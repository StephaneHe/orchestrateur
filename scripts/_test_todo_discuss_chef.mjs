#!/usr/bin/env node
// ============================================================================
// scripts/_test_todo_discuss_chef.mjs — a TODO item sent to the chef to DISCUSS
// it, never to launch it (0.96.0)
// ============================================================================
//
// User, verbatim (2026-10-14): « Orchestrateur-dev: liste des todo, on devrait
// pouvoir envoyer au chef, pas pour lancer mais en discuter, si j'ai besoin de
// reponse. »
//
// Protected:
//   1. the explicit prefix /chef-discussion is recognised only as the first
//      word of the message (never inside it, never /chef-discussionX);
//   2. the chef's Routage has a `discussion` mode WITHOUT any launching step
//      (no Decomposer, Classifier, Affecter, Dispatcher);
//   3. end to end, a real chef turn of a message with the prefix — chef routed
//      or not: Lire → Discuter → Rapporter, the answer lands in the chef's log
//      (the usual thread), and NOTHING is dispatched: no dispatch.json, no
//      musician turn, no queue entry, no waiting Routage task; a « TODO: »
//      line quoted from the item is not captured;
//   4. the same message without the prefix still goes through the usual
//      Routage (demande mode): the existing « Envoyer au chef… » is unchanged;
//   5. the dashboard: the TODO panel offers « 💬 Discuter avec le chef… »
//      next to the unchanged « Envoyer au chef… », and its message starts
//      with the same prefix as the server's (browser check todo-discuss-chef).
//
//   node scripts/_test_todo_discuss_chef.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import * as RP from './routage-pending.mjs';
import { catalogOf, catalogSteps } from './pipeline-catalog.mjs';
import { chefDiscussion, CHEF_DISCUSSION_PREFIX } from './chef-discussion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Le préfixe explicite /chef-discussion');
{
  ok(chefDiscussion('/chef-discussion\nItem à discuter').on && chefDiscussion('/chef-discussion\nItem à discuter').text === 'Item à discuter', 'en tête du message : reconnu, retiré du texte');
  ok(chefDiscussion('  /Chef-Discussion   Question ?').on, 'casse et espaces tolérés');
  ok(!chefDiscussion('Bonjour /chef-discussion').on, 'au milieu du message : ignoré');
  ok(!chefDiscussion('/chef-discussionX truc').on && !chefDiscussion('/chef-discussion-bis truc').on, 'un autre mot qui commence pareil : ignoré');
  ok(!chefDiscussion('Item de la TODO à exécuter').on, 'message ordinaire : ignoré');
  ok(CHEF_DISCUSSION_PREFIX === '/chef-discussion', 'préfixe exporté');
}

// ---------------------------------------------------------------------------
section('2. Le mode « discussion » du Routage n’a aucune étape de lancement');
{
  const modes = catalogOf('routage').modes;
  ok(Array.isArray(modes.discussion) && modes.discussion.join() === 'lire,discuter,rapporter', `étapes : ${modes.discussion}`);
  ok(!modes.discussion.some(id => ['decomposer', 'classifier', 'affecter', 'dispatcher', 'relancer'].includes(id)), 'ni Découper, ni Classer, ni Affecter, ni Dispatcher, ni Relancer');
  const st = catalogSteps('routage').find(s => s.id === 'discuter');
  ok(st && st.kind === 'judge' && /ne lances RIEN/.test(st.role) && /aucun dispatch/.test(st.role), 'étape Discuter : jugement seul, consigne « tu ne lances rien »');
}

