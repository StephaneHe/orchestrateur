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
import { scanProject as scanFleetMember } from './scripts/fleet-status-core.mjs';
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
const dispatchQueue = new Map(); // projectName → [{prompt, attachmentPaths, videoPaths}]

const QUEUE_DIR = path.join(LOGS_DIR, 'queue');
try { fs.mkdirSync(QUEUE_DIR, { recursive: true }); } catch {}

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
    if (!config.projects.find(p => p.name === name)) {
      // Project no longer in config — stale sidecar, drop it.
      try { fs.unlinkSync(path.join(QUEUE_DIR, fname)); } catch {}
      continue;
    }
    try {
      const raw = fs.readFileSync(path.join(QUEUE_DIR, fname), 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        dispatchQueue.set(name, arr);
        debugLog(`queue rehydrate ${name} (${arr.length} pending)`);
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

// Spawn a dispatch to a musician directly, bypassing the conductor session.
function spawnDirectDispatch(name, prompt, attachmentPaths = [], videoPaths = []) {
  const dispatchScript = path.join(__dirname, 'scripts', 'dispatch.mjs');
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

  const child = spawn(process.execPath, [dispatchScript, name, '--prompt-stdin'], {
    cwd: __dirname,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      DISPATCH_TRACE_ID: '',
      DISPATCH_INTERRUPTED: '0',
      DISPATCH_TIME_SINCE_LAST_MS: timeSinceLastMs == null ? '' : String(timeSinceLastMs),
      DISPATCH_REQUEST_IN_TS: String(requestInTs),
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
function drainQueue(name) {
  const q = dispatchQueue.get(name);
  if (!q || q.length === 0) { dispatchQueue.delete(name); persistQueue(name); return; }
  const { prompt, attachmentPaths, videoPaths } = q.shift();
  if (q.length === 0) dispatchQueue.delete(name);
  persistQueue(name);
  console.log(`[queue] auto-dispatch to ${name} (${dispatchQueue.get(name)?.length ?? 0} remaining)`);
  setImmediate(() => spawnDirectDispatch(name, prompt, attachmentPaths, videoPaths));
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
      // walk backwards looking for a non-stream_event, non-partial line
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        // heuristic: avoid parsing huge stream_event deltas
        if (line.includes('"type":"stream_event"')) continue;
        try {
          const ev = JSON.parse(line);
          if (ev && typeof ev.type === 'string') return ev.type;
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

// Fleet Android apps exposed on /downloads. Each needs a builds/<name>/latest.apk
// (served by /downloads/:app/apk). RemotePad/BookHaven stay first (existing
// cards); the rest were added from the chef's APK survey. Version source and
// form-factor for each are declared in APP_VERSION_SOURCES / APP_PLATFORM below.
const DOWNLOAD_APPS = [
  'orchestrateur',
  'RemotePad', 'BookHaven',
  'DeskZen', 'vuBox', 'firstAidOffline', 'frenchradio',
  'immo-share', 'meetingScribe', 'photoLab', 'SncfOptimizer', 'sommeil',
];

// Form-factor badge shown on the download card. Anything not listed → 'phone'.
const APP_PLATFORM = { vuBox: 'TV', 'immo-share': 'mobile' };

// Readable docs exposed on /downloads. A project may expose 1..n docs; this is
// a small generic registry, not a TradeBot special-case. Each entry:
//   project   — must own the doc (also namespaces the URL and builds/ folder)
//   id        — stable slug used in the URL (/downloads/<project>/doc/<id>)
//   title     — shown on the card and as the page heading
//   file      — filename under builds/<project>/ (canonical, APK-pattern)
//   fallbacks — absolute paths tried if the builds/ copy is missing, so the
//               render still works (or 404s cleanly) if the file moves.
const DOWNLOAD_DOCS = [
  {
    project: 'TradeBot',
    id: 'proposal',
    title: 'Proposition de conception',
    file: 'PROPOSAL.md',
    fallbacks: ['I:\\Dev\\TradeBot\\docs\\PROPOSAL.md'],
  },
  {
    project: 'TradeBot',
    id: 'review',
    title: 'TradeBot — Revue critique (Fable)',
    file: 'REVIEW.md',
    fallbacks: ['I:\\Dev\\TradeBot\\docs\\REVIEW.md'],
  },
];

function findDoc(project, id) {
  return DOWNLOAD_DOCS.find(d => d.project === project && d.id === id) || null;
}

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

// Unified card model for the /downloads page: an app (APK), a doc-only project,
// or both. Apps keep their config order first, doc-only projects follow.
function buildDownloadEntries() {
  const byProject = new Map();
  const ensure = (name) => {
    if (!byProject.has(name)) byProject.set(name, { name, version: null, apk: false, platform: null, docs: [] });
    return byProject.get(name);
  };
  for (const name of DOWNLOAD_APPS) {
    const e = ensure(name);
    e.version = readAppVersion(name);
    e.apk = true;
    e.platform = APP_PLATFORM[name] || 'phone';
  }
  for (const d of DOWNLOAD_DOCS) ensure(d.project).docs.push({ id: d.id, title: d.title });
  return [...byProject.values()];
}

// Where each app's displayed version is read from. Most are Android gradle
// files; RemotePad is a Python package. `re` overrides the default matcher
// (RemotePad's __version__). vuBox is the Android-TV module. Paths are literals
// here (never from the request), so there is no traversal surface.
const APP_VERSION_SOURCES = {
  orchestrateur:   { file: 'I:\\orchestrateur\\android\\app\\build.gradle.kts' },
  RemotePad:       { file: 'I:\\Dev\\RemotePad\\server\\__init__.py', re: /__version__\s*=\s*["']([^"']+)["']/ },
  BookHaven:       { file: 'I:\\Dev\\BookHaven\\android\\app\\build.gradle.kts' },
  DeskZen:         { file: 'I:\\Dev\\DeskZen\\app\\build.gradle.kts' },
  vuBox:           { file: 'I:\\Dev\\vuBox\\androidtv\\app\\build.gradle.kts' },
  firstAidOffline: { file: 'I:\\Dev\\firstAidOffline\\app\\build.gradle.kts' },
  frenchradio:     { file: 'I:\\Dev\\frenchradio\\app\\build.gradle.kts' },
  'immo-share':    { file: 'I:\\Dev\\immo-share\\apps\\mobile\\android\\app\\build.gradle' },
  meetingScribe:   { file: 'I:\\Dev\\meetingScribe\\app\\build.gradle.kts' },
  photoLab:        { file: 'I:\\Dev\\photoLab\\app\\build.gradle.kts' },
  SncfOptimizer:   { file: 'I:\\Dev\\SncfOptimizer\\app\\build.gradle.kts' },
  sommeil:         { file: 'I:\\Dev\\sommeil\\app\\build.gradle.kts' },
};

// Kotlin DSL: `versionName = "x"` · Groovy: `versionName "x"`. Case-insensitive
// (one project writes `VersionName`); the negative lookahead avoids matching
// `versionNameSuffix`. Falls back to 'unknown' rather than blocking a card.
const VERSION_NAME_RE = /versionName(?![A-Za-z])\s*=?\s*["']([^"']+)["']/i;

function readAppVersion(appName) {
  const src = APP_VERSION_SOURCES[appName];
  if (!src) return 'unknown';
  try {
    const text = fs.readFileSync(src.file, 'utf8');
    const m = (src.re || VERSION_NAME_RE).exec(text);
    return m ? m[1] : 'unknown';
  } catch { return 'unknown'; }
}

const ANDROID_ICON_SVG = `<svg class="app-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.523 15.341a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm-11.046 0a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5ZM6.38 8.25h11.24c.456 0 .83.358.83.8v6.4c0 .442-.374.8-.83.8H6.38c-.456 0-.83-.358-.83-.8V9.05c0-.442.374-.8.83-.8ZM3.75 9.3a.75.75 0 0 1 .75.75v4.9a.75.75 0 0 1-1.5 0V10.05a.75.75 0 0 1 .75-.75Zm16.5 0a.75.75 0 0 1 .75.75v4.9a.75.75 0 0 1-1.5 0V10.05a.75.75 0 0 1 .75-.75ZM8.5 5.29 7.22 3.47a.375.375 0 0 1 .61-.438L9.2 4.9A7.013 7.013 0 0 1 12 4.25c.993 0 1.937.203 2.8.65l1.37-1.87a.375.375 0 1 1 .61.44L15.5 5.29A7.001 7.001 0 0 1 18 8.25H6A7.001 7.001 0 0 1 8.5 5.29Z"/></svg>`;
const DOC_ICON_SVG = `<svg class="app-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 2.75A2.25 2.25 0 0 0 3.75 5v14A2.25 2.25 0 0 0 6 21.25h12A2.25 2.25 0 0 0 20.25 19V8.31c0-.3-.12-.585-.33-.795l-4.435-4.435a1.125 1.125 0 0 0-.795-.33H6Zm8.25 1.94 3.56 3.56H15a.75.75 0 0 1-.75-.75V4.69ZM7.5 11.5h9a.75.75 0 0 1 0 1.5h-9a.75.75 0 0 1 0-1.5Zm0 3.5h9a.75.75 0 0 1 0 1.5h-9a.75.75 0 0 1 0-1.5Zm0-7h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>`;

function downloadsPageHtml(entries) {
  const cards = entries.map((e) => {
    const icon = e.apk ? ANDROID_ICON_SVG : DOC_ICON_SVG;
    const platform = e.platform ? `<span class="app-plat">${escHtml(e.platform)}</span>` : '';
    const version = e.version ? `<p class="app-version">v${escHtml(e.version)}</p>` : '';
    const apkBtn = e.apk
      ? `<a class="dl-btn" href="/downloads/${escHtml(e.name)}/apk">↓ Télécharger APK</a>`
      : '';
    const docBtns = e.docs.map(d =>
      `<a class="dl-btn dl-btn--doc" href="/downloads/${escHtml(e.name)}/doc/${escHtml(d.id)}">📄 ${escHtml(d.title)}</a>`
    ).join('');
    return `
    <div class="card">
      <div class="app-header">
        ${icon}
        <div>
          <h2 class="app-name">${escHtml(e.name)}${platform}</h2>
          ${version}
        </div>
      </div>
      ${apkBtn}${docBtns}
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
  res.type('html').send(downloadsPageHtml(buildDownloadEntries()));
});

app.get('/downloads/:app/apk', (req, res) => {
  const appName = req.params.app;
  if (!DOWNLOAD_APPS.includes(appName)) return res.status(404).type('text/plain').end('Not found');
  const apkPath = path.join(BUILDS_DIR, appName, 'latest.apk');
  if (!fs.existsSync(apkPath)) return res.status(404).type('text/plain').end('APK not available');
  res.download(apkPath, `${appName}-latest.apk`);
});

// Rendered, mobile-readable view of a registered doc. Public (pre-token-gate).
app.get('/downloads/:project/doc/:id', (req, res) => {
  const doc = findDoc(req.params.project, req.params.id);
  if (!doc) return res.status(404).type('text/plain').end('Document introuvable');
  const found = readDocMarkdown(doc);
  if (!found) return res.status(404).type('text/plain').end('Document indisponible (fichier source absent)');
  const bodyHtml = renderMarkdown(found.md);
  res.type('html').send(docPageHtml({ project: doc.project, id: doc.id, title: doc.title, bodyHtml }));
});

// Raw Markdown download of a registered doc.
app.get('/downloads/:project/doc/:id/raw', (req, res) => {
  const doc = findDoc(req.params.project, req.params.id);
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
  if (lines.length > 1) lines.shift();
  const readAt = readMarker(name);
  const readTs = readAt ? Date.parse(readAt) : 0;

  let state = 'idle';
  let lastAssistantText = '';
  let lastLine = '';
  let unreadCount = 0;
  for (const ln of lines) {
    if (!ln) continue;
    let ev; try { ev = JSON.parse(ln); } catch { continue; }
    const t = ev?.type;
    if (t === 'user_prompt' || (t === 'system' && ev.subtype === 'init')) {
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
      if (isErr && ev.synthetic) {
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
  return { state, lastLine, unreadCount };
}

app.get('/api/version', (req, res) => {
  res.json({ version: PKG_VERSION });
});

app.get('/api/config', (req, res) => {
  const defaults = config.defaults ?? {};
  res.json({
    conductor: config.conductor || 'chef',
    defaults: {
      model: defaults.model ?? null,
      allowedTools: defaults.allowedTools ?? 'Read,Edit,Write,Bash',
      provider: defaults.provider ?? 'claude',
    },
    projects: config.projects.map(p => {
      const snap = scanProjectState(p.name);
      return {
        name: p.name,
        path: p.path || null,
        model: p.model ?? defaults.model ?? null,
        tools: p.tools ?? defaults.allowedTools ?? 'Read,Edit,Write,Bash',
        provider: p.provider ?? defaults.provider ?? 'claude',
        parked: p.parked ?? false,
        attachedSession: sessions.get(p.name) || null,
        readAt: readMarker(p.name),
        currentState: snap.state,
        lastLine: snap.lastLine,
        unreadCount: snap.unreadCount,
      };
    }),
  });
});

// ---------- Live desk view (« pupitre ») ------------------------------------
//
// Real-time snapshot of every musician INCLUDING the conductor (chef), derived
// from the same shared core as the CLI supervisor. Powers /pupitre. Parked
// projects are included but flagged so the page can de-emphasise them.
app.get('/api/pupitre', (req, res) => {
  const conductor = config.conductor || 'chef';
  const fleet = config.projects.map(p => {
    const snap = scanFleetMember(p.name);   // state, silence, stall, pid, model…
    return {
      ...snap,
      isConductor: p.name === conductor,
      parked: p.parked ?? false,
      // Configured provider/model as a fallback when the log has none yet.
      configModel: p.model ?? config.defaults?.model ?? null,
      configProvider: p.provider ?? config.defaults?.provider ?? 'claude',
    };
  });
  res.json({ now: Date.now(), conductor, fleet });
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
  res.json({ ok: true, tool });
});

// Toggle parked flag for a project (parked cards are hidden in the fleet UI).
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

app.post('/api/project/:name/park', express.json({ limit: '1kb' }), (req, res) => {
  const proj = config.projects.find(p => p.name === req.params.name);
  if (!proj) return res.status(404).json({ error: 'unknown project' });
  const parked = req.body?.parked !== false;
  if (parked) proj.parked = true;
  else delete proj.parked;
  atomicWriteJson(CONFIG_PATH, config);
  res.json({ ok: true, parked });
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
  const chef = conductorName();
  const prompt =
    `[NEEDS_CHEF_INPUT_FROM:${musicianName}] Le musicien « ${musicianName} » te demande une décision :\n\n` +
    `${question}\n\n` +
    `Réponds de façon décisive en une à trois phrases, préfixe par [ANSWER]. ` +
    `Si tu juges que c'est en fait une question pour l'utilisateur (préférence personnelle, ` +
    `autorisation, choix sans bonne réponse objective), réponds plutôt par ` +
    `NEEDS_USER_INPUT: <question reformulée pour le user>.`;
  console.log(`[needs-chef] ${musicianName} → chef : ${question.slice(0, 80)}…`);
  spawnDirectDispatch(chef, prompt);
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
  spawnDirectDispatch(musicianName, musicianPrompt);
}

function allowedToolsFor(name) {
  const project = config.projects.find(p => p.name === name);
  if (!project) return null;
  return project.tools || config.defaults?.allowedTools || 'Read,Edit,Write,Bash';
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
    if (ev.type === 'user_prompt' && typeof ev.text === 'string' && ev.text.trim()) {
      const userText = stripReplyPrefixes(ev.text.trim());
      const entry = { role: 'user', text: userText, ts: monotonic(stampFrom(ev)) };
      lastPromptTs = entry.ts;
      if (ev.source) entry.source = ev.source;
      if (Array.isArray(ev.attachmentPaths) && ev.attachmentPaths.length) {
        entry.attachmentPaths = ev.attachmentPaths.map(p => '/attachments/' + path.basename(String(p)));
      }
      msgs.push(entry);
    } else if (ev.type === 'assistant') {
      const content = ev.message?.content || [];
      for (const b of content) {
        if (b?.type === 'text' && b.text?.trim()) lastAssistantText = b.text.trim();
      }
    } else if (ev.type === 'result' && !ev.is_error && lastAssistantText) {
      const needs = /^NEEDS_USER_INPUT:/m.test(lastAssistantText);
      if (!needs) {
        msgs.push({ role: 'conductor', text: lastAssistantText, ts: monotonic(stampFrom(ev)) });
        lastAssistantText = '';
      }
    } else if (ev.type === 'notification' && ev.subtype === 'musician_done' && ev.source && typeof ev.text === 'string' && ev.text.trim()) {
      msgs.push({ role: 'callback', text: ev.text.trim(), ts: monotonic(stampFrom(ev)), source: ev.source });
    }
  }
  res.json(msgs.slice(-n));
});

// Incremental state reducer mirroring scanProjectState() but for a single
// event. Updates musicianAutoStates in place; returns prev + new state so
// the pump can detect transitions without re-reading the whole log.
function reduceMusician(name, ev) {
  const prev = musicianAutoStates.get(name) ?? { state: 'idle', lastAssistantText: '', lastLine: '' };
  let { state, lastAssistantText, lastLine } = prev;
  const t = ev?.type;
  // stream_event lines are very frequent token-level deltas — skip.
  if (t === 'stream_event') return { prevState: state, newState: state, lastLine };
  if (t === 'user_prompt' || (t === 'system' && ev.subtype === 'init')) {
    if (state === 'idle' || state === 'unread') state = 'live';
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
    if (isErr && ev.synthetic)  state = 'idle';
    else if (isErr)             { state = 'error'; lastLine = ev.subtype || 'échec du tour'; }
    else if (needs)             { state = 'input'; lastLine = needs[1].trim().slice(0, 600); }
    else {
      if (ev.result) lastLine = ev.result.replace(/\s+/g, ' ').trim().slice(0, 600);
      state = 'unread';
    }
  }
  musicianAutoStates.set(name, { state, lastAssistantText, lastLine });
  return { prevState: prev.state, newState: state, lastLine };
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
          if (parsedEv) {
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

  if (added.length || removed.length || conductorChanged) {
    console.log(`[config-reload] hot: +[${added.join(', ')}] -[${removed.join(', ')}]${conductorChanged ? ` conductor=${config.conductor}` : ''}`);
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

// Called by the SSE pump when a musician transitions to the 'unread' state,
// meaning a non-error turn just completed. Appends a callback bubble to the
// conductor's log (the SSE pump picks it up instantly) and fires a toast.
function autoNotifyConductor(musicianName, summary) {
  const cName = config.conductor || 'chef';
  if (musicianName === cName) return;
  console.log(`[notify-bg] firing autoNotifyConductor for ${musicianName}`);

  // 1. Write a visual callback bubble to the conductor log (for the human).
  const logPath = path.join(LOGS_DIR, `${cName}.jsonl`);
  const text = `[${musicianName}] Tour terminé.${summary ? ' ' + summary : ''}`;
  const ev = { type: 'notification', subtype: 'musician_done', text, timestamp: new Date().toISOString(), source: musicianName };
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

app.post('/api/notify', express.json({ limit: '2kb' }), (req, res) => {
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
        const q = dispatchQueue.get(directProj.name) ?? [];
        q.push({ prompt: stripped, attachmentPaths, videoPaths });
        dispatchQueue.set(directProj.name, q);
        persistQueue(directProj.name);
        console.log(`[queue] queued for ${directProj.name} (pos=${q.length}, state=${st})`);
        return res.status(202).json({
          ok: true, queued: true, project: directProj.name, queueLength: q.length,
        });
      }
      const pid = spawnDirectDispatch(directProj.name, stripped, attachmentPaths, videoPaths);
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
  const child = spawn(process.execPath, [dispatchScript, name, '--prompt-stdin'], {
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
          tools: existing.tools ?? config.defaults?.allowedTools ?? 'Read,Edit,Write,Bash',
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
    tools: entry.tools ?? config.defaults?.allowedTools ?? 'Read,Edit,Write,Bash',
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
  const defaults = config.defaults?.allowedTools || 'Read,Edit,Write,Bash';
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

// ---------- SSE: tail per-project stream-json -------------------------------

app.get('/sse/logs/:project', (req, res) => {
  const name = req.params.project;
  if (!PROJECT_NAMES.has(name)) {
    res.status(404).type('text/plain').end('Unknown project');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');

  const logPath = path.join(LOGS_DIR, `${name}.jsonl`);
  let offset = 0;
  let partialLine = '';

  function pump() {
    let stat;
    try { stat = fs.statSync(logPath); }
    catch { return; /* file not created yet */ }

    // Log was truncated / rotated externally — rewind. Brief says we don't
    // rotate, but be defensive.
    if (stat.size < offset) { offset = 0; partialLine = ''; }

    if (stat.size > offset) {
      const buf = Buffer.alloc(stat.size - offset);
      const fd = fs.openSync(logPath, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, offset); }
      finally { fs.closeSync(fd); }
      offset = stat.size;

      partialLine += buf.toString('utf8');
      const lines = partialLine.split('\n');
      partialLine = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        // Escape newlines inside the JSON (rare, but possible when a tool
        // result is a multi-line string inside a JSON string).
        if (res.writableEnded || res.destroyed) return;
        try { res.write(`data: ${line}\n\n`); }
        catch (e) {
          debugLog(`sse pump-write (single-project) failed: ${e.code || e.message}`);
          try { res.destroy(); } catch {}
          return;
        }
      }
    }
  }
  pump();

  const watcher = chokidar.watch(logPath, logWatchOpts({ awaitWriteFinish: false }));
  watcher.on('add', pump);
  watcher.on('change', pump);

  // Periodic heartbeat so intermediaries don't close the connection.
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    watcher.close().catch(() => {});
    try { res.end(); } catch {}
  });
});

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
          return;
        }
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          centralPty.resize(Number(parsed.cols), Number(parsed.rows));
          return;
        }
      } catch { /* fall through to raw */ }
    }
    centralPty.write(text);
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

    const pump = () => {
      let stat;
      try { stat = fs.statSync(logPath); } catch { return; }
      if (stat.size < fileState.offset) { fileState.offset = 0; fileState.partial = ''; }
      if (stat.size <= fileState.offset) return;
      const buf = Buffer.alloc(stat.size - fileState.offset);
      const fd = fs.openSync(logPath, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, fileState.offset); }
      finally { fs.closeSync(fd); }
      fileState.offset = stat.size;
      fileState.partial += buf.toString('utf8');
      const lines = fileState.partial.split('\n');
      fileState.partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          const { prevState, newState, lastLine } = reduceMusician(name, ev);
          if (ev.type === 'result') {
            console.log(`[notify-bg] ${name} result: prevState=${prevState} newState=${newState}`);
          }
          if (newState === 'unread' && (prevState === 'live' || prevState === 'think' || prevState === 'input')) {
            autoNotifyConductor(name, lastLine);
          }
          // Drain the per-musician queue on any turn completion (unread/idle/error).
          // Uses setImmediate inside drainQueue so it never blocks this pump iteration.
          if (ev.type === 'result' &&
              (newState === 'unread' || newState === 'idle' || newState === 'error') &&
              (prevState === 'live' || prevState === 'think')) {
            drainQueue(name);
          }
        } catch { /* malformed line — skip */ }
      }
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
  crashLog(`EXPRESS ERROR ${req.method} ${req.url}: ${err && err.stack || err}`);
  if (res.headersSent) return next(err);
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
