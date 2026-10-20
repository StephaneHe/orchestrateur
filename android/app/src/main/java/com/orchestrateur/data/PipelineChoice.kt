package com.orchestrateur.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Pipeline selector of the composer (server 0.52.0, pipelines phase 5).
 * AUTO lets the server classify the request; any other choice wins over the
 * classification and travels with the request (queue included). 1.0.0: every
 * pipeline of the engine (ENGINE_PIPELINES minus the chef's own « routage »),
 * plus the « /chef-discussion » prefix (talk it over, nothing is launched).
 */
enum class PipelineChoice(val label: String, val pipeline: String?, val mode: String?, val prefix: String? = null) {
    AUTO("auto", null, null),
    DISCUSSION("Discussion", "discussion", null),
    DEV_LEGER("Dév. léger", "dev", "leger"),
    DEV_COMPLET("Dév. complet", "dev", "complet"),

    /** Meeting minutes and files (server 0.110.0). */
    REUNION("Réunion", "reunion", null),

    INCIDENT("Incident", "incident", null),
    RECHERCHE("Recherche", "recherche", null),
    AUDIT("Audit sécurité", "audit", null),
    MAINTENANCE("Maintenance", "maintenance", null),
    NOUVEAU("Nouveau projet", "nouveau", null),
    DONNEES("Données", "donnees", null),
    REDACTION("Rédaction", "redaction", null),
    IMAGES("Images", "images", null),
    VIDEO("Vidéo", "video", null),
    AUDIO("Audio", "audio", null),
    CHEF_DISCUSSION("💬 Discuter avec le chef", null, null, "/chef-discussion");

    /** Next value on tap: auto → Discussion → Dév. léger → Dév. complet → Réunion → auto
     *  (the other choices are in the long-press menu). */
    fun next(): PipelineChoice = MAIN[(MAIN.indexOf(this) + 1).mod(MAIN.size)]

    companion object {
        val MAIN = listOf(AUTO, DISCUSSION, DEV_LEGER, DEV_COMPLET, REUNION)
    }
}

/** Body of POST /api/dispatch. Pure, so it can be unit-tested. */
fun dispatchPayload(
    project: String,
    prompt: String,
    attachmentPaths: List<String> = emptyList(),
    videoPaths: List<String> = emptyList(),
    choice: PipelineChoice = PipelineChoice.AUTO,
): JsonObject = buildJsonObject {
    put("project", project)
    val text = choice.prefix?.takeUnless { prompt.trimStart().startsWith(it) }?.let { "$it $prompt" } ?: prompt
    put("prompt", text)
    if (attachmentPaths.isNotEmpty()) put("attachmentPaths", buildJsonArray { attachmentPaths.forEach { add(it) } })
    if (videoPaths.isNotEmpty()) put("videoPaths", buildJsonArray { videoPaths.forEach { add(it) } })
    choice.pipeline?.let { put("pipeline", it) }
    choice.mode?.let { put("pipelineMode", it) }
}
