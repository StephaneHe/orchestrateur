package com.orchestrateur.ui.ops

import androidx.compose.runtime.Composable
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.SectionScaffold

@Composable
fun AutoAnswerScreen() {
    SectionScaffold("Réponse automatique") { EmptyLine("à venir") }
}

/** Compact band of automatic decisions for the notification dock (null height when nothing to show). */
@Composable
fun AutoAnswerBand() {}
