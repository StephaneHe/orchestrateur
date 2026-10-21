#!/usr/bin/env node
// ============================================================================
// scripts/_test_typed_operations.mjs — the registry of typed operations
// (pipelines phase 1, docs/PIPELINES-SYNTHESE.md §3.3, decisions 4 and 5)
// ============================================================================
//
// User decisions (2026-10-20, « tout comme recommandé »): an « Opérations »
// pipeline (push, tag, publication, installation, restart) whose effect is
// VERIFIED by the code — « un code retour seul ne vaut jamais « fait » » — and
// « un bond de prod n'est jamais appliqué par un musicien ».
//
// Protected here, on real git repositories (a local bare remote) and a fake adb:
//   - git_push: fast-forward only (never forced), postcondition = ls-remote;
//     already pushed = nothing run; a non fast-forward is refused before any push;
//   - git_tag / git_push_tag: never moved, never replaced; postcondition re-read;
//   - git_restore: tracked files only, a backup copy first, postcondition = status;
//   - prod_jump: the PLAN only — `--apply` never in the argv; refused without devOf;
//     the prod is unchanged (postcondition);
//   - copy_build: a new stamped copy AND latest.apk identical to it;
//   - adb_install: postcondition = installed versionCode (a « Success » with the
//     wrong versionCode is a failure); refused when the versionCode is unknown;
//   - service_restart / run_script: only what pipeline.json declares, a check is
//     mandatory, the URL / file / output is re-read;
//   - a false postcondition is a failure even with return code 0;
//   - parseOperations: closed list, at most 6, unknown parameters refused.
//
//   node scripts/_test_typed_operations.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import * as O from './typed-operations.mjs';

