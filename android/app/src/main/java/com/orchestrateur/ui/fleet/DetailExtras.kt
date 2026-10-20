package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.JournalTurn
import com.orchestrateur.data.Musician
import com.orchestrateur.data.QueueEntry
import com.orchestrateur.data.deleteJson
import com.orchestrateur.data.enc
import com.orchestrateur.data.getJson
import com.orchestrateur.data.i
import com.orchestrateur.data.l
import com.orchestrateur.data.moveId
import com.orchestrateur.data.parseJournal
import com.orchestrateur.data.parseQueue
import com.orchestrateur.data.postJson
import com.orchestrateur.data.queueOrderBody
import com.orchestrateur.data.a
import com.orchestrateur.data.b
import com.orchestrateur.data.s
import com.orchestrateur.ui.common.ConfirmDialog
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.InputDialog
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// ============================================================================
// Musician detail parity (1.0.0): activity journal (server-side turns), queue
// (detail, edit, ↑/↓ order, remove), refused permissions.
// ============================================================================

/**
 * « Journal d'activité » (public/activite.js): the turns, newest first, re-read
 * when a turn boundary of this musician arrives (ingestSeq) and every 8 s.
 */
@Composable
fun ActivityJournalTab(m: Musician) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val load = rememberLoad(m.name, refreshMs = 8_000) {
        parseJournal(env.api.getJson("/api/project/${enc(m.name)}/journal?n=60").orThrow().json)
    }
    LaunchedEffect(m.state) { load.reload() }
    val j = load.value
    when {
        j == null && load.error != null -> ErrorLine("journal illisible : ${load.error}", load.reload)
        j == null -> LoadingLine("chargement du journal…")
        j.turns.isEmpty() && j.regressions.isEmpty() -> EmptyLine("Aucun tour dans le log de ce musicien.")
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(j.regressions) { r ->
                val c = r.o2("counts")
                Text("🧪 Non-régression ${r.s("mode") ?: ""} ${r.s("status") ?: ""} · ${c.i("OK") ?: 0} OK · ${c.i("KO") ?: 0} KO · ${r.s("startedAt") ?: ""}",
                    color = if ((c.i("KO") ?: 0) > 0) Palette.StError else Palette.Fg1, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }
            items(j.turns) { t -> TurnCard(t, m.name) { action -> scope.launch { action() } } }
            if (j.truncated) item { Text("tours plus anciens : non chargés (seule la fin du log est lue)", color = Palette.Fg3, fontSize = 10.sp) }
        }
    }
}

private fun kotlinx.serialization.json.JsonElement?.o2(k: String) = (this as? kotlinx.serialization.json.JsonObject)?.get(k)

