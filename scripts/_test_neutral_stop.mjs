#!/usr/bin/env node
// ============================================================================
// scripts/_test_neutral_stop.mjs — arrêts volontaires neutres, rouge réservé
// aux vrais incidents, échecs lisibles, battements, tours d'essai (0.47.2)
// ============================================================================
//
// Demande utilisateur (2026-10-09) : « Si il n'y a pas eu de probleme, ca
// n'aurait pas du etre affiche en rouge: piplineLab ne repond pas ou processus
// perdu ».
//
//   1. TurnCore : « ■ Arrêté par la supervision — motif », etc.
//   2. Instantanés (scanProject) + décisions d'affichage RÉELLES (salle.js,
//      projets.js, pupitre-row.js chargés dans un bac à sable vm) :
//        · arrêt volontaire avec motif → neutre, motif affiché, jamais rouge ;
//        · PID mort sans result → rouge « processus perdu » ;
//        · tour d'essai, même PID mort ou silencieux → « 🧪 », jamais rouge ;
//        · battements frais → pas de stall ; battements arrêtés → stall.
//   3. De bout en bout, VRAI dispatch.mjs (doublure de codex, CODEX_BIN) :
//        · fournisseur lent → événements system/heartbeat dans le log ;
//        · échec réseau NVIDIA 504 → « ✕ échec : NVIDIA 504 après … » ;
//        · --test "<libellé>" → user_prompt.test.
//   4. VRAI kill-stalled.mjs --by supervision --reason → result neutre.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanProject, deriveState } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const section = (n) => console.log(`\n── ${n}`);
const TurnCore = globalThis.TurnCore;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// Modules d'affichage du navigateur, tels quels, dans un bac à sable.
const sandbox = { TurnCore, console, location: { search: '', hash: '' }, performance };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['salle.js', 'projets.js', 'pupitre-row.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), sandbox, { filename: f });
}
const { Salle, Projets, PupitreRow } = sandbox;

// ---------------------------------------------------------------------------
section('1. Libellés d\'arrêt (TurnCore)');
ok(TurnCore.stopText({ by: 'supervision', reason: 'NVIDIA trop lent' }) === '■ Arrêté par la supervision — NVIDIA trop lent', 'supervision + motif');
ok(TurnCore.stopWord({ by: 'chef' }) === 'Arrêté par le chef', 'chef (inchangé)');
ok(TurnCore.stopWord({ by: 'test' }) === 'Arrêté (essai)', 'essai');
ok(TurnCore.stopWord({ by: 'utilisateur' }) === "Arrêté par l'utilisateur", 'utilisateur');
ok(TurnCore.testInfo({ test: { label: 'passerelle' } })?.label === 'passerelle', 'testInfo lit user_prompt.test');

// ---------------------------------------------------------------------------
section('2. Instantanés et affichage');
const L = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-neutral-'));
const write = (name, evs, pid) => {
  fs.writeFileSync(path.join(L, `${name}.jsonl`), evs.map(e => JSON.stringify(e)).join('\n') + '\n');
  if (pid) fs.writeFileSync(path.join(L, `${name}.pid`), String(pid));
};
const deadPid = (() => { const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }); return Number(r.stdout.trim()); })();
const prompt = (msAgo, extra = {}) => ({ type: 'user_prompt', text: 'Fais la tâche', timestamp: iso(msAgo), ...extra });
const init = (msAgo) => ({ type: 'system', subtype: 'init', model: 'm', timestamp: iso(msAgo) });
const m = (name, state, extra = {}) => ({ name, state, ...extra });

// 2a. arrêt volontaire avec motif
write('stop', [prompt(300_000), init(299_000),
  { type: 'result', subtype: 'error_killed_by_conductor', is_error: true, stopped_by: 'supervision', reason: 'NVIDIA trop lent', timestamp: iso(1000) }]);
