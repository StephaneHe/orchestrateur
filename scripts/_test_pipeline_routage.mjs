#!/usr/bin/env node
// ============================================================================
// scripts/_test_pipeline_routage.mjs — pipelines phase 6, lot B (0.54.0):
// the chef's turn is itself a pipeline (Routage)
// ============================================================================
//
// User request (2026-10-09): "Routage complet (le tour du chef devient
// lui-même un pipeline)". Real dispatch.mjs and engine, claude double, chef
// folder WITHOUT git (as in production), throw-away root, dead notify port.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 700)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rout-'));
for (const d of ['logs', 'chef', 'P', 'Q']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
for (const n of ['P', 'Q']) {
  const dir = path.join(T, n);
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: n, version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }) + '\n');
  fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  g(dir, 'init', '-q'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'P', 'Q'].map(n => ({ name: n, path: path.join(T, n) })),
}));
const routing = (chef = true) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [],
  enforcement: { projects: ['P'], pipelines: E.ENGINE_PIPELINES, ...(chef ? { chef: true } : {}) },
  assignments: {
    'routage.lire': { provider: 'anthropic', model: 'claude-haiku-5-5' },
    'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' },
    'routage.decomposer': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'routage.rapporter': { provider: 'anthropic', model: 'claude-opus-5-5' },
  },
}, null, 2));
routing();
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME']) delete baseEnv[k];
const dispatch = (args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
function chefTurn(text, env = {}, extra = []) {
  const n0 = logOf('chef').length;
  const r = dispatch(['chef', text, ...extra], env);
  const evs = logOf('chef').slice(n0);
  const up = evs.find(e => e.type === 'user_prompt');
  const run = up?.pipeline?.run;
  return { r, evs, up, run, st: run ? runState(run) : null };
}
const statusOf = (st) => st.steps.map(s => `${s.id}:${s.status}`).join(' ');

// ---------------------------------------------------------------------------
section('1. Une question : Lire → Classifier « réponse » → Rapporter (les étapes de tâches sont sautées, dites)');
let x = chefTurn('Pourquoi le projet P a-t-il un seul commit ?', { FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'reponse', raison: 'question sur le dépôt' } }) });
ok(x.r.code === 0 && x.st?.pipeline === 'routage' && x.st.mode === 'demande', `tour du chef = exécution Routage (code ${x.r.code})`, x.r.out.slice(-800));
ok(statusOf(x.st) === 'lire:ok classifier:ok decomposer:skipped affecter:skipped dispatcher:skipped rapporter:ok', statusOf(x.st));
ok(x.st.steps.find(s => s.id === 'rapporter')?.served === 'claude-opus-5-5' && x.st.steps.find(s => s.id === 'lire')?.served === 'claude-haiku-5-5', 'chaque étape sur le model de SA case routage.*');
const asst = x.evs.filter(e => e.type === 'assistant').pop();
ok(asst && x.evs.filter(e => e.type === 'result').length === 1 && /rapporter/.test(asst.message.content[0].text), 'le rapport apparaît comme réponse du chef dans son fil (message + un result)');
const art = path.join(T, 'chef', '.orchestrateur', 'runs', x.run);
ok(fs.existsSync(path.join(art, 'conversation.md')) && /Conversation récente/.test(fs.readFileSync(path.join(art, 'conversation.md'), 'utf8')), 'contexte : la conversation récente est extraite du log par le code');

