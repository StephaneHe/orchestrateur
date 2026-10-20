package com.orchestrateur.ui.panels

import com.orchestrateur.data.a
import com.orchestrateur.data.b
import com.orchestrateur.data.i
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import com.orchestrateur.data.strs
import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/* Pure logic of the Requests panel (port of public/requests-panel.js). No android.* here. */

data class RqRun(val run: String, val pipeline: String?, val mode: String?, val status: String?, val steps: Int, val done: Int, val current: String?)

data class RqTask(
    val n: Int,
    val projet: String?,
    val titre: String,
    val demande: String,
    val apres: Int?,
    val pipeline: String?,
    val mode: String?,
    val state: String,
    val stateLabel: String,
    val tone: String,
    val detail: String,
    val level: Int,
    val released: Boolean,
    val pipelineRun: RqRun?,
    val launchedAt: String?,
    val since: String?,
    val endedAt: String?,
    val pendingId: String?,
    val raison: String?,
    val rattache: String?,
    val reprise: String?,
    val excerpt: String?,
)

data class RqRequest(
    val run: String,
    val createdAt: String?,
    val routageStatus: String?,
    val origin: String,
    val request: String,
    val requestHead: String,
    val sens: String?,
    val nature: String?,
    val aucunDispatch: String?,
    val questions: List<String>,
    val open: Int,
    val total: Int,
    val tasks: List<RqTask>,
)

private fun parseRun(j: JsonElement?): RqRun? = j?.let {
    RqRun(it.s("run").orEmpty(), it.s("pipeline"), it.s("mode"), it.s("status"), it.i("steps") ?: 0, it.i("done") ?: 0, it.s("current"))
}

fun parseTask(t: JsonElement) = RqTask(
    n = t.i("n") ?: 0, projet = t.s("projet"), titre = t.s("titre").orEmpty(), demande = t.s("demande").orEmpty(),
    apres = t.i("apres"), pipeline = t.s("pipeline"), mode = t.s("mode"),
    state = t.s("state").orEmpty(), stateLabel = t.s("stateLabel") ?: t.s("state").orEmpty(), tone = t.s("tone") ?: "neutral",
    detail = t.s("detail").orEmpty(), level = t.i("level") ?: 0, released = t.b("released"),
    pipelineRun = parseRun(t.o("pipelineRun")), launchedAt = t.s("launchedAt"), since = t.s("since"), endedAt = t.s("endedAt"),
    pendingId = t.s("pendingId"), raison = t.s("raison"), rattache = t.s("rattache"), reprise = t.s("reprise"), excerpt = t.s("excerpt"),
)

fun parseRequest(q: JsonElement) = RqRequest(
    run = q.s("run").orEmpty(), createdAt = q.s("createdAt"), routageStatus = q.s("routageStatus"),
    origin = q.s("origin") ?: "utilisateur", request = q.s("request").orEmpty(), requestHead = q.s("requestHead").orEmpty(),
    sens = q.s("sens"), nature = q.s("nature"), aucunDispatch = q.s("aucunDispatch"), questions = q.strs("questions"),
    open = q.i("open") ?: 0, total = q.i("total") ?: 0, tasks = q.a("tasks").map(::parseTask),
)

fun parseRequests(j: JsonElement?): List<RqRequest> = j.a("requests").map(::parseRequest)

private val ICON = mapOf(
    "attente" to "⏳", "bloquee" to "⛔", "file" to "☰", "lancee" to "↗", "en_cours" to "▶", "pause" to "⏸", "question" to "?",
    "terminee" to "✓", "echouee" to "✕", "arretee" to "■", "abandonnee" to "⊘", "renvoyee" to "↩", "action" to "⚙",
    "non_lancee" to "–", "doublon" to "≡", "a_dispatcher" to "…", "introuvable" to "⚠",
)
private val RUN_WORD = mapOf("running" to "en cours", "paused" to "en pause", "done" to "terminée", "failed" to "en échec",
    "interrupted" to "interrompue", "abandoned" to "abandonnée")
private val ROUTAGE = mapOf("running" to "Routage en cours", "paused" to "Routage en pause", "done" to "découpée",
    "failed" to "Routage en échec", "interrupted" to "Routage interrompu", "abandoned" to "Routage abandonné")

fun stateIcon(state: String) = ICON[state] ?: "·"

fun routageWord(status: String?) = status?.let { ROUTAGE[it] ?: it }.orEmpty()

private val HM = DateTimeFormatter.ofPattern("HH:mm")
private val DM_HM = DateTimeFormatter.ofPattern("dd/MM HH:mm")

