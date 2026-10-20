package com.orchestrateur.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * User requirement (2026-10-16, 0.105.0): model replies in HTML must be shown
 * correctly — and safely. Port of scripts/_test_html_output.mjs (detection,
 * rendering, refused injections).
 */
class HtmlTextTest {
    @Test fun detectsHtmlFragments() {
        assertTrue(HtmlText.isHtml("<p>Bonjour</p>"))
        assertTrue(HtmlText.isHtml("<h2>Bilan</h2>\n<ul><li>un</li><li>deux</li></ul>"))
        assertTrue(HtmlText.isHtml("Voici le point :\n<p>un</p>\n<p>deux</p>"))
        assertTrue(HtmlText.isHtml("<!doctype html><html><body><p>x</p></body></html>"))
    }

    @Test fun markdownAndPlainTextAreNotHtml() {
        assertFalse(HtmlText.isHtml("## Bilan\n\n- **un**\n- deux"))
        assertFalse(HtmlText.isHtml("Le test `<div>` a échoué, voir ```html\n<p>x</p>\n<p>y</p>\n```"))
        assertFalse(HtmlText.isHtml("si a < b et c > d alors rien"))
        assertFalse(HtmlText.isHtml("NEEDS_USER_INPUT: on publie ?"))
        assertFalse(HtmlText.isHtml(""))
    }

    private val answer = "<h2>Résumé</h2>\n<p>J'ai <strong>corrigé</strong> le bug &amp; ajouté <code>x &lt; y</code>.</p>\n" +
        "<ul><li>un</li><li>deux <em>ok</em></li></ul>\n<ol start=\"3\"><li>trois</li></ol>\n" +
        "<table><thead><tr><th scope=\"col\">Suite</th><th>État</th></tr></thead><tbody><tr><td colspan=\"2\">verte</td></tr></tbody></table>\n" +
        "<pre><code class=\"language-js\">if (a &lt; b) {\n  run();\n}</code></pre>\n" +
        "<blockquote>cité</blockquote><details open><summary>Détails</summary><p>caché</p></details>\n" +
        "<p>Voir <a href=\"https://example.org/doc\" title=\"doc\">la doc</a> et <a href=\"#s2\">plus bas</a>.</p>\n" +
        "NEEDS_USER_INPUT: on publie ?"

    @Test fun fragmentBecomesSupportedMarkdown() {
        val md = HtmlText.toMarkdown(answer)
        val lines = md.lines()
        assertTrue(md, lines.contains("## Résumé"))
        assertTrue(md, md.contains("J'ai **corrigé** le bug & ajouté `x < y`."))
        assertTrue(md, lines.contains("- un") && lines.contains("- deux *ok*"))
        assertTrue(md, lines.contains("3. trois"))
        assertTrue(md, md.contains("| Suite | État |\n|---|---|\n| verte |"))
        assertTrue(md, md.contains("```\nif (a < b) {\n  run();\n}\n```"))
        assertTrue(md, lines.contains("> cité"))
        assertTrue(md, lines.contains("Détails") && lines.contains("caché"))
        assertTrue(md, md.contains("[la doc](https://example.org/doc)") && md.contains("[plus bas](#s2)"))
        assertTrue(md, md.trimEnd().endsWith("NEEDS_USER_INPUT: on publie ?"))
    }

    @Test fun lineBreaksAndCase() {
        assertEquals("a\n\nb\n\nc", HtmlText.toMarkdown("<p>a<br>b<br/>c</p>"))
        assertEquals("Maj", HtmlText.toMarkdown("<P CLASS=\"x\">Maj</P>"))
        assertEquals("- un deux", HtmlText.toMarkdown("<ul><li>un<br>deux</li></ul>"))
    }

    @Test fun unknownTagDroppedTextKept() {
        assertEquals("a < b et c", HtmlText.toMarkdown("a < b et <notatag>c"))
        assertEquals("go", HtmlText.toMarkdown("<form><button>go</button></form>"))
    }

    @Test fun safeHrefLikeTheWeb() {
        assertNull(HtmlText.safeHref("javascript:alert(1)"))
        assertNull(HtmlText.safeHref("jav&#x61;script&colon;alert(1)"))
        assertNull(HtmlText.safeHref("java\tscript:alert(1)"))
        assertNull(HtmlText.safeHref("//evil.example/x"))
        assertNull(HtmlText.safeHref("data:text/html,x"))
        assertEquals("https://a.b", HtmlText.safeHref("https://a.b"))
        assertEquals("/api/x", HtmlText.safeHref("/api/x"))
        assertEquals("mailto:a@b.c", HtmlText.safeHref("mailto:a@b.c"))
        assertEquals("#s2", HtmlText.safeHref("#s2"))
    }

