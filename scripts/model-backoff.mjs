#!/usr/bin/env node
// ============================================================================
// scripts/model-backoff.mjs — progressive back-off on model launch failures (0.60.0)
// ============================================================================
//
// User request (2026-10-09): "il faut une reaction aux Erreurs 1 (quand le
// model est temporairement indisponible). Apres deux erreurs, il faut un
// timeout avant de recommencer deux fois. Puis apres deux nouvelles erreurs, un
// nouveau timeout un peu plus long, et ainsi de suite. On augmente le timeout
// de 10s a chaque fois. Et on donne a l'utilisateur le choix : lancer un test
// sur le model, changer de model, forcer un nouvel essai".
//
// - LAUNCH FAILURE: the step turn exits non-zero having produced nothing — no
//   system/init (the model never served), no result, no "model unavailable"
//   refusal. A criteria refusal, a failed turn that did run, a session limit
//   (error_model_unavailable) are handled elsewhere and are NOT this.
// - Every 2 consecutive launch failures: wait tier × 10 s (10, 20, 30 s…), then
//   2 more tries with the SAME model (re-read from the Models page each try: a
//   model only changes if the user changes the case). After `maxTiers` tiers
//   (6 by default, last wait 60 s) the run pauses with the same choices.
// - During a wait the user (dashboard buttons, or this CLI for the chef) can:
//   test the model (scripts/model-test.mjs, with a log), force a retry now,
//   or change the model in the Models page (then force a retry).
//
// CLI (the chef, or anyone, without a server restart):
//   node scripts/model-backoff.mjs <run> status
//   node scripts/model-backoff.mjs <run> retry      # force a new try now
//   node scripts/model-backoff.mjs <run> test       # test the model (log)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKOFF = Object.freeze({ perTier: 2, stepMs: 10_000, maxTiers: 6 });
export const CONTROL_FILE = 'backoff-control.json';
export const CONTROL_ACTIONS = Object.freeze(['retry', 'test']);
const RUN_RE = /^p-\d{8}T\d{6}-[0-9a-f]{6}$/;

export function backoffConfig(env = process.env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { perTier: BACKOFF.perTier, stepMs: n(env.ORCH_BACKOFF_STEP_MS, BACKOFF.stepMs), maxTiers: n(env.ORCH_BACKOFF_MAX_TIERS, BACKOFF.maxTiers) };
}

