// ============================================================================
// Claude Code Orchestrator — server.js
// ============================================================================
//
// Single Node.js process. Bridges a central `claude` session to the browser
// via WebSocket (node-pty), and tails per-project stream-json log files to
// the browser via SSE (chokidar). Token-gated, dual-bound to loopback +
// Tailscale.
//
// Verified CLI flags (ran `claude --help`, 2026-04-19):
//   -p / --print                    one-shot mode
//   --resume <sid>                  resume a session by id
//   --session-id <uuid>             force a specific session id
//   --output-format stream-json     JSONL events on stdout
//   --include-partial-messages      token-level streaming (requires --print
//                                   + stream-json)
//   --allowed-tools <tools>         kebab-case is canonical; --allowedTools
//                                   is accepted as an alias
//   --model <name>                  per-invocation model override
//   --setting-sources <sources>     comma-separated: user,project,local
//   --strict-mcp-config             only use MCP from --mcp-config
//   --disable-slash-commands        skip all skills
//   --bare                          NOT USED — see note below
//   (no --cwd flag exists; spawn with child_process cwd option instead)
//
// Note on --bare vs subscription auth (brief decision #4 vs user decision #10):
// `--bare` is documented as "Anthropic auth is strictly ANTHROPIC_API_KEY or
// apiKeyHelper (OAuth and keychain are never read)". We cannot both use
// --bare AND preserve OAuth subscription billing. Resolution (precedence:
// user decisions > brief): keep OAuth, drop --bare, and approximate the
// isolation intent with --setting-sources project,local + --strict-mcp-config
// + --disable-slash-commands. Project CLAUDE.md and project .claude/ still
// load naturally from the spawn cwd. See CLAUDE.md for full reasoning.
// ============================================================================

// CRITICAL: scrub ANTHROPIC_API_KEY from our own env before anything spawns.
// Any child we launch (central pty, dispatch script) inherits this env.
delete process.env.ANTHROPIC_API_KEY;

import { createServer as createHttpServer } from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
// v5 integration: !interrupt override detection in the dispatch hot path.
// Full three-state route() with classifier is intentionally NOT called
// inline because the Haiku call adds 5-30 s latency; that integration is
// deferred to a feature-flagged path. detectOverride is pure & fast.
import { detectOverride } from './src/message_router.mjs';
// Shared fleet state/silence/stall derivation — same module the CLI supervisor
// (scripts/fleet-status.mjs) uses, so the live desk view (/api/pupitre) can
// never diverge from `node scripts/fleet-status.mjs`.
import { scanProject as scanFleetMember, isPhantomResult, isQuestionResolved, isAcknowledged, isConductorStop, stopInfo, createJournal } from './scripts/fleet-status-core.mjs';
// Registre /downloads relu à chaud depuis downloads.json (0.23.0).
import { createDownloadsRegistry, VERSION_NAME_RE } from './scripts/downloads-registry.mjs';
import { trustWorkspace } from './scripts/workspace-trust.mjs';
// Vue « Models par tâche » (0.39.0) : catalogue + model-routing.json.
import { createModelRouting } from './scripts/model-routing.mjs';
// Pipelines, phase 1 (0.41.0) : chaque entrée est classée et journalisée, sans effet.
import { createObserver, TerminalLineBuffer, ENTRY_KINDS } from './scripts/pipeline-observe.mjs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import express from 'express';
import expressWs from 'express-ws';
import chokidar from 'chokidar';
import * as pty from 'node-pty';
import { startSshServer } from './ssh-server.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PORT       = 7777;
const LOGS_DIR        = path.join(__dirname, 'logs');
const CENTRAL_LOG     = path.join(LOGS_DIR, 'central.log');
const CRASH_LOG       = path.join(LOGS_DIR, 'server-crash.log');
const TOKEN_PATH      = path.join(__dirname, '.token');
const CONFIG_PATH     = path.join(__dirname, 'config.json');
const ATTACHMENTS_DIR = path.join(__dirname, 'attachments');
const BUILDS_DIR      = path.join(__dirname, 'builds');
const SECRETS_DIR     = path.join(__dirname, 'secrets');
const PKG_VERSION     = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
// Pipelines, phase 1 (observation) : créé avant tout ce qui peut lancer un tour
// au démarrage (réveil réhydraté, file, pool).
const pipelineObserver = createObserver({ logsDir: LOGS_DIR });
const OBS_ID_RE = /^obs-[a-z0-9-]{4,40}$/;
// Outils d'un musicien quand config.json n'a pas de defaults.allowedTools.
// Règle utilisateur (0.28.0) : « tous les projets doivent avoir droit au web et
// à la lecture » — même liste que defaults.allowedTools et dispatch.mjs.
const FALLBACK_TOOLS  = 'Read,Edit,Write,Bash,WebFetch,WebSearch,Grep,Glob';

fs.mkdirSync(LOGS_DIR,        { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR,      { recursive: true });
fs.mkdirSync(SECRETS_DIR,     { recursive: true });

// ---------- Crash & lifecycle diagnostics ----------------------------------
//
// Server.out historically captured only the boot banner — when the process
// died we had no idea why (uncaught throw, unhandled rejection, or
// external SIGTERM all looked identical). Everything below writes
// SYNCHRONOUSLY to logs/server-crash.log so even a crash mid-write leaves
// a usable trace, and is also mirrored to stderr/server.out.

function crashLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(CRASH_LOG, stamped); } catch {}
  try { process.stderr.write(stamped); } catch {}
}

// Verbose runtime tracing — separate file so the crash log keeps the
// signal/lifecycle events readable, while debug.log catches per-request,
// per-SSE-client, per-watcher detail. Append-synchronous so a crash mid-
// write still leaves an actionable last line.
const DEBUG_LOG = path.join(LOGS_DIR, 'server-debug.log');
function debugLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(DEBUG_LOG, stamped); } catch {}
}
debugLog(`==== boot pid=${process.pid} ====`);

crashLog(`==== boot pid=${process.pid} node=${process.version} platform=${process.platform} ====`);

process.on('uncaughtException', (err, origin) => {
  crashLog(`UNCAUGHT EXCEPTION (origin=${origin}): ${err && err.stack || err}`);
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] UNCAUGHT ${err && err.stack || err}\n`); } catch {}
  // A failed bind leaves the process alive but useless — never survive it.
  // Scoped to the dashboard port so an SFTP bind failure doesn't take it down.
  if (err && err.syscall === 'listen' && err.port === PORT && !httpServer.listening) process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  const r = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  crashLog(`UNHANDLED REJECTION: ${r}`);
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] UNHANDLED_REJECTION ${r}\n`); } catch {}
});
// 'warning' often signals a file-descriptor / listener leak before the
// process actually dies — invaluable for "fell over silently" cases.
process.on('warning', (warn) => {
  crashLog(`WARNING ${warn.name}: ${warn.message}\n${warn.stack || ''}`);
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  // SIGBREAK + SIGHUP only exist on some platforms — guard with try.
  try {
    process.on(sig, () => {
      crashLog(`signal received: ${sig} — exiting cleanly`);
      // Give the log a tick to flush, then exit non-zero so a supervisor
      // can distinguish from clean shutdown.
      setTimeout(() => process.exit(143), 50);
    });
  } catch {}
}
process.on('beforeExit', (code) => crashLog(`beforeExit code=${code} — event loop empty`));
process.on('exit', (code) => crashLog(`exit code=${code}`));

// Heartbeat — appended every 60s. If server-crash.log shows a sequence of
// heartbeats that stops abruptly without an exit/signal/exception trace
// after, the kill came from outside Node's reach (SIGKILL, Defender, OOM,
// hidden PowerShell window closed). Wide gap between heartbeats with no
// corresponding boot line in between = OS suspended the process (sleep/
// hibernate). Memory drift across heartbeats = likely leak.
function startHeartbeat() {
  const startedAt = Date.now();
  setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const uptimeS = Math.round((Date.now() - startedAt) / 1000);
      const rssMb = Math.round(mem.rss / 1048576);
      const heapMb = Math.round(mem.heapUsed / 1048576);
      crashLog(`heartbeat uptime=${uptimeS}s rss=${rssMb}mb heap=${heapMb}mb sse=${SSE_CLIENT_COUNT} pid=${process.pid}`);
    } catch (e) {
      // Heartbeat must never crash the server.
      try { process.stderr.write(`heartbeat error: ${e.message}\n`); } catch {}
    }
  }, 60_000).unref(); // unref so a stuck heartbeat doesn't keep the loop alive on intentional shutdown
}

// Counter maintained by the SSE handler — published in heartbeats so we
// can correlate "many clients connecting/dropping" with crashes.
let SSE_CLIENT_COUNT = 0;

startHeartbeat();

// ---------- Config ----------------------------------------------------------

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`[orchestrator] missing ${CONFIG_PATH}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

if (!config.projects || !Array.isArray(config.projects)) {
  console.error('[orchestrator] config.projects must be an array');
  process.exit(1);
}

const PROJECT_NAMES = new Set(config.projects.map(p => p.name));

// ---------- Token -----------------------------------------------------------

function loadOrCreateToken() {
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch { /* falls through to create */ }
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, t, { mode: 0o600 });
  return t;
}
const TOKEN = loadOrCreateToken();

// Token gate DISABLED 2026-09-07 per explicit user decision: the fleet is
// reached only over Tailscale (WireGuard provides the confidentiality +
// network-level access control), and the Android companion no longer carries a
// token at all. Flip back to `true` to re-enable the gate if the server is ever
// exposed on an untrusted network. When false, wsVerifyClient / the HTTP gate /
// the pty-WS token check all short-circuit to "accept". The `.token` file is
// still generated and the tokenized URLs still work — the token is simply not
// required.
const TOKEN_GATE_ENABLED = false;

function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

// Lightweight cookie-header parser — reads a single named cookie. We avoid
// the `cookie-parser` dep since we only ever read one cookie and set one.
const COOKIE_NAME = 'orch_tok';
function parseCookieToken(cookieHeader) {
  if (!cookieHeader) return null;
  const re = new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)');
  const m = re.exec(cookieHeader);
  return m ? decodeURIComponent(m[1]) : null;
}

// ---------- Interface allowlist (Tailscale + loopback) ----------------------

function detectTailscaleIPv4() {
  // Try PATH-lookup first (works when launched from a shell with full env).
  // Then fall back to the canonical Windows install path — when the server
  // is launched via `cmd /c start /B` the spawned env can omit user-level
  // PATH additions, and `tailscale` won't be on PATH. Without this fallback
  // the Tailscale-interface allowlist stays empty and EVERY request from
  // the Tailscale IP gets a 403 (seen 2026-05-13).
  const candidates = [
    'tailscale',
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  ];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['ip', '-4'], {
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
      const ip = out.trim().split(/\r?\n/)[0];
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch { /* try next candidate */ }
  }
  return null;
}

const TAILSCALE_IP = detectTailscaleIPv4();

const ALLOWED_LOCAL_ADDRS = new Set(['127.0.0.1', '::1']);
if (TAILSCALE_IP) ALLOWED_LOCAL_ADDRS.add(TAILSCALE_IP);

function normalizeAddr(addr) {
  if (!addr) return '';
  if (addr.startsWith('::ffff:')) return addr.slice(7);
  return addr;
}

// ---------- Session sidecars ------------------------------------------------

const sessions = new Map(); // projectName -> session_id

function sessionFilePath(name) { return path.join(LOGS_DIR, `${name}.session`); }

function loadAllSessions() {
  for (const p of config.projects) {
    const fp = sessionFilePath(p.name);
    try {
      const sid = fs.readFileSync(fp, 'utf8').trim();
      if (sid) sessions.set(p.name, sid);
    } catch { /* no sidecar yet */ }
  }
}
loadAllSessions();

// Per-musician state tracker for the auto-notify pump (see attachProject).
// Server-global so multiple concurrent SSE connections don't double-fire.
const musicianAutoStates = new Map();

// ── Per-musician direct-dispatch queue ────────────────────────────────────────
// When an explicit "@musician <text>" message arrives and the musician is busy
// (live/think), the stripped prompt is queued here instead of going to the
// conductor. When the musician finishes its turn the next item is auto-dispatched.
//
// Patch 1.5: every mutation is mirrored to a sidecar file under logs/queue/
// via atomic write-then-rename. On boot, loadQueuesFromDisk() rehydrates the
// in-memory Map BEFORE any new dispatch is accepted, so a SIGKILL between
// push and drainQueue cannot lose turns.
//
// 0.24.0 — chaque entrée porte un `id` stable et un `enqueuedAt`, et la file se
// gère par l'API (GET/DELETE /api/queue/:project, `scripts/queue.mjs`), JAMAIS
// en éditant le sidecar : la mémoire est la source de vérité et réécrit le
// fichier à chaque mutation, donc une retouche à la main était écrasée — des
// tâches déjà faites « revenaient » en tête (TranslateOverlay, 25/09/2026).
const dispatchQueue = new Map(); // projectName → [{id, enqueuedAt, prompt, attachmentPaths, videoPaths, callback?, source?, model?, provider?, slot?, ticket?}]

const QUEUE_DIR = path.join(LOGS_DIR, 'queue');
try { fs.mkdirSync(QUEUE_DIR, { recursive: true }); } catch {}

function newQueueEntryId() {
  return `q-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Le seul point d'entrée dans une file par musicien : l'id naît ici. */
function queuePush(name, entry) {
  const q = dispatchQueue.get(name) ?? [];
  q.push({ id: newQueueEntryId(), enqueuedAt: new Date().toISOString(), ...entry });
  dispatchQueue.set(name, q);
  persistQueue(name);
  return q.length;
}

function queueRemove(name, id) {
  const q = dispatchQueue.get(name);
  const i = q ? q.findIndex(e => e.id === id) : -1;
  if (i < 0) return null;
  const [removed] = q.splice(i, 1);
  if (!q.length) dispatchQueue.delete(name);
  persistQueue(name);
  return removed;
}

function queueClear(name) {
  const n = dispatchQueue.get(name)?.length ?? 0;
  dispatchQueue.delete(name);
  persistQueue(name);
  return n;
}

/** Vue publique d'une entrée : ce qu'il faut pour décider de la retirer, sans
 *  renvoyer des prompts de plusieurs Kio à chaque liste. */
function queueEntryView(e, i) {
  const text = String(e.prompt || '').replace(/\s+/g, ' ').trim();
  return {
    id: e.id, position: i + 1,
    head: text.slice(0, 200) + (text.length > 200 ? '…' : ''),
    enqueuedAt: e.enqueuedAt || null,
    model: e.model || null, provider: e.provider || null,
    callback: e.callback || null, source: e.source || null,
    attachments: (e.attachmentPaths?.length || 0) + (e.videoPaths?.length || 0),
    newSession: !!e.newSession,
  };
}

function queueSidecarPath(name) {
  return path.join(QUEUE_DIR, `${name}.json`);
}

function persistQueue(name) {
  const q = dispatchQueue.get(name);
  const file = queueSidecarPath(name);
  if (!q || q.length === 0) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(q));
    fs.renameSync(tmp, file);
  } catch (e) {
    debugLog(`persistQueue ${name} failed: ${e.message}`);
  }
}

function loadQueuesFromDisk() {
  let entries;
  try { entries = fs.readdirSync(QUEUE_DIR); } catch { return; }
  for (const fname of entries) {
    if (!fname.endsWith('.json')) continue;
    const name = fname.slice(0, -5);
    // `logs/queue/` n'héberge pas que des files par musicien : `chef.pool.json`
    // et `chef.wake.json` y vivent aussi, et leur basename (`chef.pool`) n'est
    // évidemment aucun projet. Le point est donc réservé : ce balayage ne
    // touche qu'à `<projet>.json`. Sans cette garde il détruisait les deux
    // sidecars à chaque boot — avant même que leurs loaders ne les lisent, donc
    // sans une ligne de journal (24/09/2026 : un ticket en vol évaporé).
    if (name.includes('.')) continue;
    if (!config.projects.find(p => p.name === name)) {
      // Project no longer in config — stale sidecar, drop it.
      try { fs.unlinkSync(path.join(QUEUE_DIR, fname)); } catch {}
      continue;
    }
    try {
      const raw = fs.readFileSync(path.join(QUEUE_DIR, fname), 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        // Migration (0.24.0) : les entrées d'avant n'ont pas d'id. On leur en
        // donne un UNE fois, persisté aussitôt, pour qu'il reste stable d'un
        // boot à l'autre. Ordre et contenu inchangés.
        let migrated = 0;
        const mtime = fs.statSync(path.join(QUEUE_DIR, fname)).mtime.toISOString();
        for (const e of arr) {
          if (e && typeof e === 'object' && !e.id) { e.id = newQueueEntryId(); e.enqueuedAt ??= mtime; migrated++; }
        }
        dispatchQueue.set(name, arr);
        if (migrated) persistQueue(name);
        debugLog(`queue rehydrate ${name} (${arr.length} pending${migrated ? `, ${migrated} id(s) attribué(s)` : ''})`);
      }
    } catch (e) {
      debugLog(`queue rehydrate ${name} failed: ${e.message}`);
    }
  }
}
loadQueuesFromDisk();

// Patch 1.7: per-project lastDispatchAt for time_since_last_dispatch_ms.
const lastDispatchAt = new Map();

function conductorName() { return config.conductor || 'chef'; }

// ---------- Callback wake: the chef keeps its promise ------------------------
//
// When the chef dispatches with `--callback chef` it is telling the user "I'll
// report back when this lands". Until 0.20.0 nothing recorded that expectation,
// so the chef was never re-invoked and the promised report never came: the user
// sat on "je te fais le point…" until they typed again.
//
// v0.14.3 removed an earlier auto-wake for good reasons — it fired on EVERY
// musician completion, fed the raw callback text in as a fake *user* prompt, and
// replayed stale callbacks from the persisted queue on restart. This is the
// narrow version of that idea, and every guard below answers one of those
// failures:
//   selectivity  — only a REAL result of a turn that was explicitly awaited
//   coalescence  — one synthesis per batch, never one turn per result
//   generation   — a wake-born turn can wake at most once more, then stops
//   no interrupt — a busy chef is never killed; we fire when it goes idle
//   budget       — min interval + hourly ceiling + never under a Claude limit
//   idempotence  — per-result dedup keys, persisted, so a restart cannot replay
//
// Nothing here ever dispatches a musician; it only asks the chef to speak.
const WAKE_COALESCE_MS    = 10_000;   // quiet window after the last result
const WAKE_LOT_MAX_MS     = 90_000;   // hard cap on how long a batch may gather
const WAKE_MIN_INTERVAL_MS = 60_000;  // floor between two wakes
const WAKE_MAX_PER_HOUR   = 6;
// user → wake 1 → wake 2 → wake 3 (assez pour crash → fix → feature → push),
// puis un DERNIER réveil en mode « rapport seul » (voir wakeIsReportOnly).
// Au-delà de cette borne on ne coupe plus la chaîne en silence : jusqu'à 0.23.0
// un résultat attendu né d'un tour gen=MAX était jeté, et l'utilisateur ne le
// voyait qu'en relançant le chef à la main (TranslateOverlay, 25/09/2026).
const WAKE_MAX_GEN        = 3;
const WAKE_INFLIGHT_MAX_MS = 15 * 60_000;  // safety release if no chef result
const WAKE_ITEM_TTL_MS    = 6 * 60 * 60_000;  // a promise older than this is moot
const WAKE_PENDING_MAX    = 20;
const WAKE_SIDECAR  = path.join(QUEUE_DIR, 'chef.wake.json');
const WAKE_JOURNAL  = path.join(LOGS_DIR, 'chef.wake-log.ndjson');

const wake = {
  pending: [],       // [{ key, source, outcome, summary, durationMs, costUsd, awaitingChef, wakeGen, ts }]
  seen: new Set(),   // dedup keys of results already accounted for
  firstAt: 0,        // when the current batch started gathering
  timer: null,
  inFlight: false,
  inFlightAt: 0,
  lastFireAt: 0,
  fireTimes: [],     // rolling one-hour window of fire timestamps
};

function persistWake() {
  try {
    const payload = JSON.stringify({
      pending: wake.pending,
      seen: [...wake.seen].slice(-200),
      lastFireAt: wake.lastFireAt,
      fireTimes: wake.fireTimes,
    });
    const tmp = WAKE_SIDECAR + '.tmp';
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, WAKE_SIDECAR);
  } catch (e) {
    debugLog(`persistWake failed: ${e.message}`);
  }
}

function loadWakeFromDisk() {
  let raw;
  try { raw = fs.readFileSync(WAKE_SIDECAR, 'utf8'); } catch { return; }
  try {
    const o = JSON.parse(raw);
    const now = Date.now();
    // A restart must NOT replay history (the v0.14.3 failure). We rehydrate only
    // what was still pending, drop anything stale, and cap the batch.
    wake.pending = (Array.isArray(o.pending) ? o.pending : [])
      .filter(it => it && typeof it.source === 'string' && (now - (it.ts || 0)) < WAKE_ITEM_TTL_MS)
      .slice(-WAKE_PENDING_MAX);
    wake.seen = new Set(Array.isArray(o.seen) ? o.seen : []);
    wake.lastFireAt = Number(o.lastFireAt) || 0;
    wake.fireTimes = (Array.isArray(o.fireTimes) ? o.fireTimes : []).filter(t => now - t < 3600_000);
    if (wake.pending.length) {
      wake.firstAt = now;
      debugLog(`wake rehydrate: ${wake.pending.length} pending result(s) — single catch-up armed`);
      armWakeTimer();
    }
  } catch (e) {
    debugLog(`loadWakeFromDisk failed: ${e.message}`);
  }
}

function wakeBudgetOk() {
  const now = Date.now();
  wake.fireTimes = wake.fireTimes.filter(t => now - t < 3600_000);
  if (wake.lastFireAt && now - wake.lastFireAt < WAKE_MIN_INTERVAL_MS) return false;
  return wake.fireTimes.length < WAKE_MAX_PER_HOUR;
}

function armWakeTimer(delayMs = WAKE_COALESCE_MS) {
  if (wake.timer) clearTimeout(wake.timer);
  // Never let a batch gather forever: cap at WAKE_LOT_MAX_MS from its first item.
  const capRemaining = wake.firstAt ? (wake.firstAt + WAKE_LOT_MAX_MS) - Date.now() : delayMs;
  const d = Math.max(250, Math.min(delayMs, Math.max(250, capRemaining)));
  wake.timer = setTimeout(() => { wake.timer = null; tryFireWake(); }, d);
  wake.timer.unref?.();
}

/** Queue one awaited result. Never spawns — the single firing point is below. */
function scheduleConductorWake(item) {
  if (!item || !item.key || wake.seen.has(item.key)) return;
  wake.seen.add(item.key);
  wake.pending.push(item);
  if (wake.pending.length > WAKE_PENDING_MAX) wake.pending.splice(0, wake.pending.length - WAKE_PENDING_MAX);
  if (!wake.firstAt) wake.firstAt = Date.now();
  persistWake();
  console.log(`[wake] queued ${item.source} (${item.outcome}) — batch=${wake.pending.length}`);
  armWakeTimer();
}

/** The user spoke to the chef: its own turn will show the results (the client
 *  basket renders them with "prend en compte"), so a pushed synthesis would be a
 *  paid duplicate. Drop the batch. */
function cancelWakeOnUserPrompt() {
  // 0.22.0 : un lot déjà transformé en TICKET `point` et encore en file est le
  // même doublon payant — il part avec le reste (un ticket ASSIGNED/RUNNING,
  // lui, n'est jamais tué : c'est un tour en cours).
  let withdrawn = 0;
  for (const t of pool.queue.filter(t => t.class === 'point')) {
    if (poolWithdraw(t.id)) withdrawn++;
  }
  if (withdrawn) console.log(`[wake] ${withdrawn} ticket(s) point retiré(s) — l'utilisateur parle au chef`);
  if (!wake.pending.length && !wake.timer) return;
  const n = wake.pending.length;
  wake.pending = [];
  wake.firstAt = 0;
  if (wake.timer) { clearTimeout(wake.timer); wake.timer = null; }
  persistWake();
  if (n) console.log(`[wake] cancelled ${n} pending result(s) — the user is talking to the chef`);
}

function fmtWakeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`;
}

/** Un réveil dont la génération dépasse WAKE_MAX_GEN est en « rapport seul » :
 *  le chef parle (le résultat attendu n'est jamais perdu) mais ne peut plus
 *  rien lancer — `dispatch.mjs` refuse tout dispatch venu de ce tour
 *  (DISPATCH_REPORT_ONLY). Aucun musicien ⇒ aucun résultat ⇒ aucun réveil :
 *  c'est ce qui rend la chaîne finie par construction, et non plus par abandon. */
function wakeIsReportOnly(gen) { return gen > WAKE_MAX_GEN; }

function buildWakePrompt(items, gen, reportOnly = false) {
  const lines = items.map(it => {
    const mark = it.outcome === 'failed' ? '✕' : (it.awaitingChef ? '⇄' : '✓');
    const meta = [fmtWakeAge(it.durationMs), Number.isFinite(it.costUsd) ? `$${it.costUsd.toFixed(2)}` : '']
      .filter(Boolean).join(' · ');
    const head = `— ${it.source} ${mark}${meta ? ' ' + meta : ''}`;
    const body = (it.summary || '').trim();
    return body ? `${head}\n  ${body}` : head;
  }).join('\n');
  if (reportOnly) {
    return (
      `[CALLBACK_WAKE lot=${items.length} gen=${gen} mode=rapport-seul]\n` +
      `Les résultats que tu attendais sont arrivés. Fais le point à l'utilisateur ` +
      `(2–5 puces par musicien, ce qu'il a EFFECTIVEMENT fait ; restitue verbatim toute question).\n` +
      `MODE RAPPORT SEUL : la chaîne de réveils a atteint sa limite (${WAKE_MAX_GEN} relances ` +
      `automatiques). Ne redispatche PAS — tout dispatch.mjs lancé depuis ce tour sera refusé. ` +
      `S'il reste une étape, décris-la et demande à l'utilisateur de la lancer ; puis termine ton tour.\n\n` +
      lines
    );
  }
  return (
    `[CALLBACK_WAKE lot=${items.length} gen=${gen}]\n` +
    `Les résultats que tu attendais sont arrivés. Fais le point à l'utilisateur ` +
    `(2–5 puces par musicien, ce qu'il a EFFECTIVEMENT fait ; restitue verbatim toute question).\n` +
    `Ne redispatche QUE si c'était prévu dans la demande initiale ; sinon termine ton tour.\n\n` +
    lines
  );
}

/** The one and only place a wake is fired. Re-armed rather than forced whenever
 *  a condition is not met, so nothing is ever lost — only deferred. */
function tryFireWake() {
  if (!wake.pending.length) return;

  // Safety release: a chef turn that never produced a result must not wedge the
  // scheduler shut forever.
  if (wake.inFlight && Date.now() - wake.inFlightAt > WAKE_INFLIGHT_MAX_MS) {
    debugLog('[wake] in-flight guard expired — releasing');
    wake.inFlight = false;
  }
  if (wake.inFlight) return;   // the chef's own result will re-trigger us

  // 0.22.0 : plus besoin d'attendre que le chef soit libre — le lot devient un
  // TICKET et l'ordonnanceur le tire quand un slot se libère. Le « jamais
  // d'interruption » de 0.20.0 est désormais structurel, pas conditionnel.

  // Firing into an exhausted quota would just burn a slot on a synthetic result.
  const limited = readLimitedUntil();
  if (limited) { armWakeTimer(30_000); return; }

  if (!wakeBudgetOk()) { armWakeTimer(WAKE_MIN_INTERVAL_MS); return; }

  const items = wake.pending.slice();
  const gen = Math.max(0, ...items.map(it => Number(it.wakeGen) || 0)) + 1;
  wake.pending = [];
  wake.firstAt = 0;
  wake.inFlight = true;
  wake.inFlightAt = Date.now();
  wake.lastFireAt = Date.now();
  wake.fireTimes.push(wake.lastFireAt);
  persistWake();

  // Un lot mêle parfois des générations : la plus haute l'emporte, donc un seul
  // résultat en bout de chaîne suffit à passer tout le lot en rapport seul.
  const reportOnly = wakeIsReportOnly(gen);
  const prompt = buildWakePrompt(items, gen, reportOnly);
  try {
    fs.appendFileSync(WAKE_JOURNAL, JSON.stringify({
      ts: new Date().toISOString(), gen, lot: items.length, reportOnly,
      sources: items.map(it => `${it.source}:${it.outcome}`),
    }) + '\n');
  } catch {}
  const fireMsg = `[wake] firing chef synthesis — lot=${items.length} gen=${gen}` +
    (reportOnly ? ` reportOnly (gen > WAKE_MAX_GEN=${WAKE_MAX_GEN} : dispatch interdit à ce tour)` : '') +
    ` sources=${items.map(it => it.source).join(',')}`;
  console.log(fireMsg);
  debugLog(fireMsg);
  // Le lot n'est plus spawné ici : il entre dans la file comme ticket `point`,
  // servi après les tickets `user`/`decision` (§2.4 du design).
  poolEnqueue({
    obsId: observeEntry({ entry: 'wake', project: conductorName(), text: prompt }),
    class: 'point', text: prompt, source: 'wake', wakeGen: gen, reportOnly,
    displayText: `point sur ${items.length} résultat${items.length > 1 ? 's' : ''} : ` +
      items.map(it => it.source).join(', '),
  });
}

loadWakeFromDisk();

// Spawn a dispatch to a musician directly, bypassing the conductor session.
//
// `opts.source` tags the turn's opening user_prompt (e.g. 'wake'), which makes
// the dashboard treat it as a coordination event rather than a user message.
// `opts.wakeGen` is exported to the child's environment so every dispatch that
// agent launches inherits the wake depth — that is what bounds the wake chain.
// Both are optional: the three pre-existing callers pass neither.
//
// 0.22.0 additions, all optional and backward-compatible:
//   opts.callback  — forwarded as `--callback <p>`. Until now the per-musician
//                    queue LOST it (drainQueue never passed it on), so a turn
//                    that was queued instead of spawned silently stopped being
//                    awaited: no wake, no promised report.
//   opts.model / opts.provider — forwarded as flags rather than a config.json
//                    edit (no concurrent write on a shared file).
//   opts.ticket / opts.slot    — pool stamping; dispatch.mjs copies them onto
//                    the turn's opening user_prompt so the file's status can be
//                    read back from the log rather than guessed.
// ── Pipelines, phase 1 : observation (0.41.0) ────────────────────────────────
// Demande utilisateur : « toute entree dans l'orchestrateur passe par les
// pipelines ». Ici on CLASSE et on JOURNALISE chaque entrée (logs/
// pipeline-observe.ndjson), sans rien changer. L'identifiant suit l'entrée
// jusqu'au tour (ORCH_OBS_ID) pour qu'elle ne soit comptée qu'une fois.
function observeEntry(o) {
  try { return pipelineObserver.record(o).id; }
  catch (e) { debugLog(`[observe] ${e.message}`); return null; }
}
function clientOf(req) {
  return /okhttp|dalvik|android/i.test(req.get('user-agent') || '') ? 'android' : 'dashboard';
}

