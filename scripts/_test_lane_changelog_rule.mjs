#!/usr/bin/env node
// ============================================================================
// scripts/_test_lane_changelog_rule.mjs — rule « changelog.d »: a lane task
// never edits the version nor the CHANGELOG; the integrator assigns the
// version (user decision Q4, 2026-10-15)
// ============================================================================
//
// Question 4 (design docs/PLAN-parallel-tasks-same-musician.md §2.8):
// « Validez-vous le changement de règle pour la version et le CHANGELOG ? »
// User, verbatim: « Question 4 : ok, je valide tout ».
// And Q5, verbatim: « Question 5 : Non, orchestrateur-dev, a nous de faire en
// sorte qu'il ne se trompe pas » (pilot = this repository).
//
// Permanent requirement test, on temporary git repositories with the real
// scripts/lanes.mjs:
//   1. two lane tasks write fragments; each integration is one release, the
//      version is computed by the integrator in integration order (not in
//      start order), the dated entry is written, the fragment deleted;
//   2. gradle versionName / versionCode (+1) via versionFiles;
//   3. a task that edited the version and added a top entry itself: converted
//      into a fragment, the integrator still assigns the number;
//   4. lines added under [Unreleased]: converted too;
//   5. an older entry edited: integration paused, nothing integrated;
//   6. an invalid bump: paused, never guessed;
//   7. no fragment: a patch fragment is generated, the task stays a release;
//   8. lanes.releaseCheck runs on the release tree; red ⇒ paused;
//   9. the release commit goes through the project's git hooks (delivery
//      gate of this repository): refused ⇒ paused, main checkout untouched;
//  10. the lane prompt states the rule (lanes ≥ 1 only); the pilot
//      configuration of this repository provisions a lane, keeps it out of
//      the production root and runs the targeted regression before every
//      release;
//  11. lanes.dir: lanes outside the orchestrator root, never inside the repo.
//
//   node scripts/_test_lane_changelog_rule.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lanes from './lanes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lane-cl-'));
const LOGS = path.join(T, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
const g = (dir, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: dir, encoding: 'utf8' });
const read = (f) => fs.readFileSync(f, 'utf8');
const CL0 = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-01\n\n### Added\n\n- start\n';

