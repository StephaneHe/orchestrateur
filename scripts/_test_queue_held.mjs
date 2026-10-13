#!/usr/bin/env node
// Queue held by a process that outlived its turn (0.82.0).
// User report (2026-10-13): « A partir du moment où quelque chose tourne,
// attaché à un projet, et que ça empêche le projet d'avancer (en l'occurence
// le musicien est affiché comme Prêt), alors c'est un problème qu'il faut
// corriger. » Reproduces the incident: result written, turn process alive,
// tasks queued ⇒ detected and reported, never killed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueHoldPolicy, queueHoldOf, holdReportDue, holdReport, holdLine, queueLengthOf, QUEUE_HOLD_DEFAULTS } from './queue-hold.mjs';
import { scanProject } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const read = (f) => fs.readFileSync(f, 'utf8');

console.log('── 1. Policy: thresholds from project, then defaults; never zero by accident');
const cfg = { defaults: { queueHoldAlertMin: 7 }, projects: [{ name: 'a', queueHoldAlertMin: 2, queueHoldRepeatMin: 0 }, { name: 'b' }] };
let p = queueHoldPolicy(cfg, 'a', {});
ok(p.alertMs === 120_000 && p.repeatMs === 0, `projet : alerte 2 min, sans rappel (${JSON.stringify(p)})`);
p = queueHoldPolicy(cfg, 'b', {});
ok(p.alertMs === 420_000 && p.repeatMs === QUEUE_HOLD_DEFAULTS.repeatMin * 60_000, 'defaults puis valeur par défaut');
p = queueHoldPolicy({ projects: [] }, 'x', {});
ok(p.alertMs === 5 * 60_000 && p.repeatMs === 30 * 60_000, 'sans réglage : 5 min, rappel 30 min');
ok(queueHoldPolicy(cfg, 'a', { ORCH_QUEUE_HOLD_ALERT_MS: '1500' }).alertMs === 1500, 'surcharge de test par l’environnement');
ok(queueHoldPolicy({ projects: [{ name: 'c', queueHoldAlertMin: 'abc' }] }, 'c', {}).alertMs === 5 * 60_000, 'valeur invalide ignorée');

