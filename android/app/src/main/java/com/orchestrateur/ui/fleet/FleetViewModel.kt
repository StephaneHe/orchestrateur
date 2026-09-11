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

data class PendingAttachment(
    val uri: Uri,
    val mimeType: String,
    val isVideo: Boolean,
    val thumbBitmap: Bitmap? = null,
)

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
) {
    // activity = the chef's mid-turn steps (thinking / tool_use / intermediate
    // text), kept persistently so nothing is erased when the next block arrives.
    enum class Role { user, conductor, callback, activity }
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

    private var streamJob: Job? = null

    init { boot() }

    private fun boot() {
        viewModelScope.launch {
            // Best-effort initial load. Even if it fails (server down at launch),
            // we still start the stream: its auto-reconnect + the re-sync on the
            // next successful Open will populate the fleet once the server is
            // reachable — so the app never gets stuck on "Chargement…".
            syncFromConfig()
            startStream()
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
                                if (m.state != prevState) {
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

    private fun onConductorEvent(m: Musician, raw: RawEvent) {
        when (raw.type) {
            "notification" -> {
                val txt = raw.text?.trim().orEmpty()
                val source = raw.source ?: return
                if (txt.isNotEmpty()) chat.add(ChatMsg(ChatMsg.Role.callback, txt, source = source))
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
                if (!isLocalEcho) {
                    if (source != null) {
                        chat.add(ChatMsg(ChatMsg.Role.callback, txt, source = source))
                    } else {
                        chat.add(ChatMsg(ChatMsg.Role.user, txt))
                    }
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
                if (txt.isEmpty()) return
                // The final synthesis also arrived as an assistant `text` activity —
                // drop that trailing activity so it shows once, as the conductor bubble.
                val tail = chat.lastOrNull()
                if (tail != null && tail.role == ChatMsg.Role.activity && tail.kind == "text" && tail.text.trim() == txt) {
                    chat.removeAt(chat.size - 1)
                }
                val last = chat.lastOrNull()
                if (last != null && last.role == ChatMsg.Role.conductor && last.text.trim() == txt) return
                chat.add(ChatMsg(ChatMsg.Role.conductor, txt))
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

    private suspend fun loadConductorHistory() {
        val entries = api.fetchConductorChat()
        chat.clear()
        chat.addAll(entries.map { e ->
            val role = when {
                e.role == "conductor" -> ChatMsg.Role.conductor
                e.source != null -> ChatMsg.Role.callback
                else -> ChatMsg.Role.user
            }
            ChatMsg(role = role, text = e.text.orEmpty(), ts = e.ts, source = e.source)
        })
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
    }
}

/** Extract the first video frame as a thumbnail. Returns null on failure. */
fun extractVideoThumb(context: Context, uri: Uri): Bitmap? = try {
    MediaMetadataRetriever().use { mmr ->
        mmr.setDataSource(context, uri)
        mmr.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
    }
} catch (_: Exception) { null }