/** Time today, else day/month and time (as the web's fr-FR toLocale…String). */
fun whenText(iso: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val t = iso?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return ""
    val z = t.atZone(zone)
    return if (z.toLocalDate() == now.atZone(zone).toLocalDate()) z.format(HM) else z.format(DM_HM)
}

/** Default view: only the user's requests that were split into tasks. */
fun visibleRequests(all: List<RqRequest>, showAll: Boolean) =
    if (showAll) all else all.filter { it.tasks.isNotEmpty() && it.origin == "utilisateur" }

fun hiddenText(hidden: Int): String? {
    if (hidden <= 0) return null
    val s = if (hidden > 1) "s" else ""
    return "$hidden requête$s sans tâche ou relayée$s masquée$s — cocher « tout afficher »."
}

fun noneText(total: Int) = "Aucune requête découpée en tâches parmi les $total dernières."

fun requestMeta(q: RqRequest): String =
    routageWord(q.routageStatus) + if (q.total > 0) " · ${q.total} tâche${if (q.total > 1) "s" else ""}" else ""

private val TONE_WORDS = linkedMapOf(
    "ok" to ("terminée" to "terminées"), "live" to ("en cours" to "en cours"),
    "input" to ("attend une réponse" to "attendent une réponse"), "wait" to ("en attente" to "en attente"),
    "chef" to ("au chef" to "au chef"), "bad" to ("en échec" to "en échec"), "neutral" to ("sans suite" to "sans suite"),
)

/** "n mot" per tone, in the web's order, with the tone (for its colour). */
fun toneSummary(q: RqRequest): List<Pair<String, String>> {
    val by = q.tasks.groupingBy { it.tone }.eachCount()
    return TONE_WORDS.mapNotNull { (tone, w) ->
        val n = by[tone] ?: return@mapNotNull null
        "$n ${if (n > 1) w.second else w.first}" to tone
    }
}

/** Tasks per dependency level (the map's columns, stacked on a phone). */
fun columns(q: RqRequest): List<List<RqTask>> {
    if (q.tasks.isEmpty()) return emptyList()
    val max = q.tasks.maxOf { it.level }
    return (0..max).map { l -> q.tasks.filter { it.level == l } }.filter { it.isNotEmpty() }
}

fun whyNoTask(q: RqRequest): String = q.aucunDispatch
    ?: q.questions.firstOrNull()?.let { "question posée : $it" }
    ?: when {
        q.nature == "reponse" -> "réponse du chef, sans tâche"
        q.nature == "question" -> "le chef a posé une question"
        q.routageStatus == "running" -> "découpage en cours…"
        else -> "aucune tâche"
    }

fun progressPct(p: RqRun): Int = if (p.steps <= 0) 0 else Math.round(100.0 * p.done / p.steps).toInt()

fun progressText(p: RqRun) = "${p.done}/${p.steps}${p.current?.let { " · $it" } ?: ""}"

fun detailMeta(q: RqRequest): String =
    "${routageWord(q.routageStatus)} · ${q.run} · ${q.total} tâche${if (q.total > 1) "s" else ""}" +
        if (q.open > 0) " dont ${q.open} pas encore finie${if (q.open > 1) "s" else ""}" else ""

/** Rows of a task in the detail dialog (label → value), empty ones left out, as the web. */
fun taskRows(t: RqTask, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<Pair<String, String>> {
    val p = t.pipelineRun
    val w = { iso: String? -> whenText(iso, now, zone) }
    return listOf(
        "État" to "${t.stateLabel} — ${t.detail}",
        "Musicien" to (t.projet ?: "—"),
        "Après" to (t.apres?.let { "tâche $it" } ?: ""),
        "Pipeline" to (t.pipeline?.let { "$it${t.mode?.let { m -> " ($m)" } ?: ""}" } ?: ""),
        "Exécution" to (p?.let { "${it.run} — ${RUN_WORD[it.status] ?: it.status ?: "?"}, ${it.done}/${it.steps} étapes${it.current?.let { c -> ", « $c »" } ?: ""}" } ?: ""),
        "Reprise de" to t.reprise.orEmpty(),
        "Lancée" to (t.launchedAt?.let { w(it) + if (t.released) " (libérée à la fin de la tâche attendue)" else "" } ?: ""),
        "Commencée" to (t.since?.let { w(it) } ?: ""),
        "Finie" to (t.endedAt?.let { w(it) } ?: ""),
        "En attente" to (t.pendingId?.let { "entrée $it de la liste des tâches en attente" } ?: ""),
        "Classement" to t.raison.orEmpty(),
        "Rattachée à" to t.rattache.orEmpty(),
    ).filter { it.second.isNotEmpty() }
}
