#!/usr/bin/env node
// ============================================================================
// scripts/_test_pipeline_entries.mjs — pipelines, phase 5 (0.52.0): every entry
// goes through a pipeline
// ============================================================================
//
// User request (2026-10-09): "est-ce que l'on utilise les pipeline specifies
// plutot ? Sinon, il faut faire en sorte que ces pipelines soient
// obligatoirement utlises." Phase 5 = all entries wired: classification by the
// model of the routage.classifier slot, terminal routing, enforcement switch.
// End-to-end entry paths are covered by the HTTP checks `pipeline-all-entries`
// and `terminal-routing` of regression.mjs.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from './pipeline-classify.mjs';
import * as TR from './terminal-route.mjs';
import { classify } from './pipeline-observe.mjs';
import { readEnforcement, writeEnforcement } from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 400)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-entries-'));
fs.mkdirSync(path.join(T, 'logs'));
const routing = (assignments, enforcement = { projects: ['P'], pipelines: ['discussion', 'dev'] }) =>
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, assignments, history: [], enforcement }));

// ---------------------------------------------------------------------------
section('1. Classement par le model de la case routage.classifier');
const fakeShot = (answers) => { const calls = []; return { calls, fn: async (prompt, o) => { calls.push({ prompt, model: o.model }); const a = answers.shift(); return typeof a === 'string' ? { ok: true, text: a } : a; } }; };
ok(C.parseClassification('{"pipeline":"dev","mode":"complet","raison":"nouvelle vue"}')?.mode === 'complet', 'JSON valide accepté');
ok(C.parseClassification('Voici : {"pipeline":"dev","mode":"leger"} fin')?.pipeline === 'dev', 'JSON entouré de texte accepté');
ok(C.parseClassification('{"pipeline":"routage","mode":"leger"}') === null, 'Routage refusé (pipeline du chef)');
ok(C.parseClassification('{"pipeline":"inconnu","mode":"leger"}') === null && C.parseClassification('{"pipeline":"dev"}') === null && C.parseClassification('non') === null, 'pipeline inconnu, mode absent, texte libre → refusés');
ok(/\[CLASSIFY\]/.test(C.classificationPrompt('x')) && /discussion/.test(C.classificationPrompt('x')) && !/- routage:/.test(C.classificationPrompt('x')), 'prompt : marqueur, liste des pipelines sans Routage');

routing({});
let s = fakeShot(['{"pipeline":"dev","mode":"leger","raison":"x"}']);
let r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'ajoute un bouton', oneShot: s.fn });
ok(r.classifier === 'règles-v1' && s.calls.length === 0 && /non affectée/.test(r.note), 'case vide → règles, sans appel au model, note');

routing({ 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } });
s = fakeShot(['{"pipeline":"dev","mode":"complet","raison":"nouvelle fonctionnalité"}']);
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'implémente une page de statistiques', oneShot: s.fn });
ok(r.classifier === 'model:claude-haiku-5-5' && r.pipeline === 'dev' && r.mode === 'complet' && s.calls[0].model === 'claude-haiku-5-5', 'case affectée → le model de la case classe');
ok(r.rules?.pipeline && typeof r.agree === 'boolean', 'décision comparée aux règles');
const rec = fs.readFileSync(path.join(T, 'logs', C.CLASSIFY_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop();
ok(rec.ok && rec.model === 'claude-haiku-5-5' && rec.model_result.pipeline === 'dev', 'comparaison journalisée (pipeline-classify.ndjson)');

s = fakeShot(['bof', '{"pipeline":"discussion","mode":"leger","raison":"question"}']);
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'pourquoi ça marche ?', oneShot: s.fn });
ok(s.calls.length === 2 && r.pipeline === 'discussion' && r.classifier.startsWith('model:'), 'réponse invalide → UNE nouvelle tentative');

s = fakeShot(['bof', { ok: false, why: 'délai dépassé' }]);
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'ajoute un bouton export', oneShot: s.fn });
ok(s.calls.length === 2 && r.classifier === 'règles-v1' && /impossible/.test(r.note) && r.pipeline === classify({ text: 'ajoute un bouton export' }).pipeline, 'deux échecs → règles, tracé');

s = fakeShot([]);
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: '/dev /complet ajoute un bouton', oneShot: s.fn });
ok(s.calls.length === 0 && r.explicit && r.pipeline === 'dev' && r.mode === 'complet', 'préfixe explicite → jamais de model (le choix l’emporte)');

