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
// 0.123.0 (incident of 2026-10-20: ten-day-old gaps rejected while the user
// was reading the dashboard):
// - presence counts: the dashboard / app send a heartbeat while visible,
//   focused and used; `presentSince` starts each presence period;
// - only waits born after the rule's activation AND after the user's last
//   return, and gaps actually presented, are ever answered; the rest is backlog;
// - each notification says what, on which element, and why the user was
//   considered inactive; decisions can be dismissed (kept as history).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileAtomic } from './atomic-file.mjs';
import { tailLines, deriveState, isPhantomResult } from './fleet-status-core.mjs';
import { matchOptionKey, OPTION_KEYS } from './pause-diagnosis.mjs';

export const AUTO_MODEL = 'claude-opus-5-5';
export const MODEL_LABEL = 'Opus 5.5';
export const MARK = '🤖 réponse automatique (Opus 5.5, utilisateur inactif)';
export const RULE_VERBATIM = "si aucune activite de ma part depuis plus de 15 minutes, et qu'un process attend quelque chose de moi, et que je ne reponds pas dans les 5 minutes, opus 5.5 est charge et autorise a repondre a ma place. Un point de retours est cree si possible. Sinon il faut avancer";
export const SETTINGS_FILE = 'auto-answer-settings.json';
export const GUARDRAILS_FILE = path.join('data', 'auto-answer-guardrails.json');
export const LEDGER_MAX = 500;
export const BY = 'réponse automatique';

// Pipeline limit pauses (KG synthesis, decision 6; user, 2026-10-20: « Réponse
// en votre absence face à une limite de pipeline.: applique la
// recommandation »). Decision 14 of the pipelines still holds: the engine never
// crosses a limit by itself, it pauses and asks. In the user's absence Opus may
// answer that question, within four bounds: once per run, a git return point
// first, an answer marked « 🤖 auto », never an option that closes the run.
// Budget limits only. Exhausted attempts (`green`, `criteria`) are error
// pauses under the smart-pause rule (0.122.0), whose requirement test keeps
// « abandonner » as their non-engaging option: extending these bounds to them
// needs the user's decision.
export const LIMIT_PAUSES = Object.freeze(['items', 'review', 'duration', 'item_tests', 'items_blocked']);
export const LIMIT_MARK = '🤖 auto';
// Never picked on a limit: `abandon` closes the run (abandonner, simplifier,
// livrer sans eux); `model` only works after the user changes the Models page.
export const LIMIT_FORBIDDEN_EFFECTS = Object.freeze(['abandon', 'model']);
export const isLimitPause = (w) => w?.kind === 'pause' && LIMIT_PAUSES.includes(w.context?.pausedLimit);
/** The options of a limit pause the automatic answer may choose (derived from the diagnosed cause). */
export function limitOptions(diagnosis) {
  return (diagnosis?.options || []).filter(o => OPTION_KEYS[o.key] && !LIMIT_FORBIDDEN_EFFECTS.includes(OPTION_KEYS[o.key]));
}
/** The menu words a pause answer must start with ([] = free answer). */
function pauseMenu(wait) {
  if (wait.kind !== 'pause') return [];
  return (isLimitPause(wait) ? limitOptions(wait.context?.diagnosis) : wait.context?.diagnosis?.options || []).map(o => o.key);
}
const LIMIT_COUNTED = ['running', 'applied', 'safe'];
/** Has this run's limit already been answered automatically once? */
export const limitAnswered = (wait, ledger = []) => ledger.some(d => d.limitPause && d.run && d.run === wait.context?.run && LIMIT_COUNTED.includes(d.status));

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
    // When the rule was switched on: waits born before it are backlog, never answered (0.123.0).
    activatedAt: typeof j.activatedAt === 'string' && Number.isFinite(Date.parse(j.activatedAt)) ? j.activatedAt : null,
    updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : null,
    updatedBy: typeof j.updatedBy === 'string' ? j.updatedBy : null,
  };
}

/**
 * The rule's activation date, written once when it is missing (a rule enabled
 * by default before 0.123.0 had none): every wait born before it is backlog.
 */
