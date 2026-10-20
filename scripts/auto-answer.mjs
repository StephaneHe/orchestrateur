// ============================================================================
// scripts/auto-answer.mjs — answers in place of an inactive user (0.121.0)
// ============================================================================
//
// User rule (2026-10-20, verbatim): « si aucune activite de ma part depuis plus
// de 15 minutes, et qu'un process attend quelque chose de moi, et que je ne
// reponds pas dans les 5 minutes, opus 5.5 est charge et autorise a repondre a
// ma place. Un point de retours est cree si possible. Sinon il faut avancer »
// Confirmation (verbatim): « Ces gardes fous sont tres importants, garde les »
//
// - Activity: logs/user-activity.json, written on every user gesture the
//   server sees (ACTIVITY_ROUTES, browser or app user agent only).
// - Waits: NEEDS_USER_INPUT questions (musicians, chef, lanes), pipeline pauses,
//   permission requests, proposed gaps. Collected by the server (in-memory
//   permission store) and by collectLogWaits (logs).
// - Answer: one explicit claude-opus-5-5 turn (no fallback, served model
//   checked), read-only tools on the project, then an independent verification
//   turn against the guardrails. enforceGuardrails() is the code that decides:
//   a guardrail hit never lets an engaging answer through.
// - Guardrails: data/auto-answer-guardrails.json (versioned) on top of
//   MANDATORY_GUARDRAILS (code). Always active, independent of the switch, no
//   route can change them.
// - Recovery point before applying: git tag (with `git stash create` for
//   uncommitted work) and file backups; none possible ⇒ noted, work goes on.
// - Ledger: logs/auto-answers.json — shown to the user on return, with undo.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileAtomic } from './atomic-file.mjs';
import { tailLines, deriveState, isPhantomResult } from './fleet-status-core.mjs';

export const AUTO_MODEL = 'claude-opus-5-5';
export const MODEL_LABEL = 'Opus 5.5';
export const MARK = '🤖 réponse automatique (Opus 5.5, utilisateur inactif)';
export const RULE_VERBATIM = "si aucune activite de ma part depuis plus de 15 minutes, et qu'un process attend quelque chose de moi, et que je ne reponds pas dans les 5 minutes, opus 5.5 est charge et autorise a repondre a ma place. Un point de retours est cree si possible. Sinon il faut avancer";
export const SETTINGS_FILE = 'auto-answer-settings.json';
export const GUARDRAILS_FILE = path.join('data', 'auto-answer-guardrails.json');
export const LEDGER_MAX = 500;
export const BY = 'réponse automatique';

// The five guardrails decided by the user. The versioned file may add cases or
// guardrails; it can never remove one of these (loadGuardrails re-adds it).
export const MANDATORY_GUARDRAILS = Object.freeze([
  { id: 'argent', label: 'Argent ou paiement' },
  { id: 'secret', label: 'Mot de passe, code, secret ou clé' },
  { id: 'envoi-externe', label: "Signature ou envoi en son nom vers l'extérieur" },
  { id: 'suppression-definitive', label: 'Suppression sans retour possible' },
  { id: 'publication-prive', label: "Publication d'un dépôt privé" },
]);
// Pseudo-guardrail: the verification turn failed, so nothing engaging may pass.
export const VERIFY_FAILED = 'verification-impossible';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  idleMin: 15,          // user inactivity threshold
  waitMin: 5,           // how long a wait stays unanswered first
  maxPerProject: 3,     // auto answers per project during one absence
  maxTotal: 20,         // auto answers during one absence
  permissionLeadSec: 90, // a permission request expires on its own: answer before
  projects: [],         // optional allow-list (empty = every project)
});

// ---------------------------------------------------------------------------
// Settings (hot: read on every sweep)
// ---------------------------------------------------------------------------
const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : d);

export function readSettings(root) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(path.join(root, SETTINGS_FILE), 'utf8')) || {}; } catch { /* defaults */ }
  const D = DEFAULT_SETTINGS;
  return {
    enabled: j.enabled === undefined ? D.enabled : j.enabled === true,
    idleMin: num(j.idleMin, 0, 24 * 60, D.idleMin),
    waitMin: num(j.waitMin, 0, 24 * 60, D.waitMin),
    maxPerProject: num(j.maxPerProject, 0, 100, D.maxPerProject),
    maxTotal: num(j.maxTotal, 0, 1000, D.maxTotal),
    permissionLeadSec: num(j.permissionLeadSec, 0, 3600, D.permissionLeadSec),
    projects: Array.isArray(j.projects) ? j.projects.filter(p => typeof p === 'string').slice(0, 200) : [],
    updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : null,
    updatedBy: typeof j.updatedBy === 'string' ? j.updatedBy : null,
  };
}

/** Dashboard writes: the switch and the two delays. Below one minute only for test instances. */
export function writeSettings(root, patch, { by = 'utilisateur', testing = false } = {}) {
  const cur = readSettings(root);
  const next = { ...cur };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled : true ou false' };
    next.enabled = patch.enabled;
  }
  const lo = testing ? 0.01 : 1;
  for (const k of ['idleMin', 'waitMin']) {
    if (patch[k] === undefined) continue;
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < lo || v > 24 * 60) return { ok: false, status: 400, error: `${k} : nombre de minutes entre ${lo} et 1440` };
    next[k] = v;
  }
  if (patch.projects !== undefined) {
    if (!testing) return { ok: false, status: 400, error: 'projects : réglable dans le fichier seulement' };
    next.projects = Array.isArray(patch.projects) ? patch.projects.filter(p => typeof p === 'string') : [];
  }
  next.updatedAt = new Date().toISOString();
  next.updatedBy = String(by).slice(0, 40);
  writeFileAtomic(path.join(root, SETTINGS_FILE), JSON.stringify(next, null, 2) + '\n');
  return { ok: true, settings: readSettings(root) };
}

