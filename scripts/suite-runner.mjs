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
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Suites started by THIS process and still running: a stale run (0.94.0,
// scripts/stale-run.mjs) stops exactly these, never anything else.
export const liveSuites = new Set();

/** Runs `file` with node in `cwd`; → {code, out} (stdout + stderr interleaved). */
export function runNode(file, cwd, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    // ORCH_REGRESS_LIVE=0: a regression a suite starts on its fixtures is not a
    // run of this checkout and stays out of the dashboard (0.119.0).
    const c = spawn(process.execPath, [file], { cwd, env: { ...process.env, ANTHROPIC_API_KEY: '', ORCH_REGRESS_LIVE: '0' }, windowsHide: true });
    liveSuites.add(c);
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => { try { c.kill(); } catch {} }, timeoutMs);
    c.on('close', (code) => { clearTimeout(t); liveSuites.delete(c); resolve({ code, out }); });
  });
}

/** Writes the full output of a failed suite; → path of the file. */
export function keepFailedOutput({ dir, suite, code, out, durationS }) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${path.basename(suite).replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
  fs.writeFileSync(f, `# ${suite} — exit ${code}${durationS != null ? ` — ${durationS} s` : ''}\n# full stdout + stderr\n\n${out}`);
  return f;
}

// ---------------------------------------------------------------------------
// Parallel suites (0.74.0, user request "Puis fait E"): the suites stage runs
// up to `jobs` suites at once. Suites listed in SERIAL_SUITES never share the
// machine with another suite: their checks depend on timing, or they work in
// the real repository root (its logs/, queue). They run one by one, alone,
// after the parallel ones. Results are always delivered in the original order.
// ---------------------------------------------------------------------------
export const SERIAL_SUITES = new Set([
  '_test_model_backoff.mjs',       // timing windows (back-off waits, 300 ms notice)
  '_test_chef_turn_calls.mjs',     // parallel classification measured against the summed times; detached shadow
  '_test_requests_pending_link.mjs', // detached turns released at the end of another turn (waits)
  '_test_permission_prompt.mjs',   // permission timeouts
  '_test_neutral_stop.mjs',        // heartbeat freshness
  '_test_responses_shim.mjs',      // real codex + Windows sandbox, heavy
  '_test_pool_chef_dispatch.mjs',  // real dispatch.mjs in the repository root
  '_test_pool_p0a.mjs',            // idem
  '_test_queue_api.mjs',           // queue.mjs in the repository root
  '_test_queue_order.mjs',         // own server instance under .regress/ (timed drain)
  '_test_queue_edit.mjs',          // own server instance under .regress/ (timed drain)
  '_test_stale_run.mjs',           // runs regression.mjs on a private repo, timed stop
  '_test_suite_lock.mjs',          // measures time overlaps between processes
  '_test_parallel_lanes.mjs',      // concurrent turns: overlap and wait timings
  '_test_maxparallel_default.mjs', // concurrent turns: overlap and wait timings
  '_test_dev_pilot_first.mjs',     // concurrent turns: overlap and wait timings
  '_test_lane_pipeline.mjs',       // concurrent pipeline runs: overlap timings
  '_test_dev_pipeline_lanes.mjs',   // concurrent pipeline runs of the dev instance: overlap timings
  '_test_pipeline_corpus.mjs',     // the real corpus replayed end to end; a service polled with a deadline (PIPELINES-SYNTHESE §8.3)
  '_test_hors_pipeline_task.mjs',  // detached task turns awaited with a deadline (failed under parallel load, 0.134.0)
  '_test_phase4b_harness.mjs',     // harness latency capped at 500 ms per turn (547 ms under parallel load, 0.134.0)
  '_test_pipeline_gates.mjs',      // ~240 s alone, 278 s then > 300 s (suite timeout) under parallel load (0.138.0)
  '_test_aside_rework.mjs',        // ~90 s alone: nine sequential full-Development runs (0.139.0)
  '_test_pipeline_speed.mjs',      // ~20 sequential full-Development runs, levers off then on (0.143.0)
  '_test_item_delivery.mjs',       // ~225 s alone, > 300 s (suite timeout) under parallel load (0.149.1)
]);

