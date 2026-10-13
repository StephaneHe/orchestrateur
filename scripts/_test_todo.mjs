#!/usr/bin/env node
// ============================================================================
// scripts/_test_todo.mjs — musicians' TODO lists: reader, order, todo.mjs,
// read-only wiring (0.75.0)
// ============================================================================
//
// User request (2026-10-13): « Sur dev, je veux que l'on reprenne
// l'implémentation de notre todo list et git visualisation sur pannel » —
// TODO part: full-height toggle panel; each musician's list as checkboxes,
// DONE items first then NOT DONE, each part newest first by entry date;
// read-only for the user (the musician ticks); the musician's name next to
// each done item.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTodo, sortTodo, countTodo, addItem, setStatus, TODO_FILE } from './todo-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-todo-'));
const read = (f) => fs.readFileSync(f, 'utf8');

// Shapes seen in the fleet (2026-10-13): the chef dates its items, the others
// do not; legacy "→ FAIT" text; bold; [~]; headings and continuation lines.
const FIXTURE = [
  '# TODO_LIST — Chef', '', '## En cours',
  '- [ ] (2026-09-16) **projet-a — gel périodique** → EN COURS : dispatché correctif',
  '- [x] (2026-09-15) **projet-b — icônes** → FAIT (commit `39ef05c`, v1.5.1) : couvertures',
  '- [~] (2026-09-14) **projet-a — ANALYSE** → CAUSE RACINE TROUVÉE',
  '  suite de l’item sur une seconde ligne',
  '- [ ] (2026-10-08 17:40) Limite de session relancée',
  '- [x] (2026-10-12 18:40) [projet] Instance de dev séparée → fait (2026-10-13 10:02) par orchestrateur-dev <!-- id:t-02be01 -->',
  '* [ ] item sans date',
  '- [X] autre item sans date, coché à la main',
  'texte libre qui n’est pas un item',
].join('\n');

