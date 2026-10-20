package com.orchestrateur.ui.fleet

import com.orchestrateur.data.IdVocab
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Rich text of the app (0.105.0 HTML output + 0.107.0 clickable identifiers):
 * the pure block / inline parsing behind Markdown().
 */
class MarkdownParseTest {
    private val vocab = IdVocab(projects = listOf("chef", "alpha", "garde"), slots = listOf("dev.vert"), conductor = "chef")
    private fun inl(s: String, v: IdVocab? = vocab) = parseInline(s, v)
    private fun id(display: String, kind: String, value: String = display) = MdInline.IdRef(display, kind, value)

    @Test fun blocks() {
        val b = parseBlocks("# Titre\n\npara un\nsuite\n\n- a\n2. b\n> q\n\n```\nt-abc123\n```\n| h1 | h2 |\n|---|---|\n| x | y |")
        assertEquals(MdBlock.H1("Titre"), b[0])
        assertEquals(MdBlock.Para("para un suite"), b[1])
        assertEquals(MdBlock.Bullet("a"), b[2])
        assertEquals(MdBlock.Ordered(2, "b"), b[3])
        assertEquals(MdBlock.Quote("q"), b[4])
        assertEquals(MdBlock.Code("t-abc123"), b[5])
        assertEquals(MdBlock.Table(listOf("h1", "h2"), listOf(listOf("x", "y"))), b[6])
    }

    @Test fun identifierBecomesIdRef() {
        assertEquals(listOf(MdInline.Text("voir "), id("t-abc123", "todo")), inl("voir t-abc123"))
        assertEquals(listOf(id("3e3b51b", "commit"), MdInline.Text(" posé")), inl("[[commit:3e3b51b]] posé"))
        assertEquals(listOf(id("alpha", "projet"), MdInline.Text(" et "), id("dev.vert", "case")), inl("alpha et dev.vert"))
    }

    @Test fun neverInsideCodeOrLinks() {
        assertEquals(listOf(MdInline.Code("t-abc123")), inl("`t-abc123`"))
        assertEquals(listOf(MdInline.Link(listOf(MdInline.Text("t-abc123")), "https://x.org")), inl("[t-abc123](https://x.org)"))
        assertEquals(listOf(MdInline.Link(listOf(MdInline.Text("https://x.org/t-abc123/a.js")), "https://x.org/t-abc123/a.js")), inl("https://x.org/t-abc123/a.js"))
    }

    @Test fun idrefsOffMeansPlainText() {
        assertEquals(listOf(MdInline.Text("voir t-abc123 [[x]]")), inl("voir t-abc123 [[x]]", null))
    }

    @Test fun underscoresInIdentifiersAreNotItalics() {
        assertEquals(listOf(id("my_file_name.md", "fichier")), inl("[[fichier:my_file_name.md]]"))
        assertEquals(listOf(MdInline.Text("voir "), id("scripts/_test_x.mjs", "fichier")), inl("voir scripts/_test_x.mjs"))
    }

    @Test fun identifierInsideEmphasis() {
        assertEquals(listOf(MdInline.Bold(listOf(id("alpha", "projet")))), inl("**alpha**"))
        assertEquals(listOf(MdInline.Italic(listOf(id("t-abc123", "todo")))), inl("_t-abc123_"))
    }

    @Test fun determinerRuleAndConductor() {
        assertEquals(listOf(MdInline.Text("la garde et le chef")), inl("la garde et le chef"))
        assertEquals(id("garde", "projet"), inl("garde a fini")[0])
    }

    @Test fun unsafeMarkdownLinkIsPlainText() {
        val r = inl("[x](javascript:alert(1))")
        assertTrue(r.toString(), r.none { it is MdInline.Link })
        assertEquals(listOf(MdInline.Link(listOf(MdInline.Text("doc")), "/api/x")), inl("[doc](/api/x)"))
    }

    @Test fun htmlConvertedOnlyWhenAllowed() {
        assertEquals("**gras**", prepareMarkdown("<p><strong>gras</strong></p>", html = true))
        assertEquals("<p><strong>gras</strong></p>", prepareMarkdown("<p><strong>gras</strong></p>", html = false))
        assertEquals("## Bilan", prepareMarkdown("## Bilan", html = true))
    }
}
