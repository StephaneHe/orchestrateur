#!/usr/bin/env node
// ============================================================================
// scripts/_test_item_delivery.mjs — per-item delivery of the full Development (0.64.0)
// ============================================================================
//
// User decision (2026-10-10), verbatim: « c+d » — option c = « Livraison par
// item : chaque item est relu et livré séparément, dans son propre commit. Un
// défaut ne bloque que son item ». Atomic task 4 = the delivery.
//
// Protected:
//   - each item validated by its own Review (with its « (revue item N) » cases)
//     is committed at once, in its own commit, right after that Review;
//   - version, CHANGELOG and requirement line: one release commit at the end
//     of the run, for the items delivered (never one bump per item);
//   - an item stopped by one of ITS limits is set aside (patch kept, work tree
//     cleaned) and does not prevent the delivery of the others; « continuer »
//     puts it back where it stopped, then a new release;
//   - a run paused by an older engine keeps its single commit.
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_item_delivery.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as D from './item-delivery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Briques git : commit d’un item, mise de côté, réapplication');
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-idl-'));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: T, encoding: 'utf8' });
  fs.writeFileSync(path.join(T, 'a.txt'), 'a\n'); g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const H = g('rev-parse', 'HEAD').stdout.trim();
  fs.mkdirSync(path.join(T, '.orchestrateur', 'runs', 'r'), { recursive: true });
  fs.writeFileSync(path.join(T, '.orchestrateur', 'runs', 'r', 'x.md'), 'artefact');
  fs.mkdirSync(path.join(T, '.claude')); fs.writeFileSync(path.join(T, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(T, 'item1.txt'), 'item 1\n');
  const c = D.commitWork(T, 'feat(item 1): x');
  const names = g('show', '--name-only', '--format=', 'HEAD').stdout.trim();
  ok(c.ok && c.commit && names === 'item1.txt', `commit de l’item : ses fichiers seulement, jamais .claude/ ni les artefacts (${names})`);
  ok(D.commitWork(T, 'vide').empty === true, 'rien à commiter : pas de commit vide');
  const H1 = g('rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(T, 'item2.txt'), 'item 2\n'); fs.writeFileSync(path.join(T, 'a.txt'), 'a modifié par l’item 2\n');
  // Like the engine: patch and private index live outside the project (logs/runs/<run>/).
  const A = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-idl-aside-'));
  const patchFile = path.join(A, 'aside-item-2.patch');
  const s = D.setAsideWork(T, { from: H1, indexFile: path.join(A, 'idx'), patchFile });
  ok(s.ok && !fs.existsSync(path.join(T, 'item2.txt')) && fs.readFileSync(path.join(T, 'a.txt'), 'utf8') === 'a\n' && fs.existsSync(path.join(T, '.claude', 'settings.json')),
    'mise de côté : le travail de l’item quitte l’arbre (fichier ajouté retiré, fichier modifié remis), .claude/ intact');
  ok(/item2\.txt/.test(fs.readFileSync(patchFile, 'utf8')) && s.files.sort().join(',') === 'a.txt,item2.txt', `correctif gardé, avec la liste des fichiers (${s.files.join(', ')})`);
  fs.writeFileSync(path.join(T, 'item3.txt'), 'item 3\n'); D.commitWork(T, 'feat(item 3): y');
  const ra = D.reapplyWork(T, patchFile);
  ok(ra.ok && fs.readFileSync(path.join(T, 'item2.txt'), 'utf8') === 'item 2\n' && /item 2/.test(fs.readFileSync(path.join(T, 'a.txt'), 'utf8')) && !g('diff', '--cached', '--name-only').stdout.trim(),
    'réapplication après un autre item livré : le travail revient, rien d’indexé');
  // Conflict: the same line changed meanwhile → work tree left as it was.
  const H3 = g('rev-parse', 'HEAD').stdout.trim();
  const s2 = D.setAsideWork(T, { from: H3, indexFile: path.join(A, 'idx'), patchFile });
  fs.writeFileSync(path.join(T, 'a.txt'), 'a changé autrement\n'); D.commitWork(T, 'autre');
  const rc = D.reapplyWork(T, patchFile);
  ok(s2.ok && !rc.ok && rc.conflict && fs.readFileSync(path.join(T, 'a.txt'), 'utf8') === 'a changé autrement\n' && !fs.existsSync(path.join(T, 'item2.txt')),
    'conflit à la réapplication : signalé, l’arbre reste tel qu’il était');
  ok(D.itemCommitMessage({ group: 3, text: '(tests: 1) « lentille » trouve les produits', run: 'p-1', cases: 2 }).startsWith('feat(item 3): « lentille » trouve les produits\n\nIncludes 1 case(s) attached by its review.'),
    'message du commit d’item : numéro et texte de l’item, sans « (tests: N) »');
  void H;
  for (const d of [T, A]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

// ---------------------------------------------------------------------------
// Throwaway root + notification listener (chef)
// ---------------------------------------------------------------------------
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push({ path: req.url, ...JSON.parse(b) }); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-item-delivery-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])),
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const reset = () => { g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur'); };

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_REVIEW_ITEM', 'FAKE_PIPE_REVIEW_LOG', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_BIG', 'FAKE_PIPE_REFACTOR', 'FAKE_PIPE_ITEM_EXTRA_TESTS', 'ORCH_PIPE_REVIEW_ROUNDS', 'ORCH_PIPE_ITEMS']) delete baseEnv[k];
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
  return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run, done: evs.filter(e => e.subtype === 'pipeline_step_done') };
};
const subjects = () => g('log', '--format=%s', `${H0}..HEAD`).stdout.trim().split('\n').filter(Boolean).reverse();
const filesOf = (ref) => g('show', '--name-only', '--format=', ref).stdout.trim().split('\n').filter(Boolean).sort().join(',');
const commitOf = (re) => g('log', '--format=%H %s', `${H0}..HEAD`).stdout.split('\n').find(l => re.test(l))?.split(' ')[0];
const version = () => JSON.parse(fs.readFileSync(path.join(P, 'package.json'), 'utf8')).version;

