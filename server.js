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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import express from 'express';
import expressWs from 'express-ws';
import chokidar from 'chokidar';
import * as pty from 'node-pty';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PORT       = 7777;
const LOGS_DIR        = path.join(__dirname, 'logs');
const CENTRAL_LOG     = path.join(LOGS_DIR, 'central.log');
const TOKEN_PATH      = path.join(__dirname, '.token');
const CONFIG_PATH     = path.join(__dirname, 'config.json');
const ATTACHMENTS_DIR = path.join(__dirname, 'attachments');

fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

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
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const ip = out.trim().split(/\r?\n/)[0];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  } catch { /* tailscale not installed / not running — silently fall back */ }
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

// Keep memory in sync when sidecars change on disk (dispatch.mjs writes them
// out-of-band in a separate process).
const sessionWatcher = chokidar.watch(path.join(LOGS_DIR, '*.session'), {
  persistent: true, ignoreInitial: true,
});
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
  const local = normalizeAddr(info.req.socket.localAddress);
  if (!ALLOWED_LOCAL_ADDRS.has(local)) return false;
  const urlQ = /[?&]token=([^&#]+)/.exec(info.req.url || '');
  const qtok = urlQ ? decodeURIComponent(urlQ[1]) : null;
  const htok = info.req.headers['x-orchestrator-token'];
  const ctok = parseCookieToken(info.req.headers.cookie);
  if (tokensEqual(qtok, TOKEN) || tokensEqual(htok, TOKEN) || tokensEqual(ctok, TOKEN)) return true;
  return false;
}

expressWs(app, httpServer, { wsOptions: { verifyClient: wsVerifyClient } });

// [1] Interface allowlist — runs first so 403 is unambiguous.
app.use((req, res, next) => {
  const local = normalizeAddr(req.socket.localAddress);
  if (!ALLOWED_LOCAL_ADDRS.has(local)) {
    res.status(403).type('text/plain')
       .end(`Forbidden: interface ${local} not in allowlist`);
    return;
  }
  next();
});

// [2] Token gate — accepts query param, X-Orchestrator-Token header, or a
// previously-set HttpOnly cookie. On first authenticated request the cookie
// is stamped so subsequent subresource/SSE/WS requests authenticate without
// the viewer having to append ?token=… to every URL.
app.use((req, res, next) => {
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

// Static viewer assets
app.use(express.static(path.join(__dirname, 'public'), {
  fallthrough: true,
  etag: true,
}));

// ---------- REST API --------------------------------------------------------

// Project list for the viewer — names + effective tool/model only, never
// absolute filesystem paths (defense in depth, even though it's already
// single-user and token-gated).
app.get('/api/config', (req, res) => {
  const defaults = config.defaults ?? {};
  res.json({
    defaults: {
      model: defaults.model ?? null,
      allowedTools: defaults.allowedTools ?? 'Read,Edit,Write,Bash',
    },
    projects: config.projects.map(p => ({
      name: p.name,
      model: p.model ?? defaults.model ?? null,
      tools: p.tools ?? defaults.allowedTools ?? 'Read,Edit,Write,Bash',
      attachedSession: sessions.get(p.name) || null,
    })),
  });
});

app.get('/api/sessions', (req, res) => {
  res.json(Object.fromEntries(sessions));
});

// ---------- Aggregate SSE (all projects over one connection) ---------------
//
// Chrome/Edge cap HTTP/1.1 at 6 simultaneous connections per origin. One-
// per-project SSE + the WebSocket for the central pty quickly eats that
// budget; subsequent ad-hoc requests (DELETE /api/projects/:name, session
// listings, etc.) stall in "pending" forever. This multiplexes every
// project's log tail into a single event stream, so the viewer only holds
// one SSE connection regardless of fleet size.

app.get('/api/sse/fleet', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');

  // One offset/partial state + watcher per project we tail.
  const active = new Map();       // name -> { offset, partial, watcher }

  const attachProject = (name) => {
    if (active.has(name)) return;
    const logPath = path.join(LOGS_DIR, `${name}.jsonl`);
    const state = { offset: 0, partial: '' };

    const pump = () => {
      let stat;
      try { stat = fs.statSync(logPath); } catch { return; }
      if (stat.size < state.offset) { state.offset = 0; state.partial = ''; }
      if (stat.size > state.offset) {
        const buf = Buffer.alloc(stat.size - state.offset);
        const fd = fs.openSync(logPath, 'r');
        try { fs.readSync(fd, buf, 0, buf.length, state.offset); }
        finally { fs.closeSync(fd); }
        state.offset = stat.size;
        state.partial += buf.toString('utf8');
        const lines = state.partial.split('\n');
        state.partial = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const envelope = JSON.stringify({ project: name, line });
          res.write(`data: ${envelope}\n\n`);
        }
      }
    };
    pump();

    const watcher = chokidar.watch(logPath, {
      persistent: true, ignoreInitial: true,
    });
    watcher.on('add', pump);
    watcher.on('change', pump);
    active.set(name, { state, watcher });
  };

  for (const p of config.projects) attachProject(p.name);

  // Poll the config list periodically: if a project was added via the UI,
  // pick up its stream without forcing the viewer to reconnect.
  const configPoll = setInterval(() => {
    const want = new Set(config.projects.map(p => p.name));
    for (const name of [...active.keys()]) {
      if (!want.has(name)) {
        active.get(name).watcher.close().catch(() => {});
        active.delete(name);
      }
    }
    for (const name of want) if (!active.has(name)) attachProject(name);
  }, 3000);

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    clearInterval(configPoll);
    for (const { watcher } of active.values()) watcher.close().catch(() => {});
    active.clear();
    try { res.end(); } catch {}
  });
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
app.post('/api/projects/:name/sessions/new', express.json({ limit: '16kb' }), (req, res) => {
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

  const poll = setInterval(() => {
    if (settled) return;
    try {
      const sid = fs.readFileSync(sidePath, 'utf8').trim();
      if (sid) {
        settle(() => {
          sessions.set(proj.name, sid);
          res.json({ ok: true, session_id: sid });
        });
        return;
      }
    } catch {}
    if (Date.now() > deadline) {
      settle(() => res.status(504).json({ error: 'timed out waiting for Claude to start — check logs' }));
    }
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

  if (config.projects.some(p => p.name === name)) {
    return res.status(409).json({ error: `project name "${name}" already exists` });
  }
  if (config.projects.some(p => path.resolve(p.path).toLowerCase() === normalizedLower)) {
    return res.status(409).json({ error: 'path is already registered under another name' });
  }

  const entry = { name, path: normalized };
  if (typeof model === 'string' && model.trim()) entry.model = model.trim();
  if (typeof tools === 'string' && tools.trim()) entry.tools = tools.trim();

  config.projects.push(entry);
  atomicWriteJson(CONFIG_PATH, config);
  PROJECT_NAMES.add(name);

  const effective = {
    name,
    model: entry.model ?? config.defaults?.model ?? null,
    tools: entry.tools ?? config.defaults?.allowedTools ?? 'Read,Edit,Write,Bash',
    attachedSession: null,
  };
  res.status(201).json({ ok: true, project: effective });
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
  res.json({ ok: true });
});

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
  ['image/png',  '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif',  '.gif'],
]);
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

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
      abort(413, `image exceeds ${MAX_ATTACH_BYTES / 1024 / 1024} MB limit`);
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
        res.write(`data: ${line}\n\n`);
      }
    }
  }
  pump();

  const watcher = chokidar.watch(logPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: false,
    usePolling: false,
  });
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
  const qtok = typeof req.query?.token === 'string' ? req.query.token : null;
  const htok = req.header('x-orchestrator-token');
  const ctok = parseCookieToken(req.headers?.cookie);
  if (!tokensEqual(qtok, TOKEN) && !tokensEqual(htok, TOKEN) && !tokensEqual(ctok, TOKEN)) {
    try { ws.close(1008, 'unauthorized'); } catch {}
    return;
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

// ---------- Start -----------------------------------------------------------

httpServer.listen(PORT, '0.0.0.0', () => {
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
});

function shutdown(signal) {
  console.log(`\n[orchestrator] ${signal} → shutting down`);
  if (centralPty) { try { centralPty.kill(); } catch {} }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
