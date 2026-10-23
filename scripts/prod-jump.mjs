#!/usr/bin/env node
// ============================================================================
// scripts/prod-jump.mjs — the production jump, refused without a FULL green
// non-regression on the jumped version (0.72.0)
// ============================================================================
//
// User request (2026-10-11, verbatim): « Implemente une Non-régression ciblée
// pendant le développement, et la complète seulement avant une mise en prod ».
// During development the targeted run is enough; a version only reaches
// production through this script, which demands a FULL run (every suite, HTTP
// and browser stages) made on exactly the tag's tree, with no KO (except the
// ones listed with their reason in docs/known-ko.json, printed).
//
// Since 0.106.0 (« seul les tests correspondant au perimetre impacte par des
// modifications devront etre lances avant une mise en prod »), a run BY
// PERIMETER is accepted too, when it starts from the production commit and
// ran every suite and stage of the selection recomputed here from the tag's
// own map (scripts/regression-perimeters.mjs).
//
// Since 0.142.0 (user decision 2026-10-23, « la mise en prod ne dépend plus que
// des tests unitaires et les non régression ne servent plus qu'à posteriori »):
// with the idleRegression switch on (read, never written, in the production's
// model-routing.json; or --unit), the jump needs only a GREEN report of the
// task's tests on the tag's tree (any mode: the delivery commit's own report).
// The full run is done after the fact, while idle, on orchestrateur-dev
// (scripts/idle-regression.mjs); its state is printed, never a condition.
//
// Step 2 of docs/DEV-PROD.md, made mechanical. The jump itself stays a user
// decision: without --apply nothing is written (plan only).
//
// Usage (from the dev checkout):
//   node scripts/prod-jump.mjs --tag vX.Y.Z --prod I:\orchestrateur [--from origin|<path>] [--apply]
// Refusals (exit 1): no full green report on the tag, tag unknown, production
// not clean, a production turn running, no fast-forward possible.
// After --apply: the chef restarts the server when the fleet is idle, with the
// user's agreement (never this script), then the non-regression runs on
// orchestrateur-dev. Never in production (0.125.0, user rule).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkProdReport, findProdReport, prodPlan, readKnownKo, checkUnitReport, findUnitReport } from './delivery-gate.mjs';
import { readSettings as readIdleSettings, readState as readIdleState } from './idle-regression.mjs';

const DEV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const git = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, '-c', 'user.name=orchestrateur', '-c', 'user.email=orchestrateur@localhost', ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

/**
 * Files tracked in production (`prodHead`) that the tag stops tracking AND
 * ignores (e.g. TODO_LIST.md, 0.74.2): the fast-forward would delete them from
 * the production disk, so the jump puts them back from prod-before-<tag>.
 * A file the tag deletes without ignoring it is a real deletion: not kept.
 */
export function keptOnDisk({ dev = DEV, prodHead, commit }) {
  if (!prodHead || !commit || !git(dev, ['cat-file', '-e', `${prodHead}^{commit}`]).ok) return [];
  const gone = git(dev, ['diff', '--name-only', '--diff-filter=D', prodHead, commit]).out.split('\n').filter(Boolean);
  return gone.filter(f => git(dev, ['check-ignore', '-q', '--no-index', f]).ok);
}

/** Idle-time policy on for the jump: --unit, or the switch of the production (read only). */
export function unitPolicy({ prod, unit = false } = {}) {
  if (unit) return { on: true, why: '--unit' };
  const s = prod ? readIdleSettings(prod) : null;
  const on = !!s?.enabled && (!s.projects || s.projects.some(p => /^orchestrateur/.test(p)));
  return { on, why: on ? `interrupteur idleRegression de la prod (depuis ${s.since})` : null };
}

/** State of the full runs after the fact (prod's logs/idle-regression.json, read only), for the printout. */
export function posterioriState(prod) {
  try {
    const st = readIdleState(path.join(prod, 'logs'));
    const p = Object.entries(st.projects).find(([n]) => /^orchestrateur/.test(n))?.[1] || null;
    if (!p) return 'aucune non-régression a posteriori encore faite';
    const green = p.lastGreen ? `dernière complète verte ${p.lastGreen.commit.slice(0, 7)} (${p.lastGreen.at})` : 'aucune complète verte';
    return p.red ? `${green} ; ROUGE sur ${p.red.commit.slice(0, 7)} (${(p.red.ko || []).slice(0, 4).join(', ')}) — correction ${p.red.fix ? 'lancée' : 'à lancer pendant l’inactivité'}` : green;
  } catch { return 'état illisible'; }
}

