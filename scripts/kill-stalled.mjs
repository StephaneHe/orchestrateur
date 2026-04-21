#!/usr/bin/env node
// ============================================================================
// scripts/kill-stalled.mjs — terminate a stuck sub-agent so it can be
// redispatched. Reads logs/<project>.pid, kills the whole tree, removes
// the pid file, and writes a synthetic `result` event to the log so the
// UI transitions out of `live`.
//
// Usage:
//   node scripts/kill-stalled.mjs <projectName>
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');

const project = process.argv[2];
if (!project) { console.error('usage: node scripts/kill-stalled.mjs <project>'); process.exit(64); }

const pidPath = path.join(LOGS, `${project}.pid`);
const logPath = path.join(LOGS, `${project}.jsonl`);

let pid = null;
try { pid = Number(fs.readFileSync(pidPath, 'utf8').trim()); } catch {}
if (!pid) { console.error(`[kill-stalled] no pid file for ${project} — nothing to kill`); }

if (pid) {
  // Kill the whole tree: /T = tree, /F = force. Works on Windows; on POSIX
  // fall back to SIGKILL.
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit' });
    if (r.status !== 0) console.error(`[kill-stalled] taskkill exited ${r.status}`);
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}

try { fs.unlinkSync(pidPath); } catch {}

// Write a terminal event so the viewer stops showing 'live'.
try {
  fs.appendFileSync(logPath, '\n' + JSON.stringify({
    type: 'result',
    subtype: 'error_killed_by_conductor',
    is_error: true,
    timestamp: new Date().toISOString(),
    duration_ms: 0,
    result: `Turn terminated by conductor supervision (killed pid ${pid ?? 'unknown'}).`,
  }) + '\n');
} catch (e) {
  console.error(`[kill-stalled] could not append terminal event: ${e.message}`);
}

console.log(`killed ${project} (pid ${pid ?? '—'}), log marked with error result`);
