#!/usr/bin/env node
// ============================================================================
// scripts/_test_todo_reject.mjs — rejecting a TODO item (0.85.0, part 3/5)
// ============================================================================
// User request (2026-10-13): « Possibilité […] de rejetter l'item », then the
// user's choice, verbatim: « Rejet d'un item : le rejet est marqué dans le
// TODO_LIST.md du musicien. Dans l'UI passe le dans la liste des "faits" mais
// barre, avec une marque « rejeté (date) par l'utilisateur » ».
// Checks the line written in the musician's list (only that line changes,
// dated, by the user), how it is read back (closed, with the done ones,
// `rejected`), the refusals, and the wiring of the panel.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTodo, sortTodo, countTodo, rejectItem, setStatus } from './todo-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const read = (f) => fs.readFileSync(f, 'utf8');
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

console.log('── 1. The rejection is written in the musician’s TODO_LIST.md, on that line only');
const list = [
  '# TODO_LIST', '',
  '- [ ] (2026-10-12 08:00) [correction] Bouton mal aligné <!-- id:t-r00001 -->',
  '- [~] (2026-10-11 08:00) En cours de travail <!-- id:t-r00002 -->',
  '- [x] (2026-10-10 08:00) Déjà fait → fait (2026-10-11 09:00) par alpha <!-- id:t-r00003 -->',
  '- [ ] Ligne ancienne sans date ni id',
].join('\n') + '\n';
const now = new Date(2026, 9, 13, 18, 40);
const after = rejectItem(list, { id: 't-r00001' }, { now, project: 'alpha' });
const changed = list.split('\n').map((l, n) => l === after.split('\n')[n] ? null : n).filter(n => n != null);
ok(changed.length === 1 && changed[0] === 2, `une seule ligne modifiée (${changed.join(',')})`);
ok(after.split('\n')[2] === "- [x] (2026-10-12 08:00) [correction] Bouton mal aligné → rejeté (2026-10-13 18:40) par l'utilisateur <!-- id:t-r00001 -->", `ligne écrite : ${after.split('\n')[2]}`);
const prog = rejectItem(after, { id: 't-r00002' }, { now, project: 'alpha' });
ok(/^- \[x\] \(2026-10-11 08:00\) En cours de travail → rejeté \(2026-10-13 18:40\) par l'utilisateur <!-- id:t-r00002 -->$/m.test(prog), 'un item en cours peut être rejeté');
const legacyId = parseTodo(list, { project: 'alpha' }).find(i => i.title === 'Ligne ancienne sans date ni id').id;
const leg = rejectItem(list, { id: legacyId }, { now, project: 'alpha' });
ok(leg.includes(`- [x] Ligne ancienne sans date ni id → rejeté (2026-10-13 18:40) par l'utilisateur <!-- id:${legacyId} -->`), 'ligne ancienne : son identifiant est écrit, il reste le même');

console.log('\n── 2. Read back: closed, with the done ones, « rejeté (date) par l’utilisateur »');
const items = parseTodo(prog, { project: 'alpha' });
const r = items.find(i => i.id === 't-r00001');
ok(r.status === 'done' && r.rejected?.at === '2026-10-13T18:40' && r.rejected.by === 'utilisateur', `relu : ${JSON.stringify({ s: r.status, rej: r.rejected })}`);
ok(r.title === 'Bouton mal aligné' && r.type === 'correction' && r.addedAt === '2026-10-12T08:00' && !r.doneBy && !r.manual, 'titre, type et date d’entrée intacts ; pas « coché à la main »');
const sorted = sortTodo(items);
ok(sorted.findIndex(i => i.id === 't-r00001') > sorted.findIndex(i => i.status !== 'done' && !i.rejected) && sorted.filter(i => i.status !== 'done').every(i => !i.rejected), 'rangé avec les faits, après les non faits');
const c = countTodo(items);
ok(c.rejected === 2 && c.open === 1 && c.done === 3, `compteurs : ${JSON.stringify(c)}`);

console.log('\n── 3. Refusals');
let e = throws(() => rejectItem(after, { id: 't-r00001' }, { now }));
ok(e?.code === 'closed' && /déjà rejeté/.test(e.message), 'déjà rejeté : refusé');
e = throws(() => rejectItem(list, { id: 't-r00003' }, { now }));
ok(e?.code === 'closed' && /déjà fait/.test(e.message), 'déjà fait : refusé (un fait ne se rejette pas)');
e = throws(() => rejectItem(list, { id: 't-absent' }, { now }));
ok(e && /^aucun item/.test(e.message), 'item inconnu : refusé');
const reopened = setStatus(after, { id: 't-r00001' }, 'todo');
ok(reopened.split('\n')[2] === '- [ ] (2026-10-12 08:00) [correction] Bouton mal aligné <!-- id:t-r00001 -->', 'todo.mjs peut rouvrir l’item : la marque de rejet disparaît');

console.log('\n── 4. Wiring: route, panel (action, confirmation, display)');
const srv = read(path.join(ROOT, 'server.js'));
ok(/app\.post\('\/api\/reject\/todo\/:project\/:id', sameOriginOnly/.test(srv), 'POST /api/reject/todo/:projet/:item, même origine');
const tp = read(path.join(ROOT, 'public', 'todo-panel.js'));
ok(/id: "reject", label: "Rejeter l’item…"/.test(tp) && /when: \(i\) => i\.status !== "done"/.test(tp), 'action « Rejeter l’item… », seulement sur un item ouvert');
ok(/function askReject/.test(tp) && /class="tov-reject"/.test(tp) && /tov-reject-cancel/.test(tp), 'confirmation avant le rejet (annulable)');
ok(/✕ rejeté \(\$\{esc\(fmt\(i\.rejected\.at\)\)\}\) par l’utilisateur/.test(tp) && /is-rejected/.test(tp), 'liste : « ✕ rejeté (date) par l’utilisateur », item barré');
const css = read(path.join(ROOT, 'public', 'side-panel.css'));
ok(/\.todo-item\.is-done \.ti-title \{[^}]*line-through/.test(css), 'un item de la partie « faits » est barré');

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
