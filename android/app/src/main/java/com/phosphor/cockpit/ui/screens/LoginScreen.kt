package com.phosphor.cockpit.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.phosphor.cockpit.auth.Endpoint
import com.phosphor.cockpit.state.AppViewModel
import com.phosphor.cockpit.ui.theme.Phosphor
import kotlinx.coroutines.delay

private val HOST_RE = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*:[0-9]{1,5}$")
private val TOKEN_RE = Regex("^[0-9a-fA-F]{32,128}$")

private val MonoFont = FontFamily.Monospace
private val Glow = Shadow(color = Phosphor.Glow, blurRadius = 14f)

// ---------------------------------------------------------------------
// ASCII banners — the attest-b carrier encodes "NEO IS ONE" as:
//   hex 4E 45 4F 20 49 53 20 4F 4E 45 → "NEO IS ONE"
// The ASCII-art reveal shown after `decode attest-b` is identical to
// what mobile-app.jsx renders in the design bundle.
// ---------------------------------------------------------------------
private val BANNER_PHOSPHOR = listOf(
    "  ██████ ██   ██ █████ ██████ ██████ ██  ██ █████ ██████",
    "  ██  ██ ██   ██ ██  ██ ██    ██  ██ ██  ██ ██  ██ ██  ██",
    "  ██████ █████ █ ██  ██ ██████ ██████ ██████ ██  ██ ██████",
    "  ██     ██  ██ ██  ██     ██ ██     ██  ██ ██  ██ ██  ██",
    "  ██     ██   █ █████  ██████ ██     ██  ██ █████  ██  ██",
)
private val BANNER_NEOISONE = listOf(
    "  ███    ██ ███████  ██████    ██ ███████    ██████  ███    ██ ███████",
    "  ████   ██ ██      ██    ██   ██ ██        ██    ██ ████   ██ ██",
    "  ██ ██  ██ █████   ██    ██   ██ ███████   ██    ██ ██ ██  ██ █████",
    "  ██  ██ ██ ██      ██    ██   ██      ██   ██    ██ ██  ██ ██ ██",
    "  ██   ████ ███████  ██████    ██ ███████    ██████  ██   ████ ███████",
)

