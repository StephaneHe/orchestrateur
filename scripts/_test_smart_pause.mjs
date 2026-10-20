#!/usr/bin/env node
// ============================================================================
// scripts/_test_smart_pause.mjs — every pause states its cause and offers
// choices that act on it (0.122.0)
// ============================================================================
//
// User request (2026-10-20), verbatim: « Une chose qui me gene c'est de
// porposer des choix stupides. Si quelque chose a provoquer une erreur,
// proposer de continuer ou de changer de modele ne resoudra pas l'erreur. Il
// faudrait un choix plus intelligent »
//
// Protected (user requirement, never weakened without the user's agreement):
//   1. real past pauses (tests/pause-cases.json): cause established by the
//      code, menu derived from it (expected kind and recommendation), and the
//      generic menu of before is gone;
//   2. rules, for every cause kind: no pause without a stated cause;
//      « continuer » only for a transient cause; « changer le model » only
//      with a proof; « abandonner » always; one recommended option, with its
//      reason; every option says what it does;
//   3. menu words: explicit answers, matched exactly (accents optional);
//   4. a model only when the code finds nothing (case routage.classifier);
//   5. the automatic answer chooses among the options of the menu only;
//   6. real dispatch.mjs + engine + fake claude: the pause message states the
//      cause, its menu follows the rules, and the options really act —
//      « changer d’approche » hands the named approach to the step,
//      « ajuster le critère » relaxes the criterion for this run (traced) and
//      the run completes, « découper » splits the list (named rest).
//
//   node scripts/_test_smart_pause.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnosePause, diagnoseWithModel, smartMenu, fixMenu, checkMenu, matchOptionKey, menuQuestion, CAUSE_KINDS, TRANSIENT_KINDS, OPTION_KEYS } from './pause-diagnosis.mjs';
import { resumeMessage, orchArtefactNames } from './pipeline-engine.mjs';
import { oldMenuOf, pausesInLog, replayPause } from './pause-replay.mjs';
import * as AA from './auto-answer.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const keysOf = (m) => m.options.map(o => o.key);

// ---------------------------------------------------------------------------
section('1. Vrais cas passés : cause établie par le code, menu dérivé de la cause');
const { cases } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'pause-cases.json'), 'utf8'));
const orchNames = orchArtefactNames();
for (const c of cases) {
  const input = { ...c.input, orchNames };
  if (c.input.itemsLeftCount) input.itemsLeft = Array.from({ length: c.input.itemsLeftCount }, (_, i) => ({ n: i + 1, text: `comportement ${i + 1} (tests: 1)` }));
  const d = diagnosePause(input);
  const menu = fixMenu(d, smartMenu(d, { step: input.step, ...(c.menuCtx || {}) }));
  const keys = keysOf(menu);
  ok(d.kind === c.kind, `${c.id} : cause « ${c.kind} » (obtenu « ${d.kind} »)`, d.cause);
  ok(d.source === 'code' && d.cause.length > 20, `${c.id} : cause énoncée par le code — ${d.cause.slice(0, 140)}`);
  ok(menu.recommend.key === c.recommend, `${c.id} : recommandé « ${c.recommend} » (obtenu « ${menu.recommend.key} »)`, menu);
  for (const h of c.has || []) ok(keys.includes(h), `${c.id} : propose aussi « ${h} »`, keys);
  ok(checkMenu(d, menu).length === 0, `${c.id} : menu conforme aux règles`, checkMenu(d, menu));
  ok(keys.join('|') !== c.before.join('|'), `${c.id} : plus le menu générique d’avant (${c.before.join(', ')}) → ${keys.join(', ')}`);
  if (!TRANSIENT_KINDS.includes(d.kind)) ok(!keys.includes('continuer'), `${c.id} : cause non passagère ⇒ pas de « continuer »`, keys);
}
{
  // The cited paths really judged: the bare file name points to its full path.
  const d = diagnosePause({ limit: 'criteria', step: { id: 'comprendre' }, why: 'chemins cités inexistants : VersionConsistencyTest.kt, docs/X.md', files: ['app/src/test/VersionConsistencyTest.kt'], orchNames });
  const m = smartMenu(d, {});
  const fix = m.options.find(o => o.key === 'corriger les références');
  ok(fix && /VersionConsistencyTest\.kt → app\/src\/test\/VersionConsistencyTest\.kt/.test(fix.effect.message) && /docs\/X\.md/.test(fix.effect.message), 'chemins cités : la consigne donne le chemin exact retrouvé et nomme le chemin absent', fix);
  const big = diagnosePause({ limit: 'items', itemsDone: 0, itemsMax: 15, itemsLeft: Array.from({ length: 22 }, (_, i) => ({ n: i + 1, text: `comportement ${i + 1} (tests: 1)` })) });
  const bm = smartMenu(big, { keep: 15 });
  const split = bm.options.find(o => o.key === 'découper');
  ok(split && split.effect.split.keep === 15 && /« comportement 16 »/.test(split.does) && /7 restants/.test(split.does), 'trop gros : « découper » nomme les sous-tâches qui partiront à part', split);
}

