#!/usr/bin/env node
// ============================================================================
// scripts/kg.mjs — knowledge index of the orchestrator, phase 0 b (no model)
// ============================================================================
//
// Knowledge-graph synthesis (docs/KG-SYNTHESE.md), user decisions of
// 2026-10-20 « tout comme recommandé »: an index of sourced, dated facts BUILT
// BY THE PROGRAM from the existing files, which stay the only truth. Phase 0 b:
// no model anywhere, nothing injected into any turn.
//
//   node scripts/kg.mjs build [--force] [--corpus <dir>] [--state <root>] [--runs <dir>] [--no-live]
//     --state <root>: read config.json and model-routing.json of another
//     installation (read only), e.g. the production one
//   node scripts/kg.mjs fiche <projet>          node scripts/kg.mjs regles [--projet p]
//   node scripts/kg.mjs impact <fichier>        node scripts/kg.mjs explique <id>
//   node scripts/kg.mjs historique <case>       node scripts/kg.mjs contradictions
//   node scripts/kg.mjs perimes                 node scripts/kg.mjs port-libre [--from n]
//   node scripts/kg.mjs mode [off|shadow|assist]
//   (every query accepts --json; --force runs while the mode is off)
//
// Rules (synthesis §3):
//   - single writer: this module, only under logs/kg/ (out of git) — plus the
//     `kg` block of model-routing.json for the switch (writeKgSettings);
//   - closed node types and predicates (NODE_TYPES, PREDICATES); a fact with an
//     unknown one is rejected;
//   - provenance on every fact: file:line + quote (≤ 200 chars) that the code
//     finds again in the source, JSON pointer, commit or run; otherwise rejected;
//   - functional predicates: one value per subject and scope; disagreement
//     between sources of the same authority = conflict, a source contradicted
//     by a higher authority (live state first) = stale (to review);
//   - secrets masked before anything is written; secret-bearing sources are
//     never read;
//   - switch `model-routing.json → kg.mode` = off | shadow | assist, re-read at
//     every call; absent = off = exactly the behaviour before (nothing runs,
//     nothing is written; no other module imports this one).
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileAtomic } from './atomic-file.mjs';
import '../public/permission-core.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KG_DIR = 'logs/kg';
export const ONTOLOGY_VERSION = 1;
export const MODES = ['off', 'shadow', 'assist'];
export const QUERY_BUDGET_MS = 100;

// ── Closed schema ─────────────────────────────────────────────────────────────
export const NODE_TYPES = [
  'projet', 'worktree', 'environnement', 'demande', 'tache', 'question', 'execution', 'etape',
  'pipeline', 'case', 'model', 'exigence', 'decision', 'regle', 'preference', 'garde_fou',
  'incident', 'cause_hypothese', 'fichier', 'suite', 'version', 'commit', 'service', 'port',
  'todo', 'document', 'flotte', 'composant',
];
/** predicate → functional (one active value per subject and scope). */
export const PREDICATES = {
  applies_to: false, exception_to: false, supersedes: false, contradicts: false,
  motivated_by: false, decided_in: false, protects: false, covers: false, belongs_to: false,
  depends_on: false, executed: false, refused_with: false, possible_cause_of: false,
  fixed_in: false, delivered_in: false, answered_with: false, mentions: false, cites: false,
  dev_of: true, runs_in: true, listens_on: true, has_state: true,
  default_model: true, routing_policy: true, project_count: true, assigned_model: true,
};
export const STATUSES = ['observed', 'proposed', 'validated', 'disputed', 'superseded', 'retracted', 'to_review'];
/** Live state wins (synthesis §3.1), then the user's written decisions, then documents. */
export const AUTHORITY_RANK = { live: 3, user: 2, document: 1 };
/** Staleness by type (synthesis §3.4): declared ports and services 60 days. */
export const STALE_DAYS = { port: 60 };
export const QUOTE_MAX = 200;

// Never read: secrets, raw musician logs, tokens (synthesis §3.4 last row).
const FORBIDDEN_SOURCES = [
  /(^|[\\/])\.env(\.|$)/i, /(^|[\\/])secrets[\\/]/i, /(^|[\\/])\.token$/i,
  /api-keys\.status\.json$/i, /(^|[\\/])logs[\\/][^\\/]+\.jsonl$/i, /\.orchestrateur-secret$/i,
];
export function forbiddenSource(file) { return FORBIDDEN_SOURCES.some(re => re.test(String(file))); }

const SECRET_EXTRA = [/\b[a-f0-9]{32,}\b/gi];
/** Masks every secret in a string (permission-core patterns + long hex tokens). */
export function scrubSecrets(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = globalThis.PermissionCore.maskSecrets(s);
  for (const re of SECRET_EXTRA) out = out.replace(re, (m) => /[a-f]/i.test(m) && /\d/.test(m) ? `••••${m.slice(-4)}` : m);
  return out;
}
function scrubDeep(v, depth = 0) {
  if (depth > 12) return v;
  if (typeof v === 'string') return scrubSecrets(v);
  if (Array.isArray(v)) return v.map(x => scrubDeep(x, depth + 1));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = scrubDeep(x, depth + 1); return o; }
  return v;
}

// ── Settings (hot switch) ─────────────────────────────────────────────────────
const rootOf = (root) => path.resolve(root || (process.env.DISPATCH_ROOT_FOR_TESTS ? process.env.DISPATCH_ROOT_FOR_TESTS : REPO_ROOT));

export function readKgSettings(root) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(rootOf(root), 'model-routing.json'), 'utf8')); } catch { /* absent */ }
  const k = j?.kg;
  const mode = MODES.includes(k?.mode) ? k.mode : 'off';
  return { mode, since: k?.since || null, by: k?.by || null };
}

