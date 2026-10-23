// ============================================================================
// scripts/queue-requeue.mjs — a queued task refused at launch for a passing
// cause is never lost (0.144.0)
// ============================================================================
//
// Defect seen in production (2026-10-23): while a dev pipeline run was PAUSED
// in a musician's main checkout (its files uncommitted), the server drained the
// musician's queue; the head started a new dev run, the engine refused it
// (« modifications non commitées ») and the task was gone from the queue — then
// the next one too. The chef noticed by hand.
//
// User request, verbatim: « Tant qu'une exécution de pipeline d'un projet est en
// pause dans un couloir (copie de travail non propre à cause d'elle), la file de
// ce couloir ne lance PAS sa tête : elle attend la fin (ou la clôture) de
// l'exécution. » and « Une tâche de file refusée au lancement pour une cause
// passagère (copie non propre, couloir occupé) n'est jamais perdue : elle
// reste/revient en tête de file, et le chef est alerté (chefAlerts) si elle est
// refusée pour une cause durable. »
//
// Two halves, both decided by code on facts (run.json, git status), never on
// the request's words:
//   - dispatch.mjs, BEFORE anything is written to the musician's log: a new
//     pipeline run launched from the queue (or with --queue-if-busy) whose lane
//     cannot take it goes back to the queue — at the HEAD when it came from it —
//     with `heldBy` {kind, run?, lane, why, durable};
//   - server.js: a head held by a paused run is not launched while that run is
//     paused; any other hold is retried after a delay or on the musician's next
//     result. A durable hold (tree dirty with no paused run to explain it) is
//     raised to the chef (chef-alerts.mjs, kind `queue`).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const HELD_KINDS = Object.freeze(['paused-run', 'dirty', 'capacity']);
const RUN_RE = /^p-\d{8}T\d{6}-[a-z0-9]{4,8}$/;
// Retry of a hold that no run explains (tree dirty, every lane busy). Tests: ORCH_QUEUE_HELD_RETRY_MS.
export const RETRY_MS = Object.freeze({ dirty: 10 * 60_000, capacity: 60_000 });

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const one = (s, n = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Why a NEW pipeline run cannot start in this lane, or null.
 *   lane0Run: the latest main-checkout run of the project if paused ({run, ...}) — lanes.pausedPipelineRuns
 *   dirty:    uncommitted files of the checkout (machine-local files excluded)
 *   needsClean: the chosen pipeline refuses a dirty tree (null = not known yet: before classification)
 * A paused run that left the checkout dirty holds it whatever the pipeline
 * (request 1); a dirty tree nobody explains holds only a pipeline that needs
 * it clean, and is durable.
 */
export function startBlocker({ pausedRun = null, dirty = [], needsClean = null, lane = 0 }) {
  if (!dirty.length) return null;
  if (pausedRun?.run) {
    return { kind: 'paused-run', run: pausedRun.run, lane, durable: false, files: dirty.length,
      why: `l’exécution ${pausedRun.run} est en pause dans ${lane ? `le couloir ${lane}` : 'la copie principale'} et y laisse ${dirty.length} fichier(s) non commité(s) : la tâche attend sa fin ou sa clôture` };
  }
  if (needsClean) {
    return { kind: 'dirty', lane, durable: true, files: dirty.length,
      why: `${lane ? `le couloir ${lane}` : 'la copie principale'} a ${dirty.length} fichier(s) non commité(s) qu’aucune exécution en pause n’explique (${dirty.slice(0, 4).map(l => l.slice(3)).join(', ')}${dirty.length > 4 ? '…' : ''}) : à commiter ou ranger` };
  }
  return null;
}

/** Validates a `heldBy` received over HTTP (server.js), or null. */
export function cleanHeldBy(h, now = new Date()) {
  if (!h || typeof h !== 'object' || !HELD_KINDS.includes(h.kind)) return null;
  const out = { kind: h.kind, lane: Number.isInteger(h.lane) && h.lane >= 0 && h.lane <= 9 ? h.lane : 0,
    why: one(h.why), durable: h.durable === true, at: now.toISOString() };
  if (h.kind === 'paused-run') {
    if (typeof h.run !== 'string' || !RUN_RE.test(h.run)) return null;
    out.run = h.run;
  }
  if (Number.isInteger(h.files) && h.files >= 0) out.files = h.files;
  if (typeof h.since === 'string' && Number.isFinite(Date.parse(h.since))) out.since = h.since;
  return out;
}

/**
 * Does a held queue head still have to wait? Pure apart from reading run.json.
 *   reason: what triggered the drain ('result', 'sweep', …)
 * A paused-run hold waits while that run is paused (any other status — done,
 * failed, abandoned, unreadable — releases it); another hold is retried on the
 * musician's next result or after its delay.
 */
export function heldBlocks(entry, { logsDir, now = Date.now(), reason = 'sweep', retryMs = null } = {}) {
  const h = entry?.heldBy;
  if (!h) return { blocked: false };
  if (h.kind === 'paused-run') {
    const s = readJson(path.join(logsDir, 'runs', h.run, 'run.json'));
    return s?.status === 'paused' ? { blocked: true, why: h.why || `exécution ${h.run} en pause` } : { blocked: false, released: `exécution ${h.run} ${s?.status || 'introuvable'}` };
  }
  if (reason === 'result') return { blocked: false, released: 'fin d’un tour du musicien' };
  const wait = retryMs ?? Number(process.env.ORCH_QUEUE_HELD_RETRY_MS) ?? 0;
  const delay = Number.isFinite(wait) && wait > 0 ? wait : (RETRY_MS[h.kind] || 60_000);
  const at = Date.parse(h.at || '') || 0;
  return now - at < delay ? { blocked: true, why: h.why || h.kind } : { blocked: false, released: 'nouvel essai' };
}

/** Stable identity of a held task across its requeues (the queue id changes each time). */
export function heldKey(project, entry) {
  const who = entry?.taskId || crypto.createHash('sha1').update(String(entry?.prompt || '')).digest('hex').slice(0, 12);
  return `queue:${project}:${who}:${entry?.heldBy?.kind || '?'}`;
}

/** The event written to the musician's log when a task goes back to its queue. */
export function heldEvent(h, { front, title }) {
  return { type: 'notification', subtype: 'queue_entry_held', held: { kind: h.kind, run: h.run || null, lane: h.lane || 0, durable: !!h.durable, front: !!front },
    text: `⏸ Tâche remise ${front ? 'en tête de' : 'dans la'} file, rien n’est lancé ni perdu — ${h.why}${title ? ` : « ${one(title, 120)} »` : ''}` };
}