// ---------------------------------------------------------------------------
section('2. Règles, pour CHAQUE cause : cause énoncée, « continuer » si passagère, model avec preuve, une recommandée');
const SAMPLE = {
  provider_transient: { limit: 'model_unavailable', why: 'API 529 overloaded' }, network: { limit: 'green', why: 'la suite échoue encore', testOutput: 'ETIMEDOUT' },
  limit: { limit: 'criteria', why: 'usage limit reached' }, model_unknown: { limit: 'model_unavailable', why: 'model_not_found: the model gpt-x does not exist' },
  env_auth: { limit: 'criteria', why: 'Failed to authenticate: OAuth token expired' }, refusal: { limit: 'criteria', why: "can't help with this. Start a new session" },
  env_disk: { limit: 'green', why: 'la suite échoue encore', testOutput: 'ENOSPC: no space left on device' }, env_port: { limit: 'green', why: 'la suite échoue encore', testOutput: 'Error: listen EADDRINUSE: address already in use :::7790' },
  env_dependency: { limit: 'green', why: 'la suite échoue encore', testOutput: "Error: Cannot find module 'left-pad'" }, test_wrong: { limit: 'green', why: 'la suite échoue encore', testOutput: 'test/a.test.mjs:3\nSyntaxError: Unexpected token' },
  launch: { limit: 'launch', why: 'sans result', extra: { failures: 12 } }, interrupted: { limit: 'orphaned', why: 'processus mort' },
};
for (const kind of Object.keys(CAUSE_KINDS)) {
  const input = SAMPLE[kind] || { limit: 'criteria', step: { id: 'x' }, why: 'motif inconnu' };
  const d = SAMPLE[kind] ? diagnosePause(input) : diagnosePause({ known: { kind } });
  ok(d.kind === kind, `${kind} : reconnue`, d);
  for (const proof of [null, { kind: 'model-test', text: 'test du model en échec' }]) {
    const dd = proof ? { ...d, proof } : { ...d, proof: d.proof || null };
    const menu = fixMenu(dd, smartMenu(dd, { step: { id: 'x', label: 'x' }, canAccept: true }));
    const keys = keysOf(menu);
    const tag = `${kind}${proof ? ' + preuve' : ''}`;
    ok(String(dd.cause).trim().length > 10, `${tag} : cause énoncée`);
    ok(!keys.includes('continuer') || TRANSIENT_KINDS.includes(kind), `${tag} : « continuer » seulement si passagère`, keys);
    ok(!keys.includes('changer le model') || !!dd.proof, `${tag} : « changer le model » seulement avec preuve`, keys);
    ok(keys.includes('abandonner') && keys.includes(menu.recommend.key) && menu.recommend.why.length > 10, `${tag} : « abandonner » + une option recommandée justifiée (« ${menu.recommend.key} »)`, menu);
    ok(menu.options.every(o => o.does.length > 15 && OPTION_KEYS[o.key]), `${tag} : chaque option dit ce qu’elle fera`, menu.options);
  }
}
{
  const launch = diagnosePause({ limit: 'launch', why: 'lancement impossible (code 1) : API Error: 529 overloaded_error | [dispatch] fallback refusé : model explicite x — le CLI claude a échoué sans result (529 overloaded)', extra: { failures: 6 } });
  const lm = fixMenu(launch, smartMenu(launch, {}));
  ok(launch.kind === 'launch' && !keysOf(lm).includes('changer le model') && lm.recommend.key === 'tester le model' && !lm.options.some(o => /« changer le model »/.test(o.does)),
    'panne 529 relayée par une ligne [dispatch] : pas un refus de l’orchestrateur ; sans preuve, « tester le model » recommandé, jamais « changer le model »', lm);
  const tested = diagnosePause({ limit: 'launch', why: 'sans result', modelTest: { model: 'm', ok: false, why: 'exit 1' }, model: 'm' });
  ok(!!tested.proof && keysOf(fixMenu(tested, smartMenu(tested, {}))).includes('changer le model'), 'test du model en échec = preuve : « changer le model » devient proposé', tested);
  const lim = diagnosePause({ limit: 'criteria', why: "You've hit your usage limit" });
  ok(lim.kind === 'limit' && !lim.proof && !keysOf(fixMenu(lim, smartMenu(lim, {}))).includes('changer le model'), 'limite d’utilisation : passagère, pas une preuve contre le model (pas de « changer le model »)');
}
ok(TRANSIENT_KINDS.includes('limit') && TRANSIENT_KINDS.includes('network') && !TRANSIENT_KINDS.includes('test_passes'), 'passagères : panne, limite, réseau, interruption — pas un test');
{
  const d = diagnosePause({ limit: 'criteria', why: 'la suite passe encore : x' });
  const bad = { options: [{ key: 'continuer', does: 'je réessaie' }, { key: 'changer le model', does: 'autre model' }], recommend: { key: 'continuer', why: '' } };
  const pb = checkMenu(d, bad);
  ok(pb.some(p => /continuer/.test(p)) && pb.some(p => /preuve/.test(p)) && pb.some(p => /abandonner/.test(p)) && pb.some(p => /justification/.test(p)), 'checkMenu repère chaque violation', pb);
  const fixed = fixMenu(d, bad);
  ok(checkMenu(d, fixed).length === 0, 'fixMenu rend tout menu conforme (filet de sécurité du moteur)', fixed);
  ok(checkMenu({ ...d, cause: '' }, fixed).some(p => /cause/.test(p)), 'une pause sans cause énoncée est refusée');
}
{
  const d = diagnosePause({ limit: 'criteria', step: { id: 'rouge', label: 'écrire un test' }, why: 'la suite passe encore : le nouveau test n’échoue pas' });
  const q = menuQuestion('P', d, fixMenu(d, smartMenu(d, {})));
  ok(/^P en pause — répondez « corriger le test »/.test(q) && /je recommande « corriger le test »/.test(q.slice(0, 160)) && q.includes(d.cause.slice(0, 40)), 'question : choix et recommandation d’abord (coupée à 160 caractères), puis la cause', q);
}

