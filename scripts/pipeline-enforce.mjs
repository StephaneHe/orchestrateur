#!/usr/bin/env node
// ============================================================================
// scripts/pipeline-enforce.mjs — mise en service des pipelines (phase 3, 0.48.0)
// ============================================================================
//
//   node scripts/pipeline-enforce.mjs                 état
//   node scripts/pipeline-enforce.mjs on  <projet>    met le projet en service
//   node scripts/pipeline-enforce.mjs off <projet>    le retire
//   node scripts/pipeline-enforce.mjs on  --terminal  terminal interactif routé (0.52.0)
//   node scripts/pipeline-enforce.mjs off --terminal
//   node scripts/pipeline-enforce.mjs on  --chef      tour du chef = pipeline Routage (0.54.0)
//   node scripts/pipeline-enforce.mjs off --chef
//   node scripts/pipeline-enforce.mjs pipelines all   pipelines en service (0.53.0 ; ou une liste a,b,c)
//   node scripts/pipeline-enforce.mjs off --all       retour arrière complet
//
// Écrit model-routing.json → enforcement (temp + rename, historique), relu à
// chaque dispatch : aucun redémarrage. Les cases (models) ne sont pas touchées.
// En service : toute demande au projet passe par Discussion ou Développement ;
// un musicien ne peut plus y lancer de tour ; --model y est refusé.
// Terminal routé : le terminal central démarre en Discussion (lecture seule) à
// son prochain lancement, et une ligne d'action est retenue pour confirmation.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnforcement, writeEnforcement, ENGINE_PIPELINES } from './pipeline-engine.mjs';

const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, target] = process.argv.slice(2);
const cur = readEnforcement(ROOT);
const show = (e) => console.log(`en service : ${e.projects.length ? e.projects.join(', ') : '(aucun projet)'} — pipelines : ${e.pipelines.join(', ')} — terminal routé : ${e.terminal ? 'oui' : 'non'} — chef en Routage : ${e.chef ? 'oui' : 'non'}${e.since ? ` — depuis ${e.since}${e.by ? ` (${e.by})` : ''}` : ''}`);

if (!cmd || cmd === 'status') { show(cur); process.exit(0); }
// pipelines <liste|all> (0.53.0) : quels pipelines sont en service sur les projets en service.
if (cmd === 'pipelines') {
  const want = target === 'all' ? ENGINE_PIPELINES : String(target || '').split(',').map(s => s.trim()).filter(Boolean);
  const bad = want.filter(p => !ENGINE_PIPELINES.includes(p));
  if (!want.length || bad.length) { console.error(`pipelines inconnus : ${bad.join(', ') || '(aucun)'} — connus : ${ENGINE_PIPELINES.join(', ')}`); process.exit(64); }
  if (!want.includes('discussion')) { console.error('« discussion » reste toujours en service (règle « inclassable = Discussion »)'); process.exit(64); }
  show(writeEnforcement(ROOT, { projects: cur.projects, terminal: cur.terminal, chef: cur.chef, pipelines: want, by: `pipeline-enforce pipelines ${want.join(',')}` }));
  process.exit(0);
}
if (!['on', 'off'].includes(cmd) || !target) {
  console.error('usage: node scripts/pipeline-enforce.mjs [status] | on <projet> | off <projet> | on|off --terminal | on|off --chef | pipelines <liste|all> | off --all');
  process.exit(64);
}
let projects = cur.projects;
let terminal = cur.terminal;
let chef = cur.chef;
if (target === '--terminal') terminal = cmd === 'on';
else if (target === '--chef') chef = cmd === 'on';
else if (cmd === 'off' && target === '--all') { projects = []; terminal = false; chef = false; }
else {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if (cmd === 'on' && !config.projects.some(p => p.name === target)) { console.error(`projet inconnu : ${target}`); process.exit(64); }
  projects = cmd === 'on' ? [...projects, target] : projects.filter(p => p !== target);
}
show(writeEnforcement(ROOT, { projects, terminal, chef, pipelines: cur.pipelines.length ? cur.pipelines : ENGINE_PIPELINES, by: `pipeline-enforce ${cmd} ${target}` }));
