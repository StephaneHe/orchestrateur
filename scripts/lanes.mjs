#!/usr/bin/env node
// ============================================================================
// scripts/lanes.mjs — lanes: parallel tasks of the SAME musician (0.101.0)
// ============================================================================
//
// Design: docs/PLAN-parallel-tasks-same-musician.md. A lane is an execution
// slot of a musician: a working directory, a turn lock, a log, a session file,
// a .pid. Lane 0 is the musician's own checkout with today's file names
// (logs/<p>.jsonl, .session, .pid, .turnlock). Lanes k ≥ 1 are persistent git
// worktrees under <root>/lanes/<project>/<k> (gitignored), with their files
// under logs/lanes/<project>/<k>.*. A task runs on its own branch
// lane/<k>/<task>, created from the tip of the integration branch (the branch
// checked out in the main checkout), and is integrated back at its end:
// merge of the integration branch into the task branch, release from the
// changelog fragments, fast-forward of the main checkout. Never pushed.
// A finished task's branch is kept one week, then deleted (user decision Q2,
// pruneRetainedBranches); integration is a merge, never a squash (Q3).
//
// `maxParallel` (config.json project entry, else defaults.maxParallel),
// default 2 since 0.103.0 (user decision Q1); 1 = exactly the 0.67.0 behaviour.
//
// CLI:  node scripts/lanes.mjs status <project> [--json]
//       node scripts/lanes.mjs release <project> <lane>   (frees a lane held
//       by a task waiting for an answer; its work stays on its branch)
//       node scripts/lanes.mjs prune <project> [--dry-run]   (deletes finished
//       task branches older than one week; also run at each lane task start
//       and by the server's hourly sweep)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HARD_CAP = 4;
// User decision Q1 (2026-10-15): « Q1: defaut a 2, et on monitore pour verifier
// si on peut passer a 3. » An explicit `maxParallel: 1` keeps the 0.67.0 path.
export const DEFAULT_MAX_PARALLEL = 2;
const EXCLUDED_FROM_COMMIT = ['.orchestrateur-callback.md', '.claude', '.orchestrateur/runs'];

export function maxParallelFor(config, project) {
  const v = Number(project?.maxParallel ?? config?.defaults?.maxParallel ?? DEFAULT_MAX_PARALLEL);
  return Number.isFinite(v) && v >= 1 ? Math.min(HARD_CAP, Math.floor(v)) : 1;
}

/**
 * Directory of lane k. Default `<orchestrator root>/lanes/<project>/<k>`.
 * `lanes.dir` of the project's .orchestrateur/pipeline.json (relative to the
 * project, outside it) moves its lanes, e.g. orchestrateur-dev, whose musician
 * must never write under the production root that dispatches it.
 */
export function laneDir(root, project, k) {
  const name = typeof project === 'string' ? project : project.name;
  const own = typeof project === 'object' && project.path ? laneBase(project.path) : null;
  return own ? path.join(own, String(k)) : path.join(root, 'lanes', name, String(k));
}
export function laneBase(projectPath) {
  const rel = laneConfig(projectPath).lanes?.dir;
  if (typeof rel !== 'string' || !rel.trim() || path.isAbsolute(rel)) return null;
  const base = path.resolve(projectPath, rel);
  const inside = path.relative(path.resolve(projectPath), base);
  return inside === '' || !inside.startsWith('..') ? null : base;          // never inside the repository itself
}

/** Files of a lane. Lane 0 keeps the legacy names, byte for byte. */
export function laneFiles(logsDir, projectName, k) {
  if (!k) return {
    log: path.join(logsDir, `${projectName}.jsonl`), session: path.join(logsDir, `${projectName}.session`),
    pid: path.join(logsDir, `${projectName}.pid`), lock: path.join(logsDir, `${projectName}.turnlock`), task: null,
  };
  const d = path.join(logsDir, 'lanes', projectName);
  return { log: path.join(d, `${k}.jsonl`), session: path.join(d, `${k}.session`), pid: path.join(d, `${k}.pid`),
    lock: path.join(d, `${k}.turnlock`), task: path.join(d, `${k}.task.json`) };
}
export const exclusiveLockFile = (logsDir, p) => path.join(logsDir, `${p}.exclusive`);
export const resourceLockFile = (logsDir, p, key) => path.join(logsDir, 'lanes', p, `res-${String(key).replace(/[^a-z0-9-]/gi, '_')}.lock`);
export const integrateLockFile = (logsDir, p) => path.join(logsDir, `${p}.integrate.lock`);

