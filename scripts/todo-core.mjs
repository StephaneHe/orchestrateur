// ============================================================================
// scripts/todo-core.mjs — reads and edits a musician's TODO_LIST.md (0.75.0)
// ============================================================================
//
// User request (2026-10-13): the dashboard shows each musician's TODO list,
// read-only, each part newest first by entry date, with the name of the
// musician who ticked each done item. Order of the parts (0.76.2, user request
// of 2026-10-13 replacing "done first"): OPEN items on top, DONE items below.
//
// Format (Markdown, compatible with the existing files):
//   - [ ] (2026-10-13 09:12) [correction] Title <!-- id:t-7f3a1c -->
//   - [~] (2026-10-13 09:12) Title <!-- id:… -->                   in progress
//   - [x] (2026-10-12 18:40) Title → fait (2026-10-13 10:02) par orchestrateur-dev <!-- id:… -->
//   - [x] (2026-10-12 18:40) Title → rejeté (2026-10-13 18:40) par l'utilisateur <!-- id:… -->
// A rejected item (0.85.0, user choice « le rejet est marqué dans le
// TODO_LIST.md du musicien ») is closed ("[x]", so it sits with the done
// ones) and carries `rejected: {at, by}`; only the dashboard writes it.
// The date in parentheses is the ENTRY date (the chef already writes it). The
// "→ fait (…) par <musician>" suffix is written only by scripts/todo.mjs, from
// the turn's ORCH_TURN_PROJECT: an item ticked by hand has no recorded name.
// Older lines are read as they are: no date → the file's modification time,
// flagged as an estimate; a legacy "→ FAIT …" text stays part of the detail.
// Pure functions, no I/O: the server, the CLI and the tests share them.
// ============================================================================

import crypto from 'node:crypto';

export const TODO_FILE = 'TODO_LIST.md';
export const TODO_TYPES = ['projet', 'fonctionnalite', 'correction', 'autre'];

