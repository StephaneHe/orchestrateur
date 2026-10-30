package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.runtime.setValue
import androidx.compose.foundation.clickable
import androidx.compose.ui.window.Dialog
import coil.compose.AsyncImage
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.HtmlText
import com.orchestrateur.data.IdLinks
import com.orchestrateur.data.IdMatch
import com.orchestrateur.data.IdVocab
import com.orchestrateur.data.IdVocabCache
import com.orchestrateur.data.MediaKind
import com.orchestrateur.data.MediaLinks
import com.orchestrateur.data.getJson
import com.orchestrateur.data.idVocabFrom
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.theme.Palette

private const val URL_TAG = "URL"
private const val ID_TAG = "id"

/**
 * Model / user text drawn with the app's Markdown subset.
 * [html]: an HTML fragment from a model is converted first (0.105.0); user
 * prompts pass false, like mdToHtml(t, {html: false}) on the web.
 * [idrefs]: identifiers become links to the explanation overlay (0.107.0);
 * [project] is the context project sent to /api/identify.
 */
@Composable
fun Markdown(
    src: String,
    baseColor: Color = Palette.Fg0,
    project: String? = null,
    idrefs: Boolean = true,
    html: Boolean = true,
) {
    val vocab = if (idrefs) rememberIdVocab() else null
    val blocks = remember(src, html) { parseBlocks(prepareMarkdown(src, html)) }
    val ri: (String, Color) -> AnnotatedString = { t, c -> renderInline(parseInline(t, vocab), c) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (b in blocks) when (b) {
            is MdBlock.H1 -> LinkableText(ri(b.text, Palette.Accent), color = Palette.Accent, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, project = project)
            is MdBlock.H2 -> LinkableText(ri(b.text, Palette.Accent), color = Palette.Accent, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, project = project)
            is MdBlock.H3 -> LinkableText(ri(b.text, baseColor),     color = baseColor,       fontSize = 14.sp, fontWeight = FontWeight.SemiBold, project = project)
            is MdBlock.Para -> {
                LinkableText(ri(b.text, baseColor), color = baseColor, fontSize = 13.sp, lineHeight = 19.sp, project = project)
                if (idrefs) for (m in MediaLinks.cited(b.text)) MediaPreview(m)
            }
            is MdBlock.Bullet -> Column {
                Row(verticalAlignment = Alignment.Top) {
                    Text("• ", color = baseColor, fontSize = 13.sp)
                    LinkableText(ri(b.text, baseColor), color = baseColor, fontSize = 13.sp, lineHeight = 19.sp, modifier = Modifier.weight(1f), project = project)
                }
                if (idrefs) for (m in MediaLinks.cited(b.text)) MediaPreview(m)
            }
            is MdBlock.Ordered -> Column {
                Row(verticalAlignment = Alignment.Top) {
                    Text("${b.n}. ", color = baseColor, fontSize = 13.sp)
                    LinkableText(ri(b.text, baseColor), color = baseColor, fontSize = 13.sp, lineHeight = 19.sp, modifier = Modifier.weight(1f), project = project)
                }
                if (idrefs) for (m in MediaLinks.cited(b.text)) MediaPreview(m)
            }
            is MdBlock.Quote -> Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(4.dp))
                    .background(Color.White.copy(alpha = 0.04f))
                    .padding(start = 10.dp, top = 6.dp, bottom = 6.dp, end = 10.dp),
            ) {
                Box(
                    Modifier
                        .width(3.dp)
                        .fillMaxHeight()
                        .background(Palette.Accent.copy(alpha = 0.55f)),
                )
                Spacer(Modifier.width(8.dp))
                LinkableText(
                    ri(b.text, baseColor),
                    color = baseColor,
                    fontSize = 13.sp,
                    fontStyle = FontStyle.Italic,
                    lineHeight = 19.sp,
                    modifier = Modifier.weight(1f),
                    project = project,
                )
            }
            is MdBlock.Hr -> Box(
                Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(Palette.CardBorder),
            )
            is MdBlock.Code -> Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(6.dp))
                    .background(Color(0xFF000000).copy(alpha = 0.35f))
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 10.dp, vertical = 8.dp),
            ) {
                Text(
                    b.text,
                    color = Palette.Fg0,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    lineHeight = 17.sp,
                )
            }
            is MdBlock.Table -> MdTable(b, baseColor, ri, project)
        }
    }
}

