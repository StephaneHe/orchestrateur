package com.orchestrateur.ui.models

import com.orchestrateur.data.a
import com.orchestrateur.data.b
import com.orchestrateur.data.entries
import com.orchestrateur.data.i
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import com.orchestrateur.data.str
import com.orchestrateur.data.strs
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// Pure logic of the Models page (mirror of public/models.js): parsing of
// /api/model-routing and /api/model-catalog, menus, request bodies, labels.

val LLM_PROVIDERS = listOf("anthropic", "openai", "nvidia", "openrouter")
val PLABEL = mapOf("anthropic" to "Anthropic", "openai" to "OpenAI", "nvidia" to "NVIDIA", "openrouter" to "OpenRouter", "local" to "Outil local / non-LLM")
val PSHORT = mapOf("anthropic" to "ANT", "openai" to "OAI", "nvidia" to "NV", "openrouter" to "OR", "local" to "LOCAL")

data class Need(val llm: String?, val local: List<String>)
data class Slot(val id: String, val pipeline: String, val step: String, val variant: String?, val label: String, val need: Need, val judge: Boolean)
data class Choice(val provider: String, val model: String, val at: String?, val second: Choice?) {
    val value: String get() = "$provider|$model"
}
data class Ret(val to: String, val label: String)
data class Ref(val pipeline: String, val label: String)
data class Variant(val id: String, val label: String, val what: String, val need: Need?, val custom: Boolean)
data class Step(
    val id: String, val n: String, val title: String, val what: String, val example: String,
    val optional: String?, val custom: Boolean, val advice: String?, val judge: Boolean, val need: Need?,
    val returns: List<Ret>, val ref: Ref?, val variants: List<Variant>,
)
sealed interface FlowNode {
    data class StepNode(val step: Step) : FlowNode
    data class Loop(val id: String, val n: String, val title: String, val what: String, val steps: List<Step>,
                    val backFrom: String, val backTo: String, val backLabel: String) : FlowNode
}
data class Pipeline(
    val id: String, val label: String, val icon: String, val purpose: String, val whenText: String,
    val sourceLabel: String?, val variantsInfo: List<Pair<String, String>>, val advice: List<String>,
    val custom: Boolean, val flow: List<FlowNode>,
)
data class HistEntry(val at: String?, val task: String, val role: String?, val from: String?, val to: String?, val by: String?)
data class Migration(val at: String?, val mapped: Int, val lost: List<String>)
data class Routing(
    val pipelines: List<Pipeline>, val slots: List<Slot>, val caps: Map<String, String>,
    val agentHarness: Map<String, Boolean>, val assignments: Map<String, Choice>, val updatedAt: String?,
    val history: List<HistEntry>, val historyTotal: Int, val migration: Migration?,
) {
    fun slot(id: String) = slots.firstOrNull { it.id == id }
    fun pipeline(id: String?) = pipelines.firstOrNull { it.id == id }
    fun slotLabel(id: String) = slot(id)?.label ?: id
}

private fun parseNeed(j: JsonElement?): Need? {
    if (j !is JsonObject) return null
    return Need(j.s("llm"), j.strs("local"))
}

private fun parseChoice(j: JsonElement?): Choice? {
    val p = j.s("provider") ?: return null
    val m = j.s("model") ?: return null
    return Choice(p, m, j.s("at"), parseChoice(j.o("second")))
}

private fun parseStep(j: JsonElement): Step = Step(
    id = j.s("id") ?: "", n = j.s("n") ?: "", title = j.s("title") ?: "", what = j.s("what") ?: "",
    example = j.s("example") ?: "", optional = j.s("optional"), custom = j.b("custom"), advice = j.s("advice"),
    judge = j.b("judge"), need = parseNeed(j.o("need")),
    returns = j.a("returns").map { Ret(it.s("to") ?: "", it.s("label") ?: "") },
    ref = j.o("ref")?.let { r -> r.s("pipeline")?.let { Ref(it, r.s("label") ?: "") } },
    variants = j.a("variants").map { Variant(it.s("id") ?: "", it.s("label") ?: "", it.s("what") ?: "", parseNeed(it.o("need")), it.b("custom")) },
)

