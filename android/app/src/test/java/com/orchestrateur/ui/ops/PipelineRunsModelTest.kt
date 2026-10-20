package com.orchestrateur.ui.ops

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Shape of GET /api/pipeline-runs (scripts/pipeline-run-view.mjs runView + pauseView). */
class PipelineRunsModelTest {
    private val fixture = """
    {"ok":true,"runs":[
      {"run":"p-20261020T100000-abcd","project":"alpha","pipeline":"dev","mode":"complet","kind":"simple","status":"paused",
       "createdAt":"2026-10-20T10:00:00.000Z","endedAt":null,"question":"Le test passe déjà : que faire ?","backoff":null,
       "steps":[{"id":"comprendre","key":"01-comprendre","title":"Comprendre","slot":"dev.comprendre","model":"claude-opus-5-5","served":"claude-opus-5-5","status":"ok","why":null,"durationMs":65000},
                {"id":"rouge","key":"02-rouge","title":"Test rouge","slot":"dev.rouge","model":"gpt-5.5","served":null,"status":"refused","why":"le test passe d'emblée","durationMs":1200},
                {"id":"refactor","key":"03-refactor","title":"Refactor","slot":"dev.refactor","status":"skipped","why":"moins de 10 lignes"}],
       "pause":{"cause":"Le test écrit passe déjà sur le code actuel.","kind":"test_passes","transient":false,"step":"rouge","limit":"criteria",
         "options":[{"key":"corriger le test","does":"je relance avec la consigne…","recommended":true},
                    {"key":"accepter","does":"je livre avec les défauts","recommended":false},
                    {"key":"abandonner","does":"j’arrête","recommended":false}],
         "recommend":{"key":"corriger le test","why":"c'est la cause"}}},
      {"run":"p-20261020T090000-bbbb","project":"beta","pipeline":"discussion","mode":null,"status":"running","createdAt":"2026-10-20T09:00:00.000Z",
       "backoff":{"step":"lire","slot":"discussion.lire","model":"kimi","provider":"nvidia","tier":2,"maxTiers":6,"waitMs":20000,"until":"2026-10-20T09:05:00.000Z","failures":4},
       "steps":[{"id":"lire","key":"01-lire","title":"Lire","status":"running"}],"pause":null},
      {"run":"p-20261019T090000-cccc","project":"chef","pipeline":"routage","mode":"demande","status":"paused","createdAt":"2026-10-19T09:00:00.000Z","steps":[],"pause":null},
      {"run":"p-20261018T090000-dddd","project":"alpha","pipeline":"dev","mode":"leger","status":"done","createdAt":"2026-10-18T09:00:00.000Z","endedAt":"2026-10-18T09:30:00.000Z","steps":[]}
    ]}
    """.trimIndent()

    private fun runs() = parseRuns(Json.parseToJsonElement(fixture))

    @Test fun parsesRunsStepsAndPause() {
        val r = runs()
        assertEquals(4, r.size)
        val a = r[0]
        assertEquals("p-20261020T100000-abcd", a.run)
        assertEquals("dev", a.pipeline)
        assertEquals("complet", a.mode)
        assertEquals(3, a.steps.size)
        assertEquals("gpt-5.5", a.steps[1].model)
        assertEquals("le test passe d'emblée", a.steps[1].why)
        assertEquals(65000L, a.steps[0].durationMs)
        val p = a.pause!!
        assertEquals("Le test écrit passe déjà sur le code actuel.", p.cause)
        assertEquals(3, p.options.size)
        assertTrue(p.options[0].recommended)
        assertEquals("corriger le test", p.recommendKey)
        assertEquals("c'est la cause", p.recommendWhy)
        assertNull(r[1].pause)
        assertEquals(2, r[1].backoff!!.tier)
        assertEquals("discussion.lire", r[1].backoff!!.slot)
    }

