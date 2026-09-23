package com.orchestrateur

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.orchestrateur.ui.fleet.FleetViewModel
import com.orchestrateur.ui.fleet.JournalScreen
import com.orchestrateur.ui.fleet.MusicianDetailScreen
import com.orchestrateur.ui.fleet.SettingsScreen
import com.orchestrateur.ui.login.LoginScreen
import com.orchestrateur.ui.theme.OrchestreTheme

/**
 * v0.6.0 — la navigation passe d'un `setContent` unique à un NavHost à TROIS
 * destinations : Journal (racine) · Détail musicien · Réglages.
 *
 * Le ViewModel est créé ICI, à l'échelle de l'ACTIVITÉ, et passé aux
 * destinations : sans cela chaque `NavBackStackEntry` en créerait un nouveau
 * (nouveau SSE, fil rechargé, ancre perdue). C'est ce qui garantit que le
 * retour depuis le détail rend le journal à la même ancre.
 */
class MainActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val app = application as OrchestreApp

        setContent {
            OrchestreTheme {
                var unlocked by remember { mutableStateOf(false) }
                if (!unlocked) {
                    LoginScreen(
                        store = app.serverStore,
                        onUnlocked = { unlocked = true },
                    )
                } else {
                    val context = LocalContext.current
                    val vm: FleetViewModel = viewModel(
                        factory = object : ViewModelProvider.Factory {
                            @Suppress("UNCHECKED_CAST")
                            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                                FleetViewModel(app.api, context.applicationContext) as T
                        }
                    )
                    val nav = rememberNavController()
                    NavHost(navController = nav, startDestination = ROUTE_JOURNAL) {
                        composable(ROUTE_JOURNAL) {
                            JournalScreen(
                                vm = vm,
                                onOpenMusician = { nav.navigate(routeDetail(it)) },
                                onOpenSettings = { nav.navigate(ROUTE_SETTINGS) },
                            )
                        }
                        composable(ROUTE_DETAIL) { entry ->
                            MusicianDetailScreen(
                                vm = vm,
                                name = entry.arguments?.getString("name").orEmpty(),
                                onBack = { nav.popBackStack() },
                                onTalkToChef = { name ->
                                    vm.applyAnswerContext(
                                        com.orchestrateur.ui.fleet.AnswerContext(name, about = true)
                                    )
                                    nav.popBackStack()
                                },
                            )
                        }
                        composable(ROUTE_SETTINGS) {
                            SettingsScreen(vm = vm, onBack = { nav.popBackStack() })
                        }
                    }
                }
            }
        }
    }

    companion object {
        const val ROUTE_JOURNAL = "journal"
        const val ROUTE_DETAIL = "musicien/{name}"
        const val ROUTE_SETTINGS = "reglages"
        fun routeDetail(name: String) = "musicien/$name"
    }
}
