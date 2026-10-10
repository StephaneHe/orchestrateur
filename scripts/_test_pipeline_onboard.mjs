#!/usr/bin/env node
// ============================================================================
// scripts/_test_pipeline_onboard.mjs — pipelines phase 7 (0.56.0): putting the
// fleet in service, local CLI files, roll-back, follow-up counters
// ============================================================================
//
// User request (2026-10-09): « passes tout en pipeline ». Throw-away root and
// repositories; production is never touched.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as O from './pipeline-onboard.mjs';
import * as H from './pipeline-health.mjs';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-onboard-'));
fs.mkdirSync(path.join(T, 'logs'));
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
function repo(name, { claudeTracked = false, claudeUntracked = false, dirty = false } = {}) {
  const dir = path.join(T, name);
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', scripts: { test: 'node --test' } }) + '\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n');
  if (claudeTracked) { fs.mkdirSync(path.join(dir, '.claude')); fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{"permissions":{"allow":[]}}\n'); }
  g(dir, 'init', '-q'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  if (claudeTracked) fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash"]}}\n');   // local change
  if (claudeUntracked) { fs.mkdirSync(path.join(dir, '.claude'), { recursive: true }); fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{}\n'); }
  if (dirty) fs.writeFileSync(path.join(dir, 'travail.txt'), 'en cours\n');
  return dir;
}
const entry = { testCommand: 'node --test', verified: true };
const status = (dir) => g(dir, 'status', '--porcelain').stdout.trim();

// ---------------------------------------------------------------------------
section('1. Fichiers locaux du CLI (.claude/) : jamais bloquants, jamais commités');
let d = repo('A', { claudeTracked: true });
let r = O.onboardProject({ name: 'A', path: d }, entry);
ok(r.status === 'service' && status(d) === '', `réglages suivis et modifiés : skip-worktree, arbre propre (${r.actions.join(' ; ')})`, r.why);
const lastCommit = g(d, 'show', '--name-only', '--format=%s', 'HEAD').stdout.trim().split('\n');
ok(lastCommit[0] === 'chore(orchestrator): add .orchestrateur/pipeline.json' && lastCommit.filter(Boolean).slice(1).join() === '.orchestrateur/pipeline.json', 'commit dédié : pipeline.json SEUL (aucun fichier .claude/)');
ok(g(d, 'diff', 'HEAD~1', 'HEAD', '--name-only').stdout.trim() === '.orchestrateur/pipeline.json' && !g(d, 'log', '--all', '--format=%H').stdout.trim().includes('\n\n'), 'aucune réécriture d’historique (simple ajout)');
const pj = JSON.parse(fs.readFileSync(path.join(d, '.orchestrateur', 'pipeline.json'), 'utf8'));
ok(pj.testCommand === 'node --test' && pj.versionFiles.join() === 'package.json' && pj.changelog === 'CHANGELOG.md' && pj.testGlobs.includes('test/**'), 'pipeline.json : commande vérifiée, version, CHANGELOG, motifs de test');
d = repo('B', { claudeUntracked: true });
r = O.onboardProject({ name: 'B', path: d }, entry);
ok(r.status === 'service' && status(d) === '' && fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8').includes('.claude/'), '.claude/ non suivi : .git/info/exclude (local), arbre propre');
ok(E.isLocalOnly('.claude/settings.json') && E.isLocalOnly('.orchestrateur/runs/p-x/a.md') && !E.isLocalOnly('src/a.js'), 'moteur : .claude/ et les artefacts sont des fichiers locaux');

// ---------------------------------------------------------------------------
section('2. Inéligibles : listés avec la raison, rien n’est modifié');
d = repo('C', { dirty: true });
r = O.onboardProject({ name: 'C', path: d }, entry);
ok(r.status === 'exclu' && /arbre non propre : travail.txt/.test(r.why) && !fs.existsSync(path.join(d, '.orchestrateur')), 'travail non commité : exclu, jamais commité à la place du musicien');
d = repo('D');
r = O.onboardProject({ name: 'D', path: d }, { why: 'aucune suite de tests' });
ok(r.status === 'exclu' && r.why === 'aucune suite de tests', 'sans commande de test vérifiée : exclu avec la raison');
fs.mkdirSync(path.join(T, 'E'));
ok(O.onboardProject({ name: 'E', path: path.join(T, 'E') }, entry).why.includes('pas de dépôt git'), 'sans git : exclu');

// ---------------------------------------------------------------------------
section('3. Branche qui a divergé de son distant : historique intact, configuration locale');
const remote = path.join(T, 'remote.git');
g(T, 'init', '-q', '--bare', remote);
d = repo('F');
g(d, 'remote', 'add', 'origin', remote); g(d, 'push', '-q', '-u', 'origin', 'HEAD:main'); g(d, 'branch', '-q', '--set-upstream-to=origin/main');
const other = path.join(T, 'other'); g(T, 'clone', '-q', '-b', 'main', remote, other); fs.writeFileSync(path.join(other, 'x.txt'), 'x'); g(other, 'add', '-A'); g(other, 'commit', '-q', '-m', 'distant'); g(other, 'push', '-q', 'origin', 'HEAD:main');
fs.writeFileSync(path.join(d, 'y.txt'), 'y'); g(d, 'add', '-A'); g(d, 'commit', '-q', '-m', 'local'); g(d, 'fetch', '-q');
const before = g(d, 'rev-parse', 'HEAD').stdout.trim();
r = O.onboardProject({ name: 'F', path: d }, entry);
ok(r.status === 'service' && r.local && g(d, 'rev-parse', 'HEAD').stdout.trim() === before && status(d) === '' && fs.existsSync(path.join(d, '.orchestrateur', 'pipeline.json')), `divergée (+${r.upstream?.ahead}/-${r.upstream?.behind}) : aucun commit, pipeline.json local et ignoré`);

// ---------------------------------------------------------------------------
section('4. Mise en service en bloc, puis retour arrière (par projet et en bloc)');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', projects: [{ name: 'chef', path: T }, { name: 'G', path: repo('G') }, { name: 'C2', path: repo('C2', { dirty: true }) }] }));
fs.writeFileSync(path.join(T, 'plan.json'), JSON.stringify({ G: entry, C2: entry }));
const cli = (script, ...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...a], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: T }, encoding: 'utf8' });
let o = cli('pipeline-onboard.mjs', '--plan', path.join(T, 'plan.json'), '--apply');
let enf = E.readEnforcement(T);
ok(o.status === 0 && enf.projects.join() === 'G' && enf.generalSince, `--apply : G en service, C2 exclu, date de mise en service posée (${enf.generalSince})`, o.stdout + o.stderr);
const rep = JSON.parse(fs.readFileSync(path.join(T, 'logs', 'pipeline-onboarding.json'), 'utf8'));
ok(rep.results.find(x => x.name === 'chef')?.status === 'chef' && rep.results.find(x => x.name === 'C2')?.status === 'exclu', 'rapport : le chef à part, chaque exclusion avec sa raison');
o = cli('pipeline-enforce.mjs', 'on', '--chef'); cli('pipeline-enforce.mjs', 'on', '--terminal');
enf = E.readEnforcement(T);
ok(enf.chef && enf.terminal && enf.generalSince, 'chef en Routage et terminal routé ; la date de mise en service est conservée');
o = cli('pipeline-enforce.mjs', 'off', 'G');
ok(!E.readEnforcement(T).projects.includes('G') && E.readEnforcement(T).chef, 'retour arrière d’UN projet : retiré seul');
o = cli('pipeline-enforce.mjs', 'off', '--all');
enf = E.readEnforcement(T);
ok(!enf.projects.length && !enf.chef && !enf.terminal, 'retour arrière EN BLOC : plus aucun projet, chef et terminal coupés');

// ---------------------------------------------------------------------------
section('5. Relevé : exécutions, hors pipeline, tours ordinaires, refus, pauses, jours sans contournement');
const since = '2026-10-01T00:00:00.000Z';
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' },}, history: [], enforcement: { projects: ['G'], pipelines: ['discussion', 'dev'], generalSince: since } }));
const ev = (o) => JSON.stringify(o);
fs.writeFileSync(path.join(T, 'logs', 'G.jsonl'), [
  ev({ type: 'user_prompt', text: 'ancien', timestamp: '2026-09-30T10:00:00Z' }),
  ev({ type: 'user_prompt', text: 'a', pipeline: { run: 'p1' }, timestamp: '2026-10-02T10:00:00Z' }), ev({ type: 'result', timestamp: '2026-10-02T10:05:00Z' }),
  ev({ type: 'notification', subtype: 'pipeline_limit', timestamp: '2026-10-02T10:06:00Z' }),
  ev({ type: 'user_prompt', text: 'continuer', pipeline: { run: 'p1', answer: 'continuer' }, timestamp: '2026-10-02T11:00:00Z' }),
  ev({ type: 'user_prompt', text: 'b', timestamp: '2026-10-03T10:00:00Z' }), ev({ type: 'result', subtype: 'error_pipeline_refused', timestamp: '2026-10-03T10:00:01Z' }),
  ev({ type: 'user_prompt', text: 'c', pipelineBypass: { reason: 'maintenance' }, timestamp: '2026-10-04T10:00:00Z' }), ev({ type: 'result', timestamp: '2026-10-04T10:01:00Z' }),
  ev({ type: 'user_prompt', text: 'd', timestamp: '2026-10-05T10:00:00Z' }), ev({ type: 'result', timestamp: '2026-10-05T10:01:00Z' }),
].join('\n') + '\n');
fs.writeFileSync(path.join(T, 'logs', 'pipeline-gate.ndjson'), ev({ at: '2026-10-06T09:00:00Z', project: 'G', kind: 'depuis-musicien', code: 65 }) + '\n');
const h = H.computeHealth(T, { now: new Date('2026-10-14T12:00:00Z') });
ok(h.totals.runs === 1 && h.totals.pauses === 1 && h.totals.refus === 1 && h.totals.hors === 1 && h.totals.ordinaires === 1 && h.totals.porte === 1, `compteurs : ${JSON.stringify(h.totals)}`);
ok(h.streakDays === 8 && h.criterion.met, `jours complets sans contournement depuis le dernier (05/10) : ${h.streakDays} — critère des 7 jours atteint`);
const h2 = H.computeHealth(T, { now: new Date('2026-10-09T12:00:00Z') });
ok(h2.streakDays === 3 && !h2.criterion.met, `au 09/10 : ${h2.streakDays} jour(s), critère pas encore atteint`);
ok(h.days.find(x => x.date === '2026-10-05')?.ordinaires === 1 && h.perProject[0].name === 'G', 'détail par jour et par projet');

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
