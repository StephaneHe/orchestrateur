#!/usr/bin/env node
// Test 4.B.1 + 4.B.2 — fake_claude harness shape + latency.
// Spawns fake_claude.mjs directly (no orchestrator involvement) and
// verifies (a) event sequence is well-formed, (b) per-turn latency is
// under 500 ms with default config.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(__dirname, '..', 'tests', 'fake_claude', 'fake_claude.mjs');

function runFake(promptText, env = {}, useStdin = true) {
  return new Promise((resolve) => {
    const args = [
      FAKE,
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--allowed-tools', 'Read,Edit,Write,Bash',
    ];
    if (useStdin) args.push('--input-format', 'stream-json');
    else args.push(promptText);

    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: useStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    if (useStdin) {
      child.stdin.end(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: promptText }] },
      }) + '\n');
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c.toString('utf8'); });
    child.stderr.on('data', c => { stderr += c.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseEvents(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

const results = [];
function record(id, status, detail) {
  results.push({ id, status, detail });
  console.log(`  [${status}] ${id}  ${detail}`);
}

// ── Test 4.B.1 — harness shape ────────────────────────────────────────────
console.log('\nTest 4.B.1 — harness shape');
{
  const r = await runFake('say hi', { FAKE_CLAUDE_LATENCY_MS: '20' });
  const events = parseEvents(r.stdout);
  // Required sequence: system/init, then any number of assistant/user, then result.
  const types = events.map(e => `${e.type}${e.subtype ? '/' + e.subtype : ''}`);
  const initIdx = types.indexOf('system/init');
  const resultIdx = types.indexOf('result');
  const sequenceOk = initIdx === 0 && resultIdx > 0 && resultIdx === types.length - 1;
  const hasAssistant = events.some(e => e.type === 'assistant');
  const exitOk = r.code === 0;
  const sessionPresent = events[0]?.session_id && typeof events[0].session_id === 'string';
  const ok = sequenceOk && hasAssistant && exitOk && sessionPresent;
  record('4.B.1 harness shape', ok ? 'PASS' : 'FAIL',
    `seq=${sequenceOk} assist=${hasAssistant} exit=${exitOk} session=${sessionPresent}`);
}

// ── Test 4.B.2 — latency: 10 turns under default config, each < 500 ms ───
console.log('\nTest 4.B.2 — harness latency (10 turns, default cfg)');
{
  const durations = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const r = await runFake(`turn ${i}`, {});
    const ms = performance.now() - t0;
    if (r.code !== 0) {
      record('4.B.2 latency', 'FAIL', `turn ${i} exit=${r.code}`);
      process.exit(1);
    }
    durations.push(ms);
  }
  const max = Math.max(...durations);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const ok = max < 500;
  record('4.B.2 harness latency', ok ? 'PASS' : 'FAIL',
    `max=${max.toFixed(0)} ms avg=${avg.toFixed(0)} ms (cap 500 ms)`);
}

// ── Test 4.B.bis — resume preserves session_id ────────────────────────────
console.log('\nTest 4.B.bis — --resume preserves session_id');
{
  const explicit = '12345678-aaaa-bbbb-cccc-1234567890ab';
  const r = await runFake('hi', {});
  const events1 = parseEvents(r.stdout);
  const sid1 = events1[0]?.session_id;

  // Now with --resume
  const args = [
    FAKE, '--print', '--output-format', 'stream-json',
    '--input-format', 'stream-json', '--verbose', '--resume', explicit,
  ];
  const c = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  c.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }}) + '\n');
  let so = '';
  c.stdout.on('data', x => so += x.toString());
  await new Promise(r => c.on('close', r));
  const events2 = parseEvents(so);
  const sid2 = events2[0]?.session_id;
  record('4.B.bis resume preserves session', sid2 === explicit ? 'PASS' : 'FAIL',
    `expected ${explicit}, got ${sid2}`);
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n=========== Phase 4.B (harness only) results ===========');
let allPass = true;
for (const r of results) {
  console.log(`  ${r.status === 'PASS' ? '✓' : '✗'} ${r.id} — ${r.detail}`);
  if (r.status !== 'PASS') allPass = false;
}
process.exit(allPass ? 0 : 1);
