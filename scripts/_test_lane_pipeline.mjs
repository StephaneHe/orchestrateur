#!/usr/bin/env node
// ============================================================================
// scripts/_test_lane_pipeline.mjs — the pipeline engine runs in a lane (P9, 0.115.0)
// ============================================================================
//
// User request (2026-10-18), verbatim: « Lances-led », answering the chef's
// offer to launch P9 (« faire tourner le moteur de pipeline dans un couloir »)
// after « Le parallelisme de l'orchestrateur est-il en ligne ? » — yes for
// ordinary tasks, no for pipelines: the rule « pipeline-engine » forced every
// pipeline run into lane 0, so no project in service ran two tasks at once, and
// a paused run blocked the next ones.
//
// Permanent requirement test, REAL dispatch.mjs + REAL engine, fake claude
// (FAKE_CLAUDE_PIPELINE), throw-away root (DISPATCH_ROOT_FOR_TESTS), a fake
// server for the notifications:
//   1. lane rules: a new pipeline run is no longer pinned to lane 0; only the
//      resume of a run paused in the main checkout is (rule restricted);
//   2. two dev pipeline runs of ONE project at the same time, one in a
//      worktree lane: steps run in the lane, Livrer writes a changelog.d
//      fragment (no version edit), the integration makes the release; both
//      reach the integration branch;
//   3. a run paused in a lane does not block the next task (it runs and is
//      integrated meanwhile); « continuer » resumes it IN ITS LANE and it is
//      integrated in turn;
//   4. « abandonner » (direct reply) closes a run paused in a lane: nothing
//      integrated, the lane freed, the work kept on its branch;
//   5. a Routage task waiting for a task that ran in a lane is released by the
//      lane's end marker;
//   6. maxParallel: 1 keeps the pipeline in the main checkout (0.67.0 path).
//
//   node scripts/_test_lane_pipeline.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'scripts', f)).href);
const R = await imp('lane-rules.mjs');
const L = await imp('lanes.mjs');
const RP = await imp('routage-pending.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1500)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

section('1. Règles : une exécution neuve n’est plus forcée dans la copie principale');
{
  const clean = { repo: true, top: '.', head: 'x', branch: 'master', unsupported: [], dirty: [] };
  const P = { name: 'p', path: '.' };
  const d1 = R.decide({ project: P, conductor: 'chef', pipeline: true, pipelineLanes: true, facts: clean });
  ok(d1.mode === 'pipeline' && d1.lane0 === true && !d1.rule, `exécution neuve : mode « pipeline », aucune règle (${d1.mode}, ${d1.rule || '—'})`);
  const d2 = R.decide({ project: P, conductor: 'chef', pipeline: true, pipelineLanes: true, facts: { ...clean, dirty: ['a.js'] } });
  ok(d2.mode === 'pipeline' && d2.lane0 === false, 'copie principale modifiée : un couloir seulement, jamais la copie de l’utilisateur');
  const d3 = R.decide({ project: P, conductor: 'chef', pipeline: true, pipelineResumeLane0: 'p-20261018T100000-abcd', facts: clean });
  ok(d3.mode === 'lane0' && d3.rule === 'pipeline-engine' && /copie principale/.test(R.ruleText(d3.rule, d3.evidence)), `reprise d’une exécution de la copie principale : règle pipeline-engine (« ${R.ruleText(d3.rule, d3.evidence)} »)`);
  const d4 = R.decide({ project: P, conductor: 'chef', pipeline: true, laneArg: 1, laneWhy: 'reprise', facts: clean });
  ok(d4.mode === 'lane' && d4.lane === 1 && d4.rule === 'same-task', 'reprise d’une exécution d’un couloir : ce couloir (same-task)');
  ok(!/P9|ne sait pas encore/.test(R.RULE_BY_ID['pipeline-engine'].text), 'texte de la règle : plus de « le moteur ne sait pas encore » (P9 levé)');
}

// ---------------------------------------------------------------------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lanepipe-'));
const LOGS = path.join(T, 'logs');
const P = path.join(T, 'P'), Q = path.join(T, 'Q');
for (const d of [LOGS, P, Q, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
function initRepo(dir) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
  fs.mkdirSync(path.join(dir, '.orchestrateur'), { recursive: true });
  // The requirements registry: two parallel deliveries both append to it (union merge at integration).
  fs.writeFileSync(path.join(dir, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
  g(dir, 'init', '-q', '-b', 'master'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
}
initRepo(P); initRepo(Q);
const config = {
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  // P opts in to pipeline lanes (outside the dev instance, P9 is opt-in: rule pipeline-pilot).
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P, pipelineLanes: true }, { name: 'Q', path: Q, maxParallel: 1 }],
};
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify(config));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' },
    'discussion.comprendre': { provider: 'anthropic', model: 'claude-opus-5-5' }, 'discussion.rechercher': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'discussion.repondre': { provider: 'anthropic', model: 'claude-opus-5-5' }, 'dev.rouge': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'dev.vert': { provider: 'anthropic', model: 'claude-sonnet-5-5' }, 'dev.revue': { provider: 'anthropic', model: 'claude-fable-5-1' },
    'dev.livrer': { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
  history: [], enforcement: { projects: ['P', 'Q'], pipelines: ['discussion', 'dev'] },
}, null, 2));
fs.writeFileSync(path.join(T, '.token'), 'a'.repeat(64));
const CLAUDE_JSON = path.join(T, 'claude.json');
fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ projects: {} }));

