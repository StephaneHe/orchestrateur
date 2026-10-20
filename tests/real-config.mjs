// ============================================================================
// tests/real-config.mjs — read the machine's real configuration WITHOUT ever
// depending on its switchable state (0.119.0)
// ============================================================================
//
// User request (2026-10-20), verbatim: « s'il est necessaire que l'on soit en
// pipeline pour le test, il faut etre capable de passer en pipleline seul, puis
// le remettre comme il etait apres le test. Un seul status n'est pas une source
// de bug. »
//
// A suite that looks at the real installation (config.json, model-routing.json)
// must never fail because of a switch the user is free to flip (a project in
// or out of the pipelines, lanes on or off, maxParallel…). It works on an
// isolated copy, puts the copy in the state it needs, and the real files are
// never written (checked by hash).
//
//   ORCH_REAL_ROOT_FOR_TESTS=<dir>  the "real" root to read (default: this
//                                   checkout) — used by
//                                   _test_config_state_independence.mjs
//   ORCH_REAL_CONFIG_ONLY=1         run only the real-installation section
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files whose content is a switchable state of the installation. */
export const STATE_FILES = ['config.json', 'model-routing.json', 'language-settings.json', 'permission-rules.json'];

/** Config keys that are user switches (lanes, parallelism): stripped by neutralConfig. */
export const CONFIG_SWITCHES = ['pipelineLanes', 'maxParallel'];

export const realRoot = () => (process.env.ORCH_REAL_ROOT_FOR_TESTS ? path.resolve(process.env.ORCH_REAL_ROOT_FOR_TESTS) : REPO);
export const realOnly = () => process.env.ORCH_REAL_CONFIG_ONLY === '1';

export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
export const readRealConfig = (root = realRoot()) => readJson(path.join(root, 'config.json'));

/** The config with every user switch removed: what the policy gives by default. */
export function neutralConfig(config) {
  const c = JSON.parse(JSON.stringify(config || {}));
  for (const k of CONFIG_SWITCHES) if (c.defaults) delete c.defaults[k];
  for (const p of c.projects || []) for (const k of CONFIG_SWITCHES) if (p) delete p[k];
  return c;
}

/** sha256 of each state file (null when absent): compared before/after a suite. */
export function stateHashes(root, files = STATE_FILES) {
  return Object.fromEntries(files.map(f => {
    try { return [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]; } catch { return [f, null]; }
  }));
}

/** A throw-away root holding a copy of the state files present in `root`. */
export function isolatedCopy(root, files = STATE_FILES) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-realcopy-'));
  for (const f of files) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(T, f));
  return T;
}
