#!/usr/bin/env node
// ============================================================================
// scripts/_test_routage_pending.mjs — Routage tasks never stay stuck (0.58.0)
// ============================================================================
//
// User report (2026-10-09): "A nouveau, orchestrateur est termine, et plus rien
// ne se passe. Il faut corriger la situation". Tasks the chef's Routage had put
// "after orchestrateur" / "after panierIL" never left logs/routage-pending.json:
// the chef was never woken for tasks it launched, an ordinary CLI result had no
// timestamp, a released resume would have started a NEW run, and one paused run
// was waited on twice.
//
// Protected here:
//   1. explicit resume: a waiter resuming a paused run goes out as
//      `--pipeline-resume <run>` (never `--pipeline`), and the paused run is
//      resumed WITHOUT a new run being created (real dispatch.mjs, end to end);
//   2. mechanical release at the end of EVERY turn, ordinary turns included
//      ("after O" released by O's ordinary CLI turn, no chef wake-up involved);
//   3. reliable dependency: log position + awaited task text (an unrelated turn
//      does not count, a phantom never counts), and every result is stamped;
//   4. no duplicate (same project + same resumed run);
//   5. scripts/routage-pending.mjs list / release / drop;
//   + the server side (active after a restart): the chef is woken for tasks it
//     launched, and /api/version says when a restart is required.
//
//   node scripts/_test_routage_pending.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../public/turn-core.js';
import * as RP from './routage-pending.mjs';
import * as E from './pipeline-engine.mjs';
import { isPhantomResult, isQuestionResolved } from './fleet-status-core.mjs';

const TC = globalThis.TurnCore;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = (evs) => evs.map(e => JSON.stringify(e)).join('\n') + '\n';
// The exact shape written by the engine before 0.58.0 (no id, no offset).
const writeLegacy = (dir, tasks) => fs.writeFileSync(path.join(dir, 'routage-pending.json'), JSON.stringify({ tasks }, null, 2));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pending-'));
const LOGS = path.join(T, 'logs');
fs.mkdirSync(path.join(LOGS, 'runs'), { recursive: true });
const pausedRun = (run, project, status = 'paused') => {
  fs.mkdirSync(path.join(LOGS, 'runs', run), { recursive: true });
  fs.writeFileSync(path.join(LOGS, 'runs', run, 'run.json'), JSON.stringify({ run, project, pipeline: 'dev', mode: 'leger', status, pausedLimit: 'criteria', request: 'demande de recette' }));
};

// ---------------------------------------------------------------------------
section('1. Briques : clé de tâche, dédoublonnage, reprise détectée');
{
  ok(RP.taskKey('Corriger   le pipeline\n\n(Rattachée à : la question 3)') === 'corriger le pipeline', 'taskKey : rattachement retiré, espaces normalisés');
  pausedRun('p-20261009T123458-82d93b', 'fr');
  pausedRun('p-20261009T123458-aaaaaa', 'fr', 'done');
  ok(RP.detectReprise(LOGS, { projet: 'fr', demande: 'Reprendre l’exécution en pause `p-20261009T123458-82d93b` avec « continuer »' }) === 'p-20261009T123458-82d93b', 'identifiant d’une exécution EN PAUSE du projet cité dans la demande → reprise');
  ok(RP.detectReprise(LOGS, { projet: 'autre', demande: 'p-20261009T123458-82d93b' }) === null && RP.detectReprise(LOGS, { projet: 'fr', demande: 'p-20261009T123458-aaaaaa' }) === null, 'exécution d’un autre projet, ou plus en pause : pas de reprise');
  const dir = path.join(T, 'dedupe'); fs.mkdirSync(dir);
  const a = { run: 'r1', projet: 'fr', reprise: 'p-20261009T123458-82d93b', demande: 'Reprendre (après le correctif)', after: { projet: 'orch', offset: 0, key: 'x' } };
  const b = { run: 'r2', projet: 'fr', reprise: 'p-20261009T123458-82d93b', demande: 'Autre formulation de la même reprise', after: { projet: 'pan', offset: 0, key: 'y' } };
  let r = RP.addPending(dir, [a]);
  ok(r.added.length === 1 && r.added[0].id && r.added[0].createdAt, 'ajout : identifiant et date posés');
  r = RP.addPending(dir, [b, { ...b, run: 'r3' }]);
  ok(r.added.length === 0 && r.duplicates.length === 2 && RP.readPending(dir).length === 1, 'même projet + même exécution reprise : doublon refusé (une seule attente)');
  r = RP.addPending(dir, [{ run: 'r4', projet: 'fr', demande: 'Ajoute un bouton', after: a.after }, { run: 'r5', projet: 'fr', demande: 'ajoute   un bouton', after: a.after }]);
  ok(r.added.length === 1 && r.duplicates.length === 1, 'même projet + même demande : doublon refusé');
}

