// ============================================================================
// scripts/id-resolve.mjs — what an identifier written by a model designates
// (0.107.0)
// ============================================================================
//
// User request (2026-10-16): « il faut que toutes references a un identifiant
// quelconque soit un lien qui ouvre un overlay qui decrit ou explique ce qu'est
// cet identifiant ». The web client turns every identifier of a model output
// into a link (public/id-links.js); a click asks GET /api/identify, served by
// `resolveId` below, from the server's REAL data:
//   todo     t-xxxxxx               TODO_LIST.md of each config.json project
//   run      p-YYYYMMDDTHHMMSS-xxxxxx  logs/runs/<run>/run.json
//   queue    q-<digits>-<hex>       logs/queue/<project>.json
//   attente  8 hex characters       logs/routage-pending.json (Routage task)
//   commit   7–40 hex characters    `git log -1` in the config.json repositories
//   version  vX.Y.Z                 CHANGELOG.md of the project (or the server)
//   projet   a config.json name     config.json
//   fichier  a path                 stat only, inside a project folder
//   case     pipeline.step[.variant]  page Models (model-routing.json)
// READ-ONLY: no write, no content of a file, `git log` only (argv array,
// GIT_OPTIONAL_LOCKS=0). An identifier nothing knows gets `known: false` and a
// plain explanation, never an error.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseChangelog } from './release-notes.mjs';
import { readPending, idOf as pendingIdOf, titleOf as pendingTitleOf } from './routage-pending.mjs';

export const KINDS = {
  todo: 'Item de TODO list',
  run: 'Exécution de pipeline',
  queue: 'Entrée de file d’attente',
  attente: 'Tâche du Routage en attente',
  commit: 'Commit git',
  version: 'Version',
  projet: 'Projet (musicien)',
  fichier: 'Fichier',
  case: 'Case de la page Models',
};
// Prefixes a model may write in [[kind:value]]; the canonical ones come first.
export const KIND_ALIASES = {
  todo: 'todo', tache: 'todo', 'tâche': 'todo', item: 'todo',
  run: 'run', execution: 'run', 'exécution': 'run',
  queue: 'queue',
  attente: 'attente', pending: 'attente',
  commit: 'commit', sha: 'commit',
  version: 'version',
  projet: 'projet', project: 'projet', musicien: 'projet',
  fichier: 'fichier', file: 'fichier', chemin: 'fichier', path: 'fichier',
  case: 'case', slot: 'case',
};

export const TODO_RE = /^t-[0-9a-f]{6}$/;
export const RUN_RE = /^p-\d{8}T\d{6}-[0-9a-f]{6}$/;
export const QUEUE_RE = /^q-\d{10,16}-[0-9a-f]{3,8}$/;
export const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
export const HEX8_RE = /^[0-9a-f]{8}$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/;
export const SLOT_RE = /^[a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z0-9-]+)?$/;
const MAX_ID = 300;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const field = (k, v) => (v === undefined || v === null || v === '' ? null : { k, v: String(v) });

/** "fichier:a/b.js" → {kind: 'fichier', value: 'a/b.js'}; "I:\x" keeps its drive letter. */
export function splitExplicit(raw) {
  const s = String(raw ?? '').trim();
  const m = /^([a-zà-ÿ]{2,10})\s*:\s*(.+)$/i.exec(s);
  if (m && KIND_ALIASES[m[1].toLowerCase()]) return { kind: KIND_ALIASES[m[1].toLowerCase()], value: m[2].trim() };
  return { kind: null, value: s };
}

