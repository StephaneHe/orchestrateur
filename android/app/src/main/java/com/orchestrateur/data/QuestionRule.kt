package com.orchestrateur.data

/**
 * Mirror of TurnCore.questionOpen / isTurnStart (public/turn-core.js, 0.134.0).
 * User report: « [projet] est toujours marqué avec "votre réponse attendue" ».
 * A question stops waiting for the user once it was marked answered after it,
 * or once a turn of the same musician opened after it (the user's reply, the
 * chef's, a pipeline resume — a new pause brings a new, newer question).
 */
object QuestionRule {
    fun isTurnStart(type: String?, subtype: String?, source: String?): Boolean =
        (type == "user_prompt" && source.isNullOrBlank()) ||
            (type == "system" && (subtype == "init" || subtype == "pipeline_start" || subtype == "dual_start"))

    fun isOpen(askedAtMs: Long?, turnStartedAtMs: Long?, resolvedAtMs: Long? = null): Boolean {
        if (askedAtMs == null) return true
        if (resolvedAtMs != null && resolvedAtMs >= askedAtMs) return false
        if (turnStartedAtMs != null && turnStartedAtMs > askedAtMs) return false
        return true
    }
}
