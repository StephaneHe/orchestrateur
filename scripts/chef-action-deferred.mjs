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
// A refused or failed hand-off (0.100.2) is also posted to the chef's thread:
// logs/chef-actions.log alone left the task lost without any visible signal.
if (handoffFile) {
  let h = null;
  try { h = JSON.parse(fs.readFileSync(handoffFile, 'utf8')); } catch (e) {
    log(`handoff: unreadable ${handoffFile}: ${e.message}`);
    postHandoffFailure(null, 65, `fichier de renvoi illisible (${path.basename(handoffFile)}) : ${e.message}`);
    process.exit(65);
  }
  if (dryRun) { log(`dry-run: would hand ${h.ref} to ${h.conductor}`); process.exit(0); }
  log(`handoff ${h.ref} → ${h.conductor} (turn ${pid} ended after ${Date.now() - t0} ms)`);
  const r = spawnSync(process.execPath, [path.join(HERE, 'dispatch.mjs'), h.conductor || 'chef', '--prompt-stdin', '--chef-handoff', h.ref],
    { input: h.prompt, encoding: 'utf8', windowsHide: true, cwd: path.resolve(HERE, '..') });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const code = r.status ?? 1;
  const why = code === 0 ? out.slice(-800) : refusalReason(r, out);
  log(`handoff ${h.ref} exited with ${code}: ${why.replace(/\s+/g, ' ')}`);
  if (code !== 0 && out && out !== why) log(`handoff ${h.ref} output: ${out.slice(-800).replace(/\s+/g, ' ')}`);
  if (code !== 0) postHandoffFailure(h, code, why);
  process.exit(code);
}

/** The line that says why: dispatch.mjs refuses with « [dispatch] <reason> » on stderr. */
function refusalReason(r, out) {
  if (r.error) return `lancement impossible : ${r.error.message}`;
  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const said = lines.filter(l => l.startsWith('[dispatch]')).pop() || lines.pop();
  return (said || (r.signal ? `arrêté par le signal ${r.signal}` : `sortie ${r.status} sans message`)).slice(0, 600);
}

/**
 * Appends one visible card to the chef's thread: the same notification shape
 * as a failed musician turn (rendered live and on reload by /api/conductor-chat),
 * with the reference, the titles of the tasks handed back, the code and the reason.
 */
function postHandoffFailure(h, code, why) {
  const logsDir = path.resolve(path.dirname(handoffFile), '..', '..');
  const run = path.basename(path.dirname(handoffFile));
  const conductor = (h && typeof h.conductor === 'string' && /^[A-Za-z0-9_.-]+$/.test(h.conductor)) ? h.conductor : 'chef';
  const ref = h?.ref || `${run}#?`;
  const tasks = Array.isArray(h?.tasks) ? h.tasks.map(t => ({ n: t.n, titre: t.titre, projet: t.projet })) : [];
  const titles = tasks.length ? tasks.map(t => `tâche ${t.n} « ${t.titre || '?'} »`).join(', ') : 'tâche inconnue';
  // 64/65 = dispatch.mjs refused before any turn; anything else = the turn failed.
  const refused = code === 64 || code === 65;
  const summary = refused
    ? `↩ Renvoi au chef refusé — ${ref} : ${titles}. Code ${code} : ${why}. La tâche n’a pas été exécutée ; elle est à relancer.`
    : `↩ Renvoi au chef en échec — ${ref} : ${titles}. Code ${code} : ${why}. Le tour du chef n’a pas abouti ; vérifier la tâche avant de la relancer.`;
  const ev = { type: 'notification', subtype: 'musician_done', outcome: 'failed', source: conductor,
    text: `[${conductor}] Échec. ${summary}`, summary, timestamp: new Date().toISOString(),
    handoff: { ref, run, tasks, code, why } };
  try { fs.appendFileSync(path.join(logsDir, `${conductor}.jsonl`), `\n${JSON.stringify(ev)}\n`); log(`handoff ${ref}: failure posted to the ${conductor} thread`); }
  catch (e) { log(`handoff ${ref}: could not post the failure to the ${conductor} thread: ${e.message}`); }
}

const target = path.join(HERE, script);
if (dryRun) { log(`dry-run: would run ${target}`); process.exit(0); }
log(`running ${script} (turn ${pid} ended after ${Date.now() - t0} ms)`);
const r = spawnSync(process.execPath, [target], { encoding: 'utf8', windowsHide: true });
log(`${script} exited with ${r.status}: ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(-800)}`);
process.exit(r.status ?? 1);
