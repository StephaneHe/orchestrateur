package com.phosphor.cockpit.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val PhosphorColors = darkColorScheme(
    primary           = Phosphor.AccentPrimary,
    onPrimary         = Phosphor.Bg0,
    secondary         = Phosphor.AccentSecondary,
    onSecondary       = Phosphor.Bg0,
    tertiary          = Phosphor.AlertHot,
    onTertiary        = Phosphor.Bg0,
    error             = Phosphor.AlertError,
    onError           = Phosphor.Bg0,
    background        = Phosphor.Bg0,
    onBackground      = Phosphor.Fg0,
    surface           = Phosphor.Bg1,
    onSurface         = Phosphor.Fg0,
    surfaceVariant    = Phosphor.Bg2,
    onSurfaceVariant  = Phosphor.Fg1,
    outline           = Phosphor.Rule,
    outlineVariant    = Phosphor.RuleStrong,
)

@Composable
fun PhosphorTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),  // unused — theme is always dark
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = PhosphorColors,
        typography  = PhosphorTypography,
        content     = content,
    )
}
