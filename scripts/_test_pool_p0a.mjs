#!/usr/bin/env node
// ============================================================================
// scripts/_test_pool_p0a.mjs — recette de la file de direction (P0-A, 0.22.0)
// ============================================================================
//
// POURQUOI CE HARNAIS PLUTÔT QU'UN VRAI SERVEUR : le port 7777 est occupé par
// l'instance de production (qu'on ne redémarre pas) et chaque ticket tiré
// lancerait un vrai `claude -p`. On charge donc le BLOC DE CODE RÉEL du pool
// — le texte exact de server.js, pas une réimplémentation — dans un bac à
// sable où `spawnDirectDispatch`, `dispatchPidAlive`, `readLimitedUntil` et le
// système de fichiers sont des doublures. Ce qui est testé est donc bien le
// code livré ; seules ses dépendances sont simulées.
//
//   node scripts/_test_pool_p0a.mjs
//
// Aucun `claude` n'est lancé, aucun fichier du projet n'est écrit (les
// sidecars partent dans un dossier temporaire).
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------- extraction du bloc réel ----------------------------------------

const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const START = SRC.indexOf('const POOL_SIDECAR');
const END   = SRC.indexOf('// ---------- Heal orphaned log tails');
if (START < 0 || END < 0 || END < START) {
  console.error('[test-pool] bornes du bloc pool introuvables dans server.js');
  process.exit(2);
}
const POOL_SRC = SRC.slice(START, END);

// ---------- bac à sable -----------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-p0a-'));
const LOGS_DIR = path.join(TMP, 'logs');
const QUEUE_DIR = path.join(LOGS_DIR, 'queue');
fs.mkdirSync(QUEUE_DIR, { recursive: true });

function makeSandbox() {
  const spawned = [];              // [{ name, prompt, opts }]
  const alive   = new Map();       // nom → pid vivant simulé
  const state = {
    limitedUntil: null,
    config: { conductor: 'chef', conductorPool: { size: 1, model: 'claude-opus-5' }, projects: [{ name: 'chef', path: 'I:\\Dev\\Chef' }], defaults: { model: 'claude-opus-4-8' } },
    wake: { inFlight: false },
    spawned, alive,
  };

  const deps = {
    fs, path, crypto,
    QUEUE_DIR, LOGS_DIR,
    get config() { return state.config; },
    conductorName: () => state.config.conductor || 'chef',
    debugLog: () => {},
    crashLog: () => {},
    console: { log: () => {}, error: console.error },
    projectTrace: new Map(),
    fleetSseClients: new Set(),
    wake: state.wake,
    readLimitedUntil: () => state.limitedUntil,
    dispatchPidAlive: (name) => alive.get(name) ?? null,
    killDispatchTree: (name) => { alive.delete(name); return true; },
    spawnDirectDispatch: (name, prompt, a, v, opts) => {
      spawned.push({ name, prompt, opts });
      alive.set(name, 1000 + spawned.length);      // le tour « tourne »
      return 1000 + spawned.length;
    },
  };

  const names = Object.keys(deps);
  const body = `${POOL_SRC}\n;return { pool, poolEnqueue, poolWithdraw, poolPosition, poolSnapshot, poolOnSlotResult, poolMarkRunning, poolInterruptSlot, schedulePool, loadPoolFromDisk, persistPool, poolReapLost, poolSize };`;
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, body);
  const api = factory(...names.map(n => deps[n]));
  return { api, state };
}

// ---------- mini-assertions -------------------------------------------------

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}
function scenario(name) { console.log(`\n── ${name}`); }

// ---------- 1. Deux messages en rafale : le second ATTEND ------------------

scenario('rafale — le second message attend, aucun tour tué');
{
  const { api, state } = makeSandbox();
  api.poolEnqueue({ class: 'user', text: 'Vérifie vuBox' });
  ok(state.spawned.length === 1, 'le premier message part tout de suite');
  const t2 = api.poolEnqueue({ class: 'user', text: 'Prépare la release DeskZen' });
  ok(state.spawned.length === 1, 'le second ne spawne PAS (aucune interruption implicite)');
  ok(state.alive.get('chef') != null, 'le tour en cours est toujours vivant');
  ok(api.poolPosition(t2.id) === 1, 'le second est en file, position 1');

  // Le chef termine → le second démarre.
  state.alive.delete('chef');
  api.poolOnSlotResult('chef', { is_error: false });
  api.schedulePool('test');
  ok(state.spawned.length === 2, 'au result, le second message est lancé');
  ok(state.spawned[1].prompt === 'Prépare la release DeskZen', 'FIFO respecté');
  ok(api.poolPosition(t2.id) === null, 'la file est vide');
}

// ---------- 2. Ordre des classes : point APRÈS user/decision ---------------