function spawnDirectDispatch(name, prompt, attachmentPaths = [], videoPaths = [], opts = {}) {
  const dispatchScript = path.join(__dirname, 'scripts', 'dispatch.mjs');
  // Filet de sécurité : un lancement sans observation d'origine est observé ici.
  let obsId = typeof opts.obsId === 'string' && OBS_ID_RE.test(opts.obsId) ? opts.obsId : null;
  if (!obsId) {
    const entry = opts.observeAs || (opts.poolAssign ? 'pool' : opts.noQueueIfBusy ? 'file' : opts.source === 'wake' ? 'wake' : 'spawn');
    obsId = observeEntry({ entry, project: name, text: prompt });
  }
  const hasAny = attachmentPaths.length || videoPaths.length;
  const stdinPayload = hasAny
    ? JSON.stringify({ prompt, attachmentPaths, videoPaths })
    : prompt;
  // Patch 1.7: include the same instrumentation env the POST handler sets,
  // so queue-driven and notify-driven dispatches also produce instrumentation.
  const prevAt = lastDispatchAt.get(name) || null;
  const requestInTs = Date.now();
  const timeSinceLastMs = prevAt ? (requestInTs - prevAt) : null;
  lastDispatchAt.set(name, requestInTs);

  // argv is always an array — never shell-concatenated (project hard rule).
  const args = [dispatchScript, name, '--prompt-stdin'];
  if (typeof opts.source === 'string' && opts.source) args.push('--source', opts.source);
  if (typeof opts.callback === 'string' && opts.callback) args.push('--callback', opts.callback);
  if (typeof opts.model === 'string' && opts.model) args.push('--model', opts.model);
  if (typeof opts.provider === 'string' && opts.provider) args.push('--provider', opts.provider);
  // Le slot voyage aussi par l'env (le `claude` du chef le transmet à son outil
  // Bash, c'est ce qui fait revenir le point au bon chef). Un fils ne peut donc
  // pas distinguer « le serveur me lance pour remplir le slot » de « un chef me
  // lance depuis son tour » sur l'env seul : le flag, lui, ne s'hérite pas.
  if (opts.poolAssign) args.push('--pool-assign');
  // Lancement DEPUIS la file : le serveur vient de vérifier que le musicien est
  // libre. Sans ce flag, un `slot` hérité réactive --queue-if-busy dans le fils,
  // qui se re-postait en file (voir drainAttempt).
  if (opts.noQueueIfBusy) args.push('--no-queue-if-busy');
  // Session neuve demandée (0.27.0) : le flag a voyagé avec l'entrée de file.
  if (opts.newSession) args.push('--new-session');

  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      DISPATCH_TRACE_ID: typeof opts.traceId === 'string' ? opts.traceId : '',
      DISPATCH_INTERRUPTED: '0',
      DISPATCH_TIME_SINCE_LAST_MS: timeSinceLastMs == null ? '' : String(timeSinceLastMs),
      DISPATCH_REQUEST_IN_TS: String(requestInTs),
      // Inherited by the agent's Bash tool → stamped on every dispatch it makes.
      DISPATCH_WAKE_GEN: Number.isFinite(opts.wakeGen) && opts.wakeGen > 0 ? String(opts.wakeGen) : '',
      // Réveil en rapport seul : hérité par l'outil Bash du chef, il fait
      // refuser par dispatch.mjs tout dispatch lancé depuis ce tour. Toujours
      // écrit (vide sinon) pour qu'aucun env parent ne le fasse fuir.
      DISPATCH_REPORT_ONLY: opts.reportOnly ? '1' : '',
      // Pool stamping (0.22.0). Also inherited by the chef's Bash tool, which
      // is how a musician's turn learns WHICH conductor turn is awaiting it.
      DISPATCH_TICKET: typeof opts.ticket === 'string' ? opts.ticket : '',
      DISPATCH_SLOT: Number.isFinite(opts.slot) && opts.slot > 0 ? String(opts.slot) : '',
      ORCH_OBS_ID: obsId || '',
    },
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    detached: false,
  });
  child.on('error', (err) => console.error(`[queue-dispatch] ${name} spawn error: ${err.message}`));
  // Patch 1.4: idempotent lifecycle end logging — both exit and close fire,
  // either order. We don't strictly need the close here (no resources to
  // release on the parent side beyond what node already does), but wiring
  // it makes leak diagnosis trivial and matches the policy.
  let qLifecycleLogged = false;
  const onQLifecycleEnd = (code, signal, ev) => {
    if (qLifecycleLogged) return;
    qLifecycleLogged = true;
    debugLog(`queue-dispatch ${name} pid=${child.pid} ${ev} code=${code} signal=${signal}`);
  };
  child.on('exit',  (code, signal) => onQLifecycleEnd(code, signal, 'exit'));
  child.on('close', (code, signal) => onQLifecycleEnd(code, signal, 'close'));
  child.stdin.end(stdinPayload);
  return child.pid;
}

// Pop one item from a musician's queue and dispatch it.
//
// 0.22.0 fix: a queue entry now carries `callback`, `source`, `model` and
// `provider` and they are all forwarded. Before, the entry held only the prompt
// and its attachments, so a dispatch that was QUEUED (rather than spawned) lost
// its `--callback chef`: the chef kept waiting for a report the musician was
// never told to send. Old entries rehydrated from disk simply have the fields
// undefined and behave exactly as before.
function drainQueue(name, reason = 'result') {
  if (drainPending.has(name)) return;       // un drain attend déjà la fin du processus
  const q = dispatchQueue.get(name);
  if (!q || q.length === 0) { dispatchQueue.delete(name); persistQueue(name); return; }
  drainPending.set(name, Date.now());
  setImmediate(() => drainAttempt(name, reason));
}

// 0.24.1 — POURQUOI ATTENDRE LA MORT DU PROCESSUS. Le drain part sur l'événement
// `result`, qui est écrit AVANT que le `claude` du tour ne se termine : son
// `.pid` est encore vivant. Or une entrée issue d'un chef porte `slot`, donc le
// dispatch.mjs relancé avait DISPATCH_SLOT ⇒ --queue-if-busy actif ⇒ il voyait
// ce PID encore vivant et se RE-POSTAIT en queue de file, avec un nouvel id. La
// tâche tournait en rond sans jamais partir (TranslateOverlay, vuBox, 25/09 :
// « auto-dispatch » immédiatement suivi de « occupé — mis en file »). Désormais
// on attend que le processus soit réellement mort, puis on lance avec
// --no-queue-if-busy : c'est le serveur qui possède la file et qui vient de
// vérifier ; le fils n'a pas à la re-décider.
function drainAttempt(name, reason) {
  const since = drainPending.get(name) ?? Date.now();
  const q = dispatchQueue.get(name);
  if (!q || !q.length) { drainPending.delete(name); return; }    // retirée entre-temps
  if (dispatchPidAlive(name)) {
    if (Date.now() - since < DRAIN_WAIT_MAX_MS) { setTimeout(() => drainAttempt(name, reason), DRAIN_WAIT_STEP_MS).unref?.(); return; }
    drainPending.delete(name);
    const msg = `[queue] ${name} : processus toujours vivant après ${DRAIN_WAIT_MAX_MS / 1000} s — ` +
      `un tour tourne, son result drainera (ou le balayage)`;
    console.log(msg); debugLog(msg);
    return;
  }
  drainPending.delete(name);
  const { id, prompt, attachmentPaths, videoPaths, callback, source, model, provider, slot, ticket, newSession, obsId } = q.shift();
  if (q.length === 0) dispatchQueue.delete(name);
  persistQueue(name);
  drainLaunchedAt.set(name, Date.now());
  const msg = `[queue] auto-dispatch to ${name} (${dispatchQueue.get(name)?.length ?? 0} remaining) ` +
    `id=${id || '—'} via=${reason}` + (callback ? ` callback=${callback}` : '') +
    ` attente-pid=${Date.now() - since}ms`;
  console.log(msg); debugLog(msg);
  spawnDirectDispatch(name, prompt, attachmentPaths, videoPaths,
    { callback, source, model, provider, slot, ticket, newSession, obsId, noQueueIfBusy: true });
}

const DRAIN_WAIT_STEP_MS = 1000;
const DRAIN_WAIT_MAX_MS  = 120_000;
const drainPending   = new Map();   // nom → début de l'attente de la mort du processus
const drainLaunchedAt = new Map();  // nom → dernier lancement depuis la file

// Filet de sécurité : une file non vide devant un musicien libre, sans processus,
// depuis plus d'une minute, est drainée. Couvre ce qu'aucun `result` ne
// déclenchera jamais : la file rehydratée au redémarrage, un tour lancé hors
// serveur dont le result a été manqué, un drain abandonné. Jamais sous limite
// Claude (même raison que la garde B1 sur les result synthétiques).
const QUEUE_SWEEP_MS = 30_000;
const QUEUE_STALL_MS = 60_000;
const queueStalledSince = new Map();
function sweepQueues() {
  if (readLimitedUntil()) return;
  const now = Date.now();
  for (const [name, q] of dispatchQueue) {
    const st = musicianAutoStates.get(name)?.state ?? 'idle';
    const blocked = !q?.length || drainPending.has(name) ||
      now - (drainLaunchedAt.get(name) || 0) < QUEUE_STALL_MS ||
      st === 'live' || st === 'think' || dispatchPidAlive(name);
    if (blocked) { queueStalledSince.delete(name); continue; }
    if (!queueStalledSince.has(name)) { queueStalledSince.set(name, now); continue; }
    if (now - queueStalledSince.get(name) < QUEUE_STALL_MS) continue;
    queueStalledSince.delete(name);
    const msg = `[queue-sweep] ${name} : libre (${st}), aucun processus, ${q.length} en file ` +
      `depuis ≥ ${QUEUE_STALL_MS / 1000} s — drain de secours`;
    console.log(msg); debugLog(msg);
    drainQueue(name, 'sweep');
  }
}
setInterval(sweepQueues, QUEUE_SWEEP_MS).unref();

// ---------- File de direction (pool P0-A, 0.22.0) ---------------------------
//
// Jusqu'à 0.21.3, écrire au chef pendant qu'il travaillait TUAIT son tour
// (`/api/dispatch` → killDispatchTree). L'utilisateur perdait un travail en
// cours qu'il n'avait pas demandé à perdre, et le chef reprenait avec une note
// de reprise plutôt qu'un résultat. Désormais tout ce qui veut faire parler le
// chef — message utilisateur, relais NEEDS_CHEF_INPUT, réveil-callback 0.20.0 —
// devient un TICKET dans une file FIFO persistée, et un ordonnanceur unique la
// draine quand le chef se libère. L'interruption existe toujours, mais c'est un
// GESTE EXPLICITE : `!interrupt`, `force_interrupt:true`, ou
// POST /api/pool/interrupt/:slot.
//
// P0-A n'ouvre PAS la concurrence : `conductorPool.size` est lu mais borné à 1,
// le slot 1 est le chef actuel avec ses fichiers actuels (`logs/chef.*`), rien
// n'est renommé. Le pool de trois chefs (slots `chef-2`, `chef-3`, affinité,
// épinglage, registre de direction, délégation) est P0-B.
//
// Le modèle suit `wake` (0.20.0) : un seul point de tir, ré-armé plutôt que
// forcé, rien n'est perdu — seulement différé.

const POOL_SIDECAR    = path.join(QUEUE_DIR, 'chef.pool.json');
const POOL_JOURNAL    = path.join(LOGS_DIR, 'chef.pool-log.ndjson');
// P0-A : la taille est VERROUILLÉE à 1. Le champ config existe pour que P0-B
// n'ait qu'à relever cette borne, sans changer de schéma.
const POOL_MAX_SIZE   = 1;
// Un slot assigné dont aucun processus ne vit depuis ce délai a perdu son tour.
const POOL_LOST_MS    = 60_000;
// Filet d'ordonnancement : un slot peut se libérer sans qu'aucun événement ne
// nous réveille (kill externe, log muet). On repasse régulièrement.
const POOL_RETRY_MS   = 5_000;
const POOL_MAX_QUEUE  = 100;
const POOL_HEAD_CHARS = 120;

const pool = {
  queue: [],     // tickets QUEUED, du plus ancien au plus récent
  slots: [],     // [{ slot, name, ticket, assignedAt }]
  timer: null,
  timerAt: 0,
  lastResultAt: new Map(),   // nom de slot → ts du dernier result observé
};

function poolSize() {
  const n = Number(config.conductorPool?.size);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(POOL_MAX_SIZE, Math.floor(n));
}
function poolModel() {
  return config.conductorPool?.model
    || config.projects.find(p => p.name === conductorName())?.model
    || config.defaults?.model
    || null;
}
/** Nom de fichiers d'un slot. Le slot 1 EST le chef actuel : aucun renommage,
 *  aucune migration de session. Les alias `chef-N` arrivent en P0-B. */
function poolSlotName(slot) {
  return slot === 1 ? conductorName() : `${conductorName()}-${slot}`;
}

function poolEnsureSlots() {
  const size = poolSize();
  const want = [];
  for (let i = 1; i <= size; i++) {
    const name = poolSlotName(i);
    const prev = pool.slots.find(s => s.slot === i);
    want.push(prev && prev.name === name ? prev : { slot: i, name, ticket: null, assignedAt: 0 });
  }
  pool.slots = want;
  return pool.slots;
}

function poolHead(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, POOL_HEAD_CHARS);
}

