#!/usr/bin/env node
// ============================================================================
// scripts/new-project.mjs — fleet project scaffolder
// ============================================================================
//
// Creates (or completes) a fleet project from templates/project/ and
// registers it in config.json.
//
// Usage:
//   node scripts/new-project.mjs <name>
//   node scripts/new-project.mjs <name> --path I:\Dev\<name>
//   node scripts/new-project.mjs <name> --tools "Read,Edit,Write,Bash"
//   node scripts/new-project.mjs <name> --model claude-sonnet-4-6
//   node scripts/new-project.mjs <name> --web     # + WebFetch,WebSearch
//
// ACCÈS WEB = OPT-IN (--web). Un projet sans `tools` hérite de
// defaults.allowedTools (Read,Edit,Write,Bash) : PAS de WebFetch/WebSearch —
// BtLocator l'a découvert en rendant une synthèse pleine de « non vérifié ».
// On ne l'active pas par défaut : la règle dure du projet veut que tout scope
// plus large que Read,Edit,Write,Bash soit un opt-in par projet (le web ouvre
// l'injection de prompt et l'exfiltration). À la place, le piège est rendu
// visible : le résumé dit explicitement « pas d'accès web ». `--web` sur un
// projet DÉJÀ enregistré ajoute seulement les deux outils (jamais de retrait).
//
// DESIGN — deterministic + idempotent:
//   • No LLM in the loop. Pure mechanics, like restart-orchestrateur.mjs.
//   • NEVER overwrites an existing file. Missing → created. Present →
//     left untouched, logged "exists, skipped". Running this on an
//     already-scaffolded project therefore only fills in what's missing;
//     it can never clobber real work.
//   • config.json entry added only if absent (matched by name). Present →
//     logged "exists, skipped", never duplicated.
//   • Does NOT restart the server. The new project is picked up by the
//     server's 3s config poll for watchers; a restart is the operator's
//     call.
//
// Exit codes: 0 = success (including full no-op), 64 = usage error,
//             65 = template missing, 66 = filesystem/config write failure.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Même racine alternative que dispatch.mjs, pour les recettes (jamais en prod).
const ROOT          = process.env.DISPATCH_ROOT_FOR_TESTS
  ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS)
  : path.resolve(__dirname, '..');
const TEMPLATE_DIR  = path.join(ROOT, 'templates', 'project');
const CONFIG_PATH   = path.join(ROOT, 'config.json');
const DEFAULT_DEV_ROOT = 'I:\\Dev';

function log(msg)  { console.log(`[new-project] ${msg}`); }
function warn(msg) { console.warn(`[new-project] ${msg}`); }
function die(msg, code = 64) { console.error(`[new-project] ${msg}`); process.exit(code); }

// ---------- argv ------------------------------------------------------------
//
// Hand-rolled parse (no dependency). Flags may appear in any order after the
// project name; each takes exactly one value.

const argv = process.argv.slice(2);
if (argv.length < 1 || argv[0].startsWith('--')) {
  die('usage: node scripts/new-project.mjs <name> [--path <dir>] [--tools "Read,Edit,Write,Bash"] [--model <id>] [--web]');
}

const name = argv[0];

// Project names are interpolated into paths and matched against the config
// allowlist by the server — keep them boring and filesystem-safe.
if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(name)) {
  die(`invalid project name "${name}" — must start with a letter and contain only letters, digits, dot, dash, underscore (max 64 chars)`);
}

const opts = { path: null, tools: null, model: null };
let web = false;
for (let i = 1; i < argv.length; i++) {
  const flag = argv[i];
  if (!flag.startsWith('--')) die(`unexpected argument "${flag}"`);
  if (flag === '--web') { web = true; continue; }   // drapeau sans valeur
  const key = flag.slice(2);
  if (!(key in opts)) die(`unknown flag "${flag}" — supported: --path, --tools, --model, --web`);
  if (i + 1 >= argv.length) die(`${flag} requires a value`);
  opts[key] = argv[++i];
}

const projectPath = path.resolve(opts.path || path.join(DEFAULT_DEV_ROOT, name));

// ---------- template substitution -------------------------------------------

// Only two placeholders exist, both injected here. `new Date()` is fine:
// this is an ordinary Node script, not a replayable workflow.
const SUBSTITUTIONS = {
  '{{NAME}}': name,
  '{{DATE}}': new Date().toISOString().slice(0, 10),   // YYYY-MM-DD
};

function substitute(text) {
  let out = text;
  for (const [needle, value] of Object.entries(SUBSTITUTIONS)) {
    out = out.split(needle).join(value);
  }
  return out;
}

