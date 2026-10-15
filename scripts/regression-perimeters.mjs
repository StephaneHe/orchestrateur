#!/usr/bin/env node
// ============================================================================
// scripts/regression-perimeters.mjs — non-regression by PERIMETER, before a
// production jump (0.106.0)
// ============================================================================
//
// User request (2026-10-15, verbatim): « les tests complets de regression
// deviennent beaucoup trop long. Il faut decouper l'ensemble du projet de
// maniere cloisonee, et seul les tests correspondant au perimetre impacte par
// des modifications devront etre lances avant une mise en prod. »
//
// The explicit, versioned map is scripts/regression-perimeters.json:
//   - every repository file belongs to exactly ONE perimeter, or to one of the
//     categories `transverse` (→ the FULL run), `noTests` (docs: the base
//     only) or `outOfScope` (Android);
//   - every suite scripts/_test_*.mjs belongs to exactly one perimeter (or is
//     listed in `excludedSuites` with its reason);
//   - a perimeter `uses` other perimeters: a change in Q also runs the suites
//     of every perimeter that uses Q — all of them ("Q", declared by hand), or
//     only the listed ones ({"perimeter": "Q", "suites": [...]}: those suites
//     execute code of Q). NOT transitive: the check below demands an edge for
//     every file a suite really reaches (its import closure, and that of the
//     scripts it launches), so a chain a → b → c already gives the edge a → c;
//   - a perimeter declares the stages it needs (`http`, `browser`).
//
// Selection (selectPerimeters), from the files changed since the production
// version: base suites + the suites of the impacted perimeters + their stages.
// The FULL run is the fallback, never a silent skip: a transverse file, a file
// the map does not know, a package.json changed beyond its version, or --full.
//
// The map is kept honest by checkMap (suite _test_regression_perimeters.mjs,
// part of the base, so it runs in EVERY run): an unmapped file or suite, a file
// in two perimeters, a missing `uses` edge (what each suite executes: what it
// names and imports, see regression-targets.mjs, plus the import closure of
// the scripts it launches — t-8dda3e) or a missing stage fails. Hence a
// perimeter run always selects at least what the targeted run
// (regression-targets.mjs) would select.
//
// Usage:
//   node scripts/regression-perimeters.mjs select [--since <ref>] [--ref <ref>] [--full] [--json]
//   node scripts/regression-perimeters.mjs check [--suggest]   (--suggest: the exact `uses` lists to paste)
// The run itself: node scripts/regression.mjs --ref vX.Y.Z --perimeters --prod <prod checkout>
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BASE_SUITES as TARGETED_BASE, HTTP_ROOTS, BROWSER_ROOTS, referenceGraph, coverageOf, importClosure, repoFiles, changedFiles } from './regression-targets.mjs';

export const PERIMETERS_FILE = 'scripts/regression-perimeters.json';
/** Always run, whatever changed: the targeted base plus the map's own check. */
export const BASE_SUITES = [...new Set([...TARGETED_BASE, '_test_regression_perimeters.mjs'])];
const SUITE_RE = /^scripts\/(_test_[^/]+\.mjs)$/;
const STAGES = ['http', 'browser'];

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.status === 0 ? (r.stdout || '') : '' };
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one character. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Parses and validates the map; throws with every problem found. */
export function parseMap(text) {
  const m = typeof text === 'string' ? JSON.parse(text) : text;
  const problems = [];
  const rules = (list, name) => (Array.isArray(list) ? list : []).map((r, i) => {
    if (!r || typeof r.glob !== 'string' || !String(r.reason || '').trim()) problems.push(`${name}[${i}] : glob et reason obligatoires`);
    return { ...r, re: globToRegExp(String(r?.glob || '')) };
  });
  const ids = new Set();
  const perimeters = (Array.isArray(m.perimeters) ? m.perimeters : []).map((p, i) => {
    if (!p || !/^[a-z][a-z0-9-]*$/.test(p.id || '')) problems.push(`perimeters[${i}] : id invalide`);
    else if (ids.has(p.id)) problems.push(`périmètre ${p.id} déclaré deux fois`);
    ids.add(p?.id);
    for (const s of p?.stages || []) if (!STAGES.includes(s)) problems.push(`périmètre ${p.id} : étage inconnu ${s}`);
    const uses = (p?.uses || []).map(u => typeof u === 'string' ? { perimeter: u, suites: null } : { perimeter: u?.perimeter, suites: Array.isArray(u?.suites) ? u.suites : null });
    for (const u of uses) if (u.suites) for (const x of u.suites) if (!(p.suites || []).includes(x)) problems.push(`périmètre ${p.id} : uses ${u.perimeter} cite ${x}, qui n'est pas une de ses suites`);
    return { id: p.id, label: p.label || p.id, files: (p.files || []).map(g => ({ glob: g, re: globToRegExp(g) })), suites: p.suites || [], uses, stages: p.stages || [] };
  });
  for (const p of perimeters) for (const u of p.uses) if (!ids.has(u.perimeter)) problems.push(`périmètre ${p.id} : uses ${u.perimeter} inconnu`);
  if (!perimeters.length) problems.push('aucun périmètre');
  const map = {
    perimeters, byId: new Map(perimeters.map(p => [p.id, p])),
    transverse: rules(m.transverse, 'transverse'), noTests: rules(m.noTests, 'noTests'), outOfScope: rules(m.outOfScope, 'outOfScope'),
    excludedSuites: m.excludedSuites || {},
  };
  if (problems.length) throw new Error(`carte des périmètres invalide :\n  - ${problems.join('\n  - ')}`);
  return map;
}

