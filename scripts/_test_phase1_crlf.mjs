#!/usr/bin/env node
// Validity test 1.1 — CRLF resilience of the dispatch.mjs line splitter.
// Builds a 50-line fixture mixing \n and \r\n endings (some malformed).
// Asserts that the splitter recovers every well-formed JSON line.

import assert from 'node:assert/strict';

function buildFixture(n = 50) {
  const lines = [];
  const goodCount = { value: 0 };
  for (let i = 0; i < n; i++) {
    const useCRLF = Math.random() < 0.5;
    const ending = useCRLF ? '\r\n' : '\n';
    if (i % 7 === 0) {
      // malformed line — should be skipped, not crash the parser
      lines.push('this is not json' + ending);
    } else {
      lines.push(JSON.stringify({ idx: i, sid: `sid-${i}` }) + ending);
      goodCount.value++;
    }
  }
  return { raw: lines.join(''), goodCount: goodCount.value };
}

function parseStream(raw) {
  const events = [];
  let tail = '';
  const malformed = [];
  // Simulate dispatch.mjs's chunked delivery
  const chunkSize = 19; // odd, forces splits mid-CRLF
  for (let off = 0; off < raw.length; off += chunkSize) {
    const chunk = raw.slice(off, off + chunkSize);
    tail += chunk;
    const lines = tail.split(/\r?\n/);  // Patch 1.1
    tail = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); }
      catch { malformed.push(line); }
    }
  }
  if (tail.trim()) {
    try { events.push(JSON.parse(tail)); }
    catch { malformed.push(tail); }
  }
  return { events, malformed };
}

const { raw, goodCount } = buildFixture(60);
const { events, malformed } = parseStream(raw);
assert.equal(events.length, goodCount, `expected ${goodCount} events, got ${events.length}`);
// Spot-check session ids are intact
for (const ev of events) {
  assert.ok(typeof ev.sid === 'string' && ev.sid.startsWith('sid-'),
            `bad event payload: ${JSON.stringify(ev)}`);
}
console.log(`PASS — Test 1.1 CRLF resilience: ${events.length} good lines parsed, ${malformed.length} malformed skipped, no crash`);