/** /api/model-routing; null for a server older than 0.40.0 (no pipelines). */
fun parseRouting(j: JsonElement?): Routing? {
    if (j.o("pipelines") == null) return null
    val pipelines = j.a("pipelines").map { p ->
        Pipeline(
            id = p.s("id") ?: "", label = p.s("label") ?: "", icon = p.s("icon") ?: "",
            purpose = p.s("purpose") ?: "", whenText = p.s("when") ?: "",
            sourceLabel = p.o("source").s("label"),
            variantsInfo = p.a("variantsInfo").map { (it.s("label") ?: "") to (it.s("text") ?: "") },
            advice = p.strs("advice"), custom = p.b("custom"),
            flow = p.a("flow").map { n ->
                if (n.s("kind") == "loop") FlowNode.Loop(
                    n.s("id") ?: "", n.s("n") ?: "", n.s("title") ?: "", n.s("what") ?: "",
                    n.a("steps").map(::parseStep),
                    n.o("back").s("from") ?: "", n.o("back").s("to") ?: "", n.o("back").s("label") ?: "",
                ) else FlowNode.StepNode(parseStep(n))
            },
        )
    }
    val slots = j.a("slots").map { s ->
        Slot(s.s("id") ?: "", s.s("pipeline") ?: "", s.s("step") ?: "", s.s("variant"), s.s("label") ?: "",
            parseNeed(s.o("need")) ?: Need("text", emptyList()), s.b("judge"))
    }
    val m = j.o("migration")
    return Routing(
        pipelines = pipelines, slots = slots,
        caps = j.o("caps").entries.associate { (k, v) -> k to (v.str ?: k) },
        agentHarness = j.o("agentHarness").entries.associate { (k, v) -> k to ((v as? JsonPrimitive)?.content == "true") },
        assignments = j.o("assignments").entries.mapNotNull { (k, v) -> parseChoice(v)?.let { k to it } }.toMap(),
        updatedAt = j.s("updatedAt"),
        history = j.a("history").map { HistEntry(it.s("at"), it.s("task") ?: "", it.s("role"), it.s("from"), it.s("to"), it.s("by")) },
        historyTotal = j.i("historyTotal") ?: 0,
        migration = m?.let { Migration(it.s("at"), it.a("mapped").size, it.a("lost").map { x -> "${x.s("from")} (${x.s("model") ?: "?"}) : perdue — ${x.s("reason") ?: ""}" }) },
    )
}

fun stepsOf(p: Pipeline): List<Step> = p.flow.flatMap { n ->
    when (n) { is FlowNode.Loop -> n.steps; is FlowNode.StepNode -> listOf(n.step) }
}

// ---- Catalog ----

data class Dominated(val by: String, val reason: String, val source: String)
data class CatModel(
    val id: String, val label: String, val caps: List<String>, val dominated: Dominated?,
    val announcedNote: String?, val announcedSource: String?, val unavailable: Boolean, val hint: String?,
    val installed: Boolean, val missing: Boolean,
)
data class ProviderSrc(
    val models: List<CatModel>, val disabled: Boolean, val keyPresent: Boolean, val keyWhere: List<String>,
    val error: String?, val stale: Boolean, val fetchedAt: String?, val source: String?,
)
data class Removed(val provider: String, val model: String, val reason: String, val source: String)
data class Catalog(val providers: Map<String, ProviderSrc>, val removed: List<Removed>)

fun parseCatalog(j: JsonElement?): Catalog = Catalog(
    providers = j.o("providers").entries.associate { (k, v) ->
        k to ProviderSrc(
            models = v.a("models").map { m ->
                CatModel(
                    id = m.s("id") ?: "", label = m.s("label") ?: m.s("id") ?: "", caps = m.strs("caps"),
                    dominated = m.o("dominated")?.let { Dominated(it.s("by") ?: "", it.s("reason") ?: "", it.s("source") ?: "") },
                    announcedNote = m.o("announced").s("note"), announcedSource = m.o("announced").s("source"),
                    unavailable = m.b("unavailable"), hint = m.s("hint"), installed = m.b("installed"), missing = m.b("missing"),
                )
            },
            disabled = v.b("disabled"), keyPresent = v.b("keyPresent"), keyWhere = v.strs("keyWhere"),
            error = v.s("error"), stale = v.b("stale"), fetchedAt = v.s("fetchedAt"), source = v.s("source"),
        )
    },
    removed = j.a("removed").map { Removed(it.s("provider") ?: "", it.s("model") ?: "", it.s("reason") ?: "", it.s("source") ?: "") },
)

fun removedInfo(c: Catalog?, provider: String, model: String): Removed? =
    c?.removed?.firstOrNull { it.provider == provider && it.model == model }

// ---- Menus (same rules as optionsFor() in models.js) ----

