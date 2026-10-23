#!/usr/bin/env node
// ============================================================================
// scripts/idle-regression.mjs — full non-regression AFTER the fact, during the
// user's idle hours only (0.142.0)
// ============================================================================
//
// User decision (2026-10-23, verbatim): « non. la non régression ne serait plus
// une condition pour la mise en prod. la.mise en prod ne dépend plus que des
// tests unitaires et les non régression ne servent plus qu'à posteriori. Les non
// régressions et corrections ne sont lancées que pendant les heures
// d'inactivité ». Context: « ne faire les tests de non régression qu'en dehors
// des sprints de dev. mesures un laps de temps d'au moins une demi heure avant
// d'autoriser un lancement de non régression ».
//
// With the switch on:
//   - delivery and the production jump depend on the task's tests only (TDD,
//     the tests tied to the changed files, the fast suite): the targeted run
//     never falls back to the full one (regression-targets.mjs, `noFull`), and
//     prod-jump.mjs accepts a green report of any mode on the tag's tree;
//   - the FULL run is launched by THIS program (never by a musician), only when
//     the user has been idle for ≥ idleMin (presence of the dashboard / the app,
//     logs/user-activity.json) AND no musician is in a turn on the project; it
//     is stopped as soon as either changes, and relaunched in a later window;
//   - it covers everything delivered since the last green full run (HEAD of the
//     project's checkout); for the orchestrator it runs in orchestrateur-dev,
//     NEVER in a production checkout (prod-guard.mjs, unchanged rule);
//   - red ⇒ bisect between the last green commit and the red one (only the KO
//     suites when the project declares how), alert to the chef (chef-alerts.mjs
//     kind `posteriori`), then the FIX is dispatched to the project's musician
//     (Incident) in an idle window too — at once only with `fix <p> --now`
//     (the user asked for it).
//
// Switch: model-routing.json → idleRegression {enabled, since, idleMin,
// projects, by}, written by `node scripts/pipeline-enforce.mjs idle-regression
// on|off [<projet>] [--idle-min N]`, re-read at every sweep and every dispatch.
// A pipeline run freezes it in run.json (`idleRegression`) when it starts.
// Off (default) = exactly the behaviour before 0.142.0: nothing read, nothing
// written, nothing launched.
//
// State: logs/idle-regression.json (this module is its only writer), journal
// logs/idle-regression.ndjson, step logs and results under logs/idle-regression/.
//
// A project declares its runs in .orchestrateur/pipeline.json:
//   "idleRegression": { "full": [argv], "bisect": [argv], "inPlace": true }
// with placeholders {ref} {report} {suites}; `inPlace` = run in the checkout
// itself (the command extracts {ref} on its own, e.g. regression.mjs --ref).
// Without it: `testCommand` in a detached git worktree of {ref} (dependency
// folders linked), the same command for the bisect.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-file.mjs';

export const DEFAULT_IDLE_MIN = 30;
export const MAX_IDLE_MIN = 24 * 60;
export const STEP_TIMEOUT_MS = 3 * 3600_000;
export const LAUNCHER = 'idle-regression';
export const USER_DECISION = "non. la non régression ne serait plus une condition pour la mise en prod. la.mise en prod ne dépend plus que des tests unitaires et les non régression ne servent plus qu'à posteriori. Les non régressions et corrections ne sont lancées que pendant les heures d'inactivité";
export const USER_CONTEXT = "ne faire les tests de non régression qu'en dehors des sprints de dev. mesures un laps de temps d'au moins une demi heure avant d'autoriser un lancement de non régression";

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isoNow = (now) => new Date(now).toISOString();
const short = (c) => String(c || '').slice(0, 7);

// ---------------------------------------------------------------------------
// Settings (model-routing.json → idleRegression)
// ---------------------------------------------------------------------------
export function cleanSettings(c) {
  const m = Number(c?.idleMin);
  const projects = Array.isArray(c?.projects) ? [...new Set(c.projects.filter(p => typeof p === 'string' && p))] : null;
  return {
    enabled: c?.enabled === true,
    since: c?.enabled === true && typeof c?.since === 'string' ? c.since : null,
    idleMin: Number.isFinite(m) && m >= 1 && m <= MAX_IDLE_MIN ? Math.round(m) : DEFAULT_IDLE_MIN,
    projects: projects && projects.length ? projects : null,
    by: typeof c?.by === 'string' ? c.by : null,
  };
}

