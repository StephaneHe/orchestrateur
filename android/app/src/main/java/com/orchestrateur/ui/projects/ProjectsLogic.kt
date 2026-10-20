package com.orchestrateur.ui.projects

import com.orchestrateur.data.b
import com.orchestrateur.data.d
import com.orchestrateur.data.i
import com.orchestrateur.data.l
import com.orchestrateur.data.list
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import com.orchestrateur.data.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * Pure port of public/projets.js (« Projets », 0.29.0) and of Salle.healthFlag
 * / Salle.alarming (0.47.2). The web reads the state from its SSE reducer; the
 * app reads the same fields from the /api/pupitre snapshot (server-side
 * reducer), plus `lastLine` from /api/config.
 */

data class StopInfo(val by: String, val reason: String)
data class LastTurn(val durationMs: Long?, val costUsd: Double?, val subtype: String?)

data class ProjectRow(
    val name: String,
    val state: String = "idle",
    val stopped: StopInfo? = null,
    val awaitingChef: Boolean = false,
    val testRun: Boolean = false,
    val testLabel: String? = null,
    val deadInFlight: Boolean = false,
    val stalled: Boolean = false,
    val silentMs: Long? = null,
    val awaitingPermission: Boolean = false,
    val awaitingPermissionTool: String? = null,
    val queueDepth: Int = 0,
    val callbackTo: String? = null,
    val isConductor: Boolean = false,
    val model: String? = null,
    val configModel: String? = null,
    val lastActivityAt: Long? = null,
    val lastActivitySource: String? = null,
    val turnElapsedMs: Long? = null,
    val activity: String? = null,
    val mission: String? = null,
    val needsInput: String? = null,
    val questionResolved: Boolean = false,
    val questionResolvedNote: String? = null,
    val lastTurn: LastTurn? = null,
    val version: String? = null,
    val apkAt: Long? = null,
    val lastLine: String? = null,
)

data class PupitreSnapshot(val now: Long?, val conductor: String?, val rows: List<ProjectRow>)

private fun stopOf(j: JsonElement?): StopInfo? =
    j?.let { StopInfo(it.s("by") ?: "chef", it.s("reason").orEmpty()) }

fun parsePupitre(json: JsonElement?): PupitreSnapshot {
    val rows = json.o("fleet").list.mapNotNull { r ->
        val name = r.s("name") ?: return@mapNotNull null
        val test = r.o("testRun")
        val perm = r.o("awaitingPermission")
        val qr = r.o("questionResolved")
        val lt = r.o("lastTurn")
        ProjectRow(
            name = name,
            state = r.s("state") ?: "idle",
            stopped = stopOf(r.o("stopped")),
            awaitingChef = r.b("awaitingChef"),
            testRun = test != null,
            testLabel = test?.let { (it as? JsonPrimitive)?.str ?: it.s("label") ?: "essai" },
            deadInFlight = r.b("deadInFlight"),
            stalled = r.b("stalled"),
            silentMs = r.l("silentMs"),
            awaitingPermission = perm != null && perm.toString() != "false",
            awaitingPermissionTool = perm.s("tool"),
            queueDepth = r.i("queueDepth") ?: 0,
            callbackTo = r.s("callbackTo"),
            isConductor = r.b("isConductor"),
            model = r.s("model"),
            configModel = r.s("configModel"),
            lastActivityAt = r.l("lastActivityAt"),
            lastActivitySource = r.s("lastActivitySource"),
            turnElapsedMs = r.l("turnElapsedMs"),
            activity = r.s("activity"),
            mission = r.s("mission"),
            needsInput = r.s("needsInput"),
            questionResolved = qr != null,
            questionResolvedNote = qr.s("note")?.takeIf { it.isNotBlank() },
            lastTurn = lt?.let { LastTurn(it.l("durationMs"), it.d("costUsd"), it.s("subtype")) },
            version = r.o("version").s("value"),
            apkAt = r.o("build").l("apkAt"),
        )
    }
    return PupitreSnapshot(json.l("now"), json.s("conductor"), rows)
}

/** Adds `lastLine` (and `stopped` for old servers) from GET /api/config. */
fun mergeConfig(rows: List<ProjectRow>, config: JsonElement?): List<ProjectRow> {
    val byName = config.o("projects").list.associateBy { it.s("name") }
    return rows.map { r ->
        val c = byName[r.name] ?: return@map r
        r.copy(lastLine = c.s("lastLine") ?: r.lastLine, stopped = r.stopped ?: stopOf(c.o("stopped")))
    }
}