routing({ 'routage.classifier': { provider: 'openai', model: 'gpt-6-astra' } });
s = fakeShot([]);
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'ajoute un bouton', oneShot: s.fn });
ok(s.calls.length === 0 && r.classifier === 'règles-v1' && /seul un model Claude/.test(r.note), 'case non Claude → règles, dit pourquoi');

// ---------------------------------------------------------------------------
section('2. Terminal routé : lignes retenues, confirmation, octets transmis');
const mk = () => new TR.TerminalRouter({ classify: (l) => classify({ text: l }) });
let t = mk();
let f = t.feed('Pourquoi la suite passe ?\r');
ok(f.forward === 'Pourquoi la suite passe ?\r' && !f.hold, 'question → transmise telle quelle');
f = t.feed('ajoute une fonction moitie');
ok(f.forward === 'ajoute une fonction moitie' && !f.hold, 'frappe transmise caractère par caractère (affichage normal)');
f = t.feed('\rsuite tapée');
ok(f.forward === '' && f.hold?.classification.pipeline === 'dev' && f.hold.line === 'ajoute une fonction moitie', 'Entrée d’une ligne d’action → retenue (Entrée non transmise)');
ok(t.feed('encore').forward === '', 'pendant l’attente, la frappe est mise de côté');
let res = t.resolve(f.hold.id, 'run');
ok(res.action === 'run' && res.forward === '\x15suite tapéeencore', 'lancer → Ctrl+U efface la ligne, la frappe mise de côté est rendue');
t = mk(); f = t.feed('corrige le bug du titre\r');
res = t.resolve(f.hold.id, 'discuss');
ok(res.forward === '\r', 'envoyer en Discussion → Entrée transmise');
t = mk(); f = t.feed('!del fichier\r');
ok(f.hold?.shell === true, 'commande shell directe « ! » retenue');
res = t.resolve(f.hold.id, 'discuss');
ok(res.action === 'cancel' && res.forward === '\x15', '« ! » ne part jamais au terminal, même si on demande la Discussion');
t = mk(); f = t.feed('# toujours utiliser tabs\r');
ok(f.hold?.shell === true, 'écriture en mémoire « # » retenue');
t = mk(); f = t.feed('\x1b[200~ajoute un bouton\rsur deux lignes\x1b[201~');
ok(!f.hold && f.forward.includes('\r'), 'Entrée DANS un collage : jamais interceptée');
f = t.feed('\r');
ok(f.hold?.line === 'ajoute un bouton sur deux lignes', 'collage validé ensuite : ligne entière classée');
t = mk(); f = t.feed('ajoute un truc\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7fpourquoi ?\r');
ok(!f.hold, 'retour arrière appliqué avant le classement');
t = mk();
ok(t.resolve('t-inconnu', 'run') === null, 'identifiant inconnu → rien');
const frame = TR.encodeFrame({ type: 'route-confirm', id: 'x', line: 'é' });
ok(frame.startsWith('\x1b]1337;OrchRoute=') && frame.endsWith('\x07') && TR.decodeFrames(`abc${frame}def`)[0].line === 'é', 'trame de contrôle OSC (ignorée par un terminal qui ne la connaît pas)');
const P = [{ name: 'chef' }, { name: 'omega' }];
ok(TR.targetOf('@omega ajoute x', P, 'chef').project === 'omega' && TR.targetOf('omega : ajoute x', P, 'chef').text === 'ajoute x' && TR.targetOf('ajoute x', P, 'chef').project === 'chef', 'cible : @projet, « projet : », sinon le chef');
const da = TR.discussionArgs();
ok(da.includes('plan') && da.join(' ').includes('Edit,Write,NotebookEdit,Bash,PowerShell'), 'Discussion du terminal : mode plan, aucun outil d’écriture ni shell');

// ---------------------------------------------------------------------------
section('3. Mise en service du terminal (pipeline-enforce.mjs)');
routing({}, { projects: ['P'], pipelines: ['discussion', 'dev'] });
ok(readEnforcement(T).terminal === false, 'par défaut : terminal non routé');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ projects: [{ name: 'P', path: T }] }));
const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline-enforce.mjs'), ...a], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: T }, encoding: 'utf8' });
let o = cli('on', '--terminal');
ok(o.status === 0 && readEnforcement(T).terminal === true && readEnforcement(T).projects.includes('P'), 'on --terminal : routé, projets inchangés');
writeEnforcement(T, { projects: ['P'], pipelines: ['dev'], by: 'test' });
ok(readEnforcement(T).terminal === true, 'une écriture qui ne parle pas du terminal le conserve');
o = cli('off', '--all');
ok(o.status === 0 && readEnforcement(T).terminal === false && !readEnforcement(T).projects.length, 'off --all : retour arrière complet, terminal compris');

