package com.orchestrateur.ui.panels

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.b
import com.orchestrateur.data.getJson
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.Tag
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.fleet.Markdown
import com.orchestrateur.ui.theme.Palette

private const val PREF_ALL = "requests.all"

/** « 🧭 Requêtes » panel: how each request was split into tasks, and their progress (public/requests-panel.js). */
@Composable
fun RequestsScreen() {
    val env = LocalEnv.current
    val prefs = rememberPanelPrefs()
    val (allPref, setAll) = rememberPref(prefs, PREF_ALL)
    val showAll = allPref == "1"
    // Tasks move on after the chef's turn: re-read every 10 s.
    val loaded = rememberLoad(refreshMs = 10_000) {
        val j = env.api.getJson("/api/requests?n=25").orThrow().json
        if (j.o("ok") != null && !j.b("ok")) error("Lecture impossible : ${j.s("error") ?: "?"}")
        parseRequests(j)
    }
    var open by remember { mutableStateOf<Pair<String, Int?>?>(null) }
    val all = loaded.value

    SectionScaffold("🧭 Requêtes", subtitle = "lecture seule : chaque requête du chef, son découpage en tâches, et l’état de chacune") {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { setAll(if (showAll) "" else "1") }.padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Checkbox(showAll, onCheckedChange = { setAll(if (it) "1" else "") }, colors = CheckboxDefaults.colors(checkedColor = Palette.Accent))
            Text("tout afficher (requêtes sans tâche, relais)", color = Palette.Fg1, fontSize = 13.sp)
        }
        when {
            all == null && loaded.error != null -> ErrorLine(loaded.error.let { e -> if (e.startsWith("Lecture impossible")) e else "Requêtes indisponibles : $e" }, loaded.reload)
            all == null -> LoadingLine()
            else -> {
                val list = visibleRequests(all, showAll)
                LazyColumn(contentPadding = ListPadding) {
                    if (list.isEmpty()) item { EmptyLine(noneText(all.size)) }
                    items(list, key = { it.run }) { q -> RequestCard(q, onOpen = { n -> open = q.run to n }) }
                    hiddenText(all.size - list.size)?.let { item { Text(it, color = Palette.Fg2, fontSize = 12.sp, modifier = Modifier.padding(16.dp)) } }
                }
            }
        }
    }

    val o = open
    val q = o?.let { (run, _) -> all?.firstOrNull { it.run == run } }
    LaunchedEffect(o, q) { if (o != null && all != null && q == null) open = null }
    if (o != null && q != null) RequestDialog(q, o.second, onTask = { n -> open = q.run to n }, onDismiss = { open = null })
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RequestCard(q: RqRequest, onOpen: (Int?) -> Unit) {
    Card {
        Column(Modifier.fillMaxWidth().clickable { onOpen(null) }, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(whenText(q.createdAt), color = Palette.Fg2, fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(end = 6.dp))
                if (q.origin == "relais") Tag("relais", Palette.StThink)
            }
            Text(q.requestHead.ifEmpty { "(requête vide)" }, color = Palette.Fg0, fontSize = 14.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(requestMeta(q), color = Palette.Fg2, fontSize = 11.sp)
                for ((text, tone) in toneSummary(q)) Text(text, color = toneColor(tone), fontSize = 11.sp)
            }
        }
        if (q.tasks.isEmpty()) Text(whyNoTask(q), color = Palette.Fg2, fontSize = 12.sp)
        // Dependency columns stacked (phone layout of the web map): « après n° k » says the link.
        for ((level, col) in columns(q).withIndex()) {
            if (level > 0) Text("↓", color = Palette.Fg3, fontSize = 12.sp, modifier = Modifier.padding(start = 6.dp))
            for (t in col) TaskTile(t) { onOpen(t.n) }
        }
    }
}

