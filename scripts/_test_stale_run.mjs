#!/usr/bin/env node
// ============================================================================
// scripts/_test_stale_run.mjs — a test run gone stale is stopped at once, not
// awaited (0.94.0)
// ============================================================================
//
// User, verbatim (2026-10-14): « Je ne comprends pas, si un test est detecte
// comme inutile, on aurait pu l'arreter pour ne pas perdre de temps et
// commencer l'autre ? Si oui, il faut en faire une regle ». A targeted run had
// been left to finish on content changed after its start.
//
// Protected:
//   1. the watch: no change, or a change gone within one interval (a callback
//      file removed by notify.mjs) never stops a run; a lasting change does,
//      once;
//   2. a stale report is refused by the delivery gate;
//   3. end to end, on a private copy of the real regression.mjs: content
//      changed while a suite runs → the run stops within seconds (exit 3),
//      kills ITS suite, leaves any other process alive, writes a `stale`
//      report on the START tree; an unchanged run completes normally;
//   4. the musicians' prompt carries the rule (stop only what you started,
//      never a server, a shared process or another musician's turn).
//
//   node scripts/_test_stale_run.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStaleWatch, staleMessage } from './stale-run.mjs';
import { checkReport } from './delivery-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------------------
section('1. La surveillance : un changement durable arrête, un passage éclair non');
{
  const seq = (values) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
  let calls = 0;
  let w = createStaleWatch({ read: seq(['A', 'A', 'A', 'A']), autoStart: false, onStale: () => calls++ });
  for (let i = 0; i < 3; i++) w.check();
  ok(w.start === 'A' && !w.staleInfo() && calls === 0, 'contenu inchangé : rien');
  w = createStaleWatch({ read: seq(['A', 'B', 'A', 'A', 'A']), autoStart: false, onStale: () => calls++ });
  for (let i = 0; i < 4; i++) w.check();
  ok(!w.staleInfo() && calls === 0, 'fichier apparu puis disparu en un intervalle (fichier de callback) : rien');
  w = createStaleWatch({ read: seq(['A', null, null]), autoStart: false, onStale: () => calls++ });
  for (let i = 0; i < 3; i++) w.check();
  ok(!w.staleInfo() && calls === 0, 'contenu illisible un instant : jamais compté comme un changement');
  w = createStaleWatch({ read: seq(['A', 'B', 'B', 'B', 'B']), autoStart: false, onStale: () => calls++ });
  for (let i = 0; i < 4; i++) w.check();
  ok(w.staleInfo()?.start === 'A' && w.staleInfo()?.current === 'B' && calls === 1, 'changement confirmé : arrêt, une seule fois', JSON.stringify(w.staleInfo()));
  const msg = staleMessage({ paths: ['docs/USER_REQUIREMENTS.md'], more: 2 });
  ok(/périmé/.test(msg) && /Arrêt immédiat de CE lancement/.test(msg) && /relancez-la sur le contenu final/.test(msg) && /docs\/USER_REQUIREMENTS\.md et 2 autre/.test(msg), 'message : périmé, arrêt de ce lancement seul, relancer', msg);
}

// ---------------------------------------------------------------------------
section('2. Un rapport périmé est refusé à la livraison');
{
  const v = checkReport({ label: 'worktree', at: 'x', tree: 'T1', stale: { start: 'T1', current: 'T2' }, results: [{ id: 'suite:a', status: 'OK' }] }, { tree: 'T1' });
  ok(!v.ok && v.reasons.some(r => /rapport périmé/.test(r)), 'refusé même sur son propre arbre, tout vert', v.reasons.join(' | '));
  ok(checkReport({ tree: 'T1', results: [{ id: 'suite:a', status: 'OK' }] }, { tree: 'T1' }).ok, 'un rapport non périmé passe toujours');
}

// ---------------------------------------------------------------------------
section('3. Bout en bout : la vraie non-régression s’arrête d’elle-même');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stale-'));
const REPO = path.join(T, 'repo');
const git = (...a) => spawnSync('git', ['-C', REPO, ...a], { encoding: 'utf8', windowsHide: true });
fs.mkdirSync(path.join(REPO, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'docs'), { recursive: true });
for (const f of ['regression.mjs', '_regression_sandbox.mjs', 'regression-targets.mjs', 'delivery-gate.mjs', 'suite-runner.mjs', 'stale-run.mjs', 'regression-live.mjs', 'atomic-file.mjs'])
  fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(REPO, 'scripts', f));
const PIDFILE = path.join(T, 'suite.pid');
fs.writeFileSync(path.join(REPO, 'scripts', '_test_slow.mjs'),
  `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(PIDFILE)}, String(process.pid));\nsetTimeout(() => { console.log('1 ok, 0 KO'); }, 120000);\n`);
fs.writeFileSync(path.join(REPO, '.gitignore'), '.regress/\n');
fs.writeFileSync(path.join(REPO, 'docs', 'note.md'), 'v1\n');
git('init', '-q'); git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
const ENV = { ...process.env, ORCH_REGRESS_STALE_MS: '300' };
for (const k of ['ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN']) delete ENV[k];

