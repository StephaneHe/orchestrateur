#!/usr/bin/env node
// ============================================================================
// scripts/_test_model_backoff.mjs — back-off on model launch failures (0.60.0)
// ============================================================================
//
// User request (2026-10-09): "il faut une reaction aux Erreurs 1 (quand le
// model est temporairement indisponible). Apres deux erreurs, il faut un
// timeout avant de recommencer deux fois. Puis apres deux nouvelles erreurs, un
// nouveau timeout un peu plus long, et ainsi de suite. On augmente le timeout
// de 10s a chaque fois. Et on donne a l'utilisateur le choix : lancer un test
// sur le model, changer de model, forcer un nouvel essai".
//
// REAL dispatch.mjs + engine, fake claude dying like an unavailable model
// (FAKE_CLAUDE_LAUNCH_FAIL_FILE: exit 1, nothing on stdout, one stderr line).
// Delays are shortened by ORCH_BACKOFF_STEP_MS; the rule (tier × step) is the
// same as in production (10 s, 20 s, 30 s…).
//
//   node scripts/_test_model_backoff.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../public/turn-core.js';
import * as B from './model-backoff.mjs';
import { runModelTest, isModelTestLog } from './model-test.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
section('1. La règle : détection, paliers de +10 s, plafond, canal de contrôle');
{
  ok(B.isLaunchFailure({ code: 1, log: {} }), 'code 1, ni init ni result : erreur de lancement (le cas de 19:31)');
  ok(B.isLaunchFailure({ code: 1, log: { refused: { reason: 'le CLI claude a échoué sans result (API Error: 529 overloaded_error)' }, result: { is_error: true, model_unavailable: true } } }),
    'CLI mort avant de servir, « sans result » (aucun fallback) : erreur de lancement');
  ok(B.isLaunchFailure({ code: 1, log: { served: 'claude-opus-5-5', result: { is_error: true, num_turns: 1, result: 'API Error: 500 Internal server error' } } }),
    'result en erreur passagère d’API (5xx/529/overloaded) avant tout travail : erreur de lancement');
  ok(!B.isLaunchFailure({ code: 2, log: { served: 'claude-opus-5-5', refused: { reason: 'le CLI claude a échoué sans result (code 2)' } } }), 'le model a démarré (init) puis le CLI est mort : pause « model indisponible » comme avant');
  ok(!B.isLaunchFailure({ code: 1, log: { refused: { reason: 'limite de session Claude jusqu’à …', limited_until: '2026-10-10T00:00:00Z' } } }), 'limite de session : pause immédiate, pas d’attente');
  ok(!B.isLaunchFailure({ code: 1, log: { refused: { reason: 'le CLI claude a échoué sans result (model not_found: claude-xyz)' } } }), 'model inconnu ou retiré : pas d’attente inutile');
  ok(!B.isLaunchFailure({ code: 1, log: { served: 'x', result: { is_error: true, num_turns: 7, result: 'Error: tests failed' } } }), 'tour qui a travaillé puis échoué : échec ordinaire (critère)');
  ok(!B.isLaunchFailure({ code: 0, log: {} }), 'code 0 : pas une erreur de lancement');
  const cfg = B.backoffConfig({});
  ok(cfg.perTier === 2 && cfg.stepMs === 10_000 && cfg.maxTiers === 6, 'par défaut : 2 essais par palier, +10 s par palier, 6 paliers');
  ok([1, 2, 3, 4, 5, 6, 7, 8].map(n => B.tierAfter(n, cfg)).join() === '0,1,0,2,0,3,0,4', 'une attente toutes les 2 erreurs consécutives (paliers 1, 2, 3…)');
  ok([1, 2, 3, 6].map(t => B.delayFor(t, cfg) / 1000).join() === '10,20,30,60', 'délais : 10 s, 20 s, 30 s… 60 s au 6e palier');
  ok(B.backoffConfig({ ORCH_BACKOFF_STEP_MS: '200', ORCH_BACKOFF_MAX_TIERS: '2' }).stepMs === 200, 'réglable pour les tests');
  const T0 = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bo-'));
  const run = 'p-20261009T193025-d2f51b';
  fs.mkdirSync(path.join(T0, 'runs', run), { recursive: true });
  fs.writeFileSync(path.join(T0, 'runs', run, 'run.json'), '{}');
  ok(!B.requestControl(T0, 'nope', 'retry').ok && !B.requestControl(T0, run, 'reboot').ok && !B.requestControl(T0, 'p-20261009T000000-aaaaaa', 'retry').ok, 'contrôle : exécution invalide, action inconnue ou exécution absente refusées');
  const dir = B.runDirOf(T0, run);
  let t = Date.now();
  setTimeout(() => B.requestControl(T0, run, 'retry'), 300);
  let w = await B.waitBackoff({ ms: 20_000, runDir: dir, pollMs: 50 });
  ok(w.reason === 'retry' && Date.now() - t < 3000, `« réessayer maintenant » met fin à l’attente (${w.waitedMs} ms au lieu de 20 s)`);
  let tested = 0;
  setTimeout(() => B.requestControl(T0, run, 'test'), 100);
  t = Date.now();
  w = await B.waitBackoff({ ms: 800, runDir: dir, pollMs: 50, onTest: async () => { tested++; } });
  ok(w.reason === 'elapsed' && tested === 1 && Date.now() - t >= 750, '« tester le model » pendant l’attente : test lancé, l’attente continue');
  fs.rmSync(T0, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('2. Le test de model réutilisé (oneShotClaude de « Tester la langue »), avec son journal');
const TR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mt-'));
{
  const env = { ...process.env, CLAUDE_BIN: FAKE };
  let r = await runModelTest({ root: TR, provider: 'claude', model: 'claude-opus-5-5', label: 'essai', env });
  const txt = fs.readFileSync(r.logFile, 'utf8');
  ok(r.ok && isModelTestLog(r.logName) && /verdict : OK/.test(txt) && /commande : .*--model claude-opus-5-5/.test(txt) && /--- stderr ---/.test(txt) && /--- stdout ---/.test(txt) && /"subtype":"init"/.test(txt),
    `model qui répond : OK, journal ${r.logName} (commande, code, durée, model servi, stderr, stdout)`, txt.slice(0, 600));
  const ff = path.join(TR, 'fail-count'); fs.writeFileSync(ff, '1');
  r = await runModelTest({ root: TR, provider: 'claude', model: 'claude-opus-5-5', env: { ...env, FAKE_CLAUDE_LAUNCH_FAIL_FILE: ff, FAKE_CLAUDE_LAUNCH_FAIL_ALL: '1' } });
  const t2 = fs.readFileSync(r.logFile, 'utf8');
  ok(!r.ok && /code de sortie : 1/.test(t2) && /overloaded/.test(t2) && /ÉCHEC/.test(t2), 'model indisponible : ÉCHEC, code 1 et message d’erreur du CLI dans le journal');
  r = await runModelTest({ root: TR, provider: 'codex', model: 'gpt-6-astra', env });
  ok(!r.ok && /--test/.test(r.why), 'codex : non testable hors tour, et le journal dit comment faire');
  ok(!isModelTestLog('../config.json') && !isModelTestLog('x.log'), 'noms de journal stricts (aucune traversée)');
}

// ---------------------------------------------------------------------------
// Disposable root (same layout as _test_pipeline_covered.mjs)
// ---------------------------------------------------------------------------
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push({ path: req.url, ...JSON.parse(b) }); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-backoff-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
const routing = (rougeModel) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' },
    'dev.rouge': { provider: 'anthropic', model: rougeModel },
    'dev.vert': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'dev.revue': { provider: 'anthropic', model: 'claude-fable-5-1' },
    'dev.livrer': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  }, history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
}));
routing('claude-opus-5-5');
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
const FAILF = path.join(T, 'launch-fail-count');
const LAUNCHLOG = path.join(T, 'launch-log.ndjson');
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200',
  FAKE_CLAUDE_LAUNCH_FAIL_FILE: FAILF, FAKE_CLAUDE_LAUNCH_LOG: LAUNCHLOG, ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_COVERED', 'FAKE_PIPE_NOCLAIM', 'FAKE_CLAUDE_LAUNCH_FAIL_ALL', 'ORCH_BACKOFF_STEP_MS', 'ORCH_BACKOFF_MAX_TIERS']) delete baseEnv[k];