try {
  console.log('\n── 1. Lecteur tolérant (formats réels)');
  const mtime = new Date(2026, 9, 1, 8, 30);
  const items = parseTodo(FIXTURE, { project: 'chef', fileMtime: mtime });
  ok(items.length === 7, `7 items lus, titres et texte libre ignorés (${items.length})`);
  const by = (s) => items.find(i => i.title.includes(s));
  ok(by('gel périodique')?.status === 'todo' && by('gel périodique').title === 'projet-a — gel périodique' && /EN COURS/.test(by('gel périodique').detail), 'gras retiré, « → … » ancien = détail');
  ok(by('ANALYSE')?.status === 'progress' && by('icônes')?.status === 'done', '[ ] / [~] / [x] → todo / progress / done');
  ok(by('Limite de session').addedAt === '2026-10-08T17:40' && by('gel périodique').addedAt === '2026-09-16T00:00' && !by('gel périodique').addedEstimated, 'date d’entrée lue, avec ou sans heure');
  ok(by('sans date').addedAt === '2026-10-01T08:30' && by('sans date').addedEstimated, 'sans date : date du fichier, marquée estimée');
  const dev = by('Instance de dev');
  ok(dev.id === 't-02be01' && dev.type === 'projet' && dev.doneBy === 'orchestrateur-dev' && dev.doneAt === '2026-10-13T10:02' && !dev.manual && dev.title === 'Instance de dev séparée', 'nouveau format : id, type, « fait (…) par <musicien> »');
  ok(by('icônes').doneBy === null && by('icônes').manual && by('coché à la main').doneBy === null, 'coché à la main / ancien format : aucun nom inventé');
  ok(new Set(items.map(i => i.id)).size === items.length && parseTodo(FIXTURE, { project: 'chef' }).map(i => i.id).join() === items.map(i => i.id).join(), 'identifiants uniques et stables');

  console.log('\n── 2. Ordre : FAITS en haut, puis NON FAITS ; chacun du plus récent au plus ancien (date d’entrée)');
  const s = sortTodo(items);
  const firstOpen = s.findIndex(i => i.status !== 'done');
  ok(s.slice(0, firstOpen).every(i => i.status === 'done') && s.slice(firstOpen).every(i => i.status !== 'done'), 'faits d’abord, non faits ensuite ([~] avec les non faits)');
  const desc = (part) => part.every((x, k) => k === 0 || String(part[k - 1].addedAt) >= String(x.addedAt));
  ok(desc(s.slice(0, firstOpen)) && desc(s.slice(firstOpen)), 'chaque partie : date d’entrée décroissante', s.map(i => `${i.status}:${i.addedAt}`).join(' '));
  ok(s[0].title === 'Instance de dev séparée' && s[firstOpen].title === 'Limite de session relancée', `têtes de partie : ${s[0].title} / ${s[firstOpen].title}`);
  const same = sortTodo(parseTodo('- [ ] a\n- [ ] b\n- [ ] c', { project: 'p', fileMtime: mtime }));
  ok(same.map(i => i.title).join('') === 'cba', 'même date : plus bas dans le fichier = plus récent');
  const c = countTodo(items);
  ok(c.done === 3 && c.open === 4 && c.progress === 1, `compteurs ${JSON.stringify(c)}`);

  console.log('\n── 3. Les vrais fichiers de la flotte se lisent sans erreur (disque, pas git)');
  let files = 0, total = 0;
  try {
    for (const p of JSON.parse(read(path.join(ROOT, 'config.json'))).projects || []) {
      const f = p?.path && path.join(p.path, TODO_FILE);
      if (!f || !fs.existsSync(f)) continue;
      files++; total += parseTodo(read(f), { project: p.name, fileMtime: fs.statSync(f).mtime }).length;
    }
  } catch { /* no config.json in this copy */ }
  ok(true, `${files} fichier(s), ${total} item(s) lus`);

  console.log('\n── 4. Édition : une seule ligne change');
  const a = addItem('', { title: 'Premier', type: 'correction', now: new Date(2026, 9, 13, 9, 5), id: 't-aaaaaa' });
  ok(/^# TODO_LIST\n\n- \[ \] \(2026-10-13 09:05\) \[correction\] Premier <!-- id:t-aaaaaa -->\n$/.test(a.text), 'add : ligne datée, typée, identifiée', a.text);
  const before = FIXTURE.split('\n');
  const after = setStatus(FIXTURE, { match: 'gel périodique' }, 'done', { by: 'projet-a', now: new Date(2026, 9, 13, 11, 0), project: 'chef' }).split('\n');
  const changed = before.map((l, k) => l !== after[k] ? k : -1).filter(k => k >= 0);
  ok(changed.length === 1 && /^- \[x\] \(2026-09-16\) \*\*projet-a — gel périodique\*\* → EN COURS : dispatché correctif → fait \(2026-10-13 11:00\) par projet-a <!-- id:h-[0-9a-f]{10} -->$/.test(after[changed[0]]), 'done : [x], « → fait (date) par <musicien> », identifiant fixé', after[changed[0]]);
  const re = parseTodo(after.join('\n'), { project: 'chef' }).find(i => i.title.includes('gel périodique'));
  ok(re.doneBy === 'projet-a' && re.id === by('gel périodique').id, 'relu : nom enregistré, même identifiant');
  let threw = null; try { setStatus(FIXTURE, { match: 'projet-a' }, 'done', { by: 'x' }); } catch (e) { threw = e.message; }
  ok(/2 items correspondent/.test(threw || ''), `extrait ambigu refusé (${threw})`);

  console.log('\n── 5. todo.mjs : seul le musicien coche, pendant son tour, et son nom est enregistré');
  const projA = path.join(T, 'proj-a'), projB = path.join(T, 'proj-b'), chefDir = path.join(T, 'chef');
  for (const d of [projA, projB, chefDir]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', projects: [{ name: 'chef', path: chefDir }, { name: 'a', path: projA }, { name: 'b', path: projB }] }));
  const cli = (args, turn) => {
    const env = { ...process.env, ORCH_TODO_ROOT: T };
    delete env.ORCH_TURN_PROJECT;
    if (turn) env.ORCH_TURN_PROJECT = turn;
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'todo.mjs'), ...args], { encoding: 'utf8', env, windowsHide: true });
  };
  const fa = path.join(projA, TODO_FILE);
  let r = cli(['add', '--type', 'fonctionnalite', 'Panneau TODO'], 'a');
  ok(r.status === 0 && /- \[ \] \(\d{4}-\d\d-\d\d \d\d:\d\d\) \[fonctionnalite\] Panneau TODO <!-- id:t-[0-9a-f]{6} -->/.test(read(fa)), 'add pendant le tour de a : fichier créé, ligne datée', r.stderr);
  cli(['add', 'Deuxième item'], 'a');
  const id = /id:(t-[0-9a-f]{6})/.exec(read(fa))[1];
  const snap = read(fa);
  r = cli(['done', id]);
  ok(r.status === 3 && /seul un musicien coche/.test(r.stderr) && read(fa) === snap, 'done hors d’un tour : refusé (code 3), fichier intact');
  r = cli(['start', id]);
  ok(r.status === 3, 'start hors d’un tour : refusé');
  r = cli(['start', id], 'a');
  ok(r.status === 0 && /- \[~\]/.test(read(fa)), 'start : [~]');
  r = cli(['done', id], 'a');
  const item = parseTodo(read(fa), { project: 'a' }).find(i => i.id === id);
  ok(r.status === 0 && item.status === 'done' && item.doneBy === 'a' && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(item.doneAt), `done pendant le tour : coché, nom « a » et heure enregistrés (${item.doneBy}, ${item.doneAt})`);
  ok(read(fa).split('\n').filter(l => /Deuxième item/.test(l) && /^- \[ \]/.test(l)).length === 1, 'l’autre item n’a pas bougé');
  r = cli(['add', '--project', 'b', 'Intrusion'], 'a');
  ok(r.status === 3 && !fs.existsSync(path.join(projB, TODO_FILE)), 'un musicien n’écrit pas dans la liste d’un autre (code 3)');
  fs.writeFileSync(path.join(projB, TODO_FILE), '- [ ] Item de b sans date\n');
  r = cli(['done', '--project', 'b', '--match', 'Item de b'], 'chef');
  ok(r.status === 0 && parseTodo(read(path.join(projB, TODO_FILE)), { project: 'b' })[0].doneBy === 'chef', 'le chef peut cocher chez un autre : son nom est enregistré');
  r = cli(['done', '--match', 'e'], 'a');   // « Panneau TODO » and « Deuxième item »
  ok(r.status === 2 && !fs.existsSync(`${fa}.lock`), 'extrait ambigu : code 2, aucun verrou laissé');
  r = cli(['add', 'X'], 'inconnu');
  ok(r.status === 3, 'projet hors de config.json : refusé');
  r = cli(['done', id, '--by', 'quelquun'], 'a');
  ok(!/quelquun/.test(read(fa)), 'le nom ne vient jamais d’un argument');

  console.log('\n── 6. Câblage : lecture seule, panneau réutilisable, consigne aux musiciens');
  const srv = read(path.join(ROOT, 'server.js'));
  ok(/app\.get\('\/api\/todo'/.test(srv) && !/app\.(post|put|patch|delete)\('\/api\/todo/.test(srv), 'GET /api/todo seulement, aucune route d’écriture');
  ok(/sidePanel: config\.ui\?\.sidePanel !== false/.test(srv), 'interrupteur ui.sidePanel');
  const html = read(path.join(ROOT, 'public', 'index.html'));
  ok(/side-panel\.js/.test(html) && /todo-panel\.js/.test(html) && /id="btn-todo"[^>]*data-sp-open="todo"/.test(html), 'index.html : panneau, onglet TODO, pill');
  const tp = read(path.join(ROOT, 'public', 'todo-panel.js'));
  ok(/type="checkbox" class="ti-box" disabled/.test(tp) && !/method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(tp), 'cases désactivées, aucun envoi vers le serveur');
  const sp = read(path.join(ROOT, 'public', 'side-panel.js'));
  ok(/register\(def\)/.test(sp) && /\[data-sp-open\]/.test(sp) && /globalThis\.SidePanel = \{ register, open, close, toggle/.test(sp), 'panneau générique (register / data-sp-open) réutilisable pour l’onglet git');
  const disp = read(path.join(ROOT, 'scripts', 'dispatch.mjs'));
  ok(/if \(projectName !== CONDUCTOR\) prompt = prompt \+ todoRule\(\);/.test(disp) && /todo\.mjs/.test(disp), 'dispatch.mjs : consigne TODO dans le prompt des musiciens');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
