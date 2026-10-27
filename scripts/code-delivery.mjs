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

// ---------------------------------------------------------------------------
// Version MENTIONS (0.140.0): other places that show the project's version.
// Prod run of 2026-10-23: package.json went to 1.9.0, the README still said
// « - **Version** : `1.8.1` », a requirement test of the project checked both,
// and « corriger le code » relaunched the very same program delivery, twice.
// Declared in .orchestrateur/pipeline.json → `versionMentions`: a path (the
// README convention, else the first `version … X.Y.Z` line) or
// {file, regex} with ONE capture group = the version. Plus, undeclared, the
// README convention: a line starting with « Version » (bullet, bold allowed).
// ---------------------------------------------------------------------------
const README_VERSION_RE = /^([ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?version(?:\*\*|__)?[ \t]*(?:\*\*|__)?[ \t]*[:=][ \t]*(?:\*\*|__)?[ \t]*`?v?)(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/im;
const GENERIC_VERSION_RE = /^(.*?\bversion\b[^\n0-9]{0,40}?v?)(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/im;
const SEMVER = /^\d+\.\d+\.\d+/;

/** Mentions to keep equal to the version: [{file, re, declared}] (never a version file itself). */
export function versionMentions(cwd, cfg = {}) {
  const own = new Set((cfg.versionFiles || []).map(f => f.replace(/\\/g, '/').toLowerCase()));
  const out = [];
  const seen = new Set();
  const push = (file, re, declared) => {
    const k = file.replace(/\\/g, '/').toLowerCase();
    if (own.has(k) || seen.has(k)) return;
    seen.add(k); out.push({ file: file.replace(/\\/g, '/'), re, declared });
  };
  for (const m of Array.isArray(cfg.versionMentions) ? cfg.versionMentions : []) {
    if (typeof m === 'string' && m.trim()) push(m.trim(), null, true);
    else if (m && typeof m.file === 'string') {
      let re = null;
      try { re = m.regex ? new RegExp(m.regex, String(m.flags || 'm').replace(/[^imsu]/g, '')) : null; } catch { re = 'invalid'; }
      push(m.file, re, true);
    }
  }
  let names = []; try { names = fs.readdirSync(cwd); } catch { /* no folder */ }
  const readme = names.find(n => /^readme(\.md|\.markdown|\.txt)?$/i.test(n));
  if (readme) {
    let s = ''; try { s = fs.readFileSync(path.join(cwd, readme), 'utf8'); } catch {}
    if (README_VERSION_RE.test(s)) push(readme, null, false);
  }
  return out;
}

/** Where the version sits in a mention's text: {index, value, line} | null. */
function mentionSlot(text, re) {
  if (re === 'invalid') return null;
  if (re) {
    const m = re.exec(text);
    if (!m || m[1] == null) return null;
    const at = m.index + m[0].indexOf(m[1]);
    return { index: at, value: m[1], line: text.slice(0, at).split('\n').length };
  }
  const m = README_VERSION_RE.exec(text) || GENERIC_VERSION_RE.exec(text);
  if (!m) return null;
  const at = m.index + m[1].length;
  return { index: at, value: m[2], line: text.slice(0, at).split('\n').length };
}

/**
 * Writes `version` in every mention. → { updated: [file], stale: [{file, line?, found?, why}] }
 * A declared mention the program cannot find stays stale, named precisely.
 */
export function syncVersionMentions(cwd, cfg, version) {
  const updated = [], stale = [];
  for (const m of versionMentions(cwd, cfg)) {
    const f = path.join(cwd, m.file);
    let s;
    try { s = fs.readFileSync(f, 'utf8'); } catch { stale.push({ file: m.file, why: 'fichier introuvable' }); continue; }
    const slot = mentionSlot(s, m.re);
    if (!slot) { stale.push({ file: m.file, why: m.re === 'invalid' ? 'expression « regex » invalide dans pipeline.json' : 'mention de version introuvable dans le fichier' }); continue; }
    if (slot.value === version) continue;
    if (!SEMVER.test(slot.value)) { stale.push({ file: m.file, line: slot.line, found: slot.value, why: `« ${slot.value} » n’est pas un numéro de version` }); continue; }
    fs.writeFileSync(f, s.slice(0, slot.index) + version + s.slice(slot.index + slot.value.length));
    updated.push(m.file);
  }
  return { updated, stale };
}

/** One line naming every stale mention (file, line, value found, expected). */
export function staleText(stale, version) {
  return stale.map(x => `${x.file}${x.line ? ` ligne ${x.line}` : ''}${x.found ? ` (« ${x.found} » au lieu de « ${version} »)` : ''} : ${x.why}`).join(' ; ');
}

/**
 * After a red suite: tracked lines that still show the old version next to the
 * word « version » (version files, CHANGELOG, the requirement register, lockfiles excluded).
 */
export function staleVersionHints(cwd, from, to, cfg = {}) {
  if (!from || !to || from === to) return [];
  const r = git(cwd, ['grep', '-n', '-I', '-F', '-e', from, '--', '.', ':!node_modules', ':!*.lock', ':!package-lock.json', ':!npm-shrinkwrap.json',
    `:!${cfg.changelog || 'CHANGELOG.md'}`, ...(cfg.requirements ? [`:!${cfg.requirements}`] : []), ...(cfg.versionFiles || []).map(v => `:!${v}`), ':!changelog.d']);
  if (!r.ok) return [];
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return r.out.split('\n').map(l => /^([^:]+):(\d+):(.*)$/.exec(l)).filter(Boolean)
    .filter(m => /version/i.test(m[3]) && new RegExp(`(^|[^0-9.])v?${esc}(?![0-9])`).test(m[3]))
    .slice(0, 10).map(m => ({ file: m[1], line: Number(m[2]), found: from, text: m[3].trim().slice(0, 160), why: `affiche encore ${from}` }));
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
 *   only: the run's own files; the commit carries just these plus the CHANGELOG,
 *     register, version files and version mentions (null = everything changed)
 * → { ok, version, commit, noCommit?, files } | { ok: false, why }
 */
export function deliverRelease(cwd, cfg, text, { prebump = null, versionBase = null, lane = null, date = new Date().toISOString().slice(0, 10), run = '', gateCheck = null, only = null } = {}) {
  const cl = path.join(cwd, cfg.changelog || 'CHANGELOG.md');
  const req = cfg.requirements ? path.join(cwd, cfg.requirements) : null;
  let version = null, from = null;
  if (lane) {
    fs.mkdirSync(path.dirname(path.join(cwd, lane.fragment)), { recursive: true });
    fs.writeFileSync(path.join(cwd, lane.fragment), `---\nbump: ${text.bump || 'patch'}\n---\n\n${text.changelog.trim()}\n`);
    if (req) appendRequirement(req, text.requirement.replace(/\{version\}/g, 'à l’intégration'));
  } else if (prebump) {
    version = prebump.to; from = prebump.from || null;
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
      from = from || slot.version;
      version = version || bumpVersion(slot.version, text.bump);
      s = s.replace(slot.re, (m, a, v, b) => `${a}${version}${b}`);
      if (/versionName/.test(s)) s = s.replace(/(versionCode\s*=?\s*)(\d+)/, (m, a, n) => `${a}${Number(n) + 1}`);
      fs.writeFileSync(f, s);
    }
    if (version) insertChangelogEntry(cl, version, text.changelog.replace(/\{version\}/g, version), date);
    else if (fs.existsSync(cl)) addUnreleased(cl, text.changelog);
    if (req) appendRequirement(req, text.requirement.replace(/\{version\}/g, version || ''));
  }
  // Every other mention of the version follows it, or the step fails naming the file.
  let mentions = [];
  if (!lane && version) {
    const sync = syncVersionMentions(cwd, cfg, version);
    mentions = sync.updated;
    if (sync.stale.length) {
      return { ok: false, version, from, staleVersion: sync.stale,
        why: `mention(s) de version pas à jour après le passage à ${version} : ${staleText(sync.stale, version)} — le programme n’a pas pu l’écrire (déclarer l’emplacement dans .orchestrateur/pipeline.json → versionMentions, ou confier la livraison au model)` };
    }
  }
  const subject = subjectOf(text.changelog);
  const message = lane
    ? `docs(changelog): fragment for ${path.basename(lane.fragment, '.md')}${subject ? ` — ${subject}` : ''}`
    : `chore(release): ${version ? `v${version}` : 'delivery'}${subject ? ` — ${subject}` : ''}`;
  const commitMessage = `${message}\n\nDelivered by the orchestrator (pipeline run ${run}): version, CHANGELOG and commit written by the program.`;
  // `only` (the run's own files) gains the files the release itself wrote.
  const paths = Array.isArray(only)
    ? [...new Set([...only, ...[cfg.changelog || 'CHANGELOG.md', ...(cfg.requirements ? [cfg.requirements] : []), ...(cfg.versionFiles || []), ...mentions, ...(lane ? [lane.fragment] : [])].filter(f => fs.existsSync(path.join(cwd, f)))])]
    : null;
  let c = commitWork(cwd, commitMessage, paths);
  // The pre-commit delivery gate wants a green report for the exact release tree,
  // which only exists once the project's checks ran on it: run them, retry once.
  if (!c.ok && gateCheck && /delivery-gate/.test(String(c.err))) {
    try { gateCheck(cwd); } catch {}
    c = commitWork(cwd, commitMessage, paths);
  }
  if (!c.ok) {
    // Keep the hook's whole report and the files left uncommitted: a bare first line
    // made the pause read "the step modified no file" (runs of 26-27/10).
    // -z: exact paths; a rename/copy entry is followed by its origin path, skipped.
    const parts = git(cwd, ['status', '--porcelain', '-z']).out.split('\0').filter(Boolean);
    const changed = [];
    for (let i = 0; i < parts.length; i++) {
      changed.push(parts[i].slice(3));
      if (/^[RC]/.test(parts[i])) i++;
    }
    const reason = String(c.err).split('\n').map(l => l.trim()).filter(Boolean).slice(0, 12).join(' | ');
    return { ok: false, version, from, changed, why: `commit impossible : ${reason}` };
  }
  return { ok: true, version, from, mentions, commit: c.commit || null, noCommit: !!c.empty };
}

/** A delivery without version (Rédaction, media): one commit of what changed. */
export function deliverCommit(cwd, { title = '', run = '' } = {}) {
  const c = commitWork(cwd, `docs: ${String(title || 'delivery').replace(/\s+/g, ' ').slice(0, 90)}\n\nDelivered by the orchestrator (pipeline run ${run}): commit written by the program.`);
  if (!c.ok) return { ok: false, why: `commit impossible : ${String(c.err).split('\n')[0]}` };
  if (c.empty) return { ok: false, why: 'rien à commiter' };
  return { ok: true, commit: c.commit };
}
