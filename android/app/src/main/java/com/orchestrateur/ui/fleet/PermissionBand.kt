package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.orchestrateur.data.PermissionRequest
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.delay

// ============================================================================
// Demandes d'autorisation interactives (serveur 0.45.0) — même contrat que le
// dashboard : une carte par demande (compte à rebours, « Une fois »,
// « Toujours… », « Refuser… ») et, au toucher, tous les détails de l'opération.
// ============================================================================

private val CyanTool = Color(0xFF5AD1E8)
private val AllowGreen = Color(0xFF6FCF97)

private fun riskColor(level: String) = when (level) {
    "élevé" -> Palette.StError
    "faible" -> AllowGreen
    else -> Palette.Accent
}

private fun fmtLeft(ms: Long): String {
    if (ms <= 0) return "expiré"
    val s = (ms + 999) / 1000
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
}

@Composable
fun PermissionBand(vm: FleetViewModel) {
    if (vm.permissions.isEmpty()) return
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); delay(1000) } }
    var openId by remember { mutableStateOf<String?>(null) }
    var openFocus by remember { mutableStateOf("") }

    Column(
        Modifier.fillMaxWidth()
            .background(Palette.Accent.copy(alpha = 0.10f))
            .border(1.dp, Palette.Accent.copy(alpha = 0.6f))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val n = vm.permissions.size
        Text(if (n == 1) "🔐 1 autorisation attend votre décision" else "🔐 $n autorisations attendent votre décision",
            color = Palette.Accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        for (p in vm.permissions) {
            val left = p.deadline - (now - vm.serverSkewMs)
            Column(
                Modifier.fillMaxWidth()
                    .background(Palette.Bg1, RoundedCornerShape(6.dp))
                    .border(1.dp, riskColor(p.risk.level).copy(alpha = 0.7f), RoundedCornerShape(6.dp))
                    .padding(8.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth().clickable { openFocus = ""; openId = p.id },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("${p.project}${p.branch?.let { " (branche $it)" } ?: ""} attend votre autorisation", color = Palette.Fg0, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(p.tool, color = CyanTool, fontFamily = FontFamily.Monospace, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            Spacer(Modifier.width(6.dp))
                            Text(p.preview, color = Palette.Fg1, fontFamily = FontFamily.Monospace, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Text("risque ${p.risk.level} · ${p.risk.tags.joinToString(", ")} · toucher pour les détails", color = riskColor(p.risk.level), fontSize = 11.sp)
                    }
                    Text(fmtLeft(left), color = if (left < 60_000) Palette.StError else Palette.Fg0, fontFamily = FontFamily.Monospace, fontSize = 13.sp,
                        modifier = Modifier.padding(start = 8.dp))
                }
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PermButton("Une fois", AllowGreen, Modifier.weight(1f)) { vm.decidePermission(p.id, "allow_once") }
                    PermButton("Toujours…", CyanTool, Modifier.weight(1f)) { openFocus = "always"; openId = p.id }
                    PermButton("Refuser…", Palette.StError, Modifier.weight(1f)) { openFocus = "deny"; openId = p.id }
                }
            }
        }
    }
    openId?.let { id -> PermissionDetailsDialog(vm, id, openFocus) { openId = null } }
}

@Composable
private fun PermButton(label: String, color: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = 44.dp),
        contentPadding = PaddingValues(horizontal = 6.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, color),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = color),
    ) { Text(label, fontSize = 12.sp, maxLines = 1) }
}

