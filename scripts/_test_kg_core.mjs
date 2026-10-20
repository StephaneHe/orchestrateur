#!/usr/bin/env node
// ============================================================================
// scripts/_test_kg_core.mjs — knowledge index, phase 0 b: schema, provenance,
// secrets, single writer, hot switch (off = behaviour before)
// ============================================================================
//
// User decisions of 2026-10-20 on docs/KG-SYNTHESE.md (« tout comme
// recommandé »), phase 0 b: « l'index en fichiers construit par le PROGRAMME,
// SANS model » — storage under logs/kg/ out of git with a single writing
// module (kg.mjs); closed types; provenance (file:line, commit or run) with a
// verified quote; validity dates; status; secrets filtered before writing; no
// injection in any turn; switch off/shadow/assist, « off » = exactly the
// current behaviour.
//
// Protected:
//   1. closed schema: unknown predicate, authority, status or node type ⇒ fact
//      rejected; the lists are frozen in kg.mjs;
//   2. provenance: a quote the code cannot find again in its source, a quote
//      over 200 characters, a JSON pointer that does not hold the value, an
//      unknown commit ⇒ rejected; an accepted quote gets its real line;
//   3. secrets: masked in every written file; secret-bearing sources (.env,
//      secrets/, .token, raw logs/<p>.jsonl) are never read;
//   4. single writer: only kg.mjs names logs/kg; it writes only there (plus the
//      `kg` block of model-routing.json); a build changes nothing else;
//   5. switch: absent = off; off ⇒ build and queries refused, nothing written;
//      `pipeline-enforce.mjs kg shadow|assist|off` writes only the `kg` block,
//      every other key kept; `off --all` turns it off too; no turn module
//      (dispatch.mjs, server.js, engine) imports kg.mjs: nothing is injected.
//
// Throw-away roots only (never the real installation).
//   node scripts/_test_kg_core.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as KG from './kg.mjs';
import { corpusCopy } from '../tests/kg-corpus/fixture.mjs';
import { referenceGraph, importClosure, repoFiles } from './regression-targets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-core-'));
const CORPUS = corpusCopy(path.join(T, 'corpus'));
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (s) => console.log(`\n${s}`);
const node = (args, env = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
const hashTree = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(dir);
  return out;
};