data class MenuOption(val value: String, val label: String, val title: String?, val disabled: Boolean, val dominated: Boolean)
data class MenuGroup(val provider: String, val label: String, val disabled: Boolean, val options: List<MenuOption>)
data class Menu(val emptyLabel: String, val groups: List<MenuGroup>) {
    fun find(value: String): Pair<MenuGroup, MenuOption>? =
        groups.firstNotNullOfOrNull { g -> g.options.firstOrNull { it.value == value }?.let { g to it } }
    fun selectable(value: String): Boolean = find(value)?.let { (g, o) -> !g.disabled && !o.disabled } ?: false
    val optionCount: Int get() = groups.sumOf { it.options.size }
}

fun buildMenu(slot: Slot, catalog: Catalog?, routing: Routing?, second: Boolean): Menu {
    val need = slot.need
    val isVariant = slot.variant != null
    // An action step needs an agent harness: providers without one are not selectable there.
    val action = need.llm == "text" && !slot.judge
    val capLabel = { c: String -> routing?.caps?.get(c) ?: c }
    val groups = mutableListOf<MenuGroup>()
    for (p in LLM_PROVIDERS) {
        val c = catalog?.providers?.get(p)
        val all = c?.models ?: emptyList()
        val ok = if (need.llm != null) all.filter { need.llm in it.caps } else emptyList()
        val name = PLABEL[p] ?: p
        var label = "$name (${ok.size})"
        var disabled = false
        when {
            need.llm == null -> { label = "$name — un LLM ne convient pas ici"; disabled = true }
            all.isEmpty() -> { label = "$name — liste indisponible"; disabled = true }
            ok.isEmpty() -> { label = "$name — aucun model « ${capLabel(need.llm)} »"; disabled = true }
            action && routing?.agentHarness?.get(p) == false -> {
                label = "$name — 🔧 outillage en construction : pas encore pour une étape d’action (${ok.size})"; disabled = true
            }
            p == "openrouter" && c?.disabled == true -> { label = "$name — clé non configurée (${ok.size})"; disabled = true }
        }
        groups += MenuGroup(p, label, disabled, ok.map { m ->
            val title = when {
                m.dominated != null -> "Dominé par ${m.dominated.by} : ${m.dominated.reason} (source : ${m.dominated.source})"
                m.announcedNote != null -> "${m.announcedNote} (source : ${m.announcedSource})"
                else -> m.hint
            }
            MenuOption("$p|${m.id}", m.label + if (m.dominated != null) " · dominé" else "", title, m.unavailable, m.dominated != null)
        })
    }
    if (need.local.isNotEmpty()) {
        val tools = (catalog?.providers?.get("local")?.models ?: emptyList()).filter { t -> t.caps.any { it in need.local } }
        val n = tools.count { it.installed }
        groups += MenuGroup("local", "${PLABEL["local"]} ($n installé${if (n > 1) "s" else ""})", false,
            tools.map { MenuOption("local|${it.id}", it.label, if (it.installed) null else "non installé", !it.installed, false) })
    }
    val empty = when {
        second -> "(aucun — exécution simple)"
        isVariant -> "(model de l’étape)"
        else -> "(défaut du projet)"
    }
    return Menu(empty, groups)
}

/** What the picker shows for the saved [value]: an absent or retired choice stays visible. */
fun currentLabel(menu: Menu, value: String, catalog: Catalog?): String {
    if (value.isEmpty()) return menu.emptyLabel
    if (menu.selectable(value)) return menu.find(value)!!.second.label
    val p = value.substringBefore("|")
    val model = value.substringAfter("|")
    val gone = removedInfo(catalog, p, model)
    return if (gone != null) "⚠ obsolète : $model (retiré — ${gone.reason})"
    else "${PLABEL[p] ?: p} · $model (absent de la liste ou incompatible)"
}

fun obsoleteWarnings(r: Routing, c: Catalog?, slotId: String): List<String> {
    val a = r.assignments[slotId]
    return listOfNotNull(a, a?.second).mapNotNull { x ->
        removedInfo(c, x.provider, x.model)?.let { "⚠ ${x.model} est obsolète (${it.reason}). Votre choix est conservé : changez-le quand vous voulez." }
    }
}

/** PUT /api/model-routing/:slot body. */
fun choiceBody(value: String, second: Boolean): JsonObject = buildJsonObject {
    if (value.isEmpty()) put("default", true)
    else { put("provider", value.substringBefore("|")); put("model", value.substringAfter("|")) }
    if (second) put("role", "second")
    put("by", "android")
}

