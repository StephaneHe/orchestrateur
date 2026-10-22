#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_typed_actions.mjs — the chef's typed actions and their
// postconditions (Routage v3, phase 2)
// ============================================================================
//
// User decision of 2026-10-22 (« vas y »): « actions typées avec
// postconditions, en RÉUTILISANT scripts/typed-operations.mjs livré en v0.129.0
// — ne le duplique pas ». docs/ROUTAGE-SYNTHESE.md §3.2: cancel_run (the run is
// terminal), stop_turn (the PID is dead), resolve_question (no open question),
// restart (another PID answers /api/version), copy_build (the APK exists),
// todo_add (the item is read back). A return code alone is never « done ».
//
// Real scripts (close-run.mjs, kill-stalled.mjs, todo.mjs) on a private root.
//
//   node scripts/_test_chef_typed_actions.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as O from './typed-operations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chefops-'));
const LOGS = path.join(T, 'logs');
for (const d of [LOGS, path.join(T, 'P'), path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
const config = { conductor: 'chef', defaults: {}, projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: path.join(T, 'P') }] };
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify(config));
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, ORCH_TODO_ROOT: T };
for (const k of ['ORCH_TURN_PROJECT', 'ORCH_TURN_ID', 'ORCH_REQUEST_ID']) delete env[k];
const ctx = (extra = {}) => ({ root: T, scriptsDir: path.join(ROOT, 'scripts'), logsDir: LOGS, cwd: T, project: null, config, env, ...extra });
const append = (p, ev) => fs.appendFileSync(path.join(LOGS, `${p}.jsonl`), JSON.stringify({ timestamp: new Date().toISOString(), ...ev }) + '\n');
const RUN = 'p-20261020T101010-abcdef';
const writeRun = (st) => { fs.mkdirSync(path.join(LOGS, 'runs', RUN), { recursive: true }); fs.writeFileSync(path.join(LOGS, 'runs', RUN, 'run.json'), JSON.stringify({ run: RUN, project: 'P', pipeline: 'dev', mode: 'leger', createdAt: new Date().toISOString(), request: 'x', plan: [], index: 0, steps: [], ...st })); };
const readRun = () => JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', RUN, 'run.json'), 'utf8'));

