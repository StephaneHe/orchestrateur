#!/usr/bin/env node
// ============================================================================
// scripts/_test_explicit_model.mjs — « model explicite = aucun fallback »
// ============================================================================
//
// Règle utilisateur : « si un modèle est précisément demandé, aucun fallback
// n'est toléré ». On lance le VRAI scripts/dispatch.mjs de bout en bout, dans
// une racine jetable (DISPATCH_ROOT_FOR_TESTS : config.json, logs/, pas de
// .env), avec des doublures de `claude` (CLAUDE_BIN) et de `codex`
// (CODEX_BIN). Le drapeau de limite Claude est fleet-wide : il n'est posé QUE
// dans la racine jetable, jamais dans le vrai logs/. Aucun appel réseau :
// sans clé NVIDIA, le failover passe directement à la doublure codex.
//
//   node scripts/_test_explicit_model.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');

let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const scenario = (n) => console.log(`\n── ${n}`);

// ---------- racine jetable + doublures -------------------------------------

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-model-'));
const PROJ = path.join(T, 'proj');
fs.mkdirSync(path.join(T, 'logs'), { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef',
  defaults: { model: 'claude-opus-4-8', allowedTools: 'Read', provider: 'claude' },
  projects: [{ name: 'chef', path: PROJ }, { name: 'M', path: PROJ }],
}));

// Doublure claude : sert le model demandé (--model), ou STUB_SERVE si posé ;
// STUB_LIMIT=1 ⇒ notice de limite de session + result en erreur (comme le CLI).
// Comme le vrai CLI, il y a un délai entre system/init et la suite (le vrai
// CLI fait au moins un aller-retour d'API avant tout message ou outil) :
// c'est dans cette fenêtre que dispatch.mjs doit arrêter un mauvais model.
const CLAUDE_STUB = path.join(T, 'claude-stub.mjs');
fs.writeFileSync(CLAUDE_STUB, `
const a = process.argv.slice(2);
const asked = a[a.indexOf('--model') + 1];
const served = process.env.STUB_SERVE || asked;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'sid-1', model: served });
setTimeout(() => {
  if (process.env.STUB_LIMIT === '1') {
    out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 3pm" }] }, session_id: 'sid-1' });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_api_ms: 10, result: "You've hit your session limit · resets 3pm", session_id: 'sid-1' });
    process.exitCode = 1;
    return;
  }
  out({ type: 'assistant', message: { model: served, content: [{ type: 'text', text: 'fait par ' + served }] }, session_id: 'sid-1' });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_api_ms: 10, result: 'fait par ' + served, session_id: 'sid-1' });
}, 1500);
`);
// Doublure codex : réussit toujours, laisse une trace de son lancement.
const CODEX_STUB = path.join(T, 'codex-stub.mjs');
const CODEX_MARK = path.join(T, 'codex-ran.txt');
fs.writeFileSync(CODEX_STUB, `
require('fs').writeFileSync(${JSON.stringify(CODEX_MARK)}, process.argv.slice(2).join(' '));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 'th-stub' });
out({ type: 'item.completed', item: { type: 'agent_message', text: 'fait par codex' } });
out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
`.replace("require('fs')", "(await import('node:fs')).default"));

const LOG = path.join(T, 'logs', 'M.jsonl');
const LIMIT = path.join(T, 'logs', 'claude-limited.until');
function reset() {
  for (const f of [LOG, LIMIT, CODEX_MARK, path.join(T, 'logs', 'M.session')]) { try { fs.rmSync(f); } catch {} }
}
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [DISPATCH, 'M', ...args, 'fais la tâche'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '', NVIDIA_API_KEY: '', DISPATCH_SLOT: '', DISPATCH_TICKET: '',
      DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: CLAUDE_STUB, CODEX_BIN: CODEX_STUB,
      CODEX_HOME: path.join(T, 'codex-home'),
      ...env,
    },
  });
  const events = fs.existsSync(LOG)
    ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const results = events.filter(e => e.type === 'result');
  return { code: r.status, err: r.stderr || '', events, last: results[results.length - 1] || null, results };
}
const futureIso = () => new Date(Date.now() + 3600_000).toISOString();

