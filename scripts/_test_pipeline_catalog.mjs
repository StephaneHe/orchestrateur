#!/usr/bin/env node
// ============================================================================
// scripts/_test_pipeline_catalog.mjs — pipelines phase 6, lot A (0.53.0):
// Incident, Recherche, Audit sécurité, Maintenance, Nouveau projet, Données,
// Rédaction — each with exit criteria checked by code.
// ============================================================================
//
// User request (2026-10-09): "Branche les autres pipelines … Chacun a ses
// critères de sortie vérifiés par le code et ses tests." Real dispatch.mjs,
// real engine, claude double (FAKE_CLAUDE_PIPELINE), throw-away root
// (DISPATCH_ROOT_FOR_TESTS), notifications to a dead port: production is never
// touched.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 700)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Briques : sections, sources, catalogue complet');
ok(E.missingSections('# T\n## Symptômes\nx\n### Preuves récoltées\ny', ['Symptomes', 'Preuves']).length === 0, 'sections trouvées sans accents ni casse');
ok(E.missingSections('## Impact\n', ['Impact', 'Gravité']).join() === 'Gravité', 'section manquante repérée');
ok(E.countSources('- https://a.org/x\n- https://a.org/x.\n- http://b.net/y') === 2, 'sources : URL distinctes');
// 0.56.0 — vu sur les premières exécutions réelles : citer un fichier pour dire qu'il est absent n'est pas une invention.
ok(JSON.stringify(E.missingCitedPaths('le dépôt ne contient ni `pyproject.toml` ni `setup.py`.\nvoir `src/invente.py`.\nIl n’y a pas de `docs/USER_REQUIREMENTS.md`.\nFichiers utiles : `inexistant/fichier.js`', ROOT)) === '["src/invente.py","inexistant/fichier.js"]',
  'chemin cité comme ABSENT : accepté ; chemin inventé : toujours refusé (même s’il contient « inexistant »)');
for (const p of ['incident', 'recherche', 'audit', 'maintenance', 'nouveau', 'donnees', 'redaction']) {
  const steps = E.planSteps(p);
  ok(E.ENGINE_PIPELINES.includes(p) && steps.length >= 3 && steps.every(s => s.artefact && s.chain.length && (s.checks || s.crit || s.kind === 'deliver')), `${p} : ${steps.map(s => s.id).join(' → ')} (critères déclarés à chaque étape)`);
}

