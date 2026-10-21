// ============================================================================
// scripts/files-check.mjs — the « Fichiers » generic pipeline: plan, execution
// and verification by the code (pipelines phase 1, PIPELINES-SYNTHESE §3.3)
// ============================================================================
//
// User decisions (2026-10-20, « tout comme recommandé », decision 4): a
// generic pipeline to acquire, copy, move, rename, compare or delete files —
// a meeting filing or a video download no longer goes to Maintenance. The
// model only writes the plan (fichiers.json) and, when a download is needed,
// fetches the file; copying, moving, renaming, deleting (to a trash copy) and
// comparing are done HERE, by the code, from the explicit plan only, and every
// effect is re-read afterwards. It generalises scripts/meeting-check.mjs.
//
// fichiers.json:
//   { "operations": [
//       {"op": "acquerir", "url": "https://…", "destination": "rel/path.mp4"},
//       {"op": "copier"|"deplacer"|"renommer", "source": "…", "destination": "rel"},
//       {"op": "supprimer", "source": "rel", "raison": "…"},
//       {"op": "comparer", "a": "dir or file", "b": "dir or file"} ],
//     "doutes": [{"chemin": "rel", "question": "…"}] }
// Sources may be outside the project only when the request cites them
// (`demande.md`); destinations, deletions and doubts stay inside the project.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkMediaFiles } from './media-check.mjs';

export const MAX_FILE_OPS = 50;
export const FILE_OPS = ['acquerir', 'copier', 'deplacer', 'renommer', 'supprimer', 'comparer'];
const FORBIDDEN_TOP = new Set(['.git', '.orchestrateur', 'node_modules']);
const HASH_MAX_BYTES = 64 * 1024 * 1024;
const MEDIA_EXT = {
  video: /\.(mp4|mkv|webm|mov|avi|m4v)$/i, audio: /\.(mp3|wav|m4a|ogg|flac|opus|aac)$/i, image: /\.(png|jpe?g|gif|webp)$/i,
};
const KIND_FR = { video: 'vidéo', audio: 'audio', image: 'image' };
export function mediaKindOf(f) { for (const [k, re] of Object.entries(MEDIA_EXT)) if (re.test(f)) return k; return null; }

