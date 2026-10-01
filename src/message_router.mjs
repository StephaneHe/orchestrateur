// ============================================================================
// src/message_router.mjs — incoming-prompt router with telemetry.
// ============================================================================
//
// route(prompt, ctx) returns a routing action and writes one NDJSON record
// to logs/router-<isoDate>.ndjson per call. CONSULT decisions also append
// to logs/consult-pending.ndjson with the full input pair for human review.
//
// Behavioural fallback for CONSULT = QUEUE — the orchestrator never freezes
// on ambiguity.
// ============================================================================

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from './interrupt_policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const LOGS      = path.join(ROOT, 'logs');
try { fs.mkdirSync(LOGS, { recursive: true }); } catch {}

const REQUIRED_FIELDS = [
  'ts', 'decision', 'reason', 'agent_id', 'prompt_excerpt',
  'in_flight_turn_age_ms', 'queue_depth_after',
];

function ndjsonAppend(file, record) {
  try { fs.appendFileSync(file, JSON.stringify(record) + '\n'); } catch {}
}

// !interrupt explicit override.
// Grammar : prompt (after trim) starts with `!interrupt` or `! interrupt`,
// case-insensitive, followed by whitespace, end-of-string, or punctuation
// boundary. Rejected if any letter or digit follows immediately
// (e.g. !interruption, !interruptable).
const OVERRIDE_RE = /^!\s?interrupt(?=\s|$|[^\p{L}\p{N}])/iu;

export function detectOverride(prompt) {
  if (typeof prompt !== 'string') return { override: false };
  const trimmed = prompt.trimStart();
  const m = OVERRIDE_RE.exec(trimmed);
  if (!m) return { override: false };
  const stripped = trimmed.slice(m[0].length).trim();
  return { override: true, stripped };
}

let classifierInvocationCount = 0;
export function getClassifierInvocations() { return classifierInvocationCount; }
export function resetClassifierInvocations() { classifierInvocationCount = 0; }

export async function route({
  agentId,
  newPrompt,
  inFlightTurnSummary = null,
  inFlightTurnAgeMs   = null,
  queueDepthAfter     = 0,
  classifier,
  parallelAgentError  = false,
  budgetGuardFired    = false,
  forceInterrupt      = false,
  source              = 'production',
} = {}) {
  const stamp = new Date().toISOString();
  const dailyRouter  = path.join(LOGS, `router-${stamp.slice(0, 10)}.ndjson`);
  const consultLog   = path.join(LOGS, 'consult-pending.ndjson');

  // ── !interrupt explicit override — runs BEFORE everything else ──────────
  // Either the API-level flag `forceInterrupt: true` or a prompt prefix
  // matching the OVERRIDE_RE grammar bypasses stop-word checks AND the
  // classifier. Result is always { decision: 'interrupt', reason:
  // 'explicit_override' }.
  const ov = detectOverride(newPrompt);
  if (forceInterrupt || ov.override) {
    const effectivePrompt = ov.override ? ov.stripped : newPrompt;
    const record = {
      ts: stamp,
      decision: 'interrupt',
      reason: 'explicit_override',
      agent_id: agentId,
      prompt_excerpt: (effectivePrompt || '').slice(0, 80),
      in_flight_turn_age_ms: inFlightTurnAgeMs,
      queue_depth_after: queueDepthAfter,
    };
    if (ov.override)     record.override_source = 'prefix';
    else if (forceInterrupt) record.override_source = 'api_flag';
    ndjsonAppend(dailyRouter, record);
    return { action: 'interrupt', record, effectivePrompt };
  }

  // Wrap classifier so we can count invocations for Test 2.7.
  const wrappedClassifier = classifier
    ? async (...a) => { classifierInvocationCount++; return classifier(...a); }
    : classifier;

  // No turn in flight → simple routing path. We still log because the audit
  // trail is the source of truth for "did the orchestrator see this prompt".
  if (!inFlightTurnSummary) {
    const record = {
      ts: stamp,
      decision: 'route-existing',
      reason: 'no_turn_in_flight',
      agent_id: agentId,
      prompt_excerpt: (newPrompt || '').slice(0, 80),
      in_flight_turn_age_ms: null,
      queue_depth_after: queueDepthAfter,
    };
    ndjsonAppend(dailyRouter, record);
    return { action: 'route-existing', record };
  }

  // Turn is in flight → InterruptPolicy decides.
  const verdict = await decide({
    turnSummary: inFlightTurnSummary,
    newPrompt,
    classifier: wrappedClassifier,
    parallelAgentError,
    budgetGuardFired,
  });

  let action;
  if (verdict.decision === 'interrupt') action = 'interrupt';
  else if (verdict.decision === 'consult') action = 'queue'; // fallback
  else action = 'queue';

  const record = {
    ts: stamp,
    decision: verdict.decision,
    reason: verdict.reason,
    agent_id: agentId,
    prompt_excerpt: (newPrompt || '').slice(0, 80),
    in_flight_turn_age_ms: inFlightTurnAgeMs,
    queue_depth_after: queueDepthAfter,
  };
  if (verdict.match)          record.match = verdict.match;
  if (verdict.recommendation) record.recommendation = verdict.recommendation;
  ndjsonAppend(dailyRouter, record);

  if (verdict.decision === 'consult') {
    ndjsonAppend(consultLog, {
      ts: stamp,
      source,
      agent_id: agentId,
      current_turn_summary: inFlightTurnSummary,
      new_prompt: newPrompt,
      recommendation: verdict.recommendation,
      reasoning: verdict.reasoning || null,
      fallback: 'queue',
    });
  }

  return { action, record, verdict };
}

// Schema validator for Test 2.5.
export function validateRouterRecord(rec) {
  if (!rec || typeof rec !== 'object') return { ok: false, why: 'not_object' };
  for (const f of REQUIRED_FIELDS) {
    if (!(f in rec)) return { ok: false, why: `missing_${f}` };
  }
  if (typeof rec.ts !== 'string' || isNaN(Date.parse(rec.ts))) {
    return { ok: false, why: 'bad_ts' };
  }
  const okDecisions = ['interrupt', 'queue', 'consult', 'route-existing', 'spawn-new', 'self-handle'];
  if (!okDecisions.includes(rec.decision)) {
    return { ok: false, why: `bad_decision:${rec.decision}` };
  }
  if (typeof rec.reason !== 'string' || !rec.reason) {
    return { ok: false, why: 'bad_reason' };
  }
  if (rec.in_flight_turn_age_ms !== null && typeof rec.in_flight_turn_age_ms !== 'number') {
    return { ok: false, why: 'bad_age' };
  }
  if (typeof rec.queue_depth_after !== 'number') {
    return { ok: false, why: 'bad_qd' };
  }
  return { ok: true };
}