scenario('classes — un point passe après les messages et les décisions');
{
  const { api, state } = makeSandbox();
  api.poolEnqueue({ class: 'user', text: 'occupe le chef' });      // prend le slot
  api.poolEnqueue({ class: 'point', text: 'POINT', source: 'wake' });
  api.poolEnqueue({ class: 'decision', text: 'DECISION' });
  api.poolEnqueue({ class: 'user', text: 'MESSAGE' });
  state.alive.delete('chef');
  api.poolOnSlotResult('chef', {});
  api.schedulePool('test');
  ok(state.spawned[1]?.prompt === 'DECISION', 'la décision passe avant le point (musicien bloqué)');
  state.alive.delete('chef');
  api.poolOnSlotResult('chef', {});
  api.schedulePool('test');
  ok(state.spawned[2]?.prompt === 'MESSAGE', 'le message utilisateur passe avant le point');
  state.alive.delete('chef');
  api.poolOnSlotResult('chef', {});
  api.schedulePool('test');
  ok(state.spawned[3]?.prompt === 'POINT', 'le point passe en dernier');
  ok(state.spawned[3]?.opts?.source === 'wake', 'le point garde sa source « wake » (jamais affiché dans le fil)');
}

// ---------- 3. Le verrou de réveil appartient au ticket --------------------

scenario('réveil — inFlight relâché par le ticket point, pas par n’importe quel result');
{
  const { api, state } = makeSandbox();
  state.wake.inFlight = true;
  api.poolEnqueue({ class: 'point', text: 'POINT', source: 'wake' });
  state.alive.delete('chef');
  api.poolOnSlotResult('chef', {});
  ok(state.wake.inFlight === false, 'la fin du tour de point rend le verrou');

  state.wake.inFlight = true;
  state.alive.set('chef', 4242);                 // le chef retravaille
  const t = api.poolEnqueue({ class: 'point', text: 'POINT 2', source: 'wake' });
  ok(api.poolPosition(t.id) === 1, 'le point attend (le chef est occupé)');
  api.poolWithdraw(t.id);
  ok(state.wake.inFlight === false, 'retirer un point en file rend aussi le verrou');
}

// ---------- 4. Limite Claude : la file gèle, rien ne brûle -----------------

scenario('limite Claude — ordonnanceur gelé, file intacte');
{
  const { api, state } = makeSandbox();
  state.limitedUntil = new Date(Date.now() + 3600_000).toISOString();
  const t = api.poolEnqueue({ class: 'user', text: 'quelque chose' });
  ok(state.spawned.length === 0, 'aucun spawn sous limite');
  ok(api.poolPosition(t.id) === 1, 'le ticket reste visible en file');
  state.limitedUntil = null;
  api.schedulePool('test');
  ok(state.spawned.length === 1, 'à l’expiration, la file reprend dans l’ordre');
}

// ---------- 5. Interruption explicite --------------------------------------

scenario('interruption explicite — tue le tour, le remplaçant double la file');
{
  const { api, state } = makeSandbox();
  api.poolEnqueue({ class: 'user', text: 'A (en cours)' });
  const patient = api.poolEnqueue({ class: 'user', text: 'B (patiente)' });
  ok(api.poolPosition(patient.id) === 1, 'B attend');

  // reschedule:false — c'est la route /api/dispatch qui enfile le remplaçant
  // juste après ; sans ce garde-fou B prendrait le slot libéré.
  const r = api.poolInterruptSlot(1, 'user', false);
  ok(r.ok && r.killed, 'le tour en vol est tué');
  ok(state.alive.get('chef') == null, 'plus aucun processus pour le chef');
  const interrupter = api.poolEnqueue({ class: 'user', text: 'C (interrompt)', front: true, interrupting: true });
  ok(state.spawned[1]?.prompt === 'C (interrompt)', 'C démarre immédiatement (il remplace le tour tué)');
  ok(api.poolPosition(patient.id) === 1, 'B n’a pas été doublé pour de bon : il reste position 1');
  ok(interrupter.interrupting === true, 'le ticket est marqué « a interrompu »');
}

// ---------- 6. Redémarrage serveur : LOST → requeue UNE fois ---------------

scenario('redémarrage — un ticket en vol perdu repart une fois, en tête');
{
  const { api, state } = makeSandbox();
  api.poolEnqueue({ class: 'user', text: 'en vol' });
  api.poolEnqueue({ class: 'user', text: 'en file 1' });
  api.poolEnqueue({ class: 'user', text: 'en file 2' });
  api.persistPool();

  // Le serveur redémarre : nouveau bac à sable, même sidecar, aucun PID vivant.
  const b = makeSandbox();
  b.api.loadPoolFromDisk();
  ok(b.state.spawned.length === 1, 'un seul ticket est relancé');
  ok(b.state.spawned[0].prompt.startsWith('[REPRISE]'), 'le ticket perdu porte la note de reprise');
  ok(b.state.spawned[0].prompt.includes('en vol'), 'c’est bien le ticket qui était en vol');
  ok(b.api.pool.queue.length === 2, 'les deux autres suivent, sans doublon');

  // Deuxième perte du même ticket ⇒ abandon, jamais une boucle.
  b.state.alive.delete('chef');
  const t = b.api.pool.slots[0].ticket;
  b.api.pool.slots[0].assignedAt = Date.now() - 120_000;
  b.api.poolReapLost();
  ok(b.api.pool.queue.every(x => x.id !== t.id), 'un ticket perdu deux fois est abandonné, pas rejoué');
}

