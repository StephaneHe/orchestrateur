#!/usr/bin/env node
// ============================================================================
// scripts/_test_pipeline_speed.mjs — « vitesse » levers of the full Development (0.143.0)
// ============================================================================
//
// User's agreement (2026-10-23), verbatim: « ok » — to the chef's proposal to
// speed up the pipelines, measured on six real Development runs of one project
// (304 calls, 319 min of model time, 27 refusals). Six levers, each behind its
// own switch, frozen per run; off = the behaviour before 0.143.0:
//
//   0. switches, values, pure helpers (tolerance, attribution, prefix, targeted
//      selection, reuse, unfold), pipeline-enforce.mjs tuning-values
//   1. limits        — 25 tests / 150 min set hot, frozen per run
//   2. extraTests    — « N declared, N+1 written » accepted when in the same file
//   3. redGreen      — test + code in one call, red proven by the program
//   4. groupReview   — one Review for up to 3 items, a defect sends back its item only
//   5. reuseContext  — Understand + Design reused from the cited previous run
//   6. targetedTests — targeted tests at each TDD step, the full suite at Livrer
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_pipeline_speed.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as S from './pipeline-speed.mjs';
import { TUNING_LEVERS, runTuning, runTuningValues, readTuningValues, parseValueArgs, VALUE_DEFAULTS, cleanValues } from './pipeline-tuning.mjs';
import { isTestFile, unfoldBatch } from './pipeline-engine.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
// Diagnosis only: SPEED_ONLY=4,5 runs these sections; SPEED_KEEP=1 keeps the throwaway root.
const ONLY = process.env.SPEED_ONLY ? process.env.SPEED_ONLY.split(',') : null;
const want = (n) => !ONLY || ONLY.includes(String(n));
const LEVERS = ['limits', 'redGreen', 'groupReview', 'reuseContext', 'targetedTests', 'extraTests'];
const gitIn = (cwd) => (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });

