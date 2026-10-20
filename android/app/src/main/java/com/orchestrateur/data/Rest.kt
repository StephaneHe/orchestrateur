package com.orchestrateur.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder

/**
 * Generic JSON access to every /api route (1.0.0). Screens read the JSON tree
 * with the null-safe helpers below instead of one DTO per route: a field the
 * server adds or drops never breaks the app.
 */
data class RestResult(val code: Int, val json: JsonElement?, val text: String) {
    val ok: Boolean get() = code in 200..299
    /** Human-readable error: the server's `error` / `why` field, else the status. */
    fun errorText(): String =
        json.s("error") ?: json.s("why") ?: json.s("message")
            ?: if (code < 0) "serveur injoignable : $text" else "erreur $code"
}

private val restJson = Json { ignoreUnknownKeys = true; isLenient = true }

fun parseJsonOrNull(text: String): JsonElement? =
    if (text.isBlank()) null else runCatching { restJson.parseToJsonElement(text) }.getOrNull()

/** Path segment, encoded (spaces as %20, not +). */
fun enc(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

suspend fun Api.rest(method: String, path: String, body: JsonElement? = null): RestResult =
    withContext(Dispatchers.IO) {
        try {
            val rb = when {
                body != null -> body.toString().toRequestBody("application/json".toMediaType())
                method == "GET" || method == "HEAD" -> null
                else -> "{}".toRequestBody("application/json".toMediaType())
            }
            val req = Request.Builder()
                .url("${baseUrl()}$path")
                .header("Cache-Control", "no-cache")
                .method(method, rb)
                .build()
            http().newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                RestResult(resp.code, parseJsonOrNull(text), text)
            }
        } catch (e: Exception) {
            RestResult(-1, null, e.message ?: e.javaClass.simpleName)
        }
    }

suspend fun Api.getJson(path: String) = rest("GET", path)
suspend fun Api.postJson(path: String, body: JsonElement? = null) = rest("POST", path, body)
suspend fun Api.putJson(path: String, body: JsonElement?) = rest("PUT", path, body)
suspend fun Api.deleteJson(path: String, body: JsonElement? = null) = rest("DELETE", path, body)

// ---- null-safe readers over a JSON tree ----

fun JsonElement?.o(k: String): JsonElement? = (this as? JsonObject)?.get(k)?.takeUnless { it is JsonNull }
val JsonElement?.str: String? get() = (this as? JsonPrimitive)?.contentOrNull
fun JsonElement?.s(k: String): String? = o(k).str
fun JsonElement?.l(k: String): Long? = (o(k) as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }
fun JsonElement?.i(k: String): Int? = l(k)?.toInt()
fun JsonElement?.d(k: String): Double? = (o(k) as? JsonPrimitive)?.doubleOrNull
fun JsonElement?.b(k: String): Boolean = (o(k) as? JsonPrimitive)?.booleanOrNull == true
fun JsonElement?.a(k: String): List<JsonElement> = (o(k) as? JsonArray)?.toList() ?: emptyList()
val JsonElement?.list: List<JsonElement> get() = (this as? JsonArray)?.toList() ?: emptyList()
val JsonElement?.entries: List<Pair<String, JsonElement>>
    get() = (this as? JsonObject)?.entries?.map { it.key to it.value } ?: emptyList()
/** Strings of an array field (non-string items skipped). */
fun JsonElement?.strs(k: String): List<String> = a(k).mapNotNull { it.str }
