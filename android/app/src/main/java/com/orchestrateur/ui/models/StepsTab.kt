package com.orchestrateur.ui.models

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.Mono
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.Tag
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.launch

@Composable
fun StepsTab(st: ModelsState) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val r = st.routing
    if (r == null) {
        if (st.error != null) ErrorLine(st.error!!) { scope.launch { st.load(env.api, false) } }
        else LoadingLine("Chargement des pipelines et des listes de models…")
        return
    }
    val p = r.pipeline(st.pipeline) ?: r.pipelines.firstOrNull() ?: return
    LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
        st.error?.let { e -> item { ErrorLine(e) } }
        st.gapNotice?.let { n -> item { Card { Body(n, Ok) } } }
        r.migration?.let { m ->
            if (!st.migrationSeen) item {
                Card(border = Warn) {
                    Body("Migration depuis l’ancienne structure (20 types en 6 étapes) : ${m.mapped} affectation(s) reprise(s)" +
                        if (m.lost.isNotEmpty()) ", ${m.lost.size} perdue(s)." else ", aucune perdue.")
                    m.lost.forEach { Dim(it, Warn) }
                    PillButton("Compris") { st.migrationSeen = true }
                }
            }
        }
        item {
            FlowRowCompat {
                PillButton(if (st.refreshing) "↻ Rafraîchissement…" else "↻ Rafraîchir les listes", enabled = !st.refreshing) {
                    scope.launch { st.refreshing = true; st.load(env.api, true); st.refreshing = false }
                }
                PillButton("Historique (${r.historyTotal})", color = Palette.Fg1) { st.showHistory = !st.showHistory }
            }
        }
        if (st.showHistory) item {
            Card {
                Body("Historique", weight = FontWeight.SemiBold)
                val lines = historyLines(r)
                if (lines.isEmpty()) Dim("Aucun changement enregistré.")
                lines.forEach { Dim(it, Palette.Fg1) }
                if (r.historyTotal > r.history.size) Dim("${r.history.size} derniers sur ${r.historyTotal}.")
            }
        }
        st.reco?.let { reco ->
            if (reco.report != null) item { RecoBox(st, reco) }
        }
        item {
            ChipRow(r.pipelines.map { it.id to "${it.icon} ${it.label} ${tabCount(r, it.id)}".trim() }, p.id) { st.pipeline = it }
        }
        item {
            Card {
                Fold("Légende des symboles", "mr-legend") {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        listOf(
                            "→ étape suivante, dans l’ordre", "↻ boucle : on recommence ces étapes",
                            "↩ retour possible vers une étape antérieure", "⤳ renvoi vers un autre pipeline (ses models s’appliquent)",
                            "◇ variantes : un menu par cas ; vide = model de l’étape",
                            "💡 conseil (non imposé) · ⚠ conseil non suivi",
                            "action : lit, écrit ou exécute dans le projet · jugement : rend un avis sur un texte fourni",
                            if (r.agentHarness.values.any { !it })
                                "🔧 outillage en construction : ${r.agentHarness.filter { !it.value }.keys.joinToString(" et ") { PLABEL[it] ?: it }}, étapes de jugement seulement pour l’instant"
                            else "🔧 tous les fournisseurs sont outillés : NVIDIA et OpenRouter agissent comme Claude et codex (harnais codex)",
                        ).forEach { Dim(it, Palette.Fg1) }
                    }
                }
            }
        }
        item { Banner(r, p) }
        items(p.flow, key = { n -> "${p.id}:" + when (n) { is FlowNode.Loop -> "loop:${n.id}"; is FlowNode.StepNode -> n.step.id } }) { n ->
            when (n) {
                is FlowNode.StepNode -> StepCard(st, p, n.step)
                is FlowNode.Loop -> LoopCard(st, p, n)
            }
        }
        val loops = loopsLines(p, r.pipelines)
        if (loops.isNotEmpty()) item {
            Card {
                Body("Boucles, retours et renvois", weight = FontWeight.SemiBold)
                loops.forEach { Dim(it, Palette.Fg1) }
            }
        }
        item {
            Card {
                Fold("D’où viennent les listes", "mr-sources") {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { sourcesLines(st.catalog, r).forEach { Dim(it, Palette.Fg1) } }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowCompat(content: @Composable () -> Unit) {
    FlowRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { content() }
}

@Composable
private fun Banner(r: Routing, p: Pipeline) {
    Card {
        Body("${p.icon} ${p.label}", Palette.Fg0, 15, FontWeight.SemiBold)
        Body("À quoi il sert : ${p.purpose}")
        Body("Quand il s’applique : ${p.whenText}")
        p.variantsInfo.forEach { (l, t) -> Dim("• $l : $t", Palette.Fg1) }
        p.advice.forEach { Dim("💡 $it", Palette.Fg1) }
        p.sourceLabel?.let { Dim("Référence : $it") }
        Dim("Répartition : ${distributionText(r, p.id)}")
    }
}

@Composable
private fun LoopCard(st: ModelsState, p: Pipeline, n: FlowNode.Loop) = Column {
    Card(border = Palette.Accent.copy(alpha = 0.5f)) {
        Body("↻ ${n.n} ${n.title}", Palette.Fg0, 14, FontWeight.SemiBold)
        Dim(n.what, Palette.Fg1)
        incomingFrom(p, n.id).forEach { Dim("⟲ point de retour depuis $it") }
    }
    n.steps.forEach { s -> Column(Modifier.padding(start = 10.dp)) { StepCard(st, p, s) } }
    val names = stepsOf(p).associate { it.id to "${it.n} ${it.title}" }
    Dim("    ↺ ${names[n.backFrom] ?: n.backFrom} → ${names[n.backTo] ?: n.backTo} : ${n.backLabel}", Palette.Accent)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StepCard(st: ModelsState, p: Pipeline, s: Step) {
    val r = st.routing ?: return
    val slotId = "${p.id}.${s.id}"
    val a = r.assignments[slotId]
    Card(border = if (st.highlight == slotId) Palette.Accent else Palette.CardBorder) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Body("${s.n}  ${s.title}", Palette.Fg0, 14, FontWeight.SemiBold)
            s.optional?.let { Tag(it, Palette.Fg2) }
            if (s.custom || p.custom) Tag("✦ ajouté", Palette.Accent)
            if (s.ref == null) {
                val isText = s.need == null || s.need.llm == "text"
                if (isText) Tag(if (s.judge) "jugement" else "action", if (s.judge) Palette.StUnread else Palette.StThink)
                if (a?.second != null) Tag("×2", Palette.Accent)
                Tag(providerTag(a), if (a == null) Palette.Fg2 else Palette.Fg0)
            }
        }
        Body(s.what)
        Text("Ex. ${s.example}", color = Palette.Fg2, fontSize = 12.sp, fontStyle = FontStyle.Italic)
        returnLines(p, s).forEach { Dim(it, Palette.Fg1) }
        incomingFrom(p, s.id).forEach { Dim("⟲ point de retour depuis $it") }
        if (s.ref != null) {
            val target = r.pipeline(s.ref.pipeline)
            PillButton("⤳ ${s.ref.label} — ouvrir « ${target?.label ?: s.ref.pipeline} »") { st.pipeline = s.ref.pipeline }
            return@Card
        }
        needText(s.need, r.caps)?.let { Dim(it) }
        s.advice?.let { Dim("💡 $it", Palette.Fg1) }
        adviceWarnings(p.id, r.assignments)[slotId]?.let { Dim("⚠ $it", Warn) }
        SlotEditor(st, slotId, if (s.variants.isNotEmpty()) "Model de l’étape (toutes variantes)" else "Model de l’étape")
        if (s.variants.isNotEmpty()) {
            val open = slotId in st.openVariants
            val dots = s.variants.joinToString(" ") { v ->
                val e = r.assignments["$slotId.${v.id}"] ?: a
                if (e == null) "○" else PSHORT[e.provider] ?: e.provider
            }
            PillButton("${if (open) "▾" else "▸"} ◇ Variantes (${s.variants.size})  $dots", color = Palette.Fg1) {
                if (open) st.openVariants.remove(slotId) else st.openVariants.add(slotId)
            }
            if (open) s.variants.forEach { v ->
                val vid = "$slotId.${v.id}"
                Column(Modifier.fillMaxWidth().padding(start = 8.dp, top = 6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Body(v.label, Palette.Fg0, weight = FontWeight.SemiBold)
                        if (r.assignments[vid]?.second != null) Tag("×2", Palette.Accent)
                        if (v.custom) Tag("✦ ajouté", Palette.Accent)
                    }
                    if (v.what.isNotEmpty()) Dim(v.what, Palette.Fg1)
                    if (v.need != null && v.need != s.need) needText(v.need, r.caps)?.let { Dim(it) }
                    SlotEditor(st, vid, "Model — ${v.label}")
                }
            }
        }
    }
}

/** Principal + second pickers of one slot, with its status, warnings and suggestion. */
@Composable
private fun SlotEditor(st: ModelsState, slotId: String, label: String) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val r = st.routing ?: return
    val slot = r.slot(slotId) ?: return
    val a = r.assignments[slotId]
    val menu = remember(slot, st.catalog, r, false) { buildMenu(slot, st.catalog, r, second = false) }
    val menu2 = remember(slot, st.catalog, r, true) { buildMenu(slot, st.catalog, r, second = true) }
    val v1 = a?.value ?: ""
    val v2 = a?.second?.value ?: ""
    ModelPicker("Principal · $label", menu, v1, currentLabel(menu, v1, st.catalog)) { v ->
        scope.launch { st.save(env.api, slotId, v, second = false) }
    }
    ModelPicker("Second (optionnel)", menu2, v2, currentLabel(menu2, v2, st.catalog), enabled = a != null,
        hint = "Choisissez d’abord le model principal de cette case.") { v ->
        scope.launch { st.save(env.api, slotId, v, second = true) }
    }
    dualNote(r, slotId)?.let { Dim(it, if (it.startsWith("⚠")) Warn else Palette.Fg1) }
    obsoleteWarnings(r, st.catalog, slotId).forEach { Dim(it, Warn) }
    val status = st.status[slotId]
    val text = status?.text ?: idleStatus(r, slotId)
    if (text.isNotEmpty()) Dim(text, when (status?.kind) { "error" -> Palette.StError; "saving" -> Palette.Fg2; else -> Ok })
    st.reco?.slots?.get(slotId)?.let { RecoBlock(st, st.reco!!, slotId, it) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RecoBlock(st: ModelsState, reco: Reco, slotId: String, s: SlotReco) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val r = st.routing ?: return
    val state = recoState(s, r.assignments[slotId])
    Column(Modifier.fillMaxWidth().padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Body("💡 Suggestion${if (s.inherited) " (celle de l’étape)" else ""}", Palette.Fg0, 12, FontWeight.SemiBold)
            if (s.confidence.isNotEmpty()) Tag("confiance ${s.confidence}", Palette.Fg1)
            if (s.undecided) Tag("non tranché", Warn)
            if (s.extrapolated != null) Tag("extrapolé", Palette.Fg2)
        }
        Dim("Principal suggéré : ${refText(s.principal)}" + if (state.text.isNotEmpty()) " — ${state.text}" else "",
            if (state.followed) Ok else Palette.Fg1)
        if (s.alternatives.isNotEmpty()) Dim("Alternative : ${s.alternatives.joinToString(" · ") { altText(it) }}")
        Fold("Pourquoi ? (${s.section})", "why:$slotId") {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Dim(s.why, Palette.Fg1)
                s.extrapolated?.let { Dim(it) }
                s.note?.let { Dim(it) }
                Dim(recoSourceText(reco, s), Palette.Fg3, 11)
            }
        }
        PillButton("Appliquer la suggestion", enabled = s.principal.applicable && !state.followed) {
            scope.launch { st.recoPrepare(env.api, "one", slotId) }
        }
        st.recoConfirm?.takeIf { it.slot == slotId }?.let { ConfirmBlock(st, it) }
    }
}

