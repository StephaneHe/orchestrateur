package com.orchestrateur.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

enum class State { idle, live, think, input, error, unread }

/**
 * The most useful single argument of a tool_use block — mirrors the web
 * dashboard's toolArgPreview (public/app.js): file_path / path / command /
 * pattern / url, else the first few keys. Empty string when no input.
 * Lets the card show "Edit <file>" / "Bash <cmd>" instead of a bare tool name.
 */
fun RawEvent.Block.toolArgPreview(max: Int = 80): String {
    val obj = input as? JsonObject ?: return ""
    fun s(k: String): String? = (obj[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
    val v = s("file_path") ?: s("path") ?: s("command") ?: s("pattern") ?: s("url")
        ?: obj.keys.take(3).joinToString(",").ifEmpty { null }
    return (v ?: "").replace(Regex("\\s+"), " ").trim().take(max)
}

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
    // True on results the SERVER fabricated to close a turn nobody will close
    // (orchestrator restart, child crash, Claude limit under no-failover). The
    // musician did NOT fail — the turn was closed for it. Web and server both
    // reduce these to `idle`; Android used to paint them red.
    val synthetic: Boolean? = null,
    val message: Msg? = null,
    @SerialName("session_id") val sessionId: String? = null,
    val result: String? = null,
    @SerialName("duration_ms") val durationMs: Long? = null,
    // Synthetic user_prompt injected by scripts/dispatch.mjs
    val text: String? = null,
    val timestamp: String? = null,
    val source: String? = null,
    // Additive coordination fields on `notification` events (server >= 0.18.0):
    // how the turn ended, its conclusion, and whether it is blocked on the chef.
    // Absent on older events — consumers fall back to a plain "done" card.
    val outcome: String? = null,
    val summary: String? = null,
    @SerialName("cost_usd") val costUsd: Double? = null,
    val awaitingChef: Boolean? = null,
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
        // tool_use: the tool's arguments (file_path, command, pattern, …).
        val input: JsonElement? = null,
        // tool_result: content is a string or array; stored as raw JSON for flexibility
        val content: JsonElement? = null,
        @SerialName("tool_use_id") val toolUseId: String? = null,
        // tool_result : vrai si l'appel a échoué — condition nécessaire d'un refus.
        @SerialName("is_error") val isError: Boolean? = null,
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

/** Response from GET /api/version — la version du serveur, affichée dans l'app. */
@Serializable
data class VersionResponse(val version: String? = null)

/** One entry returned by GET /api/conductor-chat */
@Serializable
data class ConductorChatEntry(
    val role: String,
    val text: String? = null,   // nullable/defaulted: a single entry missing this
                                // must not fail the whole list deserialization
    val ts: Long = 0L,
    val source: String? = null,
    // Additive result fields (server >= 0.18.0) — absent on older callbacks.
    val outcome: String? = null,
    val summary: String? = null,
    @SerialName("duration_ms") val durationMs: Long? = null,
    @SerialName("cost_usd") val costUsd: Double? = null,
    val awaitingChef: Boolean? = null,
    /** Chef reply that ends on NEEDS_USER_INPUT — a question, not a report. */
    val question: Boolean? = null,
)

/**
 * GET /api/pupitre — the AUTHORITATIVE fleet snapshot. Event streams alone
 * cannot tell you that a producer died or that a turn went silent: those come
 * from the server reading the `.pid` sidecar and the log's mtime. Without this
 * the app showed a crashed musician as "EN COURS" forever.
 */
@Serializable
data class PupitreSnapshot(
    val now: Long = 0L,
    val conductor: String? = null,
    val noFailover: Boolean = false,
    val limitedUntil: String? = null,
    val fleet: List<PupitreRow> = emptyList(),
)

@Serializable
data class PupitreRow(
    val name: String,
    val state: String? = null,
    val awaitingChef: Boolean = false,
    val stalled: Boolean = false,
    val deadInFlight: Boolean = false,
    val activity: String? = null,
    val lastKind: String? = null,
    val silentMs: Long? = null,
    val turnElapsedMs: Long? = null,
    val pid: Int? = null,
    val pidAlive: Boolean? = null,
    val model: String? = null,
    val provider: String? = null,
    val configModel: String? = null,
    val queueDepth: Int = 0,
    val isConductor: Boolean = false,
)
