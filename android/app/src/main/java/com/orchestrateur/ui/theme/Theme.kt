package com.orchestrateur.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density

/**
 * Always dark (cinematic palette). [textScale] multiplies the system font
 * scale (dashboard's A− / A / A+); [palette] picks the accent colour.
 */
@Composable
fun OrchestreTheme(textScale: Float = 1f, palette: String = "amber", content: @Composable () -> Unit) {
    val accent = Palette.accentFor(palette)
    SideEffect { if (Palette.accentState.value != accent) Palette.accentState.value = accent }
    val scheme = darkColorScheme(
        primary = accent,
        onPrimary = Palette.Bg0,
        background = Palette.Bg0,
        onBackground = Palette.Fg0,
        surface = Palette.Bg1,
        onSurface = Palette.Fg0,
        surfaceVariant = Palette.Bg2,
        onSurfaceVariant = Palette.Fg1,
        outline = Palette.CardBorder,
    )
    val d = LocalDensity.current
    CompositionLocalProvider(LocalDensity provides Density(d.density, d.fontScale * textScale)) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
