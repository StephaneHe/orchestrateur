#!/usr/bin/env node
// ============================================================================
// scripts/_test_design.mjs — the « Design » pipeline (0.146.0)
// ============================================================================
//
// User agreement (2026-10-24): « ok » to the chef's proposal of a « Design »
// pipeline, after « l'ui de [projet] est vraiment moche. quel model la fait »
// and « faut-il un pipeline dédié ? » — the Development checks that the code
// works, but nobody ever looked at the rendered screen.
//
// Protected, with the real dispatch.mjs and engine, a fake claude (never the
// network, never 7777) and a disposable git project:
//   - capture of the REAL screens: a real headless Edge on a static page
//     (mobile 390×844, desktop 1280×800), and a project's own capture command;
//   - the critique and the correction SEE the captures (images joined to the
//     model's message), each screen judged, P1/P2/P3, the critic's stop
//     criterion consistent with its problems (checked by the code);
//   - the loop: correct → recapture → recritique while a P1/P2 remains, at most
//     design.maxRounds (3 to 5) rounds, then a pause — anti-loop;
//   - the independent second opinion (previous critiques hidden), whose P1/P2
//     send the run back to a correction;
//   - guardrails: no external resource added without saying so, tests never
//     changed, the project's suite green, captures before/after kept outside
//     the repository and cited in the report, one delivery commit, no push;
//   - switch `design`: off = before (refused, not offered, no prefix);
//     Models page: Design tab, cases design.critiquer / corriger / second-avis
//     needing vision.
//
//   node scripts/_test_design.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';
import * as D from './design.mjs';
import { PIPELINES, slotsOf, JUDGE_STEPS } from './model-pipelines.mjs';
import { explicitChoice } from './pipeline-observe.mjs';
import { classifierChoices, DESIGN_RULE } from './pipeline-classify.mjs';
import { LEVER_IDS } from './pipeline-tuning.mjs';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';
import { pngBuffer, CAPTURE_SCRIPT } from '../tests/design-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 1500)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-design-'));

