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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const { isPhantomResult, deriveState } = await import('./fleet-status-core.mjs');
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
  const reduceMusician = new Function('musicianAutoStates', 'isPhantomResult', 'NEEDS_CHEF_RE',
    `${SRC.slice(start, end)}\nreturn reduceMusician;`)(musicianAutoStates, isPhantomResult, /NEEDS_CHEF_INPUT:\s*([^\n]+)/i);
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

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
