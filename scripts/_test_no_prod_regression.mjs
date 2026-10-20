#!/usr/bin/env node
// ============================================================================
// scripts/_test_no_prod_regression.mjs — no non-regression ever runs in
// production (0.125.0)
// ============================================================================
//
// User rule, recalled on 2026-10-20 (verbatim): « Aucune non regression ne doit
// se lancer sur orchestrateur. C'etait une regle. Uniquement sur
// orchestrateur-dev ».
//
// Protected:
//   1. scripts/prod-guard.mjs recognises a production root: I:\orchestrateur
//      (any spelling), a checkout whose .orchestrateur-instance.json says
//      role "prod", a checkout whose config.json has another project with
//      `devOf` pointing at the project living in that checkout, and the
//      add-only ORCH_PROD_ROOTS list; the dev checkout is not production;
//   2. regression.mjs REFUSES to run when its root (or --dir) is production,
//      with a clear message, before writing anything; it runs on the dev;
//   3. prod-jump.mjs neither prescribes nor launches any non-regression in
//      production: the plan and the --apply message only say « redémarrage
//      par le chef quand la flotte est au repos, puis non-régression sur
//      orchestrateur-dev »;
//   4. the documentation never prescribes a non-regression in production.
//
//   node scripts/_test_no_prod_regression.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1500)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const load = async (f) => { try { return await import(new URL(`./${f}`, import.meta.url)); } catch (e) { return { loadError: e }; } };

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-noprodreg-'));
const env = { ...process.env, ORCH_REGRESS_LIVE: '0' };
delete env.ORCH_PROD_ROOTS;

// ---------------------------------------------------------------------------
section('1. Reconnaître la prod (prod-guard.mjs)');
const G = await load('prod-guard.mjs');
ok(!G.loadError && typeof G.isProdRoot === 'function' && typeof G.prodRefusal === 'function', 'prod-guard.mjs exporte isProdRoot et prodRefusal', G.loadError);
if (!G.loadError) {
  for (const p of ['I:\\orchestrateur', 'i:\\Orchestrateur\\', 'I:/orchestrateur', 'I:/orchestrateur/']) ok(G.isProdRoot(p, { env: {} }), `${p} est la prod`);
  ok(!G.isProdRoot(ROOT, { env: {} }), `la dev (${ROOT}) n'est pas la prod`);
  ok(!G.isProdRoot('I:\\orchestrateur-x', { env: {} }) && !G.isProdRoot('I:\\orchestrateur\\sub', { env: {} }), 'un chemin voisin ou un sous-dossier n’est pas la racine de prod');

  const marked = path.join(T, 'marked'); fs.mkdirSync(marked);
  fs.writeFileSync(path.join(marked, '.orchestrateur-instance.json'), JSON.stringify({ instance: 'x', role: 'prod' }));
  ok(G.isProdRoot(marked, { env: {} }), 'instance marquée role « prod » : prod');
  const devMarked = path.join(T, 'devmarked'); fs.mkdirSync(devMarked);
  fs.writeFileSync(path.join(devMarked, '.orchestrateur-instance.json'), JSON.stringify({ instance: 'x', role: 'dev', prodRoot: marked }));
  ok(!G.isProdRoot(devMarked, { env: {} }), 'instance marquée role « dev » : pas la prod');

  const byConfig = path.join(T, 'byconfig'); fs.mkdirSync(byConfig);
  fs.writeFileSync(path.join(byConfig, 'config.json'), JSON.stringify({ projects: [
    { name: 'orch', cwd: byConfig }, { name: 'orch-dev', cwd: path.join(T, 'elsewhere'), devOf: 'orch' }] }));
  ok(G.isProdRoot(byConfig, { env: {} }), 'config.json : le projet de ce dossier a une instance de dev (devOf) → prod');
  ok(!G.isProdRoot(ROOT, { env: {} }), 'la vraie dev, avec sa copie de config.json, reste la dev');

  const listed = path.join(T, 'listed'); fs.mkdirSync(listed);
  ok(!G.isProdRoot(listed, { env: {} }) && G.isProdRoot(listed, { env: { ORCH_PROD_ROOTS: listed } }), 'ORCH_PROD_ROOTS ajoute une racine de prod');
  ok(G.isProdRoot('I:\\orchestrateur', { env: { ORCH_PROD_ROOTS: listed } }), 'ORCH_PROD_ROOTS n’en retire jamais (ajout seulement)');
  const msg = G.prodRefusal('I:\\orchestrateur') || '';
  ok(/orchestrateur-dev/.test(msg) && /Aucune non regression ne doit se lancer sur orchestrateur/.test(msg), 'message clair : la règle verbatim et où lancer (orchestrateur-dev)', msg);
}