// ---------------------------------------------------------------------------
section('2. Chaque item relu est livré dans son propre commit, aussitôt après sa Revue ; une seule version en fin d’exécution');
let r = await go(['Ajoute la multiplication par deux, trois et quatre', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '3', FAKE_PIPE_REVIEW_ITEM: '2:1' });
ok(r.code === 0, `exécution terminée (code ${r.code})`, r.out.slice(-1200));
const subj = subjects();
ok(subj.length === 4 && /^feat\(item 1\): multiplier par 2$/.test(subj[0]) && /^feat\(item 2\): multiplier par 3$/.test(subj[1]) && /^feat\(item 4\): multiplier par 4$/.test(subj[2]) && /^feat: double/.test(subj[3]),
  `commits, dans l’ordre : un par item, puis la version (${subj.join(' | ')})`);
ok(filesOf(commitOf(/feat\(item 1\)/)) === 'src/pipe-1.mjs,test/pipe-1.test.mjs', `commit de l’item 1 : ses fichiers seulement (${filesOf(commitOf(/feat\(item 1\)/))})`);
ok(filesOf(commitOf(/feat\(item 2\)/)) === 'src/pipe-2.mjs,src/pipe-3.mjs,test/pipe-2.test.mjs,test/pipe-3.test.mjs' && /Includes 1 case\(s\) attached/.test(g('log', '-1', '--format=%B', commitOf(/feat\(item 2\)/)).stdout),
  'commit de l’item 2 : l’item ET la case que sa Revue lui a rattachée, livrés ensemble une fois relus');
ok(filesOf('HEAD') === 'CHANGELOG.md,docs/USER_REQUIREMENTS.md,package.json' && version() === '1.0.1',
  `commit de version : version (1.0.0 → ${version()}), CHANGELOG et ligne d’exigence seulement — une seule fois pour l’exécution`);
const order = r.evs.filter(e => ['pipeline_item_start', 'pipeline_item_delivered'].includes(e.subtype) || (e.subtype === 'pipeline_step_done' && e.pipeline.step === 'revue'))
  .map(e => e.subtype === 'pipeline_item_start' ? `start${e.pipeline.item}` : e.subtype === 'pipeline_item_delivered' ? `livré${e.pipeline.item}` : `revue${e.pipeline.item}`).join(',');
