#!/usr/bin/env node
// ============================================================================
// scripts/dispatch.mjs — sub-agent spawn helper
// ============================================================================
//
// Called by the central claude via its Bash tool:
//
//   node scripts/dispatch.mjs <projectName> "<prompt>"
//   node scripts/dispatch.mjs <projectName> --prompt-stdin < /tmp/p.txt
//
// Duties (per CLAUDE.md):
//   1. Resolve the project from config.json (fail loudly if unknown).
//   2. Scrub ANTHROPIC_API_KEY from the child env — subscription auth only.
//   3. Build the argv with verified kebab-case flags (see server.js top
//      for the verification note).
//   4. Append stream-json events to logs/<project>.jsonl.
//   5. Parse events on-the-fly and write logs/<project>.session when we see
//      a session_id. The orchestrator server re-reads sidecars via chokidar.
//   6. Propagate the sub-agent's exit code.
//
// Provider abstraction:
//   • provider="claude" (default) — existing stream-json pipeline, OAuth auth.
//   • provider="codex"            — OpenAI Codex CLI (full-auto quiet mode);
//     plain text output is wrapped in synthetic stream-json events so the
//     viewer pipeline (chokidar → SSE → Musician) works identically.
//     Auth is codex's own OAuth login (`codex login`) — NO API key is ever
//     forwarded, same rule as Claude. No session continuity (Codex has no
//     --resume equivalent); each turn is independent.
//
// ---------------------------------------------------------------------------
// DETERMINISTIC FAILOVER — Claude session limit → NVIDIA cascade (codage-first)
// ---------------------------------------------------------------------------
//
// THIS CODE RUNS WHEN EVERYTHING ELSE IS BROKEN. When the Claude account
// hits its session limit, the conductor (itself a Claude session) is dead
// too — so there is NO intelligence available to react. Every step below is
// therefore plain, boring, side-effect-free-until-it-must-not-be code. No
// LLM in the loop deciding routing, no callback that has to "decide".
//
// WHERE THE FAILOVER GOES (changed 2026-08-31):
//   The operator was unhappy with codex/gpt-5.6-sol, so the failover now
//   routes to NVIDIA's free OpenAI-compatible endpoint
//   (https://integrate.api.nvidia.com/v1) trying an ORDERED, coding-first
//   cascade — the next model is tried ONLY if the previous errored / hit a
//   quota / timed out / returned empty:
//     1. moonshotai/kimi-k3
//     2. deepseek-ai/deepseek-v4-pro-0813
//     3. nvidia/nemotron-3-ultra-550b-a55b
//     4. deepseek-ai/deepseek-v4-flash-0731
//   (model IDs verified live against GET /v1/models on 2026-08-31.)
//
//   WHY A DIRECT CLIENT AND NOT THE CODEX HARNESS: the clean option would be
//   to keep codex as the agentic harness and point its provider at NVIDIA,
//   preserving tool-use. That is NOT possible here: codex-cli 0.147.0 dropped
//   `wire_api = "chat"` and requires the Responses API, but NVIDIA only
//   exposes chat/completions (`/v1/responses` → 404). So the failover leg
//   speaks OpenAI chat/completions to NVIDIA directly (see runNvidiaFailover).
//   TRADE-OFF, stated honestly: this leg is a SINGLE-SHOT completion — the
//   NVIDIA model returns text/code but cannot run Bash/Edit tools or fire the
//   callback. It is a degraded mode whose only job is to keep the turn from
//   being lost while Claude is out.
//
//   AUTH: NVIDIA_API_KEY is read from I:\orchestrateur\.env (gitignored) and
//   sent ONLY to integrate.api.nvidia.com — never forwarded to any child
//   process. ANTHROPIC_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY are all
//   scrubbed from the child env. No secret is ever logged.
//
// Flow:
//   1. START OF EVERY DISPATCH — read logs/claude-limited.until.
//      · now <  until  → skip Claude entirely, run the NVIDIA cascade.
//      · now >= until  → delete the flag, run Claude normally. This is the
//        automatic return to Claude at reset time: no operator action, no
//        scheduled job, it just happens on the next dispatch.
//   2. DURING A CLAUDE TURN — scan authoritative output (result event,
//      stderr, assistant text) for the session-limit message.
//   3. ON DETECTION — parse "resets <time>" out of the message, write the
//      absolute reset timestamp to logs/claude-limited.until (fallback:
//      now + 60 min if parsing fails), then replay THE SAME prompt through
//      the NVIDIA cascade. The prompt is kept in memory precisely for this
//      replay: the turn must be re-run from its original text.
//   4. The flag is FLEET-WIDE by design — the limit is global to the
//      Claude account, so every project routes to NVIDIA until reset.
//   5. LAST RESORT: if the entire NVIDIA cascade is down (or the key is
//      missing), the leg falls through once to codex/gpt-5.6-sol (OAuth,
//      restores tool-use) rather than losing the turn. If codex also fails
//      we log and exit cleanly. Never a retry loop: a loop here would hammer
//      dead upstreams with no one watching.
//
// SELF-TEST: `node scripts/dispatch.mjs --test-failover` exercises the NVIDIA
// leg live WITHOUT touching any project log/sidecar or setting the limit flag
// (add --test-failover-all to walk the whole cascade instead of just kimi-k3).
//
// The nominal Claude path is untouched when no limit is in effect.
//
// NOTE on --bare: NOT used. See server.js top-of-file comment for the
// reasoning (--bare disables OAuth; we want subscription billing). We
// approximate the isolation with --setting-sources project,local +
// --strict-mcp-config + --disable-slash-commands.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function die(msg, code = 64) { console.error(`[dispatch] ${msg}`); process.exit(code); }

// ---------- argv ------------------------------------------------------------

const argv = process.argv.slice(2);

// Failover self-test hook. Runs the NVIDIA cascade client against the live
// endpoint WITHOUT touching any project log, sidecar, pid file, or the
// fleet limit flag — proving the leg works without simulating a real limit.
// Function decls below are hoisted, so calling here (before they textually
// appear) is safe; runFailoverSelfTest always ends in process.exit().
if (argv.includes('--test-failover')) {
  await runFailoverSelfTest();   // never returns — exits with the test result
}

if (argv.length < 1) die('usage: node scripts/dispatch.mjs <project> "<prompt>" | --prompt-stdin [--callback <project>] | --test-failover');

const projectName = argv[0];

// Extract --callback before prompt parsing so it doesn't bleed into the prompt string.
let callbackProject = null;
const cbIdx = argv.indexOf('--callback');
if (cbIdx !== -1) {
  if (cbIdx + 1 >= argv.length) die('--callback requires a project name');
  callbackProject = argv[cbIdx + 1];
  argv.splice(cbIdx, 2);
}

// Extract --source: marks the originating project when a musician sends a callback.
let sourceProject = null;
const srcIdx = argv.indexOf('--source');
if (srcIdx !== -1) {
  if (srcIdx + 1 >= argv.length) die('--source requires a project name');
  sourceProject = argv[srcIdx + 1];
  argv.splice(srcIdx, 2);
}

let prompt = '';
let imagePaths = [];   // populated when server passes attachment paths
let videoPaths = [];   // populated when server passes video paths (Claude API doesn't accept video)

if (argv[1] === '--prompt-stdin') {
  const raw = fs.readFileSync(0, 'utf8');
  // Server sends a JSON envelope when attachments are present; plain text otherwise.
  try {
    const env = JSON.parse(raw);
    if (typeof env.prompt === 'string') {
      prompt = env.prompt;
      if (Array.isArray(env.attachmentPaths)) imagePaths = env.attachmentPaths;
      if (Array.isArray(env.videoPaths))      videoPaths = env.videoPaths;
    } else {
      prompt = raw;
    }
  } catch {
    prompt = raw; // plain text — backward compat
  }
} else if (argv.length >= 2) {
  prompt = argv.slice(1).join(' ');
} else {
  die('missing prompt — pass as argv or use --prompt-stdin');
}

