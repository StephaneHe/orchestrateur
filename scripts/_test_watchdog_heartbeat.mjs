#!/usr/bin/env node
// ============================================================================
// scripts/_test_watchdog_heartbeat.mjs — no restart while the server's
// heartbeat is fresh, even on DOWN probes (incident « serveur figé », 2026-10-26)
// ============================================================================
//
// User request (2026-10-27): « Chien de garde : aucun redémarrage si le battement
// du serveur date de moins de 3 min, même sur des sondes « down ». Rejeu du cas
// réel en test. »
//
// Real case: probes failed (classed DOWN) while the server was alive and had
// written its 60 s heartbeat to logs/server-crash.log seconds before; the
// watchdog restarted it and killed every running turn.
//
// A private copy of the real watchdog (timings rewritten) probes a closed port
// (every probe is DOWN) in three situations:
//   1. last crash-log line = fresh heartbeat      → no restart;
//   2. last line = heartbeat older than 3 min     → restart;
//   3. fresh heartbeat then an exit line (dead)   → restart.
//
//   node scripts/_test_watchdog_heartbeat.mjs
// ============================================================================

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'server-watchdog.mjs'), 'utf8');

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); if (!ok) failures++; };

// A port nobody listens on.
const probeSock = net.createServer();
await new Promise(r => probeSock.listen(0, '127.0.0.1', r));
const port = probeSock.address().port;
await new Promise(r => probeSock.close(r));

const hb = (ageMs) => `[${new Date(Date.now() - ageMs).toISOString()}] heartbeat uptime=100s rss=100mb heap=50mb sse=0 pid=1\n`;

async function scenario(label, crashLog) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-hb-'));
  fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'logs'));
  const marker = path.join(root, 'restarted.txt');
  fs.writeFileSync(path.join(root, 'scripts', 'restart-orchestrateur.mjs'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'restart\\n');\n`);
  if (crashLog != null) fs.writeFileSync(path.join(root, 'logs', 'server-crash.log'), crashLog);
  const rewritten = src
    .replace('const PORT = 7777;', `const PORT = ${port};`)
    .replace('const WATCHDOG_INTERVAL_MS = 10_000;', 'const WATCHDOG_INTERVAL_MS = 100;')
    .replace('const PROBE_TIMEOUT_MS = 8_000;', 'const PROBE_TIMEOUT_MS = 250;')
    .replace('const STARTUP_GRACE_MS = 90_000;', 'const STARTUP_GRACE_MS = 0;')
    .replace('const RESTART_COOLDOWN_MS = 60_000;', 'const RESTART_COOLDOWN_MS = 0;');
  if (!rewritten.includes(`PORT = ${port}`) || !rewritten.includes('INTERVAL_MS = 100')) check(`${label}: sandbox rewrite`, false);
  fs.writeFileSync(path.join(root, 'scripts', 'server-watchdog.mjs'), rewritten);
  const wd = spawn(process.execPath, [path.join(root, 'scripts', 'server-watchdog.mjs')], { cwd: root, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2500));
  wd.kill();
  const log = fs.existsSync(path.join(root, 'logs', 'watchdog.log')) ? fs.readFileSync(path.join(root, 'logs', 'watchdog.log'), 'utf8') : '';
  const restarted = fs.existsSync(marker);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  return { restarted, log };
}

const fresh = await scenario('fresh', hb(20_000));
check('probes are DOWN (the case is the one that used to restart)', /probe DOWN/.test(fresh.log), fresh.log);
check('1. fresh heartbeat (20 s): no restart despite DOWN probes', !fresh.restarted, fresh.log);
check('1. the skip is logged with the heartbeat age', /restart skipped — server heartbeat \d+s old/.test(fresh.log), fresh.log);

const stale = await scenario('stale', hb(5 * 60_000));
check('2. heartbeat older than 3 min: the dead server is restarted', stale.restarted, stale.log);

const dead = await scenario('dead', hb(20_000) + `[${new Date().toISOString()}] exit code=0\n`);
check('3. fresh heartbeat followed by an exit line: restarted', dead.restarted, dead.log);

// The loop monitor writes its [loop-lag] report to the same log right after a freeze,
// and warnings land there too: neither says the process is dead.
const noisy = await scenario('noisy', hb(20_000)
  + `[${new Date().toISOString()}] [loop-lag] event loop blocked ~11000ms (threshold 2000ms) — sweeps: sweepRequests/reconcile 11000ms; routes started meanwhile: none\n`
  + `[${new Date().toISOString()}] WARNING MaxListenersExceededWarning: possible leak\n`);
check('5. fresh heartbeat followed by a [loop-lag] report and a warning: no restart', !noisy.restarted, noisy.log);

const none =await scenario('none', null);
check('4. no crash log at all: restarted as before', none.restarted, none.log);

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall good');
