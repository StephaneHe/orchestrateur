#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_process_pauses.mjs — process pauses are settled by the
// chef, never asked to the user (0.133.0)
// ============================================================================
//
// User rule (2026-10-22), verbatim: « arrête de poser des questions de
// découpage. tu sais comment est organisé le process mieux que moi ».
//
// Protected (user requirement, never weakened without the user's agreement):
//   1. families: process pauses (items, items_blocked, aside_conflict, test /
//      step / review / duration limits, resume after an interruption) go to the
//      chef; user decisions (authorization, operation, doubts before deletion,
//      red base, infrastructure, model, launch refusal, unknown cause, the
//      chef's own Routage, a lane) stay with the user; the chef is never offered
//      abandonner, simplifier, accepter, tout supprimer, autoriser, tester or
//      changer le model;
//   2. the 4 pauses of the real run of 2026-10-22 (« découper », « reprendre les
//      items » twice, « écarter l’item »), replayed: none reaches the user, each
//      goes to the chef with a one-line question the server relay can carry,
//      and the answer actually given is understood;
//   3. anti-loop: the same set-aside items for the same reasons, already resumed
//      twice, cannot be resumed a 3rd time; « livrer sans eux » is then
//      recommended with the reason and a separate request per item is suggested;
//   4. real dispatch.mjs + engine + fake claude, lever ON: the pause ends with
//      NEEDS_CHEF_INPUT (never NEEDS_USER_INPUT), the musician is not « input »,
//      the automatic answer does not see it, the run view offers no button;
//      the relayed [CHEF_ANSWER] (no --pipeline-resume) resumes the run with its
//      effect, traced « tranché par le chef : <option> — <raison> » in the
//      timeline and the journal; an answer outside the options hands the pause
//      to the user; « livrer sans eux » chosen by the chef closes the run with
//      the suggestions;
//   5. a user-decision pause still reaches the user with the lever ON, and the
//      lever OFF keeps exactly the behaviour before (NEEDS_USER_INPUT); the
//      lever is frozen per run.
//
//   node scripts/_test_chef_process_pauses.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnosePause, smartMenu, fixMenu } from './pause-diagnosis.mjs';
import { routePause, pauseFamily, pauseSignature, parseChefDecision, CHEF_KEYS, PROCESS_LIMITS } from './process-pause.mjs';
import { answerPausedRun } from './pipeline-engine.mjs';
import { pauseView, runView } from './pipeline-run-view.mjs';
import { runTuning, LEVER_IDS } from './pipeline-tuning.mjs';
import { deriveState, createJournal } from './fleet-status-core.mjs';
import * as AA from './auto-answer.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const FORBIDDEN = ['abandonner', 'simplifier', 'accepter', 'tout supprimer', 'autoriser', 'tester le model', 'changer le model', 'réparé', 'reconnecté', 'garder les doutes'];
// The server's relay regex, read from server.js (the line the chef receives).
const NEEDS_CHEF_RE = new RegExp(/const NEEDS_CHEF_RE\s*=\s*\/(.+)\/i;/.exec(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))[1], 'i');

const route = (limit, input, extra = {}) => {
  const d = diagnosePause({ limit, ...input });
  const menu = fixMenu(d, smartMenu(d, { step: input.step, delivered: 2, ...(extra.menuCtx || {}) }));
  const sig = pauseSignature({ limit, kind: d.kind, step: input.step?.id, item: input.item?.n, aside: input.aside, asideConflict: extra.asideConflict });
  return { d, menu, sig, r: routePause({ limit, d, menu, pipeline: extra.pipeline || 'dev', lane: extra.lane || 0, history: extra.history || [], sig, project: '[projet]', run: 'p-20261022T133600-829910', n: extra.n || 1, aside: input.aside || [] }) };
};

