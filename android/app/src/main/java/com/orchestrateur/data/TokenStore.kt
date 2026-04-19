package com.orchestrateur.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Token + server URL kept in an EncryptedSharedPreferences file so that the
 * token at rest is wrapped with an Android KeyStore-backed AES key.
 * Biometric auth on top of this is a UX-level lock (BiometricPrompt), not an
 * additional encryption layer — but it prevents casual access to the app.
 */
class TokenStore(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "orchestre_secure",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var serverUrl: String?
        get() = prefs.getString("server_url", null)
        set(v) { prefs.edit().putString("server_url", v).apply() }

    var token: String?
        get() = prefs.getString("token", null)
        set(v) { prefs.edit().putString("token", v).apply() }

    fun isConfigured() = !serverUrl.isNullOrBlank() && !token.isNullOrBlank()

    fun clear() {
        prefs.edit().clear().apply()
    }
}
