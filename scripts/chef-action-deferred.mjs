#!/usr/bin/env node
// ============================================================================
// scripts/chef-action-deferred.mjs — runs one allowlisted chef action once a
// given process (the chef's Routage turn) has exited (0.70.0)
// ============================================================================
//
// The Routage's Dispatcher launches this through Win32_Process Create, so it
// does not belong to the server's process tree: restart-orchestrateur.mjs
// kills that tree, which the chef's turn is part of. Waiting for the turn to
// end first means the chef's report is written before the server goes down.
//
// Usage:
//   node scripts/chef-action-deferred.mjs --wait-pid <pid> --script restart-orchestrateur.mjs
//        [--log <file>] [--max-wait-ms <n>] [--dry-run]
//   node scripts/chef-action-deferred.mjs --wait-pid <pid> --handoff <logs/runs/<run>/handoff.json> (0.88.0)
// Only scripts of the allowlist below, from this very directory, can run.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED = new Set(['restart-orchestrateur.mjs']);
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const pid = Number(opt('--wait-pid'));
const script = opt('--script');
const logFile = opt('--log');
const maxWait = Number(opt('--max-wait-ms')) || 10 * 60_000;
const dryRun = argv.includes('--dry-run');

function log(msg) {
  const line = `${new Date().toISOString()} [chef-action] ${msg}`;
  console.log(line);
  if (logFile) { try { fs.appendFileSync(logFile, `${line}\n`); } catch { /* never blocks */ } }
}
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const handoffFile = opt('--handoff');
if (!handoffFile && !ALLOWED.has(script)) { log(`refused: script « ${script} » is not allowlisted`); process.exit(64); }
if (!Number.isInteger(pid) || pid <= 0) { log('refused: --wait-pid <pid> required'); process.exit(64); }

const t0 = Date.now();
const limit = handoffFile ? Math.max(maxWait, 30 * 60_000) : maxWait;
while (alive(pid) && Date.now() - t0 < limit) await new Promise(r => setTimeout(r, 1000));
if (alive(pid)) log(`process ${pid} still alive after ${limit} ms — running anyway`);

// Hand-off to the chef (0.88.0): one chef turn out of the Routage, signed by
// ORCH_HANDOFF_TOKEN (inherited), only once the Routage turn has ended.
if (handoffFile) {
  let h = null;
  try { h = JSON.parse(fs.readFileSync(handoffFile, 'utf8')); } catch (e) { log(`handoff: unreadable ${handoffFile}: ${e.message}`); process.exit(65); }
  if (dryRun) { log(`dry-run: would hand ${h.ref} to ${h.conductor}`); process.exit(0); }
  log(`handoff ${h.ref} → ${h.conductor} (turn ${pid} ended after ${Date.now() - t0} ms)`);
  const r = spawnSync(process.execPath, [path.join(HERE, 'dispatch.mjs'), h.conductor || 'chef', '--prompt-stdin', '--chef-handoff', h.ref],
    { input: h.prompt, encoding: 'utf8', windowsHide: true, cwd: path.resolve(HERE, '..') });
  log(`handoff ${h.ref} exited with ${r.status}: ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(-800)}`);
  process.exit(r.status ?? 1);
}
const target = path.join(HERE, script);
if (dryRun) { log(`dry-run: would run ${target}`); process.exit(0); }
log(`running ${script} (turn ${pid} ended after ${Date.now() - t0} ms)`);
const r = spawnSync(process.execPath, [target], { encoding: 'utf8', windowsHide: true });
log(`${script} exited with ${r.status}: ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(-800)}`);
process.exit(r.status ?? 1);