let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ops-'));
const sh = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${args.join(' ')} : ${r.stderr}`); return r.stdout.trim(); };
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const REMOTE = path.join(T, 'remote.git');
const P = path.join(T, 'proj');
sh(T, 'init', '-q', '--bare', '-b', 'main', REMOTE);
fs.mkdirSync(P);
sh(P, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(P, 'a.txt'), 'a\n');
sh(P, 'add', '-A'); sh(P, ...ident, 'commit', '-q', '-m', 'one');
sh(P, 'remote', 'add', 'origin', REMOTE);
sh(P, 'push', '-q', 'origin', 'main');
fs.writeFileSync(path.join(P, 'b.txt'), 'b\n');
sh(P, 'add', '-A'); sh(P, ...ident, 'commit', '-q', '-m', 'two');
const ctxOf = (extra = {}) => ({ cwd: P, root: T, project: 'proj', cfg: {}, config: { projects: [] }, env: process.env, ...extra });

section('1. git_push — avance rapide seulement, vérifiée par ls-remote');
{
  const ctx = ctxOf();
  const local = sh(P, 'rev-parse', 'HEAD');
  const r = await O.runOperation(ctx, { id: 'git_push', params: {} });
  ok(r.ok && r.argv.includes('push') && !r.argv.some(a => /force|^-f$/.test(a)), 'push sans --force, branche courante vers origin', r);
  ok(sh(REMOTE, 'rev-parse', 'refs/heads/main') === local && /ls-remote/.test(r.observed), 'postcondition : le distant a le commit local (relu par ls-remote)', r.observed);
  const again = await O.runOperation(ctx, { id: 'git_push', params: {} });
  ok(again.ok && again.already && !again.argv, 'déjà poussé : rien n’est lancé, l’effet est seulement revérifié', again);
  // Diverged remote: another clone pushes, the local branch adds its own commit.
  const C = path.join(T, 'clone');
  sh(T, 'clone', '-q', REMOTE, C);
  fs.writeFileSync(path.join(C, 'c.txt'), 'c\n'); sh(C, 'add', '-A'); sh(C, ...ident, 'commit', '-q', '-m', 'other'); sh(C, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(P, 'd.txt'), 'd\n'); sh(P, 'add', '-A'); sh(P, ...ident, 'commit', '-q', '-m', 'mine');
  const remoteBefore = sh(REMOTE, 'rev-parse', 'refs/heads/main');
  const nf = await O.runOperation(ctx, { id: 'git_push', params: {} });
  ok(!nf.ok && nf.stage === 'precondition' && /avance rapide|jamais forcé/.test(nf.why), 'non fast-forward : refusé AVANT tout push, jamais forcé', nf);
  ok(sh(REMOTE, 'rev-parse', 'refs/heads/main') === remoteBefore, 'le distant n’a pas bougé');
  sh(P, 'reset', '-q', '--hard', 'HEAD~1');
  sh(P, 'pull', '-q', '--ff-only', 'origin', 'main');
  ok(!(await O.runOperation(ctx, { id: 'git_push', params: { remote: 'inconnu' } })).ok, 'dépôt distant inconnu : refusé');
  ok(!(await O.runOperation(ctx, { id: 'git_push', params: { branch: '--force' } })).ok, 'une « branche » qui serait une option : refusée');
}

section('2. git_tag et git_push_tag — jamais déplacés ni remplacés');
{
  const ctx = ctxOf();
  const head = sh(P, 'rev-parse', 'HEAD');
  const t = await O.runOperation(ctx, { id: 'git_tag', params: { tag: 'v1.0.0', message: 'release' } });
  ok(t.ok && sh(P, 'rev-parse', 'v1.0.0^{commit}') === head, 'tag annoté posé sur HEAD, relu', t);
  ok(sh(P, 'cat-file', '-t', 'v1.0.0') === 'tag', 'tag annoté (objet tag)');
  const again = await O.runOperation(ctx, { id: 'git_tag', params: { tag: 'v1.0.0' } });
  ok(again.ok && again.already, 'même tag, même commit : déjà fait');
  fs.writeFileSync(path.join(P, 'e.txt'), 'e\n'); sh(P, 'add', '-A'); sh(P, ...ident, 'commit', '-q', '-m', 'three');
  const moved = await O.runOperation(ctx, { id: 'git_tag', params: { tag: 'v1.0.0' } });
  ok(!moved.ok && /jamais déplacé/.test(moved.why) && sh(P, 'rev-parse', 'v1.0.0^{commit}') === head, 'tag existant sur un autre commit : jamais déplacé', moved);
  const pt = await O.runOperation(ctx, { id: 'git_push_tag', params: { tag: 'v1.0.0' } });
  ok(pt.ok && sh(REMOTE, 'rev-parse', 'refs/tags/v1.0.0') === sh(P, 'rev-parse', 'refs/tags/v1.0.0'), 'tag poussé, relu par ls-remote', pt);
  ok(!(await O.runOperation(ctx, { id: 'git_tag', params: { tag: '-d' } })).ok, 'un tag qui serait une option : refusé');
}

section('3. git_restore — suivis seulement, sauvegarde d’abord, état relu');
{
  const backupDir = path.join(T, 'sauvegarde');
  const ctx = ctxOf({ backupDir });
  fs.writeFileSync(path.join(P, 'a.txt'), 'modifié\n');
  const r = await O.runOperation(ctx, { id: 'git_restore', params: { paths: ['a.txt'] } });
  ok(r.ok && fs.readFileSync(path.join(P, 'a.txt'), 'utf8') === 'a\n', 'fichier remis à l’état du dernier commit', r);
  ok(fs.readFileSync(path.join(backupDir, 'a.txt'), 'utf8') === 'modifié\n', 'copie de sauvegarde gardée avant (rien n’est perdu)');
  ok(!(await O.runOperation(ctx, { id: 'git_restore', params: { paths: ['../hors.txt'] } })).ok, 'chemin hors du projet : refusé');
  fs.writeFileSync(path.join(P, 'neuf.txt'), 'x\n');
  ok(!(await O.runOperation(ctx, { id: 'git_restore', params: { paths: ['neuf.txt'] } })).ok, 'fichier non suivi : refusé (git restore ne le concerne pas)');
  fs.rmSync(path.join(P, 'neuf.txt'));
  ok(O.isIrreversible(ctx, { id: 'git_restore' }) && O.isIrreversible(ctx, { id: 'git_push' }) && !O.isIrreversible(ctx, { id: 'git_tag' }), 'git_restore et git_push irréversibles, git_tag non');
}

section('4. prod_jump — le PLAN seulement, jamais --apply, prod inchangée');
{
  const PROD = path.join(T, 'prod');
  sh(T, 'clone', '-q', REMOTE, PROD);
  fs.mkdirSync(path.join(P, 'scripts'), { recursive: true });
  // A stand-in prod-jump: records its argv, writes nothing in the prod.
  fs.writeFileSync(path.join(P, 'scripts', 'prod-jump.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(T, 'pj-argv.json'))}, JSON.stringify(process.argv.slice(2)));console.log('plan ok');\n`);
  const config = { projects: [{ name: 'proj', path: P, devOf: 'prodp' }, { name: 'prodp', path: PROD }] };
  const ctx = ctxOf({ config });
  const head = sh(PROD, 'rev-parse', 'HEAD');
  const r = await O.runOperation(ctx, { id: 'prod_jump', params: { tag: 'v1.0.0' } });
  const argv = JSON.parse(fs.readFileSync(path.join(T, 'pj-argv.json'), 'utf8'));
  ok(r.ok && argv.join(' ') === `--tag v1.0.0 --prod ${PROD}` && !argv.includes('--apply'), 'prod-jump lancé avec --tag et --prod, SANS --apply', argv);
  ok(sh(PROD, 'rev-parse', 'HEAD') === head && /prod inchangée/.test(r.observed), 'postcondition : la prod n’a pas bougé', r.observed);
  ok(!O.OPERATIONS.prod_jump.irreversible, 'un plan n’est pas irréversible');
  ok(!(await O.runOperation(ctxOf({ config: { projects: [{ name: 'proj', path: P }] } }), { id: 'prod_jump', params: { tag: 'v1.0.0' } })).ok, 'projet sans « devOf » : refusé');
  ok(!O.parseOperations({ operations: [{ id: 'prod_jump', params: { tag: 'v1.0.0', apply: true } }] }).ok, 'un paramètre « apply » : refusé à la lecture du plan');
  fs.writeFileSync(path.join(P, 'scripts', 'prod-jump.mjs'), 'console.error("refusé : aucune non-régression"); process.exit(1);\n');
  const refused = await O.runOperation(ctx, { id: 'prod_jump', params: { tag: 'v1.0.0' } });
  ok(!refused.ok && /prod-jump refuse/.test(refused.why) && /aucune non-régression/.test(refused.observed), 'plan refusé par prod-jump : échec avec sa raison, jamais « fait »', refused);
  fs.rmSync(path.join(P, 'scripts'), { recursive: true });
}

