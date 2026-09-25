// ============================================================================
// scripts/downloads-registry.mjs — registre de la page /downloads, à chaud
// ============================================================================
//
// Jusqu'à 0.22.3, la liste des apps, leur plateforme, leur source de version
// et le registre des docs étaient des constantes de server.js : ajouter une
// carte exigeait un redémarrage du serveur. Ils vivent désormais dans
// `downloads.json` (versionné, distinct de config.json) et ce module le relit
// quand son mtime/taille change — un `stat` par requête, pas de watcher.
//
// Tout ou rien : si le fichier est illisible, mal formé ou contient UNE entrée
// invalide, on garde la dernière version valide et on journalise l'erreur une
// seule fois par version du fichier. La page ne répond jamais 500 pour une
// faute de frappe dans le JSON.
//
// Les chemins lus (source de version, fallbacks de doc) viennent de ce fichier
// versionné, jamais d'une requête. Les noms qui entrent dans une URL ou un
// chemin sous builds/ sont contraints à un alphabet sans séparateur.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_\-]{0,63}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/;

// Kotlin DSL : `versionName = "x"` · Groovy : `versionName "x"`. Insensible à
// la casse (un projet écrit `VersionName`) ; le lookahead négatif évite
// `versionNameSuffix`.
export const VERSION_NAME_RE = /versionName(?![A-Za-z])\s*=?\s*["']([^"']+)["']/i;

const EMPTY = Object.freeze({ apps: [], docs: [] });

/** Valide et normalise le contenu parsé. Renvoie { value } ou { errors }. */
export function validateRegistry(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['la racine doit être un objet { apps: [...], docs: [...] }'] };
  }
  if (!Array.isArray(raw.apps)) errors.push('`apps` doit être un tableau');
  if (raw.docs !== undefined && !Array.isArray(raw.docs)) errors.push('`docs` doit être un tableau');
  if (errors.length) return { errors };

  const apps = [];
  const seenApps = new Set();
  raw.apps.forEach((a, i) => {
    const at = `apps[${i}]`;
    if (!a || typeof a !== 'object') { errors.push(`${at} : objet attendu`); return; }
    if (typeof a.name !== 'string' || !NAME_RE.test(a.name)) { errors.push(`${at}.name invalide`); return; }
    if (seenApps.has(a.name)) errors.push(`${at} : « ${a.name} » en double`);
    seenApps.add(a.name);
    const app = { name: a.name, label: a.name, platform: 'phone', description: '', version: null };
    for (const k of ['label', 'platform', 'description']) {
      if (a[k] === undefined) continue;
      if (typeof a[k] !== 'string' || !a[k].trim()) errors.push(`${at}.${k} doit être une chaîne non vide`);
      else app[k] = a[k].trim();
    }
    if (a.version !== undefined) {
      const v = a.version;
      if (!v || typeof v !== 'object' || typeof v.file !== 'string' || !path.isAbsolute(v.file)) {
        errors.push(`${at}.version.file doit être un chemin absolu`);
      } else {
        let re = VERSION_NAME_RE;
        if (v.regex !== undefined) {
          // Pas de `g`/`y` : la regex est réutilisée à chaque requête et
          // `lastIndex` ferait échouer une lecture sur deux.
          if (v.flags !== undefined && (typeof v.flags !== 'string' || !/^[imsu]*$/.test(v.flags))) {
            errors.push(`${at}.version.flags : seuls i, m, s, u sont permis`);
          }
          try {
            re = new RegExp(v.regex, typeof v.flags === 'string' ? v.flags : '');
            // Il faut un groupe capturant : c'est lui qui porte la version.
            if (new RegExp(`${re.source}|`).exec('').length < 2) errors.push(`${at}.version.regex : un groupe capturant est requis`);
          } catch (e) { errors.push(`${at}.version.regex invalide : ${e.message}`); }
        }
        app.version = { file: v.file, re };
      }
    }
    apps.push(app);
  });

  const docs = [];
  const seenDocs = new Set();
  (raw.docs || []).forEach((d, i) => {
    const at = `docs[${i}]`;
    if (!d || typeof d !== 'object') { errors.push(`${at} : objet attendu`); return; }
    if (typeof d.project !== 'string' || !NAME_RE.test(d.project)) { errors.push(`${at}.project invalide`); return; }
    if (typeof d.id !== 'string' || !SLUG_RE.test(d.id)) { errors.push(`${at}.id invalide (a-z0-9_-)`); return; }
    if (typeof d.title !== 'string' || !d.title.trim()) errors.push(`${at}.title requis`);
    if (typeof d.file !== 'string' || !FILE_RE.test(d.file)) errors.push(`${at}.file : nom de fichier simple requis (sous builds/<project>/)`);
    const fallbacks = d.fallbacks === undefined ? [] : d.fallbacks;
    if (!Array.isArray(fallbacks) || !fallbacks.every(f => typeof f === 'string' && path.isAbsolute(f))) {
      errors.push(`${at}.fallbacks doit être un tableau de chemins absolus`);
    }
    const key = `${d.project}/${d.id}`;
    if (seenDocs.has(key)) errors.push(`${at} : « ${key} » en double`);
    seenDocs.add(key);
    docs.push({ project: d.project, id: d.id, title: String(d.title || '').trim(), file: d.file, fallbacks: Array.isArray(fallbacks) ? fallbacks : [] });
  });

  return errors.length ? { errors } : { value: { apps, docs } };
}

