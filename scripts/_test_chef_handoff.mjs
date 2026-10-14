#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_handoff.mjs — the Routage hands a task back to the chef,
// who acts itself (0.88.0)
// ============================================================================
//
// Incident (2026-10-14, runs p-20261014T044834-2601c2 and p-20261014T070908-f73a62):
// the Decomposer produced « tâche 3 (orchestrateur) : nettoyage des exécutions
// en pause », work the chef must do ITSELF. The code refused it (« le chef ne se
// délègue pas de tâche »); the only fallback, « ne_pas_dispatcher », ended in a
// question to the user. User answer, verbatim: « IL faut que le routage puisse
// renvoyer au chef pour qu'il agisse lui meme ».
//
// Protected:
//   1. a task marked « renvoi_chef » is accepted by the Decomposer check (even
//      naming the chef), instead of « le chef ne se délègue pas de tâche »;
//      a task naming the chef WITHOUT it is still refused; incoherent
//      combinations (no reason, « apres », « impose »…) are refused;
//   2. end to end: such a task is confirmed by the classifier model, never sent
//      to a musician, and ends in ONE chef turn, launched after the Routage
//      turn, out of the Routage, signed (user_prompt.chefHandoff), with the
//      task in its prompt — traced (event, dispatch.json) and reported;
//   3. project work is never handed to the chef: if the classifier sees a
//      pipeline, the hand-off is refused and becomes a question;
//   4. the hand-off flag cannot be forged: no or wrong token → refused (65);
//   5. the hand-off turn is not counted as a bypass by the health report.
//
//   node scripts/_test_chef_handoff.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { catalogSteps } from './pipeline-catalog.mjs';
import { countLog } from './pipeline-health.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-handoff-'));
for (const d of ['logs', 'chef', 'R']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
fs.writeFileSync(path.join(T, 'R', 'package.json'), '{"name":"R","version":"1.0.0"}\n');
spawnSync('git', ['init', '-q'], { cwd: path.join(T, 'R') });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'R'].map(n => ({ name: n, path: path.join(T, n) })),
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_CHEF_HANDOFF_TEST: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ORCH_HANDOFF_TOKEN',
  'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP', 'ORCH_CHEF_ACTION_RUNNER']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runDirs = () => { try { return fs.readdirSync(path.join(T, 'logs', 'runs')).filter(d => /^p-/.test(d)); } catch { return []; } };
function chefTurn(text, json, map) {
  const n0 = logOf('chef').length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', text, '--test', 'renvoi-chef'],
    { env: { ...baseEnv, FAKE_PIPE_JSON: JSON.stringify(json), FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify(map || {}) }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const evs = logOf('chef').slice(n0);
  const run = evs.find(e => e.type === 'user_prompt')?.pipeline?.run;
  const art = run ? path.join(T, 'chef', '.orchestrateur', 'runs', run) : null;
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(art, f), 'utf8')); } catch { return null; } };
  const st = run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : null;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, run, st, read, n0, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const statusOf = (st) => (st?.steps || []).map(s => `${s.id}:${s.status}`).join(' ');
const waitIdle = async () => { for (let i = 0; i < 60 && fs.existsSync(path.join(T, 'logs', 'R.pid')); i++) await sleep(500); };

const DEV_R = { projet: 'R', titre: 'R : fonction double', demande: 'Ajoute une fonction double(x) au projet R, avec son test.' };
const CLEAN = 'Clore les exécutions de pipeline en pause devenues sans objet (logs/runs), en les listant d’abord, sans toucher aux projets.';
const HANDOFF = { projet: 'chef', titre: 'nettoyage des exécutions en pause', demande: CLEAN, renvoi_chef: { raison: 'gestion de l’orchestration : le chef agit lui-même' } };
const DEV_MAP = { 'double(x)': { pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'fonction à ajouter' } };

