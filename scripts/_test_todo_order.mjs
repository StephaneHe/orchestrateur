#!/usr/bin/env node
// Order of the TODO items (0.83.0). User request (2026-10-13), part 5/5:
// « Chaque item est drag & dropable, et les positions doivent persister. »
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOrder, cleanOrder, createOrderStore, itemKey, ORDER_FILE } from './todo-order.mjs';
import { sortTodo } from './todo-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const read = (f) => fs.readFileSync(f, 'utf8');

const it = (project, id, status, addedAt, line = 1) => ({ project, id, status, addedAt, line, title: id });
const items = sortTodo([
  it('a', 't-a1', 'todo', '2026-10-13T08:00'),
  it('a', 't-a2', 'todo', '2026-10-12T08:00'),
  it('b', 't-b1', 'progress', '2026-10-11T08:00'),
  it('b', 't-b2', 'todo', '2026-10-10T08:00'),
  it('a', 't-a3', 'done', '2026-10-09T08:00'),
  it('b', 't-b3', 'done', '2026-10-08T08:00'),
]);
const keys = (list) => list.map(itemKey).join(' ');

console.log('── 1. applyOrder: the user\'s order, the two parts kept');
ok(keys(applyOrder(items, [])) === keys(items), 'sans ordre : le tri par défaut (non faits récents en haut, faits en bas)');
let o = applyOrder(items, ['b/t-b2', 'a/t-a1', 'b/t-b1', 'a/t-a2']);
ok(keys(o) === 'b/t-b2 a/t-a1 b/t-b1 a/t-a2 a/t-a3 b/t-b3', `ordre de l’utilisateur appliqué : ${keys(o)}`);
o = applyOrder(items, ['b/t-b3', 'a/t-a1', 'a/t-a3']);
ok(o.findIndex(i => i.status === 'done') === 4 && keys(o).startsWith('a/t-a2 b/t-b1 b/t-b2 a/t-a1') && keys(o).endsWith('b/t-b3 a/t-a3'),
  `un fait ne remonte jamais parmi les non faits ; les jamais placés d’abord (plus récents en haut) : ${keys(o)}`);
o = applyOrder(items, ['zz/t-gone', 'b/t-b2']);
ok(o.length === items.length && keys(o).startsWith('a/t-a1 a/t-a2 b/t-b1 b/t-b2'), 'clé inconnue ignorée, aucun item perdu ni dupliqué');

console.log('\n── 2. cleanOrder: validation of the posted list');
const known = (p, id) => ['a/t-a1', 'a/t-a2', 'b/t-b1'].includes(`${p}/${id}`);
ok(JSON.stringify(cleanOrder(['a/t-a2', 'a/t-a1', 'a/t-a2', 'b/t-gone', 'b/t-b1'], known)) === '["a/t-a2","a/t-a1","b/t-b1"]', 'doublons et items disparus retirés');
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.status || -1; } };
ok(throws(() => cleanOrder('a/t-a1')) === 400, 'pas une liste : 400');
ok(throws(() => cleanOrder(['../etc/passwd'])) === 400 && throws(() => cleanOrder(['a/t a1'])) === 400 && throws(() => cleanOrder([42])) === 400, 'clé mal formée : 400 (jamais de chemin)');
ok(throws(() => cleanOrder(new Array(5001).fill('a/t-a1'))) === 413, 'liste trop longue : 413');
ok(cleanOrder([]).length === 0, 'liste vide acceptée (retour au tri par défaut)');

console.log('\n── 3. Store: persisted, reread by a new store (= a server restart)');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-order-'));
try {
  const file = path.join(T, ORDER_FILE);
  const s1 = createOrderStore(file);
  ok(s1.order().length === 0 && !s1.error(), 'sans fichier : ordre vide, pas d’erreur');
  s1.set(['b/t-b2', 'a/t-a1']);
  const s2 = createOrderStore(file);
  ok(JSON.stringify(s2.order()) === '["b/t-b2","a/t-a1"]', 'relu par un nouveau magasin : l’ordre survit au redémarrage');
  ok(JSON.parse(read(file)).version === 1 && !fs.existsSync(file + '.tmp'), 'fichier versionné, écriture atomique');
  fs.writeFileSync(file, '{ cassé');
  const s3 = createOrderStore(file);
  ok(/illisible/.test(s3.error() || ''), 'fichier illisible : signalé');
  ok(throws(() => s3.set(['a/t-a1'])) === 409 && read(file) === '{ cassé', 'fichier illisible : jamais réécrit (409)');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log('\n── 4. Wiring: route, GET, panel');
const srv = read(path.join(ROOT, 'server.js'));
ok(/app\.post\('\/api\/order\/todo', sameOriginOnly/.test(srv), 'POST /api/order/todo, même origine seulement');
ok(/items: applyOrder\(sortTodo\(all\), todoOrder\.order\(\)\)/.test(srv), 'GET /api/todo rend les items dans l’ordre enregistré');
ok(!/app\.(post|put|patch|delete)\('\/api\/todo/.test(srv), 'toujours aucune route d’écriture sur /api/todo');
const tp = read(path.join(ROOT, 'public', 'todo-panel.js'));
ok(/addEventListener\("pointerdown", onPointerDown\)/.test(tp) && /DRAG_THRESHOLD = 6/.test(tp) && /suppressClickUntil/.test(tp), 'panneau : glisser au pointeur, seuil, pas d’overlay après un glisser');
ok(/e\.altKey && \(e\.key === "ArrowUp" \|\| e\.key === "ArrowDown"\)/.test(tp), 'panneau : déplacement au clavier (Alt+↑ / Alt+↓)');
ok(/fetch\("\/api\/order\/todo"/.test(tp), 'panneau : ordre envoyé au serveur');
ok(/^todo-order\.json$/m.test(read(path.join(ROOT, '.gitignore'))), 'todo-order.json hors de git');

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
