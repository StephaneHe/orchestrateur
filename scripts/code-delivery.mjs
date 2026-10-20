// ============================================================================
// scripts/code-delivery.mjs — Livrer done by the program (pipelines phase 0 b)
// ============================================================================
//
// User decision 9 (2026-10-20, « tout comme recommandé » on
// docs/PIPELINES-SYNTHESE.md): « Livraison faite par le programme (version,
// CHANGELOG, commit) au lieu d'un model : mêmes vérifications ». Switch
// `codeDeliver` (pipeline-tuning.mjs).
//
// Measured on the prod logs: 11 Livrer refusals out of 30 (9 « aucun commit
// créé », 2 « version non incrémentée »), one run with 8 identical refusals.
// The model now writes only TEXT — the CHANGELOG entry, the requirement line,
// a summary — in its artefact, and touches no file; this module bumps the
// version files, inserts the CHANGELOG entry, appends the requirement line
// and commits. The engine then runs the very same Livrer criterion as before.
//
// Two shapes:
//   - release (a step with crit 'livrer': Dev, Incident, Maintenance, Audit,
//     Nouveau, Réunion): text from the model, everything else by the code;
//   - commit (a delivery without version: Rédaction, Images, Vidéo, Audio):
//     no model at all, one commit of the changed files.
// A project whose version files the code cannot rewrite keeps the model
// delivery (never a guess): `releasePlan` says why.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitWork } from './item-delivery.mjs';

const BUMPS = ['patch', 'minor', 'major'];

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, ''), err: (r.stderr || '').trim() };
}

