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
// Classifieur à RÈGLES (déterministe, gratuit, instantané) : la classification
// par model (case routage.classifier) viendra avec la mise en service et pourra
// être comparée à ce journal. Règle utilisateur : inclassable = Discussion.
//
// Tout ici est défensif : une erreur d'observation ne doit jamais empêcher un
// dispatch. Les appelants entourent chaque appel d'un try/catch.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const OBSERVE_FILE = 'pipeline-observe.ndjson';
export const CLASSIFIER = 'règles-v1';

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

// Mots-clés pondérés par pipeline (français d'abord, anglais courant ensuite).
const RULES = {
  incident: [
    [/\b(crash|plant(e|é|ait)|panne|en panne|ne (marche|fonctionne|répond) plus|cass(é|e)|down|hors service|bloqu(é|e) en prod|urgence|rollback|revenir en arrière|régression|erreur 500|500 error|outage)\b/i, 3],
    [/\b(processus perdu|ne démarre plus|tombé)\b/i, 2],
  ],
  audit: [
    [/\b(audit|faille|vuln(é|e)rab|sécurité|securite|security|fuite de|secret(s)? (exposé|dans)|gitleaks|cve|injection|xss|csrf)\b/i, 3],
  ],
  recherche: [
    [/\b(état de l'art|etat de l'art|comparatif|compar(e|er) (les|des)|benchmark|quelles? (sont les )?(solutions|alternatives|options)|alternatives? à|fais (une|des) recherche|recherche (sur|les)|veille technologique|sources?)\b/i, 3],
  ],
  maintenance: [
    [/\b(mettre à jour les dépendances|mise à jour des dépendances|dépendances|npm (update|audit)|dette technique|nettoy(er|age)|tests? instables?|flaky|upgrade|obsolète)\b/i, 3],
  ],
  nouveau: [
    [/\b(nouveau projet|cr(é|e)e(r)? (un|le) (nouveau )?projet|nouvelle app(lication)?|démarr(er|e) un projet|new project)\b/i, 4],
  ],
  donnees: [
    [/\b(scrap(ing|er|e)|extraire (les|des) données|collecte(r)? (les|des) données|dataset|jeu de données|csv|import(er)? (les|des) données|crawler)\b/i, 3],
  ],
  redaction: [
    [/\b(rédige|rédiger|redige|écris (un|une|le|la) (mail|courriel|e-mail|article|texte|lettre|message|post|résumé)|traduis|tradui(re|ction)|translate|reformule|relis (ce|mon|le) texte|corrige (les fautes|l'orthographe))\b/i, 3],
  ],
  images: [
    [/\b(image|images|icône|icone|logo|illustration|photo|capture d'écran|screenshot|vignette|miniature|png|jpe?g|svg|ocr)\b/i, 2],
    [/\b(génère|générer|dessine|crée) (une|des|l') (image|icône|illustration|logo)\b/i, 3],
  ],
  video: [
    [/\b(vidéo|video|montage|ffmpeg|sous-titres?|chapitres?|mp4|mkv|youtube|séance enregistrée|découpe(r)? (la|une) vidéo)\b/i, 3],
  ],
  audio: [
    [/\b(audio|voix|tts|stt|synthèse vocale|transcri(re|ption|s)|whisper|podcast|mp3|wav|enregistrement sonore|son du|lecture audio)\b/i, 3],
  ],
  dev: [
    [/\b(implémente|implemente|implémenter|ajoute|ajouter|rajoute|rajouter|corrige|corriger|répare|réparer|fix|bug|feature|fonctionnalit(é|e)|refactor|refactoring|modifie|modifier|supprime|supprimer|renomme|renommer|intègre|intégrer|développe|développer|code|coder|commit|push|déploie|déployer|build|compile|bump|version|test(s)?|route|api|endpoint|bouton|écran|vue|page|interface|composant|migration|migre|plan|police)\b/i, 2],
    [/\b(fais en sorte|il faut que|doit (pouvoir|afficher|être)|n'affiche (pas|plus)|ne (s'affiche|marche) pas|donne la possibilité|permet(tre)? de|augmenter|diminuer|afficher)\b/i, 2],
  ],
};

// Verbe de PRODUCTION média : sans lui, un média cité dans une demande de code
// (« implémente une lecture audio ») reste du développement.
const MEDIA_VERB = /\b(transcri(s|re|ption de)|génère (une|des|l')|générer (une|des)|dessine|retouche|monte (la|une|les) vidéo|découpe (la|une) vidéo|sous-titre (la|cette)|synthétise|lis à voix haute|ocr (de|sur)|extrais le texte|nettoie (le|l') (son|audio)|normalise le son)\b/i;
const MEDIA = new Set(['images', 'video', 'audio']);

// Une QUESTION sans verbe d'action : discussion.
const QUESTION_START = /^\s*(pourquoi|comment|est-ce que|est ce que|qu'est-ce|qu est-ce|c'est quoi|que penses-tu|qu'en penses-tu|explique|peux-tu m'expliquer|à quoi sert|quelle est|quel est|quels sont|quelles sont|combien|où en est|ou en est|tu crois|selon toi|why|how|what|which)\b/i;
const ACTION_REQUEST = /\b(peux-tu|pourrais-tu|tu peux|merci de|je veux|je voudrais|j'aimerais|fais|fait|ajoute|rajoute|implémente|corrige|crée|lance|mets|supprime|change|modifie|il faut que|fais en sorte|on peut (aussi )?(rajouter|ajouter|faire|mettre|avoir)|on pourrait)\b/i;

// Développement léger : modification mécanique ou correctif localisé.
const LIGHT = /\b(typo|coquille|faute|libellé|libelle|renomme|renommer|remplace|couleur|marge|espacement|texte du bouton|wording|mise en forme|bump|indentation|commentaire|petit (correctif|fix)|juste)\b/i;
const HEAVY = /\b(nouvelle (fonctionnalité|vue|page|interface)|implémente|implémenter|architecture|refonte|plan|phase|pipeline|plusieurs|toute(s)? les?|tous les|migration|sécurité|étude|etude|concept|fonction|mode)\b/i;

/** Texte utile d'une entrée : sans nos propres blocs de consignes injectées. */
export function normalizeText(text) {
  let t = String(text ?? '');
  const cut = t.search(/\n---\n(RÈGLE|COMMANDES|Une fois ta tâche terminée)/);
  if (cut > 0) t = t.slice(0, cut);
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Classe une entrée. `entry` = sorte d'entrée (voir ENTRY_KINDS) ; les entrées
 * système (réveil, callback, notify, relais vers le chef) appartiennent au
 * pipeline Routage, quel que soit leur texte.
 * Renvoie {pipeline, mode, explicit, confidence, reasons[], unclassifiable}.
 */
export function classify({ text, entry } = {}) {
  const raw = normalizeText(text);
  const reasons = [];
  if (SYSTEM_ENTRIES.has(entry)) {
    return { pipeline: 'routage', mode: null, explicit: false, confidence: 'high', reasons: [`entrée système « ${entry} » : étape du pipeline Routage`], unclassifiable: false };
  }
  let mode = null;
  for (const [re, m] of MODE_PREFIX) if (re.test(raw)) { mode = m; reasons.push(`mode explicite /${m}`); }
  for (const [re, p] of PREFIXES) {
    if (re.test(raw)) {
      reasons.push(`préfixe explicite → ${p}`);
      return { pipeline: p, mode: mode || defaultMode(p, raw), explicit: true, confidence: 'high', reasons, unclassifiable: false };
    }
  }
  const body = raw.replace(/^@\S+\s*/, '');
  if (!body) return { pipeline: 'discussion', mode: 'leger', explicit: false, confidence: 'low', reasons: ['texte vide → Discussion (règle : inclassable = Discussion)'], unclassifiable: true };

  const scores = {};
  for (const [p, rules] of Object.entries(RULES)) {
    for (const [re, w] of rules) {
      const m = re.exec(body);
      if (m) { scores[p] = (scores[p] || 0) + w; reasons.push(`${p} +${w} (« ${m[0]} »)`); }
    }
  }
  // Un média nommé dans une demande de code (« ajoute un bouton image ») reste
  // du développement s'il n'y a pas de verbe propre au média.
  const isQuestion = QUESTION_START.test(body) || (/\?\s*$/.test(body) && !ACTION_REQUEST.test(body));
  if (isQuestion && !ACTION_REQUEST.test(body)) {
    const strong = Object.entries(scores).filter(([p, s]) => p !== 'dev' && s >= 3);
    if (!strong.length || strong.every(([p]) => p === 'recherche')) {
      reasons.push('question sans demande d’action → Discussion');
      if (scores.recherche >= 3 && /\b(état de l'art|comparatif|benchmark|alternatives)\b/i.test(body)) {
        return { pipeline: 'recherche', mode: 'complet', explicit: false, confidence: 'medium', reasons, unclassifiable: false };
      }
      return { pipeline: 'discussion', mode: 'leger', explicit: false, confidence: 'medium', reasons, unclassifiable: false };
    }
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) {
    reasons.push('aucune règle ne s’applique → Discussion (règle : inclassable = Discussion)');
    return { pipeline: 'discussion', mode: 'leger', explicit: false, confidence: 'low', reasons, unclassifiable: true };
  }
  let [best, bestScore] = ranked[0];
  // Média sans verbe de production + demande de code : c'est du développement.
  if (MEDIA.has(best) && scores.dev && !MEDIA_VERB.test(body)) {
    reasons.push(`média cité sans verbe de production → développement`);
    [best, bestScore] = ['dev', scores.dev + bestScore];
  }
  if (best === 'dev' && ranked[1] && ranked[1][1] >= 3 && ['incident', 'audit', 'nouveau'].includes(ranked[1][0])) [best, bestScore] = ranked[1];
  const tie = ranked[1] && ranked[1][1] === bestScore;
  const confidence = bestScore >= 4 && !tie ? 'high' : bestScore >= 2 ? 'medium' : 'low';
  return { pipeline: best, mode: mode || defaultMode(best, body), explicit: false, confidence, reasons, unclassifiable: false };
}

function defaultMode(pipeline, text) {
  if (pipeline === 'discussion') return 'leger';
  if (pipeline !== 'dev') return 'complet';
  if (HEAVY.test(text) || text.length > 400) return 'complet';
  if (LIGHT.test(text) || text.length < 120) return 'leger';
  return 'complet';
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

/** Journal append-only des classifications. */
export function createObserver({ logsDir, now = () => new Date() }) {
  const file = path.join(logsDir, OBSERVE_FILE);
  function record({ entry, project, text, caller, target, link, extra } = {}) {
    const c = classify({ text, entry });
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
      reasons: c.reasons.slice(0, 6),
      classifier: CLASSIFIER,
      head: normalizeText(text).slice(0, 200),
      ...(extra || {}),
    };
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return rec;
  }
  /** Les n plus récentes (fin du fichier seulement), du plus récent au plus ancien. */
  function recent(n = 100) {
    let raw = '';
    try {
      const size = fs.statSync(file).size;
      const len = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, size - len);
      fs.closeSync(fd);
      raw = b.toString('utf8');
    } catch { return { items: [], counts: {}, total: 0 }; }
    const items = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const counts = { byPipeline: {}, byEntry: {}, unclassifiable: 0 };
    for (const r of items) {
      counts.byPipeline[r.pipeline] = (counts.byPipeline[r.pipeline] || 0) + 1;
      counts.byEntry[r.entry] = (counts.byEntry[r.entry] || 0) + 1;
      if (r.unclassifiable) counts.unclassifiable++;
    }
    return { items: items.slice(-n).reverse(), counts, total: items.length };
  }
  return { record, recent, file };
}
