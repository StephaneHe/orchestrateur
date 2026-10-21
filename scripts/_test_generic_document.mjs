#!/usr/bin/env node
// ============================================================================
// scripts/_test_generic_document.mjs — Rédaction, mode « document » (one-off
// work on an EXISTING document; pipelines phase 1, PIPELINES-SYNTHESE §3.3)
// ============================================================================
//
// User request (2026-10-20, verbatim): « Il faut aussi prevoir des cas
// generique, comme un travail ponctuel sur un document » — decision 4. Real
// case (anonymised in tests/pipeline-corpus/): « Inscris deux nouvelles tâches
// dans le TODO_LIST.md » went to Développement (5 model calls, 2 reviews).
//
// Protected (document-check.mjs, real dispatch.mjs and engine, fake claude):
//   - one document named by the request → « Cibler » by the program (the
//     operation chosen by the classifier model's meaning), no Cibler turn;
//   - only the targeted file changes, even in a dirty tree; one commit of it
//     only, no version;
//   - format preserved (extension, BOM, line endings, front-matter, JSON,
//     headings), length ±25 % to correct, < 50 % to summarise, nothing removed
//     to complete, the target language to translate;
//   - summary / translation = a NEW file, the source untouched;
//   - DOCUMENT_DEJA_CONFORME: nothing changed, nothing delivered;
//   - Relire only above 80 changed lines, its corrections loop back;
//   - Office formats refused explicitly; a protected document goes to Dev;
//   - outside git: the targets are copied first, a refused attempt is undone
//     from the copy, the delivery gives fingerprints and the diff.
//
//   node scripts/_test_generic_document.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import * as D from './document-check.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gendoc-'));
const put = (abs, s) => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, s); };
const B = (s) => Buffer.from(s, 'utf8');

