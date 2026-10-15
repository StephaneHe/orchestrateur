#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_handoff_slot.mjs — a Routage hand-off to the chef passes
// even with the chef turn's DISPATCH_SLOT inherited, as in production (0.100.1)
// ============================================================================
//
// Incident (prod, 2026-10-14 18:16 and 19:40, logs/chef-actions.log): the
// hand-off launched by chef-action-deferred.mjs inherited the chef turn's env,
// DISPATCH_SLOT included. dispatch.mjs saw « a chef speaking to the chef » and
// refused it at the P0-B guard (65) before ever checking ORCH_HANDOFF_TOKEN.
// _test_chef_handoff.mjs missed it: it deletes DISPATCH_SLOT. User decision,
// verbatim: « 1. oui / 2. A » (option A: let a hand-off carrying a valid token
// for its reference through; every other chef → chef call stays refused).
//
// Protected (DISPATCH_SLOT and DISPATCH_TICKET KEPT in every call):
//   1. valid token for this ref → accepted, a signed hand-off turn;
//   2. no token, wrong token, token signed for another ref → 65;
//   3. ordinary chef → chef (no --chef-handoff) → 65, as before;
//   4. the hand-off never resumes the chef's session (a pool slot may be
//      running it) nor replaces its sidecar, and consumes no pool ticket;
//   5. end to end: a pool-assigned Routage turn (DISPATCH_SLOT=1) hands a task
//      back, the deferred launcher inherits the slot, the chef turn runs.
//
//   node scripts/_test_chef_handoff_slot.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-handoff-slot-'));
for (const d of ['logs', 'chef', 'R']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
fs.writeFileSync(path.join(T, 'R', 'package.json'), '{"name":"R","version":"1.0.0"}\n');
spawnSync('git', ['init', '-q'], { cwd: path.join(T, 'R') });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'R'].map(n => ({ name: n, path: path.join(T, n) })),
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
// As in production: the env of a chef turn of the pool (slot 1, its ticket).
const slotEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_CHEF_HANDOFF_TEST: '1',
  DISPATCH_SLOT: '1', DISPATCH_TICKET: 't-pool-en-vol' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ORCH_HANDOFF_TOKEN',
  'DISPATCH_REPORT_ONLY', 'DISPATCH_POOL_ASSIGN', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP', 'ORCH_CHEF_ACTION_RUNNER']) delete slotEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const CHEF_SESSION = path.join(T, 'logs', 'chef.session');
const IN_FLIGHT = 'sess-chef-en-vol-0000';
fs.writeFileSync(CHEF_SESSION, IN_FLIGHT);
const dispatch = (args, env) => spawnSync(process.execPath, [DISPATCH, ...args], { env: { ...slotEnv, ...env }, encoding: 'utf8', timeout: 120_000, windowsHide: true });
const HAND_PROMPT = '[RENVOI_CHEF] Le Routage t’a renvoyé cette tâche : clore les exécutions en pause.';

// ---------------------------------------------------------------------------
section('1-3. Garde P0-B avec DISPATCH_SLOT hérité : seul un jeton valide pour CETTE référence passe');
const ref = 'p-20261015T090000-a1b2c3#2';
const other = 'p-20261015T090000-a1b2c3#3';
const cases = [
  ['jeton absent', {}],
  ['jeton faux', { ORCH_HANDOFF_TOKEN: 'f'.repeat(64) }],
  ['jeton émis pour une autre référence', { ORCH_HANDOFF_TOKEN: E.handoffToken(T, other) }],
  ['jeton mal formé', { ORCH_HANDOFF_TOKEN: 'pas-un-jeton' }],
];
for (const [label, env] of cases) {
  const n0 = logOf('chef').length;
  const r = dispatch(['chef', HAND_PROMPT, '--chef-handoff', ref, '--test', 'renvoi-slot'], env);
  ok(r.status === 65 && /P0-B/.test(r.stderr || '') && /jeton absent ou invalide/.test(r.stderr || ''), `${label} : refusé (exit ${r.status})`, r.stderr);
  ok(logOf('chef').length === n0, `${label} : rien écrit dans le fil du chef`);
}
let r = dispatch(['chef', 'Fais-le toi-même', '--test', 'chef-vers-chef'], {});
ok(r.status === 65 && /délégation chef → chef non disponible \(P0-B\)/.test(r.stderr || '') && !/jeton/.test(r.stderr || ''), `appel chef → chef ordinaire : toujours refusé (exit ${r.status})`, r.stderr);
r = dispatch(['chef', 'Fais-le toi-même', '--test', 'chef-vers-chef-jeton'], { ORCH_HANDOFF_TOKEN: E.handoffToken(T, ref) });
ok(r.status === 65, `appel chef → chef ordinaire avec un jeton en poche mais sans --chef-handoff : refusé (exit ${r.status})`, r.stderr);

