package com.orchestrateur.ui.more

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.orchestrateur.BuildConfig
import com.orchestrateur.ui.common.Card
import com.orchestrateur.ui.common.ListPadding
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.common.SectionScaffold
import com.orchestrateur.ui.common.SectionTitle
import com.orchestrateur.ui.models.ModelsScreen
import com.orchestrateur.ui.ops.AutoAnswerScreen
import com.orchestrateur.ui.ops.PermissionRulesScreen
import com.orchestrateur.ui.ops.PipelineRunsScreen
import com.orchestrateur.ui.ops.RegressionsScreen
import com.orchestrateur.ui.panels.GitScreen
import com.orchestrateur.ui.panels.ReleaseScreen
import com.orchestrateur.ui.panels.RequestsScreen
import com.orchestrateur.ui.panels.TodoScreen
import com.orchestrateur.ui.projects.AddProjectScreen
import com.orchestrateur.ui.projects.ProjectsScreen
import com.orchestrateur.ui.settings.SettingsPlusScreen
import com.orchestrateur.ui.theme.Palette

/**
 * Every dashboard area reachable from the app (1.0.0). docs/ANDROID-PARITY.md
 * names these routes; scripts/_test_android_parity.mjs checks each one is here.
 */
enum class Section(val route: String, val icon: String, val label: String, val about: String, val group: String) {
    PROJETS("projets", "🗂", "Projets", "Statut de chaque projet en un coup d’œil", "Flotte"),
    PIPELINES("pipelines", "⏸", "Exécutions de pipeline", "Frise des étapes, pauses et leurs choix, attentes", "Flotte"),
    REGRESSIONS("non-regressions", "🧪", "Non-régressions", "Lancements en cours et récents, rapports", "Flotte"),
    TODO("todo", "☑", "TODO", "Listes des musiciens : notes, rejet, ordre, envoi au chef", "Panneaux"),
    GIT("git", "⎇", "Git", "Arbre git de chaque musicien (lecture seule)", "Panneaux"),
    RELEASE("release", "📰", "Release", "Ce qui est prêt, regroupé par release", "Panneaux"),
    REQUETES("requetes", "🧭", "Requêtes", "Découpage de chaque requête et progrès des tâches", "Panneaux"),
    MODELS("models", "⇄", "Models", "Model de chaque étape, suggestions, lacunes, clés, langues", "Pilotage"),
    AUTO("reponse-auto", "🤖", "Réponse automatique", "Décisions prises à votre place, arriéré, réglages", "Pilotage"),
    REGLES("autorisations", "🔐", "Autorisations permanentes", "Règles « toujours autoriser » par projet", "Pilotage"),
    REGLAGES("reglages", "⚙", "Réglages", "Langue, fournisseur, taille du texte, palette, lecture audio, serveur", "Application"),
    NOUVEAU("nouveau-musicien", "＋", "Nouveau musicien", "Ajouter un projet à la flotte", "Application"),
}

/** Screen of a section (one composable per route). */
@Composable
fun SectionScreen(s: Section) = when (s) {
    Section.PROJETS -> ProjectsScreen()
    Section.PIPELINES -> PipelineRunsScreen()
    Section.REGRESSIONS -> RegressionsScreen()
    Section.TODO -> TodoScreen()
    Section.GIT -> GitScreen()
    Section.RELEASE -> ReleaseScreen()
    Section.REQUETES -> RequestsScreen()
    Section.MODELS -> ModelsScreen()
    Section.AUTO -> AutoAnswerScreen()
    Section.REGLES -> PermissionRulesScreen()
    Section.REGLAGES -> SettingsPlusScreen()
    Section.NOUVEAU -> AddProjectScreen()
}

const val ROUTE_MORE = "plus"

/** Hub listing every section, plus the server's web pages. */
@Composable
fun MoreScreen() {
    val env = LocalEnv.current
    val ctx = LocalContext.current
    fun openWeb(path: String) {
        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(env.api.baseUrl() + path))) }
            .onFailure { env.toast("impossible d’ouvrir $path") }
    }
    SectionScaffold("Plus", subtitle = "Orchestre ${BuildConfig.VERSION_NAME}") {
        LazyColumn(contentPadding = ListPadding) {
            Section.entries.groupBy { it.group }.forEach { (group, list) ->
                item { SectionTitle(group) }
                items(list) { s ->
                    Card(onClick = { env.navigate(s.route) }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(s.icon, fontSize = 18.sp, modifier = Modifier.padding(end = 10.dp))
                            Text(s.label, color = Palette.Fg0, fontSize = 15.sp)
                        }
                        Text(s.about, color = Palette.Fg2, fontSize = 12.sp)
                    }
                }
            }
            item { SectionTitle("Pages du serveur") }
            item {
                Card(onClick = { openWeb("/downloads") }) {
                    Text("⬇ Téléchargements", color = Palette.Fg0, fontSize = 15.sp)
                    Text("Page /downloads : APK et documents publiés", color = Palette.Fg2, fontSize = 12.sp)
                }
            }
            item {
                Card(onClick = { openWeb("/pupitre") }) {
                    Text("▤ Pupitre", color = Palette.Fg0, fontSize = 15.sp)
                    Text("Page /pupitre du serveur", color = Palette.Fg2, fontSize = 12.sp)
                }
            }
        }
    }
}
