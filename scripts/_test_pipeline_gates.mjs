#!/usr/bin/env node
// ============================================================================
// scripts/_test_pipeline_gates.mjs — Développement COMPLET, phase 4 (0.49.0)
// ============================================================================
//
// Demande utilisateur (2026-10-09) : « il faut faire en sorte que ces pipelines
// soient obligatoirement utilisés » — phase 4 : la boucle TDD canonique, UN
// test à la fois (Comprendre → Concevoir → Liste de tests → 4a → 4b → 4c par
// item → Revue → Livrer), critères vérifiés par le code, revue → nouveaux items,
// montée léger → complet, et CHAQUE limite prévient l'utilisateur (log,
// dashboard, chef).
//
// VRAI dispatch.mjs, VRAI moteur, doublure de claude (FAKE_CLAUDE_PIPELINE),
// racine jetable ; les notifications vont à un écouteur local (jamais 7777).
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { deriveState } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 700)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Briques : liste de tests, cases, plan complet, périmètre du léger');
const md = '# Liste\n\n- [ ] a vide renvoie 0\n- [x] déjà fait\n* [ ] b deux mots\ntexte libre\n';
const it = E.parseItems(md);
ok(it.length === 3 && it[0].text === 'a vide renvoie 0' && it[1].done && it[2].n === 3, 'parseItems : cases cochées ou non, dans l’ordre');
ok(E.parseItems(E.checkItem(md, 3)).every(i => i.n !== 3 || i.done) && E.parseItems(E.checkItem(md, 3))[0].done === false, 'checkItem coche l’item n et lui seul');
const plan = E.planSteps('dev', { mode: 'complet' }).map(s => s.id);
ok(plan.join() === 'comprendre,concevoir,liste-tests,@loop,revue,livrer', `plan complet : ${plan.join(' → ')}`);
const cat = E.devCatalog({ mode: 'complet' });
ok(cat.vert.chain[0] === 'dev.vert.complexe' && cat.refactor.chain[0] === 'dev.refactor' && cat['liste-tests'].judge && cat.concevoir.chain[0] === 'dev.concevoir.plan', 'cases : 4b complexe, 4c, liste de tests (jugement), concevoir/plan');

// ---------------------------------------------------------------------------
// Racine jetable + écouteur des notifications (chef)
// ---------------------------------------------------------------------------
const notices = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { notices.push({ path: req.url, ...JSON.parse(b) }); } catch {} res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gates-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: {
    'dev.comprendre': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'dev.concevoir': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'dev.liste-tests': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'dev.rouge': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'dev.vert': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'dev.refactor': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    'dev.revue': { provider: 'anthropic', model: 'claude-fable-5-1' },
    'dev.livrer': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  }, history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
