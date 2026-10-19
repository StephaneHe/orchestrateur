#!/usr/bin/env node
// ============================================================================
// scripts/_test_paused_dependency.mjs — a paused task never releases the task
// that waits for it (Routage v3, phase 0 d)
// ============================================================================
//
// User decision (2026-10-19, docs/ROUTAGE-SYNTHESE.md §3.9, phase 0 d): « Une
// tâche en pause ne débloque plus la tâche qui l'attend ».
//
// Real production case replayed (Routage p-20261018T122954-17ac13, anonymized
// project): task 2 waited for task 1, task 3 for task 2. Task 1's pipeline run
// paused (result `success` + `pipeline_paused`), and task 2 was released at
// once; task 2 (which resumed the same run) paused again, and task 3 was
// released too — it was refused (« modifications non commitées »).
//
// Protected (routage-pending.mjs, no model):
//   1. replay: a paused pipeline result (subtype success, pipeline_paused) keeps
//      the waiter, reported as held; the run's final result releases it later,
//      even when its resume prompt is not the awaited text;
//   2. a run closed (« abandonner » / « simplifier ») blocks the waiter, never
//      releases it;
//   3. a task that ends on a question (NEEDS_USER_INPUT, ordinary turn) keeps
//      the waiter; the answer turn's result releases it, and so does
//      « Marquer comme répondue » (question_resolved);
//   4. unchanged: an ordinary successful result releases at once, a failed one
//      blocks.
//
//   node scripts/_test_paused_dependency.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as RP from './routage-pending.mjs';

let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const J = (evs) => evs.map(e => JSON.stringify(e)).join('\n') + '\n';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-paused-dep-'));
const LOGS = path.join(T, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', projects: [] }));
const launched = [];
const launch = (root, t) => { launched.push(t); return { projet: t.projet, pid: null, at: new Date().toISOString(), offset: 0, hash: RP.textHash(t.demande) }; };
const release = () => RP.releaseReady({ root: T, logsDir: LOGS, dispatchScript: 'nul', launch });
const append = (p, evs) => fs.appendFileSync(path.join(LOGS, `${p}.jsonl`), J(evs));
const waiter = (p, text, extra = {}) => ({ run: 'p-20261018T122954-17ac13', projet: p, demande: extra.demande || 'Tâche suivante', titre: extra.titre || 'tâche suivante',
  after: { projet: p, offset: RP.logOffset(LOGS, p), hash: RP.textHash(text) } });

const RUN = 'p-20261018T091024-0e199e';
const TASK1 = 'Reprise (« continuer ») de l’exécution en pause p-20261018T091024-0e199e (dev complet)';
const paused = (run, why) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 41, duration_ms: 500000, duration_api_ms: 400000, stop_reason: 'end_turn',
  pipeline: { run, pipeline: 'dev', status: 'paused', limit: 'criteria' }, pipeline_paused: true,
  result: `⏸ **[projet] — travail en pause, votre décision est attendue.**\n\n${why}\n\nNEEDS_USER_INPUT: répondez « continuer », « simplifier », « changer le model » ou « abandonner »` });

