// ============================================================================
// scripts/context-policy.mjs — the context sent with each model request is
// calibrated to what the task needs (0.99.0)
// ============================================================================
//
// User request (2026-10-13, TODO t-182fa2): « Il faut qu'on mette en place une
// gestion plus fine des contextes : a chaque requete, il faut que soit fait un
// travail sur le context necessaire et minimal a envoyer a chaque requete vers
// un model. » Precision (2026-10-14): « Le model au moment de faire le travail
// […] n'a pas besoin de connaitre tout le context du projet la plus part du
// temps, sauf cas particulier qu'il faut identifier. […] mais pas fiorcement
// l'historique, par exemple, de tous les developpements differents. Sauf
// peut-etre si ces developpements font parti de la meme tache initiale ».
//
// What a request carries, besides the project's own CLAUDE.md (always loaded
// by the CLI from the project directory):
//   1. the RESUMED SESSION — every earlier exchange of that session. It is the
//      big one: a musician resuming its single session re-sends the history of
//      all its past developments (measured: ~920k tokens on one turn);
//   2. the prompt and the rules dispatch.mjs appends to it.
//
// Ordinary musician turn (sessionDecision):
//   - the session is resumed only when the request CONTINUES the task of the
//     session: the musician is waiting for an answer to its own question (state
//     `input`, or a question to the chef answered by `[CHEF_ANSWER]`), the
//     Routage marked the task « meme_tache » (decided by the model, never by
//     keywords), or the user talks to the musician directly (a dialogue);
//   - any other request (a new task from the chef's Routage, from the queue…)
//     starts a FRESH session: the task text is autonomous (the Decomposer must
//     make it so), the project's CLAUDE.md is loaded, the code is on disk;
//   - a continuation whose session is too long (last request over
//     CONTEXT_MAX_TOKENS) starts fresh too, with the context of the current
//     task regenerated from the log (taskBrief): its requests and answers only.
// Pipeline step (stepSessionGroup): a session per run AND per item for the TDD
// steps (4a/4b/4c), per reviewed group for the review, and a session of its own
// for Livrer — item 3 no longer re-reads the exchanges of items 1 and 2: the
// plan, the test list and the code on disk carry what it needs.
// Rules appended to a step's prompt (stepRules): only those the step can use.
// ============================================================================

export const CONTEXT_MAX_TOKENS_DEFAULT = 150_000;
export function contextMaxTokens(env = process.env) {
  const n = Number(env.ORCH_CONTEXT_MAX_TOKENS);
  return Number.isFinite(n) && n >= 1000 ? n : CONTEXT_MAX_TOKENS_DEFAULT;
}

/** Size of the context sent with the LAST model request seen in the log lines (tokens), or null. */
export function lastContextTokens(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (typeof l !== 'string' || !l.includes('"assistant"') || !l.includes('"usage"')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const u = e?.type === 'assistant' ? e.message?.usage : null;
    if (!u) continue;
    const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (n > 0) return n;
  }
  return null;
}

/**
 * Resume the musician's session, or start a fresh one?
 * → { resume, regenerate, reason } (reason in French: it is shown in the log).
 */
export function sessionDecision({ hasSession, forceNew = false, forceResume = false, sameTask = false, source = null,
  prompt = '', state = null, awaitingChef = false, contextTokens = null, maxTokens = CONTEXT_MAX_TOKENS_DEFAULT } = {}) {
  if (!hasSession) return { resume: false, regenerate: false, reason: 'aucune session à reprendre' };
  if (forceNew) return { resume: false, regenerate: false, reason: 'session neuve demandée (--new-session)' };
  const why = forceResume ? 'reprise demandée (--resume-session)'
    : sameTask ? 'suite de la même tâche (marquée « meme_tache » par le Routage)'
    : state === 'input' ? 'réponse à la question que le musicien a posée'
    : /^\s*\[CHEF_ANSWER\]/.test(String(prompt)) || awaitingChef ? 'réponse du chef à la question du musicien'
    : !source ? 'dialogue direct de l’utilisateur avec le musicien'
    : null;
  if (!why) return { resume: false, regenerate: false, reason: `nouvelle tâche (venue de ${source}) : contexte minimal, sans l’historique des autres développements` };
  if (contextTokens != null && contextTokens > maxTokens) {
    return { resume: false, regenerate: true, reason: `${why}, mais la session est trop longue (${contextTokens} tokens > ${maxTokens}) : session neuve, contexte de la tâche régénéré` };
  }
  return { resume: true, regenerate: false, reason: why };
}