fs.mkdirSync(path.join(P, 'test')); fs.mkdirSync(path.join(P, 'src')); fs.mkdirSync(path.join(P, 'docs')); fs.mkdirSync(path.join(P, '.orchestrateur'));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(P, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(P, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const H0 = g('rev-parse', 'HEAD').stdout.trim();
const reset = () => { g('reset', '-q', '--hard', H0); g('clean', '-qfd', '-e', '.orchestrateur'); };

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_BIG', 'FAKE_PIPE_REFACTOR']) delete baseEnv[k];
// Asynchrone : l'écouteur des notifications tourne dans CE processus.
const dispatch = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 240_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const go = async (args, env) => { const n0 = logOf().length, k0 = notices.length; const r = await dispatch(args, env); const evs = logOf().slice(n0); return { ...r, evs, run: evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run, done: evs.filter(e => e.subtype === 'pipeline_step_done'), notes: notices.slice(k0) }; };
const seq = (done) => done.map(d => `${d.pipeline.step}${d.status === 'ok' ? '' : `:${d.status}`}`).join(',');

// ---------------------------------------------------------------------------
section('2. Complet : Comprendre → Concevoir → Liste → (4a → 4b → 4c) par item → Revue → Livrer');
let r = await go(['Ajoute les fonctions de multiplication par deux et par trois', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2' });
ok(r.code === 0, `exécution terminée (code ${r.code})`, r.out.slice(-1200));
ok(seq(r.done) === 'comprendre,concevoir,liste-tests,rouge,vert,refactor:skipped,rouge,vert,refactor:skipped,revue,livrer', `enchaînement : ${seq(r.done)}`);
const up = r.evs.find(e => e.type === 'user_prompt');
ok(up?.pipeline?.mode === 'complet' && up.pipeline.steps.some(s => s.loop && s.id === 'refactor'), 'user_prompt : mode complet, frise annoncée avec la boucle 4a/4b/4c');
const rouges = r.done.filter(d => d.pipeline.step === 'rouge'), verts = r.done.filter(d => d.pipeline.step === 'vert');
ok(rouges.length === 2 && rouges.every(d => d.test?.ok === false) && verts.every(d => d.test?.ok === true), '4a ÉCHOUE réellement (suite lancée par l’orchestrateur), 4b la rend verte — à chaque item');
ok(r.evs.filter(e => e.subtype === 'pipeline_item_start').length === 2 && r.evs.filter(e => e.subtype === 'pipeline_item_done').length === 2, 'un item à la fois : 2 démarrés, 2 cochés');
const tmd = fs.readFileSync(path.join(P, '.orchestrateur', 'runs', r.run, 'tests.md'), 'utf8');
ok(E.parseItems(tmd).every(i => i.done), 'la boucle s’arrête quand la liste est vide (tout est coché, par le moteur)');
ok(r.done.filter(d => d.pipeline.step === 'refactor').every(d => /seuil/.test(d.why || '')), '4c sautée quand 4b a très peu changé — et c’est dit');
ok(['comprendre', 'concevoir', 'liste-tests'].every(id => r.done.find(d => d.pipeline.step === id)?.served === 'claude-opus-5-5') && verts.every(d => d.served === 'claude-sonnet-5-5'), 'chaque étape sur le model de SA case');
ok(g('rev-list', '--count', `${H0}..HEAD`).stdout.trim() === '1' && fs.existsSync(path.join(P, 'test', 'pipe-1.test.mjs')) && fs.existsSync(path.join(P, 'test', 'pipe-2.test.mjs')), 'un seul commit, un test par item');
ok(/Développement complet terminé/.test(r.evs.find(e => e.type === 'result')?.result || '') && /2 item\(s\)/.test(r.evs.find(e => e.type === 'result').result), 'résultat : « Développement complet », 2 items');
reset();

// ---------------------------------------------------------------------------
section('3. Gardiens : 4b qui touche le test refusé ; 4c qui change le code, ou les tests');
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_BAD: 'vert:1' });
const v3 = r.done.filter(d => d.pipeline.step === 'vert');
ok(r.code === 0 && v3[0]?.status === 'refused' && /fichiers de test modifiés/.test(v3[0].why) && v3[1]?.status === 'ok', `4b qui modifie le test de 4a : refusé puis repris (${seq(r.done)})`);
reset();
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_REFACTOR: '1', ORCH_PIPE_REFACTOR_MIN: '0' });
const rf = r.done.find(d => d.pipeline.step === 'refactor');
ok(r.code === 0 && rf?.status === 'ok' && rf.test?.ok === true && /valeur/.test(fs.readFileSync(path.join(P, 'src', 'pipe-1.mjs'), 'utf8')), '4c exécutée : code nettoyé, suite verte vérifiée');
reset();
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_BAD: 'refactor', ORCH_PIPE_REFACTOR_MIN: '0' });
const rfs = r.done.filter(d => d.pipeline.step === 'refactor');
ok(r.code === 2 && rfs.length === 2 && rfs.every(d => d.status === 'refused' && /test modifiés/.test(d.why)), `4c qui retouche les tests : refusée (2 essais) puis pause (code ${r.code})`);
reset();
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_BAD: 'concevoir:1' });
const cv = r.done.filter(d => d.pipeline.step === 'concevoir');
ok(r.code === 0 && cv[0]?.status === 'refused' && /Approche/.test(cv[0].why) && cv[1]?.status === 'ok', 'Concevoir sans les sections attendues : refusé puis repris');
reset();

