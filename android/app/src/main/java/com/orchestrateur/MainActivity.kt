package com.orchestrateur

import android.os.Bundle
import android.widget.Toast
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModel
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.orchestrateur.ui.common.AppEnv
import com.orchestrateur.ui.common.IdentifyDialog
import com.orchestrateur.ui.common.LocalEnv
import com.orchestrateur.ui.fleet.AnswerContext
import com.orchestrateur.ui.fleet.FleetViewModel
import com.orchestrateur.ui.fleet.JournalScreen
import com.orchestrateur.ui.fleet.MusicianDetailScreen
import com.orchestrateur.ui.login.LoginScreen
import com.orchestrateur.ui.more.MoreScreen
import com.orchestrateur.ui.more.ROUTE_MORE
import com.orchestrateur.ui.more.Section
import com.orchestrateur.ui.more.SectionScreen
import com.orchestrateur.ui.projects.SessionsScreen
import com.orchestrateur.ui.theme.OrchestreTheme

/**
 * Navigation: Journal (root) · Musician detail · « Plus » hub and one
 * destination per dashboard section (1.0.0, ui/more/Sections.kt).
 *
 * The ViewModel is created HERE, at ACTIVITY scope, and shared: otherwise each
 * NavBackStackEntry would build its own (new SSE, thread reloaded, anchor lost).
 * The live stream follows the ACTIVITY lifecycle (1.0.0): it used to follow the
 * journal's back-stack entry and stopped whenever another screen was open.
 */
class MainActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val app = application as OrchestreApp
        startPresenceLoop()

        setContent {
            OrchestreTheme(textScale = app.uiPrefs.textScale, palette = app.uiPrefs.palette) {
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
                    val owner = LocalLifecycleOwner.current
                    DisposableEffect(owner) {
                        val observer = LifecycleEventObserver { _, event ->
                            when (event) {
                                Lifecycle.Event.ON_START -> vm.resumeStream()
                                Lifecycle.Event.ON_STOP -> vm.pauseStream()
                                else -> {}
                            }
                        }
                        owner.lifecycle.addObserver(observer)
                        onDispose { owner.lifecycle.removeObserver(observer) }
                    }
                    val nav = rememberNavController()
                    var idRef by remember { mutableStateOf<Triple<String?, String, String?>?>(null) }
                    val env = remember(vm) {
                        AppEnv(
                            api = app.api,
                            prefs = app.uiPrefs,
                            tts = app.tts,
                            openMusician = { nav.navigate(routeDetail(it)) },
                            navigate = { r -> if (r == ROUTE_JOURNAL) nav.popBackStack(ROUTE_JOURNAL, false) else nav.navigate(r) },
                            back = { nav.popBackStack() },
                            prepareChef = { text -> vm.prepareChefMessage(text); nav.popBackStack(ROUTE_JOURNAL, false) },
                            openId = { kind, value, project -> idRef = Triple(kind, value, project) },
                            toast = { msg -> Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() },
                            conductor = { FleetViewModel.CONDUCTOR },
                            projectNames = { vm.musicians.map { it.name } },
                        )
                    }
                    CompositionLocalProvider(LocalEnv provides env) {
                        NavHost(navController = nav, startDestination = ROUTE_JOURNAL) {
                            composable(ROUTE_JOURNAL) {
                                JournalScreen(
                                    vm = vm,
                                    onOpenMusician = { nav.navigate(routeDetail(it)) },
                                    onOpenSettings = { nav.navigate(ROUTE_MORE) },
                                )
                            }
                            composable(ROUTE_DETAIL) { entry ->
                                MusicianDetailScreen(
                                    vm = vm,
                                    name = entry.arguments?.getString("name").orEmpty(),
                                    onBack = { nav.popBackStack() },
                                    onTalkToChef = { name ->
                                        vm.applyAnswerContext(AnswerContext(name, about = true))
                                        nav.popBackStack(ROUTE_JOURNAL, false)
                                    },
                                )
                            }
                            composable(ROUTE_MORE) { MoreScreen() }
                            composable(ROUTE_SESSIONS) { entry -> SessionsScreen(entry.arguments?.getString("name").orEmpty()) }
                            Section.entries.forEach { s -> composable(s.route) { SectionScreen(s) } }
                        }
                        idRef?.let { (k, v, p) -> IdentifyDialog(k, v, p) { idRef = null } }
                    }
                }
            }
        }
    }

    // Presence heartbeat (0.13.0 / server 0.123.0): a user reading the app is not
    // inactive. One beat a minute at most, while in the foreground and touched
    // in the last 10 minutes.
    private var lastInteraction = 0L
    private var lastBeat = 0L

    private fun beat(kind: String) {
        val now = System.currentTimeMillis()
        if (now - lastBeat < HEARTBEAT_MS) return
        lastBeat = now
        val app = application as OrchestreApp
        lifecycleScope.launch { app.api.userActivity(kind) }
    }

    override fun onUserInteraction() {
        super.onUserInteraction()
        lastInteraction = System.currentTimeMillis()
        beat("présence")
    }

    override fun onResume() {
        super.onResume()
        lastInteraction = System.currentTimeMillis()
        beat("retour")
    }

    private fun startPresenceLoop() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                while (true) {
                    delay(15_000)
                    if (System.currentTimeMillis() - lastInteraction < PRESENCE_WINDOW_MS) beat("lecture")
                }
            }
        }
    }

    companion object {
        const val HEARTBEAT_MS = 60_000L
        const val PRESENCE_WINDOW_MS = 10 * 60_000L
        const val ROUTE_JOURNAL = "journal"
        const val ROUTE_DETAIL = "musicien/{name}"
        const val ROUTE_SESSIONS = "sessions/{name}"
        fun routeDetail(name: String) = "musicien/$name"
        fun routeSessions(name: String) = "sessions/$name"
    }
}
