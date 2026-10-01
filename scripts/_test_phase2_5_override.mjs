#!/usr/bin/env node
// Test 2.7 + 2.7.bis — !interrupt explicit override.
// Verifies override correctness, classifier short-circuit, and negative cases.

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, detectOverride, getClassifierInvocations, resetClassifierInvocations } from '../src/message_router.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');

const stamp = new Date().toISOString().slice(0, 10);
const dailyFile = path.join(LOGS, `router-${stamp}.ndjson`);

const dummyClassifier = async () => ({ verdict: 'still_useful', lean: 'queue' });

let prevLines = 0;
try { prevLines = fs.readFileSync(dailyFile, 'utf8').split(/\r?\n/).filter(l => l.trim()).length; } catch {}

const results = [];
function record(id, status, detail) {
  results.push({ id, status, detail });
  console.log(`  [${status}] ${id}  ${detail}`);
}

// ── Test 2.7 — 10 with-prefix cases ───────────────────────────────────────
console.log('\nTest 2.7 — !interrupt override correctness (10 with-prefix)');

const withPrefix = [
  '!interrupt switch to OAuth instead',
  '!interrupt',
  '!INTERRUPT cancel current work',
  '  !interrupt with leading whitespace',
  '! interrupt with space after !',
  '!interrupt urgent fix needed',
  '!Interrupt',
  '!interrupt; reason: data corruption',
  '!interrupt\nmulti-line content',
  '!interrupt with numbers 123 and symbols #!$',
];

resetClassifierInvocations();
let okWith = 0;
const overrideRecords = [];
for (const p of withPrefix) {
  const r = await route({
    agentId: 'agentZ',
    newPrompt: p,
    inFlightTurnSummary: 'doing work',
    inFlightTurnAgeMs: 1000,
    queueDepthAfter: 0,
    classifier: dummyClassifier,
  });
  if (r.action === 'interrupt' && r.record.reason === 'explicit_override') okWith++;
  overrideRecords.push(r.record);
}
const classifierCallsAfterOverride = getClassifierInvocations();

record('2.7 override decision (10/10)',
  okWith === 10 ? 'PASS' : 'FAIL',
  `${okWith}/10 returned decision=interrupt reason=explicit_override`);
record('2.7 classifier short-circuit',
  classifierCallsAfterOverride === 0 ? 'PASS' : 'FAIL',
  `classifier called ${classifierCallsAfterOverride} times (must be 0)`);

// ── Test 2.7 — 10 without-prefix cases ────────────────────────────────────
console.log('\nTest 2.7 — without-prefix cases (10)');

const withoutPrefix = [
  // 4 stop-word phrasings
  'stop please',
  'cancel that approach',
  'arrête tout',
  'oublie ça pour l instant',
  // 3 additive
  'also do X',
  'and please add tests',
  'next step: deploy to staging',
  // 3 ambiguous
  'I think we need a different approach',
  'maybe revisit this later',
  'possibly need attention',
];

let noFalseOverride = 0;
for (const p of withoutPrefix) {
  const r = await route({
    agentId: 'agentZ',
    newPrompt: p,
    inFlightTurnSummary: 'doing work',
    inFlightTurnAgeMs: 1000,
    queueDepthAfter: 0,
    classifier: dummyClassifier,
  });
  if (r.record.reason !== 'explicit_override') noFalseOverride++;
}
record('2.7 no false override on without-prefix',
  noFalseOverride === 10 ? 'PASS' : 'FAIL',
  `${noFalseOverride}/10 routed without explicit_override`);

// ── Test 2.7 — telemetry shape on override path ──────────────────────────
console.log('\nTest 2.7 — telemetry on override path');
const after = fs.readFileSync(dailyFile, 'utf8').split(/\r?\n/).filter(l => l.trim());
const newLines = after.slice(prevLines);
let overrideLinesOk = 0;
for (const line of newLines) {
  try {
    const rec = JSON.parse(line);
    if (rec.reason === 'explicit_override') overrideLinesOk++;
  } catch {}
}
record('2.7 override telemetry lines',
  overrideLinesOk === 10 ? 'PASS' : 'FAIL',
  `${overrideLinesOk}/10 override telemetry lines on disk`);

// ── Test 2.7.bis — 3 negative cases (!interrupt not at position 0) ────────
console.log('\nTest 2.7.bis — negative cases (!interrupt mid-prompt)');

const negative = [
  'please !interrupt this if you can',
  'the !interrupt token is documented in section 4',
  'regarding !interrupt: when should I use it?',
];

let negativeOk = 0;
for (const p of negative) {
  const det = detectOverride(p);
  if (!det.override) negativeOk++;
}
record('2.7.bis no false override on mid-prompt',
  negativeOk === 3 ? 'PASS' : 'FAIL',
  `${negativeOk}/3 detected as NOT override`);

// ── Test 2.7 — API flag override ──────────────────────────────────────────
console.log('\nTest 2.7 — API flag override');
resetClassifierInvocations();
const r = await route({
  agentId: 'agentZ',
  newPrompt: 'normal looking prompt without prefix',
  inFlightTurnSummary: 'doing work',
  inFlightTurnAgeMs: 1000,
  queueDepthAfter: 0,
  classifier: dummyClassifier,
  forceInterrupt: true,
});
const flagOk = r.action === 'interrupt'
            && r.record.reason === 'explicit_override'
            && r.record.override_source === 'api_flag'
            && getClassifierInvocations() === 0;
record('2.7 API flag override',
  flagOk ? 'PASS' : 'FAIL',
  `decision=${r.action} reason=${r.record.reason} src=${r.record.override_source} cls=${getClassifierInvocations()}`);

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n=========== Phase 2.5 results ===========');
let allPass = true;
for (const r of results) {
  console.log(`  ${r.status === 'PASS' ? '✓' : '✗'} ${r.id} — ${r.detail}`);
  if (r.status !== 'PASS') allPass = false;
}
process.exit(allPass ? 0 : 1);