// Transient model / API trouble (worth waiting for) vs a model that cannot run
// at all (worth telling at once: unknown id, retired model).
const TRANSIENT_RE = /sans result|\b(429|5\d\d)\b|overload|unavailable|indisponible|timed? ?out|délai dépassé|ECONN\w*|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network/i;
const PERMANENT_RE = /not[ _-]?found|invalid[ _-]?model|unknown[ _-]?model|unrecognized|does not exist|n['’]existe pas|no such model|model_not_found/i;

/**
 * A step turn that never got the model to work. Three shapes:
 *  1. nothing at all: no system/init, no result, exit ≠ 0 (the turn died at
 *     start — the 2026-10-09 19:31 case);
 *  2. dispatch.mjs closed the turn as "model unavailable" because the CLI died
 *     WITHOUT serving (no init), not a session limit, not a substitution;
 *  3. an error result carrying a transient API error (5xx, 529, overloaded,
 *     timeout, network) before any work (at most one turn).
 * A model that started then failed, a session limit (limited_until), a model
 * substitution, an unknown / retired model, a criteria refusal: NOT this.
 */
export function isLaunchFailure({ code, log }) {
  if (code === 0) return false;
  const ref = log?.refused;
  const why = String(ref?.reason || log?.result?.result || '');
  if (PERMANENT_RE.test(why)) return false;
  if (ref) return !log?.served && !ref.limited_until && !ref.model_served && TRANSIENT_RE.test(why);
  if (!log?.result) return !log?.served;
  const res = log.result;
  return !!res.is_error && !res.model_unavailable && (Number(res.num_turns) || 0) <= 1 && TRANSIENT_RE.test(String(res.result || res.subtype || ''));
}

// Infrastructure failures (Routage v3 phase 0 a, 2026-10-19): not the work's
// fault, never a step criterion. Patterns taken from production step logs.
const AUTH_RE = /Failed to authenticate|OAuth (?:session|token)[^\n]{0,60}(?:expired|invalid|revoked|could not be refreshed)|authentication_error|invalid (?:x-)?api[ -]?key|please run \/login|not logged in/i;
const LIMIT_RE = /you'?ve hit your (?:session|usage) limit|(?:session|usage) limit reached|\d+-hour limit reached|claude (?:ai )?usage limit reached|limite de session/i;
const REFUSAL_RE = /can['’]t help with (?:this|that)[^\n]{0,80}start a new session/i;

/**
 * The step turn failed because of the infrastructure, or null:
 *   auth    — Claude's OAuth session expired (« Failed to authenticate: OAuth
 *             session expired and could not be refreshed »);
 *   limit   — session / usage limit (dispatch.mjs' fallback_refused with
 *             limited_until, or the CLI's own wording, codex included);
 *   refusal — the provider refused the request (« API Error: … can't help
 *             with this. Start a new session to continue. », stop_reason
 *             refusal).
 * Only a failed turn (error result, non-zero exit, refusal record) qualifies:
 * a model that merely quotes these words in a good answer never does.
 */
export function infraFailure({ code, log, stderr = '' }) {
  const res = log?.result || null, ref = log?.refused || null;
  if (!(ref || !res || res.is_error || code !== 0)) return null;
  const text = [res?.result, res?.subtype, ref?.reason, ref?.evidence, stderr].filter(Boolean).join('\n');
  const pick = (re) => { const m = re.exec(text); if (!m) return null; const line = text.slice(text.lastIndexOf('\n', m.index) + 1).split('\n')[0]; return line.trim().slice(0, 300); };
  let d;
  if ((d = pick(AUTH_RE))) return { cause: 'auth', detail: d };
  const until = ref?.limited_until || res?.limited_until || null;
  if (until) return { cause: 'limit', until, detail: String(ref?.evidence || ref?.reason || res?.result || '').slice(0, 300) };
  if ((d = pick(LIMIT_RE))) return { cause: 'limit', until: null, detail: d };
  if (res?.stop_reason === 'refusal' || (d = pick(REFUSAL_RE))) return { cause: 'refusal', detail: d || String(res?.result || '').split('\n')[0].slice(0, 300) };
  return null;
}

/**
 * The orchestrator itself refused to start the step (0.61.1): dispatch.mjs
 * exited through die() — non-zero code, a "[dispatch] <reason>" line on stderr,
 * and NOTHING written to the step log (it stops while reading its arguments,
 * before any call to the model). Not a model problem: no back-off, no "test the
 * model". Returns the reason, or null.
 * User report (2026-10-10): « Tu dis que le model n'a rien produit, mais tu
 * n'expliques pas pourquoi il faut etre plus clair sur les causes ».
 */
export function dispatchRefusal({ code, log, stderr }) {
  if (code === 0 || (log?.events || 0) > 0) return null;
  const reasons = [...String(stderr || '').matchAll(/^\[dispatch\]\s*(.+?)\s*$/gm)].map(m => m[1]);
  return reasons.length ? reasons[reasons.length - 1].slice(0, 400) : null;
}

/** Tier reached after `failures` consecutive launch failures (0 = keep trying). */
export function tierAfter(failures, cfg = BACKOFF) {
  return failures > 0 && failures % cfg.perTier === 0 ? failures / cfg.perTier : 0;
}
export const delayFor = (tier, cfg = BACKOFF) => tier * cfg.stepMs;

export function runDirOf(logsDir, run) { return path.join(logsDir, 'runs', run); }

/** Asks the waiting engine to act. Returns {ok, why?}. */
export function requestControl(logsDir, run, action, by = 'utilisateur') {
  if (!RUN_RE.test(String(run || ''))) return { ok: false, why: `exécution invalide : ${run}` };
  if (!CONTROL_ACTIONS.includes(action)) return { ok: false, why: `action inconnue : ${action} (retry ou test)` };
  const dir = runDirOf(logsDir, run);
  if (!fs.existsSync(path.join(dir, 'run.json'))) return { ok: false, why: `exécution ${run} introuvable` };
  const f = path.join(dir, CONTROL_FILE);
  // Unique temp name: two writers (dashboard + CLI) never share a half-written file.
  const tmp = `${f}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ action, by: String(by).slice(0, 40), at: new Date().toISOString() }));
  fs.renameSync(tmp, f);
  return { ok: true };
}

/**
 * Reads and consumes a pending control request (null if none). The file is
 * first claimed by an atomic rename, so a request written between the read and
 * the delete can never be erased unseen. With `since` (ms), a request made
 * before that instant is stale: consumed and ignored.
 */
export function takeControl(runDir, since = null) {
  const f = path.join(runDir, CONTROL_FILE);
  const claimed = `${f}.${process.pid}-${Math.random().toString(36).slice(2)}.taken`;
  try { fs.renameSync(f, claimed); } catch { return null; }
  let c = null;
  try { c = JSON.parse(fs.readFileSync(claimed, 'utf8')); } catch {}
  try { fs.unlinkSync(claimed); } catch {}
  if (!c || !CONTROL_ACTIONS.includes(c.action)) return null;
  if (since != null && !(Date.parse(c.at) >= since)) return null;
  return c;
}

/**
 * Waits `ms`, polling the control file. "test" runs `onTest` (awaited) and the
 * wait goes on; "retry" ends the wait at once. Returns {reason, waitedMs}.
 * `since` = when the wait was ANNOUNCED (event + chef notice), which precedes
 * this call: a request made after the announcement counts even if it lands
 * before the wait starts; only an older one is stale (0.72.1).
 */
export async function waitBackoff({ ms, runDir, onTest = async () => {}, pollMs = 250, since = Date.now() }) {
  const t0 = Date.now();
  for (;;) {
    const c = takeControl(runDir, since);
    if (c?.action === 'retry') return { reason: 'retry', by: c.by, waitedMs: Date.now() - t0 };
    if (c?.action === 'test') { try { await onTest(c); } catch { /* reported by onTest */ } }
    const left = ms - (Date.now() - t0);
    if (left <= 0) return { reason: 'elapsed', waitedMs: Date.now() - t0 };
    await new Promise(r => setTimeout(r, Math.min(pollMs, left)));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const logsDir = path.join(root, 'logs');
  const [run, action] = process.argv.slice(2);
  if (!run || !action) { console.error('usage : model-backoff.mjs <run> status|retry|test'); process.exit(64); }
  if (action === 'status') {
    let st = null; try { st = JSON.parse(fs.readFileSync(path.join(runDirOf(logsDir, run), 'run.json'), 'utf8')); } catch {}
    if (!st) { console.error(`exécution ${run} introuvable`); process.exit(1); }
    const b = st.backoff;
    console.log(b ? `en attente : ${b.model} (case ${b.slot}), ${b.failures} erreur(s) de lancement, palier ${b.tier}/${b.maxTiers}, nouvel essai à ${b.until}` : `pas d'attente en cours (état ${st.status})`);
    process.exit(0);
  }
  const r = requestControl(logsDir, run, action, 'cli');
  console.log(r.ok ? `demande « ${action} » transmise à l'exécution ${run}` : r.why);
  process.exit(r.ok ? 0 : 2);
}
