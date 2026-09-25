#!/usr/bin/env node
// ============================================================================
// scripts/_test_downloads_hot.mjs — recette du registre /downloads à chaud
// ============================================================================
//
// Prouve qu'on modifie la page /downloads SANS redémarrer le serveur : on
// crée un registre sur un downloads.json temporaire, on rend la page, on
// réécrit le fichier, on rend de nouveau — même instance, même processus.
// Le rendu utilise le VRAI `downloadsPageHtml` (et `escHtml`) extrait de
// server.js : c'est le HTML livré qui est vérifié. Rien n'écrit dans le
// projet (tout vit dans un dossier temporaire), aucun port n'est ouvert.
//
//   node scripts/_test_downloads_hot.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDownloadsRegistry, validateRegistry } from './downloads-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/** Extrait une déclaration top-level de server.js par comptage d'accolades. */
function extractFunction(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} introuvable dans server.js`);
  let depth = 0, i = SRC.indexOf('{', start);
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}
function extractConst(name) {
  const m = new RegExp(`const ${name} = \`[\\s\\S]*?\`;`).exec(SRC);
  if (!m) throw new Error(`const ${name} introuvable`);
  return m[0];
}
// eslint-disable-next-line no-new-func
const downloadsPageHtml = new Function(
  [extractConst('ANDROID_ICON_SVG'), extractConst('DOC_ICON_SVG'),
   extractFunction('escHtml'), extractFunction('downloadsPageHtml'),
   'return downloadsPageHtml;'].join('\n'))();

// ---------- bac à sable -----------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-hot-'));
const FILE = path.join(TMP, 'downloads.json');
const BUILDS = path.join(TMP, 'builds');
const GRADLE = path.join(TMP, 'build.gradle.kts');
fs.mkdirSync(path.join(BUILDS, 'Alpha'), { recursive: true });
fs.writeFileSync(path.join(BUILDS, 'Alpha', 'latest.apk'), 'apk');
fs.writeFileSync(GRADLE, 'android { defaultConfig { versionName = "1.0.0" } }');

let mtimeBump = Date.now() / 1000;
/** Écrit le registre et force un mtime distinct (certains FS ont une
 *  résolution grossière : deux écritures rapprochées auraient le même). */
function write(obj) {
  fs.writeFileSync(FILE, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  mtimeBump += 5;
  fs.utimesSync(FILE, mtimeBump, mtimeBump);
}

const logs = [];
const reg = createDownloadsRegistry({ file: FILE, buildsDir: BUILDS, log: m => logs.push(m) });
const page = () => downloadsPageHtml(reg.entries());

let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const scenario = (n) => console.log(`\n── ${n}`);

// ---------- 1. ajout, modification, retrait à chaud ------------------------

scenario('modifier downloads.json change la page, sans redémarrage');
write({ apps: [{ name: 'Alpha', version: { file: GRADLE } }] });
let html = page();
ok(html.includes('>Alpha<'), 'état initial : la carte Alpha est rendue');
ok(html.includes('v1.0.0'), 'la version vient du gradle');
ok(!html.includes('Beta'), 'Beta absente');

write({ apps: [
  { name: 'Alpha', label: 'Alpha Pro', platform: 'TV', description: 'Traduit <tout> & le reste', version: { file: GRADLE } },
  { name: 'Beta' },
] });
html = page();
ok(html.includes('Alpha Pro'), 'libellé changé à chaud');
ok(html.includes('<span class="app-plat">TV</span>'), 'plateforme changée à chaud');
ok(html.includes('<p class="app-desc">Traduit &lt;tout&gt; &amp; le reste</p>'), 'description affichée, échappée');
ok(html.includes('>Beta<'), 'app ajoutée à chaud');
ok(html.includes('APK pas encore publié') && !html.includes('/downloads/Beta/apk'), 'sans latest.apk : pas de bouton menant à une 404');
ok(reg.findApp('Beta') !== null, 'la route APK connaît Beta immédiatement');

fs.writeFileSync(GRADLE, 'android { defaultConfig { versionName = "2.3.4" } }');
ok(page().includes('v2.3.4'), 'la version du gradle est relue à chaque requête');
fs.mkdirSync(path.join(BUILDS, 'Beta'), { recursive: true });
fs.writeFileSync(path.join(BUILDS, 'Beta', 'latest.apk'), 'apk');
ok(page().includes('/downloads/Beta/apk'), 'la présence de latest.apk est relue à chaque requête');

write({ apps: [{ name: 'Beta' }], docs: [{ project: 'Gamma', id: 'spec', title: 'Spécification', file: 'SPEC.md' }] });
html = page();
ok(!html.includes('Alpha'), 'app retirée à chaud');
ok(reg.findApp('Alpha') === null, 'la route APK ne sert plus Alpha');
ok(html.includes('/downloads/Gamma/doc/spec') && reg.findDoc('Gamma', 'spec'), 'doc ajouté à chaud (carte doc-seul)');

// ---------- 2. repli propre ------------------------------------------------

scenario('JSON invalide ⇒ dernière version valide conservée, erreur journalisée une fois');
const good = page();
logs.length = 0;
write('{ "apps": [ { "name": "Beta" ');
ok(page() === good, 'JSON cassé : la page est inchangée (pas de 500, pas de page vide)');
page(); page();
ok(logs.filter(l => l.includes('JSON invalide')).length === 1, 'l’erreur est journalisée une seule fois, pas à chaque requête');

logs.length = 0;
write({ apps: [{ name: 'Beta' }, { name: '../evil' }] });
ok(page() === good, 'une entrée invalide fait refuser tout le fichier (tout ou rien)');
ok(logs.some(l => l.includes('apps[1].name invalide')), 'le log nomme l’entrée fautive');

write({ apps: [{ name: 'Beta', version: { file: GRADLE, regex: 'x', flags: 'g' } }] });
ok(page() === good, 'flag g refusé (regex réutilisée entre requêtes)');
write({ apps: [{ name: 'Beta', version: { file: GRADLE, regex: 'version' } }] });
ok(page() === good, 'regex sans groupe capturant refusée');
write({ docs: [], apps: [{ name: 'Beta' }, { name: 'Beta' }] });
ok(page() === good, 'doublon refusé');
write({ apps: [], docs: [{ project: 'Gamma', id: 'x', title: 'T', file: '..\\secret.md' }] });
ok(page() === good, 'doc.file avec séparateur refusé (pas de traversée sous builds/)');

fs.rmSync(FILE);
ok(page() === good, 'fichier supprimé : dernière version valide conservée');

write({ apps: [{ name: 'Delta' }] });
ok(page().includes('>Delta<'), 'le fichier corrigé est repris aussitôt');

// ---------- 3. le vrai downloads.json --------------------------------------

scenario('le downloads.json du dépôt est valide');
const real = validateRegistry(JSON.parse(fs.readFileSync(path.join(ROOT, 'downloads.json'), 'utf8')));
ok(!real.errors, real.errors ? real.errors.join(' ; ') : 'aucune erreur de validation');
const to = real.value?.apps.find(a => a.name === 'TranslateOverlay');
ok(to && /Bulle flottante/.test(to.description), 'TranslateOverlay porte sa description');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
