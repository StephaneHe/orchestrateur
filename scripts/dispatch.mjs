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
// NOTE on --bare: NOT used. See server.js top-of-file comment for the
// reasoning (--bare disables OAuth; we want subscription billing). We
// approximate the isolation with --setting-sources project,local +
// --strict-mcp-config + --disable-slash-commands.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function die(msg, code = 64) { console.error(`[dispatch] ${msg}`); process.exit(code); }

// ---------- argv ------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.length < 1) die('usage: node scripts/dispatch.mjs <project> "<prompt>" | --prompt-stdin');

const projectName = argv[0];
let prompt = '';

if (argv[1] === '--prompt-stdin') {
  prompt = fs.readFileSync(0, 'utf8');
} else if (argv.length >= 2) {
  prompt = argv.slice(1).join(' ');
} else {
  die('missing prompt — pass as argv or use --prompt-stdin');
}

if (!prompt.trim()) die('empty prompt');

// ---------- config ----------------------------------------------------------

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const project = config.projects.find(p => p.name === projectName);
if (!project) {
  die(`unknown project "${projectName}". Known: ${config.projects.map(p => p.name).join(', ')}`);
}
if (!fs.existsSync(project.path)) {
  die(`project path does not exist: ${project.path}`, 66);
}

const model = project.model || config.defaults?.model || 'claude-sonnet-4-6';
const tools = project.tools || config.defaults?.allowedTools || 'Read,Edit,Write,Bash';

// ---------- paths -----------------------------------------------------------

const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

const logPath     = path.join(LOGS, `${projectName}.jsonl`);
const sessionPath = path.join(LOGS, `${projectName}.session`);
const pidPath     = path.join(LOGS, `${projectName}.pid`);

let sessionId = null;
try { sessionId = fs.readFileSync(sessionPath, 'utf8').trim() || null; } catch {}

// ---------- claude argv -----------------------------------------------------

const args = [
  '--print',
  prompt,
  '--output-format', 'stream-json',
  '--verbose',                              // required with stream-json
  '--include-partial-messages',
  '--allowed-tools', tools,
  '--model', model,
  '--setting-sources', 'project,local',     // skip global user settings
  '--strict-mcp-config',                    // no MCP servers
  '--disable-slash-commands',               // no skills leaking in
];
if (sessionId) args.push('--resume', sessionId);

// ---------- env scrub -------------------------------------------------------

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;   // subscription auth only

// ---------- spawn -----------------------------------------------------------

const logStream = fs.createWriteStream(logPath, { flags: 'a' });
logStream.write(`\n`); // ensure boundary from previous turn

// Synthetic "user_prompt" event so the viewer can show what was asked before
// any real stream-json event arrives (Claude's first init can take >1s).
logStream.write(JSON.stringify({
  type: 'user_prompt',
  text: prompt,
  timestamp: new Date().toISOString(),
}) + '\n');

const child = spawn('claude', args, {
  cwd: project.path,      // project CLAUDE.md and .claude/ load from here
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  windowsHide: true,
});

// Record the claude child PID so fleet-status.mjs can check if a stalled
// turn's process is still alive. Removed on clean exit below.
try { fs.writeFileSync(pidPath, String(child.pid)); } catch {}

// ---------- event parsing → session sidecar ---------------------------------

let newSessionId = null;
let stdoutTail = '';

child.stdout.on('data', (chunk) => {
  logStream.write(chunk);
  // Also echo to stderr so the central sees progress in its Bash tool output
  // (Bash tool displays stderr inline for the agent).
  // Commented out — would double-log in most workflows. Uncomment if needed.
  // process.stderr.write(chunk);

  if (newSessionId) return; // already captured
  stdoutTail += chunk.toString('utf8');
  const lines = stdoutTail.split('\n');
  stdoutTail = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim() || newSessionId) continue;
    try {
      const ev = JSON.parse(line);
      if (typeof ev.session_id === 'string' && ev.session_id.length > 0) {
        newSessionId = ev.session_id;
        fs.writeFileSync(sessionPath, newSessionId);
      }
    } catch { /* partial/corrupt — skip */ }
  }
});

child.stderr.on('data', (chunk) => {
  logStream.write(chunk);
  process.stderr.write(chunk);
});

child.on('error', (err) => {
  console.error(`[dispatch] spawn error: ${err.message}`);
});

child.on('exit', (code, signal) => {
  logStream.end();
  try { fs.unlinkSync(pidPath); } catch {}
  if (signal) {
    console.error(`[dispatch] sub-agent killed by ${signal}`);
    process.exit(128);
  }
  process.exit(code ?? 1);
});
