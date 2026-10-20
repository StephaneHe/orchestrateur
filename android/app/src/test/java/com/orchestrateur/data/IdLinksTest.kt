package com.orchestrateur.data

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/**
 * User requirement (2026-10-16, 0.107.0): « toutes references a un identifiant
 * quelconque soit un lien qui ouvre un overlay ». Port of section 1 of
 * scripts/_test_id_links.mjs (same vocabulary, same texts).
 */
class IdLinksTest {
    private val vocab = IdVocab(
        projects = listOf("chef", "alpha", "BlueFox", "garde", "sky-share", "index"),
        slots = listOf("routage.classifier", "dev.vert", "images.generer.photo"),
        conductor = "chef",
    )
    private fun find(t: String) = IdLinks.find(t, vocab)

    @Test fun explicitTagBecomesLinkWithoutBrackets() {
        val m = find("Voir [[t-1a2b3c]] « titre ».").single()
        assertEquals("t-1a2b3c", m.value)
        assertEquals("t-1a2b3c", m.display)
        assertEquals("", m.kind)
        assertEquals("[[t-1a2b3c]]", "Voir [[t-1a2b3c]] « titre ».".substring(m.start, m.end))
    }

    @Test fun explicitTagWithKindPrefix() {
        val m = find("[[commit:3e3b51b]]").single()
        assertEquals("3e3b51b", m.value)
        assertEquals("commit", m.kind)
        assertEquals("3e3b51b", m.display)
        val f = find("[[fichier:I:\\Dev\\x\\notes.md]]").single()
        assertEquals("fichier", f.kind)
        assertEquals("I:\\Dev\\x\\notes.md", f.value)
        assertEquals("todo", IdLinks.splitExplicit("tâche : t-abc123").first)
        assertEquals("fichier", IdLinks.splitExplicit("path:a/b.js").first)
    }

    @Test fun unknownExplicitFormatStillLinked() {
        val m = find("[[quelque-chose-de-libre]]").single()
        assertEquals("quelque-chose-de-libre", m.value)
        assertEquals("", m.kind)
    }

    @Test fun knownFormatsDetected() {
        val all = find("t-abc123, p-20261016T101500-a1b2c3, q-1760000000000-ab12, v0.105.0, scripts/dispatch.mjs:12, routage.classifier, 3e3b51b, 7562a914, BlueFox, alpha, garde a fini et sky-share.")
        val kinds = all.associate { it.value to it.kind }
        assertEquals("todo", kinds["t-abc123"])
        assertEquals("run", kinds["p-20261016T101500-a1b2c3"])
        assertEquals("queue", kinds["q-1760000000000-ab12"])
        assertEquals("version", kinds["v0.105.0"])
        assertEquals("fichier", kinds["scripts/dispatch.mjs:12"])
        assertEquals("case", kinds["routage.classifier"])
        assertEquals("", kinds["3e3b51b"])
        assertEquals("", kinds["7562a914"])
        assertEquals("projet", kinds["BlueFox"])
        assertEquals("projet", kinds["garde"])
        assertEquals("projet", kinds["alpha"])
        assertEquals("projet", kinds["sky-share"])
        assertEquals(12, all.size)
    }

    @Test fun noFalsePositives() {
        val none = find("Node.js, la garde, the garde, l’index, le chef, couleur #ff00aa, 20261016, decade, abcdef, v1.2, dev.md5, e-mail a.b@c.com, http://x.org/a.js, 75627914 (chiffres seuls : à baliser)")
        assertEquals(emptyList<IdMatch>(), none)
    }

    @Test fun commonNamesAndConductorOnlyWhenTagged() {
        assertTrue(find("index et chef").isEmpty())
        val tagged = find("[[index]] et [[chef]]")
        assertEquals(listOf("index", "chef"), tagged.map { it.value })
    }

    @Test fun stripRemovesTags() {
        assertEquals("Voir t-1a2b3c et 3e3b51b", IdLinks.strip("Voir [[t-1a2b3c]] et [[commit:3e3b51b]]"))
        assertTrue(find("rien").isEmpty())
        assertTrue(find("").isEmpty())
    }

