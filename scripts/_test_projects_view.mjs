#!/usr/bin/env node
// ============================================================================
// scripts/_test_projects_view.mjs — vue « Projets » (0.29.0)
// ============================================================================
//
// 1. Cœur partagé (fleet-status-core.scanProject) sur des logs JETABLES :
//    lastTurn (fantôme ignoré, coût rapporté tel quel, fin approximée par le
//    mtime), mission (1er user_prompt SANS source), callbackTo (seulement en
//    vol), lastActivityAt, et la correction de tailLines (un log qui tient dans
//    la fenêtre garde sa 1re ligne ; une fenêtre qui commence en cours de
//    fichier jette toujours sa ligne partielle).
// 2. Le VRAI classement de public/projets.js (chargé dans une VM avec le vrai
//    public/salle.js) : groupe et sorte pour chaque cas de la flotte.
// 3. server.js : la route /api/pupitre scanne les parqués (plus d'« idle »
//    forcé), expose ui/version/build, et relit `ui` à chaud.
//
// Aucun port ouvert, aucun fichier du projet écrit.
//   node scripts/_test_projects_view.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { scanProject } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  [ok]   ${l}`); } else { fail++; console.log(`  [FAIL] ${l}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pv-'));
const iso = (ago) => new Date(Date.now() - ago).toISOString();
const write = (name, evs) => fs.writeFileSync(path.join(tmp, `${name}.jsonl`), evs.map(e => JSON.stringify(e)).join('\n') + '\n');

console.log('\n── 1. scanProject : champs additifs');
write('done', [
  { type: 'user_prompt', text: 'Publier la 1.2.3\nsecond paragraphe', timestamp: iso(60_000), callback: 'chef' },
  { type: 'system', subtype: 'init', timestamp: iso(59_000) },
  { type: 'result', subtype: 'success', num_turns: 4, duration_api_ms: 8000, duration_ms: 33_000, total_cost_usd: 2.4 },
  { type: 'user_prompt', text: '[omega] Terminé.', source: 'omega', timestamp: iso(1000) },
]);
let s = scanProject('done', tmp);
ok(s.mission === 'Publier la 1.2.3', `mission = 1re ligne du dernier prompt sans source (${s.mission})`);
ok(s.lastTurn?.costUsd === 2.4 && s.lastTurn.durationMs === 33_000 && !s.lastTurn.isError, 'lastTurn : coût rapporté et durée');
ok(s.callbackTo === null, 'callbackTo nul hors tour');
ok(s.lastActivityAt > Date.now() - 5000 && s.lastActivitySource === 'event', 'lastActivityAt = dernier événement horodaté');

write('phantom', [
  { type: 'user_prompt', text: 'Tâche', timestamp: iso(30_000), callback: 'chef' },
  { type: 'system', subtype: 'init', timestamp: iso(29_000) },
  { type: 'result', subtype: 'success', num_turns: 0, duration_api_ms: 0, duration_ms: 5, total_cost_usd: 9.9 },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }, timestamp: iso(1000) },
]);
s = scanProject('phantom', tmp);
ok(s.state === 'live' && s.lastTurn === null, 'un result fantôme n\'est ni une fin de tour ni un « dernier tour »');
ok(s.callbackTo === 'chef', 'callbackTo pendant le tour qui l\'a demandé');

write('approx', [
  { type: 'user_prompt', text: 'x', timestamp: iso(90_000) },
  { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9, duration_api_ms: 1, total_cost_usd: 1 },
]);
s = scanProject('approx', tmp);
ok(s.lastTurn?.endedAtApprox === true && s.lastTurn.endedAt > 0 && s.lastTurn.isError, 'fin de tour approximée par le mtime (result non horodaté), échec reconnu');
ok(s.lastActivitySource === 'mtime', 'âge signalé comme approximatif');

ok(scanProject('absent', tmp).lastActivityAt === null, 'aucun log : jamais observé');