// ---------------------------------------------------------------------------
section('1. Briques pures : déclaration, critique, ressources externes, images jointes');
const mk = (rel, s) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
mk('s1/site/index.html', '<!doctype html><title>a</title><p>a</p>');
mk('s1/site/aide.html', '<!doctype html><p>b</p>');
let dc = D.designConfig(path.join(T, 's1'), {});
ok(dc.ok && dc.mode === 'static' && dc.defaulted && dc.screens.map(s => `${s.id}=${s.file}`).join() === 'accueil=site/index.html,aide=site/aide.html', 'sans déclaration : la page index.html statique du projet et ses pages sœurs', dc);
ok(dc.viewports.join() === 'mobile,bureau' && D.VIEWPORTS.mobile.width === 390 && D.VIEWPORTS.mobile.height === 844 && D.VIEWPORTS.bureau.width === 1280 && D.VIEWPORTS.bureau.height === 800, 'deux vues : mobile 390×844 et bureau 1280×800');
ok(!D.designConfig(path.join(T, 'vide-' + Date.now()), {}).ok && /design/.test(D.designConfig(path.join(T, 'vide'), {}).why), 'rien à capturer : la raison dit quoi déclarer (design.capture, design.start + screens)');
ok(!D.designConfig(T, { design: { capture: 'node x.mjs' } }).ok && D.designConfig(T, { design: { capture: 'node x.mjs {out}' } }).mode === 'command', 'design.capture : une commande du projet qui écrit ses captures dans {out}');
ok(!D.designConfig(T, { design: { start: 'npm start' } }).ok && D.designConfig(T, { design: { start: { command: 'npm start' }, screens: [{ id: 'accueil', path: '/', actions: [{ click: '#ok' }] }] } }).mode === 'serve', 'design.start exige design.screens');
ok(/action inconnue/.test(D.designConfig(T, { design: { start: 'npm start', screens: [{ id: 'a', path: '/', actions: [{ rm: '-rf' }] }] } }).why || ''), 'actions d’écran : liste fermée');
ok([D.maxRounds({}), D.maxRounds({ design: { maxRounds: 1 } }), D.maxRounds({ design: { maxRounds: 9 } }), D.maxRounds({ design: { maxRounds: 3 } })].join() === '4,3,5,3', 'tours de correction : 4 par défaut, bornés de 3 à 5');
const SH = [{ id: 'mobile/accueil', width: 390, height: 844 }, { id: 'bureau/accueil', width: 1280, height: 800 }];
const crit = (o = {}) => ({ ecrans: SH.map(s => ({ ecran: s.id, problemes: [] })), critere_arret: 'plus aucun P1 ni P2', arret: true, ...o });
ok(D.checkCritique(crit(), { shots: SH, attachedIds: SH.map(s => s.id) }).ok, 'critique valide : chaque écran, critère d’arrêt, arret cohérent');
let cc = D.checkCritique(crit({ ecrans: [{ ecran: 'mobile/accueil', problemes: [{ gravite: 'P1', probleme: 'tout colle au bord' }, { gravite: 'P3', probleme: 'ombre trop forte' }] }, { ecran: 'bureau/accueil', problemes: [] }], arret: false }), { shots: SH, attachedIds: SH.map(s => s.id) });
ok(cc.ok && cc.importants.length === 1 && /P1/.test(cc.importants[0]) && cc.counts.P3 === 1, 'les problèmes importants (P1, P2) sont calculés par le code', cc);
ok(/non critiqué/.test(D.checkCritique(crit({ ecrans: [{ ecran: 'mobile/accueil', problemes: [] }] }), { shots: SH }).why), 'un écran sans critique : refusé');
ok(/P1, P2 ou P3/.test(D.checkCritique(crit({ ecrans: SH.map(s => ({ ecran: s.id, problemes: [{ gravite: 'grave', probleme: 'trop serré partout' }] })) }), { shots: SH }).why), 'gravité hors P1/P2/P3 : refusée');
ok(/arret.*true alors que/.test(D.checkCritique(crit({ ecrans: SH.map(s => ({ ecran: s.id, problemes: [{ gravite: 'P2', probleme: 'contraste trop faible' }] })) }), { shots: SH }).why), '« arret » vrai avec un P2 restant : refusé (critère d’arrêt incohérent)');
ok(/critere_arret/.test(D.checkCritique(crit({ critere_arret: '' }), { shots: SH }).why), 'critère d’arrêt absent : refusé');
const SH3 = [...SH, { id: 'mobile/long', relPath: 'x/mobile/long.png', width: 390, height: 2400 }];
const crit3 = crit({ ecrans: SH3.map(s => ({ ecran: s.id, problemes: [] })) });
ok(/non regardée/.test(D.checkCritique(crit3, { shots: SH3, attachedIds: SH.map(s => s.id), readInTurn: [] }).why || '') && D.checkCritique(crit3, { shots: SH3, attachedIds: SH.map(s => s.id), readInTurn: [String.raw`I:\P\x\mobile\long.png`] }).ok, 'une capture non jointe doit avoir été ouverte avec Read dans le tour');
const many = Array.from({ length: 23 }, (_, i) => ({ id: `s${i}`, width: 390, height: i === 1 ? 2500 : 844 }));
const plan = D.attachPlan(many);
ok(plan.attach.length === D.MAX_ATTACH && plan.read.length === 3 && plan.read.some(s => s.id === 's1'), `au plus ${D.MAX_ATTACH} images jointes, aucune au-delà de ${D.MAX_EDGE} px ; le reste à ouvrir avec Read`);
const both = [...Array.from({ length: 20 }, (_, i) => ({ id: `bureau/${i}`, viewport: 'bureau', width: 1280, height: 800 })), ...Array.from({ length: 20 }, (_, i) => ({ id: `mobile/${i}`, viewport: 'mobile', width: 390, height: 844 }))];
const p2 = D.attachPlan(both);
ok(p2.attach[0].viewport === 'mobile' && p2.attach.filter(s => s.viewport === 'mobile').length === 10 && p2.attach.filter(s => s.viewport === 'bureau').length === 10, 'images jointes : mobile et bureau en alternance, mobile d’abord (rejeu réel : les 20 premières par nom étaient toutes « bureau »)');
const refs = D.newExternalRefs(['site/style.css', 'site/index.html', 'src/a.png'], {
  before: (f) => (f === 'site/index.html' ? '<script src="https://cdn.example.com/a.js"></script>' : ''),
  after: (f) => (f === 'site/style.css' ? '@import url("https://fonts.example.com/inter.css");\nbody{background:url(/local.png)}' : '<script src="https://cdn.example.com/a.js"></script><link href="//cdn2.example.org/x.css">'),
});
ok(refs.map(r => r.url).join() === '//fonts.example.com/inter.css,//cdn2.example.org/x.css', 'ressources externes NOUVELLES relevées (police, feuille) ; locales et déjà présentes ignorées', refs);
ok(!D.checkExternalDeclared('## Corrections\n- x\n\n## Ressources externes\naucune\n', refs).ok && D.checkExternalDeclared('## Ressources externes\n- fonts.example.com : police\n- cdn2.example.org : grille\n', refs).ok, 'une ressource externe ajoutée doit être déclarée dans « ## Ressources externes »');
ok(!D.checkExternalDeclared('## Corrections\n', []).ok, 'la section « ## Ressources externes » est exigée (« aucune » si rien)');
ok(D.familyOf('claude-opus-5-5') === 'anthropic' && D.familyOf('gpt-6-astra') === 'openai', 'familles de models (second avis d’une autre famille)');

