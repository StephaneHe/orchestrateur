package com.phosphor.cockpit.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Shipping the PHOSPHOR aesthetic on mobile without bundling Chakra Petch/
// JetBrains Mono TTF files into the APK (saves 180 KB · adds later if you
// want exact match). Monospace fallback is Android's default.
// If you want the fonts: add res/font/chakra_petch_regular.ttf + jetbrains_mono.ttf
// and switch to FontFamily(Font(R.font.chakra_petch_regular), …).
val UiFamily = FontFamily.SansSerif       // Chakra Petch substitute
val MonoFamily = FontFamily.Monospace     // JetBrains Mono substitute

val PhosphorTypography = Typography(
    displayLarge  = TextStyle(fontFamily = UiFamily,   fontSize = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 3.sp),
    titleLarge    = TextStyle(fontFamily = UiFamily,   fontSize = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 2.sp),
    titleMedium   = TextStyle(fontFamily = UiFamily,   fontSize = 14.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.5.sp),
    labelLarge    = TextStyle(fontFamily = UiFamily,   fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 2.sp),
    labelMedium   = TextStyle(fontFamily = UiFamily,   fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 2.sp),
    labelSmall    = TextStyle(fontFamily = UiFamily,   fontSize = 9.sp,  fontWeight = FontWeight.SemiBold, letterSpacing = 2.5.sp),
    bodyLarge     = TextStyle(fontFamily = MonoFamily, fontSize = 14.sp),
    bodyMedium    = TextStyle(fontFamily = MonoFamily, fontSize = 12.sp),
    bodySmall     = TextStyle(fontFamily = MonoFamily, fontSize = 11.sp),
)
