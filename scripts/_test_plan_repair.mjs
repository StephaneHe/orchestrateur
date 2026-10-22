#!/usr/bin/env node
// ============================================================================
// scripts/_test_plan_repair.mjs — the chef's plan repaired by the code
// (Routage v3, phase 2; docs/ROUTAGE-SYNTHESE.md §3.2 and the table §3.3)
// ============================================================================
//
// User decision of 2026-10-22 (« vas y »): phase 2 « tour unique v3 »,
// `plan-repair.mjs (table §3.3)`. « La forme toujours, le sens jamais »: one
// check per row of the table, plus the rule that no constraint is ever removed
// and that a resume is only what `reprises[]` says (decision 4).
//
//   node scripts/_test_plan_repair.mjs
// ============================================================================

import { extractPlan, repairPlan, matchProject, userSaid, WAVE_SIZE } from './plan-repair.mjs';
import { contentHash } from './routage-pending.mjs';

let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const PROJECTS = ['chef', 'orchestrateur-dev', 'projet-video', 'Études', 'pipelineLab'];
const base = { projects: PROJECTS, conductor: 'chef', userTexts: ['corrige le bug puis pousse ; fais-le hors pipeline'] };
const byRef = (r) => new Map(r.items.map(i => [i.ref, i]));
const T = (ref, extra = {}) => ({ ref, projet: 'projet-video', titre: `tâche ${ref} du test`, demande: `Demande complète de la tâche ${ref}.`, ...extra });

section('1. Extraction du bloc ```plan (absent ou illisible : un nouvel essai)');
{
  const e = extractPlan('Voici ma réponse.\n\n```plan\n{"taches": [{"ref":"a","projet":"P","demande":"x"}]}\n```');
  ok(e.ok && e.prose === 'Voici ma réponse.' && e.plan.taches.length === 1, 'bloc ```plan lu, prose sans le bloc');
  ok(extractPlan('Réponse seule, sans bloc.').ok === false && /absent/.test(extractPlan('Réponse seule').why), 'bloc absent : refus de forme (le bloc est obligatoire, `{}` pour rien)');
  ok(/illisible/.test(extractPlan('x\n```plan\n{taches: [}\n```').why), 'JSON illisible : refus de forme');
  ok(extractPlan('a\n```plan\n{}\n```').ok && Object.keys(extractPlan('a\n```plan\n{}\n```').plan).length === 0, 'plan vide `{}` accepté (réponse seule)');
  ok(extractPlan('a\n```json\n{"taches": []}\n```').ok, 'un bloc ```json qui porte un plan est accepté');
  ok(extractPlan('a\n```plan\n{"taches": {}}\n```').ok === false, '« taches » doit être une liste');
  const two = extractPlan('a\n```plan\n{"question":"premier"}\n```\nb\n```plan\n{"question":"dernier"}\n```');
  ok(two.plan.question === 'dernier', 'le DERNIER bloc plan est retenu');
}

section('2. Titre absent ou ambigu : titre de repli, suffixe « (2) »');
{
  const r = repairPlan({ taches: [T('a', { titre: '' }), T('b', { titre: 'Même titre' }), T('c', { titre: 'même  TITRE' })] }, base);
  const m = byRef(r);
  ok(m.get('a').titre.startsWith('Demande complète de la tâche a') && r.notes.some(n => /a : titre absent/.test(n)), `titre absent → repli tiré de la demande (« ${m.get('a').titre} »), dit par [Routeur]`);
  ok(m.get('b').titre === 'Même titre' && m.get('c').titre === 'même TITRE (2)', `titres ambigus → « ${m.get('c').titre} »`);
  ok(!r.retry && r.items.every(i => i.state === 'prête'), 'aucun nouvel essai pour un titre : réparé par le code');
  const long = repairPlan({ taches: [T('a', { titre: 'x'.repeat(80) })] }, base);
  ok(long.items[0].titre.length <= 60, 'titre trop long → repli de 60 caractères au plus');
}

section('3. Projet inconnu : correspondance unique, sinon question groupée (3 proches)');
{
  ok(matchProject('PROJET-VIDEO', PROJECTS).name === 'projet-video' && matchProject('etudes', PROJECTS).name === 'Études', 'casse et accents ignorés');
  const r = repairPlan({ taches: [T('a', { projet: 'Projet-Vidéo' }), T('b', { projet: 'divers' }), T('c', { projet: 'orchestrateur-dev' })] }, base);
  const m = byRef(r);
  ok(m.get('a').projet === 'projet-video' && r.notes.some(n => /lu comme « projet-video »/.test(n)), 'correspondance unique : réparée et dite');
  ok(m.get('b').state === 'à_traiter' && m.get('b').error.near.length === 3 && /Projet\(s\) à préciser/.test(r.question) && /divers/.test(r.question), `inconnu : une question groupée avec 3 proches (${m.get('b').error.near.join(', ')})`);
  ok(m.get('c').state === 'prête' && m.get('a').state === 'prête', 'les autres tâches partent');
}

