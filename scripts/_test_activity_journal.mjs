#!/usr/bin/env node
// ============================================================================
// scripts/_test_activity_journal.mjs — « vu », arrêt par le chef, journal (0.31.0)
// ============================================================================
//
//   1. TurnCore.createJournal (public/turn-core.js, partagé client/serveur) :
//      demande sans boilerplate, résumé, commits/versions/URL, issues, result
//      fantôme et result qui suit un arrêt ignorés, « vu » rattaché au tour.
//   2. deriveState (fleet-status-core) : arrêt par le chef = `error` + stopped,
//      le result qui suit est ignoré, l'acquittement repasse à `idle` et
//      SURVIT à une relecture du log (= au redémarrage), un nouveau tour efface.
//   3. De bout en bout : le VRAI dispatch.mjs (racine jetable, doublure claude
//      lente, model explicite) tué par le VRAI kill-stalled.mjs --reason : un
//      seul result dans le log, celui du chef, avec son motif ; plus de
//      « model indisponible » qui masquait l'arrêt.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveState, createJournal } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const section = (n) => console.log(`\n── ${n}`);
const T0 = Date.parse('2026-10-02T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

// ---------------------------------------------------------------------------
section('1. Journal des tours');
const BOILER = `Corrige le bug du login.\nDétail : le jeton expire trop tôt.\n\n---\nUne fois ta tâche terminée — ou si tu as un point important à signaler — envoie un résumé au projet « chef »…`;
const evs = [
  { type: 'user_prompt', text: BOILER, timestamp: at(0) },
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5', timestamp: at(1) },
  { type: 'stream_event', event: {} },
  { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git commit -m "fix: jeton" && git push' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '[master 1a2b3c4] fix: jeton\n 1 file changed' }] } },
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5', timestamp: at(30) },   // 2e init du même tour
  { type: 'assistant', message: { content: [{ type: 'text', text: '**Corrigé** : le jeton dure 24 h.\nVersion v1.4.2 publiée, voir https://example.org/release.\n\nDétails sans intérêt.' }] } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 4, duration_ms: 65000, duration_api_ms: 60000, total_cost_usd: 0.37,
    result: '**Corrigé** : le jeton dure 24 h.\nVersion v1.4.2 publiée, voir https://example.org/release.\n\nDétails sans intérêt.' },
  // result fantôme : ignoré
  { type: 'result', subtype: 'success', num_turns: 0, duration_api_ms: 0, total_cost_usd: 0.37 },
  // tour 2 : question
  { type: 'user_prompt', text: '[CHEF_ANSWER] Choisis le nom du module', timestamp: at(100) },
  { type: 'system', subtype: 'init', timestamp: at(101) },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Deux options.\nNEEDS_USER_INPUT: getUser ou fetchUser ?' }] } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5000, duration_api_ms: 4000, result: 'Deux options.\nNEEDS_USER_INPUT: getUser ou fetchUser ?' },
  // tour 3 : arrêté par le chef, puis l'ancien result parasite de dispatch.mjs
  { type: 'user_prompt', text: 'Longue tâche', timestamp: at(200) },
  { type: 'system', subtype: 'init', timestamp: at(201) },
  { type: 'result', subtype: 'error_killed_by_conductor', is_error: true, stopped_by: 'chef', reason: 'boucle sans progrès', duration_ms: 0, timestamp: at(500) },
  { type: 'system', subtype: 'fallback_refused', timestamp: at(500) },
  { type: 'result', subtype: 'error_model_unavailable', is_error: true, num_turns: 0, result: 'model demandé X indisponible', timestamp: at(500) },
  { type: 'notification', subtype: 'acknowledged', of: 'stopped', by: 'utilisateur', auto: true, timestamp: at(600) },
  // tour 4 : demande sourcée (callback) + init = un vrai tour ; échec
  { type: 'user_prompt', source: 'chef', text: 'Relance les tests', timestamp: at(700) },
  { type: 'system', subtype: 'init', timestamp: at(701) },
  { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 30, duration_ms: 9000, duration_api_ms: 8000, result: '' },
  // tour 5 : en cours
  { type: 'user_prompt', text: 'Nouvelle tâche', timestamp: at(800) },
  { type: 'system', subtype: 'init', timestamp: at(801) },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: 'a' } }] } },
];
const j = createJournal({ max: 50 });
for (const e of evs) j.push(e);
const L = j.list();
ok(L.length === 5, `5 tours (fantôme, 2e init et result parasite ne créent rien) — ${L.length}`);
const [t5, t4, t3, t2, t1] = L;
ok(t1.prompt === 'Corrige le bug du login. — Détail : le jeton expire trop tôt.', `demande sans boilerplate : « ${t1.prompt} »`);
ok(t1.outcome === 'ok' && t1.durationMs === 65000 && t1.costUsd === 0.37 && t1.model === 'claude-opus-5-5', 'issue, durée, coût, model');
ok(t1.summary[0] === 'Corrigé : le jeton dure 24 h.' && t1.summary.length === 3, `résumé : ${JSON.stringify(t1.summary)}`);
ok(t1.commits.length === 1 && t1.commits[0].sha === '1a2b3c4' && t1.commits[0].msg === 'fix: jeton', 'commit lu dans la sortie de git');
ok(t1.pushed === true, 'push détecté');
ok(t1.versions.join() === '1.4.2' && t1.urls.join() === 'https://example.org/release', `version/URL : ${t1.versions} ${t1.urls}`);
ok(t2.outcome === 'question' && t2.question === 'getUser ou fetchUser ?' && t2.prompt === 'Choisis le nom du module', 'question + préfixe [CHEF_ANSWER] retiré');
ok(t3.outcome === 'stopped' && t3.stop.reason === 'boucle sans progrès' && t3.summary[0] === 'boucle sans progrès', 'arrêt par le chef avec son motif');
ok(t3.ack && t3.ack.by === 'utilisateur', '« vu » rattaché au tour arrêté');
ok(t4.outcome === 'error' && t4.subtype === 'error_max_turns' && t4.source === 'chef' && t4.prompt === 'Relance les tests', 'tour sourcé + init = un vrai tour, échec');
ok(t5.outcome === 'running' && t5.tools === 1, 'tour en cours');
{
  const k = createJournal({ max: 50 });
  k.push({ type: 'result', subtype: 'success', result: 'Fait. Commité en local (e5b0408, v1.1.0).', duration_ms: 10 });
  ok(k.list()[0].commits[0]?.sha === 'e5b0408' && k.list()[0].prompt === '', 'SHA cité dans le texte ; tour sans demande visible');
}