// ---------------------------------------------------------------------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-discuss-'));
const LOGS = path.join(T, 'logs');
for (const d of ['logs', 'chef', 'Q']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'Q'].map(n => ({ name: n, path: path.join(T, n) })),
}));
const routing = (chef) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [],
  enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1',
  // If anything tried to decompose this message, it would dispatch to Q.
  FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'travail sur Q', raison: 'x' },
    decomposer: { taches: [{ projet: 'Q', titre: 'Q : glisser-déposer', demande: 'Q — implémenter le glisser-déposer.' }] } }),
  FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify({ 'glisser-déposer': { pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'r' } }) };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(LOGS, `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
function chefTurn(text) {
  const n0 = logOf('chef').length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', text, '--test', 'todo-discuss'],
    { env: baseEnv, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const evs = logOf('chef').slice(n0);
  const up = evs.find(e => e.type === 'user_prompt' && e.pipeline);
  const run = up?.pipeline?.run;
  const art = run ? path.join(T, 'chef', '.orchestrateur', 'runs', run) : null;
  const st = run ? JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', run, 'run.json'), 'utf8')) : null;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, up, run, art, st, steps: (st?.steps || []).map(s => `${s.id}:${s.status}`).join(' '),
    result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const nothingLaunched = (x) => {
  const why = [];
  if (x.art && fs.existsSync(path.join(x.art, 'dispatch.json'))) why.push('dispatch.json écrit');
  if (logOf('Q').length) why.push('le musicien Q a un tour');
  if (fs.existsSync(path.join(LOGS, 'queue')) && fs.readdirSync(path.join(LOGS, 'queue')).length) why.push('file non vide');
  if (RP.readPending(LOGS).length) why.push('tâche du Routage en attente');
  if (x.evs.some(e => e.type === 'system' && /^(chef_action|chef_handoff|pipeline_hors_pipeline)$/.test(e.subtype || ''))) why.push('action ou renvoi du chef');
  return why;
};
const ITEM = '/chef-discussion\n\nItem de la TODO de Q à DISCUTER (ne pas le lancer) : glisser-déposer\n\nTODO: une ligne citée de l’item, jamais capturée\n\nMa question / ce dont je veux discuter : faut-il le faire maintenant ?';

for (const [label, chef] of [['chef routé', true], ['chef NON routé (enforcement.chef false)', false]]) {
  section(`3. Bout en bout, ${label} : discussion, réponse dans le fil, rien de lancé`);
  routing(chef);
  const x = chefTurn(ITEM);
  ok(x.code === 0 && x.up?.pipeline?.mode === 'discussion', `exécution du Routage en mode discussion (${x.up?.pipeline?.mode || 'aucune'})`, x.out.slice(-900));
  ok(x.steps === 'lire:ok discuter:ok rapporter:ok', `étapes : ${x.steps}`);
  ok(x.result && x.evs.some(e => e.type === 'assistant'), 'la réponse du chef est dans son log (le fil habituel)', x.result.slice(0, 300));
  const why = nothingLaunched(x);
  ok(!why.length, 'aucun dispatch : ni dispatch.json, ni tour de musicien, ni file, ni tâche en attente', why.join(', '));
  ok(!x.evs.some(e => e.type === 'system' && e.subtype === 'todo_capture'), 'la ligne « TODO: » citée n’est pas capturée');
  ok(!/\/chef-discussion/.test(x.up?.text || '') && /faut-il le faire maintenant/.test(x.up?.text || ''), 'le préfixe est retiré du texte, la question reste');
}

section('4. Sans le préfixe : le Routage habituel (« Envoyer au chef… » inchangé)');
routing(true);
const y = chefTurn('Item de la TODO de Q à exécuter : glisser-déposer');
ok(y.up?.pipeline?.mode === 'demande' && /decomposer:ok/.test(y.steps) && /dispatcher:ok/.test(y.steps), `mode demande, avec Découper et Dispatcher (${y.steps})`, y.out.slice(-600));
ok(y.art && fs.existsSync(path.join(y.art, 'dispatch.json')), 'là, le Dispatcher a bien tourné (dispatch.json) : le témoin est sensible');

// ---------------------------------------------------------------------------
section('5. Le dashboard : action « 💬 Discuter avec le chef… » à côté de « Envoyer au chef… »');
{
  const P = fs.readFileSync(path.join(ROOT, 'public', 'todo-panel.js'), 'utf8');
  ok(/id: "discuss-chef", label: "💬 Discuter avec le chef…"/.test(P), 'action discuss-chef enregistrée');
  ok(/id: "send-chef", label: "Envoyer au chef…"/.test(P), 'l’action de lancement reste, distincte');
  ok(P.includes(`const DISCUSS_PREFIX = "${CHEF_DISCUSSION_PREFIX}"`), 'le panneau écrit le même préfixe que celui que reconnaît le serveur');
  const R = fs.readFileSync(path.join(ROOT, 'scripts', '_regression_browser.mjs'), 'utf8');
  ok(/check\(B, 'todo-discuss-chef'/.test(R), 'parcours navigateur todo-discuss-chef présent');
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
