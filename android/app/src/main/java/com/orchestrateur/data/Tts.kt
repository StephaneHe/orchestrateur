package com.orchestrateur.data

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale

/**
 * Text cleaning for speech, mirroring public/tts.js: Markdown and HTML removed,
 * code blocks never read, links read by their label, paths by their last
 * segment, long hex ids as « identifiant ». Pure: JVM-tested.
 */
object SpeechText {
    private val FENCE = Regex("```[\\s\\S]*?(```|$)")
    private val TAGS = Regex("<[^>]+>")
    private val MDLINK = Regex("\\[([^\\]]+)]\\(([^)]+)\\)")
    private val IDREF = Regex("\\[\\[(?:[a-z]+:)?([^\\]]+)]]")
    private val URL = Regex("https?://([^/\\s]+)\\S*")
    private val PATH = Regex("(?:[A-Za-z]:)?(?:[\\\\/][\\w.\\-]+){2,}[\\\\/]?([\\w.\\-]+)")
    private val HEX = Regex("\\b[0-9a-f]{12,64}\\b")

    fun toSpeech(src: String): String {
        var t = src.replace("\r", "")
        t = FENCE.replace(t, " bloc de code. ")
        t = t.replace(Regex("<(script|style)[\\s\\S]*?</\\1>", RegexOption.IGNORE_CASE), " ")
        t = TAGS.replace(t, " ")
        t = t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
        t = IDREF.replace(t) { it.groupValues[1] }
        t = MDLINK.replace(t) { it.groupValues[1] }
        t = URL.replace(t) { "lien vers ${it.groupValues[1]}" }
        t = PATH.replace(t) { it.groupValues[1] }
        t = HEX.replace(t, "identifiant")
        t = t.replace(Regex("`([^`]*)`"), "$1")
        t = t.replace(Regex("(?m)^\\s{0,3}#{1,6}\\s*"), "")
        t = t.replace(Regex("(?m)^\\s*[-*+]\\s+"), "")
        t = t.replace(Regex("(?m)^\\s*>\\s?"), "")
        t = t.replace(Regex("(?m)^\\s*\\|?[\\s:|-]+\\|[\\s:|-]*$"), "")
        t = t.replace("|", ", ")
        t = t.replace(Regex("[*_~]{1,3}"), "")
        t = t.replace(Regex("[ \\t]+"), " ").replace(Regex("\\n{2,}"), ".\n").trim()
        return t
    }

    /** Pieces of at most [max] characters, cut at sentence ends when possible. */
    fun chunks(text: String, max: Int = 220): List<String> {
        val out = mutableListOf<String>()
        var rest = text.trim()
        while (rest.length > max) {
            val window = rest.substring(0, max)
            val cut = Regex("[.!?;:]\\s").findAll(window).lastOrNull()?.range?.first?.plus(1)
                ?: window.lastIndexOf(' ').takeIf { it > max / 2 } ?: max
            out += rest.substring(0, cut).trim()
            rest = rest.substring(cut).trim()
        }
        if (rest.isNotEmpty()) out += rest
        return out.filter { it.isNotBlank() }
    }
}

/** Reads text aloud with the device's speech engine (local, free, no key). */
class Tts(context: Context, private val prefs: UiPrefs) {
    /** Id of the text being read, or null. */
    var speakingId by mutableStateOf<String?>(null)
        private set
    private var ready = false
    private lateinit var engine: TextToSpeech

    init {
        engine = TextToSpeech(context.applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (ready) engine.language = Locale.FRENCH
        }
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { if (utteranceId?.endsWith("#last") == true) speakingId = null }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { speakingId = null }
        })
    }

    val available: Boolean get() = ready && !prefs.ttsOff

    fun speak(id: String, markdown: String) {
        if (!available) return
        stop()
        val parts = SpeechText.chunks(SpeechText.toSpeech(markdown))
        if (parts.isEmpty()) return
        engine.setSpeechRate(prefs.ttsRate)
        speakingId = id
        parts.forEachIndexed { i, p ->
            engine.speak(p, TextToSpeech.QUEUE_ADD, null, if (i == parts.lastIndex) "$id#last" else "$id#$i")
        }
    }

    fun toggle(id: String, markdown: String) { if (speakingId == id) stop() else speak(id, markdown) }

    fun stop() { engine.stop(); speakingId = null }
}
