#!/usr/bin/env node
// ============================================================================
// scripts/_test_user_requirements.mjs — « toute demande utilisateur devient un
// test de non-régression » (règle fleet, 0.36.0)
// ============================================================================
//
//   1. Le VRAI dispatch.mjs (racine jetable, doublure claude qui enregistre ses
//      arguments) : la consigne est dans le prompt envoyé à claude pour un
//      musicien, absente pour le chef, et jamais dans le texte affiché.
//   2. Le modèle de projet : règle n° 6 du CLAUDE.md, docs/USER_REQUIREMENTS.md,
//      et new-project.mjs qui les pose dans un projet neuf.
//   3. Le registre de l'orchestrateur (docs/USER_REQUIREMENTS.md) : chaque
//      test cité existe, aucun nom de projet privé (dépôt public).
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const section = (n) => console.log(`\n── ${n}`);
const RULE = 'RÈGLE DES EXIGENCES UTILISATEUR';

// ---------------------------------------------------------------------------
section('1. Consigne injectée par dispatch.mjs');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ureq-'));
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'proj'));
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-opus-5-5', allowedTools: 'Read', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'proj') }, { name: 'M', path: path.join(T, 'proj') }],
}));
const STUB = path.join(T, 'claude-stub.mjs');
fs.writeFileSync(STUB, `
import fs from 'node:fs';
fs.writeFileSync(process.env.STUB_ARGS, JSON.stringify(process.argv.slice(2)));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'sid-u', model: 'claude-opus-5-5' });
out({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'fait' }] }, session_id: 'sid-u' });
out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_api_ms: 5, result: 'fait', session_id: 'sid-u' });
`);
const run = (project, prompt, extra = []) => {
  const argsFile = path.join(T, `args-${project}.json`);
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: STUB, STUB_ARGS: argsFile };
  delete env.ANTHROPIC_API_KEY;
  // Lancée depuis un tour du chef (file, pool), la suite hérite de DISPATCH_SLOT
  // & co : dispatch.mjs se croirait « le chef qui parle » et refuserait chef → chef.
  for (const k of Object.keys(env)) if (/^DISPATCH_/.test(k) && k !== 'DISPATCH_ROOT_FOR_TESTS') delete env[k];
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), project, prompt, '--no-queue-if-busy', ...extra],
    { env, encoding: 'utf8', timeout: 60_000 });
  let argv = [];
  try { argv = JSON.parse(fs.readFileSync(argsFile, 'utf8')); } catch {}
  let raw = '';
  try { raw = fs.readFileSync(path.join(T, 'logs', `${project}.jsonl`), 'utf8'); } catch { /* pas de log */ }
  const log = raw.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { r, prompt: argv.find(a => a.startsWith(prompt)) || '', log };
};
const m = run('M', 'Ajoute le mode sombre');
ok(m.r.status === 0, `dispatch musicien terminé (exit ${m.r.status})`);
ok(m.prompt.includes(RULE), 'musicien : consigne présente dans le prompt envoyé à claude');
ok(/TEST AUTOMATISÉ/.test(m.prompt) && /suite de non-régression/.test(m.prompt) && /rejouée à chaque évolution/.test(m.prompt),
  'test automatisé, ajouté à la suite de non-régression, rejouée à chaque évolution');
ok(/docs\/USER_REQUIREMENTS\.md/.test(m.prompt) && /date, demande verbatim, test associé/.test(m.prompt), 'traçabilité dans docs/USER_REQUIREMENTS.md');
ok(/Avant toute modification, rejoue cette suite/.test(m.prompt), 'suite rejouée avant toute modification');
ok(/ni supprimé ni affaibli sans l'accord explicite de l'utilisateur/.test(m.prompt), 'test ni supprimé ni affaibli sans accord');
ok(m.prompt.includes('RÈGLE DE FIN DE TOUR'), 'la règle de fin de tour reste là');
const shown = m.log.find(e => e.type === 'user_prompt');
ok(shown && shown.text === 'Ajoute le mode sombre', 'texte affiché dans le fil : la demande seule, sans la consigne');
const c = run('chef', 'Point sur la flotte');
ok(c.r.status === 0 && c.prompt && !c.prompt.includes(RULE), 'chef : pas de consigne (il route, il ne code pas)');
if (!c.prompt) console.log(String(c.r.stderr || '').slice(-800), String(c.r.stdout || '').slice(-400));
if (!c.prompt) console.log(String(c.r.stderr).slice(-800));

