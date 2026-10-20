package com.orchestrateur.ui.models

import com.orchestrateur.data.a
import com.orchestrateur.data.b
import com.orchestrateur.data.entries
import com.orchestrateur.data.i
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import com.orchestrateur.data.strs
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

// Pure logic of the Models page side panels: suggestions (0.46.0), health
// (phase 7), observation (phase 1), gaps (0.42.0), API keys (0.43.0) and
// model languages (0.51.0).

private fun JsonElement?.triBool(k: String): Boolean? = (o(k) as? JsonPrimitive)?.booleanOrNull

// ---------------------------------------------------------------- Suggestions

data class RecoRef(
    val provider: String?, val model: String?, val external: String?, val effort: String?, val note: String?,
    val applicable: Boolean, val reason: String?, val target: Boolean, val available: Boolean?, val today: RecoRef?,
)
data class SlotReco(
    val principal: RecoRef, val alternatives: List<RecoRef>, val confidence: String, val undecided: Boolean,
    val extrapolated: String?, val inherited: Boolean, val section: String, val why: String, val note: String?,
)
data class RecoReport(val date: String, val file: String, val commit: String?, val author: String?, val redoHint: String?)
data class Reco(
    val report: RecoReport?, val ageLevel: String?, val ageDays: Int, val slots: Map<String, SlotReco>,
    val countSlots: Int, val withSuggestion: Int, val applicable: Int, val undecided: Int,
)

private fun parseRef(j: JsonElement?): RecoRef? {
    if (j !is JsonObject) return null
    return RecoRef(j.s("provider"), j.s("model"), j.s("external"), j.s("effort"), j.s("note"), j.b("applicable"),
        j.s("reason"), j.b("target"), j.triBool("available"), parseRef(j.o("today")))
}

/** /api/model-recommendations; null when the server has none (older than 0.46.0 or invalid file). */
fun parseReco(j: JsonElement?): Reco? {
    if (j.o("slots") == null) return null
    val rep = j.o("report")
    return Reco(
        report = rep?.let { RecoReport(it.s("date") ?: "", it.s("file") ?: "", it.s("commit"), it.s("author"), it.s("redoHint")) },
        ageLevel = j.o("age").s("level"), ageDays = j.o("age").i("days") ?: 0,
        slots = j.o("slots").entries.mapNotNull { (k, v) ->
            val p = parseRef(v.o("principal")) ?: return@mapNotNull null
            k to SlotReco(p, v.a("alternatives").mapNotNull { parseRef(it) }, v.s("confidence") ?: "", v.b("undecided"),
                v.s("extrapolated"), v.b("inherited"), v.s("section") ?: "", v.s("why") ?: "", v.s("note"))
        }.toMap(),
        countSlots = j.o("counts").i("slots") ?: 0, withSuggestion = j.o("counts").i("withSuggestion") ?: 0,
        applicable = j.o("counts").i("applicable") ?: 0, undecided = j.o("counts").i("undecided") ?: 0,
    )
}

fun refText(r: RecoRef?): String {
    if (r == null) return ""
    if (r.external != null) return r.external + (r.note?.let { " ($it)" } ?: "")
    return (r.model ?: "") + (r.effort?.let { " · effort $it" } ?: "") + (r.note?.let { " ($it)" } ?: "")
}

fun altText(a: RecoRef): String {
    if (a.external != null) return refText(a)
    if (a.target && a.available != true) {
        return "${a.model} (cible : pas encore dans codex)" + (a.today?.let { " → aujourd’hui ${refText(it)}" } ?: "")
    }
    return (a.model ?: "") + (if (a.target) " (cible, désormais disponible)" else "") + (a.note?.let { " ($it)" } ?: "") +
        if (a.available == false) " — indisponible ici" else ""
}

data class RecoState(val text: String, val followed: Boolean)

fun recoState(r: SlotReco, assigned: Choice?): RecoState {
    val p = r.principal
    val followed = assigned != null && p.external == null && assigned.provider == p.provider && assigned.model == p.model
    val text = when {
        !p.applicable -> "non applicable ici : ${p.reason ?: ""}"
        followed -> "✓ suivie"
        assigned != null -> "votre choix est différent (conservé)"
        else -> ""
    }
    return RecoState(text, followed)
}

fun recoAgeText(r: Reco): String? {
    val hint = r.report?.redoHint
    return when (r.ageLevel) {
        "stale" -> "⚠ Rapport de ${r.ageDays} jours : dépassé — ${hint ?: "à refaire"}."
        "aging" -> "⚠ Rapport de ${r.ageDays} jours : il vieillit — ${hint ?: "à refaire d’ici 1-2 mois"}."
        else -> null
    }
}

