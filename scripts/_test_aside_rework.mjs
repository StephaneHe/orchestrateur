#!/usr/bin/env node
// ============================================================================
// scripts/_test_aside_rework.mjs — items set aside less often, never lost (0.139.0)
// ============================================================================
//
// User rule (2026-10-22), verbatim: « arrête de poser des questions de
// découpage. tu sais comment est organisé le process mieux que moi ».
// Chef's finding (2026-10-23) on six full-Development runs of one project:
// up to half of the items set aside, their patches « dépassés » at the resume,
// one pause per item discarded. Replayed here on p-20261022T221404-3a1835:
//
//   1. the real run (tests/aside-rework-case.json, anonymised): every cause is
//      recognised by the helpers of aside-rework.mjs;
//   2. the same pattern with the real engine, switches OFF: items set aside for
//      a test header, a wrong test, a stale patch — one pause per conflict;
//   3. switches ON (itemTestFix, testWrong, asideRedo, asideGroup): every item
//      delivered, a single pause;
//   4. asideGroup alone: the stale patches make ONE pause, discarded at once;
//   5. switches are frozen per run: turned on mid-run, they do not apply.
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_aside_rework.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as R from './aside-rework.mjs';
import { TUNING_LEVERS, runTuning } from './pipeline-tuning.mjs';
import { isTestFile } from './pipeline-engine.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const LEVERS = ['itemTestFix', 'testWrong', 'asideRedo', 'asideGroup'];