@Composable
private fun RecoBox(st: ModelsState, reco: Reco) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    Card {
        Body(recoBoxText(reco), size = 12)
        recoAgeText(reco)?.let { Dim(it, Warn) }
        PillButton("Appliquer les suggestions aux étapes vides seulement") { scope.launch { st.recoPrepare(env.api, "empty", null) } }
        st.recoConfirm?.takeIf { it.mode == "empty" }?.let { ConfirmBlock(st, it) }
        st.recoNotice?.let { Dim("✓ $it", Ok) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ConfirmBlock(st: ModelsState, c: RecoConfirm) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val r = st.routing
    Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        when {
            c.error != null -> {
                Dim("✕ ${c.error}", Palette.StError)
                PillButton("Fermer", color = Palette.Fg1) { st.recoConfirm = null }
            }
            c.plan == null -> Dim("Préparation…")
            else -> {
                Body(confirmHead(c.plan), size = 12)
                if (c.plan.items.isNotEmpty()) {
                    Fold("Détail (${c.plan.items.size})", "plan:${c.mode}:${c.slot}", initiallyOpen = c.mode == "one") {
                        Column { c.plan.items.forEach { Mono("${r?.slotLabel(it.slot) ?: it.slot} : ${planLine(it)}", size = 11) } }
                    }
                }
                FlowRowCompat {
                    PillButton("Confirmer", enabled = c.plan.items.isNotEmpty() && !c.busy) { scope.launch { st.recoApply(env.api) } }
                    PillButton("Annuler", color = Palette.Fg1) { st.recoConfirm = null }
                }
                Dim("Chaque changement est inscrit dans l’historique (« suggestion du rapport »).", Palette.Fg3, 11)
            }
        }
    }
}
