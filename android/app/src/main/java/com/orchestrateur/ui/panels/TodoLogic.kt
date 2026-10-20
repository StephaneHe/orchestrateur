package com.orchestrateur.ui.panels

import com.orchestrateur.data.a
import com.orchestrateur.data.b
import com.orchestrateur.data.i
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/* Pure logic of the TODO panel (port of public/todo-panel.js). No android.* here. */

data class TodoNote(val id: String, val at: String?, val by: String?, val text: String)

data class TodoItem(
    val id: String,
    val project: String,
    val line: Int,
    val status: String,
    val title: String,
    val detail: String,
    val detailFull: String?,
    val more: String?,
    val type: String?,
    val addedAt: String?,
    val addedEstimated: Boolean,
    val doneAt: String?,
    val doneBy: String?,
    val rejectedAt: String?,
    val notes: List<TodoNote>,
) {
    val key: String get() = "$project/$id"
    val isDone: Boolean get() = status == "done"
    val rejected: Boolean get() = rejectedAt != null
    /** detailFull when the list detail was cut, else detail. */
    val full: String get() = detailFull ?: detail
}

data class TodoData(
    val items: List<TodoItem>,
    val projects: List<String>,
    val openCount: Int,
    val orderError: String?,
    val notesError: String?,
)

fun parseTodoNote(j: JsonElement): TodoNote =
    TodoNote(j.s("id").orEmpty(), j.s("at"), j.s("by"), j.s("text").orEmpty())

fun parseTodoItem(j: JsonElement): TodoItem = TodoItem(
    id = j.s("id").orEmpty(),
    project = j.s("project").orEmpty(),
    line = j.i("line") ?: 0,
    status = j.s("status") ?: "todo",
    title = j.s("title").orEmpty(),
    detail = j.s("detail").orEmpty(),
    detailFull = j.s("detailFull")?.takeIf { it.isNotEmpty() },
    more = j.s("more")?.takeIf { it.isNotEmpty() },
    type = j.s("type"),
    addedAt = j.s("addedAt"),
    addedEstimated = j.b("addedEstimated"),
    doneAt = j.s("doneAt"),
    doneBy = j.s("doneBy"),
    rejectedAt = j.o("rejected")?.s("at"),
    notes = j.a("notes").map(::parseTodoNote),
)

fun parseTodoData(j: JsonElement?): TodoData = TodoData(
    items = j.a("items").map(::parseTodoItem),
    projects = j.a("lists").mapNotNull { it.s("project") },
    openCount = j.o("counts").i("open") ?: 0,
    orderError = j.s("orderError"),
    notesError = j.s("notesError"),
)

private val DATE_RE = Regex("^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})")

/** "2026-10-13T09:12" → "13/10/26 09:12" (dates are local in the files). */
fun fmtTodoDate(s: String?): String {
    val m = DATE_RE.find(s ?: "") ?: return "—"
    val (y, mo, d, h, mi) = m.destructured
    return "$d/$mo/${y.substring(2)} $h:$mi"
}

private val TYPE = mapOf("fonctionnalite" to "Fonctionnalité", "correction" to "Correction", "projet" to "Projet")
private val STATUS = mapOf("todo" to "○ Non fait", "progress" to "◐ En cours", "done" to "✓ Fait")

fun typeLabel(type: String?): String? = type?.let { TYPE[it] }

fun statusLabel(i: TodoItem): String = if (i.rejected) "✕ Rejeté" else STATUS[i.status] ?: i.status

fun addedLabel(i: TodoItem): String = (if (i.addedEstimated) "≈ " else "") + fmtTodoDate(i.addedAt)

/** Mark next to a done item: the musician who ticked it, or the rejection. */
fun doneMark(i: TodoItem): String? = when {
    !i.isDone -> null
    i.rejected -> "✕ rejeté (${fmtTodoDate(i.rejectedAt)}) par l’utilisateur"
    i.doneBy != null -> "✓ ${i.doneBy}"
    else -> "✓ —"
}

fun notesMark(i: TodoItem): String? = if (i.notes.isEmpty()) null else "✎ ${i.notes.size}"

fun canReject(i: TodoItem): Boolean = !i.isDone

/** (open, done) items of [project] (null = all), in the order served (the user's order). */
fun splitParts(items: List<TodoItem>, project: String?): Pair<List<TodoItem>, List<TodoItem>> {
    val shown = items.filter { project == null || it.project == project }
    return shown.filter { !it.isDone } to shown.filter { it.isDone }
}

private fun statusWord(status: String): String =
    (STATUS[status] ?: status).replaceFirst(Regex("^\\S+\\s"), "").lowercase()

private fun notesBlock(notes: List<TodoNote>): String =
    if (notes.isEmpty()) "" else "Notes de l’utilisateur :\n" + notes.joinToString("\n") { n ->
        "- " + (if (!n.at.isNullOrEmpty()) "(${fmtTodoDate(n.at)}) " else "") + n.text
    }

private fun sourceLine(i: TodoItem) = "(Item ${i.id}, ${i.project}/TODO_LIST.md ligne ${i.line}, ${statusWord(i.status)}.)"

/** Same text as TodoPanel.chefMessage (send the item to the chef to run it). */
fun chefMessage(i: TodoItem): String = listOf(
    "Item de la TODO de ${i.project} à exécuter : ${i.title}",
    i.full,
    i.more.orEmpty(),
    notesBlock(i.notes),
    sourceLine(i),
).filter { it.isNotEmpty() }.joinToString("\n\n")

const val DISCUSS_PREFIX = "/chef-discussion"

/** Same text as TodoPanel.discussMessage (discuss the item, nothing is launched). */
fun discussMessage(i: TodoItem): String = listOf(
    DISCUSS_PREFIX,
    "Item de la TODO de ${i.project} à DISCUTER (ne pas le lancer) : ${i.title}",
    i.full,
    i.more.orEmpty(),
    notesBlock(i.notes),
    sourceLine(i),
    "Ma question / ce dont je veux discuter : ",
).filter { it.isNotEmpty() }.joinToString("\n\n")

/**
 * New whole order after moving [key] one step ([dir] -1 up, +1 down) inside
 * [part] (the visible items of one part, maybe filtered on a project): the
 * slots of the visible items in the global order are refilled in the new
 * order, as saveOrder() of the web. Null when the item cannot move.
 */
fun movedOrder(all: List<TodoItem>, part: List<TodoItem>, key: String, dir: Int): List<String>? {
    val visible = part.map { it.key }.toMutableList()
    val at = visible.indexOf(key)
    val to = at + dir
    if (at < 0 || to < 0 || to >= visible.size) return null
    visible[at] = visible[to].also { visible[to] = key }
    val shown = visible.toSet()
    var k = 0
    return all.map { if (it.key in shown) visible[k++] else it.key }
}

fun orderBody(keys: List<String>): JsonElement = buildJsonObject {
    putJsonArray("keys") { keys.forEach { add(JsonPrimitive(it)) } }
}

const val NOTE_MAX = 4000

fun noteProblem(text: String): String? {
    val t = text.trim()
    return when {
        t.isEmpty() -> "La note est vide."
        t.length > NOTE_MAX -> "Note trop longue (${t.length} caractères, $NOTE_MAX au plus)."
        else -> null
    }
}

fun noteBody(text: String): JsonElement = buildJsonObject { put("text", text.trim()) }

fun rejectError(code: Int, error: String?): String = "Item non rejeté : " + (error ?: when (code) {
    409 -> "item déjà fait ou déjà rejeté"
    423 -> "la liste est en cours d’écriture par le musicien, réessayez dans un instant"
    else -> "erreur $code"
})