const rStop = scanProject('stop', L);
ok(rStop.state === 'error' && rStop.stopped?.by === 'supervision' && rStop.stopped.reason === 'NVIDIA trop lent', 'arrêt : état error + stopped {by, reason}');
ok(!rStop.stalled && !rStop.deadInFlight && !Salle.alarming(rStop), 'arrêt : aucune alarme');
const mStop = m('stop', 'error', { stopped: rStop.stopped });
const dStop = Projets.describe(mStop, rStop);
ok(dStop.kind === 'stopped' && dStop.word === 'Arrêté par la supervision', `vue Projets : ${dStop.word}`);
ok(Salle.label(mStop) === 'Arrêté par la supervision', 'rail : libellé neutre');
const pStop = PupitreRow.stateInfo(rStop);
ok(pStop.label === 'ARRÊTÉ' && pStop.cls !== 'st-error', `pupitre : ${pStop.label} (${pStop.cls})`);

// 2b. PID mort sans result → vrai incident, rouge
write('lost', [prompt(120_000), init(119_000)], deadPid);
const rLost = scanProject('lost', L);
ok(rLost.deadInFlight === true, 'PID mort, tour ouvert → deadInFlight');
ok(Salle.alarming(rLost) && Salle.healthFlag(rLost).text === '✗ processus perdu', 'rouge « processus perdu »');
ok(Projets.describe(m('lost', 'live'), rLost).kind === 'dead', 'vue Projets : Processus perdu');
ok(PupitreRow.stateInfo(rLost).label === 'PID MORT', 'pupitre : PID MORT');

// 2c. tour d'essai, PID mort puis silencieux → neutre
write('essai', [prompt(600_000, { test: { label: 'passerelle NVIDIA' } }), init(599_000)], deadPid);
const rTest = scanProject('essai', L);
ok(rTest.testRun?.label === 'passerelle NVIDIA' && rTest.deadInFlight === true, 'essai : testRun + PID mort');
const hTest = Salle.healthFlag(rTest);
ok(hTest?.neutral === true && /🧪/.test(hTest.text) && !Salle.alarming(rTest), `essai interrompu neutre : ${hTest?.text}`);
ok(Projets.describe(m('essai', 'live'), rTest).kind === 'test', 'vue Projets : 🧪 Test en cours');
ok(PupitreRow.stateInfo(rTest).cls !== 'st-stalled', `pupitre : ${PupitreRow.stateInfo(rTest).label}`);
fs.unlinkSync(path.join(L, 'essai.pid'));
const rTest2 = scanProject('essai', L);
ok(rTest2.stalled && !Salle.alarming(rTest2) && Salle.healthFlag(rTest2).neutral, 'essai silencieux : jamais rouge');

// 2d. battements
const hb = (msAgo, waitingMs) => ({ type: 'system', subtype: 'heartbeat', provider: 'nvidia', waitingMs, intervalMs: 30_000, text: `en attente de NVIDIA depuis ${waitingMs / 1000} s`, timestamp: iso(msAgo) });
write('lent', [prompt(400_000), init(399_000), hb(70_000, 300_000), hb(40_000, 330_000), hb(10_000, 360_000)], process.pid);
const rSlow = scanProject('lent', L);
ok(!rSlow.stalled && rSlow.waitingProvider?.provider === 'nvidia', 'battements frais → pas de stall, waitingProvider');
ok(/^⏳ en attente de NVIDIA depuis/.test(rSlow.activity), `activité : ${rSlow.activity}`);
ok(rSlow.silentMs >= 60_000, 'le silence réel dépasse bien le seuil fixe de 60 s');
write('fige', [prompt(900_000), init(899_000), hb(600_000, 30_000)], process.pid);
const rFrozen = scanProject('fige', L);
ok(rFrozen.stalled && !rFrozen.waitingProvider && Salle.alarming(rFrozen), 'battements arrêtés → stall rouge');
write('plafond', [prompt(30 * 60_000), init(30 * 60_000), hb(5_000, 25 * 60_000)], process.pid);
ok(scanProject('plafond', L).stalled, 'attente au-delà du plafond (20 min) → stall');
fs.rmSync(L, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('3. VRAI dispatch.mjs : battements, échec NVIDIA lisible, --test');
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-neutral-root-'));
fs.mkdirSync(path.join(R, 'logs'));
fs.mkdirSync(path.join(R, 'proj'));
fs.writeFileSync(path.join(R, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-opus-5-5', allowedTools: 'Read', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(R, 'proj') }, { name: 'P', path: path.join(R, 'proj') }],
}));
const CODEX = path.join(R, 'codex-slow-504.mjs');
fs.writeFileSync(CODEX, `
process.stdin.resume(); process.stdin.on('data', () => {});
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 't-neutral' });
out({ type: 'turn.started' });
setTimeout(() => {
  out({ type: 'error', message: 'unexpected status 504 Gateway Timeout: NVIDIA : HTTP 504 (après 5 min 00 s)' });
  out({ type: 'turn.failed', error: { message: 'unexpected status 504 Gateway Timeout' } });
  process.exit(1);
}, 1600);
`);
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: R, CODEX_BIN: CODEX, ORCH_HEARTBEAT_MS: '300' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TEST_LABEL']) delete env[k];
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', 'Tâche lente', '--provider', 'nvidia',
  '--model', 'moonshotai/kimi-k3', '--no-queue-if-busy', '--test', 'recette 0.47.2'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let out = '';
