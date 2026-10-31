// ============================================================================
// scripts/regression-live.mjs — a running regression is visible (0.119.0)
// ============================================================================
//
// User request (2026-10-20), verbatim: « Je ne vois pas que le test de non
// regression est en cours sur orchestrateur-dev. C'est un probleme. »
//
// Every run of scripts/regression.mjs — by a musician, a script of the chef,
// prod-jump, by hand — publishes its progress in the checkout it tests:
//
//   <root>/.regress/live/<id>.json     the run in progress (rewritten atomically
//                                      at each result and every 15 s)
//   <root>/.regress/history.ndjson     one line per finished run (append-only)
//
// The dashboard server reads these files for each project of config.json (its
// folder and its lane folders): no write from the server, no write outside the
// tested checkout from regression.mjs. A run killed without its exit handler is
// seen as « interrompue » (dead pid, or no heartbeat for STALE_MS).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-file.mjs';

export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 5 * 60_000;
export const HISTORY_KEEP = 20;
const KO_KEEP = 20;

export const liveDir = (root) => path.join(root, '.regress', 'live');
export const historyFile = (root) => path.join(root, '.regress', 'history.ndjson');

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Who launched the run, from the environment of the turn (never a guess). */
export function launcherOf(env = process.env) {
  if (env.ORCH_REGRESS_LAUNCHER) return { by: String(env.ORCH_REGRESS_LAUNCHER).slice(0, 120) };
  // A pipeline step check (pipeline-engine.mjs stepLauncherEnv): the run handles its own failure.
  if (env.ORCH_REGRESS_PIPELINE_RUN) {
    const project = String(env.ORCH_REGRESS_PIPELINE_PROJECT || ''), run = String(env.ORCH_REGRESS_PIPELINE_RUN).slice(0, 80), step = String(env.ORCH_REGRESS_PIPELINE_STEP || '').slice(0, 80);
    return { by: `vérification d’étape ${run}${step ? ` · ${step}` : ''}${project ? ` (${project})` : ''}`, kind: 'pipeline-step', ...(project ? { project } : {}), run, ...(step ? { step } : {}) };
  }
  if (env.ORCH_TURN_STEP && env.ORCH_TURN_PROJECT) return { by: `pipeline de ${env.ORCH_TURN_PROJECT}`, project: env.ORCH_TURN_PROJECT, step: env.ORCH_TURN_STEP };
  if (env.ORCH_TURN_PROJECT) return { by: `tour de ${env.ORCH_TURN_PROJECT}`, project: env.ORCH_TURN_PROJECT };
  return { by: 'hors d’un tour (script ou console)' };
}