ok(order === 'start1,revue1,livré1,start2,revue2,start3,revue2,livré2,start4,revue4,livré4', `chaque livraison suit la Revue de son item, avant l’item suivant (${order})`);
ok(!g('status', '--porcelain').stdout.trim() && runState(r.run).delivered.length === 3 && runState(r.run).releases.length === 1, 'arbre propre ; run.json : 3 livraisons, 1 version');
ok(/Livraison par item : item 1 → [0-9a-f]{7} ; item 2 → [0-9a-f]{7} ; item 4 → [0-9a-f]{7}, puis la version \(1\.0\.1/.test(r.evs.find(e => e.type === 'result')?.result || ''), 'le résultat liste les commits de chaque item et la version');
reset();

// ---------------------------------------------------------------------------
section('3. Un item bloqué (revue) est mis de côté : les autres sont livrés ; « continuer » le reprend, puis une nouvelle version');
r = await go(['Ajoute la multiplication par deux, trois et quatre', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '3', FAKE_PIPE_REVIEW_ITEM: '2', ORCH_PIPE_REVIEW_ROUNDS: '1' });
const run3 = r.run;
const lim = r.evs.find(e => e.type === 'notification' && e.subtype === 'pipeline_limit');
const s3 = runState(run3);
ok(r.code === 2 && lim?.limit === 'items_blocked' && s3.aside.length === 1 && s3.aside[0].group === 2, `pause « items_blocked » pour l’item 2 seulement (code ${r.code})`, r.out.slice(-800));
ok(subjects().join(' | ').match(/^feat\(item 1\).* \| feat\(item 4\).* \| feat: double/) && version() === '1.0.1', `les items 1 et 4 sont livrés (et versionnés) malgré l’item 2 bloqué : ${subjects().join(' | ')}`);
ok(!g('status', '--porcelain').stdout.trim() && !fs.existsSync(path.join(P, 'src', 'pipe-2.mjs')), 'le travail de l’item 2 a quitté le projet (arbre propre)');
const patch = fs.readFileSync(path.join(T, s3.aside[0].patch), 'utf8');
ok(/src\/pipe-2\.mjs/.test(patch) && /src\/pipe-3\.mjs/.test(patch) && !/pipe-4/.test(patch), `… et il est gardé dans ${s3.aside[0].patch} (item 2 et sa case rattachée)`);
const res3 = r.evs.find(e => e.type === 'result')?.result || '';
ok(/item 1 « multiplier par 2 » \([0-9a-f]{7}\)/.test(res3) && /l’item 2 « multiplier par 3 » — la relecture trouve encore des défauts/.test(res3) && res3.includes(s3.aside[0].patch),
  'message de pause : ce qui est livré (commits), l’item mis de côté, pourquoi, et où sont ses modifications');
r = await go(['continuer'], { FAKE_PIPE_ITEMS: '3', ORCH_PIPE_REVIEW_ROUNDS: '1' });
ok(r.code === 0 && r.run === run3 && r.evs.some(e => e.subtype === 'pipeline_item_resumed' && e.pipeline.item === 2), `« continuer » : l’item 2 reprend là où il s’était arrêté (code ${r.code})`, r.out.slice(-800));
ok(subjects().slice(-2).map(s => s.slice(0, 12)).join(' | ') === 'feat(item 2) | feat: double' && version() === '1.0.2' && filesOf(commitOf(/feat\(item 2\)/)) === 'src/pipe-2.mjs,src/pipe-3.mjs,test/pipe-2.test.mjs,test/pipe-3.test.mjs',
  `l’item 2 est livré dans son propre commit, puis une nouvelle version (${version()}) : ${subjects().join(' | ')}`);
ok(!g('status', '--porcelain').stdout.trim() && runState(run3).aside.length === 0 && runState(run3).releases.length === 2, 'arbre propre, plus rien de côté, 2 versions');
reset();

// ---------------------------------------------------------------------------
section('4. Un item refusé en 4a (critère) est mis de côté ; le suivant est livré');
r = await go(['Ajoute la multiplication par deux et trois', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_ITEM_EXTRA_TESTS: '2:2' });
const s4 = r.run ? runState(r.run) : {};
ok(r.code === 2 && s4.aside?.[0]?.group === 1 && s4.aside[0].limit === 'criteria' && subjects().map(s => s.slice(0, 12)).join(' | ') === 'feat(item 2) | feat: double',
  `item 1 (trop de tests en 4a, 2 refus) mis de côté, item 2 livré et versionné (${subjects().join(' | ')})`, r.out.slice(-600));
r = await go(['abandonner']);
const res4 = r.evs.find(e => e.type === 'result')?.result || '';
ok(r.code === 0 && /items déjà livrés restent dans leurs commits : item 2 \([0-9a-f]{7}\)/.test(res4) && /aside-item-1\.patch/.test(res4), '« abandonner » : dit ce qui reste livré, et où sont gardées les modifications de l’item mis de côté');
reset();

// ---------------------------------------------------------------------------
section('5. Montée léger → complet : le travail léger puis chaque item, chacun son commit');
r = await go(['Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_BIG: '1', FAKE_PIPE_ITEMS: '1' });
ok(r.code === 0 && subjects().length === 3 && /^feat: work done before switching/.test(subjects()[0]) && /^feat\(item 2\)/.test(subjects()[1]) && /^feat: double/.test(subjects()[2]), `commits : ${subjects().join(' | ')}`, r.out.slice(-600));
reset();

// ---------------------------------------------------------------------------
section('6. Une exécution mise en pause par un moteur antérieur garde son commit unique');
r = await go(['Ajoute beaucoup de choses', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '4', ORCH_PIPE_ITEMS: '3' });
const run6 = r.run;
ok(r.code === 2 && runState(run6).pausedLimit === 'items', 'pause « items » avant le premier item');
// As written by a 0.63.0 engine: no per-item delivery fields, no « @aside » in the plan.
const s6 = runState(run6);
for (const k of ['itemDelivery', 'lastDelivered', 'delivered', 'aside']) delete s6[k];
s6.plan = s6.plan.filter(id => id !== '@aside');
fs.writeFileSync(runFile(run6), JSON.stringify(s6, null, 2));
r = await go(['continuer'], { FAKE_PIPE_ITEMS: '4', ORCH_PIPE_ITEMS: '3' });
ok(r.code === 0 && r.run === run6 && subjects().length === 1 && /^feat: double/.test(subjects()[0]) && !r.evs.some(e => e.subtype === 'pipeline_item_delivered'),
  `reprise : comportement d’origine, un seul commit pour toute l’exécution (${subjects().join(' | ')})`, r.out.slice(-600));
reset();

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
