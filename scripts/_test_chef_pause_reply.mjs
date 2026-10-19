#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_pause_reply.mjs — an answer to a paused Routage run of the
// chef reaches it; a paused run can be closed by command (Routage v3, phase 0 b)
// ============================================================================
//
// User decision (2026-10-19, docs/ROUTAGE-SYNTHESE.md §3.9, phase 0 b): « Une
// réponse à une pause du chef lui parvient enfin […] Ajoute une commande pour
// clore proprement une exécution en pause ».
//
// Real production case replayed: the chef's Routage p-20261014T044705-556920
// paused at its first step (« lecture », refused twice: OAuth expired). Every
// later « continuer » / « abandonner » started a NEW Routage run
// (dispatch.mjs left on the Routage branch before reading pause answers), so
// the run stayed paused for good (4 such dead pauses in production).
//
// Protected (real dispatch.mjs + engine, fake claude, chef folder without git):
//   1. « continuer » resumes the chef's paused run (no new run) and finishes it;
//   2. « abandonner » closes it, no new run, and says nothing false about git;
//   3. a newer Routage run supersedes an older pause: « continuer » is then a
//      new request; « continuer <id> » (the run cited) still reaches it;
//   4. --pipeline-resume <run> "abandonner" closes the chef's run;
//   5. scripts/close-run.mjs: closes a paused run (status abandoned, question
//      acknowledged, no result event), refuses a live run, says « déjà
//      terminée » the second time.
//
//   node scripts/_test_chef_pause_reply.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chef-pause-'));
const LOGS = path.join(T, 'logs');
for (const d of ['logs/runs', 'chef', 'P']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'P'].map(n => ({ name: n, path: path.join(T, n) })),
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [],
  enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_PIPE_CRITERIA_ATTEMPTS: '2' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|TURN_ID)$|^DISPATCH_(SLOT|TICKET|REPORT_ONLY)$|^FAKE_PIPE_|^FAKE_CLAUDE_CLASSIFY|^CODEX_HOME$/.test(k)) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(LOGS, `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', run, 'run.json'), 'utf8'));
const runsOfChef = () => fs.readdirSync(path.join(LOGS, 'runs')).filter(r => E.RUN_RE.test(r)).filter(r => runState(r).project === 'chef').sort();
const ANSWER = JSON.stringify({ comprendre: { sens: 'sens simulé', nature: 'reponse', raison: 'question simple' } });
function chefTurn(text, env = {}, extra = []) {
  const n0 = logOf('chef').length, r0 = runsOfChef();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', text, '--test', 'chef-pause-reply', ...extra],
    { env: { ...baseEnv, FAKE_PIPE_JSON: ANSWER, ...env }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const evs = logOf('chef').slice(n0);
  const up = evs.find(e => e.type === 'user_prompt');
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, up, run: up?.pipeline?.run, newRuns: runsOfChef().filter(x => !r0.includes(x)), result: evs.filter(e => e.type === 'result').pop() };
}
// The real failure paused the reading step on « criteria » after two refused
// tries; here the step Comprendre is refused twice (its JSON is broken): same pause.
const pauseChef = (text = 'Pourquoi le projet P a-t-il un seul commit ?') => {
  const x = chefTurn(text, { FAKE_PIPE_BAD: 'comprendre:99' });
  return { ...x, st: x.run ? runState(x.run) : null };
};
const closeRun = (args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'close-run.mjs'), ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

try {
  // -------------------------------------------------------------------------
  section('1. Rejeu de p-20261014T044705-556920 : « continuer » atteint l’exécution en pause du chef');
  const p1 = pauseChef();
  ok(p1.code === 2 && p1.st?.status === 'paused' && p1.st.plan[p1.st.index] === 'comprendre', `Routage du chef en pause (étape Comprendre refusée deux fois, comme la lecture en prod) (code ${p1.code}, ${p1.st?.status}, ${p1.st?.pausedLimit})`, p1.out.slice(-700));
  let x = chefTurn('continuer');
  ok(x.newRuns.length === 0, `aucune nouvelle exécution du Routage (${x.newRuns.join(', ') || 'aucune'})`, x.out.slice(-700));
  ok(x.run === p1.run && x.up?.pipeline?.resumed === true, `le tour reprend ${p1.run} (user_prompt.pipeline.run=${x.run}, resumed=${x.up?.pipeline?.resumed})`);
  ok(x.code === 0 && runState(p1.run).status === 'done', `l’exécution reprise se termine (code ${x.code}, ${runState(p1.run).status})`, x.out.slice(-700));

  // -------------------------------------------------------------------------
  section('2. « abandonner » clôt l’exécution du chef, sans nouvelle exécution ni fausse affirmation sur git');
  const p2 = pauseChef();
  x = chefTurn('abandonner');
  ok(x.newRuns.length === 0 && runState(p2.run).status === 'abandoned', `close (${runState(p2.run).status}), aucune nouvelle exécution`, x.out.slice(-700));
  ok(x.result && /arrêtée/.test(x.result.result || '') && !/Aucune modification n’est restée/.test(x.result.result || '') && /pas suivi par git/.test(x.result.result || ''),
    `message de clôture juste pour un dossier hors git (le chef) : « ${(x.result?.result || '').slice(0, 260)} »`);

  // -------------------------------------------------------------------------
  section('3. Une exécution plus récente du chef remplace une ancienne pause ; une citation explicite l’atteint encore');
  const p3 = pauseChef();
  const done = chefTurn('Une autre question, sans rapport');
  ok(done.newRuns.length === 1 && runState(done.newRuns[0]).status === 'done', 'nouvelle demande : nouveau Routage, terminé');
  x = chefTurn('continuer');
  ok(x.newRuns.length === 1 && runState(p3.run).status === 'paused', '« continuer » après une exécution plus récente : nouvelle demande, l’ancienne pause n’est pas reprise en devinant');
  x = chefTurn(`abandonner ${p3.run}`);
  ok(x.newRuns.length === 0 && runState(p3.run).status === 'abandoned', `« abandonner ${p3.run} » (citée avec la réponse) : close`, x.out.slice(-700));

  // A request that merely starts with a menu word is routed, never taken as an answer
  // (_test_chef_actions: « Arrête le tour de Q… » is a chef action).
  const p3b = pauseChef();
  x = chefTurn('Arrête le tour de P et relance le serveur');
  ok(x.newRuns.length === 1 && runState(p3b.run).status === 'paused', '« Arrête le tour de P… » : une demande routée (nouvelle exécution), la pause n’est pas close');
  x = chefTurn('abandonner');
  ok(x.newRuns.length === 1 && runState(p3b.run).status === 'paused', '« abandonner » seul après une exécution plus récente : rien n’est clos en devinant');

  // -------------------------------------------------------------------------
  section('4. --pipeline-resume <exécution> "abandonner" vers le chef');
  const p4 = pauseChef();
  x = chefTurn('abandonner', {}, ['--pipeline-resume', p4.run]);
  ok(x.newRuns.length === 0 && runState(p4.run).status === 'abandoned', `close (${runState(p4.run).status})`, x.out.slice(-700));

  // -------------------------------------------------------------------------
  section('5. scripts/close-run.mjs : clore une exécution en pause par commande');
  const p5 = pauseChef();
  const n0 = logOf('chef').length;
  let c = closeRun([p5.run, '--reason', 'pause morte (OAuth expirée)', '--by', 'utilisateur']);
  const st5 = runState(p5.run);
  const evs = logOf('chef').slice(n0);
  ok(c.code === 0 && st5.status === 'abandoned' && st5.abandonedBy === 'commande' && st5.closed?.reason === 'pause morte (OAuth expirée)', `close : statut relu ${st5.status} (code ${c.code})`, c.out);
  ok(evs.some(e => e.type === 'notification' && e.subtype === 'question_resolved' && e.run === p5.run) && evs.some(e => e.subtype === 'pipeline_summary' && e.pipeline?.status === 'abandoned'), 'question de la pause acquittée et résumé « abandoned » dans le log du chef');
  ok(!evs.some(e => e.type === 'result'), 'aucun événement result (ni drain de file, ni réveil du chef)');
  ok(/✓/.test(c.out) && /abandoned/.test(c.out), `message clair : ${c.out.trim().split('\n').pop()}`);
  c = closeRun([p5.run]);
  ok(c.code === 2 && /déjà terminée/.test(c.out), `seconde fois : « déjà terminée » (code ${c.code})`);
  // A live run is never closed under its process.
  const p6 = pauseChef();
  const s6 = runState(p6.run); s6.status = 'running'; s6.pid = process.pid;
  fs.writeFileSync(path.join(LOGS, 'runs', p6.run, 'run.json'), JSON.stringify(s6));
  c = closeRun([p6.run]);
  ok(c.code === 3 && runState(p6.run).status === 'running', `exécution vivante : refus (code ${c.code}), rien touché`, c.out);
  // An orphaned run (status running, process dead) is paused, then closed.
  s6.pid = 999999; fs.writeFileSync(path.join(LOGS, 'runs', p6.run, 'run.json'), JSON.stringify(s6));
  c = closeRun([p6.run]);
  ok(c.code === 0 && runState(p6.run).status === 'abandoned', `exécution orpheline : close (code ${c.code}, ${runState(p6.run).status})`, c.out);
  c = closeRun(['pas-un-id']);
  ok(c.code === 64, 'identifiant invalide : usage (64)');
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
