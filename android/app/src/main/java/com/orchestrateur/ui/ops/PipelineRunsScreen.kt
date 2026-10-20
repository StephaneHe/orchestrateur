package com.orchestrateur.ui.ops

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.enc
import com.orchestrateur.data.getJson
import com.orchestrateur.data.postJson
import com.orchestrateur.ui.common.AppEnv
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.Mono
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.Tag
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

private const val RUNS_POLL_MS = 10_000L

@Composable
fun PipelineRunsScreen() {
    val env = LocalEnv.current
    var filter by remember { mutableStateOf<String?>(null) }
    val confirm = rememberConfirmState()
    val load = rememberLoad(filter, refreshMs = RUNS_POLL_MS) { parseRuns(env.api.getJson(runsPath(filter, 40)).orThrow().json) }
    SectionScaffold("⏸ Exécutions de pipeline", subtitle = "40 dernières · actualisé toutes les 10 s") {
        LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            item { FilterChip("Tous", filter == null) { filter = null } }
            items(env.projectNames()) { p -> FilterChip(p, filter == p) { filter = p } }
        }
        val runs = load.value
        when {
            runs == null && load.error != null -> ErrorLine(load.error, load.reload)
            runs == null -> LoadingLine()
            runs.isEmpty() -> EmptyLine("Aucune exécution de pipeline${filter?.let { " pour $it" } ?: ""}.")
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
                items(runs, key = { it.run }) { r -> RunCard(r, confirm, load.reload) }
            }
        }
    }
    ConfirmHost(confirm)
}

@Composable
private fun FilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
    PillButton(if (selected) "● $label" else label, color = if (selected) Palette.Accent else Palette.Fg1, onClick = onClick)
}

@Composable
private fun RunCard(r: RunView, confirm: ConfirmState, reload: () -> Unit) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    Card(border = if (r.status == "paused") Palette.StInput.copy(alpha = 0.6f) else Palette.CardBorder) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(runTitle(r), color = Palette.Fg0, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Tag(runStatusText(r.status), color = if (r.status == "paused") Palette.StInput else if (r.status == "running") Palette.StLive else Palette.Fg1)
        }
        LinkText(r.project) { env.openMusician(r.project) }
        LinkText(r.run) { env.openId("run", r.run, r.project) }
        Text("créée ${dayHhmm(r.createdAt)}" + (r.endedAt?.let { " · finie ${dayHhmm(it)}" } ?: ""), color = Palette.Fg2, fontSize = 12.sp)
        if (r.steps.isNotEmpty()) StepsTimeline(r.steps)
        if (r.backoff != null && r.status == "running") BackoffBlock(r, r.backoff, env, scope)
        if (r.pause != null && r.pause.options.isNotEmpty()) PauseBlock(r, r.pause, confirm, reload)
        else if (!r.question.isNullOrBlank() && r.status == "paused") Text(r.question, color = Palette.StInput, fontSize = 13.sp)
    }
}

@Composable
private fun StepsTimeline(steps: List<StepView>) {
    Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        for (s in steps) {
            val color = when (s.status) {
                "ok" -> Palette.StLive
                "running" -> Palette.Accent
                "refused", "failed", "launch_refused", "launch_failed" -> Palette.StError
                "model_unavailable" -> Palette.StInput
                else -> Palette.Fg2
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stepMark(s.status), color = color, fontSize = 12.sp, modifier = Modifier.width(92.dp))
                Column(Modifier.weight(1f)) {
                    Text(s.title ?: s.id, color = Palette.Fg0, fontSize = 13.sp)
                    val meta = listOf(modelText(s), durationText(s.durationMs)).filter { it.isNotBlank() }.joinToString(" · ")
                    if (meta.isNotEmpty()) Mono(meta, color = Palette.Fg2, size = 11)
                    if (!s.why.isNullOrBlank()) Text(s.why, color = if (s.status == "skipped") Palette.Fg2 else Palette.StError, fontSize = 12.sp)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BackoffBlock(r: RunView, b: BackoffView, env: AppEnv, scope: CoroutineScope) {
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.fillMaxWidth().background(Palette.Bg1, shape).border(1.dp, Palette.StInput.copy(alpha = 0.4f), shape).padding(8.dp)) {
        Text(backoffText(b) + (b.until?.let { " Prochain essai vers ${hhmm(it)}." } ?: ""), color = Palette.Fg1, fontSize = 13.sp)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((action, label) in listOf("test" to "🔬 Tester le model", "retry" to "↻ Réessayer maintenant")) {
                PillButton(label) {
                    scope.launch {
                        val res = env.api.postJson("/api/pipeline-runs/${enc(r.run)}/backoff", backoffBody(action))
                        env.toast(if (res.ok) (if (action == "test") "Test du model lancé" else "Nouvel essai demandé") else res.errorText())
                    }
                }
            }
            PillButton("⇄ Changer de model (case ${b.slot ?: "?"})") { env.navigate("models") }
        }
    }
}

/** The pause menu of [r]: cause, then each option with what it will do; each answers the pause after confirmation. */
@Composable
private fun PauseBlock(r: RunView, p: PauseView, confirm: ConfirmState, reload: () -> Unit) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (!p.cause.isNullOrBlank()) Text("Cause : ${p.cause}", color = Palette.Fg0, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        for (o in p.options) {
            val accent = if (o.recommended) Palette.Accent else Palette.CardBorder
            Column(
                Modifier.fillMaxWidth().heightIn(min = 44.dp).background(Palette.Bg1, shape).border(1.dp, accent, shape)
                    .clickable {
                        confirm.ask("Répondre « ${o.key} » ?", "${r.project} · ${r.run}\n\n${o.does}", "Répondre") {
                            scope.launch {
                                val res = env.api.postJson("/api/dispatch", pauseReplyBody(r, o.key, env.conductor()))
                                env.toast(if (res.ok) "Réponse envoyée : ${o.key}" else "Envoi impossible : ${res.errorText()}")
                                reload()
                            }
                        }
                    }
                    .padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(o.key, color = if (o.recommended) Palette.Accent else Palette.Fg0, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    if (o.recommended) Tag("recommandé", color = Palette.Accent)
                }
                Text(o.does, color = Palette.Fg1, fontSize = 12.sp)
                if (o.recommended && !p.recommendWhy.isNullOrBlank()) Text("Pourquoi : ${p.recommendWhy}", color = Palette.Fg2, fontSize = 12.sp)
            }
        }
    }
}

/** Choices of the paused pipeline run of [project] (buttons that answer the pause); nothing when none. */
@Composable
fun PauseChoices(project: String) {
    val env = LocalEnv.current
    val confirm = rememberConfirmState()
    val load = rememberLoad(project, refreshMs = RUNS_POLL_MS) { parseRuns(env.api.getJson(runsPath(project, 10)).orThrow().json) }
    val run = latestPausedWithMenu(load.value.orEmpty().filter { it.project == project }) ?: return
    Card(border = Palette.StInput.copy(alpha = 0.6f)) {
        Text("⏸ ${runTitle(run)} en pause", color = Palette.StInput, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        LinkText(run.run) { env.openId("run", run.run, run.project) }
        PauseBlock(run, run.pause!!, confirm, load.reload)
    }
    ConfirmHost(confirm)
}