// ---------------------------------------------------------------------------
section('2. Dépendance fiable : position dans le log + texte de la tâche attendue');
{
  const log = path.join(LOGS, 'orch.jsonl');
  fs.writeFileSync(log, J([
    { type: 'user_prompt', text: 'Ancienne tâche', timestamp: '2026-10-09T10:00:00Z' },
    { type: 'result', subtype: 'success', num_turns: 5, duration_api_ms: 900, result: 'fini avant' },
  ]));
  const off = RP.logOffset(LOGS, 'orch');
  const key = RP.taskKey('Corriger le pipeline dev pour DEJA_COUVERT');
  const after = { projet: 'orch', offset: off, key };
  ok(RP.dependencyResult(LOGS, after) === null, 'un result écrit AVANT la position ne compte pas');
  fs.appendFileSync(log, J([
    { type: 'user_prompt', text: 'Tour sans rapport, déjà en cours', source: 'chef', callback: 'chef' },
    { type: 'result', subtype: 'success', num_turns: 3, duration_api_ms: 500, result: 'autre chose' },
  ]));
  ok(RP.dependencyResult(LOGS, after) === null, 'le result d’un autre tour (la tâche attendue était en file) ne compte pas');
  fs.appendFileSync(log, J([
    { type: 'user_prompt', text: 'Corriger le pipeline dev pour DEJA_COUVERT\n\n(Rattachée à : x)', source: 'chef', callback: 'chef' },
    { type: 'system', subtype: 'init' },
    { type: 'user_prompt', text: '[notify] message glissé dans le log', source: 'notify' },
    { type: 'result', subtype: 'success', num_turns: 0, duration_api_ms: 0, result: 'fantôme' },
  ]));
  ok(RP.dependencyResult(LOGS, after) === null, 'un result fantôme ne compte jamais (et un message notify ne désarme pas)');
  fs.appendFileSync(log, J([{ type: 'result', subtype: 'success', num_turns: 209, duration_api_ms: 8000, result: 'Livré : 0.57.2' }]));
  const res = RP.dependencyResult(LOGS, after);
  ok(res?.result === 'Livré : 0.57.2' && !res.timestamp, 'tour ORDINAIRE sans horodatage (CLI) : la dépendance est satisfaite');
  const legacy = { projet: 'orch', since: '2026-10-09T18:31:45.779Z' };
  ok(RP.dependencyResult(LOGS, legacy) === null, 'ancienne entrée (heure seule) : un result non horodaté ne compte pas (c’était le blocage)');
  fs.appendFileSync(log, J([{ type: 'result', subtype: 'success', num_turns: 2, duration_api_ms: 10, result: 'horodaté', timestamp: '2026-10-09T19:00:00Z' }]));
  ok(RP.dependencyResult(LOGS, legacy)?.result === 'horodaté', 'ancienne entrée : un result horodaté postérieur la satisfait toujours');
}

