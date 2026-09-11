package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import com.orchestrateur.data.Musician
import com.orchestrateur.data.State as MState
import com.orchestrateur.ui.theme.Palette

private const val CONDUCTOR = "chef"

// Lower = further LEFT in the tab bar. The SELECTED musician is pinned leftmost
// so it always stays visible and reachable (even when idle — otherwise selecting
// it demotes it to the far right off-screen and it looks gone). Then working
// musicians (live/think), those needing attention (input/error), unread results,
// and idle ones on the right.
private fun tabPriority(m: Musician, activeTab: String): Int = when {
    m.name == activeTab -> -1
    m.state == MState.live || m.state == MState.think -> 0
    m.state == MState.input || m.state == MState.error -> 1
    m.state == MState.unread -> 2
    else -> 3
}

@Composable
fun TabBar(
    musicians: List<Musician>,
    activeTab: String,
    onSelect: (String) -> Unit,
    onCloseProject: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val conductor = musicians.find { it.name == CONDUCTOR }
    // Sort by activity priority only. sortedBy is STABLE, so musicians at equal
    // priority keep their existing (config) order — no erratic reshuffling. The
    // remember key includes each state, so the bar re-sorts live on state change.
    val others = remember(musicians, musicians.map { it.state }, musicians.map { it.parked }, activeTab) {
        musicians.filter { it.name != CONDUCTOR && !it.parked }
            .sortedBy { tabPriority(it, activeTab) }
    }

    Box(modifier = modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 10.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (conductor != null) {
                TabPill(
                    name = "Chef",
                    state = conductor.state,
                    unread = if (conductor.state == MState.unread) conductor.unreadCount else 0,
                    isActive = activeTab == CONDUCTOR,
                    isConductor = true,
                    showClose = false,
                    onClick = { onSelect(CONDUCTOR) },
                    onClose = {},
                )
            }
            for (m in others) {
                TabPill(
                    name = m.name,
                    state = m.state,
                    unread = if (m.state == MState.unread) m.unreadCount else 0,
                    isActive = activeTab == m.name,
                    isConductor = false,
                    showClose = activeTab == m.name,
                    onClick = { onSelect(m.name) },
                    onClose = onCloseProject,
                )
            }
            Spacer(Modifier.width(24.dp))
        }
        // Right-edge fade hint that signals there's more to scroll.
        Box(
            Modifier
                .align(Alignment.CenterEnd)
                .fillMaxHeight()
                .width(28.dp)
                .background(
                    Brush.horizontalGradient(
                        listOf(Color.Transparent, Palette.Bg0)
                    )
                )
                .zIndex(2f),
        )
    }
}

@Composable
private fun TabPill(
    name: String,
    state: MState,
    unread: Int,
    isActive: Boolean,
    isConductor: Boolean,
    showClose: Boolean,
    onClick: () -> Unit,
    onClose: () -> Unit,
) {
    val stateColor = stateColor(state)
    val bg = when {
        isActive && isConductor -> blend(Palette.Accent, Palette.CardBg, 0.26f)
        isActive -> blend(stateColor, Palette.CardBg, 0.22f)
        isConductor -> blend(Palette.Accent, Palette.CardBg, 0.10f)
        else -> Palette.CardBg
    }
    val borderColor = when {
        isActive && isConductor -> Palette.Accent
        isActive -> stateColor
        isConductor -> blend(Palette.Accent, Palette.CardBorder, 0.40f)
        else -> Palette.CardBorder
    }
    val textColor = when {
        isActive -> Palette.Fg0
        isConductor -> Palette.Accent
        else -> Palette.Fg1
    }

    Row(
        Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(bg)
            .border(1.dp, borderColor, RoundedCornerShape(999.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(stateColor))
        Text(
            name,
            color = textColor,
            fontSize = 11.sp,
            fontWeight = if (isConductor) FontWeight.SemiBold else FontWeight.Normal,
        )
        if (unread > 0) {
            Box(
                Modifier
                    .defaultMinSize(minWidth = 16.dp, minHeight = 16.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(stateColor)
                    .padding(horizontal = 5.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    unread.toString(),
                    color = Palette.Bg0,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
        if (showClose) {
            Box(
                Modifier
                    .size(16.dp)
                    .clip(CircleShape)
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Text("×", color = textColor, fontSize = 12.sp)
            }
        }
    }
}

internal fun blend(a: Color, b: Color, t: Float): Color {
    return Color(
        red   = a.red   * t + b.red   * (1 - t),
        green = a.green * t + b.green * (1 - t),
        blue  = a.blue  * t + b.blue  * (1 - t),
        alpha = 1f,
    )
}