const start = (args, env = {}) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const done = new Promise((resolve) => { const t = setTimeout(() => c.kill(), 240_000); c.on('exit', code => { clearTimeout(t); resolve({ code, out }); }); });
  return { done, get out() { return out; } };
};
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const launches = () => { try { return fs.readFileSync(LAUNCHLOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const waitFor = async (pred, ms = 30_000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = pred(); if (v) return v; await sleep(100); } return null; };
const REQ = 'Ajoute la fonction double';
const go = async (args, env, during) => {
  const n0 = logOf().length, k0 = notices.length;
  fs.rmSync(LAUNCHLOG, { force: true });
  const h = start(args, env);
  if (during) await during(() => logOf().slice(n0));
  const r = await h.done;
  const evs = logOf().slice(n0);
  return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run, notes: notices.slice(k0) };
};
const ofType = (evs, st) => evs.filter(e => e.subtype === st);

// ---------------------------------------------------------------------------
section('3. 2 erreurs → attente → 2 erreurs → attente +10 s (réduite) → reprise, même model, essais non comptés');
reset(); fs.writeFileSync(FAILF, '4');
let r = await go([REQ, '--mode', 'leger'], { ORCH_BACKOFF_STEP_MS: '300' });
ok(r.code === 0 && runState(r.run).status === 'done', `exécution terminée malgré 4 erreurs de lancement (code ${r.code})`, r.out.slice(-1200));
let done = ofType(r.evs, 'pipeline_step_done');
const rouge = done.filter(d => d.pipeline.step === 'rouge');
ok(rouge.map(d => d.status).join() === 'launch_failed,launch_failed,launch_failed,launch_failed,ok', `étape rouge : 4 « n’a pas démarré » puis ✓ (${rouge.map(d => d.status).join()})`);
const bo = ofType(r.evs, 'pipeline_backoff');
ok(bo.length === 2 && bo[0].tier === 1 && bo[0].waitMs === 300 && bo[1].tier === 2 && bo[1].waitMs === 600 && bo[0].failures === 2 && bo[1].failures === 4,
  `attentes après la 2e et la 4e erreur, de 1 puis 2 pas (${bo.map(b => `${b.tier}:${b.waitMs}ms`).join(', ')})`);
const ts = (e) => Date.parse(e.timestamp);
const gap1 = ts(r.evs.filter(e => e.subtype === 'pipeline_step_start' && e.pipeline.step === 'rouge')[2]) - ts(rouge[1]);
const gap2 = ts(r.evs.filter(e => e.subtype === 'pipeline_step_start' && e.pipeline.step === 'rouge')[4]) - ts(rouge[3]);
ok(gap1 >= 280 && gap2 >= 580 && gap2 > gap1, `délais réellement attendus : ${gap1} ms puis ${gap2} ms (croissants)`);
const rougeStarts = r.evs.filter(e => e.subtype === 'pipeline_step_start' && e.pipeline.step === 'rouge');
ok(launches().filter(l => l.failed).length === 4 && launches().filter(l => l.failed).every(l => l.model === 'claude-opus-5-5') && rougeStarts.length === 5 && rougeStarts.every(s => s.model === 'claude-opus-5-5'),
  `toujours le MÊME model pour l’étape (claude-opus-5-5, ${rougeStarts.length} lancements) : aucun fallback`);
ok(!r.evs.some(e => e.subtype === 'pipeline_limit') && !ofType(r.evs, 'pipeline_summary').some(s => s.pipeline.status === 'paused'), 'les erreurs de lancement ne consomment pas la limite de 2 essais (pas de pause)');
const lf = rouge[0];
ok(/lancement impossible \(code 1\)/.test(lf.why) && /overloaded/.test(lf.why) && fs.existsSync(path.join(T, lf.log.replace(/\.jsonl$/, '.stderr.log'))), 'motif lisible avec le message du CLI ; stderr de l’étape gardé dans un fichier');
ok(ofType(r.evs, 'pipeline_backoff_end').length === 2 && ofType(r.evs, 'pipeline_backoff_end').every(e => e.reason === 'elapsed'), 'fin de chaque attente tracée');
ok(r.notes.filter(n => /\[PIPELINE — P — /.test(n.text || '') && /⏳/.test(n.text) && /model-backoff\.mjs p-\S+ test/.test(n.text) && /model-backoff\.mjs p-\S+ retry/.test(n.text) && /case « dev\.rouge »/.test(n.text)).length === 2,
  'le chef est prévenu à chaque palier, avec les 3 choix (tester, changer la case dev.rouge, réessayer)');
ok(/palier 1\/6/.test(bo[0].text) && /case « dev\.rouge »/.test(bo[0].text), 'message d’attente : palier, case à changer');

// ---------------------------------------------------------------------------
section('4. Pendant l’attente : « réessayer maintenant », « tester le model », « changer de model »');
reset(); fs.writeFileSync(FAILF, '2');
let t0 = Date.now();
r = await go([REQ, '--mode', 'leger'], { ORCH_BACKOFF_STEP_MS: '20000' }, async (evs) => {
  const b = await waitFor(() => evs().find(e => e.subtype === 'pipeline_backoff'));
  const run = evs().find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
  if (b) {
    ok(B.requestControl(path.join(T, 'logs'), run, 'test', 'test').ok, 'demande « tester le model » transmise');
    const mt = await waitFor(() => evs().find(e => e.subtype === 'pipeline_model_test' && e.status !== 'running'), 30_000);
    ok(mt && mt.ok === true && fs.existsSync(path.join(T, mt.logFile)) && /verdict : OK/.test(fs.readFileSync(path.join(T, mt.logFile), 'utf8')), `test du model pendant l’attente : il répond, journal ${mt?.logFile}`);
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'model-backoff.mjs'), run, 'status'], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: T }, encoding: 'utf8' });
    ok(/en attente : claude-opus-5-5 \(case dev\.rouge\)/.test(cli.stdout), `CLI status : ${cli.stdout.trim()}`);
    const cr = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'model-backoff.mjs'), run, 'retry'], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: T }, encoding: 'utf8' });
    ok(cr.status === 0, 'CLI retry (le chef, sans redémarrage)');
  }
});
const end = ofType(r.evs, 'pipeline_backoff_end')[0];
ok(r.code === 0 && end?.reason === 'retry' && Date.now() - t0 < 60_000, `attente de 20 s interrompue par « réessayer maintenant » (${end?.waitedMs} ms), exécution terminée`);

