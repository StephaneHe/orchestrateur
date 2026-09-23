package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.Musician
import com.orchestrateur.data.State as MState
import com.orchestrateur.ui.theme.Palette

// ============================================================================
// Rail mobile — la barre d'onglets a disparu FONCTIONNELLEMENT : les musiciens
// sont des subordonnés, pas des interlocuteurs. Une ligne de synthèse stable
// (« Pilotage : 2 en cours · 1 question › ») ouvre cette feuille ; la feuille
// porte la recherche (parkés inclus) et les filtres.
//
// GARDE-FOU : aucune nouvelle chaîne d'état. `MState` reste
// idle|live|think|input|error|unread ; tout le reste est libellé et badge.
// ============================================================================

/** Libellés d'affichage (table validée). Les CLÉS ne changent jamais. */
internal fun stateLabel(m: Musician): String = when {
    m.state == MState.unread && m.awaitingChef -> "Attend le chef"
    m.state == MState.idle -> "Prêt"
    m.state == MState.live -> "En cours"
    m.state == MState.think -> "En cours · réflexion"
    m.state == MState.input -> "Votre réponse attendue"
    m.state == MState.error -> "Échec"
    else -> "Terminé"
}

internal fun stateGlyph(m: Musician): String = when {
    m.state == MState.unread && m.awaitingChef -> "⇄"
    m.state == MState.idle -> "○"
    m.state == MState.live -> "●"
    m.state == MState.think -> "◐"
    m.state == MState.input -> "?"
    m.state == MState.error -> "✕"
    else -> "✓"
}

/** Anomalie prioritaire, ou null. `pidAlive == null` ne dit JAMAIS « perdu ». */
internal fun healthNote(m: Musician): Pair<String, Boolean>? = when {
    m.deadInFlight -> "✗ processus perdu" to true
    m.stalled -> ("! sans progrès" + (m.silentMs?.let { " " + fmtAgeShort(it) } ?: "")) to false
    else -> null
}

internal fun fmtAgeShort(ms: Long): String {
    val s = ms / 1000
    if (s < 60) return "${s}s"
    val m = s / 60
    if (m < 60) return "${m}m${(s % 60).toString().padStart(2, '0')}"
    return "${m / 60}h${(m % 60).toString().padStart(2, '0')}"
}

/** Tri d'attention stable : anomalie > échec > question > en vol > non lu > prêt. */
internal fun railRank(m: Musician): Int = when {
    m.stalled || m.deadInFlight -> 0
    m.state == MState.error -> 1
    m.state == MState.input -> 2
    m.state == MState.live || m.state == MState.think -> 3
    m.state == MState.unread -> 4
    else -> 5
}

enum class PilotFilter { running, examine, all }

/** Compteurs de la ligne « Pilotage » : une synthèse stable, jamais des chips
 *  qui se réordonnent (le fil montre déjà QUI travaille). */
