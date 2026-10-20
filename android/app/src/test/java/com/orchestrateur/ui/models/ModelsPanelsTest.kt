package com.orchestrateur.ui.models

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Suggestions, health, observation, gaps, API keys and model languages of the Models page. */
class ModelsPanelsTest {
    private fun j(s: String) = Json.parseToJsonElement(s)

    // ---- Suggestions (GET /api/model-recommendations, POST apply-suggestions) ----
    private val recoJson = """
    {"ok":true,"report":{"date":"2026-10-01","file":"comparaison-models-2026-10.md","commit":"a8c5cc2","author":"étude","redoHint":"à refaire d’ici 1-2 mois"},
     "age":{"days":40,"level":"aging"},
     "slots":{
      "dev.vert":{"step":"vert","inherited":false,"confidence":"haute","section":"§4.2","why":"meilleur au SWE-bench","undecided":false,"extrapolated":null,"note":null,
        "principal":{"provider":"anthropic","model":"claude-opus-5-5","effort":"high","applicable":true},
        "alternatives":[{"provider":"openai","model":"gpt-6-astra","target":true,"available":false,"reason":"annoncé","today":{"provider":"openai","model":"gpt-5.5"}},
                        {"external":"Aider","note":"hors listes"}]},
      "dev.spike":{"step":"spike","inherited":true,"confidence":"moyenne","section":"§4.1","why":"rapide","undecided":true,"extrapolated":"déduit de l’étape voisine",
        "principal":{"external":"un humain","applicable":false,"reason":"outil ou service hors des listes (pas encore câblé dans l’orchestrateur)"},"alternatives":[]}
     },
     "counts":{"slots":102,"withSuggestion":98,"applicable":80,"undecided":12}}
    """

    @Test fun parsesSuggestionsAndState() {
        val r = parseReco(j(recoJson))!!
        val v = r.slots["dev.vert"]!!
        assertEquals("claude-opus-5-5 · effort high", refText(v.principal))
        assertEquals("✓ suivie", recoState(v, Choice("anthropic", "claude-opus-5-5", null, null)).text)
        assertTrue(recoState(v, Choice("anthropic", "claude-opus-5-5", null, null)).followed)
        assertEquals("votre choix est différent (conservé)", recoState(v, Choice("openai", "gpt-5.5", null, null)).text)
        assertEquals("", recoState(v, null).text)
        assertEquals("gpt-6-astra (cible : pas encore dans codex) → aujourd’hui gpt-5.5", altText(v.alternatives[0]))
        assertEquals("Aider (hors listes)", altText(v.alternatives[1]))
        val s = r.slots["dev.spike"]!!
        assertTrue(s.undecided)
        assertTrue(s.inherited)
        assertTrue(recoState(s, null).text.startsWith("non applicable ici : outil"))
        assertEquals("⚠ Rapport de 40 jours : il vieillit — à refaire d’ici 1-2 mois.", recoAgeText(r))
        assertTrue(recoBoxText(r).contains("98 cases sur 102 ont une suggestion, dont 80 applicables ici ; 12 relèvent d’étapes que le rapport juge non tranchées."))
    }

