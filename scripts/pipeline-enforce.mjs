#!/usr/bin/env node
// ============================================================================
// scripts/pipeline-enforce.mjs — mise en service des pipelines (phase 3, 0.48.0)
// ============================================================================
//
//   node scripts/pipeline-enforce.mjs                 état
//   node scripts/pipeline-enforce.mjs on  <projet>    met le projet en service
//   node scripts/pipeline-enforce.mjs off <projet>    le retire
//   node scripts/pipeline-enforce.mjs off --all       retour arrière complet
//
// Écrit model-routing.json → enforcement (temp + rename, historique), relu à
// chaque dispatch : aucun redémarrage. Les cases (models) ne sont pas touchées.
// En service : toute demande au projet passe par Discussion ou Développement
// léger ; un musicien ne peut plus y lancer de tour ; --model y est refusé.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnforcement, writeEnforcement, ENGINE_PIPELINES } from './pipeline-engine.mjs';

const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, target] = process.argv.slice(2);
const cur = readEnforcement(ROOT);
const show = (e) => console.log(`en service : ${e.projects.length ? e.projects.join(', ') : '(aucun projet)'} — pipelines : ${e.pipelines.join(', ')}${e.since ? ` — depuis ${e.since}${e.by ? ` (${e.by})` : ''}` : ''}`);

if (!cmd || cmd === 'status') { show(cur); process.exit(0); }
if (!['on', 'off'].includes(cmd) || !target) {
  console.error('usage: node scripts/pipeline-enforce.mjs [status] | on <projet> | off <projet> | off --all');
  process.exit(64);
}
let projects = cur.projects;
if (cmd === 'off' && target === '--all') projects = [];
else {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if (cmd === 'on' && !config.projects.some(p => p.name === target)) { console.error(`projet inconnu : ${target}`); process.exit(64); }
  projects = cmd === 'on' ? [...projects, target] : projects.filter(p => p !== target);
}
show(writeEnforcement(ROOT, { projects, pipelines: cur.pipelines.length ? cur.pipelines : ENGINE_PIPELINES, by: `pipeline-enforce ${cmd} ${target}` }));
