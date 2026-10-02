#!/usr/bin/env node
// ============================================================================
// scripts/_test_wake_report_only.mjs — un résultat attendu n'est jamais perdu
// ============================================================================
//
// Régression du 25/09/2026 : TranslateOverlay, dispatché avec --callback chef
// depuis un tour de réveil gen=2, a fini — et le chef n'a jamais été réveillé
// (WAKE_MAX_GEN=2 jetait le résultat en silence). Désormais, au-delà de la
// borne, le réveil a lieu en « rapport seul ».
//
// Comme _test_pool_p0a.mjs, on charge le BLOC RÉEL du réveil (de
// `const WAKE_COALESCE_MS` à `loadWakeFromDisk();`) dans un bac à sable où la
// file (`poolEnqueue`), la limite Claude et le disque sont doublés. On rejoue
// aussi la décision du pump (extraite du même fichier) : rien n'est réécrit.
//
//   node scripts/_test_wake_report_only.mjs
// ============================================================================

import fs from 'node:fs';
import '../public/turn-core.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TC = globalThis.TurnCore;   // règles 0.31.0 passées aux fonctions de server.js évaluées

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const A = SRC.indexOf('const WAKE_COALESCE_MS');
const B = SRC.indexOf('loadWakeFromDisk();', A);
if (A < 0 || B < 0) { console.error('bornes du bloc wake introuvables'); process.exit(2); }
const WAKE_SRC = SRC.slice(A, B);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-ro-'));

