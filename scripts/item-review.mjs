// ============================================================================
// scripts/item-review.mjs — per-item Review of the full Development (0.63.0)
// ============================================================================
//
// User decision « c+d » (2026-10-10), part c: « chaque item est relu et livré
// séparément […] Un défaut ne bloque que son item ». Atomic task 3 = the Review
// only: right after an item's 4a/4b/4c loop, the Review reads the diff of THAT
// item, never the whole run; a defect becomes a test-list case attached to that
// item, and the review rounds limit is counted per item.
//
// Groups: an item and the cases a review attached to it form one group, keyed
// by the item's number. An attached case reads « - [ ] (revue item K) … ». It
// is inserted right after the group's last case, so it is handled before the
// next items and never shifts the number of an item already started.
//
// Diff of a group: a git tree of the working directory is written when the
// group starts and again at review time (a private index under the run
// directory: the project's index is never touched), and the Review receives
// `git diff <start> <now>` — nothing done by another item.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ATTACHED_RE = /\(\s*revue\s+item\s+(\d+)\s*\)/i;

/** Group of a test-list case: the item a review attached it to, else itself. */
export function groupOf(item) {
  const m = ATTACHED_RE.exec(String(item?.text || ''));
  return m ? Number(m[1]) : item?.n;
}

/** Cases of group `g`, in order. */
export function groupCases(items, g) {
  return items.filter(i => groupOf(i) === g);
}

/** The group is reviewed once none of its cases is left open. */
export function groupReady(items, g) {
  return !groupCases(items, g).some(i => !i.done);
}

/** Line text of a case attached to item `g` by its review. */
export function attachedCase(g, text) {
  return `- [ ] (revue item ${g}) ${String(text).replace(/\s+/g, ' ').trim().slice(0, 300)}`;
}

/**
 * Inserts the review's defects of group `g` right after the group's last case
 * of tests.md. A group without any line (group 0: the light work of an
 * escalated run, reviewed before any item starts) gets them before the first
 * open case, so they are handled first; at the end when nothing is open.
 */
export function insertAttachedCases(md, g, defects) {
  const lines = String(md || '').replace(/\s*$/, '').split(/\r?\n/);
  const add = defects.map(d => attachedCase(g, d));
  let n = 0, lastLine = -1, firstOpen = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    n++;
    if (groupOf({ n, text: m[2] }) === g) lastLine = i;
    if (m[1] === ' ' && firstOpen < 0) firstOpen = i;
  }
  const at = lastLine >= 0 ? lastLine + 1 : firstOpen >= 0 ? firstOpen : lines.length;
  return [...lines.slice(0, at), ...add, ...lines.slice(at)].join('\n') + '\n';
}

// Paths never part of a delivery (run artefacts, local CLI settings): kept out
// of the item's diff like everywhere else in the engine.
const EXCLUDES = [':(exclude).orchestrateur/runs', ':(exclude).claude'];

function git(cwd, args, env) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, ''), err: (r.stderr || '').trim() };
}

/**
 * Git tree of the working directory as it is now (tracked + untracked, not
 * ignored), through a private index kept in `indexFile`. Returns null when
 * the directory is not a git work tree or git fails.
 */
export function worktreeTree(cwd, indexFile) {
  const env = { GIT_INDEX_FILE: path.resolve(indexFile) };
  if (!fs.existsSync(env.GIT_INDEX_FILE)) {
    fs.mkdirSync(path.dirname(env.GIT_INDEX_FILE), { recursive: true });
    // Seeded from HEAD so later `add -A` only rehashes what changed.
    if (!git(cwd, ['read-tree', 'HEAD'], env).ok) git(cwd, ['read-tree', '--empty'], env);
  }
  // No exclude pathspec here: `add` fails on a pathspec that is already
  // ignored (run artefacts usually are); local-only paths are dropped after.
  if (!git(cwd, ['add', '-A'], env).ok) return null;
  git(cwd, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.orchestrateur/runs', '.claude'], env);
  const t = git(cwd, ['write-tree'], env);
  return t.ok && /^[0-9a-f]{40,64}$/.test(t.out) ? t.out : null;
}

/** Unified diff between two trees (null when git fails). */
export function treeDiff(cwd, from, to) {
  const d = git(cwd, ['diff', '--no-color', from, to, '--', '.', ...EXCLUDES]);
  return d.ok ? d.out : null;
}
