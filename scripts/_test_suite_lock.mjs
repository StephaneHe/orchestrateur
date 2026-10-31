#!/usr/bin/env node
// ============================================================================
// scripts/_test_suite_lock.mjs — one test suite at a time per project, and a
// global cap on COMPLETE suites, enforced by code
// ============================================================================
//
// User rule (2026-10-30): « les règles doivent être faites respecter par du
// code. pas seulement par le modèle. » Context: « il n'y a aucun intérêt à faire
// tourner les mêmes tests deux fois en même temps ? » and « je ne vois aucun cas
// où en lancer deux identiques pourraient arriver ». On 2026-10-30 at 00:34-00:35
// two targeted non-regression runs of orchestrateur-dev ran at the
// same time (lane 0 and lane 1) and nothing in the code prevented it.
//
// What already exists does not cover it: the suite runner (runPool, SERIAL_SUITES)
// and the regression runner (runSuites) only order the suites INSIDE one run;
// no lock spans processes, lanes or projects.
//
// Protected (scripts/suite-lock.mjs, `withSuiteLock`):
//   1. per-project lock: a second run on the same project waits, then runs
//      (never in parallel); if it waited for the SAME git tree it reuses the
//      first run's report instead of running again;
//   2. global cap `suiteMax` (the tuning-values command, --suite-max,
//      default 1) on COMPLETE suites across projects; targeted runs are exempt;
//   3. waits are visible: « suite en attente du verrou : <qui le tient> ».
//
//   node scripts/_test_suite_lock.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// --- worker mode: one suite run, as a separate process -----------------------
if (process.argv[2] === 'worker') {
  const [, , , dir, project, who, tree, full, maxFull, logFile] = process.argv;
  const { withSuiteLock } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'suite-lock.mjs')).href);
  const waits = [];
  const out = withSuiteLock({
    dir, project, who, tree, full: full === '1', maxFull: Number(maxFull), pollMs: 20,
    onWait: (text) => waits.push(text),
  }, () => {
    fs.appendFileSync(logFile, `start ${who} ${Date.now()}\n`);
    sleepSync(900);
    fs.appendFileSync(logFile, `end ${who} ${Date.now()}\n`);
    return { ok: true, who };
  });
  process.stdout.write(JSON.stringify({ who, reused: !!out.reused, result: out.result, waits }));
  process.exit(0);
}

// --- worker mode: a run through the real helper (lockedSuiteRun), as the engine does ---------
if (process.argv[2] === 'lrun') {
  const [, , , cwd, who, full, logFile] = process.argv;
  const L = await import(pathToFileURL(path.join(ROOT, 'scripts', 'suite-lock.mjs')).href);
  const waits = [];
  L.lockedSuiteRun({ root: ROOT, cwd, who, full: full === '1', onWait: (t) => waits.push(t) }, () => {
    fs.appendFileSync(logFile, `start ${who} ${Date.now()}\n`);
    sleepSync(900);
    fs.appendFileSync(logFile, `end ${who} ${Date.now()}\n`);
    return { ok: true };
  });
  process.stdout.write(JSON.stringify({ who, waits }));
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };

function worker(dir, logFile, { project, who, tree, full = 1, maxFull = 1 }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [HERE, 'worker', dir, project, who, tree, String(full), String(maxFull), logFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: cleanEnv() });
    let o = '', e = '';
    c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
    c.on('close', code => { let json = null; try { json = JSON.parse(o); } catch { /* reported below */ } resolve({ code, json, err: e }); });
  });
}
function intervals(logFile) {
  const m = {};
  let text = '';
  try { text = fs.readFileSync(logFile, 'utf8'); } catch { /* no run happened */ }
  for (const l of text.split('\n').filter(Boolean)) {
    const [k, who, t] = l.split(' ');
    (m[who] ||= {})[k] = Number(t);
  }
  return m;
}
// A parent regression run exports ORCH_SUITE_LOCK_HELD to its suites: the workers must not inherit it.
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; if (!('ORCH_SUITE_LOCK_HELD' in extra)) delete e.ORCH_SUITE_LOCK_HELD; return e; };
function lrun(lockDir, cwd, logFile, who, full = 1, extra = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [HERE, 'lrun', cwd, who, String(full), logFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: cleanEnv({ ORCH_SUITE_LOCK_DIR: lockDir, ...extra }) });
    let o = '', e = '';
    c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
    c.on('close', code => { let json = null; try { json = JSON.parse(o); } catch { /* reported below */ } resolve({ code, json, err: e }); });
  });
}
const overlap = (a, b) => !!a && !!b && a.start < b.end && b.start < a.end;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orch-suite-lock-'));

