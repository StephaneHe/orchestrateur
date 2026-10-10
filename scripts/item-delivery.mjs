// ============================================================================
// scripts/item-delivery.mjs — per-item delivery of the full Development (0.64.0)
// ============================================================================
//
// User decision « c+d », part c: « Livraison par item : chaque item est relu et
// livré séparément, dans son propre commit. Un défaut ne bloque que son item ».
// Atomic task 4: once an item (and the cases its Review attached to it) passes
// its own Review, the engine commits it at once; an item that hits one of its
// own limits is SET ASIDE (its changes saved as a patch and removed from the
// work tree) so the other items go on and are delivered; set-aside items are
// put back, one at a time, when the user answers « continuer ».
//
// Everything here is git plumbing run by the engine itself — never by a model.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { worktreeTree } from './item-review.mjs';

const EXCLUDES = [':(exclude).orchestrateur/runs', ':(exclude).claude'];
// Never delivered (run artefacts, local CLI settings) — same rule as isLocalOnly.
const LOCAL_ONLY = ['.orchestrateur/runs', '.claude'];

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, ''), err: (r.stderr || '').trim() };
}

export const head = (cwd) => git(cwd, ['rev-parse', 'HEAD']).out;

/** Folds any commit made after `commit` (dual-mode checkpoints) back into the work tree, index cleared. */
export function foldTo(cwd, commit) {
  if (commit && head(cwd) !== commit) git(cwd, ['reset', '-q', '--soft', commit]);
  git(cwd, ['reset', '-q']);
}

// The engine commits even when the project has no git identity configured.
function identity(cwd) {
  return git(cwd, ['config', 'user.email']).out ? [] : ['-c', 'user.name=orchestrateur', '-c', 'user.email=orchestrateur@localhost'];
}

/**
 * Commits everything in the work tree except local-only paths.
 * → {ok:true, commit} | {ok:true, empty:true} | {ok:false, err}
 */
export function commitWork(cwd, message) {
  const add = git(cwd, ['add', '-A']);
  if (!add.ok) return { ok: false, err: add.err || 'git add a échoué' };
  // One call per path: a pathspec unknown to the index makes the whole call fail.
  for (const p of LOCAL_ONLY) git(cwd, ['restore', '-q', '--staged', '--', p]);
  if (git(cwd, ['diff', '--cached', '--quiet']).ok) return { ok: true, empty: true };
  const c = git(cwd, [...identity(cwd), 'commit', '-q', '-m', message]);
  if (!c.ok) { git(cwd, ['reset', '-q']); return { ok: false, err: c.err || c.out || 'git commit a échoué' }; }
  return { ok: true, commit: head(cwd) };
}

/** Commit message of a delivered item (English, the item text kept verbatim). */
export function itemCommitMessage({ group, text, run, cases }) {
  const subject = group === 0
    ? 'feat: work done before switching to the full Development'
    : `feat(item ${group}): ${String(text || '').replace(/\(\s*tests?\s*:\s*\d+\s*\)\s*/i, '').replace(/\s+/g, ' ').trim()}`;
  const extra = cases > 1 ? `\n\nIncludes ${cases - 1} case(s) attached by its review.` : '';
  return `${subject.slice(0, 120)}${extra}\n\nPipeline run ${run} — full Development, delivered item by item.`;
}

/**
 * Sets the current work aside: saves `from → now` as a patch and puts the
 * changed files back as in `from` (only those files). `from` is the last
 * delivered commit. → {ok, patch, files, tree} | {ok:false, err}
 */
export function setAsideWork(cwd, { from, indexFile, patchFile }) {
  foldTo(cwd, from);
  const tree = worktreeTree(cwd, indexFile);
  if (!tree) return { ok: false, err: 'arbre de travail illisible (git)' };
  const fromTree = git(cwd, ['rev-parse', `${from}^{tree}`]).out;
  const diff = git(cwd, ['diff', '--binary', '--full-index', '--no-renames', fromTree, tree, '--', '.', ...EXCLUDES]);
  if (!diff.ok) return { ok: false, err: diff.err };
  fs.mkdirSync(path.dirname(patchFile), { recursive: true });
  fs.writeFileSync(patchFile, diff.out ? `${diff.out}\n` : '');
  const files = git(cwd, ['diff', '--name-status', '--no-renames', fromTree, tree, '--', '.', ...EXCLUDES]).out
    .split('\n').filter(Boolean).map(l => { const [st, ...f] = l.split('\t'); return { status: st[0], file: f.join('\t') }; });
  for (const { status, file } of files) {
    if (status === 'A') { try { fs.rmSync(path.join(cwd, file), { force: true }); } catch {} continue; }
    git(cwd, ['checkout', from, '--', file]);
  }
  git(cwd, ['reset', '-q']);
  return { ok: true, patch: patchFile, files: files.map(f => f.file), tree };
}

/** Puts a set-aside patch back on the work tree (3-way merge with the work delivered since). */
export function reapplyWork(cwd, patchFile) {
  let size = 0; try { size = fs.statSync(patchFile).size; } catch { return { ok: false, err: `correctif introuvable : ${patchFile}` }; }
  if (!size) return { ok: true, empty: true };
  if (git(cwd, ['apply', '--check', '--whitespace=nowarn', patchFile]).ok) {
    const a = git(cwd, ['apply', '--whitespace=nowarn', patchFile]);
    return a.ok ? { ok: true } : { ok: false, err: a.err || 'git apply a échoué' };
  }
  const a = git(cwd, ['apply', '--3way', '--whitespace=nowarn', patchFile]);
  git(cwd, ['reset', '-q']);
  if (a.ok) return { ok: true, merged: true };
  // Conflict: the work tree is put back as it was, the patch stays on disk.
  const files = [...fs.readFileSync(patchFile, 'utf8').matchAll(/^diff --git a\/(.+?) b\//gm)].map(m => m[1]);
  for (const f of files) {
    if (git(cwd, ['cat-file', '-e', `HEAD:${f}`]).ok) git(cwd, ['checkout', 'HEAD', '--', f]);
    else { try { fs.rmSync(path.join(cwd, f), { force: true }); } catch {} }
  }
  git(cwd, ['reset', '-q']);
  return { ok: false, conflict: true, err: a.err || a.out || 'conflit en réappliquant le correctif' };
}
