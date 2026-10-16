#!/usr/bin/env node
// ============================================================================
// scripts/_test_reunion_redaction_route.mjs — requirement test (0.111.0)
// ============================================================================
//
// User request (2026-10-16): « Fais un lien entre le pipline Réunion vers le
// pipline Rédaction. Il peut être optionel, un routage interne en fonction du
// besoin. C'est bien en rapport à une réunion, mais il s'agit bien de la
// rédaction d'un email ». A request « mail to Paul » after a meeting had
// been classified into « reunion », which only files meeting files.
//
// Protects: the internal route of the meeting pipeline (filing / writing /
// both), chosen by the classifier MODEL (routage.classifier) from the meaning
// of the request — never by keywords; « e-mail about a meeting » → the
// Rédaction steps (no meeting file touched, the text is the answer); « filing a
// meeting » → exactly the 0.110.0 plan, no Rédaction step; both → filing then
// writing, one delivery; a failed choice pauses before any step; the explicit
// prefixes /redaction and /reunion still win over the classification. Real
// dispatch.mjs and engine, claude double, throw-away root
// (DISPATCH_ROOT_FOR_TESTS): production is never touched.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import { PIPELINES, slotsOf, stepsOf } from './model-pipelines.mjs';
import { explicitChoice } from './pipeline-observe.mjs';
import { classificationPrompt } from './pipeline-classify.mjs';
import { catalogOf, catalogSteps } from './pipeline-catalog.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const FILING = ['inventorier', 'trier', 'definitif', 'supprimer', 'ranger', 'verifier', 'livrer'];
const WRITING = ['rediger', 'relire', 'mettre-en-forme'];

// ---------------------------------------------------------------------------
section('1. Définition : routage interne optionnel, étapes de la Rédaction réutilisées');
const cat = catalogOf('reunion');
ok(cat.route && Object.keys(cat.route.options).join() === 'rangement,redaction,les-deux' && cat.route.slot === 'routage.classifier', 'trois routages : rangement, rédaction, les deux — choisis par le model de routage.classifier');
ok(cat.modes.rangement.join() === FILING.join() && E.planSteps('reunion').map(s => s.id).join() === FILING.join(), 'rangement = le plan par défaut, identique à 0.110.0 (aucune étape de rédaction)');
ok(cat.modes.redaction.join() === [...WRITING, 'livrer-texte'].join(), 'rédaction seule : Rédiger → Relire → Mettre en forme → Livrer (sans rien ranger)');
ok(cat.modes['les-deux'].join() === [...FILING.slice(0, -1), ...WRITING, 'livrer'].join(), 'les deux : le rangement, puis la rédaction, puis UNE livraison');
const red = Object.fromEntries(catalogSteps('redaction').map(s => [s.id, s]));
const inMeeting = Object.fromEntries(catalogSteps('reunion').map(s => [s.id, s]));
ok(WRITING.every(id => inMeeting[id].fromPipeline === 'redaction' && inMeeting[id].chain.join() === red[id].chain.join() && JSON.stringify(inMeeting[id].checks) === JSON.stringify(red[id].checks) && inMeeting[id].artefact === red[id].artefact),
  'les étapes de rédaction gardent les cases, les artefacts et les critères du pipeline Rédaction');
ok(inMeeting['livrer-texte'].version === false && inMeeting['livrer-texte'].ifChanged && inMeeting.livrer.crit === 'livrer', 'rédaction seule : livraison de la Rédaction (sans version) ; après un rangement : la livraison de la réunion');
ok(/RÉUNION/.test(inMeeting.rediger.role) && /RÉDIGER/.test(inMeeting.rediger.role), 'Rédiger reçoit la réunion comme contexte');
const page = PIPELINES.find(p => p.id === 'reunion');
const refs = stepsOf(page).filter(s => s.ref);
ok(refs.some(s => s.ref.pipeline === 'redaction' && s.optional) && refs.some(s => s.ref.pipeline === 'routage'), 'page Models : renvoi optionnel vers « Rédaction » et qualification par le Routage');
ok(slotsOf().filter(s => s.pipeline === 'reunion').length === 7, 'aucune case de plus sur la page Models (7 cases pour la réunion)');
ok(/Rédaction/.test(page.when) && !/ni la rédaction d’un nouveau texte/.test(page.when), 'description de « reunion » : un texte à rédiger sur une réunion y passe aussi');
const choices = PIPELINES.filter(p => p.id !== 'routage');
ok(/routes internally to the Rédaction steps/.test(classificationPrompt('x', {}, choices)) && /never maintenance/.test(classificationPrompt('x', {}, choices)), 'règle de sens du classement : lien interne vers la Rédaction, jamais Maintenance');