/** Writes model-routing.json → kg {mode, since, by}; every other key is kept. */
export function writeKgSettings(root, { mode, by = 'kg mode' }) {
  if (!MODES.includes(mode)) throw new Error(`mode inconnu : ${mode} — connus : ${MODES.join(', ')}`);
  const file = path.join(rootOf(root), 'model-routing.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
  if (!j || typeof j !== 'object') j = {};
  const at = new Date().toISOString();
  const before = MODES.includes(j.kg?.mode) ? j.kg.mode : 'off';
  if (mode === 'off') delete j.kg; else j.kg = { mode, since: at, by };
  j.history = Array.isArray(j.history) ? j.history : [];
  j.history.push({ at, task: 'kg', from: before, to: mode, by });
  if (j.history.length > 500) j.history = j.history.slice(-500);
  writeFileAtomic(file, JSON.stringify(j, null, 2) + '\n', `${file}.${process.pid}.tmp`);
  return readKgSettings(root);
}

// ── Single writer under logs/kg/ ──────────────────────────────────────────────
function kgWrite(root, name, data) {
  const dir = path.join(rootOf(root), ...KG_DIR.split('/'));
  const file = path.resolve(dir, name);
  if (path.dirname(file) !== path.resolve(dir)) throw new Error(`écriture refusée hors de ${KG_DIR} : ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(file, data, `${file}.${process.pid}.tmp`);
  return file;
}

// ── Sources ───────────────────────────────────────────────────────────────────
const memSlug = (p) => path.resolve(p).replace(/[:\\/]/g, '-');
function claudeHome() { return process.env.ORCH_KG_CLAUDE_HOME || path.join(os.homedir(), '.claude'); }

/**
 * Real sources of the installation, or a corpus laid out as
 * <dir>/{config.json, model-routing.json, CLAUDE.md, memory/, docs/, runs/, listening.json}.
 */
export function resolveSources(root, { corpus = null, runs = null, live = true, state = null } = {}) {
  root = rootOf(root);
  // `state`: another installation whose config.json and model-routing.json are
  // the live state (read only) — the dev checkout only holds an old snapshot.
  const stateRoot = state ? path.resolve(state) : root;
  if (corpus) {
    const c = path.resolve(corpus);
    const listeningFile = path.join(c, 'listening.json');
    return {
      label: `corpus ${path.basename(c)}`, base: c,
      configFile: path.join(c, 'config.json'), routingFile: path.join(c, 'model-routing.json'),
      chefClaudeMd: path.join(c, 'CLAUDE.md'), memoryDirs: [{ owner: 'chef', dir: path.join(c, 'memory') }],
      docsDir: path.join(c, 'docs'), requirementsFile: path.join(c, 'docs', 'USER_REQUIREMENTS.md'),
      changelogFile: path.join(c, 'CHANGELOG.md'), todoFile: path.join(c, 'TODO_LIST.md'),
      runsDir: runs ? path.resolve(runs) : path.join(c, 'runs'), repo: null,
      listening: fs.existsSync(listeningFile) ? JSON.parse(fs.readFileSync(listeningFile, 'utf8')) : null,
      now: fs.existsSync(path.join(c, 'now.txt')) ? fs.readFileSync(path.join(c, 'now.txt'), 'utf8').trim() : null,
    };
  }
  let config = null;
  try { config = JSON.parse(fs.readFileSync(path.join(stateRoot, 'config.json'), 'utf8')); } catch { /* none */ }
  const chef = (config?.projects || []).find(p => p.name === 'chef');
  const chefPath = chef?.path || chef?.cwd || null;
  return {
    label: state ? `installation (état vivant : ${stateRoot})` : 'installation', base: root,
    configFile: path.join(stateRoot, 'config.json'), routingFile: path.join(stateRoot, 'model-routing.json'),
    chefClaudeMd: chefPath ? path.join(chefPath, 'CLAUDE.md') : null,
    memoryDirs: chefPath ? [{ owner: 'chef', dir: path.join(claudeHome(), 'projects', memSlug(chefPath), 'memory') }] : [],
    docsDir: path.join(root, 'docs'), requirementsFile: path.join(root, 'docs', 'USER_REQUIREMENTS.md'),
    changelogFile: path.join(root, 'CHANGELOG.md'), todoFile: path.join(root, 'TODO_LIST.md'),
    runsDir: runs ? path.resolve(runs) : path.join(root, 'logs', 'runs'),
    repo: fs.existsSync(path.join(root, '.git')) ? root : null,
    listening: live ? 'live' : null, now: null,
  };
}

function readSource(file) {
  if (!file) return null;
  if (forbiddenSource(file)) throw new Error(`source interdite (secrets ou journaux bruts) : ${file}`);
  try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return null; }
}

// ── Fact construction and validation ──────────────────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function factId(f) { return 'f-' + sha([f.s, f.p, JSON.stringify(f.o), f.source?.ref, f.source?.quote].join('|')).slice(0, 10); }

function jsonPointer(obj, ptr) {
  let cur = obj;
  for (const raw of String(ptr).split('/').slice(1)) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur == null || typeof cur !== 'object' || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Checks one candidate fact against the closed schema and its provenance.
 * `texts` = Map(sourceKey → text) of what was read; `jsons` = Map(sourceKey → parsed).
 * → { ok: true, fact } (line recomputed, quote masked if it held a secret) | { ok: false, why }.
 */
export function validateFact(f, { texts = new Map(), jsons = new Map(), commits = null, nodes = null } = {}) {
  if (!f || typeof f !== 'object') return { ok: false, why: 'fait illisible' };
  if (!(f.p in PREDICATES)) return { ok: false, why: `prédicat inconnu : ${f.p}` };
  if (!f.s || f.o === undefined || f.o === null || f.o === '') return { ok: false, why: 'sujet ou objet manquant' };
  if (!AUTHORITY_RANK[f.authority]) return { ok: false, why: `autorité inconnue : ${f.authority}` };
  if (f.status && !STATUSES.includes(f.status)) return { ok: false, why: `statut inconnu : ${f.status}` };
  if (nodes) {
    for (const id of [f.s, ...(typeof f.o === 'string' && f.o.includes(':') ? [f.o] : [])]) {
      const n = nodes.get(id);
      if (n && !NODE_TYPES.includes(n.type)) return { ok: false, why: `type de nœud inconnu : ${n.type}` };
    }
  }
  const src = f.source || {};
  const out = { ...f, source: { ...src } };
  if (src.kind === 'md') {
    const quote = String(src.quote || '');
    if (!quote.trim()) return { ok: false, why: 'citation absente' };
    if (quote.length > QUOTE_MAX) return { ok: false, why: `citation trop longue (${quote.length} > ${QUOTE_MAX})` };
    const text = texts.get(src.key);
    if (text == null) return { ok: false, why: `source non lue : ${src.key}` };
    const i = text.indexOf(quote);
    if (i < 0) return { ok: false, why: `citation introuvable dans ${src.ref || src.key}` };
    out.source.line = text.slice(0, i).split('\n').length;
    out.source.sha256 = sha(quote).slice(0, 16);
  } else if (src.kind === 'json') {
    const j = jsons.get(src.key);
    if (j === undefined) return { ok: false, why: `source non lue : ${src.key}` };
    const v = jsonPointer(j, src.pointer);
    if (v === undefined) return { ok: false, why: `pointeur introuvable : ${src.pointer}` };
    if (src.quote !== undefined && JSON.stringify(v) !== src.quote) return { ok: false, why: `valeur différente au pointeur ${src.pointer}` };
  } else if (src.kind === 'commit') {
    if (!commits || !commits.has(src.ref)) return { ok: false, why: `commit inconnu : ${src.ref}` };
  } else if (src.kind === 'derived') {
    if (!src.ref) return { ok: false, why: 'dérivation sans référence' };
  } else {
    return { ok: false, why: `provenance inconnue : ${src.kind}` };
  }
  if (out.source.quote) {
    const masked = scrubSecrets(out.source.quote);
    if (masked !== out.source.quote) { out.source.quote = masked; out.source.masked = true; }
  }
  out.id = factId(f);
  out.status = out.status || 'observed';
  return { ok: true, fact: out };
}

// ── Markdown helpers ──────────────────────────────────────────────────────────
const DATE_RE = /\b(20\d\d-\d\d-\d\d)\b/;
const LINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text, offset: 0 };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv && kv[2] !== '') meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length), offset: m[0].length };
}
/** Line text without struck-through parts nor « verbatim quotes »: history, not
 *  claims. Blanked with spaces so match positions stay those of the line. */
const unstruck = (s) => s.replace(/~~[\s\S]*?~~|«[^»\n]*»/g, (m) => ' '.repeat(m.length));
function sentences(line) { return line.split(/(?<=[.;!?])\s+(?=\S)/); }
function quoteAround(line, idx, len) {
  // A ≤ 200-char window of the original line containing the match.
  const start = Math.max(0, Math.min(idx, line.length) - 40);
  return line.slice(start, Math.min(line.length, start + QUOTE_MAX)).trim() || line.slice(0, QUOTE_MAX);
}
const modelAlias = (s) => {
  const t = String(s).trim().replace(/`/g, '');
  if (/^claude-/.test(t)) return t;
  const m = /^Opus\s+(\d)(?:\.(\d))?$/i.exec(t);
  return m ? `claude-opus-${m[1]}${m[2] ? `-${m[2]}` : ''}` : t;
};
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Closed list of prose claims the code recognises (phase 0 b). Each yields a
// functional fact on a fixed subject. A model will propose others in phase 1.
export const CLAIM_PATTERNS = [
  { id: 'default-model-all', s: 'flotte:fleet', p: 'default_model', re: /\bTOUT (?:est )?sur\s*`?(claude-[a-z0-9-]+)`?/ },
  { id: 'default-model-ops', s: 'flotte:fleet', p: 'default_model', re: /TOUTES les opérations[^.\n]*?\b(Opus \d(?:\.\d)?|claude-[a-z0-9-]+)/i },
  { id: 'default-model-fleet', s: 'flotte:fleet', p: 'default_model', re: /défaut du fleet(?: est(?: déjà)?)?\s*:?\s*`(claude-[a-z0-9-]+)`/i },
  { id: 'default-model-table', s: 'flotte:fleet', p: 'default_model', re: /`(claude-[a-z0-9-]+)`\*{0,2}\s*[—-]+\s*défaut du fleet/i },
  { id: 'default-model-reste', s: 'flotte:fleet', p: 'default_model', re: /\(`?(claude-[a-z0-9-]+)`?\)\s*reste le DÉFAUT/i },
  { id: 'routing-uniform', s: 'flotte:fleet', p: 'routing_policy', re: /Ne plus router par nature de tâche/i, value: 'uniforme' },
  { id: 'routing-per-case', s: 'flotte:fleet', p: 'routing_policy', re: /page models fait foi case par case/i, value: 'par-case' },
  { id: 'project-count', s: 'flotte:fleet', p: 'project_count', re: /(?:fleet|flotte) de (\d+) projets/i, num: true },
  { id: 'routage-chef-on', s: 'composant:routage-chef', p: 'has_state', re: /tour EST un pipeline Routage\*{0,2}\s*\(en service/i, value: 'on' },
  { id: 'routage-chef-off', s: 'composant:routage-chef', p: 'has_state', re: /COUPÉ\*{0,2} en prod depuis le (20\d\d-\d\d-\d\d)/i, value: 'off', dated: true },
  { id: 'runs-windows', p: 'runs_in', re: /^\s*(\S+) tourne (?:désormais )?en \*{0,2}Windows natif/m, subjectFrom: 1, value: 'env:windows' },
];

// ── Build ─────────────────────────────────────────────────────────────────────
function emptyAcc() { return { nodes: new Map(), cand: [], texts: new Map(), jsons: new Map(), sources: {}, commits: new Set(), rejected: [] }; }
function node(acc, id, type, label, extra = {}) {
  if (!NODE_TYPES.includes(type)) throw new Error(`type de nœud inconnu : ${type}`);
  const cur = acc.nodes.get(id);
  if (cur) { Object.assign(cur, Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined))); return cur; }
  const n = { id, type, label: label || id, status: 'observed', ...extra };
  acc.nodes.set(id, n);
  return n;
}
function trackSource(acc, key, file, text) {
  acc.texts.set(key, text);
  acc.sources[key] = { file, sha256: sha(text).slice(0, 16), bytes: Buffer.byteLength(text) };
}
const mdSource = (key, ref, quote, extra = {}) => ({ kind: 'md', key, ref, quote, ...extra });

