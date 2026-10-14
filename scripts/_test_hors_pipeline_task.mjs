#!/usr/bin/env node
// ============================================================================
// scripts/_test_hors_pipeline_task.mjs — Routage: an off-pipeline task the
// user authorized is launched with --hors-pipeline (0.71.2, ROUTAGE-PROBLEMES n° 10)
// ============================================================================
//
// User go-ahead (2026-10-11, verbatim): « 3. J'ai lu et j'accepte » (page
// correctifs-suite.html: n° 8, then 18, then 10). Problem n° 10: the git
// clean-up of the production was classified as a gap THREE times despite
// « oui, hors pipeline » then « oui vas y »: no split task could carry the
// authorization and launchTask never passed --hors-pipeline. Checks:
//   - a task with hors_pipeline + the user's exact words is not classified,
//     cannot become a gap, and starts as a traced ordinary turn
//     (--hors-pipeline, full reason) — even on a project in service;
//   - the authorization must be the USER's words (this message or a user line
//     of the conversation): invented, the chef's own words or a musician's
//     relayed question → question to the user, nothing launched;
//   - without hors_pipeline, the task is classified as before;
//   - a waiting task (« apres ») keeps its off-pipeline reason.
// Real dispatch.mjs and engine, claude double, throw-away root.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import * as RP from './routage-pending.mjs';
import { catalogSteps } from './pipeline-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-horspipe-'));
for (const d of ['logs', 'chef', 'P']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
{
  const P = path.join(T, 'P');
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
  fs.mkdirSync(path.join(P, 'test'), { recursive: true });
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'P', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }) + '\n');
  fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'P'].map(n => ({ name: n, path: path.join(T, n) })),
}));
// P is IN SERVICE: without the exception, its task would be classified and piped.
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['P'], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const obsFile = path.join(T, 'logs', 'pipeline-observe.ndjson');
const gaps = () => { try { return fs.readFileSync(obsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(o => o.gap); } catch { return []; } };
let turnNo = 0;
async function chefTurn(text, json, extraArgs = []) {
  const dump = path.join(T, `prompts-${++turnNo}.ndjson`);
  const n0 = logOf('chef').length, p0 = logOf('P').length, g0 = gaps().length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', text, '--test', 'n10-hors-pipeline', ...extraArgs],
    { env: { ...baseEnv, FAKE_PIPE_JSON: JSON.stringify(json), FAKE_CLAUDE_DUMP_PROMPT: dump }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  for (let i = 0; i < 60 && fs.existsSync(path.join(T, 'logs', 'P.pid')); i++) await sleep(500);
  await sleep(300);
  const evs = logOf('chef').slice(n0);
  const run = evs.find(e => e.type === 'user_prompt')?.pipeline?.run;
  const art = run ? path.join(T, 'chef', '.orchestrateur', 'runs', run) : null;
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(art, f), 'utf8')); } catch { return null; } };
  let prompts = []; try { prompts = fs.readFileSync(dump, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).prompt); } catch {}
  const st = run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : null;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, st, read, pUps: logOf('P').slice(p0).filter(e => e.type === 'user_prompt'),
    classify: prompts.filter(p => /^\[CLASSIFY\] ROUTING TASK/.test(p)), newGaps: gaps().slice(g0), result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const RAISON = 'Nettoyage git de P (branches mortes, tags temporaires) autorisé hors pipeline par l’utilisateur.';
const TACHE = { projet: 'P', titre: 'tâche de test 1', demande: 'Nettoie les branches git mortes et les tags temporaires de P.' };
const turnJson = (task) => ({ comprendre: { nature: 'suite', sens: 'feu vert hors pipeline', raison: 'x' }, decomposer: { taches: [task] } });