// ---------------------------------------------------------------------------
section('3. Mots du menu : réponses explicites');
for (const [said, want] of [['corriger le test', 'corriger le test'], ['Corriger le test.', 'corriger le test'], ['[CHEF_ANSWER] découper', 'découper'], ['decouper', 'découper'],
  ["changer d'approche", 'changer d’approche'], ['ajuster le critère — pour cette fois', 'ajuster le critère'], ['réparé', 'réparé'], ['livrer sans eux', 'livrer sans eux'],
  ['continuer', 'continuer'], ['je pense qu’il faut corriger le test', null], ['corrigeons', null]]) {
  ok(matchOptionKey(said) === want, `« ${said} » → ${want ? `« ${want} »` : 'aucun choix'}`, matchOptionKey(said));
}
ok(matchOptionKey('corriger le test', ['découper', 'abandonner']) === null, 'limité aux choix de la pause quand ils sont donnés');
for (const k of ['corriger le test', 'découper', 'ajuster le critère', 'réparé']) ok(resumeMessage(k) === null, `« ${k} » seul : une décision, pas un message joint`);
ok(resumeMessage('découper — et commence par l’export') !== null, 'un choix suivi d’un message : le message est gardé');

// ---------------------------------------------------------------------------
section('4. Un model seulement si le code ne trouve rien (case routage.classifier)');
{
  let calls = 0;
  const choose = async (a) => { calls++; return { ok: true, id: 'test_wrong', raison: 'le test importe un nom qui n’existe pas', model: 'claude-haiku-5-5', _q: a }; };
  const known = diagnosePause({ limit: 'criteria', why: 'aucun commit créé' });
  const k2 = await diagnoseWithModel(known, {}, { choose });
  ok(calls === 0 && k2.source === 'code', 'cause trouvée par le code : aucun appel au model');
  const unknown = diagnosePause({ limit: 'criteria', step: { id: 'x' }, why: 'aucun résultat (code 1)' });
  ok(unknown.kind === 'unknown' && /non établie/.test(unknown.cause), 'motif opaque : cause non établie par le code (et dit)');
  const viaModel = await diagnoseWithModel(unknown, { limit: 'criteria', why: 'aucun résultat (code 1)' }, { choose });
  ok(calls === 1 && viaModel.kind === 'test_wrong' && viaModel.source === 'model' && viaModel.model === 'claude-haiku-5-5' && /importe un nom/.test(viaModel.cause), 'model consulté une fois, cause reprise avec sa raison', viaModel);
  const m = fixMenu(viaModel, smartMenu(viaModel, {}));
  ok(m.recommend.key === 'corriger le test' && checkMenu(viaModel, m).length === 0, 'menu dérivé de la cause donnée par le model');
  const failed = await diagnoseWithModel(unknown, {}, { choose: async () => ({ ok: false, why: 'case vide' }) });
  ok(failed.kind === 'unknown' && failed.modelTried?.ok === false && checkMenu(failed, fixMenu(failed, smartMenu(failed, {}))).length === 0, 'model indisponible : cause « non établie » dite, menu toujours conforme');
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'pipeline-engine.mjs'), 'utf8');
  ok(/d\.kind === 'unknown'[^\n]*\n[^\n]*chooseOption[^\n]*\n[^\n]*diagnoseWithModel/.test(src), 'moteur : le model n’est appelé que pour une cause « unknown », par chooseOption (case routage.classifier)');
}

