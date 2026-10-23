#!/usr/bin/env node
// ============================================================================
// scripts/_test_limit_pause_cause.mjs — a budget limit is never read as a
// provider outage (0.139.1)
// ============================================================================
//
// Defect seen in production on 2026-10-23 (run p-20261023T011506-ef29a5, a
// complete Development, after « prolonger »): the 15-test limit was reached;
// the next item quoted the screen text « Voix indisponible », and the provider
// detector read « indisponible » as an outage. The pause then said « Le
// fournisseur de le model a une panne passagère », offered « continuer » /
// « abandonner » (no « découper »; « continuer » loops on the same limit) and,
// the cause not being a process cause, went to the USER instead of the chef.
//
// User rule (2026-10-22), verbatim: « arrête de poser des questions de
// découpage. tu sais comment est organisé le process mieux que moi ».
//
// Protected (user requirement, never weakened without the user's agreement):
//   1. replay of the real pause: cause « too_big » (no « panne », no
//      « fournisseur »), menu with « découper », never « continuer » nor
//      « abandonner » offered to the chef, routed to the CHEF;
//   2. same for every budget limit (items, duration, review, item_tests) whose
//      reason quotes outage-like words, and for a criteria refusal quoting the
//      work between « »; a real provider error passed apart is still read;
//   3. « du model », never « de le model »;
//   4. real dispatch.mjs + engine + fake claude, lever chefPauses ON, items
//      quoting « Voix indisponible »: the pause ends with NEEDS_CHEF_INPUT, its
//      cause is the size of the work, « découper » is offered and applied.
//
//   node scripts/_test_limit_pause_cause.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnosePause, smartMenu, fixMenu, providerText, BUDGET_LIMITS, menuQuestion } from './pause-diagnosis.mjs';
import { routePause, pauseSignature } from './process-pause.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const OUTAGE = /panne|fournisseur|de le model/i;

const route = (limit, input, history = []) => {
  const d = diagnosePause({ limit, ...input });
  const menu = fixMenu(d, smartMenu(d, { step: input.step, delivered: 15 }));
  const sig = pauseSignature({ limit, kind: d.kind, step: input.step?.id, item: input.item?.n });
  return { d, menu, r: routePause({ limit, d, menu, pipeline: 'dev', lane: 0, history, sig, project: '[projet]', run: 'p-20261023T011506-ef29a5', n: 2 }) };
};

// ---------------------------------------------------------------------------
section('1. Rejeu de la pause réelle du 2026-10-23 (limite de 15 tests, après « prolonger »)');
const NEXT = '(tests: 2) Quand l\'audio de la vignette échoue (rejet de lecture autre qu\'un refus d\'autoplay, ou erreur pendant la lecture), l\'écran affiche « Voix indisponible » avec le texte de la vignette et « Répondre » utilisable ; un échec audio tardif ne coupe pas l\'écran';
const REAL = {
  step: { id: '@loop' },
  why: `la liste n'est pas vide après 15 items (suivant : « ${NEXT} ») — découper la demande`,
  itemsDone: 15, itemsMax: 15,
  itemsLeft: [{ n: 16, text: NEXT }, { n: 17, text: '(tests: 1) la vignette suivante démarre seule' }, { n: 18, text: '(tests: 1) le bouton Répondre reste actif' }],
  extra: { rounds: 15, duration: '90 min' },
};
{
  const history = [{ n: 1, limit: 'duration', sig: 'duration|criterion_strict|vert|16', key: 'prolonger', by: 'chef' }];
  const { d, menu, r } = route('items', REAL, history);
  ok(d.kind === 'too_big', `cause « too_big » (la taille du travail), pas une panne (cause « ${d.kind} »)`, d);
  ok(!OUTAGE.test(d.cause) && /15 tests sont faits/.test(d.cause), 'la cause dit la limite de 15 tests, sans « panne » ni « fournisseur »', d.cause);
  ok(!(d.evidence || []).some(e => e.source === 'fournisseur'), 'aucune preuve « fournisseur » tirée du texte de l’item', d.evidence);
  ok(menu.options.some(o => o.key === 'découper'), `« découper » est proposé (${menu.options.map(o => o.key).join(', ')})`, menu);
  ok(!menu.options.some(o => o.key === 'continuer'), '« continuer » (reboucler sur la même limite) n’est pas proposé', menu);
  ok(r.to === 'chef', `la pause va au CHEF (pause de processus), pas à l’utilisateur — ${r.why}`, r);
  if (r.to === 'chef') {
    const keys = r.menu.options.map(o => o.key);
    ok(keys.includes('découper') && !keys.includes('abandonner') && !keys.includes('continuer'), `le chef choisit parmi ${keys.join(', ')}`, keys);
    ok(/pause de PROCESSUS/.test(r.question) && !OUTAGE.test(r.question.replace(/l’utilisateur/g, '')), 'la question relayée au chef parle du processus, pas d’une panne', r.question.slice(0, 400));
  }
  ok(!OUTAGE.test(menuQuestion('[projet]', d, menu)), 'la ligne posée à défaut (levier coupé) ne parle pas non plus de panne');
}