// ---------------------------------------------------------------------------
section('1. Deux familles : processus → chef, décision utilisateur → utilisateur');
{
  const left = Array.from({ length: 9 }, (_, i) => ({ n: 16 + i, text: `comportement ${16 + i} (tests: 1)` }));
  const PROCESS = {
    items: { itemsDone: 15, itemsMax: 15, itemsLeft: left },
    items_blocked: { aside: [{ group: 5, limit: 'review', reason: 'la relecture trouve encore des défauts', why: 'commentaire d’en-tête à compléter' }] },
    aside_conflict: { why: "Applied patch to 'README.md' with conflicts." },
    item_tests: { item: { n: 3, text: 'x', declared: 1 }, written: 4 },
    green: { step: { id: 'vert', label: 'faire passer le test' }, why: 'la suite échoue encore', testOutput: 'AssertionError: expected 2 to equal 3' },
    criteria: { step: { id: 'rouge', label: 'écrire un test' }, why: 'la suite passe encore : le nouveau test n’échoue pas' },
    review: { why: 'la revue relève encore : a ; b', defects: ['a', 'b'], extra: { rounds: 3 } },
    duration: { itemsLeft: [{ n: 1, text: 'x' }], extra: { duration: '90 min' } },
    orphaned: { why: 'processus mort' },
  };
  for (const limit of PROCESS_LIMITS) {
    const { d, r } = route(limit, PROCESS[limit] || {});
    ok(r.to === 'chef', `« ${limit} » (cause « ${d.kind} ») → chef`, r);
    if (r.to !== 'chef') continue;
    const keys = r.menu.options.map(o => o.key);
    ok(keys.length && keys.every(k => CHEF_KEYS.includes(k)) && !keys.some(k => FORBIDDEN.includes(k)) && keys.includes(r.menu.recommend.key),
      `« ${limit} » : le chef choisit seulement parmi des options de processus (${keys.join(', ')}), recommandée « ${r.menu.recommend.key} »`, keys);
  }
  const USER = [
    ['autoriser', { extra: { operations: ['git_push'] } }], ['operation', { why: 'effet non vérifié', extra: { stage: 'postcondition' } }], ['doutes', { extra: { doubts: 2 } }],
    ['precondition', { extra: { failing: 'test/a.test.mjs' } }], ['infra', { known: { kind: 'env_auth', cause: 'OAuth expirée.' } }], ['launch', { why: 'sans result', extra: { failures: 6 } }],
    ['launch_refused', { why: '[dispatch] refus' }], ['model_unavailable', { why: 'API 529 overloaded' }], ['classifier', { why: 'réponse invalide' }], ['item_commit', { why: 'commit a échoué : hook' }],
  ];
  for (const [limit, input] of USER) {
    const { d, r } = route(limit, input);
    ok(r.to === 'user', `« ${limit} » (cause « ${d.kind} ») → reste à l’utilisateur — ${r.why}`, r);
  }
  ok(route('green', { step: { id: 'vert' }, why: 'la suite échoue encore', testOutput: 'Error: listen EADDRINUSE: address already in use :::7790' }).r.to === 'user', 'limite de processus mais cause d’environnement (port occupé) → utilisateur (dans le doute)');
  ok(route('criteria', { step: { id: 'x' }, why: 'motif opaque' }).r.to === 'user', 'cause non établie → utilisateur (dans le doute)');
  ok(route('criteria', { step: { id: 'x' }, why: 'Failed to authenticate: OAuth token expired' }).r.to === 'user', 'connexion expirée → utilisateur');
  ok(route('items', PROCESS.items, { pipeline: 'routage' }).r.to === 'user', 'pause du Routage du chef lui-même → utilisateur');
  ok(route('items', PROCESS.items, { lane: 2 }).r.to === 'user', 'exécution dans un couloir ≥ 1 → utilisateur (le relais ne la porte pas)');
  ok(pauseFamily({ limit: 'nouvelle-limite', kind: 'too_big' }).family === 'user', 'limite inconnue → utilisateur (dans le doute)');
}