function newTicketId() {
  return `m-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
}

function poolJournalWrite(event, ticket, extra = {}) {
  try {
    fs.appendFileSync(POOL_JOURNAL, JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ticket: ticket?.id || null,
      class: ticket?.class || null,
      slot: ticket?.slot ?? null,
      attempts: ticket?.attempts ?? 0,
      head: ticket?.head || '',
      ...extra,
    }) + '\n');
  } catch { /* audit is best-effort; it never blocks a turn */ }
}

function persistPool() {
  const payload = JSON.stringify({
    v: 1,
    queue: pool.queue,
    slots: pool.slots.map(s => ({ slot: s.slot, name: s.name, ticket: s.ticket, assignedAt: s.assignedAt })),
  });
  const tmp = POOL_SIDECAR + '.tmp';
  try {
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, POOL_SIDECAR);
  } catch (e) {
    debugLog(`persistPool failed: ${e.message}`);
  }
}

/** Broadcast « quelque chose a changé dans la file ». Le snapshot
 *  (/api/pupitre.pool) reste la vérité — cet événement n'est qu'un signal.
 *  Le try/catch couvre l'amorçage : `fleetSseClients` peut ne pas être encore
 *  évalué quand la file est rehydratée au boot. */
function broadcastPool(reason) {
  try {
    const payload = `data: ${JSON.stringify({ type: 'pool', reason })}\n\n`;
    for (const res of [...fleetSseClients]) {
      if (res.writableEnded || res.destroyed) { fleetSseClients.delete(res); continue; }
      try { res.write(payload); } catch { fleetSseClients.delete(res); }
    }
  } catch { /* trop tôt — rien à notifier */ }
}

/** Rehydratation au boot, AVANT tout dispatch. Un ticket qui était en vol sans
 *  processus vivant est PERDU : il repart une seule fois, en tête, avec une
 *  note de reprise. `attempts = 2` ⇒ échec définitif, jamais une boucle. */
function loadPoolFromDisk() {
  poolEnsureSlots();
  let raw;
  try { raw = fs.readFileSync(POOL_SIDECAR, 'utf8'); } catch { return; }
  let o;
  try { o = JSON.parse(raw); } catch (e) { debugLog(`loadPoolFromDisk parse failed: ${e.message}`); return; }
  const now = Date.now();
  pool.queue = (Array.isArray(o.queue) ? o.queue : [])
    .filter(t => t && t.id && typeof t.text === 'string')
    // Un message utilisateur n'expire jamais ; un POINT sur des résultats
    // vieux de six heures est sans objet (même TTL qu'en 0.20.0).
    .filter(t => t.class !== 'point' || (now - (t.enqueuedAt || 0)) < WAKE_ITEM_TTL_MS);
  for (const t of pool.queue) t.state = 'QUEUED';
  const inFlight = (Array.isArray(o.slots) ? o.slots : []).map(s => s?.ticket).filter(Boolean);
  for (const t of inFlight) {
    const s = pool.slots.find(x => x.slot === t.slot) || pool.slots[0];
    if (s && dispatchPidAlive(s.name)) {
      // Le tour a survécu au redémarrage du serveur : on le réadopte tel quel.
      s.ticket = t; s.assignedAt = t.assignedAt || Date.now();
      continue;
    }
    poolRequeueLost(t, 'restart');
  }
  if (pool.queue.length || pool.slots.some(s => s.ticket)) {
    console.log(`[pool] rehydraté — ${pool.queue.length} en file, ${pool.slots.filter(s => s.ticket).length} en vol`);
    persistPool();
    schedulePool('boot');
  }
}

/** Un ticket dont le tour a disparu : remis en tête UNE fois, avec une note de
 *  reprise, sinon clos en échec. */
function poolRequeueLost(t, why) {
  t.slot = null;
  if ((t.attempts || 0) >= 2) {
    t.state = 'FAILED';
    poolJournalWrite('failed_lost', t, { why });
    console.log(`[pool] ticket ${t.id} perdu 2× — abandonné`);
    return;
  }
  if (!t.repriseNoted) {
    t.text = `[REPRISE] Ton tour précédent a été perdu (${why}) ; vérifie l'état réel avant d'agir.\n\n${t.text}`;
    t.repriseNoted = true;
  }
  t.state = 'QUEUED';
  t.lost = true;
  pool.queue.unshift(t);
  poolJournalWrite('requeued_lost', t, { why });
  console.log(`[pool] ticket ${t.id} perdu (${why}) — remis en tête de file`);
}

function poolSlotFree(s) {
  return !s.ticket && !dispatchPidAlive(s.name);
}

/** Choix du ticket pour un slot libre. FIFO, avec une seule règle de classe en
 *  P0-A : un `point` (lot de réveil) ne passe que si rien d'autre n'est
 *  prenable — l'utilisateur et un musicien bloqué passent avant, et attendre
 *  enrichit le lot au lieu de l'appauvrir. */
function poolPickFor(s) {
  let pointIdx = -1;
  for (let i = 0; i < pool.queue.length; i++) {
    const t = pool.queue[i];
    if (t.pinnedSlot != null && t.pinnedSlot !== s.slot) continue;
    if (t.class === 'point') { if (pointIdx < 0) pointIdx = i; continue; }
    return i;
  }
  return pointIdx;
}

/** Ré-armement de l'ordonnanceur. `delayMs = 0` passe TOUT DE SUITE et de
 *  façon synchrone : l'appelant HTTP peut donc répondre « pris par CHEF 1 »
 *  plutôt que « position 1 » quand le chef était libre. Un délai non nul ne
 *  fait que rapprocher le prochain passage, jamais le repousser. */
let poolSchedulerRunning = false;
function schedulePool(reason = 'tick', delayMs = 0) {
  if (delayMs === 0) {
    if (poolSchedulerRunning) return;        // déjà dans la boucle : elle repassera
    poolSchedulerRunning = true;
    try { runPoolScheduler(reason); }
    catch (e) { debugLog(`pool scheduler error: ${e.message}`); }
    finally { poolSchedulerRunning = false; }
    return;
  }
  const at = Date.now() + delayMs;
  if (pool.timer && pool.timerAt && pool.timerAt <= at) return;
  if (pool.timer) clearTimeout(pool.timer);
  pool.timerAt = at;
  pool.timer = setTimeout(() => { pool.timer = null; pool.timerAt = 0; schedulePool(reason); }, delayMs);
  pool.timer.unref?.();
}

/** Le seul endroit où un tour de chef est lancé. */
function runPoolScheduler(reason) {
  poolEnsureSlots();
  poolReapLost();
  if (!pool.queue.length) return;

  // Même garde que tryFireWake : tirer dans un quota épuisé ne produirait
  // qu'un result synthétique. La file reste visible, l'UI porte le bandeau.
  if (readLimitedUntil()) { schedulePool('limited', 30_000); return; }

  let assigned = 0;
  for (const s of pool.slots) {
    if (!pool.queue.length) break;
    if (!poolSlotFree(s)) continue;
    const idx = poolPickFor(s);
    if (idx < 0) continue;
    const t = pool.queue.splice(idx, 1)[0];
    poolAssign(s, t);
    assigned++;
  }
  if (assigned) { persistPool(); broadcastPool('assigned'); }
  if (pool.queue.length) schedulePool('retry', POOL_RETRY_MS);
}

function poolAssign(s, t) {
  t.state = 'ASSIGNED';
  t.slot = s.slot;
  t.assignedAt = Date.now();
  t.attempts = (t.attempts || 0) + 1;
  s.ticket = t;
  s.assignedAt = t.assignedAt;
  poolJournalWrite('assigned', t, { reason: 'scheduler' });
  console.log(`[pool] ticket ${t.id} (${t.class}) → CHEF ${s.slot} « ${t.head} »`);
  if (t.traceId) projectTrace.set(s.name, t.traceId);
  const pid = spawnDirectDispatch(s.name, t.text, t.attachmentPaths || [], t.videoPaths || [], {
    source: t.source || undefined,
    wakeGen: t.wakeGen,
    reportOnly: !!t.reportOnly,
    ticket: t.id,
    slot: s.slot,
    traceId: t.traceId,
    poolAssign: true,
    obsId: t.obsId,
  });
  t.pid = pid || null;
}

/** Un slot assigné sans processus vivant depuis POOL_LOST_MS a perdu son tour.
 *  `healOrphanedLogs` fait la même chose au boot pour le log ; ici on fait
 *  repartir le TICKET, ce que le log ne sait pas faire. */
function poolReapLost() {
  let changed = false;
  for (const s of pool.slots) {
    const t = s.ticket;
    if (!t) continue;
    if (Date.now() - (s.assignedAt || 0) < POOL_LOST_MS) continue;
    if (dispatchPidAlive(s.name)) continue;
    s.ticket = null; s.assignedAt = 0;
    if (t.class === 'point') wake.inFlight = false;
    poolRequeueLost(t, 'processus perdu');
    changed = true;
  }
  if (changed) { persistPool(); broadcastPool('lost'); }
}

/** Mise en file. `front:true` pour un ticket qui REMPLACE un tour interrompu :
 *  il n'attend pas derrière ceux qu'il vient de doubler. */
function poolEnqueue(ticket) {
  poolEnsureSlots();
  const t = {
    id: newTicketId(),
    class: 'user',
    text: '',
    attachmentPaths: [],
    videoPaths: [],
    source: null,
    pinnedSlot: null,
    affinitySlot: null,
    hop: 0,
    attempts: 0,
    interrupting: false,
    ...ticket,
  };
  t.head = poolHead(t.displayText ?? t.text);
  t.state = 'QUEUED';
  t.enqueuedAt = Date.now();
  if (t.front) pool.queue.unshift(t); else pool.queue.push(t);
  delete t.front;
  // Borne de sécurité : on ne garde jamais une file sans fin. On sacrifie les
  // POINTS les plus anciens (leur contenu est reconstructible) avant tout
  // message utilisateur, qui lui n'expire jamais.
  while (pool.queue.length > POOL_MAX_QUEUE) {
    const i = pool.queue.findIndex(x => x.class === 'point');
    const dropped = pool.queue.splice(i >= 0 ? i : 0, 1)[0];
    if (dropped) {
      dropped.state = 'WITHDRAWN';
      if (dropped.class === 'point') wake.inFlight = false;
      poolJournalWrite('dropped_overflow', dropped);
    }
  }
  poolJournalWrite('enqueued', t, { position: pool.queue.indexOf(t) + 1 });
  persistPool();
  broadcastPool('enqueued');
  schedulePool('enqueue');
  return t;
}

function poolPosition(id) {
  const i = pool.queue.findIndex(t => t.id === id);
  return i < 0 ? null : i + 1;
}

function poolFindRunning(id) {
  for (const s of pool.slots) if (s.ticket && s.ticket.id === id) return s;
  return null;
}

/** Le log du slot a montré le `user_prompt` stampé : le ticket est réellement
 *  PRIS. C'est le log qui fait foi, jamais la réponse HTTP. */
function poolMarkRunning(name, ticketId) {
  const s = pool.slots.find(x => x.name === name);
  if (!s || !s.ticket || s.ticket.id !== ticketId) return;
  if (s.ticket.state === 'RUNNING') return;
  s.ticket.state = 'RUNNING';
  s.ticket.startedAt = Date.now();
  poolJournalWrite('running', s.ticket);
  persistPool();
  broadcastPool('started');
}

/** Un slot vient de terminer son tour : on clôt son ticket et on re-draine. */
function poolOnSlotResult(name, ev) {
  pool.lastResultAt.set(name, Date.now());
  const s = pool.slots.find(x => x.name === name);
  if (s && s.ticket) {
    const t = s.ticket;
    t.state = ev?.is_error ? 'FAILED' : 'DONE';
    t.endedAt = Date.now();
    s.ticket = null;
    s.assignedAt = 0;
    // Le verrou de réveil 0.20.0 appartient désormais au TICKET de point : il
    // se relâche quand ce tour-là finit, pas sur n'importe quel result du chef.
    if (t.class === 'point') wake.inFlight = false;
    poolJournalWrite(t.state.toLowerCase(), t, { synthetic: !!ev?.synthetic });
    persistPool();
    broadcastPool('done');
  }
  // Le `result` précède la sortie du processus : le `.pid` vit encore une
  // fraction de seconde. On repasse peu après plutôt que de tirer dans le vide
  // (le filet POOL_RETRY_MS reste là si cette passe arrive encore trop tôt).
  schedulePool('result', 1200);
}

function poolWithdraw(id) {
  const i = pool.queue.findIndex(t => t.id === id);
  if (i < 0) return null;
  const t = pool.queue.splice(i, 1)[0];
  t.state = 'WITHDRAWN';
  // Le verrou de réveil appartient au ticket : retirer le ticket le rend.
  if (t.class === 'point') wake.inFlight = false;
  poolJournalWrite('withdrawn', t);
  persistPool();
  broadcastPool('withdrawn');
  schedulePool('withdraw');
  return t;
}

/** Interruption EXPLICITE d'un slot. Tue le tour en vol et clôt son ticket.
 *
 *  `reschedule = false` quand l'appelant va enfiler le message REMPLAÇANT juste
 *  après : sans ça, le slot libéré serait immédiatement pris par le ticket qui
 *  patientait, et le message qui vient d'interrompre attendrait derrière lui —
 *  l'inverse de ce que l'utilisateur a demandé. */
function poolInterruptSlot(slotNum, why = 'explicite', reschedule = true) {
  poolEnsureSlots();
  const s = pool.slots.find(x => x.slot === slotNum);
  if (!s) return { ok: false, error: `unknown slot ${slotNum}` };
  const pid = dispatchPidAlive(s.name);
  let killed = false;
  if (pid) {
    killed = killDispatchTree(s.name, pid);
    try { fs.unlinkSync(path.join(LOGS_DIR, `${s.name}.pid`)); } catch {}
    crashLog(`pool interrupt: slot=${slotNum} name=${s.name} pid=${pid} why=${why}`);
  }
  if (s.ticket) {
    const t = s.ticket;
    t.state = 'FAILED';
    t.endedAt = Date.now();
    t.interruptedBy = why;
    s.ticket = null; s.assignedAt = 0;
    if (t.class === 'point') wake.inFlight = false;
    poolJournalWrite('interrupted', t, { why });
  }
  persistPool();
  broadcastPool('done');
  if (reschedule) schedulePool('interrupt');
  return { ok: true, slot: slotNum, name: s.name, pid: pid || null, killed };
}

/** Instantané additif exposé par /api/pupitre. `stateOf` fournit l'état du
 *  réducteur (vocabulaire verrouillé `idle|live|think|input|error|unread`). */
function poolSnapshot(stateOf) {
  poolEnsureSlots();
  return {
    size: poolSize(),
    model: poolModel(),
    slots: pool.slots.map(s => ({
      slot: s.slot,
      name: s.name,
      state: stateOf ? stateOf(s.name) : 'idle',
      pidAlive: dispatchPidAlive(s.name) != null,
      ticket: s.ticket ? {
        id: s.ticket.id, class: s.ticket.class, head: s.ticket.head,
        state: s.ticket.state, since: s.ticket.assignedAt || null,
      } : null,
      lastResultAt: pool.lastResultAt.get(s.name) || null,
    })),
    queue: pool.queue.map((t, i) => ({
      id: t.id, class: t.class, head: t.head, source: t.source || null,
      pinnedSlot: t.pinnedSlot ?? null, affinitySlot: t.affinitySlot ?? null,
      enqueuedAt: t.enqueuedAt, position: i + 1, hop: t.hop || 0,
      lost: !!t.lost, interrupting: !!t.interrupting,
    })),
  };
}

// ---------- Heal orphaned log tails ----------------------------------------
//
// If a `claude -p` child was killed mid-turn (server restart, crash,
// Ctrl-C during a long turn), the JSONL log ends on stream_event/assistant
// deltas without a final `result` event. The viewer's reducer faithfully
// reflects that and pins the panel at `live`/`think` forever. On boot we
// scan each log: if the last non-partial event is not a `result` AND the
// file has been quiet for >60s, append a synthetic error-result so the
// reducer can close the turn.

const ORPHAN_STALE_MS = 60_000;

function lastNonPartialType(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) return null;
    const CHUNK = 64 * 1024;
    let offset = Math.max(0, size - CHUNK);
    let tail = '';
    while (offset >= 0) {
      const len = size - offset;
      const buf = Buffer.alloc(Math.min(CHUNK, len));
      fs.readSync(fd, buf, 0, buf.length, offset);
      tail = buf.toString('utf8') + tail;
      const lines = tail.split('\n').filter(s => s.trim());
      // walk backwards looking for the last real TURN event, skipping partials
      // and coordination lines. A callback/notification written after a
      // completed turn is not a dangling turn — if we returned its type, heal
      // would append a bogus synthetic result over a log that already ended
      // cleanly on a real `result`.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        // heuristic: avoid parsing huge stream_event deltas
        if (line.includes('"type":"stream_event"')) continue;
        try {
          const ev = JSON.parse(line);
          if (!ev || typeof ev.type !== 'string') continue;
          if (ev.type === 'notification') continue;                 // coordination, not a turn
          if (isPhantomResult(ev)) continue;                        // mid-turn replay, not a turn end
          if (ev.type === 'user_prompt' && ev.source) continue;     // callback / @shortcut / notify
          return ev.type;
        } catch { /* partial line at the head; keep widening */ }
      }
      if (offset === 0) break;
      offset = Math.max(0, offset - CHUNK);
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Is the PID in a `.pid` sidecar still a live process? Boot-time only —
 *  dispatchPidAlive() lives below and closes over consts not yet initialised
 *  when healOrphanedLogs() runs. */
function pidSidecarAlive(pidPath) {
  let pid;
  try { pid = Number(fs.readFileSync(pidPath, 'utf8').trim()); } catch { return false; }
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // exists, just not ours to signal
}

function healOrphanedLogs() {
  let healed = 0;
  for (const p of config.projects) {
    const logPath = path.join(LOGS_DIR, `${p.name}.jsonl`);
    let stat;
    try { stat = fs.statSync(logPath); } catch { continue; }
    if (stat.size === 0) continue;
    const age = Date.now() - stat.mtimeMs;
    // A turn killed by the restart we are booting from is FRESH, so the age
    // gate alone never healed it: the chef stayed pinned at live/STALLED with
    // a dead PID until someone dispatched it again (19 aout 2026 — the
    // `restart-orchestrateur.mjs` tree-kill takes every dispatch down with the
    // server). The .pid sidecar settles it: alive means a real dispatch is
    // still producing events and must never be healed; dead means nothing can
    // ever close that turn. Only when there is no sidecar at all do we fall
    // back to the age heuristic.
    const pidPath = path.join(LOGS_DIR, `${p.name}.pid`);
    const hasPid = fs.existsSync(pidPath);
    if (hasPid && pidSidecarAlive(pidPath)) continue;
    if (!hasPid && age < ORPHAN_STALE_MS) continue;
    let lastType;
    try { lastType = lastNonPartialType(logPath); } catch { continue; }
    if (!lastType || lastType === 'result') continue;
    const synthetic = {
      type: 'result',
      subtype: 'error_interrupted',
      is_error: true,
      api_error_status: null,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      result: 'turn interrupted (orchestrator restarted or child crashed)',
      synthetic: true,
    };
    fs.appendFileSync(logPath, JSON.stringify(synthetic) + '\n');
    healed++;
    console.log(`[heal] closed orphaned turn in ${p.name}.jsonl (last=${lastType})`);
  }
  if (healed > 0) console.log(`[heal] appended synthetic result to ${healed} log(s)`);
}
healOrphanedLogs();

// Keep memory in sync when sidecars change on disk (dispatch.mjs writes them
// out-of-band in a separate process).
// Windows watch reliability: fs.watch (ReadDirectoryChangesW under the hood)
// only fires when NTFS flushes the directory entry, and NTFS defers that
// while the writing process keeps its append handle open — which every
// `claude -p` dispatch does for the whole turn. Measured on a live dispatch
// (19 aout 2026): 396 KB appended to logs/orchestrateur.jsonl over 60 s
// produced ONE fs.watch change event, versus 58 with stat polling.
// Symptom: the dashboard renders but never updates — cards frozen on their
// last state, no chef bubble, and drainQueue (which only runs when a
// `result` event is observed) never fires, so queued dispatches sit forever
// and the fleet looks dead while the sub-agents are in fact working.
// Cost of polling is one fs.stat per file per tick: 26 projects at 300 ms
// is ~87 stat/s, nothing next to a silent SSE.
const LOG_POLL_MS = Number(process.env.LOG_POLL_MS) || 300;
const logWatchOpts = (extra = {}) => ({
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval: LOG_POLL_MS,
  binaryInterval: LOG_POLL_MS,
  ...extra,
});

const sessionWatcher = chokidar.watch(path.join(LOGS_DIR, '*.session'), logWatchOpts());
sessionWatcher.on('all', (event, fp) => {
  const name = path.basename(fp, '.session');
  if (event === 'add' || event === 'change') {
    try {
      const sid = fs.readFileSync(fp, 'utf8').trim();
      if (sid) sessions.set(name, sid);
    } catch { /* race — ignore */ }
  } else if (event === 'unlink') {
    sessions.delete(name);
  }
});

// ---------- Express ---------------------------------------------------------

const app = express();
const httpServer = createHttpServer(app);

// verifyClient runs BEFORE the WebSocket handshake completes, so we can
// reject bad tokens and disallowed interfaces without ever opening the
// socket. Empirically, express-ws does NOT run the Express middleware
// chain on upgrade requests, so we can't rely on the HTTP-side guards
// alone — this is the only reliable pre-handshake gate.
function wsVerifyClient(info) {
  if (!TOKEN_GATE_ENABLED) return true;   // gate disabled — Tailscale-only access
  // Allowlist disabled 2026-05-13 — token check below is the sole gate.
  const urlQ = /[?&]token=([^&#]+)/.exec(info.req.url || '');
  const qtok = urlQ ? decodeURIComponent(urlQ[1]) : null;
  const htok = info.req.headers['x-orchestrator-token'];
  const ctok = parseCookieToken(info.req.headers.cookie);
  if (tokensEqual(qtok, TOKEN) || tokensEqual(htok, TOKEN) || tokensEqual(ctok, TOKEN)) return true;
  return false;
}

const _expressWsInstance = expressWs(app, httpServer, { wsOptions: { verifyClient: wsVerifyClient } });
// ws re-emits the http server's 'error' on the WebSocketServer; with no
// listener there it throws, which turned a boot-time EADDRINUSE into an
// uncaughtException that bypassed httpServer.on('error') and left a
// zombie process (alive, heartbeating, not listening — 2026-09-16).
// The real handling lives in httpServer.on('error') below.
_expressWsInstance.getWss().on('error', () => {});

// [1] Interface allowlist — DISABLED 2026-05-13 per user decision: home LAN
// is trusted, token gate alone is sufficient. The middleware is kept here
// (commented out) so re-enabling is a one-line revert if the network
// environment changes (public Wi-Fi, conference, etc.).
//
// app.use((req, res, next) => {
//   const local = normalizeAddr(req.socket.localAddress);
//   if (!ALLOWED_LOCAL_ADDRS.has(local)) {
//     res.status(403).type('text/plain')
//        .end(`Forbidden: interface ${local} not in allowlist`);
//     return;
//   }
//   next();
// });

// ---------- Public routes (no token gate) ------------------------------------

// Registre de la page /downloads — relu À CHAUD depuis downloads.json (0.23.0).
// Ajouter/retirer une app ou un doc, changer libellé, plateforme, description
// ou source de version ne demande plus de redémarrage : le fichier est relu
// dès que son mtime change, validé, et en cas d'erreur la dernière version
// valide est conservée (journalisée, jamais de 500). Voir CLAUDE.md.
// Tout le reste de la page est déjà calculé à chaque requête : version lue
// dans le gradle, présence de builds/<app>/latest.apk, HTML de la carte.
const downloadsRegistry = createDownloadsRegistry({
  file: path.join(__dirname, 'downloads.json'),
  buildsDir: BUILDS_DIR,
  log: (msg) => { console.log(msg); debugLog(msg); },
});

// Read a registered doc's Markdown. Tries the builds/ copy first (canonical,
// same pattern as the APKs) then the project-path fallbacks. Returns null when
// nothing is readable so the caller can emit a clean 404. Paths come only from
// the registry — never from the request — so there is no traversal surface.
function readDocMarkdown(doc) {
  const candidates = [path.join(BUILDS_DIR, doc.project, doc.file), ...(doc.fallbacks || [])];
  for (const p of candidates) {
    try { return { md: fs.readFileSync(p, 'utf8'), source: p }; } catch { /* try next */ }
  }
  return null;
}

const ANDROID_ICON_SVG = `<svg class="app-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.523 15.341a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm-11.046 0a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5ZM6.38 8.25h11.24c.456 0 .83.358.83.8v6.4c0 .442-.374.8-.83.8H6.38c-.456 0-.83-.358-.83-.8V9.05c0-.442.374-.8.83-.8ZM3.75 9.3a.75.75 0 0 1 .75.75v4.9a.75.75 0 0 1-1.5 0V10.05a.75.75 0 0 1 .75-.75Zm16.5 0a.75.75 0 0 1 .75.75v4.9a.75.75 0 0 1-1.5 0V10.05a.75.75 0 0 1 .75-.75ZM8.5 5.29 7.22 3.47a.375.375 0 0 1 .61-.438L9.2 4.9A7.013 7.013 0 0 1 12 4.25c.993 0 1.937.203 2.8.65l1.37-1.87a.375.375 0 1 1 .61.44L15.5 5.29A7.001 7.001 0 0 1 18 8.25H6A7.001 7.001 0 0 1 8.5 5.29Z"/></svg>`;
const DOC_ICON_SVG = `<svg class="app-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 2.75A2.25 2.25 0 0 0 3.75 5v14A2.25 2.25 0 0 0 6 21.25h12A2.25 2.25 0 0 0 20.25 19V8.31c0-.3-.12-.585-.33-.795l-4.435-4.435a1.125 1.125 0 0 0-.795-.33H6Zm8.25 1.94 3.56 3.56H15a.75.75 0 0 1-.75-.75V4.69ZM7.5 11.5h9a.75.75 0 0 1 0 1.5h-9a.75.75 0 0 1 0-1.5Zm0 3.5h9a.75.75 0 0 1 0 1.5h-9a.75.75 0 0 1 0-1.5Zm0-7h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>`;

function downloadsPageHtml(entries) {
  const cards = entries.map((e) => {
    const icon = e.apk ? ANDROID_ICON_SVG : DOC_ICON_SVG;
    const platform = e.platform ? `<span class="app-plat">${escHtml(e.platform)}</span>` : '';
    const version = e.version ? `<p class="app-version">v${escHtml(e.version)}</p>` : '';
    const description = e.description ? `<p class="app-desc">${escHtml(e.description)}</p>` : '';
    // Un APK absent n'est plus un bouton qui mène à une 404 : on le dit.
    const apkBtn = !e.apk ? ''
      : e.apkAvailable
        ? `<a class="dl-btn" href="/downloads/${escHtml(e.name)}/apk">↓ Télécharger APK</a>`
        : `<p class="dl-missing">APK pas encore publié</p>`;
    const docBtns = e.docs.map(d =>
      `<a class="dl-btn dl-btn--doc" href="/downloads/${escHtml(e.name)}/doc/${escHtml(d.id)}">📄 ${escHtml(d.title)}</a>`
    ).join('');
    return `
    <div class="card">
      <div class="app-header">
        ${icon}
        <div>
          <h2 class="app-name">${escHtml(e.label || e.name)}${platform}</h2>
          ${version}
        </div>
      </div>
      ${description}${apkBtn}${docBtns}
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fleet Downloads — Orchestrateur</title>
  <!-- NO external stylesheet. A render-blocking <link> to fonts.googleapis.com
       left this page BLANK on the Android-TV (MiBox) browser: the TV reaches
       myhost:7777 on the LAN but has no/blocked internet, so the font request
       hangs and the old WebView blocks first paint indefinitely. The page is now
       fully self-contained and renders offline with system fonts. -->
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f0f0f;
      color: #e0e0e0;
      font-family: 'Chakra Petch', 'Segoe UI', Roboto, system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 48px 16px;
    }
    h1 {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.14em;
      color: #555;
      text-transform: uppercase;
      margin-bottom: 40px;
    }
    /* Spacing uses margins, not flexbox gap — flex gap needs Chromium 84+, and
       the Android-TV WebView is older (it would ignore gap and cram the cards). */
    .cards {
      display: flex;
      flex-direction: column;
      width: 100%;
      max-width: 480px;
    }
    .card {
      background: #161616;
      border: 1px solid #252525;
      border-radius: 12px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      margin-bottom: 24px;
    }
    .card > * + * { margin-top: 16px; }
    .app-header {
      display: flex;
      align-items: center;
    }
    .app-icon {
      width: 36px;
      height: 36px;
      color: #7c5cff;
      flex-shrink: 0;
      margin-right: 16px;
    }
    .app-name {
      font-size: 22px;
      font-weight: 600;
      color: #f0f0f0;
      line-height: 1.2;
    }
    .app-version {
      font-size: 12px;
      color: #555;
      margin-top: 4px;
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      letter-spacing: 0.05em;
    }
    .app-plat {
      display: inline-block;
      margin-left: 8px;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #cdbcff;
      background: #1d1d24;
      border: 1px solid #3a2f66;
      border-radius: 999px;
      vertical-align: middle;
    }
    .app-desc {
      font-size: 14px;
      line-height: 1.45;
      color: #a8a8a8;
    }
    .dl-missing {
      text-align: center;
      padding: 12px 20px;
      font-size: 12px;
      color: #666;
      border: 1px dashed #333;
      border-radius: 8px;
    }
    .dl-btn {
      display: block;
      text-align: center;
      padding: 12px 20px;
      background: #7c5cff;
      color: #fff;
      border-radius: 8px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.06em;
      transition: background 0.15s;
    }
    .dl-btn:hover { background: #9b80ff; }
    .dl-btn:active { background: #6040ee; }
    .dl-btn--doc {
      background: #1d1d24;
      color: #cdbcff;
      border: 1px solid #3a2f66;
    }
    .dl-btn--doc:hover { background: #262633; }
    .dl-btn--doc:active { background: #16161c; }
    footer {
      margin-top: 56px;
      font-size: 11px;
      color: #333;
      letter-spacing: 0.08em;
    }
  </style>
</head>
<body>
  <h1>Fleet Downloads</h1>
  <div class="cards">${cards}</div>
  <footer>Orchestrateur · Fleet downloads</footer>
</body>
</html>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---------- « Pupitre » live desk page --------------------------------------
//
// Self-contained (no framework, no external resource). Reuses the existing SSE
// stream as a change hint and polls /api/pupitre for the authoritative
// snapshot. The embedded client script intentionally uses NO backticks and NO
// ${…} so it survives being nested inside this template literal verbatim.
function pupitrePageHtml() {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pupitre — suivi live du fleet</title>
  <link rel="stylesheet" href="/pupitre-row.css">
  <link rel="stylesheet" href="/pupitre-detail.css">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; background: #0d0d0f; color: #dcdcdc;
      font-family: 'JetBrains Mono', 'SF Mono', Consolas, ui-monospace, monospace;
      font-size: 13px; -webkit-text-size-adjust: 100%;
    }
    header.top {
      position: sticky; top: 0; z-index: 10;
      background: rgba(13,13,15,0.94); backdrop-filter: blur(8px);
      border-bottom: 1px solid #23232a;
      padding: 10px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    }
    header.top .title { font-size: 14px; font-weight: 600; letter-spacing: 0.12em; color: #e8a15c; }
    header.top a.back { color: #9b80ff; text-decoration: none; font-size: 12px; }
    header.top .spacer { flex: 1; }
    .counts { display: flex; gap: 14px; font-size: 12px; color: #888; }
    .counts b { color: #dcdcdc; font-weight: 600; }
    .counts .k-active b { color: #4ade80; }
    .counts .k-stalled b { color: #ff5555; }
    .live-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#4ade80; margin-right:5px; vertical-align:middle; box-shadow:0 0 6px #4ade80; }
    .live-dot.off { background:#666; box-shadow:none; animation:none; }
    main { padding: 8px 10px 60px; max-width: 1180px; margin: 0 auto; }
    /* .row / .head-row / .cell-* / .badge* / .st-* and @keyframes pulse now
       live in pupitre-row.css (linked below) — SINGLE SOURCE OF TRUTH shared
       with the dashboard's focused-musician overlay strip. Do not redefine
       them here; that reintroduces the exact divergence this file fixed. */
    /* ---- detail drawer: full event stream of one musician ---- */
    .row { cursor:pointer; transition:border-color .12s; }
    .row:hover { border-color:#33333d; }
    .row.sel { border-color:#e8a15c; background:#17161a; }
    .detail {
      position:fixed; top:0; right:0; bottom:0; width:min(780px, 60vw);
      background:#0f0f12; border-left:1px solid #26262e; z-index:20;
      display:flex; flex-direction:column; box-shadow:-18px 0 44px rgba(0,0,0,0.55);
    }
    .detail[hidden] { display:none; }
    /* .d-head / .d-name / .d-meta / .d-close / .d-body / .d-foot / .pin-on and
       .e / .e-* / .clamp / .streaming all live in /pupitre-detail.css (linked
       in <head>) — SINGLE SOURCE shared with the dashboard focused card so the
       "open row" (drawer head + event stream + foot) renders identically. */
    @media (max-width: 900px) { .detail { width:100%; } }
  </style>
</head>
<body>
  <header class="top">
    <span class="title">PUPITRE</span>
    <a class="back" href="/">← Dashboard</a>
    <span class="spacer"></span>
    <div class="counts">
      <span class="k-active">actifs <b id="c-active">0</b></span>
      <span class="k-stalled">stalled <b id="c-stalled">0</b></span>
      <span>total <b id="c-total">0</b></span>
      <span><span id="live-dot" class="live-dot off"></span>MAJ <b id="updated">—</b></span>
    </div>
  </header>
  <main>
    <div class="head-row">
      <span>état</span><span>musicien</span><span class="h-act">activité maintenant</span>
      <span class="r">tour</span><span class="r">silence</span><span class="r h-pid">pid</span><span class="h-mp">provider · model</span>
    </div>
    <div id="rows"></div>
  </main>
  <aside id="detail" class="detail" hidden>
    <div class="d-head">
      <span class="d-name" id="d-name">-</span>
      <span class="d-meta" id="d-meta"></span>
      <span class="spacer"></span>
      <button class="d-close" id="d-close" title="Fermer (Echap)">&times;</button>
    </div>
    <div class="d-body" id="d-body"></div>
    <div class="d-foot">
      <span id="d-pin" class="pin-on">⏬ suit le flux</span>
      <span class="spacer"></span>
      <span id="d-count">0 evts</span>
    </div>
  </aside>
  <script src="/pupitre-row.js"></script>
  <script src="/pupitre-detail.js"></script>
  <script>
  (function(){
    var POLL_MS = 2500;
    var snapshot = null, recvPerf = 0, sseHintTimer = null, sseOpen = false;
    var sel = null;   // currently-open musician in the detail drawer

    // esc / fmtAge / stateInfo / rank / row markup now come from PupitreRow
    // (public/pupitre-row.js) — the SAME module the dashboard's focused-card
    // strip uses, so the two can never diverge.
    var esc = PupitreRow.esc, fmtAge = PupitreRow.fmtAge,
        stateInfo = PupitreRow.stateInfo, rank = PupitreRow.rank;
    function render(){
      if(!snapshot) return;
      var elapsed = performance.now() - recvPerf;
      var rows = snapshot.fleet.slice().sort(function(a,b){
        var ra=rank(a), rb=rank(b);
        if(ra!==rb) return ra-rb;
        if(ra<=3) return b.silentMs - a.silentMs;   // attention/active: worst silence first
        return a.name.localeCompare(b.name);
      });
      var active=0, stalled=0, html='';
      for(var i=0;i<rows.length;i++){
        var r=rows[i], si=stateInfo(r);
        if(si.k==='stalled') stalled++;
        else if(r.state==='live'||r.state==='think') active++;
        html += PupitreRow.rowHtml(r, elapsed, { selected: sel===r.name });
      }
      document.getElementById('rows').innerHTML = html;
      if(sel && dMeta){
        var srow = null;
        for(var q=0;q<rows.length;q++) if(rows[q].name === sel) srow = rows[q];
        if(srow){
          var si2 = stateInfo(srow);
          dMeta.textContent = si2.label
            + ' · tour ' + ((srow.turnElapsedMs!=null) ? fmtAge(srow.turnElapsedMs+elapsed) : '—')
            + ' · silence ' + fmtAge(srow.silentMs+elapsed)
            + ' · pid ' + (srow.pid ? (srow.pid + (srow.pidAlive===false ? ' ✗' : ' ✓')) : '—')
            + ((srow.model||srow.configModel) ? ' · ' + (srow.model||srow.configModel) : '');
        }
      }
      document.getElementById('c-active').textContent = active;
      document.getElementById('c-stalled').textContent = stalled;
      document.getElementById('c-total').textContent = rows.length;
      document.getElementById('updated').textContent = new Date().toLocaleTimeString();
      var ld = document.getElementById('live-dot');
      if(ld) ld.className = 'live-dot' + (sseOpen ? '' : ' off');
    }
    function poll(){
      fetch('/api/pupitre', {headers:{'Accept':'application/json'}, credentials:'same-origin'})
        .then(function(r){ if(!r.ok) throw 0; return r.json(); })
        .then(function(j){ snapshot=j; recvPerf=performance.now(); render(); })
        .catch(function(){});
    }
    // ---- detail drawer -----------------------------------------------------
    // The row grid answers "who needs me"; this answers "what is it actually
    // doing". No new endpoint and no second SSE: the page already holds one
    // /api/sse/fleet connection carrying every project's raw JSONL lines, so
    // opening a musician just means starting to READ the lines already
    // arriving. Backfill comes from /api/project/:name/events (which already
    // assembles partial turns), then token-level deltas append live.
    var dBody = document.getElementById('d-body');
    var dName = document.getElementById('d-name');
    var dMeta = document.getElementById('d-meta');
    var dCount = document.getElementById('d-count');
    var dPin = document.getElementById('d-pin');
    var dPanel = document.getElementById('detail');
    // The "open row" event-stream renderer is shared with the dashboard card
    // (public/pupitre-detail.js) — SINGLE SOURCE so both render identically.
    var det = PupitreDetail.create(dBody, {
      maxNodes: 600,
      onCount: function(n){ dCount.textContent = n + ' evts'; }
    });

    function openDetail(name){
      sel = name;
      dPanel.hidden = false;
      dName.textContent = name;
      det.reset();
      det.setPinned(true);
      render();
      fetch('/api/project/' + encodeURIComponent(name) + '/events?n=200',
            {headers:{'Accept':'application/json'}, credentials:'same-origin'})
        .then(function(r){ return r.ok ? r.json() : []; })
        .then(function(list){
          if(sel !== name) return;              // user switched while loading
          det.reset();
          for(var i=0;i<list.length;i++) det.addEvent(list[i]);
          det.setPinned(true); det.stick();
        })
        .catch(function(){});
    }
    function closeDetail(){ sel = null; det.reset(); dPanel.hidden = true; render(); }

    document.getElementById('rows').addEventListener('click', function(e){
      var row = e.target.closest ? e.target.closest('.row') : null;
      if(!row) return;
      var n = row.getAttribute('data-name');
      if(!n) return;
      if(sel === n) closeDetail(); else openDetail(n);
    });
    document.getElementById('d-close').addEventListener('click', closeDetail);
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && sel) closeDetail(); });
    dBody.addEventListener('scroll', function(){
      var atB = det.atBottom();
      det.setPinned(atB);
      dPin.textContent = atB ? '\\u23ec suit le flux' : 'defilement libre';
      dPin.className = atB ? 'pin-on' : '';
    });

    try {
      var es = new EventSource('/api/sse/fleet');
      es.onopen  = function(){ sseOpen = true; };
      es.onerror = function(){ sseOpen = false; };   // browser auto-reconnects
      es.onmessage = function(e){
        if(sel){
          var env = null, raw = null;
          try { env = JSON.parse(e.data); } catch(_){ env = null; }
          if(env && env.project === sel){
            try { raw = JSON.parse(env.line); } catch(_){ raw = null; }
            if(raw) det.onLive(raw);
          }
        }
        if(sseHintTimer) return;
        sseHintTimer = setTimeout(function(){ sseHintTimer=null; poll(); }, 400);
      };
    } catch(e) {}
    setInterval(render, 1000);   // smooth silence/turn counters between polls
    setInterval(poll, POLL_MS);  // authoritative snapshot (pid liveness, stall)
    poll();
  })();
  </script>
</body>
</html>`;
}

// Minimal, dependency-free Markdown → HTML renderer. No CDN, no npm dependency:
// the box may be offline / CDN-blocked over Tailscale. Covers the constructs
// the fleet's docs actually use (ATX headings, fenced code, blockquotes,
// nested ordered/unordered lists, pipe tables, horizontal rules, inline code /
// links / bold / italic). Every text node is HTML-escaped, code spans are
// pulled out before escaping so they never re-format, and links are restricted
// to http(s)/mailto/relative — `javascript:` and friends collapse to `#`.
// Deliberately not a full CommonMark implementation: small and predictable.
function renderMarkdown(md) {
  const src = String(md).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  const indentOf = (l) => (l.match(/^ */)[0] || '').length;
  const isUl = (l) => /^\s*[-*+]\s+/.test(l);
  const isOl = (l) => /^\s*\d+\.\s+/.test(l);
  const isItem = (l) => isUl(l) || isOl(l);
  const isTableSep = (l) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(l);
  const isTableRow = (l) => /\|/.test(l) && /\S/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${escHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { const lvl = h[1].length; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); i++; continue; }

    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const [html, ni] = consumeTable(lines, i);
      out.push(html); i = ni; continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (isItem(line)) {
      const [html, ni] = consumeList(lines, i);
      out.push(html); i = ni; continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^\s*(```+|~~~+)/.test(lines[i]) &&
           !/^(#{1,6})\s+/.test(lines[i]) &&
           !/^\s*>/.test(lines[i]) &&
           !isItem(lines[i]) &&
           !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) &&
           !(isTableRow(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return out.join('\n');

  function consumeList(all, start) {
    const baseIndent = indentOf(all[start]);
    const type = isOl(all[start]) ? 'ol' : 'ul';
    let html = `<${type}>`;
    let idx = start;
    let cur = null;
    const flush = () => { if (cur) html += `<li>${inline(cur.text)}${cur.sub}</li>`; };
    while (idx < all.length) {
      const l = all[idx];
      if (l.trim() === '') {
        const next = all[idx + 1];
        if (next && isItem(next) && indentOf(next) >= baseIndent) { idx++; continue; }
        break;
      }
      if (!isItem(l)) {
        if (cur && indentOf(l) > baseIndent) { cur.text += ' ' + l.trim(); idx++; continue; }
        break;
      }
      const ind = indentOf(l);
      if (ind < baseIndent) break;
      if (ind > baseIndent) {
        const [sub, ni] = consumeList(all, idx);
        if (cur) cur.sub += sub;
        idx = ni; continue;
      }
      flush();
      const m = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(l);
      cur = { text: m ? m[1] : l.trim(), sub: '' };
      idx++;
    }
    flush();
    html += `</${type}>`;
    return [html, idx];
  }

  function consumeTable(all, start) {
    const splitCells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    const header = splitCells(all[start]);
    const aligns = splitCells(all[start + 1]).map(s => {
      const l = s.startsWith(':'), r = s.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    let idx = start + 2;
    const rows = [];
    while (idx < all.length && isTableRow(all[idx]) && !isTableSep(all[idx]) && all[idx].trim() !== '') {
      if (!/\|/.test(all[idx])) break;
      rows.push(splitCells(all[idx])); idx++;
    }
    const al = (n) => aligns[n] ? ` style="text-align:${aligns[n]}"` : '';
    let html = '<div class="table-wrap"><table><thead><tr>';
    header.forEach((c, n) => { html += `<th${al(n)}>${inline(c)}</th>`; });
    html += '</tr></thead><tbody>';
    for (const r of rows) {
      html += '<tr>';
      header.forEach((_, n) => { html += `<td${al(n)}>${inline(r[n] ?? '')}</td>`; });
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return [html, idx];
  }

  function inline(text) {
    const SENT = String.fromCharCode(0xE000);   // private-use sentinel, never in prose
    const codes = [];
    let t = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return SENT + (codes.length - 1) + SENT; });
    t = escHtml(t);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => {
      const safe = /^(https?:\/\/|mailto:|\/|#|\.)/i.test(url) ? url : '#';
      const ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${escHtml(safe)}"${ext}>${label}</a>`;
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
    t = t.replace(new RegExp(SENT + '(\\d+)' + SENT, 'g'), (_, n) => `<code>${escHtml(codes[n])}</code>`);
    return t;
  }
}

// Full mobile-readable page wrapping rendered Markdown. Self-contained styles
// (no external fonts/CSS) so it renders on an offline / CDN-blocked device.
function docPageHtml({ project, id, title, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(project)} — ${escHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      background: #0f0f0f;
      color: #dcdcdc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 17px;
      line-height: 1.65;
      -webkit-text-size-adjust: 100%;
    }
    .topbar {
      position: sticky; top: 0; z-index: 10;
      background: rgba(15,15,15,0.92);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid #242424;
      padding: 12px 16px;
      display: flex; align-items: center; gap: 12px;
    }
    .topbar a.back { color: #9b80ff; text-decoration: none; font-size: 14px; font-weight: 600; white-space: nowrap; }
    .topbar .spacer { flex: 1; }
    .topbar a.raw {
      color: #cdbcff; text-decoration: none; font-size: 12px;
      border: 1px solid #3a2f66; border-radius: 6px; padding: 5px 10px; white-space: nowrap;
    }
    main {
      max-width: 720px;
      margin: 0 auto;
      padding: 24px 18px 96px;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    h1, h2, h3, h4 { line-height: 1.25; color: #f2f2f2; margin: 1.6em 0 0.6em; }
    h1 { font-size: 1.7em; }
    h2 { font-size: 1.4em; border-bottom: 1px solid #242424; padding-bottom: 0.3em; }
    h3 { font-size: 1.18em; }
    h4 { font-size: 1.02em; color: #cfcfcf; }
    p { margin: 0.7em 0; }
    a { color: #9b80ff; }
    strong { color: #f2f2f2; }
    ul, ol { padding-left: 1.4em; margin: 0.7em 0; }
    li { margin: 0.3em 0; }
    li > ul, li > ol { margin: 0.3em 0; }
    blockquote {
      margin: 1em 0; padding: 0.4em 1em;
      border-left: 3px solid #7c5cff;
      background: #17151f; border-radius: 0 6px 6px 0;
      color: #c4bcd8;
    }
    blockquote p:first-child { margin-top: 0; }
    blockquote p:last-child { margin-bottom: 0; }
    code {
      font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
      font-size: 0.86em;
      background: #1c1c22; color: #e6d9ff;
      padding: 0.12em 0.4em; border-radius: 4px;
    }
    pre {
      background: #16161b; border: 1px solid #262630;
      border-radius: 8px; padding: 14px 16px;
      overflow-x: auto; margin: 1em 0;
      -webkit-overflow-scrolling: touch;
    }
    pre code { background: none; padding: 0; color: #d6d6d6; font-size: 0.82em; }
    hr { border: 0; border-top: 1px solid #262626; margin: 2em 0; }
    .table-wrap { overflow-x: auto; margin: 1em 0; -webkit-overflow-scrolling: touch; }
    table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
    th, td { border: 1px solid #2a2a2a; padding: 8px 11px; text-align: left; vertical-align: top; }
    th { background: #1a1a20; color: #f0f0f0; }
    tr:nth-child(even) td { background: #141418; }
    img { max-width: 100%; height: auto; }
    footer { max-width: 720px; margin: 0 auto; padding: 0 18px 40px; color: #444; font-size: 12px; }
  </style>
</head>
<body>
  <div class="topbar">
    <a class="back" href="/downloads">← Downloads</a>
    <span class="spacer"></span>
    <a class="raw" href="/downloads/${escHtml(project)}/doc/${escHtml(id)}/raw">↓ .md brut</a>
  </div>
  <main>
    ${bodyHtml}
  </main>
  <footer>Orchestrateur · ${escHtml(project)} · ${escHtml(title)}</footer>
</body>
</html>`;
}

app.get('/downloads', (req, res) => {
  res.type('html').send(downloadsPageHtml(downloadsRegistry.entries()));
});

app.get('/downloads/:app/apk', (req, res) => {
  const appName = req.params.app;
  if (!downloadsRegistry.findApp(appName)) return res.status(404).type('text/plain').end('Not found');
  const apkPath = downloadsRegistry.apkPath(appName);
  if (!fs.existsSync(apkPath)) return res.status(404).type('text/plain').end('APK not available');
  res.download(apkPath, `${appName}-latest.apk`);
});

// Rendered, mobile-readable view of a registered doc. Public (pre-token-gate).
app.get('/downloads/:project/doc/:id', (req, res) => {
  const doc = downloadsRegistry.findDoc(req.params.project, req.params.id);
  if (!doc) return res.status(404).type('text/plain').end('Document introuvable');
  const found = readDocMarkdown(doc);
  if (!found) return res.status(404).type('text/plain').end('Document indisponible (fichier source absent)');
  const bodyHtml = renderMarkdown(found.md);
  res.type('html').send(docPageHtml({ project: doc.project, id: doc.id, title: doc.title, bodyHtml }));
});

// Raw Markdown download of a registered doc.
app.get('/downloads/:project/doc/:id/raw', (req, res) => {
  const doc = downloadsRegistry.findDoc(req.params.project, req.params.id);
  if (!doc) return res.status(404).type('text/plain').end('Document introuvable');
  const found = readDocMarkdown(doc);
  if (!found) return res.status(404).type('text/plain').end('Document indisponible (fichier source absent)');
  res.type('text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.project}-${doc.file}"`);
  res.send(found.md);
});

// [2] Token gate — accepts query param, X-Orchestrator-Token header, or a
// previously-set HttpOnly cookie. On first authenticated request the cookie
// is stamped so subsequent subresource/SSE/WS requests authenticate without
// the viewer having to append ?token=… to every URL.
app.use((req, res, next) => {
  if (!TOKEN_GATE_ENABLED) return next();   // gate disabled — Tailscale-only access
  const header = req.header('x-orchestrator-token');
  const query  = typeof req.query?.token === 'string' ? req.query.token : null;
  const cookie = parseCookieToken(req.headers.cookie);
  const fromExplicit = tokensEqual(header, TOKEN) || tokensEqual(query, TOKEN);
  if (fromExplicit || tokensEqual(cookie, TOKEN)) {
    if (fromExplicit && !tokensEqual(cookie, TOKEN)) {
      res.cookie(COOKIE_NAME, TOKEN, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        maxAge: 365 * 86400 * 1000, // 1 year — bookmark-once experience
      });
    }
    next();
    return;
  }
  res.status(401).type('text/plain').end('Unauthorized');
});

// Per-request tracing middleware — log method, URL, content-length on
// every request that passed the token gate, plus the final status code
// and duration on response close. SSE / static / attachment requests
// are noisy; we filter those out. Skipping noisy paths keeps the log
// readable when the UI polls /api/config or hydrates events.
const NOISY_PATH_RE = /^(\/$|\/index\.html$|\/styles\.css$|\/app\.js$|\/fonts\/|\/attachments\/)/;
let _reqSeq = 0;
app.use((req, res, next) => {
  if (NOISY_PATH_RE.test(req.path)) return next();
  const id = (++_reqSeq).toString(36);
  const start = Date.now();
  const cl = req.headers['content-length'] || 0;
  const ip = normalizeAddr(req.socket.remoteAddress);
  debugLog(`req#${id} ← ${req.method} ${req.path} ip=${ip} len=${cl}`);
  res.on('close', () => {
    debugLog(`req#${id} → ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Static viewer assets
app.use(express.static(path.join(__dirname, 'public'), {
  fallthrough: true,
  etag: true,
}));

// Serve uploaded attachments so the browser can display them in chat bubbles.
// Token gate above already runs before this; no separate auth needed.
app.use('/attachments', express.static(ATTACHMENTS_DIR, { etag: true }));

// ---------- REST API --------------------------------------------------------

// Project list for the viewer — names + effective tool/model only, never
// absolute filesystem paths (defense in depth, even though it's already
// single-user and token-gated).
// Per-project last-read marker — ISO timestamp written by /api/mark-read,
// read on every /api/config. Clients use it to suppress unread counting on
// events that precede the marker (so a reload doesn't re-inflate unreads).
function readMarker(projectName) {
  try {
    const v = fs.readFileSync(path.join(LOGS_DIR, `${projectName}.read`), 'utf8').trim();
    return v || null;
  } catch { return null; }
}

// Tail the last ~256 KB of a project's log and run the same five-state
// reducer the viewer uses — so fresh page loads can hydrate each
// musician's current state immediately (the SSE only streams NEW events,
// so without this every card would start `idle` after reload).
const SCAN_TAIL_BYTES = 256 * 1024;
function scanProjectState(name) {
  const logPath = path.join(LOGS_DIR, `${name}.jsonl`);
  let stat; try { stat = fs.statSync(logPath); } catch { return { state: 'idle', lastLine: '', unreadCount: 0 }; }
  const size = stat.size;
  if (size === 0) return { state: 'idle', lastLine: '', unreadCount: 0 };
  const want = Math.min(SCAN_TAIL_BYTES, size);
  const buf = Buffer.alloc(want);
  const fd = fs.openSync(logPath, 'r');
  try { fs.readSync(fd, buf, 0, want, size - want); } finally { fs.closeSync(fd); }
  const text = buf.toString('utf8').replace(/\u0000+/g, '');
  const lines = text.split('\n');
  if (want < size && lines.length > 1) lines.shift();   // ligne partielle seulement si la fenêtre commence en cours de fichier
  const readAt = readMarker(name);
  const readTs = readAt ? Date.parse(readAt) : 0;

  let state = 'idle';
  let lastAssistantText = '';
  let lastLine = '';
  let unreadCount = 0;
  let questionResolved = null;
  let stopped = null;        // 0.31.0 : arrêt par le chef du dernier tour
  for (const ln of lines) {
    if (!ln) continue;
    let ev; try { ev = JSON.parse(ln); } catch { continue; }
    if (isPhantomResult(ev)) continue;   // mini-tour rejoué par le CLI, pas une fin de tour
    // Question acquittée (0.25.0) : `input` → `idle`, rien d'autre.
    if (isQuestionResolved(ev)) {
      if (state === 'input') { state = 'idle'; questionResolved = { ts: ev.timestamp || null, note: ev.note || '' }; }
      continue;
    }
    // « Vu » (0.31.0) : un échec ou un arrêt acquitté repasse à `idle`.
    if (isAcknowledged(ev)) {
      if (state === 'error' || state === 'unread') { state = 'idle'; unreadCount = 0; }
      continue;
    }
    if (ev?.type === 'result' && stopped && !isConductorStop(ev)) continue;   // suite d'un arrêt du chef
    const t = ev?.type;
    // A SOURCED user_prompt (musician callback, @shortcut, /api/notify) is not a
    // turn start — only a source-less prompt or a system/init is. A real dispatch
    // launched with --source still emits system/init, so it's covered.
    if ((t === 'user_prompt' && !ev.source) || (t === 'system' && ev.subtype === 'init')) {
      stopped = null;
      if (state === 'idle' || state === 'unread') state = 'live';
    } else if (t === 'assistant') {
      const blocks = ev.message?.content || [];
      let hasTool = false, hasThink = false, gotText = null;
      for (const b of blocks) {
        if (b?.type === 'text')     gotText = b.text || '';
        if (b?.type === 'thinking') hasThink = true;
        if (b?.type === 'tool_use') { hasTool = true; lastLine = `${(b.name || 'TOOL').toLowerCase()}`; }
      }
      if (gotText) { lastAssistantText = gotText; lastLine = gotText.replace(/\s+/g, ' ').trim().slice(0, 140); }
      state = hasTool ? 'live' : (hasThink ? 'think' : 'live');
    } else if (t === 'result') {
      const isErr = !!ev.is_error || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'));
      const needs = /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(lastAssistantText || '');
      if (isConductorStop(ev)) {
        stopped = stopInfo(ev);
        state = 'error';
        lastLine = stopped.reason || 'arrêté par le chef';
      } else if (isErr && ev.synthetic) {
        state = 'idle';
      } else if (isErr) {
        state = 'error';
        lastLine = ev.subtype || 'échec du tour';
      } else if (needs) {
        state = 'input';
        lastLine = needs[1].trim().slice(0, 140);
      } else {
        const evTs = ev.timestamp ? Date.parse(ev.timestamp) : Date.now();
        if (!readTs || evTs > readTs) { state = 'unread'; unreadCount++; }
        else state = 'idle';
      }
    }
  }
  return { state, lastLine, unreadCount, questionResolved, stopped: state === 'error' ? stopped : null };
}

app.get('/api/version', (req, res) => {
  res.json({ version: PKG_VERSION });
});

app.get('/api/config', (req, res) => {
  const defaults = config.defaults ?? {};
  res.json({
    conductor: config.conductor || 'chef',
    ui: uiFlags(),
    defaults: {
      model: defaults.model ?? null,
      allowedTools: defaults.allowedTools ?? FALLBACK_TOOLS,
      provider: defaults.provider ?? 'claude',
    },
    projects: config.projects.map(p => {
      const snap = scanProjectState(p.name);
      return {
        name: p.name,
        path: p.path || null,
        model: p.model ?? defaults.model ?? null,
        tools: p.tools ?? defaults.allowedTools ?? FALLBACK_TOOLS,
        provider: p.provider ?? defaults.provider ?? 'claude',
        attachedSession: sessions.get(p.name) || null,
        readAt: readMarker(p.name),
        currentState: snap.state,
        lastLine: snap.lastLine,
        unreadCount: snap.unreadCount,
        questionResolved: snap.questionResolved || null,
        stopped: snap.stopped || null,
      };
    }),
  });
});

// ---------- Live desk view (« pupitre ») ------------------------------------
//
// Real-time snapshot of every musician INCLUDING the conductor (chef), derived
// from the same shared core as the CLI supervisor. Powers /pupitre.
// Short-TTL cache keyed by the log's (mtime,size): /api/pupitre used to rescan
// every project synchronously on EVERY request (29 × up to 256 KiB on a USB
// disk, ×clients). We reuse a member snapshot when its log is byte-identical AND
// the cache entry is recent — bounding both the per-poll reads and the ×clients
// fan-out. The age cap (below the client's 5 s poll) keeps time-derived fields
// (silence, PID liveness) fresh: a static log still rescans on the next poll.
const pupitreCache = new Map();   // name → { key, at, snap }
const PUPITRE_CACHE_MS = 2500;
function scanFleetMemberCached(name, maxAgeMs = PUPITRE_CACHE_MS) {
  const logPath = path.join(LOGS_DIR, `${name}.jsonl`);
  let key = '0:0';
  try { const st = fs.statSync(logPath); key = st.mtimeMs + ':' + st.size; } catch {}
  const hit = pupitreCache.get(name);
  if (hit && hit.key === key && (Date.now() - hit.at) < maxAgeMs) return hit.snap;
  const snap = scanFleetMember(name);
  pupitreCache.set(name, { key, at: Date.now(), snap });
  return snap;
}

// ---------- Métadonnées de livrable (vue « Projets », 0.29.0) ---------------
//
// Version SOURCE du code et date du dernier APK copié. Jamais lues dans une
// route : les projets vivent sur I:\ (disque USB) et une I/O synchrone lente
// fait tuer le serveur par le watchdog. Un rafraîchissement asynchrone, au plus
// toutes les 60 s, sur une liste FIXE de fichiers (jamais d'exploration
// récursive, jamais de spawn) ; /api/pupitre ne lit que ce cache.
const PROJECT_META_TTL_MS = 60_000;
const projectMeta = new Map();   // name → { version: {value, source}|null, build: {apkAt}|null }
let projectMetaAt = 0;
let projectMetaBusy = false;
const VERSION_PROBES = [
  { rel: 'package.json',                   read: (t) => { try { return JSON.parse(t).version || null; } catch { return null; } } },
  { rel: 'app/build.gradle.kts',           read: (t) => VERSION_NAME_RE.exec(t)?.[1] || null },
  { rel: 'android/app/build.gradle.kts',   read: (t) => VERSION_NAME_RE.exec(t)?.[1] || null },
  { rel: 'app/build.gradle',               read: (t) => VERSION_NAME_RE.exec(t)?.[1] || null },
  { rel: 'pyproject.toml',                 read: (t) => /^version\s*=\s*["']([^"']+)["']/m.exec(t)?.[1] || null },
];
async function readProjectVersion(p) {
  const reg = downloadsRegistry.findApp(p.name);
  if (reg?.version) {
    try {
      const m = reg.version.re.exec(await fsp.readFile(reg.version.file, 'utf8'));
      if (m) return { value: m[1], source: path.basename(reg.version.file) };
    } catch { /* on tente les sondes du projet */ }
  }
  if (!p.path) return null;
  for (const probe of VERSION_PROBES) {
    let text;
    try { text = await fsp.readFile(path.join(p.path, probe.rel), 'utf8'); } catch { continue; }
    const v = probe.read(text);
    if (v) return { value: String(v).slice(0, 40), source: probe.rel };
  }
  return null;
}
async function refreshProjectMeta() {
  if (projectMetaBusy) return;
  projectMetaBusy = true;
  try {
    for (const p of [...config.projects]) {
      let build = null;
      try { build = { apkAt: (await fsp.stat(path.join(BUILDS_DIR, p.name, 'latest.apk'))).mtimeMs }; } catch {}
      let version = null;
      try { version = await readProjectVersion(p); } catch {}
      projectMeta.set(p.name, { version, build });
    }
  } finally {
    projectMetaAt = Date.now();
    projectMetaBusy = false;
  }
}
function projectMetaFor(name) {
  if (Date.now() - projectMetaAt > PROJECT_META_TTL_MS) refreshProjectMeta().catch(() => {});
  return projectMeta.get(name) || { version: null, build: null };
}

/** Drapeaux d'interface relus à chaud depuis config.json (`ui`). Défaut : tout
 *  activé — `"ui": { "projectsView": false }` retire la vue « Projets » des
 *  dashboards ouverts sans redémarrage ni redéploiement. */
function uiFlags() {
  return {
    projectsView: config.ui?.projectsView !== false,
    // 0.31.0 — journal d'activité du volet et cadres du Pilotage.
    activityJournal: config.ui?.activityJournal !== false,
    railCards: config.ui?.railCards !== false,
    // 0.35.0 — lecture audio des réponses du chef.
    tts: config.ui?.tts !== false,
    // 0.39.0 — vue « Models par tâche ».
    modelRouting: config.ui?.modelRouting !== false,
  };
}

// ── Models par tâche (0.39.0) ───────────────────────────────────────────────
// Enregistrement seulement : dispatch.mjs ne lit pas encore model-routing.json.
// Fichier dédié, écrit ici seul (temp + rename) — config.json est partagé par
// plusieurs chefs.
const modelRouting = createModelRouting({
  root: __dirname,
  cacheFile: path.join(LOGS_DIR, 'model-catalog.cache.json'),
});

app.get('/api/model-routing', (req, res) => {
  const n = Math.min(500, Math.max(1, Number(req.query.history) || 50));
  res.json({ ok: true, ...modelRouting.view(n) });
});

app.get('/api/model-catalog', async (req, res) => {
  try {
    const catalog = await modelRouting.getCatalog({ refresh: req.query.refresh === '1' });
    res.json({ ok: true, ...catalog });
  } catch (e) {
    debugLog(`[model-catalog] ${e.message}`);
    res.status(500).json({ ok: false, error: 'catalogue indisponible' });
  }
});

// Classifications récentes (phase 1 des pipelines, observation seule).
app.get('/api/pipeline-observe', (req, res) => {
  const n = Math.min(500, Math.max(1, Number(req.query.n) || 100));
  res.json({ ok: true, mode: 'observation', classifier: 'règles-v1', entryKinds: ENTRY_KINDS, ...pipelineObserver.recent(n) });
});

app.put('/api/model-routing/:task', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    await modelRouting.getCatalog();
    const b = req.body || {};
    const choice = b.default === true || b.model == null || b.model === '' ? null : { provider: b.provider, model: b.model };
    const r = modelRouting.setAssignment(req.params.task, choice, b.by);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    if (r.changed) console.log(`[model-routing] ${req.params.task} → ${choice ? `${choice.provider}:${choice.model}` : '(défaut du projet)'}`);
    res.json({ ok: true, task: req.params.task, assignment: r.assignment, changed: r.changed, updatedAt: r.updatedAt });
  } catch (e) {
    debugLog(`[model-routing] ${e.message}`);
    res.status(500).json({ ok: false, error: 'enregistrement impossible' });
  }
});

// Fleet-global provider availability, read cheaply per request.
function readNoFailover() { return fs.existsSync(path.join(LOGS_DIR, 'no-failover')); }
function readLimitedUntil() {
  try {
    const raw = fs.readFileSync(path.join(LOGS_DIR, 'claude-limited.until'), 'utf8').trim();
    if (!raw) return null;
    const t = Date.parse(raw);
    if (Number.isFinite(t) && t <= Date.now()) return null;   // expired
    return raw;
  } catch { return null; }
}

app.get('/api/pupitre', (req, res) => {
  const conductor = config.conductor || 'chef';
  const fleet = config.projects.map(p => {
    const snap = scanFleetMemberCached(p.name);   // state, silence, stall, pid, model…
    const meta = projectMetaFor(p.name);
    return {
      ...snap,
      version: meta.version,
      build: meta.build,
      isConductor: p.name === conductor,
      queueDepth: dispatchQueue.get(p.name)?.length ?? 0,
      // Configured provider/model as a fallback when the log has none yet.
      configModel: p.model ?? config.defaults?.model ?? null,
      configProvider: p.provider ?? config.defaults?.provider ?? 'claude',
    };
  });
  // 0.22.0 — objet `pool` ADDITIF : file de direction + slots. Aucun poll
  // supplémentaire (les slots réutilisent les lignes déjà scannées ci-dessus)
  // et les slots ne sont PAS ajoutés à `fleet[]` : le rail ne montre jamais un
  // chef. `pool` viendra s'enrichir en P0-B (affinité, épinglage, 3 pastilles).
  const stateOf = (n) => fleet.find(r => r.name === n)?.state
    || musicianAutoStates.get(n)?.state || 'idle';
  res.json({
    now: Date.now(),
    conductor,
    noFailover: readNoFailover(),
    limitedUntil: readLimitedUntil(),
    fleet,
    pool: poolSnapshot(stateOf),
    ui: uiFlags(),
  });
});

// ---------- Actions sur la file de direction (0.22.0) -----------------------
//
// Trois gestes, tous EXPLICITES. Rien ici n'est déclenché automatiquement :
// l'ordonnanceur ne retire ni n'interrompt jamais de lui-même.

/** Retirer un ticket encore en file. Le brouillon est rendu à l'appelant pour
 *  que le composer puisse le restituer (rien n'est perdu). */
// ---------- File par musicien : consulter / retirer (0.24.0) -----------------
//
// Avant, la seule façon de retirer une tâche était d'éditer
// logs/queue/<projet>.json — or la mémoire fait foi et réécrit ce fichier à
// chaque mutation : la retouche était perdue et la tâche revenait. Ces routes
// agissent sur la mémoire ET le sidecar d'un même geste. Le nom de projet est
// validé contre config.json (jamais interpolé dans un chemin sinon).
function queueProjectOr404(req, res) {
  const name = String(req.params.project || '');
  if (!config.projects.find(p => p.name === name)) {
    res.status(404).json({ error: `unknown project "${name}"` });
    return null;
  }
  return name;
}

app.get('/api/queue/:project', async (req, res) => {
  const name = queueProjectOr404(req, res);
  if (!name) return;
  const q = dispatchQueue.get(name) ?? [];
  res.json({
    project: name,
    busy: (await dispatchPidAliveAsync(name)) != null,
    count: q.length,
    entries: q.map(queueEntryView),
  });
});

app.delete('/api/queue/:project/:id', (req, res) => {
  const name = queueProjectOr404(req, res);
  if (!name) return;
  const removed = queueRemove(name, String(req.params.id || ''));
  if (!removed) return res.status(404).json({ error: `aucune entrée « ${req.params.id} » dans la file de ${name} (déjà lancée ou retirée ?)` });
  const msg = `[queue] ${name} : entrée ${removed.id} retirée (reste ${dispatchQueue.get(name)?.length ?? 0})`;
  console.log(msg); debugLog(msg);
  res.json({ ok: true, project: name, removed: queueEntryView(removed, -1), remaining: dispatchQueue.get(name)?.length ?? 0 });
});

app.delete('/api/queue/:project', (req, res) => {
  const name = queueProjectOr404(req, res);
  if (!name) return;
  const n = queueClear(name);
  const msg = `[queue] ${name} : file vidée (${n} entrée(s) retirée(s))`;
  console.log(msg); debugLog(msg);
  res.json({ ok: true, project: name, removed: n, remaining: 0 });
});

app.delete('/api/pool/queue/:ticket', (req, res) => {
  const t = poolWithdraw(String(req.params.ticket || ''));
  if (!t) return res.status(404).json({ error: 'ticket introuvable ou déjà pris' });
  res.json({ ok: true, ticket: t.id, class: t.class, draft: t.class === 'user' ? t.text : null });
});

/** Interrompre un slot — l'équivalent API de `!interrupt`, sans nouveau
 *  message. Le tour en vol est tué, son ticket clos, le suivant démarre. */
app.post('/api/pool/interrupt/:slot', express.json({ limit: '1kb' }), (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (!Number.isFinite(slot) || slot < 1) return res.status(400).json({ error: 'slot invalide' });
  const r = poolInterruptSlot(slot, 'api');
  if (!r.ok) return res.status(404).json(r);
  res.json(r);
});

// Self-contained live desk page. Reuses the EXISTING SSE stream
// (/api/sse/fleet) as a "something changed" hint and polls /api/pupitre for the
// authoritative snapshot (PID liveness / stall can't be derived from events
// alone). No framework, no external resource.
app.get('/pupitre', (req, res) => {
  res.type('html').send(pupitrePageHtml());
});

// Update which project serves as the conductor. Validates against the
// project allowlist, persists to config.json, and returns the new value.
app.post('/api/conductor', express.json({ limit: '1kb' }), (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  const proj = config.projects.find(p => p.name === name);
  if (!proj) return res.status(404).json({ error: `unknown project "${name}"` });
  const prev = config.conductor;
  config.conductor = name;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    // Drop the previous conductor's sidecar (it's not the chef anymore)
    // and the new conductor's too (fresh context so it sees the fleet).
    if (prev && prev !== name) {
      try { fs.unlinkSync(sessionFilePath(prev)); sessions.delete(prev); } catch {}
    }
    invalidateConductorSession(`conductor switched to ${name}`);
    res.json({ ok: true, conductor: name });
  } catch (e) {
    res.status(500).json({ error: `write failed: ${e.message}` });
  }
});

// Persist a per-project "read up to now" marker. Idempotent; any client
// can call it. Body: { project, timestamp? }. Timestamp defaults to now.
app.post('/api/mark-read', express.json({ limit: '2kb' }), (req, res) => {
  const name = typeof req.body?.project === 'string' ? req.body.project.trim() : '';
  const proj = config.projects.find(p => p.name === name);
  if (!proj) return res.status(404).json({ error: 'unknown project' });
  const ts = typeof req.body?.timestamp === 'string' && req.body.timestamp
    ? req.body.timestamp
    : new Date().toISOString();
  try {
    fs.writeFileSync(path.join(LOGS_DIR, `${name}.read`), ts);
    res.json({ ok: true, project: name, readAt: ts });
  } catch (e) {
    res.status(500).json({ error: `write failed: ${e.message}` });
  }
});

// ---------- Acquitter une question sans relancer le musicien (0.25.0) --------
//
// L'état `input` ne s'effaçait qu'au tour suivant du musicien. Quand
// l'utilisateur répond via le chef — ou que la question devient sans objet (la
// décision a été prise ailleurs) — la carte restait « question » indéfiniment,
// et /api/mark-read n'y changeait rien (il ne touche que unread/idle). Cette
// route AJOUTE un événement `notification/question_resolved` au log du musicien
// (voir isQuestionResolved) : aucun tour, aucun coût. Refusée (409) s'il n'y a
// pas de question ouverte ou si un tour tourne — dans ce cas la question est de
// toute façon en train d'être dépassée.
app.post('/api/question/:project/resolve', express.json({ limit: '4kb' }), async (req, res) => {
  const name = String(req.params.project || '');
  if (!config.projects.find(p => p.name === name)) return res.status(404).json({ error: `unknown project "${name}"` });
  // Lecture fraîche du log (pas le cache /api/pupitre) : on décide sur l'état réel.
  const snap = scanFleetMember(name);
  if (snap.state !== 'input') {
    return res.status(409).json({ error: `aucune question en attente pour ${name} (état : ${snap.state})`, state: snap.state });
  }
  if ((await dispatchPidAliveAsync(name)) != null) {
    return res.status(409).json({ error: `${name} a un tour en cours — la question est déjà en train d'être traitée`, state: 'live' });
  }
  const note = typeof req.body?.note === 'string' ? req.body.note.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  const by = typeof req.body?.by === 'string' && /^[A-Za-z0-9_.\-]{1,32}$/.test(req.body.by) ? req.body.by : 'utilisateur';
  const ev = {
    type: 'notification', subtype: 'question_resolved',
    question: snap.needsInput || '', note, by,
    text: `✓ question marquée répondue${by ? ` (${by})` : ''}${note ? ` : ${note}` : ''}`,
    timestamp: new Date().toISOString(),
  };
  try {
    fs.appendFileSync(path.join(LOGS_DIR, `${name}.jsonl`), JSON.stringify(ev) + '\n');
  } catch (e) {
    return res.status(500).json({ error: `écriture impossible : ${e.message}` });
  }
  const msg = `[question] ${name} : acquittement écrit par ${by} — « ${ev.question.slice(0, 80)} »`;
  console.log(msg); debugLog(msg);
  res.json({ ok: true, project: name, question: ev.question, note, by, resolvedAt: ev.timestamp });
});

// ---------- « Vu » : acquitter ce qui attend un regard (0.31.0) ---------------
//
// « À examiner » gardait un échec ou un arrêt par le chef indéfiniment : seul un
// nouveau tour l'effaçait. Cette route l'acquitte sans rien relancer :
//   · error (échec, arrêt par le chef) → événement `notification/acknowledged`
//     ajouté au log (même conception que question_resolved : tous les
//     réducteurs le lisent, il survit au redémarrage, part par le SSE) ;
//   · unread (résultat non lu, attente du chef) → marqueur de lecture, comme
//     /api/mark-read ;
//   · input → 409 : une question se règle par « Marquer comme répondue » ;
//   · tour en cours ou rien à acquitter → 409.
// Body : { note?, by?, auto? } — `auto` = acquitté par l'ouverture du volet.
app.post('/api/ack/:project', express.json({ limit: '4kb' }), async (req, res) => {
  const name = String(req.params.project || '');
  if (!config.projects.find(p => p.name === name)) return res.status(404).json({ error: `unknown project "${name}"` });
  const snap = scanFleetMember(name);
  const st = scanProjectState(name);   // porte le marqueur de lecture (unread réel)
  if (snap.state === 'live' || snap.state === 'think' || (await dispatchPidAliveAsync(name)) != null) {
    return res.status(409).json({ error: `${name} a un tour en cours`, state: 'live' });
  }
  if (snap.state === 'input') {
    return res.status(409).json({ error: `${name} attend une réponse : utiliser « Marquer comme répondue »`, state: 'input' });
  }
  const note = typeof req.body?.note === 'string' ? req.body.note.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  const by = typeof req.body?.by === 'string' && /^[A-Za-z0-9_.\-]{1,32}$/.test(req.body.by) ? req.body.by : 'utilisateur';
  const auto = req.body?.auto === true;
  const now = new Date().toISOString();
  if (snap.state === 'error') {
    const of = snap.stopped ? 'stopped' : 'error';
    const ev = {
      type: 'notification', subtype: 'acknowledged', of, by, note, auto,
      text: `✓ ${of === 'stopped' ? 'arrêt' : 'échec'} marqué vu${auto ? ' (volet ouvert)' : ''}${note ? ` : ${note}` : ''}`,
      timestamp: now,
    };
    try { fs.appendFileSync(path.join(LOGS_DIR, `${name}.jsonl`), JSON.stringify(ev) + '\n'); }
    catch (e) { return res.status(500).json({ error: `écriture impossible : ${e.message}` }); }
    try { fs.writeFileSync(path.join(LOGS_DIR, `${name}.read`), now); } catch { /* non bloquant */ }
    const msg = `[vu] ${name} : ${of === 'stopped' ? 'arrêt' : 'échec'} acquitté par ${by}${auto ? ' (volet ouvert)' : ''}`;
    console.log(msg); debugLog(msg);
    return res.json({ ok: true, project: name, kind: of, by, auto, acknowledgedAt: now });
  }
  if (st.state === 'unread') {
    try { fs.writeFileSync(path.join(LOGS_DIR, `${name}.read`), now); }
    catch (e) { return res.status(500).json({ error: `write failed: ${e.message}` }); }
    return res.json({ ok: true, project: name, kind: snap.awaitingChef ? 'awaiting_chef' : 'unread', by, auto, readAt: now });
  }
  return res.status(409).json({ error: `rien à marquer vu pour ${name} (état : ${st.state})`, state: st.state });
});

// ---------- Journal d'activité d'un musicien (0.31.0) ------------------------
//
// Ses tours, du plus récent au plus ancien, réduits par TurnCore.createJournal
// (public/turn-core.js, le même code que le client) : demande, ce qui a été
// fait, issue, durée, coût, model. Aucun appel LLM.
//
// Les logs dépassent parfois 300 Mo : on ne lit que la fin (fenêtre qui double
// de 4 à 64 Mio jusqu'à trouver `n` tours), en asynchrone, puis on garde l'état
// en cache et on ne relit que ce qui a été ajouté depuis.
const journalCache = new Map();   // nom → { size, offset, partial, journal, windowStart, truncated }
const journalLocks = new Map();
const JOURNAL_KEEP = 200;
const JOURNAL_WINDOW_MAX = 64 * 1024 * 1024;

async function readRange(file, start, end) {
  const fh = await fsp.open(file, 'r');
  try {
    const len = end - start;
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const { bytesRead } = await fh.read(buf, off, Math.min(len - off, 4 * 1024 * 1024), start + off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally { await fh.close(); }
}

function feedJournal(journal, text) {
  for (const ln of text.split('\n')) {
    if (!ln || ln.startsWith('{"type":"stream_event"')) continue;   // deltas : rien pour le journal
    let ev; try { ev = JSON.parse(ln); } catch { continue; }
    journal.push(ev);
  }
}

async function projectJournal(name, want) {
  const file = path.join(LOGS_DIR, `${name}.jsonl`);
  let st; try { st = await fsp.stat(file); } catch { return { turns: [], truncated: false, sizeBytes: 0 }; }
  let c = journalCache.get(name);
  if (c && st.size < c.size) c = null;                    // log tronqué/remplacé : on repart
  if (c && c.windowStart > 0 && c.journal.size < want && c.windowStart < JOURNAL_WINDOW_MAX && st.size > c.size) c = null;
  if (!c) {
    let win = 4 * 1024 * 1024;
    for (;;) {
      const start = Math.max(0, st.size - win);
      const buf = await readRange(file, start, st.size);
      let text = buf.toString('utf8').replace(/\u0000+/g, '');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);   // ligne coupée en tête
      const nl = text.lastIndexOf('\n');
      const body = nl >= 0 ? text.slice(0, nl + 1) : '';
      const journal = createJournal({ max: JOURNAL_KEEP });
      feedJournal(journal, body);
      c = { size: st.size, partial: nl >= 0 ? text.slice(nl + 1) : text, journal, windowStart: start };
      if (start === 0 || journal.size >= want + 1 || win >= JOURNAL_WINDOW_MAX) break;
      win *= 2;
    }
    journalCache.set(name, c);
  } else if (st.size > c.size) {
    const buf = await readRange(file, c.size, st.size);
    const text = c.partial + buf.toString('utf8').replace(/\u0000+/g, '');
    const nl = text.lastIndexOf('\n');
    feedJournal(c.journal, nl >= 0 ? text.slice(0, nl + 1) : '');
    c.partial = nl >= 0 ? text.slice(nl + 1) : text;
    c.size = st.size;
  }
  const all = c.journal.list();
  // Le plus ancien tour d'une fenêtre qui ne commence pas au début du log peut
  // être amputé de sa demande : on le signale plutôt que de le présenter entier.
  return { turns: all.slice(0, want), truncated: c.windowStart > 0, sizeBytes: st.size };
}

app.get('/api/project/:name/journal', async (req, res) => {
  const name = String(req.params.name || '');
  if (!config.projects.find(p => p.name === name)) return res.status(404).json({ error: `unknown project "${name}"` });
  const want = Math.max(1, Math.min(JOURNAL_KEEP, Number(req.query.n) || 50));
  try {
    // Une requête à la fois par musicien : deux lectures incrémentales
    // simultanées pousseraient deux fois les mêmes lignes.
    const run = (journalLocks.get(name) || Promise.resolve()).catch(() => {}).then(() => projectJournal(name, want));
    journalLocks.set(name, run);
    const j = await run;
    res.json({ project: name, ...j });
  } catch (e) {
    res.status(500).json({ error: `journal illisible : ${e.message}` });
  }
});

// Register an Android device's SSH public key for SFTP access.
// Body: { publicKey: "ssh-ed25519 AAAA..." }
// Appends to secrets/ssh_authorized_keys, skipping duplicates.
app.post('/api/ssh/register-key', express.json({ limit: '4kb' }), (req, res) => {
  const key = typeof req.body?.publicKey === 'string' ? req.body.publicKey.trim() : '';
  if (!key.startsWith('ssh-ed25519 ') && !key.startsWith('ecdsa-') && !key.startsWith('ssh-rsa ')) {
    return res.status(400).json({ error: 'invalid publicKey format' });
  }
  const keyPath = path.join(SECRETS_DIR, 'ssh_authorized_keys');
  try {
    const existing = fs.existsSync(keyPath)
      ? fs.readFileSync(keyPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
      : [];
    const keyLine = key.split(' ').slice(0, 2).join(' ');  // strip optional comment
    if (!existing.some(l => l.split(' ').slice(0, 2).join(' ') === keyLine)) {
      fs.appendFileSync(keyPath, '\n' + key + '\n');
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions', (req, res) => {
  res.json(Object.fromEntries(sessions));
});

// Append a tool to a project's allowed-tools list in config.json.
// Body: { tool: "WebSearch" }. Idempotent — no-op if already present.
app.post('/api/project/:name/add-tool', express.json({ limit: '1kb' }), (req, res) => {
  const proj = config.projects.find(p => p.name === req.params.name);
  if (!proj) return res.status(404).json({ error: 'unknown project' });
  const tool = typeof req.body?.tool === 'string' ? req.body.tool.trim() : '';
  if (!tool) return res.status(400).json({ error: 'missing tool' });

  // Write to the project's .claude/settings.json → permissions.allow.
  // This is what Claude Code reads at spawn time (--setting-sources project,local).
  if (!proj.path) return res.status(400).json({ error: 'project has no path configured' });
  const settingsDir = path.join(proj.path, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.permissions) settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
    if (!settings.permissions.allow.includes(tool)) {
      settings.permissions.allow.push(tool);
      atomicWriteJson(settingsPath, settings);
    }
  } catch (e) {
    return res.status(500).json({ error: `settings write failed: ${e.message}` });
  }
  // Without workspace trust, claude -p ignores every project allow rule and
  // the grant above would silently do nothing (0.30.0).
  let trusted = null;
  try { trusted = trustWorkspace(proj.path).key; }
  catch (e) { debugLog(`[add-tool] trust ${proj.name} failed: ${e.message}`); }
  res.json({ ok: true, tool, trusted });
});

// ---------- Refus d'autorisation traités (0.37.0) -----------------------------
//
// Exigence utilisateur : « fais en sorte que les demandes d'autorisations s'en
// aillent après validation ». Le volet ré-affichait les refus du dernier tour
// (permission_denials du result) sans fin, et proposait « + Ajouter PowerShell »
// pour des refus que l'ajout ne peut pas régler (analyse de sécurité du CLI).
// Un refus traité (« Vu », ou outil accordé) est acquitté par un événement de
// log — même conception que question_resolved et « vu » : lu par le client dans
// l'ordre, il survit au redémarrage et part par le SSE.
// Body : { toolIds: [tool_use_id…], action: 'seen'|'granted', tool?, by? }
app.post('/api/project/:name/denials/ack', express.json({ limit: '16kb' }), (req, res) => {
  const name = String(req.params.name || '');
  if (!config.projects.find(p => p.name === name)) return res.status(404).json({ error: `unknown project "${name}"` });
  const ids = Array.isArray(req.body?.toolIds) ? req.body.toolIds.map(String) : [];
  if (!ids.length || ids.length > 200 || !ids.every(id => /^[A-Za-z0-9_\-]{1,100}$/.test(id))) {
    return res.status(400).json({ error: 'toolIds : 1 à 200 identifiants d\'appel attendus' });
  }
  const action = req.body?.action === 'granted' ? 'granted' : 'seen';
  const tool = typeof req.body?.tool === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(req.body.tool) ? req.body.tool : null;
  const by = typeof req.body?.by === 'string' && /^[A-Za-z0-9_.\-]{1,32}$/.test(req.body.by) ? req.body.by : 'utilisateur';
  const ev = {
    type: 'notification', subtype: 'denials_acknowledged', toolIds: ids, action, ...(tool ? { tool } : {}), by,
    text: action === 'granted' ? `✓ ${tool || 'outil'} autorisé — refus traité` : `✓ refus d'autorisation marqué vu (${ids.length})`,
    timestamp: new Date().toISOString(),
  };
  try { fs.appendFileSync(path.join(LOGS_DIR, `${name}.jsonl`), JSON.stringify(ev) + '\n'); }
  catch (e) { return res.status(500).json({ error: `écriture impossible : ${e.message}` }); }
  debugLog(`[autorisation] ${name} : ${ids.length} refus acquitté(s) (${action}${tool ? ' ' + tool : ''}) par ${by}`);
  res.json({ ok: true, project: name, toolIds: ids, action });
});

// Toggle the global AI provider (claude | codex). Persists to config.json.
// Per-project overrides (project.provider) are set via /api/project/:name/provider.
app.post('/api/config/provider', express.json({ limit: '1kb' }), (req, res) => {
  const { provider } = req.body ?? {};
  if (provider !== 'claude' && provider !== 'codex')
    return res.status(400).json({ error: 'provider must be "claude" or "codex"' });
  if (!config.defaults) config.defaults = {};
  config.defaults.provider = provider;
  atomicWriteJson(CONFIG_PATH, config);
  res.json({ ok: true, provider });
});

// Toggle the AI provider for a single project (overrides the global default).
app.post('/api/project/:name/provider', express.json({ limit: '1kb' }), (req, res) => {
  const proj = config.projects.find(p => p.name === req.params.name);
  if (!proj) return res.status(404).json({ error: 'unknown project' });
  const { provider } = req.body ?? {};
  if (provider !== 'claude' && provider !== 'codex' && provider !== null)
    return res.status(400).json({ error: 'provider must be "claude", "codex", or null (to clear override)' });
  if (provider === null) delete proj.provider;
  else proj.provider = provider;
  atomicWriteJson(CONFIG_PATH, config);
  res.json({ ok: true, provider: proj.provider ?? config.defaults?.provider ?? 'claude' });
});

// ---------- Conductor chat history ------------------------------------------
// Reads the conductor JSONL and extracts the last N user_prompt + result
// events so the client can pre-populate the chat pane without SSE replay.
// Return the last N parsed events from a project's log. The viewer calls
// this when opening a focused panel so the user sees the turn's history,
// not just events arriving live after the page loaded.
//
// We also stitch `stream_event` thinking/text deltas into synthetic
// `assistant` events so the reader sees the model's reasoning between
// tool calls instead of just the commands it ended up running.
/** Read up to maxBytes from the END of a file and return the resulting
 *  string with NUL bytes (Windows half-flush artefact) stripped. The
 *  first (potentially partial) head line of the slice is dropped by the
 *  caller — this only handles the IO. Bounded RAM regardless of file
 *  size: we used to do `fs.readFileSync(big-log)` and watched RSS go
 *  from 78mb → 220mb when 4 SSE clients hydrated in parallel, then the
 *  process got OOM-killed without leaving any Node-side trace. */
// ---------- Request tracing ------------------------------------------------
//
// One trace_id is minted per /api/dispatch call. Every observable state
// transition for that turn is appended (synchronously, single line of
// JSON) to logs/traces.jsonl. A small in-memory Map<project, trace_id>
// tags each project's latest trace so the SSE log-watcher can attribute
// observed events (turn_started, tool_called, result) without needing
// the chef or musicians to propagate any ID.
//
// Cross-process linking (chef → musician dispatch via Bash) is done by
// time+project correlation: when a new user_prompt appears in a
// musician's log within ~2s of a chef tool_use that includes the
// musician's name, we emit a `child_dispatch` event linking the two.

const TRACES_LOG = path.join(LOGS_DIR, 'traces.jsonl');
/** projectName → trace_id of the in-flight (most recent) request */
const projectTrace = new Map();

function newTraceId() {
  return crypto.randomBytes(4).toString('hex');
}

function traceWrite(event) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  try { fs.appendFileSync(TRACES_LOG, line); } catch { /* best-effort */ }
}

function readFileTail(filePath, maxBytes = 2 * 1024 * 1024) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return ''; }
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) return '';
    const want = Math.min(maxBytes, size);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    return buf.toString('utf8').replace(/\u0000+/g, '');
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// ── NEEDS_CHEF_INPUT auto-relay (v6) ─────────────────────────────────────
// Protocol:
//   Musician final assistant text ends with "NEEDS_CHEF_INPUT: <q>"
//   → pump detects, dispatches chef with prompt marked "[NEEDS_CHEF_INPUT_FROM:<m>]"
//   Chef answers → pump walks back chef log to find marker, extracts musician,
//   dispatches chef response back via --resume with "[CHEF_ANSWER] …".
// Dedupe:
//   musician → chef : (musicianName, question first 100 chars)
//   chef → musician : (session_id, num_turns)
// State in-memory only ; restart may re-relay at most once.

const NEEDS_CHEF_RE   = /NEEDS_CHEF_INPUT:\s*([^\n]+)/i;
const CHEF_MARKER_RE  = /\[NEEDS_CHEF_INPUT_FROM:([A-Za-z][A-Za-z0-9_.\-]{0,63})\]/;
const dispatchedNeedsChef = new Set();
const relayedChefTurns    = new Set();

function extractNeedsChefInput(parsedEv) {
  let texts = [];
  if (parsedEv?.type === 'assistant') {
    for (const b of parsedEv.message?.content || []) {
      if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
  } else if (parsedEv?.type === 'result' && typeof parsedEv.result === 'string') {
    texts.push(parsedEv.result);
  } else {
    return null;
  }
  for (const t of texts) {
    const m = NEEDS_CHEF_RE.exec(t);
    if (m) return m[1].trim();
  }
  return null;
}

function maybeDispatchChefQuestion(musicianName, question) {
  if (!question) return;
  if (musicianName === conductorName()) return;
  const dedupeKey = `${musicianName}:${question.slice(0, 100)}`;
  if (dispatchedNeedsChef.has(dedupeKey)) return;
  dispatchedNeedsChef.add(dedupeKey);
  const prompt =
    `[NEEDS_CHEF_INPUT_FROM:${musicianName}] Le musicien « ${musicianName} » te demande une décision :\n\n` +
    `${question}\n\n` +
    `Réponds de façon décisive en une à trois phrases, préfixe par [ANSWER]. ` +
    `Si tu juges que c'est en fait une question pour l'utilisateur (préférence personnelle, ` +
    `autorisation, choix sans bonne réponse objective), réponds plutôt par ` +
    `NEEDS_USER_INPUT: <question reformulée pour le user>.`;
  console.log(`[needs-chef] ${musicianName} → chef : ${question.slice(0, 80)}…`);
  // 0.22.0 : ticket de classe `decision`. Un musicien bloqué passe avec les
  // messages utilisateur (avant les points), mais n'interrompt plus le chef.
  poolEnqueue({
    obsId: observeEntry({ entry: 'relais-vers-chef', project: conductorName(), text: prompt, caller: musicianName }),
    class: 'decision', text: prompt,
    displayText: `décision demandée par ${musicianName} : ${question}`,
  });
}

function maybeRelayChefAnswer(parsedEv) {
  if (parsedEv?.type !== 'result' || typeof parsedEv.result !== 'string') return;
  const sid = parsedEv.session_id;
  const nt  = parsedEv.num_turns;
  if (!sid || nt == null) return;
  const key = `${sid}:${nt}`;
  if (relayedChefTurns.has(key)) return;

  const chefLog = path.join(LOGS_DIR, `${conductorName()}.jsonl`);
  const raw = readFileTail(chefLog, 512 * 1024);
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  let musicianName = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('NEEDS_CHEF_INPUT_FROM:')) continue;
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.type === 'user_prompt' && typeof ev.text === 'string') {
        const m = CHEF_MARKER_RE.exec(ev.text);
        if (m) { musicianName = m[1]; break; }
      }
    } catch {}
  }
  if (!musicianName) return;
  if (!config.projects.find(p => p.name === musicianName)) {
    debugLog(`[chef-relay] unknown musician ${musicianName}, dropping`);
    return;
  }
  relayedChefTurns.add(key);
  const cleaned = parsedEv.result.replace(/^\s*\[ANSWER\]\s*/i, '').trim();
  const musicianPrompt =
    `[CHEF_ANSWER] ${cleaned}\n\n` +
    `Reprends ta tâche en intégrant cette décision.`;
  console.log(`[chef→${musicianName}] relay : ${cleaned.slice(0, 80)}…`);
  spawnDirectDispatch(musicianName, musicianPrompt, [], [], { observeAs: 'relais-vers-musicien' });
}

function allowedToolsFor(name) {
  const project = config.projects.find(p => p.name === name);
  if (!project) return null;
  return project.tools || config.defaults?.allowedTools || FALLBACK_TOOLS;
}

const TOOL_AUDIT_DIR = path.join(LOGS_DIR, 'tool-audit');
try { fs.mkdirSync(TOOL_AUDIT_DIR, { recursive: true }); } catch {}

// Cheap pre-filter then JSON.parse. Logs one NDJSON line per tool_use
// observed in any agent's stdout. Skips oversized lines and lines whose
// text obviously doesn't carry a tool_use to keep cost ~ O(line.length)
// for the substring check on most lines.
function auditToolUse(project, line) {
  if (!line || line.length > 1_000_000) return;
  if (line.indexOf('"tool_use"') === -1) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type !== 'assistant') return;
  const blocks = ev.message?.content;
  if (!Array.isArray(blocks)) return;
  const allowed = allowedToolsFor(project);
  for (const b of blocks) {
    if (b?.type !== 'tool_use') continue;
    const toolName = (b.name || '').toString();
    if (!toolName) continue;
    const record = {
      ts: new Date().toISOString(),
      project,
      tool_name: toolName,
      allowed_tools_in_effect: allowed,
      attempted_in_allowed: allowed
        ? allowed.split(',').map(t => t.trim().toLowerCase()).includes(toolName.toLowerCase())
        : null,
    };
    const file = path.join(TOOL_AUDIT_DIR, `tool-audit-${new Date().toISOString().slice(0, 10)}.ndjson`);
    try { fs.appendFileSync(file, JSON.stringify(record) + '\n'); } catch {}
  }
}

// Patch 1.3: async version of readFileTail. Used on the POST /api/dispatch
// hot path so a 256 KB tail read no longer blocks the event loop while a
// new request is being routed.
async function readFileTailAsync(filePath, maxBytes = 2 * 1024 * 1024) {
  let fh;
  try { fh = await fsp.open(filePath, 'r'); } catch { return ''; }
  try {
    const stat = await fh.stat();
    const size = stat.size;
    if (size === 0) return '';
    const want = Math.min(maxBytes, size);
    const buf = Buffer.alloc(want);
    await fh.read(buf, 0, want, size - want);
    return buf.toString('utf8').replace(/\u0000+/g, '');
  } finally {
    try { await fh.close(); } catch {}
  }
}

app.get('/api/project/:name/events', (req, res) => {
  const name = req.params.name;
  if (!config.projects.find(p => p.name === name)) return res.status(404).json({ error: 'unknown project' });
  const n = Math.min(500, Math.max(1, parseInt(req.query.n, 10) || 120));
  const logPath = path.join(LOGS_DIR, `${name}.jsonl`);
  // Tail-read instead of full readFileSync — log files can hit 90+ MB and
  // doing fs.readFileSync on each request OOM-killed the process under
  // concurrent SSE clients. 2 MB of tail covers ~10× the usual ring depth.
  const raw = readFileTail(logPath, 2 * 1024 * 1024);
  if (!raw) return res.json([]);

  // Walk every line, assembling consecutive delta-kinds per content-block
  // index. Synthetic `assistant` events are emitted for in-progress turns
  // (no real `assistant` yet). When the real `assistant` arrives it replaces
  // the synthetics — otherwise text blocks appear twice in the client ring.
  const out = [];
  const pending = new Map();    // blockIndex → { kind: 'thinking'|'text', text, timestamp }
  let syntheticStart = null;    // index into `out` where current turn's synthetics begin
  const flushBlock = (idx, timestamp) => {
    const block = pending.get(idx);
    if (!block) return;
    pending.delete(idx);
    if (!block.text.trim()) return;
    if (syntheticStart === null) syntheticStart = out.length;
    out.push({
      type: 'assistant',
      timestamp: timestamp || block.timestamp,
      message: {
        content: [block.kind === 'thinking'
          ? { type: 'thinking', thinking: block.text }
          : { type: 'text', text: block.text }],
      },
      synthetic: true,
    });
  };
  const flushAll = (timestamp) => { for (const idx of [...pending.keys()]) flushBlock(idx, timestamp); };

  // Drop the (likely partial) first line of the tail slice. NUL bytes
  // are already stripped inside readFileTail.
  const lines = raw.split('\n');
  if (lines.length > 1) lines.shift();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    // Jamais rendu : un result fantôme fermerait une mission en plein tour.
    if (isPhantomResult(ev)) continue;
    if (ev?.type === 'stream_event') {
      const evt = ev.event || {};
      const idx = typeof evt.index === 'number' ? evt.index : 0;
      if (evt.type === 'content_block_delta' && evt.delta) {
        const d = evt.delta;
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          const cur = pending.get(idx) || { kind: 'thinking', text: '', timestamp: ev.timestamp };
          cur.text += d.thinking;
          pending.set(idx, cur);
          continue;
        }
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          const cur = pending.get(idx) || { kind: 'text', text: '', timestamp: ev.timestamp };
          cur.text += d.text;
          pending.set(idx, cur);
          continue;
        }
      } else if (evt.type === 'content_block_stop') {
        flushBlock(idx, ev.timestamp);
        continue;
      }
      // Other stream events (message_start, content_block_start, etc.) —
      // skip; they don't carry user-visible content for our purposes.
      continue;
    }
    // Any non-partial event ends the current delta group so the output
    // remains chronological.
    flushAll(ev.timestamp);
    if (ev.type === 'assistant' && syntheticStart !== null) {
      // The real assistant event is canonical — it includes tool_use blocks
      // that stream_event deltas never carry. Drop the synthetic previews so
      // text doesn't appear twice when the ring is hydrated from this list.
      out.splice(syntheticStart);
      syntheticStart = null;
    } else if (ev.type === 'result') {
      syntheticStart = null;
    }
    out.push(ev);
  }
  flushAll();

  res.json(out.slice(-n));
});

// Strip composer reply-quote prefixes from user_prompt text before displaying.
// Android: "> [chef/moi] <quoted>\n\n"  Web: "Je réponds à ton message précédent :\n> ...\n\n"
function stripReplyPrefixes(text) {
  text = text.replace(/^> \[(?:chef|moi)\] [^\n]*\n\n/, '');
  text = text.replace(/^Je réponds à ton message précédent :\n(?:> [^\n]*\n)+\n/, '');
  return text;
}

app.get('/api/conductor-chat', (req, res) => {
  const n = Math.min(200, Math.max(1, parseInt(req.query.n, 10) || 60));
  const CONDUCTOR = config.projects.find(p => p.name === (config.conductor || 'chef'))?.name
    ?? config.conductor
    ?? 'chef';
  const logPath = path.join(LOGS_DIR, `${CONDUCTOR}.jsonl`);
  // Tail-read: chef.jsonl runs 50–80 MB; full reads were the OOM trigger.
  // 2 MB tail typically holds well over 200 turns worth of user_prompt /
  // assistant text / result events.
  const raw = readFileTail(logPath, 2 * 1024 * 1024);
  if (!raw) return res.json([]);

  const msgs = [];
  let lastAssistantText = '';
  // The claude CLI's own stream-json lines carry no timestamp — only the
  // events dispatch.mjs writes itself (user_prompt, codex results) do. The
  // old `: Date.now()` fallback therefore stamped EVERY conductor bubble with
  // the moment of the HTTP request: on reload the whole thread collapsed onto
  // "now" and came back out of order (13 inverted pairs out of 41 observed).
  // Reconstruct instead from the turn's own numbers — prompt time plus the
  // result's duration_ms — and clamp to log order, which is the real truth.
  let lastPromptTs = null;
  let lastTs = 0;
  let lastTicket = null;   // ticket du dernier tour ouvert (0.22.0)
  const stampFrom = (ev) => {
    if (ev.timestamp) { const t = Date.parse(ev.timestamp); if (Number.isFinite(t)) return t; }
    if (lastPromptTs != null && Number.isFinite(ev.duration_ms)) return lastPromptTs + ev.duration_ms;
    if (lastPromptTs != null) return lastPromptTs;
    return lastTs || Date.now();
  };
  const monotonic = (ts) => { const v = Math.max(ts, lastTs + 1); lastTs = v; return v; };
  const chatLines = raw.split('\n');
  if (chatLines.length > 1) chatLines.shift(); // drop possibly-partial head line
  for (const line of chatLines) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'user_prompt' && ev.source === 'wake') {
      // Server-generated "go report on these results" prompt — never part of the
      // human-visible conversation (the results themselves are already cards).
      continue;
    }
    if (ev.type === 'user_prompt' && typeof ev.text === 'string' && ev.text.trim()) {
      const userText = stripReplyPrefixes(ev.text.trim());
      const entry = { role: 'user', text: userText, ts: monotonic(stampFrom(ev)) };
      lastPromptTs = entry.ts;
      if (ev.source) entry.source = ev.source;
      // 0.22.0 — le ticket qui a produit ce tour. C'est ce qui permet à un
      // rechargement de reconstruire « ▸ pris par CHEF 1 » et « ↩ répond à ».
      if (typeof ev.ticket === 'string') { entry.ticket = ev.ticket; lastTicket = ev.ticket; }
      if (Number.isFinite(ev.slot)) entry.slot = ev.slot;
      if (Array.isArray(ev.attachmentPaths) && ev.attachmentPaths.length) {
        entry.attachmentPaths = ev.attachmentPaths.map(p => '/attachments/' + path.basename(String(p)));
      }
      msgs.push(entry);
    } else if (ev.type === 'assistant') {
      const content = ev.message?.content || [];
      for (const b of content) {
        if (b?.type === 'text' && b.text?.trim()) lastAssistantText = b.text.trim();
      }
    } else if (ev.type === 'result' && !ev.is_error && lastAssistantText && !isPhantomResult(ev)) {
      // A chef reply that ENDS with NEEDS_USER_INPUT used to be dropped here, so
      // the chef's own question vanished from the thread on every reload. Keep
      // it, flagged, so the client can render it as a question bubble.
      const needs = /^NEEDS_USER_INPUT:/m.test(lastAssistantText);
      const entry = { role: 'conductor', text: lastAssistantText, ts: monotonic(stampFrom(ev)) };
      if (needs) entry.question = true;
      if (lastTicket) { entry.answersTicket = lastTicket; lastTicket = null; }
      msgs.push(entry);
      lastAssistantText = '';
    } else if (ev.type === 'notification'
               && (ev.subtype === 'musician_done' || ev.subtype === 'musician_question')
               && ev.source && typeof ev.text === 'string' && ev.text.trim()) {
      // Additive fields (outcome/summary/duration/cost) are passed through so a
      // reload rebuilds the same result cards as the live stream.
      msgs.push({
        role: 'callback',
        text: ev.text.trim(),
        ts: monotonic(stampFrom(ev)),
        source: ev.source,
        ...(ev.outcome ? { outcome: ev.outcome } : {}),
        ...(typeof ev.summary === 'string' && ev.summary ? { summary: ev.summary } : {}),
        ...(Number.isFinite(ev.duration_ms) ? { duration_ms: ev.duration_ms } : {}),
        ...(Number.isFinite(ev.cost_usd)    ? { cost_usd: ev.cost_usd }       : {}),
        ...(ev.awaitingChef ? { awaitingChef: true } : {}),
      });
    }
  }
  const out = msgs.slice(-n);
  // Les tickets ENCORE EN FILE n'ont produit aucun événement : ils n'existent
  // nulle part dans le log. On les ajoute en queue de fil, dans leur ordre
  // d'arrivée, pour qu'un rechargement retrouve « ⏳ en file · position n ».
  const alreadyShown = new Set(out.map(m => m.ticket).filter(Boolean));
  for (const t of pool.queue) {
    if (t.class !== 'user') continue;
    // Un ticket PERDU puis remis en file a déjà une entrée dans le log :
    // on ne le montre pas deux fois.
    if (alreadyShown.has(t.id)) continue;
    out.push({
      role: 'user', text: stripReplyPrefixes(String(t.text || '').trim()),
      ts: t.enqueuedAt, ticket: t.id, queued: true,
    });
  }
  res.json(out);
});

// Incremental state reducer mirroring scanProjectState() but for a single
// event. Updates musicianAutoStates in place; returns prev + new state so
// the pump can detect transitions without re-reading the whole log.
function reduceMusician(name, ev) {
  const prev = musicianAutoStates.get(name)
    ?? { state: 'idle', lastAssistantText: '', lastLine: '', awaitingChef: false };
  let { state, lastAssistantText, lastLine } = prev;
  let awaitingChef = prev.awaitingChef ?? false;
  // Who (if anyone) is waiting for this turn's result, and at what wake depth.
  // Stamped by dispatch.mjs on the turn's opening user_prompt; consumed once by
  // the wake scheduler at `result`.
  let expectCallback = prev.expectCallback ?? null;
  let wakeGen = prev.wakeGen ?? 0;
  const t = ev?.type;
  // stream_event lines are very frequent token-level deltas — skip.
  if (t === 'stream_event') return { prevState: state, newState: state, lastLine, awaitingChef, expectCallback, wakeGen };
  // Result fantôme (voir isPhantomResult) : AUCUN effet. Surtout, l'attente
  // `--callback` du tour en cours n'est pas consommée — c'est le vrai result,
  // plus loin, qui doit réveiller le chef.
  if (isPhantomResult(ev)) {
    return { prevState: state, newState: state, lastLine, awaitingChef, expectCallback: null, wakeGen, phantom: true };
  }
  // Question acquittée (0.25.0) : `input` → `idle`, et c'est tout. Pas une fin
  // de tour : le pump n'en tire ni notification, ni réveil, ni drain.
  if (isQuestionResolved(ev)) {
    if (state === 'input') state = 'idle';
    musicianAutoStates.set(name, { ...prev, state });
    return { prevState: prev.state, newState: state, lastLine, awaitingChef, expectCallback: null, wakeGen, resolved: true };
  }
  // « Vu » (0.31.0) : même traitement, pour un échec / arrêt acquitté.
  if (isAcknowledged(ev)) {
    if (state === 'error' || state === 'unread') { state = 'idle'; awaitingChef = false; }
    musicianAutoStates.set(name, { ...prev, state, awaitingChef });
    return { prevState: prev.state, newState: state, lastLine, awaitingChef, expectCallback: null, wakeGen, resolved: true };
  }
  // Un result qui suit un arrêt du chef dans le même tour (ancien « model
  // indisponible » de dispatch.mjs) : aucun effet, comme un fantôme.
  if (t === 'result' && prev.stopped && !isConductorStop(ev)) {
    return { prevState: state, newState: state, lastLine, awaitingChef, expectCallback: null, wakeGen, phantom: true, afterStop: true };
  }
  let stopped = prev.stopped ?? null;
  // Sourced user_prompt (callback / @shortcut / notify) is not a turn start.
  if ((t === 'user_prompt' && !ev.source) || (t === 'system' && ev.subtype === 'init')) {
    if (state === 'idle' || state === 'unread') state = 'live';
    awaitingChef = false;   // a new turn clears "waiting on the chef"
    stopped = null;
    // Only the user_prompt carries the expectation; the system/init that follows
    // it belongs to the SAME turn, so it must not clear what we just recorded.
    if (t === 'user_prompt') {
      expectCallback = typeof ev.callback === 'string' && ev.callback ? ev.callback : null;
      wakeGen = Number.isFinite(ev.wakeGen) ? ev.wakeGen : 0;
    }
  } else if (t === 'assistant') {
    const blocks = ev.message?.content || [];
    let hasTool = false, hasThink = false, gotText = null;
    for (const b of blocks) {
      if (b?.type === 'text')     gotText = b.text || '';
      if (b?.type === 'thinking') hasThink = true;
      if (b?.type === 'tool_use') hasTool = true;
    }
    if (gotText) { lastAssistantText = gotText; lastLine = gotText.replace(/\s+/g, ' ').trim().slice(0, 600); }
    state = hasTool ? 'live' : (hasThink ? 'think' : 'live');
  } else if (t === 'result') {
    const isErr = !!ev.is_error || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'));
    const needs = /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(lastAssistantText || '');
    // NEEDS_CHEF_INPUT is a DIFFERENT wait: the musician finished its turn but is
    // blocked on a chef decision. The state string stays `unread` (locked
    // vocabulary) — `awaitingChef` is an ADDITIVE flag so the UI can say
    // "attend le chef" instead of the misleading "terminé".
    const asksChef = NEEDS_CHEF_RE.test(lastAssistantText || '')
      || (typeof ev.result === 'string' && NEEDS_CHEF_RE.test(ev.result));
    if (isConductorStop(ev))    { stopped = stopInfo(ev); state = 'error'; lastLine = stopped.reason || 'arrêté par le chef'; awaitingChef = false; }
    else if (isErr && ev.synthetic)  { state = 'idle'; awaitingChef = false; }
    else if (isErr)             { state = 'error'; lastLine = ev.subtype || 'échec du tour'; awaitingChef = false; }
    else if (needs)             { state = 'input'; lastLine = needs[1].trim().slice(0, 600); awaitingChef = false; }
    else {
      if (ev.result) lastLine = ev.result.replace(/\s+/g, ' ').trim().slice(0, 600);
      state = 'unread';
      awaitingChef = asksChef;
    }
  }
  // The expectation is consumed by the terminal event: the caller sees the value
  // that was in force during the turn, and the stored state is cleared so a later
  // event on the same log can never re-fire the same wake.
  const turnExpectCallback = expectCallback;
  const turnWakeGen = wakeGen;
  if (t === 'result') { expectCallback = null; wakeGen = 0; }
  musicianAutoStates.set(name, { state, lastAssistantText, lastLine, awaitingChef, expectCallback, wakeGen, stopped });
  return {
    prevState: prev.state, newState: state, lastLine, awaitingChef,
    expectCallback: turnExpectCallback, wakeGen: turnWakeGen,
  };
}

/** Human-facing summary of a finished turn: the LAST paragraph of the result —
 *  musicians end with their conclusion — instead of the old `slice(0, 600)` that
 *  cut the opening mid-sentence. Capped at 280 chars on a word boundary. */
function summarizeResult(ev) {
  const raw = typeof ev?.result === 'string' ? ev.result.trim() : '';
  if (!raw) return '';
  const paras = raw.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  let last = paras.length ? paras[paras.length - 1] : raw;
  // A very short tail (a closing line like "Terminé.") carries no information —
  // fold the previous paragraph in so the card still says something.
  if (last.length < 40 && paras.length > 1) last = `${paras[paras.length - 2]} ${last}`;
  last = last.replace(/\s+/g, ' ').trim();
  if (last.length <= 280) return last;
  return last.slice(0, 279).replace(/\s+\S*$/, '') + '…';
}

// ---------- Aggregate SSE (all projects over one connection) ---------------
//
// Chrome/Edge cap HTTP/1.1 at 6 simultaneous connections per origin. One-
// per-project SSE + the WebSocket for the central pty quickly eats that
// budget; subsequent ad-hoc requests (DELETE /api/projects/:name, session
// listings, etc.) stall in "pending" forever. This multiplexes every
// project's log tail into a single event stream, so the viewer only holds
// one SSE connection regardless of fleet size.
//
// SHARED WATCHER POOL — module-scoped, NOT per SSE client. Previously each
// SSE connection spun up 19 chokidar watchers (one per project). With 7
// concurrent clients that was 133 simultaneous watchers + 7 polling
// timers. Each Android churn cycle (open→close→open) created 19 new
// watchers and queued 19 async closes — we leaked file handles and
// poll timers, RSS climbed from ~80 to ~140 MB, and the server eventually
// died (29 avr. crashes). We now create AT MOST 19 watchers (one per
// project, lifetime = server lifetime) and broadcast each chunk to a
// Set<res> of subscribed SSE responses.

/** name → { offset, partial, watcher, subscribers: Set<res> } */
const fleetStreams = new Map();
// Every live /api/sse/fleet response, so config hot-reload can subscribe them
// to newly-added project streams and push a "config changed" signal.
const fleetSseClients = new Set();

function fleetEnsureProject(name) {
  if (fleetStreams.has(name)) return fleetStreams.get(name);
  const logPath = path.join(LOGS_DIR, `${name}.jsonl`);
  let initialOffset = 0;
  try { initialOffset = fs.statSync(logPath).size; } catch {}
  const stream = {
    offset: initialOffset,
    partial: '',
    subscribers: new Set(),
  };

  // Maximum bytes we'll ingest per pump tick. A `tool_result` block can
  // be hundreds of MB when an agent did `base64 < big-binary` — Buffer.alloc
  // + toString('utf8') doubles that into UTF-16 in heap, which OOMs the
  // process before any later size check fires (29 avr. 11:55 incident).
  // If the file grew faster than this, we skip ahead to EOF and emit a
  // synthetic notice; the actual content is on disk and the focused
  // panel can still fetch it via /api/project/:name/events.
  const PUMP_READ_MAX = 4 * 1024 * 1024; // 4 MB

  const pump = () => {
    let stat;
    try { stat = fs.statSync(logPath); } catch { return; }
    if (stat.size < stream.offset) { stream.offset = 0; stream.partial = ''; }
    if (stat.size > stream.offset) {
      const want = stat.size - stream.offset;
      if (want > PUMP_READ_MAX) {
        debugLog(`fleet ${name} pump skip ${want}B (> ${PUMP_READ_MAX}) — fast-forward to EOF`);
        stream.offset = stat.size;
        stream.partial = '';
        // Emit a synthetic system event so the client knows.
        const skipMsg = JSON.stringify({
          type: 'system', subtype: 'log_growth_skipped',
          note: `${want} bytes appended faster than SSE could broadcast — content on disk`,
          bytes: want,
        });
        const envelope = `data: ${JSON.stringify({ project: name, line: skipMsg })}\n\n`;
        for (const res of [...stream.subscribers]) {
          if (res.writableEnded || res.destroyed) { stream.subscribers.delete(res); continue; }
          try { res.write(envelope); }
          catch { stream.subscribers.delete(res); try { res.destroy(); } catch {} }
        }
        return;
      }
      const buf = Buffer.alloc(want);
      const fd = fs.openSync(logPath, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, stream.offset); }
      finally { fs.closeSync(fd); }
      stream.offset = stat.size;
      stream.partial += buf.toString('utf8');
      // Patch 1.1 (extended): CRLF-tolerant line split. claude.exe on
      // Windows sometimes emits CRLF; a bare `\n` split leaves trailing
      // `\r` that breaks downstream JSON.parse silently.
      const lines = stream.partial.split(/\r?\n/);
      stream.partial = lines.pop() ?? '';
      // Maximum size of a single JSONL line we'll broadcast as an SSE
      // event. Tool results that embed binary content base64-encoded
      // (e.g. attaching an 80 MB APK) produce 100+ MB lines that, when
      // multiplied by JSON serialization + per-client copies + write
      // backpressure, can exhaust heap and trigger OS-level OOM kills
      // with no Node-side trace. Anything bigger than this cap is
      // replaced with a synthetic notice — the actual content stays in
      // the JSONL log on disk for the focused panel to fetch.
      const SSE_LINE_MAX = 1_000_000; // 1 MB
      for (const line of lines) {
        if (!line) continue;
        let outLine = line;
        if (outLine.length > SSE_LINE_MAX) {
          debugLog(`fleet ${name} SSE line dropped (size=${outLine.length} > ${SSE_LINE_MAX})`);
          // Synthetic placeholder so the client knows something was
          // emitted but doesn't get the giant payload.
          outLine = JSON.stringify({
            type: 'system',
            subtype: 'oversized_line_skipped',
            note: 'tool result too large for SSE; check focused panel via /api/project/:name/events',
            size: line.length,
          });
        }
        const envelope = `data: ${JSON.stringify({ project: name, line: outLine })}\n\n`;
        // Broadcast to all live subscribers. A failed write means that one
        // client died — drop it, keep the others. NEVER let one bad
        // socket take down the watcher (which would silence ALL clients).
        for (const res of [...stream.subscribers]) {
          if (res.writableEnded || res.destroyed) {
            stream.subscribers.delete(res);
            continue;
          }
          try { res.write(envelope); }
          catch (e) {
            debugLog(`sse broadcast write failed (${name}): ${e.code || e.message}`);
            stream.subscribers.delete(res);
            try { res.destroy(); } catch {}
          }
        }
        // Audit 1.6: log every tool_use the agent attempted alongside the
        // tools it was authorised to call. Used to convert the "permission
        // deadlock" suspicion into hard data — we expect at least one
        // attempted ⊄ allowed mismatch per "agent figé" symptom.
        auditToolUse(name, line);

        // v6: NEEDS_CHEF_INPUT auto-relay. Parse the line once for both
        // directions (musician→chef, chef→musician). Cost amortises since
        // we already inspect the line for audit; one JSON.parse per line.
        if (line.length < 1_000_000) {
          let parsedEv = null;
          if (line.includes('NEEDS_CHEF_INPUT:') || (name === conductorName() && line.includes('"type":"result"'))) {
            try { parsedEv = JSON.parse(line); } catch {}
          }
          // Un result fantôme porte le texte du tour PRÉCÉDENT : le relayer
          // renverrait une réponse du chef déjà transmise (sa clé de dédupe
          // `sid:0` est neuve) ou redemanderait une décision déjà prise.
          if (parsedEv && !isPhantomResult(parsedEv)) {
            if (name !== conductorName()) {
              const q = extractNeedsChefInput(parsedEv);
              if (q) maybeDispatchChefQuestion(name, q);
            } else {
              maybeRelayChefAnswer(parsedEv);
            }
          }
        }
      }
    }
  };

  const watcher = chokidar.watch(logPath, logWatchOpts());
  watcher.on('add', pump);
  watcher.on('change', pump);
  watcher.on('error', (e) => debugLog(`watch ${name} ERROR ${e.message}`));
  stream.watcher = watcher;
  fleetStreams.set(name, stream);
  debugLog(`fleet watcher attach ${name}`);
  return stream;
}

// Create watchers for every project at boot. Cheap (one chokidar per file)
// and shared across all SSE clients.
for (const p of config.projects) fleetEnsureProject(p.name);

// ── Hot config reload ───────────────────────────────────────────────────────
// Adding/removing a musician in config.json is now picked up WITHOUT restarting
// the server: the file is watched (chokidar, so the atomic temp+rename of
// atomicWriteJson is handled) AND polled every 3s as a fallback. On a real
// change we re-read it (robust to a half-written / invalid JSON — the last good
// list is kept and we retry), reconcile the in-memory project list + per-project
// streams, subscribe already-connected dashboards to any new stream, and push a
// `fleet_config_changed` signal so they re-fetch /api/config. dispatch.mjs
// already reads config.json fresh per dispatch, so it is unaffected.
let lastConfigRaw = null;
try { lastConfigRaw = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch {}

function broadcastFleetConfigChanged() {
  const payload = `data: ${JSON.stringify({ type: 'fleet_config_changed' })}\n\n`;
  for (const res of [...fleetSseClients]) {
    if (res.writableEnded || res.destroyed) { fleetSseClients.delete(res); continue; }
    try { res.write(payload); } catch { fleetSseClients.delete(res); }
  }
}

function reloadConfigFromDisk() {
  let raw;
  try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); }
  catch (e) { console.error(`[config-reload] read failed — keeping current list (${e.message})`); return; }
  if (raw === lastConfigRaw) return;                 // unchanged — nothing to do

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.projects)) throw new Error('projects is not an array');
    if (parsed.projects.some(p => !p || typeof p.name !== 'string' || !p.name)) throw new Error('a project entry has no name');
  } catch (e) {
    // Half-written or broken JSON: do NOT crash and do NOT clobber the list.
    // lastConfigRaw stays as-is so the next stable write is retried.
    console.error(`[config-reload] invalid config.json — keeping current list (${e.message})`);
    return;
  }
  lastConfigRaw = raw;

  const before = new Set(config.projects.map(p => p.name));
  const after  = new Set(parsed.projects.map(p => p.name));
  const added   = [...after].filter(n => !before.has(n));
  const removed = [...before].filter(n => !after.has(n));
  const conductorChanged = typeof parsed.conductor === 'string' && parsed.conductor !== config.conductor;
  const uiBefore = JSON.stringify(uiFlags());
  config.ui = parsed.ui && typeof parsed.ui === 'object' ? parsed.ui : undefined;
  const uiChanged = JSON.stringify(uiFlags()) !== uiBefore;

  // Refresh the in-memory config IN PLACE (config is a shared const object;
  // routes and handlers hold it by reference). Also keep PROJECT_NAMES in sync.
  config.projects.length = 0;
  for (const p of parsed.projects) config.projects.push(p);
  if (typeof parsed.conductor === 'string') config.conductor = parsed.conductor;
  PROJECT_NAMES.clear();
  for (const p of config.projects) PROJECT_NAMES.add(p.name);

  // Reconcile per-project streams: ensure one per current project, drop the rest.
  for (const p of config.projects) fleetEnsureProject(p.name);
  for (const name of [...fleetStreams.keys()]) {
    if (!after.has(name)) {
      const s = fleetStreams.get(name);
      try { s.watcher.close().catch(() => {}); } catch {}
      fleetStreams.delete(name);
      debugLog(`fleet watcher detach ${name} (removed from config)`);
    }
  }
  // Subscribe already-connected dashboards to the newly-added project streams
  // (they only auto-subscribe at connect time).
  for (const name of added) {
    const s = fleetStreams.get(name);
    if (s) for (const res of fleetSseClients) s.subscribers.add(res);
  }
  // Free per-project in-memory state for removed projects.
  for (const name of removed) { musicianAutoStates.delete(name); dispatchQueue.delete(name); }

  if (added.length || removed.length || conductorChanged || uiChanged) {
    console.log(`[config-reload] hot: +[${added.join(', ')}] -[${removed.join(', ')}]${conductorChanged ? ` conductor=${config.conductor}` : ''}${uiChanged ? ` ui=${JSON.stringify(uiFlags())}` : ''}`);
    broadcastFleetConfigChanged();
  }
}

// Fast path: react within ~300ms of a config.json write.
let _cfgReloadTimer = null;
const scheduleConfigReload = () => { clearTimeout(_cfgReloadTimer); _cfgReloadTimer = setTimeout(reloadConfigFromDisk, 150); };
const configWatcher = chokidar.watch(CONFIG_PATH, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
});
configWatcher.on('add', scheduleConfigReload);
configWatcher.on('change', scheduleConfigReload);
configWatcher.on('unlink', () => console.error('[config-reload] config.json disappeared — keeping current list'));
configWatcher.on('error', (e) => console.error(`[config-reload] watch error: ${e.message}`));
// Fallback poll (reliable even if fs events are missed on some filesystems).
setInterval(reloadConfigFromDisk, 3000).unref();

app.get('/api/sse/fleet', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');
  SSE_CLIENT_COUNT++;
  const sseId = (++_reqSeq).toString(36);
  const sseIp = normalizeAddr(req.socket.remoteAddress);
  const sseStart = Date.now();
  debugLog(`sse#${sseId} OPEN ip=${sseIp} count=${SSE_CLIENT_COUNT}`);

  // Subscribe this res to every project's shared stream. Pure Set.add —
  // no new chokidar watchers created.
  for (const name of config.projects.map(p => p.name)) {
    fleetEnsureProject(name).subscribers.add(res);
  }
  fleetSseClients.add(res);   // so hot config-reload can reach this dashboard

  const cleanup = () => {
    for (const s of fleetStreams.values()) s.subscribers.delete(res);
    fleetSseClients.delete(res);
    try { if (!res.destroyed) res.destroy(); } catch {}
  };
  res.on('close', () => {
    SSE_CLIENT_COUNT = Math.max(0, SSE_CLIENT_COUNT - 1);
    cleanup();
    debugLog(`sse#${sseId} CLOSE after=${Date.now()-sseStart}ms count=${SSE_CLIENT_COUNT}`);
  });
  res.on('error', (e) => {
    debugLog(`sse#${sseId} ERROR ${e.code || e.message}`);
    cleanup();
  });
  // Defense-in-depth: errors can surface on req or its underlying socket
  // before they appear on res. Without these listeners, a socket-level
  // EPIPE / ECONNRESET / aborted upload becomes an unhandled 'error'
  // event → uncaughtException → process exit. Each listener just logs
  // and triggers cleanup; the actual close handlers do the real work.
  req.on('error', (e) => {
    debugLog(`sse#${sseId} req ERROR ${e.code || e.message}`);
    cleanup();
  });
  req.on('aborted', () => {
    debugLog(`sse#${sseId} req ABORTED`);
    cleanup();
  });
  // Underlying TCP socket can emit 'error' / 'close' that don't always
  // bubble to req or res in older Node versions.
  if (req.socket) {
    req.socket.on('error', (e) => {
      debugLog(`sse#${sseId} socket ERROR ${e.code || e.message}`);
      cleanup();
    });
  }

  // Per-client heartbeat ping (15s). Cheaper than per-client watchers.
  const hb = setInterval(() => {
    if (res.writableEnded || res.destroyed) { clearInterval(hb); return; }
    try { res.write(': ping\n\n'); }
    catch { clearInterval(hb); cleanup(); try { res.destroy(); } catch {} }
  }, 15000);
  res.on('close', () => clearInterval(hb));
});

