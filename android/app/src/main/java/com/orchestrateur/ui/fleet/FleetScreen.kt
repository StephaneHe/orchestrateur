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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
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

// ============================================================================
// Destination JOURNAL — la conversation de direction avec le chef.
// L'état du chef vit dans l'EN-TÊTE (source visuelle unique) ; les musiciens
// sont un rail (ligne « Pilotage » + feuille), pas des onglets.
// ============================================================================

@Composable
fun JournalScreen(
    vm: FleetViewModel,
    onOpenMusician: (String) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val context = LocalContext.current
    val connected by vm.connected.collectAsState()
    val scope = rememberCoroutineScope()

    // Lifecycle-aware SSE: when the app goes to background (ON_STOP) we close
    // the SSE connection cleanly so the server stops trying to push events into
    // a socket the OS may suspend silently. Re-opens on ON_START.
    val lifecycleOwner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            when (event) {
                androidx.lifecycle.Lifecycle.Event.ON_START -> vm.resumeStream()
                androidx.lifecycle.Lifecycle.Event.ON_STOP -> vm.pauseStream()
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

    var showPilotage by remember { mutableStateOf(false) }
    // Le LazyListState vit ICI : le retour depuis le détail rend le journal à
    // la même ancre (la destination n'est pas reconstruite, l'état persiste).
    val listState = rememberLazyListState()

    Column(Modifier.fillMaxSize().background(Palette.Bg0)) {
        JournalHeader(vm, connected, onOpenSettings) { onOpenMusician(FleetViewModel.CONDUCTOR) }
        SystemBanner(vm, connected)
        AttentionBand(vm, onOpenMusician)

        if (vm.musicians.isNotEmpty()) {
            PilotageLine(musicians = vm.musicians, onOpen = { showPilotage = true })
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.CardBorder))
        }

        var replyTo by remember { mutableStateOf<ChatMsg?>(null) }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (vm.musicians.isEmpty()) {
                Text("Chargement…", color = Palette.Fg2, modifier = Modifier.align(Alignment.Center))
            } else {
                MainPane(
                    vm = vm,
                    listState = listState,
                    onOpenMusician = onOpenMusician,
                    onReply = { msg -> replyTo = msg },
                )
                // « Nouveau rapport ↓ » — on ne force JAMAIS le défilement :
                // le brouillon et la position de lecture sont conservés.
                if (vm.newReportPending) {
                    Text(
                        "Nouveau rapport ↓",
                        color = Palette.Bg0, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 10.dp)
                            .heightIn(min = 40.dp)
                            .clip(RoundedCornerShape(999.dp))
                            .background(Palette.Accent)
                            .clickable {
                                vm.markReportSeen()
                                scope.launch { listState.animateScrollToItem((vm.chat.size - 1).coerceAtLeast(0)) }
                            }
                            .wrapContentHeight()
                            .padding(horizontal = 16.dp),
                    )
                }
            }
        }

        Composer(
            vm = vm,
            pendingImages = vm.pendingImages,
            replyTo = replyTo,
            onPickImage = { mediaLauncher.launch(arrayOf("image/*", "video/*")) },
            onRemoveImage = vm::removeImage,
            onClearReply = { replyTo = null },
            onSend = { prompt, displayText -> vm.dispatch(prompt, displayText) },
        )
    }

    if (showPilotage) {
        PilotageSheet(
            musicians = vm.musicians,
            onOpenMusician = { showPilotage = false; onOpenMusician(it) },
            onDismiss = { showPilotage = false },
        )
    }
}

