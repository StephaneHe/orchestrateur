// tests/request-fixture.mjs — one user request to the chef, split by the
// Routage into tasks that each sit in a different place now (0.100.0). Shared
// by _test_request_map.mjs, the HTTP check « requests-map » and the browser
// check « requests-panel ». Writes only under `logsDir` and `chefDir`, with
// the real file formats (run.json, dispatch.json, routage-pending.json,
// routage-released.ndjson, queue file, musicians' logs, chef-actions.log).
import fs from 'node:fs';
import path from 'node:path';
import { textHash, taskKey, pendingId, RELEASED_FILE, PENDING_FILE } from '../scripts/routage-pending.mjs';

export const REQ_RUN = 'p-20261014T120000-a1b2c3';
export const PIPE_RUN = 'p-20261014T120500-d4e5f6';
export const CALLBACK_RUN = 'p-20261014T121000-0a0b0c';
export const RELAY_RUN = 'p-20261014T110000-1a2b3c';
export const NOTASK_RUN = 'p-20261014T100000-9f8e7d';

/** Expected state of each task of REQ_RUN, by number. */
export const EXPECTED = {
  1: { state: 'terminee', level: 0 },
  2: { state: 'en_cours', level: 1, released: true },
  3: { state: 'attente', level: 2 },
  4: { state: 'file', level: 0 },
  5: { state: 'echouee', level: 0 },
  6: { state: 'question', level: 0 },
  7: { state: 'pause', level: 0 },
};

