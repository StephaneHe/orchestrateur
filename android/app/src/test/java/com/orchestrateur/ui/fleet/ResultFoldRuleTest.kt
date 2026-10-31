package com.orchestrateur.ui.fleet

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * App 1.3.1 — a « RÉSULTAT REÇU » card addressed to the chef (NEEDS_CHEF_INPUT,
 * process pause) is a musician → chef exchange: folded by default.
 */
class ResultFoldRuleTest {

    private val processPause = "NEEDS_CHEF_INPUT: [p-20261031T101234-50b2f2 · pause 2] projetA — pause de PROCESSUS, " +
        "à trancher par toi. Cause : 6 tests sont faits (le maximum de l’exécution). Choix : continuer, livrer sans eux."

    private fun item(text: String, outcome: String = "done", awaiting: Boolean = false, summary: String = "") =
        ResultItem(source = "projetA", outcome = outcome, summary = summary, text = text,
            durationMs = 120_000, awaitingChef = awaiting)

    @Test fun needsChefInputCardIsFoldedByDefault() {
        assertTrue(ChatFoldRule.resultFolded(item(processPause)))
        assertTrue(ChatFoldRule.resultFolded(item("Travail fait.\n\nNEEDS_CHEF_INPUT: Y doit-il passer d'abord ?")))
    }

    @Test fun processPauseWithoutSentinelIsFolded() {
        assertTrue(ChatFoldRule.resultFolded(item("[p-20261031T101234-50b2f2 · pause 1] pause de PROCESSUS")))
    }

    @Test fun awaitingChefFlagOrOutcomeIsFolded() {
        assertTrue(ChatFoldRule.resultFolded(item("Rapport.", awaiting = true)))
        assertTrue(ChatFoldRule.resultFolded(item("Rapport.", outcome = "ask_chef")))
        assertTrue(ChatFoldRule.resultFolded(item("", summary = processPause)))
    }

    @Test fun ordinaryResultsStayOpen() {
        assertFalse(ChatFoldRule.resultFolded(item("Livré v1.2.0, tests verts.")))
        assertFalse(ChatFoldRule.resultFolded(item("Échec : suite rouge.", outcome = "failed")))
        // A mention in prose is not the sentinel.
        assertFalse(ChatFoldRule.resultFolded(item("La ligne NEEDS_CHEF_INPUT: est détectée par le pump.")))
    }
}