// ---------- Session attachment (per-project pickers) ------------------------
//
// Claude Code stores each session as <uuid>.jsonl under
//   ~/.claude/projects/<encoded-cwd>/
// where the encoding replaces : \ / . with '-' (no collapsing). Example:
//   I:\Dev\BookHaven  →  I--Dev-BookHaven
//   I:\Dev\BookHaven\.claude-worktrees\x  →  I--Dev-BookHaven--claude-worktrees-x
//
// The picker lists those sessions (id + mtime + first user-message preview +
// git branch if available) so the user can attach one to our panel with a
// single click. Attaching = writing logs/<name>.session. `dispatch.mjs` then
// passes --resume <sid> on the next turn.

function encodeClaudeProjectDir(p) {
  return String(p).replace(/[:\\/.]/g, '-');
}

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractUserText(ev) {
  if (!ev?.message) return null;
  const c = ev.message.content;
  if (typeof c === 'string') return c.replace(/\s+/g, ' ');
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b?.type === 'text' && b.text) return b.text.replace(/\s+/g, ' ');
      if (typeof b === 'string') return b.replace(/\s+/g, ' ');
    }
  }
  return null;
}

/**
 * Scan the head and (if the file is large) the tail of a session JSONL to
 * return a richer summary than first-user-message alone.  Gives the picker
 * enough info to answer "which session should I resume?":
 *   · preview      — first user message (sets the topic)
 *   · lastMessage  — most recent user message (where the thread was last
 *                    when the user walked away / tab closed)
 *   · approxTurns  — count of assistant events seen in head+tail (lower
 *                    bound; exact count would need a full scan).
 *   · startedAt    — first event timestamp
 *   · gitBranch    — git branch at session start
 */
