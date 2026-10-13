// ============================================================================
// scripts/todo-capture.mjs — « TODO: » lines of a user message (0.84.0)
// ----------------------------------------------------------------------------
// User request (2026-10-13): « Dans ma requete, si je commence par TODO: ,
// alors ce qui suit doit etre ajoute dans la todo list. Ce doit etre une
// fonctionalite codee dans le routeur. »
//
// Applied by dispatch.mjs at the entrance of the chef's turn, before any
// routing and without any model: every line of the user's message that starts
// with « TODO: » (any case, spaces allowed around the colon: « TODO : »,
// « todo: ») becomes an item of the CHEF's TODO_LIST.md — the list of the
// user's pending requests, shown in the dashboard's TODO panel and read by
// the Routage context. The entry has the usual format of scripts/todo.mjs:
// `- [ ] (YYYY-MM-DD HH:MM) <text after the prefix, verbatim> <!-- id:t-… -->`.
// The rest of the message is routed as before; a message made only of TODO
// lines ends without any model turn.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { TODO_FILE, addItem } from './todo-core.mjs';
import { writeFileAtomic } from './atomic-file.mjs';

const TODO_LINE_RE = /^\s*TODO\s*:\s*(.*?)\s*$/i;

/** → {todos: [text], rest} ; a prefix with nothing after it is dropped. */
export function splitTodoLines(message) {
  const todos = [], rest = [];
  for (const line of String(message || '').split(/\r?\n/)) {
    const m = TODO_LINE_RE.exec(line);
    if (!m) { rest.push(line); continue; }
    if (m[1]) todos.push(m[1]);
  }
  return { todos, rest: rest.join('\n').trim() };
}

/** Same lock as scripts/todo.mjs (`<file>.lock`, taken over after 30 s). */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (i > 200) throw new Error(`liste verrouillée (${lock})`);
      const until = Date.now() + 50; while (Date.now() < until) { /* short wait */ }
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

/** Appends the items to <dir>/TODO_LIST.md. → [{id, title}] */
export function captureTodos(dir, todos, { now = new Date() } = {}) {
  if (!todos.length) return [];
  const file = path.join(dir, TODO_FILE);
  return withLock(file, () => {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* new list */ }
    const added = [];
    for (const title of todos) {
      const r = addItem(text, { title, now });
      text = r.text;
      added.push({ id: r.id, title: title.replace(/\s+/g, ' ').trim() });
    }
    writeFileAtomic(file, text, `${file}.${process.pid}.tmp`);
    return added;
  });
}

/** Line shown to the user and appended to the routed remainder. */
export function captureText(added, listLabel) {
  return `📝 Ajouté${added.length > 1 ? 's' : ''} à la TODO list (${listLabel}) par le routeur :\n` +
    added.map(a => `- ${a.title} (${a.id})`).join('\n');
}
