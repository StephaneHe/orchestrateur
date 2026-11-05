#!/usr/bin/env node
// ============================================================================
// scripts/_test_question_full.mjs — a question to the user is never cut, and is
// asked so that it can be understood alone (0.165.0)
// ============================================================================
//
// User, verbatim (2026-11-05), about a question shown on a musician's card:
// « Ta question n'est pas claire et incomplete, corrige la, et fais attention pour
// les suivantes ». Rule: « les règles doivent être faites respecter par du code ».
//
// Protected:
//   1. the question is the whole text after its sentinel (1 000 characters, several
//      lines), in the shared rule, /api/pupitre's scan and the activity journal;
//   2. an excerpt is cut between two words and says it is cut; the quote opening an
//      answer through the chef says it is an extract, never passes for the question;
//   3. no reader keeps its own one-line regex or a silent slice of the question;
//   4. the rule comes from one source and carries the user's text;
//   5. real dispatch.mjs, test doubles: every provider receives it once in an ordinary
//      turn, both branches and the synthesis of a dual run, and every pipeline step;
//      the chef never does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanProject, createJournal } from './fleet-status-core.mjs';
import { questionRule } from './question-rule.mjs';

const TC = globalThis.TurnCore;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const RULE_MARK = 'QUESTIONS À L\'UTILISATEUR';

// 1 000 characters, words of varied length, a distinct end to look for.
function longQuestion(size = 1000) {
  const end = ' FIN-DE-QUESTION';
  let s = 'Le rapport de la séance peut garder les réponses brutes ou seulement leur synthèse.';
  while (s.length < size - end.length) s += ' Choix possible numéro ' + s.length;
  return s.slice(0, size - end.length).replace(/\s$/, 'x') + end;
}

function resultLog(text) {
  return [
    { type: 'user_prompt', text: 'Fais le point', timestamp: new Date().toISOString() },
    { type: 'system', subtype: 'init', session_id: 's1', timestamp: new Date().toISOString() },
    { type: 'assistant', message: { content: [{ type: 'text', text }] }, timestamp: new Date().toISOString() },
    { type: 'result', subtype: 'success', result: text, num_turns: 1, duration_ms: 10, duration_api_ms: 8, stop_reason: 'end_turn', timestamp: new Date().toISOString() },
  ];
}

test('the shared rule keeps the whole question, every line of it', () => {
  const q = longQuestion();
  assert.equal(q.length, 1000);
  assert.equal(TC.questionOf(`Contexte du tour.\n\nNEEDS_USER_INPUT: ${q}`), q);
  assert.equal(TC.questionOf('NEEDS_USER_INPUT: Quel choix ?\n\n1. Garder\n2. Retirer'), 'Quel choix ?\n\n1. Garder\n2. Retirer');
  assert.equal(TC.questionOf('Aucune question ici.'), null);
  assert.equal(TC.questionOf('NEEDS_USER_INPUT:'), '');
  assert.equal(TC.questionOf(''), null);
});

test('/api/pupitre\'s scan and the journal give the whole question', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-full-'));
  try {
    const q = longQuestion();
    const evs = resultLog(`Bilan.\nNEEDS_USER_INPUT: ${q}`);
    fs.writeFileSync(path.join(dir, 'psy.jsonl'), evs.map(e => JSON.stringify(e)).join('\n') + '\n');
    const row = scanProject('psy', dir);
    assert.equal(row.state, 'input');
    assert.equal(row.needsInput, q);
    const j = createJournal({ max: 10 });
    for (const e of evs) j.push(e);
    assert.equal(j.list()[0].outcome, 'question');
    assert.equal(j.list()[0].question, q);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an excerpt is cut between two words and says it is cut', () => {
  const short = TC.questionExcerpt('Quelle version ?', 160);
  assert.deepEqual(short, { text: 'Quelle version ?', cut: false, total: 16 });
  const x = TC.questionExcerpt('alpha beta gamma delta', 13);
  assert.deepEqual(x, { text: 'alpha beta', cut: true, total: 22 });
  assert.equal(TC.questionExcerpt('alpha beta gamma', 10).text, 'alpha beta', 'a cut exactly at a word end keeps the word');
  assert.equal(TC.questionExcerpt('x'.repeat(50), 10).text.length, 10, 'one long word is still cut, and flagged');
  assert.ok(TC.questionExcerpt('x'.repeat(50), 10).cut);
  assert.equal(TC.questionExcerpt('a\n\n  b', 10).text, 'a b', 'one line');
});

