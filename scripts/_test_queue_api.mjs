#!/usr/bin/env node
// ============================================================================
// scripts/_test_queue_api.mjs — retirer une tâche de file sans redémarrer
// ============================================================================
//
// Incident du 25/09/2026 : la file d'un musicien ne se modifiait qu'en éditant
// logs/queue/<projet>.json, que le serveur ignore (mémoire = vérité) puis
// réécrit — deux tâches déjà faites sont revenues en tête de TranslateOverlay.
//
// Ce harnais charge, depuis server.js, le BLOC RÉEL de la file par musicien
// (de `const dispatchQueue` à l'appel `loadQueuesFromDisk();`) et le BLOC RÉEL
// des routes /api/queue, les monte sur un vrai express sur un port éphémère,
// puis pilote le VRAI scripts/queue.mjs contre lui (ORCH_PORT). Le serveur de
// production (7777) n'est jamais contacté ; tout vit dans un dossier temporaire.
//
//   node scripts/_test_queue_api.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
function slice(from, to) {
  const a = SRC.indexOf(from), b = SRC.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`bornes introuvables : ${from} … ${to}`);
  return SRC.slice(a, b);
}
const QUEUE_SRC  = slice('const dispatchQueue = new Map()', 'loadQueuesFromDisk();');
const ROUTES_SRC = slice('function queueProjectOr404', "app.delete('/api/pool/queue/:ticket'");

