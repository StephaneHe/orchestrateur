package com.orchestrateur.ui.settings

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.BuildConfig
import com.orchestrateur.OrchestreApp
import com.orchestrateur.data.TextScale
import com.orchestrateur.data.getJson
import com.orchestrateur.data.postJson
import com.orchestrateur.data.putJson
import com.orchestrateur.data.enc
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.ConfirmDialog
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.Mono
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.SectionTitle
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.launch

/** Réglages (the dashboard's ⚙ panel): versions, language, provider, text size, palette, speech, server. */
@Composable
fun SettingsPlusScreen() {
    SectionScaffold("Réglages") {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            VersionsCard()
            LanguageCard()
            ProviderCard()
            DisplayCard()
            SpeechCard()
            ServerCard()
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Segments(options: List<Pair<String, String>>, selected: String?, enabled: Boolean = true, onPick: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        options.forEach { (value, label) ->
            val on = value == selected
            val shape = RoundedCornerShape(16.dp)
            Box(
                Modifier.heightIn(min = 44.dp).padding(vertical = 4.dp)
                    .background(if (on) Palette.Accent else Palette.Bg3, shape)
                    .border(1.dp, if (on) Palette.Accent else Palette.CardBorder, shape)
                    .then(if (enabled) Modifier.clickable { onPick(value) } else Modifier)
                    .padding(horizontal = 12.dp, vertical = 9.dp)
                    .semantics { contentDescription = label + if (on) " (choisi)" else "" },
                contentAlignment = Alignment.Center,
            ) { Text(label, color = if (on) Palette.Bg0 else Palette.Fg1, fontSize = 12.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal) }
        }
    }
}

/** Compact dropdown (a « select » of the web). */
@Composable
private fun Picker(label: String, options: List<Pair<String, String>>, selected: String?, modifier: Modifier = Modifier, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val shown = options.firstOrNull { it.first == selected }?.second ?: "—"
    Box(modifier) {
        Box(
            Modifier.fillMaxWidth().heightIn(min = 44.dp).border(1.dp, Palette.CardBorder, RoundedCornerShape(8.dp))
                .clickable { open = true }.padding(horizontal = 10.dp, vertical = 10.dp)
                .semantics { contentDescription = "$label : $shown" },
        ) { Text("$shown ▾", color = Palette.Fg0, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        DropdownMenu(open, { open = false }) {
            options.forEach { (v, l) -> DropdownMenuItem(text = { Text(l) }, onClick = { open = false; onPick(v) }) }
        }
    }
}

@Composable
private fun VersionsCard() {
    val env = LocalEnv.current
    val ver = rememberLoad { parseServerVersion(env.api.getJson("/api/version").orThrow().json) }
    SectionTitle("Versions")
    Card {
        Mono("Application ${BuildConfig.VERSION_NAME}", Palette.Fg1, 13)
        val v = ver.value
        when {
            v != null -> {
                Mono(serverVersionLine(v), Palette.Fg1, 13)
                restartNotice(v)?.let { Text(it, color = Palette.StInput, fontSize = 12.sp) }
            }
            ver.error != null -> Text("Serveur : ${ver.error}", color = Palette.Fg2, fontSize = 12.sp)
            else -> Text("Serveur : chargement…", color = Palette.Fg2, fontSize = 12.sp)
        }
    }
}

@Composable
private fun LanguageCard() {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    var view by remember { mutableStateOf<LanguageView?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    val load = rememberLoad {
        val r = env.api.getJson("/api/language")
        if (r.code == 404) error("Réglage disponible après le redémarrage du serveur (0.51.0).")
        parseLanguage(r.orThrow().json).also { view = it }
    }
    var addProject by remember { mutableStateOf<String?>(null) }
    var addLang by remember { mutableStateOf<String?>(null) }

    fun put(path: String, body: kotlinx.serialization.json.JsonObject, ok: (LanguageView) -> String) = scope.launch {
        val r = env.api.putJson(path, body)
        val nv = if (r.ok) parseLanguage(r.json) else null
        if (nv != null) { view = nv; note = ok(nv) } else note = "Échec : " + r.errorText()
    }

    SectionTitle("Langue de discussion (chef et musiciens)")
    Card {
        val v = view
        if (v == null) {
            Text(load.error?.let { "Réglage illisible : $it" } ?: "chargement…", color = Palette.Fg2, fontSize = 12.sp)
        } else {
        Text("Langue", color = Palette.Fg2, fontSize = 12.sp)
        Picker("Langue de discussion", v.langs, v.default) { code ->
            put("/api/language", languageDefaultBody(code)) { "✓ Langue de discussion : ${it.label(it.default)} — appliquée au prochain tour de chaque musicien." }
        }
        Text("Exception pour un projet", color = Palette.Fg0, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
        if (v.exceptions.isEmpty()) Text("aucune — tous les projets suivent la langue ci-dessus", color = Palette.Fg2, fontSize = 12.sp)
        v.exceptions.forEach { (p, l) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("$p → ${v.label(l)}", color = Palette.Fg1, fontSize = 13.sp, modifier = Modifier.weight(1f))
                Box(
                    Modifier.heightIn(min = 44.dp).clickable {
                        put("/api/language/project/${enc(p)}", projectLanguageBody(null)) { "✓ $p suit la langue globale" }
                    }.padding(horizontal = 14.dp, vertical = 10.dp).semantics { contentDescription = "Retirer l’exception de $p" },
                ) { Text("✕", color = Palette.Fg1, fontSize = 15.sp) }
            }
        }
        val proj = addProject ?: v.projectNames.firstOrNull()
        val lang = addLang ?: v.langs.first().first
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Picker("Projet", v.projectNames.map { it to it }, proj, Modifier.weight(1.3f)) { addProject = it }
            Picker("Langue du projet", v.langs, lang, Modifier.weight(1f)) { addLang = it }
        }
        PillButton("Appliquer", enabled = proj != null) {
            if (proj != null) put("/api/language/project/${enc(proj)}", projectLanguageBody(lang)) { "✓ $proj → ${it.label(lang)}" }
        }
        note?.let { Text(it, color = Palette.Fg1, fontSize = 12.sp) }
        }
    }
}

@Composable
private fun ProviderCard() {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    val load = rememberLoad { providerOf(env.api.getJson("/api/config").orThrow().json).also { current = it } }
    SectionTitle("Fournisseur IA")
    Card {
        if (current == null && load.error != null) Text("⚠ ${load.error}", color = Palette.Fg2, fontSize = 12.sp)
        Segments(PROVIDERS, current, enabled = current != null) { p ->
            scope.launch {
                val r = env.api.postJson("/api/config/provider", providerBody(p))
                if (r.ok) { current = p; note = "✓ Fournisseur par défaut : ${p.uppercase()}" } else note = "Échec : " + r.errorText()
            }
        }
        note?.let { Text(it, color = Palette.Fg1, fontSize = 12.sp) }
    }
}

@Composable
private fun DisplayCard() {
    val prefs = LocalEnv.current.prefs
    SectionTitle("Affichage")
    Card {
        Text("Taille du texte", color = Palette.Fg2, fontSize = 12.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            PillButton("A−", enabled = prefs.textScale > TextScale.STEPS.first()) { prefs.updateTextScale(TextScale.smaller(prefs.textScale)) }
            PillButton(TextScale.label(prefs.textScale)) { prefs.updateTextScale(1f) }
            PillButton("A+", enabled = prefs.textScale < TextScale.STEPS.last()) { prefs.updateTextScale(TextScale.bigger(prefs.textScale)) }
        }
        Text("Palette", color = Palette.Fg2, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
        Segments(PALETTE_LABELS, prefs.palette) { prefs.updatePalette(it) }
    }
}

@Composable
private fun SpeechCard() {
    val env = LocalEnv.current
    val prefs = env.prefs
    SectionTitle("Lecture audio (voix de l’appareil, locale)")
    Card {
        SwitchRow("Lecture audio activée", !prefs.ttsOff) { prefs.updateTtsOff(!it) }
        SwitchRow("Lire automatiquement les nouvelles réponses du chef", prefs.ttsAuto, enabled = !prefs.ttsOff) { prefs.updateTtsAuto(it) }
        Text("Vitesse ${rateLabel(prefs.ttsRate)}", color = Palette.Fg2, fontSize = 12.sp)
        Slider(
            value = prefs.ttsRate, onValueChange = { prefs.updateTtsRate(snapRate(it)) },
            valueRange = 0.7f..1.6f, steps = 8, enabled = !prefs.ttsOff,
            colors = SliderDefaults.colors(thumbColor = Palette.Accent, activeTrackColor = Palette.Accent),
            modifier = Modifier.semantics { contentDescription = "Vitesse de lecture" },
        )
        PillButton("▶ Tester la voix", enabled = !prefs.ttsOff) {
            if (env.tts.available) env.tts.speak("test", TTS_TEST_TEXT) else env.toast("Synthèse vocale indisponible sur cet appareil")
        }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).then(if (enabled) Modifier.clickable { onChange(!checked) } else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = if (enabled) Palette.Fg1 else Palette.Fg3, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Switch(checked, onChange, enabled = enabled, colors = SwitchDefaults.colors(checkedTrackColor = Palette.Accent))
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

@Composable
private fun ServerCard() {
    val env = LocalEnv.current
    val context = LocalContext.current
    val app = context.applicationContext as OrchestreApp
    var confirm by remember { mutableStateOf(false) }
    SectionTitle("Serveur")
    Card {
        Mono(app.serverStore.serverUrl ?: "non configuré", Palette.Fg1, 12)
        PillButton("Reconfigurer", color = Palette.StError) { confirm = true }
    }
    if (confirm) ConfirmDialog(
        title = "Reconfigurer le serveur",
        text = "L’adresse du serveur et le jeton enregistrés seront effacés, puis l’écran de connexion s’ouvrira.",
        confirm = "Reconfigurer",
        onConfirm = {
            app.serverStore.clear()
            val act = context.findActivity()
            if (act != null) act.recreate() else env.toast("Redémarrez l’application")
        },
        onDismiss = { confirm = false },
    )
}
