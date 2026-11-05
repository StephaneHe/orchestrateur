// ============================================================================
// scripts/file-access.mjs — which files the dashboard may open (0.163.0)
// ============================================================================
//
// User request (2026-11-05): « Je voudrais que si c'est un identifiant, que ca
// remonte les informations, mais que de toutes facons ca me fasse un lien pour
// ouvrir le fichier (local ou web) ». The ONE source of truth for GET /api/file,
// GET /api/media and the `file` block of GET /api/identify.
//
// `pathVerdict` decides from the text of the path alone and touches no disk: a
// refused path never reveals whether it exists. `accessFile` then compares the
// real path with the asked one, so a symbolic link, a junction or an 8.3 short
// name (CREDEN~1.JSO) anywhere below a root is refused, not followed.
// Pure functions; nothing here mutates its input.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

const win = path.win32;

export const ALLOWED_ROOTS = Object.freeze([
  'I:\\Dev',
  'I:\\orchestrateur',
  'I:\\Enregistrements',
  'I:\\psyprofile-data\\seances\\anonymise',
  'I:\\psyprofile-data\\seances\\etude',
]);

const DENIED_TREES = Object.freeze([
  'I:\\psyprofile-data\\seances\\brut',
  'I:\\psyprofile-data\\responses',
]);

// Applied to every segment of the path, case-insensitively.
const DENIED_NAMES = Object.freeze([
  // The user's list.
  /^\.env/i, /^\.token$/i, /\.key$/i, /\.pem$/i, /^credentials/i, /^auth\.json$/i, /^\.git$/i, /^attachments$/i,
  // Same nature, found on this machine's projects: the secret every internal
  // token derives from, signing keystores, private keys, other credential files.
  /^\.orchestrateur-secret$/i, /^\.credentials/i, /^secrets$/i, /\.(?:jks|keystore|p12|pfx)$/i,
  /^keystore\.properties$/i, /^id_(?:rsa|dsa|ecdsa|ed25519)/i, /^\.netrc$/i, /^\.npmrc$/i,
]);

export const TEXT_VIEW_MAX = 2 * 1024 * 1024;

export const MEDIA_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.opus': 'audio/ogg',
});

const TEXT_EXTENSIONS = new Set(`md markdown txt srt vtt json jsonl ndjson log csv tsv xml yml yaml toml ini cfg conf
  properties mjs cjs js jsx ts tsx css scss html htm svg kt kts java gradle py sh bash bat cmd ps1 psm1 go rs c h cpp hpp
  cs rb php sql lock diff patch`.split(/\s+/));

const lower = (s) => s.toLowerCase();
const isUnder = (full, root) => {
  const f = lower(full), r = lower(win.normalize(root)).replace(/\\+$/, '');
  return f === r || f.startsWith(`${r}\\`);
};
const refuse = (code, reason, shown) => ({ ok: false, code, reason, path: shown });

/** "a/b.js:12:3" → {target: 'a/b.js', line: '12'}; a drive letter is left alone. */
export function splitLine(raw) {
  const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/s.exec(String(raw ?? ''));
  return { target: m[1], line: m[2] || null };
}

/**
 * Decides from the text alone (no disk access).
 * → {ok: true, path} or {ok: false, code, reason, path}.
 * `base` is the folder a relative path resolves in; `roots` exists for the tests.
 */
export function pathVerdict(raw, { base = null, roots = ALLOWED_ROOTS } = {}) {
  const shown = String(raw ?? '').trim();
  if (!shown || /[\0-\x1f]/.test(shown)) return refuse('invalid', 'chemin vide ou illisible', shown);
  if (/^[\\/]{2}/.test(shown)) return refuse('unc', 'chemin réseau (UNC) : jamais servi', shown);
  if (/^[a-z][a-z0-9+.-]+:/i.test(shown)) return refuse('scheme', 'ce n’est pas un chemin de fichier local', shown);
  if (/^[a-z]:(?![\\/])/i.test(shown) || /^[\\/]/.test(shown)) return refuse('invalid', 'chemin sans lecteur ou sans dossier précis', shown);
  const hasDrive = /^[a-z]:/i.test(shown);
  const segments = (hasDrive ? shown.slice(2) : shown).split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) return refuse('dotdot', 'le chemin contient « .. » : jamais suivi', shown);
  // Windows ignores a trailing dot or space and reads "x::$DATA" as x: each would hide a refused name.
  if (segments.some(s => s !== '.' && (/[.\s]$/.test(s) || /[:*?"<>|]/.test(s)))) return refuse('invalid', 'nom de fichier invalide sous Windows', shown);
  if (!hasDrive && !base) return refuse('relative', 'chemin relatif sans projet pour le situer', shown);
  const full = hasDrive ? win.normalize(shown) : win.join(win.normalize(base), shown);
  if (DENIED_TREES.some(t => isUnder(full, t))) return refuse('denied', 'dossier sensible : toujours refusé', full);
  if (full.split('\\').slice(1).some(s => DENIED_NAMES.some(re => re.test(s)))) return refuse('denied', 'fichier ou dossier sensible : toujours refusé', full);
  if (!roots.some(r => isUnder(full, r))) return refuse('outside', 'hors des dossiers autorisés', full);
  return { ok: true, path: full };
}

/** What opening this name means: text viewer, media player, or a download. */
export function categoryOf(name, size = 0) {
  const ext = lower(win.extname(String(name)));
  const type = MEDIA_TYPES[ext];
  if (type) return type.split('/')[0];
  return TEXT_EXTENSIONS.has(ext.slice(1)) && size <= TEXT_VIEW_MAX ? 'text' : 'download';
}

const realOf = (p) => { try { return fs.realpathSync.native(p); } catch { return win.normalize(p); } };

/**
 * → {status: 'ok', path, size, mtime, open: 'text'|'image'|'video'|'audio'|'download'}
 * or {status: 'directory'|'missing'|'refused', path, reason?, code?}.
 */
export function accessFile(raw, { base = null, roots = ALLOWED_ROOTS } = {}) {
  const v = pathVerdict(raw, { base, roots });
  if (!v.ok) return { status: 'refused', path: v.path, code: v.code, reason: v.reason };
  let real;
  try { real = fs.realpathSync.native(v.path); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { status: 'missing', path: v.path };
    return { status: 'refused', path: v.path, code: 'unreadable', reason: 'fichier illisible par le serveur' };
  }
  // A root may itself sit behind a link; everything below it must be the path asked for.
  const root = roots.find(r => isUnder(v.path, r));
  const expected = win.join(realOf(root), win.relative(root, v.path));
  if (lower(real) !== lower(expected)) return { status: 'refused', path: v.path, code: 'link', reason: 'lien symbolique ou nom court : jamais suivi' };
  let st;
  try { st = fs.statSync(real); } catch { return { status: 'missing', path: v.path }; }
  if (st.isDirectory()) return { status: 'directory', path: real };
  if (!st.isFile()) return { status: 'missing', path: v.path };
  return { status: 'ok', path: real, size: st.size, mtime: st.mtime.toISOString(), open: categoryOf(real, st.size) };
}