/**
 * What a file is, for the map.
 * → { kind: 'suite', perimeter, suite } | { kind: 'perimeter', ids }
 *   | { kind: 'transverse'|'noTests'|'outOfScope', reason } | { kind: 'excluded', reason } | { kind: 'unknown' }
 * A suite is attached by name; categories are checked before perimeters.
 */
export function classify(map, file) {
  const s = SUITE_RE.exec(file);
  if (s) {
    const p = map.perimeters.find(x => x.suites.includes(s[1]));
    if (p) return { kind: 'suite', perimeter: p.id, suite: s[1] };
    if (map.excludedSuites[s[1]]) return { kind: 'excluded', reason: map.excludedSuites[s[1]] };
    return { kind: 'unknown' };
  }
  for (const kind of ['outOfScope', 'transverse', 'noTests']) {
    const r = map[kind].find(x => x.re.test(file));
    if (r) return { kind, reason: r.reason };
  }
  // A file named exactly wins over a pattern (public/turn-core.js vs public/**).
  const exact = map.perimeters.filter(p => p.files.some(g => g.glob === file)).map(p => p.id);
  const ids = exact.length ? exact : map.perimeters.filter(p => p.files.some(g => g.re.test(file))).map(p => p.id);
  return ids.length ? { kind: 'perimeter', ids } : { kind: 'unknown' };
}

/**
 * Who runs for the perimeters changed directly (`direct`): those perimeters
 * entirely, and each perimeter that uses one of them — entirely, or only the
 * suites of its edge. Not transitive (see the header).
 * → Map<id, {whole: bool, suites: Set, how: [string]}>
 */
export function impactedBy(map, direct) {
  const out = new Map([...direct].map(id => [id, { whole: true, suites: new Set(), how: ['modifié'] }]));
  for (const p of map.perimeters) {
    if (direct.has(p.id)) continue;
    for (const u of p.uses) {
      if (!direct.has(u.perimeter)) continue;
      const e = out.get(p.id) || { whole: false, suites: new Set(), how: [] };
      if (!u.suites) { e.whole = true; e.how.push(`utilise ${u.perimeter}`); }
      else { for (const x of u.suites) e.suites.add(x); e.how.push(`suites qui couvrent ${u.perimeter}`); }
      out.set(p.id, e);
    }
  }
  return out;
}

/**
 * Selection for a set of changed files.
 * → { full: true, reason } | { full: false, perimeters: [{id, label, whole, why}], suites: [{file, reasons}],
 *     http, browser, reasons: {http, browser}, docsOnly, outOfScope }
 * `versionOnlyPackage`: package.json differs only by its version (no test of its own).
 */
