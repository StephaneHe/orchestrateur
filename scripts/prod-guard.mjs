// ============================================================================
// scripts/prod-guard.mjs — no non-regression ever runs in production (0.125.0)
// ============================================================================
//
// User rule, recalled on 2026-10-20 (verbatim): « Aucune non regression ne doit
// se lancer sur orchestrateur. C'etait une regle. Uniquement sur
// orchestrateur-dev ». The chef had followed the jump procedure, which still
// prescribed `regression.mjs --perimeters --since prod-before-…` inside the
// production checkout (v0.119.0, v0.120.0).
//
// A root is production when ANY of these holds (there is no way to waive it:
// no option, no variable that removes a root):
//   - it is I:\orchestrateur (PROD_ROOT), whatever the spelling;
//   - its .orchestrateur-instance.json says `"role": "prod"`;
//   - its config.json has a project living in that root and another project
//     whose `devOf` names it (the production fleet declares its dev instance);
//   - it is listed in ORCH_PROD_ROOTS (add-only, path-delimited; for tests).
// regression.mjs calls refuseInProd() as its very first import.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROD_ROOT = 'I:\\orchestrateur';
export const RULE = "« Aucune non regression ne doit se lancer sur orchestrateur. C'etait une regle. Uniquement sur orchestrateur-dev » (règle de l'utilisateur, 2026-10-20)";
export const REFUSED_EXIT = 65;

const norm = (p) => {
  let r = path.resolve(String(p));
  try { r = fs.realpathSync.native(r); } catch { /* not on disk: compare as written */ }
  r = r.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function declaresDevOf(root) {
  const cfg = readJson(path.join(root, 'config.json'));
  const projects = Array.isArray(cfg?.projects) ? cfg.projects : [];
  const here = norm(root);
  const mine = projects.filter(p => p?.cwd && norm(p.cwd) === here).map(p => p.name);
  return mine.some(name => projects.some(p => p?.devOf === name));
}

/** True when `root` is a production checkout (see the header). */
export function isProdRoot(root, { env = process.env } = {}) {
  if (!root) return false;
  const r = norm(root);
  const extra = String(env.ORCH_PROD_ROOTS || '').split(path.delimiter).filter(Boolean);
  if ([PROD_ROOT, ...extra].some(p => norm(p) === r)) return true;
  if (readJson(path.join(root, '.orchestrateur-instance.json'))?.role === 'prod') return true;
  return declaresDevOf(root);
}

/** The refusal text for a production root, or null. */
export function prodRefusal(root, opts) {
  if (!isProdRoot(root, opts)) return null;
  return [
    `[regression] REFUSÉ : ${root} est une instance de PRODUCTION.`,
    `  ${RULE}.`,
    '  Lancer la non-régression dans la dev : node scripts/regression.mjs … dans I:\\Dev\\orchestrateur-dev',
    '  (avant un bond : --ref vX.Y.Z --perimeters --prod I:\\orchestrateur, qui lit seulement le commit de la prod).',
  ].join('\n');
}

/** Exits (65) when the running checkout, or the --dir target, is production. */
export function refuseInProd({ root, argv = process.argv.slice(2), env = process.env } = {}) {
  const i = argv.indexOf('--dir');
  for (const r of [root, i >= 0 ? argv[i + 1] : null]) {
    const msg = r && prodRefusal(r, { env });
    if (msg) { console.error(msg); process.exit(REFUSED_EXIT); }
  }
}

// The checkout this module belongs to (regression.mjs runs from the same one).
export const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
