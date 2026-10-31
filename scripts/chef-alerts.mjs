// ============================================================================
// scripts/chef-alerts.mjs — the chef's alerts (0.138.0)
// ============================================================================
//
// User request (2026-10-22): « la non régression est en erreur. tu gères
// automatiquement ? je ne te vois pas reprendre la main ». Nothing woke the
// chef on a red regression, a process pause routed to the user, or a stuck
// musician. One mechanism for the three:
//
//   1. a regression run ended KO / in error, or interrupted without a report;
//   2. a pipeline PROCESS pause the chef was not told about (lever chefPauses
//      off for that run, run not awaited by the chef — those already wake it);
//   3. a musician live/think without progress for ≥ stallMin, or whose PID is
//      dead while its log still says « live ».
//
// The server sweeps (ORCH_CHEF_ALERTS_SWEEP_MS, 30 s), each event gets a stable
// key and is raised ONCE (logs/chef-alerts.json, survives restarts). Alerts
// pending while the chef has a turn wait for its end, and everything pending
// leaves as ONE `[ALERTE n=…]` ticket of the chef's direction queue. A stall or
// a pause that resolved itself before the chef is free is dropped (journaled).
// At most MAX_FIRES_PER_HOUR alert turns per hour: no loop.
//
// Switch: model-routing.json → chefAlerts {enabled, since, stallMin, by},
// written by `node scripts/pipeline-enforce.mjs chef-alerts on|off
// [--stall-min N]`, re-read at every sweep (no restart). `since` is frozen when
// the switch is turned on: an event older than that is never raised. Off by
// default; off = exactly the previous behaviour (the sweep reads nothing,
// writes nothing).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { heldKey } from './queue-requeue.mjs';
import { writeFileAtomic } from './atomic-file.mjs';
import { readRuns } from './regression-live.mjs';
import { pauseFamily } from './process-pause.mjs';
import { describeFailures, failureLines } from './test-failures.mjs';

export const DEFAULT_STALL_MIN = 10;
export const MAX_FIRES_PER_HOUR = 6;
// 0.142.0: `posteriori` = a full run after the fact (idle-regression.mjs) found red, culprit searched.
// 0.144.0: `queue` = a queued task kept at the head of its queue for a durable cause (queue-requeue.mjs).
export const KINDS = Object.freeze(['regression', 'pause', 'stall', 'posteriori', 'queue']);
// Runs of the idle-time program: its bisect steps are red by design, its full
// runs are raised as `posteriori` once the culprit is known.
const IDLE_LAUNCHER = 'idle-regression';
const SEEN_KEEP_MS = 30 * 24 * 3600_000;
const REGRESSION_BAD = new Set(['ko', 'error', 'interrupted']);

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const one = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const ts = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };

