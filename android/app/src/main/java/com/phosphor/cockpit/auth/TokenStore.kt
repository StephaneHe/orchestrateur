package com.phosphor.cockpit.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * Server endpoint + its token. Persisted in EncryptedSharedPreferences —
 * the whole JSON blob is encrypted at rest (AES256_GCM under an
 * Android-Keystore-backed master key).
 */
@Serializable
data class Endpoint(
    val host: String,            // "name:port" or "ip:port"
    val token: String,           // 64-hex orchestrator token
    val label: String = "",      // optional human label
    val lastUsedAt: Long = 0L,   // epoch ms
    val lastStatus: String = "unknown",   // "online" / "offline" / "unknown"
)

class TokenStore(ctx: Context) {

    private val masterKey = MasterKey.Builder(ctx)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        ctx,
        "phosphor_secure_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private val json = Json { ignoreUnknownKeys = true }
    private val listSerializer = ListSerializer(Endpoint.serializer())

    fun endpoints(): List<Endpoint> {
        val raw = prefs.getString(KEY_ENDPOINTS, null) ?: return emptyList()
        return runCatching { json.decodeFromString(listSerializer, raw) }.getOrDefault(emptyList())
    }

    fun saveEndpoints(list: List<Endpoint>) {
        val raw = json.encodeToString(listSerializer, list)
        prefs.edit().putString(KEY_ENDPOINTS, raw).apply()
    }

    /**
     * Add the endpoint (or update its token/status/lastUsed if host already
     * exists) and mark it the current one. Returns the resulting list.
     */
    fun upsert(endpoint: Endpoint, markCurrent: Boolean = true): List<Endpoint> {
        val existing = endpoints().toMutableList()
        val i = existing.indexOfFirst { it.host == endpoint.host }
        val now = System.currentTimeMillis()
        val stamped = endpoint.copy(lastUsedAt = now, lastStatus = "online")
        if (i >= 0) existing[i] = stamped else existing.add(0, stamped)
        existing.sortByDescending { it.lastUsedAt }
        saveEndpoints(existing)
        if (markCurrent) currentHost = endpoint.host
        return existing
    }

    fun remove(host: String) {
        val list = endpoints().filter { it.host != host }
        saveEndpoints(list)
        if (currentHost == host) currentHost = null
    }

    fun markStatus(host: String, status: String) {
        val list = endpoints().map { if (it.host == host) it.copy(lastStatus = status) else it }
        saveEndpoints(list)
    }

    var currentHost: String?
        get() = prefs.getString(KEY_CURRENT, null)
        set(v) { prefs.edit().putString(KEY_CURRENT, v).apply() }

    fun current(): Endpoint? = currentHost?.let { h -> endpoints().firstOrNull { it.host == h } }

    fun hasAny(): Boolean = endpoints().isNotEmpty()

    fun clear() { prefs.edit().clear().apply() }

    companion object {
        private const val KEY_ENDPOINTS = "endpoints_v2"
        private const val KEY_CURRENT   = "current_host"
    }
}
