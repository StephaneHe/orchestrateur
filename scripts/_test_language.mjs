#!/usr/bin/env node
// ============================================================================
// scripts/_test_language.mjs — language of discussion (0.51.0)
// ============================================================================
//
// Demande utilisateur (2026-10-09) : « verifie pourquoi tu me parles toujours
// anglais alors que j'ai expliciement demande du francais partout. Seul le code
// et les documents qui s'y attachent (doc, ...) doivent etre en anglais. La
// langue de la discussion doit pouvoir etre fixee et tu dois t'y tenir » — et :
// « Cette regle doit s'appliquer aux musiciens aussi, si la langue choisie n'est
// pas un probleme pour le model utilise ».
//
//   1. detection (local heuristic);
//   2. persistent setting (global, per-project override);
//   3. models × reliable languages table;
//   4. instruction injected into EVERY kind of turn (REAL dispatch.mjs);
//   5. gate: mismatch → badge + rewrite, original kept available;
//   6. « English only » model: instruction in English, output rewritten;
//   7. « Tester la langue ».
// Throwaway root, claude and codex test doubles: no real call.
// Check labels are user-facing report output, hence in French.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from './language.mjs';
import { deriveState, createJournal } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const EN = 'I am waiting for the two background runs to finish, then I will commit and push all the changes to the main branch of the project.';
const FR = 'Je reprends le travail demain : la suite de tests passe, et le commit est poussé sur la branche principale avec la nouvelle version du projet.';

// ---------------------------------------------------------------------------
section('1. Détection de la langue (heuristique locale, sans dépendance ni clé)');
const D = (t) => L.detectLanguage(t).lang;
ok(D(FR) === 'fr' && D(EN) === 'en', 'français / anglais');
ok(D('El resultado es bueno y la prueba pasa sin errores para todos los casos que hemos revisado hoy en el proyecto.') === 'es', 'espagnol');
ok(D('Das Ergebnis ist gut und der Test läuft ohne Fehler für alle Fälle, die wir heute in dem Projekt geprüft haben.') === 'de', 'allemand');
ok(D('Il risultato è buono e il test passa senza errori per tutti i casi che abbiamo controllato oggi nel progetto.') === 'it', 'italien');
ok(D('Voici le correctif : `npm test` passe (24 tests), voir src/textkit.js, SLUG_MAX et https://example.org/x. Je recommande de continuer car il ne reste presque rien à faire.') === 'fr', 'français truffé de code, chemins, URL et identifiants anglais → français');
ok(D('ok merci') === 'unknown' && D('```js\nconst a = 1; // the value of the thing\n```') === 'unknown', 'trop court, ou du code seul : on ne juge pas');
ok(D(`${FR}\n\nNEEDS_USER_INPUT: Faut-il pousser maintenant sur la branche principale du dépôt ?`) === 'fr', 'question NEEDS_USER_INPUT comprise');

// ---------------------------------------------------------------------------
// Throwaway root
// ---------------------------------------------------------------------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lang-'));
const P = path.join(T, 'proj');
for (const d of [path.join(T, 'logs'), path.join(T, 'chef'), P]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }, { name: 'Q', path: P }],
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }) + '\n');
fs.mkdirSync(path.join(P, 'test'));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.mkdirSync(path.join(P, '.orchestrateur'));
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'] }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');

// ---------------------------------------------------------------------------
section('2. Réglage persistant : global, override par projet (fichier dédié, jamais config.json)');
ok(L.readSettings(T).default === 'fr' && L.languageFor(T, 'P') === 'fr', 'défaut : français');
ok(L.setDefaultLanguage(T, 'en').ok && L.readSettings(T).default === 'en' && L.languageFor(T, 'P') === 'en', 'langue globale changée et relue');
ok(!L.setDefaultLanguage(T, 'xx').ok, 'langue inconnue refusée');
L.setDefaultLanguage(T, 'fr');
ok(L.setProjectLanguage(T, 'Q', 'es').ok && L.languageFor(T, 'Q') === 'es' && L.languageFor(T, 'P') === 'fr', 'override par projet');
ok(L.setProjectLanguage(T, 'Q', null).ok && L.languageFor(T, 'Q') === 'fr', 'override retiré : le projet suit la langue globale');
const file = JSON.parse(fs.readFileSync(path.join(T, L.SETTINGS_FILE), 'utf8'));
ok(file.history.length >= 4 && !fs.readFileSync(path.join(T, 'config.json'), 'utf8').includes('"default"'), 'historique tenu ; config.json non touché');

