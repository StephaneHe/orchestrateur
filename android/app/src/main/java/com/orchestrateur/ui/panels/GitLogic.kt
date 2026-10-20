package com.orchestrateur.ui.panels

import com.orchestrateur.data.a
import com.orchestrateur.data.b
import com.orchestrateur.data.i
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import com.orchestrateur.data.str
import com.orchestrateur.data.strs
import kotlinx.serialization.json.JsonElement
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/* Pure logic of the Git panel (port of public/git-panel.js). No android.* here. */

const val GIT_N_STEP = 80
const val GIT_N_MAX = 300

data class GitProject(val name: String, val repo: Boolean)

data class GitCommit(
    val sha: String,
    val short: String,
    val parents: List<String>,
    /** null, the current branch name, or "detached". */
    val head: String?,
    val branches: List<String>,
    val remotes: List<String>,
    val tags: List<String>,
    val author: String,
    val date: String,
    val subject: String,
)

data class GitSegment(val r1: Int, val l1: Int, val r2: Int, val l2: Int, val lane: Int)
data class GitOpen(val lane: Int, val from: Int)
data class GitLayout(val rows: List<Int>, val segments: List<GitSegment>, val lanes: Int, val open: List<GitOpen>)

data class GitGraph(
    val project: String,
    val repo: Boolean,
    val head: String?,
    val commits: List<GitCommit>,
    val layout: GitLayout,
    val truncated: Boolean,
    val error: String?,
)

fun parseGitProjects(j: JsonElement?): List<GitProject> =
    j.a("projects").map { GitProject(it.s("name").orEmpty(), it.b("repo")) }

fun parseGitGraph(j: JsonElement?): GitGraph {
    val lay = j.o("layout")
    return GitGraph(
        project = j.s("project").orEmpty(),
        // An older/odd body without "repo" but with commits is a repository.
        repo = j.o("repo")?.str?.let { it == "true" } ?: true,
        head = j.s("head"),
        commits = j.a("commits").map { c ->
            val refs = c.o("refs")
            GitCommit(
                sha = c.s("sha").orEmpty(), short = c.s("short") ?: c.s("sha").orEmpty().take(7),
                parents = c.strs("parents"), head = refs.s("head"),
                branches = refs.strs("branches"), remotes = refs.strs("remotes"), tags = refs.strs("tags"),
                author = c.s("author").orEmpty(), date = c.s("date").orEmpty(), subject = c.s("subject").orEmpty(),
            )
        },
        layout = GitLayout(
            rows = lay.a("rows").map { it.i("lane") ?: 0 },
            segments = lay.a("segments").map { GitSegment(it.i("r1") ?: 0, it.i("l1") ?: 0, it.i("r2") ?: 0, it.i("l2") ?: 0, it.i("lane") ?: 0) },
            lanes = lay.i("lanes") ?: 1,
            open = lay.a("open").map { GitOpen(it.i("lane") ?: 0, it.i("from") ?: 0) },
        ),
        truncated = j.b("truncated"),
        error = j.s("error"),
    )
}

fun gitProjectLabel(p: GitProject) = if (p.repo) p.name else "${p.name} (pas de dépôt git)"

/** The remembered musician if it has a repository, else the first repository. */
fun currentRepo(projects: List<GitProject>, want: String): String {
    val repos = projects.filter { it.repo }.map { it.name }
    return if (want in repos) want else repos.firstOrNull().orEmpty()
}

fun gitSummary(g: GitGraph): String {
    val n = g.commits.size
    return "${g.project} · HEAD ${g.head ?: "—"} · $n commit${if (n > 1) "s" else ""}${if (g.truncated) " (les plus récents)" else ""}"
}

enum class RefKind { HEAD, BRANCH, REMOTE, TAG }
data class RefChip(val text: String, val kind: RefKind)

fun refChips(c: GitCommit): List<RefChip> = buildList {
    if (c.head == "detached") add(RefChip("HEAD", RefKind.HEAD))
    for (b in c.branches) add(if (c.head == b) RefChip("HEAD → $b", RefKind.HEAD) else RefChip(b, RefKind.BRANCH))
    for (r in c.remotes) add(RefChip(r, RefKind.REMOTE))
    for (t in c.tags) add(RefChip("🏷 $t", RefKind.TAG))
}

private val GIT_DATE = DateTimeFormatter.ofPattern("dd/MM/yy HH:mm")

/** ISO date (%aI) → "dd/MM/yy HH:mm" in [zone] (the phone's, like the browser's). */
fun fmtGitDate(iso: String, zone: ZoneId = ZoneId.systemDefault()): String =
    runCatching { OffsetDateTime.parse(iso).atZoneSameInstant(zone).format(GIT_DATE) }.getOrDefault("")

fun nextN(n: Int) = minOf(GIT_N_MAX, n + GIT_N_STEP)

fun canLoadMore(g: GitGraph, n: Int) = g.truncated && n < GIT_N_MAX

/**
 * One cubic of a row's graph: x in lane units (lane k is centred on k), y in
 * row heights (0 top, 1 bottom). Straight pieces have control points on the ends.
 */
data class Stroke(
    val lane: Int,
    val x0: Double, val y0: Double, val x1: Double, val y1: Double,
    val x2: Double, val y2: Double, val x3: Double, val y3: Double,
    val dashed: Boolean = false,
)

/**
 * What row [r] draws of the web's SVG: the lower half of each segment leaving
 * it, the upper half of each segment arriving, and, on the last row, the
 * lines going on to older commits. The web's curve C(x1,ym)(x2,ym) is split at
 * t = 0.5 (de Casteljau), which falls exactly on the row boundary.
 */
fun rowStrokes(layout: GitLayout, r: Int, count: Int): List<Stroke> {
    val out = mutableListOf<Stroke>()
    for (s in layout.segments) {
        val x1 = s.l1.toDouble(); val x2 = s.l2.toDouble(); val mid = (x1 + x2) / 2
        if (s.r1 == r) {
            out += if (s.l1 == s.l2) Stroke(s.lane, x1, 0.5, x1, 0.5, x1, 1.0, x1, 1.0)
            else Stroke(s.lane, x1, 0.5, x1, 0.75, (3 * x1 + x2) / 4, 0.875, mid, 1.0)
        }
        if (s.r2 == r) {
            out += if (s.l1 == s.l2) Stroke(s.lane, x2, 0.0, x2, 0.0, x2, 0.5, x2, 0.5)
            else Stroke(s.lane, mid, 0.0, (x1 + 3 * x2) / 4, 0.125, x2, 0.25, x2, 0.5)
        }
    }
    if (r == count - 1) for (o in layout.open) {
        val f = o.from.toDouble(); val l = o.lane.toDouble()
        out += Stroke(o.lane, f, 0.5, f, 0.5, l, 1.0, l, 1.0, dashed = true)
    }
    return out
}
