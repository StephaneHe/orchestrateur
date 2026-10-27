// ============================================================================
// scripts/process-pause.mjs — process pauses are settled by the chef (0.133.0)
// ============================================================================
//
// User rule (2026-10-22), verbatim: « arrête de poser des questions de
// découpage. tu sais comment est organisé le process mieux que moi ».
//
// Two families of pipeline pauses, by their limit and diagnosed cause:
//   PROCESS — how the work is organised (too many items, set-aside items, a
//     stale set-aside patch, test/step/review limits, a resume after an
//     interruption): routed to the chef like a musician's question
//     (NEEDS_CHEF_INPUT → [ANSWER] → [CHEF_ANSWER]); the chef picks an option.
//   USER DECISION — abandoning work, irreversible operations, the guardrails
//     (money, secrets, sending in the user's name, deletion without return,
//     publishing a private repository), the environment the user must repair,
//     the choice of a model, and any product question: they stay with the user.
//   In doubt, a pause stays with the user.
//
// Anti-loop: the same pause (same signature: same set-aside items for the same
// reasons, or same limit/cause/step/item) answered twice with the same option
// cannot get that option a third time; for set-aside items the proposed option
// becomes « livrer sans eux », with the reason, and a separate request targeted
// at each item is suggested.
//
// Switch: lever `chefPauses` of pipeline-tuning.mjs (off by default, frozen in
// run.json.tuning when the run starts). Off = exactly the behaviour before.
// ============================================================================

import { OPTION_KEYS, matchOptionKey } from './pause-diagnosis.mjs';

/** Limits whose pauses are about the organisation of the work. */
export const PROCESS_LIMITS = Object.freeze(['items', 'items_blocked', 'aside_conflict', 'item_tests', 'green', 'criteria', 'review', 'duration', 'orphaned']);

/** Diagnosed causes the chef can settle (an environment, a model or an unknown cause: the user). */
export const PROCESS_KINDS = Object.freeze(['too_big', 'items_blocked', 'aside_conflict', 'criterion_strict', 'test_passes', 'no_test', 'test_wrong', 'code_wrong',
  'no_change', 'missing_sections', 'scope_violation', 'bad_format', 'cited_paths', 'missing_file', 'no_commit', 'review_defects', 'interrupted',
  'version_stale', 'code_delivery', 'delivery_gate']);

/**
 * Menu words the chef may choose. Never: closing the work (abandonner,
 * simplifier), accepting defects, deleting files, authorizing an operation,
 * a repair the user makes, testing or changing a model.
 */
export const CHEF_KEYS = Object.freeze(['continuer', 'corriger le test', 'écrire le test', 'changer d’approche', 'corriger le code', 'corriger les références',
  'créer le fichier', 'ajuster le critère', 'découper', 'prolonger', 'corriger les défauts', 'réduire les tests', 'compléter le compte rendu',
  'respecter le périmètre', 'corriger le format', 'reprendre les items', 'écarter l’item', 'relancer l’étape', 'refaire le commit', 'livrer sans eux',
  'confier au model']);

/** Same option on the same pause at most this many times (a 3rd identical resume is refused). */
export const MAX_SAME_ANSWER = 2;

const one = (s, n = 400) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const itemText = (t) => one(String(t || '').replace(/\(\s*tests?\s*:\s*\d+\s*\)\s*/i, ''), 160);

/** Signature of a pause: what must be identical for two pauses to be « the same ». */
export function pauseSignature({ limit, kind, step = null, item = null, aside = [], asideConflict = null }) {
  if (limit === 'items_blocked') return `items_blocked|${(aside || []).map(a => `${a.group}:${a.limit}`).sort().join(',')}`;
  if (limit === 'aside_conflict') return `aside_conflict|${asideConflict ?? ''}`;
  return `${limit}|${kind || ''}|${step || ''}|${item ?? ''}`;
}

/** Process or user decision, with the reason; never throws. */
export function pauseFamily({ limit, kind, pipeline = null, lane = 0 }) {
  if (pipeline === 'routage') return { family: 'user', why: 'pause du Routage du chef lui-même' };
  if (lane >= 1) return { family: 'user', why: 'exécution dans un couloir : le relais vers le chef ne la porte pas' };
  if (!PROCESS_LIMITS.includes(limit)) return { family: 'user', why: `pause « ${limit} » : décision de l’utilisateur` };
  if (!PROCESS_KINDS.includes(kind)) return { family: 'user', why: `cause « ${kind} » : décision de l’utilisateur (environnement, model ou cause non établie)` };
  return { family: 'process', why: `pause de processus (« ${limit} », cause « ${kind} »)` };
}

/**
 * Where a pause goes. input: { limit, d (diagnosis), menu (full menu), pipeline,
 * lane, history: [{sig, key}], sig, project, run, n, aside }.
 * → { to: 'user', why } | { to: 'chef', menu, blocked, suggestions, question, why }
 */