reset(); fs.writeFileSync(FAILF, '2');
r = await go([REQ, '--mode', 'leger'], { ORCH_BACKOFF_STEP_MS: '20000' }, async (evs) => {
  const b = await waitFor(() => evs().find(e => e.subtype === 'pipeline_backoff'));
  const run = evs().find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
  if (b) { routing('claude-sonnet-5-5'); B.requestControl(path.join(T, 'logs'), run, 'retry', 'test'); }
});
const starts = r.evs.filter(e => e.subtype === 'pipeline_step_start' && e.pipeline.step === 'rouge');
ok(r.code === 0 && starts.slice(0, 2).every(s => s.model === 'claude-opus-5-5') && starts[2]?.model === 'claude-sonnet-5-5',
  `« changer de model » : case dev.rouge changée dans la page Models → l’essai suivant prend le nouveau model, choisi par l’utilisateur (${starts.map(s => s.model).join(' → ')})`);
routing('claude-opus-5-5');

// ---------------------------------------------------------------------------
section('5. Plafond des paliers → pause ; « tester le model » répond en restant en pause ; « continuer » reprend');
reset(); fs.writeFileSync(FAILF, '100');
r = await go([REQ, '--mode', 'leger'], { ORCH_BACKOFF_STEP_MS: '100', ORCH_BACKOFF_MAX_TIERS: '2' });
const lim = r.evs.find(e => e.type === 'notification' && e.subtype === 'pipeline_limit');
const res5 = r.evs.filter(e => e.type === 'result').pop()?.result || '';
ok(r.code === 2 && lim?.limit === 'launch' && runState(r.run).status === 'paused' && ofType(r.evs, 'pipeline_backoff').length === 2,
  `après 2 paliers et 6 erreurs : pause « launch » (${ofType(r.evs, 'pipeline_step_done').filter(d => d.status === 'launch_failed').length} erreurs)`);
