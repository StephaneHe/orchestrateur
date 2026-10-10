// ============================================================================
// src/interrupt_policy.mjs — three-state InterruptPolicy.
// ============================================================================
//
// Returns one of:
//   { decision: 'interrupt', reason: 'classifier_useless_now' }
//   { decision: 'queue',     reason: 'classifier_still_useful' | 'default' }
//   { decision: 'consult',   reason: 'classifier_uncertain',
//     recommendation: 'interrupt' | 'queue' }
//
// Default bias = QUEUE. CONSULT runtime fallback is also QUEUE — orchestrator
// does not freeze on ambiguity; it logs and queues.
// ============================================================================

// 0.66.0: no stop-word list any more (user request, 2026-10-10: « Ce n'est pas
// une recherche de mot qui pourra faire un routage efficace, c'est une recherche
// de sens que seul un modele peut faire »). Whether a new message makes the
// in-flight task useless is decided by the classifier model; the explicit
// `!interrupt` command (message_router.mjs) stays — it is a command, not a word search.

export async function decide({
  turnSummary,
  newPrompt,
  classifier,
  parallelAgentError = false,
  budgetGuardFired   = false,
}) {
  if (parallelAgentError) {
    return { decision: 'interrupt', reason: 'parallel_agent_error' };
  }
  if (budgetGuardFired) {
    return { decision: 'interrupt', reason: 'budget_guard' };
  }
  let v;
  try { v = await classifier(turnSummary, newPrompt); }
  catch (e) {
    return { decision: 'queue', reason: 'classifier_error', error: e.message };
  }

  if (!v || typeof v !== 'object' || !v.verdict) {
    return { decision: 'queue', reason: 'classifier_malformed' };
  }

  if (v.verdict === 'useless_now') {
    return { decision: 'interrupt', reason: 'classifier_useless_now', reasoning: v.reasoning || null };
  }
  if (v.verdict === 'still_useful') {
    return { decision: 'queue', reason: 'classifier_still_useful', reasoning: v.reasoning || null };
  }
  if (v.verdict === 'uncertain') {
    const lean = v.lean === 'interrupt' ? 'interrupt' : 'queue';
    return {
      decision: 'consult',
      reason: 'classifier_uncertain',
      recommendation: lean,
      reasoning: v.reasoning || null,
    };
  }

  return { decision: 'queue', reason: 'classifier_unknown_verdict', verdict: v.verdict };
}
