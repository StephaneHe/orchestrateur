#!/usr/bin/env node
// ============================================================================
// scripts/_test_clean_copy_check.mjs — clean-copy validation of a project's
// testCommand, and alerts that name the failed tests (0.145.0)
// ============================================================================
//
// User agreement (2026-10-24): « oui », to the chef's two proposals after the
// first night of after-the-fact full runs (two projects red only because a file
// ignored by git was missing from a clean copy; an alert saying « KO :
// testCommand » while 1 test out of 559 failed).
//
//   1. parseTestOutput: node --test (spec and TAP, real outputs), pytest,
//      unittest, gradle/JUnit, dotnet test; « could not run » vs « N failed ».
//   2. checkCleanCopy: green in the checkout, red in a clean worktree because
//      of a git-ignored file — named in the reason.
//   3. pipeline-onboard: not put in service, nothing written; in service once
//      the file is committed. new-project (serviceNewProject): same rule.
//   4. --check-clean <p>|--all|--changed (real CLI, private root).
//   5. Idle sweep: a changed testCommand of a declared project is checked in a
//      clean copy first; red ⇒ alert and fix request with the details.
//   6. Real runner (idle-regression-runner.mjs): the failed test in `ko`, the
//      alert and the incident request — never « KO : testCommand ».
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTestOutput, describeFailures, koIds, failureLines } from './test-failures.mjs';
import { checkCleanCopy, readCleanChecks, cleanCheckNeeded, USER_AGREEMENT } from './clean-copy-check.mjs';
import { onboardProject, serviceNewProject } from './pipeline-onboard.mjs';
import * as IR from './idle-regression.mjs';
import { runStep } from './idle-regression-runner.mjs';
import { alertLine } from './chef-alerts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const section = (n) => console.log(`\n── ${n}`);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true });
const FAIL3 = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => assert.equal(1 + 1, 2));\ntest('renders the shelf title', () => assert.equal('Shelf', 'Self'));\ntest('lists books', () => {});\n";

