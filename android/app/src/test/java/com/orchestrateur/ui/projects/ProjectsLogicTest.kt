package com.orchestrateur.ui.projects

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of public/projets.js (Vue « Projets », 0.29.0) and Salle.healthFlag / alarming (0.47.2). */
class ProjectsLogicTest {
    private val now = 1_800_000_000_000L

    private val pupitre = """
    {"now": $now, "conductor": "chef", "fleet": [
      {"name":"chef","state":"idle","isConductor":true,"queueDepth":0,"model":"claude-opus-5-5-20260101",
       "lastActivityAt": ${now - 120_000},"lastActivitySource":"event"},
      {"name":"alpha","state":"input","needsInput":"Tailwind ou **MUI** ?","queueDepth":2,"callbackTo":"chef",
       "configModel":"claude-sonnet-5","lastActivityAt": ${now - 30_000},"lastActivitySource":"mtime",
       "version":{"value":"1.2.3","source":"package.json"},"build":{"apkAt": ${now - 7_200_000}},
       "lastTurn":{"durationMs":65000,"costUsd":0.4321,"subtype":"success"}},
      {"name":"beta","state":"live","pid":12,"pidAlive":false,"deadInFlight":true,"turnElapsedMs":61000,"activity":"Bash npm test"},
      {"name":"gamma","state":"error","stopped":{"by":"supervision","reason":"bloqué"}},
      {"name":"delta","state":"live","stalled":true,"silentMs":700000,"activity":"lecture"},
      {"name":"eps","state":"live","testRun":{"label":"essai A"},"stalled":true,"silentMs":5000},
      {"name":"zeta","state":"think","activity":"(réflexion…)","turnElapsedMs":5000},
      {"name":"eta","state":"unread","awaitingChef":true},
      {"name":"theta","state":"idle","queueDepth":1},
      {"name":"iota","state":"unread","lastActivityAt": ${now - 10_000}},
      {"name":"kappa","state":"error","lastTurn":{"subtype":"error_max_turns"}},
      {"name":"lambda","state":"idle","questionResolved":{"note":"vu avec le chef"}}
    ], "ui": {"projectsView": true}}
    """.trimIndent()

    private val config = """
    {"conductor":"chef","projects":[
      {"name":"lambda","lastLine":"ancienne question","currentState":"idle"},
      {"name":"iota","lastLine":"**Livré** la v2","currentState":"unread"}
    ]}
    """.trimIndent()

    private fun rows() = mergeConfig(parsePupitre(Json.parseToJsonElement(pupitre)).rows, Json.parseToJsonElement(config))
    private fun row(n: String) = rows().first { it.name == n }

    @Test fun parsesPupitreRows() {
        val snap = parsePupitre(Json.parseToJsonElement(pupitre))
        assertEquals("chef", snap.conductor)
        assertEquals(12, snap.rows.size)
        val a = snap.rows.first { it.name == "alpha" }
        assertEquals(2, a.queueDepth)
        assertEquals("1.2.3", a.version)
        assertEquals(now - 7_200_000, a.apkAt)
        assertEquals(65000L, a.lastTurn?.durationMs)
        assertEquals("supervision", snap.rows.first { it.name == "gamma" }.stopped?.by)
        assertEquals("essai A", snap.rows.first { it.name == "eps" }.testLabel)
        assertTrue(snap.rows.first { it.name == "lambda" }.questionResolved)
    }

    @Test fun classifiesEveryKindLikeTheWeb() {
        val k = rows().associate { it.name to describe(it).kind }
        assertEquals(Kind.IDLE, k["chef"])
        assertEquals(Kind.QUESTION, k["alpha"])
        assertEquals(Kind.DEAD, k["beta"])
        assertEquals(Kind.STOPPED, k["gamma"])
        assertEquals(Kind.STALL, k["delta"])
        assertEquals(Kind.TEST, k["eps"])
        assertEquals(Kind.THINK, k["zeta"])
        assertEquals(Kind.CHEF, k["eta"])
        assertEquals(Kind.QUEUED, k["theta"])
        assertEquals(Kind.UNREAD, k["iota"])
        assertEquals(Kind.ERROR, k["kappa"])
    }

    @Test fun wordsAndStopAuthor() {
        assertEquals("Votre réponse attendue", describe(row("alpha")).word)
        assertEquals("Arrêté par la supervision", describe(row("gamma")).word)
        assertEquals("Arrêté par le chef", stopWord(StopInfo("chef", "")))
        assertEquals("Arrêté (essai)", stopWord(StopInfo("test", "")))
        assertEquals("Arrêté par bob", stopWord(StopInfo("bob", "")))
        assertEquals("Processus perdu", describe(row("beta")).word)
        assertEquals("Prêt", describe(row("chef")).word)
        assertEquals("Terminé · non lu", describe(row("iota")).word)
    }

