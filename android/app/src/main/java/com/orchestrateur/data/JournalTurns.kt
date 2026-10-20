package com.orchestrateur.data

import kotlinx.serialization.json.JsonElement
import java.util.Locale

/**
 * Activity journal of a musician (GET /api/project/:name/journal), the same
 * turn cards as public/activite.js: outcome, request, what was done, pipeline
 * timeline, permissions, chips, acknowledgements. Pure: JVM-tested.
 */
data class JournalPipelineRow(val id: String, val text: String, val why: String?, val status: String, val upcoming: Boolean)

data class JournalPipeline(
    val run: String, val pipeline: String, val mode: String?, val status: String?,
    val planned: List<Triple<String, String, String?>>, // id, title, model
    val steps: List<JsonElement>, val items: Int, val covered: Int, val loops: Int, val resumed: Boolean,
    val escalated: String?, val extended: String?, val defects: List<String>, val limitText: String?,
    val backoffText: String?, val backoffSlot: String?, val modelTest: String?, val modelTestLog: String? = null,
) {
    fun label(): String = when (pipeline) {
        "dev" -> if (mode == "complet") "Développement complet" else "Développement léger"
        else -> PIPE_LABEL[pipeline] ?: pipeline
    }

    fun rows(): List<JournalPipelineRow> {
        val titleOf = { id: String -> planned.firstOrNull { it.first == id }?.second ?: id }
        val done = steps.map { s ->
            val id = s.s("id") ?: "?"
            val status = s.s("status") ?: "running"
            val head = buildString {
                append(titleOf(id))
                s.s("item")?.let { append(" item $it") } ?: s.i("item")?.let { append(" item $it") }
                (s.i("attempt") ?: 1).takeIf { it > 1 }?.let { append(" essai $it") }
                append(" · ")
                append(shortModel(s.s("served") ?: s.s("model")).ifBlank { "défaut du projet" })
                if (s.s("source") == "project-default") append(" ⚠ défaut du projet")
                append(" · ")
                append(STEP_STATUS[status] ?: status)
                if (s.b("covered")) append(" ↺ déjà couvert")
                s.l("durationMs")?.let { append(" · ${fmtDuration(it)}") }
            }
            JournalPipelineRow(id, head, s.s("why")?.lineSequence()?.firstOrNull()?.take(220), status, false)
        }
        val todo = if (status == "running" || status == "paused") planned
            .filter { p -> steps.none { it.s("id") == p.first && (it.s("status") == "ok" || it.s("status") == "running") } }
            .filter { p -> steps.none { it.s("id") == p.first } }
            .map { p -> JournalPipelineRow(p.first, "${p.second} · ${shortModel(p.third).ifBlank { "défaut du projet" }} · à venir", null, "todo", true) }
        else emptyList()
        return done + todo
    }

    fun headline(): String = buildString {
        append(run)
        if (resumed) append(" · reprise")
        if (items > 0) append(" · $items item(s) cochés")
        if (covered > 0) append(" dont $covered déjà couvert(s)")
        if (loops > 0) append(" · $loops retour(s) de revue")
    }

    companion object {
        val PIPE_LABEL = mapOf(
            "discussion" to "Discussion", "incident" to "Incident", "recherche" to "Recherche", "audit" to "Audit sécurité",
            "maintenance" to "Maintenance", "nouveau" to "Nouveau projet", "donnees" to "Données", "redaction" to "Rédaction",
            "reunion" to "Compte rendu de réunion", "routage" to "Routage (chef)", "images" to "Images", "video" to "Vidéo", "audio" to "Audio",
        )
        val STEP_STATUS = mapOf(
            "ok" to "✓", "refused" to "✕ refusé", "failed" to "✕ échec", "model_unavailable" to "⏸ model indisponible",
            "launch_failed" to "⚡ n’a pas démarré", "launch_refused" to "⛔ lancement refusé par l’orchestrateur",
            "running" to "● en cours", "skipped" to "↷ sautée",
        )
    }
}

