#!/usr/bin/env node
// ============================================================================
// scripts/_test_pool_chef_dispatch.mjs — la couture pool → dispatch.mjs
// ============================================================================
//
// POURQUOI CE HARNAIS EN PLUS DE _test_pool_p0a.mjs : celui-là double
// `spawnDirectDispatch`, donc il valide l'ordonnanceur sans jamais vérifier ce
// que le processus fils fait des arguments reçus. C'est exactement la couture
// qui a cassé le 24/09/2026 : le serveur stampait `DISPATCH_SLOT` sur le
// dispatch qu'il lançait LUI-MÊME pour remplir le slot, et dispatch.mjs lisait
// cette variable comme « c'est un chef qui parle » — tout tour de chef mourait
// en sortie 65 avant d'avoir commencé.
//
// On lance donc le VRAI scripts/dispatch.mjs avec l'argv et l'env que
// spawnDirectDispatch produit. `--callback __nope__` est une sentinelle : ce
// projet n'existe pas, donc le script meurt en 64 juste APRÈS les gardes du
// pool et AVANT de spawner un `claude`. Aucun tour n'est facturé.
//
//   node scripts/_test_pool_chef_dispatch.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
const CONDUCTOR = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).conductor || 'chef';

const SENTINEL = ['--callback', '__nope__'];   // meurt en 64 après les gardes
const GUARD_EXIT = 65;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  [ok]   ${label}`); }
  else      { fail++; console.log(`  [FAIL] ${label}`); }
}
function scenario(n) { console.log(`\n── ${n}`); }

function runDispatch(target, extraArgs, env) {
  const r = spawnSync(process.execPath, [DISPATCH, target, '--prompt-stdin', ...extraArgs, ...SENTINEL], {
    cwd: ROOT,
    input: 'ping',
    encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_API_KEY: '', ...env },
  });
  return { code: r.status, err: (r.stderr || '') + (r.stdout || '') };
}

// ── 1. Le serveur remplit un slot : ce tour DOIT vivre ─────────────────────
// C'est la régression. poolAssign() appelle spawnDirectDispatch(chef, …,
// {slot, ticket, poolAssign:true}) : le flag argv dit « c'est le serveur qui
// lance », ce que l'env ne peut pas contrefaire puisqu'il est hérité.
scenario('Le serveur assigne un ticket au chef');
{
  const r = runDispatch(CONDUCTOR, ['--pool-assign'], { DISPATCH_SLOT: '1', DISPATCH_TICKET: 't-test' });
  ok(r.code !== GUARD_EXIT, `pas de sortie ${GUARD_EXIT} (obtenu ${r.code})`);
  ok(/unknown project "__nope__"/.test(r.err), 'a bien dépassé les gardes du pool');
}

// ── 2. Un chef délègue à un chef : la garde DOIT tenir ─────────────────────
// Ici DISPATCH_SLOT a été hérité par l'outil Bash du chef, sans flag argv.
scenario('Un chef délègue à un chef (P0-B non disponible)');
{
  const r = runDispatch(CONDUCTOR, [], { DISPATCH_SLOT: '1', DISPATCH_TICKET: 't-test' });
  ok(r.code === GUARD_EXIT, `sortie ${GUARD_EXIT} (obtenu ${r.code})`);
  ok(/chef → chef/.test(r.err), 'message de garde attendu');
}

// ── 3. Un chef vise un slot par son nom : la garde DOIT tenir ──────────────
scenario('Un chef vise un slot nommé');
{
  const r = runDispatch(`${CONDUCTOR}-2`, [], { DISPATCH_SLOT: '1' });
  ok(r.code === GUARD_EXIT, `sortie ${GUARD_EXIT} (obtenu ${r.code})`);
  ok(/ne cible jamais un slot/.test(r.err), 'message de garde attendu');
}

// ── 4. Le flag ne s'auto-décerne pas par l'env ─────────────────────────────
// Une variable d'environnement ne doit jamais pouvoir jouer le rôle du flag :
// c'est toute la raison d'être d'un argv ici.
scenario("L'env ne peut pas contrefaire le flag");
{
  const r = runDispatch(CONDUCTOR, [], { DISPATCH_SLOT: '1', DISPATCH_POOL_ASSIGN: '1' });
  ok(r.code === GUARD_EXIT, `sortie ${GUARD_EXIT} (obtenu ${r.code})`);
}

// ── 5. La couture reste câblée côté serveur ────────────────────────────────
// Sans ces deux lignes, le fils ne reçoit jamais le flag et le scénario 1
// repasse au vert pour la mauvaise raison (il ne teste plus rien de réel).
scenario('server.js passe bien le flag');
{
  const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/opts\.poolAssign[\s\S]{0,80}'--pool-assign'/.test(SRC),
     "spawnDirectDispatch pousse '--pool-assign' quand opts.poolAssign");
  ok(/poolAssign:\s*true/.test(SRC), 'poolAssign() passe poolAssign: true');
}

// ── 6. Réveil en rapport seul (0.23.1) ─────────────────────────────────────
// Le tour de chef né d'un réveil au-delà de WAKE_MAX_GEN tourne avec
// DISPATCH_REPORT_ONLY=1, hérité par son outil Bash : tout dispatch qu'il
// tente doit mourir AVANT d'écrire quoi que ce soit — c'est ce qui rend la
// chaîne de réveils finie. Le tour lui-même (--pool-assign) doit vivre.
scenario('Réveil en rapport seul : le chef parle, ne dispatche pas');
{
  const self = runDispatch(CONDUCTOR, ['--pool-assign'], { DISPATCH_SLOT: '1', DISPATCH_REPORT_ONLY: '1', DISPATCH_WAKE_GEN: '4' });
  ok(self.code !== GUARD_EXIT && /unknown project "__nope__"/.test(self.err),
     'le tour de chef en rapport seul, lancé par le serveur, démarre');

  const r = runDispatch('orchestrateur', [], { DISPATCH_SLOT: '1', DISPATCH_REPORT_ONLY: '1', DISPATCH_WAKE_GEN: '4' });
  ok(r.code === GUARD_EXIT, `un dispatch depuis ce tour sort en ${GUARD_EXIT} (obtenu ${r.code})`);
  ok(/RAPPORT SEUL/.test(r.err) && /orchestrateur/.test(r.err), 'message explicite, qui nomme la cible refusée');

  const plain = runDispatch('orchestrateur', [], { DISPATCH_SLOT: '1', DISPATCH_REPORT_ONLY: '', DISPATCH_WAKE_GEN: '3' });
  // Sentinelle __nope__ : meurt en 64 AVANT le POST de file vers le serveur.
  ok(plain.code === 64 && /unknown project "__nope__"/.test(plain.err),
     'hors rapport seul (gen 3), le dispatch passe les gardes (et s’arrête à la sentinelle)');

  const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/DISPATCH_REPORT_ONLY:\s*opts\.reportOnly \? '1' : ''/.test(SRC),
     'spawnDirectDispatch écrit toujours DISPATCH_REPORT_ONLY (vide hors rapport seul)');
  ok(/reportOnly:\s*!!t\.reportOnly/.test(SRC), 'poolAssign() transmet reportOnly du ticket');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