export function readSettings(root) {
  return cleanSettings(readJson(path.join(root, 'model-routing.json'))?.idleRegression);
}

/** Is the policy on for `project` (a list of projects restricts it)? */
export function enabledFor(settings, project) {
  return !!settings?.enabled && (!settings.projects || settings.projects.includes(project));
}

/**
 * on/off from pipeline-enforce.mjs. `project` adds it to (on) or removes it
 * from (off) the list; without a project, on = every project, off = all off.
 */
export function writeSettings(root, { enabled, idleMin = null, project = null, by, now = new Date() }) {
  const file = path.join(root, 'model-routing.json');
  let j = readJson(file);
  if (!j || typeof j !== 'object') j = { version: 2, assignments: {} };
  const before = cleanSettings(j.idleRegression);
  const at = now.toISOString();
  const m = idleMin != null ? Number(idleMin) : before.idleMin;
  if (!Number.isFinite(m) || m < 1 || m > MAX_IDLE_MIN) throw new Error(`--idle-min : un nombre de minutes entre 1 et ${MAX_IDLE_MIN} (reçu ${idleMin})`);
  let projects = before.projects;
  let on = enabled;
  if (project) {
    if (enabled) projects = before.enabled && !before.projects ? null : [...new Set([...(before.enabled ? before.projects || [] : []), project])];
    else {
      if (before.enabled && !before.projects) throw new Error('la règle est active pour tous les projets : « idle-regression off » sans projet pour la couper, puis « on <projet> » pour chacun');
      projects = (before.projects || []).filter(p => p !== project);
      if (!projects.length) on = false;
    }
  } else projects = null;
  j.idleRegression = on
    ? { enabled: true, since: before.enabled && before.since ? before.since : at, idleMin: Math.round(m), ...(projects ? { projects } : {}), by }
    : { enabled: false, idleMin: Math.round(m), by };
  j.history = Array.isArray(j.history) ? j.history : [];
  j.history.push({ at, task: 'idleRegression', from: before.enabled ? 'on' : 'off', to: on ? 'on' : 'off', by });
  if (j.history.length > 500) j.history = j.history.slice(-500);
  writeFileAtomic(file, JSON.stringify(j, null, 2) + '\n', `${file}.${process.pid}.tmp`);
  return readSettings(root);
}

export function describeSettings(s) {
  return s.enabled
    ? `idleRegression = on depuis ${s.since}${s.by ? ` (${s.by})` : ''} — ${s.projects ? `projets : ${s.projects.join(', ')}` : 'tous les projets en service'} — seuil d’inactivité : ${s.idleMin} min — livraison et mise en prod sur les tests de la tâche ; non-régression complète a posteriori, pendant l’inactivité, par le programme`
    : `idleRegression = off (comportement d’avant 0.142.0 : complète avant la mise en prod)${s.by ? ` — ${s.by}` : ''}`;
}

/** The policy a pipeline run keeps from its start (run.json.idleRegression). */
export function runIdleRegression(state, root, names, { resumed = false } = {}) {
  if (typeof state.idleRegression === 'boolean') return state.idleRegression;
  const s = resumed ? null : readSettings(root);
  const v = !!s && [].concat(names).some(n => enabledFor(s, n));
  state.idleRegression = v;
  return v;
}

// ---------------------------------------------------------------------------
// Rules given to the musicians (dispatch.mjs) — the old text when off.
// ---------------------------------------------------------------------------
export function requirementsRuleText(on) {
  const head = `\n\n---\nRÈGLE DES EXIGENCES UTILISATEUR : toute demande de l'utilisateur concernant une fonctionnalité ` +
    `(comportement voulu, réglage, correction signalée) doit être protégée par un TEST AUTOMATISÉ ajouté à la ` +
    `suite de non-régression du projet, rejouée à chaque évolution, et tracée dans docs/USER_REQUIREMENTS.md ` +
    `(date, demande verbatim, test associé). Crée ce fichier et la suite s'ils n'existent pas. `;
  const tail = `Un test d'exigence utilisateur ne ` +
    `peut être ni supprimé ni affaibli sans l'accord explicite de l'utilisateur (demande-le par NEEDS_USER_INPUT).`;
  if (!on) return head + `Avant toute modification, rejoue cette suite ; après, rejoue-la et signale tout échec. ` + tail;
  return head + `Pendant ta tâche, lance SEULEMENT les tests de ta tâche, ceux qui couvrent les fichiers que tu modifies ` +
    `(tests d'exigence compris) et la suite rapide du projet (ex. regression.mjs --targeted, jamais sans --targeted) ; ` +
    `signale tout échec. Ne lance JAMAIS de non-régression complète, ni « avant » ni « après » : la livraison et la ` +
    `mise en prod ne dépendent plus que de ces tests, et l'orchestrateur lance lui-même la complète a posteriori, ` +
    `pendant l'inactivité de l'utilisateur (règle de l'utilisateur du 2026-10-23). ` + tail;
}

