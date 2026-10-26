#!/usr/bin/env node
// ============================================================================
// scripts/clean-copy-check.mjs — a project's testCommand, run once in a CLEAN
// copy of its current commit (0.145.0)
// ============================================================================
//
// User agreement (2026-10-24): « oui », to the chef's proposal after the first
// night of after-the-fact full runs: two projects were red only because files
// were missing from a clean copy (an AAR ignored by git, fixtures ignored by
// git). The test command is now run once in a `git worktree` of the current
// commit when a project enters the pipelines (pipeline-onboard.mjs,
// new-project.mjs) and whenever its testCommand changes (idle sweep, or
// `pipeline-onboard.mjs --check-clean`); red ⇒ not put in service, with the
// useful output (failed tests, or why the command could not run, and the
// git-ignored files the output points at).
//
// The clean copy is what the idle runner uses (idle-regression-runner.mjs):
// a detached worktree, dependency folders linked (provisionPipelineLane:
// node_modules, .venv, venv; local.properties copied), then the project's
// setup step (0.147.0, copy-setup.mjs: postinstall or setupCommand).
//
// State: logs/clean-check.json → {projects: {<name>: {testCommand, commit, ok,
// at, summary, failures, ignored}}}, written by recordCleanCheck only.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileAtomic } from './atomic-file.mjs';
import { provisionPipelineLane, PIPELINE_LINKS } from './lanes.mjs';
import { parseTestOutput, describeFailures, failureLines, compactFailures } from './test-failures.mjs';
import { runCopySetup, setupFailures } from './copy-setup.mjs';

export const USER_AGREEMENT = 'oui';
export const DEFAULT_TIMEOUT_MIN = 30;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const git = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, ''), err: (r.stderr || '').trim() };
};

/** Removes a worktree made by addCleanWorktree (linked folders unlinked first, never their target). */
export function removeWorktree(main, wt) {
  if (!wt || !fs.existsSync(wt)) { git(main, ['worktree', 'prune']); return; }
  for (const rel of PIPELINE_LINKS) {
    const f = path.join(wt, rel);
    try { if (fs.lstatSync(f).isSymbolicLink()) fs.unlinkSync(f); } catch { /* absent */ }
  }
  git(main, ['worktree', 'remove', '--force', wt]);
  try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ }
  git(main, ['worktree', 'prune']);
}

/**
 * A detached worktree of `commit`, dependency folders linked, then the
 * project's setup step (0.147.0, copy-setup.mjs: postinstall or setupCommand).
 * → {ok, out, provisioned[], setup?} — `setup.ok === false`: the copy is not
 * usable, callers report a `setup` failure instead of running the tests.
 */
export function addCleanWorktree(main, wt, commit, { setup = true, env = process.env } = {}) {
  removeWorktree(main, wt);
  const r = spawnSync('git', ['-C', main, 'worktree', 'add', '--detach', wt, commit], { encoding: 'utf8', windowsHide: true });
  let out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) return { ok: false, out };
  let provisioned = [];
  try { provisioned = provisionPipelineLane(main, wt); } catch (e) { out += `[clean-copy] liens : ${e.message}\n`; }
  if (!setup) return { ok: true, out, provisioned };
  const s = runCopySetup(wt, { env });
  if (s.ran) out += `${s.output}${s.ok ? '' : `\n[clean-copy] préparation en échec : ${s.reason}\n`}`;
  return { ok: true, out, provisioned, ...(s.ran ? { setup: { ok: s.ok, code: s.code, command: s.command, source: s.source, reason: s.reason || null, tail: s.tail || [] } } : {}) };
}

// Ignored folders that never explain a missing file (build outputs, caches).
const IGNORED_NOISE = /(^|\/)(node_modules|\.venv|venv|build|dist|out|\.gradle|\.idea|__pycache__|\.pytest_cache|bin|obj|logs|\.regress|lanes|\.claude|\.orchestrateur|coverage|\.git)(\/|$)/;

/**
 * Files present in the checkout, ignored by git (so absent from any clean
 * copy), that the output points at: by path (relative, or under the worktree)
 * or by file name. → [{file, why}]
 */
