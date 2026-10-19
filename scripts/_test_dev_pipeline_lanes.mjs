#!/usr/bin/env node
// ============================================================================
// scripts/_test_dev_pipeline_lanes.mjs — P9 is active for orchestrateur-dev:
// its pipeline runs work in parallel lanes (0.115.0)
// ============================================================================
//
// User request (2026-10-18), verbatim: « orchestrateur-dev : il faut activer
// P9 ». Context: P9 (the pipeline engine in a lane) was in the dev branch only,
// while orchestrateur-dev's turns are run by the production dispatch.mjs, so
// rule `pipeline-engine` kept every pipeline run of orchestrateur-dev in lane 0
// (serial). The 2026-10-15 decision still holds: the production project keeps
// maxParallel 1, and only the dev instance gets pipeline lanes.
//
// Permanent requirement test, REAL dispatch.mjs + REAL engine, fake claude
// (FAKE_CLAUDE_PIPELINE), throw-away root (DISPATCH_ROOT_FOR_TESTS), with the
// production config shape (orchestrateur + orchestrateur-dev devOf it):
//   1. resolution: orchestrateur-dev → pipeline lanes on, maxParallel 2;
//      orchestrateur → maxParallel 1; an ordinary project → pipeline lanes off;
//   2. two pipeline runs of orchestrateur-dev at the same time, in two lanes
//      (worktree lane 1 and lane 0): both finish, overlap, both integrated;
//   3. an ordinary project's two pipeline runs stay serial in lane 0, the
//      wait justified by rule `pipeline-pilot` (system/lane_exclusive);
//   4. the real config.json (when present): same resolution for the fleet.
//
//   node scripts/_test_dev_pipeline_lanes.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const L = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lanes.mjs')).href);
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1500)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-devpipelanes-'));
const LOGS = path.join(T, 'logs');
const PROD = path.join(T, 'orchestrateur'), DEV = path.join(T, 'orchestrateur-dev'), X = path.join(T, 'X');
for (const d of [LOGS, PROD, DEV, X, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
function initRepo(dir) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
  fs.mkdirSync(path.join(dir, '.orchestrateur'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
  g(dir, 'init', '-q', '-b', 'master'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
}
initRepo(PROD); initRepo(DEV); initRepo(X);
// The production shape: no maxParallel anywhere, the dev instance names its production.
const config = {
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'orchestrateur', path: PROD },
    { name: 'orchestrateur-dev', path: DEV, devOf: 'orchestrateur', port: 7778 }, { name: 'X', path: X }],
};
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify(config));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' },
    'dev.rouge': { provider: 'anthropic', model: 'claude-opus-5-5' }, 'dev.vert': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'dev.revue': { provider: 'anthropic', model: 'claude-fable-5-1' }, 'dev.livrer': { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
  history: [], enforcement: { projects: ['orchestrateur', 'orchestrateur-dev', 'X'], pipelines: ['discussion', 'dev'] },
}, null, 2));
fs.writeFileSync(path.join(T, '.token'), 'a'.repeat(64));
const CLAUDE_JSON = path.join(T, 'claude.json');
fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ projects: {} }));

const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_TURN_LOCK_POLL_MS: '100', ORCH_CLAUDE_JSON: CLAUDE_JSON };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID',
  'ORCH_TURN_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'CLAUDECODE', 'FAKE_PIPE_BAD']) delete baseEnv[k];
