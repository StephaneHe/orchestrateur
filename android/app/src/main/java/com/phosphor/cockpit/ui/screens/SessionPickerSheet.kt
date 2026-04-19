package com.phosphor.cockpit.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.phosphor.cockpit.data.ClaudeSession
import com.phosphor.cockpit.state.AppViewModel
import com.phosphor.cockpit.ui.theme.Phosphor
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionPickerSheet(vm: AppViewModel) {
    val state by vm.state.collectAsState()
    val project = state.pickerProject ?: return
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()

    ModalBottomSheet(
        onDismissRequest = { vm.closePicker() },
        sheetState = sheetState,
        containerColor = Phosphor.Bg1,
        contentColor = Phosphor.Fg0,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 32.dp),
        ) {
            Text(
                "SESSION · $project",
                style = MaterialTheme.typography.titleLarge,
                color = Phosphor.AccentPrimary,
            )
            Spacer(Modifier.height(8.dp))
            Meta("path", state.pickerProjectPath ?: "—")
            Meta("claude dir", state.pickerEncodedDir ?: "—")
            val attached = state.pickerAttached
            Row(verticalAlignment = Alignment.CenterVertically) {
                Meta("attached", attached ?: "none · next dispatch creates a new session", mono = attached != null)
                if (attached != null) {
                    Spacer(Modifier.width(10.dp))
                    OutlinedButton(
                        onClick = { scope.launch { sheetState.hide(); vm.detach(project) } },
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Phosphor.AlertError),
                    ) { Text("DETACH", style = MaterialTheme.typography.labelSmall) }
                }
            }

            Spacer(Modifier.height(12.dp))
            Text(
                "${state.pickerSessions.size} sessions · tap to attach",
                color = Phosphor.Fg2, style = MaterialTheme.typography.labelSmall,
            )

            if (state.pickerLoading) {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Phosphor.AccentPrimary)
                }
            } else if (state.pickerSessions.isEmpty()) {
                Text("no sessions found for this cwd",
                    modifier = Modifier.padding(vertical = 20.dp),
                    color = Phosphor.Fg3,
                    style = MaterialTheme.typography.bodySmall)
            } else {
                LazyColumn(Modifier.heightIn(max = 480.dp)) {
                    items(state.pickerSessions, key = { it.id }) { s ->
                        SessionRow(s, isCurrent = s.id == attached) {
                            scope.launch { sheetState.hide(); vm.attach(project, s.id) }
                        }
                    }
                }
            }

            state.pickerError?.let {
                Spacer(Modifier.height(8.dp))
                Text("error: $it", color = Phosphor.AlertError, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun Meta(label: String, value: String, mono: Boolean = false) {
    Row(Modifier.padding(vertical = 2.dp)) {
        Text(label.uppercase(),
            color = Phosphor.Fg3,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.width(90.dp))
        Text(
            value,
            color = Phosphor.Fg0,
            style = if (mono) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun SessionRow(s: ClaudeSession, isCurrent: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 8.dp)
            .then(if (isCurrent) Modifier.background(Phosphor.AccentSecondaryDim.copy(alpha = 0.15f)) else Modifier)
            .padding(8.dp),
    ) {
        Row {
            Text(s.id.take(8),
                color = Phosphor.AccentSecondary,
                style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.width(10.dp))
            Text(s.gitBranch ?: "—",
                color = Phosphor.AccentPrimary, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.weight(1f))
            Text(relTime(s.mtime),
                color = Phosphor.Fg2, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(4.dp))
        Text(s.preview ?: "(no user message yet)",
            color = Phosphor.Fg1,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 2)
    }
}

private fun relTime(mtime: Double): String {
    val d = System.currentTimeMillis() - mtime.toLong()
    val s = d / 1000
    return when {
        s < 60 -> "${s}s ago"
        s < 3600 -> "${s / 60}m ago"
        s < 3600 * 48 -> "${s / 3600}h ago"
        else -> "${s / 86400}d ago"
    }
}
