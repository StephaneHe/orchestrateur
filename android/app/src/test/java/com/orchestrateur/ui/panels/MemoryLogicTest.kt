package com.orchestrateur.ui.panels

import com.orchestrateur.data.b
import com.orchestrateur.data.i
import com.orchestrateur.data.s
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Shapes of GET /api/kg/review, /api/kg/status, /api/kg/rules, /api/kg/stats (server 0.131.0). */
private const val REVIEW = """
{"ok":true,"builtAt":"2026-10-22T08:00:00Z","counts":{"conflicts":1,"facts":2,"pairs":1,"stale":1,"total":6},
 "items":[
  {"id":"f-1","kind":"fact","rev":3,"status":"proposé","why":"extrait par un model","s":"alpha","p":"uses_port","o":"7781",
   "labels":{"s":"alpha","p":"écoute sur le port","o":"7781"},
   "card":{"what":"alpha écoute sur le port 7781","why":"vu dans le CLAUDE.md","since":"2026-10-20","where":"projet alpha"},
   "source":{"key":"claude:alpha","ref":"alpha/CLAUDE.md","line":12,"quote":"port 7781","kind":"document"},
   "owner":"alpha","actions":["validate","correct","expire","reject"]},
  {"id":"i-1","kind":"index","rev":1,"s":"MEMORY.md","p":"cites","o":"old.md","owner":"chef","actions":["validate","reject"]},
  {"id":"st-1","kind":"stale","rev":2,"s":"beta","p":"port","o":"7790","owner":"utilisateur",
   "source":{"key":"ports","ref":"ports.md","line":4},"actions":["validate","expire","reject"]},
  {"id":"p-1","kind":"pair","rev":1,"verdict":"contradiction probable","why":"deux valeurs","actions":["validate","reject"],
   "sides":[{"fact":"a1","o":"opus","label":"model par défaut : opus","ref":"x.md","key":"k1","line":3,"quote":"opus","date":"2026-10-01","owner":"chef"},
            {"fact":"a2","o":"sonnet","label":"model par défaut : sonnet","ref":"y.md","key":"k2","line":9,"quote":"sonnet","date":"2026-10-10","owner":"chef"}]},
  {"id":"c-1","kind":"conflict","rev":5,"why":"même autorité, valeurs différentes","actions":["arbitrate"],
   "sides":[{"fact":"b1","o":"2","label":"maxParallel 2"},{"fact":"b2","o":"3","label":"maxParallel 3"}]},
  {"id":"f-2","kind":"fact","rev":1,"s":"gamma","p":"owner","o":"chef","actions":["validate"]}
 ]}
"""

private const val STATUS = """
{"ok":true,"mode":"assist","switches":{"build":true,"extract":true,"ui":true},"cutoff":{"at":"2026-10-22","why":"trop de faits faux"},
 "index":{"builtAt":"2026-10-22T08:00:00Z","nodes":120,"facts":340,"label":"index du 22/10"},
 "review":{"conflicts":1,"facts":2,"pairs":1,"stale":1,"total":6},"contradictions":2,
 "curated":{"events":4,"proposed":3,"validated":1},
 "extraction":{"last":null,"lastPairs":null,"suspended":{"at":"2026-10-22","why":"budget atteint"},"callsToday":7,"pairsToday":3,
   "daily":{"calls":50,"pairs":20},"health":{"judged":10,"false":4,"window":20,"maxFalse":3,"breached":true,"rate":0.4},
   "model":{"ok":true,"model":"claude-haiku-5-5","source":"case"}},"backups":2}
"""

class MemoryLogicTest {
    private val review = parseKgReview(Json.parseToJsonElement(REVIEW))
    private fun item(id: String) = review.items.first { it.id == id }

    @Test
    fun parsesEveryKind() {
        assertEquals(6, review.total)
        assertEquals(setOf("fact", "index", "stale", "pair", "conflict"), review.items.map { it.kind }.toSet())
        val f = item("f-1")
        assertEquals(3, f.rev)
        assertEquals("alpha écoute sur le port 7781", f.card?.what)
        assertEquals("alpha/CLAUDE.md", f.source?.ref)
        assertEquals(12, f.source?.line)
        assertEquals(listOf("validate", "correct", "expire", "reject"), f.actions)
        val p = item("p-1")
        assertEquals(2, p.sides.size)
        assertEquals("k2", p.sides[1].key)
        assertEquals(9, p.sides[1].line)
        assertEquals("contradiction probable", p.verdict)
        assertEquals(listOf("b1", "b2"), item("c-1").sides.map { it.fact })
        // The four questions, in order, with a fallback for a fact without card.
        assertEquals(listOf("Ce que nous savons", "Pourquoi", "Depuis quand", "Où cela s’applique"), fourQuestions(f).map { it.first })
        assertEquals("gamma owner chef", fourQuestions(item("f-2"))[0].second)
        assertEquals("—", fourQuestions(item("f-2"))[2].second)
    }

