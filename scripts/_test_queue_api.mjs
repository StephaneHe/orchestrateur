#!/usr/bin/env node
// ============================================================================
// scripts/_test_queue_api.mjs — retirer une tâche de file sans redémarrer
// ============================================================================
//
// Incident du 25/09/2026 : la file d'un musicien ne se modifiait qu'en éditant
// logs/queue/<projet>.json, que le serveur ignore (mémoire = vérité) puis
// réécrit — deux tâches déjà faites sont revenues en tête de TranslateOverlay.
//
// Ce harnais charge, depuis server.js, le BLOC RÉEL de la file par musicien
// (de `const dispatchQueue` à l'appel `loadQueuesFromDisk();`) et le BLOC RÉEL
// des routes /api/queue, les monte sur un vrai express sur un port éphémère,
// puis pilote le VRAI scripts/queue.mjs contre lui (ORCH_PORT). Le serveur de
// production (7777) n'est jamais contacté ; tout vit dans un dossier temporaire.
//
//   node scripts/_test_queue_api.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
function slice(from, to) {
  const a = SRC.indexOf(from), b = SRC.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`bornes introuvables : ${from} … ${to}`);
  return SRC.slice(a, b);
}
const QUEUE_SRC  = slice('const dispatchQueue = new Map()', 'loadQueuesFromDisk();');
const ROUTES_SRC = slice('function queueProjectOr404', "app.delete('/api/pool/queue/:ticket'");

