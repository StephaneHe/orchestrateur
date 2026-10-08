// ============================================================================
// scripts/model-routing.mjs — vue « Models par tâche » (0.39.0 → 0.40.0)
// ============================================================================
//
// Demande utilisateur : voir l'enchaînement des tâches et assigner à chacune
// un model (Anthropic, OpenAI, NVIDIA, OpenRouter) dans un menu déroulant.
// 0.40.0 : 13 pipelines (scripts/model-pipelines.mjs) ; une « case » = une
// étape ou une variante d'étape ; capacités par model (vision, génération
// d'image, audio…) et outils locaux réellement installés.
//
// Ce module ne fait QUE le catalogue et l'enregistrement des choix. Rien ici
// n'est lu par dispatch.mjs : le branchement viendra plus tard.
//
// - Les choix vivent dans `model-routing.json` (racine, non versionné), écrit
//   seulement par le serveur, en temp + rename. PAS dans config.json, partagé
//   par plusieurs chefs. L'ancien format (20 types, version 1) est migré à la
//   première lecture ; ce qui n'a pas pu l'être est consigné dans `migration`.
// - Aucune clé n'est lue pour être affichée, journalisée ou copiée. Pour
//   OpenRouter on ne rapporte que « présente (où) / absente ». Les listes
//   NVIDIA et OpenRouter sont publiques : aucune clé n'est envoyée.
// ============================================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { PIPELINES, LEGACY_MAP, LOCAL_TOOLS, CAPS, slotsOf, applyCustom } from './model-pipelines.mjs';

export { PIPELINES, LEGACY_MAP, LOCAL_TOOLS, CAPS };

export const SLOTS = slotsOf();
export const PROVIDERS = ['anthropic', 'openai', 'nvidia', 'openrouter', 'local'];
export const LLM_PROVIDERS = ['anthropic', 'openai', 'nvidia', 'openrouter'];
export const PROVIDER_LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', nvidia: 'NVIDIA', openrouter: 'OpenRouter', local: 'Outil local / non-LLM' };

// Aucune liste publique sans clé API côté Anthropic (et aucune clé payante ne
// doit être ajoutée) : on garde les identifiants vérifiés avec la CLI claude.
// Tous lisent les images ; aucun ne génère d'image ni ne traite l'audio.
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
// Ni dialogue ni média utile ici : embeddings, filtres, scores, détecteurs.
const NVIDIA_EXCLUDE = /embed|safety|guard|reward|rerank|retriev|nvclip|detector|topic-control/i;
// Le catalogue NVIDIA ne donne que des identifiants : capacités déduites du nom.
const NVIDIA_CAPS = [
  ['vision',    /vision|vila|neva|kosmos|fuyu|deplot|omni|cosmos-reason|nemotron-parse|vlm|paligemma/i],
  ['video-in',  /cosmos-reason|omni/i],
  ['audio-in',  /omni|parakeet|canary|whisper|asr/i],
  ['audio-out', /tts|fastpitch|magpie|radtts/i],
  ['image-gen', /flux|stable-diffusion|sdxl|sana|edify|bria|consistory/i],
];
const NVIDIA_NOT_TEXT = /deplot|kosmos|fuyu|nemotron-parse|parakeet|canary|fastpitch|magpie|radtts|flux|stable-diffusion|sdxl/i;

export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@+~-]{0,159}$/;
export const SLOT_RE = /^[a-z0-9-]+(\.[a-z0-9-]+){1,2}$/;
export const HISTORY_MAX = 500;

/** Capacités d'un model OpenRouter, d'après ses modalités publiées. */
function openrouterCaps(m) {
  const a = m.architecture || {};
  const inp = a.input_modalities || ['text'];
  const out = a.output_modalities || ['text'];
  const caps = [];
  const tools = Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools');
  if (out.includes('text') && tools) caps.push('text');
  if (inp.includes('image')) caps.push('vision');
  if (inp.includes('video')) caps.push('video-in');
  if (inp.includes('audio')) caps.push('audio-in');
  if (out.includes('image')) caps.push('image-gen');
  if (out.includes('audio')) caps.push('audio-out');
  return caps;
}

function nvidiaCaps(id) {
  const caps = NVIDIA_NOT_TEXT.test(id) ? [] : ['text'];
  for (const [cap, re] of NVIDIA_CAPS) if (re.test(id)) caps.push(cap);
  return caps;
}

