#!/usr/bin/env node
// ============================================================================
// scripts/_test_dev_pilot_first.mjs — lanes for the dev instance only (0.104.0)
// ============================================================================
//
// User decision (2026-10-15), verbatim: « il ne faudra passer d'abord que
// orchestrateur-dev, on ne passera orchestrateur qu'a la maj suivante »
//
// Permanent requirement test:
//   1. maxParallelInfo: a project that has a dev instance (another entry with
//      `devOf: <it>`) and no `maxParallel` of its own gets 1, with its reason;
//      defaults.maxParallel does not reach it; its own `maxParallel` still
//      wins; the dev instance itself keeps the default 2;
//   2. lanesStatus reports 1 and the reason for the production project, 2 for
//      the dev one;
//   3. real dispatch.mjs + fake claude: two tasks of the production project
//      run one after the other (0.67.0 turn lock, no lane created), two tasks
//      of the dev project run at the same time (lanes 0 and 1).
//
//   node scripts/_test_dev_pilot_first.mjs
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

section('1. Seule la dev passe aux couloirs (décision utilisateur du 2026-10-15)');
{
  const prod = { name: 'P' }, dev = { name: 'PD', devOf: 'P' };
  const cfg = { projects: [prod, dev, { name: 'X' }] };
  const ip = L.maxParallelInfo(cfg, prod);
  ok(L.DEV_PILOT_FIRST === true && ip.value === 1 && ip.source === 'dev-pilot-first' && /PD/.test(ip.why) && /mise à jour suivante/.test(ip.why), `projet de prod (une dev le désigne) : 1, raison « ${ip.why} »`);
  ok(L.maxParallelFor(cfg, dev) === 2 && L.maxParallelFor(cfg, { name: 'X' }) === 2, 'la dev et les autres projets gardent le défaut 2');
  ok(L.maxParallelFor({ ...cfg, defaults: { maxParallel: 3 } }, prod) === 1 && L.maxParallelFor({ ...cfg, defaults: { maxParallel: 3 } }, dev) === 3, 'defaults.maxParallel n’atteint pas la prod');
  ok(L.maxParallelFor({ projects: [{ name: 'P', maxParallel: 2 }, dev] }, { name: 'P', maxParallel: 2 }) === 2, 'un maxParallel propre à la prod (mise à jour suivante) prime');
  ok(L.maxParallelFor({ projects: [{ name: 'P', devOf: 'P' }] }, { name: 'P', devOf: 'P' }) === 2, 'un devOf vers soi-même ne compte pas');
}

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-devfirst-'));
const LOGS = path.join(T, 'logs');
const dirOf = (n) => path.join(T, n);
for (const d of [LOGS, dirOf('chef'), dirOf('P'), dirOf('PD')]) fs.mkdirSync(d, { recursive: true });
const g = (dir, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: dir, encoding: 'utf8' });
for (const n of ['P', 'PD']) {
  fs.writeFileSync(path.join(dirOf(n), 'package.json'), JSON.stringify({ name: n.toLowerCase(), version: '1.0.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(dirOf(n), 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  g(dirOf(n), 'init', '-q', '-b', 'master'); g(dirOf(n), 'add', '-A'); g(dirOf(n), 'commit', '-q', '-m', 'init');
}
const config = {
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: dirOf('chef') }, { name: 'P', path: dirOf('P') }, { name: 'PD', path: dirOf('PD'), devOf: 'P' }],
};
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify(config));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, history: [], enforcement: { projects: [], pipelines: [] } }));
fs.writeFileSync(path.join(T, '.token'), 'a'.repeat(64));
const CLAUDE_JSON = path.join(T, 'claude.json');
fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ projects: {} }));

section('2. État des couloirs : 1 et la raison pour la prod, 2 pour la dev');
{
  const sp = L.lanesStatus({ root: T, logsDir: LOGS, config, project: config.projects[1] });
  const sd = L.lanesStatus({ root: T, logsDir: LOGS, config, project: config.projects[2] });
  ok(sp.maxParallel === 1 && sp.maxParallelSource === 'dev-pilot-first' && /mise à jour suivante/.test(sp.maxParallelWhy || ''), `prod : ${sp.maxParallel} (${sp.maxParallelSource})`, JSON.stringify(sp));
  ok(sd.maxParallel === 2 && sd.maxParallelSource === 'default' && !sd.maxParallelWhy, `dev : ${sd.maxParallel} (${sd.maxParallelSource})`, JSON.stringify(sd));
}

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

section('3. Vrai dispatch : la prod reste en série, la dev tourne en parallèle');
{
  const a = run(['P', 'Première tâche, lente', '--source', 'chef'], { ...SLOW });
  await new Promise(r => setTimeout(r, 700));
  const b = await run(['P', 'Seconde tâche', '--source', 'chef', '--no-queue-if-busy'], {});
  const ra = await a;
  ok(ra.code === 0 && b.code === 0 && /attente de sa fin/.test(b.out) && b.t1 >= ra.t1 - 50, 'prod : la seconde tâche attend la fin de la première (verrou de tour 0.67.0)', b.out);
  ok(!fs.existsSync(path.join(T, 'lanes', 'P')) && !fs.existsSync(path.join(LOGS, 'lanes', 'P')), 'prod : aucun couloir créé');
}
{
  const a = run(['PD', 'Dialogue direct, lent'], { ...SLOW });
  await new Promise(r => setTimeout(r, 700));
  const b = await run(['PD', 'Tâche du Routage', '--source', 'chef'], { ...SLOW, FAKE_CLAUDE_WRITE: 'changelog.d/b.md' });
  const ra = await a;
  ok(ra.code === 0 && b.code === 0, `dev : les deux tours finissent (codes ${ra.code}/${b.code})`, b.out);
  const c1 = norm(initCwd(events(path.join(LOGS, 'lanes', 'PD', '1.jsonl'))));
  ok(c1 === norm(path.join(T, 'lanes', 'PD', '1')) && Math.min(ra.t1, b.t1) > Math.max(ra.t0, b.t0) && !/attente de sa fin/.test(b.out), 'dev : la seconde tâche tourne en même temps, dans le couloir 1', b.out);
}

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exitCode = fail ? 1 : 0;
