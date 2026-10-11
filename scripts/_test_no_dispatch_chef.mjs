#!/usr/bin/env node
// ============================================================================
// scripts/_test_no_dispatch_chef.mjs — Routage: a chef's action is never sent
// to a musician, even when it was split as a task (0.71.0, ROUTAGE-PROBLEMES n° 8)
// ============================================================================
//
// User go-ahead (2026-10-11, verbatim): « 3. J'ai lu et j'accepte » (page
// correctifs-suite.html: n° 8, then 18, then 10). Problem n° 8: a task marked
// « action directe du chef, ne pas dispatcher » (the production restart) was
// dispatched as an ordinary turn to the musician orchestrateur
// (p-20261010T193435). Checks:
//   - a task the classifier model recognises as a chef action is never
//     dispatched; an allowlisted one runs as a chef action (by the code);
//   - a task marked « ne_pas_dispatcher » is never dispatched nor classified,
//     and becomes a question to the user;
//   - a chef action outside the allowlist becomes a question, nothing runs;
//   - the other tasks of the same message are dispatched normally.
// Real dispatch.mjs and engine, claude double, fake action runner.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { parseTaskClassification } from './pipeline-classify.mjs';
import { catalogSteps } from './pipeline-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nodisp-'));
for (const d of ['logs', 'chef', 'Q', 'R']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
for (const n of ['Q', 'R']) { fs.writeFileSync(path.join(T, n, 'package.json'), `{"name":"${n}","version":"1.0.0"}\n`); spawnSync('git', ['init', '-q'], { cwd: path.join(T, n) }); }
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'Q', 'R'].map(n => ({ name: n, path: path.join(T, n) })),
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
const RUNS = path.join(T, 'runner-calls.ndjson');
const RUNNER = path.join(T, 'fake-runner.mjs');
fs.writeFileSync(RUNNER, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(RUNS)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
const calls = () => { try { return fs.readFileSync(RUNS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_CHEF_ACTION_RUNNER: RUNNER };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
let turnNo = 0;
async function chefTurn(text, json, map) {
  const dump = path.join(T, `prompts-${++turnNo}.ndjson`);
  const n0 = logOf('chef').length, c0 = calls().length;
  const q0 = { Q: logOf('Q').length, R: logOf('R').length };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', text, '--test', 'n8-ne-pas-dispatcher'],
    { env: { ...baseEnv, FAKE_PIPE_JSON: JSON.stringify(json), FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify(map || {}), FAKE_CLAUDE_DUMP_PROMPT: dump }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  // Let any launched musician turn write its prompt, then finish.
  for (let i = 0; i < 40 && ['Q', 'R'].some(n => fs.existsSync(path.join(T, 'logs', `${n}.pid`))); i++) await sleep(500);
  await sleep(500);
  const evs = logOf('chef').slice(n0);
  const run = evs.find(e => e.type === 'user_prompt')?.pipeline?.run;
  const art = run ? path.join(T, 'chef', '.orchestrateur', 'runs', run) : null;
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(art, f), 'utf8')); } catch { return null; } };
  let prompts = []; try { prompts = fs.readFileSync(dump, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).prompt); } catch {}
  const musicianPrompts = ['Q', 'R'].flatMap(n => logOf(n).slice(q0[n]).filter(e => e.type === 'user_prompt').map(e => `${n}: ${e.text}`));
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, read, calls: calls().slice(c0), musicianPrompts,
    classify: prompts.filter(p => /^\[CLASSIFY\] ROUTING TASK/.test(p)), result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const TASKS = (extra) => ({ comprendre: { nature: 'taches', sens: 'travail et action du chef', raison: 'x' }, decomposer: { taches: [{ projet: 'R', demande: 'Ajoute une fonction double(x) au projet R, avec son test.' }, extra] } });
const DEV = { 'double(x)': { pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'fonction à ajouter' } };

// ---------------------------------------------------------------------------
section('1. Le classement par tâche peut dire « action du chef » ; Découper connaît « ne_pas_dispatcher »');
ok(parseTaskClassification('{"chef":"restart-orchestrateur","raison":"redémarrage"}')?.chef === 'restart-orchestrateur', 'réponse « chef » du model reconnue');
const dec = catalogSteps('routage').find(s => s.id === 'decomposer');
ok(/ne_pas_dispatcher/.test(dec.role) && /ne_pas_dispatcher/.test(dec.jsonExample), 'Découper : « ne_pas_dispatcher » expliqué et dans le format');

// ---------------------------------------------------------------------------
section('2. Une tâche reconnue « action du chef » (liste blanche) n’est JAMAIS dispatchée : elle est faite par le code');
let x = await chefTurn('Ajoute double() à R, puis redémarre la prod', TASKS({ projet: 'Q', demande: 'Redémarre le serveur de la prod (action directe du chef, ne pas dispatcher).' }),
  { ...DEV, 'Redémarre le serveur': { chef: 'restart-orchestrateur', raison: 'redémarrage par le chef' } });