@Composable
fun LoginScreen(vm: AppViewModel, onAuthed: () -> Unit) {
    val state by vm.state.collectAsState()

    // React to a successful connection — navigate out.
    LaunchedEffect(state.authedHost) {
        if (state.authedHost != null) onAuthed()
    }

    var host by remember {
        mutableStateOf(state.endpoints.firstOrNull()?.host ?: "")
    }
    var token by remember { mutableStateOf("") }

    // Command shell state (Easter egg).
    var shellInput by remember { mutableStateOf("") }
    val shellHistory = remember { mutableStateListOf<ShellEntry>() }

    // Progressive boot: banner → attestations → interactive UI.  Each
    // entry reveals after `delayMs` on top of the previous.  Once the
    // last boot line is on screen, the interactive section appears in
    // one shot (it's meant to be used, not read).
    val bootPlan = remember(state.endpoints.size) { bootPlan(state.endpoints.size) }
    var revealed by remember { mutableStateOf(0) }
    LaunchedEffect(bootPlan) {
        revealed = 0
        for ((i, line) in bootPlan.withIndex()) {
            delay(line.delayMs)
            revealed = i + 1
        }
    }
    val bootDone = revealed >= bootPlan.size

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Phosphor.Bg0)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        // -------- Progressive boot block --------
        bootPlan.take(revealed).forEach { it.Render() }

        // Interactive UI — hidden until the boot animation finishes.
        if (!bootDone) {
            // Show a blinking cursor on the last line while booting.
            BootCursor()
            return@Column
        }

        // -------- Connect prompt --------
        Row {
            TerminalText("$ ", Phosphor.AccentPrimaryBright, bold = true)
            TerminalText("phosphor connect <host:port>", Phosphor.Fg0)
        }

        Spacer(Modifier.height(6.dp))
        PromptLine(
            lead = "▸ wss://",
            value = host,
            placeholder = "orchestrator.fleet:7443",
            onChange = { host = it },
            enabled = !state.connecting,
            keyboard = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
        )
        val hostValid = HOST_RE.matches(host.trim())
        when {
            host.isEmpty() -> {}
            hostValid     -> InlineOk("valid · TLS handshake will follow")
            else          -> InlineErr("format: name:port or ip:port (1–65535)")
        }

        Spacer(Modifier.height(10.dp))
        // Token input — required by the orchestrator, not present in the
        // original design but an orthogonal concern of our backend.
        TerminalText("  orchestrator token (64-hex)", Phosphor.Fg2, size = 11)
        PromptLine(
            lead = "▸ tok = ",
            value = token,
            placeholder = "paste from the desktop .token",
            onChange = { token = it },
            password = true,
            enabled = !state.connecting,
            keyboard = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
        )
        if (token.isNotEmpty() && !TOKEN_RE.matches(token.trim())) {
            InlineErr("token must be 32–128 hex chars")
        }

        Spacer(Modifier.height(10.dp))
        // Animated connect progression.
        when (state.connectPhase) {
            "resolve" -> Progress("resolve", "a ? · DNS lookup…")
            "tcp"     -> Progress("tcp",     "rtt 12ms · tls handshake…")
            "tls"     -> Progress("tls",     "TLS 1.3 · ALPN=wss · verifying…")
            "ok"      -> OkRow("session",    "connected · routing to fleet")
            "err"     -> ErrRow("fail",      state.connectError ?: "unknown error")
        }

        Spacer(Modifier.height(8.dp))
        val canConnect = hostValid && TOKEN_RE.matches(token.trim()) && !state.connecting
        Button(
            enabled = canConnect,
            onClick = { vm.connect(host.trim(), token.trim()) },
            modifier = Modifier.fillMaxWidth().height(44.dp),
            shape = RoundedCornerShape(0.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = Phosphor.AccentPrimary,
                contentColor = Phosphor.Bg0,
                disabledContainerColor = Phosphor.Bg2,
                disabledContentColor = Phosphor.Fg2,
            ),
        ) {
            Text(
                if (state.connecting) "CONNECTING…" else "CONNECT",
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 3.sp,
                fontSize = 12.sp,
            )
        }

        Rule()

        // -------- Saved endpoints list --------
        Row(verticalAlignment = Alignment.CenterVertically) {
            TerminalText("  SAVED ENDPOINTS · ", Phosphor.Fg1, size = 11)
            TerminalText("${state.endpoints.size}", Phosphor.AccentPrimary, size = 11, bold = true)
            TerminalText(" · tap to reconnect", Phosphor.Fg2, size = 11)
        }

        if (state.endpoints.isEmpty()) {
            Spacer(Modifier.height(6.dp))
            TerminalText("  (no saved endpoints yet — connect once to remember.)",
                Phosphor.Fg3, size = 11)
        } else {
            state.endpoints.forEachIndexed { i, ep ->
                EndpointRow(
                    idx = i + 1,
                    ep = ep,
                    isCurrent = ep.host == state.authedHost,
                    onTap = {
                        host = ep.host
                        token = ep.token
                        vm.reconnectTo(ep.host)
                    },
                    onRemove = { vm.removeEndpoint(ep.host) },
                )
            }
        }

        Rule()

        // -------- Shell (Easter egg playground) --------
        shellHistory.forEach { entry ->
            Row {
                TerminalText("$ ", Phosphor.AccentPrimaryBright, bold = true)
                TerminalText(entry.cmd, Phosphor.Fg0)
            }
            entry.out.forEach { line ->
                TerminalText(
                    "  " + line.text,
                    color = when (line.kind) {
                        ShellKind.DIM  -> Phosphor.Fg2
                        ShellKind.OK   -> Phosphor.AccentPrimary
                        ShellKind.ERR  -> Phosphor.AlertError
                        ShellKind.PLAIN -> Phosphor.Fg0
                    },
                )
            }
            if (entry.renderNeo) {
                Spacer(Modifier.height(4.dp))
                BANNER_NEOISONE.forEach { line ->
                    TerminalRow(line, Phosphor.AccentPrimaryBright, isBanner = true)
                }
                Spacer(Modifier.height(4.dp))
            }
        }

        Spacer(Modifier.height(6.dp))
        PromptLine(
            lead = "$ ",
            value = shellInput,
            placeholder = "?help · status · decode attest-b",
            onChange = { shellInput = it },
            onDone = {
                val out = runShell(shellInput, state.endpoints.size)
                shellHistory.add(out)
                shellInput = ""
            },
            keyboard = KeyboardOptions(
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Done,
                capitalization = KeyboardCapitalization.None,
            ),
            monoLead = true,
        )

        Spacer(Modifier.height(40.dp))
    }
}