// ---------- locks (same semantics as the 0.67.0 turn lock) --------------------
export function pidIsAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
export function lockHolder(file, self = process.pid) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Number.isFinite(j.pid) && j.pid !== self && pidIsAlive(j.pid) ? j : null; }
  catch { return null; }
}
/** Exclusive create; a dead owner's lock is taken over. True if held by us. */
export function tryLock(file, info = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...info }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true;   // a lock that cannot be written never blocks a turn
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) return true; } catch {}
      if (lockHolder(file)) return false;
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return false;
}
export function releaseLock(file) {
  try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch {}
}
export function readTask(file) { try { return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; } }
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- git ---------------------------------------------------------------
export function git(dir, args, opts = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, ...opts });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function identityArgs(dir) {
  return git(dir, ['config', 'user.email']).out ? [] : ['-c', 'user.name=orchestrateur', '-c', 'user.email=orchestrateur@localhost'];
}
export function currentBranch(dir) { const r = git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']); return r.ok ? r.out : null; }

/** Lanes reserved by a task waiting for an answer (state input). */
export function reservedLanes(logsDir, projectName, max) {
  const out = [];
  for (let k = 1; k < Math.max(max, HARD_CAP); k++) {
    const t = readTask(laneFiles(logsDir, projectName, k).task);
    if (t && t.state === 'input') out.push(k);
  }
  return out;
}

/**
 * Creates lane k if needed: `git worktree add --detach`, workspace trust (the
 * CLI ignores permissions.allow in an untrusted folder, 0.30.0), provisioning.
 */
export async function ensureLane({ root, project, k, trust = true }) {
  const dir = laneDir(root, project, k);
  const known = fs.existsSync(path.join(dir, '.git'));
  if (!known) {
    git(project.path, ['worktree', 'prune']);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = git(project.path, ['worktree', 'add', '--detach', dir, 'HEAD']);
    if (!r.ok) throw new Error(`git worktree add : ${r.err || r.out}`);
    if (trust) {
      try { (await import('./workspace-trust.mjs')).trustWorkspace(dir); }
      catch (e) { console.error(`[lanes] confiance du dossier ${dir} non posée : ${e.message}`); }
    }
    const reg = path.join(root, 'lanes', project.name, 'lanes.json');
    let j = {}; try { j = JSON.parse(fs.readFileSync(reg, 'utf8')); } catch {}
    j[k] = { lane: k, path: dir, createdAt: new Date().toISOString(), base: git(project.path, ['rev-parse', 'HEAD']).out };
    writeJson(reg, j);
  }
  provisionLane(project.path, dir);
  return { dir, created: !known };
}

/**
 * A worktree has only tracked files. Ignored local files the musician needs
 * (CLAUDE.local.md, .claude/settings*.json, .env*) are copied at every task
 * start; `lanes.copy` / `lanes.link` of .orchestrateur/pipeline.json add more.
 * Only files IGNORED by git are copied: an untracked, non-ignored file would
 * be committed by the integration.
 */
export function provisionLane(mainDir, dir) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(mainDir, '.orchestrateur', 'pipeline.json'), 'utf8')).lanes || {}; } catch {}
  const wanted = new Set(['CLAUDE.local.md', '.claude/settings.json', '.claude/settings.local.json', ...(Array.isArray(cfg.copy) ? cfg.copy : [])]);
  try { for (const f of fs.readdirSync(mainDir)) if (/^\.env/.test(f)) wanted.add(f); } catch {}
  const copied = [];
  for (const rel of wanted) {
    const src = path.join(mainDir, rel);
    if (!/^[\w.\-/]+$/.test(rel) || rel.includes('..') || !fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    if (git(mainDir, ['ls-files', '--error-unmatch', rel]).ok) continue;          // tracked: already in the worktree
    if (!git(mainDir, ['check-ignore', '-q', rel]).ok) continue;                  // untracked and not ignored: never
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(dir, rel));
    copied.push(rel);
  }
  for (const rel of Array.isArray(cfg.link) ? cfg.link : []) {
    const src = path.join(mainDir, rel), dst = path.join(dir, rel);
    if (!/^[\w.\-/]+$/.test(rel) || rel.includes('..') || !fs.existsSync(src) || fs.existsSync(dst)) continue;
    if (!git(mainDir, ['check-ignore', '-q', rel]).ok) continue;
    try { fs.symlinkSync(src, dst, 'junction'); copied.push(`${rel} (lien)`); } catch (e) { console.error(`[lanes] lien ${rel} : ${e.message}`); }
  }
  return copied;
}

/** Archives whatever a lane holds (commits beyond its base, uncommitted changes). */
function archiveLane(logsDir, projectName, dir, name, base) {
  const parts = [];
  if (base) { const d = git(dir, ['diff', '--binary', `${base}`, 'HEAD']); if (d.out) parts.push(d.out); }
  const w = git(dir, ['diff', '--binary', 'HEAD']); if (w.out) parts.push(w.out);
  if (!parts.length) return null;
  const f = path.join(logsDir, 'lanes', projectName, `${name}.diff`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, parts.join('\n') + '\n');
  return f;
}

/** Commits what the task left (local-only files excluded). Returns the new commit or null. */
export function commitLeftovers(dir, message, { verify = false } = {}) {
  commitLeftovers.lastError = '';
  git(dir, ['add', '-A', '--', '.', ...EXCLUDED_FROM_COMMIT.map(p => `:(exclude)${p}`)]);
  if (git(dir, ['diff', '--cached', '--quiet']).ok) return null;
  const r = git(dir, [...identityArgs(dir), 'commit', '-q', ...(verify ? [] : ['--no-verify']), '-m', message]);
  if (!r.ok) { commitLeftovers.lastError = r.err || r.out; return null; }
  return git(dir, ['rev-parse', 'HEAD']).out;
}