// ---------------------------------------------------------------------------
section('2. Toute limite de budget, et le texte du travail cité, ne sont jamais une panne');
{
  const words = ['indisponible', 'unavailable', 'timeout', 'réseau', 'erreur 503', 'quota', 'rate limit', 'usage policy', 'not found'];
  for (const w of words) {
    const left = [{ n: 16, text: `(tests: 1) afficher « ${w} »` }];
    const items = diagnosePause({ limit: 'items', why: `la liste n'est pas vide après 15 items (suivant : « (tests: 1) afficher ${w} »)`, itemsDone: 15, itemsMax: 15, itemsLeft: left });
    ok(items.kind === 'too_big', `items, item citant « ${w} » → too_big (${items.kind})`, items);
    const dur = diagnosePause({ limit: 'duration', why: `durée atteinte ; prochain test : ${w}`, itemsLeft: left, extra: { duration: '90 min' } });
    ok(dur.kind === 'criterion_strict', `duration citant « ${w} » → limite de durée (${dur.kind})`, dur);
    const rev = diagnosePause({ limit: 'review', why: `la revue relève encore : message « ${w} » mal formulé ; ${w} non traité`, defects: [`message ${w}`], extra: { rounds: 3 } });
    ok(rev.kind === 'review_defects', `review citant « ${w} » → défauts de relecture (${rev.kind})`, rev);
    const crit = diagnosePause({ limit: 'criteria', step: { id: 'rouge', label: 'écrire un test' }, why: `étape refusée pour le test « afficher ${w} »` });
    ok(crit.kind !== 'provider_transient' && crit.kind !== 'limit' && crit.kind !== 'refusal' && crit.kind !== 'model_unknown', `criteria, texte du travail entre « » citant « ${w} » → pas une erreur fournisseur (${crit.kind})`, crit);
  }
  ok(BUDGET_LIMITS.join(',') === 'items,duration,review,item_tests', 'limites de budget : items, duration, review, item_tests');
  ok(providerText({ limit: 'items', why: 'x indisponible' }) === '', 'limite de budget : le motif n’est jamais lu comme erreur fournisseur');
  const real = diagnosePause({ limit: 'items', why: 'la liste n’est pas vide', providerError: 'API Error: 529 overloaded_error', itemsDone: 15, itemsLeft: [] });
  ok(real.kind === 'provider_transient', 'une vraie erreur fournisseur passée à part reste lue, même sur une limite de budget', real);
  ok(diagnosePause({ limit: 'criteria', why: "You've hit your usage limit" }).kind === 'limit', 'hors limite de budget, un message du fournisseur dans le motif reste lu (limite d’utilisation)');
  ok(diagnosePause({ limit: 'model_unavailable', why: 'API 529 overloaded', providerError: 'API 529 overloaded' }).kind === 'provider_transient', 'model indisponible (529) : toujours une panne passagère');
}

