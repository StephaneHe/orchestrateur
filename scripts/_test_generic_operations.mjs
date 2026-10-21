#!/usr/bin/env node
// ============================================================================
// scripts/_test_generic_operations.mjs — the « Opérations » generic pipeline
// (pipelines phase 1, docs/PIPELINES-SYNTHESE.md §3.3, decisions 4 and 5)
// ============================================================================
//
// User decisions (2026-10-20, « tout comme recommandé »): « Opérations » for
// push, tag, publication, installation, restart; « votre demande écrite suffit
// si elle cite l'action, sinon une pause ; un bond de prod n'est jamais
// appliqué par un musicien ». Real case: « Pousser (git push) … les 29 commits »
// went to Maintenance — 4 steps, nothing pushed (anonymised in
// tests/pipeline-corpus/).
//
// Protected, with the real dispatch.mjs and engine, a fake claude and a local
// bare remote (never the network, never 7777):
//   - push quoted by the user → no pause, pushed, VERIFIED by ls-remote, the
//     report says who authorized it; one classifier-named operation = no
//     « Préparer » model turn;
//   - push not quoted → pause « autoriser » before anything runs; « continuer »
//     does not authorize; « autoriser » runs it; the automatic answer never
//     handles this pause (USER_ONLY_PAUSES);
//   - a false postcondition → pause « relancer l’opération », the operations
//     already verified are not run again;
//   - a precondition that fails (non fast-forward) → pause, nothing run;
//   - nothing runnable in the closed list → no run of anything, a question;
//   - prod_jump: plan only (--apply never), a reversible operation.
//
//   node scripts/_test_generic_operations.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { classifyWaits, USER_ONLY_PAUSES } from './auto-answer.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-genops-'));
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'chef'));
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const REMOTE = path.join(T, 'remote.git');
const P = path.join(T, 'P');
function repo() {
  fs.rmSync(P, { recursive: true, force: true });
  fs.rmSync(REMOTE, { recursive: true, force: true });
  g(T, 'init', '-q', '--bare', '-b', 'main', REMOTE);
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(P, rel)), { recursive: true }); fs.writeFileSync(path.join(P, rel), s); };
  w('package.json', JSON.stringify({ name: 'P', version: '1.0.0', type: 'module' }, null, 2) + '\n');
  w('test/base.test.mjs', "import { test } from 'node:test';\ntest('base', () => {});\n");
  w('.orchestrateur/pipeline.json', JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'] }));
  g(P, 'init', '-q', '-b', 'main'); g(P, 'add', '-A'); g(P, 'commit', '-q', '-m', 'init');
  g(P, 'remote', 'add', 'origin', REMOTE); g(P, 'push', '-q', 'origin', 'main');
  for (const i of [1, 2, 3]) { w(`src/f${i}.mjs`, `export const v = ${i};\n`); g(P, 'add', '-A'); g(P, 'commit', '-q', '-m', `c${i}`); }
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
const routing = (tuning = { generic: true }) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['P'], pipelines: E.ENGINE_PIPELINES, tuning },
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'operations.preparer': { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
}, null, 2));
routing();
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME',
  'FAKE_PIPE_JSON', 'FAKE_PIPE_BAD', 'FAKE_PIPE_NOTHING', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CHOICE', 'FAKE_CLAUDE_DUMP_PROMPT', 'ORCH_REQUEST_ID']) delete baseEnv[k];
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
function play(args, env = {}) {
  const n0 = logOf().length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline?.run)?.pipeline.run;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, run, st: run ? runState(run) : null, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const remoteHead = () => g(REMOTE, 'rev-parse', 'refs/heads/main').stdout.trim();
const localHead = () => g(P, 'rev-parse', 'HEAD').stdout.trim();
const art = (st, f) => { try { return fs.readFileSync(path.join(P, '.orchestrateur', 'runs', st.run, f), 'utf8'); } catch { return ''; } };
const PUSH_REQ = 'Pousse les 3 commits locaux de P vers le dépôt distant. L’utilisateur a répondu « pousses, puis ajoutes les videos ».';

