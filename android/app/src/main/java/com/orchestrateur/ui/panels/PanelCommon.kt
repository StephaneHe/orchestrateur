package com.orchestrateur.ui.panels

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.orchestrateur.ui.theme.Palette

/** Choices of the panels kept across launches (the web keeps them in localStorage). */
class PanelPrefs(context: Context) {
    private val p = context.getSharedPreferences("panels", Context.MODE_PRIVATE)
    fun get(k: String): String = p.getString(k, "") ?: ""
    fun set(k: String, v: String) { p.edit().putString(k, v).apply() }
}

@Composable
fun rememberPanelPrefs(): PanelPrefs {
    val ctx = LocalContext.current
    return remember { PanelPrefs(ctx.applicationContext) }
}

/** A remembered string preference, observable from Compose. */
@Composable
fun rememberPref(prefs: PanelPrefs, key: String): Pair<String, (String) -> Unit> {
    var v by remember { mutableStateOf(prefs.get(key)) }
    return v to { nv: String -> v = nv; prefs.set(key, nv) }
}

data class PickerOption(val value: String, val label: String, val enabled: Boolean = true)

/** "<label> [current ▾]" with a menu; disabled options are listed but not selectable. */
@Composable
fun Picker(label: String, current: String, options: List<PickerOption>, onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    val shown = options.firstOrNull { it.value == current }?.label ?: current.ifEmpty { "—" }
    Row(modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Palette.Fg2, fontSize = 12.sp, modifier = Modifier.padding(end = 8.dp))
        Box {
            Box(
                Modifier.heightIn(min = 44.dp).border(1.dp, Palette.CardBorder, RoundedCornerShape(8.dp))
                    .clickable(enabled = options.isNotEmpty()) { open = true }.padding(horizontal = 12.dp, vertical = 11.dp),
            ) { Text("$shown ▾", color = Palette.Fg0, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            DropdownMenu(open, onDismissRequest = { open = false }) {
                for (o in options) DropdownMenuItem(
                    text = { Text(o.label, color = if (o.enabled) Palette.Fg0 else Palette.Fg3) },
                    enabled = o.enabled,
                    onClick = { open = false; onPick(o.value) },
                )
            }
        }
    }
}

/** Near full-screen window with a title, ✕, a scrolling body and an optional fixed footer. */
@Composable
fun PanelDialog(
    title: String,
    onDismiss: () -> Unit,
    footer: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val shape = RoundedCornerShape(12.dp)
        Column(
            Modifier.fillMaxWidth(0.96f).fillMaxHeight(0.92f).background(Palette.Bg1, shape).border(1.dp, Palette.CardBorder, shape),
        ) {
            Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(title, color = Palette.Fg0, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Box(Modifier.heightIn(min = 44.dp).clickable { onDismiss() }.padding(14.dp)) { Text("✕", color = Palette.Fg1, fontSize = 16.sp) }
            }
            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
                content = content,
            )
            if (footer != null) Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp), content = footer)
        }
    }
}

/** Small label: value row of a detail window. */
@Composable
fun KeyValue(k: String, v: String, valueColor: Color = Palette.Fg0) {
    Row {
        Text(k, color = Palette.Fg2, fontSize = 12.sp, modifier = Modifier.fillMaxWidth(0.28f).padding(end = 8.dp))
        Text(v, color = valueColor, fontSize = 13.sp, modifier = Modifier.weight(1f))
    }
}

@Composable
fun SubHeading(text: String) {
    Text(text, color = Palette.Fg2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
}

/** Colour of a request task tone (side-panel.css --tone). */
fun toneColor(tone: String): Color = when (tone) {
    "ok" -> Palette.StLive
    "live" -> Palette.StUnread
    "input" -> Palette.StInput
    "wait" -> Palette.StIdle
    "chef" -> Palette.StThink
    "bad" -> Palette.StError
    else -> Palette.Fg3
}
