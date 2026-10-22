#!/usr/bin/env node
// ============================================================================
// scripts/_test_run_callback.mjs — the callback belongs to the RUN (0.136.0)
// ============================================================================
//
// User request (2026-10-22), verbatim: « peut-on le mettre dans le code à la
// place ou en plus de ta mémoire ? » — about the chef's slip « tu n'as pas
// intercepté la question de psyProfile ». Real case: a run launched with
// `--callback chef` paused; the chef answered (« découper <run> ») without
// --callback, and the next pauses woke nobody. Worse, a resume launched WITH
// --callback chef ended on a pause for the user and did not wake the chef
// either (the server excluded `input` from wakes).
//
// Protected:
//   - runCallback: the run's callback (run.json) is reused by every resume,
//     whoever launches it; a resume by the chef sets it to the chef;
//   - awaitedWake (server pump): a paused pipeline run awaited by the chef
//     wakes it, a question to the user outside a pipeline still does not;
//   - real dispatch.mjs: launch with callback → pause → resume WITHOUT
//     --callback → 2nd pause → the resume's turn awaits the chef, the chef is
//     notified and the server rule wakes it; a run resumed from the chef's turn
//     without --callback calls it back, then a user's answer keeps it.
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_run_callback.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCallback } from './pipeline-engine.mjs';
import { awaitedWake, scanProject } from './fleet-status-core.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. runCallback : le rappel appartient à l’exécution');
{
  const s = { callback: 'chef' };
  ok(runCallback(s, {}) === 'chef' && s.callback === 'chef', 'reprise sans --callback : celui de l’exécution');
  const n = { callback: null };
  ok(runCallback(n, { chefCallback: 'chef' }) === 'chef' && n.callback === 'chef', 'reprise par le chef sans --callback : le chef, gardé dans run.json');
  const o = { callback: 'chef' };
  ok(runCallback(o, { callbackProject: 'autre' }) === 'autre' && o.callback === 'autre', '--callback explicite : il prime et devient celui de l’exécution');
  ok(runCallback({ callback: 'X' }, { chefCallback: 'chef' }) === 'X', 'un rappel déjà posé n’est pas remplacé par celui du chef');
  ok(runCallback({}, {}) === null, 'aucun rappel nulle part : aucun');
}

// ---------------------------------------------------------------------------
section('2. awaitedWake : une pause de pipeline attendue réveille le chef');
{
  const base = { expected: 'chef', conductor: 'chef', name: 'P' };
  const paused = { type: 'result', pipeline_paused: true };
  const w = awaitedWake({ ...base, newState: 'input', ev: paused });
  ok(w?.outcome === 'ask_chef' && w.awaitingChef === true && w.pipelinePause === true, 'pause pour l’utilisateur (NEEDS_USER_INPUT) : réveil « ⇄ attend ta décision »', JSON.stringify(w));
  ok(awaitedWake({ ...base, newState: 'unread', awaitingChef: true, ev: paused })?.outcome === 'ask_chef', 'pause tranchée par le chef (NEEDS_CHEF_INPUT) : réveil');
  ok(awaitedWake({ ...base, newState: 'input', ev: { type: 'result' } }) === null, 'question d’un tour ordinaire : pas de réveil (la bulle suffit, inchangé)');
  ok(awaitedWake({ ...base, newState: 'unread', ev: { type: 'result' } })?.outcome === 'done', 'fin de tour : réveil, inchangé');
  ok(awaitedWake({ ...base, newState: 'error', ev: { type: 'result' } })?.outcome === 'failed', 'échec : réveil, inchangé');
  ok(awaitedWake({ ...base, expected: null, newState: 'input', ev: paused }) === null, 'personne n’attend : aucun réveil');
  ok(awaitedWake({ ...base, name: 'chef', newState: 'input', ev: paused }) === null, 'jamais le chef pour lui-même');
}

// ---------------------------------------------------------------------------
// Throwaway root; a fake server records the notifications (/api/notify).
// ---------------------------------------------------------------------------
const notes = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.setEncoding('utf8'); req.on('data', c => { b += c; });
  req.on('end', () => { if (req.url.startsWith('/api/notify')) { try { notes.push(JSON.parse(b)); } catch {} } res.end('{}'); });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-run-cb-'));
