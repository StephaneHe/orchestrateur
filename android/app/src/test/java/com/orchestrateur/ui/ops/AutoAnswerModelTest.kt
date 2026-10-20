package com.orchestrateur.ui.ops

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/** Shape of GET /api/auto-answer (scripts/auto-answer.mjs view() + overview()). */
class AutoAnswerModelTest {
    private val fixture = """
    {"ok":true,"model":"claude-opus-5-5","mark":"🤖 réponse automatique","settings":{"enabled":true,"idleMin":15,"waitMin":5,"activatedAt":"2026-10-20T08:00:00.000Z"},
     "guardrails":[{"id":"argent","label":"Argent","cases":["payer","acheter"]},{"id":"secret","label":"Secret","cases":[]}],
     "guardrailsAlwaysOn":true,
     "activity":{"lastAt":"2026-10-20T09:30:00.000Z","idleMs":1000,"idle":false,"last":{"kind":"présence"},"presentSince":null},
     "unseen":2,
     "decisions":[
       {"id":"aa-20261020T100000-abcdef","at":"2026-10-20T10:00:00.000Z","status":"applied","kind":"gap","project":"alpha",
        "what":"lacune proposée — lacune rejetée","target":{"type":"gap","id":"g1","label":"lacune « g1 »","project":"alpha"},
        "why_inactive":"dernier signe de vous à 09:30","question":"Accepter  la\nlacune ?","answer":"non","decision":"reject","reason":"suivi la recommandation",
        "phase":"handled","obsolete":null,"dismissed":false,"undoable":true,"recovery":{"possible":true,"text":"tag auto-answer/x"},
        "guardrails":{"hits":["argent"]}},
       {"id":"aa-20261020T100500-123456","at":"2026-10-20T10:05:00.000Z","status":"running","kind":"question","project":"beta","what":"question : en cours",
        "target":{"type":"run","id":"p-20261020T100000-abcd","label":"exécution p-20261020T100000-abcd de beta","project":"beta"},"phase":"pending","undoable":false},
       {"id":"aa-20261020T101000-654321","at":"2026-10-20T10:10:00.000Z","status":"submitted","kind":"question","project":"beta","what":"question : soumise",
        "target":{"type":"project","id":"beta","label":"question de beta","project":"beta"},"phase":"pending","seenAt":"2026-10-20T10:11:00.000Z","undoable":false},
       {"id":"aa-20261020T101500-aaaaaa","at":"2026-10-20T10:15:00.000Z","status":"safe","kind":"permission","project":"gamma","what":"autorisation — refusée",
        "target":{"type":"permission","id":"perm1","label":"autorisation demandée par gamma","project":"gamma"},"phase":"obsolete","obsolete":"demande expirée","undoable":false,"undone":{"at":"x","done":["a"]}}
     ],
     "history":[{"id":"aa-20261019T101500-bbbbbb","at":"2026-10-19T10:15:00.000Z","status":"applied","what":"vieux","dismissed":true,"dismissedAt":"2026-10-19T11:00:00.000Z","phase":"handled"}],
     "backlog":[{"key":"gap:g2","kind":"gap","project":"alpha","lane":0,"since":"2026-10-10T08:00:00.000Z","question":"Lacune g2","reason":"avant-activation","reasonText":"née avant l’activation","gapKey":"g2"},
                {"key":"pause:p1","kind":"pause","project":"beta","lane":0,"since":"2026-10-11T08:00:00.000Z","question":"Pause","reason":"x","reasonText":"y","run":"p-20261011T080000-abcd"}]}
    """.trimIndent()

    private fun parsed() = parseAutoOverview(Json.parseToJsonElement(fixture))

    @Test fun parsesSettingsActivityAndModel() {
        val o = parsed()
        assertTrue(o.settings.enabled)
        assertEquals(15, o.settings.idleMin)
        assertEquals(5, o.settings.waitMin)
        assertEquals("2026-10-20T08:00:00.000Z", o.settings.activatedAt)
        assertEquals("claude-opus-5-5", o.model)
        assertEquals("2026-10-20T09:30:00.000Z", o.activity.lastAt)
        assertEquals("présence", o.activity.lastKind)
        assertEquals(2, o.unseen)
    }

    @Test fun guardrailsAreReadOnlyDataWithCollapsedLabel() {
        val o = parsed()
        assertEquals(2, o.guardrails.size)
        assertEquals(listOf("payer", "acheter"), o.guardrails[0].cases)
        assertEquals("🔒 2 garde-fous actifs", guardrailsLine(o.guardrails.size))
    }

    @Test fun parsesDecisionsWithTargetsAndDetails() {
        val d = parsed().decisions[0]
        assertEquals("aa-20261020T100000-abcdef", d.id)
        assertEquals("gap", d.target?.type)
        assertEquals("lacune « g1 »", d.target?.label)
        assertEquals("Accepter la lacune ?", d.questionLine)
        assertEquals("[reject] non", d.answerLine)
        assertEquals(listOf("argent"), d.hits)
        assertEquals("tag auto-answer/x", d.recoveryText)
        assertTrue(d.undoable)
        assertEquals("traitée", phaseText(d.phase))
        val d3 = parsed().decisions[3]
        assertTrue(d3.undone)
        assertEquals("demande expirée", d3.obsolete)
        assertEquals("obsolète", phaseText(d3.phase))
        assertEquals("en attente de votre décision", phaseText("pending"))
    }

