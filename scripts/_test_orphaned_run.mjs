#!/usr/bin/env node
// ============================================================================
// scripts/_test_orphaned_run.mjs — orphaned pipeline runs become resumable (0.114.0)
// ============================================================================
//
// User request (2026-10-18), verbatim: « a run whose recorded pid is dead while
// status is "running" (e.g. killed by kill-stalled.mjs) should be recognised as
// orphaned and become resumable (paused with a clear question) instead of being
// stuck ».
//
// Protected:
//   - reclaimOrphanedRun: « running » + dead pid → paused « orphaned », clear
//     question (« continuer » / « abandonner »), traced without a result; a live
//     pid or another status is never touched;
//   - --pipeline-resume and « continuer » accept an orphaned run and restart it
//     at the step where it stopped (refused before: « seule une exécution en
//     pause se reprend »);
//   - a new run on the project pauses the orphan (no longer « interrupted »);
//   - cause of the 2026-10-18 freeze: an item set aside during its review's doc
//     correction no longer leaves that correction to the next item (whose 4b
//     re-reviewed the set-aside group mid-item and crashed « @check »).
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_orphaned_run.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reclaimOrphanedRun, reclaimOrphanedRuns, pidAlive } from './pipeline-engine.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
// A pid that existed and is gone: a child that already exited.
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;

