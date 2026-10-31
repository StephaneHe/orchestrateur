package com.orchestrateur.data

import java.net.URLEncoder

enum class MediaKind { IMAGE, VIDEO, AUDIO }

/**
 * Preview links for a cited image / video / audio file: same GET /api/media?path= route as
 * the web thread (public/id-links.js). Every extension matches MEDIA_TYPES in server.js, audio
 * (wav, mp3, ogg, m4a, flac, opus) included since server 0.161.0.
 */
object MediaLinks {
    private val IMAGES = setOf("png", "jpg", "jpeg", "gif", "webp")
    private val VIDEOS = setOf("mp4", "webm", "mov")
    private val AUDIO_EXTS = setOf("wav", "mp3", "ogg", "m4a", "flac", "opus")

    fun kindOf(value: String): MediaKind? {
        val v = value.trim()
        if (v.isEmpty() || v.any { it == '\n' || it == '\u0000' }) return null
        val ext = v.substringAfterLast('.', "").lowercase()
        return when (ext) {
            in IMAGES -> MediaKind.IMAGE
            in VIDEOS -> MediaKind.VIDEO
            in AUDIO_EXTS -> MediaKind.AUDIO
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

    private val CODE_SPAN = Regex("`([^`\n]+)`")
    // The web skips <a>: Markdown links and bare URLs are never previewed.
    private val LINK_OR_URL = Regex("\\[([^\\[\\]\\n]*)\\]\\([^)\\n]*\\)|https?://[^\\s<]+")

    /**
     * Media paths cited in [text], in order, without duplicates: the same references
     * the web previews (public/id-links.js `linkText`) — explicit `[[value]]` /
     * `[[fichier:value]]` marks and bare file paths, slash or backslash — plus a
     * code span that is a whole media path (spaces allowed). Found inside code spans
     * too, never inside a link or a URL.
     */
    fun cited(text: String): List<String> {
        val out = mutableListOf<String>()
        fun scan(s: String) {
            for (m in IdLinks.find(LINK_OR_URL.replace(s) { " ".repeat(it.value.length) }, IdVocab())) {
                if (m.kind == "" || m.kind == "fichier") out += m.value.trim()
            }
        }
        var i = 0
        for (c in CODE_SPAN.findAll(text)) {
            scan(text.substring(i, c.range.first))
            val inner = c.groupValues[1].trim()
            if (kindOf(inner) != null && !inner.startsWith("[[")) out += inner else scan(c.groupValues[1])
            i = c.range.last + 1
        }
        scan(text.substring(i))
        return out.filter { kindOf(it) != null }.distinct()
    }
}