// ---------------------------------------------------------------------------
section('2. Préfixes explicites : ils l’emportent toujours');
ok(explicitChoice({ text: '/redaction écris le mail à Paul après la réunion' }).pipeline === 'redaction', '/redaction → pipeline Rédaction');
ok(explicitChoice({ text: '/reunion range la réunion du 16' }).pipeline === 'reunion', '/reunion → pipeline Compte rendu de réunion');

// ---------------------------------------------------------------------------
// Bout en bout : vrai dispatch.mjs, vrai moteur, faux claude
// ---------------------------------------------------------------------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reu-red-'));
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'chef'));
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' });
function repo(name = 'P') {
  const dir = path.join(T, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s); };
  w('package.json', JSON.stringify({ name, version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  w('test/base.test.mjs', "import { test } from 'node:test';\ntest('base', () => {});\n");
  w('src/pipe.mjs', 'export const id = (x) => x;\n');
  w('CHANGELOG.md', '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
  w('docs/USER_REQUIREMENTS.md', '| date | demande | test | version |\n|---|---|---|---|\n');
  w('.orchestrateur/pipeline.json', JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
  w('mails/brouillon-1.md', 'Bonjour, brouillon 1\n');
  w('media/reunion-16.mp4', 'vidéo simulée\n');
  w('notes/transcript.txt', 'transcription simulée\n');
  g(dir, 'init', '-q'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: path.join(T, 'P') }],
}));
const routing = (withClassifier = true) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['P'], pipelines: E.ENGINE_PIPELINES },
  assignments: { ...(withClassifier ? { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } } : {}), 'redaction.relire': { provider: 'anthropic', model: 'claude-opus-5-5' } },
}, null, 2));
routing();
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME',
  'FAKE_PIPE_JSON', 'FAKE_PIPE_BAD', 'FAKE_PIPE_NOTHING', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CHOICE', 'FAKE_CLAUDE_DUMP_PROMPT']) delete baseEnv[k];
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const okSteps = (st) => st.steps.filter(s => s.status === 'ok').map(s => s.id);
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
function play(args, env = {}) {
  const n0 = logOf().length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline?.run)?.pipeline.run;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, run, st: run ? runState(run) : null, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const F = 'reunions/2026-10-16-lancement';
const MAIL = 'Bonjour à tous, merci pour la réunion du 16 octobre.';
const filingPlan = JSON.stringify({
  inventorier: { nom: 'réunion de lancement du 16 octobre', dossier: F, fichiers: [
    { chemin: 'mails/brouillon-1.md', role: 'brouillon' }, { chemin: 'media/reunion-16.mp4', role: 'video' }, { chemin: 'notes/transcript.txt', role: 'transcription' }] },
  trier: { supprimer: [{ chemin: 'mails/brouillon-1.md', raison: 'brouillon' }], garder: ['media/reunion-16.mp4', 'notes/transcript.txt'], doutes: [] },
  definitif: { fichier: `${F}/mail-definitif.md` },
  ranger: { nom: 'réunion de lancement du 16 octobre', index: `${F}/README.md`,
    moves: { 'media/reunion-16.mp4': `${F}/2026-10-16-video.mp4`, 'notes/transcript.txt': `${F}/transcription.txt` },
    elements: [{ role: 'mail-definitif', chemin: `${F}/mail-definitif.md` }, { role: 'video', chemin: `${F}/2026-10-16-video.mp4` }, { role: 'transcription', chemin: `${F}/transcription.txt` }] },
});
const EMAIL_REQ = 'Après la réunion de lancement du 16 octobre, écris le mail à Paul qui résume les décisions prises et les prochaines étapes.';
const FILE_REQ = `Voici le mail définitif envoyé à tout le monde : « ${MAIL} » Garde-le, supprime les brouillons et range la vidéo et la transcription sous « réunion de lancement du 16 octobre ».`;