// ---------------------------------------------------------------------------
// Guardrails (mandatory, always active)
// ---------------------------------------------------------------------------
export function loadGuardrails(root) {
  const problems = [];
  let file = null;
  try { file = JSON.parse(fs.readFileSync(path.join(root, GUARDRAILS_FILE), 'utf8')); }
  catch (e) { problems.push(`fichier des garde-fous illisible (${e.message}) : garde-fous du code appliqués`); }
  const fromFile = Array.isArray(file?.guardrails) ? file.guardrails : [];
  const out = [];
  for (const m of MANDATORY_GUARDRAILS) {
    const f = fromFile.find(g => g && g.id === m.id);
    if (!f) problems.push(`garde-fou « ${m.id} » absent du fichier : rétabli depuis le code`);
    out.push({ id: m.id, label: (f && typeof f.label === 'string' && f.label) || m.label, mandatory: true,
      cases: Array.isArray(f?.cases) ? f.cases.filter(c => typeof c === 'string').slice(0, 30) : [] });
  }
  for (const g of fromFile) {
    if (!g || typeof g.id !== 'string' || !/^[a-z0-9-]{2,40}$/.test(g.id) || out.some(o => o.id === g.id)) continue;
    out.push({ id: g.id, label: String(g.label || g.id).slice(0, 120), mandatory: false,
      cases: Array.isArray(g.cases) ? g.cases.filter(c => typeof c === 'string').slice(0, 30) : [] });
  }
  return { guardrails: out, decision: file?.decision || null, problems };
}

// ---------------------------------------------------------------------------
// User activity
// ---------------------------------------------------------------------------
// User gestures the server sees (method POST, browser or app user agent).
export const ACTIVITY_ROUTES = Object.freeze([
  { re: /^\/api\/dispatch$/, kind: 'message' },
  { re: /^\/api\/projects\/[^/]+\/sessions\/new$/, kind: 'message' },
  { re: /^\/api\/conductor$/, kind: 'message' },
  { re: /^\/api\/permission\/[^/]+\/decide$/, kind: 'autorisation' },
  { re: /^\/api\/permission-rules$/, kind: 'autorisation' },
  { re: /^\/api\/project\/[^/]+\/denials\/ack$/, kind: 'autorisation' },
  { re: /^\/api\/question\/[^/]+\/resolve$/, kind: 'question' },
  { re: /^\/api\/ack\/[^/]+$/, kind: 'question' },
  { re: /^\/api\/pipeline-gaps\/[^/]+\/(accept|reject)$/, kind: 'lacune' },
  { re: /^\/api\/pipeline-runs\/[^/]+\/backoff$/, kind: 'pause' },
  { re: /^\/api\/queue\//, kind: 'menu' },
  { re: /^\/api\/pool\//, kind: 'menu' },
  { re: /^\/api\/auto-answer\//, kind: 'réponse-auto' },
  { re: /^\/api\/user-activity$/, kind: 'clic' },
]);
const USER_AGENT_RE = /Mozilla|okhttp|dalvik|android/i;

/** The activity a request stands for, or null (script, not a user gesture). */
export function activityOf({ method, path: p, userAgent, body }) {
  if (method !== 'POST' || !USER_AGENT_RE.test(userAgent || '')) return null;
  const r = ACTIVITY_ROUTES.find(x => x.re.test(p));
  if (!r) return null;
  // A dispatch relayed by a script (queue, chef, notify) is not the user.
  if (r.kind === 'message' && body && (typeof body.source === 'string' || body.queueIfBusy === true)) return null;
  if (typeof body?.by === 'string' && body.by === BY) return null;
  return { kind: r.kind === 'clic' && typeof body?.kind === 'string' ? body.kind.slice(0, 30) : r.kind };
}

const activityFile = (logsDir) => path.join(logsDir, 'user-activity.json');

export function readActivity(logsDir) {
  try {
    const j = JSON.parse(fs.readFileSync(activityFile(logsDir), 'utf8'));
    const at = Date.parse(j.at);
    return Number.isFinite(at) ? { at, kind: j.kind || null, source: j.source || null, project: j.project || null } : null;
  } catch { return null; }
}

export function recordActivity(logsDir, { kind = 'activité', source = null, project = null } = {}, now = Date.now()) {
  fs.mkdirSync(logsDir, { recursive: true });
  const rec = { at: new Date(now).toISOString(), kind, source, project };
  writeFileAtomic(activityFile(logsDir), JSON.stringify(rec) + '\n');
  return rec;
}

/** Idle = no gesture since `idleMin`. Unknown activity counts from the server boot. */
export function idleInfo({ activity, bootAt = 0, now = Date.now(), settings }) {
  const lastAt = Math.max(activity?.at || 0, bootAt || 0);
  const idleMs = Math.max(0, now - lastAt);
  return { lastAt, idleMs, idle: idleMs >= settings.idleMin * 60_000 };
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------
/** When a wait becomes due (permission requests expire on their own: answer before). */
export function dueAt(wait, settings) {
  const base = wait.since + settings.waitMin * 60_000;
  if (wait.kind === 'permission' && Number.isFinite(wait.deadline)) return Math.min(base, wait.deadline - settings.permissionLeadSec * 1000);
  return base;
}

/** Waits to answer now, oldest first, within the caps of this absence. */
export function dueWaits({ waits, now = Date.now(), idle, settings, ledger = [] }) {
  if (!settings.enabled || !idle.idle) return [];
  // An abandoned attempt (user came back) may be retried at the next absence; a failed one is not.
  const done = new Set(ledger.filter(d => d.status !== 'abandoned').map(d => d.key));
  const thisAbsence = ledger.filter(d => d.idleSince === idle.lastAt && d.status !== 'abandoned');
  const perProject = new Map();
  for (const d of thisAbsence) perProject.set(d.project, (perProject.get(d.project) || 0) + 1);
  let total = thisAbsence.length;
  const out = [];
  for (const w of [...waits].sort((a, b) => a.since - b.since)) {
    if (done.has(w.key)) continue;
    if (settings.projects.length && !settings.projects.includes(w.project)) continue;
    // A wait older than the last gesture was seen by the user: still due (unanswered).
    if (now < dueAt(w, settings)) continue;
    if (total >= settings.maxTotal) break;
    if ((perProject.get(w.project) || 0) >= settings.maxPerProject) continue;
    out.push(w);
    total++;
    perProject.set(w.project, (perProject.get(w.project) || 0) + 1);
  }
  return out;
}

function latestRunOf(logsDir, project) {
  const dir = path.join(logsDir, 'runs');
  let runs = [];
  try { runs = fs.readdirSync(dir).filter(r => /^p-\d{8}T\d{6}-[a-z0-9]{4,8}$/.test(r)).sort().reverse(); } catch { return null; }
  for (const r of runs.slice(0, 80)) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, r, 'run.json'), 'utf8')); } catch { continue; }
    if (s.project === project) return { run: r, state: s, file: path.join(dir, r, 'run.json') };
  }
  return null;
}

