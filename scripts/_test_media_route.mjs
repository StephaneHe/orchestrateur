#!/usr/bin/env node
// ============================================================================
// scripts/_test_media_route.mjs — GET /api/media serves an image (200) and a
// video as a partial response to a Range request (206)
// ============================================================================
// User request (2026-10-29, verbatim): « Il faut que l'orchestrateur puisse
// afficher des images ou des videos. Web et mobile ». This suite covers the
// serving side: on a PRIVATE instance of the real server.js, an image under a
// fleet root comes back whole with its content type, a video comes back as
// 206 with the exact bytes of the requested Range.
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

  console.log('── refus');
  // An allowed extension outside every fleet root, asked directly and through `../`.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-out-'));
  const outPng = path.join(outDir, 'secret.png');
  fs.writeFileSync(outPng, png);
  // A file under a fleet root whose extension is neither image nor video.
  const txtPath = path.join(path.dirname(imgPath), 'note.txt');
  fs.writeFileSync(txtPath, 'not media');
  try {
    const direct = await media(outPng);
    ok(direct.status === 404 && (await direct.arrayBuffer()).byteLength === 0, 'hors racine : refusé sans rien servir', direct.status);
    const viaDots = `${outDir}${path.sep}..${path.sep}${path.basename(outDir)}${path.sep}secret.png`;
    const dotdot = await media(viaDots);
    ok(dotdot.status === 404, 'hors racine par ../ : refusé', `${viaDots} → ${dotdot.status}`);
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