// ---------------------------------------------------------------------------
section('2. regression.mjs refuse en prod, accepte sur la dev');
// A copy of the scripts in a checkout marked as production.
const P = path.join(T, 'prodcopy');
fs.cpSync(path.join(ROOT, 'scripts'), path.join(P, 'scripts'), { recursive: true, filter: (s) => !/[\\/]__pycache__/.test(s) });
fs.cpSync(path.join(ROOT, 'public'), path.join(P, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(P, 'package.json'));
fs.writeFileSync(path.join(P, '.orchestrateur-instance.json'), JSON.stringify({ instance: 'orchestrateur', role: 'prod' }));
const runReg = (script, args, extraEnv = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 60000, windowsHide: true });
let r = runReg(path.join(P, 'scripts', 'regression.mjs'), ['--targeted', '--no-browser']);
ok(r.status === 65 && /REFUS/.test(r.stderr) && /orchestrateur-dev/.test(r.stderr), 'racine marquée prod : refus (code 65), message clair', `${r.status} ${r.stdout} ${r.stderr}`);
ok(!fs.existsSync(path.join(P, '.regress')), 'rien n’est écrit dans la prod (.regress absent)');
fs.rmSync(path.join(P, '.orchestrateur-instance.json'));
r = runReg(path.join(P, 'scripts', 'regression.mjs'), ['--no-suites', '--no-browser'], { ORCH_PROD_ROOTS: P });
ok(r.status === 65 && /REFUS/.test(r.stderr), 'racine listée par ORCH_PROD_ROOTS : refus', `${r.status} ${r.stderr}`);
r = runReg(path.join(P, 'scripts', 'regression.mjs'), ['--full'], { ORCH_PROD_ROOTS: P });
ok(r.status === 65, '--full ne déroge pas', `${r.status} ${r.stderr}`);
// --dir pointing at production from the dev.
const marked2 = path.join(T, 'marked2'); fs.mkdirSync(marked2);
fs.writeFileSync(path.join(marked2, '.orchestrateur-instance.json'), JSON.stringify({ role: 'prod' }));
r = runReg(path.join(ROOT, 'scripts', 'regression.mjs'), ['--dir', marked2, '--no-browser']);
ok(r.status === 65 && /REFUS/.test(r.stderr), '--dir vers une prod depuis la dev : refus', `${r.status} ${r.stderr}`);
// Accepted on the dev: --compare of two tiny reports runs to the end.
const rep = (label) => ({ label, mode: 'full', tree: 'x', results: [{ id: 'a', stage: 'suite', name: 'a', status: 'OK' }] });
fs.writeFileSync(path.join(T, 'a.json'), JSON.stringify(rep('a')));
fs.writeFileSync(path.join(T, 'b.json'), JSON.stringify(rep('b')));
r = runReg(path.join(ROOT, 'scripts', 'regression.mjs'), ['--compare', path.join(T, 'a.json'), path.join(T, 'b.json')]);
ok(r.status === 0 && /AUTORISÉE/.test(r.stdout) && !/REFUS/.test(r.stderr), 'sur la dev : regression.mjs tourne', `${r.status} ${r.stdout} ${r.stderr}`);
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
const firstCode = src.split('\n').findIndex(l => /^(import|const|let|for|if)\b/.test(l));
ok(/^import \{[^}]*refuseInProd[^}]*\} from '\.\/prod-guard\.mjs';/.test(src.split('\n')[firstCode]), 'regression.mjs : la garde est le premier import (avant tout autre module)', src.split('\n')[firstCode]);
ok(/refuseInProd\(/.test(src) && !/--allow-prod|ORCH_ALLOW_PROD/.test(src), 'aucune dérogation (ni option, ni variable)');

// ---------------------------------------------------------------------------
section('3. prod-jump.mjs ne prescrit ni ne lance aucune non-régression dans la prod');
const J = await load('prod-jump.mjs');
const jsrc = fs.readFileSync(path.join(ROOT, 'scripts', 'prod-jump.mjs'), 'utf8');
ok(!/path\.join\(prod,\s*'scripts',\s*'regression\.mjs'\)/.test(jsrc) && !/--since prod-before/.test(jsrc), 'aucune commande regression.mjs dans la prod', jsrc.match(/.*regression\.mjs.*prod.*/g));
ok(!/spawn[^\n]*regression\.mjs/.test(jsrc), 'prod-jump ne lance jamais regression.mjs');
ok(typeof J.jumpPlan === 'function' && typeof J.AFTER_APPLY === 'string', 'prod-jump exporte jumpPlan et AFTER_APPLY', J.loadError);
if (typeof J.jumpPlan === 'function') {
  const plan = J.jumpPlan({ prod: 'I:\\orchestrateur', tag: 'v9.9.9', from: 'origin', keep: ['TODO_LIST.md'] });
  ok(!plan.some(s => /regression\.mjs/.test(s)), 'plan : aucune commande de non-régression', plan.join('\n'));
  ok(plan.some(s => /redémarrage par le chef quand la flotte est au repos, puis non-régression sur orchestrateur-dev/.test(s)), 'plan : redémarrage par le chef au repos, puis non-régression sur orchestrateur-dev', plan.join('\n'));
  ok(/redémarrage par le chef quand la flotte est au repos, puis non-régression sur orchestrateur-dev/.test(J.AFTER_APPLY) && !/dans la prod/.test(J.AFTER_APPLY), 'message après --apply : seulement le redémarrage et la non-régression sur orchestrateur-dev', J.AFTER_APPLY);
  ok(/console\.log\([^\n]*AFTER_APPLY/.test(jsrc), 'le message après --apply est AFTER_APPLY');
}
ok(!/non-régression[^\n`]*dans la prod/.test(jsrc.replace(/^\/\/.*$/gm, '')), 'aucun message de prod-jump ne parle d’une non-régression dans la prod');

// ---------------------------------------------------------------------------
section('4. La documentation ne prescrit aucune non-régression dans la prod');
const docs = ['CLAUDE.md', ...fs.readdirSync(path.join(ROOT, 'docs'), { recursive: true }).filter(f => /\.md$/.test(f)).map(f => path.join('docs', f))]
  .filter(f => !/USER_REQUIREMENTS\.md$/.test(f));
const bad = [];
for (const f of docs) {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (/I:[\\/]+orchestrateur[\\/]+scripts[\\/]+regression\.mjs/i.test(l) || /regression\.mjs[^\n]*--since prod-before/.test(l) || /jumped production checkout/.test(l)) bad.push(`${f}:${i + 1}: ${l.trim()}`);
  });
}
ok(!bad.length, 'aucune commande de non-régression dans la prod dans CLAUDE.md et docs/', bad.join('\n'));
const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8').replace(/\s+/g, ' ');
ok(/Aucune non regression ne doit se lancer sur orchestrateur/.test(claude), 'CLAUDE.md porte la règle verbatim');
const devprod = fs.readFileSync(path.join(ROOT, 'docs', 'DEV-PROD.md'), 'utf8');
ok(/never in production/i.test(devprod) && /prod-guard\.mjs/.test(devprod), 'DEV-PROD.md : non-régression jamais en prod, garde nommée');
for (const f of ['ROUTAGE-SYNTHESE.md', 'PIPELINES-SYNTHESE.md']) {
  const t = fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8');
  ok(/non-régression par périmètre sur orchestrateur-dev, jamais dans la prod/.test(t), `${f} : la non-régression du bond est sur orchestrateur-dev, jamais dans la prod`);
}
const reqs = fs.readFileSync(path.join(ROOT, 'docs', 'USER_REQUIREMENTS.md'), 'utf8');
ok(/Aucune non regression ne doit se lancer sur orchestrateur\. C'etait une regle\. Uniquement sur orchestrateur-dev/.test(reqs) && /suite:_test_no_prod_regression\.mjs/.test(reqs), 'registre des exigences : règle verbatim et cette suite');

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
