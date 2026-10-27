#!/usr/bin/env node
// ============================================================================
// scripts/_test_lane_rules.mjs — lane exclusivity rules: detectors and their
// documentation (0.101.0)
// ============================================================================
//
// User request (2026-10-15): « Sauf pour certains cas particuliers sont
// detectes, ils doivent alors etre justifies et documentes. »
//   - each active rule fires on its fixture and only there;
//   - every rule of scripts/lane-rules.mjs has its row (and status) in the §3
//     table of docs/PLAN-parallel-tasks-same-musician.md, and the reverse;
//   - no detector reads the request text (no keyword routing, 0.66.0).
//
//   node scripts/_test_lane_rules.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as R from './lane-rules.mjs';
import * as L from './lanes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lanerules-'));
const g = (dir, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: dir, encoding: 'utf8' });
const repo = (name, files = {}) => {
  const d = path.join(T, name); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  g(d, 'init', '-q', '-b', 'master'); g(d, 'add', '-A'); g(d, 'commit', '-q', '-m', 'init');
  return d;
};
const decide = (project, extra = {}) => R.decide({ project, conductor: 'chef', direct: false, sameTask: false, pipeline: false, dual: false, resources: [], ...extra });

section('1. Chaque règle active se déclenche sur son cas, et seulement là');
{
  const clean = { name: 'P', path: repo('clean') };
  ok(decide(clean).mode === 'parallel' && !decide(clean).rule, 'dépôt propre, tâche du Routage : parallèle, aucune règle');
  const nogit = path.join(T, 'nogit'); fs.mkdirSync(nogit);
  ok(decide({ name: 'N', path: nogit }).rule === 'no-git' && decide({ name: 'N', path: nogit }).mode === 'project', 'no-git : pas de dépôt');
  const empty = path.join(T, 'empty'); fs.mkdirSync(empty); g(empty, 'init', '-q');
  ok(decide({ name: 'E', path: empty }).rule === 'no-git', 'no-git : dépôt sans commit');
  ok(decide({ name: 'M', path: repo('sub', { '.gitmodules': '[submodule "x"]\n' }) }).rule === 'git-unsupported', 'git-unsupported : sous-modules');
  const det = repo('detached'); g(det, 'checkout', '-q', '--detach');
  const dd = decide({ name: 'D', path: det });
  ok(dd.rule === 'git-unsupported' && /HEAD détachée/.test(dd.evidence), 'git-unsupported : HEAD détachée (pas de branche d’intégration)');
  const sp = repo('sparse'); g(sp, 'config', 'core.sparseCheckout', 'true');
  ok(decide({ name: 'S', path: sp }).rule === 'git-unsupported', 'git-unsupported : extraction partielle');
  ok(decide(clean, { direct: true }).rule === 'lane0-direct' && decide(clean, { direct: true }).mode === 'lane0', 'lane0-direct : dialogue direct dans la copie principale');
  // P9 (0.115.0, user « Lances-led »): a new pipeline run goes to a lane; the
  // rule only keeps the resume of a run paused in the main checkout there.
  ok(decide(clean, { pipeline: true }).mode === 'pipeline' && !decide(clean, { pipeline: true }).rule, 'exécution de pipeline neuve : couloir parallèle, aucune règle (P9)');
  const pilot = decide(clean, { pipeline: true, pipelineLanes: false, pipelineLanesWhy: 'P : pilote d’abord' });
  ok(pilot.mode === 'lane0' && pilot.rule === 'pipeline-pilot' && /pilote d’abord/.test(pilot.evidence), 'pipeline-pilot : exécution de pipeline d’un projet hors pilote P9 → copie principale');
  ok(decide(clean, { pipeline: true, pipelineLanes: true }).mode === 'pipeline', 'pipeline-pilot : ne se déclenche pas pour un projet pilote (pipelineLanes)');
  ok(decide(clean, { pipeline: true, pipelineResumeLane0:'p-20261018T100000-abcd' }).rule === 'pipeline-engine' && decide(clean, { pipeline: true, pipelineResumeLane0: 'p-20261018T100000-abcd' }).mode === 'lane0', 'pipeline-engine : reprise d’une exécution en pause dans la copie principale');
  ok(decide(clean, { dual: true }).rule === 'dual-mode', 'dual-mode : mode double en copie principale');
  const dirty = repo('dirty'); fs.writeFileSync(path.join(dirty, 'a.txt'), 'modifié\n');
  ok(decide({ name: 'Y', path: dirty }).rule === 'main-dirty', 'main-dirty : modifications non commitées dans la copie principale');
  ok(!decide({ name: 'Y', path: dirty }, { mainDirtyMatters: false }).rule, 'main-dirty : ignoré quand ces modifications sont celles du tour du couloir 0');
  fs.writeFileSync(path.join(clean.path, 'nouveau.txt'), 'x\n');
  ok(!decide(clean).rule, 'un fichier non suivi ne rend pas la copie « sale »');
  ok(decide(clean, { sameTask: true, sameTaskLanes: [2] }).lane === 2 && decide(clean, { sameTask: true, sameTaskLanes: [2] }).rule === 'same-task', 'same-task : la réponse va au couloir qui attend');
  ok(decide(clean, { sameTask: true, sameTaskLanes: [1, 2] }).mode === 'ambiguous', 'same-task : deux couloirs attendent → ambigu, jamais deviné');
  ok(decide(clean, { laneArg: 1 }).mode === 'lane' && decide(clean, { laneArg: 1 }).lane === 1, 'same-task : --lane désigne le couloir');
  const port = decide({ name: 'P', path: clean.path, port: 5173 }, { resources: ['serveur'] });
  ok(port.mode === 'parallel' && port.resources.some(r => r.rule === 'port' && r.key === 'port-5173'), 'port : ressource « port-5173 » (le reste de la tâche reste parallèle)');
  const self = repo('self', { '.orchestrateur-instance.json': JSON.stringify({ port: 7778 }) });
  ok(decide({ name: 'O', path: self }, { resources: ['serveur'] }).resources.some(r => r.rule === 'orchestrator-self' && r.key === 'port-7778'), 'orchestrator-self : port du bac à sable de l’instance');
  ok(!decide({ name: 'O', path: self }).resources.length, 'sans « serveur » déclaré, aucune ressource : les suites tournent dans la copie du couloir');
  ok(decide(clean, { resources: ['appareil'] }).resources.some(r => r.rule === 'adb-device'), 'adb-device : appareil déclaré');
  ok(decide(clean, { resources: ['base'] }).resources.some(r => r.rule === 'database'), 'database : base déclarée');
  const mig = decide(clean, { resources: ['migration'] });
  ok(mig.mode === 'alone' && mig.rule === 'migration' && mig.resources.some(r => r.key === 'db'), 'migration : seule, et tient la base');
  ok(decide(clean, { resources: ['poste'] }).mode === 'alone' && decide(clean, { resources: ['poste'] }).rule === 'machine-state', 'machine-state : seule');
  ok(decide({ name: 'chef', path: clean.path }).rule === 'chef', 'chef : exempté');
  const pr = R.parseResources('serveur, base,inconnu');
  ok(pr.list.join(',') === 'serveur,base' && pr.unknown.join(',') === 'inconnu', 'liste fermée des ressources déclarées : un inconnu est signalé, jamais interprété');
}

