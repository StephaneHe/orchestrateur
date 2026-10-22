#!/usr/bin/env node
// ============================================================================
// scripts/_test_kg_facts.mjs — knowledge graph phase 1: curated facts
// ============================================================================
//
// User decision (2026-10-22) « vas y » on docs/KG-SYNTHESE.md §4 phase 1
// (« faits curés et onglet Mémoire ») and §6, decisions 8 (models propose links
// with an exact quote the program finds again; nothing proposed serves as a
// rule before validation; extraction cut off beyond 5 % errors; sonnet-5-5),
// 9 (validation by batches in the Memory tab) and 15 (correcting a memory goes
// through its owner, never silently). Checked here, against the anonymised
// corpus and the fake claude:
//   - switches kg.build / kg.extract / kg.ui, off by default, refused while the
//     mode is off, all cleared by `kg off` and `off --all`;
//   - extraction: closed predicates, ids only from the list the code gives,
//     quote found again in the source, secrets masked before the model and the
//     disk; every kept fact is `proposed`; an unchanged source is not re-read;
//     a failed call suspends the batch (no hidden fallback);
//   - `proposed` is NEVER stated as a rule (injectable, regles, fiche);
//   - decisions: append-only events, idempotent by commandId, expected
//     revision (409), validate / correct / expire / reject, concurrent writers
//     under the lock; decisions survive a rebuild;
//   - automatic cut-off: 2 false facts among the last 30 judged switch
//     extraction off and say why; re-enabling restarts the window;
//   - suspect pairs chosen by the code, judged by the model, confirmed then
//     arbitrated (« celle-ci vaut »); a derived conflict too;
//   - 90 days without review → to_review; daily backup; the sweep rebuilds
//     only when a source changed, and does nothing while the mode is off;
//   - source excerpts only from sources the index knows;
//   - no module of the turns nor the server loads kg.mjs.
//
//   node scripts/_test_kg_facts.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as KG from './kg.mjs';
import { corpusCopy } from '../tests/kg-corpus/fixture.mjs';
import { referenceGraph, importClosure, repoFiles } from './regression-targets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(REPO, 'tests', 'fake_claude', 'fake_claude.mjs');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-facts-'));
const CORPUS = corpusCopy(path.join(T, 'corpus'));
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1500)}` : ''}`); };
const section = (s) => console.log(`\n${s}`);
const routing = (root) => JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8'));
const kgFile = (root, f) => path.join(root, 'logs', 'kg', f);
const newRoot = (name, kg = { mode: 'shadow' }) => {
  const r = path.join(T, name);
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, ...(kg ? { kg } : {}) }));
  return r;
};
const LOG = path.join(T, 'kg-calls.ndjson');
const DUMP = path.join(T, 'prompts.ndjson');
const fakeEnv = (extra = {}) => ({ ...process.env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_KG_LOG: LOG, FAKE_CLAUDE_DUMP_PROMPT: DUMP, ...extra });
const calls = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const cli = (root, args, input = null) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'kg.mjs'), ...args], { encoding: 'utf8', input, env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: root } });
let cmdN = 0;
const cmd = () => `test-cmd-${++cmdN}-${process.pid}`;

const BOX = 'Pour le **développement de boxapp**, router les tâches de code sur **`claude-opus-5`** (pas sonnet/haiku).';
const ALL = 'Tous les dispatches tournent sur **`claude-opus-5-5`**.';
const WIN = 'boxapp tourne désormais en **Windows natif**';
const SECRET_HEX = 'a3f9c1d2e4b5a6978877665544332211aabbccdd';
const SECRET_KEY = 'sk-ant-api03-ZXhhbXBsZS1rZXktZm9yLXRlc3RzLW9ubHktMTIzNDU2Nzg5MA';

