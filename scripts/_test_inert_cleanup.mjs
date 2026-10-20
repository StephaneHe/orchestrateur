#!/usr/bin/env node
// ============================================================================
// scripts/_test_inert_cleanup.mjs — pipelines phase 0 d: the unusable custom
// pipeline and the old keyword attachments are removed, with a backup
// ============================================================================
//
// User decision 7 (2026-10-20, « tout comme recommandé » on
// docs/PIPELINES-SYNTHESE.md): « Nettoyage : retirer le pipeline inutilisable
// x-7e4cf1 (remplacé par « Opérations ») et les 11 rattachements à mots-clés
// devenus inertes, avec sauvegarde. » — and every lever has its switch,
// re-read without restart.
//
// The fixture has the SHAPE of the production model-routing.json (one custom
// pipeline the engine cannot run, eleven attachments written before 0.66.0
// with `keywords`), anonymised (public repository), plus what must survive:
// an attachment accepted since 0.66.0 (no keywords), a custom step, a custom
// variant, the assignments, the history.
//
// Protected:
//   - « inert » is recognised by FORM (id not run by the engine; `keywords`
//     present), never by words;
//   - switch `inertCleanup` on: the classifier and the Models page no longer
//     see them (shorter classification prompt), at once, without writing;
//     off = exactly as before;
//   - `pipeline-cleanup.mjs apply`: backup byte for byte, removes only them,
//     history entry, idempotent; `restore` puts them back, nothing else lost.
//
//   node scripts/_test_inert_cleanup.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inertCustom, withoutInert, EXECUTABLE_PIPELINES } from './inert-custom.mjs';
import { classifierChoices, classificationPrompt } from './pipeline-classify.mjs';
import { createModelRouting } from './model-routing.mjs';
import { ENGINE_PIPELINES } from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-inert-'));
const OLD = Array.from({ length: 11 }, (_, i) => ({ pipeline: ['audit', 'recherche', 'dev', 'discussion'][i % 4], keywords: ['mot', `clé${i}`, 'ancien'], when: `« Demande ancienne numéro ${i} coupée au milieu d’une phrase sans rapport avec le pipeline »` }));
const NEW_ATTACH = { pipeline: 'redaction', when: '« Rédiger le compte rendu d’une démarche administrative »' };
const routing = {
  version: 2, updatedAt: null,
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'x-7e4cf1.cadrer': { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
  history: [{ at: '2026-10-01T00:00:00.000Z', task: 'dev.vert', from: null, to: 'x', by: 't' }],
  gapDecisions: { 'aucun-pipeline:deploiement': { decision: 'accepted', applied: { kind: 'pipeline', pipeline: 'x-7e4cf1' } } },
  custom: {
    attach: [...OLD.slice(0, 6), NEW_ATTACH, ...OLD.slice(6)],
    pipelines: [{ id: 'x-7e4cf1', label: 'proposition du model de classement : Il manque un pipeline d', icon: '✦', purpose: 'Ajouté depuis une lacune', when: 'proposition du model de classement : déploiement',
      flow: [{ id: 'cadrer', n: '1', title: 'Cadrer', what: 'Préciser', judge: true }, { id: 'realiser', n: '2', title: 'Réaliser', what: 'Faire' }] }],
    steps: [{ pipeline: 'audit', after: 'cartographier', step: { id: 'verif-perso', n: '1b', title: 'Vérification perso', what: 'x' } }],
    variants: [{ pipeline: 'redaction', step: 'rediger', variant: { id: 'courriel-perso', label: 'Courriel perso', what: 'x' } }],
  },
  enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
};
const FILE = path.join(T, 'model-routing.json');
const write = (j) => fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n');
const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ projects: [{ name: 'P', path: T }] }));

// ---------------------------------------------------------------------------
section('1. Reconnu par sa forme : non exécutable par le moteur, ou porteur de mots-clés');
{
  const inert = inertCustom(routing.custom);
  ok(inert.pipelines.length === 1 && inert.pipelines[0].id === 'x-7e4cf1', 'le pipeline ajouté que le moteur ne sait pas exécuter');
  ok(inert.attach.length === 11 && inert.attach.every(a => /Demande ancienne/.test(a.when)), 'les 11 rattachements à mots-clés (avant 0.66.0)');
  const kept = withoutInert(routing.custom);
  ok(kept.attach.length === 1 && kept.attach[0] === NEW_ATTACH && kept.steps.length === 1 && kept.variants.length === 1 && !kept.pipelines.length, 'gardés : rattachement récent (sans mots-clés), étape et variante ajoutées');
  ok(JSON.stringify(EXECUTABLE_PIPELINES.slice().sort()) === JSON.stringify(ENGINE_PIPELINES.slice().sort()), 'la liste des pipelines exécutables est celle du moteur');
}