// -------------------------------------------------------------------------
// Helpers — terminal rows, prompt lines, rules
// -------------------------------------------------------------------------

@Composable
private fun TerminalText(
    text: String,
    color: Color,
    size: Int = 12,
    bold: Boolean = false,
) {
    Text(
        text = text,
        color = color,
        fontFamily = MonoFont,
        fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
        fontSize = size.sp,
        style = TextStyle(
            shadow = if (color == Phosphor.AccentPrimary ||
                         color == Phosphor.AccentPrimaryBright) Glow else null,
        ),
    )
}

@Composable
private fun TerminalRow(text: String, color: Color, isBanner: Boolean = false) {
    Text(
        text = text,
        color = color,
        fontFamily = MonoFont,
        fontWeight = if (isBanner) FontWeight.Bold else FontWeight.Normal,
        fontSize = if (isBanner) 10.sp else 12.sp,
        style = TextStyle(shadow = Glow),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun Dim(text: String) = TerminalText(text, Phosphor.Fg2)

@Composable
private fun Rule() {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .height(1.dp)
            .background(Phosphor.Rule),
    )
}

@Composable
private fun OkRow(tag: String, rest: String) {
    Row {
        TerminalText("[ OK ] ", Phosphor.AccentPrimary, bold = true)
        TerminalText(tag.padEnd(10), Phosphor.AccentPrimary)
        TerminalText(rest, Phosphor.Fg2)
    }
}

@Composable
private fun ErrRow(tag: String, rest: String) {
    Row {
        TerminalText("[FAIL] ", Phosphor.AlertError, bold = true)
        TerminalText(tag.padEnd(10), Phosphor.AlertError)
        TerminalText(rest, Phosphor.Fg1)
    }
}

@Composable
private fun Progress(tag: String, rest: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        TerminalText("  ▸ ", Phosphor.AccentPrimary, bold = true)
        TerminalText(tag.padEnd(8), Phosphor.AccentPrimary)
        TerminalText(rest, Phosphor.Fg2)
    }
}

@Composable
private fun InlineOk(text: String) = Row {
    TerminalText("  ✓ $text", Phosphor.AccentPrimary, size = 11)
}

@Composable
private fun InlineErr(text: String) = Row {
    TerminalText("  ✗ $text", Phosphor.AlertError, size = 11)
}

