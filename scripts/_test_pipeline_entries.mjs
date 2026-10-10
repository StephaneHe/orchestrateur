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
import { explicitChoice } from './pipeline-observe.mjs';
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
section('1. Classement par le model de la case routage.classifier — sans aucun repli par mots-clés (0.66.0)');
const fakeShot = (answers) => { const calls = []; return { calls, fn: async (prompt, o) => { calls.push({ prompt, model: o.model }); const a = answers.shift(); return typeof a === 'string' ? { ok: true, text: a } : a; } }; };
ok(C.parseClassification('{"pipeline":"dev","mode":"complet","nature":"comportement","raison":"nouvelle vue"}')?.mode === 'complet', 'JSON valide accepté');
ok(C.parseClassification('Voici : {"pipeline":"dev","mode":"leger","nature":"bugfix"} fin')?.kind === 'bugfix', 'JSON entouré de texte accepté ; la nature d’une demande de dev est lue');
ok(C.parseClassification('{"pipeline":"routage","mode":"leger"}') === null, 'Routage refusé (pipeline du chef)');
ok(C.parseClassification('{"pipeline":"inconnu","mode":"leger"}') === null && C.parseClassification('{"pipeline":"dev"}') === null && C.parseClassification('non') === null, 'pipeline inconnu, mode absent, texte libre → refusés');
ok(C.parseClassification('{"pipeline":"dev","mode":"leger"}') === null, 'dev sans nature → refusé (la nature est classée par le model, pas devinée)');
ok(/\[CLASSIFY\]/.test(C.classificationPrompt('x')) && /discussion/.test(C.classificationPrompt('x')) && !/- routage:/.test(C.classificationPrompt('x')), 'prompt : marqueur, liste des pipelines sans Routage');

routing({});
let s = fakeShot(['{"pipeline":"dev","mode":"leger","nature":"comportement","raison":"x"}']);
let r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'ajoute un bouton', oneShot: s.fn });
ok(r.failed === true && s.calls.length === 0 && /routage\.classifier/.test(r.why) && !r.pipeline, 'case vide → ÉCHEC (pause chez l’appelant), sans appel au model, jamais de règles');

routing({ 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } });
s = fakeShot(['{"pipeline":"dev","mode":"complet","nature":"comportement","raison":"nouvelle fonctionnalité"}']);
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'implémente une page de statistiques', oneShot: s.fn });
ok(r.classifier === 'model:claude-haiku-5-5' && r.pipeline === 'dev' && r.mode === 'complet' && r.kind === 'simple' && s.calls[0].model === 'claude-haiku-5-5', 'case affectée → le model de la case classe (pipeline, mode, nature)');
ok(!('rules' in r) && !('agree' in r), 'aucune comparaison à des règles : il n’y en a plus');
const rec = fs.readFileSync(path.join(T, 'logs', C.CLASSIFY_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop();
ok(rec.ok && rec.model === 'claude-haiku-5-5' && rec.model_result.pipeline === 'dev', 'décision journalisée (pipeline-classify.ndjson)');

s = fakeShot(['bof', '{"pipeline":"discussion","mode":"leger","raison":"question"}']);
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'pourquoi ça marche ?', oneShot: s.fn });
ok(s.calls.length === 2 && r.pipeline === 'discussion' && r.classifier.startsWith('model:'), 'réponse invalide → UNE nouvelle tentative');