    @Test
    fun groupsContradictionsFirst() {
        val g = groupReview(review.items)
        assertEquals(listOf("conflict", "fact", "pair", "stale", "index"), g.map { it.kind })
        assertEquals("Contradictions", g[0].title)
        assertEquals(listOf("f-1", "f-2"), g[1].items.map { it.id })
        assertEquals("Index des mémoires", g.last().title)
    }

    @Test
    fun decisionPayload() {
        val id = newCommandId(1_700_000_000_000L, java.util.Random(1))
        assertTrue(id, Regex("^android-[0-9a-z]+-[0-9a-z]{8}$").matches(id))
        assertTrue(isValidCommandId(id))
        assertFalse(isValidCommandId("abc"))
        assertFalse(isValidCommandId("bad id with spaces"))

        val v = (decisionBody(item("f-1"), "validate", id) as DecisionBody.Ok).json
        assertEquals("f-1", v.s("id"))
        assertEquals("validate", v.s("action"))
        assertEquals(3, v.i("rev"))
        assertEquals(id, v.s("commandId"))
        assertEquals("android", v.s("client"))
        assertNull(v.s("reason"))

        val r = (decisionBody(item("f-1"), "reject", id, reason = " faux ") as DecisionBody.Ok).json
        assertEquals("faux", r.s("reason"))
        assertTrue(decisionBody(item("f-1"), "reject", id, reason = " ") is DecisionBody.Invalid)

        val c = (decisionBody(item("f-1"), "correct", id, newValue = "7782") as DecisionBody.Ok).json
        assertEquals("7782", c.s("o"))
        assertTrue(decisionBody(item("f-1"), "correct", id, newValue = "x".repeat(201)) is DecisionBody.Invalid)

        val e = (decisionBody(item("st-1"), "expire", id, validTo = "2026-10-31") as DecisionBody.Ok).json
        assertEquals("2026-10-31", e.s("valid_to"))
        assertEquals(2, e.i("rev"))
        for (bad in listOf("31/10/2026", "2026-13-01", "2026-02-30", "2026-1-5", "")) {
            assertTrue(bad, decisionBody(item("st-1"), "expire", id, validTo = bad) is DecisionBody.Invalid)
        }

        val a = (decisionBody(item("c-1"), "arbitrate", id, keep = "b2") as DecisionBody.Ok).json
        assertEquals("b2", a.s("keep"))
        assertEquals(5, a.i("rev"))
        assertTrue(decisionBody(item("c-1"), "arbitrate", id, keep = "zz") is DecisionBody.Invalid)
        assertTrue(decisionBody(item("f-1"), "validate", "x") is DecisionBody.Invalid)

        assertEquals("⚠ Confirmer la contradiction", actionLabel("pair", "validate"))
        assertEquals("✕ Écarter", actionLabel("pair", "reject"))
        assertEquals("✓ Celle-ci vaut", actionLabel("conflict", "arbitrate"))
    }

    @Test
    fun decisionOutcomes() {
        val j409 = Json.parseToJsonElement("""{"ok":false,"error":"rev"}""")
        val o409 = decisionOutcome(409, j409, "rev")
        assertTrue(o409.error && o409.reload && !o409.retryable)
        assertTrue(o409.message.contains("a changé"))
        val o400 = decisionOutcome(400, Json.parseToJsonElement("""{"ok":false,"error":"o trop long"}"""), "o trop long")
        assertTrue(o400.message.contains("o trop long"))
        assertFalse(o400.reload)
        assertTrue(decisionOutcome(-1, null, "timeout").retryable)
        val ok = decisionOutcome(200, Json.parseToJsonElement("""{"ok":true,"id":"f-1","action":"validate","rev":4,"cutoff":{"why":"seuil"}}"""), "")
        assertFalse(ok.error)
        assertTrue(ok.message.contains("seuil"))
    }

    @Test
    fun fixSourceTextAndOwner() {
        val f = item("f-1")
        assertTrue(canFixSource(f))
        assertEquals(
            "Corriger la source d’un fait de la mémoire (décision 15 : correction par le projet propriétaire, jamais réécrite en silence).\n\n" +
                "Source : alpha/CLAUDE.md\nPropriétaire : alpha\nFait : alpha écoute sur le port 7781\n\nCe qui est faux / ce qu’il faut écrire : ",
            fixSourceText(f),
        )
        assertFalse(canFixSource(item("st-1")))   // owner « utilisateur »
        assertFalse(canFixSource(item("f-2")))    // no owner, no source
    }