// ---------------------------------------------------------------------------
section('5. Réponse automatique : un choix du menu, jamais autre chose');
{
  const diagnosis = { cause: 'Le nouveau test passe déjà.', kind: 'test_passes', options: [{ key: 'corriger le test', does: 'je relance…' }, { key: 'abandonner', does: 'j’arrête' }], recommend: { key: 'corriger le test', why: 'le test ne vérifie pas ce qui manque' } };
  const wait = { kind: 'pause', project: 'P', question: 'P en pause', context: { run: 'p-1', pipeline: 'dev', pausedLimit: 'criteria', diagnosis } };
  const prompt = AA.answerPrompt(wait, { guardrails: [], idleMin: 15, waitMin: 5 });
  ok(prompt.includes('DIAGNOSED CAUSE') && prompt.includes('Le nouveau test passe déjà.') && prompt.includes('« corriger le test »') && /RECOMMENDED: « corriger le test »/.test(prompt), 'le prompt donne la cause, les choix et la recommandation', prompt.slice(-1500));
  const good = AA.normalizeAnswer(wait, { answer: 'corriger le test — c’est la recommandation', engages: [], concerns: [], safeAnswer: 'abandonner' });
  ok(good.ok && good.safeAnswer === 'abandonner', 'réponse = un choix du menu : acceptée');
  const outside = AA.normalizeAnswer(wait, { answer: 'continuer', engages: [], concerns: [] });
  ok(!outside.ok && /hors des choix/.test(outside.why), 'réponse hors du menu (« continuer » non proposé) : refusée', outside);
  const badSafe = AA.normalizeAnswer(wait, { answer: 'corriger le test', safeAnswer: 'changer le model', engages: [], concerns: [] });
  ok(badSafe.ok && badSafe.safeAnswer === '', 'variante non engageante hors menu : écartée');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smart-aa-'));
  fs.mkdirSync(path.join(T, 'runs', 'p-20261020T100000-abcdef'), { recursive: true });
  fs.writeFileSync(path.join(T, 'R.jsonl'), [JSON.stringify({ type: 'user_prompt', text: 'x' }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'pause\n\nNEEDS_USER_INPUT: R en pause' }] } }), JSON.stringify({ type: 'result', subtype: 'success', result: 'NEEDS_USER_INPUT: R en pause', num_turns: 3, duration_api_ms: 10, timestamp: '2026-10-20T10:00:00Z' })].join('\n') + '\n');
  fs.writeFileSync(path.join(T, 'runs', 'p-20261020T100000-abcdef', 'run.json'), JSON.stringify({ project: 'R', pipeline: 'dev', status: 'paused', pausedLimit: 'criteria', diagnosis }));
  const w = AA.collectLogWaits({ logsDir: T, projects: [{ name: 'R', path: T }] }).find(x => x.project === 'R');
  ok(w?.kind === 'pause' && w.context.diagnosis?.recommend?.key === 'corriger le test' && w.context.diagnosis.options.length === 2, 'attente lue dans les logs : le menu diagnostiqué l’accompagne', w);
  fs.rmSync(T, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('6. Rejeu : menu d’avant lu dans le log, menu d’après calculé');
{
  const q = 'x\n\nNEEDS_USER_INPUT: P en pause — répondez « continuer », « simplifier », « changer le model » ou « abandonner » (je recommande « continuer ») : l’étape a été refusée';
  ok(oldMenuOf(q).join('|') === 'continuer|simplifier|changer le model|abandonner', 'menu d’avant extrait de la question', oldMenuOf(q));
  const lines = [JSON.stringify({ type: 'notification', subtype: 'pipeline_limit', limit: 'criteria', pipeline: { run: 'p-1', step: 'rouge' }, why: 'la suite passe encore : le nouveau test n’échoue pas (npm test)' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: q }] } })];
  const p = pausesInLog(lines)[0];
  const r = replayPause(p);
  ok(p.limit === 'criteria' && r.d.kind === 'test_passes' && !keysOf(r.menu).includes('continuer') && r.problems.length === 0, 'pause réelle rejouée : cause et menu intelligents', r);
}

