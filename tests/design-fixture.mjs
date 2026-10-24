// ============================================================================
// tests/design-fixture.mjs — real PNG files for the Design pipeline's tests
// ============================================================================
//
// A solid-colour PNG of any size (zlib, no dependency), and the source of a
// project capture script (the `design.capture` command of a fixture project)
// that writes one PNG per viewport and screen into {out} — the code path of a
// project that captures its own states, without a browser.
// ============================================================================

import zlib from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A valid w×h RGB PNG of one colour. */
export function pngBuffer(w, h, [r, g, b] = [200, 200, 200]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Source of a project script: node scripts/capture.mjs <out> → <out>/<viewport>/<screen>.png. */
export const CAPTURE_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';
import { pngBuffer } from ${JSON.stringify(new URL('./design-fixture.mjs', import.meta.url).href)};
const out = process.argv[2];
if (process.env.FIXTURE_CAPTURE_FAIL === '1') { console.error('Chrome introuvable (simulé)'); process.exit(3); }
const css = fs.existsSync('site/style.css') ? fs.readFileSync('site/style.css', 'utf8') : '';
const shade = css.includes('max-width') ? [240, 240, 250] : [255, 255, 255];
for (const [vp, w, h] of [['mobile', 390, 844], ['bureau', 1280, 800]]) {
  const many = Number(process.env.FIXTURE_CAPTURE_MANY) || 0;
  for (const screen of many ? Array.from({ length: many }, (_, i) => 'etat-' + String(i).padStart(2, '0')) : ['accueil', 'question']) {
    fs.mkdirSync(path.join(out, vp), { recursive: true });
    fs.writeFileSync(path.join(out, vp, screen + '.png'), pngBuffer(w, h, shade));
  }
}
console.log('4 captures');
`;
