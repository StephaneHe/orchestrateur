package com.orchestrateur.ui.fleet

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.orchestrateur.data.Api
import com.orchestrateur.data.FleetStream
import com.orchestrateur.data.Musician
import com.orchestrateur.data.RawEvent
import com.orchestrateur.data.State
import com.orchestrateur.data.toolArgPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

private const val TAG = "FleetViewModel"
private const val CHAT_MAX = 200   // conductor chat entries kept (incl. chef activity steps)
private const val PUPITRE_POLL_MS = 5_000L   // same cadence as the web dashboard
private const val BASKET_MERGE_MS = 60_000L  // results landing within a minute share a basket

data class PendingAttachment(
    val uri: Uri,
    val mimeType: String,
    val isVideo: Boolean,
    val thumbBitmap: Bitmap? = null,
)

/** One musician result inside a "Résultats reçus" basket. */
data class ResultItem(
    val source: String,
    val outcome: String,          // done | failed | ask_chef
    val summary: String,
    val text: String,
    val durationMs: Long? = null,
    val costUsd: Double? = null,
    val awaitingChef: Boolean = false,
    val ts: Long = System.currentTimeMillis(),
)

/** "prend en compte : A ✓ · B ✕" — what a chef turn is answering about. */
data class TakingRef(val source: String, val outcome: String)

data class ChatMsg(
    val role: Role,
    val text: String,
    val ts: Long = System.currentTimeMillis(),
    val id: String = java.util.UUID.randomUUID().toString(),
    val imageUris: List<Uri> = emptyList(),
    val videoUris: List<Uri> = emptyList(),
    val source: String? = null,
    // For role=activity: which kind of chef mid-turn block this is.
    val kind: String? = null,   // "thinking" | "tool" | "text" | "result"
    // role=results: the basket's cards.
    val results: List<ResultItem> = emptyList(),
    // role=conductor: results this turn is answering about.
    val taking: List<TakingRef> = emptyList(),
    // role=conductor: the reply ends on NEEDS_USER_INPUT → it is a question.
    val question: Boolean = false,
) {
    // activity = the chef's mid-turn steps (thinking / tool_use / intermediate
    // text), kept persistently so nothing is erased when the next block arrives.
    // results  = a musician result basket (a musician REPORTS, it does not talk).
    // question = a musician asking the USER — jumps the basket, needs an answer.
    enum class Role { user, conductor, callback, activity, results, question }
}