try {
  // ------------------------------------------------------------------------
  section('1. Schéma fermé');
  {
    ok(Object.isFrozen(KG.NODE_TYPES) || Array.isArray(KG.NODE_TYPES), 'liste des types de nœuds exportée');
    ok(KG.NODE_TYPES.includes('projet') && KG.NODE_TYPES.includes('decision') && !KG.NODE_TYPES.includes('autorisation'), 'types de la synthèse, aucun type « autorisation » (le graphe n’autorise jamais rien)');
    for (const p of ['has_state', 'listens_on', 'runs_in', 'dev_of', 'default_model']) ok(KG.PREDICATES[p] === true, `prédicat fonctionnel : ${p}`);
    ok(KG.PREDICATES.supersedes === false && KG.PREDICATES.cites === false, 'prédicats non fonctionnels : supersedes, cites');
    const texts = new Map([['k', 'une ligne\nla règle dit ceci\n']]);
    const base = { s: 'flotte:fleet', p: 'default_model', o: 'claude-x', authority: 'document', source: { kind: 'md', key: 'k', ref: 'k:2', quote: 'la règle dit ceci' } };
    ok(KG.validateFact(base, { texts }).ok, 'un fait bien formé est accepté');
    ok(!KG.validateFact({ ...base, p: 'autorise' }, { texts }).ok, 'prédicat inconnu ⇒ rejeté');
    ok(!KG.validateFact({ ...base, authority: 'model' }, { texts }).ok, 'autorité inconnue ⇒ rejeté');
    ok(!KG.validateFact({ ...base, status: 'peut-être' }, { texts }).ok, 'statut inconnu ⇒ rejeté');
    const nodes = new Map([['flotte:fleet', { id: 'flotte:fleet', type: 'personne' }]]);
    ok(!KG.validateFact(base, { texts, nodes }).ok, 'nœud d’un type hors liste ⇒ rejeté');
  }

  // ------------------------------------------------------------------------
  section('2. Provenance vérifiée');
  {
    const texts = new Map([['m', 'titre\n\nla règle dit ceci et cela\n']]);
    const f = { s: 'flotte:fleet', p: 'default_model', o: 'claude-x', authority: 'document', source: { kind: 'md', key: 'm', ref: 'm:1', quote: 'la règle dit ceci' } };
    const r = KG.validateFact(f, { texts });
    ok(r.ok && r.fact.source.line === 3, 'citation retrouvée : ligne réelle recalculée (3, pas celle annoncée)', JSON.stringify(r));
    ok(r.ok && /^f-[0-9a-f]{10}$/.test(r.fact.id) && r.fact.status === 'observed', 'identifiant stable et statut « observed »');
    ok(!KG.validateFact({ ...f, source: { ...f.source, quote: 'une citation inventée' } }, { texts }).ok, 'citation introuvable dans la source ⇒ rejeté');
    ok(!KG.validateFact({ ...f, source: { ...f.source, quote: 'x'.repeat(201) } }, { texts }).ok, 'citation de plus de 200 caractères ⇒ rejeté');
    ok(!KG.validateFact({ ...f, source: { ...f.source, key: 'absent' } }, { texts }).ok, 'source non lue ⇒ rejeté');
    const jsons = new Map([['c', { defaults: { model: 'claude-y' } }]]);
    const j = { ...f, source: { kind: 'json', key: 'c', ref: 'c#/defaults/model', pointer: '/defaults/model', quote: '"claude-y"' } };
    ok(KG.validateFact(j, { jsons }).ok, 'pointeur JSON qui porte la valeur citée ⇒ accepté');
    ok(!KG.validateFact({ ...j, source: { ...j.source, quote: '"claude-z"' } }, { jsons }).ok, 'valeur différente au pointeur ⇒ rejeté');
    ok(!KG.validateFact({ ...j, source: { ...j.source, pointer: '/defaults/absent' } }, { jsons }).ok, 'pointeur introuvable ⇒ rejeté');
    ok(!KG.validateFact({ ...f, source: { kind: 'commit', ref: 'abc1234' } }, { commits: new Set(['def5678']) }).ok, 'commit inconnu ⇒ rejeté');
    ok(KG.validateFact({ ...f, source: { kind: 'commit', ref: 'abc1234' } }, { commits: new Set(['abc1234']) }).ok, 'commit connu ⇒ accepté');
    ok(!KG.validateFact({ ...f, source: { kind: 'oral' } }, { texts }).ok, 'provenance d’une autre nature ⇒ rejeté');
  }

  // ------------------------------------------------------------------------
  section('3. Secrets');
  {
    const key = 'sk-ant-api03-' + 'A'.repeat(30);
    const hex = 'ab12'.repeat(16);
    ok(!KG.scrubSecrets(`clé ${key}`).includes(key), 'clé d’API masquée');
    ok(!KG.scrubSecrets(`jeton ${hex}`).includes(hex), 'jeton hexadécimal masqué');
    ok(KG.scrubSecrets('commit 7da7d0e, version 0.124.0') === 'commit 7da7d0e, version 0.124.0', 'un identifiant court reste lisible');
    const texts = new Map([['m', `ligne avec ${key} dedans\n`]]);
    const r = KG.validateFact({ s: 'flotte:fleet', p: 'cites', o: 'mem:x', authority: 'document', source: { kind: 'md', key: 'm', ref: 'm:1', quote: `avec ${key} dedans` } }, { texts });
    ok(r.ok && !r.fact.source.quote.includes(key) && r.fact.source.masked === true, 'citation vérifiée AVANT masquage, puis masquée et marquée');
    for (const f of ['I:/x/.env', 'I:/x/.env.local', 'I:/x/secrets/a.txt', 'I:/x/.token', 'I:/o/logs/chef.jsonl', 'I:/o/logs/api-keys.status.json']) ok(KG.forbiddenSource(f), `source jamais lue : ${f}`);
    ok(!KG.forbiddenSource('I:/o/logs/runs/p-1/run.json') && !KG.forbiddenSource('C:/u/.claude/projects/x/memory/a.md'), 'run.json et mémoires restent lisibles');

    // End to end: a memory holding a key and a token never reaches logs/kg.
    const C = path.join(T, 'corpus-secret');
    fs.cpSync(CORPUS, C, { recursive: true });
    fs.writeFileSync(path.join(C, 'memory', 'feedback_secret_trap.md'), `---\nname: feedback_secret_trap\ndescription: piège ${key}\nmetadata:\n  type: feedback\n---\n\nClé à ne jamais recopier : ${key} et jeton ${hex}. Voir [[user_profile]].\n`);
    fs.appendFileSync(path.join(C, 'memory', 'MEMORY.md'), `- [feedback_secret_trap.md](feedback_secret_trap.md) — piège ${key}\n`);
    const R = path.join(T, 'root-secret');
    fs.mkdirSync(R);
    const b = await KG.build(R, { corpus: C, force: true });
    ok(b.ok, 'construction sur un corpus piégé', JSON.stringify(b));
    const dir = path.join(R, 'logs', 'kg');
    const all = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    ok(!all.includes(key) && !all.includes(hex), 'ni la clé ni le jeton dans logs/kg (derived, build, contradictions)');
    ok(all.includes('feedback_secret_trap'), 'la mémoire piégée est indexée (son nom), sans son secret');
  }

  // ------------------------------------------------------------------------
  section('4. Un seul module écrit, et seulement sous logs/kg');
  {
    const files = repoFiles(REPO).filter(f => /\.(mjs|js)$/.test(f) && f !== 'scripts/kg.mjs' && !/^scripts\/_test_kg_/.test(f));
    const naming = files.filter(f => { try { return /logs[\\/]+kg\b|['"`]logs['"`]\s*,\s*['"`]kg['"`]/.test(fs.readFileSync(path.join(REPO, f), 'utf8')); } catch { return false; } });
    ok(!naming.length, 'aucun autre module ne nomme logs/kg', naming.join(', '));
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'kg.mjs'), 'utf8');
    const writes = src.match(/fs\.(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|copyFileSync|cpSync)\(/g) || [];
    ok(writes.length === 0, 'kg.mjs n’écrit jamais en direct (tout passe par writeFileAtomic)', writes.join(', '));
    ok((src.match(/writeFileAtomic\(/g) || []).length === 2, 'deux écritures seulement : kgWrite (logs/kg) et writeKgSettings (bloc kg)');
    const R = path.join(T, 'root-writer');
    fs.mkdirSync(R);
    const before = hashTree(CORPUS);
    const b = await KG.build(R, { corpus: CORPUS, force: true });
    ok(b.ok, 'construction');
    ok(JSON.stringify(hashTree(CORPUS)) === JSON.stringify(before), 'sources inchangées octet pour octet');
    const created = Object.keys(hashTree(R)).map(f => f.replace(/\\/g, '/'));
    ok(created.length === 3 && created.every(f => /^logs\/kg\/(derived\.json|build\.json|contradictions\.md)$/.test(f)), 'seuls logs/kg/{derived,build}.json et contradictions.md sont créés', created.join(', '));
    const gi = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
    ok(/^logs\/\*$/m.test(gi), 'logs/ (donc logs/kg) est hors git');
  }

  // ------------------------------------------------------------------------
  section('5. Interrupteur à chaud : off = comportement d’avant');
  {
    const R = path.join(T, 'root-switch');
    fs.mkdirSync(R);
    fs.writeFileSync(path.join(R, 'config.json'), JSON.stringify({ defaults: { model: 'claude-opus-5-5' }, projects: [{ name: 'demo', path: R }] }));
    const routing = { version: 2, assignments: { 'dev.rouge': { provider: 'claude', model: 'claude-opus-5-5' } }, enforcement: { projects: ['demo'], pipelines: ['discussion', 'dev'] }, history: [] };
    fs.writeFileSync(path.join(R, 'model-routing.json'), JSON.stringify(routing));
    ok(KG.readKgSettings(R).mode === 'off', 'absent = off');
    const off = await KG.build(R, { corpus: CORPUS });
    ok(!off.ok && off.refused === 'off', 'off : construction refusée');
    ok(!fs.existsSync(path.join(R, 'logs')), 'off : rien n’est écrit');
    const env = { DISPATCH_ROOT_FOR_TESTS: R };
    const q = node([path.join(REPO, 'scripts', 'kg.mjs'), 'contradictions'], env);
    ok(q.status === 2 && /off/.test(q.stderr), 'off : requête refusée (code 2) en le disant', q.stderr);
    const cliBuild = node([path.join(REPO, 'scripts', 'kg.mjs'), 'build', '--corpus', CORPUS], env);
    ok(cliBuild.status === 2 && !fs.existsSync(path.join(R, 'logs')), 'off : « kg.mjs build » refusé, rien écrit');

    const on = node([path.join(REPO, 'scripts', 'pipeline-enforce.mjs'), 'kg', 'shadow'], env);
    ok(on.status === 0 && /shadow/.test(on.stdout) && /aucune injection/.test(on.stdout), 'pipeline-enforce kg shadow', on.stdout + on.stderr);
    const j = JSON.parse(fs.readFileSync(path.join(R, 'model-routing.json'), 'utf8'));
    ok(j.kg?.mode === 'shadow' && j.assignments['dev.rouge'] && j.enforcement.projects[0] === 'demo', 'seul le bloc kg est écrit, cases et mise en service gardées');
    ok(KG.readKgSettings(R).mode === 'shadow', 'relu à chaque appel, sans redémarrage');
    const b2 = node([path.join(REPO, 'scripts', 'kg.mjs'), 'build', '--corpus', CORPUS, '--no-live'], env);
    ok(b2.status === 0 && fs.existsSync(path.join(R, 'logs', 'kg', 'derived.json')), 'shadow : construction permise', b2.stderr);
    const q2 = node([path.join(REPO, 'scripts', 'kg.mjs'), 'contradictions', '--json'], env);
    ok(q2.status === 0 && JSON.parse(q2.stdout).conflicts.length >= 1, 'shadow : requête permise', q2.stderr);
    const tun = node([path.join(REPO, 'scripts', 'pipeline-enforce.mjs'), 'tuning', 'suiteCache', 'on'], env);
    ok(tun.status === 0 && JSON.parse(fs.readFileSync(path.join(R, 'model-routing.json'), 'utf8')).kg?.mode === 'shadow', 'une autre commande de pipeline-enforce garde le bloc kg');
    ok(node([path.join(REPO, 'scripts', 'pipeline-enforce.mjs'), 'kg', 'assist'], env).status === 0 && KG.readKgSettings(R).mode === 'assist', 'assist accepté');
    ok(node([path.join(REPO, 'scripts', 'pipeline-enforce.mjs'), 'kg', 'peut-etre'], env).status === 64, 'mode inconnu refusé (64)');
    const all = node([path.join(REPO, 'scripts', 'pipeline-enforce.mjs'), 'off', '--all'], env);
    ok(all.status === 0 && KG.readKgSettings(R).mode === 'off' && !('kg' in JSON.parse(fs.readFileSync(path.join(R, 'model-routing.json'), 'utf8'))), '« off --all » coupe aussi l’index (bloc kg retiré)');

    // Nothing is injected: no turn module reaches kg.mjs.
    const files = repoFiles(REPO);
    const graph = referenceGraph(REPO, files);
    for (const root of ['scripts/dispatch.mjs', 'server.js', 'scripts/pipeline-engine.mjs', 'scripts/auto-answer.mjs']) {
      if (!files.includes(root)) continue;
      ok(!importClosure(graph, [root]).has('scripts/kg.mjs'), `${root} n’importe pas kg.mjs (aucune injection, off = comportement actuel)`);
    }
  }
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
