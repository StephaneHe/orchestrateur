// ============================================================================
// scripts/chef-relay.mjs — the chef's answer to a NEEDS_CHEF_INPUT, relayed
// back to the musician, and the watch of process-pause answers (0.137.0)
// ============================================================================
//
// Incident of 2026-10-22 (user report: « psyProfile ne semble pas avancer »):
//   - the relay deduplicated on (session_id, num_turns); num_turns counts the
//     turns of ONE `claude -p` call, so two short answers of the same chef
//     session (both num_turns 1) had the same key: the second and the third
//     answers to the process pauses of one run were dropped;
//   - the relay walked back to the LAST marker of the chef log, whatever turn had
//     just ended: the chef's answers to the user (an ordinary turn, a
//     [CALLBACK_WAKE] report) were sent to the last musician that had asked,
//     and started parasitic Discussion runs.
// Now a chef result is relayed only when the prompt that OPENED that very turn
// (same orch_turn) carries the marker, once per opening prompt; a process
// pause's answer names its pause ([RELAIS: pause <run> n° <n>]) so dispatch.mjs
// applies it to that pause only, and an answer still not applied after
// ANSWER_GRACE_MS is reported to the chef.
//
// Pure functions (no server state): server.js and the tests call them.

import fs from 'node:fs';
import path from 'node:path';

export const CHEF_MARKER_RE = /\[NEEDS_CHEF_INPUT_FROM:([A-Za-z][A-Za-z0-9_.\-]{0,63})\]/;
const CHEF_MARKER_G = /\[NEEDS_CHEF_INPUT_FROM:([A-Za-z][A-Za-z0-9_.\-]{0,63})\]/g;
/** Head of a process pause's question (process-pause.mjs): « [<run> · pause <n>] ». */
export const PAUSE_TAG_RE = /\[(p-\d{8}T\d{6}-[a-z0-9]{4,8}) · pause (\d+)\]/;
/** Line added by the relay: what the answer answers. */
export const RELAY_TAG_RE = /^\[RELAIS: (?:pause (p-\d{8}T\d{6}-[a-z0-9]{4,8}) n° (\d+)|question)\][ \t]*$/m;
export const RELAY_TAG_STRIP_RE = /\n?^\[RELAIS: [^\]\n]*\][ \t]*$/gm;
/** A chef answer to a process pause not applied after this long is reported to the chef. */
export const ANSWER_GRACE_MS = 120_000;

const parse = (l) => { if (l && typeof l === 'object') return l; try { return JSON.parse(l); } catch { return null; } };
const one = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The user_prompt that opened the chef turn which produced `result`.
 * lines: the chef log (raw lines or parsed events), oldest first.
 * With a turn id (dispatch.mjs tags every line, 0.67.0): the prompt of that
 * turn — notifications appended meanwhile (sourced user_prompt lines) do not
 * count. Without (old lines): the latest unsourced prompt before the result.
 */
export function turnOpener(lines, result) {
  const evs = (lines || []).map(parse).filter(Boolean);
  if (result?.orch_turn) {
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.type === 'user_prompt' && e.orch_turn === result.orch_turn) return e;
    }
    return null;
  }
  let end = evs.length;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type === 'result' && e.timestamp === result?.timestamp && e.session_id === result?.session_id) { end = i; break; }
  }
  for (let i = end - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type === 'result') return null;   // the previous turn ended: no opener of ours in between
    if (e.type === 'user_prompt' && !e.source) return e;
  }
  return null;
}

/** The relayed prompt: the chef's text, what it answers, the usual last line. */
export function relayPrompt(cleaned, pause) {
  return `[CHEF_ANSWER] ${cleaned}\n\n[RELAIS: ${pause ? `pause ${pause.run} n° ${pause.n}` : 'question'}]\nReprends ta tâche en intégrant cette décision.`;
}

/** What a relayed prompt answers: { kind: 'pause', run, n } | { kind: 'question' } | null (older relay). */
export function relayTag(prompt) {
  const m = RELAY_TAG_RE.exec(String(prompt || ''));
  if (!m) return null;
  return m[1] ? { kind: 'pause', run: m[1], n: Number(m[2]) } : { kind: 'question' };
}

/**
 * Decides whether a chef `result` is relayed, to whom, and with what text.
 * → { musician, key, pause, prompt } to relay, or { skip, … } with the reason.
 */
export function chefAnswerRelay({ lines, result, isKnown = () => true }) {
  if (result?.type !== 'result' || typeof result.result !== 'string') return { skip: 'not-a-result' };
  const opener = turnOpener(lines, result);
  if (!opener || typeof opener.text !== 'string') return { skip: 'no-opener' };
  const names = [...new Set([...opener.text.matchAll(CHEF_MARKER_G)].map(m => m[1]))];
  if (!names.length) return { skip: 'not-a-question-turn' };
  if (names.length > 1) return { skip: 'several-musicians', names };
  const musician = names[0];
  if (!isKnown(musician)) return { skip: 'unknown-musician', musician };
  const tag = PAUSE_TAG_RE.exec(opener.text);
  const pause = tag ? { run: tag[1], n: Number(tag[2]) } : null;
  const cleaned = result.result.replace(/^\s*\[ANSWER\]\s*/i, '').trim();
  const key = opener.orch_turn ? `turn:${opener.orch_turn}` : `prompt:${opener.timestamp || ''}:${musician}`;
  return { musician, key, pause, prompt: relayPrompt(cleaned, pause) };
}