section('5. copy_build — nouvelle copie horodatée ET latest.apk identique');
{
  const R = path.join(T, 'orch');
  fs.mkdirSync(path.join(R, 'scripts'), { recursive: true });
  const apk = path.join(T, 'app.apk');
  fs.writeFileSync(apk, 'APK-CONTENT');
  fs.writeFileSync(path.join(R, 'scripts', 'copy-build.mjs'), `import fs from 'node:fs';import path from 'node:path';const d=path.join(${JSON.stringify(R)},'builds',process.argv[2]);fs.mkdirSync(d,{recursive:true});const s=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)+'-'+process.hrtime.bigint()%1000n;fs.copyFileSync(${JSON.stringify(apk)},path.join(d,s+'.apk'));if(!process.env.FAKE_NO_LATEST)fs.copyFileSync(${JSON.stringify(apk)},path.join(d,'latest.apk'));\n`);
  const ctx = ctxOf({ root: R });
  const r = await O.runOperation(ctx, { id: 'copy_build', params: {} });
  ok(r.ok && /latest\.apk/.test(r.observed), 'APK publié : latest.apk = la nouvelle copie', r);
  const fake = await O.runOperation(ctxOf({ root: R, exec: (argv, o) => ({ code: 0, out: 'ok' }) }), { id: 'copy_build', params: {} });
  ok(!fake.ok && /rien publié/.test(fake.why), 'code 0 sans nouvelle copie : échec (un code retour ne prouve rien)', fake);
}

section('6. adb_install — le versionCode installé fait foi');
{
  fs.mkdirSync(path.join(P, 'app'), { recursive: true });
  fs.writeFileSync(path.join(P, 'app', 'build.gradle.kts'), 'android {\n  defaultConfig {\n    applicationId = "com.ex.app"\n    versionCode = 42\n    versionName = "1.2.0"\n  }\n}\n');
  const apk = path.join(T, 'app.apk');
  let installed = null;
  const adbExec = (state, after) => (argv, o) => {
    if (argv[0] !== 'adb') return O.defaultExec(argv, o);
    if (argv[1] === 'get-state') return { code: state === 'device' ? 0 : 1, out: state };
    if (argv[1] === 'install') { installed = after; return { code: 0, out: 'Success' }; }
    if (argv[1] === 'shell') return { code: 0, out: installed != null ? `    versionCode=${installed} minSdk=24 targetSdk=34` : '' };
    return { code: 1, out: '?' };
  };
  const r = await O.runOperation(ctxOf({ exec: adbExec('device', 42) }), { id: 'adb_install', params: { apk } });
  ok(r.ok && r.argv.join(' ') === `adb install -r ${apk}` && /versionCode=42/.test(r.observed), 'installé : versionCode=42 relu sur l’appareil (applicationId et versionCode lus dans le gradle)', r);
  installed = null;
  const wrong = await O.runOperation(ctxOf({ exec: adbExec('device', 41) }), { id: 'adb_install', params: { apk } });
  ok(!wrong.ok && wrong.code === 0 && /attendu 42/.test(wrong.why), '« Success » mais versionCode 41 : échec (postcondition fausse)', wrong);
  const noDev = await O.runOperation(ctxOf({ exec: adbExec('offline', 42) }), { id: 'adb_install', params: { apk } });
  ok(!noDev.ok && noDev.stage === 'precondition' && /aucun appareil/.test(noDev.why), 'aucun appareil : refusé avant l’installation');
  fs.rmSync(path.join(P, 'app'), { recursive: true });
  const unknown = await O.runOperation(ctxOf({ exec: adbExec('device', 42) }), { id: 'adb_install', params: { apk } });
  ok(!unknown.ok && /non vérifiable/.test(unknown.why), 'versionCode inconnu : refusé (postcondition non vérifiable)', unknown);
}

