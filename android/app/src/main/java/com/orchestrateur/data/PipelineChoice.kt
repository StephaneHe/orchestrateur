package com.orchestrateur.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Pipeline selector of the composer (server 0.52.0, pipelines phase 5).
 * AUTO lets the server classify the request; any other choice wins over the
 * classification and travels with the request (queue included).
 */
enum class PipelineChoice(val label: String, val pipeline: String?, val mode: String?) {
    AUTO("auto", null, null),
    DISCUSSION("Discussion", "discussion", null),
    DEV_LEGER("Dév. léger", "dev", "leger"),
    DEV_COMPLET("Dév. complet", "dev", "complet");

    /** Next value on tap: auto → Discussion → Dév. léger → Dév. complet → auto. */
    fun next(): PipelineChoice = entries[(ordinal + 1) % entries.size]
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
    put("prompt", prompt)
    if (attachmentPaths.isNotEmpty()) put("attachmentPaths", buildJsonArray { attachmentPaths.forEach { add(it) } })
    if (videoPaths.isNotEmpty()) put("videoPaths", buildJsonArray { videoPaths.forEach { add(it) } })
    choice.pipeline?.let { put("pipeline", it) }
    choice.mode?.let { put("pipelineMode", it) }
}
