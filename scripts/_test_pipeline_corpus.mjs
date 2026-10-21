#!/usr/bin/env node
// ============================================================================
// scripts/_test_pipeline_corpus.mjs — the real corpus of mis-routed requests,
// replayed on the generics (pipelines phase 1, PIPELINES-SYNTHESE §8.2, §8.3)
// ============================================================================
//
// Exit criterion of phase 1 (decision of the user, 2026-10-21, « vas y »):
// « corpus : push, reel, TODO, APK, bond et comparaison de dossiers vont au bon
// générique ; postconditions vérifiées ». The corpus (tests/pipeline-corpus/
// cases.json) holds the real requests of the production, anonymised.
//
// Here, offline (fake claude): for each case, the classifier's answer is the
// expected generic, and the run must reach it and VERIFY its effect on the
// disk — what the code does once the meaning is found. Whether the real model
// finds that meaning is measured by scripts/pipeline-corpus-classify.mjs
// (real classifier calls, outside the regression).
//
//   node scripts/_test_pipeline_corpus.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { classificationPrompt, classifierChoices } from './pipeline-classify.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const CORPUS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'pipeline-corpus', 'cases.json'), 'utf8'));
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const byId = Object.fromEntries(CORPUS.cases.map(c => [c.id, c]));

section('1. Le corpus : réel, anonymisé, chaque cas a son générique attendu');
{
  ok(['push', 'reel', 'todo', 'apk', 'bond', 'comparaison'].every(id => byId[id]), 'les six cas du critère de sortie : push, reel, TODO, APK, bond, comparaison de dossiers');
  ok(CORPUS.cases.every(c => E.ENGINE_PIPELINES.includes(c.expected.pipeline)), 'chaque générique attendu est un pipeline exécutable');
  const text = JSON.stringify(CORPUS);
  const urls = [...text.matchAll(/https?:\/\/([^/\s"]+)/g)].map(m => m[1]);
  ok(urls.every(h => h === 'www.example.org' || h === 'keepachangelog.com'), `aucune URL réelle (hôtes : ${[...new Set(urls)].join(', ')})`);
  let priv = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const pub = new Set(['orchestrateur', 'orchestrateur-dev', 'chef', 'pipelineLab']);
    priv = (cfg.projects || []).map(p => p.name).filter(n => n && !pub.has(n) && !/^chef-\d+$/.test(n) && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  } catch { /* no local config: nothing to compare */ }
  ok(!priv.length, `aucun nom de projet privé du config.json local${priv.length ? ` : ${priv.join(', ')}` : ''}`);
  ok(!/@[\w-]+\.(com|fr|org)\b/.test(text.replace(/keepachangelog\.com/g, '')), 'aucune adresse mail');
}

section('2. La consigne de classement (interrupteur « generic ») propose chaque générique attendu');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-corpus-'));
{
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {} }));
  const choices = classifierChoices(T, { generic: true });
  const prompt = classificationPrompt('x', {}, choices);
  for (const c of CORPUS.cases) {
    const p = c.expected.pipeline, m = c.expected.mode;
    ok(new RegExp(`- ${p}:`).test(prompt) && (!m || new RegExp(`mode "${m}"`).test(prompt)) && (!c.expected.operation || prompt.includes(c.expected.operation)),
      `${c.id} : « ${p}${m ? ` / ${m}` : ''}${c.expected.operation ? ` / ${c.expected.operation}` : ''} » décrit dans la consigne`);
  }
}

// ---------------------------------------------------------------------------
// Replays: real dispatch.mjs and engine, fake claude, throwaway root
// ---------------------------------------------------------------------------
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'chef'));
fs.mkdirSync(path.join(T, 'scripts'));
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
const put = (abs, s) => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, s); };
function project(name, extra = {}, cfg = {}) {
  const dir = path.join(T, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const w = (rel, s) => put(path.join(dir, rel), s);
  w('package.json', JSON.stringify({ name, version: '1.0.0', type: 'module' }, null, 2) + '\n');
  w('.gitignore', '*.mp4\n*.apk\n');
  w('test/base.test.mjs', "import { test } from 'node:test';\ntest('base', () => {});\n");
  w('.orchestrateur/pipeline.json', JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], ...cfg }));
  for (const [rel, s] of Object.entries(extra)) w(rel, s);
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
// The service of the « déploiement » case answers on a local port — in its own
// process: this one is blocked by spawnSync while dispatch.mjs runs.
const portFile = path.join(T, 'service.port');
const srv = spawn(process.execPath, ['-e', `const h=require('http');const s=h.createServer((q,r)=>{r.writeHead(200);r.end('version 1.49.5')});s.listen(0,'127.0.0.1',()=>require('fs').writeFileSync(${JSON.stringify(portFile)},String(s.address().port)))`], { stdio: 'ignore', windowsHide: true });
for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise(r => setTimeout(r, 50));
const SERVICE_URL = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8')}/api/version`;
const NAMES = ['projet-video', 'projet-app', 'orchestrateur-dev', 'orchestrateur', 'projet-media', 'projet-box'];
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, ...NAMES.map(n => ({ name: n, path: path.join(T, n), ...(n === 'orchestrateur-dev' ? { devOf: 'orchestrateur' } : {}) }))],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: NAMES, pipelines: E.ENGINE_PIPELINES, tuning: { generic: true } },
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } },
}, null, 2));
// Stand-ins of the orchestrator's copy-build and of a phone (adb), never the real ones.
put(path.join(T, 'scripts', 'copy-build.mjs'), `import fs from 'node:fs';import path from 'node:path';const p=process.argv[2];const src=path.join(${JSON.stringify(T)},p,'app','build','app-debug.apk');const d=path.join(${JSON.stringify(T)},'builds',p);fs.mkdirSync(d,{recursive:true});const s=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);fs.copyFileSync(src,path.join(d,s+'.apk'));fs.copyFileSync(src,path.join(d,'latest.apk'));\n`);
const ADB = path.join(T, 'fake-adb.mjs');
const ADB_STATE = path.join(T, 'adb-installed.txt');
put(ADB, `import fs from 'node:fs';const a=process.argv.slice(2);const f=${JSON.stringify(ADB_STATE)};if(a[0]==='get-state'){console.log('device');process.exit(0)}if(a[0]==='install'){fs.writeFileSync(f,'42');console.log('Success');process.exit(0)}if(a[0]==='shell'){console.log(fs.existsSync(f)?'versionCode='+fs.readFileSync(f,'utf8')+' minSdk=24':'');process.exit(0)}process.exit(1);\n`);
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', ORCH_FFPROBE: 'none', ORCH_ADB: ADB,
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME',
  'FAKE_PIPE_JSON', 'FAKE_PIPE_BAD', 'FAKE_PIPE_NOTHING', 'FAKE_CLAUDE_CHOICE', 'FAKE_CLAUDE_DUMP_PROMPT', 'FAKE_CLAUDE_CLASSIFY', 'ORCH_REQUEST_ID']) delete baseEnv[k];
