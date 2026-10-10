#!/usr/bin/env node
// ============================================================================
// scripts/_test_pipeline_media.mjs — pipelines phase 6, lot C (0.55.0):
// Images, Vidéo, Audio — produced files checked by code
// ============================================================================
//
// User request (2026-10-09): "… puis Images/Vidéo/Audio. Chacun a ses
// critères de sortie vérifiés par le code et ses tests." Real dispatch.mjs and
// engine, claude double writing real small media files, throw-away root.
// ffprobe is forced off (ORCH_FFPROBE=none) for determinism, except in the
// section that uses it when it is installed.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import * as M from './media-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 700)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-media-'));
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'chef'));

// ---------------------------------------------------------------------------
section('1. Contrôle des fichiers : signature, dimensions, emplacement, taux d’erreur');
const D = path.join(T, 'brique');
fs.mkdirSync(D);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(D, 'a.png'), PNG);
fs.writeFileSync(path.join(D, 'faux.png'), 'pas une image');
let m = M.checkMediaFiles(['a.png'], { kind: 'image', roots: [D] });
ok(m.ok && m.files[0].format === 'png' && m.files[0].size.w === 1, 'PNG réel : accepté, dimensions lues');
ok(!M.checkMediaFiles(['absent.png'], { kind: 'image', roots: [D] }).ok, 'fichier annoncé mais absent : refusé');
ok(!M.checkMediaFiles(['faux.png'], { kind: 'image', roots: [D] }).ok, 'extension .png sans signature d’image : refusé');
ok(/hors du projet/.test(M.checkMediaFiles([path.join(os.tmpdir(), 'ailleurs.png')], { kind: 'image', roots: [D] }).why || ''), 'fichier hors du projet : refusé');
ok(JSON.stringify(M.listedFiles('## Fichiers\n- `media/a.png`\n## Notes\n`autre.png`')) === '["media/a.png"]', 'fichiers lus dans la section « ## Fichiers »');
ok(Math.abs(M.wordErrorRate('le chat dort sur le tapis', 'le chat dort sur un tapis') - 1 / 6) < 1e-9, 'taux d’erreur de mots (WER)');
ok(E.localToolFor({ 'images.produire.retouche': { provider: 'local', model: 'imagemagick' } }, ['images.produire.retouche', 'images.produire']) === 'imagemagick'
  && E.localToolFor({ 'images.produire': { provider: 'anthropic', model: 'claude-opus-5-5' } }, ['images.produire']) === null, 'outil local affecté à une case : repéré (un model passe avant)');

// ---------------------------------------------------------------------------
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
function repo(extra = {}) {
  const dir = path.join(T, 'P');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  fs.mkdirSync(path.join(dir, '.orchestrateur'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', ...extra.cfg }));
  for (const [f, s] of Object.entries(extra.files || {})) fs.writeFileSync(path.join(dir, f), s);
  g(dir, 'init', '-q'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: path.join(T, 'P') }] }));
