#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_pause_relay.mjs — every chef answer to a process pause is
// applied; the chef's answers to the user are never relayed (0.137.0)
// ============================================================================
//
// User report (2026-10-22), verbatim: « psyProfile ne semble pas avancer ».
// Run of a project with chefPauses on: pause 1 answered by the chef and applied;
// pauses 2 and 3 answered by the chef (« [ANSWER] reprendre les items — … »,
// « [ANSWER] livrer sans eux — … ») and NOT applied; the chef's answer to the
// user and its wake report were relayed to the musician as [CHEF_ANSWER] and
// started parasitic Discussion runs; « livrer sans eux p-… » sent by the chef
// started a new Discussion instead of answering the cited pause.
//
// Protected (user requirement, never weakened without the user's agreement):
//   1. relay (server.js → scripts/chef-relay.mjs): two process pauses of the
//      same run answered by the same chef session, both num_turns 1, are BOTH
//      relayed (the former session:num_turns key dropped the second), each
//      naming its pause; a chef turn opened by the user's message or by a
//      [CALLBACK_WAKE] is never relayed, even right after a relayed question;
//   2. real dispatch.mjs + engine + fake claude: the two relayed answers are
//      both applied (pipeline_chef_decision n° 1 and n° 2); an answer to a pause
//      already settled is dropped and traced, never a new run; an answer to an
//      ordinary question never settles a pause;
//   3. « livrer sans eux <run> » / « découper <run> » sent by the chef answers
//      the CITED paused run, as the chef's decision, even when a newer
//      Discussion of the same project ran after it;
//   4. an answer not applied after 2 min is reported to the chef (a question
//      naming the pause, the answer and the command), not to the user;
//   5. a Discussion does not start while another turn (a dev run) holds the
//      main copy of the same project: it waits for the lock.
//
//   node scripts/_test_chef_pause_relay.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chefAnswerRelay, turnOpener, relayTag, unappliedChefAnswers, unappliedText } from './chef-relay.mjs';
import { parseChefDecision } from './process-pause.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const NEEDS_CHEF_RE = new RegExp(/const NEEDS_CHEF_RE\s*=\s*\/(.+)\/i;/.exec(SERVER)[1], 'i');
const SID = '228c2819-2093-4db2-8a3b-f9d596f7157c';
// What server.js writes when it asks the chef (maybeDispatchChefQuestion).
const markerPrompt = (m, q) => `[NEEDS_CHEF_INPUT_FROM:${m}] Le musicien « ${m} » te demande une décision :\n\n${q}\n\nRéponds de façon décisive en une à trois phrases, préfixe par [ANSWER].`;
let clock = Date.parse('2026-10-22T20:29:00Z');
const ts = (ms = 1000) => new Date(clock += ms).toISOString();
/** One chef turn in the chef log: its opening prompt, a notification meanwhile, its result. */
const chefTurn = (log, { turn, text, source = null, answer, nt = 1, noise = true }) => {
  log.push({ type: 'user_prompt', text, orch_turn: turn, ...(source ? { source } : {}), timestamp: ts() });
  if (noise) log.push({ type: 'user_prompt', text: '[DÉFAUT — P — x] ⚑ 1 défaut', source: 'pipeline-defect', timestamp: ts() });
  const result = { type: 'result', subtype: 'success', session_id: SID, num_turns: nt, result: answer, orch_turn: turn, timestamp: ts() };
  log.push(result);
  return result;
};

