#!/usr/bin/env node
// ============================================================================
// scripts/_test_dev_split.mjs — the dev instance is separate from production (0.68.0)
// ============================================================================
//
// User decision (2026-10-10): « je te donne mon accord pour creer
// orchestrateur-dev » and « l'orchestrateur actuel sera sur une version donnée
// du code alors que le nouveau musicien sera sur une version au moins égale ou
// plus récente […] le code actuel (en prod sur le musicien Orchestrateur) fera
// des bons quand ce sera utile ».
//
// Protected: the dev checkout is its own clone (never a worktree sharing
// production's .git), on branch `dev`, containing the production base tag,
// unable to push into the production repository, with its own port (never
// 7777) and its own logs, and the fleet points each musician at its own
// directory. The sandbox's fixed port (dev instance) refuses 7777 and a busy
// port. The REAL installation is checked too when the fleet lists a dev.
//
//   node scripts/_test_dev_split.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDevSplit, INSTANCE_FILE } from './dev-split.mjs';
import { checkFixedPort } from './_regression_sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-C', cwd, ...a], { encoding: 'utf8' });

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-devsplit-'));
const PROD = path.join(T, 'prod'), DEV = path.join(T, 'dev');
fs.mkdirSync(PROD);
fs.writeFileSync(path.join(PROD, 'a.txt'), 'a\n');
git(PROD, 'init', '-q'); git(PROD, 'add', '-A'); git(PROD, 'commit', '-q', '-m', 'init'); git(PROD, 'tag', '-a', 'v1.0.0', '-m', 'prod');
fs.writeFileSync(path.join(PROD, '.token'), 'prodtoken');
// The dev as built for real: independent clone, branch dev at the prod tag,
// the prod remote fetch-only.
spawnSync('git', ['clone', '-q', '--no-hardlinks', PROD, DEV], { encoding: 'utf8' });
git(DEV, 'checkout', '-q', '-b', 'dev', 'v1.0.0');
git(DEV, 'remote', 'rename', 'origin', 'prod');
git(DEV, 'remote', 'set-url', '--push', 'prod', 'NO_PUSH_TO_PROD_REPO');
fs.writeFileSync(path.join(DEV, '.token'), 'devtoken');
const instance = { instance: 'x-dev', role: 'dev', branch: 'dev', port: 7778, logsDir: path.join(DEV, 'logs'), prodRoot: PROD, prodPort: 7777, baseTag: 'v1.0.0' };
const writeInstance = (o) => fs.writeFileSync(path.join(DEV, INSTANCE_FILE), JSON.stringify(o));
writeInstance(instance);
const config = { projects: [{ name: 'x', path: PROD }, { name: 'x-dev', path: DEV, devOf: 'x', port: 7778 }, { name: 'other', path: path.join(T, 'o'), port: 7790 }] };
const check = (over = {}) => checkDevSplit({ prodRoot: PROD, devRoot: DEV, config, devName: 'x-dev', prodName: 'x', ...over });

// ---------------------------------------------------------------------------
section('1. La dev telle qu’elle est construite : séparée de la prod');
let r = check();
ok(r.ok, `clone indépendant, branche dev, tag de la prod contenu, port et journaux propres (${r.problems.join(' ; ') || 'aucun problème'})`);
ok(r.facts.gitIsDir && r.facts.devGitDir.toLowerCase() !== r.facts.prodGitDir.toLowerCase(), 'son propre dépôt git (.git est un dossier, distinct de celui de la prod)');
git(DEV, 'commit', '-q', '--allow-empty', '-m', 'dev work');
ok(check().ok, 'une dev qui a avancé (version plus récente) reste valide : « au moins égale »');

