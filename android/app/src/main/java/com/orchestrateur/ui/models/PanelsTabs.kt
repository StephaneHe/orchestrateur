package com.orchestrateur.ui.models

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.deleteJson
import com.orchestrateur.data.enc
import com.orchestrateur.data.getJson
import com.orchestrateur.data.postJson
import com.orchestrateur.data.putJson
import com.orchestrateur.data.s
import com.orchestrateur.data.o
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.ConfirmDialog
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.Mono
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.Tag
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.launch

private fun restartHint(code: Int, version: String, err: String) =
    if (code == 404) "Le serveur ne connaît pas encore cette section : il doit être redémarré (version ≥ $version)." else "Chargement impossible : $err"

// ---------------------------------------------------------------- Mise en service

@Composable
fun HealthTab() {
    val env = LocalEnv.current
    val load = rememberLoad("health") {
        val r = env.api.getJson("/api/pipeline-health?refresh=1")
        if (!r.ok) error(restartHint(r.code, "0.56.0", r.errorText()))
        parseHealth(r.json)
    }
    val h = load.value
    LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
        item { Card { Body("Mise en service générale", Palette.Fg0, 15, FontWeight.SemiBold) } }
        when {
            h == null && load.error != null -> item { ErrorLine(load.error) { load.reload() } }
            h == null -> item { LoadingLine("Chargement du relevé…") }
            h.since == null -> item { Card { Dim("Aucune mise en service générale pour l’instant.") } }
            else -> {
                item {
                    Card {
                        Body("Depuis le ${fmtTime(h.since)} : ${h.projects} projet(s) en service" +
                            (if (h.chef) ", tour du chef en Routage" else "") + (if (h.terminal) ", terminal routé" else "") + ".")
                        Body(h.streakText, Palette.Fg0, weight = FontWeight.SemiBold)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Tag(if (h.met) "✓ critère atteint" else "critère en cours", if (h.met) Ok else Palette.Fg1)
                            if (h.bypass > 0) Tag("${h.bypass} contournement(s) relevé(s)", Warn)
                        }
                    }
                }
                item { HealthRowCard(h.totals, bold = true) }
                item { SectionLabel("Relevé par jour") }
                if (h.days.isEmpty()) item { Card { Dim("Aucun tour depuis la mise en service.") } }
                items(h.days) { HealthRowCard(it) }
                item { SectionLabel("Relevé par projet") }
                items(h.perProject) { HealthRowCard(it) }
            }
        }
        item { Row(Modifier.padding(horizontal = 12.dp)) { PillButton("↻ Actualiser") { load.reload() } } }
    }
}

@Composable
private fun SectionLabel(t: String) {
    Text(t.uppercase(), color = Palette.Fg2, fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 2.dp))
}

@Composable
private fun HealthRowCard(x: HealthRow, bold: Boolean = false) {
    Card(border = if (x.bypass > 0) Warn.copy(alpha = 0.6f) else Palette.CardBorder) {
        Body(x.label, Palette.Fg0, weight = if (bold) FontWeight.SemiBold else FontWeight.Normal)
        Dim(x.text, if (x.bypass > 0) Warn else Palette.Fg1)
    }
}

// ---------------------------------------------------------------- Observation

