#!/usr/bin/env node
// User requirement 2026-10-29 (« réduction des délais »): the dev instance
// declares a targetedTestCommand, so a pipeline step runs only the selected
// test files instead of `regression.mjs --targeted` over the whole perimeter.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suitesOf, regressionArgv } from './regression-files.mjs';
import { targetedCommand } from './pipeline-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (c, msg) => { console.log(`${c ? '  ok ' : '  KO '} ${msg}`); if (!c) fails++; };

// 1. The real pipeline.json: targeted command declared, full suite kept for after the fact.
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.orchestrateur', 'pipeline.json'), 'utf8'));
ok(/regression-files\.mjs/.test(cfg.targetedTestCommand || '') && cfg.targetedTestCommand.includes('{files}'), 'targetedTestCommand déclaré avec {files}');
ok(cfg.testCommand === 'node scripts/regression.mjs --targeted --no-browser', 'testCommand inchangé');

// 2. The engine builds the command from it, and the launcher keeps only those suites (dry run).
const files = ['scripts/_test_regression_files.mjs', 'scripts/_test_stale_run.mjs', 'tests/fake_claude/fake_claude.mjs', 'scripts/_regression_sandbox.mjs'];
const t = targetedCommand(ROOT, cfg, files);
ok(t.command === `node scripts/regression-files.mjs ${files.join(' ')}`, `commande ciblée construite (${t.command || t.why})`);
ok(JSON.stringify(suitesOf(files)) === JSON.stringify(['_test_regression_files.mjs', '_test_stale_run.mjs']), 'seules les suites scripts/_test_*.mjs sont gardées');
ok(JSON.stringify(suitesOf(['scripts\\_test_a.mjs', 'scripts/_test_a.mjs', 'android/_test_b.mjs'])) === '["_test_a.mjs"]', 'antislash, doublon et autre dossier');
const argv = regressionArgv(['_test_a.mjs', '_test_b.mjs']);
ok(argv.slice(1).join(' ') === '--only-suites _test_a.mjs,_test_b.mjs --no-browser', 'regression.mjs --only-suites, sans navigateur');
const dry = spawnSync(process.execPath, ['scripts/regression-files.mjs', '--dry-run', ...files], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
ok(dry.status === 0 && /--only-suites","_test_regression_files\.mjs,_test_stale_run\.mjs"/.test(dry.stdout), 'essai à sec : 2 suites seulement');
const none = spawnSync(process.execPath, ['scripts/regression-files.mjs', 'tests/x.mjs'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
ok(none.status === 0 && /rien à lancer/.test(none.stdout), 'aucune suite : rien lancé, code 0');

console.log(fails ? `\n${fails} échec(s)` : '\nOK');
process.exit(fails ? 1 : 0);
