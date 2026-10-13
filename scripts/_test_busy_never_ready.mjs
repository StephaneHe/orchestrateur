#!/usr/bin/env node
// A musician whose turn's process still runs is never « Prêt » (0.78.1).
//
// User report (2026-10-13): « A partir du moment où quelque chose tourne,
// attaché à un projet, et que ça empêche le projet d'avancer (en l'occurence
// le musicien est affiché comme Prêt), alors c'est un problème qu'il faut
// corriger. » — « Ce ne devrait pas être quelque chose en plus, mais ça
// devrait déjà être le cas. […] toute tâche qui tourne attachée à un musicien
// fait que le musicien est En cours, ou en Reflexion, en tout cas, pas Prêt ».
//
// Reproduces the incident: the turn wrote its `result`, but its process
// (logs/<p>.pid) is still alive, waiting for a background job it started.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../public/turn-core.js';
import { scanProject, stillRunning, openBackgroundTasks, PID_STALE_MS } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TC = globalThis.TurnCore;
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 500)}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-ready-'));
const keep = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
try {
  const log = (name, events) => fs.writeFileSync(path.join(T, `${name}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const turn = [
    { type: 'user_prompt', text: 'Lance la non-régression puis commite', timestamp: iso(700_000) },
    { type: 'system', subtype: 'init', session_id: 's', model: 'claude-x', timestamp: iso(699_000) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Je lance la ciblée.' }] }, timestamp: iso(650_000) },
    { type: 'system', subtype: 'task_started', task_id: 'b1', description: 'Non-régression ciblée de la 0.77.0', is_backgrounded: true, task_type: 'local_bash', timestamp: iso(640_000) },
    { type: 'system', subtype: 'task_started', task_id: 'a2', description: 'Agent au premier plan', is_backgrounded: false, task_type: 'local_agent', timestamp: iso(630_000) },
    { type: 'result', subtype: 'success', is_error: false, result: 'Je reviens quand la ciblée a fini.', num_turns: 4, duration_ms: 60_000, timestamp: iso(600_000) },
  ];

  console.log('── 1. Result écrit, processus du tour encore vivant ⇒ « En cours », jamais « Prêt »');
  log('p', turn);
  fs.writeFileSync(path.join(T, 'p.pid'), String(keep.pid));
  let s = scanProject('p', T);
  ok(s.state === 'live' && s.logState === 'unread', `état affiché live (le log seul dirait ${s.logState})`, JSON.stringify({ state: s.state, logState: s.logState }));
  ok(s.lingering?.pid === keep.pid && s.lingering.sinceMs >= 590_000, 'lingering : processus et durée depuis le result', JSON.stringify(s.lingering));
  ok(s.lingering.background.length === 1 && s.lingering.background[0].what === 'Non-régression ciblée de la 0.77.0', 'la tâche d’arrière-plan qui le retient (pas la tâche au premier plan)', JSON.stringify(s.lingering.background));
  ok(/tour terminé, processus encore actif depuis 10m\d\d : Non-régression ciblée de la 0\.77\.0/.test(s.activity), `activité : ${s.activity}`);
  ok(!s.stalled && !s.deadInFlight, 'ni « sans progrès » ni « processus perdu » : aucune alarme, rien n’est tué');

  console.log('\n── 2. La tâche d’arrière-plan finit, le processus vit encore ⇒ toujours en cours');
  log('p', [...turn, { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', timestamp: iso(5000) }]);
  s = scanProject('p', T);
  ok(s.state === 'live' && s.lingering && s.lingering.background.length === 0 && /travail en arrière-plan/.test(s.activity), `toujours en cours : ${s.activity}`);

  console.log('\n── 3. Le processus s’arrête ⇒ l’état du log revient');
  keep.kill();
  await sleep(500);
  s = scanProject('p', T);
  ok(s.state === 'unread' && !s.lingering, `processus arrêté → ${s.state}`, JSON.stringify(s.lingering));

  console.log('\n── 4. Cas limites');
  const keep2 = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
  try {
    fs.writeFileSync(path.join(T, 'p.pid'), String(keep2.pid));
    const old = (Date.now() - PID_STALE_MS - 60_000) / 1000;
    fs.utimesSync(path.join(T, 'p.pid'), old, old);
    ok(scanProject('p', T).state === 'unread', 'fichier .pid de plus de 12 h ignoré (même règle que la file du serveur)');
    fs.writeFileSync(path.join(T, 'p.pid'), String(keep2.pid));
    log('q', [...turn.slice(0, 2), { type: 'assistant', message: { content: [{ type: 'text', text: 'Prêt.\nNEEDS_USER_INPUT: on publie ?' }] }, timestamp: iso(2000) },
      { type: 'result', subtype: 'success', result: 'Prêt.\nNEEDS_USER_INPUT: on publie ?', timestamp: iso(1000) }]);
    fs.writeFileSync(path.join(T, 'q.pid'), String(keep2.pid));
    ok(scanProject('q', T).state === 'input', 'une question ouverte reste une question (ni Prêt ni masquée)');
    log('r', turn.slice(0, 4));
    fs.writeFileSync(path.join(T, 'r.pid'), String(keep2.pid));
    const r = scanProject('r', T);
    ok(r.state === 'live' && !r.lingering, 'tour encore en cours dans le log : inchangé (pas de « lingering »)');
  } finally { keep2.kill(); }
  ok(stillRunning('idle', { alive: true }) && stillRunning('unread', { alive: true }) && !stillRunning('error', { alive: true }) && !stillRunning('idle', { alive: false }) && !stillRunning('idle', null), 'stillRunning : idle/unread + processus vivant seulement');
  ok(openBackgroundTasks(turn.map(e => JSON.stringify(e))).map(t => t.id).join() === 'b1', 'openBackgroundTasks : arrière-plan seulement');

  console.log('\n── 5. Client : la même règle pour la carte, le panneau et le rail (TurnCore.reconcileBusy)');
  const R = TC.reconcileBusy;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok(eq(R('unread', null, true), { state: 'live', held: 'unread' }) && eq(R('idle', null, true), { state: 'live', held: 'idle' }), 'Terminé/Prêt + processus vivant → En cours (état du log gardé de côté)');
  ok(eq(R('live', 'unread', true), { state: 'live', held: 'unread' }), 'tant qu’il vit : reste en cours');
  ok(eq(R('live', 'unread', false), { state: 'unread', held: null }) && eq(R('live', 'idle', false), { state: 'idle', held: null }), 'processus arrêté → l’état du log revient');
  ok(eq(R('live', null, false), { state: 'live', held: null }) && eq(R('input', null, true), { state: 'input', held: null }) && eq(R('error', null, true), { state: 'error', held: null }), 'tour réellement en cours, question, échec : inchangés');

  console.log('\n── 6. Câblage');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/\(snap\.state === 'idle' \|\| snap\.state === 'unread'\) && dispatchPidAlive\(p\.name\)[\s\S]{0,80}currentState: 'live', heldState: snap\.state/.test(srv), '/api/config : état initial « live » avec le même signal que la file (dispatchPidAlive)');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok(/TurnCore\.reconcileBusy\(m\.state, m\.heldState \|\| null, !!r\.lingering\)/.test(app) && /this\.heldState = project\.heldState/.test(app), 'dashboard : chaque instantané /api/pupitre réconcilie l’état ; hydratation avec heldState');
} finally {
  try { keep.kill(); } catch { /* */ }
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