const routing = (extra = {}) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, history: [],
  enforcement: { projects: ['P'], pipelines: E.ENGINE_PIPELINES },
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'images.verifier': { provider: 'anthropic', model: 'claude-opus-5-5' }, 'images.produire.ocr': { provider: 'anthropic', model: 'claude-sonnet-5-5' }, ...extra } }));
routing();
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', ORCH_FFPROBE: 'none',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME']) delete baseEnv[k];
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
function play(pipeline, request, { env = {}, repoOpts = {} } = {}) {
  const dir = repo(repoOpts);
  const n0 = logOf().length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', request, '--pipeline', pipeline, '--test', `média ${pipeline}`], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
  const st = run ? JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8')) : null;
  return { code: r.status, out: `${r.stdout}${r.stderr}`, evs, st, dir, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const ids = (st) => st.steps.map(s => `${s.id}:${s.status}`).join(' ');

// ---------------------------------------------------------------------------
section('2. Images : cadrer → produire (fichier vérifié) → vérifier visuellement → livrer');
const dump = path.join(T, 'prompts.ndjson');
let x = play('images', 'génère une icône pour l’application', { env: { FAKE_CLAUDE_DUMP_PROMPT: dump, FAKE_CLAUDE_CHOICE: 'generation' } });
ok(x.code === 0 && ids(x.st) === 'cadrer:ok produire:ok verifier:ok livrer:ok', `${ids(x.st || { steps: [] })}`, x.out.slice(-800));
ok(x.st.steps.find(s => s.id === 'produire')?.slot === 'images.produire.generation', 'variante « génération » choisie par le model de classement, d’après le sens de la demande (sa case en tête)');
ok(x.st.steps.find(s => s.id === 'verifier')?.served === 'claude-opus-5-5', 'vérification visuelle sur le model de sa case');
const vp = fs.readFileSync(dump, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(p => /PIPELINE_STEP=verifier/.test(p.prompt));
ok(/media\/produire\.png/.test(vp?.prompt || '') && /outil Read/.test(vp.prompt), 'la vérification reçoit la liste des fichiers produits, à ouvrir avec Read');
ok(/media\/produire\.png/.test(x.result) && g(x.dir, 'log', '-1', '--format=%s').stdout.trim() !== 'init', 'résultat : fichiers produits listés ; livrés en un commit');
x = play('images', 'extrais le texte de cette capture d’écran', { env: { FAKE_CLAUDE_CHOICE: 'ocr' } });
ok(x.code === 0 && x.st.steps.find(s => s.id === 'produire')?.slot === 'images.produire.ocr' && x.st.steps.find(s => s.id === 'produire')?.served === 'claude-sonnet-5-5', 'OCR : variante « ocr » (sa case), un fichier TEXTE attendu', ids(x.st || { steps: [] }));
x = play('images', 'génère une icône', { env: { FAKE_PIPE_BAD: 'produire:1', FAKE_CLAUDE_CHOICE: 'generation' } });
const pr = x.st.steps.filter(s => s.id === 'produire');
ok(pr[0]?.status === 'refused' && /annoncé mais absent/.test(pr[0].why) && pr[1]?.status === 'ok', 'fichier annoncé mais jamais écrit : refusé, refait');
x = play('images', 'génère une icône', { env: { FAKE_CLAUDE_CHOICE: 'generation', FAKE_PIPE_JSON: JSON.stringify({ verifier: { verdict: 'problemes', items: ['image floue'] } }) } });
ok(x.code === 2 && x.evs.some(e => e.subtype === 'pipeline_loop') && x.st.steps.filter(s => s.id === 'produire').length === 3 && x.st.status === 'paused', 'défaut visuel → retour à « produire », borné (2 tours), puis pause expliquée');
routing({ 'images.produire': { provider: 'local', model: 'imagemagick' } });
fs.rmSync(dump, { force: true });
x = play('images', 'redimensionne le logo en 64 px', { env: { FAKE_CLAUDE_DUMP_PROMPT: dump, FAKE_CLAUDE_CHOICE: 'retouche' } });
const pp = fs.readFileSync(dump, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(p => /PIPELINE_STEP=produire/.test(p.prompt));
ok(/OUTIL_LOCAL=imagemagick/.test(pp?.prompt || '') && x.st.steps.find(s => s.id === 'produire')?.slot === 'images.produire.retouche', 'case affectée à un OUTIL LOCAL : annoncé à l’étape (retouche → imagemagick)');
routing();

// ---------------------------------------------------------------------------
section('3. Vidéo : acquérir → analyser (texte) → monter (vidéo) → vérifier → livrer');
x = play('video', 'ajoute des sous-titres à la vidéo de la séance', { env: { FAKE_CLAUDE_CHOICE: 'transcription,sous-titres' } });
ok(x.code === 0 && ids(x.st) === 'acquerir:ok analyser:ok monter:ok verifier:ok livrer:ok', ids(x.st || { steps: [] }), x.out.slice(-800));
ok(x.st.steps.find(s => s.id === 'monter')?.slot === 'video.monter.sous-titres' && x.st.steps.find(s => s.id === 'analyser')?.slot === 'video.analyser.transcription', 'variantes : transcription puis incrustation des sous-titres');
x = play('video', 'fais le résumé de cette vidéo', { env: { FAKE_PIPE_NOTHING: 'monter', FAKE_CLAUDE_CHOICE: 'resume,decoupe' } });
ok(x.code === 0 && x.st.steps.find(s => s.id === 'monter')?.status === 'ok' && x.st.steps.find(s => s.id === 'analyser')?.slot === 'video.analyser.resume', 'analyse seule : « AUCUN_MONTAGE » accepté, variante « résumé »');

// ---------------------------------------------------------------------------
section('4. Audio : transcription mesurée contre une référence ; synthèse vocale');
const REF = 'bonjour à tous nous allons parler du budget de la semaine prochaine';
x = play('audio', 'transcris la réunion', { repoOpts: { cfg: { werReference: 'ref.txt' }, files: { 'ref.txt': REF } }, env: { FAKE_PIPE_TRANSCRIPT: REF, FAKE_CLAUDE_CHOICE: 'source,stt' } });
ok(x.code === 0 && ids(x.st) === 'acquerir:ok traiter:ok verifier:ok livrer:ok' && x.st.steps.find(s => s.id === 'traiter')?.slot === 'audio.traiter.stt', `transcription fidèle : acceptée (${ids(x.st || { steps: [] })})`, x.out.slice(-600));
x = play('audio', 'transcris la réunion', { repoOpts: { cfg: { werReference: 'ref.txt' }, files: { 'ref.txt': REF } }, env: { FAKE_PIPE_TRANSCRIPT: 'rien à voir avec la réunion ici', FAKE_CLAUDE_CHOICE: 'source,stt' } });
const tr = x.st.steps.filter(s => s.id === 'traiter');
ok(tr.length && tr.every(s => s.status === 'refused') && /taux d'erreur/.test(tr[0].why) && x.st.status === 'paused', 'transcription infidèle : refusée par le taux d’erreur mesuré, puis pause');
x = play('audio', 'fais dire ce texte en synthèse vocale', { env: { FAKE_CLAUDE_CHOICE: 'tts' } });
ok(x.code === 0 && x.st.steps.find(s => s.id === 'traiter')?.slot === 'audio.traiter.tts' && x.st.steps.find(s => s.id === 'acquerir')?.slot === 'audio.acquerir.tts', 'synthèse vocale : texte acquis, puis fichier AUDIO produit (variantes tts)', ids(x.st || { steps: [] }));

// ---------------------------------------------------------------------------
section('5. Avec ffprobe (s’il est installé) : décodage réel exigé');
const ff = M.findFfprobe({ ...process.env, ORCH_FFPROBE: '' });
if (!ff) ok(true, 'ffprobe absent sur ce poste : section sautée (le contrôle par signature reste actif)');
else {
  x = play('audio', 'nettoie le bruit de cet enregistrement', { env: { ORCH_FFPROBE: ff, FAKE_CLAUDE_CHOICE: 'source,traitement' } });
  ok(x.code === 0 && x.st.steps.find(s => s.id === 'acquerir')?.status === 'ok', 'WAV réel : décodé par ffprobe (durée, piste audio)', ids(x.st || { steps: [] }));
  x = play('video', 'découpe la vidéo', { env: { ORCH_FFPROBE: ff, FAKE_CLAUDE_CHOICE: 'transcription,decoupe' } });
  const ac = x.st.steps.filter(s => s.id === 'acquerir');
  ok(ac.length && ac.every(s => s.status === 'refused') && /ffprobe/.test(ac[0].why), 'en-tête MP4 sans vidéo réelle : refusé par ffprobe');
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