// ---------- 7. « Pris par » vient du log, pas du HTTP ----------------------

scenario('honnêteté — « pris » n’est affirmé qu’au user_prompt stampé du slot');
{
  const { api, state } = makeSandbox();
  const t = api.poolEnqueue({ class: 'user', text: 'salut' });
  let snap = api.poolSnapshot(() => 'live');
  ok(snap.slots[0].ticket?.state === 'ASSIGNED', 'juste après le spawn : ASSIGNED, pas « pris »');
  api.poolMarkRunning('chef', t.id);
  snap = api.poolSnapshot(() => 'live');
  ok(snap.slots[0].ticket?.state === 'RUNNING', 'le user_prompt stampé fait passer à RUNNING');
  ok(snap.size === 1 && snap.model === 'claude-opus-5', 'le snapshot expose size et model du pool');
  ok(Array.isArray(snap.queue), 'le snapshot expose la file');
}

// ---------- 8. Retirer un ticket -------------------------------------------

scenario('retrait — un ticket en file peut être retiré, un tour en cours non');
{
  const { api, state } = makeSandbox();
  api.poolEnqueue({ class: 'user', text: 'en cours' });
  const t = api.poolEnqueue({ class: 'user', text: 'à retirer' });
  ok(api.poolWithdraw(t.id)?.state === 'WITHDRAWN', 'le ticket en file est retiré');
  ok(api.poolWithdraw(t.id) === null, 'retirer deux fois ne fait rien');
  const running = api.pool.slots[0].ticket;
  ok(api.poolWithdraw(running.id) === null, 'un tour en cours n’est pas « retirable » (c’est une interruption)');
}

// ---------- 9. Taille du pool verrouillée à 1 en P0-A ----------------------

scenario('P0-A — la taille du pool reste 1 même si la config demande 3');
{
  const { api, state } = makeSandbox();
  state.config.conductorPool.size = 3;
  ok(api.poolSize() === 1, 'conductorPool.size = 3 est borné à 1 (le pool de 3 est P0-B)');
  api.poolEnqueue({ class: 'user', text: 'a' });
  api.poolEnqueue({ class: 'user', text: 'b' });
  api.poolEnqueue({ class: 'user', text: 'c' });
  ok(state.spawned.length === 1, 'un seul chef travaille à la fois');
}

// ---------- 10. dispatch.mjs : flags et garde-fous -------------------------
//
// Tous ces cas MEURENT avant d'ouvrir le moindre log : aucun `claude` n'est
// lancé, aucun fichier de projet n'est touché. C'est justement ce qu'on vérifie.

scenario('dispatch.mjs — flags consommés et garde-fous du pool');
{
  const { spawnSync } = await import('node:child_process');
  const D = path.join(ROOT, 'scripts', 'dispatch.mjs');
  const run = (args, env = {}) => spawnSync(process.execPath, [D, ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env },
  });

  let r = run(['projetInexistant', '--model', 'claude-opus-5', '--provider', 'codex', 'bonjour']);
  ok(/unknown project "projetInexistant"/.test(r.stderr), '--model/--provider sont consommés (le projet reste le 1er positionnel)');

  // 0.47.0 : nvidia et openrouter sont des fournisseurs outillés (harnais codex).
  r = run(['projetInexistant', '--provider', 'mistral', 'bonjour']);
  ok(r.status === 64 && /--provider must be/.test(r.stderr), '--provider n’accepte que claude|codex|nvidia|openrouter');

  r = run(['chef', 'bonjour'], { DISPATCH_SLOT: '1', DISPATCH_TICKET: 'm-1-aaaa' });
  ok(r.status === 65 && /délégation chef → chef/.test(r.stderr), 'un chef ne délègue pas à « chef » en P0-A (refus clair, pas un suicide de tour)');

  r = run(['chef-2', 'bonjour'], { DISPATCH_SLOT: '1' });
  ok(r.status === 65 && /ne cible jamais un slot/.test(r.stderr), 'un chef ne cible jamais un slot par son nom');

  r = run(['projetInexistant', '--queue-if-busy', '--no-queue-if-busy', 'bonjour']);
  ok(/unknown project/.test(r.stderr), '--queue-if-busy / --no-queue-if-busy sont des drapeaux sans valeur');
}

// ---------- résultat --------------------------------------------------------

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