section('4. Plus de 6 tâches : lancement par vagues');
{
  const many = Array.from({ length: 8 }, (_, i) => T(`t${i}`, { demande: `Travail numéro ${i} à faire.` }));
  const r = repairPlan({ taches: many }, base);
  ok(r.items.filter(i => i.vague === 1).length === WAVE_SIZE && r.items.filter(i => i.vague === 2).length === 2, '8 tâches → 6 en vague 1, 2 en vague 2');
  ok(r.items.every(i => i.state === 'prête') && r.notes.some(n => /par vagues de 6/.test(n)), 'aucune tâche refusée, la vague est dite');
}

section('5. Dépendance hors bornes ou cycle : jamais retirée — un nouvel essai, puis « à traiter »');
{
  const plan = { taches: [T('a'), T('b', { apres: ['zz'] }), T('c', { apres: ['d'] }), T('d', { apres: ['c'] }), T('e', { apres: ['b'] }), T('f')] };
  const r1 = repairPlan(plan, base);
  ok(!!r1.retry && r1.retry.problems.some(p => /« zz »/.test(p.why)) && r1.retry.problems.some(p => /cycle/.test(p.why)), 'premier passage : nouvel essai ciblé (dépendance inconnue, cycle)');
  ok(/CORRECTION DU PLAN/.test(r1.retry.prompt) && /apres/.test(r1.retry.prompt), 'la consigne du nouvel essai nomme les champs à corriger');
  const r2 = repairPlan(plan, { ...base, final: true });
  const m = byRef(r2);
  ok(m.get('b').state === 'à_traiter' && m.get('b').apres.includes('zz') && m.get('b').error.code === 'dépendance', 'après l’essai : la tâche passe à traiter, sa dépendance GARDÉE');
  ok(m.get('c').state === 'à_traiter' && m.get('d').state === 'à_traiter', 'cycle : les deux tâches à traiter');
  ok(m.get('e').state === 'à_traiter' && m.get('e').error.code === 'prédécesseur', 'une tâche qui attend une tâche à traiter ne part pas');
  ok(m.get('a').state === 'prête' && m.get('f').state === 'prête', 'les tâches indépendantes partent');
  ok(m.get('b').error.actions.includes('corriger la dépendance'), 'action proposée : « corriger la dépendance »');
  const self = repairPlan({ taches: [T('a', { apres: ['a'] })] }, { ...base, final: true });
  ok(self.items[0].state === 'à_traiter', 'une tâche qui s’attend elle-même : à traiter');
}

section('6. « hors_pipeline » sans citation retrouvée : lancée EN pipeline, avec une note');
{
  const r = repairPlan({ taches: [T('a', { hors_pipeline: 'fais-le hors pipeline' }), T('b', { hors_pipeline: 'sans les pipelines stp' })] }, base);
  const m = byRef(r);
  ok(m.get('a').horsPipeline === 'fais-le hors pipeline', 'citation retrouvée dans les mots de l’utilisateur : hors pipeline gardé');
  ok(!m.get('b').horsPipeline && m.get('b').state === 'prête' && r.notes.some(n => /b : « hors pipeline » sans citation/.test(n)), 'citation absente : lancée en pipeline, note [Routeur]');
  ok(!userSaid(['[NEEDS_CHEF_INPUT_FROM:P] fais-le hors pipeline'], 'fais-le hors pipeline'), 'une ligne relayée d’un musicien ne vaut jamais autorisation');
}

section('7. Reprise : seulement explicite, et seulement d’une exécution en pause');
{
  const runs = { 'p-20261019T144511-44d707': { status: 'paused', project: 'orchestrateur-dev' }, 'p-20261018T091024-0e199e': { status: 'running', project: 'projet-video', alive: false },
    'p-20261016T155123-18ff0c': { status: 'done', project: 'projet-video' }, 'p-20261016T155415-e67865': { status: 'running', project: 'projet-video', alive: true } };
  const r = repairPlan({
    taches: [T('a', { demande: 'Vérifie ce qui se passe dans p-20261019T144511-44d707 quand les tests échouent (lecture seule).' })],
    reprises: [{ ref: 'r1', run: 'p-20261018T091024-0e199e', message: 'continuer' }, { ref: 'r2', run: 'p-20261016T155123-18ff0c' }, { ref: 'r3', run: 'p-20261016T155415-e67865' }, { ref: 'r4', run: 'p-20990101T000000-abcdef' }],
  }, { ...base, runInfo: (id) => runs[id] || null });
  const m = byRef(r);
  ok(!r.items.some(i => i.kind === 'reprise' && i.run === 'p-20261019T144511-44d707'), 'un identifiant cité dans une demande ne devient jamais une reprise (décision 4)');
  ok(m.get('r1').state === 'prête' && m.get('r1').orphan && r.notes.some(n => /orpheline/.test(n)), 'exécution orpheline : reprise après reclaimOrphanedRun');
  ok(m.get('r2').state === 'refusée' && r.notes.some(n => /déjà terminée \(done\)/.test(n)), 'exécution terminée : le dire, rien à reprendre');
  ok(m.get('r3').state === 'refusée' && m.get('r4').state === 'refusée', 'exécution vivante ou inconnue : refusée et dite');
}

