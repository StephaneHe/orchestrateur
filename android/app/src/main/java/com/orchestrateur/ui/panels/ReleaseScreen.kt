package com.orchestrateur.ui.panels

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.enc
import com.orchestrateur.data.getJson
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.fleet.Markdown
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.delay

private const val PREF_PROJECT = "release.project"

/** « 📰 Release » panel: what leads to the release note (public/release-panel.js). */
@Composable
fun ReleaseScreen() {
    val env = LocalEnv.current
    val prefs = rememberPanelPrefs()
    val (want, setWant) = rememberPref(prefs, PREF_PROJECT)
    val projects = rememberLoad { parseReleaseProjects(env.api.getJson("/api/release").orThrow().json) }
    val list = projects.value
    val cur = list?.let { currentReleaseProject(it, want) }
    // The list grows as the musicians deliver: re-read every 30 s.
    val loaded = rememberLoad(cur, refreshMs = 30_000) {
        if (cur.isNullOrEmpty()) null else parseRelease(env.api.getJson("/api/release/${enc(cur)}").orThrow().json)
    }
    var openKey by remember(cur) { mutableStateOf<String?>(null) }
    val d = loaded.value

    SectionScaffold("📰 Release", subtitle = "lecture seule : la liste vient du CHANGELOG et de la TODO du musicien") {
        if (list != null) Picker("Musicien", cur.orEmpty(), list.map { PickerOption(it.name, releaseProjectLabel(it), it.changelog) }, onPick = setWant)
        when {
            list == null && projects.error != null -> ErrorLine("Release indisponible : ${projects.error}", projects.reload)
            list == null -> LoadingLine()
            cur.isNullOrEmpty() -> EmptyLine("Aucun CHANGELOG.md dans la flotte.")
            d == null && loaded.error != null -> ErrorLine("Release indisponible : ${loaded.error}", loaded.reload)
            d == null -> LoadingLine()
            !d.changelog -> EmptyLine("$cur n’a pas de CHANGELOG.md.")
            d.error != null -> EmptyLine("Lecture impossible : ${d.error}")
            else -> {
                val groups = groupsOf(d)
                LazyColumn(contentPadding = ListPadding) {
                    item { Text(releaseSummary(d), color = Palette.Fg1, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)) }
                    if (groups.isEmpty()) item { EmptyLine("Rien en cours ni de prêt depuis la dernière release.") }
                    items(groups, key = { it.key }) { g -> GroupCard(g) { openKey = g.key } }
                    item { NoteBox(d) }
                }
            }
        }
    }

    val g = openKey?.let { k -> d?.let { groupsOf(it) }?.firstOrNull { it.key == k } }
    LaunchedEffect(openKey, g) { if (openKey != null && d != null && g == null) openKey = null }
    if (g != null && d != null) PanelDialog(detailTitle(d.project, g), onDismiss = { openKey = null }) {
        Text(detailMeta(g), color = Palette.Fg2, fontSize = 12.sp)
        for (i in g.items) Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(detailWhere(i), color = if (i.state == "ready") Palette.StLive else Palette.StUnread, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            Markdown(i.text)
        }
    }
}

@Composable
private fun GroupCard(g: ReleaseGroup, onOpen: () -> Unit) {
    Card(onClick = onOpen, border = if (g.state == "progress") Palette.StUnread.copy(alpha = 0.4f) else Palette.CardBorder) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(groupTitle(g), color = Palette.Fg0, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text("${countLabel(g.items.size)}  Détails ›", color = Palette.Accent, fontSize = 12.sp)
        }
        for (i in g.items) Row(verticalAlignment = Alignment.Top) {
            Text(if (i.state == "ready") "✓ prêt" else "⏳ en cours", color = if (i.state == "ready") Palette.StLive else Palette.StUnread,
                fontSize = 11.sp, modifier = Modifier.padding(end = 6.dp))
            Column(Modifier.weight(1f)) {
                Text(itemWhere(i), color = Palette.Fg2, fontSize = 11.sp)
                Text(plainLine(i.text), color = Palette.Fg1, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun NoteBox(d: ReleaseData) {
    val clipboard = LocalClipboardManager.current
    val ctx = LocalContext.current
    var copied by remember { mutableLongStateOf(0L) }
    LaunchedEffect(copied) { if (copied > 0) { delay(2500); copied = 0 } }
    if (d.note.isEmpty()) {
        EmptyLine("Pas encore de release note : rien n’est prêt depuis la dernière release.")
        return
    }
    Card {
        Text("Release note", color = Palette.Fg0, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Text("(seulement ce qui est prêt, texte du CHANGELOG)", color = Palette.Fg2, fontSize = 11.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PillButton(if (copied > 0) "✓ Copié" else "Copier") { clipboard.setText(AnnotatedString(d.note)); copied = System.currentTimeMillis() }
            PillButton("Partager .md") {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/markdown"
                    putExtra(Intent.EXTRA_SUBJECT, noteFileName(d))
                    putExtra(Intent.EXTRA_TITLE, noteFileName(d))
                    putExtra(Intent.EXTRA_TEXT, d.note)
                }
                ctx.startActivity(Intent.createChooser(send, "Partager la release note").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
        SelectionContainer {
            Text(d.note, color = Palette.Fg1, fontSize = 12.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.fillMaxWidth())
        }
    }
}
