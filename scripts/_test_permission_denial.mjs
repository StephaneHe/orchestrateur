#!/usr/bin/env node
// ============================================================================
// scripts/_test_permission_denial.mjs — refus d'autorisation : vrais ou faux ?
// ============================================================================
//
// Incident du 28/09/2026 : un panneau « autorisation » vague est apparu alors
// qu'aucune permission n'avait été refusée. Un tour avait simplement LU
// public/app.js, dont le texte contient « requires approval ». La détection
// (sous-chaîne dans n'importe quelle tool_result) a été remplacée en 0.29.1 par
// public/permission-denial.js : is_error + libellé réel du CLI, en tête.
//
// Ce test charge le VRAI public/permission-denial.js dans une VM et vérifie :
//   · chaque libellé réel relevé dans les logs de la flotte est reconnu ;
//   · un Read / une sortie de commande qui CONTIENT la chaîne ne l'est pas ;
//   · un refus n'est complet (donc annoncé) qu'avec outil + aperçu d'appel ;
//   · l'app Android (Musician.kt) applique exactement les mêmes motifs.
//
//   node scripts/_test_permission_denial.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  [ok]   ${l}`); } else { fail++; console.log(`  [FAIL] ${l}`); } };

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'permission-denial.js'), 'utf8'), ctx);
const PD = ctx.PermissionDenial;

const res = (content, is_error = true, id = 't1') => ({ type: 'tool_result', tool_use_id: id, is_error, content });
const user = (...blocks) => ({ type: 'user', message: { content: blocks } });

console.log('\n── Libellés réels du CLI (relevés dans logs/*.jsonl)');
const REAL = [
  "This command requires approval",
  "Claude requested permissions to use WebSearch, but you haven't granted it yet.",
  "Claude requested permissions to write to I:\\Dev\\BookHaven\\.claude\\skills\\x\\SKILL.md, but you haven't granted it yet.",
  "Claude requested permissions to edit I:\\Dev\\immo-share\\.claude\\CLAUDE.md which is a sensitive file, but you haven't granted it yet.",
  "This Bash command contains multiple operations. The following parts require approval: rm -f a, echo b",
  "This PowerShell command contains multiple operations. The following part requires approval: Get-ChildItem -Force",
  "Permission to use Bash with command git push origin main has been denied.",
  "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>",
];
for (const t of REAL) ok(PD.isDenialResult(res(t)), `refus reconnu : ${t.slice(0, 70)}`);
ok(PD.isDenialResult(res([{ type: 'text', text: REAL[0] }])), 'contenu en tableau de blocs texte');

console.log('\n── Faux positifs (l\'incident)');
const APP_JS_EXCERPT = '// Detect permission denials (tool_result with "requires approval")\nif (!c.includes("requires approval")) continue;';
ok(!PD.isDenialResult(res(APP_JS_EXCERPT, false)), 'Read de public/app.js contenant « requires approval » : rien');
ok(!PD.isDenialResult(res(APP_JS_EXCERPT, undefined)), 'même contenu sans is_error : rien');
ok(!PD.isDenialResult(res('Exit code 1\n  if (!c.includes("requires approval")) continue;', true)),
  'sortie en erreur d\'un grep qui CONTIENT la chaîne (cas chef.jsonl) : rien');
ok(!PD.isDenialResult(res('     1→This command requires approval', false)), 'ligne numérotée de Read : rien');
ok(!PD.isDenialResult(res(REAL[0], false)), 'libellé exact mais is_error absent/faux : rien');
ok(!PD.isDenialResult({ type: 'text', text: REAL[0] }), 'bloc texte assistant : rien');

console.log('\n── Refus complets seulement (outil + appel)');
const uses = {
  t1: { name: 'Bash', input: { command: 'rm -rf build && git push' } },
  t2: { name: 'Read', input: { file_path: 'I:\\orchestrateur\\public\\app.js' } },
  t3: { name: 'WebSearch', input: { query: 'claude code permissions' } },
};
let ds = PD.denialsFromUserEvent(user(res(REAL[0], true, 't1')), uses);
ok(ds.length === 1 && ds[0].toolName === 'Bash' && ds[0].preview === 'rm -rf build && git push' && ds[0].reason === REAL[0],
  'vrai refus → outil, commande et motif');
ds = PD.denialsFromUserEvent(user(res(APP_JS_EXCERPT, false, 't2')), uses);
ok(ds.length === 0, 'Read dont le contenu contient « requires approval » → aucun refus');
ds = PD.denialsFromUserEvent(user(res(REAL[0], true, 'inconnu')), uses);
ok(ds.length === 0, 'refus sans tool_use connu (outil/appel inconnus) → rien d\'annoncé, jamais de panneau vague');
ds = PD.denialsFromUserEvent(user(res(REAL[1], true, 't3')), uses);
ok(ds[0]?.preview === 'claude code permissions', 'aperçu d\'une recherche web = sa requête');
ok(PD.denialsFromResult({ type: 'result', permission_denials: [
  { tool_name: 'Write', tool_use_id: 'x', tool_input: { file_path: 'a/SKILL.md', content: '…' } },
  { tool_name: 'Bash', tool_use_id: 'y', tool_input: {} },
] }).map(d => d.toolName + ':' + d.preview).join() === 'Write:a/SKILL.md', 'permission_denials du result : complets seulement');

console.log('\n── Pertinence du bouton « ajouter l\'outil »');
ok(PD.toolAllowed('Read,Edit,Write,Bash,WebFetch', 'Bash') === true, 'Bash déjà autorisé → pas de bouton');
ok(PD.toolAllowed('Read,Bash(git:*)', 'Bash') === true, 'Bash(git:*) compte pour Bash');
ok(PD.toolAllowed('Read,Edit', 'Agent') === false, 'Agent absent → bouton');

console.log('\n── Web et Android : mêmes motifs');
const KT = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'orchestrateur', 'data', 'Musician.kt'), 'utf8');
const ktBlock = KT.slice(KT.indexOf('val DENIAL_PATTERNS'), KT.indexOf(')\n', KT.indexOf('val DENIAL_PATTERNS')));
const ktSources = [...ktBlock.matchAll(/Regex\("((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\\\/g, '\\'));
const jsSources = PD.DENIAL_PATTERNS.map(r => r.source);
ok(ktSources.length === jsSources.length, `même nombre de motifs (${ktSources.length}/${jsSources.length})`);
ok(ktSources.every((s, i) => s === jsSources[i]), 'motifs identiques un à un');
ok(/b\.isError == true/.test(KT) && !/contains\("requires approval"/.test(KT), 'Android exige is_error et n\'utilise plus la sous-chaîne');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
ok(!/includes\("requires approval"\)/.test(APP), 'public/app.js n\'utilise plus la sous-chaîne');

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