// ---------------------------------------------------------------------------
section('3. Table « models × langues fiables » (valeurs par défaut prudentes, éditable)');
const R = (m) => L.reliableLanguages(T, m);
ok(R('claude-opus-5-5').langs.includes('fr') && R('gpt-6-astra').langs.includes('fr') && R('deepseek/deepseek-v4.1-flash').langs.includes('fr'), 'Claude, GPT et grands models multilingues : toutes les langues usuelles');
ok(R('nvidia/nemotron-mini-4b').langs.join() === 'en' && R('nvidia/nemotron-mini-4b').source === 'default', 'model inconnu : anglais seulement, jusqu’à vérification');
ok(L.setModelLanguages(T, 'nvidia/nemotron-mini-4b', ['en', 'fr']).ok && R('nvidia/nemotron-mini-4b').source === 'override' && R('nvidia/nemotron-mini-4b').langs.includes('fr'), 'override enregistré (page Models)');
L.setModelLanguages(T, 'nvidia/nemotron-mini-4b', null);
ok(L.workingLanguage(T, 'nvidia/nemotron-mini-4b', 'fr').working === 'en' && L.workingLanguage(T, 'claude-opus-5-5', 'fr').working === 'fr', 'langue de travail : l’anglais pour un model qui ne maîtrise pas la cible');