function sandbox() {
  const enqueued = [];
  const debug = [];
  const deps = {
    fs, path,
    QUEUE_DIR: TMP, LOGS_DIR: TMP,
    debugLog: (m) => debug.push(m),
    console: { log: () => {}, error: () => {} },
    readLimitedUntil: () => null,
    pool: { queue: [] },
    poolWithdraw: () => null,
    poolEnqueue: (t) => { enqueued.push(t); return t; },
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const api = new Function(...names, `${WAKE_SRC}
    return { wake, scheduleConductorWake, tryFireWake, wakeIsReportOnly, buildWakePrompt, WAKE_MAX_GEN, WAKE_JOURNAL };`)(
    ...names.map(n => deps[n]));
  return { api, enqueued, debug };
}

let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const scenario = (n) => console.log(`\n── ${n}`);

let seq = 0;
/** Un résultat attendu, né d'un tour de chef de génération `gen`, puis tir. */
function fireFor(s, gens) {
  for (const g of gens) {
    s.api.scheduleConductorWake({ key: `k${++seq}`, source: `M${g}`, outcome: 'done', summary: 'ok', wakeGen: g, ts: Date.now() });
  }
  s.api.wake.inFlight = false;
  s.api.wake.lastFireAt = 0;         // on teste la génération, pas le budget
  s.api.wake.fireTimes = [];
  const before = s.enqueued.length;
  s.api.tryFireWake();
  if (s.api.wake.timer) { clearTimeout(s.api.wake.timer); s.api.wake.timer = null; }
  return s.enqueued.length > before ? s.enqueued[s.enqueued.length - 1] : null;
}

// ---------- 1. la chaîne légitime -------------------------------------------

scenario('chaîne légitime : 3 relances automatiques, normales');
{
  const s = sandbox();
  ok(s.api.WAKE_MAX_GEN === 3, 'WAKE_MAX_GEN = 3 (crash → fix → feature → push)');
  for (const g of [0, 1, 2]) {
    const t = fireFor(s, [g]);
    ok(t && t.wakeGen === g + 1 && !t.reportOnly, `résultat né d'un tour gen=${g} ⇒ réveil gen=${g + 1} normal`);
    ok(t && !/rapport-seul/.test(t.text), `  prompt gen=${g + 1} sans mention de rapport seul`);
  }
}

// ---------- 2. la régression : au bout de la chaîne, on réveille ------------

scenario('au-delà de la borne : réveil en RAPPORT SEUL, jamais de perte');
{
  const s = sandbox();
  const t = fireFor(s, [3]);
  ok(t !== null, 'un résultat attendu né d’un tour gen=MAX réveille quand même le chef (plus de drop silencieux)');
  ok(t?.reportOnly === true && t?.wakeGen === 4, 'le ticket est marqué reportOnly, gen=4');
  ok(/mode=rapport-seul/.test(t?.text || '') && /Ne redispatche PAS/.test(t?.text || ''), 'le prompt le dit clairement au chef');
  ok(/M3/.test(t?.text || ''), 'le résultat lui-même est bien dans le prompt');

  const t2 = fireFor(s, [7]);
  ok(t2?.reportOnly === true, 'même très au-delà (gen=7), toujours un réveil en rapport seul');
}

scenario('lot mixte : la génération la plus haute l’emporte');
{
  const s = sandbox();
  const t = fireFor(s, [0, 3]);
  ok(t?.reportOnly === true && /M0/.test(t.text) && /M3/.test(t.text),
     'un seul résultat en bout de chaîne passe tout le lot en rapport seul, sans rien perdre');
}

// ---------- 3. diagnostic en une ligne ---------------------------------------

scenario('journalisation : chef.wake-log.ndjson et server-debug.log');
{
  const s = sandbox();
  try { fs.rmSync(s.api.WAKE_JOURNAL); } catch {}
  fireFor(s, [1]);
  fireFor(s, [3]);
  const lines = fs.readFileSync(s.api.WAKE_JOURNAL, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  ok(lines.length === 2 && lines[0].reportOnly === false && lines[1].reportOnly === true,
     'chaque tir porte reportOnly dans le journal de réveil');
  ok(lines[1].gen === 4 && lines[1].sources.some(x => x.startsWith('M3')), 'gen et sources journalisées');
  ok(s.debug.some(m => /reportOnly/.test(m) && /WAKE_MAX_GEN=3/.test(m)), 'server-debug.log explique la décision');
}

// ---------- 4. la décision du pump ne jette plus rien -----------------------

scenario('pump : plus aucune branche qui jette un résultat attendu');
{
  const pumpSite = SRC.slice(SRC.indexOf("if (expectCallback === conductorName()"), SRC.indexOf('// Drain the per-musician queue'));
  ok(pumpSite.length > 0 && /scheduleConductorWake\(/.test(pumpSite), 'le site du pump appelle scheduleConductorWake');
  ok(!/not waking/.test(pumpSite) && !/gen < WAKE_MAX_GEN/.test(pumpSite), 'l’ancienne branche « not waking (loop guard) » a disparu');
}

// ---------- 5. result fantôme (0.24.1) ---------------------------------------
//
// Séquence RÉELLE de logs/vuBox.jsonl (l. 410578-410600, 25/09) réduite à ses
// champs utiles : vrai result → notification de tâche tuée → NOUVEAU tour
// (user_prompt avec --callback chef) → la notification rejouée → system/init →
// result FANTÔME (0 tour, 0 ms d'API, même coût) → le vrai travail → vrai result.

const { isPhantomResult, isQuestionResolved, deriveState, scanProject } = await import('./fleet-status-core.mjs');
const SID = 'b443cd4d-0000';
const SEQ = [
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Phase précédente terminée.' }] } },
  { type: 'result', subtype: 'success', num_turns: 22, duration_api_ms: 1841972, duration_ms: 180591, stop_reason: 'end_turn', total_cost_usd: 56.62, session_id: SID, result: 'Phase précédente terminée.' },
  { type: 'system', subtype: 'task_notification', status: 'stopped', session_id: SID },
  { type: 'user_prompt', text: 'RENDRE LES GELS/COUPURES DIAGNOSTICABLES', callback: 'chef', timestamp: '2026-09-25T10:49:38.900Z' },
  { type: 'system', subtype: 'task_notification', status: 'stopped', session_id: SID },
  { type: 'system', subtype: 'init', session_id: SID },
  { type: 'result', subtype: 'success', num_turns: 0, duration_api_ms: 0, duration_ms: 27, stop_reason: null, total_cost_usd: 56.62, session_id: SID, result: 'Phase précédente terminée.' },
  { type: 'system', subtype: 'init', session_id: SID },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'adb logcat' } }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Instrumentation livrée.' }] } },
  { type: 'result', subtype: 'success', num_turns: 31, duration_api_ms: 900000, duration_ms: 950000, stop_reason: 'end_turn', total_cost_usd: 70.1, session_id: SID, result: 'Instrumentation livrée.' },
];

scenario('result fantôme : reconnu, et SEULEMENT lui');
{
  ok(isPhantomResult(SEQ[6]) === true, 'le result à 0 tour / 0 ms est un fantôme');
  ok(!isPhantomResult(SEQ[1]) && !isPhantomResult(SEQ[10]), 'les vrais result ne le sont pas');
  ok(!isPhantomResult({ type: 'result', num_turns: 0, duration_api_ms: 0, synthetic: true }), 'un result synthétique (serveur/dispatch) n’en est jamais un');
  ok(!isPhantomResult({ type: 'result', is_error: true }), 'un result sans ces champs reste un vrai (codex, anciens logs)');
}

scenario('reduceMusician réel : le fantôme n’a AUCUN effet, le vrai result réveille');
{
  const start = SRC.indexOf('function reduceMusician(');
  const end = SRC.indexOf('\n}\n', start) + 2;
  const musicianAutoStates = new Map();
  // eslint-disable-next-line no-new-func
  const reduceMusician = new Function('musicianAutoStates', 'isPhantomResult', 'isQuestionResolved', 'NEEDS_CHEF_RE', 'isAcknowledged', 'isConductorStop', 'stopInfo',
    `${SRC.slice(start, end)}\nreturn reduceMusician;`)(musicianAutoStates, isPhantomResult, isQuestionResolved, /NEEDS_CHEF_INPUT:\s*([^\n]+)/i, TC.isAcknowledged, TC.isConductorStop, TC.stopInfo);
  const out = SEQ.map(ev => reduceMusician('vuBox', ev));
  const phantom = out[6];
  ok(phantom.phantom === true, 'le fantôme est signalé au pump');
  ok(phantom.prevState === 'live' && phantom.newState === 'live', 'pas de changement d’état (le musicien reste en cours)');
  ok(phantom.expectCallback === null, 'le pump ne voit aucune attente à honorer sur le fantôme (pas de réveil)');
  const real = out[10];
  ok(real.newState === 'unread' && real.expectCallback === 'chef',
     'le VRAI result porte encore --callback chef : c’est lui qui réveille (avant : consommé par le fantôme)');
  ok(real.lastLine === 'Instrumentation livrée.', 'et avec le texte du tour courant, pas l’ancien');

  const pump = SRC.slice(SRC.indexOf('reduceMusician(name, ev);'), SRC.indexOf('// ---- Callback-wake bookkeeping'));
  ok(/if \(phantom\)[\s\S]*debugLog\(msg\)[\s\S]*continue;/.test(pump),
     'le pump sort AVANT réveil/notification/drain/ticket de chef, et journalise dans server-debug.log');
}

scenario('fleet-status (deriveState partagé) ignore le fantôme');
{
  const lines = SEQ.map(e => JSON.stringify(e));
  ok(deriveState(lines.slice(0, 7)).state === 'live', 'juste après le fantôme : toujours « en cours »');
  ok(deriveState(lines).state === 'unread', 'après le vrai result : terminé');
}

// ---------- 6. question acquittée sans relancer le musicien (0.25.0) ---------
//
// Cas du 27/09 : TranslateOverlay restait « question » alors que l'utilisateur
// avait répondu via le chef (la décision avait même été traitée par un autre
// musicien). L'acquittement est un événement du log du musicien : tous les
// réducteurs le lisent dans l'ordre, et il ne fait passer que `input` → `idle`.

const ASK = [
  { type: 'user_prompt', text: 'Ajoute la langue cible', timestamp: '2026-09-26T09:00:00.000Z' },
  { type: 'system', subtype: 'init', session_id: 's1' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Plusieurs options.\nNEEDS_USER_INPUT: Quelle langue par défaut ?' }] } },
  { type: 'result', subtype: 'success', num_turns: 4, duration_api_ms: 9000, session_id: 's1', result: 'NEEDS_USER_INPUT: Quelle langue par défaut ?' },
];
const RESOLVED = { type: 'notification', subtype: 'question_resolved', question: 'Quelle langue par défaut ?', note: 'répondu via le chef : hébreu', by: 'chef', text: '✓ question marquée répondue (chef) : répondu via le chef : hébreu', timestamp: '2026-09-26T10:00:00.000Z' };
const NEXT = [
  { type: 'user_prompt', text: 'Autre tâche', timestamp: '2026-09-26T11:00:00.000Z' },
  { type: 'system', subtype: 'init', session_id: 's1' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'NEEDS_USER_INPUT: Et le thème ?' }] } },
  { type: 'result', subtype: 'success', num_turns: 2, duration_api_ms: 3000, session_id: 's1', result: 'NEEDS_USER_INPUT: Et le thème ?' },
];

