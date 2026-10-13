// ============================================================================
// scripts/queue-order.mjs — reordering a musician's queue (0.86.0)
// ----------------------------------------------------------------------------
// User request (2026-10-13): « il faut pouvoir drag & drop les éléments de la
// file d'attente, et que celà ai un impacte sur l'ordre de traitement ».
//
// The server's in-memory queue is the source of truth (the sidecar
// logs/queue/<p>.json is rewritten from it, never edited): the drain always
// launches the head, so the order applied here IS the order of execution.
//
// The client sends the ids in the order it shows. Between its read and the
// drop the queue may have moved: an entry may have been launched or removed
// (it is no longer in the queue — a started entry can never be moved), and
// new entries may have arrived. Pure merge, no loss, no duplicate:
//   - the posted ids still queued come first, in the posted order;
//   - entries the client did not know (arrived meanwhile) keep their place
//     relative to each other, after them;
//   - posted ids no longer queued are ignored and reported.
// ============================================================================

export const QUEUE_ORDER_MAX = 500;
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Validated, de-duplicated id list, or throws {status, message}. */
export function cleanQueueIds(ids) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!Array.isArray(ids)) throw fail(400, 'liste « ids » attendue');
  if (ids.length > QUEUE_ORDER_MAX) throw fail(413, `${QUEUE_ORDER_MAX} entrées au plus`);
  const seen = new Set(), out = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail(400, `identifiant d’entrée invalide : ${String(id).slice(0, 80)}`);
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/** entries (queue order) + wanted ids → {entries, missing, appended, changed} */
export function reorderQueue(entries, ids) {
  const byId = new Map(entries.map(e => [e.id, e]));
  const placed = [], missing = [];
  for (const id of ids) {
    if (byId.has(id)) placed.push(byId.get(id)); else missing.push(id);
  }
  const placedIds = new Set(placed.map(e => e.id));
  const appended = entries.filter(e => !placedIds.has(e.id));
  const next = [...placed, ...appended];
  const changed = next.some((e, i) => e !== entries[i]);
  return { entries: next, missing, appended: appended.map(e => e.id), changed };
}
