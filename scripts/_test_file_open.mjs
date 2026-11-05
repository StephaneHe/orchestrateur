#!/usr/bin/env node
// ============================================================================
// scripts/_test_file_open.mjs — a file cited in the thread can always be opened,
// and only the allowed ones (0.163.0)
// ============================================================================
// User request (2026-11-05, verbatim): « Tu me donnes des liens vers des fichiers
// et quand je click par exemple sur [un chemin], ca me dit ⚠ Identifiant inconnu.
// Je voudrais que si c'est un identifiant, que ca remonte les informations, mais
// que de toutes facons ca me fasse un lien pour ouvrir le fichier (local ou web) ».
//
// FICTIVE data only, in temporary folders. The protected trees of the allowlist
// are checked from the text of the path (pathVerdict never touches the disk) or
// with names that do not exist: this suite opens nothing real.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}${d !== undefined ? `\n      ${String(d).slice(0, 600)}` : ''}`); } };
const section = (s) => console.log(`── ${s}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ALLOWED_ROOTS, TEXT_VIEW_MAX, pathVerdict, accessFile, categoryOf, splitLine } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'file-access.mjs')).href);
const SECRET = 'VALEUR-FICTIVE-JAMAIS-SERVIE';

// ---------------------------------------------------------------------------
section('1. Liste d’autorisation : une seule source, décidée sur le texte du chemin');
ok(JSON.stringify(ALLOWED_ROOTS) === JSON.stringify(['I:\\Dev', 'I:\\orchestrateur', 'I:\\Enregistrements', 'I:\\psyprofile-data\\seances\\anonymise', 'I:\\psyprofile-data\\seances\\etude']) && Object.isFrozen(ALLOWED_ROOTS), 'exactement les cinq racines demandées, figées');
for (const p of ['I:\\Dev\\x\\a.md', 'i:/dev/x/a.md', 'I:\\orchestrateur\\docs\\a.md', 'I:\\Enregistrements\\a.mp3', 'I:\\psyprofile-data\\seances\\anonymise\\a.txt', 'I:\\psyprofile-data\\seances\\etude\\a.md']) {
  ok(pathVerdict(p).ok, `autorisé : ${p}`, JSON.stringify(pathVerdict(p)));
}
const refusals = [
  ['I:\\psyprofile-data\\seances\\brut\\a.txt', 'denied'], ['i:/PSYPROFILE-DATA/seances/BRUT/a.txt', 'denied'],
  ['I:\\psyprofile-data\\responses\\a.json', 'denied'], ['I:\\psyprofile-data\\autre.txt', 'outside'],
  ['I:\\psyprofile-data\\seances\\etude-bis\\a.md', 'outside'], ['I:\\Dev2\\a.md', 'outside'], ['C:\\Windows\\win.ini', 'outside'],
  ['I:\\Dev\\p\\.env', 'denied'], ['I:\\Dev\\p\\.env.local', 'denied'], ['I:\\Dev\\p\\.ENV', 'denied'], ['I:\\Dev\\p\\.token', 'denied'],
  ['I:\\Dev\\p\\a.key', 'denied'], ['I:\\Dev\\p\\a.PEM', 'denied'], ['I:\\Dev\\p\\credentials.json', 'denied'], ['I:\\Dev\\p\\Credentials', 'denied'],
  ['I:\\Dev\\p\\auth.json', 'denied'], ['I:\\Dev\\p\\.git\\config', 'denied'], ['I:\\orchestrateur\\attachments\\a.txt', 'denied'],
  ['I:\\orchestrateur\\.orchestrateur-secret', 'denied'], ['I:\\Dev\\p\\release.jks', 'denied'],
  ['\\\\srv\\partage\\a.md', 'unc'], ['//srv/partage/a.md', 'unc'], ['\\\\?\\I:\\Dev\\a.md', 'unc'], ['\\\\.\\I:\\Dev\\a.md', 'unc'],
  ['I:\\Dev\\..\\Windows\\win.ini', 'dotdot'], ['I:/Dev/x/../../a.md', 'dotdot'], ['..\\a.md', 'dotdot'],
  ['I:\\Dev\\p\\.env.', 'invalid'], ['I:\\Dev\\p\\.env::$DATA', 'invalid'], ['I:\\Dev\\p\\a.md:flux', 'invalid'], ['I:\\Dev\\p\\a*.md', 'invalid'],
  ['I:a.md', 'invalid'], ['\\a.md', 'invalid'], ['/a.md', 'invalid'], ['I:\\Dev\\a\u0000.md', 'invalid'], ['', 'invalid'],
  ['file:///I:/Dev/a.md', 'scheme'], ['http://x/a.md', 'scheme'], ['javascript:alert(1)', 'scheme'], ['a.md', 'relative'],
];
for (const [p, code] of refusals) {
  const v = pathVerdict(p);
  ok(!v.ok && v.code === code, `refusé (${code}) : ${JSON.stringify(p)}`, JSON.stringify(v));
}
ok(pathVerdict('src/a.md', { base: 'I:\\Dev\\p' }).path === 'I:\\Dev\\p\\src\\a.md', 'chemin relatif : résolu dans le dossier du projet');
ok(!pathVerdict('.env', { base: 'I:\\Dev\\p' }).ok && !pathVerdict('.git/config', { base: 'I:\\Dev\\p' }).ok, 'chemin relatif : mêmes refus');
ok(pathVerdict('I:\\Dev\\p\\.gitignore').ok && pathVerdict('I:\\Dev\\p\\.github\\a.yml').ok, '.gitignore et .github ne sont pas .git');
ok(splitLine('I:\\Dev\\a.md:12:3').target === 'I:\\Dev\\a.md' && splitLine('I:\\Dev\\a.md:12').line === '12' && splitLine('I:\\Dev\\a.md').line === null, 'numéro de ligne séparé, lettre de lecteur gardée');
ok(categoryOf('a.MD') === 'text' && categoryOf('a.srt') === 'text' && categoryOf('a.json') === 'text' && categoryOf('a.mjs') === 'text', 'texte : .md, .srt, .json, code');
ok(categoryOf('a.png') === 'image' && categoryOf('a.mp4') === 'video' && categoryOf('a.wav') === 'audio', 'médias : image, vidéo, son');
ok(categoryOf('a.zip') === 'download' && categoryOf('a.md', TEXT_VIEW_MAX + 1) === 'download' && categoryOf('a.md', TEXT_VIEW_MAX) === 'text', 'autre format, ou texte trop gros : téléchargement');

// ---------------------------------------------------------------------------
section('2. accessFile, dossier temporaire : existant, absent, dossier, lien');
const T = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-file-')));
const OUT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-file-out-')));
fs.mkdirSync(path.join(T, 'sub'));
fs.writeFileSync(path.join(T, 'sub', 'a.md'), '# fictif\n');
fs.writeFileSync(path.join(OUT, 'dehors.txt'), SECRET);
fs.symlinkSync(OUT, path.join(T, 'lien'), 'junction');
const roots = Object.freeze([T]);
const opts = Object.freeze({ roots });
let a = accessFile(path.join(T, 'sub', 'a.md'), opts);
ok(a.status === 'ok' && a.open === 'text' && a.size === 9 && !('content' in a), 'fichier existant : état, type d’ouverture, taille, jamais le contenu', JSON.stringify(a));
ok(accessFile('sub/a.md', { base: T, roots }).status === 'ok', 'relatif au projet');
ok(accessFile(path.join(T, 'absent.md'), opts).status === 'missing', 'absent : « missing », pas « refused »');
ok(accessFile(path.join(T, 'sub'), opts).status === 'directory', 'dossier reconnu');
a = accessFile(path.join(T, 'lien', 'dehors.txt'), opts);
ok(a.status === 'refused' && a.code === 'link', 'fichier derrière une jonction : refusé, jamais suivi', JSON.stringify(a));
ok(accessFile(path.join(OUT, 'dehors.txt'), opts).status === 'refused', 'hors racine : refusé');
ok(accessFile(path.join(T, 'lien', 'absent-xyz.md'), opts).status !== 'ok', 'derrière une jonction, même absent : jamais ok');

// ---------------------------------------------------------------------------
section('3. Client : liens et bloc fichier (partie pure de public/id-links.js)');
await import(pathToFileURL(path.join(ROOT, 'public', 'id-links.js')).href);
const L = globalThis.IdLinks;
L.setVocab({ projects: ['alpha'], slots: [], conductor: 'chef' });
let h = L.linkify('<p>[[https://exemple.test/a?b=1&amp;c=2]]</p>');
ok(/<a class="idref-url" href="https:\/\/exemple\.test\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">/.test(h) && !/\[\[/.test(h) && !/data-idref=/.test(h), 'URL http(s) balisée : lien direct, nouvel onglet', h);
h = L.linkify('<p>[[<a href="https://exemple.test/z" target="_blank" rel="noopener noreferrer">https://exemple.test/z</a>]]</p>');
ok(!/\[\[|\]\]/.test(h) && (h.match(/<a /g) || []).length === 1, 'URL déjà liée par le Markdown : crochets retirés', h);
for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/x', 'ftp://x/y', 'vbscript:x']) {
  h = L.linkify(`<p>[[${bad}]]</p>`);
  ok(!/\bhref="(?!#)/.test(h) && !/idref-url/.test(h), `aucun lien direct pour ${bad}`, h);
}
h = L.linkify('<p>[[I:\\psyprofile-data\\seances\\etude\\fictif.md]]</p>');
ok(/data-idref="I:\\psyprofile-data\\seances\\etude\\fictif\.md"/.test(h), 'chemin balisé : lien vers le panneau', h);
ok(/data-idref-kind="fichier"/.test(L.linkify('<p>voir notes/transcription.srt</p>')), 'un .srt dans le texte devient un lien');
const fb = L.fileBlockHtml;
const file = Object.freeze({ status: 'ok', path: 'I:\\Dev\\x\\a b.md', open: 'text' });
h = fb(file);
ok(/data-file-open="text"/.test(h) && /data-file-copy="I:\\Dev\\x\\a b\.md"/.test(h) && />Ouvrir</.test(h), 'texte : bouton Ouvrir, chemin, Copier', h);
ok(/data-file-open="image"/.test(fb({ status: 'ok', path: 'a.png', open: 'image' })) && /data-file-open="video"/.test(fb({ status: 'ok', path: 'a.mp4', open: 'video' })) && /data-file-open="audio"/.test(fb({ status: 'ok', path: 'a.wav', open: 'audio' })), 'médias : bouton Ouvrir du lecteur');
h = fb({ status: 'ok', path: 'a b.zip', open: 'download' });
ok(/href="\/api\/file\?path=a%20b\.zip&amp;download=1"/.test(h) && /\bdownload\b/.test(h), 'autre format : téléchargement servi par le serveur, jamais file://', h);
h = fb({ status: 'missing', path: 'I:\\Dev\\absent.md' });
ok(/introuvable/.test(h) && !/non autorisé/.test(h) && /absent\.md/.test(h) && /data-file-copy/.test(h) && !/data-file-open/.test(h), 'absent : dit « introuvable », chemin, Copier, pas d’Ouvrir', h);
h = fb({ status: 'refused', path: 'I:\\Dev\\.env', reason: 'fichier sensible' });
ok(/non autorisé/.test(h) && !/introuvable/.test(h) && /\.env/.test(h) && /data-file-copy/.test(h) && !/data-file-open/.test(h), 'refusé : dit « non autorisé », chemin, Copier, pas d’Ouvrir', h);
h = fb({ status: 'missing', path: '<img src=x onerror=alert(1)>' });
ok(!/<img/.test(h), 'chemin échappé dans le panneau', h);
ok(!/Identifiant inconnu/.test(fb({ status: 'missing', path: 'a' }) + fb({ status: 'refused', path: 'a' }) + fb(file)), 'jamais « Identifiant inconnu » pour un chemin');
const clientSrc = fs.readFileSync(path.join(ROOT, 'public', 'id-links.js'), 'utf8');
ok(/mdToHtml\(text, \{ html: false, idrefs: false \}\)/.test(clientSrc), 'visionneuse Markdown : HTML brut jamais interprété');
ok(!/file:\/\//.test(clientSrc.replace(/^\s*\/\/.*$/gm, '')), 'aucun lien file:// dans le client');

// ---------------------------------------------------------------------------
section('4. resolveId : la réponse du serveur au clic');
const { resolveId } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'id-resolve.mjs')).href);
const P = path.join(T, 'projet');
fs.mkdirSync(P);
fs.writeFileSync(path.join(P, 'TODO_LIST.md'), '# TODO\n\n- [ ] (2026-11-05 09:00) Fictif <!-- id:t-1a2b3c -->\n');
fs.writeFileSync(path.join(P, 'doc.md'), '# doc\n');
fs.writeFileSync(path.join(T, 'hors-projet.md'), '# hors\n');
const ctx = (contextProject = null) => ({ root: T, logsDir: path.join(T, 'logs'), projects: [{ name: 'alpha', path: P }], conductor: 'chef', todoOf: () => [{ id: 't-1a2b3c', title: 'Fictif', status: 'todo' }], pipelines: [], assignments: {}, contextProject, fileRoots: roots });
let r = await resolveId('t-1a2b3c', '', ctx());
ok(r.known && r.kind === 'todo' && r.title === 'Fictif' && r.file?.status === 'ok' && r.file.path.endsWith('TODO_LIST.md') && !('filePath' in r), 'identifiant connu : ses informations, plus le fichier qui le porte', JSON.stringify(r).slice(0, 300));
r = await resolveId('doc.md', 'fichier', ctx('alpha'));
ok(r.known && r.file?.status === 'ok' && r.file.open === 'text' && r.project === 'alpha', 'relatif : résolu dans le projet du fil', JSON.stringify(r).slice(0, 300));
r = await resolveId('hors-projet.md', 'fichier', ctx('alpha'));
ok(!r.known && r.file?.status === 'missing', 'relatif absent du projet du fil : jamais cherché ailleurs dans ce cas', JSON.stringify(r).slice(0, 300));
r = await resolveId(`fichier:${path.join(T, 'hors-projet.md')}`, '', ctx());
ok(r.known && r.file?.status === 'ok' && r.project === null, 'absolu autorisé, hors de tout projet : connu et ouvrable', JSON.stringify(r).slice(0, 300));
r = await resolveId(path.join(T, 'absent.md'), '', ctx());
ok(!r.known && r.kind === 'fichier' && r.file?.status === 'missing', 'absent : état « missing »', JSON.stringify(r).slice(0, 300));
r = await resolveId(path.join(OUT, 'dehors.txt'), '', ctx());
ok(!r.known && r.file?.status === 'refused' && !JSON.stringify(r).includes(SECRET), 'non autorisé : état « refused », rien du contenu', JSON.stringify(r).slice(0, 300));
fs.writeFileSync(path.join(P, '.env'), SECRET);
r = await resolveId('.env', 'fichier', ctx('alpha'));
ok(!r.known && r.file?.status === 'refused' && !('date' in r), '.env du projet : refusé, ni taille ni date', JSON.stringify(r).slice(0, 300));
r = await resolveId('https://exemple.test/a', '', ctx());
ok(r.known && r.kind === 'url' && r.url === 'https://exemple.test/a', 'URL http(s) : connue, lien direct');
for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x/y', 'url:javascript:alert(1)']) {
  r = await resolveId(bad, '', ctx());
  ok(!r.known && r.kind === 'url' && !r.url && /http\(s\)/.test(r.message), `schéma refusé : ${bad}`, JSON.stringify(r));
}
r = await resolveId('file:///C:/Windows/win.ini', '', ctx());
ok(!r.known && r.file?.status === 'refused', 'file:// : refusé', JSON.stringify(r));

// ---------------------------------------------------------------------------
section('5. Instance privée du vrai server.js : GET /api/file et /api/media');
const { startSandbox } = await import('./_regression_sandbox.mjs');
const sb = await startSandbox({ worktree: true }, 'file-open');
const H = { 'X-Orchestrator-Token': sb.token };
const fileGet = (p, extra = '') => fetch(`${sb.url}/api/file?path=${encodeURIComponent(p)}${extra}`, { headers: H });
const identify = async (q) => (await fetch(`${sb.url}/api/identify?${new URLSearchParams(q)}`, { headers: H })).json();
const D = path.join(sb.root, 'fichiers-fictifs');
fs.mkdirSync(path.join(D, '.git'), { recursive: true });
fs.mkdirSync(path.join(D, 'attachments'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const write = (n, c) => fs.writeFileSync(path.join(D, n), c);
const md = '# Titre\n\n<script>window.__xss = 1</script>\n';
write('doc.md', md);
write('sous-titres.srt', '1\n00:00:01,000 --> 00:00:02,000\nFictif\n');
write('page.html', '<script>alert(1)</script>');
write('image.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
write('archive.zip', 'PK-fictif');
write('gros.txt', Buffer.alloc(TEXT_VIEW_MAX + 1, 'x'));
write('image.png', png);
const DENIED = ['.env', '.env.local', '.ENV', '.token', 'a.key', 'b.pem', 'credentials.json', 'Credentials.txt', 'auth.json', '.git/config', 'attachments/a.txt', '.orchestrateur-secret'];
for (const n of DENIED) write(n, SECRET);
write('.env.png', SECRET);
write('.git/image.png', SECRET);
fs.symlinkSync(OUT, path.join(D, 'lien'), 'junction');

try {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const route = src.indexOf("app.get('/api/file'");
  ok(route > src.indexOf('// [1] Network guard') && route > src.indexOf('// [2] Token gate') && src.indexOf('// [1] Network guard') > 0 && src.indexOf('// [2] Token gate') > 0, 'route montée après le garde réseau et le contrôle du jeton');
  ok(/const TOKEN_GATE_ENABLED = false/.test(src) ? true : (await fetch(`${sb.url}/api/file?path=x`)).status === 401, 'contrôle du jeton : suit le mode réel du serveur (coupé depuis le 2026-09-07), sinon 401');
  ok(/if \(!isUpload && accessFile\(raw\)\.status !== 'ok'\)/.test(src), '/api/media passe par la même liste (ses propres pièces jointes exceptées)');
  for (const method of ['POST', 'PUT', 'DELETE']) ok((await fetch(`${sb.url}/api/file?path=x`, { method, headers: H })).status === 404, `${method} : pas de route`);

  let res = await fileGet(path.join(D, 'doc.md'));
  ok(res.status === 200 && /^text\/plain/.test(res.headers.get('content-type') || '') && (await res.text()) === md, 'Markdown : 200, en text/plain, octets exacts (rendu côté client)', res.status);
  ok(res.headers.get('cache-control') === 'no-store', 'texte : no-store', res.headers.get('cache-control'));
  ok(res.headers.get('x-content-type-options') === 'nosniff', 'texte : nosniff', res.headers.get('x-content-type-options'));
  res = await fileGet(`${path.join(D, 'doc.md')}:12`);
  ok(res.status === 200, 'chemin avec numéro de ligne : ouvert');
  res = await fileGet(path.join(D, 'sous-titres.srt'));
  ok(res.status === 200 && /^text\/plain/.test(res.headers.get('content-type')), '.srt : visionneuse');
  for (const n of ['page.html', 'image.svg']) {
    res = await fileGet(path.join(D, n));
    ok(res.status === 200 && /^text\/plain/.test(res.headers.get('content-type')) && /sandbox/.test(res.headers.get('content-security-policy') || ''), `${n} : jamais exécuté, servi en texte`, res.headers.get('content-type'));
  }
  res = await fileGet(path.join(D, 'archive.zip'));
  ok(res.status === 200 && /attachment/.test(res.headers.get('content-disposition') || '') && /octet-stream/.test(res.headers.get('content-type')), 'autre format : téléchargement', res.headers.get('content-disposition'));
  res = await fileGet(path.join(D, 'gros.txt'));
  ok(res.status === 200 && /attachment/.test(res.headers.get('content-disposition') || ''), 'texte au-delà de la limite : téléchargement', res.headers.get('content-disposition'));
  await res.arrayBuffer();
  res = await fileGet(path.join(D, 'doc.md'), '&download=1');
  ok(/attachment/.test(res.headers.get('content-disposition') || '') && res.headers.get('x-content-type-options') === 'nosniff', 'téléchargement demandé : pièce jointe, nosniff');

  section('5b. Chaque refus, sur de vrais fichiers fictifs');
  for (const n of DENIED) {
    res = await fileGet(path.join(D, ...n.split('/')));
    const body = await res.text();
    ok(res.status === 403 && !body.includes(SECRET), `${n} : 403, rien servi`, `${res.status} ${body.slice(0, 120)}`);
  }
  for (const via of [`${D}\\sous\\..\\.env`, `${D}\\.env.`, `${D}\\.env::$DATA`, `${D}\\doc.md::$DATA`, `${D}\\..\\..\\..\\package.json`, path.join(D, 'lien', 'dehors.txt'), path.join(OUT, 'dehors.txt'), '\\\\127.0.0.1\\c$\\Windows\\win.ini', '//127.0.0.1/c$/Windows/win.ini', 'C:\\Windows\\win.ini', 'I:\\psyprofile-data\\seances\\brut\\fictif-inexistant.txt', 'I:\\psyprofile-data\\responses\\fictif-inexistant.json', 'file:///C:/Windows/win.ini', 'doc.md']) {
    res = await fileGet(via);
    const body = await res.text();
    ok(res.status === 403 && !body.includes(SECRET), `refusé : ${via}`, `${res.status} ${body.slice(0, 120)}`);
  }
  res = await fileGet('I:\\psyprofile-data\\seances\\etude\\fictif-inexistant-x7q.md');
  ok(res.status === 404 && (await res.json()).status === 'missing', 'racine autorisée, fichier absent : 404 « missing », pas 403');
  res = await fileGet(path.join(D, 'absent.md'));
  ok(res.status === 404 && res.headers.get('cache-control') === 'no-store', 'absent : 404, no-store');
  res = await fileGet(D);
  ok(res.status === 404 && (await res.json()).status === 'directory', 'dossier : 404, dit « dossier »');
  res = await fetch(`${sb.url}/api/file`, { headers: H });
  ok(res.status === 403, 'sans chemin : refusé', res.status);

  section('5c. /api/media : le lecteur existant, mêmes refus');
  res = await fetch(`${sb.url}/api/media?path=${encodeURIComponent(path.join(D, 'image.png'))}`, { headers: H });
  ok(res.status === 200 && /^image\/png/.test(res.headers.get('content-type')) && res.headers.get('x-content-type-options') === 'nosniff' && Buffer.from(await res.arrayBuffer()).equals(png), 'image autorisée : servie, nosniff');
  for (const n of ['.env.png', '.git/image.png']) {
    res = await fetch(`${sb.url}/api/media?path=${encodeURIComponent(path.join(D, ...n.split('/')))}`, { headers: H });
    ok(res.status === 404 && (await res.text()) === '', `${n} : refusé par /api/media aussi`, res.status);
  }

  section('5d. /api/identify : le panneau de chaque cas');
  r = await identify({ id: path.join(D, 'doc.md') });
  ok(r.known && r.kind === 'fichier' && r.file?.status === 'ok' && r.file.open === 'text', 'chemin autorisé : connu, ouvrable', JSON.stringify(r).slice(0, 300));
  r = await identify({ id: path.join(D, 'absent.md'), kind: 'fichier' });
  ok(r.kind === 'fichier' && r.file?.status === 'missing', 'chemin absent : dit « introuvable »', JSON.stringify(r).slice(0, 300));
  r = await identify({ id: path.join(D, '.env'), kind: 'fichier' });
  ok(r.kind === 'fichier' && r.file?.status === 'refused' && !JSON.stringify(r).includes(SECRET), 'chemin sensible : dit « non autorisé »', JSON.stringify(r).slice(0, 300));
  r = await identify({ id: 'I:\\psyprofile-data\\seances\\brut\\fictif-inexistant.txt' });
  ok(r.file?.status === 'refused', 'arbre protégé : refusé sans regarder le disque', JSON.stringify(r).slice(0, 300));
} finally {
  await sb.stop();
  fs.rmSync(sb.root, { recursive: true, force: true });
  fs.rmSync(T, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
