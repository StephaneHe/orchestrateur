package com.orchestrateur.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.putJsonArray

/**
 * A musician's queue (GET /api/queue/:project): list, read-only detail like
 * the web #queue-overlay, and the order sent by ↑ / ↓ (POST …/order {ids}).
 */
data class QueueEntry(val id: String, val position: Int, val head: String, val text: String, val enqueuedAt: String?, val raw: JsonElement) {
    /** Label/value rows of the detail dialog (empty values skipped). */
    fun fields(): List<Pair<String, String>> {
        val r = raw
        val out = mutableListOf<Pair<String, String>>()
        fun add(k: String, v: String?) { if (!v.isNullOrBlank()) out += k to v }
        add("Position", r.i("position")?.toString())
        add("Identifiant", id)
        add("Mise en file", enqueuedAt)
        add("Model", listOfNotNull(r.s("model"), r.s("provider")?.takeIf { it != "claude" }).joinToString(" · ").ifBlank { null })
        add("Second model", r.s("secondModel")?.let { it + (r.s("dualMode")?.let { m -> " ($m)" } ?: "") })
        add("Pipeline", r.s("pipeline")?.let { it + (r.s("pipelineMode")?.let { m -> " · $m" } ?: "") })
        add("Reprise", r.s("pipelineResume"))
        add("Hors pipeline", r.s("horsPipeline"))
        add("Retour au", r.s("callback"))
        add("Session neuve", if (r.b("newSession")) "oui" else null)
        add("Même tâche", if (r.b("sameTask")) "oui" else null)
        add("En série", r.o("exclusive")?.let { e -> "${e.s("text") ?: ""} (règle ${e.s("rule") ?: "?"})" })
        add("Couloir", r.i("lane")?.let { "#$it" })
        add("Ressources", r.strs("ressources").joinToString(", ").ifBlank { null })
        add("Source", r.s("source"))
        add("Pièces jointes", r.i("attachments")?.takeIf { it > 0 }?.toString())
        add("Modifications", r.i("edits")?.takeIf { it > 0 }?.toString())
        return out
    }
}

data class QueueView(val busy: Boolean, val entries: List<QueueEntry>)

fun parseQueue(j: JsonElement?): QueueView = QueueView(
    busy = j.b("busy"),
    entries = j.a("entries").mapNotNull { e ->
        val id = e.s("id") ?: return@mapNotNull null
        QueueEntry(id, e.i("position") ?: 0, e.s("head") ?: "", e.s("text") ?: e.s("head") ?: "", e.s("enqueuedAt"), e)
    },
)

/** [ids] with [id] moved by [delta] places (clamped); unknown id = unchanged. */
fun moveId(ids: List<String>, id: String, delta: Int): List<String> {
    val i = ids.indexOf(id)
    if (i < 0) return ids
    val j = (i + delta).coerceIn(0, ids.lastIndex)
    if (i == j) return ids
    val m = ids.toMutableList()
    m.removeAt(i)
    m.add(j, id)
    return m
}

fun queueOrderBody(ids: List<String>): JsonObject = buildJsonObject { putJsonArray("ids") { ids.forEach { add(it) } } }
