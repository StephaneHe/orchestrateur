#!/usr/bin/env node
// Notes on TODO items (0.78.0) — user request (2026-10-13), part 2/5:
// « Possibilité d'y ajouter des notes ». The notes must be kept by the server
// (todo-notes.json): they survive a page reload and a server restart, and the
// musicians' TODO_LIST.md files are never written by them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNotesStore, cleanNote, NOTE_MAX, NOTES_PER_ITEM_MAX, NOTES_FILE } from './todo-notes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-notes-'));
try {
  const file = path.join(T, NOTES_FILE);

  console.log('── 1. Ajout et relecture');
  const s1 = createNotesStore(file);
  ok(s1.forItem('alpha', 't-a10003').length === 0 && !fs.existsSync(file), 'aucune note, aucun fichier au départ');
  const r = s1.add('alpha', 't-a10003', '  Première note\r\nsur deux lignes  ', { now: new Date(2026, 9, 13, 14, 5) });
  ok(r.note.text === 'Première note\nsur deux lignes' && r.note.at === '2026-10-13T14:05' && r.note.by === 'utilisateur' && /^n-[0-9a-f]{8}$/.test(r.note.id), 'note nettoyée, datée, attribuée à l’utilisateur', JSON.stringify(r.note));
  s1.add('alpha', 't-a10003', 'Deuxième');
  s1.add('beta', 'h-0123456789', 'Autre projet');
  ok(s1.forItem('alpha', 't-a10003').map(n => n.text).join('|') === 'Première note\nsur deux lignes|Deuxième', 'ordre d’ajout conservé');
  ok(s1.forItem('beta', 'h-0123456789').length === 1 && s1.forItem('alpha', 'h-0123456789').length === 0, 'notes rangées par projet et par item');

  console.log('\n── 2. Survit au redémarrage du serveur (le fichier est la seule source)');
  const s2 = createNotesStore(file);
  ok(s2.forItem('alpha', 't-a10003').length === 2 && s2.forItem('beta', 'h-0123456789')[0].text === 'Autre projet', 'un nouveau magasin sur le même fichier relit toutes les notes');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(disk.version === 1 && disk.notes.alpha['t-a10003'].length === 2, 'format sur disque {version, notes:{projet:{item:[…]}}}');
  // An edit made outside (by hand, or another process) is seen without restart.
  disk.notes.alpha['t-a10003'].push({ id: 'n-0000beef', at: '2026-10-13T15:00', text: 'ajoutée à la main', by: 'utilisateur' });
  fs.writeFileSync(file, JSON.stringify(disk) + '\n');
  ok(s1.forItem('alpha', 't-a10003').length === 3, 'le fichier modifié est relu (cache par date et taille)');
  ok(!fs.existsSync(file + '.tmp'), 'écriture atomique : aucun .tmp laissé');

  console.log('\n── 3. Refus');
  ok(throws(() => s1.add('alpha', 't-a10003', '   '))?.status === 400, 'note vide → 400');
  ok(throws(() => s1.add('alpha', 't-a10003', 'x'.repeat(NOTE_MAX + 1)))?.status === 413, `plus de ${NOTE_MAX} caractères → 413`);
  ok(s1.add('alpha', 't-a10004', 'y'.repeat(NOTE_MAX)).note.text.length === NOTE_MAX, `${NOTE_MAX} caractères tout juste : acceptée`);
  ok(throws(() => s1.add('alpha', '../x', 'a'))?.status === 400 && throws(() => s1.add('a/b', 't-a10003', 'a'))?.status === 400, 'identifiant ou projet invalide → 400');
  ok(cleanNote(null) === null && cleanNote(42) === null, 'texte non textuel refusé');
  const cap = createNotesStore(path.join(T, 'cap.json'));
  for (let k = 0; k < NOTES_PER_ITEM_MAX; k++) cap.add('p', 't-cap001', `n${k}`);
  ok(throws(() => cap.add('p', 't-cap001', 'une de trop'))?.status === 409 && cap.forItem('p', 't-cap001').length === NOTES_PER_ITEM_MAX, `${NOTES_PER_ITEM_MAX} notes au plus par item`);

  console.log('\n── 4. Fichier illisible : rien n’est perdu');
  const bad = path.join(T, 'bad.json');
  fs.writeFileSync(bad, '{ pas du json');
  const sb = createNotesStore(bad);
  const e = throws(() => sb.add('p', 't-bad001', 'note'));
  ok(e?.status === 409 && /illisible/.test(e.message) && fs.readFileSync(bad, 'utf8') === '{ pas du json', 'écriture refusée (409), fichier intact', e?.message);
  ok(sb.forItem('p', 't-bad001').length === 0 && /illisible/.test(sb.error() || ''), 'lecture : aucune note, erreur signalée');
  const good = createNotesStore(path.join(T, 'good.json'));
  good.add('p', 't-good01', 'avant');
  fs.writeFileSync(path.join(T, 'good.json'), 'cassé');
  ok(good.forItem('p', 't-good01')[0]?.text === 'avant' && throws(() => good.add('p', 't-good01', 'après'))?.status === 409, 'fichier cassé après coup : les dernières notes connues restent affichées, aucune écriture');

  console.log('\n── 5. Câblage');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/app\.post\('\/api\/notes\/todo\/:project\/:id', sameOriginOnly,/.test(srv), 'POST /api/notes/todo/:project/:id, même origine seulement');
  ok(/todoNotes\.forItem\(p\.name, i\.id\)/.test(srv), 'GET /api/todo joint les notes à chaque item');
  ok(!/writeFileSync\([^)]*TODO_FILE|appendFileSync\([^)]*TODO_FILE/.test(srv), 'le serveur n’écrit jamais un TODO_LIST.md');
  ok(/^todo-notes\.json$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')), 'todo-notes.json non versionné');
  const panel = fs.readFileSync(path.join(ROOT, 'public', 'todo-panel.js'), 'utf8');
  ok(/\/api\/notes\/todo\//.test(panel) && /tov-note-form/.test(panel) && /drafts/.test(panel), 'overlay : formulaire de note, brouillon gardé');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
