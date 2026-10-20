package com.orchestrateur.ui.ops

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Shape of GET /api/regressions (server.js regressionView) and of a report (scripts/regression.mjs writeReport). */
class RegressionsModelTest {
    private val now = java.time.Instant.parse("2026-10-20T10:00:00Z").toEpochMilli()
    private val fixture = """
    {"now":$now,"running":1,"projects":[
      {"project":"orchestrateur-dev","running":[
         {"id":"r-1","status":"running","stage":"suites","label":"apres","mode":"targeted","lane":0,"startedAt":"2026-10-20T09:50:00.000Z",
          "suites":{"done":3,"total":10,"ko":1},"checks":{"done":1,"expected":10,"ko":0},"counts":null,"ko":["_test_a.mjs"],
          "launcher":{"by":"orchestrateur-dev"},"progress":"3/10 suites","report":"/api/regressions/orchestrateur-dev/report/r-1","reportFile":".regress/report-apres.json"}],
       "recent":[
         {"id":"r-0","status":"ok","mode":"full","startedAt":"2026-10-20T08:00:00.000Z","endedAt":"2026-10-20T08:40:00.000Z","durationS":2400,
          "counts":{"OK":120,"KO":0,"NA":3},"ko":[],"launcher":{"by":"chef"},"report":"/api/regressions/orchestrateur-dev/report/r-0"}]},
      {"project":"alpha","running":[],"recent":[
         {"id":"r-9","status":"ko","mode":"perimeter","startedAt":"2026-10-20T09:40:00.000Z","endedAt":"2026-10-20T09:55:00.000Z","durationS":900,
          "counts":{"OK":10,"KO":2,"NA":0},"ko":["x","y"],"launcher":{"by":"alpha"},"report":null}]},
      {"project":"beta","running":[],"recent":[
         {"id":"r-8","status":"interrupted","mode":"full","startedAt":"2026-10-20T07:00:00.000Z","endedAt":"2026-10-20T07:10:00.000Z","why":"processus mort"}]}
    ]}
    """.trimIndent()

    private fun data() = parseRegressions(Json.parseToJsonElement(fixture))

    @Test fun parsesProjectsAndRuns() {
        val d = data()
        assertEquals(3, d.size)
        val r = d[0].running[0]
        assertEquals("r-1", r.id)
        assertEquals(3, r.suitesDone)
        assertEquals(10, r.suitesTotal)
        assertEquals(10, r.checksExpected)
        assertEquals(listOf("_test_a.mjs"), r.ko)
        assertEquals("orchestrateur-dev", r.launcher)
        assertEquals(120, d[0].recent[0].counts!!.ok)
    }

    @Test fun titlesSummariesMarks() {
        val d = data()
        assertEquals("Non-régression ciblée en cours", regTitle(d[0].running[0]))
        assertEquals("Non-régression complète verte", regTitle(d[0].recent[0]))
        assertEquals("Non-régression par périmètre rouge", regTitle(d[1].recent[0]))
        assertEquals("étage suites · 3/10 suites", regSummary(d[0].running[0]))
        assertEquals("120 OK · 0 KO · 3 NA · 40 min", regSummary(d[0].recent[0]))
        assertEquals("processus mort", regSummary(d[2].recent[0]))
        assertEquals("🧪", regMark("running"))
        assertEquals("■", regMark("interrupted"))
        assertEquals(2, koCount(d[1].recent[0]))
        assertEquals(1, koCount(d[0].running[0]))
    }

    @Test fun progressPercent() {
        assertEquals(20, regPct(data()[0].running[0]))
        assertNull(regPct(data()[0].recent[0]))
    }

    @Test fun bandRowsKeepRunningAndRecentUnderTenMinutes() {
        val rows = regBandRows(data(), now)
        assertEquals(listOf("orchestrateur-dev" to "r-1", "alpha" to "r-9"), rows.map { it.first to it.second.id })
        // 20 minutes later the finished alpha run leaves the band
        assertEquals(listOf("r-1"), regBandRows(data(), now + 20 * 60_000).map { it.second.id })
    }

    @Test fun reportSummaryFromReportJson() {
        val rep = Json.parseToJsonElement("""
          {"label":"apres","at":"2026-10-20T09:00:00.000Z","durationS":600,"mode":"targeted","commit":"abc1234",
           "counts":{"OK":5,"KO":1,"NA":2},
           "results":[{"stage":"suite","id":"suite:a","name":"_test_a.mjs","status":"OK","detail":""},
                      {"stage":"http","id":"http:b","name":"route b","status":"KO","detail":"500 au lieu de 200"}]}
        """)
        val s = parseReport(rep)
        assertEquals("apres", s.label)
        assertEquals("targeted", s.mode)
        assertEquals(1, s.counts!!.ko)
        assertEquals(10, s.durationMin)
        assertEquals(listOf("[http] route b — 500 au lieu de 200"), s.koLines)
        assertEquals("rapport remplacé par un lancement plus récent", reportErrorText(410, "x"))
        assertEquals("rapport absent", reportErrorText(404, "rapport absent"))
    }

    @Test fun emptyJson() {
        assertTrue(parseRegressions(Json.parseToJsonElement("{}")).isEmpty())
    }
}
