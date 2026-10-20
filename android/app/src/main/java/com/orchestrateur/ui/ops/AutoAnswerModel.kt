package com.orchestrateur.ui.ops

import com.orchestrateur.data.a
import com.orchestrateur.data.b
import com.orchestrateur.data.i
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import com.orchestrateur.data.strs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// Pure logic of the « Réponse automatique » screens (public/auto-answer.js), GET /api/auto-answer.

data class AutoSettings(val enabled: Boolean, val idleMin: Int?, val waitMin: Int?, val activatedAt: String?)
data class AutoActivity(val lastAt: String?, val lastKind: String?)
data class Guardrail(val label: String, val cases: List<String>)
data class AutoTarget(val type: String, val id: String?, val label: String, val project: String?)

data class AutoDecision(
    val id: String, val at: String?, val status: String, val kind: String?, val project: String?,
    val what: String, val target: AutoTarget?, val phase: String?, val obsolete: String?,
    val whyInactive: String?, val question: String?, val answer: String?, val decision: String?,
    val reason: String?, val why: String?, val hits: List<String>, val recoveryText: String?,
    val undoable: Boolean, val undone: Boolean, val dismissed: Boolean, val dismissedAt: String?, val seenAt: String?,
) {
    val questionLine: String get() = (question ?: "").replace(Regex("\\s+"), " ").trim().take(300)
    val answerLine: String? get() = answer?.let { (if (decision != null) "[$decision] " else "") + it.take(600) }
}

data class BacklogItem(
    val key: String, val kind: String, val project: String?, val since: String?, val question: String,
    val reasonText: String, val gapKey: String?, val run: String?,
) {
    val targetLabel: String get() = when {
        kind == "gap" -> "lacune « ${gapKey ?: key} »"
        run != null -> "exécution $run"
        else -> project ?: "—"
    }
}

data class AutoOverview(
    val settings: AutoSettings, val activity: AutoActivity, val model: String, val guardrails: List<Guardrail>,
    val unseen: Int, val decisions: List<AutoDecision>, val history: List<AutoDecision>, val backlog: List<BacklogItem>,
)

private fun parseDecision(d: JsonElement): AutoDecision? {
    val id = d.s("id") ?: return null
    val t = d.o("target")
    return AutoDecision(
        id = id, at = d.s("at"), status = d.s("status") ?: "", kind = d.s("kind"), project = d.s("project"),
        what = d.s("what") ?: d.s("statusText") ?: d.s("status") ?: "",
        target = t?.let { AutoTarget(it.s("type") ?: "", it.s("id"), it.s("label") ?: "", it.s("project")) },
        phase = d.s("phase"), obsolete = d.s("obsolete"), whyInactive = d.s("why_inactive"),
        question = d.s("question"), answer = d.s("answer"), decision = d.s("decision"), reason = d.s("reason"),
        why = d.s("why"), hits = d.o("guardrails").strs("hits"), recoveryText = d.o("recovery").s("text"),
        undoable = d.b("undoable"), undone = d.o("undone") != null, dismissed = d.b("dismissed"),
        dismissedAt = d.s("dismissedAt"), seenAt = d.s("seenAt"),
    )
}

fun parseAutoOverview(j: JsonElement?): AutoOverview {
    val s = j.o("settings")
    val act = j.o("activity")
    return AutoOverview(
        settings = AutoSettings(s.b("enabled"), s.i("idleMin"), s.i("waitMin"), s.s("activatedAt")),
        activity = AutoActivity(act.s("lastAt"), act.o("last").s("kind")),
        model = j.s("model") ?: "",
        guardrails = j.a("guardrails").map { Guardrail(it.s("label") ?: it.s("id") ?: "", it.strs("cases")) },
        unseen = j.i("unseen") ?: 0,
        decisions = j.a("decisions").mapNotNull(::parseDecision),
        history = j.a("history").mapNotNull(::parseDecision),
        backlog = j.a("backlog").mapNotNull { w ->
            val key = w.s("key") ?: return@mapNotNull null
            BacklogItem(key, w.s("kind") ?: "", w.s("project"), w.s("since"), w.s("question") ?: "",
                w.s("reasonText") ?: w.s("reason") ?: "", w.s("gapKey"), w.s("run"))
        },
    )
}