s = fakeShot(['bof', { ok: false, why: 'délai dépassé' }]);
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'ajoute un bouton export', oneShot: s.fn });
const recFail = fs.readFileSync(path.join(T, 'logs', C.CLASSIFY_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop();
ok(s.calls.length === 2 && r.failed === true && /délai dépassé/.test(r.why) && !r.pipeline && recFail.ok === false, 'deux échecs → ÉCHEC tracé, aucun classement par règles');

s = fakeShot([]);
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: '/redaction écris un courriel', oneShot: s.fn });
ok(s.calls.length === 0 && r.explicit && r.pipeline === 'redaction', 'préfixe explicite complet → jamais de model (le choix l’emporte)');
s = fakeShot(['{"nature":"bugfix","raison":"un défaut"}']);
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: '/dev /complet corrige le titre', oneShot: s.fn });
ok(s.calls.length === 1 && /The user already chose pipeline "dev" and mode "complet"/.test(s.calls[0].prompt) && r.pipeline === 'dev' && r.mode === 'complet' && r.kind === 'bugfix', '/dev /complet : le model ne décide que la nature, le choix explicite est gardé');

routing({ 'routage.classifier': { provider: 'openai', model: 'gpt-6-astra' } });
// 0.53.0 : tout fournisseur classe. codex : vrai lancement d'une doublure de `codex exec`.
const codexLog = path.join(T, 'codex.log');
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'compare les bibliothèques de graphiques',
  env: { ...process.env, CODEX_BIN: path.join(ROOT, 'tests', 'fake_codex', 'fake_codex.mjs'), FAKE_CODEX_LOG: codexLog } });