console.log('\n── 2. Detection and report timing');
const ling = { pid: 4242, sinceMs: 6 * 60_000, background: [{ what: 'non-régression ciblée' }] };
ok(queueHoldOf(ling, 0) === null, 'file vide : rien de retenu');
ok(queueHoldOf(null, 3) === null, 'aucun processus après le result : rien de retenu');
const hold = queueHoldOf(ling, 2);
ok(hold && hold.pid === 4242 && hold.queueLength === 2, 'processus vivant + file : retenue');
const pol = { alertMs: 5 * 60_000, repeatMs: 30 * 60_000 };
ok(holdReportDue({ ...hold, sinceMs: 60_000 }, pol, null) === null, 'avant le délai : pas encore signalé');
ok(holdReportDue(hold, pol, null) === 'first', 'après le délai : signalé');
const t0 = 1_000_000;
ok(holdReportDue(hold, pol, { pid: 4242, at: t0 }, t0 + 60_000) === null, 'déjà signalé : pas de répétition immédiate');
ok(holdReportDue(hold, pol, { pid: 4242, at: t0 }, t0 + 31 * 60_000) === 'repeat', 'toujours retenue après 30 min : rappel');
ok(holdReportDue(hold, { ...pol, repeatMs: 0 }, { pid: 4242, at: t0 }, t0 + 99 * 60_000) === null, 'rappel désactivé (0)');
ok(holdReportDue(hold, pol, { pid: 1, at: t0 }, t0 + 1000) === 'first', 'autre processus : nouveau signalement');
const txt = holdReport('demo', hold);
ok(/File bloquée — demo : 2 tâche\(s\)/.test(txt) && /PID 4242/.test(txt) && /non-régression ciblée/.test(txt), 'le signalement dit quoi, qui, combien');
ok(/Rien n'est arrêté automatiquement/.test(txt) && /attendre/.test(txt) && /kill-stalled\.mjs demo --by utilisateur/.test(txt) && /queue\.mjs demo --remove/.test(txt), 'il propose les actions manuelles, sans rien arrêter');
ok(/Toujours bloquée/.test(holdReport('demo', hold, 'repeat')), 'le rappel le dit');
ok(/file retenue : 2 tâche\(s\).*4242/.test(holdLine(hold)), 'ligne courte pour les tableaux');

console.log('\n── 3. The incident, reproduced: scanProject on a real live process');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-held-'));
const logs = path.join(T, 'logs');
fs.mkdirSync(path.join(logs, 'queue'), { recursive: true });
const keep = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
try {
  const ended = new Date(Date.now() - 10 * 60_000).toISOString();
  const lines = [
    { type: 'user_prompt', text: 'Livrer la 0.77.0', timestamp: new Date(Date.now() - 20 * 60_000).toISOString() },
    { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5' },
    { type: 'system', subtype: 'task_started', task_id: 'bg1', is_backgrounded: true, description: 'non-régression ciblée de la 0.77.0' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Livré.' }] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 9, duration_ms: 1000, timestamp: ended },
  ];
  fs.writeFileSync(path.join(logs, 'demo.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(logs, 'demo.pid'), String(keep.pid));
  let r = scanProject('demo', logs);
  ok(r.lingering && r.queueHeld === null, 'processus vivant, file vide : En cours, rien de retenu');
  fs.writeFileSync(path.join(logs, 'queue', 'demo.json'), JSON.stringify([{ id: 'q1', prompt: 'a' }, { id: 'q2', prompt: 'b' }]));
  ok(queueLengthOf('demo', logs) === 2, 'longueur de la file lue sur le disque');
  r = scanProject('demo', logs);
  ok(r.queueHeld && r.queueHeld.pid === keep.pid && r.queueHeld.queueLength === 2, `file retenue détectée : ${JSON.stringify(r.queueHeld)}`);
  ok(r.queueHeld.sinceMs >= 9 * 60_000 && r.queueHeld.background[0]?.what === 'non-régression ciblée de la 0.77.0', 'depuis quand, et par quoi');
  ok(r.state === 'live' && !r.stalled && !r.deadInFlight && /file retenue : 2 tâche/.test(r.activity), `état et activité : ${r.state} / ${r.activity}`);
  ok(holdReportDue(r.queueHeld, queueHoldPolicy({ projects: [] }, 'demo', {}), null) === 'first', 'au-delà de 5 min : à signaler');
  ok(keep.exitCode === null, 'le processus n’a pas été tué');
  keep.kill();
  for (let i = 0; i < 40 && keep.exitCode === null && keep.signalCode === null; i++) await new Promise(res => setTimeout(res, 50));
  await new Promise(res => setTimeout(res, 200));
  r = scanProject('demo', logs);
  ok(!r.queueHeld && !r.lingering, 'processus terminé : plus rien de retenu');
} finally {
  try { keep.kill(); } catch {}
  fs.rmSync(T, { recursive: true, force: true });
}

console.log('\n── 4. Wiring: server sweep, fleet-status, dashboard — and no automatic kill');
const srv = read(path.join(ROOT, 'server.js'));
const sweep = srv.slice(srv.indexOf('function sweepQueueHolds'), srv.indexOf('setInterval(sweepQueueHolds'));
ok(sweep.length > 200 && /subtype: 'queue_held'/.test(sweep) && /subtype: 'queue_hold_released'/.test(sweep) && /source: 'queue-held'/.test(sweep), 'balayage : événement du musicien, signalement au chef, libération');
ok(!/taskkill|process\.kill|killDispatchTree|kill-stalled\.mjs'/.test(sweep), 'le balayage ne tue jamais rien');
const fsCli = read(path.join(ROOT, 'scripts', 'fleet-status.mjs'));
ok(/r\.queueHeld \? `FILE RETENUE/.test(fsCli) && /onlyHeld/.test(fsCli), 'fleet-status : note FILE RETENUE et --held');
const salle = read(path.join(ROOT, 'public', 'salle.js'));
ok(/rc-chip-held/.test(salle) && /heldBannerHtml/.test(salle), 'dashboard : pastille du cadre et bandeau de la file');

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
