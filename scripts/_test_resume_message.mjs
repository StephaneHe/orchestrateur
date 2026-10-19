#!/usr/bin/env node
// ============================================================================
// scripts/_test_resume_message.mjs — the message joined to a resume reaches
// the resumed step (0.114.2)
// ============================================================================
//
// User request (2026-10-19), verbatim: « Corriger la cause ». A run paused at
// Livrer was resumed with « continuer » AND the user's authorization (« oui,
// adapte les trois tests »); the authorization never reached the step's prompt,
// so both new attempts asked for it again and the run paused once more.
//
// Protected:
//   - resumeMessage: a bare decision (« continuer », « [CHEF_ANSWER] oui »…)
//     carries no message; anything else is kept verbatim;
//   - resumeMessagesBlock: every message quoted verbatim, the latest last;
//   - real dispatch.mjs --pipeline-resume <run> "<message>": the message is in
//     the prompt of the resumed step AND of each of its new attempts, kept in
//     run.json and traced (system/pipeline_resume_message);
//   - « continuer » (bare): nothing is added; a later bare resume still hands
//     the earlier message on.
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_resume_message.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resumeMessage, resumeMessagesBlock } from './pipeline-engine.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const AUTH = 'oui, adapte les trois tests';

// ---------------------------------------------------------------------------
section('1. resumeMessage / resumeMessagesBlock');
{
  for (const bare of ['continuer', 'Continuer.', '[CHEF_ANSWER] continuer', 'oui', 'accepter', 'tout supprimer', '  ']) ok(resumeMessage(bare) === null, `« ${bare} » : simple décision, aucun message`);
  ok(resumeMessage(`continuer — ${AUTH}`) === `continuer — ${AUTH}`, 'décision + message : gardé tel quel');
  ok(resumeMessage(`[CHEF_ANSWER] ${AUTH}`) === AUTH, 'préfixe [CHEF_ANSWER] retiré, le reste verbatim');
  const b = resumeMessagesBlock([{ at: '2026-10-19T14:27:00Z', step: 'livrer', text: 'premier' }, { at: '2026-10-19T15:00:00Z', step: 'livrer', text: AUTH }]);
  ok(b.includes('premier') && b.includes(AUTH) && b.indexOf('premier') < b.indexOf(AUTH) && /ne la redemande pas/.test(b), 'bloc : chaque message verbatim, dans l’ordre, autorisation à appliquer', b);
  ok(resumeMessagesBlock([]) === '' && resumeMessagesBlock(undefined) === '', 'aucun message : aucun bloc');
}

// ---------------------------------------------------------------------------
// Throwaway root + notification listener (chef)
// ---------------------------------------------------------------------------
const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-resume-msg-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
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

const DUMP = path.join(T, 'prompts.ndjson');
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', FAKE_CLAUDE_DUMP_PROMPT: DUMP };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL)$|^DISPATCH_SLOT$|^FAKE_PIPE_|^ORCH_PIPE_(ITEMS|REVIEW_ROUNDS|GREEN_ATTEMPTS|CRITERIA_ATTEMPTS)$/.test(k)) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const prompts = () => { try { return fs.readFileSync(DUMP, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).prompt || ''); } catch { return []; } };
const go = async (args, env) => {
  const n0 = logOf().length;
  const r = await dispatch(args, env);
  const evs = logOf().slice(n0);
  return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run };
};
// Livrer refused every attempt (no commit), one attempt per pass: the run pauses at Livrer.
const LIVRER_KO = { FAKE_PIPE_BAD: 'livrer:99', ORCH_PIPE_CRITERIA_ATTEMPTS: '2' };
const livrerPrompts = (ps) => ps.filter(p => /PIPELINE_STEP=livrer/.test(p));

// ---------------------------------------------------------------------------
section('2. Exécution en pause à Livrer, reprise avec « continuer » + message');
let r = await go(['Ajoute le tri des vidéos', '--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple'], LIVRER_KO);
const run = r.run;
const s0 = runState(run);
ok(r.code === 2 && s0.status === 'paused' && s0.plan[s0.index] === 'livrer', `en pause à l’étape Livrer (code ${r.code}, ${s0.status}, ${s0.plan[s0.index]})`, r.out.slice(-900));
ok(!prompts().some(p => p.includes(AUTH)), 'avant la reprise : le message n’existe nulle part');

fs.rmSync(DUMP, { force: true });
const message = `Reprise de l'exécution en pause ${run} avec la réponse « continuer ». Réponse de l'utilisateur (verbatim) : « ${AUTH} ».`;
r = await go(['--pipeline-resume', run, `[CHEF_ANSWER] ${message}`], LIVRER_KO);
const lp = livrerPrompts(prompts());
ok(lp.length === 2, `l’étape Livrer est relancée, deux nouveaux essais (${lp.length})`, r.out.slice(-900));
ok(lp.length > 0 && lp.every(p => p.includes(message)), 'le message figure TEL QUEL dans le prompt de chaque essai de l’étape reprise', lp[0]?.slice(0, 1500));
ok(lp.every(p => /MESSAGE\(S\) JOINT\(S\) À LA REPRISE/.test(p) && /ne la redemande pas/.test(p)), 'présenté comme la réponse de l’utilisateur à appliquer');
const s1 = runState(run);
ok(s1.resumeMessages?.length === 1 && s1.resumeMessages[0].text === message && s1.resumeMessages[0].step === 'livrer', 'gardé dans run.json (texte, étape de reprise)', JSON.stringify(s1.resumeMessages));
ok(r.evs.some(e => e.subtype === 'pipeline_resume_message' && e.pipeline?.run === run), 'tracé dans le log du musicien (system/pipeline_resume_message)');

// ---------------------------------------------------------------------------
section('3. « continuer » seul : rien n’est ajouté, le message précédent reste transmis');
fs.rmSync(DUMP, { force: true });
r = await go(['--pipeline-resume', run, 'continuer'], LIVRER_KO);
const lp3 = livrerPrompts(prompts());
const s3 = runState(run);
ok(s3.resumeMessages?.length === 1, `aucun nouveau message enregistré (${s3.resumeMessages?.length})`);
ok(lp3.length > 0 && lp3.every(p => p.includes(message)), 'l’autorisation déjà donnée reste dans les consignes des essais suivants', r.out.slice(-600));

// ---------------------------------------------------------------------------
section('4. Réponse « continuer + message » sans --pipeline-resume (musicien en pause)');
fs.rmSync(DUMP, { force: true });
r = await go([`continuer — ${AUTH}`], LIVRER_KO);
const lp4 = livrerPrompts(prompts());
ok(r.run === run && lp4.length > 0 && lp4.every(p => p.includes(`continuer — ${AUTH}`)), `la reprise par « continuer … » transmet aussi le message (${lp4.length} essai(s))`, r.out.slice(-600));

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