// ---------------------------------------------------------------------------
section('3. Lancement : reprise explicite (--pipeline-resume), libération une seule fois');
const REC = path.join(T, 'recorder.mjs');
const RECF = path.join(T, 'launches.ndjson');
fs.writeFileSync(REC, "import fs from 'node:fs';\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{fs.appendFileSync(process.env.REC_FILE, JSON.stringify({argv:process.argv.slice(2),stdin:s})+'\\n');});\n");
process.env.REC_FILE = RECF;
const launches = async (n) => { for (let i = 0; i < 40; i++) { try { const l = fs.readFileSync(RECF, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); if (l.length >= n) return l; } catch {} await sleep(100); } try { return fs.readFileSync(RECF, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch { return []; } };
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', projects: [{ name: 'chef', path: T }, { name: 'fr', path: T }, { name: 'orch', path: T }, { name: 'pan', path: T }] }));
{
  RP.launchTask(T, { projet: 'fr', pipeline: 'dev', mode: 'leger', served: true, reprise: 'p-20261009T123458-82d93b', demande: 'Reprendre', rattache: 'pause fr' }, REC);
  RP.launchTask(T, { projet: 'pan', pipeline: 'dev', mode: 'complet', served: true, demande: 'Nouvelle fonctionnalité' }, REC);
  const l = await launches(2);
  const res = l.find(x => x.argv.includes('fr')), dev = l.find(x => x.argv.includes('pan'));
  ok(res && res.argv.includes('--pipeline-resume') && res.argv[res.argv.indexOf('--pipeline-resume') + 1] === 'p-20261009T123458-82d93b' && !res.argv.includes('--pipeline'),
    `reprise : --pipeline-resume <exécution>, jamais --pipeline (${res?.argv.slice(1).join(' ')})`);
  ok(res.argv.includes('--callback') && res.argv.includes('--source') && /Rattachée à : pause fr/.test(res.stdin), 'retour au chef et demande rattachée conservés');
  ok(dev && dev.argv.includes('--pipeline') && dev.argv.includes('complet') && !dev.argv.includes('--pipeline-resume'), 'tâche nouvelle : --pipeline dev --mode (inchangé)');

  fs.rmSync(RECF, { force: true });
  const dir = LOGS;
  fs.rmSync(path.join(dir, RP.PENDING_FILE), { force: true });
  const okAfter = { projet: 'orch', offset: 0, key: RP.taskKey('Corriger le pipeline dev pour DEJA_COUVERT') };
  RP.addPending(dir, [
    { run: 'rA', projet: 'fr', pipeline: 'dev', served: true, reprise: 'p-20261009T123458-82d93b', demande: 'Reprendre fr', after: okAfter },
    { run: 'rA', projet: 'pan', pipeline: 'dev', served: true, demande: 'Tâche pan en attente', after: { projet: 'personne', offset: 0, key: 'rien' } },
  ]);
  let r = RP.releaseReady({ root: T, logsDir: dir, dispatchScript: REC });
  ok(r.launched.length === 1 && r.launched[0].projet === 'fr' && r.launched[0].reprise === 'p-20261009T123458-82d93b', 'tâche prête lancée (reprise), l’autre attend toujours');
  ok(RP.readPending(dir).length === 1 && RP.readPending(dir)[0].projet === 'pan', 'fichier réécrit : seule la tâche non prête reste');
  r = RP.releaseReady({ root: T, logsDir: dir, dispatchScript: REC });
  ok(r.launched.length === 0, 'second passage (fin d’un autre tour) : rien relancé deux fois');
  await launches(1);
  ok((await launches(1)).length === 1, 'un seul lancement réel');

  // Failed awaited task: kept and reported, never launched.
  fs.appendFileSync(path.join(dir, 'echec.jsonl'), J([{ type: 'user_prompt', text: 'Tâche qui échoue', source: 'chef', callback: 'chef' }, { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 2, duration_api_ms: 5 }]));
  RP.addPending(dir, [{ run: 'rB', projet: 'fr', demande: 'Après l’échec', after: { projet: 'echec', offset: 0, key: RP.taskKey('Tâche qui échoue') } }]);
  r = RP.releaseReady({ root: T, logsDir: dir, dispatchScript: REC });
  ok(r.launched.length === 0 && r.blocked.length === 1 && RP.readPending(dir).some(t => t.projet === 'fr' && t.blocked), 'tâche attendue en échec : gardée, signalée « bloquée », non lancée');
  // Entry written before 0.58.0 (no `reprise`, heure seule), citing a paused
  // run: released as a RESUME, never as a new run (incident of 2026-10-09,
  // 19:39 — such an entry started a duplicate run before this guard).
  RP.dropPending(dir, { all: true });
  fs.appendFileSync(path.join(dir, 'pan.jsonl'), J([{ type: 'result', subtype: 'success', num_turns: 4, duration_api_ms: 9, result: 'Incident réparé', timestamp: '2026-10-09T16:05:43.592Z' }]));
  pausedRun('p-20261009T123458-2a1135', 'pan');
  writeLegacy(dir, [{ run: 'p-20261009T155055-b3e351', projet: 'pan', pipeline: 'dev', mode: 'complet', served: true,
    demande: 'Reprendre l’exécution de pipeline en pause p-20261009T123458-2a1135 avec la réponse « continuer »', after: { projet: 'pan', since: '2026-10-09T15:52:09.148Z' }, createdAt: '2026-10-09T15:52:09.148Z' }]);
  fs.rmSync(RECF, { force: true });
  r = RP.releaseReady({ root: T, logsDir: dir, dispatchScript: REC });
  const leg = (await launches(1))[0];
  ok(r.launched.length === 1 && r.launched[0].reprise === 'p-20261009T123458-2a1135' && leg?.argv.includes('--pipeline-resume') && !leg.argv.includes('--pipeline'),
    `ancienne entrée sans « reprise » citant une exécution en pause : lancée en --pipeline-resume, jamais en nouvelle exécution (${leg?.argv.slice(1).join(' ')})`);
  // Resume of a run no longer paused: removed, nothing launched (no double run).
  RP.dropPending(dir, { all: true });
  RP.addPending(dir, [{ run: 'rC', projet: 'fr', reprise: 'p-20261009T123458-aaaaaa', demande: 'Reprendre une exécution déjà finie', after: okAfter }]);
  fs.rmSync(RECF, { force: true });
  r = RP.releaseReady({ root: T, logsDir: dir, dispatchScript: REC });
  ok(r.launched.length === 1 && /plus en pause/.test(r.launched[0].skipped || '') && !RP.readPending(dir).length, 'reprise d’une exécution qui n’est plus en pause : rien lancé, entrée retirée');
  await sleep(500);
  ok(!fs.existsSync(RECF), 'aucun processus lancé');
}

// ---------------------------------------------------------------------------
section('4. Routage : « reprise » validée, détectée, dédoublonnée ; contexte avec les exécutions en pause');
{
  ok(E.validateTasks(T, [{ projet: 'fr', pipeline: 'dev', demande: 'Reprendre l’exécution', reprise: 'p-20261009T123458-82d93b' }]) === null, 'reprise d’une exécution en pause du projet : acceptée');
  ok(/n'est pas une exécution en pause/.test(E.validateTasks(T, [{ projet: 'fr', pipeline: 'dev', demande: 'Reprendre l’exécution', reprise: 'p-20261009T123458-aaaaaa' }]) || ''), 'exécution finie : refusée');
  ok(/identifiant d'exécution/.test(E.validateTasks(T, [{ projet: 'fr', pipeline: 'dev', demande: 'Reprendre l’exécution', reprise: 'continuer' }]) || ''), 'identifiant invalide : refusé');
  const ctx = E.routingContext(T, { logsDir: LOGS, chefLog: path.join(LOGS, 'chef.jsonl'), chefDir: T });
  ok(/Exécutions de pipeline en pause/.test(ctx) && /fr : p-20261009T123458-82d93b/.test(ctx) && !/p-20261009T123458-aaaaaa/.test(ctx), 'contexte.md : exécutions en pause listées avec leur identifiant (pas celles finies)');
  const cat = (await import('./pipeline-catalog.mjs')).catalogSteps?.('routage', { mode: 'demande' }) || null;
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'pipeline-catalog.mjs'), 'utf8');
  ok(/« reprise »: "<identifiant de l’exécution>"/.test(src) && /"reprise": "p-AAAAMMJJTHHMMSS-xxxxxx/.test(src), 'consigne de Décomposer : champ « reprise » expliqué et dans le format');
  void cat;
}

// ---------------------------------------------------------------------------
section('5. CLI scripts/routage-pending.mjs : list, release, drop');
{
  // Guard: whatever the CLI might launch runs the fake claude, never a real one
  // (a failing check once let `release` start a real session on a fixture).
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'routage-pending.mjs'), ...a],
    { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, ORCH_PERM_DISABLE: '1', ORCH_NO_PENDING_RELEASE: '1' }, encoding: 'utf8' });
  RP.dropPending(LOGS, { all: true });
  RP.addPending(LOGS, [
    { run: 'p-20261009T155055-b3e351', projet: 'pan', demande: 'Reprendre pan (après pan)', after: { projet: 'cli-attente', since: '2026-10-09T15:52:09.148Z' } },
    { run: 'p-20261009T183025-9087e2', projet: 'fr', demande: 'Reprendre fr (après orch)', after: { projet: 'personne', offset: 0, key: 'rien' } },
    { run: 'p-20261009T183025-9087e2', projet: 'pan', demande: 'Reprendre pan (après orch)', after: { projet: 'personne', offset: 0, key: 'rien' } },
  ]);
  let r = cli('list');
  const ids = RP.readPending(LOGS).map(RP.idOf);
  ok(r.status === 0 && ids.every(id => r.stdout.includes(id)) && /attend personne/.test(r.stdout), 'list : identifiants et état lisibles');
  ok(JSON.parse(cli('list', '--json').stdout).length === 3, 'list --json');
  r = cli('release');
  ok(r.status === 0 && /rien à relancer/.test(r.stdout) && RP.readPending(LOGS).length === 3, 'release : rien de prêt → rien lancé');
  r = cli('drop', '--run', 'p-20261009T183025-9087e2', '--projet', 'fr');
  ok(r.status === 0 && RP.readPending(LOGS).length === 2 && !RP.readPending(LOGS).some(t => t.projet === 'fr'), 'drop --run <routage> --projet <p> : une seule entrée retirée');
  r = cli('drop', ids[0]);
  ok(r.status === 0 && RP.readPending(LOGS).length === 1, 'drop <id>');
  ok(cli('drop', 'deadbeef').status === 2, 'drop d’un identifiant inconnu : code 2');
  ok(cli('release', '--force').status === 64 && cli('nimporte').status === 64, 'usage invalide : code 64');
  RP.dropPending(LOGS, { all: true });
}

