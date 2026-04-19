package com.orchestrateur.ui.login

import androidx.activity.compose.BackHandler
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.orchestrateur.data.TokenStore
import com.orchestrateur.ui.theme.Palette

sealed class LoginStep {
    data object Configure : LoginStep()           // first run: enter URL + token
    data object Unlock : LoginStep()              // stored token, biometric lock
    data object Ready : LoginStep()               // unlocked → show fleet
}

@Composable
fun LoginScreen(
    store: TokenStore,
    onUnlocked: () -> Unit,
) {
    val ctx = LocalContext.current
    val activity = ctx as FragmentActivity
    var step by remember { mutableStateOf(if (store.isConfigured()) LoginStep.Unlock else LoginStep.Configure) }

    when (step) {
        LoginStep.Configure -> ConfigurePanel(store) {
            step = LoginStep.Unlock
        }
        LoginStep.Unlock -> {
            UnlockPanel(
                onAuthSuccess = { step = LoginStep.Ready; onUnlocked() },
                onReconfigure = { store.clear(); step = LoginStep.Configure },
            )
            // Trigger BiometricPrompt immediately on entering this step.
            LaunchedEffect(Unit) {
                triggerBiometric(activity) { ok ->
                    if (ok) { step = LoginStep.Ready; onUnlocked() }
                }
            }
        }
        LoginStep.Ready -> Box(Modifier.fillMaxSize())  // handled by parent
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConfigurePanel(
    store: TokenStore,
    onConfigured: () -> Unit,
) {
    var url by remember { mutableStateOf(store.serverUrl ?: "http://100.64.0.10:7777") }
    var token by remember { mutableStateOf(store.token ?: "") }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier
            .fillMaxSize()
            .background(Palette.Bg0)
            .padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Orchestre", color = Palette.Accent, fontSize = 28.sp)
        Spacer(Modifier.height(4.dp))
        Text("salle de direction", color = Palette.Fg2, fontSize = 12.sp)
        Spacer(Modifier.height(32.dp))

        OutlinedTextField(
            value = url,
            onValueChange = { url = it; error = null },
            label = { Text("Adresse du serveur", color = Palette.Fg2) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = token,
            onValueChange = { token = it; error = null },
            label = { Text("Token (hex 64)", color = Palette.Fg2) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        error?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = Palette.StInput, fontSize = 12.sp)
        }
        Spacer(Modifier.height(24.dp))
        Button(
            onClick = {
                val u = url.trim().trimEnd('/')
                val t = token.trim()
                if (!u.startsWith("http")) { error = "URL doit commencer par http(s)://" ; return@Button }
                if (!t.matches(Regex("^[0-9a-f]{64}$"))) { error = "token invalide (64 hex)" ; return@Button }
                store.serverUrl = u
                store.token = t
                onConfigured()
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Enregistrer") }
    }
}

@Composable
private fun UnlockPanel(
    onAuthSuccess: () -> Unit,
    onReconfigure: () -> Unit,
) {
    val ctx = LocalContext.current
    val activity = ctx as FragmentActivity
    BackHandler { /* swallow back so the app doesn't exit mid-unlock */ }
    Column(
        Modifier
            .fillMaxSize()
            .background(Palette.Bg0)
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Orchestre", color = Palette.Accent, fontSize = 28.sp)
        Spacer(Modifier.height(4.dp))
        Text(
            "Identifie-toi pour continuer",
            color = Palette.Fg2,
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = {
            triggerBiometric(activity) { ok -> if (ok) onAuthSuccess() }
        }) { Text("Déverrouiller") }
        Spacer(Modifier.height(12.dp))
        TextButton(onClick = onReconfigure) {
            Text("Reconfigurer", color = Palette.Fg2)
        }
    }
}

private fun triggerBiometric(activity: FragmentActivity, onResult: (Boolean) -> Unit) {
    val bm = BiometricManager.from(activity)
    val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
        BiometricManager.Authenticators.DEVICE_CREDENTIAL
    if (bm.canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
        // Fallback: accept without biometric if device can't auth at all.
        onResult(true)
        return
    }
    val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                onResult(true)
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                onResult(false)
            }
        }
    )
    prompt.authenticate(
        BiometricPrompt.PromptInfo.Builder()
            .setTitle("Orchestre")
            .setSubtitle("Authentifie-toi pour accéder au dashboard")
            .setAllowedAuthenticators(authenticators)
            .build()
    )
}
