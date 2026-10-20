// ============================================================================
// tests/kg-corpus/fixture.mjs — throw-away copy of the knowledge-index corpus
// ============================================================================
//
// The past pipeline runs of the corpus are kept in one file
// (before/runs-fixture.json) and laid out as <copy>/runs/<run>/run.json only
// in the copy: a committed file named run.json would be « covered » by every
// suite that mentions that name (regression-targets matches basenames).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_BEFORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'before');

/** Copies the « before » corpus into `dir` with its runs laid out; returns `dir`. */
export function corpusCopy(dir) {
  fs.cpSync(CORPUS_BEFORE, dir, { recursive: true });
  const runs = JSON.parse(fs.readFileSync(path.join(dir, 'runs-fixture.json'), 'utf8'));
  for (const r of runs) {
    fs.mkdirSync(path.join(dir, 'runs', r.run), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs', r.run, 'run.json'), JSON.stringify(r, null, 1));
  }
  return dir;
}
