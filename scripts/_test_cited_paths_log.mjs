#!/usr/bin/env node
// ============================================================================
// scripts/_test_cited_paths_log.mjs — pipelines phase 0 a: cited paths judged
// on the files the turn really read (lever 1, switch `citedPathsLog`)
// ============================================================================
//
// User decisions (2026-10-20, « tout comme recommandé » on
// docs/PIPELINES-SYNTHESE.md): « Discussion : les chemins cités sont jugés sur
// les fichiers réellement lus pendant le tour. Supprime les faux refus
// « chemins cités inexistants » (7 sur 10). »
//
// Real cases (prod logs, read-only, 2026-10-20), anonymised here: under
// v0.119.0, 5 of the 8 historical refusals still happen — a run artefact read
// in the turn (`rouge.md`, `taches.json`), an event type (`system/init`), a
// file of another project the turn read, a bare file name whose full path the
// turn listed, a Python library frame seen in a test output, an elided path.
//
// Protected:
//   - with the switch on: each of those shapes is accepted, and REPORTED
//     (run.json step `citedReported`, step event) — never silent;
//   - NOT weakened: an invented path of the project is still refused; a path
//     named only in a command line, a Read that failed, or the artefact the
//     turn wrote itself are not observations;
//   - switch off (default) = exactly the old rule; a run keeps the settings
//     it read when it started (run.json `tuning`);
//   - `pipeline-enforce.mjs tuning …` writes the switch per project or for all,
//     keeps it across other enforcement changes, `off --all` clears it.
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_cited_paths_log.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judgeCitedPaths, observedInTurn } from './cited-paths.mjs';
import { missingCitedPaths, orchArtefactNames, readEnforcement, writeEnforcement } from './pipeline-engine.mjs';
import { applyTuningChange, tuningFor, runTuning, readTuning, LEVER_IDS } from './pipeline-tuning.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cited-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef'), path.join(P, 'src')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(P, 'src', 'present.mjs'), 'export const x = 1;\n');

// A stream-json log as the CLI writes it.
const logFile = (name, events) => { const f = path.join(T, name); fs.writeFileSync(f, events.map(e => JSON.stringify(e)).join('\n') + '\n'); return f; };
const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, content, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });
const ORCH = orchArtefactNames();
const judge = (art, events) => judgeCitedPaths(art, P, { observed: observedInTurn(logFile(`l-${Math.random().toString(36).slice(2)}.jsonl`, events)), orchNames: ORCH });

// ---------------------------------------------------------------------------
section('1. Les cinq formes réelles refusées à tort : acceptées et signalées');
{
  const cases = [
    ['artefact d’une exécution lu pendant le tour', 'Le `rouge.md` de l’exécution précédente affirme le contraire.', [use('a', 'Read', { file_path: `${P}/.orchestrateur/runs/p-1/rouge.md` }), res('a', 'contenu')]],
    ['type d’événement de l’orchestrateur', 'Le model réel est dans l’événement `system/init` du journal.', []],
    ['fichier d’un autre projet lu pendant le tour', 'Le modèle vient de `docs/PORTFOLIO.md` (autre projet).', [use('b', 'Read', { file_path: 'I:/Dev/autre/docs/PORTFOLIO.md' }), res('b', '# Portfolio')]],
    ['nom de fichier nu dont le chemin complet a été listé', 'Voir `SearchApi.kt`.', [use('c', 'Bash', { command: 'git ls-files' }), res('c', 'app/src/main/java/x/SearchApi.kt\nREADME.md')]],
    ['cadre de la bibliothèque Python vu dans une sortie de test', 'Remonte depuis `ssl.py:1103` ← `socket.py:720`.', [use('d', 'Bash', { command: 'python -m pytest' }), res('d', 'File "C:/Python/Lib/ssl.py", line 1103\nFile "C:/Python/Lib/socket.py", line 720')]],
    ['chemin abrégé', 'Son `dispatch.json` (dans `I:\\Dev\\Chef\\.orchestrateur\\runs\\…`).', []],
  ];
  for (const [label, art, ev] of cases) {
    const before = missingCitedPaths(art, P);
    const after = judge(art, ev);
    ok(before.length > 0, `${label} : refusé par l’ancienne règle (${before.join(', ')})`);
    ok(!after.missing.length && after.reported.length > 0, `${label} : accepté, signalé (${after.reported.map(r => `${r.path} — ${r.why}`).join(' ; ')})`, JSON.stringify(after));
  }
}