// ---------- 1. limite simulée AU DÉMARRAGE ---------------------------------

scenario('limite Claude active au démarrage');
reset(); fs.writeFileSync(LIMIT, futureIso());
let r = run(['--model', 'claude-opus-5']);
ok(r.code === 1 && !fs.existsSync(CODEX_MARK), 'avec --model explicite : aucun failover (ni NVIDIA ni codex lancé)');
ok(r.events.some(e => e.type === 'system' && e.subtype === 'fallback_refused' && e.model_requested === 'claude-opus-5'),
   'la décision est journalisée : system/fallback_refused, model demandé');
ok(r.last?.is_error === true && r.last.subtype === 'error_model_unavailable' && r.last.model_unavailable === true,
   'le tour échoue proprement : result is_error (error_model_unavailable)');
ok(/model demandé claude-opus-5 indisponible : limite de session Claude .* aucun fallback \(règle utilisateur\)/.test(r.last?.result || ''),
   'cause explicite dans le result (texte du ✕ reçu par le chef)');
ok(r.last && !r.last.synthetic, 'result NON synthétique ⇒ le serveur notifie et réveille le chef en ✕');
ok(/fallback refusé : model explicite claude-opus-5/.test(r.err), 'trace console « fallback refusé : model explicite X »');

reset(); fs.writeFileSync(LIMIT, futureIso());
r = run([]);
ok(r.events.some(e => e.type === 'system' && e.subtype === 'failover' && e.to === 'nvidia-cascade'),
   'SANS --model : failover inchangé (bascule vers la cascade NVIDIA)');
ok(fs.existsSync(CODEX_MARK) && /--model gpt-5\.6-sol/.test(fs.readFileSync(CODEX_MARK, 'utf8')),
   '… puis, sans clé NVIDIA, repli codex FAILOVER_CODEX_MODEL comme avant');
ok(!r.events.some(e => e.subtype === 'fallback_refused'), '… et aucune trace de refus (la règle ne concerne que le model explicite)');

// ---------- 2. limite détectée PENDANT le tour ------------------------------

scenario('limite Claude détectée pendant le tour');
reset();
r = run(['--model', 'claude-opus-5'], { STUB_LIMIT: '1' });
ok(!fs.existsSync(CODEX_MARK) && !r.events.some(e => e.subtype === 'failover'), 'avec --model : pas de rejeu NVIDIA/codex');
ok(r.last?.subtype === 'error_model_unavailable' && /limite de session Claude/.test(r.last.result), 'échec explicite « limite de session »');
ok(fs.existsSync(LIMIT), 'le drapeau de limite est quand même posé (les dispatches sans model explicite doivent basculer)');

reset();
r = run([], { STUB_LIMIT: '1' });
ok(r.events.some(e => e.subtype === 'failover') && fs.existsSync(CODEX_MARK), 'sans --model : rejeu en failover, inchangé');

// ---------- 3. substitution silencieuse par le CLI --------------------------

scenario('model substitué par le CLI');
reset();
r = run(['--model', 'claude-opus-5'], { STUB_SERVE: 'claude-opus-5-5' });
ok(r.last?.subtype === 'error_model_unavailable' && /a servi « claude-opus-5-5 »/.test(r.last.result),
   'CLI qui sert claude-opus-5-5 pour claude-opus-5 ⇒ détecté (préfixe ≠ même model) et le tour échoue');
ok(r.events.find(e => e.subtype === 'fallback_refused')?.model_served === 'claude-opus-5-5', 'le model servi est consigné');
ok(!r.events.some(e => e.type === 'assistant' && /fait par/.test(JSON.stringify(e))),
   'arrêté dès system/init : aucun travail fait par le mauvais model');
ok(r.results.length === 1, 'un seul result dans le log : l’échec (le CLI tué n’a jamais conclu en ✓)');

