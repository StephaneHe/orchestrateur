package com.orchestrateur.ui.panels

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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDate

/*
 * Pure logic of the « 🧠 Mémoire » screen (port of public/kg-panel.js, knowledge
 * graph phase 1, server 0.131.0). No android.* here: tested on the JVM.
 */

const val KG_DISABLED_TEXT = "Mémoire désactivée (interrupteur kg.ui)"

/** `ui.kgMemory` of GET /api/config (or of the /api/pupitre snapshot). */
fun kgMemoryEnabled(config: JsonElement?): Boolean = config.o("ui").b("kgMemory")

/** A kg route answering 404 `{disabled:true}`: the switch kg.ui is off. */
fun kgDisabled(code: Int, json: JsonElement?): Boolean = code == 404 && json.b("disabled")

// ---- status ------------------------------------------------------------------

data class KgStatus(
    val mode: String,
    val build: Boolean,
    val extract: Boolean,
    val ui: Boolean,
    val cutoffWhy: String?,
    val indexLabel: String?,
    val indexBuiltAt: String?,
    val reviewTotal: Int,
    val contradictions: Int,
    val suspendedWhy: String?,
    val callsToday: Int,
    val pairsToday: Int,
    val healthBreached: Boolean,
    val model: String?,
)

fun parseKgStatus(j: JsonElement?): KgStatus {
    val sw = j.o("switches")
    val ex = j.o("extraction")
    return KgStatus(
        mode = j.s("mode") ?: "off",
        build = sw.b("build"), extract = sw.b("extract"), ui = sw.b("ui"),
        cutoffWhy = j.o("cutoff").s("why"),
        indexLabel = j.o("index").s("label"),
        indexBuiltAt = j.o("index").s("builtAt"),
        reviewTotal = j.o("review").i("total") ?: 0,
        contradictions = j.i("contradictions") ?: 0,
        suspendedWhy = ex.o("suspended").s("why"),
        callsToday = ex.i("callsToday") ?: 0,
        pairsToday = ex.i("pairsToday") ?: 0,
        healthBreached = ex.o("health").b("breached"),
        model = ex.o("model").s("model"),
    )
}

/** The status line: mode, extraction on/off, cut-off and suspension reasons. */
fun statusLine(st: KgStatus): String = buildList {
    add("mode ${st.mode}")
    add(if (st.extract) "extraction active (${st.callsToday} appels, ${st.pairsToday} paires aujourd’hui)" else "extraction coupée")
    st.cutoffWhy?.let { add("⛔ coupure : $it") }
    st.suspendedWhy?.let { add("⏸ extraction suspendue : $it") }
    if (st.healthBreached) add("⚠ trop de faits faux")
}.joinToString(" · ")

/** Count shown on the « Plus » entry (the dashboard's contradictions banner). */
fun plusBadge(st: KgStatus?): String? {
    if (st == null) return null
    val parts = buildList {
        if (st.contradictions > 0) add("⚠ ${st.contradictions} contradiction${if (st.contradictions > 1) "s" else ""}")
        if (st.reviewTotal > 0) add("${st.reviewTotal} à revoir")
    }
    return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
}

// ---- review ------------------------------------------------------------------

data class KgCard(val what: String?, val why: String?, val since: String?, val where: String?)
data class KgSource(val key: String?, val ref: String?, val line: Int?, val quote: String?, val kind: String?)
data class KgSide(
    val fact: String, val o: String?, val label: String?, val ref: String?, val key: String?,
    val line: Int?, val quote: String?, val date: String?, val owner: String?,
)

data class KgItem(
    val id: String,
    val kind: String,
    val rev: Int,
    val status: String?,
    val why: String?,
    val s: String?, val p: String?, val o: String?,
    val labelS: String?, val labelP: String?, val labelO: String?,
    val card: KgCard?,
    val source: KgSource?,
    val owner: String?,
    val actions: List<String>,
    val sides: List<KgSide>,
    val verdict: String?,
)

data class KgReview(val items: List<KgItem>, val total: Int, val builtAt: String?)

private fun parseCard(j: JsonElement?): KgCard? =
    if (j !is JsonObject) null else KgCard(j.s("what"), j.s("why"), j.s("since"), j.s("where"))