section('2. Non affaibli : une affirmation positive sur un fichier du projet reste vérifiée');
{
  let v = judge('Le code est dans `src/invente.mjs`.', [use('a', 'Read', { file_path: `${P}/src/present.mjs` }), res('a', 'export const x = 1;')]);
  ok(v.missing.includes('src/invente.mjs'), 'chemin inventé, jamais lu : refusé');
  v = judge('Le code est dans `src/invente.mjs`.', [use('a', 'Bash', { command: 'cat src/invente.mjs' }), res('a', 'cat: No such file')]);
  ok(v.missing.includes('src/invente.mjs'), 'chemin seulement nommé dans une ligne de commande : refusé (ce n’est pas une observation)');
  v = judge('Le code est dans `src/invente.mjs`.', [use('a', 'Read', { file_path: `${P}/src/invente.mjs` }), res('a', 'File does not exist.', true)]);
  ok(v.missing.includes('src/invente.mjs'), 'lecture en échec : refusé');
  v = judge('Le code est dans `src/invente.mjs`.', [use('a', 'Write', { file_path: `${P}/.orchestrateur/runs/p-1/comprehension.md`, content: 'src/invente.mjs' }), res('a', 'File created at src/invente.mjs')]);
  ok(v.missing.includes('src/invente.mjs'), 'l’artefact écrit par le tour lui-même ne compte pas comme une lecture : refusé');
  v = judge('Le module `src/present.mjs` et ni `pyproject.toml` ni `setup.py`.', []);
  ok(!v.missing.length && !v.reported.length, 'fichier existant et fichiers déclarés absents : acceptés comme avant, rien à signaler');
  v = judge('Voir `src/invente/rouge.md`.', [use('a', 'Read', { file_path: `${P}/x.md` }), res('a', 'rien')]);
  ok(v.missing.includes('src/invente/rouge.md'), 'un nom d’artefact dans un chemin du projet n’est pas excusé : refusé');
}

// ---------------------------------------------------------------------------
section('3. Interrupteur : par levier, pour un projet ou tous, gardé, remis à zéro par off --all');
{
  let t = applyTuningChange({}, { on: true, lever: 'citedPathsLog', project: 'pipelineLab' });
  ok(JSON.stringify(t) === '{"citedPathsLog":["pipelineLab"]}', `on pour un projet : ${JSON.stringify(t)}`);
  ok(tuningFor(t, 'pipelineLab').citedPathsLog && !tuningFor(t, 'autre').citedPathsLog, 'actif pour ce projet seulement');
  t = applyTuningChange(t, { on: true, lever: 'all' });
  ok(LEVER_IDS.every(k => t[k] === true), 'all on sans projet : tous les leviers, tous les projets');
  let threw = false; try { applyTuningChange(t, { on: false, lever: 'codeDeliver', project: 'x' }); } catch { threw = true; }
  ok(threw, 'off d’un projet sur un levier actif partout : refusé avec une explication');
  t = applyTuningChange(t, { on: false, lever: 'all' });
  ok(!Object.keys(t).length, 'all off : plus rien');
  const st = {};
  const a = runTuning(st, T, 'P', {});
  ok(LEVER_IDS.every(k => a[k] === false) && st.tuning, 'sans réglage : tout coupé (comportement d’avant), figé dans l’état de l’exécution');
  const old = runTuning({}, T, 'P', { resumed: true });
  ok(LEVER_IDS.every(k => old[k] === false), 'exécution reprise d’avant la phase 0 (sans réglages) : tout coupé');
}

