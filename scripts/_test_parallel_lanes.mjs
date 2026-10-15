#!/usr/bin/env node
// ============================================================================
// scripts/_test_parallel_lanes.mjs — tasks of the SAME musician run in
// parallel, each in its own git worktree; exceptions are justified (0.101.0)
// ============================================================================
//
// User request (2026-10-15), verbatim: « Il faut que ce soit assez fin (d'ou la
// question sur git) pour que les taches d'un meme musicien puissent s'activer
// en parallele. Sauf pour certains cas particuliers sont detectes, ils doivent
// alors etre justifies et documentes. »
//
// Permanent requirement test, with the real dispatch.mjs and the fake claude:
//   1. two tasks of one musician run at the same time in two distinct
//      worktrees (lanes 1 and 2) while lane 0 runs a third; logs never
//      interleave; both are integrated, versions assigned in order;
//   2. an exception (shared server port) falls back to the queue with its
//      justification (queue entry + system/lane_exclusive), or waits;
//   3. a project without git stays serial, justified (rule no-git);
//   4. maxParallel = 1: exactly the 0.67.0 behaviour, no lane created;
//   5. a lane question keeps its lane; the answer resumes it (same-task);
//   6. a merge conflict pauses the integration, nothing overwritten;
//   7. a lane whose owner died is recovered (work kept, turn closed);
//   8. the activity journal shows lane tasks and the justification;
//   9. user decisions Q2/Q3 (2026-10-15): a finished task branch is kept one
//      week, then deleted — never before, never a paused one, never one that
//      moved; no tags; integration is a merge (task commits in the history).
//
//   node scripts/_test_parallel_lanes.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lanes-'));
const LOGS = path.join(T, 'logs');
const dirOf = (n) => path.join(T, n);
for (const d of [LOGS, dirOf('chef'), dirOf('P'), dirOf('N'), dirOf('S'), dirOf('X')]) fs.mkdirSync(d, { recursive: true });
const g = (dir, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: dir, encoding: 'utf8' });
function initRepo(dir) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir).toLowerCase(), version: '1.0.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'CLAUDE.local.md\n.env\n');
  g(dir, 'init', '-q', '-b', 'master'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), '# local rules\n');
  fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
}
for (const n of ['P', 'S', 'X']) initRepo(dirOf(n));
fs.writeFileSync(path.join(dirOf('N'), 'notes.txt'), 'pas de git\n');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: dirOf('chef') }, { name: 'P', path: dirOf('P'), maxParallel: 3, port: 5173 },
    { name: 'N', path: dirOf('N'), maxParallel: 2 }, { name: 'S', path: dirOf('S'), maxParallel: 1 }, { name: 'X', path: dirOf('X'), maxParallel: 2 }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, history: [], enforcement: { projects: [], pipelines: [] } }));
fs.writeFileSync(path.join(T, '.token'), 'a'.repeat(64));
const CLAUDE_JSON = path.join(T, 'claude.json');
fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ projects: {} }));

// A fake server: records what dispatch.mjs posts, queues everything.
const posts = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => { b += c; });
  req.on('end', () => { try { posts.push({ path: req.url, ...JSON.parse(b) }); } catch {} res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, queued: true, position: 1 })); });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '1',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(PORT), ORCH_NO_PENDING_RELEASE: '1', ORCH_TURN_LOCK_POLL_MS: '100', ORCH_CLAUDE_JSON: CLAUDE_JSON };
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
const mainLog = (p) => events(path.join(LOGS, `${p}.jsonl`));
const laneLog = (p, k) => events(path.join(LOGS, 'lanes', p, `${k}.jsonl`));
const laneDir = (p, k) => path.join(T, 'lanes', p, String(k));
const norm = (p) => path.resolve(String(p || '')).toLowerCase();
const initCwd = (evs) => evs.find(e => e.type === 'system' && e.subtype === 'init')?.cwd;
const SLOW = { FAKE_CLAUDE_LATENCY_MS: '400', FAKE_CLAUDE_TOOL_USES: '4' };
const lanesFree = (p) => { try { return !fs.readdirSync(path.join(LOGS, 'lanes', p)).some(f => /\.(turnlock|task\.json)$/.test(f)); } catch { return true; } };