function projectNameMap(acc) {
  const m = new Map();
  for (const n of acc.nodes.values()) if (n.type === 'projet') m.set(n.label.toLowerCase(), n.id);
  return m;
}
function subjectForService(acc, name) {
  const pid = projectNameMap(acc).get(String(name).toLowerCase());
  if (pid) return pid;
  const id = `service:${slug(name)}`;
  node(acc, id, 'service', name);
  return id;
}

function extractConfig(acc, src) {
  const text = readSource(src.configFile);
  if (text == null) return null;
  const key = 'config.json';
  trackSource(acc, key, src.configFile, text);
  let j; try { j = JSON.parse(text); } catch { acc.rejected.push({ why: 'config.json illisible' }); return null; }
  acc.jsons.set(key, j);
  node(acc, 'flotte:fleet', 'flotte', 'la flotte');
  const projects = Array.isArray(j.projects) ? j.projects : [];
  projects.forEach((p, i) => {
    if (!p?.name) return;
    node(acc, `projet:${p.name}`, 'projet', p.name, { path: p.path || p.cwd || null });
    if (p.devOf) acc.cand.push({ s: `projet:${p.name}`, p: 'dev_of', o: `projet:${p.devOf}`, authority: 'live', by: 'code:config', source: { kind: 'json', key, ref: `config.json#/projects/${i}/devOf`, pointer: `/projects/${i}/devOf`, quote: JSON.stringify(p.devOf) } });
    if (p.port) {
      node(acc, `port:${p.port}`, 'port', String(p.port));
      acc.cand.push({ s: `projet:${p.name}`, p: 'listens_on', o: [p.port], authority: 'live', by: 'code:config', source: { kind: 'json', key, ref: `config.json#/projects/${i}/port`, pointer: `/projects/${i}/port`, quote: JSON.stringify(p.port) } });
    }
  });
  acc.cand.push({ s: 'flotte:fleet', p: 'project_count', o: projects.length, authority: 'live', by: 'code:config', source: { kind: 'json', key, ref: 'config.json#/projects (longueur)', pointer: '/projects' } });
  if (j.defaults?.model) {
    node(acc, `model:${j.defaults.model}`, 'model', j.defaults.model);
    acc.cand.push({ s: 'flotte:fleet', p: 'default_model', o: j.defaults.model, authority: 'live', by: 'code:config', source: { kind: 'json', key, ref: 'config.json#/defaults/model', pointer: '/defaults/model', quote: JSON.stringify(j.defaults.model) } });
  }
  return j;
}

function extractRouting(acc, src) {
  const text = readSource(src.routingFile);
  if (text == null) return;
  const key = 'model-routing.json';
  trackSource(acc, key, src.routingFile, text);
  let j; try { j = JSON.parse(text); } catch { acc.rejected.push({ why: 'model-routing.json illisible' }); return; }
  acc.jsons.set(key, j);
  const models = new Set();
  for (const [slot, a] of Object.entries(j.assignments || {})) {
    if (!a?.model) continue;
    models.add(a.model);
    node(acc, `case:${slot}`, 'case', slot);
    node(acc, `model:${a.model}`, 'model', a.model);
    const ptr = `/assignments/${slot.replace(/~/g, '~0').replace(/\//g, '~1')}/model`;
    acc.cand.push({ s: `case:${slot}`, p: 'assigned_model', o: a.model, authority: 'live', by: 'code:model-routing', source: { kind: 'json', key, ref: `model-routing.json#${ptr}`, pointer: ptr, quote: JSON.stringify(a.model) } });
  }
  node(acc, 'flotte:fleet', 'flotte', 'la flotte');
  if (models.size >= 2) acc.cand.push({ s: 'flotte:fleet', p: 'routing_policy', o: 'par-case', authority: 'live', by: 'code:model-routing', source: { kind: 'json', key, ref: `model-routing.json#/assignments (${models.size} models distincts)`, pointer: '/assignments' } });
  node(acc, 'composant:routage-chef', 'composant', 'Routage du chef');
  const chefOn = j.enforcement?.chef === true;
  acc.cand.push({ s: 'composant:routage-chef', p: 'has_state', o: chefOn ? 'on' : 'off', authority: 'live', by: 'code:model-routing', source: { kind: 'json', key, ref: 'model-routing.json#/enforcement', pointer: '/enforcement' }, valid_from: j.enforcement?.since?.slice(0, 10) || null });
}

/** Prose claims of one Markdown text (memory body or CLAUDE.md). */
function extractClaims(acc, key, ref, text, { baseOffsetLine = 0, nodeId = null } = {}) {
  const lines = text.split('\n');
  lines.forEach((raw, li) => {
    const line = unstruck(raw);
    for (const pat of CLAIM_PATTERNS) {
      const m = pat.re.exec(line);
      if (!m) continue;
      let o = pat.value || (pat.num ? Number(m[1]) : modelAlias(m[1]));
      let s = pat.s;
      if (pat.subjectFrom) s = subjectForService(acc, m[pat.subjectFrom].replace(/\*/g, ''));
      if (pat.p === 'default_model') node(acc, `model:${o}`, 'model', o);
      const idx = raw.indexOf(m[0].slice(0, 20)) >= 0 ? raw.indexOf(m[0].slice(0, 20)) : 0;
      const date = (pat.dated ? m[1] : null) || (DATE_RE.exec(line)?.[1] ?? null);
      acc.cand.push({ s, p: pat.p, o, authority: 'document', by: `code:claim:${pat.id}`, valid_from: date, claim: pat.id, from: nodeId, source: mdSource(key, `${ref}:${li + 1 + baseOffsetLine}`, quoteAround(raw, idx, m[0].length)) });
    }
  });
}

