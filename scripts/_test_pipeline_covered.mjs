#!/usr/bin/env node
// ============================================================================
// scripts/_test_pipeline_covered.mjs — "the behaviour already exists" (0.57.2)
// ============================================================================
//
// User decision (2026-10-09): "si c'est un probleme de pipeline, il faut
// corriger le pipeline, puis seulement reprendre le deroulement". A light
// Development run whose change was already committed paused at 4a: the model
// wrote an honest, green test and refused to fake a red one; the engine refused
// it twice ("la suite passe encore", then "aucun test ajouté ni modifié") and
// the 2-refusal limit paused the run.
//
// Protected here, on the REAL dispatch.mjs and engine (fake claude):
//   1. DEJA_COUVERT is accepted at 4a in light mode too, only with a verified
//      proof (existing commit, existing production file[:line]); 4b is skipped,
//      the delivery prompt and the final result mention it;
//   2. an honest claim refused on form (no proof, test not rewritten after a
//      refused try) does not consume the retry budget — once, so it stays
//      bounded; without any claim the strict rule is unchanged;
//   3. a run already paused on that limit profits from the fix on "continuer";
//   4. the green-base precondition reports an environment failure (network,
//      timeouts) apart from a broken test.
//
//   node scripts/_test_pipeline_covered.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { deriveState } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
// Disposable root (same layout as _test_pipeline_gates.mjs)
// ---------------------------------------------------------------------------
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push({ path: req.url, ...JSON.parse(b) }); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-covered-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' },
    'dev.rouge': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'dev.vert': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'dev.revue': { provider: 'anthropic', model: 'claude-fable-5-1' },
    'dev.livrer': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  }, history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
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
  FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_BIG', 'FAKE_PIPE_REFACTOR', 'FAKE_PIPE_COVERED', 'FAKE_PIPE_NOCLAIM', 'FAKE_PIPE_PROOF', 'FAKE_PIPE_NOTEST', 'FAKE_CLAUDE_DUMP_PROMPT']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const go = async (args, env) => { const n0 = logOf().length; const r = await dispatch(args, env); const evs = logOf().slice(n0); return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run, done: evs.filter(e => e.subtype === 'pipeline_step_done') }; };
