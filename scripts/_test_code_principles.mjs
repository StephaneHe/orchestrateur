#!/usr/bin/env node
// ============================================================================
// scripts/_test_code_principles.mjs — the immutability principle is injected by
// the engine into every code-writing turn, and checked by the review (0.164.0)
// ============================================================================
//
// User, verbatim (2026-11-03): « Il faut suivre ceci: Always Prefer Immutability
// — écrire des fonctions pures, sans modifier les entrées (dataclasses figées,
// tuples). Si ca a du sens evidemment », enforced by code, whatever the provider.
//
// Protected:
//   1. one source of truth (data/code-principles.md): the rule block carries the
//      per-language guidance and the justified-mutable exception;
//   2. only code-writing steps get the block (vert, rouge-vert, refactor,
//      corrections, delivery by the model); judge/artefact steps do not;
//   3. dispatch.mjs appends it once, for every provider (no provider branch), to
//      code-writing steps and ordinary musician turns, never to the chef;
//   4. the review prompt carries the criterion (diff only, no retroactive rewrite);
//   5. real dispatch.mjs, test doubles: claude, codex, nvidia and openrouter all
//      receive it; a dual action run gives it to both branches and the synthesis,
//      a dual judge run to none;
//   6. every catalogue step that writes code (group "code", generated scripts) is listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOG_PIPELINES, catalogSteps } from './pipeline-catalog.mjs';
import { codePrinciplesRule, reviewCriterion, writesCode, CODE_WRITING_STEPS } from './code-principles.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');

test('the rule block names every language and the justified exception', () => {
  const rule = codePrinciplesRule();
  for (const s of ['pure functions', 'frozen=True', 'frozenset', 'readonly', 'as const', 'structuredClone', 'val', 'read-only lists', 'one-line comment'])
    assert.ok(rule.includes(s), `missing: ${s}`);
  assert.ok(!rule.includes('## review'), 'the review section must not leak into the writer prompt');
});

test('the review criterion is limited to the diff', () => {
  const c = reviewCriterion();
  assert.match(c, /mutation of an input/);
  assert.match(c, /Never report old code outside the diff/);
});

test('only code-writing steps get the block', () => {
  for (const id of ['vert', '04-vert', 'rouge-vert', 'refactor', 'corriger-vert', 'contenir', 'tests-instables', 'collecter', 'nettoyer', 'livrer', 'publication'])
    assert.ok(writesCode(id), id);
  for (const id of ['comprendre', 'concevoir', 'liste-tests', 'rouge', 'revue', 'rechercher', 'repondre', 'rapporter', ''])
    assert.ok(!writesCode(id), id);
  assert.ok(Array.isArray(CODE_WRITING_STEPS) && Object.isFrozen(CODE_WRITING_STEPS));
});

// livrer-texte only commits the meeting documents: it writes no code.
test('every catalogue step in the code group is a code-writing step', () => {
  for (const p of CATALOG_PIPELINES) for (const s of catalogSteps(p))
    if (s.group === 'code' && s.id !== 'livrer-texte') assert.ok(writesCode(s.id), `${p}.${s.id}`);
});

test('dispatch injects it once, provider-agnostic, never for the chef', () => {
  const src = read('dispatch.mjs');
  assert.equal(src.split('codePrinciplesRule()').length - 1, 1);
  const at = src.indexOf('codePrinciplesRule()');
  const ctx = src.slice(src.lastIndexOf('\n', src.lastIndexOf('if (!CHEF_TARGET && !DUAL_BRANCH && !dualSynthesis)', at)), at + 40);
  assert.match(ctx, /!CHEF_TARGET/); // the chef AND its slots (chef-2…)
  assert.match(ctx, /writesCode\(PIPE_STEP\.key\)/);
  assert.ok(!/provider/.test(ctx), 'no provider branch');
  // CHEF_TARGET must cover the chef slots (chef-2…), not only the chef itself.
  assert.match(src, /const CHEF_TARGET = projectName === CONDUCTOR \|\| new RegExp\(`\^\$\{CONDUCTOR\}-\\\\d\+\$`\)/);
});

