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
// Three ways to pass the text:
//
//   File (recommended for sub-agents, 0.37.2) — the summary is written with the
//   Write tool, then ONE simple command sends it. No shell variable, heredoc or
//   pipe: the CLI's safety analysis refuses those in non-interactive mode.
//     node notify.mjs <project> --file <path> [--source <project>] [--keep]
//   The file is deleted after a successful delivery unless --keep is given.
//
//   Stdin:   printf 'text' | node notify.mjs <project> --stdin [--source <project>]
//   Inline:  node notify.mjs <project> "short text" [--source <project>]

const USAGE = 'usage: node scripts/notify.mjs <project> "<text>" | --stdin | --file <path> [--source <project>] [--keep]';
const argv = process.argv.slice(2);
if (argv.length < 1 || argv[0].startsWith('--')) die(USAGE);

const projectName = argv[0];
const takeOpt = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  if (i + 1 >= argv.length) die(`${name} requires a value`);
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const takeFlag = (name) => { const i = argv.indexOf(name); if (i === -1) return false; argv.splice(i, 1); return true; };

const sourceProject = takeOpt('--source');
const filePath = takeOpt('--file');
const keepFile = takeFlag('--keep');
const useStdin = takeFlag('--stdin');

let text;
if (filePath) {
  try { text = fs.readFileSync(path.resolve(filePath), 'utf8').replace(/^﻿/, '').trim(); }
  catch (e) { die(`cannot read --file ${filePath}: ${e.message}`, 66); }
} else if (useStdin) {
  try { text = fs.readFileSync(0, 'utf8').replace(/^﻿/, '').trim(); }
  catch (e) { die(`stdin read failed: ${e.message}`); }
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

function post(payloadText) {
  const body = Buffer.from(JSON.stringify({ project: projectName, text: payloadText, source: sourceProject }), 'utf8');
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 7777,
      path: '/api/notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Orchestrator-Token': token,
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data, bytes: body.length }));
    });
    req.on('error', (err) => resolve({ status: 0, data: err.message, bytes: body.length }));
    req.end(body);
  });
}

/** Coupe aux paragraphes (puis aux lignes) en morceaux d'au plus `max` octets. */
function splitText(t, max) {
  const parts = [];
  let cur = '';
  const pushCur = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };
  for (const block of t.split(/(\n\s*\n)/)) {
    if (Buffer.byteLength(cur + block) <= max) { cur += block; continue; }
    pushCur();
    if (Buffer.byteLength(block) <= max) { cur = block; continue; }
    for (const line of block.split('\n')) {
      if (Buffer.byteLength(cur + line + '\n') > max) pushCur();
      // Une ligne seule trop longue : coupée brutalement, rien n'est perdu.
      let l = line;
      while (Buffer.byteLength(l) > max) { parts.push(l.slice(0, Math.floor(max / 3))); l = l.slice(Math.floor(max / 3)); }
      cur += l + '\n';
    }
  }
  pushCur();
  return parts;
}

const reason = (r) => { try { return JSON.parse(r.data).error || r.data; } catch { return r.data; } };

let r = await post(text);
// Serveur antérieur à 0.37.2 : /api/notify limité à 2 Ko (un corps plus gros
// finissait en HTTP 500). On envoie alors le texte en plusieurs parties
// numérotées plutôt que de le perdre.
if ((r.status === 413 || r.status === 500) && r.bytes > 1900) {
  const parts = splitText(text, 1500);
  console.error(`[notify] server refused ${r.bytes} bytes (HTTP ${r.status}) — sending in ${parts.length} parts`);
  for (let i = 0; i < parts.length; i++) {
    r = await post(`[partie ${i + 1}/${parts.length}]\n${parts[i]}`);
    if (r.status !== 200 && r.status !== 202) break;
  }
}
if (r.status === 200 || r.status === 202) {
  if (filePath && !keepFile) { try { fs.rmSync(path.resolve(filePath), { force: true }); } catch { /* best effort */ } }
  console.log(`[notify] callback delivered to ${projectName}${sourceProject ? ` (from ${sourceProject})` : ''}`);
} else if (r.status === 0) {
  console.error(`[notify] request failed: ${r.data} — is the server running on port 7777?`);
  process.exit(1);
} else {
  console.error(`[notify] server returned HTTP ${r.status}: ${reason(r)}`);
  process.exit(1);
}