// ---------------------------------------------------------------------------
section('4. Revue → chaque problème devient un item → retour à la boucle');
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_REVIEW: 'problemes:1' });
const loop = r.evs.find(e => e.subtype === 'pipeline_loop');
ok(r.code === 0 && loop?.pipeline?.to === 'tdd', `revue → retour à la boucle TDD (${loop?.text})`);
ok(seq(r.done).endsWith('revue,rouge,vert,refactor:skipped,revue,livrer'), `l’item de revue a son propre 4a/4b : ${seq(r.done)}`);
ok(E.parseItems(fs.readFileSync(path.join(P, '.orchestrateur', 'runs', r.run, 'tests.md'), 'utf8')).some(i => /^\(revue\)/.test(i.text) && i.done), 'tests.md : l’item « (revue) … » ajouté puis coché');
reset();

// ---------------------------------------------------------------------------
section('5. Montée léger → complet (garde-fou du plan §4), annoncée');
r = await go(['Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_BIG: '1', FAKE_PIPE_ITEMS: '1' });
const esc = r.evs.find(e => e.subtype === 'pipeline_escalate');
ok(r.code === 0 && esc && /nouveau\(x\) fichier\(s\) de code|fichiers/.test(esc.text), `périmètre dépassé → montée en complet : « ${esc?.text?.slice(0, 110)} »`);
ok(seq(r.done) === 'rouge,vert,liste-tests,rouge,vert,refactor:skipped,revue,livrer', `puis liste de tests et un test à la fois : ${seq(r.done)}`);
const res5 = r.evs.find(e => e.type === 'result')?.result || '';
ok(/Monté de léger en complet/.test(res5) && runState(r.run).mode === 'complet' && runState(r.run).escalated, 'dit dans le résultat ; run.json : mode complet, escalated');
reset();
r = await go(['Ajoute une fonction double', '--mode', 'leger']);
ok(r.code === 0 && !r.evs.some(e => e.subtype === 'pipeline_escalate') && seq(r.done) === 'rouge,vert,revue,livrer', 'changement localisé (fichier existant, 2 lignes) : reste léger');
reset();

// ---------------------------------------------------------------------------
section('6. Chaque limite prévient l’utilisateur : log, dashboard (input), chef');
const limitCase = async (label, args, env, want) => {
  const x = await go(args, env);
  const lim = x.evs.find(e => e.type === 'notification' && e.subtype === 'pipeline_limit');
  const input = deriveState(logOf().map(e => JSON.stringify(e))).state === 'input';
  const chef = x.notes.find(n => n.path === '/api/notify' && n.project === 'chef' && n.source === 'pipeline-limit' && /Limite atteinte/.test(n.text));
  ok(x.code === 2 && lim?.limit === want && input && chef, `${label} → pause « ${want} » : log ${!!lim}, dashboard ${input}, chef ${!!chef}`, x.out.slice(-500));
  reset();
};
await limitCase('liste de tests trop longue (4 > 3)', ['Ajoute beaucoup de choses', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '4', ORCH_PIPE_ITEMS: '3' }, 'items');
await limitCase('4b : 3 essais sans passer', ['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_BAD: 'vert' }, 'green');
await limitCase('critère de 4a refusé 2 fois', ['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_BAD: 'rouge' }, 'criteria');
await limitCase('tours de revue épuisés', ['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_REVIEW: 'problemes', ORCH_PIPE_REVIEW_ROUNDS: '1' }, 'review');
await limitCase('durée maximale', ['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', ORCH_PIPE_RUN_MS: '1' }, 'duration');

// ---------------------------------------------------------------------------
section('7. Classification : nouvelle fonctionnalité → complet ; /léger → léger');
r = await go(['Ajoute une fonction de multiplication'], { FAKE_PIPE_ITEMS: '1' });
ok(r.code === 0 && r.evs.find(e => e.type === 'user_prompt')?.pipeline?.mode === 'complet', `sans --mode : ${r.evs.find(e => e.type === 'user_prompt')?.pipeline?.mode}`);
reset();
r = await go(['/léger ajoute une fonction double']);
ok(r.code === 0 && r.evs.find(e => e.type === 'user_prompt')?.pipeline?.mode === 'leger', '« /léger » force le mode léger');
reset();
r = await go(['x', '--mode', 'moyen']);
ok(r.code === 64, '--mode inconnu refusé (64)');

// ---------------------------------------------------------------------------
section('8. Décision Q10 (« A ») : item DÉJÀ COUVERT — accepté seulement s’il est déclaré, tests seuls, suite verte');
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_COVERED: '2' });
ok(r.code === 0 && seq(r.done) === 'comprendre,concevoir,liste-tests,rouge,vert,refactor:skipped,rouge,vert:skipped,refactor:skipped,revue,livrer', `item 2 couvert : sans 4b ni 4c (${seq(r.done)})`, r.out.slice(-600));
const cov = r.done.filter(d => d.pipeline.step === 'rouge')[1];
ok(cov?.covered === true && cov.test?.ok === true && cov.status === 'ok', '4a de l’item 2 : acceptée « déjà couvert », suite verte vérifiée par l’orchestrateur');
ok(r.done.filter(d => d.status === 'skipped' && d.pipeline.item === 2).every(d => /DEJA_COUVERT/.test(d.why)) && r.evs.some(e => e.subtype === 'pipeline_item_covered'), 'tracé : 4b/4c sautées avec le motif, événement pipeline_item_covered');
ok(fs.existsSync(path.join(P, 'test', 'pipe-2.test.mjs')) && !g('status', '--porcelain').stdout.trim() && E.parseItems(fs.readFileSync(path.join(P, '.orchestrateur', 'runs', r.run, 'tests.md'), 'utf8')).every(i => i.done), 'le test reste (documentation, commité) et l’item est coché');
const rv = fs.readFileSync(path.join(T, 'logs', 'runs', r.run, r.done.find(d => d.pipeline.step === 'revue').pipeline.key + '.jsonl'), 'utf8');
ok(/DÉJÀ COUVERTS/.test(rv) && /multiplier par 3/.test(rv), 'la Revue reçoit la liste des items déjà couverts, à juger');
ok(runState(r.run).coveredItems?.length === 1, 'run.json : coveredItems');
reset();
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_COVERED: '1', FAKE_PIPE_NOCLAIM: '1' });
const nc = r.done.filter(d => d.pipeline.step === 'rouge');
ok(r.code === 2 && nc.length === 2 && nc.every(d => d.status === 'refused' && /DEJA_COUVERT/.test(d.why)), 'test qui passe SANS déclaration : refusé (avec l’indication), puis pause — la règle stricte reste par défaut');
reset();
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_COVERED: '1', FAKE_PIPE_BAD: 'rouge' });
const bc = r.done.filter(d => d.pipeline.step === 'rouge');
ok(r.code === 2 && bc.every(d => d.status === 'refused' && /hors tests/.test(d.why)), 'DEJA_COUVERT déclaré mais du code modifié : refusé (seuls des tests peuvent changer)');
reset();

// ---------------------------------------------------------------------------
section('9. Durée ACTIVE : l’attente d’une réponse ne compte pas dans les 90 min');
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_BAD: 'vert' });
const pausedRun = r.run;
const f9 = path.join(T, 'logs', 'runs', pausedRun, 'run.json');
const s9 = JSON.parse(fs.readFileSync(f9, 'utf8'));
ok(r.code === 2 && Number(s9.activeMs) > 0 && Number(s9.activeMs) < 10 * 60_000, `pause : temps actif consigné (${Math.round(s9.activeMs / 1000)} s)`);
s9.createdAt = new Date(Date.now() - 3 * 3600_000).toISOString();   // pause de 3 h
fs.writeFileSync(f9, JSON.stringify(s9));
r = await go(['continuer']);
ok(r.code === 0 && r.run === pausedRun && !r.evs.some(e => e.subtype === 'pipeline_limit'), 'reprise après 3 h de pause : aucune limite de durée, exécution terminée');
reset();

