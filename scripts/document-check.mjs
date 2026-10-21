// ============================================================================
// scripts/document-check.mjs — Rédaction, mode « document »: a one-off piece
// of work on an EXISTING document, checked by the code (pipelines phase 1,
// docs/PIPELINES-SYNTHESE.md §3.3)
// ============================================================================
//
// User request (2026-10-20): « Il faut aussi prevoir des cas generique, comme
// un travail ponctuel sur un document »; decision 4: a mode of Rédaction.
//
//   cible.json  { "fichiers": ["rel/doc.md"], "operation": "relire-corriger"|
//                 "resumer"|"traduire"|"reformater"|"completer"|"convertir",
//                 "sortie": "remplacer"|"nouveau", "langue": "en" (traduire) }
//
// What the code checks after the model's turn (checkDocumentChange):
//   - only the targeted files change (remplacer), or the source is untouched
//     and exactly one new file per source appears (nouveau: a summary or a
//     translation never overwrites its source);
//   - a non-empty change, unless the artefact says DOCUMENT_DEJA_CONFORME;
//   - the format is preserved: extension, encoding (UTF-8, BOM), line endings,
//     front-matter, JSON parsable, YAML/TOML structure (light check), `#`
//     headings not lost (except a summary or a conversion);
//   - length ±25 % to correct or reformat, < 50 % for a summary, nothing
//     deleted to complete, the target language for a translation.
// Office formats (DOCX, ODT, PPTX, PDF…) are refused explicitly — never a fake
// success. A protected document (tests, requirement register) goes to Dev.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { detectLanguage } from './language.mjs';

export const DOC_OPERATIONS = ['relire-corriger', 'resumer', 'traduire', 'reformater', 'completer', 'convertir'];
export const NEW_FILE_OPS = new Set(['resumer', 'traduire', 'convertir']);
export const DOC_ALREADY = 'DOCUMENT_DEJA_CONFORME';
export const MAX_DOC_TARGETS = 5;
export const LANGS = Object.keys(detectLanguage('').scores);
const UNSUPPORTED_RE = /\.(docx?|odt|ods|odp|pptx?|xlsx?|pdf|rtf|pages|key|numbers)$/i;
const TEXT_EXT_RE = /\.(md|markdown|txt|rst|adoc|html?|json|ya?ml|toml|csv|tsv|xml|ini|cfg|conf|properties|tex|org|srt|vtt)$/i;
const PROTECTED_RE = /(^|\/)docs\/USER_REQUIREMENTS\.md$/i;