export function fmtMin(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export function cleanSettings(c) {
  const stall = Number(c?.stallMin);
  return {
    enabled: c?.enabled === true,
    since: c?.enabled === true && typeof c?.since === 'string' ? c.since : null,
    stallMin: Number.isFinite(stall) && stall >= 1 && stall <= 240 ? Math.round(stall) : DEFAULT_STALL_MIN,
    by: typeof c?.by === 'string' ? c.by : null,
  };
}

export function readAlertSettings(root) {
  return cleanSettings(readJson(path.join(root, 'model-routing.json'))?.chefAlerts);
}

/** on/off from pipeline-enforce.mjs. Turning on freezes `since` = now. */
export function writeAlertSettings(root, { enabled, stallMin = null, by, now = new Date() }) {
  const file = path.join(root, 'model-routing.json');
  let j = readJson(file);
  if (!j || typeof j !== 'object') j = { version: 2, assignments: {} };
  const before = cleanSettings(j.chefAlerts);
  const at = now.toISOString();
  const stall = stallMin != null ? Number(stallMin) : before.stallMin;
  if (!Number.isFinite(stall) || stall < 1 || stall > 240) throw new Error(`--stall-min : un nombre de minutes entre 1 et 240 (reçu ${stallMin})`);
  j.chefAlerts = enabled
    ? { enabled: true, since: before.enabled && before.since ? before.since : at, stallMin: Math.round(stall), by }
    : { enabled: false, stallMin: Math.round(stall), by };
  j.history = Array.isArray(j.history) ? j.history : [];
  j.history.push({ at, task: 'chefAlerts', from: before.enabled ? 'on' : 'off', to: enabled ? 'on' : 'off', by });
  if (j.history.length > 500) j.history = j.history.slice(-500);
  writeFileAtomic(file, JSON.stringify(j, null, 2) + '\n', `${file}.${process.pid}.tmp`);
  return readAlertSettings(root);
}

export function describeSettings(s) {
  return s.enabled
    ? `chefAlerts = on depuis ${s.since}${s.by ? ` (${s.by})` : ''} — seuil « bloqué » : ${s.stallMin} min — non-régression KO/interrompue, pause de processus, musicien bloqué ou processus perdu, tâche de file retenue pour une cause durable`
    : `chefAlerts = off (aucune alerte : comportement d’avant 0.138.0)${s.by ? ` — ${s.by}` : ''}`;
}

// ---------------------------------------------------------------------------
// Detection (pure on its inputs; the server passes what it already knows)
// ---------------------------------------------------------------------------

/**
 * Regression runs ended KO / in error / interrupted after `since`.
 * dirs: [{project, dir, lane}] — the checkouts the server shows regressions of.
 * busy(project) → {state, sinceMs}|null : the project's turn in progress, if any.
 */
export function regressionAlerts({ dirs, since, busy = () => null, now = Date.now(), read = readRuns }) {
  const out = [];
  const sinceT = ts(since);
  for (const { project, dir, lane = 0 } of dirs || []) {
    let v;
    try { v = read(dir, { now, keep: 20 }); } catch { continue; }
    const all = [...(v.running || []), ...(v.recent || [])];
    for (const r of v.recent || []) {
      if (!REGRESSION_BAD.has(r.status)) continue;
      if (r.launcher?.by === IDLE_LAUNCHER) continue;
      // A pipeline step check: its run handles the failure (pause, retry), never a chef alert.
      if (r.launcher?.kind === 'pipeline-step') continue;
      const end = ts(r.endedAt || r.updatedAt || r.startedAt);
      if (!end || end < sinceT) continue;
      const after = all.filter(x => x.id !== r.id && ts(x.startedAt) > ts(r.startedAt))
        .sort((a, b) => ts(a.startedAt) - ts(b.startedAt));
      out.push({
        kind: 'regression', key: `regression:${project}:${r.id}`, project, at: new Date(end).toISOString(),
        run: { id: r.id, status: r.status, mode: r.mode || null, label: r.label || null, lane, why: r.why || null,
          ko: (r.ko || []).slice(0, 8), report: r.report || null, launcher: r.launcher?.by || null, launcherProject: r.launcher?.project || null,
          startedAt: r.startedAt || null, endedAt: r.endedAt || null, counts: r.counts || null },
        handling: regressionHandling({ project, launcherProject: r.launcher?.project || null, after, busy }),
      });
    }
  }
  return out;
}

function regressionHandling({ project, launcherProject, after, busy }) {
  const h = [];
  for (const x of after.slice(0, 3)) h.push(`relance ${x.id} démarrée après (${x.status === 'running' ? 'en cours' : x.status})`);
  for (const p of [...new Set([launcherProject, project].filter(Boolean))]) {
    const b = busy(p);
    if (b) h.push(`${p} est en tour (${b.state})${Number.isFinite(b.sinceMs) ? ` depuis ${fmtMin(b.sinceMs)}` : ''}`);
  }
  return h;
}

/**
 * Paused PROCESS pauses the chef has not been told about, raised after `since`.
 * Skipped: pause already sent to the chef (chefPause pending), handed back to
 * the user by the chef, run awaited by the chef (its callback wakes it), the
 * chef's own Routage, a user decision (pauseFamily).
 */
export function pauseAlerts({ runsDir, since, conductor, now = Date.now() }) {
  const out = [];
  const sinceT = ts(since);
  let names = [];
  try { names = fs.readdirSync(runsDir); } catch { return out; }
  for (const n of names) {
    const f = path.join(runsDir, n, 'run.json');
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < sinceT) continue;
    const s = readJson(f);
    if (!s || s.status !== 'paused' || !s.project || s.project === conductor) continue;
    const d = s.diagnosis || {};
    const at = ts(d.at) || st.mtimeMs;
    if (at < sinceT) continue;
    if (s.chefPause?.status === 'pending' || s.chefPause?.status === 'to-user') continue;
    if (conductor && s.callback === conductor) continue;
    const limit = s.pausedLimit || d.limit || null;
    const fam = pauseFamily({ limit, kind: d.kind, pipeline: s.pipeline, lane: s.lane?.k || 0 });
    if (fam.family !== 'process') continue;
    out.push({
      kind: 'pause', key: `pause:${s.run || n}:${d.at || st.mtimeMs}`, project: s.project, at: new Date(at).toISOString(),
      pause: { run: s.run || n, pipeline: s.pipeline || null, limit, kind: d.kind || null, cause: one(d.cause, 400), step: d.step || null,
        options: (d.options || []).map(o => o?.key).filter(Boolean).slice(0, 8), recommend: d.recommend?.key || null, waitingMs: now - at },
    });
  }
  return out;
}

