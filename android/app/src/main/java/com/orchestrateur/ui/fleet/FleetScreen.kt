package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.Api
import com.orchestrateur.data.Musician
import com.orchestrateur.data.State as MState
import com.orchestrateur.ui.theme.Palette

@Composable
fun FleetScreen(api: Api) {
    val vm = remember { FleetViewModel(api) }
    val status by vm.status.collectAsState()
    val connected by vm.connected.collectAsState()

    Column(
        Modifier
            .fillMaxSize()
            .background(Palette.Bg0),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Orchestre", color = Palette.Fg0, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Spacer(Modifier.weight(1f))
            val totalCost = vm.musicians.sumOf { it.totalCostUsd }
            val totalOut = vm.musicians.sumOf { it.totalOutputTokens }
            if (totalCost > 0.0 || totalOut > 0L) {
                Text(
                    buildString {
                        if (totalCost > 0.0) append(fmtCost(totalCost))
                        if (totalOut > 0L) {
                            if (isNotEmpty()) append(" · ")
                            append("↑").append(fmtTok(totalOut))
                        }
                    },
                    color = Palette.Fg2,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(Modifier.width(10.dp))
            }
            if (!connected) {
                Text(
                    "↺",
                    color = Palette.StInput,
                    fontSize = 16.sp,
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .clickable { vm.reconnect() }
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
                Spacer(Modifier.width(4.dp))
            }
            Text(status, color = if (connected) Palette.Fg2 else Palette.StInput, fontSize = 11.sp)
        }

        if (vm.musicians.isNotEmpty()) {
            TabBar(
                musicians = vm.musicians,
                activeTab = vm.activeTab,
                onSelect = vm::selectTab,
                onCloseProject = { vm.selectTab(FleetViewModel.CONDUCTOR) },
                modifier = Modifier
                    .fillMaxWidth()
                    .border(width = 0.dp, color = Color.Transparent)
                    .background(Palette.Bg0)
                    .padding(bottom = 6.dp),
            )
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(Palette.CardBorder),
            )
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (vm.musicians.isEmpty()) {
                Text("Chargement…", color = Palette.Fg2, modifier = Modifier.align(Alignment.Center))
            } else {
                MainPane(
                    activeTab = vm.activeTab,
                    chat = vm.chat,
                    musicians = vm.musicians,
                )
            }
        }

        Composer(
            activeTab = vm.activeTab,
            musicians = vm.musicians,
            onSend = { prompt -> vm.dispatch(prompt) },
        )
    }
}

@Composable
private fun Composer(
    activeTab: String,
    musicians: SnapshotStateList<Musician>,
    onSend: (String) -> Unit,
) {
    var field by rememberSaveable(stateSaver = TextFieldValue.Saver) {
        mutableStateOf(TextFieldValue(""))
    }
    val placeholder = if (activeTab == FleetViewModel.CONDUCTOR)
        "Parle au chef — tape @ pour citer un musicien"
    else
        "Parle directement à $activeTab…"

    val mention = remember(field.text, field.selection, musicians.toList(), musicians.map { it.state }) {
        detectMention(field.text, field.selection.start, musicians)
    }

    fun commit(pick: Musician) {
        val m = mention ?: return
        val before = field.text.substring(0, m.anchor)
        val after = field.text.substring(field.selection.start)
        val needsSpace = !(after.startsWith(" ") || after.startsWith("\n") || after.isEmpty())
        val insertion = "@${pick.name}${if (needsSpace) " " else ""}"
        val newText = before + insertion + after
        val newCaret = (before + insertion).length
        field = TextFieldValue(newText, TextRange(newCaret))
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(Palette.Bg0)
            .navigationBarsPadding()
            .imePadding(),
    ) {
        if (mention != null && mention.matches.isNotEmpty()) {
            MentionMenu(
                matches = mention.matches,
                onPick = ::commit,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Palette.CardBg)
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = field,
                onValueChange = { field = it },
                modifier = Modifier.weight(1f).padding(vertical = 8.dp),
                textStyle = TextStyle(color = Palette.Fg0, fontSize = 15.sp),
                cursorBrush = SolidColor(Palette.Accent),
                decorationBox = { inner ->
                    if (field.text.isEmpty()) {
                        Text(placeholder, color = Palette.Fg3, fontSize = 15.sp)
                    }
                    inner()
                },
            )
            TextButton(
                onClick = {
                    val t = field.text
                    if (t.isNotBlank()) {
                        onSend(t)
                        field = TextFieldValue("")
                    }
                },
                enabled = field.text.isNotBlank(),
            ) {
                Text("▶", color = if (field.text.isNotBlank()) Palette.Accent else Palette.Fg3)
            }
        }
    }
}

private data class MentionCtx(val anchor: Int, val query: String, val matches: List<Musician>)

private fun detectMention(text: String, caret: Int, musicians: List<Musician>): MentionCtx? {
    if (caret <= 0 || caret > text.length) return null
    var i = caret - 1
    var anchor = -1
    while (i >= 0 && !text[i].isWhitespace()) {
        if (text[i] == '@') {
            val prev = if (i == 0) ' ' else text[i - 1]
            if (i == 0 || prev.isWhitespace() || prev in ".,;:!?") {
                anchor = i
                break
            }
            return null
        }
        i--
    }
    if (anchor < 0) return null
    val query = text.substring(anchor + 1, caret)
    val q = query.lowercase()
    val scored = musicians
        .map { it to when {
            it.name.lowercase().startsWith(q) -> 2
            it.name.lowercase().contains(q) -> 1
            else -> 0
        } }
        .filter { it.second > 0 || q.isEmpty() }
        .sortedWith(compareByDescending<Pair<Musician, Int>> { it.second }.thenBy { it.first.name })
        .map { it.first }
        .take(8)
    return MentionCtx(anchor, query, scored)
}

@Composable
private fun MentionMenu(
    matches: List<Musician>,
    onPick: (Musician) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.CardBg)
            .border(1.dp, Palette.CardBorder, RoundedCornerShape(10.dp))
            .padding(4.dp),
    ) {
        for (m in matches) {
            val isConductor = m.name == FleetViewModel.CONDUCTOR
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(7.dp))
                    .clickable { onPick(m) }
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(stateColor(m.state)),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    if (isConductor) "Chef" else m.name,
                    color = if (isConductor) Palette.Accent else Palette.Fg0,
                    fontSize = 13.sp,
                    fontWeight = if (isConductor) FontWeight.SemiBold else FontWeight.Normal,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    stateLabel(m.state),
                    color = Palette.Fg2,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

