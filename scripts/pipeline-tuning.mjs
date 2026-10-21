// ============================================================================
// scripts/pipeline-tuning.mjs — per-lever switches of the pipeline speed-ups
// ============================================================================
//
// Pipeline redesign, phase 0 (docs/PIPELINES-SYNTHESE.md §8.1, user decisions
// of 2026-10-20 « tout comme recommandé »): every quick win has its own switch,
// re-read at each dispatch (no restart), and a run keeps the settings it read
// when it started (`run.json.tuning`): a resumed run replays the same rules.
//
//   model-routing.json → enforcement.tuning = { <lever>: true | false | [projects] }
//
// Absent or false = exactly the behaviour before phase 0. `true` = every
// project; a list = only those projects (pipelineLab first, decision 17).
// Written only by `node scripts/pipeline-enforce.mjs tuning …`.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

export const TUNING_LEVERS = {
  citedPathsLog: 'chemins cités jugés sur les fichiers lus pendant le tour (levier 1)',
  codeDeliver: 'Livrer fait par le programme ; le model n’écrit que le texte du CHANGELOG (levier 2, décision 9)',
  codeFormat: 'Mettre en forme fait par le programme quand la relecture rend des corrections exactes ou aucune (levier 3)',
  suiteCache: 'suite de tests verte mémorisée par empreinte d’arbre, jamais relancée sur un arbre identique (levier 4)',
  inertCleanup: 'pipelines ajoutés non exécutables et anciens rattachements à mots-clés ignorés (décision 7)',
  // Phase 1 (génériques), off by default like every lever.
  generic: 'génériques proposés au classement : Opérations, Fichiers, Rédaction « document », Discussion « vérification », Recherche « interne » (décision 4)',
  discussionOne: 'Discussion en un seul appel, la recherche seulement si la réponse la demande (levier 6, décision 10)',
};
export const LEVER_IDS = Object.keys(TUNING_LEVERS);

/** Raw `enforcement.tuning` of model-routing.json, only known levers kept. */
export function readTuning(root) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')); } catch { /* absent */ }
  return cleanTuning(j?.enforcement?.tuning);
}

export function cleanTuning(t) {
  const out = {};
  if (!t || typeof t !== 'object') return out;
  for (const k of LEVER_IDS) {
    const v = t[k];
    if (v === true) out[k] = true;
    else if (Array.isArray(v)) { const l = [...new Set(v.filter(p => typeof p === 'string' && p))]; if (l.length) out[k] = l; }
  }
  return out;
}

/** Resolved booleans for one project: { lever: true|false }. */
export function tuningFor(raw, project) {
  const out = {};
  for (const k of LEVER_IDS) out[k] = raw[k] === true || (Array.isArray(raw[k]) && raw[k].includes(project));
  return out;
}

/**
 * Settings of a run: the ones frozen in its state, else read now and frozen.
 * A run started before phase 0 (no `tuning` in run.json) keeps the old
 * behaviour: every lever off.
 */
export function runTuning(state, root, project, { resumed = false } = {}) {
  if (state.tuning && typeof state.tuning === 'object') return { ...tuningFor({}, project), ...state.tuning };
  const t = resumed ? tuningFor({}, project) : tuningFor(readTuning(root), project);
  state.tuning = t;
  return t;
}

/** New raw tuning after `on|off <lever|all> [project]`. Throws a French message on misuse. */
export function applyTuningChange(raw, { on, lever, project = null }) {
  const levers = lever === 'all' ? LEVER_IDS : [lever];
  if (!levers.every(l => LEVER_IDS.includes(l))) throw new Error(`levier inconnu : ${lever} — connus : ${LEVER_IDS.join(', ')}, all`);
  const out = { ...raw };
  for (const l of levers) {
    const cur = out[l];
    if (!project) { if (on) out[l] = true; else delete out[l]; continue; }
    if (on) {
      if (cur === true) continue;
      out[l] = [...new Set([...(Array.isArray(cur) ? cur : []), project])];
    } else {
      if (cur === true) throw new Error(`le levier ${l} est actif pour tous les projets : « off ${lever} » sans projet pour le couper, puis « on ${lever} <projet> » pour chacun`);
      const left = (Array.isArray(cur) ? cur : []).filter(p => p !== project);
      if (left.length) out[l] = left; else delete out[l];
    }
  }
  return cleanTuning(out);
}

export function describeTuning(raw) {
  return LEVER_IDS.map(k => `${k} : ${raw[k] === true ? 'tous les projets' : Array.isArray(raw[k]) ? raw[k].join(', ') : 'coupé'}`).join('\n');
}