// ---------------------------------------------------------------------------
section('3. « du model », jamais « de le model »');
{
  const a = diagnosePause({ limit: 'model_unavailable', why: 'API 503 unavailable', providerError: 'API 503 unavailable' });
  const b = diagnosePause({ limit: 'criteria', why: 'API 503 unavailable', model: 'claude-x' });
  const c = diagnosePause({ limit: 'criteria', why: 'usage policy: can’t help with this' });
  for (const [l, d] of [['sans model nommé', a], ['model nommé', b], ['refus', c]]) ok(!/de le model/.test(d.cause), `${l} : « ${d.cause.slice(0, 90)} »`, d.cause);
  ok(/Le fournisseur du model claude-x a une panne passagère/.test(b.cause), 'tournure : « Le fournisseur du model claude-x … »', b.cause);
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'pause-diagnosis.mjs'), 'utf8');
  ok(!/\bde \$\{mdl\}/.test(src), 'plus aucun « de ${mdl} » dans pause-diagnosis.mjs');
}

// ---------------------------------------------------------------------------
section('4. Bout en bout : vrai dispatch.mjs, vrai moteur, faux claude, items citant « Voix indisponible »');
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push(JSON.parse(b)); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-limit-cause-'));
const P = path.join(T, 'P');
for (const d of ['test', 'src', 'docs', '.orchestrateur', 'logs', 'chef']) fs.mkdirSync(path.join(d === 'logs' || d === 'chef' ? T : P, d), { recursive: true });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('base', () => { assert.equal(1, 1); });\n");
fs.writeFileSync(path.join(P, 'test', 'pipe.test.mjs'), "import { test } from 'node:test';\ntest('pipe', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: [], pipelines: ['discussion', 'dev'], tuning: { chefPauses: ['P'] } },
}));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_PAUSE_MODEL_DIAG: '0' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|REQUEST_ID)$|^DISPATCH_SLOT$|^FAKE_PIPE_|^ORCH_PIPE_(ITEMS|REVIEW_ROUNDS|GREEN_ATTEMPTS|CRITERIA_ATTEMPTS)$/.test(k)) delete baseEnv[k];
const ENV = { FAKE_PIPE_ITEMS: '5', ORCH_PIPE_ITEMS: '3', FAKE_PIPE_ITEM_SUFFIX: ' — l’écran affiche « Voix indisponible » quand l’audio échoue (timeout réseau)' };
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const go = (args) => new Promise((resolve) => {
  const n0 = logOf().length;
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...ENV }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 300_000);
  c.on('exit', code => { clearTimeout(t); const evs = logOf().slice(n0); resolve({ code, out, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run }); });
});
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const lastText = (evs) => [...evs].reverse().find(e => e.type === 'result')?.result || '';
{
  let r = await go(['Ajoute cinq multiplications', '--pipeline', 'dev', '--mode', 'complet', '--kind', 'simple']);
  const run = r.run;
  let st = runState(run);
  const text = lastText(r.evs);
  ok(r.code === 2 && st.status === 'paused' && st.pausedLimit === 'items', `4a : en pause sur la limite d’items (code ${r.code})`, r.out.slice(-800));
  ok(/indisponible/.test(fs.readFileSync(path.join(P, '.orchestrateur', 'runs', run, 'tests.md'), 'utf8')), '4a : les items citent bien « Voix indisponible »');
  ok(st.diagnosis?.kind === 'too_big' && !OUTAGE.test(st.diagnosis.cause), `4a : cause « ${st.diagnosis?.kind} » : ${st.diagnosis?.cause}`, st.diagnosis);
  ok(/NEEDS_CHEF_INPUT: \[/.test(text) && !/NEEDS_USER_INPUT\s*:/.test(text), '4a : la pause demande au CHEF (NEEDS_CHEF_INPUT), jamais à l’utilisateur', text.slice(-600));
  ok(st.chefPause?.status === 'pending' && st.chefPause.options.includes('découper') && !st.chefPause.options.includes('continuer'), `4a : choix soumis au chef : ${st.chefPause?.options?.join(', ')}`, st.chefPause);
  ok(!/de le model|panne passagère/.test(text), '4a : ni « de le model » ni « panne passagère » dans le texte de la pause');
  r = await go([`[CHEF_ANSWER] découper — deux tests de trop\n\nReprends ta tâche en intégrant cette décision.`]);
  st = runState(run);
  ok(r.run === run && st.splitOff?.length === 2 && st.pauseAnswers?.at(-1)?.key === 'découper' && st.pauseAnswers.at(-1).by === 'chef', '4b : « découper » du chef appliqué (2 tests en demandes séparées)', { code: r.code, status: st.status, splitOff: st.splitOff, answers: st.pauseAnswers });
}
srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
