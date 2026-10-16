#!/usr/bin/env node
// Requirement test (0.109.0) — user rule of 2026-10-16: « Ajoutes Ayor dans les
// services pipeline. Tout nouveau musicien est sensé en être ».
// A project created by scripts/new-project.mjs is in service in the mandatory
// pipelines right away; when that is impossible, the creation says so loudly
// (exit 67, « HORS SERVICE » + reason) instead of leaving it out silently.
// Everything runs in a private test root (DISPATCH_ROOT_FOR_TESTS): the real
// config.json, model-routing.json and ~/.claude.json are never touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnforcement, isEnforced } from './pipeline-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true });

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-np-service-'));
const ROOT = path.join(T, 'root');
const DEV = path.join(T, 'Dev');
fs.mkdirSync(ROOT); fs.mkdirSync(DEV);
fs.cpSync(path.join(REPO, 'templates'), path.join(ROOT, 'templates'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({ conductor: 'chef', defaults: {}, projects: [{ name: 'chef', path: path.join(DEV, 'Chef') }] }, null, 2));
// Enforcement already in place, as in production (other projects + chef in Routage).
fs.writeFileSync(path.join(ROOT, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, history: [], enforcement: { projects: ['Ancien'], pipelines: ['discussion', 'dev'], chef: true, generalSince: '2026-10-01T00:00:00.000Z' } }, null, 2));
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: ROOT };
delete env.ORCH_CLAUDE_JSON;
const np = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'new-project.mjs'), ...a], { env, encoding: 'utf8', windowsHide: true });
const enforced = (n) => isEnforced(readEnforcement(ROOT), n);

try {
  console.log('1. Nouveau musicien : en service dès sa création');
  const P = path.join(DEV, 'Neuf');
  let r = np('Neuf', '--path', P);
  ok(r.status === 0, `new-project exit 0 (${r.status}) ${r.status ? r.stderr.slice(-400) : ''}`);
  ok(enforced('Neuf'), 'model-routing.json → enforcement.projects contient le nouveau projet');
  const e = readEnforcement(ROOT);
  ok(e.projects.includes('Ancien') && e.chef === true && e.pipelines.join(',') === 'discussion,dev' && e.generalSince === '2026-10-01T00:00:00.000Z', 'le reste de l’enforcement est conservé (projets, chef, pipelines, generalSince)');
  ok(git(P, 'rev-parse', '--show-toplevel').stdout.trim() && path.resolve(git(P, 'rev-parse', '--show-toplevel').stdout.trim()) === path.resolve(P), 'dépôt git à la racine du projet');
  const pj = path.join(P, '.orchestrateur', 'pipeline.json');
  const cfg = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')) : {};
  ok(cfg.testCommand === 'npm test' && cfg.versionFiles?.[0] === 'package.json' && cfg.changelog === 'CHANGELOG.md' && cfg.requirements === 'docs/USER_REQUIREMENTS.md', '.orchestrateur/pipeline.json : test, version, changelog, registre');
  ok(git(P, 'ls-files', '--error-unmatch', '.orchestrateur/pipeline.json').status === 0, 'pipeline.json commité');
  ok(git(P, 'status', '--porcelain').stdout.split('\n').filter(l => l && !/\.claude/.test(l)).length === 0, 'arbre propre (seul .claude/, local, reste hors commit)');
  ok(git(P, 'ls-files', '.claude').stdout.trim() === '', '.claude/ jamais commité');
  ok(spawnSync('npm test', { cwd: P, shell: true, encoding: 'utf8' }).status === 0, 'la suite générée est verte');
  ok(JSON.parse(fs.readFileSync(path.join(P, 'package.json'), 'utf8')).version === '1.0.0', 'version 1.0.0 (celle du CHANGELOG du modèle)');
  ok(/EN SERVICE/.test(r.stdout), 'la création annonce « EN SERVICE »');

  console.log('2. Relance : idempotente');
  const head = git(P, 'rev-parse', 'HEAD').stdout.trim();
  r = np('Neuf', '--path', P);
  ok(r.status === 0 && /déjà en service/.test(r.stdout), 'relance : exit 0, « déjà en service »');
  ok(git(P, 'rev-parse', 'HEAD').stdout.trim() === head, 'relance : aucun commit de plus');
  ok(readEnforcement(ROOT).projects.filter(p => p === 'Neuf').length === 1, 'relance : pas de doublon dans enforcement');

  console.log('3. Impossible ⇒ signalé clairement, jamais en silence');
  const Q = path.join(DEV, 'Existant');
  fs.mkdirSync(Q); fs.writeFileSync(path.join(Q, 'notes.txt'), 'travail de quelqu’un');
  r = np('Existant', '--path', Q);
  ok(r.status === 67, `dossier existant sans git : exit 67 (${r.status})`);
  ok(/HORS SERVICE/.test(r.stderr) && /pas de dépôt git/.test(r.stderr), 'message « HORS SERVICE » avec la raison');
  ok(!enforced('Existant') && !fs.existsSync(path.join(Q, '.git')), 'pas en service, et rien n’est initialisé à la place du propriétaire');

  const G = path.join(DEV, 'Gradle');
  fs.mkdirSync(G); git(G, 'init', '-q'); fs.writeFileSync(path.join(G, 'build.gradle.kts'), '// app\n');
  git(G, 'add', '-A'); git(G, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  r = np('Gradle', '--path', G);
  ok(r.status === 67 && /aucune commande de test/.test(r.stderr) && !enforced('Gradle'), 'autre pile sans commande de test : exit 67, raison, aucune suite Node imposée');
  ok(!fs.existsSync(path.join(G, 'package.json')), 'aucun package.json généré sur une autre pile');

  const R = path.join(DEV, 'Rouge');
  fs.mkdirSync(R); git(R, 'init', '-q');
  fs.writeFileSync(path.join(R, 'package.json'), JSON.stringify({ name: 'rouge', version: '1.0.0', scripts: { test: 'node -e "process.exit(3)"' } }));
  git(R, 'add', '-A'); git(R, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  r = np('Rouge', '--path', R);
  ok(r.status === 67 && /suite de tests rouge/.test(r.stderr) && !enforced('Rouge'), 'suite rouge : exit 67, raison, pas en service');

  console.log('4. Dépôt existant avec une suite verte : en service, seul le squelette créé est commité');
  const V = path.join(DEV, 'Vert');
  fs.mkdirSync(V); git(V, 'init', '-q');
  fs.writeFileSync(path.join(V, 'package.json'), JSON.stringify({ name: 'vert', version: '2.3.0', scripts: { test: 'node -e "process.exit(0)"' } }));
  fs.writeFileSync(path.join(V, 'CHANGELOG.md'), '# Changelog\n\n## [2.3.0] - 2026-10-01\n');
  git(V, 'add', '-A'); git(V, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  r = np('Vert', '--path', V);
  ok(r.status === 0 && enforced('Vert'), `dépôt existant vert : en service (${r.status})`);
  ok(fs.readFileSync(path.join(V, 'CHANGELOG.md'), 'utf8').startsWith('# Changelog\n\n## [2.3.0]'), 'CHANGELOG existant jamais réécrit');
  ok(git(V, 'status', '--porcelain').stdout.split('\n').filter(l => l && !/\.claude/.test(l)).length === 0, 'arbre propre après intégration');

  console.log('5. Le chef n’est jamais mis en service comme un musicien');
  r = np('chef', '--path', path.join(DEV, 'Chef'));
  ok(r.status === 0 && !readEnforcement(ROOT).projects.includes('chef'), 'chef : exit 0, pipeline Routage, absent de enforcement.projects');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
