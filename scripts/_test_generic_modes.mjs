#!/usr/bin/env node
// ============================================================================
// scripts/_test_generic_modes.mjs — Discussion « vérification », Recherche
// « interne », Discussion in one call, and the classification of the generics
// (pipelines phase 1, docs/PIPELINES-SYNTHESE.md §3.3, §6.2 lever 6)
// ============================================================================
//
// User decisions (2026-10-20, « tout comme recommandé »): decision 4 (three
// modes of existing pipelines), decision 10 (« Discussion en un seul appel, la
// Recherche restant appelée si le web est nécessaire »), and every new
// behaviour behind its own switch, off by default, frozen per run.
//
// Protected (real dispatch.mjs and engine, fake claude):
//   - vérification: each finding's proof is checked in the turn's log and on
//     the disk (a file read, a command run in THIS turn, an URL consulted); an
//     unobserved proof is refused; the answer is the table of findings;
//   - recherche interne: sources are project files, the web is refused;
//   - discussionOne: one model call; the research step only when the answer
//     asks for it, once; switch off = the three steps as before; the setting
//     is frozen in run.json;
//   - classification: generics offered only with `generic`, specialised before
//     generic, generic modes accepted for their pipeline only, one operation
//     named with its parameters and the user's quote; prefixes /operations,
//     /fichiers, /document, /verification, /interne only with the switch.
//
//   node scripts/_test_generic_modes.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { classificationPrompt, parseClassification, classifierChoices, routingTaskPrompt, GENERIC_PIPELINES } from './pipeline-classify.mjs';
import { explicitChoice } from './pipeline-observe.mjs';
import { TUNING_LEVERS } from './pipeline-tuning.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-genmodes-'));
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'chef'));
const routing = (tuning) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['P'], pipelines: E.ENGINE_PIPELINES, tuning },
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'discussion.repondre': { provider: 'anthropic', model: 'claude-sonnet-5-5' }, 'discussion.verifier': { provider: 'anthropic', model: 'claude-opus-5-5' } },
}, null, 2));

section('1. Classement : génériques derrière l’interrupteur, règles de sens');
{
  routing({});
  const off = classifierChoices(T, { generic: false });
  const on = classifierChoices(T, { generic: true });
  ok(!off.some(p => GENERIC_PIPELINES.includes(p.id)) && GENERIC_PIPELINES.every(id => on.some(p => p.id === id)), 'Opérations et Fichiers proposés seulement avec « generic »');
  const pOff = classificationPrompt('x', {}, off), pOn = classificationPrompt('x', {}, on);
  ok(!/operations =/.test(pOff) && !/"document"/.test(pOff) && pOff === classificationPrompt('x', {}, off), 'interrupteur coupé : consigne de classement inchangée (aucune règle des génériques)');
  ok(/Specialised pipelines first, then the generic ones/.test(pOn) && /never maintenance/.test(pOn) && /mode "document"/.test(pOn) && /mode "verification"/.test(pOn) && /mode "interne"/.test(pOn), 'interrupteur actif : spécialisé d’abord, puis générique ; les trois modes décrits');
  ok(/git_push, git_tag/.test(pOn) && /"autorisation"/.test(pOn) && /TODO_LIST\.md/.test(pOn), 'consigne : opération nommée, paramètres, mots exacts de l’utilisateur ; exemple du TODO');
  ok(/mode "document"/.test(routingTaskPrompt({ projet: 'P', demande: 'x' }, {}, on)) && !/mode "document"/.test(routingTaskPrompt({ projet: 'P', demande: 'x' }, {}, off)), 'même règle pour les tâches du Routage, avec l’interrupteur seulement');
  const pc = (j, choices = on) => parseClassification(JSON.stringify(j), {}, choices);
  ok(pc({ pipeline: 'redaction', mode: 'document', raison: 'r' })?.mode === 'document' && pc({ pipeline: 'discussion', mode: 'vérification', raison: 'r' })?.mode === 'verification', 'modes génériques acceptés pour leur pipeline');
  ok(pc({ pipeline: 'dev', mode: 'document', nature: 'bugfix', raison: 'r' })?.mode === 'complet', 'un mode générique hors de son pipeline n’est pas gardé');
  ok(pc({ pipeline: 'redaction', mode: 'document' }, off) === null, 'interrupteur coupé : « document » n’est pas un mode valide');
  const op = pc({ pipeline: 'operations', mode: 'complet', operations: [{ id: 'copy_build', params: {} }, { id: 'adb_install', params: { versionCode: 42 } }], autorisation: 'publie et installe' });
  ok(op?.operations?.map(o => o.id).join() === 'copy_build,adb_install' && op.operations[1].params.versionCode === 42 && op.autorisation === 'publie et installe', 'TOUTES les opérations nommées, dans l’ordre, avec leurs paramètres et la citation');
  ok(!pc({ pipeline: 'operations', mode: 'complet', operations: [{ id: 'git_push' }, { id: 'rm -rf' }] })?.operations, 'une opération hors du registre : aucune liste (Préparer la refait, rien n’est perdu en silence)');
  ok(pc({ pipeline: 'operations', mode: 'complet', operation: 'git_tag', params: { tag: 'v1' } })?.operations?.[0]?.params?.tag === 'v1', 'ancienne forme (une opération) : une liste d’une');
  ok(/ALL the operations the task asks for/.test(pOn) && /publishing then installing is two/.test(pOn), 'consigne : la liste COMPLÈTE (publier puis installer = deux)');
  ok(explicitChoice({ text: '/operations pousse main', generic: true }).pipeline === 'operations' && explicitChoice({ text: '/operations pousse main' }).pipeline === null, '/operations : choix explicite avec l’interrupteur seulement');
  const d = explicitChoice({ text: '/document corrige README.md', generic: true });
  ok(d.pipeline === 'redaction' && d.mode === 'document' && explicitChoice({ text: '/vérification la prod est-elle à jour ?', generic: true }).mode === 'verification' && explicitChoice({ text: '/interne pourquoi ce test échoue', generic: true }).mode === 'interne', '/document, /vérification, /interne : pipeline et mode');
  ok(explicitChoice({ text: '/fichiers range les vidéos', generic: true }).pipeline === 'fichiers', '/fichiers');
  ok('generic' in TUNING_LEVERS && 'discussionOne' in TUNING_LEVERS, 'deux interrupteurs : generic, discussionOne');
}

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const P = path.join(T, 'P');
const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(P, rel)), { recursive: true }); fs.writeFileSync(path.join(P, rel), s); };
w('package.json', JSON.stringify({ name: 'P', version: '1.2.0', type: 'module' }, null, 2) + '\n');
w('test/base.test.mjs', "import { test } from 'node:test';\ntest('base', () => {});\n");
w('.orchestrateur/pipeline.json', JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'] }));
w('src/serveur.mjs', 'export const PORT = 7778;\n');
w('logs/app.log', 'démarré sur 7778\n');
g(P, 'init', '-q'); g(P, 'add', '-A'); g(P, 'commit', '-q', '-m', 'init');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME',
  'FAKE_PIPE_JSON', 'FAKE_PIPE_BAD', 'FAKE_PIPE_NOTHING', 'FAKE_CLAUDE_CHOICE', 'FAKE_CLAUDE_DUMP_PROMPT', 'FAKE_CLAUDE_CLASSIFY', 'ORCH_REQUEST_ID', 'FAKE_CLAUDE_READ_PATH', 'FAKE_CLAUDE_BASH_COMMAND', 'FAKE_CLAUDE_WEB']) delete baseEnv[k];
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
function play(args, env = {}) {
  const n0 = logOf().length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline?.run)?.pipeline.run;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, run, st: run ? runState(run) : null, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const stepTurns = (x) => x.evs.filter(e => e.subtype === 'pipeline_step_start' && !e.byCode).length;