const cl = fs.existsSync(codexLog) ? JSON.parse(fs.readFileSync(codexLog, 'utf8').trim().split('\n').pop()) : {};
ok(r.classifier === 'model:gpt-6-astra' && r.pipeline === 'recherche' && cl.model === 'gpt-6-astra' && cl.sandbox === 'read-only' && cl.classify, 'case OpenAI → codex exec (model de la case, lecture seule) classe', JSON.stringify({ r: r.classifier, cl }));
// OpenRouter / NVIDIA : API chat, clé lue côté orchestrateur, envoyée seulement à son fournisseur.
const calls = [];
const fakeFetch = async (url, init) => { calls.push({ url, auth: init.headers.authorization, model: JSON.parse(init.body).model }); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"pipeline":"redaction","mode":"leger","raison":"courriel"}' } }] }) }; };
routing({ 'routage.classifier': { provider: 'openrouter', model: 'vendor/small-1' } });
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'écris un courriel au client', keys: () => 'key-or-0000000000000000', fetchImpl: fakeFetch });
ok(r.classifier === 'model:vendor/small-1' && r.pipeline === 'redaction' && new URL(calls[0].url).host === 'openrouter.ai' && calls[0].auth === 'Bearer key-or-0000000000000000', 'case OpenRouter → API chat d’OpenRouter seulement');
routing({ 'routage.classifier': { provider: 'nvidia', model: 'moonshotai/kimi-k3' } });
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'écris un courriel au client', keys: () => 'key-nv-0000000000000000', fetchImpl: fakeFetch });
ok(r.classifier === 'model:moonshotai/kimi-k3' && new URL(calls[1].url).host === 'integrate.api.nvidia.com' && calls[1].model === 'moonshotai/kimi-k3', 'case NVIDIA → API de NVIDIA seulement');
r = await C.classifyEntry({ root: T, logsDir: path.join(T, 'logs'), text: 'ajoute un bouton', keys: () => null, fetchImpl: fakeFetch });
ok(r.failed === true && /clé NVIDIA absente/.test(r.why), 'clé absente → ÉCHEC (pause), dit pourquoi — jamais de règles');
const last = fs.readFileSync(path.join(T, 'logs', C.CLASSIFY_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
ok(last.some(x => x.provider === 'openrouter' && x.ok) && last.some(x => x.provider === 'codex' && x.ok), 'fournisseur tracé dans la comparaison');

// ---------------------------------------------------------------------------
section('2. Terminal routé : aucune décision par mots — lignes retenues pour le model, confirmation, octets transmis');
const mk = () => new TR.TerminalRouter({ classify: (l) => explicitChoice({ text: l }) });
let t = mk();
let f = t.feed('/discussion Pourquoi la suite passe ?\r');
ok(f.forward === '/discussion Pourquoi la suite passe ?\r' && !f.hold, 'Discussion choisie explicitement (/discussion) → transmise telle quelle');
f = t.feed('ajoute une fonction moitie');
ok(f.forward === 'ajoute une fonction moitie' && !f.hold, 'frappe transmise caractère par caractère (affichage normal)');
f = t.feed('\rsuite tapée');
ok(f.forward === '' && f.hold?.toClassify === true && f.hold.classification === null && f.hold.line === 'ajoute une fonction moitie', 'Entrée d’une ligne sans choix explicite → retenue, à classer par le MODEL (aucune devinette par mots)');
ok(t.feed('encore').forward === '', 'pendant l’attente, la frappe est mise de côté');
let res = t.resolve(f.hold.id, 'run');
ok(res.action === 'run' && res.forward === '\x15suite tapéeencore', 'lancer → Ctrl+U efface la ligne, la frappe mise de côté est rendue');
t = mk(); f = t.feed('Pourquoi la suite passe ?\r');
ok(f.hold?.toClassify === true, 'même une question est classée par le model (le serveur la transmet si le model dit « discussion »)');
res = t.resolve(f.hold.id, 'discuss');
ok(res.forward === '\r', 'envoyer en Discussion → Entrée transmise');
t = mk(); f = t.feed('/dev /complet ajoute un export\r');
ok(f.hold?.classification?.pipeline === 'dev' && f.hold.classification.mode === 'complet' && !f.hold.toClassify, 'préfixe explicite → retenu avec le choix de l’utilisateur, sans model');
t = mk(); f = t.feed('!del fichier\r');
ok(f.hold?.shell === true, 'commande shell directe « ! » retenue');
res = t.resolve(f.hold.id, 'discuss');
ok(res.action === 'cancel' && res.forward === '\x15', '« ! » ne part jamais au terminal, même si on demande la Discussion');
t = mk(); f = t.feed('# toujours utiliser tabs\r');
ok(f.hold?.shell === true, 'écriture en mémoire « # » retenue');
t = mk(); f = t.feed('\x1b[200~ajoute un bouton\rsur deux lignes\x1b[201~');
ok(!f.hold && f.forward.includes('\r'), 'Entrée DANS un collage : jamais interceptée');
f = t.feed('\r');
ok(f.hold?.line === 'ajoute un bouton sur deux lignes', 'collage validé ensuite : ligne entière retenue');
t = mk(); f = t.feed('ajoute un truc\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7fpourquoi ?\r');
ok(f.hold?.line === 'pourquoi ?', 'retour arrière appliqué avant le classement');
const srvT = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
ok(/hold\.toClassify[\s\S]{0,600}classifyEntry\(\{ root: __dirname/.test(srvT) && /c\.pipeline === 'discussion'\) return decide\(\{ id: hold\.id, action: 'discuss' \}\)/.test(srvT), 'serveur : la ligne retenue est classée par le model ; « discussion » → transmise, sinon confirmation');
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
ok(explicitChoice({ text: O.withPipelinePrefix('ajoute x', { pipeline: 'dev', pipelineMode: 'complet' }) }).mode === 'complet', 'le préfixe produit est bien reconnu par le classement');
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
const d = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'NG', 'ajoute un bouton', '--pipeline', 'dev', '--mode', 'leger', '--kind', 'simple'], { env, encoding: 'utf8', timeout: 60_000 });
const lg = fs.readFileSync(path.join(T, 'logs', 'NG.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
ok(d.status === 64 && lg.some(e => e.type === 'user_prompt') && lg.some(e => e.type === 'result' && e.is_error && e.subtype === 'error_pipeline_refused' && /dépôt git/.test(e.result)),
  'refus écrit dans le log du musicien (demande + result ✕ avec la raison)', `${d.status} ${JSON.stringify(lg.slice(-1))}`);

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