// ---------------------------------------------------------------------------
section('1. Découper : une tâche « renvoi_chef » est acceptée (plus « le chef ne se délègue pas de tâche »)');
ok(/le chef ne se délègue pas de tâche/.test(E.validateUnitTasks(T, [{ projet: 'chef', titre: 'nettoyage', demande: CLEAN }]) || ''), 'tâche au chef SANS renvoi_chef : toujours refusée');
ok(E.validateUnitTasks(T, [DEV_R, HANDOFF]) === null, 'tâche renvoyée au chef (projet « chef ») : acceptée', E.validateUnitTasks(T, [DEV_R, HANDOFF]));
ok(E.validateUnitTasks(T, [{ ...HANDOFF, projet: 'R' }]) === null, 'renvoi au chef qui nomme le projet concerné : accepté');
ok(/renvoi_chef/.test(E.validateUnitTasks(T, [{ ...HANDOFF, renvoi_chef: {} }]) || ''), 'renvoi sans raison : refusé');
ok(/apres/.test(E.validateUnitTasks(T, [DEV_R, { ...HANDOFF, apres: 1 }]) || ''), 'renvoi qui attend une autre tâche : refusé (le chef agit à la fin du tour)');
ok(/s’excluent/.test(E.validateUnitTasks(T, [{ ...HANDOFF, impose: { pipeline: 'dev' } }]) || ''), 'renvoi + impose : refusé');
ok(/apres.*renvoyée au chef/.test(E.validateUnitTasks(T, [HANDOFF, { ...DEV_R, apres: 1 }]) || ''), 'une tâche ne peut pas attendre une tâche renvoyée au chef');
const dec = catalogSteps('routage').find(s => s.id === 'decomposer');
ok(/renvoi_chef/.test(dec.role) && /renvoi_chef/.test(dec.jsonExample), 'la consigne et l’exemple JSON de Découper expliquent « renvoi_chef »');

// ---------------------------------------------------------------------------
section('2. Bout en bout : renvoyée au chef, jamais à un musicien ; un tour du chef signé part après le Routage');
const runs0 = runDirs().length;
let x = chefTurn('Ajoute double() à R et nettoie les exécutions en pause', {
  comprendre: { nature: 'taches', sens: 'un travail sur R et un nettoyage par le chef', raison: 'x' }, decomposer: { taches: [DEV_R, HANDOFF] },
}, { ...DEV_MAP, 'exécutions de pipeline en pause': { chef: 'autre', raison: 'gestion des exécutions : le chef' } });
ok(x.code === 0 && statusOf(x.st) === 'lire:ok comprendre:ok decomposer:ok classifier:ok affecter:ok dispatcher:ok rapporter:ok', `Routage complet, Découper accepté : ${statusOf(x.st)}`, x.out.slice(-900));
ok(!JSON.stringify(x.st).includes('le chef ne se délègue pas de tâche'), 'plus le défaut « le chef ne se délègue pas de tâche »');
const cls = x.read('classement.json');
ok(cls?.taches?.[1]?.chefHandoff === true && cls.taches[1].route === false && !(cls.questions || []).length, 'tâche 2 : renvoyée au chef, aucune question', JSON.stringify(cls));
const disp = x.read('dispatch.json');
ok(disp?.handoff?.status === 'scheduled' && disp.handoff.ref === `${x.run}#2` && disp.handoff.tasks?.[0]?.titre === HANDOFF.titre, 'dispatch.json : renvoi programmé, tâche nommée', JSON.stringify(disp?.handoff));
ok(disp?.dispatched?.length === 1 && disp.dispatched[0].projet === 'R', 'seule la tâche de R part chez un musicien');
ok(x.evs.some(e => e.subtype === 'chef_handoff' && e.ref === `${x.run}#2`), 'événement system/chef_handoff dans le fil du chef');
ok(/Renvoyé au chef, qui agit lui-même/.test(x.result) && x.result.includes(HANDOFF.titre) && !/NEEDS_USER_INPUT/.test(x.result), 'le rapport du Routage le dit (code), sans question', x.result.slice(-500));
let hand = null;
for (let i = 0; i < 120 && !hand; i++) {
  hand = logOf('chef').slice(x.n0).find(e => e.type === 'user_prompt' && e.chefHandoff);
  if (!hand) await sleep(500);
}
ok(hand?.chefHandoff?.run === x.run && hand.chefHandoff.tasks?.join() === '2' && hand.text.includes(CLEAN) && /RENVOI_CHEF/.test(hand.text), 'le chef reçoit SON tour, signé, avec la tâche dans son prompt', JSON.stringify(hand)?.slice(0, 400));
ok(hand && !hand.pipeline && !hand.pipelineBypass, 'ce tour sort du Routage (aucune nouvelle exécution) sans être compté comme contournement');
let handRes = null;
for (let i = 0; i < 60 && !handRes; i++) {
  const after = logOf('chef'); const k = after.indexOf(after.find(e => e.type === 'user_prompt' && e.chefHandoff));
  handRes = k >= 0 ? after.slice(k).find(e => e.type === 'result') : null;
  if (!handRes) await sleep(500);
}
ok(handRes && !handRes.is_error, 'le tour du chef se termine (result)', JSON.stringify(handRes)?.slice(0, 300));
ok(runDirs().length === runs0 + 1, `une seule exécution du Routage, aucune autre lancée par le renvoi (${runDirs().length - runs0})`);
let h = 0; countLog(logOf('chef').map(e => JSON.stringify(e)), '2000-01-01', (d, k) => { if (k === 'ordinaires' || k === 'hors') h++; });
ok(h === 0, `relevé de mise en service : le tour renvoyé n’est pas un contournement (${h})`);
await waitIdle();