if (!prompt.trim() && !imagePaths.length && !videoPaths.length) die('empty prompt');

// ---------- config ----------------------------------------------------------

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const project = config.projects.find(p => p.name === projectName);
if (!project) {
  die(`unknown project "${projectName}". Known: ${config.projects.map(p => p.name).join(', ')}`);
}
if (!fs.existsSync(project.path)) {
  die(`project path does not exist: ${project.path}`, 66);
}
if (callbackProject && !config.projects.find(p => p.name === callbackProject)) {
  die(`--callback: unknown project "${callbackProject}". Known: ${config.projects.map(p => p.name).join(', ')}`);
}

const model    = project.model    || config.defaults?.model        || 'claude-sonnet-4-6';
const tools    = project.tools    || config.defaults?.allowedTools || 'Read,Edit,Write,Bash';
const provider = project.provider || config.defaults?.provider     || 'claude';

// ---------- paths -----------------------------------------------------------

const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

// Kill-switch failover : si logs/no-failover existe, aucune bascule de modèle.
const NO_FAILOVER = fs.existsSync(path.join(LOGS, 'no-failover'));

const logPath     = path.join(LOGS, `${projectName}.jsonl`);
const sessionPath = path.join(LOGS, `${projectName}.session`);
const pidPath     = path.join(LOGS, `${projectName}.pid`);

let sessionId = null;
try { sessionId = fs.readFileSync(sessionPath, 'utf8').trim() || null; } catch {}

// ============================================================================
// FAILOVER CORE — deterministic, no IA in the loop. See top-of-file comment.
// ============================================================================

// Fleet-wide flag. Contains a single ISO-8601 timestamp: the moment the
// Claude session limit is expected to reset. Presence alone means nothing —
// only `now < contents` means "limited". An expired flag is deleted on read,
// which is what makes the return to Claude automatic.
const LIMIT_FLAG_PATH = path.join(LOGS, 'claude-limited.until');

// Model used for the failover leg. Explicit per the fleet spec; a project's
// own codexModel (or the config default) still wins if one is configured.
const FAILOVER_CODEX_MODEL = 'gpt-5.6-sol';

// Conservative fallback when the reset time can't be parsed out of the
// message. Long enough to stop hammering a dead account, short enough that
// an over-estimate costs at most one hour of codex routing.
const LIMIT_FALLBACK_MS = 60 * 60 * 1000;

// Never trust a parsed reset further out than this. Guards against a
// misparse pinning the whole fleet on codex for days.
const LIMIT_MAX_MS = 24 * 60 * 60 * 1000;

/** Phrases that mean "the Claude session/usage budget is exhausted".
 *  Kept narrow on purpose: a false positive routes a healthy turn to codex. */
const LIMIT_PATTERNS = [
  /you'?ve\s+hit\s+your\s+(?:session|usage)\s+limit/i,
  /you\s+have\s+hit\s+your\s+(?:session|usage)\s+limit/i,
  /(?:session|usage)\s+limit\s+reached/i,
  /\d+\s*-?\s*hour\s+limit\s+reached/i,
  /claude\s+(?:ai\s+)?usage\s+limit\s+reached/i,
  /rate[_\s-]?limit[_\s-]?(?:error|exceeded)/i,
  /\bupgrade_required\b/i,
];

// "You're approaching your session limit" is a WARNING on a healthy turn.
// Treating it as exhaustion would fail over while Claude still works.
const LIMIT_NEGATIVE_PATTERN = /approaching|will\s+reach|about\s+to\s+(?:hit|reach)/i;

/** True when `text` states the Claude budget is actually exhausted. */
function detectClaudeLimit(text) {
  if (typeof text !== 'string' || !text) return false;
  if (LIMIT_NEGATIVE_PATTERN.test(text)) return false;
  return LIMIT_PATTERNS.some(re => re.test(text));
}

/**
 * Extract the reset instant from a limit message.
 * Handles "resets 3pm", "resets at 3:30 PM", "resets at 15:00" and an
 * embedded ISO timestamp. Returns a Date, or null when nothing parses.
 *
 * Times are read as LOCAL time — that is how the CLI prints them.
 */
function parseResetTime(text, now = new Date()) {
  if (typeof text !== 'string' || !text) return null;

  // Form 1: an explicit ISO timestamp — unambiguous, prefer it.
  const isoMatch = /resets?\b[^\n]{0,20}?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (isoMatch) {
    const d = new Date(isoMatch[1].replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) return clampReset(d, now);
  }

  // Form 2: a wall-clock time, optionally with am/pm.
  const clockMatch = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (clockMatch) {
    let hour = parseInt(clockMatch[1], 10);
    const minute = clockMatch[2] ? parseInt(clockMatch[2], 10) : 0;
    const meridiem = clockMatch[3] ? clockMatch[3].toLowerCase() : null;
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      if (hour <= 23) {
        const d = new Date(now);
        d.setHours(hour, minute, 0, 0);
        return clampReset(d, now);
      }
    }
  }
  return null;
}

/** Force a parsed reset into a sane window: strictly in the future (a time
 *  already past today means tomorrow), and never beyond LIMIT_MAX_MS. */
function clampReset(date, now = new Date()) {
  let ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  // A wall-clock time earlier than now refers to tomorrow (e.g. "resets 2am"
  // read at 11pm). Reset instants are always ahead of us.
  if (ms <= now.getTime()) ms += 24 * 60 * 60 * 1000;
  const maxMs = now.getTime() + LIMIT_MAX_MS;
  if (ms > maxMs) ms = maxMs;
  return new Date(ms);
}

/**
 * Read the fleet limit flag.
 * Returns a Date while the limit is still in effect, or null.
 * SIDE EFFECT (intended): an expired or unreadable flag is deleted, so the
 * fleet returns to Claude automatically at reset time.
 */
function readClaudeLimitFlag() {
  let raw;
  try { raw = fs.readFileSync(LIMIT_FLAG_PATH, 'utf8').trim(); }
  catch { return null; }                        // no flag = not limited

  const until = new Date(raw);
  if (!raw || Number.isNaN(until.getTime())) {
    // Corrupt flag: refuse to strand the fleet on codex forever.
    console.error(`[FAILOVER] unreadable ${LIMIT_FLAG_PATH} ("${raw}") — clearing, routing Claude normally`);
    clearClaudeLimitFlag();
    return null;
  }
  if (Date.now() >= until.getTime()) {
    console.error(`[FAILOVER] Claude limit expired at ${until.toISOString()} — clearing flag, back to Claude`);
    clearClaudeLimitFlag();
    return null;
  }
  return until;
}

/** Persist the reset instant. Returns the Date actually written. */
function writeClaudeLimitFlag(resetAt) {
  const until = resetAt instanceof Date && !Number.isNaN(resetAt.getTime())
    ? resetAt
    : new Date(Date.now() + LIMIT_FALLBACK_MS);   // parsing failed → conservative
  try {
    // Temp + rename: a concurrent dispatch must never read a half-written
    // timestamp and conclude the flag is corrupt.
    const tmp = LIMIT_FLAG_PATH + '.tmp';
    fs.writeFileSync(tmp, until.toISOString());
    fs.renameSync(tmp, LIMIT_FLAG_PATH);
  } catch (e) {
    // Even if persisting fails, this dispatch still fails over to codex —
    // we just lose the fleet-wide short-circuit for other projects.
    console.error(`[FAILOVER] could not write ${LIMIT_FLAG_PATH}: ${e.message}`);
  }
  return until;
}

