#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_alerts.mjs — the chef's alerts (0.138.0)
// ============================================================================
//
// User request (2026-10-22), verbatim: « la non régression est en erreur. tu
// gères automatiquement ? je ne te vois pas reprendre la main. si ce n'est pas
// le cas, il faut que tu corriges le code et ou ta mémoire pour que tu
// réagisses à ça ».
//
// Protected (user requirement, never weakened without the user's agreement):
//   1. the real full regression r-20261022T163147-19644 (KO on
//      _test_hors_pipeline_task.mjs) is raised, with its KO suite, its launcher
//      and its handling (the relaunch r-20261022T170236-58424 started after);
//      an interrupted run without report and a run in error are raised too;
//      an OK / stale run, or one older than the activation, is not;
//   2. a paused PROCESS pause the chef was not told about is raised; not when
//      it was sent to the chef (chefPause pending), when the chef awaits the
//      run (callback), for a user decision (infra) or the chef's Routage;
//   3. a musician live without progress ≥ stallMin and a musician whose PID is
//      dead while live are raised (real scanProject on real logs); a fresh
//      turn and the chef itself are not;
//   4. ONE wake: the three cases together while the chef has a turn wait, then
//      leave as ONE [ALERTE n=3] ticket; later sweeps, a restart (new sweeper,
//      same logs) and the same events again never wake it a second time; a
//      stall resolved before the chef is free is dropped; at most
//      MAX_FIRES_PER_HOUR wakes per hour;
//   5. switch: off by default and off = nothing read, nothing written, nothing
//      queued; `pipeline-enforce.mjs chef-alerts on` freezes `since`, a second
//      « on » keeps it, `off --all` turns it off; server.js wires the sweep to
//      the direction queue (class decision), waits for the chef's turn.
//
//   node scripts/_test_chef_alerts.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as A from './chef-alerts.mjs';
import { scanProject } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-alerts-'));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// The real records of 2026-10-22 (.regress/history.ndjson of orchestrateur-dev).
const KO_RUN = {"id":"r-20261022T163147-19644","pid":19644,"root":"I:\\Dev\\orchestrateur-dev","label":"worktree","mode":"full","args":"--out .regress/report-0.134.0.json","launcher":{"by":"hors d’un tour (script ou console)"},"startedAt":"2026-10-22T16:31:47.466Z","updatedAt":"2026-10-22T17:00:21.679Z","status":"ko","stage":"navigateur","suites":{"total":150,"done":150,"ok":148,"ko":1,"na":1},"checks":{"expected":168,"done":170,"ok":169,"ko":0,"na":1},"ko":["suite:_test_hors_pipeline_task.mjs"],"report":".regress/report-0.134.0.json","endedAt":"2026-10-22T17:00:25.830Z","counts":{"OK":317,"KO":1,"NA":2},"reportAt":"2026-10-22T17:00:25.827Z","durationS":1718};
const RELAUNCH = {"id":"r-20261022T170236-58424","pid":58424,"root":"I:\\Dev\\orchestrateur-dev","label":"worktree","mode":"full","args":"--out .regress/report-0.134.0.json","launcher":{"by":"hors d’un tour (script ou console)"},"startedAt":"2026-10-22T17:02:36.606Z","updatedAt":"2026-10-22T17:32:08.892Z","status":"ko","stage":"navigateur","suites":{"total":150,"done":150,"ok":148,"ko":1,"na":1},"checks":{"expected":170,"done":170,"ok":169,"ko":0,"na":1},"ko":["suite:_test_phase4b_harness.mjs"],"report":".regress/report-0.134.0.json","endedAt":"2026-10-22T17:32:11.271Z","counts":{"OK":317,"KO":1,"NA":2},"reportAt":"2026-10-22T17:32:11.268Z","durationS":1775};
const SINCE = '2026-10-22T16:00:00.000Z';

