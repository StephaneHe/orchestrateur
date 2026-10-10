#!/usr/bin/env node
// ============================================================================
// scripts/_test_no_lexical_routing.mjs — no routing or classification by
// keywords anywhere in the orchestrator (0.66.0)
// ============================================================================
//
// User request (2026-10-10), verbatim: « Je pense a quelque chose : a chaque
// fois que j'ai un retours sur un routage qui n'est pas passe, tu me dis que
// certains mots vont etre associes a des routage. Si c'est bien le cas, je veux
// que tu defasses ca completement. Ce n'est pas une recherche de mot qui pourra
// faire un routage efficace, c'est une recherche de sens que seul un modele
// peut faire. »
//
// Protected:
//   - no keyword table, regex or lexical heuristic decides a pipeline, a mode,
//     the nature of a dev request, a step variant, a gap or a terminal line;
//   - explicit choices typed by the user (/dev, /complet, /discussion…) and
//     flags stay: they are choices, not a search for words;
//   - classifier model unavailable, slot empty or invalid answer: a PAUSE with
//     a question, the request kept — never a classification by rules;
//   - the model decides the nature of a dev request, the variant of a media
//     step, and proposes gaps.
//
// Real dispatch.mjs, real engine, fake claude, throwaway root (never 7777).
//
//   node scripts/_test_no_lexical_routing.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as OBS from './pipeline-observe.mjs';
import * as CLS from './pipeline-classify.mjs';
import * as ENG from './pipeline-engine.mjs';
import { CATALOG_PIPELINES, catalogSteps } from './pipeline-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Aucune table de mots-clés de routage dans les modules concernés');
const MODULES = ['scripts/pipeline-observe.mjs', 'scripts/pipeline-classify.mjs', 'scripts/pipeline-engine.mjs', 'scripts/pipeline-catalog.mjs',
  'scripts/pipeline-catalog-media.mjs', 'scripts/terminal-route.mjs', 'scripts/routage-pending.mjs', 'scripts/dispatch.mjs', 'scripts/model-routing.mjs', 'server.js',
  'src/interrupt_policy.mjs', 'src/message_router.mjs'];
