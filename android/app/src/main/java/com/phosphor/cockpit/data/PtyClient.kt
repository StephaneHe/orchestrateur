package com.phosphor.cockpit.data

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * Connects to /ws/pty and turns the raw pty byte stream into readable text.
 *
 * Claude Code interactive mode is an ink-based TUI: it draws its input
 * box by moving the cursor and emitting characters at specific columns
 * rather than writing flat text.  A naive ANSI strip collapses all chars
 * into a single run with no spaces (`dansleprojet…`).  To recover
 * readable output we track the cursor column through the escape stream
 * and insert spaces whenever the cursor skips forward — good enough to
 * read without a full xterm emulator.
 */
class PtyClient(private val api: OrchestratorApi) {

    @Volatile private var socket: WebSocket? = null

    // ANSI CSI pattern: ESC `[` (params) (intermediates) (final byte)
    private val csiRe = Regex("\u001B\\[([0-?]*)([ -/]*)([@-~])")
    // Non-ESC control chars. DELIBERATELY excludes \u001B so that csiRe can
    // still see its ESC-prefixed sequences further down the pipeline.
    private val controlRe = Regex("[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]")
    // OSC (set title, etc.) — `\x1b]...\x07` or `\x1b]...\x1b\\`
    private val oscRe = Regex("\u001B\\].*?(?:\u0007|\u001B\\\\)")
    // Lone-char escapes: `\x1b=`, `\x1b>`, `\x1b7`, `\x1b8`, …
    private val shortEscRe = Regex("\u001B[=>()78c]")
    // Private-mode sets/resets: `\x1b[?<n>h` or `\x1b[?<n>l` — they enter
    // and leave cursor/alt-screen modes. csiRe catches them, but we drop
    // any stragglers here just in case.
    private val privateModeRe = Regex("\u001B\\[\\?[0-9;]*[hl]")

    // Very defensive caps — a corrupt ANSI sequence shouldn't explode us
    // into gigabytes of spaces.
    private val MAX_COL_JUMP = 160

    private class Cursor { var col = 0 }

    /**
     * Cursor-aware ANSI cleaner. The goal is *readability*, not pixel-perfect
     * terminal emulation.
     *   · horizontal cursor jumps → pad with spaces (explains "dans le projet" instead of "dansleprojet")
     *   · vertical cursor jumps → treat as a CR (start of line) so the reducer overwrites
     *   · other ANSI (colors, clears, hide-cursor) → strip silently
     */
    private fun sanitizeWithCursor(raw: String, cursor: Cursor): String {
        // Order matters: strip ESC-prefixed sequences BEFORE stripping the
        // remaining control chars, because controlRe intentionally keeps
        // the ESC byte alive so csiRe can still match its sequences.
        val work = raw
            .replace("\r\n", "\n")
            .let { oscRe.replace(it, "") }
            .let { privateModeRe.replace(it, "") }
            .let { shortEscRe.replace(it, "") }
            .replace(controlRe, "")

        val out = StringBuilder(work.length)
        var i = 0
        while (i < work.length) {
            val m = csiRe.find(work, i)
            if (m == null) {
                for (c in work.substring(i)) emitChar(c, out, cursor)
                break
            }
            for (c in work.substring(i, m.range.first)) emitChar(c, out, cursor)
            interpretCsi(m.groupValues[1], m.groupValues[3], out, cursor)
            i = m.range.last + 1
        }
        // Final safety: any ESC that leaked through (malformed sequences,
        // truncated at a frame boundary, etc.) gets dropped here.
        return out.toString().replace("\u001B", "")
    }

    private fun emitChar(c: Char, out: StringBuilder, cursor: Cursor) {
        when (c) {
            '\n' -> { out.append('\n'); cursor.col = 0 }
            '\r' -> { out.append('\r'); cursor.col = 0 }
            '\t' -> {
                // A single space is a safer tab interpretation than trying to
                // pad to an 8-col stop — a TUI that needs precise alignment
                // uses absolute positioning, not tabs.
                out.append(' ')
                cursor.col++
            }
            else -> { out.append(c); cursor.col++ }
        }
    }

