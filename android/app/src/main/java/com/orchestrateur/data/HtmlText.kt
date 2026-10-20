package com.orchestrateur.data

/**
 * HTML output of the models (0.105.0) — port of public/html-render.js for the
 * app. Model text is untrusted, so an HTML fragment is never interpreted as
 * such: [toMarkdown] re-reads it through the same allow-list and produces the
 * Markdown subset the app's renderer draws. Dropped with their content:
 * script, style, iframe, svg, math, object, embed, template, textarea…;
 * attributes are all ignored except a safe `href` and `<ol start>`.
 */
object HtmlText {
    private val VOID = setOf("br", "hr", "col")
    private val ALLOWED = setOf(
        "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
        "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
        "code", "pre", "kbd", "samp", "var", "blockquote", "q", "cite", "abbr", "time",
        "ul", "ol", "li", "dl", "dt", "dd",
        "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
        "a", "span", "div", "section", "article", "header", "footer", "aside", "nav", "main",
        "figure", "figcaption", "details", "summary",
    )
    private val DROP_CONTENT = setOf(
        "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
        "template", "noscript", "noembed", "noframes", "textarea", "title", "svg", "math",
        "xmp", "plaintext", "select", "head",
    )
    private val BLOCK = setOf(
        "p", "div", "section", "article", "header", "footer", "aside", "nav", "main",
        "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "caption",
    )
    private val HEADINGS = setOf("h1", "h2", "h3", "h4", "h5", "h6")
    // Inside these a block break would split the Markdown line: it becomes a space.
    private val INLINE_HOSTS = HEADINGS + setOf("li", "td", "th", "a")

    private val TOKEN = Regex(
        "<!--[\\s\\S]*?(?:-->|\\z)|<[!?][^>]*>?|<(/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\\s+[^\\s\"'>/=]+(?:\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s\"'=<>`]+))?)*)\\s*(/?)>",
    )
    private val ATTR = Regex("([^\\s\"'>/=]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?")
    private val ENTITY = Regex("&(#\\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});")
    private val NAMED = mapOf(
        "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ", "colon" to ":", "tab" to "\t", "newline" to "\n",
        "laquo" to "«", "raquo" to "»", "hellip" to "…", "mdash" to "—", "ndash" to "–", "rsquo" to "’", "lsquo" to "‘",
        "ldquo" to "“", "rdquo" to "”", "euro" to "€", "copy" to "©", "reg" to "®", "deg" to "°", "times" to "×", "middot" to "·",
        "bull" to "•", "rarr" to "→", "larr" to "←", "check" to "✓", "eacute" to "é", "egrave" to "è", "ecirc" to "ê",
        "agrave" to "à", "acirc" to "â", "ccedil" to "ç", "ugrave" to "ù", "ucirc" to "û", "icirc" to "î", "ocirc" to "ô",
        "Eacute" to "É", "Agrave" to "À", "Ccedil" to "Ç",
    )
    // Control characters, whitespace and zero-width / line-separator code points.
    private val INVISIBLE = Regex("[\\u0000-\\u0020\\u007f-\\u00a0\\u200b-\\u200f\\u2028\\u2029\\ufeff]")
    private val SAFE_HREF = Regex("^(?:https?://|mailto:|/(?!/)|#)", RegexOption.IGNORE_CASE)
    private val BLOCK_CLOSE = Regex("</(?:p|div|ul|ol|li|table|tr|td|th|h[1-6]|pre|blockquote|section|article|details|dl|dd|dt|summary|figure)\\s*>", RegexOption.IGNORE_CASE)
    private val LEADING_TAG = Regex("^(?:<!doctype[^>]*>\\s*|<!--[\\s\\S]*?-->\\s*)*<(html|body|[a-z][a-z0-9]*)\\b[^>]*>", RegexOption.IGNORE_CASE)
    private val ANY_CLOSE = Regex("</[a-z][a-z0-9]*\\s*>|<br\\s*/?>", RegexOption.IGNORE_CASE)
    private val MD_LINK = Regex("\\[([^\\]\\n]*)\\]\\(([^)\\n]*)\\)")

    fun decodeEntities(s: String): String = ENTITY.replace(s) { m ->
        val e = m.groupValues[1]
        if (e[0] == '#') {
            val n = if (e.length > 1 && (e[1] == 'x' || e[1] == 'X')) e.substring(2).toIntOrNull(16) else e.substring(1).toIntOrNull()
            if (n != null && n in 1..0x10ffff) String(Character.toChars(n)) else ""
        } else NAMED[e] ?: NAMED[e.lowercase()] ?: m.value
    }

    /** Only http(s), mailto, same-origin absolute paths and anchors, judged on the decoded, squeezed value. */
    fun safeHref(raw: String): String? {
        val v = INVISIBLE.replace(decodeEntities(raw), "")
        return if (SAFE_HREF.containsMatchIn(v)) v else null
    }

