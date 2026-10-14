#!/usr/bin/env node
// ============================================================================
// scripts/_test_routage_split.mjs — Routage: understand, split, THEN classify
// each task on its own (0.69.0)
// ============================================================================
//
// User request (2026-10-10, verbatim): « Je maintiens que le routeur ne doit
// pas classer une demande entiere alors qu'elle est deja decoupee. De toutes
// facons, il faut commencer par : - le model essaie de trouver le sens global
// - si besoin decouper en taches plus petites - trouver un sens et router les
// taches ainsi trouvees une par une ».
//
// Checks: step order; a mixed message (dev + git/version work) gives two tasks
// classified SEPARATELY (one classifier call per task, each seeing only its
// task) and no gap on the whole message; a short follow-up answering an offer
// of the chef raises no gap; an ambiguous task, a failed classification or a
// message impossible to split ends as a question to the user (never a guess).
// Real dispatch.mjs and engine, claude double, throw-away root, dead notify port.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { catalogOf, catalogSteps } from './pipeline-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-split-'));
for (const d of ['logs', 'chef', 'Q', 'R']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
for (const n of ['Q', 'R']) {
  const dir = path.join(T, n);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: n, version: '1.0.0', type: 'module' }) + '\n');
  g(dir, 'init', '-q'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'Q', 'R'].map(n => ({ name: n, path: path.join(T, n) })),
}));
// Musicians are not in service: their tasks run as ordinary (fast) turns of the double.
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [],
  enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const obsFile = path.join(T, 'logs', 'pipeline-observe.ndjson');
const obs = () => { try { return fs.readFileSync(obsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
let turnNo = 0;
function chefTurn(text, env = {}) {
  const dump = path.join(T, `prompts-${++turnNo}.ndjson`);
  const n0 = logOf('chef').length, o0 = obs().length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', text, '--test', 'routage-split'],
    { env: { ...baseEnv, FAKE_CLAUDE_DUMP_PROMPT: dump, ...env }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const evs = logOf('chef').slice(n0);
  const run = evs.find(e => e.type === 'user_prompt')?.pipeline?.run;
  const art = run ? path.join(T, 'chef', '.orchestrateur', 'runs', run) : null;
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(art, f), 'utf8')); } catch { return null; } };
  let prompts = []; try { prompts = fs.readFileSync(dump, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).prompt); } catch {}
  const st = run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : null;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, run, st, read, classify: prompts.filter(p => /^\[CLASSIFY\] ROUTING TASK/.test(p)),
    gaps: obs().slice(o0).filter(o => o.gap), result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const statusOf = (st) => (st?.steps || []).map(s => `${s.id}:${s.status}`).join(' ');
const waitIdle = async () => { for (let i = 0; i < 60 && ['Q', 'R'].some(n => fs.existsSync(path.join(T, 'logs', `${n}.pid`))); i++) await sleep(500); };

// ---------------------------------------------------------------------------
section('1. Ordre : comprendre le sens global → découper → classer chaque tâche (jamais le message entier)');
const order = catalogOf('routage').modes.demande;
ok(order.indexOf('comprendre') > order.indexOf('lire') && order.indexOf('decomposer') > order.indexOf('comprendre') && order.indexOf('classifier') > order.indexOf('decomposer') && order.indexOf('affecter') > order.indexOf('classifier'),
  `ordre du mode « demande » : ${order.join(' → ')}`);
