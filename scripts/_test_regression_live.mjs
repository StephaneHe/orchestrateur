#!/usr/bin/env node
// ============================================================================
// scripts/_test_regression_live.mjs — every regression run is visible while it
// runs, with its progress, its KO, its report and its final result (0.119.0)
// ============================================================================
//
// User request (2026-10-20), verbatim: « Je ne vois pas que le test de non
// regression est en cours sur orchestrateur-dev. C'est un probleme. » Then:
// any run (by a musician, a script of the chef such as phase0-bond.ps1, or
// prod-jump) must show « non-régression en cours » on the project, the
// progress (suites done / total, KO), a link to the report, an entry in the
// activity journal and the final result.
//
// Permanent requirement test:
//   1. scripts/regression-live.mjs: live record, counts, final status into
//      history.ndjson, live file removed, launcher from the turn environment,
//      dead pid or silent run = « interrompue », report path kept under .regress;
//   2. the REAL scripts/regression.mjs, in a throw-away copy of the checkout:
//      the live file appears while the suites run (total, done, KO), the
//      history gets the final status and counts, the report link points to the
//      report actually written; a killed run reads « interrompue »;
//   3. the server and the client are wired (routes, pupitre, journal, band,
//      card chip). The HTTP check `regression-live` and the browser check
//      `regression-live` exercise them on the sandboxed instance.
//
//   node scripts/_test_regression_live.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RL from './regression-live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1500)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-regresslive-'));

