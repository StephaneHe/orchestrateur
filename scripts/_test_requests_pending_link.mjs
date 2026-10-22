#!/usr/bin/env node
// ============================================================================
// scripts/_test_requests_pending_link.mjs — a Routage task released later by
// routage-pending is attached to its ORIGINAL request (Routage v3, phase 2)
// ============================================================================
//
// User decision of 2026-10-22 (« vas y »): « Reprends aussi la limite connue de
// la phase 1 : une tâche libérée plus tard par routage-pending doit être
// rattachée à sa demande d'origine dans le registre ».
//
// Protected (real dispatch.mjs, real Routage engine, fake claude, private root):
//   1. a task that waits for another (« apres ») is a task of the chef turn's
//      request as soon as the Routage decides it (`en_attente_de`), and its
//      pending entry carries its task id;
//   2. its release launches it with `--task-id` (never the releasing turn's
//      ORCH_REQUEST_ID): the request follows it to its result, `terminée`;
//   3. while it waits, the request stays `suivie`; a pending entry blocked by a
//      failed predecessor ⇒ `à_traiter`; dropped from the pending file ⇒
//      `annulée`; `requests.mjs cancel` drops the pending entry too.
//
//   node scripts/_test_requests_pending_link.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RQ from './requests.mjs';
import * as RP from './routage-pending.mjs';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (pred, ms = 90_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (pred()) return true; } catch {} await sleep(250); } return false; };

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pendlink-'));
const LOGS = path.join(T, 'logs');
for (const d of ['logs', 'chef', 'P', 'Q']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n');
fs.writeFileSync(path.join(LOGS, 'no-failover'), '');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude', maxParallel: 1 },
  projects: ['chef', 'P', 'Q'].map(n => ({ name: n, path: path.join(T, n) })),
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: { 'routage.lire': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' },
    'routage.decomposer': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'routage.rapporter': { provider: 'anthropic', model: 'claude-haiku-5-5' } },
}, null, 2));
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|TURN_ID|REQUEST_ID|NO_PENDING_RELEASE)$|^DISPATCH_(SLOT|TICKET|REPORT_ONLY)$|^CODEX_HOME$/.test(k)) delete env[k];
const dispatch = (args, extra = {}) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 180_000, windowsHide: true }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }; };
const logOf = (n) => { try { return fs.readFileSync(path.join(LOGS, `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

try {
  section('1. Une tâche « apres » est inscrite dans la demande du tour du chef dès le Routage');
  const tasks = [
    { projet: 'P', titre: 'd’abord sur P', demande: 'Explique en une phrase ce que fait P (lecture seule).' },
    { projet: 'Q', titre: 'ensuite sur Q', demande: 'Puis explique en une phrase ce que fait Q (lecture seule).', apres: 1 },
  ];
  const x = dispatch(['chef', 'Explique P, puis Q.'], { FAKE_PIPE_JSON: JSON.stringify({ comprendre: { sens: 's', nature: 'taches', raison: 'deux projets, dans l’ordre' }, decomposer: { taches: tasks } }) });
  const req = RQ.listRequests(LOGS).find(r => r.text === 'Explique P, puis Q.');
  ok(x.code === 0 && req, `tour du chef (Routage) fini, demande ${req?.id}`, x.out.slice(-800));
  const tQ = req?.tasks.find(t => t.projet === 'Q');
  const pend = RP.readPending(LOGS);
  ok(tQ && ['en_attente_de', 'lancée', 'en_cours', 'réussie'].includes(tQ.state) && tQ.waitsFor?.projet === 'P', `la tâche de Q est une tâche de la demande (${tQ?.state}, attend P)`, JSON.stringify(req?.tasks));
  ok(!pend.length || pend[0].taskId === tQ.id && pend[0].request === req.id, 'l’entrée d’attente porte son identifiant de tâche et sa demande');

  section('2. Libérée à la fin du tour de P : lancée avec --task-id, suivie jusqu’à son résultat');
  const launched = await waitFor(() => logOf('Q').some(e => e.type === 'user_prompt' && e.taskId === tQ.id));
  ok(launched, `le tour de Q porte taskId ${tQ.id} (accusé de réception)`, JSON.stringify(logOf('Q').filter(e => e.type === 'user_prompt')));
  await waitFor(() => logOf('Q').some(e => e.type === 'result'));
  await waitFor(() => { RQ.reconcile({ root: T, logsDir: LOGS }); return RQ.readRequest(LOGS, req.id).state === 'terminée'; }, 30_000);
  const r2 = RQ.readRequest(LOGS, req.id);
  const q2 = r2.tasks.find(t => t.n === tQ.n);
  ok(q2.state === 'réussie' && q2.releasedAt && q2.history.some(h => /libérée/.test(h.why || '')), `tâche de Q : ${q2.state}, libérée à ${q2.releasedAt}`, JSON.stringify(q2.history));
  ok(r2.state === 'terminée' && r2.tasks.length === 2, `la demande d’origine se termine avec ses deux tâches (${r2.state})`);
  ok(RQ.listRequests(LOGS).filter(r => r.tasks.some(t => t.projet === 'Q')).length === 1, 'la tâche n’est rattachée à aucune autre demande (ni au tour qui l’a libérée)');

  section('3. En attente : suivie ; prédécesseur en échec ⇒ à traiter ; retirée ⇒ annulée ; cancel retire l’entrée');
  const mk = (txt) => {
    const r = RQ.createRequest(LOGS, { project: 'chef', text: txt });
    // As in a real chef turn: the waiter is registered DURING the turn, then the turn ends.
    RQ.startTurn(LOGS, r.id, { turn: 'turn-x', pid: 999999, log: path.join(LOGS, 'chef.jsonl') });
    const t = RQ.addTask(LOGS, r.id, { projet: 'Q', demande: `${txt} — tâche de Q`, state: 'en_attente_de', waitsFor: { projet: 'P' } });
    RP.addPending(LOGS, [{ projet: 'Q', demande: `${txt} — tâche de Q`, served: false, after: { projet: 'P', offset: 1e12, hash: 'x'.repeat(32) }, request: r.id, taskId: t.id }]);
    RQ.finishTurn(LOGS, r.id, { turn: 'turn-x', result: { type: 'result', is_error: false, result: 'ok' } });
    return { r, t, entry: RP.readPending(LOGS).find(e => e.taskId === t.id) };
  };
  const a = mk('attente simple');
  RQ.reconcile({ root: T, logsDir: LOGS, alive: () => false });
  ok(RQ.readRequest(LOGS, a.r.id).state === 'suivie' && RQ.readRequest(LOGS, a.r.id).tasks[0].state === 'en_attente_de', 'en attente : la demande est « suivie », jamais « à traiter » au bout de 2 min');
  const b = mk('prédécesseur en échec');
  const all = RP.readPending(LOGS).map(e => e.taskId === b.t.id ? { ...e, blocked: new Date().toISOString() } : e);
  RP.writePending(LOGS, all);
  RQ.reconcile({ root: T, logsDir: LOGS, alive: () => false });
  ok(RQ.readRequest(LOGS, b.r.id).tasks[0].state === 'à_traiter' && /échoué/.test(RQ.readRequest(LOGS, b.r.id).tasks[0].error.why), 'entrée bloquée (prédécesseur en échec) : à traiter, avec les commandes');
  const c = mk('retirée');
  RP.dropPending(LOGS, { ids: [c.entry.id] });
  RQ.reconcile({ root: T, logsDir: LOGS, alive: () => false });
  ok(RQ.readRequest(LOGS, c.r.id).tasks[0].state === 'annulée', 'retirée de l’attente sans libération : annulée');
  const d = mk('annulée par commande');
  const res = RQ.cmdCancel({ logsDir: LOGS, id: d.t.id });
  ok(res.ok && !RP.readPending(LOGS).some(e => e.taskId === d.t.id), 'requests.mjs cancel : la tâche est annulée ET son entrée d’attente retirée');
  ok(RQ.readRequest(LOGS, a.r.id).tasks[0].state === 'en_attente_de', 'les autres attentes ne bougent pas');
} finally {
  await sleep(500);
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
