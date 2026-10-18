#!/usr/bin/env node
// ============================================================================
// scripts/_test_dev_instance_pipelines.mjs — orchestrateur-dev works with the
// pipelines (0.113.0)
// ============================================================================
//
// User request (2026-10-18), verbatim: « Il faut que orchestrateur-dev
// fonctionne avec des pipelines », then « Ok, passes orchestrateur-dev en
// service. » (option A: targeted regression without the browser stage as the
// test command, 30 min test timeout).
//
// Protected:
//   1. testTimeoutMs: a project's `testTimeoutMin` (1..120) replaces the
//      10 min default of the engine's test command;
//   2. real dispatch.mjs: a dev instance (`devOf`, lanes on) in service has
//      its turns run by the pipeline engine — a Discussion and a light
//      Development (test command really run), never an ordinary turn;
//   3. this machine: every dev instance declared in config.json (`devOf`) is
//      in enforcement.projects, and its .orchestrateur/pipeline.json declares
//      the targeted regression without browser and testTimeoutMin 30.
//
//   node scripts/_test_dev_instance_pipelines.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testTimeoutMs, TEST_TIMEOUT_MAX_MIN, readEnforcement, isEnforced } from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const DEV_TEST_COMMAND = 'node scripts/regression.mjs --targeted --no-browser';
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Délai de la commande de test : testTimeoutMin du projet');
{
  ok(testTimeoutMs({}) === 10 * 60_000 && testTimeoutMs(null) === 10 * 60_000, 'sans réglage : 10 min (comportement d’avant)');
  ok(testTimeoutMs({ testTimeoutMin: 30 }) === 30 * 60_000, 'testTimeoutMin 30 : 30 min');
  ok(testTimeoutMs({ testTimeoutMin: TEST_TIMEOUT_MAX_MIN }) === TEST_TIMEOUT_MAX_MIN * 60_000, `plafond accepté (${TEST_TIMEOUT_MAX_MIN} min)`);
  ok([0, -5, TEST_TIMEOUT_MAX_MIN + 1, 2.5, '30', true].every(v => testTimeoutMs({ testTimeoutMin: v }) === 10 * 60_000),
    'valeur invalide (0, négative, hors plafond, décimale, texte) : défaut de 10 min');
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'pipeline-engine.mjs'), 'utf8');
  const calls = src.match(/runCommand\([^;\n]*\.(testCommand|buildCommand)[^;\n]*\)/g) || [];
  ok(calls.length >= 8 && calls.every(c => /testTimeoutMs\(/.test(c)), `chaque lancement de la commande de test ou de build passe le délai du projet (${calls.length} appels)`,
    calls.filter(c => !/testTimeoutMs\(/.test(c)).join('\n'));
}

// ---------------------------------------------------------------------------
section('2. Vrai dispatch : les tours d’une instance de dev en service passent par un pipeline');
{
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-devinst-'));
  const P = path.join(T, 'orchestrateur-dev');
  const PROD = path.join(T, 'orchestrateur');
  for (const d of [path.join(T, 'logs'), P, PROD, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
    conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
    projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'orchestrateur', path: PROD },
      { name: 'orchestrateur-dev', path: P, devOf: 'orchestrateur', port: 7778 }],
  }));
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
    version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' },
      ...Object.fromEntries(['rouge', 'vert', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
    history: [], enforcement: { projects: ['orchestrateur-dev'], pipelines: ['discussion', 'dev'] },
  }));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  for (const d of ['test', 'src', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
  fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-18\n\n### Added\n\n- init\n');
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', testTimeoutMin: 30 }));
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', FAKE_CLAUDE_ECHO_MODEL: '1',
    ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_NO_PENDING_RELEASE: '1' };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ORCH_TURN_ID',
    'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_CLAUDE_CLASSIFY']) delete env[k];
  const go = (args, extra) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'orchestrateur-dev', ...args], { env: { ...env, ...extra }, windowsHide: true });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => c.kill(), 180_000);
    c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
  });
  const LOG = path.join(T, 'logs', 'orchestrateur-dev.jsonl');
  const events = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const turnFrom = (n) => events().slice(n);

  // 2a. Discussion chosen by the classifier model (no explicit choice).
  let r = await go(['Explique comment fonctionnent les couloirs'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'leger', raison: 'question' }) });
  let evs = turnFrom(0);
  let up = evs.find(e => e.type === 'user_prompt');
  ok(r.code === 0 && up?.pipeline?.pipeline === 'discussion', `demande sans choix : classée par le model et exécutée en Discussion (code ${r.code}, pipeline ${up?.pipeline?.pipeline})`, r.out.slice(-800));
  ok(evs.some(e => e.subtype === 'pipeline_start') && evs.some(e => e.type === 'result' && !e.is_error), 'exécution de pipeline ouverte et close par un result réussi');
  ok(!evs.some(e => e.subtype === 'pipeline_bypass' || e.subtype === 'pipeline_hors_pipeline'), 'aucun contournement, aucun tour hors pipeline');

  // 2b. Light Development: the project's test command is really run by the engine.
  const before = events().length;
  r = await go(['Ajoute la fonction double', '--mode', 'leger'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'dev', mode: 'leger', nature: 'simple', raison: 'petite fonction' }) });
  evs = turnFrom(before);
  up = evs.find(e => e.type === 'user_prompt');
  const steps = evs.filter(e => e.subtype === 'pipeline_step_done');
  ok(up?.pipeline?.pipeline === 'dev', `demande de développement : pipeline « dev » (reçu ${up?.pipeline?.pipeline})`, r.out.slice(-800));
  ok(steps.some(s => /rouge/.test(s.pipeline?.step || '')) && steps.some(s => /vert/.test(s.pipeline?.step || '')),
    `étapes du Développement jouées (${steps.map(s => `${s.pipeline?.step}:${s.status}`).join(', ')})`);
  ok(r.code === 0 && evs.filter(e => e.type === 'result').pop()?.is_error === false, `exécution terminée sans erreur (code ${r.code})`, r.out.slice(-1200));
  srv.close();
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
section('3. Ce poste : chaque instance de dev déclarée est en service');
{
  let config = null;
  try { config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { /* clone without config */ }
  const devs = (config?.projects || []).filter(p => p && p.devOf);
  if (!devs.length) {
    ok(true, 'aucune instance de dev déclarée dans config.json (clone ou bac à sable) : rien à vérifier ici');
  } else {
    const enf = readEnforcement(ROOT);
    for (const d of devs) {
      ok(isEnforced(enf, d.name), `${d.name} : dans enforcement.projects (model-routing.json)`);
      let pj = null;
      try { pj = JSON.parse(fs.readFileSync(path.join(d.path, '.orchestrateur', 'pipeline.json'), 'utf8')); } catch (e) { pj = { error: e.message }; }
      ok(pj?.testCommand === DEV_TEST_COMMAND, `${d.name} : testCommand « ${DEV_TEST_COMMAND} »`, JSON.stringify(pj));
      ok(pj?.testTimeoutMin === 30 && testTimeoutMs(pj) === 30 * 60_000, `${d.name} : testTimeoutMin 30 (délai réel ${testTimeoutMs(pj || {}) / 60_000} min)`);
      ok(pj?.lanes && Array.isArray(pj.lanes.copy) && pj.lanes.copy.includes('config.json') && (pj.lanes.link || []).includes('node_modules'),
        `${d.name} : couloirs prêts pour la non-régression (config.json copié, node_modules lié)`);
    }
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
