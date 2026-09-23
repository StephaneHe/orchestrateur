package com.orchestrateur.ui.fleet

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.orchestrateur.BuildConfig
import com.orchestrateur.data.Api
import com.orchestrateur.data.Musician
import com.orchestrateur.data.State as MState
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** ACTION_GET_CONTENT contract that accepts multiple MIME types via EXTRA_MIME_TYPES. */
private class GetContentMultiMime : ActivityResultContract<Array<String>, android.net.Uri?>() {
    override fun createIntent(context: Context, input: Array<String>) =
        Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, input)
            addCategory(Intent.CATEGORY_OPENABLE)
        }
    override fun parseResult(resultCode: Int, intent: Intent?) =
        if (resultCode == Activity.RESULT_OK) intent?.data else null
}

@Composable
fun FleetScreen(api: Api) {
    val context = LocalContext.current
    // Use viewModel() so the VM survives configuration changes (rotation,
    // dark mode, language switch). With remember { } a config change
    // recreated the VM while the old one's streamJob was still running →
    // 2 SSE in parallel until the GC eventually got the old VM. Now the
    // VM lives at Activity scope, single-flight stays single-flight.
    val vm: FleetViewModel = androidx.lifecycle.viewmodel.compose.viewModel(
        factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                FleetViewModel(api, context.applicationContext) as T
        }
    )
    val status by vm.status.collectAsState()
    val connected by vm.connected.collectAsState()
    val scope = rememberCoroutineScope()

    // Lifecycle-aware SSE: when the app goes to background (ON_STOP) we
    // close the SSE connection cleanly so the server stops trying to push
    // events into a socket the OS may suspend silently. Re-opens on
    // ON_START. Without this, a backgrounded app left zombie SSE sockets
    // that crashed the server when it tried to write to them.
    val lifecycleOwner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            when (event) {
                androidx.lifecycle.Lifecycle.Event.ON_START -> vm.resumeStream()
                androidx.lifecycle.Lifecycle.Event.ON_STOP  -> vm.pauseStream()
                else -> {}
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val mediaLauncher = rememberLauncherForActivityResult(GetContentMultiMime()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch(Dispatchers.IO) {
            try {
                val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
                val isVideo = mime.startsWith("video/")
                val thumb = if (isVideo) extractVideoThumb(context, uri) else null
                vm.addAttachment(uri, mime, isVideo, thumb)
            } catch (_: Exception) {}
        }
    }

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
            Spacer(Modifier.width(6.dp))
            Text(
                "v${BuildConfig.VERSION_NAME}",
                color = Palette.Fg2,
                fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.weight(1f))
            // Fleet cost/token totals were shown here but glued onto the version
            // ("v0.4.3-debug$1.85") when the row overflowed, reading like a broken
            // build string. Per-turn cost is already in each result line, so the
            // header now stays a clean version + status.
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

        // System voice: a thin banner, never a chat bubble. Provider availability
        // and telemetry freshness must be impossible to miss and impossible to
        // confuse with something the chef or a musician said.
        val limitedUntil by vm.limitedUntil.collectAsState()
        val telemetryFresh by vm.telemetryFresh.collectAsState()
        if (limitedUntil != null || !telemetryFresh) {
            val msg = when {
                limitedUntil != null -> "⚡ Claude limité jusqu'à ${fmtLimitUntil(limitedUntil!!)}"
                else -> "⟲ données anciennes — télémétrie injoignable"
            }
            val tone = if (limitedUntil != null) Palette.StInput else Palette.Fg2
            Text(
                msg,
                color = tone,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(blend(tone, Palette.Bg0, 0.10f))
                    .padding(horizontal = 14.dp, vertical = 5.dp),
            )
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

        var replyTo by remember { mutableStateOf<ChatMsg?>(null) }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (vm.musicians.isEmpty()) {
                Text("Chargement…", color = Palette.Fg2, modifier = Modifier.align(Alignment.Center))
            } else {
                MainPane(
                    activeTab = vm.activeTab,
                    chat = vm.chat,
                    musicians = vm.musicians,
                    onAddTool = vm::addTool,
                    onReply = { msg -> replyTo = msg },
                )
            }
        }

        Composer(
            activeTab = vm.activeTab,
            musicians = vm.musicians,
            pendingImages = vm.pendingImages,
            replyTo = replyTo,
            onPickImage = { mediaLauncher.launch(arrayOf("image/*", "video/*")) },
            onRemoveImage = vm::removeImage,
            onClearReply = { replyTo = null },
            onSend = { prompt, displayText -> vm.dispatch(prompt, displayText) },
        )
    }
}