section('1. Push cité par l’utilisateur : poussé, vérifié, sans pause ni tour de Préparer');
repo();
let x = play([PUSH_REQ, '--test', 'push cité'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'operations', mode: 'complet', raison: 'un push', operations: [{ id: 'git_push', params: { remote: 'origin' } }], autorisation: 'pousses, puis ajoutes les videos' }) });
ok(x.code === 0 && x.st?.status === 'done' && x.st.pipeline === 'operations', `exécution « operations » terminée (code ${x.code})`, x.out.slice(-1500));
ok(remoteHead() === localHead(), 'le dépôt distant a les commits locaux');
ok(x.st?.steps.find(s => s.id === 'preparer')?.source === 'code' && !x.st.steps.some(s => s.id === 'preparer' && s.model), '« Préparer » fait par le programme : une seule opération nommée par le classement, aucun tour de model');
ok(x.evs.some(e => e.subtype === 'pipeline_operation' && e.operation?.ok && /ls-remote/.test(e.operation.observed)), 'l’effet est relu par git ls-remote (jamais un simple code de retour)');
ok(/✓/.test(art(x.st, 'rapport.md')) && /pousses, puis ajoutes les videos/.test(art(x.st, 'autorisation.json')) && /git_push/.test(x.result), 'rapport du programme : opération vérifiée, autorisée par les mots de l’utilisateur', x.result.slice(0, 600));
ok(!x.evs.some(e => e.type === 'system' && e.subtype === 'pipeline_step_start' && e.pipeline?.step === 'preparer'), 'aucun tour de model lancé pour Préparer');

section('2. Push non cité : pause « autoriser » avant toute exécution');
repo();
const before = remoteHead();
x = play(['Envoie les derniers commits de P sur le serveur git.', '--test', 'push non cité'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'operations', mode: 'complet', raison: 'un push', operation: 'git_push' }) });
ok(x.code === 2 && x.st?.status === 'paused' && x.st.pausedLimit === 'autoriser', `pause « autoriser » (code ${x.code}, ${x.st?.pausedLimit})`, x.out.slice(-1200));
ok(remoteHead() === before, 'rien n’a été poussé');
ok(/NEEDS_USER_INPUT/.test(x.result) && /« autoriser »/.test(x.result) && /irréversible/.test(x.result), 'la question nomme l’opération et propose « autoriser »', x.result.slice(0, 800));
ok(x.st.diagnosis?.kind === 'authorization' && x.st.diagnosis.options.map(o => o.key).join() === 'autoriser,abandonner', `menu : ${x.st.diagnosis?.options?.map(o => o.key).join(', ')}`);
const run2 = x.run;
const waits = [{ key: 'k', kind: 'pause', project: 'P', since: Date.now(), context: { pausedLimit: 'autoriser', run: run2 } }];
const cw = classifyWaits({ waits, settings: { activatedAt: new Date(0).toISOString() }, idle: { presentSince: 0 } });
ok(USER_ONLY_PAUSES.includes('autoriser') && cw.backlog.length === 1 && cw.backlog[0].backlog === 'autorisation-utilisateur', 'la réponse automatique ne traite jamais cette pause (arriéré « autorisation-utilisateur »)');
x = play(['continuer', '--pipeline-resume', run2, '--test', 'continuer n’autorise pas']);
ok(x.st?.status === 'paused' && x.st.pausedLimit === 'autoriser' && remoteHead() === before, '« continuer » n’autorise rien : toujours en pause, rien poussé');
x = play(['autoriser', '--pipeline-resume', run2, '--test', 'autoriser']);
ok(x.st?.status === 'done' && remoteHead() === localHead(), `« autoriser » : poussé et vérifié (${x.st?.status})`, x.out.slice(-1200));
ok(x.evs.some(e => e.subtype === 'pipeline_operations_authorized' && /autoriser/.test(e.text)) && /réponse « autoriser »/.test(art(x.st, 'autorisation.json')), 'l’autorisation est tracée : réponse « autoriser » de l’utilisateur');

section('3. Postcondition fausse : pause, puis reprise sans relancer ce qui est vérifié');
repo();
// Two operations: a tag (reversible, verified) then a push whose remote rejects it (hook).
fs.writeFileSync(path.join(REMOTE, 'hooks', 'pre-receive'), '#!/bin/sh\necho "refusé par le crochet" >&2\nexit 1\n');
try { fs.chmodSync(path.join(REMOTE, 'hooks', 'pre-receive'), 0o755); } catch {}
x = play(['Pose le tag v1.1.0 puis pousse main. Autorisation de l’utilisateur : « tague et pousse main ».', '--test', 'postcondition'], {
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'operations', mode: 'complet', raison: 'tag et push' }),
  FAKE_PIPE_JSON: JSON.stringify({ preparer: { operations: [{ id: 'git_tag', params: { tag: 'v1.1.0' } }, { id: 'git_push', params: { remote: 'origin', branch: 'main' }, autorisation: 'tague et pousse main' }] } }) });
