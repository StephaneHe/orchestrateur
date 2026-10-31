// ============================================================================
// scripts/aside-rework.mjs — items set aside less often, and never lost (0.139.0)
// ============================================================================
//
// Chef's finding on six psyProfile runs of the full Development (2026-10-22/23,
// replayed by _test_aside_rework.mjs on p-20261022T221404-3a1835): up to half
// of the items were never delivered, and every resume cost one pause per item.
// User rule behind it: « arrête de poser des questions de découpage. tu sais
// comment est organisé le process mieux que moi ».
//
// Causes found in the run files, each with its own switch (pipeline-tuning.mjs,
// frozen per run, off = exactly the engine of 0.138.0):
//
//   itemTestFix — the Review asked to fix the header of the item's own test
//     (« Item 4 » → « Item 8 »), but the correction step (4b) refuses any test
//     change: refused, re-reviewed, set aside (7 items out of 8). The item's
//     own tests are not delivered yet: the correction may edit them, every
//     other test stays protected.
//   testWrong — 4b proved the item's own test wrong (a folder shared by two
//     cases) and had no way back to 4a: three refusals, set aside. 4b may now
//     say « TEST_FAUX: <reason> » and the item goes back to 4a to fix its test.
//   asideRedo — a set-aside patch that no longer applies (every item adds a
//     row to the same requirements file) was « discarded », item lost. It is
//     now REDONE from the current code (4a → 4b on today's tree), its patch
//     given as a hint only. Once per item.
//   asideGroup — the remaining conflicts make ONE pause, not one per item.
//
// Pure helpers and git plumbing only; the engine decides.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { groupOf, attachedCase } from './item-review.mjs';

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, '') };
}

const LOCAL_ONLY = /^(\.orchestrateur\/runs|\.claude)(\/|$)/;

/**
 * Test files written or changed since `from` (the last delivered commit):
 * the item's own tests, not delivered yet. `isTest(file)` says what a test is.
 */
export function ownTestFiles(cwd, from, isTest) {
  if (!from) return [];
  const changed = git(cwd, ['diff', '--name-only', '--no-renames', from, '--', '.']).out.split('\n');
  const added = git(cwd, ['ls-files', '--others', '--exclude-standard']).out.split('\n');
  return [...new Set([...changed, ...added].map(f => f.trim()).filter(Boolean))]
    .filter(f => !LOCAL_ONLY.test(f) && isTest(f) && fs.existsSync(path.join(cwd, f))).sort();
}

/** The protected test prints minus the item's own tests (a new Map). */
export function withoutOwnTests(print, own) {
  const out = new Map(print || []);
  for (const f of own || []) out.delete(f);
  return out;
}

export const TEST_WRONG_MARK = 'TEST_FAUX';
/** Reason given by 4b in vert.md (« TEST_FAUX: <reason> », at least 10 characters), else null. */
export function testWrongClaim(art) {
  const m = new RegExp(`^\\s*\\**${TEST_WRONG_MARK}\\**\\s*:\\s*(.+)$`, 'm').exec(String(art || ''));
  const why = m ? m[1].replace(/\s+/g, ' ').trim() : '';
  return why.length >= 10 ? why.slice(0, 800) : null;
}
/** Back to 4a for the same item at most this many times. */
export const TEST_WRONG_ROUNDS = 2;

/** tests.md with every case of group `g` (the item and its attached cases) open again. */
export function uncheckGroup(md, g) {
  let n = 0, count = 0;
  const text = String(md || '').split(/(\r?\n)/).map(part => {
    const m = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.+)$/.exec(part);
    if (!m) return part;
    n++;
    if (groupOf({ n, text: m[4] }) !== g || m[2] === ' ') return part;
    count++;
    return `${m[1]} ${m[3]}${m[4]}`;
  }).join('');
  return { md: text, unchecked: count };
}

