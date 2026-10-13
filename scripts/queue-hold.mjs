// ============================================================================
// scripts/queue-hold.mjs — a queue held by a process that outlived its turn.
// ============================================================================
//
// User report (2026-10-13): « A partir du moment où quelque chose tourne,
// attaché à un projet, et que ça empêche le projet d'avancer […], alors c'est
// un problème qu'il faut corriger. »
//
// The CLI keeps a turn's process alive after its `result` while a task it
// started in the background runs. The server then holds the musician's queue
// (dispatchPidAlive), which is right — launching the next turn would race the
// running work — but it used to do so silently and for as long as the process
// lived. This module decides when such a hold must be reported.
//
// Policy (no automatic kill): the background work is usually legitimate (the
// incident was a regression run), and killing it would lose it. So:
//   - the hold is visible at once (scanProject `queueHeld`, dashboard,
//     fleet-status, Android activity text);
//   - after `queueHoldAlertMin` (default 5) it is journaled in the musician's
//     log and reported to the chef and the desktop, with the manual actions;
//   - while it lasts, the report is repeated every `queueHoldRepeatMin`
//     (default 30; 0 = never);
//   - when the process ends, a release event is journaled and the queue
//     drains as usual.
// Both thresholds are read from the project, then `defaults`, in config.json.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

export const QUEUE_HOLD_DEFAULTS = { alertMin: 5, repeatMin: 30 };

function minutes(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** {alertMs, repeatMs} for a project. ORCH_QUEUE_HOLD_ALERT_MS /
 *  ORCH_QUEUE_HOLD_REPEAT_MS override both (tests). */
export function queueHoldPolicy(config, project, env = process.env) {
  const p = (config?.projects || []).find(x => x.name === project) || {};
  const d = config?.defaults || {};
  const alertMin = minutes(p.queueHoldAlertMin) ?? minutes(d.queueHoldAlertMin) ?? QUEUE_HOLD_DEFAULTS.alertMin;
  const repeatMin = minutes(p.queueHoldRepeatMin) ?? minutes(d.queueHoldRepeatMin) ?? QUEUE_HOLD_DEFAULTS.repeatMin;
  const envAlert = minutes(env.ORCH_QUEUE_HOLD_ALERT_MS);
  const envRepeat = minutes(env.ORCH_QUEUE_HOLD_REPEAT_MS);
  return {
    alertMs: envAlert ?? alertMin * 60_000,
    repeatMs: envRepeat ?? repeatMin * 60_000,
  };
}

/** Number of entries in the persisted queue of a project (logs/queue/<p>.json,
 *  rewritten by the server on every queue change). */
export function queueLengthOf(project, logsDir) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(logsDir, 'queue', `${project}.json`), 'utf8'));
    return Array.isArray(q) ? q.length : 0;
  } catch { return 0; }
}

/** The hold itself: the turn's process outlives its result AND tasks wait. */
export function queueHoldOf(lingering, queueLength) {
  if (!lingering || !(queueLength > 0)) return null;
  return {
    pid: lingering.pid,
    sinceMs: lingering.sinceMs,
    queueLength,
    background: lingering.background || [],
  };
}

/** Whether to report now. `last` = {pid, at} of the previous report, or null.
 *  Returns 'first' | 'repeat' | null. */
export function holdReportDue(hold, policy, last, now = Date.now()) {
  if (!hold) return null;
  const since = hold.sinceMs ?? 0;
  if (!last || last.pid !== hold.pid) return since >= policy.alertMs ? 'first' : null;
  if (!(policy.repeatMs > 0)) return null;
  return now - last.at >= policy.repeatMs ? 'repeat' : null;
}

function age(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.round(ms / 1000)} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** Short line for tables and cards. */
export function holdLine(hold) {
  if (!hold) return '';
  return `file retenue : ${hold.queueLength} tâche(s) attendent la fin du processus ${hold.pid}` +
    ` (tour terminé depuis ${age(hold.sinceMs)})` +
    (hold.background.length ? ` — ${hold.background.map(b => b.what).join(' · ')}` : '');
}

/** Full report for the chef and the musician's log, with the manual actions. */
export function holdReport(project, hold, kind = 'first') {
  const what = hold.background.length
    ? hold.background.map(b => `« ${b.what} »`).join(', ')
    : 'un travail lancé en arrière-plan par le tour';
  return [
    `⏸ ${kind === 'repeat' ? 'Toujours bloquée' : 'File bloquée'} — ${project} : ${hold.queueLength} tâche(s) en file ne partent pas.`,
    `Le tour de ${project} est terminé depuis ${age(hold.sinceMs)}, mais son processus (PID ${hold.pid}) est encore vivant : il attend ${what}.`,
    `Tant qu'il vit, l'orchestrateur ne lance pas la suite, pour ne pas faire tourner deux tours en même temps. Rien n'est arrêté automatiquement : ce travail peut être légitime.`,
    `Choix possibles :`,
    `1. attendre : la file repartira seule dès que le processus se terminera ;`,
    `2. l'arrêter (le travail en cours est perdu) : node scripts/kill-stalled.mjs ${project} --by utilisateur --reason "file retenue"`,
    `3. retirer des tâches de la file : volet du musicien, « Retirer », ou node scripts/queue.mjs ${project} --remove <id>.`,
  ].join('\n');
}
