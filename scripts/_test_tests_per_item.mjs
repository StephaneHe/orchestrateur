#!/usr/bin/env node
// ============================================================================
// scripts/_test_tests_per_item.mjs — declared tests per item (0.61.0, « c+d »)
// ============================================================================
//
// User decision (2026-10-10), verbatim: « c+d » — part d: at the Test list step
// the model writes, for each item, the number of tests it plans, and the code
// checks it. This suite protects step 1 of 2: the declaration "(tests: N)" on
// every open case of tests.md, refused when missing or above the cap (default
// 2, LIMITS.testsPerItem), with a clear "split it" message; the same rule for
// the "(revue)" cases the Review adds (full mode).
//
// REAL dispatch.mjs + engine, fake claude (FAKE_PIPE_DECL, FAKE_PIPE_REVIEW_DECL).
//
//   node scripts/_test_tests_per_item.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. La règle : déclaration « (tests: N) », plafond 2 par défaut');
{
  ok(E.LIMITS.testsPerItem === 2, 'plafond par défaut : 2 tests par case (LIMITS.testsPerItem)');
  ok(E.declaredTests('(tests: 2) recherche « lentille »') === 2 && E.declaredTests('(Tests : 1) x') === 1 && E.declaredTests('(test: 1) x') === 1 && E.declaredTests('(revue) (tests: 1) [P2] x') === 1,
    'formats reconnus : « (tests: N) », espaces et casse tolérés, aussi après « (revue) »');
  ok(E.declaredTests('multiplier par 2') === null && E.declaredTests('2 tests prévus') === null, 'sans « (tests: N) » : aucune déclaration');
  const items = E.parseItems('# Liste\n\n- [x] déjà fait sans déclaration\n- [ ] (tests: 1) a\n- [ ] b sans déclaration\n- [ ] (tests: 0) c\n- [ ] (tests: 3) d\n- [ ] (tests: 2) e\n');
  ok(items[1].declared === 1 && items[2].declared === null && items[4].declared === 3, 'parseItems expose « declared »');
  const pb = E.declarationProblems(items, 2);
  ok(!pb.ok && pb.missing.join() === '3,4' && pb.over.length === 1 && pb.over[0].n === 5 && pb.over[0].declared === 3,
    `case cochée ignorée ; absente ou 0 → manquante (n° ${pb.missing}) ; 3 > 2 → refusée (n° 5) ; 1 et 2 acceptées`);
  const why = E.declarationWhy('tests.md', pb, 2, 'case');
  ok(/\(tests: N\)/.test(why) && /de 1 à 2/.test(why) && /n° 3, 4/.test(why) && /n° 5 \(3\)/.test(why) && /Redécoupe/.test(why), `message clair : format, plafond, cases fautives, redécouper — « ${why.slice(0, 160)}… »`);
  ok(E.declarationProblems(E.parseItems('- [ ] (tests: 3) x'), 3).ok, 'plafond réglable : 3 tests acceptés quand le plafond vaut 3');
}

// ---------------------------------------------------------------------------
// Disposable root (same layout as _test_pipeline_gates.mjs)
// ---------------------------------------------------------------------------
const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tpi-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer']
    .map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-opus-5-5' }])) },
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
const DUMP = path.join(T, 'prompts.ndjson');
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_DECL', 'FAKE_PIPE_REVIEW_DECL', 'ORCH_PIPE_TESTS_PER_ITEM', 'FAKE_CLAUDE_DUMP_PROMPT', 'FAKE_CLAUDE_LAUNCH_FAIL_FILE']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const go = async (args, env) => { const n0 = logOf().length; const r = await dispatch(args, env); const evs = logOf().slice(n0); return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run, done: evs.filter(e => e.subtype === 'pipeline_step_done') }; };
const stepsOf = (r, id) => r.done.filter(d => d.pipeline.step === id);
const testsMd = (run) => fs.readFileSync(path.join(P, '.orchestrateur', 'runs', run, 'tests.md'), 'utf8');
const prompts = () => { try { return fs.readFileSync(DUMP, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).map(p => String(p.prompt ?? p.text ?? JSON.stringify(p))); } catch { return []; } };
const REQ = 'Ajoute la multiplication';

