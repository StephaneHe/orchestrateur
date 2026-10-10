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
import { readBranchLog } from './dual-run.mjs';
import { languageFor, languageGate, localize, workingLanguage } from './language.mjs';
import { CATALOG_PIPELINES, catalogOf, catalogSteps } from './pipeline-catalog.mjs';
import { readPending, addPending, releaseReady, launchTask, detectReprise, logOffset, taskKey, RUN_ID_RE } from './routage-pending.mjs';
export { readPending };
import { backoffConfig, isLaunchFailure, dispatchRefusal, tierAfter, delayFor, waitBackoff, runDirOf } from './model-backoff.mjs';
import { runModelTest } from './model-test.mjs';
import { PIPELINES } from './model-pipelines.mjs';
import { checkMediaFiles, listedFiles, wordErrorRate } from './media-check.mjs';
import { countTests, addedTests, itemTestsVerdict } from './item-tests.mjs';

export const RUN_RE = /^p-\d{8}T\d{6}-[a-z0-9]{4,8}$/;
export const STEP_KEY_RE = /^\d{2}-[a-z0-9-]{1,40}$/;
export const SESSION_GROUP_RE = /^[a-z0-9-]{1,40}$/;

// Limites (décision n° 5, plan §2.5). ORCH_PIPE_* pour les tests.
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
};
/** Nom d'étape compréhensible par l'utilisateur, sans vocabulaire interne. */
export function plainStep(id) {
  if (PLAIN_STEP[id]) return PLAIN_STEP[id];
  for (const p of CATALOG_PIPELINES) { const s = catalogOf(p).steps.find(x => x.id === id); if (s) return s.title.replace(/^\d+[a-z]?\s+/, '').toLowerCase(); }
  return id || 'exécution';
}
export function pipelineLabel(pipeline, mode) {
  if (pipeline === 'dev') return mode === 'complet' ? 'Développement complet' : 'Développement léger';
  if (pipeline === 'discussion') return 'Discussion';
  return PIPELINES.find(p => p.id === pipeline)?.label || pipeline;
}
const PROGRESS_MS = Number(process.env.ORCH_PIPE_PROGRESS_MS) > 0 ? Number(process.env.ORCH_PIPE_PROGRESS_MS) : 30_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

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
export function writeEnforcement(root, { projects, pipelines, terminal, chef, generalSince, by }) {
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
  j.enforcement = { projects: [...new Set(projects)], pipelines: pipelines.filter(p => ENGINE_PIPELINES.includes(p)), ...(term ? { terminal: true } : {}), ...(chf ? { chef: true } : {}), ...(gen ? { generalSince: gen } : {}), since: at, by };
  const fmt = (e) => `${(e.projects || []).join(',') || '—'} / ${(e.pipelines || []).join(',')}${e.terminal ? ' / terminal' : ''}${e.chef ? ' / chef' : ''}`;
  j.history.push({ at, task: 'enforcement', from: before ? fmt(before) : null, to: fmt(j.enforcement), by });
  if (j.history.length > 500) j.history = j.history.slice(-500);
  j.updatedAt = at;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  fs.renameSync(tmp, file);
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

/** Nature d'une demande de développement léger : bugfix, mécanique ou simple. */
export function devKind(text) {
  const t = STRIP(text);
  if (/\b(bug|corrig|fix|repar|erreur|plante|crash|regression|ne marche|ne fonctionne|casse)/.test(t)) return 'bugfix';
  if (/\b(renomm|remplac|rename|deplac|typo|coquille|faute d'orthographe|libelle|wording|reformat)/.test(t)) return 'mecanique';
  return 'simple';
}

/** Étapes d'une exécution, dans l'ordre. */
export function planSteps(pipeline, { mode = 'leger', kind = 'simple' } = {}) {
  if (pipeline === 'discussion') {
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
    if (mode === 'complet') return ['comprendre', 'concevoir', 'liste-tests', '@loop', 'revue', 'livrer'].map(id => D[id]);
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
    rouge: { id: 'rouge', title: `4a Rouge${kind === 'bugfix' ? ' (reproduire le bug)' : ''}`, chain: [`dev.rouge.${v}`, 'dev.rouge'], group: 'tests', artefact: 'rouge.md' },
    vert: { id: 'vert', title: '4b Vert', chain: [`dev.vert.${vv}`, 'dev.vert'], group: 'code', artefact: 'vert.md' },
    refactor: { id: 'refactor', title: '4c Refactor', chain: ['dev.refactor'], group: 'code', artefact: 'refactor.md', optional: true },
    revue: { id: 'revue', title: '5 Revue', chain: ['dev.revue.code', 'dev.revue'], group: 'revue', artefact: 'revue.json', judge: true },
    livrer: { id: 'livrer', title: '6 Livrer (+ 7 Documenter)', chain: ['dev.livrer.git', 'dev.livrer'], group: 'code', artefact: 'livraison.md', final: true },
  };
}

/**
 * Constat de revue qui n'est PAS un comportement testable : documentation,
 * registre des exigences, CHANGELOG, version, commentaires (retour utilisateur
 * du 2026-10-09). Il part à l'étape Livrer, jamais dans la boucle TDD, et ne
 * consomme pas la limite de tests.
 */
export function isDeliveryFix(text) {
  const t = STRIP(text);
  return /(user_requirements|registre des exigences|registre d.exigence|changelog|readme|claude\.md|documentation|\bdocs?\b|docs\/|\.md\b|numero de version|version (non |pas )?(incrementee|bumpee|a jour)|\bbump|versionname|versioncode|commentaire|tracabilite|faute d.orthographe dans la doc)/.test(t);
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

/** Empreinte de chaque fichier suivi ou non ignoré (hors artefacts d'exécution). */
export function snapshot(cwd) {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']).out !== 'true') return walkSnapshot(cwd);
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

function runCommand(cwd, command, env) {
  if (!command) return { ok: true, code: 0, out: '' };
  const t0 = Date.now();
  // La commande vient du fichier VERSIONNÉ du projet (.orchestrateur/pipeline.json),
  // jamais d'une entrée réseau : un shell est nécessaire (« npm test »).
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: TEST_TIMEOUT_MS, env, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, code: r.status, out: out.slice(-12_000), ms: Date.now() - t0, timedOut: r.error?.code === 'ETIMEDOUT' };
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

/** Chemins cités entre accents graves qui n'existent pas. */
export function missingCitedPaths(text, cwd) {
  const out = [];
  for (const m of String(text).matchAll(/`([^`\n]{2,200})`/g)) {
    const p = m[1].trim().replace(/:\d+(-\d+)?$/, '');
    const looksPath = /^[\w.\-@]+([\\/][\w.\-@ ]+)+$/.test(p) || /^[\w.\-]+\.(m?js|cjs|ts|tsx|jsx|json|md|kt|kts|py|java|css|html|ya?ml|toml|txt|ps1|sh|gradle)$/i.test(p) || /^[A-Za-z]:[\\/]/.test(p);
    if (!looksPath || /^https?:/i.test(p) || /[*?]/.test(p)) continue;
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    if (fs.existsSync(abs)) continue;
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
  L.push('');
  const T = cfg.testCommand ? `« ${cfg.testCommand} »` : 'la suite de tests du projet';
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
    case 'revue':
      L.push('Ton rôle : REVUE du changement en cours (défauts, sécurité, cohérence, tests suffisants). Le diff complet est dans le fichier :');
      L.push(`  ${art('diff.patch')}`);
      if (ctx.coveredItems?.length) L.push(`Items acceptés comme DÉJÀ COUVERTS (leur test passait d'emblée, sans nouveau code) : ${ctx.coveredItems.map(coveredLabel).join(' ; ')}. Vérifie que chacun de ces tests est FIDÈLE à son item et qu'il échouerait si le comportement disparaissait ; un test vide de sens est un « problème ».`);
      L.push('Ne relève PAS l’absence de numéro de version incrémenté, d’entrée CHANGELOG ni de ligne dans le registre des exigences : l’étape Livrer, qui suit, les ajoute, et l’orchestrateur les vérifie.');
      L.push(`Écris ${art('revue.json')}, et UNIQUEMENT ce JSON : {"verdict": "ok" | "problèmes", "items": ["défaut de comportement 1", …], "hors_tdd": ["correction de doc ou de commentaire 1", …]}.`);
      L.push('« items » : uniquement des défauts de COMPORTEMENT, qu’un test peut prouver (ils repartent dans la boucle de tests). « hors_tdd » : ce qui ne se teste pas (documentation, README, commentaires…) — ce sera fait à la livraison. « problèmes » seulement pour un défaut réel, à corriger maintenant.');
      if (ctx.mode === 'complet') {
        const cap = ctx.limits?.testsPerItem || LIMITS.testsPerItem;
        L.push(`Chaque entrée de « items » devient une case de tests.md : commence-la par « (tests: N) », N = nombre de tests prévus pour la prouver, de 1 à ${cap} (ex. « (tests: 1) [P2] … »). Un défaut qui en demande plus doit être découpé en plusieurs entrées.`);
      }
      L.push('Ne modifie AUCUN fichier du projet.');
      break;
    case 'livrer': {
      L.push('Ton rôle : LIVRER et DOCUMENTER (règles de la flotte), dans cet ordre :');
      if (ctx.coveredItems?.length) L.push(`Comportement(s) DÉJÀ assuré(s) par le code existant, sans nouveau code de production (le test ajouté sert de documentation) : ${ctx.coveredItems.map(coveredLabel).join(' ; ')}. Mentionne-le dans l'entrée CHANGELOG et dans ${art('livraison.md')}.`);
      if (ctx.deliveryFixes?.length) L.push(`0. d'abord, les corrections relevées par la relecture qui ne relèvent pas des tests (documentation, commentaires…) :\n${ctx.deliveryFixes.map(f => `   - ${f}`).join('\n')}`);
      L.push(`1. incrémente la version (patch pour une correction, minor pour une fonctionnalité) dans : ${(cfg.versionFiles || []).join(', ') || '(fichier de version du projet)'} ;`);
      L.push(`2. ajoute l'entrée « ## [X.Y.Z] - AAAA-MM-JJ » correspondante dans ${cfg.changelog || 'CHANGELOG.md'} ;`);
      if (cfg.requirements) L.push(`3. ajoute D'OFFICE la ligne de la demande dans ${cfg.requirements} (date, demande verbatim, tests associés, version) — c'est obligatoire à chaque livraison, personne d'autre ne le fera ;`);
      L.push(`${cfg.requirements ? 4 : 3}. un SEUL commit avec tout le changement (git add -A puis git commit) — l'arbre doit être propre ensuite ;`);
      L.push('Pas de git push (il reste soumis à autorisation). Hormis les corrections de documentation ci-dessus, aucune nouvelle modification de code ni de test.');
      L.push(`Écris ${art('livraison.md')} : version, commit, ce qui a été livré.`);
      L.push(`L'orchestrateur vérifie ensuite : commit créé, arbre propre, version incrémentée, entrée CHANGELOG${cfg.requirements ? ', ligne d’exigence' : ''}, ${T} vert${cfg.buildCommand ? `, build (« ${cfg.buildCommand} »)` : ''}.`);
      break;
    }
  }
  if (extra?.retryWhy) L.push(`\n⚠ L'essai précédent de cette étape a été REFUSÉ par l'orchestrateur : ${extra.retryWhy}\nCorrige précisément ce point.`);
  L.push('\nRègles de l’étape : ne lance aucun dispatch (dispatch.mjs), ne pousse rien (git push interdit), ne commite pas sauf à l’étape Livrer. Termine par un résumé court de ce que tu as fait.');
  return L.join('\n');
}

/** Consigne d'une étape du catalogue (phase 6) : rôle, artefact, et les critères
 *  que le code vérifiera, dits explicitement (lignes ATTENDU_* lisibles par tous). */
function catalogStepPrompt(L, ctx, step, art, T) {
  const c = step.checks || {};
  L.push(`Ton rôle : ${step.role}`);
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
  if (c.requireFiles?.length) machine.push(`FICHIERS_REQUIS=${c.requireFiles.join(', ')}`);
  const mediaKind = c.media ? (step.mediaKind || c.media.kind) : null;
  if (mediaKind) machine.push(`MEDIA=${mediaKind}`);
  if (c.media?.optionalWith) machine.push(`MARQUEUR_SANS_MEDIA=${c.media.optionalWith}`);
  if (ctx.localTool) machine.push(`OUTIL_LOCAL=${ctx.localTool}`);
  L.push(...machine);
  L.push('');
  if (step.kind === 'judge') {
    L.push(`Écris ${art(step.artefact)}${c.json ? ', et UNIQUEMENT ce JSON' : ''}. Ne modifie AUCUN fichier du projet (lecture seule : l’orchestrateur compare les empreintes).`);
  } else if (step.kind === 'deliver') {
    L.push(step.role ? '' : 'Livre en un seul commit.');
    L.push(`Écris ${art(step.artefact)} : le commit et ce qui a été livré. L'orchestrateur vérifie : commit créé, arbre propre.`);
  } else {
    L.push(`Écris ${art(step.artefact)} : ce que tu as fait et pourquoi.`);
    if (c.onlyGlobs) L.push(`Tu ne modifies QUE des documents (motifs : ${c.onlyGlobs.join(', ')}) : aucun code, aucun test.`);
    if (c.protectTests) L.push('Interdit : modifier les tests existants (l’orchestrateur compare leur empreinte).');
    if (c.nothing) L.push(`S'il n'y a rien à faire, écris exactement « ${c.nothing} » dans l'artefact et ne modifie rien : c'est accepté.`);
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
export function countSources(text, { files = false } = {}) {
  const urls = new Set([...String(text || '').matchAll(/https?:\/\/[^\s)>\]"'`]+/g)].map(m => m[0].replace(/[.,;:]+$/, '')));
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
    if (t.projet === conductor || new RegExp(`^${conductor}-\\d+$`).test(t.projet)) return `${n} : le chef ne se délègue pas de tâche`;
    if (!ENGINE_PIPELINES.includes(t.pipeline) || t.pipeline === 'routage') return `${n} : pipeline inconnu « ${t.pipeline} »`;
    if (t.mode != null && !['leger', 'complet'].includes(t.mode)) return `${n} : mode « ${t.mode} » (leger ou complet)`;
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

/** Les derniers échanges du fil (demandes, réponses du chef, résultats), pour l'étape Lire. */
export function conversationExcerpt(logFile, { max = 30, maxChars = 30_000 } = {}) {
  let lines = [];
  try {
    const st = fs.statSync(logFile);
    const fd = fs.openSync(logFile, 'r');
    const len = Math.min(st.size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    lines = buf.toString('utf8').split('\n');
  } catch { return '# Conversation récente\n\n(aucune)\n'; }
  const out = [];
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'user_prompt' && typeof e.text === 'string' && !e.pipeline?.answer) {
      out.push(`**${e.source === 'wake' ? 'réveil' : 'utilisateur'}** : ${e.text.slice(0, 2000)}`);
    } else if (e.type === 'assistant') {
      for (const b of e.message?.content || []) { if (b?.type === 'text' && b.text?.trim()) out.push(`**chef** : ${b.text.trim().slice(0, 2000)}`); }
    } else if (e.type === 'notification' && e.subtype === 'musician_done' && e.text) {
      out.push(`**résultat** ${e.text.slice(0, 600)}`);
    }
  }
  let txt = out.slice(-max).join('\n\n');
  if (txt.length > maxChars) txt = txt.slice(-maxChars);
  return `# Conversation récente (extraite du log par l'orchestrateur)\n\n${txt || '(aucune)'}\n`;
}

const CODE_STEPS = {
  /** Les models viennent de la page Models : le code les relève, tâche par tâche. */
  async affecter({ root, ctx, state, artDir }) {
    const j = parseJsonArtefact(readArtefact(ctx, 'taches.json') || '') || {};
    const why = validateTasks(root, j.taches);
    if (why) return { ok: false, why };
    const enf = readEnforcement(root);
    const assignments = readAssignments(root);
    const rows = [];
    state.tasks = j.taches.map((t) => {
      const served = isEnforced(enf, t.projet) && enf.pipelines.includes(t.pipeline);
      const steps = served ? planSteps(t.pipeline, { mode: t.mode || 'leger' }).filter(s => s.chain?.length && s.kind !== 'code').map(s => ({ id: s.id, ...resolveCase(assignments, s.chain) })) : [];
      rows.push(`| ${t.projet} | ${served ? `${pipelineLabel(t.pipeline, t.mode)}` : `${t.pipeline} — projet hors service : tour ordinaire`} | ${steps.map(s => `${s.id}: ${s.model || 'défaut du projet'}`).join(', ') || '—'} |`);
      return { ...t, served };
    });
    fs.writeFileSync(path.join(artDir, 'affectation.md'), `# Affectation (page Models)\n\n| projet | pipeline | models par étape |\n|---|---|---|\n${rows.join('\n')}\n`);
    return { ok: true };
  },
  /** Chaque tâche part par dispatch.mjs (file si le musicien est occupé), avec retour au chef. */
  async dispatcher({ root, logsDir, state, artDir, dispatchScript, run }) {
    if (process.env.DISPATCH_REPORT_ONLY === '1') return { ok: false, why: 'réveil en rapport seul : aucun dispatch permis (chaîne de réveils au maximum)' };
    const done = [], waiting = [];
    // A task citing a paused run of its project resumes it (0.58.0), even if the
    // Decomposer forgot the « reprise » field: never a second, new run.
    const tasks = (state.tasks || []).map(t => ({ ...t, reprise: detectReprise(logsDir, t) }));
    tasks.forEach((t, i) => {
      // « puis » : une tâche qui attend la fin d'une autre part quand ce résultat
      // arrive (libération mécanique en fin de tour, 0.58.0), jamais avant.
      if (t.apres) { waiting.push({ ...t, n: i + 1, after: tasks[t.apres - 1].projet }); return; }
      done.push({ n: i + 1, ...launchTask(root, t, dispatchScript) });
    });
    let duplicates = [];
    if (waiting.length) {
      const entries = waiting.map(w => {
        const depTask = tasks[w.apres - 1];
        const dep = done.find(d => d.n === w.apres);
        // Anchor: the awaited log position when the awaited task was launched
        // (or now, if it is itself still waiting) plus its text.
        return { run, projet: w.projet, pipeline: w.pipeline, mode: w.mode || null, served: w.served, demande: w.demande, rattache: w.rattache || null,
          ...(w.reprise ? { reprise: w.reprise } : {}),
          after: { projet: w.after, offset: dep ? dep.offset : logOffset(logsDir, w.after), key: taskKey(depTask.demande), since: dep?.at || new Date().toISOString() } };
      });
      duplicates = addPending(logsDir, entries).duplicates;
    }
    fs.writeFileSync(path.join(artDir, 'dispatch.json'), JSON.stringify({ dispatched: done, waiting: waiting.map(w => ({ n: w.n, projet: w.projet, apres: w.apres, after: w.after, ...(w.reprise ? { reprise: w.reprise } : {}) })), ...(duplicates.length ? { duplicates } : {}) }, null, 2));
    const lost = done.filter(d => !d.pid);
    return lost.length ? { ok: false, why: `lancement impossible pour : ${lost.map(d => d.projet).join(', ')}` } : { ok: true };
  },
  /** Réveil : lance les tâches dont la tâche attendue a rendu son résultat depuis. */
  async relancer({ root, logsDir, artDir, dispatchScript }) {
    // Same mechanical release as the end of every turn (routage-pending.mjs);
    // usually already done by then — this is the safety net of the wake-up.
    const r = process.env.DISPATCH_REPORT_ONLY === '1'
      ? { launched: [], blocked: [], still: readPending(logsDir) }
      : releaseReady({ root, logsDir, dispatchScript });
    fs.writeFileSync(path.join(artDir, 'relance.json'), JSON.stringify({ launched: r.launched, waiting: r.still.map(p => ({ projet: p.projet, after: p.after?.projet })), blocked: r.blocked }, null, 2));
    return { ok: true };
  },
};

/** Signalement de lacune émis par le Routage (classement « lacune »). */
async function emitRoutingGap(logsDir, project, text, why) {
  const obs = await import('./pipeline-observe.mjs');
  const c = obs.classify({ text });
  const detected = obs.detectGap({ text, classification: { ...c, explicit: false } });
  const key = detected?.key || `routage:${crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`;
  const gap = {
    ...(detected || { reason: 'aucun-pipeline', proposal: { kind: 'rattachement', pipeline: 'discussion', text: 'rattacher la demande à un pipeline existant' } }),
    key, why: `Routage : aucune question ouverte ni aucun contexte ne rattache ce message${why ? ` (${String(why).slice(0, 200)})` : ''}`,
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
  L.push('## Ta dernière réponse', '', last ? last.slice(0, 6000) : '(aucune)', '');
  const asked = [];
  for (const r of replies.slice(-3)) {
    for (const line of r.split(/\r?\n/)) {
      const t = line.replace(/^[\s>*-]*(\d+[.)]\s*)?/, '').trim();
      if (/^NEEDS_USER_INPUT:/.test(t) || (/\?\s*$/.test(t) && t.length > 12)) asked.push(t.replace(/^NEEDS_USER_INPUT:\s*/, ''));
    }
  }
  L.push('## Questions que tu as posées (les plus récentes)', '', asked.length ? [...new Set(asked)].slice(-12).map(q => `- ${q.slice(0, 400)}`).join('\n') : '(aucune)', '');
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
    if (lastQ) waiting.push(`- **${p.name}** : ${lastQ.slice(0, 400)}`);
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
  L.push('## Demandes mises en attente (TODO_LIST du chef)', '', parked.length ? parked.slice(0, 20).map(x => `- ${x.slice(0, 400)}`).join('\n') : '(aucune)', '');
  // 4. Tâches de Routage qui attendent la fin d'une autre.
  const pend = readPending(logsDir);
  if (pend.length) L.push('## Tâches déjà décidées, en attente d’une autre', '', pend.map(p => `- ${p.projet} (après ${p.after?.projet || '?'})${p.reprise ? ` — reprise ${p.reprise}` : ''} : ${String(p.demande).slice(0, 200)}`).join('\n'), '');
  // 5. Paused pipeline runs (0.58.0): resuming one is a task with « reprise ».
  const paused = pausedRuns(logsDir);
  L.push('## Exécutions de pipeline en pause (pour les reprendre : tâche avec « reprise »: "<identifiant>")', '',
    paused.length ? paused.map(p => `- ${p.project} : ${p.run} (${p.pipeline}${p.mode ? ` ${p.mode}` : ''}, en pause : ${p.pausedLimit || 'question'}) — ${String(p.request || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n') : '(aucune)', '');
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

/** Critères génériques d'une étape du catalogue. */
function checkCatalogCriteria(ctx, step, before, after) {
  ctx.lastCheck = null;
  const { cwd } = ctx;
  const c = step.checks || {};
  const changed = changedFiles(before, after);
  const art = readArtefact(ctx, step.artefact);
  // Un JSON court (« {"remaining":[]} ») est une vraie réponse : il est jugé sur sa forme.
  const artOk = art != null && (c.json ? art.trim().length > 1 : art.trim().length >= 20);
  const fail = (why, extra = {}) => ({ ok: false, why, changed, ...extra });
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
    if (changed.length) return fail(`étape en lecture seule, mais des fichiers du projet ont changé : ${changed.slice(0, 8).join(', ')}`);
    if (c.headUnchanged && git(cwd, ['rev-parse', 'HEAD']).out !== ctx.headAtStep) return fail('l’historique git a été modifié : interdit à cette étape (rapport seulement)');
  } else {
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
    if (!changed.length && !nothing && !media && !waived) return fail(c.nothing ? `aucune modification — s'il n'y a rien à faire, écris « ${c.nothing} » dans l'artefact` : 'aucune modification');
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
        const t = runCommand(cwd, ctx.cfg.testCommand, ctx.testEnv);
        if (!t.ok) return fail(`la suite échoue${c.suiteTwice ? ` (passage ${i + 1}/2)` : ''} (${ctx.cfg.testCommand}, code ${t.code}) :\n${t.out.slice(-1500)}`, { test: t });
      }
    }
  }
  if (c.sections?.length) {
    const miss = missingSections(art, c.sections);
    if (miss.length) return fail(`${step.artefact} : sections manquantes « ${miss.map(s => `## ${s}`).join(' », « ')} »`);
  }
  if (c.minSources && countSources(art, { files: step.kind !== 'judge' }) < c.minSources) {
    return fail(`${step.artefact} : au moins ${c.minSources} source(s) distincte(s) avec URL attendue(s) (${countSources(art)} trouvée(s))`);
  }
  if (c.citedPaths) {
    const missing = missingCitedPaths(art, cwd);
    if (missing.length) return fail(`chemins cités inexistants : ${missing.slice(0, 6).join(', ')}`);
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
    if (c.tasks) {
      const why = validateTasks(ctx.root, json.taches);
      if (why) return fail(`${step.artefact} : ${why}`);
    }
  }
  return { ok: true, changed, json, ...(c.media ? { media: ctx.lastCheck?.media || null, wer: ctx.lastCheck?.wer ?? null } : {}) };
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
      const missing = missingCitedPaths(art, cwd);
      if (missing.length) return { ok: false, why: `chemins cités inexistants : ${missing.slice(0, 6).join(', ')}`, changed };
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
      // Comportements à corriger (boucle TDD) d'un côté ; corrections de
      // livraison (doc, registre, CHANGELOG, version) de l'autre, pour Livrer.
      const delivery = [...(Array.isArray(j.hors_tdd) ? j.hors_tdd.map(txt).filter(Boolean) : []), ...all.filter(isDeliveryFix)];
      const items = all.filter(i => !isDeliveryFix(i)).slice(0, 15);
      // Complet : ces items deviennent des cases « (revue) » de tests.md — même
      // règle que la Liste de tests (décision « c+d », 0.61.0).
      if (ctx.mode === 'complet' && items.length) {
        const cap = ctx.limits?.testsPerItem || LIMITS.testsPerItem;
        const pb = declarationProblems(items.map((t, i) => ({ n: i + 1, done: false, declared: declaredTests(t) })), cap);
        if (!pb.ok) return { ok: false, why: declarationWhy('revue.json', pb, cap, 'entrée'), changed, declaration: pb };
      }
      return { ok: true, changed, review: { verdict: items.length ? verdict : 'ok', items, delivery: [...new Set(delivery)].slice(0, 15) } };
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
    if (devRouge && ctx.item && ctx.itemTestBase) {
      const v = checkItemTests({ cwd, files: [...after.keys()].filter(f => isTestFile(f, cfg.testGlobs)), base: ctx.itemTestBase, item: ctx.item });
      if (!v.ok) return { ok: false, why: v.why, changed, itemTests: v };
    }
    const t = runCommand(cwd, cfg.testCommand, ctx.testEnv);
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
    const t = runCommand(cwd, cfg.testCommand, ctx.testEnv);
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
    const t = runCommand(cwd, cfg.testCommand, ctx.testEnv);
    if (!t.ok) return { ok: false, why: `le refactor casse la suite (${cfg.testCommand}) :\n${t.out.slice(-1500)}`, changed, test: t };
    return { ok: true, changed, test: t };
  }
  if (step.id === 'livrer') {
    const head = git(cwd, ['rev-parse', 'HEAD']).out;
    if (!head || head === ctx.base) return { ok: false, why: 'aucun commit créé', changed };
    const dirty = git(cwd, ['status', '--porcelain']).out.split('\n').filter(l => l && !isLocalOnly(l.slice(3)));
    if (dirty.length) return { ok: false, why: `arbre non propre après le commit : ${dirty.slice(0, 6).join(' ; ')}`, changed };
    const diffNames = git(cwd, ['diff', '--name-only', `${ctx.base}..HEAD`]).out.split('\n').filter(Boolean);
    let version = null;
    for (const vf of cfg.versionFiles || []) {
      if (!diffNames.includes(vf)) return { ok: false, why: `version non incrémentée : ${vf} inchangé`, changed };
      let txt = ''; try { txt = fs.readFileSync(path.join(cwd, vf), 'utf8'); } catch {}
      const prev = git(cwd, ['show', `${ctx.base}:${vf}`]).out;
      const v = readVersion(vf, txt), pv = readVersion(vf, prev);
      if (v && pv && v === pv) return { ok: false, why: `version inchangée dans ${vf} (${v})`, changed };
      version = version || v;
    }
    const cl = cfg.changelog || 'CHANGELOG.md';
    if (fs.existsSync(path.join(cwd, cl)) || (cfg.versionFiles || []).length) {
      if (!diffNames.includes(cl)) return { ok: false, why: `${cl} sans nouvelle entrée`, changed };
      if (version) {
        let txt = ''; try { txt = fs.readFileSync(path.join(cwd, cl), 'utf8'); } catch {}
        if (!txt.includes(`## [${version}]`)) return { ok: false, why: `${cl} : pas d’entrée « ## [${version}] »`, changed };
      }
    }
    const leaked = diffNames.filter(f => isLocalOnly(f));
    if (leaked.length) return { ok: false, why: `fichiers locaux commités (jamais livrés) : ${leaked.slice(0, 6).join(', ')}`, changed };
    if (cfg.requirements && !diffNames.includes(cfg.requirements)) return { ok: false, why: `${cfg.requirements} : pas de ligne pour cette demande`, changed };
    const t = runCommand(cwd, cfg.testCommand, ctx.testEnv);
    if (!t.ok) return { ok: false, why: `la suite échoue après la livraison (${cfg.testCommand}) :\n${t.out.slice(-1500)}`, changed, test: t };
    if (cfg.buildCommand) {
      const b = runCommand(cwd, cfg.buildCommand, ctx.testEnv);
      if (!b.ok) return { ok: false, why: `le build échoue (${cfg.buildCommand}) :\n${b.out.slice(-1500)}`, changed };
    }
    return { ok: true, changed, commit: head, version };
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
export async function runPipeline(o) {
  const { root, logsDir, project, projectName, prompt, dispatchScript, callbackProject, sourceProject, obsId, classification } = o;
  const say = (m) => console.log(`[pipeline] ${m}`);
  const cwd = project.path;
  const projectLog = path.join(logsDir, `${projectName}.jsonl`);
  const pidPath = path.join(logsDir, `${projectName}.pid`);
  const writeEvent = (ev) => { try { fs.appendFileSync(projectLog, JSON.stringify({ ...ev, timestamp: new Date().toISOString() }) + '\n'); } catch {} };
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
    if (state.status !== 'paused') return refuse(65, `exécution ${o.resumeRun} : statut « ${state.status} », seule une exécution en pause se reprend`);
  }
  const cfg = readJson(path.join(cwd, '.orchestrateur', 'pipeline.json')) || {};
  const pipeline = state?.pipeline || o.pipeline;
  if (!ENGINE_PIPELINES.includes(pipeline)) return refuse(64, `« ${pipeline} » n'est pas en service (${ENGINE_PIPELINES.join(', ')}).`);
  const needs = pipeline === 'dev' ? { tests: true, clean: true } : catalogOf(pipeline)?.needs || {};
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
    const gitDir = git(cwd, ['rev-parse', '--git-dir']).out;
    const excl = path.join(path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir), 'info', 'exclude');
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(RUNS_PREFIX)) { fs.mkdirSync(path.dirname(excl), { recursive: true }); fs.appendFileSync(excl, `${cur && !cur.endsWith('\n') ? '\n' : ''}${RUNS_PREFIX}\n`); }
  } catch { /* le critère « fichiers changés » ignore déjà ce dossier */ }

  // Exécution restée « running » dont le processus est mort (tour tué) : close
  // comme interrompue, pour qu'elle ne passe jamais pour une exécution en cours.
  try {
    const dir = path.join(logsDir, 'runs');
    for (const r of fs.readdirSync(dir).filter(x => RUN_RE.test(x))) {
      const f = path.join(dir, r, 'run.json');
      const s = readJson(f);
      if (!s || s.project !== projectName || s.status !== 'running' || r === state?.run) continue;
      let alive = false;
      try { process.kill(s.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) continue;
      s.status = 'interrupted'; s.endedAt = new Date().toISOString();
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2)); fs.renameSync(`${f}.tmp`, f);
      say(`exécution ${r} close comme interrompue (processus ${s.pid} mort)`);
    }
  } catch { /* aucun dossier d'exécutions */ }

  const run = state?.run || newRunId();
  const runDir = path.join(logsDir, 'runs', run);
  const artDir = path.join(cwd, '.orchestrateur', 'runs', run);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(artDir, { recursive: true });
  const modes = catalogOf(pipeline)?.modes;
  const mode = state?.mode || (pipeline === 'dev' && o.mode === 'complet' ? 'complet' : modes ? (modes[o.mode] ? o.mode : Object.keys(modes)[0]) : 'leger');
  const kind = state?.kind || (pipeline === 'dev' ? devKind(prompt) : pipeline === 'incident' ? 'bugfix' : null);
  const assignments = readAssignments(root);
  if (!state) {
    state = {
      run, project: projectName, pipeline, mode, kind, base, status: 'running',
      createdAt: new Date().toISOString(), request: prompt.slice(0, 20_000),
      plan: planSteps(pipeline, { mode, kind }).map(s => s.id), index: 0, reviewRounds: 0, steps: [],
      ...(classification ? { classification } : {}), ...(o.modeNote ? { modeNote: o.modeNote } : {}),
      callback: callbackProject || null, source: sourceProject || null,
    };
    fs.writeFileSync(path.join(artDir, 'demande.md'), `# Demande\n\n${prompt}\n`);
  }
  const saveState = () => {
    state.updatedAt = new Date().toISOString();
    const f = path.join(runDir, 'run.json');
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${f}.tmp`, f);
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
  if (resumed && ['items', 'duration', 'review'].includes(state.pausedLimit)) {
    state.budgets = state.budgets || {};
    const L = state.pausedLimit;
    // Une liste trop longue d'emblée : l'allocation couvre au moins toute la liste.
    let open = 0; try { open = parseItems(fs.readFileSync(path.join(artDir, 'tests.md'), 'utf8')).filter(i => !i.done).length; } catch {}
    if (L === 'items') state.budgets.items = (state.itemsDone || 0) + Math.max(limits.items, open);
    if (L === 'duration') state.budgets.duration = (Number(state.activeMs) || 0) + limits.runMs;
    if (L === 'review') state.budgets.review = (state.reviewRounds || 0) + limits.reviewRounds;
    extended = { limit: L, to: state.budgets[L] };
  }
  state.status = 'running';
  state.pid = process.pid;
  saveState();

  // Le musicien est occupé pendant toute l'exécution : le parent tient le .pid.
  try { fs.writeFileSync(pidPath, String(process.pid)); } catch {}
  let stepDefs = pipeline === 'dev' ? devCatalog({ mode: state.mode, kind }) : Object.fromEntries(planSteps(pipeline, { mode, kind }).map(s => [s.id, s]));
  const catalog = catalogOf(pipeline);
  // Variante d'étape (média, 0.55.0) : choisie d'après la demande ; sa case passe
  // en tête de la chaîne, et le type de fichier attendu peut en dépendre.
  if (catalog) for (const [sid, s] of Object.entries(stepDefs)) {
    if (!s.variants) continue;
    const t = STRIP(state.request || prompt);
    const v = Object.entries(s.variants).find(([, re]) => re.test(t))?.[0];
    if (v) stepDefs[sid] = { ...s, variant: v, chain: [`${pipeline}.${s.id}.${v}`, ...s.chain], mediaKind: s.mediaByVariant?.[v] || s.checks?.media?.kind };
  }
  // Frise annoncée : la boucle TDD se lit 4a → 4b → 4c, répétée par item.
  const planned = state.plan.flatMap(id => (id === '@loop' ? ['rouge', 'vert', 'refactor'].map(x => ({ id: x, loop: true })) : id === '@check' ? [] : [{ id }]))
    .map(p => ({ ...p, title: stepDefs[p.id].title, slot: stepDefs[p.id].kind === 'code' ? { slot: stepDefs[p.id].chain[0], model: null, provider: null, second: null, source: 'code' } : resolveCase(assignments, stepDefs[p.id].chain) }));
  writeEvent({
    type: 'user_prompt', text: o.promptForLog ?? prompt,
    pipeline: { run, pipeline, mode: state.mode, kind, resumed: resumed || undefined, steps: planned.map(p => ({ id: p.id, title: p.title, loop: p.loop || undefined, slot: p.slot.slot, model: p.slot.model, provider: p.slot.provider, second: p.slot.second, source: p.slot.source })) },
    ...(sourceProject ? { source: sourceProject } : {}),
    ...(callbackProject ? { callback: callbackProject } : {}),
    ...(o.ticket ? { ticket: o.ticket } : {}), ...(o.slot != null ? { slot: o.slot } : {}),
    ...(o.testLabel ? { test: { label: o.testLabel } } : {}),
  });
  writeEvent({ type: 'system', subtype: 'pipeline_start', pipeline: { run, pipeline, mode: state.mode, kind, base },
    text: `${resumed ? 'reprise de l’exécution' : 'exécution'} ${run} : pipeline ${pipelineLabel(pipeline, state.mode)} — ${state.plan.filter(id => id !== '@check').map(id => stepDefs[id].title).join(' → ')}`,
    ...(o.modeNote ? { note: o.modeNote } : {}) });
  if (extended) {
    const what = { items: `${extended.to} items au total`, duration: `${fmtDur(extended.to)} de temps actif`, review: `${extended.to} tours de revue` }[extended.limit];
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
  const ctx = { root, request: state.request || prompt, run, pipeline, kind, mode: state.mode, cwd, cfg, artDir, base, testEnv, reviewItems: null, testPrint: null, limits,
    item: state.item || null, itemTestBase: state.itemTestBase || null, escalated: !!state.escalated, coveredItems: state.coveredItems || [], deliveryFixes: state.deliveryFixes || [], suiteRedAtStart: !!state.suiteRedAtStart, lastMedia: state.lastMedia || null };
  // Durée ACTIVE : le temps passé en pause à attendre l'utilisateur ne compte
  // pas dans la limite de 90 min (une reprise repart du temps déjà consommé).
  const sessionStart = Date.now();
  const elapsed = () => (Number(state.activeMs) || 0) + (Date.now() - sessionStart);
  const totals = { costUsd: 0, apiMs: 0, turns: 0 };

  const finish = async ({ code, result, isError = false, paused = false, question = null, limit = null, notice = null }) => {
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
    const text = paused ? `${result}\n\nNEEDS_USER_INPUT: ${question}` : result;
    // Routage : la réponse du chef doit apparaître dans son fil comme un message
    // (le fil lit les messages assistant), même sans reformulation de langue.
    if (paused || (catalogOf(pipeline)?.assistantFinal && !resultLang)) writeEvent({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] } });
    // Ni « fantôme » (0 tour / 0 ms d'API) ni « synthétique » : le chef doit
    // recevoir ce résultat et son réveil, comme pour un tour ordinaire.
    writeEvent({ type: 'result', subtype: isError ? 'error_pipeline' : 'success', is_error: isError,
      num_turns: Math.max(1, totals.turns), duration_ms: elapsed(), duration_api_ms: Math.max(1, totals.apiMs),
      stop_reason: 'end_turn', pipeline: { run, pipeline, status: state.status, ...(limit ? { limit } : {}) },
      ...(paused ? { pipeline_paused: true } : {}), ...(resultLang ? { lang: resultLang } : {}), result: text });
    try { fs.unlinkSync(pidPath); } catch {}
    // Une pause part au chef avec TOUTE l'explication (ce qui s'est passé, où en
    // est le travail, les choix et la recommandation), pas seulement la question.
    const pausedText = paused ? [notice, result, question].filter(Boolean).join('\n\n') : null;
    if (callbackProject) {
      await postNotify(root, callbackProject, `[PIPELINE — ${projectName} — ${run}] ${paused ? pausedText : isError ? `✕ ${result.slice(0, 1500)}` : result.slice(0, 8000)}`, paused && limit ? 'pipeline-limit' : 'pipeline');
    } else if (paused && limit) {
      await postNotify(root, 'chef', `[PIPELINE — ${projectName} — ${run}] ${pausedText}`, 'pipeline-limit');
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
  const pauseText = ({ what, options, recommend }) => [
    `⏸ **${projectName} — travail en pause, votre décision est attendue.**`, '',
    `**Ce qui s'est passé** : ${what}`, '',
    `**Où en est le travail** : ${progressText()}`, '',
    '**Vos choix** (répondez simplement par le mot entre guillemets) :',
    ...options.map(([k, t]) => `- « **${k}** » : ${t}`), '',
    `**Je recommande « ${recommend[0]} »** : ${recommend[1]}`,
  ].join('\n');
  const commonChoices = (step) => {
    const slot = step && stepDefs[step.id]?.chain?.length ? resolveCase(readAssignments(root), stepDefs[step.id].chain).slot : null;
    return {
      simplifier: ['simplifier', 'j’arrête cette exécution sans rien livrer. Le travail déjà fait reste dans le projet (non enregistré dans git) ; vous m’envoyez ensuite une demande plus petite pour la suite.'],
      model: ['changer le model', `choisissez un autre model pour l’étape « ${plainStep(step?.id)} » dans la page Models${slot ? ` (case « ${slot} »)` : ''}, puis répondez « continuer » : je reprends là où je me suis arrêté, avec ce model.`],
      abandonner: ['abandonner', 'j’arrête et je ne livre rien. Les modifications déjà faites restent dans le projet, non enregistrées dans git, pour que vous les regardiez ou les annuliez.'],
    };
  };
  const plainWhy = (why) => String(why || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 300);

  const pauseForLimit = async ({ limit, value, step, why, lastOutput }) => {
    const C = commonChoices(step);
    const its = parseItems(readArtefact(ctx, 'tests.md') || '');
    const left = its.filter(i => !i.done);
    const itemTxt = ctx.item ? ` pour le test « ${ctx.item.text} »` : '';
    const M = {
      items: (state.itemsDone || 0) === 0 ? {
        short: `la liste prévoit ${left.length} tests, plus que le maximum de ${state.budgets?.items || limits.items} par exécution`,
        what: `la liste des tests établie pour cette demande en compte ${left.length}, alors que la règle en autorise au plus ${state.budgets?.items || limits.items} par exécution, pour garder des travaux de taille raisonnable. Aucun test n’a encore été écrit.`,
        cont: `j’accepte la liste telle quelle et je fais les ${left.length} tests, puis la relecture et la livraison.`,
        rec: left.length <= (state.budgets?.items || limits.items) + 3 ? ['continuer', 'la liste ne dépasse que de peu.'] : ['simplifier', 'la demande est trop grosse pour une seule exécution : mieux vaut la découper.'],
      } : {
        short: `nombre maximum de tests atteint (${its.length - left.length} faits, ${left.length} restant(s))`,
        what: `la règle fixe au plus ${state.budgets?.items || limits.items} tests par exécution, pour garder des travaux de taille raisonnable. Ce nombre est atteint, mais il reste ${left.length} point(s) à traiter${left[0] ? ` — le prochain : « ${left[0].text} »` : ''}.`,
        cont: `je traite le(s) ${left.length} point(s) restant(s) (avec une marge de ${limits.items} tests de plus au maximum), puis la relecture et la livraison.`,
        rec: left.length <= 5 ? ['continuer', 'il ne reste presque plus rien à faire.'] : ['simplifier', 'il reste beaucoup à faire : mieux vaut découper la demande.'],
      },
      green: {
        short: `le code ne fait pas passer le test après ${value} essais`,
        what: `l’étape « ${plainStep('vert')} » a échoué ${value} fois de suite${itemTxt}. Dernière raison : ${plainWhy(why)}.`,
        cont: `je refais ${limits.greenAttempts} essais pour ce même test, avec le même model.`,
        rec: ['changer le model', 'le même model a échoué plusieurs fois sur le même point : un autre a plus de chances d’y arriver.'],
      },
      criteria: {
        short: `l’étape « ${plainStep(step?.id)} » a été refusée ${value} fois`,
        what: `l’étape « ${plainStep(step?.id)} »${itemTxt} a été refusée ${value} fois par les vérifications automatiques de l’orchestrateur. Dernière raison : ${plainWhy(why)}.`,
        cont: `je refais ${limits.criteriaAttempts} essais de cette étape.`,
        rec: ['continuer', 'un nouvel essai règle souvent ce genre de refus ; si cela se reproduit, simplifiez la demande.'],
      },
      item_tests: {
        short: `${value} tests écrits pour un seul point de la liste, plus que prévu`,
        what: `${plainWhy(why).replace(/\.$/, '')}.`,
        cont: 'je recompte les tests de ce point (une fois que vous les avez réduits au nombre annoncé) et je le coche s’il le respecte ; sinon je m’arrête de nouveau.',
        rec: ['simplifier', 'un point qui demande plus de tests que prévu est trop large : mieux vaut le redécouper.'],
      },
      review: {
        short: `la relecture trouve encore des défauts après ${value} tour(s) de corrections`,
        what: `la relecture trouve encore des défauts après ${value} tour(s) de corrections : ${plainWhy(why).replace(/^la revue relève encore : /, '')}.`,
        cont: `encore ${limits.reviewRounds} tour(s) de corrections et de relecture.`,
        rec: ['continuer', 'les défauts restants sont précis : un tour de plus suffit en général.'],
      },
      duration: {
        short: 'durée maximale de travail atteinte',
        what: `le travail a dépassé ${fmtDur(value)} de travail effectif (le temps passé à attendre votre réponse ne compte pas).`,
        cont: `${fmtDur(limits.runMs)} de travail de plus, à partir de là où je me suis arrêté.`,
        rec: left.length > 5 ? ['simplifier', 'il reste beaucoup à faire : mieux vaut découper la demande.'] : ['continuer', 'la fin est proche.'],
      },
    }[limit] || { short: limit, what: plainWhy(why) || limit, cont: 'je reprends là où je me suis arrêté.', rec: ['continuer', 'c’est le plus simple.'] };
    const notice = `⏸ Limite atteinte — ${projectName} : ${M.short}`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step?.id || null }, limit, value, why: why ? String(why).slice(0, 2000) : null,
      lastOutput: lastOutput ? String(lastOutput).slice(-2000) : null, text: notice });
    const body = pauseText({ what: M.what, options: [['continuer', M.cont], C.simplifier, C.model, C.abandonner], recommend: M.rec });
    // Réponses et recommandation EN TÊTE : le dashboard coupe la question à 160 caractères.
    const question = `${projectName} en pause — répondez « continuer », « simplifier », « changer le model » ou « abandonner » (je recommande « ${M.rec[0]} ») : ${M.short}.`;
    return finish({ code: 2, paused: true, limit, question, result: body, notice });
  };

  const pauseForModel = async (step, info, why) => {
    const C = commonChoices(step);
    const notice = `⏸ Model indisponible — ${projectName} : ${info.model} ne répond pas (étape « ${plainStep(step.id)} »)`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step.id }, limit: 'model_unavailable', value: info.model, why: String(why).slice(0, 2000), text: notice });
    const limitLike = /limit|quota|rate|session/i.test(String(why));
    const body = pauseText({
      what: `le model ${info.model}, choisi pour l’étape « ${plainStep(step.id)} », est indisponible : ${plainWhy(why)}. Je ne bascule jamais en silence sur un autre model (votre règle).`,
      options: [['continuer', 'je réessaie avec le même model — utile s’il était seulement momentanément indisponible.'], C.simplifier, C.model, C.abandonner],
      recommend: limitLike ? ['changer le model', 'ce model a atteint une limite d’utilisation : il ne reviendra pas tout de suite.'] : ['continuer', 'une indisponibilité passagère est le cas le plus fréquent.'],
    });
    const question = `${projectName} en pause — répondez « continuer », « simplifier », « changer le model » ou « abandonner » (je recommande « ${limitLike ? 'changer le model' : 'continuer'} ») : le model ${info.model} est indisponible.`;
    return finish({ code: 2, paused: true, limit: 'model_unavailable', question, result: body, notice });
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
    const ms = delayFor(tier, BO);
    const until = new Date(Date.now() + ms).toISOString();
    state.backoff = { step: step.id, slot: info.slot, model: info.model, provider: info.provider, tier, maxTiers: BO.maxTiers, waitMs: ms, until, failures, stderrLog: rec.stderrLog || null };
    saveState();
    const text = `⏳ ${info.model || 'le model'} ne démarre pas (${failures} erreurs de lancement de suite, étape « ${plainStep(step.id)} ») : `
      + `nouvel essai dans ${Math.round(ms / 1000)} s, puis un second (palier ${tier}/${BO.maxTiers}). Pendant l’attente : tester le model, `
      + `changer de model (case « ${info.slot} » de la page Models), ou réessayer tout de suite.`;
    writeEvent({ type: 'system', subtype: 'pipeline_backoff', pipeline: { run, step: step.id, slot: info.slot }, model: info.model, provider: info.provider,
      tier, maxTiers: BO.maxTiers, waitMs: ms, until, failures, why: rec.why, stderrLog: rec.stderrLog || null, text });
    await postNotify(root, 'chef', `[PIPELINE — ${projectName} — ${run}] ${text}\nCommandes : node scripts/model-backoff.mjs ${run} test (tester, avec journal) · node scripts/model-backoff.mjs ${run} retry (réessayer maintenant) · page Models, case « ${info.slot} » (changer de model, puis retry).`, 'pipeline-backoff');
    const w = await waitBackoff({ ms, runDir, onTest: () => modelTestFor(info, `${projectName} ${run} étape ${step.id} (attente palier ${tier})`) });
    state.backoff = null;
    saveState();
    writeEvent({ type: 'system', subtype: 'pipeline_backoff_end', pipeline: { run, step: step.id, slot: info.slot }, reason: w.reason, waitedMs: w.waitedMs,
      text: w.reason === 'retry' ? '↻ nouvel essai forcé, sans attendre la fin du délai' : `↻ fin de l’attente (${Math.round(w.waitedMs / 1000)} s) : nouvel essai` });
  };
  const pauseForLaunch = async (step, info, rec, failures) => {
    const C = commonChoices(step);
    const notice = `⏸ ${info.model || 'le model'} ne démarre pas — ${projectName} : ${failures} erreurs de lancement de suite (étape « ${plainStep(step.id)} »)`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step.id }, limit: 'launch', value: failures, why: String(rec.why || '').slice(0, 2000), stderrLog: rec.stderrLog || null, text: notice });
    const waited = Array.from({ length: BO.maxTiers }, (_, i) => delayFor(i + 1, BO)).reduce((a, b) => a + b, 0);
    const body = pauseText({
      what: `le model ${info.model}, choisi pour l’étape « ${plainStep(step.id)} » (case « ${info.slot} »), n’a rien produit ${failures} fois de suite, malgré ${BO.maxTiers} attentes de plus en plus longues (${Math.round(waited / 1000)} s au total). Dernière erreur : ${plainWhy(rec.why)}. Je ne change jamais de model sans vous (votre règle).`,
      options: [['continuer', `je recommence : ${BO.perTier} essais, puis les mêmes attentes progressives.`],
        ['tester le model', `je lance un court test de ${info.model} et je vous donne son journal complet (commande, code de sortie, messages d’erreur) ; l’exécution reste en pause.`],
        C.model, C.abandonner],
      recommend: ['tester le model', 'le journal du test dira si le model est indisponible (attendre ou en changer) ou si le problème vient d’ailleurs.'],
    });
    const question = `${projectName} en pause — répondez « continuer », « tester le model », « changer le model » ou « abandonner » (je recommande « tester le model ») : ${info.model} ne démarre pas.`;
    return finish({ code: 2, paused: true, limit: 'launch', question, result: body, notice });
  };

  // Refus de lancement par dispatch.mjs (0.61.1) : la cause est nommée, et rien
  // n'est reproché au model — ni « le model n'a rien produit », ni « tester le
  // model », ni « changer le model ».
  const pauseForLaunchRefused = async (step, info, rec) => {
    const C = commonChoices(step);
    const notice = `⏸ Lancement refusé par l’orchestrateur — ${projectName} : l’étape « ${plainStep(step.id)} » n’a pas pu démarrer (dispatch.mjs a refusé de la lancer, le model n’a pas été appelé)`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step.id }, limit: 'launch_refused', value: 1,
      why: String(rec.refusal || rec.why || '').slice(0, 2000), stderrLog: rec.stderrLog || null, text: notice });
    const body = pauseText({
      what: `le lancement de l’étape « ${plainStep(step.id)} » a été refusé par dispatch.mjs avant d’appeler le model : ${plainWhy(rec.refusal || rec.why)}. `
        + `${info.model || 'Le model'} n’a donc pas été sollicité : il n’y a rien à lui reprocher, et le tester ou en changer n’y changerait rien. C’est l’orchestrateur qu’il faut corriger (journal : ${rec.stderrLog || '—'}).`,
      options: [['continuer', 'je relance l’étape, là où elle s’est arrêtée ; utile une fois l’orchestrateur corrigé, sinon le même refus se reproduira.'], C.abandonner],
      recommend: ['continuer', 'après correction de l’orchestrateur (le chef peut la demander à orchestrateur) : rien n’est perdu, l’étape reprendra telle quelle.'],
    });
    const question = `${projectName} en pause — répondez « continuer » (après correction de l’orchestrateur) ou « abandonner » : le lancement de l’étape « ${plainStep(step.id)} » a été refusé par dispatch.mjs avant d’appeler le model (${plainWhy(rec.refusal || rec.why).slice(0, 120)}).`;
    return finish({ code: 2, paused: true, limit: 'launch_refused', question, result: body, notice });
  };

  // ── Une étape : un tour, sur le model de sa case, jeton signé ────────────
  const runStep = async (step, attempt, extra) => {
    const info = resolveCase(readAssignments(root), step.chain);
    const n = String(state.steps.length + 1).padStart(2, '0');
    const key = `${n}-${step.id}`;
    const sessionGroup = `${step.group}-${(info.model || 'defaut').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`.replace(/-+$/, '');
    const token = signStepToken(root, { run, key, project: projectName, model: info.model, provider: info.provider, second: info.second, exp: Date.now() + 6 * 3600_000 });
    const args = [projectName, '--prompt-stdin', '--pipeline-step', `${run}:${key}`, '--pipeline-session', sessionGroup, '--no-queue-if-busy'];
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
    const c = checkCriteria(ctx, step, before, after);
    rec.status = c.ok ? 'ok' : 'refused';
    rec.why = c.ok ? null : c.why;
    rec.changed = c.changed?.slice(0, 50);
    if (c.test) rec.test = { ok: c.test.ok, code: c.test.code, ms: c.test.ms };
    if (c.covered) rec.covered = true;
    return { rec, crit: c, info, before, after, log };
  };

  const record = (r) => {
    state.steps.push(r.rec);
    saveState();
    const s = r.rec;
    writeEvent({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: s.id, key: s.key, slot: s.slot, attempt: s.attempt, ...(s.item ? { item: s.item } : {}) },
      model: s.model, served: s.served, provider: s.provider, modelSource: s.source, status: s.status, why: s.why ? String(s.why).slice(0, 2000) : undefined,
      durationMs: s.durationMs, costUsd: s.costUsd, changed: s.changed, test: s.test, ...(s.covered ? { covered: true } : {}), log: `logs/runs/${run}/${s.key}.jsonl`,
      text: `étape ${s.title} : ${s.status === 'ok' ? '✓ critère vérifié' : s.status === 'refused' ? `✕ refusée — ${String(s.why).split('\n')[0].slice(0, 200)}` : s.status === 'model_unavailable' ? '⏸ model indisponible' : `✕ échec — ${String(s.why).split('\n')[0].slice(0, 200)}`}` });
  };

  // ── Préconditions de Développement : la suite doit être verte au départ ──
  // Incident : une suite déjà rouge reproduit le problème — l'étape « test qui
  // reproduit » est alors sautée (dit), et la correction doit la rendre verte.
  if (pipeline === 'incident' && state.index === 0 && !resumed && cfg.testCommand && !runCommand(cwd, cfg.testCommand, testEnv).ok) {
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
    const t = runCommand(cwd, cfg.testCommand, testEnv);
    if (!t.ok) {
      const failure = classifyTestFailure(t.out);
      const envSigns = failure.signals.map(s => `${s.label} (${s.match})`).join(', ');
      writeEvent({ type: 'system', subtype: 'pipeline_precondition', pipeline: { run }, cause: failure.cause, signals: failure.signals,
        text: failure.cause === 'environment'
          ? `la suite (${cfg.testCommand}) échoue avant l'étape 4a pour une raison d'ENVIRONNEMENT, probablement pas un test cassé : ${envSigns}`
          : `la suite (${cfg.testCommand}) est déjà rouge avant l'étape 4a`,
        output: t.out.slice(-2000) });
      if (failure.cause === 'environment') {
        return finish({ code: 2, paused: true, limit: 'precondition', notice: `⏸ ${projectName} : les tests échouent à cause de l'environnement (${failure.signals[0].label}), pas forcément d'un test cassé`,
          question: `${projectName} en pause — répondez « continuer » (une fois le réseau ou le service revenu) ou « abandonner » (je recommande « continuer » plus tard) : ses tests échouent pour une raison d'environnement (${envSigns}).`,
          result: pauseText({
            what: `avant de commencer, j’ai lancé les tests du projet (« ${cfg.testCommand} ») : ils échouent, mais les erreurs viennent de l’environnement (${envSigns}) — un service distant injoignable ou trop lent —, et probablement pas d’un test cassé. Je ne peux pas démarrer sur une base qui ne passe pas, quelle qu’en soit la cause.`,
            options: [['continuer', 'je relance les tests ; si le réseau ou le service est revenu et qu’ils passent, je commence le travail.'],
              ['abandonner', 'j’arrête sans rien modifier ; vous pourrez par exemple demander que ces tests dépendants du réseau soient isolés ou rendus optionnels.']],
            recommend: ['continuer', 'réessayer quand le réseau ou le service distant répond de nouveau.'],
          }) });
      }
      return finish({ code: 2, paused: true, limit: 'precondition', notice: `⏸ ${projectName} : les tests du projet échouent déjà avant toute modification`,
        question: `${projectName} en pause — répondez « continuer » (tests réparés) ou « abandonner » (je recommande « abandonner ») : ses tests échouent déjà avant toute modification.`,
        result: pauseText({
          what: `avant de commencer, j’ai lancé les tests du projet (« ${cfg.testCommand} ») : ils échouent déjà. Or chaque nouveau test doit d’abord échouer à cause de lui seul ; sur une base déjà cassée, ce contrôle n’a plus de sens.`,
          options: [['continuer', 'je relance les tests et, s’ils passent (vous les avez réparés entre-temps), je commence le travail.'],
            ['abandonner', 'j’arrête sans rien modifier ; vous m’envoyez d’abord une demande pour réparer les tests.']],
          recommend: ['abandonner', 'il faut d’abord une base de tests qui passe.'],
        }) });
    }
  }
  // Empreinte des tests protégés : à la reprise, celle de l'état actuel.
  const testsNow = () => new Map([...snapshot(cwd)].filter(([f]) => isTestFile(f, cfg.testGlobs)));
  if (pipeline === 'dev' || (catalog && (cfg.testGlobs || []).length)) ctx.testPrint = testsNow();
  if (state.reviewItems) ctx.reviewItems = state.reviewItems;

  // ── Boucle des étapes ─────────────────────────────────────────────────────
  const readItems = () => parseItems(readArtefact(ctx, 'tests.md') || '');
  while (state.index < state.plan.length) {
    const id = state.plan[state.index];
    if (elapsed() > (state.budgets?.duration || limits.runMs)) return pauseForLimit({ limit: 'duration', value: state.budgets?.duration || limits.runMs, step: stepDefs[id] });
    // ── Boucle TDD (0.49.0) : UN item de tests.md à la fois, 4a → 4b → 4c,
    //    tant que la liste n'est pas vide. Le moteur coche l'item, pas le model.
    if (id === '@loop') {
      const next = readItems().find(i => !i.done);
      if (!next) { state.plan.splice(state.index, 1); state.item = ctx.item = null; saveState(); continue; }
      if ((state.itemsDone || 0) >= (state.budgets?.items || limits.items)) {
        return pauseForLimit({ limit: 'items', value: limits.items, step: stepDefs['@loop'], why: `la liste n'est pas vide après ${limits.items} items (suivant : « ${next.text} ») — découper la demande` });
      }
      state.item = ctx.item = next;
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
        if (!v.ok) return pauseForLimit({ limit: 'item_tests', value: v.written, step: stepDefs.rouge, why: v.why });
        tests = v.checked ? { declared: v.declared, written: v.written } : { written: v.written, unchecked: v.note };
      } else tests = { unchecked: 'item commencé avant 0.62.0 : nombre de tests non vérifié' };
      fs.writeFileSync(path.join(artDir, 'tests.md'), checkItem(readArtefact(ctx, 'tests.md') || '', state.item.n));
      state.itemsDone = (state.itemsDone || 0) + 1;
      writeEvent({ type: 'system', subtype: 'pipeline_item_done', pipeline: { run, item: state.item.n }, tests,
        text: `✓ item ${state.item.n} coché : ${state.item.text}${tests.declared != null ? ` (${tests.written}/${tests.declared} test(s))` : tests.unchecked ? ` — ${tests.unchecked}` : ''}` });
      state.plan.splice(state.index, 1);
      state.item = ctx.item = null;
      state.itemTestBase = ctx.itemTestBase = null;
      saveState();
      continue;
    }
    const step = stepDefs[id];
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
    if (delivering && git(cwd, ['rev-parse', 'HEAD']).out !== base) {
      git(cwd, ['reset', '--soft', base]);
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
    // Contexte du chef : la conversation récente, extraite de son log par le code.
    if (step.prerun === 'conversation') {
      fs.writeFileSync(path.join(artDir, 'conversation.md'), conversationExcerpt(projectLog));
      fs.writeFileSync(path.join(artDir, 'contexte.md'), routingContext(root, { logsDir, chefLog: projectLog, chefDir: cwd }));
    }
    // Étapes exécutées par le CODE (Routage : affecter, dispatcher) — aucun tour de model.
    if (step.kind === 'code') {
      const key = `${String(state.steps.length + 1).padStart(2, '0')}-${id}`;
      const t0 = Date.now();
      let out;
      try { out = await CODE_STEPS[step.handler]({ root, logsDir, ctx, state, artDir, projectName, dispatchScript, run }); }
      catch (e) { out = { ok: false, why: e.message }; }
      const rec = { id, key, title: step.title, slot: null, model: null, source: 'code', status: out.ok ? 'ok' : 'refused', why: out.ok ? null : out.why, attempt: 1, durationMs: Date.now() - t0 };
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
    }
    ctx.headAtStep = git(cwd, ['rev-parse', 'HEAD']).out;
    if (step.id === 'revue') {
      const tracked = git(cwd, ['diff', base]).out;
      const untracked = git(cwd, ['ls-files', '-o', '--exclude-standard']).out.split('\n').filter(f => f && !isLocalOnly(f));
      const extraTxt = untracked.map(f => { let s = ''; try { s = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch {} return `--- /dev/null\n+++ b/${f}\n${s.split('\n').map(l => `+${l}`).join('\n')}`; }).join('\n');
      fs.writeFileSync(path.join(artDir, 'diff.patch'), `${tracked}\n${extraTxt}\n`);
      try { fs.unlinkSync(path.join(artDir, 'revue.json')); } catch {}
    }
    let maxAttempts = step.id === 'vert' ? limits.greenAttempts : limits.criteriaAttempts;
    // An honest "already covered" claim refused on form (missing proof, test not
    // rewritten after a refused try) is not a failure: it does not consume the
    // retry budget — once per step, so the loop stays bounded (0.57.2).
    let graceLeft = 1;
    let attempt = 0, last = null, retryWhy = null;
    let launchFails = 0;   // consecutive launch failures of this step (0.60.0)
    for (;;) {
      attempt++;
      if (step.id !== 'revue') { try { fs.unlinkSync(path.join(artDir, step.artefact)); } catch {} }
      // Second avis indépendant : l'avis précédent est retiré du dossier pendant
      // l'étape (indépendance garantie par le code), puis remis.
      const hidden = (step.independent || []).filter(f => fs.existsSync(path.join(artDir, f)));
      for (const f of hidden) fs.renameSync(path.join(artDir, f), path.join(runDir, `hidden-${f}`));
      let r;
      try { r = await runStep(step, attempt, { retryWhy }); }
      finally { for (const f of hidden) { try { fs.renameSync(path.join(runDir, `hidden-${f}`), path.join(artDir, f)); } catch {} } }
      record(r);
      if (r.unavailable) return pauseForModel(step, r.info, r.rec.why);
      // Refused by dispatch.mjs (0.61.1): deterministic, the model was never
      // called — pause at once with the cause named, no back-off.
      if (r.launchRefused) return pauseForLaunchRefused(step, r.info, r.rec);
      // Launch failure (0.60.0): not a try of the step — back-off on the SAME
      // case, then pause with the user's choices once the tiers are spent.
      if (r.launchFailed) {
        if (r.before && r.after) restoreFiles(cwd, r.before, r.after, step.judge ? null : (delivering ? base : null));
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
      if (!step.judge && r.before && r.after) restoreFiles(cwd, r.before, r.after, delivering ? base : null);
      if (step.judge && r.before && r.after) restoreFiles(cwd, r.before, r.after, null);
      retryWhy = r.rec.why;
      if (r.crit?.claimedCovered && graceLeft > 0) {
        graceLeft--;
        maxAttempts++;
        writeEvent({ type: 'system', subtype: 'pipeline_retry_not_counted', pipeline: { run, step: step.id, key: r.rec.key, attempt },
          text: `essai ${attempt} de « ${step.title} » non compté : « déjà couvert » déclaré, à compléter (${plainWhy(r.rec.why)})` });
      }
      if (attempt >= maxAttempts) {
        return pauseForLimit({ limit: step.id === 'vert' ? 'green' : 'criteria', value: attempt, step, why: r.rec.why, lastOutput: r.crit?.test?.out });
      }
    }
    if (step.id === 'rouge' || step.crit === 'rouge') ctx.testPrint = testsNow();
    if (step.crit === 'vert') ctx.suiteRedAtStart = state.suiteRedAtStart = false;
    if (last.crit?.media?.length) { ctx.lastMedia = state.lastMedia = last.crit.media.map(f => f.path); state.media = [...new Set([...(state.media || []), ...ctx.lastMedia])]; }
    // Boucle déclarée (audit : re-vérifier → corriger tant qu'il reste des failles),
    // bornée par le budget des tours de revue — comme la revue du Développement.
    // Routage : une lacune n'est signalée qu'ICI, après lecture du contexte et
    // essai de rattachement (0.57.0) — jamais au simple vu du texte.
    if (pipeline === 'routage' && step.id === 'classifier' && last.crit?.json?.nature === 'lacune') {
      const g = await emitRoutingGap(logsDir, projectName, state.request, last.crit.json.raison);
      writeEvent({ type: 'system', subtype: 'pipeline_gap', pipeline: { run }, gap: g?.key || null, text: `⚑ lacune signalée après lecture du contexte : ${String(last.crit.json.raison || '').slice(0, 200)}` });
    }
    if (step.loop && Array.isArray(last.crit?.json?.[step.loop.field]) && last.crit.json[step.loop.field].length) {
      const left = last.crit.json[step.loop.field];
      const leftTxt = left.slice(0, 5).map(x => (typeof x === 'string' ? x : x.issue || JSON.stringify(x))).join(' ; ');
      if (state.reviewRounds >= (state.budgets?.review || limits.reviewRounds)) {
        return pauseForLimit({ limit: 'review', value: state.reviewRounds, step, why: `la revue relève encore : ${leftTxt}` });
      }
      state.reviewRounds++;
      state.plan.splice(state.index + 1, 0, ...step.loop.back);
      writeEvent({ type: 'system', subtype: 'pipeline_loop', pipeline: { run, from: id, to: step.loop.back[0], round: state.reviewRounds },
        text: `${step.title} : ${left.length} point(s) restant(s) → retour à « ${stepDefs[step.loop.back[0]].title} » (tour ${state.reviewRounds}/${limits.reviewRounds})` });
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
      // Garde-fou du léger (plan §4) : au-delà du périmètre, montée en complet
      // à l'étape 3 — annoncée, jamais en silence.
      if (state.mode === 'leger' && !afterReview && !state.escalated) {
        const scope = lightScope(cwd, base, cfg);
        if (scope.over) {
          state.mode = ctx.mode = 'complet';
          state.escalated = ctx.escalated = true;
          stepDefs = devCatalog({ mode: 'complet', kind });
          state.plan.splice(state.index + 1, 0, 'liste-tests', '@loop');
          writeEvent({ type: 'system', subtype: 'pipeline_escalate', pipeline: { run, from: 'leger', to: 'complet' }, scope,
            text: `⇧ périmètre dépassé (${scope.why}) : l'exécution monte en Développement complet — liste de tests, puis un test à la fois` });
        }
      }
    }
    if (step.id === 'revue' && last.crit?.review?.delivery?.length) {
      // Constats hors TDD : faits à la livraison, sans test ni tour de boucle.
      state.deliveryFixes = ctx.deliveryFixes = [...new Set([...(state.deliveryFixes || []), ...last.crit.review.delivery])].slice(0, 20);
      writeEvent({ type: 'system', subtype: 'pipeline_delivery_fixes', pipeline: { run }, fixes: last.crit.review.delivery,
        text: `revue : ${last.crit.review.delivery.length} correction(s) de documentation ou de livraison, mise(s) de côté pour l'étape Livrer (hors boucle de tests)` });
    }
    if (step.id === 'revue' && last.crit?.review?.verdict === 'problemes' && last.crit.review.items.length) {
      if (state.reviewRounds >= (state.budgets?.review || limits.reviewRounds)) {
        return pauseForLimit({ limit: 'review', value: state.reviewRounds, step, why: `la revue relève encore : ${last.crit.review.items.slice(0, 5).join(' ; ')}` });
      }
      state.reviewRounds++;
      if (state.mode === 'complet') {
        // Complet : chaque problème devient un item de la liste, puis retour à 4.
        const md = (readArtefact(ctx, 'tests.md') || '').replace(/\s*$/, '\n');
        fs.writeFileSync(path.join(artDir, 'tests.md'), md + last.crit.review.items.map(i => `- [ ] (revue) ${String(i).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') + '\n');
        state.plan.splice(state.index + 1, 0, '@loop', 'revue');
      } else {
        ctx.reviewItems = state.reviewItems = last.crit.review.items;
        ctx.testPrint = testsNow();   // tests existants protégés ; en ajouter reste permis
        state.plan.splice(state.index + 1, 0, 'vert', 'revue');
      }
      const to = state.mode === 'complet' ? '4 (nouveaux items)' : '4b';
      writeEvent({ type: 'system', subtype: 'pipeline_loop', pipeline: { run, from: 'revue', to: state.mode === 'complet' ? 'tdd' : 'vert', round: state.reviewRounds },
        text: `revue : ${last.crit.review.items.length} problème(s) → retour à ${to} (tour de revue ${state.reviewRounds}/${limits.reviewRounds})` });
    }
    state.index++;
    saveState();
  }

  // ── Fin : la réponse (Discussion) ou la livraison (Développement) ────────
  function catalogResult() {
    const label = pipelineLabel(pipeline, state.mode);
    const finalStep = catalog.final ? stepDefs[catalog.final] : null;
    let body = '';
    if (finalStep) {
      const raw = (readArtefact(ctx, finalStep.artefact) || '').trim();
      const j = finalStep.checks?.json ? parseJsonArtefact(raw) : null;
      if (j && typeof j.final === 'string') body = j.final.trim();
      else if (j && Array.isArray(j.remaining)) {
        const fmt = (x) => (typeof x === 'string' ? x : `${x.severity ? `[${x.severity}] ` : ''}${x.file ? `${x.file} : ` : ''}${x.issue || JSON.stringify(x)}`);
        body = `**Failles restantes** : ${j.remaining.length ? `\n${j.remaining.map(x => `- ${fmt(x)}`).join('\n')}` : 'aucune (gravité haute ou moyenne).'}` +
          (Array.isArray(j.verified) && j.verified.length ? `\n\n**Corrigées et vérifiées** :\n${j.verified.map(x => `- ${fmt(x)}`).join('\n')}` : '');
      } else if (j && typeof j.verdict === 'string') {
        body = `**Vérification** : ${j.verdict === 'ok' ? '✓ conforme' : 'défauts relevés'}${Array.isArray(j.items) && j.items.length ? `\n${j.items.map(x => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n')}` : ''}`;
      } else body = raw;
    }
    if (catalog.media && state.media?.length) body = `**Fichiers produits (vérifiés par l'orchestrateur)** :\n${state.media.map(f => `- \`${f}\``).join('\n')}\n\n${body}`;
    // Recherche : lecture seule, la synthèse EST la réponse.
    if (pipeline === 'recherche') return body || '(synthèse vide)';
    // Routage : le rapport EST la réponse du chef ; une demande ambiguë finit
    // par la question à l'utilisateur (règle : ne jamais deviner).
    if (pipeline === 'routage') {
      const cls = parseJsonArtefact(readArtefact(ctx, 'classement.json') || '') || {};
      const q = cls.nature === 'question' && String(cls.question || '').trim();
      return `${body || '(rapport vide)'}${q && !/NEEDS_USER_INPUT:/.test(body) ? `\n\nNEEDS_USER_INPUT: ${q.replace(/\s+/g, ' ')}` : ''}`;
    }
    const head = git(cwd, ['rev-parse', 'HEAD']).out;
    const delivered = head && head !== base ? git(cwd, ['log', '-1', '--format=%h %s']).out : null;
    const skipped = state.steps.filter(s => s.status === 'skipped');
    return `✓ ${projectName} — pipeline ${label} terminé (${run}).\n\n` +
      `- Étapes : ${state.steps.filter(s => s.status === 'ok').map(s => `${s.title.replace(/^\d+[a-z]?\s+/, '')} (${s.model || 'défaut'})`).join(' → ')}\n` +
      (skipped.length ? `- Sautées : ${skipped.map(s => `${s.title.replace(/^\d+[a-z]?\s+/, '')} — ${s.why}`).join(' ; ')}\n` : '') +
      `- ${delivered ? `Commit : ${delivered}` : 'Aucun commit (rien à livrer)'} ; pas de push (soumis à autorisation).\n` +
      `- Critères vérifiés par l'orchestrateur à chaque étape (artefacts, lecture seule, suite verte, livraison).\n` +
      (body ? `\n${body.slice(0, 8000)}` : (readArtefact(ctx, 'livraison.md') || '').trim().slice(0, 4000) ? `\n${(readArtefact(ctx, 'livraison.md') || '').trim().slice(0, 4000)}` : '');
  }
  let result;
  if (pipeline === 'discussion') {
    result = (readArtefact(ctx, 'reponse.md') || '').trim() || '(réponse vide)';
  } else if (catalog) {
    result = catalogResult();
  } else {
    const head = git(cwd, ['log', '-1', '--format=%h %s']).out;
    result = `✓ ${projectName} — pipeline ${pipelineLabel(pipeline, state.mode)} terminé (${run}).\n\n` +
      `- Commit : ${head}\n` +
      `- Étapes : ${state.steps.filter(s => s.status === 'ok').map(s => `${s.title.split(' ')[0]} ${s.model || 'défaut'}`).join(' → ')}\n` +
      (state.mode === 'complet' ? `- TDD : ${state.itemsDone || 0} item(s) de la liste de tests, un à la fois (4a → 4b → 4c)\n` : '') +
      (state.escalated ? '- ⇧ Monté de léger en complet : la demande dépassait le périmètre du mode léger\n' : '') +
      ((state.coveredItems || []).length ? `- ↺ Déjà assuré par le code existant (test ajouté comme documentation, sans nouveau code) : ${state.coveredItems.map(coveredLabel).join(' ; ')}\n` : '') +
      `- Critères vérifiés par l'orchestrateur : test rouge puis vert, tests inchangés en 4b, revue, version, CHANGELOG${cfg.requirements ? ', exigence' : ''}, suite verte\n` +
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
export async function answerPausedRun({ logsDir, project, projectName, run, answer, promptForLog, sourceProject, callbackProject, testLabel }) {
  const f = path.join(logsDir, 'runs', run, 'run.json');
  const state = readJson(f);
  if (!state || state.status !== 'paused' || state.project !== projectName) { console.error(`[pipeline] aucune exécution en pause ${run} pour ${projectName}`); return 65; }
  const projectLog = path.join(logsDir, `${projectName}.jsonl`);
  const writeEvent = (ev) => { try { fs.appendFileSync(projectLog, JSON.stringify({ ...ev, timestamp: new Date().toISOString() }) + '\n'); } catch {} };
  writeEvent({ type: 'user_prompt', text: promptForLog, pipeline: { run, pipeline: state.pipeline, mode: state.mode, answer },
    ...(sourceProject ? { source: sourceProject } : {}), ...(callbackProject ? { callback: callbackProject } : {}), ...(testLabel ? { test: { label: testLabel } } : {}) });
  const save = () => { state.updatedAt = new Date().toISOString(); fs.writeFileSync(`${f}.tmp`, JSON.stringify(state, null, 2)); fs.renameSync(`${f}.tmp`, f); };
  let text, paused = false;
  if (answer === 'tester le model') {
    // 0.60.0: a short trial of the step's model, with its full log; still paused.
    const last = [...(state.steps || [])].reverse().find(s => s.slot && s.model) || {};
    const root = path.dirname(logsDir);
    const t = await runModelTest({ root, provider: last.provider, model: last.model, label: `${projectName} ${run} (réponse « tester le model »)` });
    const rel = path.relative(root, t.logFile).split(path.sep).join('/');
    writeEvent({ type: 'system', subtype: 'pipeline_model_test', pipeline: { run, slot: last.slot }, model: last.model, status: t.ok ? 'ok' : 'failed',
      ok: t.ok, why: t.why, served: t.served, ms: t.ms, logFile: rel, logName: t.logName, text: `🔬 test du model ${last.model} : ${t.ok ? 'il répond' : `échec — ${t.why}`} (journal : ${rel})` });
    text = `🔬 Test de ${last.model || 'le model'} (case « ${last.slot || '?'} ») : ${t.ok ? `**il répond** (${Math.round(t.ms / 1000)} s). L’indisponibilité était passagère.` : `**échec** — ${t.why}.`}\n\nJournal complet (commande, code de sortie, messages d’erreur) : \`${rel}\`.\n\n`
      + `NEEDS_USER_INPUT: ${projectName} attend toujours — répondez « continuer »${t.ok ? ' (je recommande : le model répond)' : ''}, « changer le model » (case « ${last.slot || '?'} » de la page Models, puis « continuer ») ou « abandonner ».`;
    paused = true;
  } else if (answer === 'changer le model') {
    const last = [...(state.steps || [])].reverse().find(s => s.slot) || {};
    text = `D’accord. Ouvrez la page Models et choisissez un autre model pour l’étape « ${plainStep(last.id)} »${last.slot ? ` (case « ${last.slot} »${last.model ? `, actuellement ${last.model}` : ''})` : ''}. Le changement est pris en compte tout de suite, sans redémarrage.\n\nNEEDS_USER_INPUT: ${projectName} attend toujours : une fois le model changé dans la page Models, répondez « continuer » pour reprendre là où je me suis arrêté.`;
    paused = true;
  } else {
    const changed = git(project.path, ['status', '--porcelain']).out.split('\n').filter(l => l && !isLocalOnly(l.slice(3))).map(l => l.slice(3));
    state.status = 'abandoned'; state.abandonedBy = answer; state.endedAt = new Date().toISOString();
    save();
    writeEvent({ type: 'system', subtype: 'pipeline_summary', pipeline: { run, pipeline: state.pipeline, mode: state.mode, status: 'abandoned' },
      text: `exécution ${run} arrêtée à la demande de l’utilisateur (« ${answer} ») — rien n’est livré` });
    text = `■ Exécution arrêtée à votre demande (« ${answer} »). Rien n’est livré, aucun commit n’a été fait.\n\n` +
      (changed.length
        ? `Les modifications déjà faites restent dans le projet, non enregistrées dans git (vous pouvez les examiner, les garder ou les annuler) :\n${changed.slice(0, 30).map(c => `- ${c}`).join('\n')}${changed.length > 30 ? `\n- … et ${changed.length - 30} autre(s)` : ''}`
        : 'Aucune modification n’est restée dans le projet.') +
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

/** Annule les modifications d'un essai refusé (fichiers seulement, jamais les artefacts). */
function restoreFiles(cwd, before, after, resetTo) {
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
