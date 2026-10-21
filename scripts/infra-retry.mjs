#!/usr/bin/env node
// ============================================================================
// scripts/infra-retry.mjs — pipeline runs held by an infrastructure failure,
// and their automatic relaunch (Routage v3, phase 0 a)
// ============================================================================
//
// User decision (2026-10-19, docs/ROUTAGE-SYNTHESE.md §3.7): an infrastructure
// failure (Claude OAuth expired, session/usage limit, provider refusal, CLI
// dead without a result) is not an error of the work and never a step
// criterion: the run is held for a retry (paused, `pausedLimit: "infra"`), relaunched
// automatically when it can work again, and the user reads a clear message.
//
// Registry `logs/infra-retry.json` (owner: this module only; lock + atomic
// write). Relaunch = `dispatch.mjs <project> --pipeline-resume <run>
// "continuer"` (queued if the musician is busy), decided by `dueRetries`:
//   - limit: at the reset time given by the CLI (+1 min), else 5, 15, 30 min;
//   - exit (no result, 5xx, timeout, after the in-run back-off): 5, 15, 30 min;
//   - auth: as soon as the Claude credentials file changed (`claude /login`),
//     never by blind retries;
//   - refusal: never (the provider refused twice, the second time in a fresh
//     session): the user decides.
// Called at the end of every dispatch.mjs turn and by the server's 60 s sweep.
//
//   node scripts/infra-retry.mjs list | show <run> | sweep [--dry-run]
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-file.mjs';

export const RETRY_FILE = 'infra-retry.json';
/** Automatic relaunch delays after the first one (minutes). */
export const RETRY_MIN = [5, 15, 30];
const RUN_RE = /^p-\d{8}T\d{6}-[a-z0-9]{4,8}$/;

export const CAUSE_TEXT = {
  auth: 'la connexion de Claude a expiré (OAuth) : plus aucun model Claude ne peut répondre tant qu’elle n’est pas renouvelée',
  limit: 'la limite d’utilisation de Claude est atteinte',
  refusal: 'le fournisseur du model a refusé la demande',
  exit: 'le model ne démarre pas (sortie sans résultat, erreur passagère du fournisseur)',
};

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export function readRetries(logsDir) { const j = readJson(path.join(logsDir, RETRY_FILE)); return Array.isArray(j?.runs) ? j.runs : []; }
function withLock(logsDir, fn) {
  const lock = path.join(logsDir, `${RETRY_FILE}.lock`);
  for (let i = 0; i < 200; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
    catch {
      // A lock older than 30 s belongs to a dead writer.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true }); } catch {}
      const until = Date.now() + 25; while (Date.now() < until) { /* short spin: writers hold the lock for a few ms */ }
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { force: true }); } catch {} }
}
const write = (logsDir, runs) => writeFileAtomic(path.join(logsDir, RETRY_FILE), JSON.stringify({ runs }, null, 2));

/** Default Claude credentials file (its mtime changes on `claude /login`). */
export function credentialsFile(env = process.env) {
  return env.ORCH_CLAUDE_CREDENTIALS || path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
}
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };

/** First automatic relaunch time of a held run (ms), null = never automatic. */
export function firstRetryAt({ cause, until = null, now = Date.now() }) {
  if (cause === 'limit') { const u = until ? Date.parse(until) : NaN; return Number.isFinite(u) ? Math.max(u + 60_000, now + 60_000) : now + RETRY_MIN[0] * 60_000; }
  if (cause === 'exit') return now + RETRY_MIN[0] * 60_000;
  return null;
}

/** Registers (or refreshes) a held run. */
export function holdForRetry(logsDir, { run, project, cause, step = null, until = null, detail = null, now = Date.now(), env = process.env }) {
  return withLock(logsDir, () => {
    const runs = readRetries(logsDir).filter(r => r.run !== run);
    const e = { run, project, cause, step, until, detail: detail ? String(detail).slice(0, 500) : null, at: new Date(now).toISOString(), tries: 0,
      retryAt: (() => { const t = firstRetryAt({ cause, until, now }); return t ? new Date(t).toISOString() : null; })(),
      ...(cause === 'auth' ? { credentialsMtime: mtimeOf(credentialsFile(env)) } : {}) };
    runs.push(e);
    write(logsDir, runs);
    return e;
  });
}

/**
 * Runs to relaunch now. An entry whose run is no longer paused on « infra »
 * (resumed by hand, closed) is dropped. Pure apart from reading the files.
 */
export function dueRetries(logsDir, { now = Date.now(), env = process.env } = {}) {
  const due = [], stale = [];
  for (const e of readRetries(logsDir)) {
    const st = readJson(path.join(logsDir, 'runs', e.run, 'run.json'));
    if (!st || st.status !== 'paused' || !['infra', 'launch'].includes(st.pausedLimit)) { stale.push(e.run); continue; }
    if (e.cause === 'auth') {
      const m = mtimeOf(credentialsFile(env));
      if (m != null && (e.credentialsMtime == null || m > e.credentialsMtime)) due.push({ ...e, why: 'connexion Claude renouvelée' });
    } else if (e.retryAt && Date.parse(e.retryAt) <= now) due.push({ ...e, why: e.cause === 'limit' ? 'fin de la limite' : `nouvel essai automatique n° ${e.tries + 1}` });
  }
  return { due, stale };
}

