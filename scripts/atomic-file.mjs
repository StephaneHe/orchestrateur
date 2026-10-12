// ============================================================================
// scripts/atomic-file.mjs — write-then-rename that survives concurrent readers
// on Windows (0.74.3)
// ============================================================================
//
// On Windows, renameSync(tmp, file) fails with EPERM (sometimes EBUSY/EACCES)
// while another process has `file` open — e.g. the server reading run.json for
// GET /api/pipeline-runs. Measured: a reader looping on run.json makes 97 % of
// the renames fail. One such failure crashed a chef Routage turn (exit 1, run
// left "running", slot held until the lost-process sweep). The reader's handle
// lives a few milliseconds: retrying the rename shortly is the fix
// (graceful-fs and write-file-atomic do the same).
// ============================================================================

import fs from 'node:fs';

export const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** renameSync with bounded retries on the transient Windows sharing errors. */
export function renameRetry(from, to, { totalMs = 10_000 } = {}) {
  const end = Date.now() + totalMs;
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return attempt; }
    catch (e) {
      if (!RENAME_RETRY_CODES.has(e.code) || Date.now() >= end) throw e;
      sleep(Math.min(5 * (attempt + 1), 50));
    }
  }
}

/** Writes `data` to `file` through `file.tmp` + renameRetry. */
export function writeFileAtomic(file, data, tmp = `${file}.tmp`) {
  fs.writeFileSync(tmp, data);
  renameRetry(tmp, file);
}
