#!/usr/bin/env node
// ============================================================================
// scripts/_test_queue_edit.mjs — a waiting queue entry is editable; the edited
// text is what runs; once started it no longer is (0.89.0)
// ============================================================================
// User request (2026-10-13, verbatim): « il faut pouvoir drag & drop les
// éléments de la file d'attente, et que celà ai un impacte sur l'ordre de
// traitement. Les éléments de la file d'attente doivent être clickable pour
// voir leurs détails, tant qu'ils ne sont pas traités ils sont éditables ».
// This suite covers « tant qu'ils ne sont pas traités ils sont éditables »:
// 1. The edit rule (scripts/queue-order.mjs): text validated, entry edited in
//    place (other fields untouched), an id no longer queued is refused.
// 2. End to end on a PRIVATE instance of the real server.js (own port, own
//    fixtures, fake claude): an entry queued behind a busy musician is edited
//    through POST /api/queue/alpha/<id>, the sidecar follows, the musician is
//    freed — the EDITED text is the one that runs, never the original; once
//    started, the same edit is refused (409). Nothing touches the shared test
//    instance or production.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cleanQueueText, editQueueEntry, QUEUE_TEXT_MAX } from './queue-order.mjs';

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}${d ? `\n      ${String(d).slice(0, 600)}` : ''}`); } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.status || -1; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('── 1. Edit rule');
const q = [{ id: 'a', prompt: 'avant', model: 'm', callback: 'chef' }, { id: 'b', prompt: 'autre' }];
let r = editQueueEntry(q, 'a', 'après');
ok(r?.changed && q[0].prompt === 'après' && q[0].model === 'm' && q[0].callback === 'chef' && q[0].edits === 1 && q[0].editedAt, 'texte remplacé, autres champs intacts, modification datée');
ok(editQueueEntry(q, 'a', 'après').changed === false && q[0].edits === 1, 'même texte : rien ne change');
ok(editQueueEntry(q, 'parti', 'x') === null, 'entrée qui n’est plus en file : refusée');
ok(q[1].prompt === 'autre', 'les autres entrées ne bougent pas');
ok(cleanQueueText('a\r\nb') === 'a\nb', 'fins de ligne normalisées');
ok(throws(() => cleanQueueText('   ')) === 400 && throws(() => cleanQueueText(3)) === 400, 'texte vide ou absent : 400');
ok(throws(() => cleanQueueText('x'.repeat(QUEUE_TEXT_MAX + 1))) === 413, 'texte trop long : 413');

console.log('\n── 2. End to end: the edited text is what runs (private server instance)');
process.env.ORCH_QUEUE_SWEEP_MS = '500';
process.env.ORCH_QUEUE_STALL_MS = '1000';
const { startSandbox } = await import('./_regression_sandbox.mjs');
const sb = await startSandbox({ worktree: true }, 'queue-edit');
const H = { 'X-Orchestrator-Token': sb.token, 'Content-Type': 'application/json' };
const api = (p, opts = {}) => fetch(sb.url + p, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
const logs = path.join(sb.root, 'logs');
const keep = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
try {
  fs.writeFileSync(path.join(logs, 'alpha.pid'), String(keep.pid));
  const ORIG = 'EDITION-RECETTE-ORIGINAL : texte à remplacer';
  const EDIT = 'EDITION-RECETTE-MODIFIE : texte remplacé\n\nsur plusieurs lignes';
  const d = await api('/api/dispatch', { method: 'POST', body: JSON.stringify({ project: 'alpha', prompt: ORIG, queueIfBusy: true, callback: 'chef' }) });
  const dj = await d.json();
  const id = dj.id;
  ok(d.status === 202 && dj.queued === true, 'entrée mise en file derrière le musicien occupé', JSON.stringify(dj));
  const e1 = await api(`/api/queue/alpha/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ text: EDIT }) });
  const j1 = await e1.json();
  ok(e1.status === 200 && j1.ok && j1.changed && j1.entry?.text === EDIT && j1.entry.edits === 1 && j1.entry.callback === 'chef', 'modification acceptée tant que l’entrée attend (autres champs gardés)', JSON.stringify(j1));
  const mem = (await (await api('/api/queue/alpha')).json()).entries.find(e => e.id === id);
  ok(mem?.text === EDIT && mem.editedAt, 'la file du serveur (mémoire) porte le texte modifié');
  const side = JSON.parse(fs.readFileSync(path.join(logs, 'queue', 'alpha.json'), 'utf8')).find(e => e.id === id);
  ok(side?.prompt === EDIT, 'le fichier de la file est réécrit par le serveur avec le texte modifié');
  ok((await api(`/api/queue/alpha/${encodeURIComponent(id)}`, { method: 'POST', headers: { Origin: 'http://evil.example' }, body: JSON.stringify({ text: 'x' }) })).status === 403, 'autre origine : 403');
  ok((await api(`/api/queue/alpha/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ text: '  ' }) })).status === 400, 'texte vide : 400, rien de changé');
  ok((await api('/api/queue/projet-inconnu/x', { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status === 404, 'projet inconnu : 404');
  const none = await api('/api/queue/alpha/q-inexistant', { method: 'POST', body: JSON.stringify({ text: 'x' }) });
  ok(none.status === 409 && (await none.json()).alreadyStarted === true, 'entrée inconnue ou partie : 409');

  // Free the musician: the server drains its queue.
  keep.kill();
  const prompts = () => {
    let lines = [];
    try { lines = fs.readFileSync(path.join(logs, 'alpha.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch {}
    return lines.filter(e => e.type === 'user_prompt').map(e => String(e.text || ''));
  };
  const t0 = Date.now();
  while (!prompts().some(t => t.includes('EDITION-RECETTE')) && Date.now() - t0 < 90_000) await sleep(500);
  const ran = prompts().filter(t => t.includes('EDITION-RECETTE'));
  ok(ran.length === 1 && ran[0].includes(EDIT) && !ran[0].includes('ORIGINAL'), `c’est la version modifiée qui est lancée (${ran.length} tour(s))`, ran.join(' | ').slice(0, 300));
  const after = await api(`/api/queue/alpha/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ text: 'trop tard' }) });
  const aj = await after.json();
  ok(after.status === 409 && aj.alreadyStarted === true, 'une fois démarrée : modification refusée (409)', JSON.stringify(aj));
  ok(!prompts().some(t => t.includes('trop tard')), 'la modification refusée n’a rien lancé');
} finally {
  try { keep.kill(); } catch {}
  await sb.stop();
  fs.rmSync(sb.root, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