// ---------------------------------------------------------------------------
console.log('\n── 1. Non-régression KO, en erreur ou interrompue');
const checkout = path.join(tmp, 'orchestrateur-dev');
fs.mkdirSync(path.join(checkout, '.regress', 'live'), { recursive: true });
const OLD = { ...KO_RUN, id: 'r-20261021T100000-1', startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:30:00.000Z' };
const OK = { ...KO_RUN, id: 'r-20261022T150000-2', status: 'ok', ko: [], startedAt: '2026-10-22T15:00:00.000Z', endedAt: '2026-10-22T16:10:00.000Z' };
const STALE = { ...KO_RUN, id: 'r-20261022T161000-3', status: 'stale', startedAt: '2026-10-22T16:10:00.000Z', endedAt: '2026-10-22T16:20:00.000Z' };
fs.writeFileSync(path.join(checkout, '.regress', 'history.ndjson'), [OLD, OK, STALE, KO_RUN, RELAUNCH].map(r => JSON.stringify(r)).join('\n') + '\n');
// A run killed without report: its live file is left behind, its pid is dead.
const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
const INTERRUPTED = { id: `r-20261022T180000-${deadPid}`, pid: deadPid, root: checkout, label: 'worktree', mode: 'targeted', launcher: { by: 'tour de orchestrateur-dev', project: 'orchestrateur-dev' },
  startedAt: '2026-10-22T18:00:00.000Z', updatedAt: '2026-10-22T18:05:00.000Z', status: 'running', stage: 'suites', suites: { total: 10, done: 4, ok: 4, ko: 0, na: 0 }, checks: {}, ko: [] };
fs.writeFileSync(path.join(checkout, '.regress', 'live', `${INTERRUPTED.id}.json`), JSON.stringify(INTERRUPTED));
const busy = (p) => p === 'orchestrateur-dev' ? { state: 'live', sinceMs: 4 * 60_000 } : null;
const reg = A.regressionAlerts({ dirs: [{ project: 'orchestrateur-dev', dir: checkout, lane: 0 }], since: SINCE, busy });
const ko = reg.find(a => a.run.id === KO_RUN.id);
t('la complète KO r-20261022T163147-19644 est signalée', !!ko && ko.key === `regression:orchestrateur-dev:${KO_RUN.id}`);
t('… avec sa suite KO et son lanceur', ko?.run.ko.includes('suite:_test_hors_pipeline_task.mjs') && /hors d’un tour/.test(ko?.run.launcher || ''));
t('… et sa prise en charge : la relance r-20261022T170236-58424, le tour en cours', ko?.handling.some(h => h.includes(RELAUNCH.id)) && ko?.handling.some(h => /orchestrateur-dev est en tour/.test(h)), JSON.stringify(ko?.handling));
t('la relance KO est signalée elle aussi', reg.some(a => a.run.id === RELAUNCH.id));
t('une exécution interrompue sans bilan est signalée', reg.some(a => a.run.id === INTERRUPTED.id && a.run.status === 'interrupted'));
t('OK, périmée (stale) et antérieure à l’activation : rien', !reg.some(a => [OK.id, STALE.id, OLD.id].includes(a.run.id)), reg.map(a => a.run.id).join(','));
const errRun = A.regressionAlerts({ dirs: [{ project: 'x', dir: checkout }], since: SINCE, read: () => ({ running: [], recent: [{ ...KO_RUN, id: 'r-err', status: 'error', ko: [] }] }) });
t('une exécution arrêtée en erreur est signalée', errRun.length === 1 && /arrêtée en erreur/.test(A.alertLine(errRun[0], 0)));

// User request (2026-10-30), verbatim: « en plus les non régression ne sont appelés qu'après au moins une
// demi heure d'inactivité sur un projet, et uniquement si la version en prod courante n'a pas deja ete soumise
// aux tests de non régression. je ne vois aucun cas où en lancer deux identiques pourraient arriver. verifies ».
// Replay of 2026-10-29 19:27: a pipeline step check KO (testCommand = regression.mjs --targeted) was
// recorded « hors d’un tour » and raised to the chef as « Non-régression terminée KO ».
{
  const { launcherOf } = await import('./regression-live.mjs');
  const { stepLauncherEnv } = await import('./pipeline-engine.mjs');
  // The engine's test environment: ORCH_TURN_* removed (pipeline-engine.mjs), the step launcher added.
  const env = { PATH: process.env.PATH, ...stepLauncherEnv({ projectName: 'orchestrateur-dev', run: 'p-20261029T151016-21b296', stepKey: '07-vert' }) };
  const launcher = launcherOf(env);
  t('vérification d’étape : lanceur réel (exécution et étape), pas « hors d’un tour »', launcher.kind === 'pipeline-step' && launcher.run === 'p-20261029T151016-21b296' && launcher.step === '07-vert' && /p-20261029T151016-21b296 · 07-vert/.test(launcher.by), JSON.stringify(launcher));
  const STEP_KO = {"id":"r-20261029T192757-50660","pid":50660,"root":"I:\\Dev\\orchestrateur-dev","label":"worktree","mode":"targeted","args":"--targeted --no-browser","launcher":launcher,"startedAt":"2026-10-29T19:27:57.267Z","updatedAt":"2026-10-29T19:28:16.765Z","status":"ko","stage":"suites","suites":{"total":6,"done":6,"ok":5,"ko":1,"na":0},"ko":["suite:_test_android_media.mjs"],"report":".regress/report-worktree.json","endedAt":"2026-10-29T19:28:17.762Z"};
  const stepAlerts = A.regressionAlerts({ dirs: [{ project: 'orchestrateur-dev', dir: checkout }], since: '2026-10-29T00:00:00Z', read: () => ({ running: [], recent: [STEP_KO] }) });
  t('… KO : aucune alerte « Non-régression terminée KO » au chef (l’exécution gère son échec)', stepAlerts.length === 0, JSON.stringify(stepAlerts.map(a => a.key)));
  // regression.mjs reads its launcher BEFORE removing the turn markers from its environment.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
  t('… regression.mjs lit le lanceur avant de retirer les marqueurs du tour', src.indexOf('const LAUNCHER_ENV') > -1 && src.indexOf('const LAUNCHER_ENV') < src.indexOf("delete process.env[k]") && /createLiveRun\(\{[^}]*env: LAUNCHER_ENV/.test(src));
}

// ---------------------------------------------------------------------------
console.log('\n── 2. Pause de processus non transmise au chef');
const logs = path.join(tmp, 'logs');
const runsDir = path.join(logs, 'runs');
const mkRun = (run, s) => { fs.mkdirSync(path.join(runsDir, run), { recursive: true }); fs.writeFileSync(path.join(runsDir, run, 'run.json'), JSON.stringify({ run, pipeline: 'dev', ...s })); };
const diag = (kind, limit) => ({ at: iso(60_000), limit, kind, cause: `cause ${kind}`, step: '04a-rouge', options: [{ key: 'découper' }, { key: 'abandonner' }], recommend: { key: 'découper' } });
mkRun('p-20261022T190000-aaaaaa', { project: 'kappa', status: 'paused', pausedLimit: 'items', diagnosis: diag('too_big', 'items') });
mkRun('p-20261022T190000-bbbbbb', { project: 'kappa', status: 'paused', pausedLimit: 'items', diagnosis: diag('too_big', 'items'), chefPause: { status: 'pending', n: 1 } });
mkRun('p-20261022T190000-cccccc', { project: 'kappa', status: 'paused', pausedLimit: 'items', diagnosis: diag('too_big', 'items'), callback: 'chef' });
mkRun('p-20261022T190000-dddddd', { project: 'kappa', status: 'paused', pausedLimit: 'infra', diagnosis: diag('infra', 'infra') });
mkRun('p-20261022T190000-eeeeee', { project: 'chef', pipeline: 'routage', status: 'paused', pausedLimit: 'items', diagnosis: diag('too_big', 'items') });
mkRun('p-20261022T190000-ffffff', { project: 'kappa', status: 'done', pausedLimit: 'items', diagnosis: diag('too_big', 'items') });
const pauses = A.pauseAlerts({ runsDir, since: SINCE, conductor: 'chef' });
t('pause de processus (« items », too_big) non transmise : signalée', pauses.length === 1 && pauses[0].pause.run === 'p-20261022T190000-aaaaaa', pauses.map(p => p.pause.run).join(','));
t('… avec la commande de réponse --pipeline-resume', /--pipeline-resume p-20261022T190000-aaaaaa --source chef/.test(A.alertLine(pauses[0], 0)) && /recommandé « découper »/.test(A.alertLine(pauses[0], 0)));
t('déjà transmise au chef, attendue par le chef, décision utilisateur, Routage du chef, exécution finie : rien', pauses.length === 1);

// ---------------------------------------------------------------------------
console.log('\n── 3. Musicien bloqué, processus perdu (vrai scanProject)');
const line = (ev) => JSON.stringify(ev);
const turnLog = (silentMs) => [
  line({ type: 'user_prompt', text: 'travaille', timestamp: iso(silentMs + 60_000) }),
  line({ type: 'system', subtype: 'init', session_id: 's', timestamp: iso(silentMs + 50_000) }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] }, timestamp: iso(silentMs) }),
].join('\n') + '\n';
fs.writeFileSync(path.join(logs, 'lent.jsonl'), turnLog(15 * 60_000));
fs.writeFileSync(path.join(logs, 'lent.pid'), String(process.pid));
fs.writeFileSync(path.join(logs, 'perdu.jsonl'), turnLog(2 * 60_000));
fs.writeFileSync(path.join(logs, 'perdu.pid'), String(deadPid));
fs.writeFileSync(path.join(logs, 'frais.jsonl'), turnLog(3 * 60_000));
fs.writeFileSync(path.join(logs, 'frais.pid'), String(process.pid));
fs.writeFileSync(path.join(logs, 'chef.jsonl'), turnLog(30 * 60_000));
fs.writeFileSync(path.join(logs, 'chef.pid'), String(deadPid));
const snapshots = ['lent', 'perdu', 'frais', 'chef'].map(name => ({ name, snap: scanProject(name, logs) }));
const stalls = A.stallAlerts({ snapshots, stallMin: 10, excluded: ['chef'] });
t('sans progrès depuis 15 min (seuil 10) : signalé', stalls.some(a => a.project === 'lent' && !a.stall.dead && a.key.startsWith('stall:lent:')), JSON.stringify(stalls.map(a => a.key)));
t('PID mort alors que « en cours » : signalé', stalls.some(a => a.project === 'perdu' && a.stall.dead && a.key.startsWith(`dead:perdu:${deadPid}`)));
t('silence de 3 min sous le seuil, et le chef lui-même : rien', !stalls.some(a => a.project === 'frais' || a.project === 'chef'));
t('ligne lisible : arrêt possible par kill-stalled', /kill-stalled\.mjs" lent --by chef/.test(A.alertLine(stalls.find(a => a.project === 'lent'), 0)));

// ---------------------------------------------------------------------------
console.log('\n── 4. Un seul réveil, regroupé, après le tour du chef');
const root = path.join(tmp, 'root');
fs.mkdirSync(root, { recursive: true });
const alogs = path.join(tmp, 'alogs');
let settings = { enabled: true, since: SINCE, stallMin: 10 };
let chefBusy = true;
let stallNow = true;
const enqueued = [];
const collect = () => [
  ko,
  pauses[0],
  ...(stallNow ? stalls.filter(a => a.project === 'lent') : []),
];
const deps = (over = {}) => ({ root, logsDir: alogs, settings: () => settings, collect, chefBusy: () => chefBusy, enqueue: (x) => { enqueued.push(x); return `m-${enqueued.length}`; }, ...over });
let r = A.sweepAlerts(deps());
t('chef en tour : rien n’est mis en file, les 3 alertes attendent', r.waiting && r.pending === 3 && enqueued.length === 0, JSON.stringify(r));
chefBusy = false;
r = A.sweepAlerts(deps());
t('chef libre : UN réveil, [ALERTE n=3]', r.fired && enqueued.length === 1 && /^\[ALERTE n=3\]/.test(enqueued[0].text), enqueued[0]?.text.slice(0, 80));
t('… qui nomme les 3 événements', enqueued[0].text.includes(KO_RUN.id) && enqueued[0].text.includes('p-20261022T190000-aaaaaa') && /Musicien bloqué — lent/.test(enqueued[0].text));
t('… et demande de vérifier si un musicien traite déjà', /vérifie d’abord si un musicien le traite déjà/.test(enqueued[0].text));
for (let i = 0; i < 3; i++) A.sweepAlerts(deps());
t('balayages suivants : aucun autre réveil', enqueued.length === 1);
A.sweepAlerts(deps({ now: Date.now() + 1000 }));
t('redémarrage (nouveau balayeur, mêmes journaux) : aucun autre réveil', enqueued.length === 1);
const j = fs.readFileSync(A.journalFile(alogs), 'utf8').trim().split('\n').map(l => JSON.parse(l));
t('journal : 3 détections, 1 réveil', j.filter(e => e.event === 'detected').length === 3 && j.filter(e => e.event === 'fired').length === 1);
// A stall that ends before the chef is free is dropped.
const alogs2 = path.join(tmp, 'alogs2');
chefBusy = true; stallNow = true;
const enq2 = [];
const d2 = (over = {}) => deps({ logsDir: alogs2, enqueue: (x) => { enq2.push(x); return 'm'; }, ...over });
A.sweepAlerts(d2());
stallNow = false; chefBusy = false;
A.sweepAlerts(d2());
t('blocage résolu avant que le chef soit libre : retiré du réveil', enq2.length === 1 && /^\[ALERTE n=2\]/.test(enq2[0].text) && !/lent/.test(enq2[0].text), enq2[0]?.text.slice(0, 60));
// Cap: at most MAX_FIRES_PER_HOUR wakes per hour.
const alogs3 = path.join(tmp, 'alogs3');
let k = 0;
const enq3 = [];
const d3 = { root, logsDir: alogs3, settings: () => settings, chefBusy: () => false, enqueue: (x) => { enq3.push(x); return 'm'; },
  collect: () => [{ ...ko, key: `regression:x:${++k}` }] };
for (let i = 0; i < A.MAX_FIRES_PER_HOUR + 3; i++) A.sweepAlerts(d3);
t(`au plus ${A.MAX_FIRES_PER_HOUR} réveils par heure, le reste attend`, enq3.length === A.MAX_FIRES_PER_HOUR);
r = A.sweepAlerts({ ...d3, now: Date.now() + 3601_000 });
t('l’heure suivante : les alertes en attente partent ensemble', r.fired && /^\[ALERTE n=4\]/.test(enq3.at(-1).text), enq3.at(-1).text.slice(0, 20));

// ---------------------------------------------------------------------------
console.log('\n── 5. Interrupteur');
t('absent = coupé (seuil par défaut 10 min)', JSON.stringify(A.readAlertSettings(root)) === JSON.stringify({ enabled: false, since: null, stallMin: 10, by: null }));
const alogs4 = path.join(tmp, 'alogs4');
let collected = 0;
r = A.sweepAlerts({ root, logsDir: alogs4, settings: () => A.readAlertSettings(root), collect: () => { collected++; return [ko]; }, chefBusy: () => false, enqueue: () => { throw new Error('jamais'); } });
t('coupé : rien relevé, rien écrit, rien en file', r.off && collected === 0 && !fs.existsSync(alogs4));
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline-enforce.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: root } });
let o = cli('chef-alerts');
t('pipeline-enforce chef-alerts : état « off »', o.status === 0 && /chefAlerts = off/.test(o.stdout), o.stdout + o.stderr);
o = cli('chef-alerts', 'on', '--stall-min', '15');
const s1 = A.readAlertSettings(root);
t('on : activé, since figé, seuil 15 min', o.status === 0 && s1.enabled && s1.since && s1.stallMin === 15, o.stdout + o.stderr);
o = cli('chef-alerts', 'on');
t('second « on » : since inchangé', A.readAlertSettings(root).since === s1.since);
t('seuil invalide : refusé (64)', cli('chef-alerts', 'on', '--stall-min', '0').status === 64);
o = cli('off', '--all');
t('off --all : coupé', !A.readAlertSettings(root).enabled, o.stdout + o.stderr);
spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']);
cli('chef-alerts', 'on');
t('remis en service : nouveau since (les événements antérieurs ne réveillent pas)', A.readAlertSettings(root).since > s1.since);
const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
t('server.js : balayage périodique branché', /setInterval\(sweepChefAlerts, CHEF_ALERTS_SWEEP_MS\)/.test(srv));
t('server.js : file de direction, classe decision, observée', /class: 'decision', text, displayText, chefAlert: true/.test(srv) && /entry: 'alerte-chef'/.test(srv));
t('server.js : attend le tour du chef (slot occupé, file non vide, journal en cours)', /function chefAlertsBusy\(\) \{\s*if \(pool\.slots\.some\(s => s\.ticket\) \|\| pool\.queue\.length\) return true;/.test(srv));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
