#!/usr/bin/env node
// ============================================================================
// scripts/_test_resume_explicit_only.mjs — a run id cited in a task is only a
// reference: a paused run is resumed on explicit request only (Routage v3,
// phase 0 c)
// ============================================================================
//
// User decision (2026-10-19, docs/ROUTAGE-SYNTHESE.md §4, decision 4): « ok »
// — resume ONLY on explicit request; the implicit-resume assertion of
// _test_routage_pending.mjs is inverted with that agreement.
//
// Real production cases replayed (anonymized):
//   - Routage p-20261019T180056-e8254b: a read-only check (« Vérifier dans le
//     code … ») that CITED the paused run of its project was classified
//     Discussion by the model, yet the Dispatcher launched it as
//     `--pipeline-resume <that run>` (detectReprise read the id in the text);
//   - Routage p-20261018T122954-17ac13, task 2 (« Ajout de 5 vidéos… »),
//     classified dev, resumed the paused run cited in its text instead of
//     starting its own work.
//
// Protected:
//   1. detectReprise: the explicit `reprise` field only, never an id in the text;
//   2. real dispatch.mjs + engine (Routage of the chef, fake claude): the
//      Discussion task citing the paused run goes out as a Discussion, the run
//      stays paused; a task with the explicit `reprise` field still resumes;
//   3. a waiting entry (any age) whose text cites a paused run is released as
//      a new task, never as `--pipeline-resume`.
//
//   node scripts/_test_resume_explicit_only.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import * as RP from './routage-pending.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-resume-explicit-'));
const LOGS = path.join(T, 'logs');
for (const d of ['logs/runs', 'chef', 'Q']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
fs.writeFileSync(path.join(T, 'Q', 'package.json'), JSON.stringify({ name: 'Q', version: '1.0.0', type: 'module' }) + '\n');
g(path.join(T, 'Q'), 'init', '-q'); g(path.join(T, 'Q'), 'add', '-A'); g(path.join(T, 'Q'), 'commit', '-q', '-m', 'init');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude', maxParallel: 1 },
  projects: ['chef', 'Q'].map(n => ({ name: n, path: path.join(T, n) })),
}));
// Q is not in service: a launched task is an ordinary (fast) turn of the double.
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [],
  enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
