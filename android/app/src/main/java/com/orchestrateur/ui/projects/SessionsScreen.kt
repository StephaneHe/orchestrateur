package com.orchestrateur.ui.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.PipelineChoice
import com.orchestrateur.data.deleteJson
import com.orchestrateur.data.enc
import com.orchestrateur.data.getJson
import com.orchestrateur.data.postJson
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.Mono
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.Tag
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.launch

/** « Session Claude — X » (app.js openSession): attach, detach or start a session. */
@Composable
fun SessionsScreen(project: String) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val base = "/api/projects/${enc(project)}"
    val load = rememberLoad(project) { parseSessions(env.api.getJson("$base/sessions").orThrow().json) }
    var showNew by remember { mutableStateOf(false) }
    var outcome by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun attach(sid: String) = scope.launch {
        val r = env.api.postJson("$base/attach", attachBody(sid))
        if (r.ok) { env.toast("✓ session ${sid.take(8)} attachée"); load.reload() } else env.toast("Attach échoué : " + r.errorText())
    }
    fun detach() = scope.launch {
        val r = env.api.deleteJson("$base/attach")
        if (r.ok) { env.toast("✓ session détachée"); load.reload() } else env.toast("Detach échoué : " + r.errorText())
    }

    val v = load.value
    SectionScaffold("Session Claude — $project", subtitle = v?.pathLine ?: if (load.loading) "scan en cours…" else null) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("attachée", color = Palette.Fg2, fontSize = 11.sp)
                Mono(v?.attached ?: "aucune", if (v?.attached != null) Palette.Fg0 else Palette.Fg2, 12)
            }
            if (v?.attached != null) PillButton("DÉTACHER", color = Palette.StError) { detach() }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PillButton(if (busy) "démarrage…" else "Nouvelle session…", enabled = !busy) { showNew = true }
        }
        outcome?.let { Text(it, color = Palette.Fg1, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        when {
            v == null && load.error != null -> ErrorLine("échec : ${load.error}", load.reload)
            v == null -> LoadingLine("scan en cours…")
            v.sessions.isEmpty() -> EmptyLine("Aucune session Claude pour ce cwd.")
            else -> {
                val now = System.currentTimeMillis()
                LazyColumn(contentPadding = ListPadding) {
                    items(v.sessions, key = { it.id }) { s ->
                        val current = v.isAttached(s)
                        Card(onClick = { if (!current) attach(s.id) }, border = if (current) Palette.Accent else Palette.CardBorder) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Mono(s.shortId, Palette.Fg0, 13)
                                if (s.live) Tag("● LIVE", Palette.StLive)
                                if (current) Tag("attachée", Palette.Accent)
                                Text(sessionWhen(s, now), color = Palette.Fg2, fontSize = 11.sp, modifier = Modifier.weight(1f), maxLines = 1)
                            }
                            Mono(sessionMeta(s), Palette.Fg2, 11)
                            Text(sessionFirstLine(s), color = Palette.Fg1, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            sessionLastLine(s)?.let { Text(it, color = Palette.Fg2, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                        }
                    }
                }
            }
        }
    }

    if (showNew) NewSessionDialog(onDismiss = { showNew = false }) { prompt, choice ->
        showNew = false
        busy = true
        outcome = "démarrage d’une nouvelle session…"
        scope.launch {
            val r = env.api.postJson("$base/sessions/new", newSessionBody(prompt, choice))
            busy = false
            outcome = when (val o = parseNewSession(r.code, r.json, r.errorText())) {
                is NewSessionOutcome.Started -> "✓ nouvelle session ${o.sessionId}"
                is NewSessionOutcome.Pipeline -> "✓ ${o.note}"
                is NewSessionOutcome.Failed -> "⚠ Nouvelle session échouée : ${o.error}"
            }
            load.reload()
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NewSessionDialog(onDismiss: () -> Unit, onStart: (String, PipelineChoice) -> Unit) {
    var prompt by remember { mutableStateOf("") }
    var choice by remember { mutableStateOf(PipelineChoice.AUTO) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Nouvelle session") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Démarre une session neuve (sans --resume) avec cette première demande.", color = Palette.Fg2, fontSize = 12.sp)
                OutlinedTextField(prompt, { prompt = it }, label = { Text("Première demande") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                Text("Pipeline", color = Palette.Fg2, fontSize = 12.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PipelineChoice.entries.forEach { c ->
                        val on = c == choice
                        Text(c.label, color = if (on) Palette.Bg0 else Palette.Fg1, fontSize = 12.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.heightIn(min = 44.dp).padding(vertical = 4.dp)
                                .background(if (on) Palette.Accent else Palette.Bg3, RoundedCornerShape(16.dp))
                                .clickable { choice = c }
                                .padding(horizontal = 12.dp, vertical = 9.dp))
                    }
                }
            }
        },
        confirmButton = { TextButton(enabled = prompt.isNotBlank(), onClick = { onStart(prompt, choice) }) { Text("Démarrer") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Annuler") } },
        containerColor = Palette.Bg2,
    )
}