try {
  section('1. Interrupteurs : coupés par défaut, refusés en mode off, tout coupé par « kg off »');
  {
    const R0 = newRoot('off', null);
    const s = KG.readKgSettings(R0);
    ok(s.mode === 'off' && !s.build && !s.extract && !s.ui, 'sans bloc kg : mode off, build/extract/ui coupés');
    let refused = null;
    try { KG.writeKgSwitch(R0, { key: 'ui', on: true }); } catch (e) { refused = e.message; }
    ok(/kg\.mode = off/.test(refused || ''), 'allumer un interrupteur en mode off est refusé', refused);
    const R1 = newRoot('switches');
    ok(!KG.readKgSettings(R1).ui, 'mode ombre : interrupteurs toujours coupés par défaut');
    const pe = (args) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'pipeline-enforce.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: R1 } });
    const a = pe(['kg', 'ui', 'on']);
    ok(a.status === 0 && KG.readKgSettings(R1).ui, 'pipeline-enforce.mjs kg ui on', a.stderr + a.stdout);
    pe(['kg', 'extract', 'on']); pe(['kg', 'build', 'on']);
    const st = KG.readKgSettings(R1);
    ok(st.build && st.extract && st.ui && st.extractSince, 'build, extract, ui allumés (date de remise en route de l’extraction notée)');
    ok(routing(R1).history.some(h => h.task === 'kg.ui' && h.to === 'on'), 'historique de model-routing.json');
    pe(['kg', 'off']);
    ok(!routing(R1).kg && !KG.readKgSettings(R1).ui, '« kg off » retire tout le bloc : off = comportement actuel exact');
    pe(['kg', 'shadow']);
    ok(!KG.readKgSettings(R1).ui && !KG.readKgSettings(R1).extract, 'remis en ombre : les interrupteurs restent coupés');
    pe(['kg', 'ui', 'on']);
    const all = pe(['off', '--all']);
    ok(all.status === 0 && !routing(R1).kg, 'off --all coupe aussi la mémoire et ses interrupteurs', all.stderr);
    ok(KG.sweep && (await KG.sweep(R1)).skipped === 'off', 'balayage en mode off : rien ne tourne');
    ok(!fs.existsSync(path.join(R1, 'logs')), 'mode off : rien n’est écrit');
  }

  // Main root: corpus index, extraction on.
  const R = newRoot('main');
  const b = await KG.build(R, { corpus: CORPUS, repo: null });
  ok(b.ok, 'index du corpus construit', JSON.stringify(b));

  section('2. Extraction par model : liste fermée, citation retrouvée, toujours « proposé »');
  {
    const map = {
      'feedback_boxapp_opus5.md': { facts: [
        { s: 'mem:feedback_boxapp_opus5', p: 'applies_to', o: 'projet:boxapp', quote: BOX, scope: 'projet:boxapp', valid_from: '2026-08-24' },
        { s: 'mem:feedback_boxapp_opus5', p: 'applies_to', o: 'projet:inventé', quote: BOX, scope: '*' },
        { s: 'mem:feedback_boxapp_opus5', p: 'applies_to', o: 'projet:shelfapp', quote: 'router toutes les tâches de shelfapp sur haiku', scope: '*' },
        { s: 'mem:feedback_boxapp_opus5', p: 'default_model', o: 'projet:boxapp', quote: BOX, scope: '*' },
        { s: 'mem:feedback_boxapp_opus5', p: 'contradicts', o: 'projet:boxapp', quote: BOX, scope: '*' },
        { s: 'mem:feedback_boxapp_opus5', p: 'mentions', o: 'projet:boxapp', quote: BOX, scope: '*' },
      ] },
      'feedback_all_opus5.md': { facts: [{ s: 'mem:feedback_all_opus5', p: 'applies_to', o: 'projet:boxapp', quote: ALL, scope: '*' }, { s: 'mem:feedback_all_opus5', p: 'applies_to', o: 'model:claude-opus-5-5', quote: ALL, scope: '*' }, { s: 'mem:feedback_plan_opus5_code_opus48', p: 'supersedes', o: 'mem:feedback_all_opus5', quote: ALL, scope: '*' }] },
      'project_boxapp_windows_native.md': { facts: [{ s: 'mem:project_boxapp_windows_native', p: 'applies_to', o: 'projet:boxapp', quote: WIN, scope: 'projet:boxapp' }] },
      'reference_secret.md': { facts: [{ s: 'mem:reference_secret', p: 'applies_to', o: 'projet:boxapp', quote: 'jeton de boxapp', scope: '*' }] },
    };
    // A memory holding secrets: masked before the model and before the disk.
    fs.writeFileSync(path.join(CORPUS, 'memory', 'reference_secret.md'), `---\nname: reference_secret\ndescription: accès\ntype: reference\n---\njeton de boxapp : ${SECRET_HEX}\nclé : ${SECRET_KEY}\n`);
    await KG.build(R, { corpus: CORPUS, repo: null });
    const env = fakeEnv({ FAKE_CLAUDE_KG_MAP: JSON.stringify(map) });
    const off = await KG.extract(R, { corpus: CORPUS, env, only: 'memory' });
    ok(off.ok === false && off.refused === 'off' && calls().length === 0, 'kg.extract coupé : aucune extraction, aucun appel');
    KG.writeKgSwitch(R, { key: 'extract', on: true });
    const r = await KG.extract(R, { corpus: CORPUS, env, only: 'memory', max: 20 });
    ok(r.ok && r.calls === 7, `un appel par mémoire (7 mémoires, MEMORY.md exclu) : ${r.calls}`, JSON.stringify(r));
    ok(r.proposed === 4 && r.rejected === 7, `4 faits gardés, 7 rejetés (id inventé, citation introuvable, prédicat fonctionnel, contradiction écrite par un model, « s’applique à » un model, « mentionne », remplacement à l’envers) : ${r.proposed}/${r.rejected}`, JSON.stringify(r));
    ok(calls().every(c => c.model === KG.KG_DEFAULT_MODEL), 'model : claude-sonnet-5-5 (décision 8) faute de case kg.extraire');
    const st = JSON.parse(fs.readFileSync(kgFile(R, 'extract.json'), 'utf8'));
    const whys = st.rejected.map(x => x.why).join(' | ');
    ok(/hors de la liste fournie/.test(whys) && /citation introuvable/.test(whys) && /prédicat non permis : default_model/.test(whys) && /prédicat non permis : contradicts/.test(whys) && /prédicat non permis : mentions/.test(whys) && /applies_to vers un model/.test(whys) && /remplacement à l’envers/.test(whys), 'chaque rejet a sa raison', whys);
    const ev = KG.readEvents(R);
    const asserts = ev.filter(e => e.ev === 'assert');
    ok(asserts.length === 4 && asserts.every(e => e.fact.status === 'proposed' && e.fact.by.startsWith('model:') && e.fact.source.quote && e.fact.source.line), 'faits écrits « proposed », avec citation et ligne recalculée');
    const prompts = fs.readFileSync(DUMP, 'utf8');
    const disk = fs.readFileSync(kgFile(R, 'facts.jsonl'), 'utf8') + fs.readFileSync(kgFile(R, 'extract.json'), 'utf8');
    ok(!prompts.includes(SECRET_HEX) && !prompts.includes(SECRET_KEY), 'secrets masqués avant le model');
    ok(!disk.includes(SECRET_HEX) && !disk.includes(SECRET_KEY), 'aucun secret sur le disque');
    const kgPrompts = prompts.split('\n').filter(Boolean).map(l => JSON.parse(l).prompt).filter(x => /^\[KG_EXTRACT\]/.test(x));
    ok(kgPrompts.length === 7 && kgPrompts.every(x => /\nIDS:\n- mem:/.test(x) && x.includes('- projet:boxapp')), 'le code fournit la liste des identifiants permis');
    const n0 = calls().length;
    const again = await KG.extract(R, { corpus: CORPUS, env, only: 'memory', max: 20 });
    ok(again.calls === 0 && calls().length === n0, 'source inchangée : pas relue');
    const all = await KG.extract(R, { corpus: CORPUS, env, only: 'memory', max: 20, all: true });
    ok(all.seen === 4 && all.proposed === 0 && KG.readEvents(R).filter(e => e.ev === 'assert').length === 4, 'refait sur tout : « vu de nouveau », jamais en double');
  }

  section('3. Un fait proposé n’est jamais énoncé comme règle');
  let idx = KG.loadIndex(R);
  const proposed = idx.derived.facts.filter(f => f.origin === 'model');
  {
    ok(proposed.length === 4 && proposed.every(f => f.status === 'proposed'), '4 faits de model chargés, tous « proposed »');
    ok(proposed.every(f => !KG.injectable(f)), 'injectable() : faux pour chacun');
    ok(!idx.derived.facts.filter(f => KG.injectable(f)).some(f => f.status === 'proposed'), 'aucun fait injectable n’est proposé');
    const rg = KG.regles(idx, { projet: 'boxapp' });
    ok(!JSON.stringify(rg.curated).includes('mem:feedback_boxapp_opus5') && !rg.fixed.some(f => f.status === 'proposed'), 'règles de boxapp : rien de proposé');
    const fi = KG.fiche(idx, 'boxapp');
    ok(![...fi.environment, ...fi.ports].some(f => f.status === 'proposed'), 'fiche : rien de proposé');
    const q = KG.reviewQueue(idx);
    const item = q.items.find(i => i.kind === 'fact' && i.s === 'mem:feedback_boxapp_opus5');
    ok(item && item.card.what && item.card.why.includes('«') && item.card.since && item.card.where === 'projet boxapp', 'revue : fiche à quatre questions (quoi, pourquoi, depuis quand, où)', JSON.stringify(item?.card));
    ok(item && item.actions.join() === 'validate,correct,expire,reject' && item.owner === 'chef', 'boutons Valider, Corriger, Périmer, Rejeter ; propriétaire de la source = chef');
  }

  section('4. Décisions : révision attendue, idempotence, validation, correction, péremption, rejet');
  {
    const f = proposed.find(x => x.s === 'mem:feedback_boxapp_opus5');
    const bad = KG.decide(R, { id: f.id, action: 'validate', rev: 5, commandId: cmd() });
    ok(bad.ok === false && bad.status === 409, 'révision périmée : 409', JSON.stringify(bad));
    ok(KG.decide(R, { id: f.id, action: 'validate', rev: 1 }).status === 400, 'sans commandId : 400');
    ok(KG.decide(R, { id: f.id, action: 'bénir', rev: 1, commandId: cmd() }).status === 400, 'action inconnue : 400');
    const c = cmd();
    const v = KG.decide(R, { id: f.id, action: 'validate', rev: 1, commandId: c });
    ok(v.ok && v.rev === 2, 'validé', JSON.stringify(v));
    const n = KG.readEvents(R).length;
    const dup = KG.decide(R, { id: f.id, action: 'validate', rev: 1, commandId: c });
    ok(dup.ok && dup.duplicate && KG.readEvents(R).length === n, 'même commandId : rien de plus (idempotent)');
    idx = KG.loadIndex(R);
    const fv = idx.derived.facts.find(x => x.id === f.id);
    ok(fv.status === 'validated' && KG.injectable(fv), 'validé : peut désormais être énoncé');
    ok(KG.regles(idx, { projet: 'boxapp' }).curated.some(x => x.s === f.s), 'règles de boxapp : le lien validé apparaît');
    const corr = KG.decide(R, { id: f.id, action: 'correct', rev: 2, commandId: cmd(), o: 'shelfapp' });
    idx = KG.loadIndex(R);
    const nf = idx.derived.facts.find(x => x.id === corr.newId);
    ok(corr.ok && nf && nf.o === 'projet:shelfapp' && nf.status === 'validated' && nf.authority === 'user' && nf.corrects === f.id, 'corrigé : nouveau fait de l’utilisateur, identifiant résolu', JSON.stringify(corr));
    ok(idx.derived.facts.find(x => x.id === f.id).status === 'superseded', 'l’ancien fait est remplacé, pas effacé');
    const g = proposed.find(x => x.s === 'mem:reference_secret');
    const rj = KG.decide(R, { id: g.id, action: 'reject', rev: 1, commandId: cmd(), reason: 'pas un lien' });
    idx = KG.loadIndex(R);
    ok(rj.ok && idx.derived.facts.find(x => x.id === g.id).status === 'retracted' && !KG.reviewQueue(idx).items.some(i => i.id === g.id), 'rejeté (motif) : sort de la revue');
    const past = KG.decide(R, { id: corr.newId, action: 'expire', rev: 1, commandId: cmd(), valid_to: '2026-01-01' });
    idx = KG.loadIndex(R);
    ok(past.ok && idx.derived.facts.find(x => x.id === corr.newId).status === 'superseded', 'périmé à une date passée : n’est plus en vigueur');
    const pa = proposed.find(x => x.s === 'mem:feedback_all_opus5');
    ok(KG.decide(R, { id: pa.id, action: 'expire', rev: 1, commandId: cmd(), valid_to: '1er mai' }).status === 400, 'date invalide : 400');
    ok(!KG.readKgSettings(R).extract && /2 faits de model faux/.test(KG.readKgSettings(R).cutoff?.why || ''), 'un rejet et une correction de faits de model : 2 faux, extraction coupée d’office');
    ok(KG.readEvents(R).every(e => e.ev), 'journal en ajout seul, lisible ligne à ligne');
    const review = fs.readFileSync(kgFile(R, 'review.jsonl'), 'utf8');
    ok(/"ev":"queued"/.test(review) && /"ev":"done"/.test(review), 'review.jsonl : entrée et sortie de la file');
  }

  section('5. Paires suspectes : le code choisit, le model juge, l’utilisateur tranche');
  {
    idx = KG.loadIndex(R);
    const a = idx.derived.facts.find(x => x.origin && x.s === 'mem:feedback_all_opus5');
    const w = idx.derived.facts.find(x => x.origin && x.s === 'mem:project_boxapp_windows_native');
    KG.decide(R, { id: a.id, action: 'validate', rev: 1, commandId: cmd() });
    KG.decide(R, { id: w.id, action: 'validate', rev: 1, commandId: cmd() });
    idx = KG.loadIndex(R);
    KG.writeKgSwitch(R, { key: 'extract', on: true, by: 'utilisateur' });
    const sp = KG.suspectPairs(idx);
    ok(sp.length === 1 && sp[0].target === 'projet:boxapp' && [sp[0].a, sp[0].b].sort().join() === 'mem:feedback_all_opus5,mem:project_boxapp_windows_native', 'une paire : deux règles actives sur la même cible', JSON.stringify(sp));
    const env = fakeEnv({ FAKE_CLAUDE_KG: JSON.stringify({ verdict: 'contradiction', reason: 'les deux ne peuvent pas tenir ensemble (faux claude)' }) });
    const off = await KG.judgePairs(R, { env: fakeEnv(), max: 5 });
    ok(off.ok && off.judged === 1, 'paires jugées (kg.extract allumé)', JSON.stringify(off));
    // the default fake verdict is « incertain »: the pair goes to review as a suspicion
    idx = KG.loadIndex(R);
    let item = KG.reviewQueue(idx).items.find(i => i.kind === 'pair');
    ok(item && item.sides.length === 2 && item.actions.join() === 'validate,reject', 'revue : paire proposée avec ses deux sources');
    ok((await KG.judgePairs(R, { env, max: 5 })).judged === 0, 'une paire jugée ne l’est pas deux fois');
    ok(KG.decide(R, { id: item.id, action: 'arbitrate', rev: item.rev, commandId: cmd(), keep: sp[0].a }).status === 400, '« celle-ci vaut » refusé sur une paire non confirmée');
    const conf = KG.decide(R, { id: item.id, action: 'validate', rev: item.rev, commandId: cmd() });
    idx = KG.loadIndex(R);
    item = KG.openContradictions(idx).find(i => i.id === conf.id);
    ok(conf.ok && item && item.actions.join() === 'arbitrate', 'confirmée : devient une contradiction du bandeau');
    const arb = KG.decide(R, { id: item.id, action: 'arbitrate', rev: item.rev, commandId: cmd(), keep: sp[0].a });
    idx = KG.loadIndex(R);
    ok(arb.ok && !KG.openContradictions(idx).some(i => i.id === item.id), '« celle-ci vaut » : contradiction close');
  }

  section('6. Contradiction dérivée tranchée : survit à la reconstruction');
  {
    idx = KG.loadIndex(R);
    const c = KG.openContradictions(idx).find(i => i.s === 'projet:boxapp' && i.p === 'runs_in');
    ok(c && c.sides.length === 2 && c.sides.every(s => s.ref && s.owner), 'contradiction boxapp WSL / Windows : deux sources et leur propriétaire');
    const keep = c.sides.find(s => s.o === 'env:windows').fact;
    const r = KG.decide(R, { id: c.id, action: 'arbitrate', rev: c.rev, commandId: cmd(), keep });
    await KG.build(R, { corpus: CORPUS, repo: null });
    idx = KG.loadIndex(R);
    ok(r.ok && !KG.openContradictions(idx).some(i => i.id === c.id), 'tranchée, toujours close après reconstruction');
    const env = KG.fiche(idx, 'boxapp').environment;
    ok(env.length === 1 && env[0].o === 'env:windows', 'fiche : seule la valeur retenue reste énoncée', JSON.stringify(env));
    ok(idx.derived.facts.find(f => f.id === c.sides.find(s => s.fact !== keep).fact).statusWhy.includes('corriger la source'), 'l’autre est remplacée, avec « corriger la source »');
  }

  section('7. Coupure automatique au-delà de 5 % de faux sur 30 faits');
  {
    const R2 = newRoot('cutoff');
    await KG.build(R2, { corpus: CORPUS, repo: null });
    KG.writeKgSwitch(R2, { key: 'extract', on: true });
    const now = new Date().toISOString();
    const quote = ALL;
    const lines = [];
    for (let i = 0; i < 34; i++) {
      const fact = { s: 'mem:feedback_all_opus5', p: 'mentions', o: 'projet:boxapp', scope: { project: '*' }, authority: 'document', by: 'model:test', status: 'proposed', recorded_at: now,
        source: { kind: 'md', key: 'memory:chef/feedback_all_opus5.md', ref: `feedback_all_opus5.md:${i}`, quote } };
      fact.id = `f-cut${String(i).padStart(5, '0')}`;
      lines.push(JSON.stringify({ ev: 'assert', at: now, by: 'model:test', fact }));
    }
    fs.writeFileSync(kgFile(R2, 'facts.jsonl'), lines.join('\n') + '\n');
    // Concurrent writers (4 processes): every decision lands, the log stays readable.
    const kids = [0, 1, 2, 3].map(i => new Promise((res) => {
      const c = spawn(process.execPath, [path.join(REPO, 'scripts', 'kg.mjs'), 'decide', '--json', '--force'], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: R2 }, stdio: ['pipe', 'pipe', 'pipe'] });
      let o = ''; c.stdout.on('data', d => { o += d; }); c.on('close', (code) => res({ code, o }));
      c.stdin.end(JSON.stringify({ id: `f-cut${String(i).padStart(5, '0')}`, action: 'validate', rev: 1, commandId: `concurrent-${i}-${process.pid}` }));
    }));
    const done = await Promise.all(kids);
    ok(done.every(d => d.code === 0) && KG.readEvents(R2).filter(e => e.ev === 'decide').length === 4, '4 écrivains concurrents : 4 décisions, journal intact', JSON.stringify(done));
    for (let i = 4; i < 29; i++) KG.decide(R2, { id: `f-cut${String(i).padStart(5, '0')}`, action: 'validate', rev: 1, commandId: cmd() });
    KG.decide(R2, { id: 'f-cut00029', action: 'reject', rev: 1, commandId: cmd(), reason: 'faux' });
    ok(KG.readKgSettings(R2).extract, '1 faux sur 30 (3,3 %) : l’extraction continue');
    ok(KG.extractionHealth(KG.readEvents(R2)).judged === 30, 'fenêtre des 30 derniers faits jugés');
    const r = KG.decide(R2, { id: 'f-cut00030', action: 'correct', rev: 1, commandId: cmd(), o: 'shelfapp' });
    const s = KG.readKgSettings(R2);
    ok(r.cutoff && !s.extract && /coupure automatique : 2 faits de model faux/.test(s.cutoff?.why || ''), '2 faux sur les 30 derniers : extraction coupée d’office, et dit', JSON.stringify(s));
    ok(KG.readEvents(R2).some(e => e.ev === 'cutoff'), 'événement de coupure journalisé');
    const x = await KG.extract(R2, { corpus: CORPUS, env: fakeEnv() });
    ok(x.ok === false && x.refused === 'off', 'extraction refusée après la coupure');
    ok(KG.kgStatus(R2).cutoff?.why, 'état : raison de la coupure');
    KG.writeKgSwitch(R2, { key: 'extract', on: true, by: 'utilisateur' });
    const y = await KG.extract(R2, { corpus: CORPUS, env: fakeEnv(), only: 'memory', max: 1 });
    ok(y.ok && !KG.readKgSettings(R2).cutoff, 'rallumée par l’utilisateur : nouvelle fenêtre (les anciens jugements ne recoupent pas)', JSON.stringify(y));
  }

  section('8. Panne d’un appel : lot suspendu, aucun repli caché');
  {
    const R3 = newRoot('fail');
    await KG.build(R3, { corpus: CORPUS, repo: null });
    KG.writeKgSwitch(R3, { key: 'extract', on: true });
    const n0 = calls().length;
    const r = await KG.extract(R3, { corpus: CORPUS, env: fakeEnv({ FAKE_CLAUDE_KG_FAIL: '1' }), only: 'memory', max: 10 });
    ok(r.ok && r.suspended && r.proposed === 0 && calls().length - n0 === 1, 'premier appel en échec : lot arrêté, rien de proposé', JSON.stringify(r));
    ok(KG.kgStatus(R3).extraction.suspended?.why, 'état : extraction suspendue, avec la raison');
  }

  section('9. Péremption, sauvegarde, balayage');
  {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const st = KG.foldFacts([{ ev: 'assert', at: old, fact: { id: 'f-old', s: 'a', p: 'mentions', o: 'b', by: 'model:x', status: 'proposed', recorded_at: old } }]);
    ok(st.facts.get('f-old').status === 'to_review', 'fait de model non revu depuis 90 jours : « à revoir »');
    const b1 = KG.backupFacts(R);
    const b2 = KG.backupFacts(R);
    ok(b1.ok && fs.existsSync(b1.file) && b2.skipped, 'sauvegarde quotidienne de facts.jsonl (une par jour)');
    const R4 = newRoot('sweep');
    await KG.build(R4, { corpus: CORPUS, repo: null });
    const s0 = await KG.sweep(R4, { hour: 12 });
    ok(!s0.build && !s0.extract, 'kg.build et kg.extract coupés : pas de reconstruction ni d’appel');
    KG.writeKgSwitch(R4, { key: 'build', on: true });
    const s1 = await KG.sweep(R4, { hour: 12 });
    ok(!s1.build, 'sources inchangées : pas de reconstruction', JSON.stringify(s1));
    fs.appendFileSync(path.join(CORPUS, 'memory', 'user_profile.md'), '\nAjout.\n');
    const s2 = await KG.sweep(R4, { hour: 12 });
    ok(s2.build && s2.build.nodes > 0, 'une mémoire change : reconstruction', JSON.stringify(s2));
  }

  section('10. Extrait de source : seulement ce que l’index connaît');
  {
    const ex = KG.sourceExcerpt(R, 'memory:chef/feedback_all_opus5.md', 10);
    ok(ex.ok && ex.lines.some(l => l.text.includes('claude-opus-5-5')), 'extrait d’une mémoire connue');
    ok(KG.sourceExcerpt(R, '../../.env').status === 404, 'clé inconnue : 404 (jamais un chemin libre)');
    const sec = KG.sourceExcerpt(R, 'memory:chef/reference_secret.md', 1);
    ok(sec.ok && !JSON.stringify(sec).includes(SECRET_HEX), 'secrets masqués dans l’extrait');
  }

  section('11. Ligne de commande (ce que le serveur appelle)');
  {
    const no = cli(R, ['review', '--json']);
    ok(no.status === 2 && /kg\.ui = off/.test(no.stderr), 'kg.ui coupé : review refusé');
    KG.writeKgSwitch(R, { key: 'ui', on: true });
    const st = cli(R, ['status', '--json']);
    const sj = JSON.parse(st.stdout);
    ok(st.status === 0 && sj.switches.ui && sj.index && sj.review && sj.extraction.health, 'status --json', st.stderr);
    const rv = JSON.parse(cli(R, ['review', '--json']).stdout);
    ok(rv.ok && Array.isArray(rv.items), 'review --json');
    const ru = JSON.parse(cli(R, ['rules', '--projet', 'boxapp', '--json']).stdout);
    ok(ru.ok && Array.isArray(ru.inForce) && ru.inForce.every(x => Array.isArray(x.chain)), 'rules --json (chaîne des remplacements)');
    const it = rv.items.find(i => (i.kind === 'fact' || i.kind === 'stale') && i.actions.includes('validate'));
    ok(it && it.kind === 'stale', 'revue : un fait dérivé « à revoir » (port muet) se valide aussi');
    const d = cli(R, ['decide', '--json'], JSON.stringify({ id: it.id, action: 'validate', rev: it.rev, commandId: cmd() }));
    ok(d.status === 0 && JSON.parse(d.stdout).ok, 'decide (corps JSON sur stdin)', d.stderr + d.stdout);
    const d2 = cli(R, ['decide', '--json'], JSON.stringify({ id: it.id, action: 'validate', rev: it.rev, commandId: cmd() }));
    ok(d2.status === 9 && JSON.parse(d2.stdout).status === 409, 'decide en conflit de révision : code 9 et statut 409');
  }

  section('12. Ni les tours ni le serveur ne chargent kg.mjs ; chaque écriture est gardée sous logs/kg');
  {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'kg.mjs'), 'utf8');
    const uses = [...src.split('\n').filter(l => !/^import /.test(l)).join('\n').matchAll(/\b(appendLines|withExclusiveLock|removeFile)\(([^\n]{0,20})/g)].map(m => m[0]);
    ok(uses.length === 3 && uses.every(c => /\(kgPath\(/.test(c)), 'ajouts, verrou et suppressions : toujours sur un chemin vérifié par kgPath (logs/kg ou logs/kg/backup)', uses.join(' | '));
    ok(!/fs\.(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|copyFileSync|cpSync)\(/.test(src), 'aucune écriture directe dans kg.mjs');
    const graph = referenceGraph(REPO, repoFiles(REPO));
    for (const root of ['scripts/dispatch.mjs', 'server.js', 'scripts/pipeline-engine.mjs', 'scripts/auto-answer.mjs', 'scripts/chef-turn.mjs'])
      ok(!importClosure(graph, [root]).has('scripts/kg.mjs'), `${root} n’importe pas kg.mjs`);
  }
} catch (e) {
  fail++;
  console.log(`  ✗ exception : ${e.stack}`);
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
