#!/usr/bin/env node
// ============================================================================
// scripts/_test_item_review.mjs — per-item Review of the full Development (0.63.0)
// ============================================================================
//
// User decision (2026-10-10), verbatim: « c+d » — option c = « Livraison par
// item : chaque item est relu et livré séparément, dans son propre commit. Un
// défaut ne bloque que son item » (« si plusieurs demandent plus de 2 tests, ça
// n'impliquera pas les autres »). Atomic task 3 = the Review only.
//
// Protected:
//   - the Review of an item sees ONLY the diff of that item (its 4a/4b/4c and
//     the cases attached to it), right after its loop — never the whole run;
//   - a defect becomes a case attached to THAT item, handled before the next
//     items; the other items are never re-reviewed because of it;
//   - the review rounds limit is counted per item (2 rounds, then pause).
//
// Real dispatch.mjs, real engine, fake claude (FAKE_CLAUDE_PIPELINE), throwaway
// root; notifications go to a local listener (never 7777).
//
//   node scripts/_test_item_review.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as IR from './item-review.mjs';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Briques : groupes d’items, cases rattachées, diff d’un item');
{
  const md = '# Liste\n\n- [x] (tests: 1) a\n- [ ] (tests: 1) b\n- [ ] (tests: 1) c\n';
  const m1 = IR.insertAttachedCases(md, 2, ['(tests: 1) défaut de b']);
  const it1 = E.parseItems(m1);
  ok(it1.map(i => i.text).join(' | ') === '(tests: 1) a | (tests: 1) b | (revue item 2) (tests: 1) défaut de b | (tests: 1) c',
    'le défaut de l’item 2 est inséré juste après l’item 2 (avant les items suivants)');
  ok(IR.groupOf(it1[2]) === 2 && IR.groupOf(it1[3]) === 4 && it1[2].declared === 1, 'la case rattachée appartient au groupe de l’item 2, garde sa déclaration (tests: N) ; les autres items gardent le leur');
  const m2 = IR.insertAttachedCases(m1, 2, ['(tests: 1) second défaut']);
  ok(E.parseItems(m2)[3].text === '(revue item 2) (tests: 1) second défaut' && E.parseItems(m2)[4].text === '(tests: 1) c', 'un 2ᵉ tour : inséré après la dernière case du groupe');
  ok(!IR.groupReady(E.parseItems(m2), 2) && IR.groupReady(E.parseItems(m2), 1), 'le groupe 2 a des cases ouvertes (pas encore relu) ; le groupe 1 est prêt');
  const m0 = IR.insertAttachedCases(md, 0, ['(tests: 1) défaut du travail léger']);
  ok(E.parseItems(m0)[1].text === '(revue item 0) (tests: 1) défaut du travail léger', 'groupe 0 (travail léger avant la montée) : avant la première case ouverte');

  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ir-'));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: T, encoding: 'utf8' });
  fs.writeFileSync(path.join(T, 'a.txt'), 'a\n'); g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(T, '.orchestrateur', 'runs', 'r'), { recursive: true });
  const idx = path.join(T, 'idx', 'tree.idx');
  fs.writeFileSync(path.join(T, 'item1.txt'), 'item 1\n');
  const start2 = IR.worktreeTree(T, idx);
  fs.writeFileSync(path.join(T, 'item2.txt'), 'item 2\n');
  fs.writeFileSync(path.join(T, 'a.txt'), 'a modifié par l’item 2\n');
  fs.writeFileSync(path.join(T, '.orchestrateur', 'runs', 'r', 'revue.json'), '{}');
  const d2 = IR.treeDiff(T, start2, IR.worktreeTree(T, idx));
  ok(/item2\.txt/.test(d2) && /a modifié par l’item 2/.test(d2) && !/item1\.txt/.test(d2), 'diff de l’item 2 : ses fichiers (nouveaux et modifiés), rien de l’item 1');
  ok(!/\.orchestrateur/.test(d2), 'les artefacts d’exécution n’entrent pas dans le diff');
  ok(g('status', '--porcelain').stdout.includes('?? item1.txt') && !g('diff', '--cached', '--name-only').stdout.trim(), 'l’index git du projet n’est pas touché (index privé)');
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Throwaway root + notification listener (chef)
// ---------------------------------------------------------------------------
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push({ path: req.url, ...JSON.parse(b) }); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-item-review-'));
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
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const reset = () => { g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur'); };

const REVLOG = path.join(T, 'reviews.ndjson');
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', FAKE_PIPE_REVIEW_LOG: REVLOG };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_REVIEW_ITEM', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_BIG', 'FAKE_PIPE_REFACTOR', 'ORCH_PIPE_REVIEW_ROUNDS', 'ORCH_PIPE_ITEMS']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const reviews = () => { try { return fs.readFileSync(REVLOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const go = async (args, env) => {
  try { fs.unlinkSync(REVLOG); } catch {}
  const n0 = logOf().length;
  const r = await dispatch(args, env);
  const evs = logOf().slice(n0);
  return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run, done: evs.filter(e => e.subtype === 'pipeline_step_done'), reviews: reviews() };
};
const seq = (done) => done.map(d => `${d.pipeline.step}${d.status === 'ok' ? '' : `:${d.status}`}`).join(',');
const files = (diff) => [...new Set([...String(diff).matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]))].sort().join(',');

