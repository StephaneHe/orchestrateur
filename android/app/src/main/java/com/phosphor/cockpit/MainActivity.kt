package com.phosphor.cockpit

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.runtime.*
import androidx.fragment.app.FragmentActivity
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.phosphor.cockpit.state.AppViewModel
import com.phosphor.cockpit.ui.screens.FleetScreen
import com.phosphor.cockpit.ui.screens.LoginScreen
import com.phosphor.cockpit.ui.screens.SilentLockScreen
import com.phosphor.cockpit.ui.screens.TerminalScreen
import com.phosphor.cockpit.ui.theme.PhosphorTheme

/**
 * FragmentActivity is required by androidx.biometric (BiometricPrompt
 * attaches a dialog fragment on devices that do not expose the native
 * system prompt directly).
 *
 * Three-step flow by design:
 *   silent  — black screen + blinking cursor, auto-fires biometric,
 *             no other UI. Success → login. Failure stays black.
 *   login   — Matrix terminal-style host+token entry, saved-endpoint
 *             list, and the hidden shell with `decode attest-b`.
 *   fleet   — live panel list with session picker + add/remove.
 */
class MainActivity : FragmentActivity() {

    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            PhosphorTheme {
                val nav = rememberNavController()
                NavHost(navController = nav, startDestination = "silent") {
                    composable("silent") {
                        SilentLockScreen(onUnlocked = {
                            nav.navigate("login") {
                                popUpTo("silent") { inclusive = true }
                            }
                        })
                    }
                    composable("login") {
                        LoginScreen(vm) {
                            nav.navigate("fleet") {
                                popUpTo("login") { inclusive = true }
                            }
                        }
                    }
                    composable("fleet") {
                        FleetScreen(
                            vm = vm,
                            onOpenTerminal = { nav.navigate("terminal") },
                            onLogout = {
                                vm.logout()
                                // Back to silent lock — biometric again before login.
                                nav.navigate("silent") {
                                    popUpTo("fleet") { inclusive = true }
                                }
                            },
                        )
                    }
                    composable("terminal") {
                        TerminalScreen(vm) { nav.popBackStack() }
                    }
                }
            }
        }
    }
}