section('8. Doublons écartés et dits');
{
  const r = repairPlan({ taches: [T('a', { demande: 'Même travail exact.' }), T('b', { titre: 'autre titre', demande: 'même   travail exact.' })] }, base);
  ok(byRef(r).get('b').state === 'écartée' && r.notes.some(n => /b écartée : doublon de a/.test(n)), 'doublon dans le plan : écarté, dit');
  const pend = [{ id: 'abcd1234', titre: 'déjà en attente', projet: 'projet-video', pipeline: '', mode: '', demande: 'Déjà décidé avant.' }];
  pend[0].x = contentHash(pend[0]);
  const r2 = repairPlan({ taches: [T('a', { demande: 'Déjà décidé avant.' })] }, { ...base, pending: pend });
  ok(r2.items[0].state === 'écartée' && /attente abcd1234/.test(r2.items[0].duplicateOf), 'doublon d’une tâche déjà en attente (routage-pending) : écarté');
}

section('9. Le sens jamais : tâche au chef, action inconnue, champs obligatoires');
{
  const plan = { taches: [T('a', { projet: 'chef' })], actions: [{ ref: 'b', action: 'kill-stalled', cible: 'projet-video' }, { ref: 'c', action: 'stop_turn', cible: 'projet-video' }, { ref: 'd', action: 'cancel_run', cible: 'p-20261019T144511-44d707', apres: ['a'] }] };
  const r1 = repairPlan(plan, base);
  ok(r1.retry && r1.retry.problems.some(p => /adressée au chef/.test(p.why)) && r1.retry.problems.some(p => /kill-stalled/.test(p.why)) && r1.retry.problems.some(p => /raison obligatoire/.test(p.why)), 'tâche au chef, action hors liste, raison manquante → nouvel essai');
  const r2 = repairPlan(plan, { ...base, final: true });
  const m = byRef(r2);
  ok(m.get('a').state === 'à_traiter' && m.get('b').state === 'à_traiter' && m.get('c').state === 'à_traiter', 'après l’essai : à traiter, jamais lancé au chef');
  ok(m.get('d').state === 'à_traiter' && m.get('d').apres.includes('a'), 'une action qui attend une tâche à traiter garde sa dépendance et attend une décision');
  const ok2 = repairPlan({ actions: [{ ref: 'x', action: 'cancel_run', cible: 'p-20261019T144511-44d707', raison: 'abandon demandé' }] }, base);
  ok(ok2.items[0].state === 'prête' && ok2.items[0].params.run === 'p-20261019T144511-44d707' && ok2.items[0].action === 'cancel_run', '« cible » d’une action typée → son paramètre (run)');
}

section('10. Jamais une contrainte retirée : apres, pipeline, mode, session');
{
  const plan = { taches: [T('a', { pipeline: 'dev', mode: 'léger', session_neuve: true }), T('b', { apres: ['a'], meme_tache: true })], actions: [{ ref: 'c', action: 'todo_add', titre: 'noter la suite', apres: ['b'] }] };
  const r = repairPlan(plan, base);
  const m = byRef(r);
  ok(m.get('a').pipeline === 'dev' && m.get('a').mode === 'leger' && m.get('a').sessionNeuve === true, 'pipeline, mode (« léger » → leger) et session neuve gardés');
  ok(m.get('b').state === 'en_attente_de' && m.get('b').apres[0] === 'a' && m.get('b').memeTache, '« puis » gardé : b attend a');
  ok(m.get('c').state === 'en_attente_de' && m.get('c').apres[0] === 'b', 'une action du chef peut attendre une tâche (« puis » entre chef et musicien)');
  const idx = repairPlan({ taches: [T('a'), T('b', { apres: [1] })] }, base);
  ok(byRef(idx).get('b').apres[0] === 'a', 'ancienne forme (« apres »: 1) lue comme la référence de la tâche 1');
}

console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
