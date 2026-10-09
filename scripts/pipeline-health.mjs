// ============================================================================
// scripts/pipeline-health.mjs — follow-up of the general roll-out (pipelines
// phase 7, 0.56.0)
// ============================================================================
//
// Phase 7's criterion is "one week of use without bypass". This module counts,
// since `enforcement.generalSince`, for every project in service (and the chef
// when its turn is routed):
//   runs        pipeline executions started (one user_prompt with `pipeline`)
//   hors        turns explicitly outside a pipeline (`--hors-pipeline`, traced)
//   ordinaires  ordinary turns on a project in service (a bypass that slipped
//               through: should stay at 0)
//   refus       engine refusals before start (error_pipeline_refused)
//   porte       gate refusals (logs/pipeline-gate.ndjson: musician dispatch,
//               --model by hand, forged step token…)
//   pauses      executions paused on a limit or an unavailable model
// and the number of consecutive full days without any bypass (hors+ordinaires).
// Only the tail of each log is read (8 MiB): enough for weeks of activity.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { readEnforcement, isEnforced } from './pipeline-engine.mjs';

const TAIL = 8 * 1024 * 1024;
export const CRITERION_DAYS = 7;

function tailLines(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, TAIL);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n');
  } catch { return []; }
}
const day = (iso) => String(iso || '').slice(0, 10);
const blank = () => ({ runs: 0, hors: 0, ordinaires: 0, refus: 0, porte: 0, pauses: 0 });

/** Counts for one project log since `since` (ISO). Pure on its inputs. */
export function countLog(lines, since, add) {
  let pending = null;   // a user_prompt waiting to know whether the engine refused it
  const flush = () => { if (pending) { add(pending.day, pending.kind); pending = null; } };
  for (const l of lines) {
    if (!l || l[0] !== '{') continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const ts = e.timestamp || e.ts;
    if (!ts || ts < since) continue;
    if (e.type === 'user_prompt') {
      flush();
      if (e.pipeline?.answer) continue;                       // answer to a pause: not a new entry
      if (e.pipeline) { add(day(ts), 'runs'); continue; }
      pending = { day: day(ts), kind: e.pipelineBypass ? 'hors' : 'ordinaires' };
    } else if (e.type === 'result' && e.subtype === 'error_pipeline_refused') {
      if (pending) { add(pending.day, 'refus'); pending = null; } else add(day(ts), 'refus');
    } else if (e.type === 'notification' && e.subtype === 'pipeline_limit') {
      add(day(ts), 'pauses');
    } else if (e.type === 'result') flush();
  }
  flush();
}

/** Full report. `now` injectable for tests. */
export function computeHealth(root, { now = new Date() } = {}) {
  const enf = readEnforcement(root);
  const since = enf.generalSince || enf.since || null;
  let cfg = { projects: [] };
  try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch { /* no config */ }
  const conductor = cfg.conductor || 'chef';
  const tracked = cfg.projects.map(p => p.name).filter(n => isEnforced(enf, n) || (enf.chef && (n === conductor || new RegExp(`^${conductor}-\\d+$`).test(n))));
  const days = new Map();
  const perProject = [];
  const totals = blank();
  if (since) {
    for (const name of tracked) {
      const c = blank();
      countLog(tailLines(path.join(root, 'logs', `${name}.jsonl`)), since, (d, k) => {
        c[k]++; totals[k]++;
        if (!days.has(d)) days.set(d, blank());
        days.get(d)[k]++;
      });
      perProject.push({ name, ...c });
    }
    for (const l of tailLines(path.join(root, 'logs', 'pipeline-gate.ndjson'))) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (!e.at || e.at < since) continue;
      totals.porte++;
      const d = day(e.at);
      if (!days.has(d)) days.set(d, blank());
      days.get(d).porte++;
      const row = perProject.find(p => p.name === e.project);
      if (row) row.porte++;
    }
  }
  // Consecutive full days without bypass, ending yesterday (today is not over).
  let streak = 0;
  if (since) {
    const start = new Date(`${day(since)}T00:00:00Z`);
    const d = new Date(`${day(now.toISOString())}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    while (d > start) {   // the start day is partial: it does not count
      const x = days.get(day(d.toISOString()));
      if (x && (x.hors || x.ordinaires)) break;
      streak++;
      d.setUTCDate(d.getUTCDate() - 1);
    }
  }
  return {
    ok: true, since, chef: enf.chef, terminal: enf.terminal, projects: enf.projects.length,
    totals, perProject: perProject.sort((a, b) => (b.hors + b.ordinaires) - (a.hors + a.ordinaires) || b.runs - a.runs),
    days: [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v })),
    streakDays: streak, criterion: { days: CRITERION_DAYS, met: streak >= CRITERION_DAYS },
  };
}