const logOf = (p) => { try { return fs.readFileSync(path.join(T, 'logs', `${p}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
function replay(c, { request = c.request, classify = {}, env = {} } = {}) {
  const n0 = logOf(c.project).length;
  const cls = { pipeline: c.expected.pipeline, mode: c.expected.mode || 'complet', raison: `corpus ${c.id}`, ...(c.expected.operation ? { operations: [{ id: c.expected.operation, params: {} }] } : {}), ...(c.authorization ? { autorisation: c.authorization } : {}), ...classify };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), c.project, request, '--test', `corpus ${c.id}`],
    { env: { ...baseEnv, FAKE_CLAUDE_CLASSIFY: JSON.stringify(cls), ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  const evs = logOf(c.project).slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline?.run)?.pipeline.run;
  const st = run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : null;
  const turns = evs.filter(e => e.subtype === 'pipeline_step_start' && !e.byCode).length;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, run, st, turns, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const table = [];
const verdict = (c, x, effect) => {
  const right = x.st?.pipeline === c.expected.pipeline && (!c.expected.mode || x.st.mode === c.expected.mode);
  ok(right && x.st?.status === 'done', `${c.id} : ${c.before.pipeline} → ${E.pipelineLabel(x.st?.pipeline, x.st?.mode)} (${x.st?.status})`, x.out.slice(-1500));
  ok(effect.ok, `${c.id} : effet vérifié — ${effect.what}`, effect.detail);
  table.push(`| ${c.id} | ${c.before.pipeline} — ${c.before.effect} | ${E.pipelineLabel(x.st?.pipeline, x.st?.mode)} | ${x.turns} tour(s) d’étape | ${effect.ok ? '✓' : '✕'} ${effect.what} |`);
};

section('3. push → Opérations : poussé, relu par ls-remote');
{
  const c = byId.push;
  const remote = path.join(T, 'remote-video.git');
  g(T, 'init', '-q', '--bare', '-b', 'main', remote);
  const dir = project(c.project);
  g(dir, 'remote', 'add', 'origin', remote);
  for (const i of [1, 2]) { put(path.join(dir, `src/v${i}.mjs`), `export const v = ${i};\n`); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', `v${i}`); }
  const x = replay(c);
  const local = g(dir, 'rev-parse', 'HEAD').stdout.trim();
  verdict(c, x, { ok: g(remote, 'rev-parse', 'refs/heads/main').stdout.trim() === local && x.evs.some(e => e.subtype === 'pipeline_operation' && /ls-remote/.test(e.operation?.observed)), what: 'le distant a les commits (git ls-remote)' });
}

section('4. reel et vidéo → Fichiers : téléchargé, ouvert, jamais commité');
for (const id of ['reel', 'video']) {
  const c = byId[id];
  const dir = project(c.project, { 'Ancienne.mp4': MP4 });
  const dest = id === 'reel' ? 'videos/reel-AbC123.mp4' : 'Titre de la video.mp4';
  const url = (/https:\/\/\S+?(?=[\s»]|$)/.exec(c.request) || [])[0].replace(/[.,]$/, '');
  const x = replay(c, { env: { FAKE_PIPE_JSON: JSON.stringify({ inventorier: { operations: [{ op: 'acquerir', url, destination: dest }] }, acquerir: { writes: { [dest]: '@mp4' } } }) } });
  verdict(c, x, { ok: fs.existsSync(path.join(dir, dest)) && /vidéo valide/.test(x.result) && g(dir, 'log', '-1', '--format=%s').stdout.trim() === 'init', what: `${dest} présent, vidéo valide, aucun binaire commité`, detail: x.result.slice(0, 600) });
}

section('5. TODO → Rédaction « document » : deux lignes ajoutées, rien d’autre');
{
  const c = byId.todo;
  const TODO = '# TODO\n\n- [x] (2026-10-18) lecteur Dailymotion\n';
  const dir = project(c.project, { 'TODO_LIST.md': TODO });
  const after = `${TODO}- [ ] (2026-10-19) ajouter au lecteur les 5 vidéos demandées\n- [ ] (2026-10-19) télécharger le reel\n`;
  const x = replay(c, { request: c.request.replace('le TODO_LIST.md', 'le `TODO_LIST.md`'), env: { FAKE_CLAUDE_CHOICE: 'completer', FAKE_PIPE_JSON: JSON.stringify({ modifier: { writes: { 'TODO_LIST.md': after } } }) } });
  const files = g(dir, 'show', '--name-only', '--format=', 'HEAD').stdout.trim();
  verdict(c, x, { ok: fs.readFileSync(path.join(dir, 'TODO_LIST.md'), 'utf8') === after && files === 'TODO_LIST.md', what: 'TODO_LIST.md complété (rien retiré), commit de ce seul fichier', detail: files });
}

section('6. APK → Opérations : publié puis installé, versionCode relu sur l’appareil');
{
  const c = byId.apk;
  const dir = project(c.project, { 'app/build.gradle.kts': 'android {\n  defaultConfig {\n    applicationId = "org.example.app"\n    versionCode = 42\n    versionName = "1.4.0"\n  }\n}\n' });
  put(path.join(dir, 'app', 'build', 'app-debug.apk'), 'APK');
  fs.rmSync(ADB_STATE, { force: true });
  const x = replay(c, { env: { FAKE_PIPE_JSON: JSON.stringify({ preparer: { operations: [{ id: 'copy_build', params: {} }, { id: 'adb_install', params: {}, autorisation: c.authorization }] } }) } });
  verdict(c, x, { ok: fs.existsSync(path.join(T, 'builds', c.project, 'latest.apk')) && x.evs.some(e => e.subtype === 'pipeline_operation' && e.operation?.id === 'adb_install' && /versionCode=42/.test(e.operation.observed)), what: 'latest.apk publié ; versionCode=42 relu sur l’appareil' });
}

section('7. bond → Opérations : le PLAN de prod-jump, jamais --apply, prod inchangée');
{
  const c = byId.bond;
  const prod = project('orchestrateur');
  const prodHead = g(prod, 'rev-parse', 'HEAD').stdout.trim();
  const dir = project(c.project, { 'scripts/prod-jump.mjs': `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(T, 'pj-argv.json'))}, JSON.stringify(process.argv.slice(2)));console.log('[prod-jump] plan seulement');\n` });
  g(dir, 'tag', '-a', 'v1.4.0', '-m', 'v1.4.0');
  const x2 = replay(c, { classify: { operations: [{ id: 'prod_jump', params: { tag: 'v1.4.0' } }] } });
  const argv = fs.existsSync(path.join(T, 'pj-argv.json')) ? JSON.parse(fs.readFileSync(path.join(T, 'pj-argv.json'), 'utf8')) : [];
  verdict(c, x2, { ok: argv.includes('--tag') && !argv.includes('--apply') && g(prod, 'rev-parse', 'HEAD').stdout.trim() === prodHead, what: 'plan de prod-jump sans --apply, prod inchangée', detail: argv.join(' ') });
}

section('8. comparaison de dossiers → Fichiers : le tableau écrit par le code, rien modifié');
{
  const c = byId.comparaison;
  const dir = project(c.project);
  const A = path.join(T, 'series', 'Atelier'), B = path.join(T, 'series', 'Atekuer S01');
  put(path.join(A, 'e01.mkv'), 'un'); put(path.join(A, 'e02.mkv'), 'deux'); put(path.join(B, 'e01.mkv'), 'un');
  const x = replay(c, { request: c.request.replace('{A}', A).replace('{B}', B), env: { FAKE_PIPE_JSON: JSON.stringify({ inventorier: { operations: [{ op: 'comparer', a: A, b: B }] } }) } });
  verdict(c, x, { ok: /`e02\.mkv`/.test(x.result) && g(dir, 'status', '--porcelain').stdout.trim() === '' && x.turns === 1, what: 'différence listée (e02.mkv), projet inchangé, un seul tour de model', detail: x.result.slice(0, 500) });
}

section('9. déploiement → Opérations : service déclaré redémarré, URL relue');
{
  const c = byId.deploiement;
  project(c.project, {}, { operations: { services: { serveur: { argv: [process.execPath, '-e', '0'], check: { url: SERVICE_URL, contains: '1.49.5', timeoutSec: 5 } } } } });
  const x = replay(c, { classify: { operations: [{ id: 'service_restart', params: { service: 'serveur' } }], autorisation: 'lance le deploiement' } });
  verdict(c, x, { ok: x.evs.some(e => e.subtype === 'pipeline_operation' && /répond \(HTTP 200\)/.test(e.operation?.observed || '')), what: 'l’URL du service répond avec la version' });
}
srv.kill();

section('10. Avant / après (tours de model des étapes ; le classement est commun)');
console.log(['| cas | avant | après | tours | effet |', '|---|---|---|---|---|', ...table].join('\n'));
ok(byId.reunion.expected.pipeline === 'reunion' && /reunion/.test(classificationPrompt('x', {}, classifierChoices(T, { generic: true }))), 'spécialisé avant générique : la réunion reste au pipeline Réunion');

if (!process.env.KEEP_T) { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} } else console.log(T);
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