@Composable
fun ObserveTab(st: ModelsState) {
    val env = LocalEnv.current
    val load = rememberLoad("observe") {
        val r = env.api.getJson("/api/pipeline-observe?n=100")
        if (!r.ok) error(restartHint(r.code, "0.41.0", r.errorText()))
        parseObserve(r.json)
    }
    val o = load.value
    val labels = st.pipelineLabels
    LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
        item {
            Card {
                Body("Classifications récentes", Palette.Fg0, 15, FontWeight.SemiBold)
                Dim("Observation. Chaque entrée (composer, @musicien, app, dispatch.mjs, file, réveil, relais, notify, session neuve, " +
                    "terminal interactif) est journalisée avec son choix explicite (préfixe /dev, /complet…) s’il y en a un. " +
                    "Aucun classement par mots-clés : le reste est classé par le sens, par le model de la case « routage.classifier » " +
                    "(${o?.total ?: 0} entrées journalisées).", Palette.Fg1)
            }
        }
        when {
            o == null && load.error != null -> item { ErrorLine(load.error) { load.reload() } }
            o == null -> item { LoadingLine("Chargement des classifications…") }
            else -> {
                item {
                    Card {
                        if (o.byPipeline.isEmpty()) Dim("Aucune entrée pour l’instant.")
                        ObsChips(o, labels)
                    }
                }
                items(o.items) { x ->
                    Card {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Mono(fmtTime(x.at), Palette.Fg2, 11)
                            Mono(x.entry, Palette.Fg1, 11)
                            x.confidence?.let { Mono(it, Palette.Fg3, 11) }
                        }
                        Dim(x.who, Palette.Fg1)
                        Body(obsTags(x, labels), Palette.Fg0, 12, FontWeight.SemiBold)
                        if (x.head.isNotEmpty()) Dim(x.head)
                        if (x.reasons.isNotEmpty()) Dim(x.reasons.joinToString(" ; "), Palette.Fg3, 11)
                    }
                }
            }
        }
        item { Row(Modifier.padding(horizontal = 12.dp)) { PillButton("↻ Actualiser") { load.reload() } } }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ObsChips(o: Observe, labels: Map<String, String>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        o.byPipeline.forEach { (p, n) -> Tag("${pipelineLabel(p, labels)} $n") }
        if (o.unclassifiable > 0) Tag("inclassables ${o.unclassifiable}", Warn)
    }
}

// ---------------------------------------------------------------- Lacunes

