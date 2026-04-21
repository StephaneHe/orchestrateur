#!/usr/bin/env node
// ============================================================================
// scripts/fleet-status.mjs — one-shot health report for all musicians.
// ============================================================================
//
// The central claude (conductor) runs this periodically to supervise the
// fleet. It reads each project's logs/<name>.jsonl tail, replays the same
// state reducer the viewer uses (five states + stall detection), and
// emits a compact report.
//
// Usage:
//   node scripts/fleet-status.mjs              # human-readable table
//   node scripts/fleet-status.mjs --json       # machine-readable
//   node scripts/fleet-status.mjs --stalled    # only report stalled musicians (exit 2 if any)
//
// "Stalled" = state is live/think AND no non-partial event for >= 60s AND
// no terminal `result` event has been written. These are the turns the
// conductor needs to decide about: resume, retry, or kill.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');

const STALL_SILENCE_MS = 60_000;          // live/think without progress → suspect
const TAIL_BYTES = 256 * 1024;            // only scan the last 256 KB

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

/** Read the last N bytes of a file and split into full JSON lines (dropping
 *  a partial head line that may be cut mid-object). */
function tailLines(filePath) {
  let st; try { st = fs.statSync(filePath); } catch { return { lines: [], mtimeMs: 0, size: 0 }; }
  const size = st.size;
  const fd = fs.openSync(filePath, 'r');
  const want = Math.min(TAIL_BYTES, size);
  const buf = Buffer.alloc(want);
  fs.readSync(fd, buf, 0, want, size - want);
  fs.closeSync(fd);
  // Filter NUL bytes that crashed writes can leave behind on Windows.
  const text = buf.toString('utf8').replace(/\u0000+/g, '');
  const raw = text.split('\n');
  if (raw.length > 1) raw.shift(); // drop the potentially-partial first slice
  return { lines: raw.filter(Boolean), mtimeMs: st.mtimeMs, size };
}

function lastMeaningful(lines) {
  // Walk backwards for the most recent non-partial, parseable event.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'stream_event') continue; // partials are not "progress"
      return ev;
    } catch { /* skip corrupt */ }
  }
  return null;
}

function lastAny(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev && typeof ev === 'object') return ev;
    } catch { /* skip */ }
  }
  return null;
}

function deriveState(lines) {
  // Mini-reducer — mirrors public/app.js Musician.transition for the
  // bits we care about here: is a turn currently running?
  let state = 'idle';
  let lastAssistantText = '';
  for (const ln of lines) {
    let ev; try { ev = JSON.parse(ln); } catch { continue; }
    const t = ev?.type;
    if (t === 'user_prompt' || (t === 'system' && ev.subtype === 'init')) {
      if (state === 'idle' || state === 'unread') state = 'live';
    } else if (t === 'assistant') {
      const blocks = ev.message?.content || [];
      let hasTool = false, hasThink = false, gotText = null;
      for (const b of blocks) {
        if (b?.type === 'text')     gotText = b.text || '';
        if (b?.type === 'thinking') hasThink = true;
        if (b?.type === 'tool_use') hasTool = true;
      }
      if (gotText) lastAssistantText = gotText;
      state = hasTool ? 'live' : (hasThink ? 'think' : 'live');
    } else if (t === 'result') {
      const isErr = !!ev.is_error || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'));
      const needs = /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(lastAssistantText);
      if (isErr && ev.synthetic) state = 'idle';          // crash/restart — no question was posed
      else state = isErr ? 'input' : (needs ? 'input' : 'unread');
    }
  }
  return { state, lastAssistantText };
}

function readPid(project) {
  try {
    const v = fs.readFileSync(path.join(LOGS, `${project}.pid`), 'utf8').trim();
    const pid = Number(v);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function fmtAge(ms) {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}`;
}

function scanProject(name) {
  const logPath = path.join(LOGS, `${name}.jsonl`);
  const { lines, mtimeMs, size } = tailLines(logPath);
  const last = lastMeaningful(lines);
  const tail = lastAny(lines);
  const { state, lastAssistantText } = deriveState(lines);
  const now = Date.now();
  const lastMeaningfulTs = last?.timestamp ? Date.parse(last.timestamp) : (mtimeMs || 0);
  const lastEventTs = tail?.timestamp ? Date.parse(tail.timestamp) : (mtimeMs || 0);
  const silentMs = now - (lastMeaningfulTs || now);
  const fileSilentMs = now - (mtimeMs || now);
  const inFlight = state === 'live' || state === 'think';
  const stalled = inFlight && silentMs >= STALL_SILENCE_MS;
  const pid = readPid(name);
  const alive = pid ? pidAlive(pid) : null;
  const lastKind = lastKindOf(last, tail);
  const needs = /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(lastAssistantText || '');
  return {
    name,
    state,
    stalled,
    lastKind,
    silentMs,
    fileSilentMs,
    sizeBytes: size,
    pid,
    pidAlive: alive,
    needsInput: needs ? needs[1].trim().slice(0, 160) : null,
  };
}

function lastKindOf(meaningful, any) {
  if (meaningful?.type === 'assistant') {
    const b = (meaningful.message?.content || []).slice(-1)[0];
    if (b?.type === 'tool_use') return `tool_use:${(b.name || '?').toLowerCase()}`;
    if (b?.type === 'thinking') return 'thinking';
    if (b?.type === 'text')     return 'text';
    return 'assistant';
  }
  if (meaningful?.type === 'result') return meaningful.is_error ? 'result:error' : 'result:ok';
  if (meaningful?.type === 'user_prompt') return 'user_prompt';
  if (meaningful?.type === 'system')      return `system:${meaningful.subtype || '?'}`;
  if (any?.type === 'stream_event') {
    const dt = any.event?.delta?.type;
    return dt ? `stream_event:${dt}` : 'stream_event';
  }
  return meaningful?.type || any?.type || '—';
}

function renderTable(rows) {
  const cols = [
    ['MUSICIAN',  r => r.name.padEnd(18)],
    ['STATE',     r => (r.stalled ? 'STALLED' : r.state.toUpperCase()).padEnd(8)],
    ['LAST',      r => String(r.lastKind).padEnd(26)],
    ['SILENCE',   r => fmtAge(r.silentMs).padEnd(8)],
    ['FILE-AGE',  r => fmtAge(r.fileSilentMs).padEnd(8)],
    ['PID',       r => (r.pid ? String(r.pid) + (r.pidAlive ? ' alive' : ' dead') : '—').padEnd(12)],
    ['NOTE',      r => r.needsInput ? `needs: ${r.needsInput}` : (r.stalled ? 'STALL — consider intervention' : '')],
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