// ---------------------------------------------------------------------------
section('0. Interrupteurs et briques');
{
  ok(LEVERS.every(l => l in TUNING_LEVERS), `quatre interrupteurs : ${LEVERS.join(', ')}`);
  const T0 = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rework-t-'));
  const t = runTuning({}, T0, 'P');
  ok(LEVERS.every(l => t[l] === false), 'absents de model-routing.json : coupés (comportement de 0.138.0)');
  ok(LEVERS.every(l => runTuning({ tuning: { chefPauses: true } }, T0, 'P')[l] === false), 'exécution partie sans eux : coupés, même allumés ensuite');
  fs.rmSync(T0, { recursive: true, force: true });
  ok(R.testWrongClaim('TEST_FAUX: le test compte les .json de tout le dossier partagé') === 'le test compte les .json de tout le dossier partagé'
    && R.testWrongClaim('**TEST_FAUX**: dossier partagé entre les deux cas') && !R.testWrongClaim('TEST_FAUX: court') && !R.testWrongClaim('# Vert\n\nrien'), 'TEST_FAUX : raison lue (10 caractères au moins), jamais deviné');
  const md = '- [x] (tests: 1) a\n- [x] (tests: 2) b\n- [x] (revue item 2) (tests: 1) c\n- [ ] (tests: 1) d\n';
  const u = R.uncheckGroup(md, 2);
  ok(u.unchecked === 2 && u.md === '- [x] (tests: 1) a\n- [ ] (tests: 2) b\n- [ ] (revue item 2) (tests: 1) c\n- [ ] (tests: 1) d\n', 'item refait : lui et ses cases rattachées rouverts, rien d’autre');
  const print = new Map([['test/a.test.mjs', 'h1'], ['test/b.test.mjs', 'h2']]);
  ok(R.withoutOwnTests(print, ['test/b.test.mjs']).size === 1 && print.size === 2, 'tests de l’item retirés de l’empreinte protégée (copie, l’original intact)');
  const G = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rework-g-'));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: G, encoding: 'utf8' });
  fs.mkdirSync(path.join(G, 'test')); fs.writeFileSync(path.join(G, 'test', 'old.test.mjs'), 'x\n'); fs.writeFileSync(path.join(G, 'a.mjs'), 'a\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'i');
  const H = g('rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(G, 'test', 'new.test.mjs'), 'n\n'); fs.writeFileSync(path.join(G, 'a.mjs'), 'b\n');
  fs.mkdirSync(path.join(G, '.orchestrateur', 'runs'), { recursive: true }); fs.writeFileSync(path.join(G, '.orchestrateur', 'runs', 'x.test.mjs'), 'z');
  const own = R.ownTestFiles(G, H, (f) => isTestFile(f, ['test/**', '**/*.test.mjs']));
  ok(own.join() === 'test/new.test.mjs', `tests de l’item = tests écrits depuis la dernière livraison, ni les anciens ni les artefacts (${own.join()})`);
  fs.rmSync(G, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('1. Rejeu de p-20261022T221404-3a1835 (données réelles anonymisées)');
{
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'aside-rework-case.json'), 'utf8'));
  const isTest = (f) => isTestFile(f, c.testGlobs);
  ok(c.run === 'p-20261022T221404-3a1835' && c.items === 16 && c.delivered.length === 7 && c.aside.length === 8, `l’exécution : ${c.items} items, ${c.delivered.length} livrés, ${c.aside.length} mis de côté`);
  // Correction steps (no item) refused for touching a test: always a test of the item they correct.
  const refusedFix = c.steps.filter(s => s.id === 'vert' && s.item == null && /fichiers de test modifiés/.test(s.why));
  const ownOf = (f) => c.aside.some(a => (a.files || []).includes(f)) || c.steps.some(s => s.id === 'rouge');
  ok(refusedFix.length >= 10 && refusedFix.every(s => isTest(s.why.split(' : ').pop().trim()) && ownOf(s.why.split(' : ').pop().trim())),
    `${refusedFix.length} corrections de relecture refusées pour avoir touché un test de leur item — permises par « itemTestFix »`);
  const byReview = c.aside.filter(a => a.limit === 'review');
  ok(byReview.length === 6 && byReview.every(a => (a.files || []).some(isTest)), `${byReview.length} items mis de côté par la relecture, chacun avec ses propres tests dans le correctif`);
  const header = byReview.filter(a => /(header|en-tête|Item \d)/i.test(a.why));
  ok(header.length >= 3, `dont ${header.length} pour un en-tête de test (« Item 4 » au lieu de « Item 8 »…) reporté « à l’étape Livrer » — que la livraison par item ne fait jamais`);
  const item1 = c.aside.find(a => a.group === 1);
  ok(item1.limit === 'green' && R.greenAsideDiagnosis({ files: item1.files, isTest, claim: null }).includes('ne contient que les tests'),
    'item 1 « le code ne fait pas passer le test » alors que son correctif ne contient QUE son test : diagnostic donné (« testWrong »)');
  const conflicts = c.aside.filter(a => a.conflict);
  ok(conflicts.length === 6 && conflicts.every(a => /USER_REQUIREMENTS\.md/.test(a.conflict)), `${conflicts.length} correctifs « dépassés » : tous sur le registre des exigences, où chaque item ajoute une ligne — refaits par « asideRedo »`);
  ok(c.pauses.filter(p => p.limit === 'aside_conflict').length === 6, '6 pauses « écarter l’item » d’affilée — une seule avec « asideGroup »');
}

// ---------------------------------------------------------------------------
// Throwaway root + notification listener (chef)
// ---------------------------------------------------------------------------
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push(JSON.parse(b)); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-aside-rework-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
const routing = (tuning) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'], ...(tuning ? { tuning } : {}) },
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const reset = () => { g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur'); };

// The psyProfile pattern: item 1 gets a wrong test, item 2 a wrong test header,
// item 3 a review finding three times (set aside), every item a requirements row.
// Item 3's repeated review finding is a CODE finding: since 0.155.0 a documentation-only
// finding stops blocking after one correction round, so it can no longer set an item aside.
const CASE = { FAKE_PIPE_ITEMS: '4', FAKE_PIPE_TEST_WRONG: '1', FAKE_PIPE_HEADER: '2', FAKE_PIPE_REVIEW_ITEM: '3:3', FAKE_PIPE_REQ_ROW: '1' };
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_REVIEW_ITEM', 'FAKE_PIPE_REVIEW_DOC_ITEM', 'FAKE_PIPE_REVIEW_LOG', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_BIG', 'FAKE_PIPE_REFACTOR', 'FAKE_PIPE_ITEM_EXTRA_TESTS',
  'FAKE_PIPE_TEST_WRONG', 'FAKE_PIPE_HEADER', 'FAKE_PIPE_REQ_ROW', 'FAKE_PIPE_COVERED', 'ORCH_PIPE_REVIEW_ROUNDS', 'ORCH_PIPE_ITEMS']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...CASE, ...env }, windowsHide: true });
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
// A code finding attaches « (revue item k) » cases to tests.md, which shifts the case numbers of
// the items after it: report each group as the ORIGINAL item it is (rank among non-attached cases).
const originalRank = (run) => {
  let md = ''; try { md = fs.readFileSync(path.join(P, '.orchestrateur', 'runs', run, 'tests.md'), 'utf8'); } catch {}
  const cases = md.split(/\r?\n/).filter(l => /^\s*[-*]\s+\[( |x|X)\]\s+/.test(l));
  const rank = new Map(); let k = 0;
  cases.forEach((l, i) => { if (!/\]\s+\(revue item \d+\)/.test(l)) rank.set(i + 1, ++k); });
  return (g) => rank.get(g) ?? g;
};
const delivered = (run) => { const o = originalRank(run); return (runState(run).delivered || []).map(d => o(d.group)).sort((a, b) => a - b).join(','); };
const REQUEST = ['Ajoute les multiplications par deux, trois, quatre et cinq', '--mode', 'complet'];