@Composable
private fun TurnCard(t: JournalTurn, project: String, launch: (suspend () -> Unit) -> Unit) {
    val env = LocalEnv.current
    val uri = LocalUriHandler.current
    var open by rememberSaveable(t.start, t.end) { mutableStateOf(false) }
    var showOriginal by remember { mutableStateOf(false) }
    val tone = when (t.outcome) {
        "error" -> Palette.StError; "question" -> Palette.StInput; "running" -> Palette.StLive
        "stopped", "system", "interrupted" -> Palette.Fg2; else -> Palette.StUnread
    }
    Column(
        Modifier.fillMaxWidth().background(Palette.CardBg, RoundedCornerShape(10.dp))
            .border(1.dp, Palette.CardBorder, RoundedCornerShape(10.dp)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(t.mark(), color = tone, fontSize = 13.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(end = 6.dp))
            Text(fmtWhen(t.start ?: t.end), color = Palette.Fg2, fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(end = 6.dp))
            Text(t.word(), color = tone, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (t.langIssue) Text("⚠ langue", color = Palette.StInput, fontSize = 10.sp)
        }
        t.meta().takeIf { it.isNotEmpty() }?.let { Text(it, color = Palette.Fg3, fontSize = 10.sp, fontFamily = FontFamily.Monospace) }
        Text(
            "Demande " + (t.prompt ?: "absente de la partie du log lue (tour ancien, antérieur à la journalisation complète de la 0.67.0)"),
            color = Palette.Fg1, fontSize = 12.sp, maxLines = if (open) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis,
        )
        t.pipeline?.let { p ->
            Text("⇄ pipeline ${p.label()}", color = Palette.Accent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            Text(p.headline(), color = Palette.Fg3, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
            p.escalated?.let { Text(it, color = Palette.Fg1, fontSize = 11.sp) }
            p.extended?.let { Text(it, color = Palette.Fg2, fontSize = 11.sp) }
            if (p.defects.isNotEmpty()) Text("⚑ ${p.defects.size} défaut(s) signalé(s), livraison bloquée jusqu’à correction ou acceptation — dernier : ${p.defects.last()}",
                color = Palette.StError, fontSize = 11.sp)
            p.limitText?.let { Text(it, color = Palette.StInput, fontSize = 11.sp) }
            p.rows().forEach { r ->
                Column(Modifier.padding(start = 6.dp)) {
                    Text(r.text, color = when (r.status) {
                        "ok" -> Palette.Fg1; "refused", "failed" -> Palette.StError; "todo" -> Palette.Fg3; else -> Palette.Fg1
                    }, fontSize = 11.sp)
                    r.why?.let { Text(it, color = Palette.Fg3, fontSize = 10.sp) }
                }
            }
            if (p.backoffText != null && p.status == "running") {
                Text(p.backoffText, color = Palette.StInput, fontSize = 11.sp)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ActionChip("🔬 Tester le model") { launch { backoff(env.api, p.run, "test") } }
                    ActionChip("⇄ Changer de model (case ${p.backoffSlot ?: "?"})") { env.navigate("models") }
                    ActionChip("↻ Réessayer maintenant", primary = true) { launch { backoff(env.api, p.run, "retry") } }
                }
            }
            p.modelTest?.let { Text(it, color = Palette.Fg2, fontSize = 11.sp) }
            p.modelTestLog?.let { log ->
                Text("voir le journal du test", color = Palette.Accent, fontSize = 11.sp,
                    modifier = Modifier.heightIn(min = 36.dp).clickable { runCatching { uri.openUri(env.api.baseUrl() + "/api/model-tests/" + enc(log)) } }.padding(vertical = 8.dp))
            }
        }
        t.bypassReason?.let { Text("hors pipeline — $it", color = Palette.Fg2, fontSize = 11.sp) }
        t.permissionLines().forEach { Text(it, color = Palette.Fg2, fontSize = 11.sp) }
        when {
            t.outcome == "running" -> Text("en cours · ${t.tools} appel${if (t.tools > 1) "s" else ""} d'outil", color = Palette.Fg2, fontSize = 11.sp)
            t.outcome == "stopped" -> Text(t.stopReason ?: "motif non précisé", color = Palette.Fg2, fontSize = 11.sp)
            else -> t.summary.forEach { Text("• $it", color = Palette.Fg0, fontSize = 12.sp) }
        }
        if (t.outcome == "question" && t.question != null) Text("? ${t.question}", color = Palette.StInput, fontSize = 12.sp)
        val chips = t.chips()
        if (chips.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val urls = t.urls()
            chips.forEach { c ->
                val url = urls.firstOrNull { it.replace(Regex("^https?://"), "").take(48) == c }
                Text(c, color = if (url != null) Palette.Accent else Palette.Fg2, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    modifier = Modifier.border(1.dp, Palette.CardBorder, RoundedCornerShape(6.dp))
                        .then(if (url != null) Modifier.clickable { runCatching { uri.openUri(url) } } else Modifier)
                        .padding(horizontal = 6.dp, vertical = 3.dp))
            }
        }
        t.afterLines().forEach { Text(it, color = Palette.Fg2, fontSize = 11.sp) }
        if (t.langOriginal != null) Text(if (showOriginal) "masquer l'original" else "voir l'original", color = Palette.StInput, fontSize = 11.sp,
            modifier = Modifier.heightIn(min = 36.dp).clickable { showOriginal = !showOriginal }.padding(vertical = 8.dp))
        if (showOriginal) t.langOriginal?.let { Markdown(it, Palette.Fg2, project = project) }
        if (t.promptFull != null || t.resultFull != null) {
            Text(if (open) "▾ Réduire" else "▸ Afficher tout", color = Palette.Accent, fontSize = 12.sp,
                modifier = Modifier.heightIn(min = 40.dp).clickable { open = !open }.padding(vertical = 10.dp))
            if (open) {
                t.promptFull?.let { Text("DEMANDE COMPLÈTE", color = Palette.Fg3, fontSize = 9.sp); Markdown(it, Palette.Fg1, project = project, html = false) }
                t.resultFull?.let { Text("RÉSULTAT COMPLET", color = Palette.Fg3, fontSize = 9.sp); Markdown(it, Palette.Fg0, project = project) }
                Text("▴ Réduire", color = Palette.Accent, fontSize = 12.sp, modifier = Modifier.heightIn(min = 40.dp).clickable { open = false }.padding(vertical = 10.dp))
            }
        }
    }
}

private fun fmtWhen(iso: String?): String {
    val ms = com.orchestrateur.ui.common.isoMs(iso) ?: return "date inconnue"
    val z = java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault())
    val today = java.time.LocalDate.now()
    val hm = String.format(java.util.Locale.FRANCE, "%02d:%02d", z.hour, z.minute)
    return if (z.toLocalDate() == today) "aujourd'hui $hm" else String.format(java.util.Locale.FRANCE, "%02d/%02d %s", z.dayOfMonth, z.monthValue, hm)
}

/**
 * « File » of a musician (web .dive-queue): entries in launch order; tap =
 * read-only detail with « Modifier la demande… »; ↑ / ↓ reorder (the order
 * dropped IS the launch order); « Retirer » with confirmation.
 */
@Composable
fun QueueTab(m: Musician, held: kotlinx.serialization.json.JsonElement?) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val load = rememberLoad(m.name, m.queueDepth, refreshMs = 5_000) {
        parseQueue(env.api.getJson("/api/queue/${enc(m.name)}").orThrow().json)
    }
    var detail by remember { mutableStateOf<QueueEntry?>(null) }
    var removing by remember { mutableStateOf<QueueEntry?>(null) }
    var editing by remember { mutableStateOf<QueueEntry?>(null) }
    val q = load.value
    Column(Modifier.fillMaxSize()) {
        held?.let { h ->
            Text("⏸ FILE RETENUE — le processus ${h.s("pid") ?: h.l("pid") ?: ""} du tour précédent tourne encore" +
                (h.a("background").firstOrNull()?.s("what")?.let { " ($it)" } ?: "") +
                ". Rien n'est tué automatiquement : attendre, ou kill-stalled.mjs ${m.name} --by utilisateur.",
                color = Palette.StInput, fontSize = 11.sp, modifier = Modifier.padding(10.dp))
        }
        when {
            q == null && load.error != null -> ErrorLine(load.error, load.reload)
            q == null -> LoadingLine()
            q.entries.isEmpty() -> EmptyLine("File vide.")
            else -> LazyColumn(contentPadding = PaddingValues(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(q.entries, key = { it.id }) { e ->
                    val ids = q.entries.map { it.id }
                    Row(
                        Modifier.fillMaxWidth().background(Palette.CardBg, RoundedCornerShape(8.dp))
                            .border(1.dp, Palette.CardBorder, RoundedCornerShape(8.dp)).clickable { detail = e }.padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("${e.position}.", color = Palette.Fg2, fontSize = 12.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(end = 6.dp))
                        Text(e.head, color = Palette.Fg0, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        listOf("↑" to -1, "↓" to 1).forEach { (label, d) ->
                            Text(label, color = Palette.Fg1, fontSize = 16.sp, modifier = Modifier.heightIn(min = 44.dp).clickable {
                                val order = moveId(ids, e.id, d)
                                if (order != ids) scope.launch {
                                    val r = env.api.postJson("/api/queue/${enc(m.name)}/order", queueOrderBody(order))
                                    if (!r.ok) env.toast(r.errorText())
                                    load.reload()
                                }
                            }.padding(horizontal = 10.dp, vertical = 10.dp))
                        }
                    }
                }
            }
        }
    }
    detail?.let { e ->
        AlertDialog(
            onDismissRequest = { detail = null },
            title = { Text("File de ${m.name} · n° ${e.position}") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    e.fields().forEach { (k, v) ->
                        Row { Text("$k : ", color = Palette.Fg2, fontSize = 12.sp); Text(v, color = Palette.Fg0, fontSize = 12.sp) }
                    }
                    Text("DEMANDE", color = Palette.Fg3, fontSize = 9.sp, modifier = Modifier.padding(top = 6.dp))
                    Markdown(e.text, Palette.Fg0, project = m.name, html = false)
                }
            },
            confirmButton = { TextButton(onClick = { editing = e; detail = null }) { Text("Modifier la demande…") } },
            dismissButton = {
                Row {
                    TextButton(onClick = { removing = e; detail = null }) { Text("Retirer", color = Palette.StError) }
                    TextButton(onClick = { detail = null }) { Text("Fermer") }
                }
            },
            containerColor = Palette.Bg2,
        )
    }
    removing?.let { e ->
        ConfirmDialog("Retirer de la file", "« ${e.head.take(160)} » ne sera pas lancé.", confirm = "Retirer",
            onConfirm = {
                scope.launch {
                    val r = env.api.deleteJson("/api/queue/${enc(m.name)}/${enc(e.id)}")
                    env.toast(if (r.ok || r.code == 404) "retiré de la file" else r.errorText())
                    load.reload()
                }
            }, onDismiss = { removing = null })
    }
    editing?.let { e ->
        InputDialog("Modifier la demande (n° ${e.position})", initial = e.text, onSubmit = { text ->
            if (text.isNotBlank()) scope.launch {
                val r = env.api.postJson("/api/queue/${enc(m.name)}/${enc(e.id)}", buildJsonObject { put("text", text) })
                env.toast(when {
                    r.ok -> "demande modifiée"
                    r.code == 409 -> "déjà partie : elle n'est plus modifiable"
                    else -> r.errorText()
                })
                load.reload()
            }
        }, onDismiss = { editing = null })
    }
}

/** Refused tools of the last turn: « + Autoriser X » (missing tool only) and « ✓ Vu ». */
@Composable
fun DenialsBlock(m: Musician) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val tools = m.pendingDenials.toList()
    if (tools.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)
        .background(Color(0x22E53535), RoundedCornerShape(8.dp)).padding(8.dp)) {
        Text("🚫 autorisation refusée : ${tools.joinToString(", ")}", color = Palette.StError, fontSize = 12.sp)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            tools.forEach { tool ->
                ActionChip("+ Autoriser $tool") {
                    scope.launch {
                        val r = env.api.postJson("/api/project/${enc(m.name)}/add-tool", buildJsonObject { put("tool", tool) })
                        env.toast(if (r.ok) "$tool autorisé pour ${m.name}" else r.errorText())
                        if (r.ok) ackDenials(env.api, m, "granted", tool)
                    }
                }
            }
            ActionChip("✓ Vu") { scope.launch { ackDenials(env.api, m, "seen", null); env.toast("refus marqués vus") } }
        }
    }
}

