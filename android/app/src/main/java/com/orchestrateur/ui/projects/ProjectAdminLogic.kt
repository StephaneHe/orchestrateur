package com.orchestrateur.ui.projects

import com.orchestrateur.data.PipelineChoice
import com.orchestrateur.data.b
import com.orchestrateur.data.i
import com.orchestrateur.data.l
import com.orchestrateur.data.list
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Pure logic of « Nouveau musicien » and « Session Claude — X » (public/app.js openAdd / openSession). */

// ---------- Nouveau musicien ----------

data class Candidate(val name: String, val path: String, val hasGit: Boolean, val hasClaudeMd: Boolean, val hasClaude: Boolean) {
    val marks: String
        get() = listOfNotNull("git".takeIf { hasGit }, "CLAUDE.md".takeIf { hasClaudeMd }, ".claude".takeIf { hasClaude })
            .joinToString(" · ").ifEmpty { "—" }
}

data class CandidatesView(val root: String, val candidates: List<Candidate>)

fun parseCandidates(json: JsonElement?): CandidatesView = CandidatesView(
    root = json.s("root") ?: "I:\\Dev",
    candidates = json.o("candidates").list.mapNotNull { c ->
        val name = c.s("name") ?: return@mapNotNull null
        Candidate(name, c.s("path") ?: "", c.b("hasGit"), c.b("hasClaudeMd"), c.b("hasClaude"))
    },
)

/** Same rule as PROJECT_NAME_RE of server.js. */
private val PROJECT_NAME_RE = Regex("^[A-Za-z][A-Za-z0-9_.\\-]{0,63}$")

/** Error text, or null when the form can be sent. */
fun validateNewProject(name: String, path: String): String? {
    val n = name.trim()
    val p = path.trim()
    if (n.isEmpty() || p.isEmpty()) return "nom et chemin requis"
    if (!PROJECT_NAME_RE.matches(n)) return "nom invalide (lettres/chiffres/_.-, 1 à 64, commence par une lettre)"
    return null
}

fun addProjectBody(name: String, path: String, isConductor: Boolean): JsonObject = buildJsonObject {
    put("name", name.trim())
    put("path", path.trim())
    put("isConductor", isConductor)
}

fun addProjectMessage(name: String, json: JsonElement?): String =
    if (json.b("promoted")) "✓ ${json.s("conductor") ?: name} devient le chef d’orchestre"
    else "✓ ${json.o("project").s("name") ?: name} ajouté à l’orchestre"

// ---------- Sessions ----------

data class SessionInfo(
    val id: String,
    val mtime: Long,
    val live: Boolean,
    val gitBranch: String?,
    val sizeHuman: String?,
    val approxTurns: Int,
    val preview: String?,
    val lastMessage: String?,
) {
    val shortId: String get() = id.take(8)
}

data class SessionsView(val projectPath: String?, val encodedDir: String?, val attached: String?, val sessions: List<SessionInfo>) {
    val pathLine: String get() = listOfNotNull(projectPath, encodedDir).joinToString("  ·  ")
    fun isAttached(s: SessionInfo) = s.id == attached
}

fun parseSessions(json: JsonElement?): SessionsView = SessionsView(
    projectPath = json.s("projectPath"),
    encodedDir = json.s("encodedDir"),
    attached = json.s("attached"),
    sessions = json.o("sessions").list.mapNotNull { s ->
        val id = s.s("id") ?: return@mapNotNull null
        SessionInfo(
            id = id, mtime = s.l("mtime") ?: 0L, live = s.b("live"), gitBranch = s.s("gitBranch"),
            sizeHuman = s.s("sizeHuman"), approxTurns = s.i("approxTurns") ?: 0,
            preview = s.s("preview"), lastMessage = s.s("lastMessage")?.takeIf { it.isNotBlank() },
        )
    },
)

/** app.js fmtRel, in French: « il y a 5m ». */
fun sessionWhen(s: SessionInfo, now: Long): String {
    val sec = (now - s.mtime) / 1000
    val t = when {
        sec < 60 -> "${sec}s"
        sec < 3600 -> "${sec / 60}m"
        sec < 86400 * 2 -> "${sec / 3600}h"
        else -> "${sec / 86400}j"
    }
    return "il y a $t"
}

fun sessionMeta(s: SessionInfo): String = "${s.gitBranch ?: "—"} · ${s.sizeHuman ?: "?"} · ${s.approxTurns} tours"
fun sessionFirstLine(s: SessionInfo): String = "début · ${s.preview?.takeIf { it.isNotBlank() } ?: "(vide)"}"
fun sessionLastLine(s: SessionInfo): String? = s.lastMessage?.let { "dernier · $it" }

fun attachBody(sessionId: String): JsonObject = buildJsonObject { put("session_id", sessionId) }

fun newSessionBody(prompt: String, choice: PipelineChoice): JsonObject = buildJsonObject {
    put("prompt", prompt.trim())
    choice.pipeline?.let { put("pipeline", it) }
    choice.mode?.let { put("pipelineMode", it) }
}

sealed class NewSessionOutcome {
    data class Started(val sessionId: String) : NewSessionOutcome()
    /** Project in pipeline service: the request went into a pipeline, no session id. */
    data class Pipeline(val note: String) : NewSessionOutcome()
    data class Failed(val error: String) : NewSessionOutcome()
}

fun parseNewSession(code: Int, json: JsonElement?, fallbackError: String): NewSessionOutcome {
    if (code !in 200..299) return NewSessionOutcome.Failed(json.s("error") ?: fallbackError)
    if (json.b("pipeline")) return NewSessionOutcome.Pipeline(json.s("note") ?: "la demande part dans un pipeline")
    val sid = json.s("session_id") ?: return NewSessionOutcome.Failed(json.s("error") ?: fallbackError)
    return NewSessionOutcome.Started(sid)
}
