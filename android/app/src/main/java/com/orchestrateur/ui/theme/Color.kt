package com.orchestrateur.ui.theme

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.Color

// Match the web cinematic palette so states read the same on both surfaces.
object Palette {
    val Bg0 = Color(0xFF0A0908)
    val Bg1 = Color(0xFF15110E)
    val Bg2 = Color(0xFF1E1814)
    val Bg3 = Color(0xFF2A2019)

    val Fg0 = Color(0xFFF5EFE5)
    val Fg1 = Color(0xFFC9BFAC)
    val Fg2 = Color(0xFF8D8576)
    val Fg3 = Color(0xFF56514A)

    // Palette-driven (amber default, matrix, ghost, crimson — same names as the web).
    val accentState = mutableStateOf(Color(0xFFE8A15C))
    val Accent: Color get() = accentState.value
    fun accentFor(palette: String): Color = when (palette) {
        "matrix" -> Color(0xFF6BFF8F)
        "ghost" -> Color(0xFFB9C7D6)
        "crimson" -> Color(0xFFFF5C6C)
        else -> Color(0xFFE8A15C)
    }
    val CardBg = Color(0xCC1E1814)        // 0.8 alpha
    val CardBorder = Color(0x29F5EFE5)     // 16% fg-0

    // State colors (aligned with --st-* in styles.css)
    val StIdle = Color(0xFF6B6358)
    val StLive = Color(0xFF8EDE9E)
    val StThink = Color(0xFFB8A0FF)
    val StInput = Color(0xFFFF2D8B)
    val StError = Color(0xFFE53535)
    val StUnread = Color(0xFF5FD4FF)
}
