package com.orchestrateur.ui.panels

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.RestResult
import com.orchestrateur.data.getJson
import com.orchestrateur.data.postJson
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.InputDialog
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.Mono
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.SectionTitle
import com.orchestrateur.ui.common.Tag
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.models.ChipRow
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import java.time.LocalDate

/** Value of a kg route, or `disabled` when the server answers 404 `{disabled:true}`. */
private class KgFetch<T>(val disabled: Boolean, val value: T?)

private suspend fun <T> kgGet(get: suspend () -> RestResult, parse: (JsonElement?) -> T): KgFetch<T> {
    val r = get()
    if (kgDisabled(r.code, r.json)) return KgFetch(true, null)
    return KgFetch(false, parse(r.orThrow().json))
}

/**
 * « 🧠 Mémoire » (public/kg-panel.js, knowledge graph phase 1): review of the
 * proposed facts, rules in force, per-case statistics. Hidden behind ui.kgMemory.
 */
@Composable
fun MemoryScreen() {
    val env = LocalEnv.current
    val config = rememberLoad { env.api.getJson("/api/config").orThrow().json }
    val enabled = config.value?.let(::kgMemoryEnabled)
    val status = rememberLoad(enabled, refreshMs = 30_000) {
        if (enabled != true) null else kgGet({ env.api.getJson("/api/kg/status") }, ::parseKgStatus)
    }
    var tab by rememberSaveable { mutableStateOf("review") }
    val st = status.value?.value
    SectionScaffold("🧠 Mémoire", subtitle = st?.let(::statusLine)) {
        when {
            config.value == null && config.error != null -> ErrorLine("Mémoire indisponible : ${config.error}", config.reload)
            enabled == null -> LoadingLine()
            enabled == false || status.value?.disabled == true -> EmptyLine(KG_DISABLED_TEXT)
            status.value == null && status.error != null -> ErrorLine("Mémoire indisponible : ${status.error}", status.reload)
            status.value == null -> LoadingLine()
            else -> {
                val nConf = st?.contradictions ?: 0
                ChipRow(
                    listOf(
                        "review" to if (nConf > 0) "Revue (⚠ $nConf)" else "Revue",
                        "rules" to "Règles en vigueur",
                        "stats" to "Statistiques",
                    ),
                    tab,
                ) { tab = it }
                when (tab) {
                    "review" -> ReviewTab(onChanged = status.reload)
                    "rules" -> RulesTab()
                    "stats" -> StatsTab()
                }
            }
        }
    }
}