/** supersedes / exception_to / cites from the [[links]] of a memory. */
function extractLinks(acc, key, ref, selfId, body, idOf) {
  body.split('\n').forEach((raw, li) => {
    for (const sent of sentences(raw)) {
      const links = [...sent.matchAll(LINK_RE)];
      for (const lm of links) {
        const target = idOf(lm[1].trim());
        if (!target || target === selfId) continue;
        const before = sent.slice(0, lm.index), after = sent.slice(lm.index + lm[0].length);
        let p = 'cites', s = selfId, o = target;
        if (/(remplac[ée]e?s?\s+(?:le\s+\S+\s+)?(?:par|by)|replaced by|superseded by)[^[]*$/i.test(before)) { p = 'supersedes'; s = target; o = selfId; }
        else if (/caduc/i.test(before) && !/caducs?\b/i.test(after.slice(0, 30))) { p = 'supersedes'; s = target; o = selfId; }
        else if (/^\W*(?:et\s+[^.]*?)?\s*(?:sont|est)?\s*caducs?\b/i.test(after) || /\bsupersedes?\b|\bremplacent?\b(?!\s+par)/i.test(before)) { p = 'supersedes'; }
        else if (/exception\s+(?:à|a|to)\s*\S*$/i.test(before.trim() + ' ') || /exception\s+(?:à|a|to)\s*$/i.test(before)) { p = 'exception_to'; }
        acc.cand.push({ s, p, o, authority: 'document', by: 'code:memory-links', source: mdSource(key, `${ref}:${li + 1}`, quoteAround(raw, Math.max(0, raw.indexOf(lm[0]) - 60), lm[0].length + 60)) });
      }
    }
  });
}

const MEMORY_TYPE = { feedback: 'regle', user: 'preference', project: 'decision', reference: 'document' };
const CADUC_RE = /\bCADUC\b|❌\s*caduc|\bobsol[eè]te\b/i;

function extractMemories(acc, src) {
  for (const { owner, dir } of src.memoryDirs || []) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { continue; }
    const prefix = owner === 'chef' ? 'mem:' : `mem:${owner}/`;
    const names = new Set(files.filter(f => f !== 'MEMORY.md').map(f => f.replace(/\.md$/, '')));
    const idOf = (n) => (names.has(n.replace(/\.md$/, '')) ? prefix + n.replace(/\.md$/, '') : null);
    const bodies = new Map();
    for (const f of files) {
      if (f === 'MEMORY.md') continue;
      const file = path.join(dir, f);
      const text = readSource(file);
      if (text == null) continue;
      const key = `memory:${owner}/${f}`;
      trackSource(acc, key, file, text);
      const { meta, body, offset } = frontMatter(text);
      const name = f.replace(/\.md$/, '');
      const type = MEMORY_TYPE[meta.type] || MEMORY_TYPE[(text.match(/^\s*type:\s*(\w+)/m) || [])[1]] || 'document';
      const id = prefix + name;
      const firstPara = body.trim().split(/\n\s*\n/)[0] || '';
      node(acc, id, type, meta.description || name, { owner, file: key, modified: (meta.modified || '').slice(0, 10) || null, caduc: CADUC_RE.test(firstPara) });
      bodies.set(id, { key, body, offsetLines: text.slice(0, offset).split('\n').length - 1, name });
    }
    for (const [id, b] of bodies) {
      extractLinks(acc, b.key, `${b.key.replace(/^memory:/, '')}`, id, b.body, idOf);
      if (owner === 'chef') extractClaims(acc, b.key, b.key.replace(/^memory:/, ''), b.body, { baseOffsetLine: b.offsetLines, nodeId: id });
    }
    // Index lines (MEMORY.md): one per memory, checked against the memory's status.
    const idxFile = path.join(dir, 'MEMORY.md');
    const idxText = readSource(idxFile);
    if (idxText != null) {
      const key = `memory:${owner}/MEMORY.md`;
      trackSource(acc, key, idxFile, idxText);
      idxText.split('\n').forEach((line, li) => {
        const m = /\[([^\]]+)\]\(([^)]+\.md)\)\s*[—-]\s*(.*)$/.exec(line);
        if (!m) return;
        const id = idOf(m[2]);
        if (!id) return;
        const n = acc.nodes.get(id);
        if (n) n.index = { key, line: li + 1, text: m[3].trim().slice(0, QUOTE_MAX), quote: line.trim().slice(0, QUOTE_MAX) };
      });
    }
  }
}

function extractChefClaude(acc, src) {
  const text = readSource(src.chefClaudeMd);
  if (text == null) return;
  const key = 'chef:CLAUDE.md';
  trackSource(acc, key, src.chefClaudeMd, text);
  node(acc, 'document:chef/CLAUDE.md', 'document', 'CLAUDE.md du chef');
  extractClaims(acc, key, 'chef/CLAUDE.md', text, { nodeId: 'document:chef/CLAUDE.md' });
}

/** Port table (memory project_fleet_ports or any memory with a | Service | Port | table). */
function extractPortTables(acc) {
  for (const [key, text] of acc.texts) {
    if (!key.startsWith('memory:')) continue;
    const lines = text.split('\n');
    const head = lines.findIndex(l => /^\|\s*Service\s*\|\s*Port/i.test(l));
    if (head < 0) continue;
    const docDate = /mis à jour le (20\d\d-\d\d-\d\d)/i.exec(text)?.[1] || null;
    for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
      const cells = lines[i].split('|').slice(1, -1).map(c => c.trim());
      if (cells.length < 3) continue;
      const [svc, portsCell, kind] = cells;
      const ports = [...portsCell.matchAll(/\b(\d{2,5})\b/g)].map(m => Number(m[1])).filter(p => p > 0 && p < 65536);
      if (!ports.length) continue;
      const name = svc.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+(API|Frontend|docs|démo web)$/i, '').trim();
      const sid = /externe/i.test(kind) ? `service:${slug(svc)}` : subjectForService(acc, name);
      if (sid.startsWith('service:')) node(acc, sid, 'service', svc);
      const quote = lines[i].slice(0, QUOTE_MAX);
      const subj = sid.startsWith('projet:') && slug(svc) !== slug(name) ? `service:${slug(svc)}` : sid;
      if (subj !== sid) node(acc, subj, 'service', svc, { project: sid });
      for (const p of ports) node(acc, `port:${p}`, 'port', String(p));
      acc.cand.push({ s: subj, p: 'listens_on', o: ports, authority: 'document', by: 'code:port-table', valid_from: null, docDate, kindOfFact: 'port', source: mdSource(key, `${key.replace(/^memory:/, '')}:${i + 1}`, quote) });
      const env = /\bWSL\b/.test(kind) ? 'env:wsl' : /Windows/i.test(kind) ? 'env:windows' : null;
      if (env) {
        node(acc, env, 'environnement', env === 'env:wsl' ? 'WSL' : 'Windows');
        acc.cand.push({ s: subj, p: 'runs_in', o: env, authority: 'document', by: 'code:port-table', valid_from: null, docDate, source: mdSource(key, `${key.replace(/^memory:/, '')}:${i + 1}`, quote) });
      }
    }
  }
  node(acc, 'env:windows', 'environnement', 'Windows');
}