function lastResultTs(lines, mtimeMs) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (ev?.type !== 'result' || isPhantomResult(ev)) continue;
    const t = Date.parse(ev.timestamp || '');
    return Number.isFinite(t) ? t : mtimeMs;
  }
  return mtimeMs;
}

/** Recent exchanges of a log, for the model's context (user prompts and assistant texts). */
export function recentExchanges(lines, max = 6, cap = 2500) {
  const out = [];
  for (const ln of lines) {
    let ev; try { ev = JSON.parse(ln); } catch { continue; }
    if (ev?.type === 'user_prompt' && typeof ev.text === 'string') out.push({ who: ev.source ? `demande (${ev.source})` : 'demande', text: ev.text });
    else if (ev?.type === 'assistant') {
      const t = (ev.message?.content || []).filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n');
      if (t) out.push({ who: 'réponse', text: t });
    }
  }
  return out.slice(-max).map(e => ({ who: e.who, text: e.text.length > cap ? `${e.text.slice(0, cap)} […coupé : ${e.text.length} caractères]` : e.text }));
}

/**
 * Questions (NEEDS_USER_INPUT) and pipeline pauses read from the logs: lane 0
 * of every project (chef included) and every lane k ≥ 1.
 * projects: [{name, path}] from config.json.
 */
export function collectLogWaits({ logsDir, projects, conductor = 'chef', busy = () => false }) {
  const waits = [];
  for (const p of projects) {
    const logs = [{ lane: 0, file: path.join(logsDir, `${p.name}.jsonl`) }];
    try {
      for (const f of fs.readdirSync(path.join(logsDir, 'lanes', p.name))) {
        const m = /^(\d+)\.jsonl$/.exec(f);
        if (m && Number(m[1]) >= 1) logs.push({ lane: Number(m[1]), file: path.join(logsDir, 'lanes', p.name, f) });
      }
    } catch { /* no lanes */ }
    for (const { lane, file } of logs) {
      const { lines, mtimeMs } = tailLines(file);
      if (!lines.length) continue;
      const st = deriveState(lines);
      if (st.state !== 'input') continue;
      if (busy(p.name, lane)) continue;
      const since = lastResultTs(lines, mtimeMs);
      const question = (/^NEEDS_USER_INPUT:\s*([\s\S]*)$/m.exec(st.lastAssistantText || '') || [])[1]?.trim() || '';
      const isChef = p.name === conductor;
      const run = lane === 0 && !isChef ? latestRunOf(logsDir, p.name) : null;
      const paused = run && run.state.status === 'paused' ? run : null;
      waits.push({
        key: `log:${p.name}:${lane}:${new Date(since).toISOString()}`,
        kind: paused ? 'pause' : 'question', project: p.name, lane, isChef, since,
        question: question.slice(0, 4000),
        context: {
          lastText: String(st.lastAssistantText || '').slice(-12_000),
          exchanges: recentExchanges(lines),
          ...(paused ? { run: paused.run, pipeline: paused.state.pipeline, pausedLimit: paused.state.pausedLimit || null, runFile: paused.file } : {}),
        },
      });
    }
  }
  return waits;
}

/** Permission requests of the server's store (scripts/permission-store.mjs views). */
export function permissionWaits(pending, details = () => null) {
  return pending.filter(r => r.status === 'pending').map(r => {
    const d = details(r.id) || {};
    return {
      key: `perm:${r.id}`, kind: 'permission', project: r.project, lane: 0, since: r.createdAt, deadline: r.deadline,
      question: `Autoriser ${r.tool} : ${r.preview}`,
      context: { id: r.id, tool: r.tool, preview: r.preview, risk: r.risk, why: r.why, explanation: r.explanation?.text || null,
        lastText: d.lastText || '', step: r.step || null },
    };
  });
}