fun parseKgItem(j: JsonElement): KgItem {
    val src = j.o("source")
    val labels = j.o("labels")
    return KgItem(
        id = j.s("id").orEmpty(), kind = j.s("kind") ?: "fact", rev = j.i("rev") ?: 0,
        status = j.s("status"), why = j.s("why"),
        s = j.s("s"), p = j.s("p"), o = j.s("o"),
        labelS = labels.s("s"), labelP = labels.s("p"), labelO = labels.s("o"),
        card = parseCard(j.o("card")),
        source = if (src is JsonObject) KgSource(src.s("key"), src.s("ref"), src.i("line"), src.s("quote"), src.s("kind")) else null,
        owner = j.s("owner"),
        actions = j.strs("actions"),
        sides = j.a("sides").map { sd ->
            KgSide(sd.s("fact").orEmpty(), sd.s("o"), sd.s("label"), sd.s("ref"), sd.s("key"), sd.i("line"), sd.s("quote"), sd.s("date"), sd.s("owner"))
        },
        verdict = j.s("verdict"),
    )
}

fun parseKgReview(j: JsonElement?): KgReview {
    val items = j.a("items").map(::parseKgItem)
    return KgReview(items, j.o("counts").i("total") ?: items.size, j.s("builtAt"))
}

/** Groups of the « Revue » tab, in this order (contradictions first). */
val REVIEW_GROUPS = listOf(
    "conflict" to "Contradictions",
    "fact" to "Faits proposés par un model",
    "pair" to "Paires suspectes",
    "stale" to "Faits à revoir",
    "index" to "Index des mémoires",
)

data class KgGroup(val kind: String, val title: String, val items: List<KgItem>)

/** Non-empty groups in [REVIEW_GROUPS] order; an unknown kind goes last under « Autres ». */
fun groupReview(items: List<KgItem>): List<KgGroup> {
    val known = REVIEW_GROUPS.map { it.first }.toSet()
    val out = REVIEW_GROUPS.mapNotNull { (k, t) -> items.filter { it.kind == k }.takeIf { it.isNotEmpty() }?.let { KgGroup(k, t, it) } }
    val other = items.filter { it.kind !in known }
    return if (other.isEmpty()) out else out + KgGroup("other", "Autres", other)
}

/** « s p o » with the server's labels when it gives them. */
fun factText(i: KgItem): String =
    listOfNotNull(i.labelS ?: i.s, i.labelP ?: i.p, i.labelO ?: i.o).filter { it.isNotBlank() }.joinToString(" ")

/** The four questions, in order; a missing answer is « — ». */
fun fourQuestions(i: KgItem): List<Pair<String, String>> {
    val c = i.card
    return listOf(
        "Ce que nous savons" to (c?.what ?: factText(i)).ifBlank { "—" },
        "Pourquoi" to (c?.why ?: i.why ?: "—"),
        "Depuis quand" to (c?.since ?: "—"),
        "Où cela s’applique" to (c?.where ?: "—"),
    )
}

fun ownerLabel(owner: String?): String = when (owner) {
    null, "" -> "—"
    "chef" -> "le chef"
    "utilisateur" -> "vous (utilisateur)"
    else -> owner
}

/** « Corriger la source » is offered when the source has an owner other than the user. */
fun canFixSource(i: KgItem): Boolean =
    !i.owner.isNullOrBlank() && i.owner != "utilisateur" && !i.source?.ref.isNullOrBlank()

/** Text put in the chef composer by « Corriger la source » (same text as the web). */
fun fixSourceText(i: KgItem): String =
    "Corriger la source d’un fait de la mémoire (décision 15 : correction par le projet propriétaire, jamais réécrite en silence).\n\n" +
        "Source : ${i.source?.ref.orEmpty()}\n" +
        "Propriétaire : ${i.owner.orEmpty()}\n" +
        "Fait : ${i.card?.what ?: factText(i)}\n\n" +
        "Ce qui est faux / ce qu’il faut écrire : "

// ---- decisions -------------------------------------------------------------------

private val COMMAND_ID = Regex("^[A-Za-z0-9_.:-]{6,80}$")
private val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
private const val B36 = "0123456789abcdefghijklmnopqrstuvwxyz"

fun isValidCommandId(id: String) = COMMAND_ID.matches(id)

/** `android-<millis base36>-<random>`: one per user gesture, reused for a retry of the same gesture. */
fun newCommandId(nowMs: Long = System.currentTimeMillis(), random: java.util.Random = java.util.Random()): String {
    val rnd = (1..8).map { B36[random.nextInt(36)] }.joinToString("")
    return "android-${nowMs.toString(36)}-$rnd"
}

/** `YYYY-MM-DD` and a real calendar date. */
fun isValidDate(s: String): Boolean = DATE.matches(s) && runCatching { LocalDate.parse(s) }.isSuccess

const val CORRECT_MAX = 200

/** Body of POST /api/kg/decision, or the reason it cannot be sent. */
sealed class DecisionBody {
    data class Ok(val json: JsonElement) : DecisionBody()
    data class Invalid(val why: String) : DecisionBody()
}

