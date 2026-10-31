// ============================================================================
// scripts/downloads-register.mjs — add an Android app to downloads.json
// ============================================================================
//
// PitchRoll (2026-10-31): its APK was published under builds/ but the page
// /downloads answered 404, because nothing ever wrote its downloads.json
// entry. new-project.mjs cannot always do it: a fresh project has no Android
// module yet (PitchRoll got app/ 26 min after its creation). So the entry is
// added by whoever first sees the module: new-project.mjs (existing Android
// project) and copy-build.mjs (every APK publication).
//
// Additive and idempotent: an existing entry is never modified; the file is
// edited textually (hand-aligned lines kept), the result is validated with the
// real registry rules before an atomic write, and a broken file is left alone.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { validateRegistry, VERSION_NAME_RE } from './downloads-registry.mjs';
import { writeFileAtomic } from './atomic-file.mjs';

const GRADLE_CANDIDATES = [
  ['android', 'app', 'build.gradle.kts'],
  ['android', 'app', 'build.gradle'],
  ['app', 'build.gradle.kts'],
  ['app', 'build.gradle'],
];

/** Gradle file of the app module of an Android project, or null. */
export function androidAppGradle(dir) {
  for (const parts of GRADLE_CANDIDATES) {
    const f = path.join(dir, ...parts);
    if (fs.existsSync(f)) {
      const text = fs.readFileSync(f, 'utf8');
      if (/com\.android\.application|android\.application/.test(text)) return f;
    }
  }
  return null;
}

/** Version source for the downloads card: the gradle file when it holds a
 *  literal versionName, else the package.json it reads the version from. */
export function versionSource(gradleFile, dir) {
  const text = fs.readFileSync(gradleFile, 'utf8');
  if (VERSION_NAME_RE.test(text)) return { file: gradleFile };
  const pkg = path.join(dir, 'package.json');
  if (/package\.json/.test(text) && fs.existsSync(pkg)) {
    return { file: pkg, regex: '"version"\\s*:\\s*"([^"]+)"' };
  }
  return { file: gradleFile };
}

/** One-line JSON in the file's style: `{ "k": v, "o": { … } }`. */
function inline(v) {
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`;
  return JSON.stringify(v);
}

/**
 * Adds `{name, version}` to downloads.json if no app of that name exists.
 * Returns {status: 'added'|'exists'|'not-android'|'invalid', file, entry?, why?}.
 */
export function registerDownloadApp(root, { name, dir }) {
  const file = path.join(root, 'downloads.json');
  const gradle = androidAppGradle(dir);
  if (!gradle) return { status: 'not-android', file };
  let text, raw;
  try { text = fs.readFileSync(file, 'utf8'); raw = JSON.parse(text); }
  catch (e) { return { status: 'invalid', file, why: e.message }; }
  if (!Array.isArray(raw.apps)) return { status: 'invalid', file, why: '`apps` absent' };
  if (raw.apps.some(a => a && a.name === name)) return { status: 'exists', file };

  const entry = { name, version: versionSource(gradle, dir) };
  const line = `    ${inline(entry)}`;
  let next = null;
  // Insert after the last app, keeping the file's own layout.
  const m = /\n(\s*)\](\s*,\s*\n\s*"docs")/.exec(text);
  if (m && raw.apps.length) next = text.slice(0, m.index).replace(/\s*$/, '') + `,\n${line}\n${m[1]}]` + text.slice(m.index + 1 + m[1].length + 1);
  let parsed = null;
  try { parsed = next && JSON.parse(next); } catch { parsed = null; }
  if (!parsed || parsed.apps.length !== raw.apps.length + 1) {
    next = JSON.stringify({ ...raw, apps: [...raw.apps, entry] }, null, 2) + '\n';
    parsed = JSON.parse(next);
  }
  const v = validateRegistry(parsed);
  if (v.errors && v.errors.length) return { status: 'invalid', file, why: v.errors.join('; ') };
  writeFileAtomic(file, next);
  return { status: 'added', file, entry };
}