child.stdout.on('data', (b) => { out += b; });
child.stderr.on('data', (b) => { out += b; });
const code = await Promise.race([new Promise(r => child.on('close', r)), new Promise(r => setTimeout(() => r('timeout'), 60_000))]);
if (code === 'timeout') child.kill();
ok(code !== 'timeout', `dispatch.mjs terminé (code ${code})`);
const evP = fs.existsSync(path.join(R, 'logs', 'P.jsonl'))
  ? fs.readFileSync(path.join(R, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const up = evP.find(e => e.type === 'user_prompt');
ok(up?.test?.label === 'recette 0.47.2', 'user_prompt.test porte le libellé');
const beats = evP.filter(e => e.type === 'system' && e.subtype === 'heartbeat');
ok(beats.length >= 2 && beats.every(b => b.provider === 'nvidia' && /^en attente de NVIDIA depuis/.test(b.text)), `battements écrits pendant l'attente (${beats.length})`);
const res = evP.filter(e => e.type === 'result');
const last = res[res.length - 1];
ok(last && last.is_error && /✕ échec : NVIDIA 504 après 5 min 00 s/.test(last.result || ''), `échec lisible : ${String(last?.result || out.slice(-300)).slice(0, 160)}`);
ok(!/processus perdu/.test(last?.result || ''), 'jamais « processus perdu »');
const st = deriveState(evP.map(e => JSON.stringify(e)));
ok(st.state === 'error' && !st.stopped, 'état : échec (pas un arrêt)');
ok(!fs.existsSync(path.join(R, 'logs', 'P.pid')), 'pid nettoyé : aucun « PID mort » ensuite');

// ---------------------------------------------------------------------------
section('4. VRAI kill-stalled.mjs --by / --reason');
fs.writeFileSync(path.join(R, 'logs', 'Q.jsonl'), [prompt(5000), init(4000)].map(e => JSON.stringify(e)).join('\n') + '\n');
const k = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'kill-stalled.mjs'), 'Q', '--by', 'supervision', '--reason', 'NVIDIA trop lent'], { env, encoding: 'utf8' });
ok(k.status === 0 && /arrêté par la supervision/.test(k.stdout), `kill-stalled : ${k.stdout.trim()}`);
const rQ = scanProject('Q', path.join(R, 'logs'));
ok(rQ.stopped?.by === 'supervision' && !Salle.alarming(rQ) && TurnCore.stopText(rQ.stopped) === '■ Arrêté par la supervision — NVIDIA trop lent', 'stop neutre avec motif');
ok(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'kill-stalled.mjs'), 'Q', '--by', 'pirate'], { env, encoding: 'utf8' }).status === 64, '--by inconnu refusé (64)');
fs.rmSync(R, { recursive: true, force: true });

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
