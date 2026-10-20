package com.orchestrateur.ui.models

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.orchestrateur.ui.theme.Palette

/** Horizontally scrollable row of chips (top-level tabs, pipeline tabs). */
@Composable
fun ChipRow(items: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for ((id, label) in items) {
            val on = id == selected
            val shape = RoundedCornerShape(18.dp)
            Text(
                label, color = if (on) Palette.Bg0 else Palette.Fg1, fontSize = 13.sp, maxLines = 1,
                fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier.heightIn(min = 44.dp).padding(vertical = 4.dp)
                    .background(if (on) Palette.Accent else Color.Transparent, shape)
                    .border(1.dp, if (on) Palette.Accent else Palette.CardBorder, shape)
                    .clickable { onSelect(id) }.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }
}

/** Foldable block (the web's <details>). */
@Composable
fun Fold(title: String, key: String, initiallyOpen: Boolean = false, content: @Composable () -> Unit) {
    var open by rememberSaveable(key) { mutableStateOf(initiallyOpen) }
    Column {
        Text((if (open) "▾ " else "▸ ") + title, color = Palette.Fg1, fontSize = 13.sp,
            modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { open = !open }.padding(vertical = 12.dp))
        if (open) content()
    }
}

@Composable
fun Dim(text: String, color: Color = Palette.Fg2, size: Int = 12) {
    Text(text, color = color, fontSize = size.sp)
}

@Composable
fun Body(text: String, color: Color = Palette.Fg1, size: Int = 13, weight: FontWeight = FontWeight.Normal) {
    Text(text, color = color, fontSize = size.sp, fontWeight = weight)
}

val Warn = Color(0xFFFFB454)
val Ok = Color(0xFF8EDE9E)

/**
 * Field that opens the model list ([Menu]) in a dialog: the web's <select>,
 * with groups, disabled entries and the saved choice kept visible.
 */
@Composable
fun ModelPicker(label: String, menu: Menu, value: String, currentText: String, enabled: Boolean = true, hint: String? = null, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Dim(label, size = 11)
        Row(
            Modifier.fillMaxWidth().heightIn(min = 44.dp).border(1.dp, if (enabled) Palette.CardBorder else Palette.Fg3, shape)
                .background(Palette.Bg1, shape)
                .then(if (enabled) Modifier.clickable { open = true } else Modifier)
                .padding(horizontal = 10.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(currentText, color = when {
                !enabled -> Palette.Fg3
                currentText.startsWith("⚠") -> Warn
                value.isEmpty() -> Palette.Fg2
                else -> Palette.Fg0
            }, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text("▾", color = Palette.Fg2, fontSize = 13.sp)
        }
        if (!enabled && hint != null) Dim(hint, Palette.Fg3, 11)
    }
    if (open) ModelPickerDialog(label, menu, value, currentText, onDismiss = { open = false }) { v -> open = false; if (v != value) onPick(v) }
}

private sealed interface PickRow {
    data class Header(val g: MenuGroup) : PickRow
    data class Opt(val o: MenuOption, val enabled: Boolean) : PickRow
}

@Composable
private fun ModelPickerDialog(title: String, menu: Menu, value: String, currentText: String, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    var q by remember { mutableStateOf("") }
    val rows = remember(menu, q) {
        val needle = q.trim().lowercase()
        menu.groups.flatMap { g ->
            val opts = g.options.filter { needle.isEmpty() || it.label.lowercase().contains(needle) || it.value.lowercase().contains(needle) }
            if (needle.isNotEmpty() && opts.isEmpty()) emptyList()
            else listOf<PickRow>(PickRow.Header(g)) + opts.map { PickRow.Opt(it, !g.disabled && !it.disabled) }
        }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(color = Palette.Bg2, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 24.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(title, color = Palette.Fg0, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                if (menu.optionCount > 12) {
                    OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("Filtrer…") },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp))
                }
                LazyColumn(Modifier.weight(1f, fill = false)) {
                    item { PickLine(menu.emptyLabel, null, value.isEmpty(), true, false) { onPick("") } }
                    // A saved choice absent from the list (or retired) stays visible and selected.
                    if (value.isNotEmpty() && !menu.selectable(value)) item { PickLine(currentText, null, true, true, false) { onPick(value) } }
                    items(rows) { r ->
                        when (r) {
                            is PickRow.Header -> Text(r.g.label, color = if (r.g.disabled) Palette.Fg3 else Palette.Accent, fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 10.dp, bottom = 2.dp))
                            is PickRow.Opt -> PickLine(r.o.label, r.o.title, r.o.value == value, r.enabled, r.o.dominated) { onPick(r.o.value) }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("Annuler") }
                }
            }
        }
    }
}

@Composable
private fun PickLine(label: String, sub: String?, selected: Boolean, enabled: Boolean, dimmed: Boolean, onClick: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().heightIn(min = 44.dp)
            .background(if (selected) Palette.Bg3 else Color.Transparent, RoundedCornerShape(6.dp))
            .then(if (enabled) Modifier.clickable { onClick() } else Modifier)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        val c = when { !enabled -> Palette.Fg3; dimmed -> Palette.Fg2; else -> Palette.Fg0 }
        Text((if (selected) "● " else "") + label, color = if (label.startsWith("⚠")) Warn else c, fontSize = 13.sp)
        if (!sub.isNullOrBlank()) Text(sub, color = Palette.Fg3, fontSize = 11.sp)
    }
}