/** Proposed gaps not decided yet (pipeline-observe gaps().open). */
export function gapWaits(open) {
  return open.map(g => ({
    key: `gap:${g.key}`, kind: 'gap', project: g.entries?.[0]?.project || null, lane: 0,
    since: Date.parse(g.firstAt) || Date.now(),
    question: `Lacune proposée : ${g.why || ''}`.slice(0, 2000),
    context: { gapKey: g.key, why: g.why || '', proposal: g.proposal || null, alternative: g.alternative || null,
      examples: (g.entries || []).map(e => e.head).filter(Boolean).slice(0, 5) },
  }));
}

// ---------------------------------------------------------------------------
// Prompts and parsing
// ---------------------------------------------------------------------------
function guardrailBlock(guardrails) {
  return guardrails.map(g => `- ${g.id} — ${g.label}${g.cases.length ? `\n${g.cases.map(c => `    • ${c}`).join('\n')}` : ''}`).join('\n');
}

const KIND_HELP = {
  question: 'A process asked the user a question (NEEDS_USER_INPUT). Your "answer" is sent to it as the user\'s reply.',
  pause: 'A pipeline run is paused and offers a menu. Start "answer" with the exact menu word you choose (for example « continuer », « accepter », « abandonner », « simplifier », « tout supprimer »), then one sentence explaining why.',
  permission: 'A process asks for permission to run a tool. Set "decision" to "allow" (this time only, never a permanent rule) or "deny"; "answer" is the short message given with the decision.',
  gap: 'The orchestrator proposed a gap (a task no pipeline covers) with a proposal. Set "decision" to "accept" (apply the proposal) or "reject"; "answer" explains why.',
};

export function answerPrompt(wait, { guardrails, sources = [], idleMin, waitMin }) {
  const c = wait.context || {};
  const ctx = [];
  if (wait.kind === 'question' || wait.kind === 'pause') {
    if (c.exchanges?.length) ctx.push('Recent exchanges of this process (oldest first):', ...c.exchanges.map(e => `--- ${e.who} ---\n${e.text}`));
    if (c.lastText) ctx.push('--- full last message (it holds the question and, often, a recommendation) ---', c.lastText);
    if (c.run) ctx.push(`Paused run: ${c.run} (pipeline ${c.pipeline}, pause « ${c.pausedLimit || '?'} »).`);
  } else if (wait.kind === 'permission') {
    ctx.push(`Tool: ${c.tool}`, `Command / input: ${c.preview}`, `Risk (computed): ${c.risk || '?'}`, `Why asked: ${c.why || '?'}`);
    if (c.explanation) ctx.push(`Explanation (computed from the command):\n${c.explanation}`);
    if (c.lastText) ctx.push(`Last message of the process before the request:\n${c.lastText}`);
  } else if (wait.kind === 'gap') {
    ctx.push(`Why: ${c.why}`, `Proposal: ${JSON.stringify(c.proposal)}`, ...(c.alternative ? [`Alternative: ${JSON.stringify(c.alternative)}`] : []),
      ...(c.examples?.length ? ['Requests that raised it:', ...c.examples.map(e => `- ${e}`)] : []));
  }
  const decisionField = wait.kind === 'permission' ? '"decision": "allow" | "deny", '
    : wait.kind === 'gap' ? '"decision": "accept" | "reject", ' : '';
  return [
    '[AUTO_ANSWER]',
    `You answer IN PLACE OF the user, who has had no activity for more than ${idleMin} min; this ${wait.kind} has waited for more than ${waitMin} min.`,
    `The user's rule (verbatim, French): « ${RULE_VERBATIM} »`,
    'Follow FIRST the recommendation given in the question itself, then the decisions the user already made. Read the sources below (read-only tools: Read, Grep, Glob) before deciding; never contradict them; never invent a preference.',
    '',
    'GUARDRAILS — mandatory, always active (« Ces gardes fous sont tres importants, garde les »). If the question touches one of them, choose the option that lets the work move forward WITHOUT engaging it: decline or postpone that part, take the non-committing variant. Never pay, never give/create/reveal a secret, never send or sign in the user\'s name, never delete without a way back, never publish a private repository.',
    guardrailBlock(guardrails),
    '',
    `KIND: ${wait.kind}${wait.isChef ? ' (asked by the chef, the conductor)' : ''} — project: ${wait.project || '—'}${wait.lane ? ` (lane ${wait.lane})` : ''}`,
    KIND_HELP[wait.kind] || '',
    '',
    'QUESTION:',
    '<<<', wait.question || '(see the context)', '>>>',
    '',
    'CONTEXT:', ...ctx,
    '',
    sources.length ? `SOURCES to consult first (decisions, recommendations, syntheses, memory):\n${sources.map(s => `- ${s}`).join('\n')}` : '',
    '',
    'Reply with ONE JSON object only, no prose around it. All texts in French:',
    `{"answer": "<the reply sent in the user's place>", ${decisionField}"engages": [<ids of the guardrails YOUR answer would engage, [] if none>], "concerns": [<ids of the guardrails the question touches>], "safeAnswer": "<the reply that moves forward without engaging any guardrail>", "reason": "<why: the recommendation or decision you followed>", "sources": [<files you relied on>]}`,
  ].join('\n');
}

