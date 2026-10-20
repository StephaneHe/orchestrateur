package com.orchestrateur.ui.ops

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.enc
import com.orchestrateur.data.getJson
import com.orchestrateur.data.postJson
import com.orchestrateur.ui.common.AppEnv
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.SectionTitle
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject

private const val AUTO_POLL_MS = 30_000L
private const val SNOOZE_PREFS = "ops"
private const val SNOOZE_KEY = "aa.snoozed"

private fun readSnoozed(ctx: Context): Map<String, Long> =
    decodeSnoozed(ctx.getSharedPreferences(SNOOZE_PREFS, Context.MODE_PRIVATE).getString(SNOOZE_KEY, null))

private fun writeSnoozed(ctx: Context, m: Map<String, Long>) =
    ctx.getSharedPreferences(SNOOZE_PREFS, Context.MODE_PRIVATE).edit().putString(SNOOZE_KEY, encodeSnoozed(m)).apply()

/** Actions on decisions shared by the overview and the dock band. */
private class AutoActions(val env: AppEnv, val confirm: ConfirmState, val launch: (suspend () -> Unit) -> Unit, val reload: () -> Unit) {
    fun undo(d: AutoDecision) = confirm.ask("Annuler cette décision automatique ?",
        "L’élément revient à son point de retour (son état actuel est gardé).", "Annuler la décision") {
        launch {
            val r = env.api.postJson("/api/auto-answer/${enc(d.id)}/undo", buildJsonObject {})
            if (!r.ok) env.toast("Annulation impossible : ${r.errorText()}")
            reload()
        }
    }

    fun dismiss(d: AutoDecision) {
        val send: (Boolean) -> Unit = { confirmIt ->
            launch {
                val r = env.api.postJson("/api/auto-answer/dismiss", dismissBody(d.id, confirmIt))
                when {
                    r.ok -> reload()
                    !confirmIt && dismissNeedsConfirm(r.code, r.json) -> askPending { launch { postConfirmed(d) } }
                    else -> { env.toast("Écarter impossible : ${r.errorText()}"); reload() }
                }
            }
        }
        if (d.phase == "pending") askPending { send(true) } else send(false)
    }

    private suspend fun postConfirmed(d: AutoDecision) {
        val r = env.api.postJson("/api/auto-answer/dismiss", dismissBody(d.id, true))
        if (!r.ok) env.toast("Écarter impossible : ${r.errorText()}")
        reload()
    }

    private fun askPending(action: () -> Unit) = confirm.ask("Écarter quand même ?",
        "Cette décision attend encore la vôtre.\nL’écarter la retire de la vue (elle reste dans l’historique) sans y répondre.", "Écarter", action)

    fun openTarget(d: AutoDecision) {
        val t = d.target
        when {
            t?.type == "gap" -> env.navigate("models")
            t?.type == "run" && t.id != null -> env.openId("run", t.id, t.project)
            (t?.project ?: d.project) != null -> env.openMusician(t?.project ?: d.project!!)
        }
    }
}

@Composable
private fun rememberAutoActions(confirm: ConfirmState, reload: () -> Unit): AutoActions {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    return remember(env, confirm, reload) { AutoActions(env, confirm, { block -> scope.launch { block() } }, reload) }
}

