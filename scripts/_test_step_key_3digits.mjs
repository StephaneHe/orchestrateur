#!/usr/bin/env node
// ============================================================================
// scripts/_test_step_key_3digits.mjs — step keys with 3 digits or more (0.64.1)
// ============================================================================
//
// Incident (2026-10-09, run p-20261009T193934-083679 of a fleet project):
// from its 100th step the engine names a step "100-vert", but dispatch.mjs
// validated --pipeline-step with exactly 2 digits; steps 100-vert to 113-vert
// were all refused (code 64, « --pipeline-step invalide ») before any model
// call, and the run stayed paused. STEP_KEY_RE had the same flaw.
//
// Protected: a step key has 2 digits OR MORE (01-comprendre … 113-vert); a
// paused run past its 99th step resumes with « continuer ».
//
//   node scripts/_test_step_key_3digits.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STEP_KEY_RE } from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. La règle des clés d’étape');
ok(['01-comprendre', '99-vert', '100-vert', '113-vert', '1234-livrer'].every(k => STEP_KEY_RE.test(k)), 'STEP_KEY_RE : 2 chiffres ou plus (01-comprendre, 99-vert, 100-vert, 113-vert, 1234-livrer)');
ok(!['1-vert', 'vert', '100-Vert', '100_vert', '100-', '1234567-vert'].some(k => STEP_KEY_RE.test(k)), 'refusées : 1 chiffre, sans numéro, majuscule, souligné, nom vide, numéro démesuré');

// ---------------------------------------------------------------------------
section('2. Vrai dispatch.mjs : « 113-vert » n’est plus refusé à la lecture des arguments');
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stepkey-arg-'));
  const P = path.join(T, 'proj');
  for (const d of [path.join(T, 'logs'), P]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read' }, projects: [{ name: 'P', path: P }] }));
  const run = (key) => {
    const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE };
    for (const k of ['ANTHROPIC_API_KEY', 'ORCH_STEP_TOKEN', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_FAKE_STEP_REFUSAL']) delete env[k];
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', 'x', '--pipeline-step', `p-20261009T193934-083679:${key}`, '--pipeline-session', 'code'], { env, encoding: 'utf8', timeout: 60_000 });
  };
  for (const key of ['100-vert', '113-vert']) {
    const r = run(key);
    ok(!/--pipeline-step invalide/.test(r.stderr), `« ${key} » : plus de refus « --pipeline-step invalide » (sortie : ${String(r.stderr).trim().split('\n').pop()?.slice(0, 120)})`);
  }
  const r1 = run('1-vert');
  ok(r1.status === 64 && /--pipeline-step invalide/.test(r1.stderr), '« 1-vert » (1 chiffre) reste refusé (64)');
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
section('3. Une exécution en pause après sa 99ᵉ étape repart avec « continuer » (cas réel : étape 113-vert)');
{
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stepkey-'));
  const P = path.join(T, 'proj');
  for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
    conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
    projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
  }));
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
    version: 2, assignments: Object.fromEntries(['rouge', 'vert', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])),
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
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
    ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_NO_PENDING_RELEASE: '1' };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'ORCH_FAKE_STEP_REFUSAL']) delete env[k];
  const dispatch = (args, extra = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...env, ...extra }, windowsHide: true });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => c.kill(), 180_000);
    c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
  });
  const logOf = () => fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let r = await dispatch(['Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_BAD: 'vert' });
  const run = logOf().find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
  const f = path.join(T, 'logs', 'runs', run, 'run.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  ok(r.code === 2 && s.status === 'paused' && s.plan[s.index] === 'vert', `exécution en pause sur 4b (code ${r.code}, étape « ${s.plan[s.index]} »)`, r.out.slice(-600));
  // As in the real run: 113 steps already recorded (100-vert … 113-vert refused).
  while (s.steps.length < 113) {
    const n = s.steps.length + 1;
    s.steps.push({ id: 'vert', key: `${String(n).padStart(2, '0')}-vert`, title: '4b Vert', status: 'launch_failed', why: 'lancement impossible (code 64)', attempt: 1, durationMs: 0 });
  }
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  const n0 = logOf().length;
  r = await dispatch(['continuer']);
  const evs = logOf().slice(n0);
  const done = evs.filter(e => e.subtype === 'pipeline_step_done');
  const vert = done.find(e => e.pipeline.step === 'vert');
  ok(r.code === 0 && vert?.pipeline?.key === '114-vert' && vert.status === 'ok', `« continuer » : l’étape 114-vert passe (code ${r.code}, ${done.map(d => `${d.pipeline.key}:${d.status}`).join(', ')})`, r.out.slice(-800));
  ok(!evs.some(e => /--pipeline-step invalide/.test(JSON.stringify(e))) && !evs.some(e => e.status === 'launch_refused'), 'aucun refus « --pipeline-step invalide » ni « lancement refusé »');
  ok(done.some(d => d.pipeline.key === '116-livrer' && d.status === 'ok') && JSON.parse(fs.readFileSync(f, 'utf8')).status === 'done', 'puis Revue (115) et Livrer (116) : exécution terminée');
  srv.close();
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