export function verifyPrompt(wait, proposal, guardrails) {
  return [
    '[AUTO_VERIFY]',
    'An assistant is about to answer in place of an absent user. You are the independent check. Judge ONLY whether each proposed reply, once applied, would ENGAGE one of these guardrails (pay, give a secret, send or sign in the user\'s name, delete without a way back, publish a private repository — and the cases listed):',
    guardrailBlock(guardrails),
    '',
    `Kind: ${wait.kind} — project: ${wait.project || '—'}`,
    'Question:', '<<<', wait.question || '', '>>>',
    ...(wait.kind === 'permission' ? [`Tool: ${wait.context?.tool} — input: ${wait.context?.preview}`] : []),
    'Proposed reply:', '<<<', `${proposal.decision ? `[decision: ${proposal.decision}] ` : ''}${proposal.answer}`, '>>>',
    'Non-engaging alternative:', '<<<', proposal.safeAnswer || '(none)', '>>>',
    '',
    'Reply with ONE JSON object only: {"answerEngages": [<guardrail ids>], "safeEngages": [<guardrail ids>], "why": "<in French>"}',
  ].join('\n');
}

export function parseJsonReply(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const ids = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean) : []);

export function normalizeAnswer(wait, j) {
  if (!j || typeof j !== 'object') return { ok: false, why: 'réponse du model illisible (JSON attendu)' };
  const answer = typeof j.answer === 'string' ? j.answer.trim() : '';
  let decision = null;
  if (wait.kind === 'permission') decision = j.decision === 'allow' ? 'allow' : j.decision === 'deny' ? 'deny' : null;
  if (wait.kind === 'gap') decision = j.decision === 'accept' ? 'accept' : j.decision === 'reject' ? 'reject' : null;
  if ((wait.kind === 'permission' || wait.kind === 'gap') && !decision) return { ok: false, why: 'décision absente ou invalide' };
  if (!answer && !decision) return { ok: false, why: 'réponse vide' };
  return { ok: true, answer: answer.slice(0, 8000), decision, engages: ids(j.engages), concerns: ids(j.concerns),
    safeAnswer: typeof j.safeAnswer === 'string' ? j.safeAnswer.trim().slice(0, 8000) : '',
    reason: typeof j.reason === 'string' ? j.reason.trim().slice(0, 2000) : '', sources: ids(j.sources).slice(0, 20) };
}

/**
 * The code that decides. Any guardrail named by the answer itself or by the
 * independent verification — or a failed verification — blocks the engaging
 * answer. The non-engaging option is then: deny (permission), the safe answer
 * when the verification judged it clean, otherwise nothing is sent and the
 * point is submitted to the user.
 * Returns { mode: 'answer'|'safe'|'submit', text, decision, hits, why }.
 */
export function enforceGuardrails(wait, ans, verdict, guardrails) {
  const known = new Set(guardrails.map(g => g.id));
  const hits = new Set(ans.engages.filter(x => known.has(x)));
  const verified = !!verdict?.ok;
  if (!verified) hits.add(VERIFY_FAILED);
  else for (const x of ids(verdict.answerEngages)) if (known.has(x)) hits.add(x);
  const concerns = ans.concerns.filter(x => known.has(x));
  if (!hits.size) return { mode: 'answer', text: ans.answer, decision: ans.decision, hits: [], concerns, why: null };
  const list = [...hits];
  const why = list.includes(VERIFY_FAILED) ? 'vérification indépendante impossible' : `garde-fou : ${list.join(', ')}`;
  if (wait.kind === 'permission') {
    return { mode: 'safe', decision: 'deny', hits: list, concerns, why,
      text: `Refusé par la réponse automatique (${why}) : l'utilisateur décidera à son retour.` };
  }
  const safeClean = verified && ans.safeAnswer && !ids(verdict.safeEngages).some(x => known.has(x));
  if (wait.kind !== 'gap' && safeClean) return { mode: 'safe', text: ans.safeAnswer, decision: null, hits: list, concerns, why };
  return { mode: 'submit', text: null, decision: null, hits: list, concerns, why };
}

// ---------------------------------------------------------------------------
// The model turn (explicit model, no fallback)
// ---------------------------------------------------------------------------
export function resolveClaudeBin(env = process.env) {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  if (process.platform !== 'win32') return 'claude';
  const home = env.USERPROFILE || env.HOME;
  for (const f of home ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd')] : []) {
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return 'claude';
}

const servedOk = (served, model) => !!served && (served === model || served.startsWith(`${model}-`) || served.startsWith(`${model}[`));

/**
 * One claude turn on `model`, read-only tools, cwd = the project. The prompt
 * goes on stdin (stream-json): it can exceed the Windows command-line limit.
 * Returns { ok, text, served, why, costUsd }.
 */
export function runOpus(prompt, { model = AUTO_MODEL, cwd = process.cwd(), addDirs = [], env = process.env, timeoutMs = 6 * 60_000, maxTurns = 30 } = {}) {
  return new Promise((resolve) => {
    const bin = resolveClaudeBin(env);
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model,
      '--allowed-tools', 'Read,Grep,Glob', '--setting-sources', 'project,local', '--strict-mcp-config',
      '--disable-slash-commands', '--max-turns', String(maxTurns)];
    for (const d of addDirs) if (d && fs.existsSync(d)) args.push('--add-dir', d);
    args.push('--verbose');
    const childEnv = { ...env };
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID']) delete childEnv[k];
    const isJs = /\.(mjs|js|cjs)$/i.test(bin);
    let c;
    try { c = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, { cwd: fs.existsSync(cwd) ? cwd : process.cwd(), env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ ok: false, why: `lancement impossible : ${e.message}` }); return; }
    let out = '', err = '';
    const t = setTimeout(() => { try { c.kill(); } catch { /* gone */ } resolve({ ok: false, why: 'délai dépassé' }); }, timeoutMs);
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('error', e => { clearTimeout(t); resolve({ ok: false, why: e.message }); });
    c.on('close', (code) => {
      clearTimeout(t);
      let text = '', isErr = false, served = null, cost = null;
      const models = new Set();
      for (const line of out.split(/\r?\n/)) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init' && ev.model) served = ev.model;
        if (ev.type === 'assistant' && ev.message?.model && ev.message.model !== '<synthetic>') models.add(ev.message.model);
        if (ev.type === 'result') { text = typeof ev.result === 'string' ? ev.result : text; isErr = !!ev.is_error; cost = Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : null; }
      }
      const wrong = [served, ...models].find(m => m && !servedOk(m, model));
      if (wrong) return resolve({ ok: false, served, why: `model servi ${wrong} au lieu de ${model} — aucun repli (model explicite)` });
      if (!served) return resolve({ ok: false, why: `aucun model annoncé (${(err || `code ${code}`).replace(/\s+/g, ' ').slice(0, 200)})` });
      if (code !== 0 || isErr || !text.trim()) return resolve({ ok: false, served, why: (isErr ? text : err || `code ${code}`).replace(/\s+/g, ' ').slice(0, 300) });
      resolve({ ok: true, text: text.trim(), served, costUsd: cost });
    });
    c.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Recovery point and undo
// ---------------------------------------------------------------------------
function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts }).trim();
}
const samePath = (a, b) => {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
/** The folder IS the root of its own repository. A folder inside another
 *  repository is not: tagging (or undoing in) the parent would touch the
 *  wrong project. */
export function isGitRepo(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    return !!top && samePath(top, fs.realpathSync(dir));
  } catch { return false; }
}
export const recoveryTag = (id) => `auto-answer/${id}`;
export const undoTag = (id) => `auto-answer-undo/${id}`;

