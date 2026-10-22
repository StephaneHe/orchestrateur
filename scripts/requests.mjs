#!/usr/bin/env node
// ============================================================================
// scripts/requests.mjs — requests registry, in files (Routage v3, phase 1)
// ============================================================================
//
// User decisions (2026-10-19, docs/ROUTAGE-SYNTHESE.md §5): decision 1 «
// registre des demandes en fichiers, pas de base de données », decision 8 «
// actions du chef par commande autorisées, et inscrites au registre ». Plan:
// §3.4 (state machine and exits) and §3.9 phase 1 « registre et secours »,
// launched on 2026-10-21 (« vas y »).
//
// One request per chef turn opened by a message of the user, a wake-up or a
// musician's question: `logs/requests/<id>.json`, id `r-<timestamp>-<hex>`.
// Owner: this module only (lock per request, atomic write). Phase 1 plugs the
// registry on the CURRENT chef (Routage `off` or `routage`) WITHOUT changing
// what it does: dispatch.mjs records the turn and the dispatches launched from
// it (`ORCH_REQUEST_ID` in the turn's environment, decision 8), and the 60 s
// sweep reconciles. Nothing reads the registry to decide a turn: removing it
// changes nothing else. The only effects are the explicit commands below.
//
//   node scripts/requests.mjs list [--all] | show <id>[#n]
//     | answer <id> "<texte>" | close <id> [--note "…"]
//     | retry <id> | retry <id>#<n>
//     | fix <id>#<n> [--pipeline p] [--mode m] [--projet p] [--after <id>#<m>]
//     | cancel <id>#<n> | drop <id> | replay <id> | recheck <id>
//     | reconcile [--dry-run]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-file.mjs';
import { dependencyResult, readPending, dropPending, textHash } from './routage-pending.mjs';
import { infraFailure } from './model-backoff.mjs';

export const REQUESTS_DIR = 'requests';
export const REQUEST_RE = /^r-\d{8}T\d{6}-[0-9a-f]{6}$/;
/** `r-…#n`, `r-…#n.k` for the k-th launch of task n (retry / fix). */
export const TASK_RE = /^(r-\d{8}T\d{6}-[0-9a-f]{6})#(\d{1,3})(?:\.(\d{1,2}))?$/;

export const STATES = ['reçue', 'en_cours', 'attend_utilisateur', 'garée', 'à_traiter', 'suivie', 'terminée', 'abandonnée'];
export const TERMINAL = new Set(['terminée', 'abandonnée']);
export const TASK_STATES = ['en_attente_de', 'lancée', 'en_file', 'en_cours', 'réussie', 'à_traiter', 'annulée'];
export const TASK_TERMINAL = new Set(['réussie', 'annulée']);

/** No acknowledgement 2 min after a launch ⇒ the task needs a decision (never relaunched blindly). */
export const ACK_TIMEOUT_MS = 2 * 60_000;
/** A non-terminal request silent for 2 h is reported by the sweep. */
export const STALE_MS = 2 * 3600_000;

/**
 * Every non-terminal state has an exit by chat, by command and by button, or
 * an awaited event with a deadline (§3.4, checked by _test_requests_registry).
 * In phase 1 the chat exit goes through the chef, who runs the command
 * (decision 8); the buttons come with the cards of phase 3.
 */
export const EXITS = {
  'reçue': { chat: '« abandonne r-… » au chef', command: ['drop'], button: { label: 'Abandonner', phase: 3 }, event: { what: 'le tour du chef démarre (en_cours)', deadline: 'immédiat' } },
  'en_cours': { chat: 'le chef répond', command: ['show'], button: { label: 'Voir', phase: 3 }, event: { what: 'processus du tour mort sans résultat ⇒ garée', deadline: 'balayage de 60 s' } },
  'attend_utilisateur': { chat: 'répondre au chef (rattaché seulement si une seule demande attend, ou si r-… est cité)', command: ['answer', 'close'], button: { label: 'Répondre / Marquer répondue', phase: 3 } },
  'garée': { chat: '« relance » / « abandonne » au chef', command: ['retry', 'drop'], button: { label: 'Relancer maintenant / Abandonner', phase: 3 } },
  'à_traiter': { chat: '« /dev /léger » pour la tâche citée, « abandonne r-…#n » au chef', command: ['fix', 'cancel', 'retry'], button: { label: 'Corriger et lancer / Annuler la tâche', phase: 3 } },
  'suivie': { chat: 'le chef rapporte au réveil', command: ['show', 'cancel'], button: { label: 'Voir', phase: 3 }, event: { what: 'résultat de chaque tâche relu dans le journal du musicien', deadline: 'balayage de 60 s' } },
};

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const nowIso = (now = Date.now()) => new Date(now).toISOString();
export const dirOf = (logsDir) => path.join(logsDir, REQUESTS_DIR);
export const fileOf = (logsDir, id) => path.join(dirOf(logsDir), `${id}.json`);

export function newRequestId(now = Date.now()) {
  return `r-${new Date(now).toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
}
export function parseTaskId(s) {
  const m = TASK_RE.exec(String(s || ''));
  return m ? { request: m[1], n: Number(m[2]), attempt: m[3] ? Number(m[3]) : 1 } : null;
}
export const taskIdOf = (request, n, attempt = 1) => `${request}#${n}${attempt > 1 ? `.${attempt}` : ''}`;

/** Exclusive lock per request: a writer holds it a few ms; older than 30 s = dead writer. */
function withLock(logsDir, id, fn) {
  fs.mkdirSync(dirOf(logsDir), { recursive: true });
  const lock = `${fileOf(logsDir, id)}.lock`;
  let got = false;
  for (let i = 0; i < 400 && !got; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); got = true; }
    catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true }); } catch {}
      const until = Date.now() + 10 + Math.floor(Math.random() * 15); while (Date.now() < until) { /* short spin */ }
    }
  }
  if (!got) throw new Error(`demande ${id} : verrou toujours tenu`);
  try { return fn(); } finally { try { fs.rmSync(lock, { force: true }); } catch {} }
}

