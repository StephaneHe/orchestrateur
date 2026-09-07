package com.orchestrateur.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

enum class State { idle, live, think, input, error, unread }

@Serializable
data class ProjectConfig(
    val name: String,
    val path: String? = null,
    val model: String? = null,
    val tools: String? = null,
    val attachedSession: String? = null,
    val readAt: String? = null,
    val currentState: String? = null,
    val lastLine: String? = null,
    val unreadCount: Int? = null,
    val parked: Boolean? = null,
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
    // Synthetic user_prompt injected by scripts/dispatch.mjs
    val text: String? = null,
    val timestamp: String? = null,
    val source: String? = null,
    @SerialName("attachmentPaths") val attachmentPaths: List<String>? = null,
    // Usage + cost — present on `result` events.
    val usage: Usage? = null,
    @SerialName("total_cost_usd") val totalCostUsd: Double? = null,
    @SerialName("modelUsage") val modelUsage: Map<String, ModelUsage>? = null,
    @SerialName("permission_denials") val permissionDenials: List<PermissionDenial>? = null,
    // Present on `stream_event` lines (token-level deltas) — used for live streaming.
    val event: StreamEvent? = null,
) {
    @Serializable
    data class Msg(val content: List<Block>? = null)

    /** The inner event of a `stream_event` line (Anthropic streaming shape). */
    @Serializable
    data class StreamEvent(
        val type: String? = null,                       // content_block_start|_delta|_stop|message_stop
        val index: Int? = null,
        @SerialName("content_block") val contentBlock: Block? = null,
        val delta: Delta? = null,
    )

    @Serializable
    data class Delta(
        val type: String? = null,
        val text: String? = null,
        val thinking: String? = null,
        @SerialName("partial_json") val partialJson: String? = null,
    )

    @Serializable
    data class Block(
        val type: String? = null,
        val id: String? = null,           // tool_use block id
        val text: String? = null,
        val thinking: String? = null,
        val name: String? = null,
        // tool_result: content is a string or array; stored as raw JSON for flexibility
        val content: JsonElement? = null,
        @SerialName("tool_use_id") val toolUseId: String? = null,
    )

    @Serializable
    data class Usage(
        @SerialName("input_tokens") val inputTokens: Long? = null,
        @SerialName("output_tokens") val outputTokens: Long? = null,
        @SerialName("cache_read_input_tokens") val cacheReadInputTokens: Long? = null,
        @SerialName("cache_creation_input_tokens") val cacheCreationInputTokens: Long? = null,
    )

    @Serializable
    data class ModelUsage(
        @SerialName("contextWindow") val contextWindow: Long? = null,
        @SerialName("inputTokens") val inputTokens: Long? = null,
        @SerialName("outputTokens") val outputTokens: Long? = null,
        @SerialName("costUSD") val costUsd: Double? = null,
    )
}

/** One tool denied in a `result` event's `permission_denials` list. */
@Serializable
data class PermissionDenial(
    @SerialName("tool_name") val toolName: String,
    @SerialName("tool_use_id") val toolUseId: String? = null,
)

/** Response from POST /api/attach/image */
@Serializable
data class AttachResponse(val path: String)

/** One entry returned by GET /api/conductor-chat */
@Serializable
data class ConductorChatEntry(
    val role: String,
    val text: String? = null,   // nullable/defaulted: a single entry missing this
                                // must not fail the whole list deserialization
    val ts: Long = 0L,
    val source: String? = null,
)