/** Snapshot of HEAD plus uncommitted tracked changes, kept by an annotated tag. */
function gitSnapshot(repo, tag, message) {
  const head = git(repo, ['rev-parse', 'HEAD']);
  let stash = '';
  try { stash = git(repo, ['stash', 'create']); } catch { stash = ''; }
  git(repo, ['tag', '-a', tag, stash || head, '-m', message]);
  return { repo, head, stash: stash || null, tag };
}

/**
 * Before applying: git tag of the repository (`git stash create` keeps the
 * uncommitted tracked work) and a copy of each state file. Never throws:
 * { possible, git?, files, text, none? }.
 */
export function makeRecoveryPoint({ id, logsDir, repo = null, files = [] }) {
  const out = { possible: false, git: null, files: [], notes: [] };
  if (repo) {
    if (isGitRepo(repo)) {
      try { out.git = gitSnapshot(repo, recoveryTag(id), `Return point before auto-answer ${id} (Opus 5.5, user inactive)`); }
      catch (e) { out.notes.push(`tag git impossible : ${String(e.message).split('\n')[0]}`); }
    } else out.notes.push('dossier hors git : aucun tag possible');
  }
  const dir = path.join(logsDir, 'auto-answers', id);
  for (const f of files) {
    try {
      if (!f || !fs.existsSync(f)) continue;
      fs.mkdirSync(dir, { recursive: true });
      const backup = path.join(dir, path.basename(f));
      fs.copyFileSync(f, backup);
      out.files.push({ file: f, backup });
    } catch (e) { out.notes.push(`copie de ${path.basename(f)} impossible : ${e.message}`); }
  }
  out.possible = !!out.git || out.files.length > 0;
  out.text = recoveryText(out);
  return out;
}

export function recoveryText(r) {
  if (!r?.possible) return `Aucun point de retour possible${r?.notes?.length ? ` (${r.notes.join(' ; ')})` : ''} : on avance quand même.`;
  const parts = [];
  if (r.git) parts.push(`tag git ${r.git.tag} dans ${r.git.repo}${r.git.stash ? ' (modifications non commitées comprises, hors fichiers non suivis)' : ''}`);
  for (const f of r.files) parts.push(`copie de ${path.basename(f.file)} (${f.backup})`);
  return `Point de retour : ${parts.join(' ; ')}. Retour arrière : bouton « Annuler » du résumé, ou git reset --hard ${r.git ? r.git.head.slice(0, 12) : '…'}${r.git?.stash ? ` puis git stash apply ${r.git.tag}` : ''}.`;
}

/** Removes a gap decision and the additions it applied (entries absent from the backup). */
export function undoGapDecision(routingFile, backupFile, gapKey) {
  const cur = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
  const old = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  if (cur.gapDecisions) delete cur.gapDecisions[gapKey];
  for (const k of ['pipelines', 'steps', 'variants', 'attach']) {
    const before = new Set((old.custom?.[k] || []).map(x => JSON.stringify(x)));
    if (Array.isArray(cur.custom?.[k])) cur.custom[k] = cur.custom[k].filter(x => before.has(JSON.stringify(x)));
  }
  cur.updatedAt = new Date().toISOString();
  writeFileAtomic(routingFile, JSON.stringify(cur, null, 2) + '\n');
}

/**
 * Undo of one decision. Git: the current state is tagged first
 * (auto-answer-undo/<id>), then HEAD and the uncommitted work of the return
 * point come back. Files: the copies come back (gap: targeted undo).
 */
