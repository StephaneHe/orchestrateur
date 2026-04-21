package com.orchestrateur.ui.fleet

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.orchestrateur.data.Api
import com.orchestrateur.data.FleetStream
import com.orchestrateur.data.Musician
import com.orchestrateur.data.RawEvent
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class ChatMsg(val role: Role, val text: String, val ts: Long = System.currentTimeMillis(), val id: String = java.util.UUID.randomUUID().toString()) {
    enum class Role { user, conductor }
}

class FleetViewModel(private val api: Api) : ViewModel() {

    val musicians = mutableStateListOf<Musician>()

    /** Conductor transcript — user messages + conductor synthesis bubbles. */
    val chat = mutableStateListOf<ChatMsg>()

    /** Which tab the user is currently viewing. Default: the conductor. */
    var activeTab: String by mutableStateOf(CONDUCTOR)
        private set

    private val _status = MutableStateFlow("connecting…")
    val status: StateFlow<String> = _status

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected

    private var streamJob: Job? = null

    init { boot() }

    private fun boot() {
        viewModelScope.launch {
            try {
                val cfg = api.fetchConfig()
                musicians.clear()
                musicians.addAll(cfg.projects.map { Musician(it.name, it.readAt) })
                _status.value = "online · ${musicians.size} musiciens"
                startStream()
            } catch (e: Exception) {
                _status.value = "erreur: ${e.message}"
                _connected.value = false
            }
        }
    }

    fun reconnect() {
        streamJob?.cancel()
        _connected.value = false
        _status.value = "reconnexion…"
        startStream()
    }

    private fun startStream() {
        streamJob = viewModelScope.launch {
            val stream = FleetStream(api)
            stream.connect().collect { ev ->
                when (ev) {
                    is FleetStream.Event.Message -> {
                        val m = musicians.find { it.name == ev.envelope.project } ?: return@collect
                        try {
                            val prevState = m.state
                            val raw = api.json.decodeFromString(RawEvent.serializer(), ev.envelope.line)
                            m.ingest(raw)
                            if (m.name == CONDUCTOR) onConductorEvent(m, raw)
                            if (m.state != prevState) {
                                val idx = musicians.indexOf(m)
                                if (idx > 0) { musicians.removeAt(idx); musicians.add(0, m) }
                            }
                        } catch (_: Exception) { /* skip partial/invalid lines */ }
                    }
                    is FleetStream.Event.Error -> {
                        _status.value = "sse error: ${ev.cause?.message}"
                        _connected.value = false
                    }
                    is FleetStream.Event.Open  -> {
                        _status.value = "online · ${musicians.size} musiciens"
                        _connected.value = true
                    }
                    is FleetStream.Event.Closed -> {
                        _status.value = "sse closed"
                        _connected.value = false
                    }
                }
            }
        }
    }

    /** Mirror of web App.onConductorEvent — harvest user prompts sent from
     *  any client (this device, web, mobile web) and append them as user
     *  bubbles, and on result turns append the conductor synthesis. */
    private fun onConductorEvent(m: Musician, raw: RawEvent) {
        when (raw.type) {
            "user_prompt" -> {
                val txt = raw.text?.trim().orEmpty()
                if (txt.isEmpty()) return
                val last = chat.lastOrNull()
                val isLocalEcho = last != null && last.role == ChatMsg.Role.user && last.text.trim() == txt
                if (!isLocalEcho) chat.add(ChatMsg(ChatMsg.Role.user, txt))
            }
            "result" -> {
                val txt = m.lastAssistantText.trim()
                if (txt.isEmpty()) return
                val last = chat.lastOrNull()
                if (last != null && last.role == ChatMsg.Role.conductor && last.text.trim() == txt) return
                chat.add(ChatMsg(ChatMsg.Role.conductor, txt))
            }
        }
    }

    fun selectTab(name: String) {
        activeTab = name
        // Mark as read locally AND persist server-side so reload-replay
        // and other clients don't re-inflate the unread state.
        if (name != CONDUCTOR) {
            musicians.find { it.name == name }?.let { m ->
                m.markRead()
                viewModelScope.launch { runCatching { api.markRead(m.name) } }
            }
        }
    }

    fun dispatch(prompt: String, onDone: (Result<Unit>) -> Unit = {}) {
        val target = activeTab
        if (target == CONDUCTOR) {
            chat.add(ChatMsg(ChatMsg.Role.user, prompt))
        }
        viewModelScope.launch {
            val r = runCatching { api.dispatch(target, prompt) }
            onDone(r)
        }
    }

    companion object {
        const val CONDUCTOR = "orchestrateur"
    }
}