/** Candidate kinds of a bare value, most likely first. */
export function guessKinds(value, { projects = [], pipelines = [] } = {}) {
  const v = String(value || '');
  if (TODO_RE.test(v)) return ['todo'];
  if (RUN_RE.test(v)) return ['run'];
  if (QUEUE_RE.test(v)) return ['queue'];
  if (VERSION_RE.test(v) && /^v/.test(v)) return ['version'];
  if (HEX8_RE.test(v)) return ['attente', 'commit'];
  if (SHA_RE.test(v)) return ['commit'];
  if (projects.some(p => p.name === v)) return ['projet'];
  if (SLOT_RE.test(v) && pipelines.some(p => p.id === v.split('.')[0])) return ['case'];
  if (/[\\/]/.test(v) || /\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(v)) return ['fichier'];
  if (VERSION_RE.test(v)) return ['version'];
  return [];
}

function gitLog(dir, rev) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'log', '-1', '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%D', `${rev}^{commit}`, '--'],
      { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 4000, windowsHide: true, encoding: 'utf8' },
      (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

/** Projects with a folder, the context one first (then the server's own folder). */
function orderedProjects(ctx) {
  const ps = (ctx.projects || []).filter(p => p && p.name && p.path);
  const first = ps.filter(p => p.name === ctx.contextProject);
  const own = ps.filter(p => p.name !== ctx.contextProject && path.resolve(p.path) === path.resolve(ctx.root || ''));
  const rest = ps.filter(p => !first.includes(p) && !own.includes(p));
  const out = [...first, ...own, ...rest];
  if (ctx.root && !own.length && !first.some(p => path.resolve(p.path) === path.resolve(ctx.root))) out.splice(first.length, 0, { name: null, path: ctx.root, server: true });
  return out;
}

const RESOLVERS = {
  todo(id, ctx) {
    for (const p of orderedProjects(ctx)) {
      if (!p.name) continue;
      const i = (ctx.todoOf(p) || []).find(x => x.id === id);
      if (!i) continue;
      const state = i.rejected ? 'rejeté par l’utilisateur' : i.status === 'done' ? 'fait' : i.status === 'progress' ? 'en cours' : 'à faire';
      return {
        title: i.title, project: p.name, state, tone: i.rejected ? 'muted' : i.status === 'done' ? 'ok' : i.status === 'progress' ? 'live' : 'todo',
        date: i.addedAt || null,
        summary: clip(i.detailFull || i.detail || '', 600) || null,
        fields: [field('Liste', `TODO_LIST.md de ${p.name}`), field('Type', i.type), field('Entré le', i.addedAt && `${i.addedEstimated ? '≈ ' : ''}${i.addedAt}`),
          field('Fait le', i.status === 'done' && !i.rejected ? `${i.doneAt || '—'}${i.doneBy ? ` par ${i.doneBy}` : ''}` : null),
          field('Rejeté le', i.rejected?.at)].filter(Boolean),
        links: [{ label: 'Ouvrir dans le panneau TODO', open: 'todo', item: id }, { label: `Volet de ${p.name}`, musician: p.name }],
      };
    }
    return null;
  },

  run(id, ctx) {
    const st = readJson(path.join(ctx.logsDir, 'runs', id, 'run.json'));
    if (!st) return null;
    const pl = (ctx.pipelines || []).find(p => p.id === st.pipeline);
    const done = (st.steps || []).filter(s => s.status && !['failed', 'refused', 'running'].includes(s.status)).length;
    const STATUS = { running: 'en cours', paused: 'en pause', done: 'terminée', failed: 'en échec', abandoned: 'abandonnée' };
    return {
      title: `${pl?.label || st.pipeline}${st.mode ? ` (${st.mode})` : ''} — ${st.project}`,
      project: st.project, state: STATUS[st.status] || st.status, tone: st.status === 'done' ? 'ok' : st.status === 'running' ? 'live' : st.status === 'paused' ? 'todo' : 'bad',
      date: st.createdAt || null,
      summary: clip(st.request, 500) || null,
      fields: [field('Pipeline', pl ? `${pl.icon || ''} ${pl.label}`.trim() : st.pipeline), field('Mode', st.mode), field('Projet', st.project),
        field('Étapes', `${done} faite(s) sur ${(st.plan || []).length || (st.steps || []).length}`),
        field('Dernière étape', (st.steps || []).slice(-1)[0]?.title),
        field('Commencée le', st.createdAt), field('Fin', st.status !== 'running' ? st.endedAt : null),
        field('Artefacts', st.project ? `.orchestrateur/runs/${id}/ (dans ${st.project})` : null)].filter(Boolean),
      links: [st.pipeline === 'routage' ? { label: 'Voir le découpage (onglet Requêtes)', open: 'requests' } : null,
        st.project ? { label: `Volet de ${st.project}`, musician: st.project } : null].filter(Boolean),
    };
  },

  queue(id, ctx) {
    const dir = path.join(ctx.logsDir, 'queue');
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return null; }
    for (const f of files) {
      const q = readJson(path.join(dir, f));
      if (!Array.isArray(q)) continue;
      const at = q.findIndex(e => e?.id === id);
      if (at < 0) continue;
      const e = q[at], project = f.replace(/\.json$/, '');
      return {
        title: clip(e.text, 90) || id, project, state: `en attente (position ${at + 1} sur ${q.length})`, tone: 'todo',
        date: e.queuedAt || e.at || e.createdAt || null,
        summary: clip(e.text, 600) || null,
        fields: [field('Musicien', project), field('Position', `${at + 1} / ${q.length}`), field('Source', e.source),
          field('Model', e.model), field('Pipeline', e.pipeline)].filter(Boolean),
        links: [{ label: `Volet de ${project} (file)`, musician: project }],
      };
    }
    return null;
  },

  attente(id, ctx) {
    const t = readPending(ctx.logsDir).find(x => pendingIdOf(x) === id);
    if (!t) return null;
    const { titre, fallback } = pendingTitleOf(t);
    return {
      title: titre + (fallback ? ' (titre de repli)' : ''), project: t.projet, state: 'en attente de libération', tone: 'todo',
      date: t.createdAt || null,
      summary: clip(t.demande, 600) || null,
      fields: [field('Pour', t.projet), field('Routage', t.run), field('Tâche n°', t.n),
        field('Attend', t.after ? `la fin d’une tâche de ${t.after.projet}` : null),
        field('Reprise de', t.reprise), field('Créée le', t.createdAt)].filter(Boolean),
      links: [{ label: 'Voir le découpage (onglet Requêtes)', open: 'requests' }, t.projet ? { label: `Volet de ${t.projet}`, musician: t.projet } : null].filter(Boolean),
    };
  },

  async commit(id, ctx) {
    for (const p of orderedProjects(ctx)) {
      try { if (!fs.existsSync(path.join(p.path, '.git'))) continue; } catch { continue; }
      const out = await ctx.gitLog(p.path, id);
      if (!out) continue;
      const [sha, author, date, subject, refs] = out.split('\x1f');
      const where = p.name || 'orchestrateur (ce serveur)';
      return {
        title: subject || sha, project: p.name || null, state: refs ? `références : ${refs}` : null, tone: 'neutral',
        date: date || null,
        fields: [field('SHA', sha), field('Dépôt', where), field('Auteur', author), field('Date', date), field('Références', refs)].filter(Boolean),
        links: [{ label: 'Voir l’arbre git (onglet Git)', open: 'git', project: p.name || null }, p.name ? { label: `Volet de ${p.name}`, musician: p.name } : null].filter(Boolean),
      };
    }
    return null;
  },

  version(id, ctx) {
    const v = id.replace(/^v/i, '');
    for (const p of orderedProjects(ctx)) {
      let text;
      try { text = fs.readFileSync(path.join(p.path, 'CHANGELOG.md'), 'utf8'); } catch { continue; }
      const entry = parseChangelog(text).versions.find(x => x.version === v);
      if (!entry) continue;
      const isServer = path.resolve(p.path) === path.resolve(ctx.root || '');
      const items = entry.sections.flatMap(s => s.items.map(i => `${s.name} : ${clip(i, 220)}`));
      return {
        title: `Version ${v}${p.name ? ` de ${p.name}` : ''}`, project: p.name || null,
        state: isServer && ctx.serverVersion ? (ctx.serverVersion === v ? 'version servie par ce serveur'
          : `ce serveur sert la ${ctx.serverVersion}`) : null, tone: isServer && ctx.serverVersion === v ? 'ok' : 'neutral',
        date: entry.date,
        summary: items.slice(0, 4).join('\n') + (items.length > 4 ? `\n… (${items.length - 4} autre(s) élément(s))` : ''),
        fields: [field('CHANGELOG', `${p.name || 'orchestrateur'} / CHANGELOG.md`), field('Date', entry.date),
          field('Sections', entry.sections.map(s => `${s.name} (${s.items.length})`).join(', '))].filter(Boolean),
        links: [{ label: 'Voir la release (onglet Release)', open: 'release', project: p.name || null }],
      };
    }
    return null;
  },

  projet(id, ctx) {
    const p = (ctx.projects || []).find(x => x && x.name === id);
    if (!p) return null;
    const isChef = id === ctx.conductor;
    const items = p.path ? ctx.todoOf(p) || [] : [];
    const open = items.filter(i => i.status !== 'done').length;
    let git = false;
    try { git = !!p.path && fs.existsSync(path.join(p.path, '.git')); } catch { /* unreadable: no git */ }
    return {
      title: id, project: id, state: null, tone: 'neutral',
      summary: isChef ? 'Le chef : il reçoit vos messages, découpe et route les tâches vers les musiciens.' : (p.description || null),
      fields: [field('Rôle', isChef ? 'chef (routeur)' : p.devOf ? `instance de développement de ${p.devOf}` : 'musicien'),
        field('Dossier', p.path || p.cwd), field('Dépôt git', p.path ? (git ? 'oui' : 'non') : null),
        field('Provider', p.provider), field('TODO', items.length ? `${open} à faire sur ${items.length}` : null)].filter(Boolean),
      links: [{ label: `Ouvrir le volet de ${id}`, musician: id }, items.length ? { label: 'Sa TODO list', open: 'todo' } : null,
        git ? { label: 'Son arbre git', open: 'git', project: id } : null].filter(Boolean),
    };
  },

  fichier(id, ctx) {
    const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(id);
    const rel = m[1], line = m[2] || null;
    if (!rel || /\0/.test(rel)) return null;
    // An absolute path belongs to the deepest project folder that contains it.
    const candidates = orderedProjects(ctx);
    if (path.isAbsolute(rel)) candidates.sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length);
    for (const p of candidates) {
      const base = path.resolve(p.path);
      const full = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(base, rel);
      const inside = full === base || full.startsWith(base + path.sep);
      if (!inside) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const relPath = path.relative(base, full).replace(/\\/g, '/') || '.';
      return {
        title: relPath, project: p.name || null, state: st.isDirectory() ? 'dossier' : 'fichier', tone: 'neutral',
        date: st.mtime.toISOString(),
        fields: [field('Projet', p.name || 'orchestrateur (ce serveur)'), field('Chemin', full), field('Ligne', line),
          field('Taille', st.isDirectory() ? null : `${st.size.toLocaleString('fr-FR')} octets`), field('Modifié le', st.mtime.toISOString())].filter(Boolean),
        links: p.name ? [{ label: `Volet de ${p.name}`, musician: p.name }] : [],
      };
    }
    return null;
  },

  case(id, ctx) {
    const [pid, sid, vid] = id.split('.');
    const pl = (ctx.pipelines || []).find(p => p.id === pid);
    if (!pl) return null;
    const steps = pl.flow.flatMap(n => (n.kind === 'loop' ? n.steps : [n]));
    const step = steps.find(s => s.id === sid);
    if (!step) return null;
    const variant = vid ? (step.variants || []).find(v => v.id === vid) : null;
    if (vid && !variant) return null;
    const a = (ctx.assignments || {})[id];
    const fmt = (x) => (x ? `${x.provider} · ${x.model}` : null);
    return {
      title: `${pl.label} · ${step.n || ''} ${step.title}${variant ? ` · ${variant.label}` : ''}`.replace(/\s+/g, ' '), project: null,
      state: a ? `model : ${fmt(a)}` : vid ? 'hérite de l’étape' : 'défaut du projet', tone: a ? 'ok' : 'neutral',
      summary: clip(variant?.what || step.what || pl.purpose || '', 500) || null,
      fields: [field('Pipeline', `${pl.icon || ''} ${pl.label}`.trim()), field('Étape', step.title), field('Variante', variant?.label),
        field('Model principal', fmt(a)), field('Second model', fmt(a?.second)), field('Type', step.judge ? 'jugement' : 'action')].filter(Boolean),
      links: [{ label: 'Ouvrir la page Models', route: '#/models' }],
    };
  },
};