@Composable
private fun PromptLine(
    lead: String,
    value: String,
    placeholder: String,
    onChange: (String) -> Unit,
    enabled: Boolean = true,
    password: Boolean = false,
    onDone: () -> Unit = {},
    keyboard: KeyboardOptions = KeyboardOptions.Default,
    monoLead: Boolean = false,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, Phosphor.Rule)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            lead,
            color = Phosphor.AccentPrimary,
            fontFamily = MonoFont,
            fontWeight = if (monoLead) FontWeight.Bold else FontWeight.Normal,
            fontSize = 13.sp,
        )
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) {
                Text(placeholder, color = Phosphor.Fg3, fontFamily = MonoFont, fontSize = 13.sp)
            }
            BasicTextField(
                value = value,
                onValueChange = onChange,
                enabled = enabled,
                singleLine = true,
                visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                textStyle = TextStyle(
                    color = Phosphor.Fg0,
                    fontFamily = MonoFont,
                    fontSize = 13.sp,
                ),
                cursorBrush = SolidColor(Phosphor.AccentPrimary),
                keyboardOptions = keyboard,
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(
                    onDone = { onDone() },
                    onGo = { onDone() },
                ),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun EndpointRow(
    idx: Int,
    ep: Endpoint,
    isCurrent: Boolean,
    onTap: () -> Unit,
    onRemove: () -> Unit,
) {
    val accent = if (ep.lastStatus == "online") Phosphor.AccentPrimary else Phosphor.AlertError
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 6.dp)
            .clickable(onClick = onTap),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TerminalText("[$idx]".padEnd(5), Phosphor.Fg2, size = 11)
            val host = ep.host.substringBefore(':')
            val port = ep.host.substringAfter(':', "")
            TerminalText(host, Phosphor.Fg0, size = 13)
            if (port.isNotEmpty()) TerminalText(":$port", Phosphor.AccentSecondary, size = 13)
            Spacer(Modifier.weight(1f))
            TerminalText(
                if (ep.lastStatus == "online") "● UP" else "● DOWN",
                color = accent, size = 11, bold = true,
            )
            IconRemove(onRemove)
        }
        TerminalText(
            "    ↳ ${ep.label.ifEmpty { "(no label)" }} · last ${relTime(ep.lastUsedAt)}",
            Phosphor.Fg2, size = 11,
        )
    }
}

@Composable
private fun IconRemove(onClick: () -> Unit) {
    Text(
        "×",
        color = Phosphor.Fg2,
        fontFamily = MonoFont,
        fontSize = 16.sp,
        modifier = Modifier
            .padding(horizontal = 8.dp)
            .clickable(onClick = onClick),
    )
}

private fun relTime(ms: Long): String {
    if (ms == 0L) return "never"
    val d = System.currentTimeMillis() - ms
    val s = d / 1000
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60}m"
        s < 3600 * 48 -> "${s / 3600}h"
        else -> "${s / 86400}d"
    }
}

// -------------------------------------------------------------------------
// Boot sequence — each line reveals after `delayMs`.
// The effect is a fast terminal boot / TPM attestation roll rather than
// a dramatic character-by-character typewriter.  Total ≈ 1.2–1.5 s.
// -------------------------------------------------------------------------

private sealed class BootLine {
    abstract val delayMs: Long
    @Composable abstract fun Render()

    data class Banner(val text: String, override val delayMs: Long) : BootLine() {
        @Composable override fun Render() =
            TerminalRow(text, Phosphor.AccentPrimaryBright, isBanner = true)
    }
    data class Dim(val text: String, override val delayMs: Long) : BootLine() {
        @Composable override fun Render() = TerminalText(text, Phosphor.Fg2)
    }
    data class Ok(val tag: String, val rest: String, override val delayMs: Long) : BootLine() {
        @Composable override fun Render() = OkRow(tag, rest)
    }
    data class HelpLine(val prefix: String, val hint: String, override val delayMs: Long) : BootLine() {
        @Composable override fun Render() = Row(Modifier.padding(top = 2.dp)) {
            TerminalText(prefix, Phosphor.Fg2)
            TerminalText(hint, Phosphor.AccentPrimary)
        }
    }
    data class Divider(override val delayMs: Long) : BootLine() {
        @Composable override fun Render() = Rule()
    }
}

