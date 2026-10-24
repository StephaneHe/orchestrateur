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
import { writeFileAtomic } from './atomic-file.mjs';

export const TUNING_LEVERS = {
  citedPathsLog: 'chemins cités jugés sur les fichiers lus pendant le tour (levier 1)',
  codeDeliver: 'Livrer fait par le programme ; le model n’écrit que le texte du CHANGELOG (levier 2, décision 9)',
  codeFormat: 'Mettre en forme fait par le programme quand la relecture rend des corrections exactes ou aucune (levier 3)',
  suiteCache: 'suite de tests verte mémorisée par empreinte d’arbre, jamais relancée sur un arbre identique (levier 4)',
  inertCleanup: 'pipelines ajoutés non exécutables et anciens rattachements à mots-clés ignorés (décision 7)',
  // Phase 1 (génériques), off by default like every lever.
  generic: 'génériques proposés au classement : Opérations, Fichiers, Rédaction « document », Discussion « vérification », Recherche « interne » (décision 4)',
  discussionOne: 'Discussion en un seul appel, la recherche seulement si la réponse la demande (levier 6, décision 10)',
  // 0.133.0, user rule « arrête de poser des questions de découpage » (process-pause.mjs).
  chefPauses: 'pauses de processus (découpage, items mis de côté, limites de tests ou d’étapes, reprises) tranchées par le chef, plus posées à l’utilisateur',
  // 0.139.0 (aside-rework.mjs), chef's finding on psyProfile (2026-10-23).
  itemTestFix: 'la correction après la relecture peut modifier les tests de l’item, pas encore livrés (en-tête, commentaire…), au lieu de mettre l’item de côté',
  testWrong: '4b peut déclarer le test de l’item faux (« TEST_FAUX: … ») : retour à 4a pour le corriger, au lieu de trois refus',
  asideRedo: 'un item mis de côté dont le correctif ne s’applique plus est refait à partir du code actuel (le correctif sert d’indication), une fois',
  asideGroup: 'les items mis de côté dont le correctif ne s’applique plus font une seule pause groupée, pas une pause par item',
  // 0.141.0 (exploitation.mjs), « Je ferai passer ce genre de petites tâches d'exploitation par une voie plus légère ».
  exploitation: 'voie légère « Exploitation » : petite tâche d’exploitation en un seul tour de model, sans TDD, check-list vérifiée par le code (proposée au classement, préfixe /exploitation, --pipeline exploitation)',
  // 0.146.0 (design.mjs), « ok » to a dedicated pipeline after « l'ui de [projet] est vraiment moche ».
  design: 'pipeline « Design » : captures réelles des écrans (mobile et bureau), critique par un model qui voit les images, corrections de l’affichage en boucle bornée, second avis indépendant, tests du projet verts (proposé au classement, préfixe /design, --pipeline design)',
  // 0.143.0, « vitesse » phase (pipeline-speed.mjs), user's « ok » of 2026-10-23.
  limits: 'limites d’une exécution réglables à chaud (tests par exécution, durée de travail ; défaut 25 tests, 150 min ; pipeline-enforce.mjs tuning-values)',
  redGreen: 'test + code en un appel pour un petit item (≤ 2 tests annoncés) : le programme prouve le rouge (test qui échoue sans le code, sortie gardée) puis le vert',
  groupReview: 'une relecture pour 2 à 3 items consécutifs (commit provisoire par item ; un défaut ne fait reprendre que son item)',
  reuseContext: 'une exécution qui cite l’exécution précédente de la même demande reprend sa compréhension et son plan, sauf si le code a divergé',
  targetedTests: 'tests ciblés à chaque étape (tests de l’item, tests qui importent ou nomment les fichiers modifiés, exigences comprises) ; suite complète seulement à Livrer',
  extraTests: '« N tests annoncés, N+1 écrits » accepté (et noté) quand le test en plus est dans le même fichier que ceux de l’item',
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

// ---------------------------------------------------------------------------
// Values of the « vitesse » levers (0.143.0): model-routing.json →
// enforcement.tuningValues, written by `pipeline-enforce.mjs tuning-values`,
// re-read at each dispatch and frozen in run.json.tuningValues when a run
// starts. They only apply while their lever is on (limits, groupReview, redGreen).
// ---------------------------------------------------------------------------
export const VALUE_DEFAULTS = { items: 25, runMin: 150, reviewBatch: 3, redGreenMaxTests: 2 };
export const VALUE_BOUNDS = { items: [1, 60], runMin: [10, 600], reviewBatch: [2, 3], redGreenMaxTests: [1, 2] };
export const VALUE_LABELS = { items: 'tests (items) par exécution', runMin: 'minutes de travail par exécution', reviewBatch: 'items par relecture groupée', redGreenMaxTests: 'tests annoncés au plus pour test + code en un appel' };

/** Only known keys, integers within their bounds; anything else dropped. */
export function cleanValues(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(VALUE_BOUNDS)) {
    const n = Number(v[k]);
    if (Number.isInteger(n) && n >= lo && n <= hi) out[k] = n;
  }
  return out;
}
export function readTuningValues(root) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')); } catch { /* absent */ }
  return { ...VALUE_DEFAULTS, ...cleanValues(j?.enforcement?.tuningValues) };
}
/** Values of a run: the frozen ones, else read now and frozen (a run started before 0.143.0: the defaults). */
export function runTuningValues(state, root, { resumed = false } = {}) {
  if (state.tuningValues && typeof state.tuningValues === 'object') return { ...VALUE_DEFAULTS, ...cleanValues(state.tuningValues) };
  const v = resumed ? { ...VALUE_DEFAULTS } : readTuningValues(root);
  state.tuningValues = v;
  return v;
}
/** Parses `--items 25 --run-min 150 --review-batch 3 --red-green-max 2`; throws a French message. */
export function parseValueArgs(argv) {
  const flags = { '--items': 'items', '--run-min': 'runMin', '--review-batch': 'reviewBatch', '--red-green-max': 'redGreenMaxTests' };
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = flags[argv[i]];
    if (!k) throw new Error(`option inconnue : ${argv[i]} — connues : ${Object.keys(flags).join(', ')}, --reset`);
    const n = Number(argv[++i]);
    const [lo, hi] = VALUE_BOUNDS[k];
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${argv[i - 1]} : entier de ${lo} à ${hi} attendu (reçu « ${argv[i] ?? ''} »)`);
    out[k] = n;
  }
  return out;
}
export function describeValues(v) {
  return Object.keys(VALUE_DEFAULTS).map(k => `${k} = ${v[k]} (${VALUE_LABELS[k]}${v[k] === VALUE_DEFAULTS[k] ? ', défaut' : ''})`).join('\n');
}

// ---------------------------------------------------------------------------
// Routage v3, phase 2: the chef's single turn in SHADOW (chef-turn.mjs).
// model-routing.json → chefV3 {shadow, since, by}, written by
// `pipeline-enforce.mjs chef-shadow on|off`, re-read at each chef turn by
// dispatch.mjs. Off when absent.
// ---------------------------------------------------------------------------
const readRouting = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')); } catch { return null; } };
export function readChefV3(root) {
  const c = readRouting(root)?.chefV3;
  return { shadow: c?.shadow === true, since: c?.since || null, by: c?.by || null };
}
export function writeChefV3(root, { shadow, by }) {
  const file = path.join(root, 'model-routing.json');
  let j = readRouting(root);
  if (!j || typeof j !== 'object') j = { version: 2, assignments: {} };
  const before = j.chefV3?.shadow === true;
  const at = new Date().toISOString();
  j.chefV3 = { shadow: !!shadow, since: at, by };
  j.history = Array.isArray(j.history) ? j.history : [];
  j.history.push({ at, task: 'chefV3.shadow', from: before ? 'on' : 'off', to: shadow ? 'on' : 'off', by });
  if (j.history.length > 500) j.history = j.history.slice(-500);
  writeFileAtomic(file, JSON.stringify(j, null, 2) + '\n', `${file}.${process.pid}.tmp`);
  return readChefV3(root);
}
