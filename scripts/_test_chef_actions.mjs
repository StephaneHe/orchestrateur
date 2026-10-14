#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_actions.mjs — Routage: the chef's own actions and the
// justified empty split (0.70.0, ROUTAGE-PROBLEMES n° 7 and 9)
// ============================================================================
//
// User request (2026-10-10, verbatim): « on commence par s'attaquer a ca »
// (tracking document docs/ROUTAGE-PROBLEMES.md, group B). A direct action of
// the chef (restart, kill-stalled, resolve-question, copy-build, or a plain
// answer without any dispatch) must be expressible in the chef's Routage:
//   - an empty split WITH a reason is accepted, without any defect;
//   - an allowlisted chef action is run by the orchestrator's code and NEVER
//     sent to a musician; the restart is scheduled after the turn;
//   - an action outside the allowlist is refused;
//   - a task for the chef (or a chef-N slot) is still refused.
// Real dispatch.mjs and engine, claude double, throw-away root, fake action
// runner (ORCH_CHEF_ACTION_RUNNER): no real script ever runs here.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { catalogSteps } from './pipeline-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chefact-'));
for (const d of ['logs', 'chef', 'Q']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
fs.writeFileSync(path.join(T, 'Q', 'package.json'), '{"name":"Q","version":"1.0.0"}\n');
spawnSync('git', ['init', '-q'], { cwd: path.join(T, 'Q') });
// chef-2 is listed so that the « no task for the chef » rule is what refuses it.
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'chef-2', 'Q'].map(n => ({ name: n, path: path.join(T, n === 'chef-2' ? 'chef' : n) })),
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));
// Fake runner: records each call, never runs anything.
const RUNS = path.join(T, 'runner-calls.ndjson');
const RUNNER = path.join(T, 'fake-runner.mjs');
fs.writeFileSync(RUNNER, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(RUNS)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('fake ' + process.argv[2]);\n`);
const calls = () => { try { return fs.readFileSync(RUNS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_CHEF_ACTION_RUNNER: RUNNER };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
function chefTurn(text, json, env = {}) {
  const n0 = logOf('chef').length, q0 = logOf('Q').length, c0 = calls().length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', text, '--test', 'actions-du-chef'],
    { env: { ...baseEnv, FAKE_PIPE_JSON: JSON.stringify(json), ...env }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const evs = logOf('chef').slice(n0);
  const run = evs.find(e => e.type === 'user_prompt')?.pipeline?.run;
  const art = run ? path.join(T, 'chef', '.orchestrateur', 'runs', run) : null;
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(art, f), 'utf8')); } catch { return null; } };
  const st = run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : null;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, st, read, qEvents: logOf('Q').slice(q0), calls: calls().slice(c0),
    result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const statusOf = (st) => (st?.steps || []).map(s => `${s.id}:${s.status}`).join(' ');
const ALL_OK = 'lire:ok comprendre:ok decomposer:ok classifier:ok affecter:ok dispatcher:ok rapporter:ok';

// ---------------------------------------------------------------------------
section('1. Format documenté dans la consigne de Découper ; « action » est une nature du sens global');
const steps = Object.fromEntries(catalogSteps('routage').map(s => [s.id, s]));
ok(/ACTIONS DU CHEF/.test(steps.decomposer.role) && /aucun_dispatch/.test(steps.decomposer.role) && /"actions"/.test(steps.decomposer.jsonExample) && /"aucun_dispatch"/.test(steps.decomposer.jsonExample),
  'Découper : « actions » (liste blanche) et « aucun_dispatch » expliqués et dans le format');
ok(Object.keys(E.CHEF_ACTIONS).sort().join() === 'copy-build,kill-stalled,resolve-question,restart-orchestrateur', `liste blanche : ${Object.keys(E.CHEF_ACTIONS).join(', ')}`);
ok(steps.comprendre.checks.jsonEnum.nature.includes('action') && ['decomposer', 'classifier', 'affecter', 'dispatcher'].every(id => steps[id].skipIf.unless.includes('action')), 'nature « action » : Découper → Dispatcher tournent');

// ---------------------------------------------------------------------------
section('2. Liste vide JUSTIFIÉE : acceptée, sans défaut, aucun dispatch');
let x = chefTurn('Où en est la flotte ?', { comprendre: { nature: 'taches', sens: 'point sur la flotte', raison: 'x' }, decomposer: { taches: [], aucun_dispatch: 'aucun dispatch nécessaire : réponse directe du chef' } });
ok(x.code === 0 && statusOf(x.st) === ALL_OK, `exécution : ${statusOf(x.st)}`, x.out.slice(-800));
ok(!x.evs.some(e => e.subtype === 'pipeline_defect') && x.st.steps.filter(s => s.id === 'decomposer').length === 1, 'aucun défaut, un seul essai de Découper');
ok(x.read('dispatch.json')?.dispatched?.length === 0 && /réponse directe/.test(x.read('dispatch.json')?.aucun_dispatch || ''), 'dispatch.json : rien lancé, la raison est gardée');
x = chefTurn('Où en est la flotte ?', { comprendre: { nature: 'taches', sens: 's', raison: 'x' }, decomposer: { taches: [] } });
const dec = x.st.steps.filter(s => s.id === 'decomposer');
ok(dec[0]?.status === 'refused' && /aucun_dispatch/.test(dec[0].why), 'liste vide SANS raison : refusée (le message dit quoi ajouter)', dec[0]?.why);

// ---------------------------------------------------------------------------
section('3. Actions du chef : exécutées par le code, JAMAIS dispatchées à un musicien');
x = chefTurn('Arrête le tour bloqué de Q, marque sa question répondue, puis redémarre le serveur', {
  comprendre: { nature: 'action', sens: 'actions directes du chef', raison: 'supervision' },
  decomposer: { taches: [], actions: [
    { action: 'kill-stalled', projet: 'Q', raison: 'tour bloqué depuis 2 h' },
    { action: 'resolve-question', projet: 'Q', note: 'répondu par le chef' },
    { action: 'restart-orchestrateur' }] } });
ok(x.code === 0 && statusOf(x.st) === ALL_OK, `exécution : ${statusOf(x.st)}`, x.out.slice(-800));
ok(x.calls.length === 3 && x.calls[0].join(' ') === 'kill-stalled Q --by chef --reason tour bloqué depuis 2 h' && x.calls[1].join(' ') === 'resolve-question Q --note répondu par le chef' && x.calls[2].join(' ') === 'restart-orchestrateur',
  `le code lance les 3 scripts avec un argv construit (${x.calls.map(c => c[0]).join(', ')})`, JSON.stringify(x.calls));
ok(!x.qEvents.some(e => e.type === 'user_prompt') && x.read('dispatch.json')?.dispatched?.length === 0, 'aucun tour lancé chez Q (ni chez aucun musicien)');
const acts = x.read('dispatch.json')?.actions || [];
ok(acts.map(a => a.status).join() === 'done,done,scheduled' && acts[2].deferred === true, `statuts : ${acts.map(a => `${a.action}:${a.status}`).join(', ')}`);
ok(x.evs.filter(e => e.subtype === 'chef_action').length === 3 && /Actions du chef \(exécutées par l’orchestrateur\)/.test(x.result) && /restart-orchestrateur : programmée après la fin de ce tour/.test(x.result), 'fil du chef et rapport : chaque action et son issue', x.result.slice(-500));

// ---------------------------------------------------------------------------
section('4. Action hors liste blanche, ou mal formée : refusée');
const bad = (actions) => E.validateChefActions(T, actions) || '';
ok(/n’est pas une action du chef autorisée/.test(bad([{ action: 'rm-rf' }])) && /n’est pas une action du chef autorisée/.test(bad([{ action: 'dispatch' }])), 'action inconnue : refusée');
ok(/projet inconnu/.test(bad([{ action: 'kill-stalled', projet: 'Z', raison: 'motif' }])) && /lui-même/.test(bad([{ action: 'kill-stalled', projet: 'chef', raison: 'motif' }])) && /lui-même/.test(bad([{ action: 'copy-build', projet: 'chef-2' }])), 'projet hors liste blanche, ou le chef lui-même : refusé');
ok(/« raison » obligatoire/.test(bad([{ action: 'kill-stalled', projet: 'Q' }])) && /en dernier/.test(bad([{ action: 'restart-orchestrateur' }, { action: 'copy-build', projet: 'Q' }])) && /pas de projet/.test(bad([{ action: 'restart-orchestrateur', projet: 'Q' }])), 'kill-stalled sans motif, redémarrage pas en dernier, projet sur le redémarrage : refusés');
x = chefTurn('Efface le dépôt Q', { comprendre: { nature: 'action', sens: 's', raison: 'x' }, decomposer: { taches: [], actions: [{ action: 'rm-rf', projet: 'Q' }] } });
ok(x.st.steps.find(s => s.id === 'decomposer')?.status === 'refused' && x.calls.length === 0 && !x.qEvents.some(e => e.type === 'user_prompt'), 'de bout en bout : Découper refusé, rien exécuté, rien dispatché');

// ---------------------------------------------------------------------------
section('5. Une tâche pour le chef (ou un slot chef-N) reste refusée');
ok(/le chef ne se délègue pas/.test(E.validateTasks(T, [{ projet: 'chef-2', titre: 'tâche de test 1', pipeline: 'dev', demande: 'redémarre le serveur' }]) || '') && /le chef ne se délègue pas/.test(E.validateUnitTasks(T, [{ projet: 'chef', titre: 'tâche de test 2', demande: 'redémarre le serveur' }]) || '') && /le chef ne se délègue pas/.test(E.validateUnitTasks(T, [{ projet: 'chef-2', titre: 'tâche de test 3', demande: 'redémarre le serveur' }]) || ''),
  'tâche pour chef ou chef-2 : refusée (Découper et Affecter)');
x = chefTurn('Redémarre', { comprendre: { nature: 'taches', sens: 's', raison: 'x' }, decomposer: { taches: [{ projet: 'chef-2', titre: 'tâche de test 4', demande: 'Redémarre le serveur de la prod.' }] } });
ok(x.st.steps.find(s => s.id === 'decomposer')?.status === 'refused' && x.calls.length === 0, 'de bout en bout : refusée, aucun lancement');

// ---------------------------------------------------------------------------
section('6. Sécurité : une racine de test sans doublure n’exécute jamais un vrai script');
x = chefTurn('Redémarre le serveur', { comprendre: { nature: 'action', sens: 's', raison: 'x' }, decomposer: { taches: [], actions: [{ action: 'restart-orchestrateur' }] } }, { ORCH_CHEF_ACTION_RUNNER: '' });
ok(x.code === 0 && x.read('dispatch.json')?.actions?.[0]?.status === 'refused', `restart sans doublure en test : « refused » (${x.read('dispatch.json')?.actions?.[0]?.status})`);
const d = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'chef-action-deferred.mjs'), '--wait-pid', '999999', '--script', 'restart-orchestrateur.mjs', '--dry-run'], { encoding: 'utf8' });
const d2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'chef-action-deferred.mjs'), '--wait-pid', '999999', '--script', 'server.js'], { encoding: 'utf8' });
ok(d.status === 0 && /dry-run: would run .*restart-orchestrateur\.mjs/.test(d.stdout) && d2.status === 64, 'lanceur différé : attend la fin du tour, puis seulement un script de sa liste blanche');

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
