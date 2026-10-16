// ============================================================================
// scripts/meeting-check.mjs — exit criteria of the « Compte rendu de réunion »
// pipeline (reunion, 0.110.0), checked by code
// ============================================================================
//
// User request (2026-10-16): « Il faut un nouveau pipeline, plus adapté aux
// demandes de gestion de compte rendu de réunions ». A meeting request had
// gone to Maintenance, which upkeeps code and tidied nothing.
//
// The model inventories, sorts, writes and files; the CODE checks every claim
// against the disk and deletes the drafts itself, from the explicit list only:
//   inventaire.json   every listed file exists, every role is known
//   suppression.json  every inventoried file is in exactly ONE list
//                     (supprimer | garder | doutes); only drafts and
//                     duplicates may be deleted; doubts are asked, never deleted
//   definitif.json    the definitive text is written EXACTLY as the user gave
//                     it (normalised whitespace and quotes only)
//   rangement.json    one folder, one index named after the meeting, every
//                     kept element inside the folder and cited by the index
//   verification      everything expected exists, everything deleted is gone
// Deleted files are moved to logs/runs/<run>/corbeille/ (never lost).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

export const ROLES = ['mail-definitif', 'brouillon', 'doublon', 'video', 'audio', 'transcription', 'avis', 'notes', 'piece-jointe', 'autre'];
// Only these roles may be deleted: the user asked to delete drafts, nothing else.
export const DELETABLE_ROLES = ['brouillon', 'doublon'];
// A kept element of these roles must be filed in the meeting folder.
export const FILED_ROLES = ['mail-definitif', 'video', 'audio', 'transcription', 'avis', 'notes', 'piece-jointe'];
export const NO_DEFINITIVE = 'AUCUN_TEXTE_DEFINITIF';

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Text compared for « exactly as given »: NFC, typographic quotes and spaces unified, whitespace collapsed. */
export function normText(s) {
  return String(s ?? '').normalize('NFC')
    .replace(/[‘’‛′]/g, "'").replace(/[“”„«»]/g, '"')
    .replace(/[   ]/g, ' ').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ').trim();
}

/** Same, without accents nor case: used to find the meeting name in the index. */
export function foldText(s) { return fold(normText(s)); }

