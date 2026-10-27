// ============================================================================
// scripts/loop-lag.mjs — event-loop latency monitor (0.150.0)
// ============================================================================
//
// Incident « serveur figé » (2026-10-26): a 60 s sweep blocked the server's
// event loop for 10-18 s and nothing said which one. The monitor ticks on a
// timer; a tick that fires `thresholdMs` late means the loop was blocked for
// that long. The line it logs names the origin:
//   - `tracked(name, fn)` wraps a sweep: the synchronous time it held the loop
//     is recorded when it is long enough to matter;
//   - `noteRoute(label)` records HTTP requests as they arrive, so the routes
//     that started during the block are listed.
// Nothing here ever throws into the server.
// ============================================================================

export function createLoopMonitor({
  thresholdMs = 2000,
  intervalMs = 500,
  slowSectionMs = 250,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  let timer = null;
  let lastTick = now();
  let sections = [];                  // { name, ms, at } held the loop long since the last tick
  let routes = [];                    // { label, at } recent requests
  const blocks = [];                  // what was logged, for tests and /diagnostics

  function tracked(name, fn) {
    const t0 = now();
    const done = () => {
      const ms = now() - t0;
      if (ms >= slowSectionMs) { sections.push({ name, ms, at: t0 }); if (sections.length > 30) sections.shift(); }
    };
    let r;
    try { r = fn(); } finally { done(); }
    // An async fn is timed only up to its first await (its promise is returned as is):
    // the synchronous work that follows an await must be wrapped in its own tracked().
    return r;
  }

  /** `fn` as a tracked sweep: `sweep = mon.wrap('sweep', sweep)` before it is scheduled. */
  function wrap(name, fn) { return function (...args) { return tracked(name, () => fn.apply(this, args)); }; }

  function noteRoute(label) {
    const t = now();
    routes.push({ label, at: t });
    if (routes.length > 60) routes.shift();
  }

  function tick() {
    const t = now();
    const late = t - lastTick - intervalMs;
    const from = lastTick;
    lastTick = t;
    const mine = sections; sections = [];
    if (late < thresholdMs) return null;
    const secs = mine.sort((a, b) => b.ms - a.ms).slice(0, 4).map(s => `${s.name} ${s.ms}ms`);
    // Routes are those NOTED since the previous tick: a request is noted when its
    // middleware runs, so one that arrived during the block is only noted after it ends
    // and shows in the NEXT report. The sections are the reliable origin.
    const rts = [...new Set(routes.filter(r => r.at >= from).map(r => r.label))].slice(-6);
    const line = `[loop-lag] event loop blocked ~${late}ms (threshold ${thresholdMs}ms) — ` +
      `sweeps: ${secs.length ? secs.join(', ') : 'none tracked'}; routes started meanwhile: ${rts.length ? rts.join(', ') : 'none'}`;
    const rec = { at: new Date(t).toISOString(), lateMs: late, sections: mine.slice(0, 4), routes: rts, line };
    blocks.push(rec); if (blocks.length > 50) blocks.shift();
    try { log(line); } catch { /* the monitor must not take the server down */ }
    return rec;
  }

  function start() {
    if (timer) return;
    lastTick = now();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, tick, tracked, wrap, noteRoute, blocks };
}
