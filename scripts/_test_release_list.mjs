#!/usr/bin/env node
// ============================================================================
// scripts/_test_release_list.mjs — the growing list that leads to the release
// note (0.97.0)
// ============================================================================
//
// User, verbatim (2026-10-14): « Je dois voir comme TODO ou GIT, une liste qui
// augmente au fur et a mesure et qui conduira a la release note en fonction de
// ce qui est pret ». Choices: « 1. changelog / 2. je ne comprends pas,
// l'orchestrateur est sensé connaître sa propre version / 3. langue du
// changelog ».
//
// Protected:
//   1. the CHANGELOG is read as Keep a Changelog (versions, sections, multi-line
//      items, [Unreleased]);
//   2. THE LIST GROWS: a new version, an [Unreleased] entry, a TODO item in
//      progress each add a line; the release note takes ONLY the ready part
//      (versions after the last release), never the in-progress one;
//   3. the last release is found AUTOMATICALLY, without any manual step: the
//      orchestrator's own version for its checkout and its dev instance, the
//      latest v* tag otherwise, none ⇒ every version is ready; « ready » is
//      what stands above the released entry (also for non X.Y.Z headings);
//   4. the note stays in the CHANGELOG's words (no translation): verbatim
//      items, Keep a Changelog section order;
//   5. the dashboard: tab « 📰 Release », read-only routes (HTTP release-list,
//      browser release-panel).
//
//   node scripts/_test_release_list.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as R from './release-notes.mjs';
import { parseTodo } from './todo-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const V = (v, date, sections) => [`## [${v}] - ${date}`, '', ...Object.entries(sections).flatMap(([s, items]) => [`### ${s}`, '', ...items.map(i => `- ${i}`), '']), ''].join('\n');
const doc = (...blocks) => ['# Changelog', '', 'All notable changes…', '', ...blocks].join('\n');

// ---------------------------------------------------------------------------
section('1. Lecture du CHANGELOG (Keep a Changelog)');
{
  const c = R.parseChangelog(doc('## [Unreleased]\n\n### Fixed\n\n- Bug en cours de correction\n',
    V('1.1.0', '2026-10-14', { Added: ['Export CSV\n  - sous-point gardé tel quel'], Fixed: ['Plantage au démarrage'] }),
    V('1.0.0', '2026-10-01', { Added: ['Premier jet'] })));
  ok(c.versions.map(v => v.version).join() === '1.1.0,1.0.0' && c.versions[0].date === '2026-10-14', 'versions et dates, plus récente d’abord');
  ok(c.versions[0].sections.map(s => s.name).join() === 'Added,Fixed', 'sections dans l’ordre du fichier');
  ok(c.versions[0].sections[0].items[0] === 'Export CSV\n- sous-point gardé tel quel', 'un élément garde ses lignes de suite (sous-points)', JSON.stringify(c.versions[0].sections[0].items));
  ok(c.unreleased?.sections[0]?.items[0] === 'Bug en cours de correction', 'section [Unreleased] lue à part');
}

// ---------------------------------------------------------------------------
section('2. La liste s’allonge ; la release note ne reprend que le « prêt »');
{
  const release = { version: '1.0.0', source: 'tag' };
  const base = [V('1.0.0', '2026-10-01', { Added: ['Premier jet publié'] })];
  let l = R.releaseList({ changelog: doc(...base), release });
  ok(l.items.length === 0 && l.note === '', 'juste après la release : liste vide, pas de note');

  const v11 = V('1.1.0', '2026-10-10', { Added: ['PRET-A'], Fixed: ['PRET-B'] });
  l = R.releaseList({ changelog: doc(v11, ...base), release });
  ok(l.items.length === 2 && l.items.every(i => i.state === 'ready' && i.version === '1.1.0'), 'une version livrée : +2 lignes « prêt »');

  const unrel = '## [Unreleased]\n\n### Added\n\n- EN-COURS-CHANGELOG\n';
  const todos = parseTodo('- [~] (2026-10-14 09:00) [fonctionnalite] EN-COURS-TODO <!-- id:t-aaaaaa -->\n- [ ] (2026-10-14 09:00) Pas commencé <!-- id:t-bbbbbb -->\n- [x] (2026-10-13 09:00) Fini → fait (2026-10-13 10:00) par p <!-- id:t-cccccc -->\n', { project: 'p' });
  const l2 = R.releaseList({ changelog: doc(unrel, v11, ...base), release, todos });
  ok(l2.items.length === l.items.length + 2, `entrée [Unreleased] + item TODO en cours : la liste s’allonge (${l.items.length} → ${l2.items.length})`);
  ok(l2.items.filter(i => i.state === 'progress').map(i => i.text).sort().join() === 'EN-COURS-CHANGELOG,EN-COURS-TODO', 'seuls l’[Unreleased] et la TODO « en cours » sont « en cours » (ni le pas commencé, ni le fini)');
  ok(l2.note === l.note, 'l’en-cours ne change pas la release note');

  const v12 = V('1.2.0', '2026-10-14', { Security: ['PRET-C'], Added: ['PRET-D'] });
  const l3 = R.releaseList({ changelog: doc(unrel, v12, v11, ...base), release, todos });
  ok(l3.items.length === l2.items.length + 2 && l3.counts.ready === 4, 'une version de plus : la liste s’allonge encore');
  const n = l3.note;
  ok(['PRET-A', 'PRET-B', 'PRET-C', 'PRET-D'].every(t => n.includes(t)), 'release note : tous les éléments prêts');
  ok(!/EN-COURS|Premier jet publié|Pas commencé|Fini/.test(n), 'release note : rien d’en cours ni de déjà publié', n);
  const order = ['## Added', '## Fixed', '## Security'].map(h => n.indexOf(h));
  ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], 'sections dans l’ordre Keep a Changelog (Added, …, Fixed, Security)');
  ok(n.startsWith('# 1.2.0 - 2026-10-14') && n.includes('> 1.0.0 → 1.1.0 · 1.2.0') && n.includes('- PRET-A _(1.1.0)_'), 'en-tête, versions couvertes, chaque élément avec sa version', n.slice(0, 200));
  ok(!/\b(Since|Depuis)\b/.test(n), 'aucune phrase ajoutée dans une autre langue : le texte reste celui du CHANGELOG');
}

