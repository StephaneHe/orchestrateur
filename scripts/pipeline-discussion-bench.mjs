#!/usr/bin/env node
// ============================================================================
// scripts/pipeline-discussion-bench.mjs — Discussion in one call against the
// three-step Discussion, with REAL model turns (pipelines phase 1, lever 6)
// ============================================================================
//
// Exit criterion of phase 1 (PIPELINES-SYNTHESE §8.2): « Discussion ≤ 70 s ».
// The same question, on a throwaway copy of a few files of this repository,
// through the real dispatch.mjs and engine: once with the switch
// `discussionOne`, once without. The models are the production's choices for
// the Discussion cases (read-only from --routing, else given). Real turns
// (subscription billing, never an API key), throwaway root
// (DISPATCH_ROOT_FOR_TESTS), never port 7777. Outside the regression.
//
//   node scripts/pipeline-discussion-bench.mjs [--routing <model-routing.json>] [--question "…"] [--md <file>]
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENGINE_PIPELINES } from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const question = opt('--question', 'Dans ce projet, comment les tests sont-ils lancés et où est déclarée la commande de test ? Réponds en citant les fichiers.');
let assignments = { 'discussion.comprendre': { provider: 'anthropic', model: 'claude-opus-5-5' }, 'discussion.rechercher': { provider: 'anthropic', model: 'claude-sonnet-5-5' }, 'discussion.repondre': { provider: 'anthropic', model: 'claude-opus-5-5' } };
// The production's switches (phase 0 levers), so the comparison is the one the fleet would see.
let prodTuning = {};
if (opt('--routing')) {
  const j = JSON.parse(fs.readFileSync(opt('--routing'), 'utf8'));
  prodTuning = j.enforcement?.tuning || {};
  const a = j.assignments || {};
  for (const k of Object.keys(assignments)) if (a[k]?.model) assignments[k] = { provider: a[k].provider, model: a[k].model };
}

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-discbench-'));
const P = path.join(T, 'P');
fs.mkdirSync(path.join(T, 'logs'), { recursive: true });
fs.mkdirSync(path.join(T, 'chef'), { recursive: true });
for (const f of ['package.json', 'README.md', '.orchestrateur/pipeline.json', 'scripts/suite-runner.mjs']) {
  const from = path.join(ROOT, f);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(path.dirname(path.join(P, f)), { recursive: true });
  fs.copyFileSync(from, path.join(P, f));
}
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8', windowsHide: true });
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', defaults: { model: 'claude-sonnet-5-5', allowedTools: 'Read,Edit,Write,Bash,Grep,Glob', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }] }));
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, ORCH_PERM_DISABLE: '1', ORCH_PORT: '9' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_REQUEST_ID', 'CLAUDE_BIN']) delete env[k];

const rows = [];
for (const [label, tuning] of [['en un appel (discussionOne)', { ...prodTuning, discussionOne: true }], ['classique (3 étapes)', { ...prodTuning }]]) {
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, history: [], assignments, enforcement: { projects: ['P'], pipelines: ENGINE_PIPELINES, tuning } }, null, 2));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', question, '--pipeline', 'discussion', '--test', `banc ${label}`], { env, encoding: 'utf8', timeout: 900_000, windowsHide: true });
  const runs = fs.readdirSync(path.join(T, 'logs', 'runs')).sort();
  const st = JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', runs.at(-1), 'run.json'), 'utf8'));
  const steps = st.steps.map(s => `${s.id} ${Math.round((s.durationMs || 0) / 1000)} s (${s.model || '—'}, ${s.status}${s.why ? ` : ${String(s.why).split('\n')[0].slice(0, 160)}` : ''})`).join(' ; ');
  rows.push(`| ${label} | ${st.status} | ${Math.round((st.activeMs || 0) / 1000)} s | ${Math.round((Date.now() - t0) / 1000)} s | ${st.steps.filter(s => s.model).length} | ${steps} |`);
  console.log(rows.at(-1));
  if (r.status !== 0) console.log(`  (code ${r.status}) ${(r.stderr || '').slice(-400)}`);
}
const md = [`Banc Discussion, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} — question : « ${question} »`, '',
  '| variante | statut | temps actif | mur | appels | étapes |', '|---|---|---|---|---|---|', ...rows].join('\n');
if (opt('--md')) fs.writeFileSync(opt('--md'), `${md}\n`);
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${md}`);
