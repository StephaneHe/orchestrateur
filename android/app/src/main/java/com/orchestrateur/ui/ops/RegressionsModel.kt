package com.orchestrateur.ui.ops

import com.orchestrateur.data.a
import com.orchestrateur.data.i
import com.orchestrateur.data.l
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import com.orchestrateur.data.str
import kotlinx.serialization.json.JsonElement
import kotlin.math.roundToInt

// Pure logic of « Non-régressions » (public/regress-live.js, GET /api/regressions).

data class RegCounts(val ok: Int, val ko: Int, val na: Int)
data class RegRun(
    val id: String, val status: String, val stage: String?, val mode: String?, val lane: Int?,
    val startedAt: String?, val endedAt: String?, val durationS: Long?,
    val suitesDone: Int?, val suitesTotal: Int?, val suitesKo: Int?,
    val checksDone: Int?, val checksExpected: Int?, val checksKo: Int?,
    val counts: RegCounts?, val ko: List<String>, val why: String?, val launcher: String?,
    val progress: String?, val report: String?, val reportFile: String?,
)
data class RegProject(val project: String, val running: List<RegRun>, val recent: List<RegRun>)

private fun counts(j: JsonElement?): RegCounts? = j?.let { RegCounts(it.i("OK") ?: 0, it.i("KO") ?: 0, it.i("NA") ?: 0) }

private fun parseRun(r: JsonElement): RegRun? {
    val id = r.s("id") ?: return null
    val su = r.o("suites")
    val ch = r.o("checks")
    return RegRun(
        id = id, status = r.s("status") ?: "", stage = r.s("stage"), mode = r.s("mode"), lane = r.i("lane"),
        startedAt = r.s("startedAt"), endedAt = r.s("endedAt"), durationS = r.l("durationS"),
        suitesDone = su.i("done"), suitesTotal = su.i("total"), suitesKo = su.i("ko"),
        checksDone = ch.i("done"), checksExpected = ch.i("expected"), checksKo = ch.i("ko"),
        counts = counts(r.o("counts")), ko = r.a("ko").mapNotNull { it.str }, why = r.s("why"),
        launcher = r.o("launcher").s("by"), progress = r.s("progress"), report = r.s("report"), reportFile = r.s("reportFile"),
    )
}

fun parseRegressions(j: JsonElement?): List<RegProject> = j.a("projects").mapNotNull { p ->
    val name = p.s("project") ?: return@mapNotNull null
    RegProject(name, p.a("running").mapNotNull(::parseRun), p.a("recent").mapNotNull(::parseRun))
}

private val MODE = mapOf("full" to "complète", "targeted" to "ciblée", "perimeter" to "par périmètre", "partial" to "partielle")
private val STATUS = mapOf("running" to "en cours", "ok" to "verte", "ko" to "rouge", "stale" to "périmée (contenu modifié)",
    "error" to "arrêtée sur une erreur", "interrupted" to "interrompue")
private val MARK = mapOf("running" to "🧪", "ok" to "✓", "ko" to "✕", "stale" to "⚠", "error" to "✕", "interrupted" to "■")

fun regMark(status: String) = MARK[status] ?: "·"

fun regTitle(r: RegRun): String =
    "Non-régression ${MODE[r.mode] ?: r.mode ?: ""} ${STATUS[r.status] ?: r.status}".replace(Regex("\\s+"), " ").trim()

fun regSummary(r: RegRun): String {
    if (r.status == "running") return (if (r.stage != null) "étage ${r.stage} · " else "") + (r.progress ?: "")
    val c = r.counts ?: return r.why ?: r.progress ?: ""
    return "${c.ok} OK · ${c.ko} KO · ${c.na} NA" + (r.durationS?.let { " · ${(it / 60.0).roundToInt()} min" } ?: "")
}

fun koCount(r: RegRun): Int = ((r.suitesKo ?: 0) + (r.checksKo ?: 0)).takeIf { it > 0 } ?: (r.counts?.ko ?: 0)

fun regPct(r: RegRun): Int? {
    val total = (r.suitesTotal ?: 0) + (r.checksExpected ?: 0)
    if (total == 0) return null
    return (100.0 * ((r.suitesDone ?: 0) + (r.checksDone ?: 0)) / total).roundToInt().coerceIn(0, 100)
}

const val REG_RECENT_MS = 10 * 60_000L

/** Band rows: every running run, else the project's last run if it ended less than 10 min ago. */
fun regBandRows(projects: List<RegProject>, now: Long): List<Pair<String, RegRun>> {
    val rows = mutableListOf<Pair<String, RegRun>>()
    for (p in projects) {
        p.running.forEach { rows += p.project to it }
        val last = p.recent.firstOrNull()
        val ended = last?.endedAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
        if (p.running.isEmpty() && last != null && ended != null && now - ended < REG_RECENT_MS) rows += p.project to last
    }
    return rows
}

data class ReportSummary(val label: String?, val at: String?, val mode: String?, val commit: String?, val counts: RegCounts?,
                         val durationMin: Int?, val koLines: List<String>)

fun parseReport(j: JsonElement?): ReportSummary = ReportSummary(
    label = j.s("label"), at = j.s("at"), mode = j.s("mode"), commit = j.s("commit"), counts = counts(j.o("counts")),
    durationMin = j.l("durationS")?.let { (it / 60.0).roundToInt() },
    koLines = j.a("results").filter { it.s("status") == "KO" }.map { x ->
        val d = x.s("detail").orEmpty()
        "[${x.s("stage") ?: "?"}] ${x.s("name") ?: x.s("id") ?: "?"}" + (if (d.isNotBlank()) " — $d" else "")
    },
)

fun reportErrorText(code: Int, serverText: String): String =
    if (code == 410) "rapport remplacé par un lancement plus récent" else serverText

fun modeText(mode: String?): String = MODE[mode] ?: mode ?: ""
