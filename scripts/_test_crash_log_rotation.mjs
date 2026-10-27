#!/usr/bin/env node
// ============================================================================
// scripts/_test_crash_log_rotation.mjs — server-crash.log is rotated by size
// ============================================================================
//
// User request (2026-10-27): « Rotation de server-crash.log, avec son test. »
//   1. under the limit: untouched;
//   2. over the limit: becomes .1, a fresh file starts, older generations shift,
//      the oldest beyond `keep` is dropped;
//   3. the server source rotates logs/server-crash.log from crashLog().
//
//   node scripts/_test_crash_log_rotation.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rotateIfBig } from './log-rotate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); if (!ok) fail++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-'));
const f = path.join(dir, 'server-crash.log');
const rd = (x) => { try { return fs.readFileSync(x, 'utf8'); } catch { return null; } };

fs.writeFileSync(f, 'small\n');
check('under the limit: not rotated', rotateIfBig(f, { maxBytes: 100, keep: 2 }) === false && rd(f) === 'small\n' && rd(`${f}.1`) === null);

fs.writeFileSync(f, 'A'.repeat(200));
check('over the limit: rotated', rotateIfBig(f, { maxBytes: 100, keep: 2 }) === true);
check('the big file is now .1 and the live file is gone (fresh one on next append)', rd(`${f}.1`) === 'A'.repeat(200) && rd(f) === null);

fs.writeFileSync(f, 'B'.repeat(200)); rotateIfBig(f, { maxBytes: 100, keep: 2 });
fs.writeFileSync(f, 'C'.repeat(200)); rotateIfBig(f, { maxBytes: 100, keep: 2 });
check('generations shift and the oldest beyond keep is dropped',
  rd(`${f}.1`) === 'C'.repeat(200) && rd(`${f}.2`) === 'B'.repeat(200) && rd(`${f}.3`) === null && !fs.existsSync(`${f}.3`));
check('missing file: no error', rotateIfBig(path.join(dir, 'nope.log')) === false);

const srv = fs.readFileSync(path.join(here, '..', 'serve' + 'r.js'), 'utf8');
check('the server source rotates CRASH_LOG from crashLog()', /rotateIfBig\(CRASH_LOG/.test(srv));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
if (fail) { console.log(`\n${fail} failure(s)`); process.exit(1); }
console.log('\nall good');