test('the review prompt of the engine carries the criterion', () => {
  const src = read('pipeline-engine.mjs');
  assert.match(src, /L\.push\(CodePrinciples\.reviewCriterion\(\)\)/);
});

// ---------------------------------------------------------------------------
// Real dispatch.mjs on a throwaway root, with claude and codex test doubles.
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const RULE = /CODE PRINCIPLES \(user rule/;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-principles-'));
  const proj = path.join(root, 'projects', 'labo');
  const chef = path.join(root, 'projects', 'chef');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(chef, { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"labo","version":"1.0.0"}\n');
  const git = (...a) => spawnSync('git', ['-C', proj, ...a], { encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'start');
  fs.writeFileSync(path.join(root, '.env'), 'OPENROUTER_API_KEY=fixture-not-a-key-000\nNVIDIA_API_KEY=fixture-not-a-key-000\n');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    conductor: 'chef', defaults: { allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
    projects: [{ name: 'chef', path: chef }, { name: 'labo', path: proj }],
  }));
  const dump = path.join(root, 'prompts.ndjson');
  const codex = path.join(root, 'codex-fake.mjs');
  fs.writeFileSync(codex, `
import fs from 'node:fs';
let input = ''; process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(dump)}, JSON.stringify({ provider: 'codex', prompt: input }) + '\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'thread.started', thread_id: 't-cp' });
  out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Travail fait : la suite passe et le commit est prêt pour la relecture du chef.' } });
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
  process.exit(0);
});
`);
  const run = (args) => {
    const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: root, CLAUDE_BIN: FAKE, CODEX_BIN: codex, FAKE_CLAUDE_DUMP_PROMPT: dump,
      FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_MERGE: '1', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9' };
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET']) delete env[k];
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  };
  const prompts = () => { try { return fs.readFileSync(dump, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const reset = () => fs.rmSync(dump, { force: true });
  return { root, run, prompts, reset };
}

test('real dispatch: every provider receives the block, the chef never', () => {
  const sb = sandbox();
  try {
    for (const [label, args] of [
      ['claude', ['labo', 'Corrige la typo']],
      ['codex', ['labo', 'Corrige la typo', '--provider', 'codex', '--model', 'gpt-5.6-luna']],
      ['nvidia', ['labo', 'Corrige la typo', '--provider', 'nvidia', '--model', 'moonshotai/kimi-k3']],
      ['openrouter', ['labo', 'Corrige la typo', '--provider', 'openrouter', '--model', 'moonshotai/kimi-k3']],
    ]) {
      sb.reset();
      const r = sb.run(args);
      const ps = sb.prompts();
      assert.ok(ps.length > 0, `${label}: no prompt reached the model (code ${r.status}) ${(r.stderr || '').slice(-300)}`);
      assert.ok(ps.every(p => p.prompt.split('CODE PRINCIPLES (user rule').length === 2), `${label}: block missing or repeated`);
    }
    sb.reset();
    sb.run(['chef', 'Fais le point']);
    const chef = sb.prompts();
    assert.ok(chef.length > 0 && chef.every(p => !RULE.test(p.prompt)), 'the chef must not receive the block');
  } finally { fs.rmSync(sb.root, { recursive: true, force: true }); }
});

test('real dispatch: a dual action run gives it to both branches and the synthesis, a judge run to none', () => {
  const sb = sandbox();
  try {
    const dual = ['labo', 'Ajoute une note', '--model', 'claude-opus-5-5', '--second-model', 'claude-sonnet-5-5'];
    sb.run(dual);
    const action = sb.prompts();
    assert.equal(action.length, 3, 'two branches + synthesis');
    for (const p of action) assert.equal(p.prompt.split('CODE PRINCIPLES (user rule').length, 2, 'exactly once in each of the three turns');
    sb.reset();
    sb.run([...dual, '--dual-mode', 'judge']);
    const judge = sb.prompts();
    assert.equal(judge.length, 3, 'two branches + synthesis');
    assert.ok(judge.every(p => !RULE.test(p.prompt)), 'a judge run writes no code');
  } finally { fs.rmSync(sb.root, { recursive: true, force: true }); }
});
