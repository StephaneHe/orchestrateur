// ============================================================================
// scripts/suite-cache.mjs — a green test suite is never re-run on an
// identical tree (pipelines phase 0 c, switch `suiteCache`)
// ============================================================================
//
// User request (2026-10-20, phase 0 of the pipeline redesign): « Une suite de
// tests n'est pas relancée sur un arbre identique : résultat vert mis en cache
// par empreinte d'arbre. »
//
// Key = sha256 of: the work tree (tracked + untracked, ignored files and run
// artefacts excluded, hashed through a private git index — never the
// project's own index), the exact command, the Node version, the platform,
// and the test environment minus volatile per-turn variables. Only a GREEN
// result is kept (a red one is always run again), for one day at most
// (ORCH_SUITE_CACHE_TTL_MS), per project in logs/suite-cache/<project>.json.
// A suite that must run twice (flaky detection) is never served from here.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { worktreeTree } from './item-review.mjs';
import { writeFileAtomic } from './atomic-file.mjs';

const MAX_ENTRIES = 200;
export const ttlMs = () => Number(process.env.ORCH_SUITE_CACHE_TTL_MS) || 24 * 3600_000;

// Set per turn, per process or per shell: never part of what a suite tests.
const VOLATILE = /^(ORCH_(TURN_ID|TURN_PROJECT|TURN_STEP|OBS_ID|STEP_TOKEN|HANDOFF_TOKEN|TEST_LABEL)|CLAUDECODE|CLAUDE_CODE_.*|OTEL_.*|PROMPT|PS1|SHLVL|PWD|OLDPWD|_|TERM.*|WT_.*|SESSIONNAME|CLIENTNAME|RANDOM)$/i;

export function envFingerprint(env = {}) {
  const keys = Object.keys(env).filter(k => !VOLATILE.test(k)).sort();
  return crypto.createHash('sha256').update(keys.map(k => `${k}=${env[k]}`).join('\0')).digest('hex');
}

/** → { key, tree } or null (not a git work tree, git failed). */
export function suiteKey(cwd, { command, env, indexFile }) {
  const tree = worktreeTree(cwd, indexFile);
  if (!tree) return null;
  const key = crypto.createHash('sha256').update([tree, command, process.version, process.platform, envFingerprint(env)].join('\0')).digest('hex');
  return { key, tree };
}

function read(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j.entries === 'object' ? j : { entries: {} }; } catch { return { entries: {} }; }
}

/** A green result kept for this key, still fresh. */
export function lookup(file, key, now = Date.now()) {
  const e = read(file).entries[key];
  return e && now - Date.parse(e.at) < ttlMs() ? e : null;
}

export function store(file, key, info, now = Date.now()) {
  const j = read(file);
  j.entries[key] = { at: new Date(now).toISOString(), ...info };
  const keep = Object.entries(j.entries).filter(([, e]) => now - Date.parse(e.at) < ttlMs())
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, MAX_ENTRIES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ entries: Object.fromEntries(keep) }, null, 1), `${file}.${process.pid}.tmp`);
}

/**
 * Runs `run()` unless a green result is kept for this exact tree.
 * → the command's result; a cached one carries `cached: {at, tree, ms}` and ms ≈ 0.
 */
export function cachedSuite({ cwd, command, env, indexFile, file }, run) {
  const k = suiteKey(cwd, { command, env, indexFile });
  if (k) {
    const hit = lookup(file, k.key);
    if (hit) return { ok: true, code: 0, ms: 0, out: `(résultat vert mémorisé : même arbre ${k.tree.slice(0, 12)}, même commande, vérifié le ${hit.at} en ${Math.round((hit.ms || 0) / 1000)} s — suite non relancée)`, cached: { at: hit.at, tree: k.tree, ms: hit.ms || 0 } };
  }
  const t = run();
  if (t.ok && k) { try { store(file, k.key, { tree: k.tree, command, ms: t.ms }); } catch { /* cache only */ } }
  return t;
}