/**
 * {raw, kind?} → {ok, known, id, kind, kindLabel, title?, state?, …} or, for
 * an identifier nothing knows, {known: false, message}.
 * ctx = {root, logsDir, projects, conductor, todoOf(p), pipelines,
 *        assignments, serverVersion, contextProject, gitLog?(dir, rev)}.
 */
export async function resolveId(raw, kindHint, ctx) {
  const ex = splitExplicit(String(raw ?? '').slice(0, MAX_ID));
  const value = ex.value.replace(/^[`'"«\s]+|[`'"»\s.,;:!?)]+$/g, '');
  const hint = KIND_ALIASES[String(kindHint || '').toLowerCase()] || ex.kind;
  const c = { gitLog, ...ctx };
  if (!value) return { ok: true, known: false, id: '', kind: null, message: 'Identifiant vide.' };
  const kinds = hint ? [hint] : guessKinds(value, c);
  for (const kind of kinds) {
    const fn = RESOLVERS[kind];
    if (!fn) continue;
    let r = null;
    try { r = await fn(kind === 'version' && !/^v/.test(value) ? `v${value}` : value, c); } catch { r = null; }
    if (r) return { ok: true, known: true, id: value, kind, kindLabel: KINDS[kind], ...r };
  }
  const guess = kinds[0] || null;
  return {
    ok: true, known: false, id: value, kind: guess, kindLabel: guess ? KINDS[guess] : null,
    message: guess
      ? `« ${value} » a la forme d’un identifiant de type « ${KINDS[guess]} », mais l’orchestrateur ne le trouve pas${kinds.length > 1 ? ` (cherché aussi comme ${kinds.slice(1).map(k => KINDS[k]).join(', ')})` : ''} : il a peut-être été supprimé, mal recopié, ou il appartient à un autre poste.`
      : `« ${value} » n’a la forme d’aucun identifiant connu (tâche, exécution, file, commit, version, projet, fichier, case de la page Models) et l’orchestrateur ne le trouve nulle part.`,
  };
}

/** What the client needs to recognise identifiers in text. */
export function idVocabulary(ctx) {
  return {
    kinds: KINDS,
    conductor: ctx.conductor || null,
    projects: (ctx.projects || []).filter(p => p && p.name).map(p => p.name),
    pipelines: (ctx.pipelines || []).map(p => p.id),
    // Exact case ids (pipeline.step and pipeline.step.variant): the client
    // links only those, never a look-alike such as « dev.md5 ».
    slots: (ctx.pipelines || []).flatMap(p => p.flow.flatMap(n => (n.kind === 'loop' ? n.steps : [n]))
      .filter(s => !s.ref).flatMap(s => [`${p.id}.${s.id}`, ...(s.variants || []).map(v => `${p.id}.${s.id}.${v.id}`)])),
  };
}
