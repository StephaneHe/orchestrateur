package com.orchestrateur.data

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

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
class Musician(val name: String, initialReadAt: String? = null) {
    var state: State by mutableStateOf(State.idle)
        private set
    var lastLine: String by mutableStateOf("")
        private set
    var unreadCount: Int by mutableStateOf(0)
        private set
    var lastAssistantText: String = ""
        private set
    /** ISO timestamp of last "read". Loaded from /api/config, updated via markRead(). */
    var readAt: String? = initialReadAt
        private set

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

    fun ingest(raw: RawEvent) {
        ring.add(raw)
        if (ring.size > RING_MAX) ring.removeAt(0)
        when (raw.type) {
            "system" -> if (raw.subtype == "init") {
                if (state == State.idle || state == State.unread) state = State.live
            }
            "assistant" -> {
                val content = raw.message?.content.orEmpty()
                var hasTool = false
                var hasThink = false
                var gotText: String? = null
                for (b in content) {
                    when (b.type) {
                        "text"     -> gotText = b.text ?: ""
                        "thinking" -> hasThink = true
                        "tool_use" -> hasTool = true
                    }
                }
                if (!gotText.isNullOrBlank()) {
                    lastAssistantText = gotText!!
                    lastLine = gotText.replace(Regex("\\s+"), " ").trim().take(140)
                }
                state = when {
                    hasTool -> State.live
                    hasThink -> State.think
                    else -> State.live
                }
            }
            "result" -> {
                val isErr = (raw.isError == true) ||
                    (raw.subtype?.startsWith("error") == true)
                val needsMatch = NEEDS_RE.find(lastAssistantText)
                state = when {
                    isErr -> State.input.also { lastLine = raw.subtype ?: "échec du tour" }
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
        }
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
        private const val RING_MAX = 30
    }
}
