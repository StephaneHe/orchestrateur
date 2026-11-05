#!/usr/bin/env node
// ============================================================================
// scripts/_test_release_tree_check.mjs — a release writes its CHANGELOG link
// reference, and its tests run on the FINAL tree before the commit (0.164.1)
// ============================================================================
//
// User, 2026-11-05, verbatim: « corrige le problème de l'orchestrateur » — one
// project went red twice from the delivery itself: release X (Livrer by the
// program, paused) and release Y (lane fragments assembled at integration,
// delivered red, nothing ran on the final tree). Both wrote the `## [X.Y.Z]`
// header without the `[X.Y.Z]: ./` line its release test requires.
//
// Permanent requirement test, on temporary git repositories with the real
// writers and real test runs:
//   1. reference line: same format, right place; none in a project without any;
//   2. the two real writers (program delivery, prebump, lane fragments);
//   3. replay of the real case: the test reading CHANGELOG is selected AND run
//      on the final tree (proof written by the test itself), integration green;
//   4. selection: readers only; none ⇒ nothing runs; vitest; whole-suite fallback;
//   5. final tree red ⇒ delivery refused, no commit, work kept (program, lane);
//   6. what a test leaves in the tree never enters the release commit.
//
//   node scripts/_test_release_tree_check.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withVersionLink, missingVersionLink } from './changelog-links.mjs';
import { deliverRelease } from './code-delivery.mjs';
import { releaseCheckPlan, runReleaseTreeCheck } from './release-tree-check.mjs';
import * as lanes from './lanes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-release-tree-'));
const LOGS = path.join(T, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
process.env.ORCH_SUITE_LOCK_DIR = path.join(T, 'locks');
const g = (dir, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: dir, encoding: 'utf8' });
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const version = (dir) => JSON.parse(read(dir, 'package.json')).version;
const head = (dir) => g(dir, 'rev-parse', 'HEAD').stdout.trim();

