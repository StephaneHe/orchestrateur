// ============================================================================
// scripts/regression-targets.mjs — targeted non-regression selection (0.72.0)
// ============================================================================
//
// User request (2026-10-11, verbatim): « Implemente une Non-régression ciblée
// pendant le développement, et la complète seulement avant une mise en prod ».
//
// Deterministic selection from the changed files:
//   - a suite covers the files it NAMES (any string such as 'dispatch.mjs' or
//     an import specifier), plus everything its own imports import,
//     transitively — following real `import` statements only, so a hub file
//     merely mentioned in code does not drag the whole repository in;
//   - the HTTP stage covers server.js, the sandbox and the test doubles, the
//     files they name, and their import closure; the browser stage covers
//     public/** and the browser checks (plus server.js itself);
//   - documentation (*.md, docs/**) and a version-only package.json need
//     nothing beyond the always-run base;
//   - a changed file covered by nothing → the FULL run (never a silent gap);
//   - a change to the non-regression tooling (TOOLING_FILES) → the suites that
//     cover it plus TOOLING_SUITES, never the full run (0.73.0, user decision
//     "B"); only a dependency change (FULL_TRIGGERS) still needs the full run;
//   - the base (BASE_SUITES) always runs.
// The full run stays mandatory before production (scripts/prod-jump.mjs).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Fast suites always run in targeted mode (a few seconds in total). */
export const BASE_SUITES = ['_test_repo_hygiene.mjs', '_test_user_requirements.mjs', '_test_delivery_gate.mjs', '_test_targeted_regression.mjs'];
/** Entry points of the HTTP stage (regression.mjs apiChecks on a sandboxed server). */
export const HTTP_ROOTS = ['server.js', 'scripts/_regression_sandbox.mjs', 'tests/fake_claude/fake_claude.mjs', 'tests/fake_codex/fake_codex.mjs'];
/** The browser stage runs when one of these changes (or anything under public/). */
export const BROWSER_ROOTS = ['scripts/_regression_browser.mjs', 'server.js'];
/** Changes that always need the full run (dependencies). */
export const FULL_TRIGGERS = ['package-lock.json'];
/**
 * The non-regression tooling itself (0.73.0, user decision "B"): a change runs
 * the suites that cover it, plus TOOLING_SUITES, never the full run.
 * regression.mjs also defines the HTTP checks, so it brings the HTTP stage.
 */
export const TOOLING_FILES = ['scripts/regression.mjs', 'scripts/regression-targets.mjs', 'scripts/suite-runner.mjs', 'scripts/delivery-gate.mjs', 'scripts/prod-jump.mjs'];
export const TOOLING_SUITES = ['_test_failed_suite_output.mjs', '_test_targeted_regression.mjs', '_test_delivery_gate.mjs'];
/**
 * Outside the non-regression scope (0.73.2, user decision 2026-10-12: "Dissocier
 * les code Android des tests, vu qu'aucun ne lui correspondent"): no suite of the
 * full run tests the Android app, so a change there selects nothing and never
 * triggers the full run.
 */
export const OUT_OF_SCOPE = [{ re: /^android\//, reason: 'code Android : hors périmètre de la non-régression' }];
const DOC_RE = /(^docs\/|\.md$|^\.gitignore$|^LICENSE)/i;
const CODE_RE = /\.(mjs|js|cjs)$/i;
const REF_RE = /[\w.-]+\.(?:mjs|cjs|js|json|html|css)\b/g;
// Real module imports: `from 'x'`, `import 'x'`, dynamic `import('x')`.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"`]([^'"`\n]+\.(?:mjs|cjs|js))['"`]/g;

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '') : '';
}

/** Tracked + untracked (not ignored) files, forward slashes. */
export function repoFiles(repo) {
  return [...new Set(git(repo, ['ls-files', '-co', '--exclude-standard']).split('\n').map(s => s.trim()).filter(Boolean))];
}

/** Files changed against `since` (default HEAD: the uncommitted work), untracked included. */
export function changedFiles(repo, since = 'HEAD') {
  const diff = git(repo, ['diff', '--name-only', since]).split('\n');
  const untracked = git(repo, ['ls-files', '-o', '--exclude-standard']).split('\n');
  return [...new Set([...diff, ...untracked].map(s => s.trim()).filter(Boolean))].sort();
}