export function undoRecovery(rec, { busy = () => false, routingFile = null } = {}) {
  const r = rec.recovery;
  if (!r?.possible) return { ok: false, status: 409, error: 'aucun point de retour pour cette décision' };
  if (rec.undone) return { ok: false, status: 409, error: 'décision déjà annulée' };
  if (busy(rec.project, rec.lane)) return { ok: false, status: 409, error: `${rec.project} a un tour en cours : annuler après la fin du tour` };
  const done = [];
  if (r.git && !isGitRepo(r.git.repo)) return { ok: false, status: 409, error: `${r.git.repo} n’est plus la racine d’un dépôt git : annulation refusée` };
  if (r.git) {
    const safety = gitSnapshot(r.git.repo, undoTag(rec.id), `State before undoing auto-answer ${rec.id}`);
    git(r.git.repo, ['reset', '--hard', r.git.head]);
    if (r.git.stash) git(r.git.repo, ['stash', 'apply', r.git.stash]);
    done.push(`dépôt remis au point de retour (état d'avant l'annulation gardé dans le tag ${safety.tag})`);
  }
  for (const f of r.files) {
    if (rec.kind === 'gap' && routingFile && path.resolve(f.file) === path.resolve(routingFile)) {
      undoGapDecision(routingFile, f.backup, rec.gapKey);
      done.push('décision sur la lacune retirée');
    } else {
      fs.copyFileSync(f.backup, f.file);
      done.push(`${path.basename(f.file)} restauré`);
    }
  }
  return { ok: true, done };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------
const ledgerFile = (logsDir) => path.join(logsDir, 'auto-answers.json');

export function readLedger(logsDir) {
  try { const j = JSON.parse(fs.readFileSync(ledgerFile(logsDir), 'utf8')); return Array.isArray(j.decisions) ? j.decisions : []; }
  catch { return []; }
}
function writeLedger(logsDir, decisions) {
  fs.mkdirSync(logsDir, { recursive: true });
  writeFileAtomic(ledgerFile(logsDir), JSON.stringify({ version: 1, decisions: decisions.slice(-LEDGER_MAX) }, null, 2) + '\n');
}
export function upsertDecision(logsDir, rec) {
  const all = readLedger(logsDir);
  const i = all.findIndex(d => d.id === rec.id);
  if (i >= 0) all[i] = rec; else all.push(rec);
  writeLedger(logsDir, all);
  return rec;
}
export function markSeen(logsDir, idsToMark = null, now = Date.now()) {
  const all = readLedger(logsDir);
  let n = 0;
  for (const d of all) if (!d.seenAt && d.status !== 'running' && (!idsToMark || idsToMark.includes(d.id))) { d.seenAt = new Date(now).toISOString(); n++; }
  writeLedger(logsDir, all);
  return n;
}
export const newId = (now = Date.now()) => `aa-${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;

const STATUS_TEXT = {
  applied: 'répondu à votre place', safe: 'option non engageante choisie (garde-fou)', submitted: 'soumis à votre décision (garde-fou)',
  failed: 'échec : rien n’a été répondu', abandoned: 'abandonné : vous êtes revenu ou la demande a été traitée',
};
export const statusText = (s) => STATUS_TEXT[s] || s;

/** Card text (fil, journal, log of the process). */
export function decisionText(rec) {
  const head = `${MARK} — ${statusText(rec.status)}`;
  const lines = [head, `Demande : ${String(rec.question || '').replace(/\s+/g, ' ').slice(0, 300)}`];
  if (rec.answer) lines.push(`Réponse : ${rec.decision ? `[${rec.decision}] ` : ''}${String(rec.answer).slice(0, 1200)}`);
  if (rec.reason) lines.push(`Raison : ${rec.reason}`);
  if (rec.guardrails?.hits?.length) lines.push(`Garde-fous : ${rec.guardrails.hits.join(', ')}`);
  if (rec.recovery) lines.push(rec.recovery.text);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
/**
 * deps:
 *   root, logsDir, bootAt, now()
 *   listWaits(): Promise<wait[]> | wait[]
 *   stillOpen(wait): bool          — re-checked right before applying
 *   repoOf(wait): path | null      — git repository for the return point
 *   filesOf(wait): path[]          — state files to copy
 *   apply(wait, final, rec): {ok, why?}
 *   report(rec): void              — cards (fil, process log)
 *   sources(wait): path[]          — decisions/recommendations to read first
 *   addDirs(wait): path[]
 *   runModel(prompt, opts)         — default runOpus
 */
export function createAutoAnswer(deps) {
  const now = deps.now || (() => Date.now());
  const runModel = deps.runModel || runOpus;
  const log = deps.log || (() => {});
  let running = null;

  function state() {
    const settings = readSettings(deps.root);
    const idle = idleInfo({ activity: readActivity(deps.logsDir), bootAt: deps.bootAt || 0, now: now(), settings });
    return { settings, idle };
  }

  async function processWait(wait, settings, idle) {
    const { guardrails } = loadGuardrails(deps.root);
    const rec = {
      id: newId(now()), key: wait.key, kind: wait.kind, project: wait.project, lane: wait.lane || 0, isChef: !!wait.isChef,
      since: new Date(wait.since).toISOString(), at: new Date(now()).toISOString(), idleSince: idle.lastAt,
      idleMin: Math.round(idle.idleMs / 60_000), waitedMin: Math.round((now() - wait.since) / 60_000),
      question: String(wait.question || '').slice(0, 4000), model: AUTO_MODEL, status: 'running',
      ...(wait.context?.run ? { run: wait.context.run } : {}), ...(wait.context?.gapKey ? { gapKey: wait.context.gapKey } : {}),
      ...(wait.context?.id && wait.kind === 'permission' ? { permissionId: wait.context.id } : {}),
    };
    upsertDecision(deps.logsDir, rec);
    const opts = { cwd: deps.cwdOf?.(wait) || deps.root, addDirs: deps.addDirs?.(wait) || [], env: deps.env || process.env };
    const fail = (why) => { rec.status = 'failed'; rec.why = why; upsertDecision(deps.logsDir, rec); log(`[auto-answer] ${wait.key} : échec — ${why}`); return rec; };

    const a = await runModel(answerPrompt(wait, { guardrails, sources: deps.sources?.(wait) || [], idleMin: settings.idleMin, waitMin: settings.waitMin }), opts);
    rec.served = a.served || null;
    if (!a.ok) return fail(`model ${AUTO_MODEL} : ${a.why}`);
    const ans = normalizeAnswer(wait, parseJsonReply(a.text));
    if (!ans.ok) return fail(ans.why);
    const v = await runModel(verifyPrompt(wait, ans, guardrails), { ...opts, maxTurns: 1, addDirs: [] });
    const vj = v.ok ? parseJsonReply(v.text) : null;
    const verdict = vj && Array.isArray(vj.answerEngages) ? { ok: true, answerEngages: vj.answerEngages, safeEngages: vj.safeEngages || [], why: vj.why || '' }
      : { ok: false, why: v.ok ? 'réponse de vérification illisible' : v.why };
    const final = enforceGuardrails(wait, ans, verdict, guardrails);
    Object.assign(rec, {
      reason: ans.reason, sources: ans.sources, proposed: { answer: ans.answer, decision: ans.decision },
      guardrails: { hits: final.hits, concerns: final.concerns, verifier: verdict.ok ? { answerEngages: ids(verdict.answerEngages), safeEngages: ids(verdict.safeEngages), why: verdict.why } : { failed: verdict.why } },
      answer: final.text, decision: final.decision,
    });

    // The user came back, or the wait was answered meanwhile: nothing is applied.
    const again = state();
    if (again.idle.lastAt !== idle.lastAt || !again.settings.enabled || !(await deps.stillOpen(wait))) {
      rec.status = 'abandoned';
      rec.why = again.idle.lastAt !== idle.lastAt ? 'utilisateur revenu' : !again.settings.enabled ? 'règle coupée entre-temps' : 'demande déjà traitée';
      upsertDecision(deps.logsDir, rec);
      return rec;
    }
    if (final.mode === 'submit') {
      rec.status = 'submitted';
      rec.why = final.why;
      rec.recovery = null;
      upsertDecision(deps.logsDir, rec);
      try { deps.report?.(rec); } catch (e) { log(`[auto-answer] carte : ${e.message}`); }
      return rec;
    }
    rec.recovery = makeRecoveryPoint({ id: rec.id, logsDir: deps.logsDir, repo: deps.repoOf?.(wait) || null, files: deps.filesOf?.(wait) || [] });
    rec.status = final.mode === 'safe' ? 'safe' : 'applied';
    upsertDecision(deps.logsDir, rec);
    let r;
    try { r = await deps.apply(wait, final, rec); } catch (e) { r = { ok: false, why: e.message }; }
    if (!r?.ok) return fail(`application impossible : ${r?.why || '?'}`);
    upsertDecision(deps.logsDir, rec);
    try { deps.report?.(rec); } catch (e) { log(`[auto-answer] carte : ${e.message}`); }
    log(`[auto-answer] ${wait.key} → ${rec.status} (${rec.id})`);
    return rec;
  }

  /** One pass: at most one wait answered (the next sweep takes the next one). */
  async function sweep() {
    if (running) return { skipped: 'en cours' };
    const { settings, idle } = state();
    if (!settings.enabled) return { skipped: 'règle coupée' };
    if (!idle.idle) return { skipped: 'utilisateur actif' };
    running = (async () => {
      const waits = await deps.listWaits();
      const due = dueWaits({ waits, now: now(), idle, settings, ledger: readLedger(deps.logsDir) });
      if (!due.length) return { answered: null };
      return { answered: await processWait(due[0], settings, idle) };
    })();
    try { return await running; } finally { running = null; }
  }

  function view(n = 50) {
    const { settings, idle } = state();
    const decisions = readLedger(deps.logsDir);
    const g = loadGuardrails(deps.root);
    return {
      ok: true, model: AUTO_MODEL, mark: MARK, rule: RULE_VERBATIM, settings,
      guardrails: g.guardrails, guardrailsDecision: g.decision, guardrailsProblems: g.problems, guardrailsAlwaysOn: true,
      activity: { lastAt: idle.lastAt ? new Date(idle.lastAt).toISOString() : null, idleMs: idle.idleMs, idle: idle.idle, last: readActivity(deps.logsDir) },
      unseen: decisions.filter(d => !d.seenAt && d.status !== 'running').length,
      decisions: decisions.slice(-n).reverse().map(d => ({ ...d, statusText: statusText(d.status), text: decisionText(d),
        undoable: !!d.recovery?.possible && !d.undone && (d.status === 'applied' || d.status === 'safe') })),
    };
  }

  function undo(id) {
    const rec = readLedger(deps.logsDir).find(d => d.id === id);
    if (!rec) return { ok: false, status: 404, error: 'décision inconnue' };
    if (rec.status !== 'applied' && rec.status !== 'safe') return { ok: false, status: 409, error: 'rien à annuler : aucune réponse n’a été appliquée' };
    let r;
    try { r = undoRecovery(rec, { busy: deps.busy || (() => false), routingFile: deps.routingFile || null }); }
    catch (e) { return { ok: false, status: 500, error: `annulation impossible : ${String(e.message).split('\n')[0]}` }; }
    if (!r.ok) return r;
    rec.undone = { at: new Date(now()).toISOString(), done: r.done };
    upsertDecision(deps.logsDir, rec);
    try { deps.onUndo?.(rec); } catch { /* card best-effort */ }
    return { ok: true, decision: rec, done: r.done };
  }

  return { sweep, view, undo, state, seen: (list) => markSeen(deps.logsDir, list, now()), processWait };
}
