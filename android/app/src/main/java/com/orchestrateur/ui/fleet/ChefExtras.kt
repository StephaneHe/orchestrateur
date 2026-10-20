package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.Api
import com.orchestrateur.data.RestResult
import com.orchestrateur.data.b
import com.orchestrateur.data.deleteJson
import com.orchestrateur.data.enc
import com.orchestrateur.data.postJson
import com.orchestrateur.data.s
import com.orchestrateur.ui.common.ConfirmDialog
import com.orchestrateur.ui.common.InputDialog
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.ops.AutoAnswerBand
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// ============================================================================
// Chef thread parity (1.0.0): direction queue, notification dock, speech,
// « Vu » / « Marquer comme répondue ».
// ============================================================================

/** POST /api/question/:p/resolve — 409 alreadyHandled counts as done (the web hides the card too). */
suspend fun resolveQuestion(api: Api, project: String, note: String = "répondu via le chef"): RestResult {
    val r = api.postJson("/api/question/${enc(project)}/resolve", buildJsonObject { put("note", note); put("by", "android") })
    return if (r.code == 409 && r.json.b("alreadyHandled")) r.copy(code = 200) else r
}

/** POST /api/ack/:p — « Vu » on a failure, a stop or an unread result. */
suspend fun ackProject(api: Api, project: String): RestResult =
    api.postJson("/api/ack/${enc(project)}", buildJsonObject { put("by", "utilisateur") })

/** Shared action row: ✓ Vu / ✓ Marquer comme répondue (with an optional note). */
@Composable
fun AckButtons(project: String, question: Boolean, error: Boolean, onDone: () -> Unit = {}) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    var askNote by remember { mutableStateOf(false) }
    if (question) ActionChip("✓ Marquer comme répondue") { askNote = true }
    if (error) ActionChip("✓ Vu") {
        scope.launch {
            val r = ackProject(env.api, project)
            env.toast(if (r.ok) "$project : marqué vu" else r.errorText())
            if (r.ok) onDone()
        }
    }
    if (askNote) InputDialog(
        title = "Marquer la question de $project comme répondue",
        initial = "répondu via le chef", label = "Note (facultative)", confirm = "Marquer répondue",
        onSubmit = { note ->
            scope.launch {
                val r = resolveQuestion(env.api, project, note.ifBlank { "répondu via le chef" })
                env.toast(if (r.ok) "$project : question marquée répondue" else r.errorText())
                if (r.ok) onDone()
            }
        },
        onDismiss = { askNote = false },
    )
}

/** « 🔊 écouter / ⏹ arrêter » on a chef bubble (device speech engine). */
@Composable
fun TtsButton(id: String, text: String) {
    val env = LocalEnv.current
    if (env.prefs.ttsOff) return
    val on = env.tts.speakingId == id
    Text(
        if (on) "⏹ arrêter" else "🔊 écouter",
        color = if (on) Palette.Accent else Palette.Fg3, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
        modifier = Modifier.heightIn(min = 36.dp).clickable { env.tts.toggle(id, text) }.padding(horizontal = 8.dp, vertical = 8.dp),
    )
}

/**
 * Direction queue (web #poolband): messages waiting for a chef slot, each with
 * « Retirer » (its text goes back into an empty composer) and, per busy slot,
 * « Interrompre le chef avec ce message ».
 */
@Composable
fun PoolBand(vm: FleetViewModel) {
    val pool = vm.pool
    val head = pool.headline() ?: return
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var interrupt by remember { mutableStateOf<Pair<Int, String>?>(null) }
    Column(Modifier.fillMaxWidth().background(blend(Palette.Accent, Palette.Bg0, 0.06f))) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { open = !open }.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(head, color = Palette.Fg1, fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
            Text(if (open) "▾" else "▸", color = Palette.Fg2, fontSize = 10.sp)
        }
        if (open) Column(Modifier.padding(horizontal = 14.dp).padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            pool.queue.forEach { t ->
                Text("${t.position}. ${t.head}" + (if (t.interrupting) " · interrompt" else "") + " (${t.cls})",
                    color = Palette.Fg0, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ActionChip("Retirer") {
                        scope.launch {
                            val r = env.api.deleteJson("/api/pool/queue/${enc(t.id)}")
                            if (r.ok) {
                                r.json.s("draft")?.takeIf { it.isNotBlank() }?.let { vm.prepareChefMessage(it) }
                                env.toast("retiré de la file")
                            } else env.toast(r.errorText())
                        }
                    }
                    pool.busySlots().firstOrNull()?.let { slot ->
                        ActionChip("Interrompre le chef avec ce message") { interrupt = slot.slot to t.head }
                    }
                }
            }
        }
    }
    interrupt?.let { (slot, text) ->
        ConfirmDialog(
            title = "Interrompre le chef",
            text = "Le tour en cours du chef $slot est interrompu et ce message passe en premier :\n« ${text.take(200)} »",
            confirm = "Interrompre",
            onConfirm = {
                scope.launch {
                    val r = env.api.postJson("/api/pool/interrupt/$slot")
                    env.toast(if (r.ok) "chef $slot interrompu" else r.errorText())
                }
            },
            onDismiss = { interrupt = null },
        )
    }
}

/**
 * Notification dock (web #notif-dock): permission requests and automatic
 * decisions in one compact zone, bounded height with its own scroll, never
 * over the page; « Tout réduire » remembered.
 */
@Composable
fun NotificationDock(vm: FleetViewModel) {
    val env = LocalEnv.current
    val n = vm.permissions.size
    val collapsed = env.prefs.dockCollapsed
    Column(Modifier.fillMaxWidth()) {
        if (n > 0) Row(
            Modifier.fillMaxWidth().heightIn(min = 40.dp).clickable { env.prefs.updateDockCollapsed(!collapsed) }
                .background(blend(Palette.StInput, Palette.Bg0, 0.08f)).padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("🔔 $n demande${if (n > 1) "s" else ""} en attente", color = Palette.StInput, fontSize = 11.sp,
                fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
            Text(if (collapsed) "▸ Déplier" else "▾ Tout réduire", color = Palette.Fg2, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
        }
        Column(Modifier.fillMaxWidth().heightIn(max = 260.dp).verticalScroll(rememberScrollState())) {
            if (!collapsed) PermissionBand(vm)
            AutoAnswerBand()
        }
    }
}