fun decisionBody(
    item: KgItem,
    action: String,
    commandId: String,
    reason: String? = null,
    newValue: String? = null,
    validTo: String? = null,
    keep: String? = null,
): DecisionBody {
    if (!isValidCommandId(commandId)) return DecisionBody.Invalid("identifiant de commande invalide")
    val r = reason?.trim().orEmpty()
    val o = newValue?.trim().orEmpty()
    val vt = validTo?.trim().orEmpty()
    when (action) {
        "validate" -> {}
        "reject" -> if (r.isEmpty()) return DecisionBody.Invalid("raison requise")
        "correct" -> {
            if (o.isEmpty()) return DecisionBody.Invalid("nouvelle valeur requise")
            if (o.length > CORRECT_MAX) return DecisionBody.Invalid("nouvelle valeur trop longue (${o.length} > $CORRECT_MAX caractères)")
        }
        "expire" -> if (!isValidDate(vt)) return DecisionBody.Invalid("date attendue au format AAAA-MM-JJ")
        "arbitrate" -> if (keep.isNullOrBlank() || item.sides.none { it.fact == keep }) return DecisionBody.Invalid("choisir l’une des deux versions")
        else -> return DecisionBody.Invalid("action inconnue : $action")
    }
    return DecisionBody.Ok(buildJsonObject {
        put("id", item.id)
        put("action", action)
        put("rev", item.rev)
        put("commandId", commandId)
        when (action) {
            "reject" -> put("reason", r)
            "correct" -> put("o", o)
            "expire" -> put("valid_to", vt)
            "arbitrate" -> put("keep", keep!!)
        }
        put("client", "android")
    })
}

/** Outcome of POST /api/kg/decision: message and whether the review must be reloaded. */
data class DecisionOutcome(val message: String, val error: Boolean, val reload: Boolean, val retryable: Boolean)

fun decisionOutcome(code: Int, json: JsonElement?, errorText: String): DecisionOutcome = when {
    code in 200..299 && json.b("duplicate") -> DecisionOutcome("Décision déjà enregistrée.", false, true, false)
    code in 200..299 -> DecisionOutcome(
        "Décision enregistrée." + (json.o("cutoff").s("why")?.let { " ⛔ Coupure : $it" } ?: ""), false, true, false,
    )
    code == 409 -> DecisionOutcome("L’élément a changé depuis sa lecture : la revue est rechargée, vérifiez-le avant de décider.", true, true, false)
    kgDisabled(code, json) -> DecisionOutcome(KG_DISABLED_TEXT, true, true, false)
    code == 400 -> DecisionOutcome("Refusé : $errorText", true, false, false)
    code < 0 -> DecisionOutcome("Non envoyé : $errorText", true, false, true)
    else -> DecisionOutcome("Échec : $errorText", true, false, code >= 500)
}

fun actionLabel(kind: String, action: String): String = when (action) {
    "validate" -> if (kind == "pair") "⚠ Confirmer la contradiction" else "Valider"
    "reject" -> if (kind == "pair") "✕ Écarter" else "Rejeter…"
    "correct" -> "Corriger…"
    "expire" -> "Périmer à la date…"
    "arbitrate" -> "✓ Celle-ci vaut"
    else -> action
}

// ---- source excerpt ------------------------------------------------------------------

data class KgExcerpt(val file: String?, val line: Int?, val changed: Boolean, val lines: List<Pair<Int, String>>)

fun parseKgSource(j: JsonElement?): KgExcerpt = KgExcerpt(
    file = j.s("file") ?: j.s("key"), line = j.i("line"), changed = j.b("changed"),
    lines = j.a("lines").map { (it.i("n") ?: 0) to it.s("text").orEmpty() },
)

fun sourcePath(key: String, line: Int?): String =
    "/api/kg/source?key=${com.orchestrateur.data.enc(key)}" + (line?.let { "&line=$it" } ?: "")

// ---- rules -------------------------------------------------------------------------

data class KgLine(
    val s: String?, val p: String?, val o: String?, val status: String?, val why: String?,
    val authority: String?, val ref: String?, val quote: String?, val date: String?, val card: KgCard?,
)

data class KgChainLink(val id: String, val label: String?, val ref: String?, val relation: String?, val chain: List<KgChainLink>)

data class KgRule(
    val id: String, val label: String?, val status: String?, val specific: Boolean, val modified: String?,
    val supersededBy: String?, val chain: List<KgChainLink>,
)

data class KgRules(
    val fixed: List<KgLine>, val inForce: List<KgRule>, val superseded: List<KgRule>,
    val exceptions: List<KgLine>, val conflicts: List<String>, val curated: List<KgLine>,
    val caseFacts: List<KgLine>, val cases: List<String>, val projects: List<String>,
)

