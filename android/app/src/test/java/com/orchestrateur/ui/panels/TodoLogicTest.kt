package com.orchestrateur.ui.panels

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same shape as GET /api/todo (server.js, scripts/todo-core.mjs parseTodo). */
private val TODO_JSON = """
{"ok":true,
 "items":[
  {"id":"t-aaa111","project":"alpha","line":3,"status":"todo","title":"Ajouter un bouton","detail":"court","detailFull":"le texte complet","more":"  - sous-point","type":"fonctionnalite","addedAt":"2026-10-13T09:12","addedEstimated":false,"doneAt":null,"doneBy":null,"manual":false,
   "notes":[{"id":"n-1","at":"2026-10-14T08:05","text":"pense au mobile","by":"utilisateur"},{"id":"n-2","text":"sans date"}]},
  {"id":"t-bbb222","project":"beta","line":7,"status":"progress","title":"Corriger le bug","detail":"","type":"correction","addedAt":"2026-10-12T10:00","addedEstimated":true,"notes":[]},
  {"id":"t-ccc333","project":"alpha","line":9,"status":"todo","title":"Troisième","detail":"","type":null,"addedAt":"2026-10-11T10:00","addedEstimated":false,"notes":[]},
  {"id":"t-ddd444","project":"alpha","line":11,"status":"done","title":"Fait par le musicien","detail":"","addedAt":"2026-10-10T10:00","addedEstimated":false,"doneAt":"2026-10-15T11:30","doneBy":"alpha","notes":[]},
  {"id":"t-eee555","project":"beta","line":12,"status":"done","title":"Rejeté","detail":"","addedAt":"2026-10-09T10:00","addedEstimated":false,"doneAt":null,"doneBy":null,"rejected":{"at":"2026-10-16T14:02","by":"utilisateur"},"notes":[]},
  {"id":"t-fff666","project":"beta","line":13,"status":"done","title":"Coché à la main","detail":"","addedAt":"2026-10-08T10:00","addedEstimated":false,"manual":true,"notes":[]}
 ],
 "counts":{"done":3,"progress":1,"todo":2,"open":3,"rejected":1,"total":6},
 "lists":[{"project":"alpha","open":2,"total":3},{"project":"beta","open":1,"total":3}],
 "orderError":"todo-order.json illisible"}
"""

class TodoLogicTest {
    private val data = parseTodoData(Json.parseToJsonElement(TODO_JSON))
    private val alpha = data.items.first { it.id == "t-aaa111" }

    @Test fun parsesItemsListsAndCounts() {
        assertEquals(6, data.items.size)
        assertEquals(listOf("alpha", "beta"), data.projects)
        assertEquals(3, data.openCount)
        assertEquals("todo-order.json illisible", data.orderError)
        assertEquals("le texte complet", alpha.full)
        assertEquals("  - sous-point", alpha.more)
        assertEquals(2, alpha.notes.size)
        assertEquals("alpha/t-aaa111", alpha.key)
        val rej = data.items.first { it.id == "t-eee555" }
        assertEquals("2026-10-16T14:02", rej.rejectedAt)
        assertTrue(rej.isDone)
    }

    @Test fun datesAreFormattedLikeTheWeb() {
        assertEquals("13/10/26 09:12", fmtTodoDate("2026-10-13T09:12"))
        assertEquals("—", fmtTodoDate(null))
        assertEquals("—", fmtTodoDate("hier"))
        assertEquals("≈ 12/10/26 10:00", addedLabel(data.items.first { it.id == "t-bbb222" }))
        assertEquals("13/10/26 09:12", addedLabel(alpha))
    }

    @Test fun openOnTopDoneBelowInServedOrderAndFilter() {
        val (open, done) = splitParts(data.items, null)
        assertEquals(listOf("t-aaa111", "t-bbb222", "t-ccc333"), open.map { it.id })
        assertEquals(listOf("t-ddd444", "t-eee555", "t-fff666"), done.map { it.id })
        val (oa, da) = splitParts(data.items, "alpha")
        assertEquals(listOf("t-aaa111", "t-ccc333"), oa.map { it.id })
        assertEquals(listOf("t-ddd444"), da.map { it.id })
    }