function readSessionSummary(filePath, size) {
  const HEAD = 32 * 1024;
  const TAIL = 32 * 1024;

  let firstUser = null;
  let lastUser = null;
  let startedAt = null;
  let gitBranch = null;
  let userCount = 0;
  let assistantCount = 0;

  function scan(text, { skipFirst = false } = {}) {
    const lines = text.split('\n');
    if (skipFirst && lines.length > 1) lines.shift();  // drop partial line at seek boundary
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (!startedAt && typeof ev.timestamp === 'string') startedAt = ev.timestamp;
      if (!gitBranch && typeof ev.gitBranch === 'string') gitBranch = ev.gitBranch;
      if (ev.type === 'user') {
        userCount++;
        const t = extractUserText(ev);
        if (t) {
          if (!firstUser) firstUser = t;
          lastUser = t;
        }
      } else if (ev.type === 'assistant') {
        assistantCount++;
      }
    }
  }

  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const headLen = Math.min(HEAD, size);
      const headBuf = Buffer.alloc(headLen);
      fs.readSync(fd, headBuf, 0, headLen, 0);
      scan(headBuf.toString('utf8'));

      if (size > HEAD + TAIL) {
        const tailStart = size - TAIL;
        const tailBuf = Buffer.alloc(TAIL);
        fs.readSync(fd, tailBuf, 0, TAIL, tailStart);
        scan(tailBuf.toString('utf8'), { skipFirst: true });
      } else if (size > HEAD) {
        // mid-zone — read the rest in one go
        const restLen = size - HEAD;
        const restBuf = Buffer.alloc(restLen);
        fs.readSync(fd, restBuf, 0, restLen, HEAD);
        scan(restBuf.toString('utf8'), { skipFirst: true });
      }
    } finally { fs.closeSync(fd); }
  } catch {
    return { preview: null, lastMessage: null, gitBranch: null, startedAt: null, approxTurns: 0 };
  }

  return {
    preview: firstUser ? firstUser.slice(0, 180) : null,
    lastMessage: lastUser && lastUser !== firstUser ? lastUser.slice(0, 180) : null,
    gitBranch, startedAt,
    approxTurns: assistantCount,
  };
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function listClaudeSessionsForPath(projectPath) {
  const encoded = encodeClaudeProjectDir(projectPath);
  const dir = path.join(CLAUDE_PROJECTS, encoded);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return { encoded, dir, sessions: [] }; }

  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const id = e.name.slice(0, -6);
    if (!SESSION_UUID_RE.test(id)) continue;
    const fp = path.join(dir, e.name);
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    const meta = readSessionSummary(fp, stat.size);
    const liveWindowMs = 120 * 1000;
    out.push({
      id,
      mtime: stat.mtimeMs,
      size: stat.size,
      sizeHuman: humanBytes(stat.size),
      live: (Date.now() - stat.mtimeMs) < liveWindowMs,
      preview: meta.preview,
      lastMessage: meta.lastMessage,
      gitBranch: meta.gitBranch,
      startedAt: meta.startedAt,
      approxTurns: meta.approxTurns,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return { encoded, dir, sessions: out };
}

function requireProject(req, res) {
  const name = req.params.name;
  const proj = config.projects.find(p => p.name === name);
  if (!proj) { res.status(404).json({ error: 'unknown project' }); return null; }
  return proj;
}

// List sessions available for a project (from Claude's local store).
app.get('/api/projects/:name/sessions', (req, res) => {
  const proj = requireProject(req, res);
  if (!proj) return;
  const scan = listClaudeSessionsForPath(proj.path);
  res.json({
    projectName: proj.name,
    projectPath: proj.path,
    encodedDir: scan.encoded,
    attached: sessions.get(proj.name) || null,
    sessions: scan.sessions,
  });
});

// Attach a session (write sidecar). Body: { session_id: "<uuid>" }.
app.post('/api/projects/:name/attach', express.json({ limit: '2kb' }), (req, res) => {
  const proj = requireProject(req, res);
  if (!proj) return;
  const sid = req.body?.session_id;
  if (typeof sid !== 'string' || !SESSION_UUID_RE.test(sid)) {
    return res.status(400).json({ error: 'invalid session_id (expected UUID)' });
  }
  // Sanity check: the session file must actually exist under Claude's store
  // for this project's cwd — prevents attaching a random UUID that will fail
  // when dispatch runs --resume.
  const sessionFile = path.join(CLAUDE_PROJECTS, encodeClaudeProjectDir(proj.path), `${sid}.jsonl`);
  if (!fs.existsSync(sessionFile)) {
    return res.status(404).json({ error: 'session file not found for this project', path: sessionFile });
  }
  fs.writeFileSync(sessionFilePath(proj.name), sid);
  sessions.set(proj.name, sid);
  res.json({ ok: true, attached: sid });
});

// Start a brand-new session — spawn dispatch without --resume, return the new session_id
// once it appears in the sidecar (written by dispatch.mjs within a few seconds of start).
app.post('/api/projects/:name/sessions/new', express.json({ limit: '2mb' }), (req, res) => {
  const proj = requireProject(req, res);
  if (!proj) return;
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  // Delete sidecar so dispatch.mjs skips --resume and starts a fresh session.
  const sidePath = sessionFilePath(proj.name);
  try { fs.unlinkSync(sidePath); } catch {}
  sessions.delete(proj.name);

  const dispatchScript = path.join(__dirname, 'scripts', 'dispatch.mjs');
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  env.ORCH_OBS_ID = observeEntry({ entry: 'session-neuve', project: proj.name, text: prompt }) || '';
  const child = spawn(process.execPath, [dispatchScript, proj.name, '--prompt-stdin'], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env,
    shell: false,
  });
  child.stdin.end(prompt, 'utf8');
  child.unref(); // don't block the server process on the child's lifetime

  // Poll for the sidecar that dispatch.mjs writes after the first stream event.
  let settled = false;
  const POLL_MS = 250;
  const TIMEOUT_MS = 20000;
  const deadline = Date.now() + TIMEOUT_MS;

  function settle(fn) {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    fn();
  }

  // Patch 1.3: async readFile inside setInterval — never blocks the event
  // loop on the per-tick I/O. Re-entry guard prevents two ticks racing if
  // the disk is slow.
  let inFlight = false;
  const poll = setInterval(() => {
    if (settled || inFlight) return;
    inFlight = true;
    fsp.readFile(sidePath, 'utf8').then(raw => {
      inFlight = false;
      if (settled) return;
      const sid = raw.trim();
      if (sid) {
        settle(() => {
          sessions.set(proj.name, sid);
          res.json({ ok: true, session_id: sid });
        });
        return;
      }
      if (Date.now() > deadline) {
        settle(() => res.status(504).json({ error: 'timed out waiting for Claude to start — check logs' }));
      }
    }).catch(() => {
      inFlight = false;
      if (settled) return;
      if (Date.now() > deadline) {
        settle(() => res.status(504).json({ error: 'timed out waiting for Claude to start — check logs' }));
      }
    });
  }, POLL_MS);

  child.on('error', (err) => {
    settle(() => res.status(500).json({ error: `spawn error: ${err.message}` }));
  });

  // If the client disconnects before we resolve (tab closed, navigation), stop
  // polling — the dispatch keeps running; chokidar will eventually update sessions.
  req.on('close', () => settle(() => {}));
});

