#!/usr/bin/env node
// ============================================================================
// scripts/_test_suite_cache.mjs — pipelines phase 0 c: a green suite is not
// re-run on an identical tree (switch `suiteCache`)
// ============================================================================
//
// User request (2026-10-20, phase 0 of the pipeline redesign, « tout comme
// recommandé »): « Une suite de tests n'est pas relancée sur un arbre
// identique : résultat vert mis en cache par empreinte d'arbre. » — and the
// TDD guarantees stay unchanged.
//
// Protected:
//   - same tree + same command + same environment + green ⇒ not re-run, the
//     reuse is said (event `pipeline_suite_cached`, step `test.cached`);
//   - NEVER reused across trees: a changed or a new (untracked) file, another
//     command, a relevant environment variable, an expired entry ⇒ re-run;
//   - a red result is never kept (Rouge, a failing Vert always run for real);
//   - the project's own git index is never touched;
//   - end to end: a second Development run starting on the tree the first one
//     delivered (and verified green) skips its precondition suite; switch off
//     = the suite runs every time, as before.
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_suite_cache.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cachedSuite, envFingerprint } from './suite-cache.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-suitecache-'));

// ---------------------------------------------------------------------------
section('1. Le cache : même arbre seulement, vert seulement');
{
  const R = path.join(T, 'unit');
  fs.mkdirSync(path.join(R, 'src'), { recursive: true });
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: R, encoding: 'utf8' });
  fs.writeFileSync(path.join(R, 'src', 'a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(R, '.gitignore'), 'build/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const idxBefore = fs.statSync(path.join(R, '.git', 'index')).mtimeMs;
  let runs = 0, green = true;
  const run = () => { runs++; return { ok: green, code: green ? 0 : 1, out: 'sortie', ms: 1234 }; };
  const env = { PATH: 'x', NODE_ENV: 'test', ORCH_TURN_ID: 't1' };
  const o = (extra = {}) => ({ cwd: R, command: 'npm test', env, indexFile: path.join(T, 'unit.idx'), file: path.join(T, 'cache', 'unit.json'), ...extra });
  let t = cachedSuite(o(), run);
  ok(runs === 1 && t.ok && !t.cached, 'premier passage : la suite tourne');
  t = cachedSuite(o(), run);
  ok(runs === 1 && t.ok && t.cached?.ms === 1234 && /non relancée/.test(t.out), `même arbre : résultat vert réutilisé, durée évitée gardée (${t.out.slice(0, 80)}…)`);
  t = cachedSuite(o({ env: { ...env, ORCH_TURN_ID: 't2', CLAUDECODE: '1' } }), run);
  ok(runs === 1 && t.cached, 'variable propre à un tour qui change : toujours le même arbre testé, réutilisé');
  fs.mkdirSync(path.join(R, 'build')); fs.writeFileSync(path.join(R, 'build', 'out.txt'), 'x');
  t = cachedSuite(o(), run);
  ok(runs === 1 && t.cached, 'fichier ignoré par git : hors de l’empreinte (documenté)');
  fs.writeFileSync(path.join(R, 'src', 'a.mjs'), 'export const a = 2;\n');
  t = cachedSuite(o(), run);
  ok(runs === 2 && !t.cached, 'un fichier suivi modifié : relancée');
  fs.writeFileSync(path.join(R, 'src', 'b.mjs'), 'export const b = 1;\n');
  t = cachedSuite(o(), run);
  ok(runs === 3 && !t.cached, 'un nouveau fichier non suivi : relancée');
  cachedSuite(o({ command: 'npm run test:all' }), run);
  ok(runs === 4, 'autre commande : relancée');
  cachedSuite(o({ env: { ...env, NODE_ENV: 'production' } }), run);
  ok(runs === 5, 'variable d’environnement utile qui change : relancée');
  fs.writeFileSync(path.join(R, 'src', 'b.mjs'), 'export const b = 2;\n');
  green = false;
  cachedSuite(o(), run); t = cachedSuite(o(), run);
  ok(runs === 7 && !t.ok && !t.cached, 'résultat rouge : jamais gardé, relancé à chaque fois');
  green = true;
  process.env.ORCH_SUITE_CACHE_TTL_MS = '1';
  cachedSuite(o(), run); await new Promise(r => setTimeout(r, 5)); cachedSuite(o(), run);
  delete process.env.ORCH_SUITE_CACHE_TTL_MS;
  ok(runs === 9, 'entrée trop ancienne : relancée');
  ok(fs.statSync(path.join(R, '.git', 'index')).mtimeMs === idxBefore && g('status', '--porcelain').stdout.includes('?? src/b.mjs'), 'l’index git du projet n’est jamais touché (index privé)');
  ok(envFingerprint({ A: '1', ORCH_TURN_ID: 'x' }) === envFingerprint({ A: '1', ORCH_TURN_ID: 'y' }) && envFingerprint({ A: '1' }) !== envFingerprint({ A: '2' }), 'empreinte d’environnement : sans les variables d’un tour');
}

// ---------------------------------------------------------------------------
section('2. De bout en bout : la 2ᵉ exécution part de l’arbre livré et vérifié vert — sa précondition n’est pas relancée');
const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
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
const COUNT = path.join(T, 'suite-runs.txt');
fs.writeFileSync(path.join(T, 'count.mjs'), `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(COUNT)}, 'x');\n`);
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: `node "${path.join(T, 'count.mjs')}" && ${FAST_TEST_COMMAND}`, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_BIG', 'FAKE_PIPE_REFACTOR', 'ORCH_SUITE_CACHE_TTL_MS']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runs = () => { try { return fs.readFileSync(COUNT, 'utf8').length; } catch { return 0; } };
const go = async (args) => {
  const n0 = logOf().length, c0 = runs();
  const r = await dispatch(args);
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
  return { ...r, evs, run, suites: runs() - c0, state: run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : {} };
};
{
  routing(null);
  let a = await go(['Ajoute la multiplication par deux', '--mode', 'leger', '--kind', 'simple']);
  let b = await go(['Ajoute la multiplication par trois', '--mode', 'leger', '--kind', 'simple']);
  // The 2nd run stops at Rouge (the fake model rewrites the same test): only its precondition matters here.
  ok(a.code === 0 && b.suites >= 1 && !a.evs.concat(b.evs).some(e => e.subtype === 'pipeline_suite_cached'), `interrupteur coupé : aucune réutilisation, la précondition de la 2ᵉ exécution tourne (suites lancées : ${a.suites} puis ${b.suites})`, a.out.slice(-600) + b.out.slice(-600));
  const offB = b.suites;

  g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur');
  routing({ suiteCache: ['P'] });
  a = await go(['Ajoute la multiplication par quatre', '--mode', 'leger', '--kind', 'simple']);
  b = await go(['Ajoute la multiplication par cinq', '--mode', 'leger', '--kind', 'simple']);
  const hit = b.evs.find(e => e.subtype === 'pipeline_suite_cached');
  ok(a.code === 0 && a.state.status === 'done', `1ʳᵉ exécution terminée et livrée (${a.state.status})`, a.out.slice(-600));
  ok(b.evs.findIndex(e => e.subtype === 'pipeline_suite_cached') < b.evs.findIndex(e => e.subtype === 'pipeline_step_start'), 'la réutilisation est celle de la précondition, avant la première étape');
  ok(hit && /non relancée/.test(hit.text) && hit.tree, `2ᵉ exécution : précondition sur l’arbre livré par la 1ʳᵉ, non relancée (${hit?.text})`);
  ok(b.suites === offB - 1, `une suite de moins que sans le cache (${b.suites} au lieu de ${offB})`);
  ok(b.state.suiteCache?.hits === 1 && b.state.tuning?.suiteCache === true, `run.json : 1 réutilisation comptée, réglage figé (${JSON.stringify(b.state.suiteCache)})`);
  const rouge = (a.state.steps || []).find(s => s.id === 'rouge');
  ok(rouge?.status === 'ok' && rouge.test && !rouge.test.cached && rouge.test.ok === false, 'Rouge : la suite rouge tourne réellement (jamais mémorisée) — garantie TDD inchangée');
}

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* Windows: a file may still be open */ }
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