// ---------------------------------------------------------------------------
section('4. Consigne injectée dans CHAQUE type de tour (vrai dispatch.mjs)');
const DUMP = path.join(T, 'prompts.ndjson');
const CODEX = path.join(T, 'codex-fake.mjs');
fs.writeFileSync(CODEX, `
import fs from 'node:fs';
let input = ''; process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(DUMP)}, JSON.stringify({ model: 'codex', prompt: input }) + '\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'thread.started', thread_id: 't-lang' });
  out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: process.env.FAKE_CODEX_REPLY || 'Travail fait : la suite passe et le commit est prêt pour la relecture du chef.' } });
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
  process.exit(0);
});
`);
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, CODEX_BIN: CODEX, FAKE_CLAUDE_DUMP_PROMPT: DUMP, FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'ORCH_TEST_LABEL', 'FAKE_CLAUDE_REPLY', 'FAKE_CLAUDE_TRANSLATION']) delete baseEnv[k];
const dispatch = (args, env = {}) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 180_000, windowsHide: true }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }; };
const prompts = () => { try { return fs.readFileSync(DUMP, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const FR_RULE = /LANGUE \(réglage de l’utilisateur.*la langue de discussion est le FRANÇAIS.*le code, les commentaires de code, les messages de commit et la documentation technique .* sont en anglais/s;
const EN_ONLY = /LANGUAGE: write everything addressed to the user or to the conductor in ENGLISH.*translate it automatically into French/s;
const run = (label, args, env, want = FR_RULE) => {
  const n0 = prompts().length;
  const r = dispatch(args, env);
  const ps = prompts().slice(n0);
  ok(r.code === 0 && ps.length > 0 && ps.every(p => want.test(p.prompt)), `${label} : consigne présente dans ${ps.length} prompt(s)`, `code ${r.code} ${r.out.slice(-300)} ${ps.map(p => p.prompt.slice(-200)).join(' | ')}`);
  return ps;
};
run('musicien (claude)', ['P', 'Corrige la typo du titre']);
ok(logOf('P').filter(e => e.type === 'user_prompt').pop()?.lang?.target === 'fr', 'user_prompt.lang : cible tracée');
run('chef', ['chef', 'Fais le point sur la flotte']);
run('slot du chef (pool)', ['chef', 'Ticket du pool', '--pool-assign'], { DISPATCH_SLOT: '2', DISPATCH_TICKET: 't-1' });
run('étapes de pipeline (Discussion, 3 étapes)', ['P', 'Pourquoi la suite passe-t-elle ?', '--pipeline', 'discussion']);
const dual = run('mode double (2 branches + relecture)', ['P', 'Ajoute un commentaire', '--model', 'claude-opus-5-5', '--second-model', 'claude-sonnet-5-5']);
ok(dual.length === 3, `mode double : ${dual.length} tours, tous avec la consigne`);
run('codex (OpenAI)', ['P', 'Corrige la typo', '--provider', 'codex', '--model', 'gpt-5.6-luna']);
const nv = run('NVIDIA, model « anglais seulement »', ['P', 'Corrige la typo', '--provider', 'nvidia', '--model', 'nvidia/nemotron-mini-4b'], {}, EN_ONLY);
ok(logOf('P').filter(e => e.type === 'user_prompt').pop()?.lang?.working === 'en', 'model anglais seulement : langue de travail « en » tracée');
L.setProjectLanguage(T, 'Q', 'en');
run('override de projet (anglais)', ['Q', 'Fix the title typo'], {}, /LANGUAGE \(user setting.*the discussion language is ENGLISH/s);
L.setProjectLanguage(T, 'Q', null);
void nv;

// ---------------------------------------------------------------------------
section('5. Portier : réponse dans la mauvaise langue → badge + reformulation, original consultable');
let n0 = logOf('P').length;
let r = dispatch(['P', 'Fais le point'], { FAKE_CLAUDE_REPLY: EN });
let evs = logOf('P').slice(n0);
const mm = evs.find(e => e.subtype === 'language_mismatch');
const syn = evs.find(e => e.type === 'assistant' && e.lang?.reformulated);
const res = evs.filter(e => e.type === 'result').pop();
ok(r.code === 0 && mm?.lang?.detected === 'en' && mm.lang.target === 'fr' && mm.lang.reformulated, 'écart détecté et journalisé (language_mismatch)');
ok(syn && syn.lang.original === EN && /^Réponse reformulée en français/.test(syn.message.content[0].text), 'version reformulée publiée, l’original reste consultable');
ok(res?.lang?.reformulated && /^Réponse reformulée en français/.test(res.result) && !res.lang.original, 'le result porte le texte reformulé (et le badge), le pump et le chef verront la bonne langue');
ok(evs.indexOf(syn) < evs.indexOf(res) && deriveState(logOf('P').map(e => JSON.stringify(e))).state === 'unread', 'ordre correct, état du musicien intact');
const J = createJournal(); for (const e of logOf('P')) J.push(e);
const jt = J.list()[0];
ok(jt.lang?.detected === 'en' && jt.lang.original?.text === EN && /reformulée/.test(jt.resultFull?.text || ''), 'journal : badge et original');
n0 = logOf('P').length;
dispatch(['P', 'Fais le point'], { FAKE_CLAUDE_REPLY: FR });
ok(!logOf('P').slice(n0).some(e => e.subtype === 'language_mismatch'), 'réponse déjà en français : rien à faire');
n0 = logOf('P').length;
dispatch(['P', 'Fais le point'], { FAKE_CLAUDE_REPLY: `${EN}\n\nNEEDS_USER_INPUT: Should I push now to the main branch of the repository?`,
  FAKE_CLAUDE_TRANSLATION: `${FR}\n\nNEEDS_USER_INPUT: Faut-il pousser maintenant sur la branche principale du dépôt ?` });
const st = deriveState(logOf('P').map(e => JSON.stringify(e)));
ok(st.state === 'input' && /Faut-il pousser maintenant/.test(st.lastAssistantText), 'question reformulée : la question affichée est en français (état input)');
n0 = logOf('P').length;
dispatch(['P', 'Fais le point'], { FAKE_CLAUDE_REPLY: EN, FAKE_CLAUDE_TRANSLATION: EN });
evs = logOf('P').slice(n0);
ok(evs.some(e => e.subtype === 'language_mismatch' && e.lang.reformulated === false) && evs.filter(e => e.type === 'result').pop()?.result === EN, 'reformulation ratée : badge quand même, texte d’origine conservé (jamais bloquant)');
n0 = logOf('chef').length;
dispatch(['chef', 'Fais le point'], { FAKE_CLAUDE_REPLY: EN });
ok(logOf('chef').slice(n0).some(e => e.subtype === 'language_mismatch' && e.lang.detected === 'en'), 'tour du chef dans la mauvaise langue : signalé dans son journal');
n0 = logOf('P').length;
dispatch(['P', 'Pourquoi la suite passe-t-elle ?', '--pipeline', 'discussion'], { FAKE_PIPE_LANG: 'en' });
evs = logOf('P').slice(n0);
ok(evs.some(e => e.subtype === 'language_mismatch') && /reformulée en français/.test(evs.filter(e => e.type === 'result').pop()?.result || ''), 'moteur de pipeline : réponse finale en anglais reformulée');
ok(!fs.readdirSync(path.join(T, 'logs', 'dual')).some(d => { try { return fs.readdirSync(path.join(T, 'logs', 'dual', d)).some(f => f.endsWith('.jsonl') && fs.readFileSync(path.join(T, 'logs', 'dual', d, f), 'utf8').includes('language_mismatch')); } catch { return false; } }), 'branches du mode double non contrôlées (seule la relecture est destinée à l’utilisateur)');
const s0 = JSON.parse(fs.readFileSync(path.join(T, L.SETTINGS_FILE), 'utf8')); s0.check = false; fs.writeFileSync(path.join(T, L.SETTINGS_FILE), JSON.stringify(s0));
n0 = logOf('P').length;
dispatch(['P', 'Fais le point'], { FAKE_CLAUDE_REPLY: EN });
ok(!logOf('P').slice(n0).some(e => e.subtype === 'language_mismatch'), 'contrôle désactivable (check: false)');
s0.check = true; fs.writeFileSync(path.join(T, L.SETTINGS_FILE), JSON.stringify(s0));

// ---------------------------------------------------------------------------
section('6. Model « anglais seulement » : consigne en anglais, sortie reformulée dans la langue de discussion');
n0 = logOf('P').length;
r = dispatch(['P', 'Corrige la typo', '--provider', 'nvidia', '--model', 'nvidia/nemotron-mini-4b'], { FAKE_CODEX_REPLY: EN });
evs = logOf('P').slice(n0);
const mm6 = evs.find(e => e.subtype === 'language_mismatch');
ok(r.code === 0 && mm6?.lang?.reason === 'model-language' && /travaille en anglais/.test(mm6.text), `reformulation « langue du model » indiquée dans le journal (« ${mm6?.text} »)`, r.out.slice(-400));
ok(/reformulée en français/.test(evs.filter(e => e.type === 'result').pop()?.result || ''), 'le résultat destiné à l’utilisateur est en français');

// ---------------------------------------------------------------------------
section('7. « Tester la langue » : un court essai, jugé par la détection, enregistré');
let t7 = await L.testModelLanguage(T, { provider: 'anthropic', model: 'claude-test-1', lang: 'fr', env: { ...baseEnv, FAKE_CLAUDE_REPLY: FR } });
ok(t7.ok && t7.detected === 'fr' && R('claude-test-1').source === 'override' && R('claude-test-1').test?.ok, 'réponse en français : essai réussi, langue enregistrée');
t7 = await L.testModelLanguage(T, { provider: 'anthropic', model: 'claude-test-1', lang: 'fr', env: { ...baseEnv, FAKE_CLAUDE_REPLY: EN } });
ok(!t7.ok && t7.detected === 'en' && !R('claude-test-1').langs.includes('fr'), 'réponse en anglais : essai raté, langue retirée');
const up = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: FR } }] })); }); });
await new Promise(rr => up.listen(0, '127.0.0.1', rr));
t7 = await L.testModelLanguage(T, { provider: 'openrouter', model: 'vendor/small-1', lang: 'fr', keys: () => 'fixture-fixture-fixture', env: { ...baseEnv, ORCH_OPENROUTER_BASE_URL: `http://127.0.0.1:${up.address().port}` } });
ok(t7.ok && R('vendor/small-1').langs.includes('fr'), 'OpenRouter (faux fournisseur) : essai réussi et enregistré');
t7 = await L.testModelLanguage(T, { provider: 'nvidia', model: 'nvidia/x', lang: 'fr', keys: () => null });
ok(!t7.ok && /clé NVIDIA absente/.test(t7.why), 'sans clé : refus explicite, rien d’enregistré');
up.close();

// ---------------------------------------------------------------------------
section('8. Messages produits par l’orchestrateur dans la langue choisie');
ok(await L.localize(T, 'Le travail est en pause.', 'fr') === 'Le travail est en pause.', 'français : aucun appel');
const loc = await L.localize(T, 'Le travail est en pause, votre décision est attendue pour la suite du projet.', 'en', { reformulator: async (_r, t, lang) => ({ ok: true, text: `[${lang}] work is paused` }) });
ok(loc === '[en] work is paused', 'autre langue : le message est reformulé');

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
