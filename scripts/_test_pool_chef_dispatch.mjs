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

// ── 7. Règle de fin de tour : pas d'attente sur l'arrière-plan (0.24.1) ────
// La consigne est injectée dans le prompt envoyé à claude, jamais dans le
// texte affiché (promptForLog). On évalue la vraie fonction extraite du script.
scenario("Règle de fin de tour injectée aux musiciens");
{
  const D = fs.readFileSync(DISPATCH, 'utf8');
  const a = D.indexOf('function backgroundRule(');
  const b = D.indexOf('\n}\n', a) + 2;
  // eslint-disable-next-line no-new-func
  const backgroundRule = new Function('path', 'ROOT', 'projectName', `${D.slice(a, b)}\nreturn backgroundRule;`)(
    path, ROOT, 'vuBox');
  const txt = backgroundRule('chef');
  ok(/TUÉE/.test(txt) && /JAMAIS un tour en comptant sur un process d'arrière-plan/.test(txt), 'interdit de finir un tour en comptant sur l’arrière-plan');
  ok(/avant-plan/.test(txt) && /Win32_Process -MethodName Create/.test(txt), 'donne les deux issues : avant-plan, ou vraiment détaché (Win32_Process Create)');
  ok(/notify\.mjs" chef /.test(txt) && /--source vuBox/.test(txt), 'le process détaché prévient lui-même le chef via notify.mjs');
  ok(/if \(projectName !== CONDUCTOR\) prompt = prompt \+ backgroundRule\(callbackProject \|\| CONDUCTOR\)/.test(D),
     'injectée pour tout musicien (pas le chef), adressée au callback ou au chef');
  const logIdx = D.indexOf('const promptForLog = prompt;');
  const ruleIdx = D.indexOf('prompt = prompt + backgroundRule(');
  ok(logIdx > 0 && ruleIdx > logIdx, 'le texte affiché (promptForLog) est figé AVANT : le fil ne montre pas la consigne');
  ok(/noQueueIdx !== -1 \? false/.test(D), '--no-queue-if-busy l’emporte sur DISPATCH_SLOT (lancement depuis la file)');
}

// ── 7b. Règle des exigences utilisateur injectée aux musiciens (0.36.0) ────
// Règle utilisateur : toute demande sur une fonctionnalité devient un test de
// non-régression. De bout en bout : _test_user_requirements.mjs.
scenario('Règle des exigences utilisateur injectée aux musiciens');
{
  const D = fs.readFileSync(DISPATCH, 'utf8');
  const a = D.indexOf('function userRequirementsRule(');
  const b = D.indexOf('\n}\n', a) + 2;
  ok(a > 0, 'userRequirementsRule() existe');
  // eslint-disable-next-line no-new-func
  const rule = new Function(`${D.slice(a, b)}\nreturn userRequirementsRule;`)()();
  ok(/TEST AUTOMATISÉ/.test(rule) && /suite de non-régression du projet, rejouée à chaque évolution/.test(rule), 'test automatisé dans la suite de non-régression, rejouée à chaque évolution');
  ok(/docs\/USER_REQUIREMENTS\.md/.test(rule) && /date, demande verbatim, test associé/.test(rule), 'tracée dans docs/USER_REQUIREMENTS.md');
  ok(/Avant toute\s+modification, rejoue cette suite/.test(rule.replace(/' \+\s*'/g, '')), 'suite rejouée avant toute modification');
  ok(/ni supprimé ni affaibli sans l'accord explicite de l'utilisateur/.test(rule), 'ni supprimé ni affaibli sans accord explicite');
  ok(/if \(projectName !== CONDUCTOR\) prompt = prompt \+ userRequirementsRule\(\)/.test(D), 'injectée pour tout musicien (pas le chef)');
  ok(D.indexOf('prompt = prompt + userRequirementsRule()') > D.indexOf('const promptForLog = prompt;'), 'invisible dans le fil (après promptForLog)');
}

// ── 8. codex : le --model est respecté, plus de gpt-4o codé en dur (0.25.1) ─
scenario('codex : choix du model (flag > projet > défaut config > config.toml de codex)');
{
  const D = fs.readFileSync(DISPATCH, 'utf8');
  // Refus AVANT toute écriture : un vrai projet est ciblé, mais le script meurt
  // à la validation des flags (aucun log, aucun claude, aucun codex lancé).
  const plain = (args) => spawnSync(process.execPath, [DISPATCH, ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '', DISPATCH_SLOT: '' },
  });
  const logBefore = fs.statSync(path.join(ROOT, 'logs', 'orchestrateur.jsonl')).size;
  let r = plain(['orchestrateur', '--provider', 'codex', '--model', 'claude-opus-5', 'bonjour']);
  ok(r.status === 64 && /model Claude/.test(r.stderr) && /gpt-6-astra/.test(r.stderr), 'model Claude + --provider codex ⇒ refus clair (exit 64)');
  r = plain(['orchestrateur', '--model', 'gpt-6-astra', 'bonjour']);
  ok(r.status === 64 && /--provider codex/.test(r.stderr), 'model OpenAI sans --provider codex ⇒ refus clair (exit 64)');
  // Le log de ce projet grossit tout seul (c'est le musicien en cours) : on ne
  // vérifie pas son égalité, seulement qu'aucune ligne « bonjour » n'y est née.
  const tail = fs.readFileSync(path.join(ROOT, 'logs', 'orchestrateur.jsonl'), 'utf8').slice(logBefore);
  ok(!/"text":"bonjour"/.test(tail), 'aucune écriture de log pour un dispatch refusé');

  // Résolution : on évalue l'expression RÉELLE de runCodex avec des entrées pilotées.
  const a = D.indexOf('const { model: codexModel, source: codexModelSource } = isFailover');
  const b = D.indexOf(';', D.indexOf("{ model: null, source: 'codex-config' }", a)) + 1;
  const resolve = (isFailover, modelOverride, project, config) =>
    new Function('isFailover', 'modelOverride', 'project', 'config', 'FAILOVER_CODEX_MODEL',
      `${D.slice(a, b)}\nreturn { codexModel, codexModelSource };`)(isFailover, modelOverride, project, config, 'gpt-5.6-sol');
  let x = resolve(false, 'gpt-6-astra', {}, { defaults: {} });
  ok(x.codexModel === 'gpt-6-astra' && x.codexModelSource === 'flag', '--model explicite gagne');
  x = resolve(false, 'gpt-6-astra', { codexModel: 'gpt-5.5' }, { defaults: { codexModel: 'gpt-5.6-luna' } });
  ok(x.codexModel === 'gpt-6-astra', '… même devant codexModel du projet et du défaut');
  x = resolve(false, null, { codexModel: 'gpt-5.5' }, { defaults: { codexModel: 'gpt-5.6-luna' } });
  ok(x.codexModel === 'gpt-5.5' && x.codexModelSource === 'project', 'puis codexModel du projet');
  x = resolve(false, null, {}, { defaults: { codexModel: 'gpt-5.6-luna' } });
  ok(x.codexModel === 'gpt-5.6-luna' && x.codexModelSource === 'defaults', 'puis defaults.codexModel');
  x = resolve(false, null, {}, { defaults: {} });
  ok(x.codexModel === null && x.codexModelSource === 'codex-config', 'rien de configuré ⇒ pas de --model, codex lit son config.toml (le cas du poste)');
  x = resolve(true, 'claude-opus-5', {}, { defaults: {} });
  ok(x.codexModel === 'gpt-5.6-sol' && x.codexModelSource === 'failover', 'failover : inchangé, et le --model Claude du dispatch n’atteint jamais codex');
  x = resolve(true, null, { codexModel: 'gpt-5.5' }, { defaults: {} });
  ok(x.codexModel === 'gpt-5.5', 'failover : le codexModel configuré garde la priorité (comme avant)');
  ok(!D.split('\n').some(l => /'gpt-4o'/.test(l) && !/^\s*\/\//.test(l)), "plus aucun 'gpt-4o' codé en dur (hors commentaires)");
  ok(/\.\.\.\(codexModel \? \['--model', codexModel\] : \[\]\)/.test(D), '--model n’est passé à codex que s’il est résolu');

  // Trace : le model que codex utilisera, lu dans SON config.toml.
  const c0 = D.indexOf('function readCodexConfigModel(');
  const c1 = D.indexOf('\n}\n', c0) + 2;
  const home = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'codex-home-'));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n\n[profiles.x]\nmodel = "gpt-5.5"\n');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const readCfg = new Function('fs', 'path', 'process', `${D.slice(c0, c1)}\nreturn readCodexConfigModel;`)(fs, path, process);
  ok(readCfg() === 'gpt-5.6-sol', 'config.toml : la clé model de premier niveau (pas celle d’un [profil])');
  process.env.CODEX_HOME = path.join(home, 'absent');
  ok(readCfg() === null, 'config.toml illisible ⇒ null (la trace le dit, le tour part quand même)');
  if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
  ok(/model: loggedCodexModel, modelSource: codexModelSource/.test(D), 'le system/init trace model + modelSource');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
