#!/usr/bin/env node
// ============================================================================
// scripts/_test_reunion_pipeline.mjs — requirement test (0.110.0)
// ============================================================================
//
// User request (2026-10-16): « Il faut un nouveau pipeline, plus adapté aux
// demandes de gestion de compte rendu de réunions ». A request to tidy the
// files of a meeting (keep the final e-mail, delete the drafts, keep video,
// transcript and opinion, findable under a name) had been classified into
// Maintenance, which upkeeps code and tidied nothing; its « dette » step was
// refused twice although the marker had been written (artefact of 16 chars).
//
// Protects: the pipeline definition (catalog, Models page, prefix, selector),
// the classification of such a request into « reunion » (prompt rule, model
// answer accepted), every code criterion (meeting-check.mjs), the deletion by
// code from the explicit list, the doubts asked BEFORE any deletion
// (« continuer » keeps them, « tout supprimer » deletes them), the final
// verification, the local delivery (version, CHANGELOG, no push), and the
// marker-only artefact fix. Real dispatch.mjs and engine, claude double,
// throw-away root (DISPATCH_ROOT_FOR_TESTS): production is never touched.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import * as M from './meeting-check.mjs';
import { PIPELINES, slotsOf, stepsOf, JUDGE_STEPS } from './model-pipelines.mjs';
import { explicitChoice } from './pipeline-observe.mjs';
import { classificationPrompt, routingTaskPrompt, parseClassification, parseTaskClassification, classifyTask } from './pipeline-classify.mjs';
import { pipelineOptsFrom, withPipelinePrefix } from './pipeline-entry-opts.mjs';
import { catalogOf } from './pipeline-catalog.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. Définition : catalogue, page Models, préfixe, sélecteurs');
const cat = catalogOf('reunion');
ok(E.ENGINE_PIPELINES.includes('reunion') && cat, 'pipeline « reunion » connu du moteur');
ok(cat.steps.map(s => s.id).join() === 'inventorier,trier,definitif,supprimer,ranger,verifier,livrer', `déroulé : ${cat.steps.map(s => s.id).join(' → ')}`);
ok(cat.steps.find(s => s.id === 'supprimer').kind === 'code' && cat.steps.find(s => s.id === 'verifier').kind === 'code', 'suppression et vérification exécutées par le CODE');
ok(cat.steps.find(s => s.id === 'trier').askUser === 'doutes', 'la liste explicite pose les doutes à l’utilisateur');
ok(cat.steps.filter(s => s.kind !== 'code' && s.kind !== 'deliver').every(s => s.checks?.meeting), 'chaque étape de model a ses critères vérifiés par le code');
const livrer = cat.steps.find(s => s.id === 'livrer');
ok(livrer.kind === 'deliver' && livrer.crit === 'livrer' && livrer.version !== false, 'livraison : commit, version et CHANGELOG (critère « livrer »)');
ok(cat.needs.git && cat.needs.clean, 'exige un dépôt git propre');
const page = PIPELINES.find(p => p.id === 'reunion');
ok(page && page.purpose && page.when && /réunion/i.test(page.when) && stepsOf(page).every(s => s.title && s.what && s.example), 'page Models : bandeau et étapes complètes');
const slots = slotsOf().filter(s => s.pipeline === 'reunion').map(s => s.id);
ok(cat.steps.every(s => slots.includes(s.chain[0])), `une case par étape : ${slots.join(', ')}`);
ok(JUDGE_STEPS.has('reunion.trier'), '« Lister ce qui sera supprimé » est une étape de jugement');
ok(/never maintenance/.test(classificationPrompt('x', {}, PIPELINES.filter(p => p.id !== 'routage'))), 'règle de sens du classement : jamais Maintenance');
ok(/Pas le rangement/.test(PIPELINES.find(p => p.id === 'maintenance').when), 'Maintenance se décrit comme l’entretien du code seulement');
ok(explicitChoice({ text: '/reunion range la réunion du 16' }).pipeline === 'reunion' && explicitChoice({ text: '/réunion x' }).pipeline === 'reunion' && explicitChoice({ text: '/compte-rendu x' }).pipeline === 'reunion', 'préfixes /reunion, /réunion, /compte-rendu');
ok(pipelineOptsFrom({ pipeline: 'reunion' }).pipeline === 'reunion' && withPipelinePrefix('range', { pipeline: 'reunion' }) === '/reunion range' && withPipelinePrefix('/réunion range', { pipeline: 'reunion' }) === '/réunion range', 'sélecteur : accepté par le serveur, préfixe vers le chef');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
ok(/<option value="reunion">Réunion<\/option>/.test(html), 'sélecteur du dashboard : option « Réunion »');
const kt = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'orchestrateur', 'data', 'PipelineChoice.kt'), 'utf8');
ok(/REUNION\("Réunion", "reunion", null\)/.test(kt), 'sélecteur de l’app Android : choix « Réunion »');

