package com.orchestrateur.ui.login

import android.util.Log
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.orchestrateur.data.ServerStore
import com.orchestrateur.ui.theme.Palette

sealed class LoginStep {
    data object Configure : LoginStep()           // first run: enter server URL
    data object Unlock : LoginStep()              // biometric app-open lock
    data object Ready : LoginStep()               // unlocked → show fleet
}

@Composable
fun LoginScreen(
    store: ServerStore,
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
            var statusMsg by remember { mutableStateOf<String?>(null) }
            // One shared entry point: used by both the auto-trigger and the button,
            // so success routing and feedback are identical either way.
            val runAuth: () -> Unit = {
                statusMsg = null
                triggerBiometric(
                    activity,
                    onSuccess = { step = LoginStep.Ready; onUnlocked() },
                    onFail = { m -> statusMsg = m },
                    onError = { m -> statusMsg = m.ifBlank { null } },
                )
            }
            UnlockPanel(
                statusMessage = statusMsg,
                onUnlockClick = runAuth,
                onReconfigure = { store.clear(); step = LoginStep.Configure },
            )
            // Trigger BiometricPrompt immediately on entering this step.
            LaunchedEffect(Unit) { runAuth() }
        }
        LoginStep.Ready -> Box(Modifier.fillMaxSize())  // handled by parent
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConfigurePanel(
    store: ServerStore,
    onConfigured: () -> Unit,
) {
    var url by remember { mutableStateOf(store.serverUrl ?: "http://myhost:7777") }
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
        Text("salle de direction · accès Tailscale", color = Palette.Fg2, fontSize = 12.sp)
        Spacer(Modifier.height(32.dp))

        OutlinedTextField(
            value = url,
            onValueChange = { url = it; error = null },
            label = { Text("Adresse du serveur", color = Palette.Fg2) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        error?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = Palette.StInput, fontSize = 12.sp)
        }
        Spacer(Modifier.height(24.dp))
        Button(
            onClick = {
                val u = url.trim().trimEnd('/')
                if (!u.startsWith("http")) { error = "URL doit commencer par http(s)://" ; return@Button }
                store.serverUrl = u
                onConfigured()
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Enregistrer") }
    }
}

@Composable
private fun UnlockPanel(
    statusMessage: String?,
    onUnlockClick: () -> Unit,
    onReconfigure: () -> Unit,
) {
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
        Button(onClick = onUnlockClick) { Text("Déverrouiller") }
        // Feedback on a failed / not-recognized fingerprint or a sensor error,
        // so the user never faces a silent "nothing happens".
        statusMessage?.let {
            Spacer(Modifier.height(16.dp))
            Text(
                it,
                color = Palette.StInput,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
            )
        }
        Spacer(Modifier.height(12.dp))
        TextButton(onClick = onReconfigure) {
            Text("Reconfigurer", color = Palette.Fg2)
        }
    }
}

private const val BIO_TAG = "OrchBiometric"

/**
 * Launch the system BiometricPrompt.
 *
 * Config is deliberately BIOMETRIC_STRONG + an explicit negative button — the
 * canonical, most reliable combo. The previous code requested
 * BIOMETRIC_STRONG | DEVICE_CREDENTIAL: mixing DEVICE_CREDENTIAL with a negative
 * button is illegal, and on some OEM sensors (this device: MTK/sunwave) the combo
 * made the prompt scan yet never deliver a result when a finger was placed. We
 * also surface every callback (success / fail / error) both to logcat and, via the
 * caller, to the UI so a placed finger can never silently do nothing.
 *
 * @param onSuccess  finger recognized → caller unlocks and navigates.
 * @param onFail     finger read but NOT recognized (prompt stays open) → show a hint.
 * @param onError    terminal error or user cancel; empty string ⇒ user canceled (no nag).
 */
private fun triggerBiometric(
    activity: FragmentActivity,
    onSuccess: () -> Unit,
    onFail: (String) -> Unit,
    onError: (String) -> Unit,
) {
    val bm = BiometricManager.from(activity)
    val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG
    val can = bm.canAuthenticate(authenticators)
    Log.i(BIO_TAG, "canAuthenticate(BIOMETRIC_STRONG) = $can")
    if (can != BiometricManager.BIOMETRIC_SUCCESS) {
        // No usable strong biometric. Do NOT silently bypass the lock — say why.
        val msg = when (can) {
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
                "Aucune empreinte enrôlée sur l'appareil (Réglages → Sécurité)."
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE ->
                "Pas de capteur biométrique sur cet appareil."
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE ->
                "Capteur biométrique momentanément indisponible."
            else -> "Biométrie indisponible (code $can)."
        }
        onError(msg)
        return
    }
    val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                Log.i(BIO_TAG, "onAuthenticationSucceeded type=${result.authenticationType}")
                onSuccess()
            }
            override fun onAuthenticationFailed() {
                // Fired when a finger is read but not matched; prompt stays open.
                Log.w(BIO_TAG, "onAuthenticationFailed (finger not recognized)")
                onFail("Empreinte non reconnue, réessayez.")
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                Log.w(BIO_TAG, "onAuthenticationError code=$errorCode msg=$errString")
                val userCanceled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    errorCode == BiometricPrompt.ERROR_CANCELED
                onError(if (userCanceled) "" else "Erreur biométrie ($errorCode) : $errString")
            }
        }
    )
    prompt.authenticate(
        BiometricPrompt.PromptInfo.Builder()
            .setTitle("Orchestre")
            .setSubtitle("Authentifie-toi pour accéder au dashboard")
            .setAllowedAuthenticators(authenticators)
            .setNegativeButtonText("Annuler")
            .setConfirmationRequired(false)
            .build()
    )
}
