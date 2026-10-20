package com.orchestrateur.ui.panels

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke as DrawStroke
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.enc
import com.orchestrateur.data.getJson
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette

private const val PREF_PROJECT = "git.project"
private val LANE_COLORS = listOf(0xFFE8A15C, 0xFF5FD4FF, 0xFF2DFF7A, 0xFFFF8C42, 0xFFC792EA, 0xFFFF2D8B, 0xFFF5D76E, 0xFF8FBCBB).map { Color(it) }
private fun laneColor(lane: Int) = LANE_COLORS[lane % LANE_COLORS.size]
private val ROW_H = 54.dp
private val LANE_W = 14.dp

/** « ⎇ Git » panel: each musician's git tree, read-only (public/git-panel.js). */
@Composable
fun GitScreen() {
    val env = LocalEnv.current
    val prefs = rememberPanelPrefs()
    val (want, setWant) = rememberPref(prefs, PREF_PROJECT)
    val projects = rememberLoad { parseGitProjects(env.api.getJson("/api/git-graph").orThrow().json) }
    val list = projects.value
    val cur = list?.let { currentRepo(it, want) }
    var n by remember(cur) { mutableIntStateOf(GIT_N_STEP) }
    val graph = rememberLoad(cur, n, refreshMs = 30_000) {
        if (cur.isNullOrEmpty()) null
        else parseGitGraph(env.api.getJson("/api/git-graph/${enc(cur)}?n=$n").orThrow().json)
    }
    // Keeps the rows on screen while « Plus de commits » reloads.
    var shown by remember(cur) { mutableStateOf<GitGraph?>(null) }
    LaunchedEffect(graph.value) { graph.value?.let { shown = it } }

    SectionScaffold("⎇ Git", subtitle = "lecture seule : aucune opération git ne peut être lancée d’ici") {
        if (list != null) Picker("Musicien", cur.orEmpty(), list.map { PickerOption(it.name, gitProjectLabel(it), it.repo) }, onPick = setWant)
        val g = shown
        when {
            list == null && projects.error != null -> ErrorLine("Graphe git indisponible : ${projects.error}", projects.reload)
            list == null -> LoadingLine()
            cur.isNullOrEmpty() -> EmptyLine("Aucun dépôt git dans la flotte.")
            g == null && graph.error != null -> ErrorLine("Graphe git indisponible : ${graph.error}", graph.reload)
            g == null -> LoadingLine()
            !g.repo -> EmptyLine("$cur n’a pas de dépôt git.")
            g.error != null -> EmptyLine("Lecture impossible : ${g.error}")
            g.commits.isEmpty() -> EmptyLine("Aucun commit.")
            else -> {
                Text(gitSummary(g), color = Palette.Fg2, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp))
                LazyColumn(contentPadding = ListPadding) {
                    itemsIndexed(g.commits, key = { _, c -> c.sha }) { r, c -> CommitRow(g, r, c) }
                    if (canLoadMore(g, n)) item {
                        PillButton(if (graph.loading) "chargement…" else "Plus de commits", Modifier.padding(horizontal = 12.dp)) { n = nextN(n) }
                    }
                }
            }
        }
    }
}

@Composable
private fun CommitRow(g: GitGraph, r: Int, c: GitCommit) {
    val lanes = maxOf(1, g.layout.lanes)
    val isHead = c.head != null
    Row(
        Modifier.fillMaxWidth().height(ROW_H).then(if (isHead) Modifier.background(Palette.Accent.copy(alpha = 0.08f)) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GraphCell(g, r, lanes)
        Column(Modifier.weight(1f).padding(start = 6.dp, end = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val refs = refChips(c)
            Text(
                buildAnnotatedString {
                    for (ref in refs) {
                        val col = when (ref.kind) { RefKind.HEAD -> Palette.Accent; RefKind.BRANCH -> Palette.StLive; RefKind.REMOTE -> Palette.StUnread; RefKind.TAG -> Palette.StThink }
                        withStyle(SpanStyle(color = col, fontWeight = if (ref.kind == RefKind.HEAD) FontWeight.Bold else FontWeight.Normal, fontSize = 11.sp)) { append("[${ref.text}] ") }
                    }
                    withStyle(SpanStyle(color = Palette.Fg0)) { append(c.subject) }
                },
                fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = Palette.Fg1)) { append(c.short) }
                    append(" ${c.author} · ${fmtGitDate(c.date)}")
                    if (c.parents.size > 1) append(" · fusion de ${c.parents.size} parents")
                },
                color = Palette.Fg2, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** This row's slice of the web's SVG graph (rowStrokes) plus the commit dot. */
@Composable
private fun GraphCell(g: GitGraph, r: Int, lanes: Int) {
    val strokes = remember(g, r) { rowStrokes(g.layout, r, g.commits.size) }
    val dotLane = g.layout.rows.getOrElse(r) { 0 }
    Canvas(Modifier.width(LANE_W * lanes).fillMaxHeight()) {
        val lw = LANE_W.toPx()
        val h = size.height
        fun x(l: Double) = (lw / 2 + l * lw).toFloat()
        fun y(f: Double) = (f * h).toFloat()
        val width = 2.dp.toPx()
        for (s in strokes) {
            val p = Path().apply {
                moveTo(x(s.x0), y(s.y0))
                cubicTo(x(s.x1), y(s.y1), x(s.x2), y(s.y2), x(s.x3), y(s.y3))
            }
            drawPath(
                p, laneColor(s.lane).copy(alpha = if (s.dashed) 0.6f else 0.9f),
                style = DrawStroke(width = width, cap = StrokeCap.Round,
                    pathEffect = if (s.dashed) PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())) else null),
            )
        }
        drawCircle(laneColor(dotLane), radius = 4.5.dp.toPx(), center = Offset(x(dotLane.toDouble()), h / 2))
        drawCircle(Palette.Bg0, radius = 1.6.dp.toPx(), center = Offset(x(dotLane.toDouble()), h / 2))
    }
}

