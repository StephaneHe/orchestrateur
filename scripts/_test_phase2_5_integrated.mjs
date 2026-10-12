#!/usr/bin/env node
// ============================================================================
// scripts/_test_phase2_5_integrated.mjs — _test_phase2_5_override.mjs is part of
// the non-regression (0.74.1)
// ============================================================================
//
// User request (2026-10-12): « si les 2 suites _test_phase2 ne sont pas du
// code mort, il faut les integrer aux tests ». _test_phase2_5_override.mjs
// covers detectOverride (src/message_router.mjs), used by /api/dispatch: it
// is live, so it runs in the full run and is picked by the targeted run for
// the code it covers. _test_phase2.mjs only exercises code never called in
// production (route/decide/classify): dead, it stays excluded and its removal
// is the user's decision.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectTargets } from './regression-targets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const SUITE = '_test_phase2_5_override.mjs';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

console.log('\n── 1. Dans la complète');
const reg = read('scripts/regression.mjs');
const excluded = reg.match(/const EXCLUDED_SUITES = \{([\s\S]*?)\};/);
ok(excluded && !excluded[1].includes(SUITE), `${SUITE} n'est plus dans EXCLUDED_SUITES`, excluded && excluded[1]);
ok(excluded && excluded[1].includes("'_test_phase2.mjs'"), '_test_phase2.mjs reste exclue (code mort, décision de l’utilisateur pour la suppression)');
ok(fs.existsSync(path.join(ROOT, 'scripts', SUITE)) && /^_test_.*\.mjs$/.test(SUITE), 'la suite existe et porte un nom que la complète ramasse');

console.log('\n── 2. Sélectionnée par la ciblée pour le code qu’elle couvre');
for (const f of ['src/message_router.mjs', `scripts/${SUITE}`]) {
  const s = selectTargets(ROOT, [f]);
  ok(!s.full && s.suites.some(x => x.file === SUITE), `changement de ${f} → ${SUITE} sélectionnée`, JSON.stringify(s).slice(0, 400));
}

console.log('\n── 3. Hermétique : la télémétrie va dans un dossier temporaire');
const src = read(`scripts/${SUITE}`);
ok(/process\.env\.ORCH_ROUTER_LOGS_DIR = LOGS/.test(src) && /mkdtempSync/.test(src) && /await import\('\.\.\/src\/message_router\.mjs'\)/.test(src),
  'la suite pose ORCH_ROUTER_LOGS_DIR (dossier temporaire) avant de charger le routeur');
ok(/real logs\/ untouched/.test(src), 'la suite vérifie que les vrais logs/ ne bougent pas');
ok(/process\.env\.ORCH_ROUTER_LOGS_DIR \|\| path\.join\(ROOT, 'logs'\)/.test(read('src/message_router.mjs')), 'src/message_router.mjs lit ORCH_ROUTER_LOGS_DIR, sinon logs/');
ok(!/ORCH_ROUTER_LOGS_DIR/.test(read('server.js')), 'le serveur ne pose jamais ORCH_ROUTER_LOGS_DIR');

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