// ---------------------------------------------------------------------------
section('1. Relais : chaque réponse à une pause, rien d’autre');
{
  ok(/chefAnswerRelay\(/.test(SERVER) && !/`\$\{sid\}:\$\{nt\}`/.test(SERVER), 'server.js relaie par chef-relay.mjs, plus par la clé session:num_turns');
  const log = [];
  const r1 = chefTurn(log, { turn: 't-1', text: markerPrompt('psy', '[p-20261022T192950-ae8e75 · pause 1] psy — pause de PROCESSUS…'), answer: '[ANSWER] découper — il reste 9 tests' });
  const r2 = chefTurn(log, { turn: 't-2', text: markerPrompt('psy', '[p-20261022T192950-ae8e75 · pause 2] psy — pause de PROCESSUS…'), answer: '[ANSWER] reprendre les items — première reprise' });
  ok(`${r1.session_id}:${r1.num_turns}` === `${r2.session_id}:${r2.num_turns}`, 'cause de l’incident : même session, num_turns 1 → même clé session:num_turns pour les deux réponses');
  const a = chefAnswerRelay({ lines: log, result: r1 }), b = chefAnswerRelay({ lines: log, result: r2 });
  ok(a.musician === 'psy' && b.musician === 'psy' && a.key !== b.key, `les deux réponses sont relayées, chacune avec sa clé (${a.key}, ${b.key})`, [a, b]);
  ok(a.pause?.n === 1 && b.pause?.n === 2 && b.pause.run === 'p-20261022T192950-ae8e75', 'chaque relais nomme SA pause');
  ok(relayTag(b.prompt)?.n === 2 && /^\[CHEF_ANSWER\] reprendre les items — première reprise\n/.test(b.prompt), 'le texte relayé porte la réponse et la ligne [RELAIS: pause … n° 2]', b.prompt);
  const dec = parseChefDecision(b.prompt, { options: ['reprendre les items', 'livrer sans eux'] });
  ok(dec.ok && dec.key === 'reprendre les items' && dec.reason === 'première reprise', 'la ligne du relais ne gêne pas la lecture de la décision', dec);
  const r3 = chefTurn(log, { turn: 't-3', text: 'chef ne répond pas à ma question  psyProfile ne semble pas avancer', answer: 'Tu as raison sur psyProfile : il était bloqué…', nt: 4 });
  ok(chefAnswerRelay({ lines: log, result: r3 }).skip === 'not-a-question-turn', 'la réponse du chef À L’UTILISATEUR (tour ouvert par son message) n’est pas relayée');
  const r4 = chefTurn(log, { turn: 't-4', source: 'wake', text: '[CALLBACK_WAKE lot=1 gen=1] Les résultats que tu attendais sont arrivés.', answer: 'L’exécution est close…', nt: 5 });
  ok(chefAnswerRelay({ lines: log, result: r4 }).skip === 'not-a-question-turn', 'le compte rendu d’un réveil [CALLBACK_WAKE] n’est pas relayé');
  const q = chefTurn(log, { turn: 't-5', text: markerPrompt('psy', 'confirmes-tu qu’aucune autre exécution ne traite déjà ces items ?'), answer: '[ANSWER] Oui.', nt: 9 });
  const qr = chefAnswerRelay({ lines: log, result: q });
  ok(qr.musician === 'psy' && qr.pause === null && relayTag(qr.prompt)?.kind === 'question', 'la réponse à une question ordinaire est relayée, marquée « question »', qr);
  ok(chefAnswerRelay({ lines: log, result: r2 }).key === b.key, 'un même tour donne toujours la même clé (le serveur ne le relaie qu’une fois)');
  const old = [{ type: 'user_prompt', text: markerPrompt('psy', 'x ?'), timestamp: 'a' }, { type: 'user_prompt', source: 'notify', text: 'n', timestamp: 'b' },
    { type: 'result', session_id: SID, num_turns: 1, result: '[ANSWER] oui', timestamp: 'c' },
    { type: 'user_prompt', text: 'message de l’utilisateur', timestamp: 'd' }, { type: 'result', session_id: SID, num_turns: 1, result: 'réponse', timestamp: 'e' }];
  ok(chefAnswerRelay({ lines: old, result: old[2] }).musician === 'psy' && chefAnswerRelay({ lines: old, result: old[4] }).skip === 'not-a-question-turn', 'anciennes lignes sans identifiant de tour : le dernier message non sourcé avant le résultat décide');
  ok(turnOpener(log, r3)?.orch_turn === 't-3', 'l’ouverture du tour suit l’identifiant de tour, pas les notifications ajoutées entre-temps');
  ok(chefAnswerRelay({ lines: [{ type: 'user_prompt', orch_turn: 'x', text: `${markerPrompt('a', '?')}\n${markerPrompt('b', '?')}` }, { type: 'result', orch_turn: 'x', result: 'r' }], result: { type: 'result', orch_turn: 'x', result: 'r' } }).skip === 'several-musicians', 'deux musiciens dans une même question : jamais deviné');
}

// ---------------------------------------------------------------------------
section('2. Bout en bout : vrai dispatch.mjs, deux pauses de processus de suite');
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push({ path: req.url, ...JSON.parse(b) }); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chef-relay-'));
const P = path.join(T, 'P');
{
  for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d), { recursive: true });
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('base', () => { assert.equal(1, 1); });\n");
  fs.writeFileSync(path.join(P, 'test', 'pipe.test.mjs'), "import { test } from 'node:test';\ntest('pipe', () => {});\n");
  fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
}
fs.mkdirSync(path.join(T, 'logs'), { recursive: true });
fs.mkdirSync(path.join(T, 'chef'), { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
// P IS in service (like the project of the incident): a misrouted text is classified and starts a run.
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'], tuning: { chefPauses: ['P'] } },
}));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_PAUSE_MODEL_DIAG: '0',
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'leger', confiance: 'haute', raison: 'question' }), ORCH_TURN_LOCK_POLL_MS: '200' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|REQUEST_ID|TURN_ID)$|^DISPATCH_SLOT$|^FAKE_PIPE_|^ORCH_PIPE_(ITEMS|REVIEW_ROUNDS|GREEN_ATTEMPTS|CRITERIA_ATTEMPTS)$/.test(k)) delete baseEnv[k];
const spawnDispatch = (args, env = {}) => spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawnDispatch(args, env);
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 300_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const runsOfP = () => fs.readdirSync(path.join(T, 'logs', 'runs')).filter(r => /^p-/.test(r)).sort();
const go = async (args, env) => {
  const n0 = logOf().length;
  const r = await dispatch(args, env);
  const evs = logOf().slice(n0);
  return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run };
};
const lastText = (evs) => [...evs].reverse().find(e => e.type === 'result')?.result || '';
// The incident's sequence: too many tests (« découper »), then an item set aside
// by its review, twice (« reprendre les items », then « livrer sans eux »).
const ITEMS = { FAKE_PIPE_ITEMS: '5', ORCH_PIPE_ITEMS: '3', FAKE_PIPE_REVIEW_ITEM: '2:9', ORCH_PIPE_REVIEW_ROUNDS: '1' };
const chefLog = [];
/** The chef answers the question of the musician's last result; the server relay decides. */
const chefAnswers = (evs, answer, turn) => {
  const q = NEEDS_CHEF_RE.exec(lastText(evs))?.[1]?.trim();
  const result = chefTurn(chefLog, { turn, text: markerPrompt('P', q || ''), answer });
  return { q, relay: chefAnswerRelay({ lines: chefLog, result }) };
};