const PAUSED = 'p-20261019T144511-44d707';
const writeRun = (status = 'paused') => {
  fs.mkdirSync(path.join(LOGS, 'runs', PAUSED), { recursive: true });
  fs.writeFileSync(path.join(LOGS, 'runs', PAUSED, 'run.json'), JSON.stringify({ run: PAUSED, project: 'Q', pipeline: 'dev', mode: 'leger', status, pausedLimit: 'green', plan: ['vert', 'livrer'], index: 0, steps: [], request: 'Reprise de pause : le message joint à « continuer » est perdu' }));
};
writeRun();
const runStatus = () => JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', PAUSED, 'run.json'), 'utf8')).status;

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(LOGS, `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
function chefTurn(text, env = {}) {
  const n0 = logOf('chef').length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', text, '--test', 'resume-explicit'],
    { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const evs = logOf('chef').slice(n0);
  const run = evs.find(e => e.type === 'user_prompt')?.pipeline?.run;
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(T, 'chef', '.orchestrateur', 'runs', run, f), 'utf8')); } catch { return null; } };
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, run, read };
}
const waitIdle = async () => { for (let i = 0; i < 80 && fs.existsSync(path.join(LOGS, 'Q.pid')); i++) await sleep(500); await sleep(300); };

// Anonymized text of the real task of p-20261019T180056-e8254b.
const CHECK = `Vérifier dans le code du moteur de pipeline (lecture seule, aucune modification) ce qui se passe quand des tests échouent pendant une étape de développement. Contexte : l'exécution en pause ${PAUSED} « Reprise de pause : le message joint à « continuer » est perdu » a vu son second passage « Vert » refusé 3 fois.`;

try {
  // -------------------------------------------------------------------------
  section('1. detectReprise : le champ explicite seulement');
  ok(RP.detectReprise(LOGS, { projet: 'Q', demande: CHECK }) === null, 'identifiant d’une exécution en pause cité dans le texte : simple référence, aucune reprise');
  ok(RP.detectReprise(LOGS, { projet: 'Q', reprise: PAUSED, demande: 'Reprendre' }) === PAUSED, 'champ « reprise » explicite : reprise');
  ok(RP.detectReprise(LOGS, { projet: 'autre', reprise: PAUSED, demande: 'x' }) === null, 'champ explicite, mais exécution d’un autre projet : aucune reprise');

  // -------------------------------------------------------------------------
  section('2. Rejeu de p-20261019T180056-e8254b : une Discussion qui cite l’exécution en pause reste une Discussion');
  let x = chefTurn('Est-ce que, lorsque des tests échouent, la conséquence est de les repasser jusqu’à 3 fois max ? Vérifie dans le code', {
    FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'une vérification en lecture seule', raison: 'question sur le code' },
      decomposer: { taches: [{ projet: 'Q', titre: 'vérifier : échec de tests', demande: CHECK }] } }),
    FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify({ 'lecture seule': { pipeline: 'discussion', mode: 'leger', raison: 'question sur le code, aucune modification' } }),
  });
  const d = x.read('dispatch.json');
  const t = d?.dispatched?.[0];
  ok(x.code === 0 && t?.projet === 'Q', `la tâche part vers Q (code ${x.code})`, x.out.slice(-900));
  const c = x.read('classement.json')?.taches?.[0];
  ok(t && !t.reprise && c?.pipeline === 'discussion' && c.classifier !== 'reprise', `lancée comme la Discussion classée, sans reprise (reprise=${t?.reprise}, classement=${c?.pipeline}/${c?.classifier})`, JSON.stringify(d));
  await waitIdle();
  const up = logOf('Q').find(e => e.type === 'user_prompt');
  ok(up && !up.pipeline?.resumed && up.pipeline?.run !== PAUSED, 'le tour de Q n’a pas repris l’exécution citée', JSON.stringify(up)?.slice(0, 400));
  ok(runStatus() === 'paused', 'l’exécution citée reste en pause, intacte');

  // -------------------------------------------------------------------------
  section('3. Demande explicite (champ « reprise » du Découpage) : la reprise a lieu');
  x = chefTurn(`Reprends l’exécution en pause ${PAUSED} avec « continuer »`, {
    FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'reprise demandée', raison: 'l’utilisateur demande la reprise' },
      decomposer: { taches: [{ projet: 'Q', titre: 'reprise de l’exécution en pause', demande: `Reprise (« continuer ») de l’exécution en pause ${PAUSED}`, reprise: PAUSED }] } }),
  }, );
  const t3 = x.read('dispatch.json')?.dispatched?.[0];
  ok(x.code === 0 && t3?.reprise === PAUSED, `reprise explicite conservée (${t3?.reprise})`, x.out.slice(-900));
  await waitIdle();

  // -------------------------------------------------------------------------
  section('4. Tâche en attente citant une exécution en pause : lancée comme tâche neuve');
  writeRun();
  RP.dropPending(LOGS, { all: true });
  const launched = [];
  const launch = (root, task) => { launched.push(task); return { projet: task.projet, pid: null, at: new Date().toISOString(), offset: 0 }; };
  fs.appendFileSync(path.join(LOGS, 'pan.jsonl'), JSON.stringify({ type: 'result', subtype: 'success', num_turns: 4, duration_api_ms: 9, result: 'fait', timestamp: '2026-10-18T12:40:58.977Z' }) + '\n');
  fs.writeFileSync(path.join(LOGS, RP.PENDING_FILE), JSON.stringify({ tasks: [{ run: 'p-20261018T122954-17ac13', n: 2, projet: 'Q', pipeline: 'dev', mode: 'leger', served: true, titre: 'ajout des 5 vidéos',
    demande: `Ajout de 5 vidéos à la liste (le travail de streaming reste dans l’exécution en pause ${PAUSED}).`, after: { projet: 'pan', since: '2026-10-18T12:31:56.969Z' }, createdAt: '2026-10-18T12:31:56.969Z' }] }));
  const r = RP.releaseReady({ root: T, logsDir: LOGS, dispatchScript: 'nul', launch });
  ok(r.launched.length === 1 && !launched[0]?.reprise && launched[0]?.pipeline === 'dev', `libérée comme tâche neuve (reprise=${launched[0]?.reprise}, pipeline=${launched[0]?.pipeline})`, JSON.stringify(r.launched));
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