// ---------------------------------------------------------------------------
section('1. Module : suivi en direct, bilan, interrompue, lanceur, chemin du rapport');
{
  const R = path.join(T, 'unit');
  fs.mkdirSync(R);
  const live = RL.createLiveRun({ root: R, label: 'worktree', mode: 'full', argv: ['--targeted'], env: { ORCH_TURN_PROJECT: 'orchestrateur-dev' }, heartbeatMs: 60_000 });
  live.stage('suites', { total: 3 });
  live.result('suite', 'OK', '_a.mjs'); live.result('suite', 'KO', '_b.mjs'); live.result('http', 'OK', 'boot');
  let v = RL.readRuns(R);
  ok(v.running.length === 1 && v.running[0].suites.total === 3 && v.running[0].suites.done === 2 && v.running[0].suites.ko === 1 && v.running[0].checks.done === 1,
    'en cours : total, faites, KO par étage', JSON.stringify(v.running[0]));
  ok(RL.progressText(v.running[0]) === 'suites 2/3 · vérifications 1 · 1 KO' && v.running[0].ko[0] === 'suite:_b.mjs', `progression lisible (${RL.progressText(v.running[0])})`);
  ok(v.running[0].launcher.by === 'tour de orchestrateur-dev', `lanceur tiré du tour (${v.running[0].launcher.by})`);
  ok(RL.launcherOf({ ORCH_REGRESS_LAUNCHER: 'phase0-bond.ps1' }).by === 'phase0-bond.ps1' && /hors d’un tour/.test(RL.launcherOf({}).by)
    && /pipeline de P/.test(RL.launcherOf({ ORCH_TURN_PROJECT: 'P', ORCH_TURN_STEP: 'x' }).by), 'lanceur : variable explicite, étape de pipeline, hors d’un tour');
  live.finish({ status: 'ko', counts: { OK: 2, KO: 1, NA: 0 }, durationS: 4, reportAt: 'x' });
  v = RL.readRuns(R);
  ok(!v.running.length && v.recent[0]?.status === 'ko' && v.recent[0].counts.KO === 1 && !fs.readdirSync(RL.liveDir(R)).length, 'fin : bilan dans history.ndjson, fichier en direct retiré');
  ok(live.finish({ status: 'ok' }) === null && fs.readFileSync(RL.historyFile(R), 'utf8').trim().split('\n').length === 1, 'un seul bilan par lancement');
  // Dead pid; then a live pid silent for longer than STALE_MS.
  fs.writeFileSync(path.join(RL.liveDir(R), 'r-1-1.json'), JSON.stringify({ id: 'r-1-1', pid: 999999, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'running' }));
  fs.writeFileSync(path.join(RL.liveDir(R), 'r-1-2.json'), JSON.stringify({ id: 'r-1-2', pid: process.pid, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', status: 'running' }));
  v = RL.readRuns(R, { alive: (p) => p === process.pid });
  ok(!v.running.length && ['r-1-1', 'r-1-2'].every(id => v.recent.find(r => r.id === id)?.status === 'interrupted'), 'processus mort ou muet depuis 5 min : « interrompue », jamais « en cours »', JSON.stringify(v));
  ok(RL.reportPath(R, '.regress/report-x.json') === path.join(R, '.regress', 'report-x.json') && !RL.reportPath(R, '../x.json') && !RL.reportPath(R, '.regress/../config.json')
    && !RL.reportPath(R, 'C:/Windows/x.json') && !RL.reportPath(R, '.regress/x.txt'), 'rapport : seulement un .json sous .regress/');
}

// ---------------------------------------------------------------------------
section('2. Vrai regression.mjs dans une copie du dépôt');
const C = path.join(T, 'copy');
{
  for (const d of ['scripts', 'tests', 'docs']) fs.mkdirSync(path.join(C, d), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) if (!/^_test_/.test(f) && /\.(mjs|json)$/.test(f)) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(C, 'scripts', f));
  for (const f of ['package.json', 'docs/known-ko.json', '.gitignore']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(C, f));
  // Two base suites stand in for the real ones: one green (slow enough to be seen), one red.
  fs.writeFileSync(path.join(C, 'scripts', '_test_repo_hygiene.mjs'), "await new Promise(r => setTimeout(r, Number(process.env.FAKE_SUITE_MS || 5000)));\nconsole.log('1 ok, 0 KO');\n");
  fs.writeFileSync(path.join(C, 'scripts', '_test_user_requirements.mjs'), "console.log('0 ok, 1 KO');\nprocess.exitCode = 1;\n");
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: C, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'copy');
  const env = { ...process.env, ORCH_REGRESS_LAUNCHER: 'recette regression-live' };
  delete env.ORCH_REGRESS_LIVE;
  const start = (extra = {}) => {
    const c = spawn(process.execPath, [path.join(C, 'scripts', 'regression.mjs'), '--targeted', '--no-browser', '--jobs', '2', '--no-stale-stop'], { cwd: C, env: { ...env, ...extra }, windowsHide: true });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
    const done = new Promise(r => c.on('exit', code => r({ code, out })));
    return { c, done, out: () => out };
  };
  const seenLive = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { const r = RL.readRuns(C).running[0]; if (r && r.suites.total != null) return r; await sleep(100); } return null; };

  const a = start();
  const mid = await seenLive(60_000);
  ok(mid && mid.status === 'running' && mid.suites.total === 2 && mid.mode === 'targeted' && mid.launcher.by === 'recette regression-live' && mid.report === '.regress/report-worktree.json',
    'pendant les suites : lancement visible (total 2, ciblée, lanceur, rapport attendu)', JSON.stringify(mid) + a.out().slice(-600));
  const ra = await a.done;
  const end = RL.readRuns(C).recent[0];
  ok(ra.code === 1 && !RL.readRuns(C).running.length && end?.status === 'ko' && end.counts?.KO === 1 && end.counts?.OK === 1 && end.ko.some(k => /_test_user_requirements/.test(k)),
    `fin : rouge, 1 OK · 1 KO, la suite en échec nommée (exit ${ra.code})`, JSON.stringify(end) + ra.out.slice(-600));
  const repFile = RL.reportPath(C, end?.report);
  const rep = repFile && JSON.parse(fs.readFileSync(repFile, 'utf8'));
  ok(rep && rep.at === end.reportAt && rep.counts.KO === 1, 'le lien mène au rapport écrit par CE lancement (même horodatage)');

  const b = start({ FAKE_SUITE_MS: '60000' });
  const running = await seenLive(60_000);
  ok(!!running, 'second lancement visible avant d’être tué');
  spawnSync('taskkill', ['/T', '/F', '/PID', String(b.c.pid)], { windowsHide: true });
  await b.done;
  await sleep(300);
  const killed = RL.readRuns(C).recent.find(r => r.id === running?.id);
  ok(killed?.status === 'interrupted' && !RL.readRuns(C).running.length, `lancement tué : « interrompue » (${killed?.status}, ${killed?.why})`);
  const leftover = fs.readdirSync(RL.liveDir(C)).length;
  RL.createLiveRun({ root: C, label: 'x', mode: 'full', heartbeatMs: 60_000 }).finish({ status: 'ok' });
  ok(leftover === 1 && !fs.readdirSync(RL.liveDir(C)).length && RL.readRuns(C, { keep: 50 }).recent.filter(r => r.id === running?.id).length === 1,
    'le lancement suivant range le fichier du lancement tué dans l’historique (« interrompue », une seule fois)');

  const quiet = spawnSync(process.execPath, [path.join(C, 'scripts', 'regression.mjs'), '--targeted', '--no-browser', '--no-stale-stop'], { cwd: C, env: { ...env, ORCH_REGRESS_LIVE: '0', FAKE_SUITE_MS: '10' }, encoding: 'utf8', windowsHide: true });
  ok(RL.readRuns(C, { keep: 50 }).recent.length === 3 && quiet.status === 1, 'ORCH_REGRESS_LIVE=0 (non-régression lancée par une suite sur ses fixtures) : rien de publié');
}

