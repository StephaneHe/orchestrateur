#!/usr/bin/env node
// ============================================================================
// scripts/_test_ref_snapshot.mjs — regression.mjs --ref: the git-based suites
// see the tested state (0.74.3)
// ============================================================================
//
// User request (2026-10-12): « des que tu peux mets a jour, ne t'arretes pas
// tant que ce n'est pas fait » — the full run on a tag (--ref) failed
// _test_phase2_5_integrated and _test_targeted_regression: the suites run in a
// copy extracted under the ignored .regress/ of the dev checkout, so git saw
// none of its files. snapshotRepo makes the copy its own repository.
// The copy is built exactly like regression.mjs does (extractCode), inside a
// throw-away parent repository that ignores .regress/.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractCode, snapshotRepo } from './_regression_sandbox.mjs';
import { selectTargets } from './regression-targets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', windowsHide: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ref-'));

try {
  const parent = path.join(T, 'dev');
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, '.gitignore'), '.regress/\n');
  git(parent, 'init', '-q'); git(parent, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'); git(parent, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'p');
  const copy = path.join(parent, '.regress', 'vX-code-test');
  extractCode({ ref: 'HEAD' }, copy);

  console.log('\n── 1. Le défaut : copie extraite sous un .regress/ ignoré');
  ok(git(copy, 'ls-files').stdout.trim() === '', 'avant : git ne voit aucun fichier de la copie');
  ok(selectTargets(copy, ['src/message_router.mjs']).full === true, 'avant : la sélection ciblée croit le fichier « couvert par rien »');

  console.log('\n── 2. La correction : la copie est son propre dépôt');
  const top = snapshotRepo(copy);
  ok(path.resolve(top) === path.resolve(copy), `racine git = la copie (${top})`);
  const tracked = git(copy, 'ls-files').stdout.split('\n').filter(Boolean);
  const expected = git(ROOT, 'ls-tree', '-r', '--name-only', 'HEAD').stdout.split('\n').filter(Boolean);
  ok(tracked.length === expected.length && tracked.includes('scripts/regression.mjs'), `exactement les fichiers du commit testé (${tracked.length} / ${expected.length})`);
  ok(git(copy, 'status', '--porcelain').stdout.trim() === '', 'copie propre après l’instantané');
  const s = selectTargets(copy, ['src/message_router.mjs']);
  ok(!s.full && s.suites.some(x => x.file === '_test_phase2_5_override.mjs'), 'la sélection ciblée retrouve les suites qui couvrent le fichier', JSON.stringify(s).slice(0, 300));
  ok(git(parent, 'status', '--porcelain').stdout.trim() === '', 'le dépôt parent n’est pas touché');

  console.log('\n── 3. Une suite qui échouait sous --ref passe dans la copie');
  const r = spawnSync(process.execPath, [path.join(copy, 'scripts', '_test_phase2_5_integrated.mjs')], { cwd: copy, encoding: 'utf8', windowsHide: true });
  ok(r.status === 0, `_test_phase2_5_integrated.mjs dans la copie : exit ${r.status}`, (r.stdout || '').split('\n').filter(l => /✗/.test(l)).join(' | '));

  console.log('\n── 4. regression.mjs fait l’instantané juste après l’extraction');
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
  ok(/extractCode\(source, codeRoot\);[\s\S]{0,300}snapshotRepo\(codeRoot\);[\s\S]{0,200}config\.json/.test(src), 'extractCode → snapshotRepo → fichiers locaux (config.json…)');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