// ---------------------------------------------------------------------------
section('2. Des tâches : Décomposer → Affecter (page Models, par le code) → Dispatcher (par le code) → Rapporter');
const tasks = [
  { projet: 'P', pipeline: 'discussion', demande: 'Explique pourquoi la suite de tests passe.' },
  { projet: 'Q', pipeline: 'dev', mode: 'leger', demande: 'Ajoute une fonction double qui multiplie par deux.' },
];
const nP = logOf('P').length, nQ = logOf('Q').length;
x = chefTurn('Demande à P d’expliquer ses tests et ajoute double() à Q', { FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'taches', raison: 'deux projets' }, decomposer: { taches: tasks } }) });
ok(x.r.code === 0 && statusOf(x.st) === 'lire:ok classifier:ok decomposer:ok affecter:ok dispatcher:ok rapporter:ok', statusOf(x.st || { steps: [] }), x.r.out.slice(-800));
ok(x.st.steps.find(s => s.id === 'affecter')?.source === 'code' && x.st.steps.find(s => s.id === 'dispatcher')?.source === 'code', 'Affecter et Dispatcher : exécutés par le code (aucun tour de model)');
const aff = fs.readFileSync(path.join(T, 'chef', '.orchestrateur', 'runs', x.run, 'affectation.md'), 'utf8');
ok(/\| P \| Discussion/.test(aff) && /projet hors service : tour ordinaire/.test(aff), 'affectation : P en service (pipeline), Q hors service (tour ordinaire)');
let pUp = null, qUp = null;
for (let i = 0; i < 60 && !(pUp && qUp); i++) {
  await sleep(500);
  pUp = logOf('P').slice(nP).find(e => e.type === 'user_prompt');
  qUp = logOf('Q').slice(nQ).find(e => e.type === 'user_prompt');
}
ok(pUp?.pipeline?.pipeline === 'discussion' && pUp.source === 'chef' && pUp.callback === 'chef', 'P reçoit une exécution Discussion, lancée par le chef, avec retour au chef');
ok(qUp && !qUp.pipeline && /double/.test(qUp.text), 'Q (hors service) reçoit un tour ordinaire, comme aujourd’hui (pas de phase 7 déguisée)');
for (let i = 0; i < 60 && ['P', 'Q'].some(n => fs.existsSync(path.join(T, 'logs', `${n}.pid`))); i++) await sleep(500);

// ---------------------------------------------------------------------------
section('3. Tâches invalides refusées par le code, puis refaites');
x = chefTurn('Travaille sur Z', { FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'taches', raison: 'x' }, decomposer: { taches: [{ projet: 'chef', pipeline: 'dev', demande: 'délègue-toi ceci' }] } }) });
const dec = x.st.steps.filter(s => s.id === 'decomposer');
ok(dec.every(s => s.status === 'refused') && /le chef ne se délègue pas/.test(dec[0].why) && x.st.status === 'paused', 'tâche confiée au chef : refusée à chaque essai, puis pause expliquée');
ok(E.validateTasks(T, [{ projet: 'X', pipeline: 'dev', demande: 'quelque chose' }]).includes('projet inconnu') && E.validateTasks(T, [{ projet: 'P', pipeline: 'routage', demande: 'quelque chose' }]).includes('pipeline inconnu') && E.validateTasks(T, Array(7).fill({ projet: 'P', pipeline: 'dev', demande: 'quelque chose' })).includes('au plus 6'), 'projet hors liste blanche, Routage délégué, plus de 6 tâches : refusés');
x = chefTurn('Fais ceci', { FAKE_PIPE_BAD: 'decomposer:1', FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'taches', raison: 'x' }, decomposer: { taches: [tasks[0]] } }) });
const d2 = x.st.steps.filter(s => s.id === 'decomposer');
ok(d2[0]?.status === 'refused' && /JSON/.test(d2[0].why) && d2[1]?.status === 'ok', 'JSON illisible : refusé, refait');
for (let i = 0; i < 60 && fs.existsSync(path.join(T, 'logs', 'P.pid')); i++) await sleep(500);

// ---------------------------------------------------------------------------
section('4. Demande ambiguë : la question part à l’utilisateur, jamais deviner');
x = chefTurn('Réponds-lui oui', { FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'question', raison: 'deux projets attendent', question: 'À quel projet répondez-vous : P ou Q ?' } }) });
const res = x.evs.filter(e => e.type === 'result').pop();
ok(x.r.code === 0 && /NEEDS_USER_INPUT: À quel projet répondez-vous/.test(res?.result || ''), 'le résultat finit par NEEDS_USER_INPUT (le fil passe en question)');
x = chefTurn('Réponds', { FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'question', raison: 'x' } }) });
ok(x.st.steps.find(s => s.id === 'classifier' && s.status === 'refused')?.why?.includes('aucune question'), '« question » sans question : refusé');