let r = await go(['Ajoute cinq multiplications', '--pipeline', 'dev', '--mode', 'complet', '--kind', 'simple'], ITEMS);
const RUN = r.run;
let st = runState(RUN);
ok(r.code === 2 && st.status === 'paused' && st.chefPause?.status === 'pending' && st.chefPause.n === 1, `pause de processus n° 1 en attente du chef (${st.pausedLimit}, options : ${st.chefPause?.options?.join(', ')})`, r.out.slice(-600));
const first = chefAnswers(r.evs, '[ANSWER] découper — il reste 2 tests : des exécutions plus courtes restent vérifiables', 'c-1');
ok(first.relay.pause?.n === 1, 'réponse n° 1 relayée en nommant la pause n° 1', first.relay);
r = await go([first.relay.prompt], ITEMS);
st = runState(RUN);
ok(r.evs.some(e => e.subtype === 'pipeline_chef_decision' && e.n === 1 && /« découper »/.test(e.text)), 'réponse n° 1 appliquée (tranché par le chef : « découper »)', r.out.slice(-600));
ok(st.status === 'paused' && st.chefPause?.status === 'pending' && st.chefPause.n === 2, `l’exécution reprend puis pose la pause n° 2 au chef (${st.pausedLimit}, ${st.chefPause?.options?.join(', ')})`, st.chefPause);
const key2 = st.chefPause?.recommend?.key;
const second = chefAnswers(r.evs, `[ANSWER] ${key2} — c’est la première fois sur cette pause`, 'c-2');
ok(second.relay.musician === 'P' && second.relay.key !== first.relay.key && second.relay.pause?.n === 2, 'réponse n° 2 (même session, num_turns 1) relayée elle aussi', second.relay);
r = await go([second.relay.prompt], ITEMS);
st = runState(RUN);
ok(r.evs.some(e => e.subtype === 'pipeline_chef_decision' && e.n === 2 && e.text.includes(`« ${key2} »`)), `réponse n° 2 appliquée elle aussi (pipeline_chef_decision n° 2, « ${key2} »)`, r.out.slice(-600));
if (st.status === 'paused' && st.chefPause?.status === 'pending' && st.chefPause.n === 3 && !st.chefPause.options.includes('livrer sans eux')) {
  const third = chefAnswers(r.evs, `[ANSWER] ${st.chefPause.recommend.key} — suite`, 'c-2b');
  r = await go([third.relay.prompt], ITEMS);
  st = runState(RUN);
}
ok(st.pauseAnswers?.filter(a => a.by === 'chef').length === 2, 'deux décisions du chef mémorisées sur la même exécution', st.pauseAnswers);
ok(st.status === 'paused' && st.chefPause?.n === 3 && st.chefPause.status === 'pending' && st.chefPause.options.includes('livrer sans eux'), `pause n° 3 au chef (${st.pausedLimit}, ${st.chefPause?.options?.join(', ')})`, st.chefPause);