function clearClaudeLimitFlag() {
  try { fs.unlinkSync(LIMIT_FLAG_PATH); } catch {}
}

/** Model the codex LAST-RESORT leg will use — resolved the same way runCodex
 *  does, so the log line never disagrees with what actually runs. */
function failoverCodexModel() {
  return project.codexModel || config.defaults?.codexModel || FAILOVER_CODEX_MODEL;
}

// ---------------------------------------------------------------------------
// NVIDIA failover cascade (codage-first) — direct OpenAI-compatible client.
// Not routed through codex: codex 0.147.0 requires the Responses API and
// NVIDIA only serves chat/completions (see top-of-file header for the full
// reasoning). This is a SINGLE-SHOT completion leg — no tool-use, no callback.
// ---------------------------------------------------------------------------

/** Cascade definition. Ordered: model N+1 is tried ONLY if model N fails.
 *  A function (not a const) so the early --test-failover gate can call it
 *  before any module-level const is initialised (no temporal-dead-zone). */
function nvidiaFailoverConfig() {
  return {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    // IDs verified live against GET /v1/models on 2026-08-31 — they are
    // namespaced (vendor/model). Keep this list in sync with the header.
    cascade: [
      'moonshotai/kimi-k3',                  // 1 — primary coder
      'deepseek-ai/deepseek-v4-pro-0813',    // 2 — strong coder
      'nvidia/nemotron-3-ultra-550b-a55b',   // 3 — large generalist
      'deepseek-ai/deepseek-v4-flash-0731',  // 4 — fast last rung
    ],
    maxTokens: 4096,
    timeoutMs: 120_000,
  };
}

/** Read NVIDIA_API_KEY from process.env first, then I:\orchestrateur\.env.
 *  NEVER logged. Returns the key string or null. */
function loadNvidiaKey() {
  if (process.env.NVIDIA_API_KEY && process.env.NVIDIA_API_KEY.trim()) {
    return process.env.NVIDIA_API_KEY.trim();
  }
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*NVIDIA_API_KEY\s*=\s*(.*)$/.exec(line);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return null;
}

/**
 * One OpenAI-compatible chat/completions call to NVIDIA. Resolves (never
 * rejects) to { ok:true, text, usage, model } or { ok:false, error }.
 * The key rides the Authorization header to integrate.api.nvidia.com only.
 */
function nvidiaChat({ baseUrl, model, messages, apiKey, maxTokens, timeoutMs }) {
  return new Promise((resolve) => {
    let body;
    try { body = JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens, stream: false }); }
    catch (e) { resolve({ ok: false, error: `body: ${e.message}` }); return; }
    let req;
    try {
      req = https.request(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; if (data.length > 8_000_000) { try { req.destroy(); } catch {} } });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Truncate + collapse: upstream errors can be verbose, and we log
            // them — must never risk echoing a header/token back out.
            resolve({ ok: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 200).replace(/\s+/g, ' ')}` });
            return;
          }
          try {
            const j = JSON.parse(data);
            const text = j.choices?.[0]?.message?.content ?? '';
            resolve({ ok: true, text, usage: j.usage || null, model: j.model || model });
          } catch (e) { resolve({ ok: false, error: `parse: ${e.message}` }); }
        });
      });
    } catch (e) { resolve({ ok: false, error: `request: ${e.message}` }); return; }
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve({ ok: false, error: `timeout after ${timeoutMs}ms` }); });
    req.end(body);
  });
}

/**
 * The failover leg: walk the NVIDIA cascade, emit Claude-schema events so the
 * viewer/reducer/callback pipeline is unaffected, and exit. If the whole
 * cascade is down (or the key is missing) fall through ONCE to codex/gpt-5.6-sol
 * (OAuth, tool-use) as the absolute last resort. Terminates the process.
 */
async function runNvidiaFailover() {
  const cfg    = nvidiaFailoverConfig();
  const apiKey = loadNvidiaKey();
  const fakeSid = `nvidia-${crypto.randomUUID()}`;

  if (!apiKey) {
    console.error('[FAILOVER] NVIDIA_API_KEY not found in env or .env — last resort codex/gpt-5.6-sol');
    try {
      logStream.write(JSON.stringify({
        type: 'system', subtype: 'failover-note',
        note: 'nvidia_key_missing', to: `codex/${FAILOVER_CODEX_MODEL}`,
        timestamp: new Date().toISOString(),
      }) + '\n');
    } catch {}
    runCodex(true);
    return;
  }

  logStream.write(JSON.stringify({
    type: 'system', subtype: 'init', session_id: fakeSid,
    provider: 'nvidia', failover: true,
    model: cfg.cascade[0], cascade: cfg.cascade,
    timestamp: new Date().toISOString(),
  }) + '\n');

  const messages = [
    { role: 'system', content:
        'You are a coding assistant acting as a FAILOVER for a headless agent whose primary model is temporarily unavailable. '
      + `You are working on the project at ${project.path}. In this failover mode you CANNOT execute shell commands or edit files — `
      + 'answer with concrete, complete code and clear step-by-step instructions the operator can apply directly. Prioritise correctness.' },
    { role: 'user', content: prompt },
  ];

  for (let i = 0; i < cfg.cascade.length; i++) {
    const model = cfg.cascade[i];
    console.error(`[FAILOVER] NVIDIA cascade ${i + 1}/${cfg.cascade.length}: ${model} for ${projectName}`);
    const r = await nvidiaChat({ baseUrl: cfg.baseUrl, model, messages, apiKey, maxTokens: cfg.maxTokens, timeoutMs: cfg.timeoutMs });

    if (r.ok && r.text && r.text.trim()) {
      logStream.write(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: r.text }] },
        provider: 'nvidia', model, timestamp: new Date().toISOString(),
      }) + '\n');
      logStream.write(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false,
        result: r.text, session_id: fakeSid, num_turns: 1,
        usage: r.usage
          ? { input_tokens: r.usage.prompt_tokens ?? 0, output_tokens: r.usage.completion_tokens ?? 0 }
          : {},
        provider: 'nvidia', model, failover: true, cascade_index: i,
        timestamp: new Date().toISOString(),
      }) + '\n');
      console.error(`[FAILOVER] NVIDIA ${model} answered ${projectName} (cascade rung ${i + 1})`);
      try { fs.unlinkSync(pidPath); } catch {}
      endLogAndExit(0);
      return;
    }

    console.error(`[FAILOVER] NVIDIA ${model} failed for ${projectName}: ${r.error || 'empty response'} — advancing cascade`);
    try {
      logStream.write(JSON.stringify({
        type: 'system', subtype: 'failover-note',
        note: 'nvidia_model_failed', model,
        error: (r.error || 'empty response').slice(0, 200),
        timestamp: new Date().toISOString(),
      }) + '\n');
    } catch {}
  }

  // Every NVIDIA rung is down. One last rung — codex/gpt-5.6-sol via OAuth —
  // restores tool-use rather than losing the turn outright.
  console.error(`[FAILOVER] entire NVIDIA cascade failed for ${projectName} — last resort codex/${FAILOVER_CODEX_MODEL}`);
  try {
    logStream.write(JSON.stringify({
      type: 'system', subtype: 'failover-note',
      note: 'nvidia_cascade_exhausted', to: `codex/${FAILOVER_CODEX_MODEL}`,
      timestamp: new Date().toISOString(),
    }) + '\n');
  } catch {}
  runCodex(true);
}

/**
 * Self-test for the NVIDIA leg. Hits the live endpoint but touches NO project
 * log / sidecar / pid file and NEVER sets the limit flag. Exits 0 if at least
 * one probed model answered, 1 otherwise. Never prints the key.
 */
async function runFailoverSelfTest() {
  const cfg    = nvidiaFailoverConfig();
  const apiKey = loadNvidiaKey();
  console.error('[test-failover] NVIDIA failover self-test — no project logs touched, no limit flag set');
  if (!apiKey) { console.error('[test-failover] FAIL: NVIDIA_API_KEY not found in env or .env'); process.exit(1); }
  console.error(`[test-failover] key loaded (length=${apiKey.length}); cascade = ${cfg.cascade.join(' -> ')}`);

  // Default: probe only the primary (kimi-k3) — enough to prove the leg.
  // --test-failover-all walks every rung so an operator can check the lot.
  // maxTokens is generous: several cascade models are REASONING models that
  // spend hidden tokens before emitting visible content — a tiny cap makes
  // them return empty (finish_reason "length"), which is a false negative.
  const all = process.argv.includes('--test-failover-all');
  const models = all ? cfg.cascade : [cfg.cascade[0]];
  const messages = [{ role: 'user', content: 'Reply with the single word PONG and nothing else.' }];

  let anyOk = false;
  for (const model of models) {
    const t0 = Date.now();
    const r = await nvidiaChat({ baseUrl: cfg.baseUrl, model, messages, apiKey, maxTokens: 256, timeoutMs: 90_000 });
    const ms = Date.now() - t0;
    const text = (r.text || '').trim();
    // Match the real leg: ok transport + empty content counts as a failure.
    if (r.ok && text) { anyOk = true; console.error(`[test-failover] OK   ${model} (${ms}ms): ${JSON.stringify(text.slice(0, 40))}`); }
    else               console.error(`[test-failover] FAIL ${model} (${ms}ms): ${r.ok ? 'empty content' : r.error}`);
  }
  process.exit(anyOk ? 0 : 1);
}

// ---------- callback injection ----------------------------------------------

// promptForLog = original prompt shown in the viewer (no boilerplate).
// prompt       = what actually reaches claude (with injected callback instruction).
const promptForLog = prompt;
if (callbackProject) {
  const notifyPath = path.join(ROOT, 'scripts', 'notify.mjs');
  // Use printf + --stdin to avoid shell truncation of multi-line or
  // markdown-rich text (pipes, quotes, newlines break argv on Windows).
  prompt = prompt + `\n\n---\nUne fois ta tâche terminée — ou si tu as un point important à signaler en cours de route — envoie un résumé au projet « ${callbackProject} » via cette commande Bash (utilise IMPÉRATIVEMENT la forme stdin pour éviter la troncature shell) :\n\n  printf '%s' "ton résumé complet ici" | node "${notifyPath}" ${callbackProject} --stdin --source ${projectName}\n\nSi le résumé contient des sauts de ligne ou du markdown, écris-le dans une variable bash d'abord :\n\n  RESUME="ligne 1\nligne 2\nligne 3"\n  printf '%s' "$RESUME" | node "${notifyPath}" ${callbackProject} --stdin --source ${projectName}\n\nAdapte le contenu au contexte : ce que tu as accompli, découvert, ou la question que tu poses.`;
}

