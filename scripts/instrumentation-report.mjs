#!/usr/bin/env node
// ============================================================================
// scripts/instrumentation-report.mjs — Phase 1 instrumentation summariser.
// ============================================================================
//
// Reads:
//   logs/instrumentation-*.ndjson  (dispatch.mjs lifecycle records)
//   logs/traces.jsonl              (server.js trace stream — has spawn_ms)
//
// Joins on trace_id and prints a human-readable summary plus a JSON dump
// to stdout. Intended for the Phase 5 hybrid-WARM-pool decision.
//
// Usage:
//   node scripts/instrumentation-report.mjs            # all files
//   node scripts/instrumentation-report.mjs 2026-05-09 # a single date
// ============================================================================

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const LOGS      = path.join(ROOT, 'logs');

const dateFilter = process.argv[2] || null; // YYYY-MM-DD or null

function* readNdjson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip */ }
  }
}

// ── Load instrumentation-*.ndjson files ─────────────────────────────────────
let instrFiles = [];
try {
  instrFiles = fs.readdirSync(LOGS)
    .filter(f => f.startsWith('instrumentation-') && f.endsWith('.ndjson'))
    .filter(f => !dateFilter || f.includes(dateFilter))
    .map(f => path.join(LOGS, f));
} catch {}

const dispatches = [];
for (const file of instrFiles) {
  for (const rec of readNdjson(file)) dispatches.push(rec);
}

// ── Join with traces.jsonl to recover spawn_ms (server-side) ───────────────
const tracesByTrace = new Map();
for (const ev of readNdjson(path.join(LOGS, 'traces.jsonl'))) {
  if (ev.event === 'dispatch_spawned' && ev.trace) {
    tracesByTrace.set(ev.trace, ev);
  }
}
for (const d of dispatches) {
  if (d.trace_id && tracesByTrace.has(d.trace_id)) {
    const t = tracesByTrace.get(d.trace_id);
    if (typeof t.spawn_ms === 'number') d.spawn_ms = t.spawn_ms;
  }
}

// ── Per-agent histogram of time_since_last_dispatch_ms ─────────────────────
const histPerAgent = new Map();   // project → { lt5m, lt10m, lt30m, lt2h, ge2h, never }
function bucketize(ms) {
  if (ms == null) return 'never';
  if (ms < 300_000)   return 'lt5m';
  if (ms < 600_000)   return 'lt10m';
  if (ms < 1_800_000) return 'lt30m';
  if (ms < 7_200_000) return 'lt2h';
  return 'ge2h';
}
for (const d of dispatches) {
  if (!d.project) continue;
  if (!histPerAgent.has(d.project)) histPerAgent.set(d.project, { lt5m: 0, lt10m: 0, lt30m: 0, lt2h: 0, ge2h: 0, never: 0 });
  histPerAgent.get(d.project)[bucketize(d.time_since_last_dispatch_ms)]++;
}

// ── Aggregate metrics ──────────────────────────────────────────────────────
let totalSpawnMs = 0;
let countWithSpawnMs = 0;
let countLt5m = 0, countLt10m = 0, countLt30m = 0;
let countWithGap = 0;
let countInterrupted = 0;
for (const d of dispatches) {
  if (typeof d.spawn_ms === 'number') { totalSpawnMs += d.spawn_ms; countWithSpawnMs++; }
  if (d.time_since_last_dispatch_ms != null) {
    countWithGap++;
    if (d.time_since_last_dispatch_ms < 300_000)   countLt5m++;
    if (d.time_since_last_dispatch_ms < 600_000)   countLt10m++;
    if (d.time_since_last_dispatch_ms < 1_800_000) countLt30m++;
  }
  if (d.interrupt_requested) countInterrupted++;
}

const ratio = (n, d) => d === 0 ? null : Math.round((n / d) * 1000) / 1000;

const summary = {
  total_dispatches: dispatches.length,
  total_spawn_ms_cumulative: totalSpawnMs,
  spawn_ms_avg: countWithSpawnMs === 0 ? null : Math.round(totalSpawnMs / countWithSpawnMs),
  warm_hit_ratio_5min:  ratio(countLt5m,  countWithGap),
  warm_hit_ratio_10min: ratio(countLt10m, countWithGap),
  warm_hit_ratio_30min: ratio(countLt30m, countWithGap),
  interrupt_ratio: ratio(countInterrupted, dispatches.length),
  dispatches_with_gap: countWithGap,
  dispatches_with_spawn_ms: countWithSpawnMs,
};

// ── Output ─────────────────────────────────────────────────────────────────
console.log('Instrumentation report');
console.log('======================');
console.log(`Files scanned: ${instrFiles.length}${dateFilter ? ` (filter: ${dateFilter})` : ''}`);
console.log(`Total dispatches: ${summary.total_dispatches}`);
console.log('');
console.log('Cumulative cold-start cost:');
console.log(`  total spawn_ms across all dispatches: ${summary.total_spawn_ms_cumulative} ms`);
console.log(`  avg spawn_ms (n=${countWithSpawnMs}): ${summary.spawn_ms_avg ?? 'n/a'} ms`);
console.log('');
console.log('WARM-hit ratio sensitivity (upper bound on Phase 5 win):');
console.log(`  idle  5 min: ${summary.warm_hit_ratio_5min  ?? 'n/a'}`);
console.log(`  idle 10 min: ${summary.warm_hit_ratio_10min ?? 'n/a'}`);
console.log(`  idle 30 min: ${summary.warm_hit_ratio_30min ?? 'n/a'}`);
console.log(`  (n=${countWithGap} dispatches with a measurable previous-dispatch gap)`);
console.log('');
console.log(`Interrupt ratio: ${summary.interrupt_ratio ?? 'n/a'} (${countInterrupted}/${dispatches.length})`);
console.log('');
console.log('Per-agent gap histogram:');
for (const [proj, h] of [...histPerAgent.entries()].sort()) {
  const total = h.lt5m + h.lt10m + h.lt30m + h.lt2h + h.ge2h + h.never;
  console.log(`  ${proj.padEnd(20)} n=${total}  <5m=${h.lt5m}  <10m=${h.lt10m}  <30m=${h.lt30m}  <2h=${h.lt2h}  ≥2h=${h.ge2h}  never=${h.never}`);
}
console.log('');
console.log('JSON:');
console.log(JSON.stringify(summary, null, 2));
