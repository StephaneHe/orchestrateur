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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
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
    /** Un /api/notify manuel : « Information de X », pas un tour terminé. */
    val isInfo: Boolean = false,
)

/**
 * Une LIGNE DE MISSION : le chef a dispatché X, et cette ligne vit sur place
 * jusqu'à l'issue. Elle n'existe que sur PREUVE — un `tool_use Bash` du chef
 * dont la commande contient `dispatch.mjs <X>`, X validé contre la flotte.
 * Sans cette preuve, un musicien actif va dans « Activité de l'orchestre ».
 */
data class MissionItem(
    val name: String,
    val launchedAt: Long = System.currentTimeMillis(),
    /** false = « lancée » ; true = démarrage réellement observé (system/init). */
    val started: Boolean = false,
    val outcome: String? = null,   // null tant que l'issue n'est pas connue
    val durationMs: Long? = null,
    val costUsd: Double? = null,
)

/** Contexte de réponse du composer : « réponse via le chef » ou « à propos de ». */
data class AnswerContext(
    val musician: String,
    val question: String = "",
    val about: Boolean = false,
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
    // role=conductor: ce tour suit un réveil OBSERVÉ ⇒ « point sur les résultats ».
    val report: Boolean = false,
    // role=missions: les lignes de mission du tour chef.
    val missions: List<MissionItem> = emptyList(),
    // role=missions: bloc « Activité de l'orchestre » (aucun dispatch chef observé).
    val observed: Boolean = false,
    // role=missions: la fenêtre du journal chef était pleine — on le dit.
    val truncated: Boolean = false,
) {
    // activity = the chef's mid-turn steps (thinking / tool_use / intermediate
    // text), kept persistently so nothing is erased when the next block arrives.
    // results  = a musician result basket (a musician REPORTS, it does not talk).
    // question = a musician asking the USER — jumps the basket, needs an answer.
    // missions = les délégations du tour chef, une ligne par musicien.
    enum class Role { user, conductor, callback, activity, results, question, missions }
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

    /** Âge du dernier instantané reçu (ms). Alimente « synchronisé il y a X ». */
    private val _snapshotAt = MutableStateFlow(0L)
    val snapshotAt: StateFlow<Long> = _snapshotAt

    /** Version du serveur (règle standing) — null tant qu'elle n'est pas connue. */
    private val _serverVersion = MutableStateFlow<String?>(null)
    val serverVersion: StateFlow<String?> = _serverVersion

    /** Contexte de réponse du composer (réponse via le chef / à propos de X). */
    var answerContext: AnswerContext? by mutableStateOf(null)
        private set

    /** Un nouveau tour du chef est arrivé pendant que l'utilisateur lisait ou
     *  rédigeait : pastille « Nouveau rapport ↓ », JAMAIS un scroll forcé. */
    var newReportPending: Boolean by mutableStateOf(false)
        private set

    fun applyAnswerContext(ctx: AnswerContext?) { answerContext = ctx }
    fun markReportSeen() { newReportPending = false }
    fun signalNewReport() { newReportPending = true }

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
                    _snapshotAt.value = System.currentTimeMillis()
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
            _serverVersion.value = api.fetchServerVersion()
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
                                else noteMusicianEvent(m.name, raw)
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
                                _serverVersion.value = api.fetchServerVersion() ?: _serverVersion.value
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
        // Sans champ `outcome` ce n'est pas un tour terminé : c'est un notify
        // manuel (ou un log pré-0.18). On l'affiche « Information de X ».
        isInfo = raw.outcome == null &&
            raw.subtype != "musician_done" && raw.subtype != "musician_question",
    )

    private fun fileResult(item: ResultItem) {
        resultsSinceChefTurn.add(TakingRef(item.source, item.outcome))
        closeMission(item)
        if (chefTurnOpen) { pendingResults.add(item); return }
        appendResultGroup(listOf(item))
    }

    private fun appendResultGroup(items: List<ResultItem>) {
        if (items.isEmpty()) return
        val last = chat.lastOrNull()
        // Fusion seulement dans la MÊME vague : un résultat arrivé après le début
        // d'un tour chef ouvre un NOUVEAU panier (jamais ajouté rétroactivement
        // à un panier que le chef a déjà traité dans son point).
        val sameWave = last != null && last.role == ChatMsg.Role.results &&
            System.currentTimeMillis() - last.ts < BASKET_MERGE_MS &&
            (lastTurnStartTs == 0L || last.ts >= lastTurnStartTs)
        if (sameWave) {
            // Same id → the LazyColumn keeps its slot, no scroll jump.
            chat[chat.size - 1] = last!!.copy(results = last.results + items)
            return
        }
        chat.add(ChatMsg(ChatMsg.Role.results, text = "", results = items))
        while (chat.size > CHAT_MAX) chat.removeAt(0)
    }

    private fun endChefTurn() {
        chefTurnOpen = false
        currentTurnTaking = emptyList()
        turnIsReport = false
        if (pendingResults.isNotEmpty()) {
            val released = pendingResults.toList()
            pendingResults.clear()
            appendResultGroup(released)
        }
    }

    // ---- Lignes de mission (P0-2) -----------------------------------------
    //
    // Même règle que le web : la ligne naît au `tool_use Bash dispatch.mjs <X>`
    // du chef, X validé contre la flotte connue. Rien d'autre ne crée de mission.

    private var currentMissionsIdx: Int = -1
    private var lastTurnStartTs: Long = 0L
    private var wakeObservedAt: Long = 0L
    private var turnIsReport = false

    /** Projets dispatchés par une commande Bash du chef (nom validé). */
    fun extractDispatches(command: String?): List<String> {
        val cmd = command ?: return emptyList()
        if (!cmd.contains("dispatch.mjs", ignoreCase = true)) return emptyList()
        val known = musicians.map { it.name }.toSet()
        val out = LinkedHashSet<String>()
        for (mm in DISPATCH_RE.findAll(cmd)) {
            val tail = mm.groupValues.getOrNull(1).orEmpty()
            val toks = tail.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
            var i = 0
            while (i < toks.size) {
                val t = toks[i].trim('"', '\'')
                if (t.startsWith("-")) {
                    if (VALUE_OPT_RE.containsMatchIn(t) && !t.contains("=")) i++
                    i++
                    continue
                }
                if (!TOKEN_RE.matches(t)) break
                if (t in known && t != CONDUCTOR) out.add(t)
                break   // le projet est le PREMIER positionnel
            }
        }
        return out.toList()
    }

    /** Ouvre (ou complète) le bloc MISSIONS du tour chef courant. */
    private fun openMission(name: String) {
        if (name == CONDUCTOR || musicians.none { it.name == name }) return
        var idx = currentMissionsIdx
        if (idx !in chat.indices || chat[idx].role != ChatMsg.Role.missions) {
            chat.add(ChatMsg(ChatMsg.Role.missions, text = ""))
            idx = chat.size - 1
            currentMissionsIdx = idx
            while (chat.size > CHAT_MAX) { chat.removeAt(0); idx--; currentMissionsIdx = idx }
        }
        if (idx !in chat.indices) return
        val entry = chat[idx]
        if (entry.missions.any { it.name == name && it.outcome == null }) return
        chat[idx] = entry.copy(missions = entry.missions + MissionItem(name))
    }

    /** Le musicien a réellement démarré (son propre system/init a été observé). */
    private fun markMissionStarted(name: String) {
        for (i in chat.indices.reversed()) {
            val e = chat[i]
            if (e.role != ChatMsg.Role.missions) continue
            val hit = e.missions.indexOfFirst { it.name == name && it.outcome == null }
            if (hit < 0) continue
            if (e.missions[hit].started) return
            val next = e.missions.toMutableList()
            next[hit] = next[hit].copy(started = true)
            chat[i] = e.copy(missions = next)
            return
        }
    }

    /** Issue reçue : la mission ouverte la plus récente pour ce musicien la prend. */
    private fun closeMission(item: ResultItem) {
        if (item.isInfo) return      // une information n'achève pas une mission
        for (i in chat.indices.reversed()) {
            val e = chat[i]
            if (e.role != ChatMsg.Role.missions) continue
            val hit = e.missions.indexOfFirst { it.name == item.source && it.outcome == null }
            if (hit < 0) continue
            val next = e.missions.toMutableList()
            next[hit] = next[hit].copy(
                started = true,
                outcome = item.outcome,
                durationMs = item.durationMs,
                costUsd = item.costUsd,
            )
            chat[i] = e.copy(missions = next)
            return
        }
    }

    /** Les lignes de mission se lisent APRÈS la réponse du chef. */
    private fun moveMissionsAfterReply() {
        val idx = currentMissionsIdx
        if (idx !in chat.indices || chat[idx].role != ChatMsg.Role.missions) return
        if (idx == chat.size - 1) return
        val entry = chat.removeAt(idx)
        chat.add(entry)
        currentMissionsIdx = chat.size - 1
    }

    /** Observation d'un événement musicien — démarrage d'une mission. */
    fun noteMusicianEvent(name: String, raw: RawEvent) {
        if (name == CONDUCTOR) return
        val isStart = (raw.type == "system" && raw.subtype == "init") ||
            (raw.type == "user_prompt" && raw.source == null)
        if (isStart) markMissionStarted(name)
    }

    /** Musiciens en vol SANS dispatch chef observé — « Activité de l'orchestre ».
     *  Jamais présenté comme une mission : on n'a pas la preuve. */
    fun orchestraActivity(): List<MissionItem> {
        val piloted = chat.asSequence()
            .filter { it.role == ChatMsg.Role.missions && !it.observed }
            .flatMap { it.missions.asSequence() }
            .filter { it.outcome == null }
            .map { it.name }
            .toSet()
        return musicians
            .filter { it.name != CONDUCTOR && !it.parked }
            .filter { it.state == State.live || it.state == State.think }
            .filter { it.name !in piloted }
            .map { MissionItem(it.name, started = true) }
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
                lastTurnStartTs = System.currentTimeMillis()
                // Un tour qui suit IMMÉDIATEMENT un réveil observé est un point
                // sur les résultats. Le drapeau est consommé ici, une seule fois.
                turnIsReport = wakeObservedAt != 0L &&
                    System.currentTimeMillis() - wakeObservedAt < WAKE_WINDOW_MS
                wakeObservedAt = 0L
                currentMissionsIdx = -1      // nouveau tour ⇒ nouveau bloc MISSIONS
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
                    // source="wake" is the server asking the chef to report on
                    // results already shown as cards — not part of the visible
                    // conversation. The chef's reply carries "prend en compte".
                    // v0.6.0 : on MÉMORISE l'origine (sans jamais l'afficher) pour
                    // rendre le tour suivant comme un POINT SUR LES RÉSULTATS.
                    if (source == "wake") { wakeObservedAt = System.currentTimeMillis(); return }
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
                            // SIGNAL STRUCTURÉ : le chef dispatche ⇒ ligne(s) de
                            // mission dans son tour. Nom validé, sinon rien.
                            if (b.name == "Bash") {
                                val cmd = (b.input as? kotlinx.serialization.json.JsonObject)
                                    ?.get("command")
                                    ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }
                                for (target in extractDispatches(cmd)) openMission(target)
                            }
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
                    report = turnIsReport,
                ))
                while (chat.size > CHAT_MAX) chat.removeAt(0)
                // Les lignes de mission se lisent après la réponse du chef.
                moveMissionsAfterReply()
                newReportPending = true     // pastille « Nouveau rapport ↓ », pas de scroll forcé
                endChefTurn()   // release results held during this turn, AFTER the reply
            }
        }
    }

    /** Ouvre le détail d'un musicien (destination NavHost) : marque lu et
     *  hydrate son anneau. Le composer, lui, reste adressé au chef. */
    fun openMusician(name: String) {
        if (name == CONDUCTOR) return
        musicians.find { it.name == name }?.let { m ->
            m.markRead()
            viewModelScope.launch {
                runCatching { api.markRead(m.name) }
                loadProjectEvents(name)
            }
        }
    }

    fun selectTab(name: String) {
        // Le fil reste TOUJOURS celui du chef : un musicien s'ouvre en détail.
        if (name == CONDUCTOR) { activeTab = CONDUCTOR; return }
        openMusician(name)
    }

    /** Envoi DIRECT à un musicien — action explicite, jamais implicite. Sans
     *  `--callback` : aucun réveil du chef, donc aucun point. L'UI le dit. */
    fun dispatchDirect(project: String, prompt: String, onDone: (Result<Unit>) -> Unit = {}) {
        viewModelScope.launch {
            onDone(runCatching { api.dispatch(project, prompt) })
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
                        // Pas de champ `outcome` dans l'historique ⇒ notify manuel.
                        isInfo = e.outcome == null,
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
        rehydrateMissions()
    }

    /**
     * Reconstruit les blocs MISSIONS depuis le journal du chef : chaque dispatch
     * observé est rattaché au tour qu'il précède ; ceux postérieurs au dernier
     * tour restent ouverts. Les lignes de mission ne sont PAS dans
     * /api/conductor-chat — sans cette passe, un rechargement les perdrait.
     */
    private var lastMissionRehydrateAt = 0L

    private suspend fun rehydrateMissions() {
        // Le journal du chef se lit par une queue de 2 Mio côté serveur : on ne
        // la redemande pas à chaque battement de reconnexion.
        val now = System.currentTimeMillis()
        if (now - lastMissionRehydrateAt < 20_000L) return
        lastMissionRehydrateAt = now
        val events = api.fetchConductorEvents(CONDUCTOR, 500)
        if (events.isEmpty()) return
        val windowFull = events.size >= 500

        data class Dispatch(val name: String, val ts: Long)
        val dispatches = mutableListOf<Dispatch>()
        for (ev in events) {
            if (ev.type != "assistant") continue
            val ts = ev.timestamp?.let {
                runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull()
            } ?: 0L
            for (b in ev.message?.content.orEmpty()) {
                if (b.type != "tool_use" || b.name != "Bash") continue
                val cmd = (b.input as? kotlinx.serialization.json.JsonObject)
                    ?.get("command")
                    ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }
                for (n in extractDispatches(cmd)) dispatches.add(Dispatch(n, ts))
            }
        }
        if (dispatches.isEmpty()) return

        fun itemsFor(slice: List<Dispatch>, afterIdx: Int): List<MissionItem> {
            val seen = mutableSetOf<String>()
            val out = mutableListOf<MissionItem>()
            for (d in slice) {
                if (!seen.add(d.name)) continue
                var item = MissionItem(d.name, launchedAt = d.ts, started = true)
                // Issue : première carte de résultat pour ce musicien APRÈS ce tour.
                for (i in maxOf(0, afterIdx) until chat.size) {
                    val e = chat[i]
                    if (e.role != ChatMsg.Role.results) continue
                    val hit = e.results.firstOrNull { it.source == d.name && !it.isInfo } ?: continue
                    item = item.copy(outcome = hit.outcome, durationMs = hit.durationMs, costUsd = hit.costUsd)
                    break
                }
                out.add(item)
            }
            return out
        }

        // Bornes de tour : les bulles `conductor` du fil reconstruit.
        val bubbleIdx = chat.indices.filter { chat[it].role == ChatMsg.Role.conductor }
        val buckets = linkedMapOf<Int, List<Dispatch>>()
        var prevTs = 0L
        for (bi in bubbleIdx) {
            val ts = chat[bi].ts
            val slice = dispatches.filter { it.ts > prevTs && it.ts <= ts }
            if (slice.isNotEmpty()) buckets[bi] = slice
            prevTs = ts
        }
        val trailing = dispatches.filter { it.ts > prevTs }

        var first: Int? = null
        // Insertion de la fin vers le début pour ne pas décaler les index.
        for (bi in buckets.keys.sortedDescending()) {
            val items = itemsFor(buckets[bi]!!, bi)
            if (items.isEmpty()) continue
            chat.add(bi + 1, ChatMsg(ChatMsg.Role.missions, text = "", ts = chat[bi].ts, missions = items))
            first = bi + 1
        }
        if (trailing.isNotEmpty()) {
            val items = itemsFor(trailing, chat.size - 1)
            if (items.isNotEmpty()) {
                chat.add(ChatMsg(ChatMsg.Role.missions, text = "", missions = items))
                currentMissionsIdx = chat.size - 1
                if (first == null) first = chat.size - 1
            }
        }
        // Fenêtre bornée côté serveur : on le dit plutôt que de laisser croire
        // que tout l'historique est là.
        val fi = first
        if (windowFull && fi != null && fi in chat.indices) {
            chat[fi] = chat[fi].copy(truncated = true)
        }
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
        /** Un `&&`, un `;` ou un saut de ligne peut enchaîner plusieurs dispatches. */
        val DISPATCH_RE = Regex("dispatch\\.mjs[\"']?([^\n;&|]*)", RegexOption.IGNORE_CASE)
        val VALUE_OPT_RE = Regex("^--(callback|source|model|provider|prompt|resume|await)")
        val TOKEN_RE = Regex("^[A-Za-z0-9_.\\-]+$")
        /** Un réveil observé n'explique le tour suivant que s'il le précède de peu. */
        const val WAKE_WINDOW_MS = 120_000L
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