/** Default launcher: the run's own resume, queued if the musician is busy. */
export function launchResume(root, e, env0 = process.env) {
  const st = readJson(path.join(root, 'logs', 'runs', e.run, 'run.json')) || {};
  const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), 'dispatch.mjs'), e.project, 'continuer', '--pipeline-resume', e.run, '--queue-if-busy'];
  if (st.callback) args.push('--callback', st.callback);
  if (st.source) args.push('--source', st.source);
  const env = { ...env0 };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ORCH_TURN_ID', 'ORCH_REQUEST_ID']) delete env[k];
  let pid = null;
  try { const c = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true }); c.on('error', () => {}); c.unref(); pid = c.pid || null; } catch {}
  return { pid };
}

/**
 * Relaunches every due run once; the next automatic try is scheduled before the
 * launch (so two sweeps never relaunch the same run twice). Returns
 * {launched, dropped}.
 */
export function sweepRetries({ root, logsDir = path.join(root, 'logs'), now = Date.now(), env = process.env, launch = launchResume, dryRun = false }) {
  if (!readRetries(logsDir).length) return { launched: [], dropped: [] };
  const picked = withLock(logsDir, () => {
    const { due, stale } = dueRetries(logsDir, { now, env });
    if (dryRun) return { due, stale };
    const ids = new Set(due.map(d => d.run));
    const runs = readRetries(logsDir).filter(r => !stale.includes(r.run)).map(r => {
      if (!ids.has(r.run)) return r;
      const tries = (r.tries || 0) + 1;
      const next = r.cause === 'auth' ? null : RETRY_MIN[Math.min(tries, RETRY_MIN.length) - 1];
      return { ...r, tries, relaunchedAt: new Date(now).toISOString(), retryAt: tries <= RETRY_MIN.length && next ? new Date(now + next * 60_000).toISOString() : null,
        ...(r.cause === 'auth' ? { credentialsMtime: mtimeOf(credentialsFile(env)) } : {}) };
    });
    write(logsDir, runs);
    return { due, stale };
  });
  if (dryRun) return { launched: picked.due.map(d => ({ ...d, dryRun: true })), dropped: picked.stale };
  const launched = picked.due.map(d => ({ run: d.run, project: d.project, cause: d.cause, why: d.why, ...launch(root, d, env) }));
  for (const l of launched) {
    try {
      fs.appendFileSync(path.join(logsDir, `${l.project}.jsonl`), JSON.stringify({ type: 'system', subtype: 'pipeline_infra_retry', pipeline: { run: l.run }, cause: l.cause,
        text: `↻ exécution ${l.run} relancée automatiquement (${l.why})`, timestamp: new Date(now).toISOString() }) + '\n');
    } catch { /* the relaunched turn traces itself */ }
  }
  return { launched, dropped: picked.stale };
}

/** The user-facing message of a held run (template of the synthesis §3.7). */
export function retryText({ project, run, step, cause, detail, retryAt }) {
  const when = retryAt ? new Date(retryAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
  const next = cause === 'auth' ? 'relance automatique dès que Claude est reconnecté (`claude /login` dans un terminal)'
    : cause === 'refusal' ? 'pas de relance automatique : le refus s’est reproduit dans une session neuve'
    : `prochain essai automatique à ${when}`;
  return [
    `⚠ Ce qui s’est passé : ${CAUSE_TEXT[cause] || cause}${step ? ` (étape « ${step} »)` : ''}${detail ? ` — « ${String(detail).replace(/\s+/g, ' ').slice(0, 220)} »` : ''}. Ce n’est pas une erreur du travail : aucun essai de l’étape n’est compté, aucun défaut n’est signalé.`,
    `✓ Ce que j’ai fait : votre demande est gardée — l’exécution ${run} de ${project} attend sa relance là où elle s’est arrêtée, rien n’est perdu ; ${next}.`,
    `→ Vous pouvez répondre : « continuer » (relancer maintenant) · « abandonner ».`,
    `ℹ Détail : node scripts/infra-retry.mjs show ${run}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(here, '..');
  const LOGS = path.join(ROOT, 'logs');
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'list' || !cmd) {
    const runs = readRetries(LOGS);
    if (!runs.length) console.log('Aucune exécution en attente de relance.');
    for (const r of runs) console.log(`${r.run}  ${r.project}  ${r.cause}  depuis ${r.at}  essais auto : ${r.tries || 0}  prochain : ${r.cause === 'auth' ? 'à la reconnexion de Claude' : r.retryAt || 'aucun (décision de l’utilisateur)'}`);
    process.exit(0);
  }
  if (cmd === 'show') {
    const e = readRetries(LOGS).find(r => r.run === arg);
    const st = RUN_RE.test(String(arg)) ? readJson(path.join(LOGS, 'runs', arg, 'run.json')) : null;
    if (!e && !st) { console.error(`${arg} : inconnue`); process.exit(64); }
    console.log(JSON.stringify({ retry: e || null, status: st?.status || null, pausedLimit: st?.pausedLimit || null, infra: st?.infra || null }, null, 2));
    process.exit(0);
  }
  if (cmd === 'sweep') {
    const r = sweepRetries({ root: ROOT, dryRun: process.argv.includes('--dry-run') });
    for (const l of r.launched) console.log(`${l.dryRun ? 'à relancer' : 'relancée'} : ${l.run} (${l.project}) — ${l.why}`);
    for (const d of r.dropped) console.log(`retirée (plus en pause « infra ») : ${d}`);
    if (!r.launched.length && !r.dropped.length) console.log('Rien à relancer maintenant.');
    process.exit(0);
  }
  console.error('usage: node scripts/infra-retry.mjs list | show <run> | sweep [--dry-run]');
  process.exit(64);
}
