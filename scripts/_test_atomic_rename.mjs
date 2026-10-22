#!/usr/bin/env node
// ============================================================================
// scripts/_test_atomic_rename.mjs — run.json survives a concurrent reader
// (0.74.3)
// ============================================================================
//
// User request (2026-10-12): « des que tu peux mets a jour, ne t'arretes pas
// tant que ce n'est pas fait » — the production jump was blocked by the
// intermittent KO http:pipeline-routage (and, in cascade, http:callback-wake).
// Exact cause: on Windows, renameSync(run.json.tmp, run.json) fails with EPERM
// while the server reads run.json (GET /api/pipeline-runs); the chef's Routage
// turn crashed (exit 1) with its run left "running". The fix retries the
// rename on EPERM/EBUSY/EACCES (scripts/atomic-file.mjs).
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renameRetry, writeFileAtomic, RENAME_RETRY_CODES } from './atomic-file.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-atomic-'));
const F = path.join(T, 'run.json');
fs.writeFileSync(F, '{}');

// Another process reading F in a loop, like the server answering /api/pipeline-runs.
const startReader = (ms) => spawn(process.execPath, ['-e',
  `const fs=require('fs');const f=${JSON.stringify(F)};const end=Date.now()+${ms};while(Date.now()<end){try{JSON.parse(fs.readFileSync(f,'utf8'))}catch{}}`], { stdio: 'ignore' });
const hammer = (ms, write) => {
  const errors = {}; let n = 0; const end = Date.now() + ms;
  while (Date.now() < end) {
    try { write(JSON.stringify({ n, pad: 'x'.repeat(4000) })); n++; } catch (e) { errors[e.code] = (errors[e.code] || 0) + 1; }
  }
  return { n, errors };
};
const exited = (c) => new Promise(r => c.on('exit', r));

try {
  console.log('\n── 1. La cause : un renommage simple échoue quand un autre processus lit le fichier');
  let reader = startReader(2500);
  await new Promise(r => setTimeout(r, 300));
  const plain = hammer(1500, (d) => { fs.writeFileSync(`${F}.tmp`, d); fs.renameSync(`${F}.tmp`, F); });
  await exited(reader);
  if (process.platform === 'win32') ok((plain.errors.EPERM || 0) + (plain.errors.EBUSY || 0) + (plain.errors.EACCES || 0) > 0, `Windows : renommage simple en échec pendant une lecture (${JSON.stringify(plain.errors)}, ${plain.n} réussis)`);
  else ok(true, `hors Windows : pas de verrou de partage (${JSON.stringify(plain.errors)})`);

  console.log('\n── 2. La correction : writeFileAtomic ne perd aucune écriture');
  reader = startReader(2500);
  await new Promise(r => setTimeout(r, 300));
  const fixed = hammer(1500, (d) => writeFileAtomic(F, d));
  await exited(reader);
  ok(Object.keys(fixed.errors).length === 0 && fixed.n > 0, `${fixed.n} écritures, aucune erreur (${JSON.stringify(fixed.errors)})`);
  ok(JSON.parse(fs.readFileSync(F, 'utf8')).n === fixed.n - 1 && !fs.existsSync(`${F}.tmp`), 'dernière écriture en place, aucun .tmp laissé');

  console.log('\n── 3. Seules les erreurs passagères sont réessayées');
  ok(['EPERM', 'EBUSY', 'EACCES'].every(c => RENAME_RETRY_CODES.has(c)) && RENAME_RETRY_CODES.size === 3, 'codes réessayés : EPERM, EBUSY, EACCES');
  let code = null; const t0 = Date.now();
  try { renameRetry(path.join(T, 'absent.tmp'), F); } catch (e) { code = e.code; }
  ok(code === 'ENOENT' && Date.now() - t0 < 500, `fichier source absent : ENOENT levé tout de suite (${code})`);

  console.log('\n── 4. Le moteur écrit run.json par writeFileAtomic');
  const eng = fs.readFileSync(path.join(ROOT, 'scripts', 'pipeline-engine.mjs'), 'utf8');
  ok(/import \{ renameRetry, writeFileAtomic \} from '\.\/atomic-file\.mjs'/.test(eng), 'pipeline-engine importe atomic-file.mjs');
  ok(/writeFileAtomic\(path\.join\(runDir, 'run\.json'\)/.test(eng) && !/fs\.renameSync\(`\$\{f\}\.tmp`, f\)/.test(eng), 'saveState passe par writeFileAtomic ; plus aucun renameSync simple de run.json');
  ok(!/fs\.renameSync\(tmp, file\)/.test(eng) && /renameRetry\(tmp, file\)/.test(eng), 'l’écriture de la mise en service passe par renameRetry');
  // 0.135.0 — t-cfee05: lanes.json (EPERM in _test_parallel_lanes under load).
  const lanes = fs.readFileSync(path.join(ROOT, 'scripts', 'lanes.mjs'), 'utf8');
  ok(!/fs\.renameSync\(/.test(lanes) && /renameRetry\(tmp, file\)/.test(lanes), 'lanes.mjs : lanes.json et les fichiers de tâche passent par renameRetry');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
