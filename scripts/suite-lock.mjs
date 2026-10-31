// ============================================================================
// scripts/suite-lock.mjs — one test suite at a time per project, and a global
// cap on COMPLETE suites, enforced by code (0.158.0)
// ============================================================================
//
// User rule (2026-10-30): « les règles doivent être faites respecter par du
// code. pas seulement par le modèle. » Two `regression.mjs --targeted` of the
// same project ran together (lane 0 and lane 1); nothing spanned processes.
//
// `withSuiteLock(opts, fn)` is synchronous (callers are: the engine's
// spawnSync-style runners, regression.mjs, the idle runner, clean-copy-check):
//   1. per-project lock: a second run on the same project waits, then runs;
//      if it waited and the first run left a record for the SAME git tree (and
//      the same `key`, e.g. the command), the record is reused, `fn` not called;
//   2. COMPLETE runs (`full`) also take one of `maxFull` machine-wide slots;
//      targeted runs are exempt;
//   3. every wait is announced through `onWait("suite en attente du verrou : …")`.
//
// Lock files live in `dir` (logs/suite-locks). A lock whose pid is dead is
// taken over. Nothing is ever killed.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { worktreeTree } from './item-review.mjs';
import { readTuningValues } from './pipeline-tuning.mjs';

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const safe = (s) => String(s || 'projet').replace(/[^A-Za-z0-9_.-]/g, '_');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ONE directory for the whole machine (not under a checkout's logs/): every runner
// of every project, lane and checkout must see the same files, or neither the
// per-project lock nor the global cap holds. Override for tests only.
export const suiteLockDir = () => process.env.ORCH_SUITE_LOCK_DIR || path.join(os.tmpdir(), 'orchestrateur-suite-locks');

/** Main checkout of `cwd`: a pipeline lane (worktree) shares the locks of its project's main copy. */
export function sharedRoot(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true });
  const common = r.status === 0 ? r.stdout.trim() : '';
  return common && path.basename(common) === '.git' ? path.dirname(common) : path.resolve(cwd);
}

/** The project's identity for locking: its main checkout's path (config.json names and folder names differ, lanes share it). */
export function projectKey(cwd) {
  const main = path.resolve(sharedRoot(cwd));
  return `${safe(path.basename(main))}-${crypto.createHash('sha1').update(main.toLowerCase()).digest('hex').slice(0, 8)}`;
}

/**
 * What every real caller uses: tree = the content of `cwd` (so a waiting run on
 * identical content reuses the report), `maxFull` from the tuning values of `root`.
 * `fn({heldKey})` must pass heldKey to the command it runs as ORCH_SUITE_LOCK_HELD.
 * `result` must be JSON-serialisable (it is stored for reuse).
 */
export function lockedSuiteRun({ root, cwd, who, key = '', full = true, onWait = null }, fn) {
  const project = projectKey(cwd);
  let tree = '';
  const idx = path.join(os.tmpdir(), `orch-suite-tree-${project}-${process.pid}.idx`);
  try { tree = worktreeTree(cwd, idx) || ''; } catch { tree = ''; }
  try { fs.rmSync(idx, { force: true }); } catch { /* temp */ }
  let maxFull = 1;
  try { maxFull = readTuningValues(root).suiteMax; } catch { /* default */ }
  const prev = process.env.ORCH_SUITE_LOCK_HELD;
  const r = withSuiteLock({ dir: suiteLockDir(), project, label: path.basename(sharedRoot(cwd)), who, tree, key, full, maxFull, onWait }, () => {
    process.env.ORCH_SUITE_LOCK_HELD = project;
    try { return fn({ heldKey: project }); } finally { if (prev === undefined) delete process.env.ORCH_SUITE_LOCK_HELD; else process.env.ORCH_SUITE_LOCK_HELD = prev; }
  });
  return r.result;
}

