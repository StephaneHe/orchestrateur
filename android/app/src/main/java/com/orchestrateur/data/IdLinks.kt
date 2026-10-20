package com.orchestrateur.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.regex.Pattern

/**
 * Clickable identifiers in model output (0.107.0) — port of the pure part of
 * public/id-links.js (`linkify`, `strip`, `splitExplicit`), same rules:
 * explicit `[[value]]` / `[[kind:value]]` marks, then the known formats.
 */
data class IdVocab(
    val projects: List<String> = emptyList(),
    val slots: List<String> = emptyList(),
    val conductor: String? = null,
)

/** One identifier found in a text: [start, end) in the source, what to show, what to ask /api/identify. */
data class IdMatch(val start: Int, val end: Int, val display: String, val value: String, val kind: String)

object IdLinks {
    val KINDS = listOf("todo", "run", "queue", "attente", "commit", "version", "projet", "fichier", "case")
    private val ALIASES = mapOf(
        "todo" to "todo", "tache" to "todo", "tâche" to "todo", "item" to "todo", "run" to "run", "execution" to "run", "exécution" to "run",
        "queue" to "queue", "attente" to "attente", "pending" to "attente", "commit" to "commit", "sha" to "commit", "version" to "version",
        "projet" to "projet", "project" to "projet", "musicien" to "projet", "fichier" to "fichier", "file" to "fichier", "chemin" to "fichier",
        "path" to "fichier", "case" to "case", "slot" to "case",
    )
    // Generic project names are linked only when marked [[…]].
    private val COMMON_WORDS = setOf("index", "test", "tests", "demo", "app", "server", "serveur", "docs", "notes",
        "data", "main", "home", "api", "web", "core", "chef", "projet", "lab")
    // Java look-behind needs a bounded length: \s{1,10} instead of the web's \s+.
    private const val DETERMINER = "(?<!(?:^|[^\\p{L}])(?:le|la|les|l'|l’|de|du|des|un|une|en|ma|ta|sa|ce|cette|mon|ton|son|the|a|an|this|my)\\s{1,10})"
    private const val FILE_EXT = "mjs|cjs|js|jsx|ts|tsx|json|jsonl|ndjson|md|kt|kts|java|gradle|css|html|htm|ps1|psm1|py|sh|bat|cmd|txt|log|yml|yaml|toml|xml|csv|sql|apk|png|jpg|svg|lock|env|go|rs|c|h|cpp"
    private val NOT_FILES = Regex("^(?:node|vue|next|nuxt|express|three|d3|chart|react|socket\\.io|p5)\\.js$", RegexOption.IGNORE_CASE)
    private val EXPLICIT = Regex("\\[\\[([^\\[\\]\\n]{1,200})\\]\\]")
    private val SPLIT = Regex("^([a-zà-ÿ]{2,10})\\s*:\\s*(.+)$", RegexOption.IGNORE_CASE)
    private val ALL_LOWER = Regex("^\\p{Ll}+$")

    @Volatile private var cached: Pair<IdVocab, Pattern>? = null

    private fun pattern(v: IdVocab): Pattern {
        cached?.let { if (it.first == v) return it.second }
        val names = v.projects.filter { it.length >= 3 && it != v.conductor && it.lowercase() !in COMMON_WORDS }.sortedByDescending { it.length }
        val weak = names.filter { ALL_LOWER.matches(it) }.map(Pattern::quote)
        val strong = names.filterNot { ALL_LOWER.matches(it) }.map(Pattern::quote)
        val slots = v.slots.filter { it.isNotEmpty() }.sortedByDescending { it.length }.map(Pattern::quote)
        val b = "(?<![\\w./\\\\@#&-])"
        val e = "(?![\\w-]|\\.\\w)"
        val parts = listOfNotNull(
            "\\[\\[(?<explicit>[^\\[\\]\\n<>]{1,200})\\]\\]",
            "$b(?<run>p-\\d{8}T\\d{6}-[0-9a-f]{6})$e",
            "$b(?<queue>q-\\d{10,16}-[0-9a-f]{3,8})$e",
            "$b(?<todo>t-[0-9a-f]{6})$e",
            "$b(?<version>v\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?)$e",
            if (slots.isNotEmpty()) "$b(?<slot>(?:${slots.joinToString("|")}))$e" else null,
            "$b(?<file>(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/])?(?:[\\w@.-]+[\\\\/])*[\\w@-][\\w@.-]*\\.(?:$FILE_EXT)(?::\\d+(?::\\d+)?)?)(?![\\w/\\\\-])",
            "$b(?<hex>(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40})$e",
            if (strong.isNotEmpty()) "$b(?<project>${strong.joinToString("|")})(?![\\w/\\\\-]|\\.\\w)" else null,
            if (weak.isNotEmpty()) "$b$DETERMINER(?<projectw>${weak.joinToString("|")})(?![\\w/\\\\-]|\\.\\w)" else null,
        )
        val p = Pattern.compile(parts.joinToString("|"))
        cached = v to p
        return p
    }