// Fournisseurs dotés d'un harnais d'agent (lire, écrire, exécuter, permissions
// par projet, traçage system/init). NVIDIA et OpenRouter : outillage en
// construction (docs/PLAN-pipeline-enforcement.md, phase « Outillage ») — ils
// restent proposés, mais seulement pour les étapes de jugement.
export const AGENT_HARNESS = { anthropic: true, openai: true, nvidia: false, openrouter: false };
export const HARNESS_PENDING_MSG = 'outillage d’agent en construction : NVIDIA et OpenRouter ne peuvent pas encore lire, écrire ni exécuter — étapes de jugement seulement';

/** Une case accepte-t-elle ce model / cet outil ? Renvoie null si oui, sinon la raison. */
export function incompatibility(need, provider, entry, slot) {
  if (need.llm === 'text' && slot && !slot.judge && AGENT_HARNESS[provider] === false) return HARNESS_PENDING_MSG;
  if (provider === 'local') {
    if (!need.local?.length) return 'aucun outil local ne convient à cette étape';
    if (!entry) return null;
    if (!entry.caps.some(c => need.local.includes(c))) return 'cet outil ne sait pas faire cette étape';
    if (!entry.installed) return 'outil non installé sur cette machine';
    return null;
  }
  if (!need.llm) return 'cette étape demande un outil local, pas un LLM';
  if (!entry) return null;
  if (!entry.caps?.includes(need.llm)) return `pas de capacité « ${CAPS[need.llm]} »`;
  return null;
}

/**
 * @param {object} o
 * @param {string} o.root       racine de l'orchestrateur (model-routing.json, .env, scripts/dispatch.mjs)
 * @param {string} o.cacheFile  cache du catalogue (logs/, non versionné)
 * @param {Function} [o.fetch]  injectable pour les tests
 * @param {object} [o.env]      process.env par défaut
 * @param {Function} [o.which]  (bins, pyModules) → Promise<{bins:Set, py:Set}>, injectable
 */