// ---------------------------------------------------------------------------
section('3. Dernière release trouvée automatiquement (aucun marquage à la main)');
{
  const vs = R.parseChangelog(doc(V('0.97.0', '2026-10-14', { Added: ['x'] }), '## [android 0.4.7 / vc12] - 2026-09-11\n\n### Added\n\n- y\n', V('0.96.0', '2026-10-13', { Added: ['z'] }))).versions;
  ok(R.readyVersions(vs, '0.96.0').map(v => v.version).join() === '0.97.0,android 0.4.7 / vc12', 'prêt = ce qui est AU-DESSUS de la version publiée, même un titre non X.Y.Z');
  ok(R.readyVersions(vs, '0.95.0').map(v => v.version).join() === '0.97.0,0.96.0', 'version publiée absente du fichier : comparaison des numéros X.Y.Z');
  ok(R.readyVersions(vs, null).length === 3, 'aucune release repérée : tout est prêt');
  ok(R.compareVersions('0.10.0', '0.9.3') > 0 && R.compareVersions('v1.2.0', '1.2.0') === 0, 'comparaison de versions');

  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-release-'));
  const server = path.join(T, 'orch'), dev = path.join(T, 'orch-dev'), tagged = path.join(T, 'tagged'), bare = path.join(T, 'bare');
  for (const d of [server, dev, tagged, bare]) fs.mkdirSync(d, { recursive: true });
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  fs.writeFileSync(path.join(tagged, 'a.txt'), '1');
  g(tagged, 'init', '-q'); g(tagged, 'add', '-A'); g(tagged, 'commit', '-q', '-m', 'a'); g(tagged, 'tag', 'v2.3.0');
  fs.writeFileSync(path.join(tagged, 'a.txt'), '2'); g(tagged, 'commit', '-qam', 'b');
  const projects = [{ name: 'orchestrateur', path: server }, { name: 'orchestrateur-dev', path: dev, devOf: 'orchestrateur' }, { name: 'tagged', path: tagged }, { name: 'bare', path: bare }];
  const opts = { projects, serverRoot: server, serverVersion: '0.95.0' };
  const r1 = R.lastRelease(projects[0], opts), r2 = R.lastRelease(projects[1], opts), r3 = R.lastRelease(projects[2], opts), r4 = R.lastRelease(projects[3], opts);
  ok(r1.version === '0.95.0' && r1.source === 'server', 'l’orchestrateur : la version qu’il connaît (celle du serveur en service)');
  ok(r2.version === '0.95.0' && r2.source === 'devOf:server', 'son instance de dev : la version en prod', JSON.stringify(r2));
  ok(r3.version === '2.3.0' && r3.source === 'tag' && r3.tag === 'v2.3.0', 'autre projet : son dernier tag v* (même avec des commits après)');
  ok(r4.version === null && r4.source === 'none' && /toutes les versions comptent comme prêtes/.test(r4.label), 'ni tag ni version connue : aucune release, tout est prêt (et c’est dit)');
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
section('4. Le dashboard et le serveur (lecture seule)');
{
  const S = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/app\.get\('\/api\/release'/.test(S) && /app\.get\('\/api\/release\/:project'/.test(S) && !/app\.(post|put|delete)\('\/api\/release/.test(S), 'routes GET seulement');
  ok(/lastRelease\(p, \{ projects: config\.projects \|\| \[\], serverRoot: __dirname, serverVersion: PKG_VERSION \}\)/.test(S), 'le serveur passe SA propre version comme dernière release de l’orchestrateur');
  const P = fs.readFileSync(path.join(ROOT, 'public', 'release-panel.js'), 'utf8');
  const I = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  ok(/id: "release", label: "Release", icon: "📰"/.test(P) && /release-panel\.js/.test(I) && /data-sp-open="release"/.test(I), 'onglet « 📰 Release » du panneau latéral, bouton dans la barre du haut');
  ok(/rl-copy/.test(P) && /rl-download/.test(P) && !/method:\s*"(POST|PUT|DELETE)"/.test(P), 'Copier et Télécharger .md ; le panneau n’écrit rien');
  const B = fs.readFileSync(path.join(ROOT, 'scripts', '_regression_browser.mjs'), 'utf8');
  const H = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
  ok(/check\(B, 'release-panel'/.test(B) && /check\(S, 'release-list'/.test(H), 'parcours navigateur release-panel et HTTP release-list présents');
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
