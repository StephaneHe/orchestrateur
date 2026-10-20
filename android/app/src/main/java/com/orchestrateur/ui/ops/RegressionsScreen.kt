package com.orchestrateur.ui.ops

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.getJson
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
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

private const val POLL_MS = 5_000L

private fun statusColor(status: String) = when (status) {
    "running" -> Palette.StLive
    "ok" -> Palette.StLive
    "ko", "error" -> Palette.StError
    else -> Palette.Fg2
}

/** A report fetched on demand: its summary, or why it could not be read. */
private sealed interface ReportState {
    data object Loading : ReportState
    data class Shown(val s: ReportSummary) : ReportState
    data class Failed(val why: String) : ReportState
}

@Composable
fun RegressionsScreen() {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val reports = remember { mutableStateMapOf<String, ReportState>() }
    val load = rememberLoad(refreshMs = POLL_MS) { parseRegressions(env.api.getJson("/api/regressions").orThrow().json) }
    SectionScaffold("🧪 Non-régressions", subtitle = "lecture seule · actualisé toutes les 5 s") {
        val projects = load.value
        when {
            projects == null && load.error != null -> ErrorLine(load.error, load.reload)
            projects == null -> LoadingLine()
            projects.isEmpty() -> EmptyLine("Aucune non-régression en cours ni récente.")
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
                for (p in projects) {
                    item(key = "h-${p.project}") { SectionTitle(p.project) }
                    items(p.running + p.recent, key = { "${p.project}-${it.id}" }) { r ->
                        RegressionCard(r, reports[r.id]) {
                            val path = r.report ?: return@RegressionCard
                            if (reports[r.id] is ReportState.Shown) { reports.remove(r.id); return@RegressionCard }
                            reports[r.id] = ReportState.Loading
                            scope.launch {
                                val res = env.api.getJson(path)
                                reports[r.id] = if (res.ok) ReportState.Shown(parseReport(res.json)) else ReportState.Failed(reportErrorText(res.code, res.errorText()))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RegressionCard(r: RegRun, report: ReportState?, onReport: () -> Unit) {
    Card(border = if (r.status == "running") Palette.StLive.copy(alpha = 0.5f) else Palette.CardBorder) {
        Text("${regMark(r.status)} ${regTitle(r)}", color = statusColor(r.status), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Text(regSummary(r) + (if (r.status == "running") regPct(r)?.let { " · $it %" } ?: "" else ""), color = Palette.Fg1, fontSize = 13.sp)
        if (r.status == "running") regPct(r)?.let { PctBar(it) }
        val since = hhmm(r.startedAt) + (r.endedAt?.let { " → ${hhmm(it)}" } ?: "")
        Text(listOfNotNull(r.launcher, "depuis $since", r.lane?.takeIf { it > 0 }?.let { "couloir #$it" }).joinToString(" · "),
            color = Palette.Fg2, fontSize = 12.sp)
        if (r.ko.isNotEmpty()) Text("KO : ${r.ko.joinToString(", ")}", color = Palette.StError, fontSize = 12.sp)
        when {
            r.report == null -> {}
            r.status == "running" -> Text("rapport à la fin", color = Palette.Fg3, fontSize = 12.sp)
            else -> PillButton(if (report is ReportState.Shown) "Masquer le rapport" else "Rapport", onClick = onReport)
        }
        when (report) {
            ReportState.Loading -> Text("chargement du rapport…", color = Palette.Fg2, fontSize = 12.sp)
            is ReportState.Failed -> Text("⚠ ${report.why}", color = Palette.StError, fontSize = 12.sp)
            is ReportState.Shown -> ReportBlock(report.s)
            null -> {}
        }
    }
}

@Composable
private fun ReportBlock(s: ReportSummary) {
    Column(Modifier.fillMaxWidth().background(Palette.Bg1, RoundedCornerShape(8.dp)).padding(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(listOfNotNull(s.label, modeText(s.mode).ifEmpty { null }, s.at?.let { dayHhmm(it) }).joinToString(" · "), color = Palette.Fg1, fontSize = 12.sp)
        s.counts?.let { c -> Text("${c.ok} OK · ${c.ko} KO · ${c.na} NA" + (s.durationMin?.let { " · $it min" } ?: ""), color = Palette.Fg0, fontSize = 13.sp) }
        s.commit?.let { Mono("commit ${it.take(12)}", color = Palette.Fg2, size = 11) }
        if (s.koLines.isEmpty()) Text("Aucun KO.", color = Palette.StLive, fontSize = 12.sp)
        else s.koLines.forEach { Text("✕ $it", color = Palette.StError, fontSize = 12.sp) }
    }
}

/** Band of running runs, or runs finished less than 10 min ago; nothing when none. */
@Composable
fun RegressionBand() {
    val env = LocalEnv.current
    val load = rememberLoad(refreshMs = POLL_MS) { parseRegressions(env.api.getJson("/api/regressions").orThrow().json) }
    val rows = regBandRows(load.value ?: return, System.currentTimeMillis())
    if (rows.isEmpty()) return
    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).heightIn(max = 160.dp)
            .background(Palette.CardBg, shape).border(1.dp, Palette.CardBorder, shape)
            .verticalScroll(rememberScrollState()),
    ) {
        for ((project, r) in rows) {
            Column(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { env.navigate("non-regressions") }.padding(horizontal = 10.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("${regMark(r.status)} $project · ${regTitle(r)}", color = statusColor(r.status), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(regSummary(r) + (r.ko.takeIf { it.isNotEmpty() }?.let { " · KO : ${it.take(3).joinToString(", ")}" } ?: ""),
                    color = Palette.Fg2, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (r.status == "running") regPct(r)?.let { PctBar(it) }
            }
        }
    }
}
