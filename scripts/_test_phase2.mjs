#!/usr/bin/env node
// ============================================================================
// scripts/_test_phase2.mjs — runs Tests 2.1.a/.b/.c, 2.2, 2.3, 2.5, 2.6.
// ============================================================================

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide } from '../src/interrupt_policy.mjs';
import { route, validateRouterRecord }        from '../src/message_router.mjs';
import { classify }                           from '../src/classifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const FIXTURE   = path.join(ROOT, 'tests', 'fixtures', 'interrupt_policy.json');
const LOGS      = path.join(ROOT, 'logs');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const results = [];
function record(testId, status, detail = '') {
  results.push({ testId, status, detail });
  const tag = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status;
  console.log(`  [${tag}] ${testId}  ${detail}`);
}

// ── Test 2.1.a/b/c — classifier + InterruptPolicy on labeled fixture ──────
console.log('\nTest 2.1 — InterruptPolicy on labeled fixture');

const verdicts = []; // { id, label, decision, reason, recommendation, lean }

for (const pair of fixture) {
  process.stdout.write(`  classifying #${pair.id}… `);
  const t0 = Date.now();
  const v = await decide({
    turnSummary: pair.current_turn_summary,
    newPrompt:   pair.new_prompt,
    classifier:  classify,
  });
  const ms = Date.now() - t0;
  console.log(`${v.decision} (${v.reason}) [${ms} ms]`);
  verdicts.push({ id: pair.id, label: pair.label, expected_rec: pair.recommendation, ...v });
}

// 2.1.a — binary on pairs 1-13: precision/recall on should-interrupt
const binPairs = verdicts.filter(v => v.id <= 13);
let tp = 0, fp = 0, fn = 0, tn = 0;
for (const v of binPairs) {
  const predicted = v.decision === 'interrupt' ? 'interrupt' : 'queue';
  const truth     = v.label;
  if (predicted === 'interrupt' && truth === 'interrupt') tp++;
  if (predicted === 'interrupt' && truth === 'queue')     fp++;
  if (predicted === 'queue'     && truth === 'interrupt') fn++;
  if (predicted === 'queue'     && truth === 'queue')     tn++;
}
const recall    = (tp + fn) === 0 ? 1 : tp / (tp + fn);
const precision = (tp + fp) === 0 ? 1 : tp / (tp + fp);
console.log(`    confusion: tp=${tp} fp=${fp} fn=${fn} tn=${tn}`);
console.log(`    recall=${recall.toFixed(3)}  precision=${precision.toFixed(3)}`);
const passA = recall >= 0.9 && precision >= 0.7;
record('2.1.a binary classification', passA ? 'PASS' : 'FAIL',
  `recall=${recall.toFixed(3)} (≥0.9) precision=${precision.toFixed(3)} (≥0.7)`);

// 2.1.b — CONSULT detection on pairs 14-15
const consultPairs = verdicts.filter(v => v.id === 14 || v.id === 15);
const consultDetected = consultPairs.filter(v => v.decision === 'consult').length;
record('2.1.b CONSULT detection', consultDetected === 2 ? 'PASS' : 'FAIL',
  `${consultDetected}/2 detected as CONSULT`);

// 2.1.c — recommendation alignment on pairs 14-15
let alignOk = 0;
for (const v of consultPairs) {
  if (v.decision === 'consult' && v.recommendation === v.expected_rec) alignOk++;
}
record('2.1.c CONSULT recommendation alignment',
  alignOk === 2 ? 'PASS' : 'FAIL',
  `${alignOk}/2 recommendations match expected`);

// ── Test 2.2 — Stop-word coverage ─────────────────────────────────────────
console.log('\nTest 2.2 — Stop-word coverage');
const stopProbes = [
  'Stop, that approach is wrong',
  'STOP! data corruption',
  'Cancel that, dashboard is deprecated',
  'Wait, I see a problem',
  'Annule, j\'ai déjà fixé ça',
  'Arrête tout, on change d\'approche',
  'Oublie ça, on utilise MSW',
  'Laisse tomber, ça n\'est plus utile',
];
let stopMatched = 0;
const stubClassifier = async () => ({ verdict: 'still_useful', lean: 'queue' });
for (const p of stopProbes) {
  const v = await decide({
    turnSummary: 'doing some work',
    newPrompt: p,
    classifier: stubClassifier,
  });
  if (v.decision === 'interrupt' && v.reason === 'stop_word') stopMatched++;
}
record('2.2 stop-word coverage',
  stopMatched === stopProbes.length ? 'PASS' : 'FAIL',
  `${stopMatched}/${stopProbes.length}`);