    @Test fun backlogAndHistory() {
        val o = parsed()
        assertEquals(2, o.backlog.size)
        assertEquals("lacune", kindText(o.backlog[0].kind))
        assertEquals("lacune « g2 »", o.backlog[0].targetLabel)
        assertEquals("exécution p-20261011T080000-abcd", o.backlog[1].targetLabel)
        assertEquals("pause de pipeline", kindText("pause"))
        assertEquals("📥 Arriéré : 2 attentes jamais traitées automatiquement", backlogTitle(2))
        assertEquals("📥 Arriéré : 1 attente jamais traitée automatiquement", backlogTitle(1))
        assertEquals(1, o.history.size)
        assertTrue(o.history[0].dismissed)
    }

    @Test fun bandKeepsUnseenFinishedNotDismissedNotSnoozed() {
        val o = parsed()
        val now = 1_000_000L
        // decision 0: unseen, applied → shown; 1: running → hidden; 2: seen → hidden; 3: unseen safe → shown
        assertEquals(listOf("aa-20261020T100000-abcdef", "aa-20261020T101500-aaaaaa"), bandItems(o.decisions, emptyMap(), now).map { it.id })
        val snoozed = mapOf("aa-20261020T101500-aaaaaa" to now + 10, "aa-20261020T100000-abcdef" to now - 10)
        assertEquals(listOf("aa-20261020T100000-abcdef"), bandItems(o.decisions, snoozed, now).map { it.id })
        assertEquals("🤖 2 décisions prises à votre place", bandTitle(2))
        assertEquals("🤖 1 décision prise à votre place", bandTitle(1))
    }

    @Test fun snoozeAddsOneHourAndDropsExpired() {
        val now = 10_000_000L
        val s = snooze(mapOf("old" to now - 1, "keep" to now + 5), "new", now)
        assertEquals(setOf("keep", "new"), s.keys)
        assertEquals(now + 3_600_000L, s["new"])
        val text = encodeSnoozed(s)
        assertEquals(s, decodeSnoozed(text))
        assertEquals(emptyMap<String, Long>(), decodeSnoozed("pas du json"))
        assertEquals(emptyMap<String, Long>(), decodeSnoozed(null))
    }

    @Test fun discardableCountsNonPending() {
        assertEquals(2, discardableCount(parsed().decisions))
        assertEquals("Écarter tout ce qui est traité ou obsolète (2)", discardAllLabel(2))
    }

    @Test fun requestBodies() {
        assertEquals(true, settingsEnabledBody(true)["enabled"]!!.jsonPrimitive.boolean)
        val d = delaysBody("20", " 7 ")!!
        assertEquals(20, d["idleMin"]!!.jsonPrimitive.int)
        assertEquals(7, d["waitMin"]!!.jsonPrimitive.int)
        assertNull(delaysBody("0", "5"))
        assertNull(delaysBody("abc", "5"))
        assertNull(delaysBody("5", "1441"))
        val dis = dismissBody("aa-1", confirm = false)
        assertEquals("aa-1", dis["ids"]!!.jsonArray[0].jsonPrimitive.content)
        assertFalse(dis.containsKey("confirm"))
        assertEquals(true, dismissBody("aa-1", confirm = true)["confirm"]!!.jsonPrimitive.boolean)
        assertEquals(true, dismissHandledBody()["handled"]!!.jsonPrimitive.boolean)
    }

    @Test fun needsConfirmOnlyOn409WithList() {
        val j = Json.parseToJsonElement("""{"ok":false,"needsConfirm":["aa-1"],"dismissed":[]}""")
        assertTrue(dismissNeedsConfirm(409, j))
        assertFalse(dismissNeedsConfirm(200, j))
        assertFalse(dismissNeedsConfirm(409, Json.parseToJsonElement("""{"ok":false,"needsConfirm":[]}""")))
    }

    @Test fun clockTextInZone() {
        assertEquals("10:00", hhmm("2026-10-20T10:00:00.000Z", ZoneOffset.UTC))
        assertEquals("12:00", hhmm("2026-10-20T10:00:00.000Z", ZoneOffset.ofHours(2)))
        assertEquals("20/10 10:00", dayHhmm("2026-10-20T10:00:00.000Z", ZoneOffset.UTC))
        assertEquals("", hhmm(null, ZoneOffset.UTC))
        assertEquals("", hhmm("n'importe quoi", ZoneOffset.UTC))
    }

    @Test fun emptyOrForeignJsonNeverThrows() {
        val o = parseAutoOverview(Json.parseToJsonElement("{}"))
        assertFalse(o.settings.enabled)
        assertTrue(o.decisions.isEmpty())
        assertTrue(o.backlog.isEmpty())
        assertTrue(bandItems(o.decisions, emptyMap(), 0).isEmpty())
    }
}