// ---------------------------------------------------------------------------
section('1. reclaimOrphanedRun : « running » + processus mort → pause « orphaned »');
{
  const L = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-orphan-u-'));
  const mk = (run, extra) => {
    fs.mkdirSync(path.join(L, 'runs', run), { recursive: true });
    fs.writeFileSync(path.join(L, 'runs', run, 'run.json'), JSON.stringify({ run, project: 'X', pipeline: 'dev', mode: 'complet', plan: ['rouge', 'vert', '@check'], index: 2, steps: [{ key: '02-vert' }], ...extra }));
  };
  const read = (run) => JSON.parse(fs.readFileSync(path.join(L, 'runs', run, 'run.json'), 'utf8'));
  const dead = deadPid();
  ok(!pidAlive(dead) && pidAlive(process.pid) && !pidAlive(undefined), `pidAlive : mort ${dead} → false, vivant → true, absent → false`);
  mk('p-20261018T091024-aaaaaa', { status: 'running', pid: dead });
  const s = reclaimOrphanedRun(L, 'p-20261018T091024-aaaaaa');
  const r = read('p-20261018T091024-aaaaaa');
  ok(s && r.status === 'paused' && r.pausedLimit === 'orphaned' && r.orphaned.pid === dead && r.orphaned.step === '@check' && r.orphaned.index === 2 && r.index === 2,
    'mise en pause « orphaned », index et étape gardés (la reprise repart de là)', JSON.stringify(r));
  ok(/s’est arrêtée à l’étape « cocher l’item terminé »/.test(r.question) && /« continuer »/.test(r.question) && /« abandonner »/.test(r.question) && /n’existe plus/.test(r.question),
    'question claire : où, pourquoi, et les réponses possibles', r.question);
  const evs = fs.readFileSync(path.join(L, 'X.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  ok(evs.length === 1 && evs[0].subtype === 'pipeline_orphaned' && !evs.some(e => e.type === 'result'), 'tracé dans le log du musicien, sans result (pas de réveil ni de drain de file)');
  mk('p-20261018T091024-bbbbbb', { status: 'running', pid: process.pid });
  ok(reclaimOrphanedRun(L, 'p-20261018T091024-bbbbbb') === null && read('p-20261018T091024-bbbbbb').status === 'running', 'processus vivant : rien ne change');
  mk('p-20261018T091024-cccccc', { status: 'done', pid: dead });
  ok(reclaimOrphanedRun(L, 'p-20261018T091024-cccccc') === null && read('p-20261018T091024-cccccc').status === 'done', 'exécution terminée : rien ne change');
  mk('p-20261018T091024-dddddd', { status: 'running', pid: dead });
  mk('p-20261018T091024-eeeeee', { status: 'running', pid: dead });
  const swept = reclaimOrphanedRuns(L, 'X', { except: 'p-20261018T091024-eeeeee' });
  ok(swept.join() === 'p-20261018T091024-dddddd' && read('p-20261018T091024-eeeeee').status === 'running', `balayage du projet, sauf l’exécution exclue (${swept.join()})`);
  ok(reclaimOrphanedRun(L, '../evil') === null, 'identifiant d’exécution invalide : refusé');
  try { fs.rmSync(L, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Throwaway root + notification listener (chef)
// ---------------------------------------------------------------------------
const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-orphan-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
// Existing test the fake 4b weakens when told to cheat (FAKE_PIPE_BAD=vert) without an item.
fs.writeFileSync(path.join(P, 'test', 'pipe.test.mjs'), "import { test } from 'node:test';\ntest('pipe', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const reset = () => { g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur'); };

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL)$|^DISPATCH_SLOT$|^FAKE_PIPE_|^ORCH_PIPE_(ITEMS|REVIEW_ROUNDS|GREEN_ATTEMPTS|CRITERIA_ATTEMPTS)$/.test(k)) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runFile = (run) => path.join(T, 'logs', 'runs', run, 'run.json');
const runState = (run) => JSON.parse(fs.readFileSync(runFile(run), 'utf8'));
const go = async (args, env) => {
  const n0 = logOf().length;
  const r = await dispatch(args, env);
  const evs = logOf().slice(n0);
  return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run };
};
// The state a turn killed by kill-stalled.mjs leaves: still « running », its process gone.
const orphan = (run) => { const s = runState(run); s.status = 'running'; s.pid = deadPid(); delete s.pausedLimit; delete s.question; delete s.endedAt; fs.writeFileSync(runFile(run), JSON.stringify(s, null, 2)); return s; };

// ---------------------------------------------------------------------------
section('2. --pipeline-resume accepte une exécution orpheline et la reprend là où elle s’est arrêtée');
let r = await go(['Ajoute beaucoup de choses', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '3', ORCH_PIPE_ITEMS: '2' });
const run2 = r.run;
ok(r.code === 2 && runState(run2).pausedLimit === 'items', `exécution de départ en pause « items » (code ${r.code})`, r.out.slice(-600));
const before = orphan(run2);
r = await go(['reprise après kill-stalled', '--pipeline-resume', run2], { FAKE_PIPE_ITEMS: '3', ORCH_PIPE_ITEMS: '2' });
ok(!r.evs.some(e => e.subtype === 'error_pipeline_refused') && !/seule une exécution en pause se reprend/.test(r.out), 'plus de refus « seule une exécution en pause se reprend »', r.out.slice(-600));
ok(r.evs.some(e => e.subtype === 'pipeline_orphaned' && e.pipeline.run === run2) && r.evs.some(e => e.subtype === 'pipeline_start'), 'reconnue orpheline (événement), puis reprise', r.out.slice(-600));
const done2 = r.evs.filter(e => e.subtype === 'pipeline_step_done').map(e => e.pipeline.step);
// The « items » pause stops AT the list step (index not advanced): it is replayed, nothing before it.
ok(runState(run2).status !== 'running' && before.plan[before.index] === 'liste-tests' && done2[0] === 'liste-tests' && !done2.includes('comprendre') && !done2.includes('concevoir'),
  `reprise à l’étape interrompue, sans refaire les étapes validées (${done2.join(',') || 'aucune'}) → ${runState(run2).status}`);
reset();

// ---------------------------------------------------------------------------
section('3. « continuer » trouve une exécution orpheline');
r = await go(['Ajoute beaucoup de choses', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '3', ORCH_PIPE_ITEMS: '2' });
const run3 = r.run;
orphan(run3);
r = await go(['continuer'], { FAKE_PIPE_ITEMS: '3', ORCH_PIPE_ITEMS: '2' });
ok(r.run === run3 && r.evs.some(e => e.subtype === 'pipeline_orphaned') && !r.evs.some(e => e.subtype === 'error_pipeline_refused'), `« continuer » reprend l’exécution orpheline ${run3} (code ${r.code})`, r.out.slice(-600));
reset();

// ---------------------------------------------------------------------------
section('4. Une nouvelle exécution met l’orpheline en pause (plus « interrupted »)');
r = await go(['Ajoute beaucoup de choses', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '3', ORCH_PIPE_ITEMS: '2' });
const run4 = r.run;
orphan(run4);
reset();
r = await go(['Autre demande', '--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple']);
const s4 = runState(run4);
ok(r.run && r.run !== run4 && s4.status === 'paused' && s4.pausedLimit === 'orphaned', `l’ancienne exécution est en pause « orphaned », reprenable (${s4.status})`, r.out.slice(-600));
reset();

// ---------------------------------------------------------------------------
// Cause of the 2026-10-18 freeze: item 1's review asks a doc correction, the
// correction (4b) fails → item 1 set aside; item 2's 4b then took the leftover
// correction, re-reviewed group 1 mid-item (state.item cleared) and « @check »
// crashed on state.item.n, leaving the run « running » with a dead process.
section('5. Item mis de côté pendant sa correction de doc : l’item suivant ne la reprend pas, aucun plantage');
r = await go(['Ajoute la multiplication par deux et trois', '--mode', 'complet'],
  { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_COVERED: '1', FAKE_PIPE_REVIEW_DOC_ITEM: '1:1', FAKE_PIPE_BAD: 'vert:1', ORCH_PIPE_GREEN_ATTEMPTS: '1', ORCH_PIPE_CRITERIA_ATTEMPTS: '1' });
const run5 = r.run;
const s5 = runState(run5);
const order = r.evs.filter(e => ['pipeline_item_start', 'pipeline_item_done', 'pipeline_item_aside'].includes(e.subtype) || (e.subtype === 'pipeline_step_start' && e.pipeline.step === 'revue'))
  .map(e => `${{ pipeline_item_start: 'start', pipeline_item_done: 'done', pipeline_item_aside: 'aside', pipeline_step_start: 'revue' }[e.subtype]}${e.pipeline.item ?? ''}`).join(',');
ok(s5.status === 'paused' && r.evs.some(e => e.type === 'result'), `l’exécution se termine proprement (${s5.status}, code ${r.code}), jamais « running » sans processus`, r.out.slice(-1200));
ok(s5.aside?.[0]?.group === 1 && s5.aside[0].fixes?.length === 1 && s5.fixGroup == null && !s5.reviewItems, 'item 1 mis de côté AVEC sa correction de doc ; plus rien ne traîne pour l’item suivant', JSON.stringify({ aside: s5.aside, fixGroup: s5.fixGroup, reviewItems: s5.reviewItems }));
ok(!/start2,(?:(?!done2).)*revue1/.test(order), `aucune revue de l’item 1 pendant l’item 2 (${order})`);
ok(s5.delivered?.some(d => d.group === 2) && s5.pausedLimit === 'items_blocked', `l’item 2 est livré, pause « items_blocked » pour l’item 1 (${s5.pausedLimit})`);
r = await go(['continuer'], { FAKE_PIPE_ITEMS: '2' });
const s5b = runState(run5);
ok(r.code === 0 && s5b.status === 'done' && s5b.delivered.some(d => d.group === 1) && r.evs.some(e => e.subtype === 'pipeline_item_resumed' && e.pipeline.item === 1),
  `« continuer » : l’item 1 reprend avec sa correction, il est relu puis livré (${s5b.status}, code ${r.code})`, r.out.slice(-900));
reset();

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