/** file → { mentions: Set<file>, imports: Set<file> } for every code file. */
export function referenceGraph(repo, files = repoFiles(repo)) {
  const set = new Set(files);
  const byBase = new Map();
  for (const f of files) { const b = path.posix.basename(f); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(f); }
  const graph = new Map();
  for (const f of files) {
    if (!CODE_RE.test(f)) continue;
    let src = '';
    try { src = fs.readFileSync(path.join(repo, f), 'utf8'); } catch { continue; }
    const mentions = new Set(), imports = new Set();
    for (const m of src.matchAll(REF_RE)) for (const t of byBase.get(m[0]) || []) if (t !== f) mentions.add(t);
    for (const m of src.matchAll(IMPORT_RE)) {
      if (!m[1].startsWith('.')) continue; // packages are not repository files
      const t = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (set.has(t)) imports.add(t);
    }
    graph.set(f, { mentions, imports });
  }
  return graph;
}

/** Import closure of `roots` (roots included). */
export function importClosure(graph, roots) {
  const seen = new Set(roots), stack = [...roots];
  while (stack.length) {
    const f = stack.pop();
    for (const r of graph.get(f)?.imports || []) if (!seen.has(r)) { seen.add(r); stack.push(r); }
  }
  return seen;
}

/** What a root covers: itself, the files it names, and the import closure of its own imports. */
export function coverageOf(graph, root) {
  const node = graph.get(root) || { mentions: new Set(), imports: new Set() };
  return new Set([root, ...node.mentions, ...importClosure(graph, [...node.imports])]);
}

/** True when package.json differs from `since` only by its "version" field. */
export function versionOnlyPackageChange(repo, since = 'HEAD') {
  let before = null, after = null;
  try { before = JSON.parse(git(repo, ['show', `${since}:package.json`])); } catch { return false; }
  try { after = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); } catch { return false; }
  delete before.version; delete after.version;
  return JSON.stringify(before) === JSON.stringify(after);
}

/**
 * Selection for a set of changed files.
 * → { full: false, suites: [{file, reasons}], http, browser, reasons: {http, browser}, docsOnly, outOfScope: [{file, reason}] }
 *   | { full: true, reason }
 */
export function selectTargets(repo, changed, { since = 'HEAD', files = repoFiles(repo) } = {}) {
  const graph = referenceGraph(repo, files);
  const suites = files.filter(f => /^scripts\/_test_[^/]+\.mjs$/.test(f));
  const coverage = new Map(suites.map(s => [s, coverageOf(graph, s)]));
  const httpCover = new Set(HTTP_ROOTS.filter(f => files.includes(f)).flatMap(r => [...coverageOf(graph, r), ...importClosure(graph, [r])]));
  const picked = new Map();
  const add = (s, why) => { const k = path.posix.basename(s); if (!picked.has(k)) picked.set(k, new Set()); picked.get(k).add(why); };
  for (const b of BASE_SUITES) if (suites.some(s => s.endsWith(`/${b}`))) add(b, 'socle (toujours exécuté)');
  let http = false, browser = false;
  const httpWhy = new Set(), browserWhy = new Set(), docsOnly = [], outOfScope = [];
  for (const f of changed) {
    const oos = OUT_OF_SCOPE.find(o => o.re.test(f));
    if (oos) { outOfScope.push({ file: f, reason: oos.reason }); continue; }
    if (FULL_TRIGGERS.includes(f)) return { full: true, reason: `${f} modifié (dépendances)` };
    if (TOOLING_FILES.includes(f)) {
      for (const s of TOOLING_SUITES) if (suites.some(x => x.endsWith(`/${s}`))) add(s, `outillage de la non-régression : ${f}`);
      if (f === 'scripts/regression.mjs') { http = true; httpWhy.add(`${f} (définit les parcours HTTP)`); }
    }
    if (f === 'package.json') {
      if (versionOnlyPackageChange(repo, since)) { docsOnly.push(f); continue; }
      return { full: true, reason: 'package.json modifié au-delà du numéro de version (dépendances, scripts)' };
    }
    if (DOC_RE.test(f)) { docsOnly.push(f); continue; }
    let covered = TOOLING_FILES.includes(f);   // its TOOLING_SUITES were added above
    for (const [s, cov] of coverage) if (cov.has(f)) { add(s, `couvre ${f}`); covered = true; }
    if (httpCover.has(f)) { http = true; httpWhy.add(f); covered = true; }
    if (f.startsWith('public/') || BROWSER_ROOTS.includes(f)) { browser = true; http = true; browserWhy.add(f); httpWhy.add(f); covered = true; }
    if (!covered) return { full: true, reason: `${f} n'est couvert par aucune suite ni aucun étage : non-régression complète` };
  }
  return {
    full: false,
    suites: [...picked].map(([file, why]) => ({ file, reasons: [...why] })).sort((a, b) => a.file.localeCompare(b.file)),
    http, browser, reasons: { http: [...httpWhy], browser: [...browserWhy] }, docsOnly, outOfScope,
  };
}
