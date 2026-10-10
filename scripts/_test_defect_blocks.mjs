#!/usr/bin/env node
// ============================================================================
// scripts/_test_defect_blocks.mjs — every detected problem blocks delivery and
// is reported at once (0.65.0)
// ============================================================================
//
// User rule (2026-10-10), verbatim: « tout problème détecté doit bloquer une
// livraison et être rapporté immédiatement ». It answers NO to « ne bloquer la
// livraison que pour les défauts graves (P1) ? »: whatever its severity (P1,
// P2, P3, a finding on the doc, the registry, the CHANGELOG, an unmet step
// criterion, a red test, a scan…), a defect blocks the delivery until it is
// fixed or explicitly accepted by the user.
//
// Protected:
//   - a P2 defect, or a doc finding, found by an item's Review: the item is
//     NOT delivered until it is fixed and reviewed again;
//   - the report (event in the log + notification to the chef) leaves at the
//     moment of detection, before the engine goes on;
//   - a refused step attempt is reported at once;
//   - a defect never fixed: the item is never delivered; « accepter » delivers
//     it, the defects being recorded for the CHANGELOG;
//   - no severity threshold left (audit), corrections never skipped (writing).
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_defect_blocks.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { catalogSteps } from './pipeline-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// Notifications to the chef are timestamped on receipt: « at once » is checked
// against the time the engine went on.
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push({ at: Date.now(), path: req.url, ...JSON.parse(b) }); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-defects-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
const slots = ['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => `dev.${s}`)
  .concat(['rediger', 'relire', 'mettre-en-forme'].map(s => `redaction.${s}`));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(slots.map(s => [s, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev', 'redaction'] },
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const reset = () => { g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur'); };

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_REVIEW_ITEM', 'FAKE_PIPE_REVIEW_DOC_ITEM', 'FAKE_PIPE_REVIEW_SEVERITY', 'FAKE_PIPE_REVIEW_LOG', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_JSON', 'FAKE_PIPE_NOTHING',
  'ORCH_PIPE_REVIEW_ROUNDS', 'ORCH_PIPE_ITEMS']) delete baseEnv[k];
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const go = async (args, env) => {
  const n0 = logOf().length, k0 = notices.length;
  const r = await dispatch(args, env);
  const evs = logOf().slice(n0);
  return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run, done: evs.filter(e => e.subtype === 'pipeline_step_done'), notes: notices.slice(k0) };
};
const subjects = () => g('log', '--format=%s', `${H0}..HEAD`).stdout.trim().split('\n').filter(Boolean).reverse();
const tag = (e) => e.subtype === 'pipeline_item_delivered' ? `livré${e.pipeline.item}` : e.subtype === 'pipeline_defect' ? `défaut${e.pipeline.item ?? ''}` : e.subtype === 'pipeline_step_done' ? e.pipeline.step : e.subtype;
const order = (evs) => evs.filter(e => e.subtype === 'pipeline_item_delivered' || e.subtype === 'pipeline_defect' || (e.subtype === 'pipeline_step_done' && ['revue', 'vert', 'rouge'].includes(e.pipeline.step))).map(tag).join(',');
/** The notification left before the engine started its next step. */
const reportedAtOnce = (r, defect) => {
  const note = r.notes.find(n => n.source === 'pipeline-defect' && n.project === 'chef' && n.text.includes(defect.text.slice(0, 60)));
  const next = r.evs.slice(r.evs.indexOf(defect) + 1).find(e => e.subtype === 'pipeline_step_start');
  return !!note && (!next || note.at <= Date.parse(next.timestamp) + 50);
};

// ---------------------------------------------------------------------------
section('1. Un défaut P2 relevé par la Revue d’un item : signalé aussitôt, l’item n’est livré qu’une fois corrigé et relu');
let r = await go(['Ajoute la multiplication par deux et trois', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_REVIEW_ITEM: '1:1', FAKE_PIPE_REVIEW_SEVERITY: 'P2' });
let def = r.evs.find(e => e.subtype === 'pipeline_defect');
ok(r.code === 0 && def?.defects?.[0]?.severity === 'P2' && def.pipeline.item === 1 && def.pipeline.step === 'revue', `défaut P2 de l’item 1 signalé (${def?.text?.slice(0, 120)})`, r.out.slice(-800));
ok(reportedAtOnce(r, def), 'le chef est prévenu au moment de la détection, avant que le moteur ne continue');
ok(/^rouge,vert,revue,défaut1,rouge,vert,revue,livré1,/.test(order(r.evs)), `l’item 1 n’est livré qu’après la correction (sa case rattachée) et une nouvelle Revue sans défaut (${order(r.evs)})`);
ok(/Includes 1 case\(s\) attached/.test(g('log', '-1', '--format=%B', g('log', '--format=%H', '--grep=^feat(item 1)', `${H0}..HEAD`).stdout.trim()).stdout), 'le commit de l’item 1 contient sa correction');
reset();

// ---------------------------------------------------------------------------
section('2. Un constat sur la doc (non testable) bloque aussi : correction, nouvelle Revue, puis livraison');
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_REVIEW_DOC_ITEM: '1:1' });
def = r.evs.find(e => e.subtype === 'pipeline_defect');
ok(r.code === 0 && def?.defects?.[0]?.severity === 'doc' && /README/.test(def.defects[0].description), `constat de doc signalé comme défaut (${def?.text?.slice(0, 120)})`, r.out.slice(-800));
ok(reportedAtOnce(r, def), 'prévenu au moment de la détection');
ok(order(r.evs) === 'rouge,vert,revue,défaut1,vert,revue,livré1', `aucune livraison avant la correction et la nouvelle Revue (${order(r.evs)})`);
ok(!(runState(r.run).deliveryFixes || []).length && !r.evs.some(e => e.subtype === 'pipeline_delivery_fixes'), 'plus jamais « remis à Livrer » sans bloquer');
reset();

