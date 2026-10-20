// ============================================================================
// scripts/inert-custom.mjs — accepted additions that no longer do anything
// useful (pipelines phase 0 d, user decision 7, switch `inertCleanup`)
// ============================================================================
//
// User decision 7 (2026-10-20, « tout comme recommandé » on
// docs/PIPELINES-SYNTHESE.md): « retirer le pipeline inutilisable `x-7e4cf1`
// (remplacé par « Opérations ») et les 11 rattachements à mots-clés devenus
// inertes, avec sauvegarde ».
//
// Two kinds, recognised by their FORM, never by their words:
//   - a custom pipeline the engine cannot run (its id is not an engine
//     pipeline): the classifier could pick it, the run would be refused;
//   - an attachment written before 0.66.0, which still carries `keywords`:
//     the keywords are no longer read, but its `when` (a cut-off sentence of
//     one old request) still lengthens the description the classifier reads.
// An attachment accepted since 0.66.0 has no `keywords`: it is kept.
//
// With the switch on, the readers (classifier, Models page) ignore them at
// once; `node scripts/pipeline-cleanup.mjs apply` removes them from
// model-routing.json, after a backup (`restore` puts them back).
// ============================================================================

import { CATALOG_PIPELINES } from './pipeline-catalog.mjs';
import { cleanTuning } from './pipeline-tuning.mjs';

export const EXECUTABLE_PIPELINES = ['discussion', 'dev', ...CATALOG_PIPELINES];

/** → { pipelines: [{id, label}], attach: [{index, pipeline, when}] } */
export function inertCustom(custom) {
  const pipelines = (Array.isArray(custom?.pipelines) ? custom.pipelines : [])
    .filter(p => p?.id && !EXECUTABLE_PIPELINES.includes(p.id)).map(p => ({ id: p.id, label: p.label || '' }));
  const attach = (Array.isArray(custom?.attach) ? custom.attach : [])
    .map((a, index) => ({ a, index })).filter(({ a }) => Array.isArray(a?.keywords))
    .map(({ a, index }) => ({ index, pipeline: a.pipeline, when: a.when || '' }));
  return { pipelines, attach };
}

/** A copy of `custom` without its inert additions. */
export function withoutInert(custom) {
  if (!custom || typeof custom !== 'object') return custom;
  const inert = inertCustom(custom);
  const drop = new Set(inert.pipelines.map(p => p.id));
  const dropAttach = new Set(inert.attach.map(a => a.index));
  return {
    ...custom,
    ...(Array.isArray(custom.pipelines) ? { pipelines: custom.pipelines.filter(p => !drop.has(p?.id)) } : {}),
    ...(Array.isArray(custom.attach) ? { attach: custom.attach.filter((a, i) => !dropAttach.has(i)) } : {}),
  };
}

/** The switch, read from the model-routing.json content (on for all, or for any project). */
export function inertCleanupOn(routing) {
  const t = cleanTuning(routing?.enforcement?.tuning).inertCleanup;
  return t === true || (Array.isArray(t) && t.length > 0);
}

/** The `custom` the readers use: without inert additions when the switch is on. */
export function effectiveCustom(routing) {
  const custom = routing?.custom || null;
  return inertCleanupOn(routing) ? withoutInert(custom) : custom;
}
