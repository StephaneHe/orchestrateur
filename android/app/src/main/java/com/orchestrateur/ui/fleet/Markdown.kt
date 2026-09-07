package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.ui.theme.Palette

@Composable
fun Markdown(src: String, baseColor: Color = Palette.Fg0) {
    val blocks = parseBlocks(src)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (b in blocks) when (b) {
            is MdBlock.H1 -> Text(renderInline(b.text, Palette.Accent), color = Palette.Accent, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            is MdBlock.H2 -> Text(renderInline(b.text, Palette.Accent), color = Palette.Accent, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            is MdBlock.H3 -> Text(renderInline(b.text, baseColor),     color = baseColor,       fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            is MdBlock.Para -> Text(renderInline(b.text, baseColor), color = baseColor, fontSize = 13.sp, lineHeight = 19.sp)
            is MdBlock.Bullet -> Row(verticalAlignment = Alignment.Top) {
                Text("• ", color = baseColor, fontSize = 13.sp)
                Text(renderInline(b.text, baseColor), color = baseColor, fontSize = 13.sp, lineHeight = 19.sp, modifier = Modifier.weight(1f))
            }
            is MdBlock.Ordered -> Row(verticalAlignment = Alignment.Top) {
                Text("${b.n}. ", color = baseColor, fontSize = 13.sp)
                Text(renderInline(b.text, baseColor), color = baseColor, fontSize = 13.sp, lineHeight = 19.sp, modifier = Modifier.weight(1f))
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
                Text(
                    renderInline(b.text, baseColor),
                    color = baseColor,
                    fontSize = 13.sp,
                    fontStyle = FontStyle.Italic,
                    lineHeight = 19.sp,
                    modifier = Modifier.weight(1f),
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
            is MdBlock.Table -> MdTable(b, baseColor)
        }
    }
}

@Composable
private fun MdTable(t: MdBlock.Table, base: Color) {
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
                    Text(
                        renderInline(h, Palette.Accent),
                        color = Palette.Accent,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        lineHeight = 17.sp,
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
                        Text(renderInline(cell, base), color = base, fontSize = 12.sp, lineHeight = 17.sp)
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

private sealed class MdBlock {
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

private fun parseBlocks(src: String): List<MdBlock> {
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

private fun renderInline(src: String, base: Color): AnnotatedString = buildAnnotatedString {
    var i = 0
    val n = src.length
    while (i < n) {
        val c = src[i]

        // Bold **...** or __...__
        if (c == '*' && i + 1 < n && src[i + 1] == '*') {
            val end = src.indexOf("**", i + 2)
            if (end > i + 1 && !src.substring(i + 2, end).contains('\n')) {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = base)) {
                    append(renderInline(src.substring(i + 2, end), base))
                }
                i = end + 2; continue
            }
        }
        if (c == '_' && i + 1 < n && src[i + 1] == '_') {
            val end = src.indexOf("__", i + 2)
            if (end > i + 1 && !src.substring(i + 2, end).contains('\n')) {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = base)) {
                    append(renderInline(src.substring(i + 2, end), base))
                }
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
                        withStyle(SpanStyle(fontStyle = FontStyle.Italic, color = base)) {
                            append(renderInline(src.substring(i + 1, end), base))
                        }
                        i = end + 1; continue
                    }
                }
            }
        }

        // Inline code `...`
        if (c == '`') {
            val end = src.indexOf('`', i + 1)
            if (end > i && !src.substring(i + 1, end).contains('\n')) {
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = base, background = Color.White.copy(alpha = 0.08f))) {
                    append(src.substring(i + 1, end))
                }
                i = end + 1; continue
            }
        }

        // Link [text](url) — render the text styled as a link (not clickable yet)
        if (c == '[') {
            val close = src.indexOf(']', i + 1)
            if (close > i && close + 1 < n && src[close + 1] == '(') {
                val paren = src.indexOf(')', close + 2)
                if (paren > close + 1) {
                    val label = src.substring(i + 1, close)
                    withStyle(SpanStyle(color = Palette.Accent, textDecoration = TextDecoration.Underline)) {
                        append(renderInline(label, Palette.Accent))
                    }
                    i = paren + 1; continue
                }
            }
        }

        append(c)
        i++
    }
}
