package com.orchestrateur.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val Scheme = darkColorScheme(
    primary = Palette.Accent,
    onPrimary = Palette.Bg0,
    background = Palette.Bg0,
    onBackground = Palette.Fg0,
    surface = Palette.Bg1,
    onSurface = Palette.Fg0,
    surfaceVariant = Palette.Bg2,
    onSurfaceVariant = Palette.Fg1,
    outline = Palette.CardBorder,
)

@Composable
fun OrchestreTheme(content: @Composable () -> Unit) {
    // Always dark — the UI is built for a cinematic palette.
    @Suppress("UNUSED_EXPRESSION") isSystemInDarkTheme()
    MaterialTheme(colorScheme = Scheme, content = content)
}