// ---------------------------------------------------------------------------
section('2. Interrupteurs coupés : le schéma de psyProfile reproduit (comportement de 0.138.0)');
routing(null);
let r = await go(REQUEST);
const runOff = r.run;
let s = runOff ? runState(runOff) : {};
const asideOf = (st) => (st.aside || []).map(a => `${a.group}:${a.limit}`).sort().join(',');
ok(r.code === 2 && r.limit === 'items_blocked' && asideOf(s).replace(/,3:\w+$/, '') === '1:green,2:green' && /3:/.test(asideOf(s)) && delivered(runOff) === '4',
  `items 1 (test faux), 2 (en-tête de test), 3 (relecture) mis de côté, seul l’item 4 livré (aside ${asideOf(s)}, livrés ${delivered(runOff)})`, r.out.slice(-1200));
ok(s.steps.some(x => x.id === 'vert' && x.item == null && x.status === 'refused' && /fichiers de test modifiés.*pipe-2/.test(x.why)), 'la correction de l’en-tête de l’item 2 est refusée : « fichiers de test modifiés »');
// Section 5: switches turned on mid-run do not apply (frozen in run.json).
routing(Object.fromEntries(LEVERS.map(l => [l, true])));
r = await go(['reprendre les items']);
const conflictPauses = [];
for (let i = 0; i < 6 && r.limit === 'aside_conflict'; i++) { conflictPauses.push(runState(runOff).asideConflict); r = await go(['écarter l’item']); }
s = runState(runOff);
ok(conflictPauses.length === 2 && conflictPauses.join() === '2,3', `reprise : une pause « écarter l’item » PAR item dépassé (${conflictPauses.join(', ') || 'aucune'})`, r.out.slice(-800));
ok(r.limit === 'items_blocked' && asideOf(s) === '1:green', `l’item 1 bloque de nouveau pour la même raison (${asideOf(s)})`);
r = await go(['livrer sans eux']);
s = runState(runOff);
ok(s.status === 'abandoned' && delivered(runOff) === '4' && (s.discardedAside || []).length === 2, `fin : 1 item livré sur 4, 2 écartés, 1 non livré — la moitié perdue, comme dans psyProfile (${delivered(runOff)})`);
section('5. Interrupteurs figés par exécution');
ok(LEVERS.every(l => s.tuning?.[l] === false) && !logOf().some(e => ['pipeline_item_redo', 'pipeline_test_wrong'].includes(e.subtype)),
  'allumés après le départ de l’exécution : sans effet sur elle (run.json.tuning coupé, aucune reprise refaite ni retour à 4a)');
reset();

// ---------------------------------------------------------------------------
section('3. Interrupteurs allumés : chaque item livré, une seule pause');
routing(Object.fromEntries(LEVERS.map(l => [l, true])));
r = await go(REQUEST);
const runOn = r.run;
s = runOn ? runState(runOn) : {};
ok(LEVERS.every(l => s.tuning?.[l] === true), 'réglages figés au départ : les quatre interrupteurs');
const tw = r.evs.find(e => e.subtype === 'pipeline_test_wrong');
ok(tw?.pipeline.item === 1 && /f\(0\) = 1/.test(tw.why) && tw.files.includes('test/pipe-1.test.mjs'), 'item 1 : 4b juge son test faux → retour à 4a (événement, raison, fichier du test)', JSON.stringify(tw || {}));
const order1 = s.steps.filter(x => x.item === 1).map(x => `${x.id}:${x.status}`).join(',');
ok(/^rouge:ok,vert:refused,rouge:ok,vert:ok/.test(order1) && s.steps.filter(x => x.id === 'vert' && x.item === 1 && x.status === 'refused').length === 1,
  `item 1 : un seul refus de 4b, puis 4a corrige le test et 4b passe (${order1})`);
