#!/usr/bin/env node
// ============================================================================
// scripts/routage-pending.mjs — Routage tasks waiting for another one (0.58.0)
// ============================================================================
//
// The chef's Routage can decide "do B after A". B waits in
// logs/routage-pending.json until A has produced its result. Until 0.57.x, B was
// only released by the chef's wake-up turn (Relancer step), which never came for
// tasks launched by the Routage itself, and the dependency needed a timestamped
// result that ordinary CLI turns never write: the fleet froze after the end of
// a turn while work remained (user report, 2026-10-09: "A nouveau, orchestrateur
// est termine, et plus rien ne se passe. Il faut corriger la situation").
//
// This module is the single owner of that file:
//   - a dependency is anchored on a log POSITION (byte offset of the awaited
//     project's log when the awaited task was launched) and on the awaited
//     task's text, so any real result written after it releases the waiter —
//     timestamped or not, and never the result of an unrelated earlier turn;
//   - releaseReady() is mechanical (no LLM): dispatch.mjs calls it at the end of
//     EVERY turn, the server sweeps it, the Relancer step still calls it;
//   - a waiter that resumes a paused pipeline run carries `reprise` and is
//     launched with `--pipeline-resume <run>`, never as a new run;
//   - entries are deduplicated (0.67.0) on an explicit identity, never on a
//     text prefix: the same Routage task (run + task number), the same resumed
//     run, or the same task content (fingerprint of the WHOLE normalised text +
//     project + pipeline + mode + awaited project). A duplicate is never dropped
//     silently: it is returned with its reason, appended to
//     logs/routage-pending-duplicates.ndjson, and the engine reports it to the chef.
//
// Why not the first 120 characters any more (user, 2026-10-10: « La clé de
// dédoublonnage ne garde que les 120 premiers caractères de la demande :
// manifestement mauvaise methode, trouves en une autre »): two different tasks
// starting with the same sentence were merged — task 4 of a run was dropped as a
// duplicate of task 3, without any trace. A full-text fingerprint keeps every
// distinct task; the task reference catches a re-dispatch of the same task even
// if its text was reworded; the content fingerprint catches the same work queued
// again by another Routage run (a replayed wake-up).
//
// CLI (never edit the JSON file by hand):
//   node scripts/routage-pending.mjs list [--json]
//   node scripts/routage-pending.mjs release [<id>…] [--force]
//   node scripts/routage-pending.mjs drop <id>… | --run <routage run> [--projet <p>] | --all
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PENDING_FILE = 'routage-pending.json';
export const RUN_ID_RE = /\bp-\d{8}T\d{6}-[0-9a-f]{6}\b/g;
export const DUPLICATES_FILE = 'routage-pending-duplicates.ndjson';
// Only a short, human-readable label now (logs, CLI): never an identity.
const KEY_LEN = 120;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function readPending(logsDir) { return readJson(path.join(logsDir, PENDING_FILE))?.tasks || []; }
export function writePending(logsDir, tasks) {
  const f = path.join(logsDir, PENDING_FILE);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ tasks }, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}

