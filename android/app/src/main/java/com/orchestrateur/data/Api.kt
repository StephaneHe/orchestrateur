package com.orchestrateur.data

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source
import java.util.concurrent.TimeUnit

/**
 * Tiny HTTP helper around the orchestrator's REST endpoints. No auth: the fleet
 * is reached only over Tailscale and the server's token gate is disabled, so no
 * token header or query param is ever sent.
 */
class Api(private val store: ServerStore) {

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            // SSE read timeout: server pings every 15s, so any silence
            // > 45s = the connection is dead. Without this guard, OkHttp
            // would keep a zombie socket alive forever (Tailscale half-
            // close, NAT timeout, battery saver suspending sockets etc.)
            // and the server side would still try to push events into it,
            // which previously crashed the server (29 avr.).
            .readTimeout(45, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)  // TCP-level keep-alive
            .build()
    }

    val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun baseUrl(): String =
        (store.serverUrl ?: error("serveur non configuré")).trimEnd('/')

    private fun req(path: String): Request.Builder =
        Request.Builder()
            .url("${baseUrl()}$path")
            .header("Cache-Control", "no-cache")

    fun http(): OkHttpClient = http

    suspend fun fetchConfig(): ConfigResponse = withContext(Dispatchers.IO) {
        http.newCall(req("/api/config").build()).execute().use { resp ->
            if (!resp.isSuccessful) error("config ${resp.code}")
            json.decodeFromString(ConfigResponse.serializer(), resp.body!!.string())
        }
    }

    /** Last N conductor chat messages (user + conductor bubbles). */
    suspend fun fetchConductorChat(n: Int = 60): List<ConductorChatEntry> = withContext(Dispatchers.IO) {
        try {
            http.newCall(req("/api/conductor-chat?n=$n").build()).execute().use { resp ->
                if (!resp.isSuccessful) emptyList()
                else json.decodeFromString(ListSerializer(ConductorChatEntry.serializer()), resp.body!!.string())
            }
        } catch (_: Exception) { emptyList() }
    }

    /** Last N raw stream-json events for a project (for hydrating the ring). */
    suspend fun fetchProjectEvents(project: String, n: Int = 120): List<RawEvent> = withContext(Dispatchers.IO) {
        try {
            http.newCall(req("/api/project/$project/events?n=$n").build()).execute().use { resp ->
                if (!resp.isSuccessful) emptyList()
                else json.decodeFromString(ListSerializer(RawEvent.serializer()), resp.body!!.string())
            }
        } catch (_: Exception) { emptyList() }
    }

    /**
     * Stream-upload a file (image or video) from a content URI.
     * Uses a streaming RequestBody so large videos don't need to be
     * fully buffered in memory before sending.
     */
    suspend fun uploadFile(context: Context, uri: Uri, mimeType: String): String = withContext(Dispatchers.IO) {
        val contentLength = try {
            context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L
        } catch (_: Exception) { -1L }

        val mediaType = mimeType.toMediaType()
        val body = object : RequestBody() {
            override fun contentType() = mediaType
            override fun contentLength() = contentLength
            override fun writeTo(sink: BufferedSink) {
                context.contentResolver.openInputStream(uri)?.use { ins ->
                    sink.writeAll(ins.source())
                }
            }
        }
        http.newCall(
            req("/api/attach/image").post(body).header("Content-Type", mimeType).build()
        ).execute().use { resp ->
            if (!resp.isSuccessful) error("upload file ${resp.code}: ${resp.body?.string()}")
            json.decodeFromString(AttachResponse.serializer(), resp.body!!.string()).path
        }
    }

    suspend fun dispatch(
        project: String,
        prompt: String,
        attachmentPaths: List<String> = emptyList(),
        videoPaths: List<String> = emptyList(),
    ) = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("project", project)
            put("prompt", prompt)
            if (attachmentPaths.isNotEmpty()) {
                put("attachmentPaths", buildJsonArray { attachmentPaths.forEach { add(it) } })
            }
            if (videoPaths.isNotEmpty()) {
                put("videoPaths", buildJsonArray { videoPaths.forEach { add(it) } })
            }
        }
        val body = Json.encodeToString(payload).toRequestBody("application/json".toMediaType())
        http.newCall(
            req("/api/dispatch").post(body).header("Content-Type", "application/json").build()
        ).execute().use { resp ->
            if (!resp.isSuccessful) error("dispatch ${resp.code}: ${resp.body?.string()}")
        }
    }

    /** Set/clear the parked flag for a project. */
    suspend fun parkProject(project: String, parked: Boolean) = withContext(Dispatchers.IO) {
        val payload = buildJsonObject { put("parked", parked) }
        val body = Json.encodeToString(payload).toRequestBody("application/json".toMediaType())
        http.newCall(
            req("/api/project/$project/park").post(body).header("Content-Type", "application/json").build()
        ).execute().use { resp ->
            if (!resp.isSuccessful) error("parkProject ${resp.code}: ${resp.body?.string()}")
        }
    }

    /** Append `tool` to the project's allowed-tools list in config.json. */
    suspend fun addTool(project: String, tool: String) = withContext(Dispatchers.IO) {
        val payload = buildJsonObject { put("tool", tool) }
        val body = Json.encodeToString(payload).toRequestBody("application/json".toMediaType())
        http.newCall(
            req("/api/project/$project/add-tool").post(body).header("Content-Type", "application/json").build()
        ).execute().use { resp ->
            if (!resp.isSuccessful) error("addTool ${resp.code}: ${resp.body?.string()}")
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

    /** URL for the aggregate SSE stream (no token — gate disabled server-side). */
    fun fleetSseUrl(): String = "${baseUrl()}/api/sse/fleet"

    /** Lightweight health-check; used to verify the server is reachable. */
    suspend fun healthz(): Boolean = withContext(Dispatchers.IO) {
        try {
            http.newCall(req("/healthz").build()).execute().use { it.isSuccessful }
        } catch (_: Exception) { false }
    }
}