test('the quote in an answer through the chef never passes for the question', () => {
  assert.equal(TC.answerPrefix('psyAI', 'Quelle version ?'), 'Réponse pour psyAI à sa question « Quelle version ? » : ');
  const q = longQuestion();
  const p = TC.answerPrefix('psyAI', q);
  assert.match(p, /extrait/);
  assert.match(p, /sur 1000/);
  assert.match(p, /question complète dans le journal de psyAI/);
  assert.match(p, /… » : $/);
  assert.ok(!p.includes('FIN-DE-QUESTION'));
});

test('no reader keeps a one-line extraction or a silent cut of the question', () => {
  for (const f of ['server.js', 'public/app.js', 'public/salle.js', 'public/turn-core.js', 'public/activite.js', 'scripts/fleet-status-core.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/NEEDS_USER_INPUT:\\s\*\(\.\*\)/.test(src), `${f}: one-line regex`);
    assert.ok(!/needs\[1\]/.test(src), `${f}: reads a regex group instead of questionOf`);
    assert.ok(!/needsInput[^\n]{0,30}\.slice\(/.test(src), `${f}: silent cut of needsInput`);
  }
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(!/ctx\.question\.slice/.test(app) && !/\bq\.slice\(0, 160\)/.test(app), 'composer: silent cut of the question');
});

test('the rule has one source and carries the user\'s text', () => {
  const rule = questionRule();
  for (const s of [
    'Une question à l\'utilisateur (NEEDS_USER_INPUT) doit se comprendre seule',
    'le contexte en une phrase',
    'en langage simple sans noms de tests, fichiers ni fonctions sauf nécessité',
    'ce qui change selon la réponse, les choix possibles et ta recommandation',
    'Une question technique ou d\'organisation du travail va au chef (NEEDS_CHEF_INPUT), pas à l\'utilisateur',
    'Un détail sans effet sur le produit (commentaire, formulation interne) ne fait l\'objet d\'aucune question : décide et signale-le',
  ]) assert.ok(rule.includes(s), `missing: ${s}`);
  const dispatch = fs.readFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), 'utf8');
  assert.ok(!dispatch.includes('doit se comprendre seule'), 'no copy of the text in a prompt builder');
});

