#!/usr/bin/env node
// ============================================================================
// scripts/_test_routage_titles.mjs — every Routage task carries a short title,
// shown next to its id everywhere (0.87.0)
// ============================================================================
//
// Incident (2026-10-13): the chef confused two waiting Routage tasks born from
// the same request. Their texts shared their first ~400 characters, every
// display cut them at ~140, and an 8-hex id says nothing of the subject. The
// user validated a 4-task mechanism and answered, verbatim: « Lances les
// taches ». This is task 1/4: a SHORT TITLE, mandatory.
//
// Protected:
//   1. the Decomposer must give each task a non-empty short title (code check,
//      not a wish in the prompt): missing, empty, too short or too long → refused;
//   2. end to end: a taches.json without title is refused, nothing is
//      dispatched nor queued; with titles, the waiting entry keeps its title and
//      dispatch.json, the chef's report, `routage-pending.mjs list` (and --json)
//      and the context given to the chef's steps show `id « titre »`;
//   3. entries queued before 0.87.0 (no title) get a fallback title derived from
//      their « rattache », at display time only: the stored entry and its demand
//      are left byte-for-byte untouched;
//   4. an id never appears alone (list, context, drop).
//
//   node scripts/_test_routage_titles.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RP from './routage-pending.mjs';
import * as E from './pipeline-engine.mjs';
import { catalogSteps } from './pipeline-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-titles-'));
const LOGS = path.join(T, 'logs');
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
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [],
  enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(LOGS, `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
function chefTurn(text, env = {}) {
  const n0 = logOf('chef').length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', text, '--test', 'routage-titles'],
    { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const evs = logOf('chef').slice(n0);
  const run = evs.find(e => e.type === 'user_prompt')?.pipeline?.run;
  const art = run ? path.join(T, 'chef', '.orchestrateur', 'runs', run) : null;
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(art, f), 'utf8')); } catch { return null; } };
  const st = run ? JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', run, 'run.json'), 'utf8')) : null;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, run, st, read, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const statusOf = (st) => (st?.steps || []).map(s => `${s.id}:${s.status}`).join(' ');
const waitIdle = async () => { for (let i = 0; i < 60 && ['Q', 'R'].some(n => fs.existsSync(path.join(LOGS, `${n}.pid`))); i++) await sleep(500); };
const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'routage-pending.mjs'), ...a],
  { env: { ...baseEnv, DISPATCH_ROOT_FOR_TESTS: T }, encoding: 'utf8', windowsHide: true });
const ID_ALONE = /\b[0-9a-f]{8}\b(?! «)/;

// The real shape of the incident: a long shared opening, a different end.
const HEAD = 'Contexte : le chef a confondu deux tâches en attente du Routage nées de la même demande, dont le texte commence par la même longue phrase ; ce qui les distingue n’apparaît qu’après environ quatre cents caractères, alors que chaque affichage coupait le texte vers le cent quarantième caractère et que les identifiants ne disent rien du sujet. ';
const T_EDIT = `${HEAD}TÂCHE : rendre éditable un élément de la file d’attente tant qu’il n’est pas traité.`;
const T_DRAG = `${HEAD}TÂCHE : glisser-déposer les éléments de la file d’attente.`;
// Since 0.90.0 (task 2/4) one Routage run refuses two tasks with the same
// displayed start: the decomposed tasks of section 3 put what differs first.
const R_EDIT = `Édition d’un élément de file. ${T_EDIT}`;
const R_DRAG = `Glisser-déposer de la file. ${T_DRAG}`;

// ---------------------------------------------------------------------------
section('1. Découper : un titre court est exigé par le code pour chaque tâche');
{
  const t = (extra) => [{ projet: 'Q', demande: 'Une demande autonome.', ...extra }];
  ok(/tâche 1 : « titre » obligatoire/.test(E.validateUnitTasks(T, t({})) || ''), 'tâche sans titre : refusée', E.validateUnitTasks(T, t({})));
  ok(/« titre » obligatoire/.test(E.validateUnitTasks(T, t({ titre: '   ' })) || ''), 'titre vide (espaces) : refusé');
  ok(/« titre » obligatoire/.test(E.validateUnitTasks(T, t({ titre: 42 })) || ''), 'titre qui n’est pas un texte : refusé');
  ok(/trop court/.test(E.validateUnitTasks(T, t({ titre: 'ab' })) || ''), 'titre de 2 caractères : refusé');
  ok(/trop long/.test(E.validateUnitTasks(T, t({ titre: 'x'.repeat(RP.TITLE_MAX + 1) })) || ''), `titre de plus de ${RP.TITLE_MAX} caractères : refusé`);
  ok(E.validateUnitTasks(T, t({ titre: 'file : glisser-déposer' })) === null, 'titre court valide : accepté');
  ok(/tâche 2 : « titre » obligatoire/.test(E.validateUnitTasks(T, [{ projet: 'Q', titre: 'file : édition', demande: 'a' }, { projet: 'R', demande: 'b' }]) || ''), 'la tâche fautive est nommée par son numéro');
  const dec = catalogSteps('routage').find(s => s.id === 'decomposer');
  ok(/"titre"/.test(dec.jsonExample) && /titre/.test(dec.role) && dec.checks.unitTasks === true, 'la consigne et l’exemple JSON de Découper demandent le titre ; le critère unitTasks le vérifie');
}

// ---------------------------------------------------------------------------
section('2. Bout en bout : un taches.json sans titre est refusé ; rien n’est lancé ni mis en attente');
let x = chefTurn('Édition et glisser-déposer de la file', {
  FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'deux travaux sur Q', raison: 'x' },
    decomposer: { taches: [{ projet: 'Q', demande: T_DRAG }, { projet: 'Q', demande: T_EDIT, apres: 1 }] } }),
});
const dec2 = x.st?.steps?.find(s => s.id === 'decomposer');
ok(dec2 && dec2.status !== 'ok' && !x.read('dispatch.json')?.dispatched?.length, `Découper refusé (${statusOf(x.st)})`, x.out.slice(-900));
ok(JSON.stringify(x.st).includes('« titre » obligatoire'), 'le motif du refus parle du titre obligatoire');
ok(RP.readPending(LOGS).length === 0, 'aucune tâche mise en attente');

// ---------------------------------------------------------------------------
section('3. Avec titres : titre gardé dans l’attente et affiché avec l’identifiant (dispatch.json, rapport, liste, contexte)');
x = chefTurn('Glisser-déposer puis édition de la file', {
  FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'deux travaux sur Q', raison: 'x' },
    decomposer: { taches: [{ projet: 'Q', titre: 'file : glisser-déposer', demande: R_DRAG }, { projet: 'Q', titre: 'file : édition', demande: R_EDIT, apres: 1, rattache: 'tâches 1 à 4' }] } }),
  FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify({ 'glisser-déposer les éléments': { pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'r' }, 'rendre éditable': { pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'r' } }),
});
ok(x.code === 0 && statusOf(x.st) === 'lire:ok comprendre:ok decomposer:ok classifier:ok affecter:ok dispatcher:ok rapporter:ok', `exécution : ${statusOf(x.st)}`, x.out.slice(-900));
const pend = RP.readPending(LOGS);
ok(pend.length === 1 && pend[0].titre === 'file : édition' && pend[0].demande === R_EDIT, 'l’entrée en attente garde son titre (et sa demande entière)', JSON.stringify(pend));
const id = pend[0]?.id;
const disp = x.read('dispatch.json');
ok(disp?.waiting?.[0]?.id === id && disp.waiting[0].titre === 'file : édition', 'dispatch.json : identifiant et titre de la tâche en attente', JSON.stringify(disp?.waiting));
ok(disp?.dispatched?.[0]?.titre === 'file : glisser-déposer', 'dispatch.json : la tâche lancée porte aussi son titre');
ok(x.result.includes(`${id} « file : édition »`), 'le rapport du chef nomme la tâche en attente par « identifiant + titre »', x.result.slice(-600));
let l = cli('list');
ok(l.status === 0 && l.stdout.includes(`${id} « file : édition »`) && !ID_ALONE.test(l.stdout.replace(/p-\d{8}T\d{6}-[0-9a-f]{6}/g, '')), 'routage-pending list : « identifiant « titre » », jamais l’identifiant seul', l.stdout + l.stderr);
let lj = JSON.parse(cli('list', '--json').stdout || '[]');
ok(lj[0]?.id === id && lj[0].titre === 'file : édition' && !lj[0].titreRepli, 'routage-pending list --json : champ titre à côté de l’identifiant');
let ctx = E.routingContext(T, { logsDir: LOGS, chefLog: path.join(LOGS, 'chef.jsonl'), chefDir: path.join(T, 'chef') });
const sec = ctx.split('## Tâches déjà décidées, en attente d’une autre')[1]?.split('\n## ')[0] || '';
ok(sec.includes(`${id} « file : édition »`), 'contexte du chef (« Tâches déjà décidées, en attente d’une autre ») : identifiant + titre', sec);
await waitIdle();
RP.dropPending(LOGS, { all: true });

// ---------------------------------------------------------------------------
section('4. Anciennes entrées sans titre : titre de repli tiré de « rattache », entrée stockée intacte');
{
  const legacy = [
    { id: 'aaaa1111', run: 'p-20261013T153043-b3a351', n: 3, projet: 'Q', pipeline: 'dev', mode: 'complet', demande: T_EDIT, rattache: 'Tâche 3/4 : édition d’un élément de file', after: { projet: 'R', offset: 0, hash: RP.textHash('x') }, createdAt: '2026-10-13T15:31:00.000Z' },
    { id: 'bbbb2222', run: 'p-20261013T153043-b3a351', n: 4, projet: 'Q', pipeline: 'dev', mode: 'complet', demande: T_DRAG, after: { projet: 'R', offset: 0, hash: RP.textHash('y') }, createdAt: '2026-10-13T15:31:00.000Z' },
  ];
  RP.writePending(LOGS, legacy);
  const before = fs.readFileSync(path.join(LOGS, RP.PENDING_FILE), 'utf8');
  const a = RP.pendingLabel(legacy[0]), b = RP.pendingLabel(legacy[1]);
  ok(a.titreRepli && a.titre.startsWith('↳ Tâche 3/4 : édition d’un élément') && a.titre.length <= RP.TITLE_MAX, `repli tiré de « rattache » : ${a.titre}`);
  ok(b.titreRepli && b.titre.startsWith('↳ Contexte') && b.titre.length <= RP.TITLE_MAX, `sans « rattache » : repli tiré du début de la demande (${b.titre})`);
  l = cli('list');
  ok(l.stdout.includes(`aaaa1111 « ${a.titre} » (titre de repli)`) && l.stdout.includes(`bbbb2222 « ${b.titre} » (titre de repli)`), 'list : le repli est affiché et signalé comme tel', l.stdout);
  lj = JSON.parse(cli('list', '--json').stdout || '[]');
  ok(lj.length === 2 && lj.every(t => t.titreRepli === true && t.titre.startsWith('↳ ')) && lj[0].demande === T_EDIT, 'list --json : titre de repli + titreRepli, demande entière');
  ctx = E.routingContext(T, { logsDir: LOGS, chefLog: path.join(LOGS, 'chef.jsonl'), chefDir: path.join(T, 'chef') });
  ok(ctx.includes(`aaaa1111 « ${a.titre} »`) && ctx.includes(`bbbb2222 « ${b.titre} »`), 'contexte du chef : repli affiché avec l’identifiant');
  ok(fs.readFileSync(path.join(LOGS, RP.PENDING_FILE), 'utf8') === before, 'le fichier des tâches en attente n’est pas modifié par l’affichage (aucune perte, aucune réécriture)');
  const d = cli('drop', 'aaaa1111');
  ok(d.status === 0 && d.stdout.includes(`aaaa1111 « ${a.titre} »`), 'drop : la tâche retirée est nommée par identifiant + titre', d.stdout);
  ok(RP.readPending(LOGS).length === 1 && RP.readPending(LOGS)[0].demande === T_DRAG, 'seule la tâche visée est retirée');
  RP.dropPending(LOGS, { all: true });
}

// ---------------------------------------------------------------------------
section('5. Doublon écarté : la tâche gardée est nommée par son titre');
{
  const after = { projet: 'R', offset: 0, hash: RP.textHash('z') };
  const e = { run: 'p-20261014T080000-cccccc', n: 1, projet: 'Q', titre: 'file : édition', demande: T_EDIT, after };
  RP.addPending(LOGS, [e]);
  const r = RP.addPending(LOGS, [{ ...e, titre: 'autre titre' }]);
  ok(r.duplicates.length === 1 && RP.duplicatesText(r.duplicates).includes(`${r.duplicates[0].keptId} « file : édition »`), 'texte des doublons : identifiant + titre de la tâche gardée', RP.duplicatesText(r.duplicates));
  RP.dropPending(LOGS, { all: true });
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* Windows: a child may still hold a file */ }
console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
