#!/usr/bin/env node
// ============================================================================
// scripts/pipeline-speed-bench.mjs — bench of the « vitesse » levers (0.143.0)
// ============================================================================
//
// Two steps, never part of the non-regression (the extraction reads a real
// fleet, the replay takes minutes):
//
//   extract  READ-ONLY on a real fleet: for each run, its shape (items and
//            their declared tests, review findings per item, refusals), the
//            measured time of every step (model, suite, fixed cost of a call:
//            CLI start + first token), the share of the project's tests an
//            item really touches (its delivered commit, read with git, no
//            index write), and whether its Understand + Design could have been
//            reused. Writes an anonymised case file (no project name, no text).
//
//     node scripts/pipeline-speed-bench.mjs extract --logs <logs dir> --project <name>
//          --project-dir <dir> --runs <id,id,…> --out tests/speed-bench-cases.json
//
//   replay   each case with the REAL engine and dispatch.mjs, fake claude, in a
//            throwaway root: levers off, then all six on. Model calls, full
//            suite runs and targeted runs are COUNTED; time is ESTIMATED from
//            the measured step times of the real run (rules below).
//
//     node scripts/pipeline-speed-bench.mjs replay --cases tests/speed-bench-cases.json
//          [--out <report.json>] [--md <report.md>]
//
// Time estimate (stated in the report):
//   - a model call of step X costs the mean MODEL time of X in the real run
//     (step time minus its suite runs);
//   - « rouge-vert » (test + code in one call) = rouge + vert − one fixed cost;
//     a grouped Review of k items = k item Reviews − (k−1) fixed costs; the
//     fixed cost is the measured median (CLI start + first token);
//   - a full suite run costs the real mean; a targeted run costs that mean
//     times the share of the project's tests an item touched (measured);
//   - Understand + Design are saved only when the real request cited the
//     previous run and the code had not diverged since (measured with git).
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as Speed from './pipeline-speed.mjs';
import { parseItems, isTestFile } from './pipeline-engine.mjs';
import { groupOf } from './item-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const FAST = 'node --test --test-isolation=none';
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const min = (ms) => Math.round(ms / 6000) / 10;
// Read-only git: never rewrites the project's index.
const gitRO = (cwd, a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------
/** Shape and measured times of one real run (pure on its inputs; exported for the suite). */
export function profileRun({ state, testsMd, stepLogs = {}, events = [] }) {
  const items = parseItems(testsMd || '').filter(i => groupOf(i) === i.n && !/\(\s*revue/i.test(i.text));
  const review = {}, docs = {};
  for (const e of events) {
    if (e.subtype !== 'pipeline_loop' || e.pipeline?.from !== 'revue' || e.pipeline?.item == null) continue;
    const k = e.pipeline.item;
    if (e.pipeline.to === 'tdd') review[k] = (review[k] || 0) + 1;
    else docs[k] = (docs[k] || 0) + 1;
  }
  const steps = {};
  const fixed = [];
  for (const s of state.steps || []) {
    if (s.status === 'skipped' || s.source === 'code') continue;
    const st = steps[s.id] || (steps[s.id] = { calls: 0, refused: 0, stepMs: [], suiteMs: [] });
    st.calls++;
    if (s.status === 'refused') st.refused++;
    st.stepMs.push(Number(s.durationMs) || 0);
    st.suiteMs.push(Number(s.test?.ms) || 0);
    const L = stepLogs[s.key];
    if (L?.cliMs != null) fixed.push(Math.max(0, (Number(s.durationMs) || 0) - (Number(s.test?.ms) || 0) - L.cliMs) + (L.ttftMs || 0));
  }
  const out = {};
  for (const [id, st] of Object.entries(steps)) out[id] = { calls: st.calls, refused: st.refused, modelMs: Math.round(mean(st.stepMs.map((m, i) => m - st.suiteMs[i]))) };
  const suite = (state.steps || []).filter(s => s.test && !s.test.cached).map(s => s.test.ms);
  return {
    // b = rank in the original list (the replay targets it by its text, numbers shift with attached cases).
    items: items.map((i, k) => ({ b: k + 1, n: i.n, declared: i.declared, review: review[i.n] || 0, docs: docs[i.n] || 0 })),
    extraRefusals: (state.steps || []).filter(s => s.id === 'rouge' && s.status === 'refused' && /annonçait/.test(s.why || '')).length,
    steps: out, fixedMs: Math.round(median(fixed)), suite: { runs: suite.length, meanMs: Math.round(mean(suite)) },
    activeMs: Number(state.activeMs) || 0, realCalls: Object.values(out).reduce((a, s) => a + s.calls, 0),
  };
}

function stepLog(file) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return null; }
  const r = lines.find(e => e.type === 'result');
  const first = lines.find(e => e.type === 'stream_event' && Number.isFinite(e.ttft_ms));
  return r ? { cliMs: Number(r.duration_ms) || 0, ttftMs: first ? first.ttft_ms : 0 } : null;
}

