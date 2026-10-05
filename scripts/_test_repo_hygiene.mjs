#!/usr/bin/env node
// Exigence utilisateur (0.29.2) : « rien n'apparaisse sur le git, ni dans
// l'historique ». Recette ajoutée en 0.36.0 : rien de sensible n'est suivi par
// git, et .gitignore garde les chemins qui en contiennent. Lecture seule.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };

// Une copie extraite d'un tag (regression.mjs --ref, sous .regress/) n'est pas
// la racine d'un dépôt : git remonterait au dépôt parent et ne verrait rien.
const top = spawnSync('git', ['-C', ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0 || path.resolve(top.stdout.trim()).toLowerCase() !== ROOT.toLowerCase()) {
  console.log('  — pas la racine d\'un dépôt git (copie extraite) : rien à vérifier');
  process.exit(0);
}
const ls = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' });
if (ls.status !== 0) { console.log('  — pas un dépôt git : rien à vérifier'); process.exit(0); }
const files = ls.stdout.split('\0').filter(Boolean);

const FORBIDDEN = [
  [/^logs\/(?!\.gitkeep$)/, 'logs/ (conversations, contenus de fichiers)'],
  [/^\.token$/, '.token (jeton du dashboard)'],
  [/(^|\/)\.env(\.|$)/, '.env'],
  [/^config\.json$/, 'config.json (chemins et projets privés)'],
  [/^secrets\//, 'secrets/'],
  [/^attachments\//, 'attachments/ (pièces jointes)'],
  [/^builds\//, 'builds/ (APK publiés)'],
  [/^docs\/[^/]+\.png$/, 'docs/*.png (captures de l\'UI réelle)'],
  [/^docs\/.*\/captures\//, 'docs/**/captures/'],
  [/^ui-[^/]*\.png$/, 'ui-*.png'],
  [/^android\/[^/]+\.png$/, 'android/*.png'],
  [/\.apk$/, '*.apk'],
  [/^\.regress\//, '.regress/ (instances de test)'],
];
for (const [re, label] of FORBIDDEN) {
  const hit = files.filter(f => re.test(f));
  ok(hit.length === 0, `non suivi : ${label}${hit.length ? ` — ${hit.slice(0, 3).join(', ')}` : ''}`);
}

const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map(s => s.trim());
for (const want of ['logs/*', '.token', '.env', 'secrets/', 'attachments/', 'builds/', 'config.json', '.regress/']) {
  ok(gi.includes(want), `.gitignore contient ${want}`);
}
ok(files.includes('config.example.json'), 'config.example.json versionné à la place de config.json');

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