// ---------------------------------------------------------------------------
section('2. Rejeu des 4 pauses de l’exécution du 2026-10-22 : aucune ne va à l’utilisateur');
const REAL = [
  { label: 'pause 1 « découper » (liste de tests trop longue)', limit: 'items', said: 'découper',
    input: { itemsDone: 15, itemsMax: 15, itemsLeft: Array.from({ length: 9 }, (_, i) => ({ n: 16 + i, text: `comportement ${16 + i} (tests: 1)` })) } },
  { label: 'pause 2 « reprendre les items » (items mis de côté)', limit: 'items_blocked', said: 'reprendre les items',
    input: { aside: [{ group: 5, limit: 'review', reason: 'la relecture trouve encore des défauts', why: 'défaut de relecture' }, { group: 7, limit: 'review', reason: 'la relecture trouve encore des défauts', why: 'commentaire d’en-tête' }, { group: 13, limit: 'review', reason: 'la relecture trouve encore des défauts', why: 'message d’erreur' }] } },
  { label: 'pause 3 « écarter l’item » (correctif périmé)', limit: 'aside_conflict', said: 'écarter l’item', asideConflict: 7,
    input: { why: "Applied patch to 'README.md' with conflicts." } },
  { label: 'pause 4 « reprendre les items » (item 5 encore de côté)', limit: 'items_blocked', said: 'reprendre les items',
    input: { aside: [{ group: 5, limit: 'review', reason: 'la relecture trouve encore des défauts', why: 'défaut de relecture' }] } },
];
REAL.forEach((p, i) => {
  const { r } = route(p.limit, p.input, { n: i + 1, asideConflict: p.asideConflict });
  ok(r.to === 'chef', `${p.label} → chef, pas l’utilisateur`, r);
  if (r.to !== 'chef') return;
  const line = `x\n\nNEEDS_CHEF_INPUT: ${r.question}`;
  const relayed = NEEDS_CHEF_RE.exec(line)?.[1]?.trim();
  ok(relayed === r.question.trim() && !/\n/.test(r.question), `${p.label} : question sur UNE ligne, relayée entière par le serveur (regex de server.js)`, r.question);
  ok(relayed.startsWith(`[p-20261022T133600-829910 · pause ${i + 1}]`), `${p.label} : exécution et n° de pause en tête (le relais déduplique sur 100 caractères)`, relayed.slice(0, 120));
  ok(r.menu.options.some(o => o.key === p.said), `${p.label} : le choix réellement fait (« ${p.said} ») est proposé au chef`, r.menu.options.map(o => o.key));
  const dec = parseChefDecision(`[CHEF_ANSWER] ${p.said} — décision de processus\n\nReprends ta tâche en intégrant cette décision.`, { options: r.menu.options.map(o => o.key) });
  ok(dec.ok && dec.key === p.said && dec.reason === 'décision de processus', `${p.label} : la réponse relayée du chef est comprise`, dec);
});
{
  const opts = { options: ['découper', 'prolonger'] };
  ok(parseChefDecision('[CHEF_ANSWER] « découper » — trop long\n\nReprends ta tâche en intégrant cette décision.', opts).key === 'découper', 'choix entre guillemets compris');
  ok(parseChefDecision('[CHEF_ANSWER] [ANSWER] Decouper : trop long', opts).reason === 'trop long', 'sans accent, avec [ANSWER] résiduel : compris, raison isolée');
  const out = parseChefDecision('[CHEF_ANSWER] abandonner — trop long', opts);
  ok(!out.ok && /hors des choix/.test(out.why), 'option non proposée au chef (abandonner) : refusée', out);
  const back = parseChefDecision('[CHEF_ANSWER] NEEDS_USER_INPUT: faut-il garder la fonctionnalité ?', opts);
  ok(!back.ok && back.toUser && /faut-il garder/.test(back.why), 'le chef renvoie à l’utilisateur (NEEDS_USER_INPUT) : rendu à l’utilisateur', back);
}

// ---------------------------------------------------------------------------
section('3. Anti-boucle : pas de 3ᵉ reprise à l’identique ; « livrer sans eux » + demande séparée');
{
  const p4 = REAL[3];
  const first = route(p4.limit, p4.input);
  const hist = [{ sig: first.sig, key: 'reprendre les items', by: 'chef' }];
  const second = route(p4.limit, p4.input, { history: hist });
  ok(second.r.to === 'chef' && second.r.menu.options.some(o => o.key === 'reprendre les items') && !second.r.blocked.length, 'après UNE reprise : la 2ᵉ reprise reste possible');
  const third = route(p4.limit, p4.input, { history: [...hist, { sig: first.sig, key: 'reprendre les items', by: 'chef' }] });
  const keys = third.r.menu.options.map(o => o.key);
  ok(third.r.to === 'chef' && !keys.includes('reprendre les items') && third.r.blocked[0]?.key === 'reprendre les items' && third.r.blocked[0].times === 2,
    'après DEUX reprises pour les mêmes items et la même raison : plus de « reprendre les items »', third.r);
  ok(third.r.menu.recommend.key === 'livrer sans eux' && /2 fois/.test(third.r.menu.recommend.why) && /demande séparée/.test(third.r.menu.recommend.why), '« livrer sans eux » recommandé, avec la raison', third.r.menu.recommend);
  ok(third.r.suggestions.length === 1 && /item 5/.test(third.r.suggestions[0]) && /défaut de relecture/.test(third.r.suggestions[0]), 'une demande séparée ciblée sur l’item est suggérée', third.r.suggestions);
  ok(/Exclu \(anti-boucle\)/.test(third.r.question) && /Demandes séparées suggérées/.test(third.r.question), 'la question du chef dit l’exclusion et la suggestion');
  const other = route(p4.limit, { aside: [{ group: 5, limit: 'item_tests', reason: 'trop de tests', why: 'x' }] }, { history: hist.concat(hist) });
  ok(other.r.menu.options.some(o => o.key === 'reprendre les items'), 'même item mais AUTRE raison : pas la même pause, la reprise reste possible');
}