// ---------------------------------------------------------------------------
// Racine jetable
// ---------------------------------------------------------------------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cat-'));
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'chef'));
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
function repo(name, { pipelineJson = true, redTest = false } = {}) {
  const dir = path.join(T, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  if (redTest) fs.writeFileSync(path.join(dir, 'test', 'pipe.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('pipe double', async () => {\n  const m = await import('../src/pipe.mjs');\n  assert.equal(m.double(2), 4);\n});\n");
  fs.writeFileSync(path.join(dir, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.writeFileSync(path.join(dir, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
  if (pipelineJson) {
    fs.mkdirSync(path.join(dir, '.orchestrateur'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md', scanCommands: ['node -e "console.log(\'SCAN-SIMULE-OK\')"'] }));
  }
  g(dir, 'init', '-q'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const NAMES = ['P', 'N'];
const writeConfig = () => fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, ...NAMES.map(n => ({ name: n, path: path.join(T, n) }))],
}));
writeConfig();
const routing = (pipelines = E.ENGINE_PIPELINES, extra = {}) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: NAMES, pipelines },
  assignments: {
    'incident.detecter': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'incident.corriger': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'recherche.synthetiser': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'audit.second-avis': { provider: 'anthropic', model: 'claude-fable-5-1' },
    'redaction.relire': { provider: 'anthropic', model: 'claude-opus-5-5' },
    ...extra,
  },
}, null, 2));
routing();
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'GITLEAKS_BIN']) delete baseEnv[k];
const dispatch = (args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
/** Lance un pipeline sur un dépôt neuf ; renvoie {r, evs, run, st, dir}. */
function play(pipeline, request, { env = {}, repoOpts = {}, name = 'P' } = {}) {
  const dir = repo(name, repoOpts);
  const n0 = logOf(name).length;
  const r = dispatch([name, request, '--pipeline', pipeline, '--test', `catalogue ${pipeline}`], env);
  const evs = logOf(name).slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
  return { r, evs, run, st: run ? runState(run) : null, dir };
}
const okSteps = (st) => st.steps.filter(s => s.status === 'ok').map(s => s.id);
const oneTurn = (evs) => evs.filter(e => e.type === 'user_prompt').length === 1 && evs.filter(e => e.type === 'result').length === 1;
const resultOf = (evs) => evs.filter(e => e.type === 'result').pop();
const head = (dir) => g(dir, 'rev-parse', 'HEAD').stdout.trim();

// ---------------------------------------------------------------------------
section('2. Incident : détecter → évaluer → contenir → diagnostiquer → test qui reproduit → correction → post-mortem → livrer');
let x = play('incident', 'corrige le bug : double() renvoie une erreur en production');
ok(x.r.code === 0 && x.st?.status === 'done', `exécution terminée (code ${x.r.code})`, x.r.out.slice(-900));
ok(okSteps(x.st).join() === 'detecter,evaluer,contenir,diagnostiquer,corriger-rouge,corriger-vert,post-mortem,livrer', `toutes les étapes validées par le code : ${okSteps(x.st).join(' → ')}`);
ok(x.st.steps.find(s => s.id === 'detecter')?.served === 'claude-opus-5-5' && x.st.steps.find(s => s.id === 'corriger-vert')?.served === 'claude-sonnet-5-5', 'model SERVI = model de la case (détecter opus, corriger sonnet)');
ok(oneTurn(x.evs) && JSON.parse(fs.readFileSync(path.join(x.dir, 'package.json'), 'utf8')).version === '1.0.1' && g(x.dir, 'status', '--porcelain').stdout.trim() === '', 'un seul tour côté musicien ; un commit livré (1.0.1), arbre propre');
ok(/Chronologie/.test(resultOf(x.evs)?.result || ''), 'le résultat contient le post-mortem');
x = play('incident', 'les tests échouent depuis ce matin, répare', { repoOpts: { redTest: true } });
ok(x.r.code === 0 && x.st.steps.find(s => s.id === 'corriger-rouge')?.status === 'skipped' && okSteps(x.st).includes('corriger-vert'), 'suite déjà rouge au départ : « test qui reproduit » sauté (dit), la correction la rend verte', x.r.out.slice(-600));
x = play('incident', 'le service ne répond plus', { env: { FAKE_PIPE_BAD: 'evaluer:1' } });
const ev = x.st?.steps.filter(s => s.id === 'evaluer') || [];
ok(x.r.code === 0 && ev[0]?.status === 'refused' && /lecture seule/.test(ev[0].why) && ev[1]?.status === 'ok' && !fs.existsSync(path.join(x.dir, 'pollution.txt')), 'étape de jugement qui modifie le projet : refusée, annulée, refaite');

// ---------------------------------------------------------------------------
section('3. Recherche : lecture seule, sources exigées, la synthèse est la réponse');
x = play('recherche', 'fais un état de l’art des bibliothèques de tests');
const h0 = head(x.dir);
ok(x.r.code === 0 && okSteps(x.st).join() === 'cadrer,rechercher,lire,recouper,synthetiser', `5 étapes validées : ${okSteps(x.st).join(' → ')}`, x.r.out.slice(-600));
ok(/## Recommandation/.test(resultOf(x.evs).result) && /https:\/\/example\.org/.test(resultOf(x.evs).result) && head(x.dir) === h0, 'réponse = synthèse (recommandation, sources) ; aucun commit');
ok(x.st.steps.find(s => s.id === 'synthetiser')?.served === 'claude-sonnet-5-5', 'synthèse sur le model de sa case');

// ---------------------------------------------------------------------------
section('4. Audit sécurité : scans lancés par l’orchestrateur, second avis indépendant, re-vérification bouclée');
const seen = path.join(T, 'seen.log');
x = play('audit', 'fais un audit de sécurité avant publication', { env: { FAKE_PIPE_SEEN_LOG: seen, FAKE_PIPE_REMAINING: '1' } });
ok(x.r.code === 0 && x.st.status === 'done', `audit terminé (code ${x.r.code})`, x.r.out.slice(-900));
const art = path.join(x.dir, '.orchestrateur', 'runs', x.run);
ok(/SCAN-SIMULE-OK/.test(fs.readFileSync(path.join(art, 'scans-sortie.txt'), 'utf8')) && x.evs.some(e => e.subtype === 'pipeline_scans'), 'scanners réellement lancés par l’orchestrateur (sortie fournie au model)');
const seenRows = fs.readFileSync(seen, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const sa = seenRows.find(s => s.step === 'second-avis'), rv = seenRows.filter(s => s.step === 'reverifier').pop();
ok(sa && !sa.files.includes('revue-manuelle.json') && rv.files.includes('revue-manuelle.json'), 'second avis : la revue manuelle était RETIRÉE du dossier pendant l’étape, puis remise');
ok(x.st.steps.find(s => s.id === 'second-avis')?.served === 'claude-fable-5-1', 'second avis sur le model de sa case');
ok(x.evs.some(e => e.subtype === 'pipeline_loop') && x.st.steps.filter(s => s.id === 'reverifier').length === 2 && x.st.steps.filter(s => s.id === 'corriger').length === 2, 'faille restante → retour à « corriger » puis nouvelle re-vérification');
ok(okSteps(x.st).includes('livrer') && head(x.dir) !== g(x.dir, 'rev-list', '--max-parents=0', 'HEAD').stdout.trim(), 'corrections livrées en un commit');
x = play('audit', 'audit de sécurité', { env: { FAKE_PIPE_NOTHING: 'corriger' } });
ok(x.r.code === 0 && x.st.steps.find(s => s.id === 'livrer')?.status === 'skipped' && g(x.dir, 'rev-list', '--count', 'HEAD').stdout.trim() === '1', 'rien à corriger (« RIEN_A_CORRIGER ») : livraison sautée, aucun commit', x.r.out.slice(-500));

// ---------------------------------------------------------------------------
section('5. Maintenance : historique en rapport seulement, rien à faire accepté, livraison');
x = play('maintenance', 'fais la maintenance du projet', { env: { FAKE_PIPE_NOTHING: 'dependances,tests-instables' } });
ok(x.r.code === 0 && okSteps(x.st).join() === 'dependances,historique,tests-instables,dette,livrer', `étapes : ${okSteps(x.st).join(' → ')}`, x.r.out.slice(-700));
ok(fs.existsSync(path.join(x.dir, 'src', 'pipe-dette.mjs')) && g(x.dir, 'status', '--porcelain').stdout.trim() === '', 'dette nettoyée, livrée, arbre propre');
x = play('maintenance', 'maintenance', { env: { FAKE_PIPE_BAD: 'dette:1', FAKE_PIPE_NOTHING: 'dependances,tests-instables' } });
const dt = x.st.steps.filter(s => s.id === 'dette');
ok(dt[0]?.status === 'refused' && /la suite échoue/.test(dt[0].why) && dt[1]?.status === 'ok', 'action qui casse la suite : refusée, annulée, refaite');

// ---------------------------------------------------------------------------
section('6. Nouveau projet : squelette aux règles de la flotte, puis MVP et publication');
x = play('nouveau', 'crée un nouveau projet de minuteur', { repoOpts: { pipelineJson: false } });
ok(x.r.code === 0 && okSteps(x.st).join() === 'cadrage,squelette,mvp,publication', `étapes : ${okSteps(x.st).join(' → ')}`, x.r.out.slice(-900));
ok(fs.existsSync(path.join(x.dir, '.orchestrateur', 'pipeline.json')) && fs.existsSync(path.join(x.dir, 'README.md')) && JSON.parse(fs.readFileSync(path.join(x.dir, 'package.json'), 'utf8')).version === '1.0.1', 'pipeline.json, README, version publiée (commit)');

// ---------------------------------------------------------------------------
section('7. Données : sources citées, présentation');
x = play('donnees', 'récupère les données de la source et présente-les');
ok(x.r.code === 0 && okSteps(x.st).join() === 'collecter,nettoyer,stocker,presenter,livrer', `étapes : ${okSteps(x.st).join(' → ')}`, x.r.out.slice(-700));
ok(/## Résultats/.test(resultOf(x.evs).result) && /## Limites/.test(resultOf(x.evs).result), 'le résultat contient la présentation (résultats, limites)');

// ---------------------------------------------------------------------------
section('8. Rédaction : documents seulement, relecture, texte final');
x = play('redaction', 'rédige le guide d’installation');
ok(x.r.code === 0 && okSteps(x.st).join() === 'rediger,relire,mettre-en-forme,livrer', `étapes : ${okSteps(x.st).join(' → ')}`, x.r.out.slice(-700));
ok(/Texte final relu/.test(resultOf(x.evs).result) && fs.existsSync(path.join(x.dir, 'docs', 'rediger.md')), 'texte final de la relecture dans le résultat ; document écrit');
x = play('redaction', 'rédige le guide', { env: { FAKE_PIPE_BAD: 'rediger:1' } });
const rd = x.st.steps.filter(s => s.id === 'rediger');
ok(rd[0]?.status === 'refused' && /seuls des documents/.test(rd[0].why) && rd[1]?.status === 'ok', 'rédaction qui touche du code : refusée, refaite');

// ---------------------------------------------------------------------------
section('9. Classement automatique vers les nouveaux pipelines, et mise en service');
repo('P');
let n0 = logOf('P').length;
let r = dispatch(['P', 'fais un état de l\'art comparatif des bibliothèques de tests et donne les sources', '--test', 'classement']);
let evs = logOf('P').slice(n0);
ok(r.code === 0 && evs.find(e => e.type === 'user_prompt')?.pipeline?.pipeline === 'recherche', 'demande classée « recherche » → exécution Recherche (plus de repli en Discussion)', r.out.slice(-500));
routing(['discussion', 'dev']);
repo('P'); n0 = logOf('P').length;
r = dispatch(['P', 'fais un état de l\'art comparatif des bibliothèques de tests et donne les sources', '--test', 'classement']);
evs = logOf('P').slice(n0);
ok(evs.find(e => e.type === 'user_prompt')?.pipeline?.pipeline === 'discussion', 'pipeline retiré du service → Discussion, comme avant');
const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline-enforce.mjs'), ...a], { env: { ...baseEnv }, encoding: 'utf8' });
ok(cli('pipelines', 'dev,audit').status === 64 && cli('pipelines', 'discussion,inconnu').status === 64, 'pipeline-enforce pipelines : « discussion » obligatoire, pipeline inconnu refusé');
ok(cli('pipelines', 'all').status === 0 && E.readEnforcement(T).pipelines.length === E.ENGINE_PIPELINES.length, 'pipeline-enforce pipelines all : tous en service');
ok(dispatch(['P', 'x', '--pipeline', 'inexistant']).code !== 0, '--pipeline inconnu refusé');

if (!process.env.KEEP_T) fs.rmSync(T, { recursive: true, force: true }); else console.log(T);
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
