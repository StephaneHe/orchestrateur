package com.orchestrateur.ui.ops

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Shape of GET /api/permission-rules (scripts/permission-store.mjs listRules()). */
class PermissionRulesModelTest {
    @Test fun groupsByProjectSorted() {
        val j = Json.parseToJsonElement("""
          {"ok":true,"rules":{
            "zeta":[{"rule":"Bash(git status:*)","tool":"Bash","createdAt":"2026-10-01T10:00:00.000Z","by":"utilisateur"}],
            "alpha":[{"rule":"PowerShell","tool":"PowerShell","createdAt":"2026-10-02T10:00:00.000Z","by":"utilisateur","from":"tu-1"},
                     {"rule":"WebFetch","createdAt":"2026-10-03T10:00:00.000Z"}],
            "vide":[]}}
        """)
        val g = parseRules(j)
        assertEquals(listOf("alpha", "zeta"), g.map { it.project })
        assertEquals(listOf("PowerShell", "WebFetch"), g[0].rules.map { it.rule })
        assertEquals("utilisateur", g[0].rules[0].by)
        assertEquals("2026-10-03T10:00:00.000Z", g[0].rules[1].createdAt)
    }

    @Test fun revokeBody() {
        val b = revokeBody("alpha", "Bash(git status:*)")
        assertEquals("alpha", b["project"]!!.jsonPrimitive.content)
        assertEquals("Bash(git status:*)", b["rule"]!!.jsonPrimitive.content)
    }

    @Test fun emptyJson() {
        assertTrue(parseRules(Json.parseToJsonElement("{}")).isEmpty())
    }
}
