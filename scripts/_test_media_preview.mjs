#!/usr/bin/env node
// User request (2026-10-29): « Il faut que l'orchestrateur puisse afficher des
// images ou des videos. Web et mobile ». Rendering side: a cited image or video
// file shows an inline preview served by GET /api/media?path=…
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };

await import(pathToFileURL(path.join(ROOT, 'public', 'html-render.js')).href);
await import(pathToFileURL(path.join(ROOT, 'public', 'id-links.js')).href);
const L = globalThis.IdLinks;

// String.raw: real Windows paths keep their backslashes.
const img = L.linkify(String.raw`Voir [[fichier:I:\Dev\Chef\phone-after-restart.png]] svp`);
ok(/<img\b[^>]*src="\/api\/media\?path=[^"]*phone-after-restart\.png/.test(img), 'cited image gets an <img> preview via /api/media');
ok(img.includes('src="/api/media?path=I%3A%5CDev%5CChef%5Cphone-after-restart.png"'), 'backslash path is URL-encoded in the path parameter');

const vid = L.linkify(String.raw`Vidéo [[fichier:I:\Dev\Chef\demo.mp4]]`);
ok(/<video\b[^>]*\bcontrols\b[^>]*src="\/api\/media\?path=[^"]*demo\.mp4/.test(vid), 'cited video gets a <video controls> player');

const txt = L.linkify(String.raw`Voir [[fichier:I:\Dev\Chef\notes.txt]]`);
ok(!/<img|<video/.test(txt), 'non-media file gets no preview');

console.log(`\n${pass} ok, ${fail} ko`);
process.exit(fail ? 1 : 0);