private data class Ask(val item: KgItem, val action: String)
private data class Pending(val label: String, val body: JsonElement)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReviewTab(onChanged: () -> Unit) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val review = rememberLoad(refreshMs = 60_000) { kgGet({ env.api.getJson("/api/kg/review") }, ::parseKgReview) }
    var ask by remember { mutableStateOf<Ask?>(null) }
    var source by remember { mutableStateOf<Pair<String, Int?>?>(null) }
    var msg by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var retry by remember { mutableStateOf<Pending?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun send(p: Pending) {
        busy = true
        scope.launch {
            val r = env.api.postJson("/api/kg/decision", p.body)
            busy = false
            val out = decisionOutcome(r.code, r.json, r.errorText())
            msg = out.message to out.error
            // A retry of the same gesture keeps its commandId (the server de-duplicates).
            retry = if (out.retryable) p else null
            if (out.reload) { review.reload(); onChanged() }
        }
    }
    fun decide(item: KgItem, action: String, reason: String? = null, o: String? = null, validTo: String? = null, keep: String? = null) {
        when (val b = decisionBody(item, action, newCommandId(), reason, o, validTo, keep)) {
            is DecisionBody.Invalid -> msg = b.why to true
            is DecisionBody.Ok -> send(Pending(actionLabel(item.kind, action), b.json))
        }
    }

    val f = review.value
    when {
        f == null && review.error != null -> ErrorLine("Revue indisponible : ${review.error}", review.reload)
        f == null -> LoadingLine()
        f.disabled -> EmptyLine(KG_DISABLED_TEXT)
        else -> {
            val d = f.value!!
            val groups = groupReview(d.items)
            LazyColumn(contentPadding = ListPadding) {
                msg?.let { (t, err) ->
                    item {
                        Column(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
                            Text(t, color = if (err) Palette.StError else Palette.StLive, fontSize = 13.sp)
                            retry?.let { p -> PillButton("Réessayer (${p.label})", enabled = !busy) { send(p) } }
                        }
                    }
                }
                if (groups.isEmpty()) item { EmptyLine("Rien à revoir.") }
                for (g in groups) {
                    item(key = "g-${g.kind}") { SectionTitle("${g.title} (${g.items.size})") }
                    items(g.items, key = { "i-${it.id}" }) { it ->
                        ItemCard(
                            it, busy,
                            onAction = { a ->
                                when (a) {
                                    "validate" -> decide(it, a)
                                    "reject", "correct", "expire" -> ask = Ask(it, a)
                                }
                            },
                            onKeep = { fact -> decide(it, "arbitrate", keep = fact) },
                            onSource = { k, l -> source = k to l },
                            onFixSource = { env.prepareChef(fixSourceText(it)) },
                        )
                    }
                }
            }
        }
    }

    ask?.let { a ->
        when (a.action) {
            "reject" -> InputDialog(
                if (a.item.kind == "pair") "Écarter la paire" else "Rejeter le fait", label = "Raison",
                confirm = if (a.item.kind == "pair") "Écarter" else "Rejeter",
                onSubmit = { decide(a.item, "reject", reason = it) }, onDismiss = { ask = null },
            )
            "correct" -> InputDialog(
                "Corriger la valeur", initial = a.item.o.orEmpty(), label = "Nouvelle valeur (≤ $CORRECT_MAX caractères)", confirm = "Corriger",
                singleLine = true, onSubmit = { decide(a.item, "correct", o = it) }, onDismiss = { ask = null },
            )
            "expire" -> InputDialog(
                "Périmer à la date", initial = LocalDate.now().toString(), label = "Date (AAAA-MM-JJ)", confirm = "Périmer",
                singleLine = true, onSubmit = { decide(a.item, "expire", validTo = it) }, onDismiss = { ask = null },
            )
        }
    }
    source?.let { (k, l) -> SourceDialog(k, l) { source = null } }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ItemCard(
    it: KgItem,
    busy: Boolean,
    onAction: (String) -> Unit,
    onKeep: (String) -> Unit,
    onSource: (String, Int?) -> Unit,
    onFixSource: () -> Unit,
) {
    Card(border = if (it.kind == "conflict") Palette.StError.copy(alpha = 0.5f) else Palette.CardBorder) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(factText(it).ifBlank { it.id }, color = Palette.Fg0, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            it.status?.let { s -> Tag(s) }
        }
        if (it.kind == "conflict" || it.kind == "pair") {
            it.why?.let { w -> Text(w, color = Palette.Fg2, fontSize = 12.sp) }
            it.verdict?.let { v -> Text("Verdict : $v", color = Palette.StInput, fontSize = 12.sp) }
            for (side in it.sides) Column(
                Modifier.fillMaxWidth().padding(top = 4.dp).background(Palette.Bg2).padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(side.label ?: side.o ?: side.fact, color = Palette.Fg0, fontSize = 13.sp)
                Text(listOfNotNull(side.ref?.let { r -> side.line?.let { "$r:$it" } ?: r }, side.date, side.owner?.let { "propriétaire : ${ownerLabel(it)}" })
                    .joinToString(" · "), color = Palette.Fg2, fontSize = 11.sp)
                side.quote?.let { q -> Text("« $q »", color = Palette.Fg1, fontSize = 12.sp) }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if ("arbitrate" in it.actions && side.fact.isNotEmpty()) PillButton(actionLabel(it.kind, "arbitrate"), enabled = !busy) { onKeep(side.fact) }
                    side.key?.let { k -> PillButton("Ouvrir la source", color = Palette.Fg1) { onSource(k, side.line) } }
                }
            }
        } else {
            for ((q, a) in fourQuestions(it)) Column {
                Text(q, color = Palette.Fg2, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Text(a, color = Palette.Fg1, fontSize = 13.sp)
            }
        }
        it.source?.let { s ->
            Text(listOfNotNull(s.ref?.let { r -> s.line?.let { "$r:$it" } ?: r }, s.kind, "propriétaire : ${ownerLabel(it.owner)}").joinToString(" · "),
                color = Palette.Fg2, fontSize = 11.sp)
            s.quote?.let { q -> Text("« $q »", color = Palette.Fg1, fontSize = 12.sp) }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (a in it.actions) if (a != "arbitrate") PillButton(actionLabel(it.kind, a), enabled = !busy,
                color = if (a == "reject") Palette.StError else Palette.Accent) { onAction(a) }
            it.source?.key?.let { k -> PillButton("Ouvrir la source", color = Palette.Fg1) { onSource(k, it.source.line) } }
            if (canFixSource(it)) PillButton("Corriger la source", color = Palette.StThink) { onFixSource() }
        }
    }
}