const cls = x.read('classement.json');
ok(x.code === 0 && cls?.taches?.[1]?.chefAction === 'restart-orchestrateur' && cls.taches[1].route === false, `tâche 2 : action du chef (${JSON.stringify(cls?.taches?.[1] && { a: cls.taches[1].chefAction, r: cls.taches[1].route })})`, x.out.slice(-600));
ok(!x.musicianPrompts.some(p => /Redémarre/.test(p)), 'aucun musicien ne reçoit le redémarrage (ni Q, ni R)', x.musicianPrompts.join(' | '));
ok(x.musicianPrompts.some(p => /^R: .*double/.test(p)), 'la vraie tâche du même message part normalement chez R', x.musicianPrompts.join(' | '));
ok(x.calls.map(c => c[0]).join() === 'restart-orchestrateur' && x.read('dispatch.json')?.actions?.[0]?.status === 'scheduled', 'le redémarrage est programmé par le code, comme une action du chef');

x = await chefTurn('Ajoute double() à R, PUIS redémarre la prod', TASKS({ projet: 'Q', demande: 'Redémarre le serveur de la prod quand R aura fini.', apres: 1 }),
  { ...DEV, 'Redémarre le serveur': { chef: 'restart-orchestrateur', raison: 'redémarrage par le chef' } });
ok(x.calls.length === 0 && !x.musicianPrompts.some(p => /Redémarre/.test(p)) && /NEEDS_USER_INPUT: .*doit attendre la fin de la tâche 1/.test(x.result), 'action du chef qui doit attendre une tâche (« puis ») : ni exécutée tout de suite (elle couperait le tour de R), ni dispatchée — question', x.result.slice(-400));

// ---------------------------------------------------------------------------
section('3. kill-stalled reconnu sur une tâche : exécuté par le code avec le projet de la tâche');
x = await chefTurn('Arrête le tour bloqué de Q et ajoute double() à R', TASKS({ projet: 'Q', demande: 'Arrête le tour bloqué de Q.' }),
  { ...DEV, 'tour bloqué': { chef: 'kill-stalled', raison: 'tour bloqué depuis 2 h' } });
ok(x.calls.length === 1 && x.calls[0].slice(0, 4).join(' ') === 'kill-stalled Q --by chef' && !x.musicianPrompts.some(p => /^Q:/.test(p)), `kill-stalled Q par le code, aucun tour chez Q (${JSON.stringify(x.calls)})`);

// ---------------------------------------------------------------------------
section('4. Tâche marquée « ne_pas_dispatcher » : jamais dispatchée, pas classée, question à l’utilisateur');
x = await chefTurn('Ajoute double() à R ; et pour Q, la chose dont on a parlé', TASKS({ projet: 'Q', demande: 'Faire sur Q la chose dont on a parlé.', ne_pas_dispatcher: true }), DEV);
ok(x.code === 0 && x.classify.length === 1 && x.classify[0].includes('double(x)'), `seule la vraie tâche est classée (${x.classify.length} appel(s))`);
ok(!x.musicianPrompts.some(p => /^Q:/.test(p)) && x.musicianPrompts.some(p => /^R:/.test(p)), 'rien chez Q, R part normalement', x.musicianPrompts.join(' | '));
ok(/NEEDS_USER_INPUT: .*Tâche 2 \(Q\) marquée « ne pas dispatcher »/.test(x.result) && x.calls.length === 0, 'la question part à l’utilisateur, aucune action exécutée', x.result.slice(-400));

// ---------------------------------------------------------------------------
section('5. Action du chef hors liste blanche : question, rien d’exécuté, rien dispatché');
x = await chefTurn('Ajoute double() à R, et supprime les journaux de Q', TASKS({ projet: 'Q', demande: 'Supprime tous les journaux de Q.' }),
  { ...DEV, 'journaux': { chef: 'autre', raison: 'action de supervision' } });
ok(x.calls.length === 0 && !x.musicianPrompts.some(p => /^Q:/.test(p)) && /NEEDS_USER_INPUT: .*Tâche 2 \(Q\) : c’est une action du chef \(« autre »\)/.test(x.result), 'aucune exécution, aucun tour chez Q, question posée', x.result.slice(-400));

// ---------------------------------------------------------------------------
section('6. Garde-fou du Dispatcher : une tâche marquée ne part pas, quoi qu’en dise le classement');
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'pipeline-engine.mjs'), 'utf8');
ok(/if \(t\.route === false \|\| t\.ne_pas_dispatcher \|\| t\.chefAction \|\| t\.noDispatch\) return;/.test(src), 'le Dispatcher saute toute tâche « ne_pas_dispatcher » ou « action du chef »');

for (let i = 0; i < 40 && ['Q', 'R'].some(n => fs.existsSync(path.join(T, 'logs', `${n}.pid`))); i++) await sleep(500);
fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