function readHolder(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
/** Takes `file` (exclusive create); a dead holder's file is removed. Returns the live holder when busy, else null. */
function tryTake(file, info) {
  try { fs.writeFileSync(file, JSON.stringify(info), { flag: 'wx' }); return null; }
  catch {
    const h = readHolder(file);
    if (h && !alive(h.pid)) { try { fs.rmSync(file, { force: true }); } catch { /* raced */ } return { retry: true }; }
    if (!h) { // being written, or garbage: only an old one is stale
      try { if (Date.now() - fs.statSync(file).mtimeMs > 10_000) fs.rmSync(file, { force: true }); } catch { /* raced */ }
      return { retry: true, who: '?' };
    }
    return h;
  }
}

/**
 * Takes the locks (blocking, synchronous polling). → `{reused, result, by}` when a
 * waiting run on the same tree found the first run's record (nothing is held),
 * else `{reused:false, release(result)}`: the caller runs, then calls release —
 * with the JSON-serialisable result to leave for a waiter on the same tree.
 */
export function acquireSuiteLock({ dir, project, label = project, who = 'inconnu', tree = '', key = '', full = false, maxFull = 1, pollMs = 500, repeatMs = 30_000, onWait = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const info = { pid: process.pid, who, project, label, tree, since: new Date().toISOString() };
  const projFile = path.join(dir, `project-${safe(project)}.lock`);
  const lastFile = path.join(dir, `last-${safe(project)}.json`);
  // ORCH_SUITE_LOCK_HELD names the project whose lock an ancestor process holds (the engine's
  // test command is regression.mjs, which would otherwise wait for its own parent).
  // Same project: nothing to take. Another project (a suite running a fixture project's
  // engine): its own project lock is taken, but not a second global slot, because the
  // ancestor already holds one and a cap of 1 would deadlock.
  const held = process.env.ORCH_SUITE_LOCK_HELD || '';
  if (held === String(project)) return { reused: false, held: true, release() {} };
  if (held) full = false;
  const t0 = Date.now();
  const said = new Map();
  // Repeated every `repeatMs`: the wait blocks this process's event loop, and a
  // silent log would make the supervision call the musician stalled.
  const say = (holder, what) => {
    const text = `suite en attente du verrou : ${holder?.who || '?'} ${what}`;
    const at = said.get(text);
    if (at !== undefined && Date.now() - at < repeatMs) return;
    said.set(text, Date.now());
    try { onWait?.(at === undefined ? text : `${text} — attente : ${Math.round((Date.now() - t0) / 1000)} s`, holder); } catch { /* never breaks the run */ }
  };

  let waited = false;
  for (;;) {
    const busy = tryTake(projFile, info);
    if (!busy) break;
    if (!busy.retry) { waited = true; say(busy, `(${busy.label || project}${busy.tree ? `, arbre ${String(busy.tree).slice(0, 8)}` : ''}, depuis ${String(busy.since || '').slice(11, 19)})`); }
    sleepSync(pollMs);
  }
  const slotFiles = [];
  const release = (result) => {
    if (tree && result !== undefined) { try { fs.writeFileSync(lastFile, JSON.stringify({ tree, key, who, at: new Date().toISOString(), result })); } catch { /* record only */ } }
    for (const f of slotFiles) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
    try { fs.rmSync(projFile, { force: true }); } catch { /* gone */ }
  };
  try {
    if (waited && tree) {
      const last = readHolder(lastFile);
      if (last && last.tree === tree && (last.key || '') === key && 'result' in last && Date.parse(last.at) >= t0) { release(undefined); return { reused: true, result: last.result, by: last.who }; }
    }
    if (full) {
      const slots = Array.from({ length: Math.max(1, Number(maxFull) || 1) }, (_, i) => path.join(dir, `full-${i}.lock`));
      let got = null;
      for (;;) {
        let last = null;
        for (const f of slots) { const b = tryTake(f, info); if (!b) { got = f; break; } if (!b.retry) last = b; }
        if (got) break;
        if (last) say(last, `(limite globale de ${slots.length} suite(s) complète(s), tenue pour ${last.label || last.project})`);
        sleepSync(pollMs);
      }
      slotFiles.push(got);
    }
    return { reused: false, release };
  } catch (e) { release(undefined); throw e; }
}

export function withSuiteLock(opts, fn) {
  const l = acquireSuiteLock(opts);
  if (l.reused) return l;
  let result;
  try { result = fn(); } catch (e) { l.release(undefined); throw e; }
  l.release(result);
  return { reused: false, result };
}
