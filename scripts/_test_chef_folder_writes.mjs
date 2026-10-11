#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_folder_writes.mjs — a file written in the chef's folder
// during a Routage step is kept, never undone (0.71.1, ROUTAGE-PROBLEMES n° 18)
// ============================================================================
//
// User go-ahead (2026-10-11, verbatim): « 3. J'ai lu et j'accepte » (page
// correctifs-suite.html: n° 8, then 18, then 10). Problem n° 18: run
// p-20261010T210614-034d0d refused its read-only "lire" step because
// docs/ROUTAGE-PROBLEMES.md appeared in I:\Dev\Chef meanwhile, then restored
// the folder snapshot and deleted the file. Checks:
//   - a file CREATED in the chef's folder during a step is kept, the step is
//     not refused nor reported as a defect, and the change is said (event +
//     report line);
//   - a file MODIFIED there (e.g. TODO_LIST.md edited by the user) keeps its
//     new content;
//   - a git project keeps the strict read-only rule (refused, undone).
// Real dispatch.mjs and engine, claude double (FAKE_CLAUDE_WRITE stands for
// the outside writer), throw-away root, dead notify port.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chefdir-'));
for (const d of ['logs', 'chef', 'P']) fs.mkdirSync(path.join(T, d), { recursive: true });
const CHEF = path.join(T, 'chef');
fs.writeFileSync(path.join(CHEF, 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
fs.writeFileSync(path.join(CHEF, 'TODO_LIST.md'), '# TODO\n\n- avant\n');
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
{
  const P = path.join(T, 'P');
  fs.mkdirSync(path.join(P, 'test'), { recursive: true });
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'P', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }) + '\n');
  fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  g(P, 'init', '-q'); g(P, 'add', '-A'); g(P, 'commit', '-q', '-m', 'init');
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'P'].map(n => ({ name: n, path: path.join(T, n) })),
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['P'], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP', 'FAKE_CLAUDE_WRITE']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
function turn(project, text, env = {}, extra = []) {
  const n0 = logOf(project).length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), project, text, '--test', 'n18-dossier-du-chef', ...extra],
    { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const evs = logOf(project).slice(n0);
  const run = evs.find(e => e.type === 'user_prompt')?.pipeline?.run;
  const st = run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : null;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, st, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const statusOf = (st) => (st?.steps || []).map(s => `${s.id}:${s.status}`).join(' ');

// ---------------------------------------------------------------------------
section('1. Un fichier CRÉÉ dans le dossier du chef pendant une étape est conservé (cas réel du n° 18)');
const doc = path.join(CHEF, 'docs', 'ROUTAGE-PROBLEMES.md');
let x = turn('chef', 'Où en est la flotte ?', { FAKE_CLAUDE_WRITE: 'docs/ROUTAGE-PROBLEMES.md', FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'reponse', sens: 'point sur la flotte', raison: 'x' } }) });
ok(x.code === 0 && statusOf(x.st) === 'lire:ok comprendre:ok decomposer:skipped classifier:skipped affecter:skipped dispatcher:skipped rapporter:ok', `aucune étape refusée : ${statusOf(x.st)}`, x.out.slice(-800));
ok(fs.existsSync(doc), 'le fichier écrit pendant l’étape est toujours là (plus jamais effacé)');
ok(!x.evs.some(e => e.subtype === 'pipeline_defect'), 'aucun défaut signalé à tort');
ok(x.evs.some(e => e.subtype === 'pipeline_external_change' && (e.files || []).includes('docs/ROUTAGE-PROBLEMES.md')), 'le changement est signalé dans le fil du chef');
ok(/Fichiers du dossier du chef modifiés pendant cette exécution.*docs\/ROUTAGE-PROBLEMES\.md/s.test(x.result), 'et dans le rapport', x.result.slice(-500));

// ---------------------------------------------------------------------------
section('2. Un fichier MODIFIÉ (TODO_LIST.md édité par l’utilisateur) garde son nouveau contenu');
x = turn('chef', 'Rien de neuf ?', { FAKE_CLAUDE_WRITE: 'TODO_LIST.md', FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'reponse', sens: 's', raison: 'x' } }) });
const todo = fs.readFileSync(path.join(CHEF, 'TODO_LIST.md'), 'utf8');
ok(x.code === 0 && !/- avant/.test(todo) && /écrit par/.test(todo) && x.st.steps.every(s => s.status !== 'refused'), `TODO_LIST.md garde la modification, aucune étape refusée (${statusOf(x.st)})`, todo);

// ---------------------------------------------------------------------------
section('3. Un projet git garde la règle stricte : changement pendant une étape en lecture seule → refusé et annulé');
x = turn('P', 'Pourquoi la suite passe-t-elle ?', { FAKE_CLAUDE_WRITE: 'notes.txt' }, ['--pipeline', 'discussion']);
const first = x.st?.steps?.[0];
ok(first?.status === 'refused' && /lecture seule/.test(first.why || ''), `P : étape refusée (${first?.id}:${first?.status})`, JSON.stringify(first));
ok(!fs.existsSync(path.join(T, 'P', 'notes.txt')), 'P : le fichier écrit est annulé, comme avant');

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