    private fun stripCode(s: String) = s.replace(Regex("```[\\s\\S]*?(?:```|\\z)"), " ").replace(Regex("`[^`\\n]*`"), " ")

    /** HTML fragment, or legacy Markdown / plain text? (same rule as the web) */
    fun isHtml(text: String?): Boolean {
        val s = stripCode(text ?: "").trim()
        if (s.isEmpty() || '<' !in s) return false
        val closes = BLOCK_CLOSE.findAll(s).count()
        if (closes >= 2) return true
        val lead = LEADING_TAG.find(s) ?: return false
        if (closes >= 1 || ANY_CLOSE.containsMatchIn(s)) {
            val name = lead.groupValues[1].lowercase()
            return name in ALLOWED || name == "html" || name == "body"
        }
        return false
    }

    /** Targets of the Markdown links `[label](url)` of [md] (test helper, same rule as the renderer). */
    fun markdownLinkUrls(md: String): List<String> = MD_LINK.findAll(md).map { it.groupValues[2].trim() }.toList()

    private fun walk(src: String, onText: (String) -> Unit, onOpen: (String, String, Boolean) -> Unit, onClose: (String) -> Unit) {
        var i = 0
        while (i <= src.length) {
            val m = TOKEN.find(src, i) ?: break
            if (m.range.first > i) onText(src.substring(i, m.range.first))
            i = m.range.last + 1
            val tag = m.groupValues[2].lowercase()
            if (tag.isEmpty()) continue // comment, doctype, processing instruction
            val closing = m.groupValues[1].isNotEmpty()
            if (!closing && tag in DROP_CONTENT) {
                val c = Regex("</$tag\\s*>", RegexOption.IGNORE_CASE).find(src, i)
                i = c?.range?.last?.plus(1) ?: src.length
                continue
            }
            if (closing) onClose(tag) else onOpen(tag, m.groupValues[3], m.groupValues[4].isNotEmpty())
        }
        if (i < src.length) onText(src.substring(i))
    }

    private fun attr(attrs: String, name: String): String? =
        ATTR.findAll(attrs).firstOrNull { it.groupValues[1].equals(name, ignoreCase = true) }
            ?.let { m -> decodeEntities(m.groups[2]?.value ?: m.groups[3]?.value ?: m.groups[4]?.value ?: "") }

    private class Frame(val kind: String, val data: String? = null) { val sb = StringBuilder() }
    private class ListCtx(val ordered: Boolean, var n: Int)

