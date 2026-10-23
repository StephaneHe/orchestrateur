#!/usr/bin/env node
// ============================================================================
// scripts/_test_version_mentions.mjs — Livrer by the program keeps EVERY
// mention of the version up to date, or fails naming the file (0.140.0)
// ============================================================================
//
// Real case replayed (prod run p-20261023T044621-dc1385, 2026-10-23, project
// anonymised): with the lever codeDeliver, Livrer put package.json at 1.9.0 but
// left the README line « - **Version** : `1.8.1` »; a requirement test of the
// project compares both. The pause sent to the chef offered only « corriger le
// code », which relaunched the very same program delivery: twice, then closed
// by hand. User rule behind the chef's pauses: « arrête de poser des questions
// de découpage. tu sais comment est organisé le process mieux que moi ».
//
// Protected:
//   - the program updates the README « Version » line and every mention
//     declared in .orchestrateur/pipeline.json → versionMentions (path, or
//     {file, regex} with one capture group);
//   - a declared mention it cannot write: Livrer fails at once, naming the
//     file, nothing committed;
//   - after a red suite, a tracked line still showing the old version next to
//     « version » is named (file:line);
//   - the pause offers « confier au model » (recommended), never « corriger le
//     code »; it is a process pause the chef can settle; answered, Livrer is
//     done by the model with the precise instruction;
//   - anti-loop: the same error of Livrer twice in a row never offers again
//     the option already answered on it.
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_version_mentions.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionMentions, syncVersionMentions, staleVersionHints, deliverRelease } from './code-delivery.mjs';
import { diagnosePause, smartMenu, fixMenu, checkMenu, excludeAnswered, OPTION_KEYS } from './pause-diagnosis.mjs';
import { pauseFamily, routePause, CHEF_KEYS } from './process-pause.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vmentions-'));
const gitIn = (cwd) => (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
const README_PROD = '# P\n\n- **Version** : `1.8.1`\n- **Port** : 8080\n';

// ---------------------------------------------------------------------------
section('1. Mentions de version : la ligne « Version » du README, les mentions déclarées (unitaire)');
{
  const R = path.join(T, 'unit'); fs.mkdirSync(path.join(R, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(R, 'package.json'), JSON.stringify({ name: 'u', version: '1.8.1' }, null, 2) + '\n');
  fs.writeFileSync(path.join(R, 'README.md'), README_PROD);
  fs.writeFileSync(path.join(R, 'docs', 'ABOUT.md'), 'Build 1.8.1 du projet.\n');
  fs.writeFileSync(path.join(R, 'docs', 'INSTALL.md'), 'Install version 1.8.1 first.\n');
  const cfg = { versionFiles: ['package.json'], versionMentions: ['docs/INSTALL.md', { file: 'docs/ABOUT.md', regex: 'Build (\\d+\\.\\d+\\.\\d+)' }, 'package.json'] };
  const ms = versionMentions(R, cfg).map(m => m.file);
  ok(ms.includes('README.md') && ms.includes('docs/ABOUT.md') && ms.includes('docs/INSTALL.md') && !ms.includes('package.json'), `mentions : README (convention), déclarées, jamais un fichier de version (${ms.join(', ')})`);
  const s = syncVersionMentions(R, cfg, '1.9.0');
  ok(!s.stale.length && s.updated.length === 3, `toutes mises à jour (${JSON.stringify(s)})`);
  ok(fs.readFileSync(path.join(R, 'README.md'), 'utf8') === README_PROD.replace('1.8.1', '1.9.0'), 'ligne réelle « - **Version** : `1.8.1` » → `1.9.0`, rien d’autre ne change');
  ok(/Build 1\.9\.0/.test(fs.readFileSync(path.join(R, 'docs', 'ABOUT.md'), 'utf8')) && /version 1\.9\.0/.test(fs.readFileSync(path.join(R, 'docs', 'INSTALL.md'), 'utf8')), 'mention déclarée par regex et par chemin mises à jour');
  const bad = syncVersionMentions(R, { versionFiles: ['package.json'], versionMentions: ['docs/ABSENT.md', { file: 'docs/ABOUT.md', regex: 'Release (\\d+\\.\\d+\\.\\d+)' }] }, '2.0.0');
  ok(bad.stale.length === 2 && bad.stale.some(x => x.file === 'docs/ABSENT.md' && /introuvable/.test(x.why)) && bad.stale.some(x => x.file === 'docs/ABOUT.md' && /introuvable/.test(x.why)), `mention déclarée impossible à écrire : nommée précisément (${JSON.stringify(bad.stale)})`);
  fs.writeFileSync(path.join(R, 'README.md'), '# P\n\nNode version 20.1.0 requise.\n');
  ok(!versionMentions(R, { versionFiles: ['package.json'] }).length, 'README sans ligne « Version : X.Y.Z » : aucune mention supposée');

  // Program delivery with the prod README: the mention follows the version, in the release commit.
  const g = gitIn(R);
  fs.writeFileSync(path.join(R, 'README.md'), README_PROD);
  fs.writeFileSync(path.join(R, 'CHANGELOG.md'), '# Changelog\n\n## [1.8.1] - 2026-10-20\n- avant\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const d = deliverRelease(R, { versionFiles: ['package.json'], changelog: 'CHANGELOG.md' }, { bump: 'minor', changelog: '### Added\n\n- x', requirement: '' }, { date: '2026-10-23', run: 'p-t' });
  ok(d.ok && d.from === '1.8.1' && d.version === '1.9.0' && d.mentions.includes('README.md') && /`1\.9\.0`/.test(g('show', 'HEAD:README.md').stdout), `livraison par le programme : README dans le commit de version (${d.why || d.mentions})`);
  // A declared mention the program cannot write: refused BEFORE any commit, the file named.
  const head = g('rev-parse', 'HEAD').stdout.trim();
  const d2 = deliverRelease(R, { versionFiles: ['package.json'], changelog: 'CHANGELOG.md', versionMentions: ['docs/ABSENT.md'] }, { bump: 'patch', changelog: '### Fixed\n\n- y', requirement: '' }, { date: '2026-10-23', run: 'p-t' });
  ok(!d2.ok && /docs\/ABSENT\.md/.test(d2.why) && d2.staleVersion?.[0]?.file === 'docs/ABSENT.md' && g('rev-parse', 'HEAD').stdout.trim() === head, `refusée avant le commit, fichier nommé : ${d2.why}`);
  g('checkout', '-q', '--', '.');
  // Hints after a red suite: tracked lines still showing the old version next to « version ».
  fs.mkdirSync(path.join(R, 'src'), { recursive: true });
  fs.writeFileSync(path.join(R, 'src', 'version.mjs'), "export const version = '1.9.0';\n");
  fs.writeFileSync(path.join(R, 'src', 'other.mjs'), "export const port = '1.9.0.1';\n");
  g('add', '-A'); g('commit', '-q', '-m', 'src');
  const h = staleVersionHints(R, '1.9.0', '1.10.0', { changelog: 'CHANGELOG.md', versionFiles: ['package.json'] });
  ok(h.length === 3 && h.some(x => x.file === 'src/version.mjs' && x.line === 1) && h.some(x => x.file === 'README.md' && x.line === 3) && h.some(x => x.file === 'docs/INSTALL.md') && !h.some(x => /CHANGELOG|other|package.json/.test(x.file)),
    `indices : src/version.mjs:1, README.md:3, docs/INSTALL.md ; jamais un fichier de version, le CHANGELOG ni une autre valeur (${JSON.stringify(h.map(x => `${x.file}:${x.line}`))})`);
}

// ---------------------------------------------------------------------------
section('2. La pause : cause nommée, « confier au model » recommandé, jamais « corriger le code » (unitaire)');
{
  // The prod refusal, verbatim in substance.
  const why = "la suite échoue après la livraison (npm test) :\n✖ failing tests:\n\ntest at tests\\requirements\\readme-synthesizer-and-version.test.mjs:31:1\n✖ the version displayed by the README is the project version (2.5235ms)\n  AssertionError [ERR_ASSERTION]: README version must equal package.json version (1.9.0)\n  '1.8.1' !== '1.9.0'\n";
  const step = { id: 'livrer', label: 'livraison (version, journal des changements, commit)' };
  const stale = [{ file: 'README.md', line: 5, found: '1.8.1', why: 'affiche encore 1.8.1' }];
  const old = diagnosePause({ limit: 'criteria', step, why, testOutput: why });
  // 0.141.1: without the program's report, a red suite after Livrer is still « tests rouges après livraison », never an outage.
  ok(old.kind === 'code_delivery' && !/panne|fournisseur/i.test(old.cause), `sans constat de la livraison : tests rouges après livraison (${old.kind})`, old.cause);
  const d = diagnosePause({ limit: 'criteria', step, why, testOutput: why, codeDelivery: { from: '1.8.1', to: '1.9.0', red: true, stale } });
  ok(d.kind === 'version_stale' && /README\.md/.test(d.cause) && /ligne 5/.test(d.cause) && /1\.8\.1/.test(d.cause) && /1\.9\.0/.test(d.cause), `cause : la mention nommée (${d.cause})`);
  const menu = fixMenu(d, smartMenu(d, { step }));
  const keys = menu.options.map(o => o.key);
  ok(keys.includes('confier au model') && !keys.includes('corriger le code') && menu.recommend.key === 'confier au model' && keys.includes('abandonner'), `choix : ${keys.join(', ')} ; recommandé « ${menu.recommend.key} »`);
  ok(!checkMenu(d, menu).length, `menu conforme aux règles (${checkMenu(d, menu).join(' ; ')})`);
  const eff = menu.options.find(o => o.key === 'confier au model').effect;
  ok(eff?.modelDeliver === true && /README\.md:5/.test(eff.message || ''), 'l’option confie Livrer au model, avec le fichier à mettre à jour dans la consigne');
  ok(OPTION_KEYS['confier au model'] === 'resume' && CHEF_KEYS.includes('confier au model'), 'mot de menu connu ; le chef peut le choisir');
  ok(pauseFamily({ limit: 'criteria', kind: 'version_stale' }).family === 'process' && pauseFamily({ limit: 'criteria', kind: 'code_delivery' }).family === 'process', 'pause de processus : tranchée par le chef, pas posée à l’utilisateur');
  const r = routePause({ limit: 'criteria', d, menu, history: [], sig: 'criteria|version_stale|livrer|', project: 'P', run: 'p-x', n: 1 });
  ok(r.to === 'chef' && r.menu.recommend.key === 'confier au model', `transmise au chef, « confier au model » recommandé (${r.to})`);
  const d2 = diagnosePause({ limit: 'criteria', step, why, testOutput: why, codeDelivery: { from: '1.8.1', to: '1.9.0', red: true, stale: [] } });
  const m2 = fixMenu(d2, smartMenu(d2, { step }));
  ok(d2.kind === 'code_delivery' && m2.recommend.key === 'confier au model' && !m2.options.some(o => o.key === 'corriger le code'), `sans mention identifiée : la livraison elle-même casse le test (${d2.kind}, ${m2.options.map(o => o.key).join(', ')})`);
  const x = excludeAnswered(m2, ['confier au model']);
  ok(!x.options.some(o => o.key === 'confier au model') && x.options.some(o => o.key === 'abandonner') && x.recommend.key !== 'confier au model' && /déjà été choisi/.test(x.recommend.why), `anti-boucle : l’option déjà choisie retirée (${x.options.map(o => o.key).join(', ')})`);
  const y = excludeAnswered({ options: [{ key: 'relancer l’étape', does: 'x' }, { key: 'abandonner', does: 'y' }], recommend: { key: 'relancer l’étape', why: 'z' } }, ['relancer l’étape'], { fallback: { key: 'confier au model', does: 'w' } });
  ok(y.options[0].key === 'confier au model' && !y.options.some(o => o.key === 'relancer l’étape'), 'une option pas encore essayée remplace celle déjà choisie');
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
const cases = ['dev.comprendre', 'dev.concevoir', 'dev.liste-tests', 'dev.rouge', 'dev.vert', 'dev.refactor', 'dev.revue', 'dev.livrer'];
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(cases.map(s => [s, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'], tuning: { codeDeliver: ['P'] } },
}));
const g = gitIn(P);
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.8.1', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
// The project's requirement test of the prod run: README version = package.json version.
fs.writeFileSync(path.join(P, 'test', 'readme-version.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport fs from 'node:fs';\ntest('the version displayed by the README is the project version', () => {\n  const v = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;\n  assert.strictEqual(/\\*\\*Version\\*\\* : `([^`]+)`/.exec(fs.readFileSync('README.md', 'utf8'))[1], v, `README version must equal package.json version (${v})`);\n});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'README.md'), README_PROD);
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.8.1] - 2026-10-20\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
const pipeCfg = (extra = {}) => fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md', ...extra }));
pipeCfg();
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const reset = (to = H0) => { g('reset', '-q', '--hard', to); g('clean', '-qfd'); };

const promptDump = path.join(T, 'prompts.ndjson');
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  FAKE_CLAUDE_DUMP_PROMPT: promptDump, ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_PAUSE_MODEL_DIAG: '0' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_BIG', 'FAKE_PIPE_REFACTOR', 'FAKE_PIPE_JSON', 'FAKE_PIPE_NOTHING', 'FAKE_PIPE_TEXT_TOUCH', 'FAKE_PIPE_BUMP', 'FAKE_PIPE_SYNC_FILE']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const prompts = () => { try { return fs.readFileSync(promptDump, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { prompt: l }; } }); } catch { return []; } };
let lastRun = null;
const go = async (args, env) => {
  try { fs.rmSync(promptDump); } catch {}
  const n0 = logOf().length;
  const r = await dispatch(args, env);
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run || evs.find(e => e.pipeline?.run)?.pipeline.run || lastRun;
  lastRun = run;
  return { ...r, evs, run, state: run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : {}, prompts: prompts().map(p => String(p.prompt ?? p.text ?? JSON.stringify(p))) };
};
const version = () => JSON.parse(fs.readFileSync(path.join(P, 'package.json'), 'utf8')).version;
const livrer = (s) => (s.steps || []).filter(x => x.id === 'livrer');
const REQ = 'Ajoute la multiplication par deux';

// ---------------------------------------------------------------------------
section('3. Cas réel rejoué : le README « Version » suit la version, la suite reste verte');
let r = await go([REQ, '--mode', 'leger', '--kind', 'simple']);
ok(r.code === 0 && r.state.status === 'done', `exécution terminée (code ${r.code}, ${r.state.status})`, r.out.slice(-1500));
ok(livrer(r.state).length === 1 && livrer(r.state)[0].status === 'ok' && /programme/.test(livrer(r.state)[0].byCode || ''), `Livrer accepté du premier coup, par le programme (${livrer(r.state).map(s => `${s.status} ${String(s.why || '').split('\n')[0]}`).join(' | ')})`);
ok(version() === '1.8.2' && /- \*\*Version\*\* : `1\.8\.2`/.test(fs.readFileSync(path.join(P, 'README.md'), 'utf8')), `package.json et README à ${version()}`);
ok(g('show', '--name-only', '--format=', 'HEAD').stdout.split('\n').includes('README.md') && !g('status', '--porcelain').stdout.trim(), 'README dans le commit de version, arbre propre');
ok(r.prompts.some(p => /LIVRAISON=texte/.test(p) && /mentions : README\.md/.test(p)), 'la consigne dit que le programme écrit aussi la mention du README');
reset();

// ---------------------------------------------------------------------------
section('4. Mention non déclarée relevée après une suite rouge : pause précise, « confier au model »');
fs.writeFileSync(path.join(P, 'src', 'version.mjs'), "export const version = '1.8.1';\n");
fs.writeFileSync(path.join(P, 'test', 'src-version.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport fs from 'node:fs';\nimport { version } from '../src/version.mjs';\ntest('src version = package version', () => { assert.strictEqual(version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version); });\n");
g('add', '-A'); g('commit', '-q', '-m', 'src version');
const H1 = g('rev-parse', 'HEAD').stdout.trim();
r = await go([REQ, '--mode', 'leger', '--kind', 'simple']);
const l4 = livrer(r.state);
ok(r.state.status === 'paused' && l4.length === 1 && l4[0].codeDelivery?.stale?.some(x => x.file === 'src/version.mjs' && x.line === 1), `UN essai, puis pause ; mention nommée (${JSON.stringify(l4.map(s => s.codeDelivery))})`, r.out.slice(-1200));
ok(r.state.diagnosis?.kind === 'version_stale' && /src\/version\.mjs/.test(r.state.diagnosis.cause), `cause : ${r.state.diagnosis?.cause}`);
const k4 = (r.state.diagnosis?.options || []).map(o => o.key);
ok(k4.includes('confier au model') && !k4.includes('corriger le code') && r.state.diagnosis?.recommend?.key === 'confier au model', `choix : ${k4.join(', ')}`);
ok(g('rev-parse', 'HEAD').stdout.trim() === H1 && version() === '1.8.1', 'rien de livré : HEAD et version inchangés');
const run4 = r.run;
r = await go(['confier au model'], { FAKE_PIPE_SYNC_FILE: 'src/version.mjs,README.md' });
const l4b = livrer(r.state);
ok(r.run === run4 && r.state.status === 'done' && r.state.modelDeliver && l4b.at(-1).status === 'ok' && !l4b.at(-1).byCode, `reprise : Livrer fait par le model, accepté (${r.state.status} ; ${l4b.map(s => `${s.status}${s.byCode ? ' prog' : ' model'}`).join(' | ')})`, r.out.slice(-1200));
ok(r.prompts.some(p => /PIPELINE_STEP=livrer/.test(p) && !/LIVRAISON=texte/.test(p) && /LIVRAISON CONFIÉE AU MODEL/.test(p) && /src\/version\.mjs/.test(p)), 'consigne du model : livraison complète, avec le fichier à mettre à jour');
ok(r.evs.some(e => e.subtype === 'pipeline_model_deliver') && r.evs.some(e => e.subtype === 'pipeline_code_deliver_skipped' && /confiée au model à la pause/.test(e.why || '')), 'tracé : livraison confiée au model, à la pause');
ok(/'1\.8\.2'/.test(fs.readFileSync(path.join(P, 'src', 'version.mjs'), 'utf8')) && version() === '1.8.2', 'mention et version à 1.8.2');
reset(H1);

// ---------------------------------------------------------------------------
section('5. Anti-boucle : la même erreur de Livrer deux fois de suite ne repropose pas le même choix');
r = await go([REQ, '--mode', 'leger', '--kind', 'simple']);
ok(r.state.status === 'paused' && r.state.diagnosis?.kind === 'version_stale', `pause 1 : ${r.state.diagnosis?.kind}`, r.out.slice(-800));
r = await go(['confier au model']);   // the model forgets the mention: red again
const kind2 = r.state.diagnosis?.kind;
const k5a = (r.state.diagnosis?.options || []).map(o => o.key);
ok(r.state.status === 'paused' && livrer(r.state).at(-1).status === 'refused' && !k5a.includes('confier au model') && !k5a.includes('corriger le code'), `pause 2 (livraison par le model, rouge) : ${kind2} — ${k5a.join(', ')}`, r.out.slice(-800));
const first = r.state.diagnosis?.recommend?.key;
ok(first && first !== 'abandonner', `option proposée à la pause 2 : « ${first} »`);
r = await go([first]);
const k5b = (r.state.diagnosis?.options || []).map(o => o.key);
ok(r.state.status === 'paused' && r.state.diagnosis?.kind === kind2 && !k5b.includes(first) && (r.state.diagnosis?.excluded || []).includes(first), `pause 3, même erreur : « ${first} » n’est plus proposé (${k5b.join(', ')} ; exclu : ${(r.state.diagnosis?.excluded || []).join(', ')})`, r.out.slice(-800));
ok(/n’est plus proposé/.test(r.state.diagnosis?.cause || ''), 'la cause le dit');
ok(k5b.includes('abandonner') && k5b.includes(r.state.diagnosis?.recommend?.key), `recommandé parmi les choix restants : « ${r.state.diagnosis?.recommend?.key} »`);

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* Windows: a file may still be open */ }
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
