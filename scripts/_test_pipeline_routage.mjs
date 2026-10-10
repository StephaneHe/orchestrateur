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
section('5. Réveil (résultats de musiciens) : Lire → Relancer → Callback → Rapporter ; question d’un musicien : [ANSWER]');
x = chefTurn('[CALLBACK_WAKE lot=1 gen=1]\n[P] Tour terminé. La suite passe.', {}, ['--source', 'wake']);
ok(x.r.code === 0 && x.st.mode === 'callback' && statusOf(x.st) === 'lire:ok relancer:ok callback:ok rapporter:ok', `réveil : ${statusOf(x.st || { steps: [] })}`, x.r.out.slice(-600));
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
// Remarque utilisateur (2026-10-09) : « là je répondais à une question que tu as
// dans ton contexte donc le routeur devrait pouvoir décomposer pour voir si
// plusieurs musiciens sont impactés, puis distribuer ».
section('8. Réponse à des questions ouvertes : contexte, « suite », une tâche par musicien, « puis » respecté, AUCUNE lacune');
const obsFile = path.join(T, 'logs', 'pipeline-observe.ndjson');
const obsCount = () => { try { return fs.readFileSync(obsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
// Ce que le chef venait de demander, la question d'un musicien, et une demande mise en attente.
fs.appendFileSync(path.join(T, 'logs', 'chef.jsonl'), [
  { type: 'user_prompt', text: 'Où en sont les pipelines ?', timestamp: new Date().toISOString() },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Phase 6 livrée.\n1. Lance-t-on la phase 7 (tous les projets en service) ?\n2. Active-t-on le Routage pour le chef ?\n3. Quels models pour les cases Décomposer et Rapporter ?\n4. Ensuite, je reprends la demande en attente sur Q ?' }] }, timestamp: new Date().toISOString() },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, duration_api_ms: 900, result: 'Phase 6 livrée.', timestamp: new Date().toISOString() },
].map(e => JSON.stringify(e)).join('\n') + '\n');
fs.writeFileSync(path.join(T, 'chef', 'TODO_LIST.md'), '# TODO\n\n- EN ATTENTE : Q — ajouter l’export CSV demandé par l’utilisateur\n- fait : autre chose\n');
fs.appendFileSync(path.join(T, 'logs', 'P.jsonl'), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 1000, duration_api_ms: 900, result: 'Analyse faite.\n\nNEEDS_USER_INPUT: Garde-t-on le format JSON ?', timestamp: new Date().toISOString() }) + '\n');
const reply = 'passes décomposer et rapporter en opus 5.5. passes tout en pipeline puis passe à la suite';
const suiteTasks = [
  { projet: 'P', pipeline: 'discussion', demande: 'Le chef a demandé : lance-t-on la phase 7 et quels models pour Décomposer et Rapporter ? Réponse de l’utilisateur : opus 5.5, tout en pipeline. Applique-le.', rattache: 'questions 1 à 3 du chef' },
  { projet: 'Q', pipeline: 'dev', mode: 'leger', demande: 'Reprends la demande en attente : ajouter l’export CSV demandé par l’utilisateur.', rattache: 'question 4 du chef (la suite)', apres: 1 },
];
const nObs = obsCount().length, nQ8 = logOf('Q').length;
x = chefTurn(reply, { FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'suite', raison: 'répond aux questions 1 à 4 du chef', rattache: ['phase 7', 'Routage', 'models', 'la suite'] }, decomposer: { taches: suiteTasks } }) });
ok(x.r.code === 0 && statusOf(x.st) === 'lire:ok classifier:ok decomposer:ok affecter:ok dispatcher:ok rapporter:ok', `réponse reconnue comme « suite » et décomposée : ${statusOf(x.st || { steps: [] })}`, x.r.out.slice(-800));
const art8 = path.join(T, 'chef', '.orchestrateur', 'runs', x.run);
const ctx8 = fs.readFileSync(path.join(art8, 'contexte.md'), 'utf8');
ok(/Lance-t-on la phase 7/.test(ctx8) && /Ensuite, je reprends la demande en attente sur Q/.test(ctx8), 'contexte : dernière réponse du chef et ses questions ouvertes');
ok(/\*\*P\*\* : Garde-t-on le format JSON/.test(ctx8) && /EN ATTENTE : Q — ajouter l’export CSV/.test(ctx8), 'contexte : question en attente d’un musicien, demande mise en attente (TODO_LIST du chef)');
const disp = JSON.parse(fs.readFileSync(path.join(art8, 'dispatch.json'), 'utf8'));
ok(disp.dispatched.map(d => d.projet).join() === 'P' && disp.waiting.map(w => `${w.projet}<${w.after}`).join() === 'Q<P', 'une tâche par musicien : P lancée tout de suite, Q en attente de P (« puis »)');
ok(E.readPending(path.join(T, 'logs')).length === 1 && logOf('Q').slice(nQ8).every(e => e.type !== 'user_prompt'), 'Q n’est PAS lancée avant la fin de P');
const newObs = obsCount().slice(nObs);
ok(newObs.length >= 1 && !newObs.some(o => o.gap), `aucune lacune signalée pour cette réponse (${newObs.length} entrée(s) observée(s), toutes sans lacune)`);
for (let i = 0; i < 60 && fs.existsSync(path.join(T, 'logs', 'P.pid')); i++) await sleep(500);
x = chefTurn('[CALLBACK_WAKE lot=1 gen=1]\n[P] Tour terminé.', {}, ['--source', 'wake']);
ok(x.r.code === 0 && statusOf(x.st) === 'lire:ok relancer:ok callback:ok rapporter:ok', `réveil : ${statusOf(x.st || { steps: [] })}`, x.r.out.slice(-600));
let qUp8 = null;
for (let i = 0; i < 60 && !qUp8; i++) { await sleep(500); qUp8 = logOf('Q').slice(nQ8).find(e => e.type === 'user_prompt'); }
ok(qUp8 && /export CSV/.test(qUp8.text) && /Rattachée à : question 4/.test(qUp8.text) && !E.readPending(path.join(T, 'logs')).length, 'après le résultat de P, le réveil lance Q (demande rattachée), file d’attente vidée');
for (let i = 0; i < 60 && fs.existsSync(path.join(T, 'logs', 'Q.pid')); i++) await sleep(500);
ok(E.validateTasks(T, [{ projet: 'P', pipeline: 'dev', demande: 'quelque chose', apres: 1 }]).includes('apres'), '« apres » qui ne désigne pas une tâche précédente : refusé');