    /** "[[kind:value]]" content → (kind, value); kind "" when absent or unknown. */
    fun splitExplicit(s: String): Pair<String, String> {
        val t = s.trim()
        val m = SPLIT.find(t)
        val k = m?.groupValues?.get(1)?.lowercase()
        if (m != null && k != null && ALIASES.containsKey(k)) return ALIASES.getValue(k) to m.groupValues[2].trim()
        return "" to t
    }

    /** Every identifier of [text], left to right, non-overlapping. */
    fun find(text: String, vocab: IdVocab): List<IdMatch> {
        if (text.isEmpty()) return emptyList()
        val m = pattern(vocab).matcher(text)
        val out = mutableListOf<IdMatch>()
        val hasSlot = vocab.slots.any { it.isNotEmpty() }
        val names = vocab.projects.any { it.length >= 3 }
        fun g(name: String): String? = runCatching { m.group(name) }.getOrNull()
        while (m.find()) {
            val s = m.start(); val en = m.end(); val whole = m.group()
            val explicit = g("explicit")
            val hit = when {
                explicit != null -> splitExplicit(explicit).let { (k, v) -> if (v.isEmpty()) null else IdMatch(s, en, v, v, k) }
                g("file") != null -> if (NOT_FILES.matches(whole)) null else IdMatch(s, en, whole, whole, "fichier")
                g("run") != null -> IdMatch(s, en, whole, whole, "run")
                g("queue") != null -> IdMatch(s, en, whole, whole, "queue")
                g("todo") != null -> IdMatch(s, en, whole, whole, "todo")
                g("version") != null -> IdMatch(s, en, whole, whole, "version")
                hasSlot && g("slot") != null -> IdMatch(s, en, whole, whole, "case")
                g("hex") != null -> IdMatch(s, en, whole, whole, "")
                names && (g("project") != null || g("projectw") != null) -> IdMatch(s, en, whole, whole, "projet")
                else -> null
            }
            if (hit != null) out += hit
        }
        return out
    }

    /** Plain text without the [[…]] marks (speech, summaries). */
    fun strip(text: String): String = EXPLICIT.replace(text) { r -> splitExplicit(r.groupValues[1]).second.ifEmpty { r.value } }
}

/** GET /api/identify/vocab → vocabulary; null when the answer has no project list. */
fun idVocabFrom(j: JsonElement?): IdVocab? {
    if (j.o("projects") !is JsonArray) return null
    return IdVocab(j.strs("projects"), j.strs("slots"), j.s("conductor"))
}

/**
 * Vocabulary shared by every rendered text, fetched at most every 5 minutes.
 * A failed fetch keeps the last vocabulary.
 */
class IdVocabCache(private val maxAgeMs: Long = 5 * 60_000L) {
    private val state = MutableStateFlow(IdVocab())
    val vocab: StateFlow<IdVocab> get() = state
    private var loadedAt = Long.MIN_VALUE / 2
    private var loading = false

    suspend fun refreshIfStale(now: Long = System.currentTimeMillis(), fetch: suspend () -> IdVocab?) {
        synchronized(this) {
            if (loading || now - loadedAt < maxAgeMs) return
            loading = true
            loadedAt = now
        }
        try { fetch()?.let { state.value = it } } finally { synchronized(this) { loading = false } }
    }