// ---------------------------------------------------------------------------
section('2. Chaque item est relu juste après sa boucle, sur SON diff ; un défaut de l’item 2 ne relance pas la revue des autres');
let r = await go(['Ajoute la multiplication par deux, trois et quatre', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '3', FAKE_PIPE_REVIEW_ITEM: '2:1' });
ok(r.code === 0, `exécution terminée (code ${r.code})`, r.out.slice(-1200));
ok(seq(r.done) === 'comprendre,concevoir,liste-tests,rouge,vert,refactor:skipped,revue,rouge,vert,refactor:skipped,revue,rouge,vert,refactor:skipped,revue,rouge,vert,refactor:skipped,revue,livrer',
  `enchaînement : la Revue suit chaque item, plus de Revue de toute l’exécution (${seq(r.done)})`);
ok(r.reviews.map(x => x.item).join(',') === '1,2,2,4', `items relus, dans l’ordre : ${r.reviews.map(x => x.item).join(',')} (l’item 2 relu deux fois, les autres une seule)`);
const [rv1, rv2, rv2b, rv4] = r.reviews;
ok(files(rv1?.diff) === 'src/pipe-1.mjs,test/pipe-1.test.mjs', `revue de l’item 1 : son diff seulement (${files(rv1?.diff)})`);
ok(files(rv2?.diff) === 'src/pipe-2.mjs,test/pipe-2.test.mjs', `revue de l’item 2 : son diff seulement, rien de l’item 1 (${files(rv2?.diff)})`);
ok(files(rv2b?.diff) === 'src/pipe-2.mjs,src/pipe-3.mjs,test/pipe-2.test.mjs,test/pipe-3.test.mjs', `2ᵉ revue de l’item 2 : l’item et la case qui lui est rattachée (${files(rv2b?.diff)})`);
ok(files(rv4?.diff) === 'src/pipe-4.mjs,test/pipe-4.test.mjs', `revue de l’item suivant : son diff seulement, ni l’item 2 ni sa correction (${files(rv4?.diff)})`);
const tm = E.parseItems(fs.readFileSync(path.join(P, '.orchestrateur', 'runs', r.run, 'tests.md'), 'utf8'));
ok(tm[2]?.text.startsWith('(revue item 2) (tests: 1) défaut relevé sur l’item 2') && tm.every(i => i.done), `tests.md : le défaut est une case rattachée à l’item 2, placée juste après lui, puis cochée (${tm.map(i => i.text.slice(0, 22)).join(' | ')})`);
const loop = r.evs.find(e => e.subtype === 'pipeline_loop');
ok(loop?.pipeline?.item === 2 && loop.pipeline.round === 1 && /rattachée\(s\) à cet item seulement/.test(loop.text), `événement : « ${loop?.text} »`);
ok(r.done.filter(d => d.pipeline.step === 'revue').map(d => d.pipeline.item).join(',') === '1,2,2,4', 'frise : chaque Revue porte le numéro de l’item relu');
ok(JSON.stringify(runState(r.run).itemReviewRounds) === '{"2":1}', `compteur de tours de revue par item : ${JSON.stringify(runState(r.run).itemReviewRounds)}`);
ok(r.evs.find(e => e.type === 'user_prompt')?.pipeline?.steps.some(s => s.loop && s.id === 'revue'), 'frise annoncée : la Revue fait partie de la boucle de chaque item');
ok(g('rev-list', '--count', `${H0}..HEAD`).stdout.trim() === '4', 'livraison par item (0.64.0) : un commit par item relu (1, 2 avec sa correction, 4), puis la version');
reset();

