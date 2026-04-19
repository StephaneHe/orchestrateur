package com.phosphor.cockpit.state

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.phosphor.cockpit.auth.Endpoint
import com.phosphor.cockpit.auth.TokenStore
import com.phosphor.cockpit.data.AddProjectRequest
import com.phosphor.cockpit.data.Candidate
import com.phosphor.cockpit.data.ClaudeSession
import com.phosphor.cockpit.data.OrchestratorApi
import com.phosphor.cockpit.data.PanelReducer
import com.phosphor.cockpit.data.PanelSnapshot
import com.phosphor.cockpit.data.Project
import com.phosphor.cockpit.data.PtyClient
import com.phosphor.cockpit.data.SseClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class AppViewModel(app: Application) : AndroidViewModel(app) {

    val tokenStore = TokenStore(app)

    private val _state = MutableStateFlow(AppState(endpoints = tokenStore.endpoints()))
    val state: StateFlow<AppState> = _state.asStateFlow()

    private var api: OrchestratorApi? = null
    private var sse: SseClient? = null
    private var pty: PtyClient? = null
    private val sseJobs = mutableMapOf<String, Job>()
    private var ptyJob: Job? = null

    // ---------- connection lifecycle -----------------------------------

    /**
     * Probe /healthz on the given host with the given token. On success,
     * register the endpoint in the encrypted store, bring the live
     * API up, and load the fleet. Updates state.connectPhase along the
     * way so the login terminal can animate (resolve → tcp → tls → ok).
     */
    fun connect(rawHost: String, token: String, label: String = "") {
        val host = rawHost.trim().trimEnd('/')
        val url = if (host.startsWith("http://") || host.startsWith("https://")) host else "http://$host"

        _state.update { it.copy(connecting = true, connectError = null, connectPhase = "resolve") }

        viewModelScope.launch(Dispatchers.IO) {
            try {
                val probe = OrchestratorApi(url, token.trim())
                _state.update { it.copy(connectPhase = "tcp") }
                val health = probe.health()
                _state.update { it.copy(connectPhase = "tls") }
                // Good — adopt it
                api = probe
                sse = SseClient(probe)
                pty = PtyClient(probe)
                val endpoints = tokenStore.upsert(
                    Endpoint(host = host, token = token.trim(), label = label),
                    markCurrent = true,
                )
                _state.update { it.copy(
                    connecting = false, connectPhase = "ok", connectError = null,
                    endpoints = endpoints, tailscaleIp = health.tailscale,
                    authedHost = host,
                ) }
                // Load fleet after reporting success so the viewer can animate.
                refreshFleet()
            } catch (err: Throwable) {
                _state.update { it.copy(
                    connecting = false, connectPhase = "err",
                    connectError = err.message ?: "unknown error",
                ) }
                tokenStore.markStatus(host, "offline")
                _state.update { it.copy(endpoints = tokenStore.endpoints()) }
            }
        }
    }

    /** Reconnect to a saved endpoint. */
    fun reconnectTo(host: String) {
        val ep = tokenStore.endpoints().firstOrNull { it.host == host } ?: return
        connect(ep.host, ep.token, ep.label)
    }

    fun removeEndpoint(host: String) {
        tokenStore.remove(host)
        _state.update { it.copy(endpoints = tokenStore.endpoints()) }
    }

    fun logout() {
        sseJobs.values.forEach { it.cancel() }
        sseJobs.clear()
        ptyJob?.cancel(); ptyJob = null
        api = null
        sse = null
        pty = null
        _state.update { AppState(endpoints = tokenStore.endpoints()) }
    }

    fun clearAllCredentials() {
        sseJobs.values.forEach { it.cancel() }
        sseJobs.clear()
        ptyJob?.cancel(); ptyJob = null
        tokenStore.clear()
        api = null
        sse = null
        pty = null
        _state.update { AppState() }
    }

    // ---------- Terminal (central pty bridge) --------------------------

    fun enterTerminal() {
        if (ptyJob != null) return
        val p = pty ?: return
        _state.update { it.copy(terminalLines = it.terminalLines + "[connecting to central…]") }
        ptyJob = viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                p.stream().collect { chunk ->
                    if (chunk == "\u0000__open__") {
                        _state.update {
                            it.copy(terminalLines = it.terminalLines + "[attached]")
                        }
                        return@collect
                    }
                    _state.update { st ->
                        reduceTerminalChunk(st, chunk)
                    }
                }
            }.onFailure { err ->
                _state.update { it.copy(
                    terminalLines = it.terminalLines + "[link lost: ${err.message}]",
                ) }
            }
        }
    }

    fun leaveTerminal() {
        ptyJob?.cancel()
        ptyJob = null
    }

    fun sendTerminalInput(line: String, appendNewline: Boolean = true) {
        // Claude Code interactive stays in "multi-line draft" mode as long
        // as the input box accepts more text, so a bare Enter is interpreted
        // as "newline in draft". A second Enter on an empty line is what
        // actually submits. We send CR+CR: the first closes the current
        // line, the second fires submit. No local echo — the pty's own
        // echo drives the display, keeping mobile and desktop in sync.
        val toSend = if (appendNewline) line + "\r\r" else line
        pty?.send(toSend)
    }

    /**
     * Apply a fresh pty chunk to the terminal buffer with:
     *  - `\r` → overwrite the current line (tail)
     *  - `\n` → commit the current line (and dedupe vs the previous)
     *  - trailing unfinished fragment stays in `terminalTail` until the
     *    next chunk closes it.
     * Also filters two kinds of TUI noise:
     *  - consecutive identical lines (box-frame redraws)
     *  - decoration-only lines (box-drawing, arrows, dashes, underscores)
     *  - consecutive empties collapsed to at most one
     */
    private fun reduceTerminalChunk(st: AppState, chunk: String): AppState {
        var cur = StringBuilder(st.terminalTail)
        val out = st.terminalLines.toMutableList()

        fun commit(rawLine: String) {
            val line = rawLine.trimEnd()
            val last = out.lastOrNull()
            when {
                line == last -> return                    // dedupe redraws
                isDecorativeLine(line) -> return          // box frames, dashes
                line.isEmpty() && last?.isEmpty() == true -> return
                else -> out.add(line)
            }
        }

        for (c in chunk) when (c) {
            '\r' -> cur.setLength(0)
            '\n' -> {
                commit(cur.toString())
                cur.setLength(0)
            }
            else -> cur.append(c)
        }
        val trimmed = if (out.size > MAX_TERM_LINES)
            out.subList(out.size - MAX_TERM_LINES, out.size).toMutableList()
        else out
        return st.copy(terminalLines = trimmed, terminalTail = cur.toString())
    }

    /**
     * True when a line is overwhelmingly decoration rather than content —
     * box-drawing, dashes, arrows, underscores, whitespace, ellipses.
     * Fuzzy match at 75% so a single stray char in a TUI-chrome line
     * doesn't keep it.  Real prose has far less than 10% decorative.
     */
    private fun isDecorativeLine(line: String): Boolean {
        if (line.length < 3) return false
        var decor = 0
        for (c in line) {
            val d = c == ' ' || c == '\t' || c == '_' || c == '-' ||
                    c == '=' || c == '.' || c == '·' ||
                    c == '›' || c == '»' || c == '▶' || c == '▸' ||
                    c == '…' ||
                    (c.code in 0x2010..0x2027) ||    // dashes, bars, quotes
                    (c.code in 0x2030..0x205F) ||    // punctuation, thin spaces
                    (c.code in 0x2190..0x21FF) ||    // arrows
                    (c.code in 0x2500..0x257F) ||    // box drawing
                    (c.code in 0x2580..0x259F) ||    // block elements ▀▄▌▐
                    (c.code in 0x25A0..0x25FF) ||    // geometric shapes
                    (c.code in 0x2800..0x28FF)       // braille
            if (d) decor++
        }
        // 75% threshold: TUI chrome is >90% decor, real text is <10% decor.
        return decor * 4 >= line.length * 3
    }

    fun clearTerminal() {
        _state.update { it.copy(terminalLines = emptyList(), terminalTail = "") }
    }

    companion object { private const val MAX_TERM_LINES = 400 }

    // ---------- fleet + sessions ---------------------------------------

    fun refreshFleet() {
        val a = api ?: return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                val cfg = a.config()
                val health = a.health()
                val panelsNow = _state.value.panels
                val updated = cfg.projects.associate { p ->
                    val prev = panelsNow[p.name]
                    p.name to (prev?.copy(project = p) ?: PanelSnapshot(p))
                }
                updated.keys.forEach { startStream(it) }
                (panelsNow.keys - updated.keys).forEach { stopStream(it) }
                _state.update { it.copy(
                    loading = false, error = null,
                    panels = updated, tailscaleIp = health.tailscale,
                ) }
            }.onFailure { err ->
                _state.update { it.copy(loading = false, error = err.message ?: "unknown") }
            }
        }
    }

    private fun startStream(name: String) {
        if (sseJobs[name] != null) return
        val sseClient = sse ?: return
        sseJobs[name] = viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                sseClient.stream(name).collect { ev ->
                    _state.update { st ->
                        val cur = st.panels[name] ?: return@update st
                        val updated = PanelReducer.reduce(cur, ev)
                        st.copy(panels = st.panels + (name to updated))
                    }
                }
            }
        }
    }

    private fun stopStream(name: String) { sseJobs.remove(name)?.cancel() }

    fun loadSessionsFor(project: String) {
        val a = api ?: return
        viewModelScope.launch(Dispatchers.IO) {
            _state.update { it.copy(pickerLoading = true, pickerError = null, pickerProject = project) }
            runCatching { a.sessionsFor(project) }
                .onSuccess { resp -> _state.update { it.copy(
                    pickerProjectPath = resp.projectPath,
                    pickerEncodedDir = resp.encodedDir,
                    pickerAttached = resp.attached,
                    pickerSessions = resp.sessions,
                    pickerLoading = false,
                ) } }
                .onFailure { err -> _state.update { it.copy(
                    pickerError = err.message, pickerLoading = false,
                ) } }
        }
    }

    fun closePicker() {
        _state.update { it.copy(
            pickerProject = null, pickerProjectPath = null, pickerEncodedDir = null,
            pickerAttached = null, pickerSessions = emptyList(),
        ) }
    }

    fun attach(project: String, sessionId: String) {
        val a = api ?: return
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { a.attachSession(project, sessionId) }
                .onSuccess {
                    _state.update { st ->
                        val p = st.panels[project] ?: return@update st
                        val np = p.copy(project = p.project.copy(attachedSession = it.attached))
                        st.copy(panels = st.panels + (project to np))
                    }
                    closePicker()
                }
                .onFailure { err -> _state.update { it.copy(pickerError = err.message) } }
        }
    }

    fun detach(project: String) {
        val a = api ?: return
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { a.detachSession(project) }
                .onSuccess {
                    _state.update { st ->
                        val p = st.panels[project] ?: return@update st
                        val np = p.copy(project = p.project.copy(attachedSession = null))
                        st.copy(panels = st.panels + (project to np))
                    }
                    closePicker()
                }
                .onFailure { err -> _state.update { it.copy(pickerError = err.message) } }
        }
    }

    // ---------- add / remove project ----------------------------------

    fun loadCandidates() {
        val a = api ?: return
        _state.update { it.copy(addPickerLoading = true, addPickerError = null) }
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { a.candidates() }
                .onSuccess { r -> _state.update { it.copy(
                    addPickerLoading = false, addPickerRoot = r.root,
                    addPickerCandidates = r.candidates,
                ) } }
                .onFailure { err -> _state.update { it.copy(
                    addPickerLoading = false, addPickerError = err.message,
                ) } }
        }
    }

    fun addProject(candidate: Candidate) {
        val a = api ?: return
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { a.addProject(AddProjectRequest(candidate.name, candidate.path)) }
                .onSuccess { refreshFleet(); _state.update { it.copy(showAddPicker = false) } }
                .onFailure { err -> _state.update { it.copy(addPickerError = err.message) } }
        }
    }

    fun removeProject(project: String) {
        val a = api ?: return
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { a.removeProject(project) }
                .onSuccess { stopStream(project); refreshFleet() }
                .onFailure { err -> _state.update { it.copy(error = err.message) } }
        }
    }

    fun openAddPicker() { _state.update { it.copy(showAddPicker = true) }; loadCandidates() }
    fun closeAddPicker() { _state.update { it.copy(showAddPicker = false) } }
}