const P = path.join(T, 'proj');
const Q = path.join(T, 'proj2');
const LOGS = path.join(T, 'logs');
for (const d of [LOGS, P, Q, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }, { name: 'Q', path: Q }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P', 'Q'], pipelines: ['discussion', 'dev'] },
}));
for (const dir of [P, Q]) {
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: dir, encoding: 'utf8' });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(dir, d));
fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(dir, 'test', 'pipe.test.mjs'), "import { test } from 'node:test';\ntest('pipe', () => {});\n");
fs.writeFileSync(path.join(dir, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(dir, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(dir, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
}

// Livrer always refused, one attempt: every run (and every resume) pauses.
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|REQUEST_ID|TURN_ID)$|^DISPATCH_(SLOT|TICKET|WAKE_GEN|REPORT_ONLY)$|^FAKE_PIPE_|^ORCH_PIPE_(ITEMS|REVIEW_ROUNDS|GREEN_ATTEMPTS|CRITERIA_ATTEMPTS)$/.test(k)) delete baseEnv[k];
Object.assign(baseEnv, { FAKE_PIPE_BAD: 'livrer:99', ORCH_PIPE_CRITERIA_ATTEMPTS: '1' });
let PROJ = 'P';
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), PROJ, ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(LOGS, `${PROJ}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => { try { return JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', run, 'run.json'), 'utf8')); } catch { return null; } };
const lastPrompt = () => logOf().filter(e => e.type === 'user_prompt').pop();
const lastResult = () => logOf().filter(e => e.type === 'result').pop();
// What the server pump decides at the end of the last turn: the opening
// prompt's callback, the musician's state (scanProject), the result.
const serverWake = () => awaitedWake({ expected: lastPrompt()?.callback || null, conductor: 'chef', name: PROJ, newState: scanProject(PROJ, LOGS).state, ev: lastResult() });
// Pause notifications only (a refused attempt also reports its defect to the chef).
const chefNotes = (run) => notes.filter(n => n.project === 'chef' && /^pipeline(-limit|-chef-pause)?$/.test(n.source || '') && String(n.text || '').includes(run));

// ---------------------------------------------------------------------------
section('3. Lancement avec --callback chef → pause');
let r = await dispatch(['Ajoute le tri des vidéos', '--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple', '--callback', 'chef']);
const run = logOf().find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
ok(r.code === 2 && runState(run)?.status === 'paused', `en pause (code ${r.code})`, r.out.slice(-900));
ok(runState(run)?.callback === 'chef', 'run.json garde le rappel au chef');
ok(chefNotes(run).length === 1, `le chef est prévenu de la 1re pause (${chefNotes(run).length})`);
ok(serverWake()?.pipelinePause === true, 'le serveur réveille le chef sur la 1re pause', JSON.stringify(serverWake()));

// ---------------------------------------------------------------------------
section('4. Reprise SANS --callback → 2e pause : le chef est réveillé');
r = await dispatch(['--pipeline-resume', run, 'continuer']);
ok(r.code === 2 && runState(run)?.status === 'paused', `de nouveau en pause (code ${r.code})`, r.out.slice(-900));
ok(lastPrompt()?.pipeline?.run === run && lastPrompt()?.callback === 'chef', 'le tour de reprise attend le chef (callback du user_prompt)', JSON.stringify(lastPrompt()?.callback));
ok(chefNotes(run).length === 2, `le chef est prévenu de la 2e pause (${chefNotes(run).length})`);
const w2 = serverWake();
ok(w2?.outcome === 'ask_chef' && w2.awaitingChef && w2.pipelinePause, 'le serveur réveille le chef : « ⇄ attend ta décision »', JSON.stringify(w2));
// A user's answer from the menu (« changer le model », answerPausedRun) keeps it too.
r = await dispatch(['--pipeline-resume', run, 'changer le model']);
ok(lastPrompt()?.pipeline?.answer === 'changer le model' && lastPrompt()?.callback === 'chef', 'réponse au menu sans --callback : le chef attend encore', JSON.stringify(lastPrompt()));
ok(serverWake()?.pipelinePause === true, 'toujours en pause : le chef est réveillé');

// ---------------------------------------------------------------------------
section('5. Exécution lancée sans rappel, reprise par le chef qui l’oublie');
PROJ = 'Q';
r = await dispatch(['Ajoute le tri des photos', '--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple']);
const run2 = logOf().filter(e => e.type === 'user_prompt' && e.pipeline).pop()?.pipeline.run;
ok(run2 && run2 !== run && r.code === 2 && runState(run2)?.status === 'paused' && !runState(run2)?.callback, `en pause, sans rappel (code ${r.code})`);
ok(serverWake() === null, 'personne n’attend : pas de réveil');
// Launched from the chef's turn (ORCH_TURN_PROJECT=chef), without --callback.
r = await dispatch(['--pipeline-resume', run2, 'continuer'], { ORCH_TURN_PROJECT: 'chef' });
ok(r.code === 2 && lastPrompt()?.pipeline?.run === run2 && lastPrompt()?.callback === 'chef', `reprise par le chef : rappel posé d’office (code ${r.code})`, r.out.slice(-600));
ok(runState(run2)?.callback === 'chef', 'run.json : le rappel est désormais celui de l’exécution');
ok(serverWake()?.pipelinePause === true, 'la pause suivante réveille le chef');
// Then the user (or the app, or the auto-answer) resumes it without anything.
r = await dispatch(['--pipeline-resume', run2, 'continuer']);
ok(lastPrompt()?.pipeline?.run === run2 && lastPrompt()?.callback === 'chef' && serverWake()?.pipelinePause === true, 'reprise suivante par l’utilisateur : le chef est toujours réveillé');

// ---------------------------------------------------------------------------
section('6. Câblage');
{
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/const awaited = awaitedWake\(\{ expected: expectCallback/.test(server), 'server.js : le réveil passe par awaitedWake');
  ok(/attend ta décision/.test(server), 'server.js : le réveil dit « attend ta décision » pour une pause');
  const d = fs.readFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), 'utf8');
  ok((d.match(/chefCallback: CHEF_RESUME_CALLBACK/g) || []).length >= 4, 'dispatch.mjs : toutes les reprises reçoivent le rappel du chef');
  ok(/pipelineResumeArg && !callbackProject && CHEF_RESUME_CALLBACK\) payload\.callback/.test(d), 'dispatch.mjs : une reprise du chef mise en file garde le rappel');
}

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