section('7. service_restart et run_script — seulement ce que pipeline.json déclare');
{
  let up = false;
  const srv = http.createServer((q, s) => { s.writeHead(up ? 200 : 503); s.end(up ? 'version 2.0.0' : 'down'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/version`;
  const cfg = { operations: {
    services: { web: { argv: ['node', '-e', '0'], check: { url, contains: '2.0.0', timeoutSec: 3 } }, nocheck: { argv: ['node', '-e', '0'] } },
    scripts: { build: { argv: ['node', '-e', 'require("fs").writeFileSync("out.txt","x");console.log("BUILD OK")'], irreversible: false, check: { fileExists: ['out.txt'], outputContains: 'BUILD OK' } },
      bare: { argv: ['node', '-e', '0'] } } } };
  const exec = (argv, o) => { if (argv[0] === 'node' && argv[2] === '0') up = true; return O.defaultExec(argv[0] === 'node' ? [process.execPath, ...argv.slice(1)] : argv, o); };
  const r = await O.runOperation(ctxOf({ cfg, exec }), { id: 'service_restart', params: { service: 'web' } });
  ok(r.ok && /répond \(HTTP 200\)/.test(r.observed), 'service redémarré : l’URL déclarée répond avec la version attendue', r);
  up = false;
  const down = await O.runOperation(ctxOf({ cfg, exec: (argv, o) => ({ code: 0, out: '' }) }), { id: 'service_restart', params: { service: 'web' } });
  ok(!down.ok && down.code === 0, 'code 0 mais l’URL ne répond pas : échec', down);
  srv.close();
  ok(!(await O.runOperation(ctxOf({ cfg }), { id: 'service_restart', params: { service: 'nocheck' } })).ok, 'service sans « check.url » : refusé');
  ok(!(await O.runOperation(ctxOf({ cfg }), { id: 'service_restart', params: { service: 'inconnu' } })).ok, 'service non déclaré : refusé');
  const b = await O.runOperation(ctxOf({ cfg, exec }), { id: 'run_script', params: { script: 'build' } });
  ok(b.ok && fs.existsSync(path.join(P, 'out.txt')) && /BUILD OK/.test(b.observed), 'script déclaré : fichier et sortie attendus relus', b);
  fs.rmSync(path.join(P, 'out.txt'));
  ok(!(await O.runOperation(ctxOf({ cfg, exec }), { id: 'run_script', params: { script: 'bare' } })).ok, 'script sans contrôle : refusé (un code retour seul ne prouve rien)');
  ok(!O.isIrreversible(ctxOf({ cfg }), { id: 'run_script', params: { script: 'build' } }) && O.isIrreversible(ctxOf({ cfg }), { id: 'run_script', params: { script: 'bare' } }), 'script irréversible par défaut, sauf déclaration « irreversible »: false');
}

section('8. parseOperations — liste fermée, 6 au plus');
{
  ok(O.parseOperations({ operations: [{ id: 'git_push', params: {}, autorisation: 'pousse' }] }).ok, 'opération connue acceptée, avec la citation d’autorisation');
  ok(!O.parseOperations({ operations: [{ id: 'rm_rf', params: {} }] }).ok, 'opération inconnue refusée');
  ok(!O.parseOperations({ operations: Array.from({ length: 7 }, () => ({ id: 'git_tag', params: { tag: 'x' } })) }).ok, '7 opérations : refusé (découper)');
  ok(!O.parseOperations({ operations: [] }).ok, 'liste vide refusée');
  ok(O.OPERATION_IDS.join() === 'git_push,git_tag,git_push_tag,git_restore,prod_jump,copy_build,adb_install,service_restart,run_script', `registre : ${O.OPERATION_IDS.join(', ')}`);
  ok(/IRRÉVERSIBLE/.test(O.operationsCatalogText()) && O.operationsCatalogText().split('\n').length === O.OPERATION_IDS.length, 'catalogue texte : une ligne par opération, irréversibles signalées');
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