/** Recursively list template files as paths relative to TEMPLATE_DIR. */
function listTemplateFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory())   out.push(...listTemplateFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile())   out.push(rel);
  }
  return out;
}

// ---------- run -------------------------------------------------------------

if (!fs.existsSync(TEMPLATE_DIR)) {
  die(`template directory missing: ${TEMPLATE_DIR}`, 65);
}

const created = [];
const skipped = [];

// 1. Project directory ------------------------------------------------------
try {
  if (fs.existsSync(projectPath)) {
    if (!fs.statSync(projectPath).isDirectory()) {
      die(`path exists but is not a directory: ${projectPath}`, 66);
    }
    log(`dir  ${projectPath} — exists, skipped`);
    skipped.push('<project dir>');
  } else {
    fs.mkdirSync(projectPath, { recursive: true });
    log(`dir  ${projectPath} — created`);
    created.push('<project dir>');
  }
} catch (e) {
  die(`cannot create project directory: ${e.message}`, 66);
}

// 2. Template files ---------------------------------------------------------
//
// The existence check + write are deliberately NOT atomic-guarded: this is a
// single-operator local tool, and the failure mode we care about (clobbering
// real work) is fully covered by the existsSync gate.
for (const rel of listTemplateFiles(TEMPLATE_DIR)) {
  const src  = path.join(TEMPLATE_DIR, rel);
  const dest = path.join(projectPath, rel);
  if (fs.existsSync(dest)) {
    log(`file ${rel} — exists, skipped`);
    skipped.push(rel);
    continue;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, substitute(fs.readFileSync(src, 'utf8')));
    log(`file ${rel} — created`);
    created.push(rel);
  } catch (e) {
    warn(`file ${rel} — FAILED: ${e.message}`);
  }
}

// 3. config.json entry ------------------------------------------------------

let configChanged = false;
let finalTools = null;
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
function hasWeb(tools) { const t = String(tools).split(',').map(s => s.trim()); return WEB_TOOLS.every(w => t.includes(w)); }
function withWeb(tools) {
  const t = String(tools).split(',').map(s => s.trim()).filter(Boolean);
  for (const w of WEB_TOOLS) if (!t.includes(w)) t.push(w);
  return t.join(',');
}
try {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(config.projects)) die('config.projects is not an array — refusing to write', 66);

  const baseTools = config.defaults?.allowedTools || 'Read,Edit,Write,Bash';
  const existing = config.projects.find(p => p.name === name);
  if (existing && web && !hasWeb(existing.tools || baseTools)) {
    // Seul cas où une entrée existante est modifiée : --web, en AJOUT.
    existing.tools = withWeb(existing.tools || baseTools);
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmp, CONFIG_PATH);
    configChanged = true;
    finalTools = existing.tools;
    log(`config.json entry "${name}" — exists, web tools added (${existing.tools})`);
    created.push('web tools');
  } else if (existing) {
    finalTools = existing.tools || baseTools;
    log(`config.json entry "${name}" — exists, skipped`);
    skipped.push('config.json entry');
  } else {
    const entry = { name, path: projectPath };
    if (opts.tools || web) entry.tools = web ? withWeb(opts.tools || baseTools) : opts.tools;
    if (opts.model) entry.model = opts.model;
    finalTools = entry.tools || baseTools;
    config.projects.push(entry);
    // Write via temp + rename so a crash mid-write can't truncate the
    // fleet's only source of truth for project routing.
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmp, CONFIG_PATH);
    configChanged = true;
    log(`config.json entry "${name}" — created`);
    created.push('config.json entry');
  }
} catch (e) {
  if (e.code === 'ENOENT') die(`config.json not found at ${CONFIG_PATH}`, 66);
  die(`config.json update failed: ${e.message}`, 66);
}

// 4. Summary ----------------------------------------------------------------

console.log('');
log(`project : ${name}`);
log(`path    : ${projectPath}`);
if (finalTools) log(`tools   : ${finalTools}`);
if (opts.model) log(`model   : ${opts.model}`);
if (finalTools && !hasWeb(finalTools)) {
  log('web     : AUCUN accès web (pas de WebFetch/WebSearch) — relance avec --web si ce projet doit chercher en ligne');
}
log(`created : ${created.length ? created.join(', ') : '(nothing — already fully scaffolded)'}`);
log(`skipped : ${skipped.length ? skipped.join(', ') : '(none)'}`);
if (configChanged) {
  log('note    : config.json changed — the running server picks up new projects');
  log('          within ~3s for log watchers. Restart only if you need more.');
}
process.exit(0);