// Detach the current session (remove sidecar). Next dispatch starts fresh.
app.delete('/api/projects/:name/attach', (req, res) => {
  const proj = requireProject(req, res);
  if (!proj) return;
  try { fs.unlinkSync(sessionFilePath(proj.name)); } catch {}
  sessions.delete(proj.name);
  res.json({ ok: true });
});

// ---------- Callback notify (musician → conductor, no headless claude) ------
//
// When a sub-agent finishes a task it calls scripts/notify.mjs which POSTs
// here instead of spawning a full headless claude turn. The endpoint:
//   1. Appends a synthetic user_prompt event (with source) to the project log.
//   2. Fires a Windows desktop toast so the interactive chef sees it immediately.
//   3. The SSE watcher picks up the new line and the dashboard shows the
//      callback bubble without any AI turn being spawned.

function fireDesktopNotification(source, text) {
  // Best-effort Windows balloon/toast — silently ignored on non-Windows or
  // if PowerShell is unavailable.
  const title = `Orchestre — ${source}`.replace(/'/g, '`');
  const body  = text.replace(/[\r\n]+/g, ' ').replace(/'/g, '`').slice(0, 180);
  const psCmd = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    `$n = New-Object System.Windows.Forms.NotifyIcon;`,
    `$n.Icon = [System.Drawing.SystemIcons]::Information;`,
    `$n.BalloonTipTitle = '${title}';`,
    `$n.BalloonTipText = '${body}';`,
    `$n.BalloonTipIcon = 'Info';`,
    `$n.Visible = $true;`,
    `$n.ShowBalloonTip(8000);`,
    `Start-Sleep -Seconds 2`,   // keep the icon alive long enough for the balloon
  ].join(' ');
  const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  try {
    spawn(psExe, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCmd], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  } catch { /* non-Windows or PS unavailable — ignore */ }
}