@Composable
private fun Composer(
    activeTab: String,
    musicians: SnapshotStateList<Musician>,
    pendingImages: List<PendingAttachment>,
    replyTo: ChatMsg?,
    onPickImage: () -> Unit,
    onRemoveImage: (Int) -> Unit,
    onClearReply: () -> Unit,
    onSend: (prompt: String, displayText: String) -> Unit,
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

    val canSend = field.text.isNotBlank() || pendingImages.isNotEmpty() || replyTo != null

    fun commit(pick: Musician) {
        val m = mention ?: return
        val before = field.text.substring(0, m.anchor)
        val after = field.text.substring(field.selection.start)
        val needsSpace = !after.startsWith(" ") && !after.startsWith("\n")
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
        if (replyTo != null) {
            QuotePreview(
                msg = replyTo,
                onDismiss = onClearReply,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp),
            )
        }
        if (pendingImages.isNotEmpty()) {
            ImageStrip(
                images = pendingImages,
                onRemove = onRemoveImage,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp),
            )
        }
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
                .padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(
                onClick = onPickImage,
                modifier = Modifier.size(40.dp),
                contentPadding = PaddingValues(0.dp),
            ) {
                Text("📎", fontSize = 18.sp)
            }
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
                    if (canSend) {
                        val displayText = field.text
                        val quoted = replyTo?.let { r ->
                            val label = if (r.role == ChatMsg.Role.conductor) "chef" else "moi"
                            "> [$label] ${r.text.replace("\n", " ").take(120)}\n\n"
                        } ?: ""
                        onSend(quoted + displayText, displayText)
                        field = TextFieldValue("")
                        onClearReply()
                    }
                },
                enabled = canSend,
            ) {
                Text("▶", color = if (canSend) Palette.Accent else Palette.Fg3)
            }
        }
    }
}

@Composable
private fun QuotePreview(
    msg: ChatMsg,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val label = if (msg.role == ChatMsg.Role.conductor) "chef" else "moi"
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Palette.CardBg)
            .border(1.dp, Palette.Accent.copy(alpha = 0.4f), RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .width(3.dp)
                .height(32.dp)
                .background(Palette.Accent, RoundedCornerShape(2.dp)),
        )
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(label, color = Palette.Accent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            Text(
                msg.text.replace("\n", " ").take(120),
                color = Palette.Fg2,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        Box(
            Modifier
                .size(20.dp)
                .clip(CircleShape)
                .clickable { onDismiss() },
            contentAlignment = Alignment.Center,
        ) {
            Text("×", color = Palette.Fg2, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun ImageStrip(
    images: List<PendingAttachment>,
    onRemove: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        images.forEachIndexed { idx, att ->
            Box(Modifier.size(64.dp)) {
                // For videos, show the extracted first-frame bitmap; fall back to the URI
                // (Coil can't decode video frames from URI without the video decoder artifact).
                val imageModel: Any = if (att.isVideo && att.thumbBitmap != null)
                    att.thumbBitmap.asImageBitmap()
                else
                    att.uri

                AsyncImage(
                    model = imageModel,
                    contentDescription = null,
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(RoundedCornerShape(8.dp)),
                    contentScale = ContentScale.Crop,
                )

                // Video badge — play icon in bottom-left corner
                if (att.isVideo) {
                    Box(
                        Modifier
                            .align(Alignment.BottomStart)
                            .padding(3.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(Color.Black.copy(alpha = 0.60f))
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                    ) {
                        Text("▶", color = Color.White, fontSize = 8.sp)
                    }
                }

                // Remove button — top-right
                Box(
                    Modifier
                        .size(18.dp)
                        .align(Alignment.TopEnd)
                        .clip(CircleShape)
                        .background(Palette.Bg0.copy(alpha = 0.85f))
                        .clickable { onRemove(idx) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text("×", color = Palette.Fg0, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

private fun stateShort(s: MState): String = when (s) {
    MState.idle -> "repos"
    MState.live -> "actif"
    MState.think -> "réfl."
    MState.input -> "attend"
    MState.error -> "erreur"
    MState.unread -> "non lu"
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
            .heightIn(max = 220.dp)         // cap height so keyboard doesn't cut the list
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.CardBg)
            .border(1.dp, Palette.CardBorder, RoundedCornerShape(10.dp))
            .verticalScroll(rememberScrollState())
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
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    stateShort(m.state),
                    color = Palette.Fg2,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                )
            }
        }
    }
}

/** "2026-09-23T07:00:00Z" → "09:00" (local). Falls back to the raw string. */
private fun fmtLimitUntil(iso: String): String = try {
    val t = java.time.Instant.parse(iso).atZone(java.time.ZoneId.systemDefault())
    String.format(java.util.Locale.US, "%02d:%02d", t.hour, t.minute)
} catch (_: Exception) { iso }
