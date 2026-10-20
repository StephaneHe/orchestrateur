package com.orchestrateur.ui.models

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.orchestrateur.data.Api
import com.orchestrateur.data.RestResult
import com.orchestrateur.data.enc
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import com.orchestrateur.data.getJson
import com.orchestrateur.data.postJson
import com.orchestrateur.data.putJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.Instant

/** Status line of a slot: kind is saving | saved | error. */
data class SlotStatus(val kind: String, val text: String)

/** Pending « Appliquer la suggestion » confirmation (dry-run plan first). */
data class RecoConfirm(val mode: String, val slot: String?, val plan: ApplyPlan? = null, val error: String? = null, val busy: Boolean = false)

/** Screen state of the Models page, shared by its tabs (one instance per visit). */
class ModelsState {
    var routing by mutableStateOf<Routing?>(null)
    var catalog by mutableStateOf<Catalog?>(null)
    var reco by mutableStateOf<Reco?>(null)
    var error by mutableStateOf<String?>(null)
    var refreshing by mutableStateOf(false)
    var pipeline by mutableStateOf("dev")
    val status = mutableStateMapOf<String, SlotStatus>()
    val openVariants = mutableStateListOf<String>()
    var highlight by mutableStateOf<String?>(null)
    var showHistory by mutableStateOf(false)
    var recoConfirm by mutableStateOf<RecoConfirm?>(null)
    var recoNotice by mutableStateOf<String?>(null)
    var gaps by mutableStateOf<Gaps?>(null)
    var gapsError by mutableStateOf<String?>(null)
    var gapNotice by mutableStateOf<String?>(null)
    var migrationSeen by mutableStateOf(false)

    val pipelineLabels: Map<String, String> get() = routing?.pipelines?.associate { it.id to it.label } ?: emptyMap()

    private fun restartMsg(r: RestResult, version: String, fallback: String = "Chargement impossible") =
        if (r.code == 404) "Le serveur ne connaît pas encore cette section : il doit être redémarré (version ≥ $version)."
        else "$fallback : ${r.errorText()}"

    suspend fun load(api: Api, refresh: Boolean) {
        val c = api.getJson("/api/model-catalog" + if (refresh) "?refresh=1" else "")
        val r = api.getJson("/api/model-routing")
        val parsed = if (r.ok) parseRouting(r.json) else null
        when {
            !r.ok && r.code != 404 -> error = "Chargement impossible : ${r.errorText()}"
            !c.ok && c.code != 404 -> error = "Chargement impossible : ${c.errorText()}"
            parsed == null -> error = "Le serveur ne connaît pas encore cette version de la vue : il doit être redémarré (version ≥ 0.40.0)."
            else -> {
                catalog = parseCatalog(c.json)
                routing = parsed
                error = null
                // Suggestions are optional: an older server has none, the view stays usable.
                val rc = api.getJson("/api/model-recommendations")
                reco = if (rc.ok) parseReco(rc.json) else null
                if (parsed.pipeline(pipeline) == null) pipeline = parsed.pipelines.firstOrNull()?.id ?: pipeline
            }
        }
    }

    suspend fun reloadRouting(api: Api) {
        val r = api.getJson("/api/model-routing")
        if (r.ok) parseRouting(r.json)?.let { routing = it }
    }

    suspend fun reloadCatalog(api: Api) {
        val c = api.getJson("/api/model-catalog")
        if (c.ok) catalog = parseCatalog(c.json)
    }

    suspend fun save(api: Api, slot: String, value: String, second: Boolean) {
        val cur = routing?.assignments?.get(slot)
        val before = if (second) cur?.second?.value ?: "" else cur?.value ?: ""
        if (value == before) return
        status[slot] = SlotStatus("saving", "enregistrement…")
        val r = api.putJson("/api/model-routing/${enc(slot)}", choiceBody(value, second))
        if (r.ok) {
            reloadRouting(api)
            status[slot] = SlotStatus("saved", savedStatus(r.json, second))
        } else {
            status[slot] = SlotStatus("error", "✕ non enregistré : ${r.errorText()}")
        }
    }

    suspend fun recoPrepare(api: Api, mode: String, slot: String?) {
        recoNotice = null
        recoConfirm = RecoConfirm(mode, if (mode == "one") slot else null)
        val r = api.postJson("/api/model-routing/apply-suggestions", applyBody(mode, slot, dryRun = true))
        if (recoConfirm?.mode != mode) return
        recoConfirm = if (r.ok) recoConfirm?.copy(plan = parsePlan(r.json, mode)) else recoConfirm?.copy(error = r.errorText())
    }

    suspend fun recoApply(api: Api) {
        val c = recoConfirm ?: return
        if (c.plan == null) return
        recoConfirm = c.copy(busy = true)
        val r = api.postJson("/api/model-routing/apply-suggestions", applyBody(c.mode, c.slot, dryRun = false))
        if (!r.ok) { recoConfirm = c.copy(busy = false, error = r.errorText()); return }
        reloadRouting(api)
        recoConfirm = null
        val res = applyResult(r.json, c.mode, fmtTime(Instant.now().toString()))
        for ((slot, text) in res.statuses) status[slot] = SlotStatus(if (text.startsWith("✕")) "error" else "saved", text)
        recoNotice = res.notice
    }

    suspend fun loadGaps(api: Api) {
        val r = api.getJson("/api/pipeline-gaps")
        if (r.ok) { gaps = parseGaps(r.json); gapsError = null }
        else gapsError = restartMsg(r, "0.42.0")
    }

    /** Tells the server which gaps the user was shown (the automatic answer may only touch those). */
    suspend fun markPresented(api: Api, keys: List<String>) {
        if (keys.isEmpty()) return
        api.postJson("/api/auto-answer/presented", buildJsonObject { put("keys", JsonArray(keys.map { JsonPrimitive(it) })) })
    }

    /** True when an accepted gap moved the view to its pipeline. */
    suspend fun decideGap(api: Api, key: String, accept: Boolean, choice: String = "primary"): Boolean {
        val path = "/api/pipeline-gaps/${enc(key)}/${if (accept) "accept" else "reject"}"
        val r = api.postJson(path, if (accept) gapAcceptBody(choice) else gapRejectBody())
        var moved = false
        if (!r.ok) gapNotice = "Échec : ${r.errorText()}"
        else if (accept) {
            reloadRouting(api)
            gapNotice = gapAcceptedNotice(r.json, pipelineLabels)
            val pid = r.json.o("applied").s("pipeline")
            val slot = r.json.o("applied").s("slot")
            if (pid != null && routing?.pipeline(pid) != null) { pipeline = pid; moved = true }
            if (slot != null) {
                val parts = slot.split(".")
                if (parts.size == 3) { val k = parts.take(2).joinToString("."); if (k !in openVariants) openVariants += k }
                highlight = slot
            }
        } else gapNotice = "✕ Lacune rejetée : rien n’est ajouté."
        loadGaps(api)
        return moved
    }
}
