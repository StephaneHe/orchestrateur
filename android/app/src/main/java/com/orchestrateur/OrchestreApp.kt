package com.orchestrateur

import android.app.Application
import com.orchestrateur.data.Api
import com.orchestrateur.data.ServerStore

class OrchestreApp : Application() {
    lateinit var serverStore: ServerStore
        private set
    lateinit var api: Api
        private set

    override fun onCreate() {
        super.onCreate()
        serverStore = ServerStore(this)
        if (BuildConfig.DEBUG && serverStore.serverUrl.isNullOrBlank()) {
            // Dev convenience only: preseed the server URL on first debug launch.
            // No token anywhere — access is Tailscale-only.
            serverStore.serverUrl = "http://myhost:7777"
        }
        api = Api(serverStore)
    }
}