let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const scenario = (n) => console.log(`\n── ${n}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-api-'));
const LOGS_DIR = path.join(TMP, 'logs');
fs.mkdirSync(path.join(LOGS_DIR, 'queue'), { recursive: true });
const config = { projects: [{ name: 'Alpha' }, { name: 'Beta' }] };

// ---------- 1. migration au boot : ids attribués, ordre et contenu intacts --

scenario('boot : les entrées sans id reçoivent un id stable, rien d’autre ne bouge');
const legacy = [
  { prompt: 'tâche hébreu (déjà faite)', attachmentPaths: [], videoPaths: [], callback: 'chef', model: 'claude-opus-5' },
  { prompt: 'créer le repo GitHub', attachmentPaths: [], videoPaths: [], callback: 'chef' },
  { prompt: 'bug des images', attachmentPaths: ['x.png'], videoPaths: [] },
];
fs.writeFileSync(path.join(LOGS_DIR, 'queue', 'Alpha.json'), JSON.stringify(legacy));

function boot() {
  // eslint-disable-next-line no-new-func
  return new Function('fs', 'path', 'crypto', 'LOGS_DIR', 'config', 'debugLog',
    `${QUEUE_SRC}\nloadQueuesFromDisk();\nreturn { dispatchQueue, queuePush, queueRemove, queueClear, queueEntryView, persistQueue };`)(
    fs, path, crypto, LOGS_DIR, config, () => {});
}
let Q = boot();
const alpha = Q.dispatchQueue.get('Alpha');
ok(alpha.length === 3 && alpha.every(e => /^q-\d+-[0-9a-f]{4}$/.test(e.id)), 'chaque entrée a un id');
ok(alpha.map(e => e.prompt).join('|') === legacy.map(e => e.prompt).join('|'), 'ordre et prompts inchangés');
ok(alpha[0].callback === 'chef' && alpha[0].model === 'claude-opus-5', 'callback et model conservés');
const idsFirstBoot = alpha.map(e => e.id);
Q = boot();
ok(Q.dispatchQueue.get('Alpha').map(e => e.id).join() === idsFirstBoot.join(), 'les ids sont persistés : identiques au boot suivant');

// ---------- 2. API + CLI réels ----------------------------------------------

const app = express();
// eslint-disable-next-line no-new-func
new Function('app', 'config', 'dispatchQueue', 'queueRemove', 'queueClear', 'queueEntryView',
  'dispatchPidAliveAsync', 'console', 'debugLog', ROUTES_SRC)(
  app, config, Q.dispatchQueue, Q.queueRemove, Q.queueClear, Q.queueEntryView,
  async (n) => (n === 'Alpha' ? 4242 : null), { log: () => {} }, () => {});
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const PORT = server.address().port;

// spawnSync bloquerait la boucle d'événements qui sert justement l'API :
// on lance donc le CLI en asynchrone.
import { spawn } from 'node:child_process';
function cli(...args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'queue.mjs'), ...args], {
      cwd: ROOT, env: { ...process.env, ORCH_PORT: String(PORT) },
    });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}
const http = async (method, p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method });
  return { status: r.status, body: await r.json().catch(() => null) };
};

scenario('GET /api/queue/:project et queue.mjs --list');
{
  const r = await http('GET', '/api/queue/Alpha');
  ok(r.status === 200 && r.body.count === 3 && r.body.busy === true, 'liste : 3 entrées, musicien occupé');
  const e = r.body.entries[0];
  ok(e.id === idsFirstBoot[0] && e.position === 1 && /hébreu/.test(e.head) && e.callback === 'chef' && e.model === 'claude-opus-5' && e.enqueuedAt,
     'chaque entrée expose id, position, extrait, date, model, callback');
  ok(r.body.entries[2].attachments === 1, 'les pièces jointes sont comptées');
  ok((await http('GET', '/api/queue/Inconnu')).status === 404, 'projet hors config ⇒ 404');

  const c = await cli('Alpha');
  ok(c.code === 0 && c.out.includes(idsFirstBoot[1]) && /OCCUPÉ/.test(c.out) && /repo GitHub/.test(c.out), 'queue.mjs liste lisiblement (ids, état, extraits)');
}

scenario('retrait ciblé sans redémarrage : mémoire ET fichier');
{
  const c = await cli('Alpha', '--remove', idsFirstBoot[0]);
  ok(c.code === 0 && /retiré/.test(c.out), 'queue.mjs --remove retire l’entrée');
  const onDisk = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, 'queue', 'Alpha.json'), 'utf8'));
  ok(onDisk.length === 2 && !onDisk.some(e => e.id === idsFirstBoot[0]), 'le sidecar est réécrit du même geste');
  ok(Q.dispatchQueue.get('Alpha')[0].id === idsFirstBoot[1], 'la suivante passe en tête');
  Q = boot();
  ok(Q.dispatchQueue.get('Alpha').length === 2 && Q.dispatchQueue.get('Alpha')[0].id === idsFirstBoot[1],
     'après un redémarrage, la tâche retirée NE revient PAS (le cas de l’incident)');

  const again = await cli('Alpha', '--remove', idsFirstBoot[0]);
  ok(again.code === 2 && /aucune entrée/.test(again.err), 'retirer deux fois ⇒ 404 explicite (code 2)');
  ok((await http('DELETE', '/api/queue/Alpha/q-nope')).status === 404, 'DELETE d’un id absent ⇒ 404');
}

scenario('vider une file');
{
  // L'API reste montée sur l'instance d'avant le « redémarrage » simulé :
  // on vérifie donc ici par HTTP et par le fichier, pas par `Q`.
  const c = await cli('Alpha', '--clear');
  ok(c.code === 0 && /vidée/.test(c.out), 'queue.mjs --clear vide la file');
  ok(!fs.existsSync(path.join(LOGS_DIR, 'queue', 'Alpha.json')), 'le sidecar disparaît (file vide)');
  const r = await http('GET', '/api/queue/Alpha');
  ok(r.body.count === 0, 'la file est vide');
}

scenario('enqueue : l’id naît à la mise en file');
{
  const n = Q.queuePush('Beta', { prompt: 'nouvelle tâche', attachmentPaths: [], videoPaths: [], callback: 'chef' });
  const e = Q.dispatchQueue.get('Beta')[n - 1];
  ok(/^q-\d+-[0-9a-f]{4}$/.test(e.id) && !Number.isNaN(Date.parse(e.enqueuedAt)), 'queuePush attribue id + enqueuedAt');
  ok(!/q\.push\(\{ prompt/.test(SRC) && (SRC.match(/queuePush\(/g) || []).length >= 3, 'server.js n’empile plus en direct : tout passe par queuePush');
}

scenario('garde-fous du CLI');
{
  const c = await cli('Alpha', '--remove');
  ok(c.code === 64, '--remove sans id refusé');
}

server.close();

// ---------- 3. drain : la tâche part, et ne revient pas en file (0.24.1) ------
//
// Cause exacte du 25/09 : le drain partait au `result`, le `claude` du tour
// était encore vivant, et le dispatch.mjs relancé (DISPATCH_SLOT hérité ⇒
// --queue-if-busy) se RE-POSTAIT en queue de file sous un nouvel id. On charge
// le bloc réel (drainQueue → sweepQueues) avec un PID pilotable.

const DRAIN_SRC = slice('function drainQueue(name, reason', '// ---------- File de direction (pool P0-A');
function drainSandbox() {
  const dq = new Map();
  const spawned = [];
  const pid = { alive: false };
  const states = new Map();
  let limited = null;
  const intervals = [];
  const api = new Function(
    'dispatchQueue', 'persistQueue', 'dispatchPidAlive', 'spawnDirectDispatch', 'readLimitedUntil',
    'musicianAutoStates', 'debugLog', 'console', 'setInterval',
    `${DRAIN_SRC}\nreturn { drainQueue, sweepQueues, queueStalledSince, drainLaunchedAt, drainPending };`)(
    dq, () => {}, () => (pid.alive ? 4242 : null),
    (name, prompt, a, v, opts) => { spawned.push({ name, prompt, opts }); return 1; },
    () => limited, states, () => {}, { log: () => {} }, (fn, ms) => { intervals.push(ms); return { unref() {} }; });
  return { api, dq, spawned, pid, states, setLimited: (v) => { limited = v; }, intervals };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const entry = (id, extra = {}) => ({ id, enqueuedAt: new Date().toISOString(), prompt: `tâche ${id}`, attachmentPaths: [], videoPaths: [], callback: 'chef', slot: 1, ticket: 'm-1-aaaa', ...extra });

scenario('drain au result : attend la mort du processus, puis lance SANS se re-poster');
{
  const s = drainSandbox();
  s.dq.set('Alpha', [entry('q-1'), entry('q-2')]);
  s.pid.alive = true;                       // le claude du tour qui finit n'est pas encore sorti
  s.api.drainQueue('Alpha');
  s.api.drainQueue('Alpha');                // second result (ou fantôme) pendant l'attente
  await sleep(1300);
  ok(s.spawned.length === 0 && s.dq.get('Alpha').length === 2, 'tant que le processus vit : rien ne part, rien ne tourne en rond');
  s.pid.alive = false;
  await sleep(1300);
  ok(s.spawned.length === 1 && s.spawned[0].prompt === 'tâche q-1', 'dès sa mort : la tête part, une seule fois');
  ok(s.spawned[0].opts.noQueueIfBusy === true, 'lancée avec --no-queue-if-busy (le fils ne re-décide pas de la file)');
  ok(s.spawned[0].opts.callback === 'chef' && s.spawned[0].opts.slot === 1, 'callback et slot conservés');
  ok(s.dq.get('Alpha').length === 1 && s.dq.get('Alpha')[0].id === 'q-2', 'la suivante attend, avec son id d’origine');
  const SRCd = SRC.slice(SRC.indexOf('function spawnDirectDispatch('), SRC.indexOf('function drainQueue('));
  ok(/opts\.noQueueIfBusy\) args\.push\('--no-queue-if-busy'\)/.test(SRCd), 'spawnDirectDispatch transmet bien --no-queue-if-busy');
}

scenario('drain : une tâche retirée pendant l’attente ne part pas');
{
  const s = drainSandbox();
  s.dq.set('Alpha', [entry('q-1')]);
  s.pid.alive = true;
  s.api.drainQueue('Alpha');
  s.dq.delete('Alpha');                     // queue.mjs --remove pendant l'attente
  s.pid.alive = false;
  await sleep(1300);
  ok(s.spawned.length === 0, 'rien n’est lancé');
}

scenario('balayage de secours : libre + aucun processus + file ≥ 60 s ⇒ drain');
{
  const s = drainSandbox();
  ok(s.intervals.includes(30_000), 'le balayage est armé toutes les 30 s');
  s.dq.set('Alpha', [entry('q-1')]);
  s.states.set('Alpha', { state: 'input' });
  s.api.sweepQueues();
  ok(s.api.queueStalledSince.has('Alpha') && s.spawned.length === 0, '1er passage : la file est notée, rien ne part encore');
  s.api.queueStalledSince.set('Alpha', Date.now() - 61_000);
  s.api.sweepQueues();
  await sleep(50);
  ok(s.spawned.length === 1, 'après 60 s : drain de secours (y compris en « input »)');

  for (const [label, setup] of [
    ['musicien en cours (live)', (x) => x.states.set('B', { state: 'live' })],
    ['processus vivant', (x) => { x.pid.alive = true; }],
    ['limite Claude active', (x) => x.setLimited('2099-01-01T00:00:00Z')],
    ['lancé il y a moins d’une minute', (x) => x.api.drainLaunchedAt.set('B', Date.now())],
  ]) {
    const x = drainSandbox();
    x.dq.set('B', [entry('q-9')]);
    setup(x);
    x.api.sweepQueues();
    x.api.queueStalledSince.set('B', Date.now() - 61_000);
    x.api.sweepQueues();
    await sleep(30);
    ok(x.spawned.length === 0, `pas de drain de secours si ${label}`);
  }
}

// ---------- 4. acquitter une question : route + CLI réels (0.25.0) ------------

scenario('POST /api/question/:p/resolve et resolve-question.mjs');
{
  const { scanProject } = await import('./fleet-status-core.mjs');
  const QLOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'q-api-'));
  const qlog = path.join(QLOGS, 'Alpha.jsonl');
  const ask = [
    { type: 'user_prompt', text: 'go', timestamp: '2026-09-26T09:00:00.000Z' },
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'NEEDS_USER_INPUT: Quelle langue ?' }] } },
    { type: 'result', subtype: 'success', num_turns: 3, duration_api_ms: 5000, result: 'NEEDS_USER_INPUT: Quelle langue ?' },
  ];
  fs.writeFileSync(qlog, ask.map(e => JSON.stringify(e)).join('\n') + '\n');
  const pidState = { alive: false };
  const qapp = express();
  const ROUTE = slice("app.post('/api/question/:project/resolve'", '// Register an Android device');
  // eslint-disable-next-line no-new-func
  new Function('app', 'express', 'config', 'scanFleetMember', 'dispatchPidAliveAsync', 'fs', 'path', 'LOGS_DIR', 'console', 'debugLog', ROUTE)(
    qapp, express, config, (n) => scanProject(n, QLOGS), async () => (pidState.alive ? 99 : null),
    fs, path, QLOGS, { log: () => {} }, () => {});
  const qsrv = await new Promise(r => { const s = qapp.listen(0, '127.0.0.1', () => r(s)); });
  const QPORT = qsrv.address().port;
  const rq = (...args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'resolve-question.mjs'), ...args], {
      cwd: ROOT, env: { ...process.env, ORCH_PORT: String(QPORT) },
    });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });

  pidState.alive = true;
  let r = await rq('Alpha');
  ok(r.code === 2 && /tour en cours/.test(r.out) && fs.readFileSync(qlog, 'utf8').trim().split('\n').length === ask.length,
     'tour en cours ⇒ refus (409), exit 2, rien d’écrit');
  pidState.alive = false;

  r = await rq('Alpha', '--note', 'répondu via le chef : hébreu');
  ok(r.code === 0 && /acquittée/.test(r.out) && /Quelle langue/.test(r.out), 'acquittée : sortie lisible (question + note)');
  const last = JSON.parse(fs.readFileSync(qlog, 'utf8').trim().split('\n').pop());
  ok(last.type === 'notification' && last.subtype === 'question_resolved' && last.note === 'répondu via le chef : hébreu' && last.by === 'chef',
     'l’événement est ajouté au log du musicien (par « chef »), avec la note');
  ok(scanProject('Alpha', QLOGS).state === 'idle', 'le musicien repasse « prêt » — sans aucun tour');

  r = await rq('Alpha');
  ok(r.code === 2 && /aucune question en attente/.test(r.out), 'plus de question ⇒ exit 2 (non nul), comme demandé');
  r = await rq('Inconnu');
  ok(r.code === 1 && /unknown project/.test(r.err), 'projet hors config ⇒ 404, exit 1');
  r = await rq('Alpha', '--note');
  ok(r.code === 64, '--note sans texte ⇒ usage');

  qsrv.close();
  fs.rmSync(QLOGS, { recursive: true, force: true });
}

scenario('fin de tour en « input » : la file est drainée');
{
  const cond = SRC.slice(SRC.indexOf('// Drain the per-musician queue on any turn completion'), SRC.indexOf('drainQueue(name);', SRC.indexOf('// Drain the per-musician queue on any turn completion')));
  ok(/newState === 'input'/.test(cond), 'la condition de drain du pump inclut newState === "input"');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
