#!/usr/bin/env node
// Recette du texte lu à voix haute (public/tts.js, partie pure, 0.35.0).
// Le lecteur lui-même (speechSynthesis) est testé dans le navigateur avec une
// doublure : voir le parcours « tts » de _regression_browser.mjs.

import '../public/tts.js';

const T = globalThis.Tts;
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const has = (s, x) => s.includes(x);

console.log('toSpeech');
let s = T.toSpeech('## Résumé\n\nJ\'ai **corrigé** le bug, voir _ce point_.');
ok(s === 'Résumé. J\'ai corrigé le bug, voir ce point.', `titre + emphase : « ${s} »`);
s = T.toSpeech('- étape un\n- étape deux : fini\n1. premier');
ok(s === 'étape un. étape deux : fini. premier.'.replace(' :', ':'), `puces : « ${s} »`);
s = T.toSpeech('Voir [la documentation](https://example.org/doc) et https://github.com/a/b/commit/5bf1dde.');
ok(has(s, 'la documentation') && has(s, 'lien vers github.com') && !has(s, 'http') && !has(s, '5bf1dde'), `liens : « ${s} »`);
s = T.toSpeech('Avant\n```js\nconst secret = "abc";\nconsole.log(secret);\n```\nAprès');
ok(s === 'Avant. (bloc de code). Après.' && !has(s, 'secret'), `bloc de code jamais lu : « ${s} »`);
s = T.toSpeech('Commit 5bf1dde poussé, jeton 9e620f65ea53630e7fe75d268830683b, clé `ui.tts`, code `npm run build --watch`.');
ok(has(s, 'Commit identifiant') && !/[0-9a-f]{7,}/.test(s) && has(s, 'clé ui.tts') && has(s, 'code code'), `identifiants et code en ligne : « ${s} »`);
s = T.toSpeech('Fichier I:\\Dev\\Chef\\CLAUDE.md, route /api/ack/:project, outils Read/Edit/Write.');
ok(has(s, 'chemin CLAUDE.md') && has(s, 'chemin project') && has(s, 'Read/Edit/Write'), `chemins : « ${s} »`);
s = T.toSpeech('| Table | Lignes | Statut |\n|---|---|---|\n| users | 1200 | ok |\n| orders | 98000 | ok |');
ok(s === 'Tableau de 2 lignes, colonnes: Table, Lignes, Statut. users, 1200, ok. orders, 98000, ok.', `tableau court lu : « ${s} »`);
const big = '| a | b |\n|---|---|\n' + Array.from({ length: 12 }, (_, i) => `| x${i} | y${i} |`).join('\n');
s = T.toSpeech(big);
ok(s === 'Tableau de 12 lignes, colonnes: a, b.', `grand tableau annoncé seulement : « ${s} »`);
s = T.toSpeech('Fait ✓ → suite ⇄ chef 🎉\nNEEDS_USER_INPUT: on publie ?');
ok(!/[✓→⇄🎉]/u.test(s) && has(s, 'vers suite') && has(s, 'Question') && has(s, 'on publie'), `symboles et question : « ${s} »`);
ok(T.toSpeech('') === '' && T.toSpeech(null) === '', 'vide');

console.log('chunks');
const long = Array.from({ length: 30 }, (_, i) => `Phrase numéro ${i} avec un peu de contenu, et une virgule.`).join(' ');
const c = T.chunks(long, 220);
ok(c.length > 1 && c.every(x => x.length <= 220), `≤ 220 caractères (${c.length} morceaux, max ${Math.max(...c.map(x => x.length))})`);
ok(c.join(' ') === long, 'rien de perdu ni ajouté');
ok(c.every(x => /[.]$/.test(x)), 'coupé aux fins de phrase');
const one = 'mot '.repeat(120).trim();
const c2 = T.chunks(one, 100);
ok(c2.every(x => x.length <= 101) && c2.join(' ') === one, 'phrase sans ponctuation : coupée aux espaces');
ok(T.chunks('Voir github.com et CLAUDE.md. Fin.', 220).length === 1 && T.chunks('Voir github.com et CLAUDE.md. Fin.', 25)[0] === 'Voir github.com et', 'un point sans espace (domaine, fichier) n\'est pas une fin de phrase');

console.log('guessLang');
ok(T.guessLang('The build is green and the tests pass, you can deploy it now.') === 'en', 'anglais');
ok(T.guessLang('Le build est vert et les tests passent, tu peux déployer.') === 'fr', 'français');
ok(T.guessLang('Le commit fix the build est poussé sur la branche.') === 'fr', 'mélange : français par défaut');

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