reset();
r = run(['--model', 'claude-opus-5']);
ok(r.last?.subtype === 'success' && r.results.length === 1, 'model servi = model demandé : tour normal, un seul result');
reset();
r = run(['--model', 'claude-haiku-4-5'], { STUB_SERVE: 'claude-haiku-4-5-20251001' });
ok(r.last?.subtype === 'success', 'suffixe de date du même model toléré');
reset();
r = run([], { STUB_SERVE: 'claude-sonnet-5' });
ok(r.last?.subtype === 'success', 'sans --model : pas de vérification (comportement inchangé)');

// ---------- 4. codex à model explicite --------------------------------------

scenario('codex --model explicite : vérifié dans la rollout');
function rollout(model) {
  const d = new Date();
  const dir = path.join(T, 'codex-home', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.rmSync(path.join(T, 'codex-home'), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-2026-01-01T00-00-00-th-stub.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'th-stub', source: 'exec' } }) + '\n' +
    JSON.stringify({ type: 'turn_context', payload: { model } }) + '\n');
}
reset(); rollout('gpt-6-astra');
r = run(['--provider', 'codex', '--model', 'gpt-6-astra']);
ok(r.last?.subtype === 'success' && r.events.some(e => e.subtype === 'model_verified' && e.model_served === 'gpt-6-astra'),
   'rollout = model demandé ⇒ model_verified, tour normal');
reset(); rollout('gpt-5.6-sol');
r = run(['--provider', 'codex', '--model', 'gpt-6-astra']);
ok(r.last?.subtype === 'error_model_unavailable' && /codex a servi « gpt-5\.6-sol »/.test(r.last.result),
   'rollout ≠ model demandé ⇒ tour en échec explicite');
reset(); fs.rmSync(path.join(T, 'codex-home'), { recursive: true, force: true });
r = run(['--provider', 'codex', '--model', 'gpt-6-astra']);
ok(r.last?.subtype === 'success' && r.events.some(e => e.subtype === 'model_unverified'),
   'rollout introuvable ⇒ « non vérifiable » journalisé, sans faire échouer le tour (rien de prouvé)');

// ---------- 5. file / pool / API : le model voyage intact -------------------

scenario('file et API : le model demandé n’est jamais réécrit');
{
  const SRV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/model:\s+typeof req\.body\?\.model\s+=== 'string' \? req\.body\.model/.test(SRV), 'l’entrée de file garde le model du --model d’origine');
  ok(/\{ callback, source, model, provider, slot, ticket, noQueueIfBusy: true \}/.test(SRV), 'le drain le repasse tel quel (spawnDirectDispatch → --model)');
  ok(/opts\.model === 'string' && opts\.model\) args\.push\('--model', opts\.model\)/.test(SRV), 'spawnDirectDispatch le transmet en --model ⇒ explicite côté dispatch.mjs');
  ok(/!ev\.synthetic && !ev\.model_unavailable &&/.test(SRV), 'pas de drain immédiat derrière un ✕ « model indisponible »');
  ok(/\[fallback-refusé\]/.test(SRV) && /debugLog\(msg\)/.test(SRV), 'le serveur trace [fallback-refusé] dans server-debug.log');
}

scenario('côté serveur : le ✕ part bien au chef');
{
  const { isPhantomResult, isQuestionResolved } = await import('./fleet-status-core.mjs');
  const SRV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const a = SRV.indexOf('function reduceMusician(');
  const reduce = new Function('musicianAutoStates', 'isPhantomResult', 'isQuestionResolved', 'NEEDS_CHEF_RE',
    `${SRV.slice(a, SRV.indexOf('\n}\n', a) + 2)}\nreturn reduceMusician;`)(new Map(), isPhantomResult, isQuestionResolved, /NEEDS_CHEF_INPUT:\s*([^\n]+)/i);
  reset(); fs.writeFileSync(LIMIT, futureIso());
  const rr = run(['--model', 'claude-opus-5', '--callback', 'chef']);
  let out = null;
  for (const e of rr.events) out = reduce('M', e);
  ok(!isPhantomResult(rr.last), 'le result d’échec n’est jamais pris pour un « result fantôme »');
  ok(out.prevState === 'live' && out.newState === 'error', 'le musicien passe en « échec » (rouge), pas en « prêt »');
  ok(out.expectCallback === 'chef', 'l’attente --callback chef est honorée ⇒ notification ✕ + réveil du chef');
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
