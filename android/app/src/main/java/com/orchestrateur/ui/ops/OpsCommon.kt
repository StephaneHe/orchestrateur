package com.orchestrateur.ui.ops

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.ui.common.ConfirmDialog
import com.orchestrateur.ui.theme.Palette

/** One pending confirmation at a time (title, text, confirm label, action). */
@Stable
class ConfirmState {
    var pending by mutableStateOf<Ask?>(null)
    class Ask(val title: String, val text: String, val confirm: String, val action: () -> Unit)
    fun ask(title: String, text: String, confirm: String = "Confirmer", action: () -> Unit) { pending = Ask(title, text, confirm, action) }
}

@Composable
fun rememberConfirmState() = remember { ConfirmState() }

@Composable
fun ConfirmHost(s: ConfirmState) {
    val p = s.pending ?: return
    ConfirmDialog(p.title, p.text, confirm = p.confirm, onConfirm = p.action, onDismiss = { s.pending = null })
}

/** Underlined link-like text with a 44 dp touch target. */
@Composable
fun LinkText(text: String, onClick: () -> Unit) {
    Box(Modifier.heightIn(min = 44.dp).clickable { onClick() }.padding(vertical = 4.dp), contentAlignment = Alignment.CenterStart) {
        Text(text, color = Palette.StUnread, fontSize = 13.sp, textDecoration = TextDecoration.Underline)
    }
}

/** Thin progress bar (0..100). */
@Composable
fun PctBar(pct: Int, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(3.dp)
    Box(modifier.fillMaxWidth().height(6.dp).background(Palette.Bg3, shape)) {
        Box(Modifier.fillMaxWidth(pct.coerceIn(0, 100) / 100f).fillMaxHeight().background(Palette.Accent, shape))
    }
}
