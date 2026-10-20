#!/usr/bin/env node
// ============================================================================
// scripts/_test_kg_replay.mjs — knowledge index, phase 0 b: the contradictions
// found by the studies are detected on real past cases (anonymised corpus)
// ============================================================================
//
// User decisions of 2026-10-20 on docs/KG-SYNTHESE.md, phase 0 b: « Détection
// automatique des contradictions (un seul objet valide par sujet sur un
// prédicat fonctionnel) » and « Rejoue de vrais cas passés : les
// contradictions trouvées dans les études (règle des models, nombre de
// projets, vuBox WSL/Windows, Routage du chef) doivent être détectées ».
//
// Corpus tests/kg-corpus/before (KG-SYNTHESE §1.1, anonymised; « boxapp » is
// the service migrated from WSL to Windows). Protected:
//   C1 models rule: the old « TOUT sur opus-4-8 » memory is superseded through
//      the [[links]] chain; the chef's table « opus-4-8 — défaut du fleet » is
//      contradicted by config.json (Opus 5.5); « ne plus router par nature de
//      tâche » is contradicted by the per-case Models page; the index line of
//      a superseded memory that does not say so is flagged;
//   C2 « Fleet de 17 projets » contradicted by the 38 projects of config.json;
//   C3 boxapp « web WSL » (port table) vs « Windows natif » (memory): a
//      conflict between two sources of the same authority, the more recent
//      one named, nothing decided;
//   C4 Routage du chef « en service » in CLAUDE.md vs the live switch (off);
//   ports declared but not listening (annuaire 80, share-api 3000, Ollama
//      11434) to review; no false conflict on the functional predicates.
// Then the chef's corrections of 2026-10-20 (decisions 1, 2, 4) are applied
// to a copy: C1, C2 and C4 disappear; C3 stays (decision 3 pending).
//
//   node scripts/_test_kg_replay.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as KG from './kg.mjs';
import { corpusCopy } from '../tests/kg-corpus/fixture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-replay-'));
const CORPUS = corpusCopy(path.join(T, 'corpus'));
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1200)}` : ''}`); };
const section = (s) => console.log(`\n${s}`);

async function replay(corpusDir, label) {
  const R = path.join(T, `root-${label}`);
  fs.mkdirSync(R);
  const b = await KG.build(R, { corpus: corpusDir, force: true });
  if (!b.ok) throw new Error(JSON.stringify(b));
  return { b, idx: KG.loadIndex(R), md: fs.readFileSync(path.join(R, 'logs', 'kg', 'contradictions.md'), 'utf8') };
}
const staleOf = (idx, s, p) => idx.derived.stale.filter(x => x.s === s && x.p === p);

