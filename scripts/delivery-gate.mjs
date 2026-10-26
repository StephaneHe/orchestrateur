#!/usr/bin/env node
// ============================================================================
// scripts/delivery-gate.mjs — no delivery with a red suite (0.71.3)
// ============================================================================
//
// Incident (2026-10-11): fix n° 8 (v0.71.0) was committed although its full
// non-regression run had 1 KO (_test_pool_chef_dispatch.mjs, exit 1): the
// runner did exit 1, but nothing stopped the commit, and `regression.mjs
// --compare` reported "0 regressions" because the KO already existed before.
//
// The gate, applied by the code:
//   - a DELIVERY commit (the staged package.json version differs from HEAD's)
//     needs a regression report made on exactly the staged content (same git
//     tree) with no KO at all;
//   - a KO may only be accepted when it is listed, with its reason, in
//     docs/known-ko.json — and every accepted KO is printed, never silent.
//
// Usage:
//   node scripts/delivery-gate.mjs check [--report <file>] [--tree <sha>]
//   node scripts/delivery-gate.mjs prod-check <ref> [--prod <dépôt>|--base <c>] [--unit]
//                                                    (--unit, 0.142.0: the task's tests only, idle-regression.mjs)
//   node scripts/delivery-gate.mjs pre-commit        (run by the git hook)
//   node scripts/delivery-gate.mjs install-hook      (writes .git/hooks/pre-commit)
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KNOWN_KO_FILE = path.join('docs', 'known-ko.json');

function git(repo, args, env) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Tree of the working copy as it would be committed with `git add -A` (index untouched). */
export function worktreeTree(repo) {
  const tmp = path.join(os.tmpdir(), `orch-gate-index-${process.pid}-${Date.now()}`);
  try {
    const idx = path.join(repo, '.git', 'index');
    if (fs.existsSync(idx)) fs.copyFileSync(idx, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    if (!git(repo, ['add', '-A'], env).ok) return null;
    const t = git(repo, ['write-tree'], env);
    return t.ok ? t.out : null;
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** Tree of what is staged (the commit being made). */
export function stagedTree(repo) { const t = git(repo, ['write-tree']); return t.ok ? t.out : null; }

/** Accepted pre-existing KOs: [{id, reason}] from docs/known-ko.json (missing file = none). */
export function readKnownKo(repo) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(repo, KNOWN_KO_FILE), 'utf8'));
    return (Array.isArray(j) ? j : []).filter(k => k && typeof k.id === 'string' && typeof k.reason === 'string' && k.reason.trim());
  } catch { return []; }
}

/**
 * Verdict on one report for one content.
 * → { ok, reasons: [...], accepted: [{id, reason}] }
 */
export function checkReport(report, { tree, knownKo = [] } = {}) {
  const reasons = [];
  if (!report || !Array.isArray(report.results)) return { ok: false, reasons: ['rapport de non-régression illisible'], accepted: [] };
  if (report.stale) reasons.push(`rapport périmé : le contenu a changé pendant l'exécution (${report.label || '?'}, ${report.at || '?'}) — relancer la non-régression sur le contenu final`);
  if (report.timeout) reasons.push(`rapport incomplet : délai dépassé (${report.timeout.limitMin} min), ${report.timeout.notRun?.length ?? '?'} suite(s) non jouée(s) (${report.label || '?'}, ${report.at || '?'})`);
  if (tree && report.tree !== tree) reasons.push(`le rapport (${report.label || '?'}, ${report.at || '?'}) n'a pas été fait sur ce contenu (arbre ${String(report.tree || 'absent').slice(0, 10)} ≠ ${String(tree).slice(0, 10)})`);
  // An entry without a reason accepts nothing, whoever passes the list.
  const known = new Map(knownKo.filter(k => k && typeof k.reason === 'string' && k.reason.trim()).map(k => [k.id, k]));
  const accepted = [];
  for (const r of report.results.filter(x => x.status === 'KO')) {
    const k = known.get(r.id);
    if (k) accepted.push({ id: r.id, reason: k.reason });
    else reasons.push(`KO non accepté : ${r.id} — ${String(r.detail || '').slice(0, 160)}`);
  }
  return { ok: !reasons.length, reasons, accepted };
}

