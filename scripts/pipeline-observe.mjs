// ============================================================================
// scripts/pipeline-observe.mjs — pipelines, phase 1 : OBSERVATION (0.41.0)
// ============================================================================
//
// Demande utilisateur : « Il faut que toute entree dans l'orchestrateur passe
// par les pipelines decides dans la page Models ». Plan :
// docs/PLAN-pipeline-enforcement.md. Cette phase ne change AUCUN comportement :
// chaque entrée (composer, @musicien, app, dispatch.mjs, file, réveil, relais,
// notify, session neuve, terminal interactif…) est classée — pipeline + mode —
// et journalisée dans logs/pipeline-observe.ndjson. Rien n'est bloqué, rien
// n'est réécrit dans le prompt.
//
// Depuis 0.66.0, AUCUN classement par mots-clés (demande utilisateur du
// 2026-10-10 : « Ce n'est pas une recherche de mot qui pourra faire un routage
// efficace, c'est une recherche de sens que seul un modele peut faire »). Ce
// journal ne garde que les choix EXPLICITES de l'utilisateur (préfixes /dev,
// /complet…) et la sorte d'entrée ; le classement par le sens est fait par le
// model de la case routage.classifier (scripts/pipeline-classify.mjs).
//
// Tout ici est défensif : une erreur d'observation ne doit jamais empêcher un
// dispatch. Les appelants entourent chaque appel d'un try/catch.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const OBSERVE_FILE = 'pipeline-observe.ndjson';
// Plus de classifieur lexical : une entrée sans choix explicite est « à classer » (par le model).
export const CLASSIFIER = 'explicite';

// Préfixe explicite en tête de message : le choix de l'utilisateur l'emporte.
const PREFIXES = [
  [/^\/(dev|développement|developpement|code)\b/i, 'dev'],
  [/^\/(discussion|question|discuter)\b/i, 'discussion'],
  [/^\/(routage|chef)\b/i, 'routage'],
  [/^\/incident\b/i, 'incident'],
  [/^\/(recherche|veille-techno|etat-de-l-art)\b/i, 'recherche'],
  [/^\/(audit|sécurité|securite)\b/i, 'audit'],
  [/^\/maintenance\b/i, 'maintenance'],
  [/^\/(nouveau|nouveau-projet)\b/i, 'nouveau'],
  [/^\/(données|donnees|scraping)\b/i, 'donnees'],
  [/^\/(rédaction|redaction|traduction)\b/i, 'redaction'],
  [/^\/images?\b/i, 'images'],
  [/^\/(vidéo|video)\b/i, 'video'],
  [/^\/(audio|son)\b/i, 'audio'],
];
const MODE_PREFIX = [[/(^|\s)\/(léger|leger)\b/i, 'leger'], [/(^|\s)\/complet\b/i, 'complet']];

/** Texte utile d'une entrée : sans nos propres blocs de consignes injectées. */
export function normalizeText(text) {
  let t = String(text ?? '');
  const cut = t.search(/\n---\n(RÈGLE|COMMANDES|Une fois ta tâche terminée)/);
  if (cut > 0) t = t.slice(0, cut);
  return t.replace(/\s+/g, ' ').trim();
}

function stripAccents(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, ''); }
const has = (re, s) => new RegExp(stripAccents(re.source), re.flags).test(stripAccents(s));

/**
 * Choix EXPLICITE d'une entrée — jamais une recherche de mots dans la demande :
 *   - un préfixe tapé par l'utilisateur en tête (/dev, /discussion, /incident…)
 *     et un mode explicite (/léger, /complet) ;
 *   - une entrée système (réveil, relais vers le chef, notify), qui appartient
 *     au pipeline Routage par construction.
 * Renvoie {pipeline|null, mode|null, explicit, system}. pipeline null = « à
 * classer » : c'est au model de la case routage.classifier de décider.
 */
export function explicitChoice({ text, entry } = {}) {
  if (SYSTEM_ENTRIES.has(entry)) return { pipeline: 'routage', mode: null, explicit: true, system: true };
  const raw = normalizeText(text);
  let mode = null;
  for (const [re, m] of MODE_PREFIX) if (has(re, raw)) mode = m;
  for (const [re, p] of PREFIXES) if (has(re, raw)) return { pipeline: p, mode, explicit: true, system: false };
  return { pipeline: null, mode, explicit: false, system: false };
}

// Sortes d'entrée. Les « système » appartiennent au pipeline Routage.
export const ENTRY_KINDS = {
  'dashboard:chef':      'Composer du dashboard → chef',
  'dashboard:mention':   'Composer → @musicien (raccourci)',
  'dashboard:musicien':  'Dashboard / API → musicien directement',
  'android:chef':        'App Android → chef',
  'android:mention':     'App Android → @musicien',
  'android:musicien':    'App Android → musicien',
  'dispatch-cli':        'dispatch.mjs lancé hors serveur (chef, humain, script, musicien)',
  'file':                'File d’un musicien (entrée sans observation d’origine)',
  'pool':                'Ticket du chef (sans observation d’origine)',
  'wake':                'Réveil du chef (callback)',
  'relais-vers-chef':    'Question NEEDS_CHEF_INPUT d’un musicien au chef',
  'relais-vers-musicien':'Réponse du chef relayée au musicien',
  'notify':              'notify.mjs / POST /api/notify',
  'session-neuve':       'Session neuve (POST /api/projects/:p/sessions/new)',
  'terminal':            'Terminal interactif (/ws/pty)',
  'spawn':               'Autre lancement serveur (filet de sécurité)',
  'signalement':         'Lacune signalée explicitement (POST /api/pipeline-gaps)',
};
const SYSTEM_ENTRIES = new Set(['wake', 'relais-vers-chef', 'notify']);