/** Numbered items of "Décisions de l'utilisateur" sections in docs/*-SYNTHESE.md. */
function extractDecisions(acc, src, repoFiles) {
  let files = [];
  try { files = fs.readdirSync(src.docsDir).filter(f => /-SYNTHESE\.md$/.test(f)); } catch { return; }
  const byBase = new Map();
  for (const f of repoFiles || []) { const b = path.posix.basename(f); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(f); }
  for (const f of files) {
    const file = path.join(src.docsDir, f);
    const text = readSource(file);
    if (text == null) continue;
    const key = `docs/${f}`;
    trackSource(acc, key, file, text);
    const prefix = f.replace(/-SYNTHESE\.md$/, '').toUpperCase();
    const lines = text.split('\n');
    const start = lines.findIndex(l => /^##\s+(?:\d+\.\s*)?Décisions de l'utilisateur/i.test(l));
    if (start < 0) continue;
    const date = DATE_RE.exec(lines[start])?.[1] || null;
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const id = `decision:${prefix}-D${cur.n}`;
      const body = cur.text.join(' ').replace(/\s+/g, ' ').trim();
      node(acc, id, 'decision', `${prefix} D${cur.n} — ${body.replace(/\*\*/g, '').slice(0, 160)}`, { date, file: key, line: cur.line });
      acc.cand.push({ s: id, p: 'decided_in', o: `document:${key}`, authority: 'user', by: 'code:decisions', valid_from: date, source: mdSource(key, `${key}:${cur.line}`, cur.quote) });
      for (const m of body.matchAll(/`([^`\s]+)`/g)) {
        const tok = m[1];
        let target = null;
        if (/^_test_[\w-]+\.mjs$/.test(tok)) { target = `suite:${tok}`; node(acc, target, 'suite', tok); }
        else if (/\.(mjs|js|json|md|kts)$/.test(tok)) {
          const hits = tok.includes('/') ? [tok] : (byBase.get(tok) || []);
          if (hits.length === 1) { target = `fichier:${hits[0]}`; node(acc, target, 'fichier', hits[0]); }
        } else if (/^[a-z]+\.[a-z][\w.-]*$/.test(tok) && !/\.(mjs|js)$/.test(tok)) { target = `case:${tok}`; node(acc, target, 'case', tok); }
        if (target) acc.cand.push({ s: id, p: 'applies_to', o: target, authority: 'user', by: 'code:decisions', valid_from: date, source: mdSource(key, `${key}:${cur.line}`, cur.quote) });
      }
      cur = null;
    };
    node(acc, `document:${key}`, 'document', key);
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^##\s/.test(l)) break;
      const m = /^(\d+)\.\s+(.*)$/.exec(l);
      if (m) { flush(); cur = { n: Number(m[1]), line: i + 1, text: [m[2]], quote: l.slice(0, QUOTE_MAX) }; }
      else if (cur && /^\s+\S/.test(l)) cur.text.push(l.trim());
      else if (cur && !l.trim()) { /* paragraph break inside an item */ }
      else if (cur) flush();
    }
    flush();
  }
}

function extractRequirements(acc, src) {
  const text = readSource(src.requirementsFile);
  if (text == null) return;
  const key = 'docs/USER_REQUIREMENTS.md';
  trackSource(acc, key, src.requirementsFile, text);
  const rank = new Map();
  text.split('\n').forEach((l, i) => {
    const m = /^\|\s*(20\d\d-\d\d-\d\d)\s*\|(.*)\|\s*([^|]*)\|\s*([^|]*)\|\s*$/.exec(l);
    if (!m) return;
    const r = (rank.get(m[1]) || 0) + 1; rank.set(m[1], r);
    const id = `exigence:${m[1]}#${r}`;
    node(acc, id, 'exigence', m[2].trim().replace(/\s+/g, ' ').slice(0, 160), { date: m[1], line: i + 1 });
    const quote = l.slice(0, Math.min(l.length, 120));
    for (const t of m[3].matchAll(/`(suite|http|nav):([^`]+)`/g)) {
      const sid = t[1] === 'suite' ? `suite:${t[2]}` : `suite:${t[1]}:${t[2]}`;
      node(acc, sid, 'suite', t[1] === 'suite' ? t[2] : `${t[1]}:${t[2]}`);
      acc.cand.push({ s: sid, p: 'protects', o: id, authority: 'document', by: 'code:requirements', valid_from: m[1], source: mdSource(key, `${key}:${i + 1}`, quote) });
    }
    const v = /(\d+\.\d+\.\d+)/.exec(m[4])?.[1];
    if (v) { node(acc, `version:${v}`, 'version', v); acc.cand.push({ s: id, p: 'delivered_in', o: `version:${v}`, authority: 'document', by: 'code:requirements', valid_from: m[1], source: mdSource(key, `${key}:${i + 1}`, quote) }); }
  });
}

function extractChangelog(acc, src) {
  const text = readSource(src.changelogFile);
  if (text == null) return;
  const key = 'CHANGELOG.md';
  trackSource(acc, key, src.changelogFile, text);
  text.split('\n').forEach((l, i) => {
    const m = /^## \[(\d+\.\d+\.\d+)\]\s*-\s*(20\d\d-\d\d-\d\d)/.exec(l);
    if (m) node(acc, `version:${m[1]}`, 'version', `v${m[1]}`, { date: m[2], file: key, line: i + 1 });
  });
}

function extractTodo(acc, src) {
  const text = readSource(src.todoFile);
  if (text == null) return;
  const key = 'TODO_LIST.md';
  trackSource(acc, key, src.todoFile, text);
  text.split('\n').forEach((l, i) => {
    const m = /^\s*- \[([ x~])\][^\n]*?\b(t-[0-9a-f]{6})\b/.exec(l);
    if (!m) return;
    node(acc, `todo:${m[2]}`, 'todo', l.replace(/^\s*- \[[ x~]\]\s*/, '').replace(/\s+/g, ' ').slice(0, 160), { done: m[1] === 'x', file: key, line: i + 1 });
  });
}

function gitRun(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return r.status === 0 ? r.stdout || '' : '';
}

function extractGit(acc, src) {
  if (!src.repo) return;
  for (const l of gitRun(src.repo, ['log', '-50', '--format=%h%x09%ad%x09%s', '--date=short']).split('\n')) {
    const [h, d, ...s] = l.split('\t');
    if (!h) continue;
    acc.commits.add(h);
    node(acc, `commit:${h}`, 'commit', s.join('\t').slice(0, 160), { date: d });
    const v = /release: v(\d+\.\d+\.\d+)/.exec(s.join(' '))?.[1];
    if (v) { node(acc, `version:${v}`, 'version', `v${v}`); acc.cand.push({ s: `version:${v}`, p: 'delivered_in', o: `commit:${h}`, authority: 'live', by: 'code:git', source: { kind: 'commit', ref: h } }); }
  }
}

/** Suite → files it covers, exactly as regression-targets.selectTargets sees them. */
async function extractCoverage(acc, src) {
  if (!src.repo) return null;
  const rt = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'regression-targets.mjs')).href);
  const files = rt.repoFiles(src.repo);
  const graph = rt.referenceGraph(src.repo, files);
  const suites = files.filter(f => /^scripts\/_test_[^/]+\.mjs$/.test(f));
  const covers = {};
  for (const s of suites) covers[path.posix.basename(s)] = [...rt.coverageOf(graph, s)].sort();
  const httpCover = [...new Set(rt.HTTP_ROOTS.filter(f => files.includes(f)).flatMap(r => [...rt.coverageOf(graph, r), ...rt.importClosure(graph, [r])]))].sort();
  let perimeters = null;
  try { perimeters = JSON.parse(fs.readFileSync(path.join(src.repo, 'scripts', 'regression-perimeters.json'), 'utf8')); } catch { /* none */ }
  return {
    files, covers, httpCover, perimeters,
    rules: { base: rt.BASE_SUITES, tooling: rt.TOOLING_FILES, toolingSuites: rt.TOOLING_SUITES, browserRoots: rt.BROWSER_ROOTS, fullTriggers: rt.FULL_TRIGGERS },
  };
}

/** Cause of a pipeline step outcome (synthesis §3.4: capacity / criterion / infrastructure). */
export function stepCause(st) {
  if (st.status === 'ok') return 'ok';
  if (st.status === 'skipped') return null;
  if (st.status === 'launch_failed' || st.status === 'launch_refused' || st.exit === 64 || st.status === 'model_unavailable') return 'infrastructure';
  if (st.status === 'refused') return 'critere';
  return 'echec';
}

function extractRuns(acc, src) {
  let dirs = [];
  try { dirs = fs.readdirSync(src.runsDir).filter(d => /^p-/.test(d)); } catch { return []; }
  const execs = [];
  for (const d of dirs) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(src.runsDir, d, 'run.json'), 'utf8')); } catch { continue; }
    const steps = [];
    for (const st of j.steps || []) {
      const cause = stepCause(st);
      if (!cause || !st.slot) continue;
      steps.push({ case: st.slot, served: st.served || st.model || null, cause, ms: st.durationMs || 0, why: st.why ? String(st.why).slice(0, 160) : null });
    }
    execs.push({ run: j.run || d, project: j.project || null, pipeline: j.pipeline || null, status: j.status || null, at: (j.createdAt || '').slice(0, 19), steps });
  }
  return execs;
}

function listeningPorts() {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const r6 = spawnSync('netstat', ['-ano', '-p', 'TCPv6'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const ports = new Set();
  for (const out of [r.stdout || '', r6.stdout || '']) {
    for (const l of out.split('\n')) {
      const m = /^\s*TCP\s+\S*[:\]](\d+)\s+\S+\s+LISTENING/i.exec(l);
      if (m) ports.add(Number(m[1]));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

// ── Resolution: statuses, conflicts, stale facts ──────────────────────────────
const sameValue = (a, b) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b);
const scopeOverlap = (a, b) => { const x = a?.project || '*', y = b?.project || '*'; return x === '*' || y === '*' || x === y; };
const srcDoc = (f) => (f.source?.key || f.source?.ref || '').replace(/:\d+$/, '');
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

function resolve(acc, facts, { listening, now }) {
  const nodes = acc.nodes;
  // Memories: superseded by an explicit link or by their own « CADUC » banner.
  const supersededBy = new Map();
  for (const f of facts) if (f.p === 'supersedes') { if (!supersededBy.has(f.o)) supersededBy.set(f.o, []); supersededBy.get(f.o).push(f); }
  const loops = [];
  for (const [o, list] of supersededBy) for (const f of list) if ((supersededBy.get(f.s) || []).some(g => g.s === o)) loops.push([f.s, o]);
  for (const n of nodes.values()) {
    if (!n.id.startsWith('mem:')) continue;
    if (n.caduc || supersededBy.has(n.id)) { n.status = 'superseded'; n.supersededBy = (supersededBy.get(n.id) || []).map(f => f.s); }
  }
  // Claims of a superseded memory are history, not claims.
  for (const f of facts) if (f.from && nodes.get(f.from)?.status === 'superseded' && PREDICATES[f.p]) { f.status = 'superseded'; f.statusWhy = `mémoire remplacée (${f.from})`; }

  const conflicts = [], stale = [];
  // Within one source: a dated claim replaces an undated or older one.
  const groups = new Map();
  for (const f of facts) {
    if (!PREDICATES[f.p] || f.status === 'superseded') continue;
    const k = `${f.s}|${f.p}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  for (const list of groups.values()) {
    const bySrc = new Map();
    for (const f of list) { const d = srcDoc(f); if (!bySrc.has(d)) bySrc.set(d, []); bySrc.get(d).push(f); }
    for (const same of bySrc.values()) {
      if (same.length < 2) continue;
      const vals = new Set(same.map(f => JSON.stringify(f.o)));
      if (vals.size < 2) continue;
      const dated = same.filter(f => f.valid_from).sort((a, b) => b.valid_from.localeCompare(a.valid_from));
      const top = dated[0];
      if (top && (dated.length < 2 || dated[1].valid_from < top.valid_from || sameValue(dated[1].o, top.o))) {
        for (const f of same) if (!sameValue(f.o, top.o)) { f.status = 'superseded'; f.statusWhy = `remplacé dans la même source par la ligne ${top.source.line} (${top.valid_from})`; }
      }
    }
  }
  // Across sources: highest authority wins; equal authority and different value = conflict.
  for (const list0 of groups.values()) {
    const list = list0.filter(f => f.status !== 'superseded');
    if (list.length < 2) continue;
    const best = Math.max(...list.map(f => AUTHORITY_RANK[f.authority]));
    const tops = list.filter(f => AUTHORITY_RANK[f.authority] === best);
    const topVals = [];
    for (const f of tops) if (!topVals.some(v => sameValue(v, f.o))) topVals.push(f.o);
    if (topVals.length > 1) {
      const pairs = tops.filter((f, i) => tops.some((g, j) => j !== i && !sameValue(f.o, g.o) && scopeOverlap(f.scope, g.scope)));
      if (pairs.length) {
        for (const f of pairs) f.status = 'disputed';
        const newest = [...pairs].sort((a, b) => String(b.valid_from || b.docDate || '').localeCompare(String(a.valid_from || a.docDate || '')))[0];
        conflicts.push({ kind: 'conflit', s: list[0].s, p: list[0].p, authority: tops[0].authority, facts: pairs.map(f => f.id), values: pairs.map(f => ({ o: f.o, ref: f.source.ref, date: f.valid_from || f.docDate || null, quote: f.source.quote })), hint: newest && (newest.valid_from || newest.docDate) ? `plus récente : ${newest.source.ref} (${newest.valid_from || newest.docDate})` : null });
      }
      continue;
    }
    const truth = tops[0];
    for (const f of list) {
      if (AUTHORITY_RANK[f.authority] >= best || sameValue(f.o, truth.o)) continue;
      f.status = 'to_review';
      f.statusWhy = `contredit par ${truth.source.ref} (${truth.authority === 'live' ? 'état vivant' : truth.authority})`;
      stale.push({ kind: 'perime', reason: 'contredit', s: f.s, p: f.p, fact: f.id, value: f.o, ref: f.source.ref, quote: f.source.quote, truth: { o: truth.o, ref: truth.source.ref, authority: truth.authority } });
    }
  }
  // Index lines of superseded memories that do not say so.
  for (const n of nodes.values()) {
    if (n.status !== 'superseded' || !n.index) continue;
    if (CADUC_RE.test(n.index.text) || /remplac|supersed|caduc/i.test(n.index.text)) continue;
    stale.push({ kind: 'perime', reason: 'index', s: n.id, p: 'described_in', ref: `${n.index.key.replace(/^memory:/, '')}:${n.index.line}`, quote: n.index.quote, truth: { o: 'superseded', ref: n.supersededBy?.length ? n.supersededBy.join(', ') : 'bandeau CADUC de la mémoire', authority: 'document' } });
  }
  // Declared ports: silent ones and old declarations are to review.
  for (const f of facts) {
    if (f.p !== 'listens_on' || f.authority !== 'document' || f.status === 'superseded') continue;
    const silent = Array.isArray(listening) ? f.o.filter(p => !listening.includes(p)) : [];
    const age = f.docDate && now ? daysBetween(f.docDate, now) : null;
    const why = [];
    if (silent.length) why.push(`port${silent.length > 1 ? 's' : ''} ${silent.join(', ')} sans écoute au moment de la construction`);
    if (age != null && age > STALE_DAYS.port) why.push(`déclaration du ${f.docDate}, plus de ${STALE_DAYS.port} jours`);
    if (!why.length) continue;
    if (f.status === 'observed') f.status = 'to_review';
    f.statusWhy = why.join(' ; ');
    stale.push({ kind: 'perime', reason: silent.length ? 'port-muet' : 'age', s: f.s, p: f.p, fact: f.id, value: f.o, ref: f.source.ref, quote: f.source.quote, why: f.statusWhy });
  }
  return { conflicts, stale, loops };
}

/**
 * Builds the derived layer. Refused while the mode is off (unless `force`).
 * → { ok, refused?, summary, file } ; writes logs/kg/{derived.json, build.json, contradictions.md}.
 */
export async function build(root, { corpus = null, runs = null, state = null, repo = undefined, live = true, force = false, listening = undefined, now = null, write = true } = {}) {
  root = rootOf(root);
  const settings = readKgSettings(root);
  if (settings.mode === 'off' && !force) return { ok: false, refused: 'off', message: 'index désactivé (kg.mode = off) : rien n’est construit — node scripts/pipeline-enforce.mjs kg shadow, ou --force pour un essai' };
  const t0 = Date.now();
  const src = resolveSources(root, { corpus, runs, live, state });
  if (repo !== undefined) src.repo = repo;   // coverage of another checkout (tests: a corpus + this repository)
  const acc = emptyAcc();
  extractConfig(acc, src);
  extractRouting(acc, src);
  extractMemories(acc, src);
  extractChefClaude(acc, src);
  extractPortTables(acc);
  const cov = await extractCoverage(acc, src);
  extractDecisions(acc, src, cov?.files);
  extractRequirements(acc, src);
  extractChangelog(acc, src);
  extractTodo(acc, src);
  extractGit(acc, src);
  const executions = extractRuns(acc, src);
  for (const e of executions) node(acc, `execution:${e.run}`, 'execution', `${e.pipeline || '?'} — ${e.project || '?'} (${e.status || '?'})`, { project: e.project, at: e.at });

  const facts = [];
  const seen = new Set();
  for (const c of acc.cand) {
    const r = validateFact({ scope: { project: '*' }, valid_to: null, ...c }, { texts: acc.texts, jsons: acc.jsons, commits: acc.commits, nodes: acc.nodes });
    if (!r.ok) { acc.rejected.push({ why: r.why, s: c.s, p: c.p, ref: c.source?.ref }); continue; }
    if (seen.has(r.fact.id)) continue;
    seen.add(r.fact.id);
    facts.push(r.fact);
  }
  let ports = listening;
  if (ports === undefined) ports = src.listening === 'live' ? listeningPorts() : src.listening;
  const nowIso = now || src.now || new Date().toISOString();
  const { conflicts, stale, loops } = resolve(acc, facts, { listening: Array.isArray(ports) ? ports : null, now: nowIso });
  const recordedAt = new Date().toISOString();
  for (const f of facts) f.recorded_at = recordedAt;

  const derived = scrubDeep({
    version: 1, ontology: ONTOLOGY_VERSION, builtAt: recordedAt, now: nowIso, sources: src.label, mode: settings.mode,
    nodes: Object.fromEntries([...acc.nodes].map(([k, v]) => [k, v])), facts, conflicts, stale, loops,
    listening: Array.isArray(ports) ? { at: recordedAt, ports } : null,
    coverage: cov ? { covers: cov.covers, httpCover: cov.httpCover, perimeters: cov.perimeters, rules: cov.rules, files: cov.files } : null,
    executions,
  });
  const summary = { nodes: acc.nodes.size, facts: facts.length, rejected: acc.rejected.length, conflicts: conflicts.length, stale: stale.length, executions: executions.length, ms: Date.now() - t0, sources: Object.keys(acc.sources).length };
  if (!write) return { ok: true, derived, summary, rejected: acc.rejected };
  const json = JSON.stringify(derived);
  kgWrite(root, 'derived.json', json);
  kgWrite(root, 'build.json', JSON.stringify(scrubDeep({ builtAt: recordedAt, mode: settings.mode, label: src.label, sources: acc.sources, summary, rejected: acc.rejected.slice(0, 200) }), null, 2) + '\n');
  kgWrite(root, 'contradictions.md', contradictionsMarkdown(derived));
  cache = null;
  return { ok: true, summary, rejected: acc.rejected, file: path.join(root, ...KG_DIR.split('/'), 'derived.json') };
}

// ── Index loading ─────────────────────────────────────────────────────────────
let cache = null;
/** Loaded index with lookup maps. `derived` may be passed directly (tests). */
export function loadIndex(root, { derived = null } = {}) {
  root = rootOf(root);
  const file = path.join(root, ...KG_DIR.split('/'), 'derived.json');
  if (!derived) {
    let st; try { st = fs.statSync(file); } catch { return null; }
    if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.idx;
    derived = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = { file, mtimeMs: st.mtimeMs, idx: null };
  }
  const bySubject = new Map(), byObject = new Map();
  const push = (m, k, f) => { if (!m.has(k)) m.set(k, []); m.get(k).push(f); };
  for (const f of derived.facts) {
    push(bySubject, f.s, f);
    for (const o of Array.isArray(f.o) ? f.o.map(p => `port:${p}`) : [f.o]) if (typeof o === 'string') push(byObject, o, f);
  }
  const coveredBy = new Map();
  for (const [s, files] of Object.entries(derived.coverage?.covers || {})) for (const f of files) push(coveredBy, f, s);
  const idx = { derived, nodes: derived.nodes, bySubject, byObject, coveredBy, httpCover: new Set(derived.coverage?.httpCover || []) };
  if (cache && !cache.idx && cache.file === file) cache.idx = idx;
  return idx;
}

// ── Queries (no model, pure functions of the index) ───────────────────────────
const active = (f) => f.status !== 'superseded' && f.status !== 'retracted';
const fmtO = (o) => (Array.isArray(o) ? o.join(', ') : String(o));
function factLine(f) { return { s: f.s, p: f.p, o: f.o, status: f.status, why: f.statusWhy || null, authority: f.authority, ref: f.source?.ref || null, quote: f.source?.quote || null, date: f.valid_from || f.docDate || null }; }

/** Every id form the overlay may hand over → node key. */
export function resolveId(idx, raw) {
  const id = String(raw || '').trim().replace(/^\[\[|\]\]$/g, '');
  if (idx.nodes[id]) return id;
  const forms = [];
  if (/^\d{2,5}$/.test(id)) forms.push(`port:${id}`);
  if (/^v?\d+\.\d+\.\d+$/.test(id)) forms.push(`version:${id.replace(/^v/, '')}`);
  if (/^p-/.test(id)) forms.push(`execution:${id}`);
  if (/^t-[0-9a-f]{6}$/.test(id)) forms.push(`todo:${id}`);
  if (/^[0-9a-f]{7,40}$/.test(id)) forms.push(`commit:${id.slice(0, 7)}`);
  if (/^[A-Z]+-D\d+$/.test(id)) forms.push(`decision:${id}`);
  if (/^_test_.*\.mjs$/.test(id)) forms.push(`suite:${id}`);
  forms.push(`projet:${id}`, `mem:${id}`, `case:${id}`, `model:${id}`, `fichier:${id.replace(/\\/g, '/')}`, `suite:${id}`, `service:${slug(id)}`, `composant:${id}`, `exigence:${id}`);
  for (const f of forms) if (idx.nodes[f]) return f;
  const lower = id.toLowerCase();
  return Object.keys(idx.nodes).find(k => k.toLowerCase() === `projet:${lower}`) || null;
}

/** Node + 1-hop links with sources (the overlay's « Liens » section). */
export function explique(idx, raw, { max = 10 } = {}) {
  const id = resolveId(idx, raw);
  if (!id) return { known: false, id: raw, message: `identifiant inconnu de l’index : ${raw}` };
  const out = (idx.bySubject.get(id) || []).map(f => ({ dir: 'out', ...factLine(f) }));
  const inn = (idx.byObject.get(id) || []).map(f => ({ dir: 'in', ...factLine(f) }));
  const links = [...out, ...inn];
  const n = idx.nodes[id];
  const conflicts = [...idx.derived.conflicts, ...idx.derived.stale].filter(c => c.s === id || c.truth?.o === id);
  return { known: true, id, node: n, links: links.slice(0, max), more: Math.max(0, links.length - max), conflicts };
}

/** Rules in force for a project (or the fleet), most specific first; exceptions and conflicts always returned. */
export function regles(idx, { projet = null } = {}) {
  const pid = projet ? resolveId(idx, projet) : null;
  const pname = pid ? idx.nodes[pid]?.label : null;
  const rules = [];
  for (const n of Object.values(idx.nodes)) {
    if (!['regle', 'preference', 'decision', 'garde_fou'].includes(n.type) || !n.id.startsWith('mem:')) continue;
    const specific = pname && new RegExp(`\\b${pname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(`${n.label} ${n.id}`);
    if (pname && !specific && n.owner !== 'chef') continue;
    rules.push({ id: n.id, label: n.label, status: n.status, specific: !!specific, modified: n.modified, supersededBy: n.supersededBy || [] });
  }
  rules.sort((a, b) => (b.specific - a.specific) || ((a.status === 'superseded') - (b.status === 'superseded')) || String(b.modified || '').localeCompare(String(a.modified || '')));
  const fixed = [];
  for (const p of ['default_model', 'routing_policy']) {
    const fs_ = (idx.bySubject.get('flotte:fleet') || []).filter(f => f.p === p && active(f));
    if (fs_.length) fixed.push(...fs_.map(factLine));
  }
  const exceptions = idx.derived.facts.filter(f => f.p === 'exception_to' && active(f)).map(factLine);
  const conflicts = idx.derived.conflicts.filter(c => !pid || c.s === pid || c.s === 'flotte:fleet');
  return { projet: pid, inForce: rules.filter(r => r.status !== 'superseded'), superseded: rules.filter(r => r.status === 'superseded'), fixed, exceptions, conflicts };
}

/** Suites, stages, requirements and decisions touched by a change of `file` (same rules as selectTargets). */
export function impact(idx, rawFile) {
  const file = String(rawFile).replace(/\\/g, '/').replace(/^\.\//, '');
  const cov = idx.derived.coverage;
  if (!cov) return { file, available: false, message: 'couverture non calculée (index construit sans dépôt git)' };
  const r = cov.rules;
  const suites = new Map();
  const add = (s, why) => { if (!suites.has(s)) suites.set(s, new Set()); suites.get(s).add(why); };
  for (const b of r.base) if (cov.covers[b]) add(b, 'socle (toujours exécuté)');
  let http = false, browser = false, full = null;
  if (r.fullTriggers.includes(file)) full = `${file} modifié (dépendances)`;
  if (r.tooling.includes(file)) { for (const s of r.toolingSuites) if (cov.covers[s]) add(s, `outillage de la non-régression : ${file}`); if (file === 'scripts/regression.mjs') http = true; }
  const docs = /\.md$|^docs\//.test(file);
  let covered = r.tooling.includes(file) || docs;
  for (const s of idx.coveredBy.get(file) || []) { if (!docs) { add(s, `couvre ${file}`); covered = true; } }
  if (!docs && idx.httpCover.has(file)) { http = true; covered = true; }
  if (!docs && (file.startsWith('public/') || r.browserRoots.includes(file))) { browser = true; http = true; covered = true; }
  if (!covered && !full) full = `${file} n'est couvert par aucune suite ni aucun étage : non-régression complète`;
  let perimeter = null;
  const pm = cov.perimeters;
  if (pm) {
    for (const p of pm.perimeters || []) if ((p.files || []).includes(file)) { perimeter = p.id; break; }
  }
  const suiteIds = [...suites.keys()].sort((a, b) => a.localeCompare(b));
  const exigences = [];
  for (const s of suiteIds) for (const f of idx.bySubject.get(`suite:${s}`) || []) if (f.p === 'protects') exigences.push({ suite: s, exigence: f.o, label: idx.nodes[f.o]?.label || f.o, version: (idx.bySubject.get(f.o) || []).find(g => g.p === 'delivered_in')?.o || null });
  const decisions = [];
  for (const target of [`fichier:${file}`, ...suiteIds.map(s => `suite:${s}`)]) for (const f of idx.byObject.get(target) || []) if (f.p === 'applies_to') decisions.push({ decision: f.s, label: idx.nodes[f.s]?.label, via: target });
  return { file, available: true, full, suites: suiteIds.map(s => ({ file: s, reasons: [...suites.get(s)] })), http, browser, perimeter, exigences, decisions };
}

/** Outcomes of one Models case: n, by served model, causes; « données insuffisantes » under 20. */
export function historique(idx, rawCase, { min = 20 } = {}) {
  const c = String(rawCase).replace(/^case:/, '');
  const byModel = {};
  let n = 0;
  const why = {};
  for (const e of idx.derived.executions || []) for (const st of e.steps) {
    if (st.case !== c) continue;
    n++;
    const m = st.served || '?';
    byModel[m] = byModel[m] || { n: 0, ok: 0, critere: 0, infrastructure: 0, echec: 0 };
    byModel[m].n++; byModel[m][st.cause]++;
    if (st.cause !== 'ok' && st.why) why[st.why] = (why[st.why] || 0) + 1;
  }
  const causes = Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, k]) => ({ why: w, n: k }));
  return { case: c, n, enough: n >= min, message: n < min ? `données insuffisantes (${n} < ${min})` : null, byModel, causes, assigned: (idx.bySubject.get(`case:${c}`) || []).find(f => f.p === 'assigned_model')?.o || null };
}

export function contradictions(idx) { return { conflicts: idx.derived.conflicts, stale: idx.derived.stale.filter(s => s.reason === 'contredit' || s.reason === 'index'), loops: idx.derived.loops }; }
export function perimes(idx) { return { stale: idx.derived.stale, listening: idx.derived.listening }; }

/** Project card: rules, environment, dependencies, incidents, contradictions. */
export function fiche(idx, raw) {
  const id = resolveId(idx, raw);
  if (!id || !id.startsWith('projet:')) return { known: false, id: raw, message: `projet inconnu de l’index : ${raw}` };
  const n = idx.nodes[id];
  const services = [id, ...Object.values(idx.nodes).filter(x => x.type === 'service' && x.project === id).map(x => x.id)];
  const env = [], ports = [];
  for (const s of services) for (const f of idx.bySubject.get(s) || []) {
    if (!active(f)) continue;
    if (f.p === 'runs_in') env.push(factLine(f));
    if (f.p === 'listens_on') ports.push({ ...factLine(f), listening: idx.derived.listening ? f.o.map(p => ({ port: p, up: idx.derived.listening.ports.includes(p) })) : null });
  }
  const deps = [...(idx.bySubject.get(id) || []), ...(idx.byObject.get(id) || [])].filter(f => ['dev_of', 'depends_on'].includes(f.p)).map(factLine);
  const incidents = [];
  for (const e of idx.derived.executions || []) {
    if (e.project !== n.label) continue;
    for (const st of e.steps) if (st.cause !== 'ok') incidents.push({ run: e.run, at: e.at, case: st.case, cause: st.cause, why: st.why });
  }
  incidents.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const rules = regles(idx, { projet: id });
  const touching = [...idx.derived.conflicts, ...idx.derived.stale].filter(c => services.includes(c.s));
  return { known: true, id, label: n.label, path: n.path || null, environment: env, ports, dependencies: deps, rules: rules.inForce.filter(r => r.specific), incidents: incidents.slice(0, 5), contradictions: touching };
}

/** First free port ≥ from: not declared anywhere, not listening, and bindable now. */
export async function portLibre(idx, { from = 3002, to = 65000, probe = true } = {}) {
  const declared = new Set();
  for (const f of idx.derived.facts) if (f.p === 'listens_on' && f.status !== 'retracted') for (const p of f.o) declared.add(p);
  const listening = new Set(idx.derived.listening?.ports || []);
  const canBind = (port) => new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen({ port, host: '0.0.0.0', exclusive: true }, () => s.close(() => res(true)));
  });
  for (let p = from; p <= to; p++) {
    if (declared.has(p) || listening.has(p)) continue;
    if (probe && !(await canBind(p))) continue;
    return { port: p, declared: [...declared].sort((a, b) => a - b), listeningAt: idx.derived.listening?.at || null };
  }
  return { port: null };
}