const steps = Object.fromEntries(catalogSteps('routage').map(s => [s.id, s]));
ok(!steps.comprendre.checks.jsonEnum.nature.includes('lacune') && !/"pipeline"/.test(steps.comprendre.jsonExample), 'le sens global ne choisit ni pipeline ni lacune');
ok(steps.classifier.kind === 'code' && steps.classifier.handler === 'classer' && steps.classifier.chain[0] === 'routage.classifier', 'classer : exécuté par le code, un appel au model de la case routage.classifier par tâche');
ok(!/"pipeline": "dev\|/.test(steps.decomposer.jsonExample) && /impose/.test(steps.decomposer.jsonExample), 'le découpage ne choisit pas de pipeline (seul un préfixe de l’utilisateur s’impose)');

// ---------------------------------------------------------------------------
section('2. Message mixte (développement + opération git/version) : deux tâches classées séparément, aucune lacune sur le message entier');
const mixed = 'Ajoute une fonction double() au projet Q, puis pousse la branche main et pose le tag v1.1.0 sur Q';
const tDev = 'Ajoute une fonction double(x) qui renvoie 2*x dans le projet Q, avec son test.';
const tGit = 'Pousse la branche main du projet Q et pose le tag annoté v1.1.0 sur le dernier commit.';
let x = chefTurn(mixed, {
  FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'deux travaux de natures différentes sur Q', raison: 'code puis version' },
    decomposer: { taches: [{ projet: 'Q', titre: 'tâche de test 1', demande: tDev }, { projet: 'Q', titre: 'tâche de test 2', demande: tGit, apres: 1 }] } }),
  FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify({
    'double(x)': { pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'une fonction à ajouter' },
    'tag annoté': { pipeline: 'maintenance', mode: 'leger', raison: 'opération git de version' } }),
});
ok(x.code === 0 && statusOf(x.st) === 'lire:ok comprendre:ok decomposer:ok classifier:ok affecter:ok dispatcher:ok rapporter:ok', `exécution : ${statusOf(x.st)}`, x.out.slice(-900));
const cls2 = x.read('classement.json');
ok(cls2?.taches?.length === 2 && cls2.taches[0].pipeline === 'dev' && cls2.taches[0].kind === 'simple' && cls2.taches[1].pipeline === 'maintenance' && cls2.taches.every(t => t.route),
  `classement par tâche : ${(cls2?.taches || []).map(t => `${t.n}:${t.pipeline}`).join(', ')}`, JSON.stringify(cls2));
ok(x.classify.length === 2 && x.classify[0].includes('double(x)') && !x.classify[0].includes('tag annoté') && x.classify[1].includes('tag annoté') && !x.classify[1].includes('double(x)'),
  `un appel au model PAR TÂCHE, chacun ne voit que sa tâche (${x.classify.length} appel(s))`);
ok(!x.classify.some(p => p.includes(mixed)), 'le message entier n’est jamais soumis au classement');
ok(x.gaps.length === 0 && !x.evs.some(e => e.subtype === 'pipeline_gap'), `aucune lacune levée (${x.gaps.length})`);
const disp2 = x.read('dispatch.json');
ok(disp2?.dispatched?.map(d => d.n).join() === '1' && disp2.waiting?.map(w => w.n).join() === '2', 'tâche 1 lancée, tâche 2 en attente de la 1 (« puis »)', JSON.stringify(disp2));
ok(x.st.steps.find(s => s.id === 'classifier')?.model === 'claude-haiku-5-5', 'la frise dit le model qui a classé les tâches');
await waitIdle();
(await import('./routage-pending.mjs')).dropPending(path.join(T, 'logs'), { all: true });

// ---------------------------------------------------------------------------
section('3. Suite courte (réponse à une offre du chef) : comprise comme « suite », routée, aucune lacune');
fs.appendFileSync(path.join(T, 'logs', 'chef.jsonl'), [
  { type: 'user_prompt', text: 'Change l’ordre du Routage.', timestamp: new Date().toISOString() },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'J’ai mis cette tâche sur Q. Si vous préférez l’essayer d’abord sur R, dites-le-moi.' }] }, timestamp: new Date().toISOString() },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, duration_api_ms: 900, result: 'J’ai mis cette tâche sur Q.', timestamp: new Date().toISOString() },
].map(e => JSON.stringify(e)).join('\n') + '\n');
const tSuite = 'Le chef avait proposé de faire le changement d’ordre du Routage sur Q ou d’abord sur R ; l’utilisateur répond : ce développement doit être fait sur R. Fais-le sur R.';
x = chefTurn('Mais ce dev devra etre fait sur R', {
  FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'suite', sens: 'répond à l’offre du chef : le travail se fait sur R', raison: 'réponse courte à une offre', rattache: ['offre du chef'] },
    decomposer: { taches: [{ projet: 'R', titre: 'tâche de test 3', demande: tSuite, rattache: 'offre du chef' }] } }),
  FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify({ 'fait sur R': { pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'développement' } }),
});
ok(x.code === 0 && x.read('sens.json')?.nature === 'suite' && statusOf(x.st) === 'lire:ok comprendre:ok decomposer:ok classifier:ok affecter:ok dispatcher:ok rapporter:ok', `suite reconnue et routée : ${statusOf(x.st)}`, x.out.slice(-900));
ok(fs.readFileSync(path.join(T, 'chef', '.orchestrateur', 'runs', x.run, 'contexte.md'), 'utf8').includes('dites-le-moi'), 'le contexte porte l’offre du chef');
ok(x.gaps.length === 0 && !x.evs.some(e => e.subtype === 'pipeline_gap') && x.classify.length === 1 && !x.classify[0].includes('Mais ce dev devra etre fait sur R\n'), 'aucune lacune ; seule la tâche autonome est classée');
ok(x.read('dispatch.json')?.dispatched?.[0]?.projet === 'R', 'la tâche part vers R');
await waitIdle();

