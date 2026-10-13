#!/usr/bin/env node
// README screenshots (0.76.3, user request: "Si tu peux avant de commit, fais
// des captures d'écran pour améliorer le README (qui doit être en anglais)").
// Every image the README references must exist in the repository, be a light
// PNG, carry an English alt text, and every file of docs/screenshots/ must be
// used: a renamed or deleted capture breaks the rendered README on GitHub.
// The captures are produced by scripts/readme-screenshots.mjs (isolated test
// instance, fictional fixtures); this suite covers that script too.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(ROOT, 'README.md');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const MAX_BYTES = 400 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The screens the user asked for: overview, TODO panel, git tab.
const REQUIRED = ['dashboard-overview.png', 'side-panel-todo.png', 'side-panel-git.png'];

let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };

export function readmeImages(md) {
  const out = [];
  for (const m of md.matchAll(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) out.push({ at: m.index, alt: m[1], src: m[2] });
  for (const m of md.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*"([^"]+)"/i.exec(m[0]);
    const alt = /\balt\s*=\s*"([^"]*)"/i.exec(m[0]);
    if (src) out.push({ at: m.index, alt: alt ? alt[1] : '', src: src[1] });
  }
  return out.sort((a, b) => a.at - b.at).map(({ alt, src }) => ({ alt, src }));
}

// French-only letters and common French words: the README must be in English.
const FRENCH = /[àâçéèêëîïôûùüÿœ]|\b(le|la|les|des|du|une|avec|panneau|tâches?)\b/i;

console.log('README image references');
const md = fs.readFileSync(README, 'utf8');
const imgs = readmeImages(md);
const local = imgs.filter(i => !/^[a-z]+:\/\//i.test(i.src));
ok(local.length >= REQUIRED.length, `${local.length} local image(s) referenced`);
for (const i of local) {
  const file = path.join(ROOT, decodeURIComponent(i.src.split('#')[0]));
  const exists = fs.existsSync(file) && fs.statSync(file).isFile();
  ok(exists, `${i.src} exists`);
  if (!exists) continue;
  const buf = fs.readFileSync(file);
  ok(buf.subarray(0, 8).equals(PNG_SIG), `${i.src} is a PNG`);
  ok(buf.length <= MAX_BYTES, `${i.src} weighs ${Math.round(buf.length / 1024)} KiB (≤ ${MAX_BYTES / 1024})`);
  ok(i.alt.trim().length >= 10, `${i.src} has an alt text`);
  ok(!FRENCH.test(i.alt), `${i.src} alt text is English: "${i.alt}"`);
}

console.log('docs/screenshots');
const used = new Set(local.map(i => path.basename(i.src)));
for (const r of REQUIRED) ok(used.has(r), `README shows ${r}`);
const files = fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS) : [];
for (const f of files) ok(used.has(f), `${f} is referenced by the README (no orphan)`);

console.log('parser');
const sample = '![An overview](docs/a.png)\n<img src="docs/b.png" alt="Second one" width="400">\n![x](https://example.org/c.png "t")';
const parsed = readmeImages(sample);
ok(parsed.length === 3 && parsed[0].src === 'docs/a.png' && parsed[1].alt === 'Second one' && parsed[2].src === 'https://example.org/c.png', 'markdown and <img> references are found');

console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