/** Projet dont le dossier contient `cwd` (le plus profond), ou null. */
export function projectFromCwd(cwd, projects) {
  const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
  const c = norm(cwd);
  let best = null;
  for (const p of projects || []) {
    if (!p?.path) continue;
    const pp = norm(p.path);
    if ((c === pp || c.startsWith(pp + path.sep)) && (!best || pp.length > norm(best.path).length)) best = p;
  }
  return best ? best.name : null;
}

/**
 * Tampon de lignes du terminal interactif : reçoit les octets tapés (xterm),
 * renvoie les lignes validées par Entrée. Ignore les séquences d'échappement
 * (flèches, collage encadré…) et applique le retour arrière.
 */
export class TerminalLineBuffer {
  constructor(max = 4000) { this.buf = ''; this.max = max; }
  feed(data) {
    const out = [];
    const s = String(data ?? '')
      .replace(/\x1b\[20[01]~/g, '')                 // collage encadré
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')     // CSI
      .replace(/\x1b[O][A-Za-z]/g, '')               // SS3 (flèches)
      .replace(/\x1b./g, '');
    for (const ch of s) {
      if (ch === '\r' || ch === '\n') {
        const line = this.buf.trim();
        this.buf = '';
        if (line) out.push(line);
      } else if (ch === '\x7f' || ch === '\b') {
        this.buf = this.buf.slice(0, -1);
      } else if (ch === '\x03' || ch === '\x15') {      // Ctrl+C, Ctrl+U : ligne abandonnée
        this.buf = '';
      } else if (ch >= ' ' || ch === '\t') {
        if (this.buf.length < this.max) this.buf += ch;
      }
    }
    return out;
  }
}

/** Journal append-only des entrées (choix explicite seulement, jamais de mots-clés). */
export function createObserver({ logsDir, now = () => new Date() }) {
  const file = path.join(logsDir, OBSERVE_FILE);
  // deferGap est accepté pour compatibilité : depuis 0.66.0, une lacune n'est
  // JAMAIS détectée sur le texte ; seuls le model (classement, Routage) ou un
  // signalement explicite en apportent une (`gap`).
  function record({ entry, project, text, caller, target, link, extra, gap: reported } = {}) {
    const e = explicitChoice({ text, entry });
    const c = {
      pipeline: e.pipeline, mode: e.mode, explicit: e.explicit, confidence: e.explicit ? 'explicite' : 'à classer',
      unclassifiable: false,
      reasons: [e.system ? `entrée système « ${entry} » : pipeline Routage` : e.explicit ? `préfixe explicite → ${e.pipeline}` : 'aucun choix explicite : classement par le model de la case routage.classifier'],
    };
    const gap = reported || null;
    const rec = {
      at: now().toISOString(),
      id: `obs-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      entry: entry || 'spawn',
      project: project || null,
      ...(target ? { target } : {}),
      ...(caller ? { caller } : {}),
      ...(link ? { link } : {}),
      pipeline: c.pipeline,
      mode: c.mode,
      explicit: c.explicit,
      confidence: c.confidence,
      unclassifiable: c.unclassifiable,
      ...(c.modeUncertain ? { modeUncertain: true } : {}),
      reasons: c.reasons.slice(0, 6),
      classifier: CLASSIFIER,
      head: normalizeText(text).slice(0, 200),
      ...(gap ? { gap } : {}),
      ...(extra || {}),
    };
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return rec;
  }
  /** Les entrées de la fin du fichier (2 Mio), de la plus ancienne à la plus récente. */
  function readAll() {
    let raw = '';
    try {
      const size = fs.statSync(file).size;
      const len = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, size - len);
      fs.closeSync(fd);
      raw = b.toString('utf8');
    } catch { return []; }
    return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  /** Les n plus récentes, du plus récent au plus ancien. */
  function recent(n = 100) {
    const items = readAll();
    const counts = { byPipeline: {}, byEntry: {}, unclassifiable: 0 };
    for (const r of items) {
      counts.byPipeline[r.pipeline] = (counts.byPipeline[r.pipeline] || 0) + 1;
      counts.byEntry[r.entry] = (counts.byEntry[r.entry] || 0) + 1;
      if (r.unclassifiable) counts.unclassifiable++;
    }
    return { items: items.slice(-n).reverse(), counts, total: items.length };
  }
  /**
   * Lacunes signalées, regroupées par clé (une demande répétée = une lacune,
   * avec son compte). `decisions` (clé → décision) les sépare : ouvertes /
   * décidées.
   */
  function gaps(decisions = {}) {
    const by = new Map();
    for (const r of readAll()) {
      if (!r.gap?.key) continue;
      const g = by.get(r.gap.key) || { ...r.gap, count: 0, firstAt: r.at, entries: [] };
      g.count++;
      g.lastAt = r.at;
      if (g.entries.length < 5) g.entries.push({ at: r.at, entry: r.entry, project: r.project, head: r.head, pipeline: r.pipeline, obsId: r.id });
      by.set(r.gap.key, g);
    }
    const list = [...by.values()].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    return {
      open: list.filter(g => !decisions[g.key]),
      decided: list.filter(g => decisions[g.key]).map(g => ({ ...g, decision: decisions[g.key] })).slice(0, 30),
    };
  }
  return { record, recent, gaps, file };
}