// ---------------------------------------------------------------------------
section('0. Interrupteurs, valeurs et briques');
{
  ok(LEVERS.every(l => l in TUNING_LEVERS), `six interrupteurs : ${LEVERS.join(', ')}`);
  const T0 = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-speed-t-'));
  const t = runTuning({}, T0, 'P');
  ok(LEVERS.every(l => t[l] === false), 'absents de model-routing.json : coupés (comportement de 0.142.0)');
  ok(VALUE_DEFAULTS.items === 25 && VALUE_DEFAULTS.runMin === 150 && VALUE_DEFAULTS.reviewBatch === 3 && VALUE_DEFAULTS.redGreenMaxTests === 2, 'valeurs par défaut : 25 tests, 150 min, relecture par 3, test + code en un appel jusqu’à 2 tests');
  const st = {};
  fs.writeFileSync(path.join(T0, 'model-routing.json'), JSON.stringify({ enforcement: { tuningValues: { items: 30, runMin: 9999, reviewBatch: 7 } } }));
  const v = runTuningValues(st, T0);
  ok(v.items === 30 && v.runMin === 150 && v.reviewBatch === 3 && st.tuningValues.items === 30, 'valeurs relues et figées dans l’exécution ; hors bornes ignorées (runMin 9999, reviewBatch 7)');
  fs.writeFileSync(path.join(T0, 'model-routing.json'), JSON.stringify({ enforcement: { tuningValues: { items: 40 } } }));
  ok(runTuningValues(st, T0).items === 30 && runTuningValues({}, T0, { resumed: true }).items === 25, 'figées : une valeur changée ensuite ne touche pas l’exécution ; une reprise d’avant 0.143.0 garde les défauts');
  let threw = null; try { parseValueArgs(['--items', '0']); } catch (e) { threw = e.message; }
  ok(/1 à 60/.test(threw || '') && parseValueArgs(['--items', '25', '--run-min', '150']).runMin === 150 && cleanValues({ redGreenMaxTests: 3 }).redGreenMaxTests === undefined, 'options validées (bornes dites en français)');
  // pipeline-enforce.mjs tuning-values, off --all.
  fs.writeFileSync(path.join(T0, 'config.json'), JSON.stringify({ projects: [{ name: 'P', path: T0 }] }));
  fs.writeFileSync(path.join(T0, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] } }));
  const pe = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline-enforce.mjs'), ...a], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: T0 }, encoding: 'utf8' });
  let r = pe('tuning-values', '--items', '30', '--run-min', '120');
  ok(r.status === 0 && readTuningValues(T0).items === 30 && readTuningValues(T0).runMin === 120 && /items = 30/.test(r.stdout), 'tuning-values --items 30 --run-min 120 : écrit, relu', r.stderr);
  r = pe('tuning', 'limits', 'on', 'P');
  ok(r.status === 0 && readTuningValues(T0).items === 30, 'un changement d’interrupteur garde les valeurs');
  r = pe('tuning-values', '--review-batch', '9');
  ok(r.status === 64 && /2 à 3/.test(r.stderr), 'valeur hors bornes refusée (64)');
  r = pe('off', '--all');
  ok(r.status === 0 && readTuningValues(T0).items === 25 && !JSON.parse(fs.readFileSync(path.join(T0, 'model-routing.json'), 'utf8')).enforcement.tuningValues, 'off --all : valeurs remises aux défauts');
  fs.rmSync(T0, { recursive: true, force: true });

  // extraTests
  const v1 = { ok: false, checked: true, declared: 1, written: 2, added: { total: 2, perFile: { 'test/a.test.mjs': 2 } } };
  ok(S.toleratedExtra(v1)?.file === 'test/a.test.mjs', 'N+1 dans le même fichier : toléré');
  ok(!S.toleratedExtra({ ...v1, written: 3, added: { perFile: { 'test/a.test.mjs': 3 } } }) && !S.toleratedExtra({ ...v1, added: { perFile: { 'test/a.test.mjs': 1, 'test/b.test.mjs': 1 } } }) && !S.toleratedExtra({ ...v1, ok: true }),
    'N+2, ou le test en plus dans un autre fichier : refus maintenu');
  // grouped Review
  const a = S.attributeFindings(JSON.stringify({ verdict: 'problèmes', items: [{ item: 2, text: 'x', tests: 1 }], hors_tdd: [{ item: 3, text: 'doc' }] }), [1, 2, 3]);
  ok(a.ok && a.byItem[2].items[0] === '(tests: 1) x' && a.byItem[3].fixes[0] === 'doc' && !a.byItem[1].items.length, 'relecture groupée : chaque constat rangé sous son item');
  ok(!S.attributeFindings(JSON.stringify({ verdict: 'problèmes', items: ['sans item'] }), [1, 2]).ok && S.attributeFindings(JSON.stringify({ verdict: 'problèmes', items: ['sans item'] }), [4]).byItem[4].items.length === 1,
    'constat sans item refusé pour un lot de plusieurs items ; accepté pour un lot d’un seul');
  const seq = [{ commit: 'c1', group: 1 }, { commit: 'c2', group: 2 }, { commit: 'c3', group: 3 }, { commit: 'c4', group: 2 }];
  ok(S.deliverablePrefix(seq, new Set([1, 3]))?.commit === 'c1' && S.deliverablePrefix(seq, new Set([1, 3]))?.groups.join() === '1', 'défaut sur l’item 2 : seul l’item 1 (avant lui) est livrable');
  ok(S.deliverablePrefix(seq, new Set([1, 2, 3]))?.commit === 'c4' && S.deliverablePrefix(seq, new Set([1, 2, 3])).groups.join() === '1,2,3' && !S.deliverablePrefix(seq, new Set([2, 3])), 'item 2 corrigé et relu : tout le lot livré ; l’item 1 non relu : rien');

  // targeted selection and reuse on a small repository
  const G = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-speed-g-'));
  const g = gitIn(G);
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(G, f)), { recursive: true }); fs.writeFileSync(path.join(G, f), s); };
  w('package.json', JSON.stringify({ name: 'g', type: 'module', scripts: { test: 'node --import ./x.mjs --test' } }));
  w('src/a.mjs', "import { b } from './b.mjs';\nexport const a = () => b();\n");
  w('src/b.mjs', 'export const b = () => 1;\n');
  w('src/c.mjs', 'export const c = 3;\n');
  w('page.html', '<p>x</p>\n');
  w('test/a.test.mjs', "import { test } from 'node:test';\nimport { a } from '../src/a.mjs';\ntest('a', () => a());\n");
  w('test/page.test.mjs', "import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('page', () => fs.readFileSync('page.html'));\n");
  w('test/fixtures/helper.mjs', 'export const h = 1;\n');
  w('docs/USER_REQUIREMENTS.md', '| 2026 | page | test/page.test.mjs | 1 |\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'i');
  const H = g('rev-parse', 'HEAD').stdout.trim();
  const cfg = { testCommand: 'npm test', testGlobs: ['test/**'], requirements: 'docs/USER_REQUIREMENTS.md' };
  const isT = (f) => isTestFile(f, cfg.testGlobs);
  ok(S.runnableTests(G, isT).join() === 'test/a.test.mjs,test/page.test.mjs', 'tests lancés : sous les motifs de test ET déclarant un test (pas les fixtures)');
  w('src/b.mjs', 'export const b = () => 2;\n');
  let sel = S.selectTargetedTests({ cwd: G, cfg, from: H, isTest: isT });
  ok(sel.targeted && sel.files.join() === 'test/a.test.mjs' && /importe src\/b\.mjs/.test(sel.reasons['test/a.test.mjs']) && sel.command === 'node --import ./x.mjs --test test/a.test.mjs',
    `src/b.mjs modifié : le test qui l’importe (par src/a.mjs) seulement — « ${sel.command} »`, JSON.stringify(sel));
  w('page.html', '<p>y</p>\n');
  sel = S.selectTargetedTests({ cwd: G, cfg, from: H, isTest: isT });
  ok(sel.targeted && sel.files.join() === 'test/a.test.mjs,test/page.test.mjs' && sel.requirement.join() === 'test/page.test.mjs', 'page.html modifié : le test qui la nomme, compté comme test d’exigence');
  w('src/c.mjs', 'export const c = 4;\n');
  sel = S.selectTargetedTests({ cwd: G, cfg, from: H, isTest: isT });
  ok(!sel.targeted && /couvert par aucun test : src\/c\.mjs/.test(sel.why), 'fichier couvert par aucun test : suite complète, dit');
  g('checkout', '-q', '--', 'src/c.mjs');
  ok(!S.selectTargetedTests({ cwd: G, cfg: { ...cfg, testCommand: 'pytest' }, from: H, isTest: isT }).targeted, 'commande inconnue (pytest sans targetedTestCommand) : suite complète');
  ok(S.selectTargetedTests({ cwd: G, cfg: { ...cfg, testCommand: 'pytest', targetedTestCommand: 'pytest {files}' }, from: H, isTest: isT }).command === 'pytest test/a.test.mjs test/page.test.mjs', 'targetedTestCommand déclarée : {files} remplacé');
  g('checkout', '-q', '--', '.');
  // reuse: divergence
  w('CHANGELOG.md', '# c\n'); g('add', '-A'); g('commit', '-q', '-m', 'doc');
  const H2 = g('rev-parse', 'HEAD').stdout.trim();
  ok(S.divergence(G, cfg, H, H2) === null, 'seule la doc a changé depuis la fin de l’exécution précédente : pas de divergence');
  w('src/c.mjs', 'export const c = 5;\n'); g('add', '-A'); g('commit', '-q', '-m', 'code');
  ok(/src\/c\.mjs/.test(S.divergence(G, cfg, H, g('rev-parse', 'HEAD').stdout.trim()) || ''), 'du code a changé : divergence, nommée');
  ok(S.citedRuns('suite de p-20261022T235654-f8aa6c puis p-20261023T011506-ef29a5')[0] === 'p-20261023T011506-ef29a5', 'exécutions citées : identifiants seulement, la plus récente d’abord');
  // unfold: provisional commits back to the work tree
  w('src/d.mjs', 'export const d = 1;\n'); g('add', '-A'); g('commit', '-q', '-m', 'provisoire');
  const HP = g('rev-parse', 'HEAD').stdout.trim();
  const state = { base: H, lastDelivered: H2, batch: { seq: [{ commit: HP, group: 1 }], groups: [1], reviewed: [] } };
  ok(unfoldBatch(G, state) && g('rev-parse', 'HEAD').stdout.trim() === H2 && /src\/d\.mjs/.test(g('status', '--porcelain').stdout) && state.batch.folded,
    'abandon : les commits provisoires non relus redeviennent des modifications non commitées (rien de non relu ne reste commité)');
  fs.rmSync(G, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Throwaway root + notification listener (chef)
// ---------------------------------------------------------------------------
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push(JSON.parse(b)); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-speed-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
const routing = (tuning, tuningValues = null, idle = false) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'], ...(tuning ? { tuning } : {}), ...(tuningValues ? { tuningValues } : {}) },
  ...(idle ? { idleRegression: { enabled: true } } : {}),
}));
const g = gitIn(P);
const MARK = path.join(T, 'suite-runs.txt');
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
// Counts every run of the project's whole suite (it imports nothing an item changes).
fs.writeFileSync(path.join(P, 'test', 'marker.test.mjs'), "import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('marker', () => { if (process.env.SPEED_MARKER) fs.appendFileSync(process.env.SPEED_MARKER, 'x'); });\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const reset = () => { g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur'); try { fs.rmSync(MARK, { force: true }); } catch {} };

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', SPEED_MARKER: MARK };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_REVIEW_ITEM', 'FAKE_PIPE_REVIEW_DOC_ITEM', 'FAKE_PIPE_REVIEW_LOG', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_BIG', 'FAKE_PIPE_REFACTOR', 'FAKE_PIPE_ITEM_EXTRA_TESTS',
  'FAKE_PIPE_TEST_WRONG', 'FAKE_PIPE_HEADER', 'FAKE_PIPE_REQ_ROW', 'FAKE_PIPE_COVERED', 'ORCH_PIPE_REVIEW_ROUNDS', 'ORCH_PIPE_ITEMS', 'ORCH_PIPE_RUN_MS', 'FAKE_PIPE_RG_NOFAIL', 'FAKE_PIPE_REVIEW_UNNAMED']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 300_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const go = async (args, env) => {
  const n0 = logOf().length;
  const r = await dispatch(args, env);
  const evs = logOf().slice(n0);
  return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run, limit: evs.find(e => e.type === 'notification' && e.subtype === 'pipeline_limit')?.limit || null };
};
const calls = (st) => st.steps.filter(x => x.source !== 'code' && x.status !== 'skipped').length;
const ids = (st) => st.steps.filter(x => x.status !== 'skipped').map(x => x.id);
const delivered = (run) => (runState(run).delivered || []).map(d => d.group).sort((a, b) => a - b).join(',');
const marks = () => { try { return fs.readFileSync(MARK, 'utf8').length; } catch { return 0; } };
const REQ = (n) => [`Ajoute ${n} multiplication(s)`, '--pipeline', 'dev', '--mode', 'complet'];

