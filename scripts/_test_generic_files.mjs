#!/usr/bin/env node
// ============================================================================
// scripts/_test_generic_files.mjs — the « Fichiers » generic pipeline
// (pipelines phase 1, docs/PIPELINES-SYNTHESE.md §3.3, decision 4)
// ============================================================================
//
// User decision 4 (2026-10-20, « tout comme recommandé »): « Fichiers :
// télécharger, copier, ranger, comparer ». Real cases (anonymised in
// tests/pipeline-corpus/): a reel to download went to Données (7 model calls),
// « récupère la vidéo X et mets-la avec les autres » to Vidéo, a comparison of
// two folders to Discussion.
//
// Protected (files-check.mjs, real dispatch.mjs and engine, fake claude):
//   - the plan: closed list, destinations and deletions inside the project, a
//     source outside it only when the user wrote its path, never an overwrite,
//     a deletion always with its reason, at most 50 operations;
//   - the model only downloads; copy / move / rename / delete / compare are
//     done by the CODE; a deletion keeps a copy in the run's trash;
//   - a file in doubt pauses the run BEFORE anything is deleted; « garder les
//     doutes » keeps it, « tout supprimer » deletes it too;
//   - every effect re-read on the disk (verification.md = the result);
//   - the delivery commits the text files the plan touched, never a binary;
//   - a download that touches another file is refused.
//
//   node scripts/_test_generic_files.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import * as F from './files-check.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-genfiles-'));
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
const put = (abs, s) => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, s); };

section('1. Le plan (files-check.mjs) : liste fermée, vérifiée avant toute exécution');
{
  const C = path.join(T, 'unit');
  put(path.join(C, 'a.txt'), 'a'); put(path.join(C, 'b', 'c.md'), 'c');
  const OUT = path.join(T, 'ailleurs', 'x.txt'); put(OUT, 'x');
  const plan = (operations, doutes, demande = '') => F.checkFilesPlan(C, { operations, ...(doutes ? { doutes } : {}) }, { demande });
  ok(plan([{ op: 'copier', source: 'a.txt', destination: 'copie/a.txt' }]).ok, 'copier dans le projet : accepté');
  ok(!plan([{ op: 'copier', source: 'a.txt', destination: '../hors.txt' }]).ok, 'destination hors du projet : refusée');
  ok(!plan([{ op: 'copier', source: 'a.txt', destination: 'b/c.md' }]).ok, 'destination existante : refusée (jamais écrasée)');
  ok(!plan([{ op: 'copier', source: OUT, destination: 'x.txt' }]).ok, 'source hors du projet non citée : refusée');
  ok(plan([{ op: 'copier', source: OUT, destination: 'x.txt' }], null, `copie ${OUT} dans le projet`).ok, 'source hors du projet citée par l’utilisateur : acceptée');
  ok(!plan([{ op: 'deplacer', source: OUT, destination: 'x.txt' }], null, `déplace ${OUT}`).ok, 'déplacer depuis hors du projet : refusé (copier seulement)');
  ok(!plan([{ op: 'supprimer', source: 'a.txt' }]).ok, 'supprimer sans raison : refusé');
  ok(!plan([{ op: 'supprimer', source: 'b', raison: 'ménage' }]).ok, 'supprimer un dossier : refusé');
  ok(!plan([{ op: 'renommer', source: 'a.txt', destination: 'b/a.txt' }]).ok, 'renommer vers un autre dossier : refusé (c’est « deplacer »)');
  ok(!plan([{ op: 'acquerir', url: 'ftp://x', destination: 'v.mp4' }]).ok, 'acquérir sans URL http(s) : refusé');
  ok(!plan([{ op: 'executer', source: 'a.txt' }]).ok, 'opération hors liste : refusée');
  ok(!plan([{ op: 'copier', source: 'a.txt', destination: '.git/hooks/x' }]).ok, 'écrire dans .git : refusé');
  ok(!plan(Array.from({ length: 51 }, (_, i) => ({ op: 'acquerir', url: `https://e.org/${i}`, destination: `v${i}.mp4` }))).ok, '51 opérations : refusé (découper)');
  ok(!plan([{ op: 'supprimer', source: 'a.txt', raison: 'r' }], [{ chemin: 'a.txt', question: 'sûr ?' }]).ok, 'un fichier à la fois sûr et en doute : refusé');
  // compareTrees
  const A = path.join(T, 'cmpA'), B = path.join(T, 'cmpB');
  put(path.join(A, 's1', 'e1.mkv'), 'one'); put(path.join(A, 's1', 'e2.mkv'), 'two'); put(path.join(A, 'only-a.srt'), 'a');
  put(path.join(B, 's1', 'e1.mkv'), 'one'); put(path.join(B, 's1', 'e2.mkv'), 'TWO'); put(path.join(B, 'only-b.nfo'), 'b');
  const c = F.compareTrees(A, B);
  ok(c.onlyA.join() === 'only-a.srt' && c.onlyB.join() === 'only-b.nfo' && c.different.map(d => d.path).join() === 's1/e2.mkv' && c.same === 1, 'comparaison : seulement A, seulement B, différents (contenu), identiques', c);
  ok(F.isBinaryFile(path.join(A, 's1', 'e1.mkv')) && !F.isBinaryFile(path.join(C, 'a.txt')), 'binaires reconnus (extension média ou octet nul)');
}

