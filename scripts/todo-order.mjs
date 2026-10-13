// ============================================================================
// scripts/todo-order.mjs — the user's order of the TODO items (0.83.0)
// ----------------------------------------------------------------------------
// User request (2026-10-13, part 5/5): « Chaque item est drag & dropable, et
// les positions doivent persister. »
//
// The order is the USER's, so it lives with the orchestrator, in
// `todo-order.json` at its root (unversioned), never in the musicians'
// TODO_LIST.md. One global ranked list of keys "<project>/<item id>", so the
// "all projects" view and a single-project view agree.
//
// Applied on top of the default sort (sortTodo): the two parts stay — open
// items on top, done ones below (user request of 0.76.2). Inside a part, items
// the user never placed (new ones) come first, newest first as before, then
// the placed ones in the user's order.
//
// File: {version: 1, order: ["<project>/<id>", ...], updatedAt}. A file that
// cannot be read is never overwritten: writes are refused until it is fixed.
// ============================================================================

import fs from 'node:fs';
import { writeFileAtomic } from './atomic-file.mjs';
import { ITEM_ID_RE } from './todo-notes.mjs';

export const ORDER_FILE = 'todo-order.json';
export const ORDER_MAX = 5000;
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9-]{3,40}$/;

export const itemKey = (i) => `${i.project}/${i.id}`;
const part = (i) => (i.status === 'done' ? 'done' : 'open');

/** Default-sorted items → items in the user's order (parts kept). */
export function applyOrder(sorted, order) {
  const rank = new Map((Array.isArray(order) ? order : []).map((k, n) => [k, n]));
  const out = [];
  for (const p of ['open', 'done']) {
    const inPart = sorted.filter(i => part(i) === p);
    const fresh = inPart.filter(i => !rank.has(itemKey(i)));
    const placed = inPart.filter(i => rank.has(itemKey(i))).sort((a, b) => rank.get(itemKey(a)) - rank.get(itemKey(b)));
    out.push(...fresh, ...placed);
  }
  return out;
}

/** Validated key list, or throws {status, message}. `known(project, id)`
 *  says whether the item exists; unknown items are dropped, not refused (an
 *  item may have left a list between the page's read and the drop). */
export function cleanOrder(keys, known = () => true) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!Array.isArray(keys)) throw fail(400, 'liste « keys » attendue');
  if (keys.length > ORDER_MAX) throw fail(413, `${ORDER_MAX} items au plus`);
  const seen = new Set(), out = [];
  for (const k of keys) {
    if (typeof k !== 'string' || !KEY_RE.test(k)) throw fail(400, `clé d’item invalide : ${String(k).slice(0, 80)}`);
    const [project, id] = k.split('/');
    if (!ITEM_ID_RE.test(id)) throw fail(400, `identifiant d’item invalide : ${id}`);
    if (seen.has(k) || !known(project, id)) continue;
    seen.add(k); out.push(k);
  }
  return out;
}

export function createOrderStore(file) {
  let cache = { key: null, data: { version: 1, order: [] }, error: null };

  function read() {
    let st;
    try { st = fs.statSync(file); } catch { cache = { key: 'none', data: { version: 1, order: [] }, error: null }; return cache; }
    const key = `${st.mtimeMs}:${st.size}`;
    if (cache.key === key) return cache;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || !Array.isArray(data.order)) throw new Error('champ « order » absent');
      cache = { key, data, error: null };
    } catch (e) {
      cache = { key, data: cache.data, error: `${file} illisible : ${e.message}` };
    }
    return cache;
  }

  /** Replaces the whole order (an empty list goes back to the default sort). */
  function set(keys, { now = new Date() } = {}) {
    const cur = read();
    if (cur.error) throw Object.assign(new Error(`${cur.error} — l’ordre n’est pas enregistré tant qu’il n’est pas réparé`), { status: 409 });
    const data = { version: 1, order: keys, updatedAt: now.toISOString() };
    writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
    cache = { key: null, data, error: null };
    return data;
  }

  return { order: () => read().data.order, set, error: () => read().error };
}