/**
 * `lanes.releaseCheck` of .orchestrateur/pipeline.json: argv run in the lane on
 * the release tree (fragments applied, staged) before the release commit, e.g.
 * this repository's targeted regression, so its delivery gate finds a report
 * made on exactly that tree. Placeholders {base} (integration tip) and
 * {version}. Absent ⇒ nothing runs. Output kept in logs/lanes/<p>/<task>.release-check.log.
 */
export function runReleaseCheck(dir, { base, version, logsDir, project, task }) {
  const cfg = laneConfig(dir).lanes || {};
  const argv = cfg.releaseCheck;
  if (!Array.isArray(argv) || !argv.length || !argv.every(a => typeof a === 'string')) return { ok: true, ran: false };
  git(dir, ['add', '-A', '--', '.', ...EXCLUDED_FROM_COMMIT.map(p => `:(exclude)${p}`)]);
  const args = argv.map(a => a.replace(/\{base\}/g, base).replace(/\{version\}/g, version));
  const timeout = (Number(cfg.releaseCheckTimeoutMin) || 45) * 60_000;
  const env = { ...process.env };
  for (const v of ['ORCH_TURN_PROJECT', 'ORCH_TURN_ID', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN']) delete env[v];
  const r = spawnSync(args[0] === 'node' ? process.execPath : args[0], args.slice(1), { cwd: dir, encoding: 'utf8', windowsHide: true, timeout, env, maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  let file = null;
  try { file = path.join(logsDir, 'lanes', project, `${task}.release-check.log`); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `$ ${args.join(' ')}\n${output}`); } catch {}
  if (r.status === 0) return { ok: true, ran: true, output: file };
  return { ok: false, ran: true, code: r.status, output: file, why: r.error ? r.error.message : `code ${r.status}, voir ${file}` };
}

/**
 * Crash recovery: the lane's owner died during a task (killed, crashed). Its
 * work is frozen on the task branch and archived, the turn is closed in the
 * lane log, and the lane is reset. Same pattern as dual-run's recoverInterrupted.
 */
export function recoverLane({ logsDir, project, k, dir }) {
  const files = laneFiles(logsDir, project.name, k);
  const t = readTask(files.task);
  if (!t || t.state !== 'running' || (t.pid && pidIsAlive(t.pid) && t.pid !== process.pid)) return null;
  const diff = archiveLane(logsDir, project.name, dir, `${t.task}.interrupted`, t.base);
  commitLeftovers(dir, `wip(lane): tâche interrompue ${t.task}`);
  git(dir, ['checkout', '-q', '--detach']);
  const at = new Date().toISOString();
  const text = `Tâche ${t.task} interrompue (processus ${t.pid} arrêté) : son travail reste sur la branche ${t.branch}${diff ? `, différences archivées dans ${path.basename(diff)}` : ''}.`;
  fs.appendFileSync(files.log, JSON.stringify({ orch_turn: t.turn || null, type: 'system', subtype: 'lane_interrupted', lane: k, task: t.task, branch: t.branch, diff, text, timestamp: at }) + '\n'
    + JSON.stringify({ orch_turn: t.turn || null, type: 'result', subtype: 'error_lane_interrupted', is_error: true, num_turns: 0, duration_ms: 0, result: text, timestamp: at }) + '\n');
  try { fs.unlinkSync(files.task); } catch {}
  return { task: t.task, branch: t.branch, diff, text };
}

/**
 * Task start in lane k ≥ 1 (lane lock held): a dirty lane is archived and
 * reset, then the task branch is created from the integration tip.
 */
export function startTask({ logsDir, project, k, dir, task, turn, title }) {
  const files = laneFiles(logsDir, project.name, k);
  const intBranch = currentBranch(project.path);
  if (!intBranch) throw new Error('copie principale sans branche (HEAD détachée)');
  const st = git(dir, ['status', '--porcelain']);
  let orphan = null;
  if (st.out) {
    orphan = archiveLane(logsDir, project.name, dir, `${k}-${Date.now()}.orphan`, null);
    git(dir, ['reset', '-q', '--hard']);
    git(dir, ['clean', '-q', '-fd']);
  }
  const base = git(project.path, ['rev-parse', intBranch]).out;
  const branch = `lane/${k}/${task}`;
  const r = git(dir, ['checkout', '-q', '-B', branch, base]);
  if (!r.ok) throw new Error(`git checkout -B ${branch} : ${r.err}`);
  provisionLane(project.path, dir);
  const t = { task, turn, branch, base, integration: intBranch, lane: k, state: 'running', pid: process.pid, title: String(title || '').slice(0, 140), startedAt: new Date().toISOString() };
  writeJson(files.task, t);
  return { ...t, orphan };
}
/** The same task continues (answer to its question): the lane keeps its branch. */
export function resumeTask({ logsDir, project, k, turn }) {
  const files = laneFiles(logsDir, project.name, k);
  const t = readTask(files.task);
  if (!t) return null;
  Object.assign(t, { state: 'running', pid: process.pid, turn, resumedAt: new Date().toISOString() });
  writeJson(files.task, t);
  return t;
}

// ---------- changelog fragments → release -------------------------------------
const BUMPS = { patch: 0, minor: 1, major: 2 };
export function bumpVersion(v, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  if (!m) return null;
  let [a, b, c] = m.slice(1).map(Number);
  if (bump === 'major') { a++; b = 0; c = 0; } else if (bump === 'minor') { b++; c = 0; } else c++;
  return `${a}.${b}.${c}`;
}
/**
 * Fragments of changelog.d/. No front matter or no `bump:` line ⇒ patch,
 * flagged `bumpDefaulted`; a `bump:` with any other value ⇒ `invalid` (the
 * integration pauses rather than guess a version).
 */
export function readFragments(dir) {
  const d = path.join(dir, 'changelog.d');
  let names = []; try { names = fs.readdirSync(d).filter(f => f.endsWith('.md')).sort(); } catch {}
  return names.map(f => {
    const text = fs.readFileSync(path.join(d, f), 'utf8').replace(/\r\n/g, '\n');
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    const declared = fm && /^\s*bump\s*:\s*(\S*)\s*$/m.exec(fm[1])?.[1];
    const bump = declared ? (BUMPS[declared] !== undefined ? declared : null) : 'patch';
    return { file: `changelog.d/${f}`, bump, body: (fm ? text.slice(fm[0].length) : text).trim(),
      ...(declared ? {} : { bumpDefaulted: true }), ...(declared && bump === null ? { invalid: `bump « ${declared} » (attendu : patch, minor ou major)` } : {}) };
  });
}
function laneConfig(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.orchestrateur', 'pipeline.json'), 'utf8')); } catch { return {}; }
}
function versionFilesOf(cfg) { return Array.isArray(cfg.versionFiles) && cfg.versionFiles.length ? cfg.versionFiles : ['package.json']; }
function versionIn(rel, s) {
  const m = /\.json$/.test(rel) ? /"version"\s*:\s*"([^"]+)"/.exec(s) : /versionName\s*=?\s*"([^"]+)"/.exec(s);
  return m ? m[1] : null;
}
/** Bump that takes version a to version b (null when b is not above a). */
export function bumpBetween(a, b) {
  const x = /^(\d+)\.(\d+)\.(\d+)/.exec(String(a || '')), y = /^(\d+)\.(\d+)\.(\d+)/.exec(String(b || ''));
  if (!x || !y) return null;
  const [a1, a2, a3] = x.slice(1).map(Number), [b1, b2, b3] = y.slice(1).map(Number);
  if (b1 !== a1) return b1 > a1 ? 'major' : null;
  if (b2 !== a2) return b2 > a2 ? 'minor' : null;
  return b3 > a3 ? 'patch' : null;
}
/**
 * The text a task added to the CHANGELOG, when it is a plain addition the
 * integrator can turn into a fragment: one new top entry `## [X.Y.Z] - date`
 * (placed above every released entry), or lines added under `## [Unreleased]`.
 * Anything else (an older entry edited, lines removed, two entries) ⇒ null.
 */
export function plainChangelogAddition(before, after) {
  const o = String(before).replace(/\r\n/g, '\n').split('\n'), n = String(after).replace(/\r\n/g, '\n').split('\n');
  let p = 0; while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let s = 0; while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;
  if (p + s !== o.length) return null;                                   // something was changed or removed
  const added = n.slice(p, n.length - s);
  if (!added.some(l => l.trim())) return null;
  if (o.slice(0, p).some(l => /^## \[\d/.test(l))) return null;          // below a released entry
  const heads = added.filter(l => /^## /.test(l));
  if (heads.length === 1 && /^## \[\d+\.\d+\.\d+\]/.test(heads[0]) && added.findIndex(l => l.trim()) === added.indexOf(heads[0])) {
    return { kind: 'entry', version: /^## \[([^\]]+)\]/.exec(heads[0])[1], body: added.slice(added.indexOf(heads[0]) + 1).join('\n').trim() };
  }
  if (heads.length === 0 && o.slice(0, p).some(l => /^## \[Unreleased\]/i.test(l))) return { kind: 'unreleased', version: null, body: added.join('\n').trim() };
  return null;
}
/**
 * Rule « changelog.d » (design §2.8, user decision Q4): a lane task never
 * edits the version nor CHANGELOG.md. Run on the task branch once the
 * integration branch is merged into it (`intTip` = that branch's tip): a
 * direct edit that is a plain addition is converted into a fragment (version
 * fields put back, entry moved to changelog.d/), anything else ⇒ {pause}. A
 * task with changes but no fragment gets a generated patch fragment, so each
 * task stays one versioned release. Never touches the main checkout.
 */
export function enforceChangelogRule(dir, { intTip, task, title }) {
  const cfg = laneConfig(dir);
  const changelogRel = cfg.changelog || 'CHANGELOG.md';
  const show = (rel) => {                       // untrimmed: compared and written back byte for byte
    const r = spawnSync('git', ['show', `${intTip}:${rel}`], { cwd: dir, encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout : null;
  };
  const read = (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
  const touched = new Set(git(dir, ['diff', '--name-only', intTip, 'HEAD']).out.split('\n').filter(Boolean));
  const out = { converted: null, generated: null, edited: [] };
  let taskVersion = null, baseVersion = null;
  const fixes = [];
  for (const rel of versionFilesOf(cfg)) {
    if (!touched.has(rel)) continue;
    const was = show(rel), now = read(rel);
    if (was == null || now == null) continue;
    const a = versionIn(rel, was), b = versionIn(rel, now);
    const codeA = /versionCode\s*=?\s*(\d+)/.exec(was)?.[1], codeB = /versionCode\s*=?\s*(\d+)/.exec(now)?.[1];
    if (a === b && codeA === codeB) continue;                              // other edits of the file are the task's own
    baseVersion = baseVersion || a; taskVersion = taskVersion || b;
    let fixed = /\.json$/.test(rel) ? now.replace(/("version"\s*:\s*")[^"]+(")/, `$1${a}$2`)
      : now.replace(/(versionName\s*=?\s*")[^"]+(")/, `$1${a}$2`);
    if (codeA && codeB) fixed = fixed.replace(/(versionCode\s*=?\s*)\d+/, `$1${codeA}`);
    fixes.push([rel, fixed]); out.edited.push(rel);
  }
  let addition = null;
  if (touched.has(changelogRel)) {
    const was = show(changelogRel) ?? '', now = read(changelogRel) ?? '';
    if (was !== now) {
      addition = plainChangelogAddition(was, now);
      if (!addition) return { ...out, pause: { reason: 'lane-version-edited', why: `la tâche a modifié ${changelogRel} autrement qu'en ajoutant une entrée en tête : l'intégrateur ne peut pas en tirer un fragment (règle changelog.d) ; rien n'est intégré` } };
      fixes.push([changelogRel, was]); out.edited.push(changelogRel);
    }
  }
  const fragments = readFragments(dir);
  const bad = fragments.find(f => f.invalid);
  if (bad) return { ...out, pause: { reason: 'lane-fragment-invalid', why: `fragment ${bad.file} : ${bad.invalid} ; rien n'est intégré` } };
  const slug = String(task).replace(/[^\w.-]/g, '_');
  if (fixes.length) {
    for (const [rel, text] of fixes) fs.writeFileSync(path.join(dir, rel), text);
    const current = baseVersion || versionFilesOf(cfg).map(rel => versionIn(rel, show(rel) || '')).find(Boolean);
    const bump = bumpBetween(current, taskVersion) || bumpBetween(current, addition?.version) || 'patch';
    const body = addition?.body || (fragments.length ? '' : `### Changed\n\n- ${title || task}`);
    if (body) {
      fs.mkdirSync(path.join(dir, 'changelog.d'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'changelog.d', `${slug}-converted.md`), `---\nbump: ${bump}\n---\n\n${body}\n`);
    }
    commitLeftovers(dir, `chore(lane): direct version/CHANGELOG edit turned into a changelog.d fragment (${title || task})`);
    out.converted = { files: out.edited, bump, from: taskVersion || addition?.version || null };
  } else if (!fragments.length && git(dir, ['rev-list', '--count', `${intTip}..HEAD`]).out !== '0') {
    fs.mkdirSync(path.join(dir, 'changelog.d'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'changelog.d', `${slug}.md`),
      `---\nbump: patch\n---\n\n### Changed\n\n- ${title || task} (entry generated by the integrator: the task wrote no changelog.d fragment)\n`);
    commitLeftovers(dir, `chore(lane): changelog.d fragment generated (${title || task})`);
    out.generated = { bump: 'patch' };
  }
  return out;
}
/**
 * Version assigned at integration time (design §2.8): current version of the
 * integration branch + the highest fragment bump; package.json, gradle
 * versionName/versionCode (versionFiles of pipeline.json), CHANGELOG entry;
 * the fragments are deleted. Returns the new version or null (no fragment).
 */
export function applyFragments(dir, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const frags = readFragments(dir);
  if (!frags.length) return null;
  if (frags.some(f => f.invalid)) return null;
  const bump = frags.map(f => f.bump).sort((x, y) => BUMPS[y] - BUMPS[x])[0];
  const cfg = laneConfig(dir);
  const versionFiles = versionFilesOf(cfg);
  let current = null, next = null;
  for (const rel of versionFiles) {
    const f = path.join(dir, rel);
    if (!fs.existsSync(f)) continue;
    let s = fs.readFileSync(f, 'utf8');
    if (/\.json$/.test(rel)) {
      const m = /"version"\s*:\s*"([^"]+)"/.exec(s); if (!m) continue;
      current = current || m[1]; next = next || bumpVersion(current, bump);
      s = s.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
    } else {
      const m = /versionName\s*=?\s*"([^"]+)"/.exec(s); if (!m) continue;
      current = current || m[1]; next = next || bumpVersion(current, bump);
      s = s.replace(/(versionName\s*=?\s*")[^"]+(")/, `$1${next}$2`).replace(/(versionCode\s*=?\s*)(\d+)/, (x, p, n) => `${p}${Number(n) + 1}`);
    }
    fs.writeFileSync(f, s);
  }
  if (!next) return null;
  const changelog = path.join(dir, cfg.changelog || 'CHANGELOG.md');
  const entry = `## [${next}] - ${date}\n\n${frags.map(f => f.body).join('\n\n')}\n\n`;
  let cl = ''; try { cl = fs.readFileSync(changelog, 'utf8'); } catch {}
  const at = cl.search(/^## \[\d/m);
  fs.writeFileSync(changelog, at === -1 ? `${cl.replace(/\s*$/, '\n\n')}${entry}` : cl.slice(0, at) + entry + cl.slice(at));
  for (const f of frags) fs.rmSync(path.join(dir, f.file), { force: true });
  return { version: next, bump, fragments: frags.map(f => f.file) };
}

// ---------- retention of finished task branches (user decision Q2) -----------
// « On peut eliminer les branches de taches une fois terminees, apres 1
// semaine. » A finished task's branch (integrated, or nothing to integrate) is
// recorded with its tip and deleted by pruneRetainedBranches once a week has
// passed — never before, never a paused/abandoned task's branch (not recorded),
// never a branch whose tip moved since (someone kept working on it). No tags.
export const BRANCH_RETENTION_MS = 7 * 24 * 3600_000;
export const retainedBranchesFile = (logsDir, p) => path.join(logsDir, 'lanes', p, 'retained-branches.json');
export function readRetained(logsDir, p) {
  try { const j = JSON.parse(fs.readFileSync(retainedBranchesFile(logsDir, p), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}
function retentionMs() {
  const v = Number(process.env.ORCH_LANE_BRANCH_RETENTION_MS);   // tests only
  return Number.isFinite(v) && v >= 0 && process.env.ORCH_LANE_BRANCH_RETENTION_MS !== '' ? v : BRANCH_RETENTION_MS;
}
export function retainBranch(logsDir, p, entry) {
  const list = readRetained(logsDir, p).filter(e => e.branch !== entry.branch);
  list.push(entry);
  writeJson(retainedBranchesFile(logsDir, p), list);
}
/** Deletes the retained branches older than the retention. Returns {deleted, kept, moved, gone}. */
export function pruneRetainedBranches({ logsDir, project, now = Date.now(), retention = retentionMs(), dryRun = false }) {
  const out = { deleted: [], kept: [], moved: [], gone: [] };
  const list = readRetained(logsDir, project.name);
  if (!list.length) return out;
  const remaining = [];
  for (const e of list) {
    const age = now - Date.parse(e.finishedAt);
    if (!(age >= retention)) { out.kept.push(e.branch); remaining.push(e); continue; }
    const tip = git(project.path, ['rev-parse', '-q', '--verify', `refs/heads/${e.branch}`]);
    if (!tip.ok) { out.gone.push(e.branch); continue; }
    if (tip.out !== e.tip) { out.moved.push(e.branch); remaining.push({ ...e, moved: true }); continue; }
    if (dryRun) { out.deleted.push(e.branch); remaining.push(e); continue; }
    const d = git(project.path, ['branch', '-q', '-D', e.branch]);
    if (d.ok) out.deleted.push(e.branch); else { out.kept.push(e.branch); remaining.push(e); }
  }
  if (!dryRun && (out.deleted.length || out.gone.length || out.moved.length)) writeJson(retainedBranchesFile(logsDir, project.name), remaining);
  return out;
}

// ---------- end of task: integration ----------------------------------------
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Integrates the task of lane k into the integration branch. Synchronous (it
 * runs in dispatch.mjs after the turn, lane lock still held). Never pushes,
 * never stashes nor overwrites the user's work, never resolves a conflict by
 * -X ours/theirs: a conflict keeps the branch and pauses (design §1.4).
 *
 * outcome: 'input' (question: lane kept for the answer) | 'nothing' |
 *          'integrated' | 'paused'
 */
export function finishTask({ logsDir, project, k, dir, turnEnd, title, log = () => {}, waitMs = Number(process.env.ORCH_LANE_INTEGRATE_WAIT_MS) || 30 * 60_000 }) {
  const files = laneFiles(logsDir, project.name, k);
  const t = readTask(files.task);
  if (!t) return { outcome: 'nothing', why: 'aucune tâche' };
  if (turnEnd === 'input') {
    commitLeftovers(dir, `wip(lane): ${title || t.title || t.task}`);
    Object.assign(t, { state: 'input', pid: null, pausedAt: new Date().toISOString() });
    writeJson(files.task, t);
    return { outcome: 'input', task: t.task, branch: t.branch };
  }
  commitLeftovers(dir, `${turnEnd === 'error' ? 'wip(lane)' : 'chore(lane)'}: ${title || t.title || t.task}`);
  const ahead = git(dir, ['rev-list', '--count', `${t.base}..HEAD`]).out;
  const finish = (outcome, extra = {}) => {
    git(dir, ['checkout', '-q', '--detach']);
    if (outcome === 'integrated' || outcome === 'nothing') {
      const tip = git(project.path, ['rev-parse', `refs/heads/${t.branch}`]).out;
      if (tip) {
        const finishedAt = new Date().toISOString();
        retainBranch(logsDir, project.name, { branch: t.branch, task: t.task, title: t.title || '', outcome, tip, finishedAt,
          deleteAfter: new Date(Date.parse(finishedAt) + retentionMs()).toISOString() });
      }
    }
    try { fs.unlinkSync(files.task); } catch {}
    return { outcome, task: t.task, branch: t.branch, ...extra };
  };
  if (ahead === '0') return finish('nothing', { why: 'aucune modification' });
  if (turnEnd === 'error') {
    const diff = archiveLane(logsDir, project.name, dir, t.task, t.base);
    return finish('paused', { reason: 'turn-error', diff, why: `le tour a échoué : rien n'est intégré, le travail reste sur la branche ${t.branch}` });
  }

  const lockF = integrateLockFile(logsDir, project.name);
  const t0 = Date.now();
  while (!tryLock(lockF, { lane: k, task: t.task })) {
    if (Date.now() - t0 > waitMs) return finish('paused', { reason: 'integrate-lock', diff: archiveLane(logsDir, project.name, dir, t.task, t.base), why: 'intégration d’une autre tâche toujours en cours' });
    sleepSync(500);
  }
  try {
    log({ type: 'system', subtype: 'lane_integrate_start', lane: k, task: t.task, branch: t.branch, integration: t.integration });
    // Rule changelog.d (user decision Q4), applied on the task's own changes
    // BEFORE merging the integration branch, so a direct version/CHANGELOG
    // edit never conflicts with releases integrated meanwhile: converted into
    // a fragment, or paused; a task without fragment gets one.
    const rule = enforceChangelogRule(dir, { intTip: git(dir, ['merge-base', 'HEAD', t.integration]).out, task: t.task, title: title || t.title });
    if (rule.pause) {
      log({ type: 'system', subtype: 'lane_version_rule', lane: k, task: t.task, paused: rule.pause.reason, why: rule.pause.why });
      return finish('paused', { ...rule.pause, diff: archiveLane(logsDir, project.name, dir, t.task, t.base) });
    }
    const versionEdited = !!rule.converted;
    if (rule.converted || rule.generated) log({ type: 'system', subtype: 'lane_version_rule', lane: k, task: t.task, ...(rule.converted ? { converted: rule.converted } : { generated: rule.generated }) });
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (currentBranch(project.path) !== t.integration) {
        return finish('paused', { reason: 'integration-branch-changed', diff: archiveLane(logsDir, project.name, dir, t.task, t.base),
          why: `la copie principale n'est plus sur ${t.integration}` });
      }
      const m = git(dir, [...identityArgs(dir), 'merge', '--no-edit', '-q', t.integration]);
      if (!m.ok) {
        const conflicted = git(dir, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
        git(dir, ['merge', '--abort']);
        log({ type: 'system', subtype: 'lane_conflict', lane: k, task: t.task, files: conflicted });
        return finish('paused', { reason: 'conflict', files: conflicted, diff: archiveLane(logsDir, project.name, dir, t.task, t.base),
          why: `conflit avec le travail déjà intégré (${conflicted.join(', ') || m.err.slice(0, 200)})` });
      }
      const mb = git(dir, ['merge-base', 'HEAD', t.integration]).out;
      // The release is made on the merged tree, just before the fast-forward, so
      // versions strictly increase in integration order; undone if the ff fails.
      const release = applyFragments(dir);
      if (release) {
        const check = runReleaseCheck(dir, { base: mb, version: release.version, logsDir, project: project.name, task: t.task });
        if (!check.ok) {
          git(dir, ['reset', '-q', '--hard']);
          log({ type: 'system', subtype: 'lane_release_check', lane: k, task: t.task, ok: false, code: check.code, output: check.output });
          return finish('paused', { reason: 'release-check', diff: archiveLane(logsDir, project.name, dir, t.task, t.base), why: `contrôle de release en échec (${check.why}) ; rien n'est intégré` });
        }
        if (check.ran) log({ type: 'system', subtype: 'lane_release_check', lane: k, task: t.task, ok: true, output: check.output });
        // Hooks run on the release commit (e.g. this repository's delivery gate).
        const c = commitLeftovers(dir, `chore(release): v${release.version} (${title || t.title || t.task})`, { verify: true });
        if (!c) {
          const why = commitLeftovers.lastError || 'commit de version impossible';
          git(dir, ['reset', '-q', '--hard']);
          return finish('paused', { reason: 'release-commit', diff: archiveLane(logsDir, project.name, dir, t.task, t.base), why: `commit de version refusé : ${why.slice(0, 400)}` });
        }
      }
      const ff = git(project.path, ['merge', '--ff-only', '-q', t.branch]);
      if (ff.ok) {
        const commit = git(project.path, ['rev-parse', '--short', 'HEAD']).out;
        log({ type: 'system', subtype: 'lane_integrated', lane: k, task: t.task, commit, version: release?.version || null, ...(versionEdited ? { versionEdited: true } : {}) });
        return finish('integrated', { commit, version: release?.version || null, versionEdited });
      }
      if (release) git(dir, ['reset', '-q', '--hard', 'HEAD~1']);
      // The integration branch moved meanwhile: merge again. The main checkout has
      // local changes on files the task touched: wait for lane 0's turn, never stash.
      const moved = git(project.path, ['rev-parse', t.integration]).out !== mb;
      if (!moved) {
        const holder = lockHolder(laneFiles(logsDir, project.name, 0).lock);
        if (!holder || attempt === 3) {
          return finish('paused', { reason: 'main-dirty', diff: archiveLane(logsDir, project.name, dir, t.task, t.base),
            why: `la copie principale a des modifications locales sur les fichiers de la tâche (${ff.err.slice(0, 200)}) ; rien n'est écrasé` });
        }
        const w0 = Date.now();
        while (lockHolder(laneFiles(logsDir, project.name, 0).lock) && Date.now() - w0 < waitMs) sleepSync(1000);
      }
    }
    return finish('paused', { reason: 'retries', diff: archiveLane(logsDir, project.name, dir, t.task, t.base), why: 'la branche d’intégration bouge sans cesse' });
  } finally { releaseLock(lockF); }
}

// ---------- status (API, CLI) -------------------------------------------------
export function lanesStatus({ root, logsDir, config, project }) {
  const max = maxParallelFor(config, project);
  const lanes = [];
  for (let k = 0; k < Math.max(max, 1); k++) {
    const f = laneFiles(logsDir, project.name, k);
    const holder = lockHolder(f.lock, -1);
    const task = readTask(f.task);
    lanes.push({ lane: k, dir: k ? laneDir(root, project, k) : project.path, exists: k ? fs.existsSync(laneDir(root, project, k)) : true,
      busy: !!holder, turn: holder?.turn || null, pid: holder?.pid || null, task: task ? { id: task.task, title: task.title, branch: task.branch, state: task.state, startedAt: task.startedAt } : null });
  }
  const resources = [];
  try {
    for (const f of fs.readdirSync(path.join(logsDir, 'lanes', project.name)).filter(f => /^res-.*\.lock$/.test(f))) {
      const h = lockHolder(path.join(logsDir, 'lanes', project.name, f), -1);
      if (h) resources.push({ resource: f.replace(/^res-|\.lock$/g, ''), rule: h.rule || null, pid: h.pid, turn: h.turn || null });
    }
  } catch {}
  const ex = lockHolder(exclusiveLockFile(logsDir, project.name), -1);
  const retainedBranches = readRetained(logsDir, project.name).map(e => ({ branch: e.branch, task: e.task, title: e.title, outcome: e.outcome, finishedAt: e.finishedAt, deleteAfter: e.deleteAfter, ...(e.moved ? { moved: true } : {}) }));
  return { project: project.name, maxParallel: max, running: lanes.filter(l => l.busy).length, lanes, resources, retainedBranches,
    exclusive: ex ? { rule: ex.rule || null, text: ex.text || null, pid: ex.pid, turn: ex.turn || null } : null };
}

// ---------- CLI ---------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const LOGS = path.join(ROOT, 'logs');
  const [cmd, name, laneArg] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const project = config.projects.find(p => p.name === name);
  if (!project || !['status', 'release', 'prune'].includes(cmd)) { console.error('usage: node scripts/lanes.mjs status <projet> [--json] | release <projet> <couloir> | prune <projet> [--dry-run]'); process.exit(64); }
  if (cmd === 'prune') {
    const r = pruneRetainedBranches({ logsDir: LOGS, project, dryRun: process.argv.includes('--dry-run') });
    console.log(`${project.name} : ${r.deleted.length} branche(s) ${process.argv.includes('--dry-run') ? 'à supprimer' : 'supprimée(s)'}${r.deleted.length ? ` (${r.deleted.join(', ')})` : ''}, ${r.kept.length} gardée(s) (moins d'une semaine)${r.moved.length ? `, ${r.moved.length} gardée(s) car modifiée(s) depuis la fin de la tâche (${r.moved.join(', ')})` : ''}`);
  } else if (cmd === 'status') {
    const s = lanesStatus({ root: ROOT, logsDir: LOGS, config, project });
    if (process.argv.includes('--json')) console.log(JSON.stringify(s, null, 2));
    else {
      console.log(`${s.project} : ${s.running}/${s.maxParallel} couloir(s) occupé(s)${s.exclusive ? ` — tâche seule en cours (règle ${s.exclusive.rule})` : ''}`);
      for (const l of s.lanes) console.log(`  #${l.lane} ${l.busy ? 'occupé' : 'libre'}${l.task ? ` — ${l.task.state} « ${l.task.title} » (${l.task.branch})` : ''}`);
      for (const r of s.resources) console.log(`  ressource ${r.resource} tenue (règle ${r.rule})`);
      for (const b of s.retainedBranches) console.log(`  branche terminée ${b.branch} — supprimée après ${b.deleteAfter}${b.moved ? ' (modifiée depuis : gardée)' : ''}`);
    }
  } else {
    const k = Number(laneArg);
    if (!(k >= 1)) { console.error('couloir ≥ 1 attendu'); process.exit(64); }
    const f = laneFiles(LOGS, project.name, k);
    if (!tryLock(f.lock, { by: 'lanes.mjs release' })) { console.error(`couloir ${k} occupé par un tour`); process.exit(2); }
    const t = readTask(f.task);
    if (!t) { releaseLock(f.lock); console.log(`couloir ${k} : aucune tâche`); process.exit(0); }
    const dir = laneDir(ROOT, project, k);
    commitLeftovers(dir, `wip(lane): ${t.title || t.task}`);
    git(dir, ['checkout', '-q', '--detach']);
    fs.unlinkSync(f.task);
    releaseLock(f.lock);
    console.log(`couloir ${k} libéré ; le travail de « ${t.title || t.task} » reste sur la branche ${t.branch}`);
  }
}