// Names of the keyword machinery removed in 0.66.0 — none may come back.
const FORBIDDEN = [/\bRULES\s*=\s*\{/, /\bQUESTION_START\b/, /\bACTION_REQUEST\b/, /\bMEDIA_VERB\b/, /\b(HEAVY|LIGHT)\s*=\s*\//, /\bdevKind\b/, /\bisDeliveryFix\b/,
  /\bclassifierExtras\b/, /\bSTOP_WORDS\b/, /\bdetectStopWord\b/, /\bdetectGap\b/, /\bsignificantWords\b/, /règles-v1/, /classify as classifyRules/, /extraRules/];
for (const m of MODULES) {
  const src = fs.readFileSync(path.join(ROOT, m), 'utf8');
  const hits = FORBIDDEN.filter(re => re.test(src)).map(String);
  ok(!hits.length, `${m} : aucune mécanique de mots-clés`, hits.join(', '));
}
ok(!('classify' in OBS) && !('detectGap' in OBS) && typeof OBS.explicitChoice === 'function', 'pipeline-observe n’exporte plus de classifieur, seulement le choix explicite');
ok(!('devKind' in ENG) && !('isDeliveryFix' in ENG), 'le moteur ne devine ni la nature d’une demande ni le tri d’un constat de revue');
const variantRegexes = [];
for (const p of CATALOG_PIPELINES) for (const s of catalogSteps(p)) for (const [id, v] of Object.entries(s.variants || {})) if (v instanceof RegExp) variantRegexes.push(`${p}.${s.id}.${id}`);
ok(!variantRegexes.length, 'variantes d’étape : des descriptions pour le model, plus aucune regex', variantRegexes.join(', '));
const REAL = ['corrige la typo dans le README', 'le serveur est en panne, plus rien ne répond', 'transcris l’enregistrement de la réunion', 'mets à jour les dépendances npm', 'pourquoi le serveur est lent ?'];
ok(REAL.every(text => OBS.explicitChoice({ text }).pipeline === null), 'des demandes réelles ne sont rattachées à aucun pipeline par l’orchestrateur lui-même (à classer par le model)');
ok(OBS.explicitChoice({ text: '/dev /léger corrige x' }).pipeline === 'dev' && OBS.explicitChoice({ text: '/discussion x' }).pipeline === 'discussion', 'les préfixes explicites restent (choix de l’utilisateur)');

// ---------------------------------------------------------------------------
section('2. Model indisponible, case vide, réponse invalide : échec explicite, jamais de repli');
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nolex-u-'));
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {} }));
  let calls = 0;
  let r = await CLS.classifyEntry({ root: T, logsDir: T, text: 'ajoute un bouton export', oneShot: async () => { calls++; return { ok: true, text: '{}' }; } });
  ok(r.failed === true && !r.pipeline && calls === 0, `case vide : échec, aucun pipeline, aucun appel (${r.why})`);
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } } }));
  r = await CLS.classifyEntry({ root: T, logsDir: T, text: 'ajoute un bouton export', oneShot: async () => ({ ok: false, why: 'model indisponible' }) });
  ok(r.failed === true && !r.pipeline && /model indisponible/.test(r.why), 'model indisponible : échec, aucun pipeline');
  r = await CLS.classifyEntry({ root: T, logsDir: T, text: 'ajoute un bouton export', oneShot: async () => ({ ok: true, text: 'je pense que c’est du dev' }) });
  ok(r.failed === true && !r.pipeline, 'réponse invalide (deux fois) : échec, aucun pipeline');
  const c = await CLS.chooseOption({ root: T, logsDir: T, question: 'q', request: 'x', options: [{ id: 'a', what: 'A' }, { id: 'b', what: 'B' }], oneShot: async () => ({ ok: true, text: '{"choix":"z"}' }) });
  ok(!c.ok, 'choix d’une variante hors liste : refusé, jamais de « premier par défaut »');
}

// ---------------------------------------------------------------------------
// Throwaway root, a project in service
// ---------------------------------------------------------------------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nolex-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
const slots = ['comprendre', 'concevoir', 'liste-tests', 'rouge', 'vert', 'refactor', 'revue', 'livrer'].map(s => `dev.${s}`).concat(['discussion.comprendre', 'discussion.rechercher', 'discussion.repondre']);
const routing = (withClassifier) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { ...Object.fromEntries(slots.map(s => [s, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])), ...(withClassifier ? { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } } : {}) },
  history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev', 'images'] },
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
  ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL',
  'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CHOICE', 'FAKE_PIPE_ITEMS', 'FAKE_PIPE_REVIEW']) delete baseEnv[k];
