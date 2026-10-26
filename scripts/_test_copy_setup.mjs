#!/usr/bin/env node
// ============================================================================
// scripts/_test_copy_setup.mjs — the project's setup step in a clean copy
// (0.147.0, scripts/copy-setup.mjs)
// ============================================================================
//
// Complement to the user agreement « oui » (2026-10-24), post-mortem of
// p-20261024T033920-3a0055: a clean copy linked node_modules but never replayed
// `postinstall`; the file it generates (ignored by git, a vendored
// vue.global.prod.js) was missing and the project's tests failed (404).
//
//   1. Replay of the case: generated file absent from a clean worktree without
//      setup → setup (npm run postinstall --if-present) → present; the clean-copy
//      validation (onboarding) is green.
//   2. Failing setup: a named `setup` failure, the tests are not run, output
//      logged; onboarding refused with that reason.
//   3. setupCommand declared in .orchestrateur/pipeline.json (non-npm project),
//      `false` disables the step.
//   4. Persistent lane: stamp — replayed only when package.json changes.
//   5. Real after-the-fact runner: green with setup; failing setup = code 71,
//      ko `setup:échec`, described as such.
//   6. dispatch.mjs replays the setup in a pipeline lane after the links.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCleanCopy, addCleanWorktree, removeWorktree } from './clean-copy-check.mjs';
import { runCopySetup, setupOf, NPM_POSTINSTALL } from './copy-setup.mjs';
import { provisionPipelineLane } from './lanes.mjs';
import { describeFailures, koIds } from './test-failures.mjs';
import { onboardProject } from './pipeline-onboard.mjs';
import { runStep } from './idle-regression-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const section = (n) => console.log(`\n── ${n}`);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true });
const VENDOR = path.join('frontend', 'vendor', 'vue.global.prod.js');
const TEST_CMD = 'node --test tests/vendor.test.mjs';