fun recoBoxText(r: Reco): String {
    val rep = r.report ?: return ""
    val date = runCatching { LocalDate.parse(rep.date).format(DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.FRENCH)) }.getOrDefault(rep.date)
    return "💡 Suggestions de l’étude comparative du $date (${rep.file}${rep.commit?.let { ", commit $it" } ?: ""}) : " +
        "${r.withSuggestion} cases sur ${r.countSlots} ont une suggestion, dont ${r.applicable} applicables ici ; " +
        "${r.undecided} relèvent d’étapes que le rapport juge non tranchées. Rien n’est modifié sans votre clic."
}

fun recoSourceText(r: Reco, s: SlotReco): String {
    val rep = r.report
    return "Source : rapport du ${rep?.date ?: "?"}, ${s.section} — ${rep?.file ?: ""}${rep?.commit?.let { " (commit $it)" } ?: ""}. ${rep?.author ?: ""}".trim()
}

/** POST /api/model-routing/apply-suggestions body. */
fun applyBody(mode: String, slot: String?, dryRun: Boolean): JsonObject = buildJsonObject {
    put("mode", mode)
    putJsonArray("slots") { if (mode == "one" && slot != null) add(JsonPrimitive(slot)) }
    if (dryRun) put("dryRun", true)
    put("by", "android")
}

data class PlanItem(val slot: String, val provider: String, val model: String, val from: String?)
data class ApplyPlan(val mode: String, val items: List<PlanItem>, val skipped: List<Pair<String, String>>)

fun parsePlan(j: JsonElement?, mode: String) = ApplyPlan(
    mode,
    j.a("plan").map { PlanItem(it.s("slot") ?: "", it.s("provider") ?: "", it.s("model") ?: "", it.s("from")) },
    j.a("skipped").map { (it.s("slot") ?: "") to (it.s("reason") ?: "") },
)

fun confirmHead(p: ApplyPlan): String {
    if (p.mode == "empty") {
        val why = LinkedHashMap<String, Int>()
        for ((_, reason) in p.skipped) why[reason] = (why[reason] ?: 0) + 1
        val skipped = why.entries.joinToString(" · ") { "${it.value} ${it.key}" }
        return "${p.items.size} case(s) vide(s) recevront la suggestion.${if (skipped.isNotEmpty()) " Laissées telles quelles : $skipped." else ""}"
    }
    return if (p.items.firstOrNull()?.from != null) "Remplacer votre choix par la suggestion ?" else "Affecter la suggestion à cette case ?"
}

fun planLine(p: PlanItem): String = (p.from?.let { "$it → " } ?: "") + "${p.provider}:${p.model}"

data class ApplyResult(val statuses: Map<String, String>, val notice: String?)

fun applyResult(j: JsonElement?, mode: String, time: String): ApplyResult {
    val applied = j.a("applied"); val failed = j.a("failed")
    val st = LinkedHashMap<String, String>()
    for (a in applied) st[a.s("slot") ?: ""] = "✓ suggestion appliquée · $time"
    for (f in failed) st[f.s("slot") ?: ""] = "✕ non appliquée : ${f.s("error") ?: ""}"
    val notice = if (mode == "empty") "${applied.size} case(s) vide(s) remplie(s) avec la suggestion${if (failed.isNotEmpty()) ", ${failed.size} en échec" else ""}." else null
    return ApplyResult(st, notice)
}

// --------------------------------------------------------------------- Health

data class HealthRow(val label: String, val runs: Int, val hors: Int, val ordinaires: Int, val refus: Int, val porte: Int, val pauses: Int) {
    val bypass: Int get() = hors + ordinaires
    val text: String get() = "Exécutions $runs · Hors pipeline $hors · Tours ordinaires $ordinaires · Refus moteur $refus · Refus porte $porte · Pauses $pauses"
}
data class Health(
    val since: String?, val projects: Int, val chef: Boolean, val terminal: Boolean, val streakDays: Int,
    val criterionDays: Int, val met: Boolean, val totals: HealthRow, val days: List<HealthRow>, val perProject: List<HealthRow>,
) {
    val bypass: Int get() = totals.bypass
    val streakText: String get() = "$streakDays jour(s) complet(s) sans contournement sur $criterionDays"
}