// ---------------------------------------------------------------------------
section('2. Liste de tests (vrai dispatch) : consigne, refus sans déclaration ou au-delà du plafond, liste conforme acceptée');
reset(); fs.rmSync(DUMP, { force: true });
let r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_CLAUDE_DUMP_PROMPT: DUMP });
ok(r.code === 0 && stepsOf(r, 'liste-tests').map(d => d.status).join() === 'ok', `liste conforme (chaque case « (tests: 1) ») acceptée du premier coup (code ${r.code})`, r.out.slice(-800));
ok(E.parseItems(testsMd(r.run)).every(i => i.declared === 1), 'tests.md : chaque case porte sa déclaration');
const ps = prompts();
ok(ps.some(t => /PIPELINE_STEP=liste-tests/.test(t) && /« - \[ \] \(tests: N\) <comportement observable> »/.test(t) && /de 1 à 2/.test(t) && /découpe-le en plusieurs cases/.test(t)),
  'consigne de la Liste de tests : format « (tests: N) », N de 1 à 2, découper un comportement trop gros');
ok(ps.some(t => /PIPELINE_STEP=revue/.test(t) && /commence-la par « \(tests: N\) »/.test(t)), 'consigne de la Revue (complet) : chaque défaut annonce aussi « (tests: N) »');

reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_DECL: 'none:1' });
let lt = stepsOf(r, 'liste-tests');
ok(r.code === 0 && lt.map(d => d.status).join() === 'refused,ok' && /sans déclaration du nombre de tests : case\(s\) n° 1/.test(lt[0].why) && /Redécoupe/.test(lt[0].why),
  `case sans « (tests: N) » : liste refusée avec un message clair, puis acceptée une fois corrigée (${lt.map(d => d.status)})`, lt[0]?.why);

reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_DECL: 'over:1' });
lt = stepsOf(r, 'liste-tests');
ok(r.code === 0 && lt[0]?.status === 'refused' && /plus de 2 tests annoncés : n° 1 \(3\)/.test(lt[0].why), `case annonçant 3 tests (> 2) : refusée — « ${String(lt[0]?.why).slice(0, 120)}… »`);

reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_DECL: 'over:1', ORCH_PIPE_TESTS_PER_ITEM: '3' });
lt = stepsOf(r, 'liste-tests');
ok(lt[0]?.status === 'refused' && /plus de 3 tests annoncés : n° 1 \(4\)/.test(lt[0].why) && /de 1 à 3/.test(lt[0].why), 'plafond réglable (ORCH_PIPE_TESTS_PER_ITEM=3) : le message suit le plafond');

reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_DECL: 'none' });
lt = stepsOf(r, 'liste-tests');
const lim = r.evs.find(e => e.type === 'notification' && e.subtype === 'pipeline_limit');
ok(r.code === 2 && lt.length === 2 && lt.every(d => d.status === 'refused') && lim?.limit === 'criteria' && !stepsOf(r, 'rouge').length,
  'toujours sans déclaration : 2 refus, pause, et aucune case lancée en boucle de tests');

// ---------------------------------------------------------------------------
section('3. Les cases « (revue) » portent aussi une déclaration (complet) ; le léger n’est pas concerné');
reset();
// problemes:2 — try 1 (no declaration, refused) and try 2 (declared) both report the defect.
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_REVIEW: 'problemes:2', FAKE_PIPE_REVIEW_DECL: 'none:1' });
const rv = stepsOf(r, 'revue');
const md = E.parseItems(testsMd(r.run));
// Since 0.63.0 the case is attached to the item reviewed: « (revue item 1) ».
const revueItems = md.filter(i => /^\(revue item 1\)/.test(i.text));
ok(rv[0]?.status === 'refused' && /revue\.json : chaque entrée doit annoncer son nombre de tests prévus/.test(rv[0].why) && /entrée\(s\) n° 1/.test(rv[0].why),
  'revue avec un défaut sans « (tests: N) » : refusée avec le même message');
ok(r.code === 0 && revueItems.length === 1 && revueItems[0].declared === 1 && /^\(revue item 1\) \(tests: 1\)/.test(revueItems[0].text),
  `défaut déclaré : ajouté à tests.md comme « ${revueItems[0]?.text} », puis traité et livré`);

reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_REVIEW: 'problemes:1', FAKE_PIPE_REVIEW_DECL: 'over:1' });
ok(stepsOf(r, 'revue')[0]?.status === 'refused' && /plus de 2 tests annoncés/.test(stepsOf(r, 'revue')[0].why), 'défaut de revue annonçant 3 tests : refusé (à découper)');

reset();
r = await go(['Ajoute la fonction double', '--mode', 'leger'], { FAKE_PIPE_REVIEW: 'problemes:1', FAKE_PIPE_REVIEW_DECL: 'none' });
ok(r.code === 0 && !stepsOf(r, 'revue').some(d => d.status === 'refused'), 'léger : les défauts de revue vont à « écrire le code », sans tests.md — pas de déclaration exigée');

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
