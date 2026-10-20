package com.orchestrateur.ui.panels

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.clickable
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.a
import com.orchestrateur.data.enc
import com.orchestrateur.data.getJson
import com.orchestrateur.data.postJson
import com.orchestrateur.data.s
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.SectionTitle
import com.orchestrateur.ui.common.Tag
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val PREF_PROJECT = "todo.filter.project"

/** « ☑ TODO » panel: every musician's TODO list (public/todo-panel.js). */
@Composable
fun TodoScreen() {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val prefs = rememberPanelPrefs()
    val (savedProject, setProject) = rememberPref(prefs, PREF_PROJECT)
    val loaded = rememberLoad(refreshMs = 15_000) { parseTodoData(env.api.getJson("/api/todo").orThrow().json) }
    // Local copy so a move shows at once, replaced by every refresh.
    var data by remember { mutableStateOf<TodoData?>(null) }
    LaunchedEffect(loaded.value) { loaded.value?.let { data = it } }
    var orderMsg by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var openKey by remember { mutableStateOf<String?>(null) }
    var lastOpen by remember { mutableStateOf<TodoItem?>(null) }
    val drafts = remember { mutableStateMapOf<String, String>() }

    val d = data
    val project = savedProject.takeIf { d != null && it in d.projects }

    fun move(part: List<TodoItem>, item: TodoItem, dir: Int) {
        val cur = data ?: return
        val keys = movedOrder(cur.items, part, item.key, dir) ?: return
        val byKey = cur.items.associateBy { it.key }
        data = cur.copy(items = keys.mapNotNull { byKey[it] })
        orderMsg = "Enregistrement de l’ordre…" to false
        scope.launch {
            val r = env.api.postJson("/api/order/todo", orderBody(keys))
            if (r.ok && r.json.s("error") == null) {
                orderMsg = "Ordre enregistré." to false
                delay(4000)
                if (orderMsg?.first == "Ordre enregistré.") orderMsg = null
            } else {
                orderMsg = "Ordre non enregistré : ${r.errorText()}" to true
                loaded.reload()
            }
        }
    }

    SectionScaffold("☑ TODO", subtitle = d?.let { "${it.openCount} non fait${if (it.openCount > 1) "s" else ""} · lecture seule : seuls les musiciens cochent" }) {
        Picker(
            "Projet", project.orEmpty(),
            listOf(PickerOption("", "Tous les projets (${d?.projects?.size ?: 0})")) + (d?.projects ?: emptyList()).map { PickerOption(it, it) },
            onPick = setProject,
        )
        when {
            d == null && loaded.error != null -> ErrorLine("Liste indisponible : ${loaded.error}", loaded.reload)
            d == null -> LoadingLine()
            else -> {
                val (open, done) = splitParts(d.items, project)
                LazyColumn(contentPadding = ListPadding) {
                    d.orderError?.let { item { Text("Ordre personnalisé illisible : $it", color = Palette.StError, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp)) } }
                    orderMsg?.let { (m, bad) -> item { Text(m, color = if (bad) Palette.StError else Palette.Fg2, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp)) } }
                    if (open.isEmpty() && done.isEmpty()) item { EmptyLine("Aucun item${project?.let { " pour $it" } ?: ""}.") }
                    else {
                        item { SectionTitle("Non faits  ${open.size}") }
                        items(open, key = { "o:" + it.key }) { i -> TodoRow(i, open, onOpen = { openKey = i.key; lastOpen = i }, onMove = { dir -> move(open, i, dir) }) }
                        item { SectionTitle("Faits  ${done.size}") }
                        items(done, key = { "d:" + it.key }) { i -> TodoRow(i, done, onOpen = { openKey = i.key; lastOpen = i }, onMove = { dir -> move(done, i, dir) }) }
                    }
                }
            }
        }
    }

    val key = openKey
    if (key != null) {
        // Kept in step with the 15 s refresh; an item that left the list stays shown as it was.
        val item = data?.items?.firstOrNull { it.key == key } ?: lastOpen
        if (item != null) TodoItemDialog(
            item = item,
            draft = drafts[key].orEmpty(),
            onDraft = { drafts[key] = it },
            onNotes = { notes ->
                drafts.remove(key)
                data = data?.let { cur -> cur.copy(items = cur.items.map { if (it.key == key) it.copy(notes = notes) else it }) }
                lastOpen = item.copy(notes = notes)
            },
            onChanged = { loaded.reload() },
            onDismiss = { openKey = null },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TodoRow(i: TodoItem, part: List<TodoItem>, onOpen: () -> Unit, onMove: (Int) -> Unit) {
    val idx = part.indexOfFirst { it.key == i.key }
    Card(onClick = onOpen) {
        Row(verticalAlignment = Alignment.Top) {
            Text(if (i.isDone) "☑" else "☐", color = if (i.rejected) Palette.StError else Palette.Fg2, fontSize = 18.sp, modifier = Modifier.padding(end = 8.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    i.title, color = if (i.isDone) Palette.Fg2 else Palette.Fg0, fontSize = 14.sp,
                    textDecoration = if (i.rejected) TextDecoration.LineThrough else null,
                )
                if (i.detail.isNotEmpty()) Text(i.detail, color = Palette.Fg2, fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    doneMark(i)?.let { Text(it, color = if (i.rejected) Palette.StError else Palette.StLive, fontSize = 11.sp) }
                    Tag(i.project)
                    Text(addedLabel(i), color = Palette.Fg2, fontSize = 11.sp)
                    typeLabel(i.type)?.let { Tag(it, Palette.Accent) }
                    if (i.status == "progress") Text("◐ en cours", color = Palette.StUnread, fontSize = 11.sp)
                    notesMark(i)?.let { Text(it, color = Palette.Accent, fontSize = 11.sp) }
                }
            }
            // An item never leaves its part: ↑ / ↓ only inside it.
            Column {
                MoveButton("↑", enabled = idx > 0) { onMove(-1) }
                MoveButton("↓", enabled = idx in 0 until part.size - 1) { onMove(1) }
            }
        }
    }
}

@Composable
private fun MoveButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(44.dp).then(if (enabled) Modifier.clickable { onClick() } else Modifier),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = if (enabled) Palette.Fg1 else Palette.Fg3, fontSize = 18.sp) }
}

