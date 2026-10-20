package com.orchestrateur

import android.app.Application
import com.orchestrateur.data.Api
import com.orchestrateur.data.ServerStore
import com.orchestrateur.data.Tts
import com.orchestrateur.data.UiPrefs

class OrchestreApp : Application() {
    lateinit var serverStore: ServerStore
        private set
    lateinit var api: Api
        private set
    lateinit var uiPrefs: UiPrefs
        private set
    val tts: Tts by lazy { Tts(this, uiPrefs) }

    override fun onCreate() {
        super.onCreate()
        // Server URL and token are entered in the configure screen — nothing is
        // preseeded or compiled in.
        serverStore = ServerStore(this)
        api = Api(serverStore)
        uiPrefs = UiPrefs(this)
    }
}
