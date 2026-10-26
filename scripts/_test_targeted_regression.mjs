#!/usr/bin/env node
// ============================================================================
// scripts/_test_targeted_regression.mjs — targeted run in development, full
// run required for production (0.72.0)
// ============================================================================
//
// User request (2026-10-11, verbatim): « Implemente une Non-régression ciblée
// pendant le développement, et la complète seulement avant une mise en prod ».
//
// Checks:
//   - the selection is deterministic and follows the changed files: an engine
//     change selects the engine suites, not unrelated ones; docs only → the
//     base; a file covered by nothing, or the runner itself → the FULL run;
//     public/** → the browser stage; the base always runs;
//   - regression.mjs runs only the selected suites/stages and records the
//     mode (full | targeted | partial) and the selection with its reasons;
//   - production: prod-check and prod-jump refuse a targeted/partial run, a
//     KO, a report made on another tree, a dirty production, a running turn;
//     a full green run on the tag lets prod-jump fast-forward production
//     (throw-away repositories only).
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as T from './regression-targets.mjs';
import { checkProdReport, checkReport } from './delivery-gate.mjs';
import { preflight, applyJump } from './prod-jump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const names = (sel) => (sel.suites || []).map(s => s.file);

// ---------------------------------------------------------------------------
section('1. Sélection ciblée, déterministe, sur le vrai dépôt');
const files = T.repoFiles(ROOT);
const eng = T.selectTargets(ROOT, ['scripts/pipeline-engine.mjs'], { files });
ok(!eng.full && names(eng).includes('_test_pipeline_engine.mjs') && names(eng).includes('_test_routage_split.mjs') && !names(eng).includes('_test_tts_text.mjs'),
  `moteur modifié : ses suites (${names(eng).length}), pas les suites sans rapport`);