/**
 * Production gate (0.72.0, perimeters 0.106.0): a run on exactly the jumped
 * tree, with no KO, that is either FULL (every suite, HTTP and browser stages)
 * or PER PERIMETER from the production version: `plan` is the selection
 * recomputed from the tag's own map (perimeterPlan), and the report must have
 * run every suite and stage of it. Targeted or partial runs never go to prod.
 */
export function checkProdReport(report, { tree, knownKo = [], plan = null } = {}) {
  const v = checkReport(report, { tree, knownKo });
  if (report && report.mode === 'perimeter') {
    if (!plan) v.reasons.unshift('non-régression PAR PÉRIMÈTRE : version en prod inconnue, sélection impossible à vérifier (indiquer --prod)');
    else v.reasons.unshift(...reportCoversPlan(report, plan));
  } else if (report && report.mode !== 'full') v.reasons.unshift(`non-régression ${report.mode === 'targeted' ? 'CIBLÉE' : report.mode || 'sans mode'} : la mise en prod exige la COMPLÈTE ou celle PAR PÉRIMÈTRE depuis la version en prod`);
  return { ...v, ok: !v.reasons.length };
}

/**
 * The most recent report on `tree` a production jump accepts: full, or per
 * perimeter covering `plan`. Otherwise the most recent full / perimeter one on
 * `tree` (so the refusal says why), or null.
 */