// ---------------------------------------------------------------------------
section('5. Réveil (résultats de musiciens) : Lire → Callback → Rapporter ; question d’un musicien : [ANSWER]');
x = chefTurn('[CALLBACK_WAKE lot=1 gen=1]\n[P] Tour terminé. La suite passe.', {}, ['--source', 'wake']);
ok(x.r.code === 0 && x.st.mode === 'callback' && statusOf(x.st) === 'lire:ok callback:ok rapporter:ok', `réveil : ${statusOf(x.st || { steps: [] })}`, x.r.out.slice(-600));
const dump = path.join(T, 'prompts.ndjson');
x = chefTurn('[NEEDS_CHEF_INPUT_FROM:P] Faut-il suivre la convention de nommage de Q ?', { FAKE_CLAUDE_DUMP_PROMPT: dump, FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'reponse', raison: 'convention transverse' } }) });
const prompts = fs.readFileSync(dump, 'utf8').trim().split('\n').map(l => JSON.parse(l));
ok(prompts.some(p => /PIPELINE_STEP=rapporter/.test(p.prompt) && /commencer par « \[ANSWER\] »/.test(p.prompt)), 'question d’un musicien : le rapport doit commencer par [ANSWER] (relais)');

// ---------------------------------------------------------------------------
section('6. Pool : ticket et slot du chef tracés ; rapport seul : aucun dispatch');
x = chefTurn('Pourquoi ?', { DISPATCH_SLOT: '1', DISPATCH_TICKET: 't-test-1', FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'reponse', raison: 'x' } }) }, ['--pool-assign']);
ok(x.up?.ticket === 't-test-1' && x.up.slot === 1, 'user_prompt du Routage : ticket et slot (le pool clôt le bon ticket)');
x = chefTurn('Relance P', { DISPATCH_REPORT_ONLY: '1', DISPATCH_SLOT: '1', DISPATCH_TICKET: 't-test-2', FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'taches', raison: 'x' }, decomposer: { taches: [tasks[0]] } }) }, ['--pool-assign']);
ok(x.st.steps.find(s => s.id === 'dispatcher')?.status === 'refused' && /rapport seul/.test(x.st.steps.find(s => s.id === 'dispatcher').why), 'réveil en rapport seul : le Dispatcher refuse (aucun lancement)', statusOf(x.st) + ' ' + x.r.out.slice(-500));

// ---------------------------------------------------------------------------
section('7. Mise en service : désactivé par défaut, --model refusé, --hors-pipeline tracé');
x = chefTurn('Pourquoi ?', {}, ['--model', 'claude-opus-5-5']);
ok(x.r.code === 64 && /routage\.\*/.test(x.r.out), 'chef en service + --model à la main : refusé (64)');
x = chefTurn('maintenance de la flotte', {}, ['--hors-pipeline', 'essai autorisé']);
ok(x.r.code === 0 && !x.up?.pipeline && x.up?.pipelineBypass?.reason === 'essai autorisé', '--hors-pipeline : tour ordinaire du chef, tracé');
routing(false);
x = chefTurn('Pourquoi ?');
ok(x.r.code === 0 && !x.up?.pipeline, 'interrupteur « chef » coupé : tour ordinaire (comportement d’avant)');
ok(dispatch(['P', 'x', '--pipeline', 'routage']).code === 64, '--pipeline routage sur un musicien : refusé');
const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline-enforce.mjs'), ...a], { env: baseEnv, encoding: 'utf8' });
ok(cli('on', '--chef').status === 0 && E.readEnforcement(T).chef === true && cli('off', '--all').status === 0 && E.readEnforcement(T).chef === false, 'pipeline-enforce on --chef ; off --all le coupe aussi');
ok(E.readEnforcement(path.join(T, 'absent')).chef === false, 'par défaut : chef hors Routage');

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