// ---------- env scrub -------------------------------------------------------

const env = { ...process.env };
// Subscription/OAuth auth only — NEVER forward a provider API key to a child.
// Claude rides the Max/Pro OAuth session (~/.claude/), codex rides its own
// OAuth login (`codex login`). Forwarding a key would silently move billing
// off the subscription. Guards anthropics/claude-code#39903.
delete env.ANTHROPIC_API_KEY;
delete env.OPENAI_API_KEY;
// The NVIDIA key is used ONLY by our own https client (runNvidiaFailover),
// sent ONLY to integrate.api.nvidia.com. It must never reach a child process
// (a codex last-resort spawn rides its own OAuth). loadNvidiaKey reads it from
// the parent process.env / .env, so scrubbing the child copy is harmless here.
delete env.NVIDIA_API_KEY;

// ---------- shared log setup ------------------------------------------------

const logStream = fs.createWriteStream(logPath, { flags: 'a' });
logStream.write(`\n`); // ensure boundary from previous turn

/**
 * Close the log and exit — WAITING for the buffered writes to reach disk.
 *
 * `process.exit()` does not flush pending WriteStream data. Calling it right
 * after `logStream.end()` silently truncated whatever was written in the last
 * few milliseconds of the turn: the synthetic `result`, and — worse — the
 * entire `failover` audit trail plus the codex output, since those are all
 * emitted immediately before exit. Observed in testing: the turn ran, the
 * console showed [FAILOVER], and the JSONL held nothing.
 *
 * We therefore exit from the stream's finish callback, with a 2 s ceiling so
 * a wedged stream can never hang a dispatch.
 */
function endLogAndExit(code) {
  let exited = false;
  const go = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  // Deliberately NOT unref'd: the timer must hold the event loop open long
  // enough for the flush to land, otherwise Node would exit 0 on its own.
  const guard = setTimeout(go, 2000);
  try { logStream.end(() => { clearTimeout(guard); go(); }); }
  catch { clearTimeout(guard); go(); }
}

// Synthetic "user_prompt" event so the viewer can show what was asked before
// any real stream-json event arrives.
const userPromptEvent = { type: 'user_prompt', text: promptForLog, timestamp: new Date().toISOString() };
if (imagePaths.length) userPromptEvent.attachmentPaths = imagePaths;
if (sourceProject) userPromptEvent.source = sourceProject;
logStream.write(JSON.stringify(userPromptEvent) + '\n');

// ============================================================================
// PROVIDER BRANCH
// ============================================================================

/**
 * Run the turn through the OpenAI Codex CLI.
 *
 * @param {boolean} isFailover  true when reached from the Claude failover
 *        path. Only changes logging, the default model, and the exit
 *        behaviour on failure — there is NO second failover level.
 */