// ---------------------------------------------------------------------------
let r, s;
if (want(1)) {
section('1. limits — limites réglables à chaud, figées par exécution');
routing(null);
r = await go(REQ(4), { FAKE_PIPE_ITEMS: '4', ORCH_PIPE_ITEMS: '3' });
ok(r.code === 2 && r.limit === 'items', `coupé : 4 tests listés pour un maximum de 3 → pause « découper » (${r.limit})`, r.out.slice(-600));
await go(['abandonner']);
reset();
routing({ limits: true }, { items: 4, runMin: 150 });
r = await go(REQ(4), { FAKE_PIPE_ITEMS: '4', ORCH_PIPE_ITEMS: '3' });
s = r.run ? runState(r.run) : {};
ok(r.code === 0 && s.status === 'done' && s.itemsDone === 4 && s.tuningValues?.items === 4 && s.tuningValues?.runMin === 150, `allumé (tuning-values --items 4) : les 4 tests faits, valeurs figées dans run.json (${JSON.stringify(s.tuningValues)})`, r.out.slice(-600));
ok(r.evs.some(e => e.subtype === 'pipeline_tuning' && /limites 4 tests et 150 min/.test(e.text)), 'les limites de l’exécution sont dites au départ');
reset();

}

if (want(2)) {
// ---------------------------------------------------------------------------
section('2. extraTests — un test de plus, dans le même fichier');
routing(null);
r = await go(REQ(1), { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_ITEM_EXTRA_TESTS: '1:1' });
s = r.run ? runState(r.run) : {};
ok(s.steps?.some(x => x.id === 'rouge' && x.status === 'refused' && /annonçait 1 test/.test(x.why)), 'coupé : « 1 annoncé, 2 écrits » refusé à 4a (un essai de plus)', JSON.stringify(s.steps?.map(x => `${x.id}:${x.status}`)));
reset();
routing({ extraTests: true });
r = await go(REQ(1), { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_ITEM_EXTRA_TESTS: '1:1' });
s = r.run ? runState(r.run) : {};
const tol = r.evs.find(e => e.subtype === 'pipeline_item_tests_tolerated');
const done1 = r.evs.find(e => e.subtype === 'pipeline_item_done');
ok(r.code === 0 && !s.steps.some(x => x.status === 'refused') && tol?.file === 'test/pipe-1.test.mjs' && done1?.tests?.tolerated === 'test/pipe-1.test.mjs',
  `allumé : accepté du premier coup, noté (« ${tol?.text || '—'} »)`, r.out.slice(-600));
reset();

}