// ---------------------------------------------------------------------------
section('3. La limite de tours de revue est comptée PAR ITEM');
// The case attached to item 1 takes position 2: the second item of the list is then n° 3.
r = await go(['Ajoute la multiplication par deux et trois', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_REVIEW_ITEM: '1:1,3:1', ORCH_PIPE_REVIEW_ROUNDS: '1' });
ok(r.code === 0 && !r.evs.some(e => e.subtype === 'pipeline_limit') && r.reviews.map(x => x.item).join(',') === '1,1,3,3', `1 tour permis, un défaut sur le premier item ET un sur le second : aucune pause (code ${r.code}, revues ${r.reviews.map(x => x.item).join(',')}) — un compteur global aurait arrêté au second`, r.out.slice(-600));
ok(JSON.stringify(runState(r.run).itemReviewRounds) === '{"1":1,"3":1}', `un tour pour chacun : ${JSON.stringify(runState(r.run).itemReviewRounds)}`);
reset();
r = await go(['Ajoute la multiplication par deux, trois et quatre', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '3', FAKE_PIPE_REVIEW_ITEM: '2', ORCH_PIPE_REVIEW_ROUNDS: '1' });
const lim = r.evs.find(e => e.type === 'notification' && e.subtype === 'pipeline_limit');
// 0.64.0 (per-item delivery): item 2 is set aside, the next item goes on, then the pause names item 2.
const aside3 = r.run ? runState(r.run).aside : [];
ok(r.code === 2 && lim?.limit === 'items_blocked' && aside3?.length === 1 && aside3[0].group === 2 && aside3[0].limit === 'review' && /item 2/.test(aside3[0].why || ''), `l’item 2 garde son défaut après son tour : mis de côté, pause qui nomme l’item (${String(aside3?.[0]?.why).slice(0, 100)})`, r.out.slice(-600));
ok(r.reviews.map(x => x.item).join(',') === '1,2,2,4', `l’item 1 n’a été relu qu’une fois ; l’item suivant a continué, relu une fois (${r.reviews.map(x => x.item).join(',')})`);
const run3 = r.run;
r = await go(['continuer'], { FAKE_PIPE_ITEMS: '3', ORCH_PIPE_REVIEW_ROUNDS: '1' });
const ext = r.evs.find(e => e.subtype === 'pipeline_limit_extended');
ok(r.code === 0 && r.run === run3 && ext?.limit === 'items_blocked' && JSON.stringify(runState(run3).itemReviewBudgets) === '{"2":2}', `« continuer » : un tour de plus pour l’item 2 seulement (« ${ext?.text} »), puis la suite`, r.out.slice(-600));
ok(r.reviews.map(x => x.item).join(',') === '2', `après la reprise : seul l’item 2 est relu, l’item suivant est déjà livré (${r.reviews.map(x => x.item).join(',')})`);
reset();

// ---------------------------------------------------------------------------
section('4. Montée léger → complet : le travail léger est relu seul, puis chaque item');
r = await go(['Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_BIG: '1', FAKE_PIPE_ITEMS: '1' });
ok(r.code === 0 && r.evs.some(e => e.subtype === 'pipeline_escalate') && r.reviews.map(x => x.item).join(',') === '0,2', `revues : le travail léger (0), puis l’item de la liste (${r.reviews.map(x => x.item).join(',')})`, r.out.slice(-600));
ok(files(r.reviews[0]?.diff) === 'src/extra-1.mjs,src/extra-2.mjs,src/extra-3.mjs,src/extra-4.mjs,src/pipe.mjs,test/pipe.test.mjs' && files(r.reviews[1]?.diff) === 'src/pipe-2.mjs,test/pipe-2.test.mjs',
  `chacun sur son diff (léger : ${files(r.reviews[0]?.diff)} ; item : ${files(r.reviews[1]?.diff)})`);
reset();

srv.close();
if (!process.env.KEEP) { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log("kept", T);
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