private enum class Confirm { NONE, RUN, DISCUSS, REJECT }

@Composable
private fun TodoItemDialog(
    item: TodoItem,
    draft: String,
    onDraft: (String) -> Unit,
    onNotes: (List<TodoNote>) -> Unit,
    onChanged: () -> Unit,
    onDismiss: () -> Unit,
) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    var confirm by remember(item.key) { mutableStateOf(Confirm.NONE) }
    var noteMsg by remember(item.key) { mutableStateOf<Pair<String, Boolean>?>(null) }
    var rejectMsg by remember(item.key) { mutableStateOf<Pair<String, Boolean>?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun addNote() {
        if (busy) return
        noteProblem(draft)?.let { noteMsg = it to true; return }
        busy = true
        noteMsg = "Enregistrement…" to false
        scope.launch {
            val r = env.api.postJson("/api/notes/todo/${enc(item.project)}/${enc(item.id)}", noteBody(draft))
            busy = false
            if (r.ok && r.json.s("error") == null) {
                onNotes(r.json.a("notes").map(::parseTodoNote))
                noteMsg = "Note enregistrée." to false
            } else noteMsg = "Note non enregistrée : ${r.errorText()}" to true
        }
    }

    fun reject() {
        if (busy) return
        busy = true
        rejectMsg = "Rejet en cours…" to false
        scope.launch {
            val r = env.api.postJson("/api/reject/todo/${enc(item.project)}/${enc(item.id)}")
            busy = false
            if (r.ok && r.json.s("error") == null) {
                confirm = Confirm.NONE
                rejectMsg = null
                env.toast("Item rejeté.")
                onChanged()
            } else rejectMsg = rejectError(r.code, r.json.s("error") ?: if (r.code < 0) r.errorText() else null) to true
        }
    }

    PanelDialog(
        title = item.title,
        onDismiss = { if (confirm != Confirm.NONE) confirm = Confirm.NONE else onDismiss() },
        footer = {
            when (confirm) {
                Confirm.NONE -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Column(Modifier.weight(1f)) {
                        PillButton("Envoyer au chef…", Modifier.fillMaxWidth()) { confirm = Confirm.RUN }
                        PillButton("💬 Discuter avec le chef…", Modifier.fillMaxWidth()) { confirm = Confirm.DISCUSS }
                        if (canReject(item)) PillButton("Rejeter l’item…", Modifier.fillMaxWidth(), color = Palette.StError) { confirm = Confirm.REJECT; rejectMsg = null }
                    }
                }
                Confirm.RUN, Confirm.DISCUSS -> {
                    val run = confirm == Confirm.RUN
                    PillButton(if (run) "Placer dans le message au chef" else "Placer dans le message au chef (discussion)", Modifier.fillMaxWidth()) {
                        val text = if (run) chefMessage(item) else discussMessage(item)
                        onDismiss()
                        env.prepareChef(text)
                    }
                    PillButton("Annuler", Modifier.fillMaxWidth(), color = Palette.Fg1) { confirm = Confirm.NONE }
                }
                Confirm.REJECT -> {
                    PillButton("Rejeter l’item", Modifier.fillMaxWidth(), color = Palette.StError, enabled = !busy) { reject() }
                    PillButton("Annuler", Modifier.fillMaxWidth(), color = Palette.Fg1) { confirm = Confirm.NONE }
                }
            }
        },
    ) {
        when (confirm) {
            Confirm.RUN, Confirm.DISCUSS -> {
                val run = confirm == Confirm.RUN
                Text(if (run) "Envoyer cet item au chef ?" else "Discuter de cet item avec le chef ?", color = Palette.Fg0, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    if (run) "Ce message sera placé dans votre saisie au chef. Il partira quand vous l’enverrez (Entrée ou ➤), comme tout message au chef, qui en lancera l’exécution."
                    else "Ce message sera placé dans votre saisie au chef, pour en DISCUTER : ajoutez votre question à la fin, puis envoyez-le (Entrée ou ➤). Le chef répond dans le fil ; rien n’est lancé (aucune tâche, aucun musicien).",
                    color = Palette.Fg2, fontSize = 12.sp,
                )
                Text("⚠ Votre brouillon actuel au chef, s’il y en a un, sera remplacé.", color = Palette.Fg2, fontSize = 12.sp)
                SelectionContainer {
                    Text(if (run) chefMessage(item) else discussMessage(item), color = Palette.Fg1, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
                }
            }
            Confirm.REJECT -> {
                Text("Rejeter cet item ?", color = Palette.Fg0, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                Text("Il sera marqué « rejeté (date) par l’utilisateur » dans le TODO_LIST.md de ${item.project}, que le musicien lit, et passera dans les faits, barré.",
                    color = Palette.Fg2, fontSize = 12.sp)
                rejectMsg?.let { (m, bad) -> Text(m, color = if (bad) Palette.StError else Palette.Fg2, fontSize = 12.sp) }
            }
            Confirm.NONE -> ItemBody(item, draft, onDraft, noteMsg, busy, ::addNote)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ItemBody(item: TodoItem, draft: String, onDraft: (String) -> Unit, noteMsg: Pair<String, Boolean>?, busy: Boolean, addNote: () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Tag(statusLabel(item), if (item.rejected) Palette.StError else if (item.isDone) Palette.StLive else Palette.Fg1)
        Tag(item.project)
        typeLabel(item.type)?.let { Tag(it, Palette.Accent) }
    }
    KeyValue("Entrée", addedLabel(item) + if (item.addedEstimated) "  (date estimée : date du fichier)" else "")
    if (item.isDone) when {
        item.rejected -> KeyValue("Rejeté", "rejeté (${fmtTodoDate(item.rejectedAt)}) par l’utilisateur", Palette.StError)
        item.doneBy != null -> KeyValue("Fait", "${fmtTodoDate(item.doneAt)} par ${item.doneBy}")
        else -> KeyValue("Fait", "coché à la main (nom non enregistré)")
    }
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (item.full.isNotEmpty()) Text(item.full, color = Palette.Fg0, fontSize = 13.sp)
            item.more?.let { Text(it, color = Palette.Fg1, fontSize = 13.sp) }
        }
    }
    if (item.full.isEmpty() && item.more == null) Text("Aucun détail : l’item tient en son titre.", color = Palette.Fg2, fontSize = 12.sp)
    Text("${item.project}/TODO_LIST.md, ligne ${item.line} · ${item.id}", color = Palette.Fg3, fontSize = 11.sp, fontFamily = FontFamily.Monospace)

    SubHeading("Notes" + if (item.notes.isNotEmpty()) " (${item.notes.size})" else "")
    if (item.notes.isEmpty()) Text("Aucune note pour l’instant.", color = Palette.Fg2, fontSize = 12.sp)
    for (n in item.notes) Column(Modifier.padding(vertical = 2.dp)) {
        Text(fmtTodoDate(n.at) + (n.by?.let { " · $it" } ?: ""), color = Palette.Fg2, fontSize = 11.sp)
        Text(n.text, color = Palette.Fg0, fontSize = 13.sp)
    }
    OutlinedTextField(
        value = draft, onValueChange = { if (it.length <= NOTE_MAX) onDraft(it) },
        label = { Text("Ajouter une note") }, placeholder = { Text("Votre note sur cet item") },
        minLines = 2, modifier = Modifier.fillMaxWidth(),
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(noteMsg?.first.orEmpty(), color = if (noteMsg?.second == true) Palette.StError else Palette.Fg2, fontSize = 12.sp, modifier = Modifier.weight(1f))
        PillButton("Ajouter la note", enabled = !busy, onClick = addNote)
    }
}
