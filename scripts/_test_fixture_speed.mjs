#!/usr/bin/env node
// ============================================================================
// scripts/_test_fixture_speed.mjs — the slow engine suites stay fast, with the
// same checks (0.73.3)
// ============================================================================
//
// User request (2026-10-12): « Accelere les parties ou c'est possible comme
// suggere » (audit proposal D: speed up the slow engine suites without
// removing any check). No duration bound here (it would be fragile under
// load): this suite checks that the fast mode is ACTIVE and that it means the
// same thing as before.
//   1. the shared fixture settings (tests/fixture-speed.mjs) and that a failing
//      test still makes the fast command exit non-zero;
//   2. the 9 slow engine suites use them;
//   3. the engine asks git "is this a repository?" once per directory, and
//      still re-checks a directory that was not a repository;
//   4. the routage suite polls every 100 ms with the same 30 s ceiling.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FAST_TEST_COMMAND, FIXTURE_GIT_ENV, FIXTURE_SPEED_ACTIVE } from '../tests/fixture-speed.mjs';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fixture-speed-'));

try {
  console.log('\n── 1. Réglages rapides partagés : même sens qu’avant');
  ok(FIXTURE_SPEED_ACTIVE && /--test-isolation=none/.test(FAST_TEST_COMMAND) && /^node --test\b/.test(FAST_TEST_COMMAND), `commande des projets de test : « ${FAST_TEST_COMMAND} »`);
  ok(process.env.GIT_CONFIG_COUNT === '2' && process.env.GIT_CONFIG_KEY_0 === 'maintenance.auto' && process.env.GIT_CONFIG_VALUE_1 === '0' && FIXTURE_GIT_ENV.GIT_CONFIG_KEY_1 === 'gc.auto',
    'maintenance git automatique coupée pour la suite et ses processus fils');
  const proj = path.join(T, 'proj');
  fs.mkdirSync(path.join(proj, 'test'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"p","type":"module"}');
  fs.writeFileSync(path.join(proj, 'test', 'a.test.mjs'), "import { test } from 'node:test';\ntest('a', () => {});\n");
  const run = () => spawnSync(FAST_TEST_COMMAND, { cwd: proj, shell: true, encoding: 'utf8', windowsHide: true });
  ok(run().status === 0, 'suite verte : code 0');
  fs.writeFileSync(path.join(proj, 'test', 'b.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('b', () => assert.equal(1, 2));\n");
  ok(run().status !== 0, 'un test en échec : code non nul (ce que lit le moteur), comme avec « node --test »');

  console.log('\n── 2. Les 9 suites lentes du moteur utilisent ces réglages');
  const SUITES = ['pipeline_gates', 'item_delivery', 'tests_per_item', 'pipeline_catalog', 'item_review', 'defect_blocks', 'pipeline_media', 'model_backoff', 'pipeline_engine'];
  for (const s of SUITES) {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', `_test_${s}.mjs`), 'utf8');
    ok(/import \{ FAST_TEST_COMMAND \} from '\.\.\/tests\/fixture-speed\.mjs'/.test(src) && /testCommand: FAST_TEST_COMMAND/.test(src) && !/testCommand: 'node --test'/.test(src), `_test_${s}.mjs`);
  }

  console.log('\n── 3. Moteur : « est-ce un dépôt git ? » demandé une fois par dossier');
  const repo = path.join(T, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  const trace = path.join(T, 'git-trace.log');
  const before = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  try {
    const w1 = E.snapshot(repo);   // not a repository yet: walked, and NOT remembered
    spawnSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    fs.rmSync(trace, { force: true });
    const s1 = E.snapshot(repo), s2 = E.snapshot(repo), s3 = E.snapshot(repo);
    const asked = (fs.readFileSync(trace, 'utf8').match(/rev-parse --is-inside-work-tree/g) || []).length;
    ok(w1 instanceof Map && s1.has('f.txt') && s3.has('f.txt'), 'dossier devenu dépôt : bien vu comme dépôt (une réponse négative n’est pas gardée)');
    ok(asked === 1, `3 instantanés du même dépôt : 1 seule question à git (${asked})`);
    ok(JSON.stringify([...s1]) === JSON.stringify([...s2]), 'mêmes empreintes qu’avant (aucun contrôle allégé)');
  } finally { if (before === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = before; }

  console.log('\n── 4. Suite du Routage : scrutation toutes les 100 ms, même plafond de 30 s');
  const rt = fs.readFileSync(path.join(ROOT, 'scripts', '_test_pipeline_routage.mjs'), 'utf8');
  ok(!/sleep\(500\)/.test(rt) && (rt.match(/i < 300 /g) || []).length === 6 && (rt.match(/sleep\(100\)/g) || []).length === 6, '6 boucles : 300 × 100 ms = 30 s, comme 60 × 500 ms');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
