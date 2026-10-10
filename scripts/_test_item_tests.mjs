#!/usr/bin/env node
// ============================================================================
// scripts/_test_item_tests.mjs — tests written per item vs declared (0.62.0)
// ============================================================================
//
// User decision (2026-10-10), verbatim: « c+d » — part d: « à l'étape Liste de
// tests, le model écrit pour chaque item le nombre de tests prévus, et le code
// vérifie ensuite que ce nombre est respecté ». Step 2 of 2, protected here:
// for each item of the TDD loop, the tests really written (counted in the
// item's own changes) may not exceed its "(tests: N)": the step that goes over
// is refused with a message asking to split the item (no silent acceptance),
// and the item is checked again when it is ticked. An already-covered item
// (DEJA_COUVERT) is accepted without any new test.
//
// REAL dispatch.mjs + engine, fake claude (FAKE_PIPE_ITEM_EXTRA_TESTS).
//
//   node scripts/_test_item_tests.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as IT from './item-tests.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Le comptage : un cas de test par déclaration, par langage');
{
  ok(IT.countTestCases("import { test } from 'node:test';\ntest('a', () => {});\ntest.skip('b', () => {});\nit(\"c\", () => {});\ndescribe('d', () => {});\nconst latest = 1; contest('x');\n", 'a.test.mjs') === 3,
    'JS : test(), test.skip(), it() comptés ; describe() et contest() non');
  ok(IT.countTestCases('def test_a():\n    pass\nasync def test_b():\n    pass\ndef helper():\n    pass\n', 'test_x.py') === 2, 'Python : def test_… et async def test_… ; une fonction utilitaire non');
  ok(IT.countTestCases('class T {\n  @Test fun a() {}\n  @Test\n  fun b() {}\n}\n', 'T.kt') === 2 && IT.countTestCases('@Test void a(){}', 'T.java') === 1, 'Kotlin / Java : @Test');
  ok(IT.countTestCases('func TestA(t *testing.T) {}\nfunc helper() {}\n', 'a_test.go') === 1, 'Go : func TestXxx(');
  const a = IT.addedTests({ 'test/a.mjs': 2, 'test/b.mjs': 1 }, { 'test/a.mjs': 3, 'test/b.mjs': 0, 'test/c.mjs': 2 });
  ok(a.total === 3 && a.perFile['test/a.mjs'] === 1 && a.perFile['test/c.mjs'] === 2 && !a.perFile['test/b.mjs'], 'tests ajoutés = somme des hausses par fichier (un test retiré ailleurs ne compense pas)');
  let v = IT.itemTestsVerdict({ declared: 1, added: { total: 3, perFile: { 'test/x.mjs': 3 } }, itemN: 2 });
  ok(!v.ok && /annonçait 1 test\(s\), mais 3 ont été écrits/.test(v.why) && /redécoupé/.test(v.why) && /test\/x\.mjs \(\+3\)/.test(v.why), `dépassement : refus avec message de redécoupage — « ${v.why.slice(0, 120)}… »`);
  ok(IT.itemTestsVerdict({ declared: 2, added: { total: 2 } }).ok && IT.itemTestsVerdict({ declared: 1, added: { total: 0 } }).ok, 'autant ou moins que déclaré (0 compris) : accepté');
  v = IT.itemTestsVerdict({ declared: null, added: { total: 5 }, itemN: 4 });
  ok(v.ok && v.checked === false && /sans déclaration/.test(v.note), 'item sans déclaration (liste antérieure à 0.61.0) : non vérifié, signalé, jamais refusé');
}

// ---------------------------------------------------------------------------
// Disposable root (same layout as _test_tests_per_item.mjs)
// ---------------------------------------------------------------------------
const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-itt-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer']
    .map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-opus-5-5' }])),
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
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_DECL', 'FAKE_PIPE_REVIEW_DECL', 'FAKE_PIPE_COVERED', 'FAKE_PIPE_ITEM_EXTRA_TESTS', 'ORCH_PIPE_TESTS_PER_ITEM', 'FAKE_CLAUDE_LAUNCH_FAIL_FILE']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const go = async (args, env) => { const n0 = logOf().length; const r = await dispatch(args, env); const evs = logOf().slice(n0); return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run, done: evs.filter(e => e.subtype === 'pipeline_step_done') }; };
const stepsOf = (r, id) => r.done.filter(d => d.pipeline.step === id);
const REQ = 'Ajoute la multiplication';