/** tests.md with a case attached to group 0 appended at the END (inserting earlier would
 *  renumber the cases of items set aside or open). Only trailing whitespace is trimmed. */
export function appendItemZeroCase(md, text) {
  return `${String(md || '').replace(/\s*$/, '')}\n${attachedCase(0, text)}\n`;
}

/** Copies the set-aside patch into the run's artefact folder (readable by the model, inside the project). */
export function patchHint(srcPatch, artDir, g) {
  const dest = path.join(artDir, `aside-item-${g}.patch`);
  try { fs.mkdirSync(artDir, { recursive: true }); fs.copyFileSync(srcPatch, dest); return dest; } catch { return null; }
}

/** Lines of the 4a / 4b prompt for an item redone from the current code. */
export function redoLines(hint) {
  if (!hint) return [];
  return [`REPRISE_REFAITE=${hint.group}`,
    `Cet item avait été mis de côté (${hint.why}) ; ses modifications ne s’appliquent plus sur le code livré depuis. Il est REFAIT à partir du code ACTUEL : repars de l’état présent du projet.`,
    hint.patch ? `L’ancienne tentative est dans ${hint.patch} : une INDICATION seulement (le code a changé depuis), ne l’applique pas telle quelle.` : ''].filter(Boolean);
}

/** Lines of the correction step when the item's own tests may be edited. */
export function ownTestsLines(own) {
  if (!own?.length) return [];
  return [`TESTS_DE_L_ITEM=${own.join(',')}`,
    `Les fichiers de test de CET item ne sont pas encore livrés : tu peux les modifier (${own.join(', ')}), uniquement pour corriger ce que la revue relève (en-tête, commentaire, nom, structure du test) — jamais pour les affaiblir : chacun doit toujours vérifier le comportement de l’item. Tous les autres tests restent protégés (tu peux en ajouter).`];
}

/** Line of the 4b prompt that offers the way back to 4a. */
export function testWrongLine() {
  return `Si tu établis que le test de l’étape 4a est FAUX (aucun code correct ne peut le faire passer : état partagé entre deux cas, attente erronée…), ne le contourne jamais et ne modifie pas le code pour lui : écris en tête de vert.md une ligne « ${TEST_WRONG_MARK}: <la raison précise, avec le fichier et la ligne du test> ». L’orchestrateur renvoie alors l’item à l’étape 4a pour corriger son test, puis revient ici.`;
}

/** Line of the 4a prompt when 4b found the test wrong. */
export function testFixLines(fix) {
  if (!fix) return [];
  return [`${TEST_WRONG_MARK}=${fix.round}`,
    `L’étape 4b a établi que le test de cet item est FAUX : « ${fix.why} ». Corrige CE test${fix.files?.length ? ` (${fix.files.join(', ')})` : ''} pour qu’il vérifie fidèlement l’item, sans l’affaiblir ; il doit toujours ÉCHOUER sur le code actuel, à cause du comportement manquant (l’étape 4b écrira le code ensuite).`];
}

/** Review line: a finding on the item's own test is fixed now, never « at delivery ». */
export function reviewOwnTestsLine() {
  return 'Un constat sur un TEST de cet item (en-tête, commentaire, nom, structure) va dans « hors_tdd » : il est corrigé tout de suite par l’étape de correction, qui peut modifier les tests de cet item. Ne le reporte jamais « à l’étape Livrer » : chaque item est livré par l’orchestrateur, sans autre étape.';
}

/** Diagnosis added to the reason of an item set aside at 4b (« le code ne fait pas passer le test »). */
export function greenAsideDiagnosis({ files, isTest, claim }) {
  const onlyTests = (files || []).length > 0 && files.every(f => isTest(f));
  const parts = [];
  if (onlyTests) parts.push('le correctif gardé ne contient que les tests de l’étape 4a : le code de chaque essai refusé de 4b a été annulé');
  if (claim) parts.push(`4b juge le test faux : « ${claim} »`);
  return parts.join(' ; ');
}
