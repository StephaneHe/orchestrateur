#!/usr/bin/env node
// ============================================================================
// scripts/_test_no_escalate.mjs — a light run that must stay light (0.159.0)
// ============================================================================
//
// User request (2026-10-29): « concentres toi sur une étude de réduction des
// délais, et appliques tes recommandations au plus tôt ». Light Development
// runs asked « Pas de montée en complet » still climbed to the full mode
// (107 and 127 min, 13 items of 15 « déjà assurés par le code existant »).
//
// Protected here, on the REAL dispatch.mjs and engine (fake claude):
//   1. --no-escalate: a light run over its scope never climbs to the full
//      mode; it delivers what is done and lists the rest in « Reste à demander
//      séparément » (reste.md, final result);
//   2. « pas de montée en complet » in the request does the same, case and
//      accents ignored;
//   3. an item already covered by the existing code (DEJA_COUVERT) does not
//      count in the items limit.
//
//   node scripts/_test_no_escalate.mjs
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

const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-noescalate-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } },
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

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_|STEP_TOKEN|OBS_ID|TEST_LABEL|PIPE_ITEMS)|^DISPATCH_SLOT$|^FAKE_PIPE_/.test(k)) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const go = async (args, env) => { const n0 = logOf().length; const r = await dispatch(args, env); const evs = logOf().slice(n0); return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run }; };

const stayedLight = (r, label) => {
  ok(r.code === 0, `${label} : exécution terminée (code ${r.code})`, r.out.slice(-1500));
  const st = r.run ? runState(r.run) : {};
  ok(!r.evs.some(e => e.subtype === 'pipeline_escalate') && st.mode === 'leger' && !st.escalated,
    `${label} : aucune montée en complet (mode ${st.mode})`);
  ok(r.evs.some(e => e.subtype === 'pipeline_escalate_refused'), `${label} : périmètre dépassé tracé (pipeline_escalate_refused)`);
  const res = r.evs.find(e => e.type === 'result')?.result || '';
  const artDir = path.join(P, '.orchestrateur', 'runs', r.run || '-');
  ok(/Reste à demander séparément/.test(res) && /périmètre du mode léger/.test(res) && fs.existsSync(path.join(artDir, 'reste.md')),
    `${label} : le reste est listé dans « Reste à demander séparément » et reste.md`, res.slice(-800));
  ok(r.evs.some(e => e.subtype === 'pipeline_step_done' && e.pipeline.step === 'livrer' && e.status === 'ok'), `${label} : ce qui est fait est livré`);
};

// ---------------------------------------------------------------------------
section('1. --no-escalate : une exécution légère hors périmètre reste légère');
reset();
stayedLight(await go(['Ajoute double(x)', '--pipeline', 'dev', '--mode', 'leger', '--no-escalate'], { FAKE_PIPE_BIG: '1' }), '--no-escalate');

// ---------------------------------------------------------------------------
section('2. « pas de montée en complet » dans la demande, casse et accents ignorés');
ok(['Pas de montée en complet.', 'PAS DE MONTEE EN COMPLET', 'pas  de   montée en Complet'].every(E.noEscalateRequested) && !E.noEscalateRequested('montée en complet si besoin'),
  'phrase reconnue sans tenir compte de la casse, des accents ni des espaces ; absente = non');
reset();
stayedLight(await go(['Ajoute double(x). PAS DE MONTEE EN COMPLET', '--pipeline', 'dev', '--mode', 'leger'], { FAKE_PIPE_BIG: '1' }), 'phrase');

// ---------------------------------------------------------------------------
section('3. Item déjà assuré par le code existant : hors de la limite d’items');
reset();
{
  const r = await go(['Ajoute double(x) et triple(x)', '--pipeline', 'dev', '--mode', 'complet', '--kind', 'simple'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_COVERED: '1' });
  ok(r.code === 0, `exécution terminée (code ${r.code})`, r.out.slice(-1500));
  const st = r.run ? runState(r.run) : {};
  ok(r.evs.some(e => e.subtype === 'pipeline_item_covered' && e.pipeline.item === 1), 'item 1 accepté comme déjà couvert');
  ok(st.itemsDone === 1 && st.coveredDone === 1, `seul l’item non couvert compte dans la limite (itemsDone ${st.itemsDone}, couverts ${st.coveredDone})`);
}

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} ko`);
process.exit(fail ? 1 : 0);