section('2. Page Models, plan, interrupteur, classement, préfixe');
const pdef = PIPELINES.find(p => p.id === 'design');
ok(pdef && PIPELINES.map(p => p.id).slice(-3).join() === 'exploitation,design,kg', 'page Models : onglet Design, après Exploitation');
const dslots = slotsOf().filter(s => s.pipeline === 'design');
ok(['design.critiquer', 'design.corriger', 'design.second-avis'].every(id => dslots.some(s => s.id === id && s.need.llm === 'vision')), 'cases design.critiquer, design.corriger, design.second-avis : vision exigée', dslots);
ok(!dslots.some(s => /capturer|verifier/.test(s.id)) && JUDGE_STEPS.has('design.critiquer') && JUDGE_STEPS.has('design.second-avis'), 'capturer et vérifier : par le programme (sans case) ; critique et second avis : jugement');
ok(E.ENGINE_PIPELINES.includes('design') && E.planSteps('design').map(s => s.id).join() === 'capturer,critiquer,second-avis,verifier,livrer', 'moteur : Capturer → Critiquer → Second avis → Vérifier → Livrer (Corriger entre par la boucle)');
ok(LEVER_IDS.includes('design') && explicitChoice({ text: '/design refais le style' }).pipeline === null && explicitChoice({ text: '/design refais le style', design: true }).pipeline === 'design', 'préfixe /design : reconnu seulement avec l’interrupteur design');
ok(E.pipelineServed({ pipelines: ['dev'] }, 'design'), 'classé en Design = en service sur tout projet en service (proposé seulement avec l’interrupteur)');
ok(/ugly|unprofessional/.test(DESIGN_RULE) && /never dev/.test(DESIGN_RULE) && /→ dev, never design/.test(DESIGN_RULE), 'règle de sens pour le classement : « moche / refais le style / présentation / UI » → design ; comportement → dev');

section('3. Capture réelle : Edge headless, page statique, mobile et bureau');
mk('s2/site/index.html', '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>t</title></head><body><h1>Accueil</h1><button>Commencer</button></body></html>');
const cap = await D.captureScreens({ cwd: path.join(T, 's2'), cfg: {}, outDir: path.join(T, 's2-out') });
ok(cap.ok && cap.shots.length === 2 && cap.shots.find(s => s.id === 'mobile/accueil')?.width === 390 && cap.shots.find(s => s.id === 'bureau/accueil')?.width === 1280, `captures PNG réelles (${(cap.shots || []).map(s => `${s.id} ${s.width}×${s.height}`).join(', ') || cap.why})`, cap);
ok(cap.ok && cap.shots.every(s => fs.statSync(s.file).size > 500), 'images non vides');