if (want(3)) {
// ---------------------------------------------------------------------------
section('3. redGreen — test + code en un appel, rouge prouvé par le programme');
routing(null);
r = await go(REQ(2), { FAKE_PIPE_ITEMS: '2' });
s = r.run ? runState(r.run) : {};
const offCalls = calls(s);
ok(r.code === 0 && ids(s).filter(x => x === 'rouge').length === 2 && ids(s).filter(x => x === 'vert').length === 2 && !ids(s).includes('rouge-vert'), `coupé : 4a puis 4b pour chaque item (${ids(s).join(' → ')})`);
reset();
routing({ redGreen: true });
r = await go(REQ(2), { FAKE_PIPE_ITEMS: '2' });
s = r.run ? runState(r.run) : {};
const proofs = r.evs.filter(e => e.subtype === 'pipeline_red_proof');
const proofFile = proofs[0] ? path.join(T, proofs[0].red.file) : null;
ok(r.code === 0 && ids(s).filter(x => x === 'rouge-vert').length === 2 && !ids(s).includes('rouge') && !ids(s).includes('vert'), `allumé : un appel par item (${ids(s).join(' → ')})`, r.out.slice(-800));
ok(proofs.length === 2 && proofFile && fs.existsSync(proofFile) && /pipe-1|pipe item 1/.test(fs.readFileSync(proofFile, 'utf8')) && proofs[0].red.code !== 0,
  'preuve du rouge gardée par le programme : sortie de la suite lancée sans le code, en échec sur le nouveau test', proofFile);
ok(calls(s) === offCalls - 2, `${offCalls - calls(s)} appels de moins pour 2 items (${offCalls} → ${calls(s)})`);
ok(fs.existsSync(path.join(P, 'src', 'pipe-1.mjs')) && fs.existsSync(path.join(P, 'test', 'pipe-1.test.mjs')), 'le code et le test de l’étape restent en place après la preuve');
reset();
r = await go(REQ(2), { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_RG_NOFAIL: '2' });
s = r.run ? runState(r.run) : {};
const fb = r.evs.find(e => e.subtype === 'pipeline_redgreen_fallback');
ok(r.code === 0 && fb?.pipeline.item === 2 && /passe sans le code/.test(fb.why) && /rouge-vert:refused,rouge:ok,vert:ok/.test(s.steps.filter(x => x.item === 2).map(x => `${x.id}:${x.status}`).join(',')),
  'test qui passe sans le code : refusé par la preuve, l’item repasse par 4a puis 4b (aucun défaut, aucune pause)', JSON.stringify(fb || {}));
ok(!r.evs.some(e => e.subtype === 'pipeline_defect' && e.pipeline?.step === 'rouge-vert'), 'le refus de l’appel combiné n’est pas un défaut signalé au chef');
reset();

}