@Composable
private fun TaskTile(t: RqTask, onClick: () -> Unit) {
    val tone = toneColor(t.tone)
    val shape = RoundedCornerShape(8.dp)
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp).clip(shape).border(1.dp, tone.copy(alpha = 0.45f), shape).clickable { onClick() }) {
        Box(Modifier.width(4.dp).heightIn(min = 44.dp).background(tone))
        Column(Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stateIcon(t.state), color = tone, fontSize = 13.sp, modifier = Modifier.padding(end = 4.dp))
                Text("${t.n}", color = Palette.Fg2, fontSize = 12.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(end = 6.dp))
                Text(t.titre, color = Palette.Fg0, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(t.projet ?: "—", color = Palette.Fg1, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                Text(t.stateLabel, color = tone, fontSize = 11.sp)
                if (t.released) Tag("détachée", Palette.StThink)
            }
            t.apres?.let { Text("après n° $it", color = Palette.Fg2, fontSize = 11.sp) }
            t.pipelineRun?.takeIf { it.steps > 0 }?.let { p -> ProgressLine(p, tone) }
            if (t.detail.isNotEmpty()) Text(t.detail, color = Palette.Fg2, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun ProgressLine(p: RqRun, tone: androidx.compose.ui.graphics.Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f).height(5.dp).clip(RoundedCornerShape(3.dp)).background(Palette.Bg3)) {
            Box(Modifier.fillMaxWidth(progressPct(p) / 100f).height(5.dp).background(tone))
        }
        Text(progressText(p), color = Palette.Fg2, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 6.dp).weight(1f))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RequestDialog(q: RqRequest, n: Int?, onTask: (Int?) -> Unit, onDismiss: () -> Unit) {
    val t = n?.let { k -> q.tasks.firstOrNull { it.n == k } }
    PanelDialog(if (t != null) "Tâche ${t.n} — ${t.titre}" else "Requête du ${whenText(q.createdAt)}", onDismiss = onDismiss) {
        Text(detailMeta(q), color = Palette.Fg2, fontSize = 12.sp)
        if (q.tasks.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Chip("Requête", Palette.Fg1, current = t == null) { onTask(null) }
            for (x in q.tasks) Chip("${stateIcon(x.state)} ${x.n}", toneColor(x.tone), current = x.n == n) { onTask(x.n) }
        }
        if (t != null) TaskDetail(t, onTask)
        else {
            SubHeading("Requête")
            Markdown(q.request)
            q.sens?.let { SubHeading("Ce que le chef a compris"); Text(it, color = Palette.Fg0, fontSize = 13.sp) }
            if (q.questions.isNotEmpty()) {
                SubHeading("Questions posées")
                q.questions.forEachIndexed { i, x -> Text("${i + 1}. $x", color = Palette.Fg0, fontSize = 13.sp) }
            }
            for (x in q.tasks) TaskDetail(x, onTask)
        }
    }
}

@Composable
private fun Chip(label: String, color: androidx.compose.ui.graphics.Color, current: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Box(
        Modifier.heightIn(min = 44.dp).padding(vertical = 4.dp).clip(shape)
            .border(1.dp, color.copy(alpha = if (current) 1f else 0.45f), shape)
            .then(if (current) Modifier.background(color.copy(alpha = 0.15f)) else Modifier)
            .clickable { onClick() }.padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = color, fontSize = 12.sp) }
}

@Composable
private fun TaskDetail(t: RqTask, onTask: (Int?) -> Unit) {
    val tone = toneColor(t.tone)
    Column(Modifier.fillMaxWidth().padding(top = 10.dp).border(1.dp, tone.copy(alpha = 0.35f), RoundedCornerShape(8.dp)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("${stateIcon(t.state)} Tâche ${t.n} « ${t.titre} »", color = tone, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        for ((k, v) in taskRows(t)) {
            if (k == "Après" && t.apres != null) Row(verticalAlignment = Alignment.CenterVertically) {
                Text(k, color = Palette.Fg2, fontSize = 12.sp, modifier = Modifier.fillMaxWidth(0.28f).padding(end = 8.dp))
                Text(v, color = Palette.Accent, fontSize = 13.sp, modifier = Modifier.heightIn(min = 44.dp).clickable { onTask(t.apres) }.padding(vertical = 12.dp))
            } else KeyValue(k, v)
        }
        t.excerpt?.takeIf { it.isNotEmpty() }?.let { SubHeading("Résultat"); Markdown(it) }
        SubHeading("Demande confiée au musicien")
        Markdown(t.demande)
    }
}
