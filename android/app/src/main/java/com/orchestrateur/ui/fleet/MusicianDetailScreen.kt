package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.Musician
import com.orchestrateur.data.RawEvent
import com.orchestrateur.data.toolArgPreview
import com.orchestrateur.data.State as MState
import com.orchestrateur.ui.theme.Palette

// ============================================================================
// Niveau 2 — la plongée dans un musicien (destination NavHost « détail »).
// Trois onglets : Activité · Dernier résultat · Journal récent.
// Action principale : « En parler au chef » (retour au fil, projet nommé).
// Le retour rend le journal à son ancre (le LazyListState du fil est conservé
// par la destination Journal, qui n'est jamais démontée par la navigation).
// ============================================================================

enum class DetailTab { activity, result, journal }

@Composable
fun MusicianDetailScreen(
    vm: FleetViewModel,
    name: String,
    onBack: () -> Unit,
    onTalkToChef: (String) -> Unit,
) {
    val m = vm.musicians.find { it.name == name }
    var tab by rememberSaveable { mutableStateOf(DetailTab.activity) }
    var menu by remember { mutableStateOf(false) }

    LaunchedEffect(name) { vm.openMusician(name) }

    Column(Modifier.fillMaxSize().background(Palette.Bg0)) {
        // ---- En-tête ------------------------------------------------------
        Row(
            Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "‹ Chef",
                color = Palette.Fg2, fontSize = 13.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(onClick = onBack)
                    .wrapContentHeight()
                    .padding(horizontal = 8.dp),
            )
            Text(
                name.uppercase(),
                color = Palette.Fg0, fontSize = 15.sp, fontWeight = FontWeight.Bold,
                letterSpacing = 1.4.sp, fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Box {
                Text(
                    "⋮", color = Palette.Fg2, fontSize = 18.sp,
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { menu = true }
                        .wrapContentHeight()
                        .padding(horizontal = 10.dp),
                )
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text("En parler au chef", fontSize = 14.sp) },
                        onClick = { menu = false; onTalkToChef(name) },
                    )
                    DropdownMenuItem(
                        text = { Text("Marquer lu", fontSize = 14.sp) },
                        onClick = { menu = false; vm.openMusician(name) },
                    )
                }
            }
        }

        if (m == null) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text("Musicien inconnu", color = Palette.Fg2, fontSize = 13.sp)
            }
            return@Column
        }

        // ---- Sous-titre + état + télémétrie --------------------------------
        val mission = vm.chat.asSequence()
            .filter { it.role == ChatMsg.Role.missions && !it.observed }
            .flatMap { it.missions.asSequence() }
            .lastOrNull { it.name == name }
        Text(
            when {
                mission != null -> "Musicien piloté par le chef · mission lancée"
                else -> "Musicien de l'orchestre"
            },
            color = Palette.Fg2, fontSize = 11.sp,
            modifier = Modifier.padding(horizontal = 14.dp),
        )
        val health = healthNote(m)
        Text(
            "${stateGlyph(m)} ${stateLabel(m)}" + (health?.let { " · ${it.first}" } ?: ""),
            color = if (health != null) Palette.StInput else stateColor(m.state),
            fontSize = 13.sp, fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 3.dp),
        )
        val snapAt by vm.snapshotAt.collectAsState()
        Text(
            listOfNotNull(
                "tour " + (m.turnElapsedMs?.let { fmtAgeShort(it) } ?: "—"),
                "dernier progrès " + (m.silentMs?.let { fmtAgeShort(it) } ?: "—"),
                when {
                    m.pid == null -> "processus —"
                    m.pidAlive == true -> "processus ✓ ${m.pid}"
                    m.pidAlive == false -> "processus ✗ ${m.pid}"
                    else -> "processus inconnu ${m.pid}"
                },
                m.observedModel?.removePrefix("claude-") ?: "modèle —",
                if (snapAt > 0L) "instantané il y a ${fmtAgeShort(System.currentTimeMillis() - snapAt)}"
                else "instantané non reçu",
            ).joinToString(" · "),
            color = Palette.Fg3, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 2.dp),
        )

        // ---- Onglets -------------------------------------------------------
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            DetailTabChip("Activité", tab == DetailTab.activity) { tab = DetailTab.activity }
            DetailTabChip("Résultat", tab == DetailTab.result) { tab = DetailTab.result }
            DetailTabChip("Journal", tab == DetailTab.journal) { tab = DetailTab.journal }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.CardBorder))

        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (tab) {
                DetailTab.activity -> ActivityTab(m)
                DetailTab.result -> ResultTab(m)
                DetailTab.journal -> JournalTab(m)
            }
        }

        // ---- Action principale ---------------------------------------------
        Row(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "En parler au chef",
                color = Palette.Accent, fontSize = 13.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(9.dp))
                    .border(1.dp, Palette.Accent, RoundedCornerShape(9.dp))
                    .clickable { onTalkToChef(name) }
                    .wrapContentHeight()
                    .padding(horizontal = 16.dp),
            )
            Spacer(Modifier.weight(1f))
            Text(
                "${m.ring.size} evts", color = Palette.Fg3, fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun DetailTabChip(label: String, on: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (on) Palette.Fg0 else Palette.Fg2,
        fontSize = 12.sp, fontFamily = FontFamily.Monospace,
        modifier = Modifier
            .heightIn(min = 44.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (on) Palette.CardBg else androidx.compose.ui.graphics.Color.Transparent)
            .border(
                1.dp,
                if (on) Palette.CardBorder else androidx.compose.ui.graphics.Color.Transparent,
                RoundedCornerShape(8.dp),
            )
            .clickable(onClick = onClick)
            .wrapContentHeight()
            .padding(horizontal = 12.dp),
    )
}