private fun parseLine(j: JsonElement) = KgLine(
    j.s("s"), j.s("p"), j.s("o"), j.s("status"), j.s("why"), j.s("authority"), j.s("ref"), j.s("quote"), j.s("date"),
    parseCard(j.o("card")),
)

private fun parseLink(j: JsonElement): KgChainLink = KgChainLink(
    id = j.s("id").orEmpty(), label = j.s("label"), ref = j.s("ref"),
    relation = when { j.b("newer") -> "plus récente"; j.b("older") -> "plus ancienne"; else -> null },
    chain = j.a("chain").map(::parseLink),
)

private fun parseRule(j: JsonElement) = KgRule(
    id = j.s("id").orEmpty(), label = j.s("label"), status = j.s("status"), specific = j.b("specific"),
    modified = j.s("modified"), supersededBy = j.s("supersededBy"), chain = j.a("chain").map(::parseLink),
)

/** A conflict of the rules view, whatever its shape: label, else « s p : a ≠ b », else the raw JSON. */
private fun conflictText(j: JsonElement): String {
    j.str?.let { return it }
    j.s("label")?.let { return it }
    val sides = j.a("sides").mapNotNull { it.s("label") ?: it.s("o") }
    if (sides.isNotEmpty()) return listOfNotNull(j.s("s"), j.s("p")).joinToString(" ") + " : " + sides.joinToString(" ≠ ")
    return j.entries.joinToString(", ") { (k, v) -> "$k=${v.str ?: v}" }
}

fun parseKgRules(j: JsonElement?): KgRules = KgRules(
    fixed = j.a("fixed").map(::parseLine),
    inForce = j.a("inForce").map(::parseRule),
    superseded = j.a("superseded").map(::parseRule),
    exceptions = j.a("exceptions").map(::parseLine),
    conflicts = j.a("conflicts").map(::conflictText),
    curated = j.a("curated").map(::parseLine),
    caseFacts = j.a("caseFacts").map(::parseLine),
    cases = j.strs("cases"),
    projects = j.strs("projects"),
)

fun rulesPath(project: String, case: String): String {
    val q = buildList {
        if (project.isNotEmpty()) add("projet=${com.orchestrateur.data.enc(project)}")
        if (case.isNotEmpty()) add("case=${com.orchestrateur.data.enc(case)}")
    }
    return "/api/kg/rules" + if (q.isEmpty()) "" else "?" + q.joinToString("&")
}

fun lineText(l: KgLine): String =
    l.card?.what ?: listOfNotNull(l.s, l.p).joinToString(" ") + (l.o?.let { " : $it" } ?: "")

fun lineMeta(l: KgLine): String = listOfNotNull(
    l.authority?.let { "autorité $it" }, l.status, l.ref, l.date,
).joinToString(" · ")

// ---- stats ---------------------------------------------------------------------------

data class KgModelStat(val model: String, val n: Int, val ok: Int, val critere: Int, val infrastructure: Int, val echec: Int)
data class KgStatDetail(
    val case: String, val n: Int, val enough: Boolean, val message: String?,
    val byModel: List<KgModelStat>, val causes: List<Pair<String, Int>>, val assigned: String?,
)
data class KgStats(val cases: List<Pair<String, Int>>, val detail: KgStatDetail?)

fun parseKgStats(j: JsonElement?): KgStats {
    val d = j.o("detail")
    return KgStats(
        cases = j.a("cases").map { (it.s("case").orEmpty()) to (it.i("n") ?: 0) },
        detail = if (d !is JsonObject) null else KgStatDetail(
            case = d.s("case").orEmpty(), n = d.i("n") ?: 0, enough = d.b("enough"), message = d.s("message"),
            byModel = d.o("byModel").entries.map { (m, v) ->
                KgModelStat(m, v.i("n") ?: 0, v.i("ok") ?: 0, v.i("critere") ?: 0, v.i("infrastructure") ?: 0, v.i("echec") ?: 0)
            }.sortedByDescending { it.n },
            causes = d.a("causes").map { (it.s("why").orEmpty()) to (it.i("n") ?: 0) },
            assigned = d.o("assigned")?.let { it.str ?: (it.s("model") ?: it.toString()) },
        ),
    )
}

fun statsPath(case: String?): String = "/api/kg/stats" + (case?.takeIf { it.isNotEmpty() }?.let { "?case=${com.orchestrateur.data.enc(it)}" } ?: "")

/** Message of a case without enough data (the server's, else ours). */
fun insufficientText(d: KgStatDetail): String? =
    if (d.enough) null else d.message ?: "Données insuffisantes : ${d.n} exécution${if (d.n > 1) "s" else ""} pour cette case."