// ---------- health (salle.js) ----------

data class HealthFlag(val kind: String, val text: String, val neutral: Boolean = false)

/** salle.js fmtAge: 59s · 2m05 · 1h01. */
fun fmtDur(ms: Long?): String {
    if (ms == null || ms < 0) return "—"
    val s = ms / 1000
    if (s < 60) return "${s}s"
    val mn = s / 60
    if (mn < 60) return "${mn}m" + (s % 60).toString().padStart(2, '0')
    return "${mn / 60}h" + (mn % 60).toString().padStart(2, '0')
}

fun healthFlag(r: ProjectRow?): HealthFlag? {
    if (r == null) return null
    if (r.awaitingPermission) return HealthFlag("perm", "🔐 attend autorisation · " + (r.awaitingPermissionTool ?: "outil"))
    val inFlight = r.state == "live" || r.state == "think"
    if (r.testRun && inFlight && r.deadInFlight) return HealthFlag("test", "🧪 test interrompu — processus arrêté", neutral = true)
    if (r.testRun && inFlight && r.stalled) return HealthFlag("test", "🧪 test en cours — silence " + fmtDur(r.silentMs), neutral = true)
    if (r.deadInFlight) return HealthFlag("dead", "✗ processus perdu")
    if (r.stalled) return HealthFlag("stall", "! sans progrès " + fmtDur(r.silentMs))
    return null
}

/** Real health incident (red): dead PID without a result, real stall. */
fun alarming(r: ProjectRow?): Boolean {
    val h = healthFlag(r) ?: return false
    return !h.neutral && (h.kind == "dead" || h.kind == "stall")
}

// ---------- classification ----------

enum class Group(val key: String, val title: String) {
    ATTENTION("attention", "À votre attention"),
    ACTIVE("active", "Actifs et en attente"),
    REST("rest", "Au repos"),
}

enum class Kind(val glyph: String, val word: String) {
    QUESTION("?", "Votre réponse attendue"),
    DEAD("✗", "Processus perdu"),
    ERROR("✕", "Échec"),
    STOPPED("■", "Arrêté par le chef"),
    STALL("!", "Sans progrès"),
    TEST("🧪", "Test en cours"),
    LIVE("●", "En cours"),
    THINK("◐", "Réflexion"),
    CHEF("⇄", "Attend le chef"),
    QUEUED("⏳", "En file"),
    UNREAD("✓", "Terminé · non lu"),
    IDLE("○", "Prêt"),
}

/** Colour family of a tile. Volunteer stops, tests and queues stay neutral (0.47.2). */
enum class Tone { INPUT, ALARM, NEUTRAL, LIVE, THINK, UNREAD, IDLE }

fun toneOf(k: Kind): Tone = when (k) {
    Kind.QUESTION -> Tone.INPUT
    Kind.DEAD, Kind.ERROR, Kind.STALL -> Tone.ALARM
    Kind.STOPPED, Kind.TEST, Kind.QUEUED -> Tone.NEUTRAL
    Kind.LIVE -> Tone.LIVE
    Kind.THINK -> Tone.THINK
    Kind.CHEF, Kind.UNREAD -> Tone.UNREAD
    Kind.IDLE -> Tone.IDLE
}

data class Classified(val group: Group, val kind: Kind, val rank: Int)

fun classify(r: ProjectRow): Classified {
    val inFlight = r.state == "live" || r.state == "think"
    val h = healthFlag(r)
    return when {
        r.state == "input" -> Classified(Group.ATTENTION, Kind.QUESTION, 0)
        h?.kind == "dead" -> Classified(Group.ATTENTION, Kind.DEAD, 1)
        r.state == "error" -> Classified(Group.ATTENTION, if (r.stopped != null) Kind.STOPPED else Kind.ERROR, 2)
        h?.kind == "stall" -> Classified(Group.ATTENTION, Kind.STALL, 3)
        inFlight && r.testRun -> Classified(Group.ACTIVE, Kind.TEST, 0)
        inFlight -> Classified(Group.ACTIVE, if (r.state == "think") Kind.THINK else Kind.LIVE, 0)
        r.state == "unread" && r.awaitingChef -> Classified(Group.ACTIVE, Kind.CHEF, 1)
        r.queueDepth > 0 -> Classified(Group.ACTIVE, Kind.QUEUED, 2)
        r.state == "unread" -> Classified(Group.REST, Kind.UNREAD, 0)
        else -> Classified(Group.REST, Kind.IDLE, 1)
    }
}

