#!/usr/bin/env node
// ============================================================================
// scripts/kill-stalled.mjs — terminate a stuck sub-agent so it can be
// redispatched. Reads logs/<project>.pid, kills the whole tree, removes
// the pid file, and writes a synthetic `result` event to the log so the
// UI transitions out of `live`.
//
// Usage:
//   node scripts/kill-stalled.mjs <projectName> [--reason "<motif>"] [--force]
//
// 0.45.0 — refuse (exit 3) un musicien qui attend une autorisation de
// l'utilisateur : il n'est pas bloqué. `--force` l'arrête quand même.
//
// 0.31.0 — the stop is shown as « Arrêté par le chef » (with the reason, when
// given), not as a failure. A `logs/<project>.killed` marker is written BEFORE
// the kill: dispatch.mjs sees it when its claude child dies and closes the turn
// quietly. Before, it wrote a second result (« model indisponible… le CLI a
// échoué sans result ») that masked the stop.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS
  ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS)
  : path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');

const argv = process.argv.slice(2);
const project = argv[0];
const USAGE = 'usage: node scripts/kill-stalled.mjs <project> [--reason "<motif>"] [--by chef|supervision|test|utilisateur] [--force]';
if (!project || project.startsWith('--')) { console.error(USAGE); process.exit(64); }
if (!/^[A-Za-z0-9._-]{1,64}$/.test(project)) { console.error(`invalid project name "${project}"`); process.exit(64); }
let reason = '';
let force = false;
// 0.47.2 : qui arrête (affiché « ■ Arrêté par … — motif », neutre, jamais rouge).
let by = 'chef';
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--reason' && i + 1 < argv.length) reason = argv[++i];
  else if (argv[i] === '--by' && i + 1 < argv.length) by = argv[++i];
  else if (argv[i] === '--force') force = true;
  else { console.error(USAGE); process.exit(64); }
}
if (!['chef', 'supervision', 'test', 'utilisateur'].includes(by)) { console.error(USAGE); process.exit(64); }
reason = reason.replace(/\s+/g, ' ').trim().slice(0, 300);

const pidPath = path.join(LOGS, `${project}.pid`);
const logPath = path.join(LOGS, `${project}.jsonl`);
const killedPath = path.join(LOGS, `${project}.killed`);

// 0.45.0 : un tour qui attend une autorisation n'est pas bloqué, il attend
// l'utilisateur (le délai le refusera de lui-même). On ne le tue pas par erreur.
if (!force) {
  const { scanProject } = await import('./fleet-status-core.mjs');
  const snap = scanProject(project, LOGS);
  if (snap.awaitingPermission) {
    const p = snap.awaitingPermission;
    console.error(`[kill-stalled] ${project} ATTEND UNE AUTORISATION (${p.tool} — ${p.preview}) : pas bloqué, il attend la décision de l'utilisateur` +
      `${p.deadline ? ` (refus automatique dans ${Math.max(0, Math.round((p.deadline - Date.now()) / 1000))} s)` : ''}. Rien n'est tué. --force pour l'arrêter quand même.`);
    process.exit(3);
  }
}

let pid = null;
try { pid = Number(fs.readFileSync(pidPath, 'utf8').trim()); } catch {}
if (!pid) { console.error(`[kill-stalled] no pid file for ${project} — nothing to kill`); }

if (pid) {
  try { fs.writeFileSync(killedPath, JSON.stringify({ pid, reason, ts: new Date().toISOString() })); } catch {}
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
    stopped_by: by,
    ...(reason ? { reason } : {}),
    timestamp: new Date().toISOString(),
    duration_ms: 0,
    result: `Turn terminated by ${by === 'chef' ? 'conductor supervision' : by} (killed pid ${pid ?? 'unknown'})${reason ? ` — ${reason}` : ''}.`,
  }) + '\n');
} catch (e) {
  console.error(`[kill-stalled] could not append terminal event: ${e.message}`);
}

const BY_WORD = { chef: 'par le chef', supervision: 'par la supervision', test: '(essai)', utilisateur: "par l'utilisateur" };
console.log(`killed ${project} (pid ${pid ?? '—'}), log marked « arrêté ${BY_WORD[by]} »${reason ? ` — ${reason}` : ''}`);