ok(fs.readFileSync(path.join(P, 'test', 'pipe-1.test.mjs'), 'utf8').indexOf('// faux') < 0, 'le test livré de l’item 1 est le test corrigé');
const fix2 = s.steps.filter(x => x.id === 'vert' && x.item == null);
ok(fix2.some(x => x.status === 'ok') && !fix2.some(x => /fichiers de test modifiés/.test(x.why || '')) && /^\/\/ Item 2 /.test(fs.readFileSync(path.join(P, 'test', 'pipe-2.test.mjs'), 'utf8')),
  'item 2 : la correction réécrit l’en-tête de SON test, acceptée du premier coup, puis relu et livré');
ok(r.code === 2 && r.limit === 'items_blocked' && /^3:\w+$/.test(asideOf(s)) && delivered(runOn) === '1,2,4', `seul l’item 3 (constat de relecture répété) est mis de côté ; 1, 2 et 4 livrés (${delivered(runOn)})`, r.out.slice(-1200));
r = await go(['reprendre les items']);
s = runState(runOn);
const redo = r.evs.find(e => e.subtype === 'pipeline_item_redo');
ok(redo?.pipeline.item === 3 && /USER_REQUIREMENTS/.test(redo.conflict) && redo.hint && fs.existsSync(redo.hint), 'item 3 : son correctif ne s’applique plus (registre des exigences) → refait à partir du code actuel, l’ancien correctif copié comme indication', JSON.stringify(redo || {}));
const p3 = r.evs.filter(e => e.type === 'user_prompt' || e.subtype === 'pipeline_step_start').length;
void p3;
ok(r.code === 0 && s.status === 'done' && delivered(runOn) === '1,2,3,4' && !(s.aside || []).length && !(s.discardedAside || []).length,
  `les 4 items livrés, rien d’écarté, exécution terminée (code ${r.code}, livrés ${delivered(runOn)})`, r.out.slice(-1200));
ok(!r.evs.some(e => e.type === 'notification' && e.subtype === 'pipeline_limit') && (s.pauseCount || 0) <= 1, `une seule pause pour toute l’exécution (au lieu de 9 dans psyProfile)`);
ok(/Refait\(s\) à partir du code actuel[^\n]*item 3 \(livré\)/.test(r.evs.find(e => e.type === 'result')?.result || ''), 'le résultat dit que l’item 3 a été refait, et livré');
ok(!g('status', '--porcelain').stdout.trim(), 'arbre propre');
reset();

// ---------------------------------------------------------------------------
section('4. « asideGroup » seul : une seule pause pour tous les correctifs dépassés');
routing({ asideGroup: true });
r = await go(REQUEST, { FAKE_PIPE_TEST_WRONG: '' });
const runG = r.run;
s = runG ? runState(runG) : {};
ok(r.limit === 'items_blocked' && /^2:green,3:\w+$/.test(asideOf(s)), `items 2 et 3 mis de côté (${asideOf(s)})`, r.out.slice(-800));
r = await go(['reprendre les items'], { FAKE_PIPE_TEST_WRONG: '' });
s = runState(runG);
ok(r.limit === 'aside_conflict' && s.asideConflict === '2,3' && r.evs.filter(e => e.subtype === 'pipeline_aside_conflict').length === 2,
  `les deux conflits relevés sans s’arrêter, puis UNE pause qui les nomme (${s.asideConflict})`, r.out.slice(-800));
const q = r.evs.find(e => e.type === 'result')?.result || '';
ok(/j’écarte ces 2 items/.test(q) && /item 2/.test(q) && /item 3/.test(q), 'le message de la pause nomme les deux items et propose de les écarter ensemble', q.slice(0, 900));
r = await go(['écarter l’item'], { FAKE_PIPE_TEST_WRONG: '' });
s = runState(runG);
ok(r.code === 0 && s.status === 'done' && (s.discardedAside || []).map(a => a.group).join() === '2,3' && !r.evs.some(e => e.type === 'notification' && e.subtype === 'pipeline_limit'),
  `une réponse : les deux écartés d’un coup, l’exécution se termine (${s.status})`, r.out.slice(-800));
reset();

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
