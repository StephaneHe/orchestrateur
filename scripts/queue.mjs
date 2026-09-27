#!/usr/bin/env node
// ============================================================================
// scripts/queue.mjs — consulter / retirer des tâches de la file d'un musicien
// ============================================================================
//
//   node scripts/queue.mjs <projet>                 # = --list
//   node scripts/queue.mjs <projet> --list
//   node scripts/queue.mjs <projet> --remove <id>   # retire une entrée
//   node scripts/queue.mjs <projet> --clear         # vide la file
//   (ajouter --json pour une sortie machine)
//
// Passe par l'API du serveur (GET/DELETE /api/queue/...), jamais par le
// fichier logs/queue/<projet>.json : la mémoire du serveur fait foi et réécrit
// ce fichier à chaque mutation, donc l'éditer à la main ne sert à rien (la
// tâche « retirée » revient). Aucun redémarrage n'est nécessaire.
// ============================================================================

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ORCH_PORT || 7777);   // surchargeable pour les tests

function die(msg, code = 64) { console.error(`[queue] ${msg}`); process.exit(code); }

const argv = process.argv.slice(2);
const USAGE = 'usage: node scripts/queue.mjs <projet> [--list | --remove <id> | --clear] [--json]';
if (!argv.length || argv[0].startsWith('-')) die(USAGE);
const project = argv[0];
const asJson = argv.includes('--json');
const rmIdx = argv.indexOf('--remove');
const removeId = rmIdx !== -1 ? argv[rmIdx + 1] : null;
if (rmIdx !== -1 && (!removeId || removeId.startsWith('-'))) die('--remove exige un id (voir --list)');
const clear = argv.includes('--clear');
if (removeId && clear) die('--remove et --clear sont exclusifs');

let token = '';
try { token = fs.readFileSync(path.join(ROOT, '.token'), 'utf8').trim(); }
catch { die('impossible de lire .token — le serveur orchestrateur tourne-t-il ?'); }

function call(method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: { 'X-Orchestrator-Token': token },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body, raw: buf });
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('délai dépassé')); });
    req.end();
  });
}

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const base = `/api/queue/${encodeURIComponent(project)}`;
let r;
try {
  if (removeId) r = await call('DELETE', `${base}/${encodeURIComponent(removeId)}`);
  else if (clear) r = await call('DELETE', base);
  else r = await call('GET', base);
} catch (e) {
  die(`serveur injoignable sur 127.0.0.1:${PORT} (${e.message})`, 1);
}

// Un 404 sans corps JSON, c'est Express qui ne connaît pas la route : le
// serveur en mémoire est antérieur à 0.24.0 (il n'a pas été redémarré).
if (r.status === 404 && !r.body) die('route /api/queue absente — le serveur tourne une version < 0.24.0 : redémarrage requis', 3);
if (r.status === 404) die(r.body.error || 'introuvable', 2);
if (r.status < 200 || r.status >= 300) die(`HTTP ${r.status} ${r.body?.error || r.raw.slice(0, 200)}`, 1);
if (asJson) { console.log(JSON.stringify(r.body, null, 2)); process.exit(0); }

if (removeId) {
  const e = r.body.removed;
  console.log(`✓ retiré de la file de ${project} : ${e.id} « ${e.head.slice(0, 90)} »`);
  console.log(`  reste ${r.body.remaining} entrée(s)`);
} else if (clear) {
  console.log(`✓ file de ${project} vidée — ${r.body.removed} entrée(s) retirée(s)`);
} else {
  const { entries, busy } = r.body;
  console.log(`File de ${project} — ${entries.length} entrée(s) · musicien ${busy ? 'OCCUPÉ (la tête partira à la fin de son tour)' : 'libre'}`);
  if (!entries.length) process.exit(0);
  for (const e of entries) {
    const meta = [
      `ajoutée ${when(e.enqueuedAt)}`,
      e.model ? `model ${e.model}` : null,
      e.provider ? `provider ${e.provider}` : null,
      e.callback ? `callback ${e.callback}` : 'sans callback',
      e.newSession ? 'SESSION NEUVE (--new-session)' : null,
      e.attachments ? `${e.attachments} pièce(s) jointe(s)` : null,
    ].filter(Boolean).join(' · ');
    console.log(`\n  ${e.position}. ${e.id}`);
    console.log(`     ${meta}`);
    console.log(`     « ${e.head} »`);
  }
  console.log(`\nRetirer : node scripts/queue.mjs ${project} --remove <id>`);
}
