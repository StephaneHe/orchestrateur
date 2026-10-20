package com.orchestrateur.ui.models

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** Models page (0.39.0 → 0.46.0) on the app: same menus and saves as public/models.js. */
class ModelsDataTest {
    private fun j(s: String) = Json.parseToJsonElement(s)

    // Shaped like GET /api/model-routing (modelRouting.view()).
    private val routingJson = """
    {"ok":true,
     "pipelines":[
      {"id":"dev","label":"Développement","icon":"⚙","purpose":"Écrire du code.","when":"Toute modification.",
       "source":{"label":"Canon TDD — Kent Beck","url":"https://x"},
       "variantsInfo":[{"label":"Bugfix","text":"4a reproduit le bug."}],
       "advice":["Conseil : models différents."],
       "flow":[
        {"id":"comprendre","n":"1","title":"Comprendre","what":"Lire le code.","example":"Lire server.js.",
         "variants":[{"id":"codebase","label":"Étude de codebase","what":"Cartographier."},
                     {"id":"image","label":"Capture","what":"Lire une capture.","need":{"llm":"vision","local":[]}}]},
        {"id":"spike","n":"S","title":"Spike","optional":"conditionnel","what":"Essai.","example":"Ex.",
         "returns":[{"to":"liste-tests","label":"on jette l’essai, retour à 3"}]},
        {"id":"liste-tests","n":"3","title":"Liste de tests","what":"Comportements.","example":"Ex.","judge":true},
        {"kind":"loop","id":"tdd","n":"4","title":"Boucle TDD","what":"Un item.","back":{"from":"vert","to":"rouge","label":"test suivant"},
         "steps":[{"id":"rouge","n":"4a","title":"Rouge","what":"Un test.","example":"Ex."},
                  {"id":"vert","n":"4b","title":"Vert","what":"Code minimal.","example":"Ex."}]},
        {"id":"audit-ref","n":"5","title":"Audit","what":"Renvoi.","example":"Ex.","ref":{"pipeline":"audit","label":"voir l’audit"}}
       ]},
      {"id":"images","label":"Images","icon":"🖼","purpose":"p","when":"w",
       "flow":[{"id":"generer","n":"1","title":"Générer","what":"w","example":"e","need":{"llm":"image-gen","local":["image-proc"]}},
               {"id":"miniatures","n":"2","title":"Miniatures","what":"w","example":"e","need":{"llm":null,"local":["thumbnails"]}}]}
     ],
     "slots":[
      {"id":"dev.comprendre","pipeline":"dev","step":"comprendre","label":"Développement · 1 Comprendre","need":{"llm":"text","local":[]},"judge":false},
      {"id":"dev.comprendre.codebase","pipeline":"dev","step":"comprendre","variant":"codebase","label":"Développement · 1 Comprendre · Étude de codebase","need":{"llm":"text","local":[]},"judge":false},
      {"id":"dev.comprendre.image","pipeline":"dev","step":"comprendre","variant":"image","label":"Développement · 1 Comprendre · Capture","need":{"llm":"vision","local":[]},"judge":false},
      {"id":"dev.spike","pipeline":"dev","step":"spike","label":"Développement · S Spike","need":{"llm":"text","local":[]},"judge":false},
      {"id":"dev.liste-tests","pipeline":"dev","step":"liste-tests","label":"Développement · 3 Liste de tests","need":{"llm":"text","local":[]},"judge":true},
      {"id":"dev.rouge","pipeline":"dev","step":"rouge","label":"Développement · 4a Rouge","need":{"llm":"text","local":[]},"judge":false},
      {"id":"dev.vert","pipeline":"dev","step":"vert","label":"Développement · 4b Vert","need":{"llm":"text","local":[]},"judge":false},
      {"id":"images.generer","pipeline":"images","step":"generer","label":"Images · 1 Générer","need":{"llm":"image-gen","local":["image-proc"]},"judge":false},
      {"id":"images.miniatures","pipeline":"images","step":"miniatures","label":"Images · 2 Miniatures","need":{"llm":null,"local":["thumbnails"]},"judge":false}
     ],
     "caps":{"text":"texte / code (agent avec outils)","vision":"lecture d’images (vision)","image-gen":"génération d’images"},
     "agentHarness":{"anthropic":true,"openai":true,"nvidia":false,"openrouter":false},
     "assignments":{
      "dev.comprendre":{"provider":"anthropic","model":"claude-opus-5-5","at":"2026-10-20T08:00:00.000Z"},
      "dev.rouge":{"provider":"openai","model":"gpt-5.5","at":"2026-10-19T08:00:00.000Z","second":{"provider":"anthropic","model":"claude-sonnet-5"}},
      "dev.vert":{"provider":"openai","model":"gpt-5.5"},
      "dev.liste-tests":{"provider":"anthropic","model":"claude-old"}
     },
     "updatedAt":"2026-10-20T08:00:00.000Z",
     "history":[{"at":"2026-10-20T08:00:00.000Z","task":"dev.comprendre","from":null,"to":"anthropic:claude-opus-5-5","by":"dashboard"},
                {"at":"2026-10-19T08:00:00.000Z","task":"dev.rouge","role":"second","from":null,"to":"anthropic:claude-sonnet-5","by":"android"}],
     "historyTotal":7,
     "migration":null}
    """