private val KIND = mapOf("question" to "question", "pause" to "pause de pipeline", "permission" to "autorisation", "gap" to "lacune")
private val PHASE = mapOf("pending" to "en attente de votre décision", "handled" to "traitée", "obsolete" to "obsolète")
fun kindText(kind: String?): String = KIND[kind] ?: kind ?: ""
fun phaseText(phase: String?): String = PHASE[phase] ?: phase ?: ""

fun guardrailsLine(n: Int) = "🔒 $n garde-fous actifs"
fun backlogTitle(n: Int): String {
    val pl = if (n > 1) "s" else ""
    return "📥 Arriéré : $n attente$pl jamais traitée$pl automatiquement"
}
fun bandTitle(n: Int): String {
    val pl = if (n > 1) "s" else ""
    return "🤖 $n décision$pl prise$pl à votre place"
}
fun discardAllLabel(n: Int) = "Écarter tout ce qui est traité ou obsolète ($n)"

/** Decisions shown in the dock band: unseen, finished, not dismissed, not snoozed. */
fun bandItems(decisions: List<AutoDecision>, snoozed: Map<String, Long>, now: Long): List<AutoDecision> =
    decisions.filter { it.seenAt == null && it.status != "running" && !it.dismissed && (snoozed[it.id] ?: 0L) <= now }

fun discardableCount(decisions: List<AutoDecision>) = decisions.count { it.phase != "pending" }

const val SNOOZE_MS = 60 * 60_000L

fun snooze(current: Map<String, Long>, id: String, now: Long, ms: Long = SNOOZE_MS): Map<String, Long> =
    current.filterValues { it >= now } + (id to now + ms)

fun encodeSnoozed(m: Map<String, Long>): String = buildJsonObject { m.forEach { (k, v) -> put(k, v) } }.toString()

fun decodeSnoozed(text: String?): Map<String, Long> {
    if (text.isNullOrBlank()) return emptyMap()
    val j = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return emptyMap()
    return j.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.longOrNull?.let { k to it } }.toMap()
}

fun settingsEnabledBody(enabled: Boolean): JsonObject = buildJsonObject { put("enabled", enabled) }

/** {idleMin, waitMin} when both are whole minutes in 1..1440 (the web inputs' range), else null. */
fun delaysBody(idle: String, wait: String): JsonObject? {
    val i = idle.trim().toIntOrNull()?.takeIf { it in 1..1440 } ?: return null
    val w = wait.trim().toIntOrNull()?.takeIf { it in 1..1440 } ?: return null
    return buildJsonObject { put("idleMin", i); put("waitMin", w) }
}

fun dismissBody(id: String, confirm: Boolean): JsonObject = buildJsonObject {
    put("ids", buildJsonArray { add(JsonPrimitive(id)) })
    if (confirm) put("confirm", true)
}
fun dismissHandledBody(): JsonObject = buildJsonObject { put("handled", true) }

/** The server refused because the decision still waits for the user (409 + needsConfirm). */
fun dismissNeedsConfirm(code: Int, json: JsonElement?): Boolean = code == 409 && json.a("needsConfirm").isNotEmpty()

private val HM = DateTimeFormatter.ofPattern("HH:mm")
private val DHM = DateTimeFormatter.ofPattern("dd/MM HH:mm")
private fun fmt(iso: String?, zone: ZoneId, f: DateTimeFormatter): String =
    iso?.let { runCatching { f.format(Instant.parse(it).atZone(zone)) }.getOrNull() } ?: ""
fun hhmm(iso: String?, zone: ZoneId = ZoneId.systemDefault()) = fmt(iso, zone, HM)
fun dayHhmm(iso: String?, zone: ZoneId = ZoneId.systemDefault()) = fmt(iso, zone, DHM)
