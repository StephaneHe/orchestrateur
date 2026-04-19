package com.phosphor.cockpit.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.phosphor.cockpit.data.PanelSnapshot
import com.phosphor.cockpit.data.PanelState
import com.phosphor.cockpit.state.AppViewModel
import com.phosphor.cockpit.ui.theme.Phosphor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(
    vm: AppViewModel,
    onOpenTerminal: () -> Unit = {},
    onLogout: () -> Unit,
) {
    val state by vm.state.collectAsState()

    Scaffold(
        containerColor = Phosphor.Bg0,
        topBar = {
            FleetTopBar(
                onTerminal = onOpenTerminal,
                onRefresh = { vm.refreshFleet() },
                onLogout = onLogout,
                tailscale = state.tailscaleIp,
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { vm.openAddPicker() },
                containerColor = Phosphor.AccentPrimary,
                contentColor = Phosphor.Bg0,
                shape = RectangleShape,
            ) { Icon(Icons.Outlined.Add, "Add project") }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            if (state.panels.isEmpty() && state.loading) {
                Text("loading fleet…",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Phosphor.Fg2,
                    modifier = Modifier.align(Alignment.Center))
            } else if (state.panels.isEmpty()) {
                Text("fleet empty — tap + to add a project",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Phosphor.Fg2,
                    modifier = Modifier.align(Alignment.Center))
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(state.orderedPanels, key = { it.project.name }) { panel ->
                        PanelRow(
                            panel = panel,
                            onOpenSessionPicker = { vm.loadSessionsFor(panel.project.name) },
                            onRemove = { vm.removeProject(panel.project.name) },
                        )
                    }
                }
            }
            state.error?.let {
                Snackbar(Modifier.align(Alignment.BottomCenter).padding(12.dp)) {
                    Text(it, color = Phosphor.AlertError)
                }
            }
        }

        // Overlay sheets
        state.pickerProject?.let { SessionPickerSheet(vm) }
        if (state.showAddPicker) AddProjectSheet(vm)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FleetTopBar(
    onTerminal: () -> Unit,
    onRefresh: () -> Unit,
    onLogout: () -> Unit,
    tailscale: String?,
) {
    TopAppBar(
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = Phosphor.Bg0, titleContentColor = Phosphor.Fg0,
        ),
        title = {
            Column {
                Text("PHOSPHOR/03", style = MaterialTheme.typography.titleLarge)
                Text(
                    "FLEET · " + (tailscale ?: "localhost"),
                    style = MaterialTheme.typography.labelSmall, color = Phosphor.Fg2,
                )
            }
        },
        actions = {
            IconButton(onClick = onTerminal) {
                Icon(Icons.Outlined.Terminal, "Central terminal", tint = Phosphor.AccentPrimary)
            }
            IconButton(onClick = onRefresh) {
                Icon(Icons.Outlined.Refresh, "Refresh", tint = Phosphor.Fg1)
            }
            IconButton(onClick = onLogout) {
                Icon(Icons.AutoMirrored.Outlined.Logout, "Logout", tint = Phosphor.Fg1)
            }
        },
    )
}

@Composable
fun PanelRow(panel: PanelSnapshot, onOpenSessionPicker: () -> Unit, onRemove: () -> Unit) {
    val borderColor = when (panel.state) {
        PanelState.LIVE  -> Phosphor.AccentPrimary
        PanelState.INPUT -> Phosphor.AlertHot
        PanelState.DONE  -> Phosphor.AlertOk
        PanelState.ERROR -> Phosphor.AlertError
        PanelState.IDLE  -> Phosphor.Rule
    }
    val bg = when (panel.state) {
        PanelState.INPUT -> Phosphor.AlertHotBg.copy(alpha = 0.35f)
        PanelState.ERROR -> Phosphor.AlertErrorBg.copy(alpha = 0.35f)
        else -> Phosphor.Bg0
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(bg)
            .border(1.dp, Phosphor.Rule)
            .clickable { onOpenSessionPicker() }
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // Status dot
            Box(
                Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(borderColor),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                panel.project.name.uppercase(),
                style = MaterialTheme.typography.titleMedium,
                color = Phosphor.Fg0,
            )
            Spacer(Modifier.width(8.dp))
            Text(
                when (panel.state) {
                    PanelState.IDLE -> "IDLE"
                    PanelState.LIVE -> "LIVE"
                    PanelState.INPUT -> "NEEDS INPUT"
                    PanelState.DONE -> "DONE"
                    PanelState.ERROR -> "ERROR"
                },
                style = MaterialTheme.typography.labelSmall,
                color = borderColor,
            )
            Spacer(Modifier.weight(1f))
            // Attach chip
            val sid = panel.project.attachedSession
            if (sid != null) {
                ChipBadge(text = "SID " + sid.take(8), color = Phosphor.AccentSecondary)
            } else {
                ChipBadge(text = "+ attach", color = Phosphor.Fg2)
            }
        }
        Spacer(Modifier.height(6.dp))
        Row {
            Text(
                panel.activityVerb, color = Phosphor.AccentPrimary,
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.width(8.dp))
            Text(
                "· " + panel.activityNote,
                style = MaterialTheme.typography.bodySmall, color = Phosphor.Fg1,
                maxLines = 1,
            )
        }
        Spacer(Modifier.height(6.dp))
        Row {
            Text("model=${panel.project.model ?: "—"}  ·  ${panel.project.tools}",
                style = MaterialTheme.typography.labelSmall, color = Phosphor.Fg3)
            Spacer(Modifier.weight(1f))
            TextButton(
                onClick = onRemove,
                colors = ButtonDefaults.textButtonColors(contentColor = Phosphor.AlertError),
            ) { Text("REMOVE", style = MaterialTheme.typography.labelSmall) }
        }
    }
}

@Composable
private fun ChipBadge(text: String, color: Color) {
    Box(
        Modifier
            .border(1.dp, color)
            .padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall, color = color)
    }
}
