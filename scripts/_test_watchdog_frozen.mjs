#!/usr/bin/env node
// ============================================================================
// scripts/_test_watchdog_frozen.mjs — a frozen server is not restarted like a
// dead one (2026-10-26 incident)
// ============================================================================
//
// Real case: the 60 s request sweep blocked the server's event loop for
// 10-18 s; two probes timed out, the watchdog called the server DOWN and
// restarted it, killing every running turn. A process that stays bound to its
// port while not answering is SLOW (needs ~18 failed probes), never DOWN
// (2 probes). portIsListening() built its regex in a template literal, where
// `\s` collapses to `s` (`:7777s`), so it never matched netstat and every
// timeout was classed DOWN.
//
// Replay: a private copy of the real watchdog (port, timings rewritten, as the
// regression sandbox does) probes a server that accepts connections and never
// answers. Over a window far shorter than 18 probes, no restart must happen.
//
//   node scripts/_test_watchdog_frozen.mjs
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
function check(name, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

// Frozen server: accepts the TCP connection, never writes a byte.
const sockets = [];
const frozen = net.createServer(s => { sockets.push(s); s.on('error', () => {}); });
await new Promise(r => frozen.listen(0, '127.0.0.1', r));
const port = frozen.address().port;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-frozen-'));
fs.mkdirSync(path.join(root, 'scripts'));
fs.mkdirSync(path.join(root, 'logs'));
const marker = path.join(root, 'restarted.txt');
fs.writeFileSync(path.join(root, 'scripts', 'restart-orchestrateur.mjs'),
  `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'restart\\n');\n`);

const rewritten = src
  .replace('const PORT = 7777;', `const PORT = ${port};`)
  .replace('const WATCHDOG_INTERVAL_MS = 10_000;', 'const WATCHDOG_INTERVAL_MS = 150;')
  .replace('const PROBE_TIMEOUT_MS = 8_000;', 'const PROBE_TIMEOUT_MS = 250;')
  .replace('const STARTUP_GRACE_MS = 90_000;', 'const STARTUP_GRACE_MS = 0;')
  .replace('const RESTART_COOLDOWN_MS = 60_000;', 'const RESTART_COOLDOWN_MS = 0;');
check('sandbox copy rewrote port and timings',
  rewritten.includes(`PORT = ${port}`) && rewritten.includes('INTERVAL_MS = 150') && rewritten.includes('STARTUP_GRACE_MS = 0'));
fs.writeFileSync(path.join(root, 'scripts', 'server-watchdog.mjs'), rewritten);

const wd = spawn(process.execPath, [path.join(root, 'scripts', 'server-watchdog.mjs')], {
  cwd: root, stdio: ['ignore', 'ignore', 'ignore'],
});

// ~5 probes at 400 ms cadence is plenty for the old code (2 probes) to restart,
// and far below the 18 SLOW probes that justify killing a frozen server.
await new Promise(r => setTimeout(r, 3000));
wd.kill();
for (const s of sockets) s.destroy();
frozen.close();

const log = fs.existsSync(path.join(root, 'logs', 'watchdog.log'))
  ? fs.readFileSync(path.join(root, 'logs', 'watchdog.log'), 'utf8') : '';
const restarted = fs.existsSync(marker);
check('the watchdog ran and probed the frozen server', /probe (DOWN|SLOW)/.test(log), log || 'no log');
check('a server bound to its port but not answering is not restarted after a few probes',
  !restarted, 'restart script was called; log:\n' + log);
check('the failed probes are classed SLOW, not DOWN', /probe SLOW/.test(log) && !/probe DOWN/.test(log), log);

try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall good');
