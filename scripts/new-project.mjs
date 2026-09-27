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
//
// OUTILS (0.28.0) — règle utilisateur : « tous les projets doivent avoir droit
// au web et à la lecture ». defaults.allowedTools vaut désormais
// Read,Edit,Write,Bash,WebFetch,WebSearch,Grep,Glob et un nouveau projet en
// HÉRITE (pas d'entrée `tools`). `--tools` ne sert plus qu'à AJOUTER des
// outils : il est fusionné avec le défaut, un projet n'a jamais moins que lui.
// `--web` (0.27.0) est obsolète : accepté sans effet, pour ne pas casser de
// commande existante.
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
const splitTools = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
/** Défaut + outils demandés, défaut en tête ; null si rien de plus que le défaut
 *  (l'entrée hérite alors, et suivra toute évolution future du défaut). */
function toolsBeyondDefault(base, requested) {
  const b = splitTools(base);
  const extra = splitTools(requested).filter(t => !b.includes(t));
  return extra.length ? [...b, ...extra].join(',') : null;
}
try {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(config.projects)) die('config.projects is not an array — refusing to write', 66);

  const baseTools = config.defaults?.allowedTools || 'Read,Edit,Write,Bash,WebFetch,WebSearch,Grep,Glob';
  const existing = config.projects.find(p => p.name === name);
  if (web) warn('--web est obsolète depuis 0.28.0 : le web est dans le défaut de tous les projets (sans effet)');
  if (existing) {
    finalTools = existing.tools || baseTools;
    log(`config.json entry "${name}" — exists, skipped`);
    skipped.push('config.json entry');
  } else {
    const entry = { name, path: projectPath };
    const merged = opts.tools ? toolsBeyondDefault(baseTools, opts.tools) : null;
    if (merged) entry.tools = merged;
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
// Garde-fou si quelqu'un réduit un jour le défaut : on le dit plutôt que de le taire.
if (finalTools && !['WebFetch', 'WebSearch'].every(t => splitTools(finalTools).includes(t))) {
  log('web     : AUCUN accès web (WebFetch/WebSearch absents du défaut et de ce projet)');
}
log(`created : ${created.length ? created.join(', ') : '(nothing — already fully scaffolded)'}`);
log(`skipped : ${skipped.length ? skipped.join(', ') : '(none)'}`);
if (configChanged) {
  log('note    : config.json changed — the running server picks up new projects');
  log('          within ~3s for log watchers. Restart only if you need more.');
}
process.exit(0);
