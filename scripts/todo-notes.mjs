// ============================================================================
// scripts/todo-notes.mjs — notes on the musicians' TODO items (0.78.0)
// ----------------------------------------------------------------------------
// User request (2026-10-13, part 2/5): « Possibilité d'y ajouter des notes »
// in the item overlay of the side panel.
//
// The notes are the USER's, so they live with the orchestrator, in
// `todo-notes.json` at its root (unversioned, like permission-rules.json),
// never in the musicians' TODO_LIST.md: the lists stay written by the
// musicians only (scripts/todo.mjs). Keyed by project + item id; a legacy
// item keeps its derived id when it is ticked (todo-core writes it down), so
// its notes stay attached.
//
// File: {version: 1, notes: {"<project>": {"<item id>": [{id, at, text, by}]}}}
// A file that cannot be read is never overwritten: writes are refused until
// it is fixed by hand, so no note is lost.
// ============================================================================

import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeFileAtomic } from './atomic-file.mjs';
import { stamp } from './todo-core.mjs';

export const NOTES_FILE = 'todo-notes.json';
export const NOTE_MAX = 4000;
export const NOTES_PER_ITEM_MAX = 200;
export const ITEM_ID_RE = /^[A-Za-z0-9-]{3,40}$/;
const PROJECT_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Text of a note as stored: CRLF → LF, trimmed; null when empty. */
export function cleanNote(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\r\n?/g, '\n').trim();
  return t ? t : null;
}

export function createNotesStore(file) {
  let cache = { key: null, data: { version: 1, notes: {} }, error: null };

  function read() {
    let st;
    try { st = fs.statSync(file); } catch { cache = { key: 'none', data: { version: 1, notes: {} }, error: null }; return cache; }
    const key = `${st.mtimeMs}:${st.size}`;
    if (cache.key === key) return cache;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || typeof data.notes !== 'object' || Array.isArray(data.notes)) throw new Error('champ « notes » absent');
      cache = { key, data, error: null };
    } catch (e) {
      // Keep serving the last good notes; writes are refused (see add()).
      cache = { key, data: cache.data, error: `${file} illisible : ${e.message}` };
    }
    return cache;
  }

  function forItem(project, id) {
    const list = read().data.notes?.[project]?.[id];
    return Array.isArray(list) ? list : [];
  }

  /** → {note, notes} ; throws {status, message} on a refused write. */
  function add(project, id, text, { now = new Date(), by = 'utilisateur' } = {}) {
    const fail = (status, message) => Object.assign(new Error(message), { status });
    if (!PROJECT_RE.test(String(project))) throw fail(400, 'projet invalide');
    if (!ITEM_ID_RE.test(String(id))) throw fail(400, 'identifiant d’item invalide');
    const t = cleanNote(text);
    if (!t) throw fail(400, 'note vide');
    if (t.length > NOTE_MAX) throw fail(413, `note trop longue (${t.length} caractères, ${NOTE_MAX} au plus)`);
    const cur = read();
    if (cur.error) throw fail(409, `${cur.error} — aucune note n’est écrite tant qu’il n’est pas réparé`);
    const data = structuredClone(cur.data);
    data.version = 1;
    const byProject = data.notes[project] || (data.notes[project] = {});
    const list = byProject[id] || (byProject[id] = []);
    if (list.length >= NOTES_PER_ITEM_MAX) throw fail(409, `${NOTES_PER_ITEM_MAX} notes au plus par item`);
    const note = { id: 'n-' + crypto.randomBytes(4).toString('hex'), at: stamp(now).replace(' ', 'T'), text: t, by };
    list.push(note);
    writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
    cache = { key: null, data, error: null };
    return { note, notes: list };
  }

  return { forItem, add, error: () => read().error };
}
