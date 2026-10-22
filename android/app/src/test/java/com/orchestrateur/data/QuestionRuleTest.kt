package com.orchestrateur.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// User requirement 2026-10-22: « [projet] est toujours marqué avec "votre réponse attendue" ».
class QuestionRuleTest {
    @Test
    fun questionStaysOpenUntilAnewTurnOrAResolution() {
        assertTrue(QuestionRule.isOpen(1_000L, null))
        assertTrue(QuestionRule.isOpen(1_000L, 500L))          // the turn that asked
        assertFalse(QuestionRule.isOpen(1_000L, 2_000L))       // resumed after the question
        assertFalse(QuestionRule.isOpen(1_000L, null, 1_500L)) // marked answered
        assertTrue(QuestionRule.isOpen(null, 2_000L))          // no evidence: keep asking
    }

    @Test
    fun turnStartsAreTheServerOnes() {
        assertTrue(QuestionRule.isTurnStart("user_prompt", null, null))
        assertFalse(QuestionRule.isTurnStart("user_prompt", null, "chef"))
        assertTrue(QuestionRule.isTurnStart("system", "pipeline_start", "chef"))
        assertTrue(QuestionRule.isTurnStart("system", "init", null))
        assertFalse(QuestionRule.isTurnStart("system", "pipeline_progress", null))
    }

    @Test
    fun musicianRemembersTheLatestTurnStart() {
        val m = Musician("psy")
        m.noteTurnStart(2_000L)
        m.noteTurnStart(1_000L)
        assertTrue(m.lastTurnStartMs == 2_000L)
        assertFalse(QuestionRule.isOpen(1_500L, m.lastTurnStartMs))
    }
}