const run = (args, env = {}) => new Promise((resolve) => {
  const t0 = Date.now();
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 300_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out, t0, t1: Date.now() }); });
});
const DEVRUN = ['--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple', '--source', 'chef'];
const events = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
const runIdIn = (out) => (/\b(p-\d{8}T\d{6}-[a-z0-9]{4,8})\b/.exec(out) || [])[1];
const runState = (r) => { try { return JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', r, 'run.json'), 'utf8')); } catch { return null; } };
const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
const byName = (n) => config.projects.find(p => p.name === n);

section('1. Résolution : orchestrateur-dev a les pipelines en couloir, la prod reste à 1, un autre projet reste en série');
{
  const dev = L.pipelineLanesInfo(config, byName('orchestrateur-dev'));
  ok(dev.value === true && dev.source === 'dev-pilot', `orchestrateur-dev : pipelines en couloir (${dev.source})`);
  ok(L.maxParallelFor(config, byName('orchestrateur-dev')) === 2, 'orchestrateur-dev : 2 couloirs (défaut)');
  const prod = L.maxParallelInfo(config, byName('orchestrateur'));
  ok(prod.value === 1 && prod.source === 'dev-pilot-first', `orchestrateur (prod) : maxParallel 1 (${prod.source}) — décision du 2026-10-15 gardée`);
  ok(L.pipelineLanesInfo(config, byName('orchestrateur')).value === false && L.pipelineLanesInfo(config, byName('X')).value === false, 'prod et projet ordinaire : pipelines hors couloir');
  ok(L.pipelineLanesInfo(config, { name: 'Y', pipelineLanes: true }).value === true && L.pipelineLanesInfo(config, { ...byName('orchestrateur-dev'), pipelineLanes: false }).value === false,
    '`pipelineLanes` de l’entrée prime (adhésion d’un projet, ou retour arrière pour la dev)');
}

section('2. Deux exécutions de pipeline de orchestrateur-dev en même temps, dans deux couloirs');
{
  const a = run(['orchestrateur-dev', 'Tâche A : ajoute double()', ...DEVRUN], { FAKE_CLAUDE_LATENCY_MS: '350' });
  await new Promise(r => setTimeout(r, 2500));
  const b = await run(['orchestrateur-dev', 'Tâche B : ajoute double() aussi', ...DEVRUN]);
  const ra = await a;
  const runA = runIdIn(ra.out), runB = runIdIn(b.out);
  const sa = runState(runA), sb = runState(runB);
  ok(ra.code === 0 && b.code === 0 && sa?.status === 'done' && sb?.status === 'done', `les deux exécutions finissent (codes ${ra.code}/${b.code}, ${sa?.status}/${sb?.status})`, `${ra.out.slice(-1500)}\n---\n${b.out.slice(-1500)}`);
  const lanes = [sa?.lane?.k || 0, sb?.lane?.k || 0].sort();
  ok(lanes[0] === 0 && lanes[1] === 1, `deux couloirs distincts : ${lanes.join(' et ')} (A ${sa?.lane?.k ?? 0}, B ${sb?.lane?.k ?? 0})`, JSON.stringify({ a: sa?.lane, b: sb?.lane }));
  ok(Math.min(ra.t1, b.t1) > Math.max(ra.t0, b.t0) && !/attente de sa fin|en série|aucun couloir libre|pipeline-engine|pipeline-pilot/.test(b.out),
    'les deux exécutions se recouvrent : B n’a pas attendu A (aucune règle de série)', b.out.slice(-800));
  ok(!events(path.join(LOGS, 'orchestrateur-dev.jsonl')).some(e => e.subtype === 'lane_exclusive'), 'aucun « ⛓ En série » dans le journal de orchestrateur-dev');
  const end = events(path.join(LOGS, 'orchestrateur-dev.jsonl')).find(e => e.subtype === 'lane_task' && e.state === 'done' && e.lane === 1);
  ok(end?.outcome === 'integrated' && version(DEV) === '1.1.0', `l’exécution du couloir 1 est intégrée, les deux livraisons sont sur master (version ${version(DEV)})`, JSON.stringify(end));
}

section('3. Projet ordinaire : ses exécutions de pipeline restent en série dans la copie principale (règle pipeline-pilot)');
{
  const a = run(['X', 'Tâche X1 : ajoute double()', ...DEVRUN], { FAKE_CLAUDE_LATENCY_MS: '350' });
  await new Promise(r => setTimeout(r, 2500));
  const b = await run(['X', 'Tâche X2 : ajoute double() aussi', ...DEVRUN]);
  const ra = await a;
  const sa = runState(runIdIn(ra.out)), sb = runState(runIdIn(b.out));
  ok(ra.code === 0 && sa?.status === 'done' && !sa.lane, `X1 : dans la copie principale (code ${ra.code}, ${sa?.status})`, ra.out.slice(-1200));
  ok(sb && !sb.lane && /en série.*pipeline-pilot/.test(b.out), 'X2 attend X1, justifié par la règle pipeline-pilot', b.out.slice(-1200));
  const ex = events(path.join(LOGS, 'X.jsonl')).find(e => e.subtype === 'lane_exclusive');
  ok(ex?.rule === 'pipeline-pilot' && /orchestrateur-dev/.test(ex.text || ''), `« ⛓ En série » journalisé avec sa justification (${ex?.rule})`, JSON.stringify(ex));
  ok(!fs.existsSync(path.join(T, 'lanes', 'X')), 'aucun worktree créé pour X');
}

section('4. Vrai config.json : orchestrateur-dev seul a ses pipelines en couloir');
{
  let real = null;
  try { real = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
  const devs = (real?.projects || []).filter(p => p?.devOf);
  if (!devs.length) console.log('  · pas de config.json avec une instance de dev ici (copie de test) : section sans objet');
  else {
    for (const d of devs) {
      ok(L.pipelineLanesInfo(real, d).value === true && L.maxParallelFor(real, d) >= 2, `${d.name} : pipelines en couloir, ${L.maxParallelFor(real, d)} couloirs`);
      const prod = real.projects.find(p => p.name === d.devOf);
      if (prod) ok(L.maxParallelFor(real, prod) === 1, `${prod.name} (prod) : maxParallel 1`);
    }
    const others = real.projects.filter(p => !p.devOf && p.pipelineLanes !== true && real.defaults?.pipelineLanes !== true);
    ok(others.every(p => L.pipelineLanesInfo(real, p).value === false), `les ${others.length} autres projets gardent leurs pipelines dans la copie principale`);
  }
}

srv.close();
try { for (const [dir, n] of [[DEV, 'orchestrateur-dev'], [X, 'X']]) for (const k of [1, 2, 3]) { const w = path.join(T, 'lanes', n, String(k)); if (fs.existsSync(w)) g(dir, 'worktree', 'remove', '--force', w); } } catch {}
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exitCode = fail ? 1 : 0;