/** Expected number of HTTP + browser checks, from the last report of the checkout. */
export function expectedChecks(regressDir) {
  try {
    const reports = fs.readdirSync(regressDir).filter(f => /^report-.*\.json$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(regressDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of reports.slice(0, 5)) {
      const r = JSON.parse(fs.readFileSync(path.join(regressDir, f), 'utf8'));
      const n = (r.results || []).filter(x => x.stage !== 'suite').length;
      if (r.mode === 'full' && n) return n;
    }
  } catch { /* first run */ }
  return null;
}

/**
 * The live record of one run. `stage(name, {total})`, `result(stage, status,
 * name)`, `finish({status, counts, report})`. Writes only under root/.regress.
 */
export function createLiveRun({ root, label, mode, argv = [], env = process.env, pid = process.pid, now = () => Date.now(), heartbeatMs = HEARTBEAT_MS } = {}) {
  const dir = liveDir(root);
  fs.mkdirSync(dir, { recursive: true });
  sweepDead(root, { now: now() });
  const id = `r-${new Date(now()).toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${pid}`;
  const file = path.join(dir, `${id}.json`);
  const rec = {
    id, pid, root, label, mode, args: argv.join(' ').slice(0, 300), launcher: launcherOf(env),
    startedAt: new Date(now()).toISOString(), updatedAt: null, status: 'running', stage: 'préparation',
    suites: { total: null, done: 0, ok: 0, ko: 0, na: 0 }, checks: { expected: expectedChecks(path.join(root, '.regress')), done: 0, ok: 0, ko: 0, na: 0 },
    ko: [], report: null,
  };
  let finished = false;
  const write = () => {
    if (finished) return;
    rec.updatedAt = new Date(now()).toISOString();
    try { writeFileAtomic(file, JSON.stringify(rec, null, 2)); } catch { /* visibility never breaks a run */ }
  };
  write();
  const beat = setInterval(write, heartbeatMs);
  beat.unref?.();
  const api = {
    id, file, rec,
    stage(name, { total } = {}) { rec.stage = name; if (name === 'suites' && Number.isInteger(total)) rec.suites.total = total; write(); },
    setReport(rel) { rec.report = rel; write(); },
    result(stage, status, name) {
      const bucket = stage === 'suite' ? rec.suites : rec.checks;
      bucket.done++;
      if (status === 'OK') bucket.ok++; else if (status === 'KO') bucket.ko++; else bucket.na++;
      if (status === 'KO' && rec.ko.length < KO_KEEP) rec.ko.push(`${stage}:${name}`.slice(0, 160));
      write();
    },
    finish({ status, counts = null, report = null, durationS = null, reportAt = null } = {}) {
      if (finished) return null;
      clearInterval(beat);
      const end = { ...rec, status, endedAt: new Date(now()).toISOString(), counts, report: report || rec.report, reportAt, durationS };
      try { fs.appendFileSync(historyFile(root), JSON.stringify(end) + '\n'); } catch { /* idem */ }
      try { fs.rmSync(file, { force: true }); } catch { /* idem */ }
      finished = true;
      return end;
    },
    get finished() { return finished; },
  };
  return api;
}

/** A killed run left its live file: the next run of the checkout files it as « interrompue ». */
export function sweepDead(root, { now = Date.now(), alive = pidAlive } = {}) {
  let names = [];
  try { names = fs.readdirSync(liveDir(root)).filter(f => /^r-[\w-]+\.json$/.test(f)); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    const file = path.join(liveDir(root), f);
    let r; try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const beat = Date.parse(r.updatedAt || r.startedAt || 0);
    if (alive(r.pid) && now - beat < STALE_MS) continue;
    try {
      fs.appendFileSync(historyFile(root), JSON.stringify({ ...r, status: 'interrupted', endedAt: r.updatedAt || null, why: 'processus arrêté sans bilan' }) + '\n');
      fs.rmSync(file, { force: true });
      n++;
    } catch { /* next time */ }
  }
  return n;
}

/** Runs of one checkout: in progress, then the last finished ones (newest first). */
export function readRuns(root, { now = Date.now(), keep = 5, alive = pidAlive } = {}) {
  const running = [], recent = [];
  let names = [];
  try { names = fs.readdirSync(liveDir(root)).filter(f => /^r-[\w-]+\.json$/.test(f)); } catch { /* none */ }
  for (const f of names) {
    let r; try { r = JSON.parse(fs.readFileSync(path.join(liveDir(root), f), 'utf8')); } catch { continue; }
    const beat = Date.parse(r.updatedAt || r.startedAt || 0);
    if (alive(r.pid) && now - beat < STALE_MS) running.push(r);
    else recent.push({ ...r, status: 'interrupted', endedAt: r.updatedAt || null, why: alive(r.pid) ? 'aucune nouvelle depuis plus de 5 min' : 'processus arrêté sans bilan' });
  }
  try {
    const lines = fs.readFileSync(historyFile(root), 'utf8').split('\n').filter(Boolean).slice(-HISTORY_KEEP);
    for (const l of lines) { try { recent.push(JSON.parse(l)); } catch { /* torn line */ } }
  } catch { /* none yet */ }
  const t = (r) => Date.parse(r.endedAt || r.updatedAt || r.startedAt || 0) || 0;
  running.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  recent.sort((a, b) => t(b) - t(a));
  return { running, recent: recent.slice(0, keep) };
}

/** One line for a card, a band or a journal entry. */
export function progressText(r) {
  const s = r.suites || {}, c = r.checks || {};
  const parts = [];
  if (s.total != null || s.done) parts.push(`suites ${s.done}/${s.total ?? '?'}`);
  if (c.done) parts.push(`vérifications ${c.done}${c.expected ? `/${c.expected}` : ''}`);
  const ko = (s.ko || 0) + (c.ko || 0);
  parts.push(ko ? `${ko} KO` : '0 KO');
  return parts.join(' · ');
}

/** The report file of a run, only when it is a .json under <root>/.regress. */
export function reportPath(root, rel) {
  if (typeof rel !== 'string' || !rel || !/\.json$/i.test(rel)) return null;
  const base = path.resolve(root, '.regress');
  const f = path.resolve(root, rel);
  const inside = path.relative(base, f);
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? f : null;
}