export function ignoredHints(dir, wt, output, failures = null) {
  const text = String(output || '');
  const hits = new Map();
  const add = (rel, why) => { if (rel && !hits.has(rel)) hits.set(rel, why); };
  const isIgnored = (rel) => fs.existsSync(path.join(dir, rel)) && git(dir, ['check-ignore', '-q', '--', rel]).ok;
  const norm = (p) => p.replace(/\\\\/g, '\\').replace(/\\/g, '/');
  const wtN = wt ? norm(path.resolve(wt)).toLowerCase() : null;
  const cands = new Set(failures?.missing || []);
  for (const m of text.matchAll(/[A-Za-z]:[\\/][^\s'"`<>|:*?]+|(?:\.{0,2}\/)?[\w.-]+(?:[\\/][\w.-]+)+\.[A-Za-z0-9]{1,8}/g)) cands.add(m[0]);
  for (const c of cands) {
    let p = norm(c).replace(/[.,;:)]+$/, '');
    if (wtN && p.toLowerCase().startsWith(`${wtN}/`)) p = p.slice(wtN.length + 1);
    else if (/^[A-Za-z]:\//.test(p)) continue;
    p = p.replace(/^\.\//, '');
    if (p && !p.startsWith('../') && isIgnored(p)) add(p, 'cité par la sortie, ignoré par git');
  }
  // By name: an ignored file whose name the output quotes (an AAR, a fixture…).
  const listed = git(dir, ['ls-files', '-o', '-i', '--exclude-standard']).out.split('\n').filter(Boolean).filter(f => !IGNORED_NOISE.test(f)).slice(0, 20000);
  for (const f of listed) {
    const base = path.posix.basename(f);
    if (base.length < 5 || !/\.[A-Za-z0-9]{1,8}$/.test(base)) continue;
    const stem = base.replace(/\.[^.]+$/, '');
    if (text.includes(base) || (stem.length >= 6 && new RegExp(`(^|[^\\w-])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(text))) add(f, 'nommé par la sortie, ignoré par git');
    if (hits.size >= 10) break;
  }
  return [...hits].map(([file, why]) => ({ file, why })).slice(0, 10);
}

const argvOf = (tc) => (typeof tc === 'string' && tc.trim() ? { shell: true, cmd: tc } : Array.isArray(tc) && tc.length && tc.every(x => typeof x === 'string' && x) ? { shell: false, cmd: tc[0], args: tc.slice(1) } : null);
export const commandText = (tc) => (Array.isArray(tc) ? tc.join(' ') : String(tc || ''));

/** testCommand / testTimeoutMin declared in .orchestrateur/pipeline.json, or null. */
export function declaredCommand(dir) {
  const cfg = readJson(path.join(dir, '.orchestrateur', 'pipeline.json')) || {};
  return argvOf(cfg.testCommand) ? { testCommand: cfg.testCommand, timeoutMin: Number(cfg.testTimeoutMin) || null } : null;
}

/**
 * Runs `testCommand` once in a clean worktree of `commit` (HEAD by default).
 * → {ok, code, commit, testCommand, failures, ignored[], why?, summary, log?}
 */
export function checkCleanCopy({ dir, testCommand, commit = 'HEAD', timeoutMs = DEFAULT_TIMEOUT_MIN * 60_000, logFile = null, tmpRoot = os.tmpdir(), env = process.env }) {
  const sha = git(dir, ['rev-parse', '--verify', '-q', `${commit}^{commit}`]).out || null;
  const base = { commit: sha, testCommand, at: new Date().toISOString() };
  const done = (r) => {
    const res = { ...base, ...r };
    res.summary = res.ok ? `vert en copie propre (${String(sha).slice(0, 7)})` : summarize(res);
    if (logFile && r.output != null) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, r.output); res.log = logFile; } catch { /* best effort */ } }
    delete res.output;
    return res;
  };
  const a = argvOf(testCommand);
  if (!a) return done({ ok: false, code: null, why: 'aucune testCommand déclarée', failures: null, ignored: [] });
  if (!sha) return done({ ok: false, code: null, why: `commit ${commit} introuvable (dépôt sans commit ?)`, failures: null, ignored: [] });
  const wt = fs.mkdtempSync(path.join(tmpRoot, 'orch-clean-'));
  fs.rmSync(wt, { recursive: true, force: true });
  try {
    const w = addCleanWorktree(dir, wt, sha, { env });
    if (!w.ok) return done({ ok: false, code: 70, why: `copie propre impossible (git worktree) : ${w.out.trim().slice(0, 200)}`, failures: null, ignored: [], output: w.out });
    if (w.setup && !w.setup.ok) return done({ ok: false, code: w.setup.code, failures: setupFailures(w.setup), ignored: [], output: w.out });
    const t = spawnSync(a.shell ? a.cmd : (a.cmd === 'node' ? process.execPath : a.cmd), a.shell ? [] : a.args,
      { cwd: wt, shell: a.shell, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, env: { ...env, ORCH_REGRESS_LIVE: '0' } });
    const output = `${w.out}$ ${commandText(testCommand)}   (copie propre ${wt}, commit ${sha})\n${t.stdout || ''}${t.stderr || ''}${t.error ? `\n[clean-copy] ${t.error.message}\n` : ''}`;
    const timedOut = t.error?.code === 'ETIMEDOUT' || t.signal === 'SIGTERM';
    const code = t.status ?? (t.error?.code === 'ENOENT' ? 127 : 1);
    if (code === 0 && !timedOut) return done({ ok: true, code: 0, failures: null, ignored: [], output });
    const failures = parseTestOutput(output, { code: timedOut ? null : code });
    if (timedOut) { failures.kind = 'not-run'; failures.reason = `délai dépassé (${Math.round(timeoutMs / 60_000)} min)`; }
    const ignored = ignoredHints(dir, wt, output, failures);
    return done({ ok: false, code, failures: compactFailures(failures), ignored, output });
  } finally {
    removeWorktree(dir, wt);
  }
}

/** French reason of a red clean-copy check (one paragraph, then the details). */
export function summarize(res) {
  if (res.ok) return `vert en copie propre (${String(res.commit).slice(0, 7)})`;
  if (res.why) return `copie propre : ${res.why}`;
  if (res.failures?.kind === 'setup') return `copie propre du commit ${String(res.commit).slice(0, 7)} non préparée — ${res.failures.reason} ; la commande de test « ${commandText(res.testCommand)} » n’a pas été lancée`;
  const head = `la commande de test « ${commandText(res.testCommand)} » échoue dans une copie propre du commit ${String(res.commit).slice(0, 7)} (git worktree, code ${res.code})`;
  const what = describeFailures(res.failures);
  const ign = res.ignored?.length ? ` — fichier(s) ignoré(s) par git, donc absents d’une copie propre : ${res.ignored.map(i => i.file).join(', ')} (les versionner, ou une fixture, ou ne plus en dépendre)` : '';
  return `${head} : ${what}${ign}`;
}

/** Lines to print under the summary. */
export function detailLines(res, indent = '   ') {
  if (res.ok || !res.failures) return [];
  return [...failureLines(res.failures, { indent }), ...(res.log ? [`${indent}sortie complète : ${res.log}`] : [])];
}

// ---------------------------------------------------------------------------
// State: the last check of each project
// ---------------------------------------------------------------------------
export const stateFile = (logsDir) => path.join(logsDir, 'clean-check.json');
export function readCleanChecks(logsDir) {
  const j = readJson(stateFile(logsDir));
  return { projects: j?.projects && typeof j.projects === 'object' ? j.projects : {} };
}
export function recordCleanCheck(logsDir, name, res) {
  if (!logsDir) return;
  const st = readCleanChecks(logsDir);
  st.projects[name] = { testCommand: res.testCommand, commit: res.commit, ok: !!res.ok, at: res.at || new Date().toISOString(), summary: res.summary || null,
    failures: res.failures || null, ignored: res.ignored || [], log: res.log || null, by: res.by || null };
  fs.mkdirSync(logsDir, { recursive: true });
  writeFileAtomic(stateFile(logsDir), JSON.stringify(st, null, 2) + '\n', `${stateFile(logsDir)}.${process.pid}.tmp`);
}

/** A new check is due: never checked, testCommand changed, or red on an older commit. */
export function cleanCheckNeeded(rec, testCommand, head) {
  if (!rec) return true;
  if (JSON.stringify(rec.testCommand) !== JSON.stringify(testCommand)) return true;
  return !rec.ok && !!head && rec.commit !== head;
}