section('2. Les règles sont documentées : registre ↔ tableau §3 du document de conception');
{
  const doc = fs.readFileSync(path.join(ROOT, R.DOC), 'utf8');
  const documented = R.documentedRuleIds(doc);
  const ids = R.RULES.map(r => r.id);
  const missingDoc = ids.filter(i => !documented.includes(i)), missingCode = documented.filter(i => !ids.includes(i));
  ok(!missingDoc.length && !missingCode.length, `${ids.length} règles, toutes documentées et toutes codées`, `non documentées : ${missingDoc} — absentes du registre : ${missingCode}`);
  const sec = /##\s*3\.[\s\S]*?(?=\n##\s*4\.)/.exec(doc)[0];
  const bad = R.RULES.filter(r => { const row = new RegExp(`^\\|\\s*\`${r.id}\`\\s*\\|.*$`, 'm').exec(sec)?.[0] || ''; return !row.includes(`| ${r.status} |`) || !row.includes(`| ${r.scope} |`); });
  ok(!bad.length, 'chaque ligne porte la portée et le statut (active / planned) du registre', bad.map(r => r.id).join(', '));
  ok(R.RULES.every(r => r.text && r.text.length > 20), 'chaque règle a une justification en clair (affichée à l’utilisateur)');
}

section('3. Aucun détecteur ne lit le texte de la demande (pas de routage par mots-clés)');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lane-rules.mjs'), 'utf8');
  ok(!/\b(prompt|text)\s*\.\s*(match|test|includes)|\.test\(\s*(prompt|input\.prompt|text)/.test(src) && !/input\.prompt/.test(src), 'lane-rules.mjs ne reçoit ni n’examine la demande');
}