// Version formats the code rewrites — the ones readVersion() of the engine reads.
const FORMATS = [
  { test: (f) => /\.json$/i.test(f), re: /("version"\s*:\s*")([^"]+)(")/ },
  { test: () => true, re: /(versionName\s*=?\s*["'])([^"']+)(["'])/ },
  { test: () => true, re: /^(version\s*=\s*["'])([0-9][^"'\s]*)(["'])/m },
];
function versionSlot(file, text) {
  for (const f of FORMATS) {
    if (!f.test(file)) continue;
    const m = f.re.exec(text);
    if (m) return { re: f.re, version: m[2] };
  }
  return null;
}

export function bumpVersion(v, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  if (!m) return null;
  let [a, b, c] = m.slice(1).map(Number);
  if (bump === 'major') { a++; b = 0; c = 0; } else if (bump === 'minor') { b++; c = 0; } else c++;
  return `${a}.${b}.${c}`;
}

/**
 * Can the code deliver this release? → { ok: true } | { ok: false, why }.
 * Every version file must exist and carry a semver the code can rewrite;
 * corrections left for the delivery (old paused runs, 0.50.1) need a model.
 */
export function releasePlan(cwd, cfg, { deliveryFixes = [], lane = null } = {}) {
  if (deliveryFixes.length) return { ok: false, why: 'des corrections de documentation sont à faire pendant la livraison (exécution d’un ancien moteur)' };
  if (lane) return { ok: true };
  for (const vf of cfg.versionFiles || []) {
    let txt; try { txt = fs.readFileSync(path.join(cwd, vf), 'utf8'); } catch { return { ok: false, why: `fichier de version ${vf} illisible` }; }
    const slot = versionSlot(vf, txt);
    if (!slot || !/^\d+\.\d+\.\d+/.test(slot.version)) return { ok: false, why: `format de version de ${vf} non pris en charge par le programme` };
  }
  return { ok: true };
}

const SECTION_RE = /^##\s+(changelog|exigence|livr[eé])\s*$/gim;
/**
 * The model's text: front matter `bump:` then sections « ## CHANGELOG »,
 * « ## Exigence », « ## Livré ». → { bump, changelog, requirement, summary } | { error }
 */
export function parseDeliveryText(text, { needBump = true, needRequirement = false } = {}) {
  const s = String(text || '').replace(/\r\n/g, '\n');
  const fm = /^\s*---\n([\s\S]*?)\n---\n?/.exec(s);
  const declared = fm && /^\s*bump\s*:\s*(\S+)\s*$/m.exec(fm[1])?.[1];
  const body = fm ? s.slice(fm[0].length) : s;
  const sections = {};
  const heads = [...body.matchAll(SECTION_RE)];
  heads.forEach((h, i) => {
    const key = /^changelog$/i.test(h[1]) ? 'changelog' : /^exigence$/i.test(h[1]) ? 'requirement' : 'summary';
    sections[key] = body.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined).trim();
  });
  if (needBump && !BUMPS.includes(declared)) return { error: `en-tête « ---\\nbump: patch|minor|major\\n--- » manquant ou invalide (reçu « ${declared || '—'} »)` };
  if (!sections.changelog) return { error: 'section « ## CHANGELOG » absente ou vide : écris l’entrée (### Added, ### Fixed…), sans la ligne de version' };
  if (/^##\s+\[/m.test(sections.changelog)) return { error: 'la section « ## CHANGELOG » ne doit pas contenir la ligne « ## [X.Y.Z] - date » : le programme l’écrit' };
  if (needRequirement && !sections.requirement) return { error: 'section « ## Exigence » absente ou vide : écris la ligne à ajouter au registre des exigences' };
  return { bump: BUMPS.includes(declared) ? declared : null, changelog: sections.changelog, requirement: sections.requirement || '', summary: sections.summary || '' };
}

function insertChangelogEntry(file, version, body, date) {
  let cl = ''; try { cl = fs.readFileSync(file, 'utf8'); } catch { cl = '# Changelog\n\n'; }
  const eol = cl.includes('\r\n') ? '\r\n' : '\n';
  const entry = `## [${version}] - ${date}\n\n${body.trim()}\n\n`.replace(/\n/g, eol);
  const at = cl.search(/^## \[\d/m);
  fs.writeFileSync(file, at === -1 ? `${cl.replace(/\s*$/, `${eol}${eol}`)}${entry}` : cl.slice(0, at) + entry + cl.slice(at));
}

/** No version file: the entry goes under « ## [Unreleased] » (created above the releases if absent). */
function addUnreleased(file, body) {
  const cl = fs.readFileSync(file, 'utf8');
  const eol = cl.includes('\r\n') ? '\r\n' : '\n';
  const text = `${body.trim()}${eol}${eol}`.replace(/\r?\n/g, eol);
  const m = /^## \[Unreleased\][^\n]*\n/im.exec(cl);
  if (m) { const at = m.index + m[0].length; fs.writeFileSync(file, `${cl.slice(0, at)}${eol}${text}${cl.slice(at).replace(/^\r?\n/, '')}`); return; }
  const at = cl.search(/^## \[/m);
  const block = `## [Unreleased]${eol}${eol}${text}`;
  fs.writeFileSync(file, at === -1 ? `${cl.replace(/\s*$/, `${eol}${eol}`)}${block}` : cl.slice(0, at) + block + cl.slice(at));
}

/** Appends the requirement line(s) after the last table row of the register (or at its end). */
export function appendRequirement(file, text) {
  let s = ''; try { s = fs.readFileSync(file, 'utf8'); } catch { /* new register */ }
  const eol = s.includes('\r\n') ? '\r\n' : '\n';
  const lines = s.split(/\r?\n/);
  const add = String(text).trim().split(/\r?\n/);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*\|/.test(lines[i])) { last = i; break; }
  if (last >= 0) lines.splice(last + 1, 0, ...add);
  else { while (lines.length && lines.at(-1) === '') lines.pop(); lines.push(...add, ''); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join(eol).replace(new RegExp(`(${eol})*$`), eol));
}

const subjectOf = (changelog) => (String(changelog).split('\n').map(l => l.replace(/^[-*]\s+/, '').trim()).find(l => l && !/^#/.test(l)) || '').replace(/\s+/g, ' ').slice(0, 90);

/**
 * Writes the release and commits it.
 *   prebump: {from, to} — the version was already bumped by an item of the run
 *   versionBase: commit the run's version is measured from (prebump only)
 *   lane: {fragment} — in a lane, a changelog.d fragment instead (0.102.0)
 * → { ok, version, commit, noCommit?, files } | { ok: false, why }
 */
export function deliverRelease(cwd, cfg, text, { prebump = null, versionBase = null, lane = null, date = new Date().toISOString().slice(0, 10), run = '' } = {}) {
  const cl = path.join(cwd, cfg.changelog || 'CHANGELOG.md');
  const req = cfg.requirements ? path.join(cwd, cfg.requirements) : null;
  let version = null;
  if (lane) {
    fs.mkdirSync(path.dirname(path.join(cwd, lane.fragment)), { recursive: true });
    fs.writeFileSync(path.join(cwd, lane.fragment), `---\nbump: ${text.bump || 'patch'}\n---\n\n${text.changelog.trim()}\n`);
    if (req) appendRequirement(req, text.requirement.replace(/\{version\}/g, 'à l’intégration'));
  } else if (prebump) {
    version = prebump.to;
    let cur = ''; try { cur = fs.readFileSync(cl, 'utf8'); } catch {}
    if (!cur.includes(`## [${version}]`)) insertChangelogEntry(cl, version, text.changelog.replace(/\{version\}/g, version), date);
    const reqDone = req && versionBase && git(cwd, ['diff', '--name-only', `${versionBase}..HEAD`, '--', cfg.requirements]).out;
    if (req && !reqDone) appendRequirement(req, text.requirement.replace(/\{version\}/g, version));
  } else {
    const files = cfg.versionFiles || [];
    for (const vf of files) {
      const f = path.join(cwd, vf);
      let s = fs.readFileSync(f, 'utf8');
      const slot = versionSlot(vf, s);
      if (!slot) return { ok: false, why: `version introuvable dans ${vf}` };
      version = version || bumpVersion(slot.version, text.bump);
      s = s.replace(slot.re, (m, a, v, b) => `${a}${version}${b}`);
      if (/versionName/.test(s)) s = s.replace(/(versionCode\s*=?\s*)(\d+)/, (m, a, n) => `${a}${Number(n) + 1}`);
      fs.writeFileSync(f, s);
    }
    if (version) insertChangelogEntry(cl, version, text.changelog.replace(/\{version\}/g, version), date);
    else if (fs.existsSync(cl)) addUnreleased(cl, text.changelog);
    if (req) appendRequirement(req, text.requirement.replace(/\{version\}/g, version || ''));
  }
  const subject = subjectOf(text.changelog);
  const message = lane
    ? `docs(changelog): fragment for ${path.basename(lane.fragment, '.md')}${subject ? ` — ${subject}` : ''}`
    : `chore(release): ${version ? `v${version}` : 'delivery'}${subject ? ` — ${subject}` : ''}`;
  const c = commitWork(cwd, `${message}\n\nDelivered by the orchestrator (pipeline run ${run}): version, CHANGELOG and commit written by the program.`);
  if (!c.ok) return { ok: false, why: `commit impossible : ${String(c.err).split('\n')[0]}` };
  return { ok: true, version, commit: c.commit || null, noCommit: !!c.empty };
}

/** A delivery without version (Rédaction, media): one commit of what changed. */
export function deliverCommit(cwd, { title = '', run = '' } = {}) {
  const c = commitWork(cwd, `docs: ${String(title || 'delivery').replace(/\s+/g, ' ').slice(0, 90)}\n\nDelivered by the orchestrator (pipeline run ${run}): commit written by the program.`);
  if (!c.ok) return { ok: false, why: `commit impossible : ${String(c.err).split('\n')[0]}` };
  if (c.empty) return { ok: false, why: 'rien à commiter' };
  return { ok: true, commit: c.commit };
}