// ---------------------------------------------------------------------------
// Project declarations (.orchestrateur/pipeline.json → idleRegression)
// ---------------------------------------------------------------------------
const PLACEHOLDER_ARGV = (a) => Array.isArray(a) && a.length && a.every(x => typeof x === 'string' && x);

/** How the full run / the bisect run of a project are launched, or null. */
export function projectPlan(dir) {
  const cfg = readJson(path.join(dir, '.orchestrateur', 'pipeline.json')) || {};
  const d = cfg.idleRegression && typeof cfg.idleRegression === 'object' ? cfg.idleRegression : null;
  if (d && PLACEHOLDER_ARGV(d.full)) {
    return { full: d.full, bisect: PLACEHOLDER_ARGV(d.bisect) ? d.bisect : null, inPlace: d.inPlace === true, declared: true, timeoutMin: Number(d.timeoutMin) || null };
  }
  const tc = cfg.testCommand;
  const argv = typeof tc === 'string' && tc.trim() ? ['__shell__', tc] : PLACEHOLDER_ARGV(tc) ? tc : null;
  return argv ? { full: argv, bisect: null, inPlace: false, declared: false, timeoutMin: Number(cfg.testTimeoutMin) || null } : null;
}

export function fillArgv(argv, vars) {
  return argv.map(a => a.replace(/\{(ref|report|suites)\}/g, (_, k) => String(vars[k] ?? '')));
}

/**
 * The projects the sweep may test. projects: config.json entries; inService:
 * enforcement.projects. A production checkout is NEVER a target: its dev
 * (`devOf`) is. → [{name, path, plan}]
 */