// ---------------------------------------------------------------------------
section('10. « continuer » après une limite : UNE allocation de plus, tracée (sinon la reprise retombait aussitôt)');
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', ORCH_PIPE_ITEMS: '2', FAKE_PIPE_REVIEW: 'problemes:1' });
const run10 = r.run;
ok(r.code === 2 && r.evs.find(e => e.subtype === 'pipeline_limit')?.limit === 'items' && runState(run10).pausedLimit === 'items', 'revue → 3ᵉ item, au-delà de 2 : pause « items »');
r = await go(['continuer'], { FAKE_PIPE_ITEMS: '2', ORCH_PIPE_ITEMS: '2' });
const ext = r.evs.find(e => e.subtype === 'pipeline_limit_extended');
ok(r.code === 0 && r.run === run10 && ext?.limit === 'items' && ext.to === 4, `reprise : allocation accordée (« ${ext?.text} »), exécution terminée`, r.out.slice(-500));
ok(seq(r.done) === 'rouge,vert,refactor:skipped,revue,livrer' && runState(run10).budgets?.items === 4, `l’item de revue est traité, puis Revue et Livrer (${seq(r.done)})`);
reset();
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_REVIEW: 'problemes:2', ORCH_PIPE_REVIEW_ROUNDS: '1' });
const run10b = r.run;
ok(r.code === 2 && runState(run10b).pausedLimit === 'review', 'tours de revue épuisés : pause « review »');
// Pause écrite par un moteur antérieur à 0.50.0 : pas de pausedLimit dans l'état.
const f10 = path.join(T, 'logs', 'runs', run10b, 'run.json');
const s10 = JSON.parse(fs.readFileSync(f10, 'utf8')); delete s10.pausedLimit; fs.writeFileSync(f10, JSON.stringify(s10));
r = await go(['continuer'], { ORCH_PIPE_REVIEW_ROUNDS: '1' });
ok(r.code === 0 && r.run === run10b && r.evs.some(e => e.subtype === 'pipeline_limit_extended' && e.limit === 'review'), `reprise : un tour de revue de plus, puis livraison (${seq(r.done)})`, r.out.slice(-400));
reset();

