#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_handoff_failed.mjs — a refused or failed hand-off to the
// chef is posted to the chef's thread, not only to logs/chef-actions.log (0.100.2)
// ============================================================================
//
// Incident (prod, 2026-10-14): two Routage hand-offs were refused (65, P0-B)
// and only logs/chef-actions.log said so — both tasks were lost without any
// visible signal. User decision, verbatim: « 3. oui » to « Faut-il qu'un
// renvoi refusé soit signalé dans le fil, et pas seulement dans le journal ? ».
//
// Protected (real chef-action-deferred.mjs and real dispatch.mjs, fake claude):
//   1. a refused hand-off (no token → 65) appends ONE notification card to the
//      chef's log, shaped like a failed musician turn (rendered live and on
//      reload by /api/conductor-chat), naming the reference, the task title,
//      the code and the reason; logs/chef-actions.log keeps its line;
//   2. an unreadable handoff.json is posted too (reference from the run dir);
//   3. an accepted hand-off posts no failure card.
//
//   node scripts/_test_chef_handoff_failed.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const DEFERRED = path.join(ROOT, 'scripts', 'chef-action-deferred.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-handoff-failed-'));
for (const d of ['logs', 'chef']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, history: [], enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true }, assignments: {} }, null, 2));
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9',
  ORCH_NO_PENDING_RELEASE: '1', ORCH_CHEF_HANDOFF_TEST: '1', DISPATCH_SLOT: '1', DISPATCH_TICKET: 't-pool-en-vol' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ORCH_HANDOFF_TOKEN',
  'DISPATCH_REPORT_ONLY', 'DISPATCH_POOL_ASSIGN', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'ORCH_CHEF_ACTION_RUNNER']) delete env[k];
const ACTIONS = path.join(T, 'logs', 'chef-actions.log');
const chefLog = () => { try { return fs.readFileSync(path.join(T, 'logs', 'chef.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const actions = () => { try { return fs.readFileSync(ACTIONS, 'utf8'); } catch { return ''; } };
const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
const TITLE = 'clore les exécutions en pause';

function handoff(run, n, extraEnv = {}, body) {
  const file = path.join(T, 'logs', 'runs', run, 'handoff.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ref = `${run}#${n}`;
  fs.writeFileSync(file, body ?? JSON.stringify({ ref, conductor: 'chef', prompt: `[RENVOI_CHEF ${run}] Le Routage t’a renvoyé cette tâche : ${TITLE}.`,
    tasks: [{ n, titre: TITLE, projet: 'chef' }] }));
  const r = spawnSync(process.execPath, [DEFERRED, '--wait-pid', String(deadPid), '--handoff', file, '--log', ACTIONS],
    { env: { ...env, ...extraEnv }, cwd: T, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  return { r, ref };
}
const cardsFor = (ref) => chefLog().filter(e => e.type === 'notification' && e.handoff?.ref === ref);

// ---------------------------------------------------------------------------
section('1. Renvoi refusé (pas de jeton → 65) : carte visible dans le fil du chef, journal conservé');
let { r, ref } = handoff('p-20261015T100000-aaaaaa', 2);
ok(r.status === 65, `le lanceur sort avec le code du refus (exit ${r.status})`, `${r.stdout}${r.stderr}`);
let cards = cardsFor(ref);
const c = cards[0];
ok(cards.length === 1, 'une seule carte publiée dans logs/chef.jsonl', JSON.stringify(chefLog()).slice(-600));
ok(c?.subtype === 'musician_done' && c.outcome === 'failed' && c.source === 'chef' && typeof c.timestamp === 'string',
  'forme rendue par le fil (notification musician_done, outcome failed, source, horodatage)', JSON.stringify(c));
ok(c && c.text.includes(ref) && c.text.includes(`« ${TITLE} »`) && /Code 65/.test(c.text), 'le texte nomme la référence, le titre de la tâche et le code', c?.text);
ok(c && /jeton absent ou invalide/.test(c.text) && /jeton absent ou invalide/.test(c.handoff.why) && c.handoff.code === 65, 'le texte donne la raison du refus', JSON.stringify(c?.handoff));
ok(c?.handoff?.tasks?.[0]?.titre === TITLE && c.handoff.run === ref.split('#')[0], 'champs additifs : exécution et tâches renvoyées', JSON.stringify(c?.handoff));
const line = actions().split('\n').find(l => l.includes(`handoff ${ref} exited with 65: [dispatch]`));
ok(!!line && /jeton absent ou invalide/.test(line), 'logs/chef-actions.log garde la ligne « exited with 65 » et sa raison (lue par la vue Requêtes)', actions().slice(-800));
ok(actions().includes(`handoff ${ref}: failure posted to the chef thread`), 'le journal note la publication dans le fil');
ok(!chefLog().some(e => e.type === 'user_prompt'), 'aucun tour du chef n’a démarré');

// ---------------------------------------------------------------------------
section('2. Fichier de renvoi illisible : carte publiée quand même');
({ r, ref } = handoff('p-20261015T100100-bbbbbb', 3, {}, '{pas du json'));
cards = chefLog().filter(e => e.type === 'notification' && e.handoff?.run === 'p-20261015T100100-bbbbbb');
ok(r.status === 65 && cards.length === 1 && /illisible/.test(cards[0].text) && cards[0].text.includes('p-20261015T100100-bbbbbb#?'),
  `refus visible avec la référence tirée du dossier (exit ${r.status})`, JSON.stringify(cards));

// ---------------------------------------------------------------------------
section('3. Renvoi accepté (jeton valide) : aucune carte d’échec');
const run3 = 'p-20261015T100200-cccccc';
({ r, ref } = handoff(run3, 1, { ORCH_HANDOFF_TOKEN: E.handoffToken(T, `${run3}#1`) }));
ok(r.status === 0 && chefLog().some(e => e.type === 'user_prompt' && e.chefHandoff?.run === run3), `le tour renvoyé part (exit ${r.status})`, `${r.stdout}${r.stderr}`.slice(-600));
ok(cardsFor(ref).length === 0, 'aucune carte d’échec publiée');

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
