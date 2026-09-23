package com.orchestrateur.ui.fleet

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import com.orchestrateur.data.Musician
import com.orchestrateur.data.RawEvent
import com.orchestrateur.data.State as MState
import com.orchestrateur.data.toolArgPreview
import com.orchestrateur.ui.theme.Palette

private const val CONDUCTOR = "chef"

@Composable
fun MainPane(
    activeTab: String,
    chat: List<ChatMsg>,
    musicians: List<Musician>,
    onAddTool: (project: String, tool: String) -> Unit = { _, _ -> },
    onReply: (ChatMsg) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize()) {
        if (activeTab == CONDUCTOR) {
            ConductorTranscript(
                chat = chat,
                conductor = musicians.find { it.name == CONDUCTOR },
                onAddTool = { tool -> onAddTool(CONDUCTOR, tool) },
                onReply = onReply,
            )
        } else {
            val m = musicians.find { it.name == activeTab }
            ProjectSession(m, onAddTool = { tool -> onAddTool(activeTab, tool) })
        }
    }
}

@Composable
private fun ConductorTranscript(
    chat: List<ChatMsg>,
    conductor: Musician?,
    onAddTool: (tool: String) -> Unit = {},
    onReply: (ChatMsg) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val liveText = conductor?.liveText.orEmpty()
    val liveActivity = conductor?.liveActivity.orEmpty()
    val liveShown = (conductor?.state == MState.live || conductor?.state == MState.think) &&
        (liveText.isNotBlank() || liveActivity.isNotBlank())

    val listState = rememberLazyListState()
    // One-shot flag: the FIRST time we land at the bottom (page open) we jump
    // instantly (scrollToItem) so the chef view opens already at the bottom —
    // no visible top→bottom animation. Later updates animate as before so the
    // view keeps following the stream smoothly.
    var firstScrollDone by remember { mutableStateOf(false) }
    // Re-scroll as chat grows AND as the chef's answer streams in (ingestSeq
    // ticks on every token delta).
    LaunchedEffect(chat.size, conductor?.state, conductor?.ingestSeq) {
        val target = chat.size - 1 + (if (liveShown) 1 else 0)
        if (target >= 0) {
            if (!firstScrollDone) { listState.scrollToItem(target); firstScrollDone = true }
            else listState.animateScrollToItem(target)
        }
    }

    val deniedTools = conductor?.pendingDenials?.toList() ?: emptyList()

    if (chat.isEmpty() && deniedTools.isEmpty()) {
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
        chat.lastOrNull()?.role?.let { it == ChatMsg.Role.user || it == ChatMsg.Role.callback } == true

    Column(modifier.fillMaxSize()) {
        if (deniedTools.isNotEmpty()) {
            DenialBanner(
                denials = deniedTools,
                onApprove = onAddTool,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp),
            )
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(chat, key = { it.id }) { m -> ChatBubble(m, onReply = onReply) }
            // Live: the chef's reply as it streams in (token deltas), or a
            // "thinking/replying…" pill when in-flight but nothing streamed yet.
            if (liveShown) {
                item {
                    Column(
                        Modifier
                            .fillMaxWidth(0.88f)
                            .clip(RoundedCornerShape(14.dp))
                            .border(1.dp, blend(Palette.Accent, Palette.CardBorder, 0.40f), RoundedCornerShape(14.dp))
                            .background(blend(Palette.Accent, Palette.CardBg, 0.08f))
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            "CHEF D'ORCHESTRE",
                            color = Palette.Accent, fontSize = 9.sp, letterSpacing = 1.6.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                        if (liveActivity.isNotBlank()) {
                            Text(liveActivity, color = Palette.StLive, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                        }
                        if (liveText.isNotBlank()) Markdown(liveText)
                    }
                }
            } else if (isWaiting) {
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
}

/** The chef's mid-turn steps, kept persistently (thinking / tool / intermediate
 *  text / tool result) — rendered as compact left-aligned lines, not bubbles. */
@Composable
private fun ActivityLine(msg: ChatMsg) {
    when (msg.kind) {
        "tool" -> Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(Palette.StLive.copy(alpha = 0.10f))
                .border(1.dp, Palette.StLive.copy(alpha = 0.25f), RoundedCornerShape(8.dp))
                .padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text("⚙", fontSize = 13.sp, color = Palette.StLive)
            Text(msg.text, color = Palette.Fg1, fontSize = 12.sp, fontFamily = FontFamily.Monospace, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        "thinking" -> Text("◌ ${msg.text}", color = Palette.Fg2, fontSize = 12.sp, fontStyle = FontStyle.Italic, lineHeight = 17.sp)
        "result" -> Text("↳ ${msg.text}", color = Palette.Fg2, fontSize = 12.sp, fontFamily = FontFamily.Monospace, lineHeight = 16.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
        else -> Markdown(msg.text, Palette.Fg1)   // intermediate chef narration
    }
}

/** done ✓ · failed ✕ · ask_chef ⇄ — shared by cards and the "prend en compte" line. */
internal fun outcomeIcon(outcome: String): String = when (outcome) {
    "failed" -> "✕"
    "ask_chef" -> "⇄"
    "question" -> "?"
    else -> "✓"
}

internal fun outcomeColor(outcome: String): Color = when (outcome) {
    "failed" -> Palette.StError
    "ask_chef", "question" -> Palette.StInput
    else -> Palette.StUnread
}

private fun fmtAge(ms: Long): String {
    val s = ms / 1000
    if (s < 60) return "${s}s"
    val m = s / 60
    if (m < 60) return "${m}m${(s % 60).toString().padStart(2, '0')}"
    return "${m / 60}h${(m % 60).toString().padStart(2, '0')}"
}

/**
 * A musician REPORTS — it does not converse. Results are a basket of cards with
 * a state-coloured rule, never dialogue bubbles, and the basket is placed AFTER
 * the chef's reply so a callback can never split a turn. Collapsed to a single
 * line when several land at once (progressive disclosure).
 */
@Composable
private fun ResultsBasket(msg: ChatMsg) {
    val n = msg.results.size
    var expanded by remember(msg.id) { mutableStateOf(n == 1) }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .border(1.dp, Palette.CardBorder, RoundedCornerShape(10.dp))
            .background(Palette.CardBg),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Text(if (expanded) "▾" else "▸", color = Palette.Fg2, fontSize = 10.sp)
            Text(
                if (n > 1) "RÉSULTATS REÇUS" else "RÉSULTAT REÇU",
                color = Palette.Fg2, fontSize = 9.sp, letterSpacing = 1.4.sp,
                fontFamily = FontFamily.Monospace,
            )
            Box(
                Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(Palette.StUnread)
                    .padding(horizontal = 5.dp),
            ) {
                Text("$n", color = Palette.Bg0, fontSize = 9.sp, fontWeight = FontWeight.Bold)
            }
            Text(
                msg.results.joinToString(" · ") { "${it.source} ${outcomeIcon(it.outcome)}" },
                color = Palette.Fg2, fontSize = 10.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        if (expanded) {
            Column(
                Modifier.padding(start = 8.dp, end = 8.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                msg.results.forEach { ResultCard(it) }
            }
        }
    }
}

@Composable
private fun ResultCard(item: ResultItem) {
    val c = outcomeColor(item.outcome)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(blend(c, Palette.CardBg, 0.06f))
            .padding(start = 0.dp),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(c))
        Column(Modifier.padding(horizontal = 9.dp, vertical = 7.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    item.source.uppercase(), color = Palette.Fg1, fontSize = 9.sp,
                    letterSpacing = 1.2.sp, fontFamily = FontFamily.Monospace,
                )
                Text(outcomeIcon(item.outcome), color = c, fontSize = 10.sp)
                val meta = listOfNotNull(
                    item.durationMs?.let { fmtAge(it) },
                    item.costUsd?.let { String.format(java.util.Locale.US, "$%.2f", it) },
                ).joinToString(" · ")
                if (meta.isNotEmpty()) {
                    Text(meta, color = Palette.Fg2, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
                }
                if (item.awaitingChef) {
                    Text(
                        "attend le chef", color = Palette.StInput, fontSize = 8.sp,
                        letterSpacing = 1.0.sp,
                        modifier = Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .border(1.dp, blend(Palette.StInput, Palette.CardBg, 0.45f), RoundedCornerShape(999.dp))
                            .padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
            }
            val body = item.summary.ifEmpty { item.text }
            if (body.isNotBlank()) {
                Spacer(Modifier.height(3.dp))
                Text(body, color = Palette.Fg1, fontSize = 12.sp, lineHeight = 17.sp)
            }
        }
    }
}

/** A musician asking the USER — jumps the basket, it needs an answer now. */
@Composable
private fun QuestionBubble(msg: ChatMsg) {
    Column(
        Modifier
            .fillMaxWidth(0.92f)
            .clip(RoundedCornerShape(12.dp))
            .border(1.dp, blend(Palette.StInput, Palette.CardBorder, 0.45f), RoundedCornerShape(12.dp))
            .background(blend(Palette.StInput, Palette.CardBg, 0.08f))
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            "${(msg.source ?: "musicien").uppercase()} TE DEMANDE",
            color = Palette.StInput, fontSize = 9.sp, letterSpacing = 1.4.sp,
            fontFamily = FontFamily.Monospace,
        )
        Markdown(msg.text, Palette.Fg0)
        Text(
            "réponds avec @${msg.source ?: ""}",
            color = Palette.Fg2, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
        )
    }
}

@Composable
private fun TakingLine(taking: List<TakingRef>) {
    if (taking.isEmpty()) return
    Text(
        "prend en compte : " + taking.joinToString(" · ") { "${it.source} ${outcomeIcon(it.outcome)}" },
        color = Palette.Fg2, fontSize = 9.sp, letterSpacing = 0.8.sp,
        fontFamily = FontFamily.Monospace,
        maxLines = 2, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(start = 8.dp, bottom = 2.dp),
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatBubble(msg: ChatMsg, onReply: (ChatMsg) -> Unit = {}) {
    if (msg.role == ChatMsg.Role.activity) { ActivityLine(msg); return }
    if (msg.role == ChatMsg.Role.results) { ResultsBasket(msg); return }
    if (msg.role == ChatMsg.Role.question) { QuestionBubble(msg); return }
    var showMenu by remember { mutableStateOf(false) }
    val isUser = msg.role == ChatMsg.Role.user
    val isCallback = msg.role == ChatMsg.Role.callback
    val isRight = isUser
    val label = when {
        isUser -> "TOI"
        isCallback -> (msg.source ?: "musicien").uppercase()
        msg.question -> "CHEF D'ORCHESTRE · QUESTION"
        else -> "CHEF D'ORCHESTRE"
    }
    val labelColor = when {
        isUser -> Palette.Fg2
        isCallback -> Palette.Fg2
        msg.question -> Palette.StInput
        else -> Palette.Accent
    }
    val bubbleBg = when {
        isUser -> blend(Palette.Fg0, Palette.CardBg, 0.10f)
        isCallback -> blend(Palette.Fg2, Palette.CardBg, 0.05f)
        else -> blend(Palette.Accent, Palette.CardBg, 0.08f)
    }
    val bubbleBorder = when {
        isUser -> blend(Palette.Fg0, Color.Transparent, 0.28f)
        isCallback -> blend(Palette.Fg2, Palette.CardBorder, 0.30f)
        else -> blend(Palette.Accent, Palette.CardBorder, 0.40f)
    }
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (isRight) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            horizontalAlignment = if (isRight) Alignment.End else Alignment.Start,
            modifier = Modifier.fillMaxWidth(0.88f),
        ) {
            // Links this chef turn to the results it is answering about.
            TakingLine(msg.taking)
            Text(
                label,
                color = labelColor,
                fontSize = 9.sp,
                letterSpacing = 1.6.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            )
            Box {
                Box(
                    Modifier
                        .clip(RoundedCornerShape(14.dp))
                        .combinedClickable(
                            onClick = {},
                            onLongClick = { showMenu = true },
                        )
                        .background(bubbleBg)
                        .border(1.dp, bubbleBorder, RoundedCornerShape(14.dp))
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    if (isUser) {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            msg.imageUris.forEach { uri ->
                                AsyncImage(
                                    model = uri,
                                    contentDescription = null,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(max = 220.dp)
                                        .clip(RoundedCornerShape(6.dp)),
                                    contentScale = ContentScale.Fit,
                                )
                            }
                            if (msg.text.isNotBlank()) {
                                Text(msg.text, color = Palette.Fg0, fontSize = 14.sp, lineHeight = 21.sp)
                            }
                        }
                    } else {
                        Markdown(msg.text)
                    }
                }
                DropdownMenu(
                    expanded = showMenu,
                    onDismissRequest = { showMenu = false },
                ) {
                    DropdownMenuItem(
                        text = { Text("Répondre", fontSize = 14.sp) },
                        onClick = { showMenu = false; onReply(msg) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ProjectSession(
    m: Musician?,
    onAddTool: (tool: String) -> Unit,
    modifier: Modifier = Modifier,
) {
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

    // Snapshot the ring once per composition pass — prevents IndexOutOfBoundsException
    // if the SnapshotStateList mutates while LazyColumn defers item lambdas.
    // Filter to events that actually render SOMETHING: a tool_result `user` event
    // (one after every tool call), a non-init `system` event, or an empty
    // assistant turn otherwise produced a blank LazyColumn item that still ate
    // the spacedBy gap → the big empty holes between blocks.
    val ringSnapshot = m.ring.toList().filter { isRenderable(it) }

    // Use Musician.pendingDenials which is already maintained by ingest().
    val deniedTools = m.pendingDenials.toList()

    val listState = rememberLazyListState()
    // First landing = instant jump to the bottom (no top→bottom animation on
    // open); later updates animate. Key on the monotone ingest counter, not
    // ring.size — the ring is capped at 30, so once full its size stops changing
    // and auto-scroll would freeze.
    var firstScrollDone by remember { mutableStateOf(false) }
    LaunchedEffect(m.ingestSeq) {
        if (ringSnapshot.isNotEmpty()) {
            val target = ringSnapshot.size - 1
            if (!firstScrollDone) { listState.scrollToItem(target); firstScrollDone = true }
            else listState.animateScrollToItem(target)
        }
    }
    Column(modifier.fillMaxSize()) {
        TelemetryStrip(m)
        if (deniedTools.isNotEmpty()) {
            DenialBanner(
                denials = deniedTools,
                onApprove = onAddTool,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp),
            )
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(ringSnapshot) { raw -> EventLine(raw) }
            // Live token-streamed line for the in-flight block (not yet in the ring).
            val streaming = m.state == MState.live || m.state == MState.think
            if (streaming && (m.liveText.isNotBlank() || m.liveActivity.isNotBlank())) {
                item { LiveLine(activity = m.liveActivity, text = m.liveText) }
            }
        }
    }
}

/**
 * Second line of a musician's panel, fed by the authoritative /api/pupitre
 * snapshot: current activity, turn duration, silence, PID liveness. These cannot
 * be derived from the event stream — without them a crashed musician kept
 * claiming "EN COMMUNICATION" forever on the phone.
 */
@Composable
private fun TelemetryStrip(m: Musician) {
    val dead = m.deadInFlight
    val stalled = m.stalled && !dead
    val tone = when {
        dead -> Palette.StError
        stalled -> Palette.StInput
        else -> Palette.Fg2
    }
    val bits = buildList {
        m.activity?.takeIf { it.isNotBlank() }?.let { add(it.take(40)) }
        m.turnElapsedMs?.let { add("tour ${fmtAge(it)}") }
        m.silentMs?.let { add("silence ${fmtAge(it)}") }
        m.pid?.let { add("pid $it${if (m.pidAlive == false) " ✗" else if (m.pidAlive == true) " ✓" else ""}") }
        m.observedModel?.takeIf { it.isNotBlank() }?.let { add(it.removePrefix("claude-")) }
        if (m.queueDepth > 0) add("file ${m.queueDepth}")
    }
    if (bits.isEmpty() && !dead && !stalled) return
    Column(
        Modifier
            .fillMaxWidth()
            .background(blend(tone, Palette.Bg0, 0.07f))
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (dead || stalled) {
            Text(
                if (dead) "⚠ PROCESSUS PERDU — aucun producteur vivant"
                else "⚠ SANS PROGRÈS OBSERVÉ",
                color = tone, fontSize = 9.sp, letterSpacing = 1.2.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
        if (bits.isNotEmpty()) {
            Text(
                bits.joinToString(" · "),
                color = if (dead || stalled) tone else Palette.Fg2,
                fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Trailing line that shows the current block streaming in, token by token. */
@Composable
private fun LiveLine(activity: String, text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (activity.isNotBlank()) {
            Text(activity, color = Palette.StLive, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        }
        if (text.isNotBlank()) {
            Text(text, color = Palette.Fg1, fontSize = 13.sp, lineHeight = 19.sp)
        }
    }
}

/** Sticky banner listing blocked tools with an "Approuver" button each. */
@Composable
private fun DenialBanner(
    denials: List<String>,
    onApprove: (tool: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.StInput.copy(alpha = 0.08f))
            .border(1.dp, Palette.StInput.copy(alpha = 0.40f), RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            "🚫  Outils bloqués — non autorisés dans ce projet",
            color = Palette.StInput,
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Medium,
        )
        denials.forEach { tool ->
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(tool, color = Palette.Fg1, fontSize = 13.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
                Box(
                    Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(Palette.StLive.copy(alpha = 0.15f))
                        .border(1.dp, Palette.StLive.copy(alpha = 0.50f), RoundedCornerShape(6.dp))
                        .clickable { onApprove(tool) }
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                ) {
                    Text("Approuver ✓", color = Palette.StLive, fontSize = 11.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}

/** True only when EventLine will draw something for this event — used to keep
 *  blank items (and their spacing) out of the LazyColumn. Must stay in sync
 *  with the EventLine `when`. */
private fun isRenderable(raw: RawEvent): Boolean = when (raw.type) {
    "assistant" -> raw.message?.content.orEmpty().any { b ->
        (b.type == "text" && !b.text.isNullOrBlank()) ||
        (b.type == "thinking" && !b.thinking.isNullOrBlank()) ||
        b.type == "tool_use"
    }
    "result" -> true
    "system" -> raw.subtype == "init"
    "user" -> raw.message?.content.orEmpty().any { b ->
        b.type == "tool_result" && Musician.PERM_RE.containsMatchIn(blockText(b))
    }
    "user_prompt" -> !raw.text.isNullOrBlank() || !raw.attachmentPaths.isNullOrEmpty()
    else -> false
}

/** A tool_use row: gear + tool name + its key argument (file / command / …). */
@Composable
private fun ToolUseChip(b: RawEvent.Block) {
    val name = b.name ?: "tool"
    val arg = b.toolArgPreview()
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Palette.StLive.copy(alpha = 0.10f))
            .border(1.dp, Palette.StLive.copy(alpha = 0.25f), RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("⚙", fontSize = 13.sp, color = Palette.StLive)
        Text(name, color = Palette.StLive, fontSize = 12.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
        if (arg.isNotBlank()) Text(
            arg,
            color = Palette.Fg1, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun EventLine(raw: RawEvent) {
    when (raw.type) {
        "assistant" -> {
            // Render EVERY block (an assistant turn can carry thinking + tool_use
            // + text). Tool calls show their key argument (file/command/…) so the
            // user actually sees what the musician is doing — not a bare "Edit".
            val content = raw.message?.content.orEmpty()
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (b in content) when (b.type) {
                    "text" -> if (!b.text.isNullOrBlank()) Markdown(b.text.trim(), Palette.Fg0)
                    "thinking" -> if (!b.thinking.isNullOrBlank()) Text(
                        "◌ ${b.thinking.trim()}",
                        color = Palette.Fg2, fontSize = 12.sp, fontStyle = FontStyle.Italic, lineHeight = 17.sp,
                    )
                    "tool_use" -> ToolUseChip(b)
                }
            }
        }
        "result" -> {
            val baseLabel = if (raw.isError == true) "— tour en erreur" else "— tour terminé"
            val dur = raw.durationMs?.let { " · ${"%.1f".format(NUM, it / 1000.0)}s" } ?: ""
            val usage = formatResultUsage(raw)
            val label = (baseLabel + dur + (if (usage.isNotEmpty()) " · $usage" else "") + " —")
            Text(label, color = Palette.Fg3, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        }
        "system" -> {
            if (raw.subtype == "init") {
                Text("— nouveau tour —", color = Palette.Fg3, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }
        }
        "user" -> {
            val deniedTool = raw.message?.content.orEmpty().firstNotNullOfOrNull { b ->
                if (b.type != "tool_result") return@firstNotNullOfOrNull null
                Musician.PERM_RE.find(blockText(b))?.groupValues?.getOrNull(1)
            }
            if (deniedTool != null) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(Palette.StInput.copy(alpha = 0.10f))
                        .border(1.dp, Palette.StInput.copy(alpha = 0.35f), RoundedCornerShape(8.dp))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("🚫", fontSize = 14.sp)
                    Text(
                        "Outil bloqué — $deniedTool non autorisé",
                        color = Palette.StInput,
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        "user_prompt" -> {
            val t = raw.text?.trim().orEmpty()
            val imgCount = raw.attachmentPaths?.size ?: 0
            if (t.isNotEmpty() || imgCount > 0) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (imgCount > 0) {
                        Text(
                            "📎 $imgCount image${if (imgCount > 1) "s" else ""} jointe${if (imgCount > 1) "s" else ""}",
                            color = Palette.Accent,
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    if (t.isNotEmpty()) Markdown(t, Palette.Fg0)
                }
            }
        }
        else -> {}
    }
}

/** Extract text content from a tool_result Block regardless of whether content is a string or array. */
private fun blockText(b: RawEvent.Block): String = when (val c = b.content) {
    is JsonPrimitive -> c.contentOrNull ?: ""
    is JsonArray -> c.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.joinToString("\n")
    else -> ""
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

// Locale.US throughout: the default (fr) locale renders "%.2f" with a COMMA,
// so the fleet cost showed as "$6,78" and read like a broken build variable.
private val NUM = java.util.Locale.US

internal fun fmtTok(n: Long): String = when {
    n <= 0 -> "0"
    n >= 1_000_000 -> "%.2fM".format(NUM, n / 1_000_000.0)
    n >= 10_000    -> "%dk".format(NUM, n / 1000)
    n >= 1_000     -> "%.1fk".format(NUM, n / 1000.0)
    else -> n.toString()
}

internal fun fmtCost(usd: Double): String = when {
    usd <= 0 -> "$0"
    usd < 0.01 -> "<\$0.01"
    else -> "$%.2f".format(NUM, usd)
}
