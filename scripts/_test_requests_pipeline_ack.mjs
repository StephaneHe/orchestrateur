#!/usr/bin/env node
// ============================================================================
// scripts/_test_requests_pipeline_ack.mjs — a chef task launched with
// --pipeline is acknowledged and followed (requests registry, 0.132.0)
// ============================================================================
//
// User report (2026-10-22, prod v0.131.0): « l'interface montre toujours la
// question de psyProfile, alors que je crois y avoir répondu. est-ce normal ? »
// Cause: a dispatch launched from a chef turn to a project in service
// (`dispatch.mjs <p> --prompt-stdin --pipeline recherche --callback chef`) had
// its user_prompt written by the pipeline engine WITHOUT `taskId`: the task was
// never acknowledged, went `à_traiter` (no acknowledgement after 2 min, then
// « dispatch.mjs s'est arrêté avant d'écrire la demande ») although its run
// started and ended normally, and the chef could only drop the request.
//
// Protected (real dispatch.mjs, real engine, fake claude, private root):
//   1. done: the run's user_prompt carries `taskId`, the task is acknowledged
//      at launch, never `à_traiter`; the sweep reads the run's result ⇒
//      `réussie`, request `terminée`;
//   2. pause: the task stays followed (`waiting.pause` = run), then the run's
//      final result after « continuer » ⇒ `réussie`;
//   3. failure: a paused run closed by « abandonner » ⇒ `à_traiter` (échec);
//   4. catch-up: tasks left `à_traiter` by the old behaviour (missed
//      acknowledgement) whose run ended are caught up by the sweep, from the
//      fingerprint of their text; any other error is left alone;
//   5. `recheck`: a request dropped because of a missed acknowledgement becomes
//      `terminée` when its run is done; a task cancelled for another reason is
//      never touched; nothing to fix ⇒ code 2;
//   6. the dashboard does not read the registry: a task `à_traiter` is never
//      shown as a question waiting for the user.
//
//   node scripts/_test_requests_pipeline_ack.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RQ from './requests.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-req-pipe-ack-'));
const LOGS = path.join(T, 'logs');
const P = path.join(T, 'proj');
for (const d of [LOGS, P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(LOGS, 'no-failover'), '');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude', maxParallel: 1 },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'discussion.repondre': { provider: 'anthropic', model: 'claude-haiku-5-5' },
    ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(P, 'test', 'pipe.test.mjs'), "import { test } from 'node:test';\ntest('pipe', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|TURN_ID|REQUEST_ID)$|^DISPATCH_SLOT$|^FAKE_PIPE_|^FAKE_CLAUDE_REPLY$|^ORCH_PIPE_(ITEMS|REVIEW_ROUNDS|GREEN_ATTEMPTS|CRITERIA_ATTEMPTS)$/.test(k)) delete baseEnv[k];
/** dispatch.mjs P …, text on stdin (as the chef does: --prompt-stdin). */
const dispatch = (args, { env = {}, stdin = null } = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  if (stdin != null) c.stdin.end(stdin); else c.stdin.end();
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(LOGS, 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const get = (id) => RQ.readRequest(LOGS, id);
const sweep = (now = Date.now()) => RQ.reconcile({ root: T, logsDir: LOGS, now, launch: () => ({ pid: null }) });
/** A chef turn (still alive: this process) whose tools launch the tasks. */
const chefRequest = (text) => { const r = RQ.createRequest(LOGS, { project: 'chef', text }); RQ.startTurn(LOGS, r.id, { turn: `t-${r.id}`, pid: process.pid }); return r; };
const endChef = (r) => RQ.finishTurn(LOGS, r.id, { turn: `t-${r.id}`, result: { type: 'result', is_error: false, result: 'Lancé.' } });
const chefLaunch = async (r, text, args, env = {}) => {
  const n0 = logOf().length;
  const x = await dispatch(['--prompt-stdin', ...args, '--callback', 'chef'], { env: { ORCH_REQUEST_ID: r.id, ...env }, stdin: text });
  const evs = logOf().slice(n0);
  return { ...x, evs, up: evs.find(e => e.type === 'user_prompt' && e.pipeline), run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run };
};
const LIVRER_KO = { FAKE_PIPE_BAD: 'livrer:99', ORCH_PIPE_CRITERIA_ATTEMPTS: '1' };
const MIN = 60_000;

try {
  // -------------------------------------------------------------------------
  section('1. Tâche du chef vers un projet en service, --pipeline : accusée au lancement, puis réussie');
  {
    const r = chefRequest('Recherche sur P');
    const x = await chefLaunch(r, 'Fais le point sur les options de P.', ['--pipeline', 'discussion']);
    let t = get(r.id).tasks[0];
    ok(x.code === 0 && x.run && t?.id === `${r.id}#1`, `exécution lancée et tâche inscrite (${x.run}, ${t?.id})`, x.out.slice(-800));
    ok(x.up?.taskId === `${r.id}#1`, `le user_prompt de l’exécution porte taskId (${x.up?.taskId})`);
    ok(t.ack?.where === 'log' && t.state === 'en_cours' && !t.error, `accusé au lancement : en_cours, sans erreur (${t.state}, ${t.ack?.where}, ${JSON.stringify(t.error || null)})`);
    endChef(r);
    sweep(Date.now() + 3 * MIN);
    t = get(r.id).tasks[0];
    ok(t.state === 'réussie' && get(r.id).state === 'terminée', `balayage : résultat de l’exécution relu, tâche réussie, demande terminée (${t.state}, ${get(r.id).state})`);
    ok(!t.history.some(h => h.to === 'à_traiter'), 'jamais passée par « à traiter »');
  }

  // -------------------------------------------------------------------------
  section('2. Exécution en pause : la tâche reste suivie, puis réussie à la fin de l’exécution');
  let pausedRun = null;
  {
    const r = chefRequest('Dev sur P');
    const x = await chefLaunch(r, 'Ajoute le tri des vidéos de P.', ['--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple'], LIVRER_KO);
    pausedRun = x.run;
    let t = get(r.id).tasks[0];
    ok(x.code === 2 && t.ack?.where === 'log' && t.state === 'en_cours' && !t.error, `pause (code ${x.code}) : tâche accusée, en_cours, aucune erreur « lancement » (${t.state}, ${JSON.stringify(t.error || null)})`, x.out.slice(-800));
    endChef(r);
    sweep(Date.now() + 3 * MIN);
    t = get(r.id).tasks[0];
    ok(t.state === 'en_cours' && t.waiting?.pause === pausedRun && get(r.id).state === 'suivie', `balayage : en pause, toujours suivie (${t.state}, ${JSON.stringify(t.waiting)}, ${get(r.id).state})`);
    const y = await dispatch(['--pipeline-resume', pausedRun, 'continuer']);
    sweep(Date.now() + 3 * MIN);
    t = get(r.id).tasks[0];
    ok(y.code === 0 && t.state === 'réussie' && get(r.id).state === 'terminée', `« continuer » puis fin de l’exécution : réussie, demande terminée (code ${y.code}, ${t.state}, ${get(r.id).state})`, y.out.slice(-600));
  }

  // -------------------------------------------------------------------------
  section('3. Exécution en pause close par « abandonner » : à traiter (échec)');
  {
    const r = chefRequest('Dev abandonné');
    const x = await chefLaunch(r, 'Ajoute le filtre des vidéos de P.', ['--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple'], LIVRER_KO);
    endChef(r);
    const y = await dispatch(['--pipeline-resume', x.run, 'abandonner']);
    sweep(Date.now() + 3 * MIN);
    const t = get(r.id).tasks[0];
    ok(x.code === 2 && t.state === 'à_traiter' && t.error?.code === 'échec' && get(r.id).state === 'à_traiter', `exécution close sans livraison : à traiter, échec (${t.state}, ${t.error?.code}, ${t.error?.why?.slice(0, 80)})`, y.out.slice(-500));
    g('reset', '-q', '--hard'); g('clean', '-qfd');
  }

  // -------------------------------------------------------------------------
  section('4. Rattrapage : tâches laissées « à traiter » par l’ancien comportement');
  {
    // The old behaviour, replayed: the task is registered, the run is launched
    // WITHOUT acknowledgement (no --task-id reaches the engine), then
    // dispatch.mjs marked it « stopped before writing the request ».
    const r = chefRequest('Rédaction sur P');
    const text = 'Rédige la synthèse des options de P.';
    const task = RQ.addTask(LOGS, r.id, { projet: 'P', demande: text, launch: { callback: 'chef', pipeline: 'discussion' } });
    const x = await dispatch(['--prompt-stdin', '--pipeline', 'discussion', '--callback', 'chef'], { stdin: text });
    RQ.failTask(LOGS, task.id, { code: 'lancement', why: 'dispatch.mjs s’est arrêté (code 0) avant d’écrire la demande' });
    endChef(r);
    ok(x.code === 0 && get(r.id).tasks[0].state === 'à_traiter' && get(r.id).state === 'à_traiter', `état de la prod reproduit : à traiter alors que l’exécution est finie (${get(r.id).tasks[0].state})`, x.out.slice(-500));
    sweep(Date.now() + 3 * MIN);
    const t = get(r.id).tasks[0];
    ok(t.state === 'réussie' && t.ack?.recovered === true && t.recoveredFrom?.code === 'lancement' && get(r.id).state === 'terminée', `balayage : accusé rattrapé par l’empreinte du texte, réussie, demande terminée (${t.state}, ${get(r.id).state})`);
    ok(t.history.some(h => /accusé rattrapé/.test(h.why || '')), 'le rattrapage est écrit dans l’historique de la tâche');

    // No acknowledgement yet (sweep before the 2 min): caught up, never « à traiter ».
    const r2 = chefRequest('Recherche sans accusé');
    const text2 = 'Cherche les sources sur le sujet de P.';
    RQ.addTask(LOGS, r2.id, { projet: 'P', demande: text2, launch: { pipeline: 'discussion' } });
    await dispatch(['--prompt-stdin', '--pipeline', 'discussion'], { stdin: text2 });
    endChef(r2);
    sweep(Date.now() + 3 * MIN);
    ok(get(r2.id).tasks[0].state === 'réussie' && get(r2.id).tasks[0].ack?.recovered, `tâche lancée sans accusé : demande retrouvée dans le journal, réussie (${get(r2.id).tasks[0].state})`);

    // Any other error, or a text never written: left for a decision.
    const r3 = chefRequest('Autres erreurs');
    const a = RQ.addTask(LOGS, r3.id, { projet: 'P', demande: text });   // same text, but a real failure
    const b = RQ.addTask(LOGS, r3.id, { projet: 'P', demande: 'Jamais lancée.' });
    RQ.failTask(LOGS, a.id, { code: 'échec', why: 'test rouge' });
    RQ.failTask(LOGS, b.id, { code: 'lancement', why: 'refusé' });
    endChef(r3);
    sweep(Date.now() + 3 * MIN);
    const [ta, tb] = get(r3.id).tasks;
    ok(ta.state === 'à_traiter' && ta.error?.code === 'échec', 'une vraie erreur (échec) n’est jamais « rattrapée »');
    ok(tb.state === 'à_traiter' && tb.error?.code === 'lancement', 'aucune demande écrite dans le journal : reste à traiter');
  }

  // -------------------------------------------------------------------------
  section('5. recheck : une demande abandonnée à tort redevient terminée');
  {
    const r = chefRequest('Recherche abandonnée à tort');
    const text = 'Liste les pistes de la recherche de P.';
    const task = RQ.addTask(LOGS, r.id, { projet: 'P', demande: text, launch: { callback: 'chef', pipeline: 'discussion' } });
    await dispatch(['--prompt-stdin', '--pipeline', 'discussion', '--callback', 'chef'], { stdin: text });
    RQ.failTask(LOGS, task.id, { code: 'lancement', why: 'dispatch.mjs s’est arrêté (code 0) avant d’écrire la demande' });
    endChef(r);
    const other = RQ.addTask(LOGS, r.id, { projet: 'P', demande: 'Une autre tâche annulée pour de bon.' });
    RQ.cmdCancel({ logsDir: LOGS, id: other.id });
    ok(RQ.cmdDrop({ logsDir: LOGS, id: r.id }).ok && get(r.id).state === 'abandonnée', 'abandonnée par la commande drop (ce qu’a dû faire le chef)');
    const c = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'requests.mjs'), 'recheck', r.id, '--by', 'chef'], { env: baseEnv, encoding: 'utf8' });
    const u = get(r.id);
    ok(c.status === 0 && u.state === 'terminée' && u.tasks[0].state === 'réussie', `recheck : tâche réussie, demande terminée (code ${c.status}, ${u.state} — ${c.stdout.trim()})`, c.stderr);
    ok(u.tasks[1].state === 'annulée', 'une tâche annulée pour une autre raison n’est pas touchée');
    ok(u.history.some(h => h.from === 'abandonnée' && h.to === 'terminée' && h.by === 'chef'), 'la correction est tracée (abandonnée → terminée, par le chef)');
    const again = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'requests.mjs'), 'recheck', r.id], { env: baseEnv, encoding: 'utf8' });
    ok(again.status === 2 && /rien à corriger/.test(again.stdout), `relancé : rien à corriger (code ${again.status})`);
  }

  // -------------------------------------------------------------------------
  section('6. Interface : le registre n’est pas affiché comme une question');
  {
    const pub = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')).join('\n');
    ok(!/à_traiter|logs\/requests|requests\.mjs/.test(pub), 'aucun fichier du dashboard ne lit le registre ni l’état « à_traiter »');
    ok(!/requests\.mjs/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'request-map.mjs'), 'utf8')), 'l’onglet Requêtes (request-map.mjs) ne lit pas le registre');
  }
} catch (e) {
  fail++; console.log(`  ✗ exception : ${e.stack}`);
} finally {
  srv.close();
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