let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const scenario = (n) => console.log(`\n── ${n}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-api-'));
const LOGS_DIR = path.join(TMP, 'logs');
fs.mkdirSync(path.join(LOGS_DIR, 'queue'), { recursive: true });
const config = { projects: [{ name: 'Alpha' }, { name: 'Beta' }] };

// ---------- 1. migration au boot : ids attribués, ordre et contenu intacts --

scenario('boot : les entrées sans id reçoivent un id stable, rien d’autre ne bouge');
const legacy = [
  { prompt: 'tâche hébreu (déjà faite)', attachmentPaths: [], videoPaths: [], callback: 'chef', model: 'claude-opus-5' },
  { prompt: 'créer le repo GitHub', attachmentPaths: [], videoPaths: [], callback: 'chef' },
  { prompt: 'bug des images', attachmentPaths: ['x.png'], videoPaths: [] },
];
fs.writeFileSync(path.join(LOGS_DIR, 'queue', 'Alpha.json'), JSON.stringify(legacy));

function boot() {
  // eslint-disable-next-line no-new-func
  return new Function('fs', 'path', 'crypto', 'LOGS_DIR', 'config', 'debugLog',
    `${QUEUE_SRC}\nloadQueuesFromDisk();\nreturn { dispatchQueue, queuePush, queueRemove, queueClear, queueEntryView, persistQueue };`)(
    fs, path, crypto, LOGS_DIR, config, () => {});
}
let Q = boot();
const alpha = Q.dispatchQueue.get('Alpha');
ok(alpha.length === 3 && alpha.every(e => /^q-\d+-[0-9a-f]{4}$/.test(e.id)), 'chaque entrée a un id');
ok(alpha.map(e => e.prompt).join('|') === legacy.map(e => e.prompt).join('|'), 'ordre et prompts inchangés');
ok(alpha[0].callback === 'chef' && alpha[0].model === 'claude-opus-5', 'callback et model conservés');
const idsFirstBoot = alpha.map(e => e.id);
Q = boot();
ok(Q.dispatchQueue.get('Alpha').map(e => e.id).join() === idsFirstBoot.join(), 'les ids sont persistés : identiques au boot suivant');

// ---------- 2. API + CLI réels ----------------------------------------------

const app = express();
// eslint-disable-next-line no-new-func
new Function('app', 'config', 'dispatchQueue', 'queueRemove', 'queueClear', 'queueEntryView',
  'dispatchPidAliveAsync', 'console', 'debugLog', ROUTES_SRC)(
  app, config, Q.dispatchQueue, Q.queueRemove, Q.queueClear, Q.queueEntryView,
  async (n) => (n === 'Alpha' ? 4242 : null), { log: () => {} }, () => {});
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const PORT = server.address().port;

// spawnSync bloquerait la boucle d'événements qui sert justement l'API :
// on lance donc le CLI en asynchrone.
import { spawn } from 'node:child_process';
function cli(...args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'queue.mjs'), ...args], {
      cwd: ROOT, env: { ...process.env, ORCH_PORT: String(PORT) },
    });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}
const http = async (method, p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method });
  return { status: r.status, body: await r.json().catch(() => null) };
};

scenario('GET /api/queue/:project et queue.mjs --list');
{
  const r = await http('GET', '/api/queue/Alpha');
  ok(r.status === 200 && r.body.count === 3 && r.body.busy === true, 'liste : 3 entrées, musicien occupé');
  const e = r.body.entries[0];
  ok(e.id === idsFirstBoot[0] && e.position === 1 && /hébreu/.test(e.head) && e.callback === 'chef' && e.model === 'claude-opus-5' && e.enqueuedAt,
     'chaque entrée expose id, position, extrait, date, model, callback');
  ok(r.body.entries[2].attachments === 1, 'les pièces jointes sont comptées');
  ok((await http('GET', '/api/queue/Inconnu')).status === 404, 'projet hors config ⇒ 404');

  const c = await cli('Alpha');
  ok(c.code === 0 && c.out.includes(idsFirstBoot[1]) && /OCCUPÉ/.test(c.out) && /repo GitHub/.test(c.out), 'queue.mjs liste lisiblement (ids, état, extraits)');
}

scenario('retrait ciblé sans redémarrage : mémoire ET fichier');
{
  const c = await cli('Alpha', '--remove', idsFirstBoot[0]);
  ok(c.code === 0 && /retiré/.test(c.out), 'queue.mjs --remove retire l’entrée');
  const onDisk = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, 'queue', 'Alpha.json'), 'utf8'));
  ok(onDisk.length === 2 && !onDisk.some(e => e.id === idsFirstBoot[0]), 'le sidecar est réécrit du même geste');
  ok(Q.dispatchQueue.get('Alpha')[0].id === idsFirstBoot[1], 'la suivante passe en tête');
  Q = boot();
  ok(Q.dispatchQueue.get('Alpha').length === 2 && Q.dispatchQueue.get('Alpha')[0].id === idsFirstBoot[1],
     'après un redémarrage, la tâche retirée NE revient PAS (le cas de l’incident)');

  const again = await cli('Alpha', '--remove', idsFirstBoot[0]);
  ok(again.code === 2 && /aucune entrée/.test(again.err), 'retirer deux fois ⇒ 404 explicite (code 2)');
  ok((await http('DELETE', '/api/queue/Alpha/q-nope')).status === 404, 'DELETE d’un id absent ⇒ 404');
}

scenario('vider une file');
{
  // L'API reste montée sur l'instance d'avant le « redémarrage » simulé :
  // on vérifie donc ici par HTTP et par le fichier, pas par `Q`.
  const c = await cli('Alpha', '--clear');
  ok(c.code === 0 && /vidée/.test(c.out), 'queue.mjs --clear vide la file');
  ok(!fs.existsSync(path.join(LOGS_DIR, 'queue', 'Alpha.json')), 'le sidecar disparaît (file vide)');
  const r = await http('GET', '/api/queue/Alpha');
  ok(r.body.count === 0, 'la file est vide');
}

scenario('enqueue : l’id naît à la mise en file');
{
  const n = Q.queuePush('Beta', { prompt: 'nouvelle tâche', attachmentPaths: [], videoPaths: [], callback: 'chef' });
  const e = Q.dispatchQueue.get('Beta')[n - 1];
  ok(/^q-\d+-[0-9a-f]{4}$/.test(e.id) && !Number.isNaN(Date.parse(e.enqueuedAt)), 'queuePush attribue id + enqueuedAt');
  ok(!/q\.push\(\{ prompt/.test(SRC) && (SRC.match(/queuePush\(/g) || []).length >= 3, 'server.js n’empile plus en direct : tout passe par queuePush');
}

scenario('garde-fous du CLI');
{
  const c = await cli('Alpha', '--remove');
  ok(c.code === 64, '--remove sans id refusé');
}

server.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