async function extract() {
  const logs = opt('--logs'), project = opt('--project'), dir = opt('--project-dir'), out = opt('--out');
  const runs = String(opt('--runs', '')).split(',').filter(Boolean);
  if (!logs || !project || !dir || !out || runs.length < 1) { console.error('usage: extract --logs <dir> --project <name> --project-dir <dir> --runs <id,…> --out <file>'); process.exit(64); }
  const cfg = readJson(path.join(dir, '.orchestrateur', 'pipeline.json')) || {};
  const isTest = (f) => isTestFile(f, cfg.testGlobs);
  const tests = Speed.runnableTests(dir, isTest);
  // The project's log, read once, only lines of the runs asked.
  const want = new Set(runs);
  const events = {};
  const logFile = path.join(logs, `${project}.jsonl`);
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
    if (!line.includes('"pipeline_loop"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (want.has(e.pipeline?.run)) (events[e.pipeline.run] ||= []).push(e);
  }
  const cases = [];
  for (const run of runs) {
    const state = readJson(path.join(logs, 'runs', run, 'run.json'));
    if (!state || state.project !== project) { console.error(`${run} : introuvable pour ce projet`); continue; }
    let testsMd = ''; try { testsMd = fs.readFileSync(path.join(dir, '.orchestrateur', 'runs', run, 'tests.md'), 'utf8'); } catch {}
    const stepLogs = {};
    for (const s of state.steps || []) if (s.key) stepLogs[s.key] = stepLog(path.join(logs, 'runs', run, `${s.key}.jsonl`));
    const p = profileRun({ state, testsMd, stepLogs, events: events[run] || [] });
    // Share of the project's tests an item touches (its delivered commit, read-only).
    const shares = [];
    for (const d of state.delivered || []) {
      const changed = gitRO(dir, ['show', '--name-only', '--format=', d.commit]).stdout.split('\n').map(s => s.trim()).filter(Boolean);
      if (!changed.length) continue;
      const sel = Speed.selectForChanged({ cwd: dir, cfg, changed, isTest, tests });
      shares.push(sel.targeted ? sel.files.length / tests.length : 1);
    }
    // Understand + Design reusable? The request cites the previous run, and the code has not diverged since it ended.
    const cited = Speed.citedRuns(state.request).filter(r => r !== run);
    let reuse = { cited: cited.length > 0, possible: false, why: cited.length ? '' : 'la demande ne cite aucune exécution' };
    for (const c of cited) {
      const prev = readJson(path.join(logs, 'runs', c, 'run.json'));
      if (!prev || prev.pipeline !== 'dev' || prev.mode !== 'complet') { reuse.why = `${c} : pas un Développement complet`; continue; }
      const end = (prev.releases || []).at(-1)?.commit || prev.lastDelivered || prev.base;
      const div = Speed.divergence(dir, cfg, end, state.base);
      if (div) { reuse.why = `${c} : ${div.replace(/: .*/, '')}`; continue; }
      reuse = { cited: true, possible: true, why: `${c} : code inchangé depuis sa fin` };
      break;
    }
    cases.push({ run, ...p, targetedShare: shares.length ? Math.round(mean(shares) * 1000) / 1000 : 1, totalTests: tests.length, reuse });
    console.log(`${run} : ${p.items.length} items, ${p.realCalls} appels réels, ${min(p.activeMs)} min actives, part ciblée ${Math.round(mean(shares) * 100)} %, réutilisation ${reuse.possible ? 'possible' : `non (${reuse.why})`}`);
  }
  fs.writeFileSync(out, `${JSON.stringify({ about: 'Real full-Development runs, anonymised (no project name, no request text) — scripts/pipeline-speed-bench.mjs extract', cases }, null, 2)}\n`);
  console.log(`→ ${out}`);
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------
/** Fake-claude knobs that reproduce a real run's shape (exported for the suite). */
export function replayEnv(c) {
  const env = { FAKE_PIPE_ITEMS: String(c.items.length) };
  const rev = c.items.filter(i => i.review).map(i => `${i.b}:${i.review}`);
  const doc = c.items.filter(i => i.docs).map(i => `${i.b}:${i.docs}`);
  if (rev.length) env.FAKE_PIPE_REVIEW_BASE = rev.join(',');
  if (doc.length) env.FAKE_PIPE_REVIEW_DOC_BASE = doc.join(',');
  if (c.extraRefusals) env.FAKE_PIPE_ITEM_EXTRA_TESTS = `1:${c.extraRefusals}`;
  return env;
}

/**
 * Estimated minutes of an arm from what the replay counted and what the real
 * run measured (rules in the header). → {modelMs, suiteMs, totalMs}
 */
export function estimate(c, counted) {
  const m = (id) => c.steps[id]?.modelMs ?? c.steps.vert?.modelMs ?? 0;
  let modelMs = 0;
  for (const [id, n] of Object.entries(counted.calls)) {
    if (id === 'rouge-vert') modelMs += n * Math.max(m('rouge'), m('rouge') + m('vert') - c.fixedMs);
    else if (id === 'revue') modelMs += counted.reviewItems ? counted.reviewItems * m('revue') - (counted.reviewItems - n) * c.fixedMs : n * m('revue');
    else modelMs += n * m(id);
  }
  const share = Math.max(0.02, c.targetedShare ?? 1);
  const suiteMs = counted.fullRuns * c.suite.meanMs + counted.targetedRuns * c.suite.meanMs * share;
  return { modelMs: Math.round(modelMs), suiteMs: Math.round(suiteMs), totalMs: Math.round(modelMs + suiteMs) };
}

const LEVERS = ['limits', 'redGreen', 'groupReview', 'reuseContext', 'targetedTests', 'extraTests'];

async function replayCase(c, on) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-speed-bench-'));
  const P = path.join(T, 'proj');
  const MARK = path.join(T, 'suite-runs.txt');
  for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' }, projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }] }));
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2,
    assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
    history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'], ...(on ? { tuning: Object.fromEntries(LEVERS.map(l => [l, true])) } : {}) } }));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
  fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  fs.writeFileSync(path.join(P, 'test', 'marker.test.mjs'), "import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('marker', () => { if (process.env.SPEED_MARKER) fs.appendFileSync(process.env.SPEED_MARKER, 'x'); });\n");
  fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
    ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '1000', ORCH_NO_PENDING_RELEASE: '1', SPEED_MARKER: MARK, ...replayEnv(c) };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'ORCH_PIPE_ITEMS', 'ORCH_PIPE_RUN_MS']) delete env[k];
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', `Bench ${c.run}`, '--pipeline', 'dev', '--mode', 'complet'], { env, windowsHide: true, stdio: 'ignore' });
    const t = setTimeout(() => ch.kill(), 30 * 60_000);
    ch.on('exit', (cc) => { clearTimeout(t); resolve(cc); });
  });
  srv.close();
  const runs = fs.readdirSync(path.join(T, 'logs', 'runs'));
  const state = readJson(path.join(T, 'logs', 'runs', runs[0], 'run.json'));
  const log = fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const calls = {};
  for (const s of state.steps) if (s.source !== 'code' && s.status !== 'skipped') calls[s.id] = (calls[s.id] || 0) + 1;
  const batches = log.filter(e => e.subtype === 'pipeline_review_batch');
  const counted = {
    code, status: state.status, pausedLimit: state.pausedLimit || null, wallMs: Date.now() - t0, calls,
    totalCalls: Object.values(calls).reduce((a, b) => a + b, 0),
    reviewItems: batches.length ? batches.reduce((a, e) => a + e.groups.length, 0) + Math.max(0, (calls.revue || 0) - batches.length) : null,
    fullRuns: (() => { try { return fs.readFileSync(MARK, 'utf8').length; } catch { return 0; } })(),
    targetedRuns: log.filter(e => e.subtype === 'pipeline_suite_targeted' && e.files?.length).length,
    delivered: (state.delivered || []).length,
  };
  if (args.includes('--keep')) console.log(`  racine gardée : ${T}`); else try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  return counted;
}