data class JournalTurn(
    val start: String?, val end: String?, val outcome: String, val subtype: String?,
    val prompt: String?, val promptFull: String?, val resultFull: String?,
    val summary: List<String>, val question: String?, val tools: Int,
    val durationMs: Long?, val costUsd: Double?, val model: String?,
    val stopBy: String?, val stopReason: String?, val testLabel: String?,
    val langIssue: Boolean, val langOriginal: String?,
    val pipeline: JournalPipeline?, val bypassReason: String?,
    val raw: JsonElement?,
) {
    fun mark(): String = OUTCOME[outcome]?.first ?: "✓"

    fun word(): String {
        var w = OUTCOME[outcome]?.second ?: "terminé"
        if (outcome == "stopped" && stopBy != null) w = "arrêté par ${STOP_BY[stopBy] ?: stopBy}"
        if (outcome == "error" && subtype != null) w += " · $subtype"
        if (testLabel != null) w = "🧪 $w · test « $testLabel »"
        return w
    }

    fun meta(): String = listOfNotNull(
        durationMs?.let { fmtDuration(it) },
        costUsd?.let { String.format(Locale.US, "$%.2f", it) },
        shortModel(model).ifBlank { null },
    ).joinToString(" · ")

    fun chips(): List<String> = buildList {
        raw.a("commits").forEach { c -> c.s("sha")?.let { add("commit $it") } }
        if (raw.b("pushed")) add("poussé")
        raw.strs("versions").forEach { add("v$it") }
        raw.strs("urls").forEach { add(it.replace(Regex("^https?://"), "").take(48)) }
    }

    fun urls(): List<String> = raw.strs("urls")

    fun permissionLines(): List<String> = raw.a("permissions").map { p ->
        val d = p.s("decision")
        "🔐 ${p.s("tool") ?: "?"} ${p.s("preview").orEmpty().take(80)} — " +
            (if (d == null) "en attente de votre décision" else PERM_TXT[d] ?: d) +
            (p.s("rule")?.let { " ($it)" } ?: "") + (p.s("message")?.let { " — « $it »" } ?: "")
    }

    fun afterLines(): List<String> = buildList {
        raw.o("ack")?.let { a ->
            val by = a.s("by")?.takeIf { it != "utilisateur" }?.let { " par $it" } ?: ""
            add("✓ marqué vu$by" + (a.s("ts")?.let { " · $it" } ?: "") + (a.s("note")?.let { " — $it" } ?: ""))
        }
        raw.o("resolved")?.let { r -> add("✓ question marquée répondue" + (r.s("note")?.let { " — $it" } ?: "")) }
        raw.o("autoAnswer")?.let { a ->
            val ans = a.s("answer")?.let { " : « ${it.take(200)} »" }
                ?: if (a.s("status") == "submitted") " : soumis à votre décision (garde-fou)" else ""
            add("🤖 réponse automatique (Opus 5.5, utilisateur inactif)$ans" +
                (a.s("reason")?.let { " — raison : $it" } ?: "") + (a.s("recovery")?.let { " — $it" } ?: ""))
        }
    }

    companion object {
        val OUTCOME = mapOf(
            "ok" to ("✓" to "terminé"), "error" to ("✕" to "échec"), "question" to ("?" to "question posée"),
            "ask_chef" to ("⇄" to "attend le chef"), "stopped" to ("■" to "arrêté par le chef"),
            "system" to ("⟲" to "clos par le système"), "interrupted" to ("⟲" to "interrompu"), "running" to ("●" to "en cours"),
        )
        val STOP_BY = mapOf("chef" to "le chef", "supervision" to "la supervision", "test" to "un test", "utilisateur" to "l’utilisateur")
        val PERM_TXT = mapOf(
            "allow_once" to "autorisé une fois", "allow_always" to "toujours autorisé", "rule" to "règle permanente",
            "deny" to "refusé", "expired" to "expiré sans réponse",
        )
    }
}

data class Journal(val turns: List<JournalTurn>, val truncated: Boolean, val regressions: List<JsonElement>)

fun parseJournal(j: JsonElement?): Journal = Journal(
    turns = j.a("turns").map(::parseTurn),
    truncated = j.b("truncated"),
    regressions = j.a("regressions"),
)

private fun parseTurn(t: JsonElement): JournalTurn {
    val p = t.o("pipeline")
    val lang = t.o("lang")
    val langIssue = lang != null || (t.o("langIssue") != null && !t.o("langIssue").b("reformulated"))
    return JournalTurn(
        start = t.s("start"), end = t.s("end"), outcome = t.s("outcome") ?: "ok", subtype = t.s("subtype"),
        prompt = t.s("prompt"), promptFull = t.o("promptFull").s("text"), resultFull = t.o("resultFull").s("text"),
        summary = t.strs("summary"), question = t.s("question"), tools = t.i("tools") ?: 0,
        durationMs = t.l("durationMs"), costUsd = t.d("costUsd"), model = t.s("model"),
        stopBy = t.o("stop").s("by"), stopReason = t.o("stop").s("reason"), testLabel = t.o("test").s("label"),
        langIssue = langIssue, langOriginal = lang.o("original").s("text"),
        pipeline = p?.let {
            JournalPipeline(
                run = it.s("run") ?: "", pipeline = it.s("pipeline") ?: "", mode = it.s("mode"), status = it.s("status"),
                planned = it.a("planned").map { x -> Triple(x.s("id") ?: "", x.s("title") ?: (x.s("id") ?: ""), x.s("model")) },
                steps = it.a("steps"), items = it.i("items") ?: 0, covered = it.i("covered") ?: 0, loops = it.i("loops") ?: 0,
                resumed = it.b("resumed"), escalated = it.s("escalated"), extended = it.s("extended"), defects = it.strs("defects"),
                limitText = it.o("limit").s("text"), backoffText = it.o("backoff").s("text"), backoffSlot = it.o("backoff").s("slot"),
                modelTest = it.o("modelTest").s("text"), modelTestLog = it.o("modelTest").s("logName"),
            )
        },
        bypassReason = t.o("bypass").s("reason"),
        raw = t,
    )
}

fun shortModel(m: String?): String = (m ?: "").removePrefix("claude-").replace(Regex("-\\d{8}$"), "")

/** « 45 s », « 2 min 05 s », « 1 h 02 min » (Salle.fmtAge of the web). */
fun fmtDuration(ms: Long): String {
    val s = ms / 1000
    return when {
        s < 60 -> "$s s"
        s < 3600 -> String.format(Locale.US, "%d min %02d s", s / 60, s % 60)
        else -> String.format(Locale.US, "%d h %02d min", s / 3600, (s % 3600) / 60)
    }
}