/**
 * Registre rechargé à chaud. `log(msg)` reçoit les erreurs de validation (une
 * fois par version du fichier) et les rechargements réussis.
 */
export function createDownloadsRegistry({ file, buildsDir, log = () => {} }) {
  let good = EMPTY;          // dernière version valide
  let key = null;            // mtime:size de la dernière version LUE (valide ou non)

  function current() {
    let st;
    try { st = fs.statSync(file); }
    catch {
      if (key !== 'missing') { key = 'missing'; log(`[downloads] ${file} introuvable — dernière version valide conservée (${good.apps.length} apps)`); }
      return good;
    }
    const k = `${st.mtimeMs}:${st.size}`;
    if (k === key) return good;
    key = k;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
    catch (e) { log(`[downloads] JSON invalide (${e.message}) — dernière version valide conservée`); return good; }
    const r = validateRegistry(parsed);
    if (r.errors) { log(`[downloads] registre refusé — dernière version valide conservée :\n  - ${r.errors.join('\n  - ')}`); return good; }
    good = r.value;
    log(`[downloads] registre chargé : ${good.apps.length} apps, ${good.docs.length} docs`);
    return good;
  }

  function readAppVersion(app) {
    if (!app.version) return 'unknown';
    try {
      const m = app.version.re.exec(fs.readFileSync(app.version.file, 'utf8'));
      return m ? m[1] : 'unknown';
    } catch { return 'unknown'; }
  }

  return {
    current,
    findApp(name) { return current().apps.find(a => a.name === name) || null; },
    findDoc(project, id) { return current().docs.find(d => d.project === project && d.id === id) || null; },
    apkPath(name) { return path.join(buildsDir, name, 'latest.apk'); },
    /** Modèle de carte unifié : app (APK), doc seul, ou les deux. Les apps
     *  gardent leur ordre, les projets doc-seul suivent. Tout est lu à l'appel :
     *  version, présence de latest.apk, registre. */
    entries() {
      const reg = current();
      const byProject = new Map();
      const ensure = (name) => {
        if (!byProject.has(name)) byProject.set(name, { name, label: name, description: '', version: null, apk: false, apkAvailable: false, platform: null, docs: [] });
        return byProject.get(name);
      };
      for (const a of reg.apps) {
        const e = ensure(a.name);
        e.label = a.label;
        e.description = a.description;
        e.version = readAppVersion(a);
        e.apk = true;
        e.apkAvailable = fs.existsSync(path.join(buildsDir, a.name, 'latest.apk'));
        e.platform = a.platform;
      }
      for (const d of reg.docs) ensure(d.project).docs.push({ id: d.id, title: d.title });
      return [...byProject.values()];
    },
  };
}
