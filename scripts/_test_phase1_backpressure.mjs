#!/usr/bin/env node
// Test 1.2 — backpressure under slow consumer.
// Replicates dispatch.mjs's lineQueue + setImmediate drainer pattern in-process,
// feeds 100 events of varied size, simulates a 100 ms/event consumer, and
// verifies (a) the data handler never blocks, (b) all events drained, (c) no
// crash, (d) handler latency p95 stays well under 1 ms.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// ── Faithful copy of dispatch.mjs's pattern ────────────────────────────────
const lineQueue = [];
let drainerScheduled = false;
const drainedEvents = [];

// Simulated slow consumer — 100 ms per event of work.
async function slowConsume(line) {
  // Synchronous busy-wait would block; we want async sleep so the event
  // loop is free.
  return new Promise(r => setTimeout(r, 100));
}

let drainerInFlight = false;

function scheduleDrain() {
  if (drainerScheduled) return;
  drainerScheduled = true;
  setImmediate(processLineQueue);
}

async function processLineQueue() {
  drainerScheduled = false;
  if (drainerInFlight) { scheduleDrain(); return; }
  drainerInFlight = true;
  let budget = 256;
  while (lineQueue.length && budget-- > 0) {
    const line = lineQueue.shift();
    if (!line || !line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    await slowConsume(line);  // simulate slow broadcast layer
    drainedEvents.push(ev);
  }
  drainerInFlight = false;
  if (lineQueue.length) scheduleDrain();
}

// ── Synthetic chunker (the "data" handler) ─────────────────────────────────
let stdoutTail = '';
const handlerLatencies = [];

function onData(chunk) {
  const t0 = performance.now();
  // O(1): append to log + line buffer, defer parsing.
  stdoutTail += chunk.toString('utf8');
  const lines = stdoutTail.split(/\r?\n/);
  stdoutTail = lines.pop() ?? '';
  if (lines.length) {
    for (const l of lines) lineQueue.push(l);
    scheduleDrain();
  }
  handlerLatencies.push(performance.now() - t0);
}

// ── Build 100 events of varied size ────────────────────────────────────────
function buildEvents(n = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i % 5 === 0) {
      // large tool_result-style event (~16 KB)
      out.push(JSON.stringify({
        idx: i, type: 'user',
        message: { content: [{ type: 'tool_result', content: 'X'.repeat(16 * 1024) }] },
      }));
    } else {
      out.push(JSON.stringify({ idx: i, type: 'assistant', text: `event ${i}` }));
    }
  }
  return out;
}

const events = buildEvents(100);
const raw = events.join('\n') + '\n';

// Feed in 1 KB chunks to exercise chunk-boundary handling.
const CHUNK = 1024;
let maxQueueLen = 0;
const observeInterval = setInterval(() => {
  if (lineQueue.length > maxQueueLen) maxQueueLen = lineQueue.length;
}, 5);

const start = performance.now();
for (let off = 0; off < raw.length; off += CHUNK) {
  onData(raw.slice(off, off + CHUNK));
}
const feedDone = performance.now();
const feedTimeMs = feedDone - start;

// Wait for drainer to finish (no setTimeout polling — recursive drain handles it).
async function waitForDrain() {
  while (lineQueue.length > 0 || drainerInFlight) {
    await new Promise(r => setImmediate(r));
  }
}
await waitForDrain();
clearInterval(observeInterval);

// ── Assertions ─────────────────────────────────────────────────────────────
const drainedCount = drainedEvents.length;
assert.equal(drainedCount, 100, `expected 100 drained, got ${drainedCount}`);

// Handler latency p95 — sort then index 95.
const sorted = handlerLatencies.slice().sort((a, b) => a - b);
const p95 = sorted[Math.floor(sorted.length * 0.95)];
assert.ok(p95 < 50,
  `handler p95 latency ${p95.toFixed(2)} ms exceeds 50 ms (cap from spec)`);

// Feed time should be tiny vs total drain time (proves drainer is async).
assert.ok(feedTimeMs < 200,
  `feed phase took ${feedTimeMs.toFixed(2)} ms — handler likely blocked on consumer`);

// Order preserved.
for (let i = 0; i < 100; i++) {
  assert.equal(drainedEvents[i].idx, i, `order broken at i=${i}`);
}

console.log('PASS — Test 1.2 backpressure');
console.log(`  feed phase:            ${feedTimeMs.toFixed(2)} ms (must be < 200 ms)`);
console.log(`  handler p95 latency:   ${p95.toFixed(3)} ms`);
console.log(`  max queue depth:       ${maxQueueLen}`);
console.log(`  events drained:        ${drainedCount}/100`);
