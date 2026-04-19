package com.phosphor.cockpit.ui.theme

import androidx.compose.ui.graphics.Color

// PHOSPHOR/03 · MATRIX palette — the new default (see docs/Matrix-handoff/
// mobile-styles.css :root tokens).  Amber tokens are kept for contrast
// accents (glitch error / attest highlight) but no longer drive chrome.
object Phosphor {
    // Depth stack — phosphor-green-tinted dark field
    val Bg0 = Color(0xFF030705)       // deepest (true near-black)
    val Bg1 = Color(0xFF07110B)       // panel base
    val Bg2 = Color(0xFF0C1A11)       // raised
    val Bg3 = Color(0xFF122418)       // high

    val Rule = Color(0xFF143020)
    val RuleStrong = Color(0xFF1E4A30)

    val Fg0 = Color(0xFFD4EAD4)       // primary (warm phosphor white)
    val Fg1 = Color(0xFF7FB89A)       // secondary
    val Fg2 = Color(0xFF4A7A60)       // tertiary
    val Fg3 = Color(0xFF2A4A38)       // disabled / ghost

    val AccentPrimary = Color(0xFF2DFF7A)        // Matrix phosphor green
    val AccentPrimaryDim = Color(0xFF0FA24A)
    val AccentPrimaryBright = Color(0xFFBAFFC8)  // bright halo for glyphs
    val AccentSecondary = Color(0xFF5FD4FF)      // INFO / info chips
    val AccentSecondaryDim = Color(0xFF2A7A96)

    val AlertHot = Color(0xFFFF2D8B)             // NEEDS_USER_INPUT
    val AlertHotBg = Color(0xFF3B0A22)
    val AlertWarn = Color(0xFFFFD166)
    val AlertError = Color(0xFFFF3838)
    val AlertErrorBg = Color(0xFF2A0808)
    val AlertOk = Color(0xFF2DFF7A)              // same as primary — "OK" IS the phosphor green

    // CRT phosphor glow — applied as shadow on brand text / cursors
    val Glow = Color(0x592DFF7A)                 // 35% primary
}