if (want(4)) {
// ---------------------------------------------------------------------------
section('4. groupReview — une relecture pour 3 items, un défaut ne reprend que son item');
const RLOG = path.join(T, 'reviews.ndjson');
const reviews = () => { try { return fs.readFileSync(RLOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
routing(null);
r = await go(REQ(4), { FAKE_PIPE_ITEMS: '4', FAKE_PIPE_REVIEW_LOG: RLOG });
ok(r.code === 0 && reviews().length === 4 && reviews().every(x => x.item != null), `coupé : une relecture par item (${reviews().length})`);
reset(); fs.rmSync(RLOG, { force: true });
routing({ groupReview: true });
r = await go(REQ(4), { FAKE_PIPE_ITEMS: '4', FAKE_PIPE_REVIEW_LOG: RLOG, FAKE_PIPE_REVIEW_ITEM: '2:1' });
s = r.run ? runState(r.run) : {};
const rv = reviews().map(x => (x.items || [x.item]).join('+'));
ok(r.code === 0 && rv.join(' | ') === '1+2+3 | 2 | 5', `allumé : relectures ${rv.join(' | ')} (lot de 3 ; item 2 seul relu après sa case rattachée, insérée après les items déjà faits ; le 4e item, devenu n° 5, en fin de liste)`, r.out.slice(-800));
const dl = r.evs.filter(e => e.subtype === 'pipeline_item_delivered').map(e => e.pipeline.item);
ok(dl.join() === '1,2,3,5' && delivered(r.run) === '1,2,3,5', `l’item 1 livré tout de suite, 2 et 3 après la correction de 2, puis le dernier (${dl.join(', ')})`);
const subjects = g('log', '--format=%s', `${H0}..HEAD`).stdout.trim().split('\n');
ok(['item 1', 'item 2', 'item 3', 'item 5'].every(i => subjects.some(x => x.includes(`(${i})`))) && subjects.some(x => /fix\(items 2\)/.test(x) || /revue item 2|\(item 2\)/.test(x)),
  `un commit par item, plus la correction de l’item 2 (${subjects.length} commits)`, subjects.join(' / '));
ok(s.itemReviewRounds?.[2] === 1 && !s.itemReviewRounds?.[1] && !s.itemReviewRounds?.[3], 'tours de relecture comptés pour l’item 2 seulement');
reset(); fs.rmSync(RLOG, { force: true });
r = await go(REQ(3), { FAKE_PIPE_ITEMS: '3', FAKE_PIPE_REVIEW_UNNAMED: '1:1' });
s = r.run ? runState(r.run) : {};
ok(r.code === 0 && s.steps.some(x => x.id === 'revue' && x.status === 'refused' && /doit nommer son item/.test(x.why)), 'constat sans item dans un lot : refusé, la relecture le redonne avec son item');
reset();
// Review limit inside a batch: the item and those committed on top of it go aside together.
r = await go(REQ(3), { FAKE_PIPE_ITEMS: '3', FAKE_PIPE_REVIEW_ITEM: '2:2', ORCH_PIPE_REVIEW_ROUNDS: '1' });
s = r.run ? runState(r.run) : {};
const aside = s.aside || [];
ok(r.code === 2 && r.limit === 'items_blocked' && delivered(r.run) === '1' && aside.length === 1 && aside[0].group === 2 && aside[0].batch?.join() === '2,3' && /avec l’item 3/.test(aside[0].text),
  `limite de relecture de l’item 2 : mis de côté avec l’item 3 qui repose dessus (nommé) ; l’item 1 livré (${delivered(r.run)})`, JSON.stringify(aside.map(a => ({ g: a.group, b: a.batch }))));
ok(g('rev-parse', 'HEAD').stdout.trim() === s.lastDelivered, 'aucun commit non relu ne reste au-dessus du dernier livré');
r = await go(['continuer']);
s = runState(s.run);
ok(r.code === 0 && s.status === 'done' && delivered(s.run) === '1,2,3', `« continuer » : le lot remis, relu ensemble, livré (${delivered(s.run)})`, r.out.slice(-800));
reset();

}

if (want(5)) {
// ---------------------------------------------------------------------------
section('5. reuseContext — compréhension et plan repris de l’exécution citée');
routing({ reuseContext: true });
r = await go(REQ(1), { FAKE_PIPE_ITEMS: '1' });
const runA = r.run;
ok(r.code === 0 && ids(runState(runA)).includes('comprendre'), 'exécution A : Comprendre et Concevoir faits');
// The fake writes the same test for item 1: in the next runs it is « already covered » (a test that changes).
r = await go([`Suite de ${runA} : ajoute la multiplication restante`, '--pipeline', 'dev', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_COVERED: '1' });
s = r.run ? runState(r.run) : {};
const reused = r.evs.find(e => e.subtype === 'pipeline_context_reused');
const comp = fs.readFileSync(path.join(P, '.orchestrateur', 'runs', r.run, 'comprehension.md'), 'utf8');
ok(r.code === 0 && reused?.from === runA && !ids(s).includes('comprendre') && !ids(s).includes('concevoir') && s.steps.filter(x => x.reused === runA).length === 2,
  `exécution B (« suite de ${runA} ») : Comprendre et Concevoir repris, sautés en le disant`, r.out.slice(-600));
ok(/Repris de l’exécution/.test(comp) && /# Compréhension/.test(comp), 'compréhension recopiée avec une note qui renvoie à la demande actuelle');
fs.writeFileSync(path.join(P, 'src', 'autre.mjs'), 'export const autre = 1;\n'); g('add', '-A'); g('commit', '-q', '-m', 'code changé à côté');
r = await go([`Suite de ${r.run} : ajoute encore une multiplication`, '--pipeline', 'dev', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_COVERED: '1' });
s = r.run ? runState(r.run) : {};
const notReused = r.evs.find(e => e.subtype === 'pipeline_context_not_reused');
ok(ids(s).includes('comprendre') && ids(s).includes('concevoir') && /code a divergé.*src\/autre\.mjs/.test(notReused?.why || ''), `code changé depuis : refait, la raison dite (« ${notReused?.why || '—'} »)`, `code ${r.code} — ${ids(s).join(' → ')} — ${r.out.slice(-600)}`);
reset();
routing(null);
r = await go(REQ(1), { FAKE_PIPE_ITEMS: '1' });
const runC = r.run;
r = await go([`Suite de ${runC} : ajoute encore une multiplication`, '--pipeline', 'dev', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_COVERED: '1' });
ok(ids(runState(r.run)).includes('comprendre') && !r.evs.some(e => e.subtype === 'pipeline_context_reused'), 'coupé : chaque exécution refait Comprendre et Concevoir');
reset();

}

if (want(6)) {
// ---------------------------------------------------------------------------
section('6. targetedTests — tests ciblés par étape, suite complète à Livrer');
routing(null);
r = await go(REQ(2), { FAKE_PIPE_ITEMS: '2' });
const offMarks = marks();
ok(r.code === 0 && offMarks >= 6, `coupé : la suite complète à chaque contrôle (${offMarks} lancements)`);
reset();
routing({ targetedTests: true });
r = await go(REQ(2), { FAKE_PIPE_ITEMS: '2' });
s = r.run ? runState(r.run) : {};
ok(r.code === 0 && s.status === 'done' && marks() === 2, `allumé, inactivité coupée : la suite complète deux fois — au départ et à Livrer, comme avant (${marks()}) : rien ne la rattraperait a posteriori`, r.out.slice(-800));
reset();
// 2026-10-29 (point 7): with the idle regression on, the full suite no longer runs at the start nor at Livrer.
routing({ targetedTests: true }, null, true);
r = await go(REQ(2), { FAKE_PIPE_ITEMS: '2' });
s = r.run ? runState(r.run) : {};
const tg = r.evs.filter(e => e.subtype === 'pipeline_suite_targeted');
ok(r.code === 0 && s.status === 'done' && marks() === 0, `allumé : aucune suite complète, ni au départ ni à Livrer (${marks()}) — reportée a posteriori`, r.out.slice(-800));
ok(tg.some(e => /reportée a posteriori/.test(e.why || '')), 'le départ annonce que la suite complète est reportée a posteriori');
const tgItems = tg.filter(e => e.files.length);
ok(tgItems.length >= 4 && tgItems.every(e => e.files.every(f => /pipe-\d\.test\.mjs$/.test(f)) && e.total >= 3), `chaque contrôle de 4a/4b ne lance que les tests de l’item (${tgItems.map(e => e.files.join('+')).join(' | ')})`);
reset();

}

if (want(7)) {
// ---------------------------------------------------------------------------
section('7. Tous les leviers, figés par exécution');
routing(Object.fromEntries(LEVERS.map(l => [l, true])), { items: 25, runMin: 150, reviewBatch: 3, redGreenMaxTests: 2 });
r = await go(REQ(3), { FAKE_PIPE_ITEMS: '3' });
s = r.run ? runState(r.run) : {};
ok(r.code === 0 && s.status === 'done' && LEVERS.every(l => s.tuning?.[l] === true) && delivered(r.run) === '1,2,3', `les six leviers ensemble : terminé, 3 items livrés, ${calls(s)} appels`, r.out.slice(-800));
routing(null);
fs.writeFileSync(path.join(T, 'logs', 'runs', s.run, 'run.json'), JSON.stringify({ ...s, status: 'paused', pausedLimit: 'review' }));
ok(runTuning(runState(s.run), T, 'P').groupReview === true, 'coupés ensuite dans model-routing.json : une reprise de cette exécution garde ses réglages (run.json.tuning)');
reset();

}

if (want(8)) {
section('8. Banc (pipeline-speed-bench.mjs) : profil, rejeu, estimation, anonymat');
{
  const B = await import('./pipeline-speed-bench.mjs');
  const state = { activeMs: 600000, steps: [
    { id: 'rouge', key: '01-rouge', status: 'ok', durationMs: 60000, test: { ms: 10000 } },
    { id: 'rouge', key: '02-rouge', status: 'refused', why: 'l’item n° 1 annonçait 1 test(s), mais 2 ont été écrits', durationMs: 40000, test: { ms: 10000 } },
    { id: 'vert', key: '03-vert', status: 'ok', durationMs: 30000, test: { ms: 10000 } },
    { id: 'revue', key: '04-revue', status: 'ok', durationMs: 20000 },
    { id: 'refactor', key: '05-refactor', status: 'skipped' }] };
  const p = B.profileRun({ state, testsMd: '- [x] (tests: 1) a\n- [x] (revue item 1) (tests: 1) b\n- [x] (tests: 2) c\n',
    stepLogs: { '01-rouge': { cliMs: 45000, ttftMs: 2000 } }, events: [{ subtype: 'pipeline_loop', pipeline: { from: 'revue', to: 'tdd', item: 1 } }] });
  ok(p.items.length === 2 && p.items[0].review === 1 && p.items[1].b === 2 && p.items[1].n === 3 && p.extraRefusals === 1, 'profil : items d’origine (cases rattachées exclues), constats par item, refus « N+1 »');
  ok(p.steps.rouge.calls === 2 && p.steps.rouge.modelMs === 40000 && p.fixedMs === 7000 && p.suite.meanMs === 10000, 'temps de model = étape − suite ; coût fixe = démarrage du CLI + premier jeton');
  const env = B.replayEnv({ items: p.items, extraRefusals: 1 });
  ok(env.FAKE_PIPE_ITEMS === '2' && env.FAKE_PIPE_REVIEW_BASE === '1:1' && env.FAKE_PIPE_ITEM_EXTRA_TESTS === '1:1', 'rejeu : même nombre d’items, constats visés par leur rang d’origine');
  const c = { steps: { rouge: { modelMs: 60000 }, vert: { modelMs: 40000 }, revue: { modelMs: 30000 } }, fixedMs: 5000, suite: { meanMs: 20000 }, targetedShare: 0.25 };
  const e = B.estimate(c, { calls: { 'rouge-vert': 2, revue: 1 }, reviewItems: 3, fullRuns: 2, targetedRuns: 4 });
  ok(e.modelMs === 2 * 95000 + (3 * 30000 - 2 * 5000) && e.suiteMs === 2 * 20000 + 4 * 5000, 'estimation : 4ab = 4a + 4b − coût fixe ; relecture de 3 items = 3 relectures − 2 coûts fixes ; suite ciblée au prorata mesuré');
  const raw = fs.readFileSync(path.join(ROOT, 'tests', 'speed-bench-cases.json'), 'utf8');
  const cases = JSON.parse(raw).cases;
  let names = [];
  try { names = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).projects.map(x => x.name).filter(n => n.length > 3); } catch {}
  ok(cases.length >= 2 && cases.every(x => /^p-\d{8}T\d{6}-[0-9a-f]{6}$/.test(x.run) && x.items.length && x.steps.rouge) && !names.some(n => raw.includes(n)) && !/"request"|"text"/.test(raw),
    `${cases.length} exécutions réelles anonymisées (aucun nom de projet, aucun texte de demande)`);
}
}

if (want(9)) {
// ---------------------------------------------------------------------------
// 9. Areas — user's request (2026-10-29), verbatim: « vérifie qu'il n'y a pas de
// besoin de lancer des tests de non régression côté serveur quand le serveur
// (tel qu'ici) n'est pas du tout impacté. ce n'est que l'apk »
section('9. Zones (areas) : seules les zones touchées lancent leurs tests');
{
  const A = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-areas-'));
  const wa = (f, s) => { fs.mkdirSync(path.dirname(path.join(A, f)), { recursive: true }); fs.writeFileSync(path.join(A, f), s); };
  wa('server.py', 'def f():\n    return 1\n');
  wa('tests/test_server.py', 'from server import f\n\ndef test_f():\n    assert f() == 1\n');
  wa('android/app/src/main/java/Foo.kt', 'class Foo { fun x() = 1 }\n');
  wa('android/app/src/test/java/FooTest.kt', 'class FooTest { @Test fun x() { Foo().x() } }\n');
  const cfgA = {
    testCommand: 'python -m pytest -q',
    testGlobs: ['tests/**'],
    areas: [{ name: 'android', paths: ['android/**'], testCommand: 'gradlew testDebugUnitTest', targetedTestCommand: 'gradlew testDebugUnitTest {files}', testGlobs: ['android/app/src/test/**'], versionFiles: ['android/app/build.gradle.kts'] }],
  };
  ok(typeof S.selectAreaTests === 'function', 'pipeline-speed.mjs exporte selectAreaTests');
  if (typeof S.selectAreaTests === 'function') {
    const sel = (changed, c = cfgA) => S.selectAreaTests({ cwd: A, cfg: c, changed });
    const names = (r) => r.commands.map(c => c.area ?? 'main').join();
    let r = sel(['android/app/src/main/java/Foo.kt']);
    ok(names(r) === 'android' && !r.commands.some(c => /pytest/.test(c.command)), 'diff android seul ⇒ seule la commande android, pas pytest', JSON.stringify(r));
    r = sel(['server.py']);
    ok(names(r) === 'main' && /pytest/.test(r.commands[0].command), 'diff serveur seul ⇒ pytest seul', JSON.stringify(r));
    r = sel(['server.py', 'android/app/src/main/java/Foo.kt']);
    ok(['main,android', 'android,main'].includes(names(r)), 'diff mixte ⇒ les deux commandes', JSON.stringify(r));
    ok(names(sel(['server.py'], { ...cfgA, areas: undefined })) === 'main', 'pas d’« areas » ⇒ inchangé (suite principale)');
    ok(JSON.stringify(sel(['android/app/build.gradle.kts']).versionFiles) === JSON.stringify(['android/app/build.gradle.kts']), 'version montée = celle des zones touchées');
  }
  fs.rmSync(A, { recursive: true, force: true });
}
}

if (want(10)) {
// ---------------------------------------------------------------------------
// 10. Targeted selection without the full suite — user's rule (2026-10-29), verbatim:
// « tu ne refais pas tous les tests de l'application à chaque petite modification.
// tu ne le fais qu'une fois toutes les modifications et seulement les tests
// correspondant sont passés. il faut y passer beaucoup moins de temps »
section('10. Sélection ciblée sans suite complète : .kt, pytest, Gradle, tests de zone');
{
  const K = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lean-'));
  const wk = (f, c) => { fs.mkdirSync(path.dirname(path.join(K, f)), { recursive: true }); fs.writeFileSync(path.join(K, f), c); };
  const gk = (...a) => spawnSync('git', ['-C', K, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  wk('android/app/src/main/java/Foo.kt', 'class Foo { fun x() = 1 }\n');
  wk('android/app/src/main/java/Lonely.kt', 'class Lonely { fun y() = 2 }\n');
  wk('android/app/src/test/java/FooTest.kt', 'class FooTest { @Test fun x() { Foo().x() } }\n');
  wk('server.py', 'def f():\n    return 1\n');
  wk('tests/test_server.py', 'from server import f\n\ndef test_f():\n    assert f() == 1\n');
  gk('init', '-q'); gk('add', '-A'); gk('commit', '-q', '-m', 'i');
  const H = gk('rev-parse', 'HEAD').stdout.trim();
  const area = { name: 'android', paths: ['android/**'], testCommand: 'gradlew testDebugUnitTest', testGlobs: ['android/app/src/test/**'], versionFiles: ['android/app/build.gradle.kts'] };
  const cfgK = { testCommand: 'python -m pytest -q', testGlobs: ['tests/**'], areas: [area] };

  // point 5 — a .kt that no import reaches no longer forces the full suite
  wk('android/app/src/main/java/Foo.kt', 'class Foo { fun x() = 2 }\n');
  const isAndroidTest = (f) => isTestFile(f, area.testGlobs);
  let sel = S.selectTargetedTests({ cwd: K, cfg: { ...cfgK, areas: undefined, testCommand: 'gradlew testDebugUnitTest', testGlobs: area.testGlobs }, from: H, isTest: isAndroidTest, lean: true });
  ok(sel.targeted && sel.files.join() === 'android/app/src/test/java/FooTest.kt' && /classe Foo/.test(sel.reasons['android/app/src/test/java/FooTest.kt']), '.kt sans import : le test de la même zone qui nomme la classe, pas la suite complète', JSON.stringify(sel));
  wk('android/app/src/main/java/Foo.kt', 'class Foo { fun x() = 1 }\n');
  wk('android/app/src/main/java/Lonely.kt', 'class Lonely { fun y() = 3 }\n');
  sel = S.selectTargetedTests({ cwd: K, cfg: { ...cfgK, areas: undefined, testCommand: 'gradlew testDebugUnitTest', testGlobs: area.testGlobs }, from: H, isTest: isAndroidTest, lean: true });
  ok(sel.targeted && sel.empty && sel.files.length === 0 && sel.uncovered.join() === 'android/app/src/main/java/Lonely.kt', '.kt qu’aucun test ne nomme : rien à lancer à cette étape (suite complète a posteriori)', JSON.stringify(sel));
  sel = S.selectTargetedTests({ cwd: K, cfg: { ...cfgK, areas: undefined, testCommand: 'gradlew testDebugUnitTest', testGlobs: area.testGlobs }, from: H, isTest: isAndroidTest });
  ok(!sel.targeted && /couvert par aucun test/.test(sel.why), 'levier coupé (lean absent) : le repli en suite complète reste');
  gk('checkout', '-q', '--', '.');

  // lever off (lean false): the whole area command, never a --tests selection
  wk('android/app/src/main/java/Foo.kt', 'class Foo { fun x() = 7 }\n');
  wk('android/app/src/test/java/FooTest.kt', 'class FooTest { @Test fun x() { Foo().x(); Foo().x() } }\n');
  const full = S.selectAreaTests({ cwd: K, cfg: { ...cfgK, areas: [{ ...area, targetedTestCommand: 'gradlew testDebugUnitTest {files}' }] }, changed: S.changedSince(K, H) });
  ok(full.commands.length === 1 && full.commands[0].command === 'gradlew testDebugUnitTest' && !full.commands[0].files, 'levier coupé : la testCommand entière de la zone touchée, sans --tests', JSON.stringify(full));
  gk('checkout', '-q', '--', '.');

  // after-the-fact run: the area commands are part of the full run
  const PR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-plan-'));
  fs.mkdirSync(path.join(PR, '.orchestrateur'));
  fs.writeFileSync(path.join(PR, '.orchestrateur', 'pipeline.json'), JSON.stringify(cfgK));
  const IR = await import('./idle-regression.mjs');
  const idlePlan = IR.projectPlan(PR);
  ok(idlePlan && idlePlan.full[0] === '__shell__' && idlePlan.full[1] === '(python -m pytest -q) && (gradlew testDebugUnitTest)', 'complète a posteriori : la commande principale ET celle de chaque zone', JSON.stringify(idlePlan));
  fs.writeFileSync(path.join(PR, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'npm test' }));
  ok(IR.projectPlan(PR).full[1] === 'npm test', 'sans zones : la commande principale seule, inchangée');
  // a DECLARED full run carries the areas' commands too, and the runner runs them after it
  fs.writeFileSync(path.join(PR, '.orchestrateur', 'pipeline.json'), JSON.stringify({ ...cfgK, idleRegression: { full: ['node', '-e', 'process.exit(0)'] } }));
  const declared = IR.projectPlan(PR);
  ok(declared.declared && declared.areaCommands?.join() === 'gradlew testDebugUnitTest', 'complète déclarée : les commandes de zone sont portées par le plan', JSON.stringify(declared));
  const RUN = await import('./idle-regression-runner.mjs');
  const runStepWith = async (areaCommands) => {
    const id = 'z' + areaCommands.length + Math.abs(areaCommands.join().length);
    const st = { id, project: 'P', path: PR, kind: 'full', commit: 'c0ffee', argv: ['__shell__', 'node -e "process.exit(0)"'], inPlace: true, report: null,
      resultFile: path.join(PR, id + '.result.json'), logFile: path.join(PR, id + '.log'), worktree: null, areaCommands };
    const code = await RUN.runStep(st);
    return { code, log: fs.readFileSync(st.logFile, 'utf8') };
  };
  const okRun = await runStepWith(['node -p 40+2']);
  ok(okRun.code === 0 && /42/.test(okRun.log), 'le runner lance la commande de zone après la complète déclarée', okRun.log);
  const koRun = await runStepWith(['node -e process.exit(3)', 'node -p 50+5']);
  ok(koRun.code === 3 && /55/.test(koRun.log), 'une commande de zone en échec rend la complète rouge (premier code gardé), les suivantes tournent', koRun.log);
  fs.rmSync(PR, { recursive: true, force: true });

  // point 6 — targeted command deduced
  ok(S.targetedCommand(K, { testCommand: 'python -m pytest -q' }, ['tests/test_a.py', 'tests/test_b.py']).command === 'python -m pytest -q tests/test_a.py tests/test_b.py', 'python -m pytest ⇒ « python -m pytest -q {files} »');
  ok(S.targetedCommand(K, { testCommand: 'python -m pytest' }, ['tests/test_a.py']).command === 'python -m pytest -q tests/test_a.py', 'pytest sans -q : déduction aussi');
  const gr = S.targetedCommand(K, { testCommand: 'gradlew testDebugUnitTest' }, ['android/app/src/test/java/FooTest.kt']);
  ok(/^gradlew testDebugUnitTest --tests "\*\.FooTest"$/.test(gr.command || ''), 'zone Gradle ⇒ « gradlew testDebugUnitTest --tests <classe> »', JSON.stringify(gr));
  ok(!S.targetedCommand(K, { testCommand: 'pytest' }, ['t.py']).command, 'commande inconnue (pytest nu) : toujours pas de déduction');
  ok(!S.targetedCommand(K, { testCommand: 'python -m pytest && echo x' }, ['t.py']).command, 'commande composite : pas de déduction');

  // point 2 — area test globs count as tests
  const merged = S.withAreaTestGlobs(cfgK);
  ok(isTestFile('android/app/src/test/java/FooTest.kt', merged.testGlobs) && isTestFile('tests/test_server.py', merged.testGlobs), 'les testGlobs d’une zone comptent comme tests (Rouge)');
  ok(!isTestFile('android/app/src/test/java/FooTest.kt', merged.mainTestGlobs) && S.withAreaTestGlobs(merged) === merged, 'la suite principale garde ses seuls motifs ; idempotent');
  ok(S.withAreaTestGlobs({ testGlobs: ['t/**'] }).testGlobs.join() === 't/**', 'sans « areas » : inchangé');

  // point 1 in a real repository — area command targeted at the area's own tests, main untouched
  wk('android/app/src/main/java/Foo.kt', 'class Foo { fun x() = 5 }\n');
  const plan = S.selectAreaTests({ cwd: K, cfg: cfgK, changed: S.changedSince(K, H), lean: true });
  ok(plan.commands.length === 1 && plan.commands[0].area === 'android' && plan.commands[0].command === 'gradlew testDebugUnitTest --tests "*.FooTest"', 'diff .kt : la zone Android, ciblée sur FooTest, pas pytest', JSON.stringify(plan));
  gk('checkout', '-q', '--', '.');

  // point 7 is covered by the real engine run of section 6 (idle regression on / off)
  fs.rmSync(K, { recursive: true, force: true });
}
}

srv.close();
if (process.env.SPEED_KEEP) console.log(`racine gardée : ${T}`); else try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '✗' : '✓'} _test_pipeline_speed : ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
