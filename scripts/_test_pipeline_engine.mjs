#!/usr/bin/env node
// ============================================================================
// scripts/_test_pipeline_engine.mjs — moteur de pipelines, phase 3 (0.48.0)
// ============================================================================
//
// Demande utilisateur (2026-10-09) : « est-ce que l'on utilise les pipeline
// specifies plutot ? Sinon, il faut faire en sorte que ces pipelines soient
// obligatoirement utlises. » Phase 3 : une étape = un tour sur le model de sa
// case (principal + second), handoff par fichiers, critères de sortie vérifiés
// par le code, jeton par étape, pause sur model indisponible, avertissements de
// limite, Discussion + Développement léger.
//
// VRAI dispatch.mjs, VRAI moteur, doublure de claude (FAKE_CLAUDE_PIPELINE),
// racine jetable (DISPATCH_ROOT_FOR_TESTS), notifications vers un port mort :
// la production n'est jamais touchée.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { deriveState, isPhantomResult, createJournal } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Briques : jeton d’étape, cases, nature, globs, chemins cités');
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pipe-'));
const tok = E.signStepToken(R, { run: 'p-20261009T120000-abcd', key: '01-vert', project: 'P', model: 'm1', provider: 'claude', exp: Date.now() + 60_000 });
ok(E.verifyStepToken(R, tok).ok, 'jeton signé → valide');
ok(!E.verifyStepToken(R, tok.replace(/.$/, c => (c === '0' ? '1' : '0'))).ok, 'signature altérée → refusé');
const parts = tok.split('.');
const forged = `v1.${Buffer.from(JSON.stringify({ run: 'p-20261009T120000-abcd', key: '01-vert', project: 'P', model: 'autre', exp: Date.now() + 60_000 })).toString('base64url')}.${parts[2]}`;
ok(!E.verifyStepToken(R, forged).ok, 'contenu changé (autre model) → refusé');
ok(!E.verifyStepToken(R, E.signStepToken(R, { exp: Date.now() - 1 })).ok, 'jeton expiré → refusé');
ok(!E.verifyStepToken(R, null).ok, 'pas de jeton → refusé');
const A = { 'dev.vert': { provider: 'anthropic', model: 'claude-sonnet-5-5' }, 'dev.vert.simple': { provider: 'openai', model: 'gpt-6-astra', second: { provider: 'anthropic', model: 'claude-opus-5-5' } }, 'dev.rouge.bugfix': { provider: 'local', model: 'ffmpeg' } };
const c1 = E.resolveCase(A, ['dev.vert.simple', 'dev.vert']);
ok(c1.slot === 'dev.vert.simple' && c1.provider === 'codex' && c1.second?.provider === 'claude' && c1.source === 'pipeline', 'variante affectée (principal + second) gagne');
ok(E.resolveCase(A, ['dev.vert.mecanique', 'dev.vert']).model === 'claude-sonnet-5-5', 'variante vide → étape');
const c3 = E.resolveCase(A, ['dev.rouge.bugfix', 'dev.rouge']);
ok(c3.source === 'project-default' && c3.model === null, 'outil local ou case vide → défaut du projet (avertissement)');
ok(E.devKind('corrige le bug du titre') === 'bugfix' && E.devKind('renomme slugify en toSlug') === 'mecanique' && E.devKind('ajoute une fonction double') === 'simple', 'nature : bugfix / mécanique / simple');
ok(E.isTestFile('test/a/b.test.mjs', ['test/**']) && !E.isTestFile('src/a.js', ['test/**']) && E.isTestFile('x.test.js', ['**/*.test.*']), 'globs de test');
fs.mkdirSync(path.join(R, 'src')); fs.writeFileSync(path.join(R, 'src', 'a.js'), '');
ok(JSON.stringify(E.missingCitedPaths('voir `src/a.js` et `src/b.js`, `npm test`, `https://x.y/z`', R)) === '["src/b.js"]', 'chemin cité inexistant repéré, le reste ignoré');
ok(E.planSteps('dev', { kind: 'mecanique' }).map(s => s.id).join() === 'vert,revue,livrer' && E.planSteps('dev', { kind: 'bugfix' })[0].chain[0] === 'dev.rouge.bugfix', 'plans : mécanique sans 4a, bugfix = variante Bugfix');
fs.rmSync(R, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Racine jetable : config, cases, mise en service, projet git
// ---------------------------------------------------------------------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pipe-root-'));
const P = path.join(T, 'proj');
const Q = path.join(T, 'other');
for (const d of [path.join(T, 'logs'), P, Q, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }, { name: 'Q', path: Q }],
}));
const routing = (extra = {}) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: {
    'discussion.comprendre': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'discussion.rechercher': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'discussion.repondre': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'dev.rouge': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'dev.vert': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'dev.revue': { provider: 'anthropic', model: 'claude-fable-5-1' },
    ...extra,
  }, history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
}, null, 2));
routing();
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
function initRepo(dir) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
  fs.mkdirSync(path.join(dir, '.orchestrateur'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
  g(dir, 'init', '-q'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
}
initRepo(P); initRepo(Q);
const head = (dir) => g(dir, 'rev-parse', 'HEAD').stdout.trim();
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME']) delete baseEnv[k];
const dispatch = (args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const logOf = (name) => { try { return fs.readFileSync(path.join(T, 'logs', `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const since = (name, n) => logOf(name).slice(n);
const runOf = (evs) => evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const stepLog = (run, key) => fs.readFileSync(path.join(T, 'logs', 'runs', run, `${key}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// ---------------------------------------------------------------------------
section('2. Discussion : 3 étapes, model de chaque case, artefacts, lecture seule, UN tour');
let n0 = logOf('P').length;
let r = dispatch(['P', 'Pourquoi la suite de tests passe-t-elle ?']);
let evs = since('P', n0);
let run = runOf(evs);
ok(r.code === 0 && run, `exécution terminée (code ${r.code})`, r.out.slice(-800));
const up = evs.find(e => e.type === 'user_prompt');
ok(up?.pipeline?.pipeline === 'discussion' && up.pipeline.steps.map(s => s.id).join() === 'comprendre,rechercher,repondre', 'classée Discussion automatiquement, 3 étapes annoncées');
ok(evs.filter(e => e.type === 'user_prompt').length === 1 && evs.filter(e => e.type === 'result').length === 1, 'côté musicien : UN user_prompt, UN result (un seul tour)');
const done = evs.filter(e => e.subtype === 'pipeline_step_done');
ok(done.length === 3 && done.every(d => d.status === 'ok'), 'chaque étape : critère vérifié');
ok(done.map(d => d.served).join() === 'claude-opus-5-5,claude-sonnet-5-5,claude-opus-5-5', `model SERVI = model de la case, étape par étape (${done.map(d => d.served).join(', ')})`);
const sl = stepLog(run, done[0].pipeline.key);
ok(sl[0]?.type === 'user_prompt' && sl[0].pipelineStep?.run === run && sl[0].pipelineStep.modelSource === 'pipeline', 'log d’étape : user_prompt.pipelineStep {run, key, modelSource: pipeline}');
const res = evs.find(e => e.type === 'result');
ok(/Réponse simulée/.test(res?.result || '') && !isPhantomResult(res) && !res.is_error, 'result final = reponse.md, ni fantôme ni erreur');
ok(fs.existsSync(path.join(P, '.orchestrateur', 'runs', run, 'comprehension.md')) && fs.existsSync(path.join(P, '.orchestrateur', 'runs', run, 'recherche.md')), 'handoff par fichiers : comprehension.md, recherche.md');
ok(!g(P, 'status', '--porcelain').stdout.trim(), 'projet inchangé (artefacts exclus de git)');
ok(deriveState(logOf('P').map(e => JSON.stringify(e))).state === 'unread', 'état du musicien : terminé, non lu');
const J = createJournal(); for (const e of logOf('P')) J.push(e);
const JT = J.list();
ok(JT.length >= 1 && JT[0].pipeline?.steps.filter(s => s.status === 'ok').length === 3 && JT[0].outcome === 'ok', 'journal : un tour, avec la frise de ses 3 étapes');
ok(runState(run).status === 'done', 'run.json : done');

// ---------------------------------------------------------------------------
section('3. Développement léger : 4a rouge → 4b vert → revue → livrer, un commit');
routing({ 'dev.livrer': undefined });   // case vide : défaut du projet + avertissement
n0 = logOf('P').length;
const h0 = head(P);
r = dispatch(['P', 'Ajoute une fonction double qui multiplie par deux', '--mode', 'leger']);
evs = since('P', n0); run = runOf(evs);
ok(r.code === 0, `exécution terminée (code ${r.code})`, r.out.slice(-1200));
const d2 = evs.filter(e => e.subtype === 'pipeline_step_done');
ok(d2.map(d => `${d.pipeline.step}:${d.status}`).join() === 'rouge:ok,vert:ok,revue:ok,livrer:ok', `étapes : ${d2.map(d => `${d.pipeline.step}:${d.status}`).join(', ')}`);
ok(g(P, 'rev-list', '--count', `${h0}..HEAD`).stdout.trim() === '1', 'UN seul commit livré');
ok(JSON.parse(fs.readFileSync(path.join(P, 'package.json'), 'utf8')).version === '1.0.1' && /## \[1\.0\.1\]/.test(fs.readFileSync(path.join(P, 'CHANGELOG.md'), 'utf8')), 'version 1.0.1 + entrée CHANGELOG');
ok(!g(P, 'status', '--porcelain').stdout.trim(), 'arbre propre');
ok(evs.some(e => e.subtype === 'pipeline_warning' && /livrer/i.test(e.pipeline?.step || '')), 'case vide → avertissement « défaut du projet » visible');
ok(d2.find(d => d.pipeline.step === 'livrer')?.modelSource === 'project-default' && d2.find(d => d.pipeline.step === 'vert')?.modelSource === 'pipeline', 'modelSource : pipeline / project-default');
ok(d2.find(d => d.pipeline.step === 'rouge')?.test?.ok === false && d2.find(d => d.pipeline.step === 'vert')?.test?.ok === true, 'suite lancée par l’orchestrateur : rouge après 4a, verte après 4b');
routing();

// ---------------------------------------------------------------------------
section('4. Critères refusés : essai rejeté puis repris ; limite → pause annoncée');
g(P, 'reset', '-q', '--hard', h0);
n0 = logOf('P').length;
r = dispatch(['P', 'Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_BAD: 'rouge:1' });
evs = since('P', n0);
const rouge = evs.filter(e => e.subtype === 'pipeline_step_done' && e.pipeline.step === 'rouge');
ok(r.code === 0 && rouge.length === 2 && rouge[0].status === 'refused' && /hors tests.*src\/pipe\.mjs/.test(rouge[0].why) && rouge[1].status === 'ok',
  `4a qui touche le code : refusé (« ${rouge[0]?.why?.slice(0, 80)} »), puis repris`, r.out.slice(-600));
g(P, 'reset', '-q', '--hard', h0);
n0 = logOf('P').length;
r = dispatch(['P', 'Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_BAD: 'vert' });
evs = since('P', n0); run = runOf(evs);
const vert = evs.filter(e => e.subtype === 'pipeline_step_done' && e.pipeline.step === 'vert');
ok(r.code === 2 && vert.length === 3 && vert.every(v => v.status === 'refused' && /fichiers de test modifiés/.test(v.why)), `4b qui affaiblit le test : 3 essais refusés (code ${r.code})`);
const lim = evs.find(e => e.type === 'notification' && e.subtype === 'pipeline_limit');
ok(lim?.limit === 'green' && /Limite atteinte/.test(lim.text), `signal 1 : notification/pipeline_limit (« ${lim?.text} »)`);
const st = deriveState(logOf('P').map(e => JSON.stringify(e)));
ok(st.state === 'input', 'signal 2 : question dans le dashboard (état input)');
// 0.50.1 : la question est en langage clair (plus de commande) — elle liste les
// quatre réponses possibles et la recommandation.
ok(/NEEDS_USER_INPUT: .*« continuer ».*« simplifier ».*« changer le model ».*« abandonner ».*je recommande/.test(evs.find(e => e.type === 'result')?.result || ''), 'la question propose de continuer, changer de model ou abandonner');
ok(runState(run).status === 'paused', 'run.json : paused');
ok(!fs.existsSync(path.join(P, 'src', 'pipe.mjs')) || g(P, 'diff', '--quiet', '--', 'test').status === 0, 'essais refusés annulés (tests intacts)');
// Reprise : « continuer » relance l'exécution en pause, à son étape.
n0 = logOf('P').length;
r = dispatch(['P', 'continuer']);
evs = since('P', n0);
ok(r.code === 0 && runOf(evs) === run && evs.find(e => e.type === 'user_prompt')?.pipeline?.resumed, `« continuer » reprend la même exécution (${run})`, r.out.slice(-600));
ok(evs.filter(e => e.subtype === 'pipeline_step_done').map(e => e.pipeline.step).join() === 'vert,revue,livrer', 'reprise à l’étape 4b, sans refaire 4a');

// ---------------------------------------------------------------------------
section('5. Revue → correction → revue (boucle bornée)');
g(P, 'reset', '-q', '--hard', h0);
n0 = logOf('P').length;
r = dispatch(['P', 'Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_REVIEW: 'problemes:1' });
evs = since('P', n0);
ok(r.code === 0 && evs.some(e => e.subtype === 'pipeline_loop'), 'problème relevé → retour à 4b (pipeline_loop)', `code ${r.code} — ${evs.filter(e => e.subtype === 'pipeline_step_done').map(e => `${e.pipeline.step}:${e.status}:${e.why || ''}`).join(' | ')}\n${r.out.slice(-600)}`);
ok(evs.filter(e => e.subtype === 'pipeline_step_done').map(e => e.pipeline.step).join() === 'rouge,vert,revue,vert,revue,livrer', 'enchaînement rouge, vert, revue, vert, revue, livrer');
g(P, 'reset', '-q', '--hard', h0);
n0 = logOf('P').length;
r = dispatch(['P', 'Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_REVIEW: 'problemes', ORCH_PIPE_REVIEW_ROUNDS: '1' });
evs = since('P', n0);
ok(r.code === 2 && evs.find(e => e.subtype === 'pipeline_limit')?.limit === 'review', 'tours de revue épuisés → pause + signal « review »');
g(P, 'reset', '-q', '--hard', h0);

// ---------------------------------------------------------------------------
section('6. Model indisponible → pause, aucun repli');
n0 = logOf('P').length;
r = dispatch(['P', 'Pourquoi la suite de tests passe-t-elle ?'], { FAKE_CLAUDE_FAIL_MODEL: 'claude-sonnet-5-5' });
evs = since('P', n0); run = runOf(evs);
const lim6 = evs.find(e => e.subtype === 'pipeline_limit');
ok(r.code === 2 && lim6?.limit === 'model_unavailable' && lim6.value === 'claude-sonnet-5-5', 'étape Rechercher : model indisponible → pause');
const rk = evs.filter(e => e.subtype === 'pipeline_step_done').pop()?.pipeline.key;
const s6 = stepLog(run, rk);
ok(s6.some(e => e.subtype === 'fallback_refused') && !s6.some(e => e.type === 'assistant' && e.message?.model && !['claude-sonnet-5-5', '<synthetic>'].includes(e.message.model)), 'fallback_refused, aucun autre model n’a servi');
ok(!evs.some(e => e.subtype === 'pipeline_step_start' && e.pipeline.step === 'repondre'), 'l’étape suivante n’est pas lancée');

// ---------------------------------------------------------------------------
section('7. Rien ne contourne : musicien, étape, jeton, model à la main, hors pipeline');
r = dispatch(['P', 'fais autre chose'], { ORCH_TURN_PROJECT: 'Q' });
ok(r.code === 65 && /musicien « Q »/.test(r.out), 'dispatch lancé depuis le tour d’un musicien → refusé (65)');
r = dispatch(['Q', 'fais autre chose'], { ORCH_TURN_STEP: 'p-20261009T120000-abcd:01-vert', ORCH_TURN_PROJECT: 'P' });
ok(r.code === 65 && /étape de pipeline/.test(r.out), 'dispatch lancé depuis une étape → refusé (65), même vers un autre projet');
r = dispatch(['P', 'x', '--pipeline-step', 'p-20261009T120000-abcd:01-vert']);
ok(r.code === 65 && /jeton/.test(r.out), 'tour d’étape forgé sans jeton → refusé (65)');
const tk = E.signStepToken(T, { run: 'p-20261009T120000-abcd', key: '01-vert', project: 'P', model: 'claude-sonnet-5-5', provider: 'claude', exp: Date.now() + 60_000 });
r = dispatch(['P', 'x', '--pipeline-step', 'p-20261009T120000-abcd:01-vert', '--model', 'claude-opus-5-5'], { ORCH_STEP_TOKEN: tk });
ok(r.code === 65 && /model de la case/.test(r.out), 'jeton valide mais autre model → refusé (65)');
r = dispatch(['P', 'ajoute un bouton', '--model', 'claude-opus-5-5']);
ok(r.code === 64 && /page Models/.test(r.out), 'projet en service + --model à la main → refusé (64)');
n0 = logOf('P').length;
r = dispatch(['P', 'redémarre le banc', '--hors-pipeline', 'maintenance de la flotte']);
evs = since('P', n0);
ok(r.code === 0 && evs.find(e => e.type === 'user_prompt')?.pipelineBypass?.reason === 'maintenance de la flotte' && evs.some(e => e.subtype === 'pipeline_bypass'), '--hors-pipeline : tour ordinaire, raison écrite et visible');
r = dispatch(['Q', 'fais autre chose'], { ORCH_TURN_PROJECT: 'P' });
ok(r.code === 0, 'projet hors service : comportement inchangé (un musicien peut y dispatcher)');

// ---------------------------------------------------------------------------
section('8. Pipeline pas encore en service : tour ordinaire, tracé');
n0 = logOf('P').length;
r = dispatch(['P', 'fais un état de l\'art comparatif des bibliothèques de tests et donne les sources']);
evs = since('P', n0);
const byp = evs.find(e => e.subtype === 'pipeline_bypass');
ok(r.code === 0 && byp?.by === 'hors-perimetre' && !evs.some(e => e.type === 'user_prompt' && e.pipeline), `classée hors périmètre → tour ordinaire, trace « ${byp?.text?.slice(0, 70)} »`);

// ---------------------------------------------------------------------------
section('9. Étape en mode double (principal + second de la case)');
routing({ 'discussion.repondre': { provider: 'anthropic', model: 'claude-opus-5-5', second: { provider: 'anthropic', model: 'claude-fable-5-1' } } });
n0 = logOf('P').length;
r = dispatch(['P', 'Pourquoi la suite de tests passe-t-elle ?']);
evs = since('P', n0); run = runOf(evs);
const rep = evs.filter(e => e.subtype === 'pipeline_step_done').find(e => e.pipeline.step === 'repondre');
ok(r.code === 0 && rep?.status === 'ok', `étape Répondre en double : critère vérifié (code ${r.code})`, r.out.slice(-800));
const sl9 = stepLog(run, rep?.pipeline.key || 'x');
ok(sl9.some(e => e.subtype === 'dual_start') && sl9.some(e => e.subtype === 'dual_summary') && !logOf('P').slice(n0).some(e => e.subtype === 'dual_start'),
  'branches + relecture dans le log de l’étape, pas dans celui du musicien');
ok(sl9.filter(e => e.subtype === 'dual_branch_done').map(e => e.model).sort().join() === 'claude-fable-5-1,claude-opus-5-5', 'les deux models de la case ont tourné');
routing();

// ---------------------------------------------------------------------------
section('10. Mise en service : lecture, écriture atomique, hors service = inchangé');
const enf = E.readEnforcement(T);
ok(E.isEnforced(enf, 'P') && !E.isEnforced(enf, 'Q') && enf.pipelines.join() === 'discussion,dev', 'enforcement lu dans model-routing.json');
E.writeEnforcement(T, { projects: [], pipelines: ['discussion', 'dev'], by: 'test' });
ok(!E.isEnforced(E.readEnforcement(T), 'P') && JSON.parse(fs.readFileSync(path.join(T, 'model-routing.json'), 'utf8')).assignments['dev.vert'], 'retour arrière : liste vidée, cases conservées');
n0 = logOf('P').length;
r = dispatch(['P', 'Pourquoi la suite de tests passe-t-elle ?']);
ok(r.code === 0 && !since('P', n0).some(e => e.type === 'user_prompt' && e.pipeline), 'hors service : un tour ordinaire, comme avant');
r = dispatch(['P', 'Pourquoi la suite de tests passe-t-elle ?', '--pipeline', 'discussion']);
ok(r.code === 0, '--pipeline explicite marche aussi hors service');

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
