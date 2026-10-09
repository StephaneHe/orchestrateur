#!/usr/bin/env node
// ============================================================================
// scripts/restart-orchestrateur.mjs — deterministic server restart helper.
// ============================================================================
//
// Replaces the dangerous "dispatch to the orchestrateur sub-agent and tell
// it to restart the server" pattern. The sub-agent runs INSIDE the same
// repo as server.js, so an LLM-driven kill/edit/restart loop creates a
// bootstrap problem: if the agent breaks server.js or fails to relaunch,
// you lose the dashboard with no recovery channel. This script is pure
// mechanics — no Claude in the loop, no shell interpolation, no user input.
//
// Steps:
//   1. Find any process listening on PORT (7777) via spawnSync('netstat').
//   2. spawnSync('taskkill', ['/PID', pid, '/T', '/F'])  — clean tree kill.
//   3. Poll until the port is free (TCP TIME_WAIT can hold ~30s).
//   4. Launch `node server.js` detached via `cmd start /B` (see launchHidden).
//   5. Poll http://127.0.0.1:7777/ until any HTTP status (401 = token gate
//      sane, 200 = open).
//   6. Exit 0 on success, non-zero on failure.
//
// Usage:
//   node I:/orchestrateur/scripts/restart-orchestrateur.mjs
//   node I:/orchestrateur/scripts/restart-orchestrateur.mjs --no-kill   (only start)
//   node I:/orchestrateur/scripts/restart-orchestrateur.mjs --kill-only (only kill)
// ============================================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 7777;
const HEALTH_URL = `http://127.0.0.1:${PORT}/`;

const args = process.argv.slice(2);
const KILL_ONLY = args.includes('--kill-only');
const NO_KILL   = args.includes('--no-kill');

function log(msg) { console.log(`[restart] ${msg}`); }
function err(msg) { console.error(`[restart] ${msg}`); }

/** Find PIDs holding the given TCP port (LISTENING state).
 *  Uses spawnSync (no shell interpretation). */
function findListenerPids(port) {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || !r.stdout) {
    err(`netstat failed (status=${r.status}): ${r.stderr || '(no stderr)'}`);
    return [];
  }
  const pids = new Set();
  const portMatcher = new RegExp(`:${port}\\b`);
  for (const line of r.stdout.split('\n')) {
    if (!/LISTENING/.test(line)) continue;
    if (!portMatcher.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    if (Number.isFinite(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** taskkill on Windows. Returns true if the kill command exited 0.
 *  No shell — args are passed as an array. */
function killPid(pid) {
  log(`taskkill /PID ${pid} /T /F`);
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit' });
  return r.status === 0;
}

/** Wait until no process is listening on the port (or timeout). */
async function waitPortFree(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = findListenerPids(port);
    if (pids.length === 0) return true;
    await sleep(500);
  }
  return false;
}

/** Probe HEALTH_URL — any HTTP response means the server is bound and serving. */
async function isServerUp() {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    return r.status > 0;
  } catch { return false; }
}

async function waitServerUp(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp()) return true;
    await sleep(500);
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** logs\server.out, unless another process still holds it open (a leftover
 *  server instance): cmd's `>` redirect then fails and `start` exits 1,
 *  which is exactly how 59 watchdog restarts failed on 2026-09-16. */
function pickOutputFile() {
  const primary = 'logs\\server.out';
  try {
    fs.closeSync(fs.openSync(path.join(ROOT, primary), 'a'));
    return primary;
  } catch (e) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fallback = `logs\\server-${stamp}.out`;
    err(`${primary} unusable (${e.code}) — writing to ${fallback}`);
    return fallback;
  }
}

/** Launch node server.js fully detached via `cmd /c start "" /B`.
 *
 *  History: tried `spawn('powershell', ['-File', start.ps1], {detached, unref})`
 *  multiple times — Windows job objects on Git-Bash and Claude-CLI Bash
 *  tool sessions kept tearing down the new powershell despite detached.
 *  No new boot stamp ever appeared (verified 28 + 29 avril). The reliable
 *  detach on Windows is the cmd built-in `start "" /B` which does NOT
 *  inherit job-object membership and creates a real background process.
 *
 *  We bypass start.ps1 because it does interactive things (Start-Job,
 *  Start-Process for the browser) that don't suit a true daemon launch.
 *  Instead we replicate its essentials inline: Set-Location, scrub the
 *  API key, run node server.js redirected to logs/server.out. */
function launchHidden() {
  // Use cwd + relative paths to keep the cmd line free of quoting hell.
  // `start /B` with no title argument creates a true background process
  // that doesn't inherit our job object. Relative `node server.js` and
  // `logs\server.out` work because we set cwd via spawnSync below.
  const outFile = pickOutputFile();
  log(`launching via cmd start /B in ${ROOT} (stdout → ${outFile})`);
  const r = spawnSync('cmd', ['/c', `start /B node server.js >> ${outFile} 2>&1`], {
    cwd: ROOT,
    stdio: 'ignore',
    // Marqueurs du tour qui relance (pipelines, 0.48.0) : jamais hérités par le serveur.
    env: { ...process.env, ANTHROPIC_API_KEY: '', ORCH_TURN_PROJECT: '', ORCH_TURN_STEP: '', ORCH_STEP_TOKEN: '' },
    windowsHide: true,
  });
  if (r.status !== 0) {
    err(`cmd start exited ${r.status}`);
    return false;
  }
  return true;
}

async function main() {
  if (!NO_KILL) {
    const pids = findListenerPids(PORT);
    if (pids.length === 0) {
      log(`no process listening on ${PORT} — nothing to kill`);
    } else {
      log(`found PID(s) on :${PORT}: ${pids.join(', ')}`);
      for (const pid of pids) killPid(pid);
    }
    log(`waiting for port ${PORT} to free…`);
    const free = await waitPortFree(PORT, 30_000);
    if (!free) {
      err(`port ${PORT} still busy after 30s — aborting`);
      process.exit(2);
    }
    log(`port ${PORT} free`);
  }

  if (KILL_ONLY) {
    log(`--kill-only: stopping here`);
    process.exit(0);
  }

  if (await isServerUp()) {
    log(`server already responding — not launching a duplicate`);
    process.exit(0);
  }

  if (!launchHidden()) process.exit(3);

  // 60s, not 30: cold-start of start.ps1 can include Test-Path node_modules,
  // tailscale ip lookup, JIT warm-up, antivirus scan of node.exe — easily
  // pushes first bind past 30s on a loaded machine.
  log(`waiting for ${HEALTH_URL} to respond (up to 60s)…`);
  const up = await waitServerUp(60_000);
  if (!up) {
    err(`server did not respond within 60s — check logs/server.out and logs/server-crash.log`);
    process.exit(4);
  }
  log(`server is up`);
  process.exit(0);
}

main().catch(e => {
  err(`fatal: ${e && e.stack || e}`);
  process.exit(1);
});
