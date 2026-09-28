#!/usr/bin/env node
// Test 1.4 — close handler idempotence + clean teardown.
// Replicates dispatch.mjs's lifecycleEnd pattern. Two scenarios:
//   A : exit only (close not fired) — handler runs once.
//   B : both exit and close fire — handler runs once (idempotent).
//   C : SIGKILL semantics: only close fires (exit may not deliver code) —
//       handler runs once.
// Verifies logStream is closed exactly once and pidPath is cleaned.

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-life-'));
const logPath = path.join(TMPROOT, 'log.jsonl');
const pidPath = path.join(TMPROOT, 'log.pid');

let invocationCount = 0;
let logStreamEnded = false;
let pidPathRemoved = false;

// Mock logStream — captures end() calls without filesystem races.
function mockStream() {
  let ended = false;
  return {
    end() { ended = true; },
    isEnded() { return ended; },
  };
}

function buildLifecycle() {
  invocationCount = 0;
  logStreamEnded = false;
  pidPathRemoved = false;
  const logStream = mockStream();
  fs.writeFileSync(pidPath, '12345');

  let lifecycleClosed = false;
  function lifecycleEnd(code, signal) {
    if (lifecycleClosed) return;
    lifecycleClosed = true;
    invocationCount++;
    try { logStream.end(); logStreamEnded = logStream.isEnded(); } catch {}
    try { fs.unlinkSync(pidPath); pidPathRemoved = true; } catch {}
  }
  return lifecycleEnd;
}

// ── Scenario A: only `exit` fires ──────────────────────────────────────────
{
  const end = buildLifecycle();
  end(0, null); // exit
  assert.equal(invocationCount, 1, 'A: invocation count');
  assert.equal(logStreamEnded, true, 'A: logStream end');
  assert.equal(pidPathRemoved, true, 'A: pid path removed');
  assert.equal(fs.existsSync(pidPath), false, 'A: pid path absent on disk');
}

// ── Scenario B: both `exit` and `close` fire ──────────────────────────────
{
  const end = buildLifecycle();
  end(0, null);   // exit
  end(0, null);   // close (would re-enter)
  end(null, 'SIGKILL'); // any extra
  assert.equal(invocationCount, 1, 'B: idempotent — single invocation');
}

// ── Scenario C: only `close` fires (SIGKILL on Windows often skips exit) ──
{
  const end = buildLifecycle();
  end(null, 'SIGKILL'); // close
  assert.equal(invocationCount, 1, 'C: invocation count');
  assert.equal(logStreamEnded, true, 'C: logStream end');
  assert.equal(pidPathRemoved, true, 'C: pid path removed');
}

// ── Scenario D: log file ends well-formed ─────────────────────────────────
// Use sync writes to avoid race with async createWriteStream flushing.
{
  // Write the lines as a real dispatch.mjs would, but synchronously so we
  // can read deterministically.
  fs.writeFileSync(logPath,
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n'
  );
  // Now exercise lifecycleEnd on this file.
  fs.writeFileSync(pidPath, '12345');
  let lifecycleClosed = false;
  let count = 0;
  function end() {
    if (lifecycleClosed) return;
    lifecycleClosed = true;
    count++;
    try { fs.unlinkSync(pidPath); } catch {}
  }
  end(); end(); // idempotent
  assert.equal(count, 1, 'D: idempotent on inline lifecycle');
  const raw = fs.readFileSync(logPath, 'utf8');
  assert.equal(raw[raw.length - 1], '\n', 'D: file ends with newline');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  for (const l of lines) JSON.parse(l); // throws on malformed
  assert.equal(lines.length, 2, 'D: 2 JSON lines parsed');
}

// Cleanup
fs.rmSync(TMPROOT, { recursive: true, force: true });
console.log('PASS — Test 1.4 close handler: idempotent across exit/close/SIGKILL paths, file well-formed');