// ---------------------------------------------------------------------------
section('6. Serveur (actif après redémarrage) : réveil du chef pour ses tâches, « redémarrage requis »');
{
  const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = SRC.indexOf('function reduceMusician(');
  const end = SRC.indexOf('\n}\n', start) + 2;
  const mk = () => new Function('musicianAutoStates', 'isPhantomResult', 'isQuestionResolved', 'NEEDS_CHEF_RE', 'isAcknowledged', 'isConductorStop', 'stopInfo',
    `${SRC.slice(start, end)}\nreturn reduceMusician;`)(new Map(), isPhantomResult, isQuestionResolved, /NEEDS_CHEF_INPUT:\s*([^\n]+)/i, TC.isAcknowledged, TC.isConductorStop, TC.stopInfo);
  let red = mk(), out;
  for (const e of [{ type: 'user_prompt', text: 'tâche du Routage', source: 'chef', callback: 'chef' }, { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'fait' }] } }, { type: 'result', subtype: 'success', num_turns: 3, duration_api_ms: 50, result: 'fait' }]) out = red('orch', e);
  ok(out.newState === 'unread' && out.prevState === 'live' && out.expectCallback === 'chef', 'tour ordinaire lancé par le Routage (--source chef --callback chef) : le result réveille le chef');
  red = mk();
  for (const e of [{ type: 'user_prompt', text: 'reprise', source: 'chef', callback: 'chef', pipeline: { run: 'p-1' } }, { type: 'system', subtype: 'pipeline_start' },
    { type: 'result', subtype: 'success', result: 'terminé', timestamp: 'x' }]) out = red('fr', e);
  ok(out.expectCallback === 'chef' && out.prevState === 'live', 'exécution de pipeline lancée par le Routage : idem');
  red = mk();
  for (const e of [{ type: 'user_prompt', text: 'go', callback: 'chef' }, { type: 'system', subtype: 'init' }, { type: 'user_prompt', text: '[x] note', source: 'notify' },
    { type: 'result', subtype: 'success', num_turns: 2, duration_api_ms: 5, result: 'ok' }]) out = red('p', e);
  ok(out.expectCallback === 'chef', 'un message notify (sourcé, sans callback) n’efface pas l’attente');
  const pumpAt = SRC.indexOf('reduceMusician(name, ev);');
  const pump = SRC.slice(pumpAt, SRC.indexOf('scheduleConductorWake({', pumpAt) + 30);
  ok(/expectCallback === conductorName\(\)[\s\S]*scheduleConductorWake\(\{/.test(pump), 'le pump réveille le chef sur cette attente (règle inchangée)');

  const a = SRC.indexOf('function repoVersion()'), b = SRC.indexOf("app.get('/api/version'");
  const fnSrc = SRC.slice(a, b);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ver-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.58.0' }));
  const info = (served) => new Function('fs', 'path', '__dirname', 'PKG_VERSION', `${fnSrc}\nreturn restartInfo();`)(fs, path, dir, served);
  ok(JSON.stringify(info('0.55.0')) === JSON.stringify({ version: '0.55.0', repoVersion: '0.58.0', restartRequired: true }), '/api/version : dépôt plus récent que le serveur → restartRequired');
  ok(info('0.58.0').restartRequired === false, 'même version : pas de redémarrage requis');
  ok(/routagePending: routagePendingView\(\)/.test(SRC) && /\.\.\.restartInfo\(\)/.test(SRC), '/api/pupitre expose restartRequired et les tâches en attente');
  ok(/setInterval\(sweepRoutagePending, 60_000\)/.test(SRC) && /staleEntries\(/.test(SRC), 'balayage de secours toutes les 60 s, avec signalement des attentes trop longues');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok(/redémarrage requis/.test(app) && /restartRequired/.test(app), 'pied de page : « ⚠ redémarrage requis »');
}

// ---------------------------------------------------------------------------
section('7. De bout en bout (vrai dispatch.mjs) : « après O » libéré par le tour ORDINAIRE de O, reprise sans nouvelle exécution');
{
  const notices = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { notices.push(req.url); res.end('{}'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pending-e2e-'));
  const P = path.join(R, 'proj'), O = path.join(R, 'orch');
  for (const d of [path.join(R, 'logs'), P, O, path.join(R, 'chef')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(R, 'config.json'), JSON.stringify({
    conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
    projects: [{ name: 'chef', path: path.join(R, 'chef') }, { name: 'P', path: P }, { name: 'O', path: O }],
  }));
  fs.writeFileSync(path.join(R, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {
    'dev.rouge': { provider: 'anthropic', model: 'claude-opus-5-5' }, 'dev.vert': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'dev.revue': { provider: 'anthropic', model: 'claude-fable-5-1' }, 'dev.livrer': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  }, history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] } }));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
  fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: R, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
    ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200' };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
    'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_COVERED', 'FAKE_PIPE_NOCLAIM', 'FAKE_PIPE_PROOF', 'FAKE_PIPE_NOTEST', 'REC_FILE', 'ORCH_NO_PENDING_RELEASE']) delete env[k];
  const dispatch = (args, extra = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...env, ...extra }, windowsHide: true });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => c.kill(), 240_000);
    c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
  });
  const L2 = path.join(R, 'logs');
  const logOf = (p) => { try { return fs.readFileSync(path.join(L2, `${p}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const runsOf = (p) => fs.readdirSync(path.join(L2, 'runs')).filter(d => JSON.parse(fs.readFileSync(path.join(L2, 'runs', d, 'run.json'), 'utf8')).project === p);

  // A paused run on P (the frenchradio case: honest green test, no claim).
  let r = await dispatch(['P', 'Passe la version à 1.5.4 (déjà fait)', '--mode', 'leger'], { FAKE_PIPE_COVERED: '0', FAKE_PIPE_NOCLAIM: '1' });
  const run = runsOf('P')[0];
  ok(r.code === 2 && run && JSON.parse(fs.readFileSync(path.join(L2, 'runs', run, 'run.json'), 'utf8')).status === 'paused', `exécution de P en pause (${run})`, r.out.slice(-600));

  // The Routage decided: "fix O, then resume P" — twice (the duplicate case).
  const O_TASK = 'Corriger le pipeline dev pour le cas déjà couvert';
  const after = { projet: 'O', offset: RP.logOffset(L2, 'O'), key: RP.taskKey(O_TASK) };
  const add = RP.addPending(L2, [
    { run: 'p-20261009T183025-9087e2', projet: 'P', pipeline: 'dev', mode: 'leger', served: true, demande: `Reprendre l’exécution en pause ${run} avec « continuer »`, reprise: RP.detectReprise(L2, { projet: 'P', demande: run }), after },
    { run: 'p-20261009T155055-b3e351', projet: 'P', pipeline: 'dev', mode: 'complet', served: true, demande: `Reprendre ${run} après la réparation`, reprise: run, after: { projet: 'P', offset: RP.logOffset(L2, 'P'), key: 'reparation' } },
  ]);
  ok(add.added.length === 1 && add.duplicates.length === 1, 'deux décisions pour la même exécution en pause : une seule attente');

  // O's ordinary turn (O is NOT in service), launched by the chef's Routage.
  r = await dispatch(['O', O_TASK, '--source', 'chef', '--callback', 'chef'], { FAKE_PIPE_COVERED: '0' });
  const oRes = logOf('O').filter(e => e.type === 'result').pop();
  ok(r.code === 0 && oRes && !oRes.pipeline && typeof oRes.timestamp === 'string', `tour ordinaire de O terminé, son result est horodaté (${oRes?.timestamp})`, r.out.slice(-600));
  ok(/tâche en attente relancée : P — reprise/.test(r.out), 'à la fin du tour de O, la reprise de P part toute seule (sans réveil du chef)');

  let st = null;
  for (let i = 0; i < 360; i++) { st = JSON.parse(fs.readFileSync(path.join(L2, 'runs', run, 'run.json'), 'utf8')); if (st.status !== 'paused' && st.status !== 'running') break; await sleep(500); }
  ok(st.status === 'done', `l’exécution en pause est REPRISE et terminée (état ${st.status})`);
  ok(runsOf('P').length === 1, `aucune nouvelle exécution créée (${runsOf('P').join(', ')})`);
  const up = logOf('P').filter(e => e.type === 'user_prompt' && e.pipeline).pop();
  ok(up?.pipeline?.run === run && up.pipeline.resumed === true, 'côté P : user_prompt de reprise de la MÊME exécution');
  ok(RP.readPending(L2).length === 0, 'plus rien en attente');
  srv.close();
  try { fs.rmSync(R, { recursive: true, force: true }); } catch {}
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