const rejected = x.st?.status === 'paused';
ok(rejected && x.st.pausedLimit === 'operation' && x.st.diagnosis?.kind === 'operation_failed', `push refusé par le distant : pause « operation » (${x.st?.status}/${x.st?.pausedLimit})`, x.out.slice(-1500));
ok(x.st?.steps.some(s => s.id === 'preparer' && s.model === 'claude-sonnet-5-5'), 'deux opérations : « Préparer » joué par le model de sa case');
ok(g(P, 'rev-parse', 'v1.1.0^{commit}').stdout.trim() === localHead() && (x.st?.opsDone || []).join() === '0', 'le tag est posé et vérifié ; le push, non');
ok(x.st?.diagnosis?.options.map(o => o.key).join() === 'relancer l’opération,abandonner', `menu : ${x.st?.diagnosis?.options?.map(o => o.key).join(', ')}`);
fs.rmSync(path.join(REMOTE, 'hooks', 'pre-receive'));
const run3 = x.run;
x = play(['relancer l’opération', '--pipeline-resume', run3, '--test', 'relancer']);
ok(x.st?.status === 'done' && remoteHead() === localHead(), 'cause corrigée, « relancer l’opération » : poussé et vérifié', x.out.slice(-1200));
ok(x.evs.filter(e => e.subtype === 'pipeline_operation').map(e => e.operation.id).join() === 'git_push', 'le tag déjà vérifié n’est pas relancé');

section('4. Condition préalable fausse : pause, rien lancé');
repo();
const C = path.join(T, 'other');
fs.rmSync(C, { recursive: true, force: true });
g(T, 'clone', '-q', REMOTE, C);
fs.writeFileSync(path.join(C, 'x.txt'), 'x'); g(C, 'add', '-A'); g(C, 'commit', '-q', '-m', 'autre'); g(C, 'push', '-q', 'origin', 'main');
const remoteBefore = remoteHead();
x = play(['Pousse main. « pousse main » a dit l’utilisateur.', '--test', 'non fast-forward'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'operations', mode: 'complet', raison: 'push', operation: 'git_push', autorisation: 'pousse main' }) });
ok(x.st?.status === 'paused' && x.st.pausedLimit === 'operation' && /avance rapide|jamais forcé/.test(x.result) && remoteHead() === remoteBefore, 'non fast-forward : pause avant tout push, jamais forcé', x.result.slice(0, 600));

section('5. Rien d’exécutable dans la liste fermée : une question, rien lancé');
repo();
x = play(['Déploie le site sur le serveur FTP de production.', '--test', 'hors liste'], {
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'operations', mode: 'complet', raison: 'déploiement' }),
  FAKE_PIPE_JSON: JSON.stringify({ preparer: { operations: [], hors_liste: 'déployer par FTP' } }) });
ok(x.st?.status === 'done' && /NEEDS_USER_INPUT/.test(x.result) && /operations\.scripts/.test(x.result) && !x.evs.some(e => e.subtype === 'pipeline_operation'), 'aucune opération : la réponse dit quoi déclarer, et pose la question', x.result.slice(0, 700));

section('6. Plans du moteur et interrupteur');
ok(E.planSteps('operations').map(s => s.id).join() === 'preparer,autoriser,executer,rapporter', 'plan : Préparer → Autoriser → Exécuter → Rapporter');
ok(E.planSteps('operations').filter(s => s.kind === 'code').length === 3, 'trois étapes faites par le programme, sans model');
routing({});
repo();
x = play([PUSH_REQ, '--test', 'interrupteur coupé'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'leger', raison: 'question' }), FAKE_CLAUDE_DUMP_PROMPT: path.join(T, 'dump.ndjson') });
const prompts = fs.readFileSync(path.join(T, 'dump.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(p => /^\[CLASSIFY\]/.test(p.prompt));
ok(prompts.length && !/- operations:/.test(prompts.at(-1).prompt) && !/"document"/.test(prompts.at(-1).prompt), 'interrupteur « generic » coupé : le classement ne propose ni Opérations ni les modes génériques (comportement d’avant)');
routing();

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