// Exigence 0.37.2 : la consigne de callback passe par un FICHIER (outil Write +
// notify.mjs --file), sans variable shell multi-ligne que le CLI refuse.
section('1b. Consigne de callback : résumé par fichier');
const cb = run('M', 'Corrige le bug de connexion', ['--callback', 'chef']);
ok(cb.r.status === 0, `dispatch avec --callback chef (exit ${cb.r.status})`);
const cbFile = path.join(T, 'proj', '.orchestrateur-callback.md').replace(/\\/g, '/');
ok(cb.prompt.includes(`--file "${cbFile}"`) && /notify\.mjs" chef --file/.test(cb.prompt) && /--source M/.test(cb.prompt), 'consigne : node notify.mjs chef --file "<projet>/.orchestrateur-callback.md" --source M');
ok(/outil Write/.test(cb.prompt), 'consigne : le résumé est écrit avec l\'outil Write');
ok(!/RESUME=/.test(cb.prompt) && !/printf '%s'/.test(cb.prompt) && !/--stdin/.test(cb.prompt) && !/\| node/.test(cb.prompt), 'plus de variable RESUME=, de printf \'%s\', de --stdin ni de pipe dans la consigne');
ok(/sans variable shell, heredoc, printf ni pipe/.test(cb.prompt), 'la consigne dit pourquoi : ces formes sont refusées par le CLI');
ok(cb.log.filter(e => e.type === 'user_prompt').pop()?.text === 'Corrige le bug de connexion', 'consigne invisible dans le fil');
fs.rmSync(T, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('2. Modèle de projet et new-project.mjs');
const tplClaude = fs.readFileSync(path.join(ROOT, 'templates', 'project', 'CLAUDE.md'), 'utf8');
ok(/\*\*6 — Toute demande utilisateur devient un test de non-régression\.\*\*/.test(tplClaude), 'templates/project/CLAUDE.md : règle n° 6');
ok(/docs\/USER_REQUIREMENTS\.md/.test(tplClaude) && /accord explicite de l'utilisateur/.test(tplClaude), 'la règle cite le registre et l\'accord requis');
const tplReq = path.join(ROOT, 'templates', 'project', 'docs', 'USER_REQUIREMENTS.md');
ok(fs.existsSync(tplReq) && /\| Date \| Demande \(verbatim\) \| Test associé \|/.test(fs.readFileSync(tplReq, 'utf8')), 'modèle docs/USER_REQUIREMENTS.md (date, verbatim, test)');
{
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ureq-np-'));
  fs.cpSync(path.join(ROOT, 'templates'), path.join(R, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(R, 'config.json'), JSON.stringify({ conductor: 'chef', defaults: {}, projects: [] }));
  const P = path.join(R, 'Neuf');
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: R };
  delete env.ORCH_CLAUDE_JSON;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'new-project.mjs'), 'Neuf', '--path', P], { env, encoding: 'utf8' });
  const req = path.join(P, 'docs', 'USER_REQUIREMENTS.md');
  ok(r.status === 0 && fs.existsSync(req), 'new-project : docs/USER_REQUIREMENTS.md créé');
  ok(fs.existsSync(req) && /^# Neuf — exigences utilisateur/.test(fs.readFileSync(req, 'utf8')) && !/\{\{/.test(fs.readFileSync(req, 'utf8')), 'nom et date substitués');
  ok(/\*\*6 — Toute demande utilisateur/.test(fs.readFileSync(path.join(P, 'CLAUDE.md'), 'utf8')), 'new-project : la règle est dans le CLAUDE.md du projet');
  fs.rmSync(R, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('3. Registre de l\'orchestrateur');
const reg = fs.readFileSync(path.join(ROOT, 'docs', 'USER_REQUIREMENTS.md'), 'utf8');
const rows = reg.split('\n').filter(l => /^\| 20\d\d-\d\d-\d\d \|/.test(l));
ok(rows.length >= 15, `${rows.length} demandes recensées`);
const httpSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
const navSrc = fs.readFileSync(path.join(ROOT, 'scripts', '_regression_browser.mjs'), 'utf8');
const navIds = new Set([...navSrc.matchAll(/(?:check\(B, |pv\(|v031\()'([a-z0-9-]+)'/g)].map(x => x[1].replace(/^/, '')));
for (const x of navSrc.matchAll(/pv\('([a-z0-9-]+)'/g)) navIds.add(x[1]);
const httpIds = new Set([...httpSrc.matchAll(/check\(S, '([a-z0-9-]+)'/g)].map(x => x[1]));
const missing = [];
let refs = 0;
for (const row of rows) {
  const cells = row.split('|').map(s => s.trim());
  const testCell = cells[3] || '';
  const found = [...testCell.matchAll(/`(suite|http|nav):([^`\s]+)`/g)];
  if (!found.length) missing.push(`(aucun test) ${cells[2].slice(0, 50)}`);
  for (const [, kind, id] of found) {
    refs++;
    if (kind === 'suite' && !fs.existsSync(path.join(ROOT, 'scripts', id))) missing.push(`suite:${id}`);
    if (kind === 'http' && !httpIds.has(id)) missing.push(`http:${id}`);
    if (kind === 'nav' && !navIds.has(id)) missing.push(`nav:${id}`);
  }
}
ok(missing.length === 0, `chaque demande a un test, et les ${refs} références existent${missing.length ? ' — manquants : ' + missing.join(', ') : ''}`);
ok(rows.every(r => /\| 0\.\d+\.\d+ \|$/.test(r)), 'version de livraison renseignée pour chaque demande');
// Dépôt public : aucun nom de projet privé (lu dans le config.json local, s'il existe).
const cfgPath = path.join(ROOT, 'config.json');
if (fs.existsSync(cfgPath)) {
  // The orchestrator's own dev instance (`devOf: orchestrateur`, 0.68.0) is
  // this public repository too, not a private project.
  const names = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).projects
    .filter(p => !['chef', 'orchestrateur'].includes(p.name) && p.devOf !== 'orchestrateur').map(p => p.name);
  const leaked = names.filter(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(reg));
  ok(leaked.length === 0, `aucun nom de projet privé dans le registre${leaked.length ? ' — ' + leaked.join(', ') : ''}`);
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