// ---------------------------------------------------------------------------
section('3b. Choix du sélecteur : validation, drapeaux, préfixe vers le chef, câblage serveur');
const O = await import('./pipeline-entry-opts.mjs');
const o1 = O.pipelineOptsFrom({ pipeline: 'dev', pipelineMode: 'complet', horsPipeline: '  a\n b ', pipelineResume: 'p-20261009T120000-abcd' });
ok(JSON.stringify(O.pipelineArgs(o1)) === JSON.stringify(['--pipeline', 'dev', '--mode', 'complet', '--pipeline-resume', 'p-20261009T120000-abcd', '--hors-pipeline', 'a b']), 'choix valides → drapeaux de dispatch.mjs (tableau)');
const o2 = O.pipelineOptsFrom({ pipeline: 'audit; rm -rf', pipelineMode: 'max', pipelineResume: '../x', horsPipeline: '   ' });
ok(O.pipelineArgs(o2).length === 0 && O.pipelineArgs(O.pipelineOptsFrom({ pipeline: 'auto' })).length === 0, 'valeurs inconnues ou « auto » → rien d’imposé');
ok(O.withPipelinePrefix('ajoute x', { pipeline: 'dev', pipelineMode: 'complet' }) === '/dev /complet ajoute x', 'vers le chef : Dév. complet → « /dev /complet … »');
ok(O.withPipelinePrefix('pourquoi ?', { pipeline: 'discussion' }) === '/discussion pourquoi ?', 'vers le chef : Discussion → « /discussion … »');
ok(O.withPipelinePrefix('/léger corrige x', { pipeline: 'dev', pipelineMode: 'complet' }) === '/léger corrige x' && O.withPipelinePrefix('x', {}) === 'x', 'préfixe déjà tapé ou auto → texte inchangé');
ok(classify({ text: O.withPipelinePrefix('ajoute x', { pipeline: 'dev', pipelineMode: 'complet' }) }).mode === 'complet', 'le préfixe produit est bien reconnu par le classement');
const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
ok(/text: withPipelinePrefix\(isOverride \? promptForRouting : prompt, pipelineOptsFrom\(req\.body\)\)/.test(srv), 'serveur : le message au chef porte le préfixe du sélecteur');
ok(/queuePush\(directProj\.name, \{[^}]*\.\.\.pOpts \}\)/.test(srv) && /spawnDirectDispatch\(directProj\.name, stripped, attachmentPaths, videoPaths, \{ obsId, \.\.\.pOpts \}\)/.test(srv), 'serveur : @mention (file et lancement direct) garde le choix');
ok(/dispatchArgs\.push\(\.\.\.pipelineArgs\(pipelineOptsFrom\(req\.body\)\)\)/.test(srv) && /args\.push\(\.\.\.pipelineArgs\(pipelineOptsFrom\(opts\)\)\)/.test(srv), 'serveur : accès direct et spawnDirectDispatch (file, pool) passent le choix');

// ---------------------------------------------------------------------------
section('4. Choix explicite impossible (projet sans git) : refus VISIBLE dans le fil');
const NG = path.join(T, 'nogit');
fs.mkdirSync(NG);
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read' }, projects: [{ name: 'chef', path: T }, { name: 'NG', path: NG }] }));
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs'), ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', FAKE_CLAUDE_LATENCY_MS: '5' };
for (const k of ['ANTHROPIC_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT']) delete env[k];
const d = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'NG', 'ajoute un bouton', '--pipeline', 'dev'], { env, encoding: 'utf8', timeout: 60_000 });
const lg = fs.readFileSync(path.join(T, 'logs', 'NG.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
ok(d.status === 64 && lg.some(e => e.type === 'user_prompt') && lg.some(e => e.type === 'result' && e.is_error && e.subtype === 'error_pipeline_refused' && /dépôt git/.test(e.result)),
  'refus écrit dans le log du musicien (demande + result ✕ avec la raison)', `${d.status} ${JSON.stringify(lg.slice(-1))}`);

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
