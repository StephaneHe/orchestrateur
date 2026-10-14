#!/usr/bin/env node
// ============================================================================
// scripts/_test_routage_ambiguous.mjs — the Decomposer refuses two tasks of
// one Routage run that look alike where they are shown (0.90.0)
// ============================================================================
//
// Incident (2026-10-13): the chef confused two waiting Routage tasks
// (5383dd61 and 75627914) of the same request: their texts shared their first
// ~400 characters and every display cut them earlier. The user validated a
// 4-task mechanism, verbatim: « Lances les taches ». Task 1/4 (0.87.0) made a
// short title mandatory; this is task 2/4: AMBIGUOUS TITLES ARE REFUSED.
//
// Protected:
//   1. the rule: same title (case, spacing, accents ignored) or same displayed
//      start of text (the cut of `routage-pending.mjs list`) → refused, naming
//      every conflicting pair; distinct titles and starts → accepted;
//   2. end to end, the real shape of 2026-10-13 (two tasks, same long opening,
//      the difference after ~400 characters): the Decomposer step is refused
//      with a reason that names tasks 1 and 2, nothing is dispatched or
//      queued; the same split with distinct titles and starts goes through.
//
//   node scripts/_test_routage_ambiguous.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RP from './routage-pending.mjs';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The real shape of 2026-10-13: one long shared opening, the difference after it.
const HEAD = 'Contexte (tu ne vois pas la conversation) — demande verbatim de l’utilisateur (2026-10-13) : « il faut pouvoir drag & drop les éléments de la file d’attente, et que celà ai un impacte sur l’ordre de traitement. Les éléments de la file d’attente doivent être clickable pour voir leurs détails, tant qu’ils ne sont pas traités ils sont éditables ». ';
const EDIT = `${HEAD}Cette tâche couvre UNIQUEMENT la partie « éditables ».`;
const DRAG = `${HEAD}Cette tâche couvre UNIQUEMENT le glisser-déposer.`;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ambig-'));
const LOGS = path.join(T, 'logs');
for (const d of ['logs', 'chef', 'Q']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
fs.writeFileSync(path.join(T, 'Q', 'package.json'), '{"name":"Q","version":"1.0.0"}\n');
spawnSync('git', ['init', '-q'], { cwd: path.join(T, 'Q') });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'Q'].map(n => ({ name: n, path: path.join(T, n) })),
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ORCH_HANDOFF_TOKEN',
  'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(LOGS, `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
function chefTurn(text, json, map) {
  const n0 = logOf('chef').length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', text, '--test', 'titres-ambigus'],
    { env: { ...baseEnv, FAKE_PIPE_JSON: JSON.stringify(json), FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify(map || {}) }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const evs = logOf('chef').slice(n0);
  const run = evs.find(e => e.type === 'user_prompt')?.pipeline?.run;
  const art = run ? path.join(T, 'chef', '.orchestrateur', 'runs', run) : null;
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(art, f), 'utf8')); } catch { return null; } };
  const st = run ? JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', run, 'run.json'), 'utf8')) : null;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, run, st, read };
}
const statusOf = (st) => (st?.steps || []).map(s => `${s.id}:${s.status}`).join(' ');
const MAP = { 'éditables': { pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'r' }, 'glisser-déposer': { pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'r' } };

// ---------------------------------------------------------------------------
section('1. La règle : même titre ou même début affiché → refusé, en nommant les tâches en conflit');
{
  const t = (titre, demande) => ({ projet: 'Q', titre, demande });
  ok(HEAD.length > RP.DISPLAY_HEAD && RP.displayedHead(EDIT) === RP.displayedHead(DRAG), `le cas du 2026-10-13 : mêmes ${RP.DISPLAY_HEAD} premiers caractères affichés`);
  let w = E.validateUnitTasks(T, [t('file : édition', EDIT), t('file : glisser-déposer', DRAG)]);
  ok(/tâches 1 et 2 : même début de texte affiché/.test(w || ''), 'même début de texte, titres distincts : refusé, tâches 1 et 2 nommées', w);
  w = E.validateUnitTasks(T, [t('File : Édition', 'Rends éditable un élément de la file.'), t('  file :   edition ', 'Autre chose, sur la file.')]);
  ok(/tâches 1 et 2 : même titre/.test(w || ''), 'même titre à la casse, aux espaces et aux accents près : refusé', w);
  w = E.validateUnitTasks(T, [t('file : édition', 'A — première.'), t('file : tri', 'B — deuxième.'), t('file : édition', 'C — troisième.')]);
  ok(/tâches 1 et 3 : même titre/.test(w || '') && !/tâches 1 et 2|tâches 2 et 3/.test(w || ''), 'seule la paire en conflit est nommée (1 et 3)', w);
  ok(/titre distinct/.test(w || '') && /commencer sa demande par ce qui la distingue/.test(w || ''), 'le refus dit comment corriger');
  ok(E.validateUnitTasks(T, [t('file : édition', `Édition d’un élément. ${EDIT}`), t('file : glisser-déposer', `Glisser-déposer. ${DRAG}`)]) === null, 'titres et débuts distincts : accepté');
  ok(RP.ambiguityProblem([t('file : édition', EDIT)]) === null, 'une seule tâche : jamais ambiguë');
}

// ---------------------------------------------------------------------------
section('2. Bout en bout, le cas du 2026-10-13 : Découper refusé, rien de lancé ni mis en attente');
let x = chefTurn('Édition et glisser-déposer de la file', {
  comprendre: { nature: 'taches', sens: 'deux travaux sur la file', raison: 'x' },
  decomposer: { taches: [{ projet: 'Q', titre: 'file : édition', demande: EDIT }, { projet: 'Q', titre: 'file : glisser-déposer', demande: DRAG, apres: 1 }] },
}, MAP);
const dec = x.st?.steps?.filter(s => s.id === 'decomposer') || [];
ok(dec.length && dec.every(s => s.status !== 'ok'), `Découper refusé (${statusOf(x.st)})`, x.out.slice(-600));
ok(JSON.stringify(x.st).includes('tâches 1 et 2 : même début de texte affiché'), 'le motif nomme les tâches en conflit, pour que l’étape corrige');
ok(!x.read('dispatch.json')?.dispatched?.length && RP.readPending(LOGS).length === 0, 'rien de lancé, rien mis en attente');

// ---------------------------------------------------------------------------
section('3. Le même découpage aux titres et débuts distincts passe');
const E2 = `Édition d’un élément de file en attente. ${EDIT}`, D2 = `Glisser-déposer de la file. ${DRAG}`;
x = chefTurn('Édition et glisser-déposer de la file', {
  comprendre: { nature: 'taches', sens: 'deux travaux sur la file', raison: 'x' },
  decomposer: { taches: [{ projet: 'Q', titre: 'file : édition', demande: E2 }, { projet: 'Q', titre: 'file : glisser-déposer', demande: D2, apres: 1 }] },
}, MAP);
ok(x.code === 0 && statusOf(x.st) === 'lire:ok comprendre:ok decomposer:ok classifier:ok affecter:ok dispatcher:ok rapporter:ok', `Routage complet : ${statusOf(x.st)}`, x.out.slice(-600));
const pend = RP.readPending(LOGS);
ok(pend.length === 1 && pend[0].titre === 'file : glisser-déposer' && pend[0].demande === D2, 'la 2ᵉ tâche attend la 1ʳᵉ, avec son titre et sa demande entière');
for (let i = 0; i < 60 && fs.existsSync(path.join(LOGS, 'Q.pid')); i++) await sleep(500);
RP.dropPending(LOGS, { all: true });

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