export function createModelRouting({ root, cacheFile, fetch: fetchImpl = globalThis.fetch, env = process.env, which } = {}) {
  const routingFile = path.join(root, 'model-routing.json');
  // Instance de non-régression : listes lues dans des fichiers, aucun réseau.
  const fixturesDir = env.MODEL_CATALOG_FIXTURES || null;
  let catalog = null;          // dernier catalogue servi
  let refreshing = null;       // promesse en cours (une seule à la fois)

  // ── Enregistrement ─────────────────────────────────────────────────────────
  function emptyRouting() { return { version: 2, updatedAt: null, assignments: {}, history: [] }; }

  /** Ancien format (0.39.0, clés = 20 types) → cases des pipelines. */
  function migrate(old) {
    const at = new Date().toISOString();
    const data = { version: 2, updatedAt: at, assignments: {}, history: Array.isArray(old.history) ? old.history : [] };
    const mapped = [], lost = [];
    for (const [key, a] of Object.entries(old.assignments || {})) {
      const targets = LEGACY_MAP[key];
      if (!targets || !a?.provider || !a?.model) { lost.push({ from: key, model: a ? `${a.provider}:${a.model}` : null, reason: targets ? 'affectation illisible' : 'type de tâche sans équivalent' }); continue; }
      for (const slot of targets) {
        data.assignments[slot] = { provider: a.provider, model: a.model, at };
        data.history.push({ at, task: slot, from: null, to: `${a.provider}:${a.model}`, by: `migration 0.40.0 (${key})` });
      }
      mapped.push({ from: key, to: targets, model: `${a.provider}:${a.model}` });
    }
    if (data.history.length > HISTORY_MAX) data.history = data.history.slice(-HISTORY_MAX);
    data.migration = { at, fromVersion: 1, mapped, lost };
    return data;
  }

  function readRouting() {
    let j;
    try { j = JSON.parse(fs.readFileSync(routingFile, 'utf8')); } catch { return emptyRouting(); }
    if (!j || typeof j !== 'object') return emptyRouting();
    if (j.version !== 2) {
      const m = migrate(j);
      try {
        fs.copyFileSync(routingFile, `${routingFile}.v1-bak`);
        writeRouting(m);
      } catch { /* lecture seule : on sert quand même la version migrée */ }
      return m;
    }
    // Tous les champs sont conservés (custom, gapDecisions…) : une écriture ne
    // doit jamais perdre ce qu'une autre fonction a enregistré.
    return {
      ...j,
      version: 2,
      updatedAt: j.updatedAt || null,
      assignments: j.assignments && typeof j.assignments === 'object' ? j.assignments : {},
      history: Array.isArray(j.history) ? j.history : [],
    };
  }

  /** Pipelines et cases effectifs : le code + les ajouts acceptés (custom). */
  function effective(data = readRouting()) {
    const pipelines = applyCustom(data.custom);
    return { pipelines, slots: slotsOf(pipelines) };
  }

  /** Mots-clés des lacunes acceptées, pour le classifieur (pipeline-observe). */
  function classifierExtras() {
    const c = readRouting().custom || {};
    return [
      ...(c.pipelines || []).map(p => ({ pipeline: p.id, keywords: p.keywords || [] })),
      ...(c.attach || []).map(a => ({ pipeline: a.pipeline, keywords: a.keywords || [] })),
    ].filter(x => x.pipeline && x.keywords.length);
  }

  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const clean = (t, n = 160) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

  /**
   * Décision sur une lacune signalée (règle utilisateur du 2026-10-08) :
   * « Accepter » applique la proposition (ou l'alternative) à la structure
   * locale, puis l'utilisateur choisit le model de la nouvelle case ; « Rejeter »
   * la retire de la liste. `gap` vient du journal d'observation, jamais du client.
   */
  function decideGap(gap, decision, { choice = 'primary', by = 'dashboard' } = {}) {
    if (!gap?.key) return { ok: false, status: 404, error: 'lacune inconnue' };
    const data = readRouting();
    data.gapDecisions = data.gapDecisions || {};
    if (data.gapDecisions[gap.key]) return { ok: false, status: 409, error: 'lacune déjà traitée' };
    const at = new Date().toISOString();
    if (decision === 'reject') {
      data.gapDecisions[gap.key] = { decision: 'rejected', at, by: clean(by, 40) };
      data.updatedAt = at;
      writeRouting(data);
      return { ok: true, status: 200, decision: 'rejected' };
    }
    if (decision !== 'accept') return { ok: false, status: 400, error: 'décision inconnue' };
    const prop = choice === 'alternative' ? gap.alternative : gap.proposal;
    if (!prop?.kind) return { ok: false, status: 400, error: 'aucune proposition à appliquer' };
    const cur = effective(data);
    const custom = data.custom = data.custom || {};
    const keywords = (Array.isArray(prop.keywords) ? prop.keywords : []).map(k => clean(k, 30).toLowerCase()).filter(Boolean).slice(0, 6);
    const head = clean(gap.entries?.[0]?.head || gap.why, 120);
    let applied;
    if (prop.kind === 'pipeline') {
      let id = String(prop.id || '').toLowerCase();
      if (!SLUG_RE.test(id)) return { ok: false, status: 400, error: 'identifiant de pipeline invalide' };
      for (let i = 2; cur.pipelines.some(p => p.id === id); i++) id = `${String(prop.id).slice(0, 36)}-${i}`;
      const label = clean(prop.label || id, 60);
      custom.pipelines = custom.pipelines || [];
      custom.pipelines.push({
        id, label, icon: '✦', keywords,
        purpose: `Ajouté depuis une lacune signalée et acceptée : « ${head} ».`,
        when: `Demandes du type « ${head} ».`,
        flow: [
          { id: 'cadrer', n: '1', title: 'Cadrer', what: 'Préciser ce qui est attendu et comment le vérifier.', example: head, judge: true },
          { id: 'realiser', n: '2', title: 'Réaliser', what: 'Faire le travail demandé.', example: head },
          { id: 'verifier', n: '3', title: 'Vérifier', what: 'Contrôler le résultat contre ce qui a été cadré.', example: head, returns: [{ to: 'realiser', label: 'à reprendre → retour à 2' }] },
          { id: 'livrer', n: '4', title: 'Livrer', what: 'Remettre le résultat, au bon endroit.', example: head },
        ],
      });
      applied = { kind: 'pipeline', pipeline: id, slot: `${id}.realiser`, label };
    } else if (prop.kind === 'rattachement') {
      if (!cur.pipelines.some(p => p.id === prop.pipeline)) return { ok: false, status: 400, error: 'pipeline cible inconnu' };
      custom.attach = custom.attach || [];
      custom.attach.push({ pipeline: prop.pipeline, keywords, when: `« ${head} »` });
      applied = { kind: 'rattachement', pipeline: prop.pipeline, slot: cur.slots.find(x => x.pipeline === prop.pipeline)?.id || null };
    } else if (prop.kind === 'variante' || prop.kind === 'etape') {
      const p = cur.pipelines.find(x => x.id === prop.pipeline);
      const steps = p ? p.flow.flatMap(n => (n.kind === 'loop' ? n.steps : [n])) : [];
      const target = steps.find(x => x.id === (prop.kind === 'variante' ? prop.step : prop.after));
      if (!p || !target) return { ok: false, status: 400, error: 'étape cible inconnue' };
      const id = String(prop.id || '').toLowerCase();
      if (!SLUG_RE.test(id)) return { ok: false, status: 400, error: 'identifiant invalide' };
      const label = clean(prop.label || id, 60);
      if (prop.kind === 'variante') {
        if ((target.variants || []).some(v => v.id === id)) return { ok: false, status: 409, error: 'variante déjà présente' };
        custom.variants = custom.variants || [];
        custom.variants.push({ pipeline: p.id, step: target.id, variant: { id, label, what: clean(prop.what || head) } });
        applied = { kind: 'variante', pipeline: p.id, slot: `${p.id}.${target.id}.${id}`, label };
      } else {
        if (steps.some(x => x.id === id)) return { ok: false, status: 409, error: 'étape déjà présente' };
        custom.steps = custom.steps || [];
        custom.steps.push({ pipeline: p.id, after: target.id, step: { id, n: `${target.n}+`, title: label, what: clean(prop.what || head), example: head } });
        applied = { kind: 'etape', pipeline: p.id, slot: `${p.id}.${id}`, label };
      }
    } else {
      return { ok: false, status: 400, error: `sorte de proposition inconnue : ${prop.kind}` };
    }
    data.gapDecisions[gap.key] = { decision: 'accepted', choice, at, by: clean(by, 40), applied };
    data.history.push({ at, task: applied.slot || applied.pipeline, from: null, to: `lacune acceptée : ${prop.text || prop.kind}`.slice(0, 200), by: clean(by, 40) });
    if (data.history.length > HISTORY_MAX) data.history = data.history.slice(-HISTORY_MAX);
    data.updatedAt = at;
    writeRouting(data);
    return { ok: true, status: 200, decision: 'accepted', applied };
  }

  function gapDecisions() { return readRouting().gapDecisions || {}; }

  function writeRouting(data) {
    const tmp = `${routingFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, routingFile);
  }

  function fmt(a) { return a ? `${a.provider}:${a.model}` : null; }

  /**
   * `choice` = null → valeur héritée (étape, puis défaut du projet). Sinon
   * `{provider, model}`. Renvoie `{ok, status, error?, assignment?, changed?}`.
   */
  /**
   * `role` = 'principal' (défaut) ou 'second' (0.44.0, mode double model :
   * « on peut donner 2 models (1 par defaut) »). Le second exige un principal
   * sur la même case ; retirer le principal retire aussi le second.
   */
  function setAssignment(slotId, choice, by, role = 'principal') {
    if (role !== 'principal' && role !== 'second') return { ok: false, status: 400, error: `rôle inconnu : ${role}` };
    const slot = effective().slots.find(s => s.id === slotId);
    if (!slot) return { ok: false, status: 404, error: `case inconnue : ${slotId}` };
    let next = null;
    if (choice) {
      const { provider, model } = choice;
      if (!PROVIDERS.includes(provider)) return { ok: false, status: 400, error: `fournisseur inconnu : ${provider}` };
      if (typeof model !== 'string' || !MODEL_ID_RE.test(model)) return { ok: false, status: 400, error: 'identifiant de model invalide' };
      if (provider === 'openrouter' && !openrouterKey().present) {
        return { ok: false, status: 409, error: 'clé OpenRouter non configurée' };
      }
      const cat = catalog?.providers?.[provider];
      const entry = cat?.models?.find(m => m.id === model);
      // Liste connue et non vide : le model doit y figurer. Liste vide (source
      // injoignable) : on accepte un identifiant bien formé plutôt que bloquer.
      if (cat && cat.models.length && !entry) {
        return { ok: false, status: 400, error: `absent de la liste ${PROVIDER_LABELS[provider]} : ${model}` };
      }
      const why = incompatibility(slot.need, provider, entry, slot);
      const pending = why === HARNESS_PENDING_MSG;
      if (why) return { ok: false, status: pending || (provider === 'local' && entry && !entry.installed) ? 409 : 400, error: `incompatible avec « ${slot.label} » : ${why}` };
      next = { provider, model };
    }
    const data = readRouting();
    const cur = data.assignments[slotId] || null;
    const who = typeof by === 'string' ? by.slice(0, 40) : 'dashboard';
    const at = new Date().toISOString();
    if (role === 'second') {
      if (next && !cur) return { ok: false, status: 409, error: 'choisissez d’abord le model principal de cette case' };
      const prevSecond = cur?.second || null;
      if (fmt(prevSecond) === fmt(next)) return { ok: true, status: 200, assignment: cur, changed: false, updatedAt: data.updatedAt };
      if (next) cur.second = { ...next, at };
      else if (cur) delete cur.second;
      data.history.push({ at, task: slotId, role: 'second', from: fmt(prevSecond), to: fmt(next), by: who });
      if (data.history.length > HISTORY_MAX) data.history = data.history.slice(-HISTORY_MAX);
      data.updatedAt = at;
      writeRouting(data);
      const sameModel = !!(next && cur && next.provider === cur.provider && next.model === cur.model);
      return { ok: true, status: 200, assignment: data.assignments[slotId] || null, changed: true, updatedAt: at, ...(sameModel ? { warning: 'principal et second identiques : le mode double n’apporte presque rien' } : {}) };
    }
    const prev = cur ? { provider: cur.provider, model: cur.model } : null;
    if (fmt(prev) === fmt(next)) return { ok: true, status: 200, assignment: cur, changed: false, updatedAt: data.updatedAt };
    if (next) data.assignments[slotId] = { ...next, at, ...(cur?.second ? { second: cur.second } : {}) };
    else {
      if (cur?.second) data.history.push({ at, task: slotId, role: 'second', from: fmt(cur.second), to: null, by: `${who} (principal retiré)` });
      delete data.assignments[slotId];
    }
    data.history.push({ at, task: slotId, from: fmt(prev), to: fmt(next), by: who });
    if (data.history.length > HISTORY_MAX) data.history = data.history.slice(-HISTORY_MAX);
    data.updatedAt = at;
    writeRouting(data);
    return { ok: true, status: 200, assignment: data.assignments[slotId] || null, changed: true, updatedAt: at };
  }

  function view(historyN = 50) {
    const data = readRouting();
    const eff = effective(data);
    return {
      pipelines: eff.pipelines,
      slots: eff.slots,
      caps: CAPS,
      agentHarness: AGENT_HARNESS,
      harnessPending: HARNESS_PENDING_MSG,
      assignments: data.assignments,
      updatedAt: data.updatedAt,
      history: data.history.slice(-historyN).reverse(),
      historyTotal: data.history.length,
      migration: data.migration || null,
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
      models: ANTHROPIC_VERIFIED.models.map(id => ({ id, label: id, caps: ['text', 'vision'] })),
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
          caps: ['text', ...((m.input_modalities || []).includes('image') ? ['vision'] : [])],
        }));
      return {
        models: list,
        source: 'models_cache.json de codex (génération d’image, STT et TTS d’OpenAI : seulement via OpenRouter, sans clé OpenAI payante)',
        fetchedAt: j.fetched_at || null,
      };
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
      live = (Array.isArray(j.data) ? j.data : []).map(m => m?.id).filter(id => typeof id === 'string' && MODEL_ID_RE.test(id) && !NVIDIA_EXCLUDE.test(id));
    } catch (e) { error = `liste NVIDIA injoignable (${e.message})`; }
    const liveSet = new Set(live);
    const models = cascade.map((id, i) => ({
      id,
      label: `${id} — failover n° ${i + 1}` + (live.length && !liveSet.has(id) ? ' (absent du catalogue NVIDIA)' : ''),
      cascade: i + 1,
      missing: live.length > 0 && !liveSet.has(id),
      caps: nvidiaCaps(id),
    }));
    for (const id of live.sort()) {
      if (cascade.includes(id)) continue;
      const caps = nvidiaCaps(id);
      if (caps.length) models.push({ id, label: id, caps });
    }
    return {
      models,
      source: 'cascade du failover (dispatch.mjs) + liste publique integrate.api.nvidia.com (capacités déduites du nom)',
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
      // Texte : seulement les models qui savent appeler des outils (agents).
      // Média : tout model qui a la capacité, outils ou pas.
      models = all
        .filter(m => typeof m?.id === 'string' && MODEL_ID_RE.test(m.id))
        .map(m => ({ id: m.id, label: m.id, caps: openrouterCaps(m) }))
        .filter(m => m.caps.length)
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch (e) { error = `liste OpenRouter injoignable (${e.message})`; }
    return {
      models,
      total,
      filter: 'models à outils, ou dotés d’une capacité média',
      source: 'liste publique openrouter.ai (sans clé)',
      fetchedAt: new Date().toISOString(),
      keyPresent: key.present,
      keyWhere: key.where,
      disabled: !key.present,
      ...(error ? { error } : {}),
    };
  }

  /** Cherche les exécutables et modules Python des outils locaux. */
  function defaultWhich(bins, pyMods) {
    const run = (cmd, args) => new Promise(resolve => {
      execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout)));
    });
    const finder = process.platform === 'win32' ? 'where' : 'which';
    return Promise.all([
      Promise.all(bins.map(b => run(finder, [b]).then(out => (out && out.trim() ? b : null)))),
      run('python', ['-c', `import importlib.util as u;print(','.join(m for m in ${JSON.stringify(pyMods)} if u.find_spec(m)))`]),
    ]).then(([found, py]) => ({ bins: new Set(found.filter(Boolean)), py: new Set((py || '').trim().split(',').filter(Boolean)) }));
  }

  async function localSource() {
    let found;
    try {
      if (fixturesDir) {
        const j = JSON.parse(await fsp.readFile(path.join(fixturesDir, 'local-tools.json'), 'utf8'));
        found = { bins: new Set(j.bins || []), py: new Set(j.py || []) };
      } else {
        found = await (which || defaultWhich)(LOCAL_TOOLS.filter(t => t.bin).map(t => t.bin), LOCAL_TOOLS.filter(t => t.py).map(t => t.py));
      }
    } catch { found = { bins: new Set(), py: new Set() }; }
    const models = LOCAL_TOOLS.map(t => {
      const installed = t.always === true || (t.always === 'win32' && process.platform === 'win32')
        || (t.bin && found.bins.has(t.bin)) || (t.py && found.py.has(t.py)) || false;
      return { id: t.id, label: t.label + (installed ? '' : ' (non installé)'), caps: t.caps, installed };
    });
    return {
      models,
      source: 'outils détectés sur cette machine (PATH, modules Python), plus la synthèse vocale intégrée',
      fetchedAt: new Date().toISOString(),
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
      const [openai, nvidia, openrouter, local] = await Promise.all([openaiSource(), nvidiaSource(), openrouterSource(), localSource()]);
      const keep = (name, fresh) => (!fresh.error || !prev?.providers?.[name]?.models?.length)
        ? fresh
        : { ...prev.providers[name], error: fresh.error, stale: true };
      const next = {
        schema: 2,
        builtAt: new Date().toISOString(),
        providers: {
          anthropic: anthropicSource(),
          openai: keep('openai', openai),
          nvidia: keep('nvidia', nvidia),
          openrouter: { ...keep('openrouter', openrouter), keyPresent: openrouter.keyPresent, keyWhere: openrouter.keyWhere, disabled: openrouter.disabled },
          local,
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
      // Cache d'avant 0.40.0 : pas de capacités ni d'outils locaux → on refait.
      if (c?.providers && c.schema === 2) catalog = c;
      else return refresh();
    }
    // La présence de la clé et la liste codex sont relues à chaque fois : peu coûteux.
    const key = openrouterKey();
    catalog.providers.openrouter = { ...catalog.providers.openrouter, keyPresent: key.present, keyWhere: key.where, disabled: !key.present };
    catalog.providers.openai = await openaiSource().then(o => (o.models.length ? o : catalog.providers.openai));
    catalog.providers.anthropic = anthropicSource();
    return catalog;
  }

  return { view, setAssignment, getCatalog, refresh, openrouterKey, routingFile, readRouting, effective, classifierExtras, decideGap, gapDecisions };
}
