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
//   node scripts/pipeline-enforce.mjs off --all       retour arrière complet (réglages compris)
//   node scripts/pipeline-enforce.mjs tuning          interrupteurs de la phase 0 des pipelines
//   node scripts/pipeline-enforce.mjs tuning <levier|all> on|off [<projet>]
//                                                     sans projet : tous les projets ; avec : ce projet
//   node scripts/pipeline-enforce.mjs tuning-values [--items N] [--run-min N] [--review-batch N] [--red-green-max N] | --reset
//                                                     valeurs des leviers « vitesse » (0.143.0) : limites (25 tests, 150 min),
//                                                     relecture groupée (3 items), test + code en un appel (≤ 2 tests)
//   node scripts/pipeline-enforce.mjs kg [off|shadow|assist]
//                                                     index de connaissances (KG phase 0 b) ; off = rien ne tourne
//   node scripts/pipeline-enforce.mjs kg <build|extract|ui> on|off
//                                                     KG phase 1 : reconstruction auto, extraction par model, onglet Mémoire
//   node scripts/pipeline-enforce.mjs chef-shadow [on|off]
//                                                     tour unique v3 du chef EN OMBRE (Routage v3 phase 2) :
//                                                     à côté de chaque message, un plan sans aucun effet,
//                                                     journal logs/chef-shadow/ ; le chef réel ne change pas
//   node scripts/pipeline-enforce.mjs chef-alerts [on|off] [--stall-min N]
//                                                     alertes du chef (0.138.0) : non-régression KO ou interrompue,
//                                                     pause de processus, musicien bloqué → un réveil par événement
//   node scripts/pipeline-enforce.mjs idle-regression [on|off] [<projet>] [--idle-min N]
//                                                     non-régression a posteriori (0.142.0) : livraison et mise en prod
//                                                     sur les tests de la tâche ; complète lancée par le programme
//                                                     pendant l'inactivité de l'utilisateur (défaut 30 min)
//   node scripts/pipeline-enforce.mjs chef-mode       mode du chef : off | routage (« v3 » : phase 4, bascule)
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
import { readTuning, applyTuningChange, describeTuning, readChefV3, writeChefV3, readTuningValues, parseValueArgs, describeValues } from './pipeline-tuning.mjs';
import { readAlertSettings, writeAlertSettings, describeSettings as describeAlerts } from './chef-alerts.mjs';
import { readSettings as readIdleRegression, writeSettings as writeIdleRegression, describeSettings as describeIdleRegression } from './idle-regression.mjs';
import { readKgSettings, writeKgSettings, writeKgSwitch, KG_SWITCHES, MODES as KG_MODES } from './kg.mjs';


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
// tuning (pipelines phase 0): one switch per lever, re-read at each dispatch;
// a run keeps the settings it read when it started (run.json.tuning).
if (cmd === 'tuning') {
  const [, lever, onOff, project] = process.argv.slice(2);
  if (!lever) { console.log(describeTuning(readTuning(ROOT))); process.exit(0); }
  if (!['on', 'off'].includes(onOff)) { console.error('usage: node scripts/pipeline-enforce.mjs tuning [<levier|all> on|off [<projet>]]'); process.exit(64); }
  if (project) {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (!config.projects.some(p => p.name === project)) { console.error(`projet inconnu : ${project}`); process.exit(64); }
  }
  let tuning;
  try { tuning = applyTuningChange(readTuning(ROOT), { on: onOff === 'on', lever, project }); } catch (e) { console.error(e.message); process.exit(64); }
  writeEnforcement(ROOT, { projects: cur.projects, terminal: cur.terminal, chef: cur.chef, pipelines: cur.pipelines.length ? cur.pipelines : ENGINE_PIPELINES, tuning, by: `pipeline-enforce tuning ${lever} ${onOff}${project ? ` ${project}` : ''}` });
  console.log(describeTuning(readTuning(ROOT)));
  process.exit(0);
}
// tuning-values (0.143.0): values of the « vitesse » levers, re-read at each
// dispatch, frozen in run.json when a run starts; they apply only while their
// lever is on (tuning limits|groupReview|redGreen on).
if (cmd === 'tuning-values') {
  const rest = process.argv.slice(3);
  if (!rest.length) { console.log(describeValues(readTuningValues(ROOT))); process.exit(0); }
  let values;
  if (rest.length === 1 && rest[0] === '--reset') values = {};
  else {
    try { values = { ...readTuningValues(ROOT), ...parseValueArgs(rest) }; } catch (e) { console.error(e.message); process.exit(64); }
  }
  writeEnforcement(ROOT, { projects: cur.projects, terminal: cur.terminal, chef: cur.chef, pipelines: cur.pipelines.length ? cur.pipelines : ENGINE_PIPELINES, tuningValues: values, by: `pipeline-enforce tuning-values ${rest.join(' ')}` });
  console.log(describeValues(readTuningValues(ROOT)));
  process.exit(0);
}
// kg (knowledge index, phase 0 b): off | shadow | assist, re-read at every call.
// Phase 0 b injects nothing: shadow and assist only allow building and querying.
if (cmd === 'kg') {
  const kgLine = (k) => `kg.mode = ${k.mode}${k.since ? ` depuis ${k.since} (${k.by})` : ''} — build : ${k.build ? 'on' : 'off'}, extract : ${k.extract ? 'on' : 'off'}${k.cutoff ? ` (${k.cutoff.why})` : ''}, ui : ${k.ui ? 'on' : 'off'}`;
  if (!target) { console.log(kgLine(readKgSettings(ROOT))); process.exit(0); }
  // Phase 1: kg <build|extract|ui> on|off — one switch, effective only while the mode is not off.
  if (KG_SWITCHES.includes(target)) {
    const onOff = process.argv[4];
    if (!['on', 'off'].includes(onOff)) { console.error(`usage: node scripts/pipeline-enforce.mjs kg ${target} on|off`); process.exit(64); }
    try { console.log(kgLine(writeKgSwitch(ROOT, { key: target, on: onOff === 'on', by: `pipeline-enforce kg ${target} ${onOff}` }))); } catch (e) { console.error(e.message); process.exit(64); }
    process.exit(0);
  }
  if (!KG_MODES.includes(target)) { console.error(`usage: node scripts/pipeline-enforce.mjs kg [${KG_MODES.join('|')}] | kg <${KG_SWITCHES.join('|')}> on|off`); process.exit(64); }
  const k = writeKgSettings(ROOT, { mode: target, by: `pipeline-enforce kg ${target}` });
  console.log(`kg.mode = ${k.mode}${k.mode === 'off' ? ' (index arrêté : rien ne tourne)' : ' (phase 0 b : construction et requêtes seulement, aucune injection)'}`);
  process.exit(0);
}
// chef-shadow (Routage v3, phase 2): the chef's single turn in shadow, without any effect.
if (cmd === 'chef-shadow') {
  if (!target) { const c = readChefV3(ROOT); console.log(`chefV3.shadow = ${c.shadow ? 'on' : 'off'}${c.since ? ` depuis ${c.since} (${c.by})` : ''}`); process.exit(0); }
  if (!['on', 'off'].includes(target)) { console.error('usage: node scripts/pipeline-enforce.mjs chef-shadow [on|off]'); process.exit(64); }
  const c = writeChefV3(ROOT, { shadow: target === 'on', by: `pipeline-enforce chef-shadow ${target}` });
  console.log(`chefV3.shadow = ${c.shadow ? 'on (à chaque message de l’utilisateur au chef : plan en ombre, aucun effet ; journal logs/chef-shadow/, node scripts/chef-turn.mjs list)' : 'off (rien ne tourne en ombre)'}`);
  process.exit(0);
}
// chef-alerts (0.138.0): the server wakes the chef once per event (scripts/chef-alerts.mjs).
if (cmd === 'chef-alerts') {
  if (!target) { console.log(describeAlerts(readAlertSettings(ROOT))); process.exit(0); }
  const rest = process.argv.slice(4);
  const sm = rest.indexOf('--stall-min');
  if (!['on', 'off'].includes(target) || (sm !== -1 && !rest[sm + 1])) { console.error('usage: node scripts/pipeline-enforce.mjs chef-alerts [on|off] [--stall-min N]'); process.exit(64); }
  try { console.log(describeAlerts(writeAlertSettings(ROOT, { enabled: target === 'on', stallMin: sm !== -1 ? rest[sm + 1] : null, by: `pipeline-enforce chef-alerts ${target}` }))); } catch (e) { console.error(e.message); process.exit(64); }
  process.exit(0);
}
// idle-regression (0.142.0): full non-regression after the fact, idle hours only (scripts/idle-regression.mjs).
if (cmd === 'idle-regression') {
  if (!target) { console.log(describeIdleRegression(readIdleRegression(ROOT))); process.exit(0); }
  const rest = process.argv.slice(4);
  const im = rest.indexOf('--idle-min');
  const project = rest.find((a, i) => !a.startsWith('--') && (im === -1 || i !== im + 1)) || null;
  if (!['on', 'off'].includes(target) || (im !== -1 && !rest[im + 1])) { console.error('usage: node scripts/pipeline-enforce.mjs idle-regression [on|off] [<projet>] [--idle-min N]'); process.exit(64); }
  if (project) {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (!config.projects.some(p => p.name === project)) { console.error(`projet inconnu : ${project}`); process.exit(64); }
  }
  try { console.log(describeIdleRegression(writeIdleRegression(ROOT, { enabled: target === 'on', idleMin: im !== -1 ? rest[im + 1] : null, project, by: `pipeline-enforce idle-regression ${target}${project ? ` ${project}` : ''}` }))); } catch (e) { console.error(e.message); process.exit(64); }
  process.exit(0);
}
// chef-mode (ROUTAGE-SYNTHESE §3.9): « off » = ordinary chef turns, « routage » = the Routage pipeline.
// « v3 » is the switch-over of phase 4 (a user decision): refused here.
if (cmd === 'chef-mode') {
  if (!target) { console.log(`chefMode = ${cur.chef ? 'routage' : 'off'} — ombre v3 : ${readChefV3(ROOT).shadow ? 'on' : 'off'}`); process.exit(0); }
  if (target === 'v3') { console.error('chefMode v3 : bascule de la phase 4 (décision de l’utilisateur) — pas encore disponible ; l’ombre : chef-shadow on'); process.exit(64); }
  if (!['off', 'routage'].includes(target)) { console.error('usage: node scripts/pipeline-enforce.mjs chef-mode [off|routage]'); process.exit(64); }
  show(writeEnforcement(ROOT, { projects: cur.projects, terminal: cur.terminal, chef: target === 'routage', pipelines: cur.pipelines.length ? cur.pipelines : ENGINE_PIPELINES, by: `pipeline-enforce chef-mode ${target}` }));
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
const tuning = cmd === 'off' && target === '--all' ? {} : undefined;
show(writeEnforcement(ROOT, { projects, terminal, chef, pipelines: cur.pipelines.length ? cur.pipelines : ENGINE_PIPELINES, tuning, tuningValues: tuning, by: `pipeline-enforce ${cmd} ${target}` }));
if (cmd === 'off' && target === '--all' && readKgSettings(ROOT).mode !== 'off') writeKgSettings(ROOT, { mode: 'off', by: 'pipeline-enforce off --all' });
if (cmd === 'off' && target === '--all' && readAlertSettings(ROOT).enabled) writeAlertSettings(ROOT, { enabled: false, by: 'pipeline-enforce off --all' });
if (cmd === 'off' && target === '--all' && readIdleRegression(ROOT).enabled) writeIdleRegression(ROOT, { enabled: false, by: 'pipeline-enforce off --all' });
if (cmd === 'off' && target === '--all' && readChefV3(ROOT).shadow) writeChefV3(ROOT, { shadow: false, by: 'pipeline-enforce off --all' });
