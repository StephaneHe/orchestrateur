// ============================================================================
// scripts/log-rotate.mjs — size-based rotation for append-only diagnostics (0.150.0)
// ============================================================================
//
// logs/server-crash.log grew without bound (a heartbeat per minute, plus every
// warning and signal). When a file passes `maxBytes` it becomes `<file>.1`
// (`.1` → `.2`, … up to `keep`; the oldest is dropped) and a fresh file starts.
// On Windows the rename fails when another process (the watchdog, a tail) holds the
// file open at that instant; the failure is silent (returns false) and the rotation
// is simply retried by the next call, i.e. 30 s later from server.js.
// Synchronous and exception-free: a rotation problem must not stop the logger.
// NOT for the musicians' stream-json logs (append-only, never truncated).
// ============================================================================

import fs from 'node:fs';

/** @returns {boolean} true when the file was rotated. */
export function rotateIfBig(file, { maxBytes = 5 * 1024 * 1024, keep = 3 } = {}) {
  try {
    if (fs.statSync(file).size < maxBytes) return false;
  } catch { return false; }
  try {
    try { fs.rmSync(`${file}.${keep}`, { force: true }); } catch {}
    for (let i = keep - 1; i >= 1; i--) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* missing */ }
    }
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch { return false; }
}
