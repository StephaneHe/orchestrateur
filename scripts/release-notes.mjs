// ============================================================================
// scripts/release-notes.mjs — the growing list that leads to the release note
// (0.97.0)
// ============================================================================
//
// User request (2026-10-14): « Je dois voir comme TODO ou GIT, une liste qui
// augmente au fur et a mesure et qui conduira a la release note en fonction de
// ce qui est pret ». User choices: the source is the CHANGELOG; the starting
// point is found by the orchestrator itself (« l'orchestrateur est sensé
// connaître sa propre version »); the release note stays in the CHANGELOG's
// language (no translation, no model).
//
//   ✓ ready       = every version of the CHANGELOG newer than the last release
//   ⏳ in progress = the [Unreleased] bullets + the TODO items being worked on
//   release note  = the ready versions only, merged by Keep a Changelog section
//
// Last release (automatic, deterministic — never a manual step):
//   1. the orchestrator itself (the server's own checkout): the version the
//      running server knows (its package.json at boot);
//   2. a dev instance (`devOf: X` in config.json): the last release of X — for
//      the orchestrator's dev instance, the version production runs;
//   3. any other project: its latest `v*` git tag reachable from HEAD;
//   4. none of these: no release found yet — every version counts as ready.
// Pure functions except `lastRelease` (git, read-only: `git describe`).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SECTION_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const VERSION_RE = /^##\s*\[([^\]]+)\](?:\s*[-–—]\s*(\d{4}-\d{2}-\d{2}))?/;

/** Semver-ish comparison ("0.10.0" > "0.9.3"); non-numeric parts compare as text. */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/), pb = String(b).replace(/^v/i, '').split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0', y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx < ny ? -1 : 1; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Keep a Changelog → {unreleased: {sections}, versions: [{version, date, sections}]}.
 * sections = [{name, items: [text]}] in file order; an item keeps its
 * indented continuation lines (sub-bullets), verbatim.
 */
export function parseChangelog(text) {
  const out = { unreleased: null, versions: [] };
  let block = null, section = null, item = null;
  const flush = () => { item = null; };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const v = VERSION_RE.exec(raw);
    if (v) {
      flush();
      section = null;
      block = { version: v[1].trim(), date: v[2] || null, sections: [] };
      if (/^unreleased$/i.test(block.version)) out.unreleased = block; else out.versions.push(block);
      continue;
    }
    if (!block) continue;
    const s = /^###\s+(.+?)\s*$/.exec(raw);
    if (s) { flush(); section = { name: s[1], items: [] }; block.sections.push(section); continue; }
    if (/^##\s/.test(raw)) { flush(); block = null; continue; }
    const b = /^[-*]\s+(.*)$/.exec(raw);
    if (b) {
      if (!section) { section = { name: '', items: [] }; block.sections.push(section); }
      item = { text: b[1] };
      section.items.push(item);
      continue;
    }
    if (item && /^\s+\S/.test(raw)) { item.text += '\n' + raw.replace(/^ {2}/, ''); continue; }
    if (!raw.trim()) continue;
    item = null;
  }
  const plain = (blk) => blk && { ...blk, sections: blk.sections.map(se => ({ name: se.name, items: se.items.map(i => i.text) })).filter(se => se.items.length) };
  return { unreleased: plain(out.unreleased), versions: out.versions.map(plain) };
}

const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/i;
const norm = (v) => String(v || '').trim().replace(/^v/i, '');

/**
 * Versions newer than the last release. A Keep a Changelog file lists the
 * newest first, so what stands ABOVE the released entry is ready — this also
 * holds for headings that are not plain X.Y.Z (e.g. « android 0.4.7 / vc12 »).
 * Released entry missing from the file: X.Y.Z headings greater than it.
 */
export function readyVersions(versions, releaseVersion) {
  if (!releaseVersion) return versions;
  const k = versions.findIndex(v => norm(v.version) === norm(releaseVersion));
  if (k >= 0) return versions.slice(0, k);
  return versions.filter(v => SEMVER_RE.test(v.version.trim()) && compareVersions(v.version, releaseVersion) > 0);
}

/**
 * The growing list. `release` = {version|null, source, label}; `todos` = TODO
 * items of the project (scripts/todo-core.mjs parseTodo). Newest first.
 */