section('3. Réponse arrivée après coup, réponse à une question ordinaire');
{
  const runs0 = runsOfP().length;
  r = await go([second.relay.prompt], ITEMS);   // the answer to pause 2, again: pause 3 waits now
  st = runState(RUN);
  ok(r.code === 0 && runsOfP().length === runs0 && !r.evs.some(e => e.type === 'user_prompt') && st.chefPause.n === 3 && st.chefPause.status === 'pending', 'réponse à la pause n° 2 rejouée pendant la n° 3 : rien n’est lancé, la pause n° 3 attend toujours', r.out.slice(-400));
  ok(r.evs.some(e => e.subtype === 'pipeline_chef_answer_stale' && e.n === 2 && /n’est plus celle qui attend/.test(e.why)), 'et c’est tracé (pipeline_chef_answer_stale)', r.evs);
  const q = chefTurn(chefLog, { turn: 'c-q', text: markerPrompt('P', 'une question ordinaire ?'), answer: '[ANSWER] Oui, vas-y.' });
  const qr = chefAnswerRelay({ lines: chefLog, result: q });
  r = await go([qr.prompt], ITEMS);
  st = runState(RUN);
  ok(!r.evs.some(e => e.subtype === 'pipeline_chef_decision' || e.subtype === 'pipeline_chef_pause_to_user') && st.chefPause.status === 'pending' && st.chefPause.n === 3, 'une réponse à une question ordinaire ne tranche jamais une pause (ni décision, ni pause rendue à l’utilisateur)', r.evs.map(e => e.subtype || e.type));
  ok(r.run && r.run !== RUN, `elle part comme une demande (ici une Discussion ${r.run}), plus récente que l’exécution en pause`, r.out.slice(-300));
}

section('4. Réponse non appliquée sous 2 min : signalée au chef');
{
  clock = Date.now();   // the chef answers after the pause was posed
  const stale = chefTurn([], { turn: 'c-old', text: markerPrompt('P', `[${RUN} · pause 3] P — pause de PROCESSUS…`), answer: '[ANSWER] x' });
  ok(unappliedChefAnswers({ logsDir: path.join(T, 'logs'), conductor: 'chef', chefEvents: [{ ...stale, type: 'user_prompt', text: markerPrompt('P', `[${RUN} · pause 3] …`), timestamp: '2026-01-01T00:00:00Z' }, { ...stale, timestamp: '2026-01-01T00:00:01Z' }], now: Date.now() + 600_000 }).length === 0,
    'une question plus ancienne que la pause (même texte) ne compte pas comme réponse à celle-ci');
  const res3 = chefTurn(chefLog, { turn: 'c-3', text: markerPrompt('P', `[${RUN} · pause 3] P — pause de PROCESSUS…`), answer: '[ANSWER] livrer sans eux — l’item 2 reste bloqué pour la même raison' });
  const at = Date.parse(res3.timestamp);
  ok(unappliedChefAnswers({ logsDir: path.join(T, 'logs'), conductor: 'chef', chefEvents: chefLog, now: at + 30_000 }).length === 0, 'après 30 s : rien à signaler');
  const late = unappliedChefAnswers({ logsDir: path.join(T, 'logs'), conductor: 'chef', chefEvents: chefLog, now: at + 125_000 });
  ok(late.length === 1 && late[0].run === RUN && late[0].n === 3 && late[0].project === 'P' && /livrer sans eux/.test(late[0].answer), 'après 2 min, la réponse n° 3 non appliquée est relevée', late);
  const text = unappliedText(late[0], { orchestratorRoot: ROOT });
  ok(text.startsWith(`[NEEDS_CHEF_INPUT_FROM:P] [${RUN} · pause 3]`) && /n’est pas appliquée depuis 2 min/.test(text) && /--pipeline-resume/.test(text) && !/NEEDS_USER_INPUT:/.test(text.split('\n')[0]), 'le signalement va au CHEF : une question qui nomme la pause, la réponse et la commande', text.slice(0, 300));
  const reask = chefTurn(chefLog, { turn: 'c-4', text, answer: '[ANSWER] livrer sans eux — répété' });
  ok(chefAnswerRelay({ lines: chefLog, result: reask }).pause?.n === 3, 'la réponse du chef à ce signalement est relayée en nommant la pause n° 3');
  ok(/sweepUnappliedChefAnswers/.test(SERVER) && /class: 'decision', text,\s*displayText: u\.queued \? `réponse en file[^\n]*`réponse non appliquée/.test(SERVER) && /pipeline_chef_answer_unapplied/.test(SERVER), 'server.js : balayage, ticket de décision au chef, trace dans le journal du musicien');

  // Defect (a), 2026-10-26/27: the answer was applied with --pipeline-resume but waits in the
  // musician's queue (answers to a pause go first, 0.148.0, yet the lane is busy). The watch
  // must see it and say so, not ask the chef to answer again (duplicates in the queue).
  fs.mkdirSync(path.join(T, 'logs', 'queue'), { recursive: true });
  fs.writeFileSync(path.join(T, 'logs', 'queue', 'P.json'), JSON.stringify([{ id: 'q-1', prompt: 'livrer sans eux', pipelineResume: RUN, pauseReply: true, enqueuedAt: new Date(at + 20_000).toISOString() }]));
  const waiting = unappliedChefAnswers({ logsDir: path.join(T, 'logs'), conductor: 'chef', chefEvents: chefLog, now: at + 125_000 });
  ok(waiting.length === 1 && waiting[0].queued?.id === 'q-1', 'la réponse déjà en file (pipelineResume = l’exécution) est relevée comme « en file », avec son entrée', waiting);
  const qtext = waiting[0] ? unappliedText(waiting[0], { orchestratorRoot: ROOT }) : '';
  ok(/en file/.test(qtext) && !/Réponds de nouveau/.test(qtext), 'le signalement dit que la réponse attend en file et ne demande pas de répondre de nouveau', qtext.slice(0, 400));
  fs.rmSync(path.join(T, 'logs', 'queue', 'P.json'), { force: true });
}

