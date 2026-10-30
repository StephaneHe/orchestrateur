package com.orchestrateur.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * User requirement (2026-10-29): « Il faut que l'orchestrateur puisse afficher des
 * images ou des videos. Web et mobile ». Same route and extensions as the web thread.
 */
class MediaLinksTest {
    @Test
    fun kindOfRecognisesServerExtensions() {
        assertEquals(MediaKind.IMAGE, MediaLinks.kindOf("I:\\Dev\\a\\shot.PNG"))
        assertEquals(MediaKind.IMAGE, MediaLinks.kindOf("x.jpeg"))
        assertEquals(MediaKind.VIDEO, MediaLinks.kindOf("clip.mov"))
        assertNull(MediaLinks.kindOf("notes.txt"))
        assertNull(MediaLinks.kindOf("png"))
    }

    @Test
    fun urlEncodesPathAndToken() {
        assertEquals(
            "http://h:7777/api/media?path=I%3A%5CDev%5Ca%20b.png",
            MediaLinks.url("http://h:7777/", "I:\\Dev\\a b.png", null),
        )
        assertEquals(
            "http://h/api/media?path=a.png&token=a%2Bb",
            MediaLinks.url("http://h", "a.png", "a+b"),
        )
    }

    @Test
    fun citedKeepsOnlyMediaPathsWithoutDuplicates() {
        assertEquals(
            listOf("a.png", "b.mp4"),
            MediaLinks.cited("see `a.png`, `notes.txt`, `b.mp4` and `a.png`"),
        )
    }
}
