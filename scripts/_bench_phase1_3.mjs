#!/usr/bin/env node
// Test 1.3 — microbenchmark sync vs async on the three converted hot-path
// sites. Reproduces the pre-patch sync versions from conversation memory
// (orchestrateur is not a git repo) and benches each pair.
//
// Sites:
//   A : dispatchPidAlive   — fs.statSync + fs.readFileSync (small text file)
//   B : captureInterruptState — readFileTail of 256 KB log
//   C : poll loop callback — fs.readFileSync of a small sidecar file
//
// PASS per spec: at least one site ratio ≥ 2× OR weighted composite ≥ 50%
// reduction. Event-loop unblocking gain is unmeasurable in a tight loop and
// is documented separately.

import fs   from 'node:fs';
import fsp  from 'node:fs/promises';
import os   from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const ITER = 1000;
const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bench-'));

// ── Fixture data ───────────────────────────────────────────────────────────
const pidPath = path.join(TMPROOT, 'foo.pid');
fs.writeFileSync(pidPath, '12345');

const logPath = path.join(TMPROOT, 'foo.jsonl');
const fixture = (() => {
  let s = '';
  while (s.length < 256 * 1024) s += JSON.stringify({ type: 'assistant', text: 'x'.repeat(80) }) + '\n';
  return s;
})();
fs.writeFileSync(logPath, fixture);

const sidePath = path.join(TMPROOT, 'foo.session');
fs.writeFileSync(sidePath, 'session-uuid-1234567890');

// ── Site A — dispatchPidAlive ──────────────────────────────────────────────
function siteA_sync() {
  const st = fs.statSync(pidPath);
  const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  return { pid, mtimeMs: st.mtimeMs };
}
async function siteA_async() {
  const st = await fsp.stat(pidPath);
  const raw = await fsp.readFile(pidPath, 'utf8');
  return { pid: Number(raw.trim()), mtimeMs: st.mtimeMs };
}

// ── Site B — captureInterruptState (readFileTail 256 KB) ──────────────────
function readFileTailSync(p, max = 256 * 1024) {
  const fd = fs.openSync(p, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const want = Math.min(max, size);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
async function readFileTailAsync(p, max = 256 * 1024) {
  const fh = await fsp.open(p, 'r');
  try {
    const stat = await fh.stat();
    const size = stat.size;
    const want = Math.min(max, size);
    const buf = Buffer.alloc(want);
    await fh.read(buf, 0, want, size - want);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

// ── Site C — poll loop callback ───────────────────────────────────────────
function siteC_sync() {
  const raw = fs.readFileSync(sidePath, 'utf8');
  return raw.trim();
}
async function siteC_async() {
  const raw = await fsp.readFile(sidePath, 'utf8');
  return raw.trim();
}

// ── Bench harness ──────────────────────────────────────────────────────────
function p(arr, q) {
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * q)];
}

function benchSync(fn, label) {
  const samples = [];
  // Warm-up
  for (let i = 0; i < 50; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < ITER; i++) {
    const s = performance.now();
    fn();
    samples.push(performance.now() - s);
  }
  const total = performance.now() - t0;
  return { label, total, p50: p(samples, 0.5), p95: p(samples, 0.95) };
}

async function benchAsync(fn, label) {
  const samples = [];
  for (let i = 0; i < 50; i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < ITER; i++) {
    const s = performance.now();
    await fn();
    samples.push(performance.now() - s);
  }
  const total = performance.now() - t0;
  return { label, total, p50: p(samples, 0.5), p95: p(samples, 0.95) };
}

const a_sync  = benchSync(siteA_sync,  'A sync ');
const a_async = await benchAsync(siteA_async, 'A async');
const b_sync  = benchSync(() => readFileTailSync(logPath),  'B sync ');
const b_async = await benchAsync(() => readFileTailAsync(logPath), 'B async');
const c_sync  = benchSync(siteC_sync,  'C sync ');
const c_async = await benchAsync(siteC_async, 'C async');

function row(s, a) {
  const ratio = s.total / a.total;
  const reduction = 1 - (a.total / s.total);
  return { sync: s, async: a, ratio_sync_over_async: ratio, async_reduction: reduction };
}
const rA = row(a_sync, a_async);
const rB = row(b_sync, b_async);
const rC = row(c_sync, c_async);

// Frequency-weighted composite — POST handler hits A once + B once per
// dispatch with interrupt; C fires every 250 ms while attaching.
// Rough weights: A=1, B=1, C=80 (long attach poll burst).
const weight = { A: 1, B: 1, C: 80 };
const weightedSync  = a_sync.total * weight.A  + b_sync.total * weight.B  + c_sync.total * weight.C;
const weightedAsync = a_async.total * weight.A + b_async.total * weight.B + c_async.total * weight.C;
const weightedRatio = weightedSync / weightedAsync;
const weightedReduction = 1 - (weightedAsync / weightedSync);

console.log('Test 1.3 — microbenchmark (n=1000)');
console.log('==================================');
for (const [name, r] of [['A dispatchPidAlive', rA], ['B captureInterruptState', rB], ['C poll-loop sidecar read', rC]]) {
  console.log(`\n  ${name}`);
  console.log(`    sync  total=${r.sync.total.toFixed(2)}ms  p50=${r.sync.p50.toFixed(3)}ms  p95=${r.sync.p95.toFixed(3)}ms`);
  console.log(`    async total=${r.async.total.toFixed(2)}ms  p50=${r.async.p50.toFixed(3)}ms  p95=${r.async.p95.toFixed(3)}ms`);
  console.log(`    ratio sync/async = ${r.ratio_sync_over_async.toFixed(2)}×   async reduction = ${(r.async_reduction * 100).toFixed(1)}%`);
}

console.log('\nWeighted composite (A=1, B=1, C=80):');
console.log(`  sync  total = ${weightedSync.toFixed(2)} ms`);
console.log(`  async total = ${weightedAsync.toFixed(2)} ms`);
console.log(`  ratio = ${weightedRatio.toFixed(2)}×   reduction = ${(weightedReduction * 100).toFixed(1)}%`);

const anySiteRatio2x = [rA, rB, rC].some(r => r.ratio_sync_over_async >= 2);
const compositeReduction50 = weightedReduction >= 0.5;
const passByCriterion = anySiteRatio2x || compositeReduction50;

console.log('\n--- VERDICT ---');
console.log(`any site ratio ≥ 2×       : ${anySiteRatio2x}`);
console.log(`weighted reduction ≥ 50%  : ${compositeReduction50}`);
console.log(`PASS criterion (literal)  : ${passByCriterion ? 'PASS' : 'FAIL'}`);
console.log('\nNote: in a tight microbenchmark loop, sync I/O on small files');
console.log('typically beats async because of libuv scheduling overhead. The');
console.log('REAL Phase 1.3 win is event-loop unblocking — when one of these');
console.log('I/Os runs concurrently with other request handling, async lets');
console.log('the event loop process other requests during the syscall, which');
console.log('a microbenchmark cannot measure.');

fs.rmSync(TMPROOT, { recursive: true, force: true });

process.exit(passByCriterion ? 0 : 2);
