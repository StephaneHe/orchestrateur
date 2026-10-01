package com.orchestrateur.data

import android.content.Context

/**
 * Persists the server URL and the optional dashboard token. The token is never
 * compiled into the app: the user pastes it in the configure screen, and it is
 * only sent when set (server token gate enabled). Private SharedPreferences is
 * the same trust boundary as the app's own data.
 */
class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences("orchestre", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = prefs.getString("server_url", null)
        set(v) { prefs.edit().putString("server_url", v).apply() }

    var token: String?
        get() = prefs.getString("token", null)
        set(v) { prefs.edit().putString("token", v?.takeIf { it.isNotBlank() }).apply() }

    fun isConfigured() = !serverUrl.isNullOrBlank()

    fun clear() { prefs.edit().clear().apply() }
}