/** Whole task text, normalised (the chef's « Rattachée à » suffix is not part of the task). */
export function normalizeTask(text) {
  return String(text || '').replace(/\n\n\(Rattachée à :[\s\S]*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
/** Short label of a task text (display only). */
export function taskKey(text) { return normalizeTask(text).slice(0, KEY_LEN); }
/** Fingerprint of the WHOLE normalised text: what identifies a turn's request. */
export function textHash(text) {
  return crypto.createHash('sha256').update(normalizeTask(text)).digest('hex').slice(0, 32);
}
/** Fingerprint of a task's content: project, pipeline, mode, awaited project and whole text. */
export function contentHash(t) {
  return crypto.createHash('sha256')
    .update([t.projet || '', t.pipeline || '', t.mode || '', t.after?.projet || '', normalizeTask(t.demande)].join('\u0000'))
    .digest('hex').slice(0, 32);
}
/** Explicit reference of a Routage task: its run and its number in that run. */
export const taskRef = (t) => (t.run && Number.isInteger(t.n) ? `${t.run}#${t.n}` : null);
/**
 * The identities that make two entries the same work, strongest first:
 * same Routage task, same resumed run of the same project, same content.
 */
export function identities(t) {
  return [
    ...(taskRef(t) ? [`ref:${taskRef(t)}`] : []),
    ...(t.reprise ? [`run:${t.projet}|${t.reprise}`] : []),
    `content:${contentHash(t)}`,
  ];
}
/** Kept for the id of entries written before 0.67.0 (and for display). */
export function dedupeKey(t) { return identities(t)[0]; }
export function pendingId(t) {
  return crypto.createHash('sha1').update(`${t.run || ''}|${taskRef(t) || ''}|${contentHash(t)}`).digest('hex').slice(0, 8);
}
/** Entries written before 0.58.0 have no id: derive a stable one. */
export const idOf = (t) => t.id || pendingId(t);

export function logOffset(logsDir, projet) {
  try { return fs.statSync(path.join(logsDir, `${projet}.jsonl`)).size; } catch { return 0; }
}

/** Paused pipeline run of this project cited in the task text (or given), else null. */
export function detectReprise(logsDir, t) {
  const cands = [...(t.reprise ? [t.reprise] : []), ...(String(t.demande || '').match(RUN_ID_RE) || [])];
  for (const run of cands) {
    const st = readJson(path.join(logsDir, 'runs', run, 'run.json'));
    if (st && st.project === t.projet && st.status === 'paused') return run;
  }
  return null;
}

const DUP_REASON = {
  ref: 'même tâche du même Routage déjà en attente (re-dispatch)',
  run: 'reprise de la même exécution en pause déjà en attente',
  content: 'même travail déjà en attente (même projet, même pipeline, même texte complet)',
};

/**
 * Adds waiters, skipping true duplicates. Returns {added, duplicates}; every
 * duplicate says why and which entry it matched, and is appended to
 * logs/routage-pending-duplicates.ndjson — never dropped silently.
 */
export function addPending(logsDir, entries) {
  return withLock(logsDir, () => {
    const tasks = readPending(logsDir);
    const seen = new Map();
    const index = (t) => { for (const k of identities(t)) if (!seen.has(k)) seen.set(k, t); };
    tasks.forEach(index);
    const added = [], duplicates = [];
    for (const e of entries) {
      const hit = identities(e).find(k => seen.has(k));
      if (hit) {
        const kept = seen.get(hit);
        duplicates.push({ projet: e.projet, run: e.run || null, n: e.n ?? null, reprise: e.reprise || null, key: hit,
          reason: DUP_REASON[hit.split(':')[0]], keptId: idOf(kept), keptRun: kept.run || null, keptN: kept.n ?? null,
          demande: String(e.demande || '').slice(0, 2000) });
        continue;
      }
      const t = { ...e, id: e.id || pendingId(e), createdAt: e.createdAt || new Date().toISOString() };
      tasks.push(t); added.push(t); index(t);
    }
    writePending(logsDir, tasks);
    if (duplicates.length) {
      const at = new Date().toISOString();
      try { fs.appendFileSync(path.join(logsDir, DUPLICATES_FILE), duplicates.map(d => JSON.stringify({ at, ...d })).join('\n') + '\n'); } catch {}
    }
    return { added, duplicates };
  });
}

/** One line per duplicate, in the user's language, for the chef's report. */
export function duplicatesText(duplicates) {
  return duplicates.map(d => `- ${d.projet}${d.n != null ? ` (tâche ${d.n}${d.run ? ` du Routage ${d.run}` : ''})` : ''} : écartée — ${d.reason} ; gardée : ${d.keptId}${d.keptN != null ? ` (tâche ${d.keptN}${d.keptRun ? ` du Routage ${d.keptRun}` : ''})` : ''}. Demande : « ${String(d.demande).replace(/\s+/g, ' ').slice(0, 160)} »`).join('\n');
}

/**
 * The real result that satisfies a dependency, or null.
 *  - `after.offset` (0.58.0): only what was appended to the awaited log after
 *    that byte position counts; with `after.key`, only the result of the turn
 *    whose user_prompt starts with the awaited task's text (a turn that was
 *    already running when the task got queued does not count).
 *  - legacy entries (`after.since` only): a timestamped result after it.
 * Phantom results (num_turns 0 and duration_api_ms 0) never count.
 */
export function dependencyResult(logsDir, after) {
  if (!after?.projet) return null;
  const file = path.join(logsDir, `${after.projet}.jsonl`);
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const from = Number.isFinite(after.offset) ? Math.min(after.offset, size) : Math.max(0, size - 4 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  const legacy = !Number.isFinite(after.offset);
  let armed = legacy || !(after.key || after.hash);
  for (const l of text.split('\n')) {
    if (!l.includes('"type"')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    // Only a prompt that opens a turn re-arms (a notify message is no turn).
    // 0.67.0: the awaited task is recognised by the fingerprint of its whole
    // text (`after.hash`); a shared opening sentence is not enough any more.
    // Entries written before keep the legacy prefix match.
    if (!legacy && (after.hash || after.key) && e.type === 'user_prompt' && typeof e.text === 'string' && (!e.source || e.pipeline || e.callback)) {
      armed = after.hash ? textHash(e.text) === after.hash : (taskKey(e.text).startsWith(after.key.slice(0, 60)) || taskKey(e.text) === after.key);
      continue;
    }
    if (e.type !== 'result' || !armed) continue;
    if (!e.synthetic && e.num_turns === 0 && e.duration_api_ms === 0) continue;
    if (legacy && (!e.timestamp || e.timestamp <= after.since)) continue;
    return e;
  }
  return null;
}

function conductorOf(root) { return readJson(path.join(root, 'config.json'))?.conductor || 'chef'; }

/**
 * Launches one Routage task by dispatch.mjs (queued if the musician is busy),
 * with a report back to the chef. A task that resumes a paused run goes out as
 * `--pipeline-resume <run>`: never `--pipeline`, which would start a new run.
 * Returns the launch record, including the awaited log offset taken BEFORE the
 * spawn (what a later "after this task" waiter anchors on).
 */
export function launchTask(root, t, dispatchScript) {
  const conductor = conductorOf(root);
  const logsDir = path.join(root, 'logs');
  const offset = logOffset(logsDir, t.projet);
  const args = [dispatchScript, t.projet, '--prompt-stdin', '--callback', conductor, '--source', conductor, '--queue-if-busy'];
  if (t.reprise) args.push('--pipeline-resume', t.reprise);
  else if (t.served) { args.push('--pipeline', t.pipeline); if (t.pipeline === 'dev' && t.mode) args.push('--mode', t.mode); }
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID']) delete env[k];
  let pid = null;
  try {
    const c = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    c.on('error', () => {});
    c.stdin.on('error', () => {});
    c.stdin.end(t.rattache ? `${t.demande}\n\n(Rattachée à : ${t.rattache})` : t.demande);
    c.unref();
    pid = c.pid || null;
  } catch { pid = null; }
  return { projet: t.projet, pipeline: t.reprise ? t.pipeline || null : t.served ? t.pipeline : null, mode: t.mode || null,
    reprise: t.reprise || null, pid, at: new Date().toISOString(), offset, key: taskKey(t.demande), hash: textHash(t.demande) };
}

/**
 * Mechanical release (no LLM): every waiter whose awaited task has produced a
 * real, successful result is launched once and removed from the file; a failed
 * awaited task keeps the waiter (reported as blocked). The file is rewritten
 * BEFORE launching, under a lock, so two turns ending together never launch the
 * same waiter twice. `onlyAfter` limits the scan to waiters of that project.
 */
export function releaseReady({ root, logsDir = path.join(root, 'logs'), dispatchScript, onlyAfter = null, ids = null, force = false, launch = launchTask }) {
  const ready = [], blocked = [], twins = [];
  const still = withLock(logsDir, () => {
    const tasks = readPending(logsDir);
    const keep = [];
    const keys = new Map();
    for (const t of tasks) {
      const id = idOf(t);
      if (ids && !ids.includes(id)) { keep.push(t); continue; }
      if (!ids && onlyAfter && t.after?.projet !== onlyAfter) { keep.push(t); continue; }
      const r = force ? { forced: true } : dependencyResult(logsDir, t.after);
      if (!r) { keep.push(t); continue; }
      if (r.is_error || (typeof r.subtype === 'string' && r.subtype.startsWith('error'))) {
        blocked.push({ id, projet: t.projet, after: t.after?.projet, why: `la tâche attendue (${t.after?.projet}) a échoué : non relancée` });
        keep.push({ ...t, blocked: t.blocked || new Date().toISOString() });
        continue;
      }
      // Same work released once (identities, never a text prefix); the twin
      // (entries written before 0.67.0) is traced, never dropped silently.
      const ks = identities(t);
      const twin = ks.find(k => keys.has(k));
      if (twin) { twins.push({ projet: t.projet, run: t.run || null, n: t.n ?? null, key: twin, reason: 'jumeau d’une tâche libérée au même moment : lancée une seule fois', keptId: keys.get(twin), demande: String(t.demande || '').slice(0, 2000) }); continue; }
      ks.forEach(k => keys.set(k, id));
      ready.push({ ...t, id });
    }
    writePending(logsDir, keep);
    if (twins.length) {
      const at = new Date().toISOString();
      try { fs.appendFileSync(path.join(logsDir, DUPLICATES_FILE), twins.map(d => JSON.stringify({ at, ...d })).join('\n') + '\n'); } catch {}
    }
    return keep;
  });
  const launched = ready.map(t => {
    // A resume is re-checked at launch time: a run already resumed (or closed)
    // is not paused any more, and the engine would refuse it anyway.
    // A demand citing a paused run of its project is a resume even without the
    // field (entries written before 0.58.0): never a second, new run.
    const reprise = detectReprise(logsDir, t);
    if (t.reprise && !reprise) return { id: t.id, projet: t.projet, skipped: `exécution ${t.reprise} plus en pause : rien relancé` };
    return { id: t.id, ...launch(root, { ...t, reprise }, dispatchScript), after: t.after?.projet };
  });
  return { launched, blocked, still, duplicates: twins };
}

/** Waiters older than `maxMs` (default 2 h), not yet reported. */
export function staleEntries(tasks, { now = Date.now(), maxMs = 2 * 3600_000 } = {}) {
  return tasks.filter(t => !t.staleNotified && Date.parse(t.createdAt || 0) < now - maxMs);
}
export function markNotified(logsDir, ids) {
  return withLock(logsDir, () => {
    const tasks = readPending(logsDir).map(t => (ids.includes(idOf(t)) ? { ...t, staleNotified: new Date().toISOString() } : t));
    writePending(logsDir, tasks);
    return tasks;
  });
}

/** Drops waiters by id, by Routage run (optionally one project), or all. */
export function dropPending(logsDir, { ids = null, run = null, projet = null, all = false } = {}) {
  return withLock(logsDir, () => {
    const tasks = readPending(logsDir);
    const hit = (t) => all || (ids && ids.includes(idOf(t))) || (run && t.run === run && (!projet || t.projet === projet));
    const dropped = tasks.filter(hit);
    writePending(logsDir, tasks.filter(t => !hit(t)));
    return dropped;
  });
}

// --- lock: a directory, atomic on every filesystem; stale after 30 s --------
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function withLock(logsDir, fn) {
  fs.mkdirSync(logsDir, { recursive: true });
  const lock = path.join(logsDir, `${PENDING_FILE}.lock`);
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() - t0 > 5000) throw new Error('routage-pending : verrou occupé');
      sleepSync(50);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function describe(logsDir, t) {
  const dep = t.after ? dependencyResult(logsDir, t.after) : null;
  const state = !t.after ? 'sans dépendance' : !dep ? `attend ${t.after.projet}` : dep.is_error ? `${t.after.projet} a échoué` : `prête (${t.after.projet} a fini)`;
  return `${idOf(t)}  ${t.projet}${t.reprise ? ` — reprise ${t.reprise}` : ''}  [${state}]  depuis ${t.createdAt || '?'}  (routage ${t.run || '?'})\n    ${String(t.demande || '').replace(/\s+/g, ' ').slice(0, 140)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(here, '..');
  const LOGS = path.join(ROOT, 'logs');
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (f) => { const i = rest.indexOf(f); if (i < 0) return null; const v = rest[i + 1]; rest.splice(i, 2); return v; };
  const has = (f) => { const i = rest.indexOf(f); if (i < 0) return false; rest.splice(i, 1); return true; };
  if (cmd === 'list') {
    const tasks = readPending(LOGS);
    if (has('--json')) console.log(JSON.stringify(tasks.map(t => ({ ...t, id: idOf(t), ready: !!(t.after && dependencyResult(LOGS, t.after)) })), null, 2));
    else console.log(tasks.length ? tasks.map(t => describe(LOGS, t)).join('\n') : 'aucune tâche en attente');
  } else if (cmd === 'release') {
    const force = has('--force');
    const ids = rest.filter(Boolean);
    if (force && !ids.length) { console.error('--force exige au moins un identifiant'); process.exit(64); }
    const r = releaseReady({ root: ROOT, logsDir: LOGS, dispatchScript: path.join(here, 'dispatch.mjs'), ids: ids.length ? ids : null, force });
    for (const l of r.launched) console.log(l.skipped ? `— ${l.id} ${l.projet} : ${l.skipped}` : `↗ ${l.id} ${l.projet} lancée${l.reprise ? ` (reprise ${l.reprise})` : ''}`);
    for (const b of r.blocked) console.log(`✕ ${b.id} ${b.projet} : ${b.why}`);
    if (!r.launched.length && !r.blocked.length) console.log('rien à relancer');
  } else if (cmd === 'drop') {
    const run = flag('--run'), projet = flag('--projet'), all = has('--all');
    const ids = rest.filter(Boolean);
    if (!run && !all && !ids.length) { console.error('drop : donner un identifiant, --run <routage run> [--projet <p>] ou --all'); process.exit(64); }
    const d = dropPending(LOGS, { ids: ids.length ? ids : null, run, projet, all });
    console.log(d.length ? d.map(t => `− ${idOf(t)} ${t.projet} retirée`).join('\n') : 'aucune tâche retirée');
    process.exit(d.length ? 0 : 2);
  } else {
    console.error('usage : routage-pending.mjs list [--json] | release [<id>…] [--force] | drop <id>… | --run <run> [--projet <p>] | --all');
    process.exit(64);
  }
}