// ---------------------------------------------------------------------------
section('2. États : arrêt, « vu » persistant, nouveau tour');
const lines = (arr) => arr.map(e => JSON.stringify(e));
const upToStop = evs.slice(13, 16);   // prompt, init, kill
let d = deriveState(lines(upToStop));
ok(d.state === 'error' && d.stopped?.reason === 'boucle sans progrès', `arrêt : ${d.state} ${JSON.stringify(d.stopped)}`);
ok(deriveState(lines(evs.slice(13, 18))).state === 'error', 'le result « model indisponible » qui suit est ignoré (toujours arrêté)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ack-'));
const logFile = path.join(tmp, 'p.jsonl');
fs.writeFileSync(logFile, lines(evs.slice(13, 18)).join('\n') + '\n');
fs.appendFileSync(logFile, JSON.stringify({ type: 'notification', subtype: 'acknowledged', of: 'stopped', by: 'utilisateur', timestamp: at(600) }) + '\n');
d = deriveState(fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean));
ok(d.state === 'idle' && d.stopped === null && d.acknowledged?.by === 'utilisateur', 'acquitté → idle, relu depuis le disque (survit au redémarrage)');
const errLines = lines([{ type: 'user_prompt', text: 'x', timestamp: at(1) }, { type: 'result', subtype: 'error_max_turns', is_error: true }]);
ok(deriveState(errLines).state === 'error' && deriveState(errLines).stopped === null, 'échec ordinaire : pas « arrêté »');
ok(deriveState([...errLines, JSON.stringify({ type: 'notification', subtype: 'acknowledged', of: 'error' })]).state === 'idle', 'échec acquitté → idle');
ok(deriveState([...errLines, JSON.stringify({ type: 'notification', subtype: 'acknowledged' }), ...lines([{ type: 'user_prompt', text: 'y' }])]).state === 'live', 'un nouveau tour reprend la main');
const inputLines = lines([{ type: 'assistant', message: { content: [{ type: 'text', text: 'NEEDS_USER_INPUT: oui ?' }] } }, { type: 'result', subtype: 'success' }]);
ok(deriveState([...inputLines, JSON.stringify({ type: 'notification', subtype: 'acknowledged' })]).state === 'input', '« vu » ne répond pas à une question (reste input)');
fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('3. kill-stalled --reason contre le vrai dispatch.mjs');
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-kill-'));
fs.mkdirSync(path.join(R, 'logs'));
fs.mkdirSync(path.join(R, 'proj'));
fs.writeFileSync(path.join(R, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-opus-5-5', allowedTools: 'Read', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(R, 'proj') }, { name: 'K', path: path.join(R, 'proj') }],
}));
const STUB = path.join(R, 'claude-slow.mjs');
fs.writeFileSync(STUB, `
const a = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'sid-k', model: a[a.indexOf('--model') + 1] });
setTimeout(() => {}, 60000);
`);
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: R, CLAUDE_BIN: STUB };
delete env.ANTHROPIC_API_KEY;
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'K', 'Tâche interminable', '--model', 'claude-opus-5-5', '--no-queue-if-busy'],
  { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stderr = '';
child.stderr.on('data', (b) => { stderr += b; });
const exited = new Promise((res) => child.on('close', (code) => res(code)));
const pidFile = path.join(R, 'logs', 'K.pid');
const logK = path.join(R, 'logs', 'K.jsonl');
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
const started = await waitFor(() => fs.existsSync(pidFile) && fs.existsSync(logK) && fs.readFileSync(logK, 'utf8').includes('"init"'), 20000);
ok(started, 'tour démarré (pid + system/init)');
if (started) {
  const k = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'kill-stalled.mjs'), 'K', '--reason', 'boucle sans progrès'], { env, encoding: 'utf8' });
  ok(k.status === 0 && /arrêté par le chef/.test(k.stdout), `kill-stalled : ${k.stdout.trim()}`);
  const code = await Promise.race([exited, new Promise(r => setTimeout(() => r('timeout'), 20000))]);
  ok(code !== 'timeout', `dispatch.mjs terminé (code ${code})`);
  await new Promise(r => setTimeout(r, 300));
  const evK = fs.readFileSync(logK, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const results = evK.filter(e => e.type === 'result');
  ok(results.length === 1 && results[0].subtype === 'error_killed_by_conductor' && results[0].reason === 'boucle sans progrès',
    `un seul result, celui du chef : ${results.map(r => r.subtype).join(', ')}`);
  ok(!evK.some(e => e.subtype === 'fallback_refused'), 'aucun « fallback refusé » / « model indisponible »');
  ok(!fs.existsSync(path.join(R, 'logs', 'K.killed')), 'marqueur .killed consommé');
  const st = deriveState(evK.map(e => JSON.stringify(e)));
  ok(st.state === 'error' && st.stopped?.reason === 'boucle sans progrès', 'état : arrêté par le chef, motif conservé');
} else {
  child.kill();
  console.log(stderr.slice(-600));
}
try { child.kill(); } catch {}
ok(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'kill-stalled.mjs'), '../x'], { env, encoding: 'utf8' }).status === 64, 'nom de projet invalide refusé (64)');
fs.rmSync(R, { recursive: true, force: true });

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
