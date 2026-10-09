package com.orchestrateur.data

import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** User requirement (2026-10-09, pipelines phase 5): the app's composer can choose the pipeline. */
class PipelineChoiceTest {
    @Test fun autoSendsNoPipeline() {
        val p = dispatchPayload("chef", "bonjour")
        assertFalse(p.containsKey("pipeline"))
        assertFalse(p.containsKey("pipelineMode"))
    }

    @Test fun explicitChoiceTravelsInThePayload() {
        val p = dispatchPayload("chef", "ajoute un bouton", choice = PipelineChoice.DEV_COMPLET)
        assertEquals("dev", p["pipeline"]!!.jsonPrimitive.content)
        assertEquals("complet", p["pipelineMode"]!!.jsonPrimitive.content)
        val d = dispatchPayload("chef", "pourquoi ?", choice = PipelineChoice.DISCUSSION)
        assertEquals("discussion", d["pipeline"]!!.jsonPrimitive.content)
        assertFalse(d.containsKey("pipelineMode"))
    }

    @Test fun tapCyclesThroughEveryChoice() {
        var c = PipelineChoice.AUTO
        val seen = mutableListOf<PipelineChoice>()
        repeat(4) { c = c.next(); seen += c }
        assertEquals(listOf(PipelineChoice.DISCUSSION, PipelineChoice.DEV_LEGER, PipelineChoice.DEV_COMPLET, PipelineChoice.AUTO), seen)
    }
}