export function findProdReport(repo, tree, { plan = null, knownKo = [] } = {}) {
  const dir = path.join(repo, '.regress');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^report-.*\.json$/.test(f)).map(f => path.join(dir, f)); } catch { return null; }
  const all = files.map(f => { try { return { f, r: JSON.parse(fs.readFileSync(f, 'utf8')), m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(x => x && x.r.tree === tree && (x.r.mode === 'full' || x.r.mode === 'perimeter')).sort((a, b) => b.m - a.m);
  return all.find(x => checkProdReport(x.r, { tree, knownKo, plan }).ok) || all[0] || null;
}

/**
 * Production gate under the idle-time policy (0.142.0, idle-regression.mjs):
 * « la mise en prod ne dépend plus que des tests unitaires ». A green report of
 * ANY mode (targeted, partial, perimeter, full) on exactly the jumped tree —
 * the task's tests, i.e. the report the delivery commit was checked against.
 * Stale or KO reports are still refused; no full run is ever required.
 */
export function checkUnitReport(report, { tree, knownKo = [] } = {}) {
  return checkReport(report, { tree, knownKo });
}

/** The most recent report on `tree` checkUnitReport accepts, else the most recent one on `tree`, or null. */
export function findUnitReport(repo, tree, { knownKo = [] } = {}) {
  const dir = path.join(repo, '.regress');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^report-.*\.json$/.test(f)).map(f => path.join(dir, f)); } catch { return null; }
  const all = files.map(f => { try { return { f, r: JSON.parse(fs.readFileSync(f, 'utf8')), m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    // A bisect step of the idle-time program (report-idle-*, only the KO suites) is not the task's tests.
    .filter(x => x && x.r.tree === tree && !(path.basename(x.f).startsWith('report-idle-') && x.r.mode !== 'full')).sort((a, b) => b.m - a.m);
  return all.find(x => checkUnitReport(x.r, { tree, knownKo }).ok) || all[0] || null;
}

/**
 * Does `report` cover `plan` (a perimeterPlan)? → [reasons it does not]; [] = covered.
 * Kept here, import-free: the pre-commit hook runs this file on its own.
 */
export function reportCoversPlan(report, plan) {
  const reasons = [];
  const sel = report?.selection || {};
  if (sel.baseCommit !== plan.baseCommit) reasons.push(`non-régression par périmètre faite depuis ${String(sel.baseCommit || '?').slice(0, 7)}, pas depuis la version en prod (${String(plan.baseCommit).slice(0, 7)})`);
  if (plan.full) { reasons.push(`la sélection exige la COMPLÈTE : ${plan.reason}`); return reasons; }
  const results = report?.results || [];
  const ran = new Set(results.filter(r => r.stage === 'suite').map(r => r.id.replace(/^suite:/, '')));
  const absent = plan.suites.map(s => s.file).filter(s => !ran.has(s));
  if (absent.length) reasons.push(`suites attendues non exécutées : ${absent.join(', ')}`);
  if (plan.http && !results.some(r => r.stage === 'http')) reasons.push('étage HTTP attendu, non exécuté');
  if (plan.browser && !results.some(r => !['suite', 'http'].includes(r.stage))) reasons.push('étage navigateur attendu, non exécuté');
  return reasons;
}

/**
 * Selection a perimeter run from `prodHead` to `ref` must cover, recomputed
 * from the map of `ref` (regression-perimeters.mjs select, run as a child so
 * this file stays import-free); null without a map in `ref` or a known commit.
 */
export function prodPlan(repo, ref, prodHead) {
  const cli = path.join(ROOT, 'scripts', 'regression-perimeters.mjs');
  if (!prodHead || !fs.existsSync(cli)) return null;
  const r = spawnSync(process.execPath, [cli, 'select', '--since', prodHead, '--ref', ref, '--repo', repo, '--json'], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
}

/** The most recent FULL report under .regress/ made on `tree`, or null. */
export function findFullReport(repo, tree) {
  const dir = path.join(repo, '.regress');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^report-.*\.json$/.test(f)).map(f => path.join(dir, f)); } catch { return null; }
  return files.map(f => { try { return { f, r: JSON.parse(fs.readFileSync(f, 'utf8')), m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(x => x && x.r.tree === tree && x.r.mode === 'full').sort((a, b) => b.m - a.m)[0] || null;
}

/** The most recent report under .regress/ made on `tree`, or the most recent one. */
export function findReport(repo, tree) {
  const dir = path.join(repo, '.regress');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^report-.*\.json$/.test(f)).map(f => path.join(dir, f)); } catch { return null; }
  const reports = files.map(f => { try { return { f, r: JSON.parse(fs.readFileSync(f, 'utf8')), m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.m - a.m);
  return (reports.find(x => tree && x.r.tree === tree) || reports[0]) || null;
}

/** True when the staged package.json version differs from HEAD's: a delivery commit. */
export function isDeliveryCommit(repo) {
  const ver = (txt) => { try { return JSON.parse(txt).version || null; } catch { return null; } };
  const head = git(repo, ['show', 'HEAD:package.json']);
  const staged = git(repo, ['show', ':package.json']);
  if (!staged.ok) return false;
  return !head.ok || ver(head.out) !== ver(staged.out);
}

function printVerdict(v, where) {
  for (const a of v.accepted) console.error(`[delivery-gate] KO accepté (docs/known-ko.json) : ${a.id} — ${a.reason}`);
  if (v.ok) console.error(`[delivery-gate] LIVRAISON AUTORISÉE${where ? ` (${where})` : ''}${v.accepted.length ? ` — ${v.accepted.length} KO accepté(s), listés ci-dessus` : ' — aucune suite rouge'}`);
  else { console.error(`[delivery-gate] LIVRAISON REFUSÉE${where ? ` (${where})` : ''} :`); for (const r of v.reasons) console.error(`  - ${r}`); }
}

const HOOK = '#!/bin/sh\n# Installed by scripts/delivery-gate.mjs install-hook: no delivery commit with a red suite.\nexec node "$(git rev-parse --show-toplevel)/scripts/delivery-gate.mjs" pre-commit\n';

async function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
  const repo = opt('--repo') || ROOT;
  if (cmd === 'install-hook') {
    const f = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && !fs.readFileSync(f, 'utf8').includes('delivery-gate.mjs')) { console.error(`[delivery-gate] un hook pre-commit existe déjà : ${f} — rien n'est écrasé`); process.exit(3); }
    fs.writeFileSync(f, HOOK, { mode: 0o755 });
    console.log(`[delivery-gate] hook installé : ${f}`);
    return;
  }
  if (cmd === 'pre-commit') {
    if (!isDeliveryCommit(repo)) return; // not a delivery: docs, intermediate commits…
    const tree = stagedTree(repo);
    const found = findReport(repo, tree);
    const v = found ? checkReport(found.r, { tree, knownKo: readKnownKo(repo) }) : { ok: false, reasons: ['aucun rapport de non-régression dans .regress/'], accepted: [] };
    printVerdict(v, found ? path.basename(found.f) : null);
    process.exit(v.ok ? 0 : 1);
  }
  if (cmd === 'check') {
    const tree = opt('--tree') || worktreeTree(repo);
    const file = opt('--report');
    const found = file ? { f: file, r: JSON.parse(fs.readFileSync(file, 'utf8')) } : findReport(repo, tree);
    const v = found ? checkReport(found.r, { tree, knownKo: readKnownKo(repo) }) : { ok: false, reasons: ['aucun rapport de non-régression'], accepted: [] };
    printVerdict(v, found ? path.basename(found.f) : null);
    process.exit(v.ok ? 0 : 1);
  }
  if (cmd === 'prod-check') {
    const ref = rest.find(a => !a.startsWith('--') && ![opt('--repo'), opt('--report'), opt('--prod'), opt('--base')].includes(a));
    if (!ref) { console.error('usage: delivery-gate.mjs prod-check <tag|commit> [--prod <dépôt de prod> | --base <commit>] [--report <f>]'); process.exit(64); }
    const tree = git(repo, ['rev-parse', `${ref}^{tree}`]).out;
    if (!tree) { console.error(`[delivery-gate] référence inconnue : ${ref}`); process.exit(64); }
    const file = opt('--report');
    // The production version a perimeter run starts from: --prod <checkout> or --base <commit>.
    const prodHead = opt('--base') || (opt('--prod') ? git(path.resolve(opt('--prod')), ['rev-parse', 'HEAD']).out : null);
    const knownKo = readKnownKo(repo);
    // 0.142.0: --unit = the idle-time policy, the task's tests only (no full run required).
    if (rest.includes('--unit')) {
      const found = file ? { f: file, r: JSON.parse(fs.readFileSync(file, 'utf8')) } : findUnitReport(repo, tree, { knownKo });
      const v = found ? checkUnitReport(found.r, { tree, knownKo }) : { ok: false, reasons: [`aucun rapport de tests vert sur ${ref} (arbre ${tree.slice(0, 10)}) : celui du commit de livraison (regression.mjs --targeted)`], accepted: [] };
      printVerdict(v, found ? `${path.basename(found.f)}, mise en prod de ${ref} sur les tests de la tâche` : `mise en prod de ${ref}`);
      process.exit(v.ok ? 0 : 1);
    }
    const plan = prodPlan(repo, ref, prodHead);
    const found = file ? { f: file, r: JSON.parse(fs.readFileSync(file, 'utf8')) } : findProdReport(repo, tree, { plan, knownKo });
    const v = found ? checkProdReport(found.r, { tree, knownKo, plan })
      : { ok: false, reasons: [`aucune non-régression COMPLÈTE ni PAR PÉRIMÈTRE sur ${ref} (arbre ${tree.slice(0, 10)}) : lancer node scripts/regression.mjs --ref ${ref} --perimeters --prod <dépôt de prod> dans orchestrateur-dev (jamais en prod)`], accepted: [] };
    printVerdict(v, found ? `${path.basename(found.f)}, mise en prod de ${ref}` : `mise en prod de ${ref}`);
    process.exit(v.ok ? 0 : 1);
  }
  console.error('usage: delivery-gate.mjs check [--report <f>] [--tree <sha>] | prod-check <ref> [--prod <dépôt>|--base <commit>|--unit] | pre-commit | install-hook');
  process.exit(64);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