fun fmtTime(iso: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val t = iso?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return ""
    val d = t.atZone(zone)
    val today = d.toLocalDate() == now.atZone(zone).toLocalDate()
    return d.format(DateTimeFormatter.ofPattern(if (today) "HH:mm" else "dd/MM HH:mm"))
}

fun savedStatus(resp: JsonElement?, second: Boolean, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val at = resp.s("updatedAt") ?: now.toString()
    val warn = resp.s("warning")
    return "✓ enregistré${if (second) " (second)" else ""} · ${fmtTime(at, now, zone)}${if (warn != null) " — ⚠ $warn" else ""}"
}

/** Default status line of a slot (no action in progress). */
fun idleStatus(r: Routing, slotId: String): String =
    r.assignments[slotId]?.at?.let { "✓ enregistré · ${fmtTime(it)}" } ?: ""

fun shortModel(a: Choice?): String {
    if (a == null) return ""
    return if (a.model.length > 26) a.model.take(25) + "…" else a.model
}

fun providerTag(a: Choice?): String = if (a == null) "défaut" else "${PSHORT[a.provider] ?: a.provider} · ${shortModel(a)}"

fun dualNote(r: Routing, slotId: String): String? {
    val a = r.assignments[slotId]
    val b = a?.second ?: return null
    if (a.provider == b.provider && a.model == b.model) return "⚠ principal et second identiques : le mode double n’apporte presque rien."
    return "×2 : ${shortModel(a)} et ${shortModel(b)} travaillent en parallèle, chacun de son côté, puis ${shortModel(a)} relit et garde le meilleur — coût ≈ ×2,5, durée ≈ la plus longue des deux + la relecture."
}

/** Family of a model, for the « autre famille » advice. */
fun family(a: Choice?): String? {
    if (a == null || a.provider == "local") return null
    if (a.provider == "anthropic") return "Claude"
    if (a.provider == "openai") return "GPT"
    val v = a.model.removePrefix("~").substringBefore("/").lowercase()
    val map = mapOf("anthropic" to "Claude", "openai" to "GPT", "google" to "Gemini", "meta" to "Llama", "meta-llama" to "Llama",
        "deepseek-ai" to "DeepSeek", "deepseek" to "DeepSeek", "moonshotai" to "Kimi", "qwen" to "Qwen", "z-ai" to "GLM",
        "mistralai" to "Mistral", "nv-mistralai" to "Mistral", "nvidia" to "Nemotron", "x-ai" to "Grok")
    return map[v] ?: v
}

/** Non-binding advice: slot → warning text (without the leading ⚠). */
fun adviceWarnings(pipelineId: String, asg: Map<String, Choice>): Map<String, String> {
    val out = mutableMapOf<String, String>()
    fun same(x: Choice?, y: Choice?) = x != null && y != null && x.provider == y.provider && x.model == y.model
    if (pipelineId == "dev") {
        val vert = asg["dev.vert"]; val rouge = asg["dev.rouge"]; val liste = asg["dev.liste-tests"]
        val clash = listOfNotNull(if (same(rouge, vert)) "4a" else null, if (same(liste, vert)) "3" else null)
        if (clash.isNotEmpty()) out["dev.vert"] = "même model que ${clash.joinToString(" et ")} : la preuve n’est plus indépendante (conseil : un model différent)."
        if (same(rouge, vert)) out["dev.rouge"] = "même model que 4b (conseil : un model différent)."
        if (same(liste, vert)) out["dev.liste-tests"] = "même model que 4b (conseil : un model différent)."
    }
    if (pipelineId == "audit") {
        val f1 = family(asg["audit.revue-manuelle"]); val f2 = family(asg["audit.second-avis"])
        if (f1 != null && f1 == f2) out["audit.second-avis"] = "même famille ($f1) que la revue manuelle (conseil : une autre famille)."
    }
    return out
}

fun summaryText(r: Routing): String = "${r.slots.count { r.assignments.containsKey(it.id) }}/${r.slots.size} cases affectées"

fun tabCount(r: Routing, pipelineId: String): String {
    val s = r.slots.filter { it.pipeline == pipelineId }
    return "${s.count { r.assignments.containsKey(it.id) }}/${s.size}"
}

fun distributionText(r: Routing, pipelineId: String): String {
    val slots = r.slots.filter { it.pipeline == pipelineId }
    val counts = mutableMapOf<String, Int>()
    for (s in slots) { val k = r.assignments[s.id]?.provider ?: "inherit"; counts[k] = (counts[k] ?: 0) + 1 }
    val parts = (LLM_PROVIDERS + "local").filter { (counts[it] ?: 0) > 0 }.map { "${PSHORT[it]} ${counts[it]}" }.toMutableList()
    counts["inherit"]?.let { parts += "hérité $it" }
    val duals = slots.count { r.assignments[it.id]?.second != null }
    if (duals > 0) parts += "×2 $duals"
    return parts.joinToString(" · ")
}

