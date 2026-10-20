#!/usr/bin/env node
// ============================================================================
// scripts/_test_release_prebump.mjs — Livrer accepts a version already bumped
// earlier in the SAME run (0.114.1)
// ============================================================================
//
// Incident (2026-10-18, run p-20261018T091024-0e199e): the plan's items 15/16
// bumped the version and wrote the CHANGELOG entry, each delivered in its own
// commit. Livrer then checked the version against the last delivered item →
// « version non incrémentée : package.json inchangé »; the model rightly
// refused a second bump → « aucun commit créé »; two refusals, dead-end pause.
// User decision (answer to the chef, verbatim): « les deux ».
//
// Protected:
//   - a version (and CHANGELOG entry) bumped by an item of the run satisfies
//     Livrer: release commit with only the docs accepted, or no commit at all
//     when version, CHANGELOG and requirement line are already committed;
//   - the Livrer prompt says the version is already bumped (never bump twice);
//   - NOT weakened: a run where nothing bumped the version is still refused,
//     and a bump without its CHANGELOG entry is still refused.
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_release_prebump.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prebump-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.14.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.14.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const reset = () => { g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur'); };

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_REVIEW_ITEM', 'FAKE_PIPE_REVIEW_LOG', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_BIG', 'FAKE_PIPE_REFACTOR', 'FAKE_PIPE_ITEM_EXTRA_TESTS', 'ORCH_PIPE_REVIEW_ROUNDS', 'ORCH_PIPE_ITEMS',
  'FAKE_PIPE_ITEM_BUMP', 'FAKE_PIPE_LIVRER_NO_BUMP', 'FAKE_PIPE_LIVRER_NOTHING', 'FAKE_CLAUDE_DUMP_PROMPT']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const go = async (args, env) => {
  const n0 = logOf().length;
  const r = await dispatch(args, env);
  const evs = logOf().slice(n0);
  return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run };
};
const subjects = () => g('log', '--format=%s', `${H0}..HEAD`).stdout.trim().split('\n').filter(Boolean).reverse();
const version = () => JSON.parse(fs.readFileSync(path.join(P, 'package.json'), 'utf8')).version;
const livrerSteps = (run) => runState(run).steps.filter(s => s.id === 'livrer');
const REQ = 'Ajoute la multiplication par deux et trois';

// ---------------------------------------------------------------------------
section('1. Incident reproduit : un item a déjà incrémenté la version et écrit le CHANGELOG ; Livrer complète la doc sans réincrémenter → accepté');
const promptDump = path.join(T, 'prompts.txt');
let r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_ITEM_BUMP: '2', FAKE_PIPE_LIVRER_NO_BUMP: '1', FAKE_CLAUDE_DUMP_PROMPT: promptDump });
const s1 = r.run ? runState(r.run) : {};
ok(r.code === 0 && s1.status === 'done', `exécution terminée, sans pause « limite atteinte » (code ${r.code}, ${s1.status})`, r.out.slice(-1500));
const l1 = r.run ? livrerSteps(r.run) : [];
ok(l1.length === 1 && l1[0].status === 'ok', `Livrer accepté du premier coup (${l1.map(s => `${s.status}${s.why ? ` : ${s.why}` : ''}`).join(' | ')})`);
ok(version() === '1.14.1', `une seule version pour la correction : 1.14.0 → ${version()} (jamais 1.14.2)`);
const subj1 = subjects();
ok(subj1.length === 3 && /^feat\(item 1\)/.test(subj1[0]) && /^feat\(item 2\)/.test(subj1[1]) && /^docs: release notes \(v1\.14\.1\)/.test(subj1[2]), `commits : items puis commit de livraison (doc seulement) — ${subj1.join(' | ')}`);
ok(g('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort().join(',') === 'CHANGELOG.md,docs/USER_REQUIREMENTS.md', 'le commit de livraison ne contient que CHANGELOG et la ligne d’exigence');
let dumped = ''; try { dumped = fs.readFileSync(promptDump, 'utf8'); } catch {}
ok(/version est DÉJÀ incrémentée par un item de cette exécution \(1\.14\.0 → 1\.14\.1\) : ne l'incrémente PAS de nouveau/.test(dumped), 'la consigne de Livrer annonce la version déjà incrémentée et interdit un second incrément');
ok(s1.releases?.length === 1 && s1.releases[0].version === '1.14.1', `run.json : une version, 1.14.1 (${JSON.stringify(s1.releases?.map(x => x.version))})`);
reset();

// ---------------------------------------------------------------------------
section('2. Version, CHANGELOG ET ligne d’exigence déjà commités par un item : Livrer sans commit → accepté');
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_ITEM_BUMP: '2:req', FAKE_PIPE_LIVRER_NOTHING: '1' });
const s2 = r.run ? runState(r.run) : {};
const l2 = r.run ? livrerSteps(r.run) : [];
ok(r.code === 0 && s2.status === 'done' && l2.length === 1 && l2[0].status === 'ok', `exécution terminée, Livrer accepté sans commit (code ${r.code}, ${l2.map(s => `${s.status} ${s.why || ''}`).join(' | ')})`, r.out.slice(-1500));
ok(version() === '1.14.1' && subjects().length === 2 && !g('status', '--porcelain').stdout.trim(), `aucun commit de plus, arbre propre (${subjects().join(' | ')})`);
reset();

// ---------------------------------------------------------------------------
section('3. Non affaibli : aucune version incrémentée dans l’exécution → toujours refusé');
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_LIVRER_NO_BUMP: '1' });
const s3 = r.run ? runState(r.run) : {};
const l3 = r.run ? livrerSteps(r.run) : [];
ok(r.code === 2 && s3.pausedLimit === 'criteria', `pause « limite » après les refus de Livrer (code ${r.code}, ${s3.pausedLimit})`, r.out.slice(-1200));
ok(l3.length >= 2 && l3.every(s => s.status === 'refused' && /version non incrémentée : package\.json inchangé/.test(s.why || '')), `chaque essai refusé : « version non incrémentée » (${l3.map(s => s.why).join(' | ')})`);
ok(version() === '1.14.0' && !subjects().some(s => /^docs: release/.test(s)), 'version inchangée, commit de livraison retiré');
reset();

