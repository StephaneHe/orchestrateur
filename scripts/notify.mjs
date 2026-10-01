#!/usr/bin/env node
// ============================================================================
// scripts/notify.mjs — lightweight callback notification (no headless claude)
// ============================================================================
//
// Called by sub-agents at the end of a task INSTEAD of dispatch.mjs when the
// destination is the conductor (chef). Appends a user_prompt event to the
// project's log and triggers a desktop notification — without spawning a
// headless AI turn that the interactive chef session will never see.
//
//   node scripts/notify.mjs <project> "<text>" --source <sourceProject>
//
// The server's SSE stream picks up the new event and the dashboard displays
// it as a "callback" bubble in the conductor view. A Windows toast fires so
// the user sees it even if the dashboard is in the background.
// ============================================================================

import fs   from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

function die(msg, code = 64) { console.error(`[notify] ${msg}`); process.exit(code); }

// ---------- argv ------------------------------------------------------------
//
// Two calling conventions are supported:
//
//   Inline arg (short text only — may break if text contains newlines or
//   shell-special chars like | " ` on Windows):
//     node notify.mjs <project> "text" [--source <project>]
//
//   Stdin (recommended for multi-line or markdown-rich text):
//     printf 'text' | node notify.mjs <project> --stdin [--source <project>]
//     echo "text" | node notify.mjs <project> --stdin [--source <project>]
//
// Sub-agents should always use the stdin form to avoid shell truncation.

const argv = process.argv.slice(2);
if (argv.length < 1) die('usage: node scripts/notify.mjs <project> "<text>" | --stdin [--source <project>]');

const projectName = argv[0];

let sourceProject = null;
const srcIdx = argv.indexOf('--source');
if (srcIdx !== -1) {
  if (srcIdx + 1 >= argv.length) die('--source requires a project name');
  sourceProject = argv[srcIdx + 1];
  argv.splice(srcIdx, 2);
}

// Determine text source: stdin flag or inline argv.
const useStdin = argv.includes('--stdin');

let text;
if (useStdin) {
  // Read entire stdin synchronously (fd 0).
  try {
    text = fs.readFileSync(0, 'utf8').trim();
  } catch (e) {
    die(`stdin read failed: ${e.message}`);
  }
} else {
  text = argv.slice(1).join(' ').trim();
}

if (!text) die('empty text');

// ---------- token -----------------------------------------------------------

const tokenPath = path.join(ROOT, '.token');
let token;
try { token = fs.readFileSync(tokenPath, 'utf8').trim(); }
catch { die('could not read .token — is the orchestrateur server running?'); }

// ---------- POST /api/notify ------------------------------------------------

const body = Buffer.from(JSON.stringify({ project: projectName, text, source: sourceProject }));

const req = http.request({
  hostname: '127.0.0.1',
  port: 7777,
  path: '/api/notify',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Orchestrator-Token': token,
    'Content-Length': body.length,
  },
}, (res) => {
  res.resume(); // drain
  if (res.statusCode === 200 || res.statusCode === 202) {
    console.log(`[notify] callback delivered to ${projectName}${sourceProject ? ` (from ${sourceProject})` : ''}`);
  } else {
    console.error(`[notify] server returned HTTP ${res.statusCode}`);
    process.exit(1);
  }
});

req.on('error', (err) => {
  console.error(`[notify] request failed: ${err.message} — is the server running on port 7777?`);
  process.exit(1);
});

req.end(body);