private fun stepIndex(p: Pipeline): Map<String, Pair<String, String>> {
    val m = mutableMapOf<String, Pair<String, String>>()
    for (n in p.flow) when (n) {
        is FlowNode.Loop -> { m[n.id] = n.n to n.title; n.steps.forEach { m[it.id] = it.n to it.title } }
        is FlowNode.StepNode -> m[n.step.id] = n.step.n to n.step.title
    }
    return m
}

/** « Boucles, retours et renvois » lines. */
fun loopsLines(p: Pipeline, all: List<Pipeline>): List<String> {
    val by = stepIndex(p)
    fun name(id: String) = by[id]?.let { "${it.first} ${it.second}" } ?: id
    val rows = mutableListOf<String>()
    for (n in p.flow) if (n is FlowNode.Loop) rows += "↻ ${name(n.backFrom)} → ${name(n.backTo)} — ${n.backLabel}"
    for (s in stepsOf(p)) for (r in s.returns) rows += "↩ ${s.n} ${s.title} → ${name(r.to)} — ${r.label}"
    for (s in stepsOf(p)) s.ref?.let { ref ->
        rows += "⤳ ${s.n} ${s.title} → pipeline ${all.firstOrNull { it.id == ref.pipeline }?.label ?: ref.pipeline} — ${ref.label}"
    }
    return rows
}

/** Steps whose « retour » points to [stepId] (shown as « ⟲ point de retour depuis … »). */
fun incomingFrom(p: Pipeline, stepId: String): List<String> =
    stepsOf(p).filter { s -> s.returns.any { it.to == stepId } }.map { "${it.n} ${it.title}" }

fun returnLines(p: Pipeline, s: Step): List<String> {
    val by = stepIndex(p)
    return s.returns.map { r -> "↩ retour vers ${by[r.to]?.let { "${it.first} ${it.second}" } ?: r.to} — ${r.label}" }
}

fun needText(need: Need?, caps: Map<String, String>): String? {
    if (need == null || (need.llm == "text" && need.local.isEmpty())) return null
    val parts = mutableListOf<String>()
    if (need.llm != null) parts += "un model capable de ${caps[need.llm] ?: need.llm}"
    if (need.local.isNotEmpty()) parts += "un outil local"
    return "Exige : ${parts.joinToString(" ou ")}."
}

fun historyLines(r: Routing, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<String> = r.history.map { e ->
    "${fmtTime(e.at, now, zone)} · ${r.slotLabel(e.task)}${if (e.role == "second") " (second)" else ""} : ${e.from ?: "(hérité)"} → ${e.to ?: "(hérité)"}" +
        if (e.by != null && e.by != "dashboard") " · ${e.by}" else ""
}

/** « D’où viennent les listes » lines. */
fun sourcesLines(c: Catalog?, r: Routing?): List<String> {
    val out = LLM_PROVIDERS.map { p ->
        val s = c?.providers?.get(p)
        val n = s?.models?.size ?: 0
        var extra = ""
        if (p == "openrouter") extra = if (s?.keyPresent == true) " · clé présente (${s.keyWhere.joinToString(", ")})" else " · clé non configurée"
        if (r?.agentHarness?.get(p) == false) extra += " · 🔧 outillage d’agent en construction (étapes de jugement seulement)"
        if (p == "nvidia") { val miss = s?.models?.count { it.missing } ?: 0; if (miss > 0) extra += " · $miss model(s) du failover absent(s) du catalogue" }
        val err = s?.error?.let { " · $it${if (s.stale) " — dernière liste connue" else ""}" } ?: ""
        val whenTxt = s?.fetchedAt?.let { if (p == "anthropic") " · vérifiée le ${it.take(10)}" else " · ${fmtTime(it).ifEmpty { it }}" } ?: ""
        "${PSHORT[p]} ${PLABEL[p]} $n models$whenTxt$extra$err"
    }.toMutableList()
    val loc = c?.providers?.get("local")?.models ?: emptyList()
    val inst = loc.filter { it.installed }
    out += "LOCAL Outils locaux ${inst.size}/${loc.size} installés : ${inst.joinToString(", ") { it.id }.ifEmpty { "aucun" }}"
    return out
}