private fun bootPlan(endpointCount: Int): List<BootLine> = buildList {
    // Banner — five lines flash in rapidly, like a retro TPM POST.
    BANNER_PHOSPHOR.forEach { add(BootLine.Banner(it, delayMs = 28)) }
    add(BootLine.Dim("  phosphor/03 · orchestrator shell · build 2026.04.19+a17c3", delayMs = 90))
    add(BootLine.Dim("  © nitro systems · not for flight", delayMs = 40))
    add(BootLine.Divider(delayMs = 70))
    // Attestations — one every ~110ms, evokes the secure-boot scroll.
    add(BootLine.Ok("tpm",       "pcr#0 · 0x7F3A 9C2E BB01 4AF2 3D88", delayMs = 120))
    add(BootLine.Ok("attest-a",  "0xA91B 2D44 8C71 60E3 FF02 11BD",    delayMs = 110))
    add(BootLine.Ok("attest-b",  "0x4E454F20 4953204F 4E45 3C9A 81DF", delayMs = 110))
    add(BootLine.Ok("attest-c",  "0xD5CC 7712 9A04 E6B1 83FA 5742",    delayMs = 110))
    add(BootLine.Ok("secure-el", "nitro-v3 · sealed · nonce 0x7E12",   delayMs = 110))
    add(BootLine.Ok("keyring",   "$endpointCount endpoints · keys loaded",                delayMs = 110))
    add(BootLine.HelpLine("  awaiting operator directive… ", "type ?help for shell commands", delayMs = 220))
    add(BootLine.Divider(delayMs = 120))
}

@Composable
private fun BootCursor() {
    var on by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        while (true) { delay(420); on = !on }
    }
    Row(Modifier.padding(top = 4.dp)) {
        TerminalText(
            text = if (on) "▋" else " ",
            color = Phosphor.AccentPrimaryBright,
            bold = true,
        )
    }
}

// -------------------------------------------------------------------------
// Shell — the Easter egg
// -------------------------------------------------------------------------

private enum class ShellKind { PLAIN, DIM, OK, ERR }
private data class ShellLine(val text: String, val kind: ShellKind = ShellKind.DIM)
private data class ShellEntry(
    val cmd: String,
    val out: List<ShellLine>,
    val renderNeo: Boolean = false,
)

private fun runShell(raw: String, endpointCount: Int): ShellEntry {
    val cmd = raw.trim()
    val low = cmd.lowercase()
    return when {
        low.isEmpty() -> ShellEntry("", listOf(ShellLine("(nothing)", ShellKind.DIM)))
        low in setOf("?help", "help", "?") -> ShellEntry(cmd, listOf(
            ShellLine("available commands:"),
            ShellLine("  ?help               this message"),
            ShellLine("  status              fleet snapshot"),
            ShellLine("  decode <attest-id>  ascii-render attestation bytes"),
            ShellLine("  whoami              operator identity"),
            ShellLine("  clear               clear buffer"),
        ))
        low == "status" -> ShellEntry(cmd, listOf(
            ShellLine("$endpointCount saved endpoint(s) · heartbeat n/a until connected"),
        ))
        low == "whoami" -> ShellEntry(cmd, listOf(
            ShellLine("operator: k.ishikawa · clearance lvl-3 · biometric required"),
        ))
        low == "clear" -> ShellEntry(cmd, listOf(ShellLine("(buffer cleared — restart app to reset)", ShellKind.DIM)))
        low.startsWith("decode") -> {
            val arg = low.substringAfter("decode").trim().removePrefix("attest-").removePrefix("attest_")
            when (arg) {
                "b" -> ShellEntry(cmd, listOf(
                    ShellLine("reading bytes · 0x4E 45 4F 20 49 53 20 4F 4E 45", ShellKind.OK),
                    ShellLine("ascii-render ↓", ShellKind.OK),
                ), renderNeo = true)
                "a", "c" -> ShellEntry(cmd, listOf(
                    ShellLine("decode: bytes are opaque hash (non-printable). try attest-b.", ShellKind.DIM),
                ))
                else -> ShellEntry(cmd, listOf(
                    ShellLine("usage: decode <attest-a|attest-b|attest-c>", ShellKind.DIM),
                ))
            }
        }
        else -> ShellEntry(cmd, listOf(ShellLine("shell: unknown command '$cmd' · try ?help", ShellKind.ERR)))
    }
}
