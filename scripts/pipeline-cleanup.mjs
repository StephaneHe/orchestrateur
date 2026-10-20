#!/usr/bin/env node
// ============================================================================
// scripts/pipeline-cleanup.mjs — removes the inert accepted additions from
// model-routing.json, with a backup (pipelines phase 0 d, user decision 7)
// ============================================================================
//
//   node scripts/pipeline-cleanup.mjs [plan]          what would be removed (writes nothing)
//   node scripts/pipeline-cleanup.mjs apply [--by <qui>]
//        backup model-routing.json.bak-cleanup-<date> (byte for byte), then
//        removes the custom pipelines the engine cannot run and the
//        attachments that still carry keywords; history entry; idempotent
//   node scripts/pipeline-cleanup.mjs restore <backup>
//        puts back the removed additions found in that backup (nothing else
//        of the current file changes)
//
// What is « inert »: scripts/inert-custom.mjs. The switch `inertCleanup`
// (pipeline-enforce.mjs tuning) hides them from the readers without writing.
// Root: DISPATCH_ROOT_FOR_TESTS, else this checkout.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inertCustom, withoutInert } from './inert-custom.mjs';
import { renameRetry } from './atomic-file.mjs';

const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'model-routing.json');
const [cmd = 'plan', arg] = process.argv.slice(2);
const flag = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };

function readRouting() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.error(`model-routing.json illisible (${e.code || e.message}) : rien n’est fait`); process.exit(2); }
}
function writeRouting(j) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  renameRetry(tmp, FILE);
}
const describe = (inert) => [
  ...inert.pipelines.map(p => `  - pipeline « ${p.id} » (${p.label.slice(0, 80)}) : le moteur ne sait pas l’exécuter`),
  ...inert.attach.map(a => `  - rattachement à « ${a.pipeline} » à mots-clés (ancien, avant 0.66.0) : ${a.when.slice(0, 90)}`),
].join('\n');

if (cmd === 'plan') {
  const inert = inertCustom(readRouting().custom);
  const n = inert.pipelines.length + inert.attach.length;
  console.log(n ? `${n} ajout(s) inerte(s) à retirer :\n${describe(inert)}` : 'aucun ajout inerte');
  process.exit(0);
}
if (cmd === 'apply') {
  const j = readRouting();
  const inert = inertCustom(j.custom);
  if (!inert.pipelines.length && !inert.attach.length) { console.log('aucun ajout inerte : rien à retirer'); process.exit(0); }
  const at = new Date().toISOString();
  const backup = `${FILE}.bak-cleanup-${at.replace(/[:.]/g, '-')}`;
  fs.copyFileSync(FILE, backup);
  j.custom = withoutInert(j.custom);
  j.history = Array.isArray(j.history) ? j.history : [];
  j.history.push({ at, task: 'cleanup', from: `${inert.pipelines.length} pipeline(s) non exécutable(s), ${inert.attach.length} rattachement(s) à mots-clés`, to: 'retirés', by: flag('--by') || 'pipeline-cleanup (décision 7)', backup: path.basename(backup) });
  if (j.history.length > 500) j.history = j.history.slice(-500);
  j.updatedAt = at;
  writeRouting(j);
  console.log(`retiré(s) :\n${describe(inert)}\nsauvegarde : ${backup}\nretour arrière : node scripts/pipeline-cleanup.mjs restore "${backup}"`);
  process.exit(0);
}
if (cmd === 'restore') {
  if (!arg) { console.error('usage: node scripts/pipeline-cleanup.mjs restore <sauvegarde>'); process.exit(64); }
  const bak = path.resolve(arg);
  if (path.dirname(bak) !== ROOT || !path.basename(bak).startsWith('model-routing.json.bak-cleanup-')) { console.error('sauvegarde attendue : model-routing.json.bak-cleanup-… à la racine'); process.exit(64); }
  let old; try { old = JSON.parse(fs.readFileSync(bak, 'utf8')); } catch { console.error(`sauvegarde illisible : ${bak}`); process.exit(2); }
  const j = readRouting();
  j.custom = j.custom && typeof j.custom === 'object' ? j.custom : {};
  const inert = inertCustom(old.custom);
  const pipes = (old.custom?.pipelines || []).filter(p => inert.pipelines.some(x => x.id === p.id) && !(j.custom.pipelines || []).some(c => c.id === p.id));
  const atts = inert.attach.map(a => old.custom.attach[a.index]).filter(a => !(j.custom.attach || []).some(c => JSON.stringify(c) === JSON.stringify(a)));
  if (pipes.length) j.custom.pipelines = [...(j.custom.pipelines || []), ...pipes];
  if (atts.length) j.custom.attach = [...(j.custom.attach || []), ...atts];
  const at = new Date().toISOString();
  j.history = Array.isArray(j.history) ? j.history : [];
  j.history.push({ at, task: 'cleanup-restore', from: 'retirés', to: `${pipes.length} pipeline(s), ${atts.length} rattachement(s) remis`, by: flag('--by') || 'pipeline-cleanup restore', backup: path.basename(bak) });
  j.updatedAt = at;
  writeRouting(j);
  console.log(`remis : ${pipes.length} pipeline(s), ${atts.length} rattachement(s)`);
  process.exit(0);
}
console.error('usage: node scripts/pipeline-cleanup.mjs [plan] | apply [--by <qui>] | restore <sauvegarde>');
process.exit(64);
