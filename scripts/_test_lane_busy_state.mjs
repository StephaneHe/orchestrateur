#!/usr/bin/env node
// A turn or step running in ANY lane makes the musician « En cours » (0.162.2).
//
// User request (2026-11-03): « Rien ne tourne. orchestrateur-dev fait ce que tu
// lui demandes ? » — then « oui » to fixing the display defect. Observed case:
// step 01-vert of a pipeline run ran in lane 1 (process alive, lane log written
// < 1 min ago) while the main log ended on system/lane_task, so the card said
// « non lu » and fleet-status said UNREAD · system:lane_task. scanProject only
// read logs/<p>.jsonl (lane 0): the main copy must never mask a lane.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import '../public/turn-core.js';
import { scanProject } from './fleet-status-core.mjs';

let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 500)}` : ''}`); };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-busy-'));
const keep = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
try {
  const write = (file, events) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  };
  const main = (name, events) => write(path.join(T, `${name}.jsonl`), events);
  const lane = (name, k, events) => write(path.join(T, 'lanes', name, `${k}.jsonl`), events);
  const lanePid = (name, k, pid) => fs.writeFileSync(path.join(T, 'lanes', name, `${k}.pid`), String(pid));

  // Main copy idle; its log ends on the lane marker, as the dispatcher writes it.
  const idleMain = [
    { type: 'user_prompt', text: 'ancienne tâche', timestamp: iso(900_000) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Fait.' }] }, timestamp: iso(890_000) },
    { type: 'result', subtype: 'success', is_error: false, result: 'Fait.', num_turns: 2, duration_ms: 5000, timestamp: iso(880_000) },
    { type: 'system', subtype: 'lane_task', lane: 1, task: 't1', branch: 'lane/1/t1', state: 'running', title: 'corriger', timestamp: iso(217_000) },
  ];
  const runningLane = (sinceMs, lastMs) => [
    { type: 'user_prompt', text: 'corriger le défaut', timestamp: iso(sinceMs) },
    { type: 'system', subtype: 'init', session_id: 's', model: 'claude-x', timestamp: iso(sinceMs - 1000) },
    { type: 'system', subtype: 'pipeline_progress', text: 'étape vert en cours', timestamp: iso(lastMs) },
  ];

  console.log('── 1. Couloir 1 tourne (pid vivant), copie principale inactive ⇒ « En cours » avec le couloir');
  main('p', idleMain);
  lane('p', 1, runningLane(240_000, 20_000));
  lanePid('p', 1, keep.pid);
  let s = scanProject('p', T);
  ok(s.logState !== 'live', `le log principal seul dit ${s.logState} (cas du signalement)`);
  ok(s.state === 'live', `état affiché live (obtenu : ${s.state})`, JSON.stringify({ state: s.state, logState: s.logState }));
  ok(Array.isArray(s.lanes) && s.lanes.length === 1 && s.lanes[0].lane === 1 && s.lanes[0].state === 'live', 'lanes : le couloir 1 est listé en cours', JSON.stringify(s.lanes));
  ok(/couloir 1/.test(s.activity) && /4m\d\d/.test(s.activity), `activité : ${s.activity}`);
  ok(!s.stalled, 'couloir actif récemment : pas de STALLED');

  console.log('\n── 2. Couloir silencieux ⇒ STALLED, comme la copie principale');
  lane('p', 1, runningLane(900_000, 300_000));
  s = scanProject('p', T);
  ok(s.state === 'live' && s.stalled === true, 'couloir muet depuis 5 min ⇒ stalled', JSON.stringify({ state: s.state, stalled: s.stalled }));
  ok(s.lanes?.[0]?.stalled === true, 'le couloir porte lui-même stalled');

  console.log('\n── 2b. Exceptions du STALL, comme la copie principale');
  // Fresh provider heartbeat after a 6 min silence: waiting, not stalled.
  lane('p', 1, [...runningLane(900_000, 360_000),
    { type: 'system', subtype: 'heartbeat', provider: 'codex', waitingMs: 340_000, intervalMs: 30_000, timestamp: iso(20_000) }]);
  s = scanProject('p', T);
  ok(s.state === 'live' && !s.stalled && s.lanes?.[0]?.stalled === false, 'battement frais : pas de STALL', JSON.stringify(s.lanes));
  // Pending permission request, written in the MAIN log by the server.
  lane('p', 1, runningLane(900_000, 300_000));
  main('p', [...idleMain, { type: 'system', subtype: 'permission_request', timestamp: iso(100_000),
    permission: { id: 'perm-1', tool: 'Bash', preview: 'npm test', deadline: Date.now() + 200_000 } }]);
  s = scanProject('p', T);
  ok(s.state === 'live' && !s.stalled && s.lanes?.[0]?.awaitingPermission === true, 'autorisation en attente : pas de STALL', JSON.stringify(s.lanes));
  main('p', idleMain);
  // Process dead under an in-flight lane log: reported, never silent.
  fs.writeFileSync(path.join(T, 'lanes', 'p', '1.pid'), '2147483646');
  lane('p', 1, runningLane(240_000, 20_000));
  s = scanProject('p', T);
  ok(s.state === 'live' && s.deadInFlight === true && s.lanes?.[0]?.deadInFlight === true, 'processus de couloir perdu : deadInFlight', JSON.stringify({ s: s.state, d: s.deadInFlight }));
  lanePid('p', 1, keep.pid);

  console.log('\n── 3. Le couloir finit ⇒ retour à l’état normal');
  lane('p', 1, [...runningLane(240_000, 20_000),
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 3, duration_ms: 9000, timestamp: iso(1000) }]);
  fs.rmSync(path.join(T, 'lanes', 'p', '1.pid'), { force: true });
  s = scanProject('p', T);
  ok(s.state === s.logState && s.state !== 'live', `état normal : ${s.state}`);
  ok(!s.stalled && (!s.lanes || s.lanes.length === 0), 'plus de couloir actif ni de stall', JSON.stringify(s.lanes));

  console.log('\n── 4. Sans dossier de couloirs : inchangé');
  main('q', idleMain.slice(0, 3));
  s = scanProject('q', T);
  ok(s.state === s.logState && s.state !== 'live' && (!s.lanes || s.lanes.length === 0), `projet sans couloir : ${s.state}`);

  console.log('\n── 5. Pureté : scanProject ne modifie pas les fichiers de couloir');
  const f = path.join(T, 'lanes', 'p', '1.jsonl');
  const before = fs.readFileSync(f, 'utf8');
  scanProject('p', T);
  ok(fs.readFileSync(f, 'utf8') === before, 'lecture seule');
} finally { keep.kill(); fs.rmSync(T, { recursive: true, force: true }); }

console.log(`\n${pass} ok, ${fail} ko`);
process.exit(fail ? 1 : 0);