/**
 * Stuck musicians. snapshots: [{name, snap}] where snap is scanProject().
 * excluded: the chef and its slots (an alert to the chef about itself helps nobody).
 */
export function stallAlerts({ snapshots, stallMin = DEFAULT_STALL_MIN, excluded = [] }) {
  const out = [];
  const stallMs = stallMin * 60_000;
  for (const { name, snap } of snapshots || []) {
    if (!snap || excluded.includes(name)) continue;
    const inFlight = snap.logState ? (snap.logState === 'live' || snap.logState === 'think') : (snap.state === 'live' || snap.state === 'think');
    if (!inFlight) continue;
    const turn = snap.lastTurnStartAt || 'tour';
    const base = { project: name, at: new Date().toISOString(),
      stall: { pid: snap.pid ?? null, silentMs: snap.silentMs ?? null, turnElapsedMs: snap.turnElapsedMs ?? null, activity: one(snap.activity, 200), state: snap.state } };
    if (snap.deadInFlight) {
      out.push({ kind: 'stall', key: `dead:${name}:${snap.pid}:${turn}`, ...base, stall: { ...base.stall, dead: true } });
    } else if (snap.stalled && Number(snap.silentMs) >= stallMs) {
      out.push({ kind: 'stall', key: `stall:${name}:${turn}`, ...base, stall: { ...base.stall, dead: false } });
    }
  }
  return out;
}

/**
 * Queued tasks kept back for a DURABLE cause (0.144.0): the launch refused them
 * (tree dirty with no paused run to explain it), they stay in the queue — never
 * lost — and the chef is told once per task and cause.
 * queues: [{project, entries}] — the server's in-memory queues.
 */
