package com.orchestrateur.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JournalTurnsTest {
    private val sample = """
    {"project":"omega","truncated":true,"turns":[
      {"start":"2026-10-20T10:00:00.000Z","end":"2026-10-20T10:05:00.000Z","outcome":"error","subtype":"error_max_turns",
       "prompt":"Corrige le bug","promptFull":{"text":"Corrige le bug complet"},"resultFull":{"text":"Rapport **entier**"},
       "summary":["a fait X","a fait Y"],"durationMs":300000,"costUsd":1.234,"model":"claude-opus-5-5-20261001",
       "pipeline":{"run":"p-20261020T100000-abcdef","pipeline":"dev","mode":"complet","status":"paused","items":2,"loops":1,
         "planned":[{"id":"comprendre","title":"Comprendre","model":"claude-opus-5-5"},{"id":"rouge","title":"Rouge","model":"m2"},{"id":"livrer","title":"Livrer"}],
         "steps":[{"id":"comprendre","status":"ok","model":"claude-opus-5-5","durationMs":60000},
                  {"id":"rouge","status":"refused","model":"m2","source":"project-default","item":1,"attempt":2,"why":"le test passe\nsuite"}],
         "defects":["d1","d2"],"limit":{"limit":"green","text":"limite atteinte"},
         "backoff":{"text":"attente 10 s","tier":1,"slot":"dev.rouge"},"modelTest":{"status":"ok","text":"model OK","logName":"20261020T100000Z-m.log"}},
       "commits":[{"sha":"abc1234","msg":"fix"}],"pushed":true,"versions":["1.2.3"],"urls":["https://x.y/z"],
       "ack":{"by":"chef","ts":"2026-10-20T11:00:00Z","note":"ok"},"resolved":{"note":"répondu"},
       "autoAnswer":{"status":"applied","answer":"continuer","reason":"recommandé"},
       "permissions":[{"tool":"Bash","preview":"npm test","decision":"allow_once"}],
       "test":{"label":"essai"}},
      {"start":"2026-10-20T09:00:00.000Z","outcome":"stopped","stop":{"by":"supervision","reason":"bloqué"}},
      {"start":"2026-10-20T08:00:00.000Z","outcome":"question","question":"On pousse ?"}
    ],"regressions":[]}
    """.trimIndent()

    @Test fun parsesTurnsAndFields() {
        val j = parseJournal(parseJsonOrNull(sample))
        assertTrue(j.truncated)
        assertEquals(3, j.turns.size)
        val t = j.turns[0]
        assertEquals("error", t.outcome)
        assertEquals("Corrige le bug", t.prompt)
        assertEquals("Corrige le bug complet", t.promptFull)
        assertEquals("Rapport **entier**", t.resultFull)
        assertEquals(listOf("a fait X", "a fait Y"), t.summary)
        assertEquals(listOf("commit abc1234", "poussé", "v1.2.3", "x.y/z"), t.chips())
        assertEquals("p-20261020T100000-abcdef", t.pipeline?.run)
        assertEquals(2, t.pipeline?.defects?.size)
        assertEquals("dev.rouge", t.pipeline?.backoffSlot)
        assertEquals("model OK", t.pipeline?.modelTest)
        assertEquals("20261020T100000Z-m.log", t.pipeline?.modelTestLog)
    }

    @Test fun outcomeWordLikeTheWeb() {
        val j = parseJournal(parseJsonOrNull(sample))
        assertEquals("✕", j.turns[0].mark())
        assertEquals("🧪 échec · error_max_turns · test « essai »", j.turns[0].word())
        assertEquals("■ arrêté par la supervision", "${j.turns[1].mark()} ${j.turns[1].word()}")
        assertEquals("question posée", j.turns[2].word())
        assertEquals("5 min 00 s · \$1.23 · opus-5-5", j.turns[0].meta())
    }

    @Test fun pipelineTimelineRowsAndUpcoming() {
        val p = parseJournal(parseJsonOrNull(sample)).turns[0].pipeline!!
        assertEquals("Développement complet", p.label())
        val rows = p.rows()
        assertEquals("Comprendre · opus-5-5 · ✓ · 1 min 00 s", rows[0].text)
        assertEquals("Rouge item 1 essai 2 · m2 ⚠ défaut du projet · ✕ refusé", rows[1].text)
        assertEquals("le test passe", rows[1].why)
        assertEquals("Livrer · défaut du projet · à venir", rows[2].text)
        assertTrue(rows[2].upcoming)
    }

    @Test fun afterLines() {
        val t = parseJournal(parseJsonOrNull(sample)).turns[0]
        val after = t.afterLines()
        assertTrue(after[0].startsWith("✓ marqué vu par chef"))
        assertEquals("✓ question marquée répondue — répondu", after[1])
        assertEquals("🤖 réponse automatique (Opus 5.5, utilisateur inactif) : « continuer » — raison : recommandé", after[2])
        assertEquals(listOf("🔐 Bash npm test — autorisé une fois"), t.permissionLines())
    }

    @Test fun emptyOrBrokenJournal() {
        assertEquals(0, parseJournal(null).turns.size)
        assertEquals(0, parseJournal(parseJsonOrNull("""{"turns":"x"}""")).turns.size)
        assertNull(parseJournal(parseJsonOrNull("""{"turns":[{}]}""")).turns[0].pipeline)
    }

    @Test fun durationFormat() {
        assertEquals("45 s", fmtDuration(45_000))
        assertEquals("2 min 05 s", fmtDuration(125_000))
        assertEquals("1 h 02 min", fmtDuration(3_720_000))
    }
}
