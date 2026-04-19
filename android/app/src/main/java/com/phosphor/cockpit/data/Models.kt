package com.phosphor.cockpit.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ConfigResponse(
    val defaults: Defaults,
    val projects: List<Project>,
)

@Serializable
data class Defaults(
    val model: String? = null,
    val allowedTools: String = "Read,Edit,Write,Bash",
)

@Serializable
data class Project(
    val name: String,
    val model: String? = null,
    val tools: String = "Read,Edit,Write,Bash",
    val attachedSession: String? = null,
)

@Serializable
data class HealthResponse(
    val ok: Boolean,
    val uptime: Double,
    val tailscale: String? = null,
    val projects: Int = 0,
    val centralPty: String = "idle",
)

@Serializable
data class SessionListResponse(
    val projectName: String,
    val projectPath: String,
    val encodedDir: String,
    val attached: String? = null,
    val sessions: List<ClaudeSession>,
)

@Serializable
data class ClaudeSession(
    val id: String,
    val mtime: Double,
    val size: Long = 0,
    val preview: String? = null,
    val gitBranch: String? = null,
    val startedAt: String? = null,
)

@Serializable
data class AttachRequest(
    @SerialName("session_id") val sessionId: String,
)

@Serializable
data class AttachResponse(
    val ok: Boolean,
    val attached: String? = null,
)

@Serializable
data class CandidatesResponse(
    val root: String,
    val candidates: List<Candidate>,
)

@Serializable
data class Candidate(
    val name: String,
    val path: String,
    val hasGit: Boolean = false,
    val hasClaudeMd: Boolean = false,
    val hasClaude: Boolean = false,
)

@Serializable
data class AddProjectRequest(
    val name: String,
    val path: String,
    val model: String? = null,
    val tools: String? = null,
)

@Serializable
data class AddProjectResponse(
    val ok: Boolean,
    val project: Project,
)

@Serializable
data class GenericResponse(val ok: Boolean = false, val error: String? = null)

// UI-side derived state — the panel's current "face" as shown on the mobile
// fleet screen. This is *not* sent by the server; it is produced by the
// stream-json parser over SSE.
enum class PanelState { IDLE, LIVE, INPUT, DONE, ERROR }

data class PanelSnapshot(
    val project: Project,
    val state: PanelState = PanelState.IDLE,
    val activityVerb: String = "IDLE",
    val activityNote: String = "awaiting dispatch",
    val eventCount: Int = 0,
    val turnCount: Int = 0,
    val lastAssistantText: String = "",
)