    // Shaped like GET /api/model-catalog (getCatalog() + decorateCatalog()).
    private val catalogJson = """
    {"ok":true,"providers":{
      "anthropic":{"models":[{"id":"claude-opus-5-5","label":"claude-opus-5-5","caps":["text","vision"]},
                             {"id":"claude-haiku-4","label":"claude-haiku-4","caps":["text","vision"],"dominated":{"by":"claude-haiku-5-5","reason":"moins bon et plus cher","source":"§3"}}],
                   "source":"liste vérifiée","fetchedAt":"2026-10-01"},
      "openai":{"models":[{"id":"gpt-5.5","label":"gpt-5.5","caps":["text","vision"]},
                          {"id":"gpt-6-astra","label":"gpt-6-astra — annoncé, pas encore disponible dans codex","caps":["text"],"announced":{"note":"annoncé","source":"blog"},"unavailable":true},
                          {"id":"gpt-image","label":"gpt-image","caps":["image-gen"]}],"fetchedAt":"2026-10-20T07:00:00.000Z"},
      "nvidia":{"models":[{"id":"moonshotai/kimi-k3","label":"kimi-k3","caps":["text"],"missing":true}],"error":"504","stale":true},
      "openrouter":{"models":[{"id":"google/gemini-3","label":"gemini-3","caps":["text","vision"]}],"disabled":true,"keyPresent":false,"keyWhere":[]},
      "local":{"models":[{"id":"imagemagick","label":"ImageMagick","caps":["image-proc","thumbnails"],"installed":true},
                         {"id":"opencv","label":"OpenCV (Python)","caps":["image-proc","thumbnails"],"installed":false}],"source":"PATH"}
     },
     "removed":[{"provider":"anthropic","model":"claude-old","reason":"retiré par l’éditeur","source":"§2"}]}
    """

    private val routing get() = parseRouting(j(routingJson))!!
    private val catalog get() = parseCatalog(j(catalogJson))

    @Test fun parsesPipelinesFlowLoopsVariantsAndRefs() {
        val r = routing
        assertEquals(listOf("dev", "images"), r.pipelines.map { it.id })
        val dev = r.pipelines[0]
        assertEquals("Canon TDD — Kent Beck", dev.sourceLabel)
        assertEquals(listOf("Bugfix" to "4a reproduit le bug."), dev.variantsInfo)
        val loop = dev.flow[3] as FlowNode.Loop
        assertEquals(listOf("rouge", "vert"), loop.steps.map { it.id })
        assertEquals("vert", loop.backFrom)
        val first = (dev.flow[0] as FlowNode.StepNode).step
        assertEquals(2, first.variants.size)
        assertEquals("vision", first.variants[1].need!!.llm)
        assertEquals("audit", (dev.flow[4] as FlowNode.StepNode).step.ref!!.pipeline)
        assertEquals(6, stepsOf(dev).size)
        assertEquals("claude-sonnet-5", r.assignments["dev.rouge"]!!.second!!.model)
        assertEquals(7, r.historyTotal)
        assertEquals("second", r.history[1].role)
        assertFalse(r.agentHarness["nvidia"]!!)
    }

