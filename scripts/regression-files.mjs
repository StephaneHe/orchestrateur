#!/usr/bin/env node
// Targeted test command of this repo (0.157.0): the pipeline engine's
// `targetedTestCommand` gives the selected test FILES as paths
// (`.orchestrateur/pipeline.json` → `{files}`); regression.mjs only takes
// `--only-suites a,b` (basenames). This launcher keeps the scripts/_test_*.mjs
// among them and runs only those suites, without the HTTP and browser stages.
// The report it writes (.regress/report-*.json, on the exact tree) is the one
// the pre-commit delivery gate reads. Fixtures and sandbox files (tests/**,
// _regression*.mjs) are not suites: the engine selects the suites that reach
// them anyway.
//
// Usage: node scripts/regression-files.mjs [--dry-run] <file>...
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Paths → suite basenames regression.mjs accepts (scripts/_test_*.mjs only, deduplicated). */
export function suitesOf(files) {
  const out = [];
  for (const f of files) {
    const p = String(f).replace(/\\/g, '/');
    const base = path.posix.basename(p);
    const dir = path.posix.dirname(p);
    if (!/^_test_[\w.-]+\.mjs$/.test(base)) continue;
    if (dir !== '.' && !/(^|\/)scripts$/.test(dir)) continue;
    if (!out.includes(base)) out.push(base);
  }
  return out;
}

/** argv of the regression.mjs run for `suites`. */
export function regressionArgv(suites) {
  return [path.join(HERE, 'regression.mjs'), '--only-suites', suites.join(','), '--no-browser'];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const suites = suitesOf(args.filter(a => a !== '--dry-run'));
  if (!suites.length) {
    console.log('[regression-files] aucune suite scripts/_test_*.mjs parmi les fichiers reçus : rien à lancer');
    process.exit(0);
  }
  const argv = regressionArgv(suites);
  console.log(`[regression-files] suites : ${suites.join(', ')}`);
  if (dry) { console.log(JSON.stringify([process.execPath, ...argv])); process.exit(0); }
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit', windowsHide: true });
  process.exit(r.status ?? 1);
}