export function selectPerimeters(map, changed, { versionOnlyPackage = false, full = false } = {}) {
  if (full) return { full: true, reason: '--full demandé' };
  const direct = new Set(), why = new Map(), docsOnly = [], outOfScope = [], changedSuites = [];
  for (const f of changed) {
    if (f === 'package.json') {
      if (versionOnlyPackage) { docsOnly.push(f); continue; }
      return { full: true, reason: 'package.json modifié au-delà du numéro de version (dépendances, scripts) : fichier transverse' };
    }
    const c = classify(map, f);
    if (c.kind === 'outOfScope') { outOfScope.push({ file: f, reason: c.reason }); continue; }
    if (c.kind === 'transverse') return { full: true, reason: `${f} est transverse (${c.reason}) : non-régression complète` };
    if (c.kind === 'noTests') { docsOnly.push(f); continue; }
    if (c.kind === 'excluded') { docsOnly.push(f); continue; }
    if (c.kind === 'suite') { changedSuites.push({ file: c.suite, perimeter: c.perimeter }); continue; }
    if (c.kind === 'unknown') return { full: true, reason: `${f} n'appartient à aucun périmètre de ${PERIMETERS_FILE} : non-régression complète` };
    for (const id of c.ids) { direct.add(id); if (!why.has(id)) why.set(id, []); why.get(id).push(f); }
  }
  const impacted = impactedBy(map, direct);
  const picked = new Map();
  const add = (s, r) => { if (!picked.has(s)) picked.set(s, new Set()); picked.get(s).add(r); };
  for (const b of BASE_SUITES) add(b, 'socle (toujours exécuté)');
  let http = false, browser = false;
  const httpWhy = [], browserWhy = [];
  const perimeters = [];
  for (const [id, e] of impacted) {
    const p = map.byId.get(id);
    const files = why.get(id) || [];
    const how = e.how.join(', ');
    perimeters.push({ id, label: p.label, whole: e.whole, why: files.length ? `modifié : ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` (+${files.length - 3})` : ''}` : how });
    for (const s of e.whole ? p.suites : [...e.suites]) add(s, `périmètre ${id} (${files.length ? 'modifié' : how})`);
    // Stages follow the changed files only: checkMap demands the stage of the
    // perimeter that owns every file a stage covers.
    if (!direct.has(id)) continue;
    if (p.stages.includes('http')) { http = true; httpWhy.push(id); }
    if (p.stages.includes('browser')) { browser = true; browserWhy.push(id); }
  }
  // A changed suite runs by itself: no other code depends on a test file.
  for (const s of changedSuites) add(s.file, 'suite modifiée');
  if (browser) http = true; // the browser stage runs on the HTTP stage's sandbox
  return {
    full: false, perimeters,
    suites: [...picked].map(([file, r]) => ({ file, reasons: [...r] })).sort((a, b) => a.file.localeCompare(b.file)),
    http, browser, reasons: { http: httpWhy, browser: browserWhy }, docsOnly, outOfScope,
  };
}

/**
 * Files a suite executes: coverageOf (what it names, its import closure) plus
 * the import closure of every code file it names (a script it spawns).
 * → Map<file, the named file it is reached through>
 */
export function reachOf(graph, suite) {
  const out = new Map();
  for (const t of coverageOf(graph, suite)) out.set(t, t);
  for (const m of graph.get(suite)?.mentions || []) {
    if (SUITE_RE.test(m) || !graph.has(m)) continue;
    for (const t of importClosure(graph, [m])) if (!out.has(t)) out.set(t, m);
  }
  return out;
}

/** Does perimeter `from` declare it runs `suite` (null = all its suites) when `to` changes? */
function declares(map, from, to, suite) {
  return (map.byId.get(from)?.uses || []).some(u => u.perimeter === to && (!u.suites || (suite && u.suites.includes(suite))));
}

/**
 * Keeps the map honest.
 * → { ok, problems: [string], missingUses: [{from, to, suite, because}], requiredUses: [same, declared or not] }
 * `files`: every repository file (tracked + untracked not ignored).
 */