const slash = (p) => String(p).replace(/\\/g, '/');
export function parseJson(art) {
  try { return JSON.parse(String(art || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
}

function projectRel(cwd, p) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const rel = slash(path.relative(root, abs));
  return rel && !rel.startsWith('..') && !rel.startsWith('.git/') && !rel.startsWith('.orchestrateur/') ? rel : null;
}
const citedIn = (demande, p) => String(demande || '').replace(/\\/g, '/').toLowerCase().includes(slash(p).toLowerCase());

/**
 * Existing files the request names (between backquotes, or a token with a
 * file extension): path extraction verified on the disk — never a routing by
 * keywords. Absolute paths outside the project are kept with `outside: true`.
 */
export function candidateTargets(cwd, demande) {
  const text = String(demande || '');
  const tokens = new Set();
  for (const m of text.matchAll(/`([^`\n]{2,260})`/g)) tokens.add(m[1].trim());
  for (const m of text.matchAll(/(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[\w.@-]+(?:[\\/][\w .@-]+)*\.[A-Za-z0-9]{1,8}\b/g)) tokens.add(m[0].trim());
  const out = [];
  const seen = new Set();
  for (const t0 of tokens) {
    const t = t0.replace(/[.,;:)»"']+$/, '').replace(/:\d+(-\d+)?$/, '');
    if (!t || /^https?:/i.test(t)) continue;
    const abs = path.isAbsolute(t) ? path.resolve(t) : path.resolve(cwd, t);
    let st = null; try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = projectRel(cwd, abs);
    out.push(rel ? { path: rel, abs, outside: false } : { path: abs, abs, outside: true });
  }
  return out;
}

/**
 * cible.json → { ok, value: {targets: [{path, abs, outside}], operation, sortie, langue} } | { ok:false, why }.
 * protectedFn(rel) → true for a test file of the project (Dev's job).
 */
export function checkTarget(cwd, art, { demande = '', protectedFn = () => false } = {}) {
  const j = typeof art === 'string' ? parseJson(art) : art;
  if (!j || typeof j !== 'object') return { ok: false, why: 'cible.json n’est pas un JSON valide' };
  const files = Array.isArray(j.fichiers) ? j.fichiers.filter(f => typeof f === 'string' && f.trim()) : [];
  if (!files.length) return { ok: false, why: 'cible.json : « fichiers » (liste de 1 à 5 documents existants) absent' };
  if (files.length > MAX_DOC_TARGETS) return { ok: false, why: `cible.json : ${files.length} documents, au plus ${MAX_DOC_TARGETS} (découper la demande)` };
  if (!DOC_OPERATIONS.includes(j.operation)) return { ok: false, why: `cible.json : « operation » doit valoir ${DOC_OPERATIONS.map(o => `« ${o} »`).join(', ')} (reçu « ${j.operation} »)` };
  const sortie = NEW_FILE_OPS.has(j.operation) ? 'nouveau' : (j.sortie === 'nouveau' ? 'nouveau' : 'remplacer');
  if (NEW_FILE_OPS.has(j.operation) && j.sortie === 'remplacer') return { ok: false, why: `cible.json : « ${j.operation} » écrit un NOUVEAU fichier, jamais par-dessus sa source (sortie « nouveau »)` };
  const langue = j.operation === 'traduire' ? String(j.langue || '').toLowerCase().trim() : null;
  if (j.operation === 'traduire' && !LANGS.includes(langue)) return { ok: false, why: `cible.json : « langue » cible obligatoire pour traduire, parmi ${LANGS.join(', ')} (reçu « ${j.langue ?? ''} »)` };
  const targets = [];
  for (const f of files) {
    const abs = path.isAbsolute(f) ? path.resolve(f) : path.resolve(cwd, f);
    const rel = projectRel(cwd, abs);
    if (!rel && !(path.isAbsolute(f) && citedIn(demande, f))) return { ok: false, why: `${f} : hors du projet et non cité par l’utilisateur dans la demande` };
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, why: `${f} : document introuvable (ce mode travaille sur un document EXISTANT)` };
    if (UNSUPPORTED_RE.test(abs)) return { ok: false, why: `${f} : format non pris en charge (bureautique ou PDF) — rien n’est modifié, un faux succès serait pire` };
    if (rel && (PROTECTED_RE.test(rel) || protectedFn(rel))) return { ok: false, why: `${f} : document protégé (test ou registre des exigences) — ce travail passe par le pipeline Développement` };
    if (!rel && sortie === 'remplacer') return { ok: false, why: `${f} : un document hors du projet n’est jamais modifié en place (sortie « nouveau », écrite dans le projet)` };
    targets.push(rel ? { path: rel, abs, outside: false } : { path: abs, abs, outside: true });
  }
  return { ok: true, value: { targets, operation: j.operation, sortie, langue } };
}

// ---------------------------------------------------------------------------
// Format preservation
// ---------------------------------------------------------------------------
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const hasBom = (b) => b.length >= 3 && b.subarray(0, 3).equals(BOM);
function validUtf8(b) { try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; } }
export function eolStyle(s) {
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/(^|[^\r])\n/g) || []).length;
  return crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
}
const frontMatter = (s) => /^﻿?---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.test(s);
const headings = (s) => (s.match(/^#{1,6}\s+\S/gm) || []).length;
const textOf = (s) => s.replace(/^﻿/, '');

/** Light structural check of YAML: no tab indentation, balanced flow brackets per document. */
export function yamlProblem(s) {
  const lines = textOf(s).split(/\r?\n/);
  const bad = lines.findIndex(l => /^\t/.test(l) || /^ *\t/.test(l));
  if (bad >= 0) return `YAML : indentation par tabulation ligne ${bad + 1}`;
  const flat = lines.filter(l => !/^\s*#/.test(l)).join('\n').replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '');
  for (const [o, c] of [['[', ']'], ['{', '}']]) if (flat.split(o).length !== flat.split(c).length) return `YAML : « ${o} » et « ${c} » non équilibrés`;
  return null;
}
/** Light structural check of TOML: every line is a table, a key = value, a comment, or inside a multi-line value. */
export function tomlProblem(s) {
  const lines = textOf(s).split(/\r?\n/);
  let depth = 0, inStr = null;
  for (const [i, raw] of lines.entries()) {
    const l = raw.trim();
    if (inStr) { if (l.includes(inStr)) inStr = null; continue; }
    if (depth > 0) { depth += (l.match(/\[/g) || []).length - (l.match(/\]/g) || []).length; continue; }
    if (!l || l.startsWith('#')) continue;
    if (/^\[\[?[\w."' -]+\]\]?$/.test(l)) continue;
    const m = /^[\w."' -]+=\s*(.*)$/.exec(l);
    if (!m) return `TOML : ligne ${i + 1} illisible (« ${l.slice(0, 60)} »)`;
    const v = m[1];
    for (const q of ['"""', "'''"]) if (v.startsWith(q) && v.split(q).length === 2) inStr = q;
    if (!inStr) depth = (v.match(/\[/g) || []).length - (v.match(/\]/g) || []).length;
  }
  return depth || inStr ? 'TOML : valeur sur plusieurs lignes non refermée' : null;
}

/**
 * Format problems between the original and the result. → [reason] (empty = preserved)
 * op: the document operation; convert = the format itself changes.
 */
export function formatProblems(orig, next, { op, origExt, nextExt }) {
  const pb = [];
  const convert = op === 'convertir';
  if (!convert && origExt.toLowerCase() !== nextExt.toLowerCase()) pb.push(`extension changée (${origExt} → ${nextExt})`);
  if (validUtf8(orig) && !validUtf8(next)) pb.push('encodage : le résultat n’est plus de l’UTF-8 valide');
  if (!convert && hasBom(orig) !== hasBom(next)) pb.push(`encodage : marque BOM ${hasBom(orig) ? 'perdue' : 'ajoutée'}`);
  const o = orig.toString('utf8'), n = next.toString('utf8');
  const eo = eolStyle(o), en = eolStyle(n);
  if (!convert && ((eo === 'crlf' && en !== 'crlf' && en !== 'none') || (eo === 'lf' && en !== 'lf' && en !== 'none'))) pb.push(`fins de ligne changées (${eo.toUpperCase()} → ${en.toUpperCase()})`);
  if (!convert && frontMatter(o) && !frontMatter(n)) pb.push('front-matter (bloc --- en tête) perdu');
  const ext = (convert ? nextExt : origExt).toLowerCase();
  if (ext === '.json') { try { JSON.parse(textOf(n)); } catch (e) { pb.push(`JSON illisible : ${e.message.slice(0, 120)}`); } }
  if (ext === '.yml' || ext === '.yaml') { const y = yamlProblem(n); if (y) pb.push(y); }
  if (ext === '.toml') { const t = tomlProblem(n); if (t) pb.push(t); }
  if (!['resumer', 'convertir'].includes(op) && /\.(md|markdown)$/i.test(origExt) && headings(n) < headings(o)) pb.push(`titres perdus (${headings(o)} → ${headings(n)})`);
  return pb;
}

/** Length and content rules of the operation. → [reason] */
export function operationProblems(orig, next, { op, langue }) {
  const o = textOf(orig.toString('utf8')), n = textOf(next.toString('utf8'));
  const lo = o.trim().length || 1, ln = n.trim().length;
  const pb = [];
  if ((op === 'relire-corriger' || op === 'reformater') && Math.abs(ln - lo) / lo > 0.25) pb.push(`longueur ${ln} caractères contre ${lo} : plus de ±25 % pour « ${op} »`);
  if (op === 'resumer' && ln >= lo * 0.5) pb.push(`résumé de ${ln} caractères pour un original de ${lo} : il doit faire moins de la moitié`);
  if (op === 'completer') {
    const nl = new Set(n.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
    const lost = o.split(/\r?\n/).map(l => l.trim()).filter(l => l && !nl.has(l));
    if (lost.length) pb.push(`compléter ne retire rien : ${lost.length} ligne(s) d’origine disparue(s) (ex. « ${lost[0].slice(0, 80)} »)`);
    if (ln <= lo) pb.push('compléter : le document n’a pas grandi');
  }
  if (op === 'traduire') {
    const d = detectLanguage(n);
    if (d.lang !== 'unknown' && d.lang !== langue) pb.push(`traduction en « ${d.lang} » détectée, « ${langue} » demandée`);
  }
  if (!ln) pb.push('document vide');
  return pb;
}

/**
 * The model's change, judged by the code.
 *   target   checkTarget(...).value
 *   backups  Map(path → Buffer)  the targets as they were before the step
 *   changed  project-relative files changed during the step (snapshot diff)
 *   added    project-relative files that did not exist before the step
 *   art      the step's artefact (marker DOCUMENT_DEJA_CONFORME)
 * → { ok, why?, outputs: [{source, output}] }
 */
export function checkDocumentChange(cwd, target, { backups, changed = [], added = [], art = '' }) {
  const { operation: op, sortie, langue } = target;
  const already = new RegExp(`\\b${DOC_ALREADY}\\b`).test(art || '');
  const targetRels = new Set(target.targets.filter(t => !t.outside).map(t => t.path));
  const fail = (why) => ({ ok: false, why });
  for (const t of target.targets) {
    const now = fs.existsSync(t.abs) ? fs.readFileSync(t.abs) : null;
    if (!now) return fail(`${t.path} a disparu`);
    if (sortie === 'nouveau' && !now.equals(backups.get(t.path))) return fail(`${t.path} : la source a été modifiée, alors que « ${op} » écrit un nouveau fichier`);
  }
  if (already) {
    if (changed.length) return fail(`« ${DOC_ALREADY} » annoncé, mais des fichiers ont changé : ${changed.slice(0, 8).join(', ')}`);
    return { ok: true, outputs: [], already: true };
  }
  const outputs = [];
  if (sortie === 'remplacer') {
    const extra = changed.filter(f => !targetRels.has(f));
    if (extra.length) return fail(`seuls les documents ciblés peuvent changer ; aussi modifiés : ${extra.slice(0, 8).join(', ')}`);
    for (const t of target.targets) {
      const now = fs.readFileSync(t.abs);
      if (now.equals(backups.get(t.path))) return fail(`${t.path} : aucune modification — si le document est déjà conforme, écrire « ${DOC_ALREADY} » dans l’artefact`);
      outputs.push({ source: t.path, output: t.path });
    }
  } else {
    const fresh = added.filter(f => !targetRels.has(f));
    const extra = changed.filter(f => !targetRels.has(f) && !fresh.includes(f));
    if (extra.length) return fail(`seuls les nouveaux documents peuvent apparaître ; aussi modifiés : ${extra.slice(0, 8).join(', ')}`);
    if (fresh.length !== target.targets.length) return fail(`« ${op} » : ${target.targets.length} nouveau(x) fichier(s) attendu(s) (un par document source), ${fresh.length} créé(s)${fresh.length ? ` : ${fresh.join(', ')}` : ''}`);
    target.targets.forEach((t, i) => outputs.push({ source: t.path, output: fresh[i] }));
  }
  for (const { source, output } of outputs) {
    const orig = backups.get(source);
    const next = fs.readFileSync(path.join(cwd, output));
    const pb = [...formatProblems(orig, next, { op, origExt: path.extname(source), nextExt: path.extname(output) }), ...operationProblems(orig, next, { op, langue })];
    if (pb.length) return fail(`${output} : ${pb.join(' ; ')}`);
  }
  return { ok: true, outputs };
}

/** Changed lines between the backups and the current targets / outputs (Relire only above a threshold). */
export function changedLineCount(cwd, outputs, backups) {
  let n = 0;
  for (const { source, output } of outputs) {
    const a = String(backups.get(source) || '').split(/\r?\n/);
    let b = [];
    try { b = fs.readFileSync(path.join(cwd, output), 'utf8').split(/\r?\n/); } catch { continue; }
    const setA = new Map(); for (const l of a) setA.set(l, (setA.get(l) || 0) + 1);
    let common = 0;
    for (const l of b) { const k = setA.get(l) || 0; if (k) { common++; setA.set(l, k - 1); } }
    n += (a.length - common) + (b.length - common);
  }
  return n;
}

export const isTextDocument = (f) => TEXT_EXT_RE.test(f);
