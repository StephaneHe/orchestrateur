package com.orchestrateur.ui.ops

import androidx.compose.runtime.Composable
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.SectionScaffold

@Composable
fun RegressionsScreen() {
    SectionScaffold("Non-régressions") { EmptyLine("à venir") }
}

/** Band of running (or just finished) non-regression runs; nothing when none. */
@Composable
fun RegressionBand() {}