section('2. Discussion « vérification » : chaque preuve vérifiée dans le journal du tour');
routing({ generic: true });
const constats = (preuve) => ({ verifier: { constats: [{ affirmation: 'le serveur écoute sur 7778', observe: 'PORT = 7778', preuve, verdict: 'vrai' }] } });
let x = play(['Vérifie que le serveur écoute bien sur le port 7778.', '--test', 'vérif fichier'], {
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'verification', raison: 'vérifier' }),
  FAKE_CLAUDE_READ_PATH: path.join(P, 'src', 'serveur.mjs'), FAKE_PIPE_JSON: JSON.stringify(constats({ type: 'fichier', ref: 'src/serveur.mjs:1' })) });
ok(x.code === 0 && x.st?.status === 'done' && x.st.mode === 'verification' && x.st.plan.join() === 'verifier', `vérification en une étape (code ${x.code})`, x.out.slice(-1200));
ok(/\| ✓ vrai \| le serveur écoute sur 7778 \|/.test(x.result) && /src\/serveur\.mjs:1/.test(x.result), 'la réponse est le tableau des constats', x.result.slice(0, 600));
ok(x.st.steps.some(s => s.id === 'verifier' && s.model === 'claude-opus-5-5'), 'case discussion.verifier');
x = play(['Vérifie que le serveur écoute bien sur le port 7778.', '--test', 'vérif non observée'], {
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'verification', raison: 'vérifier' }),
  FAKE_PIPE_JSON: JSON.stringify(constats({ type: 'fichier', ref: 'src/serveur.mjs' })) });
ok(x.st?.status === 'paused' && /n’a pas été lu ni vu pendant le tour/.test(x.st.steps.filter(s => s.status === 'refused').pop()?.why || ''), 'fichier cité sans avoir été lu : refusé (preuve non observée)', x.st?.steps?.map(s => s.why).join(' | '));
x = play(['Vérifie la version de node.', '--test', 'vérif commande'], {
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'verification', raison: 'vérifier' }),
  FAKE_CLAUDE_BASH_COMMAND: 'node --version', FAKE_CLAUDE_BASH_OUTPUT: 'v24.19.0',
  FAKE_PIPE_JSON: JSON.stringify({ verifier: { constats: [{ affirmation: 'node est en v24', observe: 'v24.19.0', preuve: { type: 'commande', ref: 'node --version' }, verdict: 'vrai' }] } }) });