    @Test fun oldServerWithoutPipelinesIsNull() {
        assertNull(parseRouting(j("""{"ok":true,"assignments":{}}""")))
    }

    @Test fun actionStepMenuFiltersByCapsAndGreysUnharnessedProviders() {
        val m = buildMenu(routing.slot("dev.comprendre")!!, catalog, routing, second = false)
        assertEquals("(défaut du projet)", m.emptyLabel)
        assertEquals(listOf("anthropic", "openai", "nvidia", "openrouter"), m.groups.map { it.provider })
        val oai = m.groups[1]
        // image-only model filtered out; announced one visible but not selectable
        assertEquals(listOf("gpt-5.5", "gpt-6-astra"), oai.options.map { it.value.substringAfter("|") })
        assertTrue(oai.options[1].disabled)
        assertFalse(m.selectable("openai|gpt-6-astra"))
        val nv = m.groups[2]
        assertTrue(nv.disabled)
        assertEquals("NVIDIA — 🔧 outillage en construction : pas encore pour une étape d’action (1)", nv.label)
        val ant = m.groups[0]
        assertEquals("Anthropic (2)", ant.label)
        assertTrue(ant.options[1].dominated)
        assertEquals("claude-haiku-4 · dominé", ant.options[1].label)
        assertEquals("Dominé par claude-haiku-5-5 : moins bon et plus cher (source : §3)", ant.options[1].title)
    }

    @Test fun judgeStepAllowsUnharnessedButNotKeylessOpenRouter() {
        val m = buildMenu(routing.slot("dev.liste-tests")!!, catalog, routing, second = false)
        assertFalse(m.groups[2].disabled)  // NVIDIA allowed on a judgement step
        val or = m.groups[3]
        assertTrue(or.disabled)
        assertEquals("OpenRouter — clé non configurée (1)", or.label)
    }

    @Test fun variantAndSecondEmptyLabels() {
        assertEquals("(model de l’étape)", buildMenu(routing.slot("dev.comprendre.codebase")!!, catalog, routing, false).emptyLabel)
        assertEquals("(aucun — exécution simple)", buildMenu(routing.slot("dev.comprendre")!!, catalog, routing, true).emptyLabel)
    }

    @Test fun mediaStepsShowLocalToolsAndNoLlmGroups() {
        val gen = buildMenu(routing.slot("images.generer")!!, catalog, routing, false)
        assertEquals("Anthropic — aucun model « génération d’images »", gen.groups[0].label)
        assertTrue(gen.groups[0].disabled)
        assertEquals(listOf("openai|gpt-image"), gen.groups[1].options.map { it.value })
        val local = gen.groups.last()
        assertEquals("local", local.provider)
        assertEquals("Outil local / non-LLM (1 installé)", local.label)
        assertTrue(gen.selectable("local|imagemagick"))
        assertFalse(gen.selectable("local|opencv"))
        val mini = buildMenu(routing.slot("images.miniatures")!!, catalog, routing, false)
        assertEquals("Anthropic — un LLM ne convient pas ici", mini.groups[0].label)
        assertTrue(mini.groups.filter { it.provider != "local" }.all { it.disabled })
    }

    @Test fun currentChoiceLabelsIncludingObsolete() {
        val r = routing
        val m = buildMenu(r.slot("dev.liste-tests")!!, catalog, r, false)
        assertEquals("⚠ obsolète : claude-old (retiré — retiré par l’éditeur)", currentLabel(m, "anthropic|claude-old", catalog))
        assertEquals("Anthropic · claude-x (absent de la liste ou incompatible)", currentLabel(m, "anthropic|claude-x", catalog))
        assertEquals("claude-opus-5-5", currentLabel(m, "anthropic|claude-opus-5-5", catalog))
        assertEquals("(défaut du projet)", currentLabel(m, "", catalog))
        assertEquals(listOf("⚠ claude-old est obsolète (retiré par l’éditeur). Votre choix est conservé : changez-le quand vous voulez."),
            obsoleteWarnings(r, catalog, "dev.liste-tests"))
    }