/** Shared identifier vocabulary (GET /api/identify/vocab, at most every 5 min; fleet names if it fails). */
@Composable
private fun rememberIdVocab(): IdVocab {
    val env = LocalEnv.current
    val cache = IdVocabCache.shared
    val v by cache.vocab.collectAsState()
    LaunchedEffect(Unit) {
        cache.refreshIfStale {
            val r = env.api.getJson("/api/identify/vocab")
            (if (r.ok) idVocabFrom(r.json) else null)
                ?: IdVocab(env.projectNames(), cache.vocab.value.slots, env.conductor()).takeIf { it.projects.isNotEmpty() }
        }
    }
    return v
}

@Composable
private fun MdTable(t: MdBlock.Table, base: Color, ri: (String, Color) -> AnnotatedString, project: String?) {
    val cols = t.header.size.coerceAtLeast(1)
    val rowDivider: @Composable () -> Unit = {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.CardBorder))
    }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .border(1.dp, Palette.CardBorder, RoundedCornerShape(6.dp)),
    ) {
        Row(Modifier.fillMaxWidth().background(Color.White.copy(alpha = 0.05f))) {
            for ((idx, h) in t.header.withIndex()) {
                Box(Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 6.dp)) {
                    LinkableText(
                        ri(h, Palette.Accent),
                        color = Palette.Accent,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        lineHeight = 17.sp,
                        project = project,
                    )
                }
                if (idx < cols - 1) VDivider()
            }
        }
        for (row in t.rows) {
            rowDivider()
            Row(Modifier.fillMaxWidth()) {
                for (c in 0 until cols) {
                    val cell = row.getOrNull(c) ?: ""
                    Box(Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 6.dp)) {
                        LinkableText(ri(cell, base), color = base, fontSize = 12.sp, lineHeight = 17.sp, project = project)
                    }
                    if (c < cols - 1) VDivider()
                }
            }
        }
    }
}

@Composable
private fun VDivider() {
    Box(Modifier.width(1.dp).fillMaxHeight().background(Palette.CardBorder))
}

/**
 * Renders an inline AnnotatedString. URL annotations (markdown links and bare
 * http(s) URLs) open the browser via LocalUriHandler; "id" annotations open
 * the identifier overlay (env.openId). ClickableText is used because the
 * project's Compose (BOM 2024.08 / UI 1.6.8) predates LinkAnnotation.
 */
@Composable
private fun LinkableText(
    text: AnnotatedString,
    color: Color,
    fontSize: TextUnit,
    modifier: Modifier = Modifier,
    fontWeight: FontWeight? = null,
    fontStyle: FontStyle? = null,
    lineHeight: TextUnit = TextUnit.Unspecified,
    project: String? = null,
) {
    val style = TextStyle(
        color = color,
        fontSize = fontSize,
        fontWeight = fontWeight,
        fontStyle = fontStyle,
        lineHeight = lineHeight,
    )
    if (text.getStringAnnotations(URL_TAG, 0, text.length).isEmpty() && text.getStringAnnotations(ID_TAG, 0, text.length).isEmpty()) {
        Text(text, modifier = modifier, style = style)
        return
    }
    val uriHandler = LocalUriHandler.current
    val env = LocalEnv.current
    ClickableText(
        text = text,
        modifier = modifier,
        style = style,
        onClick = { offset ->
            val id = text.getStringAnnotations(ID_TAG, offset, offset).firstOrNull()
            if (id != null) {
                val kind = id.item.substringBefore('\n')
                env.openId(kind.ifEmpty { null }, id.item.substringAfter('\n'), project)
            } else text.getStringAnnotations(URL_TAG, offset, offset).firstOrNull()?.let {
                val url = it.item
                // Same-origin paths are relative to the orchestrator server; anchors have no target in the app.
                when {
                    url.startsWith("/") -> runCatching { uriHandler.openUri(env.api.baseUrl() + url) }
                    !url.startsWith("#") -> runCatching { uriHandler.openUri(url) }
                    else -> Unit
                }
            }
        },
    )
}