section('9. Vrai message inclassable, sans aucun contexte qui le rattache : toujours une lacune');
const nObs9 = obsCount().length;
x = chefTurn('planifie mes vacances en Italie avec un budget serré', { FAKE_PIPE_JSON: JSON.stringify({ classifier: { nature: 'lacune', raison: 'aucun pipeline ni aucune question ouverte ne correspond' } }) });
const gap9 = obsCount().slice(nObs9).find(o => o.gap);
ok(x.r.code === 0 && gap9?.entry === 'signalement' && gap9.caller === 'routage' && gap9.gap.proposal && /aucune question ouverte/.test(gap9.gap.why), `lacune signalée APRÈS lecture du contexte, avec proposition (${gap9?.gap?.key})`);
ok(x.evs.some(e => e.subtype === 'pipeline_gap'), 'le fil du chef le dit (⚑ lacune signalée)');
const O = await import('./pipeline-observe.mjs');
const ob = O.createObserver({ logsDir: path.join(T, 'obs-unit') });
// 0.66.0: a gap is never detected on words at the observation, deferred or not —
// only the model (classification, Routage) or an explicit report brings one.
ok(!ob.record({ entry: 'dashboard:chef', project: 'chef', text: 'planifie mes vacances en Italie avec un budget serré', deferGap: true }).gap
  && !ob.record({ entry: 'dashboard:chef', project: 'chef', text: 'planifie mes vacances en Italie avec un budget serré' }).gap, 'à l’observation : aucune lacune détectée sur des mots (le Routage ou le model de classement la proposent)');

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
