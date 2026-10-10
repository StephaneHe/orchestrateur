#!/usr/bin/env node
// ============================================================================
// scripts/dev-split.mjs — the dev instance is separate from production (0.68.0)
// ============================================================================
//
// User decision (2026-10-10): « l'orchestrateur actuel sera sur une version
// donnée du code alors que le nouveau musicien sera sur une version au moins
// égale ou plus récente. donc la version du code actuel sera figé pour ce
// musicien. le développement continuera et les versions évolueront sur le
// nouveau musicien. le code actuel (en prod sur le musicien Orchestrateur) fera
// des bons quand ce sera utile. » — and « je te donne mon accord pour creer
// orchestrateur-dev ».
//
// checkDevSplit() verifies that the dev checkout can never touch production:
//   - distinct directories, neither inside the other;
//   - the dev checkout is its OWN git repository (a clone, not a worktree
//     sharing production's .git), on branch `dev`, containing the production
//     base tag (« au moins égale »);
//   - no remote of the dev checkout can push into the production repository;
//   - its own port (never 7777, never another fleet port) and its own logs
//     directory, inside the dev checkout;
//   - its fleet entry points at the dev checkout, production's at production;
//   - distinct access tokens.
//
// CLI: node scripts/dev-split.mjs check   (real fleet: entry with `devOf`)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const INSTANCE_FILE = '.orchestrateur-instance.json';
const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
const inside = (a, b) => { const r = path.relative(norm(b), norm(a)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const git = (cwd, args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }); return { ok: r.status === 0, out: (r.stdout || '').trim() }; };

/**
 * → { ok, problems: [..], facts: {...} }. `prodPort` defaults to 7777.
 */
export function checkDevSplit({ prodRoot, devRoot, config, devName, prodName, prodPort = 7777 }) {
  const problems = [];
  const facts = {};
  const fail = (why) => problems.push(why);

  // Directories
  if (!devRoot || !fs.existsSync(devRoot)) return { ok: false, problems: [`dossier de la dev absent : ${devRoot}`], facts };
  if (inside(devRoot, prodRoot) || inside(prodRoot, devRoot)) fail(`la dev (${devRoot}) et la prod (${prodRoot}) se chevauchent`);

  // Own git repository (clone, not a worktree of production)
  const dotGit = path.join(devRoot, '.git');
  facts.gitIsDir = fs.existsSync(dotGit) && fs.statSync(dotGit).isDirectory();
  if (!facts.gitIsDir) fail('la dev n’a pas son propre dépôt git (.git absent ou lien de worktree vers un autre dépôt)');
  const devCommon = git(devRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
  const prodCommon = git(prodRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
  facts.devGitDir = devCommon; facts.prodGitDir = prodCommon;
  if (!devCommon || norm(devCommon) === norm(prodCommon) || inside(devCommon, prodRoot)) fail(`le dépôt git de la dev (${devCommon || '?'}) n’est pas distinct de celui de la prod`);

  // Branch and base version
  const inst = readJson(path.join(devRoot, INSTANCE_FILE)) || {};
  facts.instance = inst;
  facts.branch = git(devRoot, ['branch', '--show-current']).out;
  if (facts.branch !== (inst.branch || 'dev')) fail(`la dev n’est pas sur sa branche (${facts.branch || 'détachée'} au lieu de ${inst.branch || 'dev'})`);
  if (!inst.baseTag) fail(`${INSTANCE_FILE} : tag de base (version de la prod) absent`);
  else if (!git(devRoot, ['merge-base', '--is-ancestor', inst.baseTag, 'HEAD']).ok) fail(`la dev ne contient pas ${inst.baseTag} : elle doit être au moins égale à la prod`);

  // No push path into production
  const remotes = git(devRoot, ['remote', '-v']).out.split('\n').filter(Boolean).map(l => l.split(/\s+/));
  facts.remotes = remotes.map(r => r.join(' '));
  for (const [name, url, kind] of remotes) {
    if (kind === '(push)' && fs.existsSync(url) && norm(url) === norm(prodRoot)) fail(`la remote « ${name} » de la dev pousse dans le dépôt de la prod`);
  }

  // Port
  const otherPorts = (config?.projects || []).filter(p => p.name !== devName && Number.isInteger(p.port)).map(p => p.port);
  facts.port = inst.port;
  if (!Number.isInteger(inst.port)) fail(`${INSTANCE_FILE} : port de la dev absent`);
  else {
    if (inst.port === prodPort) fail(`la dev utilise le port de la prod (${prodPort})`);
    if (otherPorts.includes(inst.port)) fail(`le port ${inst.port} est déjà attribué à un autre projet du fleet`);
  }

  // Logs
  facts.logsDir = inst.logsDir;
  if (!inst.logsDir) fail(`${INSTANCE_FILE} : dossier de journaux absent`);
  else {
    if (!inside(inst.logsDir, devRoot)) fail(`les journaux de la dev (${inst.logsDir}) sont hors de son dossier`);
    if (inside(inst.logsDir, prodRoot)) fail('les journaux de la dev sont dans le dossier de la prod');
  }

  // Fleet entries
  const devEntry = (config?.projects || []).find(p => p.name === devName);
  const prodEntry = (config?.projects || []).find(p => p.name === prodName);
  facts.devEntry = devEntry || null;
  if (!devEntry) fail(`musicien « ${devName} » absent du fleet (config.json)`);
  else {
    if (norm(devEntry.path) !== norm(devRoot)) fail(`le musicien « ${devName} » ne pointe pas sur ${devRoot} (${devEntry.path})`);
    if (devEntry.port != null && devEntry.port !== inst.port) fail(`port du fleet (${devEntry.port}) ≠ port de l’instance (${inst.port})`);
  }
  if (prodEntry && norm(prodEntry.path) !== norm(prodRoot)) fail(`le musicien « ${prodName} » ne pointe plus sur la prod (${prodEntry.path})`);

  // Tokens
  const tok = (r) => { try { return fs.readFileSync(path.join(r, '.token'), 'utf8').trim(); } catch { return null; } };
  const td = tok(devRoot), tp = tok(prodRoot);
  if (td && tp && td === tp) fail('la dev et la prod partagent le même jeton (.token)');

  return { ok: problems.length === 0, problems, facts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = readJson(path.join(ROOT, 'config.json')) || { projects: [] };
  const devs = config.projects.filter(p => p.devOf);
  if (!devs.length) { console.log('aucune instance de dev dans le fleet (entrée avec « devOf »)'); process.exit(0); }
  let bad = 0;
  for (const d of devs) {
    const prod = config.projects.find(p => p.name === d.devOf);
    const r = checkDevSplit({ prodRoot: prod?.path || ROOT, devRoot: d.path, config, devName: d.name, prodName: d.devOf });
    console.log(`${r.ok ? '✓' : '✕'} ${d.name} (dev de ${d.devOf}) : ${r.ok ? `séparée — port ${r.facts.port}, branche ${r.facts.branch}, journaux ${r.facts.logsDir}` : r.problems.join(' ; ')}`);
    if (!r.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}