const iso = (min) => new Date(Date.UTC(2026, 9, 14, 12, min)).toISOString();
const append = (file, events) => { const at = fs.existsSync(file) ? fs.statSync(file).size : 0; fs.appendFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n'); return at; };
const size = (file) => (fs.existsSync(file) ? fs.statSync(file).size : 0);

export const MUS_A = 'req-a';
export const MUS_B = 'req-b';

export function writeRequestFixture({ logsDir, chefDir, chef = 'chef', a = MUS_A, b = MUS_B }) {
  fs.mkdirSync(path.join(logsDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(logsDir, 'queue'), { recursive: true });
  const art = path.join(chefDir, '.orchestrateur', 'runs', REQ_RUN);
  fs.mkdirSync(art, { recursive: true });
  const D = (n, s) => `REQ-FIX tâche ${n} : ${s}. Demande complète et autonome confiée au musicien.`;
  const tasks = [
    { n: 1, projet: a, titre: 'export CSV', demande: D(1, 'ajouter l’export CSV'), route: true, pipeline: 'dev', mode: 'leger' },
    { n: 2, projet: b, titre: 'doc de l’export', demande: D(2, 'documenter l’export'), apres: 1, route: true, pipeline: 'redaction' },
    { n: 3, projet: a, titre: 'tests de bout en bout', demande: D(3, 'tester l’export de bout en bout'), apres: 2, route: true, pipeline: 'dev', mode: 'leger' },
    { n: 4, projet: b, titre: 'maquette de l’écran', demande: D(4, 'maquetter l’écran d’export'), route: true, pipeline: 'discussion' },
    { n: 5, projet: chef, titre: 'règle du chef', demande: D(5, 'noter la règle'), route: false, chefHandoff: true, raison: 'règle de pratique du chef' },
    { n: 6, projet: a, titre: 'format à choisir', demande: D(6, 'choisir le format'), route: false, question: 'CSV ou JSON ?' },
    { n: 7, projet: a, titre: 'refonte du menu', demande: D(7, 'refaire le menu'), route: true, pipeline: 'dev', mode: 'complet' },
  ];
  const fa = path.join(logsDir, `${a}.jsonl`), fb = path.join(logsDir, `${b}.jsonl`);
  const withRattache = (t) => `${t.demande}\n\n(Rattachée à : requête REQ-FIX)`;
  // 1: launched, then its turn ran and finished.
  const off1 = size(fa);
  append(fa, [
    { orch_turn: 't-fix-1', type: 'user_prompt', text: withRattache(tasks[0]), source: chef, callback: chef, timestamp: iso(1) },
    { orch_turn: 't-fix-1', type: 'system', subtype: 'init', timestamp: iso(1) },
    { orch_turn: 't-fix-1', type: 'assistant', message: { content: [{ type: 'text', text: 'Export CSV livré.' }] }, timestamp: iso(4) },
    { orch_turn: 't-fix-1', type: 'result', subtype: 'success', num_turns: 0, duration_api_ms: 0, result: 'résultat fantôme', timestamp: iso(4) },
    { orch_turn: 't-fix-1', type: 'result', subtype: 'success', num_turns: 4, duration_api_ms: 900, result: 'REQ-FIX-RESULT-1 : export CSV livré (v1.2.0).', timestamp: iso(5) },
  ]);
  // 7: launched into a pipeline run, now paused at its 3rd step.
  const off7 = size(fa);
  append(fa, [
    { orch_turn: 't-fix-7', type: 'user_prompt', text: tasks[6].demande, source: chef, callback: chef, pipeline: { run: PIPE_RUN, pipeline: 'dev', mode: 'complet' }, timestamp: iso(6) },
    { orch_turn: 't-fix-7', type: 'result', subtype: 'success', num_turns: 1, duration_api_ms: 50, result: 'Pause.\nNEEDS_USER_INPUT: continuer ?', timestamp: iso(9) },
  ]);
  fs.mkdirSync(path.join(logsDir, 'runs', PIPE_RUN), { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'runs', PIPE_RUN, 'run.json'), JSON.stringify({ run: PIPE_RUN, project: a, pipeline: 'dev', mode: 'complet', status: 'paused',
    plan: ['comprendre', 'concevoir', 'liste-tests', '@loop', 'revue', 'livrer'], index: 2, steps: [], pausedLimit: 'criteria', createdAt: iso(6), updatedAt: iso(9) }));
  // 2: waited for 1, released at the end of 1 (detached), its turn now running.
  const off2 = size(fb);
  append(fb, [
    { orch_turn: 't-fix-2', type: 'user_prompt', text: withRattache(tasks[1]), source: chef, callback: chef, timestamp: iso(10) },
    { orch_turn: 't-fix-2', type: 'assistant', message: { content: [{ type: 'text', text: 'REQ-FIX-PROGRESS-2 : rédaction du chapitre 2.' }] }, timestamp: iso(11) },
  ]);
  fs.appendFileSync(path.join(logsDir, RELEASED_FILE), JSON.stringify({ at: iso(10), run: REQ_RUN, n: 2, id: 'rel00002', projet: b, offset: off2, hash: textHash(tasks[1].demande), pid: null, titre: tasks[1].titre }) + '\n');
  // 3: still waiting for 2.
  const pendingFile = path.join(logsDir, PENDING_FILE);
  const prev = (() => { try { return JSON.parse(fs.readFileSync(pendingFile, 'utf8')).tasks || []; } catch { return []; } })();
  const waiter = { run: REQ_RUN, n: 3, projet: a, titre: tasks[2].titre, pipeline: 'dev', mode: 'leger', served: false, demande: tasks[2].demande, rattache: 'requête REQ-FIX',
    after: { projet: b, offset: off2, key: taskKey(tasks[1].demande), hash: textHash(tasks[1].demande), since: iso(10) }, createdAt: new Date().toISOString() };
  waiter.id = pendingId(waiter);
  fs.writeFileSync(pendingFile, JSON.stringify({ tasks: [...prev.filter(t => t.run !== REQ_RUN), waiter] }, null, 2));
  // 4: launched while its musician was busy: in its queue.
  const qf = path.join(logsDir, 'queue', `${b}.json`);
  const q = (() => { try { return JSON.parse(fs.readFileSync(qf, 'utf8')); } catch { return []; } })();
  fs.writeFileSync(qf, JSON.stringify([...q.filter(e => !String(e.prompt || '').startsWith('REQ-FIX')),
    { id: 'q-fix-4', enqueuedAt: iso(12), prompt: withRattache(tasks[3]), source: chef, callback: chef }]));
  // 5: handed back to the chef, whose turn was refused (code 65).
  fs.appendFileSync(path.join(logsDir, 'chef-actions.log'),
    `${iso(13)} [chef-action] handoff ${REQ_RUN}#5 → chef (turn 1 ended after 10 ms)\n${iso(13)} [chef-action] handoff ${REQ_RUN}#5 exited with 65: [dispatch] REQ-FIX refus du tour du chef\n`);
  // The Routage run itself and its artefacts.
  const launch = (t, offset, at) => ({ n: t.n, projet: t.projet, titre: t.titre, pipeline: t.pipeline, mode: t.mode || null, reprise: null, pid: null, at, offset, key: taskKey(t.demande), hash: textHash(t.demande) });
  fs.mkdirSync(path.join(logsDir, 'runs', REQ_RUN), { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'runs', REQ_RUN, 'run.json'), JSON.stringify({ run: REQ_RUN, project: chef, pipeline: 'routage', mode: 'demande', status: 'done',
    request: 'REQ-FIX-REQUEST : ajoute l’export CSV, documente-le, teste-le, maquette l’écran, refais le menu.', tasks, createdAt: iso(0), updatedAt: iso(1), endedAt: iso(1) }));
  fs.writeFileSync(path.join(art, 'sens.json'), JSON.stringify({ nature: 'taches', sens: 'REQ-FIX-SENS : un export CSV complet et un menu refait.' }));
  fs.writeFileSync(path.join(art, 'classement.json'), JSON.stringify({ taches: tasks, questions: [`Tâche 6 (${a}) : CSV ou JSON ?`] }));
  fs.writeFileSync(path.join(art, 'dispatch.json'), JSON.stringify({
    dispatched: [launch(tasks[0], off1, iso(1)), launch(tasks[3], size(fb), iso(1)), launch(tasks[6], off7, iso(1))],
    waiting: [{ id: 'w2', titre: tasks[1].titre, n: 2, projet: b, apres: 1, after: a }, { id: waiter.id, titre: tasks[2].titre, n: 3, projet: a, apres: 2, after: b }],
    handoff: { ref: `${REQ_RUN}#5`, status: 'scheduled', pid: null, tasks: [{ n: 5, titre: tasks[4].titre, projet: chef }] },
  }, null, 2));
  // Not user requests with tasks: a wake-up (excluded), a relay, an answer.
  for (const [run, mode, request, min, extra] of [[CALLBACK_RUN, 'callback', '[CALLBACK_WAKE] fin de tâche', 20, { source: 'wake' }],
    [RELAY_RUN, 'demande', '[NEEDS_CHEF_INPUT_FROM:alpha] quel format ?', -60, {}], [NOTASK_RUN, 'demande', 'Où en est la flotte ?', -120, {}]]) {
    fs.mkdirSync(path.join(logsDir, 'runs', run), { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'runs', run, 'run.json'), JSON.stringify({ run, project: chef, pipeline: 'routage', mode, status: 'done', request, tasks: [], createdAt: iso(min), ...extra }));
  }
  return { tasks, art, queueFile: qf, pendingFile, waiterId: waiter.id, offsets: { off1, off2, off7 } };
}

// Lines this fixture appends to shared files (the musicians' logs are its own).
const OURS = /p-20261014T120000-a1b2c3/;
function dropOurLines(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return; }
  fs.writeFileSync(file, txt.split('\n').filter(l => !OURS.test(l)).join('\n'));
}

/**
 * Removes what writeRequestFixture added. Its musicians (req-a, req-b) belong
 * to it alone: no other check reads their logs, deleted here.
 */
export function removeRequestFixture({ logsDir, chefDir, a = MUS_A, b = MUS_B }) {
  for (const m of [a, b]) fs.rmSync(path.join(logsDir, `${m}.jsonl`), { force: true });
  for (const f of ['chef-actions.log', RELEASED_FILE]) dropOurLines(path.join(logsDir, f));
  for (const run of [REQ_RUN, PIPE_RUN, CALLBACK_RUN, RELAY_RUN, NOTASK_RUN]) fs.rmSync(path.join(logsDir, 'runs', run), { recursive: true, force: true });
  fs.rmSync(path.join(chefDir, '.orchestrateur', 'runs', REQ_RUN), { recursive: true, force: true });
  const pf = path.join(logsDir, PENDING_FILE);
  try { const t = JSON.parse(fs.readFileSync(pf, 'utf8')).tasks || []; fs.writeFileSync(pf, JSON.stringify({ tasks: t.filter(x => x.run !== REQ_RUN) }, null, 2)); } catch {}
  const qf = path.join(logsDir, 'queue', `${b}.json`);
  try { const q = JSON.parse(fs.readFileSync(qf, 'utf8')).filter(e => !String(e.prompt || '').startsWith('REQ-FIX')); q.length ? fs.writeFileSync(qf, JSON.stringify(q)) : fs.rmSync(qf, { force: true }); } catch {}
}