@Composable
fun PilotageLine(musicians: List<Musician>, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val others = musicians.filter { it.name != FleetViewModel.CONDUCTOR && !it.parked }
    val running = others.count { it.state == MState.live || it.state == MState.think }
    val questions = others.count { it.state == MState.input }
    val examine = others.count {
        it.state == MState.error || it.stalled || it.deadInFlight ||
            (it.state == MState.unread && it.awaitingChef)
    }
    val bits = buildList {
        if (running > 0) add("$running en cours")
        if (questions > 0) add("$questions question${if (questions > 1) "s" else ""}")
        if (examine > 0) add("$examine à examiner")
        if (isEmpty()) add("orchestre au repos")
    }
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)          // zone tactile ≥ 48 dp
            .clickable(onClick = onOpen)
            .background(blend(Palette.Fg2, Palette.Bg0, 0.05f))
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "PILOTAGE", color = Palette.Fg3, fontSize = 9.sp, letterSpacing = 1.6.sp,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            bits.joinToString(" · "), color = Palette.Fg1, fontSize = 12.sp,
            fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text("›", color = Palette.Fg2, fontSize = 15.sp)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PilotageSheet(
    musicians: List<Musician>,
    onOpenMusician: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf(PilotFilter.running) }
    var showParked by remember { mutableStateOf(false) }

    val others = musicians.filter { it.name != FleetViewModel.CONDUCTOR }
    val parked = others.filter { it.parked }
    val active = others.filter { !it.parked }

    // La sélection ne bouge pas pendant un geste : la liste est triée UNE fois
    // par composition (remember sur les clés d'état), pas à chaque recomposition.
    val listed = remember(query, filter, showParked, active.map { it.name to it.state }, parked.size) {
        val base = when (filter) {
            PilotFilter.running -> active.filter { it.state == MState.live || it.state == MState.think }
            PilotFilter.examine -> active.filter {
                it.state == MState.input || it.state == MState.error ||
                    it.stalled || it.deadInFlight || (it.state == MState.unread && it.awaitingChef)
            }
            PilotFilter.all -> active
        }
        val q = query.trim().lowercase()
        val pool = if (q.isEmpty()) base else (active + parked).filter { it.name.lowercase().contains(q) }
        pool.sortedWith(compareBy({ railRank(it) }, { it.name }))
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = Palette.Bg1,
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 18.dp)) {
            Text(
                "PILOTAGE", color = Palette.Fg3, fontSize = 10.sp, letterSpacing = 2.4.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(start = 16.dp, bottom = 8.dp),
            )
            // Recherche — parkés inclus dès qu'une requête est saisie.
            Row(
                Modifier
                    .padding(horizontal = 14.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(Palette.CardBg)
                    .border(1.dp, Palette.CardBorder, RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    textStyle = TextStyle(color = Palette.Fg0, fontSize = 14.sp),
                    cursorBrush = SolidColor(Palette.Accent),
                    decorationBox = { inner ->
                        if (query.isEmpty()) {
                            Text("Rechercher un musicien… (parkés inclus)", color = Palette.Fg3, fontSize = 14.sp)
                        }
                        inner()
                    },
                )
            }
            Spacer(Modifier.height(10.dp))
            Row(
                Modifier.padding(horizontal = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                FilterChip("En cours", filter == PilotFilter.running) { filter = PilotFilter.running }
                FilterChip("À examiner", filter == PilotFilter.examine) { filter = PilotFilter.examine }
                FilterChip("Tous", filter == PilotFilter.all) { filter = PilotFilter.all }
            }
            Spacer(Modifier.height(8.dp))
            if (listed.isEmpty()) {
                Text(
                    "Rien dans cette vue.",
                    color = Palette.Fg3, fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }
            LazyColumn(
                Modifier.heightIn(max = 420.dp).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                items(listed, key = { it.name }) { m -> PilotRow(m) { onOpenMusician(m.name) } }
            }
            if (parked.isNotEmpty() && query.isBlank()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .clickable { showParked = !showParked }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        "Mis de côté (${parked.size})", color = Palette.Fg2, fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace, letterSpacing = 1.2.sp,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(if (showParked) "▾" else "▸", color = Palette.Fg2, fontSize = 11.sp)
                }
                if (showParked) {
                    Column(
                        Modifier.padding(horizontal = 14.dp),
                        verticalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        parked.sortedBy { it.name }.forEach { m ->
                            PilotRow(m) { onOpenMusician(m.name) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FilterChip(label: String, on: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (on) Palette.Fg0 else Palette.Fg2,
        fontSize = 11.sp,
        fontFamily = FontFamily.Monospace,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (on) blend(Palette.Accent, Palette.CardBg, 0.20f) else Palette.CardBg)
            .border(
                1.dp,
                if (on) Palette.Accent else Palette.CardBorder,
                RoundedCornerShape(999.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

@Composable
private fun PilotRow(m: Musician, onClick: () -> Unit) {
    val c = stateColor(m.state)
    val health = healthNote(m)
    val sub = buildList {
        when {
            m.parked -> add("santé non suivie")
            health != null -> add(health.first)
            m.state == MState.live || m.state == MState.think -> {
                m.activity?.takeIf { it.isNotBlank() }?.let { add(it.take(34)) }
                m.turnElapsedMs?.let { add(fmtAgeShort(it)) }
            }
            m.state == MState.input -> add(m.lastLine.take(48).ifBlank { "question sans texte" })
            m.state == MState.unread -> add(if (m.awaitingChef) "⇄ attend une décision du chef" else "✓ résultat non lu")
            else -> m.lastLine.takeIf { it.isNotBlank() }?.let { add(it.take(42)) }
        }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(9.dp))
            .background(Palette.CardBg)
            .border(
                1.dp,
                if (health?.second == true) blend(Palette.StError, Palette.CardBorder, 0.5f) else Palette.CardBorder,
                RoundedCornerShape(9.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(c))
            Text(
                m.name, color = Palette.Fg0, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                "${stateGlyph(m)} ${stateLabel(m)}",
                color = c, fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1,
            )
        }
        if (sub.isNotEmpty()) {
            Text(
                sub.joinToString(" · "),
                color = if (health != null) Palette.StInput else Palette.Fg2,
                fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 16.dp),
            )
        }
    }
}