export function targetsOf({ projects = [], inService = [], conductor = 'chef', settings, isProd = null }) {
  // A production is the project another one declares as its `devOf`, or a
  // checkout whose instance file says « prod ». The runner checks again with
  // prod-guard.mjs (idle-regression-runner.mjs) before running anything.
  const prodNames = new Set(projects.filter(p => p?.devOf).map(p => p.devOf));
  const prodLike = isProd || ((dir) => readJson(path.join(dir, '.orchestrateur-instance.json'))?.role === 'prod');
  const out = [];
  const devs = new Set(projects.filter(p => p?.devOf).map(p => p.name));
  for (const p of projects) {
    if (!p?.name || !p.path || p.name === conductor) continue;
    if (!inService.includes(p.name) && !devs.has(p.name)) continue;
    if (!enabledFor(settings, p.name) && !(p.devOf && enabledFor(settings, p.devOf))) continue;
    if (prodNames.has(p.name) || prodLike(p.path)) continue;
    if (!fs.existsSync(path.join(p.path, '.git'))) continue;
    const plan = projectPlan(p.path);
    if (plan) out.push({ name: p.name, path: p.path, plan });
  }
  return out;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
export const stateFile = (logsDir) => path.join(logsDir, 'idle-regression.json');
export const journalFile = (logsDir) => path.join(logsDir, 'idle-regression.ndjson');
export const stepsDir = (logsDir) => path.join(logsDir, 'idle-regression');

export function readState(logsDir) {
  const j = readJson(stateFile(logsDir)) || {};
  return { projects: j.projects && typeof j.projects === 'object' ? j.projects : {}, active: j.active || null };
}
function saveState(logsDir, st) {
  fs.mkdirSync(logsDir, { recursive: true });
  writeFileAtomic(stateFile(logsDir), JSON.stringify(st, null, 2) + '\n', `${stateFile(logsDir)}.${process.pid}.tmp`);
}
function journal(logsDir, now, ev) {
  try { fs.mkdirSync(logsDir, { recursive: true }); fs.appendFileSync(journalFile(logsDir), JSON.stringify({ ts: isoNow(now), ...ev }) + '\n'); } catch { /* best effort */ }
}
const proj = (st, name) => (st.projects[name] ||= { lastGreen: null, red: null, interrupted: 0 });

// ---------------------------------------------------------------------------
// Bisect (pure): list = commits after the last green one up to the red one,
// oldest first. lo = index of the last known green (-1 = the base), hi = first
// known red. Done when they are adjacent: the culprit is list[hi].
// ---------------------------------------------------------------------------
export function bisectStart(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const b = { list, lo: -1, hi: list.length - 1, steps: [] };
  return bisectNext(b);
}
export function bisectNext(b) {
  if (b.hi - b.lo <= 1) return { ...b, done: true, culprit: b.list[b.hi], next: null };
  return { ...b, done: false, culprit: null, next: b.list[Math.floor((b.lo + b.hi) / 2)] };
}
export function bisectRecord(b, commit, red) {
  const i = b.list.indexOf(commit);
  if (i < 0) return b;
  const n = { ...b, steps: [...b.steps, { commit, red }] };
  if (red) n.hi = i; else n.lo = i;
  return bisectNext(n);
}

/** A step stays red when one of the KOs of the full run is still KO there. */
export function stillRed(fullKo, stepKo, code) {
  if (!Array.isArray(stepKo)) return code !== 0;
  if (!fullKo?.length) return code !== 0;
  return stepKo.some(id => fullKo.includes(id));
}

// ---------------------------------------------------------------------------
// The fix request (Incident) and the chef's alert
// ---------------------------------------------------------------------------
export function fixText(name, red) {
  const c = red.bisect?.culprit;
  return [
    `[NON-RÉGRESSION A POSTERIORI ROUGE] La non-régression complète lancée par l'orchestrateur pendant l'inactivité de l'utilisateur est rouge sur ${name} (commit ${short(red.commit)}).`,
    `KO : ${red.ko?.length ? red.ko.join(' ; ') : '(code de sortie non nul, aucun KO détaillé)'}`,
    c ? `Commit fautif (recherche entre la dernière complète verte ${short(red.good)} et ${short(red.commit)}) : ${short(c)}${red.bisect.subject ? ` « ${red.bisect.subject} »` : ''}.`
      : red.good ? `Commit fautif non isolé entre ${short(red.good)} et ${short(red.commit)}${red.bisect?.why ? ` (${red.bisect.why})` : ''}.` : 'Aucune complète verte connue avant : commit fautif non recherché.',
    red.report ? `Rapport : ${red.report}` : null,
    red.log ? `Sortie : ${red.log}` : null,
    'Corrige la cause (voie Incident) : reproduis avec les tests KO seulement, corrige, relance ces tests et les tests liés aux fichiers modifiés. Ne lance pas de non-régression complète : l’orchestrateur la relancera pendant la prochaine période d’inactivité. Un test d’exigence ne se supprime ni ne s’affaiblit.',
  ].filter(Boolean).join('\n');
}

/** Alerts for chef-alerts.mjs (kind `posteriori`): one per red run, once its culprit search is over. */
export function posterioriAlert(name, r) {
  return { kind: 'posteriori', key: `posteriori:${name}:${r.commit}`, project: name, at: r.at,
    red: { commit: r.commit, good: r.good || null, ko: (r.ko || []).slice(0, 8), culprit: r.bisect?.culprit || null, subject: r.bisect?.subject || null,
      why: r.bisect?.why || null, report: r.report || null, fix: r.fix || null } };
}
export function posterioriAlerts({ logsDir, since }) {
  const st = readState(logsDir);
  const sinceT = Date.parse(since || '') || 0;
  const out = [];
  for (const [name, p] of Object.entries(st.projects)) {
    const r = p.red;
    if (!r || !r.searchDone || r.alerted?.via !== 'chef-alerts' || (Date.parse(r.at || '') || 0) < sinceT) continue;
    out.push(posterioriAlert(name, r));
  }
  return out;
}
/** Culprit search over: chef-alerts carries the alert when on, else the chef is woken directly. */
function raiseRed(deps, name, r, act) {
  let via = 'chef-alerts';
  if (!deps.chefAlertsOn?.()) {
    via = 'direct';
    try { deps.alert?.([posterioriAlert(name, r)]); } catch (e) { via = `échec : ${e.message}`; }
  }
  r.alerted = { at: isoNow(deps.now ?? Date.now()), via };
  act({ event: 'alert', project: name, commit: r.commit, why: via });
}

// ---------------------------------------------------------------------------
// The sweep (all effects injected; the server passes the real ones)
// ---------------------------------------------------------------------------
/**
 * deps:
 *   logsDir, now
 *   settings()              → cleanSettings result (re-read every sweep)
 *   lastActivityAt()        → ms of the user's last sign (gesture or presence), 0 = unknown
 *   bootAt                  → server boot (unknown activity counts from it)
 *   targets(settings)       → targetsOf(...)
 *   busy(name)              → a musician turn in progress on the project
 *   head(dir)               → HEAD commit of the checkout
 *   revList(dir, a, b)      → commits a..b, oldest first
 *   subject(dir, c)         → commit subject
 *   launch(step)            → { pid } — starts the runner (detached)
 *   alive(pid), kill(pid)
 *   dispatchFix(name, text) → launches the fix turn
 *   alert(alerts)           → when chef-alerts is off: wake the chef directly
 *   chefAlertsOn()          → chef-alerts sweeps carry the alert
 *   log(msg)
 * Returns a short verdict for the tests and the debug log.
 */
export function sweep(deps) {
  const { logsDir, now = Date.now(), log = () => {} } = deps;
  const settings = deps.settings();
  let st = readState(logsDir);
  const out = { actions: [] };
  const act = (ev) => { out.actions.push(ev); journal(logsDir, now, ev); log(`[idle-regression] ${ev.event} ${ev.project || ''} ${ev.why || ev.commit || ''}`.trim()); };

  // Switched off: stop what runs, touch nothing else.
  if (!settings.enabled) {
    if (st.active) { stopActive(deps, st, 'règle coupée', act); saveState(logsDir, st); }
    return { ...out, off: true };
  }
  const last = Math.max(Number(deps.lastActivityAt?.()) || 0, Number(deps.bootAt) || 0);
  const idleMs = Math.max(0, now - last);
  const idle = idleMs >= settings.idleMin * 60_000;
  out.idle = idle; out.idleMs = idleMs;

  // 1. The step in progress: finished, dead, or to stop.
  if (st.active) {
    const a = st.active;
    const res = readJson(a.resultFile);
    if (res) { st.active = null; applyResult(deps, st, a, res, act); }
    else if (!deps.alive(a.pid)) {
      st.active = null; proj(st, a.project).interrupted++;
      act({ event: 'interrupted', project: a.project, step: a.kind, commit: a.commit, why: 'processus arrêté sans résultat' });
    } else if (now - Date.parse(a.startedAt) > (a.timeoutMs || STEP_TIMEOUT_MS)) {
      stopActive(deps, st, `délai dépassé (${Math.round((a.timeoutMs || STEP_TIMEOUT_MS) / 60_000)} min)`, act);
    } else if (!idle) {
      stopActive(deps, st, 'activité de l’utilisateur reprise', act);
    } else if (deps.busy(a.project)) {
      stopActive(deps, st, 'un musicien est en cours sur le projet', act);
    } else { saveState(logsDir, st); return { ...out, running: a }; }
  }
  if (!idle) { saveState(logsDir, st); return { ...out, waiting: `utilisateur actif il y a ${Math.round(idleMs / 60_000)} min (seuil ${settings.idleMin} min)` }; }

  // 2. Next work, one step at a time for the whole fleet: fix, bisect, full.
  const targets = deps.targets(settings);
  for (const t of targets) {
    const p = proj(st, t.name);
    if (deps.busy(t.name)) continue;
    const r = p.red;
    if (r && r.searchDone && !r.fix) {
      deps.dispatchFix(t.name, fixText(t.name, r));
      r.fix = { at: isoNow(now), by: 'inactivité' };
      act({ event: 'fix-dispatched', project: t.name, commit: r.commit });
      saveState(logsDir, st); return out;
    }
    if (r && !r.searchDone && r.bisect?.next) {
      startStep(deps, st, t, { kind: 'bisect', commit: r.bisect.next, ko: r.ko }, act);
      saveState(logsDir, st); return out;
    }
  }
  for (const t of targets) {
    const p = proj(st, t.name);
    if (deps.busy(t.name)) continue;
    const head = deps.head(t.path);
    if (!head || head === p.lastGreen?.commit) continue;
    if (p.red && p.red.commit === head) continue; // red already known on this content: wait for a new commit
    startStep(deps, st, t, { kind: 'full', commit: head }, act);
    saveState(logsDir, st); return out;
  }
  saveState(logsDir, st);
  return { ...out, nothing: true };
}

function stopActive(deps, st, why, act) {
  const a = st.active;
  try { deps.kill(a.pid); } catch { /* already gone */ }
  st.active = null;
  proj(st, a.project).interrupted++;
  act({ event: 'stopped', project: a.project, step: a.kind, commit: a.commit, why });
}

function startStep(deps, st, t, { kind, commit, ko = null }, act) {
  const id = `${kind}-${short(commit)}-${Date.now().toString(36)}`;
  const dir = path.join(stepsDir(deps.logsDir), t.name);
  fs.mkdirSync(dir, { recursive: true });
  const suites = (ko || []).filter(x => x.startsWith('suite:')).map(x => x.slice(6));
  const useBisect = kind === 'bisect' && t.plan.bisect && ko?.length && suites.length === ko.length;
  const report = t.plan.inPlace ? `.regress/report-idle-${id}.json` : null;
  const argv = fillArgv(useBisect ? t.plan.bisect : t.plan.full, { ref: commit, report: report || '', suites: suites.join(',') });
  const step = {
    id, project: t.name, path: t.path, kind, commit, argv, inPlace: t.plan.inPlace, report,
    resultFile: path.join(dir, `${id}.result.json`), logFile: path.join(dir, `${id}.log`),
    worktree: t.plan.inPlace ? null : path.join(dir, 'wt'),
    timeoutMs: (t.plan.timeoutMin ? t.plan.timeoutMin * 60_000 * (t.plan.declared ? 1 : 2) : STEP_TIMEOUT_MS),
  };
  fs.writeFileSync(path.join(dir, `${id}.step.json`), JSON.stringify(step, null, 2));
  const { pid } = deps.launch(step);
  st.active = { ...step, pid, startedAt: isoNow(deps.now ?? Date.now()), stepFile: path.join(dir, `${id}.step.json`) };
  act({ event: 'started', project: t.name, step: kind, commit, argv });
}

function applyResult(deps, st, a, res, act) {
  const p = proj(st, a.project);
  const red = res.code !== 0;
  if (a.kind === 'full') {
    if (!red) {
      p.lastGreen = { commit: a.commit, at: res.endedAt || isoNow(deps.now), report: res.report || null };
      if (p.red) act({ event: 'repaired', project: a.project, commit: a.commit, was: p.red.commit });
      p.red = null;
      act({ event: 'green', project: a.project, commit: a.commit });
      return;
    }
    const good = p.lastGreen?.commit || null;
    const r = { commit: a.commit, at: res.endedAt || isoNow(deps.now), ko: res.ko || [], report: res.report || null, log: a.logFile, good, code: res.code };
    if (!good) { r.searchDone = true; r.bisect = { culprit: null, why: 'aucune complète verte connue avant' }; }
    else {
      const list = deps.revList(a.path, good, a.commit);
      const b = bisectStart(list);
      if (!b) { r.searchDone = true; r.bisect = { culprit: null, why: 'aucun commit entre la dernière verte et la rouge' }; }
      else { r.bisect = b; r.searchDone = b.done; if (b.done) r.bisect.subject = deps.subject(a.path, b.culprit); }
    }
    p.red = r;
    act({ event: 'red', project: a.project, commit: a.commit, ko: r.ko.slice(0, 8) });
    if (r.searchDone) { act({ event: 'culprit', project: a.project, commit: r.bisect?.culprit || null, why: r.bisect?.why || null }); raiseRed(deps, a.project, r, act); }
    return;
  }
  // bisect step
  const r = p.red;
  if (!r || !r.bisect?.list) return;
  if (res.code !== 0 && res.code !== 1 && !Array.isArray(res.ko)) {
    r.searchDone = true;
    r.bisect = { ...r.bisect, culprit: null, next: null, why: `essai inexploitable sur ${short(a.commit)} (code ${res.code}) : entre ${short(r.bisect.list[r.bisect.lo + 1])} et ${short(r.bisect.list[r.bisect.hi])}` };
    act({ event: 'culprit', project: a.project, commit: null, why: r.bisect.why });
    raiseRed(deps, a.project, r, act);
    return;
  }
  r.bisect = bisectRecord(r.bisect, a.commit, stillRed(r.ko, res.ko, res.code));
  if (r.bisect.done) {
    r.searchDone = true;
    r.bisect.subject = deps.subject(a.path, r.bisect.culprit);
    act({ event: 'culprit', project: a.project, commit: r.bisect.culprit });
    raiseRed(deps, a.project, r, act);
  }
}

// ---------------------------------------------------------------------------
// Real effects (server side)
// ---------------------------------------------------------------------------
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}
export const gitHead = (dir) => git(dir, ['rev-parse', 'HEAD']).out || null;
export const gitRevList = (dir, a, b) => git(dir, ['rev-list', '--reverse', '--first-parent', `${a}..${b}`]).out.split('\n').filter(Boolean);
export const gitSubject = (dir, c) => git(dir, ['log', '-1', '--format=%s', c]).out.slice(0, 160) || null;

