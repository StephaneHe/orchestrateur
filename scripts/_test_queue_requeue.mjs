#!/usr/bin/env node
// ============================================================================
// scripts/_test_queue_requeue.mjs — a queued task refused at launch for a
// passing cause is never lost (0.144.0)
// ============================================================================
//
// Real production case replayed (2026-10-23, anonymized project): the dev run
// p-20261023T153721-ec927d was PAUSED in the musician's main checkout (a
// process pause waiting for the chef), its files uncommitted. The queue's head
// (task r-20261023T150628-291c4c#1) was drained, refused « ✕ pipeline dev
// refusé : modifications non commitées (1 fichier(s)) » and gone from the
// queue; the next task too. User request (verbatim in docs/USER_REQUIREMENTS.md).
//
// Protected:
//   1. queue-requeue.mjs (pure): a paused run that dirtied the checkout holds
//      it (transient); a dirty tree no run explains holds a clean-tree pipeline
//      only (durable); heldBy validated; a paused-run hold waits while the run
//      is paused, released by its end or its closing; another hold is retried
//      on a result or after its delay;
//   2. end to end, real dispatch.mjs launched as the server's drain does
//      (--no-queue-if-busy): the head goes back to the HEAD of the queue
//      (front, heldBy paused-run), nothing written to the musician's log but a
//      queue_entry_held notification, no refusal, no lost task; the run still
//      paused — no classifier call;
//   3. same with a dirty tree and no paused run: held, durable;
//   4. a reply to the pause (« continuer ») is never held; a clean checkout is
//      never held;
//   5. chef alert (chef-alerts.mjs, kind `queue`): durable hold only, once per
//      task (stable key across requeues), after `since`;
//   6. server.js: queuePush({front}), heldBy accepted by POST /api/dispatch,
//      drain and sweep hold the head (static).
//
//   node scripts/_test_queue_requeue.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RQ from './queue-requeue.mjs';
import * as CA from './chef-alerts.mjs';
import * as E from './pipeline-engine.mjs';
import { FAST_TEST_COMMAND, FIXTURE_GIT_ENV } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const RUN = 'p-20261023T153721-ec927d';
const TASK = 'r-20261023T150628-291c4c#1';
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-requeue-'));
const LOGS = path.join(T, 'logs');
const P = path.join(T, 'P');
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(path.join(P, '.orchestrateur'), { recursive: true });
fs.mkdirSync(path.join(T, 'chef'), { recursive: true });
fs.writeFileSync(path.join(T, '.token'), 'a'.repeat(64));
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  // maxParallel 1: the production project's path (the lane path is covered by `capacity` below).
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P, maxParallel: 1 }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, history: [], assignments: {},
  enforcement: { projects: ['P'], pipelines: E.ENGINE_PIPELINES } }, null, 2));
const gitEnv = { ...process.env, ...FIXTURE_GIT_ENV };
const g = (...a) => spawnSync('git', ['-C', P, ...a], { encoding: 'utf8', windowsHide: true, env: gitEnv });
g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND }));
fs.writeFileSync(path.join(P, 'app.mjs'), 'export const v = 1;\n');
g('add', '-A'); g('commit', '-q', '-m', 'init');
const writeRun = (status) => {
  fs.mkdirSync(path.join(LOGS, 'runs', RUN), { recursive: true });
  fs.writeFileSync(path.join(LOGS, 'runs', RUN, 'run.json'), JSON.stringify({ run: RUN, project: 'P', pipeline: 'dev', mode: 'complet', kind: 'simple', status,
    pausedLimit: 'items_blocked', base: g('rev-parse', 'HEAD').stdout.trim(), plan: [], index: 0, steps: [] }));
};

