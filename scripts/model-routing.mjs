// ============================================================================
// scripts/model-routing.mjs — vue « Models par tâche » (0.39.0)
// ============================================================================
//
// Demande utilisateur : une interface où l'on voit l'enchaînement des types de
// tâche et où l'on assigne à chacun un model (Anthropic, OpenAI, NVIDIA,
// OpenRouter) dans un menu déroulant.
//
// Ce module ne fait QUE le catalogue des models et l'enregistrement des choix.
// Rien ici n'est lu par dispatch.mjs : le branchement viendra plus tard.
//
// - Les choix vivent dans `model-routing.json` (racine, non versionné), écrit
//   seulement par le serveur, en temp + rename. PAS dans config.json, qui est
//   partagé par plusieurs chefs.
// - Aucune clé n'est lue pour être affichée, journalisée ou copiée. Pour
//   OpenRouter on ne rapporte que « présente (où) / absente ». La clé NVIDIA
//   n'est jamais envoyée : la liste publique des models se lit sans clé.
// ============================================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const STAGES = [
  { id: 'reflechir',  label: 'Réfléchir' },
  { id: 'ecrire',     label: 'Écrire' },
  { id: 'corriger',   label: 'Corriger' },
  { id: 'verifier',   label: 'Vérifier' },
  { id: 'livrer',     label: 'Livrer / opérer' },
  { id: 'documenter', label: 'Écrire sur le code' },
];

export const TASK_TYPES = [
  { n: 1,  id: 'architecture',     stage: 'reflechir',  label: 'Architecture / conception',  description: 'Choisir la structure, les modules, les compromis avant d’écrire.' },
  { n: 2,  id: 'plan',             stage: 'reflechir',  label: 'Plan d’implémentation',       description: 'Découper le travail en étapes ordonnées et vérifiables.' },
  { n: 3,  id: 'etude-codebase',   stage: 'reflechir',  label: 'Étude de codebase',           description: 'Lire et comprendre un projet existant, cartographier le code.' },
  { n: 4,  id: 'feature-complexe', stage: 'ecrire',     label: 'Feature complexe',            description: 'Fonctionnalité qui touche plusieurs modules ou un algorithme délicat.' },
  { n: 5,  id: 'feature-simple',   stage: 'ecrire',     label: 'Feature simple',              description: 'Ajout localisé, bien délimité, peu de risques.' },
  { n: 6,  id: 'edits-mecaniques', stage: 'ecrire',     label: 'Edits mécaniques',            description: 'Renommages, remplacements en série, mises en forme.' },
  { n: 7,  id: 'refactoring',      stage: 'ecrire',     label: 'Refactoring',                 description: 'Restructurer sans changer le comportement.' },
  { n: 8,  id: 'migration',        stage: 'ecrire',     label: 'Migration',                   description: 'Changer de version, de bibliothèque ou de format de données.' },
  { n: 9,  id: 'debug-simple',     stage: 'corriger',   label: 'Debug simple',                description: 'Bug reproductible, cause probable évidente.' },
  { n: 10, id: 'debug-difficile',  stage: 'corriger',   label: 'Debug difficile',             description: 'Bug intermittent, concurrence, cause inconnue.' },
  { n: 11, id: 'analyse-crash',    stage: 'corriger',   label: 'Analyse de crash / logs',     description: 'Lire des traces, des logs, un dump pour trouver la cause.' },
  { n: 12, id: 'tests',            stage: 'verifier',   label: 'Écriture de tests',           description: 'Tests unitaires, d’intégration, de non-régression.' },
  { n: 13, id: 'revue',            stage: 'verifier',   label: 'Revue de code',               description: 'Relire un changement : défauts, lisibilité, cohérence.' },
  { n: 14, id: 'audit-securite',   stage: 'verifier',   label: 'Audit sécurité',              description: 'Chercher les failles : injection, secrets, droits, surface d’attaque.' },
  { n: 15, id: 'second-avis',      stage: 'verifier',   label: 'Second avis / contradiction', description: 'Un autre model conteste une conclusion ou un plan.' },
  { n: 16, id: 'build-deploiement',stage: 'livrer',     label: 'Build / déploiement',         description: 'Compiler, publier un APK, déployer un service.' },
  { n: 17, id: 'git',              stage: 'livrer',     label: 'Opérations git',              description: 'Commits, branches, tags, résolution de conflits.' },
  { n: 18, id: 'device-e2e',       stage: 'livrer',     label: 'Pilotage device / E2E',       description: 'Piloter un téléphone, un navigateur, des parcours de bout en bout.' },
  { n: 19, id: 'documentation',    stage: 'documenter', label: 'Documentation technique',     description: 'README, guides, commentaires d’API.' },
  { n: 20, id: 'synthese',         stage: 'documenter', label: 'Synthèse / rapport',          description: 'Résumer un travail, un état, des résultats pour décider.' },
];