const seq = (done) => done.map(d => `${d.pipeline.step}${d.status === 'ok' ? '' : `:${d.status}`}`).join(',');
const prompts = () => { try { return fs.readFileSync(DUMP, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const promptText = (p) => String(p?.prompt ?? p?.text ?? JSON.stringify(p));
const REQ = 'Passe la version à 1.5.4 (déjà fait dans le dernier commit)';

// ---------------------------------------------------------------------------
section('1. Briques : preuve d’un DEJA_COUVERT, cause d’un échec de tests');
{
  const cfg = { testGlobs: ['test/**'] };
  const short = H0.slice(0, 7);
  let p = E.coveredProof(P, `DEJA_COUVERT\nPreuve : commit ${short}, \`src/pipe.mjs:1\` (id).`, cfg);
  ok(p.some(x => x.kind === 'commit' && x.ref === short) && p.some(x => x.kind === 'file' && x.ref === 'src/pipe.mjs' && x.line === 1), `commit existant + fichier:ligne existant = preuve (${JSON.stringify(p)})`);
  p = E.coveredProof(P, 'DEJA_COUVERT\nPreuve : commit deadbee0, src/absent.mjs, src/pipe.mjs:99, test/base.test.mjs', cfg);
  ok(p.length === 0, `commit inconnu, fichier absent, ligne hors du fichier, fichier de test : aucune preuve (${JSON.stringify(p)})`);
  ok(E.coveredProof(P, 'DEJA_COUVERT\nLe code existant le fait déjà.', cfg).length === 0, 'une affirmation sans référence n’est pas une preuve');
  const net = 'ERROR tests/integration/test_x.py::test_a\nE               TimeoutError: The read operation timed out\n249 passed, 6 errors in 50.23s';
  const c1 = E.classifyTestFailure(net);
  ok(c1.cause === 'environment' && c1.signals.some(s => s.label === 'délai dépassé'), `sortie réelle (timeouts réseau) → environnement (${JSON.stringify(c1.signals)})`);
  ok(E.classifyTestFailure('Error: getaddrinfo ENOTFOUND api.example.com').cause === 'environment', 'ENOTFOUND / getaddrinfo → environnement');
  ok(E.classifyTestFailure('AssertionError [ERR_ASSERTION]: 3 == 4\n1 failing').cause === 'tests', 'assertion fausse → tests cassés');
}

// ---------------------------------------------------------------------------
section('2. Léger, comportement déjà présent : DEJA_COUVERT prouvé accepté, sans 4b, livraison qui le mentionne');
reset(); try { fs.unlinkSync(DUMP); } catch {}
let r = await go([REQ, '--pipeline', 'dev', '--mode', 'leger'], { FAKE_PIPE_COVERED: '0', FAKE_CLAUDE_DUMP_PROMPT: DUMP });
ok(r.code === 0, `exécution terminée (code ${r.code})`, r.out.slice(-1500));
ok(seq(r.done) === 'rouge,vert:skipped,revue,livrer', `enchaînement : ${seq(r.done)}`);
const rg = r.done.find(d => d.pipeline.step === 'rouge');
ok(rg?.covered === true && rg.pipeline?.attempt === 1 && rg.test?.ok === true, '4a acceptée au premier essai, test vert, marquée « déjà couvert »');
ok(/DEJA_COUVERT/.test(r.done.find(d => d.pipeline.step === 'vert')?.why || ''), '4b sautée avec son motif');
const cov = r.evs.find(e => e.subtype === 'pipeline_item_covered');
ok(cov && cov.proof?.some(x => x.kind === 'commit') && cov.proof?.some(x => x.ref === 'src/pipe.mjs') && /déjà présent/.test(cov.text) && !/«\s*»/.test(cov.text),`événement tracé avec la preuve : ${cov?.text}`);
ok(runState(r.run).coveredItems?.[0]?.proof?.length >= 2, 'run.json garde l’item couvert et sa preuve');
const res2 = r.evs.find(e => e.type === 'result')?.result || '';
ok(/Déjà assuré par le code existant/.test(res2) && /preuve : commit/.test(res2), 'le résultat final le mentionne, avec la preuve');
const ps = prompts().map(promptText);
ok(ps.some(t => /PIPELINE_STEP=rouge/.test(t) && /DEJA_COUVERT/.test(t) && /PREUVE/.test(t) && /à la demande/.test(t)), 'consigne 4a en léger : l’exception DEJA_COUVERT et la preuve sont annoncées');
ok(ps.some(t => /PIPELINE_STEP=livrer/.test(t) && /DÉJÀ assuré/.test(t)), 'consigne de Livrer : le comportement déjà assuré est à mentionner (CHANGELOG, livraison.md)');
ok(fs.existsSync(path.join(P, 'test', 'pipe-covered.test.mjs')) && g('rev-list', '--count', `${H0}..HEAD`).stdout.trim() === '1', 'le test documentaire est livré dans un seul commit');

// ---------------------------------------------------------------------------
section('3. Refus « de forme » d’un DEJA_COUVERT honnête : essai non compté (une fois)');
reset();
r = await go([REQ, '--pipeline', 'dev', '--mode', 'leger'], { FAKE_PIPE_COVERED: '0', FAKE_PIPE_PROOF: 'none:2' });
let rr = r.done.filter(d => d.pipeline.step === 'rouge');
ok(r.code === 0 && rr.length === 3 && rr[0].status === 'refused' && rr[1].status === 'refused' && rr[2].status === 'ok',
  `sans preuve 2 fois : 3 essais (2 + 1 non compté), puis accepté — ${rr.map(d => d.status).join(',')} (code ${r.code})`, r.out.slice(-800));
ok(/sans preuve/.test(rr[0].why || ''), `motif du refus : ${rr[0].why}`);
ok(r.evs.filter(e => e.subtype === 'pipeline_retry_not_counted').length === 1, 'un seul essai non compté, tracé (pipeline_retry_not_counted)');

reset();
r = await go([REQ, '--pipeline', 'dev', '--mode', 'leger'], { FAKE_PIPE_COVERED: '0', FAKE_PIPE_NOTEST: '1:1' });
rr = r.done.filter(d => d.pipeline.step === 'rouge');
ok(r.code === 0 && rr.length === 2 && rr[0].status === 'refused' && /réécris le test/.test(rr[0].why || '') && rr[1].status === 'ok',
  `cas réel (essai 2 sans test réécrit) : refus explicite non compté, puis accepté — ${rr.map(d => `${d.status}:${(d.why || '').slice(0, 60)}`).join(' | ')}`, r.out.slice(-800));

reset();
r = await go([REQ, '--pipeline', 'dev', '--mode', 'leger'], { FAKE_PIPE_COVERED: '0', FAKE_PIPE_PROOF: 'none' });
rr = r.done.filter(d => d.pipeline.step === 'rouge');
ok(r.code === 2 && rr.length === 3 && rr.every(d => d.status === 'refused'), `jamais de preuve : borné à 3 essais, puis pause (code ${r.code}, ${rr.length} essais)`);
ok(runState(r.run).status === 'paused', 'exécution en pause (limite)');

reset();
r = await go([REQ, '--pipeline', 'dev', '--mode', 'leger'], { FAKE_PIPE_COVERED: '0', FAKE_PIPE_NOCLAIM: '1' });
rr = r.done.filter(d => d.pipeline.step === 'rouge');
ok(r.code === 2 && rr.length === 2 && rr.every(d => d.status === 'refused' && /DEJA_COUVERT/.test(d.why) && /preuve/.test(d.why)),
  'test vert SANS déclaration : règle stricte inchangée (2 refus avec l’indication DEJA_COUVERT + preuve, puis pause)');
ok(!r.evs.some(e => e.subtype === 'pipeline_retry_not_counted'), 'aucun essai offert sans déclaration');
const pausedRun = r.run;

// ---------------------------------------------------------------------------
section('4. Reprise d’une exécution déjà en pause sur cette limite : « continuer » profite du correctif');
r = await go(['continuer'], { FAKE_PIPE_COVERED: '0' });
ok(r.run === pausedRun, `même exécution reprise (${r.run})`);
ok(r.code === 0 && runState(pausedRun).status === 'done', `reprise terminée (code ${r.code}, état ${runState(pausedRun).status})`, r.out.slice(-1200));
ok(seq(r.done) === 'rouge,vert:skipped,revue,livrer' && r.done[0].covered === true, `reprise : ${seq(r.done)}`);
ok(deriveState(logOf().map(e => JSON.stringify(e))).state === 'unread', 'côté musicien : tour terminé, plus de question ouverte');

// ---------------------------------------------------------------------------
section('5. Base rouge au départ : environnement (réseau, délais) signalé à part');
reset();
fs.writeFileSync(path.join(P, 'test', 'net.test.mjs'), "import { test } from 'node:test';\ntest('remote', () => { const e = new Error('The read operation timed out'); e.name = 'TimeoutError'; throw e; });\n");
g('add', '-A'); g('commit', '-q', '-m', 'flaky network test');
r = await go(['Ajoute la fonction double', '--mode', 'leger']);
let pre = r.evs.find(e => e.subtype === 'pipeline_precondition');
ok(r.code === 2 && pre?.cause === 'environment' && pre.signals?.length, `pause, cause « environnement » (${JSON.stringify(pre?.signals)})`);
const resEnv = r.evs.find(e => e.type === 'result')?.result || '';
ok(/environnement/.test(resEnv) && /pas d’un test cassé/.test(resEnv) && /Je recommande « continuer »/.test(resEnv), 'message de pause : environnement, pas un test cassé, « continuer » plus tard recommandé');
reset();
fs.writeFileSync(path.join(P, 'test', 'broken.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('broken', () => { assert.equal(1 + 1, 3); });\n");
g('add', '-A'); g('commit', '-q', '-m', 'broken test');
r = await go(['Ajoute la fonction double', '--mode', 'leger']);
pre = r.evs.find(e => e.subtype === 'pipeline_precondition');
ok(r.code === 2 && pre?.cause === 'tests' && /déjà rouge/.test(pre.text) && /Je recommande « abandonner »/.test(r.evs.find(e => e.type === 'result')?.result || ''), 'test réellement cassé : cause « tests », message inchangé');
reset();

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