// Called by the background watcher when a musician's turn reaches a terminal
// state. Appends ONE coordination event to the conductor's log (the SSE pump
// picks it up instantly) and fires a toast.
//
// The event carries ADDITIVE fields so the dashboard can render a proper result
// CARD (outcome, duration, cost, a real summary) instead of a truncated bubble.
// Older events without them still render — consumers default `outcome` to 'done'.
//
//   outcome: 'done' | 'failed' | 'question' | 'ask_chef'
//   subtype: 'musician_done' (done/failed) | 'musician_question' (question/ask_chef)
//
// `question` = the musician asked the USER (NEEDS_USER_INPUT); `ask_chef` = it
// asked the CHEF (NEEDS_CHEF_INPUT) — the latter is why a finished turn must not
// be announced as plain "terminé".
const OUTCOME_LABEL = {
  done:     'Tour terminé',
  failed:   'Échec',
  question: 'Question',
  ask_chef: 'Demande au chef',
};
function autoNotifyConductor(musicianName, opts = {}) {
  const cName = config.conductor || 'chef';
  if (musicianName === cName) return;
  const outcome = OUTCOME_LABEL[opts.outcome] ? opts.outcome : 'done';
  const summary = typeof opts.summary === 'string' ? opts.summary.trim() : '';
  console.log(`[notify-bg] firing autoNotifyConductor for ${musicianName} (${outcome})`);

  // 1. Write a visual coordination event to the conductor log (for the human).
  const logPath = path.join(LOGS_DIR, `${cName}.jsonl`);
  const text = `[${musicianName}] ${OUTCOME_LABEL[outcome]}.${summary ? ' ' + summary : ''}`;
  const ev = {
    type: 'notification',
    subtype: (outcome === 'question' || outcome === 'ask_chef') ? 'musician_question' : 'musician_done',
    text,
    timestamp: new Date().toISOString(),
    source: musicianName,
    outcome,
    summary,
    ...(Number.isFinite(opts.durationMs) ? { duration_ms: opts.durationMs } : {}),
    ...(Number.isFinite(opts.costUsd)    ? { cost_usd: opts.costUsd }       : {}),
    ...(opts.awaitingChef ? { awaitingChef: true } : {}),
  };
  try {
    fs.appendFileSync(logPath, '\n' + JSON.stringify(ev) + '\n');
  } catch (e) {
    console.error(`[auto-notify] could not write to ${cName}.jsonl: ${e.message}`);
    return;
  }
  fireDesktopNotification(musicianName, text);

  // ROOT FIX (2026-09-09): a musician callback is NO LONGER re-dispatched to the
  // chef as a turn. It previously spawned/queued a headless chef turn whose
  // prompt was the callback text — a source-less `user_prompt` that the dashboard
  // rendered as a *user* message and that forced the chef to "reply for nothing"
  // to every musician completion (old ones also replayed from the persisted
  // queue on restart). A completion is just a musician EVENT: the `musician_done`
  // notification written above (for the human, shown as a musician callback in
  // the dashboard) plus the musician's own `result` already in
  // logs/<project>.jsonl, which the chef reads on its own schedule to synthesize
  // a report to the user. No fake user turn, no forced chef response.
}

// 0.37.2 — la limite était de 2 Ko : tout résumé un peu long (markdown,
// tableaux, accents multi-octets) levait « entity too large », que le
// gestionnaire d'erreurs global renvoyait en 500. D'où le « premier envoi
// échoue, la version courte passe » chez presque tous les musiciens.
const NOTIFY_MAX_BODY = '512kb';
app.post('/api/notify', express.json({ limit: NOTIFY_MAX_BODY }), (req, res) => {
  const { project, text, source } = req.body ?? {};
  if (typeof project !== 'string' || !project) return res.status(400).json({ error: 'missing project' });
  if (typeof text    !== 'string' || !text.trim()) return res.status(400).json({ error: 'missing text' });

  const proj = config.projects.find(p => p.name === project);
  if (!proj) return res.status(404).json({ error: `unknown project "${project}"` });

  const logPath = path.join(LOGS_DIR, `${project}.jsonl`);
  const ev = {
    type: 'user_prompt',
    text: text.trim(),
    timestamp: new Date().toISOString(),
    ...(source && typeof source === 'string' ? { source } : {}),
  };
  try {
    fs.appendFileSync(logPath, '\n' + JSON.stringify(ev) + '\n');
  } catch (err) {
    return res.status(500).json({ error: `could not write log: ${err.message}` });
  }

  if (source) fireDesktopNotification(String(source), text.trim());
  observeEntry({ entry: 'notify', project, text, caller: typeof source === 'string' ? source.slice(0, 64) : undefined });

  res.json({ ok: true });
});

// ---------- Direct dispatch (conductor → musician) -------------------------
//
// The Orchestre UI talks to sub-agents *directly* — no central claude
// routing. POST /api/dispatch with {project, prompt} spawns
// scripts/dispatch.mjs, which turns the prompt into `claude -p --resume
// <sid>`. stream-json events are appended to logs/<project>.jsonl by
// dispatch.mjs; the viewer's /api/sse/fleet picks them up and the panel
// updates live.
//
// We respond 202 Accepted immediately (fire-and-forget) so the UI isn't
// blocked for the whole turn — a sub-agent tour can take minutes.
//
// ---------- Cooperative interrupt + resume ---------------------------------
//
// When a new dispatch arrives for a project that already has a turn in
// flight, we DON'T queue silently. Instead:
//   1. capture the in-flight state from the log tail (last assistant /
//      tool_use, whether the tool got a tool_result back, side-effects
//      hint listing the recent tool calls)
//   2. taskkill the running dispatch tree
//   3. prepend a [SYSTEM_INTERRUPT_RESUME] block to the new prompt so the
//      resumed Claude knows it was cut off and can verify the world state
//      before continuing
//
// Cross-project: each project has its own `.pid` file → checks are
// independent, dispatches to different musicians never block each other
// and never see each other's interrupts. Per-musician parallelism is
// preserved by design.

/** Read the last ~256 KB of a log file and find the most recent
 *  meaningful state for resume hints. Returns:
 *    {
 *      lastToolUse: 'bash | edit | write | …' or null,
 *      lastToolArgs: '<truncated args>' or null,
 *      lastToolStatus: 'completed' | 'in_progress' | 'unknown',
 *      recentToolCalls: ['edit:server.js', 'bash:npm install', …],
 *      lastUserPromptText: '<previous prompt>' or null,
 *    } */
// Synchronous version retained for any caller that runs at boot or in a
// non-hot path. The async version below is used by POST /api/dispatch.
function captureInterruptState(name) {
  const logPath = path.join(LOGS_DIR, `${name}.jsonl`);
  const raw = readFileTail(logPath, 256 * 1024);
  return _captureInterruptStateFromRaw(raw);
}

// Patch 1.3: async hot-path version.
async function captureInterruptStateAsync(name) {
  const logPath = path.join(LOGS_DIR, `${name}.jsonl`);
  const raw = await readFileTailAsync(logPath, 256 * 1024);
  return _captureInterruptStateFromRaw(raw);
}

function _captureInterruptStateFromRaw(raw) {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  if (lines.length > 1) lines.shift();

  // Walk forward but remember the last assistant-tool_use and the last
  // user-prompt encountered. Determine completion: if a `user` event
  // (tool_result) follows the last tool_use_id without an interleaving
  // assistant-tool_use, then it completed.
  let lastToolUse = null;
  let lastToolArgs = null;
  let lastToolUseId = null;
  let toolResultSeen = false;
  const recentToolCalls = [];
  let lastUserPromptText = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'user_prompt' && typeof ev.text === 'string') {
      lastUserPromptText = ev.text;
    } else if (ev.type === 'assistant') {
      const blocks = ev.message?.content || [];
      for (const b of blocks) {
        if (b?.type === 'tool_use') {
          const argSummary = previewToolArgs(b);
          lastToolUse = (b.name || 'tool').toLowerCase();
          lastToolArgs = argSummary;
          lastToolUseId = b.id || null;
          toolResultSeen = false;
          recentToolCalls.push(`${lastToolUse}:${argSummary || ''}`.slice(0, 80));
          if (recentToolCalls.length > 10) recentToolCalls.shift();
        }
      }
    } else if (ev.type === 'user') {
      const blocks = ev.message?.content || [];
      for (const b of blocks) {
        if (b?.type === 'tool_result' && b.tool_use_id && b.tool_use_id === lastToolUseId) {
          toolResultSeen = true;
        }
      }
    } else if (ev.type === 'result') {
      // A `result` closes the turn — there is nothing in flight after this,
      // so any "interrupt" found before this point is irrelevant. Reset.
      lastToolUse = null; lastToolArgs = null; lastToolUseId = null;
      toolResultSeen = false;
      recentToolCalls.length = 0;
    }
  }

  const status = !lastToolUse ? 'unknown'
    : toolResultSeen ? 'completed'
    : 'in_progress';

  return {
    lastToolUse,
    lastToolArgs,
    lastToolStatus: status,
    recentToolCalls,
    lastUserPromptText: lastUserPromptText ? lastUserPromptText.slice(0, 400) : null,
  };
}

function previewToolArgs(block) {
  const i = block.input || {};
  return String(i.file_path || i.path || i.command || i.pattern || '')
    .replace(/\s+/g, ' ').slice(0, 80);
}

/** Format the resume notice prepended to the new user prompt when we
 *  killed a turn in flight. Kept short and actionable — the Claude side
 *  reads it, checks reality, then handles the new instruction. */
function formatInterruptResumeNotice(captured, newPrompt) {
  if (!captured) return newPrompt;
  const parts = [];
  parts.push('[SYSTEM_INTERRUPT_RESUME]');
  parts.push('Ton tour précédent a été interrompu avant complétion par un nouveau message de l\'utilisateur.');
  parts.push('');
  if (captured.lastUserPromptText) {
    parts.push(`Prompt précédent (en cours quand interrompu) : « ${captured.lastUserPromptText} »`);
  }
  if (captured.lastToolUse) {
    const args = captured.lastToolArgs ? ` (${captured.lastToolArgs})` : '';
    parts.push(`Dernière action tentée : ${captured.lastToolUse}${args} — statut : ${captured.lastToolStatus}.`);
  }
  if (captured.recentToolCalls?.length) {
    parts.push(`Actions récentes durant ce tour : ${captured.recentToolCalls.join(', ')}.`);
    parts.push('Ces actions ont pu produire des effets de bord (fichiers modifiés, processus lancés, commits faits) qui PERSISTENT après l\'interrupt.');
  }
  parts.push('');
  parts.push('Avant d\'agir : vérifie l\'état réel (lis les fichiers concernés, `git status`, `ls`, etc.) plutôt que de te fier à ta mémoire de ce tour. Puis décide : reprendre, retry idempotent, rollback, ou pivoter selon les nouvelles instructions.');
  parts.push('');
  parts.push('---');
  parts.push('Nouveau message de l\'utilisateur :');
  parts.push(newPrompt);
  return parts.join('\n');
}

/** Read the .pid sidecar and check if the process is alive AND the
 *  sidecar isn't suspiciously stale.
 *
 *  Previously we ran `tasklist /FI "PID eq <n>"` to verify the PID is a
 *  claude.exe (defending against PID recycling). That synchronous spawn
 *  cost 2-3 SECONDS on a machine with many processes — enough to freeze
 *  the entire event loop and queue up events that crashed the server
 *  on resume (29 avr. 11:05 incident). We now use a fast strategy:
 *
 *    1. process.kill(pid, 0) — sub-microsecond liveness check
 *    2. .pid file mtime ≤ 12h old — dispatch.mjs writes the file at
 *       spawn time and a turn never lasts > 12h ; an older mtime means
 *       the file is leftover from a crashed dispatch and the PID
 *       (likely recycled) shouldn't be trusted.
 *
 *  This catches 99.9% of the stale-PID-recycled-to-something-else bug
 *  without freezing the server. */
const STALE_PID_MS = 12 * 60 * 60 * 1000;
function dispatchPidAlive(name) {
  const pidPath = path.join(LOGS_DIR, `${name}.pid`);
  let pid, mtimeMs;
  try {
    const st = fs.statSync(pidPath);
    mtimeMs = st.mtimeMs;
    pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  } catch { return null; }
  return _dispatchPidAliveCheck(name, pidPath, pid, mtimeMs);
}

// Patch 1.3: async hot-path version. Same semantics, fs.promises everywhere.
async function dispatchPidAliveAsync(name) {
  const pidPath = path.join(LOGS_DIR, `${name}.pid`);
  let pid, mtimeMs;
  try {
    const st = await fsp.stat(pidPath);
    mtimeMs = st.mtimeMs;
    const raw = await fsp.readFile(pidPath, 'utf8');
    pid = Number(raw.trim());
  } catch { return null; }
  return _dispatchPidAliveCheck(name, pidPath, pid, mtimeMs);
}

function _dispatchPidAliveCheck(name, pidPath, pid, mtimeMs) {
  if (!Number.isFinite(pid) || pid <= 0) return null;

  // Stale-file gate: if the .pid was written more than 12h ago, the
  // process that created it almost certainly isn't running anymore;
  // any "alive" PID at this number is recycled. Clean and bail.
  if (Date.now() - mtimeMs > STALE_PID_MS) {
    debugLog(`dispatch ${name} pid file stale (${Math.round((Date.now()-mtimeMs)/1000)}s) — unlinking`);
    try { fs.unlinkSync(pidPath); } catch {}
    return null;
  }

  // Cheap kernel-level liveness check, no external process spawn.
  try { process.kill(pid, 0); return pid; }
  catch (e) {
    if (e.code === 'EPERM') return pid;     // exists, just no permission
    // ESRCH or anything else → process gone. Clean the file.
    try { fs.unlinkSync(pidPath); } catch {}
    return null;
  }
}

/** taskkill the dispatch tree for a project (Windows). FIRE AND FORGET —
 *  spawn detached so the kill happens in background, freeing the event
 *  loop immediately. Caller doesn't need to wait: the kill is best-effort
 *  and we don't care exactly when it lands, only that it lands eventually.
 *  Returns true if the kill was queued, false on syscall error. */
function killDispatchTree(name, pid) {
  if (process.platform === 'win32') {
    try {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      child.unref();
      return true;
    } catch { return false; }
  }
  try { process.kill(-pid, 'SIGKILL'); return true; }
  catch { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } }
}

app.post('/api/dispatch', express.json({ limit: '2mb' }), async (req, res) => {
  // Patch 1.3: handler is async so the hot-path I/O (dispatchPidAliveAsync,
  // captureInterruptStateAsync) doesn't block the event loop. Catch any
  // unhandled error to keep Express happy on Node 20+.
  try {
  const name       = req.body?.project;
  const prompt     = req.body?.prompt;
  const rawPaths   = req.body?.attachmentPaths;
  const rawVideos  = req.body?.videoPaths;

  if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'missing project' });
  if (typeof prompt !== 'string') return res.status(400).json({ error: 'missing prompt' });

  // Allow empty prompt only when attachments are present.
  const hasPaths  = Array.isArray(rawPaths)  && rawPaths.length > 0;
  const hasVideos = Array.isArray(rawVideos) && rawVideos.length > 0;
  if (!prompt.trim() && !hasPaths && !hasVideos) return res.status(400).json({ error: 'empty prompt' });

  // Validate every attachment path is inside ATTACHMENTS_DIR to prevent
  // path-traversal: client must have uploaded via /api/attach/image first.
  function validatePaths(rawList) {
    const out = [];
    for (const p of rawList) {
      if (typeof p !== 'string') continue;
      const resolved = path.resolve(p);
      if (!resolved.startsWith(ATTACHMENTS_DIR + path.sep) && resolved !== ATTACHMENTS_DIR) {
        return { error: `invalid attachment path: ${p}` };
      }
      out.push(resolved);
    }
    return { paths: out };
  }

  const attachmentPaths = [];
  if (hasPaths) {
    const { paths, error } = validatePaths(rawPaths);
    if (error) return res.status(400).json({ error });
    attachmentPaths.push(...paths);
  }

  const videoPaths = [];
  if (hasVideos) {
    const { paths, error } = validatePaths(rawVideos);
    if (error) return res.status(400).json({ error });
    videoPaths.push(...paths);
  }

  const proj = config.projects.find(p => p.name === name);
  if (!proj) return res.status(404).json({ error: `unknown project "${name}"` });

  // Pipelines, phase 1 : l'entrée est classée et journalisée (aucun effet).
  // Venue de dispatch.mjs, elle porte déjà son identifiant d'observation.
  let obsId = typeof req.body?.obsId === 'string' && OBS_ID_RE.test(req.body.obsId) ? req.body.obsId : null;
  if (!obsId) {
    const isChef = name === conductorName();
    const mention = isChef ? /^@(\S+)/.exec(prompt.trim()) : null;
    obsId = observeEntry({
      entry: `${clientOf(req)}:${isChef ? (mention ? 'mention' : 'chef') : 'musicien'}`,
      project: name, text: prompt, target: mention ? mention[1] : undefined,
    });
  }

  // ── Un musicien occupé n'est JAMAIS interrompu par un chef (0.22.0) ───────
  //
  // `dispatch.mjs` ne regardait pas le `.pid` de sa cible : deux dispatches
  // rapprochés lançaient deux `claude --resume` sur LA MÊME session. Avec un
  // seul chef c'était déjà un risque de corruption de session ; avec trois ce
  // serait la règle. `dispatch.mjs --queue-if-busy` poste donc ici, et la file
  // par musicien qui existe déjà (`dispatchQueue`) fait le travail — en
  // portant désormais le callback, la source et le model du dispatch.
  if (req.body?.queueIfBusy === true && name !== conductorName()) {
    const busy = await dispatchPidAliveAsync(name);
    const entry = {
      prompt, attachmentPaths, videoPaths,
      callback: typeof req.body?.callback === 'string' ? req.body.callback : undefined,
      source:   typeof req.body?.source   === 'string' ? req.body.source   : undefined,
      model:    typeof req.body?.model    === 'string' ? req.body.model    : undefined,
      provider: typeof req.body?.provider === 'string' ? req.body.provider : undefined,
      // Quel tour de chef attend ce résultat. Inutile avec un seul chef, mais
      // le conserver DANS la file est ce qui fera revenir le point au bon chef
      // en P0-B : une entrée qui a patienté ne doit rien perdre de son origine.
      slot:     Number.isFinite(Number(req.body?.slot)) && Number(req.body.slot) > 0 ? Number(req.body.slot) : undefined,
      ticket:   typeof req.body?.ticket   === 'string' ? req.body.ticket   : undefined,
      // --new-session : ne prend effet qu'au LANCEMENT de l'entrée (0.27.0).
      newSession: req.body?.newSession === true ? true : undefined,
      obsId: obsId || undefined,
    };
    if (busy) {
      const len = queuePush(name, entry);
      const id = dispatchQueue.get(name)[len - 1].id;
      console.log(`[queue] ${name} occupé (pid=${busy}) — dispatch mis en file (pos=${len}, id=${id})`);
      return res.status(202).json({ ok: true, queued: true, project: name, queueLength: len, position: len, id });
    }
    const pid = spawnDirectDispatch(name, prompt, attachmentPaths, videoPaths, entry);
    return res.status(202).json({ ok: true, direct: true, project: name, pid });
  }

  // ── Direct @mention shortcut ─────────────────────────────────────────────
  // If the message is sent to the conductor AND starts with "@musicianX",
  // route it straight to musicianX — no conductor turn needed when the
  // target is explicit and unambiguous. If musicianX is busy (live/think)
  // the message is queued and dispatched automatically when it finishes.
  if (name === conductorName()) {
    const m = /^@(\S+)/i.exec(prompt.trim());
    const directProj = m && config.projects.find(
      p => p.name !== conductorName() && p.name.toLowerCase() === m[1].toLowerCase()
    );
    if (directProj) {
      const stripped = prompt.trim().replace(/^@\S+\s*/i, '').trim() || prompt;
      // v6 fix: append a synthetic user_prompt to chef's log so the conductor
      // sees @-routed questions in its transcript when it wakes up. NOT a
      // dispatched turn — just visibility for context. Without this, chef
      // receives the musician's callback later with zero idea who asked.
      try {
        const chefLogPath = path.join(LOGS_DIR, `${conductorName()}.jsonl`);
        const synth = {
          type: 'user_prompt',
          text: `@${directProj.name} ${stripped}`,
          timestamp: new Date().toISOString(),
          source: `shortcut→${directProj.name}`,
        };
        fs.appendFileSync(chefLogPath, JSON.stringify(synth) + '\n');
      } catch (e) {
        debugLog(`shortcut log → chef failed: ${e.message}`);
      }
      const st = musicianAutoStates.get(directProj.name)?.state ?? 'idle';
      if (st === 'live' || st === 'think') {
        const len = queuePush(directProj.name, { prompt: stripped, attachmentPaths, videoPaths, obsId: obsId || undefined });
        const id = dispatchQueue.get(directProj.name)[len - 1].id;
        console.log(`[queue] queued for ${directProj.name} (pos=${len}, state=${st}, id=${id})`);
        return res.status(202).json({
          ok: true, queued: true, project: directProj.name, queueLength: len, id,
        });
      }
      const pid = spawnDirectDispatch(directProj.name, stripped, attachmentPaths, videoPaths, { obsId });
      console.log(`[queue] direct dispatch to ${directProj.name} (state=${st}) pid=${pid}`);
      return res.status(202).json({ ok: true, direct: true, project: directProj.name, pid });
    }
  }

  // Mint a trace_id for this request — every observable state transition
  // below logs to logs/traces.jsonl tagged with this id.
  const traceId = newTraceId();
  const requestInTs = Date.now();
  debugLog(`dispatch trace=${traceId} project=${name} prompt_chars=${(prompt||'').length} attach=${hasPaths || hasVideos}`);
  traceWrite({
    trace: traceId, event: 'request_in', project: name,
    prompt_chars: (prompt || '').length,
    has_attachments: hasPaths || hasVideos,
  });

  // v5: !interrupt explicit override — detected pre-classifier so it's
  // deterministic and zero-latency. The body flag `force_interrupt: true`
  // is the API-equivalent. When either fires, we strip the prefix from
  // the prompt and force the cooperative-interrupt path below to run
  // unconditionally — no resume notice, the user's intent is explicit.
  const overrideDetected = detectOverride(prompt);
  const forceFlag = req.body?.force_interrupt === true;
  const isOverride = overrideDetected.override || forceFlag;
  const promptForRouting = overrideDetected.override ? overrideDetected.stripped : prompt;
  if (isOverride) {
    const stamp = new Date().toISOString();
    const routerLine = path.join(LOGS_DIR, `router-${stamp.slice(0, 10)}.ndjson`);
    const record = {
      ts: stamp,
      decision: 'interrupt',
      reason: 'explicit_override',
      source: 'production',
      agent_id: name,
      prompt_excerpt: (promptForRouting || '').slice(0, 80),
      in_flight_turn_age_ms: null,
      queue_depth_after: 0,
      override_source: overrideDetected.override ? 'prefix' : 'api_flag',
      trace_id: traceId,
    };
    try { fs.appendFileSync(routerLine, JSON.stringify(record) + '\n'); } catch {}
    traceWrite({ trace: traceId, event: 'override', project: name, source: record.override_source });
    debugLog(`dispatch trace=${traceId} explicit override (${record.override_source})`);
  }

  // ── Le chef passe par la FILE DE DIRECTION (0.22.0) ──────────────────────
  //
  // Le changement de fond de P0-A : un message qui arrive pendant un tour du
  // chef ne le TUE plus. Il devient un ticket et attend son tour. Interrompre
  // reste possible — mais c'est un geste explicite (`!interrupt`,
  // `force_interrupt:true`), et il est traité ici : on tue le tour en vol puis
  // on met le ticket EN TÊTE de file (il remplace le tour qu'il vient de
  // doubler, il n'attend pas derrière ceux qui patientaient).
  if (name === conductorName()) {
    let interruptedSlot = null;
    if (isOverride) {
      const slotNum = Number(req.body?.slot) || 1;
      const r = poolInterruptSlot(slotNum, 'user', /* reschedule */ false);
      if (r.ok && r.killed) {
        interruptedSlot = slotNum;
        traceWrite({ trace: traceId, event: 'interrupt', project: name, prev_pid: r.pid, override: true, slot: slotNum });
      }
    }
    const ticket = poolEnqueue({
      obsId: obsId || undefined,
      class: 'user',
      text: isOverride ? promptForRouting : prompt,
      attachmentPaths, videoPaths,
      traceId,
      interrupting: interruptedSlot != null,
      front: isOverride,
      pinnedSlot: Number(req.body?.replyToSlot) || null,
    });
    traceWrite({
      trace: traceId, event: 'pool_enqueued', project: name,
      ticket: ticket.id, position: poolPosition(ticket.id), interrupting: ticket.interrupting,
    });
    const s = poolFindRunning(ticket.id);
    return res.status(202).json({
      ok: true, project: name, ticket: ticket.id, class: 'user',
      slot: s ? s.slot : null,
      position: poolPosition(ticket.id),
      poolSize: poolSize(),
      interrupting: ticket.interrupting,
      trace_id: traceId,
    });
  }

  // Cooperative interrupt: if a turn is already in flight for THIS project
  // (and only this project — other musicians keep going untouched), capture
  // the in-flight state, kill the running tree, and prepend a resume notice
  // to the new prompt so Claude at --resume time knows it was interrupted
  // and verifies the world before continuing.
  let interrupted = false;
  // v5: when override fires, the prompt the agent sees is the stripped
  // remainder (no [SYSTEM_INTERRUPT_RESUME] block — user's intent is
  // unambiguous so we don't need to coach the agent). When no override,
  // legacy behavior: capture state and prepend resume notice.
  let effectivePrompt = isOverride ? promptForRouting : prompt;
  const livePid = await dispatchPidAliveAsync(name);
  debugLog(`dispatch trace=${traceId} livePidCheck=${livePid ?? 'none'} override=${isOverride}`);
  if (livePid) {
    const captured = isOverride ? null : await captureInterruptStateAsync(name);
    debugLog(`dispatch trace=${traceId} interrupt-attempt pid=${livePid}`);
    const killed = killDispatchTree(name, livePid);
    if (killed) {
      interrupted = true;
      crashLog(`interrupt: project=${name} pid=${livePid} lastTool=${captured?.lastToolUse || 'none'} status=${captured?.lastToolStatus || 'unknown'} override=${isOverride}`);
      debugLog(`dispatch trace=${traceId} interrupted pid=${livePid} ok`);
      traceWrite({
        trace: traceId, event: 'interrupt', project: name,
        prev_pid: livePid,
        prev_trace: projectTrace.get(name) || null,
        last_tool: captured?.lastToolUse || null,
        last_tool_status: captured?.lastToolStatus || null,
        override: isOverride,
      });
      try { fs.unlinkSync(path.join(LOGS_DIR, `${name}.pid`)); } catch {}
      if (!isOverride) effectivePrompt = formatInterruptResumeNotice(captured, prompt);
    }
  }

  // Tag this project's current trace so the SSE watcher attributes its
  // observed events (turn_started, tool_called, result) to this request.
  projectTrace.set(name, traceId);

  const dispatchScript = path.join(__dirname, 'scripts', 'dispatch.mjs');

  // When attachments are present, send a JSON envelope on stdin so dispatch.mjs
  // can extract the prompt, image paths, and video paths cleanly.
  // Plain-text stdin is kept for backward compatibility (no attachments).
  const hasAny = attachmentPaths.length || videoPaths.length;
  const stdinPayload = hasAny
    ? JSON.stringify({ prompt: effectivePrompt, attachmentPaths, videoPaths })
    : effectivePrompt;

  // Patch 1.7: time-since-last-dispatch is the key signal for the future
  // hybrid WARM-pool decision in Phase 5. Captured once per dispatch.
  const prevAt = lastDispatchAt.get(name) || null;
  const timeSinceLastMs = prevAt ? (requestInTs - prevAt) : null;
  lastDispatchAt.set(name, requestInTs);

  const spawnStartTs = Date.now();
  // `newSession: true` dans le corps = --new-session (0.27.0) ; argv en tableau.
  const dispatchArgs = [dispatchScript, name, '--prompt-stdin'];
  if (req.body?.newSession === true) dispatchArgs.push('--new-session');
  const child = spawn(process.execPath, dispatchArgs, {
    cwd: __dirname,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      // Patch 1.7: pipe instrumentation context to the child so its
      // per-dispatch NDJSON line is self-contained.
      DISPATCH_TRACE_ID: traceId,
      DISPATCH_INTERRUPTED: interrupted ? '1' : '0',
      DISPATCH_TIME_SINCE_LAST_MS: timeSinceLastMs == null ? '' : String(timeSinceLastMs),
      DISPATCH_REQUEST_IN_TS: String(requestInTs),
      ORCH_OBS_ID: obsId || '',
    },
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    detached: false,
  });
  const spawnMs = Date.now() - spawnStartTs;
  debugLog(`dispatch trace=${traceId} spawned pid=${child.pid} spawn_ms=${spawnMs}`);
  traceWrite({
    trace: traceId, event: 'dispatch_spawned', project: name, pid: child.pid,
    interrupted, spawn_ms: spawnMs, time_since_last_dispatch_ms: timeSinceLastMs,
  });
  child.on('error', (err) => {
    console.error('[dispatch] spawn error:', err.message);
    debugLog(`dispatch trace=${traceId} spawn-error: ${err.message}`);
    traceWrite({ trace: traceId, event: 'spawn_error', project: name, error: err.message });
  });
  // Patch 1.4: handle both `exit` and `close` idempotently. `close` fires
  // after stdio streams are closed; `exit` fires on process termination.
  // Either may fire first depending on OS scheduling.
  let lifecycleLogged = false;
  const onLifecycleEnd = (code, signal, ev) => {
    if (lifecycleLogged) return;
    lifecycleLogged = true;
    debugLog(`dispatch trace=${traceId} pid=${child.pid} ${ev} code=${code} signal=${signal}`);
    traceWrite({ trace: traceId, event: 'dispatch_exited', project: name, code, signal, via: ev });
  };
  child.on('exit',  (code, signal) => onLifecycleEnd(code, signal, 'exit'));
  child.on('close', (code, signal) => onLifecycleEnd(code, signal, 'close'));
  child.stdin.end(stdinPayload);

  res.status(202).json({ ok: true, project: name, pid: child.pid, interrupted, trace_id: traceId });
  } catch (err) {
    console.error('[dispatch] handler error:', err);
    debugLog(`dispatch handler error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ---------- Add / remove a project at runtime ------------------------------
//
// The original brief had the project list come from config.json at boot time.
// This endpoint pair lets the user add/remove projects without restarting:
//   - POST /api/projects                → { name, path, model?, tools? }
//   - GET  /api/projects/candidates     → scan I:\Dev for unclaimed dirs
//   - DELETE /api/projects/:name        → remove entry + session sidecar
// config.json is the source of truth and is rewritten atomically on every
// mutation so nothing is lost if the process dies mid-write.

const PROJECT_NAME_RE = /^[A-Za-z][A-Za-z0-9_.\-]{0,63}$/;
const DEV_ROOT = 'I:\\Dev';  // per the global disk-usage policy

function atomicWriteJson(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

// Scan I:\Dev for directories and return those not yet registered in config.
app.get('/api/projects/candidates', (req, res) => {
  let entries;
  try { entries = fs.readdirSync(DEV_ROOT, { withFileTypes: true }); }
  catch (err) { return res.status(500).json({ error: String(err.message) }); }

  const taken = new Set(config.projects.map(p => path.resolve(p.path).toLowerCase()));
  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;   // skip .claude, .claude-history, etc.
    const full = path.join(DEV_ROOT, e.name);
    if (taken.has(path.resolve(full).toLowerCase())) continue;
    // Bonus metadata: does it have a .git or a CLAUDE.md?
    let hasGit = false, hasClaudeMd = false, hasClaude = false;
    try { hasGit = fs.statSync(path.join(full, '.git')).isDirectory(); } catch {}
    try { hasClaudeMd = fs.statSync(path.join(full, 'CLAUDE.md')).isFile(); } catch {}
    try { hasClaude = fs.statSync(path.join(full, '.claude')).isDirectory(); } catch {}
    candidates.push({ name: e.name, path: full, hasGit, hasClaudeMd, hasClaude });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ root: DEV_ROOT, candidates });
});

// Add a project. Body: { name, path, model?, tools? }
app.post('/api/projects', express.json({ limit: '4kb' }), (req, res) => {
  const { name, path: projPath, model, tools } = req.body || {};
  if (typeof name !== 'string' || !PROJECT_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'invalid name (letters/digits/_.-, 1–64, must start with a letter)' });
  }
  if (typeof projPath !== 'string' || projPath.length < 3) {
    return res.status(400).json({ error: 'invalid path' });
  }
  // Previously we restricted every project to live under I:\Dev per the
  // global disk-usage policy.  That still holds as a *default* for the
  // candidate scanner, but the user has legitimate cases where the
  // source of truth for a project lives elsewhere (external drive, a
  // worktree, etc.) — we accept any existing directory and leave the
  // policy as guidance.
  const normalized = path.resolve(projPath);
  const normalizedLower = normalized.toLowerCase();
  let stat;
  try { stat = fs.statSync(normalized); }
  catch { return res.status(400).json({ error: 'path does not exist' }); }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'path is not a directory' });

  const isConductor = req.body?.isConductor === true;

  // If a project with this name OR path is already registered, and the
  // caller ticked "is conductor", treat the call as a promotion rather
  // than a creation: switch config.conductor to that existing project
  // and return ok. This lets the user reuse the Add panel to re-assign
  // the chef without having to first delete the project.
  const byName = config.projects.find(p => p.name === name);
  const byPath = config.projects.find(p => path.resolve(p.path).toLowerCase() === normalizedLower);
  const existing = byName || byPath;
  if (existing) {
    if (isConductor) {
      const prevConductor = config.conductor;
      config.conductor = existing.name;
      atomicWriteJson(CONFIG_PATH, config);
      // The PREVIOUS conductor's session is stale (it may still think
      // it's the chef). Wipe its sidecar so any future direct dispatch
      // starts fresh.
      if (prevConductor && prevConductor !== existing.name) {
        try { fs.unlinkSync(sessionFilePath(prevConductor)); sessions.delete(prevConductor); } catch {}
      }
      // The new conductor's own session also must re-read config.json,
      // since it now owns the chef role and the fleet view differs.
      invalidateConductorSession(`conductor promoted: ${existing.name}`);
      return res.status(200).json({
        ok: true,
        promoted: true,
        project: {
          name: existing.name,
          model: existing.model ?? config.defaults?.model ?? null,
          tools: existing.tools ?? config.defaults?.allowedTools ?? FALLBACK_TOOLS,
          attachedSession: sessions.get(existing.name) || null,
        },
        conductor: config.conductor,
      });
    }
    if (byName) return res.status(409).json({ error: `project name "${name}" already exists` });
    return res.status(409).json({ error: `path is already registered under "${byPath.name}"` });
  }

  const entry = { name, path: normalized };
  if (typeof model === 'string' && model.trim()) entry.model = model.trim();
  if (typeof tools === 'string' && tools.trim()) entry.tools = tools.trim();

  config.projects.push(entry);
  // New project flagged as conductor — promote immediately.
  if (isConductor) config.conductor = name;
  atomicWriteJson(CONFIG_PATH, config);
  PROJECT_NAMES.add(name);

  // Reset the conductor's session so its next dispatch sees the new fleet
  // list. Without this the conductor's Claude keeps replying "unknown
  // project" for anything added since the session started.
  invalidateConductorSession(`project added: ${name}`);

  const effective = {
    name,
    model: entry.model ?? config.defaults?.model ?? null,
    tools: entry.tools ?? config.defaults?.allowedTools ?? FALLBACK_TOOLS,
    attachedSession: null,
  };
  res.status(201).json({
    ok: true,
    project: effective,
    conductor: config.conductor || null,
  });
});

// Add a tool to a project's allowed-tools list.
// Body: { tool: "WebSearch" }  — appends if not already present.
app.patch('/api/projects/:name/tools', express.json({ limit: '1kb' }), (req, res) => {
  const name = req.params.name;
  const project = config.projects.find(p => p.name === name);
  if (!project) return res.status(404).json({ error: 'unknown project' });
  const tool = req.body?.tool;
  if (typeof tool !== 'string' || !tool.trim()) return res.status(400).json({ error: 'missing tool' });
  const toolName = tool.trim();
  const defaults = config.defaults?.allowedTools || FALLBACK_TOOLS;
  const current = (project.tools ?? defaults).split(',').map(t => t.trim()).filter(Boolean);
  if (!current.includes(toolName)) {
    current.push(toolName);
    project.tools = current.join(',');
    atomicWriteJson(CONFIG_PATH, config);
  }
  res.json({ ok: true, tools: project.tools });
});

// Remove a project. Also clears its sidecar; the JSONL is left on disk.
app.delete('/api/projects/:name', (req, res) => {
  const name = req.params.name;
  const idx = config.projects.findIndex(p => p.name === name);
  if (idx < 0) return res.status(404).json({ error: 'unknown project' });

  config.projects.splice(idx, 1);
  atomicWriteJson(CONFIG_PATH, config);
  PROJECT_NAMES.delete(name);
  try { fs.unlinkSync(sessionFilePath(name)); } catch {}
  sessions.delete(name);
  // The conductor's Claude session has a cached fleet list in its context.
  // Dropping the chef's sidecar forces the next dispatch to start a fresh
  // session that reads config.json clean — otherwise the chef will keep
  // insisting the removed project doesn't exist (or pretend it still does).
  invalidateConductorSession(`project removed: ${name}`);
  res.json({ ok: true });
});

/** Delete the conductor's session sidecar so the next dispatch spawns a
 *  fresh Claude session with an up-to-date `config.json` in its context. */
function invalidateConductorSession(reason) {
  const conductorName = config.conductor || 'chef';
  const sidecar = sessionFilePath(conductorName);
  try {
    if (fs.existsSync(sidecar)) {
      fs.unlinkSync(sidecar);
      sessions.delete(conductorName);
      console.log(`[orchestrator] conductor session reset — ${reason}`);
    }
  } catch (e) {
    console.error(`[orchestrator] could not reset conductor session: ${e.message}`);
  }
}

// ---------- Image attachments -----------------------------------------------
//
// Client posts raw image bytes with Content-Type set to the MIME type.
// Server validates MIME before writing, generates a sanitised filename
// (timestamp + 4-byte random hex, never trusts the client's filename),
// enforces a 20 MB cap, and returns the Windows absolute path so the
// client can insert it into the central pty draft for Claude Code to read.
//
// TODO: add a periodic cleanup cron for old files in attachments/ (v2).

const ATTACH_MIME = new Map([
  ['image/png',       '.png'],
  ['image/jpeg',      '.jpg'],
  ['image/webp',      '.webp'],
  ['image/gif',       '.gif'],
  ['video/mp4',       '.mp4'],
  ['video/webm',      '.webm'],
  ['video/quicktime', '.mov'],
]);
const MAX_ATTACH_BYTES = 100 * 1024 * 1024; // 100 MB for video

app.post('/api/attach/image', (req, res) => {
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext  = ATTACH_MIME.get(mime);
  if (!ext) {
    return res.status(415).json({
      error: `unsupported type "${mime}". Allowed: ${[...ATTACH_MIME.keys()].join(', ')}`,
    });
  }

  const filename = `att-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const filePath = path.join(ATTACHMENTS_DIR, filename);
  const out = fs.createWriteStream(filePath);

  let received = 0;
  let aborted  = false;

  function abort(statusCode, message) {
    if (aborted) return;
    aborted = true;
    out.destroy();
    try { fs.unlinkSync(filePath); } catch {}
    if (!res.headersSent) res.status(statusCode).json({ error: message });
  }

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_ATTACH_BYTES) {
      abort(413, `file exceeds ${MAX_ATTACH_BYTES / 1024 / 1024} MB limit`);
      req.destroy();
    } else if (!aborted) {
      out.write(chunk);
    }
  });
  req.on('end',   () => { if (!aborted) out.end(); });
  req.on('error', () => abort(500, 'upload stream error'));
  out.on('error', (err) => abort(500, err.message));
  out.on('finish', () => {
    if (aborted || res.headersSent) return;
    res.json({ ok: true, path: filePath });
  });
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    tailscale: TAILSCALE_IP,
    projects: config.projects.length,
    centralPty: centralPty ? 'running' : 'idle',
  });
});

