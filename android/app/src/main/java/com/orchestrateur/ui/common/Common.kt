package com.orchestrateur.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.Api
import com.orchestrateur.data.RestResult
import com.orchestrateur.data.Tts
import com.orchestrateur.data.UiPrefs
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.delay

/**
 * What every screen may use (1.0.0). Provided once by MainActivity through
 * [LocalEnv]; screens never build their own Api or navigation.
 */
class AppEnv(
    val api: Api,
    val prefs: UiPrefs,
    val tts: Tts,
    /** Opens a musician's detail screen. */
    val openMusician: (String) -> Unit,
    /** Navigates to a route (a [com.orchestrateur.ui.more.Section] route or "journal"). */
    val navigate: (String) -> Unit,
    val back: () -> Unit,
    /** Puts [text] in the chef composer (replacing the draft) and shows the thread. */
    val prepareChef: (text: String) -> Unit,
    /** Opens the explanation overlay of an identifier ([[kind:value]]). */
    val openId: (kind: String?, value: String, project: String?) -> Unit,
    /** Short message at the bottom of the screen. */
    val toast: (String) -> Unit,
    /** Name of the conductor project (from /api/config). */
    val conductor: () -> String,
    /** Names of the fleet's projects, conductor included. */
    val projectNames: () -> List<String>,
)

val LocalEnv = staticCompositionLocalOf<AppEnv> { error("AppEnv not provided") }

/** Result of [rememberLoad]: last value, last error, and a manual reload. */
class Loaded<T>(val value: T?, val error: String?, val loading: Boolean, val reload: () -> Unit)

/**
 * Loads [fetch] when composed (and again when [keys] change), then every
 * [refreshMs] while on screen (0 = once). A failed refresh keeps the last value.
 */
@Composable
fun <T> rememberLoad(vararg keys: Any?, refreshMs: Long = 0, fetch: suspend () -> T): Loaded<T> {
    var value by remember(*keys) { mutableStateOf<T?>(null) }
    var error by remember(*keys) { mutableStateOf<String?>(null) }
    var loading by remember(*keys) { mutableStateOf(true) }
    var tick by remember(*keys) { mutableIntStateOf(0) }
    LaunchedEffect(*keys, tick) {
        while (true) {
            loading = true
            try { value = fetch(); error = null } catch (e: Exception) { error = e.message ?: e.javaClass.simpleName }
            loading = false
            if (refreshMs <= 0) break
            delay(refreshMs)
        }
    }
    return Loaded(value, error, loading) { tick++ }
}

/** Throws the server's error text when [r] failed (for use inside [rememberLoad]). */
fun RestResult.orThrow(): RestResult { if (!ok) error(errorText()); return this }

/** Full-screen section: title bar with ← and optional actions, scrollable body by the caller. */
@Composable
fun SectionScaffold(
    title: String,
    subtitle: String? = null,
    onBack: (() -> Unit)? = LocalEnv.current.back,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize().background(Palette.Bg0).statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) {
                Box(Modifier.heightIn(min = 44.dp).clickable { onBack() }.padding(horizontal = 10.dp, vertical = 10.dp)) {
                    Text("←", color = Palette.Fg0, fontSize = 20.sp)
                }
            }
            Column(Modifier.weight(1f).padding(start = 4.dp)) {
                Text(title, color = Palette.Fg0, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                if (!subtitle.isNullOrBlank()) Text(subtitle, color = Palette.Fg2, fontSize = 12.sp)
            }
            actions()
        }
        Box(Modifier.fillMaxWidth().background(Palette.CardBorder).heightIn(min = 1.dp, max = 1.dp))
        Column(Modifier.fillMaxSize(), content = content)
    }
}

@Composable
fun LoadingLine(text: String = "chargement…") {
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.padding(end = 10.dp).heightIn(max = 18.dp), strokeWidth = 2.dp, color = Palette.Accent)
        Text(text, color = Palette.Fg2, fontSize = 13.sp)
    }
}

@Composable
fun ErrorLine(text: String, onRetry: (() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(16.dp)) {
        Text("⚠ $text", color = Palette.StError, fontSize = 13.sp)
        if (onRetry != null) PillButton("Réessayer", onClick = onRetry)
    }
}

@Composable
fun EmptyLine(text: String) {
    Text(text, color = Palette.Fg2, fontSize = 13.sp, modifier = Modifier.padding(16.dp))
}

/** Card with the app's border. */
@Composable
fun Card(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, border: Color = Palette.CardBorder, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    var m = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 5.dp)
        .background(Palette.CardBg, shape).border(1.dp, border, shape)
    if (onClick != null) m = m.clickable { onClick() }
    Column(m.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp), content = content)
}

/** Button ≥ 44 dp high (same touch target as the mobile web). */
@Composable
fun PillButton(label: String, modifier: Modifier = Modifier, color: Color = Palette.Accent, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(22.dp)
    Box(
        modifier.heightIn(min = 44.dp).padding(vertical = 4.dp)
            .border(1.dp, if (enabled) color.copy(alpha = 0.7f) else Palette.Fg3, shape)
            .then(if (enabled) Modifier.clickable { onClick() } else Modifier)
            .padding(horizontal = 14.dp, vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = if (enabled) color else Palette.Fg3, fontSize = 13.sp) }
}

/** Small read-only tag. */
@Composable
fun Tag(text: String, color: Color = Palette.Fg1) {
    Text(text, color = color, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
        modifier = Modifier.border(1.dp, color.copy(alpha = 0.4f), RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
}

@Composable
fun SectionTitle(text: String) {
    Text(text.uppercase(), color = Palette.Fg2, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp))
}

@Composable
fun Mono(text: String, color: Color = Palette.Fg1, size: Int = 12) {
    Text(text, color = color, fontSize = size.sp, fontFamily = FontFamily.Monospace)
}

/** Confirmation dialog (Annuler / [confirm]). */
@Composable
fun ConfirmDialog(title: String, text: String, confirm: String = "Confirmer", onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = { TextButton(onClick = { onConfirm(); onDismiss() }) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Annuler") } },
        containerColor = Palette.Bg2,
    )
}

/** One-field input dialog; [onSubmit] gets the trimmed text. */
@Composable
fun InputDialog(title: String, initial: String = "", label: String = "", confirm: String = "Enregistrer", singleLine: Boolean = false,
                onSubmit: (String) -> Unit, onDismiss: () -> Unit) {
    var v by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { OutlinedTextField(v, { v = it }, label = { if (label.isNotEmpty()) Text(label) }, singleLine = singleLine, modifier = Modifier.fillMaxWidth()) },
        confirmButton = { TextButton(onClick = { onSubmit(v.trim()); onDismiss() }) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Annuler") } },
        containerColor = Palette.Bg2,
    )
}

val ListPadding = PaddingValues(bottom = 24.dp)

/** "il y a 3 min" from an epoch-ms or ISO timestamp. */
fun ageText(ms: Long?, now: Long = System.currentTimeMillis()): String {
    if (ms == null || ms <= 0) return "—"
    val s = (now - ms) / 1000
    return when {
        s < 0 -> "à l’instant"
        s < 60 -> "il y a ${s} s"
        s < 3600 -> "il y a ${s / 60} min"
        s < 86400 -> "il y a ${s / 3600} h"
        else -> "il y a ${s / 86400} j"
    }
}

/** Epoch ms of an ISO-8601 instant, or null. */
fun isoMs(iso: String?): Long? = iso?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
