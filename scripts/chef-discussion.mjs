// ============================================================================
// scripts/chef-discussion.mjs — « discuss with the chef » messages (0.96.0)
// ============================================================================
//
// User, 2026-10-14: « Orchestrateur-dev: liste des todo, on devrait pouvoir
// envoyer au chef, pas pour lancer mais en discuter, si j'ai besoin de
// reponse. » A user message to the chef that starts with the explicit prefix
// below (placed by the TODO panel's « Discuter avec le chef… ») runs the
// chef's Routage in its `discussion` mode: Lire → Discuter → Rapporter, with no
// Decomposer, Classifier, Affecter nor Dispatcher step — nothing can be
// dispatched, by construction (and a step turn refuses any dispatch.mjs).
// An explicit choice of the user, never a keyword search.
// ============================================================================

export const CHEF_DISCUSSION_PREFIX = '/chef-discussion';
const RE = /^\s*\/chef-discussion(?![\w-])[ \t]*(?:\r?\n)?/i;

/** {on, text}: whether the message asks for a discussion, and its text without the prefix. */
export function chefDiscussion(text) {
  const s = String(text ?? '');
  const m = RE.exec(s);
  return m ? { on: true, text: s.slice(m[0].length).trim() } : { on: false, text: s };
}
