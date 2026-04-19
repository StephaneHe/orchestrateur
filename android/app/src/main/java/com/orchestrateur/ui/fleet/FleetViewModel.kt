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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class FleetViewModel(private val api: Api) : ViewModel() {

    val musicians = mutableStateListOf<Musician>()
    var deckOffset: Int by mutableStateOf(0)
        private set

    private val _status = MutableStateFlow("connecting…")
    val status: StateFlow<String> = _status

    init { boot() }

    private fun boot() {
        viewModelScope.launch {
            try {
                val cfg = api.fetchConfig()
                musicians.clear()
                musicians.addAll(cfg.projects.map { Musician(it.name) })
                _status.value = "online · ${musicians.size} musiciens"
                streamForever()
            } catch (e: Exception) {
                _status.value = "erreur: ${e.message}"
            }
        }
    }

    private fun streamForever() {
        viewModelScope.launch {
            val stream = FleetStream(api)
            stream.connect().collect { ev ->
                when (ev) {
                    is FleetStream.Event.Message -> {
                        val m = musicians.find { it.name == ev.envelope.project } ?: return@collect
                        try {
                            val raw = api.json.decodeFromString(RawEvent.serializer(), ev.envelope.line)
                            m.ingest(raw)
                        } catch (_: Exception) { /* skip partial/invalid lines */ }
                    }
                    is FleetStream.Event.Error -> _status.value = "sse error: ${ev.cause?.message}"
                    is FleetStream.Event.Open  -> _status.value = "online · ${musicians.size} musiciens"
                    is FleetStream.Event.Closed -> _status.value = "sse closed"
                }
            }
        }
    }

    fun rotateDeck() {
        if (musicians.size < 2) return
        deckOffset = (deckOffset + 1) % musicians.size
    }

    fun dispatch(projectName: String, prompt: String, onDone: (Result<Unit>) -> Unit) {
        viewModelScope.launch {
            val r = runCatching { api.dispatch(projectName, prompt) }
            onDone(r)
        }
    }
}
