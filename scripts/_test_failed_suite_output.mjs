#!/usr/bin/env node
// ============================================================================
// scripts/_test_failed_suite_output.mjs — the full output of a failed suite is
// kept by regression.mjs (0.73.0)
// ============================================================================
//
// User request (2026-10-11): "Conserver toute la sortie d'une suite en échec
// dans regression.mjs" — "2. oui". Until 0.72.1 the report kept only the LAST
// line of a suite: the 3 failed checks of _test_model_backoff.mjs and the stack
// of _test_responses_shim.mjs were lost after the full run.
//
// Real child processes (fake suites in a throw-away folder) through the same
// runSuite() regression.mjs uses, plus the wiring in regression.mjs itself.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuite } from './suite-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-suite-output-'));
const OUT = path.join(T, 'suite-output', 'worktree-run');
try {
  // A failing suite: many lines on stdout AND stderr, the failed checks in the middle.
  fs.writeFileSync(path.join(T, '_test_fake_fail.mjs'), [
    "for (let i = 1; i <= 200; i++) console.log(`  ✓ contrôle ${i}`);",
    "console.log('  ✗ contrôle 201 : attendu retry, obtenu elapsed');",
    "console.error('détail sur stderr : délai dépassé');",
    "for (let i = 202; i <= 250; i++) console.log(`  ✓ contrôle ${i}`);",
    "console.log('\\n✗ 249 réussis, 1 échoués');",
    'process.exitCode = 1;',
  ].join('\n'));
  // A crashing suite (like _test_responses_shim.mjs): uncaught TypeError, stack on stderr.
  fs.writeFileSync(path.join(T, '_test_fake_crash.mjs'), "console.log('── 6. Bout en bout');\nconst res = undefined;\nconsole.log(JSON.stringify(res).slice(0, 300));\n");
  fs.writeFileSync(path.join(T, '_test_fake_ok.mjs'), "console.log('  ✓ tout va bien');\nconsole.log('\\n1 ok, 0 KO');\n");

  console.log('\n── 1. Suite en échec : sortie complète conservée');
  let r = await runSuite(path.join(T, '_test_fake_fail.mjs'), T, { failedOutputDir: OUT });
  const txt = r.outputFile && fs.existsSync(r.outputFile) ? fs.readFileSync(r.outputFile, 'utf8') : '';
  ok(!r.ok && r.code === 1 && r.tail === '✗ 249 réussis, 1 échoués', `code 1, dernière ligne inchangée dans le rapport (« ${r.tail} »)`);
  ok(!!r.outputFile && path.dirname(r.outputFile) === OUT && /_test_fake_fail\.mjs\.log$/.test(r.outputFile), `un fichier par suite en échec : ${r.outputFile && path.relative(T, r.outputFile)}`);
  ok(/✓ contrôle 1\n/.test(txt) && /✓ contrôle 200\n/.test(txt) && /✓ contrôle 250\n/.test(txt), 'TOUTES les lignes de stdout, de la première à la dernière');
  ok(/✗ contrôle 201 : attendu retry, obtenu elapsed/.test(txt), 'le contrôle en échec (au milieu de la sortie) est retrouvable');
  ok(/détail sur stderr : délai dépassé/.test(txt), 'stderr conservé aussi');
  ok(/^# .*_test_fake_fail\.mjs — exit 1 — \d+ s/.test(txt), 'en-tête : suite, code de sortie, durée');

  console.log('\n── 2. Suite qui plante (exception non interceptée)');
  r = await runSuite(path.join(T, '_test_fake_crash.mjs'), T, { failedOutputDir: OUT });
  const crash = r.outputFile ? fs.readFileSync(r.outputFile, 'utf8') : '';
  ok(!r.ok && /^Node\.js v/.test(r.tail), `le rapport ne voit que « ${r.tail} »`);
  ok(/TypeError: Cannot read properties of undefined \(reading 'slice'\)/.test(crash) && /_test_fake_crash\.mjs:3/.test(crash) && /── 6\. Bout en bout/.test(crash),
    'le fichier garde l’erreur, la ligne en cause et ce qui précédait');

  console.log('\n── 3. Suite verte : rien n’est écrit');
  r = await runSuite(path.join(T, '_test_fake_ok.mjs'), T, { failedOutputDir: OUT });
  ok(r.ok && r.outputFile === null && r.tail === '1 ok, 0 KO', 'OK, aucun fichier, dernière ligne comme avant');
  ok(fs.readdirSync(OUT).sort().join() === '_test_fake_crash.mjs.log,_test_fake_fail.mjs.log', `seules les suites en échec ont un fichier (${fs.readdirSync(OUT).join(', ')})`);

  console.log('\n── 4. Branchement dans regression.mjs');
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
  ok(/import \{ runNode, runSuite \} from '\.\/suite-runner\.mjs';/.test(src) && /await runSuite\(path\.join\(dir, f\), codeRoot, \{ failedOutputDir: FAILED_OUTPUT_DIR \}\)/.test(src),
    'runSuites passe par runSuite avec le dossier des sorties');
  ok(/const FAILED_OUTPUT_DIR = path\.join\(REGRESS_DIR, 'suite-output', /.test(src), 'dossier sous .regress/suite-output/<label>-<horodatage>/');
  ok(/record\('suite', f, f, r\.ok \? 'OK' : 'KO', `\$\{r\.tail\} \(\$\{r\.durationS\} s, exit \$\{r\.code\}\)`, output \? \{ output \} : null\)/.test(src) && /\.\.\.\(extra \|\| \{\}\)/.test(src),
    'rapport : même « detail » qu’avant, plus le champ additif « output » (chemin du fichier) pour une suite KO');
  ok(/^\.regress\/?$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')), '.regress/ est ignoré par git (sorties jamais versionnées)');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
