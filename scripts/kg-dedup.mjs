// ============================================================================
// scripts/kg-dedup.mjs — a memory proposal is never a duplicate (0.162.0)
// ============================================================================
//
// User remark (2026-11-02): « J'ai l'impression qu'il est facile d'y avoir
// beaucoup de duplicats dans les propositions de la memoire. Ex: Lnage de
// discussion = francais ... ».
//
// Why duplicates got through: a fact id hashes its quote and source ref
// (kg.mjs factId), so the same relation re-read from a changed memory, or
// stated by another sentence, got a new id and a new proposal; nothing looked
// at pending or rejected relations, nor at a rule the whole fleet already
// carries, nor at rules a setting already applies.
//
// Pure functions, used by kg.mjs only:
//   - proposalDuplicate(cand, {facts, nodes}) → null | {kind, of, why}
//       kind: setting | rejected | pending | known | covered
//   - pendingDuplicates(facts, nodes) → [{id, of, kind, why}] (oldest kept)
// Relations are compared on ids (subject, predicate, object) the code gave the
// model: never on words. The only words read are the closed SETTING_RULES list
// (like kg.mjs CLAIM_PATTERNS), matched on the rule's own label or quote.
// ============================================================================

/** Rules a setting of the orchestrator already applies to every turn: never proposed as memory. */
export const SETTING_RULES = [
  { id: 'discussion-language', setting: 'langue de discussion (language-settings.json, injectée à chaque tour par dispatch.mjs)', re: /\blangue\s+de\s+(?:la\s+)?discussion\b/i },
];

const PENDING = new Set(['proposed', 'to_review']);
const ACCEPTED = new Set(['validated', 'observed']);
const tripleKey = (f) => `${f.s}|${f.p}|${JSON.stringify(f.o)}`;
const isProject = (o) => typeof o === 'string' && o.startsWith('projet:');

export function settingRuleOf(texts) {
  for (const t of texts) for (const r of SETTING_RULES) if (t && r.re.test(String(t))) return r;
  return null;
}

/**
 * Is `cand` (a fact about to be proposed, or a pending one) a duplicate?
 * `facts`: every other known fact (derived, curated, any status), `nodes`: id → node.
 */
export function proposalDuplicate(cand, { facts = [], nodes = {} } = {}) {
  const rule = settingRuleOf([nodes[cand.s]?.label, cand.source?.quote]);
  if (rule) return { kind: 'setting', of: rule.id, why: `règle déjà appliquée par un réglage : ${rule.setting}` };
  const key = tripleKey(cand);
  // A proposal already put away as a duplicate only points at its original, which is in `facts` itself.
  const same = facts.filter(f => f.id !== cand.id && !f.dedup && tripleKey(f) === key);
  const refused = same.find(f => f.status === 'retracted');
  if (refused) return { kind: 'rejected', of: refused.id, why: `même relation déjà refusée (${refused.id})` };
  const pending = same.find(f => PENDING.has(f.status));
  if (pending) return { kind: 'pending', of: pending.id, why: `même relation déjà proposée, en attente (${pending.id})` };
  const known = same[0];
  if (known) return { kind: 'known', of: known.id, why: `même relation déjà connue (${known.id}, ${known.status || 'observé'})` };
  if (cand.p === 'applies_to' && isProject(cand.o)) {
    // Only an accepted fleet rule covers: a merely proposed one may still be refused, and the project ones would be lost.
    const fleet = facts.find(f => f.id !== cand.id && !f.dedup && f.s === cand.s && f.p === 'applies_to' && f.o === 'flotte:fleet' && ACCEPTED.has(f.status));
    if (fleet) return { kind: 'covered', of: fleet.id, why: `déjà couvert : la règle s’applique à toute la flotte, validé (${fleet.id})` };
  }
  return null;
}

/** Fleet-wide « applies_to » first (it covers the project ones), then oldest first. */
export function proposalOrder(a, b) {
  const fa = a.p === 'applies_to' && a.o === 'flotte:fleet' ? 0 : 1, fb = b.p === 'applies_to' && b.o === 'flotte:fleet' ? 0 : 1;
  return fa - fb || String(a.recorded_at || '').localeCompare(String(b.recorded_at || '')) || String(a.id).localeCompare(String(b.id));
}

/** Pending model proposals that duplicate something; the first of each relation is kept. */
export function pendingDuplicates(facts, nodes = {}) {
  const pending = facts.filter(f => f.origin && PENDING.has(f.status)).sort(proposalOrder);
  const pendingIds = new Set(pending.map(f => f.id));
  const kept = facts.filter(f => !pendingIds.has(f.id));
  const out = [];
  for (const f of pending) {
    const d = proposalDuplicate(f, { facts: kept, nodes });
    if (d) out.push({ id: f.id, ...d });
    else kept.push(f);
  }
  return out;
}
