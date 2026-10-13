#!/usr/bin/env node
// ============================================================================
// scripts/_test_queue_order.mjs — the order dropped in a musician's queue is
// the order of execution (0.86.0)
// ============================================================================
// User request (2026-10-13, verbatim): « il faut pouvoir drag & drop les
// éléments de la file d'attente, et que celà ai un impacte sur l'ordre de
// traitement. »
// 1. The merge rule (scripts/queue-order.mjs): posted order first, entries
//    launched meanwhile ignored, new arrivals kept after — no loss, no dup.
// 2. End to end on a PRIVATE instance of the real server.js (own port, own
//    fixtures, fake claude): three tasks queued behind a busy musician are
//    reordered through POST /api/queue/alpha/order, the sidecar follows, then
//    the musician is freed and the server drains: the turns start in the
//    dropped order. Nothing touches the shared test instance or production.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cleanQueueIds, reorderQueue, QUEUE_ORDER_MAX } from './queue-order.mjs';

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}${d ? `\n      ${String(d).slice(0, 600)}` : ''}`); } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.status || -1; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('── 1. Merge rule');
const E = (id) => ({ id, prompt: id });
const ids = (list) => list.map(e => e.id).join(' ');
let r = reorderQueue([E('a'), E('b'), E('c')], ['c', 'a', 'b']);
ok(ids(r.entries) === 'c a b' && r.changed && !r.missing.length && !r.appended.length, `ordre déposé appliqué : ${ids(r.entries)}`);
r = reorderQueue([E('a'), E('b'), E('c')], ['a', 'b', 'c']);
ok(!r.changed, 'même ordre : rien ne change');
r = reorderQueue([E('b'), E('c'), E('d')], ['c', 'a', 'b']);   // a launched meanwhile, d arrived
ok(ids(r.entries) === 'c b d' && r.missing.join() === 'a' && r.appended.join() === 'd', `parti entre-temps ignoré, arrivé entre-temps gardé après : ${ids(r.entries)}`);
ok(r.entries.length === 3 && new Set(r.entries.map(e => e.id)).size === 3, 'aucune perte, aucun doublon');
ok(JSON.stringify(cleanQueueIds(['q-1', 'q-2', 'q-1'])) === '["q-1","q-2"]', 'doublon dans la demande retiré');
ok(throws(() => cleanQueueIds('q-1')) === 400 && throws(() => cleanQueueIds(['../x'])) === 400 && throws(() => cleanQueueIds([3])) === 400, 'demande invalide : 400');
ok(throws(() => cleanQueueIds(new Array(QUEUE_ORDER_MAX + 1).fill('q-1'))) === 413, 'demande trop longue : 413');

console.log('\n── 2. End to end: the dropped order is the order of execution (private server instance)');
process.env.ORCH_QUEUE_SWEEP_MS = '500';
process.env.ORCH_QUEUE_STALL_MS = '1000';
const { startSandbox } = await import('./_regression_sandbox.mjs');
const sb = await startSandbox({ worktree: true }, 'queue-order');
const H = { 'X-Orchestrator-Token': sb.token, 'Content-Type': 'application/json' };
const api = (p, opts = {}) => fetch(sb.url + p, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
const logs = path.join(sb.root, 'logs');
const keep = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
try {
  fs.writeFileSync(path.join(logs, 'alpha.pid'), String(keep.pid));
  const texts = ['ORDRE-RECETTE-A', 'ORDRE-RECETTE-B', 'ORDRE-RECETTE-C'];
  const qids = [];
  for (const t of texts) {
    const d = await api('/api/dispatch', { method: 'POST', body: JSON.stringify({ project: 'alpha', prompt: t, queueIfBusy: true }) });
    const j = await d.json();
    qids.push(j.id);
    ok(d.status === 202 && j.queued === true, `« ${t} » mis en file derrière le musicien occupé`, JSON.stringify(j));
  }
  const want = [qids[2], qids[0], qids[1]];   // C, A, B
  const o = await api('/api/queue/alpha/order', { method: 'POST', body: JSON.stringify({ ids: want }) });
  const oj = await o.json();
  ok(o.ok && oj.changed && oj.entries.map(e => e.id).join() === want.join(), `ordre déposé accepté : ${oj.entries?.map(e => e.head).join(' › ')}`, JSON.stringify(oj));
  const mem = (await (await api('/api/queue/alpha')).json()).entries.map(e => e.id);
  ok(mem.join() === want.join(), 'la file du serveur (mémoire) suit l’ordre déposé');
  const side = JSON.parse(fs.readFileSync(path.join(logs, 'queue', 'alpha.json'), 'utf8')).map(e => e.id);
  ok(side.join() === want.join(), 'le fichier de la file est réécrit dans le même ordre (jamais édité à la main)');
  ok((await api('/api/queue/alpha/order', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: JSON.stringify({ ids: want }) })).status === 403, 'autre origine : 403');
  ok((await api('/api/queue/projet-inconnu/order', { method: 'POST', body: JSON.stringify({ ids: want }) })).status === 404, 'projet inconnu : 404');

  // Free the musician: the server drains its queue, head first.
  keep.kill();
  const started = () => {
    let lines = [];
    try { lines = fs.readFileSync(path.join(logs, 'alpha.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch {}
    return lines.filter(e => e.type === 'user_prompt' && texts.some(t => String(e.text || '').includes(t))).map(e => texts.find(t => e.text.includes(t)));
  };
  const t0 = Date.now();
  while (started().length < 3 && Date.now() - t0 < 90_000) await sleep(500);
  const order = started();
  ok(order.join(' › ') === 'ORDRE-RECETTE-C › ORDRE-RECETTE-A › ORDRE-RECETTE-B', `tours lancés dans l’ordre déposé : ${order.join(' › ') || '(aucun)'}`);
  const left = (await (await api('/api/queue/alpha')).json()).count;
  ok(left === 0, `file vidée par l’exécution, rien de perdu ni de relancé deux fois (${left} restant)`);
} finally {
  try { keep.kill(); } catch {}
  await sb.stop();
  fs.rmSync(sb.root, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