const dispatch = (args, env = {}) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }; };
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const runsCount = () => { try { return fs.readdirSync(path.join(T, 'logs', 'runs')).length; } catch { return 0; } };
const pendingFile = path.join(T, 'logs', 'P.a-classer.json');
const pending = () => { try { return JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { return []; } };
const go = (args, env) => { const n0 = logOf().length, k0 = runsCount(); const r = dispatch(args, env); const evs = logOf().slice(n0); return { ...r, evs, newRuns: runsCount() - k0, result: evs.filter(e => e.type === 'result').pop()?.result || '' }; };

// ---------------------------------------------------------------------------
section('3. Classement impossible : pause avec question, demande gardée, jamais de règles');
routing(false);
let r = go(['Ajoute une fonction double']);
ok(r.code === 2 && r.newRuns === 0 && /NEEDS_USER_INPUT:.*« continuer ».*« abandonner »/.test(r.result) && /routage\.classifier/.test(r.result), `case vide : pause (code ${r.code}), aucune exécution lancée, question posée`, r.out.slice(-600));
ok(pending().length === 1 && pending()[0].prompt === 'Ajoute une fonction double', 'la demande est gardée (aucune perte de message)');
ok(!/règles/.test(r.result) || /jamais par mots-clés/.test(r.result), 'le message dit que le classement se fait par le sens, jamais par mots-clés');
routing(true);
r = go(['continuer']);
ok(r.code === 0 && r.newRuns === 1 && r.evs.some(e => e.type === 'user_prompt' && e.pipeline?.pipeline === 'dev') && !pending().length, `« continuer » (case affectée entre-temps) : la demande gardée est classée par le model et lancée (code ${r.code})`, r.out.slice(-600));
reset();
routing(false);
go(['Ajoute une fonction triple']);
r = go(['/discussion']);
ok(r.code === 0 && r.evs.some(e => e.type === 'user_prompt' && e.pipeline?.pipeline === 'discussion') && !pending().length, '« /discussion » : le choix explicite s’applique à la demande gardée');
go(['Ajoute une fonction quadruple']);
r = go(['abandonner']);
ok(r.code === 0 && r.newRuns === 0 && !pending().length && /abandonnée/.test(r.result), '« abandonner » : la demande gardée est oubliée, rien lancé');
reset();

// ---------------------------------------------------------------------------
section('4. Le model décide la nature d’une demande de dev, propose les lacunes');
routing(true);
r = go(['Renomme la fonction id', '--mode', 'leger'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'dev', mode: 'leger', nature: 'mecanique', raison: 'renommage' }) });
const up = r.evs.find(e => e.type === 'user_prompt' && e.pipeline);
ok(r.code === 0 && up?.pipeline?.kind === 'mecanique' && !up.pipeline.steps.some(s => s.id === 'rouge'), `nature « mécanique » donnée par le model : pas de test rouge (${up?.pipeline?.steps.map(s => s.id).join(',')})`, r.out.slice(-500));
reset();
r = go(['Ajoute une fonction double', '--mode', 'leger'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'dev', mode: 'leger', nature: 'bugfix', raison: 'un défaut' }) });
const up2 = r.evs.find(e => e.type === 'user_prompt' && e.pipeline);
ok(up2?.pipeline?.kind === 'bugfix', 'nature « bugfix » donnée par le model, même si les mots disent « ajoute »');
reset();
r = go(['planifie mes vacances en Italie'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'leger', raison: 'voyage', lacune: 'créer un pipeline Voyages' }) });
const obs = fs.readFileSync(path.join(T, 'logs', 'pipeline-observe.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
ok(obs.some(o => o.entry === 'signalement' && o.gap?.proposal?.text === 'créer un pipeline Voyages' && !o.gap.proposal.keywords), 'lacune proposée par le model (sa proposition, sans mots-clés)');
reset();

// ---------------------------------------------------------------------------
section('5. Variante d’une étape média : choisie par le model ; échec → pause, jamais de repli');
routing(false);
r = go(['génère une icône pour l’application', '--pipeline', 'images', '--test', 'variante']);
const runId = r.evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
const st5 = runId ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', runId, 'run.json'), 'utf8')) : {};
ok(r.code === 2 && st5.pausedLimit === 'classifier' && !st5.steps?.length && /variante/.test(r.result) && /NEEDS_USER_INPUT:/.test(r.result), `case vide : pause « classifier » avant toute étape (code ${r.code})`, r.out.slice(-600));
routing(true);
r = go(['continuer'], { FAKE_CLAUDE_CHOICE: 'retouche' });
const prod = r.evs.find(e => e.subtype === 'pipeline_step_start' && e.pipeline?.step === 'produire');
ok(prod?.pipeline?.slot === 'images.produire.retouche', `« continuer » : variante choisie par le model (${prod?.pipeline?.slot})`, r.out.slice(-600));
reset();

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
