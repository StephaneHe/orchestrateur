package com.orchestrateur.ui.projects

import com.orchestrateur.data.PipelineChoice
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** « + Projet » (Nouveau musicien) and « Session Claude — X » of public/app.js. */
class ProjectAdminLogicTest {
    private val now = 1_800_000_000_000L

    @Test fun parsesCandidatesWithMarks() {
        val v = parseCandidates(Json.parseToJsonElement("""
            {"root":"I:\\Dev","candidates":[
              {"name":"Foo","path":"I:\\Dev\\Foo","hasGit":true,"hasClaudeMd":true,"hasClaude":false},
              {"name":"Bar","path":"I:\\Dev\\Bar","hasGit":false,"hasClaudeMd":false,"hasClaude":false}]}
        """.trimIndent()))
        assertEquals("I:\\Dev", v.root)
        assertEquals(2, v.candidates.size)
        assertEquals("git · CLAUDE.md", v.candidates[0].marks)
        assertEquals("—", v.candidates[1].marks)
        assertEquals("I:\\Dev\\Foo", v.candidates[0].path)
    }

    @Test fun validatesNameAndPathLikeTheServer() {
        assertEquals("nom et chemin requis", validateNewProject("", "I:\\Dev\\x"))
        assertEquals("nom et chemin requis", validateNewProject("x", " "))
        assertTrue(validateNewProject("1abc", "I:\\Dev\\x")!!.startsWith("nom invalide"))
        assertTrue(validateNewProject("a b", "I:\\Dev\\x")!!.startsWith("nom invalide"))
        assertNull(validateNewProject("My_proj-1.2", "I:\\Dev\\x"))
    }

    @Test fun addProjectBodyAndOutcome() {
        val b = addProjectBody(" Foo ", " I:\\Dev\\Foo ", true)
        assertEquals("Foo", b["name"]!!.jsonPrimitive.content)
        assertEquals("I:\\Dev\\Foo", b["path"]!!.jsonPrimitive.content)
        assertTrue(b["isConductor"]!!.jsonPrimitive.boolean)
        assertEquals("✓ Foo ajouté à l’orchestre", addProjectMessage("Foo", Json.parseToJsonElement("""{"ok":true,"project":{"name":"Foo"}}""")))
        assertEquals("✓ Foo devient le chef d’orchestre", addProjectMessage("Foo", Json.parseToJsonElement("""{"ok":true,"promoted":true,"conductor":"Foo"}""")))
    }

    private val sessionsJson = """
        {"projectName":"alpha","projectPath":"I:\\Dev\\alpha","encodedDir":"I--Dev-alpha",
         "attached":"bbbbbbbb-0000-0000-0000-000000000000",
         "sessions":[
           {"id":"aaaaaaaa-0000-0000-0000-000000000000","mtime":${now - 30_000},"size":10,"sizeHuman":"10 B","live":true,
            "preview":"bonjour","lastMessage":null,"gitBranch":"dev","approxTurns":3},
           {"id":"bbbbbbbb-0000-0000-0000-000000000000","mtime":${now - 7_200_000},"sizeHuman":"2.1 MB","live":false,
            "preview":null,"lastMessage":"fini","gitBranch":null,"approxTurns":0}]}
    """.trimIndent()

    @Test fun parsesSessionsAndMarksAttached() {
        val v = parseSessions(Json.parseToJsonElement(sessionsJson))
        assertEquals("I:\\Dev\\alpha  ·  I--Dev-alpha", v.pathLine)
        assertEquals("bbbbbbbb-0000-0000-0000-000000000000", v.attached)
        assertEquals(2, v.sessions.size)
        val (a, b) = v.sessions
        assertTrue(a.live)
        assertFalse(v.isAttached(a))
        assertTrue(v.isAttached(b))
        assertEquals("aaaaaaaa", a.shortId)
        assertEquals("dev · 10 B · 3 tours", sessionMeta(a))
        assertEquals("— · 2.1 MB · 0 tours", sessionMeta(b))
        assertEquals("il y a 30s", sessionWhen(a, now))
        assertEquals("il y a 2h", sessionWhen(b, now))
        assertEquals("début · (vide)", sessionFirstLine(b))
        assertEquals("début · bonjour", sessionFirstLine(a))
        assertNull(sessionLastLine(a))
        assertEquals("dernier · fini", sessionLastLine(b))
    }

    @Test fun sessionBodies() {
        assertEquals("abc", attachBody("abc")["session_id"]!!.jsonPrimitive.content)
        val auto = newSessionBody("  fais X  ", PipelineChoice.AUTO)
        assertEquals("fais X", auto["prompt"]!!.jsonPrimitive.content)
        assertFalse(auto.containsKey("pipeline"))
        val dev = newSessionBody("fais X", PipelineChoice.DEV_LEGER)
        assertEquals("dev", dev["pipeline"]!!.jsonPrimitive.content)
        assertEquals("leger", dev["pipelineMode"]!!.jsonPrimitive.content)
    }

    @Test fun newSessionOutcomes() {
        val started = parseNewSession(200, Json.parseToJsonElement("""{"ok":true,"session_id":"cccc"}"""), "x")
        assertEquals(NewSessionOutcome.Started("cccc"), started)
        val pipe = parseNewSession(202, Json.parseToJsonElement("""{"ok":true,"pipeline":true,"pid":5,"note":"projet en service"}"""), "x")
        assertEquals(NewSessionOutcome.Pipeline("projet en service"), pipe)
        val fail = parseNewSession(504, Json.parseToJsonElement("""{"error":"timed out"}"""), "erreur 504")
        assertEquals(NewSessionOutcome.Failed("timed out"), fail)
        assertEquals(NewSessionOutcome.Failed("erreur 500"), parseNewSession(500, JsonNull, "erreur 500"))
    }
}
