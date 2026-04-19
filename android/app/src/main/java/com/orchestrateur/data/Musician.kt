package com.orchestrateur.data

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Mirror of public/app.js Musician — a compact reducer that transitions
 * between the five states based on stream-json events. Kept deliberately
 * lean: just enough to render the card.
 */
class Musician(val name: String) {
    var state: State by mutableStateOf(State.idle)
        private set
    var lastLine: String by mutableStateOf("")
        private set
    var unreadCount: Int by mutableStateOf(0)
        private set
    var lastAssistantText: String = ""
        private set

    fun ingest(raw: RawEvent) {
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
                    else -> State.unread.also { unreadCount++ }
                }
            }
        }
    }

    fun markRead() {
        if (state == State.unread) {
            state = State.idle
            unreadCount = 0
        }
    }

    companion object {
        private val NEEDS_RE = Regex("^NEEDS_USER_INPUT:\\s*(.*)$", RegexOption.MULTILINE)
    }
}