export function routePause({ limit, d, menu, pipeline = null, lane = 0, history = [], sig, project, run, n = 1, aside = [] }) {
  const f = pauseFamily({ limit, kind: d?.kind, pipeline, lane });
  if (f.family !== 'process') return { to: 'user', why: f.why };
  const blocked = [];
  let options = (menu?.options || []).filter(o => CHEF_KEYS.includes(o.key));
  options = options.filter((o) => {
    const times = (history || []).filter(h => h.sig === sig && h.key === o.key).length;
    if (times >= MAX_SAME_ANSWER && OPTION_KEYS[o.key] === 'resume') { blocked.push({ key: o.key, times }); return false; }
    return true;
  });
  if (!options.length) return { to: 'user', why: blocked.length ? `boucle : « ${blocked.map(b => b.key).join('», «')} » déjà choisi ${blocked[0].times} fois sur la même pause, aucune autre option de processus` : 'aucune option que le chef peut choisir' };
  const suggestions = limit === 'items_blocked' && blocked.length
    ? (aside || []).map(a => `${project} — demande séparée ciblée sur l’item ${a.group}${a.text ? ` « ${itemText(a.text)} »` : ''} : ${one(a.why || a.limit, 220)}${a.patch ? ` (correctif gardé : ${a.patch})` : ''}`)
    : [];
  let recommend = menu?.recommend && options.some(o => o.key === menu.recommend.key) ? menu.recommend : null;
  if (!recommend && options.some(o => o.key === 'livrer sans eux')) {
    recommend = { key: 'livrer sans eux', why: `${blocked.map(b => `« ${b.key} »`).join(', ')} a déjà été choisi ${blocked[0]?.times || MAX_SAME_ANSWER} fois pour les mêmes items bloqués pour la même raison : recommencer à l’identique échouerait encore ; le travail livré est gardé et chaque item bloqué devient une demande séparée ciblée.` };
  }
  if (!recommend) recommend = { key: options[0].key, why: blocked.length ? `« ${blocked.map(b => b.key).join('», «')} » a déjà été choisi ${blocked[0].times} fois sur cette même pause : une autre option est nécessaire.` : (menu?.recommend?.why || 'c’est l’option qui agit sur la cause établie.') };
  const chefMenu = { options, recommend };
  return { to: 'chef', menu: chefMenu, blocked, suggestions, why: f.why, question: chefQuestion({ project, run, n, d, menu: chefMenu, blocked, suggestions }) };
}

/** The one-line question relayed to the chef (NEEDS_CHEF_INPUT: is read on ONE line). Run and pause number first: they make it unique. */
export function chefQuestion({ project, run, n, d, menu, blocked = [], suggestions = [] }) {
  const opts = menu.options.map(o => `« ${o.key} » (${one(o.does, 220)})`).join(' ; ');
  return one([
    `[${run} · pause ${n}] ${project} — pause de PROCESSUS, à trancher par toi (règle de l’utilisateur : ne plus lui poser ces questions d’organisation du travail).`,
    `Cause : ${one(d?.cause, 500)}`,
    `Choix possibles : ${opts}.`,
    `Je recommande « ${menu.recommend.key} » : ${one(menu.recommend.why, 400)}`,
    blocked.length ? `Exclu (anti-boucle) : ${blocked.map(b => `« ${b.key} » déjà choisi ${b.times} fois sur cette même pause`).join(' ; ')}.` : '',
    suggestions.length ? `Demandes séparées suggérées : ${suggestions.join(' | ')}.` : '',
    'Réponds exactement « [ANSWER] <un seul de ces choix> — <ta raison en une phrase> ». Si la décision revient en fait à l’utilisateur (abandon, produit, irréversible), réponds par le marqueur NEEDS_USER_INPUT suivi de la question reformulée pour l’utilisateur.',
  ].filter(Boolean).join(' '), 6000);
}

/**
 * The chef's relayed answer → { ok: true, key, reason } | { ok: false, why, toUser? }.
 * Only one of the options offered to the chef is accepted; anything else goes
 * back to the user (never guessed).
 */
export function parseChefDecision(text, chefPause) {
  let t = String(text || '')
    .replace(/^\s*\[CHEF_ANSWER\]\s*/i, '')
    .replace(/\n\s*Reprends ta tâche en intégrant cette décision\.?\s*$/i, '')
    // 0.137.0: the relay's line naming what the answer answers.
    .replace(/\n?^\[RELAIS: [^\]\n]*\][ \t]*$/gm, '')
    .replace(/^\s*\[ANSWER\]\s*/i, '')
    .trim();
  if (/NEEDS_USER_INPUT\s*:/i.test(t)) return { ok: false, toUser: true, why: `le chef renvoie la décision à l’utilisateur : ${one(t.replace(/^[\s\S]*?NEEDS_USER_INPUT\s*:\s*/i, ''), 400)}` };
  t = t.replace(/\bp-\d{8}T\d{6}-[a-z0-9]{4,8}\b/g, '').replace(/^[\s«"]+/, '').trim();
  const key = matchOptionKey(t, chefPause?.options || []);
  if (!key) return { ok: false, why: `réponse du chef hors des choix proposés (${(chefPause?.options || []).map(k => `« ${k} »`).join(', ')}) : « ${one(t, 200)} »` };
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, '\'');
  const start = norm(t).indexOf(norm(key));
  const rest = start >= 0 ? t.slice(start + key.length) : '';
  const reason = one(rest.replace(/^[\s»"]*[—–:,.;-]*\s*/, '').split('\n')[0], 400);
  return { ok: true, key, reason: reason || '(sans raison donnée)' };
}

/** The information line shown to the user for a settled process pause. */
export function decisionText({ key, reason }) {
  return `⚖ tranché par le chef : « ${key} » — ${reason}`;
}