/** Everything that must hold before the jump; → { ok, problems, plan, report, keep } */
export function preflight({ dev = DEV, prod, tag, from = 'origin', turnLock = null, unit = false } = {}) {
  const problems = [];
  const tree = git(dev, ['rev-parse', `${tag}^{tree}`]).out;
  const commit = git(dev, ['rev-parse', `${tag}^{commit}`]).out;
  if (!tree || !commit) problems.push(`tag ${tag} inconnu dans la dev`);
  let report = null;
  // The production version a perimeter run must start from (read only).
  const prodHead = prod && fs.existsSync(path.join(prod, '.git')) ? git(prod, ['rev-parse', 'HEAD']).out : null;
  const policy = unitPolicy({ prod, unit });
  if (tree && policy.on) {
    const knownKo = readKnownKo(dev);
    const found = findUnitReport(dev, tree, { knownKo });
    const v = found ? checkUnitReport(found.r, { tree, knownKo })
      : { ok: false, reasons: [`aucun rapport de tests vert sur ${tag} : celui du commit de livraison (node scripts/regression.mjs --targeted, dans orchestrateur-dev)`], accepted: [] };
    report = { file: found?.f || null, accepted: v.accepted, mode: found?.r.mode || null, plan: null, unit: true, why: policy.why };
    problems.push(...v.reasons);
  } else if (tree) {
    const plan = prodPlan(dev, tag, prodHead);
    const knownKo = readKnownKo(dev);
    const found = findProdReport(dev, tree, { plan, knownKo });
    const v = found ? checkProdReport(found.r, { tree, knownKo, plan })
      : { ok: false, reasons: [`aucune non-régression COMPLÈTE ni PAR PÉRIMÈTRE sur ${tag} : lancer, dans orchestrateur-dev (jamais en prod), node scripts/regression.mjs --ref ${tag} --perimeters --prod ${prod}`], accepted: [] };
    report = { file: found?.f || null, accepted: v.accepted, mode: found?.r.mode || null, plan };
    problems.push(...v.reasons);
  }
  let keep = [];
  if (!prod || !fs.existsSync(path.join(prod, '.git'))) problems.push(`dépôt de prod introuvable : ${prod}`);
  else {
    const dirty = git(prod, ['status', '--porcelain']).out;
    if (dirty) problems.push(`la prod a des modifications non commitées :\n${dirty.split('\n').slice(0, 6).join('\n')}`);
    const lock = turnLock || path.join(prod, 'logs', 'orchestrateur.turnlock');
    if (fs.existsSync(lock)) problems.push(`un tour de l'orchestrateur est en cours (${lock}) : attendre qu'il finisse`);
    if (commit) {
      const head = git(prod, ['rev-parse', 'HEAD']).out;
      const known = git(prod, ['cat-file', '-e', `${commit}^{commit}`]).ok;
      if (known && !git(prod, ['merge-base', '--is-ancestor', head, commit]).ok) problems.push(`pas d'avance rapide possible : la prod (${head.slice(0, 7)}) n'est pas un ancêtre de ${tag}`);
      // The tag is usually not in production yet: check from the dev side too.
      if (!known) {
        if (!git(dev, ['cat-file', '-e', `${head}^{commit}`]).ok) problems.push(`pas d'avance rapide vérifiable : le commit de la prod (${head.slice(0, 7)}) est inconnu de la dev (git fetch prod, puis le fusionner dans dev)`);
        else if (!git(dev, ['merge-base', '--is-ancestor', head, commit]).ok) problems.push(`pas d'avance rapide possible : la prod (${head.slice(0, 7)}) n'est pas un ancêtre de ${tag}`);
      }
      keep = keptOnDisk({ dev, prodHead: head, commit });
    }
  }
  const plan = jumpPlan({ prod, tag, from, keep, unit: policy.on });
  return { ok: !problems.length, problems, plan, report, tree, commit, keep };
}

// 0.125.0, user rule (2026-10-20): « Aucune non regression ne doit se lancer
// sur orchestrateur. C'etait une regle. Uniquement sur orchestrateur-dev ».
// The jump never prescribes nor runs a non-regression in production.
export const AFTER_APPLY = 'Reste : redémarrage par le chef quand la flotte est au repos, puis non-régression sur orchestrateur-dev.';
// 0.142.0: the full run is not prescribed after the jump: the program runs it while idle.
export const AFTER_APPLY_UNIT = 'Reste : redémarrage par le chef quand la flotte est au repos. La non-régression complète tourne a posteriori, pendant l’inactivité, sur orchestrateur-dev (idle-regression.mjs) — jamais en prod.';