// ---------------------------------------------------------------------------
section('1. Lecture des tests en échec dans la sortie');
{
  const D = tmp('orch-tf-node-');
  fs.writeFileSync(path.join(D, 'a.test.mjs'), FAIL3);
  for (const rep of ['spec', 'tap']) {
    const r = spawnSync(process.execPath, ['--test', `--test-reporter=${rep}`], { cwd: D, encoding: 'utf8' });
    const f = parseTestOutput(`${r.stdout}${r.stderr}`, { code: r.status });
    ok(f.kind === 'tests' && f.failed.length === 1 && f.failed[0].name === 'renders the shelf title' && f.counts.total === 3,
      `node --test (${rep}, vraie sortie) : 1 test en échec sur 3, nommé (${f.failed.map(t => t.name).join(', ')})`);
    ok(/a\.test\.mjs:4/.test(f.failed[0].file || ''), `node --test (${rep}) : fichier et ligne du test (${f.failed[0].file})`);
  }
  fs.rmSync(D, { recursive: true, force: true });

  const pytest = [
    '============================= test session starts =============================',
    'collected 559 items', '',
    'tests/test_loans.py ......F.....', '',
    '=========================== short test summary info ===========================',
    "FAILED tests/test_loans.py::test_due_date_rolls_over - AssertionError: assert '2026-11-01' == '2026-10-31'",
    '======================== 1 failed, 558 passed in 12.31s ========================',
  ].join('\n');
  let f = parseTestOutput(pytest, { code: 1 });
  const d = describeFailures(f);
  ok(f.kind === 'tests' && f.runner === 'pytest' && f.counts.total === 559 && f.failed[0].name === 'tests/test_loans.py::test_due_date_rolls_over', 'pytest : 1 en échec sur 559, nommé');
  ok(/^1 test en échec sur 559/.test(d) && d.includes('test_due_date_rolls_over') && !/KO : testCommand/.test(d), `texte : « ${d} »`);
  ok(JSON.stringify(koIds(f, 1)) === '["test:tests/test_loans.py::test_due_date_rolls_over"]', 'identifiants KO = les tests (pour la recherche du commit fautif)');

  f = parseTestOutput(['ImportError while importing test module tests/test_api.py', "E   ModuleNotFoundError: No module named 'requests'", 'ERROR tests/test_api.py', '!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!', '=============================== 1 error in 0.42s ==============================='].join('\n'), { code: 2 });
  ok(f.kind === 'not-run' && /requests/.test(f.reason) && /n’a pas pu tourner/.test(describeFailures(f)), `pytest, erreur de collecte : « la commande n’a pas pu tourner » (${f.reason})`);

  f = parseTestOutput(['F..', '======================================================================', 'FAIL: test_title (tests.test_shelf.ShelfTest.test_title)', '----------------------------------------------------------------------', 'AssertionError', '', 'Ran 3 tests in 0.002s', '', 'FAILED (failures=1)'].join('\n'), { code: 1 });
  ok(f.kind === 'tests' && f.runner === 'unittest' && f.failed[0].name === 'tests.test_shelf.ShelfTest.test_title' && f.counts.total === 3, 'unittest : le test en échec et le total');

  f = parseTestOutput(['> Task :app:testDebugUnitTest', '', 'com.example.box.PlayerTest > resumesAtLastPosition FAILED', '    java.lang.AssertionError at PlayerTest.kt:42', '', '128 tests completed, 1 failed', '', 'FAILURE: Build failed with an exception.', '', '* What went wrong:', "Execution failed for task ':app:testDebugUnitTest'.", '> There were failing tests. See the report at: file:///x/index.html'].join('\n'), { code: 1 });
  ok(f.kind === 'tests' && f.runner === 'gradle' && f.failed[0].name === 'com.example.box.PlayerTest > resumesAtLastPosition' && f.counts.total === 128, 'gradle/JUnit : le test en échec sur 128');

  f = parseTestOutput(['FAILURE: Build failed with an exception.', '', '* What went wrong:', "Could not resolve all files for configuration ':app:debugRuntimeClasspath'.", '> Could not find sherpa-onnx-1.12.15.aar.', '  Searched in the following locations:', '', '* Try:', '> Run with --stacktrace'].join('\n'), { code: 1 });
  ok(f.kind === 'not-run' && /sherpa-onnx-1\.12\.15\.aar/.test(f.reason) && f.missing.includes('sherpa-onnx-1.12.15.aar'), `gradle sans test lancé (AAR absent) : « n’a pas pu tourner », fichier nommé (${f.reason})`);

  f = parseTestOutput(['  Failed Shelf.Tests.LoanTests.Overdue [12 ms]', '  Error Message:', '   Assert.Equal() Failure: Values differ', 'Failed!  - Failed:     1, Passed:    41, Skipped:     0, Total:    42, Duration: 2 s - Shelf.Tests.dll (net8.0)'].join('\n'), { code: 1 });
  ok(f.kind === 'tests' && f.runner === 'dotnet test' && f.failed[0].name === 'Shelf.Tests.LoanTests.Overdue' && f.counts.total === 42 && /Values differ/.test(f.failed[0].error), 'dotnet test : le test, son message, le total');

  f = parseTestOutput(["src\\Shelf.cs(12,5): error CS0246: The type or namespace name 'Foo' could not be found", 'Build FAILED.'].join('\n'), { code: 1 });
  ok(f.kind === 'not-run' && /CS0246/.test(f.reason), 'dotnet, erreur de compilation : « n’a pas pu tourner »');

  f = parseTestOutput("'pytest' is not recognized as an internal or external command,\noperable program or batch file.", { code: 1 });
  ok(f.kind === 'not-run' && /not recognized/.test(f.reason), 'commande introuvable (Windows) : « n’a pas pu tourner »');

  f = parseTestOutput('running checks\nstep 3: mismatch in totals\nexit', { code: 3 });
  ok(f.kind === 'unknown' && f.tail.includes('step 3: mismatch in totals') && /dernières lignes/.test(describeFailures(f)), 'sortie inconnue : les dernières lignes utiles');
  ok(failureLines(parseTestOutput(pytest, { code: 1 })).length === 1, 'détail : une ligne par test en échec');
}

