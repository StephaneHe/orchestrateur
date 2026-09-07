package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.Musician
import com.orchestrateur.data.State
import com.orchestrateur.ui.theme.Palette

fun stateColor(s: State): Color = when (s) {
    State.idle -> Palette.StIdle
    State.live -> Palette.StLive
    State.think -> Palette.StThink
    State.input -> Palette.StInput
    State.error -> Palette.StError
    State.unread -> Palette.StUnread
}

fun stateLabel(s: State): String = when (s) {
    State.idle -> "AU REPOS"
    State.live -> "EN COMMUNICATION"
    State.think -> "RÉFLEXION"
    State.input -> "ATTEND TA RÉPONSE"
    State.error -> "ERREUR"
    State.unread -> "NOUVEAUX MESSAGES"
}

@Composable
fun MusicianCard(
    m: Musician,
    modifier: Modifier = Modifier,
) {
    val color = stateColor(m.state)
    Column(
        modifier
            .background(Palette.CardBg, RoundedCornerShape(14.dp))
            .border(1.dp, Palette.CardBorder, RoundedCornerShape(14.dp))
            .padding(horizontal = 16.dp, vertical = 14.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).background(color, RoundedCornerShape(5.dp)))
            Spacer(Modifier.width(8.dp))
            Text(
                m.name,
                color = Palette.Fg0,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (m.state == State.unread && m.unreadCount > 0) {
                Box(
                    Modifier
                        .background(color, RoundedCornerShape(10.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(
                        m.unreadCount.toString(),
                        color = Palette.Bg0,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(
            if (m.lastLine.isBlank()) "en attente…" else m.lastLine,
            color = if (m.lastLine.isBlank()) Palette.Fg3 else Palette.Fg1,
            fontSize = 12.sp,
            maxLines = 7,
            overflow = TextOverflow.Ellipsis,
            lineHeight = 18.sp,
            modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = if (m.unreadCount > 1 && m.state == State.unread)
                "${m.unreadCount} ${stateLabel(m.state)}"
            else stateLabel(m.state),
            color = color,
            fontSize = 9.sp,
            letterSpacing = 1.6.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}