const clip = (s, max) => { const t = String(s || '').trim(); return t.length <= max ? t : `${t.slice(0, max)}\n⚠ [tronqué par l’orchestrateur : ${max} caractères sur ${t.length}]`; };

/**
 * The current task's context, regenerated from the musician's log when its
 * session is too long to resume: its last turns (request and answer), never
 * the rest of the session. Deterministic, no model.
 */
export function taskBrief(lines, { turns = 3, perText = 4000 } = {}) {
  const evs = [];
  for (const l of lines) { if (typeof l !== 'string' || !l.startsWith('{')) continue; try { evs.push(JSON.parse(l)); } catch { /* skip */ } }
  const out = [];
  let cur = null;
  for (const e of evs) {
    if (e.type === 'user_prompt' && typeof e.text === 'string') { cur = { request: e.text, answer: '' }; out.push(cur); }
    else if (cur && e.type === 'result' && typeof e.result === 'string' && !(e.num_turns === 0 && e.duration_api_ms === 0)) cur.answer = e.result;
  }
  const last = out.slice(-turns);
  if (!last.length) return '';
  return ['[CONTEXTE RÉGÉNÉRÉ PAR L’ORCHESTRATEUR — la session précédente était trop longue ; voici seulement la tâche en cours]',
    ...last.map((t, i) => `### Échange ${i + 1}/${last.length}\n**Demande :**\n${clip(t.request, perText)}\n\n**Réponse :**\n${clip(t.answer || '(pas de réponse)', perText)}`),
    '[FIN DU CONTEXTE RÉGÉNÉRÉ — la demande actuelle suit]'].join('\n\n');
}

// TDD steps work on ONE item: their session is the item's, not the run's.
const ITEM_STEPS = new Set(['rouge', 'vert', 'refactor']);

/** Session group of a pipeline step: per run (as before) + per item / reviewed group / delivery. */
export function stepSessionGroup({ step, model = null, item = null, reviewGroup = null }) {
  const m = (model || 'defaut').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  const scope = ITEM_STEPS.has(step.id) && item?.n != null ? `-i${item.n}`
    : step.id === 'revue' && reviewGroup != null ? `-g${reviewGroup}`
    : '';
  const group = step.id === 'livrer' ? 'livrer' : step.group;
  return `${group}${scope}-${m}`.replace(/-+$/, '').slice(0, 40).replace(/-+$/, '');
}

/** Rules dispatch.mjs appends to a step's prompt: only the ones the step can use. */
const RULES_ALL = ['background', 'requirements', 'commands', 'todo', 'stale'];
// Steps of the Development and Discussion pipelines, whose needs are known.
// Any other step (catalogue pipelines) keeps every rule: never under-inform.
const CALIBRATED_STEPS = new Set(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer', 'rechercher', 'repondre']);
export function stepRules(stepId) {
  if (!stepId || !CALIBRATED_STEPS.has(stepId)) return RULES_ALL;
  const rules = ['background', 'commands'];
  if (['liste-tests', 'rouge', 'vert', 'refactor', 'livrer'].includes(stepId)) rules.push('stale');
  if (['liste-tests', 'rouge', 'livrer'].includes(stepId)) rules.push('requirements');
  return rules;
}
