package com.orchestrateur.data

import kotlinx.serialization.json.JsonElement

/**
 * Direction queue of the chef pool (/api/pupitre `pool`), as the web
 * #poolband: waiting messages with « Retirer » (DELETE /api/pool/queue/:ticket)
 * and busy slots with « Interrompre » (POST /api/pool/interrupt/:slot).
 */
data class PoolTicket(val id: String, val cls: String, val head: String, val position: Int, val interrupting: Boolean, val enqueuedAt: String?)
data class PoolSlot(val slot: Int, val name: String, val state: String?, val pidAlive: Boolean, val ticketId: String?, val ticketHead: String?)

data class Pool(val size: Int, val slots: List<PoolSlot>, val queue: List<PoolTicket>) {
    val free: Int get() = slots.count { it.ticketId == null && !it.pidAlive }
    fun busySlots(): List<PoolSlot> = slots.filter { it.ticketId != null || it.pidAlive }
    /** Band headline, or null when nothing waits. */
    fun headline(): String? {
        if (queue.isEmpty()) return null
        val n = queue.size
        return "⏳ File de direction · $n message${if (n > 1) "s" else ""} en attente · " +
            if (free > 0) "$free libre" else "chef occupé"
    }
}

fun parsePool(j: JsonElement?): Pool = Pool(
    size = j.i("size") ?: 0,
    slots = j.a("slots").map { s ->
        PoolSlot(s.i("slot") ?: 0, s.s("name") ?: "", s.s("state"), s.b("pidAlive"), s.o("ticket").s("id"), s.o("ticket").s("head"))
    },
    queue = j.a("queue").mapNotNull { q ->
        val id = q.s("id") ?: return@mapNotNull null
        PoolTicket(id, q.s("class") ?: "user", q.s("head") ?: "", q.i("position") ?: 0, q.b("interrupting"), q.s("enqueuedAt"))
    },
)