    /** HTML fragment → Markdown of the app's renderer (allow-list applied, nothing executable kept). */
    fun toMarkdown(html: String): String {
        val stack = mutableListOf<String>()
        val frames = mutableListOf(Frame("root"))
        val lists = mutableListOf<ListCtx>()
        val tables = mutableListOf<MutableList<MutableList<String>>>()
        fun cur() = frames.last().sb
        fun inline() = stack.any { it in INLINE_HOSTS }
        fun inPre() = frames.any { it.kind == "pre" }
        fun trimEndSpaces(sb: StringBuilder) { while (sb.isNotEmpty() && (sb.last() == ' ' || sb.last() == '\t')) sb.setLength(sb.length - 1) }
        fun space() { val sb = cur(); if (sb.isNotEmpty() && !sb.last().isWhitespace()) sb.append(' ') }
        fun blockBreak() {
            if (inline()) { space(); return }
            val sb = cur()
            trimEndSpaces(sb)
            if (sb.isEmpty()) return
            while (!sb.endsWith("\n\n")) sb.append('\n')
        }
        fun lineStart() { val sb = cur(); trimEndSpaces(sb); if (sb.isNotEmpty() && sb.last() != '\n') sb.append('\n') }
        fun appendText(t: String) {
            val sb = cur()
            if (t.startsWith(" ") && (sb.isEmpty() || sb.last().isWhitespace())) sb.append(t.trimStart()) else sb.append(t)
        }
        // A model cannot forge a Markdown link (or a code span) through plain HTML text.
        fun neutral(t: String) = t.replace("](", "] (").replace("`", "'")

        fun closeOne(tag: String) {
            when {
                tag in HEADINGS -> blockBreak()
                tag == "strong" || tag == "b" -> cur().append("**")
                tag == "em" || tag == "i" -> cur().append("*")
                tag == "code" -> if (!inPre()) cur().append("`")
                tag == "pre" -> {
                    val f = frames.removeAt(frames.lastIndex)
                    blockBreak()
                    cur().append("```\n").append(f.sb.toString().trim('\n')).append("\n```")
                    blockBreak()
                }
                tag == "ul" || tag == "ol" -> { if (lists.isNotEmpty()) lists.removeAt(lists.lastIndex); blockBreak() }
                tag == "li" -> lineStart()
                tag == "blockquote" -> {
                    val f = frames.removeAt(frames.lastIndex)
                    val body = f.sb.toString().lines().map { it.trim() }.filter { it.isNotEmpty() }
                    blockBreak()
                    cur().append(body.joinToString("\n") { "> $it" })
                    blockBreak()
                }
                tag == "td" || tag == "th" -> {
                    val f = frames.removeAt(frames.lastIndex)
                    val cell = f.sb.toString().replace(Regex("\\s+"), " ").replace("|", "/").trim()
                    tables.lastOrNull()?.let { t -> if (t.isEmpty()) t += mutableListOf<String>(); t.last() += cell }
                }
                tag == "table" -> {
                    val rows = if (tables.isNotEmpty()) tables.removeAt(tables.lastIndex).filter { it.isNotEmpty() } else emptyList()
                    if (rows.isNotEmpty()) {
                        blockBreak()
                        val head = rows.first()
                        val sb = cur()
                        sb.append("| ").append(head.joinToString(" | ")).append(" |\n")
                        sb.append("|").append(head.joinToString("|") { "---" }).append("|")
                        for (r in rows.drop(1)) sb.append("\n| ").append(r.joinToString(" | ")).append(" |")
                        blockBreak()
                    }
                }
                tag == "a" -> {
                    val f = frames.removeAt(frames.lastIndex)
                    val label = IdLinks.strip(f.sb.toString()).replace(Regex("\\s+"), " ").trim().replace('[', '(').replace(']', ')')
                    val url = f.data
                    if (url != null && label.isNotEmpty()) cur().append("[").append(label).append("](").append(url.replace(")", "%29").replace(" ", "%20")).append(")")
                    else appendText(label)
                }
                tag in BLOCK -> blockBreak()
            }
        }

        walk(html,
            onText = { raw ->
                val t = decodeEntities(raw)
                when {
                    inPre() -> cur().append(t)
                    stack.isEmpty() -> {
                        // Top-level prose between blocks (e.g. a NEEDS_USER_INPUT line) keeps its line breaks.
                        val body = t.trim()
                        if (body.isEmpty()) { if ('\n' !in t && t.isNotEmpty()) space() }
                        else {
                            if (t.first().isWhitespace()) space()
                            body.lines().map { it.trim().replace(Regex("\\s+"), " ") }.forEachIndexed { k, line ->
                                if (k > 0) blockBreak()
                                appendText(neutral(line))
                            }
                            if (t.last().isWhitespace()) space()
                        }
                    }
                    else -> appendText(neutral(t.replace(Regex("\\s+"), " ")))
                }
            },
            onOpen = { tag, attrs, selfClose ->
                if (tag in ALLOWED) {
                    when {
                        tag in HEADINGS -> { blockBreak(); cur().append("#".repeat(tag[1].digitToInt())).append(' ') }
                        tag == "br" -> blockBreak()
                        tag == "hr" -> { blockBreak(); cur().append("---"); blockBreak() }
                        tag == "strong" || tag == "b" -> cur().append("**")
                        tag == "em" || tag == "i" -> cur().append("*")
                        tag == "code" -> if (!inPre()) cur().append("`")
                        tag == "pre" -> frames += Frame("pre")
                        tag == "ul" || tag == "ol" -> {
                            blockBreak()
                            lists += ListCtx(tag == "ol", attr(attrs, "start")?.trim()?.toIntOrNull() ?: 1)
                        }
                        tag == "li" -> {
                            lineStart()
                            val l = lists.lastOrNull()
                            cur().append("  ".repeat((lists.size - 1).coerceAtLeast(0)))
                            cur().append(if (l?.ordered == true) "${l.n++}. " else "- ")
                        }
                        tag == "blockquote" -> frames += Frame("bq")
                        tag == "table" -> tables += mutableListOf<MutableList<String>>()
                        tag == "tr" -> tables.lastOrNull()?.add(mutableListOf())
                        tag == "td" || tag == "th" -> frames += Frame("cell")
                        tag == "a" -> frames += Frame("a", attr(attrs, "href")?.let { safeHref(it) })
                        tag in BLOCK -> blockBreak()
                    }
                    if (tag !in VOID) {
                        stack += tag
                        if (selfClose) { stack.removeAt(stack.lastIndex); closeOne(tag) }
                    }
                }
            },
            onClose = { tag ->
                if (tag in ALLOWED && tag !in VOID) {
                    val at = stack.lastIndexOf(tag)
                    if (at >= 0) while (stack.size > at) closeOne(stack.removeAt(stack.lastIndex))
                }
            })
        while (stack.isNotEmpty()) closeOne(stack.removeAt(stack.lastIndex))
        while (frames.size > 1) { val f = frames.removeAt(frames.lastIndex); cur().append(f.sb) }
        return cur().toString()
            .replace(Regex("[ \\t]+\\n"), "\n")
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()
    }
}