    companion object { val shared = IdVocabCache() }
}

/** Where a link of the identifier overlay leads in the app. */
sealed class IdLinkTarget {
    data class Musician(val name: String) : IdLinkTarget()
    data class Route(val route: String) : IdLinkTarget()
}

private val OPEN_ROUTES = mapOf("todo" to "todo", "git" to "git", "release" to "release", "requests" to "requetes")
private val WEB_ROUTES = mapOf("#/models" to "models", "#/projets" to "projets")

/** A web link of /api/identify ({musician} | {route: "#/…"} | {open: side-panel tab}) → app destination, or null. */
fun idLinkTarget(musician: String?, route: String?, open: String?): IdLinkTarget? {
    if (!musician.isNullOrBlank()) return IdLinkTarget.Musician(musician)
    if (!route.isNullOrBlank()) {
        WEB_ROUTES[route.substringBefore('?')]?.let { return IdLinkTarget.Route(it) }
        Regex("^#/m/([^/?]+)").find(route)?.let { return IdLinkTarget.Musician(java.net.URLDecoder.decode(it.groupValues[1], "UTF-8")) }
        return null
    }
    if (!open.isNullOrBlank()) return OPEN_ROUTES[open]?.let { IdLinkTarget.Route(it) }
    return null
}

/** Body of GET /api/identify, ready to draw. */
data class IdInfo(
    val id: String,
    val known: Boolean,
    val kind: String = "",
    val kindLabel: String = "",
    val title: String = "",
    val state: String? = null,
    val tone: String = "neutral",
    val project: String? = null,
    val date: String? = null,
    val summary: String? = null,
    val fields: List<Pair<String, String>> = emptyList(),
    val links: List<Pair<String, IdLinkTarget>> = emptyList(),
    val message: String? = null,
)

fun parseIdentify(j: JsonElement?, id: String): IdInfo {
    val known = j.b("known")
    val realId = j.s("id") ?: id
    if (!known) return IdInfo(id = realId, known = false, kind = j.s("kind").orEmpty(), kindLabel = "Identifiant inconnu",
        title = realId, message = j.s("message") ?: "L’orchestrateur ne trouve pas cet identifiant.")
    val fields = j.a("fields").mapNotNull { f -> val k = f.s("k"); if (k == null) null else k to (f.o("v")?.let { v -> v.str ?: v.toString() } ?: "") }
    val links = j.a("links").filterIsInstance<JsonObject>().mapNotNull { l ->
        idLinkTarget(l.s("musician"), l.s("route"), l.s("open"))?.let { (l.s("label") ?: "Ouvrir") to it }
    }
    return IdInfo(
        id = realId, known = true, kind = j.s("kind").orEmpty(), kindLabel = j.s("kindLabel") ?: "Identifiant",
        title = j.s("title")?.takeIf { it.isNotBlank() } ?: realId, state = j.s("state"), tone = j.s("tone") ?: "neutral",
        project = j.s("project"), date = j.s("date"), summary = j.s("summary"), fields = fields, links = links,
    )
}

private val FR_DATE = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.FRENCH)
private val FR_DATE_TIME = DateTimeFormatter.ofPattern("d MMM yyyy HH:mm", Locale.FRENCH)

/** Date of the overlay, like the web's toLocaleString("fr-FR"): with the time only when the source has one. */
fun fmtIdDate(s: String, zone: ZoneId = ZoneId.systemDefault()): String {
    if (Regex("T\\d\\d:\\d\\d").containsMatchIn(s)) {
        runCatching { return FR_DATE_TIME.format(Instant.parse(s).atZone(zone)) }
        runCatching { return FR_DATE_TIME.format(java.time.OffsetDateTime.parse(s).atZoneSameInstant(zone)) }
        runCatching { return FR_DATE_TIME.format(java.time.LocalDateTime.parse(s)) }
    }
    runCatching { return FR_DATE.format(LocalDate.parse(s.take(10))) }
    return s
}
