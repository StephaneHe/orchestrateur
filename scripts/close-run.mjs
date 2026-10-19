#!/usr/bin/env node
// ============================================================================
// scripts/close-run.mjs — close a paused pipeline run cleanly (Routage v3,
// phase 0 b)
// ============================================================================
//
//   node scripts/close-run.mjs <run> [--reason "…"] [--by utilisateur|chef]
//
// A paused run (the chef's Routage included) used to have no exit but an
// answer in the chat, which never reached a paused Routage run. This command
// closes one, from outside any turn:
//   - run.json → status « abandoned » (abandonedBy « commande », closed {by,
//     reason, at}); nothing is undone or deleted in the project;
//   - the project's log gets `system/pipeline_summary` (status abandoned) and
//     `notification/question_resolved`: the pause question is acknowledged,
//     the musician goes back to idle; NO result event (no queue drain, no
//     chef wake-up, no fake end of turn);
//   - postcondition: run.json is re-read; « fait » only if it is terminal.
//
// Refused: a run whose process is alive (3: stop the turn first), a run in a
// parallel lane k ≥ 1 (64: answer « abandonner » with --lane k, which frees
// the lane). A run left « running » by a dead process (orphaned) is paused
// first, then closed. Already terminal: exit 2, nothing written.
//
// Exit codes: 0 closed · 2 already terminal · 3 process alive · 64 usage.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_RE, reclaimOrphanedRun } from './pipeline-engine.mjs';
import { writeFileAtomic } from './atomic-file.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(here, '..');
const LOGS = path.join(ROOT, 'logs');

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const run = argv.find(a => RUN_RE.test(a));
const reason = String(opt('--reason') || '').trim().slice(0, 500) || null;
const by = String(opt('--by') || 'utilisateur').trim().slice(0, 40);
if (!run) {
  console.error('usage: node scripts/close-run.mjs <p-AAAAMMJJTHHMMSS-xxxxxx> [--reason "…"] [--by utilisateur|chef]');
  process.exit(64);
}
const file = path.join(LOGS, 'runs', run, 'run.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

let state = read();
if (!state) { console.error(`[close-run] ${run} : exécution inconnue (${path.relative(ROOT, file)} absent)`); process.exit(64); }
if (state.status === 'running') {
  if (alive(state.pid)) {
    console.error(`[close-run] ${run} (${state.project}) tourne encore (processus ${state.pid}) : arrête d'abord le tour (kill-stalled.mjs ${state.project} --by ${by}), puis relance cette commande.`);
    process.exit(3);
  }
  state = reclaimOrphanedRun(LOGS, run) || read();
}
if (state.status !== 'paused') {
  console.log(`[close-run] ${run} (${state.project}) est déjà terminée (${state.status}) : rien à faire.`);
  process.exit(2);
}
if (Number(state.lane?.k) >= 1) {
  console.error(`[close-run] ${run} attend dans le couloir ${state.lane.k} de ${state.project} : réponds « abandonner » avec --lane ${state.lane.k} (dispatch.mjs ${state.project} "abandonner" --lane ${state.lane.k}), ce qui libère le couloir.`);
  process.exit(64);
}

const at = new Date().toISOString();
const question = state.question || null;
state.status = 'abandoned';
state.abandonedBy = 'commande';
state.closed = { by, reason, at, pausedLimit: state.pausedLimit || null };
state.endedAt = at;
state.updatedAt = at;
writeFileAtomic(file, JSON.stringify(state, null, 2));

const what = `exécution ${run} close par commande (${by})${reason ? ` : ${reason}` : ''}`;
const log = path.join(LOGS, `${state.project}.jsonl`);
const ev = (e) => JSON.stringify({ ...e, timestamp: at });
fs.appendFileSync(log, [
  ev({ type: 'system', subtype: 'pipeline_summary', pipeline: { run, pipeline: state.pipeline, mode: state.mode, status: 'abandoned' }, closed: state.closed,
    text: `${what} — rien n'est annulé dans le projet, ce qui est déjà livré reste livré` }),
  ev({ type: 'notification', subtype: 'question_resolved', question, note: what, by, run }),
].join('\n') + '\n');

const after = read();
if (after?.status !== 'abandoned') { console.error(`[close-run] ${run} : postcondition non remplie (statut relu : ${after?.status})`); process.exit(1); }
console.log(`[close-run] ✓ ${what}. Statut relu : abandoned. Question de la pause acquittée dans ${state.project}.`);
process.exit(0);