    @Test fun stepMarks() {
        assertEquals("✓", stepMark("ok"))
        assertEquals("✕ refusé", stepMark("refused"))
        assertEquals("● en cours", stepMark("running"))
        assertEquals("↷ sautée", stepMark("skipped"))
        assertEquals("⏸ model indisponible", stepMark("model_unavailable"))
        assertEquals("pending", stepMark("pending"))
    }

    @Test fun statusAndDurationTexts() {
        assertEquals("⏸ en pause", runStatusText("paused"))
        assertEquals("● en cours", runStatusText("running"))
        assertEquals("✓ terminée", runStatusText("done"))
        assertEquals("1 min 05 s", durationText(65_000))
        assertEquals("1,2 s", durationText(1_200))
        assertEquals("", durationText(null))
        assertEquals("dev · complet", runTitle(runs()[0]))
        assertEquals("discussion", runTitle(runs()[1]))
    }

    @Test fun servedModelShownOnlyWhenDifferent() {
        val s = runs()[0].steps
        assertEquals("claude-opus-5-5", modelText(s[0]))
        assertEquals("gpt-5.5", modelText(s[1]))
        assertEquals("a → servi b", modelText(StepView("x", "x", null, "a", "b", "ok", null, null)))
        assertEquals("", modelText(s[2]))
    }

    @Test fun pauseReplyForAMusicianTargetsTheRun() {
        val r = runs()[0]
        val b = pauseReplyBody(r, "corriger le test", conductor = "chef")
        assertEquals("alpha", b["project"]!!.jsonPrimitive.content)
        assertEquals("corriger le test p-20261020T100000-abcd", b["prompt"]!!.jsonPrimitive.content)
        assertEquals("p-20261020T100000-abcd", b["pipelineResume"]!!.jsonPrimitive.content)
    }

    @Test fun acceptAndDeleteDoubtsAreNotSentWithPipelineResume() {
        // dispatch.mjs applies « accepter » / « tout supprimer » only on the bare
        // reply path (latest paused run); with --pipeline-resume they would only resume.
        val r = runs()[0]
        val a = pauseReplyBody(r, "accepter", conductor = "chef")
        assertEquals("accepter p-20261020T100000-abcd", a["prompt"]!!.jsonPrimitive.content)
        assertFalse(a.containsKey("pipelineResume"))
        assertFalse(pauseReplyBody(r, "tout supprimer", conductor = "chef").containsKey("pipelineResume"))
    }

    @Test fun pauseReplyForTheChefCitesTheRunOnly() {
        val chefRun = runs()[2]
        val b = pauseReplyBody(chefRun, "continuer", conductor = "chef")
        assertEquals("chef", b["project"]!!.jsonPrimitive.content)
        assertEquals("continuer p-20261019T090000-cccc", b["prompt"]!!.jsonPrimitive.content)
        assertFalse(b.containsKey("pipelineResume"))
    }

    @Test fun latestPausedRunWithAPause() {
        assertEquals("p-20261020T100000-abcd", latestPausedWithMenu(runs())?.run)
        assertNull(latestPausedWithMenu(runs().drop(1)))
        // a newer paused run without menu hides an older one: never offer stale choices
        val newer = runs()[2].copy(project = "alpha", run = "p-20261021T090000-eeee")
        assertNull(latestPausedWithMenu(listOf(newer) + runs()))
    }

    @Test fun backoffTextAndBody() {
        val b = runs()[1].backoff!!
        assertEquals("Attente après des erreurs de lancement : palier 2/6, 4 échecs, model kimi (case discussion.lire).", backoffText(b))
        assertEquals("retry", backoffBody("retry")["action"]!!.jsonPrimitive.content)
    }

    @Test fun projectFilterPath() {
        assertEquals("/api/pipeline-runs?n=40", runsPath(null, 40))
        assertEquals("/api/pipeline-runs?n=10&project=mon%20projet", runsPath("mon projet", 10))
    }

    @Test fun emptyResponse() {
        assertTrue(parseRuns(Json.parseToJsonElement("{}")).isEmpty())
    }
}