// ---------------------------------------------------------------------------
section('2. Vrai dispatch : autant de tests que déclaré → item coché, nombre tracé');
reset();
let r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2' });
const doneItems = r.evs.filter(e => e.subtype === 'pipeline_item_done');
ok(r.code === 0 && doneItems.length === 2, `2 items de 1 test déclaré, 1 test écrit chacun : cochés (code ${r.code})`, r.out.slice(-800));
ok(doneItems.every(e => e.tests?.declared === 1 && e.tests?.written === 1), `l’événement « item coché » porte le décompte (${JSON.stringify(doneItems.map(e => e.tests))})`);

// ---------------------------------------------------------------------------
section('3. Plus de tests que déclaré : l’étape est refusée, avec demande de redécouper');
reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_ITEM_EXTRA_TESTS: '2:1' });
let rg = stepsOf(r, 'rouge');
ok(rg[0]?.status === 'refused' && /annonçait 1 test\(s\), mais 3 ont été écrits/.test(rg[0].why) && /redécoupé/.test(rg[0].why),
  `4a qui écrit 3 tests pour un item « (tests: 1) » : refusée — « ${String(rg[0]?.why).slice(0, 130)}… »`);
ok(r.code === 0 && rg[1]?.status === 'ok' && r.evs.some(e => e.subtype === 'pipeline_item_done'), 'nouvel essai avec 1 seul test : accepté, item coché, exécution terminée');

reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_ITEM_EXTRA_TESTS: '2' });
rg = stepsOf(r, 'rouge');
const lim = r.evs.find(e => e.type === 'notification' && e.subtype === 'pipeline_limit');
const res = r.evs.filter(e => e.type === 'result').pop()?.result || '';
ok(r.code === 2 && rg.length === 2 && rg.every(d => d.status === 'refused') && lim && !r.evs.some(e => e.subtype === 'pipeline_item_done'),
  'toujours trop de tests : 2 refus, pause, item NON coché (aucune acceptation silencieuse)');
ok(/redécoupé/.test(res) || /redécoupé/.test(lim?.why || ''), 'le message de pause demande de redécouper l’item');

reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_ITEM_EXTRA_TESTS: '1:1', ORCH_PIPE_TESTS_PER_ITEM: '2', FAKE_PIPE_DECL: 'two' });
rg = stepsOf(r, 'rouge');
ok(r.code === 0 && rg[0]?.status === 'ok', 'item « (tests: 2) » avec 2 tests écrits : accepté (le plafond déclaré par item est respecté, pas seulement « 1 »)');

// ---------------------------------------------------------------------------
section('4. DEJA_COUVERT reste accepté, et la vérification finale au moment de cocher');
reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_COVERED: '1' });
ok(r.code === 0 && stepsOf(r, 'rouge')[0]?.status === 'ok' && stepsOf(r, 'rouge')[0]?.covered && r.evs.some(e => e.subtype === 'pipeline_item_covered'),
  'item déjà couvert (DEJA_COUVERT) : accepté comme avant, dans la limite déclarée');
const E = await import('./pipeline-engine.mjs');
ok(typeof E.checkItemTests === 'function', 'checkItemTests exporté (vérification au moment de cocher, testable)');
if (typeof E.checkItemTests === 'function') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-itt-unit-'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test', 'a.test.mjs'), "import { test } from 'node:test';\ntest('a', () => {});\n");
  const base = IT.countTests(dir, ['test/a.test.mjs']);
  fs.writeFileSync(path.join(dir, 'test', 'a.test.mjs'), "import { test } from 'node:test';\ntest('a', () => {});\ntest('b', () => {});\ntest('c', () => {});\n");
  const v1 = E.checkItemTests({ cwd: dir, files: ['test/a.test.mjs'], base, item: { n: 3, declared: 1 } });
  const v2 = E.checkItemTests({ cwd: dir, files: ['test/a.test.mjs'], base, item: { n: 3, declared: 2 } });
  ok(!v1.ok && /n° 3 annonçait 1 test\(s\), mais 2 ont été écrits/.test(v1.why) && v2.ok, 'au moment de cocher : 2 tests ajoutés pour 1 déclaré → refus ; pour 2 déclarés → accepté');
  fs.rmSync(dir, { recursive: true, force: true });
}

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