private val STOP_BY = mapOf("chef" to "par le chef", "supervision" to "par la supervision", "test" to "(essai)", "utilisateur" to "par l'utilisateur")

/** TurnCore.stopWord: « Arrêté par la supervision »… */
fun stopWord(stop: StopInfo?): String =
    "Arrêté " + (STOP_BY[stop?.by] ?: stop?.by?.let { "par $it" } ?: "par le chef")

fun wordOf(kind: Kind, r: ProjectRow): String =
    if (kind == Kind.STOPPED && r.stopped != null) stopWord(r.stopped) else kind.word

data class Described(val kind: Kind, val group: Group, val glyph: String, val word: String)

fun describe(r: ProjectRow): Described {
    val c = classify(r)
    return Described(c.kind, c.group, c.kind.glyph, wordOf(c.kind, r))
}

// ---------- lines and ages ----------

private val SENTINEL = Regex("^NEEDS_(USER|CHEF)_INPUT:\\s*", RegexOption.IGNORE_CASE)

/** Results are Markdown: bold and code marks are noise on a single line. */
fun cleanLine(s: String?): String =
    (s ?: "").replace(SENTINEL, "").replace(Regex("\\*\\*|__|`"), "")
        .replace(Regex("^#+\\s*"), "").replace(Regex("\\s+"), " ").trim()

private fun String.orIfEmpty(alt: String) = ifEmpty { alt }

fun lineOf(r: ProjectRow, kind: Kind): String = when (kind) {
    Kind.QUESTION -> cleanLine(r.needsInput ?: r.lastLine).orIfEmpty("question sans texte")
    Kind.ERROR -> cleanLine(r.lastTurn?.subtype?.takeIf { it != "success" } ?: r.lastLine).orIfEmpty("échec du tour")
    Kind.DEAD -> "le tour n'a plus de processus" + (r.activity?.let { " · " + cleanLine(it) } ?: "")
    Kind.STALL -> cleanLine(r.activity ?: r.lastLine).orIfEmpty("aucun événement récent")
    Kind.LIVE -> cleanLine(r.activity ?: r.lastLine ?: r.mission).orIfEmpty("démarrage…")
    Kind.TEST -> {
        val h = healthFlag(r)
        (r.testLabel?.let { "$it · " } ?: "") + (h?.text ?: cleanLine(r.activity ?: r.lastLine).orIfEmpty("démarrage…"))
    }
    Kind.THINK -> cleanLine(r.activity?.takeIf { it != "(réflexion…)" }).orIfEmpty("réflexion…")
    Kind.CHEF -> "décision demandée au chef" + (r.lastLine?.takeIf { it.isNotEmpty() }?.let { " · " + cleanLine(it) } ?: "")
    Kind.QUEUED -> "${r.queueDepth} tâche${if (r.queueDepth > 1) "s" else ""} en file, démarrage à la fin du tour"
    else -> if (r.state == "idle" && r.questionResolved)
        "✓ question marquée répondue" + (r.questionResolvedNote?.let { " — " + cleanLine(it) } ?: "")
    else cleanLine(r.lastLine?.takeIf { it.isNotEmpty() } ?: r.mission).orIfEmpty("—")
}

fun fmtAgo(ts: Long?, now: Long): String {
    if (ts == null || ts <= 0) return "jamais observé"
    val s = maxOf(0L, (now - ts) / 1000)
    if (s < 45) return "à l'instant"
    val mn = s / 60
    if (mn < 60) return "il y a ${maxOf(1L, mn)} min"
    val h = mn / 60
    if (h < 48) return "il y a $h h"
    return "il y a ${h / 24} j"
}

data class AgeText(val text: String, val live: Boolean)

/** Turn in flight, silence when stalled, else last activity (« ~ » = mtime approximation). */
fun ageOf(r: ProjectRow, kind: Kind, now: Long, recvElapsedMs: Long = 0): AgeText {
    if (kind == Kind.STALL && r.silentMs != null) return AgeText("silence " + fmtDur(r.silentMs + recvElapsedMs), true)
    if ((kind == Kind.LIVE || kind == Kind.THINK || kind == Kind.DEAD || kind == Kind.TEST) && r.turnElapsedMs != null)
        return AgeText("tour " + fmtDur(r.turnElapsedMs + recvElapsedMs), true)
    val ts = r.lastActivityAt?.takeIf { it > 0 }
    val approx = if (ts != null && r.lastActivitySource == "mtime") "~ " else ""
    return AgeText(approx + fmtAgo(ts, now), false)
}

