package com.phosphor.cockpit.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Send
import androidx.compose.material.icons.outlined.DeleteSweep
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.phosphor.cockpit.state.AppViewModel
import com.phosphor.cockpit.ui.theme.Phosphor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(vm: AppViewModel, onBack: () -> Unit) {
    val state by vm.state.collectAsState()

    // Open the pty stream while on this screen; close on leave.
    DisposableEffect(Unit) {
        vm.enterTerminal()
        onDispose { vm.leaveTerminal() }
    }

    var input by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    // Autoscroll on new output.
    LaunchedEffect(state.terminalLines.size) {
        if (state.terminalLines.isNotEmpty()) {
            listState.animateScrollToItem(state.terminalLines.lastIndex)
        }
    }

    Scaffold(
        containerColor = Phosphor.Bg0,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Phosphor.Bg0, titleContentColor = Phosphor.Fg0,
                ),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back", tint = Phosphor.Fg1)
                    }
                },
                title = {
                    Column {
                        Text("COMMANDER", style = MaterialTheme.typography.titleLarge)
                        Text(
                            "CENTRAL SESSION · attached",
                            style = MaterialTheme.typography.labelSmall,
                            color = Phosphor.AccentPrimary,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { vm.clearTerminal() }) {
                        Icon(Icons.Outlined.DeleteSweep, "Clear", tint = Phosphor.Fg1)
                    }
                },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {

            // ---- Output area ----
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) {
                if (state.terminalLines.isEmpty() && state.terminalTail.isEmpty()) {
                    Text(
                        "[awaiting central…]",
                        color = Phosphor.Fg3,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        modifier = Modifier.align(Alignment.Center),
                    )
                } else {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(0.dp),
                    ) {
                        items(state.terminalLines) { line ->
                            TerminalLine(line)
                        }
                        if (state.terminalTail.isNotEmpty()) {
                            item { TerminalLine(state.terminalTail + " ▋") }
                        }
                    }
                }
            }

            // ---- Quick-action row ----
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 10.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                listOf(
                    "/status", "/help", "y", "n", "d",
                    "↵ enter",  // sends an empty newline — useful for prompts
                    "^C", "^D",
                ).forEach { cmd ->
                    QuickChip(cmd) {
                        when (cmd) {
                            "↵ enter" -> vm.sendTerminalInput("", appendNewline = true)
                            "^C"      -> vm.sendTerminalInput("\u0003", appendNewline = false)
                            "^D"      -> vm.sendTerminalInput("\u0004", appendNewline = false)
                            else      -> vm.sendTerminalInput(cmd)
                        }
                    }
                }
            }

            // ---- Prompt input ----
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "▸ ",
                    color = Phosphor.AccentPrimary,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp,
                )
                Box(
                    Modifier
                        .weight(1f)
                        .border(1.dp, Phosphor.Rule)
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                ) {
                    if (input.isEmpty()) {
                        Text(
                            "command or message…",
                            color = Phosphor.Fg3,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp,
                        )
                    }
                    BasicTextField(
                        value = input,
                        onValueChange = { input = it },
                        singleLine = true,
                        textStyle = TextStyle(
                            color = Phosphor.Fg0,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp,
                        ),
                        cursorBrush = SolidColor(Phosphor.AccentPrimary),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = androidx.compose.ui.text.input.KeyboardType.Ascii,
                            imeAction = ImeAction.Send,
                            capitalization = KeyboardCapitalization.None,
                            autoCorrect = false,
                        ),
                        keyboardActions = KeyboardActions(
                            onSend = {
                                vm.sendTerminalInput(input)
                                input = ""
                            },
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Spacer(Modifier.width(8.dp))
                IconButton(
                    enabled = input.isNotEmpty(),
                    onClick = {
                        vm.sendTerminalInput(input)
                        input = ""
                    },
                ) {
                    Icon(
                        Icons.Outlined.Send, "Send",
                        tint = if (input.isNotEmpty()) Phosphor.AccentPrimary else Phosphor.Fg3,
                    )
                }
            }
        }
    }
}

@Composable
private fun TerminalLine(text: String) {
    val color = when {
        text.startsWith("> ")           -> Phosphor.AccentPrimary       // echoed user input
        text.startsWith("[")            -> Phosphor.Fg2                 // meta ([attached], [connecting], [link lost])
        text.startsWith("//")           -> Phosphor.Fg2
        text.contains("error", true)    -> Phosphor.AlertError
        text.contains("fail", true)     -> Phosphor.AlertError
        else                            -> Phosphor.Fg0
    }
    Text(
        text = text.ifEmpty { " " },
        color = color,
        fontFamily = FontFamily.Monospace,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    )
}

@Composable
private fun QuickChip(label: String, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Phosphor.AccentPrimary),
        border = androidx.compose.foundation.BorderStroke(1.dp, Phosphor.Rule),
    ) {
        Text(label, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
    }
}