@Composable
private fun PermissionDetailsDialog(vm: FleetViewModel, id: String, focus: String, onDismiss: () -> Unit) {
    var req by remember { mutableStateOf<PermissionRequest?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var rule by remember { mutableStateOf<String?>(null) }
    var reason by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(id) {
        runCatching { vm.permissionDetails(id) }
            .onSuccess { r -> req = r; rule = (r.suggestions.firstOrNull { it.scope == "pattern" } ?: r.suggestions.firstOrNull { it.scope == "exact" } ?: r.suggestions.firstOrNull())?.rule }
            .onFailure { error = it.message }
    }
    val decide: (String, String?, String?) -> Unit = { decision, r, msg ->
        busy = true
        vm.decidePermission(id, decision, r, msg) { res ->
            busy = false
            if (res.isSuccess) onDismiss() else error = res.exceptionOrNull()?.message
        }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Palette.Bg1).padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("🔐 ${req?.project ?: ""} · ${req?.tool ?: "Chargement…"}", color = Palette.Fg0, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 44.dp)) { Text("✕", color = Palette.Fg0) }
            }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                error?.let { Text(it, color = Palette.StError, fontSize = 13.sp) }
                req?.let { r ->
                    Text("Pourquoi : ${r.why.text}", color = Palette.Fg0, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().background(Palette.Accent.copy(alpha = 0.12f)).padding(8.dp))
                    Spacer(Modifier.height(6.dp))
                    Text("Risque ${r.risk.level} : ${r.risk.tags.joinToString(", ")}", color = riskColor(r.risk.level), fontSize = 13.sp)
                    Spacer(Modifier.height(6.dp))
                    for ((k, v) in listOf(
                        "Projet" to r.project, "Model" to (r.model ?: "—"), "Tour" to (r.turnPrompt ?: "—"),
                        "Étape du pipeline" to (r.step ?: "inconnue"), "Répertoire" to (r.cwd ?: "—"),
                        "Demandée" to java.text.DateFormat.getDateTimeInstance().format(java.util.Date(r.createdAt)),
                        "Échéance" to java.text.DateFormat.getDateTimeInstance().format(java.util.Date(r.deadline)),
                    )) {
                        Text(k, color = Palette.Fg2, fontSize = 11.sp)
                        Text(v, color = Palette.Fg0, fontSize = 13.sp)
                    }
                    r.lastText?.takeIf { it.isNotBlank() }?.let {
                        Spacer(Modifier.height(8.dp))
                        Text("DERNIER MESSAGE DU MODEL", color = Palette.Fg2, fontSize = 11.sp)
                        Text(it, color = Palette.Fg1, fontSize = 13.sp)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("ENTRÉE COMPLÈTE DE L'APPEL", color = Palette.Fg2, fontSize = 11.sp)
                    for (b in r.blocks) {
                        Text(b.label, color = Palette.Fg1, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
                        Column(Modifier.fillMaxWidth().background(Palette.Bg0).horizontalScroll(rememberScrollState()).padding(6.dp)) {
                            for (line in b.text.split('\n')) {
                                val c = if (b.kind == "diff" && line.startsWith("+")) AllowGreen else if (b.kind == "diff" && line.startsWith("-")) Palette.StError else Palette.Fg0
                                Text(line, color = c, fontFamily = FontFamily.Monospace, fontSize = 11.sp, softWrap = false)
                            }
                        }
                    }
                    Text("Les valeurs qui ressemblent à des clés sont masquées.", color = Palette.Fg2, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))

                    Spacer(Modifier.height(10.dp))
                    Text("Toujours autoriser — portée", color = CyanTool, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    for (s in r.suggestions) {
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 44.dp).selectable(selected = rule == s.rule, onClick = { rule = s.rule }),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = rule == s.rule, onClick = { rule = s.rule })
                            Text("${s.rule} — ${s.label}", color = Palette.Fg0, fontSize = 12.sp)
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = reason, onValueChange = { reason = it.take(1000) },
                        label = { Text(if (focus == "deny") "Motif du refus (optionnel, transmis au model)" else "Motif si vous refusez (optionnel)") },
                        modifier = Modifier.fillMaxWidth(), minLines = 2,
                    )
                }
            }
            if (req != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 8.dp)) {
                    PermButton("Une fois", AllowGreen, Modifier.weight(1f)) { if (!busy) decide("allow_once", null, null) }
                    PermButton("Toujours", CyanTool, Modifier.weight(1f)) { if (!busy) decide("allow_always", rule, null) }
                    PermButton("Refuser", Palette.StError, Modifier.weight(1f)) { if (!busy) decide("deny", null, reason.trim().ifBlank { null }) }
                }
            }
        }
    }
}
