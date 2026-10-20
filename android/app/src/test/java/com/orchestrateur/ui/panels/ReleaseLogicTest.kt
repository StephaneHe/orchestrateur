package com.orchestrateur.ui.panels

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same shapes as GET /api/release and /api/release/:project (scripts/release-notes.mjs). */
private const val PROJECTS = """{"ok":true,"projects":[{"name":"notes","changelog":false},{"name":"alpha","changelog":true}]}"""

private const val RELEASE = """
{"ok":true,"project":"alpha","changelog":true,
 "release":{"version":"1.2.0","source":"tag","tag":"v1.2.0","label":"dernier tag de version v1.2.0"},
 "readyVersions":[{"version":"1.4.0","date":"2026-10-14"},{"version":"1.3.0","date":"2026-10-12"}],
 "counts":{"ready":3,"progress":2},
 "items":[
  {"state":"progress","origin":"unreleased","section":"Added","text":"**Gras** et `code`\nsuite"},
  {"state":"progress","origin":"todo","id":"t-abc123","text":"Item en cours","since":"2026-10-13T09:00"},
  {"state":"ready","version":"1.4.0","date":"2026-10-14","section":"Fixed","text":"Correctif"},
  {"state":"ready","version":"1.4.0","date":"2026-10-14","section":"Added","text":"Ajout"},
  {"state":"ready","version":"1.3.0","date":"2026-10-12","section":"Added","text":"Ancien ajout"}
 ],
 "groups":[
  {"key":"progress","state":"progress","version":null,"date":null,"items":[
    {"state":"progress","origin":"unreleased","section":"Added","text":"**Gras** et `code`\nsuite","index":0},
    {"state":"progress","origin":"todo","id":"t-abc123","text":"Item en cours","since":"2026-10-13T09:00","index":1}]},
  {"key":"v:1.4.0","state":"ready","version":"1.4.0","date":"2026-10-14","items":[
    {"state":"ready","version":"1.4.0","date":"2026-10-14","section":"Fixed","text":"Correctif","index":2},
    {"state":"ready","version":"1.4.0","date":"2026-10-14","section":"Added","text":"Ajout","index":3}],"sections":["Fixed","Added"]},
  {"key":"v:1.3.0","state":"ready","version":"1.3.0","date":"2026-10-12","items":[
    {"state":"ready","version":"1.3.0","date":"2026-10-12","section":"Added","text":"Ancien ajout","index":4}],"sections":["Added"]}
 ],
 "note":"# 1.4.0 - 2026-10-14\n\n### Added\n- Ajout\n"}
"""

class ReleaseLogicTest {
    private val projects = parseReleaseProjects(Json.parseToJsonElement(PROJECTS))
    private val d = parseRelease(Json.parseToJsonElement(RELEASE))

    @Test fun pickerAndSummary() {
        assertEquals("notes (pas de CHANGELOG)", releaseProjectLabel(projects[0]))
        assertEquals("alpha", currentReleaseProject(projects, "notes"))
        assertEquals("Dernière release : 1.2.0 (dernier tag de version v1.2.0) · 3 prêts · 2 en cours", releaseSummary(d))
        assertEquals("Dernière release : — () · 1 prêt · 0 en cours",
            releaseSummary(d.copy(releaseVersion = null, releaseLabel = null, ready = 1, progress = 0)))
    }

    @Test fun groupsInProgressFirstThenEachVersion() {
        val g = groupsOf(d)
        assertEquals(listOf("progress", "v:1.4.0", "v:1.3.0"), g.map { it.key })
        assertEquals("⏳ En cours — pas encore dans une version", groupTitle(g[0]))
        assertEquals("✓ 1.4.0 · 2026-10-14", groupTitle(g[1]))
        assertEquals("2 éléments", countLabel(g[1].items.size))
        assertEquals("1 élément", countLabel(1))
    }

    /** An older server sends only `items`: grouped here the same way as the web. */
    @Test fun fallbackGroupingFromItems() {
        val g = groupsOf(d.copy(groups = null))
        assertEquals(listOf("progress", "v:1.4.0", "v:1.3.0"), g.map { it.key })
        assertEquals(2, g[1].items.size)
    }

    @Test fun listAndDetailLabels() {
        val items = d.items
        assertEquals("Gras et code", plainLine(items[0].text))
        assertEquals("Unreleased · Added", itemWhere(items[0]))
        assertEquals("TODO t-abc123", itemWhere(items[1]))
        assertEquals("Fixed", itemWhere(items[2]))
        assertEquals("CHANGELOG [Unreleased] · Added", detailWhere(items[0]))
        assertEquals("TODO du musicien · t-abc123 · depuis le 2026-10-13", detailWhere(items[1]))
        assertEquals("Fixed", detailWhere(items[2]))
        val g = groupsOf(d)
        assertEquals("alpha — release 1.4.0", detailTitle("alpha", g[1]))
        assertEquals("alpha — en cours", detailTitle("alpha", g[0]))
        assertEquals("✓ prêt · 2026-10-14 · 2 éléments · Fixed, Added", detailMeta(g[1]))
        assertEquals("⏳ en cours, pas encore publié · 2 éléments · Added", detailMeta(g[0]))
    }

    @Test fun noteFileName() {
        assertTrue(d.note.startsWith("# 1.4.0"))
        assertEquals("alpha-release-1.4.0.md", noteFileName(d))
        assertEquals("alpha-release-release.md", noteFileName(d.copy(readyVersions = emptyList())))
        assertFalse(parseRelease(Json.parseToJsonElement("""{"ok":true,"project":"x","changelog":false,"items":[],"note":""}""")).changelog)
    }
}
