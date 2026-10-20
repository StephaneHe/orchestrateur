package com.orchestrateur.ui.panels

import androidx.compose.runtime.Composable
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.SectionScaffold

@Composable
fun TodoScreen() {
    SectionScaffold("TODO") { EmptyLine("à venir") }
}
