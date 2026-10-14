#!/usr/bin/env node
// ============================================================================
// scripts/_test_release_groups.mjs — the Release tab groups its items by
// release, and each release opens a detail window (0.98.0)
// ============================================================================
//
// User, verbatim (2026-10-14): « Dans RELEASE, les items doivent etre
// regroupes par release, et chaque release est clickable et ouvrir une fenetre
// qui montre les details de chaque items ».
//
// Protected:
//   1. groupByRelease: one group per ready version, newest first, preceded by
//      the « ⏳ en cours » group (not yet in any version); every item lands in
//      exactly one group, with its index in the flat list; the groups follow
//      the CHANGELOG as it grows;
//   2. /api/release/:project returns those groups (releaseList);
//   3. the tab draws one clickable block per release (a button), and the
//      detail window shows each item in full — HTTP release-groups is not
//      needed (same route), browser release-groups clicks it for real.
//
//   node scripts/_test_release_groups.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from './release-notes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const V = (v, date, sections) => [`## [${v}] - ${date}`, '', ...Object.entries(sections).flatMap(([s, items]) => [`### ${s}`, '', ...items.map(i => `- ${i}`), '']), ''].join('\n');
const doc = (...b) => ['# Changelog', '', ...b].join('\n');

// ---------------------------------------------------------------------------
section('1. Regroupement par release');
{
  const release = { version: '1.0.0', source: 'tag' };
  const base = V('1.0.0', '2026-10-01', { Added: ['publié'] });
  const v11 = V('1.1.0', '2026-10-10', { Added: ['A1', 'A2\n  - détail de A2'], Fixed: ['F1'] });
  let l = R.releaseList({ changelog: doc(v11, base), release });
  ok(l.groups.length === 1 && l.groups[0].version === '1.1.0' && l.groups[0].state === 'ready' && l.groups[0].items.length === 3, 'une release prête = un groupe de 3 éléments', JSON.stringify(l.groups.map(g => [g.key, g.items.length])));
  ok(l.groups[0].date === '2026-10-10' && l.groups[0].sections.join() === 'Added,Fixed', 'le groupe porte sa date et ses sections');

  const unrel = '## [Unreleased]\n\n### Changed\n\n- EN-COURS\n';
  const v12 = V('1.2.0', '2026-10-14', { Security: ['S1'] });
  l = R.releaseList({ changelog: doc(unrel, v12, v11, base), release, todos: [{ status: 'progress', id: 't-1', title: 'TODO-EN-COURS' }] });
  ok(l.groups.map(g => g.key).join() === 'progress,v:1.2.0,v:1.1.0', `ordre : en cours, puis les releases de la plus récente à la plus ancienne (${l.groups.map(g => g.key)})`);
  ok(l.groups[0].items.map(i => i.text).join() === 'EN-COURS,TODO-EN-COURS', 'le groupe « en cours » : [Unreleased] et TODO en cours, hors de toute version');
  const all = l.groups.flatMap(g => g.items.map(i => i.index)).sort((a, b) => a - b);
  ok(all.length === l.items.length && all.every((v, k) => v === k), 'chaque élément est dans exactement un groupe, avec son index dans la liste');
  ok(l.groups.every(g => g.items.every(i => i.text === l.items[i.index].text)), 'l’index renvoie bien au même élément (texte complet pour la fenêtre)');
  ok(!l.groups.some(g => g.version === '1.0.0'), 'la release déjà publiée n’apparaît pas');
  ok(l.groups[2].items.find(i => i.text.startsWith('A2')).text.includes('- détail de A2'), 'le texte complet (sous-points) suit l’élément');
  ok(R.groupByRelease([]).length === 0, 'rien de prêt ni en cours : aucun groupe');
}

// ---------------------------------------------------------------------------
section('2. Serveur et onglet');
{
  const S = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/const list = releaseList\(/.test(S) && /\.\.\.list/.test(S), '/api/release/:projet renvoie la liste complète de releaseList, groupes compris');
  const P = fs.readFileSync(path.join(ROOT, 'public', 'release-panel.js'), 'utf8');
  ok(/class="rl-group-head" data-rl-group=/.test(P) && /<button type="button" class="rl-group-head"/.test(P), 'chaque release est un bouton (clic, Entrée, Espace)');
  ok(/el\.id = "release-overlay"/.test(P) && /role="dialog"/.test(P) && /aria-modal="true"/.test(P), 'fenêtre de détail : dialogue modal');
  ok(/function groupsOf\(d\)/.test(P) && /Array\.isArray\(d\.groups\)/.test(P), 'ancien serveur sans groupes : regroupement côté navigateur');
  const B = fs.readFileSync(path.join(ROOT, 'scripts', '_regression_browser.mjs'), 'utf8');
  ok(/check\(B, 'release-groups'/.test(B), 'parcours navigateur release-groups présent');
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
