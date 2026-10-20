package com.orchestrateur.ui.projects

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.getJson
import com.orchestrateur.data.postJson
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.Mono
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.SectionTitle
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.launch

/** « Nouveau musicien » (⋮ « + Projet » of the dashboard). A tapped candidate fills the form. */
@Composable
fun AddProjectScreen() {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val cands = rememberLoad { parseCandidates(env.api.getJson("/api/projects/candidates").orThrow().json) }
    var name by rememberSaveable { mutableStateOf("") }
    var path by rememberSaveable { mutableStateOf("") }
    var isConductor by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun submit() {
        error = validateNewProject(name, path)
        if (error != null) return
        busy = true
        scope.launch {
            val r = env.api.postJson("/api/projects", addProjectBody(name, path, isConductor))
            busy = false
            if (r.ok) { env.toast(addProjectMessage(name.trim(), r.json)); env.back() }
            else error = "Ajout échoué : " + r.errorText()
        }
    }

    SectionScaffold("Nouveau musicien") {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            SectionTitle("Un dossier sous ${cands.value?.root ?: "I:\\Dev"}")
            val v = cands.value
            when {
                v == null && cands.error != null -> ErrorLine("scan échoué : ${cands.error}", cands.reload)
                v == null -> LoadingLine("scan en cours…")
                v.candidates.isEmpty() -> EmptyLine("Aucun nouveau dossier sous ${v.root}.")
                else -> v.candidates.forEach { c ->
                    Card(onClick = { name = c.name; path = c.path; error = null }, border = if (c.path == path) Palette.Accent else Palette.CardBorder) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(c.name, color = Palette.Fg0, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Mono(c.marks, Palette.Fg2, 11)
                        }
                        Mono(c.path, Palette.Fg2, 11)
                    }
                }
            }
            SectionTitle("Le musicien")
            Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(name, { name = it; error = null }, singleLine = true, label = { Text("nom (lettres/chiffres/_.-)") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(path, { path = it; error = null }, singleLine = true, label = { Text("chemin absolu, doit exister") }, modifier = Modifier.fillMaxWidth())
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { isConductor = !isConductor },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(isConductor, { isConductor = it }, colors = CheckboxDefaults.colors(checkedColor = Palette.Accent))
                    Column(Modifier.weight(1f)) {
                        Text("Chef d’orchestre", color = Palette.Fg0, fontSize = 14.sp)
                        Text("Ce projet pilotera les autres musiciens. Remplace le chef actuel.", color = Palette.Fg2, fontSize = 11.sp)
                    }
                }
                error?.let { Text("⚠ $it", color = Palette.StError, fontSize = 13.sp) }
                PillButton(if (busy) "ajout…" else "AJOUTER", enabled = !busy) { submit() }
            }
        }
    }
}
