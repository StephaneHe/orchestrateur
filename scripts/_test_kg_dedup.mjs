#!/usr/bin/env node
// ============================================================================
// scripts/_test_kg_dedup.mjs — memory proposals are never duplicates (0.162.0)
// ============================================================================
//
// User remark (2026-11-02): « J'ai l'impression qu'il est facile d'y avoir
// beaucoup de duplicats dans les propositions de la memoire. Ex: Lnage de
// discussion = francais ... Et ce n'est pas la premiere que je vois aujourd'hui ».
//
// Replays the real production cases of 2026-11-02 (logs/kg of the prod, read
// only; anonymised): one memory « Langue de discussion = français » proposed
// three times (fleet, chef, orchestrateur); the same relation proposed again
// when its memory was re-read with another quote (a fact id hashes the quote);
// a project-level « s'applique à » next to the same rule for the whole fleet.
// Checked:
//   - a rule already applied by a setting (discussion language) is never proposed;
//   - the same relation as an existing fact (pending, validated, rejected),
//     whatever the quote, is never proposed again;
//   - a project « s'applique à » is not proposed when the rule already applies
//     to the whole fleet;
//   - a genuinely new relation still is;
//   - duplicates already pending are put away by the program with a trace
//     (`dedup` event, review.jsonl), never counted as a false model fact (no
//     cut-off), idempotent, dry run writes nothing; a non-duplicate stays;
//   - the periodic sweep does it.
//
//   node scripts/_test_kg_dedup.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as KG from './kg.mjs';
import { corpusCopy } from '../tests/kg-corpus/fixture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(REPO, 'tests', 'fake_claude', 'fake_claude.mjs');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-dedup-'));
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1500)}` : ''}`); };
const section = (s) => console.log(`\n${s}`);
const kgFile = (root, f) => path.join(root, 'logs', 'kg', f);
const newRoot = (name) => {
  const r = path.join(T, name);
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, kg: { mode: 'shadow', ui: true, extract: true } }));
  return r;
};
const fakeEnv = (map) => ({ ...process.env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_KG_MAP: JSON.stringify(map) });
const asserts = (root) => KG.readEvents(root).filter(e => e.ev === 'assert');
const pendingIds = (root) => KG.reviewQueue(KG.loadIndex(root)).items.filter(i => i.kind === 'fact').map(i => i.id);

// The real memory (chef's feedback_chef_speaks_french.md, 2026-10-09), lines kept verbatim.
const LANG_MEM = `---
name: feedback_chef_speaks_french
description: "Langue de discussion = français, TOUJOURS (chef + musiciens, y compris CALLBACK_WAKE) ; seuls le code et sa doc technique sont en anglais ; rechute 2026-10-09"
metadata:
  type: feedback
  modified: 2026-10-09T04:38:19.232Z
---

Règle utilisateur (2026-10-04) : « le chef doit parler français. Pas d'anglais dans les réponses, à moins que le contexte l'exige ».

**How to apply:**
- Chaque message à l'utilisateur est en français, sans exception de type de tour (réveil, rapport, question, relais).
- La langue de discussion est un réglage de l'orchestrateur (demandé à orchestrateur le 2026-10-09) ; s'y conformer.
`;
const Q_FLEET = "Chaque message à l'utilisateur est en français, sans exception de type de tour (réveil, rapport, question, relais).";
const Q_CHEF = "Règle utilisateur (2026-10-04) : « le chef doit parler français.";
const Q_ORCH = "La langue de discussion est un réglage de l'orchestrateur (demandé à orchestrateur le 2026-10-09) ; s'y conformer.";
// The three facts the model really proposed on 2026-10-22 (f-728e71dee1, f-a8f0d8be3f, f-d4da077fee).
const LANG_FACTS = { facts: [
  { s: 'mem:feedback_chef_speaks_french', p: 'applies_to', o: 'flotte:fleet', quote: Q_FLEET, scope: '*' },
  { s: 'mem:feedback_chef_speaks_french', p: 'applies_to', o: 'projet:chef', quote: Q_CHEF, scope: '*' },
  { s: 'mem:feedback_chef_speaks_french', p: 'applies_to', o: 'projet:orchestrateur', quote: Q_ORCH, scope: '*' },
] };

const ALL_A = 'Tous les dispatches tournent sur **`claude-opus-5-5`**.';
const ALL_B = '**Ne plus router par nature de tâche**';
const NEW_LINE = '\nPrécision (2026-11-02) : la règle vaut pour chaque musicien de la flotte, sans exception.\n';
const Q_NEW = 'la règle vaut pour chaque musicien de la flotte, sans exception.';