data class AppState(
    val loading: Boolean = false,
    val error: String? = null,
    val tailscaleIp: String? = null,
    val panels: Map<String, PanelSnapshot> = emptyMap(),

    // Connection flow (login screen)
    val connecting: Boolean = false,
    val connectPhase: String? = null,  // "resolve" / "tcp" / "tls" / "ok" / "err"
    val connectError: String? = null,
    val endpoints: List<Endpoint> = emptyList(),
    val authedHost: String? = null,    // filled once a connect succeeded

    // Session picker
    val pickerProject: String? = null,
    val pickerProjectPath: String? = null,
    val pickerEncodedDir: String? = null,
    val pickerAttached: String? = null,
    val pickerSessions: List<ClaudeSession> = emptyList(),
    val pickerLoading: Boolean = false,
    val pickerError: String? = null,

    // Add-project picker
    val showAddPicker: Boolean = false,
    val addPickerRoot: String = "",
    val addPickerCandidates: List<Candidate> = emptyList(),
    val addPickerLoading: Boolean = false,
    val addPickerError: String? = null,

    // Terminal screen
    val terminalLines: List<String> = emptyList(),
    val terminalTail: String = "",
) {
    val orderedPanels: List<PanelSnapshot>
        get() = panels.values.sortedBy { it.project.name }
}
