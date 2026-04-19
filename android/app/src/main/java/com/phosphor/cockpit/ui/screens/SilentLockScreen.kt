package com.phosphor.cockpit.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.fragment.app.FragmentActivity
import com.phosphor.cockpit.auth.BiometricAuth
import com.phosphor.cockpit.ui.theme.Phosphor
import kotlinx.coroutines.delay

/**
 * Matches the launcher icon:  >  █  ｦ
 * A phosphor-green chevron, a bright block cursor (blinking), and a
 * trailing katakana. Positioned top-left like a prompt at column 1.
 *
 * No text, no button, no UI hint. Tap (or long-press) anywhere fires
 * BiometricPrompt; success → login. Nothing else on screen.
 */
@Composable
fun SilentLockScreen(onUnlocked: () -> Unit) {
    val ctx = LocalContext.current
    val activity = ctx as? FragmentActivity
    val tryAuth: () -> Unit = tryAuth@{
        val act = activity ?: return@tryAuth onUnlocked()
        when (BiometricAuth.check(act)) {
            BiometricAuth.Availability.AVAILABLE,
            BiometricAuth.Availability.NONE_ENROLLED ->
                BiometricAuth.prompt(
                    act,
                    title = " ",
                    subtitle = " ",
                    onSuccess = { onUnlocked() },
                    onFail = { /* silent */ },
                )
            BiometricAuth.Availability.UNSUPPORTED -> onUnlocked()
        }
    }

    // Blinking block cursor.
    var cursorOn by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(520)
            cursorOn = !cursorOn
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { tryAuth() },
                    onLongPress = { tryAuth() },
                )
            },
        contentAlignment = Alignment.TopStart,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 16.dp, top = 44.dp),
        ) {
            // Prompt: steady chevron + blinking block cursor. No trailing
            // glyph — keeps the lockscreen spartan.
            Text(
                text = buildAnnotatedString {
                    withStyle(SpanStyle(color = Phosphor.AccentPrimary)) { append(">") }
                    append(" ")
                    withStyle(
                        SpanStyle(
                            color = if (cursorOn) Phosphor.AccentPrimaryBright
                                    else          Color.Transparent,
                        ),
                    ) { append("▋") }
                },
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                fontSize = 22.sp,
            )
        }
    }
}