/** En-tête : marque, version app, version serveur, état du CHEF, fraîcheur. */
@Composable
private fun JournalHeader(
    vm: FleetViewModel,
    connected: Boolean,
    onOpenSettings: () -> Unit,
    onOpenChef: () -> Unit,
) {
    val chef = vm.musicians.find { it.name == FleetViewModel.CONDUCTOR }
    val serverVersion by vm.serverVersion.collectAsState()
    val snapAt by vm.snapshotAt.collectAsState()
    Column(Modifier.fillMaxWidth().statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Orchestre", color = Palette.Fg0, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Spacer(Modifier.width(6.dp))
            Text(
                "app ${BuildConfig.VERSION_NAME}" + (serverVersion?.let { " · serveur $it" } ?: ""),
                color = Palette.Fg3, fontSize = 9.sp, fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.weight(1f))
            if (!connected) {
                Text(
                    "↺", color = Palette.StInput, fontSize = 16.sp,
                    modifier = Modifier
                        .heightIn(min = 40.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .clickable { vm.reconnect() }
                        .wrapContentHeight()
                        .padding(horizontal = 8.dp),
                )
            }
            Text(
                "⋮", color = Palette.Fg2, fontSize = 18.sp,
                modifier = Modifier
                    .heightIn(min = 40.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .clickable(onClick = onOpenSettings)
                    .wrapContentHeight()
                    .padding(horizontal = 8.dp),
            )
        }
        // L'état du chef : ici et nulle part ailleurs (plus de carte chef).
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .clickable(onClick = onOpenChef)
                .padding(horizontal = 14.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            val tone = chef?.let { stateColor(it.state) } ?: Palette.Fg3
            Text("♛", color = tone, fontSize = 13.sp)
            Text(
                "CHEF", color = Palette.Fg0, fontSize = 10.sp, letterSpacing = 1.8.sp,
                fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
            )
            val waiting = chef != null && (chef.state == MState.live || chef.state == MState.think)
            Text(
                when {
                    chef == null -> "aucun chef configuré"
                    waiting && chef.state == MState.think -> "réfléchit…"
                    waiting -> "répond…"
                    else -> stateLabel(chef).lowercase()
                },
                color = tone, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.weight(1f))
            // Fraîcheur : l'ÂGE de l'instantané, pas l'horloge de rendu.
            val telemetryFresh by vm.telemetryFresh.collectAsState()
            Text(
                when {
                    snapAt == 0L -> "instantané non reçu"
                    !telemetryFresh -> "données anciennes"
                    else -> "synchronisé il y a ${fmtAgeShort(System.currentTimeMillis() - snapAt)}"
                },
                color = Palette.Fg3, fontSize = 9.sp, fontFamily = FontFamily.Monospace,
                maxLines = 1,
            )
        }
    }
}

/**
 * UN SEUL bandeau système à la fois, le plus grave, les autres en compteur.
 * Priorité : processus perdu > limite Claude > flux interrompu / données
 * anciennes. Un SSE coupé avec un instantané frais ne dit PAS « tout est mort ».
 */
@Composable
private fun SystemBanner(vm: FleetViewModel, connected: Boolean) {
    val limitedUntil by vm.limitedUntil.collectAsState()
    val telemetryFresh by vm.telemetryFresh.collectAsState()
    val dead = vm.musicians.filter { it.deadInFlight && !it.parked }

    data class Banner(val msg: String, val tone: Color)
    val banners = buildList {
        if (dead.isNotEmpty()) {
            add(Banner("✗ processus perdu — ${dead.joinToString(", ") { it.name }}", Palette.StError))
        }
        limitedUntil?.let { add(Banner("⚡ Claude limité jusqu'à ${fmtLimitUntil(it)}", Palette.StInput)) }
        if (!connected) {
            add(Banner(
                if (!telemetryFresh) "⟲ flux interrompu — données anciennes, reconnexion automatique"
                else "⟲ flux interrompu — états actualisés par instantané, direct coupé",
                Palette.Fg2,
            ))
        } else if (!telemetryFresh) {
            add(Banner("⟲ télémétrie muette — dernières valeurs connues affichées", Palette.Fg2))
        }
    }
    val top = banners.firstOrNull() ?: return
    Row(
        Modifier
            .fillMaxWidth()
            .background(blend(top.tone, Palette.Bg0, 0.10f))
            .padding(horizontal = 14.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            top.msg, color = top.tone, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
            maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        if (banners.size > 1) {
            Text(
                "+${banners.size - 1}", color = Palette.Fg3, fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

/**
 * Bande « À votre attention » : une ligne repliée, l'élément le plus grave
 * lisible sans clic. Priorité : question > processus perdu > échec > sans
 * progrès. Un parké n'y figure pas — sa santé n'est pas suivie.
 */
@Composable
private fun AttentionBand(vm: FleetViewModel, onOpenMusician: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }

    data class Item(val rank: Int, val name: String, val mark: String, val text: String, val question: Boolean)
    val items = vm.musicians
        .filter { it.name != FleetViewModel.CONDUCTOR && !it.parked }
        .mapNotNull { m ->
            val health = healthNote(m)
            when {
                m.state == MState.input ->
                    Item(0, m.name, "?", m.lastLine.ifBlank { "question sans texte" }, true)
                health != null && health.second -> Item(1, m.name, "✗", health.first, false)
                m.state == MState.error -> Item(2, m.name, "✕", m.lastLine.ifBlank { "échec du tour" }, false)
                health != null -> Item(3, m.name, "!", health.first, false)
                else -> null
            }
        }
        .sortedWith(compareBy({ it.rank }, { it.name }))
    if (items.isEmpty()) return

    val counts = buildList {
        val nq = items.count { it.rank == 0 }
        val nd = items.count { it.rank == 1 }
        val ne = items.count { it.rank == 2 }
        val ns = items.count { it.rank == 3 }
        if (nq > 0) add("$nq question${if (nq > 1) "s" else ""}")
        if (nd > 0) add("$nd processus perdu${if (nd > 1) "s" else ""}")
        if (ne > 0) add("$ne échec${if (ne > 1) "s" else ""}")
        if (ns > 0) add("$ns sans progrès")
    }
    val top = items.first()

    Column(Modifier.fillMaxWidth().background(blend(Palette.StInput, Palette.Bg0, 0.07f))) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clickable { open = !open }
                .padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "⚠ À VOTRE ATTENTION", color = Palette.StInput, fontSize = 9.sp,
                letterSpacing = 1.4.sp, fontFamily = FontFamily.Monospace,
            )
            Text(
                counts.joinToString(" · "), color = Palette.Fg2, fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                "${top.name} : ${top.text}", color = Palette.Fg0, fontSize = 11.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Text(if (open) "▾" else "▸", color = Palette.Fg2, fontSize = 10.sp)
        }
        if (open) {
            Column(
                Modifier.padding(horizontal = 14.dp).padding(bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items.forEach { it2 ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(Palette.Bg1)
                            .border(1.dp, Palette.CardBorder, RoundedCornerShape(8.dp))
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                it2.mark,
                                color = if (it2.rank <= 2) Palette.StError else Palette.StInput,
                                fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                            )
                            Text(
                                it2.name, color = Palette.Fg0, fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                            )
                            Text(
                                it2.text, color = Palette.Fg1, fontSize = 11.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (it2.question) {
                                ActionChip("Répondre via le chef", primary = true) {
                                    vm.applyAnswerContext(AnswerContext(it2.name, it2.text))
                                }
                            } else {
                                ActionChip("En parler au chef", primary = true) {
                                    vm.applyAnswerContext(AnswerContext(it2.name, about = true))
                                }
                            }
                            ActionChip("Ouvrir") { onOpenMusician(it2.name) }
                        }
                    }
                }
            }
        }
    }
}

/** Destination RÉGLAGES — admin hors du fil (version, flotte, parkés). */
@Composable
fun SettingsScreen(vm: FleetViewModel, onBack: () -> Unit) {
    val serverVersion by vm.serverVersion.collectAsState()
    Column(
        Modifier.fillMaxSize().background(Palette.Bg0).statusBarsPadding()
            .verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "‹ Retour", color = Palette.Fg2, fontSize = 13.sp, fontFamily = FontFamily.Monospace,
            modifier = Modifier
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(8.dp))
                .clickable(onClick = onBack)
                .wrapContentHeight()
                .padding(horizontal = 8.dp),
        )
        Text("Réglages", color = Palette.Fg0, fontSize = 20.sp, fontWeight = FontWeight.Medium)
        Text(
            "Application ${BuildConfig.VERSION_NAME}",
            color = Palette.Fg1, fontSize = 13.sp, fontFamily = FontFamily.Monospace,
        )
        Text(
            "Serveur " + (serverVersion ?: "version non fournie"),
            color = Palette.Fg1, fontSize = 13.sp, fontFamily = FontFamily.Monospace,
        )
        Text(
            "${vm.musicians.count { !it.parked }} musiciens actifs · " +
                "${vm.musicians.count { it.parked }} mis de côté",
            color = Palette.Fg2, fontSize = 12.sp,
        )
        Text(
            "Les projets, sessions et outils se gèrent depuis le tableau de bord web.",
            color = Palette.Fg3, fontSize = 11.sp,
        )
    }
}