// ---------------------------------------------------------------------------
section('2. Classement : une demande de compte rendu de réunion va dans « reunion »');
const REQ = 'Voici le mail définitif envoyé à tout le monde : « Bonjour à tous, merci pour la réunion du 16 octobre. Nous avons décidé de lancer la phase 2 en novembre. » Aucun autre n’a été envoyé. Garde ce mail dans le répertoire, supprime les brouillons. A la fin ne doivent rester : le mail, la video, le transcript, ton avis ; le tout facilement retrouvable en tant que "réunion de lancement du 16 octobre"';
const choices = PIPELINES.filter(p => p.id !== 'routage');
const prompt = classificationPrompt(REQ, {}, choices);
ok(/- reunion: Compte rendu de réunion/.test(prompt) && /- maintenance:/.test(prompt), 'le model voit « reunion » et « maintenance » avec leur description');
const v = parseClassification('{"pipeline":"reunion","mode":"complet","raison":"rangement des fichiers d’une réunion"}', {}, choices);
ok(v?.pipeline === 'reunion' && v.mode === 'complet' && v.kind === null, 'réponse « reunion » du model acceptée (sans nature de dev)');
const tp = routingTaskPrompt({ projet: 'P', demande: REQ }, {}, choices);
ok(/- reunion:/.test(tp) && /never maintenance/.test(tp), 'tâche du Routage : même liste, même règle');
ok(parseTaskClassification('{"pipeline":"reunion","mode":"complet","raison":"réunion"}', {}, choices)?.pipeline === 'reunion', 'tâche du Routage classée « reunion »');
const T0 = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reu-cls-'));
fs.writeFileSync(path.join(T0, 'model-routing.json'), JSON.stringify({ version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } } }));
let seenPrompt = '';
const r0 = await classifyTask({ root: T0, logsDir: null, task: { projet: 'P', demande: REQ }, oneShot: async (p) => { seenPrompt = p; return { ok: true, text: '{"pipeline":"reunion","mode":"complet","raison":"fichiers de réunion"}' }; } });
ok(r0.pipeline === 'reunion' && /réunion de lancement/.test(seenPrompt), 'classifyTask : le model reçoit la demande et la classe en « reunion »');
fs.rmSync(T0, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('3. Critères par le code (meeting-check.mjs)');
const U = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reu-unit-'));
const put = (rel, s) => { fs.mkdirSync(path.dirname(path.join(U, rel)), { recursive: true }); fs.writeFileSync(path.join(U, rel), s); };
put('mails/brouillon.md', 'brouillon'); put('media/r.mp4', 'v'); put('notes/avis.md', 'avis');
ok(M.normText('a  b’c  «d»') === 'a b\'c "d"', 'normalisation : espaces, apostrophes et guillemets typographiques');
ok(M.safeRel(U, '../x') === null && M.safeRel(U, '.git/config') === null && M.safeRel(U, '.orchestrateur/runs/x') === null && M.safeRel(U, 'a/b.md') === 'a/b.md', 'chemins : hors projet, .git et .orchestrateur refusés');
const invJ = (fichiers, extra = {}) => JSON.stringify({ nom: 'réunion de lancement du 16 octobre', dossier: 'reunions/2026-10-16', fichiers, ...extra });
const files = [{ chemin: 'mails/brouillon.md', role: 'brouillon' }, { chemin: 'media/r.mp4', role: 'video' }, { chemin: 'notes/avis.md', role: 'avis' }];
ok(!M.checkInventory(U, invJ([...files, { chemin: 'absent.md', role: 'notes' }])).ok, 'inventaire : fichier inexistant refusé');
ok(!M.checkInventory(U, invJ([{ chemin: 'media/r.mp4', role: 'film' }])).ok && !M.checkInventory(U, invJ(files, { nom: '' })).ok, 'inventaire : rôle inconnu ou nom absent refusé');
const inv = M.checkInventory(U, invJ(files));
ok(inv.ok, 'inventaire valide accepté', inv.why);
const so = (o) => M.checkSorting(U, inv.value, JSON.stringify({ supprimer: [], garder: [], doutes: [], ...o }));
ok(/sans décision/.test(so({ supprimer: [{ chemin: 'mails/brouillon.md', raison: 'brouillon' }], garder: ['media/r.mp4'] }).why || ''), 'liste : un fichier inventorié sans décision est refusé (liste explicite)');
ok(/ne peut pas être supprimé/.test(so({ supprimer: [{ chemin: 'media/r.mp4', raison: 'x' }, { chemin: 'mails/brouillon.md', raison: 'x' }], garder: ['notes/avis.md'] }).why || ''), 'liste : la vidéo ne peut pas être supprimée (seuls brouillons et doublons)');
ok(/à la fois/.test(so({ supprimer: [{ chemin: 'mails/brouillon.md', raison: 'brouillon' }], garder: ['mails/brouillon.md', 'media/r.mp4', 'notes/avis.md'] }).why || ''), 'liste : un fichier dans deux listes est refusé');
ok(/sans « question »/.test(so({ doutes: [{ chemin: 'mails/brouillon.md' }], garder: ['media/r.mp4', 'notes/avis.md'] }).why || ''), 'liste : un doute sans question est refusé');
const sorting = so({ supprimer: [{ chemin: 'mails/brouillon.md', raison: 'brouillon remplacé' }], garder: ['media/r.mp4', 'notes/avis.md'] });
ok(sorting.ok, 'liste explicite valide acceptée', sorting.why);
const MAIL = 'Bonjour à tous, merci pour la réunion du 16 octobre. Nous avons décidé de lancer la phase 2 en novembre.';
put('reunions/2026-10-16/mail.md', MAIL.replace('Bonjour', '  Bonjour').replace(', merci', ',\nmerci'));
ok(M.checkDefinitive(U, { art: '{"fichier":"reunions/2026-10-16/mail.md"}', demande: REQ, sorting: sorting.value, changed: ['reunions/2026-10-16/mail.md'] }).ok, 'texte définitif : identique à la demande (espaces et retours à la ligne près) accepté');
put('reunions/2026-10-16/mail2.md', `# Mail\n\n${MAIL}`);
ok(/EXACTEMENT/.test(M.checkDefinitive(U, { art: '{"fichier":"reunions/2026-10-16/mail2.md"}', demande: REQ, sorting: sorting.value }).why || ''), 'texte définitif : un titre ajouté est refusé');
put('reunions/2026-10-16/mail3.md', MAIL.replace('novembre', 'décembre'));
ok(!M.checkDefinitive(U, { art: '{"fichier":"reunions/2026-10-16/mail3.md"}', demande: REQ, sorting: sorting.value }).ok, 'texte définitif : un mot changé est refusé');
ok(/seul le fichier/.test(M.checkDefinitive(U, { art: '{"fichier":"reunions/2026-10-16/mail.md"}', demande: REQ, sorting: sorting.value, changed: ['reunions/2026-10-16/mail.md', 'src/x.js'] }).why || ''), 'texte définitif : aucun autre fichier ne peut changer');
ok(/liste des fichiers à supprimer/.test(M.checkDefinitive(U, { art: '{"fichier":"mails/brouillon.md"}', demande: REQ, sorting: sorting.value }).why || ''), 'texte définitif : jamais dans un fichier à supprimer');
ok(M.checkDefinitive(U, { art: 'AUCUN_TEXTE_DEFINITIF', demande: REQ, sorting: sorting.value }).value?.none, 'aucun texte définitif fourni : marqueur accepté');
put('reunions/2026-10-16/video.mp4', 'v'); put('reunions/2026-10-16/avis.md', 'avis');
put('reunions/2026-10-16/README.md', '# Réunion de lancement du 16 octobre\n\n- [mail](mail.md)\n- [vidéo](video.mp4)\n- [avis](avis.md)\n');
const els = [{ role: 'mail-definitif', chemin: 'reunions/2026-10-16/mail.md' }, { role: 'video', chemin: 'reunions/2026-10-16/video.mp4' }, { role: 'avis', chemin: 'reunions/2026-10-16/avis.md' }];
const filing = (o = {}) => M.checkFiling(U, { art: JSON.stringify({ index: 'reunions/2026-10-16/README.md', elements: els, ...o }), inv: inv.value, sorting: sorting.value, definitive: { fichier: 'reunions/2026-10-16/mail.md' }, demande: REQ, deleted: [], changed: [] });
ok(filing().ok, 'rangement : dossier, index nommé, éléments cités → accepté', filing().why);
ok(/absent\(s\) du rangement : avis/.test(filing({ elements: els.slice(0, 2) }).why || ''), 'rangement : un élément gardé (l’avis) manquant est refusé');
ok(/n’est pas dans le dossier/.test(filing({ elements: [...els, { role: 'notes', chemin: 'notes/avis.md' }] }).why || ''), 'rangement : un élément hors du dossier est refusé');
put('reunions/2026-10-16/README.md', '# Réunion\n\n- [mail](mail.md)\n- [vidéo](video.mp4)\n- [avis](avis.md)\n');
ok(/ne contient pas le nom/.test(filing().why || ''), 'rangement : un index sans le nom de la réunion est refusé');
put('reunions/2026-10-16/README.md', '# REUNION DE LANCEMENT DU 16 OCTOBRE\n\n- [mail](mail.md)\n- [vidéo](video.mp4)\n- [avis](avis.md)\n');
ok(filing().ok, 'rangement : le nom est retrouvé sans casse ni accents');
ok(/modifiés aussi/.test(M.checkFiling(U, { art: JSON.stringify({ index: 'reunions/2026-10-16/README.md', elements: els }), inv: inv.value, sorting: sorting.value, definitive: null, demande: REQ, changed: ['src/app.js'] }).why || ''), 'rangement : un fichier sans rapport avec la réunion ne peut pas changer');
const ver = M.verifyMeeting(U, { inv: inv.value, filing: filing().value, deleted: ['mails/brouillon.md'], definitive: { fichier: 'reunions/2026-10-16/mail.md' }, demande: REQ });
ok(!ver.ok && /encore présent : mails\/brouillon\.md/.test(ver.problems.join()), 'vérification finale : un brouillon encore présent est signalé');
fs.rmSync(path.join(U, 'mails/brouillon.md'));
ok(M.verifyMeeting(U, { inv: inv.value, filing: filing().value, deleted: ['mails/brouillon.md'], definitive: { fichier: 'reunions/2026-10-16/mail.md' }, demande: REQ }).ok, 'vérification finale : tout est en place');
fs.rmSync(U, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Bout en bout : vrai dispatch.mjs, vrai moteur, faux claude
// ---------------------------------------------------------------------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reu-'));
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
  w('mails/brouillon-2.md', 'Bonjour, brouillon 2\n');
  w('mails/brouillon-final.md', 'Bonjour à tous, presque définitif\n');
  w('media/reunion-16.mp4', 'vidéo simulée\n');
  w('notes/transcript.txt', 'transcription simulée\n');
  w('notes/avis.md', '# Avis\n\nAvis sur la réunion.\n');
  g(dir, 'init', '-q'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: path.join(T, 'P') }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['P'], pipelines: E.ENGINE_PIPELINES },
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'reunion.definitif': { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_PIPE_JSON', 'FAKE_PIPE_BAD', 'FAKE_PIPE_NOTHING']) delete baseEnv[k];
const dispatch = (args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const okSteps = (st) => st.steps.filter(s => s.status === 'ok').map(s => s.id);
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const F = 'reunions/2026-10-16-lancement';
const plan = ({ doubt = false } = {}) => JSON.stringify({
  inventorier: { nom: 'réunion de lancement du 16 octobre', dossier: F, fichiers: [
    { chemin: 'mails/brouillon-1.md', role: 'brouillon' }, { chemin: 'mails/brouillon-2.md', role: 'brouillon' }, { chemin: 'mails/brouillon-final.md', role: 'brouillon' },
    { chemin: 'media/reunion-16.mp4', role: 'video' }, { chemin: 'notes/transcript.txt', role: 'transcription' }, { chemin: 'notes/avis.md', role: 'avis' }] },
  trier: { supprimer: [{ chemin: 'mails/brouillon-1.md', raison: 'brouillon' }, { chemin: 'mails/brouillon-2.md', raison: 'brouillon' },
    ...(doubt ? [] : [{ chemin: 'mails/brouillon-final.md', raison: 'brouillon remplacé par le mail envoyé' }])],
    garder: ['media/reunion-16.mp4', 'notes/transcript.txt', 'notes/avis.md'],
    doutes: doubt ? [{ chemin: 'mails/brouillon-final.md', question: 'Ce brouillon presque final est-il bien à supprimer ?' }] : [] },
  definitif: { fichier: `${F}/mail-definitif.md` },
  ranger: { nom: 'réunion de lancement du 16 octobre', index: `${F}/README.md`,
    moves: { 'media/reunion-16.mp4': `${F}/2026-10-16-video.mp4`, 'notes/transcript.txt': `${F}/transcription.txt`, 'notes/avis.md': `${F}/avis.md` },
    elements: [{ role: 'mail-definitif', chemin: `${F}/mail-definitif.md` }, { role: 'video', chemin: `${F}/2026-10-16-video.mp4` },
      { role: 'transcription', chemin: `${F}/transcription.txt` }, { role: 'avis', chemin: `${F}/avis.md` }] },
});
function play(args, env) {
  const n0 = logOf().length;
  const r = dispatch(args, { FAKE_REUNION_TEXT: `${MAIL}\n`, ...env });
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline?.run)?.pipeline.run;
  return { r, evs, run, st: run ? runState(run) : null };
}

// ---------------------------------------------------------------------------
section('4. Bout en bout : inventaire → liste → définitif → suppression → rangement → vérification → livraison');
let dir = repo();
let x = play(['P', REQ, '--pipeline', 'reunion', '--test', 'réunion'], { FAKE_PIPE_JSON: plan() });
ok(x.r.code === 0 && x.st?.status === 'done', `exécution terminée (code ${x.r.code})`, x.r.out.slice(-1200));
ok(okSteps(x.st).join() === 'inventorier,trier,definitif,supprimer,ranger,verifier,livrer', `étapes validées : ${okSteps(x.st || { steps: [] }).join(' → ')}`);
ok(x.st.steps.find(s => s.id === 'definitif')?.served === 'claude-sonnet-5-5', 'étape « définitif » sur le model de sa case');
ok(['mails/brouillon-1.md', 'mails/brouillon-2.md', 'mails/brouillon-final.md'].every(f => !exists(dir, f)), 'brouillons supprimés');
const trash = path.join(T, 'logs', 'runs', x.run, 'corbeille');
ok(['mails/brouillon-1.md', 'mails/brouillon-2.md', 'mails/brouillon-final.md'].every(f => fs.existsSync(path.join(trash, f))), 'copie de chaque fichier supprimé gardée dans la corbeille de l’exécution');
ok([`${F}/mail-definitif.md`, `${F}/2026-10-16-video.mp4`, `${F}/transcription.txt`, `${F}/avis.md`, `${F}/README.md`].every(f => exists(dir, f)), 'restent : le mail, la vidéo, la transcription, l’avis, et l’index');
ok(fs.readFileSync(path.join(dir, F, 'mail-definitif.md'), 'utf8') === `${MAIL}\n`, 'mail définitif : texte exact de la demande');
ok(/réunion de lancement du 16 octobre/.test(fs.readFileSync(path.join(dir, F, 'README.md'), 'utf8')), 'retrouvable sous « réunion de lancement du 16 octobre » (index)');
ok(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version === '1.0.1' && /## \[1\.0\.1\]/.test(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')), 'livraison : version incrémentée, entrée CHANGELOG');
ok(g(dir, 'status', '--porcelain').stdout.trim() === '' && g(dir, 'rev-list', '--count', 'HEAD').stdout.trim() === '2' && !g(dir, 'remote').stdout.trim(), 'un commit local, arbre propre, aucun push');
ok(!g(dir, 'ls-files', 'mails').stdout.trim(), 'les suppressions sont dans le commit');
const res = x.evs.filter(e => e.type === 'result').pop()?.result || '';
ok(/Vérification : ✓/.test(res) && /corbeille/.test(res), 'le résultat donne la vérification et l’emplacement des copies');
ok(x.evs.filter(e => e.type === 'user_prompt').length === 1 && x.evs.filter(e => e.type === 'result').length === 1, 'un seul tour côté musicien');
ok(x.evs.some(e => e.subtype === 'meeting_deleted') && x.evs.some(e => e.subtype === 'meeting_verified' && e.ok), 'suppression et vérification tracées dans le log');

// ---------------------------------------------------------------------------
section('5. Doutes : question AVANT toute suppression ; « continuer » garde, « tout supprimer » supprime');
dir = repo();
x = play(['P', REQ, '--pipeline', 'reunion', '--test', 'réunion doutes'], { FAKE_PIPE_JSON: plan({ doubt: true }) });
const firstRun = x.run;
ok(x.r.code === 2 && x.st.status === 'paused' && x.st.pausedLimit === 'doutes', `pause « doutes » (code ${x.r.code})`, x.r.out.slice(-800));
const pauseRes = x.evs.filter(e => e.type === 'result').pop()?.result || '';
ok(/NEEDS_USER_INPUT:/.test(pauseRes) && /brouillon-final\.md/.test(pauseRes) && /tout supprimer/.test(pauseRes), 'la question nomme le fichier en doute et les réponses possibles');
ok(['mails/brouillon-1.md', 'mails/brouillon-2.md', 'mails/brouillon-final.md'].every(f => exists(dir, f)) && g(dir, 'status', '--porcelain').stdout.trim() === '', 'rien n’est supprimé ni modifié avant la réponse');
x = play(['P', 'continuer', '--test', 'réunion doutes'], { FAKE_PIPE_JSON: plan({ doubt: true }) });
ok(x.r.code === 0 && runState(firstRun).status === 'done', `« continuer » : exécution reprise et terminée (code ${x.r.code})`, x.r.out.slice(-800));
ok(!exists(dir, 'mails/brouillon-1.md') && !exists(dir, 'mails/brouillon-2.md') && exists(dir, 'mails/brouillon-final.md'), '« continuer » : seuls les sûrs sont supprimés, le fichier en doute est GARDÉ');
dir = repo();
x = play(['P', REQ, '--pipeline', 'reunion', '--test', 'réunion doutes 2'], { FAKE_PIPE_JSON: plan({ doubt: true }) });
const secondRun = x.run;
x = play(['P', 'tout supprimer', '--test', 'réunion doutes 2'], { FAKE_PIPE_JSON: plan({ doubt: true }) });
ok(x.r.code === 0 && runState(secondRun).status === 'done' && !exists(dir, 'mails/brouillon-final.md'), '« tout supprimer » : le fichier en doute est supprimé aussi', x.r.out.slice(-800));
ok(fs.existsSync(path.join(T, 'logs', 'runs', secondRun, 'corbeille', 'mails', 'brouillon-final.md')), '… et sa copie est gardée');

// ---------------------------------------------------------------------------
section('6. Refus par le code, puis nouvel essai');
dir = repo();
x = play(['P', REQ, '--pipeline', 'reunion', '--test', 'réunion refus'], { FAKE_PIPE_JSON: plan(), FAKE_PIPE_BAD: 'definitif:1' });
const df = x.st?.steps.filter(s => s.id === 'definitif') || [];
ok(df[0]?.status === 'refused' && /EXACTEMENT/.test(df[0].why) && df[1]?.status === 'ok' && x.st.status === 'done', 'texte définitif reformulé : refusé, annulé, refait à l’identique', x.r.out.slice(-800));
dir = repo();
x = play(['P', REQ, '--pipeline', 'reunion', '--test', 'réunion index'], { FAKE_PIPE_JSON: plan(), FAKE_PIPE_BAD: 'ranger:1' });
const rg = x.st?.steps.filter(s => s.id === 'ranger') || [];
ok(rg[0]?.status === 'refused' && /ne contient pas le nom/.test(rg[0].why) && rg[1]?.status === 'ok', 'index sans le nom de la réunion : refusé, refait', x.r.out.slice(-800));

// ---------------------------------------------------------------------------
section('7. Classement automatique : la demande part dans « reunion », plus en Maintenance');
dir = repo();
x = play(['P', REQ, '--test', 'réunion classée'], { FAKE_PIPE_JSON: plan(), FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'reunion', mode: 'complet', raison: 'rangement des fichiers d’une réunion' }) });
ok(x.evs.find(e => e.type === 'user_prompt')?.pipeline?.pipeline === 'reunion' && x.st?.status === 'done', 'demande classée « reunion » par le model → exécution Compte rendu de réunion', x.r.out.slice(-800));

// ---------------------------------------------------------------------------
section('8. Défaut constaté sur l’exécution du 2026-10-16 : le marqueur seul est un artefact valide');
dir = repo();
x = play(['P', 'fais la maintenance du projet', '--pipeline', 'maintenance', '--test', 'marqueur seul'], { FAKE_PIPE_NOTHING: 'dependances,tests-instables,dette', FAKE_PIPE_MARKER_ONLY: '1' });
const dt = x.st?.steps.filter(s => s.id === 'dette') || [];
ok(dt.length === 1 && dt[0].status === 'ok' && fs.readFileSync(path.join(dir, '.orchestrateur', 'runs', x.run, 'dette.md'), 'utf8').trim() === 'RIEN_A_NETTOYER', '« RIEN_A_NETTOYER » seul (15 caractères) accepté du premier coup', JSON.stringify(dt));
ok(x.r.code === 0 && x.st.steps.find(s => s.id === 'livrer')?.status === 'skipped', 'rien à faire : livraison sautée');

if (!process.env.KEEP_T) fs.rmSync(T, { recursive: true, force: true }); else console.log(T);
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