// ── Markdown rendering (French) ───────────────────────────────────────────────
const P_LABEL = { default_model: 'model par défaut', routing_policy: 'routage des models', project_count: 'nombre de projets', runs_in: 'environnement', listens_on: 'ports', has_state: 'état', described_in: 'ligne d’index', dev_of: 'instance de dev de', assigned_model: 'model de la case' };
export function contradictionsMarkdown(d) {
  const out = [`# Contradictions de l'index (${d.builtAt})`, '', `Sources : ${d.sources}. Construit par le programme, sans model.`, ''];
  out.push(`## Conflits (${d.conflicts.length})`, '');
  for (const c of d.conflicts) {
    out.push(`- **${c.s}** — ${P_LABEL[c.p] || c.p} :`);
    for (const v of c.values) out.push(`  - « ${fmtO(v.o)} » — ${v.ref}${v.date ? ` (${v.date})` : ''}`);
    if (c.hint) out.push(`  - ${c.hint}`);
  }
  const st = d.stale;
  out.push('', `## À revoir (${st.length})`, '');
  for (const s of st) out.push(`- **${s.s}** — ${P_LABEL[s.p] || s.p} : ${s.reason === 'index' ? `la ligne d’index ne dit pas que la mémoire est remplacée (${s.truth.ref})` : s.reason === 'contredit' ? `« ${fmtO(s.value)} » contredit par ${s.truth.ref} (« ${fmtO(s.truth.o)} »)` : s.why} — ${s.ref}`);
  return out.join('\n') + '\n';
}