    @Test fun redOnlyForRealIncidents() {
        assertTrue(alarming(row("beta")))
        assertTrue(alarming(row("delta")))
        assertFalse(alarming(row("eps")))           // test run: neutral even when silent
        assertFalse(alarming(row("gamma")))         // volunteer stop
        assertEquals(Tone.NEUTRAL, toneOf(Kind.STOPPED))
        assertEquals(Tone.NEUTRAL, toneOf(Kind.TEST))
        assertEquals(Tone.ALARM, toneOf(Kind.DEAD))
        assertEquals(Tone.ALARM, toneOf(Kind.STALL))
        val perm = ProjectRow(name = "p", state = "live", awaitingPermission = true, awaitingPermissionTool = "Bash", stalled = true)
        assertEquals("perm", healthFlag(perm)?.kind)
        assertFalse(alarming(perm))
    }

    @Test fun linesStripMarkdownAndSentinels() {
        assertEquals("Tailwind ou MUI ?", lineOf(row("alpha"), Kind.QUESTION))
        assertEquals("le tour n'a plus de processus · Bash npm test", lineOf(row("beta"), Kind.DEAD))
        assertEquals("error_max_turns", lineOf(row("kappa"), Kind.ERROR))
        assertEquals("essai A · 🧪 test en cours — silence 5s", lineOf(row("eps"), Kind.TEST))
        assertEquals("réflexion…", lineOf(row("zeta"), Kind.THINK))
        assertEquals("1 tâche en file, démarrage à la fin du tour", lineOf(row("theta"), Kind.QUEUED))
        assertEquals("décision demandée au chef", lineOf(row("eta"), Kind.CHEF))
        assertEquals("Livré la v2", lineOf(row("iota"), Kind.UNREAD))
        assertEquals("✓ question marquée répondue — vu avec le chef", lineOf(row("lambda"), Kind.IDLE))
    }

    @Test fun agesWithTildeForMtime() {
        assertEquals("~ à l'instant", ageOf(row("alpha"), Kind.QUESTION, now).text)
        val old = row("alpha").copy(lastActivityAt = now - 600_000)
        assertEquals("~ il y a 10 min", ageOf(old, Kind.QUESTION, now).text)
        assertEquals("il y a 2 min", ageOf(row("chef"), Kind.IDLE, now).text)
        assertEquals("tour 1m01", ageOf(row("beta"), Kind.DEAD, now).text)
        assertTrue(ageOf(row("beta"), Kind.DEAD, now).live)
        assertEquals("tour 1m03", ageOf(row("beta"), Kind.DEAD, now, recvElapsedMs = 2000).text)
        assertEquals("silence 11m40", ageOf(row("delta"), Kind.STALL, now).text)
        assertEquals("jamais observé", ageOf(row("eta"), Kind.CHEF, now).text)
        assertEquals("il y a 3 j", fmtAgo(now - 72L * 3600_000, now))
        assertEquals("il y a 47 h", fmtAgo(now - 47L * 3600_000, now))
    }

    @Test fun durationFormatLikeSalle() {
        assertEquals("59s", fmtDur(59_000))
        assertEquals("2m05", fmtDur(125_000))
        assertEquals("1h01", fmtDur(3_660_000))
        assertEquals("—", fmtDur(-1))
    }

    @Test fun shortModelAndDetails() {
        assertEquals("opus-5-5", shortModel(row("chef")))
        assertEquals("prévu sonnet-5", shortModel(row("alpha")))
        assertNull(shortModel(ProjectRow(name = "x", model = "<synthetic>")))
        assertEquals("code v1.2.3 · APK copié il y a 2 h · dernier tour 1m05 coût rapporté \$0.43", detailsOf(row("alpha"), now))
        assertEquals("aucune métadonnée de livrable", detailsOf(row("eta"), now))
        assertEquals("dernier tour coût non fourni", detailsOf(row("kappa"), now))
    }

    @Test fun groupsCountsAndOrder() {
        val v = buildView(rows(), filter = "", only = null, conductor = "chef", now = now)
        assertEquals(12, v.counts.all)
        assertEquals(5, v.counts.attention)
        assertEquals(4, v.counts.active)
        assertEquals(3, v.counts.rest)
        assertEquals(1, v.counts.questions)
        assertEquals(listOf("alpha", "beta", "gamma", "kappa", "delta"), v.group(Group.ATTENTION).items.map { it.row.name })
        assertEquals(listOf("eps", "zeta", "eta", "theta"), v.group(Group.ACTIVE).items.map { it.row.name })
        // rest: unread first, then most recent activity, then name
        assertEquals(listOf("iota", "chef", "lambda"), v.group(Group.REST).items.map { it.row.name })
        assertTrue(v.group(Group.REST).items.first { it.row.name == "chef" }.isChef)
    }

    @Test fun filterAndCounterIsolation() {
        val v = buildView(rows(), filter = "supervision", only = null, conductor = "chef", now = now)
        assertEquals(listOf("gamma"), v.group(Group.ATTENTION).visible.map { it.row.name })
        assertTrue(v.group(Group.ACTIVE).hidden)          // filter, nothing visible
        assertEquals("1/5", v.group(Group.ATTENTION).countText)
        val iso = buildView(rows(), filter = "", only = Group.REST, conductor = "chef", now = now)
        assertTrue(iso.group(Group.ATTENTION).hidden)
        assertFalse(iso.group(Group.REST).hidden)
        assertEquals(Group.REST, toggleOnly(null, Group.REST))
        assertNull(toggleOnly(Group.REST, Group.REST))
        assertNull(toggleOnly(Group.REST, null))
    }
}
