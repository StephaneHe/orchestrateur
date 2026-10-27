#!/usr/bin/env node
// ============================================================================
// scripts/_test_reconcile_incremental.mjs — the 60 s requests sweep must not
// re-read huge logs (incident « serveur figé », p-20261026T161242-466928)
// ============================================================================
//
// User request (2026-10-27): « Réconciliation sans relecture massive :
// mémoriser par tâche l'offset et la taille déjà parcourus, ne relire que les
// octets ajoutés […], borner le travail d'un passage. Test : un passage sur un
// journal de plusieurs centaines de Mo reste sous un budget fixé, et un second
// passage sans ajout ne relit rien. »
//
// Protected: reconcile() on a task acknowledged in a ~100 MB log
//   1. one pass reads a bounded number of bytes (work per pass is capped);
//   2. once caught up, a pass with nothing appended reads (almost) nothing;
//   3. bytes appended later are read, and only those.
//
//   node scripts/_test_reconcile_incremental.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as RQ from './requests.mjs';
import { textHash } from './routage-pending.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const MB = 1024 * 1024;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-incr-'));
const LOGS = path.join(TMP, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

// Count every byte the sweep reads from a file under LOGS.
let bytes = 0;
const inLogs = (f) => typeof f === 'string' && path.resolve(f).startsWith(LOGS);
const fdPath = new Map();
const origOpen = fs.openSync, origRead = fs.readSync, origReadFile = fs.readFileSync;
fs.openSync = function (f, ...a) { const fd = origOpen.call(fs, f, ...a); if (inLogs(String(f))) fdPath.set(fd, String(f)); return fd; };
fs.readSync = function (fd, ...a) { const n = origRead.call(fs, fd, ...a); if (fdPath.has(fd)) bytes += n; return n; };
fs.readFileSync = function (f, ...a) { const r = origReadFile.call(fs, f, ...a); if (inLogs(String(f)) && r?.length) bytes += r.length; return r; };
const measure = (fn) => { bytes = 0; fn(); return bytes; };

try {
  // ~100 MB musician log: the task's user_prompt first, then a long tail of events.
  const log = path.join(LOGS, 'P.jsonl');
  const line = JSON.stringify({ type: 'assistant', timestamp: '2026-10-27T00:00:00.000Z', text: 'x'.repeat(1000) }) + '\n';
  const chunk = line.repeat(1000);
  const fd = fs.openSync(log, 'w');
  for (let i = 0; i < 100; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const size0 = fs.statSync(log).size;

  const r = RQ.createRequest(LOGS, { project: 'chef', text: 'Tâche sur un gros journal' });
  const t = RQ.addTask(LOGS, r.id, { projet: 'P', demande: 'Travaille sur P.' });
  RQ.ackTask(LOGS, RQ.taskIdOf(r.id, t.n), { where: 'log', log, offset: 0, hash: 'sans-resultat', turn: 't-big', pid: process.pid });

  const sweep = () => RQ.reconcile({ root: ROOT, logsDir: LOGS, launch: () => ({}), alive: () => true });

  console.log(`\n── journal de ${(size0 / MB).toFixed(0)} Mo, tâche accusée à l'offset 0`);
  const first = measure(sweep);
  ok(first <= 32 * MB, `1. un passage lit un volume borné (${(first / MB).toFixed(1)} Mo lus, plafond 32 Mo)`);

  for (let i = 0; i < 8; i++) sweep(); // catch up (bounded passes converge)
  const idle = measure(sweep);
  ok(idle <= 1 * MB, `2. rattrapé, un passage sans ajout ne relit rien (${(idle / MB).toFixed(2)} Mo lus, plafond 1 Mo)`);

  const extra = line.repeat(50); // ~50 KB appended
  fs.appendFileSync(log, extra);
  const delta = measure(sweep);
  ok(delta <= 1 * MB, `3. un ajout de ${(Buffer.byteLength(extra) / 1024).toFixed(0)} Ko ne relit que l'ajout (${(delta / MB).toFixed(2)} Mo lus)`);

  // ── 4. no false « sans-résultat » while the log is still being caught up ────
  // The turn's process is dead, the ack is old, and the result lies at the END of
  // a log bigger than one pass: until the log is read to its end there is no verdict.
  console.log('\n── résultat loin dans le journal, processus mort');
  {
    const L = path.join(LOGS, 'R.jsonl');
    const demande = 'Travaille sur R, tâche loin.';
    const fdr = fs.openSync(L, 'w');
    fs.writeSync(fdr, JSON.stringify({ type: 'user_prompt', text: demande, timestamp: '2026-10-27T00:00:00.000Z' }) + '\n');
    for (let i = 0; i < 40; i++) fs.writeSync(fdr, chunk); // ~40 MB between the prompt and the result
    fs.writeSync(fdr, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fini', num_turns: 4, duration_api_ms: 900, timestamp: '2026-10-27T00:10:00.000Z' }) + '\n');
    fs.closeSync(fdr);
    const r4 = RQ.createRequest(LOGS, { project: 'chef', text: 'Résultat tardif' });
    const t4 = RQ.addTask(LOGS, r4.id, { projet: 'R', demande });
    RQ.ackTask(LOGS, RQ.taskIdOf(r4.id, t4.n), { where: 'log', log: L, offset: 0, hash: textHash(demande), turn: 't-far', pid: 999999 });
    const later = Date.now() + 3600_000; // far past the 2 min ack timeout
    const states = [];
    for (let i = 0; i < 8; i++) {
      RQ.reconcile({ root: ROOT, logsDir: LOGS, now: later, launch: () => ({}), alive: () => false });
      states.push(RQ.readRequest(LOGS, r4.id).tasks[0].state);
    }
    ok(!states.includes('à_traiter'), `4. jamais « sans résultat » tant que le journal n'est pas lu jusqu'au bout (états : ${[...new Set(states)].join(' → ')})`);
    ok(states.at(-1) === 'réussie', `4. le résultat lointain est trouvé après le rattrapage (état final : ${states.at(-1)})`);
  }

  // ── 5. the work of one pass is bounded across all tasks ─────────────────────
  console.log('\n── cinq tâches, cinq journaux de ~20 Mo : le passage entier est borné');
  {
    const r5 = RQ.createRequest(LOGS, { project: 'chef', text: 'Cinq tâches' });
    for (let k = 1; k <= 5; k++) {
      const L = path.join(LOGS, `B${k}.jsonl`);
      const fdb = fs.openSync(L, 'w');
      for (let i = 0; i < 20; i++) fs.writeSync(fdb, chunk);
      fs.closeSync(fdb);
      const t = RQ.addTask(LOGS, r5.id, { projet: `B${k}`, demande: `Tâche ${k}` });
      RQ.ackTask(LOGS, RQ.taskIdOf(r5.id, t.n), { where: 'log', log: L, offset: 0, hash: `sans-resultat-${k}`, turn: `t-${k}`, pid: process.pid });
    }
    const total = measure(sweep);
    ok(total <= 70 * MB, `5. un passage sur 5 journaux lit un volume borné (${(total / MB).toFixed(1)} Mo lus, plafond 70 Mo ; sans budget : 80 Mo)`);
  }

  // ── 6. a task without acknowledgement does not re-read the project log ─────
  console.log('\n── tâche sans accusé sur un gros journal : lue une fois, pas à chaque passage');
  {
    const L = path.join(LOGS, 'U.jsonl');
    const fdu = fs.openSync(L, 'w');
    for (let i = 0; i < 20; i++) fs.writeSync(fdu, chunk);
    fs.closeSync(fdu);
    const r6 = RQ.createRequest(LOGS, { project: 'chef', text: 'Sans accusé' });
    RQ.addTask(LOGS, r6.id, { projet: 'U', demande: 'Tâche jamais vue dans le journal.' });
    measure(sweep); measure(sweep); // first looks (bounded), then caught up
    const again = measure(sweep);
    ok(again <= 1 * MB, `6. un journal inchangé n'est pas relu pour chercher l'accusé (${(again / MB).toFixed(2)} Mo lus)`);
    fs.appendFileSync(L, line.repeat(20));
    const grown = measure(sweep);
    ok(grown <= 8 * MB, `6. un journal qui a grandi ne relit que la fin (${(grown / MB).toFixed(2)} Mo lus, plafond 8 Mo)`);
  }

  // ── 7. budget exhausted DURING the look for the acknowledgement: no verdict ─
  // The main log is read first and eats the whole budget; the lane log that holds
  // the acknowledgement is skipped. The task must not be called « sans-accusé ».
  console.log('\n── budget épuisé pendant la recherche de l\'accusé');
  {
    const demande7 = 'Tâche dont l\'accusé est dans un couloir.';
    const r7 = RQ.createRequest(LOGS, { project: 'chef', text: 'Accusé en couloir' });
    const t7 = RQ.addTask(LOGS, r7.id, { projet: 'X', demande: demande7 });
    const tid7 = RQ.taskIdOf(r7.id, t7.n);
    fs.writeFileSync(path.join(LOGS, 'X.jsonl'), line.repeat(3000)); // ~3 MB, no ack in it
    fs.mkdirSync(path.join(LOGS, 'lanes', 'X'), { recursive: true });
    fs.writeFileSync(path.join(LOGS, 'lanes', 'X', '1.jsonl'), JSON.stringify({ type: 'user_prompt', text: demande7, taskId: tid7, orch_turn: 't-lane', timestamp: new Date().toISOString() }) + '\n');
    const later = Date.now() + 3600_000;
    const saved = process.env.ORCH_RECONCILE_BUDGET_BYTES;
    process.env.ORCH_RECONCILE_BUDGET_BYTES = String(1 * MB);
    RQ.reconcile({ root: ROOT, logsDir: LOGS, now: later, launch: () => ({}), alive: () => true });
    const tight = RQ.readRequest(LOGS, r7.id).tasks[0].state;
    ok(tight !== 'à_traiter', `7. budget épuisé avant le journal de couloir : pas de verdict « sans-accusé » (état : ${tight})`);
    if (saved === undefined) delete process.env.ORCH_RECONCILE_BUDGET_BYTES; else process.env.ORCH_RECONCILE_BUDGET_BYTES = saved;
    RQ.reconcile({ root: ROOT, logsDir: LOGS, now: later, launch: () => ({}), alive: () => true });
    const rich = RQ.readRequest(LOGS, r7.id).tasks[0];
    ok(rich.ack?.where === 'log' && /lanes/.test(String(rich.ack.log)), `7. avec le budget normal, l'accusé du couloir est trouvé (état : ${rich.state})`);
  }
} finally {
  fs.openSync = origOpen; fs.readSync = origRead; fs.readFileSync = origReadFile;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} ok, ${fail} ko`);
process.exit(fail ? 1 : 0);
