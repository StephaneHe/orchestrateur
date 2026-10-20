package com.orchestrateur.ui.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Réglages: version, langue de discussion (public/langue.js), fournisseur IA, palette, lecture audio. */
class SettingsLogicTest {
    @Test fun serverVersionAndRestartNotice() {
        val v = parseServerVersion(Json.parseToJsonElement("""{"version":"0.113.0","repoVersion":"0.114.0","restartRequired":true}"""))
        assertEquals("Serveur v0.113.0", serverVersionLine(v))
        assertEquals("⚠ redémarrage requis (dépôt v0.114.0)", restartNotice(v))
        val same = parseServerVersion(Json.parseToJsonElement("""{"version":"0.113.0","repoVersion":"0.113.0","restartRequired":false}"""))
        assertNull(restartNotice(same))
        assertEquals("Serveur : version non fournie", serverVersionLine(parseServerVersion(null)))
    }

    private val languageJson = """
        {"ok":true,"langs":{"fr":{"label":"Français"},"en":{"label":"English"},"es":{"label":"Español"}},
         "default":"en","projects":{"beta":"fr","alpha":"es"},"projectNames":["alpha","beta","chef"]}
    """.trimIndent()

    @Test fun parsesLanguageView() {
        val v = parseLanguage(Json.parseToJsonElement(languageJson))!!
        assertEquals(listOf("fr", "en", "es"), v.langs.map { it.first })
        assertEquals("English", v.label("en"))
        assertEquals("zz", v.label("zz"))
        assertEquals("en", v.default)
        assertEquals(listOf("alpha" to "es", "beta" to "fr"), v.exceptions)
        assertEquals(listOf("alpha", "beta", "chef"), v.projectNames)
        assertNull(parseLanguage(Json.parseToJsonElement("""{"error":"x"}""")))
    }

    @Test fun languageBodies() {
        val d = languageDefaultBody("fr")
        assertEquals("fr", d["default"]!!.jsonPrimitive.content)
        assertEquals("android", d["by"]!!.jsonPrimitive.content)
        val p = projectLanguageBody("es")
        assertEquals("es", p["lang"]!!.jsonPrimitive.content)
        assertEquals("android", p["by"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, projectLanguageBody(null)["lang"])
    }

    @Test fun providerFromConfigAndBody() {
        assertEquals("codex", providerOf(Json.parseToJsonElement("""{"defaults":{"provider":"codex"}}""")))
        assertEquals("claude", providerOf(Json.parseToJsonElement("""{"defaults":{}}""")))
        assertEquals("codex", providerBody("codex")["provider"]!!.jsonPrimitive.content)
        assertEquals(listOf("claude" to "CLAUDE", "codex" to "CODEX"), PROVIDERS)
    }

    @Test fun paletteLabels() {
        assertEquals(listOf("amber", "matrix", "ghost", "crimson"), PALETTE_LABELS.map { it.first })
        assertEquals("CINÉMA", PALETTE_LABELS.first().second)
    }

    @Test fun ttsRateSnapsAndFormats() {
        assertEquals(1.2f, snapRate(1.23f), 0.0001f)
        assertEquals(0.7f, snapRate(0.1f), 0.0001f)
        assertEquals(1.6f, snapRate(3f), 0.0001f)
        assertEquals("×1.0", rateLabel(1f))
        assertEquals("×1.3", rateLabel(1.3f))
        assertTrue(TTS_TEST_TEXT.startsWith("Bonjour."))
        assertFalse(TTS_TEST_TEXT.isBlank())
    }
}
