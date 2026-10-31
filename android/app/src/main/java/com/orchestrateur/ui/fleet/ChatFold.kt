package com.orchestrateur.ui.fleet

/**
 * A technical message of the chef thread, shown folded on one line
 * (« ▸ type · summary ») and expanded on tap.
 *
 * Only the user's own messages and the chef's replies to them stay open. What
 * the thread stream provides (server /api/conductor-chat and live
 * `user_prompt`): a `source` for most machine messages (wake, pipeline,
 * permission, musician notify…), but the relays written by the server
 * ([NEEDS_CHEF_INPUT_FROM:…], [ALERTE …], « ⏳ Ta réponse à la pause… »,
 * [REPRISE]) carry none, and a chef reply carries no origin at all. So: the
 * source when present, otherwise the fixed protocol prefixes — never a guess
 * on free text.
 */
data class ChatFold(val type: String, val summary: String)

object ChatFoldRule {
    private const val SUMMARY_MAX = 110

    private val REPRISE_RE = Regex("""^\[REPRISE\][^\n]*(?:\n\s*)*""")
    private val NEEDS_CHEF_RE = Regex("""^\[NEEDS_CHEF_INPUT_FROM:\s*([^\]]+)\]\s*""")
    private val ASKS_LINE_RE = Regex("""^Le musicien « [^»]+ » te demande une décision\s*:?\s*$""")
    private val WAKE_RE = Regex("""^\[CALLBACK_WAKE[^\]]*\]\s*""")
    private val ALERT_RE = Regex("""^\[ALERTE[^\]]*\]\s*""")
    private val ALERT_ITEM_RE = Regex("""^\d+\.\s+(.*)$""")
    private val PAUSE_NOTICE_RE = Regex("""^(?:\[p-[^\]]*\]\s*)?[⏳⚠]️?\s*Ta réponse à la pause""")
    private val ANSWER_RE = Regex("""^\[ANSWER\]\s*""")

    /** Labels of the server's own sources; any other source is a project (musician notify). */
    private val SOURCE_TYPES = mapOf(
        "wake" to "réveil",
        "pipeline" to "pipeline",
        "pipeline-chef-pause" to "pause à trancher",
        "pipeline-limit" to "limite de pipeline",
        "pipeline-defect" to "défaut",
        "pipeline-gap" to "lacune",
        "permission" to "autorisation",
        "lane-integration" to "intégration",
        "alerte-chef" to "alerte",
        "idle-regression" to "non-régression",
        "routage-duplicate" to "doublon du Routage",
    )

    /** A message received by the chef (role user). Null = typed by the user: stays open. */
    fun forUser(text: String, source: String? = null): ChatFold? {
        val t = text.trim()
        if (source != null && source.isNotBlank()) {
            // An @shortcut prompt carries source "shortcut→X" but is the user's own message.
            if (source.startsWith("shortcut")) return null
            val type = SOURCE_TYPES[source] ?: "message de $source"
            return ChatFold(type, summarize(t))
        }
        val reprise = REPRISE_RE.find(t)
        if (reprise != null) {
            val rest = t.substring(reprise.range.last + 1).trim()
            // A lost turn replayed: the inner message decides. A user's own
            // message replayed after a lost turn is still a dialogue.
            if (rest.isEmpty()) return ChatFold("reprise", summarize(t.removePrefix("[REPRISE]")))
            return forUser(rest)?.let { it.copy(type = it.type + " (reprise)") }
        }
        NEEDS_CHEF_RE.find(t)?.let { m ->
            val body = t.substring(m.range.last + 1).lines().filterNot { ASKS_LINE_RE.matches(it.trim()) }
            return ChatFold("question de ${m.groupValues[1].trim()}", summarize(body.joinToString("\n")))
        }
        WAKE_RE.find(t)?.let { m -> return ChatFold("réveil", summarize(t.substring(m.range.last + 1))) }
        ALERT_RE.find(t)?.let { m ->
            val body = t.substring(m.range.last + 1)
            val item = body.lines().firstNotNullOfOrNull { ALERT_ITEM_RE.find(it.trim())?.groupValues?.get(1) }
            return ChatFold("alerte", summarize(item ?: body))
        }
        if (PAUSE_NOTICE_RE.containsMatchIn(t)) {
            return ChatFold("réponse à la pause", summarize(t.replace(Regex("""^\[p-[^\]]*\]\s*"""), "")))
        }
        return null
    }

    /** A chef reply (role conductor). Only the [ANSWER] replies to a musician fold. */
    fun forConductor(text: String): ChatFold? {
        val t = text.trim()
        val m = ANSWER_RE.find(t) ?: return null
        return ChatFold("réponse au musicien", summarize(t.substring(m.range.last + 1)))
    }

    /** First meaningful line, whitespace collapsed, cut at [SUMMARY_MAX]. */
    fun summarize(text: String): String {
        val line = text.lines().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: return ""
        val flat = line.replace(Regex("""\s+"""), " ")
        return if (flat.length <= SUMMARY_MAX) flat else flat.take(SUMMARY_MAX - 1).trimEnd() + "…"
    }
}
