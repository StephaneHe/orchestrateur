#!/usr/bin/env node
// ============================================================================
// scripts/resolve-question.mjs — acquitter la question d'un musicien
// ============================================================================
//
//   node scripts/resolve-question.mjs <projet> [--note "répondu via le chef : …"]
//
// Quand l'utilisateur a répondu via le chef, ou que la question est devenue
// sans objet, la carte du musicien restait en « question » jusqu'à son tour
// suivant. Ceci l'acquitte SANS relancer le musicien (aucun tour, aucun coût) :
// le serveur ajoute un événement `question_resolved` à son log, l'état repasse
// à « prêt », la note reste visible dans son panneau.
//
// Codes de sortie : 0 acquittée · 2 aucune question en attente (ou tour en
// cours) · 3 serveur antérieur à 0.25.0 (non redémarré) · 1 autre erreur ·
// 64 usage.
// ============================================================================

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ORCH_PORT || 7777);   // surchargeable pour les tests

function die(msg, code = 64) { console.error(`[resolve-question] ${msg}`); process.exit(code); }

const argv = process.argv.slice(2);
if (!argv.length || argv[0].startsWith('-')) die('usage: node scripts/resolve-question.mjs <projet> [--note "…"]');
const project = argv[0];
const noteIdx = argv.indexOf('--note');
if (noteIdx !== -1 && (noteIdx + 1 >= argv.length)) die('--note exige un texte');
const note = noteIdx !== -1 ? argv[noteIdx + 1] : '';

let token = '';
try { token = fs.readFileSync(path.join(ROOT, '.token'), 'utf8').trim(); }
catch { die('impossible de lire .token — le serveur orchestrateur tourne-t-il ?', 1); }

const body = Buffer.from(JSON.stringify({ note, by: process.env.RESOLVE_BY || 'chef' }));
const r = await new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1', port: PORT, method: 'POST',
    path: `/api/question/${encodeURIComponent(project)}/resolve`,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Orchestrator-Token': token },
  }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', c => { buf += c; });
    res.on('end', () => {
      let json = null;
      try { json = JSON.parse(buf); } catch { /* non-JSON */ }
      resolve({ status: res.statusCode, body: json, raw: buf });
    });
  });
  req.on('error', reject);
  req.setTimeout(10_000, () => req.destroy(new Error('délai dépassé')));
  req.end(body);
}).catch(e => die(`serveur injoignable sur 127.0.0.1:${PORT} (${e.message})`, 1));

// Un 404 sans JSON : Express ne connaît pas la route ⇒ serveur pas redémarré.
if (r.status === 404 && !r.body) die('route /api/question absente — le serveur tourne une version < 0.25.0 : redémarrage requis', 3);
if (r.status === 404) die(r.body.error, 1);
if (r.status === 409) { console.log(`— ${r.body?.error || 'aucune question en attente'}`); process.exit(2); }
if (r.status < 200 || r.status >= 300) die(`HTTP ${r.status} ${r.body?.error || r.raw.slice(0, 200)}`, 1);

console.log(`✓ question de ${project} acquittée`);
if (r.body.question) console.log(`  question : « ${r.body.question} »`);
if (r.body.note) console.log(`  note     : ${r.body.note}`);
console.log('  (aucun tour relancé — le musicien repasse « prêt »)');