/** The printed plan: git steps in production, then the restart; no test there. */
export function jumpPlan({ prod, tag, from = 'origin', keep = [], unit = false }) {
  return [
    `git -C ${prod} tag -a prod-before-${tag} -m "production before the jump to ${tag}"`,
    `git -C ${prod} fetch ${from} tag ${tag}`,
    `git -C ${prod} merge --ff-only ${tag}`,
    ...keep.map(f => `remettre ${f} sur le disque (n'est plus suivi par git depuis ${tag}) : contenu de prod-before-${tag}:${f}`),
    unit ? 'redémarrage par le chef quand la flotte est au repos ; la non-régression complète tourne a posteriori, pendant l’inactivité, sur orchestrateur-dev (jamais en prod)'
      : 'redémarrage par le chef quand la flotte est au repos, puis non-régression sur orchestrateur-dev (jamais en prod)',
  ];
}

/** Steps 1-3 of the plan (tag, fetch, fast-forward), then the kept files; never restarts anything. */
export function applyJump({ prod, tag, from = 'origin', keep = [] }) {
  const steps = [
    ['tag', ['tag', '-a', `prod-before-${tag}`, '-m', `production before the jump to ${tag}`]],
    ['fetch', ['fetch', from, 'tag', tag, '--no-tags']],
    ['merge', ['merge', '--ff-only', tag]],
  ];
  for (const [name, args] of steps) {
    const r = git(prod, args);
    if (!r.ok) return { ok: false, step: name, err: r.err };
  }
  const restored = [];
  for (const f of keep) {
    const to = path.join(prod, f);
    if (fs.existsSync(to)) continue;
    const r = spawnSync('git', ['-C', prod, 'show', `prod-before-${tag}:${f}`], { windowsHide: true });
    if (r.status !== 0) return { ok: false, step: `keep ${f}`, err: String(r.stderr || '') };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, r.stdout);
    restored.push(f);
  }
  return { ok: true, restored };
}

async function main() {
  const tag = opt('--tag'), prod = opt('--prod'), from = opt('--from') || 'origin';
  if (!tag || !prod) { console.error('usage: prod-jump.mjs --tag vX.Y.Z --prod <chemin du dépôt de prod> [--from origin|<chemin>] [--unit] [--apply]'); process.exit(64); }
  const p = preflight({ prod: path.resolve(prod), tag, from, unit: argv.includes('--unit') });
  for (const a of p.report?.accepted || []) console.log(`KO accepté (docs/known-ko.json) : ${a.id} — ${a.reason}`);
  if (!p.ok) {
    console.error(`[prod-jump] MISE EN PROD REFUSÉE (${tag}) :`);
    for (const x of p.problems) console.error(`  - ${x}`);
    process.exit(1);
  }
  if (p.report.unit) {
    console.log(`[prod-jump] ${tag} : tests de la tâche verts (${path.basename(p.report.file)}, mode ${p.report.mode}) — mise en prod possible sans non-régression complète (${p.report.why})`);
    console.log(`[prod-jump] non-régression a posteriori (information, jamais une condition) : ${posterioriState(path.resolve(prod))}`);
  }
  const kind = p.report.unit ? null : p.report.mode === 'perimeter' ? `PAR PÉRIMÈTRE depuis la prod (${p.report.plan.perimeters.map(x => x.id).join(', ') || 'socle seul'})` : 'COMPLÈTE';
  if (kind) console.log(`[prod-jump] ${tag} : non-régression ${kind} verte (${path.basename(p.report.file)}) — mise en prod possible`);
  console.log(p.plan.map((s, i) => `  ${i + 1}. ${s}`).join('\n'));
  if (!argv.includes('--apply')) { console.log('[prod-jump] plan seulement (ajouter --apply, sur décision de l’utilisateur)'); return; }
  const r = applyJump({ prod: path.resolve(prod), tag, from, keep: p.keep });
  if (!r.ok) { console.error(`[prod-jump] échec à l'étape ${r.step} : ${r.err}`); process.exit(1); }
  for (const f of r.restored) console.log(`[prod-jump] ${f} remis sur le disque (non suivi par git, contenu de prod-before-${tag})`);
  console.log(`[prod-jump] prod avancée sur ${tag} (retour : git reset --hard prod-before-${tag}). ${p.report.unit ? AFTER_APPLY_UNIT : AFTER_APPLY}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
