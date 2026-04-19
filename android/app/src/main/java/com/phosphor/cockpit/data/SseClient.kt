package com.phosphor.cockpit.data

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

/**
 * Tails `/sse/logs/<project>` and parses each event line as a JSON object.
 * Malformed lines are silently skipped (the brief mandates "never truncate"
 * the stream, so we don't filter — just skip-and-continue on parse errors).
 */
class SseClient(private val api: OrchestratorApi) {

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    fun stream(project: String): Flow<JsonObject> = callbackFlow {
        val req = Request.Builder()
            .url(api.baseUrl.trimEnd('/') + "/sse/logs/" + project)
            .header("X-Orchestrator-Token", api.token)
            .header("Accept", "text/event-stream")
            .build()

        val listener = object : EventSourceListener() {
            override fun onEvent(src: EventSource, id: String?, type: String?, data: String) {
                val trimmed = data.trim()
                if (trimmed.isEmpty()) return
                try {
                    val obj = json.parseToJsonElement(trimmed) as? JsonObject ?: return
                    trySend(obj)
                } catch (_: Exception) { /* skip bad line */ }
            }
            override fun onFailure(src: EventSource, t: Throwable?, res: Response?) {
                close(t ?: RuntimeException("SSE closed: ${res?.code}"))
            }
        }
        val source = EventSources.createFactory(api.client).newEventSource(req, listener)
        awaitClose { source.cancel() }
    }

}

/**
 * Reduces stream-json events into an updated PanelSnapshot. Mirrors the
 * behaviour of public/app.js (handleStreamEvent → onSystem/onAssistant/
 * onUser/onResult). Stream deltas (`stream_event`) are ignored — the
 * complete `assistant` event carries the final content.
 */
object PanelReducer {
    private val needsInputRe = Regex("""^NEEDS_USER_INPUT:\s*(.*)$""", RegexOption.MULTILINE)

    fun reduce(snap: PanelSnapshot, ev: JsonObject): PanelSnapshot {
        val type = ev["type"]?.toString()?.trim('"') ?: return snap
        return when (type) {
            "system" -> onSystem(snap, ev)
            "assistant" -> onAssistant(snap, ev)
            "user" -> snap.copy(eventCount = snap.eventCount + 1)
            "result" -> onResult(snap, ev)
            else -> snap
        }
    }

    private fun onSystem(s: PanelSnapshot, ev: JsonObject): PanelSnapshot {
        val sub = ev["subtype"]?.toString()?.trim('"')
        if (sub != "init") return s
        val state = if (s.state == PanelState.IDLE || s.state == PanelState.DONE) PanelState.LIVE else s.state
        return s.copy(
            state = state,
            turnCount = s.turnCount + 1,
            activityVerb = "START",
            activityNote = "new turn",
            eventCount = s.eventCount + 1,
        )
    }

    private fun onAssistant(s: PanelSnapshot, ev: JsonObject): PanelSnapshot {
        val message = ev["message"] as? JsonObject ?: return s.copy(eventCount = s.eventCount + 1)
        val content = (message["content"] as? kotlinx.serialization.json.JsonArray) ?: return s.copy(eventCount = s.eventCount + 1)
        var verb = s.activityVerb
        var note = s.activityNote
        var lastText = s.lastAssistantText
        var state = s.state
        for (block in content) {
            val b = block as? JsonObject ?: continue
            when (b["type"]?.toString()?.trim('"')) {
                "text" -> lastText = b["text"]?.toString()?.trim('"').orEmpty()
                "tool_use" -> {
                    verb = (b["name"]?.toString()?.trim('"') ?: "TOOL").uppercase()
                    val input = b["input"] as? JsonObject
                    note = input?.get("file_path")?.toString()?.trim('"')
                        ?: input?.get("path")?.toString()?.trim('"')
                        ?: input?.get("command")?.toString()?.trim('"')
                        ?: "—"
                    state = PanelState.LIVE
                }
            }
        }
        return s.copy(
            state = state,
            activityVerb = verb,
            activityNote = note.take(80),
            lastAssistantText = lastText,
            eventCount = s.eventCount + 1,
        )
    }

    private fun onResult(s: PanelSnapshot, ev: JsonObject): PanelSnapshot {
        val isErr = ev["is_error"]?.toString() == "true" ||
            (ev["subtype"]?.toString()?.trim('"') ?: "").startsWith("error")
        val needs = needsInputRe.find(s.lastAssistantText)
        val state = when {
            isErr -> PanelState.ERROR
            needs != null -> PanelState.INPUT
            else -> PanelState.DONE
        }
        val verb = when (state) {
            PanelState.ERROR -> "FAIL"
            PanelState.INPUT -> "ASKS"
            else -> "DONE"
        }
        val note = when (state) {
            PanelState.ERROR -> ev["subtype"]?.toString()?.trim('"') ?: "turn failed"
            PanelState.INPUT -> needs?.groupValues?.get(1)?.trim()?.take(80).orEmpty()
            else -> "turn complete"
        }
        return s.copy(state = state, activityVerb = verb, activityNote = note, eventCount = s.eventCount + 1)
    }
}
