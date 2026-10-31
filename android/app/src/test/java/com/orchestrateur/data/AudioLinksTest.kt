package com.orchestrateur.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * User requirement (2026-10-31): « ajoutes un lecteur pour lire dans l'App (il n'y en a pas) ».
 * Cited audio files are detected like images / videos; only one player plays at a time.
 */
class AudioLinksTest {
    @Test
    fun audioExtensionsAreDetected() {
        for (e in listOf("wav", "mp3", "ogg", "m4a", "flac", "opus")) {
            assertEquals(MediaKind.AUDIO, MediaLinks.kindOf("I:\\Dev\\a\\voix.${e.uppercase()}"))
        }
        assertNull(MediaLinks.kindOf("voix.txt"))
    }

    @Test
    fun citedFindsAudioMarksAndBarePaths() {
        val text = "Écoute [[fichier:I:\\Dev\\a\\note vocale.mp3]] et I:/Dev/a/b.flac, pas https://x/y.wav"
        assertEquals(listOf("I:\\Dev\\a\\note vocale.mp3", "I:/Dev/a/b.flac"), MediaLinks.cited(text))
    }

    @Test
    fun startingAPlayerStopsThePreviousOne() {
        val sp = SinglePlayer()
        val stopped = mutableListOf<String>()
        sp.play("a") { stopped += "a" }
        sp.play("b") { stopped += "b" }
        assertEquals(listOf("a"), stopped)
        assertEquals("b", sp.current)
        sp.stop("a")
        assertEquals("b", sp.current)
        sp.stopAll()
        assertEquals(listOf("a", "b"), stopped)
        assertNull(sp.current)
    }

    @Test
    fun replayingTheSameKeyDoesNotStopItself() {
        val sp = SinglePlayer()
        var n = 0
        sp.play("a") { n++ }
        sp.play("a") { n++ }
        assertEquals(0, n)
        sp.stop("a")
        assertNull(sp.current)
    }

    @Test
    fun durationFormat() {
        assertEquals("0:05", SinglePlayer.format(5400))
        assertEquals("1:05", SinglePlayer.format(65000))
        assertEquals("1:01:01", SinglePlayer.format(3661000))
        assertTrue(SinglePlayer.format(-1) == "0:00")
    }
}