r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_LIVRER_NOTHING: '1' });
const l3b = r.run ? livrerSteps(r.run) : [];
ok(r.code === 2 && l3b.length >= 2 && l3b.every(s => s.status === 'refused' && /aucun commit créé/.test(s.why || '')), `sans incrément et sans commit : « aucun commit créé » (${l3b.map(s => s.why).join(' | ')})`, r.out.slice(-800));
reset();

// ---------------------------------------------------------------------------
section('4. Non affaibli : version incrémentée par un item SANS entrée CHANGELOG → refusé');
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_ITEM_BUMP: '2:nolog', FAKE_PIPE_LIVRER_NO_BUMP: '1' });
const l4 = r.run ? livrerSteps(r.run) : [];
ok(r.code === 2 && l4.length >= 2 && l4.every(s => s.status === 'refused' && /pas d’entrée « ## \[1\.14\.1\] »/.test(s.why || '')), `refusé : pas d’entrée CHANGELOG pour 1.14.1 (${l4.map(s => s.why).join(' | ')})`, r.out.slice(-800));
reset();

// ---------------------------------------------------------------------------
// Pipelines phase 0 b, decision 9 (« tout comme recommandé », 2026-10-20,
// explicit agreement for this ⚠ test): with `codeDeliver`, the PROGRAM writes
// the release. Sections 1-4 above stay as they are (switch off = the model's
// delivery); here the same guarantees, with the program doing the writing.
section('5. Livrer par le programme (décision 9) : jamais un second incrément, entrée et exigence exigées');
{
  const mr = JSON.parse(fs.readFileSync(path.join(T, 'model-routing.json'), 'utf8'));
  mr.enforcement.tuning = { codeDeliver: ['P'] };
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify(mr));
}
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_ITEM_BUMP: '2' });
const s5 = r.run ? runState(r.run) : {};
const l5 = r.run ? livrerSteps(r.run) : [];
ok(r.code === 0 && s5.status === 'done' && l5.length === 1 && l5[0].status === 'ok', `version incrémentée par un item : Livrer du programme accepté du premier coup (${l5.map(s => `${s.status} ${s.why || ''}`).join(' | ')})`, r.out.slice(-1200));
ok(version() === '1.14.1', `aucun second incrément : 1.14.0 → ${version()}`);
ok(g('show', '--name-only', '--format=', 'HEAD').stdout.trim() === 'docs/USER_REQUIREMENTS.md' && /\| 1\.14\.1 \|/.test(fs.readFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), 'utf8')), 'commit de livraison : la seule ligne d’exigence (entrée CHANGELOG de l’item gardée telle quelle)');
reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_ITEM_BUMP: '2:req' });
const l5b = r.run ? livrerSteps(r.run) : [];
ok(r.code === 0 && l5b.length === 1 && l5b[0].status === 'ok' && subjects().length === 2 && !g('status', '--porcelain').stdout.trim(), `version, entrée et exigence déjà commitées : aucun commit de plus (${subjects().join(' | ')})`, r.out.slice(-800));
reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_ITEM_BUMP: '2:nolog' });
const l5c = r.run ? livrerSteps(r.run) : [];
ok(r.code === 0 && l5c.length === 1 && l5c[0].status === 'ok' && /## \[1\.14\.1\] - /.test(fs.readFileSync(path.join(P, 'CHANGELOG.md'), 'utf8')) && version() === '1.14.1',
  `incrément sans entrée CHANGELOG : le programme écrit l’entrée « ## [1.14.1] » exigée par le même critère (${l5c.map(s => `${s.status} ${s.why || ''}`).join(' | ')})`, r.out.slice(-800));
reset();
r = await go([REQ, '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2' });
const l5d = r.run ? livrerSteps(r.run) : [];
ok(r.code === 0 && l5d.length === 1 && l5d[0].status === 'ok' && version() === '1.14.1', `aucun incrément dans l’exécution : le programme incrémente une fois (${version()})`, r.out.slice(-800));
reset();

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