export function checkMap(map, { repo, files }) {
  const problems = [];
  const owner = new Map();
  for (const f of files) {
    const c = classify(map, f);
    if (c.kind === 'unknown') problems.push(`${f} : rattaché à aucun périmètre ni catégorie (${PERIMETERS_FILE})`);
    else if (c.kind === 'perimeter') {
      if (c.ids.length > 1) problems.push(`${f} : dans plusieurs périmètres (${c.ids.join(', ')}) — les périmètres sont cloisonnés`);
      owner.set(f, c.ids[0]);
    } else if (c.kind === 'suite') owner.set(f, c.perimeter);
  }
  const present = new Set(files.map(f => SUITE_RE.exec(f)?.[1]).filter(Boolean));
  const listed = new Map();
  for (const p of map.perimeters) for (const s of p.suites) {
    if (listed.has(s)) problems.push(`${s} : listée dans ${listed.get(s)} et ${p.id}`);
    listed.set(s, p.id);
    if (!present.has(s)) problems.push(`${s} (périmètre ${p.id}) : suite introuvable`);
  }
  for (const s of Object.keys(map.excludedSuites)) if (listed.has(s)) problems.push(`${s} : exclue et listée dans ${listed.get(s)}`);
  for (const b of BASE_SUITES) if (!present.has(b)) problems.push(`suite du socle introuvable : ${b}`);

  const graph = referenceGraph(repo, files);
  const missing = new Map(), required = new Map();
  // An edge is required exactly when a suite of P EXECUTES code of Q
  // (reachOf: what it imports, and the scripts it names — spawned, like
  // dispatch.mjs or server.js — with their whole import closure; t-8dda3e).
  // A suite file is never a dependency: a changed suite runs by itself; a
  // base suite needs no edge: it runs every time.
  const need = (from, to, suite, because) => {
    if (!from || !to || from === to || BASE_SUITES.includes(suite)) return;
    const k = `${from}→${to}→${suite || '*'}`;
    if (!required.has(k)) required.set(k, { from, to, suite, because });
    if (!declares(map, from, to, suite) && !missing.has(k)) missing.set(k, { from, to, suite, because });
  };
  const codeOwner = (f) => SUITE_RE.test(f) ? null : owner.get(f);
  for (const p of map.perimeters) for (const s of p.suites) {
    const file = `scripts/${s}`;
    if (!graph.has(file)) continue;
    for (const [t, via] of reachOf(graph, file)) need(p.id, codeOwner(t), s, `${s} ${via === t ? 'couvre' : `lance ${via}, qui importe`} ${t}`);
  }
  // Stages: a file the HTTP stage covers, or a browser file, needs that stage in its perimeter.
  const httpCover = new Set(HTTP_ROOTS.filter(f => files.includes(f)).flatMap(r => [...coverageOf(graph, r), ...importClosure(graph, [r])]));
  for (const [f, id] of owner) {
    if (SUITE_RE.test(f)) continue;
    const p = map.byId.get(id);
    if (httpCover.has(f) && !p.stages.includes('http')) problems.push(`${f} est couvert par l'étage HTTP : le périmètre ${id} doit déclarer "http"`);
    if ((f.startsWith('public/') || BROWSER_ROOTS.includes(f)) && !p.stages.includes('browser')) problems.push(`${f} est couvert par l'étage navigateur : le périmètre ${id} doit déclarer "browser"`);
  }
  const missingUses = [...missing.values()];
  for (const m of missingUses) problems.push(`périmètre ${m.from} doit utiliser ${m.to}${m.suite ? ` (au moins par ${m.suite})` : ' (toutes ses suites)'} : ${m.because}`);
  return { ok: !problems.length, problems, missingUses, requiredUses: [...required.values()] };
}

// ---------------------------------------------------------------------------
// Reading a state of the repository: the working tree, or a commit / tag.
// ---------------------------------------------------------------------------

/** Map, file list and package.json of `ref` (null = working tree). */
export function readState(repo, ref = null) {
  if (!ref) {
    return { map: parseMap(fs.readFileSync(path.join(repo, PERIMETERS_FILE), 'utf8')), files: repoFiles(repo),
      pkg: (() => { try { return JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); } catch { return null; } })() };
  }
  const show = (f) => git(repo, ['show', `${ref}:${f}`]);
  const m = show(PERIMETERS_FILE);
  if (!m.ok) throw new Error(`${PERIMETERS_FILE} absent de ${ref} : pas de non-régression par périmètre possible`);
  let pkg = null; try { pkg = JSON.parse(show('package.json').out); } catch { /* none */ }
  return { map: parseMap(m.out), files: git(repo, ['ls-tree', '-r', '--name-only', ref]).out.split('\n').filter(Boolean), pkg };
}

function versionOnly(a, b) {
  if (!a || !b) return false;
  const x = { ...a }, y = { ...b }; delete x.version; delete y.version;
  return JSON.stringify(x) === JSON.stringify(y);
}