try {
  section('Avant : les quatre contradictions des études sortent');
  const { b, idx, md } = await replay(CORPUS, 'before');
  ok(b.rejected.length === 0, 'aucun fait rejeté (toutes les citations retrouvées)', JSON.stringify(b.rejected));
  const N = idx.nodes;

  // C1
  ok(N['mem:feedback_plan_opus5_code_opus48']?.status === 'superseded', 'C1 : « TOUT sur opus-4-8 » remplacée (lien supersede de feedback_all_opus5)');
  ok(N['mem:feedback_boxapp_opus5']?.status === 'superseded', 'C1 : la règle boxapp remplacée par la règle générale');
  ok(N['mem:feedback_all_opus5']?.status === 'observed', 'C1 : feedback_all_opus5 en vigueur');
  const sup = idx.derived.facts.filter(f => f.p === 'supersedes').map(f => `${f.s}>${f.o}`);
  ok(sup.includes('mem:feedback_all_opus5>mem:feedback_plan_opus5_code_opus48') && sup.includes('mem:feedback_plan_opus5_code_opus48>mem:feedback_boxapp_opus5'), 'C1 : chaîne supersedes reconstruite', sup.join(', '));
  const dm = staleOf(idx, 'flotte:fleet', 'default_model');
  ok(dm.length === 1 && dm[0].value === 'claude-opus-4-8' && /CLAUDE\.md/.test(dm[0].ref) && dm[0].truth.o === 'claude-opus-5-5' && dm[0].truth.authority === 'live', 'C1 : tableau du chef « opus-4-8 défaut du fleet » contredit par config.json (Opus 5.5)', JSON.stringify(dm));
  const oldClaims = idx.derived.facts.filter(f => f.p === 'default_model' && /feedback_plan/.test(f.source.ref));
  ok(oldClaims.length >= 1 && oldClaims.every(f => f.status === 'superseded'), 'C1 : l’affirmation de la mémoire remplacée ne compte plus (historique, pas contradiction)');
  const rp = staleOf(idx, 'flotte:fleet', 'routing_policy');
  ok(rp.length === 1 && rp[0].value === 'uniforme' && rp[0].truth.o === 'par-case', 'C1 : « ne plus router par nature de tâche » contredit par la page Models (case par case)', JSON.stringify(rp));
  const ix = idx.derived.stale.filter(x => x.reason === 'index').map(x => x.s).sort();
  ok(JSON.stringify(ix) === JSON.stringify(['mem:feedback_boxapp_opus5', 'mem:feedback_plan_opus5_code_opus48']), 'C1 : lignes d’index MEMORY.md périmées signalées', ix.join(', '));
  // C2
  const pc = staleOf(idx, 'flotte:fleet', 'project_count');
  ok(pc.length === 1 && pc[0].value === 17 && pc[0].truth.o === 38, 'C2 : « Fleet de 17 projets » contredit par les 38 projets de config.json', JSON.stringify(pc));
  // C3
  const c3 = idx.derived.conflicts.find(c => c.s === 'projet:boxapp' && c.p === 'runs_in');
  ok(c3 && c3.values.map(v => v.o).sort().join() === 'env:windows,env:wsl', 'C3 : boxapp WSL (table des ports) contre Windows natif (mémoire) = conflit', JSON.stringify(idx.derived.conflicts));
  ok(c3 && /project_boxapp_windows_native/.test(c3.hint || '') && /2026-09-18/.test(c3.hint || ''), 'C3 : la source la plus récente est nommée, rien n’est tranché');
  ok(idx.derived.facts.filter(f => f.s === 'projet:boxapp' && f.p === 'runs_in').every(f => f.status === 'disputed'), 'C3 : les deux faits passent « disputed »');
  // C4
  const c4 = staleOf(idx, 'composant:routage-chef', 'has_state');
  ok(c4.length === 1 && c4[0].value === 'on' && c4[0].truth.o === 'off', 'C4 : Routage du chef « en service » dans CLAUDE.md contredit par l’interrupteur réel (off)', JSON.stringify(c4));
  // Ports
  const muted = idx.derived.stale.filter(x => x.reason === 'port-muet').map(x => x.value[0]).sort((a, c) => a - c);
  ok(JSON.stringify(muted) === JSON.stringify([80, 3000, 11434]), 'ports déclarés sans écoute à revoir : 80, 3000, 11434', JSON.stringify(muted));
  ok(!idx.derived.stale.some(x => x.reason === 'port-muet' && x.value.includes(3001)), 'boxapp (3001) écoute : pas signalé muet');
  ok(idx.derived.stale.filter(x => x.reason === 'age').length >= 1, 'déclarations de ports de plus de 60 jours à revoir');
  // No false conflict.
  ok(idx.derived.conflicts.length === 1, 'aucun faux conflit sur les prédicats fonctionnels (un seul : C3)', JSON.stringify(idx.derived.conflicts.map(c => `${c.s}/${c.p}`)));
  ok(!idx.derived.loops.length, 'aucune boucle de remplacement');
  // Exception kept as an exception, not a contradiction.
  ok(idx.derived.facts.some(f => f.p === 'exception_to' && f.s === 'mem:project_boxapp_windows_native' && f.o === 'mem:user_profile'), 'exception rendue comme exception (boxapp → profil)');
  ok(/## Conflits \(1\)/.test(md) && /boxapp/.test(md) && /17/.test(md), 'rapport logs/kg/contradictions.md écrit en français');
  // Provenance on every contradiction.
  ok([...idx.derived.conflicts.flatMap(c => c.values), ...idx.derived.stale].every(x => /:\d+$|#\//.test(x.ref)), 'chaque contradiction porte sa source (fichier:ligne ou pointeur)');

  section('Après les corrections du chef (décisions 1, 2, 4) : seule C3 reste');
  const A = path.join(T, 'after');
  fs.cpSync(CORPUS, A, { recursive: true });
  const edit = (rel, fn) => { const f = path.join(A, rel); fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8'))); };
  edit('memory/feedback_all_opus5.md', s => s.replace('---\n\n', '---\n\n**⚠ MISE À JOUR 2026-10-20 (décision utilisateur, synthèse KG) : la PAGE MODELS fait foi case par case pour toute étape de pipeline ; Opus 5.5 (`claude-opus-5-5`) reste le DÉFAUT hors case. Le tableau de models du CLAUDE.md et [[feedback_plan_opus5_code_opus48]] sont caducs.**\n\n'));
  edit('memory/feedback_plan_opus5_code_opus48.md', s => s.replace('---\n\n', '---\n\n**❌ CADUC (2026-10-20) : remplacé par [[feedback_all_opus5]]. Ne plus appliquer ce qui suit.**\n\n'));
  edit('memory/MEMORY.md', s => s.replace(/Routage standing : planification → Opus 5, code → Opus 4\.8/, 'CADUC (2026-10-20), remplacé par feedback_all_opus5'));
  edit('memory/user_profile.md', s => s.replace('Fleet de 17 projets', 'Fleet de 38 projets'));
  edit('CLAUDE.md', s => s.replace(/  Choix des models :[\s\S]*?\n\n/, '  Choix des models : la page Models fait foi (décision du 2026-10-20).\n\n').replace('  > - **Ton propre tour', '  > - ⚠ **COUPÉ en prod depuis le 2026-10-19 18:27** (`pipeline-enforce.mjs off --chef`).\n  > - **Ton propre tour'));
  const after = await replay(A, 'after');
  const a = after.idx;
  ok(!staleOf(a, 'flotte:fleet', 'default_model').length && !staleOf(a, 'flotte:fleet', 'routing_policy').length, 'C1 close : plus de règle de models contredite', JSON.stringify(a.derived.stale.filter(x => x.s === 'flotte:fleet')));
  ok(!staleOf(a, 'flotte:fleet', 'project_count').length, 'C2 close');
  ok(!staleOf(a, 'composant:routage-chef', 'has_state').length, 'C4 close : la ligne datée « COUPÉ » remplace « en service » dans la même source');
  ok(a.derived.facts.some(f => f.s === 'composant:routage-chef' && f.o === 'on' && f.status === 'superseded'), 'C4 : l’ancienne affirmation reste lisible, marquée remplacée');
  ok(a.derived.conflicts.length === 1 && a.derived.conflicts[0].s === 'projet:boxapp', 'C3 reste ouverte (décision 3 en attente)');
  const ixA = a.derived.stale.filter(x => x.reason === 'index').map(x => x.s);
  ok(JSON.stringify(ixA) === JSON.stringify(['mem:feedback_boxapp_opus5']), 'ligne d’index corrigée : plus signalée ; celle qui ne l’est pas, toujours', ixA.join(', '));
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
