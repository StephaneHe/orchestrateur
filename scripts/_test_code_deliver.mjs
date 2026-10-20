#!/usr/bin/env node
// ============================================================================
// scripts/_test_code_deliver.mjs — pipelines phase 0 b: Livrer and Mettre en
// forme done by the program (switches `codeDeliver`, `codeFormat`)
// ============================================================================
//
// User decisions (2026-10-20, « tout comme recommandé » on
// docs/PIPELINES-SYNTHESE.md), decision 9: « Livraison faite par le programme
// (version, CHANGELOG, commit) au lieu d'un model : mêmes vérifications » ;
// phase 0 b: « Livrer (et Mettre en forme) fait par le programme ; le model
// n'écrit plus que le texte du CHANGELOG ».
//
// Real case reproduced (prod run of 2026-10-18, project anonymised): the
// project's own tests pinned the old version; the model refused to deliver 8
// times in a row (330 s of turns, 23 h of wall clock) without changing
// anything. By the program: one try, the red suite named, an immediate pause.
//
// Protected:
//   - Livrer: the model writes only livraison.md (bump, ## CHANGELOG,
//     ## Exigence, ## Livré) and touches nothing; the program bumps the
//     version, inserts the entry, appends the requirement line ({version}
//     replaced), commits; the SAME Livrer criterion is then checked;
//   - a text problem is retried (the model fixes its text); a refusal of the
//     program's release (red suite) is not retried identically: pause at once;
//   - a model that touches a file or commits in the text step is refused;
//   - a delivery without version (Rédaction) is one commit by the program,
//     no model turn; Mettre en forme by the program when the review lists no
//     correction or only exact replacements, the model otherwise;
//   - a version format the program cannot rewrite keeps the model delivery,
//     and says so; switches off = the old behaviour (prompt unchanged).
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_code_deliver.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDeliveryText, appendRequirement, deliverRelease, releasePlan, bumpVersion } from './code-delivery.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codedeliver-'));