// ---------------------------------------------------------------------------
section('3. Un critère d’étape non rempli est signalé tout de suite, même si l’essai suivant passe');
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_BAD: 'vert:1' });
def = r.evs.find(e => e.subtype === 'pipeline_defect');
ok(r.code === 0 && def?.pipeline?.step === 'vert' && /fichiers de test modifiés/.test(def.defects[0].description), `essai refusé de 4b signalé (${def?.text?.slice(0, 120)})`, r.out.slice(-600));
ok(reportedAtOnce(r, def), 'prévenu avant le nouvel essai');
reset();

// ---------------------------------------------------------------------------
section('4. Un défaut jamais corrigé : l’item n’est jamais livré ; « accepter » le livre, défauts notés');
r = await go(['Ajoute la multiplication par deux et trois', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_REVIEW_DOC_ITEM: '1', ORCH_PIPE_REVIEW_ROUNDS: '1' });
const run4 = r.run;
const res4 = r.evs.filter(e => e.type === 'result').pop()?.result || '';
ok(r.code === 2 && !subjects().some(s => /^feat\(item 1\)/.test(s)) && subjects().some(s => /^feat\(item 2\)/.test(s)), `constat de doc toujours là après son tour : l’item 1 n’est PAS livré, l’item 2 l’est (${subjects().join(' | ')})`, r.out.slice(-600));
ok(/« accepter »/.test(res4) && /NEEDS_USER_INPUT:.*« accepter »/.test(res4), 'la pause propose « accepter » (livrer en connaissance de cause)');
r = await go(['accepter'], { FAKE_PIPE_ITEMS: '2', ORCH_PIPE_REVIEW_ROUNDS: '1' });
const acc = r.evs.find(e => e.subtype === 'pipeline_defect_accepted');
const livLog = fs.readFileSync(path.join(T, 'logs', 'runs', run4, r.done.filter(d => d.pipeline.step === 'livrer').pop()?.pipeline.key + '.jsonl'), 'utf8');
ok(r.code === 0 && r.run === run4 && acc?.pipeline?.item === 1 && subjects().some(s => /^feat\(item 1\)/.test(s)), `« accepter » : l’item 1 est livré, l’acceptation est tracée (« ${acc?.text?.slice(0, 100)} »)`, r.out.slice(-600));
ok(/Défauts ACCEPTÉS explicitement/.test(livLog) && /README/.test(livLog) && runState(run4).acceptedDefects?.length === 1, 'Livrer reçoit les défauts acceptés, à noter dans le CHANGELOG');
reset();

// ---------------------------------------------------------------------------
section('5. Léger : un défaut bloque Livrer ; « accepter » seulement sur décision explicite');
r = await go(['Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_REVIEW: 'problemes', ORCH_PIPE_REVIEW_ROUNDS: '1' });
const run5 = r.run;
ok(r.code === 2 && !r.done.some(d => d.pipeline.step === 'livrer') && g('rev-list', '--count', `${H0}..HEAD`).stdout.trim() === '0' && r.evs.filter(e => e.subtype === 'pipeline_defect').length >= 2,
  `défaut toujours relevé : pause, aucun commit, chaque relecture signalée (code ${r.code})`, r.out.slice(-600));
r = await go(['accepter'], { ORCH_PIPE_REVIEW_ROUNDS: '1' });
ok(r.code === 0 && r.run === run5 && r.evs.some(e => e.subtype === 'pipeline_defect_accepted') && g('rev-list', '--count', `${H0}..HEAD`).stdout.trim() === '1', '« accepter » : livré, acceptation tracée');
reset();

// ---------------------------------------------------------------------------
section('6. Plus de seuil de gravité (audit) ; une correction de relecture ne peut pas être ignorée (rédaction)');
const audit = catalogSteps('audit');
ok(/quelle que soit leur gravité/.test(audit.find(s => s.id === 'corriger').role) && /quelle que soit leur gravité/.test(audit.find(s => s.id === 'reverifier').role) && /basse/.test(audit.find(s => s.id === 'reverifier').jsonExample),
  'audit : toutes les failles sont à corriger et à re-vérifier, y compris de gravité basse');
r = await go(['rédige le guide d’installation', '--pipeline', 'redaction', '--test', 'défauts'], { FAKE_PIPE_JSON: JSON.stringify({ relire: { corrections: ['corriger la faute du titre'] } }), FAKE_PIPE_NOTHING: 'mettre-en-forme' });
const mef = r.done.filter(d => d.pipeline.step === 'mettre-en-forme');
ok(r.code === 2 && mef.length === 2 && mef.every(d => d.status === 'refused' && /correction\(s\) à appliquer/.test(d.why)) && g('rev-list', '--count', `${H0}..HEAD`).stdout.trim() === '0',
  `« rien à mettre en forme » alors que la relecture liste une correction : refusé, rien livré (${mef.map(d => d.status).join(',')})`, r.out.slice(-600));
ok(r.evs.filter(e => e.subtype === 'pipeline_defect' && e.pipeline.step === 'mettre-en-forme').length === 2, 'chaque refus est signalé');
reset();

srv.close();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