// ── Test 2.3 — Default-queue bias on ambiguous (non-CONSULT) prompts ─────
console.log('\nTest 2.3 — Default-queue bias');
const ambiguousPrompts = [
  'Hmm okay',
  'Maybe consider that approach',
  'We might want a different setup eventually',
  'Could possibly need attention',
  'Just thinking out loud here',
];
// For these we mock classifier returning still_useful — they should QUEUE.
let queueOk = 0;
for (const p of ambiguousPrompts) {
  const v = await decide({
    turnSummary: 'continuing the refactor',
    newPrompt: p,
    classifier: async () => ({ verdict: 'still_useful', lean: 'queue' }),
  });
  if (v.decision === 'queue') queueOk++;
}
record('2.3 default-queue bias',
  queueOk === ambiguousPrompts.length ? 'PASS' : 'FAIL',
  `${queueOk}/${ambiguousPrompts.length} routed to QUEUE`);

// ── Test 2.5 — Telemetry shape: 100 sample decisions, all valid NDJSON ───
console.log('\nTest 2.5 — Telemetry shape (100 samples)');
const dailyFile = path.join(LOGS, `router-${new Date().toISOString().slice(0, 10)}.ndjson`);
// snapshot existing line count so we count only what we write here
let prevLines = 0;
try { prevLines = fs.readFileSync(dailyFile, 'utf8').split(/\r?\n/).filter(l => l.trim()).length; } catch {}

const stubSamples = ['useless_now', 'still_useful', 'uncertain'];
const seedClassifier = (verdict) => async () => ({ verdict, lean: verdict === 'useless_now' ? 'interrupt' : 'queue' });

for (let i = 0; i < 100; i++) {
  const verdictPick = stubSamples[i % stubSamples.length];
  const inFlight = i % 4 === 0 ? null : 'doing work iteration ' + i;
  await route({
    agentId: 'agentX-' + (i % 5),
    newPrompt: 'sample prompt #' + i,
    inFlightTurnSummary: inFlight,
    inFlightTurnAgeMs: inFlight ? Math.floor(Math.random() * 60000) : null,
    queueDepthAfter: i % 3,
    classifier: seedClassifier(verdictPick),
  });
}

const after = fs.readFileSync(dailyFile, 'utf8').split(/\r?\n/).filter(l => l.trim());
const newLines = after.slice(prevLines);
let validCount = 0;
const reasons = [];
for (const line of newLines) {
  let rec;
  try { rec = JSON.parse(line); } catch { reasons.push('parse'); continue; }
  const v = validateRouterRecord(rec);
  if (v.ok) validCount++;
  else reasons.push(v.why);
}
record('2.5 telemetry shape',
  validCount === 100 ? 'PASS' : 'FAIL',
  `${validCount}/100 valid NDJSON; bad: ${[...new Set(reasons)].join(', ')}`);

// ── Test 2.6 — CONSULT logging: 5 synthetic CONSULT-triggering inputs ────
console.log('\nTest 2.6 — CONSULT logging (5 inputs)');
const consultLog = path.join(LOGS, 'consult-pending.ndjson');
let prevConsult = 0;
try { prevConsult = fs.readFileSync(consultLog, 'utf8').split(/\r?\n/).filter(l => l.trim()).length; } catch {}

for (let i = 0; i < 5; i++) {
  await route({
    agentId: 'agentY-' + i,
    newPrompt: 'ambiguous input #' + i,
    inFlightTurnSummary: 'doing X',
    inFlightTurnAgeMs: 1000 + i * 100,
    queueDepthAfter: 1,
    classifier: async () => ({ verdict: 'uncertain', lean: i % 2 === 0 ? 'interrupt' : 'queue', reasoning: `case ${i}` }),
  });
}
const consultLines = fs.readFileSync(consultLog, 'utf8').split(/\r?\n/).filter(l => l.trim());
const newConsult = consultLines.slice(prevConsult);

const required = ['ts', 'agent_id', 'current_turn_summary', 'new_prompt', 'recommendation', 'fallback'];
let consultOk = 0;
for (const line of newConsult) {
  try {
    const rec = JSON.parse(line);
    if (required.every(f => f in rec) && rec.fallback === 'queue') consultOk++;
  } catch {}
}
record('2.6 CONSULT logging',
  consultOk === 5 ? 'PASS' : 'FAIL',
  `${consultOk}/5 well-formed CONSULT entries`);

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n=========== Phase 2 results ===========');
let allPass = true;
for (const r of results) {
  console.log(`  ${r.status === 'PASS' ? '✓' : '✗'} ${r.testId} — ${r.detail}`);
  if (r.status !== 'PASS') allPass = false;
}
process.exit(allPass ? 0 : 1);
