#!/usr/bin/env node
// ============================================================================
// scripts/_test_request_map.mjs — each user request, its atomic tasks, and the
// state of every task now, even detached ones (0.100.0)
// ============================================================================
//
// User request (2026-10-14), verbatim: « Je parle de voir comment une requete
// utilisateur a ete decoupee en taches atomiques, et voir le progres de ces
// taches, meme detachees. On avait fait le contstat qu'elles n'etaient pas
// visible actuellement ».
//
// Protected:
//   1. a request (Routage run) is linked to ALL its tasks, with their title,
//      musician, dependency (« après ») and dependency level (map column);
//   2. the state of each task is read where the task is NOW: finished turn,
//      running turn of a task released later (detached), waiting list, queue,
//      hand-back to the chef refused, question, paused pipeline run (with its
//      progress), failed / interrupted turn, duplicate, chef action;
//   3. a waiting task released by the real releaseReady is traced
//      (routage-released.ndjson) and followed to its end;
//   4. the list: newest first, wake-ups excluded, relays told apart;
//   5. the routes (GET only) and the side-panel tab are wired.
//
//   node scripts/_test_request_map.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as RM from './request-map.mjs';
import * as RP from './routage-pending.mjs';
import { writeRequestFixture, REQ_RUN, RELAY_RUN, NOTASK_RUN, CALLBACK_RUN, EXPECTED, MUS_A, MUS_B } from '../tests/request-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-requests-'));
const LOGS = path.join(T, 'logs'), CHEF = path.join(T, 'chef');
fs.mkdirSync(LOGS, { recursive: true }); fs.mkdirSync(CHEF, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', projects: [{ name: 'chef', path: CHEF }, { name: 'alpha', path: T }, { name: 'omega', path: T }] }));
const fx = writeRequestFixture({ logsDir: LOGS, chefDir: CHEF });
const get = () => RM.buildRequest(T, { logsDir: LOGS, run: REQ_RUN });
const task = (r, n) => r.tasks.find(t => t.n === n);

// ---------------------------------------------------------------------------
section('1. La requête et toutes ses tâches');
{
  const r = get();
  ok(r && r.request.startsWith('REQ-FIX-REQUEST') && /REQ-FIX-SENS/.test(r.sens) && r.origin === 'utilisateur', 'requête d’origine et ce que le chef a compris', JSON.stringify(r && { req: r.request, sens: r.sens }));
  ok(r.total === 7 && r.tasks.map(t => t.n).join() === '1,2,3,4,5,6,7', 'les 7 tâches du découpage, dans l’ordre');
  ok(r.tasks.every(t => t.titre && t.projet && t.demande.startsWith('REQ-FIX tâche')), 'titre, musicien et demande complète de chaque tâche');
  ok(Object.entries(EXPECTED).every(([n, e]) => task(r, +n).level === e.level), 'niveau de dépendance : 1 → 2 → 3 en colonnes 0, 1, 2', r.tasks.map(t => `${t.n}:L${t.level}`).join(' '));
  ok(task(r, 3).apres === 2 && task(r, 2).apres === 1, 'dépendances « après » conservées');
  ok(r.questions.length === 1, 'questions posées par le Routage');
}

// ---------------------------------------------------------------------------
section('2. L’état de chaque tâche, là où elle est maintenant');
{
  const r = get();
  for (const [n, e] of Object.entries(EXPECTED)) ok(task(r, +n).state === e.state, `tâche ${n} : ${e.state} (${task(r, +n).detail})`, JSON.stringify(task(r, +n)));
  ok(/REQ-FIX-RESULT-1/.test(task(r, 1).excerpt || '') && task(r, 1).endedAt, 'terminée : résultat du tour, résultat fantôme ignoré');
  ok(task(r, 2).released === true && /REQ-FIX-PROGRESS-2/.test(task(r, 2).detail), 'détachée (libérée après la tâche 1) : son tour suivi en direct');
  ok(/tâche 2/.test(task(r, 3).detail) && task(r, 3).pendingId === fx.waiterId, 'en attente : ce qu’elle attend, son entrée dans la liste d’attente');
  ok(/position 1 sur 1/.test(task(r, 4).detail), 'en file : sa position dans la file du musicien');
  ok(/code 65/.test(task(r, 5).detail) && /REQ-FIX refus/.test(task(r, 5).detail), 'renvoi au chef refusé (chef-actions.log) : visible comme un échec, avec la raison');
  ok(/CSV ou JSON/.test(task(r, 6).detail), 'question : le texte de la question');
  const p = task(r, 7).pipelineRun;
  ok(p && p.done === 2 && p.steps === 5 && p.current === 'liste-tests' && /en pause/.test(task(r, 7).detail), 'pipeline en pause : progression 2/5 et étape courante', JSON.stringify(p));
  ok(r.tasks.every(t => t.stateLabel && t.tone), 'libellé et teinte de chaque état');
  ok(r.open === 5, `${r.open} tâche(s) pas encore finies (2, 3, 4, 6, 7)`);
}

// ---------------------------------------------------------------------------
section('3. Une tâche détachée suivie jusqu’au bout');
{
  // Task 2 finishes: its turn gets a result → finished, read later.
  fs.appendFileSync(path.join(LOGS, `${MUS_B}.jsonl`), JSON.stringify({ orch_turn: 't-fix-2', type: 'result', subtype: 'success', num_turns: 2, duration_api_ms: 40, result: 'REQ-FIX-DONE-2', timestamp: new Date().toISOString() }) + '\n');
  ok(task(get(), 2).state === 'terminee', 'la tâche détachée passe à « terminée » quand son tour finit');
  // Task 3 is now released by the REAL releaseReady (fake launcher): traced.
  const rec = [];
  const launch = (root, t) => { const offset = RP.logOffset(LOGS, t.projet); rec.push(t); return { projet: t.projet, titre: t.titre, pid: null, at: new Date().toISOString(), offset, key: RP.taskKey(t.demande), hash: RP.textHash(t.demande) }; };
  const out = RP.releaseReady({ root: T, logsDir: LOGS, dispatchScript: 'x', launch });
  ok(out.launched.length === 1 && rec[0]?.n === 3, 'releaseReady libère la tâche 3 (la tâche 2 a fini)', JSON.stringify(out));
  const line = fs.readFileSync(path.join(LOGS, RP.RELEASED_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(l => l.n === 3);
  ok(line && line.run === REQ_RUN && Number.isFinite(line.offset) && line.hash === RP.textHash(fx.tasks[2].demande), 'son lancement est gardé (routage-released.ndjson : run, n, offset, empreinte)', JSON.stringify(line));
  let t3 = task(get(), 3);
  ok(t3.state === 'introuvable' || t3.state === 'lancee', `libérée mais pas encore de tour : ${t3.state}`);
  fs.appendFileSync(path.join(LOGS, `${MUS_A}.jsonl`), [
    { orch_turn: 't-fix-3', type: 'user_prompt', text: fx.tasks[2].demande, source: 'chef', callback: 'chef', timestamp: new Date().toISOString() },
    { orch_turn: 't-fix-3', type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 3, duration_api_ms: 30, result: 'REQ-FIX-FAIL-3', timestamp: new Date().toISOString() },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  t3 = task(get(), 3);
  ok(t3.state === 'echouee' && t3.released === true, 'son tour lancé plus tard est retrouvé : « échouée »', JSON.stringify(t3));
}

// ---------------------------------------------------------------------------
section('4. Tour interrompu, doublon, action du chef, Routage en cours');
{
  // A turn without result followed by another turn of the same musician.
  const run = 'p-20261014T130000-abcdef';
  const D = 'REQ-FIX-INT tâche interrompue, texte complet';
  const off = RP.logOffset(LOGS, 'omega');
  fs.appendFileSync(path.join(LOGS, 'omega.jsonl'), [
    { orch_turn: 't-int', type: 'user_prompt', text: D, source: 'chef', timestamp: new Date().toISOString() },
    { orch_turn: 't-next', type: 'user_prompt', text: 'autre tour', timestamp: new Date().toISOString() },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.mkdirSync(path.join(LOGS, 'runs', run), { recursive: true });
  fs.mkdirSync(path.join(CHEF, '.orchestrateur', 'runs', run), { recursive: true });
  const tasks = [{ n: 1, projet: 'omega', titre: 'interrompue', demande: D, route: true }, { n: 2, projet: 'omega', titre: 'doublon', demande: 'x', route: true },
    { n: 3, projet: 'alpha', titre: 'redémarrage', demande: 'y', route: false, chefAction: 'restart-orchestrateur' }, { n: 4, projet: 'alpha', titre: 'pas encore', demande: 'z', route: true }];
  fs.writeFileSync(path.join(LOGS, 'runs', run, 'run.json'), JSON.stringify({ run, project: 'chef', pipeline: 'routage', mode: 'demande', status: 'running', request: 'REQ-FIX-2', tasks, createdAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(CHEF, '.orchestrateur', 'runs', run, 'dispatch.json'), JSON.stringify({ dispatched: [{ n: 1, projet: 'omega', offset: off, hash: RP.textHash(D), at: new Date().toISOString(), pid: null }],
    duplicates: [{ n: 2, reason: 'même travail déjà en attente', keptId: 'abcd1234', keptTitre: 'gardée' }], actions: [{ action: 'restart-orchestrateur', status: 'scheduled' }] }));
  const r = RM.buildRequest(T, { logsDir: LOGS, run });
  ok(task(r, 1).state === 'arretee' && /interrompu/.test(task(r, 1).detail), 'tour sans résultat suivi d’un autre tour : « arrêtée », interrompu');
  ok(task(r, 2).state === 'doublon' && /abcd1234/.test(task(r, 2).detail), 'doublon écarté : la tâche gardée');
  ok(task(r, 3).state === 'action' && /programmée/.test(task(r, 3).detail), 'action du chef : programmée');
  ok(task(r, 4).state === 'a_dispatcher', 'Routage encore en cours : « pas encore dispatchée »');
  fs.rmSync(path.join(LOGS, 'runs', run), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('5. La liste des requêtes');
{
  const list = RM.listRequests(T, { logsDir: LOGS, limit: 10 });
  const runs = list.map(r => r.run);
  ok(runs[0] === REQ_RUN && runs.indexOf(RELAY_RUN) < runs.indexOf(NOTASK_RUN), 'la plus récente d’abord', runs.join(' '));
  ok(!runs.includes(CALLBACK_RUN), 'les réveils du chef ne sont pas des requêtes');
  ok(list.find(r => r.run === RELAY_RUN)?.origin === 'relais' && list.find(r => r.run === NOTASK_RUN)?.total === 0, 'relais repéré ; requête sans tâche gardée (filtrée par l’affichage)');
  ok(RM.listRequests(T, { logsDir: LOGS, limit: 1 }).length === 1, 'limite respectée');
}

// ---------------------------------------------------------------------------
section('6. Routes et onglet du dashboard');
{
  const S = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/app\.get\('\/api\/requests'/.test(S) && /app\.get\('\/api\/requests\/:run'/.test(S) && !/app\.(post|put|delete)\('\/api\/requests/.test(S), 'GET /api/requests et /api/requests/:run, aucune route d’écriture');
  const H = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  ok(/id="btn-requests"[^>]*data-sp-open="requests"/.test(H) && /requests-panel\.js/.test(H), 'pill « 🧭 Requêtes » et script de l’onglet');
  const P = fs.readFileSync(path.join(ROOT, 'public', 'requests-panel.js'), 'utf8');
  ok(/SidePanel\.register\(\{\s*id: "requests"/.test(P) && /fetch\("\/api\/requests/.test(P) && !/method:\s*"(POST|PUT|DELETE)"/.test(P), 'onglet du panneau, lecture seule');
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
