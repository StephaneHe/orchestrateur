package com.orchestrateur.ui.ops

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.data.deleteJson
import com.orchestrateur.data.getJson
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.EmptyLine
import com.orchestrateur.ui.common.ErrorLine
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LoadingLine
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.Mono
import com.orchestrateur.ui.common.PillButton
import com.orchestrateur.ui.common.SectionTitle
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.orThrow
import com.orchestrateur.ui.common.rememberLoad
import com.orchestrateur.ui.theme.Palette
import kotlinx.coroutines.launch

@Composable
fun PermissionRulesScreen() {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val confirm = rememberConfirmState()
    val load = rememberLoad { parseRules(env.api.getJson("/api/permission-rules").orThrow().json) }
    SectionScaffold("🔐 Autorisations permanentes") {
        val groups = load.value
        when {
            groups == null && load.error != null -> ErrorLine(load.error, load.reload)
            groups == null -> LoadingLine()
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
                item {
                    Text("Une règle laisse passer, sans vous déranger, les appels qu'elle couvre. Une règle de préfixe (Bash(git status:*)) ne couvre jamais une commande composite.",
                        color = Palette.Fg2, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
                }
                if (groups.isEmpty()) item { EmptyLine("Aucune règle permanente. « Toujours autoriser » en crée une, par projet.") }
                for (g in groups) {
                    item(key = "h-${g.project}") { SectionTitle(g.project) }
                    items(g.rules, key = { "r-${g.project}-${it.rule}" }) { r ->
                        Card {
                            Mono(r.rule, color = Palette.Fg0, size = 13)
                            Text(listOfNotNull(dayHhmm(r.createdAt).ifEmpty { null }, r.by).joinToString(" · "), color = Palette.Fg2, fontSize = 12.sp)
                            PillButton("Révoquer", color = Palette.StError) {
                                confirm.ask("Révoquer la règle ?", "${g.project} : ${r.rule}\nLes appels qu'elle couvre vous seront de nouveau demandés.", "Révoquer") {
                                    scope.launch {
                                        val res = env.api.deleteJson("/api/permission-rules", revokeBody(g.project, r.rule))
                                        if (res.ok) env.toast("Règle révoquée") else env.toast("Révocation impossible : ${res.errorText()}")
                                        load.reload()
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    ConfirmHost(confirm)
}