// ---------------------------------------------------------------------------
// End to end: real dispatch.mjs, real engine, fake claude
// ---------------------------------------------------------------------------
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'chef'));
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const P = path.join(T, 'P');
function repo() {
  fs.rmSync(P, { recursive: true, force: true });
  const w = (rel, s) => put(path.join(P, rel), s);
  w('package.json', JSON.stringify({ name: 'P', version: '1.0.0', type: 'module' }, null, 2) + '\n');
  w('.gitignore', '*.mp4\n');
  w('test/base.test.mjs', "import { test } from 'node:test';\ntest('base', () => {});\n");
  w('.orchestrateur/pipeline.json', JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'] }));
  w('notes/index.md', '# Index\n');
  w('brouillons/v1.md', 'brouillon 1\n');
  w('brouillons/v2.md', 'brouillon 2\n');
  w('videos/ancienne.mp4', MP4);
  g(P, 'init', '-q'); g(P, 'add', '-A'); g(P, 'commit', '-q', '-m', 'init');
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['P'], pipelines: E.ENGINE_PIPELINES, tuning: { generic: true } },
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'fichiers.inventorier': { provider: 'anthropic', model: 'claude-sonnet-5-5' }, 'fichiers.acquerir': { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', ORCH_FFPROBE: 'none',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200',
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'fichiers', mode: 'complet', raison: 'des fichiers' }) };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME',
  'FAKE_PIPE_JSON', 'FAKE_PIPE_BAD', 'FAKE_PIPE_NOTHING', 'FAKE_CLAUDE_CHOICE', 'FAKE_CLAUDE_DUMP_PROMPT', 'ORCH_REQUEST_ID']) delete baseEnv[k];
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
function play(args, env = {}) {
  const n0 = logOf().length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline?.run)?.pipeline.run;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, run, st: run ? runState(run) : null, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const has = (rel) => fs.existsSync(path.join(P, rel));

section('2. Télécharger un reel : le model télécharge, le code vérifie, rien n’est commité (binaire)');
repo();
let x = play(['Télécharge le reel https://www.example.org/reels/AbC123/ et donne son chemin local.', '--test', 'reel'], {
  FAKE_PIPE_JSON: JSON.stringify({ inventorier: { operations: [{ op: 'acquerir', url: 'https://www.example.org/reels/AbC123/', destination: 'videos/reel-AbC123.mp4' }] }, acquerir: { writes: { 'videos/reel-AbC123.mp4': '@mp4' } } }) });
ok(x.code === 0 && x.st?.status === 'done' && x.st.pipeline === 'fichiers', `exécution « fichiers » terminée (code ${x.code})`, x.out.slice(-1500));
ok(has('videos/reel-AbC123.mp4') && /✓ acquerir https:\/\/www\.example\.org\/reels\/AbC123\/ → `videos\/reel-AbC123\.mp4`.*vidéo valide/.test(x.result), 'résultat : le fichier, sa taille, « vidéo valide » — relus par le code', x.result.slice(0, 900));
ok(x.st.steps.filter(s => s.model).map(s => s.id).join() === 'inventorier,acquerir', `deux tours de model seulement (inventorier, acquérir) : ${x.st.steps.filter(s => s.model).map(s => s.id).join(', ')}`);
ok(x.st.steps.filter(s => s.source === 'code').map(s => s.id).join() === 'executer,verifier,livrer', 'exécuter, vérifier, livrer : par le programme');
ok(g(P, 'log', '-1', '--format=%s').stdout.trim() === 'init', 'binaire jamais commité : aucun commit');

section('3. Une acquisition qui touche un autre fichier est refusée');
repo();
x = play(['Télécharge https://www.example.org/v.mp4 dans videos/v.mp4.', '--test', 'acquisition débordante'], {
  FAKE_PIPE_JSON: JSON.stringify({ inventorier: { operations: [{ op: 'acquerir', url: 'https://www.example.org/v.mp4', destination: 'videos/v.mp4' }] }, acquerir: { writes: { 'videos/v.mp4': '@mp4', 'notes/index.md': '# modifié en douce\n' } } }) });
ok(x.st?.status === 'paused' && x.st.steps.some(s => s.id === 'acquerir' && s.status === 'refused' && /seuls les fichiers prévus/.test(s.why)), 'refusée : « seuls les fichiers prévus peuvent changer »', x.st?.steps?.map(s => `${s.id}:${s.status}:${s.why || ''}`).join(' | '));
ok(fs.readFileSync(path.join(P, 'notes/index.md'), 'utf8') === '# Index\n', 'le fichier touché en douce est remis');

