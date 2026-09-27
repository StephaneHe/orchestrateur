#!/usr/bin/env node
// ============================================================================
// scripts/_test_tools_resolution.mjs — chaque projet a-t-il le web et la lecture ?
// ============================================================================
//
// Règle utilisateur (0.28.0) : « tous les projets doivent avoir droit au web et
// à la lecture ». On évalue l'expression RÉELLE qui choisit les outils —
// extraite de scripts/dispatch.mjs (`const tools = …`) et de server.js
// (`allowedToolsFor`) — sur le VRAI config.json, projet par projet. Lecture
// seule : rien n'est écrit, aucun musicien n'est lancé.
//
//   node scripts/_test_tools_resolution.mjs          (exit 1 si un projet manque un outil)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = ['Read', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Grep', 'Glob'];
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// ---------- les deux résolutions réelles ------------------------------------

const D = fs.readFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), 'utf8');
const line = /^const tools\s*=\s*(.+);$/m.exec(D);
if (!line) { console.error('ligne `const tools = …` introuvable dans dispatch.mjs'); process.exit(2); }
// eslint-disable-next-line no-new-func
const dispatchTools = new Function('project', 'config', `return ${line[1]};`);

const S = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const fb = /^const FALLBACK_TOOLS\s*=\s*'([^']+)';$/m.exec(S);
const a = S.indexOf('function allowedToolsFor(');
if (!fb || a < 0) { console.error('FALLBACK_TOOLS / allowedToolsFor introuvables dans server.js'); process.exit(2); }
// eslint-disable-next-line no-new-func
const serverTools = new Function('config', 'FALLBACK_TOOLS',
  `${S.slice(a, S.indexOf('\n}\n', a) + 2)}\nreturn allowedToolsFor;`)(config, fb[1]);

// ---------- vérification ----------------------------------------------------

const split = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
let bad = 0;
const width = Math.max(...config.projects.map(p => p.name.length));
console.log(`defaults.allowedTools = ${config.defaults?.allowedTools}`);
console.log(`FALLBACK (dispatch/server) = ${split(/'([^']+)'\s*$/.exec(line[1])?.[1]).join(',')} / ${fb[1]}\n`);
for (const p of config.projects) {
  const d = split(dispatchTools(p, config));
  const s = split(serverTools(p.name));
  const missing = REQUIRED.filter(t => !d.includes(t));
  const agree = d.join(',') === s.join(',');
  const extra = d.filter(t => !REQUIRED.includes(t));
  const status = missing.length ? `✗ manque ${missing.join(',')}` : '✓';
  if (missing.length || !agree) bad++;
  console.log(`  ${p.name.padEnd(width)}  ${status}${p.tools ? '  (override)' : '  (défaut)'}` +
    `${extra.length ? `  + ${extra.join(',')}` : ''}${agree ? '' : '  ✗ dispatch ≠ serveur'}`);
}
for (const [label, v] of [['FALLBACK dispatch.mjs', split(/'([^']+)'\s*$/.exec(line[1])?.[1])], ['FALLBACK server.js', split(fb[1])]]) {
  const m = REQUIRED.filter(t => !v.includes(t));
  if (m.length) { bad++; console.log(`  ✗ ${label} (config sans defaults) manque ${m.join(',')}`); }
}
console.log(`\n${bad === 0 ? '✓' : '✗'} ${config.projects.length} projets vérifiés, ${bad} problème(s)`);
process.exit(bad ? 1 : 0);