const BOX_RE = /^(\s*[-*]\s+\[)([ xX~])(\]\s?)(.*)$/;
const DATE_RE = /^\((\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\)\s*/;
const TYPE_RE = /^\[(projet|fonctionnalit[eé]|correction|autre)\]\s*/i;
const ID_RE = /\s*<!--\s*id:([A-Za-z0-9-]{3,40})\s*-->\s*$/;
const DONE_RE = /\s*→\s*fait \((\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\) par ([A-Za-z0-9_.-]{1,64})\s*$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const REJECTED_RE = /\s*→\s*rejeté \((\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\) par l'utilisateur\s*$/;
export const REJECTED_BY = 'utilisateur';
const DETAIL_MAX = 400;

const pad = (n) => String(n).padStart(2, '0');
/** Local "YYYY-MM-DD HH:MM" of a Date (the files are written in local time). */
export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const iso = (day, hm) => `${day}T${hm || '00:00'}`;

/** Stable id for a line written without one (legacy lines). */
function derivedId(project, body) {
  return 'h-' + crypto.createHash('sha1').update(`${project}\n${body}`).digest('hex').slice(0, 10);
}

/**
 * Splits "**Title** → detail" (legacy chef lines) into title and detail.
 * `detail` is cut for the list; `detailFull` keeps the whole text (item
 * overlay, 0.77.0) and is only set when the cut happened.
 */
function splitTitle(text) {
  const clean = text.replace(/\*\*/g, '').trim();
  const i = clean.indexOf(' → ');
  const title = (i > 0 ? clean.slice(0, i) : clean).trim();
  const detail = i > 0 ? clean.slice(i + 3).trim() : '';
  return detail.length > DETAIL_MAX
    ? { title, detail: detail.slice(0, DETAIL_MAX) + '…', detailFull: detail }
    : { title, detail };
}

/**
 * Indented lines right under an item belong to it (multi-line items of the
 * fleet's lists); a blank line, an unindented line or another box ends them.
 */
function continuationOf(lines, idx) {
  const out = [];
  for (let j = idx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!/^\s+\S/.test(l) || BOX_RE.test(l)) break;
    out.push(l.trim());
  }
  return out.join('\n');
}

/**
 * Parses a TODO_LIST.md. → items [{id, project, line, status: done|progress|
 * todo, title, detail, detailFull?, more?, type, addedAt, addedEstimated,
 * doneAt, doneBy, manual}]
 * `fileMtime` (Date) dates the lines written without an entry date.
 */
export function parseTodo(text, { project = '', fileMtime = null } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const est = fileMtime ? stamp(fileMtime).replace(' ', 'T') : null;
  const items = [];
  lines.forEach((raw, idx) => {
    const m = BOX_RE.exec(raw);
    if (!m) return;
    const mark = m[2].toLowerCase();
    let body = m[4];
    let id = null, doneAt = null, doneBy = null, addedAt = null, type = null, rejectedAt = null;
    const idm = ID_RE.exec(body);
    if (idm) { id = idm[1]; body = body.slice(0, idm.index); }
    const rm = REJECTED_RE.exec(body);
    if (rm) { rejectedAt = iso(rm[1], rm[2]); body = body.slice(0, rm.index); }
    const dm = DONE_RE.exec(body);
    if (dm) { doneAt = iso(dm[1], dm[2]); doneBy = dm[3]; body = body.slice(0, dm.index); }
    const idSource = body.trim();
    const am = DATE_RE.exec(body);
    if (am) { addedAt = iso(am[1], am[2]); body = body.slice(am[0].length); }
    const tm = TYPE_RE.exec(body);
    if (tm) { type = tm[1].toLowerCase().replace('é', 'e'); body = body.slice(tm[0].length); }
    const { title, detail, detailFull } = splitTitle(body);
    if (!title) return;
    const status = mark === 'x' ? 'done' : mark === '~' ? 'progress' : 'todo';
    const more = continuationOf(lines, idx);
    items.push({
      id: id || derivedId(project, idSource),
      project, line: idx + 1, status, title, detail,
      ...(detailFull ? { detailFull } : {}), ...(more ? { more } : {}),
      type: type || 'autre',
      addedAt: addedAt || est, addedEstimated: !addedAt,
      doneAt: status === 'done' ? doneAt : null,
      doneBy: status === 'done' ? doneBy : null,
      manual: status === 'done' && !doneBy && !rejectedAt,
      ...(status === 'done' && rejectedAt ? { rejected: { at: rejectedAt, by: REJECTED_BY } } : {}),
    });
  });
  return items;
}

/** Open items first (in progress + to do), then done ones; each part newest entry first. */
export function sortTodo(items) {
  const rank = (s) => (s === 'done' ? 1 : 0);
  return [...items].sort((a, b) => rank(a.status) - rank(b.status)
    || String(b.addedAt || '').localeCompare(String(a.addedAt || ''))
    // Same date (estimated, or same minute): later in the file = added later.
    || (a.project === b.project ? b.line - a.line : a.project.localeCompare(b.project)));
}

export function countTodo(items) {
  const c = { done: 0, progress: 0, todo: 0, open: 0, rejected: 0, total: items.length };
  for (const i of items) { c[i.status]++; if (i.status !== 'done') c.open++; if (i.rejected) c.rejected++; }
  return c;
}

// ---------------------------------------------------------------------------
// Edition (used by scripts/todo.mjs only)
// ---------------------------------------------------------------------------
export function newId() { return 't-' + crypto.randomBytes(3).toString('hex'); }

/** Appends a dated item; creates the list when the file is empty. → {text, id} */
export function addItem(text, { title, type = null, now = new Date(), id = newId() } = {}) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('titre vide');
  if (type && !TODO_TYPES.includes(type)) throw new Error(`type inconnu : ${type} (${TODO_TYPES.join(', ')})`);
  const line = `- [ ] (${stamp(now)})${type ? ` [${type}]` : ''} ${t} <!-- id:${id} -->`;
  const base = String(text || '');
  const head = base.trim() ? base.replace(/\s*$/, '\n') : '# TODO_LIST\n\n';
  return { text: head + line + '\n', id };
}

/**
 * Finds the one item meant by `ref` ({id} or {match: substring of the title}).
 * → {index (0-based line), item} ; throws on none / several.
 */
export function findItem(text, { id = null, match = null } = {}, project = '') {
  const items = parseTodo(text, { project });
  const hits = id ? items.filter(i => i.id === id)
    : match ? items.filter(i => i.title.toLowerCase().includes(String(match).toLowerCase())) : [];
  if (!hits.length) throw new Error(id ? `aucun item ${id}` : `aucun item ne contient « ${match} »`);
  if (hits.length > 1) throw new Error(`${hits.length} items correspondent : ${hits.map(h => h.id).join(', ')} — préciser l'identifiant`);
  return { index: hits[0].line - 1, item: hits[0] };
}

/**
 * Sets the status of one item; only that line changes.
 * done: "[x]" + "→ fait (<now>) par <by>" ; progress: "[~]" ; todo: "[ ]".
 */
export function setStatus(text, ref, status, { by = null, now = new Date(), project = '' } = {}) {
  const { index, item } = findItem(text, ref, project);
  const lines = String(text).split(/\r?\n/);
  const m = BOX_RE.exec(lines[index]);
  let body = m[4];
  const idm = ID_RE.exec(body);
  // A legacy line gets its (derived) id written down: it stays stable afterwards.
  const idPart = idm ? body.slice(idm.index) : ` <!-- id:${item.id} -->`;
  if (idm) body = body.slice(0, idm.index);
  body = body.replace(DONE_RE, '').replace(REJECTED_RE, '');
  if (status === 'done') {
    if (!by || !NAME_RE.test(by)) throw new Error('nom du musicien absent ou invalide');
    body = `${body.replace(/\s+$/, '')} → fait (${stamp(now)}) par ${by}`;
  }
  const mark = status === 'done' ? 'x' : status === 'progress' ? '~' : ' ';
  lines[index] = `${m[1]}${mark}${m[3]}${body}${idPart}`;
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
}

/**
 * Rejects one OPEN item (0.85.0): "[x]" + "→ rejeté (<now>) par l'utilisateur";
 * only that line changes. Refuses an item already done or rejected.
 */
export function rejectItem(text, ref, { now = new Date(), project = '' } = {}) {
  const { index, item } = findItem(text, ref, project);
  if (item.status === 'done') throw Object.assign(new Error(item.rejected ? 'item déjà rejeté' : 'item déjà fait : il ne peut plus être rejeté'), { code: 'closed' });
  const lines = String(text).split(/\r?\n/);
  const m = BOX_RE.exec(lines[index]);
  let body = m[4];
  const idm = ID_RE.exec(body);
  const idPart = idm ? body.slice(idm.index) : ` <!-- id:${item.id} -->`;
  if (idm) body = body.slice(0, idm.index);
  body = `${body.replace(DONE_RE, '').replace(REJECTED_RE, '').replace(/\s+$/, '')} → rejeté (${stamp(now)}) par l'utilisateur`;
  lines[index] = `${m[1]}x${m[3]}${body}${idPart}`;
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
}
