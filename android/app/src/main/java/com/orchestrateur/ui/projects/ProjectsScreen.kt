package com.orchestrateur.ui.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.getJson
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.delay

/** Snapshot plus the moment it was received (ages of turns in flight keep running). */
private class Received(val snap: PupitreSnapshot, val at: Long)

fun toneColor(t: Tone): Color = when (t) {
    Tone.INPUT -> Palette.StInput
    Tone.ALARM -> Palette.StError
    Tone.NEUTRAL -> Palette.Fg2
    Tone.LIVE -> Palette.StLive
    Tone.THINK -> Palette.StThink
    Tone.UNREAD -> Palette.StUnread
    Tone.IDLE -> Palette.StIdle
}

/** « Projets » (public/projets.js): every musician's status at a glance, in three groups. */
@Composable
fun ProjectsScreen() {
    val env = LocalEnv.current
    val config = rememberLoad { env.api.getJson("/api/config").orThrow().json }
    val pupitre = rememberLoad(refreshMs = 5000) {
        Received(parsePupitre(env.api.getJson("/api/pupitre").orThrow().json), System.currentTimeMillis())
    }
    var filter by rememberSaveable { mutableStateOf("") }
    var onlyKey by rememberSaveable { mutableStateOf<String?>(null) }
    var details by rememberSaveable { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }

    val only = Group.entries.firstOrNull { it.key == onlyKey }
    val rec = pupitre.value
    val conductor = rec?.snap?.conductor ?: env.conductor()
    val rows = rec?.let { mergeConfig(it.snap.rows, config.value) }.orEmpty()
    val view = buildView(rows, filter, only, conductor, now, recvElapsedMs = rec?.let { maxOf(0L, now - it.at) } ?: 0L)

    val sync = rec?.let {
        val age = now - it.at
        if (age > 15000) "données anciennes (${fmtDur(age)})" else "synchronisé il y a ${fmtDur(age)}"
    } ?: "instantané non reçu"

    SectionScaffold("Projets", subtitle = sync) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            CountChip("Tous", view.counts.all, only == null) { onlyKey = null }
            CountChip("Attention", view.counts.attention, only == Group.ATTENTION) { onlyKey = toggleOnly(only, Group.ATTENTION)?.key }
            CountChip("Actifs / attente", view.counts.active, only == Group.ACTIVE) { onlyKey = toggleOnly(only, Group.ACTIVE)?.key }
            CountChip("Repos", view.counts.rest, only == Group.REST) { onlyKey = toggleOnly(only, Group.REST)?.key }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                filter, { filter = it }, singleLine = true,
                placeholder = { Text("Filtrer (nom, état, texte)", fontSize = 13.sp) },
                modifier = Modifier.weight(1f).semantics { contentDescription = "Filtrer les projets" },
            )
            Row(
                Modifier.heightIn(min = 44.dp).clickable { details = !details }.padding(start = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(details, { details = it }, colors = CheckboxDefaults.colors(checkedColor = Palette.Accent))
                Text("détails", color = Palette.Fg1, fontSize = 12.sp)
            }
        }
        when {
            rec == null && pupitre.error != null -> ErrorLine(pupitre.error, pupitre.reload)
            rec == null -> LoadingLine()
            else -> LazyColumn(contentPadding = ListPadding) {
                if (pupitre.error != null) item { Text("⚠ ${pupitre.error}", color = Palette.Fg2, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 16.dp)) }
                for (g in view.groups) {
                    if (g.hidden) continue
                    item(key = "h-${g.group.key}") {
                        Text("${g.group.title} (${g.countText})".uppercase(), color = Palette.Fg2, fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp))
                    }
                    if (g.items.isEmpty()) item(key = "e-${g.group.key}") { EmptyLine("aucun projet") }
                    items(g.visible, key = { "t-${it.row.name}" }) { ProjectTile(it, details) { env.openMusician(it.row.name) } }
                }
            }
        }
    }
}

@Composable
private fun CountChip(label: String, n: Int, on: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Box(
        Modifier.heightIn(min = 44.dp).padding(vertical = 4.dp)
            .background(if (on) Palette.Bg3 else Color.Transparent, shape)
            .border(1.dp, if (on) Palette.Accent else Palette.CardBorder, shape)
            .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp)
            .semantics { contentDescription = "$label : $n" + if (on) " (affiché seul)" else "" },
        contentAlignment = Alignment.Center,
    ) { Text("$label $n", color = if (on) Palette.Fg0 else Palette.Fg1, fontSize = 12.sp) }
}

@Composable
private fun ProjectTile(it: ProjectItem, details: Boolean, onClick: () -> Unit) {
    val color = toneColor(it.tone)
    val shape = RoundedCornerShape(7.dp)
    val strong = it.kind == Kind.QUESTION || it.kind == Kind.DEAD || it.kind == Kind.ERROR
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp)
            .background(Palette.CardBg, shape)
            .border(1.dp, if (strong) color.copy(alpha = 0.5f) else Palette.CardBorder, shape)
            .clickable(onClick = onClick)
            .heightIn(min = 44.dp)
            .semantics {
                contentDescription = listOfNotNull(
                    it.row.name, it.word, it.line, it.age.text,
                    it.row.queueDepth.takeIf { q -> q > 0 }?.let { q -> "$q en file" },
                    it.row.callbackTo?.let { c -> "rapport promis à $c" },
                    "chef d'orchestre".takeIf { _ -> it.isChef },
                ).joinToString(", ")
            },
    ) {
        Box(Modifier.width(3.dp).heightIn(min = 44.dp).background(color, RoundedCornerShape(topStart = 7.dp, bottomStart = 7.dp)))
        Text(it.kind.glyph, color = color, fontWeight = FontWeight.Bold, fontSize = 14.sp,
            modifier = Modifier.padding(start = 8.dp, top = 8.dp).width(20.dp))
        Column(Modifier.weight(1f).padding(start = 4.dp, end = 10.dp, top = 7.dp, bottom = 7.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(it.row.name, color = Palette.Fg0, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, fontFamily = FontFamily.Monospace,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text(it.word, color = if (strong) Palette.Fg0 else Palette.Fg1, fontSize = 11.sp,
                    fontWeight = if (strong) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false))
            }
            val chips = buildList {
                if (it.row.queueDepth > 0) add("⏳ ${it.row.queueDepth}" to Palette.Fg0)
                it.row.callbackTo?.let { c -> add("⇄ $c" to Palette.StUnread) }
                if (it.isChef) add("CHEF" to Palette.Fg0)
                it.model?.let { m -> add(m to Palette.Fg2) }
            }
            if (chips.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    chips.forEach { (t, c) ->
                        Text(t, color = c, fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false).background(Palette.Bg2, RoundedCornerShape(4.dp))
                                .border(1.dp, Palette.CardBorder, RoundedCornerShape(4.dp)).padding(horizontal = 5.dp))
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(it.line, color = if (it.kind == Kind.QUESTION) Palette.Fg0 else Palette.Fg1, fontSize = 12.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(it.age.text, color = if (it.age.live) Palette.Fg1 else Palette.Fg2, fontSize = 11.sp, maxLines = 1,
                    modifier = Modifier.padding(start = 6.dp))
            }
            if (details) Text(it.details, color = Palette.Fg2, fontSize = 10.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}
