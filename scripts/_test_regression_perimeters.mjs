#!/usr/bin/env node
// ============================================================================
// scripts/_test_regression_perimeters.mjs — non-regression by perimeter before
// a production jump (0.106.0)
// ============================================================================
//
// User request (2026-10-15, verbatim): « les tests complets de regression
// deviennent beaucoup trop long. Il faut decouper l'ensemble du projet de
// maniere cloisonee, et seul les tests correspondant au perimetre impacte par
// des modifications devront etre lances avant une mise en prod. »
//
// Checks:
//   1. the versioned map is up to date on the real repository: every file and
//      every suite attached, no file in two perimeters, every edge a suite
//      really needs declared (also part of the base: it runs in every run);
//   2. selection on the real map: only the impacted perimeters, with reasons;
//      the FULL run for a transverse file, an unmapped file, package.json
//      beyond its version, --full; never less than the targeted selection;
//   3. checkMap catches an unmapped file / suite, a file in two perimeters, a
//      missing edge, a missing stage (throw-away repository);
//   4. production: a perimeter report is accepted only from the production
//      version and when it ran every expected suite and stage; prod-jump
//      accepts it on throw-away repositories;
//   5. regression.mjs is wired (--perimeters, mode "perimeter" in the report).
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as P from './regression-perimeters.mjs';
import * as T from './regression-targets.mjs';
import { checkProdReport } from './delivery-gate.mjs';
import { preflight } from './prod-jump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1500)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const names = (sel) => (sel.suites || []).map(s => s.file);
const g = (repo, ...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { encoding: 'utf8', windowsHide: true });

// ---------------------------------------------------------------------------
section('1. La carte du dépôt est à jour (chaque fichier, chaque suite, chaque dépendance)');
const { map, files } = P.readState(ROOT);
const v = P.checkMap(map, { repo: ROOT, files });
ok(v.ok, `carte ${P.PERIMETERS_FILE} : ${map.perimeters.length} périmètres, ${files.length} fichiers`,
  `${v.problems.slice(0, 15).join('\n      ')}${v.problems.length > 15 ? `\n      (+${v.problems.length - 15})` : ''}\n      → node scripts/regression-perimeters.mjs check --suggest`);
ok(map.perimeters.length >= 6, `projet découpé en périmètres (${map.perimeters.map(p => p.id).join(', ')})`);
const owners = files.filter(f => /\.(mjs|js|cjs)$/.test(f) && !f.startsWith('android/')).map(f => [f, P.classify(map, f)]);
ok(owners.every(([, c]) => c.kind !== 'unknown' && !(c.kind === 'perimeter' && c.ids.length !== 1)), 'chaque fichier de code a exactement un rattachement (cloisonné)');
ok(P.BASE_SUITES.includes('_test_regression_perimeters.mjs') && T.BASE_SUITES.includes('_test_regression_perimeters.mjs'),
  'ce contrôle est dans le socle des deux modes (par périmètre et ciblé) : une carte périmée échoue partout');

// ---------------------------------------------------------------------------
section('2. Sélection sur la vraie carte');
const sel = (changed, o) => P.selectPerimeters(map, changed, o);
const ui = sel(['public/side-panel.js']);
ok(!ui.full && ui.perimeters.some(p => p.id === 'client' && p.whole) && ui.browser && ui.http && !names(ui).includes('_test_pipeline_gates.mjs'),
  `client web modifié : son périmètre, les étages HTTP et navigateur, pas le moteur (${names(ui).length} suites)`, JSON.stringify(ui.perimeters));