ok(/« continuer »/.test(res5) && /« tester le model »/.test(res5) && /« changer le model »/.test(res5) && /case « dev\.rouge »/.test(res5) && /NEEDS_USER_INPUT:.*tester le model/.test(res5),
  'message de pause : continuer, tester le model (recommandé), changer le model (case dev.rouge), abandonner');
const pausedRun = r.run;
r = await go(['tester le model']);
const t5 = r.evs.find(e => e.subtype === 'pipeline_model_test');
ok(r.code === 2 && runState(pausedRun).status === 'paused' && t5?.logFile && /journal complet/i.test(r.evs.filter(e => e.type === 'result').pop()?.result || ''),
  `réponse « tester le model » : test lancé, journal ${t5?.logFile}, l’exécution reste en pause`);
fs.writeFileSync(FAILF, '0');
r = await go(['continuer'], { ORCH_BACKOFF_STEP_MS: '100', ORCH_BACKOFF_MAX_TIERS: '2' });
ok(r.code === 0 && runState(pausedRun).status === 'done', `« continuer » : reprise de la même exécution, terminée (${runState(pausedRun).status})`);

// ---------------------------------------------------------------------------
section('6. Frise du tableau de bord (turn-core) et boutons');
{
  const j = globalThis.TurnCore.createJournal();
  const run = 'p-20261009T193025-d2f51b';
  const evs = [
    { type: 'user_prompt', text: 'x', pipeline: { run, pipeline: 'dev', mode: 'leger', steps: [{ id: 'rouge', title: '4a Rouge' }] }, timestamp: '2026-10-09T10:00:00Z' },
    { type: 'system', subtype: 'pipeline_backoff', pipeline: { run, step: 'rouge', slot: 'dev.rouge' }, model: 'claude-opus-5-5', tier: 1, maxTiers: 6, waitMs: 10000, failures: 2, text: '⏳ attente' },
  ];
  for (const e of evs) j.push(e);
  let t = j.list()[0];
  ok(t.pipeline.backoff?.tier === 1 && t.pipeline.backoff.slot === 'dev.rouge', 'attente visible dans la frise (palier, case)');
  j.push({ type: 'system', subtype: 'pipeline_model_test', pipeline: { run, slot: 'dev.rouge' }, model: 'claude-opus-5-5', status: 'ok', ok: true, logName: '20261009T100000Z-claude-opus-5-5.log', text: '🔬 il répond' });
  j.push({ type: 'system', subtype: 'pipeline_backoff_end', pipeline: { run }, reason: 'retry' });
  t = j.list()[0];
  ok(!t.pipeline.backoff && t.pipeline.modelTest?.logName, 'fin d’attente : bloc retiré, résultat du test et journal gardés');
  const act = fs.readFileSync(path.join(ROOT, 'public', 'activite.js'), 'utf8');
  ok(/data-backoff-action="test"/.test(act) && /data-backoff-action="retry"/.test(act) && /href="#\/models" data-backoff-action="model"/.test(act) && /\/api\/pipeline-runs\/\$\{encodeURIComponent\(run\)\}\/backoff/.test(act) && /\/api\/model-tests\//.test(act),
    'dashboard : boutons « Tester le model », « Réessayer maintenant », lien « Changer de model » (page Models), lien vers le journal');
  const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/app\.post\('\/api\/pipeline-runs\/:run\/backoff', sameOriginOnly/.test(srvSrc) && /app\.get\('\/api\/model-tests\/:name'/.test(srvSrc), 'server.js : route de contrôle (même origine) et lecture des journaux de test');
}

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); fs.rmSync(TR, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