@Composable
private fun Composer(
    vm: FleetViewModel,
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
    val musicians = vm.musicians
    val ctx = vm.answerContext

    // « Répondre via le chef » / « En parler au chef » préremplissent le
    // composer : le message part au CHEF, en citant la question et en nommant X.
    LaunchedEffect(ctx) {
        val c = ctx ?: return@LaunchedEffect
        val prefix = if (c.about) "À propos de ${c.musician} : "
        else "Réponse pour ${c.musician} à sa question « ${c.question.take(160)} » : "
        if (!field.text.startsWith(prefix)) {
            val rest = field.text.replace(Regex("^@\\S+\\s*"), "")
            field = TextFieldValue(prefix + rest, TextRange((prefix + rest).length))
        }
    }

    // Cible affichée : le chef par défaut, un musicien nommé si `@X` explicite.
    val directTarget = remember(field.text, musicians.map { it.name }) {
        Regex("^@([A-Za-z0-9_.\\-]+)").find(field.text.trim())?.groupValues?.get(1)
            ?.takeIf { n -> musicians.any { it.name == n } }
    }
    val chefBusy = musicians.find { it.name == FleetViewModel.CONDUCTOR }?.pidAlive == true

    val placeholder = if (directTarget != null)
        "Envoi direct à $directTarget — aucun retour au chef"
    else "Écrivez au chef — tape @ pour citer un musicien"

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
        if (ctx != null) {
            Row(
                Modifier
                    .padding(start = 12.dp, end = 12.dp, top = 6.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(blend(Palette.Accent, Palette.CardBg, 0.08f))
                    .border(1.dp, blend(Palette.Accent, Palette.CardBorder, 0.40f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    if (ctx.about) "AU CHEF, À PROPOS DE ${ctx.musician.uppercase()}"
                    else "RÉPONSE VIA LE CHEF POUR ${ctx.musician.uppercase()}",
                    color = Palette.Accent, fontSize = 9.sp, letterSpacing = 1.2.sp,
                    fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Box(
                    Modifier.size(20.dp).clip(CircleShape).clickable { vm.applyAnswerContext(null) },
                    contentAlignment = Alignment.Center,
                ) { Text("×", color = Palette.Fg2, fontSize = 14.sp, fontWeight = FontWeight.Bold) }
            }
        }
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
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                if (directTarget != null) "À : ${directTarget.uppercase()} (DIRECT)" else "À : CHEF",
                color = if (directTarget != null) Palette.StInput else Palette.Fg3,
                fontSize = 9.sp, letterSpacing = 1.4.sp, fontFamily = FontFamily.Monospace,
            )
            // Interruption coopérative : on le DIT avant, pas après.
            if (directTarget == null && chefBusy) {
                Text(
                    "· l'envoi interrompra le tour du chef",
                    color = Palette.StInput, fontSize = 9.sp, fontFamily = FontFamily.Monospace,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Palette.CardBg)
                .padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(
                onClick = onPickImage,
                modifier = Modifier.size(44.dp),
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
                        vm.applyAnswerContext(null)
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
                .size(24.dp)
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

                Box(
                    Modifier
                        .size(20.dp)
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
                    .heightIn(min = 48.dp)
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
