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
        // Server URL and token are entered in the configure screen — nothing is
        // preseeded or compiled in.
        serverStore = ServerStore(this)
        api = Api(serverStore)
    }
}
