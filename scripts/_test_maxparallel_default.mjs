#!/usr/bin/env node
// ============================================================================
// scripts/_test_maxparallel_default.mjs — default maxParallel is 2 (0.103.0)
// ============================================================================
//
// User decision Q1 (2026-10-15), verbatim: « Q1: defaut a 2, et on monitore
// pour verifier si on peut passer a 3. Le monitoring n'est pas a faire
// maintenant, mets dans une TODO »
//
// Permanent requirement test:
//   1. maxParallelFor: a project without `maxParallel` (and no
//      defaults.maxParallel) gets 2; hard cap stays 4; an explicit 1 (project
//      or defaults) keeps the 0.67.0 path;
//   2. lanesStatus reports 2 for such a project;
//   3. real dispatch.mjs + fake claude: two tasks of a git project WITHOUT
//      `maxParallel` run at the same time (lane 0 and lane 1);
//   4. exception rules stay active under the default: a project without git
//      and without `maxParallel` stays serial, justified (rule no-git).
//
//   node scripts/_test_maxparallel_default.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const L = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lanes.mjs')).href);
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

section('1. Valeur par défaut : 2 (décision utilisateur Q1)');
{
  ok(L.DEFAULT_MAX_PARALLEL === 2 && L.maxParallelFor({}, {}) === 2 && L.maxParallelFor({ defaults: {} }, { name: 'p' }) === 2, 'projet sans maxParallel, defaults sans maxParallel : 2');
  ok(L.HARD_CAP === 4 && L.maxParallelFor({}, { maxParallel: 99 }) === 4, 'plafond dur inchangé : 4');
  ok(L.maxParallelFor({}, { maxParallel: 1 }) === 1 && L.maxParallelFor({ defaults: { maxParallel: 1 } }, {}) === 1, 'un 1 explicite (projet ou defaults) garde le chemin 0.67.0');
  ok(L.maxParallelFor({ defaults: { maxParallel: 1 } }, { maxParallel: 3 }) === 3 && L.maxParallelFor({ defaults: { maxParallel: 3 } }, {}) === 3, 'le projet, puis defaults, priment sur le défaut');
  ok(L.maxParallelFor({}, { maxParallel: 0 }) === 1 && L.maxParallelFor({}, { maxParallel: 'x' }) === 1, 'valeur invalide = 1 (jamais plus que demandé)');
}

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-maxpar-'));
const LOGS = path.join(T, 'logs');
const dirOf = (n) => path.join(T, n);
for (const d of [LOGS, dirOf('chef'), dirOf('D'), dirOf('G')]) fs.mkdirSync(d, { recursive: true });
const g = (dir, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: dir, encoding: 'utf8' });
fs.writeFileSync(path.join(dirOf('D'), 'package.json'), JSON.stringify({ name: 'd', version: '1.0.0' }, null, 2) + '\n');
fs.writeFileSync(path.join(dirOf('D'), 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
g(dirOf('D'), 'init', '-q', '-b', 'master'); g(dirOf('D'), 'add', '-A'); g(dirOf('D'), 'commit', '-q', '-m', 'init');
fs.writeFileSync(path.join(dirOf('G'), 'notes.txt'), 'pas de git\n');
const config = {
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: dirOf('chef') }, { name: 'D', path: dirOf('D') }, { name: 'G', path: dirOf('G') }],
};
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify(config));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, history: [], enforcement: { projects: [], pipelines: [] } }));
fs.writeFileSync(path.join(T, '.token'), 'a'.repeat(64));
const CLAUDE_JSON = path.join(T, 'claude.json');
fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ projects: {} }));

section('2. État des couloirs : 2 pour un projet sans réglage');
{
  const st = L.lanesStatus({ root: T, logsDir: LOGS, config, project: config.projects[1] });
  ok(st.maxParallel === 2, `lanesStatus D : maxParallel ${st.maxParallel}`, JSON.stringify(st));
}

// A fake server: dispatch.mjs may post to it; everything is accepted.
const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, queued: true, position: 1 })); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '1',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_NO_PENDING_RELEASE: '1', ORCH_TURN_LOCK_POLL_MS: '100', ORCH_CLAUDE_JSON: CLAUDE_JSON };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID',
  'ORCH_TURN_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'ORCH_TEST_LABEL', 'FAKE_CLAUDE_WRITE', 'FAKE_CLAUDE_REPLY', 'CLAUDECODE']) delete baseEnv[k];
const run = (args, env = {}) => new Promise((resolve) => {
  const t0 = Date.now();
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 180_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out, t0, t1: Date.now() }); });
});
const events = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return { unreadable: l }; } }); } catch { return []; } };
const norm = (p) => path.resolve(String(p || '')).toLowerCase();
const initCwd = (evs) => evs.find(e => e.type === 'system' && e.subtype === 'init')?.cwd;
const SLOW = { FAKE_CLAUDE_LATENCY_MS: '400', FAKE_CLAUDE_TOOL_USES: '4' };

section('3. Projet git sans maxParallel : deux tâches en même temps (couloirs 0 et 1)');
{
  const a = run(['D', 'Dialogue direct, lent'], { ...SLOW });
  await new Promise(r => setTimeout(r, 700));
  const b = await run(['D', 'Tâche du Routage', '--source', 'chef'], { ...SLOW, FAKE_CLAUDE_WRITE: 'changelog.d/b.md' });
  const ra = await a;
  ok(ra.code === 0 && b.code === 0, `les deux tours finissent (codes ${ra.code}/${b.code})`, b.out);
  const c0 = norm(initCwd(events(path.join(LOGS, 'D.jsonl')))), c1 = norm(initCwd(events(path.join(LOGS, 'lanes', 'D', '1.jsonl'))));
  ok(c0 === norm(dirOf('D')) && c1 === norm(path.join(T, 'lanes', 'D', '1')), `deux dossiers : copie principale et couloir 1 (${path.basename(c0)}, ${c1 ? 'lanes/D/1' : '—'})`);
  ok(Math.min(ra.t1, b.t1) > Math.max(ra.t0, b.t0) && !/attente de sa fin|en série/.test(b.out), 'les deux tours se recouvrent, la tâche n’a pas attendu', b.out);
}

section('4. Les exceptions restent actives sous le défaut : sans git, en série (no-git)');
{
  const a = run(['G', 'Première tâche', '--source', 'chef'], { ...SLOW });
  await new Promise(r => setTimeout(r, 700));
  const b = await run(['G', 'Seconde tâche', '--source', 'chef', '--no-queue-if-busy'], {});
  const ra = await a;
  const ex = events(path.join(LOGS, 'G.jsonl')).find(x => x.subtype === 'lane_exclusive');
  ok(ra.code === 0 && b.code === 0 && ex?.rule === 'no-git' && b.t1 >= ra.t1 - 50, `seconde tâche après la première, raison écrite (« ${ex?.text} »)`, b.out);
  ok(!fs.existsSync(path.join(T, 'lanes', 'G')), 'aucune copie créée pour un projet sans git');
}

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exitCode = fail ? 1 : 0;
