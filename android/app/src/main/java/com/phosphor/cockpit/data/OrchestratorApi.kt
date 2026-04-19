package com.phosphor.cockpit.data

import kotlinx.serialization.json.Json
import okhttp3.CookieJar
import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Thin HTTP wrapper around the orchestrator's REST endpoints. The token is
 * attached as both an `X-Orchestrator-Token` header *and* the `orch_tok`
 * cookie (the server accepts either). Cookies are persisted by OkHttp so
 * that SSE calls, which only carry whatever the CookieJar has cached, stay
 * authenticated after the first REST call.
 */
class OrchestratorApi(
    initialBaseUrl: String,
    val token: String,
) {
    @Volatile var baseUrl: String = initialBaseUrl
        private set

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private val cookies = ConcurrentHashMap<String, MutableList<Cookie>>()

    private val cookieJar = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, list: List<Cookie>) {
            cookies.getOrPut(url.host) { mutableListOf() }.apply {
                removeAll { existing -> list.any { it.name == existing.name } }
                addAll(list)
            }
        }
        override fun loadForRequest(url: HttpUrl): List<Cookie> =
            cookies[url.host]?.toList() ?: emptyList()
    }

    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)     // SSE is long-lived
        .cookieJar(cookieJar)
        .build()

    fun updateBaseUrl(url: String) { baseUrl = url.trimEnd('/') }

    // ---- internals -----------------------------------------------------

    private fun urlFor(path: String): String =
        baseUrl.trimEnd('/') + path

    private fun get(path: String): String {
        val req = Request.Builder()
            .url(urlFor(path))
            .header("X-Orchestrator-Token", token)
            .get()
            .build()
        client.newCall(req).execute().use { r ->
            val body = r.body?.string().orEmpty()
            if (!r.isSuccessful) error("GET $path → ${r.code} ${body.take(200)}")
            return body
        }
    }

    private fun postJson(path: String, body: String): String {
        val req = Request.Builder()
            .url(urlFor(path))
            .header("X-Orchestrator-Token", token)
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(req).execute().use { r ->
            val txt = r.body?.string().orEmpty()
            if (!r.isSuccessful) error("POST $path → ${r.code} ${txt.take(200)}")
            return txt
        }
    }

    private fun delete(path: String): String {
        val req = Request.Builder()
            .url(urlFor(path))
            .header("X-Orchestrator-Token", token)
            .delete()
            .build()
        client.newCall(req).execute().use { r ->
            val txt = r.body?.string().orEmpty()
            if (!r.isSuccessful) error("DELETE $path → ${r.code} ${txt.take(200)}")
            return txt
        }
    }

    // ---- public API ----------------------------------------------------

    fun health(): HealthResponse =
        json.decodeFromString(get("/healthz"))

    fun config(): ConfigResponse =
        json.decodeFromString(get("/api/config"))

    fun sessionsFor(project: String): SessionListResponse =
        json.decodeFromString(get("/api/projects/$project/sessions"))

    fun attachSession(project: String, sessionId: String): AttachResponse {
        val body = json.encodeToString(AttachRequest.serializer(), AttachRequest(sessionId))
        return json.decodeFromString(postJson("/api/projects/$project/attach", body))
    }

    fun detachSession(project: String): GenericResponse =
        json.decodeFromString(delete("/api/projects/$project/attach"))

    fun candidates(): CandidatesResponse =
        json.decodeFromString(get("/api/projects/candidates"))

    fun addProject(req: AddProjectRequest): AddProjectResponse {
        val body = json.encodeToString(AddProjectRequest.serializer(), req)
        return json.decodeFromString(postJson("/api/projects", body))
    }

    fun removeProject(project: String): GenericResponse =
        json.decodeFromString(delete("/api/projects/$project"))
}
