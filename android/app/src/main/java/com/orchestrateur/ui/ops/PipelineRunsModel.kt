package com.orchestrateur.ui.ops

import com.orchestrateur.data.a
import com.orchestrateur.data.b
import com.orchestrateur.data.enc
import com.orchestrateur.data.i
import com.orchestrateur.data.l
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Pure logic of « Exécutions de pipeline » (GET /api/pipeline-runs, scripts/pipeline-run-view.mjs).

data class StepView(
    val id: String, val key: String?, val title: String?, val model: String?, val served: String?,
    val status: String, val why: String?, val durationMs: Long?,
)
data class PauseOption(val key: String, val does: String, val recommended: Boolean)
data class PauseView(
    val cause: String?, val kind: String?, val transient: Boolean, val step: String?, val limit: String?,
    val options: List<PauseOption>, val recommendKey: String?, val recommendWhy: String?,
)
data class BackoffView(val step: String?, val slot: String?, val model: String?, val tier: Int?, val maxTiers: Int?, val failures: Int?, val until: String?)
data class RunView(
    val run: String, val project: String, val pipeline: String, val mode: String?, val status: String,
    val createdAt: String?, val endedAt: String?, val question: String?, val steps: List<StepView>,
    val backoff: BackoffView?, val pause: PauseView?,
)

fun parseRuns(j: JsonElement?): List<RunView> = j.a("runs").mapNotNull { r ->
    val id = r.s("run") ?: return@mapNotNull null
    val p = r.o("pause")
    val bo = r.o("backoff")
    RunView(
        run = id, project = r.s("project") ?: "", pipeline = r.s("pipeline") ?: "", mode = r.s("mode"),
        status = r.s("status") ?: "", createdAt = r.s("createdAt"), endedAt = r.s("endedAt"), question = r.s("question"),
        steps = r.a("steps").map { x ->
            StepView(x.s("id") ?: "", x.s("key"), x.s("title"), x.s("model"), x.s("served"), x.s("status") ?: "", x.s("why"), x.l("durationMs"))
        },
        backoff = bo?.let { BackoffView(it.s("step"), it.s("slot"), it.s("model"), it.i("tier"), it.i("maxTiers"), it.i("failures"), it.s("until")) },
        pause = p?.let {
            PauseView(
                cause = it.s("cause"), kind = it.s("kind"), transient = it.b("transient"), step = it.s("step"), limit = it.s("limit"),
                options = it.a("options").mapNotNull option@{ o ->
                    val k = o.s("key") ?: return@option null
                    PauseOption(k, o.s("does") ?: "", o.b("recommended"))
                },
                recommendKey = it.o("recommend").s("key"), recommendWhy = it.o("recommend").s("why"),
            )
        },
    )
}

// Same words as the run timeline of public/activite.js.
private val STEP_MARK = mapOf(
    "ok" to "✓", "refused" to "✕ refusé", "failed" to "✕ échec", "model_unavailable" to "⏸ model indisponible",
    "launch_failed" to "⚡ n’a pas démarré", "launch_refused" to "⛔ lancement refusé par l’orchestrateur",
    "running" to "● en cours", "skipped" to "↷ sautée",
)
fun stepMark(status: String): String = STEP_MARK[status] ?: status

private val RUN_STATUS = mapOf(
    "paused" to "⏸ en pause", "running" to "● en cours", "done" to "✓ terminée", "failed" to "✕ échec",
    "abandoned" to "■ abandonnée", "interrupted" to "■ interrompue",
)
fun runStatusText(status: String): String = RUN_STATUS[status] ?: status

fun runTitle(r: RunView): String = if (r.mode.isNullOrBlank()) r.pipeline else "${r.pipeline} · ${r.mode}"

fun durationText(ms: Long?): String {
    if (ms == null || ms < 0) return ""
    if (ms < 60_000) return String.format(java.util.Locale.FRANCE, "%.1f s", ms / 1000.0)
    val s = ms / 1000
    return "${s / 60} min ${(s % 60).toString().padStart(2, '0')} s"
}

/** Model of a step; the served one only when it differs (substitution is worth seeing). */
fun modelText(s: StepView): String = when {
    s.model.isNullOrBlank() -> s.served ?: ""
    s.served.isNullOrBlank() || s.served == s.model -> s.model
    else -> "${s.model} → servi ${s.served}"
}

fun backoffText(b: BackoffView): String =
    "Attente après des erreurs de lancement : palier ${b.tier ?: "?"}/${b.maxTiers ?: "?"}, ${b.failures ?: 0} échecs, " +
        "model ${b.model ?: "?"} (case ${b.slot ?: "?"})."

fun backoffBody(action: String): JsonObject = buildJsonObject { put("action", action) }

fun runsPath(project: String?, n: Int): String =
    "/api/pipeline-runs?n=$n" + (project?.let { "&project=${enc(it)}" } ?: "")

// dispatch.mjs applies these two only on the bare-reply path (latest paused run of
// the project); under --pipeline-resume they would merely resume the run.
private val BARE_ONLY = setOf("accepter", "tout supprimer")

/**
 * POST /api/dispatch body answering a pause with one of its menu words. The run id
 * follows the word: matchOptionKey reads the word first, and the chef's Routage
 * targets the cited run. A musician's run is also named by pipelineResume.
 */
fun pauseReplyBody(r: RunView, key: String, conductor: String): JsonObject = buildJsonObject {
    put("project", r.project)
    put("prompt", "$key ${r.run}")
    if (r.project != conductor && key !in BARE_ONLY) put("pipelineResume", r.run)
}

/** The newest paused run, when it carries a menu (an older pause is never offered under a newer one). */
fun latestPausedWithMenu(runs: List<RunView>): RunView? =
    runs.firstOrNull { it.status == "paused" }?.takeIf { it.pause?.options?.isNotEmpty() == true }