const notes = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { try { notes.push(JSON.parse(b)); } catch {} res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_TURN_LOCK_POLL_MS: '100', ORCH_CLAUDE_JSON: CLAUDE_JSON };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID',
  'ORCH_TURN_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'CLAUDECODE', 'FAKE_PIPE_BAD']) delete baseEnv[k];
const run = (args, env = {}) => new Promise((resolve) => {
  const t0 = Date.now();
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 300_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out, t0, t1: Date.now() }); });
});
const DEV = ['--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple', '--source', 'chef'];
const events = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return { unreadable: l }; } }); } catch { return []; } };
const mainLog = (n = 'P') => events(path.join(LOGS, `${n}.jsonl`));
const laneLog = (k, n = 'P') => events(path.join(LOGS, 'lanes', n, `${k}.jsonl`));
const runIdIn = (out) => (/\b(p-\d{8}T\d{6}-[a-z0-9]{4,8})\b/.exec(out) || [])[1];
const runState = (r) => { try { return JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', r, 'run.json'), 'utf8')); } catch { return null; } };
const norm = (p) => path.resolve(String(p || '')).toLowerCase();
const laneDir1 = path.join(T, 'lanes', 'P', '1');
const stepCwds = (r) => fs.readdirSync(path.join(LOGS, 'runs', r)).filter(f => /^\d+-[a-z-]+\.jsonl$/.test(f))
  .map(f => events(path.join(LOGS, 'runs', r, f)).find(e => e.type === 'system' && e.subtype === 'init')?.cwd).filter(Boolean).map(norm);
const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
const clean = (dir) => !g(dir, 'status', '--porcelain', '--untracked-files=no').stdout.trim();
// The fake's light dev run adds double(): put the fixture back so the next run's test is red again.
const resetFixture = () => {
  fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.rmSync(path.join(P, 'test', 'pipe.test.mjs'), { force: true });
  g(P, 'add', '-A'); g(P, 'commit', '-q', '-m', 'test: reset fixture');
};

section('2. Deux exécutions de pipeline en même temps sur un projet, dont une dans un couloir (worktree)');
let runA, runB;
{
  const a = run(['P', 'Tâche A : ajoute double()', ...DEV], { FAKE_CLAUDE_LATENCY_MS: '350' });
  await new Promise(r => setTimeout(r, 2500));
  const b = await run(['P', 'Tâche B : ajoute double() aussi', ...DEV]);
  const ra = await a;
  runA = runIdIn(ra.out); runB = runIdIn(b.out);
  const sa = runState(runA), sb = runState(runB);
  ok(ra.code === 0 && b.code === 0 && sa?.status === 'done' && sb?.status === 'done', `les deux exécutions finissent (codes ${ra.code}/${b.code}, ${sa?.status}/${sb?.status})`, `${ra.out.slice(-1500)}\n---\n${b.out.slice(-1500)}`);
  ok(sa?.lane?.k === 1 && /^lane\/1\//.test(sa.lane.branch || '') && !sb?.lane, `A dans le couloir 1 (branche ${sa?.lane?.branch}), B dans la copie principale`, JSON.stringify(sa?.lane));
  ok(Math.min(ra.t1, b.t1) > Math.max(ra.t0, b.t0) && !/attente de sa fin|en série|aucun couloir libre/.test(b.out), 'les deux exécutions se recouvrent : B n’a pas attendu A', b.out.slice(-800));
  const ca = runA ? stepCwds(runA) : [], cb = runB ? stepCwds(runB) : [];
  ok(ca.length >= 3 && ca.every(c => c === norm(laneDir1)), `chaque étape de A tourne dans le worktree du couloir 1 (${ca.length} étape(s))`, ca.join(' | '));
  ok(cb.length >= 3 && cb.every(c => c === norm(P)), `chaque étape de B tourne dans la copie principale (${cb.length} étape(s))`, cb.join(' | '));
  ok(fs.existsSync(path.join(laneDir1, '.orchestrateur', 'runs', runA || 'x', 'demande.md')), 'artefacts de A dans le couloir (.orchestrateur/runs/<exécution>)');
  const upA = laneLog(1).find(e => e.type === 'user_prompt' && e.pipeline?.run === runA);
  ok(upA?.pipeline?.lane === 1 && !mainLog().some(e => e.type === 'user_prompt' && e.pipeline?.run === runA), 'le tour de A est écrit dans le journal du couloir, pas dans celui de la copie principale');
  // Livrer in the lane: fragment, no version / CHANGELOG edit.
  const fragCommit = g(P, 'log', '--all', '--format=%H', '--grep=feat: double (fragment)').stdout.trim().split('\n')[0];
  const names = fragCommit ? g(P, 'show', '--name-only', '--format=', fragCommit).stdout.split('\n').filter(Boolean) : [];
  ok(names.some(n => /^changelog\.d\/.+\.md$/.test(n)) && !names.includes('package.json') && !names.includes('CHANGELOG.md'), `Livrer dans le couloir : un fragment changelog.d, ni version ni CHANGELOG (${names.join(', ')})`);
  const subjects = g(P, 'log', '--format=%s', 'master').stdout;
  const cl = fs.readFileSync(path.join(P, 'CHANGELOG.md'), 'utf8');
  ok(/chore\(release\): v1\.1\.0/.test(subjects) && version(P) === '1.1.0' && /## \[1\.1\.0\]/.test(cl) && /## \[1\.0\.1\]/.test(cl), `intégration : B livré en 1.0.1, puis la release de A (1.1.0) faite par l’intégrateur (version ${version(P)})`, subjects);
  ok(!fs.existsSync(path.join(P, 'changelog.d')) || !fs.readdirSync(path.join(P, 'changelog.d')).length, 'aucun fragment laissé sur la branche d’intégration');
  const reqs = fs.readFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), 'utf8');
  ok(reqs.includes(`« double » ${sa?.lane?.task}`) && reqs.includes('| 1.0.1 |') && !/^(<<<<<<<|>>>>>>>|=======)/m.test(reqs), 'registre des exigences : les lignes des deux livraisons gardées (fusion par union), sans marqueur de conflit', reqs);
  ok(!L.readTask(L.laneFiles(LOGS, 'P', 1).task) && clean(P), 'couloir 1 libéré, copie principale propre');
  const end = mainLog().find(e => e.subtype === 'lane_task' && e.lane === 1 && e.state === 'done' && e.run === runA);
  ok(end?.outcome === 'integrated' && end.version === '1.1.0' && end.promptHash, `marqueur de fin dans le journal du musicien (intégrée, v${end?.version})`, JSON.stringify(end));
}

section('3. Une exécution en pause dans un couloir ne bloque pas la tâche suivante ; « continuer » la reprend dans son couloir');
{
  resetFixture();
  const offC = fs.statSync(path.join(LOGS, 'P.jsonl')).size;
  const c = await run(['P', 'Tâche C : en pause', ...DEV], { FAKE_PIPE_BAD: 'vert', ORCH_PIPE_GREEN_ATTEMPTS: '1', ORCH_PIPE_CRITERIA_ATTEMPTS: '1' });
  const runC = runIdIn(c.out), sc = runState(runC);
  const tc = L.readTask(L.laneFiles(LOGS, 'P', 1).task);
  ok(c.code === 2 && sc?.status === 'paused' && sc.lane?.k === 1, `C en pause dans le couloir 1 (code ${c.code}, ${sc?.status}, couloir ${sc?.lane?.k})`, c.out.slice(-1500));
  ok(tc?.state === 'input' && tc.task === sc?.lane?.task && clean(P), 'le couloir 1 garde la tâche pour la réponse ; la copie principale reste propre');
  ok(mainLog().some(e => e.subtype === 'lane_task' && e.lane === 1 && e.state === 'input' && e.run === runC), 'marqueur « en attente d’une réponse » dans le journal du musicien');
  const depC = { projet: 'P', offset: offC, hash: RP.textHash('Tâche C : en pause') };
  ok(!RP.dependencyResult(LOGS, depC), 'une tâche du Routage qui attend C n’est pas libérée par sa pause');
  const v0 = version(P);
  const d = await run(['P', 'Tâche D : pendant la pause de C', ...DEV]);
  const runD = runIdIn(d.out), sd = runState(runD);
  ok(d.code === 0 && sd?.status === 'done' && !/aucun couloir libre|attente de sa fin|en série/.test(d.out), `D passe pendant la pause de C, sans attendre (code ${d.code}, ${sd?.status})`, d.out.slice(-1500));
  ok(version(P) !== v0 && runState(runC)?.status === 'paused', `D livré (version ${v0} → ${version(P)}), C toujours en pause`);
  const r = await run(['P', '[CHEF_ANSWER] continuer', '--source', 'chef']);
  const s2 = runState(runC);
  const resumedUp = laneLog(1).filter(e => e.type === 'user_prompt' && e.pipeline?.run === runC);
  ok(r.code === 0 && s2?.status === 'done', `« continuer » : C reprise et terminée (code ${r.code}, ${s2?.status})`, r.out.slice(-1500));
  ok(resumedUp.length === 2 && resumedUp[1].pipeline.resumed === true && s2?.lane?.k === 1, 'reprise dans SON couloir (journal du couloir 1 : départ puis reprise)');
  const cl = fs.readFileSync(path.join(P, 'CHANGELOG.md'), 'utf8');
  const endC = mainLog().filter(e => e.subtype === 'lane_task' && e.run === runC).at(-1);
  ok(endC?.outcome === 'integrated' && /chore\(release\)/.test(g(P, 'log', '-1', '--format=%s', 'master').stdout) && cl.includes(`(${sc.lane.task})`) && !L.readTask(L.laneFiles(LOGS, 'P', 1).task),
    `C intégrée à son tour (version ${version(P)}), couloir libéré`, `${JSON.stringify(endC)}\n${r.out.slice(-1500)}`);
  const dep = RP.dependencyResult(LOGS, depC);
  ok(dep && !dep.is_error && dep.fromLane, 'après « continuer » et l’intégration, la tâche qui attend C est libérée (empreinte de la demande d’origine)', JSON.stringify(endC));
}

section('4. « abandonner » (réponse directe) clôt l’exécution en pause dans son couloir : rien d’intégré, couloir libéré, travail gardé');
{
  resetFixture();
  const e = await run(['P', 'Tâche E : sera abandonnée', ...DEV], { FAKE_PIPE_BAD: 'vert', ORCH_PIPE_GREEN_ATTEMPTS: '1', ORCH_PIPE_CRITERIA_ATTEMPTS: '1' });
  const runE = runIdIn(e.out), se = runState(runE);
  const tip = g(P, 'rev-parse', 'master').stdout.trim();
  ok(e.code === 2 && se?.lane?.k === 1, `E en pause dans le couloir 1 (code ${e.code})`, e.out.slice(-1200));
  const a = await run(['P', 'abandonner']);
  ok(a.code === 0 && runState(runE)?.status === 'abandoned', `réponse directe « abandonner » : exécution close (code ${a.code}, ${runState(runE)?.status})`, a.out.slice(-1200));
  ok(g(P, 'rev-parse', 'master').stdout.trim() === tip && clean(P), 'rien n’est intégré, copie principale intacte');
  ok(!L.readTask(L.laneFiles(LOGS, 'P', 1).task) && g(P, 'rev-parse', '-q', '--verify', `refs/heads/${se.lane.branch}`).status === 0, `couloir libéré, branche ${se?.lane?.branch} gardée`);
  ok(mainLog().some(x => x.subtype === 'lane_task' && x.state === 'abandoned' && x.run === runE), 'marqueur « abandonnée » dans le journal du musicien');
  ok(!L.readRetained(LOGS, 'P').some(x => x.branch === se.lane.branch), 'branche d’une tâche abandonnée jamais supprimée automatiquement');
}

section('5. Une tâche du Routage qui attend une tâche passée dans un couloir est libérée par le marqueur de fin');
{
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lanepipe-dep-'));
  const text = 'Tâche attendue\n\n(Rattachée à : t-abc)';
  const f = path.join(logsDir, 'X.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'system', subtype: 'lane_task', lane: 1, state: 'done', outcome: 'integrated', turnEnd: 'done', promptHash: RP.textHash('autre') }) + '\n');
  const after = { projet: 'X', offset: fs.statSync(f).size, hash: RP.textHash('Tâche attendue') };
  ok(!RP.dependencyResult(logsDir, after), 'rien après le lancement : pas encore libérée');
  fs.appendFileSync(f, JSON.stringify({ type: 'system', subtype: 'lane_task', lane: 1, state: 'input', promptHash: RP.textHash(text) }) + '\n');
  ok(!RP.dependencyResult(logsDir, after), 'couloir en attente d’une réponse : pas libérée (travail pas intégré)');
  fs.appendFileSync(f, JSON.stringify({ type: 'system', subtype: 'lane_task', lane: 1, state: 'done', outcome: 'integrated', turnEnd: 'done', promptHash: RP.textHash(text) }) + '\n');
  const dep = RP.dependencyResult(logsDir, after);
  ok(dep && !dep.is_error && dep.fromLane, 'tâche intégrée dans son couloir : libérée');
  const f2 = path.join(logsDir, 'Y.jsonl');
  fs.writeFileSync(f2, JSON.stringify({ type: 'system', subtype: 'lane_task', lane: 1, state: 'done', outcome: 'nothing', turnEnd: 'error', promptHash: RP.textHash(text) }) + '\n');
  ok(RP.dependencyResult(logsDir, { ...after, projet: 'Y', offset: 0 })?.is_error === true, 'tour en échec dans son couloir : comptée comme échouée (non relancée)');
  fs.rmSync(logsDir, { recursive: true, force: true });
}

section('6. maxParallel: 1 : l’exécution reste dans la copie principale (chemin 0.67.0)');
{
  const q = await run(['Q', 'Tâche Q', ...DEV]);
  const runQ = runIdIn(q.out), sq = runState(runQ);
  ok(q.code === 0 && sq?.status === 'done' && !sq.lane && !fs.existsSync(path.join(T, 'lanes', 'Q')) && !fs.existsSync(path.join(LOGS, 'lanes', 'Q')), `Q : exécution dans la copie principale, aucun couloir (code ${q.code})`, q.out.slice(-1000));
  ok(version(Q) === '1.0.1' && /## \[1\.0\.1\]/.test(fs.readFileSync(path.join(Q, 'CHANGELOG.md'), 'utf8')), 'Livrer y garde la règle habituelle : version et CHANGELOG');
}

srv.close();
try { for (const k of [1, 2, 3]) if (fs.existsSync(path.join(T, 'lanes', 'P', String(k)))) g(P, 'worktree', 'remove', '--force', path.join(T, 'lanes', 'P', String(k))); } catch {}
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exitCode = fail ? 1 : 0;