const n0 = logOf('chef').length;
r = dispatch(['chef', HAND_PROMPT, '--chef-handoff', ref, '--test', 'renvoi-slot'], { ORCH_HANDOFF_TOKEN: E.handoffToken(T, ref) });
const evs = logOf('chef').slice(n0);
const up = evs.find(e => e.type === 'user_prompt');
ok(r.status === 0 && up?.chefHandoff?.run === ref.split('#')[0] && up.chefHandoff.tasks?.join() === '2', `jeton valide pour cette référence : accepté, tour signé (exit ${r.status})`, `${r.stderr}\n${JSON.stringify(up)}`);
ok(evs.some(e => e.type === 'result' && !e.is_error), 'le tour de renvoi se termine (result)');
ok(up && up.slot == null && up.ticket == null && up.callbackSlot == null, 'aucun ticket du pool consommé (slot/ticket hérités non tamponnés)', JSON.stringify(up));

// ---------------------------------------------------------------------------
section('4. Le renvoi ne reprend jamais la session du chef en vol');
const init = evs.find(e => e.type === 'system' && e.subtype === 'init');
ok(init?.session_id && init.session_id !== IN_FLIGHT, `session neuve, pas de --resume sur ${IN_FLIGHT} (${init?.session_id})`, JSON.stringify(init));
ok(fs.readFileSync(CHEF_SESSION, 'utf8').trim() === IN_FLIGHT, 'logs/chef.session inchangé');
const hs = path.join(T, 'logs', 'runs', ref.split('#')[0], 'handoff.session');
ok(fs.existsSync(hs) && fs.readFileSync(hs, 'utf8').trim() === init?.session_id, 'la session du renvoi est gardée à part (logs/runs/<run>/handoff.session)');

// ---------------------------------------------------------------------------
section('5. Bout en bout : Routage assigné par le pool (DISPATCH_SLOT=1), renvoi lancé par le lanceur différé');
const CLEAN = 'Clore les exécutions de pipeline en pause devenues sans objet (logs/runs), en les listant d’abord, sans toucher aux projets.';
const HANDOFF = { projet: 'chef', titre: 'nettoyage des exécutions en pause', demande: CLEAN, renvoi_chef: { raison: 'gestion de l’orchestration : le chef agit lui-même' } };
const m0 = logOf('chef').length;
r = dispatch(['chef', 'Nettoie les exécutions en pause', '--pool-assign', '--test', 'renvoi-slot-e2e'], {
  FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'un nettoyage par le chef', raison: 'x' }, decomposer: { taches: [HANDOFF] } }),
  FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify({ 'exécutions de pipeline en pause': { chef: 'autre', raison: 'gestion des exécutions : le chef' } }),
});
const run = logOf('chef').slice(m0).find(e => e.type === 'user_prompt')?.pipeline?.run;
ok(r.status === 0 && run, `tour du Routage terminé (exit ${r.status}, ${run})`, `${r.stdout}${r.stderr}`.slice(-900));
let hand = null;
for (let i = 0; i < 120 && !hand; i++) {
  hand = logOf('chef').slice(m0).find(e => e.type === 'user_prompt' && e.chefHandoff);
  if (!hand) await sleep(500);
}
ok(hand?.chefHandoff?.run === run && hand.text.includes(CLEAN), 'le chef reçoit le tour renvoyé malgré DISPATCH_SLOT hérité', JSON.stringify(hand)?.slice(0, 400));
let handRes = null;
for (let i = 0; i < 60 && !handRes; i++) {
  const all = logOf('chef'); const k = all.indexOf(all.find(e => e.type === 'user_prompt' && e.chefHandoff && e.chefHandoff.run === run));
  handRes = k >= 0 ? all.slice(k).find(e => e.type === 'result') : null;
  if (!handRes) await sleep(500);
}
ok(handRes && !handRes.is_error, 'le tour renvoyé se termine (result)', JSON.stringify(handRes)?.slice(0, 300));
let actions = '';
for (let i = 0; i < 20 && !/exited with/.test(actions); i++) { try { actions = fs.readFileSync(path.join(T, 'logs', 'chef-actions.log'), 'utf8'); } catch {} if (!/exited with/.test(actions)) await sleep(500); }
ok(/handoff .* exited with 0/.test(actions) && !/P0-B/.test(actions), 'logs/chef-actions.log : renvoi sorti en 0, plus de refus P0-B', actions.slice(-600));
ok(fs.readFileSync(CHEF_SESSION, 'utf8').trim() !== '' , 'le sidecar du chef existe toujours');

await sleep(500);
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
