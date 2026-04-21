package com.orchestrateur.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Tiny HTTP helper around the orchestrator's REST endpoints.
 * Every call stamps `X-Orchestrator-Token` so the server's token gate
 * accepts us. The same token is also appended as `?token=` on SSE calls
 * (see FleetStream) because browsers can't send custom headers on
 * EventSource — our Android client has no such limitation, but keeping
 * the query-param path makes it interchangeable with the web dashboard.
 */
class Api(private val store: TokenStore) {

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)  // SSE: no read timeout
            .build()
    }

    val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun baseUrl(): String = store.serverUrl!!.trimEnd('/')
    fun token(): String = store.token!!

    private fun req(path: String): Request.Builder =
        Request.Builder()
            .url("${baseUrl()}$path")
            .header("X-Orchestrator-Token", token())
            .header("Cache-Control", "no-cache")

    fun http(): OkHttpClient = http

    suspend fun fetchConfig(): ConfigResponse = withContext(Dispatchers.IO) {
        http.newCall(req("/api/config").build()).execute().use { resp ->
            if (!resp.isSuccessful) error("config ${resp.code}")
            json.decodeFromString(ConfigResponse.serializer(), resp.body!!.string())
        }
    }

    suspend fun dispatch(project: String, prompt: String) = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("project", project)
            put("prompt", prompt)
        }
        val body = Json.encodeToString(payload).toRequestBody("application/json".toMediaType())
        http.newCall(
            req("/api/dispatch").post(body).header("Content-Type", "application/json").build()
        ).execute().use { resp ->
            if (!resp.isSuccessful) error("dispatch ${resp.code}: ${resp.body?.string()}")
        }
    }

    suspend fun markRead(project: String) = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("project", project)
            put("timestamp", java.time.Instant.now().toString())
        }
        val body = Json.encodeToString(payload).toRequestBody("application/json".toMediaType())
        runCatching {
            http.newCall(
                req("/api/mark-read").post(body).header("Content-Type", "application/json").build()
            ).execute().use { /* fire-and-forget */ }
        }
    }

    /** URL for the aggregate SSE stream. Query-string token lets the browser
     *  flow match, even though we always also send the header. */
    fun fleetSseUrl(): String = "${baseUrl()}/api/sse/fleet?token=${token()}"

    /** Lightweight health-check; used to verify token + server are reachable. */
    suspend fun healthz(): Boolean = withContext(Dispatchers.IO) {
        try {
            http.newCall(req("/healthz").build()).execute().use { it.isSuccessful }
        } catch (_: Exception) { false }
    }
}
