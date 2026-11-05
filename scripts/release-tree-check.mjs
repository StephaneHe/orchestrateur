// ============================================================================
// scripts/release-tree-check.mjs — the tests that read what a release writes,
// run on the FINAL tree, before the release commit
// ============================================================================
//
// A task's tests run before the version, the CHANGELOG entry and the fragments
// are assembled, and a lane without `lanes.releaseCheck` ran nothing afterwards:
// release 1.15.3 of a project went out red (its release test checks the
// CHANGELOG). Selection by code, no model: the tests whose text cites a file the
// release changed, the CHANGELOG, a version file or package.json. No such test:
// nothing runs. Red: the caller refuses the commit and keeps the work.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { areaGlob, citedTestsMax, readTexts, readersOf, runnableTests, targetedCommand } from './pipeline-speed.mjs';
import { lockedSuiteRun } from './suite-lock.mjs';

const DEFAULT_TEST_GLOBS = ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*'];
const posix = (f) => String(f).replace(/\\/g, '/');

/** Uncommitted entries: [{path, untracked}] (a rename counts for its new path). */
function treeEntries(dir) {
  const r = spawnSync('git', ['-C', dir, 'status', '--porcelain', '-z'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const parts = (r.stdout || '').split('\0').filter(Boolean);
  return parts.flatMap((p, i) => {
    if (i > 0 && /^[RC]/.test(parts[i - 1])) return [];
    return [{ path: posix(p.slice(3)), untracked: p.startsWith('??') }];
  });
}

/** Files a test of the project may read to check the release. */
function releaseFiles(cfg, changed) {
  const declared = [cfg.changelog || 'CHANGELOG.md', ...(cfg.versionFiles || []), ...(cfg.areas || []).flatMap(a => a.versionFiles || []), 'package.json'];
  return [...new Set([...changed, ...declared].map(posix))];
}

function mainCommand(dir, cfg, files) {
  const t = targetedCommand(dir, cfg, files);
  if (t.command) return t.command;
  let script = '';
  try { script = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts?.test || ''; } catch { /* no package.json */ }
  const npm = /^npm(\.cmd)?\s+(run\s+)?test$/.test(String(cfg.testCommand || '').trim());
  if (npm && /^vitest(\s+run)?\s*$/.test(script.trim()) && !t.why?.includes('caractère spécial')) return `npx vitest run ${files.join(' ')}`;
  return cfg.testCommand;
}

/**
 * What to run for a release tree: [{area, command, files}], [] when no test
 * reads what the release wrote. Beyond the reader bound, the zone's whole suite.
 */
export function releaseCheckPlan(dir, cfg, changed) {
  const areas = Array.isArray(cfg.areas) ? cfg.areas : [];
  const globs = [...(cfg.mainTestGlobs || cfg.testGlobs || DEFAULT_TEST_GLOBS), ...areas.flatMap(a => a.testGlobs || [])].map(areaGlob);
  const tests = runnableTests(dir, (f) => globs.some(g => g.test(f)));
  const readers = [...readersOf(tests, readTexts(dir, tests), releaseFiles(cfg, changed)).keys()].sort();
  const areaOf = (t) => areas.find(a => (a.paths || []).some(g => areaGlob(g).test(t))) || null;
  const zones = [...new Set(readers.map(areaOf))];
  const tooMany = readers.length > citedTestsMax(cfg);
  return zones.flatMap((a) => {
    const files = readers.filter(t => areaOf(t) === a);
    const whole = a ? a.testCommand : cfg.testCommand;
    const narrow = tooMany ? null
      : a ? (String(a.targetedTestCommand || '').includes('{files}') ? a.targetedTestCommand.replace('{files}', files.join(' ')) : null)
      : mainCommand(dir, cfg, files);
    const command = narrow || whole;
    return command ? [{ area: a?.name || null, command, files, full: command === whole }] : [];
  });
}

function defaultRun(dir, command, timeoutMs) {
  const env = { ...process.env };
  for (const v of ['ORCH_TURN_PROJECT', 'ORCH_TURN_ID', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN']) delete env[v];
  // The command comes from the project's VERSIONED pipeline.json, never from a network input.
  const r = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.slice(-12_000) };
}

/** Puts back what the tests left in the tree, so the commit carries only the release. */
function dropLeftovers(dir, before) {
  const known = new Set(before.map(e => e.path));
  for (const e of treeEntries(dir).filter(x => !known.has(x.path))) {
    if (e.untracked) fs.rmSync(path.join(dir, e.path), { recursive: true, force: true });
    else spawnSync('git', ['-C', dir, 'checkout', '-q', '--', e.path], { windowsHide: true });
  }
}

/**
 * Runs the plan on the tree as it stands (release written, not committed).
 * `run(command, full)` runs one command (the engine's, under its suite lock);
 * else `root` gives the machine-wide suite lock to a plain run.
 * → {ran:false, ok:true} | {ran:true, ok, code, out, command, files}
 */
export function runReleaseTreeCheck(dir, cfg, { run = null, root = null, who = 'release', timeoutMs = 45 * 60_000 } = {}) {
  const before = treeEntries(dir);
  const plan = releaseCheckPlan(dir, cfg, before.map(e => e.path));
  if (!plan.length) return { ran: false, ok: true };
  const runOne = run || ((command, full) => lockedSuiteRun({ root, cwd: dir, who, key: command, full }, () => defaultRun(dir, command, timeoutMs)));
  const files = plan.flatMap(p => p.files);
  for (const p of plan) {
    const t = runOne(p.command, p.full);
    if (!t.ok) { dropLeftovers(dir, before); return { ran: true, ok: false, code: t.code, out: String(t.out || ''), command: p.command, files }; }
  }
  dropLeftovers(dir, before);
  return { ran: true, ok: true, command: plan.map(p => p.command).join(' ; '), files };
}