// Suites known to run close to the default 300 s cap even alone get their own
// cap (0.148.0): _test_pipeline_gates.mjs took 231 to 292 s over the last
// releases and was killed at 300 s, alone, with all its checks green so far.
// 0.149.1: the after-the-fact full run of 6a111c2 killed two more at 300 s with
// every check green so far; measured alone: _test_pipeline_speed.mjs 283 s,
// _test_item_delivery.mjs 224 s.
export const SUITE_TIMEOUT_MS = Object.freeze({
  '_test_pipeline_gates.mjs': 600_000,
  '_test_pipeline_speed.mjs': 600_000,
  '_test_item_delivery.mjs': 600_000,
});

// Suites that assert a wall-clock cap on a spawned process and failed ALONE on
// a loaded machine (_test_phase4b_harness.mjs: max=515 ms, cap 500 ms, after-the-
// fact run of acf03ed, although already serial). One re-run decides: a real
// regression fails twice, a load spike does not. The re-run is announced in the
// kept output; the cap in the suite itself is not loosened.
export const RETRY_ONCE_SUITES = new Set(['_test_phase4b_harness.mjs']);

/** Default parallelism: ORCH_REGRESS_JOBS, else a quarter of the CPUs, 1 to 4. */
export function defaultJobs(env = process.env, cpus = os.cpus().length) {
  const n = Number(env.ORCH_REGRESS_JOBS);
  if (Number.isInteger(n) && n >= 1) return n;
  return Math.max(1, Math.min(4, Math.floor(cpus / 4)));
}

/**
 * Runs tasks [{name, run: () => Promise<any>}] with at most `jobs` at once;
 * tasks whose name is in `serial` run afterwards, one by one, alone.
 * onResult(index, value) is called in the ORIGINAL order, as soon as every
 * earlier task is done. → values in the original order.
 */
export async function runPool(tasks, { jobs = 1, serial = new Set(), onResult = () => {} } = {}) {
  const values = new Array(tasks.length), done = new Array(tasks.length).fill(false);
  let next = 0;
  const flush = () => { while (next < tasks.length && done[next]) { onResult(next, values[next]); next++; } };
  const finish = (i, v) => { values[i] = v; done[i] = true; flush(); };
  const parallel = tasks.map((t, i) => i).filter(i => !serial.has(tasks[i].name));
  const serialIdx = tasks.map((t, i) => i).filter(i => serial.has(tasks[i].name));
  let cursor = 0;
  const worker = async () => { while (cursor < parallel.length) { const i = parallel[cursor++]; finish(i, await tasks[i].run()); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, parallel.length)) }, worker));
  for (const i of serialIdx) finish(i, await tasks[i].run());
  return values;
}

/**
 * Runs one suite. → {code, ok, tail, durationS, out, outputFile}; outputFile
 * is set only when the suite failed (its full output is then on disk).
 */
export async function runSuite(file, cwd, { failedOutputDir, timeoutMs } = {}) {
  const t0 = Date.now();
  let r = await runNode(file, cwd, timeoutMs ?? SUITE_TIMEOUT_MS[path.basename(file)]);
  if (r.code !== 0 && RETRY_ONCE_SUITES.has(path.basename(file))) {
    const first = r.out;
    r = await runNode(file, cwd, timeoutMs ?? SUITE_TIMEOUT_MS[path.basename(file)]);
    r.out = `${first}
--- first attempt failed (timing-sensitive suite), re-run once ---
${r.out}`;
  }
  const durationS = Math.round((Date.now() - t0) / 1000);
  const tail = r.out.trim().split('\n').slice(-1)[0] || '';
  const ok = r.code === 0;
  const outputFile = !ok && failedOutputDir ? keepFailedOutput({ dir: failedOutputDir, suite: file, code: r.code, out: r.out, durationS }) : null;
  return { code: r.code, ok, tail, durationS, out: r.out, outputFile };
}
