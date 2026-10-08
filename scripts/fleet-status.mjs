#!/usr/bin/env node
// ============================================================================
// scripts/fleet-status.mjs — one-shot health report for all musicians.
// ============================================================================
//
// The central claude (conductor) runs this periodically to supervise the
// fleet. It reads each project's logs/<name>.jsonl tail, replays the same
// state reducer the viewer uses (states + stall detection), and emits a
// compact report.
//
// The state/silence/stall logic lives in scripts/fleet-status-core.mjs — the
// SAME module the server's live desk view (/api/pupitre) imports, so the CLI
// and the dashboard never diverge on "what is each musician doing?".
//
// Usage:
//   node scripts/fleet-status.mjs              # human-readable table
//   node scripts/fleet-status.mjs --json       # machine-readable
//   node scripts/fleet-status.mjs --stalled    # only stalled musicians (exit 2 if any)
//
// "Stalled" = state is live/think AND no non-partial event for >= 60s AND
// no terminal `result` event has been written. These are the turns the
// conductor needs to decide about: resume, retry, or kill.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject, fmtAge } from './fleet-status-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

function renderTable(rows) {
  const cols = [
    ['MUSICIAN',  r => r.name.padEnd(18)],
    ['STATE',     r => (r.stalled ? 'STALLED' : r.state.toUpperCase()).padEnd(8)],
    ['LAST',      r => String(r.lastKind).padEnd(26)],
    ['SILENCE',   r => fmtAge(r.silentMs).padEnd(8)],
    ['FILE-AGE',  r => fmtAge(r.fileSilentMs).padEnd(8)],
    ['PID',       r => (r.pid ? String(r.pid) + (r.pidAlive ? ' alive' : ' dead') : '—').padEnd(12)],
    // L'état reste LIVE pendant une attente d'autorisation (les scripts
    // restart-when-idle du chef y lisent « occupé ») ; la note le précise.
    ['NOTE',      r => r.awaitingPermission
      ? `ATTEND AUTORISATION : ${r.awaitingPermission.tool} — ${String(r.awaitingPermission.preview || '').slice(0, 60)}${r.awaitingPermission.deadline ? ` (reste ${fmtAge(r.awaitingPermission.deadline - Date.now())})` : ''} — ne pas tuer`
      : r.needsInput ? `needs: ${r.needsInput}` : (r.stalled ? 'STALL — consider intervention' : '')],
  ];
  const out = [cols.map(c => c[0]).join('  ')];
  for (const r of rows) out.push(cols.map(c => c[1](r)).join('  '));
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const wantJson    = args.includes('--json');
  const onlyStalled = args.includes('--stalled');

  const config = loadConfig();
  const rows = config.projects.map(p => scanProject(p.name));
  const filtered = onlyStalled ? rows.filter(r => r.stalled) : rows;

  if (wantJson) {
    process.stdout.write(JSON.stringify({ now: new Date().toISOString(), fleet: filtered }, null, 2) + '\n');
  } else {
    if (!filtered.length && onlyStalled) {
      console.log('no stalled musicians — fleet healthy');
    } else {
      console.log(renderTable(filtered));
    }
  }
  // Non-zero exit when --stalled finds something — lets the conductor gate on it.
  process.exit(onlyStalled && filtered.length ? 2 : 0);
}

main();