export function queueAlerts({ queues, since, now = Date.now() }) {
  const out = [];
  const sinceT = ts(since);
  for (const { project, entries } of queues || []) {
    (entries || []).forEach((e, i) => {
      const h = e?.heldBy;
      if (!h?.durable) return;
      const at = ts(h.at);
      if (!at || at < sinceT) return;
      out.push({ kind: 'queue', key: heldKey(project, e), project, at: new Date(at).toISOString(),
        queue: { id: e.id || null, position: i + 1, taskId: e.taskId || null, head: one(e.prompt, 160), heldKind: h.kind, why: one(h.why, 400),
          enqueuedAt: e.enqueuedAt || null, waitingMs: now - at } });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The wake prompt
// ---------------------------------------------------------------------------
export function alertLine(a, i, { root = '.' } = {}) {
  const n = `${i + 1}.`;
  const S = (p) => path.join(root, 'scripts', p).replace(/\\/g, '/');
  if (a.kind === 'regression') {
    const r = a.run;
    const what = r.status === 'interrupted' ? `interrompue sans bilan${r.why ? ` (${r.why})` : ''}` : r.status === 'error' ? 'arrêtée en erreur' : 'terminée KO';
    return [
      `${n} ✕ Non-régression ${what} — ${a.project}${r.lane ? ` (couloir ${r.lane})` : ''} · ${r.id} · mode ${r.mode || '?'}${r.endedAt ? ` · fin ${r.endedAt}` : ''}`,
      `   KO : ${r.ko.length ? r.ko.join(' ; ') : '(aucun KO enregistré)'}`,
      `   Lancée par : ${r.launcher || 'inconnu'}${r.report ? ` · rapport ${r.report}` : ''}`,
      `   Prise en charge : ${a.handling?.length ? a.handling.join(' ; ') : 'aucune relance ni tour en cours vu par le serveur'}`,
    ].join('\n');
  }
  if (a.kind === 'posteriori') {
    const r = a.red;
    // 0.145.0: the failed tests (or why the command could not run), never just « KO : testCommand ».
    const what = describeFailures(r.failures);
    return [
      r.cleanCopy
        ? `${n} ✕ Commande de test rouge en COPIE PROPRE — ${a.project} · commit ${String(r.commit).slice(0, 7)} (testCommand modifiée, validée par le programme pendant l’inactivité)`
        : `${n} ✕ Non-régression complète A POSTERIORI rouge — ${a.project} · commit ${String(r.commit).slice(0, 7)} (lancée par le programme pendant l’inactivité)`,
      what ? `   Échec : ${what}${r.report ? ` · rapport ${r.report}` : ''}` : `   KO : ${r.ko.length ? r.ko.join(' ; ') : '(aucun KO détaillé)'}${r.report ? ` · rapport ${r.report}` : ''}`,
      ...failureLines(r.failures, { max: 6, indent: '     ' }),
      ...(r.ignored?.length ? [`   Ignoré(s) par git, absent(s) d’une copie propre : ${r.ignored.map(i => i.file).join(', ')}`] : []),
      r.cleanCopy ? `   Commande : ${Array.isArray(r.testCommand) ? r.testCommand.join(' ') : r.testCommand || '?'} — un fichier nécessaire n’est sans doute pas versionné` : `   Commit fautif : ${r.culprit ? `${String(r.culprit).slice(0, 7)}${r.subject ? ` « ${r.subject} »` : ''}` : `non isolé${r.why ? ` (${r.why})` : ''}`} — entre la dernière complète verte ${r.good ? String(r.good).slice(0, 7) : '(aucune)'} et ${String(r.commit).slice(0, 7)}`,
      `   Correction : ${r.fix ? `lancée ${r.fix.at}` : 'lancée par le programme vers le musicien (voie Incident) à la prochaine période d’inactivité ; tout de suite seulement si l’utilisateur le demande'} : node "${S('idle-regression.mjs')}" fix ${a.project} --now`,
    ].join('\n');
  }
  if (a.kind === 'pause') {
    const p = a.pause;
    return [
      `${n} ⏸ Pause de processus — ${a.project} · ${p.run} (${p.pipeline || '?'}, « ${p.limit || '?'} »${p.step ? `, étape ${p.step}` : ''}) · en attente depuis ${fmtMin(p.waitingMs)}`,
      `   Cause : ${p.cause || '(non établie)'}`,
      `   Choix : ${p.options.map(k => `« ${k} »`).join(', ') || '(aucun)'}${p.recommend ? ` — recommandé « ${p.recommend} »` : ''}`,
      `   La question est posée à l’utilisateur. Pour la trancher : node "${S('dispatch.mjs')}" ${a.project} "<choix> ${p.run}" --pipeline-resume ${p.run} --source chef`,
    ].join('\n');
  }
  if (a.kind === 'queue') {
    const q = a.queue;
    return [
      `${n} ⏸ Tâche de file retenue — ${a.project} · ${q.id || '?'}${q.taskId ? ` (${q.taskId})` : ''} · position ${q.position} · « ${q.head} »`,
      `   Cause durable : ${q.why || '(non précisée)'}`,
      `   Elle reste dans la file (rien n’est perdu) et repartira d’elle-même quand la cause aura disparu. Voir : node "${S('queue.mjs')}" ; ranger la copie du projet (commit) ou retirer la tâche si elle n’a plus lieu d’être.`,
    ].join('\n');
  }
  const s = a.stall;
  return [
    s.dead
      ? `${n} ⚠ Processus perdu — ${a.project} · le processus ${s.pid} est mort alors que le journal dit encore « en cours »`
      : `${n} ⚠ Musicien bloqué — ${a.project} · aucun progrès depuis ${fmtMin(s.silentMs)}${Number.isFinite(s.turnElapsedMs) ? ` (tour de ${fmtMin(s.turnElapsedMs)})` : ''} · processus ${s.pid ?? '?'}`,
    `   Dernière activité : ${s.activity || '—'}`,
    `   État : node "${S('fleet-status.mjs')}" ; arrêt si nécessaire : node "${S('kill-stalled.mjs')}" ${a.project} --by chef --reason "<raison>"`,
  ].join('\n');
}

export function buildAlertPrompt(alerts, { root = '.' } = {}) {
  return [
    `[ALERTE n=${alerts.length}]`,
    `Le serveur signale ${alerts.length === 1 ? 'un événement qui peut demander' : `${alerts.length} événements qui peuvent demander`} ton intervention (chaque événement n’est signalé qu’une fois).`,
    'Pour chacun : vérifie d’abord si un musicien le traite déjà (tour en cours, relance, file d’attente). Si oui, ne fais rien de plus que le noter. Sinon, agis (relance, dispatch, arrêt) ou informe l’utilisateur. Jamais de relance à l’aveugle ; une décision de l’utilisateur reste à l’utilisateur.',
    '',
    ...alerts.map((a, i) => alertLine(a, i, { root })),
  ].join('\n');
}

export function alertSummary(alerts) {
  const c = { regression: 0, pause: 0, stall: 0, posteriori: 0, queue: 0 };
  for (const a of alerts) c[a.kind]++;
  return [c.regression && `${c.regression} non-régression(s)`, c.posteriori && `${c.posteriori} complète(s) a posteriori rouge(s)`, c.pause && `${c.pause} pause(s)`, c.stall && `${c.stall} musicien(s) bloqué(s)`, c.queue && `${c.queue} tâche(s) de file retenue(s)`]
    .filter(Boolean).join(', ') + ` : ${[...new Set(alerts.map(a => a.project))].join(', ')}`;
}

// ---------------------------------------------------------------------------
// The sweeper: once per event, grouped, never during a chef turn, capped.
// ---------------------------------------------------------------------------
export const stateFile = (logsDir) => path.join(logsDir, 'chef-alerts.json');
export const journalFile = (logsDir) => path.join(logsDir, 'chef-alerts.ndjson');

export function readAlertState(logsDir) {
  const j = readJson(stateFile(logsDir)) || {};
  return {
    seen: j.seen && typeof j.seen === 'object' ? j.seen : {},
    pending: Array.isArray(j.pending) ? j.pending : [],
    fires: Array.isArray(j.fires) ? j.fires.filter(Number.isFinite) : [],
  };
}

/**
 * One sweep. deps:
 *   root, logsDir
 *   settings()           → cleanSettings result (re-read every time)
 *   collect(settings)    → alerts currently true (all three kinds)
 *   chefBusy()           → true while the chef has a turn or an alert ticket queued
 *   enqueue({text, displayText, alerts}) → ticket id (the direction queue)
 *   log(msg)
 * Returns { off } | { fired, ticket, alerts } | { waiting, reason } | { idle }.
 */
export function sweepAlerts(deps) {
  const { logsDir, now = Date.now(), log = () => {} } = deps;
  const settings = deps.settings();
  if (!settings.enabled) return { off: true };
  const st = readAlertState(logsDir);
  const journal = (ev) => { try { fs.mkdirSync(logsDir, { recursive: true }); fs.appendFileSync(journalFile(logsDir), JSON.stringify({ ts: new Date(now).toISOString(), ...ev }) + '\n'); } catch { /* best effort */ } };
  let current = [];
  try { current = deps.collect(settings) || []; } catch (e) { log(`[chef-alerts] relevé : ${e.message}`); }
  const byKey = new Map(current.map(a => [a.key, a]));
  let changed = false;
  for (const a of current) {
    if (st.seen[a.key]) continue;
    st.seen[a.key] = now;
    st.pending.push(a);
    changed = true;
    journal({ event: 'detected', key: a.key, kind: a.kind, project: a.project });
    log(`[chef-alerts] détectée : ${a.key}`);
  }
  // A stall or a pause gone by itself before the chef is free is no longer news.
  const keep = [];
  for (const a of st.pending) {
    if (a.kind === 'regression' || a.kind === 'posteriori') { keep.push(byKey.get(a.key) || a); continue; }
    if (byKey.has(a.key)) { keep.push(byKey.get(a.key)); continue; }
    changed = true;
    journal({ event: 'resolved', key: a.key, kind: a.kind, project: a.project });
    log(`[chef-alerts] résolue avant le réveil : ${a.key}`);
  }
  st.pending = keep;
  for (const [k, t] of Object.entries(st.seen)) if (now - t > SEEN_KEEP_MS) { delete st.seen[k]; changed = true; }
  const save = () => { try { fs.mkdirSync(logsDir, { recursive: true }); writeFileAtomic(stateFile(logsDir), JSON.stringify(st, null, 2)); } catch (e) { log(`[chef-alerts] écriture : ${e.message}`); } };

  if (!st.pending.length) { if (changed) save(); return { idle: true }; }
  let busy = false;
  try { busy = !!deps.chefBusy(); } catch { busy = true; }
  if (busy) { if (changed) save(); return { waiting: true, reason: 'tour du chef en cours', pending: st.pending.length }; }
  st.fires = st.fires.filter(t => now - t < 3600_000);
  if (st.fires.length >= MAX_FIRES_PER_HOUR) { if (changed) save(); return { waiting: true, reason: `plafond de ${MAX_FIRES_PER_HOUR} réveils par heure`, pending: st.pending.length }; }

  const alerts = st.pending;
  const text = buildAlertPrompt(alerts, { root: deps.root });
  const displayText = `alerte : ${alertSummary(alerts)}`;
  let ticket = null;
  try { ticket = deps.enqueue({ text, displayText, alerts }); } catch (e) { log(`[chef-alerts] mise en file : ${e.message}`); save(); return { waiting: true, reason: 'mise en file impossible' }; }
  st.pending = [];
  st.fires.push(now);
  save();
  journal({ event: 'fired', ticket, keys: alerts.map(a => a.key), settings: { stallMin: settings.stallMin, since: settings.since } });
  log(`[chef-alerts] réveil du chef — ${alerts.length} alerte(s) : ${alerts.map(a => a.key).join(', ')}`);
  return { fired: true, ticket, alerts, text };
}