// ---------------------------------------------------------------------------
section('7. Bout en bout : vrai dispatch.mjs, vrai moteur, faux claude');
const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smart-pause-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer', 'rechercher', 'repondre'].map(s => [s === 'rechercher' || s === 'repondre' ? `discussion.${s}` : `dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])), 'discussion.comprendre': { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
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
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', FAKE_CLAUDE_DUMP_PROMPT: DUMP, ORCH_PAUSE_MODEL_DIAG: '0' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL)$|^DISPATCH_SLOT$|^FAKE_PIPE_|^ORCH_PIPE_(ITEMS|REVIEW_ROUNDS|GREEN_ATTEMPTS|CRITERIA_ATTEMPTS)$/.test(k)) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 300_000);
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
const lastText = (evs) => [...evs].reverse().find(e => e.type === 'result')?.result || '';
const checkPause = (label, r, st) => {
  const text = lastText(r.evs);
  const q = (/NEEDS_USER_INPUT:\s*(.*)/.exec(text) || [])[1] || st.question || '';
  const keys = (st.diagnosis?.options || []).map(o => o.key);
  ok(r.code === 2 && st.status === 'paused', `${label} : en pause (code ${r.code})`, r.out.slice(-800));
  ok(/\*\*Cause\*\* : /.test(text) && st.diagnosis?.cause && text.includes(st.diagnosis.cause.slice(0, 50)), `${label} : le message énonce la cause — ${String(st.diagnosis?.cause).slice(0, 120)}`, text.slice(0, 800));
  ok(r.evs.some(e => e.subtype === 'pipeline_diagnosis' && e.diagnosis?.cause), `${label} : diagnostic tracé (system/pipeline_diagnosis)`);
  ok(checkMenu(st.diagnosis, { options: st.diagnosis.options, recommend: st.diagnosis.recommend }).length === 0, `${label} : menu conforme (${keys.join(', ')})`, st.diagnosis);
  ok(new RegExp(`je recommande « ${st.diagnosis.recommend.key} »`).test(q) && text.includes(`**Je recommande « ${st.diagnosis.recommend.key} »**`), `${label} : une option recommandée, dans la question et le message`, q);
  return { text, q, keys };
};