console.log('\n── 1b. tailLines : première ligne');
write('one', [{ type: 'user_prompt', text: 'seul événement', timestamp: iso(1000) }]);
s = scanProject('one', tmp);
ok(s.state === 'live' && s.mission === 'seul événement', 'un log d\'une ligne garde sa ligne (état live)');
const big = path.join(tmp, 'big.jsonl');
const pad = 'x'.repeat(300);
fs.writeFileSync(big, Array.from({ length: 1200 }, (_, i) => JSON.stringify({ type: 'notification', i, pad })).join('\n') + '\n');
s = scanProject('big', tmp);
ok(s.state === 'idle', 'un gros log (> 256 Kio) se lit sans erreur (ligne partielle jetée)');

console.log('\n── 2. Classement de public/projets.js (vrai code, VM)');
const ctx = { console, setTimeout, clearTimeout, performance, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '', search: '' } };
ctx.window = ctx;
ctx.document = { querySelector: () => null, getElementById: () => null, addEventListener() {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'salle.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'projets.js'), 'utf8'), ctx);
const classify = ctx.Projets.classify;
const M = (state, extra = {}) => ({ name: 'x', state, parked: false, awaitingChef: false, ...extra });
const cases = [
  ['question',             M('input'),                              {},                               'attention', 'question'],
  ['processus perdu',      M('live'),                               { deadInFlight: true },            'attention', 'dead'],
  ['échec',                M('error'),                              {},                               'attention', 'error'],
  ['sans progrès',         M('think'),                              { stalled: true, silentMs: 90_000 }, 'attention', 'stall'],
  ['en cours',             M('live'),                               {},                               'active',    'live'],
  ['réflexion',            M('think'),                              {},                               'active',    'think'],
  ['attend le chef',       M('unread', { awaitingChef: true }),     {},                               'active',    'chef'],
  ['attend le chef (instantané, après rechargement)', M('unread'), { awaitingChef: true },            'active',    'chef'],
  ['en file sans tour',    M('idle'),                               { queueDepth: 2 },                'active',    'queued'],
  ['terminé non lu',       M('unread'),                             {},                               'rest',      'unread'],
  ['prêt',                 M('idle'),                               {},                               'rest',      'idle'],
  ['parqué au repos',      M('unread', { parked: true }),           {},                               'parked',    'parked'],
  ['parqué avec question', M('input', { parked: true }),            {},                               'attention', 'question'],
  ['parqué en cours',      M('live', { parked: true }),             {},                               'active',    'live'],
  ['parqué : santé non suivie', M('live', { parked: true }),        { stalled: true, deadInFlight: true }, 'active', 'live'],
];
for (const [label, m, r, group, kind] of cases) {
  const c = classify(m, r);
  ok(c.group === group && c.kind === kind, `${label} → ${group}/${kind} (obtenu ${c.group}/${c.kind})`);
}

console.log('\n── 3. server.js');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const route = SRC.slice(SRC.indexOf("app.get('/api/pupitre'"), SRC.indexOf("app.get('/api/pupitre'") + 2500);
ok(!/state:\s*'idle'\s*}/.test(route), "/api/pupitre ne force plus « idle » pour les parqués");
ok(/PUPITRE_PARKED_CACHE_MS/.test(route) && /healthTracked/.test(route), 'parqués scannés (cache 60 s), healthTracked exposé');
ok(/ui:\s*uiFlags\(\)/.test(route) && /version:\s*meta\.version/.test(route), 'ui, version et build exposés');
ok(/config\.ui\s*=\s*parsed\.ui/.test(SRC) && /uiChanged/.test(SRC), '`ui` relu à chaud avec signal fleet_config_changed');
const metaFn = SRC.slice(SRC.indexOf('async function refreshProjectMeta'), SRC.indexOf('function projectMetaFor'));
ok(/fsp\./.test(metaFn) && !/fs\.(readFileSync|statSync|existsSync)/.test(metaFn), 'métadonnées lues en asynchrone uniquement (jamais de I/O synchrone sur I:\\Dev)');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