    private fun interpretCsi(params: String, final: String, out: StringBuilder, cursor: Cursor) {
        when (final) {
            "H", "f" -> {
                val parts = params.split(";")
                val targetCol = ((parts.getOrNull(1) ?: parts.getOrNull(0))?.toIntOrNull() ?: 1) - 1
                jumpTo(targetCol, out, cursor)
            }
            "G" -> {
                val targetCol = (params.toIntOrNull() ?: 1) - 1
                jumpTo(targetCol, out, cursor)
            }
            "C" -> {
                // Relative move-forward. In Claude Code's input box this can
                // happen between each typed char (the TUI re-walks over
                // already-drawn content) — padding with spaces would produce
                // "c o n t i n u e". Just advance the cursor silently; text
                // that follows will overwrite what's beyond.
                val n = (params.toIntOrNull() ?: 1).coerceAtMost(MAX_COL_JUMP)
                cursor.col += n
            }
            "D" -> {
                val n = (params.toIntOrNull() ?: 1).coerceAtMost(MAX_COL_JUMP)
                cursor.col = (cursor.col - n).coerceAtLeast(0)
            }
            else -> { /* colors, clears, modes — drop */ }
        }
    }

    private fun jumpTo(targetCol: Int, out: StringBuilder, cursor: Cursor) {
        when {
            targetCol == cursor.col -> return
            targetCol > cursor.col -> {
                // Only pad when the jump is large and we're at column 0 —
                // that's the case the tracker was meant to cover: status bars
                // that claim a column at the far end of an otherwise blank
                // line.  Small forward jumps are almost always TUI redraws
                // walking over existing content; padding them produces the
                // "c o n t i n u e" letter-spacing artefact.
                val gap = targetCol - cursor.col
                if (cursor.col == 0 && gap >= 4) {
                    repeat(gap.coerceAtMost(MAX_COL_JUMP)) { out.append(' ') }
                }
                cursor.col = targetCol
            }
            else -> {
                // Moving back — treat as carriage return (redraw).
                out.append('\r')
                cursor.col = targetCol.coerceAtLeast(0)
            }
        }
    }

    fun stream(): Flow<String> = callbackFlow {
        val url = api.baseUrl
            .replaceFirst("http://", "ws://")
            .replaceFirst("https://", "wss://")
            .trimEnd('/') + "/ws/pty?token=" + api.token

        val req = Request.Builder().url(url).build()
        val cursor = Cursor()

        val listener = object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, r: Response) { trySend("\u0000__open__") }
            override fun onMessage(ws: WebSocket, text: String) {
                val clean = sanitizeWithCursor(text, cursor)
                if (clean.isNotEmpty()) trySend(clean)
            }
            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                val clean = sanitizeWithCursor(bytes.utf8(), cursor)
                if (clean.isNotEmpty()) trySend(clean)
            }
            override fun onFailure(ws: WebSocket, t: Throwable, r: Response?) { close(t) }
            override fun onClosing(ws: WebSocket, code: Int, reason: String) { close() }
        }
        socket = api.client.newWebSocket(req, listener)
        awaitClose {
            try { socket?.close(1000, "leaving") } catch (_: Exception) {}
            socket = null
        }
    }

    fun send(userInput: String) {
        val s = socket ?: return
        s.send("""{"type":"input","data":${jsonString(userInput)}}""")
    }

    private fun jsonString(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) when (c) {
            '\\' -> b.append("\\\\")
            '"'  -> b.append("\\\"")
            '\n' -> b.append("\\n")
            '\r' -> b.append("\\r")
            '\t' -> b.append("\\t")
            else -> if (c.code < 0x20) b.append("\\u%04x".format(c.code)) else b.append(c)
        }
        b.append('"')
        return b.toString()
    }
}