// ---------------------------------------------------------------------------
// Disposable root: a git project P with an interface, a test suite, a capture
// command of its own (no browser needed) and a version.
// ---------------------------------------------------------------------------
fs.mkdirSync(path.join(T, 'logs'));
fs.mkdirSync(path.join(T, 'chef'));
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const P = path.join(T, 'P');
const PIPE_CFG = (design = {}) => ({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', design: { capture: 'node scripts/capture.mjs {out}', ...design } });
function repo(design) {
  fs.rmSync(P, { recursive: true, force: true });
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(P, rel)), { recursive: true }); fs.writeFileSync(path.join(P, rel), s); };
  w('package.json', JSON.stringify({ name: 'P', version: '1.18.0', type: 'module' }, null, 2) + '\n');
  w('CHANGELOG.md', '# Changelog\n\n## [1.18.0] - 2026-10-23\n\n### Added\n\n- questions\n');
  w('site/index.html', '<!doctype html><link rel="stylesheet" href="style.css"><main><h1>Accueil</h1></main>\n');
  w('site/style.css', 'body { margin: 8px; }\n');
  w('scripts/capture.mjs', CAPTURE_SCRIPT);
  w('test/page.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport fs from 'node:fs';\ntest('accueil', () => assert.match(fs.readFileSync('site/index.html', 'utf8'), /Accueil/));\n");
  w('.orchestrateur/pipeline.json', JSON.stringify(PIPE_CFG(design), null, 2) + '\n');
  g(P, 'init', '-q', '-b', 'main'); g(P, 'add', '-A'); g(P, 'commit', '-q', '-m', 'init');
}
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
// enforcement.pipelines WITHOUT design: classified there, it is in service all the same (its switch).
const LISTED = E.ENGINE_PIPELINES.filter(p => p !== 'design');
const routing = (tuning = { design: true }) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['P'], pipelines: LISTED, tuning },
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'design.critiquer': { provider: 'anthropic', model: 'claude-opus-5-5' },
    'design.corriger': { provider: 'anthropic', model: 'claude-opus-5-5' }, 'design.second-avis': { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
}, null, 2));
routing();
const DLOG = path.join(T, 'design.ndjson');
const DSTATE = path.join(T, 'design-state.json');
const DUMP = path.join(T, 'dump.ndjson');
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', FAKE_DESIGN_LOG: DLOG, FAKE_DESIGN_STATE: DSTATE };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'CODEX_HOME',
  'FAKE_PIPE_JSON', 'FAKE_PIPE_BAD', 'FAKE_PIPE_NOTHING', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CHOICE', 'FAKE_CLAUDE_DUMP_PROMPT', 'ORCH_REQUEST_ID', 'FAKE_DESIGN_IMPORTANT', 'FAKE_DESIGN_SECOND', 'FAKE_DESIGN_BAD', 'FAKE_DESIGN_CDN', 'FAKE_DESIGN_FILE', 'FAKE_DESIGN_READ', 'FIXTURE_CAPTURE_MANY', 'FIXTURE_CAPTURE_FAIL']) delete baseEnv[k];
const logOf = () => { try { return fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(T, 'logs', 'runs', run, 'run.json'), 'utf8'));
const dlog = () => (fs.existsSync(DLOG) ? fs.readFileSync(DLOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
function play(args, env = {}) {
  for (const f of [DLOG, DSTATE]) fs.rmSync(f, { force: true });
  const n0 = logOf().length;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 300_000, windowsHide: true });
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline?.run)?.pipeline.run;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs, run, st: run ? runState(run) : null, result: evs.filter(e => e.type === 'result').pop()?.result || '' };
}
const head = () => g(P, 'rev-parse', 'HEAD').stdout.trim();
const clean = () => !g(P, 'status', '--porcelain').stdout.split('\n').filter(l => l && !l.slice(3).startsWith('.orchestrateur/runs')).length;
const steps = (x) => (x.st?.steps || []).map(s => s.id);
const CLASSIFY_DESIGN = JSON.stringify({ pipeline: 'design', mode: 'complet', raison: 'interface jugée moche : passe visuelle' });
const UGLY = 'L’interface est vraiment moche : vide, pas pro. Refais la présentation (mise en page, typographie, boutons), sans toucher au comportement.';

