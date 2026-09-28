package com.orchestrateur.data

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private const val TAG = "Musician"

data class TurnUsage(
    val inputTokens: Long,
    val outputTokens: Long,
    val cacheReadTokens: Long,
    val cacheCreateTokens: Long,
    val costUsd: Double,
    val contextUsedTokens: Long,
    val contextMaxTokens: Long,
)

/**
 * Mirror of public/app.js Musician — a compact reducer that transitions
 * between the five states based on stream-json events. Kept deliberately
 * lean: just enough to render the card.
 */
class Musician(
    val name: String,
    initialReadAt: String? = null,
    initialState: State = State.idle,
    initialLastLine: String = "",
    initialUnreadCount: Int = 0,
    initialParked: Boolean = false,
) {
    var state: State by mutableStateOf(initialState)
        private set
    var parked: Boolean by mutableStateOf(initialParked)
        private set
    var lastLine: String by mutableStateOf(initialLastLine)
        private set
    var unreadCount: Int by mutableStateOf(initialUnreadCount)
        private set
    var lastAssistantText: String = ""
        private set
    /** ISO timestamp of last "read". Loaded from /api/config, updated via markRead(). */
    var readAt: String? = initialReadAt
        private set

    /** Finished, but blocked on a CHEF decision (NEEDS_CHEF_INPUT). The state
     *  stays `unread` (locked vocabulary) — this additive flag is what keeps the
     *  pill from claiming "terminé". Set by the reducer AND by /api/pupitre. */
    var awaitingChef: Boolean by mutableStateOf(false)
        private set

    // ---- Authoritative telemetry from /api/pupitre ------------------------
    // Event streams cannot prove a producer died or a turn went silent; the
    // server derives these from the .pid sidecar and the log mtime. Null until
    // the first successful snapshot.
    var stalled: Boolean by mutableStateOf(false)
        private set
    var deadInFlight: Boolean by mutableStateOf(false)
        private set
    var pid: Int? by mutableStateOf(null)
        private set
    var pidAlive: Boolean? by mutableStateOf(null)
        private set
    var silentMs: Long? by mutableStateOf(null)
        private set
    var turnElapsedMs: Long? by mutableStateOf(null)
        private set
    var observedModel: String? by mutableStateOf(null)
        private set
    var activity: String? by mutableStateOf(null)
        private set
    var queueDepth: Int by mutableStateOf(0)
        private set

    /** Merge one authoritative snapshot row. Never touches `state`: the SSE
     *  reducer owns it — except that a confirmed-dead producer must not keep
     *  claiming the turn is running. */
    fun applyPupitre(row: PupitreRow) {
        stalled = row.stalled
        deadInFlight = row.deadInFlight
        pid = row.pid
        pidAlive = row.pidAlive
        silentMs = row.silentMs
        turnElapsedMs = row.turnElapsedMs
        observedModel = row.model ?: row.configModel
        activity = row.activity
        queueDepth = row.queueDepth
        if (row.awaitingChef) awaitingChef = true
    }

    // Cumulative usage for this musician — harvested from `result` events.
    var totalCostUsd: Double by mutableStateOf(0.0)
        private set
    var totalInputTokens: Long by mutableStateOf(0L)
        private set
    var totalOutputTokens: Long by mutableStateOf(0L)
        private set
    var totalCacheReadTokens: Long by mutableStateOf(0L)
        private set
    var totalCacheCreateTokens: Long by mutableStateOf(0L)
        private set
    var lastTurnUsage: TurnUsage? by mutableStateOf(null)
        private set

    /** Rolling history of raw stream-json events; used by the project-session
     *  pane to render what the musician is saying, mirroring the web ring. */
    val ring: MutableList<RawEvent> = mutableStateListOf()

    /** Monotonically increasing count of events ever ingested/loaded. The ring
     *  is capped, so its `size` stops changing once full — UI that needs to
     *  react to "new event arrived" (auto-scroll, derived maps) keys on this. */
    var ingestSeq: Int by mutableStateOf(0)
        private set

    /** Live token-streamed text of the CURRENT in-flight block (from
     *  stream_event deltas). Shown as a live trailing line while the turn runs;
     *  cleared when the consolidated event lands or a new turn/result arrives. */
    var liveText: String by mutableStateOf("")
        private set

    /** Short live activity hint ("⚙ Bash", "réflexion…") for the current block. */
    var liveActivity: String by mutableStateOf("")
        private set

    /** Tools blocked by --allowed-tools in the last completed turn.
     *  Cleared on turn start (system/init). Drives the approve-tool banner. */
    val pendingDenials: MutableList<String> = mutableStateListOf()

    // Last tool_use name seen in an assistant event; used to attribute denials.
    private var lastToolUseName: String? = null

    fun ingest(raw: RawEvent) {
        // Token-level deltas are VERY frequent; they must never enter the capped
        // ring (they'd evict the real assistant/tool/result events and the card
        // would look empty). Stitch them into the live-streaming buffer instead.
        if (raw.type == "stream_event") { ingestStreamEvent(raw); return }

        ring.add(raw)
        if (ring.size > RING_MAX) ring.removeAt(0)
        ingestSeq++
        when (raw.type) {
            "system" -> if (raw.subtype == "init") {
                if (state == State.idle || state == State.unread || state == State.error) state = State.live
                pendingDenials.clear()
                lastToolUseName = null
                liveText = ""
                liveActivity = ""
                awaitingChef = false      // a new turn clears the pending chef decision
                stalled = false
                deadInFlight = false
            }
            "assistant" -> {
                val content = raw.message?.content.orEmpty()
                var hasTool = false
                var hasThink = false
                var gotText: String? = null
                var toolLabel: String? = null
                for (b in content) {
                    when (b.type) {
                        "text"     -> gotText = b.text ?: ""
                        "thinking" -> hasThink = true
                        "tool_use" -> {
                            hasTool = true; lastToolUseName = b.name
                            val arg = b.toolArgPreview()
                            toolLabel = (b.name ?: "outil") + (if (arg.isNotBlank()) " $arg" else "")
                        }
                    }
                }
                // lastLine drives the card/tab preview — reflect the actual
                // activity even when the turn produced no prose (tool with its
                // target, or thinking).
                if (!gotText.isNullOrBlank()) {
                    lastAssistantText = gotText
                    lastLine = gotText.replace(Regex("\\s+"), " ").trim().take(140)
                } else if (hasTool) {
                    lastLine = "⚙ ${toolLabel ?: "outil"}".take(140)
                } else if (hasThink) {
                    lastLine = "réflexion…"
                }
                // The consolidated block is now in the ring — clear the live
                // buffer so the same text isn't shown twice.
                liveText = ""
                liveActivity = ""
                state = when {
                    hasTool -> State.live
                    hasThink -> State.think
                    else -> State.live
                }
            }
            "result" -> {
                liveText = ""
                liveActivity = ""
                val isErr = (raw.isError == true) ||
                    (raw.subtype?.startsWith("error") == true)
                val needsMatch = NEEDS_RE.find(lastAssistantText)
                // Finished but blocked on a chef decision — NOT the same as "terminé".
                awaitingChef = !isErr && needsMatch == null &&
                    (NEEDS_CHEF_RE.containsMatchIn(lastAssistantText) ||
                        NEEDS_CHEF_RE.containsMatchIn(raw.result.orEmpty()))
                state = when {
                    // A SYNTHETIC result means the system closed the turn, not that
                    // the musician failed — show it as closed (idle) with the cause,
                    // exactly like the web/server reducers. Painting it red made a
                    // quota pause look like a crash.
                    isErr && raw.synthetic == true ->
                        State.idle.also { lastLine = syntheticCause(raw.subtype) }
                    isErr -> State.error.also { lastLine = raw.subtype ?: "échec du tour" }
                    needsMatch != null -> State.input.also {
                        lastLine = needsMatch.groupValues[1].trim().take(140)
                    }
                    else -> {
                        val evTs = raw.timestamp?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
                            ?: System.currentTimeMillis()
                        val readTs = readAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L
                        if (readTs == 0L || evTs > readTs) {
                            State.unread.also { unreadCount++ }
                        } else {
                            State.idle
                        }
                    }
                }
                // Authoritative denied-tool list for this turn.
                raw.permissionDenials?.let { denials ->
                    Log.d(TAG, "[$name] result: ${denials.size} denials: ${denials.map { it.toolName }}")
                    denials.forEach { d ->
                        if (d.toolName.isNotBlank() && !pendingDenials.contains(d.toolName)) {
                            Log.i(TAG, "[$name] adding denied tool: ${d.toolName}")
                            pendingDenials.add(d.toolName)
                        }
                    }
                }
                // Harvest tokens/cost.
                val u = raw.usage
                val inTok = u?.inputTokens ?: 0L
                val outTok = u?.outputTokens ?: 0L
                val cacheRead = u?.cacheReadInputTokens ?: 0L
                val cacheCreate = u?.cacheCreationInputTokens ?: 0L
                val cost = raw.totalCostUsd ?: 0.0
                val ctxMax = raw.modelUsage?.values?.firstOrNull()?.contextWindow ?: 0L
                val ctxUsed = inTok + cacheRead + cacheCreate
                totalCostUsd += cost
                totalInputTokens += inTok
                totalOutputTokens += outTok
                totalCacheReadTokens += cacheRead
                totalCacheCreateTokens += cacheCreate
                lastTurnUsage = TurnUsage(inTok, outTok, cacheRead, cacheCreate, cost, ctxUsed, ctxMax)
            }
            "user" -> {
                // Refus en cours de tour : VRAI refus du CLI seulement (is_error + libellé
                // réel en tête), jamais « requires approval » dans un fichier lu (0.29.1,
                // même règle que public/permission-denial.js).
                val isBlocked = raw.message?.content.orEmpty().any { b ->
                    b.type == "tool_result" && b.isError == true &&
                        DENIAL_PATTERNS.any { it.containsMatchIn(blockText(b).trim()) }
                }
                if (isBlocked) {
                    val tool = lastToolUseName
                    Log.d(TAG, "[$name] user event: tool blocked, lastToolUseName=$tool")
                    if (!tool.isNullOrBlank() && !pendingDenials.contains(tool)) {
                        Log.i(TAG, "[$name] adding denied tool (live): $tool")
                        pendingDenials.add(tool)
                    }
                }
            }
        }
    }

    /** Stitch a token-level stream_event delta into the live buffer. Never adds
     *  to the ring. Keeps the card showing text as it streams in. */
    private fun ingestStreamEvent(raw: RawEvent) {
        val ev = raw.event ?: return
        when (ev.type) {
            "content_block_start" -> {
                liveText = ""                       // new block — start fresh
                val cb = ev.contentBlock
                when (cb?.type) {
                    "tool_use" -> {
                        lastToolUseName = cb.name
                        liveActivity = "⚙ ${cb.name ?: "outil"}"
                        lastLine = liveActivity
                        if (state == State.idle || state == State.unread || state == State.error) state = State.live
                    }
                    "thinking" -> { liveActivity = "réflexion…"; if (state != State.error) state = State.think }
                    else -> liveActivity = ""
                }
                ingestSeq++
            }
            "content_block_delta" -> {
                val d = ev.delta ?: return
                val chunk = d.text ?: d.thinking ?: ""   // ignore tool partial_json (args)
                if (chunk.isNotEmpty()) {
                    liveText += chunk
                    lastLine = liveText.replace(Regex("\\s+"), " ").trim().takeLast(140)
                    state = when {
                        state == State.error -> State.error
                        d.thinking != null   -> State.think
                        else                 -> State.live
                    }
                    ingestSeq++
                }
            }
            // content_block_stop / message_stop: leave liveText until the
            // consolidated assistant/result event replaces it (avoids a flicker
            // to empty between stop and the consolidated line).
        }
    }

    /** Bulk-load historical events into the ring without touching state or counters.
     *  Repopulates pendingDenials from the last result event's permission_denials. */
    fun loadHistory(events: List<RawEvent>) {
        ring.clear()
        pendingDenials.clear()
        val slice = if (events.size > RING_MAX) events.takeLast(RING_MAX) else events
        ring.addAll(slice)
        ingestSeq++
        // Use result.permission_denials — authoritative and contains tool names directly.
        events.lastOrNull { it.type == "result" }?.permissionDenials?.forEach { d ->
            if (d.toolName.isNotBlank() && !pendingDenials.contains(d.toolName)) {
                Log.i(TAG, "[$name] loadHistory: adding denied tool: ${d.toolName}")
                pendingDenials.add(d.toolName)
            }
        }
        Log.d(TAG, "[$name] loadHistory: ${events.size} events, pendingDenials=$pendingDenials")
    }

    fun reset() {
        ring.clear()
        pendingDenials.clear()
        state = State.idle
        lastLine = ""
        lastAssistantText = ""
        lastToolUseName = null
        unreadCount = 0
        lastTurnUsage = null
        liveText = ""
        liveActivity = ""
    }

    /** Merge authoritative snapshot fields from /api/config (server-computed
     *  state). Does NOT touch the event ring or usage counters — used on SSE
     *  (re)connect so a fresh stream never blanks out states the server already
     *  knows about (e.g. a musician sitting in `input`/`unread`). */
    fun applyServerState(
        state: State,
        unreadCount: Int,
        lastLine: String,
        parked: Boolean,
        readAt: String?,
    ) {
        this.state = state
        this.unreadCount = unreadCount
        this.lastLine = lastLine
        this.parked = parked
        this.readAt = readAt
    }

    fun markRead() {
        if (state == State.unread) {
            state = State.idle
            unreadCount = 0
        }
        readAt = java.time.Instant.now().toString()
    }

    companion object {
        private val NEEDS_RE = Regex("^NEEDS_USER_INPUT:\\s*(.*)$", RegexOption.MULTILINE)
        private val NEEDS_CHEF_RE = Regex("NEEDS_CHEF_INPUT:", RegexOption.IGNORE_CASE)
        // Matches "Claude requested permissions to use WebSearch, but you haven't granted it yet"
        // (\w+) stops at the comma/period so we get "WebSearch" not "WebSearch,"
        val PERM_RE = Regex("requested permissions to use (\\w+)", RegexOption.IGNORE_CASE)
        private const val RING_MAX = 30

        /** Human cause for a turn the SYSTEM closed (never a musician failure). */
        fun syntheticCause(subtype: String?): String = when {
            subtype == null -> "tour clos"
            subtype.contains("limited") -> "limité (quota)"
            subtype.contains("interrupted") -> "interrompu"
            else -> subtype
        }

        /** Libellés réels d'un refus de permission du CLI claude, ancrés en tête. */
        val DENIAL_PATTERNS = listOf(
            Regex("^Claude requested permissions? to .+ but you haven't granted it yet\\.?", RegexOption.DOT_MATCHES_ALL),
            Regex("^This command requires approval\\b"),
            Regex("^This (?:Bash|PowerShell) command contains multiple operations\\. The following parts? requires? approval\\b"),
            Regex("^Permission to use \\S+ .*has been denied\\.?\\s*$", RegexOption.DOT_MATCHES_ALL),
            Regex("^<tool_use_error>[^<]*denied by your permission settings"),
        )

        fun blockText(b: RawEvent.Block): String = when (val c = b.content) {
            is JsonPrimitive -> c.contentOrNull ?: ""
            is JsonArray -> c.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.joinToString("\n")
            else -> ""
        }
    }
}