scenario('question acquittée : fleet-status (deriveState + scanProject)');
{
  const L = (evs) => evs.map(e => JSON.stringify(e));
  ok(deriveState(L(ASK)).state === 'input', 'avant : la question est ouverte');
  const d = deriveState(L([...ASK, RESOLVED]));
  ok(d.state === 'idle' && d.resolution?.note === 'répondu via le chef : hébreu', 'après acquittement : « prêt », la note est conservée');
  ok(deriveState(L([...ASK, RESOLVED, ...NEXT])).state === 'input', 'une NOUVELLE question posée ensuite reste bien ouverte');
  ok(deriveState(L([...ASK, NEXT[0], NEXT[1], RESOLVED])).state === 'live',
     'un acquittement arrivé après le début d’un nouveau tour est ignoré (le tour garde la main)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-res-'));
  fs.writeFileSync(path.join(dir, 'TO.jsonl'), L(ASK).join('\n') + '\n');
  ok(scanProject('TO', dir).needsInput === 'Quelle langue par défaut ?', 'scanProject : needsInput tant que la question est ouverte');
  fs.appendFileSync(path.join(dir, 'TO.jsonl'), JSON.stringify(RESOLVED) + '\n');
  const s = scanProject('TO', dir);
  ok(s.state === 'idle' && s.needsInput === null, 'scanProject : plus de « needs: … » après acquittement (fleet-status, /api/pupitre)');
  fs.appendFileSync(path.join(dir, 'TO.jsonl'), L(NEXT.slice(0, 2)).join('\n') + '\n');
  ok(scanProject('TO', dir).needsInput === null, 'ni pendant le tour suivant (avant : l’ancienne question restait affichée)');
  fs.rmSync(dir, { recursive: true, force: true });
}