/**
 * Whole plan between `base` (the production version) and `target` (a tag, or
 * null for the working tree). Pure git reads: prod-jump.mjs recomputes it to
 * check a report. → { base, baseCommit, target, changed, ...selection }
 */
export function perimeterPlan({ repo, base, target = null, full = false }) {
  const baseCommit = git(repo, ['rev-parse', `${base}^{commit}`]).out.trim();
  if (!baseCommit) throw new Error(`référence de base inconnue : ${base}`);
  const state = readState(repo, target);
  const changed = target
    ? git(repo, ['diff', '--name-only', baseCommit, target]).out.split('\n').map(s => s.trim()).filter(Boolean).sort()
    : changedFiles(repo, baseCommit);
  let basePkg = null; try { basePkg = JSON.parse(git(repo, ['show', `${baseCommit}:package.json`]).out); } catch { /* none */ }
  const sel = selectPerimeters(state.map, changed, { versionOnlyPackage: versionOnly(basePkg, state.pkg), full });
  return { base, baseCommit, target: target || 'worktree', changed, ...sel };
}

/**
 * The `uses` of every perimeter, exactly the edges its suites need
 * (maintenance aid: check --suggest; pass checkMap's requiredUses).
 */
export function suggestUses(map, requiredUses) {
  const out = {};
  for (const p of map.perimeters) {
    const by = new Map();
    for (const m of requiredUses.filter(x => x.from === p.id)) {
      if (!m.suite) by.set(m.to, null);
      else if (by.get(m.to) !== null) by.set(m.to, new Set([...(by.get(m.to) || []), m.suite]));
    }
    out[p.id] = [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([perimeter, suites]) => suites ? { perimeter, suites: [...suites].sort() } : perimeter);
  }
  return out;
}

/** Human-readable lines of a plan (printed by regression.mjs and by `select`). */
export function planLines(plan) {
  const out = [`=== Non-régression PAR PÉRIMÈTRE — ${plan.changed.length} fichier(s) modifié(s) entre ${plan.base} (${plan.baseCommit.slice(0, 7)}) et ${plan.target}`];
  if (plan.full) { out.push(`   → bascule sur la COMPLÈTE : ${plan.reason}`); return out; }
  out.push(`   périmètres retenus : ${plan.perimeters.length ? '' : 'aucun (socle seulement)'}`);
  for (const p of plan.perimeters) out.push(`     · ${p.id} — ${p.why}`);
  for (const s of plan.suites) out.push(`   suite ${s.file} — ${s.reasons.slice(0, 2).join(' ; ')}${s.reasons.length > 2 ? ` (+${s.reasons.length - 2})` : ''}`);
  out.push(`   étage HTTP : ${plan.http ? `oui (${plan.reasons.http.join(', ') || 'navigateur'})` : 'non'} · navigateur : ${plan.browser ? `oui (${plan.reasons.browser.join(', ')})` : 'non'}`);
  if (plan.docsOnly.length) out.push(`   sans test propre (docs, version) : ${plan.docsOnly.join(', ')}`);
  for (const o of plan.outOfScope) out.push(`   ${o.file} — ${o.reason}`);
  return out;
}

/** Does a report cover a plan? Lives in delivery-gate.mjs (import-free for the git hook). */
export { reportCoversPlan } from './delivery-gate.mjs';

async function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
  const repo = opt('--repo') || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (cmd === 'check') {
    const { map, files } = readState(repo);
    const v = checkMap(map, { repo, files });
    if (v.ok) (rest.includes('--suggest') ? console.error : console.log)(`[périmètres] carte à jour : ${map.perimeters.length} périmètres, ${files.length} fichiers rattachés`);
    else { console.error('[périmètres] carte à mettre à jour :'); for (const p of v.problems) console.error(`  - ${p}`); }
    if (rest.includes('--suggest')) console.log(JSON.stringify(suggestUses(map, v.requiredUses), null, 2));
    process.exit(v.ok ? 0 : 1);
  }
  if (cmd === 'select') {
    const plan = perimeterPlan({ repo, base: opt('--since') || 'HEAD', target: opt('--ref'), full: rest.includes('--full') });
    if (rest.includes('--json')) console.log(JSON.stringify(plan, null, 2));
    else console.log(planLines(plan).join('\n'));
    return;
  }
  console.error('usage: regression-perimeters.mjs select [--since <ref>] [--ref <ref>] [--full] [--json] | check');
  process.exit(64);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
