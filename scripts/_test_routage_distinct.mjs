#!/usr/bin/env node
// ============================================================================
// scripts/_test_routage_distinct.mjs — waiting Routage tasks that share their
// start show what sets them apart, and their « rattache » (0.91.0)
// ============================================================================
//
// Incident (2026-10-13): the chef confused two waiting tasks, 5383dd61
// (« édition tant que non traité ») and 75627914 (« glisser-déposer »):
// `routage-pending.mjs list` and the chef's context cut each text near the
// 140th character, while they only differed after ~400; their `rattache`,
// which named the part covered, was shown nowhere. The user validated a
// 4-task mechanism, verbatim: « Lances les taches ». This is task 3/4: SHOW
// WHAT DIFFERS.
//
// Protected (the real shape of the incident, two entries queued before the
// mandatory title, so with fallback titles):
//   1. distinctExcerpts: each twin gets the excerpt starting where it parts
//      from the other; an entry with its own start is left alone;
//   2. `routage-pending.mjs list`: for each twin, its title, the distinctive
//      excerpt and its `rattache` — never only the common 140 characters;
//      `--json` carries `distinct`;
//   3. the context given to the chef's steps shows the same.
//
//   node scripts/_test_routage_distinct.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RP from './routage-pending.mjs';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const HEAD = 'Contexte (tu ne vois pas la conversation) — demande verbatim de l’utilisateur (2026-10-13) : « il faut pouvoir drag & drop les éléments de la file d’attente, et que celà ai un impacte sur l’ordre de traitement. Les éléments de la file d’attente doivent être clickable pour voir leurs détails, tant qu’ils ne sont pas traités ils sont éditables ». La vue de détail a été livrée. ';
const EDIT = `${HEAD}Cette tâche couvre UNIQUEMENT la partie « tant qu’ils ne sont pas traités ils sont éditables » : modifier le texte d’un élément en attente.`;
const DRAG = `${HEAD}Cette tâche couvre UNIQUEMENT le glisser-déposer : l’ordre déposé est l’ordre de traitement.`;
const OTHER = 'Corrige le calcul de la durée affichée dans le journal d’activité.';
const after = { projet: 'R', offset: 0, hash: RP.textHash('x') };
const entries = [
  { id: '5383dd61', run: 'p-20261013T153043-b3a351', n: 3, projet: 'Q', demande: EDIT, rattache: 'Tâche 3/4 : édition tant que non traité', after, createdAt: '2026-10-13T15:33:01.351Z' },
  { id: '75627914', run: 'p-20261013T153043-b3a351', n: 4, projet: 'Q', demande: DRAG, rattache: 'Tâche 4/4 : glisser-déposer', after, createdAt: '2026-10-13T15:33:01.352Z' },
  { id: 'cafe0001', run: 'p-20261013T153043-b3a351', n: 5, projet: 'Q', titre: 'journal : durée', demande: OTHER, after, createdAt: '2026-10-13T15:33:01.353Z' },
];

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-distinct-'));
const LOGS = path.join(T, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(path.join(T, 'chef'), { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', projects: ['chef', 'Q', 'R'].map(n => ({ name: n, path: path.join(T, n) })) }));
RP.writePending(LOGS, entries);
const before = fs.readFileSync(path.join(LOGS, RP.PENDING_FILE), 'utf8');

// ---------------------------------------------------------------------------
section('1. Ce qui distingue deux entrées au même début');
const d = RP.distinctExcerpts(entries);
ok(RP.displayedHead(EDIT) === RP.displayedHead(DRAG) && HEAD.length > RP.DISPLAY_HEAD, 'le cas du 2026-10-13 : même début affiché');
const de = d.get('5383dd61'), dd = d.get('75627914');
ok(de?.excerpt.includes('éditables » : modifier le texte') && dd?.excerpt.includes('glisser-déposer : l’ordre déposé'), 'chaque entrée reçoit l’extrait qui la distingue', JSON.stringify([de, dd]));
ok(!de.excerpt.includes('Contexte (tu ne vois') && !dd.excerpt.includes('Contexte (tu ne vois'), 'l’extrait ne répète pas le début commun');
ok(de.commonLength >= HEAD.length && de.commonWith.join() === '75627914' && dd.commonWith.join() === '5383dd61', `début commun mesuré (${de.commonLength} caractères) et jumeau nommé`);
ok(!d.has('cafe0001'), 'une entrée au début propre n’a pas besoin d’extrait');

// ---------------------------------------------------------------------------
section('2. routage-pending.mjs list : titre, extrait distinctif et rattache de chaque entrée');
const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'routage-pending.mjs'), ...a],
  { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: T }, encoding: 'utf8', windowsHide: true });
