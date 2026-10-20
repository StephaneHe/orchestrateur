package com.orchestrateur.ui.models

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.SectionScaffold
import kotlinx.coroutines.delay

/**
 * « ⇄ Models » (public/models.js): models per pipeline step, suggestions,
 * health of the pipeline service, observation, gaps, API keys, model languages.
 */
@Composable
fun ModelsScreen() {
    val env = LocalEnv.current
    val st = remember { ModelsState() }
    var tab by rememberSaveable { mutableStateOf("steps") }
    LaunchedEffect(Unit) {
        st.load(env.api, refresh = false)
        // Keeps the « ⚑ Lacunes (n) » count fresh, like the web pill.
        while (true) { st.loadGaps(env.api); delay(60_000) }
    }
    val r = st.routing
    val saving = st.status.values.any { it.kind == "saving" }
    val subtitle = r?.let {
        summaryText(it) + (if (saving) " · enregistrement…" else " · tout est enregistré") +
            (it.updatedAt?.let { u -> " · dernier enregistrement ${fmtTime(u)}" } ?: "")
    }
    SectionScaffold("Models", subtitle = subtitle) {
        val nGaps = st.gaps?.open?.size ?: 0
        ChipRow(
            listOf(
                "steps" to "Étapes",
                "health" to "📈 Mise en service",
                "observe" to "Observation",
                "gaps" to if (nGaps > 0) "⚑ Lacunes ($nGaps)" else "Lacunes",
                "keys" to "🔑 Clés API",
                "langs" to "🌐 Langues",
            ),
            tab,
        ) { tab = it }
        when (tab) {
            "steps" -> StepsTab(st)
            "health" -> HealthTab()
            "observe" -> ObserveTab(st)
            "gaps" -> GapsTab(st) { tab = "steps" }
            "keys" -> KeysTab(st)
            "langs" -> LangsTab()
        }
    }
}