// ---------------------------------------------------------------------------
section('11. Retour utilisateur : un constat de revue NON testable (doc, registre, CHANGELOG, version) va à Livrer, pas dans la boucle de tests');
ok(E.isDeliveryFix('docs/USER_REQUIREMENTS.md : la demande est absente du registre') && E.isDeliveryFix('CHANGELOG : décrire la fonction') && E.isDeliveryFix('version non incrémentée') && !E.isDeliveryFix('nommer le paramètre de double') && !E.isDeliveryFix('charCount(null) doit renvoyer 0'), 'tri : doc / registre / CHANGELOG / version d’un côté, comportements de l’autre');
// Le cas exact signalé : liste pleine (2/2), puis un constat de registre en revue.
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', ORCH_PIPE_ITEMS: '2', FAKE_PIPE_REVIEW: 'doc:1' });
ok(r.code === 0 && !r.evs.some(e => e.subtype === 'pipeline_limit') && !r.evs.some(e => e.subtype === 'pipeline_loop'), `liste pleine + constat de registre : AUCUNE pause, aucun tour de boucle (code ${r.code})`, r.out.slice(-400));
ok(seq(r.done).endsWith('rouge,vert,refactor:skipped,revue,livrer') && runState(r.run).itemsDone === 2, `la limite de tests n’est pas consommée (${seq(r.done)})`);
const dfx = r.evs.find(e => e.subtype === 'pipeline_delivery_fixes');
const livLog = fs.readFileSync(path.join(T, 'logs', 'runs', r.run, r.done.find(d => d.pipeline.step === 'livrer').pipeline.key + '.jsonl'), 'utf8');
ok(dfx && /USER_REQUIREMENTS/.test(livLog) && /D'OFFICE la ligne de la demande/.test(livLog), 'le constat est transmis à Livrer, qui ajoute d’office la ligne d’exigence');
reset();
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_REVIEW: 'hors:1' });
ok(r.code === 0 && !r.evs.some(e => e.subtype === 'pipeline_loop') && r.evs.some(e => e.subtype === 'pipeline_delivery_fixes'), 'revue au nouveau format (hors_tdd) : même traitement');
reset();
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_REVIEW: 'mixte:1' });
const tm = E.parseItems(fs.readFileSync(path.join(P, '.orchestrateur', 'runs', r.run, 'tests.md'), 'utf8'));
ok(r.code === 0 && tm.filter(i => /^\(revue\)/.test(i.text)).length === 1 && !tm.some(i => /CHANGELOG/.test(i.text)) && runState(r.run).deliveryFixes?.some(f => /CHANGELOG/.test(f)), 'revue mixte : le défaut de comportement devient un test, le constat CHANGELOG va à Livrer');
reset();
r = await go(['Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_REVIEW: 'doc:1' });
ok(r.code === 0 && seq(r.done) === 'rouge,vert,revue,livrer', `léger : pas de retour à « écrire le code » pour un constat de doc (${seq(r.done)})`);
reset();

// ---------------------------------------------------------------------------
section('12. Retour utilisateur : message de pause compréhensible, et chaque choix fait vraiment quelque chose');
r = await go(['Ajoute beaucoup de choses', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '4', ORCH_PIPE_ITEMS: '3' });
const res12 = r.evs.find(e => e.type === 'result')?.result || '';
const needs = (/^NEEDS_USER_INPUT:\s*(.*)$/m.exec(res12) || [])[1] || '';
ok(r.code === 2 && ["Ce qui s'est passé", 'Où en est le travail', '« **continuer** »', '« **simplifier** »', '« **changer le model** »', '« **abandonner** »', 'Je recommande'].every(s => res12.includes(s)), 'le message dit : ce qui s’est passé, où en est le travail, chaque choix et sa conséquence, une recommandation');
ok(/0 test\(s\) faits sur 4 prévus, 4 restant\(s\)/.test(res12), `avancement chiffré : « ${(/Où en est le travail\*\* : (.*)/.exec(res12) || [])[1]} »`);
ok(/continuer.*simplifier.*changer le model.*abandonner.*je recommande « (continuer|simplifier|changer le model|abandonner) »/.test(needs), `la question elle-même liste les réponses et la recommandation : « ${needs.slice(0, 160)} »`);
ok(!/\b4[abc]\b|@loop|--pipeline-resume|critère de sortie|\bitem/i.test(res12), 'aucun vocabulaire interne (4a/4b/4c, boucle, commande, critère, item)');
ok(/abandonner/.test(needs.slice(0, 160)) && /je recommande « [^»]+ »/.test(needs.slice(0, 160)), 'l’aperçu du dashboard (160 caractères) garde les réponses et la recommandation');
ok(r.notes.some(n => n.project === 'chef' && /Ce qui s'est passé/.test(n.text) && /Je recommande/.test(n.text)), 'le chef reçoit toute l’explication, pas seulement la question');
const run12 = r.run;
r = await go(['changer le model']);
ok(r.code === 2 && runState(run12).status === 'paused' && /page Models/.test(r.evs.find(e => e.type === 'result')?.result || '') && deriveState(logOf().map(e => JSON.stringify(e))).state === 'input', '« changer le model » : dit quelle case changer, et reste en attente de « continuer »');
r = await go(['abandonner']);
const res12b = r.evs.find(e => e.type === 'result')?.result || '';
ok(r.code === 0 && runState(run12).status === 'abandoned' && /Rien n’est livré/.test(res12b) && deriveState(logOf().map(e => JSON.stringify(e))).state !== 'input', '« abandonner » : exécution close, rien de livré, plus de question en attente', `code ${r.code} statut ${runState(run12).status} état ${deriveState(logOf().map(e => JSON.stringify(e))).state} — ${res12b.slice(0, 200)} ${r.out.slice(-300)}`);
reset();
r = await go(['Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_BAD: 'vert' });
r = await go(['simplifier']);
const res12c = r.evs.find(e => e.type === 'result')?.result || '';
ok(r.code === 0 && /demande plus petite/.test(res12c) && /src\/pipe-1\.mjs|test\/pipe-1\.test\.mjs/.test(res12c), '« simplifier » : clos, et liste les modifications restées dans le projet');
reset();
r = await go(['Ajoute beaucoup de choses', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '4', ORCH_PIPE_ITEMS: '3' });
ok(r.code === 2 && /la liste prévoit 4 tests, plus que le maximum de 3/.test(r.evs.find(e => e.type === 'result')?.result || ''), 'liste trop longue d’emblée : le message le dit tel quel (pas « 0 faits »)');
r = await go(['continuer'], { FAKE_PIPE_ITEMS: '4', ORCH_PIPE_ITEMS: '3' });
ok(r.code === 0 && r.done.filter(d => d.pipeline.step === 'rouge').length === 4, `« continuer » accepte toute la liste : 4 tests faits, puis livraison (code ${r.code})`, r.out.slice(-300));
reset();

srv.close();
fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
