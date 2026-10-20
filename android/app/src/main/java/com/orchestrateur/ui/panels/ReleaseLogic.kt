package com.orchestrateur.ui.panels

import com.orchestrateur.data.a
import com.orchestrateur.data.b
import com.orchestrateur.data.i
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement

/* Pure logic of the Release panel (port of public/release-panel.js). No android.* here. */

data class ReleaseProject(val name: String, val changelog: Boolean)

data class ReleaseItem(
    val state: String,
    val origin: String?,
    val section: String?,
    val text: String,
    val version: String?,
    val date: String?,
    val id: String?,
    val since: String?,
)

data class ReleaseGroup(val key: String, val state: String, val version: String?, val date: String?, val items: List<ReleaseItem>)

data class ReleaseData(
    val project: String,
    val changelog: Boolean,
    val error: String?,
    val releaseVersion: String?,
    val releaseLabel: String?,
    val ready: Int,
    val progress: Int,
    val items: List<ReleaseItem>,
    /** null when the server is older than 0.98.0 (no `groups`). */
    val groups: List<ReleaseGroup>?,
    val note: String,
    val readyVersions: List<String>,
)

fun parseReleaseProjects(j: JsonElement?): List<ReleaseProject> =
    j.a("projects").map { ReleaseProject(it.s("name").orEmpty(), it.b("changelog")) }

private fun parseItem(j: JsonElement) = ReleaseItem(
    state = j.s("state") ?: "progress", origin = j.s("origin"), section = j.s("section"), text = j.s("text").orEmpty(),
    version = j.s("version"), date = j.s("date"), id = j.s("id"), since = j.s("since"),
)

fun parseRelease(j: JsonElement?): ReleaseData {
    val rel = j.o("release")
    return ReleaseData(
        project = j.s("project").orEmpty(),
        changelog = j.b("changelog"),
        error = j.s("error"),
        releaseVersion = rel.s("version"),
        releaseLabel = rel.s("label"),
        ready = j.o("counts").i("ready") ?: 0,
        progress = j.o("counts").i("progress") ?: 0,
        items = j.a("items").map(::parseItem),
        groups = (j.o("groups") as? JsonArray)?.map { g ->
            ReleaseGroup(g.s("key").orEmpty(), g.s("state") ?: "ready", g.s("version"), g.s("date"), g.a("items").map(::parseItem))
        },
        note = j.s("note").orEmpty(),
        readyVersions = j.a("readyVersions").mapNotNull { it.s("version") },
    )
}

fun releaseProjectLabel(p: ReleaseProject) = if (p.changelog) p.name else "${p.name} (pas de CHANGELOG)"

fun currentReleaseProject(projects: List<ReleaseProject>, want: String): String {
    val ok = projects.filter { it.changelog }.map { it.name }
    return if (want in ok) want else ok.firstOrNull().orEmpty()
}

fun releaseSummary(d: ReleaseData): String =
    "Dernière release : ${d.releaseVersion ?: "—"} (${d.releaseLabel.orEmpty()}) · ${d.ready} prêt${if (d.ready > 1) "s" else ""} · ${d.progress} en cours"

/** Server groups, or the same grouping done here for an older server. */
fun groupsOf(d: ReleaseData): List<ReleaseGroup> {
    d.groups?.let { return it }
    val order = mutableListOf<String>()
    val by = linkedMapOf<String, MutableList<ReleaseItem>>()
    for (it in d.items) {
        val key = if (it.state == "ready") "v:${it.version}" else "progress"
        if (key !in by) { by[key] = mutableListOf(); order += key }
        by.getValue(key) += it
    }
    return order.sortedBy { if (it == "progress") 0 else 1 }.map { k ->
        val first = by.getValue(k).first()
        ReleaseGroup(k, first.state, first.version, first.date, by.getValue(k))
    }
}

fun groupTitle(g: ReleaseGroup): String =
    if (g.state == "progress") "⏳ En cours — pas encore dans une version" else "✓ ${g.version}${g.date?.let { " · $it" } ?: ""}"

fun countLabel(n: Int) = "$n élément${if (n > 1) "s" else ""}"

private val BOLD = Regex("\\*\\*(.+?)\\*\\*")
private val CODE = Regex("`([^`]+)`")

/** First line, bold and code marks removed (the list does not render Markdown). */
fun plainLine(s: String): String = BOLD.replace(CODE.replace(s.split("\n").first(), "$1"), "$1")

fun itemWhere(i: ReleaseItem): String = when {
    i.state == "ready" -> i.section ?: "—"
    i.origin == "todo" -> "TODO${i.id?.let { " $it" } ?: ""}"
    else -> "Unreleased${i.section?.let { " · $it" } ?: ""}"
}

fun detailWhere(i: ReleaseItem): String = when {
    i.state == "ready" -> i.section ?: "Autre"
    i.origin == "todo" -> "TODO du musicien${i.id?.let { " · $it" } ?: ""}${i.since?.let { " · depuis le ${it.take(10)}" } ?: ""}"
    else -> "CHANGELOG [Unreleased]${i.section?.let { " · $it" } ?: ""}"
}

fun detailTitle(project: String, g: ReleaseGroup) =
    if (g.state == "progress") "$project — en cours" else "$project — release ${g.version}"

fun detailMeta(g: ReleaseGroup): String {
    val secs = g.items.mapNotNull { it.section?.takeIf { s -> s.isNotEmpty() } }.distinct()
    val head = if (g.state == "progress") "⏳ en cours, pas encore publié" else "✓ prêt${g.date?.let { " · $it" } ?: ""}"
    return "$head · ${countLabel(g.items.size)}${if (secs.isNotEmpty()) " · ${secs.joinToString(", ")}" else ""}"
}

fun noteFileName(d: ReleaseData): String {
    val last = d.readyVersions.firstOrNull() ?: "release"
    return "${d.project}-release-${last.replace(Regex("[^\\w.-]+"), "_")}.md"
}
