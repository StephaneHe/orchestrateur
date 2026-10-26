#!/usr/bin/env node
// ============================================================================
// scripts/_test_parallel_suites.mjs — suites run in parallel, bounded, the
// "serial" ones alone, results and failed outputs unchanged (0.74.0)
// ============================================================================
//
// User request (2026-10-12): « Puis fait E » (audit proposal E: run the
// _test_* suites in parallel in regression.mjs). Real child processes (fake
// suites that log when they start and end) through the same runPool +
// runSuite that regression.mjs uses.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPool, runSuite, SERIAL_SUITES, SUITE_TIMEOUT_MS, defaultJobs } from './suite-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-parallel-'));
const LOG = path.join(T, 'intervals.ndjson');
const OUT = path.join(T, 'suite-output');

// A fake suite: logs {name, start, end}, waits ms, exits with code.
const fake = (name, ms, code = 0) => fs.writeFileSync(path.join(T, name), `import fs from 'node:fs';
const start = Date.now();
console.log('début ${name}');
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ name: '${name}', start, end: Date.now() }) + '\\n');
  ${code ? `console.error('échec voulu de ${name}'); console.log('\\n0 ok, 1 KO'); process.exitCode = ${code};` : `console.log('\\n1 ok, 0 KO');`}
}, ${ms});
`);

try {
  const names = ['_test_a.mjs', '_test_b.mjs', '_test_c.mjs', '_test_d.mjs', '_test_e.mjs', '_test_f.mjs', '_test_s1.mjs', '_test_s2.mjs'];
  for (const n of names) fake(n, 700, n === '_test_d.mjs' ? 1 : 0);
  const serial = new Set(['_test_s1.mjs', '_test_s2.mjs']);
  const order = [];
  const tasks = names.map(n => ({ name: n, run: () => runSuite(path.join(T, n), T, { failedOutputDir: OUT }) }));
  const t0 = Date.now();
  const values = await runPool(tasks, { jobs: 3, serial, onResult: (i) => order.push(i) });
  const wall = Date.now() - t0;
  const iv = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const overlap = (a, b) => a.start < b.end && b.start < a.end;
  const maxConcurrent = Math.max(...iv.map(a => iv.filter(b => b.start <= a.start && b.end > a.start).length));

  console.log('\n── 1. Exécution réellement parallèle, bornée');
  ok(iv.length === names.length, `les ${names.length} suites ont tourné (${iv.length})`);
  ok(maxConcurrent >= 2, `plusieurs suites en même temps (au plus ${maxConcurrent} simultanées)`);
  ok(maxConcurrent <= 3, `borne respectée : jamais plus de 3 (${maxConcurrent})`);
  const sum = values.reduce((a, v) => a + v.durationS * 1000, 0);
  ok(wall < sum * 0.8, `gain réel : ${wall} ms au lieu d'environ ${sum} ms en série`);

  console.log('\n── 2. Suites « série » : toujours seules, jamais en même temps qu’une autre');
  for (const s of serial) {
    const me = iv.find(x => x.name === s);
    const others = iv.filter(x => x.name !== s && overlap(me, x)).map(x => x.name);
    ok(me && !others.length, `${s} a tourné seule${others.length ? ` (chevauche ${others.join(', ')})` : ''}`);
  }

  console.log('\n── 3. Ordre des résultats et sortie des échecs inchangés');
  ok(order.join() === names.map((_, i) => i).join(), `résultats remis dans l'ordre d'origine (${order.join(',')})`);
  ok(values.every((v, i) => v.tail === (names[i] === '_test_d.mjs' ? '0 ok, 1 KO' : '1 ok, 0 KO')), 'dernière ligne de chaque suite à sa place');
  const d = values[names.indexOf('_test_d.mjs')];
  const txt = d.outputFile ? fs.readFileSync(d.outputFile, 'utf8') : '';
  ok(!d.ok && /début _test_d\.mjs/.test(txt) && /échec voulu de _test_d\.mjs/.test(txt) && values.filter(v => v.outputFile).length === 1,
    'la suite en échec garde sa sortie complète (et elle seule)');

  console.log('\n── 4. Réglage du parallélisme');
  ok(defaultJobs({ ORCH_REGRESS_JOBS: '6' }, 20) === 6 && defaultJobs({}, 20) === 4 && defaultJobs({}, 2) === 1 && defaultJobs({ ORCH_REGRESS_JOBS: 'x' }, 8) === 2,
    'ORCH_REGRESS_JOBS, sinon 1/4 des cœurs borné à 1–4');
  const runOne = await runPool([{ name: 'x', run: async () => 1 }, { name: 'y', run: async () => 2 }], { jobs: 1 });
  ok(runOne.join() === '1,2', '--jobs 1 : une suite à la fois, comme avant');

  console.log('\n── 5. Branchement dans regression.mjs et liste des suites « série »');
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
  ok(/await runPool\(tasks, \{ jobs, serial: SERIAL_SUITES, onResult:/.test(src) && /opt\('--jobs'\)/.test(src) && /defaultJobs\(\)/.test(src), 'runSuites passe par runPool, avec --jobs et SERIAL_SUITES');
  ok(/record\('suite', f, f, r\.ok \? 'OK' : 'KO', `\$\{r\.tail\} \(\$\{r\.durationS\} s, exit \$\{r\.code\}\)`, output \? \{ output \} : null\)/.test(src), 'entrée du rapport inchangée (même detail, même champ output)');
  for (const s of ['_test_model_backoff.mjs', '_test_permission_prompt.mjs', '_test_neutral_stop.mjs', '_test_responses_shim.mjs', '_test_pool_chef_dispatch.mjs', '_test_pool_p0a.mjs', '_test_queue_api.mjs'])
    ok(SERIAL_SUITES.has(s) && fs.existsSync(path.join(ROOT, 'scripts', s)), `${s} reste en série (suite existante)`);
  // 0.148.0: own cap of the suites known to run close to the default 300 s.
  for (const [s, ms] of Object.entries(SUITE_TIMEOUT_MS))
    ok(ms > 300_000 && SERIAL_SUITES.has(s) && fs.existsSync(path.join(ROOT, 'scripts', s)), `${s} : délai propre ${ms / 1000} s, en série, suite existante`);
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'suite-runner.mjs'), 'utf8');
  ok(/runNode\(file, cwd, timeoutMs \?\? SUITE_TIMEOUT_MS\[path\.basename\(file\)\]\)/.test(runnerSrc), 'runSuite applique ce délai propre (sinon 300 s)');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