function makeRepo(name, { files = {} } = {}) {
  const dir = path.join(T, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: name.toLowerCase(), version: '1.0.0', dependencies: { a: '1.0.0' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), CL0);
  fs.writeFileSync(path.join(dir, 'src.txt'), 'one\n');
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  g(dir, 'init', '-q', '-b', 'master'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return { name, path: dir };
}
let seq = 0;
async function start(project, k, title) {
  const { dir } = await lanes.ensureLane({ root: T, project, k, trust: false });
  const task = `t-${++seq}`;
  lanes.startTask({ logsDir: LOGS, project, k, dir, task, turn: `turn-${seq}`, title });
  return { dir, task, k, title };
}
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const frag = (bump, body) => `---\nbump: ${bump}\n---\n\n${body}\n`;
function finish(project, t) {
  const events = [];
  const r = lanes.finishTask({ logsDir: LOGS, project, k: t.k, dir: t.dir, turnEnd: 'done', title: t.title, log: (e) => events.push(e), waitMs: 5000 });
  return { ...r, events };
}
const version = (p) => JSON.parse(read(path.join(p.path, 'package.json'))).version;
const head = (p) => g(p.path, 'rev-parse', 'HEAD').stdout.trim();
const today = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
section('1. Fragments : la version est attribuée par l’intégrateur, dans l’ordre d’intégration');
{
  const P = makeRepo('P');
  const a = await start(P, 1, 'Tâche A');
  const b = await start(P, 2, 'Tâche B');
  write(a.dir, 'a.txt', 'A\n'); write(a.dir, `changelog.d/${a.task}.md`, frag('patch', '### Fixed\n\n- bug A'));
  write(b.dir, 'b.txt', 'B\n'); write(b.dir, `changelog.d/${b.task}.md`, frag('minor', '### Added\n\n- feature B'));
  ok(version(P) === '1.0.0' && read(path.join(P.path, 'CHANGELOG.md')) === CL0, 'pendant les tâches, la copie principale garde sa version et son CHANGELOG');
  const rb = finish(P, b);                                       // B started second, integrated first
  const ra = finish(P, a);
  ok(rb.outcome === 'integrated' && rb.version === '1.1.0', `B (minor) intégrée la première : v1.1.0 (${rb.outcome} ${rb.version})`, rb.why);
  ok(ra.outcome === 'integrated' && ra.version === '1.1.1', `A (patch) intégrée ensuite : v1.1.1, calculée sur la version déjà intégrée (${ra.outcome} ${ra.version})`, ra.why);
  const cl = read(path.join(P.path, 'CHANGELOG.md'));
  ok(version(P) === '1.1.1', `package.json de la branche d’intégration : ${version(P)}`);
  ok(new RegExp(`## \\[Unreleased\\]\\n\\n## \\[1\\.1\\.1\\] - ${today}\\n\\n### Fixed\\n\\n- bug A\\n\\n## \\[1\\.1\\.0\\] - ${today}\\n\\n### Added\\n\\n- feature B`).test(cl),
    'CHANGELOG : une entrée datée par tâche, la plus récente en haut, texte du fragment', cl);
  ok(!fs.existsSync(path.join(P.path, 'changelog.d', `${a.task}.md`)) && !fs.existsSync(path.join(P.path, 'changelog.d', `${b.task}.md`)), 'les fragments sont supprimés à l’intégration');
  const log = g(P.path, 'log', '--format=%s', 'master').stdout;
  ok(/chore\(release\): v1\.1\.1 \(Tâche A\)/.test(log) && /chore\(release\): v1\.1\.0 \(Tâche B\)/.test(log), 'un commit de release par tâche, nommé par la tâche');
  const pkg = JSON.parse(read(path.join(P.path, 'package.json')));
  ok(pkg.dependencies.a === '1.0.0', 'le reste de package.json est intact');
}

// ---------------------------------------------------------------------------
section('2. Gradle : versionName et versionCode + 1 (versionFiles)');
{
  const G = makeRepo('G', { files: {
    'app/build.gradle.kts': 'android {\n  defaultConfig {\n    versionCode = 7\n    versionName = "2.3.4"\n  }\n}\n',
    '.orchestrateur/pipeline.json': JSON.stringify({ versionFiles: ['app/build.gradle.kts'] }) } });
  const t = await start(G, 1, 'Écran');
  write(t.dir, 'ui.kt', 'x\n'); write(t.dir, `changelog.d/${t.task}.md`, frag('minor', '### Added\n\n- (android) écran'));
  const r = finish(G, t);
  const gr = read(path.join(G.path, 'app', 'build.gradle.kts'));
  ok(r.version === '2.4.0' && /versionName = "2\.4\.0"/.test(gr) && /versionCode = 8/.test(gr), `versionName 2.4.0, versionCode 8 (${r.version})`, gr);
}

// ---------------------------------------------------------------------------
section('3. Version et entrée modifiées par la tâche : converties en fragment');
{
  const P = makeRepo('C');
  const t = await start(P, 1, 'Fonction X');
  write(t.dir, 'x.txt', 'X\n');
  const pkg = JSON.parse(read(path.join(t.dir, 'package.json'))); pkg.version = '1.1.0'; pkg.dependencies.b = '2.0.0';
  write(t.dir, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
  write(t.dir, 'CHANGELOG.md', CL0.replace('## [1.0.0]', '## [1.1.0] - 2026-10-14\n\n### Added\n\n- feature X\n\n## [1.0.0]'));
  // Meanwhile another task is integrated: the number the task wrote is stale.
  const o = await start(P, 2, 'Correctif Y');
  write(o.dir, 'y.txt', 'Y\n'); write(o.dir, `changelog.d/${o.task}.md`, frag('patch', '### Fixed\n\n- Y'));
  ok(finish(P, o).version === '1.0.1', 'une autre tâche est intégrée entre-temps (v1.0.1)');
  const r = finish(P, t);
  const conv = r.events.find(e => e.subtype === 'lane_version_rule');
  ok(r.outcome === 'integrated' && r.version === '1.1.0' && r.versionEdited, `intégrée, numéro calculé par l’intégrateur : 1.0.1 + minor = ${r.version}`, r.why);
  ok(conv && conv.converted && conv.converted.bump === 'minor' && conv.converted.files.includes('package.json') && conv.converted.files.includes('CHANGELOG.md'),
    'événement lane_version_rule : conversion tracée (fichiers, hausse déduite de la version écrite)', JSON.stringify(conv));
  const cl = read(path.join(P.path, 'CHANGELOG.md'));
  ok((cl.match(/## \[1\.1\.0\]/g) || []).length === 1 && new RegExp(`## \\[1\\.1\\.0\\] - ${today}\\n\\n### Added\\n\\n- feature X\\n\\n## \\[1\\.0\\.1\\]`).test(cl),
    'une seule entrée 1.1.0, datée du jour de l’intégration, au-dessus de 1.0.1', cl);
  ok(JSON.parse(read(path.join(P.path, 'package.json'))).dependencies.b === '2.0.0', 'les autres modifications de package.json de la tâche sont gardées');
}

// ---------------------------------------------------------------------------
section('4. Lignes ajoutées sous [Unreleased] : converties en fragment');
{
  const P = makeRepo('U');
  const t = await start(P, 1, 'Petit correctif');
  write(t.dir, 'z.txt', 'Z\n');
  write(t.dir, 'CHANGELOG.md', CL0.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n- petit correctif\n'));
  const r = finish(P, t);
  const cl = read(path.join(P.path, 'CHANGELOG.md'));
  ok(r.outcome === 'integrated' && r.version === '1.0.1' && /## \[Unreleased\]\n\n## \[1\.0\.1\][^\n]*\n\n### Fixed\n\n- petit correctif/.test(cl), `v${r.version}, l’entrée quitte [Unreleased]`, cl);
}

// ---------------------------------------------------------------------------
section('5. Entrée ancienne modifiée : intégration en pause, rien n’est intégré');
{
  const P = makeRepo('E');
  const before = head(P);
  const t = await start(P, 1, 'Réécrit l’historique');
  write(t.dir, 'e.txt', 'E\n');
  write(t.dir, 'CHANGELOG.md', CL0.replace('- start', '- start (réécrit)'));
  const r = finish(P, t);
  ok(r.outcome === 'paused' && r.reason === 'lane-version-edited' && /CHANGELOG/.test(r.why), `pause lane-version-edited (${r.reason}) : ${r.why}`);
  ok(head(P) === before && version(P) === '1.0.0' && read(path.join(P.path, 'CHANGELOG.md')) === CL0, 'copie principale intacte');
  ok(g(P.path, 'rev-parse', '--verify', '-q', `refs/heads/lane/1/${t.task}`).status === 0 && r.diff && fs.existsSync(r.diff), 'le travail reste sur sa branche, différences archivées');
}

// ---------------------------------------------------------------------------
section('6. Hausse invalide : pause, jamais devinée');
{
  const P = makeRepo('I');
  const before = head(P);
  const t = await start(P, 1, 'Fragment faux');
  write(t.dir, 'i.txt', 'I\n'); write(t.dir, `changelog.d/${t.task}.md`, frag('feature', '### Added\n\n- i'));
  const r = finish(P, t);
  ok(r.outcome === 'paused' && r.reason === 'lane-fragment-invalid' && /feature/.test(r.why) && head(P) === before, `pause lane-fragment-invalid : ${r.why}`);
}

// ---------------------------------------------------------------------------
section('7. Aucun fragment : un fragment patch est généré, la tâche reste une release');
{
  const P = makeRepo('N');
  const t = await start(P, 1, 'Oubli du fragment');
  write(t.dir, 'n.txt', 'N\n');
  const r = finish(P, t);
  const gen = r.events.find(e => e.subtype === 'lane_version_rule');
  ok(r.outcome === 'integrated' && r.version === '1.0.1' && gen?.generated?.bump === 'patch', `v${r.version}, fragment généré tracé`, JSON.stringify(gen));
  ok(/## \[1\.0\.1\][^\n]*\n\n### Changed\n\n- Oubli du fragment \(entry generated by the integrator/.test(read(path.join(P.path, 'CHANGELOG.md'))), 'l’entrée nomme la tâche et dit qu’elle a été générée');
  const t2 = await start(P, 1, 'Rien');
  const r2 = finish(P, t2);
  ok(r2.outcome === 'nothing' && version(P) === '1.0.1', 'une tâche sans modification ne crée pas de release');
}

// ---------------------------------------------------------------------------
section('8. lanes.releaseCheck : lancé sur l’arbre de la release ; rouge ⇒ pause');
{
  const check = path.join(T, 'check.mjs');
  fs.writeFileSync(check, `import fs from 'node:fs';\nconst v = JSON.parse(fs.readFileSync('package.json','utf8')).version;\nconst staged = (await import('node:child_process')).spawnSync('git',['diff','--cached','--name-only'],{encoding:'utf8'}).stdout;\nfs.writeFileSync(${JSON.stringify(path.join(T, 'check-seen.txt'))}, v + ' ' + process.argv.slice(2).join(' ') + '\\n' + staged);\nprocess.exit(process.env.CHECK_RED ? 1 : 0);\n`);
  const P = makeRepo('R', { files: { '.orchestrateur/pipeline.json': JSON.stringify({ lanes: { releaseCheck: ['node', check, '--since', '{base}', '--v', '{version}'] } }) } });
  const before = head(P);
  const t = await start(P, 1, 'Avec contrôle');
  write(t.dir, 'r.txt', 'R\n'); write(t.dir, `changelog.d/${t.task}.md`, frag('minor', '### Added\n\n- r'));
  process.env.CHECK_RED = '1';
  const r = finish(P, t);
  delete process.env.CHECK_RED;
  const seen = read(path.join(T, 'check-seen.txt'));
  ok(r.outcome === 'paused' && r.reason === 'release-check' && head(P) === before && version(P) === '1.0.0', `contrôle rouge ⇒ pause release-check, rien d’intégré (${r.why})`);
  ok(seen.startsWith(`1.1.0 --since ${before} --v 1.1.0`) && /package\.json/.test(seen) && /CHANGELOG\.md/.test(seen), 'le contrôle voit la version calculée, la base, et l’arbre de la release indexé', seen);
  const t2 = await start(P, 1, 'Avec contrôle, vert');
  write(t2.dir, 'r2.txt', 'R2\n'); write(t2.dir, `changelog.d/${t2.task}.md`, frag('minor', '### Added\n\n- r2'));
  const r2 = finish(P, t2);
  ok(r2.outcome === 'integrated' && r2.version === '1.1.0' && r2.events.some(e => e.subtype === 'lane_release_check' && e.ok), `contrôle vert ⇒ intégrée v${r2.version}`, r2.why);
}

// ---------------------------------------------------------------------------
section('9. Le commit de release passe par les hooks git du projet (garde-fou de livraison)');
{
  const P = makeRepo('H');
  const hook = path.join(P.path, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\necho "hook $(git diff --cached --name-only | tr '\\n' ' ')" >> "${path.join(T, 'hook-seen.txt').replace(/\\/g, '/')}"\nif [ -f "${path.join(T, 'hook-red').replace(/\\/g, '/')}" ]; then echo "livraison refusée : aucun rapport" >&2; exit 1; fi\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
  const before = head(P);
  fs.writeFileSync(path.join(T, 'hook-red'), '1');
  const t = await start(P, 1, 'Sans rapport');
  write(t.dir, 'h.txt', 'H\n'); write(t.dir, `changelog.d/${t.task}.md`, frag('patch', '### Fixed\n\n- h'));
  const r = finish(P, t);
  ok(r.outcome === 'paused' && r.reason === 'release-commit' && /aucun rapport/.test(r.why) && head(P) === before && version(P) === '1.0.0',
    `hook rouge ⇒ pause release-commit, copie principale intacte (${r.why})`);
  fs.rmSync(path.join(T, 'hook-red'));
  const t2 = await start(P, 1, 'Avec rapport');
  write(t2.dir, 'h2.txt', 'H2\n'); write(t2.dir, `changelog.d/${t2.task}.md`, frag('patch', '### Fixed\n\n- h2'));
  const r2 = finish(P, t2);
  const seen = read(path.join(T, 'hook-seen.txt'));
  ok(r2.outcome === 'integrated' && r2.version === '1.0.1', `hook vert ⇒ intégrée v${r2.version}`, r2.why);
  ok(/hook .*package\.json/.test(seen), 'le hook a bien vu le commit de release (version indexée)', seen);
}

// ---------------------------------------------------------------------------
section('10. Consigne du couloir et configuration du pilote orchestrateur-dev');
{
  const d = read(path.join(ROOT, 'scripts', 'dispatch.mjs'));
  const rule = /function laneRule\(\)[\s\S]*?\n}\n/.exec(d)?.[0] || '';
  ok(/NE MODIFIE NI le numéro de version/.test(rule) && /CHANGELOG\.md/.test(rule) && /changelog\.d\//.test(rule) && /bump: patch\|minor\|major/.test(rule) && /attribue lui-même la version/.test(rule),
    'laneRule : ni version ni CHANGELOG, un fragment changelog.d avec sa hausse, version attribuée à l’intégration');
  ok(/if \(LANE && LANE\.k >= 1\) prompt = prompt \+ laneRule\(\);/.test(d), 'la consigne ne part qu’aux couloirs ≥ 1 (le couloir 0 garde la règle habituelle)');
  const cfg = JSON.parse(read(path.join(ROOT, '.orchestrateur', 'pipeline.json'))).lanes || {};
  ok(['config.json', '.orchestrateur-instance.json', '.token'].every(f => cfg.copy?.includes(f)) && cfg.link?.includes('node_modules'),
    'pilote : un couloir reçoit config.json, .orchestrateur-instance.json, .token et node_modules', JSON.stringify(cfg));
  ok(Array.isArray(cfg.releaseCheck) && cfg.releaseCheck.join(' ') === 'node scripts/regression.mjs --targeted --since {base}',
    'pilote : non-régression ciblée sur l’arbre exact de chaque release avant son commit (le hook de livraison la vérifie)', JSON.stringify(cfg.releaseCheck));
  ok(cfg.dir === '../orchestrateur-dev-lanes' && lanes.laneBase(ROOT) === path.resolve(ROOT, '..', 'orchestrateur-dev-lanes')
    && path.relative('I:/orchestrateur', lanes.laneBase(ROOT)).startsWith('..'),
    'pilote : ses couloirs sont hors du dépôt et jamais sous la racine de la prod (I:/orchestrateur)', lanes.laneBase(ROOT));
  ok(!/--no-verify/.test(/chore\(release\)[^\n]*\n/.exec(read(path.join(ROOT, 'scripts', 'lanes.mjs')))?.[0] || 'x') && /verify: true/.test(read(path.join(ROOT, 'scripts', 'lanes.mjs'))),
    'le commit de release ne contourne jamais les hooks');
}

// ---------------------------------------------------------------------------
section('11. lanes.dir : couloirs hors de la racine de l’orchestrateur');
{
  const P = makeRepo('D', { files: { '.orchestrateur/pipeline.json': JSON.stringify({ lanes: { dir: '../D-lanes' } }) } });
  const t = await start(P, 1, 'Ailleurs');
  ok(path.resolve(t.dir) === path.join(T, 'D-lanes', '1') && fs.existsSync(path.join(t.dir, '.git')) && !fs.existsSync(path.join(T, 'lanes', 'D', '1')),
    `le couloir est créé dans lanes.dir (${t.dir}), aucune copie sous la racine`);
  write(t.dir, 'd.txt', 'D\n'); write(t.dir, `changelog.d/${t.task}.md`, frag('patch', '### Fixed\n\n- d'));
  ok(finish(P, t).version === '1.0.1', 'intégration normale depuis ce couloir');
  const st = lanes.lanesStatus({ root: T, logsDir: LOGS, config: { defaults: {} }, project: { ...P, maxParallel: 2 } });
  ok(path.resolve(st.lanes[1].dir) === path.join(T, 'D-lanes', '1'), 'lanes.mjs status montre ce dossier');
  for (const bad of ['sub/lanes', '.', 'C:/abs/lanes']) {
    fs.writeFileSync(path.join(P.path, '.orchestrateur', 'pipeline.json'), JSON.stringify({ lanes: { dir: bad } }));
    ok(lanes.laneBase(P.path) === null, `lanes.dir « ${bad} » refusé (dans le dépôt ou absolu) : emplacement par défaut`);
  }
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '✗' : '✓'} ${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
