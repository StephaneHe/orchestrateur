package com.orchestrateur.data

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Local display preferences (same scope as the dashboard's localStorage):
 * text size, palette, speech, notification dock. Observable from Compose.
 */
class UiPrefs(context: Context) {
    private val p = context.getSharedPreferences("ui", Context.MODE_PRIVATE)

    var textScale by mutableStateOf(TextScale.clamp(p.getFloat("textScale", 1f)))
        private set
    var palette by mutableStateOf(p.getString("palette", PALETTES[0]) ?: PALETTES[0])
        private set
    var ttsAuto by mutableStateOf(p.getBoolean("ttsAuto", false))
        private set
    var ttsRate by mutableStateOf(p.getFloat("ttsRate", 1f))
        private set
    var ttsOff by mutableStateOf(p.getBoolean("ttsOff", false))
        private set
    var dockCollapsed by mutableStateOf(p.getBoolean("dockCollapsed", false))
        private set

    fun updateTextScale(v: Float) { textScale = TextScale.clamp(v); p.edit().putFloat("textScale", textScale).apply() }
    fun updatePalette(v: String) { if (v in PALETTES) { palette = v; p.edit().putString("palette", v).apply() } }
    fun updateTtsAuto(v: Boolean) { ttsAuto = v; p.edit().putBoolean("ttsAuto", v).apply() }
    fun updateTtsRate(v: Float) { ttsRate = v.coerceIn(0.7f, 1.6f); p.edit().putFloat("ttsRate", ttsRate).apply() }
    fun updateTtsOff(v: Boolean) { ttsOff = v; p.edit().putBoolean("ttsOff", v).apply() }
    fun updateDockCollapsed(v: Boolean) { dockCollapsed = v; p.edit().putBoolean("dockCollapsed", v).apply() }

    companion object {
        /** Same names as the web palettes (body[data-palette]). */
        val PALETTES = listOf("amber", "matrix", "ghost", "crimson")
    }
}

/** Text size steps of the dashboard (text-size.js): 85 … 150 %. */
object TextScale {
    val STEPS = listOf(0.85f, 0.9f, 1f, 1.1f, 1.25f, 1.5f)
    fun clamp(v: Float): Float = STEPS.minByOrNull { kotlin.math.abs(it - v) } ?: 1f
    fun bigger(v: Float): Float = STEPS.firstOrNull { it > v + 0.001f } ?: STEPS.last()
    fun smaller(v: Float): Float = STEPS.lastOrNull { it < v - 0.001f } ?: STEPS.first()
    fun label(v: Float): String = "${Math.round(v * 100)} %"
}