@Composable
fun GapsTab(st: ModelsState, openSteps: () -> Unit) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val busy = remember { mutableStateMapOf<String, Boolean>() }
    LaunchedEffect(Unit) { st.gapNotice = null; st.loadGaps(env.api) }
    val g = st.gaps
    // Only gaps actually displayed to the user are reported as presented.
    val shownKeys = g?.let { presentedKeys(it) } ?: emptyList()
    LaunchedEffect(shownKeys) { st.markPresented(env.api, shownKeys) }
    val labels = st.pipelineLabels
    LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
        item {
            Card {
                Body("Lacunes proposées", Palette.Fg0, 15, FontWeight.SemiBold)
                Dim("Quand une demande ou une étape ne rentre dans aucun pipeline, ou seulement de façon floue, elle n’est pas classée de force : " +
                    "elle est traitée en Discussion et une proposition arrive ici (et au chef). Accepter ajoute la tâche à la structure ; il reste à lui choisir un model.",
                    Palette.Fg1)
                st.gapNotice?.let { Dim(it, if (it.startsWith("✓")) Ok else Warn) }
            }
        }
        when {
            g == null && st.gapsError != null -> item { ErrorLine(st.gapsError!!) { scope.launch { st.loadGaps(env.api) } } }
            g == null -> item { LoadingLine("Chargement des lacunes…") }
            else -> {
                if (g.open.isEmpty()) item { Card { Dim("Aucune lacune ouverte.") } }
                items(g.open, key = { it.key }) { x ->
                    val decide: (Boolean, String) -> Unit = { accept, choice ->
                        busy[x.key] = true
                        scope.launch {
                            val moved = st.decideGap(env.api, x.key, accept, choice)
                            busy.remove(x.key)
                            if (moved) openSteps()
                        }
                    }
                    val off = busy[x.key] == true
                    Card {
                        Body("« ${x.head} »", Palette.Fg0, weight = FontWeight.SemiBold)
                        Dim("${x.entry}${x.project?.let { " · $it" } ?: ""} · ${x.count} fois · ${fmtTime(x.lastAt)}")
                        Dim("${x.why} — traitée en ${pipelineLabel(x.pipeline ?: "discussion", labels)} en attendant.", Palette.Fg1)
                        x.proposal?.let { pr ->
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) { Tag(pr.kindLabel); Dim(pr.text, Palette.Fg1) }
                            PillButton("✓ Accepter", color = Ok, enabled = !off) { decide(true, "primary") }
                        }
                        x.alternative?.let { pr ->
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) { Tag(pr.kindLabel); Dim(pr.text, Palette.Fg1) }
                            PillButton("✓ Accepter l’alternative", color = Ok, enabled = !off) { decide(true, "alternative") }
                        }
                        PillButton("✕ Rejeter", color = Palette.StError, enabled = !off) { decide(false, "primary") }
                    }
                }
                if (g.decided.isNotEmpty()) item {
                    Card {
                        Fold("Déjà traitées (${g.decided.size})", "gaps-decided") {
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) { g.decided.forEach { Dim(it, Palette.Fg1) } }
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- Clés API

@Composable
fun KeysTab(st: ModelsState) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    var keys by remember { mutableStateOf<List<ApiKey>?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    val notice = remember { mutableStateMapOf<String, String>() }
    val drafts = remember { mutableStateMapOf<String, String>() }
    var confirmDel by remember { mutableStateOf<ApiKey?>(null) }
    suspend fun reload() {
        val r = env.api.getJson("/api/api-keys")
        if (r.ok) { keys = parseKeys(r.json); err = null } else err = restartHint(r.code, "0.43.0", r.errorText())
    }
    LaunchedEffect(Unit) { reload() }
    fun act(k: ApiKey, action: String) {
        scope.launch {
            val r = when (action) {
                "save" -> {
                    val value = (drafts[k.name] ?: "").trim()
                    drafts.remove(k.name)   // the value stays neither in the field nor in memory
                    if (value.isEmpty()) { notice[k.name] = "Collez d’abord une clé."; return@launch }
                    notice[k.name] = "Enregistrement et vérification…"
                    env.api.putJson("/api/api-keys/${enc(k.name)}", keyBody(value))
                }
                "test" -> { notice[k.name] = "Vérification…"; env.api.postJson("/api/api-keys/${enc(k.name)}/test") }
                else -> env.api.deleteJson("/api/api-keys/${enc(k.name)}")
            }
            notice[k.name] = if (r.ok) keyNotice(action, r.json) else "Échec : ${r.errorText()}"
            reload()
            // The OpenRouter group of the menus depends on the key.
            if (r.ok) st.reloadCatalog(env.api)
        }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
        item {
            Card {
                val n = keys?.let { keysToFix(it) } ?: 0
                Body(if (n > 0) "Clés API ($n à régler)" else "Clés API", Palette.Fg0, 15, FontWeight.SemiBold)
                Dim("Les clés sont écrites dans le .env de l’orchestrateur (non versionné) et prises en compte immédiatement. " +
                    "Leur valeur n’est jamais renvoyée ni affichée : seuls ses 4 derniers caractères le sont.", Palette.Fg1)
            }
        }
        val ks = keys
        when {
            ks == null && err != null -> item { ErrorLine(err!!) { scope.launch { reload() } } }
            ks == null -> item { LoadingLine("Chargement de l’état des clés…") }
            else -> items(ks, key = { it.name }) { k -> KeyCard(k, drafts[k.name] ?: "", notice[k.name], { drafts[k.name] = it }, { act(k, it) }, { confirmDel = k }) }
        }
    }
    confirmDel?.let { k ->
        ConfirmDialog("Supprimer", "Retirer la clé ${k.label} du .env ?", confirm = "Supprimer",
            onConfirm = { act(k, "del") }, onDismiss = { confirmDel = null })
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun KeyCard(k: ApiKey, draft: String, notice: String?, onDraft: (String) -> Unit, onAct: (String) -> Unit, onDelete: () -> Unit) {
    Card {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Body(k.label, Palette.Fg0, weight = FontWeight.SemiBold)
            Tag(k.stateText, when { !k.configured -> Palette.Fg2; k.valid == false -> Palette.StError; k.valid == true -> Ok; else -> Palette.Fg1 })
            k.last4?.let { Mono("••••$it", Palette.Fg1, 11) }
        }
        val meta = listOfNotNull(k.source?.let { "source : $it" }, k.checkedAt?.let { "vérifiée ${fmtTime(it)}" })
        if (meta.isNotEmpty()) Dim(meta.joinToString(" · "))
        Dim(k.usage + (k.detail?.let { " — $it" } ?: ""), Palette.Fg1)
        OutlinedTextField(
            draft, onDraft, singleLine = true,
            placeholder = { Text(if (k.configured) "Remplacer la clé…" else "Coller la clé ${k.label}…") },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PillButton("Enregistrer") { onAct("save") }
            PillButton("Tester", color = Palette.Fg1, enabled = k.configured) { onAct("test") }
            PillButton("Supprimer", color = Palette.StError, enabled = k.deletable) { onDelete() }
        }
        if (!k.deletable && k.configured) Dim("Clé fournie par l’environnement du serveur", Palette.Fg3, 11)
        notice?.let { Dim(it, if (it.startsWith("Échec") || it.contains("refusée")) Palette.StError else Palette.Fg1) }
    }
}

// ---------------------------------------------------------------- Langues des models

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LangsTab() {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<ModelLangs?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    val busy = remember { mutableStateMapOf<String, Boolean>() }
    val discussion = rememberLoad("lang-default") { env.api.getJson("/api/language").orThrow().json.s("default") ?: "fr" }
    suspend fun reload() {
        val r = env.api.getJson("/api/model-languages")
        if (r.ok) { data = parseModelLangs(r.json); err = null } else err = restartHint(r.code, "0.51.0", r.errorText())
    }
    LaunchedEffect(Unit) { reload() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
        item {
            Card {
                Body("Langues des models", Palette.Fg0, 15, FontWeight.SemiBold)
                Dim("Un model qui écrit mal la langue de discussion travaille en anglais ; sa réponse destinée à l’utilisateur est reformulée " +
                    "automatiquement (⚠ langue). Valeurs par défaut prudentes : Claude, GPT et les grands models multilingues = toutes les langues ; " +
                    "inconnu = anglais seulement, jusqu’à vérification.", Palette.Fg1)
            }
        }
        val d = data
        when {
            d == null && err != null -> item { ErrorLine(err!!) { scope.launch { reload() } } }
            d == null -> item { LoadingLine() }
            d.models.isEmpty() -> item { Card { Dim("aucun model affecté dans les cases") } }
            else -> items(d.models, key = { it.model }) { m ->
                Card {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Mono(m.model, Palette.Fg0, 12)
                        m.provider?.let { Dim(it) }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        for (l in d.langs) {
                            val on = l in m.langs
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(on, onCheckedChange = { checked ->
                                    scope.launch {
                                        val r = env.api.putJson("/api/model-languages/${enc(m.model)}", langsBody(toggledLangs(m.langs, l, checked, d.langs)))
                                        if (r.ok) data = parseModelLangs(r.json) else env.toast("Langues de ${m.model} : ${r.errorText()}")
                                    }
                                }, colors = CheckboxDefaults.colors(checkedColor = Palette.Accent))
                                Dim(l, Palette.Fg1)
                            }
                        }
                    }
                    Dim(m.originText)
                    val b = busy[m.model] == true
                    PillButton(if (b) "essai en cours…" else "Tester la langue", enabled = !b) {
                        busy[m.model] = true
                        scope.launch {
                            val r = env.api.postJson("/api/model-languages/test", langTestBody(m.provider, m.model, discussion.value ?: "fr"))
                            if (r.json.o("models") != null) data = parseModelLangs(r.json)
                            val why = r.json.s("why")
                            if (!r.ok || (why != null && r.json.o("detected") == null)) env.toast("Essai de ${m.model} : ${why ?: r.errorText()}")
                            busy.remove(m.model)
                        }
                    }
                }
            }
        }
    }
}
