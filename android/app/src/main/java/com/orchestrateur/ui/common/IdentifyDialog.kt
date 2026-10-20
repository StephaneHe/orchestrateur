package com.orchestrateur.ui.common

import androidx.compose.runtime.Composable

/** Overlay that explains an identifier (GET /api/identify). */
@Composable
fun IdentifyDialog(kind: String?, value: String, project: String?, onDismiss: () -> Unit) {
    ConfirmDialog(title = value, text = kind ?: "", onConfirm = {}, onDismiss = onDismiss)
}
