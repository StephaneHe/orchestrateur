package com.orchestrateur.ui.settings

import com.orchestrateur.data.b
import com.orchestrateur.data.entries
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import com.orchestrateur.data.str
import com.orchestrateur.data.strs
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Pure logic of the Réglages screen (⚙ panel of the dashboard). */

data class ServerVersion(val version: String?, val repoVersion: String?, val restartRequired: Boolean)

fun parseServerVersion(json: JsonElement?) = ServerVersion(json.s("version"), json.s("repoVersion"), json.b("restartRequired"))

fun serverVersionLine(v: ServerVersion): String = v.version?.let { "Serveur v$it" } ?: "Serveur : version non fournie"

fun restartNotice(v: ServerVersion): String? =
    if (v.restartRequired) "⚠ redémarrage requis (dépôt v${v.repoVersion ?: "?"})" else null

// ---------- Langue de discussion (public/langue.js) ----------

data class LanguageView(
    val langs: List<Pair<String, String>>,
    val default: String,
    val exceptions: List<Pair<String, String>>,
    val projectNames: List<String>,
) {
    fun label(code: String): String = langs.firstOrNull { it.first == code }?.second ?: code
}

/** Null when the server answered without a language view (older than 0.51.0, or an error). */
fun parseLanguage(json: JsonElement?): LanguageView? {
    val langs = json.o("langs").entries.map { (k, v) -> k to (v.s("label") ?: k) }
    if (langs.isEmpty()) return null
    return LanguageView(
        langs = langs,
        default = json.s("default") ?: langs.first().first,
        exceptions = json.o("projects").entries.mapNotNull { (p, l) -> l.str?.let { p to it } }.sortedBy { it.first.lowercase() },
        projectNames = json.strs("projectNames"),
    )
}

fun languageDefaultBody(code: String): JsonObject = buildJsonObject { put("default", code); put("by", "android") }

/** `null` removes the project's exception (it follows the global language again). */
fun projectLanguageBody(lang: String?): JsonObject = buildJsonObject {
    if (lang == null) put("lang", JsonNull) else put("lang", lang)
    put("by", "android")
}

// ---------- Fournisseur IA ----------

val PROVIDERS = listOf("claude" to "CLAUDE", "codex" to "CODEX")

fun providerOf(config: JsonElement?): String = config.o("defaults").s("provider") ?: "claude"

fun providerBody(provider: String): JsonObject = buildJsonObject { put("provider", provider) }

// ---------- Palette ----------

/** App palette names (UiPrefs.PALETTES) with the dashboard's tweak labels. */
val PALETTE_LABELS = listOf("amber" to "CINÉMA", "matrix" to "MATRIX", "ghost" to "ENCRE", "crimson" to "CRAMOISI")

// ---------- Lecture audio (public/tts.js) ----------

const val TTS_TEST_TEXT = "Bonjour. Voici la voix qui lira les réponses du chef."

/** Slider value snapped to the web's 0.1 steps within 0.7–1.6. */
fun snapRate(v: Float): Float = (Math.round(v.coerceIn(0.7f, 1.6f) * 10f) / 10f)

fun rateLabel(v: Float): String = "×" + String.format(java.util.Locale.ROOT, "%.1f", v)