// 1. Per-project lock: serialised; same tree ⇒ the report is reused; waits are said
console.log('1. verrou de suite par projet');
{
  const dir = tmp(), log = path.join(dir, 'log.txt');
  const [a, b] = await Promise.all([
    worker(dir, log, { project: 'alpha', who: 'lane0', tree: 'T1' }),
    worker(dir, log, { project: 'alpha', who: 'lane1', tree: 'T2' }),
  ]);
  ok(a.code === 0 && b.code === 0, 'les deux demandes aboutissent', `${a.err}\n${b.err}`);
  const iv = intervals(log);
  ok(iv.lane0 && iv.lane1 && !overlap(iv.lane0, iv.lane1), 'arbres différents : jamais en parallèle', JSON.stringify(iv));
  const waiter = [a, b].find(r => r.json && r.json.waits.length);
  ok(waiter && /suite en attente du verrou : /.test(waiter.json.waits[0]) && /lane[01]/.test(waiter.json.waits[0]), 'l’attente dit qui tient le verrou', JSON.stringify(waiter?.json));

  const dir2 = tmp(), log2 = path.join(dir2, 'log.txt');
  const [c, d] = await Promise.all([
    worker(dir2, log2, { project: 'alpha', who: 'lane0', tree: 'SAME' }),
    worker(dir2, log2, { project: 'alpha', who: 'lane1', tree: 'SAME' }),
  ]);
  const starts = fs.existsSync(log2) ? fs.readFileSync(log2, 'utf8').split('\n').filter(l => l.startsWith('start')).length : 0;
  ok(starts === 1, 'même arbre : la suite ne tourne qu’une fois', `${starts} lancements`);
  ok([c, d].filter(r => r.json?.reused).length === 1, 'même arbre : l’attente réutilise le rapport de la première', JSON.stringify([c.json, d.json]));
}

// 2. Global cap on COMPLETE suites, all projects; targeted runs exempt; tunable, default 1
console.log('2. limite globale des suites complètes');
{
  const dir = tmp(), log = path.join(dir, 'log.txt');
  await Promise.all([
    worker(dir, log, { project: 'alpha', who: 'pa', tree: 'A' }),
    worker(dir, log, { project: 'beta', who: 'pb', tree: 'B' }),
  ]);
  const iv = intervals(log);
  ok(iv.pa && iv.pb && !overlap(iv.pa, iv.pb), 'deux projets, suites complètes : une seule à la fois (suiteMax = 1)', JSON.stringify(iv));

  const dir2 = tmp(), log2 = path.join(dir2, 'log.txt');
  await Promise.all([
    worker(dir2, log2, { project: 'alpha', who: 'pa', tree: 'A', full: 1 }),
    worker(dir2, log2, { project: 'beta', who: 'pb', tree: 'B', full: 0 }),
  ]);
  const iv2 = intervals(log2);
  ok(overlap(iv2.pa, iv2.pb), 'un test ciblé n’est pas soumis à la limite globale', JSON.stringify(iv2));

  const dir3 = tmp(), log3 = path.join(dir3, 'log.txt');
  await Promise.all([
    worker(dir3, log3, { project: 'alpha', who: 'pa', tree: 'A', maxFull: 2 }),
    worker(dir3, log3, { project: 'beta', who: 'pb', tree: 'B', maxFull: 2 }),
  ]);
  const iv3 = intervals(log3);
  ok(overlap(iv3.pa, iv3.pb), 'suiteMax = 2 : deux projets tournent ensemble', JSON.stringify(iv3));

  const T = await import(pathToFileURL(path.join(ROOT, 'scripts', 'pipeline-tuning.mjs')).href);
  ok(T.VALUE_DEFAULTS.suiteMax === 1, 'défaut de suiteMax = 1', String(T.VALUE_DEFAULTS.suiteMax));
  let parsed = null; try { parsed = T.parseValueArgs(['--suite-max', '2']); } catch (e) { parsed = e.message; }
  ok(parsed && parsed.suiteMax === 2, 'tuning-values --suite-max 2 est accepté', JSON.stringify(parsed));
}