async function replay() {
  const file = opt('--cases', path.join(ROOT, 'tests', 'speed-bench-cases.json'));
  const data = readJson(file);
  if (!data?.cases?.length) { console.error(`aucun cas dans ${file}`); process.exit(64); }
  const rows = [];
  // --only <run> (diagnosis): one case.
  for (const c of data.cases.filter(x => !opt('--only') || x.run === opt('--only'))) {
    console.log(`\n${c.run} : ${c.items.length} items — rejeu leviers coupés…`);
    const off = await replayCase(c, false);
    console.log(`  coupés : ${off.totalCalls} appels, ${off.fullRuns} suites complètes (${off.status}${off.pausedLimit ? ` ${off.pausedLimit}` : ''})`);
    console.log('  rejeu leviers allumés…');
    const onC = await replayCase(c, true);
    console.log(`  allumés : ${onC.totalCalls} appels, ${onC.fullRuns} suites complètes, ${onC.targetedRuns} ciblées (${onC.status}${onC.pausedLimit ? ` ${onC.pausedLimit}` : ''})`);
    // Reuse is decided by the real request and the real history, measured at extraction.
    const reuseSaved = c.reuse?.possible ? (c.steps.comprendre?.modelMs || 0) * (c.steps.comprendre?.calls || 0) + (c.steps.concevoir?.modelMs || 0) * (c.steps.concevoir?.calls || 0) : 0;
    const reuseCalls = c.reuse?.possible ? (c.steps.comprendre?.calls || 0) + (c.steps.concevoir?.calls || 0) : 0;
    const eOff = estimate(c, off);
    const eOn = estimate(c, onC);
    eOn.totalMs -= reuseSaved; eOn.modelMs -= reuseSaved;
    rows.push({ run: c.run, items: c.items.length, real: { calls: c.realCalls, activeMs: c.activeMs }, off: { ...off, est: eOff }, on: { ...onC, est: eOn, totalCalls: onC.totalCalls - reuseCalls, reuse: c.reuse }, gain: {
      calls: off.totalCalls - (onC.totalCalls - reuseCalls), callsPct: Math.round((1 - (onC.totalCalls - reuseCalls) / off.totalCalls) * 100),
      ms: eOff.totalMs - eOn.totalMs, pct: Math.round((1 - eOn.totalMs / eOff.totalMs) * 100) } });
  }
  const md = [
    '# Banc des leviers « vitesse » (0.143.0)', '',
    'Rejeu avec le vrai moteur et le faux claude, leviers coupés puis les six allumés. Appels et suites **comptés** ; temps **estimé** à partir des temps mesurés de l’exécution réelle (règles en tête de `scripts/pipeline-speed-bench.mjs`).', '',
    '| Exécution | Items | Réel : appels / min | Coupés : appels / min estimées | Allumés : appels / min estimées | Gain appels | Gain temps |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.run} | ${r.items} | ${r.real.calls} / ${min(r.real.activeMs)} | ${r.off.totalCalls} / ${min(r.off.est.totalMs)} | ${r.on.totalCalls} / ${min(r.on.est.totalMs)} | −${r.gain.calls} (−${r.gain.callsPct} %) | −${min(r.gain.ms)} min (−${r.gain.pct} %) |`),
    '', '| Exécution | Appels coupés (par étape) | Appels allumés (par étape) | Suites complètes coupés → allumés | Réutilisation |', '|---|---|---|---|---|',
    ...rows.map(r => `| ${r.run} | ${Object.entries(r.off.calls).map(([k, v]) => `${k} ${v}`).join(', ')} | ${Object.entries(r.on.calls).map(([k, v]) => `${k} ${v}`).join(', ')} | ${r.off.fullRuns} → ${r.on.fullRuns} (+${r.on.targetedRuns} ciblées) | ${r.on.reuse?.possible ? 'oui' : `non — ${r.on.reuse?.why || '?'}`} |`),
  ].join('\n');
  const tot = rows.reduce((a, r) => ({ off: a.off + r.off.est.totalMs, on: a.on + r.on.est.totalMs, cOff: a.cOff + r.off.totalCalls, cOn: a.cOn + r.on.totalCalls }), { off: 0, on: 0, cOff: 0, cOn: 0 });
  const summary = `Total : ${tot.cOff} → ${tot.cOn} appels (−${Math.round((1 - tot.cOn / tot.cOff) * 100)} %), ${min(tot.off)} → ${min(tot.on)} min estimées (−${Math.round((1 - tot.on / tot.off) * 100)} %).`;
  console.log(`\n${md}\n\n${summary}`);
  if (opt('--out')) fs.writeFileSync(opt('--out'), `${JSON.stringify({ rows, summary }, null, 2)}\n`);
  if (opt('--md')) fs.writeFileSync(opt('--md'), `${md}\n\n${summary}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const verb = args[0];
  if (verb === 'extract') await extract();
  else if (verb === 'replay') await replay();
  else { console.error('usage: node scripts/pipeline-speed-bench.mjs extract … | replay [--cases f] [--out f] [--md f]'); process.exit(64); }
}