    @Test fun doneMarksNameRejectionAndManualTick() {
        assertEquals("✓ alpha", doneMark(data.items.first { it.id == "t-ddd444" }))
        assertEquals("✕ rejeté (16/10/26 14:02) par l’utilisateur", doneMark(data.items.first { it.id == "t-eee555" }))
        assertEquals("✓ —", doneMark(data.items.first { it.id == "t-fff666" }))
        assertNull(doneMark(alpha))
        assertEquals("✎ 2", notesMark(alpha))
        assertNull(notesMark(data.items.first { it.id == "t-ccc333" }))
        assertEquals("Fonctionnalité", typeLabel("fonctionnalite"))
        assertNull(typeLabel(null))
        assertEquals("✕ Rejeté", statusLabel(data.items.first { it.id == "t-eee555" }))
        assertEquals("◐ En cours", statusLabel(data.items.first { it.id == "t-bbb222" }))
    }

    /** Exact text of public/todo-panel.js chefMessage for the same item. */
    @Test fun chefMessageIsIdenticalToTheWeb() {
        val expected = "Item de la TODO de alpha à exécuter : Ajouter un bouton\n\n" +
            "le texte complet\n\n" +
            "  - sous-point\n\n" +
            "Notes de l’utilisateur :\n- (14/10/26 08:05) pense au mobile\n- sans date\n\n" +
            "(Item t-aaa111, alpha/TODO_LIST.md ligne 3, non fait.)"
        assertEquals(expected, chefMessage(alpha))
        val bare = data.items.first { it.id == "t-bbb222" }
        assertEquals("Item de la TODO de beta à exécuter : Corriger le bug\n\n(Item t-bbb222, beta/TODO_LIST.md ligne 7, en cours.)", chefMessage(bare))
    }

    /** Exact text of public/todo-panel.js discussMessage. */
    @Test fun discussMessageIsIdenticalToTheWeb() {
        val bare = data.items.first { it.id == "t-ddd444" }
        val expected = "/chef-discussion\n\n" +
            "Item de la TODO de alpha à DISCUTER (ne pas le lancer) : Fait par le musicien\n\n" +
            "(Item t-ddd444, alpha/TODO_LIST.md ligne 11, fait.)\n\n" +
            "Ma question / ce dont je veux discuter : "
        assertEquals(expected, discussMessage(bare))
        assertTrue(discussMessage(alpha).startsWith("/chef-discussion\n\nItem de la TODO de alpha à DISCUTER (ne pas le lancer) : Ajouter un bouton\n\nle texte complet"))
    }

    /** Moving inside a filtered part refills the slots of the visible items in the global order. */
    @Test fun moveKeepsThePartAndMergesIntoTheWholeOrder() {
        val (oa, _) = splitParts(data.items, "alpha")
        val keys = movedOrder(data.items, oa, "alpha/t-ccc333", -1)!!
        assertEquals(listOf("alpha/t-ccc333", "beta/t-bbb222", "alpha/t-aaa111", "alpha/t-ddd444", "beta/t-eee555", "beta/t-fff666"), keys)
        // First item cannot go up, last cannot go down: no request.
        assertNull(movedOrder(data.items, oa, "alpha/t-aaa111", -1))
        assertNull(movedOrder(data.items, oa, "alpha/t-ccc333", 1))
        val (open, _) = splitParts(data.items, null)
        assertEquals(listOf("alpha/t-aaa111", "alpha/t-ccc333", "beta/t-bbb222"), movedOrder(data.items, open, "beta/t-bbb222", 1)!!.take(3))
        val body = orderBody(keys).jsonObject
        assertEquals(6, body["keys"]!!.jsonArray.size)
        assertEquals("alpha/t-ccc333", body["keys"]!!.jsonArray[0].jsonPrimitive.content)
    }

    @Test fun noteValidationAndRejectErrors() {
        assertEquals("La note est vide.", noteProblem("   "))
        assertEquals("Note trop longue (4001 caractères, 4000 au plus).", noteProblem("x".repeat(4001)))
        assertNull(noteProblem("ok"))
        assertEquals("ok", noteBody("ok").jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals("Item non rejeté : item déjà fait : il ne peut plus être rejeté", rejectError(409, "item déjà fait : il ne peut plus être rejeté"))
        assertEquals("Item non rejeté : item déjà fait ou déjà rejeté", rejectError(409, null))
        assertEquals("Item non rejeté : la liste est en cours d’écriture par le musicien, réessayez dans un instant", rejectError(423, null))
        assertEquals("Item non rejeté : boom", rejectError(500, "boom"))
        assertFalse(canReject(data.items.first { it.id == "t-ddd444" }))
        assertTrue(canReject(alpha))
    }
}