// 3. The real helper: lanes of one project and runners of different projects share ONE lock set
console.log('3. verrou réel : couloirs d’un projet, projets différents, ORCH_SUITE_LOCK_HELD');
{
  const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', windowsHide: true });
  const mkRepo = () => { const d = tmp(); git(d, 'init', '-q'); fs.writeFileSync(path.join(d, 'a.txt'), 'x'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init'); return d; };
  const L = await import(pathToFileURL(path.join(ROOT, 'scripts', 'suite-lock.mjs')).href);
  const lockDir = tmp();
  const repo = mkRepo(), lane = path.join(tmp(), 'lane1');
  git(repo, 'worktree', 'add', '-q', '--detach', lane);
  fs.writeFileSync(path.join(lane, 'lane.txt'), 'work in the lane'); // another tree: a waiter on the same tree would reuse, not run
  ok(L.projectKey(repo) === L.projectKey(lane), 'la clé de projet est celle de la copie principale, pour un couloir aussi', `${L.projectKey(repo)} / ${L.projectKey(lane)}`);

  const log = path.join(lockDir, 'lane.txt');
  const [a, b] = await Promise.all([lrun(lockDir, repo, log, 'copie0', 0), lrun(lockDir, lane, log, 'couloir1', 0)]);
  const iv = intervals(log);
  ok(a.code === 0 && b.code === 0 && iv.copie0 && iv.couloir1 && !overlap(iv.copie0, iv.couloir1), 'copie principale et couloir : jamais en parallèle', JSON.stringify({ iv, e: a.err + b.err }));
  const w = [a, b].flatMap(r => r.json?.waits || []);
  ok(w.some(t => /^suite en attente du verrou : (copie0|couloir1)/.test(t)), 'l’attente nomme qui tient le verrou', JSON.stringify(w));

  // two DIFFERENT projects, full runs, launched from the real helper: the global cap is one for the machine
  const other = mkRepo(), log2 = path.join(lockDir, 'cap.txt');
  await Promise.all([lrun(lockDir, repo, log2, 'p1'), lrun(lockDir, other, log2, 'p2')]);
  const iv2 = intervals(log2);
  ok(iv2.p1 && iv2.p2 && !overlap(iv2.p1, iv2.p2), 'deux projets, deux suites complètes : une seule à la fois (même dossier de verrous)', JSON.stringify(iv2));

  // ORCH_SUITE_LOCK_HELD: same project = nothing to take; another project = own project lock only, no second global slot
  const log3 = path.join(lockDir, 'held.txt');
  const key = L.projectKey(repo);
  await Promise.all([lrun(lockDir, repo, log3, 'h1', 1, { ORCH_SUITE_LOCK_HELD: key }), lrun(lockDir, repo, log3, 'h2', 1, { ORCH_SUITE_LOCK_HELD: key })]);
  const iv3 = intervals(log3);
  ok(overlap(iv3.h1, iv3.h2), 'ORCH_SUITE_LOCK_HELD du même projet : aucun verrou repris (le parent le tient)', JSON.stringify(iv3));
  const log4 = path.join(lockDir, 'held-other.txt');
  await Promise.all([lrun(lockDir, repo, log4, 'o1', 1, { ORCH_SUITE_LOCK_HELD: L.projectKey(other) }), lrun(lockDir, lane, log4, 'o2', 1, { ORCH_SUITE_LOCK_HELD: L.projectKey(other) })]);
  const iv4 = intervals(log4);
  ok(iv4.o1 && iv4.o2 && !overlap(iv4.o1, iv4.o2), 'ORCH_SUITE_LOCK_HELD d’un autre projet : le verrou de ce projet reste pris', JSON.stringify(iv4));
  ok(!fs.readdirSync(lockDir).some(f => f.endsWith('.lock')), 'tous les verrous sont rendus');

  // The other launchers use the same directory and the same key (static: they are heavy to run here)
  const src = (f) => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
  for (const f of ['regression.mjs', 'idle-regression-runner.mjs', 'clean-copy-check.mjs']) {
    const t = src(f);
    ok(t.includes('acquireSuiteLock(') && t.includes('suiteLockDir()') && t.includes('projectKey('), `${f} : même dossier et même clé de projet`);
  }
  const eng = src('pipeline-engine.mjs');
  ok(eng.includes('lockedSuiteRun(') && [...eng.matchAll(/runCommand\([^)]*(testCommand|sel\.command|c\.command)/g)].length === 0, 'le moteur lance toutes ses commandes de tests par le verrou');
  ok(eng.includes("ctx.onSuiteWait = (text) => writeEvent({ type: 'system', subtype: 'pipeline_progress'"), 'l’attente du moteur est écrite dans le journal du musicien');
  ok(src('suite-runner.mjs').includes("'_test_suite_lock.mjs'"), 'la suite est dans SERIAL_SUITES');
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
