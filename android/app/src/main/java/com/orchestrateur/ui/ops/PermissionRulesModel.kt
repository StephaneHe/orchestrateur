package com.orchestrateur.ui.ops

import com.orchestrateur.data.entries
import com.orchestrateur.data.list
import com.orchestrateur.data.o
import com.orchestrateur.data.s
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Pure logic of « Autorisations permanentes » (public/permissions.js openRules, GET /api/permission-rules).

data class PermRule(val rule: String, val createdAt: String?, val by: String?)
data class ProjectRules(val project: String, val rules: List<PermRule>)

fun parseRules(j: JsonElement?): List<ProjectRules> =
    j.o("rules").entries.map { (p, list) ->
        ProjectRules(p, list.list.mapNotNull { r -> r.s("rule")?.let { PermRule(it, r.s("createdAt"), r.s("by")) } })
    }.filter { it.rules.isNotEmpty() }.sortedBy { it.project }

fun revokeBody(project: String, rule: String): JsonObject = buildJsonObject { put("project", project); put("rule", rule) }