// ---------------------------------------------------------------------------
section('1. Le programme : texte du model analysé, version, CHANGELOG, exigence (unitaire)');
{
  let p = parseDeliveryText('---\nbump: minor\n---\n## CHANGELOG\n### Added\n- x\n## Exigence\n| d | « x » | t | {version} |\n## Livré\nok', { needRequirement: true });
  ok(p.bump === 'minor' && /### Added/.test(p.changelog) && /\{version\}/.test(p.requirement) && p.summary === 'ok', 'texte complet lu : bump, CHANGELOG, exigence, résumé');
  ok(/bump/.test(parseDeliveryText('## CHANGELOG\n- x').error || ''), 'sans « bump: » : refusé (problème de texte)');
  ok(/CHANGELOG/.test(parseDeliveryText('---\nbump: patch\n---\n## Livré\nx').error || ''), 'sans section CHANGELOG : refusé');
  ok(/ne doit pas contenir/.test(parseDeliveryText('---\nbump: patch\n---\n## CHANGELOG\n## [1.2.3] - 2026-10-20\n- x').error || ''), 'la ligne de version est celle du programme : refusée dans le texte');
  ok(/Exigence/.test(parseDeliveryText('---\nbump: patch\n---\n## CHANGELOG\n- x', { needRequirement: true }).error || ''), 'registre des exigences déclaré, pas de ligne : refusé');
  ok(parseDeliveryText('## CHANGELOG\n- x', { needBump: false }).bump === null, 'version déjà incrémentée : pas de bump demandé');
  ok(bumpVersion('1.14.9', 'patch') === '1.14.10' && bumpVersion('1.14.9', 'minor') === '1.15.0' && bumpVersion('1.14.9', 'major') === '2.0.0', 'patch / minor / major');
  const R = path.join(T, 'unit'); fs.mkdirSync(path.join(R, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(R, 'docs', 'R.md'), '# R\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nNote finale.\n');
  appendRequirement(path.join(R, 'docs', 'R.md'), '| 3 | 4 |');
  ok(fs.readFileSync(path.join(R, 'docs', 'R.md'), 'utf8') === '# R\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nNote finale.\n', 'ligne d’exigence ajoutée après la dernière ligne du tableau');
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: R, encoding: 'utf8' });
  fs.mkdirSync(path.join(R, 'app'));
  fs.writeFileSync(path.join(R, 'app', 'build.gradle.kts'), 'android {\n  defaultConfig {\n    versionCode = 41\n    versionName = "2.3.4"\n  }\n}\n');
  fs.writeFileSync(path.join(R, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [2.3.4] - 2026-10-01\n- avant\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const cfg = { versionFiles: ['app/build.gradle.kts'], changelog: 'CHANGELOG.md', requirements: 'docs/R.md' };
  ok(releasePlan(R, cfg).ok, 'gradle versionName : pris en charge');
  const d = deliverRelease(R, cfg, { bump: 'minor', changelog: '### Fixed\n\n- le tri', requirement: '| 5 | {version} |' }, { date: '2026-10-20', run: 'p-test' });
  const gradle = fs.readFileSync(path.join(R, 'app', 'build.gradle.kts'), 'utf8');
  ok(d.ok && d.version === '2.4.0' && /versionName = "2\.4\.0"/.test(gradle) && /versionCode = 42/.test(gradle), `gradle : versionName 2.4.0 et versionCode 42 (${d.why || ''})`);
  const cl = fs.readFileSync(path.join(R, 'CHANGELOG.md'), 'utf8');
  ok(/## \[Unreleased\]\n\n## \[2\.4\.0\] - 2026-10-20\n\n### Fixed\n\n- le tri\n\n## \[2\.3\.4\]/.test(cl), 'entrée insérée sous [Unreleased], au-dessus des versions publiées');
  ok(/\| 5 \| 2\.4\.0 \|/.test(fs.readFileSync(path.join(R, 'docs', 'R.md'), 'utf8')), '{version} remplacé dans la ligne d’exigence');
  ok(/^chore\(release\): v2\.4\.0 — le tri/.test(g('log', '-1', '--format=%s').stdout) && !g('status', '--porcelain').stdout.trim(), 'un commit « chore(release) », arbre propre');
  fs.writeFileSync(path.join(R, 'VERSION.txt'), 'v1\n');
  ok(!releasePlan(R, { versionFiles: ['VERSION.txt'] }).ok, 'format de version inconnu : livraison laissée au model');
  ok(!releasePlan(R, cfg, { deliveryFixes: ['README'] }).ok, 'corrections de doc à faire pendant la livraison (ancien moteur) : laissée au model');
}

// ---------------------------------------------------------------------------
const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
const cases = ['dev.comprendre', 'dev.concevoir', 'dev.liste-tests', 'dev.rouge', 'dev.vert', 'dev.refactor', 'dev.revue', 'dev.livrer', 'redaction.rediger', 'redaction.relire', 'redaction.mettre-en-forme'];
const routing = (tuning) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(cases.map(s => [s, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev', 'redaction'], ...(tuning ? { tuning } : {}) },
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.14.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'README.md'), '# P\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.14.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const reset = () => { g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur'); };

const promptDump = path.join(T, 'prompts.ndjson');
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  FAKE_CLAUDE_DUMP_PROMPT: promptDump, ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_BIG', 'FAKE_PIPE_REFACTOR', 'FAKE_PIPE_JSON', 'FAKE_PIPE_NOTHING', 'FAKE_PIPE_TEXT_TOUCH', 'FAKE_PIPE_BUMP']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const prompts = () => { try { return fs.readFileSync(promptDump, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { prompt: l }; } }); } catch { return []; } };
const go = async (args, env) => {
  try { fs.rmSync(promptDump); } catch {}
  const n0 = logOf().length;
  const r = await dispatch(args, env);
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
  return { ...r, evs, run, state: run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : {}, prompts: prompts().map(p => String(p.prompt ?? p.text ?? JSON.stringify(p))) };
};
const version = () => JSON.parse(fs.readFileSync(path.join(P, 'package.json'), 'utf8')).version;
const stepsOf = (s, id) => (s.steps || []).filter(x => x.id === id);
const REQ = 'Ajoute la multiplication par deux';

// ---------------------------------------------------------------------------
section('2. Interrupteur coupé : livraison par le model, consigne inchangée');
routing(null);
let r = await go([REQ, '--mode', 'leger', '--kind', 'simple']);
ok(r.code === 0 && r.state.status === 'done' && version() === '1.14.1', `exécution terminée par le model (code ${r.code}, ${r.state.status}, ${version()})`, r.out.slice(-1200));
ok(r.prompts.some(p => /PIPELINE_STEP=livrer/.test(p) && /incrémente la version/.test(p)) && !r.prompts.some(p => /LIVRAISON=texte/.test(p)), 'consigne de Livrer d’avant (le model incrémente et commite)');
reset();

// ---------------------------------------------------------------------------
section('3. Interrupteur actif : le model écrit le texte, le programme livre');
routing({ codeDeliver: ['P'] });
r = await go([REQ, '--mode', 'leger', '--kind', 'simple']);
const l3 = stepsOf(r.state, 'livrer');
ok(r.code === 0 && r.state.status === 'done', `exécution terminée (code ${r.code}, ${r.state.status})`, r.out.slice(-1500));
ok(l3.length === 1 && l3[0].status === 'ok' && /programme/.test(l3[0].byCode || ''), `Livrer accepté du premier coup, fait par le programme (${l3.map(s => `${s.status} ${s.why || ''}`).join(' | ')})`);
ok(version() === '1.14.1', `version écrite par le programme : 1.14.0 → ${version()}`);
const cl3 = fs.readFileSync(path.join(P, 'CHANGELOG.md'), 'utf8');
ok(new RegExp(`## \\[1\\.14\\.1\\] - ${new Date().toISOString().slice(0, 10)}\\n\\n### Added\\n\\n- double\\(\\) : multiplie par deux`).test(cl3), 'entrée CHANGELOG : ligne de version du programme + texte du model');
ok(/\| 2026-10-20 \| « double » \| test\/pipe\.test\.mjs \| 1\.14\.1 \|/.test(fs.readFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), 'utf8')), 'ligne d’exigence ajoutée, {version} remplacé');
ok(/^chore\(release\): v1\.14\.1/.test(g('log', '-1', '--format=%s').stdout) && g('log', '--format=%s', `${H0}..HEAD`).stdout.trim().split('\n').length === 1 && !g('status', '--porcelain').stdout.trim(), 'UN commit (travail + version), arbre propre');
const lp = r.prompts.find(p => /LIVRAISON=texte/.test(p)) || '';
ok(/MODIFIER=non/.test(lp) && /## CHANGELOG/.test(lp) && /## Exigence/.test(lp) && /\{version\}/.test(lp) && !/incrémente la version/.test(lp), 'consigne : texte seulement (bump, CHANGELOG, exigence), aucun fichier ni commit');
ok(/## Livraison faite par le programme/.test(fs.readFileSync(path.join(P, '.orchestrateur', 'runs', r.run, 'livraison.md'), 'utf8')), 'livraison.md dit ce que le programme a fait (version, commit)');
ok(r.state.tuning?.codeDeliver === true && r.state.tuning?.codeFormat === false, 'réglages figés dans run.json');
reset();

section('4. Texte invalide : le model le corrige au nouvel essai (problème de texte, relancé)');
r = await go([REQ, '--mode', 'leger', '--kind', 'simple'], { FAKE_PIPE_BAD: 'livrer:1' });
const l4 = stepsOf(r.state, 'livrer');
ok(r.state.status === 'done' && l4.length === 2 && l4[0].status === 'refused' && /CHANGELOG/.test(l4[0].why) && l4[1].status === 'ok', `refusé puis accepté (${l4.map(s => `${s.status} ${s.why || ''}`).join(' | ')})`, r.out.slice(-800));
ok(version() === '1.14.1' && g('log', '--format=%s', `${H0}..HEAD`).stdout.trim().split('\n').length === 1, 'une seule version, un seul commit');
reset();

section('5. Le model modifie un fichier pendant l’étape de texte : refusé, rien de commité');
r = await go([REQ, '--mode', 'leger', '--kind', 'simple'], { FAKE_PIPE_TEXT_TOUCH: '1' });
const l5 = stepsOf(r.state, 'livrer');
ok(r.state.status === 'paused' && l5.length >= 1 && l5.every(s => s.status === 'refused' && /le model ne modifie aucun fichier/.test(s.why)), `refusé, pause (${r.state.status} ; ${l5.map(s => s.why).join(' | ').slice(0, 200)})`);
ok(version() === '1.14.0' && g('rev-parse', 'HEAD').stdout.trim() === H0, 'aucune version, aucun commit');
reset();

section('6. Cas réel reproduit : les tests du projet épinglent l’ancienne version');
fs.writeFileSync(path.join(P, 'test', 'version.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport fs from 'node:fs';\ntest('version épinglée', () => { assert.equal(JSON.parse(fs.readFileSync('package.json', 'utf8')).version, '1.14.0'); });\n");
g('add', '-A'); g('commit', '-q', '-m', 'pinned version test');
const H1 = g('rev-parse', 'HEAD').stdout.trim();
const t0 = Date.now();
r = await go([REQ, '--mode', 'leger', '--kind', 'simple']);
const l6 = stepsOf(r.state, 'livrer');
ok(r.state.status === 'paused' && l6.length === 1 && /la suite échoue après la livraison/.test(l6[0].why) && /version épinglée/.test(l6[0].why + JSON.stringify(r.evs.filter(e => e.subtype === 'pipeline_limit'))), `UN essai, puis pause avec le test en échec nommé (${l6.map(s => `${s.status} ${String(s.why).split('\n')[0]}`).join(' | ')})`, r.out.slice(-800));
ok(g('rev-parse', 'HEAD').stdout.trim() === H1 && version() === '1.14.0', 'rien de livré : HEAD et version inchangés');
ok(r.evs.some(e => e.subtype === 'pipeline_limit' || /NEEDS_USER_INPUT/.test(e.result || '')), 'la pause pose la question à l’utilisateur (aucune relance identique)');
console.log(`    (durée de l’exécution jusqu’à la pause : ${Math.round((Date.now() - t0) / 100) / 10} s)`);
g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur');

// ---------------------------------------------------------------------------
section('7. Rédaction : Livrer = un commit du programme, aucun tour de model');
routing({ codeDeliver: ['P'], codeFormat: ['P'] });
const RED = 'Rédige une note sur la multiplication';
r = await go([RED, '--pipeline', 'redaction']);
const l7 = stepsOf(r.state, 'livrer'), f7 = stepsOf(r.state, 'mettre-en-forme');
ok(r.code === 0 && r.state.status === 'done', `exécution terminée (code ${r.code}, ${r.state.status})`, r.out.slice(-1200));
ok(l7.length === 1 && l7[0].status === 'ok' && l7[0].source === 'code' && !l7[0].model, `Livrer fait par le programme, sans model (${JSON.stringify(l7.map(s => [s.status, s.source, s.model]))})`);
ok(!r.prompts.some(p => /PIPELINE_STEP=livrer/.test(p)), 'aucune consigne Livrer envoyée à un model');
ok(/^docs: /.test(g('log', '-1', '--format=%s').stdout) && !g('status', '--porcelain').stdout.trim() && version() === '1.14.0', 'un commit « docs: », sans version, arbre propre');
ok(f7.length === 1 && f7[0].status === 'ok' && f7[0].source === 'code' && !r.prompts.some(p => /PIPELINE_STEP=mettre-en-forme/.test(p)), 'relecture sans correction : Mettre en forme fait par le programme (marqueur), sans model');
ok(r.prompts.some(p => /PIPELINE_STEP=relire/.test(p) && /CORRECTIONS_EXACTES=oui/.test(p)), 'la Relecture est invitée à écrire des remplacements exacts');
const ev7 = r.evs.find(e => e.subtype === 'pipeline_step_done' && e.pipeline?.step === 'livrer');
ok(/fait par le programme/.test(ev7?.text || '') && ev7?.byCode, 'la frise dit « fait par le programme »');
reset();

section('8. Mettre en forme : corrections exactes appliquées par le programme ; une correction de jugement va au model');
r = await go([RED, '--pipeline', 'redaction'], { FAKE_PIPE_JSON: JSON.stringify({ relire: { verdict: 'corrections', corrections: [{ fichier: 'docs/rediger.md', avant: 'Texte simulé.', apres: 'Texte relu et corrigé.' }] } }) });
const f8 = stepsOf(r.state, 'mettre-en-forme');
ok(r.state.status === 'done' && f8.length === 1 && f8[0].source === 'code' && f8[0].status === 'ok', `remplacement exact : fait par le programme (${JSON.stringify(f8.map(s => [s.status, s.source, s.why]))})`, r.out.slice(-800));
ok(/Texte relu et corrigé\./.test(g('show', 'HEAD:docs/rediger.md').stdout), 'correction appliquée et livrée');
reset();
r = await go([RED, '--pipeline', 'redaction'], { FAKE_PIPE_JSON: JSON.stringify({ relire: { verdict: 'corrections', corrections: ['reformuler l’introduction, trop longue'] } }) });
const f8b = stepsOf(r.state, 'mettre-en-forme');
ok(f8b.length >= 1 && f8b[0].source !== 'code' && f8b[0].model && r.prompts.some(p => /PIPELINE_STEP=mettre-en-forme/.test(p)), `correction de jugement : étape confiée au model (${JSON.stringify(f8b.map(s => [s.status, s.source, s.model]))})`);
reset();

section('9. Format de version non pris en charge : livraison laissée au model, et dit');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json', 'VERSION.txt'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
fs.writeFileSync(path.join(P, 'VERSION.txt'), 'release one\n');
g('add', '-A'); g('commit', '-q', '-m', 'odd version file');
r = await go([REQ, '--mode', 'leger', '--kind', 'simple']);
ok(r.evs.some(e => e.subtype === 'pipeline_code_deliver_skipped' && /VERSION\.txt/.test(e.why)) && r.prompts.some(p => /PIPELINE_STEP=livrer/.test(p) && !/LIVRAISON=texte/.test(p)), 'événement « livraison confiée au model » avec la raison, consigne d’avant');

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* Windows: a file may still be open */ }
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