// ---------------------------------------------------------------------------
section('3. Mail lié à une réunion → routage interne vers la Rédaction');
let dir = repo();
const dump = path.join(T, 'prompts.ndjson');
let x = play([EMAIL_REQ, '--pipeline', 'reunion', '--test', 'mail réunion'], { FAKE_CLAUDE_CHOICE: 'redaction', FAKE_CLAUDE_DUMP_PROMPT: dump });
const asked = fs.readFileSync(dump, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(p => /^\[CLASSIFY\]/.test(p.prompt) && /MEETING/.test(p.prompt));
ok(asked && asked.model === 'claude-haiku-5-5' && /- rangement:/.test(asked.prompt) && /- redaction:/.test(asked.prompt) && /- les-deux:/.test(asked.prompt) && asked.prompt.includes('écris le mail à Paul') && /MEANING/.test(asked.prompt),
  'le model de routage.classifier reçoit la demande et les trois routages, et décide par le sens', asked?.prompt?.slice(0, 400));
ok(x.code === 0 && x.st?.status === 'done' && x.st.route?.id === 'redaction' && x.st.mode === 'redaction', `exécution terminée, routage « redaction » (code ${x.code})`, x.out.slice(-1200));
ok(okSteps(x.st).join() === [...WRITING, 'livrer-texte'].join(), `étapes de la Rédaction seulement : ${okSteps(x.st || { steps: [] }).join(' → ')}`);
ok(!x.st.steps.some(s => FILING.slice(0, -1).includes(s.id)), 'aucune étape de rangement (ni inventaire, ni suppression)');
ok(exists(dir, 'mails/brouillon-1.md') && exists(dir, 'media/reunion-16.mp4') && exists(dir, 'notes/transcript.txt'), 'les fichiers de la réunion ne sont pas touchés');
ok(x.st.steps.find(s => s.id === 'relire')?.served === 'claude-opus-5-5', 'Relire tourne sur le model de la case redaction.relire');
ok(/Routage interne/.test(x.result) && /rédaction/.test(x.result) && /Texte final relu/.test(x.result), 'le résultat annonce le routage et donne le texte relu', x.result.slice(0, 600));
ok(x.evs.some(e => e.subtype === 'pipeline_route' && e.pipeline?.route === 'redaction'), 'routage interne tracé dans le log (system/pipeline_route)');
ok(x.evs.find(e => e.type === 'user_prompt')?.pipeline?.steps.map(s => s.id).join() === [...WRITING, 'livrer-texte'].join(), 'la frise annonce dès le départ les étapes du routage choisi');
ok(x.st.steps.find(s => s.id === 'livrer-texte')?.status === 'ok' && g(dir, 'rev-list', '--count', 'HEAD').stdout.trim() === '2' && g(dir, 'status', '--porcelain').stdout.trim() === '' && !g(dir, 'remote').stdout.trim(), 'livraison de la Rédaction : un commit local, arbre propre, sans push');

// ---------------------------------------------------------------------------
section('4. Rangement d’une réunion → reste dans le pipeline réunion, inchangé');
dir = repo();
x = play([FILE_REQ, '--pipeline', 'reunion', '--test', 'rangement réunion'], { FAKE_CLAUDE_CHOICE: 'rangement', FAKE_PIPE_JSON: filingPlan, FAKE_REUNION_TEXT: `${MAIL}\n` });
ok(x.code === 0 && x.st?.status === 'done' && x.st.route?.id === 'rangement', `exécution terminée, routage « rangement » (code ${x.code})`, x.out.slice(-1200));
ok(okSteps(x.st).join() === FILING.join(), `étapes du rangement, comme en 0.110.0 : ${okSteps(x.st || { steps: [] }).join(' → ')}`);
ok(!x.st.steps.some(s => WRITING.includes(s.id) || s.id === 'livrer-texte'), 'aucune étape de rédaction');
ok(!exists(dir, 'mails/brouillon-1.md') && exists(dir, `${F}/README.md`) && JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version === '1.0.1', 'brouillon supprimé, réunion indexée, livrée (1.0.1)');
ok(/Vérification : ✓/.test(x.result), 'le résultat donne la vérification du rangement');

// ---------------------------------------------------------------------------
section('5. Les deux : rangement, puis rédaction, une seule livraison');
dir = repo();
x = play([`${FILE_REQ} Puis écris le mail à Paul qui résume les décisions.`, '--pipeline', 'reunion', '--test', 'les deux'], { FAKE_CLAUDE_CHOICE: 'les-deux', FAKE_PIPE_JSON: filingPlan, FAKE_REUNION_TEXT: `${MAIL}\n` });
ok(x.code === 0 && x.st?.status === 'done' && okSteps(x.st).join() === [...FILING.slice(0, -1), ...WRITING, 'livrer'].join(), `étapes : ${okSteps(x.st || { steps: [] }).join(' → ')}`, x.out.slice(-1200));
ok(/Vérification : ✓/.test(x.result) && /Texte final relu/.test(x.result), 'le résultat donne la vérification ET le texte relu');
ok(g(dir, 'status', '--porcelain').stdout.trim() === '' && g(dir, 'rev-list', '--count', 'HEAD').stdout.trim() === '2', 'un seul commit livré, arbre propre');

// ---------------------------------------------------------------------------
section('6. Choix impossible → pause avant toute étape ; « continuer » réessaie');
dir = repo();
routing(false);
x = play([EMAIL_REQ, '--pipeline', 'reunion', '--test', 'routage en échec']);
const pausedRun = x.run;
ok(x.code === 2 && x.st?.status === 'paused' && x.st.pausedLimit === 'classifier' && !x.st.steps.length && /routage interne/.test(x.result) && /NEEDS_USER_INPUT:/.test(x.result), `case vide : pause « classifier », aucune étape lancée (code ${x.code})`, x.out.slice(-800));
ok(exists(dir, 'mails/brouillon-1.md') && g(dir, 'status', '--porcelain').stdout.trim() === '', 'rien n’est modifié (jamais de repli par défaut)');
routing(true);
x = play(['continuer', '--test', 'routage en échec'], { FAKE_CLAUDE_CHOICE: 'redaction' });
ok(x.code === 0 && runState(pausedRun).status === 'done' && runState(pausedRun).route?.id === 'redaction' && okSteps(runState(pausedRun)).join() === [...WRITING, 'livrer-texte'].join(), `« continuer » : routage choisi, rédaction faite (code ${x.code})`, x.out.slice(-800));

// ---------------------------------------------------------------------------
section('7. Classement automatique puis routage interne ; le préfixe /redaction l’emporte');
dir = repo();
x = play([EMAIL_REQ, '--test', 'classé réunion'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'reunion', mode: 'complet', raison: 'à propos d’une réunion' }), FAKE_CLAUDE_CHOICE: 'redaction' });
ok(x.evs.find(e => e.type === 'user_prompt')?.pipeline?.pipeline === 'reunion' && x.st?.route?.id === 'redaction' && okSteps(x.st).join() === [...WRITING, 'livrer-texte'].join(), 'demande classée « reunion » → routage interne vers la Rédaction', x.out.slice(-800));
dir = repo();
x = play([`/redaction ${EMAIL_REQ}`, '--test', 'préfixe rédaction'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'reunion', mode: 'complet', raison: 'ne doit pas servir' }) });
ok(x.evs.find(e => e.type === 'user_prompt')?.pipeline?.pipeline === 'redaction' && !x.st?.route && okSteps(x.st).join() === 'rediger,relire,mettre-en-forme,livrer', '« /redaction » : pipeline Rédaction directement, sans classement ni routage interne', x.out.slice(-800));
dir = repo();
x = play([`/reunion ${FILE_REQ}`, '--test', 'préfixe réunion'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'redaction', mode: 'complet', raison: 'ne doit pas servir' }), FAKE_CLAUDE_CHOICE: 'rangement', FAKE_PIPE_JSON: filingPlan, FAKE_REUNION_TEXT: `${MAIL}\n` });
ok(x.evs.find(e => e.type === 'user_prompt')?.pipeline?.pipeline === 'reunion' && okSteps(x.st).join() === FILING.join(), '« /reunion » : pipeline réunion, quel que soit le classement', x.out.slice(-800));

if (!process.env.KEEP_T) fs.rmSync(T, { recursive: true, force: true }); else console.log(T);
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
