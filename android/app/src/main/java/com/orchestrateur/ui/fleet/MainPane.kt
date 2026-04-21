package com.orchestrateur.ui.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.Musician
import com.orchestrateur.data.RawEvent
import com.orchestrateur.data.State as MState
import com.orchestrateur.ui.theme.Palette

private const val CONDUCTOR = "orchestrateur"

@Composable
fun MainPane(
    activeTab: String,
    chat: List<ChatMsg>,
    musicians: List<Musician>,
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize()) {
        if (activeTab == CONDUCTOR) {
            ConductorTranscript(chat, musicians.find { it.name == CONDUCTOR })
        } else {
            val m = musicians.find { it.name == activeTab }
            ProjectSession(m)
        }
    }
}

@Composable
private fun ConductorTranscript(
    chat: List<ChatMsg>,
    conductor: Musician?,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    LaunchedEffect(chat.size, conductor?.state) {
        if (chat.isNotEmpty()) listState.animateScrollToItem(chat.size - 1)
    }
    if (chat.isEmpty()) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(24.dp),
            ) {
                Text("Salle de direction", color = Palette.Fg0, fontSize = 20.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(6.dp))
                Text(
                    "Parle au chef. Il délègue aux musiciens et te rapporte la synthèse.",
                    color = Palette.Fg2,
                    fontSize = 13.sp,
                )
            }
        }
        return
    }
    val isWaiting = conductor != null &&
        (conductor.state == MState.live || conductor.state == MState.think) &&
        chat.lastOrNull()?.role == ChatMsg.Role.user

    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(chat, key = { it.id }) { m -> ChatBubble(m) }
        if (isWaiting) {
            item {
                Text(
                    if (conductor?.state == MState.think) "le chef réfléchit…" else "le chef répond…",
                    color = Palette.Fg2,
                    fontSize = 11.sp,
                    letterSpacing = 1.4.sp,
                    modifier = Modifier
                        .padding(horizontal = 4.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .border(1.dp, blend(Palette.Accent, Palette.CardBorder, 0.30f), RoundedCornerShape(14.dp))
                        .background(Palette.CardBg)
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun ChatBubble(msg: ChatMsg) {
    val isUser = msg.role == ChatMsg.Role.user
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
            modifier = Modifier.fillMaxWidth(0.88f),
        ) {
            Text(
                if (isUser) "TOI" else "CHEF D'ORCHESTRE",
                color = if (isUser) Palette.Fg2 else Palette.Accent,
                fontSize = 9.sp,
                letterSpacing = 1.6.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            )
            Box(
                Modifier
                    .clip(RoundedCornerShape(14.dp))
                    .background(if (isUser) blend(Palette.Fg0, Palette.CardBg, 0.10f) else blend(Palette.Accent, Palette.CardBg, 0.08f))
                    .border(
                        1.dp,
                        if (isUser) blend(Palette.Fg0, Color.Transparent, 0.28f) else blend(Palette.Accent, Palette.CardBorder, 0.40f),
                        RoundedCornerShape(14.dp),
                    )
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            ) {
                if (isUser) {
                    Text(msg.text, color = Palette.Fg0, fontSize = 14.sp, lineHeight = 21.sp)
                } else {
                    Markdown(msg.text)
                }
            }
        }
    }
}

@Composable
private fun ProjectSession(m: Musician?, modifier: Modifier = Modifier) {
    if (m == null || m.ring.isEmpty()) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
                Text(m?.name ?: "?", color = Palette.Fg0, fontSize = 20.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(6.dp))
                Text(
                    "Aucun événement. Écris un message pour démarrer un tour direct.",
                    color = Palette.Fg2,
                    fontSize = 13.sp,
                )
            }
        }
        return
    }
    val listState = rememberLazyListState()
    LaunchedEffect(m.ring.size) {
        if (m.ring.isNotEmpty()) listState.animateScrollToItem(m.ring.size - 1)
    }
    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(m.ring.size) { idx -> EventLine(m.ring[idx]) }
    }
}

@Composable
private fun EventLine(raw: RawEvent) {
    when (raw.type) {
        "assistant" -> {
            val content = raw.message?.content.orEmpty()
            var text = ""
            var toolName: String? = null
            var thinking = false
            for (b in content) when (b.type) {
                "text"     -> if (!b.text.isNullOrBlank()) text = b.text
                "thinking" -> thinking = true
                "tool_use" -> toolName = b.name
            }
            when {
                text.isNotBlank() -> Markdown(text, Palette.Fg0)
                thinking -> Text("… réflexion", color = Palette.Fg2, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                toolName != null -> Text("› $toolName", color = Palette.StLive, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                else -> {}
            }
        }
        "result" -> {
            val baseLabel = if (raw.isError == true) "— tour en erreur" else "— tour terminé"
            val dur = raw.durationMs?.let { " · ${"%.1f".format(it / 1000.0)}s" } ?: ""
            val usage = formatResultUsage(raw)
            val label = (baseLabel + dur + (if (usage.isNotEmpty()) " · $usage" else "") + " —")
            Text(label, color = Palette.Fg3, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        }
        "system" -> {
            if (raw.subtype == "init") {
                Text("— nouveau tour —", color = Palette.Fg3, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }
        }
        "user_prompt" -> {
            val t = raw.text?.trim().orEmpty()
            if (t.isNotEmpty()) Markdown(t, Palette.Fg0)
        }
        else -> {}
    }
}

private fun formatResultUsage(raw: RawEvent): String {
    val u = raw.usage ?: return ""
    val inTok = (u.inputTokens ?: 0L) + (u.cacheReadInputTokens ?: 0L) + (u.cacheCreationInputTokens ?: 0L)
    val outTok = u.outputTokens ?: 0L
    val cost = raw.totalCostUsd ?: 0.0
    val ctxMax = raw.modelUsage?.values?.firstOrNull()?.contextWindow ?: 0L
    val parts = mutableListOf<String>()
    if (inTok > 0) parts += "↓${fmtTok(inTok)}"
    if (outTok > 0) parts += "↑${fmtTok(outTok)}"
    if (cost > 0) parts += fmtCost(cost)
    if (ctxMax > 0 && inTok > 0) {
        val pct = ((inTok.toDouble() / ctxMax) * 100).toInt()
        if (pct > 0) parts += "$pct% ctx"
    }
    return parts.joinToString(" · ")
}

internal fun fmtTok(n: Long): String = when {
    n <= 0 -> "0"
    n >= 1_000_000 -> "%.2fM".format(n / 1_000_000.0)
    n >= 10_000    -> "%dk".format(n / 1000)
    n >= 1_000     -> "%.1fk".format(n / 1000.0)
    else -> n.toString()
}

internal fun fmtCost(usd: Double): String = when {
    usd <= 0 -> "$0"
    usd < 0.01 -> "<\$0.01"
    else -> "$%.2f".format(usd)
}