section('4. Copier, renommer, supprimer avec un doute : pause AVANT toute suppression');
repo();
const plan4 = { operations: [
  { op: 'copier', source: 'notes/index.md', destination: 'archives/index-2026.md' },
  { op: 'renommer', source: 'videos/ancienne.mp4', destination: 'videos/2026-10-01-seance.mp4' },
  { op: 'supprimer', source: 'brouillons/v1.md', raison: 'brouillon remplacé' },
], doutes: [{ chemin: 'brouillons/v2.md', question: 'Le brouillon v2 est-il la version envoyée ?' }] };
x = play(['Range : copie l’index dans archives, renomme la vidéo avec sa date, supprime les brouillons.', '--test', 'doutes'], { FAKE_PIPE_JSON: JSON.stringify({ inventorier: plan4 }) });
ok(x.st?.status === 'paused' && x.st.pausedLimit === 'doutes' && /v2\.md/.test(x.result), 'pause « doutes » : la question est posée', x.result.slice(0, 600));
ok(has('brouillons/v1.md') && has('brouillons/v2.md') && !has('archives/index-2026.md'), 'rien n’est fait avant la réponse');
const run4 = x.run;
x = play(['garder les doutes', '--pipeline-resume', run4, '--test', 'garder']);
ok(x.st?.status === 'done', `reprise : exécution terminée (${x.st?.status})`, x.out.slice(-1200));
ok(has('archives/index-2026.md') && has('videos/2026-10-01-seance.mp4') && !has('videos/ancienne.mp4') && !has('brouillons/v1.md') && has('brouillons/v2.md'), 'copié, renommé, supprimé ; le fichier en doute est gardé');
ok(fs.existsSync(path.join(T, 'logs', 'runs', run4, 'corbeille', 'brouillons', 'v1.md')), 'le fichier supprimé a sa copie dans la corbeille de l’exécution');
const last = g(P, 'show', '--name-status', '--format=%s', 'HEAD').stdout;
ok(/archives\/index-2026\.md/.test(last) && /brouillons\/v1\.md/.test(last) && !/\.mp4/.test(last), 'un commit des seuls fichiers texte du plan, jamais la vidéo', last);
ok(/Gardés \(en doute/.test(x.result) && /v2\.md/.test(x.result), 'le résultat dit ce qui a été gardé');

section('5. « tout supprimer » supprime aussi le fichier en doute');
repo();
x = play(['Supprime les brouillons.', '--test', 'tout supprimer'], { FAKE_PIPE_JSON: JSON.stringify({ inventorier: { operations: [{ op: 'supprimer', source: 'brouillons/v1.md', raison: 'brouillon' }], doutes: [{ chemin: 'brouillons/v2.md', question: 'Supprimer aussi v2 ?' }] } }) });
x = play(['tout supprimer', '--test', 'tout supprimer']);
ok(x.st?.status === 'done' && !has('brouillons/v1.md') && !has('brouillons/v2.md'), '« tout supprimer » : les deux supprimés (copie gardée)', x.out.slice(-800));

section('6. Comparer deux dossiers hors du projet, cités par l’utilisateur : rien n’est modifié');
repo();
const A = path.join(T, 'series', 'Atelier'), B = path.join(T, 'series', 'Atelier S01');
put(path.join(A, 'e01.mkv'), 'un'); put(path.join(A, 'e02.mkv'), 'deux'); put(path.join(B, 'e01.mkv'), 'un'); put(path.join(B, 'e03.mkv'), 'trois');
x = play([`Compare en lecture seule le contenu des dossiers « ${A} » et « ${B} ».`, '--test', 'comparaison'], { FAKE_PIPE_JSON: JSON.stringify({ inventorier: { operations: [{ op: 'comparer', a: A, b: B }] } }) });
ok(x.st?.status === 'done' && /seulement dans A[^|]*\| 1 \|/.test(x.result) && /`e02\.mkv`/.test(x.result) && /`e03\.mkv`/.test(x.result) && /identiques \| 1 \|/.test(x.result), 'tableau de comparaison écrit par le code', x.result.slice(0, 900));
ok(g(P, 'status', '--porcelain').stdout.trim() === '' && g(P, 'log', '-1', '--format=%s').stdout.trim() === 'init', 'projet inchangé, aucun commit');
const notCited = F.checkFilesPlan(P, { operations: [{ op: 'comparer', a: A, b: B }] }, { demande: 'compare les deux dossiers de séries' });
ok(!notCited.ok && /non citée/.test(notCited.why), 'sans les chemins écrits dans la demande : refusé (jamais lu hors du projet)');

section('7. Plan');
ok(E.planSteps('fichiers').map(s => s.id).join() === 'inventorier,acquerir,executer,verifier,livrer', 'Inventorier → Acquérir → Exécuter → Vérifier → Livrer');

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