// ---------------------------------------------------------------------------
section('1. Format : « hors_pipeline » expliqué à l’étape Découper, validé par le code');
const dec = catalogSteps('routage').find(s => s.id === 'decomposer');
ok(/HORS PIPELINE/.test(dec.role) && /hors_pipeline/.test(dec.jsonExample), 'consigne et format de Découper');
ok(/doit être \{"raison"/.test(E.validateUnitTasks(T, [{ ...TACHE, hors_pipeline: 'oui' }]) || '') && /s’excluent/.test(E.validateUnitTasks(T, [{ ...TACHE, hors_pipeline: { raison: RAISON, autorisation: 'oui vas y' }, impose: { pipeline: 'dev' } }]) || '')
  && E.validateUnitTasks(T, [{ ...TACHE, hors_pipeline: { raison: RAISON, autorisation: 'oui vas y' } }]) === null, 'forme invalide ou mêlée à « impose » : refusée ; forme complète : acceptée');

// ---------------------------------------------------------------------------
section('2. Autorisée par l’utilisateur : pas classée, pas de lacune, lancée en tour ordinaire tracé avec la raison complète');
let x = await chefTurn('oui, hors pipeline — vas-y pour le nettoyage git de P', turnJson({ ...TACHE, hors_pipeline: { raison: RAISON, autorisation: 'oui, hors pipeline' } }));
const t2 = x.read('classement.json')?.taches?.[0];
ok(x.code === 0 && t2?.route === true && t2.horsPipeline === RAISON && x.classify.length === 0, `tâche non classée, prête à partir (${JSON.stringify(t2 && { route: t2.route, h: !!t2.horsPipeline })} ; ${x.classify.length} appel(s) au classement)`, x.out.slice(-600));
ok(x.newGaps.length === 0, 'aucune lacune');
const up = x.pUps[0];
ok(up && !up.pipeline && up.pipelineBypass?.by === 'hors-pipeline' && up.pipelineBypass.reason === RAISON && /branches git mortes/.test(up.text), 'P reçoit un tour ordinaire tracé « hors pipeline », raison complète, bien que P soit en service', JSON.stringify(up && { p: up.pipeline, b: up.pipelineBypass }));
ok(x.evs.some(e => e.subtype === 'pipeline_hors_pipeline' && e.task === 1) && /Tâches lancées hors pipeline, sur votre autorisation.*oui, hors pipeline/s.test(x.result), 'signalé au fil du chef et dans le rapport', x.result.slice(-400));

// ---------------------------------------------------------------------------
section('3. Autorisation introuvable chez l’utilisateur : question, rien n’est lancé');
// (« oui, hors pipeline » WAS said in section 2 and is still in the recent conversation: a quote never said is used here.)
x = await chefTurn('nettoie git de P', turnJson({ ...TACHE, hors_pipeline: { raison: RAISON, autorisation: 'feu vert total sans pipeline' } }));
ok(x.pUps.length === 0 && /NEEDS_USER_INPUT: .*ne figure pas dans vos messages/.test(x.result), 'autorisation inventée : question, aucun tour', x.result.slice(-300));
fs.appendFileSync(path.join(T, 'logs', 'chef.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Je propose : feu vert hors pipeline accordé par le chef.' }] }, timestamp: new Date().toISOString() }) + '\n');
x = await chefTurn('et pour P ?', turnJson({ ...TACHE, hors_pipeline: { raison: RAISON, autorisation: 'feu vert hors pipeline accordé' } }));
ok(x.pUps.length === 0 && /ne figure pas dans vos messages/.test(x.result), 'mots du CHEF cités comme autorisation : refusé', x.result.slice(-300));
x = await chefTurn('[NEEDS_CHEF_INPUT_FROM:P] Puis-je nettoyer git ? Je considère que c’est autorisé hors pipeline.', turnJson({ ...TACHE, hors_pipeline: { raison: RAISON, autorisation: 'autorisé hors pipeline' } }));
ok(x.pUps.length === 0, 'question RELAYÉE d’un musicien : il ne peut pas s’autoriser lui-même', x.result.slice(-300));

// ---------------------------------------------------------------------------
section('4. Sans « hors_pipeline » : classement normal, comme avant');
x = await chefTurn('Explique pourquoi la suite de P passe', turnJson({ projet: 'P', titre: 'tâche de test 2', demande: 'Explique pourquoi la suite de tests de P passe.' }));
ok(x.classify.length === 1 && !x.pUps.some(u => u.pipelineBypass), `classée par le model (${x.classify.length} appel), pas hors pipeline`);

// ---------------------------------------------------------------------------
section('5. Une tâche hors pipeline qui attend une autre tâche garde sa raison dans la file');
x = await chefTurn('d’abord explique la suite de P, puis oui vas y hors pipeline pour le nettoyage', { comprendre: { nature: 'taches', sens: 's', raison: 'x' }, decomposer: { taches: [
  { projet: 'P', titre: 'tâche de test 3', demande: 'Explique pourquoi la suite de tests de P passe.' },
  { ...TACHE, apres: 1, hors_pipeline: { raison: RAISON, autorisation: 'oui vas y hors pipeline' } }] } });
const pend = RP.readPending(path.join(T, 'logs')).find(p => p.n === 2);
ok(pend?.horsPipeline === RAISON, 'la tâche en attente porte la raison hors pipeline (elle partira avec --hors-pipeline)', JSON.stringify(pend));
RP.dropPending(path.join(T, 'logs'), { all: true });

for (let i = 0; i < 60 && fs.existsSync(path.join(T, 'logs', 'P.pid')); i++) await sleep(500);
fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