    @Test fun putBodies() {
        val b = choiceBody("openrouter|google/gemini-3", second = false)
        assertEquals("openrouter", b["provider"]!!.jsonPrimitive.content)
        assertEquals("google/gemini-3", b["model"]!!.jsonPrimitive.content)
        assertEquals("android", b["by"]!!.jsonPrimitive.content)
        assertFalse(b.containsKey("role"))
        val d = choiceBody("", second = true)
        assertEquals("true", d["default"]!!.jsonPrimitive.content)
        assertEquals("second", d["role"]!!.jsonPrimitive.content)
    }

    @Test fun savedStatusShowsWarning() {
        val zone = ZoneId.of("UTC")
        val now = Instant.parse("2026-10-20T12:00:00Z")
        val s = savedStatus(j("""{"ok":true,"updatedAt":"2026-10-20T09:05:00.000Z","warning":"principal et second identiques"}"""), true, now, zone)
        assertEquals("✓ enregistré (second) · 09:05 — ⚠ principal et second identiques", s)
        assertEquals("20/10 09:05", fmtTime("2026-10-20T09:05:00Z", Instant.parse("2026-10-22T00:00:00Z"), zone))
    }

    @Test fun dualNoteAndAdvice() {
        val r = routing
        assertTrue(dualNote(r, "dev.rouge")!!.startsWith("×2 : gpt-5.5 et claude-sonnet-5 travaillent en parallèle"))
        assertNull(dualNote(r, "dev.vert"))
        val w = adviceWarnings("dev", r.assignments)
        assertEquals("même model que 4a : la preuve n’est plus indépendante (conseil : un model différent).", w["dev.vert"])
        assertEquals("même model que 4b (conseil : un model différent).", w["dev.rouge"])
    }

    @Test fun summaryTabCountsAndLoops() {
        val r = routing
        assertEquals("4/9 cases affectées", summaryText(r))
        assertEquals("4/7", tabCount(r, "dev"))
        val lines = loopsLines(r.pipelines[0], r.pipelines)
        assertEquals("↻ 4b Vert → 4a Rouge — test suivant", lines[0])
        assertEquals("↩ S Spike → 3 Liste de tests — on jette l’essai, retour à 3", lines[1])
        assertEquals("⤳ 5 Audit → pipeline audit — voir l’audit", lines[2])
        assertEquals(listOf("S Spike"), incomingFrom(r.pipelines[0], "liste-tests"))
        assertEquals("Exige : un model capable de génération d’images ou un outil local.", needText(r.slot("images.generer")!!.need, r.caps))
        assertNull(needText(Need("text", emptyList()), r.caps))
        val dist = distributionText(r, "dev")
        assertEquals("ANT 2 · OAI 2 · hérité 3 · ×2 1", dist)
    }

    @Test fun historyAndSources() {
        val zone = ZoneId.of("UTC")
        val now = Instant.parse("2026-10-20T12:00:00Z")
        val h = historyLines(routing, now, zone)
        assertEquals("08:00 · Développement · 1 Comprendre : (hérité) → anthropic:claude-opus-5-5", h[0])
        assertEquals("19/10 08:00 · Développement · 4a Rouge (second) : (hérité) → anthropic:claude-sonnet-5 · android", h[1])
        val src = sourcesLines(catalog, routing)
        assertTrue(src[3].contains("clé non configurée"))
        assertTrue(src[2].contains("1 model(s) du failover absent(s) du catalogue"))
        assertTrue(src[2].contains("504 — dernière liste connue"))
        assertEquals("LOCAL Outils locaux 1/2 installés : imagemagick", src[4])
    }

    @Test fun catalogParsingKeepsFlags() {
        val c = catalog
        assertTrue(c.providers["openrouter"]!!.disabled)
        assertNotNull(removedInfo(c, "anthropic", "claude-old"))
        assertTrue(c.providers["nvidia"]!!.models[0].missing)
    }
}