function runCodex(isFailover = false) {

  // ── Codex path ─────────────────────────────────────────────────────────────
  //
  // The OpenAI Codex CLI (@openai/codex) has its own non-interactive mode,
  // `codex exec --json`, whose event schema is NOT Claude's stream-json. We
  // run it and translate every event into the Claude schema (see the mapper
  // below) so the rest of the pipeline (chokidar → SSE → Musician state
  // machine → fleet-status) is unaffected.
  //
  // Limitations vs Claude:
  //   • No session continuity. `codex exec resume <thread_id>` exists but is
  //     not wired up; each turn is independent.
  //   • Auth is codex's own OAuth (`codex login`, ~/.codex/auth.json).
  //     No API key is forwarded — both ANTHROPIC_API_KEY and OPENAI_API_KEY
  //     are scrubbed from the child env.

  /**
   * Locate the codex CLI and return how to spawn it: { cmd, prefixArgs }.
   *
   * WHY THIS IS NOT JUST "return 'codex.cmd'":
   * Since the BatBadBut fix (Node ≥18.20.2/20.12/21.7, and every Node 24),
   * `spawn()` with `shell: false` THROWS EINVAL on a `.cmd`/`.bat` target.
   * The previous implementation returned `codex.cmd` (or a bare `codex`
   * PATH lookup that resolves to `.cmd` via PATHEXT), so the codex path
   * could not start at all on this machine — the failover would have died
   * on an uncaught EINVAL at the exact moment it was needed.
   *
   * Resolution order, safest first:
   *   1. CODEX_BIN — explicit operator override (test stubs use this).
   *   2. The package's own `codex.js`, run as `node codex.js`. Argv stays an
   *      array, no shell is involved, so nothing in the prompt can be
   *      interpreted as a command. This is the path we want.
   *   3. A real `codex.exe` — also spawnable directly.
   *   4. `.cmd` wrapper via cmd.exe — last resort, see the note below.
   *
   * npm bin dirs are discovered from PATH as well as the usual locations,
   * because a custom npm prefix (here: I:\npm-global) is invisible to a
   * hardcoded %APPDATA%\npm list.
   */
  function resolveCodexBin() {
    const fromEnv = process.env.CODEX_BIN;
    if (fromEnv) return classifyCodexBin(fromEnv);
    if (process.platform !== 'win32') return { cmd: 'codex', prefixArgs: [] };

    // Candidate npm bin directories, in priority order.
    const dirs = [];
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) {
      dirs.push(path.join(home, 'AppData', 'Roaming', 'npm'), path.join(home, '.local', 'bin'));
    }
    for (const p of (process.env.PATH || '').split(path.delimiter)) {
      if (p && p.trim()) dirs.push(p.trim());
    }
    try {
      for (const u of fs.readdirSync('C:\\Users', { withFileTypes: true })) {
        if (!u.isDirectory()) continue;
        if (u.name === 'Public' || u.name === 'Default' || u.name.startsWith('All ')) continue;
        dirs.push(`C:\\Users\\${u.name}\\AppData\\Roaming\\npm`);
      }
    } catch {}

    const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

    // Pass 1 — the JS entry point (safest).
    for (const d of dirs) {
      const js = path.join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (isFile(js)) return { cmd: process.execPath, prefixArgs: [js] };
    }
    // Pass 2 — a native executable.
    for (const d of dirs) {
      const exe = path.join(d, 'codex.exe');
      if (isFile(exe)) return { cmd: exe, prefixArgs: [] };
    }
    // Pass 3 — the .cmd shim.
    for (const d of dirs) {
      const cmdFile = path.join(d, 'codex.cmd');
      if (isFile(cmdFile)) return classifyCodexBin(cmdFile);
    }
    return { cmd: 'codex', prefixArgs: [] };
  }

  /** Turn an explicit binary path into a safe spawn descriptor. */
  function classifyCodexBin(bin) {
    if (/\.(mjs|js|cjs)$/i.test(bin)) return { cmd: process.execPath, prefixArgs: [bin] };
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
      // LAST RESORT. A batch shim cannot be spawned directly (EINVAL), so it
      // must go through cmd.exe. `/d /s /c` plus wrapping the whole command
      // line in one extra pair of quotes is the documented-safe form, and
      // windowsVerbatimArguments stops Node from re-quoting on top of ours.
      // Prefer the .js route above whenever it exists — the prompt is
      // attacker-shaped text and we do not want it near a command line.
      return { cmd: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', bin], viaCmd: true };
    }
    return { cmd: bin, prefixArgs: [] };
  }

  const codexBinInfo = resolveCodexBin();
  // On the failover leg the fleet spec pins a specific model; an explicit
  // project/config setting still wins so per-project choices are honoured.
  const codexModel = project.codexModel
    || config.defaults?.codexModel
    || (isFailover ? FAILOVER_CODEX_MODEL : 'gpt-4o');
  const fakeSid    = `codex-${crypto.randomUUID()}`;

  logStream.write(JSON.stringify({
    type: 'system', subtype: 'init', session_id: fakeSid,
    provider: 'codex', failover: isFailover || undefined,
    model: codexModel, timestamp: new Date().toISOString(),
  }) + '\n');

  // Where codex writes its final assistant message. Authoritative source for
  // the synthetic `result` text — more reliable than reassembling it from the
  // event stream. Removed once read.
  const lastMsgPath = path.join(LOGS, `${projectName}.codex-last.txt`);
  try { fs.unlinkSync(lastMsgPath); } catch {}

  // ── Invocation (codex-cli 0.147.0, verified against `codex exec --help`) ──
  //
  // `codex exec` is the non-interactive mode. Flag notes, each one learned the
  // hard way from the real CLI:
  //   • The old `--approval-mode full-auto` / `--quiet` pair NO LONGER EXISTS.
  //     Passing it made codex exit 2 immediately ("unexpected argument").
  //   • `--approve-for-me` is its replacement: auto-approval routed through
  //     the workspace-write sandbox.
  //   • `-s/--sandbox` is MUTUALLY EXCLUSIVE with `--approve-for-me` ("cannot
  //     be used with"). --approve-for-me already implies workspace-write, so
  //     we must NOT pass -s alongside it.
  //   • `--dangerously-bypass-approvals-and-sandbox` is the codex equivalent
  //     of --dangerously-skip-permissions. FLEET RULE: never used.
  //   • `--skip-git-repo-check` is required — several fleet projects are not
  //     git repositories and codex otherwise refuses to run.
  //   • `--json` emits JSONL events (mapped to the Claude schema below).
  //   • Prompt goes through STDIN with the `-` placeholder: no argv length
  //     limit, and nothing in the prompt can ever reach a command line.
  const codexArgs = [
    'exec',
    '--model', codexModel,
    '--approve-for-me',
    '--skip-git-repo-check',
    '--json',
    '--cd', project.path,
    '--output-last-message', lastMsgPath,
    // Images are natively supported here, unlike the old path which dropped
    // them silently — matters when a failover replays a turn that had attachments.
    ...imagePaths.flatMap(p => ['--image', p]),
    '-',   // read the prompt from stdin
  ];

  // spawn() can THROW synchronously (EINVAL on a batch shim, ENOENT on a bad
  // override) rather than emitting 'error'. On the failover leg an uncaught
  // throw here would kill the dispatch with no result event and no clean
  // exit — precisely the crash-when-everything-is-broken case this feature
  // exists to prevent. Requirement: log it, close the turn, exit. No retry.
  let codexChild;
  try {
    codexChild = spawn(codexBinInfo.cmd, [...codexBinInfo.prefixArgs, ...codexArgs], {
      cwd: project.path,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],   // stdin carries the prompt
      shell: false,
      windowsHide: true,
      ...(codexBinInfo.viaCmd ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    const where = isFailover ? '[FAILOVER] codex fallback' : '[dispatch/codex] codex';
    console.error(`${where} could not be spawned (${codexBinInfo.cmd}): ${err.message} — giving up (no retry loop)`);
    logStream.write(JSON.stringify({
      type: 'result', subtype: 'error', is_error: true,
      result: `codex spawn failed: ${err.message}`,
      session_id: fakeSid, usage: {},
      provider: 'codex', failover: isFailover || undefined,
      timestamp: new Date().toISOString(),
    }) + '\n');
    try { fs.unlinkSync(pidPath); } catch {}
    endLogAndExit(1);
    return;
  }
  try { fs.writeFileSync(pidPath, String(codexChild.pid)); } catch {}

  // Feed the prompt and close stdin so codex stops waiting for more input.
  try { codexChild.stdin.end(prompt); } catch {}

  // ── codex --json → Claude stream-json mapping ──────────────────────────────
  //
  // The two schemas are NOT compatible, and everything downstream (the log
  // reducer in server.js, fleet-status.mjs, the viewer, the chef's callback)
  // only understands Claude's. Writing codex events through raw would leave
  // the panel stuck with no `result` — the failover would "work" while the
  // fleet stayed visibly blocked. So we translate.
  //
  // Real codex 0.147.0 event shapes (captured live, not guessed):
  //   {"type":"thread.started","thread_id":"…"}
  //   {"type":"turn.started"}
  //   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
  //   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N,…}}
  // and on failure:
  //   {"type":"item.completed","item":{"type":"error","message":"…"}}
  //   {"type":"error","message":"…"}
  //   {"type":"turn.failed","error":{"message":"…"}}
  //
  // NOTE: the codex thread_id is deliberately NOT written to
  // logs/<project>.session. That sidecar feeds `claude --resume`; putting a
  // codex id there would corrupt the Claude session on the way back from a
  // failover.

  let codexStdoutTail = '';
  let codexFinalText  = '';   // accumulated agent_message text (fallback)
  let codexErrorMsg   = null; // first hard error seen
  let codexTurnFailed = false;
  let codexUsage      = null;
  let codexThreadId   = null;

  function writeAssistant(blocks) {
    if (!blocks.length) return;
    logStream.write(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: blocks },
      provider: 'codex', timestamp: new Date().toISOString(),
    }) + '\n');
  }

  /** Translate one codex event into zero or more Claude-schema events. */
  function mapCodexEvent(ev) {
    switch (ev.type) {
      case 'thread.started':
        // The system/init that puts the panel in `live` was already written
        // before the spawn (so a codex that dies instantly still shows a
        // started turn). Here we only record the thread id, which is echoed
        // on the final result for traceability.
        codexThreadId = ev.thread_id || null;
        return;

      case 'item.completed': {
        const item = ev.item || {};
        switch (item.type) {
          case 'agent_message':
            if (item.text) {
              codexFinalText = item.text;
              writeAssistant([{ type: 'text', text: item.text }]);
            }
            return;
          case 'reasoning':
            if (item.text) writeAssistant([{ type: 'thinking', thinking: item.text }]);
            return;
          case 'command_execution':
            writeAssistant([{
              type: 'tool_use', id: item.id || 'codex-cmd', name: 'Bash',
              input: { command: item.command ?? '', status: item.status },
            }]);
            return;
          case 'file_change':
            writeAssistant([{
              type: 'tool_use', id: item.id || 'codex-edit', name: 'Edit',
              input: { changes: item.changes ?? item },
            }]);
            return;
          case 'mcp_tool_call':
          case 'web_search':
            writeAssistant([{
              type: 'tool_use', id: item.id || `codex-${item.type}`, name: item.type,
              input: item,
            }]);
            return;
          case 'error':
            // Non-fatal notice (codex emits these as warnings too). Surface it,
            // but let turn.failed / exit code decide whether the turn errored.
            if (item.message) writeAssistant([{ type: 'text', text: `[codex] ${item.message}` }]);
            return;
          default:
            // Unknown item kind: keep it visible rather than dropping it.
            if (item.text) writeAssistant([{ type: 'text', text: item.text }]);
            return;
        }
      }

      case 'error':
        if (!codexErrorMsg) codexErrorMsg = extractCodexError(ev.message);
        return;

      case 'turn.failed':
        codexTurnFailed = true;
        if (!codexErrorMsg) codexErrorMsg = extractCodexError(ev.error?.message ?? ev.error);
        return;

      case 'turn.completed':
        if (ev.usage) codexUsage = ev.usage;
        return;

      default:
        return;   // turn.started and anything future: nothing to emit
    }
  }

  /** codex nests the upstream API error as a JSON string. Pull out the human part. */
  function extractCodexError(raw) {
    if (raw == null) return null;
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
    try {
      const parsed = JSON.parse(s);
      return parsed?.error?.message || parsed?.message || s;
    } catch { return s; }
  }

  codexChild.stdout.on('data', (chunk) => {
    codexStdoutTail += chunk.toString('utf8');
    const lines = codexStdoutTail.split(/\r?\n/);
    codexStdoutTail = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); }
      catch {
        // Not JSONL (a banner, a warning) — preserve it as plain text.
        writeAssistant([{ type: 'text', text: line }]);
        continue;
      }
      try { mapCodexEvent(ev); }
      catch (e) { debugCodex(`event map failed: ${e.message}`); }
    }
  });

  function debugCodex(msg) { console.error(`[dispatch/codex] ${msg}`); }

  codexChild.stderr.on('data', (chunk) => {
    // codex uses stderr for progress chatter; keep it off the JSONL log so we
    // never corrupt the event stream with non-JSON lines.
    process.stderr.write(chunk);
  });

  codexChild.on('error', (err) => {
    // Terminal for this turn. On the failover leg this is the second and
    // LAST provider — we log loudly and let finishCodex exit. No retry.
    if (isFailover) {
      console.error(`[FAILOVER] codex fallback also failed to spawn for ${projectName}: ${err.message} — giving up (no retry loop)`);
    } else {
      console.error(`[dispatch/codex] spawn error: ${err.message}`);
    }
  });

  let codexDone = false;
  function finishCodex(code, signal) {
    if (codexDone) return;
    codexDone = true;

    // Drain a trailing partial line (no newline before EOF).
    if (codexStdoutTail.trim()) {
      let ev = null;
      try { ev = JSON.parse(codexStdoutTail); } catch {}
      if (ev) { try { mapCodexEvent(ev); } catch {} }
      else writeAssistant([{ type: 'text', text: codexStdoutTail }]);
      codexStdoutTail = '';
    }

    // The final message file is authoritative; fall back to the last
    // agent_message we saw, then to the error text.
    let finalText = '';
    try { finalText = fs.readFileSync(lastMsgPath, 'utf8').trim(); } catch {}
    if (!finalText) finalText = codexFinalText.trim();
    try { fs.unlinkSync(lastMsgPath); } catch {}

    // A turn is an error if codex said so OR the process failed. Both are
    // checked: turn.failed can appear with exit 0 in principle, and a crash
    // can kill codex before it emits any event at all.
    const isErr = codexTurnFailed || !!codexErrorMsg
      || (code !== 0 && code !== null) || !!signal;

    if (isErr && !finalText) finalText = codexErrorMsg || `codex exited with code ${code}${signal ? ` (signal ${signal})` : ''}`;

    // THE event everything downstream keys on: server.js's reducer, the
    // viewer's panel state, fleet-status.mjs and the chef's callback all
    // look for a Claude-shaped `result`. Without it the panel never leaves
    // `live`, whatever codex actually did.
    logStream.write(JSON.stringify({
      type: 'result',
      subtype: isErr ? 'error' : 'success',
      is_error: isErr,
      result: finalText,
      session_id: fakeSid,
      thread_id: codexThreadId,
      num_turns: 1,
      usage: codexUsage
        ? { input_tokens: codexUsage.input_tokens ?? 0, output_tokens: codexUsage.output_tokens ?? 0 }
        : {},
      provider: 'codex',
      model: codexModel,
      failover: isFailover || undefined,
      timestamp: new Date().toISOString(),
    }) + '\n');
    try { fs.unlinkSync(pidPath); } catch {}
    // END OF THE LINE. Codex is the last provider we try — whatever happened
    // here, we exit. A retry loop would pound a dead account unattended.
    if (isFailover) {
      if (isErr) console.error(`[FAILOVER] codex fallback FAILED for ${projectName} (code=${code} signal=${signal || 'none'}) — turn lost, giving up (no retry loop)`);
      else       console.error(`[FAILOVER] codex fallback completed ${projectName} via ${codexModel}`);
    }
    if (signal) { console.error(`[dispatch/codex] killed by ${signal}`); endLogAndExit(128); return; }
    endLogAndExit(code ?? 1);
  }
  codexChild.on('exit',  (c, s) => finishCodex(c, s));
  codexChild.on('close', (c, s) => finishCodex(c, s));

}