// NOTE: the old per-project SSE route `GET /sse/logs/:project` was removed
// (2026-09-19). It had no consumers (the dashboard uses the aggregate
// /api/sse/fleet) yet read from offset 0 and Buffer.alloc'd the whole file on
// first connect — a synchronous 300+ MB read on the chef log that could stall
// the event loop long enough for the watchdog to kill a "slow" server.

// ---------- WebSocket: central pty bridge -----------------------------------

let centralPty = null;
const wsClients = new Set();

function broadcastToClients(data) {
  for (const client of wsClients) {
    try { client.send(data); } catch { /* dead client — ignore */ }
  }
}

function startCentralPty() {
  if (centralPty) return;

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;     // defense in depth
  env.TERM = 'xterm-256color';
  env.FORCE_COLOR = '1';

  try {
    // node-pty on Windows does NOT auto-append `.exe` like child_process
    // does — it hits the native CreateProcess with the exact string.
    // The package.json `os: ["win32"]` lock makes this safe.
    centralPty = pty.spawn('claude.exe', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: __dirname,   // central reads orchestrator CLAUDE.md
      env,
    });
  } catch (err) {
    console.error('[central] failed to spawn claude:', err.message);
    broadcastToClients(`\r\n\x1b[31m[orchestrator] failed to spawn central claude: ${err.message}\x1b[0m\r\n`);
    return;
  }

  console.log(`[central] spawned pid=${centralPty.pid}`);

  const logStream = fs.createWriteStream(CENTRAL_LOG, { flags: 'a' });
  logStream.write(`\n=== session start ${new Date().toISOString()} pid=${centralPty.pid} ===\n`);

  centralPty.onData((data) => {
    logStream.write(data);
    broadcastToClients(data);
  });

  centralPty.onExit(({ exitCode, signal }) => {
    console.log(`[central] exited code=${exitCode} signal=${signal}`);
    logStream.write(`\n=== session end ${new Date().toISOString()} code=${exitCode} signal=${signal} ===\n`);
    logStream.end();
    centralPty = null;
    broadcastToClients(`\r\n\x1b[33m[orchestrator] central claude exited (code ${exitCode}). Reload page to respawn.\x1b[0m\r\n`);
  });
}

app.ws('/ws/pty', (ws, req) => {
  // express-ws intercepts the upgrade at the HTTP server level and does NOT
  // run the full Express middleware chain in all versions — verified by
  // smoke test that unauthenticated upgrades reached this handler. So we
  // re-check both guards explicitly here before doing anything with the pty.
  const local = normalizeAddr(req.socket.localAddress);
  if (!ALLOWED_LOCAL_ADDRS.has(local)) {
    try { ws.close(1008, 'forbidden'); } catch {}
    return;
  }
  if (TOKEN_GATE_ENABLED) {
    const qtok = typeof req.query?.token === 'string' ? req.query.token : null;
    const htok = req.header('x-orchestrator-token');
    const ctok = parseCookieToken(req.headers?.cookie);
    if (!tokensEqual(qtok, TOKEN) && !tokensEqual(htok, TOKEN) && !tokensEqual(ctok, TOKEN)) {
      try { ws.close(1008, 'unauthorized'); } catch {}
      return;
    }
  }

  wsClients.add(ws);
  // Réponse utilisateur n° 1 : le terminal passe aussi par le routeur.
  const termLines = new TerminalLineBuffer();
  const observeTyping = (data) => {
    try { for (const line of termLines.feed(data)) observeEntry({ entry: 'terminal', project: 'central', text: line }); }
    catch (e) { debugLog(`[observe] terminal: ${e.message}`); }
  };

  if (!centralPty) startCentralPty();

  // Send a greeting if the pty didn't spawn.
  if (!centralPty) {
    try { ws.send('\r\n\x1b[31m[orchestrator] central pty unavailable — is `claude` on PATH?\x1b[0m\r\n'); } catch {}
  }

  ws.on('message', (msg) => {
    if (!centralPty) return;
    const text = typeof msg === 'string' ? msg : msg.toString('utf8');
    // Control frames are JSON objects; everything else is raw bytes to write.
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.type === 'input' && typeof parsed.data === 'string') {
          centralPty.write(parsed.data);
          observeTyping(parsed.data);
          return;
        }
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          centralPty.resize(Number(parsed.cols), Number(parsed.rows));
          return;
        }
      } catch { /* fall through to raw */ }
    }
    centralPty.write(text);
    observeTyping(text);
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    // Do NOT kill the pty — other tabs may still be attached, and we want
    // survival across accidental reloads.
  });
});

// ---------- Background notify watchers --------------------------------------
//
// These watchers run from boot, independent of any SSE client connections.
// They call reduceMusician + autoNotifyConductor so notifications fire even
// when the dashboard is closed. The server-global musicianAutoStates Map
// prevents duplicate notifications whether or not SSE clients are also
// processing the same lines concurrently.

function startBackgroundNotifyWatchers() {
  const bgActive = new Map(); // name → { state: { offset, partial }, watcher }

  function attachNotifyWatcher(name) {
    if (bgActive.has(name)) return;
    const logPath = path.join(LOGS_DIR, `${name}.jsonl`);
    let initialOffset = 0;
    try { initialOffset = fs.statSync(logPath).size; } catch {}
    const fileState = { offset: initialOffset, partial: '' };

    // Read at most this many bytes per tick. A single append can be hundreds of
    // MB (an agent that base64'd a big binary into a tool_result); allocating the
    // whole growth at once doubles it into the UTF-16 heap and can OOM the
    // process. Read in bounded blocks and re-schedule until drained, so every
    // event is still processed (unlike the SSE pump, which fast-forwards).
    const WATCH_READ_MAX = 4 * 1024 * 1024;
    const pump = () => {
      let stat;
      try { stat = fs.statSync(logPath); } catch { return; }
      if (stat.size < fileState.offset) { fileState.offset = 0; fileState.partial = ''; }
      if (stat.size <= fileState.offset) return;
      const want = Math.min(stat.size - fileState.offset, WATCH_READ_MAX);
      const buf = Buffer.alloc(want);
      const fd = fs.openSync(logPath, 'r');
      try { fs.readSync(fd, buf, 0, want, fileState.offset); }
      finally { fs.closeSync(fd); }
      fileState.offset += want;
      fileState.partial += buf.toString('utf8');
      const moreToDrain = stat.size > fileState.offset;
      const lines = fileState.partial.split('\n');
      fileState.partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          const { prevState, newState, lastLine, awaitingChef, expectCallback, wakeGen, phantom, resolved, afterStop } =
            reduceMusician(name, ev);
          if (resolved) {
            const msg = `[${ev.subtype === 'acknowledged' ? 'vu' : 'question'}] ${name} : ${ev.subtype === 'acknowledged' ? 'marqué vu' : 'question acquittée'} (${prevState} → ${newState})` +
              (ev.note ? ` — ${String(ev.note).slice(0, 120)}` : '');
            console.log(msg); debugLog(msg);
            continue;
          }
          if (phantom) {
            // Ni réveil, ni notification, ni drain, ni clôture de ticket de chef.
            const msg = afterStop
              ? `[arrêt-chef] ${name} : result ${ev.subtype || ''} ignoré — il suit un arrêt par le chef dans le même tour`
              : `[result-fantôme] ${name} : result ignoré (num_turns=0, duration_api_ms=0, ` +
                `session=${String(ev.session_id || '').slice(0, 8)}) — mini-tour rejoué par le CLI, pas une fin de tour`;
            console.log(msg);
            debugLog(msg);
            continue;
          }
          if (ev.type === 'result') {
            console.log(`[notify-bg] ${name} result: prevState=${prevState} newState=${newState}`);
          }
          // Règle « model explicite = aucun fallback » (0.26.0) : dispatch.mjs a
          // refusé de basculer. Le result est un échec ordinaire (notification
          // ✕ et réveil du chef comme tout échec) ; on trace juste la décision.
          if (ev.type === 'result' && ev.model_unavailable) {
            const msg = `[fallback-refusé] ${name} : model explicite ${ev.model_requested || '?'} — ${String(ev.result || '').slice(0, 200)}`;
            console.log(msg); debugLog(msg);
          }
          // ---- Callback-wake bookkeeping on the CHEF's own log ----------------
          if (name === conductorName()) {
            // The user is talking to the chef: its turn will show the results
            // itself, so drop any batch we were about to push (no paid double).
            if (ev.type === 'user_prompt' && !ev.source) cancelWakeOnUserPrompt();
            // « Pris par » n'est affirmé que quand le log du slot le prouve —
            // jamais sur la foi d'une réponse HTTP (garde-fou §6 du design).
            if (ev.type === 'user_prompt' && typeof ev.ticket === 'string') {
              poolMarkRunning(name, ev.ticket);
            }
            // The chef finished (including a wake turn): close its ticket,
            // release the slot, and let the queue advance.
            if (ev.type === 'result') {
              poolOnSlotResult(name, ev);
              setImmediate(tryFireWake);
            }
          }
          // One coordination event per terminal transition of a real turn.
          // A SYNTHETIC result (interrupted / limited) is closed by the system,
          // not by the musician — it gets no callback at all (the card carries
          // the cause), so the chef's thread isn't polluted with non-work.
          if (ev.type === 'result' && !ev.synthetic &&
              (prevState === 'live' || prevState === 'think' || prevState === 'input')) {
            const durationMs = Number.isFinite(ev.duration_ms) ? ev.duration_ms : undefined;
            const costUsd    = Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : undefined;
            if (newState === 'unread') {
              autoNotifyConductor(name, {
                outcome: awaitingChef ? 'ask_chef' : 'done',
                summary: summarizeResult(ev) || lastLine,
                durationMs, costUsd, awaitingChef,
              });
            } else if (newState === 'input') {
              // The musician is asking the USER — surface it in the chef thread
              // instead of leaving it to be spotted on an orange card.
              autoNotifyConductor(name, { outcome: 'question', summary: lastLine, durationMs, costUsd });
            } else if (newState === 'error') {
              autoNotifyConductor(name, {
                outcome: 'failed',
                summary: summarizeResult(ev) || ev.subtype || 'échec du tour',
                durationMs, costUsd,
              });
            }

            // ---- Wake the chef, but ONLY for a result it explicitly awaited ---
            // The notification above is written either way (the card always shows
            // up); this only decides whether the chef is asked to speak about it.
            //
            // Excluded on purpose: `input` (the musician is asking the USER — the
            // question bubble already jumps the thread, so a relayed synthesis
            // would duplicate it), synthetic results (guarded above), and any turn
            // nobody awaited. A result that WAS awaited is never dropped any more:
            // past WAKE_MAX_GEN the wake fires in report-only mode instead.
            if (expectCallback === conductorName() &&
                name !== conductorName() &&
                (newState === 'unread' || newState === 'error')) {
              const gen = Number(wakeGen) || 0;
              if (wakeIsReportOnly(gen + 1)) {
                debugLog(`[wake] ${name} awaited, gen=${gen} ≥ WAKE_MAX_GEN=${WAKE_MAX_GEN} — réveil en rapport seul (dispatch interdit)`);
              }
              scheduleConductorWake({
                key: `${name}:${ev.session_id || ''}:${ev.timestamp || ev.duration_ms || ''}`,
                source: name,
                outcome: newState === 'error' ? 'failed' : (awaitingChef ? 'ask_chef' : 'done'),
                summary: summarizeResult(ev) || lastLine || '',
                durationMs, costUsd, awaitingChef, wakeGen: gen,
                ts: Date.now(),
              });
            }
          }
          // Drain the per-musician queue on any turn completion (unread/idle/error).
          // Uses setImmediate inside drainQueue so it never blocks this pump iteration.
          // NOT on a SYNTHETIC result (B1): the no-failover guard writes an
          // `error_limited` synthetic when Claude is limited — draining then would
          // launch the next queued item, which hits the same limit, synthesises
          // another result, and burns the whole queue with zero work done.
          //
          // 0.24.1 : on draine AUSSI quand le tour finit en `input` (question à
          // l'utilisateur). Les entrées en file sont presque toujours des
          // précisions de l'utilisateur envoyées pendant le tour — souvent la
          // réponse même à la question. Bloquer la file sur une question non
          // lue a laissé TranslateOverlay « libre avec 1 tâche en file » des
          // heures (25/09). La question reste affichée (fil du chef + bande
          // d'attention) ; le tour suivant la verra dans sa propre session.
          //
          // 0.26.0 : pas de drain immédiat derrière un échec « model explicite
          // indisponible ». Sous limite Claude, l'entrée suivante échouerait
          // pareil (ou basculerait) sans rien produire — même raison que la
          // garde B1. Le balayage de secours la reprendra (jamais sous limite).
          if (ev.type === 'result' && !ev.synthetic && !ev.model_unavailable &&
              (newState === 'unread' || newState === 'idle' || newState === 'error' || newState === 'input') &&
              (prevState === 'live' || prevState === 'think')) {
            drainQueue(name);
          }
        } catch { /* malformed line — skip */ }
      }
      // A big append was only partially read this tick — keep draining without
      // blocking the loop, so no result/notification is missed.
      if (moreToDrain) setImmediate(pump);
    };

    const watcher = chokidar.watch(logPath, logWatchOpts());
    watcher.on('add', pump);
    watcher.on('change', pump);
    bgActive.set(name, { fileState, watcher });
  }

  // Warm-up: reconstruct state from recent log tail so prevState is accurate
  // even for musicians who were live just before the server restarted.
  for (const p of config.projects) {
    const logPath = path.join(LOGS_DIR, `${p.name}.jsonl`);
    try {
      const size = fs.statSync(logPath).size;
      const readSize = Math.min(size, 32 * 1024); // last 32 KB
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(logPath, 'r');
      try { fs.readSync(fd, buf, 0, readSize, size - readSize); }
      finally { fs.closeSync(fd); }
      const tail = buf.toString('utf8');
      const lines = tail.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { reduceMusician(p.name, JSON.parse(line)); } catch {}
      }
      const state = musicianAutoStates.get(p.name);
      if (state && state.state !== 'idle') {
        console.log(`[notify-bg] warm-up: ${p.name} → ${state.state}`);
      }
    } catch {}
  }

  for (const p of config.projects) attachNotifyWatcher(p.name);

  // Keep in sync with projects added/removed at runtime (same cadence as SSE poll).
  setInterval(() => {
    const want = new Set(config.projects.map(p => p.name));
    for (const name of [...bgActive.keys()]) {
      if (!want.has(name)) {
        bgActive.get(name).watcher.close().catch(() => {});
        bgActive.delete(name);
      }
    }
    for (const name of want) attachNotifyWatcher(name);
  }, 3000);

  console.log(`[notify-bg] watching ${bgActive.size} project logs`);
}

startBackgroundNotifyWatchers();
startSshServer(console);

// ---------- Start -----------------------------------------------------------

// Express error handler — catches any error thrown synchronously or via
// next(err) inside route handlers. Without this, a buggy route can leave
// the request hanging without ever logging a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Erreurs du parseur JSON (body-parser) : ce sont des erreurs du CLIENT, pas
  // des pannes — un corps trop gros n'est pas un « internal server error ».
  if (err && err.type === 'entity.too.large') {
    debugLog(`[http] ${req.method} ${req.url} : corps trop volumineux (${err.length ?? '?'} octets, limite ${err.limit ?? '?'})`);
    return res.status(413).json({ error: `corps trop volumineux : ${err.length ?? '?'} octets (limite ${err.limit ?? '?'})` });
  }
  if (err && (err.type === 'entity.parse.failed' || err.type === 'charset.unsupported' || err.type === 'encoding.unsupported')) {
    return res.status(400).json({ error: `corps illisible : ${err.message}` });
  }
  crashLog(`EXPRESS ERROR ${req.method} ${req.url}: ${err && err.stack || err}`);
  res.status(500).json({ error: 'internal server error' });
});

let _listenAttempts = 0;

function killPortHolder(port) {
  try {
    const out = execFileSync(
      'C:\\Windows\\System32\\netstat.exe',
      ['-ano'],
      { encoding: 'utf8', timeout: 5000 },
    );
    for (const line of out.split('\n')) {
      // Match both 0.0.0.0:<port> and 127.0.0.1:<port> in LISTENING state
      if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (!pid || pid === '0') continue;
      console.log(`[eaddrinuse] port ${port} held by PID ${pid} — killing`);
      try {
        execFileSync('C:\\Windows\\System32\\taskkill.exe', ['/F', '/PID', pid], { timeout: 5000 });
        console.log(`[eaddrinuse] PID ${pid} killed`);
        return true;
      } catch (ke) {
        console.error(`[eaddrinuse] taskkill failed: ${ke.message}`);
      }
    }
  } catch (e) {
    console.error(`[eaddrinuse] netstat failed: ${e.message}`);
  }
  return false;
}

async function orchestratorAlreadyServing() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz?token=${TOKEN}`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

httpServer.on('error', async (err) => {
  if (err.code === 'EADDRINUSE' && !httpServer.listening) {
    // Scheduled task and watchdog can launch simultaneously at logon. If the
    // holder is a working orchestrator, step aside instead of killing it.
    if (await orchestratorAlreadyServing()) {
      crashLog(`EADDRINUSE: a healthy orchestrator already serves :${PORT} — this instance exits`);
      process.exit(0);
    }
    if (_listenAttempts < 3) {
      _listenAttempts++;
      console.error(`[eaddrinuse] port ${PORT} already in use (attempt ${_listenAttempts})`);
      const killed = killPortHolder(PORT);
      const delay = killed ? 1500 : 4000;
      console.log(`[eaddrinuse] retrying in ${delay}ms…`);
      setTimeout(() => httpServer.listen(PORT, '0.0.0.0', onListening), delay);
      return;
    }
    crashLog(`EADDRINUSE: could not bind :${PORT} after ${_listenAttempts} attempts — exiting`);
    process.exit(1);
  }
  crashLog(`HTTP SERVER ERROR: ${err && err.stack || err}`);
  if (!httpServer.listening) process.exit(1);
});

// Last line of defence against zombies: a process that is not bound to the
// port is useless AND harmful (it holds logs/server.out open, which made the
// watchdog's relaunch fail 59 times). Exit so a supervisor can start clean.
const NOT_LISTENING_EXIT_MS = 90_000;
let _notListeningSince = Date.now();
setInterval(() => {
  if (httpServer.listening) { _notListeningSince = 0; return; }
  if (!_notListeningSince) _notListeningSince = Date.now();
  if (Date.now() - _notListeningSince >= NOT_LISTENING_EXIT_MS) {
    crashLog(`not listening on :${PORT} for ${Math.round((Date.now() - _notListeningSince) / 1000)}s — exiting`);
    process.exit(1);
  }
}, 15_000).unref();
httpServer.on('clientError', (err, socket) => {
  crashLog(`HTTP clientError: ${err.code || err.message}`);
  try { socket.destroy(); } catch {}
});

httpServer.listen(PORT, '0.0.0.0', onListening);

function onListening() {
  _listenAttempts = 0;
  // La file de direction est rehydratée ICI, une fois le module entièrement
  // évalué (l'ensemble SSE, `config`, les watchers) et AVANT tout dispatch :
  // un ticket en vol perdu au redémarrage repart une seule fois, en tête.
  try { loadPoolFromDisk(); } catch (e) { crashLog(`loadPoolFromDisk failed: ${e.message}`); }
  const url = `http://127.0.0.1:${PORT}/?token=${TOKEN}`;
  const tsUrl = TAILSCALE_IP ? `http://${TAILSCALE_IP}:${PORT}/?token=${TOKEN}` : null;
  console.log('┌─ Claude Code Orchestrator ─────────────────────────────────');
  console.log(`│  localhost : ${url}`);
  if (tsUrl) console.log(`│  tailscale : ${tsUrl}`);
  else       console.log('│  tailscale : not detected (tailscale ip -4 failed)');
  console.log(`│  interfaces: ${[...ALLOWED_LOCAL_ADDRS].join(', ')}`);
  console.log(`│  projects  : ${config.projects.length}`);
  console.log(`│  sessions  : ${sessions.size} loaded from sidecars`);
  console.log('└────────────────────────────────────────────────────────────');
  crashLog(`listen ok port=${PORT} projects=${config.projects.length}`);
}

function shutdown(signal) {
  console.log(`\n[orchestrator] ${signal} → shutting down`);
  if (centralPty) { try { centralPty.kill(); } catch {} }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
