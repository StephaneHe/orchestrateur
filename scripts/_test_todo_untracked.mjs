#!/usr/bin/env node
// ============================================================================
// scripts/_test_todo_untracked.mjs — TODO_LIST.md is never tracked by git, and
// a production jump keeps it on disk (0.74.2)
// ============================================================================
//
// User request (2026-10-12, verbatim): « Une TODO list ne devrait pas etre
// dans git ». Fails if TODO_LIST.md is tracked again. Since production still
// tracks it, the fast-forward to a version that stops tracking it would delete
// it from the production disk: prod-jump puts it back from prod-before-<tag>.
// Also: a production commit unknown to the dev is refused before the jump.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflight, applyJump, keptOnDisk } from './prod-jump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const g = (repo, ...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL', ...a], { encoding: 'utf8', windowsHide: true });

console.log('\n── 1. Ce dépôt : TODO_LIST.md n’est pas suivi par git');
ok(g(ROOT, 'ls-files', '--error-unmatch', 'TODO_LIST.md').status !== 0, 'TODO_LIST.md absent de l’index (git ls-files)');
ok(g(ROOT, 'check-ignore', '-q', '--no-index', 'TODO_LIST.md').status === 0, 'TODO_LIST.md ignoré par .gitignore');
ok(g(ROOT, 'ls-files').stdout.split('\n').every(f => !/(^|\/)TODO_LIST\.md$/i.test(f)), 'aucun TODO_LIST.md suivi, à aucun niveau du dépôt');

console.log('\n── 2. Bond vers une version qui ne le suit plus : gardé sur le disque de la prod');
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-todo-'));
try {
  const DEV = path.join(R, 'dev'), PROD = path.join(R, 'prod');
  fs.mkdirSync(DEV);
  fs.writeFileSync(path.join(DEV, '.gitignore'), '.regress/\nlogs/\n');
  fs.writeFileSync(path.join(DEV, 'a.txt'), 'v1\n');
  fs.writeFileSync(path.join(DEV, 'TODO_LIST.md'), '# TODO\n- prod note\n');
  fs.writeFileSync(path.join(DEV, 'old.mjs'), 'export {}\n');
  g(DEV, 'init', '-q'); g(DEV, 'add', '-A'); g(DEV, 'commit', '-q', '-m', 'v1');
  spawnSync('git', ['clone', '-q', DEV, PROD], { windowsHide: true });
  g(DEV, 'rm', '--cached', '-q', 'TODO_LIST.md'); g(DEV, 'rm', '-q', 'old.mjs');
  fs.appendFileSync(path.join(DEV, '.gitignore'), 'TODO_LIST.md\n');
  g(DEV, 'add', '-A'); g(DEV, 'commit', '-q', '-m', 'v2 untrack todo'); g(DEV, 'tag', '-a', 'v2.0.0', '-m', 'v2');
  const tree = g(DEV, 'rev-parse', 'v2.0.0^{tree}').stdout.trim();
  fs.mkdirSync(path.join(DEV, '.regress'));
  fs.writeFileSync(path.join(DEV, '.regress', 'report-full.json'), JSON.stringify({ mode: 'full', tree, results: [{ id: 'suite:_test_x.mjs', status: 'OK' }] }));

  const head = g(PROD, 'rev-parse', 'HEAD').stdout.trim(), commit = g(DEV, 'rev-parse', 'v2.0.0^{commit}').stdout.trim();
  ok(JSON.stringify(keptOnDisk({ dev: DEV, prodHead: head, commit })) === '["TODO_LIST.md"]', 'gardé : TODO_LIST.md (plus suivi ET ignoré) ; old.mjs (vraie suppression) non gardé',
    JSON.stringify(keptOnDisk({ dev: DEV, prodHead: head, commit })));
  const p = preflight({ dev: DEV, prod: PROD, tag: 'v2.0.0', from: DEV });
  ok(p.ok && p.plan.some(s => /remettre TODO_LIST\.md sur le disque/.test(s)), 'le plan (bond à blanc) annonce la remise de TODO_LIST.md', p.problems.join(' | '));
  const j = applyJump({ prod: PROD, tag: 'v2.0.0', from: DEV, keep: p.keep });
  ok(j.ok && g(PROD, 'rev-parse', 'HEAD').stdout.trim() === commit, 'avance rapide faite', JSON.stringify(j));
  ok(fs.existsSync(path.join(PROD, 'TODO_LIST.md')) && fs.readFileSync(path.join(PROD, 'TODO_LIST.md'), 'utf8') === '# TODO\n- prod note\n' && j.restored.includes('TODO_LIST.md'),
    'TODO_LIST.md toujours sur le disque de la prod, contenu intact');
  ok(g(PROD, 'status', '--porcelain').stdout.trim() === '' && g(PROD, 'ls-files', '--error-unmatch', 'TODO_LIST.md').status !== 0, 'prod propre, TODO_LIST.md non suivi');
  ok(!fs.existsSync(path.join(PROD, 'old.mjs')), 'un fichier vraiment supprimé reste supprimé');

  console.log('\n── 3. Sans cette remise, l’avance rapide l’effacerait (justification)');
  const PROD2 = path.join(R, 'prod2');
  spawnSync('git', ['clone', '-q', '-b', 'master', DEV, PROD2], { windowsHide: true });
  g(PROD2, 'reset', '-q', '--hard', head);
  g(PROD2, 'merge', '-q', '--ff-only', commit);
  ok(!fs.existsSync(path.join(PROD2, 'TODO_LIST.md')), 'merge --ff-only seul : TODO_LIST.md effacé du disque');

  console.log('\n── 4. Un commit de la prod inconnu de la dev : bond refusé avant tout');
  const PROD3 = path.join(R, 'prod3');
  spawnSync('git', ['clone', '-q', DEV, PROD3], { windowsHide: true });
  g(PROD3, 'reset', '-q', '--hard', head);
  fs.writeFileSync(path.join(PROD3, 'note.txt'), 'prod only\n'); g(PROD3, 'add', '-A'); g(PROD3, 'commit', '-q', '-m', 'prod only');
  const p3 = preflight({ dev: DEV, prod: PROD3, tag: 'v2.0.0', from: DEV });
  ok(!p3.ok && /inconnu de la dev|pas d'avance rapide/.test(p3.problems.join(' ')), 'refusé : pas d’avance rapide vérifiable', p3.problems.join(' | '));
} finally {
  fs.rmSync(R, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
