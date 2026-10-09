// ============================================================================
// scripts/media-check.mjs — deterministic checks of media files produced by a
// pipeline step (pipelines phase 6, lot C, 0.55.0)
// ============================================================================
//
// The engine never trusts "I produced the image / the video": every output
// listed by the step is opened and checked here — it exists inside the project
// or the run folder, is not empty, has the signature of the expected kind, and
// (when ffprobe is installed) really decodes with a duration and the expected
// stream. ORCH_FFPROBE=<path>|none overrides discovery (tests).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SIGS = {
  image: [
    ['png', (b) => b.length > 24 && b.readUInt32BE(0) === 0x89504e47],
    ['jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
    ['gif', (b) => b.slice(0, 4).toString('latin1') === 'GIF8'],
    ['webp', (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP'],
    ['svg', (b) => /<svg[\s>]/i.test(b.slice(0, 2048).toString('utf8'))],
  ],
  audio: [
    ['wav', (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WAVE'],
    ['mp3', (b) => b.slice(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
    ['ogg', (b) => b.slice(0, 4).toString('latin1') === 'OggS'],
    ['flac', (b) => b.slice(0, 4).toString('latin1') === 'fLaC'],
    ['m4a', (b) => b.slice(4, 8).toString('latin1') === 'ftyp'],
  ],
  video: [
    ['mp4', (b) => b.slice(4, 8).toString('latin1') === 'ftyp'],
    ['mkv', (b) => b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3],
    ['avi', (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 11).toString('latin1') === 'AVI'],
    ['gif', (b) => b.slice(0, 4).toString('latin1') === 'GIF8'],
  ],
  text: [['texte', (b) => b.length > 0 && !b.slice(0, 512).includes(0)]],
};

/** Image size from the header (png, gif, jpeg), or null. */
export function imageSize(b) {
  try {
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.slice(0, 4).toString('latin1') === 'GIF8') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* truncated header */ }
  return null;
}

export function findFfprobe(env = process.env) {
  if (env.ORCH_FFPROBE) return env.ORCH_FFPROBE === 'none' ? null : env.ORCH_FFPROBE;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffprobe'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? (r.stdout.split(/\r?\n/)[0] || '').trim() || null : null;
}

/** Paths listed by the step: backquoted paths in its artefact (« ## Fichiers » first). */
export function listedFiles(artefactText) {
  const lines = String(artefactText || '').split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s+Fichiers/i.test(l));
  let src = lines;
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
    src = lines.slice(start + 1, end < 0 ? undefined : end);
  }
  return [...new Set([...src.join('\n').matchAll(/`([^`\n]+\.[A-Za-z0-9]{2,5})`/g)].map(m => m[1].trim()))];
}

/**
 * Checks every listed file of `kind`. `roots`: folders a file may live in.
 * Returns { ok, why, files: [{path, kind, format, bytes, size?, duration?}] }.
 */
export function checkMediaFiles(listed, { kind, min = 1, roots, env = process.env } = {}) {
  const ffprobe = kind === 'video' || kind === 'audio' ? findFfprobe(env) : null;
  const out = [];
  for (const rel of listed) {
    const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(roots[0], rel);
    if (!roots.some(r => abs === path.resolve(r) || abs.startsWith(path.resolve(r) + path.sep))) return { ok: false, why: `fichier hors du projet : ${rel}` };
    if (!fs.existsSync(abs)) return { ok: false, why: `fichier annoncé mais absent : ${rel}` };
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size === 0) return { ok: false, why: `fichier vide : ${rel}` };
    const head = Buffer.alloc(Math.min(st.size, 64 * 1024));
    const fd = fs.openSync(abs, 'r'); fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd);
    const sig = (SIGS[kind] || []).find(([, test]) => test(head));
    if (!sig) continue;   // other files (artefacts, transcripts) may be listed too
    const rec = { path: rel, kind, format: sig[0], bytes: st.size };
    if (kind === 'image') {
      const size = imageSize(head);
      if (size) { if (!size.w || !size.h) return { ok: false, why: `image sans dimensions : ${rel}` }; rec.size = size; }
    }
    if (ffprobe) {
      const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', abs], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
      let j = null; try { j = JSON.parse(r.stdout); } catch { /* unreadable */ }
      if (r.status !== 0 || !j) return { ok: false, why: `ffprobe ne lit pas ${rel} : ${(r.stderr || '').trim().slice(0, 200)}` };
      const types = (j.streams || []).map(s => s.codec_type);
      const dur = Number(j.format?.duration);
      if (!types.includes(kind)) return { ok: false, why: `${rel} : aucune piste ${kind === 'video' ? 'vidéo' : 'audio'} (ffprobe)` };
      if (!(dur > 0)) return { ok: false, why: `${rel} : durée nulle (ffprobe)` };
      rec.duration = dur;
    }
    out.push(rec);
  }
  if (out.length < min) return { ok: false, why: `aucun fichier ${{ image: 'image', video: 'vidéo', audio: 'audio', text: 'texte' }[kind] || kind} valide listé dans la section « ## Fichiers » de l’artefact (${listed.length ? `listés : ${listed.slice(0, 5).join(', ')}` : 'aucun'})`, files: out };
  return { ok: true, files: out, probed: !!ffprobe };
}

/** Word error rate (Levenshtein on words) between a reference and a hypothesis. */
export function wordErrorRate(ref, hyp) {
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  const r = norm(ref), h = norm(hyp);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[h.length] / r.length;
}
