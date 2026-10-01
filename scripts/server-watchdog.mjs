#!/usr/bin/env node
// ============================================================================
// scripts/server-watchdog.mjs — auto-restart guardian for the orchestrator.
// ============================================================================
//
// Polls the server every WATCHDOG_INTERVAL_MS via http://127.0.0.1:7777/.
// Any HTTP response (including 401 from the token gate) counts as alive.
//
// Failures are classified, because they call for opposite reactions:
//   - DOWN : connection refused, or nothing LISTENING on the port.
//            → restart after CONSEC_DOWN_TO_RESTART probes (~20s).
//   - SLOW : probe timed out but a process IS bound to the port (event loop
//            blocked by sync I/O on the USB disk, big log scans…).
//            → killing it loses in-flight work and was the root trigger of
//              the 2026-09-16 outage; only restart after a sustained freeze
//              (CONSEC_SLOW_TO_RESTART probes, ~3 min).
//
// STARTUP_GRACE_MS: at logon the watchdog task can start before the server
// task has bound the port. Restarting then launches a second instance that
// races the first — so no restarts during the grace window.
//
// We deliberately don't try to diagnose the death — that's what the
// crash log + heartbeats are for. The watchdog only ensures uptime
// between root-cause investigations.
//
// Usage:
//   node scripts/server-watchdog.mjs                     # foreground
//   cmd /c start "" /B node scripts/server-watchdog.mjs  # detached
//
// Stop: create a file at logs/watchdog.stop — the loop exits cleanly
// at next tick.
//
// Status: tail logs/watchdog.log to see probe history + restarts.
// ============================================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'logs', 'watchdog.log');
const STOP_FILE = path.join(ROOT, 'logs', 'watchdog.stop');
const RESTART_SCRIPT = path.join(ROOT, 'scripts', 'restart-orchestrateur.mjs');
const PORT = 7777;
const HEALTH_URL = `http://127.0.0.1:${PORT}/`;

const WATCHDOG_INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 8_000;
const STARTUP_GRACE_MS = 90_000;
const CONSEC_DOWN_TO_RESTART = 2;         // ≈ 20s
const CONSEC_SLOW_TO_RESTART = 18;        // ≈ 3 min of unbroken freeze
const RESTART_COOLDOWN_MS = 60_000;       // don't restart more than once per minute

const startedAt = Date.now();
let consecDown = 0;
let consecSlow = 0;
let restartCount = 0;
let lastRestartTs = 0;
let ticking = false;

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(LOG_FILE, stamped); } catch {}
  try { process.stderr.write(stamped); } catch {}
}

function portIsListening(port) {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000 });
  // If netstat itself fails, assume bound: the SLOW path is the cautious one.
  if (r.status !== 0 || !r.stdout) return true;
  const portMatcher = new RegExp(`:${port}\s`);
  return r.stdout.split('\n').some(l => /LISTENING/.test(l) && portMatcher.test(l));
}

/** @returns {'up'|'down'|'slow'} */
async function probe() {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return r.status > 0 ? 'up' : 'down';
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    if (!timedOut) return 'down';
    return portIsListening(PORT) ? 'slow' : 'down';
  }
}

function triggerRestart(reason) {
  const now = Date.now();
  if (now - lastRestartTs < RESTART_COOLDOWN_MS) {
    log(`restart skipped — cooldown (${Math.round((now - lastRestartTs) / 1000)}s since last)`);
    return;
  }
  lastRestartTs = now;
  restartCount++;
  log(`SERVER ${reason} — calling restart-orchestrateur.mjs (restart #${restartCount})`);
  // spawnSync blocks until the script returns. The script itself spawns
  // the new server detached, so it returns once HTTP responds (or after
  // its own 60s timeout).
  const r = spawnSync(process.execPath, [RESTART_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
    timeout: 120_000,
  });
  log(`restart script exit=${r.status} (signal=${r.signal || 'none'})`);
  if (r.stdout) log(`restart stdout: ${r.stdout.toString().trim().split('\n').slice(-3).join(' | ')}`);
  if (r.stderr && r.stderr.length) log(`restart stderr: ${r.stderr.toString().trim().split('\n').slice(-3).join(' | ')}`);
}

async function tick() {
  if (fs.existsSync(STOP_FILE)) {
    log(`stop file detected — exiting`);
    try { fs.unlinkSync(STOP_FILE); } catch {}
    process.exit(0);
  }
  const state = await probe();
  if (state === 'up') {
    if (consecDown || consecSlow) log(`server back up after ${consecDown} down / ${consecSlow} slow probe(s)`);
    consecDown = 0;
    consecSlow = 0;
    return;
  }
  const inGrace = Date.now() - startedAt < STARTUP_GRACE_MS;
  if (state === 'down') {
    consecDown++;
    consecSlow = 0;
    log(`probe DOWN #${consecDown}${inGrace ? ' (startup grace)' : ''}`);
    if (!inGrace && consecDown >= CONSEC_DOWN_TO_RESTART) {
      triggerRestart('DOWN');
      consecDown = 0;
    }
  } else {
    consecSlow++;
    consecDown = 0;
    log(`probe SLOW #${consecSlow}/${CONSEC_SLOW_TO_RESTART} (port bound, no answer in ${PROBE_TIMEOUT_MS}ms)`);
    if (!inGrace && consecSlow >= CONSEC_SLOW_TO_RESTART) {
      triggerRestart(`FROZEN ${Math.round(consecSlow * WATCHDOG_INTERVAL_MS / 1000)}s`);
      consecSlow = 0;
    }
  }
}

function safeTick() {
  // A restart blocks for up to 2 min; never stack ticks behind it.
  if (ticking) return;
  ticking = true;
  tick().catch(e => log(`tick error: ${e.message}`)).finally(() => { ticking = false; });
}

log(`==== watchdog start pid=${process.pid} interval=${WATCHDOG_INTERVAL_MS}ms grace=${STARTUP_GRACE_MS}ms ====`);

safeTick();
setInterval(safeTick, WATCHDOG_INTERVAL_MS);

// Defensive — don't let an unhandled error inside the watchdog itself kill it.
process.on('uncaughtException', (e) => log(`UNCAUGHT in watchdog: ${e.message}`));
process.on('unhandledRejection', (r) => log(`UNHANDLED in watchdog: ${r}`));
