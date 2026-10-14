// ============================================================================
// scripts/stale-run.mjs — stop a test run whose result went stale (0.94.0)
// ============================================================================
//
// User, 2026-10-14, after a targeted run was left to finish on content changed
// while it ran: « Je ne comprends pas, si un test est detecte comme inutile, on
// aurait pu l'arreter pour ne pas perdre de temps et commencer l'autre ? Si
// oui, il faut en faire une regle ».
//
// A run of scripts/regression.mjs on the working tree tests the content it
// started on. Once that content changes, its verdict says nothing about the
// content to deliver: the delivery gate would refuse it anyway (its tree is
// not the staged one). So the run stops at once, kills only what IT started
// (its suites, its sandbox instance), and says to relaunch on the final
// content.
//
// A change is confirmed on `confirm` consecutive samples (default 2), so a
// file written and removed within one interval (a callback file deleted by
// notify.mjs a second later) never stops a run.
// ============================================================================

import { spawnSync } from 'node:child_process';

/** Default sampling interval; ORCH_REGRESS_STALE_MS overrides it (tests). */
export function staleIntervalMs(env = process.env) {
  const n = Number(env.ORCH_REGRESS_STALE_MS);
  return Number.isFinite(n) && n >= 50 ? n : 15_000;
}

/**
 * Watch the tested content. `read()` returns the current content id (a git
 * tree) or null when it cannot be computed (never counted as a change).
 * → { start, check(), stop(), staleInfo() }; `onStale({start, current})` is
 * called once, after `confirm` consecutive samples differ from `start`.
 * `check()` runs one sample synchronously (used by the timer and at the end).
 */
export function createStaleWatch({ read, intervalMs = staleIntervalMs(), confirm = 2, onStale = () => {}, autoStart = true } = {}) {
  const start = read();
  let streak = 0, info = null, timer = null, last = null;
  const check = () => {
    if (info || !start) return info;
    const cur = read();
    if (!cur) return null;
    if (cur === start) { streak = 0; return null; }
    streak = cur === last ? streak + 1 : 1;
    last = cur;
    if (streak >= confirm) {
      info = { start, current: cur, at: new Date().toISOString() };
      stop();
      onStale(info);
    }
    return info;
  };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  if (autoStart && start) { timer = setInterval(check, intervalMs); timer.unref?.(); }
  return { start, check, stop, staleInfo: () => info };
}

/** Paths that differ between two trees of `repo` (for the message). */
export function changedPaths(repo, a, b, max = 12) {
  const r = spawnSync('git', ['-C', repo, 'diff-tree', '-r', '--name-only', a, b], { encoding: 'utf8', windowsHide: true });
  const all = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  return { paths: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** The message printed when a run stops (French: shown to the user). */
export function staleMessage({ paths = [], more = 0 } = {}) {
  const list = paths.length ? ` (${paths.join(', ')}${more ? ` et ${more} autre(s)` : ''})` : '';
  return `⚠ Contenu modifié pendant l’exécution${list} : le résultat de cette non-régression serait périmé. ` +
    `Arrêt immédiat de CE lancement (ses suites et son instance de test seulement) — relancez-la sur le contenu final.`;
}

/** Kill a process tree this run started itself (Windows: taskkill /T). */
export function killOwnTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}