export const PROVIDERS = ['anthropic', 'openai', 'nvidia', 'openrouter'];
export const PROVIDER_LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', nvidia: 'NVIDIA', openrouter: 'OpenRouter' };

// Aucune liste publique sans clé API côté Anthropic (et aucune clé payante ne
// doit être ajoutée) : on garde les identifiants vérifiés avec la CLI claude.
export const ANTHROPIC_VERIFIED = {
  checkedAt: '2026-10-08',
  models: [
    'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8',
    'claude-sonnet-5-5', 'claude-sonnet-5',
    'claude-fable-5-1', 'claude-fable-5',
    'claude-haiku-4-5-20251001',
  ],
};

const NVIDIA_MODELS_URL     = 'https://integrate.api.nvidia.com/v1/models';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
// Models NVIDIA qui ne sont pas des models de dialogue (embeddings, filtres…).
const NVIDIA_NON_CHAT = /embed|safety|guard|reward|rerank|retriev|parse|ocr|clip|pii|detector|vila|cosmos|fuyu|kosmos|deplot|paligemma|neva|grounding|riva|asr|tts|audio2|vista|streampetr|bevformer|sparsedrive/i;

export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,159}$/;
export const HISTORY_MAX = 500;

/**
 * @param {object} o
 * @param {string} o.root       racine de l'orchestrateur (model-routing.json, .env, scripts/dispatch.mjs)
 * @param {string} o.cacheFile  cache du catalogue (logs/, non versionné)
 * @param {Function} [o.fetch]  injectable pour les tests
 * @param {object} [o.env]      process.env par défaut
 */