/**
 * Run the turn through Claude (nominal path).
 *
 * Unchanged from the original implementation except for the session-limit
 * watch: output is scanned for exhaustion, and if the turn dies from it we
 * hand the SAME prompt to runCodex(true) instead of exiting.
 */
function runClaude() {

  // ── Claude path (original) ─────────────────────────────────────────────────

  // When images are present we use --input-format stream-json so we can embed
  // base64 image content blocks in the user message. The claude CLI has no
  // --image flag (verified against v2.1.113); stream-json input is the only way.
  // Videos are not supported as content blocks by the Claude API; they are
  // referenced as text (path) so the sub-agent knows a video exists on disk.
  const useStreamJsonInput = imagePaths.length > 0 || videoPaths.length > 0;

  const args = [
    '--print',
    ...(useStreamJsonInput ? [] : [prompt]),  // prompt as positional arg in text-only mode
    '--output-format', 'stream-json',
    '--verbose',                              // required with stream-json
    '--include-partial-messages',
    '--allowed-tools', tools,
    '--model', model,
    '--setting-sources', 'project,local',     // skip global user settings
    '--strict-mcp-config',                    // no MCP servers
    '--disable-slash-commands',               // no skills leaking in
  ];
  if (useStreamJsonInput) args.push('--input-format', 'stream-json');
  if (sessionId) args.push('--resume', sessionId);

  // CLAUDE_BIN env opt-in: when set, spawn that binary instead of `claude`.
  // Used by Phase 4.B/4.C harness to swap in the deterministic fake_claude
  // stub. If the value ends in `.mjs` or `.js`, prepend node so the file
  // runs without needing a #! shebang on Windows.
  //
  // Path resolution fallback: when server.js runs as a Windows service under
  // LocalSystem, the user-level PATH is NOT inherited and `spawn('claude',
  // ...)` fails with ENOENT (-4058) — observed 2026-05-13 after NSSM install.
  // We probe a list of well-known install paths and pick the first that exists.
  function resolveClaudeBin() {
    const fromEnv = process.env.CLAUDE_BIN;
    if (fromEnv) return fromEnv;
    if (process.platform !== 'win32') return 'claude';
    // Under LocalSystem (Windows service), USERPROFILE points at the system
    // profile, not the human user — so the env-derived candidates miss the
    // real install location. We also probe every C:\Users\<name>\.local\bin\
    // so the service works regardless of which user installed claude.
    const candidates = [];
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) {
      candidates.push(
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, '.local', 'bin', 'claude.cmd'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      );
    }
    // Scan C:\Users\*\.local\bin\claude.exe so service contexts find it too.
    try {
      for (const u of fs.readdirSync('C:\\Users', { withFileTypes: true })) {
        if (!u.isDirectory()) continue;
        if (u.name === 'Public' || u.name === 'Default' || u.name.startsWith('All ')) continue;
        candidates.push(
          `C:\\Users\\${u.name}\\.local\\bin\\claude.exe`,
          `C:\\Users\\${u.name}\\.local\\bin\\claude.cmd`,
        );
      }
    } catch {}
    candidates.push('C:\\Program Files\\Claude\\claude.exe');
    for (const c of candidates) {
      try { if (fs.statSync(c).isFile()) return c; } catch {}
    }
    return 'claude';  // last resort — PATH lookup
  }
  const claudeBin = resolveClaudeBin();
  let spawnCmd, spawnArgs;
  if (claudeBin && /\.(mjs|js|cjs)$/i.test(claudeBin)) {
    spawnCmd  = process.execPath;
    spawnArgs = [claudeBin, ...args];
  } else {
    spawnCmd  = claudeBin;
    spawnArgs = args;
  }
  const child = spawn(spawnCmd, spawnArgs, {
    cwd: project.path,      // project CLAUDE.md and .claude/ load from here
    env,
    stdio: [useStreamJsonInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });

  // Record the claude child PID so fleet-status.mjs can check if a stalled
  // turn's process is still alive. Removed on clean exit below.
  try { fs.writeFileSync(pidPath, String(child.pid)); } catch {}

  // ---------- event parsing → session sidecar + instrumentation --------------
  //
  // Patch 1.1: line-splitter accepts both `\n` and `\r\n` endings (the previous
  // version split only on `\n`, so any chunk delivering a CRLF-ended line left
  // a trailing `\r` that broke JSON.parse silently — observed events lost).
  //
  // Patch 1.2: the `'data'` handler MUST be O(1). It only appends bytes to the
  // log stream and pushes complete lines into an in-memory queue; a separate
  // drainer scheduled on `setImmediate` does the JSON.parse work. This decouples
  // child stdout flow from the cost of parsing, so a slow consumer (heavy line)
  // can never fill the OS pipe buffer and stall the child.
  //
  // Patch 1.7 (dispatch side): note the wall-clock timestamp of the first
  // stream-json event and the eventual `result`. These are appended to the
  // instrumentation log on lifecycle close so server-side reporting can
  // compute first_event_ms / turn_total_ms without parsing the full log.

  let newSessionId        = null;
  let stdoutTail          = '';
  let firstEventAtMs      = null;
  let resultAtMs          = null;
  let tokensInputCached   = null;
  let tokensOutputCached  = null;
  const dispatchStartedAt = Date.now();

  // ---------- session-limit watch (failover trigger) -------------------------
  //
  // We only ever act on this if the turn ALSO failed (non-zero exit or an
  // error result). That conjunction is what keeps a musician who merely
  // *writes about* rate limits from triggering a spurious failover.

  let limitDetected = false;
  let limitResetAt  = null;
  let limitEvidence = '';
  let resultIsError = false;
  let stderrTail    = '';

  /** Record the first credible limit sighting; later ones can't override it. */
  function noteLimitEvidence(text) {
    if (limitDetected || typeof text !== 'string' || !text) return;
    if (!detectClaudeLimit(text)) return;
    limitDetected = true;
    limitEvidence = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    limitResetAt  = parseResetTime(text);
  }

  const lineQueue = [];
  let drainerScheduled = false;

  function scheduleDrain() {
    if (drainerScheduled) return;
    drainerScheduled = true;
    setImmediate(processLineQueue);
  }

  function processLineQueue() {
    drainerScheduled = false;
    // Cap work per tick so a giant burst doesn't starve the event loop.
    // 256 lines/tick is generous; the tail of the queue picks up next tick.
    let budget = 256;
    while (lineQueue.length && budget-- > 0) {
      const line = lineQueue.shift();
      if (!line || !line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (firstEventAtMs == null) firstEventAtMs = Date.now();
      if (!newSessionId && typeof ev.session_id === 'string' && ev.session_id.length > 0) {
        newSessionId = ev.session_id;
        try { fs.writeFileSync(sessionPath, newSessionId); } catch {}
      }
      if (ev.type === 'result') {
        resultAtMs = Date.now();
        if (ev.is_error || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'))) {
          resultIsError = true;
        }
        // Authoritative fields only — never tool_result payloads, which can
        // legitimately contain the words "rate limit" from a file the agent read.
        noteLimitEvidence(typeof ev.result === 'string' ? ev.result : '');
        noteLimitEvidence(typeof ev.subtype === 'string' ? ev.subtype : '');
        noteLimitEvidence(typeof ev.error === 'string' ? ev.error : (ev.error?.message || ''));
        const u = ev.usage || ev.message?.usage;
        if (u) {
          if (typeof u.input_tokens  === 'number') tokensInputCached  = u.input_tokens;
          if (typeof u.output_tokens === 'number') tokensOutputCached = u.output_tokens;
        }
      } else if (ev.type === 'assistant') {
        // The CLI often surfaces the limit notice as the final assistant text.
        for (const b of ev.message?.content || []) {
          if (b?.type === 'text') noteLimitEvidence(b.text);
        }
      }
    }
    if (lineQueue.length) scheduleDrain();
  }

  child.stdout.on('data', (chunk) => {
    // O(1): append bytes to log + line buffer, defer parse work.
    logStream.write(chunk);
    stdoutTail += chunk.toString('utf8');
    const lines = stdoutTail.split(/\r?\n/);   // Patch 1.1: CRLF-tolerant
    stdoutTail = lines.pop() ?? '';
    if (lines.length) {
      for (const l of lines) lineQueue.push(l);
      scheduleDrain();
    }
  });

  child.stderr.on('data', (chunk) => {
    logStream.write(chunk);
    process.stderr.write(chunk);
    // A bare CLI failure (limit hit before any stream-json event) shows up
    // only here. Keep a bounded tail — stderr can be large on a crash loop.
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192);
    noteLimitEvidence(stderrTail);
  });

  child.on('error', (err) => {
    console.error(`[dispatch] spawn error: ${err.message}`);
  });

  // Patch 1.4: idempotent lifecycle teardown. Both `exit` and `close` may fire
  // (in either order, both with reasonable timing); this guarantees we do the
  // flush + sidecar cleanup exactly once.
  let lifecycleClosed = false;
  function lifecycleEnd(code, signal) {
    if (lifecycleClosed) return;
    lifecycleClosed = true;
    // Drain any pending queued lines before we shut the log so we don't lose
    // a final `result` observation (which may carry the limit message).
    try { processLineQueue(); } catch {}

    // Did this turn die because the Claude account is exhausted? Requires
    // BOTH a limit message and an actual failure — see noteLimitEvidence.
    const turnFailed  = (code !== 0 && code !== null) || !!signal || resultIsError;
    const doFailover  = limitDetected && turnFailed;

    // On failover the codex leg keeps writing to this same stream, so the
    // close is deferred to finishCodex (via endLogAndExit).
    try { fs.unlinkSync(pidPath); } catch {}
    // Patch 1.7: append the instrumentation record. Best-effort; never blocks
    // exit and never throws. The trace id, interrupt flag, and time-since-last
    // are propagated from server.js via env vars so each line is self-contained.
    try {
      const instrPath = path.join(LOGS, `instrumentation-${new Date().toISOString().slice(0, 10)}.ndjson`);
      const turnTotalMs = resultAtMs ? (resultAtMs - dispatchStartedAt) : null;
      const firstEventMs = firstEventAtMs ? (firstEventAtMs - dispatchStartedAt) : null;
      const tslRaw = process.env.DISPATCH_TIME_SINCE_LAST_MS;
      const timeSinceLastMs = tslRaw ? Number(tslRaw) : null;
      const record = {
        ts: new Date().toISOString(),
        trace_id: process.env.DISPATCH_TRACE_ID || null,
        project: projectName,
        pid: child.pid,
        dispatch_started_at: new Date(dispatchStartedAt).toISOString(),
        first_event_ms: firstEventMs,
        turn_total_ms: turnTotalMs,
        tokens_input:  tokensInputCached,
        tokens_output: tokensOutputCached,
        interrupt_requested: process.env.DISPATCH_INTERRUPTED === '1',
        time_since_last_dispatch_ms: Number.isFinite(timeSinceLastMs) ? timeSinceLastMs : null,
        exit_code: code ?? null,
        exit_signal: signal ?? null,
        claude_limited: doFailover || undefined,
      };
      fs.appendFileSync(instrPath, JSON.stringify(record) + '\n');
    } catch {}

    // ---------- FAILOVER HANDOFF -------------------------------------------
    //
    // Claude is out of budget. Persist the fleet-wide flag so every OTHER
    // project short-circuits straight to codex from now until reset, then
    // replay THIS turn's original prompt through codex. `prompt` still holds
    // it (callback instruction included) — that is why we keep it around.
    if (doFailover) {
      const until = writeClaudeLimitFlag(limitResetAt);
      if (NO_FAILOVER) {
        console.error(`[NO-FAILOVER] Claude limited until ${until.toISOString()} — model switch DISABLED (logs/no-failover). Turn stops; resume on Claude after reset.`);
        try { logStream.write(JSON.stringify({ type:'system', subtype:'limited-no-failover', reason:'claude_session_limit', limited_until: until.toISOString(), timestamp:new Date().toISOString() }) + '\n'); } catch {}
        endLogAndExit(1);
        return;
      }
      console.error(`[FAILOVER] Claude limited until ${until.toISOString()}, routing ${projectName} -> NVIDIA cascade`);
      if (!limitResetAt) {
        console.error(`[FAILOVER] reset time not parseable from the limit message — assuming +60 min (conservative fallback)`);
      }
      console.error(`[FAILOVER] evidence: ${limitEvidence}`);
      try {
        logStream.write(JSON.stringify({
          type: 'system', subtype: 'failover',
          from: 'claude', to: 'nvidia-cascade',
          reason: 'claude_session_limit',
          limited_until: until.toISOString(),
          reset_parsed: !!limitResetAt,
          evidence: limitEvidence,
          timestamp: new Date().toISOString(),
        }) + '\n');
      } catch {}
      // NVIDIA cascade is the failover leg; it falls through to codex only as a
      // last resort. Either way it always terminates the process.
      runNvidiaFailover();
      return;
    }

    if (signal) {
      console.error(`[dispatch] sub-agent killed by ${signal}`);
      endLogAndExit(128);
      return;
    }
    endLogAndExit(code ?? 1);
  }

  child.on('exit', (code, signal) => lifecycleEnd(code, signal));
  child.on('close', (code, signal) => lifecycleEnd(code, signal));

  // ---------- stream-json stdin (images) --------------------------------------

  if (useStreamJsonInput) {
    // Build a user message with image content blocks followed by the text prompt.
    // Videos cannot be sent as content blocks (Claude API limitation); they are
    // referenced by path in a text block so the sub-agent knows they exist.
    const EXT_TO_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const content = [];
    for (const imgPath of imagePaths) {
      const ext = path.extname(imgPath).slice(1).toLowerCase();
      const mediaType = EXT_TO_MIME[ext] || 'image/png';
      const data = fs.readFileSync(imgPath).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    }
    for (const vidPath of videoPaths) {
      content.push({ type: 'text', text: `[Vidéo jointe — disponible sur le disque : ${vidPath}]\nNote : l'API Claude ne prend pas en charge les vidéos en entrée. Tu ne peux pas visionner cette vidéo, mais tu peux en tenir compte dans ta réponse si le contexte le demande.` });
    }
    if (prompt.trim()) content.push({ type: 'text', text: prompt });
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
    child.stdin.end(msg + '\n');
  }

} // end runClaude