// ---------------------------------------------------------------------------
section('5a. Interrupteur : coupé par défaut, figé par exécution');
{
  ok(LEVER_IDS.includes('chefPauses'), 'levier « chefPauses » de pipeline-tuning.mjs');
  const T0 = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chefp-tuning-'));
  fs.writeFileSync(path.join(T0, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, enforcement: { tuning: { chefPauses: true } } }));
  ok(runTuning({}, path.join(T0, 'absent'), 'P').chefPauses === false, 'absent de model-routing.json : coupé');
  ok(runTuning({ tuning: { citedPathsLog: true } }, T0, 'P').chefPauses === false, 'exécution partie avec le levier coupé : reste coupée même s’il est allumé ensuite');
  const fresh = {};
  ok(runTuning(fresh, T0, 'P').chefPauses === true && fresh.tuning.chefPauses === true, 'nouvelle exécution : lu et figé dans run.json');
  fs.rmSync(T0, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('4. Bout en bout : vrai dispatch.mjs, vrai moteur, faux claude');
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push({ path: req.url, ...JSON.parse(b) }); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chef-pauses-'));
const mkProject = (name, { failing = false } = {}) => {
  const P = path.join(T, name);
  for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d), { recursive: true });
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: name.toLowerCase(), version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), `import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('base', () => { assert.equal(1, ${failing ? 2 : 1}); });\n`);
  fs.writeFileSync(path.join(P, 'test', 'pipe.test.mjs'), "import { test } from 'node:test';\ntest('pipe', () => {});\n");
  fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: failing ? 'node --test' : FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  return P;
};
fs.mkdirSync(path.join(T, 'logs'), { recursive: true });
fs.mkdirSync(path.join(T, 'chef'), { recursive: true });
const P = mkProject('P'), Q = mkProject('Q', { failing: true }), R = mkProject('R');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }, { name: 'Q', path: Q }, { name: 'R', path: R }],
}));
const routing = (tuning) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  // P and Q are NOT in service: the relayed [CHEF_ANSWER] must still find its run.
  history: [], enforcement: { projects: [], pipelines: ['discussion', 'dev'], tuning },
}));
routing({ chefPauses: ['P', 'Q'] });
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_PAUSE_MODEL_DIAG: '0' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|REQUEST_ID)$|^DISPATCH_SLOT$|^FAKE_PIPE_|^ORCH_PIPE_(ITEMS|REVIEW_ROUNDS|GREEN_ATTEMPTS|CRITERIA_ATTEMPTS)$/.test(k)) delete baseEnv[k];
const dispatch = (name, args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), name, ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 300_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const linesOf = (name) => { try { return fs.readFileSync(path.join(T, 'logs', `${name}.jsonl`), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const logOf = (name) => linesOf(name).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const go = async (name, args, env) => {
  const n0 = logOf(name).length;
  const r = await dispatch(name, args, env);
  const evs = logOf(name).slice(n0);
  return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run };
};
const lastText = (evs) => [...evs].reverse().find(e => e.type === 'result')?.result || '';
const ITEMS = { FAKE_PIPE_ITEMS: '5', ORCH_PIPE_ITEMS: '3' };
const relay = (text) => `[CHEF_ANSWER] ${text}\n\nReprends ta tâche en intégrant cette décision.`;   // exactly what server.js sends back

// 4a. A process pause (too many tests) goes to the chef.
let r = await go('P', ['Ajoute cinq multiplications', '--pipeline', 'dev', '--mode', 'complet', '--kind', 'simple'], ITEMS);
const run1 = r.run;
let st = runState(run1);
let text = lastText(r.evs);
ok(r.code === 2 && st.status === 'paused' && st.pausedLimit === 'items', `4a : en pause sur la limite d’items (code ${r.code})`, r.out.slice(-800));
ok(/NEEDS_CHEF_INPUT: \[/.test(text) && !/NEEDS_USER_INPUT\s*:/.test(text), '4a : la pause demande au CHEF (NEEDS_CHEF_INPUT), jamais à l’utilisateur', text.slice(-600));
ok(st.chefPause?.status === 'pending' && st.chefPause.options.includes('découper') && !st.chefPause.options.some(k => FORBIDDEN.includes(k)), `4a : pause de processus en attente du chef (${st.chefPause?.options?.join(', ')})`, st.chefPause);
ok(/aucune décision de votre part n’est attendue/.test(text) && /pause de processus, transmise au chef/.test(text), '4a : l’utilisateur lit une information, pas une question');
const ds = deriveState(linesOf('P'));
ok(ds.state !== 'input' && ds.awaitingChef === true, `4a : le musicien n’est pas « en attente de l’utilisateur » (état ${ds.state}, attend le chef)`, ds);
ok(!AA.collectLogWaits({ logsDir: path.join(T, 'logs'), projects: [{ name: 'P', path: P }] }).some(w => w.project === 'P'), '4a : la réponse automatique ne la voit pas (elle va au chef)');
const pv = pauseView(st), rv = runView(st);
ok(pv.byChef === true && pv.options.length === 0 && /transmise au chef/.test(pv.info) && rv.question === null, '4a : vue des exécutions (app, dashboard) : aucun bouton, une ligne d’information', pv);
ok(r.evs.some(e => e.subtype === 'pipeline_chef_pause'), '4a : transmission au chef tracée (system/pipeline_chef_pause)');
ok(notices.some(n => n.source === 'pipeline-chef-pause' && /\[PIPELINE — P —/.test(n.text)) && !notices.some(n => n.source === 'pipeline-limit'), '4a : le chef est prévenu comme d’une pause de processus, pas d’une limite à poser à l’utilisateur', notices.map(n => n.source));
const relayedQ = NEEDS_CHEF_RE.exec(text)?.[1] || '';
ok(relayedQ.startsWith(`[${run1} · pause 1]`) && /Réponds exactement « \[ANSWER\]/.test(relayedQ), '4a : la ligne relayée au chef nomme l’exécution et le format de réponse', relayedQ.slice(0, 200));

// 4b. The chef's answer, as relayed by the server (no --pipeline-resume): the run resumes with its effect.
r = await go('P', [relay('découper — deux tests de trop : les livrer à part garde l’exécution courte')], ITEMS);
st = runState(run1);
ok(r.run === run1 && r.code === 0 && st.status === 'done', `4b : [CHEF_ANSWER] reprend la bonne exécution et la termine (code ${r.code}, ${st.status})`, r.out.slice(-800));
ok(st.splitOff?.length === 2, '4b : l’effet de « découper » est appliqué (2 tests en demandes séparées)', st.splitOff);
const dec = r.evs.find(e => e.subtype === 'pipeline_chef_decision');
ok(dec && dec.text === '⚖ tranché par le chef : « découper » — deux tests de trop : les livrer à part garde l’exécution courte', `4b : frise : « ${dec?.text} »`, dec);
ok(st.chefPause.status === 'decided' && st.pauseAnswers?.at(-1)?.by === 'chef' && st.pauseAnswers.at(-1).key === 'découper', '4b : décision mémorisée (anti-boucle), par le chef', st.pauseAnswers);
const J = createJournal({ max: 50 });
for (const e of logOf('P')) J.push(e);
const turns = J.list();
ok(turns.some(t => t.pipeline?.chefPause) && turns.some(t => (t.pipeline?.chefDecisions || []).some(x => /tranché par le chef : « découper »/.test(x))), '4b : journal : la transmission et la décision du chef sont lisibles');
ok(turns.find(t => t.pipeline?.chefPause)?.outcome !== 'question', '4b : journal : le tour en pause n’est pas une question à l’utilisateur', turns.map(t => t.outcome));
const act = fs.readFileSync(path.join(ROOT, 'public', 'activite.js'), 'utf8');
ok(/jt-chef-decision/.test(act) && /p\.chefDecisions/.test(act), '4b : la frise du volet affiche chaque décision du chef');

// 4c. An answer outside the options offered: the pause goes to the user, with its full menu.
r = await go('P', ['Ajoute cinq multiplications encore', '--pipeline', 'dev', '--mode', 'complet', '--kind', 'simple'], ITEMS);
const run2 = r.run;
r = await go('P', [relay('je ne sais pas trop')], ITEMS);
st = runState(run2);
text = lastText(r.evs);
ok(r.code === 2 && st.status === 'paused' && st.chefPause.status === 'to-user' && /NEEDS_USER_INPUT: P en pause — répondez/.test(text), '4c : réponse du chef hors des choix → la pause revient à l’utilisateur, avec son menu complet', text.slice(-500));
ok(deriveState(linesOf('P')).state === 'input', '4c : l’utilisateur la voit alors comme une question');
r = await go('P', ['découper', '--pipeline-resume', run2], ITEMS);   // as the dashboard / app answer a pause
st = runState(run2);
ok(st.pausedLimit !== 'items' && st.splitOff?.length === 2 && st.pauseAnswers.at(-1).by === 'utilisateur' && st.pauseAnswers.at(-1).key === 'découper', '4c : la réponse de l’utilisateur la reprend avec son effet (notée « utilisateur »)', st);
if (st.status === 'paused') ok(st.chefPause?.status === 'pending' && /NEEDS_CHEF_INPUT/.test(lastText(r.evs)), `4c : la pause de processus suivante (« ${st.pausedLimit} ») repart au chef`, st.chefPause);

// 4d. « livrer sans eux » chosen by the chef after the anti-loop: the run closes, suggestions given.
{
  const run = 'p-20261022T150000-abcdef';
  fs.mkdirSync(path.join(T, 'logs', 'runs', run), { recursive: true });
  const sug = ['P — demande séparée ciblée sur l’item 5 « x » : défaut de relecture'];
  fs.writeFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), JSON.stringify({ run, project: 'P', pipeline: 'dev', mode: 'complet', status: 'paused', pausedLimit: 'items_blocked',
    delivered: [{ group: 1, commit: 'a'.repeat(40) }], aside: [{ group: 5, limit: 'review', patch: 'logs/runs/x/aside-item-5.patch', files: ['src/a.mjs'] }],
    lastPause: { n: 4, limit: 'items_blocked', sig: 'items_blocked|5:review', to: 'chef' },
    chefPause: { status: 'pending', n: 4, limit: 'items_blocked', sig: 'items_blocked|5:review', options: ['livrer sans eux'], suggestions: sug } }));
  const n0 = logOf('P').length;
  const code = await answerPausedRun({ logsDir: path.join(T, 'logs'), project: { name: 'P', path: P }, projectName: 'P', run, answer: 'livrer sans eux', promptForLog: relay('livrer sans eux — repris deux fois sans succès'), chefDecision: { key: 'livrer sans eux', reason: 'repris deux fois sans succès' } });
  const evs = logOf('P').slice(n0);
  const s = runState(run);
  const t = lastText(evs);
  ok(code === 0 && s.status === 'abandoned' && /par décision du chef/.test(t) && /Demandes séparées suggérées/.test(t) && /item 5/.test(t), '4d : « livrer sans eux » du chef : exécution close, livrés gardés, demande séparée suggérée', t.slice(0, 600));
  ok(evs.some(e => e.subtype === 'pipeline_chef_decision' && /tranché par le chef : « livrer sans eux » — repris deux fois sans succès/.test(e.text)) && s.pauseAnswers.at(-1).by === 'chef', '4d : décision tracée');
}

// 5b. A user-decision pause (tests already red) still reaches the user, lever ON.
r = await go('Q', ['Ajoute la division', '--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple']);
st = runState(r.run);
text = lastText(r.evs);
ok(r.code === 2 && st.pausedLimit === 'precondition' && /NEEDS_USER_INPUT:/.test(text) && !/NEEDS_CHEF_INPUT/.test(text) && st.chefPause == null, '5b : pause de décision utilisateur (tests déjà rouges) : posée à l’utilisateur, levier allumé', text.slice(-400));
ok(deriveState(linesOf('Q')).state === 'input', '5b : l’utilisateur la voit comme une question');

// 5c. Lever OFF (R not listed): exactly the behaviour before.
r = await go('R', ['Ajoute cinq multiplications', '--pipeline', 'dev', '--mode', 'complet', '--kind', 'simple'], ITEMS);
st = runState(r.run);
text = lastText(r.evs);
ok(r.code === 2 && /NEEDS_USER_INPUT: R en pause — répondez/.test(text) && !/NEEDS_CHEF_INPUT/.test(text) && st.chefPause === undefined && st.pauseCount === undefined && st.lastPause === undefined,
  '5c : levier coupé : la même pause est posée à l’utilisateur, comme avant, sans rien de plus dans run.json', text.slice(-300));
ok(!r.evs.some(e => e.subtype === 'pipeline_chef_pause'), '5c : levier coupé : aucune trace de transmission au chef');

srv.close();
if (!process.env.KEEP_T) { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log('T=' + T);
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