try {
  // -------------------------------------------------------------------------
  section('1. Rejeu du cas réel : une exécution en pause ne libère pas la tâche suivante');
  {
    RP.addPending(LOGS, [{ ...waiter('yl', TASK1), n: 2, demande: 'Ajout de 5 vidéos à la liste', titre: 'ajout de 5 vidéos' }]);
    append('yl', [
      { type: 'user_prompt', text: TASK1, source: 'chef', callback: 'chef', pipeline: { run: RUN, resumed: true } },
      { type: 'system', subtype: 'pipeline_summary', pipeline: { run: RUN, status: 'paused' } },
      paused(RUN, 'la règle fixe au plus 15 tests'),
    ]);
    let r = release();
    ok(r.launched.length === 0 && launched.length === 0, `résultat « success » + pipeline_paused : la tâche suivante n’est PAS lancée (${r.launched.length} lancée(s))`);
    ok(RP.readPending(LOGS).length === 1, 'la tâche suivante reste en attente');
    ok(r.held?.length === 1 && /en pause/.test(r.held[0].why) && r.held[0].run === RUN, `signalée « attente maintenue : la tâche attendue est en pause » (${JSON.stringify(r.held)})`);
    // Resumed (« continuer » relayed by the chef: not the awaited text), paused again.
    append('yl', [
      { type: 'user_prompt', text: 'continuer', source: 'chef', callback: 'chef', pipeline: { run: RUN, resumed: true } },
      paused(RUN, 'l’étape « livraison » a été refusée 2 fois'),
    ]);
    r = release();
    ok(r.launched.length === 0, 'reprise puis nouvelle pause : toujours rien lancé');
    // An unrelated turn of the same musician (another task) never counts.
    append('yl', [{ type: 'user_prompt', text: 'Autre demande, sans rapport', source: 'chef', callback: 'chef' },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_api_ms: 900, result: 'fait' }]);
    r = release();
    ok(r.launched.length === 0, 'le résultat d’une autre tâche du musicien ne libère pas l’attente');
    // The run finally ends: its result releases the waiter.
    append('yl', [
      { type: 'user_prompt', text: 'continuer', source: 'chef', callback: 'chef', pipeline: { run: RUN, resumed: true } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 12, duration_api_ms: 9000, pipeline: { run: RUN, pipeline: 'dev', status: 'done' }, result: 'Livré.' },
    ]);
    r = release();
    ok(r.launched.length === 1 && launched.at(-1)?.titre === 'ajout de 5 vidéos', `fin réelle de l’exécution (status done) : la tâche suivante part (${r.launched.length})`);
    ok(!RP.readPending(LOGS).length, 'et quitte la liste d’attente');
  }

  // -------------------------------------------------------------------------
  section('2. Exécution close (« simplifier » / « abandonner ») : la tâche suivante est bloquée');
  {
    const RUN2 = 'p-20261018T091024-aaaaaa';
    const T2 = 'Corriger le tri (exécution qui sera abandonnée)';
    RP.addPending(LOGS, [{ ...waiter('yl2', T2), n: 3, demande: 'Tri des vidéos', titre: 'tri des vidéos' }]);
    append('yl2', [{ type: 'user_prompt', text: T2, source: 'chef', callback: 'chef', pipeline: { run: RUN2 } }, paused(RUN2, 'limite atteinte')]);
    ok(release().launched.length === 0, 'en pause : rien lancé');
    append('yl2', [
      { type: 'user_prompt', text: 'simplifier — réponse de l’utilisateur', source: 'chef', callback: 'chef', pipeline: { run: RUN2, answer: 'simplifier' } },
      { type: 'system', subtype: 'pipeline_summary', pipeline: { run: RUN2, status: 'abandoned' } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1, duration_api_ms: 1, pipeline: { run: RUN2, status: 'abandoned', answer: 'simplifier' }, result: '■ Exécution arrêtée à votre demande (« simplifier »).' },
    ]);
    const n0 = launched.length;
    const r = release();
    ok(r.launched.length === 0 && launched.length === n0, 'exécution close sans livraison : la tâche suivante n’est pas lancée');
    ok(r.blocked.length === 1 && RP.readPending(LOGS).some(t => t.titre === 'tri des vidéos' && t.blocked), `gardée et signalée « bloquée » (${JSON.stringify(r.blocked.map(b => b.why))})`);
    RP.dropPending(LOGS, { all: true });
  }

  // -------------------------------------------------------------------------
  section('3. Question (NEEDS_USER_INPUT) d’un tour ordinaire : attente maintenue jusqu’à la réponse');
  {
    const Q = 'Rédiger le mail de retour de réunion';
    RP.addPending(LOGS, [{ ...waiter('ay', Q), n: 2, demande: 'Envoyer le brouillon au chef', titre: 'brouillon au chef' }]);
    append('ay', [{ type: 'user_prompt', text: Q, source: 'chef', callback: 'chef' },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 6, duration_api_ms: 30000, result: 'Brouillon prêt.\n\nNEEDS_USER_INPUT: le destinataire est-il celui de la deuxième réunion ?' }]);
    let r = release();
    ok(r.launched.length === 0 && r.held?.some(h => /question/.test(h.why)), `question posée : la tâche suivante attend (${JSON.stringify(r.held)})`);
    append('ay', [{ type: 'user_prompt', text: '[CHEF_ANSWER] Oui, Michael en destinataire direct.', source: 'chef', context: { resume: true, reason: 'réponse du chef à la question du musicien' } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 4, duration_api_ms: 8000, result: 'Brouillon corrigé.' }]);
    r = release();
    ok(r.launched.length === 1 && launched.at(-1)?.titre === 'brouillon au chef', 'réponse donnée, tour fini sans question : la tâche suivante part');

    const Q2 = 'Classer les pièces jointes';
    RP.addPending(LOGS, [{ ...waiter('ay', Q2), n: 3, demande: 'Archiver la réunion', titre: 'archiver la réunion' }]);
    append('ay', [{ type: 'user_prompt', text: Q2, source: 'chef', callback: 'chef' },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_api_ms: 3000, result: 'NEEDS_USER_INPUT: garder les doublons ?' }]);
    ok(release().launched.length === 0, 'seconde question : attente');
    append('ay', [{ type: 'notification', subtype: 'question_resolved', question: 'garder les doublons ?', note: 'non', by: 'utilisateur' }]);
    r = release();
    ok(r.launched.length === 1 && launched.at(-1)?.titre === 'archiver la réunion', '« Marquer comme répondue » : la tâche suivante part');
  }

  // -------------------------------------------------------------------------
  section('4. Inchangé : un résultat ordinaire libère, un échec bloque');
  {
    const A = 'Tâche ordinaire réussie';
    RP.addPending(LOGS, [{ ...waiter('o', A), n: 2, titre: 'suite ordinaire' }]);
    append('o', [{ type: 'user_prompt', text: A, source: 'chef', callback: 'chef' }, { type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_api_ms: 900, result: 'Fait.' }]);
    ok(release().launched.length === 1, 'résultat réussi sans question : libération immédiate');
    const B = 'Tâche ordinaire en échec';
    RP.addPending(LOGS, [{ ...waiter('o', B), n: 3, titre: 'suite d’un échec' }]);
    append('o', [{ type: 'user_prompt', text: B, source: 'chef', callback: 'chef' }, { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 2, duration_api_ms: 5 }]);
    const r = release();
    ok(r.launched.length === 0 && r.blocked.length === 1, 'résultat en échec : bloquée');
  }
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
