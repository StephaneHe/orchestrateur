#!/usr/bin/env node
// ============================================================================
// scripts/_test_resume_clears_question.mjs — a resumed run no longer asks
// (0.134.0)
// ============================================================================
//
// User report (2026-10-22), verbatim: « [projet] est toujours marqué avec
// "votre réponse attendue" ». The run had been resumed (« reprendre les
// items »), the musician was LIVE, yet run.json still carried the previous
// pause's `question`, and the chef thread kept the question bubble with its
// « votre décision » buttons.
//
// Protected:
//   - TurnCore.questionOpen: a question stops waiting once marked answered
//     after it, or once a turn of the musician opened after it;
//   - runView (/api/pipeline-runs): `question` only for a paused run, even for
//     a run.json written by an older engine;
//   - real dispatch.mjs: pause → resume ⇒ while the run goes again, run.json
//     has no `question` (kept in `answeredQuestions`), the musician is not
//     `input`, no needsInput, and lastTurnStartAt is after the question;
//   - the clients apply the rule: app.js (bubble, /api/config, /api/pupitre,
//     SSE), Android (QuestionRule in the bubble, Musician, config, pupitre).
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_resume_clears_question.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../public/turn-core.js';
import { runView } from './pipeline-run-view.mjs';
import { scanProject } from './fleet-status-core.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const TC = globalThis.TurnCore;

// ---------------------------------------------------------------------------
section('1. TurnCore.questionOpen');
{
  ok(TC.questionOpen({ askedAt: 1000 }) === true, 'aucune preuve : la question attend');
  ok(TC.questionOpen({ askedAt: 1000, turnStartedAt: 500 }) === true, 'le tour qui a posé la question ne la clôt pas');
  ok(TC.questionOpen({ askedAt: 1000, turnStartedAt: 2000 }) === false, 'un tour ouvert APRÈS la question : plus de réponse attendue');
  ok(TC.questionOpen({ askedAt: 1000, resolvedAt: 1000 }) === false, 'marquée répondue après elle : close');
  ok(TC.questionOpen({ askedAt: '2026-10-22T14:30:56Z', turnStartedAt: '2026-10-22T14:31:21Z' }) === false, 'horodatages ISO acceptés');
  ok(TC.questionOpen({ askedAt: undefined, turnStartedAt: 2000 }) === true, 'question sans date : jamais close au hasard');
}

// ---------------------------------------------------------------------------
section('2. runView : la question seulement pour une exécution en pause');
{
  const q = '[projet] en pause — répondez « reprendre les items »';
  ok(runView({ run: 'p-1', status: 'paused', question: q }).question === q, 'en pause : la question est exposée');
  const v = runView({ run: 'p-1', status: 'running', question: q, diagnosis: { options: [{ key: 'reprendre les items', does: 'x' }] } });
  ok(v.question === null && v.pause === null, 'reprise (run.json d’un ancien moteur) : ni question ni menu', JSON.stringify(v));
  ok(runView({ run: 'p-1', status: 'done', question: q }).question === null, 'terminée : plus de question');
}