export function parseJson(art) {
  try { return JSON.parse(String(art || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
}
const slash = (p) => String(p).replace(/\\/g, '/');
const fold = (s) => slash(s).toLowerCase().replace(/\/+$/, '');

/** Path inside the project (relative, normalised) or null. Absolute paths under cwd are accepted. */
export function projectRel(cwd, p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const raw = p.trim();
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const rel = slash(path.relative(root, abs));
  if (!rel || rel.startsWith('..') || FORBIDDEN_TOP.has(rel.split('/')[0])) return null;
  return rel;
}

/** A path the user cited in the request (case- and separator-insensitive), for sources outside the project. */
export function citedByUser(demande, p) {
  const d = fold(demande);
  const n = fold(p);
  return n.length >= 3 && d.includes(n);
}

/** Resolves a source: { abs, rel|null, outside } or { why }. */
function resolveSource(cwd, p, demande) {
  if (typeof p !== 'string' || !p.trim()) return { why: 'source absente' };
  const rel = projectRel(cwd, p);
  if (rel) return { abs: path.join(cwd, rel), rel, outside: false };
  if (!path.isAbsolute(p)) return { why: `source hors du projet : ${p}` };
  if (!citedByUser(demande, p)) return { why: `source hors du projet non citée par l’utilisateur : ${p} (seul un chemin écrit dans la demande peut être lu hors du projet)` };
  return { abs: path.resolve(p), rel: null, outside: true };
}

/**
 * fichiers.json → { ok, value: {ops, doutes} } | { ok:false, why }. Nothing is
 * touched. `exists: false` skips the existence checks (re-reading the plan
 * after its execution).
 */
export function checkFilesPlan(cwd, art, { demande = '', exists = true, max = MAX_FILE_OPS } = {}) {
  const j = typeof art === 'string' ? parseJson(art) : art;
  if (!j || typeof j !== 'object') return { ok: false, why: 'fichiers.json n’est pas un JSON valide' };
  const list = Array.isArray(j.operations) ? j.operations : null;
  if (!list) return { ok: false, why: 'fichiers.json : champ « operations » (liste) absent' };
  const doutesIn = Array.isArray(j.doutes) ? j.doutes : [];
  if (!list.length && !doutesIn.length) return { ok: false, why: 'fichiers.json : aucune opération' };
  if (list.length + doutesIn.length > max) return { ok: false, why: `${list.length + doutesIn.length} opérations : au plus ${max} (découper la demande)` };
  const ops = [];
  const dests = new Set();
  for (const [i, o] of list.entries()) {
    const n = `opération ${i + 1}`;
    if (!o || !FILE_OPS.includes(o.op)) return { ok: false, why: `${n} : « ${o?.op ?? o} » n’est pas une opération de fichiers (liste : ${FILE_OPS.join(', ')})` };
    if (o.op === 'comparer') {
      const a = resolveSource(cwd, o.a, demande), b = resolveSource(cwd, o.b, demande);
      if (a.why || b.why) return { ok: false, why: `${n} (comparer) : ${a.why || b.why}` };
      if (exists && (!fs.existsSync(a.abs) || !fs.existsSync(b.abs))) return { ok: false, why: `${n} (comparer) : ${!fs.existsSync(a.abs) ? o.a : o.b} introuvable` };
      ops.push({ op: 'comparer', a: a.abs, b: b.abs, label: `${o.a} ↔ ${o.b}` });
      continue;
    }
    if (o.op === 'supprimer') {
      const rel = projectRel(cwd, o.source);
      if (!rel) return { ok: false, why: `${n} (supprimer) : seul un fichier du projet peut être supprimé (${o.source})` };
      if (!(typeof o.raison === 'string' && o.raison.trim().length >= 3)) return { ok: false, why: `${n} (supprimer ${rel}) : « raison » obligatoire` };
      if (exists) {
        if (!fs.existsSync(path.join(cwd, rel))) return { ok: false, why: `${n} (supprimer) : ${rel} introuvable` };
        if (!fs.statSync(path.join(cwd, rel)).isFile()) return { ok: false, why: `${n} (supprimer) : ${rel} est un dossier (un fichier à la fois)` };
      }
      ops.push({ op: 'supprimer', source: rel, raison: o.raison.trim().slice(0, 300) });
      continue;
    }
    const dest = projectRel(cwd, o.destination);
    if (!dest) return { ok: false, why: `${n} (${o.op}) : la destination doit être dans le projet (${o.destination ?? 'absente'})` };
    if (dests.has(dest)) return { ok: false, why: `${n} (${o.op}) : destination ${dest} utilisée deux fois` };
    dests.add(dest);
    if (o.op === 'acquerir') {
      if (typeof o.url !== 'string' || !/^https?:\/\/\S+$/i.test(o.url)) return { ok: false, why: `${n} (acquerir) : « url » http(s) obligatoire` };
      ops.push({ op: 'acquerir', url: o.url, destination: dest });
      continue;
    }
    const src = resolveSource(cwd, o.source, demande);
    if (src.why) return { ok: false, why: `${n} (${o.op}) : ${src.why}` };
    if ((o.op === 'deplacer' || o.op === 'renommer') && src.outside) return { ok: false, why: `${n} (${o.op}) : déplacer hors du projet n’est pas permis, seulement copier (${o.source})` };
    if (o.op === 'renommer' && path.posix.dirname(src.rel) !== path.posix.dirname(dest)) return { ok: false, why: `${n} (renommer) : même dossier attendu (sinon « deplacer »)` };
    if (exists) {
      if (!fs.existsSync(src.abs)) return { ok: false, why: `${n} (${o.op}) : source introuvable ${o.source}` };
      if (!fs.statSync(src.abs).isFile()) return { ok: false, why: `${n} (${o.op}) : ${o.source} est un dossier (un fichier à la fois)` };
      if (fs.existsSync(path.join(cwd, dest))) return { ok: false, why: `${n} (${o.op}) : la destination ${dest} existe déjà (jamais écrasée)` };
    }
    ops.push({ op: o.op, source: src.rel || src.abs, sourceAbs: src.abs, outside: src.outside, destination: dest });
  }
  const doutes = [];
  for (const [i, d] of doutesIn.entries()) {
    const rel = projectRel(cwd, d?.chemin);
    if (!rel) return { ok: false, why: `doute ${i + 1} : « chemin » du projet attendu (${d?.chemin ?? 'absent'})` };
    if (!(typeof d.question === 'string' && d.question.trim().length >= 5)) return { ok: false, why: `doute ${i + 1} (${rel}) : « question » à poser obligatoire` };
    if (ops.some(o => o.op === 'supprimer' && o.source === rel)) return { ok: false, why: `doute ${i + 1} : ${rel} est aussi dans les suppressions sûres` };
    doutes.push({ chemin: rel, question: d.question.trim().slice(0, 400) });
  }
  return { ok: true, value: { ops, doutes } };
}

const sha = (f) => {
  try {
    const st = fs.statSync(f);
    if (st.size > HASH_MAX_BYTES) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  } catch { return null; }
};
function listTree(root) {
  const out = new Map();
  let n = 0;
  const walk = (dir, rel) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (n > 20_000) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== '.git') walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile()) continue;
      n++;
      let st; try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
      out.set(r, { size: st.size, abs: path.join(dir, e.name) });
    }
  };
  if (fs.statSync(root).isFile()) out.set(path.basename(root), { size: fs.statSync(root).size, abs: root });
  else walk(root, '');
  return out;
}

