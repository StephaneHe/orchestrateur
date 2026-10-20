package com.orchestrateur.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QueueLogicTest {
    private val sample = """
    {"project":"omega","busy":true,"count":3,"entries":[
      {"id":"q-1","position":1,"head":"Faire A","text":"Faire A en entier","enqueuedAt":"2026-10-20T10:00:00Z","model":"claude-opus-5-5","callback":"chef","source":"chef","attachments":0,"newSession":true,"pipeline":"dev","pipelineMode":"leger","edits":2},
      {"id":"q-2","position":2,"head":"Faire B","text":"Faire B","exclusive":{"rule":"git-index","text":"index git partagé"},"lane":1,"secondModel":"gpt-5.5","dualMode":"judge"},
      {"id":"q-3","position":3,"head":"Faire C","text":"Faire C","horsPipeline":"urgence","pipelineResume":"p-20261020T100000-abcdef"}
    ]}
    """.trimIndent()

    @Test fun parsesEntries() {
        val q = parseQueue(parseJsonOrNull(sample))
        assertTrue(q.busy)
        assertEquals(listOf("q-1", "q-2", "q-3"), q.entries.map { it.id })
        assertEquals("Faire A en entier", q.entries[0].text)
    }

    @Test fun detailFieldsLikeTheWebOverlay() {
        val q = parseQueue(parseJsonOrNull(sample))
        val f0 = q.entries[0].fields().toMap()
        assertEquals("claude-opus-5-5", f0["Model"])
        assertEquals("dev · leger", f0["Pipeline"])
        assertEquals("oui", f0["Session neuve"])
        assertEquals("chef", f0["Retour au"])
        assertEquals("2", f0["Modifications"])
        val f1 = q.entries[1].fields().toMap()
        assertEquals("index git partagé (règle git-index)", f1["En série"])
        assertEquals("#1", f1["Couloir"])
        assertEquals("gpt-5.5 (judge)", f1["Second model"])
        val f2 = q.entries[2].fields().toMap()
        assertEquals("urgence", f2["Hors pipeline"])
        assertEquals("p-20261020T100000-abcdef", f2["Reprise"])
    }

    @Test fun moveKeepsEveryIdOnce() {
        val ids = listOf("a", "b", "c", "d")
        assertEquals(listOf("b", "a", "c", "d"), moveId(ids, "b", -1))
        assertEquals(listOf("a", "c", "b", "d"), moveId(ids, "b", +1))
        assertEquals(ids, moveId(ids, "a", -1))
        assertEquals(ids, moveId(ids, "d", +1))
        assertEquals(ids, moveId(ids, "zz", +1))
    }

    @Test fun orderBody() {
        assertEquals("""{"ids":["b","a"]}""", queueOrderBody(listOf("b", "a")).toString())
    }

    @Test fun emptyQueue() {
        assertEquals(0, parseQueue(null).entries.size)
        assertNull(parseQueue(parseJsonOrNull("{}")).entries.firstOrNull())
    }
}