// ---------------------------------------------------------------------------
// Throwaway root
// ---------------------------------------------------------------------------
const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-resume-q-'));
const P = path.join(T, 'proj');
const LOGS = path.join(T, 'logs');
for (const d of [LOGS, P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(P, 'test', 'pipe.test.mjs'), "import { test } from 'node:test';\ntest('pipe', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|REQUEST_ID)$|^DISPATCH_SLOT$|^FAKE_PIPE_|^ORCH_PIPE_(ITEMS|REVIEW_ROUNDS|GREEN_ATTEMPTS|CRITERIA_ATTEMPTS)$/.test(k)) delete baseEnv[k];
const spawnDispatch = (args, env = {}) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  const done = new Promise(resolve => c.on('exit', code => { clearTimeout(t); resolve({ code, out }); }));
  return { child: c, done };
};
const logOf = () => { try { return fs.readFileSync(path.join(LOGS, 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => { try { return JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', run, 'run.json'), 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
section('3. Pause (vrai dispatch) : la question est attendue');
const LIVRER_KO = { FAKE_PIPE_BAD: 'livrer:99', ORCH_PIPE_CRITERIA_ATTEMPTS: '1' };
let r = await spawnDispatch(['Ajoute le tri des vidéos', '--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple'], LIVRER_KO).done;
const run = logOf().find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
const s0 = run && runState(run);
ok(r.code === 2 && s0?.status === 'paused' && typeof s0.question === 'string' && s0.question.length > 0, `en pause avec une question (code ${r.code}, ${s0?.status})`, r.out.slice(-900));
const scan0 = scanProject('P', LOGS);
ok(scan0.state === 'input' && !!scan0.needsInput, `musicien « votre réponse attendue » (${scan0.state})`);
ok(runView(s0).question === s0.question, '/api/pipeline-runs : la question est exposée pendant la pause');
// The chef thread's question bubble is dated by the server's notification,
// written after the pause's result: the result's time is a lower bound.
const askedAt = Date.parse(logOf().filter(e => e.type === 'result').pop()?.timestamp || '') || Date.now();
ok(TC.questionOpen({ askedAt, turnStartedAt: scan0.lastTurnStartAt }) === true, 'la bulle du fil reste ouverte tant que rien ne reprend');

// ---------------------------------------------------------------------------
section('4. Reprise : plus aucune « réponse attendue », pendant que l’exécution repart');
await sleep(20);
const resume = spawnDispatch(['--pipeline-resume', run, 'continuer'], { FAKE_CLAUDE_LATENCY_MS: '1500' });
let seen = null;
for (let i = 0; i < 300 && !seen; i++) {
  const s = runState(run);
  if (s?.status === 'running' && logOf().some(e => e.subtype === 'pipeline_start' && /reprise/.test(e.text || ''))) seen = s;
  else await sleep(50);
}
ok(!!seen, 'l’exécution repart (status running)');
if (seen) {
  ok(!('question' in seen), 'run.json en cours : plus de champ question', JSON.stringify(seen.question));
  ok(seen.answeredQuestions?.length === 1 && seen.answeredQuestions[0].text === s0.question && !!seen.answeredQuestions[0].answeredAt,
    'la question est gardée comme historique (answeredQuestions)', JSON.stringify(seen.answeredQuestions));
  const v = runView(seen);
  ok(v.question === null && v.pause === null, '/api/pipeline-runs : ni question ni menu de pause');
  const scan1 = scanProject('P', LOGS);
  ok(scan1.state !== 'input' && scan1.needsInput === null, `musicien plus « votre réponse attendue » (${scan1.state})`);
  ok(Number.isFinite(scan1.lastTurnStartAt) && scan1.lastTurnStartAt >= askedAt, 'lastTurnStartAt : le tour de reprise, après la question');
  ok(TC.questionOpen({ askedAt, turnStartedAt: scan1.lastTurnStartAt }) === false, 'la bulle de question du fil passe « reprise — plus de réponse attendue »');
}
r = await resume.done;
const s2 = runState(run);
ok(s2.status !== 'paused' || s2.question !== s0.question || (s2.answeredQuestions || []).length >= 1, `fin de la reprise (${s2.status}, code ${r.code})`);
if (s2.status !== 'paused') ok(!('question' in s2) && runView(s2).question === null, 'exécution finie : aucune question résiduelle');

// ---------------------------------------------------------------------------
section('5. Les clients appliquent la règle');
{
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok(/questionOpen\(\{\s*askedAt: b\.ts, turnStartedAt: m\?\.turnStartMs\s*\}\)/.test(app) && /plus de réponse attendue/.test(app), 'app.js : la bulle de question applique TurnCore.questionOpen');
  ok(/this\.turnStartMs = Number\(project\.lastTurnStartAt\)/.test(app), 'app.js : /api/config (rechargement) donne le dernier début de tour');
  ok(/r\.lastTurnStartAt\)\s*>\s*\(m\.turnStartMs/.test(app), 'app.js : /api/pupitre le met à jour');
  ok(/isTurnStart\(raw\) && App\.chat\.some\(b => b\.role === "question"/.test(app), 'app.js : un début de tour en direct redessine la bulle');
  const A = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'orchestrateur');
  const pane = fs.readFileSync(path.join(A, 'ui', 'fleet', 'MainPane.kt'), 'utf8');
  ok(/QuestionRule\.isOpen\(msg\.ts, m\?\.lastTurnStartMs\)/.test(pane) && /PLUS DE RÉPONSE ATTENDUE/.test(pane), 'Android : la bulle applique QuestionRule');
  const mus = fs.readFileSync(path.join(A, 'data', 'Musician.kt'), 'utf8');
  ok(/QuestionRule\.isTurnStart\(raw\.type, raw\.subtype, raw\.source\)/.test(mus) && /noteTurnStart\(row\.lastTurnStartAt/.test(mus), 'Android : Musician note chaque début de tour (flux et pupitre)');
  const vm = fs.readFileSync(path.join(A, 'ui', 'fleet', 'FleetViewModel.kt'), 'utf8');
  ok(/noteTurnStart\(p\.lastTurnStartAt/.test(vm), 'Android : /api/config aussi');
  const rule = fs.readFileSync(path.join(A, 'data', 'QuestionRule.kt'), 'utf8');
  ok(/pipeline_start/.test(rule) && /dual_start/.test(rule), 'Android : mêmes ouvertures de tour que TurnCore.isTurnStart');
}

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
