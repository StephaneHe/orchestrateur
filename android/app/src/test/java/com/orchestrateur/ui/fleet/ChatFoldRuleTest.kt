package com.orchestrateur.ui.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * App 1.3.0 — only the user ↔ chef dialogue stays open in the chef thread;
 * technical messages fold on one line. Fixtures are real messages taken from
 * the chef's log (2026-10-29 → 31), project names anonymised.
 */
class ChatFoldRuleTest {

    // ── Real messages received by the chef ──────────────────────────────────

    private val needsChef = "[NEEDS_CHEF_INPUT_FROM:projetA] Le musicien « projetA » te demande une décision :\n\n" +
        "[p-20261031T101234-50b2f2 · pause 1] projetA — pause de PROCESSUS, à trancher par toi (règle de l’utilisateur : " +
        "ne plus lui poser ces questions d’organisation du travail). Cause : 6 tests sont faits (le maximum de l’exécution)."

    private val alert = "[ALERTE n=1]\nLe serveur signale un événement qui peut demander ton intervention (chaque événement n’est signalé qu’une fois).\n" +
        "Pour chacun : vérifie d’abord si un musicien le traite déjà (tour en cours, relance, file d’attente). Si oui, ne fais rien de plus que le noter.\n\n" +
        "1. ✕ Non-régression terminée KO — orchestrateur-dev · r-20261031T034418-77264 · mode targeted · fin 2026-10-31T03:51:15.022Z\n" +
        "   KO : suite:_test_pipeline_speed.mjs\n"

    private val pauseNotice = "[p-20261029T192619-cf191e · pause 1] ⏳ Ta réponse à la pause de processus n° 1 de orchestrateur-dev " +
        "(exécution p-20261029T192619-cf191e) est appliquée et attend en file (entrée q-1793302314456-76fd) depuis 3 min : le musicien a un tour en cours."

    private val repriseRelay = "[REPRISE] Ton tour précédent a été perdu (processus perdu) ; vérifie l'état réel avant d'agir.\n\n" + needsChef

    private val repriseUser = "[REPRISE] Ton tour précédent a été perdu (processus perdu) ; vérifie l'état réel avant d'agir.\n\n" +
        "est-ce que la version 1.2.1 est installée ?"

    private val wake = "[CALLBACK_WAKE gen=1] 2 résultat(s) de musiciens à rapporter."

    // ── Real messages typed by the user ─────────────────────────────────────

    private val userMessages = listOf(
        "Je vois l'image sur le client web, mais pas sur l'app",
        "utilises l'icone pour l'app",
        "app Orchestrateur: je ne veux pas voir les messages techniques entre musiciens et le chef.",
        "[p-20261030T061614-209f22] où en est cette exécution ?",
    )

    // ── Real chef replies ───────────────────────────────────────────────────

    private val answer = "[ANSWER] livrer sans eux — les éléments 1 et 2 (valeur perçue = référence + dérive + compensation, " +
        "et sens de correction) sont déjà repris en tête de file dans la tâche dédiée au cœur de la mécanique."

    private val reportAfterWake = "La mécanique de projetA est terminée : version 1.3.0, livrée en 17 minutes ([[commit:fbf0e32]]).\n\n" +
        "- **Le principe :** ce que tu vois ou entends correspond à la référence."

    private val chefQuestion = "Deux options pour l'icône.\n\nNEEDS_USER_INPUT: laquelle préfères-tu, A ou B ?"

    @Test fun userTypedMessagesStayOpen() {
        for (m in userMessages) assertNull(m, ChatFoldRule.forUser(m))
        assertNull(ChatFoldRule.forUser(repriseUser))
        assertNull("@shortcut is the user's own message", ChatFoldRule.forUser("@projetA relance", "shortcut→projetA"))
    }

    @Test fun relayFromMusicianFolds() {
        val f = ChatFoldRule.forUser(needsChef)!!
        assertEquals("question de projetA", f.type)
        assertTrue(f.summary, f.summary.startsWith("[p-20261031T101234-50b2f2 · pause 1] projetA — pause de PROCESSUS"))
        assertTrue(f.summary.length <= 110)
    }

    @Test fun alertFoldsWithItsEventLine() {
        val f = ChatFoldRule.forUser(alert)!!
        assertEquals("alerte", f.type)
        assertTrue(f.summary, f.summary.startsWith("✕ Non-régression terminée KO — orchestrateur-dev"))
    }

    @Test fun pauseNoticeWakeAndRepriseFold() {
        val n = ChatFoldRule.forUser(pauseNotice)!!
        assertEquals("réponse à la pause", n.type)
        assertTrue(n.summary, n.summary.startsWith("⏳ Ta réponse à la pause"))
        assertEquals("réveil", ChatFoldRule.forUser(wake)!!.type)
        assertEquals("question de projetA (reprise)", ChatFoldRule.forUser(repriseRelay)!!.type)
        assertEquals("reprise", ChatFoldRule.forUser("[REPRISE] Ton tour précédent a été perdu.")!!.type)
        assertEquals("réponse à la pause", ChatFoldRule.forUser("⚠ Ta réponse à la pause n° 2 n'a pas été appliquée.")!!.type)
    }

    @Test fun sourceDecidesBeforePrefixes() {
        val defect = "[DÉFAUT — projetA — p-20261029T155621-3df10c] ⚑ 2 défaut(s) détecté(s) — projetA"
        assertEquals("défaut", ChatFoldRule.forUser(defect, "pipeline-defect")!!.type)
        assertEquals("autorisation", ChatFoldRule.forUser("[AUTORISATION EN ATTENTE] projetA attend…", "permission")!!.type)
        assertEquals("message de projetA", ChatFoldRule.forUser("## Compte rendu\nfait", "projetA")!!.type)
        assertEquals("réveil", ChatFoldRule.forUser("anything", "wake")!!.type)
    }

    @Test fun onlyAnswerRepliesOfTheChefFold() {
        val f = ChatFoldRule.forConductor(answer)!!
        assertEquals("réponse au musicien", f.type)
        assertTrue(f.summary, f.summary.startsWith("livrer sans eux"))
        assertNull("report written for the user after a wake stays open", ChatFoldRule.forConductor(reportAfterWake))
        assertNull(ChatFoldRule.forConductor(chefQuestion))
        assertNull("[ANSWER] quoted mid-text is not the protocol prefix", ChatFoldRule.forConductor("Le musicien attend un [ANSWER] de ma part."))
    }

    @Test fun summaryIsOneLineAndBounded() {
        assertEquals("a b", ChatFoldRule.summarize("\n\n  a   b \nsuite"))
        val long = ChatFoldRule.summarize("x".repeat(300))
        assertEquals(110, long.length)
        assertTrue(long.endsWith("…"))
    }
}