ok(eng.suites.find(s => s.file === '_test_pipeline_engine.mjs').reasons.some(r => /pipeline-engine\.mjs/.test(r)), 'chaque suite retenue porte sa raison');
ok(JSON.stringify(T.selectTargets(ROOT, ['scripts/pipeline-engine.mjs'], { files })) === JSON.stringify(eng), 'même entrée → même sélection');
const docs = T.selectTargets(ROOT, ['docs/ROUTAGE-PROBLEMES.md', 'CHANGELOG.md'], { files });
ok(!docs.full && names(docs).every(n => T.BASE_SUITES.includes(n)) && !docs.http && !docs.browser, `documentation seule : le socle seulement (${names(docs).join(', ')})`);
ok(T.BASE_SUITES.every(b => names(docs).includes(b) || !files.includes(`scripts/${b}`)), 'le socle est toujours exécuté');
const UNCOVERED = 'tools/uncovered/Fixture.kt';   // covered by nothing, outside android/
const unk = T.selectTargets(ROOT, [UNCOVERED], { files });
ok(unk.full && /n'est couvert par aucune suite/.test(unk.reason), `fichier non couvert : COMPLÈTE (« ${unk.reason} »)`);
// 0.73.2, user decision (2026-10-12): « Dissocier les code Android des tests, vu
// qu'aucun ne lui correspondent » — android/ is outside the non-regression scope.
const andr = T.selectTargets(ROOT, ['android/app/src/main/java/X.kt', 'android/app/build.gradle.kts'], { files });
ok(!andr.full && names(andr).every(n => T.BASE_SUITES.includes(n)) && !andr.http && !andr.browser,
  `code Android : PAS la complète, aucune suite au-delà du socle (${andr.full ? andr.reason : names(andr).join(', ')})`);
ok(andr.outOfScope?.length === 2 && andr.outOfScope.every(o => /code Android : hors périmètre de la non-régression/.test(o.reason)),
  'code Android : raison explicite pour chaque fichier (« hors périmètre de la non-régression »)', JSON.stringify(andr.outOfScope));
const andrMix = T.selectTargets(ROOT, ['android/app/src/main/java/X.kt', 'scripts/pipeline-engine.mjs'], { files });
ok(!andrMix.full && names(andrMix).includes('_test_pipeline_engine.mjs'), 'Android + un fichier couvert : seulement les suites du fichier couvert');
ok(T.selectTargets(ROOT, ['android/x.kt', UNCOVERED], { files }).full, 'Android + un fichier couvert par rien : la complète, comme avant (règle inchangée)');
const rsrc = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
ok(/for \(const o of sel\.outOfScope \|\| \[\]\) console\.log/.test(rsrc), 'regression.mjs --targeted affiche la raison des fichiers hors périmètre');
// 0.73.0, user decision "B" (2026-10-12): a change to the non-regression
// tooling runs the suites that cover it, never the full run.
const run = T.selectTargets(ROOT, ['scripts/regression.mjs'], { files });
ok(!run.full && T.TOOLING_SUITES.every(s => names(run).includes(s)) && run.http && !names(run).includes('_test_tts_text.mjs'),
  `regression.mjs modifié : PAS la complète, les suites de l’outillage (${T.TOOLING_SUITES.join(', ')}) + l’étage HTTP qu’il définit`, run.reason);
ok(run.suites.find(s => s.file === '_test_failed_suite_output.mjs').reasons.some(r => /outillage de la non-régression : scripts\/regression\.mjs/.test(r)), 'la raison du choix est donnée');
for (const tf of ['scripts/regression-targets.mjs', 'scripts/suite-runner.mjs', 'scripts/delivery-gate.mjs', 'scripts/prod-jump.mjs']) {
  const s = T.selectTargets(ROOT, [tf], { files });
  ok(!s.full && T.TOOLING_SUITES.every(x => names(s).includes(x)) && !s.browser, `${tf} modifié : suites de l’outillage, pas la complète (${s.full ? s.reason : names(s).length + ' suites'})`);
}
ok(names(T.selectTargets(ROOT, ['scripts/suite-runner.mjs'], { files })).includes('_test_failed_suite_output.mjs') && names(T.selectTargets(ROOT, ['scripts/regression-targets.mjs'], { files })).includes('_test_targeted_regression.mjs'),
  'chaque fichier d’outillage sélectionne au moins la suite qui l’exerce');
const lock = T.selectTargets(ROOT, ['package-lock.json'], { files });
ok(lock.full && /dépendances/.test(lock.reason), 'package-lock.json (dépendances) : toujours la complète');
const mix = T.selectTargets(ROOT, ['scripts/regression.mjs', UNCOVERED], { files });
ok(mix.full && /tools\/uncovered/.test(mix.reason), 'outillage + un fichier couvert par rien : la complète, comme avant');
const ui = T.selectTargets(ROOT, ['public/app.js'], { files });
ok(!ui.full && ui.browser && ui.http, 'public/** : étages HTTP et navigateur');
const graph = T.referenceGraph(ROOT, files);
const suites = files.filter(f => /^scripts\/_test_[^/]+\.mjs$/.test(f));
ok(suites.every(s => T.coverageOf(graph, s).has(s)), `chaque suite (${suites.length}) se couvre au moins elle-même : la modifier la relance`);

// ---------------------------------------------------------------------------
section('2. Fichiers modifiés et package.json (dépôt jetable)');
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-targets-'));
const g = (repo, ...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { encoding: 'utf8', windowsHide: true });
fs.mkdirSync(path.join(R, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(R, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0', dependencies: { a: '1' } }, null, 2));
fs.writeFileSync(path.join(R, 'scripts', 'lib.mjs'), 'export const x = 1;\n');
fs.writeFileSync(path.join(R, 'scripts', '_test_lib.mjs'), "import { x } from './lib.mjs';\nconsole.log(x);\n");
fs.writeFileSync(path.join(R, 'scripts', 'other.mjs'), 'export const y = 2;\n');
g(R, 'init', '-q'); g(R, 'add', '-A'); g(R, 'commit', '-q', '-m', 'init');
fs.writeFileSync(path.join(R, 'scripts', 'lib.mjs'), 'export const x = 3;\n');
fs.writeFileSync(path.join(R, 'scripts', 'new.mjs'), 'export const z = 1;\n');
const ch = T.changedFiles(R);
ok(ch.includes('scripts/lib.mjs') && ch.includes('scripts/new.mjs'), `modifiés + non suivis : ${ch.join(', ')}`);
const s2 = T.selectTargets(R, ['scripts/lib.mjs']);
ok(!s2.full && names(s2).includes('_test_lib.mjs'), 'lib.mjs → la suite qui l’importe');
ok(T.selectTargets(R, ['scripts/other.mjs']).full, 'other.mjs, testé par personne → COMPLÈTE');
fs.writeFileSync(path.join(R, 'package.json'), JSON.stringify({ name: 'r', version: '1.1.0', dependencies: { a: '1' } }, null, 2));
ok(T.versionOnlyPackageChange(R) && !T.selectTargets(R, ['package.json']).full, 'package.json : seule la version change → pas de complète');
fs.writeFileSync(path.join(R, 'package.json'), JSON.stringify({ name: 'r', version: '1.1.0', dependencies: { a: '2' } }, null, 2));
ok(T.selectTargets(R, ['package.json']).full, 'package.json : une dépendance change → COMPLÈTE');

// ---------------------------------------------------------------------------
section('3. regression.mjs : seulement les suites/étages retenus, mode et sélection dans le rapport');
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
ok(/flag\('--targeted'\)/.test(src) && /if \(targeted && !targeted\.has\(f\)\) continue;/.test(src) && /const runHttp = !narrowed \|\| selection\.http;/.test(src) && /const runBrowser = /.test(src),
  'filtre des suites et des étages branché sur la sélection');
ok(/const mode = narrowed \? 'targeted' : \(flag\('--no-suites'\) \|\| flag\('--no-browser'\)\) \? 'partial' : 'full';/.test(src) && /selection: \{ since: selection\.since/.test(src), 'le rapport porte le mode et la sélection');

// ---------------------------------------------------------------------------
section('4. Mise en prod : la COMPLÈTE verte est exigée');
const GREEN = [{ id: 'suite:_test_a.mjs', status: 'OK' }];
const RED = [...GREEN, { id: 'suite:_test_b.mjs', status: 'KO', detail: 'exit 1' }];
ok(!checkProdReport({ mode: 'targeted', tree: 't', results: GREEN }, { tree: 't' }).ok, 'ciblée verte : refusée pour la prod');
ok(!checkProdReport({ mode: 'partial', tree: 't', results: GREEN }, { tree: 't' }).ok, 'partielle (--no-browser…) : refusée');
ok(!checkProdReport({ mode: 'full', tree: 't', results: RED }, { tree: 't' }).ok, 'complète avec un KO : refusée');
ok(!checkProdReport({ mode: 'full', tree: 'x', results: GREEN }, { tree: 't' }).ok, 'complète faite sur un autre contenu : refusée');
ok(checkProdReport({ mode: 'full', tree: 't', results: GREEN }, { tree: 't' }).ok, 'complète verte sur ce contenu : acceptée');

// prod-jump on two throw-away repositories: DEV (with a tag) and PROD (a clone, behind).
const DEV = path.join(R, 'dev'), PROD = path.join(R, 'prod');
fs.mkdirSync(DEV, { recursive: true });
fs.writeFileSync(path.join(DEV, '.gitignore'), '.regress/\nlogs/\n');
fs.writeFileSync(path.join(DEV, 'a.txt'), 'v1\n');
g(DEV, 'init', '-q'); g(DEV, 'add', '-A'); g(DEV, 'commit', '-q', '-m', 'v1');
spawnSync('git', ['clone', '-q', DEV, PROD], { windowsHide: true });
fs.writeFileSync(path.join(DEV, 'a.txt'), 'v2\n'); g(DEV, 'add', '-A'); g(DEV, 'commit', '-q', '-m', 'v2'); g(DEV, 'tag', '-a', 'v2.0.0', '-m', 'v2');
const tree = g(DEV, 'rev-parse', 'v2.0.0^{tree}').stdout.trim();
const putReport = (rep) => { fs.mkdirSync(path.join(DEV, '.regress'), { recursive: true }); fs.writeFileSync(path.join(DEV, '.regress', `report-${Math.random().toString(36).slice(2)}.json`), JSON.stringify(rep)); };
let p = preflight({ dev: DEV, prod: PROD, tag: 'v2.0.0', from: DEV });
ok(!p.ok && /aucune non-régression COMPLÈTE/.test(p.problems.join(' ')), 'prod-jump sans complète : REFUSÉ', p.problems.join(' | '));
putReport({ mode: 'targeted', tree, results: GREEN });
p = preflight({ dev: DEV, prod: PROD, tag: 'v2.0.0', from: DEV });
ok(!p.ok, 'prod-jump avec seulement une ciblée verte : REFUSÉ');
putReport({ mode: 'full', tree, results: GREEN });
fs.mkdirSync(path.join(PROD, 'logs'), { recursive: true }); fs.writeFileSync(path.join(PROD, 'logs', 'orchestrateur.turnlock'), '123');
p = preflight({ dev: DEV, prod: PROD, tag: 'v2.0.0', from: DEV });
ok(!p.ok && /tour de l'orchestrateur est en cours/.test(p.problems.join(' ')), 'tour en cours dans la prod : REFUSÉ');
fs.rmSync(path.join(PROD, 'logs'), { recursive: true, force: true });
fs.writeFileSync(path.join(PROD, 'a.txt'), 'local edit\n');
p = preflight({ dev: DEV, prod: PROD, tag: 'v2.0.0', from: DEV });
ok(!p.ok && /modifications non commitées/.test(p.problems.join(' ')), 'prod modifiée : REFUSÉ');
g(PROD, 'checkout', '-q', '--', 'a.txt');
p = preflight({ dev: DEV, prod: PROD, tag: 'v2.0.0', from: DEV });
ok(p.ok, 'complète verte sur le tag, prod propre et libre : mise en prod possible', p.problems.join(' | '));
const j = applyJump({ prod: PROD, tag: 'v2.0.0', from: DEV });
ok(j.ok && g(PROD, 'rev-parse', 'HEAD').stdout.trim() === g(DEV, 'rev-parse', 'v2.0.0^{commit}').stdout.trim() && g(PROD, 'rev-parse', '-q', '--verify', 'prod-before-v2.0.0').status === 0,
  'avance rapide de la prod sur le tag, avec le tag de retour prod-before-v2.0.0', JSON.stringify(j));
const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'prod-jump.mjs'), '--tag', 'v9.9.9', '--prod', PROD], { encoding: 'utf8', cwd: ROOT });
ok(cli.status === 1 && /MISE EN PROD REFUSÉE/.test(cli.stderr), 'CLI : tag inconnu ou sans complète → refus, code 1');

// ---------------------------------------------------------------------------
section('Plafond de la sélection ciblée (cas réel p-20261026T090638-774755)');
// User request (2026-10-26): a change of scripts/idle-regression.mjs selected
// 69 suites and each targeted pass took 20-30 min. In the idle-time policy
// (noFull) only suites that import or name the file directly (and its dedicated
// tests) are kept, capped; what is dropped is logged, never silent.
const IDLE = 'scripts/idle-regression.mjs';
const idle = T.selectTargets(ROOT, [IDLE], { files, noFull: true });
const MAX_TARGETED = 15;
ok(names(idle).length <= MAX_TARGETED, `idle-regression.mjs : au plus ${MAX_TARGETED} suites ciblées`, `${names(idle).length} suites sélectionnées`);
ok(Array.isArray(idle.dropped) && idle.dropped.length > 0 && idle.dropped.every(d => d.file && d.reason),
  'les suites écartées sont journalisées (file + reason), pas de troncature silencieuse', JSON.stringify(idle.dropped));
const idleGraph = T.referenceGraph(ROOT, files);
const direct = (n) => { const g = idleGraph.get(`scripts/${n}`); return !!g && (g.mentions.has(IDLE) || g.imports.has(IDLE)); };
const transitive = names(idle).filter(n => !T.BASE_SUITES.includes(n) && !direct(n) && !n.startsWith('_test_idle_regression'));
ok(!transitive.length, 'seulement des suites qui nomment ou importent directement le fichier (ou son test dédié)', transitive.join(', '));
ok(names(idle).includes('_test_idle_regression.mjs'), 'le test dédié du fichier est gardé');
const wide = T.selectTargets(ROOT, [IDLE], { files });
ok(!wide.dropped.length && names(wide).length > names(idle).length, 'sans noFull, rien n’est écarté (la complète a posteriori n’existe pas pour ce projet) : comportement d’avant');
const sum = T.selectionSummary(idle);
ok(sum.dropped?.length === idle.dropped.length && sum.suites.length === idle.suites.length, 'le rapport garde les suites écartées (selection.dropped)');
ok(T.selectionLines(idle).length === idle.dropped.length && T.selectionLines(idle).every(l => /plafond|transitive/.test(l)), 'la console imprime chaque suite écartée avec sa raison');
const regSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
ok(/RT\.selectionLines\(sel\)/.test(regSrc) && /RT\.selectionSummary\(selection\)/.test(regSrc), 'regression.mjs imprime et enregistre la sélection via selectionLines / selectionSummary (contrôle statique du source : un renommage le casse sans défaut réel)');

section('Délai dépassé : bilan explicite (jamais « code null / aucun KO »)');
const dl = (o) => T.targetedDeadlineMin({ targeted: true, ...o });
ok(dl({ noFull: true }) === 25 && dl({ noFull: true }) === T.DEFAULT_TARGETED_DEADLINE_MIN, 'sous noFull (--no-full / ORCH_UNIT_DELIVERY=1) : délai par défaut de 25 min');
ok(dl({ noFull: false }) === null && dl({}) === null, 'sans noFull : aucun délai par défaut (sélection non plafonnée, un passage long mais sain n’est pas coupé)');
ok(dl({ noFull: false, timeoutMin: '40' }) === 40 && dl({ noFull: true, timeoutMin: '40' }) === 40, '--timeout-min explicite : valable avec ou sans noFull');
ok(dl({ noFull: false, envMin: '30' }) === 30 && dl({ noFull: true, timeoutMin: '10', envMin: '30' }) === 10, 'ORCH_REGRESS_TIMEOUT_MIN explicite ; --timeout-min prime');
ok(dl({ noFull: true, timeoutMin: 'abc', envMin: '0' }) === 25 && dl({ noFull: false, timeoutMin: '-5' }) === null, 'valeur invalide ou nulle : comme si absente');
ok(T.targetedDeadlineMin({ targeted: false, noFull: true, timeoutMin: '40' }) === null, 'sans --targeted : jamais de délai');
ok(/RT\.targetedDeadlineMin\(/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8')), 'regression.mjs utilise targetedDeadlineMin de regression-targets.mjs (contrôle statique du branchement : un renommage le casse sans défaut réel)');
const bilan = T.timeoutBilan({ planned: ['_a.mjs', '_b.mjs', '_c.mjs', '_d.mjs'], limitMin: 25, results: [
  { stage: 'suite', name: '_a.mjs', status: 'OK' }, { stage: 'suite', name: '_b.mjs', status: 'KO' }, { stage: 'http', name: 'x', status: 'OK' }] });
ok(bilan.passed.join() === '_a.mjs' && bilan.failed.join() === '_b.mjs' && bilan.notRun.join() === '_c.mjs,_d.mjs', 'suites passées, échouées et non jouées');
const tl = T.timeoutLines(bilan).join(' | ');
ok(/DÉLAI DÉPASSÉ \(25 min\)/.test(tl) && /1 suite\(s\) passée/.test(tl) && /_b\.mjs/.test(tl) && /_c\.mjs, _d\.mjs/.test(tl), 'le message nomme la limite et les trois listes', tl);
ok(/abortTimeout/.test(regSrc) && /TIMEOUT_EXIT = 5/.test(regSrc) && /--timeout-min/.test(regSrc) && /ORCH_REGRESS_TIMEOUT_MIN/.test(regSrc), 'regression.mjs : surveillance du délai (--timeout-min, ORCH_REGRESS_TIMEOUT_MIN), sortie 5 (contrôle statique du source : un renommage le casse sans défaut réel)');
const gated = checkReport({ results: [], timeout: { limitMin: 25, notRun: ['_c.mjs'] } });
ok(!gated.ok && gated.reasons.some(r => /délai dépassé/.test(r)), 'un rapport « délai dépassé » est refusé à la livraison');

fs.rmSync(R, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
