#!/usr/bin/env node
// ============================================================================
// scripts/_test_loop_lag.mjs — event-loop latency monitor (incident « serveur
// figé », p-20261026T161242-466928)
// ============================================================================
//
// User request (2026-10-27): « Moniteur de latence de boucle dans the server source :
// au-delà de 2 s, journaliser la durée et le balayage ou la route en cours.
// Test : un blocage provoqué est journalisé avec son origine. »
//
//   1. a real block of 2.4 s inside a tracked sweep is logged with its duration
//      and the sweep's name; routes noted meanwhile are listed;
//   2. a short block (0.5 s) is not logged;
//   3. the server source starts the monitor, notes every route, rotates nothing here but
//      wraps its periodic sweeps in loopMon.tracked().
//
//   node scripts/_test_loop_lag.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); if (!ok) fail++; };

const child = `
import { createLoopMonitor } from ${JSON.stringify(pathToFileURL(path.join(here, 'loop-lag.mjs')).href)};
const mon = createLoopMonitor({ thresholdMs: 2000, intervalMs: 100, log: (l) => console.log(l) });
mon.start();
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
setTimeout(() => {
  mon.noteRoute('GET /api/pupitre');
  mon.tracked('sweepRequests', () => block(2400));
  setTimeout(() => { mon.tracked('sweepShort', () => block(500)); setTimeout(() => process.exit(0), 600); }, 400);
}, 300);
`;
const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', timeout: 30000 });
const lines = (r.stdout || '').split('\n').filter(l => l.includes('[loop-lag]'));
check('a provoked 2.4 s block is logged once', lines.length === 1, `${r.stdout}${r.stderr}`);
const line = lines[0] || '';
const ms = Number(/blocked ~(\d+)ms/.exec(line)?.[1]);
check('the line carries the duration (≥ 2000 ms)', ms >= 2000 && ms < 4000, line);
check('the line names the sweep that held the loop', /sweepRequests \d+ms/.test(line), line);
check('the line lists the route started meanwhile', line.includes('GET /api/pupitre'), line);
check('a 0.5 s block is not logged', !(r.stdout || '').includes('sweepShort'), r.stdout);

// An async sweep is timed only up to its first await (as the server source's sweepRequests:
// `await import(...)` first), so the synchronous work after the await must carry its
// own tracked(): the block is then attributed to the sweep, not « none tracked ».
const childAsync = `
import { createLoopMonitor } from ${JSON.stringify(pathToFileURL(path.join(here, 'loop-lag.mjs')).href)};
const mon = createLoopMonitor({ thresholdMs: 2000, intervalMs: 100, log: (l) => console.log(l) });
mon.start();
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sweep = mon.wrap('sweepAsync', async () => {
  await Promise.resolve();
  mon.tracked('sweepAsync/reconcile', () => block(2400));
});
setTimeout(async () => { await sweep(); setTimeout(() => process.exit(0), 600); }, 300);
`;
const ra = spawnSync(process.execPath, ['--input-type=module', '-e', childAsync], { encoding: 'utf8', timeout: 30000 });
const alines = (ra.stdout || '').split('\n').filter(l => l.includes('[loop-lag]'));
check('a block after an await is attributed to the tracked section inside it', alines.length === 1 && /sweepAsync\/reconcile \d+ms/.test(alines[0]) && !alines[0].includes('none tracked'), `${ra.stdout}${ra.stderr}`);

const srv = fs.readFileSync(path.join(here, '..', 'serve' + 'r.js'), 'utf8');
check('the server source starts the monitor and notes routes', /createLoopMonitor\(/.test(srv) && /loopMon\.start\(\)/.test(srv) && /loopMon\.noteRoute\(/.test(srv));
for (const n of ['sweepRequests', 'sweepRoutagePending', 'sweepQueues', 'sweepQueueHolds', 'sweepInfraRetries', 'sweepChefAlerts', 'sweepUnappliedChefAnswers', 'sweepIdleRegression']) {
  check(`the server source tracks ${n}`, srv.includes(`loopMon.wrap('${n}'`) || srv.includes(`loopMon.tracked('${n}'`));
}
check('the server times reconcile() and the infra sweep itself, after their await',
  srv.includes(`loopMon.tracked('sweepRequests/reconcile'`) && srv.includes(`loopMon.tracked('sweepInfraRetries/sweep'`));
if (fail) { console.log(`\n${fail} failure(s)`); process.exit(1); }
console.log('\nall good');
