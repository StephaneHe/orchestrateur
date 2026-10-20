package com.orchestrateur.ui.panels

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/** Same shapes as GET /api/git-graph and /api/git-graph/:project (scripts/git-graph-core.mjs). */
private const val PROJECTS = """{"ok":true,"projects":[{"name":"notes","repo":false},{"name":"alpha","repo":true},{"name":"beta","repo":true}]}"""

// Merge commit m (parents a, b) on main, b on a feature branch, a and b's parent root.
private const val GRAPH = """
{"ok":true,"project":"alpha","n":80,"repo":true,"head":"main","truncated":true,
 "commits":[
  {"sha":"m000000000","short":"m000000","parents":["a000000000","b000000000"],"refs":{"head":"main","branches":["main"],"remotes":["origin/main"],"tags":["v1.2.0"]},"author":"Ana","date":"2026-10-14T09:05:00+02:00","subject":"Merge feature"},
  {"sha":"b000000000","short":"b000000","parents":["r000000000"],"refs":{"head":null,"branches":["feature"],"remotes":[],"tags":[]},"author":"Bo","date":"2026-10-13T18:00:00+02:00","subject":"Feature work"},
  {"sha":"a000000000","short":"a000000","parents":["r000000000"],"refs":{"head":null,"branches":[],"remotes":[],"tags":[]},"author":"Ana","date":"2026-10-13T10:00:00+02:00","subject":"Main work"}
 ],
 "layout":{"rows":[{"lane":0},{"lane":1},{"lane":0}],
   "segments":[{"r1":0,"l1":0,"r2":1,"l2":0,"lane":0},{"r1":0,"l1":0,"r2":1,"l2":1,"lane":1},{"r1":1,"l1":0,"r2":2,"l2":0,"lane":0}],
   "lanes":2,"open":[{"lane":0,"from":0},{"lane":0,"from":1}]}}
"""

class GitLogicTest {
    private val projects = parseGitProjects(Json.parseToJsonElement(PROJECTS))
    private val g = parseGitGraph(Json.parseToJsonElement(GRAPH))

    @Test fun pickerListsNonReposDisabledAndPicksARepo() {
        assertEquals(3, projects.size)
        assertFalse(projects[0].repo)
        assertEquals("notes (pas de dépôt git)", gitProjectLabel(projects[0]))
        assertEquals("alpha", currentRepo(projects, ""))
        assertEquals("beta", currentRepo(projects, "beta"))
        assertEquals("alpha", currentRepo(projects, "notes"))
        assertEquals("", currentRepo(emptyList(), "x"))
    }

    @Test fun parsesCommitsRefsAndLayout() {
        assertEquals(3, g.commits.size)
        assertTrue(g.truncated)
        assertEquals("main", g.head)
        assertEquals(2, g.layout.lanes)
        assertEquals(listOf(0, 1, 0), g.layout.rows)
        assertEquals(3, g.layout.segments.size)
        assertEquals(2, g.layout.open.size)
        assertEquals("alpha · HEAD main · 3 commits (les plus récents)", gitSummary(g))
    }

    @Test fun refsLikeTheWebHeadHighlighted() {
        val refs = refChips(g.commits[0])
        assertEquals(listOf("HEAD → main", "origin/main", "🏷 v1.2.0"), refs.map { it.text })
        assertEquals(listOf(RefKind.HEAD, RefKind.REMOTE, RefKind.TAG), refs.map { it.kind })
        assertEquals(listOf(RefKind.BRANCH), refChips(g.commits[1]).map { it.kind })
        val detached = g.commits[2].copy(head = "detached")
        assertEquals("HEAD", refChips(detached).first().text)
    }

    @Test fun dateInLocalTime() {
        assertEquals("14/10/26 09:05", fmtGitDate("2026-10-14T09:05:00+02:00", ZoneId.of("Europe/Paris")))
        assertEquals("14/10/26 07:05", fmtGitDate("2026-10-14T09:05:00+02:00", ZoneId.of("UTC")))
        assertEquals("", fmtGitDate("pas une date", ZoneId.of("UTC")))
    }

    @Test fun moreCommitsByEightyUpToThreeHundred() {
        assertEquals(160, nextN(80))
        assertEquals(300, nextN(240))
        assertTrue(canLoadMore(g, 80))
        assertFalse(canLoadMore(g, 300))
        assertFalse(canLoadMore(g.copy(truncated = false), 80))
    }

    /** Each row draws the lower half of the segments leaving it and the upper half of those arriving. */
    @Test fun rowStrokesSplitSegmentsAtTheRowBoundary() {
        val r0 = rowStrokes(g.layout, 0, g.commits.size)
        // Two segments leave row 0: straight lane 0, curve 0 → 1 (split at its middle).
        assertEquals(2, r0.size)
        val straight = r0.first { it.lane == 0 }
        assertEquals(Stroke(0, 0.0, 0.5, 0.0, 0.5, 0.0, 1.0, 0.0, 1.0), straight.copy())
        val curve = r0.first { it.lane == 1 }
        assertEquals(0.0, curve.x0, 1e-9); assertEquals(0.5, curve.y0, 1e-9)
        assertEquals(0.5, curve.x3, 1e-9); assertEquals(1.0, curve.y3, 1e-9)
        val r1 = rowStrokes(g.layout, 1, g.commits.size)
        // Row 1 receives two halves and sends one.
        assertEquals(3, r1.size)
        val arrivingCurve = r1.first { it.lane == 1 && it.y0 == 0.0 }
        assertEquals(0.5, arrivingCurve.x0, 1e-9); assertEquals(1.0, arrivingCurve.x3, 1e-9); assertEquals(0.5, arrivingCurve.y3, 1e-9)
        // Last row: arriving half plus the two "open" lines towards older commits.
        val r2 = rowStrokes(g.layout, 2, g.commits.size)
        assertEquals(3, r2.size)
        assertEquals(2, r2.count { it.dashed })
        assertNull(rowStrokes(g.layout, 5, 3).firstOrNull())
    }
}
