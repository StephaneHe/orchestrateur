#!/usr/bin/env node
// ============================================================================
// scripts/copy-setup.mjs — the project's setup step in a CLEAN copy (0.147.0)
// ============================================================================
//
// Post-mortem of p-20261024T033920-3a0055 (complement to the user agreement
// « oui », 2026-10-24): a clean copy links node_modules by a junction
// (provisionPipelineLane) but never replays the project's `postinstall`
// script, so files it generates — ignored by git, e.g. a vendored
// frontend/vendor/vue.global.prod.js — are missing and the tests fail (404)
// for no reason of the code under test.
//
// After the dependency folders are linked, a clean copy (pipeline lane,
// after-the-fact full run, clean-copy validation of the onboarding) runs:
//   1. `.orchestrateur/pipeline.json` → `setupCommand` (string = shell, or an
//      argv array) when declared — for non-npm projects; `false` disables the
//      step;
//   2. otherwise `npm run postinstall --if-present` when package.json declares
//      a `postinstall` script;
//   3. otherwise nothing.
// The output is logged; a failure is a clear, named failure (kind `setup`),
// never a red test run blamed on the code.
//
// A persistent lane only replays the step when its inputs changed (command,
// package.json, package-lock.json): stamp in the worktree's own git dir.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { usefulTail } from './test-failures.mjs';

export const DEFAULT_SETUP_TIMEOUT_MIN = 10;
export const NPM_POSTINSTALL = 'npm run postinstall --if-present';
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const commandText = (c) => (Array.isArray(c) ? c.join(' ') : String(c || ''));

/**
 * The setup step of the copy `dir` (read from the copy itself: the commit's
 * own files). → {command, shell, argv?, source: 'setupCommand'|'postinstall', timeoutMs} | null
 */
export function setupOf(dir) {
  const cfg = readJson(path.join(dir, '.orchestrateur', 'pipeline.json')) || {};
  const timeoutMs = (Number(cfg.setupTimeoutMin) > 0 ? Number(cfg.setupTimeoutMin) : DEFAULT_SETUP_TIMEOUT_MIN) * 60_000;
  const sc = cfg.setupCommand;
  if (sc === false) return null;
  if (typeof sc === 'string' && sc.trim()) return { command: sc, shell: true, source: 'setupCommand', timeoutMs };
  if (Array.isArray(sc) && sc.length && sc.every(x => typeof x === 'string' && x)) return { command: sc, shell: false, argv: sc, source: 'setupCommand', timeoutMs };
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg?.scripts && typeof pkg.scripts.postinstall === 'string' && pkg.scripts.postinstall.trim()) {
    return { command: NPM_POSTINSTALL, shell: true, source: 'postinstall', timeoutMs };
  }
  return null;
}

/** Fingerprint of what the step depends on (a lane replays it when this changes). */
export function setupKey(dir, s) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(s?.command ?? null));
  for (const f of ['package.json', 'package-lock.json', path.join('.orchestrateur', 'pipeline.json')]) h.update(`\0${f}\0${readText(path.join(dir, f))}`);
  return h.digest('hex');
}

function stampFile(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--git-path', 'orch-setup.json'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const p = (r.stdout || '').trim();
  return p ? path.resolve(dir, p) : null;
}

/**
 * Runs the setup step in the copy `dir`.
 *   stamp: true — skip when the last run in this worktree succeeded with the same inputs.
 * → {ran: false, why} | {ran: true, ok, code, command, source, output, log?, reason?, tail?}
 */
export function runCopySetup(dir, { stamp = false, logFile = null, env = process.env, timeoutMs = null } = {}) {
  const s = setupOf(dir);
  if (!s) return { ran: false, why: 'aucune préparation déclarée' };
  const key = setupKey(dir, s);
  const sf = stamp ? stampFile(dir) : null;
  if (sf && readJson(sf)?.key === key && readJson(sf)?.ok) return { ran: false, why: 'déjà faite pour ce contenu', command: commandText(s.command), source: s.source, cached: true };
  const limit = timeoutMs || s.timeoutMs;
  const t = spawnSync(s.shell ? s.command : (s.argv[0] === 'node' ? process.execPath : s.argv[0]), s.shell ? [] : s.argv.slice(1),
    { cwd: dir, shell: s.shell, encoding: 'utf8', windowsHide: true, timeout: limit, maxBuffer: 64 * 1024 * 1024, env: { ...env, ORCH_REGRESS_LIVE: '0' } });
  const timedOut = t.error?.code === 'ETIMEDOUT' || (t.signal === 'SIGTERM' && t.status == null);
  const code = timedOut ? null : (t.status ?? (t.error?.code === 'ENOENT' ? 127 : 1));
  const output = `$ ${commandText(s.command)}   (préparation de la copie propre, ${s.source}, ${dir})\n${t.stdout || ''}${t.stderr || ''}${t.error ? `\n[copy-setup] ${t.error.message}\n` : ''}`;
  const ok = code === 0;
  const res = { ran: true, ok, code, command: commandText(s.command), source: s.source, output };
  if (!ok) {
    res.tail = usefulTail(output).slice(-8);
    res.reason = timedOut ? `délai dépassé (${Math.round(limit / 60_000)} min)` : `code ${code}${res.tail.length ? ` — ${res.tail[res.tail.length - 1]}` : ''}`;
  }
  if (logFile) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, output); res.log = logFile; } catch { /* best effort */ } }
  if (sf) { try { fs.writeFileSync(sf, JSON.stringify({ key, ok, at: new Date().toISOString(), command: res.command })); } catch { /* stamp only */ } }
  return res;
}

/** The failure record of a failed setup (same shape as test-failures.mjs, kind `setup`). */
export function setupFailures(s) {
  return { kind: 'setup', runner: null, counts: null, command: s.command, source: s.source, reason: `préparation « ${s.command} » en échec : ${s.reason || `code ${s.code}`}`,
    missing: [], failed: [], truncated: 0, tail: s.tail || [] };
}