/** A project shaped like the real case: postinstall copies a vendored file out of node_modules. */
function vendorProject(W, { failing = false, name = 'proj' } = {}) {
  const P = path.join(W, name);
  fs.mkdirSync(path.join(P, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(P, 'tests'), { recursive: true });
  git(W, 'init', '-q', P);
  fs.writeFileSync(path.join(P, '.gitignore'), 'node_modules/\nfrontend/vendor/\n');
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name, private: true, scripts: { test: TEST_CMD, postinstall: 'node scripts/copy-vendor.js' } }, null, 2));
  fs.writeFileSync(path.join(P, 'scripts', 'copy-vendor.js'), failing
    ? "console.error('copy-vendor: cannot find node_modules/vue/dist/vue.global.prod.js'); process.exit(3);\n"
    : "const fs = require('fs'), path = require('path');\nconst dst = path.join('frontend', 'vendor');\nfs.mkdirSync(dst, { recursive: true });\nfs.copyFileSync(path.join('node_modules', 'vue', 'dist', 'vue.global.prod.js'), path.join(dst, 'vue.global.prod.js'));\nconsole.log('copy-vendor: vue copied');\n");
  fs.writeFileSync(path.join(P, 'tests', 'vendor.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('serves /vendor/vue.global.prod.js', () => assert.ok(fs.existsSync('frontend/vendor/vue.global.prod.js'), 'GET /vendor/vue.global.prod.js → 404'));\n");
  git(P, 'add', '-A'); git(P, 'commit', '-qm', 'base');
  // « npm install » in the checkout: node_modules present, postinstall already run.
  fs.mkdirSync(path.join(P, 'node_modules', 'vue', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(P, 'node_modules', 'vue', 'dist', 'vue.global.prod.js'), '/* vue */\n');
  if (!failing) spawnSync(process.execPath, ['scripts/copy-vendor.js'], { cwd: P });
  return P;
}

// ---------------------------------------------------------------------------
section('1. Rejeu du cas : fichier généré absent → préparation → présent');
{
  const W = tmp('orch-setup-1-');
  const P = vendorProject(W);
  ok(fs.existsSync(path.join(P, VENDOR)), 'copie de travail : le fichier généré existe (postinstall déjà lancé)');
  ok(spawnSync('cmd', ['/c', TEST_CMD], { cwd: P }).status === 0, 'copie de travail : la suite est verte');
  const head = git(P, 'rev-parse', 'HEAD').stdout.trim();
  const s = setupOf(P);
  ok(s?.source === 'postinstall' && s.command === NPM_POSTINSTALL, `préparation détectée : « ${s?.command} » (${s?.source})`);

  const wt = path.join(W, 'wt-sans');
  let w = addCleanWorktree(P, wt, head, { setup: false });
  ok(w.ok && fs.existsSync(path.join(wt, 'node_modules')) && !fs.existsSync(path.join(wt, VENDOR)), 'copie propre SANS préparation : node_modules lié, fichier généré ABSENT (le défaut)');
  ok(spawnSync('cmd', ['/c', TEST_CMD], { cwd: wt }).status !== 0, 'copie propre sans préparation : faux rouge (404)');
  removeWorktree(P, wt);

  const wt2 = path.join(W, 'wt-avec');
  w = addCleanWorktree(P, wt2, head);
  ok(w.ok && w.setup?.ok === true && fs.existsSync(path.join(wt2, VENDOR)), 'copie propre AVEC préparation : fichier généré PRÉSENT');
  ok(/npm run postinstall --if-present/.test(w.out) && /copy-vendor: vue copied/.test(w.out), 'sortie de la préparation journalisée');
  ok(fs.existsSync(path.join(P, 'node_modules', 'vue', 'dist', 'vue.global.prod.js')), 'la cible du lien node_modules est intacte');
  removeWorktree(P, wt2);

  const r = checkCleanCopy({ dir: P, testCommand: TEST_CMD, logFile: path.join(W, 'logs', 'clean-check', 'proj.log') });
  ok(r.ok === true, `validation en copie propre (onboarding) verte : ${r.summary}`);
  const L = path.join(W, 'logs');
  const on = onboardProject({ name: 'proj', path: P }, { testCommand: TEST_CMD, verified: true }, { logsDir: L });
  ok(on.status === 'service', `pipeline-onboard : en service, préparation comprise (${on.status}${on.why ? ` — ${on.why}` : ''})`);
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('2. Préparation en échec : échec nommé, tests non lancés');
{
  const W = tmp('orch-setup-2-');
  const P = vendorProject(W, { failing: true });
  const log = path.join(W, 'logs', 'clean-check', 'proj.log');
  const r = checkCleanCopy({ dir: P, testCommand: TEST_CMD, logFile: log });
  ok(r.ok === false && r.failures?.kind === 'setup', `rouge, nature « setup » (${r.failures?.kind})`);
  ok(/non préparée/.test(r.summary) && /npm run postinstall --if-present/.test(r.summary) && /n’a pas été lancée/.test(r.summary), `raison claire : « ${r.summary} »`);
  ok(/code 3/.test(r.failures.reason) && /cannot find node_modules/.test(r.failures.reason), `cause du script citée : ${r.failures.reason}`);
  const out = fs.readFileSync(log, 'utf8');
  ok(/cannot find node_modules/.test(out) && !out.includes(`$ ${TEST_CMD}`), 'sortie journalisée, commande de test jamais lancée');
  const d = describeFailures(r.failures);
  ok(/^tests non lancés : préparation/.test(d) && !/KO : testCommand/.test(d), `description : « ${d} »`);
  ok(JSON.stringify(koIds(r.failures, 71)) === '["setup:échec"]', 'identifiant KO : setup:échec');
  const on = onboardProject({ name: 'proj', path: P }, { testCommand: TEST_CMD, verified: true }, { logsDir: path.join(W, 'logs') });
  ok(on.status === 'exclu' && /non préparée/.test(on.why || ''), `pipeline-onboard : exclu, raison = la préparation (${(on.why || '').slice(0, 100)}…)`);
  ok(!fs.existsSync(path.join(P, '.orchestrateur', 'pipeline.json')), 'rien n’est écrit');
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('3. setupCommand déclarée (projet non npm) ; false la coupe');
{
  const W = tmp('orch-setup-3-');
  const P = path.join(W, 'py');
  fs.mkdirSync(path.join(P, '.orchestrateur'), { recursive: true });
  git(W, 'init', '-q', P);
  fs.writeFileSync(path.join(P, '.gitignore'), 'data/\n');
  fs.writeFileSync(path.join(P, 'gen.mjs'), "import fs from 'node:fs';\nfs.mkdirSync('data', { recursive: true });\nfs.writeFileSync('data/generated.txt', 'ok');\n");
  fs.writeFileSync(path.join(P, 'check.mjs'), "import fs from 'node:fs';\nprocess.exit(fs.existsSync('data/generated.txt') ? 0 : 1);\n");
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: ['node', 'check.mjs'], setupCommand: ['node', 'gen.mjs'] }));
  git(P, 'add', '-A'); git(P, 'commit', '-qm', 'base');
  ok(setupOf(P)?.source === 'setupCommand', 'setupCommand lue dans .orchestrateur/pipeline.json');
  let r = checkCleanCopy({ dir: P, testCommand: ['node', 'check.mjs'] });
  ok(r.ok === true, `copie propre verte grâce à la setupCommand : ${r.summary}`);
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: ['node', 'check.mjs'], setupCommand: false }));
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'py', scripts: { postinstall: 'node gen.mjs' } }));
  git(P, 'add', '-A'); git(P, 'commit', '-qm', 'disable');
  ok(setupOf(P) === null, 'setupCommand: false — aucune préparation, même avec un postinstall');
  r = checkCleanCopy({ dir: P, testCommand: ['node', 'check.mjs'] });
  ok(r.ok === false && r.failures?.kind !== 'setup', 'préparation coupée : la suite tourne (rouge ici), sans étape setup');
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('4. Couloir persistant : rejouée seulement si ses entrées changent');
{
  const W = tmp('orch-setup-4-');
  const P = vendorProject(W);
  const lane = path.join(W, 'lane1');
  git(P, 'worktree', 'add', '-q', '--detach', lane, 'HEAD');
  provisionPipelineLane(P, lane);
  const log = path.join(W, 'logs', 'lanes', 'proj', '1.setup.log');
  let s = runCopySetup(lane, { stamp: true, logFile: log });
  ok(s.ran && s.ok && fs.existsSync(path.join(lane, VENDOR)) && fs.existsSync(log), 'premier passage : préparation faite, fichier présent, journal écrit');
  s = runCopySetup(lane, { stamp: true });
  ok(!s.ran && s.cached, 'second passage, même contenu : non rejouée');
  ok(git(lane, 'status', '--porcelain').stdout.trim() === '', 'le tampon ne salit pas la copie du couloir');
  const pkg = JSON.parse(fs.readFileSync(path.join(lane, 'package.json'), 'utf8'));
  pkg.version = '1.0.1';
  fs.writeFileSync(path.join(lane, 'package.json'), JSON.stringify(pkg, null, 2));
  s = runCopySetup(lane, { stamp: true });
  ok(s.ran && s.ok, 'package.json modifié : rejouée');
  removeWorktree(P, lane);
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('5. Vrai runner a posteriori');
{
  const W = tmp('orch-setup-5-');
  for (const failing of [false, true]) {
    const P = vendorProject(W, { failing, name: failing ? 'ko' : 'vert' });
    const commit = git(P, 'rev-parse', 'HEAD').stdout.trim();
    const dir = path.join(W, 'logs', 'idle-regression', failing ? 'ko' : 'vert'); fs.mkdirSync(dir, { recursive: true });
    const step = { id: 'full-x', project: 'p', path: P, kind: 'full', commit, argv: ['__shell__', TEST_CMD], inPlace: false, report: null,
      resultFile: path.join(dir, 'full-x.result.json'), logFile: path.join(dir, 'full-x.log'), worktree: path.join(dir, 'wt'), testCommand: TEST_CMD };
    const code = await runStep(step);
    const res = JSON.parse(fs.readFileSync(step.resultFile, 'utf8'));
    const out = fs.readFileSync(step.logFile, 'utf8');
    if (!failing) ok(code === 0 && res.code === 0 && /copy-vendor: vue copied/.test(out), 'préparation puis suite : vert (plus de faux rouge)');
    else {
      ok(code === 71 && JSON.stringify(res.ko) === '["setup:échec"]' && res.failures?.kind === 'setup', `préparation en échec : code 71, ko ${JSON.stringify(res.ko)}`);
      ok(/préparation/.test(describeFailures(res.failures)) && !out.includes(`$ ${TEST_CMD}`), 'décrite comme telle, tests non lancés');
    }
    ok(!fs.existsSync(step.worktree), 'copie propre supprimée');
  }
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('6. Couloir de pipeline (dispatch.mjs)');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), 'utf8');
  const a = src.indexOf('lanesMod.provisionPipelineLane(project.path, dir)');
  const b = src.indexOf("runCopySetup(dir, { stamp: true");
  ok(a > 0 && b > a && b - a < 1200, 'la préparation est rejouée juste après la liaison des dépendances');
  ok(/subtype: 'lane_setup_failed'/.test(src), 'échec : événement system/lane_setup_failed dans le journal du musicien');
}

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
