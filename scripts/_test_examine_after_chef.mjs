#!/usr/bin/env node
// ============================================================================
// scripts/_test_examine_after_chef.mjs — a question answered through the chef
// leaves "À examiner" (0.57.1)
// ============================================================================
//
// User report (2026-10-09): "J'ai repondu aux questions via le chef. Les
// panneaux A Examiner sont toujours affiches. Quand je click sur Repondu ca me
// met que j'ai deja repondu et que le musicien tourne".
//
// Cause: a pipeline run dispatched by the chef writes a SOURCED user_prompt and
// no system/init in the musician's log (its steps have their own logs). No
// reducer saw a turn start: the paused question stayed `input` for the whole
// run, and its final result (no assistant text) re-read the old
// NEEDS_USER_INPUT. "Répondu" was then refused because a turn was running.
//
// Every reducer is exercised on the REAL code, on the event sequence seen in
// production: fleet-status-core (/api/pupitre, fleet-status), scanProjectState
// (/api/config) and reduceMusician (pump) sliced out of server.js, the client
// `Musician` class sliced out of public/app.js, and the resolve route itself.
//
//   node scripts/_test_examine_after_chef.mjs
// ============================================================================

import fs from 'node:fs';
import '../public/turn-core.js';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { deriveState, scanProject, isPhantomResult } from './fleet-status-core.mjs';

const TC = globalThis.TurnCore;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const scenario = (t) => console.log(`\n▶ ${t}`);
const L = (evs) => evs.map(e => JSON.stringify(e));
const ts = (m) => `2026-10-09T${m}:00.000Z`;

// ---------- fixtures: the production sequence ---------------------------------
const RUN_OLD = 'p-20261009T123458-aaaaaa';
const RUN_NEW = 'p-20261009T155209-bbbbbb';
const PAUSE = [
  { type: 'user_prompt', text: 'Ajoute un article générique', pipeline: { run: RUN_OLD, pipeline: 'dev', mode: 'complet' }, timestamp: ts('12:34') },
  { type: 'system', subtype: 'pipeline_start', pipeline: { run: RUN_OLD }, text: `exécution ${RUN_OLD}`, timestamp: ts('12:34') },
  { type: 'system', subtype: 'pipeline_summary', pipeline: { run: RUN_OLD }, text: 'en pause', timestamp: ts('12:35') },
  { type: 'assistant', synthetic: true, message: { content: [{ type: 'text', text: '⏸ travail en pause, votre décision est attendue.\n\nNEEDS_USER_INPUT: répondez « continuer » ou « abandonner »' }] }, timestamp: ts('12:35') },
  { type: 'result', subtype: 'success', synthetic: true, pipeline_paused: true, result: '⏸ en pause\n\nNEEDS_USER_INPUT: répondez « continuer » ou « abandonner »', timestamp: ts('12:35') },
];
// The chef relays the answer by dispatching a NEW pipeline run (Incident,
// Discussion…) on the same musician: sourced prompt, pipeline_start, steps.
const CHEF_RUN = [
  { type: 'user_prompt', source: 'chef', callback: 'chef', text: 'Répare le code cassé avant de continuer', pipeline: { run: RUN_NEW, pipeline: 'incident' }, timestamp: ts('15:52') },
  { type: 'system', subtype: 'pipeline_start', pipeline: { run: RUN_NEW }, text: `exécution ${RUN_NEW} : pipeline Incident`, timestamp: ts('15:52') },
  { type: 'system', subtype: 'pipeline_step_start', pipeline: { run: RUN_NEW, step: 'detecter' }, timestamp: ts('15:53') },
  { type: 'system', subtype: 'pipeline_step_done', pipeline: { run: RUN_NEW, step: 'detecter' }, timestamp: ts('15:56') },
];
// …and that run ends on a result WITHOUT any assistant event (engine result).
const CHEF_RUN_END = [
  { type: 'system', subtype: 'pipeline_summary', pipeline: { run: RUN_NEW }, text: 'terminée', timestamp: ts('15:58') },
  { type: 'result', subtype: 'success', result: '# Diagnostic\nLe blocage vient de la demande.', timestamp: ts('15:58') },
];
const FAIL = [
  { type: 'user_prompt', text: 'go', timestamp: ts('11:00') },
  { type: 'system', subtype: 'init', timestamp: ts('11:00') },
  { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 2, duration_api_ms: 10, timestamp: ts('11:01') },
];
const DUAL_START = { type: 'system', subtype: 'dual_start', dual: { run: 'd-1' }, timestamp: ts('16:00') };
// A sourced callback / notify line is still NOT a turn start.
const CALLBACK = { type: 'user_prompt', source: 'notify', text: '[eps] Tour terminé', timestamp: ts('15:00') };

