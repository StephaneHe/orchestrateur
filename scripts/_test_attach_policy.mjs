#!/usr/bin/env node
// Chat attachments: .mkv accepted and a 500 MB cap end to end (0.108.0).
// User request (2026-10-16): « Acceptes les mkv et les fichiers jusqu'à 500Mo ».
//
// Checks the real shared module public/attach-policy.js (types, aliases,
// extension fallback, size boundary, wording), and that the server route, the
// client composer and the dashboard page all use it. The live upload (500 MB
// accepted, 500 MB + 1 refused with 413) is the HTTP check `attach-mkv-500`.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };

const ctx = vm.createContext({});
vm.runInContext(read('public/attach-policy.js'), ctx, { filename: 'attach-policy.js' });
const P = ctx.AttachPolicy;
const MB = 1024 * 1024;

console.log('1. Types acceptés');
ok(P.MAX_BYTES === 500 * MB, 'limite = 500 Mo');
ok(P.MIME_TO_EXT.get('video/x-matroska') === '.mkv', 'video/x-matroska → .mkv');
for (const [t, e] of [['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/gif', '.gif'],
  ['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov']]) {
  ok(P.MIME_TO_EXT.get(t) === e, `${t} toujours accepté (${e})`);
}
for (const alias of ['video/matroska', 'video/mkv', 'application/x-matroska', 'VIDEO/X-MATROSKA; codecs=x']) {
  ok(P.normalizeMime(alias) === 'video/x-matroska', `alias « ${alias} » → video/x-matroska`);
}
ok(P.MIME_TO_EXT.get(P.normalizeMime('text/plain')) === undefined, 'text/plain refusé');

console.log('2. Vérification d\'un fichier (client)');
const mkvNoType = P.check({ name: 'Réunion.MKV', type: '', size: 260 * MB });
ok(mkvNoType.ok && mkvNoType.mediaType === 'video/x-matroska' && mkvNoType.isVideo, '.mkv sans type (Windows) accepté par l\'extension');
ok(P.check({ name: 'x.bin', type: 'application/octet-stream', size: 1 }).reason === 'type', 'type inconnu refusé');
ok(P.check({ name: 'r.mkv', type: 'application/octet-stream', size: 1 }).ok, '.mkv en octet-stream accepté par l\'extension');
ok(P.check({ name: 'a.png', type: 'image/png', size: 10 }).isVideo === false, 'image : pas une vidéo');
ok(P.check({ name: 'v.mkv', type: 'video/x-matroska', size: 500 * MB }).ok, '500 Mo exactement : accepté');
const big = P.check({ name: 'v.mkv', type: 'video/x-matroska', size: 500 * MB + 1 });
ok(!big.ok && big.reason === 'size', '500 Mo + 1 octet : refusé');
ok(/v\.mkv/.test(big.message) && /trop volumineux/.test(big.message) && /500 Mo/.test(big.message), `message de taille clair : ${big.message}`);
const badMsg = P.unsupportedText(['notes.txt']);
ok(/notes\.txt/.test(badMsg) && /MKV/.test(badMsg) && /500 Mo/.test(badMsg) && !/100 Mo/.test(badMsg), `message de type à jour : ${badMsg}`);

console.log('3. Câblage');
const server = read('server.js');
ok(/import '\.\/public\/attach-policy\.js'/.test(server), 'server.js importe attach-policy.js');
ok(/MAX_ATTACH_BYTES = globalThis\.AttachPolicy\.MAX_BYTES/.test(server), 'le serveur prend la limite du module');
ok(/ATTACH_MIME = globalThis\.AttachPolicy\.MIME_TO_EXT/.test(server), 'le serveur prend les types du module');
ok(!/100 \* 1024 \* 1024/.test(server), 'plus de limite de 100 Mo dans server.js');
ok(/requestTimeout = 60 \* 60 \* 1000/.test(server), 'délai de requête HTTP relevé pour les gros envois');
const app = read('public/app.js');
ok(/AttachPolicy\.check\(f\)/.test(app), 'le composer vérifie chaque fichier par AttachPolicy');
ok(!/MP4\/WEBM\/MOV\)/.test(app), 'ancien message sans MKV disparu');
const html = read('public/index.html');
ok(html.indexOf('attach-policy.js') > 0 && html.indexOf('attach-policy.js') < html.indexOf('src="./app.js'), 'attach-policy.js chargé avant app.js');
ok(/id="composer-file"[^>]*accept="[^"]*\.mkv/.test(html), 'le sélecteur de fichiers propose .mkv');

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
