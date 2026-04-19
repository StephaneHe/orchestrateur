package com.phosphor.cockpit.auth

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import java.util.concurrent.Executor

/**
 * Thin wrapper around androidx.biometric. Returns one of three statuses:
 *  - AVAILABLE : fingerprint/face/PIN enrolled, prompt will work.
 *  - NONE_ENROLLED : user has no biometric set up — caller should fall
 *                    back to plain device credential (PIN).
 *  - UNSUPPORTED : hardware missing. Caller should hide biometric UI.
 */
object BiometricAuth {

    enum class Availability { AVAILABLE, NONE_ENROLLED, UNSUPPORTED }

    fun check(activity: FragmentActivity): Availability {
        val mgr = BiometricManager.from(activity)
        return when (mgr.canAuthenticate(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)) {
            BiometricManager.BIOMETRIC_SUCCESS -> Availability.AVAILABLE
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> Availability.NONE_ENROLLED
            else -> Availability.UNSUPPORTED
        }
    }

    /**
     * Show the biometric prompt. The `onSuccess` lambda is invoked on the
     * main thread when authentication completes. `onFail` is invoked for
     * any terminal failure (user cancel, lockout, etc.).
     */
    fun prompt(
        activity: FragmentActivity,
        title: String = "Unlock PHOSPHOR/03",
        subtitle: String = "Authenticate to access the orchestrator",
        onSuccess: () -> Unit,
        onFail: (String) -> Unit,
    ) {
        val executor: Executor = androidx.core.content.ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) = onSuccess()
                override fun onAuthenticationError(code: Int, msg: CharSequence) = onFail(msg.toString())
            }
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
            .build()
        prompt.authenticate(info)
    }
}