const posted = [];
let oldServer = false;
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', d => { b += d; });
  req.on('end', () => {
    const held = req.url.startsWith('/api/queue-held');
    // `oldServer`: a server older than 0.144.0 has no /api/queue-held (404).
    if (held && oldServer) { res.writeHead(404); res.end('{}'); return; }
    if (held || req.url.startsWith('/api/dispatch')) { try { posted.push({ ...JSON.parse(b), url: req.url }); } catch { /* ignore */ } }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queued: true, position: 1, id: `q-test-${posted.length}`, ...(held ? { held: true } : {}) }));
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const CLASSIFY_LOG = path.join(T, 'classify.log');
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1',
  ORCH_PORT: String(srv.address().port), ORCH_NO_PENDING_RELEASE: '1', FAKE_CLAUDE_CLASSIFY_LOG: CLASSIFY_LOG,
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'r' }), ...FIXTURE_GIT_ENV };
for (const k of ['ANTHROPIC_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'ORCH_REQUEST_ID', 'FAKE_CLAUDE_CLASSIFY_MAP']) delete env[k];
const logOf = () => { try { return fs.readFileSync(path.join(LOGS, 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
// Asynchronous: the stand-in server answers from this process's event loop.
const drain = (text, extra = []) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', text, '--no-queue-if-busy', '--source', 'chef', ...extra], { env, windowsHide: true });
  let stderr = '';
  c.stderr.on('data', d => { stderr += d; });
  c.stdout.resume();
  const t = setTimeout(() => c.kill(), 120_000);
  c.on('close', (status) => { clearTimeout(t); resolve({ status, stderr }); });
});

try {
  // -------------------------------------------------------------------------
  section('1. queue-requeue.mjs : décision et relance (pur)');
  {
    const dirty = [' M app.mjs'];
    const h = RQ.startBlocker({ pausedRun: { run: RUN }, dirty });
    ok(h?.kind === 'paused-run' && h.run === RUN && h.durable === false && /en pause/.test(h.why), 'exécution en pause + copie non propre ⇒ retenue (passagère)', JSON.stringify(h));
    ok(RQ.startBlocker({ pausedRun: { run: RUN }, dirty: [] }) === null, 'exécution en pause, copie propre ⇒ rien n’est retenu');
    const d = RQ.startBlocker({ dirty, needsClean: true });
    ok(d?.kind === 'dirty' && d.durable === true && /app\.mjs/.test(d.why), 'copie non propre sans exécution en pause, pipeline qui l’exige ⇒ retenue durable', JSON.stringify(d));
    ok(RQ.startBlocker({ dirty, needsClean: false }) === null && RQ.startBlocker({ dirty }) === null, 'pipeline qui n’exige pas une copie propre ⇒ rien');
    ok(RQ.cleanHeldBy({ kind: 'paused-run', run: 'x' }) === null && RQ.cleanHeldBy({ kind: 'autre' }) === null && RQ.cleanHeldBy(null) === null, 'heldBy invalide refusé');
    const c = RQ.cleanHeldBy({ kind: 'paused-run', run: RUN, lane: 0, why: 'w', durable: false, extra: 1 });
    ok(c && c.run === RUN && !('extra' in c) && typeof c.at === 'string', 'heldBy validé, champs inconnus retirés, daté');
    writeRun('paused');
    ok(RQ.heldBlocks({ heldBy: c }, { logsDir: LOGS, reason: 'result' }).blocked, 'exécution toujours en pause ⇒ tête retenue, même sur un result');
    for (const st of ['done', 'abandoned', 'failed']) { writeRun(st); ok(!RQ.heldBlocks({ heldBy: c }, { logsDir: LOGS }).blocked, `exécution « ${st} » ⇒ tête libérée`); }
    const now = Date.now();
    const dh = { heldBy: { kind: 'dirty', at: new Date(now).toISOString() } };
    ok(RQ.heldBlocks(dh, { logsDir: LOGS, now: now + 1000, reason: 'sweep', retryMs: 60_000 }).blocked, 'retenue durable : pas de nouvel essai avant son délai');
    ok(!RQ.heldBlocks(dh, { logsDir: LOGS, now: now + 61_000, reason: 'sweep', retryMs: 60_000 }).blocked, '… nouvel essai après son délai');
    ok(!RQ.heldBlocks(dh, { logsDir: LOGS, now: now + 1000, reason: 'result' }).blocked, '… et à la fin d’un tour du musicien');
    ok(!RQ.heldBlocks({}, { logsDir: LOGS }).blocked, 'entrée non retenue : jamais bloquée');
  }

  // -------------------------------------------------------------------------
  section('2. Rejeu du cas réel : exécution en pause, la tête de file revient en tête');
  writeRun('paused');
  fs.writeFileSync(path.join(P, 'app.mjs'), 'export const v = 2; // travail de l’exécution en pause\n');
  {
    const n0 = logOf().length;
    const r = await drain('Précision de l’utilisateur sur le processus : les réponses se complètent', ['--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple']);
    const evs = logOf().slice(n0);
    const p = posted.at(-1);
    ok(r.status === 0, 'dispatch sort en 0 (aucun refus)', `${r.status}\n${r.stderr}`);
    ok(p?.url === '/api/queue-held' && p.front === true && p.heldBy?.kind === 'paused-run' && p.heldBy.run === RUN, 'remise EN TÊTE de file (route /api/queue-held), retenue par l’exécution en pause', JSON.stringify(p));
    ok(p?.pipeline === 'dev' && p.pipelineMode === 'leger' && /les réponses se complètent/.test(p.prompt), 'la tâche garde son texte et son pipeline');
    ok(!evs.some(e => e.type === 'user_prompt' || e.type === 'result'), 'aucune demande ni result écrit : rien n’est lancé, rien n’est refusé', JSON.stringify(evs));
    ok(evs.some(e => e.type === 'notification' && e.subtype === 'queue_entry_held' && e.held?.run === RUN && e.held.front === true), 'notification queue_entry_held dans le journal du musicien');
    ok(!evs.some(e => /modifications non commitées/.test(JSON.stringify(e))), 'plus jamais « modifications non commitées » pour cette tâche');
    // Same with a task the classifier would have to classify: held BEFORE any model call.
    try { fs.rmSync(CLASSIFY_LOG, { force: true }); } catch {}
    const r2 = await drain('tout à fait, les réponses se complètent');
    ok(r2.status === 0 && posted.at(-1)?.heldBy?.kind === 'paused-run' && !posted.at(-1).pipeline, 'tâche suivante (sans pipeline choisi) : retenue aussi', `${r2.status}\n${r2.stderr}`);
    ok(!fs.existsSync(CLASSIFY_LOG) || !fs.readFileSync(CLASSIFY_LOG, 'utf8').trim(), 'aucun appel au model de classement pour une tâche retenue');
    const st = JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', RUN, 'run.json'), 'utf8'));
    ok(st.status === 'paused', 'l’exécution en pause n’est pas touchée');
  }

  // -------------------------------------------------------------------------
  section('2b. Serveur antérieur à 0.144.0 (sans /api/queue-held) : jamais de boucle');
  oldServer = true;
  {
    const before = posted.length, n0 = logOf().length;
    const r = await drain('Ajoute une option', ['--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple']);
    ok(!posted.slice(before).some(p => p.url === '/api/dispatch'), 'la tâche n’est jamais renvoyée par /api/dispatch (un ancien serveur la relancerait sans fin)');
    ok(r.status !== 0 && logOf().slice(n0).some(e => e.subtype === 'error_pipeline_refused') && /antérieur à 0\.144\.0/.test(r.stderr), 'refus visible d’avant, avec la raison (redémarrage nécessaire)', r.stderr);
  }
  oldServer = false;

  // -------------------------------------------------------------------------
  section('3. Copie non propre sans exécution en pause : retenue durable');
  writeRun('done');
  {
    const n0 = logOf().length;
    const r = await drain('Ajoute une option', ['--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple']);
    const p = posted.at(-1);
    ok(r.status === 0 && p?.front === true && p.heldBy?.kind === 'dirty' && p.heldBy.durable === true, 'remise en tête, retenue durable (copie à ranger)', `${r.status} ${JSON.stringify(p)}\n${r.stderr}`);
    ok(!logOf().slice(n0).some(e => e.type === 'result'), 'aucun refus écrit');
  }

  // -------------------------------------------------------------------------
  section('4. Jamais retenu : une réponse à la pause, une copie propre');
  writeRun('paused');
  {
    const before = posted.length;
    await drain('continuer', []);
    ok(!posted.slice(before).some(p => p.heldBy), '« continuer » reprend l’exécution en pause : jamais retenu');
  }
  g('checkout', '--', 'app.mjs');
  writeRun('done');
  {
    const before = posted.length;
    const r = await drain('Ajoute une option', ['--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple']);
    ok(!posted.slice(before).some(p => p.heldBy), 'copie propre : la tâche part normalement', r.stderr);
    ok(logOf().some(e => e.type === 'user_prompt' && /Ajoute une option/.test(e.text || '')), '… et son tour s’ouvre dans le journal');
  }

  // -------------------------------------------------------------------------
  section('5. Alerte du chef : cause durable seulement, une fois par tâche');
  {
    const since = new Date(Date.now() - 60_000).toISOString();
    const at = new Date().toISOString();
    const queues = [{ project: 'P', entries: [
      { id: 'q-1', taskId: TASK, prompt: 'Précision…', heldBy: { kind: 'dirty', durable: true, why: 'copie à ranger', at } },
      { id: 'q-2', prompt: 'Autre', heldBy: { kind: 'paused-run', run: RUN, durable: false, why: 'pause', at } },
      { id: 'q-3', prompt: 'Normale' },
    ] }];
    const a = CA.queueAlerts({ queues, since });
    ok(a.length === 1 && a[0].kind === 'queue' && a[0].queue.taskId === TASK && /copie à ranger/.test(CA.alertLine(a[0], 0)), 'une alerte, pour la retenue durable seulement', JSON.stringify(a));
    const again = CA.queueAlerts({ queues: [{ project: 'P', entries: [{ ...queues[0].entries[0], id: 'q-9' }] }], since });
    ok(again[0]?.key === a[0].key, 'clé stable d’une remise en file à l’autre (nouvel id de file) : signalée une fois');
    ok(CA.queueAlerts({ queues, since: new Date(Date.now() + 60_000).toISOString() }).length === 0, 'avant l’activation des alertes : rien');
    ok(CA.KINDS.includes('queue') && /tâche\(s\) de file retenue/.test(CA.alertSummary(a)), 'type `queue` déclaré, résumé du réveil');
  }

  // -------------------------------------------------------------------------
  section('6. server.js : file, route et drain');
  {
    const s = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(/function queuePush\(name, entry, \{ front = false \} = \{\}\)/.test(s) && /q\.unshift\(e\)/.test(s), 'queuePush({front}) : remise en tête');
    ok(/app\.post\('\/api\/queue-held'/.test(s) && /heldBy: \(req\.orchHeld && QueueRequeue\.cleanHeldBy\(req\.body\?\.heldBy\)\)/.test(s) && /busy \|\| entry\.exclusive \|\| entry\.heldBy/.test(s),
      'POST /api/queue-held : heldBy validé, toujours mis en file ; /api/dispatch seul ne le prend jamais');
    ok((s.match(/queueHeadHeld\(name, q\[0\], reason\)/g) || []).length === 2 && /QueueRequeue\.heldBlocks\(q\[0\]/.test(s), 'drain et balayage : la tête retenue ne part pas');
    ok(/ChefAlerts\.queueAlerts\(/.test(s), 'balayage des alertes du chef : tâches retenues');
  }
} finally {
  srv.close();
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
