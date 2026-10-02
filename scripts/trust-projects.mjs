#!/usr/bin/env node
// ============================================================================
// scripts/trust-projects.mjs — retrofit what new-project.mjs now does at
// creation: workspace trusted in ~/.claude.json + standard tools (and
// PowerShell) allowed in <project>/.claude/settings.json.
//
// Usage:
//   node scripts/trust-projects.mjs                 every project of config.json
//   node scripts/trust-projects.mjs <name> [...]    only these
//   node scripts/trust-projects.mjs --dry-run       show before/after, write nothing
//   node scripts/trust-projects.mjs --json
//
// Additive only. The conductor's settings are left alone (its allow list is a
// deliberate contract); it is still trusted if it is not already.
//
// Exit codes: 0 ok, 64 usage, 66 at least one project failed.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_TOOLS, EXTRA_SETTINGS_TOOLS, claudeJsonPath, trustStatus, trustWorkspace, ensureProjectPermissions } from './workspace-trust.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS
  ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS)
  : path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const asJson = argv.includes('--json');
const unknown = argv.filter(a => a.startsWith('--') && !['--dry-run', '--json'].includes(a));
if (unknown.length) { console.error(`usage: node scripts/trust-projects.mjs [<name>...] [--dry-run] [--json]`); process.exit(64); }
const names = argv.filter(a => !a.startsWith('--'));

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const defaults = config.defaults?.allowedTools || STANDARD_TOOLS;
let projects = config.projects || [];
if (names.length) {
  const missing = names.filter(n => !projects.some(p => p.name === n));
  if (missing.length) { console.error(`unknown project(s): ${missing.join(', ')}`); process.exit(64); }
  projects = projects.filter(p => names.includes(p.name));
}

const file = claudeJsonPath();
function settingsAllow(p) {
  try { return JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8')).permissions?.allow || []; }
  catch { return null; }
}

const rows = [];
let failed = 0;
for (const p of projects) {
  const row = { name: p.name, path: p.path, conductor: p.name === config.conductor };
  if (!p.path || !fs.existsSync(p.path)) { row.skipped = 'path missing'; rows.push(row); continue; }
  const wanted = [...(p.tools || defaults).split(',').map(s => s.trim()).filter(Boolean), ...EXTRA_SETTINGS_TOOLS];
  row.trustedBefore = trustStatus(p.path, file).trusted;
  const allowBefore = settingsAllow(p.path) || [];
  row.missingBefore = row.conductor ? [] : wanted.filter(t => !allowBefore.includes(t));
  if (!dry) {
    try {
      if (!row.conductor) ensureProjectPermissions(p.path, p.tools || defaults);
      trustWorkspace(p.path, { file });
    } catch (e) { row.error = e.message; failed++; }
  }
  row.trustedAfter = dry ? row.trustedBefore : trustStatus(p.path, file).trusted;
  const allowAfter = settingsAllow(p.path) || [];
  row.missingAfter = row.conductor ? [] : wanted.filter(t => !allowAfter.includes(t));
  rows.push(row);
}

if (asJson) console.log(JSON.stringify({ file, dryRun: dry, rows }, null, 2));
else {
  console.log(`${dry ? '[dry-run] ' : ''}${file}`);
  for (const r of rows) {
    if (r.skipped) { console.log(`${r.name.padEnd(20)} skipped: ${r.skipped}`); continue; }
    const t = `trust ${r.trustedBefore ? 'yes' : 'NO '} → ${r.trustedAfter ? 'yes' : 'NO '}`;
    const m = r.conductor ? 'settings untouched (conductor)'
      : `allow missing ${r.missingBefore.length ? r.missingBefore.join(',') : '-'} → ${r.missingAfter.length ? r.missingAfter.join(',') : '-'}`;
    console.log(`${r.name.padEnd(20)} ${t}   ${m}${r.error ? `   ERROR ${r.error}` : ''}`);
  }
}
process.exit(failed ? 66 : 0);