@Composable
fun AutoAnswerScreen() {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val confirm = rememberConfirmState()
    val load = rememberLoad(refreshMs = AUTO_POLL_MS) { parseAutoOverview(env.api.getJson("/api/auto-answer").orThrow().json) }
    val actions = rememberAutoActions(confirm, load.reload)
    var showGuards by remember { mutableStateOf(false) }
    var showBacklog by remember { mutableStateOf(false) }
    var showHistory by remember { mutableStateOf(false) }
    SectionScaffold("🤖 Réponse automatique") {
        val o = load.value
        when {
            o == null && load.error != null -> ErrorLine(load.error, load.reload)
            o == null -> LoadingLine()
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
                item {
                    Card {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Règle active : Opus 5.5 répond à ma place quand je suis inactif", color = Palette.Fg0, fontSize = 14.sp, modifier = Modifier.weight(1f))
                            Switch(checked = o.settings.enabled, onCheckedChange = { on ->
                                scope.launch {
                                    val r = env.api.postJson("/api/auto-answer/settings", settingsEnabledBody(on))
                                    if (!r.ok) env.toast(r.errorText())
                                    load.reload()
                                }
                            })
                        }
                        DelaysEditor(o.settings) { body ->
                            scope.launch {
                                val r = env.api.postJson("/api/auto-answer/settings", body)
                                env.toast(if (r.ok) "enregistré" else r.errorText())
                                load.reload()
                            }
                        }
                        Text("Dernier signe de vous : ${hhmm(o.activity.lastAt).ifEmpty { "—" }}${o.activity.lastKind?.let { " ($it)" } ?: ""} · " +
                            "lire le dashboard compte comme une activité · règle active depuis ${dayHhmm(o.settings.activatedAt).ifEmpty { "—" }} · " +
                            "model ${o.model}, aucun repli.", color = Palette.Fg2, fontSize = 12.sp)
                    }
                }
                item {
                    Card(onClick = { showGuards = !showGuards }) {
                        Text((if (showGuards) "▾ " else "▸ ") + guardrailsLine(o.guardrails.size), color = Palette.Fg1, fontSize = 13.sp)
                        if (showGuards) {
                            Text("Obligatoires et toujours actifs, indépendants de l’interrupteur. Dans ces cas, Opus choisit l’option qui avance sans engager, sinon le point vous est soumis. " +
                                "Les modifier demande une nouvelle décision de votre part (fichier data/auto-answer-guardrails.json) : aucun bouton ici.",
                                color = Palette.Fg2, fontSize = 12.sp)
                            for (g in o.guardrails) {
                                Text("• ${g.label}", color = Palette.Fg0, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                                for (c in g.cases) Text("   – $c", color = Palette.Fg1, fontSize = 12.sp)
                            }
                        }
                    }
                }
                if (o.backlog.isNotEmpty()) {
                    item {
                        Card(onClick = { showBacklog = !showBacklog }) {
                            Text((if (showBacklog) "▾ " else "▸ ") + backlogTitle(o.backlog.size), color = Palette.Fg1, fontSize = 13.sp)
                        }
                    }
                    if (showBacklog) items(o.backlog, key = { "b-${it.key}" }) { w ->
                        Card {
                            Text("${dayHhmm(w.since)} · ${kindText(w.kind)}", color = Palette.Fg2, fontSize = 12.sp)
                            LinkText(w.targetLabel) {
                                when {
                                    w.kind == "gap" -> env.navigate("models")
                                    w.run != null -> env.openId("run", w.run, w.project)
                                    w.project != null -> env.openMusician(w.project)
                                }
                            }
                            Text(w.question, color = Palette.Fg0, fontSize = 13.sp)
                            Text(w.reasonText, color = Palette.Fg2, fontSize = 12.sp)
                        }
                    }
                }
                item { SectionTitle("Décisions automatiques") }
                item {
                    val n = discardableCount(o.decisions)
                    PillButton(discardAllLabel(n), enabled = n > 0, modifier = Modifier.padding(horizontal = 12.dp)) {
                        scope.launch {
                            val r = env.api.postJson("/api/auto-answer/dismiss", dismissHandledBody())
                            if (!r.ok) env.toast(r.errorText())
                            load.reload()
                        }
                    }
                }
                if (o.decisions.isEmpty()) item { Text("Aucune.", color = Palette.Fg2, fontSize = 13.sp, modifier = Modifier.padding(16.dp)) }
                items(o.decisions, key = { it.id }) { d -> Card { DecisionBody(d, actions, compact = false) } }
                if (o.history.isNotEmpty()) {
                    item {
                        val n = o.history.size
                        Card(onClick = { showHistory = !showHistory }) {
                            Text((if (showHistory) "▾ " else "▸ ") + "Historique : $n décision${if (n > 1) "s" else ""} écartée${if (n > 1) "s" else ""}",
                                color = Palette.Fg1, fontSize = 13.sp)
                        }
                    }
                    if (showHistory) items(o.history, key = { "h-${it.id}" }) { d -> Card { DecisionBody(d, actions, compact = false) } }
                }
            }
        }
    }
    ConfirmHost(confirm)
}

@Composable
private fun DelaysEditor(s: AutoSettings, onSave: (kotlinx.serialization.json.JsonObject) -> Unit) {
    val env = LocalEnv.current
    var idle by remember(s.idleMin) { mutableStateOf(s.idleMin?.toString() ?: "") }
    var wait by remember(s.waitMin) { mutableStateOf(s.waitMin?.toString() ?: "") }
    val num = KeyboardOptions(keyboardType = KeyboardType.Number)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(idle, { idle = it }, label = { Text("Inactivité (min)", fontSize = 11.sp) }, singleLine = true, keyboardOptions = num, modifier = Modifier.weight(1f))
        OutlinedTextField(wait, { wait = it }, label = { Text("Sans réponse depuis (min)", fontSize = 11.sp) }, singleLine = true, keyboardOptions = num, modifier = Modifier.weight(1f))
    }
    PillButton("Enregistrer") {
        val body = delaysBody(idle, wait)
        if (body == null) env.toast("Délais : nombres entiers de 1 à 1440 minutes") else onSave(body)
    }
}