section('2. Interrupteur coupé : rien ne change ; actif : classement et page Models sans eux, à chaud');
{
  write(routing);
  const before = fs.readFileSync(FILE);
  let ch = classifierChoices(T);
  const promptOff = classificationPrompt('Pousse la branche', {}, ch);
  ok(ch.some(p => p.id === 'x-7e4cf1') && /Demande ancienne numéro 3/.test(promptOff), 'coupé : le classement voit le pipeline et les phrases des rattachements (comme avant)');
  const mr = createModelRouting({ root: T, cacheFile: path.join(T, 'cache.json'), fetch: async () => { throw new Error('offline'); }, env: { CODEX_HOME: T }, which: () => false });
  ok(mr.effective().slots.some(s => s.id === 'x-7e4cf1.cadrer'), 'coupé : la page Models montre ses cases');

  const on = JSON.parse(JSON.stringify(routing)); on.enforcement.tuning = { inertCleanup: true };
  write(on);
  ch = classifierChoices(T);
  const promptOn = classificationPrompt('Pousse la branche', {}, ch);
  ok(!ch.some(p => p.id === 'x-7e4cf1') && !/Demande ancienne/.test(promptOn) && /démarche administrative/.test(promptOn), 'actif : ni le pipeline ni les vieux rattachements ; le rattachement récent reste');
  ok(promptOn.length < promptOff.length, `consigne de classement plus courte (${promptOff.length} → ${promptOn.length} caractères)`);
  ok(!mr.effective().slots.some(s => s.id.startsWith('x-7e4cf1.')) && mr.effective().slots.some(s => s.id === 'audit.verif-perso'), 'actif : la page Models ne montre plus ses cases, garde les ajouts utiles (relu à chaud)');
  ok(JSON.stringify(read().custom) === JSON.stringify(routing.custom), 'l’interrupteur n’écrit rien : model-routing.json garde tout');
  write(routing);
  ok(fs.readFileSync(FILE).equals(before) && classifierChoices(T).some(p => p.id === 'x-7e4cf1'), 'recoupé : tout revient');
}

// ---------------------------------------------------------------------------
section('3. Retrait avec sauvegarde, idempotent ; restauration');
const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline-cleanup.mjs'), ...a], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: T }, encoding: 'utf8' });
{
  write(routing);
  const original = fs.readFileSync(FILE);
  let r = cli('plan');
  ok(r.status === 0 && /12 ajout\(s\) inerte\(s\)/.test(r.stdout) && fs.readFileSync(FILE).equals(original), `plan : 12 ajouts listés, rien d’écrit (${r.stdout.split('\n')[0]})`);
  r = cli('apply', '--by', 'test');
  const bak = fs.readdirSync(T).find(f => f.startsWith('model-routing.json.bak-cleanup-'));
  ok(r.status === 0 && bak && fs.readFileSync(path.join(T, bak)).equals(original), `apply : sauvegarde identique octet pour octet (${bak})`, r.stderr);
  const after = read();
  ok(!after.custom.pipelines.length && after.custom.attach.length === 1 && after.custom.attach[0].when === NEW_ATTACH.when && after.custom.steps.length === 1 && after.custom.variants.length === 1, 'retirés : le pipeline et les 11 rattachements ; le reste de custom intact');
  ok(JSON.stringify(after.assignments) === JSON.stringify(routing.assignments) && JSON.stringify(after.gapDecisions) === JSON.stringify(routing.gapDecisions) && JSON.stringify(after.enforcement) === JSON.stringify(routing.enforcement), 'cases, décisions de lacunes et mise en service intactes');
  ok(after.history.at(-1).task === 'cleanup' && after.history.at(-1).by === 'test' && after.history.at(-1).backup === bak && after.history.length === 2, 'historique : une entrée « cleanup » qui nomme la sauvegarde');
  ok(!classifierChoices(T).some(p => p.id === 'x-7e4cf1'), 'le classement ne le voit plus, même interrupteur coupé');
  const once = fs.readFileSync(FILE);
  r = cli('apply');
  ok(r.status === 0 && /rien à retirer/.test(r.stdout) && fs.readFileSync(FILE).equals(once) && fs.readdirSync(T).filter(f => f.includes('bak-cleanup')).length === 1, 'deuxième apply : rien à faire, aucune écriture, aucune nouvelle sauvegarde');
  // A change made after the cleanup must survive the restore.
  const later = read(); later.assignments['dev.vert'] = { provider: 'anthropic', model: 'claude-opus-5-5' }; write(later);
  r = cli('restore', path.join(T, bak));
  const back = read();
  ok(r.status === 0 && back.custom.pipelines.some(p => p.id === 'x-7e4cf1') && back.custom.attach.length === 12 && back.assignments['dev.vert']?.model === 'claude-opus-5-5', `restore : les 12 ajouts remis, la modification faite depuis gardée (${r.stdout.trim()})`, r.stderr);
  r = cli('restore', path.join(T, 'ailleurs.json'));
  ok(r.status === 64, 'restore : seule une sauvegarde du nettoyage, à la racine, est acceptée');
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* Windows */ }
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
