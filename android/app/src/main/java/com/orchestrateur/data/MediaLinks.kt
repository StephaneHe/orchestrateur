package com.orchestrateur.data

import java.net.URLEncoder

enum class MediaKind { IMAGE, VIDEO }

/**
 * Preview links for a cited image / video: same GET /api/media?path= route as
 * the web thread (public/id-links.js), same extensions as MEDIA_TYPES in server.js.
 */
object MediaLinks {
    private val IMAGES = setOf("png", "jpg", "jpeg", "gif", "webp")
    private val VIDEOS = setOf("mp4", "webm", "mov")

    fun kindOf(value: String): MediaKind? {
        val v = value.trim()
        if (v.isEmpty() || v.any { it == '\n' || it == '\u0000' }) return null
        val ext = v.substringAfterLast('.', "").lowercase()
        return when (ext) {
            in IMAGES -> MediaKind.IMAGE
            in VIDEOS -> MediaKind.VIDEO
            else -> null
        }
    }

    /** Absolute URL to load [path]; the token goes in the query for players that cannot set headers. */
    fun url(base: String, path: String, token: String?): String {
        val enc = URLEncoder.encode(path.trim(), "UTF-8").replace("+", "%20")
        val t = token?.takeIf { it.isNotBlank() }?.let { "&token=${URLEncoder.encode(it, "UTF-8")}" } ?: ""
        return "${base.trimEnd('/')}/api/media?path=$enc$t"
    }

    /** True when the server serves [url] (HEAD answers 2xx); any error means "not available". Blocking: call off the main thread. */
    fun available(url: String): Boolean = runCatching {
        val c = java.net.URL(url).openConnection() as java.net.HttpURLConnection
        try {
            c.requestMethod = "HEAD"
            c.connectTimeout = 5000
            c.readTimeout = 5000
            c.responseCode in 200..299
        } finally {
            c.disconnect()
        }
    }.getOrDefault(false)

    /** Media paths cited as `code` spans in [text], in order, without duplicates. */
    fun cited(text: String): List<String> =
        Regex("`([^`\n]+)`").findAll(text).map { it.groupValues[1].trim() }
            .filter { kindOf(it) != null }.distinct().toList()
}
