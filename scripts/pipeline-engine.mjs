// ============================================================================
// scripts/pipeline-engine.mjs — moteur de pipelines, phase 3 (0.48.0)
// ============================================================================
//
// Demande utilisateur (2026-10-09) : « est-ce que l'on utilise les pipeline
// specifies plutot ? Sinon, il faut faire en sorte que ces pipelines soient
// obligatoirement utlises. » Plan : docs/PLAN-pipeline-enforcement.md (§2, §3).
//
// Une EXÉCUTION (run) = un pipeline appliqué à une demande sur un projet.
//   - Une ÉTAPE = un tour séparé (claude -p ou codex), lancé sur le model de SA
//     case de la page Models (variante, puis étape ; principal + second en mode
//     double). Case vide = défaut du projet, AVEC un avertissement visible.
//   - Passation par FICHIERS : <projet>/.orchestrateur/runs/<run>/ (demande.md,
//     comprehension.md, recherche.md, reponse.md, revue.json…), jamais versionné.
//   - Critères de sortie VÉRIFIÉS PAR LE CODE (diff, commande de test, artefact),
//     jamais sur la parole du model. Un essai refusé est relancé avec la raison,
//     puis l'exécution se met en PAUSE (question à l'utilisateur).
//   - Chaque étape tourne avec un JETON D'ÉTAPE signé (HMAC du secret local) :
//     dispatch.mjs refuse une étape sans jeton valide, ou avec un autre model.
//   - Model indisponible (règle « aucun fallback ») → PAUSE, jamais de repli.
//   - Toute limite atteinte → notification/pipeline_limit dans le log, question
//     dans le dashboard (état input), notification au chef. Jamais en silence.
//
// Côté musicien, une exécution est UN tour : un user_prompt (avec `pipeline`),
// des événements system/pipeline_* (frise), puis un seul result (ou une pause).
// Les tours d'étape ont leurs propres logs : logs/runs/<run>/<clé>.jsonl.
//
// En service en phase 3 : Discussion et Développement LÉGER, sur les projets
// listés dans model-routing.json → enforcement (pipelineLab d'abord).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { derivedToken } from './local-secret.mjs';
import { renameRetry, writeFileAtomic } from './atomic-file.mjs';
import { notificationReportText } from './turn-report.mjs';
import { readBranchLog } from './dual-run.mjs';
import { languageFor, languageGate, localize, workingLanguage } from './language.mjs';
import { CATALOG_PIPELINES, catalogOf, catalogSteps } from './pipeline-catalog.mjs';
import { checkReportIds } from './report-check.mjs';
import { readPending, addPending, releaseReady, launchTask, detectReprise, logOffset, taskKey, textHash, duplicatesText, RUN_ID_RE, titleProblem, pendingLabel, cleanTitle, ambiguityProblem, distinctExcerpts } from './routage-pending.mjs';
import { stepSessionGroup } from './context-policy.mjs';
export { readPending };
import { backoffConfig, isLaunchFailure, dispatchRefusal, infraFailure, tierAfter, delayFor, waitBackoff, runDirOf } from './model-backoff.mjs';
import { holdForRetry, retryText, CAUSE_TEXT } from './infra-retry.mjs';
import { runModelTest } from './model-test.mjs';
import { PIPELINES } from './model-pipelines.mjs';
import { checkMediaFiles, listedFiles, wordErrorRate } from './media-check.mjs';
import * as Meeting from './meeting-check.mjs';
import { countTests, addedTests, itemTestsVerdict } from './item-tests.mjs';
import { groupOf, groupCases, groupReady, insertAttachedCases, worktreeTree, treeDiff } from './item-review.mjs';
import { foldTo, commitWork, itemCommitMessage, setAsideWork, reapplyWork, head as headOf } from './item-delivery.mjs';
import { readFragments } from './lanes.mjs';
import { cleanTuning, runTuning, readTuning, tuningFor } from './pipeline-tuning.mjs';
import { judgeCitedPaths, observedInTurn, toolUsesInTurn } from './cited-paths.mjs';
import * as Ops from './typed-operations.mjs';
import * as Files from './files-check.mjs';
import * as Doc from './document-check.mjs';
import { diagnosePause, diagnoseWithModel, smartMenu, fixMenu, menuQuestion, menuBlock, matchOptionKey, readTestOutput } from './pause-diagnosis.mjs';
import { routePause, pauseSignature, decisionText } from './process-pause.mjs';
import { releasePlan, parseDeliveryText, deliverRelease, deliverCommit } from './code-delivery.mjs';
import { cachedSuite } from './suite-cache.mjs';

/** Changelog fragment a lane task delivers (P9; same slug as the integrator's, scripts/lanes.mjs). */
export function laneFragmentPath(task) { return `changelog.d/${String(task).replace(/[^\w.-]/g, '_')}.md`; }

export const RUN_RE = /^p-\d{8}T\d{6}-[a-z0-9]{4,8}$/;
// Keys are padStart(2) of the step count: 3 digits from the 100th step (0.64.1).
export const STEP_KEY_RE = /^\d{2,6}-[a-z0-9-]{1,40}$/;
export const SESSION_GROUP_RE = /^[a-z0-9-]{1,40}$/;

// Limites (décision n° 5, plan §2.5). ORCH_PIPE_* pour les tests.
// Why an item was set aside (per-item delivery, 0.64.0), in the user's words.
const ASIDE_WORDS = {
  review: 'la relecture trouve encore des défauts', item_tests: 'plus de tests écrits que prévu',
  green: 'le code ne fait pas passer le test', criteria: 'refusé par les vérifications automatiques',
};
// Set-aside items dropped because their patch no longer applies (0.113.2): always listed, never silent.
function discardedText(state, lead = '') {
  const ds = state.discardedAside || [];
  if (!ds.length) return '';
  return `${lead}⊘ Écarté(s), non livré(s) — leurs modifications ne s’appliquaient plus sur le travail livré depuis ; elles restent gardées (à réappliquer à la main avec « git apply » si besoin) : `
    + `${ds.map(a => `${a.group === 0 ? 'travail d’avant la montée en complet' : `item ${a.group}`} → \`${a.patch}\``).join(' ; ')}\n`;
}
export const LIMITS = {
  criteriaAttempts: 2,     // essais d'une étape dont le critère échoue
  greenAttempts: 3,        // essais de 4b pour un même test
  reviewRounds: 2,         // tours de revue → correction
  runMs: 90 * 60_000,      // durée totale d'une exécution
  items: 15,               // items de la liste de tests (au-delà : découper)
  testsPerItem: 2,         // tests prévus déclarés par item, au plus (0.61.0, décision « c+d »)
  refactorMinLines: 10,    // 4c sautée si 4b a changé moins de lignes
};
// Garde-fou du léger (plan §4) : au-delà, l'exécution monte en complet.
export const LIGHT_SCOPE = { files: 3, lines: 150 };
const PLAIN_STEP = {
  comprendre: 'comprendre la demande', concevoir: 'concevoir la solution', 'liste-tests': 'établir la liste des tests',
  rouge: 'écrire un test, qui doit d’abord échouer', vert: 'écrire le code qui fait passer le test', refactor: 'nettoyer le code',
  revue: 'relecture', livrer: 'livraison (version, journal des changements, commit)',
  rechercher: 'rechercher', repondre: 'rédiger la réponse', '@loop': 'boucle des tests',
  '@check': 'cocher l’item terminé', '@aside': 'reprendre les items mis de côté',
};
/** Nom d'étape compréhensible par l'utilisateur, sans vocabulaire interne. */
export function plainStep(id) {
  if (PLAIN_STEP[id]) return PLAIN_STEP[id];
  for (const p of CATALOG_PIPELINES) { const s = catalogOf(p).steps.find(x => x.id === id); if (s) return s.title.replace(/^\d+[a-z]?\s+/, '').toLowerCase(); }
  return id || 'exécution';
}
// Modes of the generics (pipelines phase 1): the label says which one runs.
export const GENERIC_MODES = { redaction: ['document'], discussion: ['verification'], recherche: ['interne'] };
const MODE_LABEL = { document: 'document existant', verification: 'vérification', interne: 'interne' };
export function pipelineLabel(pipeline, mode) {
  if (pipeline === 'dev') return mode === 'complet' ? 'Développement complet' : 'Développement léger';
  if (GENERIC_MODES[pipeline]?.includes(mode)) return `${pipeline === 'discussion' ? 'Discussion' : PIPELINES.find(p => p.id === pipeline)?.label || pipeline} — ${MODE_LABEL[mode]}`;
  if (pipeline === 'discussion') return 'Discussion';
  return PIPELINES.find(p => p.id === pipeline)?.label || pipeline;
}
const PROGRESS_MS = Number(process.env.ORCH_PIPE_PROGRESS_MS) > 0 ? Number(process.env.ORCH_PIPE_PROGRESS_MS) : 30_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
export const TEST_TIMEOUT_MAX_MIN = 120;
/**
 * Timeout of the project's test (and build) command: `testTimeoutMin` of its
 * .orchestrateur/pipeline.json (integer, 1 to TEST_TIMEOUT_MAX_MIN minutes),
 * else 10 min. Needed by projects whose suite is slower, such as
 * orchestrateur-dev (targeted regression, 0.113.0).
 */
export function testTimeoutMs(cfg) {
  const m = cfg?.testTimeoutMin;
  return Number.isInteger(m) && m >= 1 && m <= TEST_TIMEOUT_MAX_MIN ? m * 60_000 : TEST_TIMEOUT_MS;
}

/** Pipelines que le moteur sait exécuter (phase 6 : catalogue déclaratif en plus). */
export const ENGINE_PIPELINES = ['discussion', 'dev', ...CATALOG_PIPELINES];

// ---------------------------------------------------------------------------
// Mise en service (model-routing.json → enforcement), relue à chaque dispatch
// ---------------------------------------------------------------------------
export function readEnforcement(root) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')); } catch { /* absent */ }
  const e = j?.enforcement && typeof j.enforcement === 'object' ? j.enforcement : {};
  const projects = Array.isArray(e.projects) ? e.projects.filter(p => typeof p === 'string') : [];
  const pipelines = (Array.isArray(e.pipelines) ? e.pipelines : ENGINE_PIPELINES).filter(p => ENGINE_PIPELINES.includes(p));
  // terminal (0.52.0) : le terminal interactif /ws/pty passe par le routeur.
  return { projects, pipelines, terminal: e.terminal === true, chef: e.chef === true, since: e.since || null, generalSince: e.generalSince || null, by: e.by || null };
}
export function isEnforced(enf, project) {
  return enf.projects.includes(project) || enf.projects.includes('*');
}

/** Écriture atomique de la mise en service (CLI pipeline-enforce.mjs, route serveur). */
export function writeEnforcement(root, { projects, pipelines, terminal, chef, generalSince, tuning, by }) {
  const file = path.join(root, 'model-routing.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* neuf */ }
  if (!j || typeof j !== 'object') j = {};
  if (!j.version) j.version = 2;
  j.assignments = j.assignments || {};
  j.history = Array.isArray(j.history) ? j.history : [];
  const at = new Date().toISOString();
  const before = j.enforcement || null;
  const term = typeof terminal === 'boolean' ? terminal : before?.terminal === true;
  const chf = typeof chef === 'boolean' ? chef : before?.chef === true;
  const gen = generalSince || before?.generalSince || null;
  // Phase 0 switches (pipeline-tuning.mjs): kept as they are unless given.
  const tun = cleanTuning(tuning === undefined ? before?.tuning : tuning);
  j.enforcement = { projects: [...new Set(projects)], pipelines: pipelines.filter(p => ENGINE_PIPELINES.includes(p)), ...(term ? { terminal: true } : {}), ...(chf ? { chef: true } : {}), ...(gen ? { generalSince: gen } : {}), ...(Object.keys(tun).length ? { tuning: tun } : {}), since: at, by };
  const fmt = (e) => `${(e.projects || []).join(',') || '—'} / ${(e.pipelines || []).join(',')}${e.terminal ? ' / terminal' : ''}${e.chef ? ' / chef' : ''}${e.tuning ? ` / réglages ${Object.entries(e.tuning).map(([k, v]) => `${k}=${v === true ? 'tous' : v.join('+')}`).join(',')}` : ''}`;
  j.history.push({ at, task: 'enforcement', from: before ? fmt(before) : null, to: fmt(j.enforcement), by });
  if (j.history.length > 500) j.history = j.history.slice(-500);
  j.updatedAt = at;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  renameRetry(tmp, file);
  return j.enforcement;
}

// ---------------------------------------------------------------------------
// Jeton d'étape (plan §3.3)
// ---------------------------------------------------------------------------
function b64u(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64u(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }

export function signStepToken(root, payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', derivedToken(root, 'pipeline-step')).update(body).digest('hex');
  return `v1.${body}.${mac}`;
}

/** Renvoie {ok, payload} ou {ok:false, why}. Comparaison à temps constant. */
export function verifyStepToken(root, token, now = Date.now()) {
  const m = /^v1\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(String(token || ''));
  if (!m) return { ok: false, why: 'jeton d’étape absent ou illisible' };
  const want = crypto.createHmac('sha256', derivedToken(root, 'pipeline-step')).update(m[1]).digest();
  const got = Buffer.from(m[2], 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, why: 'jeton d’étape invalide (signature)' };
  let p;
  try { p = JSON.parse(unb64u(m[1])); } catch { return { ok: false, why: 'jeton d’étape illisible' }; }
  if (!Number.isFinite(p.exp) || p.exp < now) return { ok: false, why: 'jeton d’étape expiré' };
  return { ok: true, payload: p };
}

// ---------------------------------------------------------------------------
// Cases et models
// ---------------------------------------------------------------------------
const PROVIDER_OF = { anthropic: 'claude', openai: 'codex', nvidia: 'nvidia', openrouter: 'openrouter' };

/**
 * Model d'une étape : la case la plus précise affectée (variante, puis étape).
 * Case vide → défaut du projet (`source: 'project-default'`), avertissement.
 * Une affectation « outil local » n'est pas un model de tour : ignorée.
 */
export function resolveCase(assignments, chain) {
  for (const slot of chain) {
    const a = assignments?.[slot];
    if (!a?.model || !PROVIDER_OF[a.provider]) continue;
    const second = a.second?.model && PROVIDER_OF[a.second.provider]
      ? { model: a.second.model, provider: PROVIDER_OF[a.second.provider] } : null;
    return { slot, model: a.model, provider: PROVIDER_OF[a.provider], second, source: 'pipeline' };
  }
  return { slot: chain[0], model: null, provider: null, second: null, source: 'project-default' };
}

/** Outil local affecté à une case de la chaîne (ffmpeg, whisper…), ou null. */
export function localToolFor(assignments, chain) {
  for (const slot of chain || []) {
    const a = assignments?.[slot];
    if (a?.provider === 'local' && a.model) return String(a.model).slice(0, 60);
    if (a?.model && PROVIDER_OF[a.provider]) return null;   // un model passe avant
  }
  return null;
}

function readAssignments(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')).assignments || {}; } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Plans des pipelines en service
// ---------------------------------------------------------------------------
const STRIP = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Étapes d'une exécution, dans l'ordre. */
export function planSteps(pipeline, { mode = 'leger', kind = 'simple', tuning = null } = {}) {
  if (pipeline === 'discussion') {
    // Variant « vérification » (decision 4): verified findings, nothing modified.
    if (mode === 'verification') return [DISCUSSION_VERIFY];
    // Lever 6 (decision 10, switch `discussionOne`): Understand + Answer in ONE
    // read-only call; the research step comes back only if the answer asks for it.
    if (tuning?.discussionOne) return [DISCUSSION_ONE];
    return [
      { id: 'comprendre', title: '1 Comprendre la question', chain: ['discussion.comprendre'], group: 'discussion', artefact: 'comprehension.md', judge: true },
      { id: 'rechercher', title: '2 Rechercher', chain: ['discussion.rechercher'], group: 'discussion', artefact: 'recherche.md', judge: true },
      { id: 'repondre', title: '3 Répondre', chain: ['discussion.repondre'], group: 'discussion', artefact: 'reponse.md', judge: true, final: true },
    ];
  }
  if (pipeline === 'dev') {
    const D = devCatalog({ mode, kind });
    // Complet (0.49.0) : le TDD canonique — liste de tests, puis UN test à la
    // fois (4a → 4b → 4c) tant que la liste n'est pas vide (« @loop »).
    // Per-item Review (« c+d », part c): each item is reviewed right after its
    // loop, inside « @loop » — there is no whole-run Review any more.
    if (mode === 'complet') return ['comprendre', 'concevoir', 'liste-tests', '@loop', 'livrer'].map(id => D[id]);
    return [...(kind !== 'mecanique' ? [D.rouge] : []), D.vert, D.revue, D.livrer];
  }
  const cat = catalogOf(pipeline);
  if (cat?.modes) {
    const ids = cat.modes[mode] || Object.values(cat.modes)[0];
    const all = catalogSteps(pipeline);
    return ids.map(id => all.find(s => s.id === id));
  }
  if (cat) return catalogSteps(pipeline);
  throw new Error(`pipeline « ${pipeline} » pas encore en service`);
}

export const RESEARCH_MARK = 'RECHERCHE_NECESSAIRE';
export const DISCUSSION_ONE = { id: 'repondre', title: '1 Répondre (en un appel)', chain: ['discussion.repondre'], group: 'discussion', artefact: 'reponse.md', kind: 'judge', judge: true, final: true,
  role: `RÉPONDRE à la question de l’utilisateur (demande.md), en UN seul tour et en lecture seule : comprends ce qui est réellement demandé, lis ce qu’il faut (code, docs, journaux ; le web si c’est utile et permis), puis écris la réponse directe, argumentée, avec une recommandation. Si un fichier recherche.md existe dans le dossier, appuie-toi dessus. Si la réponse exige une recherche approfondie que tu ne peux pas mener dans ce tour, écris en tête une ligne « ${RESEARCH_MARK}: <ce qu’il faut chercher> » : l’orchestrateur lance alors la recherche, puis te redonne la main. Ne modifie AUCUN fichier ; si une modification est souhaitable, propose-la : elle deviendra une tâche si l’utilisateur la confirme.`,
  checks: { sections: ['Réponse', 'Sources'], citedPaths: true, researchMark: RESEARCH_MARK } };
export const VERIFY_VERDICTS = ['vrai', 'faux', 'partiel', 'indetermine'];
export const DISCUSSION_VERIFY = { id: 'verifier', title: '1 Vérifier (constats et preuves)', chain: ['discussion.verifier', 'discussion.repondre'], group: 'discussion', artefact: 'verification.json', kind: 'judge', judge: true, final: true,
  role: 'VÉRIFIER ce que demande l’utilisateur (demande.md : « vérifie que… », « compare… ») en lecture seule : pour chaque affirmation à vérifier, ce que tu as OBSERVÉ, la PREUVE (un fichier que tu as lu, avec :ligne si utile ; une commande que tu as lancée dans ce tour et sa sortie ; une URL que tu as consultée) et le verdict. L’orchestrateur vérifie chaque preuve dans le journal de ton tour et sur le disque : une preuve non observée fait refuser l’étape. Ne modifie AUCUN fichier.',
  checks: { json: { constats: 'array' }, verification: true },
  jsonExample: '{"constats": [{"affirmation": "ce qui est vérifié", "observe": "ce que tu as constaté", "preuve": {"type": "fichier|commande|url", "ref": "chemin/relatif:12 | la commande exacte | https://…"}, "verdict": "vrai|faux|partiel|indetermine"}]}' };
const DISCUSSION_RESEARCH = { id: 'rechercher', title: '2 Rechercher', chain: ['discussion.rechercher'], group: 'discussion', artefact: 'recherche.md', judge: true };

/** Toutes les étapes possibles du Développement (léger, complet, montée en complet). */
export function devCatalog({ mode = 'leger', kind = 'simple' } = {}) {
  const v = kind === 'bugfix' ? 'bugfix' : 'comportement';
  const vv = kind === 'mecanique' ? 'mecanique' : mode === 'complet' ? 'complexe' : 'simple';
  return {
    comprendre: { id: 'comprendre', title: '1 Comprendre', chain: ['dev.comprendre.codebase', 'dev.comprendre'], group: 'analyse', artefact: 'comprehension.md', judge: true },
    concevoir: { id: 'concevoir', title: '2 Concevoir', chain: ['dev.concevoir.plan', 'dev.concevoir'], group: 'analyse', artefact: 'plan.md', judge: true },
    'liste-tests': { id: 'liste-tests', title: '3 Liste de tests', chain: ['dev.liste-tests'], group: 'tests', artefact: 'tests.md', judge: true },
    '@loop': { id: '@loop', title: '4 Boucle TDD (un test à la fois)', chain: ['dev.rouge'], marker: true },
    '@check': { id: '@check', title: 'item coché', chain: [], marker: true },
    '@aside': { id: '@aside', title: 'items mis de côté', chain: [], marker: true },
    rouge: { id: 'rouge', title: `4a Rouge${kind === 'bugfix' ? ' (reproduire le bug)' : ''}`, chain: [`dev.rouge.${v}`, 'dev.rouge'], group: 'tests', artefact: 'rouge.md' },
    vert: { id: 'vert', title: '4b Vert', chain: [`dev.vert.${vv}`, 'dev.vert'], group: 'code', artefact: 'vert.md' },
    refactor: { id: 'refactor', title: '4c Refactor', chain: ['dev.refactor'], group: 'code', artefact: 'refactor.md', optional: true },
    revue: { id: 'revue', title: '5 Revue', chain: ['dev.revue.code', 'dev.revue'], group: 'revue', artefact: 'revue.json', judge: true },
    livrer: { id: 'livrer', title: '6 Livrer (+ 7 Documenter)', chain: ['dev.livrer.git', 'dev.livrer'], group: 'code', artefact: 'livraison.md', final: true },
  };
}

/** Items de tests.md : « - [ ] texte » / « - [x] texte », dans l'ordre.
 *  `declared` : nombre de tests prévus annoncé par « (tests: N) », sinon null. */
export function parseItems(md) {
  const out = [];
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ n: out.length + 1, done: m[1] !== ' ', text: m[2], declared: declaredTests(m[2]) });
  }
  return out;
}
// User decision « c+d » (2026-10-10): each item states how many tests it needs,
// "(tests: N)", and the code refuses an item without it or above the cap — so
// a list is made of atomic behaviours, not of 5-to-10-behaviour bundles.
export const TESTS_DECL_RE = /\(\s*tests?\s*:\s*(\d+)\s*\)/i;
export function declaredTests(text) {
  const m = TESTS_DECL_RE.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}
/** Items (open ones) whose declaration is missing, zero or above `cap`. */
export function declarationProblems(items, cap) {
  const missing = [], over = [];
  for (const i of items) {
    if (i.done) continue;
    if (!Number.isInteger(i.declared) || i.declared < 1) missing.push(i.n);
    else if (i.declared > cap) over.push({ n: i.n, declared: i.declared });
  }
  return { missing, over, ok: !missing.length && !over.length };
}
export function declarationWhy(where, { missing, over }, cap, label = 'item') {
  const parts = [];
  if (missing.length) parts.push(`sans déclaration du nombre de tests : ${label}(s) n° ${missing.join(', ')}`);
  if (over.length) parts.push(`plus de ${cap} tests annoncés : ${over.map(o => `n° ${o.n} (${o.declared})`).join(', ')}`);
  return `${where} : chaque ${label} doit annoncer son nombre de tests prévus au format « (tests: N) », N de 1 à ${cap} — ${parts.join(' ; ')}. `
    + `Redécoupe ces ${label}s en comportements plus petits : un ${label} = un comportement vérifiable par 1 à ${cap} test(s).`;
}
/** tests.md without the items whose number (1-based) is in `drop` (« découper » at a pause). */
export function splitTestsList(md, drop) {
  let i = 0;
  return String(md).split(/\r?\n/).filter((line) => {
    if (!/^\s*[-*]\s+\[( |x|X)\]\s+.+$/.test(line)) return true;
    i++;
    return !drop.has(i);
  }).join('\n');
}
/** Coche l'item n (1-based) dans le texte de tests.md. */
export function checkItem(md, n) {
  let i = 0;
  return String(md).split(/(\r?\n)/).map(part => {
    const m = /^(\s*[-*]\s+\[)( |x|X)(\]\s+.+)$/.exec(part);
    if (!m) return part;
    i++;
    return i === n ? `${m[1]}x${m[3]}` : part;
  }).join('');
}
/** Lignes changées entre deux instantanés (fichiers hors tests) : une mesure grossière mais stable. */
export function lineDelta(cwd, before, after, files) {
  let n = 0;
  const read = (h) => { if (!h) return []; const r = spawnSync('git', ['-C', cwd, 'cat-file', 'blob', h], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout.split('\n') : []; };
  for (const f of files) {
    const a = read(before.get(f)), b = read(after.get(f));
    const sa = new Set(a), sb = new Set(b);
    n += b.filter(l => !sa.has(l)).length + a.filter(l => !sb.has(l)).length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Git, instantanés, globs
// ---------------------------------------------------------------------------
function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, ''), err: (r.stderr || '').trim() };
}
const RUNS_PREFIX = '.orchestrateur/runs/';
// Fichiers locaux à la machine, jamais livrés (phase 7, 0.56.0) : les artefacts
// d'exécution et la configuration locale du CLI (.claude/ : réglages, confiance).
export function isLocalOnly(f) {
  const p = String(f).replace(/^"|"$/g, '').split('\\').join('/');
  return p.startsWith(RUNS_PREFIX) || p === '.claude' || p === '.claude/' || p.startsWith('.claude/');
}

// Un dépôt git ne cesse pas d'en être un pendant une exécution : la réponse
// positive est gardée (0.73.3 ; ~28 appels git de moins par exécution, ~40 ms
// chacun sous Windows). Un dossier hors git est toujours revérifié.
const KNOWN_GIT_REPOS = new Set();
function isGitWorkTree(cwd) {
  const k = path.resolve(cwd);
  if (KNOWN_GIT_REPOS.has(k)) return true;
  const yes = git(cwd, ['rev-parse', '--is-inside-work-tree']).out === 'true';
  if (yes) KNOWN_GIT_REPOS.add(k);
  return yes;
}

/** Empreinte de chaque fichier suivi ou non ignoré (hors artefacts d'exécution). */
export function snapshot(cwd) {
  if (!isGitWorkTree(cwd)) return walkSnapshot(cwd);
  const files = git(cwd, ['ls-files', '-c', '-o', '--exclude-standard']).out.split('\n').filter(f => f && !isLocalOnly(f));
  const uniq = [...new Set(files)];
  const map = new Map();
  const present = uniq.filter(f => fs.existsSync(path.join(cwd, f)));
  if (present.length) {
    const r = spawnSync('git', ['-C', cwd, 'hash-object', '-w', '--stdin-paths'], { input: present.join('\n') + '\n', encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const hashes = (r.stdout || '').split('\n');
    present.forEach((f, i) => map.set(f, hashes[i] || ''));
  }
  return map;
}
export function changedFiles(a, b) {
  const out = [];
  for (const [f, h] of b) if (a.get(f) !== h) out.push(f);
  for (const f of a.keys()) if (!b.has(f)) out.push(f);
  return [...new Set(out)].sort();
}
export function globToRe(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export function isTestFile(f, globs) { return (globs || []).some(g => globToRe(g).test(f)); }

function runCommand(cwd, command, env, timeoutMs = TEST_TIMEOUT_MS) {
  if (!command) return { ok: true, code: 0, out: '' };
  const t0 = Date.now();
  // La commande vient du fichier VERSIONNÉ du projet (.orchestrateur/pipeline.json),
  // jamais d'une entrée réseau : un shell est nécessaire (« npm test »).
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, code: r.status, out: out.slice(-12_000), ms: Date.now() - t0, timedOut: r.error?.code === 'ETIMEDOUT' };
}

/**
 * The project's test suite (lever 4, phase 0 c): with `suiteCache`, a GREEN
 * result is reused for an identical tree, command and environment — never
 * across trees; every reuse is reported (ctx.onSuiteCached).
 */
function runSuite(ctx) {
  const { cwd, cfg } = ctx;
  const run = () => runCommand(cwd, cfg.testCommand, ctx.testEnv, testTimeoutMs(cfg));
  if (!ctx.tuning?.suiteCache || !cfg.testCommand || !ctx.suiteCacheFile) return run();
  const t = cachedSuite({ cwd, command: cfg.testCommand, env: ctx.testEnv, indexFile: ctx.suiteCacheIndex, file: ctx.suiteCacheFile }, run);
  if (t.cached) ctx.onSuiteCached?.(t.cached);
  return t;
}

/** Scanners de sécurité du projet (`scanCommands` de .orchestrateur/pipeline.json),
 *  sinon gitleaks s'il est installé. Sorties masquées (--redact), tronquées. */
export function runScanners(cwd, cfg, env) {
  let cmds = Array.isArray(cfg?.scanCommands) ? cfg.scanCommands.filter(c => typeof c === 'string' && c.trim()) : null;
  if (!cmds) {
    cmds = [];
    const gl = [process.env.GITLEAKS_BIN, 'I:\\tools\\gitleaks\\gitleaks.exe'].find(f => f && fs.existsSync(f));
    if (gl) cmds.push(`"${gl}" dir . --no-banner --redact`);
  }
  const ran = [];
  const parts = [];
  for (const cmd of cmds) {
    const t = runCommand(cwd, cmd, env);
    ran.push({ name: cmd.replace(/^"[^"]*[\\/]([^\\/"]+)"/, '$1').slice(0, 80), code: t.code });
    parts.push(`$ ${cmd}\n(code ${t.code})\n${t.out.slice(-6000)}`);
  }
  return { ran, text: parts.length ? parts.join('\n\n') : 'Aucun scanner configuré : ajouter "scanCommands" à .orchestrateur/pipeline.json (gitleaks absent).\n' };
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/** Version courante lue dans un fichier de version (package.json ou gradle). */
export function readVersion(file, text) {
  if (/\.json$/i.test(file)) { try { return JSON.parse(text).version || null; } catch { return null; } }
  const m = /versionName\s*=?\s*["']([^"']+)["']/.exec(text) || /^version\s*=\s*["']?([0-9][^"'\s]*)/m.exec(text);
  return m ? m[1] : null;
}

/**
 * Version already bumped by a delivered item of this run (0.114.1, run
 * p-20261018T091024-0e199e): every version file reads a different version at
 * `to` (last delivered item) than at `from` (start of the run, or its previous
 * release). Null when one file is unchanged or unreadable: the strict rule applies.
 */
export function bumpedInRun(cwd, cfg, from, to) {
  const files = cfg.versionFiles || [];
  if (!files.length || !from || !to || from === to) return null;
  let first = null;
  for (const vf of files) {
    const pv = readVersion(vf, git(cwd, ['show', `${from}:${vf}`]).out);
    const v = readVersion(vf, git(cwd, ['show', `${to}:${vf}`]).out);
    if (!v || !pv || v === pv) return null;
    first = first || { from: pv, to: v };
  }
  return first;
}

/** Chemins cités entre accents graves qui n'existent pas. */
export function missingCitedPaths(text, cwd, { exists = null } = {}) {
  const has = exists || ((p) => fs.existsSync(path.isAbsolute(p) ? p : path.join(cwd, p)));
  const out = [];
  for (const m of String(text).matchAll(/`([^`\n]{2,200})`/g)) {
    const p = m[1].trim().replace(/:\d+(-\d+)?$/, '');
    const looksPath = /^[\w.\-@]+([\\/][\w.\-@ ]+)+$/.test(p) || /^[\w.\-]+\.(m?js|cjs|ts|tsx|jsx|json|md|kt|kts|py|java|css|html|ya?ml|toml|txt|ps1|sh|gradle)$/i.test(p) || /^[A-Za-z]:[\\/]/.test(p);
    if (!looksPath || /^https?:/i.test(p) || /[*?]/.test(p)) continue;
    if (has(p)) continue;
    // A file cited to say it is ABSENT (« ni `pyproject.toml` ni `setup.py` »,
    // « pas de `docs/X.md` ») is a correct observation, not an invented path
    // (seen on the first real runs of phase 7). Judged on its own line.
    const start = String(text).lastIndexOf('\n', m.index) + 1;
    const end = String(text).indexOf('\n', m.index);
    const line = STRIP(String(text).slice(start, end < 0 ? undefined : end).replace(/`[^`\n]*`/g, ' '));
    if (/(\bni\b|\bpas d|\baucun|\bsans\b|absent|n.existe pas|inexistant|manqu|\bmissing\b|\bno\b|\bnot\b|does not exist|n.y a pas|a creer|a ajouter)/.test(line)) continue;
    out.push(p);
  }
  return [...new Set(out)];
}

/** File names the orchestrator itself writes (run artefacts, logs), lower case:
 *  cited by a turn that read them, never a file of the project (lever 1). */
export function orchArtefactNames() {
  const names = new Set(['demande.md', 'contexte.md', 'conversation.md', 'diff.patch', 'run.json', 'dispatch.json', 'handoff.json',
    'routage-pending.json', 'routage-released.ndjson', 'pipeline-observe.ndjson', 'pipeline-classify.ndjson', 'model-routing.json',
    'backoff-control.json', 'scans-sortie.txt', 'item-review.idx', 'tests.md', 'plan.md', 'comprehension.md', 'revue.json']);
  for (const s of Object.values(devCatalog())) if (s.artefact) names.add(s.artefact.toLowerCase());
  for (const p of CATALOG_PIPELINES) { try { for (const s of catalogSteps(p)) if (s.artefact) names.add(s.artefact.toLowerCase()); } catch { /* mode-only pipeline */ } }
  return names;
}

/** Paths an artefact cites that are refused, with the switch of lever 1. */
function citedPathsCheck(ctx, art) {
  // « ajuster le critère » answered at a pause (smart pause menu): the lever-1
  // judgement for this run only, traced by the resume (pipeline_criterion_relaxed).
  const relaxed = (ctx.relaxed || []).some(r => r.criterion === 'citedPaths');
  if (!ctx.tuning?.citedPathsLog && !relaxed) return { missing: missingCitedPaths(art, ctx.cwd), reported: [] };
  const v = judgeCitedPaths(art, ctx.cwd, { observed: observedInTurn(ctx.stepLogFile || ''), orchNames: orchArtefactNames() });
  return v;
}

// ---------------------------------------------------------------------------
// Identifiants, événements, notification
// ---------------------------------------------------------------------------
export function newRunId(now = new Date()) {
  const s = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `p-${s}-${crypto.randomBytes(3).toString('hex')}`;
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')} s` : ''}`;
}
/**
 * Who is called back when this run pauses or ends (user report 2026-10-22: a
 * pause after a resume launched without --callback woke nobody). The callback
 * belongs to the RUN: kept in run.json, reused by every resume whoever launches
 * it; a resume launched by the chef (`chefCallback`) sets it to the chef even
 * when it forgot --callback. Updates `state.callback`; the caller saves.
 */
export function runCallback(state, { callbackProject = null, chefCallback = null } = {}) {
  const to = callbackProject || state?.callback || chefCallback || null;
  if (state && to && state.callback !== to) state.callback = to;
  return to;
}

function postNotify(root, project, text, source) {
  return new Promise((resolve) => {
    let token = '';
    try { token = fs.readFileSync(path.join(root, '.token'), 'utf8').trim(); } catch {}
    const port = Number(process.env.ORCH_PORT) || 7777;
    const body = Buffer.from(JSON.stringify({ project, text, source }));
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/notify', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Orchestrator-Token': token } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { try { req.destroy(); } catch {} resolve(null); });
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Consignes d'étape (le contrat du musicien) — le code vérifie, pas le prompt
// ---------------------------------------------------------------------------
/** The message carried by a resume, verbatim — null when it is only the bare
 *  decision (« continuer », « accepter », « tout supprimer »…), already acted on. */
export function resumeMessage(text) {
  const t = String(text || '').replace(/^\s*\[CHEF_ANSWER\]\s*/i, '').trim();
  if (!t) return null;
  if (/^(continue|continuer|reprends|reprendre|on continue|oui|go|vas-y|accepter?|tout\s+supprimer)[\s.!…]*$/i.test(t)) return null;
  // A bare word of the smart pause menu (0.122.0) is a decision too, acted on by its effect.
  const bare = t.replace(/[\s.!…«»"]+$/g, '').replace(/^[«"\s]+/, '');
  if (matchOptionKey(bare) && matchOptionKey(bare).length >= bare.length - 1) return null;
  return t.slice(0, 20_000);
}

/** Step-prompt block quoting every message joined to a resume of this run. */
export function resumeMessagesBlock(messages) {
  if (!messages?.length) return '';
  const L = ['MESSAGE(S) JOINT(S) À LA REPRISE DE CETTE EXÉCUTION — transmis tels quels ; c’est la réponse de l’utilisateur (ou relayée pour lui par le chef) à la pause. Applique-les : une autorisation donnée ici EST accordée, ne la redemande pas. Le plus récent prime en cas de contradiction.'];
  messages.forEach((m, i) => {
    L.push(`--- message ${i + 1}/${messages.length} (${m.at || '?'}${m.step ? `, reprise à l’étape « ${plainStep(m.step)} »` : ''}) ---`);
    L.push(m.text);
  });
  L.push('--- fin des messages joints ---');
  return L.join('\n');
}

function stepPrompt(ctx, step, extra) {
  const { run, pipeline, artDir, cfg } = ctx;
  const art = (f) => path.join(artDir, f).replace(/\\/g, '/');
  const L = [];
  L.push(`[PIPELINE ${pipelineLabel(pipeline, ctx.mode)} — exécution ${run} — étape ${step.title}]`);
  L.push(`PIPELINE_STEP=${step.devRole || step.id}`);
  if (step.devRole) L.push(`ETAPE=${step.id}`);
  L.push(`ARTEFACT=${art(step.artefact)}`);
  L.push(`DOSSIER_ARTEFACTS=${artDir.replace(/\\/g, '/')}`);
  if (ctx.item && ['rouge', 'vert', 'refactor'].includes(step.id)) L.push(`ITEM=${ctx.item.n}: ${ctx.item.text}`);
  L.push('');
  L.push(`Demande d'origine : ${art('demande.md')} (lis-la d'abord). Les artefacts des étapes précédentes sont dans le même dossier : lis ceux qui existent.`);
  if (ctx.lane) {
    L.push(`COULOIR=${ctx.lane.k}`);
    L.push(`Tu travailles dans le couloir ${ctx.lane.k} du projet : une copie isolée du dépôt (git worktree) ${String(ctx.lane.dir).replace(/\\/g, '/')}, sur la branche ${ctx.lane.branch}. D'autres tâches de ce musicien tournent peut-être en même temps dans d'autres copies : reste dans ce dossier, n'écris jamais dans ${String(ctx.lane.main).replace(/\\/g, '/')}.`);
  }
  L.push('');
  const resumeBlock = resumeMessagesBlock(ctx.resumeMessages);
  if (resumeBlock) { L.push(resumeBlock); L.push(''); }
  const T =cfg.testCommand ? `« ${cfg.testCommand} »` : 'la suite de tests du projet';
  if (!step.devRole && (step.checks || step.role)) {
    catalogStepPrompt(L, ctx, step, art, T);
    if (extra?.retryWhy) L.push(`\n⚠ L'essai précédent de cette étape a été REFUSÉ par l'orchestrateur : ${extra.retryWhy}\nCorrige précisément ce point.`);
    L.push(`\nRègles de l’étape : ne lance aucun dispatch (dispatch.mjs), ne pousse rien (git push interdit), ne commite pas${step.kind === 'deliver' ? ' sauf pour cette livraison' : ''}. Termine par un résumé court de ce que tu as fait.`);
    return L.join('\n');
  }
  switch (step.devRole || step.id) {
    case 'comprendre':
      L.push(pipeline === 'dev'
        ? 'Ton rôle : étape 1 COMPRENDRE. Lis le code existant (et les logs utiles) avant toute modification : modules concernés, conventions, points d’entrée, tests existants.'
        : 'Ton rôle : COMPRENDRE la question. Reformule ce qui est réellement demandé, les interprétations possibles, et repère les fichiers utiles du projet.');
      L.push(`Écris ${art('comprehension.md')}. Cite les fichiers du projet entre accents graves (\`chemin/relatif\`) : chaque chemin cité doit exister.`);
      L.push('Ne modifie AUCUN fichier du projet (lecture seule).');
      break;
    case 'rechercher':
      L.push('Ton rôle : RECHERCHER, en lecture seule, ce qu’il faut pour répondre (code, docs, web si utile).');
      L.push(`Écris ${art('recherche.md')} : les faits trouvés, avec leur source (fichier, ligne, URL).`);
      L.push('Ne modifie AUCUN fichier du projet.');
      break;
    case 'repondre':
      L.push('Ton rôle : RÉPONDRE à l’utilisateur, à partir de comprehension.md et recherche.md : une réponse directe, argumentée, avec une recommandation.');
      L.push(`Écris la réponse complète, en Markdown, dans ${art('reponse.md')} : c'est elle que l'utilisateur lira.`);
      L.push('Ne modifie AUCUN fichier du projet. Si une modification est souhaitable, propose-la : elle deviendra une tâche si l’utilisateur la confirme.');
      break;
    case 'concevoir':
      L.push('Ton rôle : étape 2 CONCEVOIR. À partir de comprehension.md : la structure retenue, les compromis, et le découpage en étapes vérifiables. Aucune ligne de code.');
      L.push(`Écris ${art('plan.md')}, avec au moins les sections « ## Approche » et « ## Étapes ».`);
      L.push('Ne modifie AUCUN fichier du projet.');
      break;
    case 'liste-tests':
      L.push('Ton rôle : étape 3 LISTE DE TESTS (TDD canonique, Kent Beck). Liste les COMPORTEMENTS attendus, un par ligne, avec leurs critères d’acceptation — sans aucune décision d’implémentation.');
      {
        const cap = ctx.limits?.testsPerItem || LIMITS.testsPerItem;
        L.push(`Écris ${art('tests.md')} : une case à cocher par comportement, au format exact « - [ ] (tests: N) <comportement observable> », où N est le nombre de tests automatisés prévus pour vérifier cette case, de 1 à ${cap}. Exemple : « - [ ] (tests: 1) « lentille » trouve les produits « Lentilles » ». Au plus ${ctx.limits?.items || LIMITS.items} cases (au-delà : la demande doit être découpée).`);
        L.push(`Une case = UN comportement atomique. Si un comportement demande plus de ${cap} tests (plusieurs variantes, plusieurs champs, plusieurs routes…), découpe-le en plusieurs cases : l’orchestrateur refuse toute case sans « (tests: N) » ou avec N > ${cap}.`);
      }
      if (ctx.escalated) L.push('La demande a dépassé le périmètre du mode léger : un premier test existe déjà (voir rouge.md) et passe. Mets-le en tête, déjà coché « - [x] », puis les comportements RESTANTS à couvrir.');
      L.push('Ne modifie AUCUN fichier du projet. L’orchestrateur traitera ensuite les cases UNE PAR UNE (4a → 4b → 4c).');
      break;
    case 'refactor':
      L.push(`Ton rôle : étape 4c REFACTOR, pour l'item « ${ctx.item?.text || ''} » : nettoie le code maintenant que les tests le protègent, SANS changer le comportement (noms, duplication, lisibilité).`);
      L.push('Interdit : modifier les tests. La suite doit rester verte.');
      L.push(`Écris ${art('refactor.md')} : ce que tu as nettoyé. S'il n'y a rien d'utile à faire, écris exactement « RIEN_A_REFACTORER » dans ce fichier et ne modifie rien.`);
      break;
    case 'rouge':
      if (ctx.item) L.push(`Item de la liste de tests à traiter MAINTENANT, et lui seul (tests.md) : « ${ctx.item.text} ».`);
      L.push(`Ton rôle : étape 4a ROUGE du TDD. Écris UN test qui décrit le comportement attendu${ctx.kind === 'bugfix' && !ctx.item ? ' — ici : un test qui REPRODUIT le bug signalé' : ''}, et rien d'autre.`);
      L.push(`Tu ne modifies QUE des fichiers de test (motifs : ${(cfg.testGlobs || []).join(', ')}). Aucun code de production.`);
      L.push(`Après ton tour, l'orchestrateur lance ${T} : elle doit ÉCHOUER, à cause de ton test.`);
      L.push(`Écris ${art('rouge.md')} : le nom du test, le fichier, et pourquoi il échoue aujourd'hui.`);
      L.push(`Exception : si ce comportement est DÉJÀ assuré par le code existant (tout test fidèle ${ctx.item ? 'à l’item' : 'à la demande'} passe d’emblée), ne fausse jamais le test pour le faire échouer. Garde ce test fidèle comme documentation (il doit être écrit dans CE tour, même si tu l’avais écrit lors d’un essai précédent), écris le mot DEJA_COUVERT en tête de rouge.md, puis la PREUVE : le commit (hash) et/ou le fichier:ligne du code de production qui l’implémente déjà. L’orchestrateur vérifie la preuve, que seuls des tests ont changé et que toute la suite passe ; ${ctx.item ? 'il coche l’item sans 4b ni 4c' : 'il passe alors directement à la revue, sans 4b'}, et la Revue jugera le test.`);
      break;
    case 'vert':
      if (ctx.reviewItems?.length) {
        L.push('Ton rôle : CORRIGER les problèmes relevés par la revue (revue.json), sans toucher aux tests existants (tu peux en AJOUTER).');
        L.push(`Problèmes à corriger :\n${ctx.reviewItems.map(i => `- ${i}`).join('\n')}`);
      } else if (ctx.kind === 'mecanique') {
        L.push('Ton rôle : étape 4b — faire la modification MÉCANIQUE demandée (renommage, remplacement…), sans changer le comportement. Ne modifie aucun test existant.');
      } else {
        if (ctx.item) L.push(`Item en cours : « ${ctx.item.text} ». Ne traite pas les items suivants : ils auront leur propre test.`);
        L.push('Ton rôle : étape 4b VERT du TDD. Écris le code MINIMAL qui fait passer le test écrit à l’étape 4a (voir rouge.md) ET tous les autres.');
        L.push('Interdit : modifier les fichiers de test (l’orchestrateur compare leur empreinte : toute modification est refusée).');
      }
      L.push(`Après ton tour, l'orchestrateur lance ${T} : elle doit PASSER.`);
      L.push(`Écris ${art('vert.md')} : ce que tu as changé et pourquoi. Ne commite pas (l'étape Livrer le fera).`);
      break;
    case 'revue': {
      const scope = ctx.reviewScope;
      if (scope) {
        L.push(`REVUE_ITEM=${scope.group}`);
        L.push(scope.group === 0
          ? 'Ton rôle : REVUE du travail fait AVANT la montée en Développement complet (le premier test et son code), et de lui seul (défauts, sécurité, cohérence, tests suffisants).'
          : `Ton rôle : REVUE de l’item ${scope.group} de la liste de tests, et de lui seul : « ${scope.text} » (défauts, sécurité, cohérence, tests suffisants).`);
        L.push(scope.fallback
          ? `⚠ Le diff propre à cet item n’a pas pu être isolé : le fichier contient tout le changement de l’exécution ; ne juge que ce qui concerne cet item. Fichier :`
          : 'Le diff de CET item seulement (ses étapes 4a, 4b, 4c et les corrections qui lui sont rattachées) est dans le fichier :');
        L.push(`  ${art('diff.patch')}`);
        L.push('Les autres items sont relus séparément, chacun juste après sa boucle : ne relève rien sur eux.');
      } else {
        L.push('Ton rôle : REVUE du changement en cours (défauts, sécurité, cohérence, tests suffisants). Le diff complet est dans le fichier :');
        L.push(`  ${art('diff.patch')}`);
      }
      const covered = scope ? (ctx.coveredItems || []).filter(c => scope.cases.includes(c.n)) : ctx.coveredItems;
      if (covered?.length) L.push(`Items acceptés comme DÉJÀ COUVERTS (leur test passait d'emblée, sans nouveau code) : ${covered.map(coveredLabel).join(' ; ')}. Vérifie que chacun de ces tests est FIDÈLE à son item et qu'il échouerait si le comportement disparaissait ; un test vide de sens est un « problème ».`);
      L.push('Ne relève PAS l’absence de numéro de version incrémenté, d’entrée CHANGELOG ni de ligne dans le registre des exigences : l’étape Livrer, qui suit, les ajoute, et l’orchestrateur les vérifie.');
      L.push(`Écris ${art('revue.json')}, et UNIQUEMENT ce JSON : {"verdict": "ok" | "problèmes", "items": ["défaut de comportement 1", …], "hors_tdd": ["correction de doc ou de commentaire 1", …]}.`);
      L.push('« items » : uniquement des défauts de COMPORTEMENT, qu’un test peut prouver (ils repartent dans la boucle de tests). « hors_tdd » : ce qui ne se teste pas (documentation, README, commentaires…) — ce sera fait à la livraison. « problèmes » seulement pour un défaut réel, à corriger maintenant.');
      if (ctx.mode === 'complet') {
        const cap = ctx.limits?.testsPerItem || LIMITS.testsPerItem;
        L.push(`Chaque entrée de « items » devient une case de tests.md${scope ? ', rattachée à cet item seulement' : ''} : commence-la par « (tests: N) », N = nombre de tests prévus pour la prouver, de 1 à ${cap} (ex. « (tests: 1) [P2] … »). Un défaut qui en demande plus doit être découpé en plusieurs entrées.`);
      }
      L.push('Ne modifie AUCUN fichier du projet.');
      break;
    }
    case 'livrer': {
      if (ctx.deliveryMode === 'release') { deliveryTextPrompt(L, ctx, art, T); break; }
      L.push('Ton rôle : LIVRER et DOCUMENTER (règles de la flotte), dans cet ordre :');
      if (ctx.coveredItems?.length) L.push(`Comportement(s) DÉJÀ assuré(s) par le code existant, sans nouveau code de production (le test ajouté sert de documentation) : ${ctx.coveredItems.map(coveredLabel).join(' ; ')}. Mentionne-le dans l'entrée CHANGELOG et dans ${art('livraison.md')}.`);
      if (ctx.acceptedDefects?.length) L.push(`Défauts ACCEPTÉS explicitement par l'utilisateur, livrés en connaissance de cause : ${ctx.acceptedDefects.map(d => `${d.item != null ? `[item ${d.item}] ` : ''}${d.description}`).join(' ; ')}. Mentionne-les dans l'entrée CHANGELOG (problèmes connus) et dans ${art('livraison.md')}.`);
      if (ctx.deliveryFixes?.length) L.push(`0. d'abord, les corrections relevées par la relecture qui ne relèvent pas des tests (documentation, commentaires…) :\n${ctx.deliveryFixes.map(f => `   - ${f}`).join('\n')}`);
      if (ctx.lane) {
        // P9 / design §2.8: two parallel tasks must never both write the same
        // version; the integrator numbers each task's release in turn.
        L.push(`FRAGMENT=${ctx.lane.fragment}`);
        L.push(`1. NE MODIFIE NI le numéro de version (${(cfg.versionFiles || []).join(', ') || 'fichiers de version'}) NI ${cfg.changelog || 'CHANGELOG.md'} : tu travailles dans un couloir parallèle, c'est l'orchestrateur qui attribue la version en intégrant la branche ;`);
        L.push(`2. écris à la place le fragment ${ctx.lane.fragment} : il commence par « ---\\nbump: patch|minor|major\\n--- » (patch pour une correction, minor pour une fonctionnalité), suivi des sections Keep a Changelog (### Added, ### Fixed…) de cette livraison ;`);
      } else if (ctx.prebump) {
        // 0.114.1: an item of this run already bumped the version — never bump it twice.
        L.push(`1. la version est DÉJÀ incrémentée par un item de cette exécution (${ctx.prebump.from} → ${ctx.prebump.to}) : ne l'incrémente PAS de nouveau ;`);
        L.push(`2. vérifie et complète au besoin l'entrée « ## [${ctx.prebump.to}] » de ${cfg.changelog || 'CHANGELOG.md'} ;`);
      } else {
        L.push(`1. incrémente la version (patch pour une correction, minor pour une fonctionnalité) dans : ${(cfg.versionFiles || []).join(', ') || '(fichier de version du projet)'} ;`);
        L.push(`2. ajoute l'entrée « ## [X.Y.Z] - AAAA-MM-JJ » correspondante dans ${cfg.changelog || 'CHANGELOG.md'} ;`);
      }
      if (cfg.requirements) L.push(`3. ajoute D'OFFICE la ligne de la demande dans ${cfg.requirements} (date, demande verbatim, tests associés, version) — c'est obligatoire à chaque livraison, personne d'autre ne le fera ;`);
      if (ctx.release) {
        // Per-item delivery (0.64.0): the items are already committed; this is the release commit.
        const it = (d) => (d.group === 0 ? 'travail d’avant la montée en complet' : `item ${d.group} « ${d.text} »`);
        L.splice(L.length - (cfg.requirements ? 3 : 2), 0, `Les items sont DÉJÀ livrés par l'orchestrateur, chacun dans son propre commit — ne les refais pas : ${ctx.release.delivered.map(d => `${it(d)} (${d.commit.slice(0, 7)})`).join(' ; ')}. Cette livraison est la VERSION qui les regroupe : l'entrée CHANGELOG et la ligne d'exigence décrivent ces items.`);
        if (ctx.release.aside.length) L.push(`Items MIS DE CÔTÉ, non livrés (ne les mentionne que comme « restant à faire ») : ${ctx.release.aside.map(a => it(a)).join(' ; ')}.`);
        L.push(ctx.prebump && !ctx.lane
          ? `${cfg.requirements ? 4 : 3}. un commit de livraison avec ces seuls changements (git add -A puis git commit) s'il reste quelque chose à compléter ; si version, entrée CHANGELOG${cfg.requirements ? ' et ligne d’exigence' : ''} sont déjà commitées, AUCUN commit — l'arbre doit être propre ensuite ;`
          : `${cfg.requirements ? 4 : 3}. un commit ${ctx.lane ? 'de livraison' : 'de version'} avec ces seuls changements (git add -A puis git commit) — l'arbre doit être propre ensuite ;`);
      } else L.push(`${cfg.requirements ? 4 : 3}. un SEUL commit avec tout le changement (git add -A puis git commit) — l'arbre doit être propre ensuite ;`);
      L.push('Pas de git push (il reste soumis à autorisation). Hormis les corrections de documentation ci-dessus, aucune nouvelle modification de code ni de test.');
      L.push(`Écris ${art('livraison.md')} : ${ctx.lane ? 'fragment, commit' : 'version, commit'}, ce qui a été livré.`);
      L.push(`L'orchestrateur vérifie ensuite : ${ctx.prebump && !ctx.lane ? `depuis le début de l'exécution` : 'commit créé'}, arbre propre, ${ctx.lane ? `version et ${cfg.changelog || 'CHANGELOG.md'} inchangés, fragment ${ctx.lane.fragment} valide` : 'version incrémentée, entrée CHANGELOG'}${cfg.requirements ? ', ligne d’exigence' : ''}, ${T} vert${cfg.buildCommand ? `, build (« ${cfg.buildCommand} »)` : ''}.`);
      break;
    }
  }
  if (extra?.retryWhy) L.push(`\n⚠ L'essai précédent de cette étape a été REFUSÉ par l'orchestrateur : ${extra.retryWhy}\nCorrige précisément ce point.`);
  L.push('\nRègles de l’étape : ne lance aucun dispatch (dispatch.mjs), ne pousse rien (git push interdit), ne commite pas sauf à l’étape Livrer. Termine par un résumé court de ce que tu as fait.');
  return L.join('\n');
}

/**
 * Livrer done by the program (phase 0 b, decision 9): the model writes only
 * the text of the delivery; version, CHANGELOG, requirement line and commit
 * are the code's (code-delivery.mjs), then the same Livrer criterion runs.
 */
function deliveryTextPrompt(L, ctx, art, T) {
  const { cfg } = ctx;
  const cl = cfg.changelog || 'CHANGELOG.md';
  L.push('LIVRAISON=texte');
  L.push('MODIFIER=non');
  const does = ctx.lane ? `le fragment ${ctx.lane.fragment}`
    : ctx.prebump ? `l'entrée « ## [${ctx.prebump.to}] » de ${cl} (la version est DÉJÀ incrémentée par un item de cette exécution : ${ctx.prebump.from} → ${ctx.prebump.to})`
      : `la version (${(cfg.versionFiles || []).join(', ') || 'aucun fichier de version'}) et l'entrée de ${cl}`;
  L.push(`Ton rôle : rédiger le TEXTE de la livraison, et seulement lui. Le programme de l'orchestrateur écrit lui-même ${does}${cfg.requirements ? `, la ligne de ${cfg.requirements}` : ''} et le commit, puis vérifie ${cfg.testCommand ? `${T} vert` : 'le résultat'}${cfg.buildCommand ? ` et le build` : ''}.`);
  if (ctx.coveredItems?.length) L.push(`Comportement(s) DÉJÀ assuré(s) par le code existant (le test ajouté sert de documentation) : ${ctx.coveredItems.map(coveredLabel).join(' ; ')}. Mentionne-le dans l'entrée.`);
  if (ctx.acceptedDefects?.length) L.push(`Défauts ACCEPTÉS explicitement par l'utilisateur : ${ctx.acceptedDefects.map(d => `${d.item != null ? `[item ${d.item}] ` : ''}${d.description}`).join(' ; ')}. Mentionne-les dans l'entrée (problèmes connus).`);
  if (ctx.release) {
    const it = (d) => (d.group === 0 ? 'travail d’avant la montée en complet' : `item ${d.group} « ${d.text} »`);
    L.push(`Items DÉJÀ livrés, chacun dans son commit : ${ctx.release.delivered.map(d => `${it(d)} (${d.commit.slice(0, 7)})`).join(' ; ')}. L'entrée décrit ces items.`);
    if (ctx.release.aside.length) L.push(`Items MIS DE CÔTÉ, non livrés (seulement « restant à faire ») : ${ctx.release.aside.map(a => it(a)).join(' ; ')}.`);
  }
  L.push(`Écris ${art('livraison.md')}, exactement sous cette forme :`);
  if (!ctx.prebump || ctx.lane) L.push('---', 'bump: patch|minor|major', '---   (patch : correction ; minor : fonctionnalité ; major : changement incompatible)');
  L.push('## CHANGELOG', 'les sections Keep a Changelog de cette livraison (### Added, ### Fixed, ### Changed…), SANS la ligne « ## [X.Y.Z] - date » : le programme l’écrit');
  if (cfg.requirements) L.push('## Exigence', `la ligne à ajouter à ${cfg.requirements}, au format de ce fichier (lis ses dernières lignes) : date, demande verbatim, tests associés ; écris {version} à la place du numéro de version`);
  L.push('## Livré', 'ce qui a été livré, en quelques lignes');
  L.push('Ne modifie AUCUN fichier du projet et ne lance ni git add ni git commit : le programme le fait, et refuse l’étape si un fichier a changé.');
}

/**
 * Applies the model's delivery text (phase 0 b). → {ok:true, …} | {ok:false,
 * why, changed, textProblem?}. The model must not have touched the project.
 */
function releaseFromText(ctx, step, before, after) {
  const { cwd, cfg } = ctx;
  const touched = changedFiles(before, after).filter(f => !isLocalOnly(f));
  if (touched.length) return { ok: false, textProblem: true, changed: touched, why: `étape de texte : le model ne modifie aucun fichier du projet, le programme fait la livraison (modifiés : ${touched.slice(0, 8).join(', ')})` };
  if (git(cwd, ['rev-parse', 'HEAD']).out !== ctx.headAtStep) return { ok: false, textProblem: true, changed: [], why: 'étape de texte : le model ne commite pas, le programme fait le commit' };
  const text = parseDeliveryText(readArtefact(ctx, step.artefact), { needBump: !ctx.prebump || !!ctx.lane, needRequirement: !!cfg.requirements });
  if (text.error) return { ok: false, textProblem: true, changed: [], why: `${step.artefact} : ${text.error}` };
  const d = deliverRelease(cwd, cfg, text, { prebump: ctx.lane ? null : ctx.prebump, versionBase: ctx.versionBase, lane: ctx.lane, run: ctx.run });
  return d.ok ? d : { ...d, changed: [] };
}

/**
 * Mettre en forme by the program (lever 3), from relecture.json: no
 * correction, or the text lives in the artefact (both allowed by the « nothing
 * to do » rule of 0.65.0), or every correction is an exact replacement
 * {fichier, avant, apres} found once in its file. Otherwise null: the model.
 */
function formatPlan(ctx, step) {
  const c = step.checks || {};
  const j = parseJsonArtefact(readArtefact(ctx, c.applies?.artefact || 'relecture.json') || '');
  if (!j || !Array.isArray(j.corrections)) return null;
  const list = j.corrections.filter(Boolean);
  const inArtefact = c.applies?.unlessMarker && new RegExp(`\\b${c.applies.unlessMarker}\\b`).test(readArtefact(ctx, c.applies.markerIn) || '');
  if (!list.length || inArtefact) return { nothing: true, why: !list.length ? 'la relecture ne liste aucune correction' : 'le texte est dans l’artefact (texte final dans relecture.json)', count: list.length };
  const edits = [];
  for (const x of list) {
    if (!x || typeof x !== 'object' || typeof x.fichier !== 'string' || typeof x.avant !== 'string' || typeof x.apres !== 'string' || !x.avant) return null;
    const rel = x.fichier.replace(/\\/g, '/').replace(/^\.\//, '');
    if (path.isAbsolute(rel) || rel.split('/').includes('..') || (c.onlyGlobs && !isTestFile(rel, c.onlyGlobs))) return null;
    let s; try { s = fs.readFileSync(path.join(ctx.cwd, rel), 'utf8'); } catch { return null; }
    if (s.split(x.avant).length !== 2) return null;
    edits.push({ fichier: rel, avant: x.avant, apres: x.apres });
  }
  return { edits };
}
function applyFormatPlan(ctx, step, plan) {
  const art = path.join(ctx.artDir, step.artefact);
  if (plan.nothing) {
    fs.writeFileSync(art, `# Mise en forme\n\n${step.checks?.nothing || 'RIEN_A_METTRE_EN_FORME'} — ${plan.why} : rien à appliquer aux documents du projet (fait par le programme, aucun model).\n`);
    return { ok: true };
  }
  for (const e of plan.edits) {
    const f = path.join(ctx.cwd, e.fichier);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(e.avant, () => e.apres));
  }
  fs.writeFileSync(art, `# Mise en forme\n\nCorrections de la relecture appliquées par le programme (remplacements exacts, aucun model) :\n\n${plan.edits.map(e => `- \`${e.fichier}\` : « ${e.avant.slice(0, 120)} » → « ${e.apres.slice(0, 120)} »`).join('\n')}\n`);
  return { ok: true };
}

/** The « nothing to do » instruction, with every section the artefact must still
 *  carry: the marker alone would otherwise be refused by the sections check. */
export function nothingHint(c, exact = false) {
  const secs = c.sections?.length ? `, avec les sections « ${c.sections.map(s => `## ${s}`).join(' », « ')} »` : '';
  return `écris${exact ? ' exactement' : ''} « ${c.nothing} » dans l'artefact${secs}`;
}

/** Consigne d'une étape du catalogue (phase 6) : rôle, artefact, et les critères
 *  que le code vérifiera, dits explicitement (lignes ATTENDU_* lisibles par tous). */
function catalogStepPrompt(L, ctx, step, art, T) {
  const c = step.checks || {};
  L.push(`Ton rôle : ${step.role}`);
  // Lever 3: exact corrections are applied by the program, without a model turn.
  if (ctx.tuning?.codeFormat && step.id === 'relire' && c.json?.corrections) {
    L.push('CORRECTIONS_EXACTES=oui');
    L.push('Une correction d’un document du projet s’écrit, si possible, en remplacement exact : {"fichier": "chemin/relatif.md", "avant": "texte exact, présent une seule fois dans le fichier", "apres": "texte corrigé"} — le programme l’applique lui-même. Une correction qui demande du jugement (reformuler, restructurer) reste une phrase : elle sera faite par un model.');
  }
  if (step.prerun === 'scans') L.push(`Sortie des scanners lancés par l'orchestrateur : ${art('scans-sortie.txt')} (lis-la).`);
  if (step.independent?.length) L.push(`Indépendance : ${step.independent.join(', ')} n'est pas disponible pendant cette étape (retiré par l'orchestrateur) — fais ton propre examen.`);
  const machine = [];
  if (step.kind === 'deliver') machine.push('LIVRAISON=commit');
  else if (step.kind === 'judge') machine.push('MODIFIER=non');
  else if (c.onlyGlobs) machine.push(`MODIFIER=docs (${c.onlyGlobs.join(', ')})`);
  else machine.push('MODIFIER=oui');
  if (c.sections?.length) machine.push(`ATTENDU_SECTIONS=${c.sections.join(' | ')}`);
  if (c.minSources) machine.push(`ATTENDU_SOURCES=${c.minSources}`);
  if (c.json) machine.push(`ATTENDU_JSON=${Object.keys(c.json).join(',')}`);
  if (c.jsonEnum) machine.push(`ATTENDU_ENUM=${Object.entries(c.jsonEnum).map(([k, v]) => `${k}:${v.join('|')}`).join(';')}`);
  if (step.jsonExample) machine.push(`JSON_EXEMPLE=${step.jsonExample}`);
  if (c.nothing) machine.push(`MARQUEUR_RIEN=${c.nothing}`);
  if (c.artefactIsWork) machine.push('ARTEFACT_EST_LE_TRAVAIL=oui');
  if (c.requireFiles?.length) machine.push(`FICHIERS_REQUIS=${c.requireFiles.join(', ')}`);
  const mediaKind = c.media ? (step.mediaKind || c.media.kind) : null;
  if (mediaKind) machine.push(`MEDIA=${mediaKind}`);
  if (c.media?.optionalWith) machine.push(`MARQUEUR_SANS_MEDIA=${c.media.optionalWith}`);
  if (ctx.localTool) machine.push(`OUTIL_LOCAL=${ctx.localTool}`);
  if (c.meeting) machine.push(`REUNION=${c.meeting}`);
  L.push(...machine);
  L.push('');
  if (step.kind === 'judge') {
    L.push(`Écris ${art(step.artefact)}${c.json ? ', et UNIQUEMENT ce JSON' : ''}. Ne modifie AUCUN fichier du projet (lecture seule : l’orchestrateur compare les empreintes).`);
  } else if (step.kind === 'deliver') {
    L.push(step.role ? '' : 'Livre en un seul commit.');
    L.push(`Écris ${art(step.artefact)} : le commit et ce qui a été livré. L'orchestrateur vérifie : commit créé, arbre propre.`);
  } else {
    L.push(c.meeting && step.jsonExample ? `Écris ${art(step.artefact)}, et UNIQUEMENT ce JSON (format plus bas).` : `Écris ${art(step.artefact)} : ce que tu as fait et pourquoi.`);
    if (c.onlyGlobs) L.push(`Tu ne modifies QUE des documents (motifs : ${c.onlyGlobs.join(', ')}) : aucun code, aucun test.`);
    if (c.protectTests) L.push('Interdit : modifier les tests existants (l’orchestrateur compare leur empreinte).');
    if (c.nothing) L.push(`S'il n'y a rien à faire, ${nothingHint(c, true)} et ne modifie rien : c'est accepté.`);
    if (c.artefactIsWork) L.push(`Cet artefact EST le travail de l'étape : complet, il suffit, même si aucun fichier du projet ne change.`);
    if (c.requireFiles?.length) L.push(`À la fin, ces fichiers doivent exister : ${c.requireFiles.join(', ')}.`);
    if (ctx.cfg.testCommand || c.needTestCommand) L.push(`Après ton tour, l'orchestrateur lance ${c.needTestCommand ? 'la commande de test déclarée dans .orchestrateur/pipeline.json' : T}${c.suiteTwice ? ' DEUX fois' : ''} : elle doit PASSER.`);
    L.push('Ne commite pas (l’étape de livraison le fera).');
  }
  if (c.sections?.length) L.push(`L'artefact doit contenir les sections « ${c.sections.map(s => `## ${s}`).join(' », « ')} ».`);
  if (c.minSources) L.push(`Au moins ${c.minSources} source(s) distincte(s), chacune avec son URL (https://…).`);
  if (c.citedPaths) L.push('Cite les fichiers du projet entre accents graves (`chemin/relatif`) : chaque chemin cité doit exister.');
  if (step.jsonExample) L.push(`Format exact : ${step.jsonExample}`);
  if (mediaKind) {
    const word = { image: 'image(s)', video: 'vidéo(s)', audio: 'fichier(s) audio', text: 'fichier(s) texte' }[mediaKind];
    L.push(`Liste CHAQUE ${word} produit(s) dans une section « ## Fichiers » de l'artefact, un chemin entre accents graves par ligne (relatif au projet, ou absolu dans le dossier d'artefacts). L'orchestrateur ouvre chaque fichier et vérifie son type${mediaKind === 'image' ? ' et ses dimensions' : mediaKind === 'text' ? '' : ' (et, si ffprobe est installé, la durée et les pistes)'} : un fichier annoncé mais absent ou invalide fait refuser l'étape.`);
    if (c.media?.optionalWith) L.push(`Si la demande ne réclame aucun fichier à cette étape, écris « ${c.media.optionalWith} » dans l'artefact.`);
  }
  if (ctx.localTool) L.push(`Outil local affecté à cette étape dans la page Models : « ${ctx.localTool} » (installé). Utilise-le pour le traitement.`);
  if (ctx.lastMedia?.length && step.kind === 'judge' && catalogOf(ctx.pipeline)?.media) {
    L.push(`Fichiers produits à vérifier${step.vision ? ' (ouvre chaque image avec l’outil Read : tu les vois)' : ''} :\n${ctx.lastMedia.map(f => `- ${f}`).join('\n')}`);
  }
  if (step.id === 'rapporter' && /^\s*\[NEEDS_CHEF_INPUT_FROM:/.test(ctx.request || '')) {
    L.push('Cette demande est la QUESTION D’UN MUSICIEN (relais automatique) : le rapport doit commencer par « [ANSWER] » suivi de ta décision, ou par « NEEDS_USER_INPUT: » si la décision revient à l’utilisateur — l’orchestrateur relaie selon ce préfixe.');
  }
}

const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Sections `##` présentes (mot-clé contenu dans un titre, sans accents). */
export function missingSections(text, wanted) {
  const heads = [...String(text || '').matchAll(/^#{2,4}\s+(.+)$/gm)].map(m => fold(m[1]));
  return (wanted || []).filter(w => !heads.some(h => h.includes(fold(w))));
}
/** Sources distinctes : URL http(s), et (option) chemins cités entre accents graves. */
export function countSources(text, { files = false, urls: withUrls = true } = {}) {
  // Internal research (phase 1): only files of the project count, never an URL.
  const urls = new Set([...(withUrls ? String(text || '') : '').matchAll(/https?:\/\/[^\s)>\]"'`]+/g)].map(m => m[0].replace(/[.,;:]+$/, '')));
  if (files) for (const m of String(text || '').matchAll(/`([\w.\-/\\]+\.[a-z0-9]{1,6})`/gi)) urls.add(m[1]);
  return urls.size;
}
function parseJsonArtefact(art) {
  try { return JSON.parse(String(art).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Routage (lot B, 0.54.0) : contexte, tâches, étapes exécutées par le code
// ---------------------------------------------------------------------------
const MAX_TASKS = 6;
function readConfig(root) { return readJson(path.join(root, 'config.json')) || { projects: [] }; }
function conductorOf(root) { return readConfig(root).conductor || 'chef'; }

/** Tâches du Routage : projet de la liste blanche (jamais le chef), pipeline connu, demande autonome. */
export function validateTasks(root, tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return 'aucune tâche';
  if (tasks.length > MAX_TASKS) return `${tasks.length} tâches (au plus ${MAX_TASKS} par message : découper)`;
  const cfg = readConfig(root);
  const conductor = cfg.conductor || 'chef';
  const names = new Set((cfg.projects || []).map(p => p.name));
  for (const [i, t] of tasks.entries()) {
    const n = `tâche ${i + 1}`;
    if (!t || typeof t !== 'object') return `${n} illisible`;
    if (!names.has(t.projet)) return `${n} : projet inconnu « ${t.projet} »`;
    // A task handed back to the chef (0.88.0) is the chef's own work: it may name
    // the chef; any other task never does.
    if (!t.renvoi_chef && (t.projet === conductor || new RegExp(`^${conductor}-\\d+$`).test(t.projet))) return `${n} : le chef ne se délègue pas de tâche (s’il doit agir lui-même : « renvoi_chef »)`;
    if (t.apres != null && tasks[t.apres - 1]?.renvoi_chef) return `${n} : « apres » ne peut pas désigner une tâche renvoyée au chef (elle part à la fin de ce tour)`;
    if (!ENGINE_PIPELINES.includes(t.pipeline) || t.pipeline === 'routage') return `${n} : pipeline inconnu « ${t.pipeline} »`;
    if (t.mode != null && !['leger', 'complet', ...(GENERIC_MODES[t.pipeline] || [])].includes(t.mode)) return `${n} : mode « ${t.mode} » (leger ou complet${GENERIC_MODES[t.pipeline] ? `, ou ${GENERIC_MODES[t.pipeline].join(', ')}` : ''})`;
    if (typeof t.demande !== 'string' || t.demande.trim().length < 8) return `${n} : demande absente ou trop courte`;
    if (t.apres != null && !(Number.isInteger(t.apres) && t.apres >= 1 && t.apres <= i)) return `${n} : « apres » doit désigner une tâche précédente (1 à ${i})`;
    // 0.58.0: resuming a paused run is explicit, and only a real paused run of
    // that project can be resumed (otherwise a NEW run would start).
    if (t.reprise != null) {
      if (typeof t.reprise !== 'string' || !new RegExp(`^${RUN_ID_RE.source}$`).test(t.reprise)) return `${n} : « reprise » doit être un identifiant d'exécution (p-AAAAMMJJTHHMMSS-xxxxxx)`;
      if (!detectReprise(path.join(root, 'logs'), { projet: t.projet, reprise: t.reprise })) return `${n} : l'exécution ${t.reprise} n'est pas une exécution en pause de ${t.projet}`;
    }
  }
  return null;
}

/**
 * Unit tasks of the Decomposer (0.69.0): same rules as validateTasks, but NO
 * pipeline yet — each task is classified on its own afterwards. A pipeline may
 * only come from the user's explicit prefix (« impose »).
 */
export function validateUnitTasks(root, tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return 'aucune tâche';
  for (const [i, t] of tasks.entries()) {
    // 0.87.0: an id alone told the chef nothing and two tasks of one request were
    // confused (2026-10-13); every task is named here, where it is decided.
    const why = t && typeof t === 'object' ? titleProblem(t.titre) : null;
    if (why) return `tâche ${i + 1} : ${why}`;
    if (t?.renvoi_chef != null) { const h = handoffProblem(t); if (h) return `tâche ${i + 1} : ${h}`; }
    // 0.95.0: a fresh session is a flag for dispatch.mjs (--new-session), so it
    // must be a real boolean, and it means nothing for a resumed run.
    if (t?.session_neuve != null) {
      if (t.session_neuve !== true && t.session_neuve !== false) return `tâche ${i + 1} : « session_neuve » doit valoir true (ou être absent)`;
      if (t.session_neuve && t.reprise) return `tâche ${i + 1} : « session_neuve » et « reprise » s’excluent (une reprise continue l’exécution en pause)`;
    }
    // 0.99.0: « meme_tache » = this task continues the musician's current task,
    // so its session (that task's history) is resumed; without it, fresh.
    if (t?.meme_tache != null) {
      if (t.meme_tache !== true && t.meme_tache !== false) return `tâche ${i + 1} : « meme_tache » doit valoir true (ou être absent)`;
      if (t.meme_tache && t.session_neuve) return `tâche ${i + 1} : « meme_tache » et « session_neuve » s’excluent`;
    }
  }
  // 0.90.0 (task 2/4): two tasks of this run that look alike where they are
  // shown would be confused again, as on 2026-10-13.
  const ambiguous = ambiguityProblem(tasks);
  if (ambiguous) return ambiguous;
  for (const [i, t] of tasks.entries()) {
    if (t?.hors_pipeline == null) continue;
    const h = t.hors_pipeline;
    // 0.71.2 (n° 10): an off-pipeline task must quote the user's authorization.
    if (typeof h !== 'object' || typeof h.raison !== 'string' || h.raison.trim().length < 8 || typeof h.autorisation !== 'string' || h.autorisation.trim().length < 3) {
      return `tâche ${i + 1} : « hors_pipeline » doit être {"raison": "…", "autorisation": "les mots exacts de l’utilisateur qui l’autorisent"}`;
    }
    if (t.impose) return `tâche ${i + 1} : « hors_pipeline » et « impose » s’excluent`;
  }
  const probe = tasks.map((t) => {
    if (!t || typeof t !== 'object') return t;
    const imp = t.impose && typeof t.impose === 'object' ? t.impose : {};
    if (imp.pipeline != null && (!ENGINE_PIPELINES.includes(imp.pipeline) || imp.pipeline === 'routage')) return { ...t, pipeline: `imposé « ${imp.pipeline} »` };
    return { ...t, pipeline: imp.pipeline || 'discussion', mode: imp.mode ?? null };
  });
  return validateTasks(root, probe);
}

/**
 * Chef's own actions (0.70.0, ROUTAGE-PROBLEMES n° 7 and 9): what the chef
 * does ITSELF never becomes a musician task. Allowlist only; each action maps
 * to one orchestrator script, run by the code with an argv array (never a
 * shell string). The restart runs AFTER the chef's turn has ended, outside
 * the server's process tree (it kills that tree).
 */
export const CHEF_ACTIONS = {
  'restart-orchestrateur': { script: 'restart-orchestrateur.mjs', project: false, deferred: true },
  'kill-stalled': { script: 'kill-stalled.mjs', project: true, needs: 'raison' },
  'resolve-question': { script: 'resolve-question.mjs', project: true },
  'copy-build': { script: 'copy-build.mjs', project: true },
};
const MAX_CHEF_ACTIONS = 4;

/** null when the chef actions are valid, else the reason (in French, for the retry). */
export function validateChefActions(root, actions) {
  if (actions == null) return null;
  if (!Array.isArray(actions)) return '« actions » doit être une liste';
  if (actions.length > MAX_CHEF_ACTIONS) return `${actions.length} actions (au plus ${MAX_CHEF_ACTIONS})`;
  const cfg = readConfig(root);
  const conductor = cfg.conductor || 'chef';
  const names = new Set((cfg.projects || []).map(p => p.name));
  for (const [i, a] of actions.entries()) {
    const n = `action ${i + 1}`;
    const def = a && typeof a === 'object' ? CHEF_ACTIONS[a.action] : null;
    if (!def) return `${n} : « ${a?.action ?? a} » n’est pas une action du chef autorisée (liste blanche : ${Object.keys(CHEF_ACTIONS).join(', ')})`;
    if (def.project) {
      if (!names.has(a.projet)) return `${n} (${a.action}) : projet inconnu « ${a.projet} »`;
      if (a.projet === conductor || new RegExp(`^${conductor}-\\d+$`).test(a.projet)) return `${n} (${a.action}) : le chef ne s’applique pas cette action à lui-même`;
    } else if (a.projet != null) return `${n} (${a.action}) : pas de projet pour cette action`;
    if (def.needs && !(typeof a[def.needs] === 'string' && a[def.needs].trim().length >= 4)) return `${n} (${a.action}) : « ${def.needs} » obligatoire`;
    if (def.deferred && (i !== actions.length - 1 || actions.filter(x => x?.action === a.action).length > 1)) return `${n} (${a.action}) : une seule fois, et en dernier`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hand-off to the chef (0.88.0). User, 2026-10-14: « IL faut que le routage
// puisse renvoyer au chef pour qu'il agisse lui meme ». A task the chef must do
// ITSELF on the orchestration (close paused runs, manage a queue, …) that the
// code allowlist (CHEF_ACTIONS) does not cover used to be refused (« le chef ne
// se délègue pas de tâche ») or end as a question. Now the Decomposer marks it
// `renvoi_chef`, the classifier model confirms it is chef work (never project
// work: code, git, build), and ONE chef turn — out of the Routage, signed by a
// token — is launched once this Routage turn has ended.
// ---------------------------------------------------------------------------
const HANDOFF_REF_RE = /^(p-\d{8}T\d{6}-[0-9a-f]{6})#(\d{1,2}(?:,\d{1,2}){0,5})$/;
export function handoffToken(root, ref) {
  return crypto.createHmac('sha256', derivedToken(root, 'chef-handoff')).update(String(ref)).digest('hex');
}
/** {run, tasks} when `token` signs `ref`, else null. */
export function verifyHandoff(root, ref, token) {
  const m = HANDOFF_REF_RE.exec(String(ref || ''));
  if (!m || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const want = Buffer.from(handoffToken(root, ref), 'hex');
  const got = Buffer.from(token, 'hex');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return { run: m[1], tasks: m[2].split(',').map(Number) };
}
/** Prompt of the hand-off turn: the tasks, and what the chef may (not) do. */
export function handoffPrompt(run, tasks) {
  return `[RENVOI_CHEF ${run}] Le Routage t’a renvoyé ${tasks.length > 1 ? 'ces tâches' : 'cette tâche'} : tu agis TOI-MÊME, sans la confier à un musicien.\n\n` +
    tasks.map(t => `## Tâche ${t.n} « ${t.titre} »${t.projet ? ` (projet concerné : ${t.projet})` : ''}\n\n${t.demande}\n\nPourquoi c’est pour toi : ${t.raison}`).join('\n\n') +
    '\n\nRègles : seulement l’infrastructure d’orchestration (exécutions de pipeline, files, tâches en attente du Routage, questions, avec les scripts de l’orchestrateur) ; ' +
    'jamais de travail de projet (code, git, build, livraison) ni de dispatch vers toi-même. Si une tâche est en réalité du travail de projet ou demande une décision, ' +
    'ne la fais pas : termine par « NEEDS_USER_INPUT: <question> ». Termine par un compte rendu court de ce que tu as fait.';
}
/** null when the `renvoi_chef` of a decomposed task is valid, else why. */
function handoffProblem(t) {
  const h = t.renvoi_chef;
  if (typeof h !== 'object' || h == null || typeof h.raison !== 'string' || h.raison.trim().length < 8) return '« renvoi_chef » doit être {"raison": "pourquoi le chef doit agir lui-même"}';
  for (const k of ['impose', 'hors_pipeline', 'reprise', 'ne_pas_dispatcher', 'session_neuve', 'meme_tache']) if (t[k]) return `« renvoi_chef » et « ${k} » s’excluent`;
  if (t.apres != null) return '« renvoi_chef » ne peut pas attendre une autre tâche (« apres ») : le chef agit à la fin de ce tour';
  return null;
}
/** Launches the hand-off chef turn once `waitPid` (this Routage turn) has exited. */
function launchHandoff({ root, logsDir, scriptsDir, run, tasks, waitPid, env = process.env }) {
  const ref = `${run}#${tasks.map(t => t.n).join(',')}`;
  const file = path.join(logsDir, 'runs', run, 'handoff.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ref, conductor: conductorOf(root), prompt: handoffPrompt(run, tasks), tasks: tasks.map(t => ({ n: t.n, titre: t.titre, projet: t.projet })) }, null, 2));
  } catch (e) { return { ref, status: 'failed', why: e.message }; }
  // A test root never starts a real chef turn unless the test asks for it.
  if (env.DISPATCH_ROOT_FOR_TESTS && env.ORCH_CHEF_HANDOFF_TEST !== '1') return { ref, status: 'refused', why: 'racine de test sans ORCH_CHEF_HANDOFF_TEST=1 : aucun tour réel', file };
  const childEnv = { ...env, ORCH_HANDOFF_TOKEN: handoffToken(root, ref) };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID']) delete childEnv[k];
  try {
    // Detached like a musician task (launchTask): it outlives this turn, then
    // waits for it — two chef turns never resume the same session at once.
    const c = spawn(process.execPath, [path.join(scriptsDir, 'chef-action-deferred.mjs'), '--wait-pid', String(waitPid), '--handoff', file,
      '--log', path.join(logsDir, 'chef-actions.log')], { cwd: root, env: childEnv, detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => {});
    c.unref();
    return { ref, status: c.pid ? 'scheduled' : 'failed', pid: c.pid || null, file };
  } catch (e) { return { ref, status: 'failed', why: e.message }; }
}

/** argv (after the script path) of one validated chef action. */
export function chefActionArgs(a) {
  if (a.action === 'kill-stalled') return [a.projet, '--by', 'chef', '--reason', String(a.raison).replace(/\s+/g, ' ').trim().slice(0, 300)];
  if (a.action === 'resolve-question') return [a.projet, ...(typeof a.note === 'string' && a.note.trim() ? ['--note', a.note.replace(/\s+/g, ' ').trim().slice(0, 500)] : [])];
  if (a.action === 'copy-build') return [a.projet];
  return [];
}

/**
 * Runs the chef actions. ORCH_CHEF_ACTION_RUNNER (tests) replaces every
 * script by `node <runner> <action> …args`; a test root without it never runs
 * a real script (a test must never restart the production server).
 */
function runChefActions({ actions, scriptsDir, logsDir, waitPid, env = process.env }) {
  const out = [];
  for (const a of actions) {
    const def = CHEF_ACTIONS[a.action];
    const args = chefActionArgs(a);
    const rec = { action: a.action, ...(a.projet ? { projet: a.projet } : {}), ...(def.deferred ? { deferred: true } : {}) };
    const childEnv = { ...env };
    for (const k of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID']) delete childEnv[k];
    if (env.ORCH_CHEF_ACTION_RUNNER) {
      const r = spawnSync(process.execPath, [env.ORCH_CHEF_ACTION_RUNNER, a.action, ...args], { env: childEnv, encoding: 'utf8', timeout: 120_000, windowsHide: true });
      out.push({ ...rec, status: r.status === 0 ? (def.deferred ? 'scheduled' : 'done') : 'failed', code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-600) });
      continue;
    }
    if (env.DISPATCH_ROOT_FOR_TESTS) { out.push({ ...rec, status: 'refused', why: 'racine de test sans ORCH_CHEF_ACTION_RUNNER : aucune action réelle' }); continue; }
    if (def.deferred) {
      // Win32_Process Create: the waiter's parent is WMI, not this turn — the
      // restart kills the server tree, which this turn belongs to.
      const q = (s) => `"${String(s).replace(/"/g, '')}"`;
      const cmd = [q(process.execPath), q(path.join(scriptsDir, 'chef-action-deferred.mjs')), '--wait-pid', String(waitPid), '--script', def.script, '--log', q(path.join(logsDir, 'chef-actions.log'))].join(' ');
      const ps = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmd.replace(/'/g, "''")}'} | Select-Object -ExpandProperty ReturnValue`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: childEnv, encoding: 'utf8', timeout: 60_000, windowsHide: true });
      const ok = r.status === 0 && String(r.stdout).trim() === '0';
      out.push({ ...rec, status: ok ? 'scheduled' : 'failed', code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-600) });
      continue;
    }
    const r = spawnSync(process.execPath, [path.join(scriptsDir, def.script), ...args], { env: childEnv, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    out.push({ ...rec, status: r.status === 0 ? 'done' : 'failed', code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-600) });
  }
  return out;
}

/**
 * True when `quote` appears in the user's own words: the current message
 * (demande.md) or a user line of the recent conversation (conversation.md),
 * never a line of the chef. Compared case-, accent- and spacing-insensitively.
 */
function userSaid(ctx, quote) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[«»"“”'’]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(quote);
  if (q.length < 3) return false;
  // A musician's relayed question or a wake-up is not the user speaking: a
  // musician must never authorize itself.
  const relayed = (s) => /\[(NEEDS_CHEF_INPUT_FROM:|CALLBACK_WAKE)/.test(s);
  const demande = readArtefact(ctx, 'demande.md') || '';
  const userText = [
    relayed(demande) ? '' : demande,
    ...String(readArtefact(ctx, 'conversation.md') || '').split(/\n\n+/).filter(l => /^\*\*utilisateur\*\*/.test(l) && !relayed(l)),
  ].join('\n');
  return norm(userText).includes(q);
}

/** Les derniers échanges du fil (demandes, réponses du chef, résultats), pour l'étape Lire. */
// ---------------------------------------------------------------------------
// No silent truncation (0.93.0). User, 2026-10-14: « c'est problematique »
// — a musician's report reached the chef cut at « | 26cf9ce7 |
// orchestrateur-dev | attend » (its « after » list missing) although the whole
// 3,207-character report was in the chef's log: the excerpt given to the
// Routage cut every message at 2,000 characters, and the 30,000-character
// window cut the oldest kept message in the middle, both without a word.
// Now a cut is always stated, with where the whole text is, and the window
// drops whole messages, never part of one.
// ---------------------------------------------------------------------------
export const EXCERPT_MESSAGE_MAX = 8000;
/** `text` cut at `max` (word boundary) with an explicit notice, or as is. */
export function clipText(text, max, { where = null } = {}) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, cut: false };
  const kept = s.slice(0, max).replace(/\s+\S*$/, '');
  return { text: `${kept} […]\n⚠ [tronqué par l’orchestrateur : ${kept.length} caractères affichés sur ${s.length}${where ? ` — texte complet : ${where}` : ''}]`, cut: true };
}
/** Who wrote a user_prompt: never « utilisateur » for a musician's message. */
function promptAuthor(e) {
  if (!e.source) return 'utilisateur';
  if (e.source === 'wake') return 'réveil';
  return `message de ${e.source}`;
}

export function conversationExcerpt(logFile, { max = 30, maxChars = 30_000, perMessage = EXCERPT_MESSAGE_MAX, fullDir = null } = {}) {
  let lines = [];
  let firstLine = 1;
  try {
    const st = fs.statSync(logFile);
    const fd = fs.openSync(logFile, 'r');
    const len = Math.min(st.size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    lines = buf.toString('utf8').split('\n');
    if (len < st.size) { lines.shift(); firstLine = 0; }   // partial first line; line numbers unknown then
  } catch { return '# Conversation récente\n\n(aucune)\n'; }
  const msgs = [];
  lines.forEach((l, i) => {
    let e; try { e = JSON.parse(l); } catch { return; }
    const lineNo = firstLine ? i + 1 : null;
    if (e.type === 'user_prompt' && typeof e.text === 'string' && !e.pipeline?.answer) msgs.push({ who: promptAuthor(e), text: e.text, lineNo });
    else if (e.type === 'assistant') {
      for (const b of e.message?.content || []) { if (b?.type === 'text' && b.text?.trim()) msgs.push({ who: 'chef', text: b.text.trim(), lineNo }); }
    } else if (e.type === 'notification' && e.subtype === 'musician_done' && e.text) msgs.push({ who: 'résultat', text: notificationReportText(e), lineNo });
  });
  const recent = msgs.slice(-max);
  const blocks = recent.map((m, k) => {
    let where = null;
    if (m.text.length > perMessage) {
      if (fullDir) {
        try {
          fs.mkdirSync(fullDir, { recursive: true });
          const f = path.join(fullDir, `message-${String(k + 1).padStart(2, '0')}.md`);
          fs.writeFileSync(f, m.text);
          where = `${f} (à lire avec Read)`;
        } catch { /* fall back to the log reference */ }
      }
      if (!where) where = `${logFile}${m.lineNo ? `, ligne ${m.lineNo}` : ''}`;
    }
    return `**${m.who}** : ${clipText(m.text, perMessage, { where }).text}`;
  });
  // Keep the most recent messages whole; drop whole older ones to fit.
  const kept = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (kept.length && size + blocks[i].length + 2 > maxChars) break;
    kept.unshift(blocks[i]);
    size += blocks[i].length + 2;
  }
  const omitted = msgs.length - kept.length;
  const head = omitted > 0 ? `⚠ [${omitted} message(s) plus ancien(s) non repris ici — journal complet : ${logFile}]\n\n` : '';
  return `# Conversation récente (extraite du log par l'orchestrateur)\n\n${head}${kept.join('\n\n') || '(aucune)'}\n`;
}

// ── Helpers of the generic pipelines (phase 1) ─────────────────────────────
/** Context of a typed operation run from a pipeline step. */
function opContext(root, ctx, projectName) {
  const adb = process.env.ORCH_ADB || 'adb';
  // ORCH_ADB may name a Node script (a stand-in device for the tests): run by node, argv kept.
  const exec = /\.m?js$/i.test(adb) ? (argv, o) => Ops.defaultExec(argv[0] === adb ? [process.execPath, adb, ...argv.slice(1)] : argv, o) : undefined;
  return { cwd: ctx.cwd, root, project: projectName, cfg: ctx.cfg || {}, config: readConfig(root), env: ctx.testEnv || process.env,
    backupDir: path.join(ctx.runDir, 'sauvegarde'), bins: { adb }, ...(exec ? { exec } : {}) };
}
/** One commit of exactly these paths (never `git add -A` of the whole tree); hooks run. */
function commitPaths(cwd, files, message) {
  const ident = git(cwd, ['config', 'user.email']).out ? [] : ['-c', 'user.name=orchestrateur', '-c', 'user.email=orchestrateur@localhost'];
  const a = git(cwd, ['add', '-A', '--', ...files]);
  if (!a.ok) return { ok: false, why: a.err.split('\n')[0] };
  if (!git(cwd, ['diff', '--cached', '--name-only', '--', ...files]).out) return { ok: true, empty: true };
  const c = git(cwd, [...ident, 'commit', '-q', '-m', message, '--', ...files]);
  if (!c.ok) return { ok: false, why: (c.err || c.out).split('\n')[0] };
  return { ok: true, commit: git(cwd, ['rev-parse', 'HEAD']).out };
}
export const DOC_OPERATION_OPTIONS = [
  { id: 'relire-corriger', what: 'proofread and correct the document in place (spelling, grammar, accuracy), same structure and length' },
  { id: 'resumer', what: 'write a summary of the document as a NEW file (the source is kept)' },
  { id: 'traduire', what: 'translate the document into another language as a NEW file (the source is kept)' },
  { id: 'reformater', what: 'reformat the document in place (layout, headings, lists, tables), same content' },
  { id: 'completer', what: 'complete the document in place: add lines, items or sections, remove nothing' },
  { id: 'convertir', what: 'convert the document to another text format as a NEW file (e.g. Markdown to HTML)' },
];
const LANG_NAMES = { fr: 'French', en: 'English', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch' };
export const DOC_REVIEW_LINES = 80;
/** Snapshot and copies of the targets taken before the first « Modifier » (document mode). */
function readDocBase(ctx) {
  const j = readJson(path.join(ctx.runDir, 'doc-base.json')) || {};
  const backups = new Map(), files = new Map();
  for (const [p, f] of Object.entries(j.backups || {})) { try { backups.set(p, fs.readFileSync(f)); files.set(p, f); } catch { /* gone */ } }
  return { snapshot: new Map(Object.entries(j.snapshot || {})), backups, files };
}
function saveDocBase(ctx, cible) {
  const f = path.join(ctx.runDir, 'doc-base.json');
  if (fs.existsSync(f)) return;
  const dir = path.join(ctx.runDir, 'sauvegarde');
  fs.mkdirSync(dir, { recursive: true });
  const backups = {};
  cible.targets.forEach((t, i) => { const to = path.join(dir, `${i + 1}-${path.basename(t.abs)}`); fs.copyFileSync(t.abs, to); backups[t.path] = to; });
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), backups, snapshot: Object.fromEntries(snapshot(ctx.cwd)) }));
}
/** A refused document attempt outside git: the targets come back from their copy, new files go. */
function restoreDocAttempt(ctx, before, after) {
  const base = readDocBase(ctx);
  for (const [p, buf] of base.backups) { const abs = path.isAbsolute(p) ? p : path.join(ctx.cwd, p); try { if (!fs.readFileSync(abs).equals(buf)) fs.writeFileSync(abs, buf); } catch { /* gone */ } }
  for (const f of changedFiles(before, after)) if (!before.has(f) && !base.backups.has(f)) { try { fs.rmSync(path.join(ctx.cwd, f), { force: true }); } catch {} }
}
/** Named skip rules (`skipUnless`): null = the step runs, else the reason it is skipped. */
const SKIP_RULES = {
  'files-acquire': ({ ctx }) => {
    const pl = Files.checkFilesPlan(ctx.cwd, readArtefact(ctx, 'fichiers.json'), { demande: readArtefact(ctx, 'demande.md') || '', exists: false });
    return pl.ok && pl.value.ops.some(o => o.op === 'acquerir') ? null : 'aucun téléchargement dans le plan';
  },
  'document-relire': ({ ctx, state }) => {
    const outs = state.docOutputs || [];
    if (!outs.length) return 'document déjà conforme : rien à relire';
    const n = Doc.changedLineCount(ctx.cwd, outs, readDocBase(ctx).backups);
    return n > DOC_REVIEW_LINES ? null : `modification de ${n} ligne(s) : relecture seulement au-delà de ${DOC_REVIEW_LINES}`;
  },
};
const WEB_TOOLS = /^(WebSearch|WebFetch|web_search|web_fetch|mcp__.*web)/i;
/**
 * Discussion « vérification »: every finding carries a proof the code can
 * check — a file that exists (and was read or seen in the turn), a command run
 * in THIS turn, or an URL seen in the turn.
 */
function checkVerification(ctx, json) {
  const list = Array.isArray(json.constats) ? json.constats : [];
  if (!list.length) return { ok: false, why: 'verification.json : aucun constat' };
  const uses = toolUsesInTurn(ctx.stepLogFile || '');
  const seen = observedInTurn(ctx.stepLogFile || '');
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const [i, c] of list.entries()) {
    const n = `constat ${i + 1}`;
    if (!c || typeof c.affirmation !== 'string' || c.affirmation.trim().length < 3) return { ok: false, why: `${n} : « affirmation » absente` };
    if (typeof c.observe !== 'string' || !c.observe.trim()) return { ok: false, why: `${n} : « observe » (ce qui a été constaté) absent` };
    const verdict = STRIP(c.verdict || '');
    if (!VERIFY_VERDICTS.includes(verdict)) return { ok: false, why: `${n} : « verdict » doit valoir ${VERIFY_VERDICTS.join(', ')} (reçu « ${c.verdict} »)` };
    const pr = typeof c.preuve === 'string' ? { type: /^https?:/i.test(c.preuve) ? 'url' : 'fichier', ref: c.preuve } : c.preuve;
    if (!pr?.ref) { if (verdict === 'indetermine') continue; return { ok: false, why: `${n} : « preuve » obligatoire pour un verdict « ${verdict} »` }; }
    const ref = String(pr.ref).trim();
    if (pr.type === 'fichier') {
      const m = /^(.*?)(?::(\d+)(?:-\d+)?)?$/.exec(ref);
      const abs = path.isAbsolute(m[1]) ? m[1] : path.join(ctx.cwd, m[1]);
      if (!fs.existsSync(abs)) return { ok: false, why: `${n} : preuve « ${ref} » introuvable` };
      if (m[2] && fs.statSync(abs).isFile() && Number(m[2]) > fs.readFileSync(abs, 'utf8').split('\n').length) return { ok: false, why: `${n} : la ligne ${m[2]} n’existe pas dans ${m[1]}` };
      const key = norm(m[1]).replace(/\\/g, '/');
      if (!seen.text.includes(key) && !seen.text.includes(norm(path.basename(m[1])))) return { ok: false, why: `${n} : le fichier « ${m[1]} » n’a pas été lu ni vu pendant le tour (preuve non observée)` };
    } else if (pr.type === 'commande') {
      if (!uses.some(u => /^(Bash|PowerShell)$/.test(u.name) && u.ok && norm(u.input?.command).includes(norm(ref)))) return { ok: false, why: `${n} : la commande « ${ref.slice(0, 80)} » n’a pas été lancée dans ce tour (preuve non observée)` };
    } else if (pr.type === 'url') {
      if (!/^https?:\/\/\S+$/i.test(ref)) return { ok: false, why: `${n} : URL invalide « ${ref.slice(0, 80)} »` };
      if (!seen.text.includes(norm(ref)) && !uses.some(u => JSON.stringify(u.input || {}).toLowerCase().includes(norm(ref)))) return { ok: false, why: `${n} : l’URL « ${ref.slice(0, 80)} » n’a pas été consultée dans ce tour` };
    } else return { ok: false, why: `${n} : type de preuve « ${pr.type} » (fichier, commande ou url)` };
  }
  return { ok: true };
}
/** Markdown of a verification (the answer of the Discussion « vérification »). */
export function verificationMarkdown(json) {
  const icon = { vrai: '✓', faux: '✕', partiel: '◐', indetermine: '?' };
  const rows = (json?.constats || []).map((c) => {
    const v = STRIP(c.verdict || '');
    const pr = typeof c.preuve === 'string' ? c.preuve : c.preuve?.ref ? `${c.preuve.type} : ${c.preuve.ref}` : '—';
    return `| ${icon[v] || ''} ${v} | ${String(c.affirmation).replace(/\|/g, '/')} | ${String(c.observe).replace(/\|/g, '/')} | \`${String(pr).replace(/\|/g, '/').replace(/`/g, '')}\` |`;
  });
  return ['## Vérification', '', '| Verdict | Affirmation | Constaté | Preuve (vérifiée par l’orchestrateur) |', '|---|---|---|---|', ...rows, ''].join('\n');
}

const CODE_STEPS = {
  /**
   * Meeting pipeline (0.110.0): the drafts are deleted by the CODE, from the
   * explicit list of suppression.json only (validated again here), never a
   * file in doubt unless the user answered « tout supprimer », never the
   * definitive text. Each file is copied to logs/runs/<run>/corbeille/ first.
   */
  async 'reunion-supprimer'({ root, logsDir, ctx, state, artDir, run, writeEvent }) {
    const m = meetingContext(ctx);
    if (m.why || !m.sorting) return { ok: false, why: m.why || m.sortingWhy };
    const { plan, refused } = Meeting.deletionPlan(ctx.cwd, m.sorting, { definitive: m.definitive?.fichier, withDoubts: !!state.deleteDoubts });
    if (refused.length) return { ok: false, why: `suppression refusée : ${refused.map(r => `${r.chemin} (${r.why})`).join(', ')}` };
    const trash = path.join(logsDir, 'runs', run, 'corbeille');
    const before = Meeting.parseJson(readArtefact(ctx, 'suppression-faite.json') || '') || {};
    const r = Meeting.deleteFiles(ctx.cwd, plan, trash);
    // A resumed run keeps what an earlier pass already deleted.
    const supprimes = [...(before.supprimes || []), ...r.done];
    const kept = state.deleteDoubts ? [] : m.sorting.doutes.map(d => d.chemin);
    const trashRel = path.relative(root, trash).split(path.sep).join('/');
    fs.writeFileSync(path.join(artDir, 'suppression-faite.json'), JSON.stringify({ supprimes, absents: r.missing, doutes_gardes: kept, corbeille: trashRel }, null, 2));
    writeEvent({ type: 'system', subtype: 'meeting_deleted', pipeline: { run, step: 'supprimer' }, deleted: supprimes.map(d => d.chemin), kept, trash: trashRel,
      text: `🗑 ${supprimes.length} fichier(s) supprimé(s) par le code, d’après la liste explicite (copie gardée dans ${trashRel})${kept.length ? ` ; ${kept.length} fichier(s) en doute gardé(s)` : ''}` });
    return { ok: true };
  },
  /** Meeting pipeline (0.110.0): the final check, by code only — what must remain exists, what was deleted is gone. */
  async 'reunion-verifier'({ ctx, artDir, run, writeEvent }) {
    const m = meetingContext(ctx);
    if (m.why || !m.sorting) return { ok: false, why: m.why || m.sortingWhy };
    const f = Meeting.checkFiling(ctx.cwd, { art: readArtefact(ctx, 'rangement.json'), inv: m.inv, sorting: m.sorting, definitive: m.definitive, demande: m.demande, deleted: m.deleted });
    if (!f.ok) return { ok: false, why: `vérification finale : ${f.why}` };
    const v = Meeting.verifyMeeting(ctx.cwd, { inv: m.inv, filing: f.value, deleted: m.deleted, definitive: m.definitive, demande: m.demande });
    const done = Meeting.parseJson(readArtefact(ctx, 'suppression-faite.json') || '') || {};
    const md = [
      `## Réunion « ${m.inv.nom} »`, '',
      `Retrouvable par son index : \`${f.value.index}\`${f.value.indexGlobal ? ` (cité dans \`${f.value.indexGlobal}\`)` : ''}, dossier \`${m.inv.dossier}\`.`, '',
      '## Éléments gardés (vérifiés par l’orchestrateur)', ...v.lines, '',
      '## Supprimés', ...((done.supprimes || []).length ? done.supprimes.map(d => `- \`${d.chemin}\` — ${d.raison || ''}${d.doute ? ' (doute levé par l’utilisateur)' : ''}`) : ['- aucun']),
      ...((done.supprimes || []).length ? ['', `Une copie de chaque fichier supprimé est gardée dans \`${done.corbeille}\`.`] : []),
      ...((done.doutes_gardes || []).length ? ['', '## Gardés (en doute, sans réponse « tout supprimer »)', ...done.doutes_gardes.map(c => `- \`${c}\``)] : []),
      '', `## Vérification : ${v.ok ? '✓ tout ce qui doit rester existe, tout ce qui a été supprimé a disparu' : `✕ ${v.problems.join(' ; ')}`}`,
    ].join('\n');
    fs.writeFileSync(path.join(artDir, 'verification.md'), `${md}\n`);
    writeEvent({ type: 'system', subtype: 'meeting_verified', pipeline: { run, step: 'verifier' }, ok: v.ok, problems: v.problems, index: f.value.index,
      text: v.ok ? `✓ réunion « ${m.inv.nom} » : ${f.value.elements.length} élément(s) rangé(s), index ${f.value.index}, supprimés absents` : `✕ vérification de la réunion : ${v.problems.join(' ; ')}` });
    return v.ok ? { ok: true } : { ok: false, why: `vérification finale : ${v.problems.join(' ; ')}` };
  },

  // ── Opérations (pipelines phase 1, typed-operations.mjs) ───────────────
  /** codeFirst of « Préparer »: the classifier named the operations, all in the registry → no model turn. */
  async 'operations-preparer'({ state, artDir }) {
    const c = state.classification || {};
    if (!Array.isArray(c.operations) || !c.operations.length) return null;
    const p = Ops.parseOperations({ operations: c.operations.map(o => ({ id: o.id, params: o.params || {} })), ...(c.autorisation ? { autorisation: c.autorisation } : {}) });
    if (!p.ok) return null;
    fs.writeFileSync(path.join(artDir, 'operations.json'), JSON.stringify({ operations: p.ops, ...(p.autorisation ? { autorisation: p.autorisation } : {}), source: 'classement' }, null, 2));
    return { done: true, why: `opération(s) nommée(s) par le classement (${p.ops.map(o => o.id).join(', ')}) : préparées par le programme, sans tour de model` };
  },
  /**
   * Decision 5: an irreversible operation runs only with the user's own words
   * (a quote found in demande.md or a user line of the conversation, never a
   * relayed musician), or the answer « autoriser » at the pause. Preconditions
   * are read first: nothing runs on a plan that cannot run.
   */
  async 'operations-autoriser'({ root, ctx, state, artDir, projectName, run, writeEvent }) {
    const j = parseJsonArtefact(readArtefact(ctx, 'operations.json') || '') || {};
    if (Array.isArray(j.operations) && !j.operations.length) {
      const what = String(j.hors_liste || 'ce qui est demandé').replace(/\s+/g, ' ').trim().slice(0, 400);
      const q = `${projectName} : aucune opération de la liste fermée ne fait « ${what} ». Voulez-vous la déclarer comme script du projet (operations.scripts de .orchestrateur/pipeline.json, avec son contrôle), ou la faire autrement ?`;
      return { finish: `Rien n’a été exécuté : aucune opération de la liste fermée ne fait ce qui est demandé (${what}).\n\nOpérations possibles : ${Ops.OPERATION_IDS.join(', ')}. Une commande propre au projet peut être déclarée dans \`.orchestrateur/pipeline.json\` (« operations.scripts », avec un contrôle de son effet), puis demandée comme « run_script ».\n\nNEEDS_USER_INPUT: ${q}` };
    }
    const p = Ops.parseOperations(j);
    if (!p.ok) return { ok: false, why: `operations.json : ${p.why}` };
    const octx = opContext(root, ctx, projectName);
    const done = new Set(state.opsDone || []);
    const pre = Ops.precheckOperations(octx, p.ops);
    // Only the next operation is checked now: a later one may need what an
    // earlier one makes (install the APK that copy_build publishes) — it is
    // checked again when its turn comes, and the run stops there if it fails.
    const next = p.ops.findIndex((_, i) => !done.has(i));
    const blocked = pre.map((x, i) => ({ ...x, i })).filter(x => !x.ok && x.i === next);
    if (blocked.length) {
      const why = blocked.map(b => `${b.id} : ${b.why}`).join(' ; ');
      return { pause: { limit: 'operation', notice: `⏸ ${projectName} : une opération ne peut pas partir (condition préalable non remplie)`,
        what: `avant toute exécution, l’orchestrateur a vérifié les conditions de chaque opération : ${why}. Rien n’a été lancé.`, input: { why, extra: { stage: 'precondition', operations: blocked.map(b => b.id) } } } };
    }
    const authorized = new Set(state.authorizedOps || []);
    const rows = [], need = [];
    p.ops.forEach((op, i) => {
      const irr = pre[i].irreversible && !pre[i].already && !done.has(i);
      const quote = op.autorisation || p.autorisation || '';
      let by = null;
      if (!irr) by = pre[i].already ? 'déjà fait' : 'réversible';
      else if (authorized.has(i)) by = 'réponse « autoriser » de l’utilisateur à la pause';
      else if (quote.replace(/\s+/g, ' ').trim().length >= 4 && userSaid(ctx, quote)) by = `demande écrite de l’utilisateur : « ${quote.slice(0, 200)} »`;
      if (irr && !by) need.push(i);
      rows.push({ n: i + 1, id: op.id, detail: pre[i].detail, irreversible: pre[i].irreversible, authorized: !!by, by });
    });
    fs.writeFileSync(path.join(artDir, 'autorisation.json'), JSON.stringify({ operations: rows }, null, 2));
    state.opsAuthorized = rows.filter(r => r.authorized).map(r => r.n - 1);
    if (need.length) {
      state.pendingAuth = need;
      const list = need.map(i => `${p.ops[i].id} (${pre[i].detail || Ops.OPERATIONS[p.ops[i].id].label})`);
      return { pause: { limit: 'autoriser', notice: `⏸ ${projectName} : action irréversible en attente de votre autorisation`,
        what: `ces opérations sont irréversibles et votre demande ne les autorise pas en toutes lettres : ${list.join(' ; ')}. Rien n’a été lancé. Seule votre réponse « autoriser » les déclenche (jamais une réponse automatique).`,
        input: { extra: { operations: list } } } };
    }
    writeEvent({ type: 'system', subtype: 'pipeline_operations_authorized', pipeline: { run, step: 'autoriser' }, operations: rows,
      text: `opérations autorisées : ${rows.map(r => `${r.id} (${r.by})`).join(' ; ')}` });
    return { ok: true };
  },
  /** Each operation: preconditions, argv (never a shell), then its postcondition re-read; stops at the first false one. */
  async 'operations-executer'({ root, ctx, state, artDir, projectName, run, writeEvent }) {
    const p = Ops.parseOperations(parseJsonArtefact(readArtefact(ctx, 'operations.json') || '') || {});
    if (!p.ok) return { ok: false, why: `operations.json : ${p.why}` };
    const octx = opContext(root, ctx, projectName);
    const done = new Set(state.opsDone || []);
    const allowed = new Set(state.opsAuthorized || []);
    const results = Array.isArray(state.opsResults) ? state.opsResults : [];
    for (const [i, op] of p.ops.entries()) {
      if (done.has(i)) continue;
      // Defence in depth: an irreversible operation never runs without its authorization.
      if (Ops.isIrreversible(octx, op) && !allowed.has(i)) {
        const prep = Ops.precheckOperations(octx, [op])[0];
        if (!prep.already) return { ok: false, why: `${op.id} : irréversible et non autorisée — refusée par le code` };
      }
      const r = await Ops.runOperation(octx, op);
      results[i] = { n: i + 1, ...r };
      state.opsResults = results;
      fs.writeFileSync(path.join(artDir, 'execution.json'), JSON.stringify({ operations: results.filter(Boolean) }, null, 2));
      writeEvent({ type: 'system', subtype: 'pipeline_operation', pipeline: { run, step: 'executer' }, operation: { n: i + 1, id: op.id, ok: r.ok, already: !!r.already, code: r.code ?? null, observed: r.observed, why: r.why || null, ms: r.ms },
        text: `${r.ok ? '✓' : '✕'} ${op.id}${r.detail ? ` — ${r.detail}` : ''} : ${r.ok ? `${r.already ? 'déjà fait, ' : ''}vérifié (${r.observed})` : `${r.why} (${r.observed})`}` });
      if (!r.ok) {
        return { pause: { limit: 'operation', notice: `⏸ ${projectName} : l’opération ${op.id} n’a pas produit l’effet vérifié`,
          what: `${op.id}${r.detail ? ` (${r.detail})` : ''} : ${r.why}. Constaté : ${r.observed}.${r.out ? ` Sortie : ${String(r.out).split('\n').slice(-4).join(' | ').slice(0, 600)}` : ''} Les opérations suivantes n’ont pas été lancées.`,
          input: { why: r.why, extra: { stage: r.stage || 'postcondition', operation: op.id, observed: r.observed } } } };
      }
      done.add(i);
      state.opsDone = [...done];
    }
    return { ok: true };
  },
  /** The report, written by the code from execution.json: what ran, what was verified. */
  async 'operations-rapporter'({ ctx, state, artDir }) {
    const res = (parseJsonArtefact(readArtefact(ctx, 'execution.json') || '') || {}).operations || state.opsResults || [];
    const auth = (parseJsonArtefact(readArtefact(ctx, 'autorisation.json') || '') || {}).operations || [];
    const md = ['## Opérations', '', '| # | Opération | Résultat vérifié par l’orchestrateur |', '|---|---|---|',
      ...res.filter(Boolean).map(r => `| ${r.n} | ${r.id}${r.detail ? ` — ${String(r.detail).replace(/\|/g, '/')}` : ''} | ${r.ok ? `✓ ${r.already ? 'déjà fait — ' : ''}${String(r.observed).replace(/\|/g, '/')}` : `✕ ${String(r.why).replace(/\|/g, '/')}`} |`), '',
      '## Autorisations', '', ...(auth.length ? auth.map(a => `- ${a.id} : ${a.irreversible ? `irréversible — ${a.by || 'non autorisée'}` : a.by}`) : ['- aucune nécessaire']), '',
      '## Commandes', '', ...res.filter(r => r?.argv).map(r => `- \`${r.argv.join(' ')}\` (code ${r.code})`), '',
      '_Un code retour seul ne vaut jamais « fait » : chaque effet a été relu (postcondition)._'];
    fs.writeFileSync(path.join(artDir, 'rapport.md'), `${md.join('\n')}\n`);
    return { ok: true };
  },

  // ── Fichiers (pipelines phase 1, files-check.mjs) ──────────────────────
  /** Copy, move, rename, delete (trash first) and compare: by the code, from the explicit plan only. */
  async 'fichiers-executer'({ ctx, state, artDir, projectName, run, writeEvent }) {
    const pl = Files.checkFilesPlan(ctx.cwd, readArtefact(ctx, 'fichiers.json'), { demande: readArtefact(ctx, 'demande.md') || '', exists: false });
    if (!pl.ok) return { ok: false, why: pl.why };
    const plan = pl.value;
    const before = snapshot(ctx.cwd);
    const ex = Files.executeFilesPlan(ctx.cwd, plan, { trashDir: path.join(ctx.runDir, 'corbeille'), withDoubts: !!state.deleteDoubts });
    const after = snapshot(ctx.cwd);
    const allowed = new Set([...plan.ops.flatMap(o => [o.destination, ['deplacer', 'renommer', 'supprimer'].includes(o.op) && !o.outside ? o.source : null]), ...(state.deleteDoubts ? plan.doutes.map(d => d.chemin) : [])].filter(Boolean));
    const extra = changedFiles(before, after).filter(f => !isLocalOnly(f) && !allowed.has(f));
    fs.writeFileSync(path.join(artDir, 'execution.json'), JSON.stringify({ results: ex.results.map(({ sourceAbs, ...r }) => r), comparisons: ex.comparisons }, null, 2));
    const by = (s) => ex.results.filter(r => r.status === s).length;
    writeEvent({ type: 'system', subtype: 'pipeline_files_done', pipeline: { run, step: 'executer' }, done: by('done'), already: by('already'), failed: by('failed'),
      text: `📁 ${by('done')} opération(s) de fichiers faite(s) par le code${by('already') ? `, ${by('already')} déjà faite(s)` : ''}${by('failed') ? `, ${by('failed')} en échec` : ''}${ex.comparisons.length ? ` ; ${ex.comparisons.length} comparaison(s)` : ''}` });
    if (extra.length) return { ok: false, why: `des fichiers hors du plan ont changé pendant l’exécution : ${extra.slice(0, 8).join(', ')}` };
    const failed = ex.results.filter(r => r.status === 'failed');
    if (failed.length) {
      const why = failed.map(r => `${r.op} ${r.source || r.label || ''} : ${r.why}`).join(' ; ');
      return { pause: { limit: 'operation', notice: `⏸ ${projectName} : ${failed.length} opération(s) de fichiers en échec`,
        what: `${why}. Les autres opérations sont faites (voir execution.json) ; rien n’a été écrasé.`, input: { why, extra: { stage: 'execution' } } } };
    }
    return { ok: true };
  },
  /** The postconditions, re-read on the disk; verification.md is the result of the run. */
  async 'fichiers-verifier'({ ctx, run, writeEvent }) {
    const pl = Files.checkFilesPlan(ctx.cwd, readArtefact(ctx, 'fichiers.json'), { demande: readArtefact(ctx, 'demande.md') || '', exists: false });
    if (!pl.ok) return { ok: false, why: pl.why };
    const ex = parseJsonArtefact(readArtefact(ctx, 'execution.json') || '') || { results: [], comparisons: [] };
    const v = Files.verifyFilesPlan(ctx.cwd, pl.value, ex.results || []);
    const kept = pl.value.doutes.filter(d => fs.existsSync(path.join(ctx.cwd, d.chemin)));
    const md = ['## Fichiers (vérifiés par l’orchestrateur)', '', ...(v.lines.length ? v.lines : ['- aucune opération de fichier']), '',
      ...(ex.comparisons?.length ? ['## Comparaisons', '', Files.comparisonsMarkdown(ex.comparisons)] : []),
      ...(kept.length ? ['## Gardés (en doute, sans réponse « tout supprimer »)', ...kept.map(d => `- \`${d.chemin}\` — ${d.question}`), ''] : []),
      `## Vérification : ${v.ok ? '✓ chaque effet est présent sur le disque' : `✕ ${v.problems.join(' ; ')}`}`];
    fs.writeFileSync(path.join(ctx.artDir, 'verification.md'), `${md.join('\n')}\n`);
    writeEvent({ type: 'system', subtype: 'pipeline_files_verified', pipeline: { run, step: 'verifier' }, ok: v.ok, problems: v.problems,
      text: v.ok ? '✓ fichiers vérifiés par l’orchestrateur' : `✕ vérification des fichiers : ${v.problems.join(' ; ')}` });
    return v.ok ? { ok: true } : { ok: false, why: `vérification : ${v.problems.join(' ; ')}` };
  },
  /** One commit of the text files the plan touched, never a binary, never another file; outside git: nothing. */
  async 'fichiers-livrer'({ ctx, run }) {
    const art = path.join(ctx.artDir, 'livraison.md');
    if (!isGitWorkTree(ctx.cwd)) { fs.writeFileSync(art, '# Livraison\n\nDossier hors git : rien à commiter. Chaque effet a été vérifié sur le disque (verification.md) ; les fichiers supprimés ont une copie dans la corbeille de l’exécution.\n'); return { ok: true }; }
    const pl = Files.checkFilesPlan(ctx.cwd, readArtefact(ctx, 'fichiers.json'), { demande: readArtefact(ctx, 'demande.md') || '', exists: false });
    if (!pl.ok) return { ok: false, why: pl.why };
    const touched = [...new Set([...pl.value.ops.flatMap(o => [o.destination, ['deplacer', 'renommer', 'supprimer'].includes(o.op) && !o.outside ? o.source : null]), ...pl.value.doutes.map(d => d.chemin)].filter(Boolean))];
    const changed = touched.length ? git(ctx.cwd, ['status', '--porcelain', '--', ...touched]).out.split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, '')) : [];
    const binary = changed.filter(f => fs.existsSync(path.join(ctx.cwd, f)) && Files.isBinaryFile(path.join(ctx.cwd, f)));
    const text = changed.filter(f => !binary.includes(f));
    if (!text.length) {
      fs.writeFileSync(art, `# Livraison\n\nRien à commiter${binary.length ? ` : les fichiers binaires ne sont jamais versionnés par la livraison (${binary.slice(0, 10).map(f => `\`${f}\``).join(', ')})` : ''}.\n`);
      return { ok: true };
    }
    const c = commitPaths(ctx.cwd, text, `files: ${String(ctx.request || '').split('\n').find(l => l.trim())?.slice(0, 80) || 'file operations'}\n\nDelivered by the orchestrator (pipeline run ${run}): file operations done and verified by the program.`);
    if (!c.ok) return { ok: false, why: `commit impossible : ${c.why}` };
    fs.writeFileSync(art, `# Livraison\n\n${c.empty ? 'Rien de nouveau à commiter.' : `Commit ${c.commit.slice(0, 12)} fait par le programme (aucun model) : ${text.map(f => `\`${f}\``).join(', ')}.`}${binary.length ? `\n\nNon versionnés (binaires) : ${binary.map(f => `\`${f}\``).join(', ')}.` : ''}\n`);
    return { ok: true };
  },

  // ── Rédaction « document » (pipelines phase 1, document-check.mjs) ─────
  /**
   * codeFirst of « Cibler »: the request names ONE existing document (path
   * found on the disk); the operation is chosen by the MEANING (classifier
   * model, closed list). Otherwise the model's Cibler step runs.
   */
  async 'document-cibler'({ root, logsDir, ctx, artDir, projectName }) {
    const demande = readArtefact(ctx, 'demande.md') || '';
    const cands = Doc.candidateTargets(ctx.cwd, demande);
    if (cands.length !== 1) return null;
    const { chooseOption } = await import('./pipeline-classify.mjs');
    const r = await chooseOption({ root, logsDir, project: projectName, request: demande, question: `Which one-off operation does this request ask on the existing document ${cands[0].path}?`,
      options: DOC_OPERATION_OPTIONS });
    if (!r.ok) return null;
    let langue = null;
    if (r.id === 'traduire') {
      const l = await chooseOption({ root, logsDir, project: projectName, request: demande, question: 'Into which language must the document be translated?', options: Doc.LANGS.map(id => ({ id, what: LANG_NAMES[id] || id })) });
      if (!l.ok) return null;
      langue = l.id;
    }
    const cible = { fichiers: [cands[0].path], operation: r.id, sortie: Doc.NEW_FILE_OPS.has(r.id) ? 'nouveau' : 'remplacer', ...(langue ? { langue } : {}) };
    const v = Doc.checkTarget(ctx.cwd, cible, { demande, protectedFn: (f) => isTestFile(f, ctx.cfg.testGlobs || []) });
    if (!v.ok) return { ok: false, why: v.why };
    fs.writeFileSync(path.join(artDir, 'cible.json'), JSON.stringify({ ...cible, source: 'programme' }, null, 2));
    return { done: true, model: r.model, why: `un seul document nommé par la demande (${cands[0].path}) ; opération « ${r.id} » choisie par le model de classement, par le sens` };
  },
  /** Commit of the document(s) only (no version); outside git: backup, fingerprints and diff. */
  async 'document-livrer'({ ctx, state, run }) {
    const art = path.join(ctx.artDir, 'livraison.md');
    const outs = state.docOutputs || [];
    if (!outs.length) { fs.writeFileSync(art, `# Livraison\n\nDocument déjà conforme (${Doc.DOC_ALREADY}) : rien n’a été modifié, rien à livrer.\n`); return { ok: true }; }
    const base = readDocBase(ctx);
    const L = ['# Livraison', '', '| Document | Avant (SHA-256) | Après (SHA-256) |', '|---|---|---|'];
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
    const diffs = [];
    for (const o of outs) {
      const absOut = path.join(ctx.cwd, o.output);
      const before = base.backups.get(o.source);
      L.push(`| \`${o.output}\`${o.output !== o.source ? ` (depuis \`${o.source}\`)` : ''} | ${before ? sha(before) : '—'} | ${sha(fs.readFileSync(absOut))} |`);
      const bf = base.files.get(o.source);
      if (bf) diffs.push(spawnSync('git', ['diff', '--no-index', '--no-color', '--', bf, absOut], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).stdout || '');
    }
    const inGit = isGitWorkTree(ctx.cwd);
    let commitLine = 'Dossier hors git : la copie d’avant est gardée dans la sauvegarde de l’exécution (`logs/runs/' + run + '/sauvegarde/`), avec les empreintes et le diff ci-dessous.';
    if (inGit) {
      const c = commitPaths(ctx.cwd, outs.map(o => o.output), `docs: ${String(ctx.request || '').split('\n').find(l => l.trim())?.slice(0, 80) || 'document'}\n\nDelivered by the orchestrator (pipeline run ${run}): document checked and committed by the program, no version.`);
      if (!c.ok) return { ok: false, why: `commit impossible : ${c.why}` };
      commitLine = c.empty ? 'Rien de nouveau à commiter.' : `Commit ${c.commit.slice(0, 12)} fait par le programme (aucun model), seulement ${outs.map(o => `\`${o.output}\``).join(', ')} ; pas de version.`;
    }
    L.push('', commitLine, '', '## Diff', '', '```diff', diffs.join('\n').slice(0, 20_000), '```');
    const mod = (readArtefact(ctx, 'modification.md') || '').trim();
    if (mod) L.push('', '## Ce qui a été fait', '', mod.slice(0, 4000));
    fs.writeFileSync(art, `${L.join('\n')}\n`);
    return { ok: true };
  },
  /**
   * Split before classify (0.69.0): every unit task of taches.json is
   * classified ON ITS OWN — one call to the routage.classifier model per task,
   * which sees only that task. A task the model finds ambiguous, or that it
   * cannot classify, becomes a question to the user (never a guess); a task no
   * pipeline covers raises a gap about THAT task, never about the whole message.
   */
  async classer({ root, logsDir, ctx, state, artDir, projectName, writeEvent, run }) {
    const j = parseJsonArtefact(readArtefact(ctx, 'taches.json') || '') || {};
    const units = Array.isArray(j.taches) ? j.taches : [];
    const questions = [];
    if (!units.length) {
      if (String(j.question || '').trim()) questions.push(String(j.question).replace(/\s+/g, ' ').trim());
      state.tasks = [];
      fs.writeFileSync(path.join(artDir, 'classement.json'), JSON.stringify({ taches: [], questions }, null, 2));
      return { ok: true };
    }
    const { classifyTask } = await import('./pipeline-classify.mjs');
    const out = [];
    const models = new Set();
    // Chef actions found while classifying tasks (0.71.0, n° 8): run by the
    // Dispatcher's code like the Decomposer's own « actions », never dispatched.
    const extraActions = [];
    for (const [i, t] of units.entries()) {
      const n = i + 1;
      const imp = t.impose && typeof t.impose === 'object' ? t.impose : {};
      const base = { n, projet: t.projet, titre: cleanTitle(t.titre), demande: t.demande, ...(t.rattache ? { rattache: t.rattache } : {}), ...(t.apres ? { apres: t.apres } : {}), ...(t.reprise ? { reprise: t.reprise } : {}), ...(t.ne_pas_dispatcher ? { ne_pas_dispatcher: true } : {}), ...(t.session_neuve === true ? { sessionNeuve: true } : {}), ...(t.meme_tache === true ? { memeTache: true } : {}) };
      // Explicitly marked « not for a musician » (0.71.0, n° 8): never dispatched,
      // not even classified — the user says what it is (never guess).
      if (t.ne_pas_dispatcher) {
        const q = `Tâche ${n} (${t.projet}) marquée « ne pas dispatcher » : elle n’est confiée à aucun musicien. Est-ce une action du chef (redémarrer le serveur, arrêter un tour, marquer une question répondue, publier un APK) ? Laquelle ?`;
        questions.push(q);
        out.push({ ...base, route: false, noDispatch: true, question: q });
        continue;
      }
      // Off-pipeline task authorized by the user (0.71.2, n° 10): not classified
      // (it can no longer fall into a gap) and launched with --hors-pipeline —
      // only if the quoted authorization really is the user's own words, in
      // this message or in the recent conversation (never the chef's).
      if (t.hors_pipeline) {
        const h = t.hors_pipeline;
        const raison = String(h.raison).replace(/\s+/g, ' ').trim().slice(0, 300);
        if (userSaid(ctx, h.autorisation)) {
          out.push({ ...base, route: true, pipeline: null, mode: null, kind: null, horsPipeline: raison, autorisation: String(h.autorisation).trim().slice(0, 300), classifier: 'hors-pipeline', raison });
          writeEvent?.({ type: 'system', subtype: 'pipeline_hors_pipeline', pipeline: { run }, task: n, projet: t.projet, reason: raison,
            text: `↷ tâche ${n} (${t.projet}) lancée hors pipeline, autorisée par l’utilisateur (« ${String(h.autorisation).trim().slice(0, 120)} ») : ${raison}` });
        } else {
          const q = `Tâche ${n} (${t.projet}) : elle devait partir hors pipeline (« ${raison} »), mais l’autorisation citée (« ${String(h.autorisation).trim().slice(0, 120)} ») ne figure pas dans vos messages. L’autorisez-vous hors pipeline ?`;
          questions.push(q);
          out.push({ ...base, route: false, question: q, refused: 'autorisation hors pipeline introuvable' });
        }
        continue;
      }
      // Resuming a paused run keeps that run's own pipeline: nothing to classify.
      if (t.reprise) { out.push({ ...base, route: true, pipeline: imp.pipeline || null, mode: imp.mode || null, kind: null, classifier: 'reprise', raison: `reprise de l’exécution ${t.reprise}` }); continue; }
      const c = await classifyTask({ root, logsDir, task: t, fixed: { pipeline: imp.pipeline || null, mode: imp.mode || null } });
      if (c.model) models.add(c.model);
      // Handed back to the chef (0.88.0): the classifier model must see chef
      // work too — project work (code, git, build) is never done by the chef.
      if (t.renvoi_chef && !c.chef) {
        const seen = c.failed ? `le classement a échoué (${c.why})` : c.question ? `le classement hésite : ${c.question}` : c.pipeline ? `le classement y voit du travail de projet (pipeline ${c.pipeline})` : 'le classement n’y voit pas une action du chef';
        const q = `Tâche ${n} « ${base.titre} » : le découpage la renvoie au chef pour qu’il agisse lui-même, mais ${seen}. Le chef ne fait jamais de travail de projet : faut-il la confier à un musicien, ou est-ce bien au chef d’agir ?`;
        questions.push(q);
        out.push({ ...base, route: false, question: q, refused: 'renvoi au chef non confirmé par le classement', classifier: c.classifier || null });
        continue;
      }
      if (c.chef) {
        const def = CHEF_ACTIONS[c.chef];
        const cand = def ? { action: c.chef, ...(def.project ? { projet: t.projet } : {}), ...(def.needs ? { [def.needs]: String(c.raison || t.demande).slice(0, 300) } : {}), ...(c.chef === 'resolve-question' && c.raison ? { note: String(c.raison).slice(0, 300) } : {}) } : null;
        // A chef action that must wait for another task (« apres ») cannot run at
        // the end of this turn: a restart would kill the awaited musician's turn.
        const why = !cand ? 'hors liste blanche'
          : t.apres ? `elle doit attendre la fin de la tâche ${t.apres}, et une action du chef part à la fin de ce tour — à redemander quand la tâche ${t.apres} sera finie`
          : validateChefActions(root, [...(Array.isArray(j.actions) ? j.actions : []), ...extraActions, cand]);
        if (cand && !why) {
          extraActions.push(cand);
          out.push({ ...base, route: false, chefAction: cand.action, raison: c.raison || null, classifier: c.classifier });
        } else if (!cand && !t.apres) {
          // No allowlisted script fits: the chef acts itself, in a turn of its
          // own after this one (0.88.0) — no longer a question to the user.
          const raison = String(t.renvoi_chef?.raison || c.raison || 'action directe du chef hors de la liste des actions exécutées par le code').replace(/\s+/g, ' ').trim().slice(0, 300);
          out.push({ ...base, route: false, chefHandoff: true, raison, classifier: c.classifier });
        } else {
          const q = `Tâche ${n} (${t.projet}) : c’est une action du chef (« ${c.chef} »), qui n’est confiée à aucun musicien, mais elle ne peut pas être faite automatiquement (${why}). Que faut-il faire ?`;
          questions.push(q);
          out.push({ ...base, route: false, chefAction: c.chef, refused: why, question: q, classifier: c.classifier });
        }
      } else if (c.failed) {
        const q = `Tâche ${n} (${t.projet}) : le classement par le model a échoué (${c.why}). Quel pipeline voulez-vous pour : « ${String(t.demande).slice(0, 200)} » ?`;
        questions.push(q);
        out.push({ ...base, route: false, failed: true, why: c.why, question: q });
      } else if (c.question) {
        questions.push(`Tâche ${n} (${t.projet}) : ${c.question}`);
        out.push({ ...base, route: false, question: c.question, raison: c.raison || null, classifier: c.classifier });
      } else if (c.lacune) {
        const g = await emitRoutingGap(logsDir, projectName, t.demande, c.lacune, { task: n, projet: t.projet });
        writeEvent?.({ type: 'system', subtype: 'pipeline_gap', pipeline: { run }, gap: g?.key || null, task: n,
          text: `⚑ lacune signalée pour la tâche ${n} (${t.projet}) seulement : ${String(c.lacune).slice(0, 200)}` });
        out.push({ ...base, route: false, lacune: c.lacune, gap: g?.key || null, classifier: c.classifier });
      } else {
        out.push({ ...base, route: true, pipeline: c.pipeline, mode: c.mode, kind: c.kind || null, raison: c.raison || null, classifier: c.classifier });
      }
    }
    // A task waiting (« apres ») for a task that is not launched cannot start.
    for (const t of out) {
      const dep = t.apres ? out[t.apres - 1] : null;
      if (t.route && dep && !dep.route) {
        t.route = false;
        t.blocked = dep.n;
        questions.push(`Tâche ${t.n} (${t.projet}) : elle devait suivre la tâche ${dep.n}, qui n’est pas lancée — la lancer quand même, ou attendre votre réponse sur la tâche ${dep.n} ?`);
      }
    }
    state.tasks = out;
    state.extraActions = extraActions;
    fs.writeFileSync(path.join(artDir, 'classement.json'), JSON.stringify({ taches: out, questions, ...(extraActions.length ? { actions: extraActions } : {}) }, null, 2));
    return { ok: true, model: [...models].join(', ') || null };
  },
  /** Les models viennent de la page Models : le code les relève, tâche par tâche. */
  async affecter({ root, ctx, state, artDir }) {
    // Runs paused before 0.69.0 have no per-task classification: the old
    // Decomposer output (with a pipeline per task) is used as it was.
    if (!Array.isArray(state.tasks)) {
      const j = parseJsonArtefact(readArtefact(ctx, 'taches.json') || '') || {};
      const why = validateTasks(root, j.taches);
      if (why) return { ok: false, why };
      state.tasks = j.taches.map((t, i) => ({ ...t, n: i + 1, route: true }));
    }
    const enf = readEnforcement(root);
    const assignments = readAssignments(root);
    const rows = [];
    state.tasks = state.tasks.map((t) => {
      if (!t.route) {
        rows.push(`| ${t.projet} | non lancée — ${t.chefHandoff ? `renvoyée au chef, qui agit lui-même après ce tour : ${t.raison || ''}` : t.chefAction && !t.refused ? `action du chef « ${t.chefAction} », exécutée par le code` : t.lacune ? `lacune : ${t.lacune}` : t.blocked ? `attend la tâche ${t.blocked}, non lancée` : `question : ${t.question || t.why || '?'}`} | — |`);
        return t;
      }
      const served = !!t.pipeline && isEnforced(enf, t.projet) && enf.pipelines.includes(t.pipeline);
      const steps = served ? planSteps(t.pipeline, { mode: t.mode || 'leger' }).filter(s => s.chain?.length && s.kind !== 'code').map(s => ({ id: s.id, ...resolveCase(assignments, s.chain) })) : [];
      rows.push(`| ${t.projet} | ${t.horsPipeline ? `hors pipeline, autorisé par l’utilisateur (« ${t.autorisation || '?'} ») : ${t.horsPipeline}` : served ? `${pipelineLabel(t.pipeline, t.mode)}` : t.reprise ? `reprise de ${t.reprise}` : `${t.pipeline} — projet hors service : tour ordinaire`}${t.sessionNeuve ? ' — session neuve' : ''} | ${steps.map(s => `${s.id}: ${s.model || 'défaut du projet'}`).join(', ') || '—'} |`);
      return { ...t, served };
    });
    fs.writeFileSync(path.join(artDir, 'affectation.md'), `# Affectation (page Models)\n\n| projet | pipeline | models par étape |\n|---|---|---|\n${rows.join('\n')}\n`);
    return { ok: true };
  },
  /** Chaque tâche part par dispatch.mjs (file si le musicien est occupé), avec retour au chef. */
  async dispatcher({ root, logsDir, ctx, state, artDir, dispatchScript, run, writeEvent }) {
    if (process.env.DISPATCH_REPORT_ONLY === '1') return { ok: false, why: 'réveil en rapport seul : aucun dispatch permis (chaîne de réveils au maximum)' };
    const done = [], waiting = [];
    // Only the explicit « reprise » field resumes a paused run (phase 0 c, user
    // decision 4): a run id cited in the demand is a reference, never a resume.
    const tasks = (state.tasks || []).map(t => ({ ...t, reprise: detectReprise(logsDir, t) }));
    tasks.forEach((t, i) => {
      // Not launched (question, gap, failed classification): said in the report.
      // A chef action or a task marked « ne pas dispatcher » never reaches a
      // musician, whatever the classification said (0.71.0, n° 8).
      if (t.route === false || t.ne_pas_dispatcher || t.chefAction || t.noDispatch) return;
      // « puis » : une tâche qui attend la fin d'une autre part quand ce résultat
      // arrive (libération mécanique en fin de tour, 0.58.0), jamais avant.
      if (t.apres) { waiting.push({ ...t, n: i + 1, after: tasks[t.apres - 1].projet }); return; }
      done.push({ n: i + 1, ...launchTask(root, t, dispatchScript) });
    });
    let duplicates = [], queued = [];
    if (waiting.length) {
      const entries = waiting.map(w => {
        const depTask = tasks[w.apres - 1];
        const dep = done.find(d => d.n === w.apres);
        // Anchor: the awaited log position when the awaited task was launched
        // (or now, if it is itself still waiting) plus the fingerprint of its
        // WHOLE text (0.67.x: a shared opening sentence no longer matches).
        // `n` + `run` identify this Routage task (deduplication, 0.68.0).
        return { run, n: w.n, projet: w.projet, ...(w.titre ? { titre: w.titre } : {}), pipeline: w.pipeline, mode: w.mode || null, ...(w.kind ? { kind: w.kind } : {}), ...(w.horsPipeline ? { horsPipeline: w.horsPipeline } : {}), served: w.served, demande: w.demande, rattache: w.rattache || null,
          ...(w.reprise ? { reprise: w.reprise } : {}), ...(w.sessionNeuve === true ? { sessionNeuve: true } : {}), ...(w.memeTache === true ? { memeTache: true } : {}),
          after: { projet: w.after, offset: dep ? dep.offset : logOffset(logsDir, w.after), key: taskKey(depTask.demande), hash: textHash(depTask.demande), since: dep?.at || new Date().toISOString() } };
      });
      // Requests registry (Routage v3 phase 2, the known limit of phase 1): each
      // waiter is a task of the chef turn's request from now on, launched later
      // under its own --task-id by the release.
      const rid = /^r-\d{8}T\d{6}-[0-9a-f]{6}$/.test(process.env.ORCH_REQUEST_ID || '') ? process.env.ORCH_REQUEST_ID : null;
      let Req = null;
      if (rid) { try { Req = await import('./requests.mjs'); if (!Req.readRequest(logsDir, rid)) Req = null; } catch { Req = null; } }
      if (Req) {
        const conductor = readConfig(root).conductor || 'chef';
        for (const e of entries) {
          try {
            const t = Req.addTask(logsDir, rid, { projet: e.projet, demande: e.demande, titre: e.titre || null, state: 'en_attente_de', waitsFor: { projet: e.after.projet },
              launch: { callback: conductor, source: conductor, pipeline: e.served ? e.pipeline : null, pipelineMode: e.mode || null, horsPipeline: e.horsPipeline || null, newSession: e.sessionNeuve === true, ...(e.reprise ? { reprise: e.reprise } : {}) } });
            Object.assign(e, { request: rid, taskId: t.id });
          } catch { /* the registry never blocks the Routage */ }
        }
      }
      const res = addPending(logsDir, entries);
      queued = res.added;
      duplicates = res.duplicates;
      if (Req) for (const d of duplicates) {
        const e = entries.find(x => x.run === d.run && x.n === d.n);
        if (e?.taskId) { try { const c = Req.cmdCancel({ logsDir, id: e.taskId, by: 'code' }); void c; } catch {} }
      }
    }
    // The chef's own actions (0.70.0): run by the code, never sent to a musician.
    const tj = parseJsonArtefact(readArtefact(ctx, 'taches.json') || '') || {};
    let actions = [];
    const allActions = [...(Array.isArray(tj.actions) ? tj.actions : []), ...(state.extraActions || [])];
    if (allActions.length) {
      const why = validateChefActions(root, allActions);
      if (why) return { ok: false, why };
      actions = runChefActions({ actions: allActions, scriptsDir: path.dirname(dispatchScript), logsDir, waitPid: process.pid });
      for (const a of actions) {
        writeEvent?.({ type: 'system', subtype: 'chef_action', pipeline: { run }, action: a.action, projet: a.projet || null, status: a.status,
          text: `⚙ action du chef ${a.action}${a.projet ? ` (${a.projet})` : ''} : ${{ done: 'faite', scheduled: 'programmée après la fin de ce tour', failed: `échec (code ${a.code})`, refused: `refusée — ${a.why}` }[a.status] || a.status}` });
      }
    }
    // Tasks handed back to the chef (0.88.0): ONE chef turn, after this one.
    const handTasks = tasks.filter(t => t.chefHandoff);
    let handoff = null;
    if (handTasks.length) {
      handoff = launchHandoff({ root, logsDir, scriptsDir: path.dirname(dispatchScript), run, tasks: handTasks, waitPid: process.pid });
      writeEvent?.({ type: 'system', subtype: 'chef_handoff', pipeline: { run }, ref: handoff.ref, status: handoff.status, tasks: handTasks.map(t => ({ n: t.n, titre: t.titre, projet: t.projet })),
        text: `↩ renvoyé au chef (il agit lui-même, après ce tour) : ${handTasks.map(t => `tâche ${t.n} « ${t.titre} »`).join(', ')} — ${handoff.status === 'scheduled' ? 'tour du chef programmé' : `non lancé (${handoff.why || '?'})`}` });
    }
    // « waiting » = what is REALLY queued (it was computed before addPending, so
    // a task dropped as a duplicate still showed as waiting); duplicates apart.
    fs.writeFileSync(path.join(artDir, 'dispatch.json'), JSON.stringify({ dispatched: done,
      waiting: queued.map(q => ({ id: q.id, titre: pendingLabel(q).titre, n: q.n, projet: q.projet, apres: waiting.find(w => w.n === q.n)?.apres ?? null, after: q.after?.projet || null, ...(q.reprise ? { reprise: q.reprise } : {}) })),
      ...(duplicates.length ? { duplicates } : {}),
      ...(actions.length ? { actions } : {}),
      ...(handoff ? { handoff: { ...handoff, tasks: handTasks.map(t => ({ n: t.n, titre: t.titre, projet: t.projet, raison: t.raison })) } } : {}),
      ...(tj.aucun_dispatch && !done.length && !waiting.length ? { aucun_dispatch: String(tj.aucun_dispatch).slice(0, 500) } : {}) }, null, 2));
    // A duplicate is never dropped silently (user rule): the chef is told at once.
    if (duplicates.length) {
      await postNotify(root, conductorOf(root), `[ROUTAGE ${run}] ${duplicates.length} tâche(s) écartée(s) comme doublon d’une tâche déjà en attente — rien n’est perdu, voici lesquelles et pourquoi :\n${duplicatesText(duplicates)}`, 'routage-duplicate');
    }
    const lost = done.filter(d => !d.pid);
    if (handoff && handoff.status === 'failed') lost.push({ projet: `chef (renvoi : ${handoff.why || 'lancement impossible'})` });
    return lost.length ? { ok: false, why: `lancement impossible pour : ${lost.map(d => d.projet).join(', ')}` } : { ok: true };
  },
  /** Réveil : lance les tâches dont la tâche attendue a rendu son résultat depuis. */
  async relancer({ root, logsDir, artDir, dispatchScript }) {
    // Same mechanical release as the end of every turn (routage-pending.mjs);
    // usually already done by then — this is the safety net of the wake-up.
    const r = process.env.DISPATCH_REPORT_ONLY === '1'
      ? { launched: [], blocked: [], still: readPending(logsDir) }
      : releaseReady({ root, logsDir, dispatchScript });
    fs.writeFileSync(path.join(artDir, 'relance.json'), JSON.stringify({ launched: r.launched, waiting: r.still.map(p => ({ ...pendingLabel(p), projet: p.projet, after: p.after?.projet })), blocked: r.blocked }, null, 2));
    return { ok: true };
  },
};

/**
 * Gap raised by the Routage. Since 0.69.0 only about ONE unit task (its own
 * text), after the message was understood and split — never the whole message.
 */
async function emitRoutingGap(logsDir, project, text, why, { task = null, projet = null } = {}) {
  const obs = await import('./pipeline-observe.mjs');
  // The gap and its proposal come from the Classifier model's reasoning only —
  // no keyword detection, no « recognised by the words … » proposal (0.66.0).
  const key = `routage:${crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`;
  const gap = {
    key, reason: 'aucun-pipeline', ...(task ? { task, projet } : {}),
    why: `Routage : ${task ? `la tâche ${task}${projet ? ` (${projet})` : ''} ne correspond à aucun pipeline` : 'aucune question ouverte ni aucun contexte ne rattache ce message'}${why ? ` (${String(why).slice(0, 200)})` : ''}`,
    proposal: { kind: 'pipeline', text: why ? `proposition du model de classement : ${String(why).slice(0, 300)}` : 'ajouter un pipeline ou une étape qui couvre ce besoin (à décrire dans la page Models)' },
  };
  try { obs.createObserver({ logsDir }).record({ entry: 'signalement', project, text, caller: 'routage', gap }); } catch { /* jamais bloquant */ }
  return gap;
}

// Pending Routage tasks live in routage-pending.mjs (0.58.0).
function tailText(file, max) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, max);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}
/**
 * Contexte utile au Routage (0.57.0) : ce que le chef a dit et demandé en
 * dernier, les questions en attente des musiciens, les demandes qu'il a mises
 * en attente. Sans lui, une réponse courte (« passe à la suite ») n'a pas de sens.
 */
export function routingContext(root, { logsDir, chefLog, chefDir }) {
  const L = ['# Contexte du message (fourni par l’orchestrateur)', ''];
  // 1. Dernière réponse du chef et questions qu'il a posées.
  const replies = [];
  for (const l of tailText(chefLog, 4 * 1024 * 1024).split('\n')) {
    if (!l.includes('"assistant"')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'assistant') continue;
    const txt = (e.message?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();
    if (txt) replies.push(txt);
  }
  const last = replies[replies.length - 1] || '';
  L.push('## Ta dernière réponse', '', last ? clipText(last, 6000, { where: chefLog }).text : '(aucune)', '');
  const asked = [];
  for (const r of replies.slice(-3)) {
    for (const line of r.split(/\r?\n/)) {
      const t = line.replace(/^[\s>*-]*(\d+[.)]\s*)?/, '').trim();
      if (/^NEEDS_USER_INPUT:/.test(t) || (/\?\s*$/.test(t) && t.length > 12)) asked.push(t.replace(/^NEEDS_USER_INPUT:\s*/, ''));
    }
  }
  L.push('## Questions que tu as posées (les plus récentes)', '', asked.length ? [...new Set(asked)].slice(-12).map(q => `- ${clipText(q, 600, { where: chefLog }).text}`).join('\n') : '(aucune)', '');
  // 2. Questions en attente des musiciens (dernier tour fini sur NEEDS_USER_INPUT, non acquitté).
  const waiting = [];
  const cfg = readConfig(root);
  for (const p of cfg.projects || []) {
    if (p.name === (cfg.conductor || 'chef')) continue;
    let lastQ = null;
    for (const l of tailText(path.join(logsDir, `${p.name}.jsonl`), 256 * 1024).split('\n')) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.type === 'user_prompt' || (e.type === 'notification' && e.subtype === 'question_resolved')) lastQ = null;
      else if (e.type === 'result' && typeof e.result === 'string') {
        const m = /^NEEDS_USER_INPUT:\s*(.+)$/m.exec(e.result);
        lastQ = m ? m[1].trim() : null;
      }
    }
    if (lastQ) waiting.push(`- **${p.name}** : ${clipText(lastQ, 600, { where: path.join(logsDir, `${p.name}.jsonl`) }).text}`);
  }
  L.push('## Questions en attente des musiciens', '', waiting.join('\n') || '(aucune)', '');
  // 3. Demandes mises en attente par le chef (TODO_LIST.md, entrées « EN ATTENTE »).
  const parked = [];
  try {
    const lines = fs.readFileSync(path.join(chefDir, 'TODO_LIST.md'), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/EN ATTENTE/i.test(line)) return;
      const next = lines[i + 1] && !/^\s*([-*#]|$)/.test(lines[i + 1]) ? lines[i + 1].trim() : '';
      parked.push(`${line.replace(/^[\s*-]+/, '').trim()}${next ? ` ${next}` : ''}`);
    });
  } catch { /* pas de TODO_LIST */ }
  L.push('## Demandes mises en attente (TODO_LIST du chef)', '', parked.length ? parked.slice(0, 20).map(x => `- ${clipText(x, 600, { where: path.join(chefDir, 'TODO_LIST.md') }).text}`).join('\n') +
    (parked.length > 20 ? `\n⚠ [${parked.length - 20} autre(s) non repris ici — voir ${path.join(chefDir, 'TODO_LIST.md')}]` : '') : '(aucune)', '');
  // 4. Tâches de Routage qui attendent la fin d'une autre.
  const pend = readPending(logsDir);
  // 0.91.0 (task 3/4): entries sharing their start show what sets them apart
  // and their « rattache », never only the common start.
  const distinct = distinctExcerpts(pend);
  if (pend.length) L.push('## Tâches déjà décidées, en attente d’une autre', '', pend.map(p => {
    const d = distinct.get(pendingLabel(p).id);
    const what = d ? `ce qui la distingue : ${d.excerpt} (même début sur ${d.commonLength} caractères que ${d.commonWith.join(', ')})` : clipText(String(p.demande).replace(/\s+/g, ' ').trim(), 300, { where: `node scripts/routage-pending.mjs list --json (${pendingLabel(p).id})` }).text;
    const r = cleanTitle(p.rattache);
    return `- ${pendingLabel(p).text} — ${p.projet} (après ${p.after?.projet || '?'})${p.reprise ? ` — reprise ${p.reprise}` : ''} : ${what}${r ? `\n  rattachée à : ${r.slice(0, 300)}` : ''}`;
  }).join('\n'), '');
  // 5. Paused pipeline runs (0.58.0): resuming one is a task with « reprise ».
  const paused = pausedRuns(logsDir);
  L.push('## Exécutions de pipeline en pause (pour les reprendre : tâche avec « reprise »: "<identifiant>")', '',
    paused.length ? paused.map(p => `- ${p.project} : ${p.run} (${p.pipeline}${p.mode ? ` ${p.mode}` : ''}, en pause : ${p.pausedLimit || 'question'}) — ${clipText(String(p.request || '').replace(/\s+/g, ' '), 240, { where: path.join(logsDir, 'runs', p.run, 'run.json') }).text}`).join('\n') : '(aucune)', '');
  return L.join('\n');
}

/** Paused runs, most recent first (logs/runs/<run>/run.json). */
export function pausedRuns(logsDir, { max = 20 } = {}) {
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(logsDir, 'runs')).filter(d => /^p-\d{8}T\d{6}-[0-9a-f]{6}$/.test(d)).sort().reverse(); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    const st = readJson(path.join(logsDir, 'runs', d, 'run.json'));
    if (st?.status === 'paused') out.push({ run: d, project: st.project, pipeline: st.pipeline, mode: st.mode || null, pausedLimit: st.pausedLimit || null, request: st.request || '' });
    if (out.length >= max) break;
  }
  return out;
}

/** Is the process `pid` alive? (EPERM: alive, owned by someone else.) */
export function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * A run left « running » whose recorded process is dead (turn killed by
 * kill-stalled.mjs, crash) is orphaned (0.114.0): it becomes a pause with a
 * clear question, so « continuer » / --pipeline-resume restarts it at the step
 * where it stopped — before, it stayed « running » forever and every resume was
 * refused. Nothing is launched and nothing in the project is touched. Returns
 * the paused state, or null when the run is not orphaned.
 */
export function reclaimOrphanedRun(logsDir, run, { alive = pidAlive, why = null } = {}) {
  if (!RUN_RE.test(String(run || ''))) return null;
  const f = path.join(logsDir, 'runs', run, 'run.json');
  const state = readJson(f);
  if (!state || state.status !== 'running' || alive(state.pid)) return null;
  const at = new Date().toISOString();
  const stepId = (state.plan || [])[state.index] || null;
  const lastDone = [...(state.steps || [])].reverse()[0] || null;
  const where = stepId ? `à l’étape « ${plainStep(stepId)} »` : 'avant sa fin';
  const cause = why || `son processus (${state.pid ?? 'inconnu'}) n’existe plus — tour arrêté (kill-stalled) ou arrêt brutal`;
  state.status = 'paused';
  state.pausedLimit = 'orphaned';
  state.orphaned = { pid: state.pid ?? null, at, index: state.index ?? null, step: stepId, lastStep: lastDone?.key || null, why: cause };
  // Smart pause (0.122.0): an interruption is a transient cause, stated.
  const d = diagnosePause({ limit: 'orphaned', why: cause });
  const menu = fixMenu(d, smartMenu(d, { delivered: (state.delivered || []).length }));
  state.diagnosis = { at, limit: 'orphaned', step: stepId, kind: d.kind, transient: d.transient, cause: d.cause, source: d.source, evidence: d.evidence, options: menu.options, recommend: menu.recommend };
  state.question = `${state.project} : l’exécution ${run} (${pipelineLabel(state.pipeline, state.mode)}) s’est arrêtée ${where} sans finir : ${cause}. `
    + `Répondez « continuer » pour la reprendre là où elle s’est arrêtée (je recommande), ou « abandonner » pour la clore (ce qui est déjà livré reste livré).`;
  state.endedAt = at;
  state.updatedAt = at;
  writeFileAtomic(f, JSON.stringify(state, null, 2));
  // Traced in the musician's log, without a result: a result would wake the
  // pump (queue drain, chef notification) — only the next real turn does that.
  try {
    fs.appendFileSync(path.join(logsDir, `${state.project}.jsonl`), JSON.stringify({ type: 'system', subtype: 'pipeline_orphaned',
      pipeline: { run, pipeline: state.pipeline, mode: state.mode, status: 'paused', step: stepId }, orphaned: state.orphaned,
      text: `⏸ exécution ${run} orpheline (${cause}) : mise en pause ${where}, reprise par « continuer »`, timestamp: at }) + '\n');
  } catch { /* the run.json is the source of truth */ }
  return state;
}

/** Every orphaned run of `projectName` becomes a pause (see reclaimOrphanedRun). */
export function reclaimOrphanedRuns(logsDir, projectName, opts = {}) {
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(logsDir, 'runs')).filter(d => RUN_RE.test(d)); } catch { return []; }
  const out = [];
  for (const r of dirs) {
    const s = readJson(path.join(logsDir, 'runs', r, 'run.json'));
    if (!s || s.project !== projectName || s.status !== 'running' || r === opts.except) continue;
    if (reclaimOrphanedRun(logsDir, r, opts)) out.push(r);
  }
  return out;
}

/**
 * Meeting pipeline (reunion, 0.110.0): the artefacts read back for every step,
 * from disk. Later steps read them without existence checks (files moved or
 * deleted since). → { inv, sorting, definitive, deleted, demande } | { why }
 */
export function meetingContext(ctx) {
  const { cwd } = ctx;
  const inv = Meeting.checkInventory(cwd, readArtefact(ctx, 'inventaire.json'), { exists: false });
  if (!inv.ok) return { why: inv.why };
  const so = Meeting.checkSorting(cwd, inv.value, readArtefact(ctx, 'suppression.json'), { exists: false });
  const defArt = readArtefact(ctx, 'definitif.json') || '';
  const defJson = Meeting.parseJson(defArt);
  const definitive = defJson && Meeting.safeRel(cwd, defJson.fichier) && !new RegExp(`\\b${Meeting.NO_DEFINITIVE}\\b`).test(defArt) ? { fichier: Meeting.safeRel(cwd, defJson.fichier) } : null;
  const done = Meeting.parseJson(readArtefact(ctx, 'suppression-faite.json') || '') || {};
  return { inv: inv.value, sorting: so.ok ? so.value : null, sortingWhy: so.ok ? null : so.why, definitive,
    deleted: (done.supprimes || []).map(d => d.chemin), demande: readArtefact(ctx, 'demande.md') || '' };
}

function meetingCheck(ctx, kind, art, changed) {
  const { cwd } = ctx;
  if (kind === 'inventaire') return Meeting.checkInventory(cwd, art);
  const m = meetingContext(ctx);
  if (m.why) return { ok: false, why: m.why };
  if (kind === 'tri') return Meeting.checkSorting(cwd, m.inv, art);
  if (!m.sorting) return { ok: false, why: m.sortingWhy };
  if (kind === 'definitif') return Meeting.checkDefinitive(cwd, { art, demande: m.demande, sorting: m.sorting, changed });
  if (kind === 'rangement') return Meeting.checkFiling(cwd, { art, inv: m.inv, sorting: m.sorting, definitive: m.definitive, demande: m.demande, deleted: m.deleted, changed });
  return { ok: false, why: `contrôle de réunion inconnu « ${kind} »` };
}

/** Critères génériques d'une étape du catalogue. */
function checkCatalogCriteria(ctx, step, before, after) {
  ctx.lastCheck = null;
  ctx.docResult = null;
  const { cwd } = ctx;
  const c = step.checks || {};
  const changed = changedFiles(before, after);
  const art = readArtefact(ctx, step.artefact);
  // Un JSON court (« {"remaining":[]} ») est une vraie réponse : il est jugé sur sa forme.
  // 0.110.0: so is the « nothing to do » marker alone, exactly as the prompt
  // asks (« RIEN_A_NETTOYER » is 15 characters: refused before, run
  // p-20261016T132118-ddfd3b of 2026-10-16).
  const markers = [c.nothing, c.media?.optionalWith, c.meeting ? Meeting.NO_DEFINITIVE : null].filter(Boolean);
  const markerOnly = art != null && markers.some(m => new RegExp(`\\b${m}\\b`).test(art));
  const artOk = art != null && (c.json || c.meeting ? art.trim().length > 1 : art.trim().length >= 20 || markerOnly);
  const fail = (why, extra = {}) => ({ ok: false, why, changed, ...extra });
  let external = null;
  if (step.kind === 'deliver') {
    const head = git(cwd, ['rev-parse', 'HEAD']).out;
    if (!head || head === ctx.base) return fail('aucun commit créé');
    const dirty = git(cwd, ['status', '--porcelain']).out.split('\n').filter(l => l && !isLocalOnly(l.slice(3)));
    if (dirty.length) return fail(`arbre non propre après le commit : ${dirty.slice(0, 6).join(' ; ')}`);
    const leaked = git(cwd, ['diff', '--name-only', `${ctx.base}..HEAD`]).out.split(/\r?\n/).filter(f => f && isLocalOnly(f));
    if (leaked.length) return fail(`fichiers locaux commités (jamais livrés) : ${leaked.slice(0, 6).join(', ')}`);
    return { ok: true, changed, commit: head };
  }
  if (!artOk) return fail(`artefact ${step.artefact} absent ou vide`);
  if (step.kind === 'judge') {
    // Folder outside git (the chef's, 0.71.1, ROUTAGE-PROBLEMES n° 18): a change
    // seen during the step may come from someone else (the user, a musician
    // writing a document). It is reported, never blamed on the step nor undone.
    external = changed.length && isWalkSnapshot(before) ? changed : null;
    if (changed.length && !external) return fail(`étape en lecture seule, mais des fichiers du projet ont changé : ${changed.slice(0, 8).join(', ')}`);
    if (c.headUnchanged && git(cwd, ['rev-parse', 'HEAD']).out !== ctx.headAtStep) return fail('l’historique git a été modifié : interdit à cette étape (rapport seulement)');
    if (c.meeting) { const m = meetingCheck(ctx, c.meeting, art, changed); if (!m.ok) return fail(m.why); }
  } else {
    // Meeting steps (0.110.0): their own criteria; a step that finds everything
    // already in place (definitive text already written, files already filed) is valid.
    let meetingOk = false;
    if (c.meeting) { const m = meetingCheck(ctx, c.meeting, art, changed); if (!m.ok) return fail(m.why); meetingOk = true; }
    // Generics (phase 1): an acquisition is judged on the files on the disk (often
    // gitignored, so absent from the snapshot); a document on its copy before the step.
    if (c.files === 'acquisition') {
      const pl = Files.checkFilesPlan(cwd, readArtefact(ctx, 'fichiers.json'), { demande: readArtefact(ctx, 'demande.md') || '', exists: false });
      if (!pl.ok) return fail(pl.why);
      const a = Files.checkAcquisition(cwd, pl.value, { changed: changed.filter(f => !isLocalOnly(f)) });
      if (!a.ok) return fail(a.why);
      meetingOk = true;
    }
    if (c.document === 'modification') {
      const v = Doc.checkTarget(cwd, readArtefact(ctx, 'cible.json'), { demande: readArtefact(ctx, 'demande.md') || '' });
      if (!v.ok) return fail(v.why);
      const base = readDocBase(ctx);
      const sinceBase = changedFiles(base.snapshot, after).filter(f => !isLocalOnly(f));
      const d = Doc.checkDocumentChange(cwd, v.value, { backups: base.backups, changed: sinceBase, added: sinceBase.filter(f => !base.snapshot.has(f) && after.has(f)), art });
      if (!d.ok) return fail(d.why);
      ctx.docResult = d;
      meetingOk = true;
    }
    // Médias (0.55.0) : chaque fichier annoncé est ouvert et vérifié par le code.
    let media = null, waived = false, wer = null;
    if (c.media) {
      const kind = step.mediaKind || c.media.kind;
      waived = !!(c.media.optionalWith && new RegExp(`\\b${c.media.optionalWith}\\b`).test(art));
      if (!waived) {
        const m = checkMediaFiles(listedFiles(art), { kind, min: c.media.min || 1, roots: [cwd, ctx.artDir] });
        if (!m.ok) return fail(m.why);
        media = m.files;
        // Transcription : taux d'erreur mesuré si une référence a été fournie.
        // Référence : reference.txt du dossier d'exécution, sinon `werReference` du pipeline.json du projet.
        const ref = [path.join(ctx.artDir, 'reference.txt'), ctx.cfg.werReference ? path.join(cwd, String(ctx.cfg.werReference)) : null].find(f => f && fs.existsSync(f)) || '';
        if (c.wer && kind === 'text' && ref) {
          const hypFile = media[0].path;
          const hyp = fs.readFileSync(path.isAbsolute(hypFile) ? hypFile : path.join(cwd, hypFile), 'utf8');
          wer = wordErrorRate(fs.readFileSync(ref, 'utf8'), hyp);
          const max = Number(ctx.cfg.werMax) || 0.35;
          if (wer > max) return fail(`transcription trop éloignée de la référence : taux d'erreur ${(wer * 100).toFixed(1)} % (maximum ${(max * 100).toFixed(0)} %)`);
        }
      }
      ctx.lastCheck = { media, waived, wer };
    }
    const nothing = c.nothing && new RegExp(`\\b${c.nothing}\\b`).test(art);
    if (nothing && changed.length && !c.onlyGlobs) return fail(`« ${c.nothing} » annoncé, mais des fichiers ont changé : ${changed.slice(0, 8).join(', ')}`);
    // 0.65.0: corrections listed by a previous step cannot be skipped with the
    // « nothing to do » marker — unless the text lives in the artefact only.
    if (nothing && c.applies) {
      const j = parseJsonArtefact(readArtefact(ctx, c.applies.artefact) || '') || {};
      const todo = Array.isArray(j[c.applies.field]) ? j[c.applies.field].filter(Boolean) : [];
      const inArtefactOnly = c.applies.unlessMarker && new RegExp(`\\b${c.applies.unlessMarker}\\b`).test(readArtefact(ctx, c.applies.markerIn) || '');
      if (todo.length && !inArtefactOnly) return fail(`« ${c.nothing} » annoncé, mais ${c.applies.artefact} liste ${todo.length} correction(s) à appliquer : ${todo.slice(0, 5).map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ; ')}`);
    }
    // 0.114.3: a step whose deliverable is the artefact itself (artefactIsWork) is
    // judged on the artefact, never refused for leaving the project untouched; the
    // hint names everything the next check will demand (marker AND sections).
    if (!changed.length && !nothing && !media && !waived && !meetingOk && !c.artefactIsWork) return fail(c.nothing ? `aucune modification — s'il n'y a rien à faire, ${nothingHint(c)}` : 'aucune modification');
    if (c.onlyGlobs) {
      const bad = changed.filter(f => !isTestFile(f, c.onlyGlobs));
      if (bad.length) return fail(`seuls des documents peuvent changer à cette étape ; modifiés : ${bad.slice(0, 8).join(', ')}`);
    }
    if (c.protectTests && ctx.testPrint) {
      const touched = [...ctx.testPrint.keys()].filter(f => after.get(f) !== ctx.testPrint.get(f));
      if (touched.length) return fail(`fichiers de test modifiés (interdit à cette étape) : ${touched.slice(0, 8).join(', ')}`);
    }
    for (const f of c.requireFiles || []) if (!fs.existsSync(path.join(cwd, f))) return fail(`fichier requis absent : ${f}`);
    if (c.reloadConfig) ctx.cfg = readJson(path.join(cwd, '.orchestrateur', 'pipeline.json')) || ctx.cfg;
    if (c.needTestCommand && !ctx.cfg.testCommand) return fail('.orchestrateur/pipeline.json sans testCommand');
    // Suite déjà rouge au départ (incident) : seule la correction doit la rendre
    // verte ; les étapes d'avant ne peuvent pas être jugées sur elle.
    if (ctx.cfg.testCommand && changed.length && !ctx.suiteRedAtStart) {
      for (let i = 0; i < (c.suiteTwice ? 2 : 1); i++) {
        const t = runCommand(cwd, ctx.cfg.testCommand, ctx.testEnv, testTimeoutMs(ctx.cfg));
        if (!t.ok) return fail(`la suite échoue${c.suiteTwice ? ` (passage ${i + 1}/2)` : ''} (${ctx.cfg.testCommand}, code ${t.code}) :\n${t.out.slice(-1500)}`, { test: t });
      }
    }
  }
  // Recherche « interne »: the web is not a source here (checked on the turn's own log, first).
  if (c.noWeb) {
    const web = toolUsesInTurn(ctx.stepLogFile || '').filter(u => WEB_TOOLS.test(u.name));
    if (web.length) return fail(`recherche interne : le web a été utilisé (${[...new Set(web.map(u => u.name))].join(', ')}), interdit dans ce mode — sources : le dépôt et les journaux`);
  }
  // Discussion in one call: an answer that asks for the research step first is not judged on its sections.
  const asksResearch = c.researchMark && new RegExp(`^\\s*${c.researchMark}\\s*:`, 'm').test(art);
  if (c.sections?.length && !asksResearch) {
    const miss = missingSections(art, c.sections);
    if (miss.length) return fail(`${step.artefact} : sections manquantes « ${miss.map(s => `## ${s}`).join(' », « ')} »`);
  }
  if (c.minSources && countSources(art, c.sourcesFiles ? { files: true, urls: false } : { files: step.kind !== 'judge' }) < c.minSources) {
    return fail(c.sourcesFiles ? `${step.artefact} : au moins ${c.minSources} source(s) distincte(s) du projet, chacune citée entre accents graves (${countSources(art, { files: true, urls: false })} trouvée(s))` : `${step.artefact} : au moins ${c.minSources} source(s) distincte(s) avec URL attendue(s) (${countSources(art)} trouvée(s))`);
  }
  if (c.citedPaths) {
    const { missing, reported } = citedPathsCheck(ctx, art);
    if (missing.length) return fail(`chemins cités inexistants : ${missing.slice(0, 6).join(', ')}`);
    if (reported.length) ctx.citedReported = reported;
  }
  let json = null;
  if (c.json) {
    json = parseJsonArtefact(art);
    if (!json || typeof json !== 'object') return fail(`${step.artefact} n’est pas un JSON valide`);
    for (const [k, type] of Object.entries(c.json)) {
      if (type === 'array' && !Array.isArray(json[k])) return fail(`${step.artefact} : champ « ${k} » (liste) absent`);
      if (type === 'string' && typeof json[k] !== 'string') return fail(`${step.artefact} : champ « ${k} » (texte) absent`);
    }
    for (const [k, allowed] of Object.entries(c.jsonEnum || {})) {
      if (!allowed.includes(json[k])) return fail(`${step.artefact} : « ${k} » doit valoir ${allowed.map(a => `« ${a} »`).join(' ou ')} (reçu « ${json[k]} »)`);
    }
    if (json.nature === 'question' && !String(json.question || '').trim()) return fail(`${step.artefact} : « question » choisie, mais aucune question à poser`);
    // Generics (phase 1): plans checked by the code before anything runs.
    if (c.operations && !(Array.isArray(json.operations) && !json.operations.length && String(json.hors_liste || '').trim())) {
      const p = Ops.parseOperations(json);
      if (!p.ok) return fail(`${step.artefact} : ${p.why}`);
    }
    if (c.files === 'plan') { const pl = Files.checkFilesPlan(cwd, json, { demande: readArtefact(ctx, 'demande.md') || '' }); if (!pl.ok) return fail(`${step.artefact} : ${pl.why}`); }
    if (c.document === 'cible') { const v = Doc.checkTarget(cwd, json, { demande: readArtefact(ctx, 'demande.md') || '', protectedFn: (f) => isTestFile(f, ctx.cfg.testGlobs || []) }); if (!v.ok) return fail(`${step.artefact} : ${v.why}`); }
    if (c.verification) { const v = checkVerification(ctx, json); if (!v.ok) return fail(`${step.artefact} : ${v.why}`); }
    if (c.tasks) {
      const why = validateTasks(ctx.root, json.taches);
      if (why) return fail(`${step.artefact} : ${why}`);
    }
    // A message that cannot be split with certainty ends as a question to the
    // user (never guess): no task and a question is a valid answer.
    // 0.70.0: no task is also valid when the chef acts itself (« actions ») or
    // says why nothing needs dispatching (« aucun_dispatch ») — never a defect.
    if (c.unitTasks) {
      const whyActions = validateChefActions(ctx.root, json.actions);
      if (whyActions) return fail(`${step.artefact} : ${whyActions}`);
      const empty = Array.isArray(json.taches) && !json.taches.length;
      const justified = String(json.question || '').trim() || (Array.isArray(json.actions) && json.actions.length) || String(json.aucun_dispatch || '').trim().length >= 8;
      if (!(empty && justified)) {
        const why = validateUnitTasks(ctx.root, json.taches);
        if (why) return fail(`${step.artefact} : ${why === 'aucune tâche' ? 'aucune tâche, et ni « aucun_dispatch » (la raison), ni « actions » du chef, ni « question »' : why}`);
      }
    }
  }
  return { ok: true, changed, json, ...(external ? { externalChanges: external } : {}), ...(c.media ? { media: ctx.lastCheck?.media || null, wer: ctx.lastCheck?.wer ?? null } : {}) };
}

// ---------------------------------------------------------------------------
// Critères de sortie (plan §2.4)
// ---------------------------------------------------------------------------
function readArtefact(ctx, f) { try { return fs.readFileSync(path.join(ctx.artDir, f), 'utf8'); } catch { return null; } }

/**
 * Proof behind a DEJA_COUVERT claim (0.57.2): at least one commit that exists in
 * the repository, or one existing production file (optionally `file:line`, the
 * line must exist). Test files and orchestrator-local files are no proof.
 */
export function coveredProof(cwd, text, cfg) {
  const proof = [];
  const src = String(text || '');
  for (const m of new Set(src.match(/\b[0-9a-f]{7,40}\b/g) || [])) {
    if (git(cwd, ['cat-file', '-e', `${m}^{commit}`]).ok) proof.push({ kind: 'commit', ref: m });
  }
  for (const m of src.matchAll(/(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w]{0,9})(?::(\d+))?(?![\w/])/g)) {
    const rel = m[1].replace(/^\.\//, '');
    if (rel.includes('..') || isLocalOnly(rel) || isTestFile(rel, cfg?.testGlobs)) continue;
    const abs = path.join(cwd, rel);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    if (m[2]) {
      let n = 0; try { n = fs.readFileSync(abs, 'utf8').split('\n').length; } catch {}
      if (Number(m[2]) < 1 || Number(m[2]) > n) continue;
    }
    if (!proof.some(p => p.kind === 'file' && p.ref === rel)) proof.push({ kind: 'file', ref: rel, ...(m[2] ? { line: Number(m[2]) } : {}) });
  }
  return proof;
}
// Network / environment failure signatures across Node, Python, JVM and .NET.
const ENV_FAILURE_RES = [
  [/\bE(?:TIMEDOUT|CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH)\b/, 'erreur réseau'],
  [/\b(?:TimeoutError|socket\.timeout|SocketTimeoutException|ReadTimeout(?:Error)?|ConnectTimeout(?:Error)?|TaskCanceledException)\b/, 'délai dépassé'],
  [/\b(?:read operation|connection|request|operation) timed out\b/i, 'délai dépassé'],
  [/\b(?:ConnectionError|ConnectionRefusedError|ConnectionResetError|ConnectException|UnknownHostException|NoRouteToHostException|HttpRequestException|getaddrinfo|Name or service not known|Temporary failure in name resolution|Network is unreachable|No such host is known)\b/i, 'réseau indisponible'],
];

/**
 * Why a test command failed (0.57.2): `environment` when the output carries
 * network / timeout signatures (an unreachable remote service, not a broken
 * test), `tests` otherwise. Used at the "green base" precondition to report
 * the two cases apart; the base is still refused either way.
 */
export function classifyTestFailure(out) {
  const text = String(out || '');
  const signals = [];
  for (const [re, label] of ENV_FAILURE_RES) {
    const m = re.exec(text);
    if (m && !signals.some(s => s.match === m[0])) signals.push({ label, match: m[0] });
  }
  return { cause: signals.length ? 'environment' : 'tests', signals };
}

function proofText(list) {
  return (list || []).map(p => (p.kind === 'commit' ? `commit ${p.ref}` : `${p.ref}${p.line ? `:${p.line}` : ''}`)).join(', ');
}
function coveredLabel(i) {
  const proof = proofText(i.proof);
  return `${i.n ? `n° ${i.n} ` : ''}« ${i.text} »${proof ? ` (preuve : ${proof})` : ''}`;
}
const COVERED_HINT ='si le comportement existe déjà dans le code, garde ce test fidèle (il passe), écris DEJA_COUVERT en tête de rouge.md avec la preuve : le commit et/ou le fichier:ligne du code de production qui l’implémente déjà';

/**
 * Décision « c+d », partie 2 (0.62.0) : les tests réellement écrits pour un
 * item (hausse du nombre de cas de test par fichier depuis le début de l'item,
 * voir item-tests.mjs) ne dépassent pas sa déclaration « (tests: N) ».
 */
/** The item-tests criterion adjusted for this item at a pause (« ajuster le critère »). */
function itemTestsRelaxed(relaxed, item) {
  return !!item && (relaxed || []).some(r => r.criterion === 'itemTests' && r.item === item.n);
}
export function checkItemTests({ cwd, files, base, item }) {
  const added = addedTests(base || {}, countTests(cwd, files));
  return { ...itemTestsVerdict({ declared: item?.declared, added, itemN: item?.n }), added };
}

function checkCriteria(ctx, step, before, after) {
  // Catalogue (phase 6) : critères génériques, ou critère du Développement réutilisé.
  if (!step.crit && (step.checks || step.kind)) return checkCatalogCriteria(ctx, step, before, after);
  // DEJA_COUVERT belongs to the Development pipeline's own 4a, not to catalog
  // steps that reuse its criterion (an Incident reproduction must fail).
  const devRouge = !step.crit && step.id === 'rouge';
  if (step.crit) step = { ...step, id: step.crit };
  const { cwd, cfg } = ctx;
  const changed = changedFiles(before, after);
  const art = readArtefact(ctx, step.artefact);
  const need = (cond, why) => (cond ? null : why);
  const artOk = art != null && art.trim().length >= 20;
  if (step.judge) {
    const why = need(artOk, `artefact ${step.artefact} absent ou vide`) ||
      need(!changed.length, `étape en lecture seule, mais des fichiers du projet ont changé : ${changed.slice(0, 8).join(', ')}`);
    if (why) return { ok: false, why, changed };
    if (step.id === 'comprendre') {
      const { missing, reported } = citedPathsCheck(ctx, art);
      if (missing.length) return { ok: false, why: `chemins cités inexistants : ${missing.slice(0, 6).join(', ')}`, changed };
      if (reported.length) ctx.citedReported = reported;
    }
    if (step.id === 'concevoir' && (art.match(/^##\s+\S/gm) || []).length < 2) {
      return { ok: false, why: 'plan.md : il faut au moins les sections « ## Approche » et « ## Étapes »', changed };
    }
    if (step.id === 'liste-tests') {
      const items = parseItems(art);
      const open = items.filter(i => !i.done);
      if (!items.length || (!open.length && !ctx.escalated)) return { ok: false, why: 'tests.md : aucune case « - [ ] (tests: N) <comportement> »', changed };
      // Décision « c+d » (0.61.0) : chaque case annonce ses tests, au plus le plafond.
      const cap = ctx.limits?.testsPerItem || LIMITS.testsPerItem;
      const pb = declarationProblems(items, cap);
      if (!pb.ok) return { ok: false, why: declarationWhy('tests.md', pb, cap, 'case'), changed, items, declaration: pb };
      return { ok: true, changed, items };
    }
    if (step.id === 'revue') {
      let j;
      try { j = JSON.parse(art.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return { ok: false, why: 'revue.json n’est pas un JSON valide', changed }; }
      const verdict = STRIP(j?.verdict || '');
      if (!['ok', 'problemes'].includes(verdict) || !Array.isArray(j.items)) return { ok: false, why: 'revue.json : il faut {"verdict": "ok"|"problèmes", "items": [...]}', changed };
      const txt = (x) => {
        let s = String(typeof x === 'string' ? x : x?.text || JSON.stringify(x)).replace(/\s+/g, ' ').trim();
        // {"text": "…", "tests": N} est accepté : la déclaration rejoint le texte.
        if (x && typeof x === 'object' && Number.isInteger(x.tests) && declaredTests(s) == null) s = `(tests: ${x.tests}) ${s}`;
        return s.slice(0, 400);
      };
      const all = j.items.map(txt).filter(Boolean);
      // Behaviours to fix (TDD loop) on one side; non-testable findings (doc,
      // registry, CHANGELOG…) on the other. Since 0.65.0 BOTH block delivery
      // (user rule « tout problème détecté doit bloquer une livraison »): the
      // latter are fixed by a correction step before the item is delivered.
      // The split testable / non-testable is the REVIEW model's (items vs
      // hors_tdd) — no keyword re-sorting since 0.66.0.
      const delivery = Array.isArray(j.hors_tdd) ? j.hors_tdd.map(txt).filter(Boolean) : [];
      const items = all.slice(0, 15);
      // Complet : ces items deviennent des cases « (revue) » de tests.md — même
      // règle que la Liste de tests (décision « c+d », 0.61.0).
      if (ctx.mode === 'complet' && items.length) {
        const cap = ctx.limits?.testsPerItem || LIMITS.testsPerItem;
        const pb = declarationProblems(items.map((t, i) => ({ n: i + 1, done: false, declared: declaredTests(t) })), cap);
        if (!pb.ok) return { ok: false, why: declarationWhy('revue.json', pb, cap, 'entrée'), changed, declaration: pb };
      }
      const fixes = [...new Set(delivery)].slice(0, 15);
      if (verdict === 'problemes' && !items.length && !fixes.length) return { ok: false, why: 'revue.json : verdict « problèmes » sans aucun défaut listé (items ou hors_tdd)', changed };
      return { ok: true, changed, review: { verdict: items.length || fixes.length ? 'problemes' : 'ok', items, delivery: fixes } };
    }
    return { ok: true, changed };
  }
  if (step.id === 'rouge') {
    const claimed = devRouge && /\bDEJA_COUVERT\b/.test(art || '');
    if (!changed.length) {
      return claimed
        ? { ok: false, why: 'DEJA_COUVERT déclaré, mais aucun test ajouté ni modifié : les fichiers d’un essai refusé sont retirés, réécris le test fidèle (il doit passer) et garde la preuve dans rouge.md', changed, claimedCovered: true }
        : { ok: false, why: 'aucun test ajouté ni modifié', changed };
    }
    const notTests = changed.filter(f => !isTestFile(f, cfg.testGlobs));
    if (notTests.length) return { ok: false, why: `l’étape Rouge ne touche que des tests ; modifiés hors tests : ${notTests.slice(0, 8).join(', ')}`, changed };
    // Seule 4a écrit des tests (4b et 4c ne peuvent pas y toucher) : le compte
    // de l'item se vérifie ici, DEJA_COUVERT compris.
    if (devRouge && ctx.item && ctx.itemTestBase && !itemTestsRelaxed(ctx.relaxed, ctx.item)) {
      const v = checkItemTests({ cwd, files: [...after.keys()].filter(f => isTestFile(f, cfg.testGlobs)), base: ctx.itemTestBase, item: ctx.item });
      if (!v.ok) return { ok: false, why: v.why, changed, itemTests: v };
    }
    const t = runSuite(ctx);
    if (t.ok) {
      // Décision utilisateur Q10 (« A », 2026-10-09) : un comportement DÉJÀ
      // assuré par le code existant est accepté si le model le DÉCLARE
      // (DEJA_COUVERT), que seuls des tests ont changé et que toute la suite
      // passe. 0.57.2 : aussi en mode léger (sans item), et avec une preuve
      // vérifiée (commit existant, fichier[:ligne] de production existant).
      if (claimed) {
        const proof = coveredProof(cwd, art, cfg);
        if (!proof.length) return { ok: false, why: 'DEJA_COUVERT déclaré sans preuve vérifiable : cite le commit (hash) et/ou le fichier:ligne du code de production qui implémente déjà le comportement', changed, test: t, claimedCovered: true };
        return { ok: true, changed, test: t, covered: true, proof };
      }
      return { ok: false, why: `la suite passe encore : le nouveau test n’échoue pas (${cfg.testCommand})${devRouge ? ` — ${COVERED_HINT}` : ''}`, changed, test: t };
    }
    const names = changed.map(f => path.basename(f).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, ''));
    const titles = [];
    for (const f of changed) {
      let s = ''; try { s = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch {}
      for (const m of s.matchAll(/\b(?:test|it|describe)\s*\(\s*(['"`])(.{3,120}?)\1/g)) titles.push(m[2]);
    }
    const cited = [...names, ...titles].some(n => n && t.out.includes(n));
    if (!cited) return { ok: false, why: 'la suite échoue, mais l’échec ne cite pas le test ajouté (cause sans rapport ?)', changed, test: t };
    return { ok: true, changed, test: t };
  }
  if (step.id === 'vert') {
    if (!changed.length) return { ok: false, why: 'aucune modification', changed };
    const tests = ctx.testPrint;  // empreinte des tests à protéger
    const touched = [...tests.keys()].filter(f => after.get(f) !== tests.get(f));
    if (touched.length) return { ok: false, why: `fichiers de test modifiés (interdit à cette étape) : ${touched.slice(0, 8).join(', ')}`, changed };
    const t = runSuite(ctx);
    if (!t.ok) return { ok: false, why: `la suite échoue encore (${cfg.testCommand}, code ${t.code}) :\n${t.out.slice(-1500)}`, changed, test: t };
    return { ok: true, changed, test: t };
  }
  if (step.id === 'refactor') {
    const nothing = /RIEN_A_REFACTORER/.test(art || '');
    if (!art) return { ok: false, why: 'artefact refactor.md absent', changed };
    if (nothing && changed.length) return { ok: false, why: `« RIEN_A_REFACTORER » annoncé, mais des fichiers ont changé : ${changed.slice(0, 8).join(', ')}`, changed };
    const tests = ctx.testPrint;
    const touched = [...tests.keys()].filter(f => after.get(f) !== tests.get(f));
    if (touched.length) return { ok: false, why: `fichiers de test modifiés (interdit au refactor) : ${touched.slice(0, 8).join(', ')}`, changed };
    if (nothing) return { ok: true, changed, nothing: true };
    const t = runSuite(ctx);
    if (!t.ok) return { ok: false, why: `le refactor casse la suite (${cfg.testCommand}) :\n${t.out.slice(-1500)}`, changed, test: t };
    return { ok: true, changed, test: t };
  }
  if (step.id === 'livrer') {
    // Per-item delivery: the release is checked against the last delivered item.
    let relBase = ctx.releaseBase || ctx.base;
    const head = git(cwd, ['rev-parse', 'HEAD']).out;
    // Version already bumped by a delivered item of this run (0.114.1): the
    // release is checked from the run's start (or its previous release), so the
    // bump counts, and a release commit is optional — none is needed when the
    // version, CHANGELOG entry and requirement line are already committed.
    // Never relaxed when no item bumped the version.
    const prebump = ctx.releaseBase ? bumpedInRun(cwd, cfg, ctx.versionBase, ctx.releaseBase) : null;
    if (prebump) relBase = ctx.versionBase;
    if (!head || head === relBase) return { ok: false, why: 'aucun commit créé', changed };
    const dirty = git(cwd, ['status', '--porcelain']).out.split('\n').filter(l => l && !isLocalOnly(l.slice(3)));
    if (dirty.length) return { ok: false, why: `arbre non propre après le commit : ${dirty.slice(0, 6).join(' ; ')}`, changed };
    const diffNames = git(cwd, ['diff', '--name-only', `${relBase}..HEAD`]).out.split('\n').filter(Boolean);
    let version = null;
    if (ctx.lane) {
      // P9, rule changelog.d (design §2.8): in a lane the delivery carries a
      // fragment; the version and the CHANGELOG are the integrator's.
      const cl = cfg.changelog || 'CHANGELOG.md';
      for (const vf of cfg.versionFiles || []) {
        if (!diffNames.includes(vf)) continue;
        const v = readVersion(vf, git(cwd, ['show', `HEAD:${vf}`]).out), pv = readVersion(vf, git(cwd, ['show', `${relBase}:${vf}`]).out);
        if (v !== pv) return { ok: false, why: `version modifiée dans ${vf} (${pv} → ${v}) : dans un couloir, la version est attribuée à l’intégration — remets ${pv} et écris le fragment ${ctx.lane.fragment}`, changed };
      }
      if (diffNames.includes(cl)) return { ok: false, why: `${cl} modifié : dans un couloir, l’entrée est écrite à l’intégration — annule cette modification et écris le fragment ${ctx.lane.fragment}`, changed };
      if (!diffNames.includes(ctx.lane.fragment)) return { ok: false, why: `fragment ${ctx.lane.fragment} absent du commit`, changed };
      const frag = readFragments(cwd).find(f => f.file === ctx.lane.fragment);
      if (!frag || frag.invalid || frag.bumpDefaulted) return { ok: false, why: `fragment ${ctx.lane.fragment} : ${frag?.invalid || 'en-tête « ---\\nbump: patch|minor|major\\n--- » manquant'}`, changed };
      if (!frag.body) return { ok: false, why: `fragment ${ctx.lane.fragment} vide : décris la livraison (### Added, ### Fixed…)`, changed };
    }
    for (const vf of ctx.lane ? [] : cfg.versionFiles || []) {
      if (!diffNames.includes(vf)) return { ok: false, why: `version non incrémentée : ${vf} inchangé`, changed };
      let txt = ''; try { txt = fs.readFileSync(path.join(cwd, vf), 'utf8'); } catch {}
      const prev = git(cwd, ['show', `${relBase}:${vf}`]).out;
      const v = readVersion(vf, txt), pv = readVersion(vf, prev);
      if (v && pv && v === pv) return { ok: false, why: `version inchangée dans ${vf} (${v})`, changed };
      version = version || v;
    }
    const cl = cfg.changelog || 'CHANGELOG.md';
    if (!ctx.lane && (fs.existsSync(path.join(cwd, cl)) || (cfg.versionFiles || []).length)) {
      if (!diffNames.includes(cl)) return { ok: false, why: `${cl} sans nouvelle entrée`, changed };
      if (version) {
        let txt = ''; try { txt = fs.readFileSync(path.join(cwd, cl), 'utf8'); } catch {}
        if (!txt.includes(`## [${version}]`)) return { ok: false, why: `${cl} : pas d’entrée « ## [${version}] »`, changed };
      }
    }
    const leaked = diffNames.filter(f => isLocalOnly(f));
    if (leaked.length) return { ok: false, why: `fichiers locaux commités (jamais livrés) : ${leaked.slice(0, 6).join(', ')}`, changed };
    if (cfg.requirements && !diffNames.includes(cfg.requirements)) return { ok: false, why: `${cfg.requirements} : pas de ligne pour cette demande`, changed };
    const t = runSuite(ctx);
    if (!t.ok) return { ok: false, why: `la suite échoue après la livraison (${cfg.testCommand}) :\n${t.out.slice(-1500)}`, changed, test: t };
    if (cfg.buildCommand) {
      const b = runCommand(cwd, cfg.buildCommand, ctx.testEnv, testTimeoutMs(cfg));
      if (!b.ok) return { ok: false, why: `le build échoue (${cfg.buildCommand}) :\n${b.out.slice(-1500)}`, changed };
    }
    return { ok: true, changed, commit: head, version, ...(prebump ? { prebump, noCommit: head === ctx.releaseBase } : {}) };
  }
  return { ok: artOk, why: artOk ? '' : `artefact ${step.artefact} absent`, changed };
}

// ---------------------------------------------------------------------------
// L'exécution
// ---------------------------------------------------------------------------
/**
 * Lance (ou reprend) une exécution. Renvoie le code de sortie du processus :
 * 0 terminée, 2 pause (question à l'utilisateur), 64/65 refus avant écriture.
 */
/** Extra fields the caller adds to an event of the musician's log (never throws). */
function eventTagOf(o, ev) { try { return (typeof o?.eventTag === 'function' && o.eventTag(ev)) || {}; } catch { return {}; } }

export async function runPipeline(o) {
  const { root, logsDir, project, projectName, prompt, dispatchScript, callbackProject, sourceProject, obsId, classification } = o;
  const say = (m) => console.log(`[pipeline] ${m}`);
  // P9: a run may work in a lane of the musician (git worktree, task branch):
  // o.cwd, o.logFile, o.pidFile and o.lane come from dispatch.mjs.
  const cwd = o.cwd || project.path;
  const projectLog = o.logFile || path.join(logsDir, `${projectName}.jsonl`);
  const pidPath = o.pidFile || path.join(logsDir, `${projectName}.pid`);
  // o.eventTag (dispatch.mjs) adds the requests registry's acknowledgement
  // (`taskId`) to the run's user_prompt: without it, a chef task launched with
  // --pipeline was never acknowledged (prod, 2026-10-22).
  const writeEvent = (ev) => { try { fs.appendFileSync(projectLog, JSON.stringify({ ...(process.env.ORCH_TURN_ID ? { orch_turn: process.env.ORCH_TURN_ID } : {}), ...eventTagOf(o, ev), ...ev, timestamp: new Date().toISOString() }) + '\n'); } catch {} };
  const limits = {
    criteriaAttempts: Number(process.env.ORCH_PIPE_CRITERIA_ATTEMPTS) || LIMITS.criteriaAttempts,
    greenAttempts: Number(process.env.ORCH_PIPE_GREEN_ATTEMPTS) || LIMITS.greenAttempts,
    reviewRounds: Number.isFinite(Number(process.env.ORCH_PIPE_REVIEW_ROUNDS)) && process.env.ORCH_PIPE_REVIEW_ROUNDS !== undefined ? Number(process.env.ORCH_PIPE_REVIEW_ROUNDS) : LIMITS.reviewRounds,
    runMs: Number(process.env.ORCH_PIPE_RUN_MS) || LIMITS.runMs,
    items: Number(process.env.ORCH_PIPE_ITEMS) || LIMITS.items,
    testsPerItem: Number(process.env.ORCH_PIPE_TESTS_PER_ITEM) || LIMITS.testsPerItem,
    refactorMinLines: Number.isFinite(Number(process.env.ORCH_PIPE_REFACTOR_MIN)) && process.env.ORCH_PIPE_REFACTOR_MIN !== undefined ? Number(process.env.ORCH_PIPE_REFACTOR_MIN) : LIMITS.refactorMinLines,
  };

  // ── Reprise d'une exécution en pause, ou exécution neuve ─────────────────
  // Un refus avant le départ est écrit dans le log du musicien (0.52.0) : une
  // demande lancée depuis le dashboard ou l'app ne disparaît jamais en silence.
  const refuse = (code, why) => {
    console.error(`[pipeline] refusé : ${why}`);
    writeEvent({ type: 'user_prompt', text: o.promptForLog ?? prompt, ...(sourceProject ? { source: sourceProject } : {}), ...(o.testLabel ? { test: { label: o.testLabel } } : {}) });
    writeEvent({ type: 'result', subtype: 'error_pipeline_refused', is_error: true, num_turns: 0, duration_ms: 0, duration_api_ms: 0, total_cost_usd: 0,
      result: `✕ pipeline ${o.pipeline || o.resumeRun || ''} refusé : ${why}` });
    return code;
  };
  let state;
  if (o.resumeRun) {
    if (!RUN_RE.test(o.resumeRun)) return refuse(64, `exécution invalide : ${o.resumeRun}`);
    state = readJson(path.join(logsDir, 'runs', o.resumeRun, 'run.json'));
    if (!state || state.project !== projectName) return refuse(64, `exécution ${o.resumeRun} introuvable pour ${projectName}`);
    // « running » with a dead process: orphaned, resumable (0.114.0).
    if (state.status === 'running') state = reclaimOrphanedRun(logsDir, o.resumeRun) || state;
    if (state.status !== 'paused') return refuse(65, `exécution ${o.resumeRun} : statut « ${state.status} », seule une exécution en pause se reprend`);
    // Its files are in the lane it started in: resumed there, or not at all.
    const was = Number(state.lane?.k) || 0, now = Number(o.lane?.k) || 0;
    if (was !== now || (was && state.lane.task !== o.lane.task)) {
      return refuse(65, `exécution ${o.resumeRun} : elle travaille dans ${was ? `le couloir ${was} (branche ${state.lane.branch})` : 'la copie principale'}, pas dans ${now ? `le couloir ${now}` : 'la copie principale'} — reprise refusée, rien n'est modifié`);
    }
  }
  const cfg = readJson(path.join(cwd, '.orchestrateur', 'pipeline.json')) || {};
  const pipeline = state?.pipeline || o.pipeline;
  if (!ENGINE_PIPELINES.includes(pipeline)) return refuse(64, `« ${pipeline} » n'est pas en service (${ENGINE_PIPELINES.join(', ')}).`);
  // A mode may have its own preconditions (Rédaction « document »: outside git, tree not clean).
  const needs = pipeline === 'dev' ? { tests: true, clean: true } : { ...(catalogOf(pipeline)?.needs || {}), ...(catalogOf(pipeline)?.needsByMode?.[state?.mode || o.mode] || {}) };
  const isGit = git(cwd, ['rev-parse', '--is-inside-work-tree']).out === 'true';
  // Le Routage (dossier du chef, hors git) se juge sur une empreinte du dossier.
  if (!isGit && needs.git !== false) {
    return refuse(64, `${cwd} n'est pas un dépôt git (les critères de sortie s'appuient sur git).`);
  }
  if (needs.tests && !cfg.testCommand) {
    return refuse(64, `${pipelineLabel(pipeline, 'leger').replace(/ léger$/, '')} exige .orchestrateur/pipeline.json avec testCommand dans ${cwd} (critères de sortie vérifiés par le code).`);
  }
  const base = state?.base || (isGit ? git(cwd, ['rev-parse', 'HEAD']).out : 'hors-git');
  if (!base) return refuse(65, 'dépôt sans commit.');
  if (!state && needs.clean) {
    const dirty = git(cwd, ['status', '--porcelain']).out.split('\n').filter(l => l && !isLocalOnly(l.slice(3)));
    if (dirty.length) return refuse(65, `modifications non commitées (${dirty.length} fichier(s)) — l'étape Livrer doit produire UN commit propre. Commite ou range d'abord.`);
  }

  // Artefacts jamais versionnés, même si le projet ne les ignore pas.
  if (isGit) try {
    // The COMMON dir: a worktree (lane, P9) reads info/exclude from there only.
    const gitDir = git(cwd, ['rev-parse', '--git-common-dir']).out;
    const excl = path.join(path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir), 'info', 'exclude');
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(RUNS_PREFIX)) { fs.mkdirSync(path.dirname(excl), { recursive: true }); fs.appendFileSync(excl, `${cur && !cur.endsWith('\n') ? '\n' : ''}${RUNS_PREFIX}\n`); }
  } catch { /* le critère « fichiers changés » ignore déjà ce dossier */ }

  // Exécution restée « running » dont le processus est mort (tour tué) : jamais
  // une exécution en cours — mise en pause, reprenable (0.114.0 ; elle était
  // close « interrupted », sans reprise possible).
  for (const r of reclaimOrphanedRuns(logsDir, projectName, { except: state?.run })) say(`exécution ${r} orpheline (processus mort) : mise en pause, reprise par « continuer »`);

  const run = state?.run || newRunId();
  const runDir = path.join(logsDir, 'runs', run);
  const artDir = path.join(cwd, '.orchestrateur', 'runs', run);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(artDir, { recursive: true });
  const modes = catalogOf(pipeline)?.modes;
  const mode = state?.mode || (pipeline === 'dev' && o.mode === 'complet' ? 'complet' : pipeline === 'discussion' && o.mode === 'verification' ? 'verification' : modes ? (modes[o.mode] ? o.mode : Object.keys(modes)[0]) : 'leger');
  // The nature of a dev request comes from the classifier model or --kind
  // (0.66.0) — never guessed from its words.
  const kind = state?.kind || (pipeline === 'dev' ? o.kind || null : pipeline === 'incident' ? 'bugfix' : null);
  if (pipeline === 'dev' && !kind) return refuse(64, 'nature de la demande (comportement, bugfix ou mécanique) non classée : le model de classement doit la donner (ou --kind).');
  const assignments = readAssignments(root);
  // Switches read when the run starts and frozen in run.json (pipeline-tuning.mjs):
  // the plan itself may depend on them (lever 6), so they are read first.
  const startTuning = state ? null : tuningFor(readTuning(root), projectName);
  if (!state) {
    state = {
      run, project: projectName, pipeline, mode, kind, base, status: 'running',
      createdAt: new Date().toISOString(), request: prompt.slice(0, 20_000),
      plan: planSteps(pipeline, { mode, kind, tuning: startTuning }).map(s => s.id), index: 0, reviewRounds: 0, steps: [], tuning: startTuning,
      // Runs paused by an older engine keep their whole-run Review / single
      // commit (no flag): per-item Review (0.63.0), per-item delivery (0.64.0).
      ...(pipeline === 'dev' && mode === 'complet' ? { itemReview: true, itemDelivery: true, lastDelivered: base, delivered: [], aside: [] } : {}),
      ...(classification ? { classification } : {}), ...(o.modeNote ? { modeNote: o.modeNote } : {}),
      callback: callbackProject || null, source: sourceProject || null,
      ...(o.lane ? { lane: { k: o.lane.k, task: o.lane.task, branch: o.lane.branch, integration: o.lane.integration || null } } : {}),
    };
    // Per-item delivery: set-aside items are put back (or the run paused for
    // them) at « @aside », just before the release step.
    if (state.itemDelivery) state.plan.splice(state.plan.lastIndexOf('livrer'), 0, '@aside');
    fs.writeFileSync(path.join(artDir, 'demande.md'), `# Demande\n\n${prompt}\n`);
  }
  // The callback belongs to the RUN, not to the turn (2026-10-22): a resume
  // launched without --callback keeps the one the run was started with.
  const callbackTo = runCallback(state, { callbackProject, chefCallback: o.resumeRun ? o.chefCallback : null });
  const saveState = () => {
    state.updatedAt = new Date().toISOString();
    // run.json is read by the server (GET /api/pipeline-runs) at any time: a
    // plain rename fails with EPERM on Windows while it is open (0.74.3).
    writeFileAtomic(path.join(runDir, 'run.json'), JSON.stringify(state, null, 2));
  };
  const resumed = state.status === 'paused';
  // « continuer » après une limite (items, durée, revue) : l'utilisateur accepte
  // UNE allocation de plus, de la même taille, pour cette exécution — sans quoi
  // la reprise retomberait aussitôt sur la même limite. Tracé dans le log.
  let extended = null;
  if (resumed && !state.pausedLimit) {
    // Exécution mise en pause par un moteur antérieur à 0.50.0 : la limite est
    // relue dans le log du musicien (dernier pipeline_limit de CETTE exécution).
    try {
      const lines = fs.readFileSync(projectLog, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && i > lines.length - 5000; i--) {
        if (!lines[i].includes('"pipeline_limit"')) continue;
        const ev = JSON.parse(lines[i]);
        if (ev.subtype === 'pipeline_limit' && ev.pipeline?.run === state.run) { state.pausedLimit = ev.limit; break; }
      }
    } catch { /* log illisible : pas d'allocation */ }
  }
  // Smart pause menu (0.122.0): the option answered acts on the diagnosed cause
  // — split the list, adjust a criterion for this run, hand a precise
  // instruction to the step, run the concrete repair. Every effect is traced.
  const pauseOption = resumed && o.pauseOption ? (state.diagnosis?.options || []).find(x => x.key === o.pauseOption) || null : null;
  if (resumed && o.pauseOption) {
    const eff = pauseOption?.effect || {};
    writeEvent({ type: 'system', subtype: 'pipeline_pause_option', pipeline: { run }, key: o.pauseOption, cause: state.diagnosis?.cause || null, effect: Object.keys(eff),
      text: `choix « ${o.pauseOption} » à la pause${state.diagnosis?.cause ? ` (cause : ${String(state.diagnosis.cause).slice(0, 200)})` : ''}` });
    if (eff.split) {
      const its = parseItems(fs.existsSync(path.join(artDir, 'tests.md')) ? fs.readFileSync(path.join(artDir, 'tests.md'), 'utf8') : '');
      const open = its.filter(i => !i.done);
      const drop = new Set(open.slice(Math.max(0, eff.split.keep || 0)).map(i => i.n));
      if (drop.size) {
        let n = 0;
        const kept = splitTestsList(fs.readFileSync(path.join(artDir, 'tests.md'), 'utf8'), drop);
        const gone = open.filter(i => drop.has(i.n)).map(i => i.text.replace(TESTS_DECL_RE, '').trim());
        fs.writeFileSync(path.join(artDir, 'tests.md'), kept);
        fs.writeFileSync(path.join(artDir, 'reste.md'), ['# Reste à demander séparément', '', ...gone.map((t, i) => `${i + 1}. ${t}`), ''].join('\n'));
        state.splitOff = [...(state.splitOff || []), ...gone];
        // Paused right after « Liste de tests »: its list is kept (trimmed), not rewritten by a new turn.
        if (state.plan?.[state.index] === 'liste-tests') state.index++;
        writeEvent({ type: 'system', subtype: 'pipeline_split', pipeline: { run }, kept: open.length - drop.size, splitOff: gone,
          text: `demande découpée : ${open.length - drop.size} test(s) gardé(s) dans cette exécution, ${gone.length} devenu(s) des demandes séparées (reste.md)` });
      }
    }
    if (eff.relax) {
      const r = { ...eff.relax, at: new Date().toISOString(), cause: state.diagnosis?.cause || null, ...(eff.relax.criterion === 'itemTests' && state.item ? { item: state.item.n } : {}) };
      state.relaxed = [...(state.relaxed || []), r];
      writeEvent({ type: 'system', subtype: 'pipeline_criterion_relaxed', pipeline: { run, item: r.item ?? null }, criterion: r.criterion,
        text: `critère « ${r.criterion === 'citedPaths' ? 'chemins cités' : 'nombre de tests de l’item'} » ajusté pour cette exécution seulement${r.item ? ` (item ${r.item})` : ''}, à la demande faite à la pause` });
    }
    if (eff.repair) {
      const [cmd, ...args] = eff.repair;
      const ok = ['npm', 'pip'].includes(cmd);
      const t0 = Date.now();
      const rr = ok ? spawnSync(process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd, args, { cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15 * 60_000 }) : { status: 64, stderr: 'commande de réparation non autorisée' };
      writeEvent({ type: 'system', subtype: 'pipeline_repair', pipeline: { run }, command: eff.repair, code: rr.status, ms: Date.now() - t0,
        output: String((rr.stdout || '') + (rr.stderr || '') || rr.error?.message || '').slice(-2000),
        text: `réparation « ${eff.repair.join(' ')} » : ${rr.status === 0 ? 'réussie' : `échec (code ${rr.status ?? rr.error?.code ?? '?'})`}` });
    }
    if (eff.message) {
      state.resumeMessages = [...(state.resumeMessages || []), { at: new Date().toISOString(), step: state.plan?.[state.index] || null, pausedLimit: state.pausedLimit || null, from: 'diagnostic', text: eff.message }];
    }
    // Decision 5 (phase 1): « autoriser » at the authorization pause — only the
    // operations that pause listed, and only by this explicit menu word.
    if (eff.authorize && state.pausedLimit === 'autoriser') {
      state.authorizedOps = [...new Set([...(state.authorizedOps || []), ...(state.pendingAuth || [])])];
      writeEvent({ type: 'system', subtype: 'pipeline_operations_authorized', pipeline: { run }, operations: state.pendingAuth || [],
        text: `opération(s) irréversible(s) autorisée(s) par la réponse « autoriser » de l’utilisateur : n° ${(state.pendingAuth || []).map(i => i + 1).join(', ')}` });
      state.pendingAuth = [];
    }
  }
  // 0.133.0: every answer to a pause is remembered with the pause's signature
  // (anti-loop of process-pause.mjs); a decision of the chef is traced below.
  let chefDecided = null;
  if (resumed && state.lastPause) {
    const key = o.chefDecision?.key || o.pauseOption || (o.acceptDefects ? 'accepter' : o.deleteDoubts ? 'tout supprimer' : 'continuer');
    const by = o.chefDecision ? 'chef' : 'utilisateur';
    state.pauseAnswers = [...(state.pauseAnswers || []), { n: state.lastPause.n, limit: state.lastPause.limit, sig: state.lastPause.sig, key, by, at: new Date().toISOString() }].slice(-200);
    if (state.chefPause?.status === 'pending') state.chefPause = { ...state.chefPause, status: by === 'chef' ? 'decided' : 'answered-by-user', key, answeredAt: new Date().toISOString() };
    if (o.chefDecision) chefDecided = { n: state.lastPause.n, limit: state.lastPause.limit, key, reason: o.chefDecision.reason };
    state.lastPause = null;
  }
  if (resumed && ['items', 'duration', 'review'].includes(state.pausedLimit)) {
    state.budgets = state.budgets || {};
    const L = state.pausedLimit;
    // Une liste trop longue d'emblée : l'allocation couvre au moins toute la liste.
    let open = 0; try { open = parseItems(fs.readFileSync(path.join(artDir, 'tests.md'), 'utf8')).filter(i => !i.done).length; } catch {}
    if (L === 'items') state.budgets.items = (state.itemsDone || 0) + Math.max(limits.items, open);
    if (L === 'duration') state.budgets.duration = (Number(state.activeMs) || 0) + limits.runMs;
    if (L === 'review' && state.reviewGroup != null) {
      // Per-item Review: the extra allocation goes to the item that paused.
      const g = state.reviewGroup;
      state.itemReviewBudgets = { ...(state.itemReviewBudgets || {}), [g]: (state.itemReviewRounds?.[g] || 0) + limits.reviewRounds };
      extended = { limit: L, to: state.itemReviewBudgets[g], item: g };
    } else {
      if (L === 'review') state.budgets.review = (state.reviewRounds || 0) + limits.reviewRounds;
      extended = { limit: L, to: state.budgets[L] };
    }
  }
  // « continuer » after a pause for set-aside items: each one is put back in
  // turn (one more allocation of its own limit), then a release.
  if (resumed && state.pausedLimit === 'items_blocked' && state.aside?.length) {
    state.restoreQueue = state.aside.map(a => a.group);
    extended = { limit: 'items_blocked', to: state.restoreQueue.length };
  }
  // « continuer » after aside_conflict (0.113.2): the stale patch is set apart
  // (kept on disk, listed, never re-applied) and the other set-aside items go
  // on. Retrying it would only fall back into the same conflict, forever
  // (items_blocked → continuer → aside_conflict → … , user report 2026-10-18).
  if (resumed && state.pausedLimit === 'aside_conflict') {
    const stale = (state.aside || []).filter(a => a.conflict || a.group === state.asideConflict);
    // A run paused by an older engine has no marker: the item it tried first.
    if (!stale.length && state.aside?.length) stale.push(state.aside[0]);
    const goneGroups = new Set(stale.map(a => a.group));
    state.discardedAside = [...(state.discardedAside || []), ...stale.map(a => ({ ...a, discardedAt: new Date().toISOString() }))];
    state.aside = (state.aside || []).filter(a => !goneGroups.has(a.group));
    // An older engine emptied the queue at the conflict: the remaining items are put back.
    const queued = (state.restoreQueue || []).filter(g => !goneGroups.has(g));
    state.restoreQueue = queued.length ? queued : state.aside.map(a => a.group);
    state.asideConflict = null;
    extended = { limit: 'aside_conflict', to: state.restoreQueue.length, discarded: stale };
  }
  // « accepter » (0.65.0): the review defects that paused the run are accepted
  // explicitly by the user — the next Review of that item (or of the run) is
  // replaced by the acceptance, recorded and handed to Livrer (CHANGELOG).
  if (resumed && o.acceptDefects) {
    const keys = state.pausedLimit === 'items_blocked' ? (state.aside || []).filter(a => a.limit === 'review').map(a => a.group)
      : state.pausedLimit === 'review' ? [state.reviewGroup != null ? state.reviewGroup : 'global'] : [];
    state.acceptReview = [...new Set([...(state.acceptReview || []), ...keys])];
  }
  // Meeting pipeline (0.110.0): « tout supprimer » after the doubts pause — the
  // files in doubt are deleted too (by the code, from the same explicit list).
  if (resumed && o.deleteDoubts && state.pausedLimit === 'doutes') state.deleteDoubts = true;
  // The text sent with a resume (the user's answer, an authorization, details
  // relayed by the chef) is kept verbatim and handed to every following step
  // (0.114.2). It used to be dropped: only the « continuer » decision reached
  // the paused step, which then asked again for an authorization already given.
  if (resumed) {
    const msg = resumeMessage(o.promptForLog ?? prompt);
    if (msg) {
      state.resumeMessages = [...(state.resumeMessages || []), { at: new Date().toISOString(), step: state.plan?.[state.index] || null, pausedLimit: state.pausedLimit || null, text: msg }];
      writeEvent({ type: 'system', subtype: 'pipeline_resume_message', pipeline: { run, step: state.plan?.[state.index] || null }, text: `message joint à la reprise transmis aux étapes suivantes (${msg.length} caractères)` });
    }
  }
  // 0.134.0 — « [projet] est toujours marqué avec "votre réponse attendue" » :
  // once the run goes again, its pause question is answered, whoever answered.
  // Kept as history only; `question` is what a client reads as « awaited ».
  if (state.question) {
    state.answeredQuestions = [...(state.answeredQuestions || []), { text: state.question, pausedLimit: state.pausedLimit || null, answeredAt: new Date().toISOString() }].slice(-20);
    delete state.question;
  }
  state.status = 'running';
  state.pid = process.pid;
  saveState();

  // Le musicien est occupé pendant toute l'exécution : le parent tient le .pid.
  try { fs.writeFileSync(pidPath, String(process.pid)); } catch {}
  // Internal route of a pipeline (meeting → Rédaction, 0.111.0): chosen once,
  // before any step, by the MEANING of the request (classifier model, never
  // keywords); the plan becomes that mode. A failure pauses the run (below,
  // `routeFailure`) — no silent fallback.
  let routeFailure = null;
  const route = catalogOf(pipeline)?.route;
  if (route && !state.route && !state.steps.length) {
    const { chooseOption } = await import('./pipeline-classify.mjs');
    const r = await chooseOption({ root, logsDir, project: projectName, request: state.request || prompt, question: route.question,
      options: Object.entries(route.options).map(([id, what]) => ({ id, what })) });
    if (!r.ok) routeFailure = r.why;
    else {
      state.route = { id: r.id, why: r.raison || '', model: r.model || null };
      state.mode = r.id;
      state.plan = planSteps(pipeline, { mode: r.id, kind }).map(s => s.id);
      state.index = 0;
      saveState();
    }
  }
  let stepDefs = pipeline === 'dev' ? devCatalog({ mode: state.mode, kind }) : Object.fromEntries(planSteps(pipeline, { mode: state.mode, kind, tuning: state.tuning }).map(s => [s.id, s]));
  // Discussion in one call: its research step is inserted only when the answer asks for it.
  if (pipeline === 'discussion' && stepDefs.repondre?.checks?.researchMark) stepDefs.rechercher = DISCUSSION_RESEARCH;
  const catalog = catalogOf(pipeline);
  // Variante d'étape (média, 0.55.0) : sa case passe en tête de la chaîne, et le
  // type de fichier attendu peut en dépendre. Depuis 0.66.0 elle est choisie par
  // le SENS de la demande, par le model de la case routage.classifier — jamais
  // par mots-clés ; un échec met l'exécution en pause (plus bas, `variantFailure`).
  let variantFailure = null;
  if (catalog) for (const [sid, s] of Object.entries(stepDefs)) {
    if (!s.variants) continue;
    let v = state.variants?.[sid];
    if (!v) {
      const { chooseOption } = await import('./pipeline-classify.mjs');
      const r = await chooseOption({ root, logsDir, project: projectName, request: state.request || prompt,
        question: `Which variant of the step "${s.title}" of the "${pipeline}" pipeline does this request need?`,
        options: Object.entries(s.variants).map(([id, what]) => ({ id, what })) });
      if (!r.ok) { variantFailure = { step: s, why: r.why }; break; }
      v = r.id;
      state.variants = { ...(state.variants || {}), [sid]: v };
      saveState();
    }
    stepDefs[sid] = { ...s, variant: v, chain: [`${pipeline}.${s.id}.${v}`, ...s.chain], mediaKind: s.mediaByVariant?.[v] || s.checks?.media?.kind };
  }
  // Frise annoncée : la boucle TDD se lit 4a → 4b → 4c (→ 5 Revue de l'item), répétée par item.
  const loopIds = ['rouge', 'vert', 'refactor', ...(state.itemReview ? ['revue'] : [])];
  const planned = state.plan.flatMap(id => (id === '@loop' ? loopIds.map(x => ({ id: x, loop: true })) : id === '@check' || id === '@aside' ? [] : [{ id }]))
    .map(p => ({ ...p, title: stepDefs[p.id].title, slot: stepDefs[p.id].kind === 'code' ? { slot: stepDefs[p.id].chain[0], model: null, provider: null, second: null, source: 'code' } : resolveCase(assignments, stepDefs[p.id].chain) }));
  writeEvent({
    type: 'user_prompt', text: o.promptForLog ?? prompt,
    pipeline: { run, pipeline, mode: state.mode, kind, resumed: resumed || undefined, ...(state.lane ? { lane: state.lane.k, branch: state.lane.branch } : {}), steps: planned.map(p => ({ id: p.id, title: p.title, loop: p.loop || undefined, slot: p.slot.slot, model: p.slot.model, provider: p.slot.provider, second: p.slot.second, source: p.slot.source })) },
    ...(sourceProject ? { source: sourceProject } : {}),
    ...(callbackTo ? { callback: callbackTo } : {}),
    ...(o.ticket ? { ticket: o.ticket } : {}), ...(o.slot != null ? { slot: o.slot } : {}),
    ...(o.testLabel ? { test: { label: o.testLabel } } : {}),
  });
  writeEvent({ type: 'system', subtype: 'pipeline_start', pipeline: { run, pipeline, mode: state.mode, kind, base, ...(state.lane ? { lane: state.lane.k, branch: state.lane.branch } : {}) },
    text: `${resumed ? 'reprise de l’exécution' : 'exécution'} ${run} : pipeline ${pipelineLabel(pipeline, state.mode)} — ${state.plan.filter(id => id !== '@check' && id !== '@aside').map(id => stepDefs[id].title).join(' → ')}${state.lane ? ` — couloir ${state.lane.k} (branche ${state.lane.branch})` : ''}`,
    ...(o.modeNote ? { note: o.modeNote } : {}) });
  if (chefDecided) {
    writeEvent({ type: 'system', subtype: 'pipeline_chef_decision', pipeline: { run }, n: chefDecided.n, limit: chefDecided.limit, key: chefDecided.key, reason: chefDecided.reason,
      text: decisionText(chefDecided) });
  }
  if (state.route && !state.routeAnnounced) {
    writeEvent({ type: 'system', subtype: 'pipeline_route', pipeline: { run, pipeline, route: state.route.id }, model: state.route.model,
      text: `↪ routage interne : ${route?.labels?.[state.route.id] || state.route.id}${state.route.why ? ` — ${state.route.why}` : ''} (choisi par le model de la case routage.classifier)` });
    state.routeAnnounced = true;
    saveState();
  }
  for (const a of extended?.discarded || []) {
    writeEvent({ type: 'system', subtype: 'pipeline_aside_discarded', pipeline: { run, item: a.group }, patch: a.patch,
      text: `⊘ ${a.group === 0 ? 'le travail d’avant la montée en complet' : `l’item ${a.group}`} écarté : ses modifications ne s’appliquent plus sur le travail livré depuis ; elles restent gardées dans ${a.patch}, non réappliquées` });
  }
  if (extended) {
    const what = { items: `${extended.to} items au total`, duration: `${fmtDur(extended.to)} de temps actif`, review: `${extended.to} tours de revue${extended.item != null ? ` pour l’item ${extended.item}` : ''}`,
      items_blocked: `${extended.to} item(s) mis de côté repris un à un, chacun avec une allocation de plus`,
      aside_conflict: `item en conflit écarté, ${extended.to} autre(s) item(s) mis de côté repris un à un` }[extended.limit];
    writeEvent({ type: 'system', subtype: 'pipeline_limit_extended', pipeline: { run }, limit: extended.limit, to: extended.to,
      text: `↻ « continuer » après la limite « ${extended.limit} » : une allocation de plus accordée pour cette exécution (${what})` });
  }
  for (const p of planned) {
    if (p.slot.source === 'project-default') {
      writeEvent({ type: 'system', subtype: 'pipeline_warning', pipeline: { run, step: p.id, slot: p.slot.slot },
        text: `⚠ ${p.title} : aucune case affectée (${p.slot.slot}) — défaut du projet, failover compris` });
    }
  }
  say(`${resumed ? 'reprise' : 'exécution'} ${run} — ${pipeline}${kind ? ` (${kind})` : ''} — ${planned.map(p => `${p.id}:${p.slot.model || 'défaut'}`).join(', ')}`);

  let current = null;
  const progress = setInterval(() => {
    writeEvent({ type: 'system', subtype: 'pipeline_progress', pipeline: { run, step: current?.id || null },
      text: current ? `étape ${current.title} en cours (${current.model || 'défaut du projet'}) depuis ${fmtDur(Date.now() - current.t0)}` : 'exécution en cours' });
  }, PROGRESS_MS);
  progress.unref?.();

  const childEnv = { ...process.env };
  // DISPATCH_REPORT_ONLY : un tour d'étape ne dispatche jamais (règle 1 de la porte) ; hérité, il le ferait refuser.
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_TEST_LABEL']) delete childEnv[k];
  if (obsId) childEnv.ORCH_OBS_ID = obsId;
  const testEnv = { ...childEnv };
  delete testEnv.ORCH_OBS_ID;
  const ctx = { root, request: state.request || prompt, run, pipeline, kind, mode: state.mode, cwd, cfg, artDir, runDir, base, testEnv, reviewItems: null, testPrint: null, limits,
    item: state.item || null, itemTestBase: state.itemTestBase || null, reviewScope: null, acceptedDefects: state.acceptedDefects || [], escalated: !!state.escalated, coveredItems: state.coveredItems || [], deliveryFixes: state.deliveryFixes || [], suiteRedAtStart: !!state.suiteRedAtStart, lastMedia: state.lastMedia || null,
    resumeMessages: state.resumeMessages || [], relaxed: state.relaxed || [],
    // P9: in a lane, Livrer writes a changelog.d fragment; the integrator assigns the version.
    lane: state.lane?.k >= 1 ? { ...state.lane, dir: cwd, main: project.path, fragment: laneFragmentPath(state.lane.task) } : null };
  // Phase 0 switches, frozen in run.json when the run starts (pipeline-tuning.mjs).
  ctx.tuning = runTuning(state, root, projectName, { resumed: !!o.resumeRun });
  saveState();
  ctx.suiteCacheFile = path.join(logsDir, 'suite-cache', `${projectName}.json`);
  ctx.suiteCacheIndex = path.join(runDir, 'suite-cache.idx');
  ctx.onSuiteCached = (c) => {
    state.suiteCache = { hits: (state.suiteCache?.hits || 0) + 1, savedMs: (state.suiteCache?.savedMs || 0) + (c.ms || 0) };
    writeEvent({ type: 'system', subtype: 'pipeline_suite_cached', pipeline: { run, step: current?.id || null }, tree: c.tree, at: c.at, savedMs: c.ms,
      text: `suite verte déjà vérifiée sur ce même arbre (${c.tree.slice(0, 12)}, le ${c.at.slice(0, 16).replace('T', ' ')}) : non relancée, ${fmtDur(c.ms)} évitées` });
  };
  if (!o.resumeRun && Object.values(ctx.tuning).some(Boolean)) {
    writeEvent({ type: 'system', subtype: 'pipeline_tuning', pipeline: { run }, tuning: ctx.tuning,
      text: `réglages de cette exécution (figés au départ) : ${Object.entries(ctx.tuning).filter(([, v]) => v).map(([k]) => k).join(', ')}` });
  }
  // Durée ACTIVE : le temps passé en pause à attendre l'utilisateur ne compte
  // pas dans la limite de 90 min (une reprise repart du temps déjà consommé).
  const sessionStart = Date.now();
  const elapsed = () => (Number(state.activeMs) || 0) + (Date.now() - sessionStart);
  const totals = { costUsd: 0, apiMs: 0, turns: 0 };

  const finish = async ({ code, result, isError = false, paused = false, question = null, limit = null, notice = null, chef = false }) => {
    clearInterval(progress);
    state.status = paused ? 'paused' : isError ? 'failed' : 'done';
    state.endedAt = new Date().toISOString();
    state.activeMs = elapsed();
    if (question) state.question = question;
    state.pausedLimit = paused ? limit : null;
    saveState();
    const summary = {
      type: 'system', subtype: 'pipeline_summary', pipeline: { run, pipeline, mode: state.mode, kind, status: state.status, escalated: state.escalated || undefined, items: state.itemsDone || undefined },
      steps: state.steps.map(s => ({ id: s.id, key: s.key, title: s.title, slot: s.slot, model: s.model, served: s.served, source: s.source, status: s.status, why: s.why, durationMs: s.durationMs, costUsd: s.costUsd, attempt: s.attempt })),
      totalMs: elapsed(), costUsd: totals.costUsd || null,
      text: `exécution ${run} : ${state.status === 'done' ? 'terminée' : state.status === 'paused' ? 'en pause' : 'échec'} — ${state.steps.filter(s => s.status === 'ok').length} étape(s) validée(s)`,
    };
    writeEvent(summary);
    // Langue de discussion (0.51.0) : le résultat final (réponse, livraison)
    // passe par le même portier que les tours ; les messages rédigés par
    // l'orchestrateur lui-même (pause, échec) sont mis dans la langue choisie.
    // Smart pause answers (0.122.0): what was split off or adjusted is said in the result.
    if (!paused && !isError && state.splitOff?.length) result = `${result}\n\n**Reste à demander séparément** (découpage choisi à la pause ; liste dans reste.md) :\n${state.splitOff.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
    if (!paused && !isError && state.relaxed?.length) result = `${result}\n\n**Critère(s) ajusté(s) pour cette exécution, à votre demande** : ${state.relaxed.map(r => `${r.criterion === 'citedPaths' ? 'chemins cités (signalés au lieu d’être refusés)' : `nombre de tests de l’item ${r.item ?? '?'}`}`).join(' ; ')}.`;
    const target = languageFor(root, projectName);
    let resultLang = null;
    if (paused || isError) {
      result = await localize(root, result, target);
      if (question) question = await localize(root, question, target);
      if (notice) notice = await localize(root, notice, target);
    } else {
      const lastModel = [...state.steps].reverse().find(s => s.status === 'ok' && s.model)?.model || null;
      const g = await languageGate(root, { text: result, target, working: lastModel ? workingLanguage(root, lastModel, target).working : target, model: lastModel, project: projectName });
      for (const e of g.events) writeEvent(e);
      if (g.lang) {
        writeEvent({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: g.text }] }, lang: g.lang });
        result = g.text;
        const { original, ...meta } = g.lang;
        resultLang = meta;
      }
    }
    // A process pause (0.133.0) asks the CHEF: the server relays this line to it
    // and its answer back ([CHEF_ANSWER]); the user is not asked.
    const text = paused ? `${result}\n\n${chef ? 'NEEDS_CHEF_INPUT' : 'NEEDS_USER_INPUT'}: ${question}` : result;
    // Routage : la réponse du chef doit apparaître dans son fil comme un message
    // (le fil lit les messages assistant), même sans reformulation de langue.
    if (paused || (catalogOf(pipeline)?.assistantFinal && !resultLang)) writeEvent({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] } });
    // Ni « fantôme » (0 tour / 0 ms d'API) ni « synthétique » : le chef doit
    // recevoir ce résultat et son réveil, comme pour un tour ordinaire.
    writeEvent({ type: 'result', subtype: isError ? 'error_pipeline' : 'success', is_error: isError,
      num_turns: Math.max(1, totals.turns), duration_ms: elapsed(), duration_api_ms: Math.max(1, totals.apiMs),
      stop_reason: 'end_turn', pipeline: { run, pipeline, status: state.status, ...(limit ? { limit } : {}) },
      ...(paused ? { pipeline_paused: true } : {}), ...(paused && chef ? { chef_pause: true } : {}), ...(resultLang ? { lang: resultLang } : {}), result: text });
    try { fs.unlinkSync(pidPath); } catch {}
    // Une pause part au chef avec TOUTE l'explication (ce qui s'est passé, où en
    // est le travail, les choix et la recommandation), pas seulement la question.
    const pausedText = paused ? [notice, result, question].filter(Boolean).join('\n\n') : null;
    if (callbackTo) {
      await postNotify(root, callbackTo, `[PIPELINE — ${projectName} — ${run}] ${paused ? pausedText : isError ? `✕ ${result.slice(0, 1500)}` : result.slice(0, 8000)}`, paused && chef ? 'pipeline-chef-pause' : paused && limit ? 'pipeline-limit' : 'pipeline');
    } else if (paused && limit) {
      await postNotify(root, 'chef', `[PIPELINE — ${projectName} — ${run}] ${pausedText}`, chef ? 'pipeline-chef-pause' : 'pipeline-limit');
    }
    say(`${summary.text}`);
    return code;
  };

  // ── Messages de pause lisibles (retour utilisateur du 2026-10-09) : ce qui
  //    s'est passé, où en est le travail, ce que fait chaque réponse, et une
  //    recommandation — sans vocabulaire interne (4a, critère, boucle…).
  const progressText = () => {
    const its = parseItems(readArtefact(ctx, 'tests.md') || '');
    const okSteps = state.steps.filter(s => s.status === 'ok');
    if (pipeline === 'dev' && state.mode === 'complet' && its.length) {
      const done = its.filter(i => i.done).length, left = its.length - done;
      const cov = (state.coveredItems || []).length;
      return `${done} test(s) faits sur ${its.length} prévus, ${left} restant(s)${cov ? ` (dont ${cov} déjà assurés par le code existant, sans nouveau code)` : ''}.`;
    }
    return okSteps.length ? `étapes terminées : ${[...new Set(okSteps.map(s => plainStep(s.id)))].join(', ')}.` : 'aucune étape terminée pour l’instant.';
  };
  // Smart pause (0.122.0, user report « porposer des choix stupides ») : every
  // pause states its CAUSE, established by the code first (pause-diagnosis.mjs),
  // and offers choices that act on it — never the same generic menu.
  const pauseText = ({ what, diag, menu, body = null }) => {
    const b = menuBlock(diag, menu);
    return [
      `⏸ **${projectName} — travail en pause, votre décision est attendue.**`, '',
      b.cause, '',
      ...(body ? [body] : [`**Ce qui s'est passé** : ${what}`, '', `**Où en est le travail** : ${progressText()}`]), '',
      b.choices, '',
      b.recommend,
    ].join('\n');
  };
  const plainWhy = (why) => String(why || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 300);
  const projectFiles = () => {
    const r = git(cwd, ['ls-files']);
    return r.ok === false ? [] : String(r.out || '').split('\n').filter(Boolean).slice(0, 50_000);
  };
  // The refusals of the same step, last first block of consecutive attempts.
  const stepAttempts = (id) => {
    const out = [];
    for (const s of [...state.steps].reverse()) { if (s.id !== id) break; if (s.status === 'refused') out.unshift(s.why); }
    return out;
  };
  const diagnose = async (input, menuCtx = {}) => {
    const sid = input.step?.id || null;
    const step = sid ? { id: sid, label: plainStep(sid) } : null;
    const full = { attempts: sid ? stepAttempts(sid) : [], files: projectFiles(), orchNames: orchArtefactNames(), modelTest: state.lastModelTest || null,
      changed: sid ? [...state.steps].reverse().find(s => s.id === sid)?.changed : undefined, ...input, step };
    let d = diagnosePause(full);
    // A model only when the code found nothing: one short choice, case routage.classifier.
    if (d.kind === 'unknown' && process.env.ORCH_PAUSE_MODEL_DIAG !== '0') {
      const { chooseOption } = await import('./pipeline-classify.mjs');
      d = await diagnoseWithModel(d, full, { choose: chooseOption, root, logsDir, project: projectName });
    }
    const slotInfo = sid && stepDefs[sid]?.chain?.length ? resolveCase(readAssignments(root), stepDefs[sid].chain) : null;
    const menu = fixMenu(d, smartMenu(d, { step, slot: input.slot || slotInfo?.slot || null, model: input.model || slotInfo?.model || null,
      delivered: (state.delivered || []).length, hasLock: fs.existsSync(path.join(cwd, 'package-lock.json')), durationText: fmtDur(limits.runMs), ...menuCtx }));
    state.diagnosis = { at: new Date().toISOString(), limit: input.limit || null, step: sid, kind: d.kind, transient: d.transient, cause: d.cause, source: d.source,
      ...(d.model ? { model: d.model } : {}), ...(d.proof ? { proof: d.proof } : {}), ...(d.repeated ? { repeated: true } : {}),
      evidence: (d.evidence || []).slice(0, 8), options: menu.options, recommend: menu.recommend };
    writeEvent({ type: 'system', subtype: 'pipeline_diagnosis', pipeline: { run, step: sid }, diagnosis: state.diagnosis,
      text: `🔎 cause de la pause${d.source === 'model' ? ` (selon le model ${d.model || ''})` : ''} : ${d.cause} — je recommande « ${menu.recommend.key} »` });
    return { d, menu };
  };
  const pauseWith = async ({ limit, input = {}, what, body = null, notice, menuCtx = {}, tail = '' }) => {
    const { d, menu } = await diagnose({ limit, ...input }, menuCtx);
    // 0.133.0 (lever chefPauses, frozen per run): a PROCESS pause is settled by
    // the chef, never asked to the user (process-pause.mjs; in doubt: the user).
    if (ctx.tuning?.chefPauses) {
      const n = state.pauseCount = (Number(state.pauseCount) || 0) + 1;
      const sig = pauseSignature({ limit, kind: d.kind, step: input.step?.id || null, item: (input.item || state.item)?.n ?? null, aside: state.aside, asideConflict: state.asideConflict });
      const r = routePause({ limit, d, menu, pipeline, lane: state.lane?.k || 0, history: state.pauseAnswers || [], sig, project: projectName, run, n, aside: state.aside || [] });
      state.lastPause = { n, limit, sig, to: r.to, why: r.why };
      if (r.to === 'chef') {
        const userQuestion = menuQuestion(projectName, d, menu);
        state.chefPause = { status: 'pending', n, at: new Date().toISOString(), limit, sig, options: r.menu.options.map(o => o.key), recommend: r.menu.recommend,
          blocked: r.blocked, suggestions: r.suggestions, question: r.question, userQuestion, userText: `${pauseText({ what, diag: d, menu, body })}${tail}` };
        const b = menuBlock(d, r.menu);
        const info = [
          `⇄ **${projectName} — pause de processus, transmise au chef** : aucune décision de votre part n’est attendue (votre règle : « arrête de poser des questions de découpage »).`, '',
          b.cause, '',
          ...(body ? [body] : [`**Ce qui s'est passé** : ${what}`, '', `**Où en est le travail** : ${progressText()}`]), '',
          `**Choix soumis au chef** : ${r.menu.options.map(o => `« ${o.key} »`).join(', ')} — recommandé : « ${r.menu.recommend.key} ».`,
          ...(r.blocked.length ? ['', `**Anti-boucle** : ${r.blocked.map(x => `« ${x.key} » déjà choisi ${x.times} fois sur cette même pause, plus proposé`).join(' ; ')}.`] : []),
          ...(r.suggestions.length ? ['', '**Demandes séparées suggérées** :', ...r.suggestions.map(s => `- ${s}`)] : []),
        ].join('\n');
        writeEvent({ type: 'system', subtype: 'pipeline_chef_pause', pipeline: { run }, limit, n, options: state.chefPause.options, recommend: r.menu.recommend.key,
          ...(r.blocked.length ? { blocked: r.blocked } : {}), ...(r.suggestions.length ? { suggestions: r.suggestions } : {}),
          text: `⇄ pause de processus n° ${n} (« ${limit} ») transmise au chef — choix : ${state.chefPause.options.join(', ')} ; recommandé « ${r.menu.recommend.key} »` });
        return finish({ code: 2, paused: true, chef: true, limit, question: r.question, result: `${info}${tail}`, notice: notice ? `${notice} — transmise au chef` : notice });
      }
    }
    return finish({ code: 2, paused: true, limit, question: menuQuestion(projectName, d, menu), result: `${pauseText({ what, diag: d, menu, body })}${tail}`, notice });
  };

  const pauseForLimit = async ({ limit, value, step, why, lastOutput }) => {
    const its = parseItems(readArtefact(ctx, 'tests.md') || '');
    const left = its.filter(i => !i.done);
    const itemTxt = ctx.item ? ` pour le test « ${ctx.item.text} »` : '';
    const maxItems = state.budgets?.items || limits.items;
    const M = {
      items: (state.itemsDone || 0) === 0 ? {
        short: `la liste prévoit ${left.length} tests, plus que le maximum de ${maxItems} par exécution`,
        what: `la liste prévoit ${left.length} tests, plus que le maximum de ${maxItems} par exécution (une règle qui garde des travaux de taille raisonnable). Aucun test n’a encore été écrit.`,
      } : {
        short: `nombre maximum de tests atteint (${its.length - left.length} faits, ${left.length} restant(s))`,
        what: `la règle fixe au plus ${maxItems} tests par exécution, pour garder des travaux de taille raisonnable. Ce nombre est atteint, mais il reste ${left.length} point(s) à traiter${left[0] ? ` — le prochain : « ${left[0].text} »` : ''}.`,
      },
      green: { short: `le code ne fait pas passer le test après ${value} essais`, what: `l’étape « ${plainStep('vert')} » a échoué ${value} fois de suite${itemTxt}. Dernière raison : ${plainWhy(why)}.` },
      criteria: { short: `l’étape « ${plainStep(step?.id)} » a été refusée ${value} fois`, what: `l’étape « ${plainStep(step?.id)} »${itemTxt} a été refusée ${value} fois par les vérifications automatiques de l’orchestrateur. Dernière raison : ${plainWhy(why)}.` },
      item_tests: { short: `${value} tests écrits pour un seul point de la liste, plus que prévu`, what: `${plainWhy(why).replace(/\.$/, '')}.` },
      review: { short: `la relecture trouve encore des défauts après ${value} tour(s) de corrections`, what: `la relecture trouve encore des défauts après ${value} tour(s) de corrections : ${plainWhy(why).replace(/^la revue relève encore : /, '')}.` },
      items_blocked: (() => {
        const ds = state.delivered || [], as = state.aside || [];
        const it = (x) => (x.group === 0 ? 'le travail d’avant la montée en complet' : `l’item ${x.group} « ${String(x.text).replace(/\(\s*tests?\s*:\s*\d+\s*\)\s*/i, '')} »`);
        const rel = (state.releases || []).at(-1);
        return {
          short: `${as.length} item(s) mis de côté, ${ds.length} livré(s)`,
          what: `chaque item est livré séparément. ${ds.length ? `Déjà livré(s), chacun dans son propre commit : ${ds.map(d => `${it(d)} (${d.commit.slice(0, 7)})`).join(' ; ')}${rel?.version ? ` — version ${rel.version}` : ''}.` : 'Aucun item n’a encore pu être livré.'} `
            + `Mis de côté, sans bloquer les autres : ${as.map(a => `${it(a)} — ${ASIDE_WORDS[a.limit] || a.limit} (${plainWhy(a.why)}) ; ses modifications sont gardées dans \`${a.patch}\``).join(' ; ')}.`
            + (discardedText(state) ? ` ${discardedText(state).trim()}` : ''),
        };
      })(),
      aside_conflict: { short: 'un item mis de côté ne s’applique plus sur le travail livré depuis', what: `${plainWhy(why)}. Le projet est resté tel qu’il était après la dernière livraison.` },
      duration: { short: 'durée maximale de travail atteinte', what: `le travail a dépassé ${fmtDur(value)} de travail effectif (le temps passé à attendre votre réponse ne compte pas).` },
    }[limit] || { short: limit, what: plainWhy(why) || limit };
    const notice = `⏸ Limite atteinte — ${projectName} : ${M.short}`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step?.id || null }, limit, value, why: why ? String(why).slice(0, 2000) : null,
      lastOutput: lastOutput ? String(lastOutput).slice(-2000) : null, text: notice });
    // Review defects can also be accepted explicitly (0.65.0): nothing is delivered with a defect otherwise.
    const canAccept = limit === 'review' || (limit === 'items_blocked' && (state.aside || []).some(a => a.limit === 'review'));
    const defects = limit === 'review' ? String(why || '').replace(/^la revue relève encore\s*:\s*/i, '').split(/\s*;\s*/).filter(Boolean) : [];
    return pauseWith({ limit, what: M.what, notice,
      input: { step, why, testOutput: lastOutput, itemsLeft: left, itemsDone: state.itemsDone || 0, itemsMax: maxItems, item: ctx.item || state.item || null,
        written: limit === 'item_tests' ? value : undefined, defects,
        aside: (state.aside || []).map(a => ({ group: a.group, limit: a.limit, reason: ASIDE_WORDS[a.limit] || a.limit, why: plainWhy(a.why) })),
        extra: { rounds: value, duration: fmtDur(limits.runMs) } },
      menuCtx: { canAccept, keep: limit === 'items' && (state.itemsDone || 0) === 0 ? maxItems : 0, restoreQueue: (state.restoreQueue || []).length } });
  };

  const pauseForModel = async (step, info, why) => {
    const notice = `⏸ Model indisponible — ${projectName} : ${info.model} ne répond pas (étape « ${plainStep(step.id)} »)`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step.id }, limit: 'model_unavailable', value: info.model, why: String(why).slice(0, 2000), text: notice });
    return pauseWith({ limit: 'model_unavailable', notice,
      what: `le model ${info.model}, choisi pour l’étape « ${plainStep(step.id)} », est indisponible : ${plainWhy(why)}. Je ne bascule jamais en silence sur un autre model (votre règle).`,
      input: { step, why, providerError: why, model: info.model, slot: info.slot } });
  };

  // ── Erreurs de lancement : attentes progressives (0.60.0, model-backoff.mjs) ──
  const BO = backoffConfig(process.env);
  const modelTestFor = async (info, label) => {
    writeEvent({ type: 'system', subtype: 'pipeline_model_test', pipeline: { run, slot: info.slot }, model: info.model, status: 'running',
      text: `🔬 test du model ${info.model || '(défaut)'} en cours…` });
    const t = await runModelTest({ root, provider: info.provider, model: info.model, label });
    const rel = path.relative(root, t.logFile).split(path.sep).join('/');
    writeEvent({ type: 'system', subtype: 'pipeline_model_test', pipeline: { run, slot: info.slot }, model: info.model, status: t.ok ? 'ok' : 'failed',
      ok: t.ok, why: t.why, served: t.served, ms: t.ms, logFile: rel, logName: t.logName,
      text: `🔬 test du model ${info.model} : ${t.ok ? 'il répond' : `échec — ${t.why}`} (journal : ${rel})` });
    return { ...t, rel };
  };
  const backoffWait = async (step, info, rec, tier, failures) => {
    // Taken before the wait is announced: a "test"/"retry" made as soon as the
    // event or the chef's notice appears must count, even though waitBackoff
    // only starts after postNotify returns (up to 4 s on a slow server).
    const since = Date.now();
    const ms = delayFor(tier, BO);
    const until = new Date(since + ms).toISOString();
    state.backoff = { step: step.id, slot: info.slot, model: info.model, provider: info.provider, tier, maxTiers: BO.maxTiers, waitMs: ms, until, failures, stderrLog: rec.stderrLog || null };
    saveState();
    const text = `⏳ ${info.model || 'le model'} ne démarre pas (${failures} erreurs de lancement de suite, étape « ${plainStep(step.id)} ») : `
      + `nouvel essai dans ${Math.round(ms / 1000)} s, puis un second (palier ${tier}/${BO.maxTiers}). Pendant l’attente : tester le model, `
      + `changer de model (case « ${info.slot} » de la page Models), ou réessayer tout de suite.`;
    writeEvent({ type: 'system', subtype: 'pipeline_backoff', pipeline: { run, step: step.id, slot: info.slot }, model: info.model, provider: info.provider,
      tier, maxTiers: BO.maxTiers, waitMs: ms, until, failures, why: rec.why, stderrLog: rec.stderrLog || null, text });
    await postNotify(root, 'chef', `[PIPELINE — ${projectName} — ${run}] ${text}\nCommandes : node scripts/model-backoff.mjs ${run} test (tester, avec journal) · node scripts/model-backoff.mjs ${run} retry (réessayer maintenant) · page Models, case « ${info.slot} » (changer de model, puis retry).`, 'pipeline-backoff');
    const w = await waitBackoff({ ms, runDir, since, onTest:() => modelTestFor(info, `${projectName} ${run} étape ${step.id} (attente palier ${tier})`) });
    state.backoff = null;
    saveState();
    writeEvent({ type: 'system', subtype: 'pipeline_backoff_end', pipeline: { run, step: step.id, slot: info.slot }, reason: w.reason, waitedMs: w.waitedMs,
      text: w.reason === 'retry' ? '↻ nouvel essai forcé, sans attendre la fin du délai' : `↻ fin de l’attente (${Math.round(w.waitedMs / 1000)} s) : nouvel essai` });
  };
  const pauseForLaunch = async (step, info, rec, failures) => {
    const notice = `⏸ ${info.model || 'le model'} ne démarre pas — ${projectName} : ${failures} erreurs de lancement de suite (étape « ${plainStep(step.id)} »)`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step.id }, limit: 'launch', value: failures, why: String(rec.why || '').slice(0, 2000), stderrLog: rec.stderrLog || null, text: notice });
    const waited = Array.from({ length: BO.maxTiers }, (_, i) => delayFor(i + 1, BO)).reduce((a, b) => a + b, 0);
    // Phase 0 a: also held for an automatic retry (5, 15, 30 min).
    const held = holdForRetry(logsDir, { run, project: projectName, cause: 'exit', step: step.id, detail: rec.why });
    const at = new Date(held.retryAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    state.infra = { cause: 'exit', step: step.id, slot: info.slot, model: info.model, at: held.at, until: null, retryAt: held.retryAt, detail: String(rec.why || '').slice(0, 300) };
    return pauseWith({ limit: 'launch', notice,
      what: `le model ${info.model}, choisi pour l’étape « ${plainStep(step.id)} » (case « ${info.slot} »), n’a rien produit ${failures} fois de suite, malgré ${BO.maxTiers} attentes de plus en plus longues (${Math.round(waited / 1000)} s au total). Dernière erreur : ${plainWhy(rec.why)}. Je ne change jamais de model sans vous (votre règle).`,
      input: { step, why: rec.why, providerError: rec.why, model: info.model, slot: info.slot, extra: { failures } },
      tail: `\n\n↻ Votre demande est gardée : prochain essai automatique à ${at} (puis 15 et 30 min plus tard si besoin).` });
  };

  // Phase 0 a (Routage v3): an infrastructure failure sets the run aside. No
  // attempt counted, no defect, no criteria pause; the registry relaunches it.
  const INFRA_KIND = { auth: 'env_auth', limit: 'limit', refusal: 'refusal', exit: 'launch' };
  const holdForInfra = async (step, info, rec, infra) => {
    const held = holdForRetry(logsDir, { run, project: projectName, cause: infra.cause, step: step.id, until: infra.until || null, detail: infra.detail });
    state.infra = { cause: infra.cause, step: step.id, slot: info.slot, model: info.model, at: held.at, until: infra.until || null, retryAt: held.retryAt, detail: infra.detail || null };
    const notice = `⏸ En attente de relance — ${projectName} : ${CAUSE_TEXT[infra.cause]} (étape « ${plainStep(step.id)} »)`;
    writeEvent({ type: 'system', subtype: 'pipeline_infra_hold', pipeline: { run, step: step.id, slot: info.slot }, infra: state.infra, text: notice });
    const kind = INFRA_KIND[infra.cause] || 'provider_transient';
    const detail = plainWhy(infra.detail);
    const proof = kind === 'refusal' ? { kind: 'refusal', text: detail || CAUSE_TEXT.refusal } : null;
    return pauseWith({ limit: 'infra', notice,
      body: retryText({ project: projectName, run, step: plainStep(step.id), cause: infra.cause, detail: infra.detail, retryAt: held.retryAt }),
      input: { step, model: info.model, slot: info.slot, known: { kind, cause: `${CAUSE_TEXT[infra.cause].charAt(0).toUpperCase()}${CAUSE_TEXT[infra.cause].slice(1)}${detail ? ` (${detail})` : ''}.`, ...(proof ? { proof } : {}), ...(infra.until ? { until: infra.until } : {}) } } });
  };

  // Refus de lancement par dispatch.mjs (0.61.1) : la cause est nommée, et rien
  // n'est reproché au model — ni « le model n'a rien produit », ni « tester le
  // model », ni « changer le model ».
  const pauseForLaunchRefused = async (step, info, rec) => {
    const notice = `⏸ Lancement refusé par l’orchestrateur — ${projectName} : l’étape « ${plainStep(step.id)} » n’a pas pu démarrer (dispatch.mjs a refusé de la lancer, le model n’a pas été appelé)`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step.id }, limit: 'launch_refused', value: 1,
      why: String(rec.refusal || rec.why || '').slice(0, 2000), stderrLog: rec.stderrLog || null, text: notice });
    return pauseWith({ limit: 'launch_refused', notice,
      what: `le lancement de l’étape « ${plainStep(step.id)} » a été refusé par dispatch.mjs avant d’appeler le model : ${plainWhy(rec.refusal || rec.why)}. `
        + `${info.model || 'Le model'} n’a donc pas été sollicité : il n’y a rien à lui reprocher, et le tester ou en changer n’y changerait rien. C’est l’orchestrateur qu’il faut corriger (journal : ${rec.stderrLog || '—'}).`,
      input: { step, why: rec.refusal || rec.why, model: info.model, slot: info.slot } });
  };

  // Meeting pipeline (0.110.0): files in doubt are asked BEFORE any deletion.
  const pauseForDoubts = async (step, doubts, json) => {
    const sure = (json?.supprimer || []).map(s => `- \`${s.chemin}\` — ${s.raison || ''}`);
    const notice = `⏸ Question avant suppression — ${projectName} : ${doubts.length} fichier(s) en doute`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step.id }, limit: 'doutes', value: doubts.length,
      why: doubts.map(d => `${d.chemin} : ${d.question}`).join(' ; ').slice(0, 2000), text: notice });
    return pauseWith({ limit: 'doutes', notice,
      what: `avant de supprimer quoi que ce soit, voici la liste explicite. Rien n’a encore été supprimé ni déplacé.\n\nÀ supprimer (sûr) :\n${sure.length ? sure.join('\n') : '- aucun'}\n\nEn doute — je ne les supprime pas sans votre réponse :\n${doubts.map(d => `- \`${d.chemin}\` : ${d.question}`).join('\n')}`,
      input: { step, extra: { doubts: doubts.length } } });
  };

  // ── Phase 0 b/3: steps the PROGRAM does instead of a model turn ──────────
  // Same record, same criterion as a model's attempt; a refusal of the
  // program's own work is deterministic (`noRetry`): no identical retry.
  const programStep = (step, attempt, key, info, work) => {
    const t0 = Date.now();
    const before = snapshot(cwd);
    writeEvent({ type: 'system', subtype: 'pipeline_step_start', pipeline: { run, step: step.id, key, slot: info.slot, attempt }, byCode: true,
      text: `étape ${step.title} — faite par le programme${attempt > 1 ? ` — essai ${attempt}` : ''}` });
    let c;
    try { c = work(before); } catch (e) { c = { ok: false, why: `erreur du programme : ${e.message}` }; }
    const after = snapshot(cwd);
    if (c.ok && !c.checked) c = checkCriteria(ctx, step, before, after);
    const rec = { id: step.id, key, title: step.title, slot: info.slot, model: null, source: 'code', attempt, durationMs: Date.now() - t0, costUsd: null, exit: 0,
      status: c.ok ? 'ok' : 'refused', why: c.ok ? null : c.why, changed: c.changed?.slice(0, 50) };
    if (c.test) rec.test = { ok: c.test.ok, code: c.test.code, ms: c.test.ms, ...(c.test.cached ? { cached: true } : {}) };
    return { rec, crit: { ...c, noRetry: !c.ok }, info, before, after };
  };
  const writeArtefactNote = (step, text) => { try { fs.appendFileSync(path.join(artDir, step.artefact), text); } catch { /* artefact folder gone */ } };

  // ── Une étape : un tour, sur le model de sa case, jeton signé ────────────
  const runStep = async (step, attempt, extra) => {
    const info = resolveCase(readAssignments(root), step.chain);
    const n = String(state.steps.length + 1).padStart(2, '0');
    const key = `${n}-${step.id}`;
    // A delivery without version (Rédaction, media): one commit, by the program.
    if (ctx.deliveryMode === 'commit') {
      return programStep(step, attempt, key, info, () => {
        const d = deliverCommit(cwd, { title: String(state.request || '').split('\n').find(l => l.trim()) || step.title, run });
        if (!d.ok) return { ok: false, why: d.why };
        fs.writeFileSync(path.join(artDir, step.artefact), `# Livraison\n\nCommit ${d.commit.slice(0, 12)} fait par le programme de l’orchestrateur (aucun model) : les fichiers modifiés par l’exécution, sans version ni CHANGELOG.\n`);
        return { ok: true };
      });
    }
    // Mettre en forme by the program (lever 3): no correction, text kept in
    // the artefact, or exact replacements only; anything else = the model.
    if (step.id === 'mettre-en-forme' && ctx.tuning?.codeFormat) {
      const plan = formatPlan(ctx, step);
      if (plan) {
        const r = programStep(step, attempt, key, info, () => applyFormatPlan(ctx, step, plan));
        if (r.rec.status === 'ok') return r;
        restoreFiles(cwd, r.before, r.after, null);
        writeEvent({ type: 'system', subtype: 'pipeline_format_fallback', pipeline: { run, step: step.id, key }, why: r.rec.why,
          text: `mise en forme par le programme impossible (${String(r.rec.why).split('\n')[0].slice(0, 200)}) : l’étape est confiée au model` });
      }
    }
    // Calibrated context (0.99.0): a TDD step's session is its item's, the
    // review's is its group's, Livrer has its own — not the whole run's history.
    const sessionGroup = stepSessionGroup({ step, model: info.model, item: ctx.item, reviewGroup: state.reviewGroup ?? ctx.reviewScope?.group ?? null });
    // A provider refusal asks for a new session (phase 0 a): one fresh try.
    const stepSession = extra?.freshSession ? `${sessionGroup.slice(0, 30)}-n${Date.now().toString(36).slice(-6)}` : sessionGroup;
    const token = signStepToken(root, { run, key, project: projectName, model: info.model, provider: info.provider, second: info.second, exp: Date.now() + 6 * 3600_000 });
    const args = [projectName, '--prompt-stdin', '--pipeline-step', `${run}:${key}`, '--pipeline-session', stepSession, '--no-queue-if-busy'];
    if (info.model) args.push('--model', info.model, '--provider', info.provider);
    if (info.model && info.second) args.push('--second-model', info.second.model, '--second-provider', info.second.provider, '--dual-mode', step.judge ? 'judge' : 'action');
    ctx.localTool = localToolFor(readAssignments(root), step.chain);
    const text = stepPrompt(ctx, step, extra);
    const before = snapshot(cwd);
    current = { id: step.id, title: step.title, model: info.model, t0: Date.now() };
    writeEvent({ type: 'system', subtype: 'pipeline_step_start', pipeline: { run, step: step.id, key, slot: info.slot, attempt, ...(ctx.item ? { item: ctx.item.n, itemText: ctx.item.text } : {}) },
      model: info.model, provider: info.provider, second: info.second, modelSource: info.source,
      text: `étape ${step.title} — ${info.model ? `${info.provider}/${info.model}${info.second ? ` + second ${info.second.model}` : ''}` : 'défaut du projet ⚠'}${attempt > 1 ? ` — essai ${attempt}` : ''}` });
    // Mode double dans une étape d'action : les deux branches partent du dernier
    // commit — l'état courant y est figé par un commit de point d'étape, replié
    // (git reset --soft) avant Livrer pour qu'il ne reste qu'UN commit.
    if (info.second && !step.judge && git(cwd, ['status', '--porcelain']).out) {
      git(cwd, ['add', '-A']);
      git(cwd, ['-c', 'user.name=orchestrateur', '-c', 'user.email=orchestrateur@localhost', 'commit', '-q', '-m', `[pipeline ${run}] point avant ${step.id}`]);
      state.checkpoints = (state.checkpoints || 0) + 1; saveState();
    }
    const t0 = Date.now();
    // The step's stderr is kept (0.60.0): a turn that dies before writing
    // anything (launch failure) leaves its only explanation there.
    const stderrFile = path.join(runDir, `${key}.stderr.log`);
    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [dispatchScript, ...args], { cwd: root, env: { ...childEnv, ORCH_STEP_TOKEN: token }, stdio: ['pipe', 'inherit', 'pipe'], windowsHide: true });
      const errOut = fs.createWriteStream(stderrFile);
      c.stderr.on('data', (d) => { errOut.write(d); try { process.stderr.write(d); } catch {} });
      c.on('error', () => { errOut.end(); resolve(127); });
      c.on('close', (cc) => { errOut.end(() => resolve(cc ?? 1)); });
      c.stdin.end(text);
    });
    const log = readBranchLog(path.join(runDir, `${key}.jsonl`));
    const after = snapshot(cwd);
    const rec = { id: step.id, key, title: step.title, ...(ctx.item ? { item: ctx.item.n } : {}), slot: info.slot, model: info.model, provider: info.provider, second: info.second, source: info.source,
      served: log.served, attempt, durationMs: Date.now() - t0, costUsd: Number.isFinite(log.result?.total_cost_usd) ? log.result.total_cost_usd : null, exit: code };
    totals.turns += 1;
    totals.apiMs += Number(log.result?.duration_api_ms) || Number(log.result?.duration_ms) || 0;
    if (rec.costUsd) totals.costUsd += rec.costUsd;
    current = null;
    // Launch failure (0.60.0): the model never worked (died at start, CLI dead
    // before serving, transient API error) — back-off on the same case, checked
    // BEFORE "model unavailable", which keeps the session limits and the models
    // that cannot run (see model-backoff.mjs).
    // Refused by dispatch.mjs before any call to the model (0.61.1): an
    // orchestrator problem, named as such — checked before the launch failures.
    {
      let stderrText = '';
      try { stderrText = fs.readFileSync(stderrFile, 'utf8'); } catch {}
      const refusal = dispatchRefusal({ code, log, stderr: stderrText });
      if (refusal) {
        rec.status = 'launch_refused';
        rec.why = `le lancement a été refusé par dispatch.mjs avant d'appeler le model (code ${code}) : ${refusal}`;
        rec.refusal = refusal;
        rec.stderrLog = `logs/runs/${run}/${key}.stderr.log`;
        return { rec, info, before, after, launchRefused: true };
      }
      // Infrastructure failure (phase 0 a): checked before the launch failures
      // (an expired OAuth would otherwise be retried blindly) and before
      // « model unavailable » (a session limit is not the model's fault).
      const infra = infraFailure({ code, log, stderr: stderrText });
      if (infra) {
        rec.status = 'infra';
        rec.infra = infra;
        rec.why = `panne d'infrastructure (${CAUSE_TEXT[infra.cause] || infra.cause})${infra.detail ? ` : ${infra.detail}` : ''}`;
        rec.stderrLog = `logs/runs/${run}/${key}.stderr.log`;
        return { rec, info, before, after, infra };
      }
    }
    if (isLaunchFailure({ code, log })) {
      let errTail = '';
      try { errTail = fs.readFileSync(stderrFile, 'utf8').trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(-400); } catch {}
      if (!errTail) errTail = String(log.refused?.reason || log.result?.result || '').replace(/\s+/g, ' ').slice(-400);
      rec.status = 'launch_failed';
      rec.why = `lancement impossible (code ${code}) : le model n'a rien produit${errTail ? ` — ${errTail}` : ''}`;
      rec.stderrLog = `logs/runs/${run}/${key}.stderr.log`;
      return { rec, info, before, after, launchFailed: true };
    }
    // Model indisponible : la règle « aucun fallback » a refusé, ou rien n'a tourné.
    if (log.refused || log.result?.subtype === 'error_model_unavailable') {
      rec.status = 'model_unavailable'; rec.why = String(log.refused?.reason || log.result?.result || 'model indisponible');
      return { rec, unavailable: true, info };
    }
    if (!log.result || log.result.is_error || code !== 0) {
      rec.status = 'failed'; rec.why = !log.result ? `aucun résultat (code ${code})` : String(log.result.result || log.result.subtype || 'échec').slice(0, 1500);
      return { rec, info, before, after };
    }
    ctx.stepLogFile = path.join(runDir, `${key}.jsonl`);
    ctx.citedReported = null;
    // Livrer by the program (phase 0 b, decision 9): the model wrote the text
    // only; the code writes the release, then the SAME criterion is checked.
    if (ctx.deliveryMode === 'release') {
      const d = releaseFromText(ctx, step, before, after);
      const after2 = snapshot(cwd);
      const c = d.ok ? checkCriteria(ctx, step, before, after2) : d;
      rec.status = c.ok ? 'ok' : 'refused';
      rec.why = c.ok ? null : c.why;
      rec.changed = c.changed?.slice(0, 50);
      rec.byCode = 'version, CHANGELOG, exigence et commit écrits par le programme';
      if (c.test) rec.test = { ok: c.test.ok, code: c.test.code, ms: c.test.ms, ...(c.test.cached ? { cached: true } : {}) };
      if (c.ok) writeArtefactNote(step, `\n\n## Livraison faite par le programme\n\n${c.version ? `- version ${c.version}\n` : ''}- commit ${String(c.commit || '').slice(0, 12)}${c.noCommit ? ' (aucun commit nécessaire : déjà livré)' : ''}\n`);
      // A text problem is the model's to fix (new try); a refusal of the
      // program's release (red suite, build…) would repeat identically.
      return { rec, crit: { ...c, noRetry: !c.ok && !d.textProblem }, info, before, after: after2, log };
    }
    const c = checkCriteria(ctx, step, before, after);
    // Lever 1: accepted cited paths that are not files of the project are said, never silent.
    if (ctx.citedReported?.length) rec.citedReported = ctx.citedReported.slice(0, 20);
    rec.status = c.ok ? 'ok' : 'refused';
    rec.why = c.ok ? null : c.why;
    rec.changed = c.changed?.slice(0, 50);
    if (c.test) rec.test = { ok: c.test.ok, code: c.test.code, ms: c.test.ms, ...(c.test.cached ? { cached: true } : {}) };
    if (c.covered) rec.covered = true;
    return { rec, crit: c, info, before, after, log };
  };

  const record = (r) => {
    state.steps.push(r.rec);
    saveState();
    const s = r.rec;
    writeEvent({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: s.id, key: s.key, slot: s.slot, attempt: s.attempt, ...(s.item ? { item: s.item } : {}) },
      model: s.model, served: s.served, provider: s.provider, modelSource: s.source, status: s.status, why: s.why ? String(s.why).slice(0, 2000) : undefined,
      durationMs: s.durationMs, costUsd: s.costUsd, changed: s.changed, test: s.test, ...(s.covered ? { covered: true } : {}), ...(s.citedReported ? { citedReported: s.citedReported } : {}), ...(s.cached ? { cached: s.cached } : {}), ...(s.source === 'code' ? { byCode: true } : {}), log: `logs/runs/${run}/${s.key}.jsonl`,
      text: `étape ${s.title} : ${s.status === 'ok' ? `✓ critère vérifié${s.source === 'code' ? ' (fait par le programme)' : ''}${s.citedReported ? ` — chemins acceptés hors projet : ${s.citedReported.map(r => `${r.path} (${r.why})`).join(', ').slice(0, 300)}` : ''}` : s.status === 'refused' ? `✕ refusée — ${String(s.why).split('\n')[0].slice(0, 200)}` : s.status === 'model_unavailable' ? '⏸ model indisponible' : `✕ échec — ${String(s.why).split('\n')[0].slice(0, 200)}`}` });
  };

  // User rule (2026-10-10) « tout problème détecté doit bloquer une livraison
  // et être rapporté immédiatement »: every defect is written to the log and
  // sent to the chef the moment it is detected — not at the end of the run.
  const reportDefects = async (step, list, kind) => {
    const defects = (list || []).map((x) => {
      const d = String(typeof x === 'string' ? x : x?.issue || x?.text || JSON.stringify(x)).replace(/\s+/g, ' ').trim();
      const sev = (x && typeof x === 'object' && x.severity) || (/\bP[0-3]\b/.exec(d) || [])[0] || kind;
      return { severity: String(sev).slice(0, 20), kind, description: d.slice(0, 400) };
    }).filter(d => d.description);
    if (!defects.length) return;
    const item = ctx.reviewScope?.group ?? ctx.item?.n ?? null;
    const where = `étape « ${String(step?.title || step?.id || '?').replace(/^\d+[a-z]?\s+/, '')} »${item != null ? `, item ${item}` : ''}`;
    const text = `⚑ ${defects.length} défaut(s) détecté(s) — ${projectName}, exécution ${run}, ${where} : ${defects.map(d => `[${d.severity}] ${d.description}`).join(' ; ').slice(0, 1800)} — aucune livraison tant qu’il n’est pas corrigé ou accepté`;
    writeEvent({ type: 'system', subtype: 'pipeline_defect', pipeline: { run, step: step?.id || null, item }, defects, text });
    state.defectsReported = (state.defectsReported || 0) + defects.length;
    await postNotify(root, 'chef', `[DÉFAUT — ${projectName} — ${run}] ${text}`, 'pipeline-defect');
  };
  // Variant not classified by the model (0.66.0): a pause with a question,
  // never a keyword guess. « continuer » asks the model again.
  if (routeFailure) {
    const opts = Object.entries(route.labels || route.options).map(([id, what]) => `« ${id} » (${what})`).join(', ');
    return pauseWith({ limit: 'classifier',
      notice: `⏸ ${projectName} : le model de classement n’a pas pu choisir le routage interne du pipeline « ${pipelineLabel(pipeline, state.mode)} »`,
      what: `le routage interne de ce pipeline se fait par le sens de la demande, par le model de la case « routage.classifier » de la page Models, jamais par mots-clés. Ce choix a échoué : ${routeFailure}. Routages possibles : ${opts}.`,
      input: { why: routeFailure } });
  }
  if (variantFailure) {
    const sv = variantFailure.step;
    const opts = Object.entries(sv.variants).map(([id, what]) => `« ${id} » (${what})`).join(', ');
    return pauseWith({ limit: 'classifier',
      notice: `⏸ ${projectName} : le model de classement n’a pas pu choisir la variante de l’étape « ${plainStep(sv.id)} »`,
      what: `le choix de la variante de l’étape « ${plainStep(sv.id)} » se fait par le sens de la demande, par le model de la case « routage.classifier » de la page Models, jamais par mots-clés. Ce choix a échoué : ${variantFailure.why}. Variantes possibles : ${opts}.`,
      input: { why: variantFailure.why } });
  }

  // ── Préconditions de Développement : la suite doit être verte au départ ──
  // Incident : une suite déjà rouge reproduit le problème — l'étape « test qui
  // reproduit » est alors sautée (dit), et la correction doit la rendre verte.
  if (pipeline === 'incident' && state.index === 0 && !resumed && cfg.testCommand && !runSuite(ctx).ok) {
    state.suiteRedAtStart = ctx.suiteRedAtStart = true;
    const i = state.plan.indexOf('corriger-rouge');
    if (i >= 0) {
      state.plan.splice(i, 1);
      const why = `la suite (${cfg.testCommand}) échoue déjà au départ : elle reproduit le problème, aucun nouveau test n'est nécessaire pour le montrer`;
      state.steps.push({ id: 'corriger-rouge', key: '00-corriger-rouge', title: stepDefs['corriger-rouge'].title, status: 'skipped', why, attempt: 1, durationMs: 0 });
      writeEvent({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: 'corriger-rouge', key: '00-corriger-rouge', attempt: 1 }, status: 'skipped', why, durationMs: 0, text: `étape ${stepDefs['corriger-rouge'].title} : sautée — ${why}` });
      saveState();
    }
  }
  if ((pipeline === 'dev' || pipeline === 'maintenance') && state.index === 0 && (!resumed || state.pausedLimit === 'precondition')) {
    const t = runSuite(ctx);
    if (!t.ok) {
      const failure = classifyTestFailure(t.out);
      const envSigns = failure.signals.map(s => `${s.label} (${s.match})`).join(', ');
      writeEvent({ type: 'system', subtype: 'pipeline_precondition', pipeline: { run }, cause: failure.cause, signals: failure.signals,
        text: failure.cause === 'environment'
          ? `la suite (${cfg.testCommand}) échoue avant l'étape 4a pour une raison d'ENVIRONNEMENT, probablement pas un test cassé : ${envSigns}`
          : `la suite (${cfg.testCommand}) est déjà rouge avant l'étape 4a`,
        output: t.out.slice(-2000) });
      await reportDefects({ id: 'precondition', title: 'Préconditions' }, [`la suite (${cfg.testCommand}) échoue avant toute modification${failure.cause === 'environment' ? ` (environnement : ${envSigns})` : ''}${ctx.lane ? ` — dans le couloir ${ctx.lane.k} (copie isolée) : s’il manque un fichier non suivi, le déclarer dans « lanes.copy » / « lanes.link » de .orchestrateur/pipeline.json, ou « maxParallel »: 1 pour ce projet` : ''}`], 'test');
      if (failure.cause === 'environment') {
        return pauseWith({ limit: 'precondition', notice: `⏸ ${projectName} : les tests échouent à cause de l'environnement (${failure.signals[0].label}), pas forcément d'un test cassé`,
          what: `avant de commencer, j’ai lancé les tests du projet (« ${cfg.testCommand} ») : ils échouent, mais les erreurs viennent de l’environnement (${envSigns}) — un service distant injoignable ou trop lent —, et probablement pas d’un test cassé. Je ne peux pas démarrer sur une base qui ne passe pas, quelle qu’en soit la cause.`,
          input: { extra: { environment: envSigns } } });
      }
      return pauseWith({ limit: 'precondition', notice: `⏸ ${projectName} : les tests du projet échouent déjà avant toute modification`,
        what: `avant de commencer, j’ai lancé les tests du projet (« ${cfg.testCommand} ») : ils échouent déjà. Or chaque nouveau test doit d’abord échouer à cause de lui seul ; sur une base déjà cassée, ce contrôle n’a plus de sens.`
          + (ctx.lane ? ` Le travail se fait dans le couloir ${ctx.lane.k}, une copie isolée du dépôt qui ne contient que les fichiers suivis par git (plus les dépendances installées, partagées par lien) : si les tests passent dans la copie principale, il manque probablement un fichier non suivi, à déclarer dans « lanes.copy » ou « lanes.link » de .orchestrateur/pipeline.json (ou « maxParallel »: 1 pour ce projet).` : ''),
        input: { testOutput: t.out, extra: { failing: readTestOutput(t.out)?.line || '' } } });
    }
  }
  // Empreinte des tests protégés : à la reprise, celle de l'état actuel.
  const testsNow = () => new Map([...snapshot(cwd)].filter(([f]) => isTestFile(f, cfg.testGlobs)));
  if (pipeline === 'dev' || (catalog && (cfg.testGlobs || []).length)) ctx.testPrint = testsNow();
  if (state.reviewItems) ctx.reviewItems = state.reviewItems;

  // ── Boucle des étapes ─────────────────────────────────────────────────────
  const readItems = () => parseItems(readArtefact(ctx, 'tests.md') || '');
  // ── Per-item delivery (0.64.0, « c+d » part c) ─────────────────────────
  const asideGroups = () => new Set((state.aside || []).map(a => a.group));
  const groupText = (g) => (g === 0 ? 'travail d’avant la montée en complet' : readItems().find(i => i.n === g)?.text || '');
  const groupLabel = (g) => (g === 0 ? 'le travail d’avant la montée en complet' : `l’item ${g}`);
  const deliverGroup = (g) => {
    foldTo(cwd, state.lastDelivered || base);
    state.checkpoints = 0;
    const c = commitWork(cwd, itemCommitMessage({ group: g, text: groupText(g), run, cases: groupCases(readItems(), g).length }));
    if (!c.ok || c.empty) return c;
    state.lastDelivered = c.commit;
    state.delivered = [...(state.delivered || []), { group: g, text: groupText(g).slice(0, 300), commit: c.commit }];
    state.releasePending = true;
    writeEvent({ type: 'system', subtype: 'pipeline_item_delivered', pipeline: { run, item: g }, commit: c.commit,
      text: `📦 ${groupLabel(g)} livré dans son propre commit ${c.commit.slice(0, 7)}` });
    return c;
  };
  // An item stopped by one of ITS limits is set aside — its work saved as a
  // patch and taken out of the work tree — and the other items go on.
  const acceptDefects = (key, step) => {
    const list = state.lastDefects?.[key] || [];
    state.acceptedDefects = [...(state.acceptedDefects || []), ...list.map(d => ({ item: key === 'global' ? null : key, description: String(d).slice(0, 400) }))];
    ctx.acceptedDefects = state.acceptedDefects;
    state.acceptReview = (state.acceptReview || []).filter(k => k !== key);
    writeEvent({ type: 'system', subtype: 'pipeline_defect_accepted', pipeline: { run, step: step?.id || null, item: key === 'global' ? null : key }, defects: list,
      text: `✓ ${list.length} défaut(s) accepté(s) explicitement par l’utilisateur${key === 'global' ? '' : ` pour ${groupLabel(key)}`} — livraison autorisée en connaissance de cause${list.length ? ` : ${list.slice(0, 5).join(' ; ')}` : ''}` });
  };
  const setAside = (g, limit, why) => {
    const end = state.plan.indexOf('@loop', state.index);
    if (end < 0) return false;
    const prefix = state.plan.splice(state.index, end - state.index);
    const patchFile = path.join(runDir, `aside-item-${g}.patch`);
    const r = setAsideWork(cwd, { from: state.lastDelivered || base, indexFile: path.join(runDir, 'item-review.idx'), patchFile });
    if (!r.ok) { state.plan.splice(state.index, 0, ...prefix); return false; }
    const patch = path.relative(root, patchFile).split(path.sep).join('/');
    state.aside = [...(state.aside || []), { group: g, text: groupText(g).slice(0, 300), limit, why: String(why || '').slice(0, 2000), prefix,
      item: state.item, itemTestBase: state.itemTestBase, reviewGroup: state.reviewGroup, lastGreenLines: state.lastGreenLines ?? null, patch, files: r.files }];
    state.item = ctx.item = null;
    state.itemTestBase = ctx.itemTestBase = null;
    state.reviewGroup = null; ctx.reviewScope = null;
    // Its pending doc correction goes aside with it (0.114.0): left behind, the
    // NEXT item's 4b took it as its own and re-reviewed this group mid-item,
    // which cleared state.item and crashed « @check » (frozen run, 2026-10-18).
    if (state.fixGroup === g) {
      state.aside[state.aside.length - 1].fixes = state.reviewItems || ctx.reviewItems || [];
      state.fixGroup = null; state.reviewItems = ctx.reviewItems = null;
    }
    state.checkpoints = 0;
    ctx.testPrint = testsNow();
    writeEvent({ type: 'system', subtype: 'pipeline_item_aside', pipeline: { run, item: g }, limit, why: String(why || '').slice(0, 2000), patch, files: r.files,
      text: `⏸ ${groupLabel(g)} mis de côté (${ASIDE_WORDS[limit] || limit}) : ses modifications sont gardées dans ${patch} — les autres items continuent` });
    saveState();
    return true;
  };
  steps: while (state.index < state.plan.length) {
    const id = state.plan[state.index];
    if (elapsed() > (state.budgets?.duration || limits.runMs)) return pauseForLimit({ limit: 'duration', value: state.budgets?.duration || limits.runMs, step: stepDefs[id] });
    // ── Boucle TDD (0.49.0) : UN item de tests.md à la fois, 4a → 4b → 4c,
    //    tant que la liste n'est pas vide. Le moteur coche l'item, pas le model.
    if (id === '@loop') {
      // Escalated run: the light work done before the list (group 0) is
      // reviewed first, on its own diff, before any item starts.
      if (state.pendingGroupReview != null) {
        state.reviewGroup = state.pendingGroupReview;
        state.pendingGroupReview = null;
        state.plan.splice(state.index, 0, 'revue');
        saveState();
        continue;
      }
      const aside = asideGroups();
      const next = readItems().find(i => !i.done && !aside.has(groupOf(i)));
      if (!next) { state.plan.splice(state.index, 1); state.item = ctx.item = null; saveState(); continue; }
      if ((state.itemsDone || 0) >= (state.budgets?.items || limits.items)) {
        return pauseForLimit({ limit: 'items', value: limits.items, step: stepDefs['@loop'], why: `la liste n'est pas vide après ${limits.items} items (suivant : « ${next.text} ») — découper la demande` });
      }
      state.item = ctx.item = next;
      // Per-item Review: the tree at the start of the item's group is the
      // origin of the diff its Review will read (null → whole-run fallback).
      const g = groupOf(next);
      if (state.itemReview && g === next.n && !(String(g) in (state.groupTrees || {}))) {
        state.groupTrees = { ...(state.groupTrees || {}), [g]: worktreeTree(cwd, path.join(runDir, 'item-review.idx')) };
      }
      // Point de départ du compte des tests de cet item (vérifié en 4a et en le cochant).
      state.itemTestBase = ctx.itemTestBase = countTests(cwd, [...testsNow().keys()]);
      state.plan.splice(state.index, 0, 'rouge', 'vert', 'refactor', '@check');
      writeEvent({ type: 'system', subtype: 'pipeline_item_start', pipeline: { run, item: next.n }, text: `item ${next.n} : ${next.text}` });
      saveState();
      continue;
    }
    if (id === '@check') {
      // Vérification finale avant de cocher (décision « c+d », 0.62.0) : jamais
      // de dépassement accepté en silence. Item d'une exécution antérieure à
      // 0.62.0 (pas de point de départ) : non vérifiable, dit.
      let tests;
      if (state.itemTestBase) {
        const v = checkItemTests({ cwd, files: [...testsNow().keys()], base: state.itemTestBase, item: state.item });
        if (!v.ok && itemTestsRelaxed(state.relaxed, state.item)) {
          v.ok = true; v.relaxed = true;
          writeEvent({ type: 'system', subtype: 'pipeline_criterion_relaxed', pipeline: { run, item: state.item.n }, criterion: 'itemTests',
            text: `item ${state.item.n} : ${v.written} test(s) acceptés au lieu de ${state.item.declared ?? '?'} annoncé(s) — critère ajusté pour cet item à la pause (« ajuster le critère »)` });
        }
        if (!v.ok) {
          if (state.itemDelivery && setAside(groupOf(state.item), 'item_tests', v.why)) continue;
          return pauseForLimit({ limit: 'item_tests', value: v.written, step: stepDefs.rouge, why: v.why });
        }
        tests = v.checked ? { declared: v.declared, written: v.written } : { written: v.written, unchecked: v.note };
      } else tests = { unchecked: 'item commencé avant 0.62.0 : nombre de tests non vérifié' };
      fs.writeFileSync(path.join(artDir, 'tests.md'), checkItem(readArtefact(ctx, 'tests.md') || '', state.item.n));
      state.itemsDone = (state.itemsDone || 0) + 1;
      writeEvent({ type: 'system', subtype: 'pipeline_item_done', pipeline: { run, item: state.item.n }, tests,
        text: `✓ item ${state.item.n} coché : ${state.item.text}${tests.declared != null ? ` (${tests.written}/${tests.declared} test(s))` : tests.unchecked ? ` — ${tests.unchecked}` : ''}` });
      // Per-item Review once the item's group has no open case left (an item
      // and the cases its Review attached to it are reviewed together).
      const g = groupOf(state.item);
      const reviewNow = !!state.itemReview && groupReady(readItems(), g);
      state.plan.splice(state.index, 1, ...(reviewNow ? ['revue'] : []));
      if (reviewNow) state.reviewGroup = g;
      state.item = ctx.item = null;
      state.itemTestBase = ctx.itemTestBase = null;
      saveState();
      continue;
    }
    if (id === '@aside') {
      // « continuer » granted: put the next set-aside item back, where it stopped.
      if (state.restoreQueue?.length) {
        const g = state.restoreQueue.shift();
        const a = (state.aside || []).find(x => x.group === g);
        if (!a) { saveState(); continue; }
        const from = state.lastDelivered || base;
        foldTo(cwd, from);
        const r = reapplyWork(cwd, path.join(root, a.patch));
        if (!r.ok) {
          // The rest of the queue is kept: « continuer » sets this one apart and goes on with them.
          a.conflict = { at: new Date().toISOString(), err: String(r.err || '').split('\n')[0].slice(0, 500) };
          state.asideConflict = g;
          saveState();
          return pauseForLimit({ limit: 'aside_conflict', value: g, step: stepDefs.vert,
            why: `les modifications de ${groupLabel(g)} (« ${a.text} »), gardées dans ${a.patch}, ne s’appliquent plus sur le travail livré depuis : ${String(r.err).split('\n')[0]}` });
        }
        state.aside = state.aside.filter(x => x !== a);
        // Its Review diff starts from what was delivered, not from its old start.
        state.groupTrees = { ...(state.groupTrees || {}), [g]: git(cwd, ['rev-parse', `${from}^{tree}`]).out };
        state.item = ctx.item = a.item || null;
        state.itemTestBase = ctx.itemTestBase = a.itemTestBase || null;
        state.reviewGroup = a.reviewGroup ?? null;
        state.lastGreenLines = a.lastGreenLines;
        if (a.fixes?.length) { state.fixGroup = g; state.reviewItems = ctx.reviewItems = a.fixes; }
        if (a.limit === 'review') state.itemReviewBudgets = { ...(state.itemReviewBudgets || {}), [g]: (state.itemReviewRounds?.[g] || 0) + limits.reviewRounds };
        ctx.testPrint = testsNow();
        state.plan.splice(state.index, 0, ...a.prefix, '@loop');
        if (state.plan.indexOf('livrer', state.index) < 0) state.plan.push('livrer');
        writeEvent({ type: 'system', subtype: 'pipeline_item_resumed', pipeline: { run, item: g },
          text: `↻ ${groupLabel(g)} repris là où il s’était arrêté (${ASIDE_WORDS[a.limit] || a.limit})${r.merged ? ', fusionné avec le travail livré depuis' : ''}` });
        saveState();
        continue;
      }
      if (!state.aside?.length) { state.plan.splice(state.index, 1); saveState(); continue; }
      // Items remain set aside: what was delivered is released first, then the pause.
      const li = state.plan.indexOf('livrer', state.index);
      if (state.releasePending && li > state.index) {
        state.plan.splice(state.index, 1);
        state.plan.splice(li, 0, '@aside');
        saveState();
        continue;
      }
      return pauseForLimit({ limit: 'items_blocked', value: state.aside.length, step: null });
    }
    let step = stepDefs[id];
    if (id === 'revue' && state.reviewGroup != null) {
      const g = state.reviewGroup;
      const its = readItems();
      const root = its.find(i => i.n === g);
      ctx.reviewScope = { group: g, text: root?.text || '', cases: groupCases(its, g).map(i => i.n), fallback: false };
      step = { ...step, title: g === 0 ? '5 Revue (travail d’avant la montée en complet)' : `5 Revue de l’item ${g}` };
      // Events and records of this Review carry the item it reviews.
      state.item = ctx.item = { n: g, text: g === 0 ? 'travail d’avant la montée en complet' : root?.text || '' };
    } else ctx.reviewScope = null;
    // Defects accepted by the user (« accepter »): the Review is replaced by the acceptance.
    if (id === 'revue' && (state.acceptReview || []).includes(state.reviewGroup != null ? state.reviewGroup : 'global')) {
      const key = state.reviewGroup != null ? state.reviewGroup : 'global';
      acceptDefects(key, step);
      if (key !== 'global') {
        if (state.itemDelivery) {
          const c = deliverGroup(key);
          if (!c.ok) return pauseForLimit({ limit: 'item_commit', value: key, step: stepDefs.livrer, why: `le commit de ${groupLabel(key)} a échoué : ${String(c.err).split('\n')[0]}` });
        }
        state.reviewGroup = null; state.item = ctx.item = null; ctx.reviewScope = null;
      }
      state.index++; saveState(); continue;
    }
    // 4c sautée quand 4b a très peu changé (plan §2.3) : dit, jamais en silence.
    if (id === 'refactor' && (state.lastGreenLines ?? 0) < limits.refactorMinLines) {
      const why = `4b n'a changé que ${state.lastGreenLines ?? 0} ligne(s) (seuil ${limits.refactorMinLines})`;
      const key = `${String(state.steps.length + 1).padStart(2, '0')}-refactor`;
      state.steps.push({ id, key, title: step.title, ...(ctx.item ? { item: ctx.item.n } : {}), status: 'skipped', why, attempt: 1, durationMs: 0 });
      writeEvent({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: id, key, attempt: 1, ...(ctx.item ? { item: ctx.item.n } : {}) }, status: 'skipped', why, durationMs: 0, text: `étape ${step.title} : sautée — ${why}` });
      state.index++;
      saveState();
      continue;
    }
    // Un seul commit à la livraison : points d'étape du mode double, commits de
    // sa relecture… tout ce qui a été commité depuis le départ est replié.
    const delivering = step.id === 'livrer' || step.kind === 'deliver';
    // Per-item delivery: the items are already committed one by one; Livrer
    // only makes the release commit on top of the last delivered item.
    const foldBase = state.itemDelivery && step.id === 'livrer' ? (state.lastDelivered || base) : base;
    ctx.releaseBase = state.itemDelivery && step.id === 'livrer' ? foldBase : null;
    ctx.release = ctx.releaseBase ? { delivered: (state.delivered || []).filter(d => !d.released), aside: state.aside || [] } : null;
    // Where this release's version bump is measured from: the run's previous release, else its start.
    ctx.versionBase = ctx.releaseBase ? ((state.releases || []).at(-1)?.commit || base) : null;
    ctx.prebump = ctx.releaseBase ? bumpedInRun(cwd, cfg, ctx.versionBase, ctx.releaseBase) : null;
    if (state.itemDelivery && step.id === 'livrer' && !state.releasePending) {
      const why = (state.delivered || []).length ? 'tous les items livrés sont déjà dans une version' : 'aucun item livré';
      const key = `${String(state.steps.length + 1).padStart(2, '0')}-${id}`;
      state.steps.push({ id, key, title: step.title, status: 'skipped', why, attempt: 1, durationMs: 0 });
      writeEvent({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: id, key, attempt: 1 }, status: 'skipped', why, durationMs: 0, text: `étape ${step.title} : sautée — ${why}` });
      state.index++; saveState(); continue;
    }
    if (delivering && git(cwd, ['rev-parse', 'HEAD']).out !== foldBase) {
      git(cwd, ['reset', '--soft', foldBase]);
      state.checkpoints = 0; saveState();
    }
    // Livraison « seulement s'il y a quelque chose » (audit, maintenance…) : rien
    // n'a changé dans le projet → étape sautée, en le disant.
    if (delivering && step.ifChanged && !git(cwd, ['status', '--porcelain']).out.split('\n').some(l => l && !isLocalOnly(l.slice(3)))) {
      const why = 'aucune modification du projet : rien à livrer';
      const key = `${String(state.steps.length + 1).padStart(2, '0')}-${id}`;
      state.steps.push({ id, key, title: step.title, status: 'skipped', why, attempt: 1, durationMs: 0 });
      writeEvent({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: id, key, attempt: 1 }, status: 'skipped', why, durationMs: 0, text: `étape ${step.title} : sautée — ${why}` });
      state.index++;
      saveState();
      continue;
    }
    // Étape conditionnelle (Routage) : sautée selon la décision d'une étape
    // précédente, lue dans son artefact — en le disant.
    if (step.skipIf) {
      const j = parseJsonArtefact(readArtefact(ctx, step.skipIf.artefact) || '') || {};
      const allowed = [].concat(step.skipIf.unless);
      if (!allowed.includes(j[step.skipIf.field])) {
        const why = `${step.skipIf.field} = « ${j[step.skipIf.field] ?? '—'} » (étape utile seulement pour « ${allowed.join(' » ou « ')} »)`;
        const key = `${String(state.steps.length + 1).padStart(2, '0')}-${id}`;
        state.steps.push({ id, key, title: step.title, status: 'skipped', why, attempt: 1, durationMs: 0 });
        writeEvent({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: id, key, attempt: 1 }, status: 'skipped', why, durationMs: 0, text: `étape ${step.title} : sautée — ${why}` });
        state.index++; saveState(); continue;
      }
    }
    // Generics (phase 1): a named rule of the code decides (download in the
    // plan? document change large enough to be re-read?) — said, never silent.
    if (step.skipUnless && SKIP_RULES[step.skipUnless]) {
      const why = SKIP_RULES[step.skipUnless]({ ctx, state });
      if (why) {
        const key = `${String(state.steps.length + 1).padStart(2, '0')}-${id}`;
        state.steps.push({ id, key, title: step.title, status: 'skipped', why, attempt: 1, durationMs: 0 });
        writeEvent({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: id, key, attempt: 1 }, status: 'skipped', why, durationMs: 0, text: `étape ${step.title} : sautée — ${why}` });
        state.index++; saveState(); continue;
      }
    }
    // A step the PROGRAM may do itself (one named operation, one named
    // document): done → no model turn; null → the model's step runs as usual.
    if (step.codeFirst && CODE_STEPS[step.codeFirst]) {
      const key = `${String(state.steps.length + 1).padStart(2, '0')}-${id}`;
      const t0 = Date.now();
      let out = null;
      try { out = await CODE_STEPS[step.codeFirst]({ root, logsDir, ctx, state, artDir, projectName, dispatchScript, run, writeEvent }); }
      catch (e) { writeEvent({ type: 'system', subtype: 'pipeline_warning', pipeline: { run, step: id }, text: `${step.title} : le programme n’a pas pu faire l’étape (${e.message}) — confiée au model` }); }
      if (out?.ok === false) {
        record({ rec: { id, key, title: step.title, slot: null, model: out.model || null, source: 'code', status: 'refused', why: out.why, attempt: 1, durationMs: Date.now() - t0 } });
        return finish({ code: 1, isError: true, result: `✕ ${projectName} — ${step.title.replace(/^[A-Z]?\d+\s+/, '')} : ${out.why}. Rien n’a été modifié.` });
      }
      if (out?.done) {
        record({ rec: { id, key, title: step.title, slot: out.model ? step.chain[0] : null, model: out.model || null, ...(out.model ? { served: out.model } : {}), source: 'code', status: 'ok', why: null, attempt: 1, durationMs: Date.now() - t0 } });
        writeEvent({ type: 'system', subtype: 'pipeline_step_by_code', pipeline: { run, step: id, key }, text: `étape ${step.title} faite par le programme : ${out.why}` });
        state.index++; saveState(); continue;
      }
    }
    // The case of a step may depend on an earlier decision (the document's operation).
    if (step.chainFrom) {
      const v = (parseJsonArtefact(readArtefact(ctx, step.chainFrom.artefact) || '') || {})[step.chainFrom.field];
      if (typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v)) step = { ...step, chain: [`${step.chainFrom.prefix}${v}`, ...step.chain] };
    }
    // Rédaction « document »: a copy of each target before its first change
    // (the criterion compares to it; outside git it is the only way back).
    if (step.checks?.document === 'modification') {
      const v = Doc.checkTarget(cwd, readArtefact(ctx, 'cible.json'), { demande: readArtefact(ctx, 'demande.md') || '' });
      if (!v.ok) return finish({ code: 1, isError: true, result: `✕ ${projectName} — cible du document invalide : ${v.why}. Rien n’a été modifié.` });
      saveDocBase(ctx, v.value);
    }
    // Contexte du chef : la conversation récente, extraite de son log par le code.
    if (step.prerun === 'conversation') {
      fs.writeFileSync(path.join(artDir, 'conversation.md'), conversationExcerpt(projectLog, { fullDir: path.join(artDir, 'conversation') }));
      fs.writeFileSync(path.join(artDir, 'contexte.md'), routingContext(root, { logsDir, chefLog: projectLog, chefDir: cwd }));
    }
    // Étapes exécutées par le CODE (Routage : affecter, dispatcher) — aucun tour de model.
    if (step.kind === 'code') {
      const key = `${String(state.steps.length + 1).padStart(2, '0')}-${id}`;
      const t0 = Date.now();
      let out;
      try { out = await CODE_STEPS[step.handler]({ root, logsDir, ctx, state, artDir, projectName, dispatchScript, run, writeEvent }); }
      catch (e) { out = { ok: false, why: e.message }; }
      // A code step of the generics may pause the run (authorization, an
      // operation that failed: phase 1) — re-run from the same step on resume —
      // or end it with its own result (nothing runnable, said with a question).
      if (out?.pause) { saveState(); return pauseWith(out.pause); }
      if (out?.finish) {
        record({ rec: { id, key, title: step.title, slot: null, model: null, source: 'code', status: 'ok', why: null, attempt: 1, durationMs: Date.now() - t0 } });
        return finish({ code: 0, result: out.finish });
      }
      // A code step may call a model itself (« classer »: one classifier call per task).
      const rec = { id, key, title: step.title, slot: out.model ? step.chain[0] : null, model: out.model || null, ...(out.model ? { served: out.model } : {}), source: 'code', status: out.ok ? 'ok' : 'refused', why: out.ok ? null : out.why, attempt: 1, durationMs: Date.now() - t0 };
      record({ rec });
      if (!out.ok) return finish({ code: 1, isError: true, result: `✕ ${projectName} — étape « ${step.title} » : ${out.why}` });
      state.index++; saveState(); continue;
    }
    // Scanners lancés par l'orchestrateur lui-même : le model interprète une
    // sortie réelle, il ne peut pas inventer un scan.
    if (step.prerun === 'scans') {
      const out = runScanners(cwd, ctx.cfg, testEnv);
      fs.writeFileSync(path.join(artDir, 'scans-sortie.txt'), out.text);
      writeEvent({ type: 'system', subtype: 'pipeline_scans', pipeline: { run, step: id }, scanners: out.ran, text: `scanners lancés par l’orchestrateur : ${out.ran.length ? out.ran.map(s => `${s.name} (code ${s.code})`).join(', ') : 'aucun configuré'}` });
      await reportDefects(step, out.ran.filter(s => s.code !== 0).map(s => `scanner ${s.name} : code de sortie ${s.code}`), 'scan');
    }
    ctx.headAtStep = git(cwd, ['rev-parse', 'HEAD']).out;
    if (step.id === 'revue') {
      // Per-item Review: only the diff of this item's group, from the tree
      // taken when the group started (group 0 = the light work: from base).
      let itemDiff = null;
      if (ctx.reviewScope) {
        const g = ctx.reviewScope.group;
        const from = g === 0 ? git(cwd, ['rev-parse', `${base}^{tree}`]).out : state.groupTrees?.[g];
        const now = from ? worktreeTree(cwd, path.join(runDir, 'item-review.idx')) : null;
        itemDiff = from && now ? treeDiff(cwd, from, now) : null;
        if (itemDiff == null) ctx.reviewScope.fallback = true;
      }
      if (itemDiff != null) fs.writeFileSync(path.join(artDir, 'diff.patch'), `${itemDiff}\n`);
      else {
        const tracked = git(cwd, ['diff', base]).out;
        const untracked = git(cwd, ['ls-files', '-o', '--exclude-standard']).out.split('\n').filter(f => f && !isLocalOnly(f));
        const extraTxt = untracked.map(f => { let s = ''; try { s = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch {} return `--- /dev/null\n+++ b/${f}\n${s.split('\n').map(l => `+${l}`).join('\n')}`; }).join('\n');
        fs.writeFileSync(path.join(artDir, 'diff.patch'), `${tracked}\n${extraTxt}\n`);
      }
      try { fs.unlinkSync(path.join(artDir, 'revue.json')); } catch {}
    }
    // Livrer by the program (phase 0 b): decided per step, said when the
    // project keeps the model delivery (a version format the code cannot write).
    ctx.deliveryMode = null;
    if (delivering && ctx.tuning?.codeDeliver && isGit) {
      if (step.crit === 'livrer' || (step.id === 'livrer' && !step.kind && !step.checks)) {
        const p = releasePlan(cwd, cfg, { deliveryFixes: ctx.deliveryFixes, lane: ctx.lane });
        if (p.ok) ctx.deliveryMode = 'release';
        else writeEvent({ type: 'system', subtype: 'pipeline_code_deliver_skipped', pipeline: { run, step: id }, why: p.why, text: `livraison confiée au model, comme avant : ${p.why}` });
      } else if (step.kind === 'deliver' && !step.crit) ctx.deliveryMode = 'commit';
    }
    let maxAttempts = step.id === 'vert' ? limits.greenAttempts : limits.criteriaAttempts;
    // An honest "already covered" claim refused on form (missing proof, test not
    // rewritten after a refused try) is not a failure: it does not consume the
    // retry budget — once per step, so the loop stays bounded (0.57.2).
    let graceLeft = 1;
    let attempt = 0, last = null, retryWhy = null;
    let launchFails = 0;   // consecutive launch failures of this step (0.60.0)
    let freshSession = false, freshTried = false;   // provider refusal: one try in a new session (phase 0 a)
    for (;;) {
      attempt++;
      if (step.id !== 'revue') { try { fs.unlinkSync(path.join(artDir, step.artefact)); } catch {} }
      // Second avis indépendant : l'avis précédent est retiré du dossier pendant
      // l'étape (indépendance garantie par le code), puis remis.
      const hidden = (step.independent || []).filter(f => fs.existsSync(path.join(artDir, f)));
      for (const f of hidden) fs.renameSync(path.join(artDir, f), path.join(runDir, `hidden-${f}`));
      let r;
      try { r = await runStep(step, attempt, { retryWhy, freshSession }); }
      finally { for (const f of hidden) { try { fs.renameSync(path.join(runDir, `hidden-${f}`), path.join(artDir, f)); } catch {} } }
      record(r);
      // Infrastructure failure (phase 0 a): never a try of the step, never a defect.
      if (r.infra) {
        if (r.before && r.after) restoreFiles(cwd, r.before, r.after, step.judge ? null : (delivering ? foldBase : null));
        attempt--;
        if (r.infra.cause === 'refusal' && !freshTried) {
          freshTried = true; freshSession = true;
          writeEvent({ type: 'system', subtype: 'pipeline_retry_fresh_session', pipeline: { run, step: step.id, key: r.rec.key },
            text: `le fournisseur a refusé la demande (« ${String(r.infra.detail || '').slice(0, 160)} ») : nouvel essai dans une session neuve, comme il l’indique — essai non compté` });
          continue;
        }
        return holdForInfra(step, r.info, r.rec, r.infra);
      }
      freshSession = false;
      if (r.unavailable) return pauseForModel(step, r.info, r.rec.why);
      // Refused by dispatch.mjs (0.61.1): deterministic, the model was never
      // called — pause at once with the cause named, no back-off.
      if (r.launchRefused) return pauseForLaunchRefused(step, r.info, r.rec);
      // Launch failure (0.60.0): not a try of the step — back-off on the SAME
      // case, then pause with the user's choices once the tiers are spent.
      if (r.launchFailed) {
        if (r.before && r.after) restoreFiles(cwd, r.before, r.after, step.judge ? null : (delivering ? foldBase : null));
        attempt--;
        launchFails++;
        const tier = tierAfter(launchFails, BO);
        if (tier > BO.maxTiers) return pauseForLaunch(step, r.info, r.rec, launchFails);
        if (tier) await backoffWait(step, r.info, r.rec, tier, launchFails);
        continue;
      }
      launchFails = 0;
      last = r;
      if (r.rec.status === 'ok') break;
      // Un essai refusé n'est pas gardé : retour à l'état d'avant l'essai.
      if (!step.judge && r.before && r.after) restoreFiles(cwd, r.before, r.after, delivering ? foldBase : null);
      // Outside git restoreFiles never undoes anything: a document has its own copy (phase 1).
      if (step.checks?.document === 'modification' && r.before && r.after && isWalkSnapshot(r.before)) restoreDocAttempt(ctx, r.before, r.after);
      if (step.judge && r.before && r.after) restoreFiles(cwd, r.before, r.after, null);
      if (r.crit?.noRetry && delivering) git(cwd, ['reset', '-q']);
      retryWhy = r.rec.why;
      // A step criterion not met (red suite, protected test touched…) is a
      // detected problem: reported now, even if the next try fixes it.
      await reportDefects(step, [String(r.rec.why || '').split('\n')[0]], r.crit?.test && !r.crit.test.ok ? 'test' : 'critère');
      if (r.crit?.claimedCovered && graceLeft > 0) {
        graceLeft--;
        maxAttempts++;
        writeEvent({ type: 'system', subtype: 'pipeline_retry_not_counted', pipeline: { run, step: step.id, key: r.rec.key, attempt },
          text: `essai ${attempt} de « ${step.title} » non compté : « déjà couvert » déclaré, à compléter (${plainWhy(r.rec.why)})` });
      }
      // The program's own work refused (phase 0 b/3): a new try would repeat it identically.
      if (attempt >= maxAttempts || r.crit?.noRetry) {
        const limit = step.id === 'vert' ? 'green' : 'criteria';
        // An item's own step (4a/4b/4c, its Review) stops only that item.
        const g = ctx.reviewScope ? ctx.reviewScope.group : ctx.item && ['rouge', 'vert', 'refactor'].includes(step.id) ? groupOf(ctx.item) : step.id === 'vert' && state.fixGroup != null ? state.fixGroup : null;
        if (state.itemDelivery && g != null && setAside(g, limit, r.rec.why)) continue steps;
        return pauseForLimit({ limit, value: attempt, step, why: r.rec.why, lastOutput: r.crit?.test?.out });
      }
    }
    if (step.id === 'rouge' || step.crit === 'rouge') ctx.testPrint = testsNow();
    if (step.id === 'livrer' && state.itemDelivery) {
      // The release covers every item delivered since the previous one.
      state.releasePending = false;
      state.lastDelivered = headOf(cwd);
      state.releases = [...(state.releases || []), { commit: state.lastDelivered, version: last.crit?.version || null, items: (state.delivered || []).filter(d => !d.released).map(d => d.group) }];
      state.delivered = (state.delivered || []).map(d => ({ ...d, released: true }));
    }
    if (step.crit === 'vert') ctx.suiteRedAtStart = state.suiteRedAtStart = false;
    // n° 18: changes made in the chef's folder during the step, by someone
    // else most likely — kept as they are, and said.
    if (last.crit?.externalChanges?.length) {
      const files = last.crit.externalChanges;
      state.externalChanges = [...new Set([...(state.externalChanges || []), ...files])];
      writeEvent({ type: 'system', subtype: 'pipeline_external_change', pipeline: { run, step: step.id }, files,
        text: `fichiers du dossier modifiés pendant l’étape ${step.title}, conservés tels quels (pas annulés) : ${files.slice(0, 8).join(', ')}` });
    }
    // Rédaction « document »: the outputs the code accepted (what Relire and Livrer work on).
    if (step.checks?.document === 'modification' && ctx.docResult) { state.docOutputs = ctx.docResult.outputs || []; state.docAlready = !!ctx.docResult.already; }
    // Discussion in one call (lever 6): the answer asked for a research first —
    // the research step, then the answer again, once.
    if (pipeline === 'discussion' && step.checks?.researchMark && !state.discussionResearch && new RegExp(`^\\s*${RESEARCH_MARK}\\s*:`, 'm').test(readArtefact(ctx, step.artefact) || '')) {
      state.discussionResearch = true;
      state.plan.splice(state.index + 1, 0, 'rechercher', 'repondre');
      writeEvent({ type: 'system', subtype: 'pipeline_research_inserted', pipeline: { run, step: id }, text: 'la réponse demande une recherche : étape « Rechercher », puis la réponse de nouveau (une fois)' });
    }
    if (last.crit?.media?.length) { ctx.lastMedia = state.lastMedia = last.crit.media.map(f => f.path); state.media = [...new Set([...(state.media || []), ...ctx.lastMedia])]; }
    // Boucle déclarée (audit : re-vérifier → corriger tant qu'il reste des failles),
    // bornée par le budget des tours de revue — comme la revue du Développement.
    // Routage: since 0.69.0 a gap is raised only by the « classer » code step,
    // about one unit task — never about the whole message.
    // Security findings of the audit (manual review, independent second opinion):
    // every severity is a defect, reported at once (0.65.0).
    if (Array.isArray(last.crit?.json?.findings) && last.crit.json.findings.length) await reportDefects(step, last.crit.json.findings, 'faille');
    if (step.loop && Array.isArray(last.crit?.json?.[step.loop.field]) && last.crit.json[step.loop.field].length) {
      const left = last.crit.json[step.loop.field];
      const leftTxt = left.slice(0, 5).map(x => (typeof x === 'string' ? x : x.issue || JSON.stringify(x))).join(' ; ');
      state.lastDefects = { ...(state.lastDefects || {}), global: left.map(x => (typeof x === 'string' ? x : x.issue || JSON.stringify(x))) };
      await reportDefects(step, left, 'restant');
      if ((state.acceptReview || []).includes('global')) {
        // « accepter » after the pause: the user takes the remaining points as they are.
        acceptDefects('global', step);
      } else {
      if (state.reviewRounds >= (state.budgets?.review || limits.reviewRounds)) {
        return pauseForLimit({ limit: 'review', value: state.reviewRounds, step, why: `la revue relève encore : ${leftTxt}` });
      }
      state.reviewRounds++;
      state.plan.splice(state.index + 1, 0, ...step.loop.back);
      writeEvent({ type: 'system', subtype: 'pipeline_loop', pipeline: { run, from: id, to: step.loop.back[0], round: state.reviewRounds },
        text: `${step.title} : ${left.length} point(s) restant(s) → retour à « ${stepDefs[step.loop.back[0]].title} » (tour ${state.reviewRounds}/${limits.reviewRounds})` });
      }
    }
    if (step.id === 'rouge' && last.crit?.covered) {
      // Q10 (A) : item déjà couvert — 4b et 4c de CET item sont sautées, en le disant.
      const why = `item déjà couvert par le code existant (DEJA_COUVERT déclaré ; seuls des tests ont changé, suite verte)`;
      for (const sid of ['vert', 'refactor']) {
        if (state.plan[state.index + 1] !== sid) continue;
        state.plan.splice(state.index + 1, 1);
        const key = `${String(state.steps.length + 1).padStart(2, '0')}-${sid}`;
        state.steps.push({ id: sid, key, title: stepDefs[sid].title, item: ctx.item?.n, status: 'skipped', why, attempt: 1, durationMs: 0 });
        writeEvent({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: sid, key, attempt: 1, ...(ctx.item ? { item: ctx.item.n } : {}) }, status: 'skipped', why, durationMs: 0, text: `étape ${stepDefs[sid].title} : sautée — ${why}` });
      }
      // Light mode has no item: the request itself is what is already covered.
      const coveredText = ctx.item?.text || String(state.request || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const proof = last.crit.proof || [];
      state.coveredItems = ctx.coveredItems = [...(state.coveredItems || []), { n: ctx.item?.n ?? null, text: coveredText, proof }];
      const proofTxt = proof.length ? `(preuve : ${proofText(proof)})` : '';
      writeEvent({ type: 'system', subtype: 'pipeline_item_covered', pipeline: { run, item: ctx.item?.n ?? null }, proof,
        text: ctx.item
          ? `↺ item ${ctx.item.n} déjà couvert : test gardé comme documentation, sans 4b ni 4c — la Revue le jugera ${proofTxt}`.trim()
          : `↺ comportement déjà présent dans le code : test gardé comme documentation, sans 4b — la Revue le jugera ${proofTxt}`.trim() });
    }
    if (step.id === 'liste-tests' && (last.crit?.items || []).filter(i => !i.done).length > (state.budgets?.items || limits.items)) {
      return pauseForLimit({ limit: 'items', value: limits.items, step, why: `${last.crit.items.filter(i => !i.done).length} items listés (maximum ${limits.items}) — découper la demande en plusieurs exécutions` });
    }
    if (step.id === 'vert') {
      const codeFiles = (last.rec.changed || []).filter(f => !isTestFile(f, cfg.testGlobs));
      state.lastGreenLines = lineDelta(cwd, last.before, last.after, codeFiles);
      const afterReview = !!ctx.reviewItems;
      if (ctx.reviewItems) { ctx.reviewItems = null; state.reviewItems = null; }
      // Correction of an item's doc findings (0.65.0): the item is reviewed
      // again once none of its cases is open, and only then delivered.
      if (afterReview && state.fixGroup != null) {
        const g = state.fixGroup;
        state.fixGroup = null;
        if (state.itemReview && groupReady(readItems(), g)) { state.plan.splice(state.index + 1, 0, 'revue'); state.reviewGroup = g; }
      }
      // Garde-fou du léger (plan §4) : au-delà du périmètre, montée en complet
      // à l'étape 3 — annoncée, jamais en silence.
      if (state.mode === 'leger' && !afterReview && !state.escalated) {
        const scope = lightScope(cwd, base, cfg);
        if (scope.over) {
          state.mode = ctx.mode = 'complet';
          state.escalated = ctx.escalated = true;
          stepDefs = devCatalog({ mode: 'complet', kind });
          state.plan.splice(state.index + 1, 0, 'liste-tests', '@loop');
          // Per-item Review from here on: the light Review planned after the
          // loop goes, the light work is reviewed on its own (group 0) first.
          const lightReview = state.plan.indexOf('revue', state.index + 3);
          if (lightReview >= 0) state.plan.splice(lightReview, 1);
          state.itemReview = true;
          state.pendingGroupReview = 0;
          Object.assign(state, { itemDelivery: true, lastDelivered: state.lastDelivered || base, delivered: state.delivered || [], aside: state.aside || [] });
          state.plan.splice(state.plan.lastIndexOf('livrer'), 0, '@aside');
          writeEvent({ type: 'system', subtype: 'pipeline_escalate', pipeline: { run, from: 'leger', to: 'complet' }, scope,
            text: `⇧ périmètre dépassé (${scope.why}) : l'exécution monte en Développement complet — liste de tests, puis un test à la fois, chaque item relu juste après sa boucle` });
        }
      }
    }
    // 0.65.0: no more « non-testable findings go to Livrer without blocking »
    // — every finding is reported now and fixed before any delivery.
    if (step.id === 'revue' && last.crit?.review?.verdict === 'problemes') {
      await reportDefects(step, last.crit.review.items, 'revue');
      await reportDefects(step, last.crit.review.delivery, 'doc');
    }
    if (step.id === 'revue' && ctx.reviewScope) {
      // Per-item Review (« c+d », part c): a defect becomes a case attached to
      // THIS item, the rounds are counted for THIS item, the others go on.
      const g = ctx.reviewScope.group;
      const label = g === 0 ? 'le travail d’avant la montée en complet' : `l’item ${g}`;
      const problems = last.crit?.review?.verdict === 'problemes';
      const defects = problems ? last.crit.review.items : [];
      // Non-testable findings (doc, registry…) block too (0.65.0): a correction
      // step fixes them, then the item is reviewed again before any delivery.
      const fixes = problems ? last.crit.review.delivery || [] : [];
      const rounds = state.itemReviewRounds?.[g] || 0;
      const budget = state.itemReviewBudgets?.[g] || limits.reviewRounds;
      if (defects.length || fixes.length) {
        state.lastDefects = { ...(state.lastDefects || {}), [g]: [...defects, ...fixes] };
        if (rounds >= budget) {
          const why = `la revue de ${label}${g ? ` (« ${ctx.reviewScope.text} »)` : ''} relève encore : ${[...defects, ...fixes].slice(0, 5).join(' ; ')}`;
          if (state.itemDelivery && setAside(g, 'review', why)) continue;
          return pauseForLimit({ limit: 'review', value: rounds, step, why });
        }
        state.itemReviewRounds = { ...(state.itemReviewRounds || {}), [g]: rounds + 1 };
        if (defects.length) fs.writeFileSync(path.join(artDir, 'tests.md'), insertAttachedCases(readArtefact(ctx, 'tests.md') || '', g, defects));
        if (fixes.length) {
          ctx.reviewItems = state.reviewItems = fixes;
          state.fixGroup = g;
          ctx.testPrint = testsNow();
          state.plan.splice(state.index + 1, 0, 'vert');
        }
        writeEvent({ type: 'system', subtype: 'pipeline_loop', pipeline: { run, from: 'revue', to: defects.length ? 'tdd' : 'vert', item: g, round: rounds + 1 },
          text: `revue de ${label} : ${[defects.length && `${defects.length} problème(s) → case(s) rattachée(s) à cet item seulement`, fixes.length && `${fixes.length} constat(s) de documentation → correction avant toute livraison`].filter(Boolean).join(' ; ')} (tour de revue ${rounds + 1}/${budget} de cet item)` });
      } else {
        writeEvent({ type: 'system', subtype: 'pipeline_item_reviewed', pipeline: { run, item: g }, text: `✓ revue de ${label} : rien à corriger` });
        // Per-item delivery: validated by its own Review → its own commit, now.
        if (state.itemDelivery) {
          const c = deliverGroup(g);
          if (!c.ok) return pauseForLimit({ limit: 'item_commit', value: g, step: stepDefs.livrer, why: `le commit de ${label} a échoué : ${String(c.err).split('\n')[0]}` });
        }
      }
      state.reviewGroup = null;
      state.item = ctx.item = null;
      ctx.reviewScope = null;
    } else if (step.id === 'revue' && last.crit?.review?.verdict === 'problemes') {
      const items = last.crit.review.items, fixes = last.crit.review.delivery || [];
      state.lastDefects = { ...(state.lastDefects || {}), global: [...items, ...fixes] };
      if (state.reviewRounds >= (state.budgets?.review || limits.reviewRounds)) {
        return pauseForLimit({ limit: 'review', value: state.reviewRounds, step, why: `la revue relève encore : ${[...items, ...fixes].slice(0, 5).join(' ; ')}` });
      }
      state.reviewRounds++;
      ctx.testPrint = testsNow();   // tests existants protégés ; en ajouter reste permis
      if (state.mode === 'complet') {
        // Complet : chaque problème devient un item de la liste, puis retour à 4 ;
        // un constat de doc passe par une correction (0.65.0), jamais par Livrer.
        if (items.length) {
          const md = (readArtefact(ctx, 'tests.md') || '').replace(/\s*$/, '\n');
          fs.writeFileSync(path.join(artDir, 'tests.md'), md + items.map(i => `- [ ] (revue) ${String(i).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') + '\n');
        }
        if (fixes.length) ctx.reviewItems = state.reviewItems = fixes;
        state.plan.splice(state.index + 1, 0, ...(fixes.length ? ['vert'] : []), ...(items.length ? ['@loop'] : []), 'revue');
      } else {
        ctx.reviewItems = state.reviewItems = [...items, ...fixes];
        state.plan.splice(state.index + 1, 0, 'vert', 'revue');
      }
      const to = state.mode === 'complet' && items.length ? '4 (nouveaux items)' : '4b';
      writeEvent({ type: 'system', subtype: 'pipeline_loop', pipeline: { run, from: 'revue', to: state.mode === 'complet' && items.length ? 'tdd' : 'vert', round: state.reviewRounds },
        text: `revue : ${items.length + fixes.length} problème(s)${fixes.length ? ` dont ${fixes.length} constat(s) de documentation` : ''} → retour à ${to} (tour de revue ${state.reviewRounds}/${limits.reviewRounds})` });
    }
    // A step that lists questions for the user (meeting: files in doubt) pauses
    // right after it, once: « continuer » resumes at the next step.
    if (step.askUser && !state.askedUser?.[step.id]) {
      const asked = Array.isArray(last.crit?.json?.[step.askUser]) ? last.crit.json[step.askUser] : [];
      if (asked.length) {
        state.askedUser = { ...(state.askedUser || {}), [step.id]: true };
        state.index++;
        saveState();
        return pauseForDoubts(step, asked, last.crit.json);
      }
    }
    state.index++;
    saveState();
  }

  // ── Fin : la réponse (Discussion) ou la livraison (Développement) ────────
  function catalogResult() {
    const label = pipelineLabel(pipeline, state.mode);
    // `final` may depend on the mode (meeting internal route, 0.111.0): one
    // step, or several whose answers are put one after the other.
    const finalIds = [].concat(catalog.final && typeof catalog.final === 'object' && !Array.isArray(catalog.final) ? catalog.final[state.mode] || [] : catalog.final || []);
    const finalBody = (finalStep) => {
      let body = '';
      const raw = (readArtefact(ctx, finalStep.artefact) || '').trim();
      const j = finalStep.checks?.json ? parseJsonArtefact(raw) : null;
      if (j && typeof j.final === 'string') body = j.final.trim();
      else if (j && Array.isArray(j.remaining)) {
        const fmt = (x) => (typeof x === 'string' ? x : `${x.severity ? `[${x.severity}] ` : ''}${x.file ? `${x.file} : ` : ''}${x.issue || JSON.stringify(x)}`);
        body = `**Failles restantes** : ${j.remaining.length ? `\n${j.remaining.map(x => `- ${fmt(x)}`).join('\n')}` : 'aucune, quelle que soit la gravité.'}` +
          (Array.isArray(j.verified) && j.verified.length ? `\n\n**Corrigées et vérifiées** :\n${j.verified.map(x => `- ${fmt(x)}`).join('\n')}` : '');
      } else if (j && typeof j.verdict === 'string') {
        body = `**Vérification** : ${j.verdict === 'ok' ? '✓ conforme' : 'défauts relevés'}${Array.isArray(j.items) && j.items.length ? `\n${j.items.map(x => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n')}` : ''}`;
      } else body = raw;
      return body;
    };
    const finals = finalIds.map(id => stepDefs[id]).filter(Boolean);
    let body = finals.map(s => [s, finalBody(s)]).filter(([, b]) => b)
      .map(([s, b]) => (finals.length > 1 ? `**${s.title.replace(/^R?\d+[a-z]?\s+/, '')}** :\n\n${b}` : b)).join('\n\n');
    if (state.route) body = `**Routage interne** : ${catalog.route?.labels?.[state.route.id] || state.route.id}${state.route.why ? ` — ${state.route.why}` : ''}\n\n${body}`;
    if (catalog.media && state.media?.length) body = `**Fichiers produits (vérifiés par l'orchestrateur)** :\n${state.media.map(f => `- \`${f}\``).join('\n')}\n\n${body}`;
    // Recherche : lecture seule, la synthèse EST la réponse.
    if (pipeline === 'recherche') return body || '(synthèse vide)';
    // Routage : le rapport EST la réponse du chef ; une demande ambiguë finit
    // par la question à l'utilisateur (règle : ne jamais deviner).
    if (pipeline === 'routage') {
      // 0.92.0 (task 4/4): every id the model wrote is checked against the
      // registries before the report leaves (request and wake-up modes).
      const chk = checkReportIds(body, { logsDir });
      if (chk.findings.length) {
        body = chk.text;
        const bad = chk.findings.filter(f => f.kind !== 'titled');
        writeEvent({ type: 'system', subtype: 'report_check', pipeline: { run }, findings: chk.findings,
          text: `🔎 contrôle des identifiants du rapport : ${chk.findings.length - bad.length} complété(s) par leur titre${bad.length ? `, ${bad.length} point(s) signalé(s)` : ''}` });
      }
      // Questions come from the global meaning (ambiguous message), the split
      // (impossible to split) or the per-task classification (0.69.0).
      const sens = parseJsonArtefact(readArtefact(ctx, 'sens.json') || '') || {};
      const cls = parseJsonArtefact(readArtefact(ctx, 'classement.json') || '') || {};
      const qs = [
        sens.nature === 'question' && String(sens.question || '').trim(),
        // Runs started before 0.69.0 kept the nature in classement.json.
        cls.nature === 'question' && String(cls.question || '').trim(),
        ...(Array.isArray(cls.questions) ? cls.questions : []),
      ].filter(Boolean).map(q => String(q).replace(/\s+/g, ' ').trim());
      const q = qs.length > 1 ? qs.map((x, i) => `(${i + 1}) ${x}`).join(' ') : qs[0];
      // The chef's own actions are stated by the code, whatever the report says.
      const disp = parseJsonArtefact(readArtefact(ctx, 'dispatch.json') || '') || {};
      const acts = Array.isArray(disp.actions) && disp.actions.length
        ? `\n\n**Actions du chef (exécutées par l’orchestrateur)** :\n${disp.actions.map(a => `- ${a.action}${a.projet ? ` ${a.projet}` : ''} : ${{ done: 'faite', scheduled: 'programmée après la fin de ce tour', failed: `échec (code ${a.code})`, refused: `refusée — ${a.why}` }[a.status] || a.status}`).join('\n')}`
        : '';
      // Hand-off to the chef (0.88.0), stated by the code.
      const handTxt = disp.handoff
        ? `\n\n**Renvoyé au chef, qui agit lui-même** (${disp.handoff.status === 'scheduled' ? 'son tour part dès la fin de celui-ci' : `non lancé : ${disp.handoff.why || '?'}`}) :\n${(disp.handoff.tasks || []).map(t => `- tâche ${t.n} « ${t.titre} » — ${t.raison || ''}`).join('\n')}`
        : '';
      // Waiting tasks are named by the code (0.87.0): never a bare id.
      const waitTxt = Array.isArray(disp.waiting) && disp.waiting.length
        ? `\n\n**Tâches mises en attente (identifiant « titre »)** :\n${disp.waiting.map(w => `- ${w.id || '?'} « ${w.titre || '?'} » — ${w.projet}, après ${w.after || '?'}`).join('\n')}`
        : '';
      const hors = (state.tasks || []).filter(t => t.horsPipeline && t.route);
      const horsTxt = hors.length ? `\n\n**Tâches lancées hors pipeline, sur votre autorisation** : ${hors.map(t => `tâche ${t.n} (${t.projet}) — « ${t.autorisation} » — ${t.horsPipeline}`).join(' ; ')}` : '';
      const ext = (state.externalChanges || []).length
        ? `\n\n**Fichiers du dossier du chef modifiés pendant cette exécution** (par vous ou un musicien, conservés, rien n’a été annulé) : ${state.externalChanges.slice(0, 12).map(f => `\`${f}\``).join(', ')}`
        : '';
      return `${body || '(rapport vide)'}${acts}${handTxt}${waitTxt}${horsTxt}${ext}${q && !/NEEDS_USER_INPUT:/.test(body) ? `\n\nNEEDS_USER_INPUT: ${q}` : ''}`;
    }
    const head = git(cwd, ['rev-parse', 'HEAD']).out;
    const delivered = head && head !== base ? git(cwd, ['log', '-1', '--format=%h %s']).out : null;
    const skipped = state.steps.filter(s => s.status === 'skipped');
    return `✓ ${projectName} — pipeline ${label} terminé (${run}).\n\n` +
      `- Étapes : ${state.steps.filter(s => s.status === 'ok').map(s => `${s.title.replace(/^\d+[a-z]?\s+/, '')} (${s.model || (s.source === 'code' ? 'programme' : 'défaut')})`).join(' → ')}\n` +
      (skipped.length ? `- Sautées : ${skipped.map(s => `${s.title.replace(/^\d+[a-z]?\s+/, '')} — ${s.why}`).join(' ; ')}\n` : '') +
      `- ${delivered ? `Commit : ${delivered}` : 'Aucun commit (rien à livrer)'} ; pas de push (soumis à autorisation).\n` +
      `- Critères vérifiés par l'orchestrateur à chaque étape (artefacts, lecture seule, suite verte, livraison).\n` +
      (body ? `\n${body.slice(0, 8000)}` : (readArtefact(ctx, 'livraison.md') || '').trim().slice(0, 4000) ? `\n${(readArtefact(ctx, 'livraison.md') || '').trim().slice(0, 4000)}` : '');
  }
  let result;
  if (pipeline === 'discussion' && state.mode === 'verification') {
    result = verificationMarkdown(parseJsonArtefact(readArtefact(ctx, 'verification.json') || '') || {});
  } else if (pipeline === 'discussion') {
    result = (readArtefact(ctx, 'reponse.md') || '').trim() || '(réponse vide)';
  } else if (catalog) {
    result = catalogResult();
  } else {
    const head = git(cwd, ['log', '-1', '--format=%h %s']).out;
    result = `✓ ${projectName} — pipeline ${pipelineLabel(pipeline, state.mode)} terminé (${run}).\n\n` +
      `- Commit : ${head}\n` +
      `- Étapes : ${state.steps.filter(s => s.status === 'ok').map(s => `${s.title.split(' ')[0]} ${s.model || 'défaut'}`).join(' → ')}\n` +
      (state.mode === 'complet' ? `- TDD : ${state.itemsDone || 0} item(s) de la liste de tests, un à la fois (4a → 4b → 4c)\n` : '') +
      ((state.delivered || []).length ? `- Livraison par item : ${state.delivered.map(d => `${d.group === 0 ? 'travail d’avant la montée en complet' : `item ${d.group}`} → ${d.commit.slice(0, 7)}`).join(' ; ')}, puis la version (${(state.releases || []).map(r => `${r.version || '?'} ${r.commit.slice(0, 7)}`).join(', ')})\n` : '') +
      discardedText(state, '- ') +
      (state.escalated ? '- ⇧ Monté de léger en complet : la demande dépassait le périmètre du mode léger\n' : '') +
      ((state.coveredItems || []).length ? `- ↺ Déjà assuré par le code existant (test ajouté comme documentation, sans nouveau code) : ${state.coveredItems.map(coveredLabel).join(' ; ')}\n` : '') +
      `- Critères vérifiés par l'orchestrateur : test rouge puis vert, tests inchangés en 4b, revue, ${ctx.lane ? `fragment ${ctx.lane.fragment}` : 'version, CHANGELOG'}${cfg.requirements ? ', exigence' : ''}, suite verte\n` +
      (ctx.lane ? `- Couloir ${ctx.lane.k} (branche ${ctx.lane.branch}) : l’orchestrateur intègre la branche dans ${ctx.lane.integration || 'la branche d’intégration'} à la fin de ce tour et attribue la version\n` : '') +
      `- Pas de push (soumis à autorisation).\n\n${(readArtefact(ctx, 'livraison.md') || '').trim().slice(0, 4000)}`;
  }
  return finish({ code: 0, result });
}

/**
 * Réponse de l'utilisateur à une exécution EN PAUSE, autre que « continuer »
 * (retour du 2026-10-09 : chaque choix proposé doit vraiment faire quelque chose) :
 *   abandonner / simplifier → l'exécution est close (rien n'est livré), les
 *     modifications restent dans le projet et sont listées ;
 *   changer le model → reste en pause, dit quelle case changer, attend « continuer ».
 * Un tour côté musicien : user_prompt + result. Renvoie le code de sortie.
 */
export async function answerPausedRun({ logsDir, project, projectName, run, answer, promptForLog, sourceProject, callbackProject, testLabel, logFile = null, cwd = null, eventTag = null, chefDecision = null, chefCallback = null }) {
  const f = path.join(logsDir, 'runs', run, 'run.json');
  const state = readJson(f);
  if (!state || state.status !== 'paused' || state.project !== projectName) { console.error(`[pipeline] aucune exécution en pause ${run} pour ${projectName}`); return 65; }
  const hadCallback = state.callback || null;
  const callbackTo = runCallback(state, { callbackProject, chefCallback });
  // P9: the run's lane (log, worktree) when it works in one.
  const projectLog = logFile || path.join(logsDir, `${projectName}.jsonl`);
  const workDir = cwd || project.path;
  const writeEvent = (ev) => { try { fs.appendFileSync(projectLog, JSON.stringify({ ...(process.env.ORCH_TURN_ID ? { orch_turn: process.env.ORCH_TURN_ID } : {}), ...eventTagOf({ eventTag }, ev), ...ev, timestamp: new Date().toISOString() }) + '\n'); } catch {} };
  writeEvent({ type: 'user_prompt', text: promptForLog, pipeline: { run, pipeline: state.pipeline, mode: state.mode, answer },
    ...(sourceProject ? { source: sourceProject } : {}), ...(callbackTo ? { callback: callbackTo } : {}), ...(testLabel ? { test: { label: testLabel } } : {}) });
  const save = () => { state.updatedAt = new Date().toISOString(); writeFileAtomic(f, JSON.stringify(state, null, 2)); };
  if (callbackTo !== hadCallback) save();
  // 0.133.0: the answer is remembered with the pause's signature; the chef's decision is traced.
  if (state.lastPause) {
    const by = chefDecision ? 'chef' : 'utilisateur';
    state.pauseAnswers = [...(state.pauseAnswers || []), { n: state.lastPause.n, limit: state.lastPause.limit, sig: state.lastPause.sig, key: answer, by, at: new Date().toISOString() }].slice(-200);
    if (state.chefPause?.status === 'pending') state.chefPause = { ...state.chefPause, status: chefDecision ? 'decided' : 'answered-by-user', key: answer, answeredAt: new Date().toISOString() };
    if (chefDecision) writeEvent({ type: 'system', subtype: 'pipeline_chef_decision', pipeline: { run }, n: state.lastPause.n, limit: state.lastPause.limit, key: answer, reason: chefDecision.reason, text: decisionText({ key: answer, reason: chefDecision.reason }) });
    state.lastPause = null;
    save();
  }
  const whose = chefDecision ? 'par décision du chef' : 'à votre demande';
  let text, paused = false;
  if (answer === 'tester le model') {
    // 0.60.0: a short trial of the step's model, with its full log; still paused.
    const last = [...(state.steps || [])].reverse().find(s => s.slot && s.model) || {};
    const root = path.dirname(logsDir);
    const t = await runModelTest({ root, provider: last.provider, model: last.model, label: `${projectName} ${run} (réponse « tester le model »)` });
    const rel = path.relative(root, t.logFile).split(path.sep).join('/');
    writeEvent({ type: 'system', subtype: 'pipeline_model_test', pipeline: { run, slot: last.slot }, model: last.model, status: t.ok ? 'ok' : 'failed',
      ok: t.ok, why: t.why, served: t.served, ms: t.ms, logFile: rel, logName: t.logName, text: `🔬 test du model ${last.model} : ${t.ok ? 'il répond' : `échec — ${t.why}`} (journal : ${rel})` });
    // The test result is the proof the smart menu needs (0.122.0): a failed
    // test makes « changer le model » available, a passing one points to a
    // transient cause.
    state.lastModelTest = { model: last.model || null, ok: !!t.ok, why: t.why || null, at: new Date().toISOString(), log: rel };
    const d = t.ok
      ? diagnosePause({ known: { kind: 'provider_transient', cause: `Le model ${last.model || ''} répond au test : son indisponibilité était passagère.` } })
      : diagnosePause({ known: { kind: 'launch', cause: `Le model ${last.model || ''} échoue au test (${String(t.why || '').slice(0, 200)}) : c’est lui qui est en cause.`, proof: { kind: 'model-test', text: `test du model en échec : ${String(t.why || '').slice(0, 160)}` } } });
    const menu = fixMenu(d, smartMenu(d, { step: { id: last.id, label: plainStep(last.id) }, slot: last.slot, model: last.model, delivered: (state.delivered || []).length }));
    if (!t.ok) menu.recommend = { key: 'changer le model', why: 'le test prouve que ce model ne répond pas : un nouvel essai avec lui échouerait encore.' };
    state.diagnosis = { ...(state.diagnosis || {}), at: new Date().toISOString(), kind: d.kind, transient: d.transient, cause: d.cause, source: 'code', ...(d.proof ? { proof: d.proof } : {}), options: menu.options, recommend: menu.recommend };
    save();
    const b = menuBlock(d, menu);
    text = `🔬 Test de ${last.model || 'le model'} (case « ${last.slot || '?'} ») : ${t.ok ? `**il répond** (${Math.round(t.ms / 1000)} s). L’indisponibilité était passagère.` : `**échec** — ${t.why}.`}\n\nJournal complet (commande, code de sortie, messages d’erreur) : \`${rel}\`.\n\n`
      + `${b.cause}\n\n${b.choices}\n\n${b.recommend}\n\nNEEDS_USER_INPUT: ${menuQuestion(projectName, d, menu)}`;
    paused = true;
  } else if (answer === 'changer le model') {
    const last = [...(state.steps || [])].reverse().find(s => s.slot) || {};
    text = `D’accord. Ouvrez la page Models et choisissez un autre model pour l’étape « ${plainStep(last.id)} »${last.slot ? ` (case « ${last.slot} »${last.model ? `, actuellement ${last.model}` : ''})` : ''}. Le changement est pris en compte tout de suite, sans redémarrage.\n\nNEEDS_USER_INPUT: ${projectName} attend toujours : une fois le model changé dans la page Models, répondez « continuer » pour reprendre là où je me suis arrêté.`;
    paused = true;
  } else {
    const changed = git(workDir, ['status', '--porcelain']).out.split('\n').filter(l => l && !isLocalOnly(l.slice(3))).map(l => l.slice(3));
    // A folder outside git (the chef's): nothing can be said about leftovers.
    const inGit = git(workDir, ['rev-parse', '--is-inside-work-tree']).out === 'true';
    state.status = 'abandoned'; state.abandonedBy = answer; state.endedAt = new Date().toISOString();
    save();
    writeEvent({ type: 'system', subtype: 'pipeline_summary', pipeline: { run, pipeline: state.pipeline, mode: state.mode, status: 'abandoned' },
      text: `exécution ${run} arrêtée ${chefDecision ? 'par décision du chef' : 'à la demande de l’utilisateur'} (« ${answer} ») — ${(state.delivered || []).length ? `${state.delivered.length} item(s) déjà livré(s), le reste non livré` : 'rien n’est livré'}` });
    const ds = state.delivered || [], as = state.aside || [];
    const sugg = chefDecision && state.chefPause?.suggestions?.length ? `**Demandes séparées suggérées** (une par item bloqué, à envoyer ensuite) :\n${state.chefPause.suggestions.map(s => `- ${s}`).join('\n')}\n\n` : '';
    text = (chefDecision ? `${decisionText({ key: answer, reason: chefDecision.reason })}\n\n` : '') + (ds.length
      ? `■ Exécution arrêtée ${whose} (« ${answer} »). Les items déjà livrés restent dans leurs commits : ${ds.map(d => `${d.group === 0 ? 'travail d’avant la montée en complet' : `item ${d.group}`} (${d.commit.slice(0, 7)})`).join(' ; ')}. Le reste n’est pas livré.\n\n`
      : `■ Exécution arrêtée ${whose} (« ${answer} »). Rien n’est livré, aucun commit n’a été fait.\n\n`) + sugg +
      (as.length ? `Items mis de côté, non livrés — leurs modifications sont gardées hors du projet (à réappliquer avec « git apply » si vous voulez les reprendre) :\n${as.map(a => `- ${a.group === 0 ? 'travail d’avant la montée en complet' : `item ${a.group}`} : \`${a.patch}\` (${(a.files || []).slice(0, 10).join(', ')})${a.conflict ? ' — ne s’applique plus sur le travail livré depuis' : ''}`).join('\n')}\n\n` : '') +
      (discardedText(state) ? `${discardedText(state)}\n` : '') +
      (state.lane?.k >= 1
        // P9: the lane is freed; its work is committed on the task branch, never integrated.
        ? (changed.length
          ? `Cette exécution travaillait dans le couloir ${state.lane.k} (copie isolée) : rien n’est intégré au projet. Les modifications déjà faites sont gardées sur la branche ${state.lane.branch} (et leurs différences archivées sous logs/lanes/) :\n${changed.slice(0, 30).map(c => `- ${c}`).join('\n')}${changed.length > 30 ? `\n- … et ${changed.length - 30} autre(s)` : ''}`
          : `Cette exécution travaillait dans le couloir ${state.lane.k} (copie isolée) : rien n’est intégré au projet, aucune modification n’y était restée.`)
        : changed.length
        ? `Les modifications déjà faites restent dans le projet, non enregistrées dans git (vous pouvez les examiner, les garder ou les annuler) :\n${changed.slice(0, 30).map(c => `- ${c}`).join('\n')}${changed.length > 30 ? `\n- … et ${changed.length - 30} autre(s)` : ''}`
        : inGit ? 'Aucune modification n’est restée dans le projet.' : 'Le dossier du projet n’est pas suivi par git : cet arrêt n’y a rien annulé ni modifié.') +
      (answer === 'simplifier' ? '\n\nEnvoyez-moi maintenant une demande plus petite pour la suite : elle partira dans une nouvelle exécution.' : '');
  }
  text = await localize(path.dirname(logsDir), text, languageFor(path.dirname(logsDir), projectName));
  // Toujours un message : l'état du musicien se lit sur le dernier texte du tour
  // (sans lui, l'ancienne question restait affichée après « abandonner »).
  writeEvent({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] } });
  writeEvent({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: 'end_turn',
    pipeline: { run, pipeline: state.pipeline, status: state.status, answer }, ...(paused ? { pipeline_paused: true } : {}), result: text });
  console.log(`[pipeline] exécution ${run} : réponse « ${answer} » — ${state.status}`);
  return paused ? 2 : 0;
}

/**
 * 0.133.0: the chef's answer to a process pause could not be applied (outside
 * the options offered, or handed back with NEEDS_USER_INPUT): the pause goes to
 * the user, with its full menu — never guessed. The run stays paused.
 */
export async function handChefPauseToUser({ logsDir, projectName, run, why, promptForLog, sourceProject = null, logFile = null, eventTag = null }) {
  const f = path.join(logsDir, 'runs', run, 'run.json');
  const state = readJson(f);
  if (!state || state.status !== 'paused' || state.project !== projectName || state.chefPause?.status !== 'pending') { console.error(`[pipeline] aucune pause de processus en attente du chef pour ${run}`); return 65; }
  const projectLog = logFile || path.join(logsDir, `${projectName}.jsonl`);
  const writeEvent = (ev) => { try { fs.appendFileSync(projectLog, JSON.stringify({ ...(process.env.ORCH_TURN_ID ? { orch_turn: process.env.ORCH_TURN_ID } : {}), ...eventTagOf({ eventTag }, ev), ...ev, timestamp: new Date().toISOString() }) + '\n'); } catch {} };
  writeEvent({ type: 'user_prompt', text: promptForLog, pipeline: { run, pipeline: state.pipeline, mode: state.mode, answer: 'chef-vers-utilisateur' }, ...(sourceProject ? { source: sourceProject } : {}) });
  state.chefPause = { ...state.chefPause, status: 'to-user', why: String(why || '').slice(0, 600), handedAt: new Date().toISOString() };
  state.question = state.chefPause.userQuestion || state.question;
  // The pause is now the user's: an answer of theirs is not an answer of the chef.
  state.lastPause = state.lastPause || { n: state.chefPause.n, limit: state.chefPause.limit, sig: state.chefPause.sig, to: 'user', why };
  state.updatedAt = new Date().toISOString();
  writeFileAtomic(f, JSON.stringify(state, null, 2));
  writeEvent({ type: 'system', subtype: 'pipeline_chef_pause_to_user', pipeline: { run }, n: state.chefPause.n, why: state.chefPause.why,
    text: `⇄ pause n° ${state.chefPause.n} rendue à l’utilisateur : ${state.chefPause.why}` });
  const text = `⇄ Le chef n’a pas tranché cette pause de processus (${state.chefPause.why}) : elle vous revient.\n\n${state.chefPause.userText || ''}\n\nNEEDS_USER_INPUT: ${state.question}`;
  writeEvent({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] } });
  writeEvent({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: 'end_turn',
    pipeline: { run, pipeline: state.pipeline, status: 'paused', limit: state.pausedLimit || null }, pipeline_paused: true, result: text });
  console.log(`[pipeline] exécution ${run} : pause de processus rendue à l’utilisateur — ${state.chefPause.why}`);
  return 2;
}

/** The pending process pause of a project's latest paused run (lane 0), or null. */
export function pendingChefPause(logsDir, projectName) {
  let runs = [];
  try { runs = fs.readdirSync(path.join(logsDir, 'runs')).filter(r => /^p-\d{8}T\d{6}-[a-z0-9]{4,8}$/.test(r)).sort().reverse().slice(0, 50); } catch { return null; }
  for (const r of runs) {
    const s = readJson(path.join(logsDir, 'runs', r, 'run.json'));
    if (!s || s.project !== projectName) continue;
    if (s.status !== 'paused') continue;
    return s.chefPause?.status === 'pending' && !(s.lane?.k >= 1) ? { run: r, chefPause: s.chefPause } : null;
  }
  return null;
}

const CODE_RE = /\.(m?js|cjs|ts|tsx|jsx|kt|kts|java|py|go|rs|cs|swift|c|cc|cpp|h)$/i;
/** Périmètre d'un changement léger, hors tests et artefacts (plan §4 : plus de
 *  3 fichiers, plus de 150 lignes ou un NOUVEAU fichier de code ⇒ complet). */
export function lightScope(cwd, base, cfg) {
  const isRun = (f) => isLocalOnly(f) || f.startsWith('.orchestrateur/');
  let files = 0, lines = 0, newCode = 0;
  for (const l of git(cwd, ['diff', '--numstat', base]).out.split('\n').filter(Boolean)) {
    const [a, b, f] = l.split('\t');
    if (!f || isRun(f) || isTestFile(f, cfg.testGlobs)) continue;
    files++; lines += (Number(a) || 0) + (Number(b) || 0);
  }
  for (const f of git(cwd, ['ls-files', '-o', '--exclude-standard']).out.split('\n').filter(Boolean)) {
    if (isRun(f) || isTestFile(f, cfg.testGlobs)) continue;
    files++;
    try { lines += fs.readFileSync(path.join(cwd, f), 'utf8').split('\n').length; } catch {}
    if (CODE_RE.test(f)) newCode++;
  }
  const why = [files > LIGHT_SCOPE.files && `${files} fichiers`, lines > LIGHT_SCOPE.lines && `${lines} lignes`, newCode && `${newCode} nouveau(x) fichier(s) de code`].filter(Boolean).join(', ');
  return { files, lines, newCode, over: !!why, why };
}

/** True for a snapshot of a folder outside git (the chef's): see walkSnapshot. */
function isWalkSnapshot(snap) { return WALK_CONTENT.has(snap); }

/** Annule les modifications d'un essai refusé (fichiers seulement, jamais les artefacts). */
function restoreFiles(cwd, before, after, resetTo) {
  // Never undo changes in a folder outside git (0.71.1, n° 18): nothing tells
  // the step's writes from the user's or a musician's — they are reported.
  if (isWalkSnapshot(before)) return;
  if (resetTo) git(cwd, ['reset', '--soft', resetTo]);
  for (const f of changedFiles(before, after)) {
    const abs = path.join(cwd, f);
    if (!before.has(f)) { try { fs.rmSync(abs, { force: true }); } catch {} continue; }
    const h = before.get(f);
    // Dossier hors git (chef) : le contenu d'avant a été gardé par l'empreinte.
    const kept = WALK_CONTENT.get(before)?.get(f);
    if (kept) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, kept); continue; }
    const r = spawnSync('git', ['-C', cwd, 'cat-file', 'blob', h], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, r.stdout); }
  }
}

// Empreinte d'un dossier HORS git (le chef, 0.54.0) : sha1 de chaque fichier,
// contenu gardé (≤ 1 Mio) pour pouvoir annuler un essai refusé.
const WALK_CONTENT = new WeakMap();
function walkSnapshot(cwd) {
  const map = new Map(), content = new Map();
  let n = 0;
  const walk = (dir, rel) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (n > 5000) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (['.git', 'node_modules', '.venv', '__pycache__'].includes(e.name) || r === '.orchestrateur/runs') continue; walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile()) continue;
      n++;
      let buf; try { buf = fs.readFileSync(path.join(dir, e.name)); } catch { continue; }
      map.set(r, crypto.createHash('sha1').update(buf).digest('hex'));
      if (buf.length <= 1024 * 1024) content.set(r, buf);
    }
  };
  walk(cwd, '');
  WALK_CONTENT.set(map, content);
  return map;
}