/** Onglet Activité — le flux d'événements, même rendu que le panneau projet. */
@Composable
private fun ActivityTab(m: Musician) {
    val ring = m.ring.toList()
    val listState = rememberLazyListState()
    var first by remember { mutableStateOf(false) }
    LaunchedEffect(m.ingestSeq) {
        if (ring.isNotEmpty()) {
            val target = ring.size - 1
            if (!first) { listState.scrollToItem(target); first = true }
            else listState.animateScrollToItem(target)
        }
    }
    if (ring.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Aucun événement chargé.", color = Palette.Fg3, fontSize = 12.sp)
        }
        return
    }
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(ring) { raw -> DetailEventLine(raw) }
    }
}

/** Onglet Dernier résultat — issue, durée, coût, question, texte servi. */
@Composable
private fun ResultTab(m: Musician) {
    val ring = m.ring.toList()
    val res = ring.lastOrNull { it.type == "result" }
    val served = ring.lastOrNull { e ->
        e.type == "assistant" && e.message?.content.orEmpty().any { it.type == "text" && !it.text.isNullOrBlank() }
    }?.message?.content.orEmpty()
        .filter { it.type == "text" }.mapNotNull { it.text }.joinToString("\n").trim()

    if (res == null && served.isBlank()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Aucun résultat dans la fenêtre chargée.", color = Palette.Fg3, fontSize = 12.sp)
        }
        return
    }
    val isErr = res?.isError == true || (res?.subtype?.startsWith("error") == true)
    val synthetic = res?.synthetic == true
    // Un résultat synthétique est GRIS, jamais rouge : le musicien n'a pas
    // échoué, le tour a été clos pour lui.
    val issue = when {
        synthetic -> "⟲ clos par le système — ${res?.subtype ?: "interrompu"}"
        isErr -> "✕ échec — ${res?.subtype ?: "erreur"}"
        res != null -> "✓ terminé"
        else -> "… tour en cours"
    }
    val issueColor = when {
        synthetic -> Palette.Fg2
        isErr -> Palette.StError
        res != null -> Palette.StUnread
        else -> Palette.Fg2
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        DrKey("Issue"); Text(issue, color = issueColor, fontSize = 13.sp)
        Spacer(Modifier.height(6.dp))
        DrKey("Durée · coût")
        Text(
            (res?.durationMs?.let { fmtAgeShort(it) } ?: "—") + " · " +
                (res?.totalCostUsd?.let { String.format(java.util.Locale.US, "$%.2f", it) } ?: "coût non fourni"),
            color = Palette.Fg1, fontSize = 13.sp, fontFamily = FontFamily.Monospace,
        )
        if (m.state == MState.input && m.lastLine.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            DrKey("Question posée")
            Text(m.lastLine, color = Palette.StInput, fontSize = 13.sp)
        }
        Spacer(Modifier.height(6.dp))
        DrKey("Texte servi")
        if (served.isBlank()) Text("—", color = Palette.Fg3, fontSize = 13.sp)
        else Markdown(served, Palette.Fg1)
    }
}

@Composable
private fun DrKey(s: String) {
    Text(
        s.uppercase(), color = Palette.Fg3, fontSize = 9.sp, letterSpacing = 1.4.sp,
        fontFamily = FontFamily.Monospace,
    )
}

/** Onglet Journal récent — événements bruts horodatés, fenêtre bornée ASSUMÉE. */
@Composable
private fun JournalTab(m: Musician) {
    val ring = m.ring.toList()
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        item {
            Text(
                "fenêtre bornée (500 événements / 2 Mio côté serveur) — ce n'est pas tout l'historique",
                color = Palette.Fg3, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(bottom = 6.dp),
            )
        }
        items(ring) { raw ->
            val ts = raw.timestamp?.let {
                runCatching {
                    val t = java.time.Instant.parse(it).atZone(java.time.ZoneId.systemDefault())
                    String.format(java.util.Locale.US, "%02d:%02d:%02d", t.hour, t.minute, t.second)
                }.getOrNull()
            } ?: "--:--:--"
            val kind = (raw.type ?: "?") + (raw.subtype?.let { "/$it" } ?: "")
            val prev = when (raw.type) {
                "assistant" -> raw.message?.content.orEmpty().firstOrNull()?.let { b ->
                    when (b.type) {
                        "tool_use" -> "${b.name} ${b.toolArgPreview(60)}"
                        "thinking" -> b.thinking.orEmpty().take(70)
                        else -> b.text.orEmpty().take(70)
                    }
                }.orEmpty()
                "user_prompt" -> raw.text.orEmpty().take(70)
                "result" -> (if (raw.isError == true) "is_error " else "") + (raw.subtype ?: "")
                else -> ""
            }
            Text(
                "$ts  $kind  $prev",
                color = Palette.Fg2, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Même rendu d'événement que le panneau projet, réutilisé tel quel. */
@Composable
private fun DetailEventLine(raw: RawEvent) = EventLinePublic(raw)