// ---------------------------------------------------------------------------
section('1. Deux tâches d’un même musicien tournent en même temps, chacune dans sa copie git');
{
  const a = run(['P', 'Dialogue direct, lent'], { ...SLOW });
  await new Promise(r => setTimeout(r, 700));
  const b = run(['P', 'Tâche B du Routage', '--source', 'chef'], { ...SLOW, FAKE_CLAUDE_WRITE: 'changelog.d/b.md' });
  const c = run(['P', 'Tâche C du Routage', '--source', 'chef'], { ...SLOW, FAKE_CLAUDE_WRITE: 'changelog.d/c.md' });
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  ok(ra.code === 0 && rb.code === 0 && rc.code === 0, `les trois tours finissent (codes ${ra.code}/${rb.code}/${rc.code})`, rb.out + '\n' + rc.out);
  const l1 = laneLog('P', 1), l2 = laneLog('P', 2);
  const cw = [initCwd(mainLog('P')), initCwd(l1), initCwd(l2)].map(norm);
  ok(cw[0] === norm(dirOf('P')) && new Set(cw).size === 3 && [cw[1], cw[2]].sort().join('|') === [norm(laneDir('P', 1)), norm(laneDir('P', 2))].join('|'),
    `trois dossiers distincts : copie principale, worktrees 1 et 2 (${cw.map(x => path.basename(x)).join(', ')})`, cw.join(' | '));
  for (const k of [1, 2]) ok(g(laneDir('P', k), 'rev-parse', '--git-common-dir').stdout.trim() && fs.existsSync(path.join(laneDir('P', k), '.git')) && fs.statSync(path.join(laneDir('P', k), '.git')).isFile(), `couloir ${k} : un git worktree du dépôt (fichier .git)`);
  const overlap = Math.min(rb.t1, rc.t1) > Math.max(rb.t0, rc.t0) && Math.min(ra.t1, rb.t1) > Math.max(ra.t0, rb.t0);
  ok(overlap && !/attente|en série/.test(rb.out + rc.out), 'B et C (et A) se recouvrent dans le temps, aucun n’a attendu', `${rb.out}\n${rc.out}`);
  const ids = (evs) => new Set(evs.map(e => e.orch_turn).filter(Boolean));
  ok(ids(l1).size === 1 && ids(l2).size === 1 && [...ids(l1)][0] !== [...ids(l2)][0] && [...l1, ...l2].every(e => !e.unreadable), 'un log par couloir : jamais deux tours entremêlés, aucune ligne illisible');
  const up = [...l1, ...l2].filter(e => e.type === 'user_prompt');
  ok(up.length === 2 && up.every(e => e.lane && e.lane.lane >= 1 && /^lane\/\d\//.test(e.lane.branch)), 'la demande de chaque tour porte son couloir et sa branche', JSON.stringify(up.map(e => e.lane)));
  const marks = mainLog('P').filter(e => e.subtype === 'lane_task');
  ok(marks.filter(m => m.state === 'running').length === 2 && marks.filter(m => m.outcome === 'integrated').length === 2, `marqueurs dans le log du musicien : 2 lancées, 2 intégrées (${marks.map(m => `${m.lane}:${m.outcome || m.state}`).join(', ')})`);
  const pkg = JSON.parse(fs.readFileSync(path.join(dirOf('P'), 'package.json'), 'utf8'));
  const cl = fs.readFileSync(path.join(dirOf('P'), 'CHANGELOG.md'), 'utf8');
  const vers = marks.filter(m => m.version).map(m => m.version).sort();
  ok(pkg.version === '1.0.2' && vers.join(',') === '1.0.1,1.0.2' && /## \[1\.0\.2\][\s\S]*## \[1\.0\.1\][\s\S]*## \[1\.0\.0\]/.test(cl), `versions attribuées à l’intégration, dans l’ordre (${vers.join(', ')} ; package.json ${pkg.version})`, cl);
  ok(!fs.existsSync(path.join(dirOf('P'), 'changelog.d', 'b.md')) && !fs.existsSync(path.join(dirOf('P'), 'changelog.d', 'c.md')), 'les fragments sont consommés par l’intégration');
  // User decisions Q2 (« eliminer les branches de taches une fois terminees,
  // apres 1 semaine ») and Q3 (« Fusion par merge »).
  const kept = g(dirOf('P'), 'branch', '--list', 'lane/*').stdout.split('\n').map(s => s.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
  const ret = JSON.parse(fs.readFileSync(path.join(LOGS, 'lanes', 'P', 'retained-branches.json'), 'utf8'));
  const week = 7 * 24 * 3600_000;
  ok(kept.length === 2 && ret.length === 2 && ret.every(e => kept.includes(e.branch) && e.outcome === 'integrated' && Math.abs(Date.parse(e.deleteAfter) - Date.parse(e.finishedAt) - week) < 1000),
    `branches de tâche gardées une semaine après l’intégration (${kept.join(', ')})`, JSON.stringify(ret));
  ok(!g(dirOf('P'), 'tag', '--list').stdout.trim(), 'aucun tag créé pour les tâches (décision : pas de tags)');
  ok(ret.every(e => g(dirOf('P'), 'merge-base', '--is-ancestor', e.tip, 'master').status === 0) && ret.every(e => g(dirOf('P'), 'rev-parse', e.branch).stdout.trim() === e.tip),
    'fusion par merge, jamais squash : chaque commit de tâche est dans l’historique de la branche d’intégration');
  ok(g(dirOf('P'), 'log', '--oneline').stdout.split('\n').filter(l => /chore\(release\): v1\.0\.[12]/.test(l)).length === 2, 'deux commits de release dans la branche d’intégration, jamais poussés');
  ok(fs.existsSync(path.join(laneDir('P', 1), 'CLAUDE.local.md')) && fs.existsSync(path.join(laneDir('P', 1), '.env')), 'provisionnement : les fichiers locaux ignorés (CLAUDE.local.md, .env) sont copiés dans le couloir');
  const cj = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
  ok(Object.entries(cj.projects || {}).some(([k, v]) => /lanes\/P\/1$/.test(k) && v.hasTrustDialogAccepted), 'confiance du dossier posée pour le couloir (sinon permissions.allow est ignoré)');
  ok(!fs.existsSync(path.join(LOGS, 'lanes', 'P', '1.task.json')) && !fs.existsSync(path.join(LOGS, 'lanes', 'P', '1.turnlock')), 'couloir rendu libre (ni tâche, ni verrou)');
}

// ---------------------------------------------------------------------------
section('2. Cas d’exception (port fixe partagé) : retour en file avec sa justification');
{
  const n0 = mainLog('P').length, p0 = posts.length;
  const d = run(['P', 'Lance le serveur de dev et vérifie la page', '--source', 'chef', '--ressources', 'serveur'], { ...SLOW });
  await new Promise(r => setTimeout(r, 900));
  const e = await run(['P', 'Vérifie aussi la page de contact sur le serveur', '--source', 'chef', '--ressources', 'serveur', '--queue-if-busy'], {});
  ok(e.code === 0 && /mis en file/.test(e.out) && /règle port/.test(e.out), 'la seconde tâche retombe en file (elle ne tourne pas en parallèle)', e.out);
  const q = posts.slice(p0).find(x => x.path === '/api/dispatch');
  ok(q && q.queueIfBusy && q.exclusive?.rule === 'port' && /port 5173/.test(q.exclusive.text) && q.ressources === 'serveur', `l’entrée de file porte la justification (${q?.exclusive?.rule} : « ${q?.exclusive?.text} »)`, JSON.stringify(q));
  const ex = mainLog('P').slice(n0).find(x => x.subtype === 'lane_exclusive');
  ok(ex && ex.rule === 'port' && ex.scope === 'resource' && /deux serveurs ne peuvent pas écouter le même port/.test(ex.text) && /PLAN-parallel-tasks-same-musician\.md/.test(ex.doc),
    'system/lane_exclusive écrit dans le log du musicien : règle, portée, raison en clair, lien vers la documentation', JSON.stringify(ex));
  // Without the queue: it waits for the resource, then runs.
  const f = await run(['P', 'Troisième tâche sur le serveur', '--source', 'chef', '--ressources', 'serveur', '--no-queue-if-busy'], {});
  const rd = await d;
  ok(f.code === 0 && rd.code === 0 && /⛓ en série/.test(f.out) && f.t1 > rd.t1 - 50, 'sans file : elle attend la fin de la tâche qui tient la ressource, puis tourne', f.out);
  // Independent work is not blocked by the resource.
  ok(fs.readdirSync(path.join(LOGS, 'lanes', 'P')).filter(x => /^res-.*\.lock$/.test(x)).length === 0, 'verrou de ressource libéré en fin de tour');
}

// ---------------------------------------------------------------------------
section('3. Projet sans git : reste en série, justifié (règle no-git)');
{
  const n0 = mainLog('N').length;
  const a = run(['N', 'Première tâche', '--source', 'chef'], { ...SLOW });
  await new Promise(r => setTimeout(r, 700));
  const b = await run(['N', 'Seconde tâche', '--source', 'chef', '--no-queue-if-busy'], {});
  const ra = await a;
  const ex = mainLog('N').slice(n0).find(x => x.subtype === 'lane_exclusive');
  ok(ra.code === 0 && b.code === 0 && ex?.rule === 'no-git' && /pas un dépôt git/.test(ex.text) && b.t1 >= ra.t1 - 50, `seconde tâche après la première, raison écrite (« ${ex?.text} »)`, b.out);
  ok(!fs.existsSync(path.join(T, 'lanes', 'N')), 'aucune copie créée pour un projet sans git');
}

// ---------------------------------------------------------------------------
section('4. maxParallel = 1 : exactement le comportement 0.67.0');
{
  const a = run(['S', 'Premier tour, lent'], { ...SLOW });
  await new Promise(r => setTimeout(r, 700));
  const b = await run(['S', 'Second tour', '--source', 'chef', '--no-queue-if-busy'], {});
  const ra = await a;
  ok(ra.code === 0 && b.code === 0 && /attente de sa fin/.test(b.out) && !/couloir/.test(b.out), 'le second attend le verrou de tour, aucun couloir', b.out);
  ok(!fs.existsSync(path.join(T, 'lanes', 'S')) && !fs.existsSync(path.join(LOGS, 'lanes', 'S')) && !mainLog('S').some(e => e.subtype?.startsWith('lane_') || e.lane), 'ni dossier de couloir, ni fichier, ni champ ajouté');
}

// ---------------------------------------------------------------------------
section('5. Une question posée dans un couloir le garde ; la réponse le reprend');
{
  const a = run(['X', 'Dialogue direct pendant ce temps'], { ...SLOW, FAKE_CLAUDE_TOOL_USES: '6' });
  await new Promise(r => setTimeout(r, 700));
  const q = await run(['X', 'Ajoute une option', '--source', 'chef'], { FAKE_CLAUDE_WRITE: 'notes/option.txt', FAKE_CLAUDE_REPLY: 'J’ai préparé deux variantes.\n\nNEEDS_USER_INPUT: variante A ou B ?' });
  const t = JSON.parse(fs.readFileSync(path.join(LOGS, 'lanes', 'X', '1.task.json'), 'utf8'));
  ok(q.code === 0 && t.state === 'input' && /attente d'une réponse \(--lane 1\)/.test(q.out), 'tour fini sur une question : le couloir 1 reste réservé à la tâche', q.out);
  ok(mainLog('X').some(e => e.subtype === 'lane_task' && e.state === 'input' && /variante A ou B/.test(e.question)), 'la question est visible dans le log du musicien (marqueur)');
  const ans = await run(['X', '[CHEF_ANSWER] Variante A', '--source', 'chef'], { FAKE_CLAUDE_WRITE: 'notes/option-a.txt' });
  const l1 = laneLog('X', 1).filter(e => e.type === 'user_prompt');
  ok(ans.code === 0 && l1.length === 2 && l1[1].lane?.rule === 'same-task' && l1[1].lane?.resumed && /intégrée/.test(ans.out), 'la réponse reprend le couloir 1 (règle same-task), puis la tâche est intégrée', ans.out);
  ok(fs.existsSync(path.join(dirOf('X'), 'notes', 'option.txt')) && fs.existsSync(path.join(dirOf('X'), 'notes', 'option-a.txt')), 'le travail des deux tours de la tâche arrive dans la copie principale');
  await a;
}

// ---------------------------------------------------------------------------
section('6. Conflit à l’intégration : pause, branche gardée, rien d’écrasé');
{
  // Lane 0 busy; two lane tasks create the same file with different contents.
  const hold = run(['P', 'Occupe la copie principale'], { ...SLOW, FAKE_CLAUDE_TOOL_USES: '6' });
  await new Promise(r => setTimeout(r, 700));
  const env = (m) => ({ ...SLOW, FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_WRITE: 'notes/commun.txt' });
  const [rb, rc] = await Promise.all([
    run(['P', 'Écris le fichier commun (haiku)', '--source', 'chef', '--model', 'claude-haiku-5-5'], env()),
    run(['P', 'Écris le fichier commun (sonnet)', '--source', 'chef', '--model', 'claude-sonnet-5-5'], env()),
  ]);
  await hold;
  const out = rb.out + rc.out;
  ok(rb.code === 0 && rc.code === 0 && /intégrée/.test(out) && /intégration en pause/.test(out), 'la première intégrée, la seconde en pause', out);
  const pm = mainLog('P').filter(e => e.subtype === 'lane_task' && e.outcome === 'paused').pop();
  ok(pm?.reason === 'conflict' && pm.files?.includes('notes/commun.txt'), `conflit détecté et nommé (« ${pm?.why} »)`, JSON.stringify(pm));
  ok(g(dirOf('P'), 'branch', '--list', pm?.branch || '-').stdout.trim() && fs.existsSync(pm?.diff || '-'), 'la branche de la tâche est gardée et ses différences archivées');
  const kept = fs.readFileSync(path.join(dirOf('P'), 'notes', 'commun.txt'), 'utf8');
  const winner = /intégrée/.test(rb.out) ? 'claude-haiku-5-5' : 'claude-sonnet-5-5';
  ok(kept.includes(winner) && !g(dirOf('P'), 'status', '--porcelain', '--untracked-files=no').stdout.trim(), `la copie principale garde la version intégrée (${winner}) : rien d’écrasé, pas d’état de fusion`);
  ok(posts.some(p => p.path === '/api/notify' && p.source === 'lane-integration' && /INTÉGRATION EN PAUSE/.test(p.text)), 'le chef est prévenu (notify, source lane-integration)');
  ok(lanesFree('P'), 'les couloirs sont rendus libres après la pause');
}

// ---------------------------------------------------------------------------
section('7. Couloir dont le processus est mort : repris, travail gardé, tour clos');
{
  const dir = laneDir('X', 1);
  g(dir, 'checkout', '-q', '-B', 'lane/1/t-mort', 'master');
  fs.writeFileSync(path.join(dir, 'travail-perdu.txt'), 'en cours\n');
  fs.writeFileSync(path.join(LOGS, 'lanes', 'X', '1.task.json'), JSON.stringify({ task: 't-mort', turn: 't-mort', branch: 'lane/1/t-mort', base: g(dir, 'rev-parse', 'HEAD').stdout.trim(), state: 'running', pid: 999999, lane: 1 }));
  const hold = run(['X', 'Occupe la copie principale'], { ...SLOW });
  await new Promise(r => setTimeout(r, 700));
  const r = await run(['X', 'Tâche après un crash', '--source', 'chef'], {});
  await hold;
  const evs = laneLog('X', 1);
  ok(r.code === 0 && evs.some(e => e.subtype === 'lane_interrupted' && e.task === 't-mort') && evs.some(e => e.type === 'result' && e.subtype === 'error_lane_interrupted'), 'le tour interrompu est clos dans le log du couloir', r.out);
  ok(/travail-perdu\.txt/.test(g(dirOf('X'), 'show', '--stat', '--oneline', 'lane/1/t-mort').stdout), 'son travail est commité sur sa branche, jamais perdu');
}

// ---------------------------------------------------------------------------
section('8. Journal d’activité : les tâches des couloirs et la justification sont visibles');
{
  await import(pathToFileURL(path.join(ROOT, 'public', 'turn-core.js')).href);
  const j = globalThis.TurnCore.createJournal({ max: 500 });
  for (const e of mainLog('P')) j.push(e);
  const turns = j.list();
  const laneTurns = turns.filter(t => t.lane && t.lane.lane > 0);
  ok(laneTurns.some(t => t.outcome === 'ok' && t.versions.includes('1.0.2') && /Tâche C|Tâche B/.test(t.prompt)), 'une tâche de couloir apparaît avec sa demande, son issue et sa version', JSON.stringify(laneTurns.map(t => [t.prompt, t.outcome, t.versions])));
  ok(laneTurns.some(t => t.outcome === 'error' && /conflit/.test(t.summary.join(' '))), 'une intégration en pause apparaît en échec, avec la raison');
  ok(turns.some(t => t.serial?.rule === 'port' && /même port/.test(t.serial.text)), 'le tour retenu porte « ⛓ En série » avec sa règle et sa raison');
  const direct = turns.filter(t => !t.lane || t.lane.lane === 0);
  ok(direct.some(t => /Dialogue direct, lent/.test(t.prompt) && t.outcome === 'ok'), 'les tours du couloir 0 restent intacts dans le journal');
}

// ---------------------------------------------------------------------------
section('9. Branches de tâches terminées : supprimées après une semaine, jamais avant');
{
  // User decision (2026-10-15), verbatim: « On peut eliminer les branches de
  // taches une fois terminees, apres 1 semaine. »
  const L = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lanes.mjs')).href);
  const P = { name: 'P', path: dirOf('P') };
  const ret0 = L.readRetained(LOGS, 'P');
  const paused = mainLog('P').filter(e => e.subtype === 'lane_task' && e.outcome === 'paused').pop()?.branch;
  const latest = Math.max(...ret0.map(e => Date.parse(e.finishedAt)));
  const before = L.pruneRetainedBranches({ logsDir: LOGS, project: P, now: Math.min(...ret0.map(e => Date.parse(e.finishedAt))) + L.BRANCH_RETENTION_MS - 60_000 });
  ok(ret0.length >= 3 && before.deleted.length === 0 && ret0.every(e => g(dirOf('P'), 'rev-parse', '--verify', '-q', e.branch).status === 0),
    `une minute avant la semaine : aucune branche supprimée (${ret0.length} gardées)`, JSON.stringify(before));
  // A retained branch whose tip moved after the end of its task is never deleted.
  const moved = ret0[0].branch;
  g(dirOf('P'), 'branch', '-f', moved, 'master');
  const after = L.pruneRetainedBranches({ logsDir: LOGS, project: P, now: latest + L.BRANCH_RETENTION_MS + 60_000 });
  const exists = (b) => g(dirOf('P'), 'rev-parse', '--verify', '-q', `refs/heads/${b}`).status === 0;
  ok(after.deleted.length === ret0.length - 1 && ret0.slice(1).every(e => !exists(e.branch)), `une minute après la semaine : branches terminées supprimées (${after.deleted.join(', ')})`, JSON.stringify(after));
  ok(after.moved.includes(moved) && exists(moved), 'une branche modifiée depuis la fin de sa tâche est gardée');
  ok(paused && exists(paused) && !ret0.some(e => e.branch === paused), `la branche d’une intégration en pause n’est jamais supprimée (${paused})`);
  ok(L.readRetained(LOGS, 'P').map(e => e.branch).join() === moved, 'le registre ne garde que ce qui reste à surveiller');
  // End to end: a new lane task prunes what is due (retention forced to 0 for the test).
  const due = L.readRetained(LOGS, 'X').map(e => e.branch);
  const hold = run(['X', 'Occupe la copie principale'], { ...SLOW });
  await new Promise(r => setTimeout(r, 700));
  const r = await run(['X', 'Tâche qui déclenche le nettoyage', '--source', 'chef'], { ORCH_LANE_BRANCH_RETENTION_MS: '0', FAKE_CLAUDE_WRITE: 'notes/nettoyage.txt' });
  await hold;
  const pr = mainLog('X').filter(e => e.subtype === 'lane_branches_pruned').pop();
  ok(r.code === 0 && due.length >= 1 && pr && due.every(b => pr.branches.includes(b) && !g(dirOf('X'), 'rev-parse', '--verify', '-q', `refs/heads/${b}`).stdout.trim()),
    `au départ d’une tâche de couloir, les branches échues sont supprimées et tracées (${pr?.branches?.join(', ')})`, r.out + JSON.stringify(due));
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lanes.mjs'), 'prune', 'X', '--dry-run'], { env: { ...baseEnv }, encoding: 'utf8' });
  ok(cli.status === 0 && /gardée\(s\) \(moins d'une semaine\)/.test(cli.stdout), `CLI : lanes.mjs prune --dry-run (${cli.stdout.trim()})`, cli.stderr);
}

srv.close();
for (const p of ['P', 'X']) try { spawnSync('git', ['worktree', 'prune'], { cwd: dirOf(p) }); } catch {}
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
