// tests/regress-live-fixture.mjs — a fake regression run of a fixture project,
// written exactly as scripts/regression-live.mjs writes it (0.119.0). Shared by
// the HTTP (regression.mjs) and browser (_regression_browser.mjs) checks.
import fs from 'node:fs';
import path from 'node:path';

/** A run in progress owned by a LIVE pid (default: this process). */
export function writeRunning(projectDir, { id = 'r-20261020T090000-1', pid = process.pid, suites = { total: 10, done: 3, ok: 2, ko: 1, na: 0 }, ko = ['suite:_test_x.mjs'] } = {}) {
  const dir = path.join(projectDir, '.regress', 'live');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const rec = { id, pid, root: projectDir, label: 'worktree', mode: 'full', args: '', launcher: { by: 'script du chef (recette)' },
    startedAt: now, updatedAt: now, status: 'running', stage: 'suites', suites, checks: { expected: 20, done: 0, ok: 0, ko: 0, na: 0 }, ko, report: '.regress/report-worktree.json' };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

/** A finished run in history.ndjson, with its report file (unless report: false). */
export function writeFinished(projectDir, { id = 'r-20261020T080000-2', status = 'ko', report = true, reportAt = '2026-10-20T08:30:00.000Z' } = {}) {
  const regress = path.join(projectDir, '.regress');
  fs.mkdirSync(regress, { recursive: true });
  const rel = `.regress/report-${id}.json`;
  if (report) fs.writeFileSync(path.join(projectDir, rel), JSON.stringify({ label: 'worktree', at: reportAt, mode: 'full', counts: { OK: 9, KO: 1, NA: 0 }, results: [] }));
  const end = { id, pid: 999999, root: projectDir, label: 'worktree', mode: 'full', launcher: { by: 'tour de recette' }, startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status, stage: 'navigateur', suites: { total: 10, done: 10, ok: 9, ko: 1, na: 0 },
    checks: { expected: 0, done: 0, ok: 0, ko: 0, na: 0 }, ko: ['suite:_test_x.mjs'], counts: { OK: 9, KO: 1, NA: 0 }, report: rel, reportAt, durationS: 60 };
  fs.appendFileSync(path.join(regress, 'history.ndjson'), JSON.stringify(end) + '\n');
  return end;
}

export function clearRuns(projectDir) {
  try { fs.rmSync(path.join(projectDir, '.regress'), { recursive: true, force: true }); } catch { /* none */ }
}