class FleetViewModel(
    private val api: Api,
    private val appContext: Context,
) : ViewModel() {

    val musicians = mutableStateListOf<Musician>()

    /** Conductor transcript — user messages + conductor synthesis bubbles. */
    val chat = mutableStateListOf<ChatMsg>()

    /** Attachments pending on the next send. Cleared by dispatch(). */
    val pendingImages = mutableStateListOf<PendingAttachment>()

    /** Which tab the user is currently viewing. Default: the conductor. */
    var activeTab: String by mutableStateOf(CONDUCTOR)
        private set

    private val _status = MutableStateFlow("connecting…")
    val status: StateFlow<String> = _status

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected

    /** Fleet-wide availability from the last snapshot (banner, never a bubble). */
    private val _limitedUntil = MutableStateFlow<String?>(null)
    val limitedUntil: StateFlow<String?> = _limitedUntil
    private val _noFailover = MutableStateFlow(false)
    val noFailover: StateFlow<Boolean> = _noFailover

    /** False when the last /api/pupitre poll failed — the telemetry on screen is
     *  the last known one, so the UI must say so instead of implying it is live. */
    private val _telemetryFresh = MutableStateFlow(true)
    val telemetryFresh: StateFlow<Boolean> = _telemetryFresh

    private var streamJob: Job? = null
    private var pupitreJob: Job? = null

    init { boot() }

    // ---- Authoritative snapshot poll --------------------------------------
    //
    // The SSE stream carries events; it cannot tell us a producer died or a turn
    // went silent. Without this poll a crashed musician stayed "EN COURS" on the
    // phone forever. Runs only while the app is in the FOREGROUND (started by
    // resumeStream / boot, cancelled by pauseStream) so a backgrounded phone
    // does not poll a USB-backed server every 5s for nothing.
    private fun startPupitrePoll() {
        if (pupitreJob?.isActive == true) return
        pupitreJob = viewModelScope.launch {
            while (true) {
                try {
                    val snap = api.fetchPupitre()
                    val byName = snap.fleet.associateBy { it.name }
                    for (m in musicians) byName[m.name]?.let { m.applyPupitre(it) }
                    _limitedUntil.value = snap.limitedUntil
                    _noFailover.value = snap.noFailover
                    _telemetryFresh.value = true
                } catch (_: Exception) {
                    // Keep the last snapshot on screen, but flag it as stale.
                    _telemetryFresh.value = false
                }
                kotlinx.coroutines.delay(PUPITRE_POLL_MS)
            }
        }
    }

    private fun stopPupitrePoll() {
        pupitreJob?.cancel()
        pupitreJob = null
    }

    private fun boot() {
        viewModelScope.launch {
            // Best-effort initial load. Even if it fails (server down at launch),
            // we still start the stream: its auto-reconnect + the re-sync on the
            // next successful Open will populate the fleet once the server is
            // reachable — so the app never gets stuck on "Chargement…".
            syncFromConfig()
            startStream()
            startPupitrePoll()
        }
    }

    /**
     * Fetch /api/config and MERGE authoritative state into the musician list
     * (creating instances for new projects, updating existing ones in place so
     * their event rings survive a reconnect). Returns true on success.
     */
    private suspend fun syncFromConfig(): Boolean {
        return try {
            val cfg = api.fetchConfig()
            val existing = musicians.associateBy { it.name }
            val merged = cfg.projects.map { p ->
                val st = runCatching { State.valueOf(p.currentState ?: "idle") }.getOrDefault(State.idle)
                val m = existing[p.name] ?: Musician(name = p.name)
                m.applyServerState(
                    state = st,
                    unreadCount = p.unreadCount ?: 0,
                    lastLine = p.lastLine.orEmpty(),
                    parked = p.parked ?: false,
                    readAt = p.readAt,
                )
                m
            }
            musicians.clear()
            musicians.addAll(merged)
            _status.value = "online · ${musicians.size} musiciens"
            true
        } catch (e: Exception) {
            _status.value = "erreur config: ${e.message}"
            _connected.value = false
            false
        }
    }

    /** Backoff state for auto-reconnect. Reset to 1s on every successful Open. */
    private var reconnectDelayMs: Long = 1_000L
    private val reconnectMaxMs: Long = 30_000L

    fun reconnect() {
        streamJob?.cancel()
        _connected.value = false
        _status.value = "reconnexion…"
        reconnectDelayMs = 1_000L  // user-driven: reset backoff
        startStream()
    }

    /** Called when the activity goes to background (ON_STOP). Cancels the
     *  SSE collect job so OkHttp closes its socket properly — the server
     *  then doesn't try to push events into a zombie connection. */
    private var paused = false
    fun pauseStream() {
        paused = true
        streamJob?.cancel()
        streamJob = null
        stopPupitrePoll()          // foreground-only telemetry
        _connected.value = false
        _status.value = "en pause"
    }

    /** Called when the activity returns to foreground (ON_START). Re-opens
     *  the SSE connection from a clean state. */
    fun resumeStream() {
        paused = false
        if (streamJob?.isActive != true) {
            reconnectDelayMs = 1_000L
            startStream()
        }
        startPupitrePoll()   // resumes the authoritative telemetry with the UI
    }

    private fun startStream() {
        // Single-flight: if a stream is already running, don't start a 2nd.
        // Without this guard, fast lifecycle events / config changes /
        // reconnect callbacks could open multiple SSE connections in
        // parallel — server logs showed 2 sockets opening 50ms apart and
        // some closing within 331ms (just after open). One SSE is enough,
        // the server multiplexes everything.
        if (streamJob?.isActive == true) {
            Log.d(TAG, "startStream skipped — already active")
            return
        }
        streamJob = viewModelScope.launch {
            val stream = FleetStream(api)
            try {
                stream.connect().collect { ev ->
                    when (ev) {
                        is FleetStream.Event.Message -> {
                            val m = musicians.find { it.name == ev.envelope.project } ?: return@collect
                            try {
                                val prevState = m.state
                                val raw = api.json.decodeFromString(RawEvent.serializer(), ev.envelope.line)
                                if (raw.type == "result" && !raw.permissionDenials.isNullOrEmpty()) {
                                    Log.d(TAG, "SSE result for ${m.name}: denials=${raw.permissionDenials.map { it.toolName }}")
                                }
                                m.ingest(raw)
                                if (m.name == CONDUCTOR) onConductorEvent(m, raw)
                                // Only promote a musician to the front when it starts
                                // NEEDING something (question / failure). Promoting on
                                // EVERY transition made the tab under the user's thumb
                                // jump away mid-tap (live→think→live is constant).
                                val needsAttentionNow =
                                    (m.state == State.input || m.state == State.error) &&
                                        m.state != prevState
                                if (needsAttentionNow) {
                                    val idx = musicians.indexOf(m)
                                    if (idx > 0) { musicians.removeAt(idx); musicians.add(0, m) }
                                }
                            } catch (e: Exception) {
                                Log.w(TAG, "ingest error for ${ev.envelope.project}: $e")
                            }
                        }
                        is FleetStream.Event.Error -> {
                            _status.value = "sse error: ${ev.cause?.message}"
                            _connected.value = false
                        }
                        is FleetStream.Event.Open -> {
                            reconnectDelayMs = 1_000L  // reset backoff on successful open
                            _connected.value = true
                            // Re-sync authoritative state from /api/config instead of
                            // blank-resetting every musician to idle. The SSE stream
                            // starts at EOF (no replay), so a reset() here used to wipe
                            // states the server already knew (input/unread) until the
                            // next event — hiding blocked panels. Merge keeps them.
                            viewModelScope.launch {
                                syncFromConfig()
                                loadConductorHistory()
                                if (activeTab != CONDUCTOR) loadProjectEvents(activeTab)
                            }
                        }
                        is FleetStream.Event.Closed -> {
                            _status.value = "sse closed"
                            _connected.value = false
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "stream collect crashed: $e")
            }

            // Auto-reconnect with exponential backoff. Caps at 30s. Skips
            // when the user/lifecycle has explicitly paused us (background)
            // so we don't fight resumeStream() — only resumeStream calls
            // startStream() in that path.
            if (paused) return@launch
            val delayMs = reconnectDelayMs
            _status.value = "reconnexion dans ${delayMs / 1000}s…"
            kotlinx.coroutines.delay(delayMs)
            reconnectDelayMs = (delayMs * 2).coerceAtMost(reconnectMaxMs)
            if (!paused) startStream()
        }
    }

    // ---- Results basket (mirrors the web dashboard, 0.18.0) ----------------
    //
    // A musician result that lands WHILE the chef is mid-turn must not be spliced
    // into that turn: it is held here and released after the chef's reply, as a
    // "Résultats reçus (n)" basket. Nothing here ever starts a chef turn.
    private val pendingResults = mutableListOf<ResultItem>()
    private val resultsSinceChefTurn = mutableListOf<TakingRef>()
    private var currentTurnTaking: List<TakingRef> = emptyList()
    private var chefTurnOpen = false

    private fun chatKey(s: String): String = s.replace(Regex("\\s+"), " ").trim().take(160)

    /** The notification and the relayed sourced user_prompt carry the SAME text;
     *  reconnect replays can repeat one. Collapse them to a single card. */
    private fun isDuplicateResult(txt: String): Boolean {
        val k = chatKey(txt)
        if (k.isEmpty()) return false
        if (pendingResults.any { chatKey(it.text) == k }) return true
        return chat.any { msg ->
            (msg.role == ChatMsg.Role.callback && chatKey(msg.text) == k) ||
                (msg.role == ChatMsg.Role.results && msg.results.any { chatKey(it.text) == k })
        }
    }

    private fun makeResultItem(raw: RawEvent, txt: String, source: String) = ResultItem(
        source = source,
        outcome = raw.outcome ?: if (raw.subtype == "musician_question") "question" else "done",
        summary = raw.summary.orEmpty(),
        text = txt,
        durationMs = raw.durationMs,
        costUsd = raw.costUsd,
        awaitingChef = raw.awaitingChef == true,
    )

    private fun fileResult(item: ResultItem) {
        resultsSinceChefTurn.add(TakingRef(item.source, item.outcome))
        if (chefTurnOpen) { pendingResults.add(item); return }
        appendResultGroup(listOf(item))
    }

    private fun appendResultGroup(items: List<ResultItem>) {
        if (items.isEmpty()) return
        val last = chat.lastOrNull()
        if (last != null && last.role == ChatMsg.Role.results &&
            System.currentTimeMillis() - last.ts < BASKET_MERGE_MS
        ) {
            // Same id → the LazyColumn keeps its slot, no scroll jump.
            chat[chat.size - 1] = last.copy(results = last.results + items)
            return
        }
        chat.add(ChatMsg(ChatMsg.Role.results, text = "", results = items))
        while (chat.size > CHAT_MAX) chat.removeAt(0)
    }

    private fun endChefTurn() {
        chefTurnOpen = false
        currentTurnTaking = emptyList()
        if (pendingResults.isNotEmpty()) {
            val released = pendingResults.toList()
            pendingResults.clear()
            appendResultGroup(released)
        }
    }

    private fun onConductorEvent(m: Musician, raw: RawEvent) {
        when (raw.type) {
            "notification" -> {
                val txt = raw.text?.trim().orEmpty()
                val source = raw.source ?: return
                if (txt.isEmpty() || isDuplicateResult(txt)) return
                val item = makeResultItem(raw, txt, source)
                if (item.outcome == "question") {
                    // Asking the USER — jumps the basket, it needs an answer now.
                    chat.add(ChatMsg(
                        ChatMsg.Role.question,
                        text = item.summary.ifEmpty { txt },
                        source = source,
                    ))
                    while (chat.size > CHAT_MAX) chat.removeAt(0)
                } else {
                    fileResult(item)
                }
            }
            "system" -> if (raw.subtype == "init") {
                // A real chef turn starts: hold incoming results until it replies,
                // and remember what came back since the previous turn.
                chefTurnOpen = true
                currentTurnTaking = resultsSinceChefTurn.toList()
                resultsSinceChefTurn.clear()
            }
            "user_prompt" -> {
                val txt = raw.text?.trim().orEmpty()
                if (txt.isEmpty() && raw.attachmentPaths.isNullOrEmpty()) return
                val source = raw.source
                val last = chat.lastOrNull()
                // Strip Android reply-quote prefix ("> [chef|moi] ...\n\n") before
                // comparing so the local echo is recognised even when a reply was sent.
                val txtStripped = REPLY_PREFIX_RE.replace(txt, "").trim()
                val isLocalEcho = source == null
                    && last != null
                    && last.role == ChatMsg.Role.user
                    && (last.text.trim() == txt || last.text.trim() == txtStripped)
                if (source != null) {
                    // Relayed musician callback — same routing as the notification.
                    // An @shortcut prompt carries source="shortcut→X" but IS the
                    // user's own message, so it stays a user bubble.
                    if (source.startsWith("shortcut")) {
                        if (!isLocalEcho) chat.add(ChatMsg(ChatMsg.Role.user, txt))
                    } else if (!isDuplicateResult(txt)) {
                        fileResult(makeResultItem(raw, txt, source))
                    }
                } else {
                    if (!isLocalEcho) chat.add(ChatMsg(ChatMsg.Role.user, txt))
                    chefTurnOpen = true      // the user just opened a chef turn
                }
            }
            "assistant" -> {
                // Accumulate the chef's mid-turn steps as PERSISTENT entries so
                // nothing is erased when the next block arrives (thinking → tool
                // → text → …). The live-streaming bubble shows the in-flight
                // block; once consolidated it lands here for good.
                for (b in raw.message?.content.orEmpty()) {
                    when (b.type) {
                        "thinking" -> b.thinking?.trim()?.takeIf { it.isNotEmpty() }
                            ?.let { chat.add(ChatMsg(ChatMsg.Role.activity, it, kind = "thinking")) }
                        "tool_use" -> {
                            val arg = b.toolArgPreview()
                            val label = (b.name ?: "outil") + (if (arg.isNotBlank()) " $arg" else "")
                            chat.add(ChatMsg(ChatMsg.Role.activity, label, kind = "tool"))
                        }
                        "text" -> b.text?.trim()?.takeIf { it.isNotEmpty() }
                            ?.let { chat.add(ChatMsg(ChatMsg.Role.activity, it, kind = "text")) }
                    }
                }
                while (chat.size > CHAT_MAX) chat.removeAt(0)
            }
            "user" -> {
                // Tool results the chef received mid-turn — keep a condensed line.
                for (b in raw.message?.content.orEmpty()) {
                    if (b.type != "tool_result") continue
                    val preview = Musician.blockText(b).trim().lines().take(4).joinToString("\n").take(400)
                    if (preview.isNotEmpty()) chat.add(ChatMsg(ChatMsg.Role.activity, preview, kind = "result"))
                }
                while (chat.size > CHAT_MAX) chat.removeAt(0)
            }
            "result" -> {
                val txt = m.lastAssistantText.trim()
                if (txt.isEmpty()) { endChefTurn(); return }
                // The final synthesis also arrived as an assistant `text` activity —
                // drop that trailing activity so it shows once, as the conductor bubble.
                val tail = chat.lastOrNull()
                if (tail != null && tail.role == ChatMsg.Role.activity && tail.kind == "text" && tail.text.trim() == txt) {
                    chat.removeAt(chat.size - 1)
                }
                val last = chat.lastOrNull()
                if (last != null && last.role == ChatMsg.Role.conductor && last.text.trim() == txt) {
                    endChefTurn(); return
                }
                chat.add(ChatMsg(
                    ChatMsg.Role.conductor, txt,
                    taking = currentTurnTaking,
                    question = CHEF_QUESTION_RE.containsMatchIn(txt),
                ))
                while (chat.size > CHAT_MAX) chat.removeAt(0)
                endChefTurn()   // release results held during this turn, AFTER the reply
            }
        }
    }

    fun selectTab(name: String) {
        activeTab = name
        if (name == CONDUCTOR) return
        musicians.find { it.name == name }?.let { m ->
            m.markRead()
            viewModelScope.launch {
                runCatching { api.markRead(m.name) }
                if (m.ring.isEmpty()) loadProjectEvents(name)
            }
        }
    }

    /**
     * Rebuild the thread from the server history using the SAME ordering rule as
     * the live stream: a result that landed between a user prompt and the chef's
     * reply was held during that turn, so it replays AFTER the reply; runs of
     * results collapse into one basket. Otherwise a reload showed a different
     * story from the one the user had just watched.
     */
    private suspend fun loadConductorHistory() {
        val entries = api.fetchConductorChat()
        val built = mutableListOf<ChatMsg>()
        val seen = mutableSetOf<String>()
        var pending = mutableListOf<ResultItem>()
        var sinceChefTurn = mutableListOf<TakingRef>()
        var taking: List<TakingRef> = emptyList()
        var inTurn = false

        fun flush() {
            if (pending.isEmpty()) return
            val tail = built.lastOrNull()
            if (tail != null && tail.role == ChatMsg.Role.results) {
                built[built.size - 1] = tail.copy(results = tail.results + pending)
            } else {
                built.add(ChatMsg(ChatMsg.Role.results, text = "", results = pending.toList()))
            }
            pending = mutableListOf()
        }

        for (e in entries) {
            val txt = e.text.orEmpty()
            when {
                e.source != null -> {
                    val k = chatKey(txt)
                    if (k.isEmpty() || !seen.add(k)) continue
                    val outcome = e.outcome
                        ?: if (e.source.startsWith("shortcut")) "user" else "done"
                    if (outcome == "user") { built.add(ChatMsg(ChatMsg.Role.user, txt, ts = e.ts)); continue }
                    val item = ResultItem(
                        source = e.source,
                        outcome = outcome,
                        summary = e.summary.orEmpty(),
                        text = txt,
                        durationMs = e.durationMs,
                        costUsd = e.costUsd,
                        awaitingChef = e.awaitingChef == true,
                        ts = e.ts,
                    )
                    if (outcome == "question") {
                        built.add(ChatMsg(
                            ChatMsg.Role.question,
                            text = item.summary.ifEmpty { txt },
                            ts = e.ts, source = e.source,
                        ))
                    } else {
                        sinceChefTurn.add(TakingRef(item.source, item.outcome))
                        pending.add(item)
                        if (!inTurn) flush()   // outside a turn → shown in place
                    }
                }
                e.role == "conductor" -> {
                    built.add(ChatMsg(
                        ChatMsg.Role.conductor, txt, ts = e.ts,
                        taking = taking,
                        question = e.question == true || CHEF_QUESTION_RE.containsMatchIn(txt),
                    ))
                    taking = emptyList()
                    inTurn = false
                    flush()                    // held results land after the reply
                }
                else -> {
                    flush()
                    inTurn = true              // a turn opens
                    taking = sinceChefTurn.toList()
                    sinceChefTurn = mutableListOf()
                    built.add(ChatMsg(ChatMsg.Role.user, txt, ts = e.ts))
                }
            }
        }
        flush()
        chat.clear()
        chat.addAll(built)
    }

    private suspend fun loadProjectEvents(project: String) {
        val m = musicians.find { it.name == project } ?: return
        val events = api.fetchProjectEvents(project)
        m.loadHistory(events)
    }

    fun addAttachment(uri: Uri, mimeType: String, isVideo: Boolean, thumbBitmap: Bitmap? = null) {
        pendingImages.add(PendingAttachment(uri, mimeType, isVideo, thumbBitmap))
    }

    fun removeImage(index: Int) {
        if (index in pendingImages.indices) pendingImages.removeAt(index)
    }

    fun addTool(project: String, tool: String) {
        musicians.find { it.name == project }?.pendingDenials?.remove(tool)
        viewModelScope.launch {
            runCatching { api.addTool(project, tool) }
        }
    }

    fun dispatch(prompt: String, displayText: String = prompt, onDone: (Result<Unit>) -> Unit = {}) {
        val target = activeTab
        val attachments = pendingImages.toList()
        pendingImages.clear()

        val imageUris = attachments.filter { !it.isVideo }.map { it.uri }
        val videoUris = attachments.filter { it.isVideo }.map { it.uri }

        if (target == CONDUCTOR) {
            chat.add(ChatMsg(
                role = ChatMsg.Role.user,
                text = displayText,
                imageUris = imageUris,
                videoUris = videoUris,
            ))
        }

        viewModelScope.launch {
            val r = runCatching {
                val attachmentPaths = attachments
                    .filter { !it.isVideo }
                    .map { api.uploadFile(appContext, it.uri, it.mimeType) }
                val videoPaths = attachments
                    .filter { it.isVideo }
                    .map { api.uploadFile(appContext, it.uri, it.mimeType) }
                api.dispatch(target, prompt, attachmentPaths, videoPaths)
            }
            onDone(r)
        }
    }

    companion object {
        const val CONDUCTOR = "chef"
        // Matches the reply-quote prefix written by the Android composer:
        // "> [chef] quoted text\n\n"  or  "> [moi] quoted text\n\n"
        val REPLY_PREFIX_RE = Regex("^> \\[(?:chef|moi)\\] [^\n]*\n\n")
        /** A chef reply ending on this is a QUESTION to the user, not a report. */
        val CHEF_QUESTION_RE = Regex("^NEEDS_USER_INPUT:", RegexOption.MULTILINE)
    }
}

/** Extract the first video frame as a thumbnail. Returns null on failure. */
fun extractVideoThumb(context: Context, uri: Uri): Bitmap? = try {
    MediaMetadataRetriever().use { mmr ->
        mmr.setDataSource(context, uri)
        mmr.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
    }
} catch (_: Exception) { null }