// ============================================================================
// PROVIDER DISPATCH — startup short-circuit
// ============================================================================
//
// Runs at the very start of every dispatch. Three outcomes, all deterministic:
//   • project is configured for codex        → codex, no failover logic at all
//   • Claude flagged limited and not expired → NVIDIA cascade (skip Claude)
//   • otherwise                              → Claude, nominal path untouched
//
// readClaudeLimitFlag() deletes an expired flag as a side effect, so the
// third case is also the automatic return to Claude at reset time.

if (provider === 'codex') {
  runCodex(false);
} else {
  const limitedUntil = readClaudeLimitFlag();
  if (limitedUntil && NO_FAILOVER) {
    console.error(`[NO-FAILOVER] Claude limited until ${limitedUntil.toISOString()} — skipping dispatch (no model switch).`);
    try { logStream.write(JSON.stringify({ type:'system', subtype:'limited-no-failover', reason:'claude_session_limit_active', limited_until: limitedUntil.toISOString(), timestamp:new Date().toISOString() }) + '\n'); } catch {}
    endLogAndExit(1);
  } else if (limitedUntil) {
    console.error(`[FAILOVER] Claude limited until ${limitedUntil.toISOString()}, routing ${projectName} -> NVIDIA cascade`);
    try {
      logStream.write(JSON.stringify({
        type: 'system', subtype: 'failover',
        from: 'claude', to: 'nvidia-cascade',
        reason: 'claude_session_limit_active',
        limited_until: limitedUntil.toISOString(),
        timestamp: new Date().toISOString(),
      }) + '\n');
    } catch {}
    runNvidiaFailover();
  } else {
    runClaude();
  }
}
