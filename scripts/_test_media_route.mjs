#!/usr/bin/env node
// ============================================================================
// scripts/_test_media_route.mjs — GET /api/media serves an image (200) and a
// video as a partial response to a Range request (206); refuses paths outside
// the fleet roots (direct and via `../`) and non-media extensions
// ============================================================================
// User request (2026-10-29, verbatim): « Il faut que l'orchestrateur puisse
// afficher des images ou des videos. Web et mobile ». This suite covers the
// serving side: on a PRIVATE instance of the real server.js, an image under a
// fleet root comes back whole with its content type, a video comes back as
// 206 with the exact bytes of the requested Range. Refusals (404, empty body):
// an image outside every root, a path that starts in a root and leaves it by
// `../`, and a non-media extension under a root.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}${d ? `\n      ${String(d).slice(0, 600)}` : ''}`); } };

const { startSandbox } = await import('./_regression_sandbox.mjs');
const sb = await startSandbox({ worktree: true }, 'media-route');
const H = { 'X-Orchestrator-Token': sb.token };
const media = (p, headers = {}) => fetch(`${sb.url}/api/media?path=${encodeURIComponent(p)}`, { headers: { ...H, ...headers } });
// Uploads land under the instance's attachments folder, a fleet root.
const upload = async (type, body) => {
  const r = await fetch(`${sb.url}/api/attach/image`, { method: 'POST', headers: { ...H, 'Content-Type': type }, body });
  return (await r.json()).path;
};

try {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const video = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const imgPath = await upload('image/png', png);
  const vidPath = await upload('video/mp4', video);
  ok(imgPath && vidPath && fs.existsSync(imgPath) && fs.existsSync(vidPath), 'fichiers de test déposés sous une racine du parc');

  console.log('── image');
  const img = await media(imgPath);
  ok(img.status === 200, 'image : 200', img.status);
  ok(/^image\/png/.test(img.headers.get('content-type') || ''), 'image : type de contenu image/png', img.headers.get('content-type'));
  ok(Buffer.from(await img.arrayBuffer()).equals(png), 'image : contenu exact');

  console.log('── vidéo en Range');
  const vid = await media(vidPath, { Range: 'bytes=10-19' });
  ok(vid.status === 206, 'vidéo : 206', vid.status);
  ok(vid.headers.get('content-range') === `bytes 10-19/${video.length}`, 'vidéo : Content-Range correct', vid.headers.get('content-range'));
  ok(Buffer.from(await vid.arrayBuffer()).equals(video.subarray(10, 20)), 'vidéo : octets demandés exacts');

  console.log('── audio (2026-10-31)');
  // User request (2026-10-31): « ajoutes un lecteur pour lire dans l'App (il n'y en a pas) et dans le web s'il n'y en a pas déja ».
  const aTypes = { wav: /^audio\/(x-)?wav|^audio\/wave/, mp3: /^audio\/mpeg/, ogg: /^audio\/ogg/, m4a: /^audio\/(mp4|x-m4a|m4a)/, flac: /^audio\/(x-)?flac/, opus: /^audio\/(ogg|opus)/ };
  const aDir = path.dirname(imgPath);
  for (const [ext, re] of Object.entries(aTypes)) {
    const f = path.join(aDir, `son-test.${ext}`);
    fs.writeFileSync(f, video);
    try {
      const r = await media(f, { Range: 'bytes=10-19' });
      ok(r.status === 206, `.${ext} : 206 sur Range`, r.status);
      ok(re.test(r.headers.get('content-type') || ''), `.${ext} : Content-Type audio`, r.headers.get('content-type'));
      ok(r.headers.get('content-range') === `bytes 10-19/${video.length}`, `.${ext} : Content-Range`, r.headers.get('content-range'));
      ok(Buffer.from(await r.arrayBuffer()).equals(video.subarray(10, 20)), `.${ext} : octets exacts`);
    } finally { fs.rmSync(f, { force: true }); }
  }

  console.log('── refus');
  // An allowed extension outside every fleet root, asked directly and through `../`.
  // Same drive as the uploads (a relative `../` path cannot cross drives): the
  // drive root is outside every fleet root; os.tmpdir() serves other platforms.
  const driveRoot = path.parse(imgPath).root;
  const outBase = path.parse(os.tmpdir()).root === driveRoot ? os.tmpdir() : driveRoot;
  const outDir = fs.mkdtempSync(path.join(outBase, 'media-out-'));
  const outPng = path.join(outDir, 'secret.png');
  fs.writeFileSync(outPng, png);
  // A file under a fleet root whose extension is neither image nor video.
  const txtPath = path.join(path.dirname(imgPath), 'note.txt');
  fs.writeFileSync(txtPath, 'not media');
  try {
    const direct = await media(outPng);
    ok(direct.status === 404 && (await direct.arrayBuffer()).byteLength === 0, 'hors racine : refusé sans rien servir', direct.status);
    // Starts INSIDE a fleet root and climbs out with `../`, built as a plain
    // string (no normalisation): a prefix check on the raw path would accept it,
    // only resolving the path first refuses it.
    const rootDir = path.dirname(imgPath);
    const viaDots = `${rootDir}${path.sep}${path.relative(rootDir, outDir)}${path.sep}secret.png`;
    ok(viaDots.startsWith(rootDir) && viaDots.includes('..'), 'chemin ../ construit depuis une racine du parc', viaDots);
    const dotdot = await media(viaDots);
    ok(dotdot.status === 404 && (await dotdot.arrayBuffer()).byteLength === 0, 'sortie d’une racine par ../ : refusée, rien servi', `${viaDots} → ${dotdot.status}`);
    // Audio types must not widen access: same refusals for a sound outside the roots.
    const outWav = path.join(outDir, 'secret.wav');
    fs.writeFileSync(outWav, png);
    const wavDirect = await media(outWav);
    ok(wavDirect.status === 404 && (await wavDirect.arrayBuffer()).byteLength === 0, 'audio hors racine : refusé sans rien servir', wavDirect.status);
    const wavDots = `${rootDir}${path.sep}${path.relative(rootDir, outDir)}${path.sep}secret.wav`;
    const wavVia = await media(wavDots);
    ok(wavVia.status === 404 && (await wavVia.arrayBuffer()).byteLength === 0, 'audio : sortie d’une racine par ../ refusée, rien servi', `${wavDots} → ${wavVia.status}`);
    const txt = await media(txtPath);
    ok(txt.status === 404 && (await txt.text()) === '', 'extension non autorisée sous une racine : refusée', txt.status);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(txtPath, { force: true });
  }
} finally {
  await sb.stop();
  fs.rmSync(sb.root, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