    @Test
    fun disabledFrom404() {
        val off = Json.parseToJsonElement("""{"ok":false,"disabled":true,"error":"kg.ui coupé"}""")
        assertTrue(kgDisabled(404, off))
        assertFalse(kgDisabled(404, Json.parseToJsonElement("""{"ok":false,"error":"inconnu"}""")))
        assertFalse(kgDisabled(200, off))
        assertTrue(decisionOutcome(404, off, "kg.ui coupé").message == KG_DISABLED_TEXT)
        assertTrue(kgMemoryEnabled(Json.parseToJsonElement("""{"ui":{"kgMemory":true}}""")))
        assertFalse(kgMemoryEnabled(Json.parseToJsonElement("""{"ui":{"kgMemory":false}}""")))
        assertFalse(kgMemoryEnabled(Json.parseToJsonElement("""{"ui":{}}""")))
    }

    @Test
    fun statusLineAndBadge() {
        val st = parseKgStatus(Json.parseToJsonElement(STATUS))
        val line = statusLine(st)
        assertTrue(line, line.startsWith("mode assist"))
        assertTrue(line.contains("extraction active"))
        assertTrue(line.contains("trop de faits faux"))
        assertTrue(line.contains("budget atteint"))
        assertEquals("⚠ 2 contradictions · 6 à revoir", plusBadge(st))
        assertNull(plusBadge(st.copy(contradictions = 0, reviewTotal = 0)))
    }

    @Test
    fun rulesAndStats() {
        val rules = parseKgRules(Json.parseToJsonElement("""
            {"ok":true,"fixed":[{"s":"defaults","p":"maxParallel","o":"2","status":"validé","authority":"live","ref":"config.json"}],
             "inForce":[{"id":"r2","label":"Règle 2","status":"en vigueur","specific":true,"chain":[{"id":"r1","label":"Règle 1","older":true,"chain":[{"id":"r0"}]}]}],
             "superseded":[{"id":"r1","label":"Règle 1","supersededBy":"r2"}],"exceptions":[],"conflicts":[{"label":"x ≠ y"}],
             "curated":[],"caseFacts":[{"s":"dev.vert","p":"model","o":"opus","card":{"what":"opus","why":"choisi","since":"2026-10-01","where":"dev.vert"}}],
             "cases":["dev.vert"],"projects":["alpha"]}""".trimIndent()))
        assertEquals("defaults maxParallel : 2", lineText(rules.fixed[0]))
        assertEquals("plus ancienne", rules.inForce[0].chain[0].relation)
        assertEquals("r0", rules.inForce[0].chain[0].chain[0].id)
        assertEquals(listOf("x ≠ y"), rules.conflicts)
        assertEquals("opus", lineText(rules.caseFacts[0]))
        assertEquals("/api/kg/rules?projet=alpha&case=dev.vert", rulesPath("alpha", "dev.vert"))
        assertEquals("/api/kg/rules", rulesPath("", ""))

        val stats = parseKgStats(Json.parseToJsonElement("""
            {"ok":true,"cases":[{"case":"dev.vert","n":3}],"detail":{"case":"dev.vert","n":3,"enough":false,
             "byModel":{"opus":{"n":2,"ok":1,"critere":1,"infrastructure":0,"echec":0},"sonnet":{"n":1,"ok":1}},
             "causes":[{"why":"critère","n":1}],"assigned":"opus"}}""".trimIndent()))
        val d = stats.detail!!
        assertEquals(listOf("opus", "sonnet"), d.byModel.map { it.model })
        assertTrue(insufficientText(d)!!.contains("insuffisantes"))
        assertNull(insufficientText(d.copy(enough = true)))
        assertEquals("/api/kg/stats?case=dev.vert", statsPath("dev.vert"))
        assertEquals("/api/kg/source?key=claude%3Aalpha&line=12", sourcePath("claude:alpha", 12))
        val ex = parseKgSource(Json.parseToJsonElement("""{"ok":true,"key":"k","file":"a.md","line":2,"from":1,"to":3,"changed":false,"lines":[{"n":1,"text":"a"},{"n":2,"text":"b"}]}"""))
        assertEquals(2, ex.line)
        assertEquals(listOf(1 to "a", 2 to "b"), ex.lines)
        assertTrue(Json.parseToJsonElement("""{"disabled":true}""").b("disabled"))
    }
}
