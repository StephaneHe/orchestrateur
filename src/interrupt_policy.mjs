// ============================================================================
// src/interrupt_policy.mjs — three-state InterruptPolicy.
// ============================================================================
//
// Returns one of:
//   { decision: 'interrupt', reason: 'stop_word' | 'classifier_useless_now' }
//   { decision: 'queue',     reason: 'classifier_still_useful' | 'default' }
//   { decision: 'consult',   reason: 'classifier_uncertain',
//     recommendation: 'interrupt' | 'queue' }
//
// Default bias = QUEUE. CONSULT runtime fallback is also QUEUE — orchestrator
// does not freeze on ambiguity; it logs and queues.
// ============================================================================

export const STOP_WORDS = {
  en: ['stop', 'abort', 'cancel', 'scrap that', 'never mind', 'wait'],
  fr: ['stop', 'arrête', 'arrete', 'annule', 'oublie', 'attends', 'laisse tomber'],
};

const ALL_STOP_WORDS = [...STOP_WORDS.en, ...STOP_WORDS.fr];

function buildStopWordRegex() {
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = ALL_STOP_WORDS.map(w => {
    const e = escapeRe(w);
    if (w.includes(' ')) return e;
    return `(?<![\\p{L}])${e}(?![\\p{L}])`;
  });
  return new RegExp(`(?:${parts.join('|')})`, 'iu');
}

const STOP_RE = buildStopWordRegex();

export function detectStopWord(prompt) {
  if (typeof prompt !== 'string' || !prompt) return null;
  const m = STOP_RE.exec(prompt);
  return m ? m[0] : null;
}

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
  const stop = detectStopWord(newPrompt);
  if (stop) {
    return { decision: 'interrupt', reason: 'stop_word', match: stop };
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