// ---------------------------------------------------------------------------
// Real dispatch.mjs on a throwaway root, with claude and codex test doubles.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'question-rule-'));
  const proj = path.join(root, 'projects', 'labo');
  const chef = path.join(root, 'projects', 'chef');
  fs.mkdirSync(path.join(proj, '.orchestrateur'), { recursive: true });
  fs.mkdirSync(chef, { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"labo","version":"1.0.0","type":"module","scripts":{"test":"node --test"}}\n');
  fs.writeFileSync(path.join(proj, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', proj, ...a], { encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'start');
  fs.writeFileSync(path.join(root, '.env'), 'OPENROUTER_API_KEY=fixture-not-a-key-000\nNVIDIA_API_KEY=fixture-not-a-key-000\n');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    conductor: 'chef', defaults: { allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
    projects: [{ name: 'chef', path: chef }, { name: 'labo', path: proj }],
  }));
  fs.writeFileSync(path.join(root, 'model-routing.json'), JSON.stringify({
    version: 2, history: [], enforcement: { projects: [], pipelines: ['discussion'] },
    assignments: {
      'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' },
      'discussion.comprendre': { provider: 'anthropic', model: 'claude-opus-5-5' },
      'discussion.rechercher': { provider: 'openai', model: 'gpt-5.6-luna' },
      'discussion.repondre': { provider: 'anthropic', model: 'claude-opus-5-5' },
    },
  }));
  const dump = path.join(root, 'prompts.ndjson');
  const codex = path.join(root, 'codex-fake.mjs');
  fs.writeFileSync(codex, `
import fs from 'node:fs';
let input = ''; process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(dump)}, JSON.stringify({ provider: 'codex', prompt: input }) + '\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'thread.started', thread_id: 't-qr' });
  out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Travail fait : la suite passe et le commit est prêt pour la relecture du chef.' } });
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
  process.exit(0);
});
`);
  const run = (args, extra = {}) => {
    const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: root, CLAUDE_BIN: FAKE, CODEX_BIN: codex, FAKE_CLAUDE_DUMP_PROMPT: dump,
      FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_MERGE: '1', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ...extra };
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET']) delete env[k];
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  };
  const prompts = () => { try { return fs.readFileSync(dump, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const reset = () => fs.rmSync(dump, { force: true });
  return { root, run, prompts, reset };
}
const onceIn = (p) => p.prompt.split(RULE_MARK).length === 2;

test('real dispatch: every provider receives the rule once, the chef never', () => {
  const sb = sandbox();
  try {
    for (const [label, args] of [
      ['claude', ['labo', 'Fais le point']],
      ['codex', ['labo', 'Fais le point', '--provider', 'codex', '--model', 'gpt-5.6-luna']],
      ['nvidia', ['labo', 'Fais le point', '--provider', 'nvidia', '--model', 'moonshotai/kimi-k3']],
      ['openrouter', ['labo', 'Fais le point', '--provider', 'openrouter', '--model', 'moonshotai/kimi-k3']],
    ]) {
      sb.reset();
      const r = sb.run(args);
      const ps = sb.prompts();
      assert.ok(ps.length > 0, `${label}: no prompt reached the model (code ${r.status}) ${(r.stderr || '').slice(-300)}`);
      assert.ok(ps.every(onceIn), `${label}: rule missing or repeated`);
    }
    sb.reset();
    sb.run(['chef', 'Fais le point']);
    const chef = sb.prompts();
    assert.ok(chef.length > 0 && chef.every(p => !p.prompt.includes(RULE_MARK)), 'the chef routes questions: no rule');
  } finally { fs.rmSync(sb.root, { recursive: true, force: true }); }
});

test('real dispatch: both branches and the synthesis of a dual run receive it', () => {
  const sb = sandbox();
  try {
    sb.run(['labo', 'Ajoute une note', '--model', 'claude-opus-5-5', '--second-model', 'claude-sonnet-5-5']);
    const ps = sb.prompts();
    assert.equal(ps.length, 3, 'two branches + synthesis');
    assert.ok(ps.every(onceIn), 'exactly once in each of the three turns');
  } finally { fs.rmSync(sb.root, { recursive: true, force: true }); }
});

test('real dispatch: every pipeline step receives it, on claude and on codex', () => {
  const sb = sandbox();
  try {
    const r = sb.run(['labo', 'Explique le rapport', '--pipeline', 'discussion'],{ FAKE_CLAUDE_PIPELINE: '1' });
    const ps = sb.prompts();
    assert.ok(ps.length >= 2, `pipeline steps: ${ps.length} prompts (code ${r.status}) ${(r.stdout || '').slice(-400)} ${(r.stderr || '').slice(-400)}`);
    assert.ok(ps.every(onceIn), `a step misses the rule or repeats it: ${ps.map(onceIn).join()}`);
    assert.ok(ps.some(p => p.provider === 'codex'), 'the step assigned to OpenAI runs on the codex double');
  } finally { fs.rmSync(sb.root, { recursive: true, force: true }); }
});
