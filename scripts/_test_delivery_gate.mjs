#!/usr/bin/env node
// ============================================================================
// scripts/_test_delivery_gate.mjs — no delivery with a red suite (0.71.3)
// ============================================================================
//
// User request (2026-10-11, verbatim): « La non-régression du n° 8 n'était pas
// entièrement verte : 168 OK, 1 KO, 3 NA. La suite _test_pool_chef_dispatch.mjs
// sort en erreur Node (exit 1) au bout d'1 s. Le correctif a pourtant été
// livré. => Comment est-ce possible ? Ca ne devrait pas arriver ».
//
// Checks, on a throw-away git repository:
//   - a delivery commit (package.json version bump) is REFUSED by the git
//     hook when the report of that exact content has a KO, or when no report
//     was made on that content;
//   - a green report on the same content lets it through;
//   - a KO is accepted only if listed with its reason in docs/known-ko.json,
//     and it is then printed (never silent);
//   - a non-delivery commit (docs) is not blocked;
//   - `regression.mjs --compare` refuses a KO that already existed before
//     (the exact hole of incident n° 8: "0 regressions" with a red suite);
//   - _test_pool_chef_dispatch.mjs no longer depends on the production log.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as G from './delivery-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-'));
const git = (...a) => spawnSync('git', ['-C', T, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { encoding: 'utf8', windowsHide: true });
fs.mkdirSync(path.join(T, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(T, 'docs'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'scripts', 'delivery-gate.mjs'), path.join(T, 'scripts', 'delivery-gate.mjs'));
fs.writeFileSync(path.join(T, '.gitignore'), '.regress/\n');
fs.writeFileSync(path.join(T, 'package.json'), JSON.stringify({ name: 'g', version: '1.0.0' }, null, 2) + '\n');
fs.writeFileSync(path.join(T, 'docs', 'known-ko.json'), '[]\n');
git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'init');
const inst = spawnSync(process.execPath, [path.join(T, 'scripts', 'delivery-gate.mjs'), 'install-hook', '--repo', T], { encoding: 'utf8' });
const report = (results, tree) => {
  fs.mkdirSync(path.join(T, '.regress'), { recursive: true });
  const f = path.join(T, '.regress', `report-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(f, JSON.stringify({ label: 'worktree', at: new Date().toISOString(), tree, results }));
  return f;
};
const GREEN = [{ id: 'suite:_test_a.mjs', stage: 'suite', name: 'a', status: 'OK' }, { id: 'http:x', stage: 'http', name: 'x', status: 'NA' }];
const RED = [...GREEN, { id: 'suite:_test_pool_chef_dispatch.mjs', stage: 'suite', name: 'pool', status: 'KO', detail: 'Node.js v24 (1 s, exit 1)' }];
const bump = (v) => { fs.writeFileSync(path.join(T, 'package.json'), JSON.stringify({ name: 'g', version: v }, null, 2) + '\n'); git('add', '-A'); };
const commit = (msg) => git('commit', '-q', '-m', msg);
const clearReports = () => fs.rmSync(path.join(T, '.regress'), { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('1. Commit de livraison (version changée) : refusé avec une suite rouge, autorisé seulement si tout est vert');
ok(inst.status === 0 && fs.readFileSync(path.join(T, '.git', 'hooks', 'pre-commit'), 'utf8').includes('delivery-gate.mjs'), 'hook pre-commit installé');
bump('1.1.0');
report(RED, G.stagedTree(T));
let c = commit('release 1.1.0');
ok(c.status !== 0 && /LIVRAISON REFUSÉE/.test(c.stderr) && /_test_pool_chef_dispatch/.test(c.stderr), 'suite rouge sur ce contenu : commit refusé, la suite est nommée', c.stderr);
clearReports();
c = commit('release 1.1.0');
ok(c.status !== 0 && /aucun rapport/.test(c.stderr), 'aucun rapport : commit refusé', c.stderr);
report(GREEN, 'deadbeef');
c = commit('release 1.1.0');
ok(c.status !== 0 && /pas été fait sur ce contenu/.test(c.stderr), 'rapport vert mais fait sur un AUTRE contenu : refusé', c.stderr);
report(GREEN, G.stagedTree(T));
c = commit('release 1.1.0');
ok(c.status === 0 && /LIVRAISON AUTORISÉE/.test(c.stderr), 'rapport vert sur ce contenu : commit accepté', c.stderr);

// ---------------------------------------------------------------------------
section('2. KO accepté seulement s’il est listé avec sa raison, et toujours affiché');
clearReports();
bump('1.2.0');
fs.writeFileSync(path.join(T, 'docs', 'known-ko.json'), JSON.stringify([{ id: 'suite:_test_pool_chef_dispatch.mjs', reason: 'dépend d’un log absent du clone (test)' }]));
git('add', '-A');
report(RED, G.stagedTree(T));
c = commit('release 1.2.0');
ok(c.status === 0 && /KO accepté \(docs\/known-ko\.json\) : suite:_test_pool_chef_dispatch\.mjs — dépend/.test(c.stderr), 'KO listé : accepté ET affiché avec sa raison', c.stderr);
ok(G.readKnownKo(T).length === 1 && G.checkReport({ results: RED }, { knownKo: [{ id: 'suite:_test_pool_chef_dispatch.mjs', reason: '  ' }] }).ok === false, 'une entrée sans raison n’accepte rien');

// ---------------------------------------------------------------------------
section('3. Un commit qui n’est pas une livraison (version inchangée) n’est pas bloqué');
clearReports();
fs.writeFileSync(path.join(T, 'docs', 'note.md'), 'note\n'); git('add', '-A');
c = commit('docs: note');
ok(c.status === 0, 'commit de documentation accepté sans rapport', c.stderr);

// ---------------------------------------------------------------------------
section('4. regression.mjs --compare refuse un KO déjà présent avant (le trou de l’incident n° 8)');
const a = path.join(T, 'avant.json'), b = path.join(T, 'apres.json');
fs.writeFileSync(a, JSON.stringify({ label: 'avant', results: RED })); fs.writeFileSync(b, JSON.stringify({ label: 'apres', results: RED }));
const cmp = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'regression.mjs'), '--compare', a, b], { encoding: 'utf8', cwd: ROOT });
ok(cmp.status !== 0 && /Régressions : 0/.test(cmp.stdout) && /Livraison : REFUSÉE/.test(cmp.stdout), `0 régression mais une suite rouge : --compare sort en ${cmp.status} et dit « REFUSÉE »`, cmp.stdout.slice(-400));
fs.writeFileSync(b, JSON.stringify({ label: 'apres', results: GREEN }));
const cmp2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'regression.mjs'), '--compare', a, b], { encoding: 'utf8', cwd: ROOT });
ok(cmp2.status === 0 && /Livraison : AUTORISÉE/.test(cmp2.stdout), 'tout vert après : AUTORISÉE');

// ---------------------------------------------------------------------------
section('5. La cause du KO est réparée : _test_pool_chef_dispatch.mjs ne dépend plus du log de la prod');
const src = fs.readFileSync(path.join(ROOT, 'scripts', '_test_pool_chef_dispatch.mjs'), 'utf8');
ok(!/fs\.statSync\(path\.join\(ROOT, 'logs', 'orchestrateur\.jsonl'\)\)/.test(src) && /const sizeOf = \(f\) => \{ try \{ return fs\.statSync\(f\)\.size; \} catch \{ return 0; \} \};/.test(src), 'plus de statSync direct sur logs/orchestrateur.jsonl (absent d’un clone neuf)');

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