const runReg = (args, timeoutMs) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(REPO, 'scripts', 'regression.mjs'), ...args], { cwd: REPO, env: ENV, windowsHide: true });
  let out = '';
  c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t0 = Date.now();
  const kill = setTimeout(() => { spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); }, timeoutMs);
  c.on('close', (code) => { clearTimeout(kill); resolve({ code, out, ms: Date.now() - t0 }); });
});

// A process this test started on its own: stands for anything the run did not
// start (a server, another musician's turn). It must survive the stop.
const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
const REPORT = path.join(T, 'report-stale.json');
const pending = runReg(['--no-browser', '--jobs', '1', '--out', REPORT], 90_000);
let suitePid = 0;
for (let i = 0; i < 200 && !suitePid; i++) { await sleep(100); try { suitePid = Number(fs.readFileSync(PIDFILE, 'utf8')) || 0; } catch { /* not yet */ } }
ok(suitePid && alive(suitePid), 'la suite lente tourne (lancée par la non-régression)');
const tChange = Date.now();
fs.writeFileSync(path.join(REPO, 'docs', 'note.md'), 'v2 — corrigé pendant le lancement\n');
const r = await pending;
ok(r.code === 3, `code de sortie 3 (périmée) — reçu ${r.code}`, r.out.slice(-800));
ok(Date.now() - tChange < 20_000, `arrêt en ${Math.round((Date.now() - tChange) / 1000)} s, sans attendre la fin de la suite (120 s)`);
ok(/Contenu modifié pendant l’exécution \(docs\/note\.md\)/.test(r.out) && /relancez-la sur le contenu final/.test(r.out) && /LIVRAISON : REFUSÉE/.test(r.out), 'message : fichier changé, relancer, livraison refusée', r.out.slice(-600));
await sleep(500);
ok(suitePid && !alive(suitePid), 'la suite lancée par CE lancement est arrêtée');
ok(alive(other.pid), 'un processus que ce lancement n’a pas lancé reste en vie');
let rep = null; try { rep = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { /* checked below */ }
const startTree = (() => { const g = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }); return g.stdout.trim(); })();
ok(rep && rep.stale && rep.tree === startTree && rep.stale.start === startTree && rep.stale.changed?.includes('docs/note.md'), 'rapport `stale`, sur l’arbre du DÉPART (le contenu réellement testé)', JSON.stringify(rep && { tree: rep.tree, stale: rep.stale }));
ok(rep && !checkReport(rep, { tree: rep.tree }).ok, 'ce rapport ne permet aucune livraison');
try { other.kill(); } catch { /* ignore */ }

// An unchanged run completes and records the tree it started on.
git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v2');
fs.writeFileSync(path.join(REPO, 'docs', 'note.md'), 'v3\n');
const REPORT2 = path.join(T, 'report-ok.json');
const r2 = await runReg(['--targeted', '--no-browser', '--out', REPORT2], 60_000);
let rep2 = null; try { rep2 = JSON.parse(fs.readFileSync(REPORT2, 'utf8')); } catch { /* checked below */ }
ok(r2.code === 0 && rep2 && !rep2.stale && rep2.tree && /arrêt immédiat s’il change en cours de route/.test(r2.out), 'contenu inchangé : la non-régression va au bout, sans arrêt', r2.out.slice(-600));
const r3 = await runReg(['--targeted', '--no-browser', '--no-stale-stop', '--out', path.join(T, 'r3.json')], 60_000);
ok(r3.code === 0 && !/arrêt immédiat/.test(r3.out), '--no-stale-stop désactive la surveillance');

// ---------------------------------------------------------------------------
section('4. La consigne des musiciens');
{
  const D = fs.readFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), 'utf8');
  const a = D.indexOf('function staleTestRule(');
  const b = D.indexOf('\n}\n', a) + 2;
  const rule = a > 0 ? new Function(`${D.slice(a, b)}\nreturn staleTestRule;`)()() : '';
  ok(/TEST PÉRIMÉ/.test(rule) && /Arrête-le immédiatement/.test(rule) && /relance-le sur le contenu final/.test(rule), 'arrêter tout de suite, relancer sur le contenu final', rule);
  ok(/que TU as lancé/.test(rule) && /ni un serveur/.test(rule) && /ni un processus partagé/.test(rule) && /ni le tour d'un autre musicien/.test(rule), 'limites : seulement son propre lancement', rule);
  ok(/if \(projectName !== CONDUCTOR\) prompt = prompt \+ staleTestRule\(\)/.test(D) && D.indexOf('prompt = prompt + staleTestRule()') > D.indexOf('const promptForLog = prompt;'), 'injectée pour tout musicien (pas le chef), invisible dans le fil');
  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'project', 'CLAUDE.md'), 'utf8');
  ok(/\*\*7 — Un test devenu périmé s'arrête aussitôt\.\*\*/.test(tpl), 'modèle des nouveaux projets : règle n° 7');
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