// ---------------------------------------------------------------------------
section('2. Chaque manière de mélanger dev et prod est refusée');
const WT = path.join(T, 'wt');
git(PROD, 'worktree', 'add', '-q', '-b', 'devwt', WT, 'v1.0.0');
fs.writeFileSync(path.join(WT, INSTANCE_FILE), JSON.stringify({ ...instance, branch: 'devwt', logsDir: path.join(WT, 'logs') }));
r = checkDevSplit({ prodRoot: PROD, devRoot: WT, config: { projects: [{ name: 'x', path: PROD }, { name: 'x-dev', path: WT }] }, devName: 'x-dev', prodName: 'x' });
ok(!r.ok && r.problems.some(p => /propre dépôt git|n’est pas distinct/.test(p)), `worktree du dépôt de la prod : refusé (${r.problems[0]})`);
r = checkDevSplit({ prodRoot: PROD, devRoot: path.join(PROD, 'sub'), config, devName: 'x-dev', prodName: 'x' });
ok(!r.ok, 'dev dans le dossier de la prod (ou absente) : refusé');
git(DEV, 'checkout', '-q', '-b', 'autre');
ok(!check().ok && check().problems.some(p => /branche/.test(p)), 'pas sur la branche dev : refusé');
git(DEV, 'checkout', '-q', 'dev');
writeInstance({ ...instance, port: 7777 });
ok(check().problems.some(p => /port de la prod/.test(p)), 'port 7777 (celui de la prod) : refusé');
writeInstance({ ...instance, port: 7790 });
ok(check({ config: { projects: config.projects.map(p => (p.name === 'x-dev' ? { ...p, port: 7790 } : p)) } }).problems.some(p => /déjà attribué/.test(p)), 'port déjà attribué à un autre projet du fleet : refusé');
writeInstance({ ...instance, logsDir: path.join(PROD, 'logs') });
ok(check().problems.some(p => /journaux/.test(p)), 'journaux dans le dossier de la prod : refusé');
writeInstance(instance);
git(DEV, 'remote', 'set-url', '--push', 'prod', PROD);
ok(check().problems.some(p => /pousse dans le dépôt de la prod/.test(p)), 'une remote qui pousse dans le dépôt de la prod : refusée');
git(DEV, 'remote', 'set-url', '--push', 'prod', 'NO_PUSH_TO_PROD_REPO');
ok(check({ config: { projects: [{ name: 'x', path: PROD }, { name: 'x-dev', path: PROD }] } }).problems.some(p => /ne pointe pas sur/.test(p)), 'musicien dev du fleet pointant sur la prod : refusé');
ok(check({ config: { projects: [{ name: 'x', path: PROD }] } }).problems.some(p => /absent du fleet/.test(p)), 'musicien dev absent du fleet : refusé');
fs.writeFileSync(path.join(DEV, '.token'), 'prodtoken');
ok(check().problems.some(p => /même jeton/.test(p)), 'même jeton que la prod : refusé');
fs.writeFileSync(path.join(DEV, '.token'), 'devtoken');
writeInstance({ ...instance, baseTag: 'v9.9.9' });
ok(check().problems.some(p => /au moins égale/.test(p)), 'dev qui ne contient pas la version de la prod : refusée');
writeInstance(instance);

// ---------------------------------------------------------------------------
section('3. Instance de dev durable : port fixe, jamais 7777, jamais un port occupé');
let e = null; try { await checkFixedPort(7777); } catch (x) { e = x; }
ok(e && /production/.test(e.message), `7777 refusé : « ${e?.message} »`);
const busy = net.createServer(); await new Promise(res => busy.listen(0, '0.0.0.0', res));
const busyPort = busy.address().port;
e = null; try { await checkFixedPort(busyPort); } catch (x) { e = x; }
ok(e && /occupé/.test(e.message), 'port occupé refusé');
await new Promise(res => busy.close(res));
ok(await checkFixedPort(busyPort) === busyPort, 'port libre accepté');
ok(/--port/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8')), 'regression.mjs accepte --port (instance de dev isolée)');

// ---------------------------------------------------------------------------
section('4. L’installation réelle (quand le fleet déclare une dev)');
const real = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return null; } })();
const devs = (real?.projects || []).filter(p => p.devOf);
if (!devs.length) console.log('  — aucune dev déclarée dans ce config.json (instance de test ou autre machine) : contrôle réel sans objet');
for (const d of devs) {
  const prod = real.projects.find(p => p.name === d.devOf);
  r = checkDevSplit({ prodRoot: prod.path, devRoot: d.path, config: real, devName: d.name, prodName: d.devOf });
  ok(r.ok, `${d.name} : séparée de ${d.devOf} (${r.ok ? `port ${r.facts.port}, branche ${r.facts.branch}` : r.problems.join(' ; ')})`);
}

git(PROD, 'worktree', 'remove', '--force', WT);
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
