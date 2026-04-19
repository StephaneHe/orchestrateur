package com.orchestrateur.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

enum class State { idle, live, think, input, unread }

@Serializable
data class ProjectConfig(
    val name: String,
    val path: String? = null,
    val model: String? = null,
    val tools: String? = null,
    val attachedSession: String? = null,
)

@Serializable
data class ConfigResponse(
    val projects: List<ProjectConfig>,
    val defaults: JsonElement? = null,
    val tailscale: String? = null,
)

/** Envelope used by /api/sse/fleet. `line` is the raw JSONL event string. */
@Serializable
data class FleetEnvelope(
    val project: String,
    val line: String,
)

/** Top-level shape we care about in a stream-json event (partial, best-effort). */
@Serializable
data class RawEvent(
    val type: String? = null,
    val subtype: String? = null,
    @SerialName("is_error") val isError: Boolean? = null,
    val message: Msg? = null,
    @SerialName("session_id") val sessionId: String? = null,
    val result: String? = null,
    @SerialName("duration_ms") val durationMs: Long? = null,
) {
    @Serializable
    data class Msg(val content: List<Block>? = null)

    @Serializable
    data class Block(
        val type: String? = null,
        val text: String? = null,
        val thinking: String? = null,
        val name: String? = null,
    )
}