section('5. « livrer sans eux <run> » envoyé par le chef : la pause citée, malgré une Discussion plus récente');
{
  const latest = runsOfP().at(-1);
  ok(latest !== RUN && runState(latest).pipeline === 'discussion', `une Discussion (${latest}) est plus récente que l’exécution en pause`);
  const runs0 = runsOfP().length;
  r = await go([`livrer sans eux ${RUN} — l’item 2 reste bloqué pour la même raison après une reprise`], { ...ITEMS, ORCH_TURN_PROJECT: 'chef' });
  st = runState(RUN);
  ok(runsOfP().length === runs0 && r.run === RUN && st.status === 'abandoned' && st.abandonedBy === 'livrer sans eux', `le texte répond à l’exécution citée et la clôt, aucune nouvelle exécution (${r.run}, ${st.status})`, r.out.slice(-600));
  ok(r.evs.some(e => e.subtype === 'pipeline_chef_decision' && e.n === 3 && /« livrer sans eux » — l’item 2 reste bloqué/.test(e.text)) && st.pauseAnswers.at(-1).by === 'chef', 'c’est la décision du chef (la pause attendait le chef)', st.pauseAnswers?.at(-1));
  ok(unappliedChefAnswers({ logsDir: path.join(T, 'logs'), conductor: 'chef', chefEvents: chefLog, now: Date.now() + 3600_000 }).length === 0, 'plus rien à signaler');
}

section('6. Une Discussion ne démarre pas pendant le tour d’une exécution dev dans la copie principale');
{
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true });
  const lock = path.join(T, 'logs', 'P.turnlock');
  fs.writeFileSync(lock, JSON.stringify({ pid: holder.pid, turn: 't-dev-run', at: new Date().toISOString() }));
  const n0 = logOf().length;
  const c = spawnDispatch(['/discussion où en est le projet ?']);
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const exited = new Promise(res => c.on('exit', res));
  await new Promise(res => setTimeout(res, 3000));
  ok(c.exitCode === null && !logOf().slice(n0).some(e => e.type === 'user_prompt'), 'tant que le tour dev tient la copie principale : la Discussion attend, rien n’est écrit', out.slice(-400));
  holder.kill();
  const code = await exited;
  ok(code === 0 && logOf().slice(n0).some(e => e.type === 'user_prompt' && e.pipeline?.pipeline === 'discussion'), 'le tour fini, elle démarre', out.slice(-400));
}

srv.close();
if (!process.env.KEEP_T) { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log('T=' + T);
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