section('4. Limite de concurrence');
{
  ok(L.maxParallelFor({}, {}) === 2, 'défaut : 2 (décision utilisateur Q1, 0.103.0)');
  ok(L.maxParallelFor({}, { maxParallel: 1 }) === 1, '1 explicite : comportement 0.67.0');
  ok(L.maxParallelFor({ defaults: { maxParallel: 2 } }, {}) === 2 && L.maxParallelFor({ defaults: { maxParallel: 2 } }, { maxParallel: 3 }) === 3, 'projet, puis defaults');
  ok(L.maxParallelFor({}, { maxParallel: 99 }) === L.HARD_CAP && L.HARD_CAP === 4 && L.maxParallelFor({}, { maxParallel: 0 }) === 1, 'plafond dur 4, valeur invalide = 1');
  const f0 = L.laneFiles('/l', 'P', 0);
  ok(f0.log === path.join('/l', 'P.jsonl') && f0.session === path.join('/l', 'P.session') && f0.pid === path.join('/l', 'P.pid') && f0.lock === path.join('/l', 'P.turnlock'), 'couloir 0 : les noms de fichiers d’aujourd’hui, inchangés');
  ok(L.bumpVersion('0.100.3', 'minor') === '0.101.0' && L.bumpVersion('1.2.3', 'patch') === '1.2.4' && L.bumpVersion('1.2.3', 'major') === '2.0.0', 'bump de version');
}

section('5. Un dispatch du chef ou de la file n’est pas un dialogue direct (demande du 2026-10-27)');
{
  // Real case (2026-10-27, BookHaven): the chef's dispatches carry no --source,
  // so dispatch.mjs took them for the user's direct dialogue (lane0-direct).
  const direct = (o) => (typeof R.isDirectDialogue === 'function' ? R.isDirectDialogue(o) : 'fonction absente');
  const user = { sourceProject: null, laneArg: null, pipelineResume: false, turnOf: null, fromQueue: false, poolAssign: false };
  ok(direct(user) === true, 'message de l’utilisateur (sans source, hors tour, hors file) : dialogue direct');
  ok(direct({ ...user, turnOf: 'chef' }) === false, 'dispatch lancé depuis le tour du chef (ORCH_TURN_PROJECT) : pas direct');
  ok(direct({ ...user, turnOf: 'chef-2' }) === false, 'dispatch lancé depuis le tour d’un slot du chef : pas direct');
  ok(direct({ ...user, fromQueue: true }) === false, 'demande venue de la file (--no-queue-if-busy) : pas direct');
  ok(direct({ ...user, poolAssign: true }) === false, 'remplissage de slot par le serveur : pas direct');
  ok(direct({ ...user, sourceProject: 'chef' }) === false, 'avec --source : pas direct');
  ok(direct({ ...user, laneArg: 1 }) === false && direct({ ...user, pipelineResume: true }) === false, '--lane ou reprise de pause : pas direct');
  // And with the lane-0 rule no longer firing, a busy lane 0 + clean tree means a parallel lane.
  const clean = { name: 'P', path: repo('chefcase') };
  ok(decide(clean, { direct: direct({ ...user, turnOf: 'chef' }) }).mode === 'parallel', 'dispatch du chef, copie propre : mode parallèle (couloir k ≥ 1 si le 0 est occupé)');
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
