package com.orchestrateur

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import com.orchestrateur.ui.fleet.FleetScreen
import com.orchestrateur.ui.login.LoginScreen
import com.orchestrateur.ui.theme.OrchestreTheme

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
                        store = app.tokenStore,
                        onUnlocked = { unlocked = true },
                    )
                } else {
                    FleetScreen(api = app.api)
                }
            }
        }
    }
}