scenario('question acquittée : reduceMusician réel (pump) et scanProjectState (/api/config)');
{
  const start = SRC.indexOf('function reduceMusician(');
  const end = SRC.indexOf('\n}\n', start) + 2;
  const states = new Map();
  // eslint-disable-next-line no-new-func
  const reduce = new Function('musicianAutoStates', 'isPhantomResult', 'isQuestionResolved', 'NEEDS_CHEF_RE', 'isAcknowledged', 'isConductorStop', 'stopInfo',
    `${SRC.slice(start, end)}\nreturn reduceMusician;`)(states, isPhantomResult, isQuestionResolved, /NEEDS_CHEF_INPUT:\s*([^\n]+)/i, TC.isAcknowledged, TC.isConductorStop, TC.stopInfo);
  ASK.forEach(e => reduce('TO', e));
  const r = reduce('TO', RESOLVED);
  ok(r.resolved === true && r.prevState === 'input' && r.newState === 'idle', 'input → idle, signalé au pump');
  ok(r.expectCallback === null, 'aucune attente à honorer : ni réveil ni notification');
  const pump = SRC.slice(SRC.indexOf('reduceMusician(name, ev);'), SRC.indexOf('// ---- Callback-wake bookkeeping'));
  ok(/if \(resolved\)[\s\S]*debugLog\(msg\)[\s\S]*continue;/.test(pump), 'le pump journalise et s’arrête là (pas de drain, pas de réveil)');

  const s0 = SRC.indexOf('function scanProjectState(');
  const s1 = SRC.indexOf('\n}\n', s0) + 2;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-sps-'));
  fs.writeFileSync(path.join(dir, 'TO.jsonl'), [...ASK, RESOLVED].map(e => JSON.stringify(e)).join('\n') + '\n');
  // eslint-disable-next-line no-new-func
  const sps = new Function('fs', 'path', 'LOGS_DIR', 'SCAN_TAIL_BYTES', 'readMarker', 'isPhantomResult', 'isQuestionResolved', 'isAcknowledged', 'isConductorStop', 'stopInfo',
    `${SRC.slice(s0, s1)}\nreturn scanProjectState;`)(fs, path, dir, 256 * 1024, () => null, isPhantomResult, isQuestionResolved, TC.isAcknowledged, TC.isConductorStop, TC.stopInfo);
  const snap = sps('TO');
  ok(snap.state === 'idle' && snap.questionResolved?.note === 'répondu via le chef : hébreu',
     '/api/config : la carte se recharge « prête », avec la note (survit au redémarrage)');
  fs.rmSync(dir, { recursive: true, force: true });
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
