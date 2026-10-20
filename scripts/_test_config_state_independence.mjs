#!/usr/bin/env node
// ============================================================================
// scripts/_test_config_state_independence.mjs — a switchable state of the
// installation never makes a suite fail, and a suite never changes it (0.119.0)
// ============================================================================
//
// User request (2026-10-20), verbatim: « Il faut corriger le teste : s'il est
// necessaire que l'on soit en pipeline pour le test, il faut etre capable de
// passer en pipleline seul, puis le remettre comme il etait apres le test. Un
// seul status n'est pas une source de bug. »
// Real case: after the jump to v0.118.0 the production regression went red
// on _test_dev_instance_pipelines.mjs (« orchestrateur-dev : dans
// enforcement.projects ») because the user had taken orchestrateur-dev out of
// the pipelines on 2026-10-19 — a legitimate state, not a bug.
//
// Permanent requirement test:
//   1. the suites that look at the real installation pass in every state of
//      its switches (dev instance in / out of the pipelines, no
//      model-routing.json, lanes switched off, maxParallel 1), run against a
//      throw-away "real" root (ORCH_REAL_ROOT_FOR_TESTS);
//   2. that root is byte-identical before and after each run, and so are the
//      state files of this checkout;
//   3. static guard: no suite reads a state file of the real root directly
//      (it goes through tests/real-config.mjs and an isolated copy).
//
//   node scripts/_test_config_state_independence.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stateHashes } from '../tests/real-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = ['_test_dev_instance_pipelines.mjs', '_test_dev_pipeline_lanes.mjs'];
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1500)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-statefree-'));
const DEV = path.join(T, 'Dev', 'orchestrateur-dev');
fs.mkdirSync(path.join(DEV, '.orchestrateur'), { recursive: true });
fs.copyFileSync(path.join(ROOT, '.orchestrateur', 'pipeline.json'), path.join(DEV, '.orchestrateur', 'pipeline.json'));
const PROD = path.join(T, 'orchestrateur');
fs.mkdirSync(PROD, { recursive: true });

const baseConfig = () => ({
  conductor: 'chef', defaults: { model: 'claude-sonnet-5-5', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'Chef') }, { name: 'orchestrateur', path: PROD },
    { name: 'orchestrateur-dev', path: DEV, devOf: 'orchestrateur', port: 7778 }, { name: 'autre', path: path.join(T, 'autre') }],
});
const routing = (projects) => ({ version: 2, assignments: {}, history: [], enforcement: { projects, pipelines: ['discussion', 'dev'], chef: false } });
const STATES = [
  { id: 'hors-pipeline', label: 'orchestrateur-dev hors des pipelines (la prod du 2026-10-20)', config: baseConfig(), routing: routing(['orchestrateur', 'autre']) },
  { id: 'en-pipeline', label: 'orchestrateur-dev en service', config: baseConfig(), routing: routing(['orchestrateur', 'orchestrateur-dev', 'autre']) },
  { id: 'sans-routing', label: 'aucun model-routing.json', config: baseConfig(), routing: null },
  { id: 'interrupteurs', label: 'couloirs coupés sur la dev, defaults.maxParallel 1 (retours arrière documentés)',
    config: (() => { const c = baseConfig(); c.defaults.maxParallel = 1; c.projects[2].pipelineLanes = false; c.projects[1].maxParallel = 1; return c; })(),
    routing: routing(['orchestrateur-dev']) },
];

const snapshotDir = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(T, f)] = fs.readFileSync(f).toString('base64'); } };
  walk(dir);
  return JSON.stringify(out);
};

// ---------------------------------------------------------------------------
section('1-2. Chaque état des interrupteurs : suites vertes, état identique avant/après');
const ownBefore = stateHashes(ROOT);
for (const s of STATES) {
  const R = path.join(T, `real-${s.id}`);
  fs.mkdirSync(R, { recursive: true });
  fs.writeFileSync(path.join(R, 'config.json'), JSON.stringify(s.config, null, 2));
  if (s.routing) fs.writeFileSync(path.join(R, 'model-routing.json'), JSON.stringify(s.routing, null, 2));
  for (const suite of SUITES) {
    const before = snapshotDir(R);
    const devBefore = snapshotDir(DEV);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', suite)], {
      env: { ...process.env, ORCH_REAL_ROOT_FOR_TESTS: R, ORCH_REAL_CONFIG_ONLY: '1' }, encoding: 'utf8', windowsHide: true, timeout: 180_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    ok(r.status === 0, `${s.label} — ${suite} vert (exit ${r.status})`, out.split('\n').filter(l => /✗|Error/.test(l)).join('\n') || out.slice(-800));
    ok(snapshotDir(R) === before && snapshotDir(DEV) === devBefore, `${s.label} — ${suite} : configuration « réelle » identique, octet pour octet, après le test`);
  }
}
ok(JSON.stringify(stateHashes(ROOT)) === JSON.stringify(ownBefore), 'fichiers d’état de ce dépôt (config.json, model-routing.json, langue, règles) inchangés');

// ---------------------------------------------------------------------------
section('3. Garde statique : aucune suite ne lit l’état réel en direct');
{
  const STATE_RE = /path\.join\(\s*(ROOT|REPO|DEV|REAL)\s*,\s*'(model-routing|language-settings|permission-rules)\.json'\s*\)|readEnforcement\(\s*(ROOT|REPO)\s*\)/;
  const offenders = fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => /^_test_.*\.mjs$/.test(f) && f !== path.basename(fileURLToPath(import.meta.url)))
    .filter(f => {
      const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
      // A suite whose ROOT is a throw-away directory may read it (its own fixture).
      if (/const ROOT\s*=\s*path\.join\(\s*T\b/.test(src) || /const ROOT\s*=\s*fs\.mkdtempSync/.test(src)) return false;
      return STATE_RE.test(src);
    });
  ok(!offenders.length, `aucune suite ne lit model-routing.json, language-settings.json ou permission-rules.json de la vraie racine (${offenders.length} trouvée(s))`, offenders.join(', '));
  for (const f of SUITES) ok(/tests\/real-config\.mjs/.test(fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8')), `${f} passe par tests/real-config.mjs`);
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