export function releaseList({ changelog, release = { version: null, source: 'none' }, todos = [] }) {
  const cl = typeof changelog === 'string' ? parseChangelog(changelog) : changelog;
  const ready = readyVersions(cl.versions, release.version);
  const progress = [];
  for (const se of cl.unreleased?.sections || []) for (const t of se.items) progress.push({ state: 'progress', origin: 'unreleased', section: se.name, text: t });
  for (const t of todos) if (t.status === 'progress') progress.push({ state: 'progress', origin: 'todo', id: t.id, text: t.title, since: t.addedAt || null });
  const items = [
    ...progress,
    ...ready.flatMap(v => v.sections.flatMap(se => se.items.map(t => ({ state: 'ready', version: v.version, date: v.date, section: se.name, text: t })))),
  ];
  return {
    release, readyVersions: ready.map(v => ({ version: v.version, date: v.date })),
    counts: { ready: items.filter(i => i.state === 'ready').length, progress: progress.length },
    items, groups: groupByRelease(items), note: releaseNote({ versions: ready, release }),
  };
}

/**
 * The list grouped by release (0.98.0, user request « les items doivent etre
 * regroupes par release »): first the not-yet-released group (⏳ in progress:
 * [Unreleased] + TODO), then one group per ready version, newest first. Each
 * item keeps its index in `items`, so a detail view can show it in full.
 */
export function groupByRelease(items) {
  const groups = [];
  const progress = items.map((it, index) => ({ ...it, index })).filter(i => i.state === 'progress');
  if (progress.length) groups.push({ key: 'progress', state: 'progress', version: null, date: null, items: progress });
  const byVersion = new Map();
  items.forEach((it, index) => {
    if (it.state !== 'ready') return;
    if (!byVersion.has(it.version)) {
      const g = { key: `v:${it.version}`, state: 'ready', version: it.version, date: it.date || null, items: [] };
      byVersion.set(it.version, g);
      groups.push(g);
    }
    byVersion.get(it.version).items.push({ ...it, index });
  });
  for (const g of groups) g.sections = [...new Set(g.items.map(i => i.section || ''))].filter(Boolean);
  return groups;
}

/** Markdown release note: ready versions only, merged by Keep a Changelog section, verbatim. */
export function releaseNote({ versions, release = {}, project = '' }) {
  if (!versions.length) return '';
  const sorted = [...versions].sort((a, b) => compareVersions(a.version, b.version));
  const first = sorted[0], last = sorted[sorted.length - 1];
  const bySection = new Map();
  for (const v of [...sorted].reverse()) for (const se of v.sections) {
    const k = se.name || 'Other';
    if (!bySection.has(k)) bySection.set(k, []);
    for (const t of se.items) bySection.get(k).push({ version: v.version, text: t });
  }
  const names = [...SECTION_ORDER.filter(n => bySection.has(n)), ...[...bySection.keys()].filter(n => !SECTION_ORDER.includes(n))];
  const head = `# ${project ? `${project} ` : ''}${last.version}${last.date ? ` - ${last.date}` : ''}`;
  // Language-neutral framing (numbers and arrows only): the text itself stays
  // the CHANGELOG's, untranslated (user choice).
  const L = [head, '', `> ${release.version ? `${release.version} → ` : ''}${sorted.map(v => v.version).join(' · ')}`, ''];
  for (const n of names) {
    L.push(`## ${n}`, '');
    for (const it of bySection.get(n)) {
      const [firstLine, ...rest] = it.text.split('\n');
      L.push(`- ${firstLine}${sorted.length > 1 ? ` _(${it.version})_` : ''}`, ...rest.map(r => `  ${r}`));
    }
    L.push('');
  }
  return L.join('\n').trimEnd() + '\n';
}

/** Latest `v*` tag reachable from HEAD (read-only git), or null. */
export function latestVersionTag(dir) {
  const r = spawnSync('git', ['-C', dir, 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const tag = (r.stdout || '').trim();
  return r.status === 0 && tag ? tag : null;
}

/**
 * The last release of `project`, found automatically (see the header).
 * `serverRoot` / `serverVersion`: the orchestrator serving the dashboard.
 */
export function lastRelease(project, { projects = [], serverRoot, serverVersion, tagOf = latestVersionTag, seen = new Set() } = {}) {
  const same = (a, b) => a && b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (same(project.path, serverRoot)) return { version: serverVersion || null, source: 'server', label: `version de l’orchestrateur en service (${serverVersion})` };
  if (project.devOf && !seen.has(project.name)) {
    const of = projects.find(p => p && p.name === project.devOf);
    if (of) {
      const r = lastRelease(of, { projects, serverRoot, serverVersion, tagOf, seen: new Set([...seen, project.name]) });
      return { ...r, source: `devOf:${r.source}`, label: `${r.label}, celle de ${of.name} (instance de dev)` };
    }
  }
  const tag = fs.existsSync(path.join(project.path, '.git')) ? tagOf(project.path) : null;
  if (tag) return { version: tag.replace(/^v/i, ''), source: 'tag', tag, label: `dernier tag de version ${tag}` };
  return { version: null, source: 'none', label: 'aucune release repérée (ni tag v*) : toutes les versions comptent comme prêtes' };
}