const l = cli('list');
const block = (id) => { const s = l.stdout.split('\n'); const i = s.findIndex(x => x.startsWith(id)); return i < 0 ? '' : [s[i], ...s.slice(i + 1).filter((x, k, arr) => arr.slice(0, k + 1).every(y => y.startsWith(' ')))].join('\n'); };
const be = block('5383dd61'), bd = block('75627914');
ok(l.status === 0 && be.includes('« ↳ Tâche 3/4 : édition tant que non traité »') && bd.includes('« ↳ Tâche 4/4 : glisser-déposer »'), 'titre (de repli, tiré du rattache) sur la ligne de chaque entrée', l.stdout);
ok(/ce qui la distingue : …[^\n]*éditables » : modifier le texte/.test(be) && /ce qui la distingue : …[^\n]*glisser-déposer : l’ordre déposé/.test(bd), 'la partie distinctive est affichée pour chacune', `${be}\n---\n${bd}`);
ok(be.includes('rattachée à : Tâche 3/4 : édition tant que non traité') && bd.includes('rattachée à : Tâche 4/4 : glisser-déposer'), 'le rattache est affiché pour chacune');
ok(!be.split('\n').slice(1).some(x => x.trim() === RP.displayedHead(EDIT)), 'plus jamais seulement les 140 premiers caractères communs');
ok(block('cafe0001').includes(OTHER), 'une entrée au début propre garde son début affiché');
const j = JSON.parse(cli('list', '--json').stdout || '[]');
ok(j.find(x => x.id === '5383dd61')?.distinct?.excerpt === de.excerpt && j.find(x => x.id === '75627914')?.distinct?.commonWith?.join() === '5383dd61' && !j.find(x => x.id === 'cafe0001')?.distinct,
  'list --json : champ « distinct » (extrait, longueur commune, jumeaux) pour les seules entrées concernées');

// ---------------------------------------------------------------------------
section('3. Contexte fourni aux étapes du chef');
const ctx = E.routingContext(T, { logsDir: LOGS, chefLog: path.join(LOGS, 'chef.jsonl'), chefDir: path.join(T, 'chef') });
const sec = ctx.split('## Tâches déjà décidées, en attente d’une autre')[1]?.split('\n## ')[0] || '';
ok(/5383dd61 « ↳ Tâche 3\/4[^\n]*ce qui la distingue : …[^\n]*modifier le texte/.test(sec) && /75627914 « ↳ Tâche 4\/4[^\n]*ce qui la distingue : …[^\n]*l’ordre déposé/.test(sec), 'titre et partie distinctive de chaque entrée', sec);
ok(sec.includes('rattachée à : Tâche 3/4 : édition tant que non traité') && sec.includes('rattachée à : Tâche 4/4 : glisser-déposer'), 'rattache de chaque entrée');
ok(sec.includes(OTHER), 'une entrée au début propre reste affichée par son début');
ok(fs.readFileSync(path.join(LOGS, RP.PENDING_FILE), 'utf8') === before, 'l’affichage ne réécrit pas le fichier des tâches en attente');

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
