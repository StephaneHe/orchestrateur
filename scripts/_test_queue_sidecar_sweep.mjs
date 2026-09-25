#!/usr/bin/env node
// ============================================================================
// scripts/_test_queue_sidecar_sweep.mjs — le balayage de logs/queue/
// ============================================================================
//
// `loadQueuesFromDisk()` supprime tout `logs/queue/<x>.json` dont `<x>` n'est
// pas un projet connu : un sidecar de file laissé par un projet retiré de
// config.json ne doit pas traîner. Mais le dossier héberge aussi des sidecars
// qui ne sont PAS des files par musicien — `chef.pool.json` (0.22.0) et
// `chef.wake.json`. Leur basename (`chef.pool`, `chef.wake`) n'est évidemment
// aucun projet : ils étaient donc détruits à CHAQUE démarrage, avant même que
// loadPoolFromDisk()/loadWakeFromDisk() ne les lisent. Constaté le 24/09/2026 :
// le ticket « Status ? » en vol au redémarrage s'est évaporé sans une ligne de
// journal.
//
// On charge ici le VRAI bloc de server.js dans un bac à sable, comme
// _test_pool_p0a.mjs. Aucun fichier du projet n'est touché.
//
//   node scripts/_test_queue_sidecar_sweep.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const START = SRC.indexOf('function queueSidecarPath(');
const END   = SRC.indexOf('loadQueuesFromDisk();');
if (START < 0 || END < 0 || END < START) {
  console.error('[test-sweep] bornes du bloc file introuvables dans server.js');
  process.exit(2);
}
const BLOCK = SRC.slice(START, END);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sweep-'));
const QUEUE_DIR = path.join(tmp, 'queue');
fs.mkdirSync(QUEUE_DIR, { recursive: true });

const config = { projects: [{ name: 'chef' }, { name: 'vuBox' }] };
const dispatchQueue = new Map();
const debugLog = () => {};

const sandbox = new Function(
  'fs', 'path', 'QUEUE_DIR', 'config', 'dispatchQueue', 'debugLog',
  `${BLOCK}\n return { loadQueuesFromDisk, persistQueue, queueSidecarPath };`,
)(fs, path, QUEUE_DIR, config, dispatchQueue, debugLog);

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  [ok]   ${l}`); } else { fail++; console.log(`  [FAIL] ${l}`); } };
const exists = f => fs.existsSync(path.join(QUEUE_DIR, f));

const write = (f, o) => fs.writeFileSync(path.join(QUEUE_DIR, f), JSON.stringify(o));
write('chef.pool.json', { v: 1, queue: [{ id: 't1', text: 'Status ?' }], slots: [] });
write('chef.wake.json', { v: 1, items: [{ id: 'w1' }] });
write('vuBox.json', [{ prompt: 'salut' }]);
write('projetDisparu.json', [{ prompt: 'orphelin' }]);

console.log('\n── Balayage au boot');
sandbox.loadQueuesFromDisk();

ok(exists('chef.pool.json'), 'chef.pool.json survit (lu plus tard par loadPoolFromDisk)');
ok(exists('chef.wake.json'), 'chef.wake.json survit (lu plus tard par loadWakeFromDisk)');
ok(exists('vuBox.json'),     'la file du musicien vuBox survit');
ok(!exists('projetDisparu.json'), "le sidecar d'un projet retiré de config est bien supprimé");
ok(dispatchQueue.get('vuBox')?.length === 1, 'la file de vuBox est réhydratée');
ok(!dispatchQueue.has('chef.pool'), 'chef.pool n’est jamais pris pour une file de musicien');
ok(!dispatchQueue.has('chef.wake'), 'chef.wake n’est jamais pris pour une file de musicien');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
