#!/usr/bin/env node
// ============================================================================
// scripts/_test_routage_dedupe.mjs — Routage task deduplication on an explicit
// identity, never on a text prefix; no duplicate dropped silently (0.67.0)
// ============================================================================
//
// User request (2026-10-10), verbatim: « La clé de dédoublonnage ne garde que
// les 120 premiers caractères de la demande : manifestement mauvaise methode,
// trouves en une autre ».
// Real incident: in a Routage run, task 4 was dropped as a duplicate of task 3
// (same opening text, different work), with no alert and no trace; the run's
// dispatch.json even listed it as waiting.
//
// Protected:
//   - two different tasks sharing their first 200 characters are BOTH kept;
//   - a true duplicate (same Routage task re-dispatched, same work queued again
//     by another Routage run, same resumed run) is still refused — with its
//     reason, the entry it matched, a line in routage-pending-duplicates.ndjson
//     and a report to the chef;
//   - dispatch.json lists as waiting only what was really queued;
//   - a dependency waits for ITS task, not for a task with the same opening.
//
//   node scripts/_test_routage_dedupe.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RP from './routage-pending.mjs';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const J = (evs) => evs.map(e => JSON.stringify(e)).join('\n') + '\n';

// The real shape of the incident: one long shared opening, a different end.
const HEAD = 'Décision de l’utilisateur (2026-10-10), verbatim : « c+d » — rendre les pipelines Développement plus atomiques. Contexte complet : la liste de tests déclare ses tests, la vérification après coup compte les tests réellement écrits, et ';
const TASK3 = `${HEAD}TÂCHE 3 : la Revue porte sur le diff d’un seul item, juste après sa boucle.`;
const TASK4 = `${HEAD}TÂCHE 4 : chaque item validé est livré dans son propre commit.`;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dedupe-'));

// ---------------------------------------------------------------------------
section('1. Deux tâches au même début de texte mais différentes : les deux sont gardées');
{
  const L = path.join(T, 'l1'); fs.mkdirSync(L);
  ok(HEAD.length > 200 && RP.taskKey(TASK3) === RP.taskKey(TASK4), 'l’ancienne clé (120 premiers caractères) les confondait : même clé pour la tâche 3 et la tâche 4');
  ok(RP.contentHash({ projet: 'O', demande: TASK3 }) !== RP.contentHash({ projet: 'O', demande: TASK4 }), 'empreinte du texte complet : différente');
  const after = { projet: 'Q', offset: 0, hash: RP.textHash('tâche 1') };
  const r = RP.addPending(L, [
    { run: 'p-20261010T080000-aaaaaa', n: 3, projet: 'O', pipeline: 'dev', mode: 'complet', demande: TASK3, after },
    { run: 'p-20261010T080000-aaaaaa', n: 4, projet: 'O', pipeline: 'dev', mode: 'complet', demande: TASK4, after },
  ]);
  ok(r.added.length === 2 && r.duplicates.length === 0 && RP.readPending(L).length === 2, `les deux sont en attente (${r.added.length} ajoutée(s), ${r.duplicates.length} doublon(s))`);
  ok(new Set(r.added.map(t => t.id)).size === 2, 'deux identifiants distincts');
}