@Composable
private fun SourceDialog(key: String, line: Int?, onDismiss: () -> Unit) {
    val env = LocalEnv.current
    val ex = rememberLoad(key, line) { parseKgSource(env.api.getJson(sourcePath(key, line)).orThrow().json) }
    PanelDialog(ex.value?.file ?: key, onDismiss = onDismiss) {
        val e = ex.value
        when {
            e == null && ex.error != null -> ErrorLine("Source indisponible : ${ex.error}", ex.reload)
            e == null -> LoadingLine()
            else -> {
                if (e.changed) Text("⚠ Le fichier a changé depuis la construction de l’index.", color = Palette.StInput, fontSize = 12.sp)
                for ((n, text) in e.lines) {
                    val hl = n == (e.line ?: line)
                    Row(Modifier.fillMaxWidth().background(if (hl) Palette.Accent.copy(alpha = 0.18f) else Palette.Bg1)) {
                        Text(n.toString().padStart(4), color = if (hl) Palette.Accent else Palette.Fg3, fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace, modifier = Modifier.padding(end = 6.dp))
                        Text(text, color = if (hl) Palette.Fg0 else Palette.Fg1, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                    }
                }
            }
        }
    }
}

@Composable
private fun RulesTab() {
    val env = LocalEnv.current
    var project by rememberSaveable { mutableStateOf("") }
    var case by rememberSaveable { mutableStateOf("") }
    val rules = rememberLoad(project, case) { kgGet({ env.api.getJson(rulesPath(project, case)) }, ::parseKgRules) }
    val f = rules.value
    when {
        f == null && rules.error != null -> ErrorLine("Règles indisponibles : ${rules.error}", rules.reload)
        f == null -> LoadingLine()
        f.disabled -> EmptyLine(KG_DISABLED_TEXT)
        else -> {
            val d = f.value!!
            Picker("Projet", project, listOf(PickerOption("", "tous")) + d.projects.map { PickerOption(it, it) }, onPick = { project = it })
            Picker("Case", case, listOf(PickerOption("", "aucune")) + d.cases.map { PickerOption(it, it) }, onPick = { case = it })
            LazyColumn(contentPadding = ListPadding) {
                lineSection("Valeurs fixées", d.fixed)
                item { SectionTitle("Règles en vigueur (${d.inForce.size})") }
                if (d.inForce.isEmpty()) item { EmptyLine("Aucune.") }
                items(d.inForce, key = { "r-${it.id}" }) { RuleCard(it) }
                if (d.superseded.isNotEmpty()) {
                    item { SectionTitle("Remplacées (${d.superseded.size})") }
                    items(d.superseded, key = { "s-${it.id}" }) { RuleCard(it) }
                }
                lineSection("Liens validés par vous", d.curated)
                lineSection("Exceptions", d.exceptions)
                if (d.conflicts.isNotEmpty()) {
                    item { SectionTitle("Conflits (${d.conflicts.size})") }
                    items(d.conflicts) { Card { Text(it, color = Palette.StError, fontSize = 13.sp) } }
                }
                if (case.isNotEmpty()) lineSection("Case $case", d.caseFacts, cards = true)
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.lineSection(title: String, lines: List<KgLine>, cards: Boolean = false) {
    item { SectionTitle("$title (${lines.size})") }
    if (lines.isEmpty()) item { EmptyLine("Aucune.") }
    items(lines) { l ->
        Card {
            Text(lineText(l), color = Palette.Fg0, fontSize = 13.sp)
            if (cards && l.card != null) {
                l.card.why?.let { Text("Pourquoi : $it", color = Palette.Fg1, fontSize = 12.sp) }
                l.card.since?.let { Text("Depuis quand : $it", color = Palette.Fg1, fontSize = 12.sp) }
                l.card.where?.let { Text("Où cela s’applique : $it", color = Palette.Fg1, fontSize = 12.sp) }
            } else l.why?.let { Text(it, color = Palette.Fg1, fontSize = 12.sp) }
            lineMeta(l).takeIf { it.isNotEmpty() }?.let { Text(it, color = Palette.Fg2, fontSize = 11.sp) }
            l.quote?.let { Text("« $it »", color = Palette.Fg2, fontSize = 11.sp) }
        }
    }
}

@Composable
private fun RuleCard(r: KgRule) {
    var open by remember(r.id) { mutableStateOf(false) }
    Card(onClick = if (r.chain.isNotEmpty()) ({ open = !open }) else null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(r.label ?: r.id, color = Palette.Fg0, fontSize = 13.sp, modifier = Modifier.weight(1f))
            if (r.specific) Tag("spécifique", Palette.StUnread)
            r.status?.let { Tag(it) }
        }
        val meta = listOfNotNull(r.modified?.let { "modifiée $it" }, r.supersededBy?.let { "remplacée par $it" }).joinToString(" · ")
        if (meta.isNotEmpty()) Text(meta, color = Palette.Fg2, fontSize = 11.sp)
        if (r.chain.isNotEmpty()) Text(if (open) "▾ chaîne de remplacement" else "▸ remplace ${r.chain.size} règle${if (r.chain.size > 1) "s" else ""}",
            color = Palette.Accent, fontSize = 12.sp)
        if (open) ChainView(r.chain, 0)
    }
}

@Composable
private fun ChainView(links: List<KgChainLink>, depth: Int) {
    for (l in links) {
        Column(Modifier.padding(start = (12 * (depth + 1)).dp)) {
            Text("↳ ${l.label ?: l.id}${l.relation?.let { " ($it)" } ?: ""}", color = Palette.Fg1, fontSize = 12.sp)
            l.ref?.let { Mono(it, Palette.Fg2, 11) }
        }
        if (l.chain.isNotEmpty() && depth < 6) ChainView(l.chain, depth + 1)
    }
}

@Composable
private fun StatsTab() {
    val env = LocalEnv.current
    var case by rememberSaveable { mutableStateOf<String?>(null) }
    val stats = rememberLoad(case) { kgGet({ env.api.getJson(statsPath(case)) }, ::parseKgStats) }
    val f = stats.value
    when {
        f == null && stats.error != null -> ErrorLine("Statistiques indisponibles : ${stats.error}", stats.reload)
        f == null -> LoadingLine()
        f.disabled -> EmptyLine(KG_DISABLED_TEXT)
        else -> {
            val d = f.value!!
            LazyColumn(contentPadding = ListPadding) {
                if (d.cases.isEmpty()) item { EmptyLine("Aucune exécution enregistrée.") }
                items(d.cases, key = { "c-${it.first}" }) { (c, n) ->
                    val on = c == case
                    Card(onClick = { case = if (on) null else c }, border = if (on) Palette.Accent else Palette.CardBorder) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Mono(c, Palette.Fg0, 13)
                            Text("  $n", color = Palette.Fg2, fontSize = 12.sp, modifier = Modifier.weight(1f))
                            Text(if (on) "▾" else "›", color = Palette.Accent, fontSize = 13.sp)
                        }
                        val det = d.detail?.takeIf { on && it.case == c }
                        if (det != null) StatDetail(det)
                    }
                }
            }
        }
    }
}

@Composable
private fun StatDetail(d: KgStatDetail) {
    insufficientText(d)?.let { Text(it, color = Palette.StInput, fontSize = 12.sp) }
    d.assigned?.let { Text("Model assigné : $it", color = Palette.Fg1, fontSize = 12.sp) }
    if (d.byModel.isNotEmpty()) {
        Row { for (h in listOf("model", "n", "ok", "critère", "infra", "échec")) Text(h, color = Palette.Fg2, fontSize = 11.sp, modifier = Modifier.weight(if (h == "model") 2.4f else 1f)) }
        for (m in d.byModel) Row {
            Text(m.model, color = Palette.Fg0, fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(2.4f))
            for (v in listOf(m.n, m.ok, m.critere, m.infrastructure, m.echec)) Text(v.toString(), color = Palette.Fg1, fontSize = 11.sp, modifier = Modifier.weight(1f))
        }
    }
    if (d.causes.isNotEmpty()) {
        Text("Causes", color = Palette.Fg2, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
        for ((why, n) in d.causes) Text("$n × $why", color = Palette.Fg1, fontSize = 12.sp)
    }
}
