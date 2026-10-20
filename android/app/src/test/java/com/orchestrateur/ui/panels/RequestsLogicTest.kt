package com.orchestrateur.ui.panels

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** Same shape as GET /api/requests (scripts/request-map.mjs buildRequest / listRequests). */
private const val REQUESTS = """
{"ok":true,"states":{},"requests":[
 {"run":"p-20261014T091500-abc123","createdAt":"2026-10-14T07:15:00.000Z","routageStatus":"done","origin":"utilisateur",
  "request":"Fais A puis B","requestHead":"Fais A puis B","sens":"deux tâches liées","nature":"taches","aucunDispatch":null,
  "questions":["Quel projet pour C ?"],"open":2,"total":3,
  "tasks":[
   {"n":1,"projet":"alpha","titre":"Faire A","demande":"Fais **A**","apres":null,"pipeline":"dev","mode":"leger","state":"en_cours","stateLabel":"en cours","tone":"live","detail":"pipeline dev : 2/5 étapes","level":0,
    "pipelineRun":{"run":"p-20261014T091600-def456","pipeline":"dev","mode":"leger","status":"running","steps":5,"done":2,"current":"vert"},"launchedAt":"2026-10-14T07:16:00.000Z","since":"2026-10-14T07:16:05.000Z"},
   {"n":2,"projet":"beta","titre":"Faire B","demande":"Fais B","apres":1,"pipeline":null,"mode":null,"state":"attente","stateLabel":"en attente d’une autre tâche","tone":"wait","detail":"attend la fin de la tâche 1 (alpha)","level":1,"pendingId":"r-1234","raison":"code"},
   {"n":3,"projet":"gamma","titre":"Faire C","demande":"Fais C","apres":1,"state":"terminee","stateLabel":"terminée","tone":"ok","detail":"fait","level":1,"released":true,"launchedAt":"2026-10-14T08:00:00.000Z","endedAt":"2026-10-14T08:30:00.000Z","excerpt":"Résultat **ok**","rattache":"suite de A","reprise":"p-20261013T000000-aaaaaa"}
  ]},
 {"run":"p-20261014T080000-bbb111","createdAt":"2026-10-13T08:00:00.000Z","routageStatus":"done","origin":"relais","request":"[CALLBACK_WAKE] x","requestHead":"[CALLBACK_WAKE] x","sens":null,"nature":"reponse","questions":[],"open":0,"total":0,"tasks":[]},
 {"run":"p-20261014T070000-ccc222","createdAt":"2026-10-13T07:00:00.000Z","routageStatus":"running","origin":"utilisateur","request":"Bonjour","requestHead":"Bonjour","sens":null,"nature":null,"questions":[],"open":0,"total":0,"tasks":[]}
]}
"""

class RequestsLogicTest {
    private val reqs = parseRequests(Json.parseToJsonElement(REQUESTS))
    private val paris = ZoneId.of("Europe/Paris")

    @Test fun parsesRequestsAndTasks() {
        assertEquals(3, reqs.size)
        val q = reqs[0]
        assertEquals(3, q.tasks.size)
        assertEquals(5, q.tasks[0].pipelineRun!!.steps)
        assertEquals(1, q.tasks[1].apres)
        assertEquals(true, q.tasks[2].released)
        assertEquals("Résultat **ok**", q.tasks[2].excerpt)
    }

    @Test fun defaultShowsOnlyUserRequestsWithTasks() {
        assertEquals(listOf("p-20261014T091500-abc123"), visibleRequests(reqs, false).map { it.run })
        assertEquals(3, visibleRequests(reqs, true).size)
        assertEquals("2 requêtes sans tâche ou relayées masquées — cocher « tout afficher ».", hiddenText(2))
        assertEquals("1 requête sans tâche ou relayée masquée — cocher « tout afficher ».", hiddenText(1))
        assertNull(hiddenText(0))
        assertEquals("Aucune requête découpée en tâches parmi les 3 dernières.", noneText(3))
    }

    @Test fun headMetaAndSummaryByTone() {
        val q = reqs[0]
        assertEquals("découpée · 3 tâches", requestMeta(q))
        assertEquals(listOf("1 terminée" to "ok", "1 en cours" to "live", "1 en attente" to "wait"), toneSummary(q))
        assertEquals("Routage en cours", requestMeta(reqs[2]))
    }

    @Test fun columnsByLevelAndWhyNoTask() {
        val cols = columns(reqs[0])
        assertEquals(listOf(listOf(1), listOf(2, 3)), cols.map { c -> c.map { it.n } })
        assertEquals("réponse du chef, sans tâche", whyNoTask(reqs[1]))
        assertEquals("découpage en cours…", whyNoTask(reqs[2]))
        assertEquals("question posée : Quel projet pour C ?", whyNoTask(reqs[0].copy(tasks = emptyList())))
    }

    @Test fun iconsProgressAndTimes() {
        assertEquals("▶", stateIcon("en_cours"))
        assertEquals("·", stateIcon("inconnu"))
        val t = reqs[0].tasks[0]
        assertEquals(40, progressPct(t.pipelineRun!!))
        assertEquals("2/5 · vert", progressText(t.pipelineRun!!))
        val now = Instant.parse("2026-10-14T12:00:00Z")
        assertEquals("09:15", whenText("2026-10-14T07:15:00.000Z", now, paris))
        assertEquals("13/10 10:00", whenText("2026-10-13T08:00:00.000Z", now, paris))
        assertEquals("", whenText(null, now, paris))
    }

    @Test fun detailRowsLikeTheWebDialog() {
        val now = Instant.parse("2026-10-14T12:00:00Z")
        val q = reqs[0]
        assertEquals("découpée · p-20261014T091500-abc123 · 3 tâches dont 2 pas encore finies", detailMeta(q))
        val r1 = taskRows(q.tasks[0], now, paris).toMap()
        assertEquals("en cours — pipeline dev : 2/5 étapes", r1["État"])
        assertEquals("alpha", r1["Musicien"])
        assertEquals("dev (leger)", r1["Pipeline"])
        assertEquals("p-20261014T091600-def456 — en cours, 2/5 étapes, « vert »", r1["Exécution"])
        assertEquals("09:16", r1["Lancée"])
        assertEquals("09:16", r1["Commencée"])
        val r2 = taskRows(q.tasks[1], now, paris).toMap()
        assertEquals("tâche 1", r2["Après"])
        assertEquals("entrée r-1234 de la liste des tâches en attente", r2["En attente"])
        assertEquals("code", r2["Classement"])
        val r3 = taskRows(q.tasks[2], now, paris).toMap()
        assertEquals("10:00 (libérée à la fin de la tâche attendue)", r3["Lancée"])
        assertEquals("10:30", r3["Finie"])
        assertEquals("suite de A", r3["Rattachée à"])
        assertEquals("p-20261013T000000-aaaaaa", r3["Reprise de"])
        assertNull(r3["Pipeline"])
    }
}
