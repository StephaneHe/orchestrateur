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

    /**
     * User report (2026-10-31): « Je vois l'image sur le client web, mais pas sur l'app ».
     * The real chef message cited the image as an explicit [[fichier:…]] mark, which the
     * web previews (public/id-links.js) and the app ignored (code spans only).
     */
    @Test
    fun citedFindsTheRealChefMessageMark() {
        val real = "[[fichier:I:\\Dev\\Chef\\icons\\pitchball\\pitchball-icon-512.png]]"
        assertEquals(listOf("I:\\Dev\\Chef\\icons\\pitchball\\pitchball-icon-512.png"), MediaLinks.cited(real))
        assertEquals(
            listOf("I:\\Dev\\Chef\\icons\\pitchball\\pitchball-icon-512.png"),
            MediaLinks.cited("Voici l'icône : $real (512×512)."),
        )
    }

    @Test
    fun citedFindsEveryFormatTheWebPreviews() {
        // Explicit marks, with or without the kind, slash or backslash.
        assertEquals(listOf("I:/Dev/a/shot.png"), MediaLinks.cited("[[I:/Dev/a/shot.png]]"))
        assertEquals(listOf("C:\\x\\clip.mp4"), MediaLinks.cited("[[file:C:\\x\\clip.mp4]]"))
        // Bare paths: Windows drive with backslashes or slashes, relative, plain name, every extension.
        assertEquals(listOf("I:\\Dev\\Chef\\a.webp"), MediaLinks.cited("capture I:\\Dev\\Chef\\a.webp ok"))
        assertEquals(listOf("I:/Dev/Chef/a.jpeg"), MediaLinks.cited("capture I:/Dev/Chef/a.jpeg."))
        assertEquals(listOf("docs/shots/b.gif", "c.mov"), MediaLinks.cited("- voir docs/shots/b.gif et c.mov"))
        // Inside a code span: the mark and the path are still found.
        assertEquals(listOf("I:\\Dev\\x.png"), MediaLinks.cited("`[[fichier:I:\\Dev\\x.png]]`"))
        assertEquals(listOf("I:\\Dev\\x y.png"), MediaLinks.cited("`I:\\Dev\\x y.png`"))
        // Mixed, in order, without duplicates.
        assertEquals(
            listOf("I:\\a.png", "b.mp4"),
            MediaLinks.cited("[[fichier:I:\\a.png]], `b.mp4`, I:\\a.png"),
        )
    }

    @Test
    fun citedIgnoresWhatTheWebDoesNotPreview() {
        assertEquals(emptyList<String>(), MediaLinks.cited("[[t-1a2b3c]] [[commit:3e3b51b]] notes.txt [[fichier:a.txt]]"))
        assertEquals(emptyList<String>(), MediaLinks.cited("[[projet:a.png]] [[version:x.png]]"))
        // Links and URLs are not previewed (the web skips <a>).
        assertEquals(emptyList<String>(), MediaLinks.cited("[photo](https://h/a.png) et https://h/b.png"))
        // A path with a line suffix is a source location, not a media file.
        assertEquals(emptyList<String>(), MediaLinks.cited("src/a.png:12"))
    }
}