/** « opus-5-5 » when served, « prévu sonnet-5 » when only configured. */
fun shortModel(r: ProjectRow): String? {
    val m = r.model ?: r.configModel ?: return null
    if (m == "<synthetic>") return null
    val short = m.replace(Regex("^claude-"), "").replace(Regex("-\\d{8}$"), "")
    return if (r.model != null) short else "prévu $short"
}

fun detailsOf(r: ProjectRow, now: Long): String {
    val bits = mutableListOf<String>()
    r.version?.let { bits += "code v$it" }
    r.apkAt?.let { bits += "APK copié ${fmtAgo(it, now)}" }
    r.lastTurn?.let { t ->
        val parts = mutableListOf("dernier tour")
        t.durationMs?.let { parts += fmtDur(it) }
        parts += t.costUsd?.let { "coût rapporté \$" + String.format(java.util.Locale.ROOT, "%.2f", it) } ?: "coût non fourni"
        bits += parts.joinToString(" ")
    }
    return bits.joinToString(" · ").ifEmpty { "aucune métadonnée de livrable" }
}

// ---------- view model ----------

data class ProjectItem(
    val row: ProjectRow,
    val kind: Kind,
    val group: Group,
    val rank: Int,
    val word: String,
    val line: String,
    val tone: Tone,
    val isChef: Boolean,
    val age: AgeText,
    val model: String?,
    val details: String,
)

data class GroupView(val group: Group, val items: List<ProjectItem>, val visible: List<ProjectItem>, val hidden: Boolean, val countText: String)

data class Counts(val all: Int, val attention: Int, val active: Int, val rest: Int, val live: Int, val questions: Int) {
    fun of(g: Group?): Int = when (g) { null -> all; Group.ATTENTION -> attention; Group.ACTIVE -> active; Group.REST -> rest }
}

data class ProjectsView(val groups: List<GroupView>, val counts: Counts) {
    fun group(g: Group): GroupView = groups.first { it.group == g }
}

fun matches(filter: String, it: ProjectItem): Boolean {
    val f = filter.trim().lowercase()
    if (f.isEmpty()) return true
    return it.row.name.lowercase().contains(f) || it.line.lowercase().contains(f) || it.word.lowercase().contains(f)
}

/** A counter isolates its group; tapping it again (or « Tous ») shows every group. */
fun toggleOnly(current: Group?, tapped: Group?): Group? = if (tapped == null || current == tapped) null else tapped

fun buildView(rows: List<ProjectRow>, filter: String, only: Group?, conductor: String?, now: Long, recvElapsedMs: Long = 0): ProjectsView {
    val items = rows.map { r ->
        val c = classify(r)
        ProjectItem(
            row = r, kind = c.kind, group = c.group, rank = c.rank, word = wordOf(c.kind, r), line = lineOf(r, c.kind),
            tone = toneOf(c.kind), isChef = r.isConductor || r.name == conductor,
            age = ageOf(r, c.kind, now, recvElapsedMs), model = shortModel(r), details = detailsOf(r, now),
        )
    }
    val byName = compareBy<ProjectItem> { it.row.name.lowercase() }
    val groups = Group.entries.map { g ->
        val list = items.filter { it.group == g }.sortedWith(
            if (g == Group.REST) compareBy<ProjectItem> { it.rank }.thenByDescending { it.row.lastActivityAt ?: 0L }.then(byName)
            else compareBy<ProjectItem> { it.rank }.then(byName)
        )
        val vis = list.filter { matches(filter, it) }
        val filtering = filter.isNotBlank()
        GroupView(
            group = g, items = list, visible = vis,
            hidden = (only != null && only != g) || (filtering && vis.isEmpty()),
            countText = if (filtering) "${vis.size}/${list.size}" else "${list.size}",
        )
    }
    val counts = Counts(
        all = items.size,
        attention = items.count { it.group == Group.ATTENTION },
        active = items.count { it.group == Group.ACTIVE },
        rest = items.count { it.group == Group.REST },
        live = items.count { it.kind == Kind.LIVE || it.kind == Kind.THINK },
        questions = items.count { it.kind == Kind.QUESTION },
    )
    return ProjectsView(groups, counts)
}
