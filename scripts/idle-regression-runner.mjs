#!/usr/bin/env node
// ============================================================================
// scripts/idle-regression-runner.mjs — one step of the full non-regression
// after the fact (0.142.0, scripts/idle-regression.mjs)
// ============================================================================
//
// Launched detached by the server's idle sweep (launchRunner), never imported:
//   node scripts/idle-regression-runner.mjs <step.json>
// Runs one full or bisect run of one commit — in the checkout itself when the
// project declares `inPlace` (regression.mjs --ref extracts the commit), else
// in a detached git worktree of the commit, dependency folders linked — and
// writes {code, ko, report, endedAt} to step.resultFile. Refuses (65) a
// production checkout (prod-guard.mjs), whatever the caller.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-file.mjs';
import { isProdRoot } from './prod-guard.mjs';
import { LAUNCHER } from './idle-regression.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const git = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
};

function removeWorktree(main, wt) {
  if (!wt || !fs.existsSync(wt)) { git(main, ['worktree', 'prune']); return; }
  // Linked dependency folders are junctions: unlink them first, never their target.
  for (const rel of ['node_modules', '.venv', 'venv']) {
    const f = path.join(wt, rel);
    try { if (fs.lstatSync(f).isSymbolicLink()) fs.unlinkSync(f); } catch { /* absent */ }
  }
  git(main, ['worktree', 'remove', '--force', wt]);
  try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ }
  git(main, ['worktree', 'prune']);
}

/** One full or bisect run of one commit, result written to step.resultFile. */
export async function runStep(step) {
  fs.mkdirSync(path.dirname(step.logFile), { recursive: true });
  const logFd = fs.openSync(step.logFile, 'a');
  const write = (s) => fs.writeSync(logFd, s);
  const finish = (res) => { writeFileAtomic(step.resultFile, JSON.stringify({ ...res, endedAt: new Date().toISOString() }, null, 2)); };
  let cwd = step.path;
  try {
    if (isProdRoot(step.path)) { write(`[idle-regression] refusé : ${step.path} est une prod\n`); finish({ code: 65, ko: null, refused: true }); return 65; }
    if (!step.inPlace) {
      removeWorktree(step.path, step.worktree);
      const r = spawnSync('git', ['-C', step.path, 'worktree', 'add', '--detach', step.worktree, step.commit], { encoding: 'utf8', windowsHide: true });
      write(`${r.stdout || ''}${r.stderr || ''}`);
      if (r.status !== 0) { finish({ code: 70, ko: null, why: 'worktree impossible' }); return 70; }
      try { const { provisionPipelineLane } = await import('./lanes.mjs'); provisionPipelineLane(step.path, step.worktree); } catch (e) { write(`[idle-regression] liens : ${e.message}\n`); }
      cwd = step.worktree;
    }
    const [cmd, ...args] = step.argv[0] === '__shell__' ? [step.argv[1]] : step.argv;
    const shell = step.argv[0] === '__shell__';
    write(`\n$ ${shell ? cmd : [cmd, ...args].join(' ')}   (cwd ${cwd}, commit ${step.commit})\n`);
    const code = await new Promise((resolve) => {
      const c = spawn(shell ? cmd : (cmd === 'node' ? process.execPath : cmd), shell ? [] : args, { cwd, shell, windowsHide: true, stdio: ['ignore', logFd, logFd],
        env: { ...process.env, ORCH_REGRESS_LAUNCHER: LAUNCHER } });
      c.on('error', (e) => { write(`[idle-regression] ${e.message}\n`); resolve(127); });
      c.on('exit', (c2) => resolve(c2 ?? 1));
    });
    let ko = null, reportRel = null;
    if (step.report) {
      const rep = readJson(path.join(cwd, step.report));
      if (rep && Array.isArray(rep.results)) { ko = rep.results.filter(x => x.status === 'KO').map(x => x.id); reportRel = path.join(cwd, step.report); }
    } else ko = code === 0 ? [] : ['testCommand'];
    finish({ code, ko, report: reportRel });
    return code;
  } catch (e) {
    write(`[idle-regression] ${e.stack || e.message}\n`);
    finish({ code: 2, ko: null, why: e.message });
    return 2;
  } finally {
    if (!step.inPlace) removeWorktree(step.path, step.worktree);
    try { fs.closeSync(logFd); } catch { /* closed */ }
  }
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await runStep(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))));
}