ok(ui.suites.every(s => s.reasons.length) && ui.perimeters.every(p => p.why), 'chaque périmètre et chaque suite retenus portent leur raison');
ok(JSON.stringify(sel(['public/side-panel.js'])) === JSON.stringify(ui), 'même entrée → même sélection');
const docs = sel(['docs/DEV-PROD.md', 'CHANGELOG.md']);
ok(!docs.full && names(docs).every(n => P.BASE_SUITES.includes(n)) && !docs.http && !docs.browser, `documentation seule : le socle seulement (${names(docs).join(', ')})`);
ok(P.BASE_SUITES.every(b => names(docs).includes(b)), 'le socle est toujours exécuté');
for (const f of ['scripts/atomic-file.mjs', 'package-lock.json', 'tests/fake_claude/fake_claude.mjs', '.gitignore']) {
  const s = sel([f, 'public/app.js']);
  ok(s.full && /transverse/.test(s.reason), `${f} (transverse) : COMPLÈTE (« ${s.reason} »)`);
}
const unk = sel(['scripts/brand-new-module.mjs']);
ok(unk.full && /n'appartient à aucun périmètre/.test(unk.reason), `fichier non cartographié : COMPLÈTE, jamais un saut silencieux (« ${unk.reason} »)`);
ok(sel(['public/app.js', 'tools/unknown/X.kt']).full, 'un fichier inconnu parmi d’autres connus : COMPLÈTE');
ok(!sel(['package.json'], { versionOnlyPackage: true }).full && sel(['package.json'], { versionOnlyPackage: false }).full,
  'package.json : version seule → socle ; dépendances ou scripts → COMPLÈTE');
ok(sel(['public/app.js'], { full: true }).full, '--full : COMPLÈTE');
const andr = sel(['android/app/build.gradle.kts']);
ok(!andr.full && andr.outOfScope.length === 1 && names(andr).every(n => P.BASE_SUITES.includes(n)), 'code Android : hors périmètre, raison affichée, pas de complète');
const suiteOnly = sel(['scripts/_test_git_graph.mjs']);
ok(!suiteOnly.full && names(suiteOnly).includes('_test_git_graph.mjs') && names(suiteOnly).length === P.BASE_SUITES.length + 1, 'une suite modifiée : elle seule (plus le socle)');
// t-8dda3e: lanes.mjs runs inside dispatch.mjs — the suites that launch
// dispatch.mjs must run, not only the ones importing lanes.mjs.
const lanes = sel(['scripts/lanes.mjs']);
ok(!lanes.full && ['_test_parallel_lanes.mjs', '_test_pipeline_engine.mjs', '_test_routage_split.mjs', '_test_chef_handoff.mjs'].every(s => names(lanes).includes(s)),
  `lanes.mjs modifié : aussi les suites qui lancent dispatch.mjs (${names(lanes).length} suites)`);
const todoMap = sel(['scripts/git-graph-core.mjs']);
ok(!todoMap.full && names(todoMap).includes('_test_git_graph.mjs') && !todoMap.browser, 'données d’un panneau (git) : ses suites, sans le navigateur');

// Never less than the targeted selection (regression-targets.mjs), suites and stages.
const sample = [...new Set(map.perimeters.flatMap(p => files.filter(f => P.classify(map, f).kind === 'perimeter' && P.classify(map, f).ids[0] === p.id && /\.(mjs|js)$/.test(f)).slice(0, 3)))]
  .concat(['scripts/lanes.mjs', 'scripts/lane-rules.mjs', 'scripts/regression.mjs', 'public/turn-core.js', 'server.js']);
const weaker = [];
for (const f of [...new Set(sample)]) {
  const t = T.selectTargets(ROOT, [f], { files });
  const p = sel([f]);
  if (t.full || p.full) continue;
  const miss = names(t).filter(s => !names(p).includes(s));
  if (miss.length || (t.http && !p.http) || (t.browser && !p.browser)) weaker.push(`${f} : ${miss.join(', ')}${t.http && !p.http ? ' +http' : ''}${t.browser && !p.browser ? ' +navigateur' : ''}`);
}
ok(!weaker.length, `jamais moins que la ciblée (${new Set(sample).size} fichiers témoins, un par périmètre au moins)`, weaker.join('\n      '));

// ---------------------------------------------------------------------------
section('3. Le contrôle de la carte échoue quand elle n’est plus à jour (dépôt jetable)');
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-perimeters-'));
const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(R, f)), { recursive: true }); fs.writeFileSync(path.join(R, f), s); };
put('scripts/a.mjs', 'export const a = 1;\n');
put('scripts/b.mjs', "import { a } from './a.mjs';\nexport const b = a;\n");
put('scripts/_test_a.mjs', "import { a } from './a.mjs';\nconsole.log(a);\n");
put('scripts/_test_b.mjs', "import { b } from './b.mjs';\nconsole.log(b);\n");
for (const b of P.BASE_SUITES) put(`scripts/${b}`, 'console.log(1);\n');
put('README.md', '# r\n');
put('package.json', JSON.stringify({ name: 'r', version: '1.0.0' }, null, 2));
const baseMap = {
  transverse: [{ glob: 'package.json', reason: 'dépendances' }], noTests: [{ glob: '**/*.md', reason: 'doc' }], outOfScope: [],
  perimeters: [
    { id: 'pa', files: ['scripts/a.mjs'], suites: ['_test_a.mjs', ...P.BASE_SUITES], uses: [], stages: [] },
    { id: 'pb', files: ['scripts/b.mjs'], suites: ['_test_b.mjs'], uses: [{ perimeter: 'pa', suites: ['_test_b.mjs'] }], stages: [] },
  ],
};
put(P.PERIMETERS_FILE, JSON.stringify(baseMap, null, 2));
baseMap.perimeters[0].files.push(P.PERIMETERS_FILE);
put(P.PERIMETERS_FILE, JSON.stringify(baseMap, null, 2));
g(R, 'init', '-q'); g(R, 'add', '-A'); g(R, 'commit', '-q', '-m', 'v1'); g(R, 'tag', '-a', 'v1.0.0', '-m', 'v1');
const chk = () => { const s = P.readState(R); return P.checkMap(s.map, { repo: R, files: s.files }); };
ok(chk().ok, 'carte complète : contrôle vert', chk().problems.join(' | '));
put('scripts/c.mjs', 'export const c = 1;\n');
ok(chk().problems.some(p => /scripts\/c\.mjs : rattaché à aucun/.test(p)), 'fichier de code non rattaché : contrôle rouge');
fs.rmSync(path.join(R, 'scripts', 'c.mjs'));
put('scripts/_test_c.mjs', 'console.log(1);\n');
ok(chk().problems.some(p => /_test_c\.mjs : rattaché à aucun/.test(p)), 'suite non rattachée : contrôle rouge');
fs.rmSync(path.join(R, 'scripts', '_test_c.mjs'));
const twice = JSON.parse(JSON.stringify(baseMap)); twice.perimeters[1].files.push('scripts/a.mjs');
put(P.PERIMETERS_FILE, JSON.stringify(twice));
ok(chk().problems.some(p => /scripts\/a\.mjs : dans plusieurs périmètres/.test(p)), 'fichier dans deux périmètres : contrôle rouge (cloisonnement)');
const noEdge = JSON.parse(JSON.stringify(baseMap)); noEdge.perimeters[1].uses = [];
put(P.PERIMETERS_FILE, JSON.stringify(noEdge));
const ne = chk();
ok(ne.missingUses.some(m => m.from === 'pb' && m.to === 'pa' && m.suite === '_test_b.mjs'), 'dépendance manquante (_test_b exécute a.mjs via b.mjs) : contrôle rouge', ne.problems.join(' | '));
ok(JSON.stringify(P.suggestUses(P.readState(R).map, ne.requiredUses).pb) === JSON.stringify([{ perimeter: 'pa', suites: ['_test_b.mjs'] }]), 'check --suggest propose la dépendance à ajouter');
put('server.js', "import { a } from './scripts/a.mjs';\n");
const stageMap = JSON.parse(JSON.stringify(baseMap)); stageMap.perimeters.push({ id: 'srv', files: ['server.js'], suites: [], uses: [], stages: [] });
put(P.PERIMETERS_FILE, JSON.stringify(stageMap));
ok(chk().problems.some(p => /scripts\/a\.mjs est couvert par l'étage HTTP/.test(p)), 'étage manquant (fichier couvert par l’étage HTTP) : contrôle rouge');
fs.rmSync(path.join(R, 'server.js'));
put(P.PERIMETERS_FILE, JSON.stringify(baseMap, null, 2));

// ---------------------------------------------------------------------------
section('4. Mise en prod : par périmètre depuis la version en prod, ou complète');
put('scripts/b.mjs', "import { a } from './a.mjs';\nexport const b = a + 1;\n");
put('README.md', '# r2\n');
put('package.json', JSON.stringify({ name: 'r', version: '1.1.0' }, null, 2));
g(R, 'add', '-A'); g(R, 'commit', '-q', '-m', 'v1.1'); g(R, 'tag', '-a', 'v1.1.0', '-m', 'v1.1');
const plan = P.perimeterPlan({ repo: R, base: 'v1.0.0', target: 'v1.1.0' });
ok(!plan.full && plan.changed.includes('scripts/b.mjs') && plan.perimeters.map(p => p.id).join() === 'pb' && names(plan).includes('_test_b.mjs') && !names(plan).includes('_test_a.mjs'),
  `plan entre deux tags (git diff) : périmètre pb seulement, version seule de package.json ignorée (${names(plan).join(', ')})`, JSON.stringify(plan));
const pa = P.perimeterPlan({ repo: R, base: 'v1.0.0', target: 'v1.1.0', full: true });
ok(pa.full, 'plan --full : COMPLÈTE');
const tree = g(R, 'rev-parse', 'v1.1.0^{tree}').stdout.trim();
const okResults = (list) => list.map(s => ({ id: `suite:${s}`, stage: 'suite', status: 'OK' }));
const rep = { mode: 'perimeter', tree, selection: { baseCommit: plan.baseCommit }, results: okResults(names(plan)) };
ok(checkProdReport(rep, { tree, plan }).ok, 'rapport par périmètre vert, depuis la version en prod, toutes les suites attendues : accepté');
ok(!checkProdReport(rep, { tree }).ok, 'rapport par périmètre sans version en prod connue : refusé');
const other = P.perimeterPlan({ repo: R, base: 'v1.1.0', target: 'v1.1.0' });
ok(!checkProdReport(rep, { tree, plan: other }).ok && /pas depuis la version en prod/.test(checkProdReport(rep, { tree, plan: other }).reasons.join(' ')),
  'rapport fait depuis une autre base que la prod : refusé');
const short = { ...rep, results: okResults(names(plan).filter(s => s !== '_test_b.mjs')) };
ok(/suites attendues non exécutées : _test_b\.mjs/.test(checkProdReport(short, { tree, plan }).reasons.join(' ')), 'suite attendue absente du rapport : refusé');
const fullPlan = P.perimeterPlan({ repo: R, base: 'v1.0.0', target: 'v1.1.0' });
const fullPlanUi = { ...fullPlan, http: true };
ok(/étage HTTP attendu/.test(checkProdReport(rep, { tree, plan: fullPlanUi }).reasons.join(' ')), 'étage attendu non exécuté : refusé');
ok(!checkProdReport({ ...rep, mode: 'targeted' }, { tree, plan }).ok, 'ciblée : toujours refusée pour la prod');
ok(checkProdReport({ mode: 'full', tree, results: okResults(['_test_a.mjs']) }, { tree }).ok, 'complète verte : toujours acceptée');

// prod-jump on throw-away DEV / PROD: PROD is on v1.0.0, the tag is v1.1.0.
const PROD = path.join(os.tmpdir(), `orch-perimeters-prod-${process.pid}`);
fs.rmSync(PROD, { recursive: true, force: true });
spawnSync('git', ['clone', '-q', R, PROD], { windowsHide: true });
g(PROD, 'checkout', '-q', '-B', 'master', 'v1.0.0');
const putReport = (r) => { fs.mkdirSync(path.join(R, '.regress'), { recursive: true }); fs.writeFileSync(path.join(R, '.regress', `report-${Math.random().toString(36).slice(2)}.json`), JSON.stringify(r)); };
let pj = preflight({ dev: R, prod: PROD, tag: 'v1.1.0', from: R });
ok(!pj.ok && /aucune non-régression COMPLÈTE ni PAR PÉRIMÈTRE/.test(pj.problems.join(' ')), 'prod-jump sans rapport : REFUSÉ', pj.problems.join(' | '));
putReport({ ...rep, selection: { baseCommit: g(R, 'rev-parse', 'v1.1.0^{commit}').stdout.trim() } });
pj = preflight({ dev: R, prod: PROD, tag: 'v1.1.0', from: R });
ok(!pj.ok && /pas depuis la version en prod/.test(pj.problems.join(' ')), 'prod-jump avec un rapport par périmètre fait depuis une autre base : REFUSÉ', pj.problems.join(' | '));
putReport(rep);
pj = preflight({ dev: R, prod: PROD, tag: 'v1.1.0', from: R });
// 0.125.0, user rule: no non-regression in production, so none in the plan.
ok(pj.ok && pj.report.mode === 'perimeter' && !pj.plan.some(s => /regression\.mjs/.test(s)) && pj.plan.some(s => /non-régression sur orchestrateur-dev/.test(s)),
  'prod-jump avec le rapport par périmètre vert depuis la prod : mise en prod possible, aucune non-régression dans la prod au plan', pj.problems.join(' | ') + '\n' + pj.plan.join('\n'));
fs.rmSync(PROD, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('5. Branchement dans regression.mjs et dans la procédure de mise en prod');
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
ok(/flag\('--perimeters'\)/.test(src) && /perimeterPlan\(\{ repo: REPO, base: base \|\| 'HEAD', target: source\.ref \|\| null, full: flag\('--full'\) \}\)/.test(src) && /planLines\(plan\)/.test(src),
  'regression.mjs --perimeters : plan calculé (état de travail ou --ref), affiché avec ses raisons');
ok(/const runMode = mode === 'targeted' && selection\.kind === 'perimeter' \? 'perimeter' : mode;/.test(src) && /kind: 'perimeter', base: selection\.base, baseCommit: selection\.baseCommit/.test(src),
  'le rapport porte le mode « perimeter » et la base de la sélection');
const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'regression-perimeters.mjs'), 'select', '--since', 'v1.0.0', '--ref', 'v1.1.0', '--repo', R], { encoding: 'utf8' });
ok(cli.status === 0 && /périmètres retenus/.test(cli.stdout) && /pb — modifié : scripts\/b\.mjs/.test(cli.stdout), 'CLI select : périmètres et suites retenus, avec leur raison', cli.stdout + cli.stderr);
const doc = fs.readFileSync(path.join(ROOT, 'docs', 'DEV-PROD.md'), 'utf8');
ok(/--perimeters --prod/.test(doc), 'docs/DEV-PROD.md : la mise en prod passe par la non-régression par périmètre');

fs.rmSync(R, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