// 7a. « la suite passe encore » twice (real case): no « continuer », no « changer le model ».
fs.rmSync(DUMP, { force: true });
let r = await go(['Ajoute le tri des vidéos', '--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple'], { FAKE_PIPE_COVERED: '0', FAKE_PIPE_NOCLAIM: '1' });
const run1 = r.run;
let st = runState(run1);
let v = checkPause('7a suite qui passe encore', r, st);
ok(st.diagnosis.kind === 'test_passes' && !v.keys.includes('continuer') && !v.keys.includes('changer le model') && !/« continuer »|« changer le model »/.test(v.q), '7a : ni « continuer » ni « changer le model » (rien ne prouve le model en cause)', v.q);
ok(v.keys.includes('corriger le test') && st.diagnosis.recommend.key === 'changer d’approche', '7a : « corriger le test » proposé ; même refus deux fois ⇒ « changer d’approche » recommandé', st.diagnosis);
fs.rmSync(DUMP, { force: true });
r = await go(['changer d’approche'], { FAKE_PIPE_COVERED: '0', FAKE_PIPE_NOCLAIM: '1' });
const rp = prompts().filter(p => /PIPELINE_STEP=rouge/.test(p));
ok(r.run === run1 && rp.length > 0 && rp.every(p => /CHANGER D’APPROCHE/.test(p) && /DEJA_COUVERT/.test(p)), `7a : « changer d’approche » relance l’étape avec la méthode nommée (${rp.length} essai(s))`, r.out.slice(-600));
ok(r.evs.some(e => e.subtype === 'pipeline_pause_option' && e.key === 'changer d’approche'), '7a : le choix est tracé (system/pipeline_pause_option)');

// 7b. cited paths of the orchestrator (real case): « ajuster le critère » relaxes it for this run, the run completes.
r = await go(['/discussion Que fait ce projet ?'], { FAKE_PIPE_CITE: 'rouge.md,system/init' });
const run2 = r.run;
st = runState(run2);
v = checkPause('7b chemins cités', r, st);
ok(st.diagnosis.kind === 'criterion_strict' && st.diagnosis.recommend.key === 'ajuster le critère' && !v.keys.includes('continuer'), '7b : refus à tort reconnu ⇒ « ajuster le critère » recommandé', st.diagnosis);
r = await go(['ajuster le critère'], { FAKE_PIPE_CITE: 'rouge.md,system/init' });
st = runState(run2);
ok(r.code === 0 && st.status === 'done', `7b : l’exécution reprend et se termine (code ${r.code}, ${st.status})`, r.out.slice(-800));
ok(st.relaxed?.length === 1 && st.relaxed[0].criterion === 'citedPaths' && r.evs.some(e => e.subtype === 'pipeline_criterion_relaxed'), '7b : critère ajusté pour cette exécution seulement, tracé', st.relaxed);
ok(/Critère\(s\) ajusté\(s\)/.test(lastText(r.evs)), '7b : l’ajustement est dit dans le résultat');

// 7c. too many tests: « découper » keeps the first ones, the rest becomes named separate requests.
r = await go(['Ajoute cinq multiplications', '--pipeline', 'dev', '--mode', 'complet', '--kind', 'simple'], { FAKE_PIPE_ITEMS: '5', ORCH_PIPE_ITEMS: '3' });
const run3 = r.run;
st = runState(run3);
v = checkPause('7c liste trop longue', r, st);
ok(st.diagnosis.kind === 'too_big' && v.keys.includes('découper') && !v.keys.includes('continuer'), '7c : trop gros ⇒ « découper » proposé, pas « continuer »', st.diagnosis);
r = await go(['découper'], { FAKE_PIPE_ITEMS: '5', ORCH_PIPE_ITEMS: '3' });
st = runState(run3);
const reste = fs.existsSync(path.join(P, '.orchestrateur', 'runs', run3, 'reste.md')) ? fs.readFileSync(path.join(P, '.orchestrateur', 'runs', run3, 'reste.md'), 'utf8') : '';
ok(st.splitOff?.length === 2 && /multiplier par 5/.test(reste) && /multiplier par 6/.test(reste), '7c : les 2 tests en trop deviennent des demandes séparées nommées (reste.md)', reste || st.splitOff);
ok(r.code === 0 && st.status === 'done' && st.itemsDone === 3, `7c : les 3 premiers sont faits et l’exécution se termine (code ${r.code}, ${st.status}, ${st.itemsDone} items)`, r.out.slice(-800));
ok(/Reste à demander séparément/.test(lastText(r.evs)) && /multiplier par 6/.test(lastText(r.evs)), '7c : le résultat nomme ce qui reste à demander');

srv.close();
if (!process.env.KEEP_T) { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log('T=' + T);
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