// ---------------------------------------------------------------------------
section('3. Branchement : serveur, client');
{
  const S = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(["app.get('/api/regressions'", "app.get('/api/regressions/:project'", "app.get('/api/regressions/:project/report/:id'"].every(x => S.includes(x)), 'routes /api/regressions (liste, projet, rapport)');
  ok(/regression: regressionBadge\(p\.name\)/.test(S) && /regressions: \(\(\) =>/.test(S), 'pupitre (pastille) et journal d’activité portent la non-régression');
  ok(!/app\.(post|put|delete)\('\/api\/regressions/.test(S), 'aucune route d’écriture');
  const H = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  ok(/id="regress-band"/.test(H) && /regress-live\.js/.test(H) && H.indexOf('regress-live.js') < H.indexOf('activite.js'), 'bande et module chargés avant le journal');
  ok(/RegressLive\.chipHtml/.test(fs.readFileSync(path.join(ROOT, 'public', 'salle.js'), 'utf8')) && /RegressLive\.journalHtml/.test(fs.readFileSync(path.join(ROOT, 'public', 'activite.js'), 'utf8')), 'pastille du cadre et entrée du journal');
  ok(/ORCH_REGRESS_LIVE: '0'/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'suite-runner.mjs'), 'utf8')), 'les non-régressions des fixtures (lancées par une suite) restent hors du tableau de bord');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'regress-live.css'), 'utf8');
  ok(!/font-size:\s*\d+px/.test(css), 'tailles de police en rem (réglage A−/A+)');
  // Pure client helpers.
  const g = {}; new Function('globalThis', fs.readFileSync(path.join(ROOT, 'public', 'regress-live.js'), 'utf8'))(g);
  const chip = g.RegressLive.chipHtml({ status: 'running', suites: { total: 120, done: 34, ko: 1 }, checks: { ko: 0 } });
  ok(/NR 34\/120 · 1 KO/.test(chip) && /data-regress="running"/.test(chip), `pastille : ${chip.replace(/<[^>]+>/g, '')}`);
  ok(/rapport<\/a>/.test(g.RegressLive.journalHtml({ id: 'r-1', status: 'ok', report: '/api/regressions/x/report/r-1', counts: { OK: 1, KO: 0, NA: 0 } })), 'journal : lien vers le rapport une fois fini');
  ok(/rapport à la fin/.test(g.RegressLive.journalHtml({ id: 'r-1', status: 'running', report: '/api/x', suites: { total: 2, done: 1 } })), 'journal : rapport annoncé pour la fin pendant le lancement');
  ok(!/<script/i.test(g.RegressLive.bandHtml([{ project: '<script>', r: { status: 'running', launcher: { by: '<script>x' } } }])), 'texte échappé dans la bande');
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