/**
 * Compares two folders (or files): same relative names, sizes, and content
 * (SHA-256 up to 64 MiB; beyond, by size only — said). Read only.
 */
export function compareTrees(a, b) {
  const A = listTree(a), B = listTree(b);
  const onlyA = [], onlyB = [], different = [], same = [], sizeOnly = [];
  for (const [r, x] of A) {
    const y = B.get(r);
    if (!y) { onlyA.push(r); continue; }
    if (x.size !== y.size) { different.push({ path: r, why: `taille ${x.size} ≠ ${y.size}` }); continue; }
    const hx = sha(x.abs), hy = hx ? sha(y.abs) : null;
    if (hx && hy) { if (hx === hy) same.push(r); else different.push({ path: r, why: 'contenu différent (SHA-256)' }); }
    else { same.push(r); sizeOnly.push(r); }
  }
  for (const r of B.keys()) if (!A.has(r)) onlyB.push(r);
  return { countA: A.size, countB: B.size, onlyA, onlyB, different, same: same.length, sizeOnly };
}

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to); fs.rmSync(from);
  }
}

/**
 * Executes the plan (acquisitions excluded: the model's step). Idempotent: an
 * operation whose effect is already there is « déjà fait ». Deletions go to
 * `trashDir` first. → { results: [{op, …, status: done|already|failed, why?}], comparisons }
 */
export function executeFilesPlan(cwd, plan, { trashDir, withDoubts = false } = {}) {
  const results = [];
  const comparisons = [];
  const del = [...plan.ops.filter(o => o.op === 'supprimer'), ...(withDoubts ? plan.doutes.map(d => ({ op: 'supprimer', source: d.chemin, raison: `doute levé par l’utilisateur : ${d.question}`, doute: true })) : [])];
  for (const o of plan.ops) {
    if (o.op === 'acquerir' || o.op === 'supprimer') continue;
    if (o.op === 'comparer') {
      try { const c = compareTrees(o.a, o.b); comparisons.push({ label: o.label, a: o.a, b: o.b, ...c }); results.push({ ...o, status: 'done' }); }
      catch (e) { results.push({ ...o, status: 'failed', why: e.message }); }
      continue;
    }
    const to = path.join(cwd, o.destination);
    try {
      if (fs.existsSync(to)) {
        // A resumed run: the effect may already be there; a destination is never overwritten.
        const srcThere = fs.existsSync(o.sourceAbs);
        const already = o.op === 'copier' ? srcThere && fs.statSync(to).size === fs.statSync(o.sourceAbs).size : !srcThere;
        results.push(already ? { ...o, status: 'already' } : { ...o, status: 'failed', why: `la destination ${o.destination} existe déjà (jamais écrasée)` });
        continue;
      }
      if (o.op === 'copier') { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(o.sourceAbs, to, fs.constants.COPYFILE_EXCL); }
      else moveFile(o.sourceAbs, to);
      results.push({ ...o, status: 'done' });
    } catch (e) { results.push({ ...o, status: 'failed', why: e.message }); }
  }
  for (const o of del) {
    const abs = path.join(cwd, o.source);
    if (!fs.existsSync(abs)) { results.push({ ...o, status: 'already' }); continue; }
    try {
      const keep = path.join(trashDir, o.source);
      fs.mkdirSync(path.dirname(keep), { recursive: true });
      fs.copyFileSync(abs, keep);
      fs.rmSync(abs);
      results.push({ ...o, status: 'done', trash: keep });
    } catch (e) { results.push({ ...o, status: 'failed', why: e.message }); }
  }
  return { results, comparisons };
}

/** Every acquisition destination exists, is not empty and, for a media file, is valid. */
export function checkAcquisition(cwd, plan, { changed = [], env = process.env } = {}) {
  const acq = plan.ops.filter(o => o.op === 'acquerir');
  const lines = [];
  for (const o of acq) {
    const abs = path.join(cwd, o.destination);
    if (!fs.existsSync(abs) || !fs.statSync(abs).size) return { ok: false, why: `acquisition : ${o.destination} absent ou vide après l’étape` };
    const kind = mediaKindOf(o.destination);
    if (kind) { const m = checkMediaFiles([o.destination], { kind, roots: [cwd], env }); if (!m.ok) return { ok: false, why: `acquisition : ${m.why}` }; }
    lines.push(`${o.destination} (${(fs.statSync(abs).size / 1048576).toFixed(1)} Mo${kind ? `, ${KIND_FR[kind]} valide` : ''})`);
  }
  const allowed = new Set(acq.map(o => o.destination));
  const extra = changed.filter(f => !allowed.has(slash(f)));
  if (extra.length) return { ok: false, why: `acquisition : seuls les fichiers prévus peuvent changer ; aussi modifiés : ${extra.slice(0, 8).join(', ')}` };
  return { ok: true, lines };
}