/** Starts the runner (idle-regression-runner.mjs, never imported), detached from the server. */
export function launchRunner(step, { root = OWN_ROOT, env = process.env } = {}) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'idle-regression-runner.mjs'), path.join(path.dirname(step.resultFile), `${step.id}.step.json`)], {
    cwd: root, detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...env, ORCH_REGRESS_LAUNCHER: LAUNCHER, ORCH_TURN_PROJECT: '', ORCH_TURN_STEP: '' },
  });
  child.unref();
  return { pid: child.pid };
}

export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
}

export function statusLines(logsDir, settings) {
  const st = readState(logsDir);
  const L = [describeSettings(settings)];
  if (st.active) L.push(`en cours : ${st.active.kind} de ${st.active.project} sur ${short(st.active.commit)} (processus ${st.active.pid}, depuis ${st.active.startedAt})`);
  for (const [name, p] of Object.entries(st.projects)) {
    L.push(`${name} : dernière complète verte ${p.lastGreen ? `${short(p.lastGreen.commit)} (${p.lastGreen.at})` : 'aucune'}${p.interrupted ? ` · ${p.interrupted} arrêt(s)` : ''}`);
    if (p.red) L.push(`   ROUGE sur ${short(p.red.commit)} — KO : ${(p.red.ko || []).slice(0, 6).join(' ; ') || '?'} — ${p.red.searchDone ? `fautif : ${p.red.bisect?.culprit ? short(p.red.bisect.culprit) : `non isolé (${p.red.bisect?.why || '?'})`}` : 'recherche du commit fautif en cours'} — correction : ${p.red.fix ? `lancée ${p.red.fix.at}` : 'à lancer pendant l’inactivité'}`);
  }
  return L;
}