    @Test fun emptyVocabularyStillFindsFormats() {
        val m = IdLinks.find("item t-abc123 de alpha", IdVocab())
        assertEquals(listOf("t-abc123"), m.map { it.value })
    }

    @Test fun vocabularyFromServerJson() {
        val v = idVocabFrom(parseJsonOrNull("""{"ok":true,"projects":["alpha","chef"],"slots":["dev.vert"],"conductor":"chef","kinds":{}}"""))!!
        assertEquals(listOf("alpha", "chef"), v.projects)
        assertEquals(listOf("dev.vert"), v.slots)
        assertEquals("chef", v.conductor)
        assertNull(idVocabFrom(parseJsonOrNull("""{"ok":false}""")))
    }

    @Test fun vocabularyCacheRefreshesAtMostEveryFiveMinutes() = runBlocking {
        val cache = IdVocabCache()
        var calls = 0
        cache.refreshIfStale(now = 1_000) { calls++; vocab }
        cache.refreshIfStale(now = 1_000 + 60_000) { calls++; vocab }
        assertEquals(1, calls)
        assertEquals(vocab, cache.vocab.value)
        cache.refreshIfStale(now = 1_000 + 5 * 60_000) { calls++; null }
        assertEquals(2, calls)
        assertEquals("a failed refresh keeps the last vocabulary", vocab, cache.vocab.value)
    }

    @Test fun webLinksMapToAppRoutes() {
        assertEquals(IdLinkTarget.Musician("alpha"), idLinkTarget(musician = "alpha", route = null, open = null))
        assertEquals(IdLinkTarget.Route("models"), idLinkTarget(null, "#/models", null))
        assertEquals(IdLinkTarget.Route("projets"), idLinkTarget(null, "#/projets", null))
        assertEquals(IdLinkTarget.Musician("beta"), idLinkTarget(null, "#/m/beta", null))
        assertEquals(IdLinkTarget.Route("todo"), idLinkTarget(null, null, "todo"))
        assertEquals(IdLinkTarget.Route("git"), idLinkTarget(null, null, "git"))
        assertEquals(IdLinkTarget.Route("release"), idLinkTarget(null, null, "release"))
        assertEquals(IdLinkTarget.Route("requetes"), idLinkTarget(null, null, "requests"))
        assertNull(idLinkTarget(null, "#/inconnu", null))
        assertNull(idLinkTarget(null, null, "bidule"))
        assertNull(idLinkTarget(null, null, null))
    }

    @Test fun identifyResponseParsed() {
        val j = parseJsonOrNull("""{"ok":true,"known":true,"id":"t-1a2b3c","kind":"todo","kindLabel":"Item de TODO list",
            "title":"Mode sombre","project":"alpha","state":"à faire","tone":"todo","date":"2026-10-15T09:00:00Z",
            "summary":"ligne 1","fields":[{"k":"Type","v":"fonctionnalite"}],
            "links":[{"label":"Ouvrir dans le panneau TODO","open":"todo","item":"t-1a2b3c"},{"label":"Volet de alpha","musician":"alpha"},{"label":"??","open":"zzz"}]}""")
        val info = parseIdentify(j, "t-1a2b3c")
        assertTrue(info.known)
        assertEquals("Mode sombre", info.title)
        assertEquals("Item de TODO list", info.kindLabel)
        assertEquals("todo", info.tone)
        assertEquals(listOf("Type" to "fonctionnalite"), info.fields)
        assertEquals(2, info.links.size)
        assertEquals(IdLinkTarget.Route("todo"), info.links[0].second)
        val unknown = parseIdentify(parseJsonOrNull("""{"ok":true,"known":false,"id":"t-ffffff","message":"introuvable"}"""), "t-ffffff")
        assertTrue(!unknown.known)
        assertEquals("introuvable", unknown.message)
        assertEquals("Identifiant inconnu", unknown.kindLabel)
    }

    @Test fun datesFormattedLikeTheWeb() {
        assertEquals("15 oct. 2026 09:30", fmtIdDate("2026-10-15T09:30:00Z", ZoneOffset.UTC))
        assertEquals("5 oct. 2026", fmtIdDate("2026-10-05", ZoneOffset.UTC))
        assertEquals("bidule", fmtIdDate("bidule", ZoneOffset.UTC))
    }
}