export function parseJson(text) {
  try { return JSON.parse(String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
}

/**
 * Project-relative POSIX path of `p`, or null when it leaves the project or
 * points into git's or the orchestrator's own folders.
 */
export function safeRel(cwd, p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const abs = path.resolve(cwd, p.trim());
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join('/');
  if (/^(\.git|\.orchestrateur)(\/|$)/.test(posix)) return null;
  return posix;
}

const isFile = (cwd, rel) => { try { return fs.statSync(path.join(cwd, rel)).isFile(); } catch { return false; } };
const pathOf = (x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.chemin : null);
const sameRel = (cwd, a, b) => { const x = safeRel(cwd, a), y = safeRel(cwd, b); return !!x && x.toLowerCase() === (y || '').toLowerCase(); };

/** True when `text` is, once normalised, a passage of the request of at least 40 characters. */
export function isVerbatim(text, demande) {
  const body = normText(text);
  return body.length >= 40 && normText(demande).includes(body);
}

/**
 * inventaire.json → { ok, value: {nom, dossier, fichiers:[{chemin, role}]} } | { ok:false, why }
 * `exists: false` reads it back after files were deleted or moved (later steps).
 */
export function checkInventory(cwd, art, { exists = true } = {}) {
  const j = parseJson(art);
  if (!j || typeof j !== 'object') return { ok: false, why: 'inventaire.json n’est pas un JSON valide' };
  const nom = typeof j.nom === 'string' ? j.nom.replace(/\s+/g, ' ').trim() : '';
  if (nom.length < 5) return { ok: false, why: 'inventaire.json : « nom » absent — le nom sous lequel l’ensemble doit être retrouvé (ex. « réunion de lancement du 16 octobre »)' };
  const dossier = safeRel(cwd, j.dossier);
  if (!dossier) return { ok: false, why: `inventaire.json : « dossier » invalide (« ${j.dossier ?? ''} ») — un chemin relatif DANS le projet` };
  if (!Array.isArray(j.fichiers) || !j.fichiers.length) return { ok: false, why: 'inventaire.json : « fichiers » vide — liste chaque fichier de la réunion avec son rôle' };
  const seen = new Set(), files = [];
  for (const f of j.fichiers) {
    const rel = safeRel(cwd, pathOf(f));
    if (!rel) return { ok: false, why: `inventaire.json : chemin invalide « ${pathOf(f) ?? ''} » (hors du projet, ou dans .git / .orchestrateur)` };
    if (exists && !isFile(cwd, rel)) return { ok: false, why: `inventaire.json : fichier inexistant « ${rel} » (chaque fichier inventorié doit exister)` };
    const role = String(f?.role || '').trim().toLowerCase();
    if (!ROLES.includes(role)) return { ok: false, why: `inventaire.json : rôle « ${f?.role ?? ''} » inconnu pour « ${rel} » (rôles : ${ROLES.join(', ')})` };
    if (seen.has(rel.toLowerCase())) return { ok: false, why: `inventaire.json : « ${rel} » listé deux fois` };
    seen.add(rel.toLowerCase());
    files.push({ chemin: rel, role, ...(f?.note ? { note: String(f.note).slice(0, 300) } : {}) });
  }
  return { ok: true, value: { nom, dossier, fichiers: files } };
}

/**
 * suppression.json — the explicit list. Every inventoried file is in exactly
 * one of supprimer / garder / doutes; only drafts and duplicates are deleted.
 */
export function checkSorting(cwd, inv, art, { exists = true } = {}) {
  const j = parseJson(art);
  if (!j || typeof j !== 'object') return { ok: false, why: 'suppression.json n’est pas un JSON valide' };
  for (const k of ['supprimer', 'garder', 'doutes']) if (!Array.isArray(j[k])) return { ok: false, why: `suppression.json : champ « ${k} » (liste) absent` };
  const roleOf = new Map(inv.fichiers.map(f => [f.chemin.toLowerCase(), f.role]));
  const where = new Map();
  const out = { supprimer: [], garder: [], doutes: [] };
  for (const k of ['supprimer', 'garder', 'doutes']) {
    for (const x of j[k]) {
      const rel = safeRel(cwd, pathOf(x));
      if (!rel) return { ok: false, why: `suppression.json (${k}) : chemin invalide « ${pathOf(x) ?? ''} »` };
      const key = rel.toLowerCase();
      if (!roleOf.has(key)) return { ok: false, why: `suppression.json (${k}) : « ${rel} » n’est pas dans l’inventaire — n’agis que sur les fichiers inventoriés` };
      if (where.has(key)) return { ok: false, why: `suppression.json : « ${rel} » est à la fois dans « ${where.get(key)} » et dans « ${k} »` };
      where.set(key, k);
      if (k === 'supprimer') {
        const role = roleOf.get(key);
        if (!DELETABLE_ROLES.includes(role)) return { ok: false, why: `suppression.json : « ${rel} » (rôle « ${role} ») ne peut pas être supprimé — seuls les brouillons et les doublons le peuvent` };
        if (exists && !isFile(cwd, rel)) return { ok: false, why: `suppression.json : « ${rel} » à supprimer n’existe pas` };
        const raison = String(x?.raison || '').trim();
        if (raison.length < 3) return { ok: false, why: `suppression.json : « ${rel} » à supprimer sans « raison »` };
        out.supprimer.push({ chemin: rel, raison: raison.slice(0, 300) });
      } else if (k === 'doutes') {
        const question = String(x?.question || '').trim();
        if (question.length < 5) return { ok: false, why: `suppression.json : doute sur « ${rel} » sans « question » à poser à l’utilisateur` };
        out.doutes.push({ chemin: rel, question: question.slice(0, 400) });
      } else out.garder.push(rel);
    }
  }
  const missing = inv.fichiers.filter(f => !where.has(f.chemin.toLowerCase())).map(f => f.chemin);
  if (missing.length) return { ok: false, why: `suppression.json : fichier(s) inventorié(s) sans décision (à mettre dans « supprimer », « garder » ou « doutes ») : ${missing.slice(0, 8).join(', ')}` };
  return { ok: true, value: out };
}

/**
 * definitif.json — the definitive version, written EXACTLY as the user gave it
 * in the request. Only that file may change at this step.
 * → { ok, value: {fichier}|{none:true} } | { ok:false, why }
 */
export function checkDefinitive(cwd, { art, demande, sorting, changed = [] }) {
  if (new RegExp(`\\b${NO_DEFINITIVE}\\b`).test(String(art || ''))) {
    if (changed.length) return { ok: false, why: `« ${NO_DEFINITIVE} » annoncé, mais des fichiers ont changé : ${changed.slice(0, 8).join(', ')}` };
    return { ok: true, value: { none: true } };
  }
  const j = parseJson(art);
  if (!j || typeof j !== 'object') return { ok: false, why: `definitif.json n’est pas un JSON valide (ou écris « ${NO_DEFINITIVE} » si la demande ne fournit aucun texte définitif)` };
  const rel = safeRel(cwd, j.fichier);
  if (!rel) return { ok: false, why: `definitif.json : « fichier » invalide (« ${j.fichier ?? ''} »)` };
  if (!isFile(cwd, rel)) return { ok: false, why: `definitif.json : « ${rel} » n’existe pas` };
  if ((sorting?.supprimer || []).some(s => sameRel(cwd, s.chemin, rel))) return { ok: false, why: `definitif.json : « ${rel} » est dans la liste des fichiers à supprimer` };
  const text = fs.readFileSync(path.join(cwd, rel), 'utf8');
  if (normText(text).length < 40) return { ok: false, why: `« ${rel} » : texte définitif trop court (${normText(text).length} caractères)` };
  if (!isVerbatim(text, demande)) {
    return { ok: false, why: `« ${rel} » ne reprend pas EXACTEMENT le texte fourni par l’utilisateur dans la demande (rien à ajouter, retirer ni reformuler : ni titre, ni mise en forme, ni correction)` };
  }
  const other = changed.filter(f => !sameRel(cwd, f, rel));
  if (other.length) return { ok: false, why: `seul le fichier du texte définitif peut changer à cette étape ; modifiés aussi : ${other.slice(0, 8).join(', ')}` };
  return { ok: true, value: { fichier: rel } };
}

/** Files to delete now: the sure list, plus the doubts when the user said « tout supprimer ». */
export function deletionPlan(cwd, sorting, { definitive = null, withDoubts = false } = {}) {
  const list = [...sorting.supprimer.map(s => ({ ...s, doute: false })), ...(withDoubts ? sorting.doutes.map(d => ({ chemin: d.chemin, raison: `doute levé par l’utilisateur (« tout supprimer ») : ${d.question}`, doute: true })) : [])];
  const refused = [];
  const plan = [];
  for (const x of list) {
    const rel = safeRel(cwd, x.chemin);
    if (!rel) { refused.push({ chemin: x.chemin, why: 'chemin invalide' }); continue; }
    if (definitive && sameRel(cwd, rel, definitive)) { refused.push({ chemin: rel, why: 'c’est le texte définitif' }); continue; }
    plan.push({ ...x, chemin: rel });
  }
  return { plan, refused };
}

/** Deletes the planned files, each moved to `trashDir` first (never lost). */
export function deleteFiles(cwd, plan, trashDir) {
  const done = [], missing = [];
  for (const x of plan) {
    const abs = path.join(cwd, x.chemin);
    if (!isFile(cwd, x.chemin)) { missing.push(x.chemin); continue; }
    const dest = path.join(trashDir, x.chemin);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    fs.rmSync(abs, { force: true });
    done.push({ chemin: x.chemin, raison: x.raison, corbeille: dest, ...(x.doute ? { doute: true } : {}) });
  }
  return { done, missing };
}

/**
 * rangement.json — one folder, one index named after the meeting. Every kept
 * element (and the definitive text) is inside the folder and cited by the
 * index; nothing deleted is listed; only meeting files changed.
 */
export function checkFiling(cwd, { art, inv, sorting, definitive = null, demande = '', deleted = [], changed = [] }) {
  const j = parseJson(art);
  if (!j || typeof j !== 'object') return { ok: false, why: 'rangement.json n’est pas un JSON valide' };
  const dossier = inv.dossier;
  const inFolder = (rel) => rel.toLowerCase() === dossier.toLowerCase() || rel.toLowerCase().startsWith(`${dossier.toLowerCase()}/`);
  const index = safeRel(cwd, j.index);
  if (!index || !inFolder(index)) return { ok: false, why: `rangement.json : « index » doit être un fichier du dossier « ${dossier} » (reçu « ${j.index ?? ''} »)` };
  if (!isFile(cwd, index)) return { ok: false, why: `index « ${index} » absent` };
  const indexText = fs.readFileSync(path.join(cwd, index), 'utf8');
  if (!foldText(indexText).includes(foldText(inv.nom))) return { ok: false, why: `l’index « ${index} » ne contient pas le nom de la réunion « ${inv.nom} » (c’est par ce nom qu’on doit la retrouver)` };
  if (!Array.isArray(j.elements) || !j.elements.length) return { ok: false, why: 'rangement.json : « elements » vide' };
  const deletedSet = new Set(deleted.map(d => String(d).toLowerCase()));
  const els = [];
  for (const e of j.elements) {
    const rel = safeRel(cwd, pathOf(e));
    const role = String(e?.role || '').trim().toLowerCase();
    if (!rel) return { ok: false, why: `rangement.json : chemin invalide « ${pathOf(e) ?? ''} »` };
    if (!ROLES.includes(role) || DELETABLE_ROLES.includes(role)) return { ok: false, why: `rangement.json : rôle « ${e?.role ?? ''} » invalide pour « ${rel} »` };
    if (!inFolder(rel)) return { ok: false, why: `« ${rel} » n’est pas dans le dossier de la réunion « ${dossier} »` };
    if (!isFile(cwd, rel)) return { ok: false, why: `élément « ${rel} » absent` };
    if (deletedSet.has(rel.toLowerCase())) return { ok: false, why: `« ${rel} » a été supprimé : il ne peut pas être un élément gardé` };
    const base = path.posix.basename(rel);
    const relToIndex = path.posix.relative(path.posix.dirname(index), rel);
    if (rel !== index && !indexText.includes(base) && !indexText.includes(relToIndex)) return { ok: false, why: `l’index « ${index} » ne cite pas « ${rel} »` };
    els.push({ chemin: rel, role });
  }
  // Every kept element of a filed role must be there (the drafts are gone, the rest is filed).
  const keptRoles = new Set(inv.fichiers.filter(f => FILED_ROLES.includes(f.role) && !sorting.supprimer.some(s => s.chemin.toLowerCase() === f.chemin.toLowerCase()) && !deletedSet.has(f.chemin.toLowerCase())).map(f => f.role));
  if (definitive?.fichier) keptRoles.add('mail-definitif');
  const missingRoles = [...keptRoles].filter(r => !els.some(e => e.role === r));
  if (missingRoles.length) return { ok: false, why: `élément(s) attendu(s) absent(s) du rangement : ${missingRoles.join(', ')}` };
  // The definitive text must still be exact, wherever it was filed.
  if (definitive?.fichier) {
    const mails = els.filter(e => e.role === 'mail-definitif');
    if (!mails.some(m => isVerbatim(fs.readFileSync(path.join(cwd, m.chemin), 'utf8'), demande))) return { ok: false, why: 'le texte définitif rangé n’est plus identique à celui fourni par l’utilisateur' };
  }
  const allowed = (f) => {
    const rel = safeRel(cwd, f);
    if (!rel) return false;
    if (inFolder(rel)) return true;
    const k = rel.toLowerCase();
    if (inv.fichiers.some(x => x.chemin.toLowerCase() === k) || deletedSet.has(k)) return true;
    if (definitive?.fichier && definitive.fichier.toLowerCase() === k) return true;
    const glob = safeRel(cwd, j.index_global);
    return !!glob && glob.toLowerCase() === k;
  };
  const bad = changed.filter(f => !allowed(f));
  if (bad.length) return { ok: false, why: `seuls les fichiers de la réunion, son dossier et l’index global peuvent changer à cette étape ; modifiés aussi : ${bad.slice(0, 8).join(', ')}` };
  return { ok: true, value: { index, elements: els, ...(safeRel(cwd, j.index_global) ? { indexGlobal: safeRel(cwd, j.index_global) } : {}) } };
}

/**
 * Final check, by code only: every expected element exists, the index names
 * the meeting, every deleted file is gone. → { ok, lines, problems }
 */
export function verifyMeeting(cwd, { inv, filing, deleted = [], definitive = null, demande = '' }) {
  const problems = [], lines = [];
  for (const e of filing.elements) {
    if (isFile(cwd, e.chemin)) lines.push(`- ✓ ${e.role} : \`${e.chemin}\``);
    else problems.push(`élément absent : ${e.chemin} (${e.role})`);
  }
  const indexOk = isFile(cwd, filing.index) && foldText(fs.readFileSync(path.join(cwd, filing.index), 'utf8')).includes(foldText(inv.nom));
  if (!indexOk) problems.push(`index « ${filing.index} » absent ou sans le nom « ${inv.nom} »`);
  for (const d of deleted) {
    if (fs.existsSync(path.join(cwd, d))) problems.push(`fichier supprimé encore présent : ${d}`);
  }
  if (definitive?.fichier) {
    const mails = filing.elements.filter(e => e.role === 'mail-definitif' && isFile(cwd, e.chemin));
    if (!mails.some(m => isVerbatim(fs.readFileSync(path.join(cwd, m.chemin), 'utf8'), demande))) problems.push('texte définitif modifié ou absent');
  }
  return { ok: problems.length === 0, problems, lines, indexOk };
}