/** `fix <project> --now`: the user asked for the fix now, whatever the activity. */
export function markFixRequested(logsDir, name, { now = Date.now() } = {}) {
  const st = readState(logsDir);
  const p = st.projects[name];
  if (!p?.red) return { ok: false, why: `aucune non-régression a posteriori rouge pour ${name}` };
  if (p.red.fix) return { ok: false, why: `correction déjà lancée le ${p.red.fix.at}` };
  p.red.fix = { at: isoNow(now), by: 'utilisateur (--now)' };
  saveState(logsDir, st);
  journal(logsDir, now, { event: 'fix-dispatched', project: name, commit: p.red.commit, by: 'utilisateur' });
  return { ok: true, text: fixText(name, p.red), red: p.red };
}

async function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = OWN_ROOT;
  const logsDir = path.join(root, 'logs');
  if (cmd === 'status' || !cmd) { console.log(statusLines(logsDir, readSettings(root)).join('\n')); return; }
  if (cmd === 'fix') {
    const name = rest.find(a => !a.startsWith('--'));
    if (!name || !rest.includes('--now')) { console.error('usage: idle-regression.mjs fix <projet> --now   (correction lancée tout de suite, à la demande de l’utilisateur)'); process.exit(64); }
    const r = markFixRequested(logsDir, name);
    if (!r.ok) { console.error(`[idle-regression] ${r.why}`); process.exit(2); }
    const d = spawnSync(process.execPath, [path.join(root, 'scripts', 'dispatch.mjs'), name, r.text, '--source', LAUNCHER, '--queue-if-busy'], { stdio: 'inherit', windowsHide: true });
    process.exit(d.status ?? 1);
  }
  console.error('usage: node scripts/idle-regression.mjs status | fix <projet> --now');
  process.exit(64);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