// ---------------------------------------------------------------------------
section('3. Garde-fou : du travail de projet n’est jamais renvoyé au chef');
x = chefTurn('Nettoie le code de R', {
  comprendre: { nature: 'taches', sens: 's', raison: 'x' },
  decomposer: { taches: [{ projet: 'R', titre: 'R : ménage du code', demande: 'Supprime le code mort du projet R et commite.', renvoi_chef: { raison: 'le chef pourrait le faire vite' } }] },
}, { 'code mort': { pipeline: 'dev', mode: 'leger', nature: 'mecanique', raison: 'travail de code' } });
const cls3 = x.read('classement.json');
ok(x.code === 0 && cls3?.taches?.[0]?.route === false && !cls3.taches[0].chefHandoff && !x.read('dispatch.json')?.handoff, 'pas de renvoi au chef, rien de lancé', JSON.stringify(cls3));
ok(/NEEDS_USER_INPUT: .*travail de projet \(pipeline dev\)/.test(x.result), 'question à l’utilisateur : le classement y voit du travail de projet', x.result.slice(-400));

// ---------------------------------------------------------------------------
section('4. Le drapeau de renvoi ne se forge pas');
const ref = 'p-20261014T070908-f73a62#3';
ok(E.verifyHandoff(T, ref, E.handoffToken(T, ref))?.tasks?.join() === '3', 'jeton du Routage : accepté');
ok(E.verifyHandoff(T, 'p-20261014T070908-f73a62#4', E.handoffToken(T, ref)) === null && E.verifyHandoff(T, ref, 'f'.repeat(64)) === null, 'autre référence ou jeton faux : refusé');
const forged = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', 'nettoie tout', '--chef-handoff', ref, '--test', 'renvoi-forge'],
  { env: { ...baseEnv, ORCH_HANDOFF_TOKEN: 'f'.repeat(64) }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
ok(forged.status === 65 && /jeton absent ou invalide/.test(forged.stderr || ''), `--chef-handoff sans le bon jeton : refusé (exit ${forged.status})`, forged.stderr);
const mus = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'R', 'x', '--chef-handoff', ref, '--test', 'renvoi-musicien'],
  { env: { ...baseEnv, ORCH_HANDOFF_TOKEN: E.handoffToken(T, ref) }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
ok(mus.status === 64, `--chef-handoff vers un musicien : refusé (exit ${mus.status})`);

await waitIdle();
await sleep(500);
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
