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
// in a detached git worktree of the commit, dependency folders linked and the
// project's setup step replayed (0.147.0, copy-setup.mjs; failure = code 71,
// ko `setup:échec`, the tests are not run) — and
// writes {code, ko, report, failures?, ignored?, endedAt} to step.resultFile
// (0.145.0: without a report, `ko` names the failed tests read from the output,
// test-failures.mjs; `ignored` = git-ignored files the output points at,
// clean-copy-check.mjs). Refuses (65) a
// production checkout (prod-guard.mjs), whatever the caller.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-file.mjs';
import { isProdRoot } from './prod-guard.mjs';
import { LAUNCHER } from './idle-regression.mjs';
import { addCleanWorktree, removeWorktree, ignoredHints } from './clean-copy-check.mjs';
import { parseTestOutput, compactFailures, koIds } from './test-failures.mjs';
import { setupFailures } from './copy-setup.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// The command's own output (the log is appended to): read back from `from`, at most 4 MB from its end.
function readSegment(file, from) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(from, size - 4 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(size - start); fs.readSync(fd, b, 0, b.length, start); return b.toString('utf8'); } finally { fs.closeSync(fd); }
  } catch { return ''; }
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
      const w = addCleanWorktree(step.path, step.worktree, step.commit);
      write(w.out);
      if (!w.ok) { finish({ code: 70, ko: null, why: 'worktree impossible' }); return 70; }
      // 0.147.0: setup (postinstall / setupCommand) failed — a named failure, the tests are not run.
      if (w.setup && !w.setup.ok) { finish({ code: 71, ko: koIds({ kind: 'setup' }, 71), failures: setupFailures(w.setup), why: 'préparation de la copie propre en échec' }); return 71; }
      cwd = step.worktree;
    }
    const [cmd, ...args] = step.argv[0] === '__shell__' ? [step.argv[1]] : step.argv;
    const shell = step.argv[0] === '__shell__';
    write(`\n$ ${shell ? cmd : [cmd, ...args].join(' ')}   (cwd ${cwd}, commit ${step.commit})\n`);
    const from = fs.fstatSync(logFd).size;
    const code0 = await new Promise((resolve) => {
      const c = spawn(shell ? cmd : (cmd === 'node' ? process.execPath : cmd), shell ? [] : args, { cwd, shell, windowsHide: true, stdio: ['ignore', logFd, logFd],
        env: { ...process.env, ORCH_REGRESS_LAUNCHER: LAUNCHER } });
      c.on('error', (e) => { write(`[idle-regression] ${e.message}\n`); resolve(127); });
      c.on('exit', (c2) => resolve(c2 ?? 1));
    });
    let code = code0;
    // Areas' commands of a declared full run (2026-10-29): each runs after it, the first failure code is kept.
    for (const ac of Array.isArray(step.areaCommands) ? step.areaCommands : []) {
      write(`\n$ ${ac}   (zone, cwd ${cwd}, commit ${step.commit})\n`);
      const c3 = await new Promise((resolve) => {
        const c = spawn(ac, [], { cwd, shell: true, windowsHide: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, ORCH_REGRESS_LAUNCHER: LAUNCHER } });
        c.on('error', (e) => { write(`[idle-regression] ${e.message}\n`); resolve(127); });
        c.on('exit', (c2) => resolve(c2 ?? 1));
      });
      if (code === 0) code = c3;
    }
    let ko = null, reportRel = null, failures = null, ignored = [];
    if (step.report) {
      const rep = readJson(path.join(cwd, step.report));
      if (rep && Array.isArray(rep.results)) { ko = rep.results.filter(x => x.status === 'KO').map(x => x.id); reportRel = path.join(cwd, step.report); }
    } else {
      // 0.145.0: the failed tests themselves, never just « testCommand ».
      const output = readSegment(step.logFile, from);
      const f = parseTestOutput(output, { code });
      ko = koIds(f, code);
      if (code !== 0) {
        failures = compactFailures(f);
        if (!step.inPlace) try { ignored = ignoredHints(step.path, step.worktree, output, f); } catch { /* hints only */ }
      }
    }
    finish({ code, ko, report: reportRel, ...(failures ? { failures } : {}), ...(ignored.length ? { ignored } : {}) });
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