internal sealed class MdBlock {
    data class H1(val text: String) : MdBlock()
    data class H2(val text: String) : MdBlock()
    data class H3(val text: String) : MdBlock()
    data class Para(val text: String) : MdBlock()
    data class Bullet(val text: String) : MdBlock()
    data class Ordered(val n: Int, val text: String) : MdBlock()
    data class Quote(val text: String) : MdBlock()
    data class Code(val text: String) : MdBlock()
    data class Table(val header: List<String>, val rows: List<List<String>>) : MdBlock()
    object Hr : MdBlock()
}

internal fun parseBlocks(src: String): List<MdBlock> {
    val out = mutableListOf<MdBlock>()
    val lines = src.split("\n")
    var i = 0
    val paraBuf = StringBuilder()
    fun flushPara() {
        if (paraBuf.isNotEmpty()) {
            out += MdBlock.Para(paraBuf.toString().trim())
            paraBuf.clear()
        }
    }
    val tableSep = Regex("^\\s*\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)+\\|?\\s*$")
    val tableRow = Regex("^\\s*\\|.*\\|?\\s*$")
    fun splitRow(r: String): List<String> =
        r.trim().trim('|').split("|").map { it.trim() }

    while (i < lines.size) {
        val line = lines[i]

        // Fenced code
        if (line.trimStart().startsWith("```")) {
            flushPara()
            val code = StringBuilder()
            i++
            while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                if (code.isNotEmpty()) code.append("\n")
                code.append(lines[i])
                i++
            }
            out += MdBlock.Code(code.toString())
            i++
            continue
        }

        // Blank line flushes the paragraph
        if (line.isBlank()) { flushPara(); i++; continue }

        // Heading
        val h = Regex("^(#{1,6})\\s+(.+?)\\s*#*\\s*$").find(line)
        if (h != null) {
            flushPara()
            val level = h.groupValues[1].length
            val txt = h.groupValues[2]
            out += when (level) { 1 -> MdBlock.H1(txt); 2 -> MdBlock.H2(txt); else -> MdBlock.H3(txt) }
            i++; continue
        }

        // Horizontal rule
        if (Regex("^(---+|\\*\\*\\*+|___+)\\s*$").matches(line)) {
            flushPara()
            out += MdBlock.Hr
            i++; continue
        }

        // Blockquote
        val bq = Regex("^>\\s?(.*)$").find(line)
        if (bq != null) {
            flushPara()
            out += MdBlock.Quote(bq.groupValues[1])
            i++; continue
        }

        // GFM table — header row + separator row + zero or more body rows
        if (i + 1 < lines.size && tableRow.matches(line) && tableSep.matches(lines[i + 1])) {
            flushPara()
            val header = splitRow(line)
            var end = i + 1
            while (end + 1 < lines.size && tableRow.matches(lines[end + 1])) end++
            val body = mutableListOf<List<String>>()
            for (k in (i + 2)..end) body += splitRow(lines[k])
            out += MdBlock.Table(header, body)
            i = end + 1
            continue
        }

        // Bullet — -, *, or +
        val bu = Regex("^\\s*[-*+]\\s+(.*)$").find(line)
        if (bu != null) {
            flushPara()
            out += MdBlock.Bullet(bu.groupValues[1])
            i++; continue
        }

        // Ordered list — 1. or 1)
        val ol = Regex("^\\s*(\\d+)[.)]\\s+(.*)$").find(line)
        if (ol != null) {
            flushPara()
            out += MdBlock.Ordered(ol.groupValues[1].toIntOrNull() ?: 1, ol.groupValues[2])
            i++; continue
        }

        if (paraBuf.isNotEmpty()) paraBuf.append(" ")
        paraBuf.append(line.trim())
        i++
    }
    flushPara()
    return out
}


/** Source actually parsed: a model's HTML fragment becomes Markdown when [html] is allowed. */
internal fun prepareMarkdown(src: String, html: Boolean): String =
    if (html && HtmlText.isHtml(src)) HtmlText.toMarkdown(src) else src

/** Inline tree of one block (pure; drawn by [renderInline]). */
internal sealed class MdInline {
    data class Text(val text: String) : MdInline()
    data class Bold(val children: List<MdInline>) : MdInline()
    data class Italic(val children: List<MdInline>) : MdInline()
    /** [kind]/[value] set when the whole span is one identifier (linked, like the web). */
    data class Code(val text: String, val kind: String? = null, val value: String? = null) : MdInline()
    data class Link(val children: List<MdInline>, val url: String) : MdInline()
    data class IdRef(val display: String, val kind: String, val value: String) : MdInline()
}

