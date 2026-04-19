package com.orchestrateur

import android.app.Application
import com.orchestrateur.data.Api
import com.orchestrateur.data.TokenStore

class OrchestreApp : Application() {
    lateinit var tokenStore: TokenStore
        private set
    lateinit var api: Api
        private set

    override fun onCreate() {
        super.onCreate()
        tokenStore = TokenStore(this)
        api = Api(tokenStore)
    }
}