// ---------------------------------------------------------------------------
section('4. Tâche ambiguë : question à l’utilisateur pour CETTE tâche, les autres partent ; jamais deviner');
x = chefTurn('Corrige le bug de Q et range R', {
  FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'deux demandes', raison: 'deux projets' },
    decomposer: { taches: [{ projet: 'Q', titre: 'tâche de test 4', demande: 'Corrige le bug de division par zéro de Q.' }, { projet: 'R', titre: 'tâche de test 5', demande: 'Range le projet R comme convenu.' }] } }),
  FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify({ 'division par zéro': { pipeline: 'dev', mode: 'leger', nature: 'bugfix', raison: 'bug' }, 'Range le projet': { question: 'Ranger R : supprimer les fichiers inutiles, ou réorganiser les dossiers ?', raison: 'ambigu' } }),
});
const cls4 = x.read('classement.json');
ok(x.code === 0 && cls4?.taches?.[0]?.route === true && cls4.taches[1].route === false && x.read('dispatch.json')?.dispatched?.map(d => d.projet).join() === 'Q', 'Q part, R ne part pas', JSON.stringify(cls4));
ok(/NEEDS_USER_INPUT: .*Tâche 2 \(R\) : Ranger R/.test(x.result), 'la question de la tâche 2 finit le tour (NEEDS_USER_INPUT)', x.result.slice(-400));
await waitIdle();

// ---------------------------------------------------------------------------
section('5. Classement impossible (réponse invalide du model) : question, rien n’est lancé, aucun repli');
x = chefTurn('Fais le ménage dans Q', {
  FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'ménage', raison: 'x' }, decomposer: { taches: [{ projet: 'Q', titre: 'tâche de test 6', demande: 'Fais le ménage dans le dépôt Q.' }] } }),
  FAKE_CLAUDE_CLASSIFY: 'pas du JSON',
});
ok(x.code === 0 && x.read('dispatch.json')?.dispatched?.length === 0 && x.read('classement.json')?.taches?.[0]?.failed === true, 'aucune tâche lancée');
ok(/NEEDS_USER_INPUT: Tâche 1 \(Q\) : le classement par le model a échoué/.test(x.result), 'question à l’utilisateur', x.result.slice(-300));

// ---------------------------------------------------------------------------
section('6. Message impossible à découper : question à l’utilisateur ; « lacune » sur le message entier : refusée');
x = chefTurn('Fais ce qu’on a dit', {
  FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'une demande de travail', raison: 'x' }, decomposer: { taches: [], question: 'De quelle demande parlez-vous : celle sur Q ou celle sur R ?' } }),
});
ok(x.code === 0 && x.classify.length === 0 && x.read('dispatch.json')?.dispatched?.length === 0 && /NEEDS_USER_INPUT: De quelle demande parlez-vous/.test(x.result), 'aucun classement, aucune tâche, la question part', x.result.slice(-300));
x = chefTurn('Organise un voyage', { FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'lacune', sens: 's', raison: 'x' } }) });
ok(x.st?.steps?.find(s => s.id === 'comprendre')?.status === 'refused' && x.gaps.length === 0, '« lacune » pour le message entier : refusée, aucune lacune signalée');
ok(E.validateUnitTasks(T, [{ projet: 'Q', titre: 'tâche de test 7', demande: 'Une demande autonome.' }]) === null && /pipeline inconnu/.test(E.validateUnitTasks(T, [{ projet: 'Q', titre: 'tâche de test 8', demande: 'Une demande autonome.', impose: { pipeline: 'routage' } }]) || ''),
  'tâches unitaires : pas de pipeline exigé ; un pipeline imposé reste vérifié');

// The double's default answer (nothing scripted) must satisfy « Comprendre » too.
x = chefTurn('Pourquoi Q a-t-il un seul commit ?');
ok(x.code === 0 && statusOf(x.st) === 'lire:ok comprendre:ok decomposer:skipped classifier:skipped affecter:skipped dispatcher:skipped rapporter:ok', `réponse directe, sans rien de scripté : ${statusOf(x.st)}`, x.out.slice(-600));

await waitIdle();
fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
