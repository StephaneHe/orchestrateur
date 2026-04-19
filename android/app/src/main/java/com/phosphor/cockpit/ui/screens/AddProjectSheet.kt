package com.phosphor.cockpit.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.phosphor.cockpit.data.Candidate
import com.phosphor.cockpit.state.AppViewModel
import com.phosphor.cockpit.ui.theme.Phosphor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddProjectSheet(vm: AppViewModel) {
    val state by vm.state.collectAsState()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = { vm.closeAddPicker() },
        sheetState = sheetState,
        containerColor = Phosphor.Bg1,
        contentColor = Phosphor.Fg0,
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp).padding(bottom = 32.dp)) {
            Text("ADD PROJECT · " + state.addPickerRoot.ifEmpty { "I:\\Dev" },
                style = MaterialTheme.typography.titleLarge,
                color = Phosphor.AccentPrimary)
            Spacer(Modifier.height(8.dp))
            Text("${state.addPickerCandidates.size} directories not yet in the fleet",
                style = MaterialTheme.typography.labelSmall, color = Phosphor.Fg2)
            Spacer(Modifier.height(12.dp))

            if (state.addPickerLoading) {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Phosphor.AccentPrimary)
                }
            } else if (state.addPickerCandidates.isEmpty()) {
                Text("every directory under ${state.addPickerRoot} is already in the fleet",
                    color = Phosphor.Fg3, style = MaterialTheme.typography.bodySmall)
            } else {
                LazyColumn(Modifier.heightIn(max = 560.dp)) {
                    items(state.addPickerCandidates, key = { it.name }) { c ->
                        CandidateRow(c) { vm.addProject(c) }
                    }
                }
            }

            state.addPickerError?.let {
                Spacer(Modifier.height(8.dp))
                Text("error: $it", color = Phosphor.AlertError, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun CandidateRow(c: Candidate, onPick: () -> Unit) {
    val markers = listOfNotNull(
        "git".takeIf { c.hasGit },
        "CLAUDE.md".takeIf { c.hasClaudeMd },
        ".claude".takeIf { c.hasClaude },
    ).joinToString(" · ").ifEmpty { "—" }

    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onPick)
            .padding(vertical = 10.dp),
    ) {
        Row {
            Text(c.name,
                color = Phosphor.AccentSecondary,
                style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.weight(1f))
            Text(markers,
                color = Phosphor.AccentPrimary, style = MaterialTheme.typography.bodySmall)
        }
        Text(c.path,
            color = Phosphor.Fg2,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1)
    }
}