export function ensureActivation(root, now = Date.now()) {
  const cur = readSettings(root);
  if (!cur.enabled || cur.activatedAt) return cur;
  let j = {};
  try { j = JSON.parse(fs.readFileSync(path.join(root, SETTINGS_FILE), 'utf8')) || {}; } catch { /* none yet */ }
  writeFileAtomic(path.join(root, SETTINGS_FILE), JSON.stringify({ ...j, activatedAt: new Date(now).toISOString() }, null, 2) + '\n');
  return readSettings(root);
}

/** Dashboard writes: the switch and the two delays. Below one minute only for test instances. */
export function writeSettings(root, patch, { by = 'utilisateur', testing = false } = {}) {
  const cur = readSettings(root);
  const next = { ...cur };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled : true ou false' };
    if (patch.enabled && !cur.enabled) next.activatedAt = new Date().toISOString();
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

// Presence kinds sent by the dashboard / the app while the user is there
// (reading counts: tab visible and focused, recent pointer, scroll or keys).
export const PRESENCE_KINDS = Object.freeze(['présence', 'lecture', 'saisie', 'panneau', 'retour']);

export function readActivity(logsDir) {
  try {
    const j = JSON.parse(fs.readFileSync(activityFile(logsDir), 'utf8'));
    const at = Date.parse(j.at);
    if (!Number.isFinite(at)) return null;
    const ps = Date.parse(j.presentSince || '');
    const g = Date.parse(j.lastGestureAt || '');
    return { at, kind: j.kind || null, source: j.source || null, project: j.project || null,
      presentSince: Number.isFinite(ps) && ps <= at ? ps : at,
      lastGestureAt: Number.isFinite(g) ? g : null, lastGestureKind: j.lastGestureKind || null };
  } catch { return null; }
}

/**
 * One sign of the user (gesture or presence). `presentSince` is the start of
 * the current presence period: it starts again after `idleMs` without any sign
 * (the user's return). Waits born before it are backlog (0.123.0).
 */
export function recordActivity(logsDir, { kind = 'activité', source = null, project = null } = {}, now = Date.now(), { idleMs = DEFAULT_SETTINGS.idleMin * 60_000 } = {}) {
  fs.mkdirSync(logsDir, { recursive: true });
  const prev = readActivity(logsDir);
  const continued = prev && now >= prev.at && now - prev.at < idleMs;
  const presence = PRESENCE_KINDS.includes(kind);
  const rec = { at: new Date(now).toISOString(), kind, source, project,
    presentSince: new Date(continued ? prev.presentSince : now).toISOString(),
    lastGestureAt: presence ? (prev?.lastGestureAt ? new Date(prev.lastGestureAt).toISOString() : null) : new Date(now).toISOString(),
    lastGestureKind: presence ? (prev?.lastGestureKind || null) : kind };
  writeFileAtomic(activityFile(logsDir), JSON.stringify(rec) + '\n');
  return rec;
}

/** Idle = no gesture since `idleMin`. Unknown activity counts from the server boot. */
export function idleInfo({ activity, bootAt = 0, now = Date.now(), settings }) {
  const lastAt = Math.max(activity?.at || 0, bootAt || 0);
  const idleMs = Math.max(0, now - lastAt);
  // The presence period that holds lastAt (the boot when the activity is older).
  const presentSince = activity && activity.at >= (bootAt || 0) ? (activity.presentSince ?? activity.at) : lastAt;
  return { lastAt, idleMs, idle: idleMs >= settings.idleMin * 60_000, presentSince };
}

// What the dashboard actually showed the user (proposed gaps): key → first time.
const presentedFile = (logsDir) => path.join(logsDir, 'auto-answer-presented.json');
export function readPresented(logsDir) {
  try {
    const j = JSON.parse(fs.readFileSync(presentedFile(logsDir), 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(j.keys || {})) { const t = Date.parse(v); if (Number.isFinite(t)) out[k] = t; }
    return out;
  } catch { return {}; }
}
export function recordPresented(logsDir, keys, now = Date.now()) {
  const cur = readPresented(logsDir);
  let n = 0;
  for (const k of Array.isArray(keys) ? keys : []) if (typeof k === 'string' && /^gap:.{1,200}$/.test(k) && !cur[k]) { cur[k] = now; n++; }
  if (!n) return 0;
  fs.mkdirSync(logsDir, { recursive: true });
  const all = Object.entries(cur).sort((a, b) => b[1] - a[1]).slice(0, 2000);
  writeFileAtomic(presentedFile(logsDir), JSON.stringify({ version: 1, keys: Object.fromEntries(all.map(([k, t]) => [k, new Date(t).toISOString()])) }, null, 2) + '\n');
  return n;
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------
/** When a wait becomes due (permission requests expire on their own: answer before). */
export function dueAt(wait, settings) {
  // A gap only starts waiting for the user once it was shown to them.
  const base = Math.max(wait.since, wait.presentedAt || 0) + settings.waitMin * 60_000;
  if (wait.kind === 'permission' && Number.isFinite(wait.deadline)) return Math.min(base, wait.deadline - settings.permissionLeadSec * 1000);
  return base;
}

export const BACKLOG_TEXT = {
  'avant-activation': 'née avant l’activation de la règle : jamais traitée automatiquement',
  'avant-retour': 'née avant votre dernier retour : vous l’avez eue sous les yeux, elle vous revient',
  'non-presentee': 'lacune jamais présentée (page Models) : jamais traitée automatiquement',
  'limite-deja-repondue': 'limite de pipeline : la réponse automatique a déjà répondu une fois pour cette exécution, la suivante vous attend',
  'limite-sans-choix': 'limite de pipeline sans option autorisée (seulement abandonner ou changer le model) : elle vous attend',
};

/**
 * Which waits the rule may ever answer (0.123.0, incident of 2026-10-20:
 * ten-day-old gaps, invisible outside the Models page, rejected in the user's
 * place): born after the rule's activation, after the user's last return, and
 * — for a proposed gap — actually presented to the user. The others are
 * backlog, listed for the user and never answered automatically.
 * presented: { [waitKey]: epoch ms }.
 */
export function classifyWaits({ waits, settings, idle, presented = {}, ledger = [] }) {
  const activatedAt = Date.parse(settings.activatedAt || '') || 0;
  const eligible = [], backlog = [];
  for (const w of waits) {
    let reason = null;
    if (w.since < activatedAt) reason = 'avant-activation';
    else if (Number.isFinite(idle?.presentSince) && w.since < idle.presentSince) reason = 'avant-retour';
    else if (w.kind === 'gap' && !presented[w.key]) reason = 'non-presentee';
    else if (isLimitPause(w) && limitAnswered(w, ledger)) reason = 'limite-deja-repondue';
    else if (isLimitPause(w) && !limitOptions(w.context?.diagnosis).length) reason = 'limite-sans-choix';
    if (reason) backlog.push({ ...w, backlog: reason, backlogText: BACKLOG_TEXT[reason] });
    else eligible.push(w.kind === 'gap' ? { ...w, presentedAt: presented[w.key] } : w);
  }
  return { eligible, backlog };
}

/** Waits to answer now, oldest first, within the caps of this absence. */
export function dueWaits({ waits, now = Date.now(), idle, settings, ledger = [], presented = {} }) {
  if (!settings.enabled || !idle.idle) return [];
  waits = classifyWaits({ waits, settings, idle, presented, ledger }).eligible;
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
          ...(paused ? { run: paused.run, pipeline: paused.state.pipeline, pausedLimit: paused.state.pausedLimit || null, runFile: paused.file,
            // Smart pause (0.122.0): the diagnosed cause and the menu derived from it.
            ...(paused.state.diagnosis?.options?.length ? { diagnosis: { cause: paused.state.diagnosis.cause, kind: paused.state.diagnosis.kind, options: paused.state.diagnosis.options.map(o => ({ key: o.key, does: o.does })), recommend: paused.state.diagnosis.recommend } } : {}) } : {}),
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
  pause: 'A pipeline run is paused and offers a menu derived from the diagnosed cause. Start "answer" with the exact menu word you choose among the OPTIONS listed in the context (the RECOMMENDED one unless a decision of the user says otherwise; never a word outside the menu), then one sentence explaining why.',
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
    if (c.diagnosis && isLimitPause(wait)) {
      const allowed = limitOptions(c.diagnosis);
      const rec = allowed.find(o => o.key === c.diagnosis.recommend?.key);
      ctx.push(`PIPELINE LIMIT (« ${c.pausedLimit} »): the engine never crosses a limit by itself, it asks. You may answer it ONCE for this run, in the user's absence. NEVER choose an option that closes the run (abandonner, simplifier, livrer sans eux) nor « changer le model » (it needs the user's own action): they are not offered below.`,
        `DIAGNOSED CAUSE (established by the orchestrator): ${c.diagnosis.cause}`,
        'OPTIONS — your "answer" (and "safeAnswer") MUST start with exactly one of these menu words, nothing else is accepted:',
        ...allowed.map(o => `- « ${o.key} » : ${o.does}`),
        rec ? `RECOMMENDED: « ${rec.key} » — ${c.diagnosis.recommend.why}`
          : `The orchestrator recommended « ${c.diagnosis.recommend?.key || '?'} », which is not allowed here: choose the listed option that acts best on the cause.`);
    } else if (c.diagnosis) {
      ctx.push(`DIAGNOSED CAUSE (established by the orchestrator): ${c.diagnosis.cause}`,
        'OPTIONS — your "answer" (and "safeAnswer") MUST start with exactly one of these menu words, nothing else is accepted:',
        ...c.diagnosis.options.map(o => `- « ${o.key} » : ${o.does}`),
        `RECOMMENDED: « ${c.diagnosis.recommend.key} » — ${c.diagnosis.recommend.why}`);
    }
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
  // A paused run with a smart menu (0.122.0): only one of ITS options is a valid
  // answer; on a limit, never one that closes the run or needs a model change.
  const menu = pauseMenu(wait);
  if (isLimitPause(wait) && !menu.length) return { ok: false, why: 'limite de pipeline sans option autorisée : elle attend l’utilisateur' };
  if (menu.length && !matchOptionKey(answer, menu)) return { ok: false, why: `réponse hors des choix proposés par la pause (${menu.map(k => `« ${k} »`).join(', ')})` };
  if (menu.length && typeof j.safeAnswer === 'string' && !matchOptionKey(j.safeAnswer, menu)) j = { ...j, safeAnswer: '' };
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
  // Without git, the copies are the return point: no misleading « git reset … ».
  const manual = r.git ? `, ou git reset --hard ${r.git.head.slice(0, 12)}${r.git.stash ? ` puis git stash apply ${r.git.tag}` : ''}` : '';
  return `Point de retour : ${parts.join(' ; ')}. Retour arrière : bouton « Annuler » du résumé${manual}.`;
}

/**
 * Removes a gap decision and the additions it applied (entries absent from the
 * backup). Only the automatic answer's own decision: one the user made since is
 * never touched. A rejection added nothing: only its decision goes.
 */
export function undoGapDecision(routingFile, backupFile, gapKey) {
  const cur = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
  const old = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  const d = cur.gapDecisions?.[gapKey];
  if (!d) return { ok: false, status: 409, error: 'la décision sur cette lacune n’existe plus (déjà retirée)' };
  if (d.by !== BY) return { ok: false, status: 409, error: `décision sur la lacune reprise depuis par « ${d.by || '?'} » : rien n’est annulé` };
  delete cur.gapDecisions[gapKey];
  if (d.decision !== 'rejected') for (const k of ['pipelines', 'steps', 'variants', 'attach']) {
    const before = new Set((old.custom?.[k] || []).map(x => JSON.stringify(x)));
    if (Array.isArray(cur.custom?.[k])) cur.custom[k] = cur.custom[k].filter(x => before.has(JSON.stringify(x)));
  }
  cur.updatedAt = new Date().toISOString();
  writeFileAtomic(routingFile, JSON.stringify(cur, null, 2) + '\n');
  return { ok: true };
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
  // A gap decision is checked first: refused ⇒ nothing at all is restored.
  if (rec.kind === 'gap' && routingFile) {
    const f = r.files.find(x => path.resolve(x.file) === path.resolve(routingFile));
    if (f) {
      const g = undoGapDecision(routingFile, f.backup, rec.gapKey);
      if (!g.ok) return g;
      done.push('décision sur la lacune retirée : elle est de nouveau proposée');
    }
  }
  if (r.git && !isGitRepo(r.git.repo)) return { ok: false, status: 409, error: `${r.git.repo} n’est plus la racine d’un dépôt git : annulation refusée` };
  if (r.git) {
    const safety = gitSnapshot(r.git.repo, undoTag(rec.id), `State before undoing auto-answer ${rec.id}`);
    git(r.git.repo, ['reset', '--hard', r.git.head]);
    if (r.git.stash) git(r.git.repo, ['stash', 'apply', r.git.stash]);
    done.push(`dépôt remis au point de retour (état d'avant l'annulation gardé dans le tag ${safety.tag})`);
  }
  for (const f of r.files) {
    if (rec.kind === 'gap' && routingFile && path.resolve(f.file) === path.resolve(routingFile)) continue;
    fs.copyFileSync(f.backup, f.file);
    done.push(`${path.basename(f.file)} restauré`);
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
/**
 * Where a decision stands for the user (0.123.0):
 *   pending  — still needs the user (running, or submitted and still open);
 *   handled  — applied, non-engaging option, failed, abandoned, undone;
 *   obsolete — its request was closed or answered meanwhile (marked automatically).
 * targetOpen(rec): true | false | null (unknown).
 */
export function decisionPhase(rec, targetOpen = () => null) {
  if (rec.status === 'running') return { phase: 'pending', obsolete: null };
  const asks = rec.status === 'submitted' || rec.status === 'failed' || rec.status === 'abandoned';
  const open = asks ? targetOpen(rec) : null;
  if (open === false) return { phase: 'obsolete', obsolete: 'demande close ou déjà répondue entre-temps' };
  if (rec.status === 'submitted') return { phase: 'pending', obsolete: null };
  return { phase: 'handled', obsolete: null };
}

/**
 * « Écarter » hides decisions from the summary; they stay in the ledger
 * (history), nothing is erased. A pending one needs `confirm`.
 * Returns { ok, dismissed: [ids], needsConfirm: [ids] }.
 */
export function dismissDecisions(logsDir, { ids = null, handled = false, confirm = false, by = 'utilisateur', targetOpen = () => null } = {}, now = Date.now()) {
  const all = readLedger(logsDir);
  const dismissed = [], needsConfirm = [];
  for (const d of all) {
    if (d.dismissedAt) continue;
    const ph = decisionPhase(d, targetOpen).phase;
    if (handled) { if (ph === 'pending') continue; }
    else if (!ids || !ids.includes(d.id)) continue;
    if (ph === 'pending' && !confirm) { needsConfirm.push(d.id); continue; }
    d.dismissedAt = new Date(now).toISOString();
    d.dismissedBy = String(by).slice(0, 40);
    d.dismissedPhase = ph;
    if (!d.seenAt) d.seenAt = d.dismissedAt;
    dismissed.push(d.id);
  }
  if (dismissed.length) writeLedger(logsDir, all);
  return { ok: !needsConfirm.length, dismissed, needsConfirm };
}

export const newId = (now = Date.now()) => `aa-${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;

const KIND_TEXT = { question: 'question', pause: 'pause de pipeline', permission: 'demande d’autorisation', gap: 'lacune proposée' };
const ACTION_TEXT = {
  gap: { accept: 'lacune acceptée (proposition appliquée)', reject: 'lacune rejetée' },
  permission: { allow: 'autorisée une fois', deny: 'refusée' },
};
const hm = (iso) => { const t = Date.parse(iso || ''); if (!t) return '?'; const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dur = (min) => (min >= 2 * 1440 ? `${Math.round(min / 1440)} jours` : min >= 120 ? `${Math.round(min / 60)} h` : `${Math.round(min)} min`);

/** What was decided, in words (« lacune proposée — lacune rejetée »…). */
export function decisionWhat(rec) {
  const k = rec.limitPause ? `limite de pipeline (« ${rec.pausedLimit} »)` : KIND_TEXT[rec.kind] || rec.kind;
  if (rec.status === 'submitted') return `${k} : soumise à votre décision (garde-fou), rien n’a été répondu`;
  if (rec.status === 'failed' || rec.status === 'abandoned' || rec.status === 'running') return `${k} : ${statusText(rec.status)}`;
  const a = rec.decision && ACTION_TEXT[rec.kind]?.[rec.decision];
  return `${k} — ${a || 'répondu à votre place'}${rec.status === 'safe' ? ' (option non engageante, garde-fou)' : ''}`;
}

/** The element the decision is about, for a link: { type, id, label, project }. */
export function decisionTarget(rec) {
  if (rec.kind === 'gap') return { type: 'gap', id: rec.gapKey || null, label: `lacune « ${rec.gapKey || '?'} »`, project: rec.project || null };
  if (rec.kind === 'permission') return { type: 'permission', id: rec.permissionId || null, label: `autorisation demandée par ${rec.project || '?'}`, project: rec.project || null };
  if (rec.run) return { type: 'run', id: rec.run, label: `exécution ${rec.run} de ${rec.project || '?'}`, project: rec.project || null };
  return { type: 'project', id: rec.project || null, label: `question de ${rec.isChef ? 'chef' : rec.project || '?'}${rec.lane ? ` (couloir ${rec.lane})` : ''}`, project: rec.project || null };
}

/** Why the user was considered inactive, in words. */
export function inactivityText(rec) {
  const i = rec.inactivity;
  const waited = `demande en attente depuis ${dur(rec.waitedMin ?? 0)}`;
  if (!i) return `aucune activité enregistrée depuis ${rec.idleMin ?? '?'} min (seuil de la règle) ; ${waited}`;
  const last = i.lastAt
    ? `dernier signe de vous à ${hm(i.lastAt)}${i.lastKind ? ` (${i.lastKind}${i.lastSource ? `, ${i.lastSource}` : ''})` : ''}`
    : 'aucun signe de vous depuis le démarrage du serveur';
  return `${last}, soit ${i.idleMin} min sans activité ≥ seuil de ${i.thresholdMin} min ; ${waited}`;
}

const STATUS_TEXT = {
  applied: 'répondu à votre place', safe: 'option non engageante choisie (garde-fou)', submitted: 'soumis à votre décision (garde-fou)',
  failed: 'échec : rien n’a été répondu', abandoned: 'abandonné : vous êtes revenu ou la demande a été traitée',
};
export const statusText = (s) => STATUS_TEXT[s] || s;

/** Card text (fil, journal, log of the process). */
export function decisionText(rec) {
  const head = `${MARK} — ${decisionWhat(rec)}`;
  const lines = [head, `Élément : ${decisionTarget(rec).label}`, `Demande : ${String(rec.question || '').replace(/\s+/g, ' ').slice(0, 300)}`];
  if (rec.answer) lines.push(`Réponse : ${rec.decision ? `[${rec.decision}] ` : ''}${String(rec.answer).slice(0, 1200)}`);
  if (rec.reason) lines.push(`Raison : ${rec.reason}`);
  if (rec.limitPause) lines.push('Limite de pipeline : une seule réponse automatique par exécution, point de retour obligatoire, jamais « abandonner » ; la limite suivante de cette exécution vous attendra.');
  lines.push(`Pourquoi vous étiez considéré inactif : ${inactivityText(rec)}`);
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
    const settings = ensureActivation(deps.root, now());
    const activity = readActivity(deps.logsDir);
    const idle = idleInfo({ activity, bootAt: deps.bootAt || 0, now: now(), settings });
    return { settings, idle, activity };
  }
  const targetOpen = (rec) => { try { return deps.targetOpen ? deps.targetOpen(rec) : null; } catch { return null; } };

  async function processWait(wait, settings, idle, activity = readActivity(deps.logsDir)) {
    const { guardrails } = loadGuardrails(deps.root);
    const rec = {
      id: newId(now()), key: wait.key, kind: wait.kind, project: wait.project, lane: wait.lane || 0, isChef: !!wait.isChef,
      since: new Date(wait.since).toISOString(), at: new Date(now()).toISOString(), idleSince: idle.lastAt,
      idleMin: Math.round(idle.idleMs / 60_000), waitedMin: Math.round((now() - wait.since) / 60_000),
      // Why the user was considered inactive (shown in the notification, 0.123.0).
      inactivity: { lastAt: idle.lastAt ? new Date(idle.lastAt).toISOString() : null,
        lastKind: activity && activity.at === idle.lastAt ? activity.kind : idle.lastAt ? 'démarrage du serveur' : null,
        lastSource: activity && activity.at === idle.lastAt ? activity.source : null,
        idleMin: Math.round(idle.idleMs / 60_000), thresholdMin: settings.idleMin },
      ...(wait.presentedAt ? { presentedAt: new Date(wait.presentedAt).toISOString() } : {}),
      question: String(wait.question || '').slice(0, 4000), model: AUTO_MODEL, status: 'running',
      ...(wait.context?.run ? { run: wait.context.run } : {}), ...(wait.context?.gapKey ? { gapKey: wait.context.gapKey } : {}),
      ...(isLimitPause(wait) ? { limitPause: true, pausedLimit: wait.context.pausedLimit } : {}),
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
    let final = enforceGuardrails(wait, ans, verdict, guardrails);
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
    if (rec.limitPause) {
      // A limit is answered only with a git return point (« point de retour obligatoire »).
      if (!rec.recovery.git) {
        rec.status = 'submitted';
        rec.why = `limite de pipeline : point de retour obligatoire impossible (${rec.recovery.text}) — rien n’a été répondu`;
        upsertDecision(deps.logsDir, rec);
        try { deps.report?.(rec); } catch (e) { log(`[auto-answer] carte : ${e.message}`); }
        return rec;
      }
      final = { ...final, text: `${final.text} — ${LIMIT_MARK} (réponse automatique en votre absence, une seule fois pour cette exécution)` };
      rec.answer = final.text;
    }
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
    const { settings, idle, activity } = state();
    if (!settings.enabled) return { skipped: 'règle coupée' };
    if (!idle.idle) return { skipped: 'utilisateur actif' };
    running = (async () => {
      const waits = await deps.listWaits();
      const due = dueWaits({ waits, now: now(), idle, settings, ledger: readLedger(deps.logsDir), presented: readPresented(deps.logsDir) });
      if (!due.length) return { answered: null };
      return { answered: await processWait(due[0], settings, idle, activity) };
    })();
    try { return await running; } finally { running = null; }
  }

  const decorate = (d) => {
    const ph = decisionPhase(d, targetOpen);
    return { ...d, statusText: statusText(d.status), what: decisionWhat(d), target: decisionTarget(d), why_inactive: inactivityText(d),
      text: decisionText(d), phase: ph.phase, obsolete: ph.obsolete, dismissed: !!d.dismissedAt,
      undoable: !!d.recovery?.possible && !d.undone && (d.status === 'applied' || d.status === 'safe') };
  };

  function view(n = 50) {
    const { settings, idle, activity } = state();
    const decisions = readLedger(deps.logsDir);
    const g = loadGuardrails(deps.root);
    const shown = decisions.filter(d => !d.dismissedAt);
    return {
      ok: true, model: AUTO_MODEL, mark: MARK, rule: RULE_VERBATIM, settings,
      guardrails: g.guardrails, guardrailsDecision: g.decision, guardrailsProblems: g.problems, guardrailsAlwaysOn: true,
      activity: { lastAt: idle.lastAt ? new Date(idle.lastAt).toISOString() : null, idleMs: idle.idleMs, idle: idle.idle, last: activity,
        presentSince: Number.isFinite(idle.presentSince) ? new Date(idle.presentSince).toISOString() : null },
      unseen: shown.filter(d => !d.seenAt && d.status !== 'running').length,
      decisions: shown.slice(-n).reverse().map(decorate),
      history: decisions.filter(d => d.dismissedAt).slice(-n).reverse().map(decorate),
    };
  }

  /** view() plus the backlog: what waits now and will never be answered automatically. */
  async function overview(n = 50) {
    const v = view(n);
    let waits = [];
    try { waits = await deps.listWaits(); } catch { /* backlog unknown */ }
    const { idle } = state();
    const { backlog } = classifyWaits({ waits, settings: v.settings, idle, presented: readPresented(deps.logsDir), ledger: readLedger(deps.logsDir) });
    v.backlog = backlog.sort((a, b) => a.since - b.since).slice(0, 200).map(w => ({ key: w.key, kind: w.kind, project: w.project, lane: w.lane || 0,
      since: new Date(w.since).toISOString(), question: String(w.question || '').slice(0, 300), reason: w.backlog, reasonText: w.backlogText,
      ...(w.context?.gapKey ? { gapKey: w.context.gapKey } : {}), ...(w.context?.run ? { run: w.context.run } : {}) }));
    return v;
  }

  function dismiss(opts) { return dismissDecisions(deps.logsDir, { ...opts, targetOpen }, now()); }

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

  return { sweep, view, overview, undo, dismiss, state, seen: (list) => markSeen(deps.logsDir, list, now()),
    presented: (keys) => recordPresented(deps.logsDir, keys, now()), processWait };
}
