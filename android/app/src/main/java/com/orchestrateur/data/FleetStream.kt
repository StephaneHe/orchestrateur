package com.orchestrateur.data

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

/**
 * Aggregate SSE stream wrapping the server's /api/sse/fleet. Each event carries
 * one JSONL line from one project's log, inside a {project, line} envelope.
 * The flow emits parsed envelopes; downstream decides what to do with them.
 */
class FleetStream(private val api: Api) {

    sealed class Event {
        data object Open : Event()
        data class Message(val envelope: FleetEnvelope) : Event()
        data class Error(val cause: Throwable?) : Event()
        data object Closed : Event()
    }

    fun connect(): Flow<Event> = callbackFlow {
        val request = Request.Builder()
            .url(api.fleetSseUrl())
            .header("X-Orchestrator-Token", api.token())
            .header("Accept", "text/event-stream")
            .build()

        val factory = EventSources.createFactory(api.http())
        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                trySend(Event.Open)
            }
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                try {
                    val env = api.json.decodeFromString(FleetEnvelope.serializer(), data)
                    trySend(Event.Message(env))
                } catch (_: Exception) {
                    // Swallow envelope parse errors — server sometimes ships
                    // partial/non-JSON stream_event deltas inside `line`.
                }
            }
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                trySend(Event.Error(t))
                close()
            }
            override fun onClosed(eventSource: EventSource) {
                trySend(Event.Closed)
                close()
            }
        }

        val source = factory.newEventSource(request, listener)
        awaitClose { source.cancel() }
    }
}
