package com.orchestrateur.data

import android.content.Context

/**
 * Persists only the server URL. There is no token anymore: the fleet is reached
 * exclusively over Tailscale (WireGuard is the confidentiality + access layer),
 * and the server's token gate is disabled. Plain SharedPreferences is fine — the
 * URL is not a secret.
 */
class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences("orchestre", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = prefs.getString("server_url", null)
        set(v) { prefs.edit().putString("server_url", v).apply() }

    fun isConfigured() = !serverUrl.isNullOrBlank()

    fun clear() { prefs.edit().clear().apply() }
}