/** Tail of a log file, as parsed events (never the whole file). */
export function readTail(file, maxBytes = 2 * 1024 * 1024) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(maxBytes, size);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    return buf.toString('utf8').split(/\r?\n/).map(parse).filter(Boolean);
  } finally { try { fs.closeSync(fd); } catch {} }
}

/**
 * Process pauses the chef has answered but that are still waiting after
 * graceMs: the answer was not applied (lost relay, refused launch, server
 * not restarted…). → [{ run, project, n, answer, answeredAt, waitingMs, options,
 * queued }] where queued is { id, enqueuedAt } when the answer was applied and waits in
 * the musician's queue, else null.
 */
export function unappliedChefAnswers({ logsDir, conductor, now = Date.now(), graceMs = ANSWER_GRACE_MS, chefEvents = null, maxRuns = 300 }) {
  const runsDir = path.join(logsDir, 'runs');
  let runs = [];
  try { runs = fs.readdirSync(runsDir).filter(r => /^p-\d{8}T\d{6}-[a-z0-9]{4,8}$/.test(r)).sort().reverse().slice(0, maxRuns); } catch { return []; }
  const pending = [];
  for (const r of runs) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(runsDir, r, 'run.json'), 'utf8')); } catch { continue; }
    if (s.status === 'paused' && s.chefPause?.status === 'pending' && Number.isFinite(s.chefPause.n)) pending.push({ run: r, state: s });
  }
  if (!pending.length) return [];
  const evs = chefEvents || readTail(path.join(logsDir, `${conductor}.jsonl`));
  const out = [];
  for (const { run, state } of pending) {
    const tag = `[${run} · pause ${state.chefPause.n}]`;
    const since = Date.parse(state.chefPause.at || '') || 0;
    let answer = null;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.type !== 'user_prompt' || typeof e.text !== 'string' || !e.text.includes(tag) || !CHEF_MARKER_RE.test(e.text)) continue;
      if (since && (Date.parse(e.timestamp || '') || 0) < since - 5000) continue;
      for (let j = i + 1; j < evs.length; j++) {
        const x = evs[j];
        if (x.type !== 'result') continue;
        if (e.orch_turn ? x.orch_turn === e.orch_turn : true) { answer = x; break; }
      }
      if (answer) break;
    }
    if (!answer) continue;
    const at = Date.parse(answer.timestamp || '') || 0;
    if (!at || now - at < graceMs) continue;
    out.push({ run, project: state.project, n: state.chefPause.n, answer: one(String(answer.result || '').replace(/^\s*\[ANSWER\]\s*/i, ''), 300),
      answeredAt: answer.timestamp, waitingMs: now - at, options: state.chefPause.options || [],
      queued: queuedAnswer(logsDir, state.project, run) });
  }
  return out;
}

/** The answer already applied with --pipeline-resume that waits in the musician's queue, or null. */
function queuedAnswer(logsDir, project, run) {
  if (!project) return null;
  let q;
  try { q = JSON.parse(fs.readFileSync(path.join(logsDir, 'queue', `${project}.json`), 'utf8')); } catch { return null; }
  const list = Array.isArray(q) ? q : (Array.isArray(q?.entries) ? q.entries : []);
  const e = list.find(x => x && x.pipelineResume === run);
  return e ? { id: e.id, enqueuedAt: e.enqueuedAt || null } : null;
}

/** The message that tells the chef its answer was not applied — a new question it can answer. */
export function unappliedText(u, { orchestratorRoot = null } = {}) {
  const min = Math.max(1, Math.round(u.waitingMs / 60000));
  const script = orchestratorRoot ? path.join(orchestratorRoot, 'scripts', 'dispatch.mjs').split(path.sep).join('/') : 'scripts/dispatch.mjs';
  if (u.queued) {
    // No NEEDS_CHEF_INPUT_FROM marker: this is information, its reply must never be relayed to the musician.
    return `[${u.run} · pause ${u.n}] ⏳ Ta réponse à la pause de processus n° ${u.n} de ${u.project} (exécution ${u.run}) est appliquée et attend en file (entrée ${u.queued.id}) depuis ${min} min : le musicien a un tour en cours, elle part dès qu’il est libre.\n\n` +
      `Ta réponse : « ${u.answer} »\n\n` +
      'Aucune action requise : ne réponds pas de nouveau, une seconde réponse créerait un doublon en file.';
  }
  return `[NEEDS_CHEF_INPUT_FROM:${u.project}] [${u.run} · pause ${u.n}] ⚠ Ta réponse à la pause de processus n° ${u.n} de ${u.project} (exécution ${u.run}) n’est pas appliquée depuis ${min} min : l’exécution est toujours en pause.\n\n` +
    `Ta réponse : « ${u.answer} »\n\n` +
    `Réponds de nouveau, exactement « [ANSWER] <choix> — <raison> » (choix proposés : ${u.options.map(o => `« ${o} »`).join(', ') || '—'}), ` +
    `ou applique-la toi-même : node "${script}" ${u.project} --pipeline-resume ${u.run} "<choix>". ` +
    'Si la décision revient en fait à l’utilisateur, réponds plutôt par NEEDS_USER_INPUT: <question reformulée>.';
}