private fun codeEnd(src: String, i: Int): Int {
    if (src[i] != '`') return -1
    val end = src.indexOf('`', i + 1)
    return if (end > i && !src.substring(i + 1, end).contains('\n')) end + 1 else -1
}

/** [label](url) at [i] → (end exclusive, label, url), or null. */
private fun mdLinkAt(src: String, i: Int): Triple<Int, String, String>? {
    if (src[i] != '[') return null
    val close = src.indexOf(']', i + 1)
    if (close <= i || close + 1 >= src.length || src[close + 1] != '(') return null
    val paren = src.indexOf(')', close + 2)
    if (paren <= close + 1) return null
    return Triple(paren + 1, src.substring(i + 1, close), src.substring(close + 2, paren).trim())
}

private fun bareUrlEnd(src: String, i: Int): Int {
    if (src[i] != 'h' || !(src.startsWith("http://", i) || src.startsWith("https://", i))) return -1
    var end = i
    while (end < src.length && !src[end].isWhitespace() && src[end] != '<') end++
    // Trailing sentence punctuation isn't part of the URL.
    while (end > i && src[end - 1] in ".,;:!?)]") end--
    return if (end > i) end else -1
}

/** Identifiers of [src] that are not inside an inline code span, a [text](url) link or a bare URL. */
private fun idsOutsideCodeAndLinks(src: String, vocab: IdVocab): Map<Int, IdMatch> {
    val found = IdLinks.find(src, vocab)
    if (found.isEmpty()) return emptyMap()
    val excluded = mutableListOf<IntRange>()
    var i = 0
    while (i < src.length) {
        val end = codeEnd(src, i).takeIf { it > 0 } ?: mdLinkAt(src, i)?.first ?: bareUrlEnd(src, i).takeIf { it > 0 }
        if (end != null) { excluded += i until end; i = end } else i++
    }
    return found.filter { m -> excluded.none { r -> m.start <= r.last && m.end - 1 >= r.first } }.associateBy { it.start }
}

/** Inline Markdown → tree; [vocab] null = no identifier links. */
internal fun parseInline(src: String, vocab: IdVocab?): List<MdInline> {
    val out = mutableListOf<MdInline>()
    val buf = StringBuilder()
    fun flush() { if (buf.isNotEmpty()) { out += MdInline.Text(buf.toString()); buf.clear() } }
    val ids = if (vocab == null) emptyMap() else idsOutsideCodeAndLinks(src, vocab)
    var i = 0
    val n = src.length
    while (i < n) {
        val c = src[i]

        // Identifier first: a path may contain "_" or "*"-free text that emphasis would otherwise eat.
        val id = ids[i]
        if (id != null) {
            flush(); out += MdInline.IdRef(id.display, id.kind, id.value)
            i = id.end; continue
        }

        // Bold **...** or __...__
        if ((c == '*' || c == '_') && i + 1 < n && src[i + 1] == c) {
            val end = src.indexOf("$c$c", i + 2)
            if (end > i + 1 && !src.substring(i + 2, end).contains('\n')) {
                flush(); out += MdInline.Bold(parseInline(src.substring(i + 2, end), vocab))
                i = end + 2; continue
            }
        }
        // Italic *...* or _..._ — require non-alnum boundary, same line, no space right after opener
        if ((c == '*' || c == '_') && (i + 1 < n) && src[i + 1] != c && src[i + 1] != ' ') {
            val prev = if (i == 0) ' ' else src[i - 1]
            if (!prev.isLetterOrDigit()) {
                val end = src.indexOf(c, i + 1)
                if (end > i && !src.substring(i + 1, end).contains('\n')) {
                    val after = if (end + 1 < n) src[end + 1] else ' '
                    if (!after.isLetterOrDigit()) {
                        flush(); out += MdInline.Italic(parseInline(src.substring(i + 1, end), vocab))
                        i = end + 1; continue
                    }
                }
            }
        }

        // Inline code `...`
        val ce = codeEnd(src, i)
        if (ce > 0) {
            val code = src.substring(i + 1, ce - 1)
            val whole = vocab?.let { v -> IdLinks.find(code, v).singleOrNull()?.takeIf { it.start == 0 && it.end == code.length } }
            flush(); out += if (whole != null) MdInline.Code(code, whole.kind, whole.value) else MdInline.Code(code)
            i = ce; continue
        }

        // Link [text](url): only http(s), mailto, "/" and "#" targets (same rule as the web);
        // any other target leaves the label as plain text.
        val link = mdLinkAt(src, i)
        if (link != null) {
            val (end, label, url) = link
            flush()
            if (HtmlText.safeHref(url) != null) out += MdInline.Link(parseInline(label, null), url)
            else out += parseInline(label, null)
            i = end; continue
        }

        // Bare URL autolink — scheme required (http/https). host:port without a
        // scheme ("myhost:7777") is not linked, to avoid false positives.
        val ue = bareUrlEnd(src, i)
        if (ue > 0) {
            val url = src.substring(i, ue)
            flush(); out += MdInline.Link(listOf(MdInline.Text(url)), url)
            i = ue; continue
        }

        buf.append(c)
        i++
    }
    flush()
    // Adjacent texts (e.g. an unsafe link's label) are merged.
    return out.fold(mutableListOf()) { acc, x ->
        val last = acc.lastOrNull()
        if (x is MdInline.Text && last is MdInline.Text) acc[acc.lastIndex] = MdInline.Text(last.text + x.text) else acc += x
        acc
    }
}

