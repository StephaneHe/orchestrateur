package com.orchestrateur.data

/**
 * 0.135.0 / app 1.1.2 — user report (2026-10-22): « a l'instant je ne vois dans
 * pilotage sur l'application : 1 en cours (Orchestrateur-dev) », then « après
 * avoir relancé l'application je vois bien les 2 tâches en cours ».
 *
 * Two causes, two rules:
 *  1. A pipeline run (and its resume) writes no `system/init` and no assistant
 *     event in the musician's log — only a sourced `user_prompt` and
 *     `system/pipeline_start`. The live reducer must open a turn on the SAME
 *     events as the server (TurnCore.isTurnStart / stateAtTurnStart).
 *  2. A missed live event (stream cut, phone asleep) must not freeze a card
 *     until the app restarts: the 5 s /api/pupitre snapshot corrects it
 *     (same rule as TurnCore.snapshotState, public/turn-core.js).
 */
object LiveStateRule {
    /** TurnCore.stateAtTurnStart: a new turn supersedes a pending question, an
     *  unread result or a failure. */
    fun stateAtTurnStart(s: State): State = when (s) {
        State.idle, State.unread, State.input, State.error -> State.live
        else -> s
    }

    private fun busy(s: State) = s == State.live || s == State.think

    /**
     * Next state given the server snapshot. Returns the state to adopt, or null
     * to keep the local one. `streak` is how many consecutive snapshots already
     * disagreed the same way (this one excluded).
     *  - server busy and it saw a turn opening newer than ours: adopt at once;
     *  - any other disagreement on busy / question / failure: adopt from the second
     *    snapshot in a row (the live stream may simply be a beat ahead);
     *  - unread vs idle (read marker) and live vs think: never touched.
     */
    fun fromSnapshot(local: State, server: State?, streak: Int, newerTurn: Boolean = false): State? {
        if (server == null || server == local) return null
        if (busy(server) && busy(local)) return null
        if (busy(server) && newerTurn) return server
        val meaningful = busy(server) || busy(local) || server == State.input || local == State.input || server == State.error
        if (!meaningful) return null
        return if (streak >= 1) server else null
    }

    fun parse(s: String?): State? = s?.let { runCatching { State.valueOf(it) }.getOrNull() }
}