private fun healthRow(label: String, x: JsonElement?) = HealthRow(label, x.i("runs") ?: 0, x.i("hors") ?: 0, x.i("ordinaires") ?: 0,
    x.i("refus") ?: 0, x.i("porte") ?: 0, x.i("pauses") ?: 0)

fun parseHealth(j: JsonElement?) = Health(
    since = j.s("since"), projects = j.i("projects") ?: 0, chef = j.b("chef"), terminal = j.b("terminal"),
    streakDays = j.i("streakDays") ?: 0, criterionDays = j.o("criterion").i("days") ?: 7, met = j.o("criterion").b("met"),
    totals = healthRow("Total", j.o("totals")),
    days = j.a("days").map { healthRow(it.s("date") ?: "", it) },
    perProject = j.a("perProject").map { healthRow(it.s("name") ?: "", it) },
)

// ---------------------------------------------------------------- Observation

data class ObsItem(
    val at: String?, val entry: String, val project: String?, val target: String?, val caller: String?,
    val pipeline: String?, val mode: String?, val explicit: Boolean, val unclassifiable: Boolean,
    val modeUncertain: Boolean, val gap: Boolean, val confidence: String?, val head: String, val reasons: List<String>,
) {
    val who: String get() = (project ?: "—") + (target?.let { " → $it" } ?: "") + (caller?.let { " (par $it)" } ?: "")
}
data class Observe(val total: Int, val byPipeline: List<Pair<String, Int>>, val unclassifiable: Int, val entryKinds: Map<String, String>, val items: List<ObsItem>)

fun parseObserve(j: JsonElement?) = Observe(
    total = j.i("total") ?: 0,
    byPipeline = j.o("counts").o("byPipeline").entries.map { (k, v) -> k to ((v as? JsonPrimitive)?.content?.toIntOrNull() ?: 0) }
        .sortedByDescending { it.second },
    unclassifiable = j.o("counts").i("unclassifiable") ?: 0,
    entryKinds = j.o("entryKinds").entries.associate { (k, v) -> k to ((v as? JsonPrimitive)?.content ?: k) },
    items = j.a("items").map {
        // Gap may be an object (the proposal) or a flag: either means « lacune proposée ».
        ObsItem(it.s("at"), it.s("entry") ?: "", it.s("project"), it.s("target"), it.s("caller"), it.s("pipeline"), it.s("mode"),
            it.b("explicit"), it.b("unclassifiable"), it.b("modeUncertain"), it.o("gap")?.let { g -> g !is JsonPrimitive || g.content == "true" } ?: false,
            it.s("confidence"), it.s("head") ?: "", it.strs("reasons"))
    },
)

fun pipelineLabel(id: String?, labels: Map<String, String>): String =
    if (id == null || id == "null") "à classer (model)" else labels[id] ?: id

fun obsTags(x: ObsItem, labels: Map<String, String>): String = buildString {
    append(pipelineLabel(x.pipeline, labels))
    x.mode?.let { append(" · ").append(if (it == "leger") "léger" else it) }
    if (x.explicit) append(" · explicite")
    if (x.unclassifiable) append(" · inclassable → Discussion")
    if (x.modeUncertain) append(" · mode incertain → léger")
    if (x.gap) append(" · ⚑ lacune proposée")
}

// ----------------------------------------------------------------------- Gaps

fun gapKindLabel(kind: String?): String = when (kind) {
    "pipeline" -> "nouveau pipeline"; "variante" -> "nouvelle variante"; "etape" -> "nouvelle étape"
    "rattachement" -> "rattachement"; else -> kind ?: ""
}

data class GapProp(val kind: String?, val text: String) { val kindLabel: String get() = gapKindLabel(kind) }
data class Gap(
    val key: String, val why: String, val count: Int, val lastAt: String?, val head: String, val entry: String,
    val project: String?, val pipeline: String?, val proposal: GapProp?, val alternative: GapProp?,
)
data class Gaps(val open: List<Gap>, val decided: List<String>)

private fun parseProp(j: JsonElement?): GapProp? = if (j !is JsonObject) null else GapProp(j.s("kind"), j.s("text") ?: "")

fun parseGaps(j: JsonElement?) = Gaps(
    open = j.a("open").map { g ->
        val e = g.a("entries").firstOrNull()
        Gap(g.s("key") ?: "", g.s("why") ?: "", g.i("count") ?: 0, g.s("lastAt"), e.s("head") ?: "", e.s("entry") ?: "",
            e.s("project"), e.s("pipeline"), parseProp(g.o("proposal")), parseProp(g.o("alternative")))
    },
    decided = j.a("decided").map { g ->
        val d = g.o("decision"); val ap = d.o("applied")
        "${g.a("entries").firstOrNull().s("head") ?: g.s("key")} — ${if (d.s("decision") == "accepted") "acceptée" else "rejetée"}" +
            (ap?.let { " (${it.s("kind") ?: ""} ${it.s("label") ?: it.s("pipeline") ?: ""})" } ?: "")
    },
)