/**
 * The postconditions of an executed plan, re-read on disk: each destination
 * exists, is not empty and (media) valid; a moved source is gone; a deleted
 * file is gone and kept in the trash. → { ok, problems, lines }
 */
export function verifyFilesPlan(cwd, plan, results, { env = process.env } = {}) {
  const problems = [], lines = [];
  for (const o of plan.ops) {
    if (o.op === 'comparer') { lines.push(`- comparer ${o.label} : fait (lecture seule)`); continue; }
    if (o.op === 'supprimer') continue;
    const abs = path.join(cwd, o.destination);
    if (!fs.existsSync(abs) || !fs.statSync(abs).size) { problems.push(`${o.destination} absent ou vide`); lines.push(`- ✕ ${o.op} → \`${o.destination}\` : absent ou vide`); continue; }
    const kind = mediaKindOf(o.destination);
    if (kind) { const m = checkMediaFiles([o.destination], { kind, roots: [cwd], env }); if (!m.ok) { problems.push(m.why); lines.push(`- ✕ \`${o.destination}\` : ${m.why}`); continue; } }
    if ((o.op === 'deplacer' || o.op === 'renommer') && fs.existsSync(o.sourceAbs)) { problems.push(`${o.source} existe encore après « ${o.op} »`); lines.push(`- ✕ ${o.op} : \`${o.source}\` existe encore`); continue; }
    lines.push(`- ✓ ${o.op}${o.op === 'acquerir' ? ` ${o.url}` : ` \`${o.source}\``} → \`${o.destination}\` (${(fs.statSync(abs).size / 1048576).toFixed(2)} Mo${kind ? `, ${KIND_FR[kind]} valide` : ''})`);
  }
  for (const r of results.filter(x => x.op === 'supprimer')) {
    const gone = !fs.existsSync(path.join(cwd, r.source));
    if (!gone) { problems.push(`${r.source} existe encore après sa suppression`); lines.push(`- ✕ supprimer \`${r.source}\` : existe encore`); continue; }
    if (r.status === 'done' && !(r.trash && fs.existsSync(r.trash))) { problems.push(`${r.source} : copie de corbeille absente`); continue; }
    lines.push(`- ✓ supprimer \`${r.source}\`${r.doute ? ' (doute levé par l’utilisateur)' : ''} — ${r.raison}${r.trash ? ' (copie dans la corbeille)' : ''}`);
  }
  for (const r of results.filter(x => x.status === 'failed')) problems.push(`${r.op} ${r.source || r.label || ''} : ${r.why}`);
  return { ok: !problems.length, problems, lines };
}

/** Markdown of the comparisons (verification.md). */
export function comparisonsMarkdown(comparisons) {
  const L = [];
  for (const c of comparisons) {
    L.push(`### ${c.label}`, '', '| | fichiers |', '|---|---|', `| seulement dans A (\`${c.a}\`) | ${c.onlyA.length} |`, `| seulement dans B (\`${c.b}\`) | ${c.onlyB.length} |`, `| présents des deux côtés, différents | ${c.different.length} |`, `| identiques | ${c.same} |`, '');
    const item = (x) => (typeof x === 'string' ? `- \`${x}\`` : `- \`${x.path}\` — ${x.why}`);
    const list = (title, xs) => { if (xs.length) L.push(`**${title}** :`, ...xs.slice(0, 200).map(item), ...(xs.length > 200 ? [`- … et ${xs.length - 200} autre(s)`] : []), ''); };
    list('Seulement dans A', c.onlyA);
    list('Seulement dans B', c.onlyB);
    list('Différents', c.different);
    if (c.sizeOnly.length) L.push(`_${c.sizeOnly.length} fichier(s) de plus de 64 Mio comparé(s) par la taille seulement._`, '');
  }
  return L.join('\n');
}

/** Files that look binary (NUL byte in the first 8 KiB, or a media extension): never committed by the delivery. */
export function isBinaryFile(abs) {
  if (mediaKindOf(abs) || /\.(zip|7z|rar|exe|dll|apk|iso|bin|pdf|docx?|xlsx?|pptx?|odt)$/i.test(abs)) return true;
  try {
    const fd = fs.openSync(abs, 'r');
    const b = Buffer.alloc(8192);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    fs.closeSync(fd);
    return b.subarray(0, n).includes(0);
  } catch { return false; }
}