// The real CLI, on a throwaway root.
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'rechercher', 'repondre'].map(s => [`discussion.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
}));
const enforce = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline-enforce.mjs'), ...a], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: T }, encoding: 'utf8' });
{
  let r = enforce('tuning', 'citedPathsLog', 'on', 'P');
  ok(r.status === 0 && JSON.stringify(readTuning(T)) === '{"citedPathsLog":["P"]}', `pipeline-enforce tuning citedPathsLog on P (${r.stdout.trim().split('\n')[0]})`, r.stderr);
  r = enforce('tuning', 'inconnu', 'on');
  ok(r.status === 64, 'levier inconnu : refusé (64)');
  r = enforce('tuning', 'citedPathsLog', 'on', 'pasUnProjet');
  ok(r.status === 64, 'projet inconnu : refusé (64)');
  r = enforce('on', 'chef');
  ok(JSON.stringify(readTuning(T)) === '{"citedPathsLog":["P"]}', 'une autre modification de la mise en service garde les réglages');
  const e = readEnforcement(T);
  writeEnforcement(T, { projects: e.projects, pipelines: e.pipelines, by: 'test' });
  ok(JSON.stringify(readTuning(T)) === '{"citedPathsLog":["P"]}', 'writeEnforcement sans réglages donnés : les garde');
  r = enforce('off', '--all');
  ok(!Object.keys(readTuning(T)).length && !readEnforcement(T).projects.length, 'off --all : retour arrière complet, réglages compris');
  enforce('on', 'P');
}

// ---------------------------------------------------------------------------
section('4. De bout en bout (vrai dispatch, Discussion) : refus avant, accepté et signalé après');
const srv = http.createServer((req, rs) => { req.resume(); req.on('end', () => rs.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
fs.mkdirSync(path.join(P, '.orchestrateur'), { recursive: true });
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '1',
  FAKE_CLAUDE_READ_PATH: 'I:/Dev/autre/docs/PORTFOLIO.md', FAKE_PIPE_CITE: 'docs/PORTFOLIO.md',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'FAKE_PIPE_BAD']) delete baseEnv[k];
const dispatch = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: baseEnv, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const go = async (args) => { const n0 = logOf().length; const r = await dispatch(args); const evs = logOf().slice(n0); const run = evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run; return { ...r, evs, run, state: run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : {} }; };
const Q = 'D’où vient le texte du portfolio ?';
{
  let r = await go([Q, '--pipeline', 'discussion']);
  const c1 = r.state.steps?.filter(s => s.id === 'comprendre') || [];
  ok(c1.length >= 1 && c1.every(s => s.status === 'refused') && /chemins cités inexistants : docs\/PORTFOLIO\.md/.test(c1[0].why || ''), `interrupteur coupé : Comprendre refusé comme avant (${c1.map(s => s.status).join(', ')})`, r.out.slice(-800));
  ok(LEVER_IDS.every(k => r.state.tuning?.[k] === false), 'réglages figés dans run.json : tout coupé');

  enforce('tuning', 'citedPathsLog', 'on', 'P');
  r = await go([Q, '--pipeline', 'discussion']);
  const c2 = r.state.steps?.filter(s => s.id === 'comprendre') || [];
  ok(r.code === 0 && r.state.status === 'done', `interrupteur actif : exécution terminée (code ${r.code}, ${r.state.status})`, r.out.slice(-800));
  ok(c2.length === 1 && c2[0].status === 'ok', `Comprendre accepté du premier coup (${c2.map(s => `${s.status} ${s.why || ''}`).join(' | ')})`);
  ok(c2[0]?.citedReported?.some(x => x.path === 'docs/PORTFOLIO.md' && /lu pendant le tour/.test(x.why)), `chemin signalé dans run.json (${JSON.stringify(c2[0]?.citedReported)})`);
  const ev = r.evs.find(e => e.subtype === 'pipeline_step_done' && e.pipeline?.step === 'comprendre');
  ok(/chemins acceptés hors projet : docs\/PORTFOLIO\.md \(lu pendant le tour\)/.test(ev?.text || '') && ev?.citedReported, 'signalé dans l’événement de l’étape (frise), jamais en silence');
  ok(r.state.tuning?.citedPathsLog === true && r.evs.some(e => e.subtype === 'pipeline_tuning'), 'réglages figés au départ et tracés (system/pipeline_tuning)');

  // A run keeps what it read at its start: the frozen value wins over the file.
  const st = { tuning: r.state.tuning };
  enforce('tuning', 'citedPathsLog', 'off', 'P');
  ok(runTuning(st, T, 'P', { resumed: true }).citedPathsLog === true && readTuning(T).citedPathsLog === undefined, 'une exécution garde le réglage lu à son départ, même coupé depuis');
}

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* Windows: a file may still be open */ }
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
