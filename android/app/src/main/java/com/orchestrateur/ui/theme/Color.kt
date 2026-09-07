package com.orchestrateur.ui.theme

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

    val Accent = Color(0xFFE8A15C)
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