function render(verb, r) {
  if (r && r.known === false) return r.message;
  switch (verb) {
    case 'contradictions': return contradictionsMarkdown({ ...cache?.idx?.derived, conflicts: r.conflicts, stale: r.stale, builtAt: cache?.idx?.derived?.builtAt, sources: cache?.idx?.derived?.sources }).trim();
    case 'impact': {
      if (!r.available) return r.message;
      const l = [`# Impact de ${r.file}`, r.full ? `- **non-régression complète** : ${r.full}` : `- suites (${r.suites.length}) : ${r.suites.map(s => s.file).join(', ')}`, `- étage HTTP : ${r.http ? 'oui' : 'non'} ; navigateur : ${r.browser ? 'oui' : 'non'} ; périmètre : ${r.perimeter || '—'}`];
      if (r.exigences.length) l.push(`- ⚠ exigences protégées (${r.exigences.length}) :`, ...r.exigences.slice(0, 30).map(e => `  - ${e.exigence} (${e.suite}${e.version ? `, ${e.version.replace('version:', 'v')}` : ''}) — ${e.label}`));
      if (r.decisions.length) l.push('- décisions :', ...r.decisions.map(d => `  - ${d.decision.replace('decision:', '')} (${d.via}) — ${d.label}`));
      return l.join('\n');
    }
    default: return JSON.stringify(r, null, 2);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
async function main(argv) {
  const args = argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
  const asJson = !!flag('--json'), force = !!flag('--force'), corpus = flag('--corpus'), runs = flag('--runs'), state = flag('--state'), noLive = !!flag('--no-live');
  const from = flag('--from'), projet = flag('--projet');
  const [verb, arg] = args;
  const root = rootOf();
  if (verb === 'mode') {
    if (!arg) { const s = readKgSettings(root); console.log(`kg.mode = ${s.mode}${s.since ? ` depuis ${s.since} (${s.by})` : ''}`); return 0; }
    try { const s = writeKgSettings(root, { mode: arg, by: `kg mode ${arg}` }); console.log(`kg.mode = ${s.mode}`); return 0; } catch (e) { console.error(e.message); return 64; }
  }
  const settings = readKgSettings(root);
  if (verb === 'build') {
    const r = await build(root, { corpus: corpus === true ? null : corpus, runs: runs === true ? null : runs, state: state === true ? null : state, live: !noLive, force });
    if (!r.ok) { console.error(r.message); return 2; }
    console.log(asJson ? JSON.stringify(r.summary) : `index construit : ${r.summary.nodes} nœuds, ${r.summary.facts} faits (${r.summary.rejected} rejetés), ${r.summary.conflicts} conflits, ${r.summary.stale} à revoir, ${r.summary.ms} ms → ${KG_DIR}/derived.json`);
    return 0;
  }
  if (!['fiche', 'regles', 'impact', 'explique', 'historique', 'contradictions', 'perimes', 'port-libre'].includes(verb)) {
    console.error('usage: node scripts/kg.mjs build|fiche <p>|regles [--projet p]|impact <fichier>|explique <id>|historique <case>|contradictions|perimes|port-libre [--from n]|mode [off|shadow|assist] [--json] [--force]');
    return 64;
  }
  if (settings.mode === 'off' && !force) { console.error('index désactivé (kg.mode = off) — --force pour interroger quand même'); return 2; }
  const idx = loadIndex(root);
  if (!idx) { console.error(`index absent : node scripts/kg.mjs build${settings.mode === 'off' ? ' --force' : ''}`); return 2; }
  const t0 = process.hrtime.bigint();
  let r;
  if (verb === 'fiche') r = fiche(idx, arg);
  else if (verb === 'regles') r = regles(idx, { projet: projet === true ? null : projet || arg || null });
  else if (verb === 'impact') r = impact(idx, arg);
  else if (verb === 'explique') r = explique(idx, arg);
  else if (verb === 'historique') r = historique(idx, arg);
  else if (verb === 'contradictions') r = contradictions(idx);
  else if (verb === 'perimes') r = perimes(idx);
  else r = await portLibre(idx, { from: from ? Number(from) : undefined });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(asJson ? JSON.stringify({ ...r, ms }) : render(verb, r));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then((c) => process.exit(c), (e) => { console.error(e?.stack || String(e)); process.exit(1); });
}