try {
  const CORPUS = corpusCopy(path.join(T, 'corpus'));
  fs.writeFileSync(path.join(CORPUS, 'memory', 'feedback_chef_speaks_french.md'), LANG_MEM);
  const R = newRoot('main');
  const b = await KG.build(R, { corpus: CORPUS, repo: null });
  ok(b.ok, 'index du corpus construit (avec la mémoire de langue réelle)', JSON.stringify(b));

  section('1. « Langue de discussion = français » : règle appliquée par un réglage, jamais proposée');
  {
    const r = await KG.extract(R, { corpus: CORPUS, env: fakeEnv({ 'feedback_chef_speaks_french.md': LANG_FACTS }), only: 'memory', max: 20 });
    const lang = asserts(R).filter(e => e.fact.s === 'mem:feedback_chef_speaks_french');
    ok(r.ok && lang.length === 0, `aucune des 3 propositions réelles n’est écrite (avant : 3) : ${lang.length}`, JSON.stringify(r));
    const st = JSON.parse(fs.readFileSync(kgFile(R, 'extract.json'), 'utf8'));
    const tr = (st.duplicates || []).filter(d => d.s === 'mem:feedback_chef_speaks_french');
    ok(tr.length === 3 && tr.every(d => d.kind === 'setting' && /réglage/.test(d.why)), 'trace des 3 écartées, raison « déjà appliquée par un réglage »', JSON.stringify(st.duplicates));
  }

  section('2. Même relation, autre citation : jamais reproposée (en attente, refusée)');
  {
    const r1 = await KG.extract(R, { corpus: CORPUS, env: fakeEnv({ 'feedback_all_opus5.md': { facts: [{ s: 'mem:feedback_all_opus5', p: 'applies_to', o: 'flotte:fleet', quote: ALL_A, scope: '*' }] } }), only: 'memory', max: 20, all: true });
    const first = asserts(R).filter(e => e.fact.s === 'mem:feedback_all_opus5' && e.fact.o === 'flotte:fleet');
    ok(r1.ok && first.length === 1, 'première proposition écrite', JSON.stringify(r1));
    const it0 = KG.reviewQueue(KG.loadIndex(R)).items.find(i => i.id === first[0].fact.id);
    ok(KG.decide(R, { id: it0.id, action: 'validate', rev: it0.rev, commandId: 'test-validate-1' }).ok, 'règle de flotte validée par l’utilisateur');
    // The memory changes (its chunk is re-read); the model states the same relation with another quote.
    fs.appendFileSync(path.join(CORPUS, 'memory', 'feedback_all_opus5.md'), NEW_LINE);
    await KG.build(R, { corpus: CORPUS, repo: null });
    const env2 = fakeEnv({ 'feedback_all_opus5.md': { facts: [
      { s: 'mem:feedback_all_opus5', p: 'applies_to', o: 'flotte:fleet', quote: ALL_B, scope: '*' },
      { s: 'mem:feedback_all_opus5', p: 'applies_to', o: 'projet:boxapp', quote: Q_NEW, scope: '*' },
      { s: 'mem:feedback_all_opus5', p: 'motivated_by', o: 'mem:feedback_plan_opus5_code_opus48', quote: Q_NEW, scope: '*' },
    ] } });
    const r2 = await KG.extract(R, { corpus: CORPUS, env: env2, only: 'memory', max: 20 });
    const fleet = asserts(R).filter(e => e.fact.s === 'mem:feedback_all_opus5' && e.fact.o === 'flotte:fleet');
    ok(fleet.length === 1, `même relation, autre citation : pas reproposée (avant : 2) : ${fleet.length}`, JSON.stringify(r2));
    const box = asserts(R).filter(e => e.fact.s === 'mem:feedback_all_opus5' && e.fact.o === 'projet:boxapp');
    ok(box.length === 0, 'projet déjà couvert par « s’applique à toute la flotte » (validée) : pas proposé');
    const comp = asserts(R).filter(e => e.fact.s === 'mem:feedback_all_opus5' && e.fact.o === 'mem:feedback_plan_opus5_code_opus48');
    ok(comp.length === 1, 'une relation vraiment nouvelle reste proposée');
    const st = JSON.parse(fs.readFileSync(kgFile(R, 'extract.json'), 'utf8'));
    const kinds = (st.duplicates || []).filter(d => d.s === 'mem:feedback_all_opus5').map(d => d.kind).sort().join(',');
    ok(kinds === 'covered,known', `raisons tracées : ${kinds}`, JSON.stringify(st.duplicates));

    // Rejected by the user, then proposed again in other words: never back.
    const idx = KG.loadIndex(R);
    const item = KG.reviewQueue(idx).items.find(i => i.id === comp[0].fact.id);
    const d = KG.decide(R, { id: item.id, action: 'reject', rev: item.rev, commandId: 'test-reject-1' });
    ok(d.ok, 'proposition refusée par l’utilisateur', JSON.stringify(d));
    fs.appendFileSync(path.join(CORPUS, 'memory', 'feedback_all_opus5.md'), '\nAucune exception pour le Routage du chef.\n');
    await KG.build(R, { corpus: CORPUS, repo: null });
    await KG.extract(R, { corpus: CORPUS, env: fakeEnv({ 'feedback_all_opus5.md': { facts: [{ s: 'mem:feedback_all_opus5', p: 'motivated_by', o: 'mem:feedback_plan_opus5_code_opus48', quote: 'Aucune exception pour le Routage du chef.', scope: '*' }] } }), only: 'memory', max: 20 });
    const again = asserts(R).filter(e => e.fact.s === 'mem:feedback_all_opus5' && e.fact.o === 'mem:feedback_plan_opus5_code_opus48');
    ok(again.length === 1, `proposition refusée, reformulée : ne revient pas (${again.length})`);
    const st2 = JSON.parse(fs.readFileSync(kgFile(R, 'extract.json'), 'utf8'));
    ok((st2.duplicates || []).some(x => x.kind === 'rejected' && x.of === comp[0].fact.id), 'trace : « déjà refusée » avec l’identifiant refusé', JSON.stringify(st2.duplicates));
  }

  section('3. Fonction pure : réglage, en attente, refusée, couverte, nouvelle');
  {
    const nodes = { 'mem:lang': { label: 'Langue de discussion = français, TOUJOURS' }, 'mem:r': { label: 'Règle' } };
    const f = (id, o, status, extra = {}) => ({ id, s: 'mem:r', p: 'applies_to', o, status, ...extra });
    const facts = [f('f-1', 'flotte:fleet', 'proposed'), f('f-2', 'projet:x', 'retracted'), f('f-3', 'case:a', 'validated'),
      { id: 'f-4', s: 'mem:v', p: 'applies_to', o: 'flotte:fleet', status: 'validated' }];
    const D = (cand) => KG.proposalDuplicate(cand, { facts, nodes });
    ok(D({ s: 'mem:lang', p: 'applies_to', o: 'projet:y' })?.kind === 'setting', 'règle de langue : réglage');
    ok(D({ s: 'mem:r', p: 'applies_to', o: 'flotte:fleet' })?.of === 'f-1', 'même relation en attente');
    ok(D({ s: 'mem:r', p: 'applies_to', o: 'case:a' })?.kind === 'known', 'même relation validée');
    ok(D({ s: 'mem:r', p: 'applies_to', o: 'projet:x' })?.kind === 'rejected', 'même relation refusée');
    ok(D({ s: 'mem:v', p: 'applies_to', o: 'projet:z' })?.kind === 'covered', 'projet couvert par une règle de flotte validée');
    ok(D({ s: 'mem:r', p: 'applies_to', o: 'projet:z' }) === null, 'règle de flotte seulement proposée : le projet reste proposé (rien de perdu si elle est refusée)');
    ok(D({ s: 'mem:r', p: 'motivated_by', o: 'projet:z' }) === null, 'relation nouvelle : pas un doublon');
  }

  section('4. Doublons déjà en attente : rangés avec une trace, rien d’autre perdu');
  {
    const R2 = newRoot('tidy');
    await KG.build(R2, { corpus: CORPUS, repo: null });
    // The production pattern, as it stands in logs/kg/facts.jsonl (anonymised).
    const at = (d) => `2026-${d}T09:10:24.070Z`;
    const fact = (id, s, o, quote, d) => ({ ev: 'assert', at: at(d), by: 'model:claude-sonnet-5-5', fact: { id, s, p: 'applies_to', o, scope: { project: '*' }, authority: 'document', by: 'model:claude-sonnet-5-5', status: 'proposed',
      source: { kind: 'md', key: `memory:chef/${s.slice(4)}.md`, ref: `chef/${s.slice(4)}.md:1`, quote, line: 3 }, recorded_at: at(d), last_seen: at(d) } });
    const seed = [
      fact('f-lang1', 'mem:feedback_chef_speaks_french', 'flotte:fleet', Q_FLEET, '10-22'),
      fact('f-lang2', 'mem:feedback_chef_speaks_french', 'projet:chef', Q_CHEF, '10-22'),
      fact('f-lang3', 'mem:feedback_chef_speaks_french', 'projet:orchestrateur', Q_ORCH, '10-22'),
      fact('f-roll1', 'mem:feedback_all_opus5', 'flotte:fleet', ALL_A, '10-22'),
      fact('f-roll2', 'mem:feedback_all_opus5', 'flotte:fleet', ALL_B, '10-30'),
      fact('f-roll3', 'mem:feedback_all_opus5', 'projet:boxapp', ALL_A, '10-29'),
      fact('f-keep1', 'mem:feedback_boxapp_opus5', 'projet:boxapp', 'router les tâches de code', '10-22'),
      fact('f-cov1', 'mem:feedback_plan_opus5_code_opus48', 'flotte:fleet', 'plan', '10-22'),
      { ev: 'decide', target: 'f-cov1', action: 'validate', at: at('10-23'), by: 'user:dashboard', commandId: 'seed-validate-1' },
      fact('f-cov2', 'mem:feedback_plan_opus5_code_opus48', 'projet:boxapp', 'plan boxapp', '10-25'),
    ];
    fs.mkdirSync(path.join(R2, 'logs', 'kg'), { recursive: true });
    fs.writeFileSync(kgFile(R2, 'facts.jsonl'), seed.map(e => JSON.stringify(e)).join('\n') + '\n');
    ok(pendingIds(R2).length === 8, `avant : 8 propositions en attente : ${pendingIds(R2).length}`);
    const dry = KG.tidyDuplicates(R2, { dryRun: true });
    ok(dry.ok && dry.duplicates.length === 5 && KG.readEvents(R2).length === 10, 'essai à blanc : 5 doublons trouvés, rien écrit', JSON.stringify(dry));
    const r = KG.tidyDuplicates(R2);
    const left = pendingIds(R2).sort().join(',');
    ok(left === 'f-keep1,f-roll1,f-roll3', `restent : la première de chaque relation, la proposition unique et le projet dont la règle de flotte n’est que proposée : ${left}`, JSON.stringify(r));
    const ev = KG.readEvents(R2).filter(e => e.ev === 'dedup');
    ok(ev.length === 5 && ev.every(e => e.of && e.why && e.by === 'code:dedup'), 'chaque doublon rangé a sa trace (de quoi, pourquoi, par le programme)', JSON.stringify(ev));
    const roll2 = ev.find(e => e.target === 'f-roll2'), cov2 = ev.find(e => e.target === 'f-cov2');
    ok(roll2?.of === 'f-roll1' && roll2.kind === 'pending' && cov2?.of === 'f-cov1' && cov2.kind === 'covered', 'reformulation → la première ; projet → la règle de flotte validée');
    const rv = fs.readFileSync(kgFile(R2, 'review.jsonl'), 'utf8');
    ok((rv.match(/"action":"dedup"/g) || []).length === 5, 'file de revue : 5 sorties « dedup »');
    const h = KG.extractionHealth(KG.readEvents(R2));
    ok(h.judged === 1 && h.false === 0 && !h.breached, 'jamais compté comme un fait faux du model (aucune coupure)');
    const idx = KG.loadIndex(R2);
    const f2 = idx.derived.facts.find(x => x.id === 'f-roll2');
    ok(f2?.status === 'retracted' && /doublon/.test(f2.statusWhy || '') && f2.duplicateOf === 'f-roll1', 'statut lisible : rangé comme doublon de f-roll1', JSON.stringify(f2));
    const again = KG.tidyDuplicates(R2);
    ok(again.ok && again.duplicates.length === 0, "deuxième passage : rien de plus (idempotent)", JSON.stringify(again));
  }

  section('5. Le balayage périodique range les doublons');
  {
    const R3 = newRoot('sweep');
    await KG.build(R3, { corpus: CORPUS, repo: null });
    const e = (id, quote) => ({ ev: 'assert', at: '2026-10-22T09:10:24.070Z', by: 'model:x', fact: { id, s: 'mem:feedback_all_opus5', p: 'applies_to', o: 'flotte:fleet', scope: { project: '*' }, status: 'proposed', by: 'model:x', source: { key: 'memory:chef/feedback_all_opus5.md', ref: 'chef/feedback_all_opus5.md:1', quote }, recorded_at: '2026-10-22T09:10:24.070Z' } });
    fs.mkdirSync(path.join(R3, 'logs', 'kg'), { recursive: true });
    fs.writeFileSync(kgFile(R3, 'facts.jsonl'), [e('f-s1', ALL_A), e('f-s2', ALL_B)].map(x => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(R3, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, kg: { mode: 'shadow', ui: true } }));
    const s = await KG.sweep(R3, { hour: 1 });
    ok(s.dedup?.duplicates?.length === 1 && pendingIds(R3).join(',') === 'f-s1', 'sweep : doublon rangé', JSON.stringify(s));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ exception : ${e?.stack || e}`);
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\n${pass} ok / ${fail} ko`);
process.exit(fail ? 1 : 0);