    @Test fun applySuggestionBodiesPlanAndResult() {
        val dry = applyBody("one", "dev.vert", dryRun = true)
        assertEquals("one", dry["mode"]!!.jsonPrimitive.content)
        assertEquals(listOf("dev.vert"), dry["slots"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("true", dry["dryRun"]!!.jsonPrimitive.content)
        val empty = applyBody("empty", null, dryRun = false)
        assertTrue(empty["slots"]!!.jsonArray.isEmpty())
        assertFalse(empty.containsKey("dryRun"))

        val plan = parsePlan(j("""{"ok":true,"dryRun":true,"mode":"empty","plan":[{"slot":"dev.vert","provider":"anthropic","model":"claude-opus-5-5","from":null}],
            "skipped":[{"slot":"dev.rouge","reason":"déjà choisie : jamais modifiée"},{"slot":"dev.spike","reason":"déjà choisie : jamais modifiée"},{"slot":"x","reason":"hérite déjà de son étape"}]}"""), "empty")
        assertEquals("1 case(s) vide(s) recevront la suggestion. Laissées telles quelles : 2 déjà choisie : jamais modifiée · 1 hérite déjà de son étape.", confirmHead(plan))
        val one = parsePlan(j("""{"plan":[{"slot":"dev.vert","provider":"anthropic","model":"m","from":"openai:gpt-5.5"}],"skipped":[]}"""), "one")
        assertEquals("Remplacer votre choix par la suggestion ?", confirmHead(one))
        assertEquals("openai:gpt-5.5 → anthropic:m", planLine(one.items[0]))

        val res = applyResult(j("""{"ok":true,"mode":"empty","applied":[{"slot":"dev.vert"}],"failed":[{"slot":"dev.rouge","error":"incompatible"}],"skipped":[]}"""), "empty", "10:00")
        assertEquals("✓ suggestion appliquée · 10:00", res.statuses["dev.vert"])
        assertEquals("✕ non appliquée : incompatible", res.statuses["dev.rouge"])
        assertEquals("1 case(s) vide(s) remplie(s) avec la suggestion, 1 en échec.", res.notice)
    }

    // ---- Mise en service (GET /api/pipeline-health) ----
    @Test fun parsesHealth() {
        val h = parseHealth(j("""{"ok":true,"since":"2026-10-09T10:00:00.000Z","chef":true,"terminal":false,"projects":20,
            "totals":{"runs":40,"hors":1,"ordinaires":2,"refus":3,"porte":4,"pauses":5},
            "perProject":[{"name":"alpha","runs":10,"hors":1,"ordinaires":0,"refus":0,"porte":0,"pauses":1}],
            "days":[{"date":"2026-10-10","runs":5,"hors":0,"ordinaires":0,"refus":0,"porte":0,"pauses":0}],
            "streakDays":3,"criterion":{"days":7,"met":false}}"""))
        assertEquals(20, h.projects)
        assertEquals(3, h.bypass)
        assertEquals("3 jour(s) complet(s) sans contournement sur 7", h.streakText)
        assertEquals("Exécutions 10 · Hors pipeline 1 · Tours ordinaires 0 · Refus moteur 0 · Refus porte 0 · Pauses 1", h.perProject[0].text)
        assertEquals("alpha", h.perProject[0].label)
        assertNull(parseHealth(j("""{"ok":true,"since":null,"totals":{},"days":[],"perProject":[],"criterion":{"days":7}}""")).since)
    }

    // ---- Observation (GET /api/pipeline-observe) ----
    @Test fun parsesObservation() {
        val o = parseObserve(j("""{"ok":true,"total":12,"entryKinds":{"dashboard":"composer du dashboard"},
            "counts":{"byPipeline":{"dev":3,"discussion":8,"null":1},"unclassifiable":2},
            "items":[{"at":"2026-10-20T10:00:00Z","entry":"dashboard","project":"chef","target":"alpha","caller":"x","pipeline":"dev","mode":"leger","explicit":true,"gap":true,"head":"ajoute un bouton","confidence":"haute"},
                     {"at":"2026-10-20T09:00:00Z","entry":"cli","pipeline":null,"head":"bonjour"}]}"""))
        assertEquals(12, o.total)
        assertEquals(listOf("discussion" to 8, "dev" to 3, "null" to 1), o.byPipeline)
        val labels = mapOf("dev" to "Développement", "discussion" to "Discussion")
        assertEquals("à classer (model)", pipelineLabel(null, labels))
        assertEquals("à classer (model)", pipelineLabel("null", labels))
        assertEquals("Développement · léger · explicite · ⚑ lacune proposée", obsTags(o.items[0], labels))
        assertEquals("chef → alpha (par x)", o.items[0].who)
        assertEquals("—", o.items[1].who)
    }

    // ---- Lacunes (GET /api/pipeline-gaps) ----
    private val gapsJson = """
    {"ok":true,"open":[{"key":"model:abc","why":"aucun pipeline pour les vidéos","count":2,"lastAt":"2026-10-20T10:00:00Z",
        "entries":[{"head":"monte la vidéo","entry":"dashboard","project":"alpha","pipeline":"discussion"}],
        "proposal":{"kind":"pipeline","text":"un pipeline Vidéo"},"alternative":{"kind":"rattachement","text":"rattacher à Images"}},
       {"key":"model:def","why":"w","count":1,"entries":[],"proposal":{"kind":"etape","text":"t"}}],
     "decided":[{"key":"model:old","entries":[{"head":"vieux"}],"decision":{"decision":"accepted","applied":{"kind":"variante","label":"Montage","pipeline":"video"}}},
                {"key":"model:rej","entries":[],"decision":{"decision":"rejected"}}]}
    """

    @Test fun parsesGapsAndPresentedKeys() {
        val g = parseGaps(j(gapsJson))
        assertEquals(2, g.open.size)
        assertEquals(listOf("gap:model:abc", "gap:model:def"), presentedKeys(g))
        assertEquals("nouveau pipeline", gapKindLabel("pipeline"))
        assertEquals("rattachement", g.open[0].alternative!!.kindLabel)
        assertNull(g.open[1].alternative)
        assertEquals("vieux — acceptée (variante Montage)", g.decided[0])
        assertEquals("model:rej — rejetée", g.decided[1])
        val body = gapAcceptBody("alternative")
        assertEquals("alternative", body["choice"]!!.jsonPrimitive.content)
        assertEquals("✓ Acceptée : variante « Montage » ajouté au pipeline Vidéo — choisissez son model dans l’onglet Étapes.",
            gapAcceptedNotice(j("""{"ok":true,"applied":{"kind":"variante","label":"Montage","pipeline":"video","slot":"video.monter.montage"}}"""), mapOf("video" to "Vidéo")))
    }

    // ---- Clés API (GET /api/api-keys) ----
    @Test fun parsesKeysAndNotices() {
        val keys = parseKeys(j("""{"ok":true,"keys":[
            {"name":"OPENROUTER_API_KEY","label":"OpenRouter","usage":"models OpenRouter","configured":true,"valid":true,"last4":"ab12","source":".env","checkedAt":"2026-10-20T10:00:00Z","deletable":true},
            {"name":"NVIDIA_API_KEY","label":"NVIDIA","usage":"failover","configured":false,"valid":null,"last4":null,"deletable":false}]}"""))
        assertEquals("✓ configurée · acceptée", keys[0].stateText)
        assertEquals("○ absente", keys[1].stateText)
        assertEquals(1, keysToFix(keys))
        assertEquals("Clé enregistrée et acceptée par le fournisseur.", keyNotice("save", j("""{"ok":true,"key":{"valid":true}}""")))
        assertEquals("Clé refusée par le fournisseur (invalide).", keyNotice("test", j("""{"ok":true,"key":{"valid":false}}""")))
        assertEquals("Clé enregistrée — vérification impossible : réseau", keyNotice("save", j("""{"ok":true,"key":{"valid":null,"detail":"réseau"}}""")))
        assertEquals("Clé retirée.", keyNotice("del", j("""{"ok":true}""")))
        assertEquals("abcd1234", keyBody("  abcd1234 ")["value"]!!.jsonPrimitive.content)
    }

    // ---- Langues des models (GET /api/model-languages) ----
    @Test fun parsesModelLanguages() {
        val l = parseModelLangs(j("""{"ok":true,"langs":{"fr":{"label":"Français"},"en":{"label":"English"}},
            "models":[{"model":"kimi-k3","provider":"nvidia","langs":["en"],"source":"default","note":"model inconnu : anglais seulement, jusqu’à vérification",
                       "test":{"lang":"fr","ok":false,"detected":"en"}},
                      {"model":"claude-opus-5-5","provider":"anthropic","langs":["fr","en"],"source":"rule","note":null}]}"""))
        assertEquals(listOf("fr", "en"), l.langs)
        assertEquals("inconnu : anglais seulement — model inconnu : anglais seulement, jusqu’à vérification · essai fr : ✕ (réponse en en)", l.models[0].originText)
        assertEquals("règle par défaut", l.models[1].originText)
        // Order follows the server's language list.
        assertEquals(listOf("fr", "en"), toggledLangs(l.models[0].langs, "fr", true, l.langs))
        assertEquals(listOf("fr"), toggledLangs(listOf("fr", "en"), "en", false, l.langs))
        val b = langTestBody("nvidia", "kimi-k3", "fr")
        assertEquals("kimi-k3", b["model"]!!.jsonPrimitive.content)
        assertEquals("fr", b["lang"]!!.jsonPrimitive.content)
    }
}