// The real project's changelog shape, just before the release that went red.
const CL_REFS = '# Changelog\n\n## [Unreleased]\n\n## [1.15.2] - 2026-11-02\n\n### Fixed\n\n- earlier\n\n## [1.15.1] - 2026-11-02\n\n### Fixed\n\n- older\n\n[Unreleased]: ./\n[1.15.2]: ./\n[1.15.1]: ./\n';
const CL_NONE = '# Changelog\n\n## [Unreleased]\n\n## [1.15.2] - 2026-11-02\n\n### Fixed\n\n- earlier\n';
// The real release test's assertion; `extra` makes it red on the final tree only.
const releaseTest = (proof, extra = '') => `import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
const cl = fs.readFileSync('CHANGELOG.md', 'utf8');
const v = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
fs.appendFileSync(${JSON.stringify(proof)}, v + '\\n');
fs.writeFileSync('generated-by-test.txt', 'x');
test('every CHANGELOG release header has a matching link reference', () => {
  const headers = [...cl.matchAll(/^## \\[([^\\]]+)\\]/gm)].map(m => m[1]);
  const links = new Set([...cl.matchAll(/^\\[([^\\]]+)\\]: /gm)].map(m => m[1]));
  assert.deepStrictEqual(headers.filter(h => !links.has(h)), []);
  ${extra}
});
`;
const OTHER_TEST = (proof) => `import { test } from 'node:test';\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(proof)}, 'other\\n');\ntest('unrelated', () => {});\n`;
const CFG = { testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md' };
const TEXT = { bump: 'patch', changelog: '### Fixed\n\n- the fix', requirement: '' };

let seq = 0;
function makeRepo({ changelog = CL_REFS, files = {}, cfg = CFG } = {}) {
  const name = `R${++seq}`;
  const dir = path.join(T, name);
  write(dir, 'package.json', JSON.stringify({ name: name.toLowerCase(), version: '1.15.2', type: 'module' }, null, 2) + '\n');
  write(dir, 'CHANGELOG.md', changelog);
  write(dir, 'src.txt', 'one\n');
  write(dir, '.orchestrateur/pipeline.json', JSON.stringify(cfg));
  write(dir, '.gitignore', 'node_modules\n');
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  g(dir, 'init', '-q', '-b', 'master'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return { name, path: dir };
}
async function laneTask(project, title = 'Tâche') {
  const { dir } = await lanes.ensureLane({ root: T, project, k: 1, trust: false });
  const task = `t-${++seq}`;
  lanes.startTask({ logsDir: LOGS, project, k: 1, dir, task, turn: `turn-${seq}`, title });
  write(dir, 'work.txt', 'the task\n');
  write(dir, `changelog.d/${task}.md`, '---\nbump: patch\n---\n\n### Added\n\n- the feature\n');
  return { dir, task, title };
}
const finish = (project, t) => {
  const events = [];
  return { ...lanes.finishTask({ logsDir: LOGS, project, k: 1, dir: t.dir, turnEnd: 'done', title: t.title, log: (e) => events.push(e), waitMs: 5000 }), events };
};
const proofOf = (name) => path.join(T, `proof-${name}-${++seq}.txt`);
const readProof = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

// ---------------------------------------------------------------------------
section('1. La ligne de référence : même format, bonne place ; aucune sans références');
{
  const out = withVersionLink(CL_REFS, '1.15.3');
  ok(out.endsWith('[Unreleased]: ./\n[1.15.3]: ./\n[1.15.2]: ./\n[1.15.1]: ./\n'), 'format réel « ./ » : entre [Unreleased] et la version précédente', out);
  ok(withVersionLink(out, '1.15.3') === out, 'déjà présente : texte inchangé');
  ok(withVersionLink(CL_NONE, '1.15.3') === CL_NONE, 'projet sans références : rien ajouté');
  ok(withVersionLink('# C\n\n[Keep]: https://k\n[Unreleased]: ./\n', '1.0.0') === '# C\n\n[Keep]: https://k\n[Unreleased]: ./\n', 'un autre lien ou [Unreleased] seul ne sont pas des références de version');
  const cmp = withVersionLink('[Unreleased]: https://g/compare/v1.2.3...HEAD\n[1.2.3]: https://g/compare/v1.2.2...v1.2.3\n[1.2.2]: https://g/compare/v1.2.1...v1.2.2\n', '1.2.4');
  ok(cmp === '[Unreleased]: https://g/compare/v1.2.4...HEAD\n[1.2.4]: https://g/compare/v1.2.3...v1.2.4\n[1.2.3]: https://g/compare/v1.2.2...v1.2.3\n[1.2.2]: https://g/compare/v1.2.1...v1.2.2\n', 'URL de comparaison : les deux bornes suivent, [Unreleased] aussi', cmp);
  ok(withVersionLink('[1.2.3]: https://g/releases/tag/v1.2.3\n', '1.3.0') === '[1.3.0]: https://g/releases/tag/v1.3.0\n[1.2.3]: https://g/releases/tag/v1.2.3\n', 'URL de tag');
  ok(withVersionLink('[1.0.0]: ./a\n[1.1.0]: ./b\n', '1.2.0') === '[1.0.0]: ./a\n[1.1.0]: ./b\n[1.2.0]: ./b\n', 'références du plus ancien au plus récent : ajoutée en dernier');
  ok(withVersionLink('[1.0.0]: ./\r\nfin\r\n', '1.0.1') === '[1.0.1]: ./\r\n[1.0.0]: ./\r\nfin\r\n', 'fins de ligne CRLF gardées');
  ok(missingVersionLink(CL_REFS, '1.15.3') && !missingVersionLink(out, '1.15.3') && !missingVersionLink(CL_NONE, '1.15.3'), 'missingVersionLink : seulement un projet avec références, sans la ligne');
}

// ---------------------------------------------------------------------------
section('2. Les deux écritures réelles de l’en-tête');
{
  const A = makeRepo();
  const d = deliverRelease(A.path, CFG, TEXT, { date: '2026-11-05', run: 'p-t' });
  ok(d.ok && d.version === '1.15.3' && /^\[1\.15\.3\]: \.\/$/m.test(g(A.path, 'show', 'HEAD:CHANGELOG.md').stdout), `livraison par le programme : ligne dans le commit (${d.version})`, d.why);
  const B = makeRepo({ changelog: CL_NONE });
  const d2 = deliverRelease(B.path, CFG, TEXT, { date: '2026-11-05', run: 'p-t' });
  ok(d2.ok && !/^\[/m.test(read(B.path, 'CHANGELOG.md')), 'livraison, projet sans références : aucune ligne', read(B.path, 'CHANGELOG.md'));
  const C = makeRepo({ changelog: CL_REFS.replace('## [1.15.2]', '## [1.15.3] - 2026-11-05\n\n### Fixed\n\n- x\n\n## [1.15.2]') });
  write(C.path, 'package.json', JSON.stringify({ version: '1.15.3' }));
  g(C.path, 'add', '-A'); g(C.path, 'commit', '-q', '-m', 'item with bump');
  const d3 = deliverRelease(C.path, CFG, TEXT, { prebump: { from: '1.15.2', to: '1.15.3' }, date: '2026-11-05', run: 'p-t' });
  ok(d3.ok && /^\[1\.15\.3\]: \.\/$/m.test(read(C.path, 'CHANGELOG.md')), 'version déjà incrémentée, entrée déjà là : la ligne manquante est ajoutée', d3.why);

  const L = makeRepo();
  const t = await laneTask(L);
  const r = finish(L, t);
  ok(r.outcome === 'integrated' && r.version === '1.15.3' && /^\[1\.15\.3\]: \.\/$/m.test(read(L.path, 'CHANGELOG.md')), `fragments d’un couloir : ligne ajoutée (${r.outcome} ${r.version})`, r.why);
  const N = makeRepo({ changelog: CL_NONE });
  const r2 = finish(N, await laneTask(N));
  ok(r2.outcome === 'integrated' && !/^\[/m.test(read(N.path, 'CHANGELOG.md')), 'fragments, projet sans références : aucune ligne', r2.why);
}

// ---------------------------------------------------------------------------
section('3. Cas réel rejoué : le test qui lit le CHANGELOG est sélectionné et lancé sur l’arbre final');
{
  const proof = proofOf('real'), other = proofOf('other');
  const P = makeRepo({ files: { 'test/release.test.mjs': releaseTest(proof), 'test/other.test.mjs': OTHER_TEST(other) } });
  const t = await laneTask(P, 'Séances');
  const r = finish(P, t);
  ok(r.outcome === 'integrated', `intégrée (${r.outcome})`, r.why);
  ok(readProof(proof).at(-1) === '1.15.3', `le test a tourné sur l’arbre final : il a lu la version ${readProof(proof).at(-1)}`, readProof(proof));
  ok(!readProof(other).length, 'un test sans rapport n’est pas lancé');
  const ev = r.events.find(e => e.subtype === 'lane_release_check');
  ok(ev?.ok === true && /release\.test\.mjs/.test(read(ev.output)), 'contrôle tracé, commande gardée dans le journal du couloir', ev);
  ok(!/generated-by-test/.test(g(P.path, 'show', '--name-only', '--format=', 'HEAD').stdout), 'ce que le test a laissé n’entre pas dans le commit de release');

  // Mutation: the header without its line — what the old writer produced — is red.
  const M = makeRepo({ files: { 'test/release.test.mjs': releaseTest(proofOf('mut')) } });
  write(M.path, 'CHANGELOG.md', read(M.path, 'CHANGELOG.md').replace('## [1.15.2]', '## [1.15.3] - 2026-11-04\n\n- x\n\n## [1.15.2]'));
  const c = runReleaseTreeCheck(M.path, CFG, { root: T });
  ok(c.ran && !c.ok && /matching link reference/.test(c.out), 'en-tête sans sa ligne (ce que faisait l’ancien code) : le contrôle est rouge', c);
  ok(/generated-by-test/.test(g(M.path, 'status', '--short').stdout) === false, 'les fichiers laissés par le test sont retirés de la copie');
}

// ---------------------------------------------------------------------------
section('4. Sélection');
{
  const P = makeRepo({ files: { 'test/release.test.mjs': releaseTest('x'), 'test/other.test.mjs': OTHER_TEST('y') } });
  const plan = releaseCheckPlan(P.path, CFG, ['CHANGELOG.md']);
  ok(plan.length === 1 && plan[0].command === 'node --test test/release.test.mjs' && !plan[0].full, `seul le lecteur : ${plan[0]?.command}`, plan);
  const pkg = makeRepo({ files: { 'test/pkg.test.mjs': "import { test } from 'node:test';\ntest('reads package.json', () => {});\n" } });
  ok(releaseCheckPlan(pkg.path, CFG, [])[0]?.files.join() === 'test/pkg.test.mjs', 'package.json compte même si seul le CHANGELOG a changé');
  const none = makeRepo({ files: { 'test/other.test.mjs': OTHER_TEST('y') } });
  const c = runReleaseTreeCheck(none.path, CFG, { root: T });
  ok(!releaseCheckPlan(none.path, CFG, ['CHANGELOG.md']).length && !c.ran && c.ok, 'aucun test ne lit la release : rien n’est lancé');
  const V = makeRepo({ files: { 'src/server/release.test.ts': "import { it } from 'vitest';\nit('reads CHANGELOG.md', () => {});\n", 'package.json': JSON.stringify({ version: '1.15.2', scripts: { test: 'vitest run' } }) } });
  const vc = { ...CFG, testCommand: 'npm test', testGlobs: ['**/*.test.*'] };
  ok(releaseCheckPlan(V.path, vc, ['CHANGELOG.md'])[0]?.command === 'npx vitest run src/server/release.test.ts', 'projet vitest (« npm test ») : le seul fichier', releaseCheckPlan(V.path, vc, ['CHANGELOG.md']));
  const U = makeRepo({ files: { 'test/release.test.mjs': releaseTest('x') } });
  const uc = { ...CFG, testCommand: 'make check' };
  const up = releaseCheckPlan(U.path, uc, ['CHANGELOG.md']);
  ok(up[0]?.command === 'make check' && up[0].full, 'commande ciblée inconnue : toute la suite, comptée comme complète', up);
  const many = makeRepo({ files: { 'test/a.test.mjs': releaseTest('x'), 'test/b.test.mjs': releaseTest('y') } });
  const mp = releaseCheckPlan(many.path, { ...CFG, citedTestsMax: 1 }, ['CHANGELOG.md']);
  ok(mp[0]?.command === 'node --test' && mp[0].full, 'au-delà du seuil de lecteurs : toute la suite', mp);
  const Z = makeRepo({ files: { 'app/t/a.test.mjs': releaseTest('x') } });
  const zc = { ...CFG, testGlobs: ['test/**'], areas: [{ name: 'app', paths: ['app/**'], testGlobs: ['app/t/**'], testCommand: 'gradle test', targetedTestCommand: 'gradle test {files}' }] };
  ok(releaseCheckPlan(Z.path, zc, ['CHANGELOG.md'])[0]?.command === 'gradle test app/t/a.test.mjs', 'zone : la commande ciblée de la zone du lecteur', releaseCheckPlan(Z.path, zc, ['CHANGELOG.md']));
}

// ---------------------------------------------------------------------------
section('5. Arbre final rouge : livraison refusée, aucun commit, travail gardé');
{
  // Green before the bump, red on the final tree only.
  const red = (proof) => releaseTest(proof, "assert.strictEqual(v, '1.15.2', 'version pinned by the project');");
  const proof = proofOf('prog');
  const P = makeRepo({ files: { 'test/release.test.mjs': red(proof) } });
  write(P.path, 'src.txt', 'the work\n');
  const h0 = head(P.path), cl0 = read(P.path, 'CHANGELOG.md');
  const d = deliverRelease(P.path, CFG, TEXT, { date: '2026-11-05', run: 'p-t', treeCheck: (dir) => runReleaseTreeCheck(dir, CFG, { root: T }) });
  ok(!d.ok && /^la suite échoue après la livraison/.test(d.why) && /commit refusé/.test(d.why) && d.test?.ok === false, 'programme : refusée, motif des tests rouges après livraison', d);
  ok(readProof(proof).at(-1) === '1.15.3', 'le test a bien lu la version de l’arbre final', readProof(proof));
  ok(head(P.path) === h0, 'aucun commit');
  ok(version(P.path) === '1.15.2' && read(P.path, 'CHANGELOG.md') === cl0, 'version et CHANGELOG remis comme avant');
  ok(read(P.path, 'src.txt') === 'the work\n', 'le travail reste dans la copie');
  ok(d.from === '1.15.2' && d.version === '1.15.3', 'les versions restent dites à la pause');
  const green = deliverRelease(makeRepo({ files: { 'test/release.test.mjs': releaseTest(proofOf('ok')) } }).path, CFG, TEXT, { date: '2026-11-05', run: 'p-t', treeCheck: (dir) => runReleaseTreeCheck(dir, CFG, { root: T }) });
  ok(green.ok && green.commit, 'arbre final vert : livraison faite', green.why);

  const Q = makeRepo({ files: { 'test/release.test.mjs': red(proofOf('lane')) } });
  const h1 = head(Q.path), clq = read(Q.path, 'CHANGELOG.md');
  const t = await laneTask(Q);
  const r = finish(Q, t);
  ok(r.outcome === 'paused' && r.reason === 'release-check' && /tests de l’arbre final rouges/.test(r.why), `couloir : en pause, rien d’intégré (${r.outcome}, ${r.reason})`, r.why);
  ok(head(Q.path) === h1 && version(Q.path) === '1.15.2' && read(Q.path, 'CHANGELOG.md') === clq, 'copie principale intacte');
  ok(g(Q.path, 'show', `${r.branch}:work.txt`).stdout === 'the task\n' && g(Q.path, 'show', `${r.branch}:changelog.d/${t.task}.md`).status === 0, 'travail et fragment gardés sur la branche de la tâche');
  ok(r.events.some(e => e.subtype === 'lane_release_check' && e.ok === false), 'refus tracé dans le journal du couloir');

  const M = makeRepo({ files: { 'README.md': '# P\n\n- **Version** : `1.15.2`\n', 'test/readme.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport fs from 'node:fs';\ntest('README.md shows the version', () => { assert.ok(fs.readFileSync('README.md', 'utf8').includes(JSON.parse(fs.readFileSync('package.json', 'utf8')).version)); });\n" } });
  const rm = finish(M, await laneTask(M));
  ok(rm.outcome === 'integrated' && /`1\.15\.3`/.test(read(M.path, 'README.md')), 'couloir : la mention de version du README suit, le contrôle ne la voit pas rouge', rm.why);
}

// ---------------------------------------------------------------------------
section('6. Câblage du moteur (livraison par le model comprise)');
{
  const engine = read(ROOT, 'scripts', 'pipeline-engine.mjs');
  ok((engine.match(/treeCheck: finalTreeCheck\(ctx\)/g) || []).length === 2, 'Livrer par le programme et Exploitation passent le contrôle de l’arbre final');
  ok(/missingVersionLink\(txt, version\)/.test(engine), 'critère de Livrer : un model qui oublie la ligne est refusé');
  ok(/changelogLinkHint\(ctx\)/.test(engine), 'consigne de Livrer : la ligne est demandée au model');
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* Windows: a file may still be open */ }
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