    // The refused injections of scripts/_test_html_output.mjs, section 3.
    private val attacks = mapOf(
        "script" to "<p>a</p><script>window.__xss=1</script><p>b</p>",
        "script non fermé" to "<p>a</p><script>window.__xss=1",
        "img onerror" to "<p>x</p><img src=x onerror=\"window.__xss=1\">",
        "attribut on* sur balise permise" to "<p onclick=\"window.__xss=1\" onmouseover=alert(1)>clic</p>",
        "javascript: dans un lien" to "<a href=\"javascript:window.__xss=1\">l</a>",
        "javascript: en majuscules et espaces" to "<a href=\"  JaVaScRiPt:alert(1)\">l</a>",
        "javascript: avec entités" to "<a href=\"jav&#x61;script&colon;alert(1)\">l</a><a href=\"&#106;avascript:alert(1)\">m</a>",
        "javascript: coupé par tabulation" to "<a href=\"java\tscript:alert(1)\">l</a><a href=\"java&#9;script:alert(1)\">m</a>",
        "data: et vbscript:" to "<a href=\"data:text/html,<script>alert(1)</script>\">d</a><a href=\"vbscript:msgbox(1)\">v</a>",
        "lien protocole relatif" to "<a href=\"//evil.example/x\">p</a>",
        "style" to "<style>body{display:none}</style><p style=\"position:fixed;top:0\">x</p>",
        "iframe" to "<iframe src=\"https://evil.example\"></iframe><p>ok</p>",
        "svg onload" to "<svg onload=\"window.__xss=1\"><circle r=1></circle></svg><p>ok</p>",
        "math et template" to "<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math><template><img src=x onerror=alert(1)></template>",
        "object et embed" to "<object data=\"x.swf\"></object><embed src=\"x.swf\">",
        "formulaire" to "<form action=\"https://evil.example\"><input name=a><button formaction=\"javascript:alert(1)\">go</button></form>",
        "meta et base" to "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\"><base href=\"https://evil.example/\">",
        "commentaire conditionnel" to "<!--[if IE]><script>alert(1)</script><![endif]--><p>ok</p>",
        "attribut non fermé" to "<p title=\"x\" onclick=alert(1)//>y</p>",
        "balise dans un attribut" to "<p title=\"<img src=x onerror=alert(1)>\">t</p>",
        "lien Markdown caché dans le texte" to "<p>[clic](javascript:alert(1))</p><p>x</p>",
    )

    @Test fun everyInjectionIsRefused() {
        for ((label, a) in attacks) {
            val md = HtmlText.toMarkdown(a)
            for (bad in listOf("<script", "__xss", "alert(", "onerror", "onclick", "onload", "onmouseover", "<iframe", "<svg", "<img", "style=", "position:fixed", "msgbox", "evil.example/x"))
                if (label != "lien Markdown caché dans le texte" || bad != "alert(")
                    assertFalse("$label : « $bad » reste dans $md", md.contains(bad, ignoreCase = true))
            for (u in HtmlText.markdownLinkUrls(md))
                assertTrue("$label : lien dangereux $u", HtmlText.safeHref(u) != null)
        }
    }

    @Test fun droppedContentDisappearsRestKept() {
        assertEquals("a\n\nb", HtmlText.toMarkdown(attacks.getValue("script")))
        assertEquals("a", HtmlText.toMarkdown(attacks.getValue("script non fermé")))
        assertEquals("ok", HtmlText.toMarkdown(attacks.getValue("iframe")))
        assertEquals("l", HtmlText.toMarkdown(attacks.getValue("javascript: dans un lien")))
        assertEquals("p", HtmlText.toMarkdown(attacks.getValue("lien protocole relatif")))
        assertEquals("t", HtmlText.toMarkdown(attacks.getValue("balise dans un attribut")))
    }

    @Test fun entitiesDecoded() {
        assertEquals("a & b < c « d » é", HtmlText.toMarkdown("<p>a &amp; b &lt; c &laquo; d &raquo; &#233;</p>"))
        assertEquals("&unknown; x", HtmlText.decodeEntities("&unknown; x"))
    }

    @Test fun idTagsSurviveConversion() {
        assertEquals("Voir [[t-1a2b3c]] et [[commit:3e3b51b]]", HtmlText.toMarkdown("<p>Voir [[t-1a2b3c]] et [[commit:3e3b51b]]</p>"))
    }
}
