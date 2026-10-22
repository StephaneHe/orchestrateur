#!/usr/bin/env node
// ============================================================================
// scripts/_test_live_state.mjs — cards follow turns live, pipeline runs and
// resumes included, without restarting the client (0.135.0)
// ============================================================================
//
// User report (2026-10-22, Android app 1.1.0), verbatim: « a l'instant je ne
// vois dans pilotage sur l'application : 1 en cours (Orchestrateur-dev) », then
// « après avoir relancé l'application je vois bien les 2 tâches en cours ».
//
// Causes: (1) the Android live reducer opened a turn only on `system/init`; a
// pipeline run (and its resume) writes a sourced `user_prompt` and
// `system/pipeline_start`, never an init, in the musician's log. (2) Neither
// client corrected a live event missed during a stream gap (sleep, hidden tab,
// reconnect): the /api/pupitre snapshot never changed a card's state.
//
// Protected:
//   - the server sees a pipeline run / resume as a running turn (scanProject);
//   - TurnCore.snapshotState: the rule both clients apply to each snapshot;
//   - app.js applies it in applyPupitreToCards;
//   - Android: LiveStateRule mirrors it, Musician.ingest opens a turn on the
//     server's turn starts, applyPupitre applies the snapshot rule, and the
//     return to foreground re-reads /api/config even on a live-looking stream.
//
//   node scripts/_test_live_state.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../public/turn-core.js';
import { scanProject } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TC = globalThis.TurnCore;
let ok = 0, ko = 0;
function check(label, cond, detail = '') {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { ko++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

console.log('1. Server: a pipeline run started or resumed by the chef is a running turn');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-state-'));
  try {
    const t0 = Date.now() - 120_000;
    const iso = d => new Date(t0 + d).toISOString();
    const lines = [
      { type: 'user_prompt', text: 'avant', timestamp: iso(0) },
      { type: 'system', subtype: 'init', timestamp: iso(1000) },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Une question ?\nNEEDS_USER_INPUT: reprendre les items ?' }] }, timestamp: iso(2000) },
      { type: 'result', subtype: 'success', result: 'NEEDS_USER_INPUT: reprendre les items ?', timestamp: iso(3000) },
    ];
    const log = path.join(dir, 'psy.jsonl');
    fs.writeFileSync(log, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    check('a pause leaves the musician on its question', scanProject('psy', dir).state === 'input', scanProject('psy', dir).state);
    fs.appendFileSync(log, [
      { type: 'user_prompt', source: 'chef', text: 'reprendre les items', timestamp: iso(60_000) },
      { type: 'system', subtype: 'pipeline_start', pipeline: { run: 'p-x' }, timestamp: iso(61_000) },
    ].map(l => JSON.stringify(l)).join('\n') + '\n');
    const s = scanProject('psy', dir);
    check('resume by the chef (sourced prompt + pipeline_start, no init) ⇒ live', s.state === 'live', s.state);
    check('lastTurnStartAt = the pipeline_start', s.lastTurnStartAt === t0 + 61_000, String(s.lastTurnStartAt));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('2. TurnCore: turn starts and the snapshot rule');
{
  check('pipeline_start opens a turn', TC.isTurnStart({ type: 'system', subtype: 'pipeline_start' }));
  check('a sourced prompt alone does not', !TC.isTurnStart({ type: 'user_prompt', source: 'chef' }));
  for (const s of ['idle', 'unread', 'input', 'error']) check(`${s} → live at a turn start`, TC.stateAtTurnStart(s) === 'live');
  const S = TC.snapshotState;
  check('missed start, server saw a newer turn: adopted at once', S('idle', 'live', 0, true) === 'live');
  check('missed start from a question: adopted at once', S('input', 'live', 0, true) === 'live');
  check('snapshot a beat behind a live result (same turn): not at once', S('unread', 'live', 0, false) === null);
  check('… adopted at the second snapshot', S('unread', 'live', 1, false) === 'live');
  check('missed end: not at the first snapshot', S('live', 'unread', 0, false) === null);
  check('missed end: adopted at the second', S('live', 'unread', 1, false) === 'unread');
  check('missed question: adopted at the second', S('idle', 'input', 1, false) === 'input');
  check('live vs think: never', S('think', 'live', 9, true) === null);
  check('unread vs idle (read marker): never', S('unread', 'idle', 9, false) === null && S('idle', 'unread', 9, false) === null);
  check('same state: nothing', S('live', 'live', 9, true) === null);
}

console.log('3. Dashboard: the snapshot rule is applied to every card');
{
  const app = read('public/app.js');
  const fn = app.slice(app.indexOf('applyPupitreToCards() {'), app.indexOf('applyPupitreToCards() {') + 2500);
  check('applyPupitreToCards calls TurnCore.snapshotState', /TurnCore\.snapshotState\(m\.state, r\.state, streak, newerTurn\)/.test(fn));
  check('newerTurn compares the server turn start with the local one', /newerTurn = Number\(r\.lastTurnStartAt\) > \(m\.turnStartMs \|\| 0\)/.test(fn));
  check('the live reducer opens a turn on pipeline_start (TurnCore.isTurnStart)', /else if \(window\.TurnCore\.isTurnStart\(raw\)\)/.test(app));
}

console.log('4. Android: same turn starts, same snapshot rule, re-read on return');
{
  const kt = 'android/app/src/main/java/com/orchestrateur/';
  const rule = read(kt + 'data/LiveStateRule.kt');
  const mus = read(kt + 'data/Musician.kt');
  const vm = read(kt + 'ui/fleet/FleetViewModel.kt');
  check('LiveStateRule.stateAtTurnStart: idle, unread, input, error → live', /State\.idle, State\.unread, State\.input, State\.error -> State\.live/.test(rule));
  check('LiveStateRule.fromSnapshot mirrors snapshotState', /busy\(server\) && newerTurn\) return server/.test(rule) && /streak >= 1\) server else null/.test(rule));
  check('Musician.ingest opens a turn on QuestionRule.isTurnStart (pipeline_start included)', /isTurnStart\(raw\.type, raw\.subtype, raw\.source\)\)[\s\S]{0,400}state = LiveStateRule\.stateAtTurnStart\(state\)/.test(mus));
  check('Musician.applyPupitre applies the snapshot rule', /LiveStateRule\.fromSnapshot\(state, server,/.test(mus));
  check('QuestionRule.isTurnStart knows pipeline_start and dual_start', /pipeline_start/.test(read(kt + 'data/QuestionRule.kt')) && /dual_start/.test(read(kt + 'data/QuestionRule.kt')));
  check('resumeStream re-reads /api/config on a live-looking stream', /fun resumeStream\(\)[\s\S]{0,500}syncFromConfig\(\)/.test(vm));
  check('JVM test LiveStateRuleTest exists', fs.existsSync(path.join(ROOT, 'android/app/src/test/java/com/orchestrateur/data/LiveStateRuleTest.kt')));
}

console.log(`\n${ok} OK, ${ko} KO`);
process.exit(ko ? 1 : 0);