private fun AnnotatedString.Builder.appendInline(nodes: List<MdInline>, base: Color) {
    for (n in nodes) when (n) {
        is MdInline.Text -> append(n.text)
        is MdInline.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = base)) { appendInline(n.children, base) }
        is MdInline.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic, color = base)) { appendInline(n.children, base) }
        is MdInline.Code -> if (n.kind != null && n.value != null) {
            pushStringAnnotation(ID_TAG, "${n.kind}\n${n.value}")
            withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = Palette.Accent, textDecoration = TextDecoration.Underline, background = Color.White.copy(alpha = 0.08f))) { append(n.text) }
            pop()
        } else withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = base, background = Color.White.copy(alpha = 0.08f))) { append(n.text) }
        is MdInline.Link -> {
            pushStringAnnotation(URL_TAG, n.url)
            withStyle(SpanStyle(color = Palette.Accent, textDecoration = TextDecoration.Underline)) { appendInline(n.children, Palette.Accent) }
            pop()
        }
        is MdInline.IdRef -> {
            // Web a.idref: underlined, highlighted in the accent tint (Compose has no dotted underline).
            pushStringAnnotation(ID_TAG, "${n.kind}\n${n.value}")
            withStyle(SpanStyle(color = Palette.Accent, textDecoration = TextDecoration.Underline, background = Palette.Accent.copy(alpha = 0.10f))) { append(n.display) }
            pop()
        }
    }
}

private fun renderInline(nodes: List<MdInline>, base: Color): AnnotatedString = buildAnnotatedString { appendInline(nodes, base) }

/**
 * Preview of a cited image / video through GET /api/media (same route and token
 * as the web). A missing or refused file shows nothing: the plain link stays.
 */
@Composable
private fun MediaPreview(path: String) {
    val env = LocalEnv.current
    val kind = MediaLinks.kindOf(path) ?: return
    val url = remember(path) { runCatching { MediaLinks.url(env.api.baseUrl(), path, env.api.token()) }.getOrNull() } ?: return
    var full by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val uri = LocalUriHandler.current
    if (failed) return
    if (kind == MediaKind.IMAGE) {
        AsyncImage(
            model = url,
            contentDescription = path.substringAfterLast('\\').substringAfterLast('/'),
            onError = { failed = true },
            modifier = Modifier.heightIn(max = 180.dp).clip(RoundedCornerShape(6.dp)).clickable { full = true },
        )
        if (full) Dialog(onDismissRequest = { full = false }) {
            AsyncImage(model = url, contentDescription = null, modifier = Modifier.fillMaxWidth().clickable { full = false })
        }
    } else {
        val available by produceState<Boolean?>(null, url) { value = withContext(Dispatchers.IO) { MediaLinks.available(url) } }
        if (available == true) Text("▶ Lire la vidéo", color = Palette.Accent, fontSize = 13.sp, modifier = Modifier.clickable { uri.openUri(url) })
    }
}