/** One decision; [compact] = dock band line (details on demand). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DecisionBody(d: AutoDecision, actions: AutoActions, compact: Boolean, open: Boolean = true, onToggle: () -> Unit = {}, onSnooze: () -> Unit = {}) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("${hhmm(d.at)}  🤖 ${d.what}", color = Palette.Fg0, fontSize = 13.sp,
            maxLines = if (compact && !open) 2 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("sur ", color = Palette.Fg2, fontSize = 12.sp)
            if (d.target != null) LinkText(d.target.label) { actions.openTarget(d) } else Text(d.project ?: "—", color = Palette.Fg1, fontSize = 12.sp)
        }
        if (!d.phase.isNullOrBlank()) Text(phaseText(d.phase), color = if (d.phase == "pending") Palette.StInput else Palette.Fg2, fontSize = 12.sp)
        if (open) {
            if (!d.whyInactive.isNullOrBlank()) Text("Pourquoi à votre place : ${d.whyInactive}", color = Palette.Fg1, fontSize = 12.sp)
            if (d.questionLine.isNotEmpty()) Text("Demande : ${d.questionLine}", color = Palette.Fg1, fontSize = 12.sp)
            d.answerLine?.let { Text("Réponse : $it", color = Palette.Fg0, fontSize = 12.sp) }
            d.reason?.let { Text("Raison : $it", color = Palette.Fg1, fontSize = 12.sp) }
            if (!d.why.isNullOrBlank() && d.status != "applied") Text(d.why, color = Palette.Fg1, fontSize = 12.sp)
            d.obsolete?.let { Text("Obsolète : $it", color = Palette.Fg2, fontSize = 12.sp) }
            if (d.hits.isNotEmpty()) Text("⚠ garde-fou : ${d.hits.joinToString(", ")}", color = Palette.StError, fontSize = 12.sp)
            d.recoveryText?.let { Text(it, color = Palette.Fg2, fontSize = 12.sp) }
        }
        if (d.dismissed) {
            Text("écartée ${dayHhmm(d.dismissedAt)}", color = Palette.Fg3, fontSize = 12.sp)
            if (d.undoable) PillButton("Annuler") { actions.undo(d) }
        } else FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (compact) PillButton(if (open) "Masquer" else "Détail", color = Palette.Fg1, onClick = onToggle)
            if (d.undoable) PillButton("Annuler") { actions.undo(d) }
            else if (d.undone) Text("↩ annulée", color = Palette.Fg2, fontSize = 12.sp, modifier = Modifier.padding(vertical = 14.dp))
            if (compact) PillButton("Reporter", color = Palette.Fg1, onClick = onSnooze)
            PillButton("Écarter", color = Palette.Fg1) { actions.dismiss(d) }
        }
    }
}

/** Compact band of automatic decisions for the notification dock; nothing when there is none to show. */
@Composable
fun AutoAnswerBand() {
    val env = LocalEnv.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val confirm = rememberConfirmState()
    val load = rememberLoad(refreshMs = AUTO_POLL_MS) { parseAutoOverview(env.api.getJson("/api/auto-answer").orThrow().json) }
    val actions = rememberAutoActions(confirm, load.reload)
    var snoozed by remember { mutableStateOf(readSnoozed(ctx)) }
    var expanded by remember { mutableStateOf(false) }
    val open = remember { mutableStateMapOf<String, Boolean>() }
    val o = load.value ?: return
    val items = bandItems(o.decisions, snoozed, System.currentTimeMillis())
    if (items.isEmpty()) { ConfirmHost(confirm); return }
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).background(Palette.CardBg, shape).border(1.dp, Palette.Accent.copy(alpha = 0.5f), shape)) {
        Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).heightIn(min = 44.dp).clickable { expanded = !expanded }, verticalAlignment = Alignment.CenterVertically) {
                Text(if (expanded) "▾" else "▸", color = Palette.Fg2, fontSize = 13.sp, modifier = Modifier.width(16.dp))
                Text(bandTitle(items.size), color = Palette.Fg0, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            PillButton("✓ Vu", color = Palette.Fg1) {
                scope.launch { env.api.postJson("/api/auto-answer/seen", buildJsonObject {}); load.reload() }
            }
        }
        if (expanded) {
            Column(Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(rememberScrollState()).padding(horizontal = 10.dp)) {
                PillButton("Récapitulatif…", color = Palette.Fg1) { env.navigate("reponse-auto") }
                for (d in items) {
                    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        DecisionBody(d, actions, compact = true, open = open[d.id] == true,
                            onToggle = { open[d.id] = open[d.id] != true },
                            onSnooze = { snoozed = snooze(snoozed, d.id, System.currentTimeMillis()).also { writeSnoozed(ctx, it) } })
                    }
                }
            }
        }
    }
    ConfirmHost(confirm)
}
