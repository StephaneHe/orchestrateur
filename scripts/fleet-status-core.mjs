// ============================================================================
// scripts/fleet-status-core.mjs — shared fleet state/stall/silence logic.
// ============================================================================
//
// SINGLE SOURCE OF TRUTH for "what is each musician doing right now?". Both the
// CLI supervisor (scripts/fleet-status.mjs) and the server's live desk view
// (/api/pupitre in server.js) import from here, so the two never diverge.
//
// A musician is any project with a logs/<name>.jsonl stream — the conductor
// (chef) included; it is treated exactly like the others.
//
// "Stalled" = state is live/think AND no non-partial event for >= STALL_SILENCE_MS
// AND no terminal `result` written. (A dead PID while still in-flight is an
// additional, stronger stall signal, surfaced separately as pidAlive === false.)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_LOGS = path.join(ROOT, 'logs');

export const STALL_SILENCE_MS = 60_000;   // live/think without progress → suspect
const TAIL_BYTES = 256 * 1024;            // only scan the last 256 KB

/** Read the last TAIL_BYTES of a file and split into full JSON lines (dropping
 *  a partial head line that may be cut mid-object). */
export function tailLines(filePath) {
  let st; try { st = fs.statSync(filePath); } catch { return { lines: [], mtimeMs: 0, size: 0 }; }
  const size = st.size;
  const fd = fs.openSync(filePath, 'r');
  const want = Math.min(TAIL_BYTES, size);
  const buf = Buffer.alloc(want);
  try { fs.readSync(fd, buf, 0, want, size - want); } finally { fs.closeSync(fd); }
  // Filter NUL bytes that crashed writes can leave behind on Windows.
  const text = buf.toString('utf8').replace(/\u0000+/g, '');
  const raw = text.split('\n');
  if (raw.length > 1) raw.shift(); // drop the potentially-partial first slice
  return { lines: raw.filter(Boolean), mtimeMs: st.mtimeMs, size };
}

export function lastMeaningful(lines) {
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

export function lastAny(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev && typeof ev === 'object') return ev;
    } catch { /* skip */ }
  }
  return null;
}

/** Mirror of public/app.js Musician.transition for the bits we need here:
 *  is a turn running, when did it start, and what model/provider is in use? */
export function deriveState(lines) {
  let state = 'idle';
  let lastAssistantText = '';
  let turnStartTs = null;     // ts of the in-flight turn's opening event, else null
  let model = null;
  let provider = null;

  for (const ln of lines) {
    let ev; try { ev = JSON.parse(ln); } catch { continue; }
    const t = ev?.type;

    // Track model/provider as they appear (init, assistant, result all carry them).
    const evModel = ev?.model || ev?.message?.model;
    if (typeof evModel === 'string' && evModel) model = evModel;
    const evProvider = ev?.provider || ev?.message?.provider;
    if (typeof evProvider === 'string' && evProvider) provider = evProvider;

    // Sourced user_prompt (callback / @shortcut / notify) is not a turn start;
    // only a source-less prompt or a system/init is (a --source dispatch emits
    // init too, so real turns are still covered).
    if ((t === 'user_prompt' && !ev.source) || (t === 'system' && ev.subtype === 'init')) {
      if (state === 'idle' || state === 'unread' || state === 'input') {
        state = 'live';
        turnStartTs = ev.timestamp ? Date.parse(ev.timestamp) : Date.now();
      }
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
      if (isErr && ev.synthetic) state = 'idle';          // crash/restart — no question posed
      else state = isErr ? 'error' : (needs ? 'input' : 'unread');
      turnStartTs = null;                                  // turn is over
    }
  }
  return { state, lastAssistantText, turnStartTs, model, provider };
}

export function readPid(project, logsDir = DEFAULT_LOGS) {
  try {
    const v = fs.readFileSync(path.join(logsDir, `${project}.pid`), 'utf8').trim();
    const pid = Number(v);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function fmtAge(ms) {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}`;
}

/** Compact label of the most recent real activity, e.g. tool_use:bash,
 *  thinking, result:ok, stream_event:thinking_delta. */
export function lastKindOf(meaningful, any) {
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

/** Short human preview of what the musician is doing NOW (for the desk view). */
function activityPreview(meaningful, lastAssistantText) {
  if (meaningful?.type === 'assistant') {
    const blocks = meaningful.message?.content || [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b?.type === 'tool_use') {
        const arg = b.input ? Object.values(b.input).find(v => typeof v === 'string') : '';
        return `${(b.name || 'tool').toLowerCase()}${arg ? ' · ' + String(arg).replace(/\s+/g, ' ').slice(0, 80) : ''}`;
      }
      if (b?.type === 'text' && b.text)     return b.text.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (b?.type === 'thinking')           return '(réflexion…)';
    }
  }
  if (meaningful?.type === 'result') {
    return meaningful.is_error ? (meaningful.subtype || 'échec du tour')
                               : (typeof meaningful.result === 'string' ? meaningful.result.replace(/\s+/g, ' ').trim().slice(0, 120) : 'terminé');
  }
  if (lastAssistantText) return lastAssistantText.replace(/\s+/g, ' ').trim().slice(0, 120);
  return '';
}

/**
 * Full snapshot for one project. Used by the CLI table and the live desk view.
 * Includes state, current activity, turn-elapsed, silence, PID liveness,
 * stall, and model/provider.
 */
export function scanProject(name, logsDir = DEFAULT_LOGS) {
  const logPath = path.join(logsDir, `${name}.jsonl`);
  const { lines, mtimeMs, size } = tailLines(logPath);
  const last = lastMeaningful(lines);
  const tail = lastAny(lines);
  const { state, lastAssistantText, turnStartTs, model, provider } = deriveState(lines);
  const now = Date.now();
  const lastMeaningfulTs = last?.timestamp ? Date.parse(last.timestamp) : (mtimeMs || 0);
  const silentMs = now - (lastMeaningfulTs || now);
  const fileSilentMs = now - (mtimeMs || now);
  const inFlight = state === 'live' || state === 'think';
  const stalled = inFlight && silentMs >= STALL_SILENCE_MS;
  const pid = readPid(name, logsDir);
  const alive = pid ? pidAlive(pid) : null;
  const lastKind = lastKindOf(last, tail);
  const needs = /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(lastAssistantText || '');
  const turnElapsedMs = inFlight && turnStartTs ? (now - turnStartTs) : null;

  return {
    name,
    state,
    stalled,
    // Dead process while the log still says a turn is running — a stronger,
    // separate stall signal (the child was SIGKILLed or crashed silently).
    deadInFlight: inFlight && pid != null && alive === false,
    lastKind,
    activity: activityPreview(last, lastAssistantText),
    silentMs,
    fileSilentMs,
    turnElapsedMs,
    sizeBytes: size,
    pid,
    pidAlive: alive,
    model: model || null,
    provider: provider || null,
    needsInput: needs ? needs[1].trim().slice(0, 160) : null,
  };
}
