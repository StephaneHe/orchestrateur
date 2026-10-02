// ============================================================================
// scripts/workspace-trust.mjs — make a fleet project usable by headless claude
// ============================================================================
//
// Two things must be true for a sub-agent to run without anyone clicking:
//
// 1. The workspace is TRUSTED in the CLI's user config (~/.claude.json,
//    projects["I:/Dev/X"].hasTrustDialogAccepted). Without it, `claude -p`
//    prints "Ignoring N permissions.allow entries from .claude/settings.json:
//    this workspace has not been trusted" and drops every project-level allow
//    rule — so a tool granted from the dashboard (add-tool) silently did
//    nothing. The CLI looks the key up with forward slashes ("I:/Dev/X"); some
//    entries also exist in backslash form, both are set.
//
// 2. The project's .claude/settings.json allows the fleet's standard tools,
//    plus PowerShell: on Windows the model reaches for the PowerShell tool,
//    which is not in --allowed-tools and was denied in headless runs (the
//    "authorisation" the user ended up granting by hand, project by project).
//
// ~/.claude.json is rewritten by every running claude process. We therefore
// read-modify-write in one short synchronous burst, only touch the target
// entries, back the file up first, write a temp file in the same directory
// and rename it over, then re-read to check our flag survived (another
// process may have written a stale copy in between) and retry if not.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STANDARD_TOOLS = 'Read,Edit,Write,Bash,WebFetch,WebSearch,Grep,Glob';
// Not in --allowed-tools on purpose (argv stays provider-neutral); granted
// through the project settings instead.
export const EXTRA_SETTINGS_TOOLS = ['PowerShell'];

// Shape the CLI gives a fresh project entry; a bare {hasTrustDialogAccepted}
// could leave arrays it iterates undefined.
const NEW_ENTRY_DEFAULTS = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

export function claudeJsonPath() {
  if (process.env.ORCH_CLAUDE_JSON) return path.resolve(process.env.ORCH_CLAUDE_JSON);
  const dir = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  return path.join(dir, '.claude.json');
}

/** "i:\\Dev\\X\\" → "I:/Dev/X", the key form the CLI uses. */
export function trustKey(projectPath) {
  let p = path.resolve(projectPath).replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  return p;
}

const sameKey = (a, b) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
                       === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function matchingKeys(projects, key) {
  return Object.keys(projects).filter(k => sameKey(k, key));
}

/** Read-only: { key, trusted, keys:[{key,value}] }. */
export function trustStatus(projectPath, file = claudeJsonPath()) {
  const key = trustKey(projectPath);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const projects = j.projects || {};
  const keys = matchingKeys(projects, key).map(k => ({ key: k, value: projects[k]?.hasTrustDialogAccepted === true }));
  const canonical = Object.keys(projects).find(k => k === key);
  return { key, trusted: !!canonical && projects[canonical].hasTrustDialogAccepted === true, keys };
}

const backedUp = new Set();

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Mark projectPath as trusted. Returns { key, changed, touched:[keys], backup }.
 * Throws if the file cannot be parsed or the write keeps getting overwritten.
 */
export function trustWorkspace(projectPath, { file = claudeJsonPath(), attempts = 5 } = {}) {
  const key = trustKey(projectPath);
  return editProjects(file, attempts, key, (projects) => {
    const touched = [];
    for (const k of new Set([key, ...matchingKeys(projects, key)])) {
      const entry = projects[k];
      if (entry && entry.hasTrustDialogAccepted === true) continue;
      projects[k] = entry ? { ...entry, hasTrustDialogAccepted: true }
                          : { ...NEW_ENTRY_DEFAULTS, hasTrustDialogAccepted: true };
      touched.push(k);
    }
    return touched;
  }, () => trustStatus(projectPath, file).trusted);
}

/** Drop every ~/.claude.json entry of projectPath (both path forms). For
 *  deleting a project; same care as trustWorkspace. */
export function forgetWorkspace(projectPath, { file = claudeJsonPath(), attempts = 5 } = {}) {
  const key = trustKey(projectPath);
  return editProjects(file, attempts, key, (projects) => {
    const touched = matchingKeys(projects, key);
    for (const k of touched) delete projects[k];
    return touched;
  }, () => trustStatus(projectPath, file).keys.length === 0);
}

function editProjects(file, attempts, key, mutate, persisted) {
  let backup = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') throw new Error(`${file}: not a JSON object`);
    if (!j.projects || typeof j.projects !== 'object') j.projects = {};

    const touched = mutate(j.projects);
    if (!touched.length) return { key, changed: false, touched, backup };

    // One backup per process: a retrofit run over many projects keeps the
    // state from before its first write, not before its last.
    if (!backedUp.has(file)) {
      fs.writeFileSync(`${file}.orchestrateur-bak`, raw);
      backedUp.add(file);
    }
    backup = `${file}.orchestrateur-bak`;
    // The CLI writes 2-space JSON without a trailing newline; keep that.
    const tmp = `${file}.orch-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
    // Last-moment check: if someone wrote since our read, start over from
    // their version instead of clobbering it.
    if (fs.readFileSync(file, 'utf8') !== raw) {
      fs.rmSync(tmp, { force: true });
      sleepSync(50 * attempt);
      continue;
    }
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
      sleepSync(100 * attempt);
      continue;
    }
    sleepSync(150);
    if (persisted()) return { key, changed: true, touched, backup };
  }
  throw new Error(`could not persist the change for ${key} in ${file} after ${attempts} attempts`);
}

/**
 * Add the fleet's standard tools (plus PowerShell) to
 * <project>/.claude/settings.json permissions.allow. Additive only: nothing
 * else in the file is changed. Returns { file, added:[...] }.
 */
export function ensureProjectPermissions(projectPath, tools = STANDARD_TOOLS) {
  const wanted = [...String(tools).split(',').map(s => s.trim()).filter(Boolean), ...EXTRA_SETTINGS_TOOLS];
  const dir = path.join(projectPath, '.claude');
  const file = path.join(dir, 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    // A broken settings file is the user's to fix; never overwrite it.
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
  const added = wanted.filter(t => !settings.permissions.allow.includes(t));
  if (!added.length) return { file, added };
  settings.permissions.allow.push(...added);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return { file, added };
}