ok(x.st?.status === 'done', 'commande lancée dans le tour : preuve acceptée', x.out.slice(-800));
x = play(['Vérifie la version de node.', '--test', 'vérif commande inventée'], {
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'verification', raison: 'vérifier' }),
  FAKE_PIPE_JSON: JSON.stringify({ verifier: { constats: [{ affirmation: 'node est en v24', observe: 'v24', preuve: { type: 'commande', ref: 'node --version' }, verdict: 'vrai' }] } }) });
ok(x.st?.status === 'paused' && /n’a pas été lancée dans ce tour/.test(x.st.steps.filter(s => s.status === 'refused').pop()?.why || ''), 'commande jamais lancée : refusée');

section('3. Recherche « interne » : sources du projet, le web refusé');
const sources = '# Sources\n\n- `src/serveur.mjs` : le port\n- `logs/app.log` : le démarrage\n- `package.json` : la version\n';
x = play(['Cherche dans le dépôt et ses journaux pourquoi le serveur démarre sur 7778.', '--test', 'interne'], {
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'recherche', mode: 'interne', raison: 'interne' }) });
ok(x.st?.mode === 'interne' && x.st.plan.join() === 'cadrer,explorer,lire-interne,recouper-interne,synthetiser-interne', `plan interne : ${x.st?.plan?.join(', ')}`);
ok(x.st?.status === 'paused' && /source\(s\) distincte\(s\) du projet/.test(x.st.steps.find(s => s.status === 'refused')?.why || ''), 'des URL ne sont pas des sources internes : refusé', x.st?.steps?.map(s => `${s.id}:${s.status}:${s.why || ''}`).join(' | '));
x = play(['Cherche dans le dépôt pourquoi le serveur démarre sur 7778.', '--test', 'interne web'], {
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'recherche', mode: 'interne', raison: 'interne' }), FAKE_CLAUDE_WEB: '1' });
ok(x.st?.status === 'paused' && /le web a été utilisé \(WebSearch\)/.test(x.st.steps.find(s => s.status === 'refused')?.why || ''), 'WebSearch pendant une recherche interne : refusé', x.st?.steps?.map(s => `${s.id}:${s.status}:${s.why || ''}`).join(' | '));
x = play(['Cherche dans le dépôt et ses journaux pourquoi le serveur démarre sur 7778.', '--test', 'interne ok'], {
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'recherche', mode: 'interne', raison: 'interne' }), FAKE_PIPE_FILE_SOURCES: 'src/serveur.mjs,logs/app.log,package.json' });
ok(x.st?.status === 'done' && /src\/serveur\.mjs/.test(x.result) && /## Recommandation/.test(x.result), 'fichiers du projet cités, sans web : la synthèse est la réponse', x.st?.steps?.map(s => `${s.id}:${s.status}:${s.why || ''}`).join(' | '));
// The internal steps accept project files as sources.
const step = E.planSteps('recherche', { mode: 'interne' }).find(s => s.id === 'explorer');
ok(step.checks.sourcesFiles && step.checks.noWeb && step.chain[0] === 'recherche.rechercher.interne' && E.countSources(sources, { files: true }) === 3, 'sources = fichiers cités ; case recherche.rechercher.interne');

section('4. Discussion en un appel (levier 6) — coupé par défaut, figé par exécution');
routing({});
x = play(['Pourquoi le port 7778 ?', '--test', 'discussion classique'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'leger', raison: 'question' }) });
ok(x.st?.status === 'done' && x.st.plan.join() === 'comprendre,rechercher,repondre' && stepTurns(x) === 3 && x.st.tuning?.discussionOne === false, `interrupteur coupé : 3 étapes comme avant, réglage figé (${x.st?.plan?.join(', ')})`);
routing({ discussionOne: true });
x = play(['Pourquoi le port 7778 ?', '--test', 'discussion un appel'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'leger', raison: 'question' }) });
ok(x.st?.status === 'done' && x.st.plan.join() === 'repondre' && stepTurns(x) === 1 && x.st.tuning?.discussionOne === true, `interrupteur actif : UN appel (${stepTurns(x)})`, x.out.slice(-1000));
ok(/## Réponse/.test(x.result) && /## Sources/.test(x.result) && x.st.steps[0].model === 'claude-sonnet-5-5', 'réponse avec ses sections, sur le model de discussion.repondre');
x = play(['Quelles versions de la bibliothèque sont publiées ?', '--test', 'discussion recherche'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'leger', raison: 'question' }), FAKE_PIPE_RESEARCH: '1' });
ok(x.st?.status === 'done' && x.st.plan.join() === 'repondre,rechercher,repondre' && stepTurns(x) === 3 && x.evs.some(e => e.subtype === 'pipeline_research_inserted'), `la réponse demande une recherche : Rechercher puis la réponse, une fois (${x.st?.plan?.join(', ')})`, x.out.slice(-1000));
ok(!/RECHERCHE_NECESSAIRE/.test(x.result), 'la réponse finale ne garde pas le marqueur');

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