// ---------------------------------------------------------------------------
section('2. Un vrai doublon reste écarté — mais jamais en silence');
{
  const L = path.join(T, 'l2'); fs.mkdirSync(L);
  const after = { projet: 'Q', offset: 0, hash: RP.textHash('tâche 1') };
  const base = { run: 'p-20261010T080000-bbbbbb', n: 2, projet: 'O', pipeline: 'dev', mode: 'leger', demande: 'Ajoute un bouton', after };
  RP.addPending(L, [base]);
  let r = RP.addPending(L, [{ ...base, demande: 'Ajoute un bouton (formulation revue)' }]);
  ok(r.added.length === 0 && r.duplicates[0]?.key.startsWith('ref:') && /re-dispatch/.test(r.duplicates[0].reason), `même tâche du même Routage re-dispatchée (texte reformulé) : écartée — « ${r.duplicates[0]?.reason} »`);
  r = RP.addPending(L, [{ ...base, run: 'p-20261010T090000-cccccc', n: 1, demande: 'ajoute   un BOUTON' }]);
  ok(r.duplicates[0]?.key.startsWith('content:') && r.duplicates[0].keptId === RP.readPending(L)[0].id && r.duplicates[0].keptN === 2,
    'même travail remis en file par un autre Routage (réveil rejoué) : écarté, avec l’entrée gardée');
  const lines = fs.readFileSync(path.join(L, RP.DUPLICATES_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  ok(lines.length === 2 && lines.every(d => d.at && d.reason && d.keptId && d.demande), `chaque doublon est journalisé dans ${RP.DUPLICATES_FILE} (date, motif, entrée gardée, demande)`);
  ok(/tâche 1 du Routage p-20261010T090000-cccccc\) : écartée — même travail/.test(RP.duplicatesText(r.duplicates)), 'texte du signalement au chef : quelle tâche, pourquoi, laquelle est gardée');
  r = RP.addPending(L, [{ ...base, run: 'p-x', n: 9, demande: 'Ajoute un bouton', mode: 'complet' }]);
  ok(r.added.length === 1, 'même texte mais autre mode : ce n’est pas le même travail, gardée');
}

// ---------------------------------------------------------------------------
section('3. Une dépendance attend SA tâche, pas une tâche au même début');
{
  const L = path.join(T, 'l3'); fs.mkdirSync(L);
  fs.writeFileSync(path.join(L, 'O.jsonl'), '');
  const after = { projet: 'O', offset: 0, key: RP.taskKey(TASK4), hash: RP.textHash(TASK4) };
  fs.writeFileSync(path.join(L, 'O.jsonl'), J([
    { type: 'user_prompt', text: `${TASK3}\n\n(Rattachée à : c+d)`, source: 'chef', callback: 'chef' },
    { type: 'result', subtype: 'success', num_turns: 3, duration_api_ms: 900, result: 'tâche 3 faite' },
  ]));
  ok(RP.dependencyResult(L, after) === null, 'le result de la tâche 3 ne libère pas ce qui attend la tâche 4');
  fs.appendFileSync(path.join(L, 'O.jsonl'), J([
    { type: 'user_prompt', text: `${TASK4}\n\n(Rattachée à : c+d)`, source: 'chef', callback: 'chef' },
    { type: 'result', subtype: 'success', num_turns: 3, duration_api_ms: 900, result: 'tâche 4 faite' },
  ]));
  ok(RP.dependencyResult(L, after)?.result === 'tâche 4 faite', 'le result de la tâche 4 la libère');
}

// ---------------------------------------------------------------------------
section('4. Libération : deux jumeaux (anciennes entrées) partent une seule fois, l’autre est tracé');
{
  const L = path.join(T, 'l4'); fs.mkdirSync(L);
  fs.writeFileSync(path.join(L, 'routage-pending.json'), JSON.stringify({ tasks: [
    { projet: 'O', demande: 'Même travail', after: { projet: 'Q', since: '2000-01-01T00:00:00Z' } },
    { projet: 'O', demande: 'même   travail', after: { projet: 'Q', since: '2000-01-01T00:00:00Z' } },
  ] }));
  fs.writeFileSync(path.join(L, 'Q.jsonl'), J([{ type: 'result', subtype: 'success', num_turns: 2, duration_api_ms: 5, result: 'ok', timestamp: '2026-10-10T08:00:00Z' }]));
  const launched = [];
  const r = RP.releaseReady({ root: T, logsDir: L, dispatchScript: 'x', launch: (root, t) => { launched.push(t); return { projet: t.projet }; } });
  ok(launched.length === 1 && r.duplicates.length === 1 && fs.readFileSync(path.join(L, RP.DUPLICATES_FILE), 'utf8').includes('jumeau'), `un seul lancement, le jumeau journalisé (${launched.length} lancement(s))`);
}

// ---------------------------------------------------------------------------
section('5. De bout en bout (vrai dispatch.mjs, Routage du chef) : tâches 3 et 4 gardées ; relance du même Routage signalée au chef');
{
  const R = path.join(T, 'e2e');
  for (const d of ['logs', 'chef', 'O', 'Q']) fs.mkdirSync(path.join(R, d), { recursive: true });
  fs.writeFileSync(path.join(R, 'chef', 'CLAUDE.md'), '# Chef\n');
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
  for (const n of ['O', 'Q']) {
    const dir = path.join(R, n);
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: n, version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }) + '\n');
    fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
    g(dir, 'init', '-q'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  }
  fs.writeFileSync(path.join(R, 'config.json'), JSON.stringify({ conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
    projects: ['chef', 'O', 'Q'].map(n => ({ name: n, path: path.join(R, n) })) }));
  fs.writeFileSync(path.join(R, 'model-routing.json'), JSON.stringify({ version: 2, history: [],
    enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
    assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])) }));
  const notices = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push(JSON.parse(b)); } catch {} res.end('{}'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: R, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5',
    ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME']) delete env[k];
  const tasks = [
    { projet: 'Q', pipeline: 'discussion', demande: 'Explique pourquoi la suite de tests passe.' },
    { projet: 'O', pipeline: 'discussion', demande: 'Résume l’état du dépôt.', apres: 1 },
    { projet: 'O', pipeline: 'discussion', demande: TASK3, apres: 1 },
    { projet: 'O', pipeline: 'discussion', demande: TASK4, apres: 1 },
  ];
  const fakeJson = JSON.stringify({ classifier: { nature: 'taches', raison: 'enchaînement' }, decomposer: { taches: tasks } });
  // Async: the notification listener lives in THIS process (spawnSync would block it).
  const chefTurn = async () => {
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', 'Lance les tâches c+d', '--test', 'dédoublonnage'], { env: { ...env, FAKE_PIPE_JSON: fakeJson }, windowsHide: true });
      let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
      const t = setTimeout(() => c.kill(), 180_000);
      c.on('exit', code => { clearTimeout(t); resolve({ status: code, stdout: out, stderr: '' }); });
    });
    const runs = fs.readdirSync(path.join(R, 'logs', 'runs')).sort();
    const run = runs[runs.length - 1];
    let disp = null; try { disp = JSON.parse(fs.readFileSync(path.join(R, 'chef', '.orchestrateur', 'runs', run, 'dispatch.json'), 'utf8')); } catch {}
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, run, disp };
  };
  let x = await chefTurn();
  const pend = RP.readPending(path.join(R, 'logs'));
  ok(x.code === 0 && pend.length === 3 && pend.some(t => t.demande === TASK3) && pend.some(t => t.demande === TASK4), `les tâches 2, 3 et 4 attendent la tâche 1 — la 4 n’est plus confondue avec la 3 (${pend.length} en attente)`, x.out.slice(-900));
  ok(x.disp?.waiting?.map(w => w.n).join(',') === '2,3,4' && !x.disp.duplicates, `dispatch.json : « waiting » = ce qui est vraiment en file (${x.disp?.waiting?.map(w => w.n).join(',')})`);
  ok(pend.every(t => t.after?.hash && Number.isInteger(t.n) && t.run === x.run), 'chaque attente porte sa référence (Routage + numéro) et l’empreinte de la tâche attendue');
  const k0 = notices.length;
  x = await chefTurn();
  ok(RP.readPending(path.join(R, 'logs')).length === 3 && x.disp?.waiting?.length === 0 && x.disp?.duplicates?.length === 3, `même Routage relancé : rien de remis en file, les 3 doublons sont listés dans dispatch.json (${x.disp?.duplicates?.length ?? 0})`, x.out.slice(-600));
  const note = notices.slice(k0).find(n => n.source === 'routage-duplicate' && n.project === 'chef');
  ok(note && /3 tâche\(s\) écartée\(s\) comme doublon/.test(note.text) && note.text.includes('tâche 4'), 'signalé au chef aussitôt : quelles tâches, pourquoi, lesquelles sont gardées', JSON.stringify(notices.slice(k0)).slice(0, 1500));
  ok(fs.readFileSync(path.join(R, 'logs', RP.DUPLICATES_FILE), 'utf8').trim().split('\n').length === 3, `et journalisé dans logs/${RP.DUPLICATES_FILE}`);
  srv.close();
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
