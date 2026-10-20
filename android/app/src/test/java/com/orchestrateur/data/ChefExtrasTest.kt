package com.orchestrateur.data

import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Android 1.0.0 — chef thread parity: direction queue, every pipeline of the engine, speech text, text size. */
class ChefExtrasTest {
    private val pool = """
    {"size":2,"model":"claude-opus-5-5",
     "slots":[{"slot":1,"name":"chef","state":"live","pidAlive":true,"ticket":{"id":"T1","class":"user","head":"fais X","state":"running"}},
              {"slot":2,"name":"chef-2","state":"idle","pidAlive":false,"ticket":null}],
     "queue":[{"id":"T2","class":"user","head":"et Y","source":null,"position":1,"enqueuedAt":"2026-10-20T10:00:00Z","interrupting":false},
              {"id":"T3","class":"point","head":"point","position":2,"interrupting":true}]}
    """.trimIndent()

    @Test fun poolBand() {
        val p = parsePool(parseJsonOrNull(pool))
        assertEquals(2, p.size)
        assertEquals(1, p.free)
        assertEquals(listOf("T2", "T3"), p.queue.map { it.id })
        assertTrue(p.queue[1].interrupting)
        assertEquals("⏳ File de direction · 2 messages en attente · 1 libre", p.headline())
        assertEquals(1, p.busySlots().first().slot)
        assertEquals("T1", p.busySlots().first().ticketId)
    }

    @Test fun emptyPool() {
        val p = parsePool(null)
        assertEquals(0, p.queue.size)
        assertNull(p.headline())
    }

    @Test fun everyEnginePipelineIsSelectable() {
        val wanted = listOf("discussion", "dev", "incident", "recherche", "audit", "maintenance", "nouveau",
            "donnees", "redaction", "reunion", "images", "video", "audio")
        val offered = PipelineChoice.entries.mapNotNull { it.pipeline }.toSet()
        wanted.forEach { assertTrue("pipeline $it missing", it in offered) }
        assertFalse("routage is the chef's own pipeline", "routage" in offered)
    }

    @Test fun chefDiscussionIsATextPrefix() {
        val p = dispatchPayload("chef", "on en parle ?", choice = PipelineChoice.CHEF_DISCUSSION)
        assertEquals("/chef-discussion on en parle ?", p["prompt"]!!.jsonPrimitive.content)
        assertFalse(p.containsKey("pipeline"))
        val q = dispatchPayload("chef", "/chef-discussion déjà", choice = PipelineChoice.CHEF_DISCUSSION)
        assertEquals("/chef-discussion déjà", q["prompt"]!!.jsonPrimitive.content)
    }

    @Test fun extraPipelinesTravelInThePayload() {
        val p = dispatchPayload("chef", "audite", choice = PipelineChoice.AUDIT)
        assertEquals("audit", p["pipeline"]!!.jsonPrimitive.content)
    }

    @Test fun speechTextNeverReadsCodeOrMarkup() {
        val t = SpeechText.toSpeech("## Bilan\n**Suite verte** voir [la doc](https://ex.com/a) et `x`\n```js\nalert(1)\n```\n<script>bad()</script>[[t-1a2b3c]] dans I:/Dev/projet/src/app.kt commit 3e3b51b0a1c2d3e4f5")
        assertFalse(t.contains("alert"))
        assertFalse(t.contains("bad()"))
        assertFalse(t.contains("**"))
        assertTrue(t.contains("bloc de code"))
        assertTrue(t.contains("la doc"))
        assertTrue(t.contains("t-1a2b3c"))
        assertTrue(t.contains("app.kt"))
        assertTrue(t.contains("identifiant"))
    }

    @Test fun speechChunksStayShort() {
        val long = (1..40).joinToString(" ") { "Phrase numéro $it." }
        val parts = SpeechText.chunks(long, 220)
        assertTrue(parts.all { it.length <= 220 })
        assertEquals(long.replace(" ", ""), parts.joinToString("").replace(" ", ""))
    }

    @Test fun textScaleSteps() {
        assertEquals(1.1f, TextScale.bigger(1f))
        assertEquals(0.9f, TextScale.smaller(1f))
        assertEquals(1.5f, TextScale.bigger(1.5f))
        assertEquals(0.85f, TextScale.smaller(0.85f))
        assertEquals(1.25f, TextScale.clamp(1.3f))
        assertEquals("110 %", TextScale.label(1.1f))
    }

    @Test fun restReaders() {
        val j = parseJsonOrNull("""{"a":{"b":"x","n":3,"f":1.5,"t":true,"l":["u","v",1]},"z":null}""")
        assertEquals("x", j.o("a").s("b"))
        assertEquals(3, j.o("a").i("n"))
        assertEquals(1.5, j.o("a").d("f")!!, 0.0)
        assertTrue(j.o("a").b("t"))
        assertEquals(listOf("u", "v", "1"), j.o("a").strs("l"))
        assertNull(j.o("z"))
        assertNull(j.s("missing"))
        assertEquals("erreur 404", RestResult(404, null, "").errorText())
        assertEquals("nope", RestResult(409, parseJsonOrNull("""{"error":"nope"}"""), "").errorText())
        assertEquals("a%20b%2Fc", enc("a b/c"))
    }
}
