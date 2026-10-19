#!/usr/bin/env node
// ============================================================================
// scripts/_test_presenter_artefact.mjs — 0.114.3: a step whose artefact IS the
// work is never refused for « no change », and a refusal hint never asks for
// what the next check refuses.
// ============================================================================
//
// User request (2026-10-19, run p-20261019T150341-318fcf of a Data pipeline):
// « corriges les tests qui font que ca bloque, ils ne sont pas corrects
// manifestement ». The Présenter step was refused once for « aucune
// modification — écris « PRESENTATION_SEULE » », then, with exactly that
// marker, for « sections manquantes « ## Résultats », « ## Limites » ».
//
// Real dispatch.mjs, real engine, claude double (FAKE_CLAUDE_PIPELINE),
// throw-away root (DISPATCH_ROOT_FOR_TESTS): production is never touched.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { CATALOG_PIPELINES, catalogSteps } from './pipeline-catalog.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Catalogue : aucune consigne « rien à faire » contredite par un contrôle suivant');
const presenter = catalogSteps('donnees').find(s => s.id === 'presenter');
ok(presenter.checks.artefactIsWork === true && !presenter.checks.nothing && presenter.checks.sections.join() === 'Résultats,Limites',
  'Données › Présenter : l’artefact est le travail (sections exigées, plus de marqueur PRESENTATION_SEULE)');
for (const p of CATALOG_PIPELINES) for (const s of catalogSteps(p)) {
  const c = s.checks || {};
  if (!c.nothing) continue;
  const hint = E.nothingHint(c);
  // Exactly what the hint says, nothing more: marker plus each named section.
  const art = [c.nothing, ...(c.sections || []).map(x => `## ${x}`)].join('\n');
  const contradicted = E.missingSections(art, c.sections || []).length > 0 || (c.sections || []).some(x => !hint.includes(`## ${x}`));
  ok(!contradicted, `${p} › ${s.id} : « ${hint} » suffit au contrôle des sections`);
}
const mixed = { nothing: 'X_SEUL', sections: ['Résultats', 'Limites'] };
ok(/écris « X_SEUL » dans l'artefact, avec les sections « ## Résultats », « ## Limites »/.test(E.nothingHint(mixed)),
  'marqueur + sections (forme générique) : la consigne de refus nomme aussi les sections');

// ---------------------------------------------------------------------------
// Throw-away root
// ---------------------------------------------------------------------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-present-'));
process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} });
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'chef'));
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
function repo(name) {
  const dir = path.join(T, name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  fs.writeFileSync(path.join(dir, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.writeFileSync(path.join(dir, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
  fs.writeFileSync(path.join(dir, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
  g(dir, 'init', '-q'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'D', path: path.join(T, 'D') }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['D'], pipelines: E.ENGINE_PIPELINES },
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } },
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'GITLEAKS_BIN', 'FAKE_PIPE_BAD', 'FAKE_PIPE_NOTHING', 'FAKE_PIPE_ARTEFACT_ONLY']) delete baseEnv[k];
const dispatch = (args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'D.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const presenterTries = (st) => st.steps.filter(s => s.id === 'presenter');

// ---------------------------------------------------------------------------
section('2. Présenter : une présentation conforme, sans autre modification du projet, est acceptée');
let dir = repo('D');
let n0 = logOf().length;
let r = dispatch(['D', 'récupère les données de la source et présente-les', '--pipeline', 'donnees', '--test', 'présenter sans modification'], { FAKE_PIPE_ARTEFACT_ONLY: 'presenter' });
let evs = logOf().slice(n0);
let run = evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
let st = run ? runState(run) : null;
let tries = st ? presenterTries(st) : [];
ok(r.code === 0 && st?.status === 'done', `exécution terminée (code ${r.code}, ${st?.status})`, r.out.slice(-900));
ok(tries.length === 1 && tries[0].status === 'ok' && tries[0].changed.length === 0, `Présenter accepté au premier essai, aucun fichier du projet modifié (${tries.map(t => `${t.status}:${t.why || ''}`).join(' ; ')})`);
ok(!evs.some(e => /aucune modification/.test(JSON.stringify(e))), 'aucun refus « aucune modification » dans le log');
const prompt = fs.readFileSync(path.join(T, 'logs', 'runs', run, `${tries[0].key}.jsonl`), 'utf8');
ok(/ARTEFACT_EST_LE_TRAVAIL=oui/.test(prompt) && !/PRESENTATION_SEULE/.test(prompt), 'la consigne dit que l’artefact est le travail, sans proposer de marqueur');
ok(/## Résultats/.test(evs.filter(e => e.type === 'result').pop()?.result || ''), 'le résultat final est la présentation');

// ---------------------------------------------------------------------------
section('3. Une exécution en pause (critère) sur Présenter reprend avec la règle corrigée');
dir = repo('D');
n0 = logOf().length;
r = dispatch(['D', 'récupère les données de la source et présente-les', '--pipeline', 'donnees', '--test', 'présenter en pause'], { FAKE_PIPE_BAD: 'presenter' });
evs = logOf().slice(n0);
run = evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
st = run ? runState(run) : null;
ok(st?.status === 'paused' && st.pausedLimit === 'criteria' && st.plan[st.index] === 'presenter', `pause sur Présenter (${st?.status}, ${st?.pausedLimit})`, r.out.slice(-900));
n0 = logOf().length;
r = dispatch(['D', 'continuer', '--test', 'reprise présenter'], { FAKE_PIPE_ARTEFACT_ONLY: 'presenter' });
evs = logOf().slice(n0);
st = runState(run);
tries = presenterTries(st);
const last = tries[tries.length - 1];
ok(st.status === 'done' && last.status === 'ok' && last.changed.length === 0, `reprise : Présenter accepté sans modification du projet, exécution terminée (${st.status} ; ${tries.map(t => t.status).join(', ')})`, r.out.slice(-900));
ok(g(dir, 'status', '--porcelain').stdout.trim() === '', 'arbre propre après la livraison');

console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