// ---------------------------------------------------------------------------
section('4. Cas réel rejoué : interface « moche » — critique, une correction, recritique, second avis, livraison');
repo();
let h0 = head();
let x = play([UGLY, '--test', 'design : passe visuelle'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FAKE_DESIGN_IMPORTANT: '2,0', FAKE_DESIGN_SECOND: '0' });
ok(x.code === 0 && x.st?.status === 'done' && x.st.pipeline === 'design', `exécution « design » terminée (code ${x.code}, ${x.st?.status})`, x.out.slice(-2500));
ok(steps(x).join() === 'capturer,critiquer,corriger,capturer,critiquer,second-avis,verifier,livrer', `étapes : ${steps(x).join(' → ')}`);
const dl = dlog();
const crits = dl.filter(d => d.step === 'critiquer');
ok(crits.length === 2 && crits.every(d => d.images === 4 && d.ecrans.length === 4), `la critique VOIT les 4 captures (images jointes au message) à chaque tour : ${crits.map(d => d.images).join(', ')}`, dl);
ok(dl.some(d => d.step === 'corriger' && d.images === 4) && dl.some(d => d.step === 'second-avis' && d.images === 4), 'la correction et le second avis reçoivent aussi les captures');
ok(x.st.designCaptures?.map(c => c.label).join() === 'avant,tour-1' && x.st.designCritiques?.map(c => `${c.counts.P1}`).join() === '2,0', 'captures avant puis tour-1 ; P1 : 2 puis 0', x.st.designCaptures);
const kept = x.st.designKept || {};
ok(kept.avant && kept.apres && fs.existsSync(path.join(T, kept.avant, 'mobile', 'accueil.png')) && fs.existsSync(path.join(T, kept.apres, 'bureau', 'question.png')) && kept.avant.startsWith('logs/runs/'), `captures avant/après gardées HORS dépôt (${kept.avant}, ${kept.apres})`);
ok(new RegExp(kept.avant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(x.result) && /Tours de correction : 1/.test(x.result) && /critère d’arrêt du critique : « plus aucun P1 ni P2 »/.test(x.result) && /vert/.test(x.result), 'compte rendu : captures avant/après citées, tours, critère d’arrêt, tests verts', x.result.slice(0, 2500));
ok(JSON.parse(fs.readFileSync(path.join(P, 'package.json'), 'utf8')).version !== '1.18.0' && g(P, 'rev-list', '--count', `${h0}..HEAD`).stdout.trim() === '1' && clean(), 'livraison : version + CHANGELOG + un commit ; arbre propre ; pas de push');
ok(/max-width/.test(fs.readFileSync(path.join(P, 'site', 'style.css'), 'utf8')) && !g(P, 'ls-files', '.orchestrateur/runs').stdout.trim(), 'la correction d’affichage est livrée ; les captures ne sont pas commitées');
ok(x.evs.some(e => e.subtype === 'pipeline_design_capture') && x.evs.some(e => e.subtype === 'pipeline_design_critique') && x.evs.some(e => e.subtype === 'pipeline_loop' && /P1\/P2/.test(e.text)), 'journal : captures, critiques, boucle dite');
ok(!x.evs.some(e => e.subtype === 'pipeline_defect'), 'les problèmes d’une critique sont la liste de travail du tour suivant, pas des défauts de livraison');

section('5. Anti-boucle : un P1 qui ne part jamais → au plus design.maxRounds tours, puis une pause');
repo({ maxRounds: 3 });
h0 = head();
x = play([UGLY, '--test', 'design : anti-boucle'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FAKE_DESIGN_IMPORTANT: '1' });
ok(x.code === 2 && x.st?.status === 'paused' && x.st.pausedLimit === 'review', `pause « review » (code ${x.code}, ${x.st?.pausedLimit})`, x.out.slice(-2000));
ok(steps(x).filter(s => s === 'corriger').length === 3 && steps(x).filter(s => s === 'critiquer').length === 4, `3 tours de correction exactement, puis arrêt (${steps(x).join(',')})`);
ok(/3 tour\(s\) de correction \(maximum 3\)/.test(x.st.steps.length ? JSON.stringify(x.st) + x.result : '') || /maximum 3/.test(x.result), 'la pause dit le nombre de tours et le maximum', x.result.slice(0, 1500));
ok(fs.existsSync(path.join(P, '.orchestrateur', 'runs', x.run, 'a-corriger.json')) && head() === h0, 'a-corriger.json écrit par l’orchestrateur ; rien de livré');

section('6. Second avis indépendant : ses P1/P2 relancent une correction ; critiques précédentes cachées');
repo();
fs.rmSync(DUMP, { force: true });
x = play([UGLY, '--test', 'design : second avis'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FAKE_DESIGN_IMPORTANT: '0', FAKE_DESIGN_SECOND: '1,0', FAKE_CLAUDE_DUMP_PROMPT: DUMP });
ok(x.st?.status === 'done' && steps(x).join() === 'capturer,critiquer,second-avis,corriger,capturer,second-avis,verifier,livrer', `second avis → correction → second avis (${steps(x).join(' → ')})`, x.out.slice(-1500));
const sec = (fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8').trim().split('\n') : []).map(l => JSON.parse(l)).filter(p => /^PIPELINE_STEP=second-avis/m.test(p.prompt));
ok(sec.length === 2 && sec.every(p => /Indépendance : critique\.json, a-corriger\.json, corrections\.md n'est pas disponible/.test(p.prompt)), 'indépendance : les critiques précédentes sont retirées pendant le second avis');
ok(x.st.designSecond?.counts?.P1 === 0 && /Second avis indépendant/.test(x.result), 'le compte rendu donne le second avis final');
ok(/même famille de model/.test(x.result), 'même famille pour la critique et le second avis : dit (la case design.second-avis devrait être d’une autre famille)');

section('7. Garde-fous de la correction : ressource externe non déclarée, tests modifiés');
repo();
x = play([UGLY, '--test', 'design : CDN non déclaré'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FAKE_DESIGN_IMPORTANT: '1,0', FAKE_DESIGN_CDN: '1' });
const refused = (x.st?.steps || []).filter(s => s.id === 'corriger' && s.status === 'refused');
ok(refused.length && /ressource\(s\) externe\(s\) ajoutée\(s\) sans le dire.*fonts\.example\.com/.test(refused[0].why) && !/fonts\.example\.com/.test(fs.readFileSync(path.join(P, 'site', 'style.css'), 'utf8')), 'police d’un CDN ajoutée sans le dire : correction refusée et annulée', refused[0]?.why);
repo();
x = play([UGLY, '--test', 'design : CDN déclaré'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FAKE_DESIGN_IMPORTANT: '1,0', FAKE_DESIGN_CDN: 'declared' });
ok(x.st?.status === 'done' && /fonts\.example\.com/.test(fs.readFileSync(path.join(P, 'site', 'style.css'), 'utf8')), 'déclarée dans « ## Ressources externes » : acceptée', x.out.slice(-1200));
repo();
x = play([UGLY, '--test', 'design : test modifié'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FAKE_DESIGN_IMPORTANT: '1,0', FAKE_DESIGN_FILE: 'test/page.test.mjs' });
ok((x.st?.steps || []).some(s => s.id === 'corriger' && s.status === 'refused' && /fichiers de test modifiés/.test(s.why)), 'un test modifié par la correction : refusé (aucun test par détail de style)');

section('8. Critique incomplète refusée puis refaite ; capture impossible = pause qui dit quoi faire');
repo();
x = play([UGLY, '--test', 'design : critique incomplète'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FAKE_DESIGN_IMPORTANT: '0', FAKE_DESIGN_BAD: 'missing' });
const c1 = (x.st?.steps || []).filter(s => s.id === 'critiquer');
ok(x.st?.status === 'done' && c1.length === 2 && c1[0].status === 'refused' && /non critiqué/.test(c1[0].why), 'un écran oublié par la critique : refusé, puis refait', c1);
repo();
x = play([UGLY, '--test', 'design : arret incohérent'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FAKE_DESIGN_IMPORTANT: '1,0', FAKE_DESIGN_BAD: 'arret' });
ok((x.st?.steps || []).some(s => s.id === 'critiquer' && s.status === 'refused' && /« arret » vaut true alors que/.test(s.why)), 'critère d’arrêt incohérent (arrêt annoncé avec un P1) : refusé');
repo();
x = play([UGLY, '--test', 'design : capture impossible'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FIXTURE_CAPTURE_FAIL: '1' });
ok(x.code === 2 && x.st?.status === 'paused' && x.st.pausedLimit === 'operation' && /capture (les|des) écrans/.test(x.result) && /Chrome introuvable/.test(x.result), `capture impossible : pause qui nomme la cause (${x.st?.pausedLimit})`, x.result.slice(0, 1200));
const runCap = x.run;
x = play(['relancer l’opération', '--pipeline-resume', runCap, '--test', 'design : reprise'], { FAKE_DESIGN_IMPORTANT: '0' });
ok(x.st?.status === 'done' && x.st.designCaptures?.length === 1, `cause corrigée puis « relancer l’opération » : capture refaite, exécution terminée (${x.st?.status})`, x.out.slice(-1500));
ok(/Aucune correction/.test(x.result) && !/Tests du projet : `/.test(x.result), 'rien à corriger : ni correction, ni tests relancés, ni commit (dit)');

section('8b. Plus de captures que d’images jointes : chacune ouverte avec Read, les essais d’une même étape comptent ensemble');
repo();
x = play([UGLY, '--test', 'design : captures à lire'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FAKE_DESIGN_IMPORTANT: '0', FIXTURE_CAPTURE_MANY: '12' });
const cr0 = (x.st?.steps || []).filter(s => s.id === 'critiquer');
ok(x.st?.status === 'paused' && cr0.every(s => s.status === 'refused' && /non regardée/.test(s.why)), `24 captures, 20 jointes, aucune des 4 autres ouverte : critique refusée (${x.st?.status})`, cr0);
ok(/« corriger le format »/.test(x.result) && /critique de l’étape .* est incomplète/.test(x.result) && !/plus strict que le travail/.test(x.result), 'la pause nomme la cause (critique incomplète) et propose de la refaire, pas seulement « abandonner »', x.result.slice(0, 1200));
const dlm = dlog().filter(d => d.step === 'critiquer');
ok(dlm.length && dlm.every(d => d.images === 20), `20 images jointes au plus (${dlm.map(d => d.images).join(', ')})`);
repo();
x = play([UGLY, '--test', 'design : lectures en deux essais'], { FAKE_CLAUDE_CLASSIFY: CLASSIFY_DESIGN, FAKE_DESIGN_IMPORTANT: '0', FIXTURE_CAPTURE_MANY: '12', FAKE_DESIGN_READ: 'split' });
const cr1 = (x.st?.steps || []).filter(s => s.id === 'critiquer');
ok(x.st?.status === 'done' && cr1.length === 2 && cr1[0].status === 'refused' && cr1[1].status === 'ok', 'moitié ouverte au 1er essai, le reste au 2e (même session) : acceptée (cas du rejeu réel)', cr1);

section('9. Interrupteur coupé = comportement d’avant ; préfixe, classement');
routing({});
repo();
x = play([UGLY, '--pipeline', 'design', '--test', 'interrupteur coupé']);
ok(x.code === 64 && x.evs.some(e => e.type === 'result' && /pipeline « Design » est coupé/.test(e.result || '')), `--pipeline design refusé quand l’interrupteur est coupé (code ${x.code})`, x.out.slice(-800));
fs.rmSync(DUMP, { force: true });
x = play([`/design ${UGLY}`, '--test', 'préfixe coupé'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'leger', raison: 'question' }), FAKE_CLAUDE_DUMP_PROMPT: DUMP });
let cls = (fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8').trim().split('\n') : []).map(l => JSON.parse(l)).filter(p => /^\[CLASSIFY\]/.test(p.prompt));
ok(cls.length && !/- design:/.test(cls.at(-1).prompt) && x.st?.pipeline === 'discussion', 'coupé : préfixe non reconnu, Design non proposé au classement');
ok(!classifierChoices(T, {}).some(p => p.id === 'design') && classifierChoices(T, { design: true }).some(p => p.id === 'design'), 'classifierChoices : Design seulement avec l’interrupteur');
routing();
fs.rmSync(DUMP, { force: true });
x = play([UGLY, '--test', 'classement allumé'], { FAKE_CLAUDE_CLASSIFY: JSON.stringify({ pipeline: 'discussion', mode: 'leger', raison: 'question' }), FAKE_CLAUDE_DUMP_PROMPT: DUMP });
cls = (fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8').trim().split('\n') : []).map(l => JSON.parse(l)).filter(p => /^\[CLASSIFY\]/.test(p.prompt));
ok(cls.length && /- design:/.test(cls.at(-1).prompt) && /design = the VISUAL quality/.test(cls.at(-1).prompt), 'allumé : Design proposé au classement, avec sa règle de sens');
repo();
x = play([`/design ${UGLY}`, '--test', 'préfixe allumé'], { FAKE_DESIGN_IMPORTANT: '0', FAKE_CLAUDE_DUMP_PROMPT: DUMP });
ok(x.st?.pipeline === 'design' && x.st.status === 'done' && x.st.tuning?.design === true, `préfixe /design : choix explicite ; réglage figé dans l’exécution (${x.st?.pipeline}/${x.st?.status})`, x.out.slice(-1200));

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