export function createModelRouting({ root, cacheFile, fetch: fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const routingFile = path.join(root, 'model-routing.json');
  // Instance de non-régression : listes lues dans des fichiers, aucun réseau.
  const fixturesDir = env.MODEL_CATALOG_FIXTURES || null;
  let catalog = null;          // dernier catalogue servi
  let refreshing = null;       // promesse en cours (une seule à la fois)

  // ── Enregistrement ─────────────────────────────────────────────────────────
  function emptyRouting() { return { version: 1, updatedAt: null, assignments: {}, history: [] }; }

  function readRouting() {
    try {
      const j = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
      if (!j || typeof j !== 'object') return emptyRouting();
      return {
        version: 1,
        updatedAt: j.updatedAt || null,
        assignments: j.assignments && typeof j.assignments === 'object' ? j.assignments : {},
        history: Array.isArray(j.history) ? j.history : [],
      };
    } catch { return emptyRouting(); }
  }

  function writeRouting(data) {
    const tmp = `${routingFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, routingFile);
  }

  function fmt(a) { return a ? `${a.provider}:${a.model}` : null; }

  /**
   * `choice` = null → « (défaut du projet) ». Sinon `{provider, model}`.
   * Renvoie `{ok, status, error?, assignment?, changed?}`.
   */
  function setAssignment(taskId, choice, by) {
    const task = TASK_TYPES.find(t => t.id === taskId);
    if (!task) return { ok: false, status: 404, error: `type de tâche inconnu : ${taskId}` };
    let next = null;
    if (choice) {
      const { provider, model } = choice;
      if (!PROVIDERS.includes(provider)) return { ok: false, status: 400, error: `fournisseur inconnu : ${provider}` };
      if (typeof model !== 'string' || !MODEL_ID_RE.test(model)) return { ok: false, status: 400, error: 'identifiant de model invalide' };
      const cat = catalog?.providers?.[provider];
      if (provider === 'openrouter' && !openrouterKey().present) {
        return { ok: false, status: 409, error: 'clé OpenRouter non configurée' };
      }
      // Liste connue et non vide : le model doit y figurer. Liste vide (source
      // injoignable) : on accepte un identifiant bien formé plutôt que bloquer.
      if (cat && cat.models.length && !cat.models.some(m => m.id === model)) {
        return { ok: false, status: 400, error: `model absent de la liste ${PROVIDER_LABELS[provider]} : ${model}` };
      }
      next = { provider, model };
    }
    const data = readRouting();
    const prev = data.assignments[taskId] || null;
    if (fmt(prev) === fmt(next)) return { ok: true, status: 200, assignment: next, changed: false, updatedAt: data.updatedAt };
    const at = new Date().toISOString();
    if (next) data.assignments[taskId] = { ...next, at };
    else delete data.assignments[taskId];
    data.history.push({ at, task: taskId, from: fmt(prev), to: fmt(next), by: typeof by === 'string' ? by.slice(0, 40) : 'dashboard' });
    if (data.history.length > HISTORY_MAX) data.history = data.history.slice(-HISTORY_MAX);
    data.updatedAt = at;
    writeRouting(data);
    return { ok: true, status: 200, assignment: data.assignments[taskId] || null, changed: true, updatedAt: at };
  }

  function view(historyN = 50) {
    const data = readRouting();
    return {
      stages: STAGES,
      tasks: TASK_TYPES,
      assignments: data.assignments,
      updatedAt: data.updatedAt,
      history: data.history.slice(-historyN).reverse(),
      historyTotal: data.history.length,
    };
  }

  // ── Clés : présence seulement ──────────────────────────────────────────────
  function dotEnvHas(name) {
    try {
      const raw = fs.readFileSync(path.join(root, '.env'), 'utf8');
      return raw.split(/\r?\n/).some(l => {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l);
        return m && m[1] === name && m[2].trim().replace(/^["']|["']$/g, '').length > 0;
      });
    } catch { return false; }
  }

  function openrouterKey() {
    const where = [];
    if (env.OPENROUTER_API_KEY && String(env.OPENROUTER_API_KEY).trim()) where.push('variable d’environnement OPENROUTER_API_KEY');
    if (dotEnvHas('OPENROUTER_API_KEY')) where.push('.env de l’orchestrateur');
    return { present: where.length > 0, where };
  }

  // ── Sources des listes ─────────────────────────────────────────────────────
  function anthropicSource() {
    return {
      models: ANTHROPIC_VERIFIED.models.map(id => ({ id, label: id })),
      source: `liste vérifiée avec la CLI claude (${ANTHROPIC_VERIFIED.checkedAt}) — pas de liste publique sans clé API`,
      fetchedAt: ANTHROPIC_VERIFIED.checkedAt,
    };
  }

  function codexHome() { return env.CODEX_HOME || path.join(os.homedir(), '.codex'); }

  async function openaiSource() {
    const file = path.join(fixturesDir || codexHome(), 'models_cache.json');
    try {
      const j = JSON.parse(await fsp.readFile(file, 'utf8'));
      const list = (Array.isArray(j.models) ? j.models : [])
        .filter(m => m && typeof m.slug === 'string' && MODEL_ID_RE.test(m.slug))
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
        .map(m => ({
          id: m.slug,
          label: m.slug + (m.visibility === 'hide' ? ' (masqué dans codex)' : ''),
          hint: typeof m.description === 'string' ? m.description.slice(0, 120) : undefined,
        }));
      return { models: list, source: 'models_cache.json de codex', fetchedAt: j.fetched_at || null };
    } catch (e) {
      return { models: [], source: 'models_cache.json de codex', fetchedAt: null, error: `lecture impossible (${e.code || e.message})` };
    }
  }

  /** Cascade du failover NVIDIA, lue dans dispatch.mjs (une seule source). */
  function nvidiaCascade() {
    try {
      const src = fs.readFileSync(path.join(root, 'scripts', 'dispatch.mjs'), 'utf8');
      const body = /function nvidiaFailoverConfig\(\)[\s\S]*?cascade:\s*\[([\s\S]*?)\]/.exec(src);
      if (!body) return [];
      return [...body[1].matchAll(/'([^']+)'/g)].map(m => m[1]).filter(id => MODEL_ID_RE.test(id));
    } catch { return []; }
  }

  async function getJson(url) {
    if (fixturesDir) {
      const name = url === NVIDIA_MODELS_URL ? 'nvidia.json' : 'openrouter.json';
      return JSON.parse(await fsp.readFile(path.join(fixturesDir, name), 'utf8'));
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async function nvidiaSource() {
    const cascade = nvidiaCascade();
    let live = [], error;
    try {
      const j = await getJson(NVIDIA_MODELS_URL);
      live = (Array.isArray(j.data) ? j.data : []).map(m => m?.id).filter(id => typeof id === 'string' && MODEL_ID_RE.test(id) && !NVIDIA_NON_CHAT.test(id));
    } catch (e) { error = `liste NVIDIA injoignable (${e.message})`; }
    const liveSet = new Set(live);
    const models = cascade.map((id, i) => ({
      id,
      label: `${id} — failover n° ${i + 1}` + (live.length && !liveSet.has(id) ? ' (absent du catalogue NVIDIA)' : ''),
      cascade: i + 1,
      missing: live.length > 0 && !liveSet.has(id),
    }));
    for (const id of live.sort()) if (!cascade.includes(id)) models.push({ id, label: id });
    return {
      models,
      source: 'cascade du failover (dispatch.mjs) + liste publique integrate.api.nvidia.com',
      fetchedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
  }

  async function openrouterSource() {
    const key = openrouterKey();
    let models = [], error, total = 0;
    try {
      const j = await getJson(OPENROUTER_MODELS_URL);
      const all = Array.isArray(j.data) ? j.data : [];
      total = all.length;
      // Pour du code, un model doit savoir appeler des outils.
      models = all
        .filter(m => typeof m?.id === 'string' && MODEL_ID_RE.test(m.id))
        .filter(m => Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'))
        .map(m => ({ id: m.id, label: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch (e) { error = `liste OpenRouter injoignable (${e.message})`; }
    return {
      models,
      total,
      filter: 'models capables d’appeler des outils',
      source: 'liste publique openrouter.ai (sans clé)',
      fetchedAt: new Date().toISOString(),
      keyPresent: key.present,
      keyWhere: key.where,
      disabled: !key.present,
      ...(error ? { error } : {}),
    };
  }

  function readCache() {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return null; }
  }
  function writeCache(c) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(c));
      fs.renameSync(tmp, cacheFile);
    } catch {}
  }

  /** Reconstruit tout. Une source injoignable garde sa dernière liste connue. */
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const prev = catalog || readCache();
      const [openai, nvidia, openrouter] = await Promise.all([openaiSource(), nvidiaSource(), openrouterSource()]);
      const keep = (name, fresh) => (!fresh.error || !prev?.providers?.[name]?.models?.length)
        ? fresh
        : { ...prev.providers[name], error: fresh.error, stale: true };
      const next = {
        builtAt: new Date().toISOString(),
        providers: {
          anthropic: anthropicSource(),
          openai: keep('openai', openai),
          nvidia: keep('nvidia', nvidia),
          openrouter: { ...keep('openrouter', openrouter), keyPresent: openrouter.keyPresent, keyWhere: openrouter.keyWhere, disabled: openrouter.disabled },
        },
      };
      catalog = next;
      writeCache(next);
      return next;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  async function getCatalog({ refresh: force = false } = {}) {
    if (force) return refresh();
    if (!catalog) {
      const c = readCache();
      if (c?.providers) catalog = c;
      else return refresh();
    }
    // La présence de la clé et la liste codex sont relues à chaque fois : peu coûteux.
    const key = openrouterKey();
    catalog.providers.openrouter = { ...catalog.providers.openrouter, keyPresent: key.present, keyWhere: key.where, disabled: !key.present };
    catalog.providers.openai = await openaiSource().then(o => (o.models.length ? o : catalog.providers.openai));
    catalog.providers.anthropic = anthropicSource();
    return catalog;
  }

  return { view, setAssignment, getCatalog, refresh, openrouterKey, routingFile, readRouting };
}