/** Keys for POST /api/auto-answer/presented: only gaps actually shown may be answered automatically. */
fun presentedKeys(g: Gaps): List<String> = g.open.map { "gap:${it.key}" }

fun gapAcceptBody(choice: String): JsonObject = buildJsonObject { put("choice", choice); put("by", "android") }
fun gapRejectBody(): JsonObject = buildJsonObject { put("by", "android") }

fun gapAcceptedNotice(j: JsonElement?, labels: Map<String, String>): String {
    val a = j.o("applied") ?: return "✓ Acceptée."
    return "✓ Acceptée : ${a.s("kind") ?: ""} « ${a.s("label") ?: a.s("pipeline") ?: ""} » ajouté au pipeline ${pipelineLabel(a.s("pipeline"), labels)} — choisissez son model dans l’onglet Étapes."
}

// ------------------------------------------------------------------- API keys

data class ApiKey(
    val name: String, val label: String, val usage: String, val detail: String?, val configured: Boolean,
    val valid: Boolean?, val last4: String?, val source: String?, val checkedAt: String?, val deletable: Boolean,
) {
    val stateText: String get() = when {
        !configured -> "○ absente"
        valid == false -> "✕ invalide"
        valid == true -> "✓ configurée · acceptée"
        else -> "✓ configurée · non vérifiée"
    }
}

fun parseKeys(j: JsonElement?): List<ApiKey> = j.a("keys").map {
    ApiKey(it.s("name") ?: "", it.s("label") ?: it.s("name") ?: "", it.s("usage") ?: "", it.s("detail"), it.b("configured"),
        it.triBool("valid"), it.s("last4"), it.s("source"), it.s("checkedAt"), it.b("deletable"))
}

fun keysToFix(keys: List<ApiKey>): Int = keys.count { !it.configured || it.valid == false }

fun keyBody(value: String): JsonObject = buildJsonObject { put("value", value.trim()) }

fun keyNotice(action: String, j: JsonElement?): String {
    if (action == "del") return "Clé retirée."
    val k = j.o("key")
    return when (k.triBool("valid")) {
        true -> "Clé enregistrée et acceptée par le fournisseur."
        false -> "Clé refusée par le fournisseur (invalide)."
        null -> "Clé enregistrée — vérification impossible : ${k.s("detail") ?: "?"}"
    }
}

// ------------------------------------------------------------ Model languages

data class ModelLang(val model: String, val provider: String?, val langs: List<String>, val source: String, val note: String?, val test: String?) {
    val originText: String get() {
        val src = mapOf("override" to "réglé ici", "rule" to "règle par défaut", "default" to "inconnu : anglais seulement")[source] ?: source
        return src + (note?.let { " — $it" } ?: "") + (test ?: "")
    }
}
data class ModelLangs(val langs: List<String>, val labels: Map<String, String>, val models: List<ModelLang>)

fun parseModelLangs(j: JsonElement?) = ModelLangs(
    langs = j.o("langs").entries.map { it.first },
    labels = j.o("langs").entries.associate { (k, v) -> k to (v.s("label") ?: k) },
    models = j.a("models").map { m ->
        val t = m.o("test")
        val test = t?.let { " · essai ${it.s("lang") ?: ""} : ${if (it.b("ok")) "✓" else "✕ (réponse en ${it.s("detected") ?: "?"})"}" }
        ModelLang(m.s("model") ?: "", m.s("provider"), m.strs("langs"), m.s("source") ?: "", m.s("note"), test)
    },
)

fun toggledLangs(cur: List<String>, lang: String, on: Boolean, order: List<String>): List<String> {
    val set = cur.toMutableSet()
    if (on) set += lang else set -= lang
    return order.filter { it in set } + set.filter { it !in order }
}

fun langsBody(langs: List<String>): JsonObject = buildJsonObject {
    putJsonArray("langs") { langs.forEach { add(JsonPrimitive(it)) } }
    put("by", "android")
}

fun langTestBody(provider: String?, model: String, lang: String): JsonObject = buildJsonObject {
    put("provider", provider ?: ""); put("model", model); put("lang", lang)
}
