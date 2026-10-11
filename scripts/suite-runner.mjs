// ============================================================================
// scripts/suite-runner.mjs — run one node test suite; keep the FULL output of a
// failed one (0.73.0)
// ============================================================================
//
// User request (2026-10-11): "Conserver toute la sortie d'une suite en échec
// dans regression.mjs" — "2. oui". The report only carries the last line of a
// suite; when a suite fails, its whole stdout + stderr is written to a file
// under .regress/ (git-ignored) and the report points to it. Green suites
// write nothing.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Runs `file` with node in `cwd`; → {code, out} (stdout + stderr interleaved). */
export function runNode(file, cwd, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [file], { cwd, env: { ...process.env, ANTHROPIC_API_KEY: '' }, windowsHide: true });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => { try { c.kill(); } catch {} }, timeoutMs);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

/** Writes the full output of a failed suite; → path of the file. */
export function keepFailedOutput({ dir, suite, code, out, durationS }) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${path.basename(suite).replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
  fs.writeFileSync(f, `# ${suite} — exit ${code}${durationS != null ? ` — ${durationS} s` : ''}\n# full stdout + stderr\n\n${out}`);
  return f;
}

/**
 * Runs one suite. → {code, ok, tail, durationS, out, outputFile}; outputFile
 * is set only when the suite failed (its full output is then on disk).
 */
export async function runSuite(file, cwd, { failedOutputDir, timeoutMs } = {}) {
  const t0 = Date.now();
  const r = await runNode(file, cwd, timeoutMs);
  const durationS = Math.round((Date.now() - t0) / 1000);
  const tail = r.out.trim().split('\n').slice(-1)[0] || '';
  const ok = r.code === 0;
  const outputFile = !ok && failedOutputDir ? keepFailedOutput({ dir: failedOutputDir, suite: file, code: r.code, out: r.out, durationS }) : null;
  return { code: r.code, ok, tail, durationS, out: r.out, outputFile };
}
