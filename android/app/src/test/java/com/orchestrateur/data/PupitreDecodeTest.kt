package com.orchestrateur.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertTrue
import org.junit.Test

/** A real /api/pupitre answer (regression sandbox, server 0.127.0) must decode with the app's Json settings. */
class PupitreDecodeTest {
    @Test fun realSnapshotDecodes() {
        val text = javaClass.classLoader!!.getResource("pupitre-sample.json")!!.readText()
        val json = Json { ignoreUnknownKeys = true; isLenient = true }
        val snap = json.decodeFromString(PupitreSnapshot.serializer(), text)
        assertTrue(snap.fleet.isNotEmpty())
        assertTrue(snap.version != null)
    }
}