// ---------------------------------------------------------------------------
// A project whose test reads a fixture ignored by git: green in the checkout,
// red in any clean copy (the KG-fixtures case of the first night).
function ignoredFixtureRepo(W, name = 'proj') {
  const P = path.join(W, name);
  fs.mkdirSync(path.join(P, 'tests'), { recursive: true });
  git(W, 'init', '-q', P);
  fs.writeFileSync(path.join(P, '.gitignore'), 'fixture.json\nTODO_LIST.md\n');
  fs.writeFileSync(path.join(P, 'fixture.json'), '{"title":"Shelf"}\n');
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name, version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2));
  fs.writeFileSync(path.join(P, 'tests', 'fixture.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('reads the fixture', () => assert.equal(JSON.parse(fs.readFileSync('fixture.json', 'utf8')).title, 'Shelf'));\ntest('sums', () => assert.equal(2 + 2, 4));\n");
  git(P, 'add', '-A'); git(P, 'commit', '-qm', 'base');
  return P;
}

section('2. Copie propre : verte dans la copie, rouge dans un worktree propre');
{
  const W = tmp('orch-cc-');
  const P = ignoredFixtureRepo(W);
  const inCheckout = spawnSync('npm test', { cwd: P, shell: true, encoding: 'utf8' });
  ok(inCheckout.status === 0, 'dans la copie du musicien : vert (le fichier ignoré est là)');
  const c = checkCleanCopy({ dir: P, testCommand: 'npm test', logFile: path.join(W, 'cc.log') });
  ok(!c.ok && c.failures?.kind === 'tests' && c.failures.failed[0].name === 'reads the fixture', `copie propre : rouge, test nommé (${c.failures?.failed?.[0]?.name})`);
  ok(c.ignored.some(i => i.file === 'fixture.json') && /fixture\.json/.test(c.summary) && /ignoré\(s\) par git/.test(c.summary), `raison : le fichier ignoré par git est nommé — « ${c.summary.slice(0, 160)}… »`);
  ok(/1 test en échec sur 2/.test(c.summary) && fs.existsSync(c.log), 'sortie utile dans la raison, sortie complète gardée');
  ok(!git(P, 'worktree', 'list').stdout.includes('orch-clean-') && git(P, 'status', '--porcelain').stdout === '', 'worktree retiré, copie du musicien intacte');
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('3. Intégration : pas de mise en service tant que la copie propre est rouge');
{
  const W = tmp('orch-cc-onb-');
  const P = ignoredFixtureRepo(W);
  const L = path.join(W, 'logs');
  const head = git(P, 'rev-parse', 'HEAD').stdout.trim();
  let r = onboardProject({ name: 'proj', path: P }, { testCommand: 'npm test', verified: true }, { logsDir: L });
  ok(r.status === 'exclu' && /copie propre/.test(r.why) && /fixture\.json/.test(r.why), `pipeline-onboard : exclu, raison claire (${r.why.slice(0, 120)}…)`);
  ok(r.details?.some(l => /reads the fixture/.test(l)), 'détail : le test en échec');
  ok(!fs.existsSync(path.join(P, '.orchestrateur', 'pipeline.json')) && git(P, 'rev-parse', 'HEAD').stdout.trim() === head, 'rien n’est écrit ni commité');
  ok(readCleanChecks(L).projects.proj?.ok === false, 'résultat gardé dans logs/clean-check.json');
  // The fix: commit the fixture (the KG case was solved that way).
  fs.writeFileSync(path.join(P, '.gitignore'), 'TODO_LIST.md\n');
  git(P, 'add', '-A'); git(P, 'commit', '-qm', 'commit the fixture');
  r = onboardProject({ name: 'proj', path: P }, { testCommand: 'npm test', verified: true }, { logsDir: L });
  ok(r.status === 'service' && r.actions.some(a => /copie propre verte/.test(a)), 'fichier versionné : en service, copie propre verte');
  ok(readCleanChecks(L).projects.proj?.ok === true, 'validation verte enregistrée');

  // new-project.mjs (serviceNewProject) applies the same rule.
  const R = path.join(W, 'root'); fs.mkdirSync(path.join(R, 'logs'), { recursive: true });
  const Q = ignoredFixtureRepo(W, 'newp');
  fs.writeFileSync(path.join(R, 'config.json'), JSON.stringify({ conductor: 'chef', projects: [{ name: 'newp', path: Q }] }));
  const s = serviceNewProject(R, { name: 'newp', dir: Q, fresh: false, scaffolded: [] });
  ok(s.status === 'exclu' && /copie propre/.test(s.why) && s.details?.length, `new-project : hors service, raison « copie propre » (${s.why.slice(0, 90)}…)`);
  ok(!JSON.parse(fs.readFileSync(path.join(R, 'config.json'), 'utf8')).enforcement && !fs.existsSync(path.join(R, 'model-routing.json')), 'pas dans enforcement.projects');
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('4. --check-clean <projet>|--all|--changed (vrai CLI, racine privée)');
{
  const W = tmp('orch-cc-cli-');
  const P = ignoredFixtureRepo(W);
  fs.mkdirSync(path.join(P, '.orchestrateur'));
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'npm test' }));
  git(P, 'add', '-f', '.orchestrateur/pipeline.json'); git(P, 'commit', '-qm', 'pipeline.json');
  const R = path.join(W, 'root'); fs.mkdirSync(path.join(R, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(R, 'config.json'), JSON.stringify({ conductor: 'chef', projects: [{ name: 'chef', path: W }, { name: 'proj', path: P }, { name: 'other', path: W }] }));
  fs.writeFileSync(path.join(R, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, enforcement: { projects: ['proj'], pipelines: ['discussion', 'dev'] } }));
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline-onboard.mjs'), '--check-clean', ...a], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: R }, encoding: 'utf8', timeout: 300_000 });
  let r = cli('--all');
  ok(r.status === 1 && /proj\s+ROUGE/.test(r.stdout) && /fixture\.json/.test(r.stdout) && /reads the fixture/.test(r.stdout), '--all : rouge, code 1, test et fichier ignoré affichés');
  ok(/reste en service/.test(r.stdout) && /pipeline-enforce\.mjs off proj/.test(r.stdout), 'avertissement bloquant clair, retrait proposé, jamais fait d’office');
  ok(!/other/.test(r.stdout.split('\n').filter(l => /VERT|ROUGE/.test(l)).join('\n')), 'seuls les projets en service sont vérifiés');
  r = cli('--changed');
  ok(r.status === 2, '--changed : rouge déjà constaté sur ce commit, même testCommand ⇒ pas relancé avant un nouveau commit');
  fs.writeFileSync(path.join(P, '.gitignore'), 'TODO_LIST.md\n'); git(P, 'add', '-A'); git(P, 'commit', '-qm', 'fixture committed');
  r = cli('proj');
  ok(r.status === 0 && /proj\s+VERT/.test(r.stdout), '<projet> : vert après le commit du fichier');
  r = cli('--changed');
  ok(r.status === 2 && /inchangée/.test(r.stdout), '--changed : testCommand inchangée depuis sa validation ⇒ rien à faire (code 2)');
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test' })); git(P, 'add', '-f', '-A'); git(P, 'commit', '-qm', 'new testCommand');
  r = cli('--changed');
  ok(r.status === 0 && /proj\s+VERT/.test(r.stdout), '--changed : testCommand modifiée ⇒ revalidée');
  ok(cleanCheckNeeded(null, 'x', 'h') && !cleanCheckNeeded({ testCommand: 'x', ok: true, commit: 'a' }, 'x', 'b') && cleanCheckNeeded({ testCommand: 'x', ok: false, commit: 'a' }, 'x', 'b'),
    'règle : jamais vérifiée, testCommand changée, ou rouge sur un commit plus ancien');
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('5. Balayage d’inactivité : testCommand modifiée d’un projet déclaré ⇒ copie propre d’abord');
{
  const L = tmp('orch-cc-sweep-');
  const launched = [], alerts = [], fixes = [];
  const alive = new Set();
  let pid = 5000;
  const head = 'e'.repeat(40);
  const deps = () => ({
    logsDir: L, now: Date.now(), bootAt: 0,
    settings: () => IR.cleanSettings({ enabled: true, since: '2026-01-01T00:00:00Z', idleMin: 30 }),
    lastActivityAt: () => Date.now() - 120 * 60_000,
    targets: () => [{ name: 'P', path: L, plan: { full: ['node', 'run-all.mjs', '--ref', '{ref}'], bisect: null, inPlace: true, declared: true }, test: { testCommand: 'npm test', timeoutMin: 5 } }],
    busy: () => false, head: () => head, revList: () => [], subject: () => null,
    launch: (step) => { const p = pid++; alive.add(p); launched.push({ ...step, pid: p }); return { pid: p }; },
    alive: (p) => alive.has(p), kill: (p) => alive.delete(p),
    dispatchFix: (name, text) => fixes.push({ name, text }), chefAlertsOn: () => false, alert: (a) => alerts.push(...a),
  });
  IR.sweep(deps());
  ok(launched[0]?.kind === 'clean-check' && !launched[0].inPlace && launched[0].worktree && launched[0].argv[1] === 'npm test', 'jamais validée : la testCommand tourne d’abord dans une copie propre (worktree), pas la complète');
  fs.writeFileSync(launched[0].resultFile, JSON.stringify({ code: 1, ko: ['test:reads the fixture'], ignored: [{ file: 'fixture.json', why: 'x' }],
    failures: { kind: 'tests', runner: 'node --test', counts: { total: 2, failed: 1 }, failed: [{ name: 'reads the fixture', file: 'tests/fixture.test.mjs:4' }], missing: [], tail: [] } }));
  IR.sweep(deps());
  const red = IR.readState(L).projects.P.red;
  ok(red?.cleanCopy && red.searchDone && readCleanChecks(L).projects.P?.ok === false, 'rouge en copie propre : enregistré (état et clean-check.json)');
  ok(alerts.length === 1 && alerts[0].red.cleanCopy && alerts[0].red.failures.failed[0].name === 'reads the fixture', 'alerte au chef avec le test en échec');
  const line = alertLine(alerts[0], 0, { root: ROOT });
  ok(/COPIE PROPRE/.test(line) && /1 test en échec sur 2/.test(line) && /fixture\.json/.test(line) && !/KO : testCommand/.test(line), 'texte de l’alerte : copie propre, test nommé, fichier ignoré');
  IR.sweep(deps());
  ok(fixes.length === 1 && /COPIE PROPRE ROUGE/.test(fixes[0].text) && /reads the fixture/.test(fixes[0].text) && /fixture\.json/.test(fixes[0].text), 'demande d’incident : le test et le fichier ignoré');
  ok(launched.length === 1 && IR.sweep(deps()).nothing, 'même tête : ni complète ni nouvel essai');
  fs.rmSync(L, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('6. Vrai runner : 1 test sur 3 en échec ⇒ nommé partout, jamais « KO : testCommand »');
{
  const W = tmp('orch-cc-run-');
  const P = path.join(W, 'proj'), L = path.join(W, 'logs');
  fs.mkdirSync(path.join(P, 'tests'), { recursive: true });
  git(W, 'init', '-q', P);
  fs.writeFileSync(path.join(P, 'tests', 'shelf.test.mjs'), FAIL3);
  git(P, 'add', '-A'); git(P, 'commit', '-qm', 'base');
  const commit = git(P, 'rev-parse', 'HEAD').stdout.trim();
  const dir = path.join(L, 'idle-regression', 'proj'); fs.mkdirSync(dir, { recursive: true });
  const step = { id: 'full-x', project: 'proj', path: P, kind: 'full', commit, argv: ['__shell__', 'node --test'], inPlace: false, report: null,
    resultFile: path.join(dir, 'full-x.result.json'), logFile: path.join(dir, 'full-x.log'), worktree: path.join(dir, 'wt'), testCommand: 'node --test' };
  const code = await runStep(step);
  const res = JSON.parse(fs.readFileSync(step.resultFile, 'utf8'));
  ok(code === 1 && JSON.stringify(res.ko) === '["test:renders the shelf title"]', `résultat : ko = le test en échec (${JSON.stringify(res.ko)})`);
  ok(res.failures?.kind === 'tests' && res.failures.counts.total === 3, 'résultat : nature « tests en échec », total');
  const red = { commit, at: new Date().toISOString(), ko: res.ko, failures: res.failures, good: null, searchDone: true, bisect: { culprit: null, why: 'aucune complète verte connue avant' } };
  const text = IR.fixText('proj', red);
  ok(/Échec : 1 test en échec sur 3/.test(text) && /renders the shelf title/.test(text) && !/KO : testCommand/.test(text), 'demande d’incident : le test en échec, pas « KO : testCommand »');
  const line = alertLine(IR.posterioriAlert('proj', red), 0, { root: ROOT });
  ok(/1 test en échec sur 3/.test(line) && /renders the shelf title/.test(line) && !/KO : testCommand/.test(line), 'alerte du chef : idem');
  ok(IR.stillRed(res.ko, ['test:renders the shelf title'], 1) && !IR.stillRed(res.ko, ['test:other'], 1) && IR.stillRed(res.ko, ['testCommand:non-lancée'], 1),
    'recherche du commit fautif : comparée par test ; une commande qui n’a pas pu tourner reste rouge');
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('7. Registre des exigences');
{
  const reg = fs.readFileSync(path.join(ROOT, 'docs', 'USER_REQUIREMENTS.md'), 'utf8');
  ok(USER_AGREEMENT === 'oui' && reg.includes('suite:_test_clean_copy_check.mjs') && /2026-10-24/.test(reg), 'ligne du registre : date, accord « oui », ce test');
}

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
