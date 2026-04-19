package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.Api
import com.orchestrateur.data.Musician
import com.orchestrateur.ui.theme.Palette

private const val CONDUCTOR = "orchestrateur"

@Composable
fun FleetScreen(api: Api) {
    val vm = remember { FleetViewModel(api) }
    val status by vm.status.collectAsState()
    var focused by remember { mutableStateOf<Musician?>(null) }

    Box(Modifier.fillMaxSize().background(Palette.Bg0)) {

        // Top bar
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Orchestre", color = Palette.Fg0, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Spacer(Modifier.weight(1f))
            Text(status, color = Palette.Fg2, fontSize = 11.sp)
        }

        // Fan
        if (vm.musicians.isNotEmpty()) {
            FanOfCards(
                musicians = vm.musicians,
                deckOffset = vm.deckOffset,
                onRotate = { vm.rotateDeck() },
                onTap = { focused = it },
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text(
                "Chargement…",
                color = Palette.Fg2,
                modifier = Modifier.align(Alignment.Center),
            )
        }

        // Composer at the bottom
        Composer(
            onSend = { prompt, target ->
                vm.dispatch(target, prompt) { /* TODO: show error toast */ }
            },
            musicians = vm.musicians,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }

    // Focused view
    focused?.let { m ->
        FocusedSheet(musician = m, onDismiss = {
            m.markRead()
            focused = null
        })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FocusedSheet(musician: Musician, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = Palette.Bg1,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(16.dp)
                .heightIn(min = 300.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(10.dp).background(stateColor(musician.state), RoundedCornerShape(5.dp)))
                Spacer(Modifier.width(8.dp))
                Text(musician.name, color = Palette.Fg0, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Text(stateLabel(musician.state), color = stateColor(musician.state), fontSize = 10.sp, letterSpacing = 1.6.sp)
            }
            Spacer(Modifier.height(12.dp))
            Text(
                text = if (musician.lastAssistantText.isBlank()) "Aucun message" else musician.lastAssistantText,
                color = Palette.Fg1,
                fontSize = 14.sp,
                lineHeight = 22.sp,
            )
        }
    }
}

@Composable
private fun Composer(
    onSend: (prompt: String, target: String) -> Unit,
    musicians: List<Musician>,
    modifier: Modifier = Modifier,
) {
    var text by rememberSaveable { mutableStateOf("") }
    val target = CONDUCTOR      // v1: always the conductor

    Column(
        modifier
            .fillMaxWidth()
            .background(Palette.Bg0)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Box(
            Modifier
                .align(Alignment.CenterHorizontally)
                .clip(RoundedCornerShape(999.dp))
                .background(Palette.CardBg)
                .padding(horizontal = 14.dp, vertical = 6.dp)
        ) {
            Text("au chef d'orchestre", color = Palette.Accent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(8.dp))
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(Palette.CardBg)
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.weight(1f).padding(vertical = 6.dp),
                textStyle = TextStyle(color = Palette.Fg0, fontSize = 15.sp),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(Palette.Accent),
                decorationBox = { inner ->
                    if (text.isEmpty()) {
                        Text(
                            "Parle au chef — il déléguera…",
                            color = Palette.Fg3,
                            fontSize = 15.sp,
                        )
                    }
                    inner()
                },
            )
            TextButton(
                onClick = {
                    if (text.isNotBlank()) {
                        onSend(text, target)
                        text = ""
                    }
                },
                enabled = text.isNotBlank(),
            ) {
                Text("▶", color = if (text.isNotBlank()) Palette.Accent else Palette.Fg3)
            }
        }
    }
}