section('1. Préservation du format (document-check.mjs)');
{
  const fp = (o, n, op = 'relire-corriger', origExt = '.md', nextExt = '.md') => D.formatProblems(B(o), B(n), { op, origExt, nextExt });
  ok(!fp('# T\n\nTexte\n', '# T\n\nTexte corrigé\n').length, 'correction simple : format préservé');
  ok(fp('# T\r\nTexte\r\n', '# T\nTexte\n').some(p => /fins de ligne/.test(p)), 'CRLF → LF : refusé');
  ok(fp('\uFEFF# T\n', '# T\n').some(p => /BOM/.test(p)), 'BOM perdue : refusée');
  ok(fp('---\ntitle: x\n---\n# T\n', '# T\n').some(p => /front-matter/.test(p)), 'front-matter perdu : refusé');
  ok(fp('{"a":1}', '{"a":1,}', 'reformater', '.json', '.json').some(p => /JSON/.test(p)), 'JSON cassé : refusé');
  ok(fp('# A\n## B\n## C\n', '# A\n## B\n').some(p => /titres perdus/.test(p)), 'titre perdu : refusé');
  ok(!fp('# A\n## B\n## C\n', '# A\nrésumé\n', 'resumer').length, 'résumé : les titres peuvent disparaître');
  ok(fp('a', 'a', 'relire-corriger', '.md', '.txt').some(p => /extension/.test(p)), 'extension changée : refusée');
  ok(D.yamlProblem('a:\n\tb: 1\n') && !D.yamlProblem('a:\n  b: [1, 2]\n'), 'YAML : tabulation refusée, structure simple acceptée');
  ok(D.tomlProblem('[x]\na = 1\nn\n') && !D.tomlProblem('# c\n[x]\na = 1\nb = [\n 1,\n]\n'), 'TOML : ligne illisible refusée, tableau sur plusieurs lignes accepté');
  const op = (o, n, x, langue) => D.operationProblems(B(o), B(n), { op: x, langue });
  ok(op('x'.repeat(100), 'x'.repeat(140), 'relire-corriger').length && !op('x'.repeat(100), 'x'.repeat(110), 'relire-corriger').length, 'corriger : ±25 % de longueur');
  ok(op('x'.repeat(100), 'x'.repeat(60), 'resumer').length && !op('x'.repeat(100), 'x'.repeat(30), 'resumer').length, 'résumer : moins de la moitié');
  ok(op('- a\n- b\n', '- a\n- c\n- d\n', 'completer').some(p => /retire rien/.test(p)) && !op('- a\n- b\n', '- a\n- b\n- c\n', 'completer').length, 'compléter : rien retiré');
  const fr = 'Le chat est sur la table et il regarde par la fenêtre pendant que nous parlons de la journée.';
  const en = 'The cat is on the table and it looks through the window while we talk about the day and the weather.';
  ok(op(fr, en, 'traduire', 'en').length === 0 && op(fr, fr, 'traduire', 'en').some(p => /traduction/.test(p)), 'traduire : langue cible détectée');
  const C = path.join(T, 'cible');
  put(path.join(C, 'doc.md'), '# Doc\n'); put(path.join(C, 'rapport.docx'), 'PK'); put(path.join(C, 'test', 'a.test.mjs'), 'x');
  ok(!D.checkTarget(C, { fichiers: ['rapport.docx'], operation: 'relire-corriger' }).ok, 'DOCX : refusé explicitement (format non pris en charge)');
  ok(!D.checkTarget(C, { fichiers: ['test/a.test.mjs'], operation: 'reformater' }, { protectedFn: f => f.startsWith('test/') }).ok, 'fichier de test : protégé, passe par le Développement');
  ok(!D.checkTarget(C, { fichiers: ['doc.md'], operation: 'resumer', sortie: 'remplacer' }).ok, 'résumer par-dessus la source : refusé');
  ok(!D.checkTarget(C, { fichiers: ['doc.md'], operation: 'traduire' }).ok, 'traduire sans langue cible : refusé');
  ok(!D.checkTarget(C, { fichiers: ['absent.md'], operation: 'completer' }).ok, 'document inexistant : refusé');
  ok(D.candidateTargets(C, 'Ajoute une ligne à `doc.md` et regarde README.md').map(t => t.path).join() === 'doc.md', 'cible trouvée sur le disque (le fichier inexistant est ignoré)');
}

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'chef'));
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const P = path.join(T, 'P');
const Q = path.join(T, 'Q');   // a folder outside git
const TODO = '# TODO\n\n- [x] (2026-10-01) première tâche\n- [ ] (2026-10-02) deuxième tâche\n';
function repo() {
  fs.rmSync(P, { recursive: true, force: true });
  const w = (rel, s) => put(path.join(P, rel), s);
  w('package.json', JSON.stringify({ name: 'P', version: '1.0.0', type: 'module' }, null, 2) + '\n');
  w('test/base.test.mjs', "import { test } from 'node:test';\ntest('base', () => {});\n");
  w('.orchestrateur/pipeline.json', JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'] }));
  w('TODO_LIST.md', TODO);
  w('docs/guide.md', '# Guide\n\n## Installer\n\nLancer npm install.\n\n## Utiliser\n\nOuvrir le tableau de bord et choisir un projet dans la liste.\n');
  g(P, 'init', '-q'); g(P, 'add', '-A'); g(P, 'commit', '-q', '-m', 'init');
  w('src/en-cours.mjs', 'export const wip = 1;\n');   // the user's own work in progress: never touched
}
fs.rmSync(Q, { recursive: true, force: true });
put(path.join(Q, 'notes.md'), '# Notes\n\nLe texte des notes de la réunion.\n');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }, { name: 'Q', path: Q }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['P', 'Q'], pipelines: E.ENGINE_PIPELINES, tuning: { generic: true } },
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'redaction.modifier.completer': { provider: 'anthropic', model: 'claude-sonnet-5-5' }, 'redaction.cibler': { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
}, null, 2));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200',
  FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'redaction', mode: 'document', raison: 'un document existant' }) };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME',
  'FAKE_PIPE_JSON', 'FAKE_PIPE_BAD', 'FAKE_PIPE_NOTHING', 'FAKE_CLAUDE_CHOICE', 'FAKE_CLAUDE_DUMP_PROMPT', 'ORCH_REQUEST_ID']) delete baseEnv[k];