/** POST /api/project/:name/denials/ack — the denied calls of the turn are not shown again. */
private suspend fun ackDenials(api: com.orchestrateur.data.Api, m: Musician, action: String, tool: String?) {
    val ids = m.ring.toList().flatMap { it.permissionDenials.orEmpty() }.mapNotNull { it.toolUseId }.distinct()
    api.postJson("/api/project/${enc(m.name)}/denials/ack", buildJsonObject {
        put("toolIds", buildJsonArray { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
        put("action", action)
        tool?.let { put("tool", it) }
        put("by", "android")
    })
    m.pendingDenials.clear()
}

/** POST /api/pipeline-runs/:run/backoff {action: test|retry}. */
private suspend fun backoff(api: com.orchestrateur.data.Api, run: String, action: String) {
    api.postJson("/api/pipeline-runs/${enc(run)}/backoff", buildJsonObject { put("action", action) })
}

/** « Envoyer directement à X… » (no callback to the chef; queued if X is busy). */
@Composable
fun DirectSendDialog(project: String, onDismiss: () -> Unit) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    InputDialog("Envoyer directement à $project", label = "Message (aucun retour au chef)", confirm = "Envoyer", onSubmit = { text ->
        if (text.isNotBlank()) scope.launch {
            val r = env.api.postJson("/api/dispatch", com.orchestrateur.data.dispatchPayload(project, text))
            env.toast(when {
                !r.ok -> r.errorText()
                r.json.b("queued") -> "$project est occupé — message en file"
                else -> "envoyé à $project"
            })
        }
    }, onDismiss = onDismiss)
}