// ---------- the real reducers --------------------------------------------------
function sliceFn(src, head) {
  const a = src.indexOf(head);
  if (a < 0) throw new Error(`introuvable : ${head}`);
  return src.slice(a, src.indexOf('\n}\n', a) + 2);
}
function makeReduce() {
  const states = new Map();
  // eslint-disable-next-line no-new-func
  const fn = new Function('musicianAutoStates', 'isPhantomResult', 'isQuestionResolved', 'NEEDS_CHEF_RE', 'isAcknowledged', 'isConductorStop', 'stopInfo',
    `${sliceFn(SRC, 'function reduceMusician(')}\nreturn reduceMusician;`)(states, isPhantomResult, TC.isQuestionResolved, /NEEDS_CHEF_INPUT:\s*([^\n]+)/i, TC.isAcknowledged, TC.isConductorStop, TC.stopInfo);
  return (evs) => { let r = null; for (const e of evs) r = fn('P', e); return r; };
}
function scanProjectStateOf(evs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-sps-'));
  fs.writeFileSync(path.join(dir, 'P.jsonl'), L(evs).join('\n') + '\n');
  // eslint-disable-next-line no-new-func
  const sps = new Function('fs', 'path', 'LOGS_DIR', 'SCAN_TAIL_BYTES', 'readMarker', 'isPhantomResult', 'isQuestionResolved', 'isAcknowledged', 'isConductorStop', 'stopInfo',
    `${sliceFn(SRC, 'function scanProjectState(')}\nreturn scanProjectState;`)(fs, path, dir, 256 * 1024, () => null, isPhantomResult, TC.isQuestionResolved, TC.isAcknowledged, TC.isConductorStop, TC.stopInfo);
  const out = sps('P');
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
function scanOf(evs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-fs-'));
  fs.writeFileSync(path.join(dir, 'P.jsonl'), L(evs).join('\n') + '\n');
  const out = scanProject('P', dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
// Client: the real `Musician` class in a vm context with minimal doubles.
const CLIENT_SRC = [
  APP.slice(APP.indexOf('const NEEDS_CHEF_INPUT_RE'), APP.indexOf('\n', APP.indexOf('const NEEDS_CHEF_INPUT_RE'))),
  APP.slice(APP.indexOf('const RING_MAX'), APP.indexOf('\n', APP.indexOf('const RING_MAX'))),
  APP.slice(APP.indexOf('const CARD_MAX_W'), APP.indexOf('\n', APP.indexOf('const CARD_MAX_W'))),
  sliceFn(APP, 'const STATE_LABELS = {').replace(/\n}\n$/, '\n'),
  sliceFn(APP, 'function stripReplyPrefixes('),
  sliceFn(APP, 'function toolArgPreview('),
  sliceFn(APP, 'class Musician {'),
  'globalThis.Musician = Musician;',
].join('\n');
function clientOf(evs, initial = {}) {
  const ctx = { console, Date, JSON, Math, Number, String, Object, Array, Set, Map, RegExp,
    App: { localAckedDenials: () => [], reorderSoon() {} }, fetch: async () => ({ ok: true, json: async () => ({}) }) };
  ctx.window = { TurnCore: TC, PermissionDenial: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CLIENT_SRC, ctx);
  const m = new ctx.Musician({ name: 'P', ...initial });
  for (const e of evs) m.transition(e);
  return m;
}

// ---------- 1. a pending question superseded by a chef-dispatched run ---------
scenario('Pause (question) puis exécution lancée par le chef : plus « input » pendant le tour');
{
  const during = [...PAUSE, ...CHEF_RUN];
  ok(TC.isTurnStart(CHEF_RUN[1]) && TC.isTurnStart(DUAL_START) && !TC.isTurnStart(CHEF_RUN[0]) && !TC.isTurnStart(CALLBACK),
     'TurnCore.isTurnStart : pipeline_start / dual_start ouvrent un tour, un prompt sourcé seul non');
  ok(deriveState(L(PAUSE)).state === 'input', 'avant : la pause est une question ouverte');
  const d = deriveState(L(during));
  ok(d.state === 'live' && d.turnStartTs === Date.parse(ts('15:52')), 'fleet-status : « en cours » dès pipeline_start (durée du tour comprise)');
  const s = scanOf(during);
  ok(s.state === 'live' && s.needsInput === null, '/api/pupitre : live, plus de « needs: … »');
  ok(scanProjectStateOf(during).state === 'live', '/api/config (scanProjectState) : live');
  const r = makeReduce()(during);
  ok(r.newState === 'live', 'pump (reduceMusician) : live');
  ok(clientOf(during).state === 'live', 'client (Musician.transition) : live — la carte quitte « À examiner »');
}

scenario('Fin de l’exécution du chef sans texte assistant : pas de retour de l’ancienne question');
{
  const all = [...PAUSE, ...CHEF_RUN, ...CHEF_RUN_END];
  const d = deriveState(L(all));
  ok(d.state === 'unread', `fleet-status : terminé (« unread »), pas « input » (état ${d.state})`);
  ok(scanOf(all).needsInput === null, '/api/pupitre : needsInput nul');
  ok(scanProjectStateOf(all).state === 'unread', '/api/config : unread');
  const reduce = makeReduce();
  reduce([...PAUSE, ...CHEF_RUN]);
  const end = reduce(CHEF_RUN_END);
  ok(end.prevState === 'live' && end.newState === 'unread',
     'pump : live → unread (le résultat est notifié et la file drainée comme un tour normal)');
  ok(clientOf(all).state === 'unread', 'client : unread');
}

scenario('Une NOUVELLE question posée par l’exécution du chef reste bien ouverte');
{
  const asks = [...PAUSE, ...CHEF_RUN,
    { type: 'assistant', synthetic: true, message: { content: [{ type: 'text', text: 'NEEDS_USER_INPUT: Quelle version ?' }] }, timestamp: ts('15:59') },
    { type: 'result', subtype: 'success', synthetic: true, pipeline_paused: true, result: 'NEEDS_USER_INPUT: Quelle version ?', timestamp: ts('15:59') }];
  const s = scanOf(asks);
  ok(s.state === 'input' && s.needsInput === 'Quelle version ?', 'fleet-status : la nouvelle question, pas l’ancienne');
  ok(scanProjectStateOf(asks).state === 'input' && makeReduce()(asks).newState === 'input' && clientOf(asks).state === 'input',
     '/api/config, pump et client : input');
}

scenario('Un échec dépassé par une exécution du chef ne reste pas rouge pendant le tour');
{
  const evs = [...FAIL, ...CHEF_RUN];
  ok(deriveState(L(evs)).state === 'live' && scanProjectStateOf(evs).state === 'live' && makeReduce()(evs).newState === 'live' && clientOf(evs).state === 'live',
     'error → live dans les 4 réducteurs');
}

scenario('Inchangé : un prompt sourcé (callback, notify) n’ouvre pas de tour');
{
  const evs = [...PAUSE, CALLBACK];
  ok(deriveState(L(evs)).state === 'input' && scanProjectStateOf(evs).state === 'input' && makeReduce()(evs).newState === 'input' && clientOf(evs).state === 'input',
     'la question reste ouverte dans les 4 réducteurs');
}

// ---------- 2. « Répondu » : the real resolve route ----------------------------
scenario('POST /api/question/:p/resolve réel : acquittement possible pendant un tour, jamais d’erreur sur une carte périmée');
{
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-route-'));
  const log = path.join(DIR, 'P.jsonl');
  // A paused run on disk: the acknowledgement must never touch it.
  const runDir = path.join(DIR, 'runs', RUN_OLD);
  fs.mkdirSync(runDir, { recursive: true });
  const runJson = JSON.stringify({ run: RUN_OLD, status: 'paused', pausedLimit: 'precondition' });
  fs.writeFileSync(path.join(runDir, 'run.json'), runJson);
  const A0 = SRC.indexOf("app.post('/api/question/:project/resolve'");
  const ROUTE = SRC.slice(A0, SRC.indexOf('\n});\n', A0) + 5);
  const qapp = express();
  // eslint-disable-next-line no-new-func
  new Function('app', 'express', 'config', 'scanFleetMember', 'dispatchPidAliveAsync', 'fs', 'path', 'LOGS_DIR', 'console', 'debugLog', ROUTE)(
    qapp, express, { projects: [{ name: 'P' }] }, (n) => scanProject(n, DIR), async () => 4242 /* a turn is running */,
    fs, path, DIR, { log: () => {} }, () => {});
  const srv = await new Promise(r => { const s = qapp.listen(0, '127.0.0.1', () => r(s)); });
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/question/P/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const lines = () => fs.readFileSync(log, 'utf8').trim().split('\n').length;

  // a) question still open while a process is alive (old log, or a run whose
  //    opening the server has not read yet): acknowledged, nothing relaunched.
  fs.writeFileSync(log, L(PAUSE).join('\n') + '\n');
  let r = await post({ note: 'répondu via le chef', by: 'utilisateur' });
  ok(r.status === 200 && r.body.ok === true, `question ouverte + tour vivant ⇒ 200 (avant : 409 « le musicien tourne ») — ${r.status}`);
  const last = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  ok(last.type === 'notification' && last.subtype === 'question_resolved' && last.note === 'répondu via le chef',
     'seul un événement question_resolved est ajouté au log');
  ok(scanProject('P', DIR).state === 'idle', 'la carte repasse « prêt »');

  // b) the chef's run already took the question over: stale card ⇒ 409 marked
  //    alreadyHandled (the client hides the card, no error), nothing written.
  fs.writeFileSync(log, L([...PAUSE, ...CHEF_RUN]).join('\n') + '\n');
  const n0 = lines();
  r = await post({ note: 'bis' });
  ok(r.status === 409 && r.body.alreadyHandled === true && r.body.state === 'live' && /prise en charge/.test(r.body.error),
     `carte périmée (tour du chef en cours) ⇒ 409 alreadyHandled, état live — ${JSON.stringify(r.body)}`);
  ok(lines() === n0, 'rien n’est écrit');
  ok(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8') === runJson, 'l’exécution en pause n’est jamais touchée (run.json identique)');
  await new Promise(r => srv.close(r));
  fs.rmSync(DIR, { recursive: true, force: true });
}

// ---------- 3. the client handles alreadyHandled without an error ------------
scenario('Client : « Répondu » sur une carte périmée la masque au lieu d’afficher une erreur');
{
  const body = sliceFn(APP.replace(/^ {2}/gm, ''), 'async resolveQuestion(');
  ok(/alreadyHandled/.test(body) && /if \(!resp\.ok && !already\) throw/.test(body),
     'resolveQuestion : un 409 alreadyHandled n’est pas une erreur');
  ok(/m\.setState\(/.test(body) && /renderAttention\(\)/.test(body),
     'resolveQuestion : l’état local est aligné sur le serveur et « À examiner » est redessiné');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
// exitCode, not exit(): exiting while fetch's keep-alive sockets close trips a
// libuv assertion on Windows.
process.exitCode = fail ? 1 : 0;