try {
  section('1. Un seul registre : les actions du chef y sont ajoutées, jamais dupliquées');
  ok(O.OPERATION_IDS.join() === 'git_push,git_tag,git_push_tag,git_restore,prod_jump,copy_build,adb_install,service_restart,run_script', 'le pipeline « operations » d’un musicien garde ses 9 opérations');
  ok(O.CHEF_OPERATION_IDS.join() === 'cancel_run,stop_turn,resolve_question,restart,todo_add,copy_build', `actions du chef : ${O.CHEF_OPERATION_IDS.join(', ')}`);
  ok(O.CHEF_OPERATION_IDS.every(id => typeof O.OPERATIONS[id]?.prepare === 'function' && typeof O.OPERATIONS[id]?.verify === 'function'), 'chacune : préconditions et postcondition, dans OPERATIONS');
  ok(O.parseOperations({ operations: [{ id: 'cancel_run', params: { run: RUN } }] }).ok === false && !/cancel_run/.test(O.operationsCatalogText()), 'un musicien ne peut jamais demander une action du chef');
  ok(/cancel_run/.test(O.chefActionsCatalogText()) && /copy_build/.test(O.chefActionsCatalogText()), 'liste fermée des actions pour la consigne du chef (copy_build partagée)');
  ok(/pid: process\.pid/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), '/api/version donne le pid du serveur (postcondition de restart)');

  section('2. cancel_run : l’exécution visée est terminale (close-run.mjs réel)');
  writeRun({ status: 'paused', pausedLimit: 'green' });
  append('P', { type: 'user_prompt', text: 'x' });
  let r = await O.runOperation(ctx(), { id: 'cancel_run', params: { run: RUN, raison: 'abandon demandé par l’utilisateur' } });
  ok(r.ok && readRun().status === 'abandoned' && /abandoned/.test(r.observed), `pause close : ${r.observed}`, r.out || r.why);
  r = await O.runOperation(ctx(), { id: 'cancel_run', params: { run: RUN } });
  ok(r.ok && r.already, 'déjà terminale : rien relancé (idempotent)');
  writeRun({ status: 'running', pid: process.pid });
  r = await O.runOperation(ctx(), { id: 'cancel_run', params: { run: RUN } });
  ok(!r.ok && r.stage === 'precondition' && /tourne encore/.test(r.why) && readRun().status === 'running', 'exécution vivante : refusée avant toute commande');
  r = await O.runOperation(ctx(), { id: 'cancel_run', params: { run: 'p-20990101T000000-000000' } });
  ok(!r.ok && /introuvable/.test(r.why), 'exécution inconnue : refusée');

  section('3. stop_turn : le PID est mort (kill-stalled.mjs réel, jamais --force)');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)'], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(path.join(LOGS, 'P.pid'), String(sleeper.pid));
  append('P', { type: 'user_prompt', text: 'un tour qui boucle' });
  r = await O.runOperation(ctx(), { id: 'stop_turn', params: { project: 'P', raison: 'tour bloqué depuis 2 h' } });
  ok(r.ok && /mort/.test(r.observed) && !r.argv.includes('--force'), `tour arrêté : ${r.observed}`, r.out || r.why);
  r = await O.runOperation(ctx(), { id: 'stop_turn', params: { project: 'P', raison: 'encore' } });
  ok(r.ok && r.already, 'aucun tour vivant : rien à faire');
  ok(!(await O.runOperation(ctx(), { id: 'stop_turn', params: { project: 'chef', raison: 'non' } })).ok, 'le chef n’arrête pas son propre tour');
  ok(/raison/.test((await O.runOperation(ctx(), { id: 'stop_turn', params: { project: 'P' } })).why), 'raison obligatoire');

  section('4. resolve_question : plus de question ouverte — un code retour seul ne suffit jamais');
  append('P', { type: 'user_prompt', text: 'question ?' });
  append('P', { type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_api_ms: 50, result: 'Fait.\n\nNEEDS_USER_INPUT: Tailwind ou MUI ?' });
  ok(O.openQuestion(LOGS, 'P') === 'Tailwind ou MUI ?', 'question ouverte relevée dans le journal');
  const liar = (argv) => ({ code: 0, out: 'ok' });
  r = await O.runOperation(ctx({ exec: liar }), { id: 'resolve_question', params: { project: 'P', note: 'répondu' } });
  ok(!r.ok && r.stage === 'postcondition' && /toujours ouverte/.test(r.observed), 'code 0 mais question toujours ouverte : ÉCHEC (postcondition fausse)');
  const honest = (argv) => { if (argv.some(a => /resolve-question\.mjs$/.test(a))) append('P', { type: 'notification', subtype: 'question_resolved', note: 'répondu' }); return { code: 0, out: 'ok' }; };
  r = await O.runOperation(ctx({ exec: honest }), { id: 'resolve_question', params: { project: 'P', note: 'répondu' } });
  ok(r.ok && /plus de question ouverte/.test(r.observed), `question acquittée : ${r.observed}`);
  r = await O.runOperation(ctx({ exec: liar }), { id: 'resolve_question', params: { project: 'P' } });
  ok(r.ok && r.already, 'plus de question : rien à faire');

  section('5. todo_add : l’item est relu dans la TODO du chef (todo.mjs réel)');
  r = await O.runOperation(ctx(), { id: 'todo_add', params: { titre: 'EN ATTENTE : reprendre la pause mise de côté', type: 'autre' } });
  const todo = fs.readFileSync(path.join(T, 'chef', 'TODO_LIST.md'), 'utf8');
  ok(r.ok && /reprendre la pause mise de côté/.test(todo) && /relue/.test(r.observed), `item ajouté et relu : ${r.observed}`, r.out || r.why);
  r = await O.runOperation(ctx(), { id: 'todo_add', params: { titre: 'EN ATTENTE : reprendre la pause mise de côté' } });
  ok(r.ok && r.already && fs.readFileSync(path.join(T, 'chef', 'TODO_LIST.md'), 'utf8') === todo, 'déjà ouvert : rien ajouté deux fois');
  r = await O.runOperation(ctx({ exec: liar }), { id: 'todo_add', params: { titre: 'un item jamais écrit' } });
  ok(!r.ok && r.stage === 'postcondition', 'code 0 sans item relu : échec');

  section('6. restart : un autre pid répond /api/version');
  let pids = [111, 111, 222];
  const probe = async () => ({ ok: true, status: 200, body: JSON.stringify({ version: '0.130.0', pid: pids.length > 1 ? pids.shift() : pids[0] }) });
  r = await O.runOperation(ctx({ probe, exec: liar, restartWaitMs: 5000 }), { id: 'restart', params: {} });
  ok(r.ok && /pid 222 \(avant 111\)/.test(r.observed), `redémarré : ${r.observed}`);
  r = await O.runOperation(ctx({ probe: async () => ({ ok: true, status: 200, body: JSON.stringify({ version: '0.130.0', pid: 333 }) }), exec: liar, restartWaitMs: 1500 }), { id: 'restart', params: {} });
  ok(!r.ok && /même pid/.test(r.observed), 'code 0 mais même pid : échec');
  r = await O.runOperation(ctx({ probe: async () => ({ ok: true, status: 200, body: JSON.stringify({ version: '0.129.0' }) }), exec: liar }), { id: 'restart', params: {} });
  ok(!r.ok && /non vérifiable/.test(r.why), 'serveur sans pid dans /api/version : refusé (postcondition non vérifiable)');
  ok(O.OPERATIONS.restart.deferred === true, 'restart part après la fin du tour du chef (deferred)');

  section('7. copy_build : l’opération du registre, pour le projet visé');
  r = await O.runOperation(ctx({ project: 'P', exec: liar }), { id: 'copy_build', params: {} });
  ok(!r.ok && r.stage === 'postcondition' && /absent ou vide/.test(r.observed), 'code 0 sans APK publié : échec (postcondition)', JSON.stringify(r));
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
