package com.orchestrateur.ui.ops

import androidx.compose.runtime.Composable
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.SectionScaffold

@Composable
fun PipelineRunsScreen() {
    SectionScaffold("Exécutions de pipeline") { EmptyLine("à venir") }
}

/** Choices of the paused pipeline run of [project] (buttons that answer the pause); nothing when none. */
@Composable
fun PauseChoices(project: String) {}
