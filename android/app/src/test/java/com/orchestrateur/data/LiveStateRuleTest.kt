package com.orchestrateur.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** User report (2026-10-22): « a l'instant je ne vois dans pilotage sur
 *  l'application : 1 en cours (Orchestrateur-dev) » / « après avoir relancé
 *  l'application je vois bien les 2 tâches en cours ». */
class LiveStateRuleTest {
    private fun ev(type: String, subtype: String? = null, source: String? = null, result: String? = null) =
        RawEvent(type = type, subtype = subtype, source = source, result = result, timestamp = "2026-10-22T18:45:00Z")

    @Test
    fun pipelineRunStartIsLiveWithoutInit() {
        val m = Musician("psy")
        m.ingest(ev("user_prompt", source = "chef"))
        assertEquals(State.idle, m.state)          // a sourced prompt alone opens nothing
        m.ingest(ev("system", "pipeline_start"))
        assertEquals(State.live, m.state)
        m.ingest(ev("system", "pipeline_progress"))
        assertEquals(State.live, m.state)
        m.ingest(ev("result", "success", result = "fini"))
        assertEquals(State.unread, m.state)
    }

    @Test
    fun resumeAfterPauseLeavesTheQuestion() {
        val m = Musician("psy", initialState = State.input)
        m.ingest(ev("user_prompt"))                 // the user's answer
        assertEquals(State.live, m.state)
        val c = Musician("q", initialState = State.input)
        c.ingest(ev("system", "init"))              // a chef answer resumes with an init
        assertEquals(State.live, c.state)
        val e = Musician("e", initialState = State.error)
        e.ingest(ev("system", "pipeline_start"))
        assertEquals(State.live, e.state)
    }

    @Test
    fun snapshotCorrectsAMissedEvent() {
        // Missed start (the server saw a newer turn opening): adopted at once.
        assertEquals(State.live, LiveStateRule.fromSnapshot(State.idle, State.live, 0, newerTurn = true))
        assertEquals(State.live, LiveStateRule.fromSnapshot(State.input, State.live, 0, newerTurn = true))
        // A snapshot one beat behind the live result (same turn): not at once.
        assertNull(LiveStateRule.fromSnapshot(State.unread, State.live, 0))
        assertEquals(State.live, LiveStateRule.fromSnapshot(State.unread, State.live, 1))
        // Missed end: adopted from the second snapshot in a row only.
        assertNull(LiveStateRule.fromSnapshot(State.live, State.unread, 0))
        assertEquals(State.unread, LiveStateRule.fromSnapshot(State.live, State.unread, 1))
        assertEquals(State.input, LiveStateRule.fromSnapshot(State.idle, State.input, 1))
        // Never touched: same, live/think, unread/idle.
        assertNull(LiveStateRule.fromSnapshot(State.live, State.live, 5))
        assertNull(LiveStateRule.fromSnapshot(State.think, State.live, 5))
        assertNull(LiveStateRule.fromSnapshot(State.unread, State.idle, 5))
    }

    @Test
    fun musicianFollowsTheSnapshotAfterSleep() {
        val m = Musician("psy")
        m.applyPupitre(PupitreRow(name = "psy", state = "live", lastTurnStartAt = 1.0e12))
        assertEquals(State.live, m.state)            // turn started while asleep
        m.applyPupitre(PupitreRow(name = "psy", state = "unread"))
        assertEquals(State.live, m.state)            // one snapshot is not enough
        m.applyPupitre(PupitreRow(name = "psy", state = "unread"))
        assertEquals(State.unread, m.state)          // the end was missed: corrected
    }
}