export function readRequest(logsDir, id) { return REQUEST_RE.test(String(id)) ? readJson(fileOf(logsDir, id)) : null; }
// The server sweeps every minute and requests accumulate: a file is parsed
// again only when its mtime or size changed.
const parsed = new Map();
export function listRequests(logsDir) {
  let names = [];
  try { names = fs.readdirSync(dirOf(logsDir)).filter(f => /^r-.*\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of names) {
    const file = path.join(dirOf(logsDir), f);
    let st; try { st = fs.statSync(file); } catch { continue; }
    const c = parsed.get(file);
    let r = c && c.mtimeMs === st.mtimeMs && c.size === st.size ? c.r : null;
    if (!r) { r = readJson(file); if (r) parsed.set(file, { mtimeMs: st.mtimeMs, size: st.size, r }); }
    if (r && REQUEST_RE.test(r.id)) out.push(structuredClone(r));
  }
  return out.sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
}

/** Read-modify-write of one request under its lock; `fn` mutates or returns a new object. */
export function updateRequest(logsDir, id, fn, { now = Date.now() } = {}) {
  return withLock(logsDir, id, () => {
    const r = readRequest(logsDir, id);
    if (!r) throw new Error(`demande inconnue : ${id}`);
    const out = fn(r) || r;
    out.updatedAt = nowIso(now);
    writeFileAtomic(fileOf(logsDir, id), JSON.stringify(out, null, 2));
    return out;
  });
}

function setState(r, to, why, by = 'code', now = Date.now()) {
  if (r.state === to) return;
  (r.history ||= []).push({ at: nowIso(now), from: r.state, to, by, why: why || null });
  r.state = to;
  r.lastActivityAt = nowIso(now);
}
function setTaskState(t, to, why, now = Date.now()) {
  if (t.state === to) return;
  (t.history ||= []).push({ at: nowIso(now), from: t.state, to, why: why || null });
  t.state = to;
}

/** Kind of a chef turn, from its source and text. */
export function requestKind({ source = null, text = '', handoff = false } = {}) {
  if (handoff) return 'handoff';
  if (/^\s*\[NEEDS_CHEF_INPUT_FROM:/.test(text)) return 'question';
  if (source === 'wake' || /^\s*\[CALLBACK_WAKE/.test(text)) return 'wake';
  return source ? 'notification' : 'message';
}

/** Creates a request (state `reçue`). */
export function createRequest(logsDir, { project, text, source = null, callback = null, kind = null, chefMode = null, now = Date.now(), id = newRequestId(now) }) {
  const r = {
    id, version: 1, kind: kind || requestKind({ source, text }), project, source, callback, chefMode,
    text: String(text || ''), createdAt: nowIso(now), updatedAt: nowIso(now), lastActivityAt: nowIso(now),
    state: 'reçue', turns: [], tasks: [], answers: [], history: [{ at: nowIso(now), from: null, to: 'reçue', by: 'code', why: null }],
  };
  fs.mkdirSync(dirOf(logsDir), { recursive: true });
  withLock(logsDir, id, () => writeFileAtomic(fileOf(logsDir, id), JSON.stringify(r, null, 2)));
  return r;
}

/** A chef turn of the request starts (`en_cours`). Reused by answer / retry. */
export function startTurn(logsDir, id, { turn, pid = process.pid, log = null, offset = null, now = Date.now() }) {
  return updateRequest(logsDir, id, (r) => {
    r.turns.push({ turn, pid, log, offset, at: nowIso(now), end: null });
    delete r.parked; delete r.awaitingTurn;
    setState(r, 'en_cours', `tour ${turn}`, 'code', now);
  }, { now });
}

const QUESTION_RE = /(^|\n)\s*NEEDS_(USER|CHEF)_INPUT\s*:\s*(.+)/;

/** The outcome of one chef turn, from its own result line (or none). */
export function turnOutcome({ result, code = 0, infra = null }) {
  if (result && !result.is_error) {
    const q = QUESTION_RE.exec(String(result.result || ''));
    if (q) return { end: 'question', question: q[3].trim().slice(0, 600) };
    return { end: 'done' };
  }
  const detail = String(result?.result || result?.subtype || (code ? `sortie ${code} sans résultat` : 'aucun résultat')).replace(/\s+/g, ' ').slice(0, 300);
  if (infra) return { end: 'parked', cause: infra.cause, until: infra.until || null, detail: infra.detail || detail };
  return { end: 'parked', cause: result ? 'error' : 'exit', detail };
}

/** Request state derived from its last turn and its tasks. */
export function deriveState(r) {
  if (TERMINAL.has(r.state)) return r.state;
  const last = r.turns[r.turns.length - 1];
  if (last && !last.end) return 'en_cours';
  if (r.awaitingTurn) return 'reçue';
  if (r.parked) return 'garée';
  if (r.question && !r.question.answeredAt) return 'attend_utilisateur';
  const live = r.tasks.filter(t => t.state !== 'annulée');
  if (live.some(t => t.state === 'à_traiter')) return 'à_traiter';
  if (live.some(t => !TASK_TERMINAL.has(t.state))) return 'suivie';
  return r.turns.length ? 'terminée' : 'reçue';
}

/** End of a chef turn: question, parked (infrastructure, error) or done. */
export function finishTurn(logsDir, id, { turn, result = null, code = 0, infra = null, now = Date.now() }) {
  return updateRequest(logsDir, id, (r) => {
    const t = r.turns.find(x => x.turn === turn) || r.turns[r.turns.length - 1];
    if (!t || t.end) return;
    const o = turnOutcome({ result, code, infra });
    t.end = { at: nowIso(now), ...o, code };
    if (o.end === 'question') r.question = { text: o.question, turn: t.turn, at: nowIso(now) };
    else if (o.end === 'parked') r.parked = { cause: o.cause, until: o.until || null, detail: o.detail, at: nowIso(now) };
    if (o.end !== 'question' && r.question && !r.question.answeredAt) r.question.answeredAt = nowIso(now);
    setState(r, deriveState(r), o.end === 'parked' ? `tour ${t.turn} : ${o.cause}` : `tour ${t.turn} : ${o.end}`, 'code', now);
  }, { now });
}

/** Registers a task (a dispatch launched from the chef turn, or by a command). */
export function addTask(logsDir, id, { projet, demande, titre = null, launch = {}, state = 'lancée', after = null, waitsFor = null, now = Date.now() }) {
  let task = null;
  updateRequest(logsDir, id, (r) => {
    const n = r.tasks.reduce((m, t) => Math.max(m, t.n), 0) + 1;
    task = { n, id: taskIdOf(id, n), attempt: 1, projet, titre: titre || String(demande || '').replace(/\s+/g, ' ').trim().slice(0, 80), demande: String(demande || ''),
      launch, state, after, ...(waitsFor ? { waitsFor } : {}), launchedAt: state === 'lancée' ? nowIso(now) : null, ack: null, history: [{ at: nowIso(now), from: null, to: state, why: waitsFor ? `attend la fin d’une tâche de ${waitsFor.projet || '?'} (attente du Routage)` : null }] };
    r.tasks.push(task);
    r.lastActivityAt = nowIso(now);
    setState(r, deriveState(r), null, 'code', now);
  }, { now });
  return task;
}

/**
 * Phase 1's known limit, closed in phase 2: a Routage task that waits for
 * another one (routage-pending.json) is registered in its request as soon as
 * it is decided (`en_attente_de`, `waitsFor`), and its release launches it
 * with its `--task-id` (routage-pending.mjs). Marked here BEFORE the pending
 * file is rewritten, so the sweep never mistakes a released task for a dropped one.
 */
export function markReleased(logsDir, taskId, { now = Date.now() } = {}) {
  const p = parseTaskId(taskId);
  if (!p || !readRequest(logsDir, p.request)) return null;
  return updateRequest(logsDir, p.request, (r) => {
    const t = r.tasks.find(x => x.n === p.n);
    if (!t || t.state !== 'en_attente_de') return;
    t.releasedAt = nowIso(now); t.launchedAt = nowIso(now);
    setTaskState(t, 'lancée', 'libérée : la tâche attendue a fini', now);
    r.lastActivityAt = nowIso(now);
    setState(r, deriveState(r), null, 'code', now);
  }, { now });
}

/** The task of a request matching a task id (any attempt). */
export function findTask(r, taskId) {
  const p = parseTaskId(taskId);
  return p && r?.id === p.request ? r.tasks.find(t => t.n === p.n) || null : null;
}

/**
 * Acknowledgement (§3.4): dispatch.mjs wrote the task's user_prompt in a log
 * (`log`), queued it (`queue`), or handed it to the server (`server`). Only the
 * current attempt is acknowledged.
 */
export function ackTask(logsDir, taskId, ack, { now = Date.now() } = {}) {
  const p = parseTaskId(taskId);
  if (!p) return null;
  return updateRequest(logsDir, p.request, (r) => {
    const t = r.tasks.find(x => x.n === p.n);
    if (!t || (t.attempt || 1) !== p.attempt) return;
    const prev = t.ack;
    // A log acknowledgement is final; a queue / server one is refined by the log.
    if (prev?.where === 'log' && ack.where !== 'log') return;
    t.ack = { ...(prev?.where === 'log' ? prev : {}), ...ack, at: nowIso(now) };
    if (ack.where === 'log') setTaskState(t, 'en_cours', `demande écrite dans ${path.basename(ack.log || '')}`, now);
    else if (ack.where === 'queue') setTaskState(t, 'en_file', `file ${ack.queueId || ''}`.trim(), now);
    r.lastActivityAt = nowIso(now);
    setState(r, deriveState(r), null, 'code', now);
  }, { now });
}

/** A task stopped before being acknowledged (refused launch, …): it needs a decision. */
export function failTask(logsDir, taskId, { code = 'échec', why, now = Date.now() }) {
  const p = parseTaskId(taskId);
  if (!p) return null;
  return updateRequest(logsDir, p.request, (r) => {
    const t = r.tasks.find(x => x.n === p.n);
    if (!t || (t.attempt || 1) !== p.attempt || TASK_TERMINAL.has(t.state)) return;
    t.error = { code, why: String(why || '').slice(0, 400), at: nowIso(now) };
    setTaskState(t, 'à_traiter', `${code} : ${t.error.why}`, now);
    setState(r, deriveState(r), `tâche ${t.id} : ${code}`, 'code', now);
  }, { now });
}

// ---------------------------------------------------------------------------
// Facts: logs and queue files (never the registry alone)
// ---------------------------------------------------------------------------

function tail(file, bytes = 32 * 1024 * 1024) {
  try {
    const size = fs.statSync(file).size, from = Math.max(0, size - bytes);
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}
/** Logs where a turn of `project` may write its user_prompt (main log, lane logs). */
export function projectLogs(logsDir, project) {
  const out = [path.join(logsDir, `${project}.jsonl`)];
  try { for (const f of fs.readdirSync(path.join(logsDir, 'lanes', project))) if (/^\d+\.jsonl$/.test(f)) out.push(path.join(logsDir, 'lanes', project, f)); } catch {}
  return out;
}
/** Where a task id already is: { where: 'log', log } | { where: 'queue', queueId } | null. */
export function taskSeen(logsDir, project, taskId) {
  const needle = `"taskId":${JSON.stringify(taskId)}`;
  for (const log of projectLogs(logsDir, project)) {
    const text = tail(log);
    if (!text.includes(needle)) continue;
    for (const l of text.split('\n')) {
      if (!l.includes(needle)) continue;
      try { const e = JSON.parse(l); if (e.type === 'user_prompt' && e.taskId === taskId) return { where: 'log', log, turn: e.orch_turn || null }; } catch {}
    }
  }
  const q = readJson(path.join(logsDir, 'queue', `${project}.json`));
  const entries = Array.isArray(q) ? q : Array.isArray(q?.queue) ? q.queue : Array.isArray(q?.entries) ? q.entries : [];
  const e = entries.find(x => x?.taskId === taskId);
  return e ? { where: 'queue', queueId: e.id || null } : null;
}

const pidAlive = (pid) => { if (!Number.isFinite(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** The chef turn's own result line in its log (non-phantom), or null. */
export function turnResult(logFile, turn, offset = null) {
  const text = Number.isFinite(offset) ? (() => { try { const size = fs.statSync(logFile).size; const fd = fs.openSync(logFile, 'r'); const from = Math.min(offset, size); const buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd); return buf.toString('utf8'); } catch { return ''; } })() : tail(logFile, 8 * 1024 * 1024);
  let res = null;
  for (const l of text.split('\n')) {
    if (!l.includes(turn) || !l.includes('"result"')) continue;
    try { const e = JSON.parse(l); if (e.type === 'result' && e.orch_turn === turn && !(e.num_turns === 0 && e.duration_api_ms === 0 && !e.synthetic)) res = e; } catch {}
  }
  return res;
}

// ---------------------------------------------------------------------------
// Reconciliation (server sweep, 60 s)
// ---------------------------------------------------------------------------

/**
 * A task error that may only mean « the acknowledgement was missed »: up to
 * 0.131.0 a dispatch run by the pipeline engine wrote its user_prompt without
 * `taskId` (prod, 2026-10-22), so the task went `à_traiter` (no
 * acknowledgement after 2 min, then « stopped before writing the request »)
 * although its run started and ended normally.
 */
export const MISSED_ACK_CODES = new Set(['sans-accusé', 'lancement']);

/** Byte offset of the first line of `file` timestamped at or after `iso` (end of file if none). */
function offsetAtTime(file, iso) {
  let buf; try { buf = fs.readFileSync(file); } catch { return null; }
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const end = nl === -1 ? buf.length : nl;
    const m = /"timestamp":"([^"]+)"/.exec(buf.toString('utf8', pos, end));
    if (m && m[1] >= iso) return pos;
    pos = end + 1;
  }
  return buf.length;
}

/**
 * The acknowledgement a task should have had, recovered from the facts: the
 * user_prompt carrying the fingerprint of its whole text (`textHash`, the one
 * dispatch.mjs records), written in one of the musician's logs at or after its
 * launch. `offset` is taken in the MAIN log (what dependencyResult reads, lane
 * ends included). null when no such prompt exists.
 */
export function recoverAck(logsDir, t, tid = null) {
  const since = t.launchedAt || null;
  if (!since || !t.demande) return null;
  const hash = textHash(t.demande);
  const main = path.join(logsDir, `${t.projet}.jsonl`);
  for (const log of projectLogs(logsDir, t.projet)) {
    const text = tail(log);
    if (!text.includes('"user_prompt"')) continue;
    for (const l of text.split('\n')) {
      if (!l.includes('"user_prompt"')) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.type !== 'user_prompt' || typeof e.text !== 'string' || !(e.timestamp >= since)) continue;
      if (e.taskId && tid && e.taskId !== tid) continue;
      if (textHash(e.text) !== hash) continue;
      const offset = offsetAtTime(main, log === main ? e.timestamp : since);
      if (offset == null) return null;
      return { where: 'log', log, offset, hash, turn: e.orch_turn || null, run: e.pipeline?.run || null, recovered: true };
    }
  }
  return null;
}

/** Brings one task in line with the facts (reconcile, recheck). Mutates `t`. */
function followTask(r, t, { logsDir, now, alive, toLaunch = [], pending = () => readPending(logsDir) }) {
  if (TASK_TERMINAL.has(t.state)) return;
  const tid = taskIdOf(r.id, t.n, t.attempt || 1);
  if (t.state === 'en_attente_de' && t.waitsFor && !t.after) {
    const entry = pending().find(e => e.taskId === tid);
    if (!entry) { setTaskState(t, 'annulée', 'retirée de l’attente du Routage sans être libérée (routage-pending drop)', now); }
    else if (entry.blocked && !t.error) { t.error = { code: 'prédécesseur', why: `la tâche attendue (${entry.after?.projet || '?'}) a échoué ou a été close sans livraison : non relancée`, at: nowIso(now) }; t.actions = [`node scripts/routage-pending.mjs release ${entry.id} --force`, `node scripts/routage-pending.mjs drop ${entry.id}`]; setTaskState(t, 'à_traiter', t.error.why, now); }
    return;
  }
  if (t.state === 'en_attente_de' && t.after) {
    const dep = parseTaskId(t.after);
    const pre = dep && dep.request === r.id ? r.tasks.find(x => x.n === dep.n) : null;
    if (pre?.state === 'réussie') { setTaskState(t, 'lancée', `${t.after} réussie`, now); t.launchedAt = nowIso(now); toLaunch.push(t); }
    else if (!pre || ['à_traiter', 'annulée'].includes(pre.state)) { t.error = { code: 'prédécesseur', why: `${t.after} ${pre ? pre.state : 'introuvable'}`, at: nowIso(now) }; setTaskState(t, 'à_traiter', t.error.why, now); }
    return;
  }
  if (t.state === 'à_traiter') {
    // Only a missed acknowledgement is caught up; any other error waits for a decision.
    if (t.ack?.where === 'log' || !MISSED_ACK_CODES.has(t.error?.code)) return;
    const ack = recoverAck(logsDir, t, tid);
    if (!ack) return;
    t.ack = { ...ack, at: nowIso(now) };
    t.recoveredFrom = t.error; delete t.error; delete t.actions;
    setTaskState(t, 'en_cours', `accusé rattrapé : demande retrouvée dans ${path.basename(ack.log)}${ack.run ? ` (exécution ${ack.run})` : ''}`, now);
  }
  if (t.ack?.where !== 'log') {
    const seen = taskSeen(logsDir, t.projet, tid);
    if (seen?.where === 'log') { t.ack = { ...(t.ack || {}), where: 'log', log: seen.log, turn: seen.turn, at: nowIso(now) }; setTaskState(t, 'en_cours', 'demande relue dans le journal', now); }
    else if (seen?.where === 'queue') { if (t.ack?.where !== 'queue') { t.ack = { where: 'queue', queueId: seen.queueId, at: nowIso(now) }; setTaskState(t, 'en_file', 'relue dans la file', now); } return; }
    else {
      const ack = t.ack?.where !== 'queue' ? recoverAck(logsDir, t, tid) : null;
      if (ack) { t.ack = { ...ack, at: nowIso(now) }; setTaskState(t, 'en_cours', `accusé rattrapé : demande retrouvée dans ${path.basename(ack.log)}${ack.run ? ` (exécution ${ack.run})` : ''}`, now); }
      else {
        const since = Date.parse(t.ack?.at || t.launchedAt || r.createdAt);
        if (now - since >= ACK_TIMEOUT_MS) {
          t.error = { code: 'sans-accusé', why: t.ack?.where === 'queue' ? 'retirée de la file sans avoir démarré (processus tué entre le retrait et le lancement ?)' : 'aucun accusé de réception après 2 min (lancement interrompu ?)', at: nowIso(now) };
          t.actions = [`node scripts/requests.mjs retry ${r.id}#${t.n}`, `node scripts/requests.mjs cancel ${r.id}#${t.n}`];
          setTaskState(t, 'à_traiter', t.error.why, now);
        }
        return;
      }
    }
  }
  // acknowledged in a log: follow its result (pauses and questions keep it running)
  const info = {};
  const res = t.ack.hash ? dependencyResult(logsDir, { projet: t.projet, offset: t.ack.offset, hash: t.ack.hash }, info) : null;
  if (res) {
    if (res.is_error) { t.error = { code: 'échec', why: String(res.result || res.subtype || '').replace(/\s+/g, ' ').slice(0, 300), at: nowIso(now) }; t.actions = [`node scripts/requests.mjs retry ${r.id}#${t.n}`, `node scripts/requests.mjs fix ${r.id}#${t.n} --pipeline …`, `node scripts/requests.mjs cancel ${r.id}#${t.n}`]; setTaskState(t, 'à_traiter', t.error.why, now); }
    else { t.result = { at: nowIso(now), text: String(res.result || '').slice(0, 300) }; setTaskState(t, 'réussie', null, now); }
    delete t.waiting;
  } else if (info.held) t.waiting = info.held.run ? { pause: info.held.run } : { question: true };
  else if (t.ack.pid && !alive(t.ack.pid) && now - Date.parse(t.ack.at) >= ACK_TIMEOUT_MS) {
    t.error = { code: 'sans-résultat', why: 'le tour s’est arrêté sans résultat', at: nowIso(now) };
    t.actions = [`node scripts/requests.mjs retry ${r.id}#${t.n}`, `node scripts/requests.mjs cancel ${r.id}#${t.n}`];
    setTaskState(t, 'à_traiter', t.error.why, now);
  }
}

/**
 * Brings every non-terminal request in line with the facts: a chef turn whose
 * process died (result found ⇒ its outcome; none ⇒ `garée`), task
 * acknowledgements read in the logs and queue files, task results (a paused
 * run or an open question keeps the task running — it never counts as done),
 * no acknowledgement 2 min after a launch ⇒ `à_traiter` (« relancer
 * l'opération existante », never a blind relaunch), dependencies set by `fix
 * --after`. Returns { changed, launched, stale }.
 */
export function reconcile({ root, logsDir = path.join(root, 'logs'), now = Date.now(), launch = launchTaskProcess, dryRun = false, staleMs = STALE_MS, alive = pidAlive }) {
  const out = { changed: [], launched: [], stale: [] };
  let pendingNow = null;
  for (const r0 of listRequests(logsDir)) {
    if (TERMINAL.has(r0.state)) continue;
    const toLaunch = [];
    const before = JSON.stringify(r0);
    const apply = (r) => {
      // 1. chef turn
      const last = r.turns[r.turns.length - 1];
      if (last && !last.end && !alive(last.pid)) {
        const result = last.log ? turnResult(last.log, last.turn, last.offset) : null;
        const code = result && !result.is_error ? 0 : 1;
        const o = turnOutcome({ result, code, infra: infraFailure({ code, log: { result } }) });
        last.end = { at: nowIso(now), ...o, by: 'balayage' };
        if (o.end === 'question') r.question = { text: o.question, turn: last.turn, at: nowIso(now) };
        else if (o.end === 'parked') r.parked = { cause: o.cause, detail: o.cause === 'exit' ? 'processus du tour mort sans résultat' : o.detail, at: nowIso(now) };
      }
      // A relaunched chef turn (answer, retry) that never started.
      if (r.awaitingTurn && now - Date.parse(r.awaitingTurn) >= ACK_TIMEOUT_MS && !(last && !last.end)) {
        delete r.awaitingTurn;
        r.parked = { cause: 'exit', detail: 'le tour du chef relancé n’a pas démarré', at: nowIso(now) };
      }
      // 2. tasks
      for (const t of r.tasks) followTask(r, t, { logsDir, now, alive, toLaunch, pending: () => (pendingNow ||= readPending(logsDir)) });
      setState(r, deriveState(r), 'réconciliation', 'balayage', now);
      // 3. silent too long
      if (!TERMINAL.has(r.state) && now - Date.parse(r.lastActivityAt || r.updatedAt) >= staleMs && !r.staleNotifiedAt) { r.staleNotifiedAt = nowIso(now); out.stale.push(r.id); }
    };
    if (dryRun) { const copy = JSON.parse(before); apply(copy); if (JSON.stringify(copy) !== before) out.changed.push(r0.id); out.launched.push(...toLaunch.map(t => ({ id: taskIdOf(r0.id, t.n, t.attempt || 1), dryRun: true }))); continue; }
    let after = null;
    try { after = updateRequest(logsDir, r0.id, (r) => { apply(r); }, { now }); } catch { continue; }
    if (JSON.stringify({ ...after, updatedAt: r0.updatedAt }) !== before) out.changed.push(r0.id);
    for (const t of toLaunch) out.launched.push({ id: taskIdOf(r0.id, t.n, t.attempt || 1), ...launch(root, after, after.tasks.find(x => x.n === t.n)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Launchers (explicit commands only)
// ---------------------------------------------------------------------------

const DISPATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dispatch.mjs');
function cleanEnv(env0 = process.env) {
  const env = { ...env0 };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ORCH_TURN_ID', 'ORCH_REQUEST_ID']) delete env[k];
  return env;
}
function spawnDetached(root, args, env) {
  let pid = null;
  try { const c = spawn(process.execPath, [DISPATCH, ...args], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true }); c.on('error', () => {}); c.unref(); pid = c.pid || null; } catch {}
  return { pid };
}
/** Launches the current attempt of a task (`--task-id`), queued if the musician is busy. */
export function launchTaskProcess(root, r, t, env0 = process.env) {
  const L = t.launch || {};
  const args = [t.projet, t.demande, '--task-id', taskIdOf(r.id, t.n, t.attempt || 1), '--queue-if-busy'];
  if (L.callback) args.push('--callback', L.callback);
  if (L.source) args.push('--source', L.source);
  if (L.pipeline) args.push('--pipeline', L.pipeline);
  if (L.pipelineMode) args.push('--mode', L.pipelineMode);
  if (L.horsPipeline) args.push('--hors-pipeline', L.horsPipeline);
  if (L.newSession) args.push('--new-session');
  return spawnDetached(root, args, cleanEnv(env0));
}
/** Launches a chef turn that continues request `r` (answer, retry). */
export function launchChefTurn(root, r, text, env0 = process.env) {
  const args = [r.project, text];
  if (r.source) args.push('--source', r.source);
  return spawnDetached(root, args, { ...cleanEnv(env0), ORCH_REQUEST_ID: r.id });
}

// ---------------------------------------------------------------------------
// Commands (§3.4): each returns { ok, code, text, request? }
// ---------------------------------------------------------------------------

const refuse = (code, text) => ({ ok: false, code, text });
function pendingWithQuestion(logsDir) { return listRequests(logsDir).filter(r => r.state === 'attend_utilisateur'); }

export function cmdAnswer({ root, logsDir, id, text, by = 'utilisateur', now = Date.now(), launch = launchChefTurn }) {
  const r = readRequest(logsDir, id);
  if (!r) return refuse(64, `demande inconnue : ${id}`);
  if (r.state !== 'attend_utilisateur') return refuse(2, `${id} n’attend pas de réponse (état ${r.state})`);
  if (!String(text || '').trim()) return refuse(64, 'réponse vide');
  const u = updateRequest(logsDir, id, (x) => { x.answers.push({ at: nowIso(now), text: String(text), by }); x.question.answeredAt = nowIso(now); x.awaitingTurn = nowIso(now); setState(x, 'reçue', 'réponse de l’utilisateur', by, now); }, { now });
  const l = launch(root, u, String(text));
  return { ok: true, code: 0, text: `réponse envoyée au chef pour ${id} (pid ${l.pid ?? '?'})`, request: u };
}
export function cmdClose({ logsDir, id, note = null, by = 'utilisateur', now = Date.now() }) {
  const r = readRequest(logsDir, id);
  if (!r) return refuse(64, `demande inconnue : ${id}`);
  if (r.state !== 'attend_utilisateur') return refuse(2, `${id} n’attend pas de réponse (état ${r.state})`);
  const u = updateRequest(logsDir, id, (x) => { x.question.answeredAt = nowIso(now); x.question.closed = { by, note }; setState(x, deriveState(x), `marquée répondue${note ? ` : ${note}` : ''}`, by, now); }, { now });
  return { ok: true, code: 0, text: `${id} : question marquée répondue → ${u.state}`, request: u };
}
export function cmdRetry({ root, logsDir, id, by = 'utilisateur', now = Date.now(), launchChef = launchChefTurn, launchTask = launchTaskProcess }) {
  const p = parseTaskId(id);
  const r = readRequest(logsDir, p ? p.request : id);
  if (!r) return refuse(64, `demande inconnue : ${id}`);
  if (p) {
    const t = findTask(r, id);
    if (!t) return refuse(64, `tâche inconnue : ${id}`);
    if (t.state !== 'à_traiter') return refuse(2, `${r.id}#${t.n} n’est pas à traiter (état ${t.state}) : rien à relancer`);
    return relaunchTask({ root, logsDir, r, n: t.n, by, now, launch: launchTask, why: 'relance de l’opération existante' });
  }
  if (r.state !== 'garée') return refuse(2, `${id} n’est pas garée (état ${r.state})`);
  const u = updateRequest(logsDir, id, (x) => { x.retries = (x.retries || 0) + 1; delete x.parked; x.awaitingTurn = nowIso(now); setState(x, 'reçue', 'relance demandée', by, now); }, { now });
  const l = launchChef(root, u, u.text);
  return { ok: true, code: 0, text: `${id} relancée (tour du chef, pid ${l.pid ?? '?'})`, request: u };
}
function relaunchTask({ root, logsDir, r, n, by, now, launch, why, change = {} }) {
  const u = updateRequest(logsDir, r.id, (x) => {
    const t = x.tasks.find(y => y.n === n);
    t.attempt = (t.attempt || 1) + 1;
    if (change.projet) t.projet = change.projet;
    t.launch = { ...(t.launch || {}), ...(change.launch || {}) };
    t.ack = null; delete t.error; delete t.actions; delete t.waiting;
    t.after = change.after || null;
    if (change.after) setTaskState(t, 'en_attente_de', `après ${change.after}`, now);
    else { setTaskState(t, 'lancée', `${why} (essai ${t.attempt})`, now); t.launchedAt = nowIso(now); }
    (x.history ||= []).push({ at: nowIso(now), from: x.state, to: x.state, by, why: `${x.id}#${n} : ${why}` });
    setState(x, deriveState(x), null, by, now);
  }, { now });
  const t = u.tasks.find(y => y.n === n);
  if (t.state === 'en_attente_de') return { ok: true, code: 0, text: `${u.id}#${n} attend ${t.after}`, request: u };
  const l = launch(root, u, t);
  return { ok: true, code: 0, text: `${taskIdOf(u.id, n, t.attempt)} lancée (${t.projet}, pid ${l.pid ?? '?'})`, request: u };
}
export function cmdFix({ root, logsDir, id, pipeline = null, mode = null, projet = null, after = null, projects = null, by = 'utilisateur', now = Date.now(), launch = launchTaskProcess }) {
  const p = parseTaskId(id);
  const r = p && readRequest(logsDir, p.request);
  const t = r && findTask(r, id);
  if (!t) return refuse(64, `tâche inconnue : ${id}`);
  if (t.state !== 'à_traiter') return refuse(2, `${r.id}#${t.n} n’est pas à traiter (état ${t.state})`);
  if (projet && projects && !projects.includes(projet)) return refuse(64, `projet inconnu de config.json : ${projet}`);
  if (pipeline && !/^[a-z][a-z0-9-]{1,30}$/.test(pipeline)) return refuse(64, `pipeline invalide : ${pipeline}`);
  if (mode && !['leger', 'léger', 'complet'].includes(mode)) return refuse(64, `mode invalide : ${mode}`);
  if (after) {
    const a = parseTaskId(after);
    if (!a || a.request !== r.id || a.n === t.n || !r.tasks.some(x => x.n === a.n)) return refuse(64, `--after : tâche de la même demande attendue (${after})`);
  }
  return relaunchTask({ root, logsDir, r, n: t.n, by, now, launch, why: 'corrigée', change: { projet, after, launch: { ...(pipeline ? { pipeline } : {}), ...(mode ? { pipelineMode: mode.replace('é', 'e') } : {}) } } });
}
export function cmdCancel({ logsDir, id, by = 'utilisateur', now = Date.now() }) {
  const p = parseTaskId(id);
  const r = p && readRequest(logsDir, p.request);
  const t = r && findTask(r, id);
  if (!t) return refuse(64, `tâche inconnue : ${id}`);
  if (TASK_TERMINAL.has(t.state)) return refuse(2, `${r.id}#${t.n} est déjà ${t.state}`);
  if (t.waitsFor && t.state === 'en_attente_de') {
    const tid = taskIdOf(r.id, t.n, t.attempt || 1);
    const ids = readPending(logsDir).filter(e => e.taskId === tid).map(e => e.id);
    if (ids.length) dropPending(logsDir, { ids });
  }
  if (t.state === 'en_cours' || t.state === 'en_file') return refuse(3, `${r.id}#${t.n} est ${t.state === 'en_file' ? 'en file' : 'en cours'} : la retirer de la file (node scripts/queue.mjs) ou arrêter le tour (kill-stalled.mjs ${t.projet} --by ${by}) d’abord — rien n’est annulé à l’aveugle`);
  const u = updateRequest(logsDir, r.id, (x) => { const y = x.tasks.find(z => z.n === t.n); setTaskState(y, 'annulée', `annulée par ${by}`, now); for (const z of x.tasks) if (z.state === 'en_attente_de' && parseTaskId(z.after)?.n === t.n) { z.error = { code: 'prédécesseur', why: `${x.id}#${t.n} annulée`, at: nowIso(now) }; setTaskState(z, 'à_traiter', z.error.why, now); } setState(x, deriveState(x), `${x.id}#${t.n} annulée`, by, now); }, { now });
  return { ok: true, code: 0, text: `${r.id}#${t.n} annulée → demande ${u.state}`, request: u };
}
export function cmdDrop({ logsDir, id, reason = null, by = 'utilisateur', now = Date.now(), alive = pidAlive }) {
  const r = readRequest(logsDir, id);
  if (!r) return refuse(64, `demande inconnue : ${id}`);
  if (TERMINAL.has(r.state)) return refuse(2, `${id} est déjà ${r.state}`);
  const last = r.turns[r.turns.length - 1];
  if (r.state === 'en_cours' && last && !last.end && alive(last.pid)) return refuse(3, `${id} : le tour du chef tourne encore (pid ${last.pid}) — rien n’est abandonné pendant un tour`);
  const running = r.tasks.filter(t => ['en_cours', 'en_file'].includes(t.state));
  const u = updateRequest(logsDir, id, (x) => { for (const t of x.tasks) if (['en_attente_de', 'lancée', 'à_traiter'].includes(t.state)) setTaskState(t, 'annulée', 'demande abandonnée', now); setState(x, 'abandonnée', reason || `abandonnée par ${by}`, by, now); }, { now });
  return { ok: true, code: 0, text: `${id} abandonnée${running.length ? ` — encore en cours ou en file, non arrêtées : ${running.map(t => `${id}#${t.n} (${t.projet})`).join(', ')}` : ''}`, request: u };
}
/**
 * Re-reads the facts of a request, including one abandoned while its tasks had
 * only missed their acknowledgement (prod, 2026-10-22: dropped because nothing
 * else could close them). A task cancelled by the drop, or still `à_traiter`,
 * whose error is a missed acknowledgement and whose user_prompt is found in the
 * musician's log, is followed again: run done ⇒ `réussie`. If every task ends
 * that way, an abandoned request becomes `terminée`. Never launches anything,
 * never touches a task cancelled for another reason.
 */
export function cmdRecheck({ logsDir, id, by = 'utilisateur', now = Date.now(), alive = pidAlive }) {
  const r = readRequest(logsDir, id);
  if (!r) return refuse(64, `demande inconnue : ${id}`);
  const fixed = [];
  const u = updateRequest(logsDir, id, (x) => {
    for (const t of x.tasks) {
      const droppedMissed = t.state === 'annulée' && MISSED_ACK_CODES.has(t.error?.code) && t.ack?.where !== 'log';
      const before = t.state;
      if (droppedMissed) t.state = 'à_traiter';
      if (t.state !== 'à_traiter' && TASK_TERMINAL.has(t.state)) continue;
      const snapshot = JSON.stringify(t);
      followTask(x, t, { logsDir, now, alive });
      if (droppedMissed && !t.recoveredFrom) { t.state = before; continue; }
      if (JSON.stringify(t) !== snapshot) fixed.push(`${x.id}#${t.n} ${before} → ${t.state}`);
      if (droppedMissed) (t.history ||= []).push({ at: nowIso(now), from: before, to: t.state, why: `réexamen par ${by} : l’annulation suivait un accusé manqué` });
    }
    if (!fixed.length) return;
    const live = x.tasks.filter(t => t.state !== 'annulée');
    const wasDropped = x.state === 'abandonnée';
    if (wasDropped && live.length && live.every(t => t.state === 'réussie')) setState(x, 'terminée', `réexamen : ${fixed.join(', ')}`, by, now);
    else if (wasDropped && live.some(t => !TASK_TERMINAL.has(t.state))) { x.state = null; setState(x, deriveState(x), `réexamen : ${fixed.join(', ')}`, by, now); x.history[x.history.length - 1].from = 'abandonnée'; }
    else if (!TERMINAL.has(x.state)) setState(x, deriveState(x), `réexamen : ${fixed.join(', ')}`, by, now);
  }, { now });
  if (!fixed.length) return { ok: true, code: 2, text: `${id} : rien à corriger d’après les journaux (état ${u.state})`, request: u };
  return { ok: true, code: 0, text: `${id} : ${fixed.join(', ')} → demande ${u.state}`, request: u };
}
export function cmdReplay({ root, logsDir, id, now = Date.now(), launch = (rt, rq) => spawnDetached(rt, [rq.project, rq.text], cleanEnv()) }) {
  const r = readRequest(logsDir, id);
  if (!r) return refuse(64, `demande inconnue : ${id}`);
  if (!TERMINAL.has(r.state)) return refuse(2, `${id} n’est pas terminée (état ${r.state}) : « retry » ou « answer »`);
  const l = launch(root, r);
  return { ok: true, code: 0, text: `${id} rejouée : nouvelle demande, même texte (pid ${l.pid ?? '?'})` };
}

/** Requests waiting for the user: an answer is attached only if one waits or its id is cited. */
export function attachAnswer(logsDir, text) {
  const cited = /\br-\d{8}T\d{6}-[0-9a-f]{6}\b/.exec(String(text || ''));
  const waiting = pendingWithQuestion(logsDir);
  if (cited) return waiting.find(r => r.id === cited[0]) ? { id: cited[0] } : { none: true };
  if (waiting.length === 1) return { id: waiting[0].id };
  return waiting.length ? { ambiguous: waiting.map(r => r.id) } : { none: true };
}

export function summaryLine(r) {
  const tasks = r.tasks.length ? ` — ${r.tasks.map(t => `#${t.n} ${t.projet} ${t.state}`).join(', ')}` : '';
  const head = r.text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${r.id}  ${r.state.padEnd(18)}  ${r.kind.padEnd(12)}  « ${head}${r.text.length > 80 ? '…' : ''} »${tasks}`;
}

// ---------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(here, '..');
  const LOGS = path.join(ROOT, 'logs');
  const argv = process.argv.slice(2);
  const flag = (f) => { const i = argv.indexOf(f); if (i === -1) return null; const v = argv[i + 1]; argv.splice(i, 2); return v ?? null; };
  const by = flag('--by') || 'utilisateur';
  const [cmd, id, ...rest] = argv;
  const print = (r) => { (r.ok ? console.log : console.error)(r.text); process.exit(r.code); };
  if (!cmd || cmd === 'list') {
    const all = argv.includes('--all');
    const rs = listRequests(LOGS).filter(r => all || !TERMINAL.has(r.state));
    if (!rs.length) console.log(all ? 'Aucune demande.' : 'Aucune demande en cours.');
    for (const r of rs) console.log(summaryLine(r));
    process.exit(0);
  }
  if (cmd === 'show') {
    const p = parseTaskId(id); const r = readRequest(LOGS, p ? p.request : id);
    if (!r) { console.error(`demande inconnue : ${id}`); process.exit(64); }
    const out = p ? findTask(r, id) : { ...r, exits: EXITS[r.state] || null };
    if (!out) { console.error(`tâche inconnue : ${id}`); process.exit(64); }
    console.log(JSON.stringify(out, null, 2)); process.exit(0);
  }
  if (cmd === 'answer') print(cmdAnswer({ root: ROOT, logsDir: LOGS, id, text: rest.join(' '), by }));
  if (cmd === 'close') print(cmdClose({ logsDir: LOGS, id, note: flag('--note'), by }));
  if (cmd === 'retry') print(cmdRetry({ root: ROOT, logsDir: LOGS, id, by }));
  if (cmd === 'fix') {
    const cfg = readJson(path.join(ROOT, 'config.json'));
    print(cmdFix({ root: ROOT, logsDir: LOGS, id, pipeline: flag('--pipeline'), mode: flag('--mode'), projet: flag('--projet'), after: flag('--after'), projects: (cfg?.projects || []).map(p => p.name), by }));
  }
  if (cmd === 'cancel') print(cmdCancel({ logsDir: LOGS, id, by }));
  if (cmd === 'drop') print(cmdDrop({ logsDir: LOGS, id, reason: flag('--reason'), by }));
  if (cmd === 'replay') print(cmdReplay({ root: ROOT, logsDir: LOGS, id }));
  if (cmd === 'recheck') print(cmdRecheck({ logsDir: LOGS, id, by }));
  if (cmd === 'reconcile') {
    const r = reconcile({ root: ROOT, logsDir: LOGS, dryRun: argv.includes('--dry-run') });
    console.log(`changées : ${r.changed.join(', ') || 'aucune'} ; lancées : ${r.launched.map(l => l.id).join(', ') || 'aucune'} ; silencieuses depuis 2 h : ${r.stale.join(', ') || 'aucune'}`);
    process.exit(0);
  }
  console.error('usage: node scripts/requests.mjs list [--all] | show <id>[#n] | answer <id> "<texte>" | close <id> [--note …] | retry <id>[#n] | fix <id>#<n> [--pipeline p] [--mode m] [--projet p] [--after <id>#<m>] | cancel <id>#<n> | drop <id> [--reason …] | replay <id> | recheck <id> | reconcile [--dry-run]');
  process.exit(64);
}