const logOf = (p) => { try { return fs.readFileSync(path.join(T, 'logs', `${p}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
function play(p, args, env = {}) {
  const n0 = logOf(p).length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), p, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  const evs = logOf(p).slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline?.run)?.pipeline.run;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, run, st: run ? runState(run) : null, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const read = (rel) => fs.readFileSync(path.join(P, rel), 'utf8');
const TWO = `${TODO}- [ ] (2026-10-21) ajouter les 5 vidéos au lecteur\n- [ ] (2026-10-21) télécharger le reel\n`;

section('2. « Ajoute deux tâches à TODO_LIST.md » : un seul tour de model, un commit de ce fichier seul');
repo();
let x = play('P', ['Inscris deux nouvelles tâches dans `TODO_LIST.md`, sans les exécuter : ajouter les 5 vidéos au lecteur, puis télécharger le reel.', '--test', 'todo'], {
  FAKE_CLAUDE_CHOICE: 'completer', FAKE_PIPE_JSON: JSON.stringify({ modifier: { writes: { 'TODO_LIST.md': TWO } } }) });
ok(x.code === 0 && x.st?.status === 'done' && x.st.mode === 'document', `Rédaction « document » terminée (code ${x.code})`, x.out.slice(-1500));
ok(x.st?.steps.find(s => s.id === 'cibler')?.source === 'code' && x.st.steps.filter(s => s.model && s.source !== 'code').map(s => s.id).join() === 'modifier', `un seul tour de model (Modifier) : ${x.st?.steps.map(s => `${s.id}:${s.source || s.model}`).join(', ')}`);
ok(x.st?.steps.some(s => s.id === 'modifier' && s.slot === 'redaction.modifier.completer' && s.model === 'claude-sonnet-5-5'), 'case de l’opération : redaction.modifier.completer');
ok(x.st?.steps.some(s => s.id === 'relire-document' && s.status === 'skipped' && /au-delà de 80/.test(s.why)), 'Relire sautée : petite modification (dit)');
const show = g(P, 'show', '--name-only', '--format=%s', 'HEAD').stdout;
ok(/TODO_LIST\.md/.test(show) && !/en-cours|package\.json/.test(show) && fs.existsSync(path.join(P, 'src', 'en-cours.mjs')), 'commit du seul TODO_LIST.md ; le travail en cours de l’utilisateur n’est pas touché', show);
ok(read('package.json').includes('"version": "1.0.0"') && /SHA-256/.test(x.result), 'aucune version ; empreintes et diff dans le résultat');

section('3. Compléter qui retire une ligne : refusé, document remis');
repo();
x = play('P', ['Ajoute une tâche à `TODO_LIST.md`.', '--test', 'retire une ligne'], {
  FAKE_CLAUDE_CHOICE: 'completer', FAKE_PIPE_JSON: JSON.stringify({ modifier: { writes: { 'TODO_LIST.md': '# TODO\n\n- [ ] (2026-10-21) la nouvelle\n' } } }) });
ok(x.st?.status === 'paused' && x.st.steps.filter(s => s.id === 'modifier' && s.status === 'refused').every(s => /retire rien/.test(s.why)), 'refusé : « compléter ne retire rien »', x.st?.steps?.map(s => `${s.id}:${s.status}:${s.why || ''}`).join(' | '));
ok(read('TODO_LIST.md') === TODO, 'le document est remis à l’identique');

section('4. Traduire : un NOUVEAU fichier, source intacte, langue vérifiée');
repo();
const EN = '# Guide\n\n## Install\n\nRun npm install.\n\n## Use\n\nOpen the dashboard and choose a project in the list, then the work starts with the first step of the day.\n';
x = play('P', ['Traduis `docs/guide.md` en anglais.', '--test', 'traduire'], {
  FAKE_CLAUDE_CHOICE: 'traduire,en', FAKE_PIPE_JSON: JSON.stringify({ modifier: { writes: { 'docs/guide.en.md': EN } } }) });
ok(x.st?.status === 'done' && fs.existsSync(path.join(P, 'docs', 'guide.en.md')) && /Lancer npm install/.test(read('docs/guide.md')), 'nouveau fichier écrit, source intacte', x.out.slice(-1200));
ok(JSON.parse(fs.readFileSync(path.join(P, '.orchestrateur', 'runs', x.run, 'cible.json'), 'utf8')).langue === 'en', 'langue cible choisie par le model de classement (« en »)');
repo();
x = play('P', ['Traduis `docs/guide.md` en anglais.', '--test', 'traduire par-dessus'], {
  FAKE_CLAUDE_CHOICE: 'traduire,en', FAKE_PIPE_JSON: JSON.stringify({ modifier: { writes: { 'docs/guide.md': EN } } }) });
ok(x.st?.status === 'paused' && /source a été modifiée/.test(x.st.steps.filter(s => s.status === 'refused').pop()?.why || '') && /Lancer npm install/.test(read('docs/guide.md')), 'traduction écrite par-dessus la source : refusée, source remise');

section('5. Déjà conforme : rien modifié, rien livré');
repo();
x = play('P', ['Relis et corrige `docs/guide.md`.', '--test', 'déjà conforme'], {
  FAKE_CLAUDE_CHOICE: 'relire-corriger', FAKE_PIPE_NOTHING: 'modifier' });
ok(x.st?.status === 'done' && g(P, 'log', '-1', '--format=%s').stdout.trim() === 'init' && /déjà conforme/.test(x.result), 'DOCUMENT_DEJA_CONFORME : aucun commit, dit dans le résultat', x.result.slice(0, 500));

section('6. Plusieurs documents : Cibler par le model, case redaction.cibler');
repo();
x = play('P', ['Reformate `docs/guide.md` et `TODO_LIST.md` en listes propres.', '--test', 'deux documents'], {
  FAKE_PIPE_JSON: JSON.stringify({ cibler: { fichiers: ['docs/guide.md'], operation: 'relire-corriger', sortie: 'remplacer' }, modifier: { writes: { 'docs/guide.md': read('docs/guide.md').replace('choisir', 'sélectionner') } } }) });
ok(x.st?.status === 'done' && x.st.steps.some(s => s.id === 'cibler' && s.model === 'claude-sonnet-5-5'), 'deux documents nommés : l’étape Cibler est jouée par le model', x.out.slice(-1200));

section('7. Hors git : copie d’abord, essai refusé annulé depuis la copie, empreintes et diff');
x = play('Q', [`Complète \`notes.md\` avec une section « Décisions ».`, '--test', 'hors git'], {
  FAKE_CLAUDE_CHOICE: 'completer', FAKE_PIPE_JSON: JSON.stringify({ modifier: { writes: { 'notes.md': '# Notes\n' } } }) });
ok(x.st?.status === 'paused' && fs.readFileSync(path.join(Q, 'notes.md'), 'utf8') === '# Notes\n\nLe texte des notes de la réunion.\n', 'dossier hors git : l’essai refusé est annulé depuis la copie', x.out.slice(-1000));
x = play('Q', [`Complète \`notes.md\` avec une section « Décisions ».`, '--test', 'hors git ok'], {
  FAKE_CLAUDE_CHOICE: 'completer', FAKE_PIPE_JSON: JSON.stringify({ modifier: { writes: { 'notes.md': '# Notes\n\nLe texte des notes de la réunion.\n\n## Décisions\n\n- aucune\n' } } }) });
ok(x.st?.status === 'done' && /hors git/.test(x.result) && /```diff/.test(x.result) && /\+## Décisions/.test(x.result), 'livré hors git : sauvegarde, empreintes, diff', x.result.slice(0, 900));

section('8. Plan du mode');
ok(E.planSteps('redaction', { mode: 'document' }).map(s => s.id).join() === 'cibler,modifier,relire-document,livrer-document', 'Cibler → Modifier → Relire (si > 80 lignes) → Livrer (programme)');
ok(E.planSteps('redaction', { mode: 'complet' }).map(s => s.id).join() === 'rediger,relire,mettre-en-forme,livrer', 'la Rédaction ordinaire est inchangée');
ok(E.pipelineLabel('redaction', 'document') === 'Rédaction — document existant', 'libellé du mode');

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
