#!/usr/bin/env node
// ============================================================================
// scripts/regression.mjs — batterie de NON-RÉGRESSION de tout le dashboard
// ============================================================================
//
// Une seule commande, à rejouer à chaque modification. Code de sortie non nul au
// moindre échec. Trois étages :
//
//   1. SUITES  : toutes les suites node `scripts/_test_*.mjs` de l'état testé
//                (sauf _test_phase2.mjs : code mort, appels Haiku réels).
//   2. HTTP    : une INSTANCE DE TEST isolée (scripts/_regression_sandbox.mjs :
//                autre port, flotte de fixtures, faux `claude`, jamais 7777)
//                et un parcours de chaque route : token gate, version, config,
//                pupitre, files, questions, lecture, parcage, notify, SSE,
//                pièces jointes, /downloads à chaud, WS, callback + réveil du
//                chef, drapeau de la vue Projets.
//   3. NAVIGATEUR : Edge piloté par Playwright sur la même instance : fil du
//                chef et saisie, rail, bande d'attention, « Marquer comme
//                répondue », volet et onglets, file + Retirer, recherche,
//                briefing, pool, pièce jointe, temps réel, mobile, vue Projets
//                (+ captures), désactivation à chaud.
//
// Usage :
//   node scripts/regression.mjs                      arbre de travail (défaut)
//   node scripts/regression.mjs --ref <tag|sha>      même batterie sur un ancien état
//   node scripts/regression.mjs --dir <chemin>       … sur un dossier (ex. worktree d'un revert)
//   node scripts/regression.mjs --targeted [--since <ref>]  CIBLÉE (développement) : socle + suites/étages
//                                                    qui couvrent les fichiers modifiés ; complète si un fichier
//                                                    n'est couvert par rien. La prod exige la complète (prod-jump.mjs)
//   node scripts/regression.mjs --ref vX.Y.Z --perimeters --prod <dépôt de prod>   PAR PÉRIMÈTRE (avant une mise en prod,
//                                                    0.106.0) : socle + suites/étages des périmètres touchés depuis la version
//                                                    en prod (scripts/regression-perimeters.json) ; complète pour un fichier
//                                                    transverse ou inconnu, ou avec --full. Aussi --since <ref> au lieu de --prod,
//                                                    et sans --ref sur l'état de travail
//   node scripts/regression.mjs --jobs <n>          suites en parallèle (défaut : ORCH_REGRESS_JOBS, sinon 1/4 des cœurs, 1 à 4 ;
//                                                    les suites SERIAL_SUITES de suite-runner.mjs restent seules, à la fin)
//   node scripts/regression.mjs --no-browser         sans navigateur
//   node scripts/regression.mjs --no-suites          sans les suites node
//   node scripts/regression.mjs --shots <dossier>    enregistre les captures
//   node scripts/regression.mjs --restart-check      rejoue restart-orchestrateur.mjs sur l'instance
//   node scripts/regression.mjs --keep               garde l'instance (débogage)
//   node scripts/regression.mjs --port <n>           port fixe de l'instance (jamais 7777, refusé s'il est occupé) :
//                                                    instance de dev durable, ex. --keep --no-suites --no-browser --port 7778
//   node scripts/regression.mjs --out <fichier.json> rapport JSON (défaut .regress/report-<label>.json)
//   node scripts/regression.mjs --no-stale-stop      ne s'arrête pas si le contenu change en cours de route
//                                                    (par défaut, 0.94.0 : arrêt immédiat, rapport `stale`, code 3)
//   node scripts/regression.mjs --compare avant.json apres.json [--md sortie.md]
//
// Jamais dans la prod (0.125.0, règle de l'utilisateur) : refus, code 65, si ce
// dépôt ou --dir est une instance de production (scripts/prod-guard.mjs).
//
// Statuts : OK · KO · NA (fonction absente de l'état testé, ex. la vue Projets
// sur un tag antérieur). Seul KO fait échouer.
// ============================================================================

import { refuseInProd, OWN_ROOT } from './prod-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO, REGRESS_DIR, extractCode, startSandbox, waitUp, serverEnv } from './_regression_sandbox.mjs';
import { snapshotRepo } from './_regression_sandbox.mjs';
import { worktreeTree, readKnownKo, checkReport } from './delivery-gate.mjs';
import { runNode, runSuite } from './suite-runner.mjs';
import { runPool, SERIAL_SUITES, defaultJobs, liveSuites } from './suite-runner.mjs';
import { createStaleWatch, changedPaths, staleMessage, killOwnTree } from './stale-run.mjs';
import { createLiveRun } from './regression-live.mjs';

// 0.125.0, user rule: never a non-regression in production (this checkout or
// --dir), whatever the mode. First statement: nothing is written before it.
refuseInProd({ root: OWN_ROOT });

// Exit code of a run stopped because the tested content changed (0.94.0).
const STALE_EXIT = 3;

// Marqueurs du tour qui lance la recette (0.48.0) : jamais transmis aux suites
// ni à l'instance de test, sinon leurs dispatches passeraient pour ce tour.
for (const k of ['ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN']) delete process.env[k];

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

// ---------------------------------------------------------------------------
// Comparaison de deux rapports
// ---------------------------------------------------------------------------
if (flag('--compare')) {
  const i = argv.indexOf('--compare');
  const [a, b] = [argv[i + 1], argv[i + 2]].map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  const byId = (r) => new Map(r.results.map(x => [x.id, x]));
  const A = byId(a), B = byId(b);
  const ids = [...new Set([...A.keys(), ...B.keys()])];
  const lines = [
    `| Étage | Fonctionnalité | Avant (${a.label}) | Après (${b.label}) | Écart |`,
    '|---|---|---|---|---|',
  ];
  let regressions = 0;
  for (const id of ids) {
    const x = A.get(id), y = B.get(id);
    const sa = x?.status || '—', sb = y?.status || '—';
    // Une ligne absente d'un côté = parcours non exécuté (ex. captures sans --shots), pas une régression.
    const gap = !x || !y ? 'non exécuté d\'un côté'
      : sa === 'OK' && sb !== 'OK' ? '**RÉGRESSION**'
      : sa !== 'OK' && sb === 'OK' ? 'corrigé / nouveau' : '';
    if (gap.startsWith('**')) regressions++;
    lines.push(`| ${(y || x).stage} | ${(y || x).name.replace(/\|/g, '/')} | ${sa} | ${sb} | ${gap} |`);
  }
  const summary = (r) => { const c = { OK: 0, KO: 0, NA: 0 }; for (const x of r.results) c[x.status]++; return `${c.OK} OK · ${c.KO} KO · ${c.NA} NA`; };
  lines.push('', `Avant : ${summary(a)} — Après : ${summary(b)} — Régressions : ${regressions}`);
  // 0.71.3: a KO in the AFTER report blocks too, even if it already existed
  // before (incident n° 8) — unless listed with its reason in docs/known-ko.json.
  const gate = checkReport(b, { knownKo: readKnownKo(REPO) });
  for (const k of gate.accepted) lines.push(`KO accepté (docs/known-ko.json) : ${k.id} — ${k.reason}`);
  for (const r of gate.reasons) lines.push(`**REFUS** : ${r}`);
  lines.push(`Livraison : ${regressions || !gate.ok ? 'REFUSÉE' : 'AUTORISÉE'}`);
  const md = lines.join('\n');
  if (opt('--md')) fs.writeFileSync(opt('--md'), md + '\n');
  console.log(md);
  process.exit(regressions || !gate.ok ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------
const source = opt('--ref') ? { ref: opt('--ref') } : opt('--dir') ? { dir: opt('--dir') } : { worktree: true };
const label = opt('--ref') || (opt('--dir') ? path.basename(path.resolve(opt('--dir'))) : 'worktree');
const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '_');
// Targeted run (0.72.0): only the suites and stages touched by the changed
// files; null = full run. A change covered by nothing falls back to full.
let selection = null;
if (flag('--targeted')) {
  if (!source.worktree) { console.error('--targeted ne vaut que pour l’état de travail (pas avec --ref / --dir)'); process.exit(64); }
  const { changedFiles, selectTargets } = await import('./regression-targets.mjs');
  const since = opt('--since') || 'HEAD';
  const changed = changedFiles(REPO, since);
  const sel = selectTargets(REPO, changed, { since });
  console.log(`\n=== Non-régression CIBLÉE — ${changed.length} fichier(s) modifié(s) depuis ${since}`);
  if (sel.full) console.log(`   → bascule sur la COMPLÈTE : ${sel.reason}`);
  else {
    for (const s of sel.suites) console.log(`   suite ${s.file} — ${s.reasons.slice(0, 3).join(' ; ')}${s.reasons.length > 3 ? ` (+${s.reasons.length - 3})` : ''}`);
    console.log(`   étage HTTP : ${sel.http ? `oui (${sel.reasons.http.slice(0, 4).join(', ')})` : 'non'} · navigateur : ${sel.browser ? `oui (${sel.reasons.browser.slice(0, 4).join(', ')})` : 'non'}`);
    if (sel.docsOnly.length) console.log(`   sans test propre (docs, version) : ${sel.docsOnly.join(', ')}`);
    for (const o of sel.outOfScope || []) console.log(`   ${o.file} — ${o.reason}`);
  }
  selection = { since, changed, ...sel };
}
// Perimeter run (0.106.0): the suites and stages of the perimeters impacted
// since the production version (scripts/regression-perimeters.json), on the
// working tree or on a tag. Full fallback: transverse or unmapped file, --full.
if (flag('--perimeters')) {
  if (selection) { console.error('--perimeters et --targeted sont exclusifs'); process.exit(64); }
  if (opt('--dir')) { console.error('--perimeters vaut pour l’état de travail ou un --ref, pas pour --dir'); process.exit(64); }
  const { perimeterPlan, planLines } = await import('./regression-perimeters.mjs');
  let base = opt('--since');
  if (!base && opt('--prod')) {
    base = (spawnSync('git', ['-C', path.resolve(opt('--prod')), 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim();
    if (!base) { console.error(`--prod : version en prod illisible dans ${opt('--prod')}`); process.exit(64); }
  }
  if (!base && source.ref) { console.error('--perimeters --ref exige --since <version en prod> ou --prod <dépôt de prod>'); process.exit(64); }
  let plan;
  try { plan = perimeterPlan({ repo: REPO, base: base || 'HEAD', target: source.ref || null, full: flag('--full') }); }
  catch (e) { console.error(`[périmètres] ${e.message}`); process.exit(64); }
  console.log(`\n${planLines(plan).join('\n')}`);
  selection = { kind: 'perimeter', since: plan.base, ...plan };
}
const results = [];
// Visible while it runs (0.119.0): progress in .regress/live/, read by the dashboard.
let live = null;
function record(stage, id, name, status, detail = '', extra = null) {
  results.push({ stage, id: `${stage}:${id}`, name, status, detail: String(detail).slice(0, 400), ...(extra || {}) });
  live?.result(stage, status, name);
  const mark = status === 'OK' ? '  ok ' : status === 'NA' ? '  na ' : '  KO ';
  console.log(`${mark} [${stage}] ${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`);
}
/** Exécute `fn`; OK si elle ne lève pas, KO sinon; NA si elle lève NA. */
class NotApplicable extends Error {}
const NA = (why) => { throw new NotApplicable(why); };
async function check(stage, id, name, fn) {
  try { const d = await fn(); record(stage, id, name, 'OK', d || ''); }
  catch (e) { record(stage, id, name, e instanceof NotApplicable ? 'NA' : 'KO', e?.message || String(e)); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, timeoutMs, stepMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch { /* réessaie */ }
    await sleep(stepMs);
  }
  return last;
}

// ---------------------------------------------------------------------------
// 1. Suites node
// ---------------------------------------------------------------------------
// _test_phase2_5_override.mjs is part of the run since 0.74.1 (it covers
// detectOverride, used by /api/dispatch; its telemetry goes to a temp dir).
const EXCLUDED_SUITES = {
  '_test_phase2.mjs': 'code mort (route/decide/classify jamais appelés en production), appels Haiku réels, écrit dans les vrais logs/',
};
// Suites hermétiques non liées au code du serveur : ajoutées à un ancien ref
// qui ne les versionnait pas encore, pour que l'avant/après compare la même liste.
const HERMETIC_OVERLAY = [
  '_test_phase1_crlf.mjs', '_test_phase1_backpressure.mjs', '_test_phase1_close_handler.mjs',
  '_test_phase1_queue_persist.mjs', '_test_phase4b_harness.mjs',
];

// Full output of each failed suite (0.73.0): one file per suite, git-ignored,
// referenced by `output` in the report entry.
const FAILED_OUTPUT_DIR = path.join(REGRESS_DIR, 'suite-output', `${safeLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}`);

async function runSuites() {
  let codeRoot = REPO;
  if (!source.worktree) {
    codeRoot = path.join(REGRESS_DIR, `${safeLabel}-code-${Date.now().toString(36)}`);
    extractCode(source, codeRoot);
    // 0.74.3: its own git repository (exactly the extracted files), before the
    // local-only files below, so git-based suites see the tested state.
    snapshotRepo(codeRoot);
    // Les suites de config valident la VRAIE configuration de la flotte.
    for (const f of ['config.json']) fs.copyFileSync(path.join(REPO, f), path.join(codeRoot, f));
    // _test_pool_chef_dispatch mesure logs/orchestrateur.jsonl (présent dans
    // une archive de tag, où des logs sont versionnés, absent d'un dossier).
    fs.mkdirSync(path.join(codeRoot, 'logs'), { recursive: true });
    const probeLog = path.join(codeRoot, 'logs', 'orchestrateur.jsonl');
    if (!fs.existsSync(probeLog)) fs.writeFileSync(probeLog, '');
    // Jeton propre à cette copie (le vrai .token n'est jamais recopié).
    fs.writeFileSync(path.join(codeRoot, '.token'), (await import('node:crypto')).randomBytes(32).toString('hex'));
    for (const f of HERMETIC_OVERLAY) {
      const to = path.join(codeRoot, 'scripts', f);
      if (!fs.existsSync(to) && fs.existsSync(path.join(REPO, 'scripts', f))) fs.copyFileSync(path.join(REPO, 'scripts', f), to);
    }
  }
  const dir = path.join(codeRoot, 'scripts');
  const suites = fs.readdirSync(dir).filter(f => /^_test_.*\.mjs$/.test(f)).sort();
  // Une suite présente d'un seul côté doit apparaître des deux (NA de l'autre).
  const known = new Set([...suites, ...fs.readdirSync(path.join(REPO, 'scripts')).filter(f => /^_test_.*\.mjs$/.test(f))]);
  const targeted = selection && !selection.full ? new Set(selection.suites.map(s => s.file)) : null;
  // Parallel suites (0.74.0): runPool keeps the alphabetical order of the
  // results and of the console lines; SERIAL_SUITES run alone, afterwards.
  const tasks = [];
  for (const f of [...known].sort()) {
    if (targeted && !targeted.has(f)) continue; // not touched by this change: not run, not reported
    tasks.push({ name: f, run: async () => {
      if (EXCLUDED_SUITES[f]) return { na: `${f} (exclue : ${EXCLUDED_SUITES[f]})` };
      if (!suites.includes(f)) return { na: f, detail: 'absente de cet état du code' };
      return await runSuite(path.join(dir, f), codeRoot, { failedOutputDir: FAILED_OUTPUT_DIR });
    } });
  }
  const jobs = Number(opt('--jobs')) >= 1 ? Number(opt('--jobs')) : defaultJobs();
  live?.stage('suites', { total: tasks.length });
  const t0 = Date.now();
  await runPool(tasks, { jobs, serial: SERIAL_SUITES, onResult: (i, r) => {
    const f = tasks[i].name;
    if (r.na) { record('suite', f, r.na, 'NA', r.detail || ''); return; }
    const output = r.outputFile ? path.relative(REPO, r.outputFile).split(path.sep).join('/') : null;
    record('suite', f, f, r.ok ? 'OK' : 'KO', `${r.tail} (${r.durationS} s, exit ${r.code})`, output ? { output } : null);
    if (output) console.log(`       sortie complète : ${output}`);
  } });
  const serialRun = tasks.filter(t => SERIAL_SUITES.has(t.name)).length;
  console.log(`   étage des suites : ${Math.round((Date.now() - t0) / 1000)} s — ${tasks.length} suite(s), ${jobs} en parallèle, ${serialRun} en série`);
}

// ---------------------------------------------------------------------------
// 2. HTTP sur l'instance de test
// ---------------------------------------------------------------------------
async function apiChecks(sb) {
  const H = { 'X-Orchestrator-Token': sb.token };
  const get = (p, h = H) => fetch(sb.url + p, { headers: h });
  const json = async (p) => { const r = await get(p); assert(r.ok, `${p} → HTTP ${r.status}`); return r.json(); };
  const post = (p, body) => fetch(sb.url + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const readLog = (n) => { try { return fs.readFileSync(path.join(sb.root, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(sb.root, 'package.json'), 'utf8')).version;
  const S = 'http';

  // Le gate peut être coupé dans server.js (TOKEN_GATE_ENABLED = false, décision
  // utilisateur du 2026-09-07). On teste alors le contrat RÉEL : le jeton reste
  // accepté partout, et le rapport le dit — sans le maquiller en échec ni en succès du gate.
  const gateOn = /const TOKEN_GATE_ENABLED\s*=\s*true/.test(fs.readFileSync(path.join(sb.root, 'server.js'), 'utf8'))
    || !/TOKEN_GATE_ENABLED/.test(fs.readFileSync(path.join(sb.root, 'server.js'), 'utf8'));
  sb.gateOn = gateOn;
  await check(S, 'token-gate', 'Token gate (contrat de server.js) : jeton par en-tête, paramètre, cookie ; 401 sans jeton si activé', async () => {
    if (!gateOn) {
      for (const h of [H, {}]) assert((await get('/api/version', h)).status === 200, 'jeton refusé');
      assert((await fetch(`${sb.url}/api/version?token=${sb.token}`)).status === 200, 'paramètre refusé');
      return 'GATE DÉSACTIVÉ dans server.js (TOKEN_GATE_ENABLED = false) : accès sans jeton accepté — comportement inchangé, à arbitrer';
    }
    assert((await get('/api/version', {})).status === 401, 'sans jeton ≠ 401');
    assert((await get('/', {})).status === 401, 'page sans jeton ≠ 401');
    assert((await get('/api/version')).status === 200, 'en-tête refusé');
    const q = await fetch(`${sb.url}/api/version?token=${sb.token}`);
    assert(q.status === 200, 'paramètre refusé');
    const cookie = (q.headers.get('set-cookie') || '').split(';')[0];
    assert(cookie, 'pas de cookie posé');
    assert((await get('/api/version', { cookie })).status === 200, 'cookie refusé');
    assert((await get('/api/version', { 'X-Orchestrator-Token': 'f'.repeat(64) })).status === 401, 'mauvais jeton accepté');
  });
  await check(S, 'version', '/api/version = version de package.json', async () => {
    const v = await json('/api/version');
    assert(v.version === pkgVersion, `${v.version} ≠ ${pkgVersion}`);
    return `v${v.version}`;
  });
  // 0.75.0 — TODO lists of the musicians, read-only (side panel).
  await check(S, 'todo-api', 'TODO des musiciens : GET /api/todo lit le disque (projets de config.json seulement), non faits puis faits, chacun du plus récent au plus ancien, nom du musicien sur les faits ; aucune route d’écriture ; un item coché par todo.mjs pendant un tour apparaît avec son nom', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'todo-core.mjs'))) NA('TODO absente de cet état du code');
    const d = await json('/api/todo');
    const lists = Object.fromEntries(d.lists.map(l => [l.project, l]));
    assert(lists.chef?.total === 3 && lists.alpha?.total === 4 && lists.beta?.total === 2 && d.items.length === 9, `listes : ${JSON.stringify(d.lists)}`);
    // 0.76.2: open items on top, done ones below (user request replacing "done first").
    const k = d.items.findIndex(i => i.status === 'done');
    assert(k > 0 && d.items.slice(0, k).every(i => i.status !== 'done') && d.items.slice(k).every(i => i.status === 'done'), 'non faits pas en premier');
    for (const part of [d.items.slice(0, k), d.items.slice(k)]) part.forEach((x, n) => assert(n === 0 || String(part[n - 1].addedAt) >= String(x.addedAt), `ordre : ${part.map(i => i.addedAt).join(' ')}`));
    const a1 = d.items.find(i => i.id === 't-a10001');
    assert(a1?.doneBy === 'alpha' && a1.doneAt === '2026-10-13T10:02', `nom du musicien : ${JSON.stringify(a1)}`);
    assert(d.items.find(i => i.project === 'beta' && i.status === 'done')?.doneBy === null, 'coché à la main : aucun nom inventé');
    assert(d.counts.done === 4 && d.counts.open === 5, `compteurs ${JSON.stringify(d.counts)}`);
    const longItem = d.items.find(i => i.project === 'chef' && /beta — analyse/.test(i.title));
    assert(longItem && longItem.detail.endsWith('…') && /FIN-DU-DETAIL-COMPLET$/.test(longItem.detailFull || '') && /Spec : docs\/analyse-beta\.md\nReste/.test(longItem.more || ''), `item complet (détail entier, lignes de suite) : ${JSON.stringify(longItem)}`);
    const only = await json('/api/todo?project=alpha');
    assert(only.items.length === 4 && only.items.every(i => i.project === 'alpha'), 'filtre projet');
    assert((await get('/api/todo?project=..%2F..%2Fsecret')).status === 404, 'projet hors liste accepté');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await fetch(sb.url + '/api/todo', { method, headers: { ...H, 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
      assert(r.status === 404, `${method} /api/todo → ${r.status} (aucune écriture ne doit exister)`);
    }
    assert((await json('/api/config')).ui?.sidePanel === true, 'drapeau ui.sidePanel absent');
    // A musician ticks during its turn: the panel shows its name.
    const env = { ...process.env, ORCH_TURN_PROJECT: 'alpha' };
    const r = spawnSync(process.execPath, [path.join(sb.root, 'scripts', 'todo.mjs'), 'done', 't-a10003'], { encoding: 'utf8', env, windowsHide: true });
    assert(r.status === 0, `todo.mjs done : ${r.status} ${r.stderr}`);
    const a3 = (await json('/api/todo?project=alpha')).items.find(i => i.id === 't-a10003');
    assert(a3?.status === 'done' && a3.doneBy === 'alpha', `item coché par alpha : ${JSON.stringify(a3)}`);
    const refused = spawnSync(process.execPath, [path.join(sb.root, 'scripts', 'todo.mjs'), 'done', 't-a10004'], { encoding: 'utf8', env: { ...process.env, ORCH_TURN_PROJECT: '' }, windowsHide: true });
    assert(refused.status === 3, `coché hors d’un tour : ${refused.status}`);
    return `${d.items.length} items (3 listes), faits puis non faits, nom affiché ; écriture : 404 ; coché par alpha pendant son tour → visible`;
  });
  // 0.78.0 — user request (2026-10-13), part 2/5: « Possibilité d'y ajouter des notes ».
  await check(S, 'todo-notes', 'Notes sur un item TODO : POST /api/notes/todo/:projet/:item (même origine) les enregistre dans todo-notes.json, GET /api/todo les rend avec l’item, le fichier relu à chaque changement (rien n’est gardé en mémoire seulement : survit au redémarrage) ; TODO_LIST.md jamais modifié ; refus : autre origine, projet ou item inconnu, note vide', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'todo-notes.mjs'))) NA('notes absentes de cet état du code');
    const alphaList = path.join(sb.root, 'projects', 'alpha', 'TODO_LIST.md');
    const before = fs.readFileSync(alphaList);
    const post = (proj, id, body, extra = {}) => fetch(`${sb.url}/api/notes/todo/${encodeURIComponent(proj)}/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
    });
    // t-a10003 was ticked by todo.mjs in todo-api: its id, and so its notes, stay.
    const r1 = await post('alpha', 't-a10003', { text: 'Note de recette\nsur deux lignes' });
    const j1 = await r1.json();
    assert(r1.status === 201 && j1.note?.text === 'Note de recette\nsur deux lignes' && j1.notes.length === 1, `ajout : ${r1.status} ${JSON.stringify(j1)}`);
    const r2 = await post('alpha', 't-a10003', { text: 'Deuxième' }, { Origin: sb.url });
    assert(r2.status === 201, `même origine explicite : ${r2.status}`);
    const item = (await json('/api/todo?project=alpha')).items.find(i => i.id === 't-a10003');
    assert(item?.notes?.map(n => n.text).join('|') === 'Note de recette\nsur deux lignes|Deuxième', `notes rendues avec l’item : ${JSON.stringify(item?.notes)}`);
    assert(Buffer.compare(before, fs.readFileSync(alphaList)) === 0, 'TODO_LIST.md modifié par une note');
    const notesFile = path.join(sb.root, 'todo-notes.json');
    const disk = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
    assert(disk.notes?.alpha?.['t-a10003']?.length === 2, `todo-notes.json : ${JSON.stringify(disk)}`);
    // The server holds nothing in memory alone: an edit of the file is served
    // as is, so a restart (which only rereads it) loses nothing.
    disk.notes.alpha['t-a10003'].push({ id: 'n-feedface', at: '2026-10-13T16:00', text: 'écrite sur le disque', by: 'utilisateur' });
    fs.writeFileSync(notesFile, JSON.stringify(disk, null, 2) + '\n');
    const again = (await json('/api/todo?project=alpha')).items.find(i => i.id === 't-a10003');
    assert(again?.notes?.length === 3 && again.notes[2].text === 'écrite sur le disque', 'le serveur ne relit pas le fichier des notes');
    assert((await post('alpha', 't-a10003', { text: 'x' }, { Origin: 'http://evil.example' })).status === 403, 'autre origine acceptée');
    assert((await post('alpha', 't-inexistant', { text: 'x' })).status === 404, 'item inconnu accepté');
    const unknownProj = await post('projet-inconnu', 't-a10003', { text: 'x' });
    assert(unknownProj.status === 404 && /projet inconnu/.test((await unknownProj.json()).error || ''), 'projet hors liste accepté');
    assert((await post('alpha', 't-a10003', { text: '   ' })).status === 400, 'note vide acceptée');
    assert(JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes.alpha['t-a10003'].length === 3, 'un refus a écrit une note');
    return '2 notes ajoutées puis rendues avec l’item, fichier relu (survit au redémarrage), TODO_LIST.md intact ; refus : autre origine 403, item/projet inconnu 404, vide 400';
  });
  // User request (2026-10-13), part 5/5: « Chaque item est drag & dropable, et
  // les positions doivent persister. »
  await check(S, 'todo-order', 'Ordre des items TODO : POST /api/order/todo (même origine) l’enregistre dans todo-order.json, GET /api/todo rend les items dans cet ordre (faits toujours en bas), le fichier relu à chaque changement (survit au redémarrage) ; TODO_LIST.md jamais modifié ; liste vide = tri par défaut ; refus : autre origine, clé invalide', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'todo-order.mjs'))) NA('glisser-déposer absent de cet état du code');
    const lists = ['alpha', 'chef', 'beta'].map(n => path.join(sb.root, 'projects', n, 'TODO_LIST.md'));
    const before = lists.map(f => fs.readFileSync(f));
    const send = (keys, extra = {}) => fetch(`${sb.url}/api/order/todo`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ keys }) });
    const keysOf = (items) => items.map(i => `${i.project}/${i.id}`);
    try {
      const all0 = (await json('/api/todo')).items;
      const open0 = keysOf(all0.filter(i => i.status !== 'done'));
      assert(open0.length >= 3, `items non faits : ${open0.length}`);
      const wanted = [...open0].reverse();
      const r1 = await send([...wanted, ...keysOf(all0.filter(i => i.status === 'done')), 'alpha/t-inexistant']);
      const j1 = await r1.json();
      assert(r1.ok && j1.ok && !j1.order.includes('alpha/t-inexistant'), `enregistrement : ${r1.status} ${JSON.stringify(j1).slice(0, 200)}`);
      const all1 = (await json('/api/todo')).items;
      const open1 = keysOf(all1.filter(i => i.status !== 'done'));
      assert(open1.join(' ') === wanted.join(' '), `ordre rendu : ${open1.join(' ')}`);
      assert(all1.findIndex(i => i.status === 'done') === open1.length, 'un fait est remonté parmi les non faits');
      const alphaOnly = keysOf((await json('/api/todo?project=alpha')).items.filter(i => i.status !== 'done'));
      assert(alphaOnly.join(' ') === wanted.filter(k => k.startsWith('alpha/')).join(' '), 'vue d’un seul projet pas dans le même ordre');
      // Nothing only in memory: an edit of the file is served as is (a restart
      // only rereads it).
      const orderFile = path.join(sb.root, 'todo-order.json');
      const disk = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
      disk.order = [...open0];
      fs.writeFileSync(orderFile, JSON.stringify(disk, null, 2) + '\n');
      assert(keysOf((await json('/api/todo')).items.filter(i => i.status !== 'done')).join(' ') === open0.join(' '), 'le serveur ne relit pas todo-order.json');
      assert((await send(wanted, { Origin: 'http://evil.example' })).status === 403, 'autre origine acceptée');
      assert((await send(['../../etc/passwd'])).status === 400, 'clé invalide acceptée');
      assert((await send('alpha/t-a10003')).status === 400, 'corps sans liste accepté');
      lists.forEach((f, n) => assert(Buffer.compare(before[n], fs.readFileSync(f)) === 0, `${f} modifié par l’ordre`));
      return `${open0.length} non faits inversés puis rendus dans cet ordre (vue complète et vue alpha), faits en bas, fichier relu ; TODO_LIST.md intacts ; refus 403 / 400`;
    } finally {
      await send([]);
    }
  });
  // User request (2026-10-13), part 3/5, and the user's choice: « le rejet est
  // marqué dans le TODO_LIST.md du musicien. Dans l'UI passe le dans la liste
  // des "faits" mais barre, avec une marque « rejeté (date) par l'utilisateur » ».
  await check(S, 'todo-reject', 'Rejet d’un item TODO : POST /api/reject/todo/:projet/:item (même origine) écrit « → rejeté (date) par l’utilisateur » sur la seule ligne de l’item dans le TODO_LIST.md du musicien ; GET /api/todo le rend fermé (avec les faits) et `rejected` ; refus : déjà rejeté ou déjà fait 409, autre origine 403, item ou projet inconnu 404', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'todo-capture.mjs')) || !fs.readFileSync(path.join(sb.root, 'server.js'), 'utf8').includes('/api/reject/todo/')) NA('rejet absent de cet état du code');
    const listFile = path.join(sb.root, 'projects', 'alpha', 'TODO_LIST.md');
    const before = fs.readFileSync(listFile, 'utf8');
    const reject = (proj, id, extra = {}) => fetch(`${sb.url}/api/reject/todo/${encodeURIComponent(proj)}/${encodeURIComponent(id)}`, { method: 'POST', headers: { ...H, ...extra } });
    try {
      const r = await reject('alpha', 't-a10004');
      const j = await r.json();
      assert(r.ok && j.ok && j.item?.rejected?.by === 'utilisateur' && j.item.status === 'done', `rejet : ${r.status} ${JSON.stringify(j)}`);
      const after = fs.readFileSync(listFile, 'utf8');
      const diff = before.split('\n').map((l, n) => (l === after.split('\n')[n] ? null : n)).filter(n => n != null);
      const line = after.split('\n')[diff[0]] || '';
      assert(diff.length === 1 && /^- \[x\] \(2026-09-20 12:00\) Nettoyer les logs → rejeté \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\) par l'utilisateur <!-- id:t-a10004 -->$/.test(line), `ligne écrite : ${line} (${diff.length} ligne(s) changée(s))`);
      const items = (await json('/api/todo?project=alpha')).items;
      const it = items.find(i => i.id === 't-a10004');
      assert(it?.status === 'done' && it.rejected?.at && items.findIndex(i => i.id === 't-a10004') > items.findIndex(i => i.status !== 'done'), `rendu : ${JSON.stringify(it)}`);
      assert((await reject('alpha', 't-a10004')).status === 409, 'second rejet accepté');
      assert((await reject('alpha', 't-a10001')).status === 409, 'rejet d’un item fait accepté');
      assert((await reject('alpha', 't-a10003', { Origin: 'http://evil.example' })).status === 403, 'autre origine acceptée');
      assert((await reject('alpha', 't-inexistant')).status === 404, 'item inconnu accepté');
      assert((await reject('projet-inconnu', 't-a10004')).status === 404, 'projet hors liste accepté');
      assert(fs.readFileSync(listFile, 'utf8') === after, 'un refus a modifié la liste');
      return `t-a10004 rejeté (une ligne : « → rejeté (date) par l’utilisateur »), rendu avec les faits ; refus 409 / 403 / 404 sans écriture`;
    } finally {
      fs.writeFileSync(listFile, before);
    }
  });
  await check(S, 'config', '/api/config : flotte, états hydratés, parcage, lecture', async () => {
    const c = await json('/api/config');
    const by = Object.fromEntries(c.projects.map(p => [p.name, p]));
    assert(c.projects.length === 14, `${c.projects.length} projets`);
    assert(c.conductor === 'chef', 'conductor');
    assert(by.beta.currentState === 'input', `beta ${by.beta.currentState}`);
    assert(by.gamma.currentState === 'error', `gamma ${by.gamma.currentState}`);
    assert(by.eps.currentState === 'live', `eps ${by.eps.currentState}`);
    // 0.38.0 : plus de « mis de côté » ; zeta et eta gardent l'ancien marqueur
    // dans la config de fixtures, il doit être ignoré.
    if (c.projects.some(p => 'parked' in p)) NA('concept « mis de côté » encore présent dans cet état du code');
    assert(by.zeta && by.eta, 'projets à l\'ancien marqueur absents de /api/config');
    assert(by.lambda.questionResolved?.note === 'répondu via le chef', 'questionResolved lambda');
    assert(!JSON.stringify(c).includes(sb.token), 'le jeton fuit dans /api/config');
  });
  // 0.78.1 — user report (2026-10-13): « toute tâche qui tourne attachée à un
  // musicien fait que le musicien est En cours, ou en Reflexion, en tout cas,
  // pas Prêt ». alpha's turn has its result; its process is made to live on.
  await check(S, 'busy-not-ready', 'Tour terminé (result) mais processus encore vivant : /api/pupitre et /api/config disent « En cours » (live), jamais Prêt, avec ce qui tourne ; le processus arrêté, l’état du log revient ; rien n’est tué', async () => {
    if (!fs.readFileSync(path.join(sb.root, 'scripts', 'fleet-status-core.mjs'), 'utf8').includes('stillRunning')) NA('correction absente de cet état du code');
    const pidFile = path.join(sb.root, 'logs', 'alpha.pid');
    assert(!fs.existsSync(pidFile), 'alpha.pid existe déjà');
    const before = (await json('/api/pupitre')).fleet.find(r => r.name === 'alpha');
    assert(before && before.state !== 'live' && !before.lingering, `alpha au départ : ${before?.state}`);
    const keep = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
    try {
      fs.writeFileSync(pidFile, String(keep.pid));
      const row = await until(async () => (await json('/api/pupitre')).fleet.find(r => r.name === 'alpha' && r.lingering) || null, 8000);
      assert(row && row.state === 'live' && row.logState === before.state && row.lingering.pid === keep.pid, `pupitre : ${JSON.stringify(row && { s: row.state, l: row.logState, g: row.lingering })}`);
      assert(/processus encore actif/.test(row.activity || '') && !row.stalled && !row.deadInFlight, `activité / alarmes : ${row.activity}`);
      const cfg = (await json('/api/config')).projects.find(p => p.name === 'alpha');
      assert(cfg.currentState === 'live' && cfg.heldState === before.state, `config : ${JSON.stringify({ c: cfg.currentState, h: cfg.heldState })}`);
      assert(keep.exitCode === null, 'le processus a été tué');
    } finally {
      keep.kill();
      for (let i = 0; i < 20 && fs.existsSync(pidFile); i++) { try { fs.unlinkSync(pidFile); } catch { await new Promise(r => setTimeout(r, 150)); } }
    }
    const after = await until(async () => { const r = (await json('/api/pupitre')).fleet.find(x => x.name === 'alpha'); return r && !r.lingering ? r : null; }, 8000);
    assert(after && after.state === before.state, `après l’arrêt : ${after?.state}`);
    return `alpha : ${before.state} → live tant que le processus vit (pupitre et config) → ${after.state} après son arrêt`;
  });
  // 0.82.0 — same report, second part: a process alive after its turn's result
  // that holds tasks in the queue is detected, journaled, reported to the chef
  // and visible in fleet-status — never killed automatically.
  await check(S, 'queue-held', 'File retenue : tour terminé, processus encore vivant et tâches en file ⇒ détecté (/api/pupitre queueHeld), journalisé dans le log du musicien, signalé au chef avec les actions possibles, visible dans fleet-status --held ; rien n’est tué ; libération journalisée', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'queue-hold.mjs'))) NA('détection absente de cet état du code');
    const logs = path.join(sb.root, 'logs');
    const pidFile = path.join(logs, 'alpha.pid');
    const readLog = (n) => { try { return fs.readFileSync(path.join(logs, `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
    const keep = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
    let qid = null;
    try {
      fs.writeFileSync(pidFile, String(keep.pid));
      await until(async () => (await json('/api/pupitre')).fleet.find(r => r.name === 'alpha' && r.lingering) || null, 8000);
      const d = await post('/api/dispatch', { project: 'alpha', prompt: 'tâche retenue de recette', queueIfBusy: true });
      const dj = await d.json();
      assert(d.status === 202 && dj.queued === true, `mise en file : ${d.status} ${JSON.stringify(dj)}`);
      qid = dj.id;
      const row = await until(async () => (await json('/api/pupitre')).fleet.find(r => r.name === 'alpha' && r.queueHeld) || null, 8000);
      assert(row && row.queueHeld.pid === keep.pid && row.queueHeld.queueLength === 1 && row.state === 'live', `pupitre : ${JSON.stringify(row?.queueHeld)}`);
      assert(/file retenue/.test(row.activity || '') && !row.stalled, `activité : ${row.activity}`);
      const ev = await until(async () => readLog('alpha').find(e => e.type === 'notification' && e.subtype === 'queue_held' && e.pid === keep.pid) || null, 10_000);
      assert(ev && ev.queue_length === 1 && /kill-stalled\.mjs alpha/.test(ev.text) && /Rien n'est arrêté automatiquement/.test(ev.text), `événement du musicien : ${JSON.stringify(ev)}`);
      const chef = readLog('chef').find(e => e.type === 'user_prompt' && e.source === 'queue-held' && e.project === 'alpha');
      assert(chef && /File bloquée — alpha/.test(chef.text), 'signalement au chef absent');
      const fsr = spawnSync(process.execPath, [path.join(sb.root, 'scripts', 'fleet-status.mjs'), '--held'], { cwd: sb.root, encoding: 'utf8', windowsHide: true });
      assert(fsr.status === 2 && /alpha/.test(fsr.stdout) && /FILE RETENUE/.test(fsr.stdout), `fleet-status --held : exit ${fsr.status} ${fsr.stdout.slice(0, 300)}`);
      await sleep(2500);
      assert(readLog('alpha').filter(e => e.subtype === 'queue_held').length === 1, 'signalé plus d’une fois avant le délai de rappel');
      assert(keep.exitCode === null, 'le processus a été tué');
      const del = await fetch(`${sb.url}/api/queue/alpha/${encodeURIComponent(qid)}`, { method: 'DELETE', headers: H });
      assert(del.ok, `DELETE ${del.status}`);
      qid = null;
      const rel = await until(async () => readLog('alpha').find(e => e.type === 'notification' && e.subtype === 'queue_hold_released' && e.pid === keep.pid) || null, 10_000);
      assert(rel, 'libération non journalisée');
      return `alpha : PID ${keep.pid} vivant après le result, 1 tâche en file ⇒ pupitre, log du musicien, chef, fleet-status --held (exit 2) ; un seul signalement ; rien n’est tué ; libération journalisée`;
    } finally {
      if (qid) await fetch(`${sb.url}/api/queue/alpha/${encodeURIComponent(qid)}`, { method: 'DELETE', headers: H }).catch(() => {});
      keep.kill();
      for (let i = 0; i < 20 && fs.existsSync(pidFile); i++) { try { fs.unlinkSync(pidFile); } catch { await new Promise(r => setTimeout(r, 150)); } }
    }
  });
  // User request (2026-10-20): « Je ne vois pas que le test de non regression
  // est en cours sur orchestrateur-dev. C'est un probleme. »
  await check(S, 'regression-live', 'Non-régression visible pendant qu’elle tourne : /api/regressions (en cours, progression, KO, lanceur), pastille du pupitre, entrée du journal d’activité, lien vers le rapport (servi seulement sous .regress/, refusé s’il a été remplacé), lancement mort = « interrompue »', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'regression-live.mjs'))) NA('suivi absent de cet état du code');
    const F = await import(pathToFileURL(path.join(REPO, 'tests', 'regress-live-fixture.mjs')).href);
    const beta = path.join(sb.root, 'projects', 'beta'), gamma = path.join(sb.root, 'projects', 'gamma');
    try {
      const run = F.writeRunning(beta);
      const fin = F.writeFinished(gamma);
      const dead = F.writeRunning(gamma, { id: 'r-20261020T070000-3', pid: 999998 });
      await sleep(2200);   // server cache: 2 s
      const all = await json('/api/regressions');
      const b = all.projects.find(p => p.project === 'beta'), g = all.projects.find(p => p.project === 'gamma');
      assert(all.running === 1 && b?.running[0]?.id === run.id && b.running[0].progress === 'suites 3/10 · 1 KO' && b.running[0].launcher.by === 'script du chef (recette)', `en cours : ${JSON.stringify(b)}`);
      assert(g && !g.running.length && g.recent.some(r => r.id === fin.id && r.status === 'ko') && g.recent.some(r => r.id === dead.id && r.status === 'interrupted'), `historique / interrompue : ${JSON.stringify(g)}`);
      const row = (await json('/api/pupitre')).fleet.find(r => r.name === 'beta');
      assert(row?.regression?.status === 'running' && row.regression.suites.total === 10, `pupitre : ${JSON.stringify(row?.regression)}`);
      const j = await json('/api/project/beta/journal?n=5');
      assert((j.regressions || []).some(r => r.id === run.id), 'journal sans la non-régression');
      const rep = (await json('/api/regressions/gamma')).recent.find(r => r.id === fin.id).report;
      const rr = await get(rep);
      assert(rr.status === 200 && (await rr.json()).at === fin.reportAt, `rapport : HTTP ${rr.status}`);
      assert((await get(`/api/regressions/beta/report/${run.id}`)).status === 404, 'rapport d’un lancement en cours servi avant la fin');
      assert((await get('/api/regressions/gamma/report/r-inconnu')).status === 404 && (await get('/api/regressions/gamma/report/..%2Fx')).status === 400, 'identifiant inconnu / invalide');
      const evil = F.writeFinished(gamma, { id: 'r-20261020T060000-4', report: false });
      fs.appendFileSync(path.join(gamma, '.regress', 'history.ndjson'), JSON.stringify({ ...evil, id: 'r-20261020T050000-5', report: '../../config.json' }) + '\n');
      fs.writeFileSync(path.join(gamma, fin.report), JSON.stringify({ at: '2026-10-20T09:59:00.000Z' }));
      await sleep(2200);
      assert((await get('/api/regressions/gamma/report/r-20261020T050000-5')).status === 404, 'rapport hors de .regress/ servi');
      assert((await get(rep)).status === 410, 'rapport remplacé par un lancement plus récent : servi comme s’il était le bon');
      return `beta en cours (${b.running[0].progress}), gamma : rouge + interrompue, rapport servi puis 410`;
    } finally { F.clearRuns(beta); F.clearRuns(gamma); }
  });
  await check(S, 'pupitre', '/api/pupitre : santé (stall, processus perdu, PIDvivant), file, pool', async () => {
    const p = await json('/api/pupitre');
    const by = Object.fromEntries(p.fleet.map(r => [r.name, r]));
    assert(p.fleet.length === 14, `${p.fleet.length} lignes`);
    assert(by.eps.state === 'live' && by.eps.pidAlive === true && !by.eps.stalled, 'eps en vol, PID vivant');
    assert(by.theta.stalled === true, 'theta sans progrès');
    assert(by.iota.deadInFlight === true, 'iota processus perdu');
    assert(by.eps.queueDepth === 2, `file eps = ${by.eps.queueDepth}`);
    assert(by.beta.needsInput && /production/.test(by.beta.needsInput), 'question beta');
    assert(by.chef.isConductor === true, 'isConductor');
    assert(p.pool && Array.isArray(p.pool.queue) && Array.isArray(p.pool.slots), 'pool');
  });
  await check(S, 'pupitre-projects', '/api/pupitre : champs de la vue Projets (dernier tour, mission, version, APK)', async () => {
    const p0 = await json('/api/pupitre');
    if (!('lastTurn' in (p0.fleet[0] || {}))) NA('champs absents de cet état du code');
    await sleep(1200);                                 // rafraîchissement asynchrone des métadonnées
    const p = await json('/api/pupitre');
    const by = Object.fromEntries(p.fleet.map(r => [r.name, r]));
    assert(Math.abs(by.alpha.lastTurn?.costUsd - 0.42) < 1e-9, 'coût rapporté alpha');
    assert(by.alpha.mission === "Publier la version 1.2.3 de l'app", `mission alpha = ${by.alpha.mission}`);
    assert(by.eps.callbackTo === 'chef', 'rapport promis eps');
    assert(by.alpha.callbackTo === null, 'pas de rapport promis hors tour');
    assert(by.alpha.version?.value === '1.2.3', `version alpha ${JSON.stringify(by.alpha.version)}`);
    assert(by.gamma.version?.value === '0.4.0', 'version gamma (pyproject)');
    assert(by.alpha.build?.apkAt > 0 && by.beta.build === null, 'APK');
    assert(by.eta.state === 'input' && by.eta.stalled === false, 'eta scanné comme les autres (question ouverte)');
    assert(by.kappa.lastActivityAt === null, 'jamais observé');
    assert(p.ui?.projectsView === true, 'drapeau ui');
  });
  await check(S, 'pupitre-page', 'Page /pupitre et /healthz', async () => {
    const r = await get('/pupitre');
    assert(r.ok && /<html/i.test(await r.text()), '/pupitre');
    assert((await get('/healthz')).ok, '/healthz');
  });
  await check(S, 'queue', 'File par musicien : mise en file si occupé, GET, DELETE d\'une entrée', async () => {
    const d = await post('/api/dispatch', { project: 'eps', prompt: 'tâche de recette', queueIfBusy: true });
    const dj = await d.json();
    assert(d.status === 202 && dj.queued === true, `dispatch sur occupé : ${d.status} ${JSON.stringify(dj)}`);
    const q = await json('/api/queue/eps');
    assert(q.count === 3 && q.busy === true, `file = ${q.count}, busy ${q.busy}`);
    const del = await fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(dj.id)}`, { method: 'DELETE', headers: H });
    assert(del.ok, `DELETE ${del.status}`);
    assert((await json('/api/queue/eps')).count === 2, 'entrée non retirée');
    assert((await fetch(`${sb.url}/api/queue/nope`, { headers: H })).status === 404, 'projet inconnu ≠ 404');
  });
  // User request (2026-10-13): « il faut pouvoir drag & drop les éléments de la
  // file d'attente, et que celà ai un impacte sur l'ordre de traitement ».
  await check(S, 'queue-order', 'File : POST /api/queue/:projet/order (même origine) réordonne la file du serveur (mémoire et fichier réécrit), qui est l’ordre de lancement ; un élément parti entre-temps est ignoré sans perte ni doublon ; refus : autre origine, projet inconnu, liste invalide', async () => {
    if (!fs.readFileSync(path.join(sb.root, 'server.js'), 'utf8').includes("'/api/queue/:project/order'")) NA('réordonnancement de la file absent de cet état du code');
    const ids0 = (await json('/api/queue/eps')).entries.map(e => e.id);
    assert(ids0.length >= 2, `file d’eps : ${ids0.length} entrée(s)`);
    const send = (ids, extra = {}) => fetch(`${sb.url}/api/queue/eps/order`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ ids }) });
    try {
      const rev = [...ids0].reverse();
      const r = await send(rev);
      const j = await r.json();
      assert(r.ok && j.changed && j.entries.map(e => e.id).join() === rev.join() && j.entries[0].position === 1, `réordonnancement : ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      assert((await json('/api/queue/eps')).entries.map(e => e.id).join() === rev.join(), 'la file du serveur ne suit pas l’ordre');
      const side = JSON.parse(fs.readFileSync(path.join(sb.root, 'logs', 'queue', 'eps.json'), 'utf8')).map(e => e.id);
      assert(side.join() === rev.join(), `fichier de la file : ${side.join()}`);
      // Concurrent change: an id no longer queued, and one entry left out.
      const r2 = await send(['q-deja-parti', rev[1]]);
      const j2 = await r2.json();
      assert(r2.ok && j2.missing.join() === 'q-deja-parti' && j2.entries.map(e => e.id).join() === [rev[1], rev[0], ...rev.slice(2)].join() && j2.count === ids0.length, `concurrence : ${JSON.stringify(j2).slice(0, 240)}`);
      assert((await send(rev, { Origin: 'http://evil.example' })).status === 403, 'autre origine acceptée');
      assert((await fetch(`${sb.url}/api/queue/nope/order`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{"ids":[]}' })).status === 404, 'projet inconnu accepté');
      assert((await send('pas-une-liste')).status === 400, 'liste invalide acceptée');
      return `${ids0.length} entrées inversées (mémoire et fichier), élément parti ignoré sans perte, refus 403 / 404 / 400`;
    } finally {
      await send(ids0);
    }
  });
  // User request (2026-10-13): « tant qu'ils ne sont pas traités ils sont éditables ».
  await check(S, 'queue-edit', 'File : POST /api/queue/:projet/:id {text} (même origine) modifie la demande d’une entrée EN ATTENTE (mémoire et fichier réécrit, autres champs gardés) ; une entrée partie ou retirée : 409 ; refus : texte vide, autre origine, projet inconnu', async () => {
    if (!fs.readFileSync(path.join(sb.root, 'server.js'), 'utf8').includes('editQueueEntry')) NA('modification d’une entrée de file absente de cet état du code');
    const d = await post('/api/dispatch', { project: 'eps', prompt: 'Recette de modification : texte d’origine', queueIfBusy: true, callback: 'chef' });
    const dj = await d.json();
    assert(d.status === 202 && dj.queued === true, `mise en file : ${d.status}`);
    const send = (id, text, extra = {}) => fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(id)}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ text }) });
    try {
      const NEW = 'Recette de modification : texte MODIFIÉ\nsur deux lignes';
      const r = await send(dj.id, NEW);
      const j = await r.json();
      assert(r.ok && j.changed && j.entry?.text === NEW && j.entry.callback === 'chef' && j.entry.edits === 1, `modification : ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      assert((await json('/api/queue/eps')).entries.find(e => e.id === dj.id)?.text === NEW, 'la file du serveur ne porte pas le texte modifié');
      const side = JSON.parse(fs.readFileSync(path.join(sb.root, 'logs', 'queue', 'eps.json'), 'utf8')).find(e => e.id === dj.id);
      assert(side?.prompt === NEW, 'fichier de la file non réécrit');
      assert((await send(dj.id, '   ')).status === 400, 'texte vide accepté');
      assert((await send(dj.id, 'x', { Origin: 'http://evil.example' })).status === 403, 'autre origine acceptée');
      assert((await fetch(`${sb.url}/api/queue/nope/${dj.id}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{"text":"x"}' })).status === 404, 'projet inconnu accepté');
      await fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(dj.id)}`, { method: 'DELETE', headers: H });
      const gone = await send(dj.id, 'trop tard');
      assert(gone.status === 409 && (await gone.json()).alreadyStarted === true, `entrée retirée encore modifiable : ${gone.status}`);
      return 'demande modifiée en attente (mémoire et fichier), autres champs gardés ; retirée : 409 ; refus 400 / 403 / 404';
    } finally {
      await fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(dj.id)}`, { method: 'DELETE', headers: H }).catch(() => {});
    }
  });
  // User request (2026-10-13): queue entries open a detail view with the whole entry.
  await check(S, 'queue-detail', 'File : GET /api/queue/:projet donne le texte INTÉGRAL de chaque entrée (sauts de ligne compris, jamais tronqué) et tous ses champs', async () => {
    const text = 'Recette du détail.\n\n' + 'ligne longue '.repeat(60) + '\nFIN';
    const d = await post('/api/dispatch', { project: 'eps', prompt: text, queueIfBusy: true, callback: 'chef', model: 'claude-sonnet-5', provider: 'claude',
      newSession: true, pipeline: 'dev', pipelineMode: 'leger', secondModel: 'claude-opus-5-5', secondProvider: 'claude' });
    const dj = await d.json();
    assert(d.status === 202 && dj.queued === true, `mise en file : ${d.status}`);
    try {
      const q = await json('/api/queue/eps');
      const e = q.entries.find(x => x.id === dj.id);
      if (e && e.text === undefined) NA('texte intégral absent de cet état du code');
      assert(e, 'entrée absente');
      assert(e.text === text, `texte altéré (${e.text?.length} / ${text.length})`);
      assert(e.head.length <= 201, 'aperçu non borné');
      assert(e.position === q.count && e.enqueuedAt && e.callback === 'chef' && e.model === 'claude-sonnet-5' && e.provider === 'claude', `champs : ${JSON.stringify({ ...e, text: undefined })}`);
      assert(e.newSession === true && e.pipeline === 'dev' && e.pipelineMode === 'leger' && e.secondModel === 'claude-opus-5-5', 'session neuve / pipeline / second model');
    } finally {
      await fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(dj.id)}`, { method: 'DELETE', headers: H });
    }
  });
  await check(S, 'lanes-queue', 'Couloirs (0.101.0) : une tâche retenue en série par une règle va en file même si le musicien est libre, avec sa justification, son couloir et ses ressources', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'lane-rules.mjs'))) NA('couloirs absents de cet état du code');
    const exclusive = { rule: 'port', text: 'la tâche lance un serveur sur un port fixe — port 5173 ; ressource tenue', resource: 'port-5173', doc: 'docs/PLAN-parallel-tasks-same-musician.md §3' };
    const d = await post('/api/dispatch', { project: 'theta', prompt: 'Recette des couloirs : tâche en série', queueIfBusy: true, source: 'chef', lane: 1, ressources: 'serveur', exclusive });
    const dj = await d.json();
    try {
      assert(d.status === 202 && dj.queued === true, `musicien libre + règle de couloir : mise en file attendue (${d.status} ${JSON.stringify(dj)})`);
      const e = (await json('/api/queue/theta')).entries.find(x => x.id === dj.id);
      assert(e && e.exclusive?.rule === 'port' && e.exclusive.text === exclusive.text && e.exclusive.doc === exclusive.doc && e.lane === 1 && e.ressources === 'serveur', `entrée : ${JSON.stringify(e)}`);
      const bad = await post('/api/dispatch', { project: 'eps', prompt: 'x', queueIfBusy: true, exclusive: { rule: '../../x', text: 'y' }, lane: 42, ressources: 'rm -rf' });
      const bj = await bad.json();
      const be = (await json('/api/queue/eps')).entries.find(x => x.id === bj.id);
      try { assert(be && be.exclusive === null && be.lane === null && be.ressources === null, `champs invalides acceptés : ${JSON.stringify(be)}`); }
      finally { if (bj.id) await fetch(`${sb.url}/api/queue/eps/${encodeURIComponent(bj.id)}`, { method: 'DELETE', headers: H }); }
    } finally {
      if (dj.id) await fetch(`${sb.url}/api/queue/theta/${encodeURIComponent(dj.id)}`, { method: 'DELETE', headers: H });
    }
  });
  await check(S, 'lanes-api', 'Couloirs (0.101.0) : GET /api/lanes/:projet donne les couloirs, la limite et les règles documentées ; projet hors liste refusé ; aucune écriture', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'lane-rules.mjs'))) NA('couloirs absents de cet état du code');
    const d = await json('/api/lanes/alpha');
    // Default maxParallel: 1 up to 0.102.0, 2 since 0.103.0 (user decision Q1).
    const want = /DEFAULT_MAX_PARALLEL = 2\b/.test(fs.readFileSync(path.join(sb.root, 'scripts', 'lanes.mjs'), 'utf8')) ? 2 : 1;
    assert(d.project === 'alpha' && d.maxParallel === want && d.lanes.length === want && d.lanes[0].lane === 0 && d.running === 0 && Array.isArray(d.resources) && d.exclusive === null, `état (défaut attendu ${want}) : ${JSON.stringify(d)}`);
    assert(d.rules.some(r => r.id === 'no-git' && r.status === 'active' && r.text) && /PLAN-parallel-tasks-same-musician\.md$/.test(d.doc), 'règles documentées absentes');
    assert((await get('/api/lanes/..%2Fsecret')).status === 404, 'projet hors liste accepté');
    const w = await fetch(sb.url + '/api/lanes/alpha', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });
    assert(w.status === 404, `POST /api/lanes → ${w.status} (lecture seule)`);
  });
  await check(S, 'question', 'Question acquittée sans relancer (200 puis 409), événement dans le log', async () => {
    const a = await post('/api/question/mu/resolve', { note: 'recette', by: 'regression' });
    assert(a.status === 200, `1er acquittement ${a.status}`);
    const b = await post('/api/question/mu/resolve', { note: 'bis' });
    assert(b.status === 409, `2e acquittement ${b.status}`);
    assert(readLog('mu').some(e => e.type === 'notification' && e.subtype === 'question_resolved'), 'événement absent');
    const c = await json('/api/config');
    assert(c.projects.find(p => p.name === 'mu').currentState === 'idle', 'mu non repassé idle');
  });
  // 0.127.0 — Android 1.0.0: a paused run exposes its pause menu as data.
  await check(S, 'pipeline-runs-pause', 'GET /api/pipeline-runs : une exécution en pause porte son menu (cause, choix, recommandation), sans l’effet interne des options', async () => {
    const run = 'p-20261020T110000-a1b2c3';
    const dir = path.join(sb.root, 'logs', 'runs', run);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run, project: 'omega', pipeline: 'dev', status: 'paused', question: 'omega en pause',
      diagnosis: { kind: 'test_passes', transient: false, cause: 'le test passe déjà', options: [{ key: 'corriger le test', does: 'je relance', effect: { message: 'INTERNE' } }, { key: 'abandonner', does: 'j’arrête' }], recommend: { key: 'corriger le test', why: 'agit sur la cause' } } }));
    // Removed afterwards: a paused run is a wait the automatic answer would
    // pick up during the browser walks (it made auto-answer-dismiss fail).
    try {
      const runs = await json('/api/pipeline-runs?project=omega&n=100');
      const r = runs.runs.find(x => x.run === run);
      assert(r, 'exécution absente');
      if (!('pause' in r)) NA('champ pause absent de cet état du code');
      assert(r.pause?.cause === 'le test passe déjà', `cause : ${JSON.stringify(r.pause)}`);
      assert(r.pause.options.map(o => o.key).join('|') === 'corriger le test|abandonner', 'choix');
      assert(r.pause.options[0].recommended === true && r.pause.recommend?.key === 'corriger le test', 'recommandation');
      assert(!JSON.stringify(r).includes('INTERNE'), 'effet interne exposé');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  // 0.60.0 — erreurs de lancement : contrôle de l'attente et journaux de test du model.
  await check(S, 'model-backoff', 'Attente après erreurs de lancement : POST /api/pipeline-runs/:run/backoff (retry, test ; 404, 400, origine étrangère 403) et GET /api/model-tests/:name', async () => {
    const probe = await post('/api/pipeline-runs/p-20261009T000000-aaaaaa/backoff', { action: 'retry' });
    if (probe.status === 404 && !/introuvable/.test(await probe.text())) NA('route absente de cet état du code');
    const run = 'p-20261009T120000-abcdef';
    const dir = path.join(sb.root, 'logs', 'runs', run);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run, project: 'omega', status: 'running', backoff: { tier: 1, model: 'claude-opus-5-5', slot: 'dev.rouge' } }));
    const a = await post(`/api/pipeline-runs/${run}/backoff`, { action: 'retry' });
    assert(a.status === 200, `retry : ${a.status}`);
    const ctl = JSON.parse(fs.readFileSync(path.join(dir, 'backoff-control.json'), 'utf8'));
    assert(ctl.action === 'retry' && ctl.by === 'dashboard', `fichier de contrôle : ${JSON.stringify(ctl)}`);
    assert((await post(`/api/pipeline-runs/${run}/backoff`, { action: 'test' })).status === 200, 'test refusé');
    assert((await post(`/api/pipeline-runs/${run}/backoff`, { action: 'reboot' })).status === 400, 'action inconnue acceptée');
    const foreign = await fetch(`${sb.url}/api/pipeline-runs/${run}/backoff`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ action: 'retry' }) });
    assert(foreign.status === 403, `origine étrangère : ${foreign.status}`);
    const runs = await json('/api/pipeline-runs?project=omega&n=50');
    assert(runs.runs.find(x => x.run === run)?.backoff?.slot === 'dev.rouge', '/api/pipeline-runs n’expose pas l’attente');
    assert((await get('/api/model-tests/..%2Fconfig.json')).status === 400, 'nom de journal non filtré');
    assert((await get('/api/model-tests/20261009T000000Z-claude-opus-5-5.log')).status === 404, 'journal absent ≠ 404');
    fs.mkdirSync(path.join(sb.root, 'logs', 'model-tests'), { recursive: true });
    fs.writeFileSync(path.join(sb.root, 'logs', 'model-tests', '20261009T000001Z-claude-opus-5-5.log'), '# Test du model\nverdict : OK\n');
    const lg = await get('/api/model-tests/20261009T000001Z-claude-opus-5-5.log');
    assert(lg.status === 200 && /verdict : OK/.test(await lg.text()), 'journal de test non servi');
  });
  // 0.59.0 — « Protection puis redémarrage » : boucle locale + Tailscale, LAN refusé.
  await check(S, 'network-guard', 'Garde réseau du vrai server.js : boucle locale et Tailscale servis, IP LAN de la machine refusée (403)', async () => {
    const src = fs.readFileSync(path.join(sb.root, 'server.js'), 'utf8');
    if (!/networkGuard\.middleware/.test(src)) NA('garde réseau absente de cet état du code');
    const os = await import('node:os');
    const http = await import('node:http');
    const port = Number(new URL(sb.url).port);
    const status = (host) => new Promise((resolve) => {
      const rq = http.request({ host, port, path: '/api/version', localAddress: host === '127.0.0.1' ? undefined : host, timeout: 5000 }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      rq.on('error', (e) => resolve(`erreur ${e.code}`)); rq.on('timeout', () => { rq.destroy(); resolve('délai'); }); rq.end();
    });
    const v4 = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    const lan = v4.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
    const ts = v4.find(a => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a));
    assert(await status('127.0.0.1') === 200, 'boucle locale refusée');
    const notes = [];
    if (lan) { const s = await status(lan); assert(s === 403, `IP LAN ${lan} : ${s} au lieu de 403`); notes.push(`LAN ${lan} → 403`); } else notes.push('pas d’IP LAN');
    if (ts) { const s = await status(ts); assert(s === 200, `IP Tailscale ${ts} : ${s} au lieu de 200`); notes.push(`Tailscale ${ts} → 200`); } else notes.push('pas d’IP Tailscale');
    return notes.join(', ');
  });
  // 0.58.0 — « redémarrage requis » et tâches du Routage en attente, visibles.
  await check(S, 'routage-pending', '/api/version (repoVersion, restartRequired) et /api/pupitre (restartRequired, routagePending)', async () => {
    const v = await json('/api/version');
    if (!('restartRequired' in v)) NA('champs absents de cet état du code');
    assert(v.repoVersion === v.version && v.restartRequired === false, `instance lancée depuis le dépôt : pas de redémarrage requis (${JSON.stringify(v)})`);
    const p = await json('/api/pupitre');
    assert(p.restartRequired === false && Array.isArray(p.routagePending), `pupitre : ${JSON.stringify({ r: p.restartRequired, n: p.routagePending })}`);
  });
  // 0.31.0 — arrêt par le chef présenté comme tel, « vu » persistant sans relance.
  await check(S, 'ack-stopped', 'Arrêt par le chef (motif, result parasite ignoré) puis « vu » : 200, 409, idle, événement dans le log', async () => {
    const probe = await post('/api/ack/nope', {});
    if (probe.status === 404 && !/unknown project/.test(await probe.text())) NA('route /api/ack absente de cet état du code');
    const ts = (s) => new Date(Date.now() - s * 1000).toISOString();
    fs.appendFileSync(path.join(sb.root, 'logs', 'lambda.jsonl'), [
      { type: 'user_prompt', text: 'Tâche de recette interminable', timestamp: ts(120) },
      { type: 'system', subtype: 'init', model: 'claude-opus-5-5', timestamp: ts(119) },
      { type: 'result', subtype: 'error_killed_by_conductor', is_error: true, stopped_by: 'chef', reason: 'boucle sans progrès', duration_ms: 0, timestamp: ts(10) },
      { type: 'result', subtype: 'error_model_unavailable', is_error: true, num_turns: 0, result: 'model demandé indisponible', timestamp: ts(10) },
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    let c = await json('/api/config');
    let l = c.projects.find(p => p.name === 'lambda');
    assert(l.currentState === 'error' && l.stopped?.reason === 'boucle sans progrès', `config : ${l.currentState} ${JSON.stringify(l.stopped)}`);
    const pu = await until(async () => { const p = await json('/api/pupitre'); const r = p.fleet.find(x => x.name === 'lambda'); return r?.stopped ? r : null; }, 8000);
    assert(pu && pu.stopped.by === 'chef', '/api/pupitre : stopped absent');
    assert((await post('/api/ack/beta', {})).status === 409, 'question : « vu » doit être refusé (409)');
    const a = await post('/api/ack/lambda', { by: 'regression' });
    const aj = await a.json();
    assert(a.status === 200 && aj.kind === 'stopped', `1er « vu » : ${a.status} ${JSON.stringify(aj)}`);
    assert((await post('/api/ack/lambda', {})).status === 409, '2e « vu » ≠ 409');
    assert(readLog('lambda').some(e => e.type === 'notification' && e.subtype === 'acknowledged' && e.of === 'stopped'), 'événement absent du log');
    c = await json('/api/config');
    l = c.projects.find(p => p.name === 'lambda');
    assert(l.currentState === 'idle' && !l.stopped, `après « vu » : ${l.currentState}`);
    assert((await post('/api/ack/nope', {})).status === 404, 'projet inconnu ≠ 404');
  });
  await check(S, 'journal', 'Journal d\'activité /api/project/:name/journal : tours, demande, issue, coût, version', async () => {
    const r = await get('/api/project/alpha/journal');
    if (r.status === 404) NA('route absente de cet état du code');
    const jA = await r.json();
    const t = jA.turns[0];
    assert(t && t.prompt === "Publier la version 1.2.3 de l'app" && t.outcome === 'ok', `alpha : ${JSON.stringify(t)}`);
    assert(Math.abs(t.costUsd - 0.42) < 1e-9 && t.versions.includes('1.2.3'), `coût/version : ${t.costUsd} ${t.versions}`);
    const g = (await json('/api/project/gamma/journal')).turns[0];
    assert(g.outcome === 'error' && g.subtype === 'error_max_turns', `gamma : ${g.outcome}`);
    const l = (await json('/api/project/lambda/journal')).turns[0];
    assert(l.outcome === 'stopped' && l.stop.reason === 'boucle sans progrès' && l.ack, `lambda : ${JSON.stringify(l)}`);
    // Incrémental : une ligne ajoutée apparaît sans relire tout le log (omega :
    // sans log jusqu'ici, aucun parcours ne dépend de son dernier tour).
    assert((await json('/api/project/omega/journal')).turns.length === 0, 'omega : aucun tour attendu');
    fs.appendFileSync(path.join(sb.root, 'logs', 'omega.jsonl'), JSON.stringify({ type: 'user_prompt', text: 'Tour ajouté', timestamp: new Date().toISOString() }) + '\n');
    const t2 = (await json('/api/project/omega/journal')).turns[0];
    assert(t2.prompt === 'Tour ajouté' && t2.outcome === 'running', `incrément : ${JSON.stringify(t2)}`);
    fs.appendFileSync(path.join(sb.root, 'logs', 'omega.jsonl'), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1200, result: 'Tour ajouté : fait.', timestamp: new Date().toISOString() }) + '\n');
    const t3 = await until(async () => { const x = (await json('/api/project/omega/journal')).turns[0]; return x?.outcome === 'ok' ? x : null; }, 3000);
    assert(t3 && t3.summary[0] === 'Tour ajouté : fait.', 'incrément : fin du tour');
    assert((await get('/api/project/nope/journal')).status === 404, 'projet inconnu ≠ 404');
    return `${jA.turns.length} tour(s) pour alpha`;
  });
  // 0.37.0 — exigence : « les demandes d'autorisations s'en aillent après validation ».
  await check(S, 'denials-ack', 'Refus d\'autorisation traités : /api/project/:name/denials/ack (200, événement dans le log, 400, 404)', async () => {
    const probe = await post('/api/project/nope/denials/ack', { toolIds: ['x'] });
    if (probe.status === 404 && !/unknown project/.test(await probe.text())) NA('route absente de cet état du code');
    const r = await post('/api/project/delta/denials/ack', { toolIds: ['toolu_http1', 'toolu_http2'], action: 'granted', tool: 'WebSearch', by: 'regression' });
    const j = await r.json();
    assert(r.status === 200 && j.ok && j.action === 'granted', `ack : ${r.status} ${JSON.stringify(j)}`);
    const ev = readLog('delta').find(e => e.type === 'notification' && e.subtype === 'denials_acknowledged');
    assert(ev && ev.toolIds.join() === 'toolu_http1,toolu_http2' && ev.tool === 'WebSearch' && ev.by === 'regression', 'événement absent ou incomplet');
    assert((await post('/api/project/delta/denials/ack', { toolIds: [] })).status === 400, 'liste vide ≠ 400');
    assert((await post('/api/project/delta/denials/ack', { toolIds: ['pas un id!'] })).status === 400, 'identifiant invalide ≠ 400');
    assert((await post('/api/project/nope/denials/ack', { toolIds: ['x'] })).status === 404, 'projet inconnu ≠ 404');
    const c = await json('/api/config');
    assert(c.projects.find(p => p.name === 'delta').currentState === 'unread', 'l\'acquittement d\'un refus ne change pas l\'état du musicien');
  });
  // 0.37.2 — exigence : un résumé long (20 Ko, markdown, accents, tableau)
  // passe du premier coup, envoyé par fichier (notify.mjs --file).
  await check(S, 'notify-long', 'Callback long par fichier : notify.mjs --file 20 Ko accentué → 200 du premier coup, texte intact, fichier supprimé ; 413 (pas 500) au-delà de la limite', async () => {
    const notifySrc = fs.readFileSync(path.join(sb.root, 'scripts', 'notify.mjs'), 'utf8');
    if (!notifySrc.includes("'--file'")) NA('notify.mjs --file absent de cet état du code');
    const row = '| étape | résultat élevé | « remarque » ça déborde ? |\n';
    let body = '# Résumé détaillé — tâche terminée\n\nÉté, août, œuvre, ç, ü, 中文, emoji ✓ → ⇄.\n\n| Colonne | Valeur | Commentaire |\n|---|---|---|\n';
    while (Buffer.byteLength(body) < 20 * 1024) body += row;
    body += '\nFIN DU RÉSUMÉ LONG';
    const f = path.join(sb.root, '.orchestrateur-callback.md');
    fs.writeFileSync(f, body, 'utf8');
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(sb.root, 'scripts', 'notify.mjs'), 'chef', '--file', f, '--source', 'regression'], { cwd: sb.root });
      let out = '';
      c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
      c.on('close', code => resolve({ code, out }));
    });
    assert(r.code === 0 && /delivered/.test(r.out) && !/parts|HTTP 5/.test(r.out), `notify --file : exit ${r.code} — ${r.out.trim()}`);
    assert(!fs.existsSync(f), 'le fichier de résumé n\'a pas été supprimé après l\'envoi');
    const got = readLog('chef').filter(e => e.type === 'user_prompt' && e.source === 'regression').pop();
    assert(got && got.text === body.trim(), `texte reçu différent (${got ? got.text.length : 0} car. au lieu de ${body.trim().length})`);
    const direct = await post('/api/notify', { project: 'chef', text: body, source: 'regression' });
    assert(direct.status === 200, `POST direct 20 Ko : HTTP ${direct.status}`);
    const huge = await post('/api/notify', { project: 'chef', text: 'x'.repeat(600 * 1024), source: 'regression' });
    assert(huge.status === 413, `corps de 600 Ko : HTTP ${huge.status} (413 attendu, jamais 500)`);
    return `${Buffer.byteLength(body)} octets livrés en un envoi`;
  });
  // 0.45.0 — exigence : « Je n'ai pas vu de moyen d'autoriser (1 fois, pour
  // toujours) … un overlay avec tous les details … attendre ma reponse pendant
  // au moins 5 minutes ». Copie de dispatch.mjs de l'instance + faux claude qui
  // lance le vrai permission-mcp.mjs.
  await check(S, 'permission-prompt', 'Autorisations interactives : tour en attente (carte, supervision, chef prévenu), explication de la commande sur la carte, dans les détails et dans le message au chef (0.78.0), détails complets masqués, une fois / refus motivé / toujours (puis sans demande) / expiration, origine étrangère 403', async () => {
    if ((await get('/api/permissions')).status === 404) NA('route absente de cet état du code');
    const runDispatch = (prompt, extra) => {
      const env = { ...serverEnv(sb.root, sb.port), FAKE_CLAUDE_LATENCY_MS: '20', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_POLL_MS: '150', ...extra };
      const c = spawn(process.execPath, [path.join(sb.root, 'scripts', 'dispatch.mjs'), 'omega', prompt], { cwd: sb.root, env, windowsHide: true });
      let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
      return { c, done: new Promise(r => c.on('exit', code => r({ code, out }))) };
    };
    const pendingOmega = () => until(async () => (await json('/api/permissions')).pending.find(p => p.project === 'omega') || null, 20000);
    const lastRes = () => readLog('omega').filter(e => e.type === 'result').pop()?.result || '';
    const SECRET = 'sk-ant-api03-REGRESSIONSECRETVALUE77';
    // 1. Une fois
    let d = runDispatch('recette autorisation', { FAKE_CLAUDE_PERM: `Bash|${JSON.stringify({ command: `npm run build && node deploy.js --token ${SECRET} ${'y'.repeat(2500)} FIN` })}` });
    let p = await pendingOmega();
    assert(p && p.tool === 'Bash' && p.deadline - p.createdAt >= 5 * 60_000 - 1000, `carte : ${JSON.stringify(p)}`);
    const det = await json(`/api/permission/${p.id}/details`);
    const cmd = det.request.blocks.find(b => b.label === 'Commande')?.text || '';
    assert(cmd.includes('y'.repeat(2500)) && cmd.endsWith('FIN'), 'entrée incomplète dans les détails');
    assert(!JSON.stringify(det).includes(SECRET), 'secret en clair dans les détails');
    const row = await until(async () => (await json('/api/pupitre')).fleet.find(r => r.name === 'omega' && r.awaitingPermission) || null, 8000);
    assert(row && row.state === 'live' && !row.stalled, `pupitre : ${JSON.stringify(row && { s: row.state, a: row.awaitingPermission })}`);
    assert(readLog('chef').some(e => e.type === 'user_prompt' && e.source === 'permission' && /omega/.test(e.text)), 'chef non prévenu');
    // 0.78.0 — « Il faut aussi donner une explication de celle-ci » : the card,
    // the details and the chef's message explain the command, not only show it.
    if (p.explanation !== undefined) {
      const what = 'Cette commande lance le script « build » du projet, puis exécute le script deploy.js avec Node.js.';
      assert(p.explanation?.what === what && det.request.explanation?.what === what, `explication : ${JSON.stringify(p.explanation)}`);
      assert(!JSON.stringify(p.explanation).includes(SECRET), 'secret en clair dans l’explication');
      const told = await until(() => readLog('chef').find(e => e.type === 'user_prompt' && e.source === 'permission' && /omega/.test(e.text) && e.text.includes(what)) || null, 8000);
      assert(told && /Explication :/.test(told.text), `message au chef sans explication : ${readLog('chef').filter(e => e.source === 'permission').pop()?.text}`);
    }
    const foreign = await fetch(`${sb.url}/api/permission/${p.id}/decide`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ decision: 'allow_once' }) });
    assert(foreign.status === 403, `origine étrangère : ${foreign.status}`);
    assert((await post(`/api/permission/${p.id}/decide`, { decision: 'allow_once' })).status === 200, 'décision refusée');
    let r = await d.done;
    assert(r.code === 0 && /PERM_RESULT: allow/.test(lastRes()), `une fois : ${r.code} ${lastRes().slice(-120)}`);
    // 2. Refus motivé
    d = runDispatch('recette refus', { FAKE_CLAUDE_PERM: `Write|${JSON.stringify({ file_path: path.join(sb.root, '..', 'hors.txt'), content: 'x' })}` });
    p = await pendingOmega();
    await post(`/api/permission/${p.id}/decide`, { decision: 'deny', message: 'reste dans le projet' });
    await d.done;
    assert(/Motif de l'utilisateur : reste dans le projet/.test(lastRes()), `refus : ${lastRes().slice(-160)}`);
    // 3. Toujours, puis sans demande
    const perm = `Bash|${JSON.stringify({ command: 'git log --oneline' })}`;
    d = runDispatch('recette toujours', { FAKE_CLAUDE_PERM: perm });
    p = await pendingOmega();
    assert(p.suggestions[0].rule === 'Bash(git log:*)', `portée : ${p.suggestions[0].rule}`);
    assert((await post(`/api/permission/${p.id}/decide`, { decision: 'allow_always', rule: 'Bash(git log:*)' })).status === 200, 'toujours refusé');
    await d.done;
    const nReq = readLog('omega').filter(e => e.subtype === 'permission_request').length;
    r = await runDispatch('recette règle', { FAKE_CLAUDE_PERM: perm }).done;
    assert(r.code === 0 && /PERM_RESULT: allow/.test(lastRes()) && readLog('omega').filter(e => e.subtype === 'permission_request').length === nReq, 'la règle n\'a pas évité la demande');
    assert((await json('/api/permission-rules')).rules.omega?.some(x => x.rule === 'Bash(git log:*)'), 'règle non listée');
    const del = await fetch(`${sb.url}/api/permission-rules`, { method: 'DELETE', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'omega', rule: 'Bash(git log:*)' }) });
    assert(del.status === 200, `révocation : ${del.status}`);
    // 4. Expiration (délai court)
    r = await runDispatch('recette expiration', { FAKE_CLAUDE_PERM: `Bash|${JSON.stringify({ command: 'mkdir a && cd a' })}`, ORCH_PERM_TIMEOUT_MS: '2000' }).done;
    assert(r.code === 0 && /EXPIRÉE SANS RÉPONSE/.test(lastRes()), `expiration : ${lastRes().slice(-160)}`);
    assert(readLog('omega').some(e => e.subtype === 'permission_decision' && e.permission?.decision === 'expired'), 'expiration non journalisée');
    return '4 parcours : une fois, refus motivé, toujours puis sans demande, expiration';
  });
  // 0.48.0 — pipelines, phase 3 (exigence : « il faut faire en sorte que ces
  // pipelines soient obligatoirement utilisés »). omega devient un petit dépôt
  // git en service ; le faux claude joue les étapes (FAKE_CLAUDE_PIPELINE).
  const omegaDir = path.join(sb.root, 'projects', 'omega');
  const routingFile = path.join(sb.root, 'model-routing.json');
  // Les notifications du moteur (pause, limite) vont à un écouteur local : un
  // vrai réveil du chef de l'instance ajouterait des bulles au fil et décalerait
  // les parcours navigateur qui le lisent. Le contenu reçu est vérifié.
  const notices = [];
  const noticeSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { try { notices.push({ path: req.url, ...JSON.parse(b) }); } catch { /* corps illisible */ } res.end('{}'); });
  });
  await new Promise(r => noticeSrv.listen(0, '127.0.0.1', r));
  noticeSrv.unref();
  const noticePort = noticeSrv.address().port;
  const pipeDispatch = (args, extra = {}) => new Promise((resolve) => {
    const env = { ...serverEnv(sb.root, sb.port), FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_LATENCY_MS: '10', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_DISABLE: '1', ORCH_PORT: String(noticePort), ...extra };
    const c = spawn(process.execPath, [path.join(sb.root, 'scripts', 'dispatch.mjs'), ...args], { cwd: sb.root, env, windowsHide: true });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
    c.on('exit', code => resolve({ code, out }));
  });
  const omegaRepo = () => {
    const g = (...a) => spawnSync('git', ['-c', 'user.name=r', '-c', 'user.email=r@localhost', ...a], { cwd: omegaDir, encoding: 'utf8' });
    if (fs.existsSync(path.join(omegaDir, '.git'))) return g;
    fs.writeFileSync(path.join(omegaDir, 'package.json'), JSON.stringify({ name: 'omega', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
    fs.mkdirSync(path.join(omegaDir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(omegaDir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
    fs.mkdirSync(path.join(omegaDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(omegaDir, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
    fs.writeFileSync(path.join(omegaDir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
    fs.mkdirSync(path.join(omegaDir, '.orchestrateur'), { recursive: true });
    fs.writeFileSync(path.join(omegaDir, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
    fs.mkdirSync(path.join(omegaDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(omegaDir, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
    return g;
  };
  // 0.66.0: routing is decided by the classifier model only — the fixture assigns its slot.
  const enforceOmega = (assignments = {}) => fs.writeFileSync(routingFile, JSON.stringify({ version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...assignments }, history: [], enforcement: { projects: ['omega'], pipelines: ['discussion', 'dev'] } }));
  const runsOf = async () => (await json('/api/pipeline-runs?project=omega')).runs || [];
  await check(S, 'pipeline-run', 'Pipelines, phase 3 : une demande au projet en service passe par son pipeline (Discussion, Développement léger) — une étape = un tour, artefacts, critères vérifiés par le code, un seul tour côté musicien, frise dans le journal', async () => {
    if ((await get('/api/pipeline-enforcement')).status === 404) NA('moteur absent de cet état du code');
    const g = omegaRepo();
    enforceOmega();
    const enf = await json('/api/pipeline-enforcement');
    assert(enf.projects.includes('omega') && enf.inService.includes('dev'), `mise en service : ${JSON.stringify(enf)}`);
    const h0 = g('rev-parse', 'HEAD').stdout.trim();
    // Par l'API (le serveur lance dispatch.mjs, qui classe et route).
    let r = await post('/api/dispatch', { project: 'omega', prompt: 'Pourquoi la suite de tests passe-t-elle ?', queueIfBusy: true });
    assert(r.status === 202, `dispatch : ${r.status}`);
    let run = await until(async () => (await runsOf()).find(x => x.pipeline === 'discussion' && x.status !== 'running') || null, 90_000);
    assert(run?.status === 'done' && run.steps.filter(s => s.status === 'ok').length === 3, `Discussion : ${JSON.stringify(run && { s: run.status, st: run.steps.map(x => `${x.id}:${x.status}:${x.why || ''}`) })}`);
    r = await pipeDispatch(['omega', 'Ajoute une fonction double qui multiplie par deux', '--mode', 'leger']);
    run = (await runsOf()).find(x => x.pipeline === 'dev');
    assert(r.code === 0 && run?.status === 'done' && run.steps.map(s => s.id).join() === 'rouge,vert,revue,livrer', `Développement léger : ${r.code} ${JSON.stringify(run?.steps?.map(x => `${x.id}:${x.status}`))} ${r.out.slice(-300)}`);
    assert(g('rev-list', '--count', `${h0}..HEAD`).stdout.trim() === '1', 'un seul commit attendu');
    const turns = (await json('/api/project/omega/journal?n=5')).turns || [];
    assert(turns[0]?.pipeline?.pipeline === 'dev' && turns[0].pipeline.steps.length === 4 && turns[1]?.pipeline?.pipeline === 'discussion', 'journal : frises absentes');
    assert(readLog('omega').filter(e => e.type === 'user_prompt' && e.pipeline).length >= 2 && turns[0].pipeline.steps.every(s => s.source === 'project-default'), 'cases vides : défaut du projet attendu');
    return `Discussion 3/3 ✓, Développement léger 4/4 ✓ (commit ${g('log', '-1', '--format=%h').stdout.trim()})`;
  });
  await check(S, 'pipeline-bypass', 'Pipelines : rien ne contourne — tour de musicien, étape, jeton forgé, --model à la main refusés ; --hors-pipeline tracé ; pipeline gardé en file d’attente', async () => {
    if ((await get('/api/pipeline-enforcement')).status === 404) NA('moteur absent de cet état du code');
    omegaRepo(); enforceOmega();
    let r = await pipeDispatch(['omega', 'ajoute un bouton'], { ORCH_TURN_PROJECT: 'lambda' });
    assert(r.code === 65, `depuis le tour d’un musicien : ${r.code}`);
    r = await pipeDispatch(['lambda', 'ajoute un bouton'], { ORCH_TURN_PROJECT: 'omega', ORCH_TURN_STEP: 'p-20261009T120000-abcd:01-vert' });
    assert(r.code === 65, `depuis une étape : ${r.code}`);
    r = await pipeDispatch(['omega', 'x', '--pipeline-step', 'p-20261009T120000-abcd:01-vert'], { ORCH_STEP_TOKEN: 'v1.e30.' + 'a'.repeat(64) });
    assert(r.code === 65 && /jeton/.test(r.out), `jeton forgé : ${r.code}`);
    r = await pipeDispatch(['omega', 'ajoute un bouton', '--model', 'claude-opus-5-5']);
    assert(r.code === 64, `--model à la main : ${r.code}`);
    r = await pipeDispatch(['omega', 'corrige le bug du compteur', '--hors-pipeline', 'maintenance de la flotte']);
    const up = readLog('omega').filter(e => e.type === 'user_prompt').pop();
    assert(r.code === 0 && up?.pipelineBypass?.reason === 'maintenance de la flotte', `hors pipeline non tracé : ${JSON.stringify(up?.pipelineBypass)}`);
    // La file garde le pipeline : omega occupé (pid vivant), entrée en file, puis retirée.
    fs.writeFileSync(path.join(sb.root, 'logs', 'omega.pid'), String(process.pid));
    r = await post('/api/dispatch', { project: 'omega', prompt: 'ajoute une fonction carre', queueIfBusy: true, pipeline: 'dev' });
    const q = await json('/api/queue/omega');
    const entry = (q.entries || []).find(e => e.head === 'ajoute une fonction carre');
    fs.rmSync(path.join(sb.root, 'logs', 'omega.pid'), { force: true });
    if (entry) await fetch(`${sb.url}/api/queue/omega/${entry.id}`, { method: 'DELETE', headers: H });
    assert(r.status === 202 && entry?.pipeline === 'dev', `file : ${r.status} ${JSON.stringify(entry)}`);
    return '4 contournements refusés, hors pipeline tracé, pipeline conservé en file';
  });
  await check(S, 'pipeline-unavailable', 'Pipelines : model de la case indisponible → pause (question), fallback_refused, aucun autre model, étape suivante non lancée', async () => {
    if ((await get('/api/pipeline-enforcement')).status === 404) NA('moteur absent de cet état du code');
    omegaRepo(); enforceOmega({ 'discussion.rechercher': { provider: 'anthropic', model: 'claude-indispo-1' } });
    const r = await pipeDispatch(['omega', 'Pourquoi la suite de tests passe-t-elle ?'], { FAKE_CLAUDE_FAIL_MODEL: 'claude-indispo-1' });
    const run = (await runsOf()).find(x => x.pipeline === 'discussion');
    assert(r.code === 2 && run?.status === 'paused' && /indisponible/.test(run.question || ''), `pause attendue : ${r.code} ${JSON.stringify(run && { s: run.status, q: run.question })}`);
    assert(!run.steps.some(s => s.id === 'repondre'), 'l’étape suivante a été lancée');
    const row = await until(async () => (await json('/api/pupitre')).fleet.find(x => x.name === 'omega' && x.state === 'input') || null, 8000);
    assert(row, 'omega devrait attendre une réponse (input)');
    await post('/api/question/omega/resolve', { note: 'recette' });
    return 'pause sur model indisponible, question posée';
  });
  await check(S, 'pipeline-limit-notice', 'Pipelines : limite atteinte (3 essais de 4b refusés) → notification/pipeline_limit dans le log, question dans le dashboard, chef prévenu', async () => {
    if ((await get('/api/pipeline-enforcement')).status === 404) NA('moteur absent de cet état du code');
    const g = omegaRepo(); enforceOmega();
    // Repartir du commit initial : le parcours pipeline-run a déjà livré double().
    g('reset', '-q', '--hard', g('rev-list', '--max-parents=0', 'HEAD').stdout.trim());
    const nNotices = notices.length;
    const r = await pipeDispatch(['omega', 'Ajoute une fonction triple', '--mode', 'leger'], { FAKE_PIPE_BAD: 'vert' });
    const lim = readLog('omega').filter(e => e.subtype === 'pipeline_limit').pop();
    assert(r.code === 2 && lim?.limit === 'green' && /Limite atteinte/.test(lim.text), `signal du log : ${r.code} ${JSON.stringify(lim)}`);
    const row = await until(async () => (await json('/api/pupitre')).fleet.find(x => x.name === 'omega' && x.state === 'input') || null, 8000);
    assert(row, 'question absente du dashboard');
    const chef = notices.slice(nNotices).find(n => n.path === '/api/notify' && n.project === 'chef' && n.source === 'pipeline-limit');
    assert(chef && /omega/.test(chef.text) && /Limite atteinte/.test(chef.text), `chef non prévenu (POST /api/notify, source pipeline-limit) : ${JSON.stringify(notices.slice(nNotices))}`);
    await post('/api/question/omega/resolve', { note: 'recette' });
    spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: omegaDir });
    spawnSync('git', ['clean', '-qfd', '-e', '.orchestrateur'], { cwd: omegaDir });
    fs.rmSync(routingFile, { force: true });
    return 'les 3 signaux partent : log, dashboard, chef';
  });
  // 0.52.0 — phase 5 : TOUTES les entrées passent par un pipeline (demande utilisateur du 2026-10-09).
  const waitNewRun = async (before, ms = 120_000) => until(async () => {
    const all = await runsOf();
    const fresh = all.filter(x => !before.has(x.run));
    return fresh.length && fresh.every(x => x.status !== 'running') ? fresh[0] : null;
  }, ms, 500);
  const runFile = (run) => JSON.parse(fs.readFileSync(path.join(sb.root, 'logs', 'runs', run, 'run.json'), 'utf8'));
  await check(S, 'pipeline-all-entries', 'Pipelines, phase 5 : chaque entrée (API directe, app Android, session neuve, dispatch.mjs, relais du chef ; @mention et préfixe vers le chef en suite) lance une EXÉCUTION de pipeline ; classement par le model de la case routage.classifier ; pipeline pas en service → Discussion ; aucun tour hors pipeline', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'pipeline-classify.mjs'))) NA('phase 5 absente de cet état du code');
    const g = omegaRepo();
    g('reset', '-q', '--hard', g('rev-list', '--max-parents=0', 'HEAD').stdout.trim()); g('clean', '-qfd', '-e', '.orchestrateur');
    enforceOmega({ 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } });
    const done = [];
    const entry = async (label, fire, expect) => {
      const before = new Set((await runsOf()).map(x => x.run));
      const nLog = readLog('omega').length;
      const r = await fire();
      if (r && 'status' in r) assert(r.status === 202, `${label} : HTTP ${r.status}`);
      const run = await waitNewRun(before);
      assert(run, `${label} : aucune exécution de pipeline lancée`);
      const evs = readLog('omega').slice(nLog);
      assert(!evs.some(e => e.type === 'user_prompt' && !e.pipeline), `${label} : un tour hors pipeline a été écrit`);
      const st = runFile(run.run);
      expect?.(run, st);
      done.push(`${label}→${run.pipeline}${st.classification?.classifier ? `(${st.classification.classifier})` : '(choix explicite)'}`);
      return { run, st };
    };
    // E2 — API / dashboard directement vers le musicien, choix du sélecteur.
    await entry('API directe', () => post('/api/dispatch', { project: 'omega', prompt: 'Pourquoi la suite de tests passe-t-elle ?', pipeline: 'discussion' }),
      (run, st) => assert(run.pipeline === 'discussion' && !st.classification, 'choix explicite : pas de classement'));
    // E3 — app Android vers le musicien : l'entrée est observée « android:musicien ».
    // (La @mention et le préfixe vers le chef sont couverts par _test_pipeline_entries.mjs :
    // un tour du chef ici pousserait l'historique de référence hors de la fenêtre du fil.)
    const nObs = fs.readFileSync(path.join(sb.root, 'logs', 'pipeline-observe.ndjson'), 'utf8').split('\n').length;
    await entry('Android', () => fetch(sb.url + '/api/dispatch', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'User-Agent': 'okhttp/4.12.0' },
      body: JSON.stringify({ project: 'omega', prompt: 'Pourquoi le dépôt a-t-il un seul commit ?', pipeline: 'discussion' }) }));
    const obsTail = fs.readFileSync(path.join(sb.root, 'logs', 'pipeline-observe.ndjson'), 'utf8').split('\n').slice(nObs - 1).filter(Boolean).map(l => JSON.parse(l));
    assert(obsTail.some(o => o.entry === 'android:musicien'), 'entrée Android non observée');
    // E12 — session neuve sur un projet en service : exécution, pas d'attente de sidecar.
    let sn;
    await entry('session neuve', async () => { sn = await post('/api/projects/omega/sessions/new', { prompt: 'Pourquoi src/pipe.mjs existe-t-il ?' }); return sn; });
    assert((await sn.json()).pipeline === true, 'session neuve : réponse « pipeline » attendue');
    // E4/E5 — dispatch.mjs sans choix : classement par le model de la case.
    const classifyLog = path.join(sb.root, 'logs', 'pipeline-classify.ndjson');
    await entry('dispatch.mjs', () => pipeDispatch(['omega', 'Explique le rôle du fichier src/pipe.mjs']), (run, st) => {
      assert(st.classification?.classifier === 'model:claude-haiku-5-5', `classement : ${JSON.stringify(st.classification)}`);
      const rec = fs.readFileSync(classifyLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop();
      assert(rec?.ok && rec.model === 'claude-haiku-5-5' && !('agree' in rec), `décision du model non journalisée : ${JSON.stringify(rec)}`);
    });
    // E10 — réponse du chef relayée au musicien.
    await entry('relais du chef', () => pipeDispatch(['omega', '[CHEF_ANSWER] Pourquoi garder un seul fichier source ?', '--source', 'chef']));
    // Pipeline pas encore en service → Discussion, notée (plus aucun tour ordinaire).
    await entry('pas en service', () => pipeDispatch(['omega', 'Compare les bibliothèques de tests'], { FAKE_CLAUDE_CLASSIFY: '{"pipeline":"recherche","mode":"complet","raison":"comparatif"}' }),
      (run, st) => assert(run.pipeline === 'discussion' && st.classification?.notInService === 'recherche', `pas en service : ${JSON.stringify(st.classification)}`));
    // 0.66.0 — réponse du classifieur illisible deux fois : PAUSE avec question,
    // demande gardée, aucune exécution, jamais de classement par mots-clés.
    {
      const before = new Set((await runsOf()).map(x => x.run));
      const nLog = readLog('omega').length;
      const r = await pipeDispatch(['omega', 'Pourquoi node --test ?'], { FAKE_CLAUDE_CLASSIFY: 'je ne sais pas' });
      const evs = readLog('omega').slice(nLog);
      const res = evs.filter(e => e.type === 'result').pop()?.result || '';
      assert(r.code === 2 && !(await runsOf()).some(x => !before.has(x.run)) && /NEEDS_USER_INPUT:.*« continuer »/.test(res), `classifieur en échec : pause attendue (code ${r.code}) ${res.slice(0, 200)}`);
      const pend = JSON.parse(fs.readFileSync(path.join(sb.root, 'logs', 'omega.a-classer.json'), 'utf8'));
      assert(pend[0]?.prompt === 'Pourquoi node --test ?', 'demande non gardée');
      const ab = await pipeDispatch(['omega', 'abandonner']);
      assert(ab.code === 0 && !fs.existsSync(path.join(sb.root, 'logs', 'omega.a-classer.json')), '« abandonner » n’a pas oublié la demande gardée');
      done.push('classifieur en échec→pause (demande gardée, puis abandonnée)');
    }
    return `${done.length} entrées → exécutions : ${done.join(', ')}`;
  });
  await check(S, 'terminal-routing', 'Pipelines, phase 5 : terminal interactif routé — Discussion en lecture seule, ligne d’action retenue puis lancée en exécution après confirmation, commande shell directe jamais envoyée', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'terminal-route.mjs'))) NA('phase 5 absente de cet état du code');
    const { decodeFrames } = await import(pathToFileURL(path.join(sb.root, 'scripts', 'terminal-route.mjs')).href);
    const g = omegaRepo();
    g('reset', '-q', '--hard', g('rev-list', '--max-parents=0', 'HEAD').stdout.trim()); g('clean', '-qfd', '-e', '.orchestrateur');
    fs.writeFileSync(routingFile, JSON.stringify({ version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } }, history: [], enforcement: { projects: ['omega'], pipelines: ['discussion', 'dev'], terminal: true } }));
    const ws = new WebSocket(`ws://127.0.0.1:${sb.port}/ws/pty?token=${sb.token}`);
    let all = '';
    ws.onmessage = (m) => { all += typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8'); };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket refusé')); });
    const frames = () => decodeFrames(all);
    const send = (o) => ws.send(JSON.stringify(o));
    try {
      await until(async () => /ARGS /.test(all) || null, 15_000);
      const args = /ARGS (\[.*?\])\r\n/.exec(all)?.[1] || '';
      assert(/--permission-mode","plan"/.test(args) && /Edit,Write/.test(args), `terminal pas en Discussion lecture seule : ${args}`);
      send({ type: 'input', data: 'Pourquoi la suite de tests passe ?\r' });
      assert(await until(async () => /RECU:Pourquoi la suite de tests passe \?/.test(all) || null, 8000), 'ligne de discussion non transmise');
      const before = new Set((await runsOf()).map(x => x.run));
      send({ type: 'input', data: '@omega ajoute une fonction moitie qui divise par deux\r' });
      const conf = await until(async () => frames().find(f => f.type === 'route-confirm' && !f.shell) || null, 8000);
      assert(conf?.target === 'omega' && conf.pipeline === 'dev' && !/RECU:@omega/.test(all), `ligne d’action non retenue : ${JSON.stringify(conf)}`);
      send({ type: 'route', id: conf.id, action: 'run' });
      const doneF = await until(async () => frames().find(f => f.type === 'route-done' && f.id === conf.id) || null, 8000);
      assert(doneF?.ok && doneF.result?.project === 'omega' && /EFFACE/.test(all), `confirmation : ${JSON.stringify(doneF)}`);
      const run = await waitNewRun(before);
      assert(run?.pipeline === 'dev' && /moitie/.test(runFile(run.run).request || ''), `aucune exécution lancée depuis le terminal : ${JSON.stringify(run)}`);
      send({ type: 'input', data: '!del src\\pipe.mjs\r' });
      const sh = await until(async () => frames().find(f => f.type === 'route-confirm' && f.shell) || null, 8000);
      assert(sh && !sh.actions.includes('discuss'), `commande shell : ${JSON.stringify(sh)}`);
      send({ type: 'route', id: sh.id, action: 'discuss' });
      const shDone = await until(async () => frames().find(f => f.type === 'route-done' && f.id === sh.id) || null, 8000);
      assert(shDone?.action === 'cancel' && !/RECU:!del/.test(all), `commande shell transmise : ${JSON.stringify(shDone)}`);
      return `discussion transmise, action retenue puis exécution ${run.run} (dev), « !… » annulée d’office`;
    } finally {
      try { ws.close(); } catch {}
      fs.rmSync(routingFile, { force: true });
    }
  });
  // 0.53.0 — phase 6, lot A : les autres pipelines (Recherche, Maintenance… ; les 7 sont couverts par _test_pipeline_catalog.mjs).
  await check(S, 'pipeline-catalog', 'Pipelines, phase 6 (lot A) : une demande classée « recherche » part en exécution Recherche par l’API (sources exigées, lecture seule, synthèse = réponse) ; Maintenance lancée par dispatch.mjs va jusqu’à la livraison ; frises au journal', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'pipeline-catalog.mjs'))) NA('catalogue absent de cet état du code');
    const { ENGINE_PIPELINES } = await import(pathToFileURL(path.join(sb.root, 'scripts', 'pipeline-engine.mjs')).href);
    const g = omegaRepo();
    g('reset', '-q', '--hard', g('rev-list', '--max-parents=0', 'HEAD').stdout.trim()); g('clean', '-qfd', '-e', '.orchestrateur');
    fs.writeFileSync(routingFile, JSON.stringify({ version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } }, history: [], enforcement: { projects: ['omega'], pipelines: ENGINE_PIPELINES } }));
    const h0 = g('rev-parse', 'HEAD').stdout.trim();
    let before = new Set((await runsOf()).map(x => x.run));
    // Recherche chosen explicitly: a server-launched dispatch cannot be given a scripted model answer.
    const r = await post('/api/dispatch', { project: 'omega', prompt: '/recherche fais un état de l\'art comparatif des bibliothèques de tests et donne les sources' });
    assert(r.status === 202, `dispatch : ${r.status}`);
    const rech = await waitNewRun(before, 150_000);
    assert(rech?.pipeline === 'recherche' && rech.status === 'done' && rech.steps.filter(s => s.status === 'ok').length === 5, `Recherche : ${JSON.stringify(rech && { p: rech.pipeline, s: rech.status, st: rech.steps.map(x => `${x.id}:${x.status}:${x.why || ''}`) })}`);
    const res = readLog('omega').filter(e => e.type === 'result').pop();
    assert(/https?:\/\//.test(res?.result || '') && g('rev-parse', 'HEAD').stdout.trim() === h0, 'synthèse sans source, ou commit inattendu');
    before = new Set((await runsOf()).map(x => x.run));
    const m = await pipeDispatch(['omega', 'fais la maintenance du projet', '--pipeline', 'maintenance'], { FAKE_PIPE_NOTHING: 'dependances,tests-instables' });
    const maint = (await runsOf()).find(x => !before.has(x.run));
    assert(m.code === 0 && maint?.status === 'done' && maint.steps.map(s => s.id).join() === 'dependances,historique,tests-instables,dette,livrer', `Maintenance : ${m.code} ${JSON.stringify(maint?.steps?.map(x => `${x.id}:${x.status}`))} ${m.out.slice(-300)}`);
    assert(g('rev-list', '--count', `${h0}..HEAD`).stdout.trim() === '1', 'un commit de livraison attendu');
    const turns = (await json('/api/project/omega/journal?n=4')).turns || [];
    assert(turns[0]?.pipeline?.pipeline === 'maintenance' && turns[1]?.pipeline?.pipeline === 'recherche', `journal : ${turns.slice(0, 2).map(t => t.pipeline?.pipeline).join(', ')}`);
    fs.rmSync(routingFile, { force: true });
    return `Recherche 5/5 par l’API (choisie par préfixe explicite), Maintenance livrée (commit ${g('log', '-1', '--format=%h').stdout.trim()}), frises au journal`;
  });
  // 0.54.0 — phase 6, lot B : le tour du chef est lui-même un pipeline (Routage).
  await check(S, 'pipeline-routage', 'Pipelines, phase 6 (lot B) : avec « chef » en service, un message au chef passe par le pool et devient une exécution Routage (Lire → Comprendre → Découper → Classer chaque tâche → … → Rapporter, étapes sur leurs cases) ; la réponse arrive dans le fil du chef ; interrupteur coupé = tour ordinaire', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'pipeline-catalog.mjs')) || !/routage/.test(fs.readFileSync(path.join(sb.root, 'scripts', 'pipeline-catalog.mjs'), 'utf8'))) NA('Routage absent de cet état du code');
    const { ENGINE_PIPELINES } = await import(pathToFileURL(path.join(sb.root, 'scripts', 'pipeline-engine.mjs')).href);
    // Cases vides : la doublure de claude n'annonce pas le model demandé (un model
    // affecté serait refusé, « aucun repli ») ; le model de case est couvert par la suite.
    fs.writeFileSync(routingFile, JSON.stringify({ version: 2, history: [], assignments: {}, enforcement: { projects: ['omega'], pipelines: ENGINE_PIPELINES, chef: true } }));
    try {
      const chefRuns = async () => (await json('/api/pipeline-runs?project=chef')).runs || [];
      const before = new Set((await chefRuns()).map(x => x.run));
      const r = await post('/api/dispatch', { project: 'chef', prompt: 'Pourquoi le projet omega a-t-il un seul commit ? (recette Routage)' });
      assert(r.status === 202, `dispatch chef : ${r.status}`);
      const run = await until(async () => (await chefRuns()).find(x => !before.has(x.run) && x.status !== 'running') || null, 150_000, 500);
      assert(run?.pipeline === 'routage' && run.status === 'done', `Routage : ${JSON.stringify(run && { s: run.status, st: run.steps.map(x => `${x.id}:${x.status}:${x.why || ''}`) })}`);
      const ids = run.steps.map(s => `${s.id}:${s.status}`).join(' ');
      assert(/lire:ok (comprendre:ok decomposer:skipped classifier:skipped|classifier:ok decomposer:skipped) affecter:skipped dispatcher:skipped rapporter:ok/.test(ids), `étapes : ${ids}`);
      const chat = await json('/api/conductor-chat');
      const last = chat.filter(m => m.role === 'conductor').pop();
      assert(last && /Rapport simulé/.test(last.text), `réponse du chef absente du fil : ${JSON.stringify(last)}`);
      // Le serveur clôt le ticket en lisant le result dans le log (observateur
      // de fichiers) : un court délai après la fin de l'exécution est normal.
      const closed = await until(async () => { const p = (await json('/api/pupitre')).pool; return !p.queue.length && p.slots.every(s => !s.ticket) ? p : null; }, 20_000, 500);
      assert(closed, `ticket du pool non clos : ${JSON.stringify((await json('/api/pupitre')).pool)}`);
      return `message → pool → Routage ${run.run} (${ids}) → réponse dans le fil, ticket clos`;
    } finally {
      fs.rmSync(routingFile, { force: true });
      // Le chef ne doit jamais rester en question pour les parcours suivants.
      try { await post('/api/question/chef/resolve', { note: 'recette Routage' }); } catch { /* rien à acquitter */ }
    }
  });
  // 0.55.0 — phase 6, lot C : Images / Vidéo / Audio (fichiers produits vérifiés par le code).
  await check(S, 'pipeline-media', 'Pipelines, phase 6 (lot C) : une demande classée « images » part en exécution Images par l’API — fichier produit réellement ouvert et vérifié (signature, dimensions), vérification visuelle, livraison ; frise au journal', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'media-check.mjs'))) NA('pipelines média absents de cet état du code');
    const { ENGINE_PIPELINES } = await import(pathToFileURL(path.join(sb.root, 'scripts', 'pipeline-engine.mjs')).href);
    const g = omegaRepo();
    g('reset', '-q', '--hard', g('rev-list', '--max-parents=0', 'HEAD').stdout.trim()); g('clean', '-qfd', '-e', '.orchestrateur');
    fs.writeFileSync(routingFile, JSON.stringify({ version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } }, history: [], enforcement: { projects: ['omega'], pipelines: ENGINE_PIPELINES } }));
    try {
      const before = new Set((await runsOf()).map(x => x.run));
      // 0.66.0: « images » chosen explicitly (a server-launched dispatch cannot be given a
      // scripted classifier answer); the variant is chosen by the classifier model.
      const r = await post('/api/dispatch', { project: 'omega', prompt: '/images génère une image : dessine une icône pour le projet' });
      assert(r.status === 202, `dispatch : ${r.status}`);
      const run = await waitNewRun(before, 150_000);
      assert(run?.pipeline === 'images' && run.status === 'done' && run.steps.map(s => `${s.id}:${s.status}`).join() === 'cadrer:ok,produire:ok,verifier:ok,livrer:ok', `Images : ${JSON.stringify(run && { p: run.pipeline, s: run.status, st: run.steps.map(x => `${x.id}:${x.status}:${x.why || ''}`) })}`);
      const png = path.join(omegaDir, 'media', 'produire.png');
      assert(fs.existsSync(png) && fs.readFileSync(png).readUInt32BE(0) === 0x89504e47, 'fichier image absent ou invalide');
      const turns = (await json('/api/project/omega/journal?n=2')).turns || [];
      assert(turns[0]?.pipeline?.pipeline === 'images', `journal : ${turns[0]?.pipeline?.pipeline}`);
      return `Images 4/4 (classée automatiquement), ${path.relative(omegaDir, png)} vérifié, livré (commit ${g('log', '-1', '--format=%h').stdout.trim()})`;
    } finally { fs.rmSync(routingFile, { force: true }); }
  });
  // 0.76.0 — git graph of each musician, read-only (side panel).
  await check(S, 'git-graph', 'Arbre git des musiciens : GET /api/git-graph (projets de config.json, dépôt ou non) et /api/git-graph/:projet (commits, branches, tags, HEAD, voies) ; lecture seule — refs, HEAD et index inchangés, aucune route d’écriture, projet hors liste refusé', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'git-graph-core.mjs'))) NA('graphe git absent de cet état du code');
    const g = omegaRepo();
    g('tag', '-f', 'recette-git', 'HEAD');
    const state = () => ({ refs: g('for-each-ref', '--format=%(refname) %(objectname)').stdout, head: fs.readFileSync(path.join(omegaDir, '.git', 'HEAD'), 'utf8'), index: fs.statSync(path.join(omegaDir, '.git', 'index')).mtimeMs });
    const before = state();
    const list = await json('/api/git-graph');
    const by = Object.fromEntries(list.projects.map(p => [p.name, p]));
    assert(by.omega?.repo === true && by.alpha?.repo === false, `liste : ${JSON.stringify(list.projects.slice(0, 4))}`);
    const d = await json('/api/git-graph/omega?n=20');
    assert(d.repo && d.commits.length >= 1 && d.layout.rows.length === d.commits.length && !!d.head, `graphe omega : ${JSON.stringify({ n: d.commits?.length, head: d.head, err: d.error })}`);
    assert(d.commits.some(c => c.refs.tags.includes('recette-git')) && d.commits[0].refs.head, 'tag ou HEAD absents');
    assert(d.layout.segments.every(s => s.r2 === s.r1 + 1), 'segments');
    assert((await json('/api/git-graph/alpha')).repo === false, 'projet sans dépôt');
    assert((await get('/api/git-graph/..%2F..%2Fsecret')).status === 404 && (await get('/api/git-graph/inconnu')).status === 404, 'projet hors liste accepté');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await fetch(sb.url + '/api/git-graph/omega', { method, headers: { ...H, 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : '{"cmd":"reset"}' });
      assert(r.status === 404, `${method} /api/git-graph/omega → ${r.status} (aucune opération git ne doit exister)`);
    }
    const one = await json('/api/git-graph/omega?n=1');
    assert(one.commits.length === 1 && (one.truncated || d.commits.length === 1), 'fenêtre n');
    const after = state();
    assert(after.refs === before.refs && after.head === before.head && after.index === before.index, 'le dépôt a changé pendant la lecture');
    g('tag', '-d', 'recette-git');
    return `omega : ${d.commits.length} commits, HEAD ${d.head}, ${d.layout.lanes} voie(s) ; dépôt inchangé ; écritures : 404`;
  });
  // 0.97.0 — « une liste qui augmente au fur et a mesure et qui conduira a la
  // release note en fonction de ce qui est pret ».
  await check(S, 'release-list', 'Liste menant à la release note : GET /api/release et /api/release/:projet — la liste s’allonge quand une version ou une entrée [Unreleased] arrive dans le CHANGELOG, la release note ne reprend que le « prêt » (versions après la dernière release, trouvée seule : dernier tag v*), lecture seule', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'release-notes.mjs'))) NA('liste de release absente de cet état du code');
    const g = omegaRepo();
    const cl = path.join(omegaDir, 'CHANGELOG.md');
    const write = (blocks) => fs.writeFileSync(cl, ['# Changelog', '', ...blocks].join('\n') + '\n');
    const V = (v, line) => `## [${v}] - 2026-10-1${v.at(-1)}\n\n### Added\n\n- ${line}\n`;
    g('tag', '-f', 'v1.0.0', 'HEAD');
    try {
      write([V('1.0.0', 'Premier jet publié')]);
      let d = await json('/api/release/omega');
      assert(d.changelog && d.release?.source === 'tag' && d.release.version === '1.0.0' && d.counts.ready === 0 && !d.note, `départ : ${JSON.stringify({ rel: d.release, c: d.counts })}`);
      write([V('1.1.0', 'RECETTE-PRET-1'), V('1.0.0', 'Premier jet publié')]);
      d = await json('/api/release/omega');
      assert(d.counts.ready === 1 && d.note.includes('RECETTE-PRET-1') && !d.note.includes('Premier jet publié'), `1 version prête : ${JSON.stringify(d.counts)} ${d.note}`);
      write(['## [Unreleased]\n\n### Fixed\n\n- RECETTE-EN-COURS\n', V('1.2.0', 'RECETTE-PRET-2'), V('1.1.0', 'RECETTE-PRET-1'), V('1.0.0', 'Premier jet publié')]);
      d = await json('/api/release/omega');
      assert(d.counts.ready === 2 && d.counts.progress >= 1 && d.items.some(i => i.state === 'progress' && /RECETTE-EN-COURS/.test(i.text)), `la liste s’allonge : ${JSON.stringify(d.counts)}`);
      assert(d.note.includes('RECETTE-PRET-1') && d.note.includes('RECETTE-PRET-2') && !d.note.includes('RECETTE-EN-COURS'), `release note = prêt seulement : ${d.note}`);
      const list = await json('/api/release');
      assert(list.projects.find(p => p.name === 'omega')?.changelog === true && list.projects.find(p => p.name === 'beta')?.changelog === false, 'liste des musiciens');
      assert((await get('/api/release/inconnu')).status === 404, 'projet hors liste accepté');
      for (const method of ['POST', 'PUT', 'DELETE']) assert((await fetch(sb.url + '/api/release/omega', { method, headers: H })).status === 404, `${method} /api/release/omega accepté`);
      return `omega : départ v1.0.0 (tag), puis ${d.counts.ready} entrées prêtes et ${d.counts.progress} en cours ; note sans l’en-cours`;
    } finally { g('tag', '-d', 'v1.0.0'); fs.rmSync(cl, { force: true }); }
  });
  // 0.100.0 — « Je parle de voir comment une requete utilisateur a ete decoupee
  // en taches atomiques, et voir le progres de ces taches, meme detachees ».
  await check(S, 'requests-map', 'Vue par requête : GET /api/requests et /api/requests/:run relient chaque requête au chef à toutes ses tâches atomiques (titre, musicien, « après », colonne) et donnent l’état de chacune là où elle est maintenant — terminée, détachée en cours, en attente, en file, renvoi au chef refusé, question, pipeline en pause avec sa progression — ; réveils exclus ; lecture seule', async () => {
    const fxFile = path.join(sb.root, 'tests', 'request-fixture.mjs');
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'request-map.mjs')) || !fs.existsSync(fxFile)) NA('vue par requête absente de cet état du code');
    const FX = await import(pathToFileURL(fxFile).href);
    const logsDir = path.join(sb.root, 'logs'), chefDir = path.join(sb.root, 'projects', 'chef');
    FX.writeRequestFixture({ logsDir, chefDir });
    try {
      const d = await json('/api/requests?n=40');
      const r = d.requests.find(x => x.run === FX.REQ_RUN);
      assert(r && r.total === 7 && r.request.startsWith('REQ-FIX-REQUEST'), `requête absente : ${JSON.stringify(d.requests.map(x => x.run))}`);
      const bad = Object.entries(FX.EXPECTED).filter(([n, e]) => { const t = r.tasks.find(x => x.n === +n); return !t || t.state !== e.state || t.level !== e.level; });
      assert(!bad.length, `états : ${r.tasks.map(t => `${t.n}:${t.state}/L${t.level}`).join(' ')}`);
      assert(r.tasks.find(t => t.n === 2).released && r.tasks.find(t => t.n === 7).pipelineRun?.done === 2, 'détachée ou progression du pipeline absente');
      assert(!d.requests.some(x => x.run === FX.CALLBACK_RUN) && d.states?.terminee?.label, 'réveil listé, ou libellés absents');
      const one = await json(`/api/requests/${FX.REQ_RUN}`);
      assert(one.request?.tasks?.length === 7, 'GET /api/requests/:run');
      assert((await get('/api/requests/pas-un-run')).status === 400 && (await get('/api/requests/p-20200101T000000-000000')).status === 404, 'identifiant invalide ou inconnu accepté');
      for (const method of ['POST', 'PUT', 'DELETE']) assert((await fetch(sb.url + `/api/requests/${FX.REQ_RUN}`, { method, headers: H })).status === 404, `${method} accepté`);
      return `${FX.REQ_RUN} : ${r.tasks.map(t => `${t.n} ${t.state}`).join(', ')}`;
    } finally { FX.removeRequestFixture({ logsDir, chefDir }); }
  });
  // 0.107.0 — user request (2026-10-16): « il faut que toutes references a un
  // identifiant quelconque soit un lien qui ouvre un overlay qui decrit ou
  // explique ce qu'est cet identifiant ».
  await check(S, 'identify', 'Identifiants expliqués : GET /api/identify dit ce que désigne un identifiant à partir des vraies données (item TODO, commit, version, projet, fichier, case de la page Models), « inconnu » avec un message clair sinon, rien hors des projets ; GET /api/identify/vocab donne projets et cases au client ; lecture seule', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'id-resolve.mjs'))) NA('identifiants expliqués absents de cet état du code');
    const idf = (q) => json(`/api/identify?${new URLSearchParams(q)}`);
    let r = await idf({ id: 't-a10001' });
    assert(r.known && r.kind === 'todo' && r.project === 'alpha' && r.title && r.links.some(l => l.open === 'todo'), `item TODO : ${JSON.stringify(r).slice(0, 200)}`);
    const g = omegaRepo();
    const sha = g('rev-parse', 'HEAD').stdout.trim();
    const subject = g('log', '-1', '--format=%s').stdout.trim();
    r = await idf({ id: sha.slice(0, 7), project: 'omega' });
    assert(r.known && r.kind === 'commit' && r.project === 'omega' && r.title === subject, `commit : ${JSON.stringify(r).slice(0, 200)}`);
    // Other walkthroughs rewrite omega's CHANGELOG: write a known entry, put the file back after.
    const omegaCl = path.join(omegaDir, 'CHANGELOG.md');
    const clBefore = fs.existsSync(omegaCl) ? fs.readFileSync(omegaCl) : null;
    fs.writeFileSync(omegaCl, '# Changelog\n\n## [9.8.7] - 2026-10-02\n\n### Added\n\n- IDREF entrée de recette\n');
    try {
      r = await idf({ id: 'v9.8.7', project: 'omega' });
      assert(r.known && r.kind === 'version' && r.project === 'omega' && r.date === '2026-10-02' && /IDREF entrée/.test(r.summary || ''), `version (CHANGELOG d’omega) : ${JSON.stringify(r).slice(0, 200)}`);
    } finally { if (clBefore) fs.writeFileSync(omegaCl, clBefore); else fs.rmSync(omegaCl, { force: true }); }
    // The sandbox copies no CHANGELOG.md of the server: the "served version" case only when it has one.
    if (fs.existsSync(path.join(sb.root, 'CHANGELOG.md'))) {
      r = await idf({ id: `v${pkgVersion}` });
      assert(r.known && r.state === 'version servie par ce serveur', `version servie : ${JSON.stringify(r).slice(0, 200)}`);
    }
    r = await idf({ id: 'alpha', kind: 'projet' });
    assert(r.known && r.links.some(l => l.musician === 'alpha'), `projet : ${JSON.stringify(r).slice(0, 200)}`);
    r = await idf({ id: 'TODO_LIST.md', project: 'alpha' });
    assert(r.known && r.kind === 'fichier' && r.project === 'alpha' && !('content' in r), `fichier : ${JSON.stringify(r).slice(0, 200)}`);
    r = await idf({ id: 'routage.classifier' });
    assert(r.known && r.kind === 'case' && r.links.some(l => l.route === '#/models'), `case : ${JSON.stringify(r).slice(0, 200)}`);
    r = await idf({ id: 't-ffffff' });
    assert(r.ok && !r.known && /ne le trouve pas/.test(r.message), `inconnu : ${JSON.stringify(r)}`);
    for (const bad of ['..\\..\\..\\Windows\\win.ini', 'C:\\Windows\\win.ini', '../../package.json']) {
      r = await idf({ id: bad, kind: 'fichier', project: 'alpha' });
      assert(!r.known, `hors des projets accepté : ${bad} → ${JSON.stringify(r).slice(0, 160)}`);
    }
    assert((await get('/api/identify')).status === 400, 'identifiant manquant accepté');
    const v = await json('/api/identify/vocab');
    assert(v.projects.includes('alpha') && v.slots.includes('routage.classifier') && v.conductor === 'chef', `vocabulaire : ${JSON.stringify(v).slice(0, 200)}`);
    for (const method of ['POST', 'PUT', 'DELETE']) assert((await fetch(sb.url + '/api/identify?id=t-a10001', { method, headers: H })).status === 404, `${method} accepté`);
    return `t-a10001, ${sha.slice(0, 7)}, v9.8.7 (omega), alpha, TODO_LIST.md, routage.classifier expliqués ; t-ffffff inconnu ; chemins hors projets refusés`;
  });
  // 0.56.0 — phase 7 : relevé de la mise en service générale (« une semaine sans contournement »).
  await check(S, 'pipeline-health', 'Pipelines, phase 7 : relevé de la mise en service — exécutions, tours hors pipeline, tours ordinaires, refus (moteur et porte), pauses, jours complets sans contournement', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'pipeline-health.mjs'))) NA('relevé absent de cet état du code');
    const since = new Date(Date.now() - 3 * 86400_000).toISOString();
    fs.writeFileSync(routingFile, JSON.stringify({ version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } }, history: [], enforcement: { projects: ['omega'], pipelines: ['discussion', 'dev'], generalSince: since } }));
    try {
      const at = new Date().toISOString();
      fs.appendFileSync(path.join(sb.root, 'logs', 'omega.jsonl'), [
        { type: 'user_prompt', text: 'recette relevé', pipeline: { run: 'p-20261009T000000-abcd' }, timestamp: at },
        { type: 'notification', subtype: 'pipeline_limit', timestamp: at },
        { type: 'user_prompt', text: 'recette relevé hors', pipelineBypass: { reason: 'recette' }, timestamp: at },
      ].map(e => JSON.stringify(e)).join('\n') + '\n');
      const h = await json('/api/pipeline-health?refresh=1');
      assert(h.since === since && h.totals.runs >= 1 && h.totals.pauses >= 1 && h.totals.hors >= 1 && Array.isArray(h.days) && h.criterion.days === 7, `relevé : ${JSON.stringify(h.totals)}`);
      assert(h.perProject.some(p => p.name === 'omega'), 'omega absent du relevé par projet');
      return `relevé : ${JSON.stringify(h.totals)}, ${h.streakDays} jour(s) sans contournement`;
    } finally { fs.rmSync(routingFile, { force: true }); }
  });
  // 0.49.0 — phase 4 : Développement COMPLET, TDD canonique un test à la fois.
  const omegaFresh = () => { const g = omegaRepo(); g('reset', '-q', '--hard', g('rev-list', '--max-parents=0', 'HEAD').stdout.trim()); g('clean', '-qfd', '-e', '.orchestrateur'); return g; };
  await check(S, 'pipeline-tdd', 'Pipelines, phase 4 : Développement complet — Comprendre, Concevoir, Liste de tests, puis UN test à la fois (4a échoue réellement, 4b la rend verte, 4c sautée si inutile), items cochés par le moteur, un commit ; montée léger → complet annoncée ; frise du journal', async () => {
    if ((await get('/api/pipeline-enforcement')).status === 404) NA('moteur absent de cet état du code');
    const js = await (await fetch(`${sb.url}/activite.js`, { headers: H })).text();
    if (!/jt-escalate/.test(js)) NA('Développement complet absent de cet état du code');
    const g = omegaFresh(); enforceOmega();
    const h0 = g('rev-parse', 'HEAD').stdout.trim();
    const n0 = readLog('omega').length;
    let r = await pipeDispatch(['omega', 'Ajoute les multiplications par deux et par trois', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2' });
    let evs = readLog('omega').slice(n0);
    const seq = evs.filter(e => e.subtype === 'pipeline_step_done').map(e => `${e.pipeline.step}${e.status === 'ok' ? '' : ':' + e.status}`).join(',');
    // 0.63.0 (« c+d », part c): one Review per item, right after its loop.
    const wantSeq = fs.existsSync(path.join(sb.root, 'scripts', 'item-review.mjs'))
      ? 'comprendre,concevoir,liste-tests,rouge,vert,refactor:skipped,revue,rouge,vert,refactor:skipped,revue,livrer'
      : 'comprendre,concevoir,liste-tests,rouge,vert,refactor:skipped,rouge,vert,refactor:skipped,revue,livrer';
    assert(r.code === 0 && seq === wantSeq, `enchaînement : ${seq} (code ${r.code}) ${r.out.slice(-300)}`);
    const rouges = evs.filter(e => e.subtype === 'pipeline_step_done' && e.pipeline.step === 'rouge');
    assert(rouges.every(e => e.test?.ok === false && e.pipeline.item), '4a doit échouer réellement, item par item');
    assert(evs.filter(e => e.subtype === 'pipeline_item_done').length === 2, 'items non cochés un par un');
    // 0.64.0 (« c+d », part c): one commit per item, then the release commit.
    const wantCommits = fs.existsSync(path.join(sb.root, 'scripts', 'item-delivery.mjs')) ? '3' : '1';
    assert(g('rev-list', '--count', `${h0}..HEAD`).stdout.trim() === wantCommits, `${wantCommits} commit(s) attendu(s)`);
    const t0 = (await json('/api/project/omega/journal?n=3')).turns[0];
    assert(t0?.pipeline?.mode === 'complet' && t0.pipeline.items === 2 && t0.pipeline.steps.some(s => s.status === 'skipped' && s.item), `journal : ${JSON.stringify(t0?.pipeline && { m: t0.pipeline.mode, i: t0.pipeline.items })}`);
    omegaFresh();
    const n1 = readLog('omega').length;
    r = await pipeDispatch(['omega', 'Ajoute une fonction double', '--mode', 'leger'], { FAKE_PIPE_BIG: '1', FAKE_PIPE_ITEMS: '1' });
    evs = readLog('omega').slice(n1);
    assert(r.code === 0 && evs.some(e => e.subtype === 'pipeline_escalate'), `montée en complet absente (code ${r.code})`);
    const t1 = (await json('/api/project/omega/journal?n=3')).turns[0];
    assert(t1?.pipeline?.escalated && t1.pipeline.mode === 'complet', 'journal : montée en complet non visible');
    omegaFresh();
    return `complet : ${seq.split(',').length} étapes, 2 items ; montée léger → complet annoncée`;
  });
  await check(S, 'pipeline-limits', 'Pipelines, phase 4 : chaque limite (items, durée) met en pause ET prévient — log (pipeline_limit), dashboard (input), chef (notify pipeline-limit)', async () => {
    if ((await get('/api/pipeline-enforcement')).status === 404) NA('moteur absent de cet état du code');
    const js = await (await fetch(`${sb.url}/activite.js`, { headers: H })).text();
    if (!/jt-escalate/.test(js)) NA('Développement complet absent de cet état du code');
    const got = [];
    for (const [limit, env] of [['items', { FAKE_PIPE_ITEMS: '4', ORCH_PIPE_ITEMS: '3' }], ['duration', { FAKE_PIPE_ITEMS: '1', ORCH_PIPE_RUN_MS: '1' }]]) {
      omegaFresh(); enforceOmega();
      const k0 = notices.length;
      const r = await pipeDispatch(['omega', 'Ajoute des opérations', '--mode', 'complet'], env);
      const lim = readLog('omega').filter(e => e.subtype === 'pipeline_limit').pop();
      assert(r.code === 2 && lim?.limit === limit, `${limit} : code ${r.code}, signal ${JSON.stringify(lim?.limit)}`);
      const row = await until(async () => (await json('/api/pupitre')).fleet.find(x => x.name === 'omega' && x.state === 'input') || null, 8000);
      assert(row, `${limit} : question absente du dashboard`);
      const chef = notices.slice(k0).find(n => n.project === 'chef' && n.source === 'pipeline-limit' && /Limite atteinte/.test(n.text));
      assert(chef, `${limit} : chef non prévenu`);
      await post('/api/question/omega/resolve', { note: 'recette' });
      got.push(limit);
    }
    omegaFresh();
    fs.rmSync(routingFile, { force: true });
    return `limites ${got.join(', ')} : les 3 signaux partent`;
  });
  // Décision utilisateur Q10 (« A ») : un item déjà couvert est accepté s'il est
  // déclaré (DEJA_COUVERT), tests seuls, suite verte — sans 4b ni 4c, tracé.
  await check(S, 'pipeline-covered', 'Pipelines (Q10 « A ») : item déjà couvert accepté s’il est déclaré DEJA_COUVERT (tests seuls, suite verte) — coché sans 4b/4c, tracé, journal « ↺ déjà couvert » ; sans déclaration : refusé', async () => {
    if ((await get('/api/pipeline-enforcement')).status === 404) NA('moteur absent de cet état du code');
    const js = await (await fetch(`${sb.url}/activite.js`, { headers: H })).text();
    if (!/jt-covered/.test(js)) NA('« déjà couvert » absent de cet état du code');
    omegaFresh(); enforceOmega();
    const n0 = readLog('omega').length;
    let r = await pipeDispatch(['omega', 'Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', FAKE_PIPE_COVERED: '2' });
    const evs = readLog('omega').slice(n0);
    const done = evs.filter(e => e.subtype === 'pipeline_step_done');
    const covered = done.find(e => e.pipeline.step === 'rouge' && e.covered);
    assert(r.code === 0 && covered?.pipeline.item === 2 && done.filter(e => e.status === 'skipped' && e.pipeline.item === 2).length === 2, `item 2 couvert : ${done.map(e => `${e.pipeline.step}:${e.status}`).join(',')} (code ${r.code})`);
    const t0 = (await json('/api/project/omega/journal?n=3')).turns[0];
    assert(t0?.pipeline?.covered === 1 && t0.pipeline.steps.some(s => s.covered), 'journal : « déjà couvert » absent');
    omegaFresh();
    r = await pipeDispatch(['omega', 'Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '1', FAKE_PIPE_COVERED: '1', FAKE_PIPE_NOCLAIM: '1' });
    assert(r.code === 2, `sans déclaration : pause attendue (code ${r.code})`);
    await post('/api/question/omega/resolve', { note: 'recette' });
    omegaFresh();
    fs.rmSync(routingFile, { force: true });
    return 'déclaré → accepté sans 4b/4c ; non déclaré → refusé';
  });
  // Retour utilisateur (2026-10-09) sur la pause « liste pas vide après 15 items » :
  // un constat de revue non testable va à Livrer ; la pause s'explique en clair.
  await check(S, 'pipeline-pause-clear', 'Pipelines : constat de revue non testable (registre, doc) → Livrer, sans pause ni test de plus ; pause expliquée en clair (ce qui s’est passé, avancement, choix, recommandation) ; « abandonner » clôt l’exécution', async () => {
    if ((await get('/api/pipeline-enforcement')).status === 404) NA('moteur absent de cet état du code');
    const js = await (await fetch(`${sb.url}/activite.js`, { headers: H })).text();
    if (!/jt-covered/.test(js)) NA('cet état du code ne trie pas les constats de revue');
    omegaFresh(); enforceOmega();
    let n0 = readLog('omega').length;
    let r = await pipeDispatch(['omega', 'Ajoute la multiplication', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '2', ORCH_PIPE_ITEMS: '2', FAKE_PIPE_REVIEW: 'doc:1' });
    let evs = readLog('omega').slice(n0);
    // 0.65.0 (« tout problème détecté doit bloquer une livraison »): the finding is
    // reported and corrected before delivery — still no pause, never a new test.
    const blocks = evs.some(e => e.subtype === 'pipeline_defect');
    if (!blocks && !evs.some(e => e.subtype === 'pipeline_delivery_fixes')) NA('cet état du code ne trie pas les constats de revue');
    assert(r.code === 0 && !evs.some(e => e.subtype === 'pipeline_limit'), `constat de registre : pause inattendue (code ${r.code})`);
    if (blocks) assert(evs.some(e => e.subtype === 'pipeline_loop' && e.pipeline?.to === 'vert'), 'constat de registre signalé mais pas corrigé avant la livraison');
    omegaFresh();
    n0 = readLog('omega').length;
    r = await pipeDispatch(['omega', 'Ajoute beaucoup de choses', '--mode', 'complet'], { FAKE_PIPE_ITEMS: '4', ORCH_PIPE_ITEMS: '3' });
    evs = readLog('omega').slice(n0);
    const res = evs.find(e => e.type === 'result')?.result || '';
    assert(r.code === 2 && ["Ce qui s'est passé", 'Où en est le travail', 'Je recommande', '« **abandonner** »'].every(s => res.includes(s)) && !/--pipeline-resume|\b4[abc]\b/.test(res), `pause peu claire : ${res.slice(0, 300)}`);
    const row = await until(async () => (await json('/api/pupitre')).fleet.find(x => x.name === 'omega' && x.state === 'input') || null, 8000);
    // 0.122.0 (« Il faudrait un choix plus intelligent »): the choices of THIS cause (list too big), stated cause, no generic « continuer ».
    assert(row && /découper.*abandonner/.test(row.needsInput || '') && !/« continuer »|« changer le model »/.test(row.needsInput || '') && res.includes('**Cause** :'), `question du dashboard : ${row?.needsInput}`);
    r = await pipeDispatch(['omega', 'abandonner']);
    const st = await until(async () => (await json('/api/pupitre')).fleet.find(x => x.name === 'omega' && x.state !== 'input') || null, 8000);
    assert(r.code === 0 && st, '« abandonner » : la question devrait disparaître');
    omegaFresh();
    fs.rmSync(routingFile, { force: true });
    return 'constat de doc signalé et corrigé avant livraison (0.65.0) ; pause claire ; abandon effectif';
  });
  // 0.51.0 — « La langue de la discussion doit pouvoir etre fixee et tu dois t'y tenir ».
  await check(S, 'language-settings', 'Langue de discussion : réglage global + exception par projet (fichier dédié, pas config.json), table « models × langues fiables », essai de langue, origine étrangère refusée', async () => {
    const g0 = await get('/api/language');
    if (g0.status === 404) NA('réglage de langue absent de cet état du code');
    let v = await g0.json();
    assert(v.default === 'fr' && v.langs.fr && v.projectNames.includes('omega'), `défaut : ${JSON.stringify({ d: v.default })}`);
    const put = (p, body, extra = {}) => fetch(sb.url + p, { method: 'PUT', headers: { ...H, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
    assert((await put('/api/language', { default: 'xx' })).status === 400, 'langue inconnue acceptée');
    assert((await put('/api/language', { default: 'en' }, { Origin: 'http://evil.example' })).status === 403, 'origine étrangère acceptée');
    v = await (await put('/api/language', { default: 'en' })).json();
    assert(v.default === 'en', 'langue globale non enregistrée');
    v = await (await put('/api/language/project/omega', { lang: 'es' })).json();
    assert(v.projects.omega === 'es', 'exception non enregistrée');
    assert((await put('/api/language/project/inconnu', { lang: 'es' })).status === 404, 'projet inconnu accepté');
    const file = JSON.parse(fs.readFileSync(path.join(sb.root, 'language-settings.json'), 'utf8'));
    assert(file.default === 'en' && file.projects.omega === 'es' && !fs.readFileSync(path.join(sb.root, 'config.json'), 'utf8').includes('"projects":{"omega"'), 'fichier dédié attendu');
    await put('/api/language/project/omega', { lang: null });
    await put('/api/language', { default: 'fr' });
    const ml = await json('/api/model-languages');
    assert(ml.defaults?.rules?.length && Array.isArray(ml.models), 'table des models absente');
    const pm = await (await put(`/api/model-languages/${encodeURIComponent('vendor/petit-1')}`, { langs: ['en'] })).json();
    assert(pm.models.find(m => m.model === 'vendor/petit-1')?.source === 'override', 'override de model non enregistré');
    const t = await fetch(`${sb.url}/api/model-languages/test`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'anthropic', model: 'claude-essai-1', lang: 'fr' }) });
    const tj = await t.json();
    assert('detected' in tj || tj.why, `essai de langue : ${JSON.stringify(tj).slice(0, 200)}`);
    await put(`/api/model-languages/${encodeURIComponent('vendor/petit-1')}`, { langs: null });
    fs.rmSync(path.join(sb.root, 'language-settings.json'), { force: true });
    return `réglage, exception, table (${ml.defaults.rules.length} règles), essai (${tj.detected || tj.why})`;
  });
  await check(S, 'mark-read', 'Marquer lu (/api/mark-read) persiste le marqueur', async () => {
    const r = await post('/api/mark-read', { project: 'lambda' });
    assert(r.ok, `HTTP ${r.status}`);
    assert(fs.existsSync(path.join(sb.root, 'logs', 'lambda.read')), 'marqueur absent');
  });
  // Exigence 0.38.0 : « Ce concept de mis de côté n'a plus d'intérêt » — aucun
  // projet n'est exclu par un ancien marqueur (zeta/eta le gardent en fixtures).
  await check(S, 'no-parked', 'Plus de « mis de côté » : marqueur ignoré, aucun projet exclu, route /park supprimée', async () => {
    const c = await json('/api/config');
    if (c.projects.some(p => 'parked' in p)) NA('concept encore présent dans cet état du code');
    assert(c.projects.length === 14 && ['zeta', 'eta'].every(n => c.projects.some(p => p.name === n)), 'un projet à l\'ancien marqueur manque');
    const p = await json('/api/pupitre');
    assert(p.fleet.length === 14 && p.fleet.every(r => !('parked' in r) && !('healthTracked' in r)), '/api/pupitre expose encore parked/healthTracked');
    const r = await post('/api/project/omega/park', { parked: true });
    assert(r.status === 404, `route /park encore servie (HTTP ${r.status})`);
  });
  await check(S, 'model-routing', 'Models par tâche : 14 pipelines (boucles, retours, renvois), une case par étape et variante, migration de l\'ancien format, capacités média, outils locaux, choix validé, enregistré hors config.json, relu, historisé', async () => {
    const routingPath = path.join(sb.root, 'model-routing.json');
    // Ancien format (0.39.0) posé avant la première lecture : il doit être migré.
    fs.writeFileSync(routingPath, JSON.stringify({ version: 1, assignments: {
      'refactoring': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      'second-avis': { provider: 'openai', model: 'gpt-6-astra' },
      'type-disparu': { provider: 'anthropic', model: 'claude-opus-5-5' },
    }, history: [] }));
    const first = await get('/api/model-routing');
    if (first.status === 404) NA('route absente de cet état du code');
    const v = await first.json();
    if (!Array.isArray(v.pipelines)) NA('structure en pipelines absente de cet état du code');
    const ids = v.pipelines.map(p => p.id).join(',');
    assert(ids === 'dev,discussion,routage,incident,recherche,audit,maintenance,nouveau,donnees,redaction,reunion,images,video,audio', `pipelines : ${ids}`);
    const steps = (p) => p.flow.flatMap(n => (n.kind === 'loop' ? n.steps : [n]));
    for (const p of v.pipelines) {
      assert(p.purpose && p.when, `${p.id} : bandeau incomplet`);
      for (const s of steps(p)) {
        assert(s.title && s.what && s.example, `${p.id}.${s.id} : titre, quand/quoi ou exemple manquant`);
        if (!s.ref) assert(v.slots.some(x => x.id === `${p.id}.${s.id}`), `${p.id}.${s.id} : pas de case`);
        for (const vr of s.variants || []) assert(v.slots.some(x => x.id === `${p.id}.${s.id}.${vr.id}`), `${p.id}.${s.id}.${vr.id} : pas de case`);
      }
    }
    const dev = v.pipelines[0];
    const loop = dev.flow.find(n => n.kind === 'loop');
    assert(loop && loop.steps.map(s => s.n).join(',') === '4a,4b,4c' && loop.back.from === 'refactor' && loop.back.to === 'rouge', 'boucle TDD 4a→4b→4c→4a absente');
    assert(steps(dev).find(s => s.id === 'revue').returns.some(r => r.to === 'tdd'), 'retour Revue → 4 absent');
    assert(steps(dev).find(s => s.id === 'vert').variants.length === 5, 'variantes de 4b');
    assert(steps(v.pipelines.find(p => p.id === 'incident')).find(s => s.id === 'corriger').ref.pipeline === 'dev', 'renvoi Incident → Développement absent');
    assert(steps(v.pipelines.find(p => p.id === 'images')).find(s => s.id === 'verifier').returns.some(r => r.to === 'produire'), 'boucle Images vérifier → générer absente');
    // Migration : reprise sur les nouvelles cases, perte signalée.
    assert(v.migration && v.migration.mapped.length === 2 && v.migration.lost.length === 1 && v.migration.lost[0].from === 'type-disparu', `migration : ${JSON.stringify(v.migration)}`);
    assert(v.assignments['dev.vert.refactoring']?.model === 'claude-sonnet-5-5' && v.assignments['dev.refactor']?.model === 'claude-sonnet-5-5', 'refactoring non repris');
    assert(v.assignments['audit.second-avis']?.model === 'gpt-6-astra' && v.assignments['dev.revue.second-avis'], 'second avis non repris');
    assert(fs.existsSync(routingPath + '.v1-bak'), 'pas de sauvegarde de l\'ancien fichier');
    assert(JSON.parse(fs.readFileSync(routingPath, 'utf8')).version === 2, 'fichier non réécrit au nouveau format');
    // Catalogue : capacités et outils locaux.
    const c = await json('/api/model-catalog');
    assert(['anthropic', 'openai', 'nvidia', 'openrouter', 'local'].every(p => Array.isArray(c.providers[p]?.models)), 'fournisseur manquant');
    assert(c.providers.anthropic.models.every(m => m.caps.includes('vision') && !m.caps.includes('image-gen')), 'capacités Anthropic');
    // 0.46.0 : gpt-reserve retiré (étude comparative, demande utilisateur), les
    // annoncés ajoutés non sélectionnables. Avant : la liste brute de codex.
    const oaiIds = c.providers.openai.models.map(m => m.id + (m.unavailable ? '(annoncé)' : '')).join(',');
    assert(oaiIds === (Array.isArray(c.removed) ? 'gpt-6-astra,gpt-5.6-sol,gpt-6.1-sol(annoncé),gpt-6-luna(annoncé)' : 'gpt-6-astra,gpt-reserve,gpt-5.6-sol'), `OpenAI : ${oaiIds}`);
    const nv = c.providers.nvidia.models;
    assert(nv[0].id === 'moonshotai/kimi-k3' && nv.some(m => m.missing) && !nv.some(m => /embed/.test(m.id)), 'NVIDIA : cascade, signalement, filtre');
    assert(nv.find(m => m.id === 'meta/llama-3.2-90b-vision-instruct')?.caps.includes('vision'), 'NVIDIA : vision non détectée');
    const or = c.providers.openrouter;
    assert(or.keyPresent === false && or.disabled === true, 'OpenRouter : clé');
    assert(or.models.find(m => m.id === 'google/gemini-3-pro-image')?.caps.includes('image-gen'), 'OpenRouter : génération d\'image non détectée');
    assert(or.models.find(m => m.id === 'openai/gpt-audio')?.caps.includes('audio-out'), 'OpenRouter : TTS non détecté');
    assert(!or.models.some(m => m.id === 'some/no-tools-model'), 'OpenRouter : model sans outils ni média gardé');
    const loc = c.providers.local.models;
    assert(loc.find(t => t.id === 'ffmpeg')?.installed && !loc.find(t => t.id === 'piper')?.installed && loc.find(t => t.id === 'web-speech')?.installed, 'outils locaux : détection');
    assert(!JSON.stringify(c).match(/sk-or-|nvapi-/), 'une valeur de clé apparaît dans le catalogue');
    // Enregistrement et validation.
    const cfgPath = path.join(sb.root, 'config.json');
    const cfgBefore = fs.readFileSync(cfgPath, 'utf8');
    const put = (slot, body) => fetch(`${sb.url}/api/model-routing/${slot}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let r = await put('dev.revue.code', { provider: 'anthropic', model: 'claude-opus-5-5' });
    assert(r.status === 200 && (await r.json()).changed === true, `PUT ${r.status}`);
    r = await put('dev.revue.code', { provider: 'anthropic', model: 'claude-opus-5-5' });
    assert((await r.json()).changed === false, 'même choix compté comme un changement');
    assert((await put('dev.revue.code', { provider: 'openrouter', model: 'qwen/qwen3-coder' })).status === 409, 'OpenRouter accepté sans clé');
    assert((await put('dev.inconnue', { provider: 'anthropic', model: 'claude-opus-5-5' })).status === 404, 'case inconnue acceptée');
    assert((await put('incident.corriger', { provider: 'anthropic', model: 'claude-opus-5-5' })).status === 404, 'un renvoi a reçu un model');
    assert((await put('dev.revue.code', { provider: 'anthropic', model: 'claude-inexistant-9' })).status === 400, 'model hors liste accepté');
    assert((await put('dev.revue.code', { provider: 'anthropic', model: '../x y' })).status === 400, 'identifiant invalide accepté');
    assert((await put('dev.revue.code', { provider: 'mistral', model: 'x' })).status === 400, 'fournisseur inconnu accepté');
    assert((await put('images.produire.generation', { provider: 'anthropic', model: 'claude-opus-5-5' })).status === 400, 'model texte accepté pour la génération d\'image');
    assert((await put('audio.traiter.tts', { provider: 'local', model: 'piper' })).status === 409, 'outil non installé accepté');
    assert((await put('dev.vert', { provider: 'local', model: 'ffmpeg' })).status === 400, 'outil local accepté pour du code');
    assert((await put('video.monter.decoupe', { provider: 'local', model: 'ffmpeg' })).status === 200, 'ffmpeg refusé pour la découpe');
    assert((await put('audio.traiter.stt', { provider: 'local', model: 'whisper' })).status === 200, 'whisper local refusé pour la transcription');
    assert((await put('images.verifier', { provider: 'nvidia', model: 'meta/llama-3.2-90b-vision-instruct' })).status === 200, 'model vision refusé pour la vérification visuelle');
    // 0.41.0 — NVIDIA / OpenRouter : outillage d'agent en construction (409 sur
    // une étape d'action). 0.47.0 — outillés (harnais codex) : acceptés.
    const hv = await put('dev.vert', { provider: 'nvidia', model: 'z-ai/glm-5.3' });
    if (Array.isArray(v.slots) && 'judge' in (v.slots[0] || {})) {
      if (v.agentHarness?.nvidia === true) {
        assert(hv.status === 200, `NVIDIA outillé mais refusé sur une étape d'action (${hv.status})`);
        await put('dev.vert', { default: true });
      } else assert(hv.status === 409 && /outillage/.test((await hv.json()).error || ''), `NVIDIA accepté sur une étape d'action (${hv.status})`);
      assert((await put('routage.classifier', { provider: 'nvidia', model: 'z-ai/glm-5.3' })).status === 200, 'NVIDIA refusé sur une étape de jugement');
      await put('routage.classifier', { default: true });
    }
    const after = await json('/api/model-routing');
    assert(after.assignments['dev.revue.code']?.model === 'claude-opus-5-5' && after.assignments['video.monter.decoupe']?.provider === 'local', 'choix non relus');
    const file = JSON.parse(fs.readFileSync(routingPath, 'utf8'));
    assert(file.assignments['dev.revue.code']?.model === 'claude-opus-5-5', 'model-routing.json sans le choix');
    assert(fs.readFileSync(cfgPath, 'utf8') === cfgBefore, 'config.json modifié');
    // 0.44.0 — mode double model : second optionnel, mêmes règles, persistance.
    if ((await put('dev.livrer.git', { provider: 'anthropic', model: 'claude-sonnet-5', role: 'second' })).status !== 400) {
      assert((await put('dev.livrer.git', { provider: 'anthropic', model: 'claude-sonnet-5', role: 'second' })).status === 409, 'second accepté sans principal');
      assert((await put('dev.revue.code', { provider: 'openai', model: 'gpt-6-astra', role: 'second' })).status === 200, 'second refusé');
      assert((await json('/api/model-routing')).assignments['dev.revue.code']?.second?.model === 'gpt-6-astra', 'second non relu');
      const same = await (await put('dev.revue.code', { provider: 'anthropic', model: 'claude-opus-5-5', role: 'second' })).json();
      assert(/identiques/.test(same.warning || ''), 'pas d’avertissement principal = second');
    }
    r = await put('dev.revue.code', { default: true });
    assert(r.status === 200 && !(await json('/api/model-routing')).assignments['dev.revue.code'], 'valeur héritée non appliquée');
    const h = (await json('/api/model-routing')).history;
    assert(h[0].task === 'dev.revue.code' && h[0].from === 'anthropic:claude-opus-5-5' && h[0].to === null, `historique : ${JSON.stringify(h[0])}`);
    assert(h.some(e => /migration/.test(e.by || '')), 'historique : migration non tracée');
    for (const s of ['video.monter.decoupe', 'audio.traiter.stt', 'images.verifier']) await put(s, { default: true });
    // L'instance repart propre pour les parcours navigateur.
    fs.rmSync(routingPath, { force: true });
    return `${v.pipelines.length} pipelines, ${v.slots.length} cases, ${loc.filter(t => t.installed).length} outils locaux`;
  });
  // 0.46.0 — demande : appliquer la recommandation de l'étude comparative EN
  // SUGGESTIONS, sans toucher aux choix de l'utilisateur.
  await check(S, 'model-reco', 'Suggestions de l\'étude comparative : une par case, haiku-5-5 présent, gpt-reserve et gpt-5.5 absents, annoncés non sélectionnables, aucun choix modifié sans action, « cases vides seulement » ne touche que les vides, historique', async () => {
    const r0 = await get('/api/model-recommendations');
    if (r0.status === 404) NA('suggestions absentes de cet état du code');
    const routingPath = path.join(sb.root, 'model-routing.json');
    const reco = await r0.json();
    const v = await json('/api/model-routing');
    assert(reco.ok && reco.counts.withSuggestion === v.slots.length && v.slots.every(s => reco.slots[s.id]), `suggestions : ${JSON.stringify(reco.counts)}`);
    assert(reco.report.date === '2026-10-08' && reco.age?.level, 'date / âge du rapport');
    assert(['discussion', 'refactor', 'recherche', 'redaction'].every(k => Object.values(reco.slots).some(s => s.step === k && s.undecided)), 'étapes non tranchées non signalées');
    const c = await json('/api/model-catalog');
    assert(c.providers.anthropic.models.some(m => m.id === 'claude-haiku-5-5'), 'claude-haiku-5-5 absent');
    assert(!c.providers.openai.models.some(m => m.id === 'gpt-reserve' || m.id === 'gpt-5.5'), 'gpt-reserve / gpt-5.5 encore listés');
    assert(c.providers.anthropic.models.find(m => m.id === 'claude-opus-5')?.dominated?.source, 'dominé non marqué');
    const put = (slot, body) => fetch(`${sb.url}/api/model-routing/${encodeURIComponent(slot)}`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert((await put('dev.vert.migration', { provider: 'openai', model: 'gpt-6.1-sol' })).status === 409, 'model annoncé accepté');
    assert((await put('dev.vert', { provider: 'openai', model: 'gpt-reserve' })).status === 400, 'model retiré accepté');
    // Un choix de l'utilisateur, et un choix obsolète écrit avant le retrait.
    assert((await put('dev.concevoir', { provider: 'openai', model: 'gpt-6-astra' })).status === 200, 'choix utilisateur');
    const f = JSON.parse(fs.readFileSync(routingPath, 'utf8'));
    f.assignments['maintenance.dette'] = { provider: 'openai', model: 'gpt-5.5', at: '2026-10-01T00:00:00Z' };
    fs.writeFileSync(routingPath, JSON.stringify(f));
    const before = JSON.stringify((await json('/api/model-routing')).assignments);
    await json('/api/model-recommendations');
    assert(JSON.stringify((await json('/api/model-routing')).assignments) === before, 'lire les suggestions a modifié un choix');
    const dry = await (await post('/api/model-routing/apply-suggestions', { mode: 'empty', dryRun: true })).json();
    assert(dry.ok && dry.plan.length > 0 && !dry.plan.some(p => p.slot === 'dev.concevoir' || p.slot === 'maintenance.dette'), `plan : ${JSON.stringify(dry).slice(0, 200)}`);
    assert(JSON.stringify((await json('/api/model-routing')).assignments) === before, 'dryRun a écrit');
    const ap = await (await post('/api/model-routing/apply-suggestions', { mode: 'empty' })).json();
    const after = await json('/api/model-routing?history=500');
    assert(ap.applied.length === dry.plan.length && !ap.failed.length, `appliqué ${ap.applied.length}/${dry.plan.length}, échecs ${JSON.stringify(ap.failed).slice(0, 200)}`);
    assert(after.assignments['dev.concevoir'].model === 'gpt-6-astra' && after.assignments['maintenance.dette'].model === 'gpt-5.5', 'un choix existant a été modifié');
    assert(after.assignments['dev.comprendre']?.model === 'claude-opus-5-5', 'case vide non remplie');
    assert(after.history.filter(h => /suggestion du rapport/.test(h.by || '')).length === ap.applied.length, 'historique incomplet');
    const one = await (await post('/api/model-routing/apply-suggestions', { mode: 'one', slots: ['dev.concevoir'] })).json();
    assert(one.applied[0]?.from === 'openai:gpt-6-astra' && (await json('/api/model-routing')).assignments['dev.concevoir'].model === 'claude-opus-5-5', 'application d\'une case');
    assert((await post('/api/model-routing/apply-suggestions', { mode: 'one', slots: [] })).status === 400, 'mode one sans case accepté');
    const foreign = await fetch(`${sb.url}/api/model-routing/apply-suggestions`, { method: 'POST', headers: { ...H, 'content-type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ mode: 'empty' }) });
    assert(foreign.status === 403, `origine étrangère : ${foreign.status}`);
    fs.rmSync(routingPath, { force: true });
    return `${reco.counts.withSuggestion} cases avec suggestion, ${reco.counts.applicable} applicables, ${ap.applied.length} cases vides remplies`;
  });
  // 0.47.0 — phase 2 des pipelines : NVIDIA / OpenRouter outillés (décision n° 7 :
  // « tous les models doivent pouvoir agir de manière identique »).
  await check(S, 'harness-nvidia', 'Outillage NVIDIA / OpenRouter : passerelle Responses → chat montée dans le serveur (boucle locale, jeton dérivé du secret local, 401 / 404 / 503 explicites), fournisseurs outillés acceptés sur une étape d\'action', async () => {
    const probe = await get('/api/llm-gateway/nvidia/v1/models', {});
    if (probe.status === 404 && !/fournisseur/.test(await probe.text())) NA('passerelle absente de cet état du code');
    const { derivedToken } = await import(pathToFileURL(path.join(sb.root, 'scripts', 'local-secret.mjs')).href);
    const auth = { authorization: `Bearer ${derivedToken(sb.root, 'gateway')}` };
    assert((await get('/api/llm-gateway/nvidia/v1/models', {})).status === 401, 'sans jeton ≠ 401');
    assert((await get('/api/llm-gateway/nvidia/v1/models', { authorization: 'Bearer ' + 'a'.repeat(64) })).status === 401, 'mauvais jeton ≠ 401');
    assert((await get('/api/llm-gateway/nvidia/v1/models', auth)).status === 200, 'jeton dérivé refusé');
    assert((await get('/api/llm-gateway/inconnu/v1/models', auth)).status === 404, 'fournisseur inconnu ≠ 404');
    const r = await fetch(`${sb.url}/api/llm-gateway/nvidia/v1/responses`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'moonshotai/kimi-k3', input: [] }) });
    assert(r.status === 503 && /clé NVIDIA absente/.test(await r.text()), `instance sans clé NVIDIA : ${r.status}`);
    const v = await json('/api/model-routing');
    assert(v.agentHarness?.nvidia === true && v.agentHarness?.openrouter === true, `fournisseurs non outillés : ${JSON.stringify(v.agentHarness)}`);
    const put = (slot, body) => fetch(`${sb.url}/api/model-routing/${encodeURIComponent(slot)}`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert((await put('dev.vert', { provider: 'nvidia', model: 'z-ai/glm-5.3' })).status === 200, 'NVIDIA refusé sur une étape d’action');
    await put('dev.vert', { default: true });
    fs.rmSync(path.join(sb.root, 'model-routing.json'), { force: true });
    return 'passerelle montée et protégée ; NVIDIA / OpenRouter acceptés sur une étape d’action';
  });
  await check(S, 'pipeline-observe', 'Pipelines, phase 1 (observation) : chaque entrée (composer → chef, @musicien, app Android, musicien direct, dispatch.mjs via la file, notify, session neuve) est journalisée une seule fois avec son choix explicite, sans aucun classement par mots-clés (0.66.0), aucun changement de comportement', async () => {
    const first = await get('/api/pipeline-observe?n=5');
    if (first.status === 404) NA('observation absente de cet état du code');
    const obsFile = path.join(sb.root, 'logs', 'pipeline-observe.ndjson');
    const readObs = () => { try { return fs.readFileSync(obsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
    const n0 = readObs().length;
    const postUA = (p, body, ua) => fetch(sb.url + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', ...(ua ? { 'User-Agent': ua } : {}) }, body: JSON.stringify(body) });
    const since = () => readObs().slice(n0);
    // 1. Composer → chef : ticket du pool, comportement inchangé (202 + ticket).
    let r = await post('/api/dispatch', { project: 'chef', prompt: 'corrige la typo du titre de la page' });
    assert(r.status === 202 && (await r.json()).ticket, `chef : ${r.status}`);
    // 2. @mention, 3. app Android, 4. musicien direct, 5. inclassable.
    r = await post('/api/dispatch', { project: 'chef', prompt: '@omega pourquoi le build est lent ?' });
    assert(r.status === 202, `mention : ${r.status}`);
    r = await postUA('/api/dispatch', { project: 'chef', prompt: 'traduis le README en anglais' }, 'okhttp/4.12.0');
    assert(r.status === 202, `android : ${r.status}`);
    r = await post('/api/dispatch', { project: 'lambda', prompt: 'bonjour', queueIfBusy: true });
    assert(r.status === 202, `musicien : ${r.status}`);
    // 6. dispatch.mjs (déjà observé) : le serveur ne compte pas deux fois.
    r = await post('/api/dispatch', { project: 'mu', prompt: 'ajoute un test', queueIfBusy: true, obsId: 'obs-deja-observe-1' });
    assert(r.status === 202, `dispatch.mjs : ${r.status}`);
    // 7. notify, 8. session neuve.
    r = await post('/api/notify', { project: 'chef', text: 'omega : tâche terminée', source: 'omega' });
    assert(r.status === 200, `notify : ${r.status}`);
    // La route attend que la session existe : on ne l'attend pas, l'entrée est
    // observée dès son arrivée.
    post('/api/projects/kappa/sessions/new', { prompt: 'génère une icône pour l\'app' }).catch(() => {});
    const ok = await until(() => since().length >= 6, 8000);
    await sleep(2500);   // le pool et les lancements directs ont eu le temps de partir
    const recs = since();
    const by = (entry) => recs.filter(x => x.entry === entry);
    assert(ok, `observations : ${recs.map(x => x.entry).join(', ')}`);
    assert(!recs.some(x => ['pool', 'file', 'spawn'].includes(x.entry)), `entrée recomptée au lancement : ${recs.map(x => x.entry).join(', ')}`);
    // 0.66.0 : plus aucun classement par mots-clés à l'observation — sans préfixe,
    // l'entrée est « à classer » (par le model de la case routage.classifier).
    assert(by('dashboard:chef').some(x => x.pipeline === null && x.explicit === false), 'composer → chef : un pipeline a été deviné par mots-clés');
    assert(by('dashboard:mention').some(x => x.target === 'omega' && x.pipeline === null), '@omega non observé, ou deviné par mots-clés');
    assert(by('android:chef').some(x => x.pipeline === null), 'entrée Android non observée, ou devinée par mots-clés');
    assert(by('dashboard:musicien').some(x => x.project === 'lambda' && x.pipeline === null), 'entrée « bonjour » non observée, ou devinée par mots-clés');
    assert(!recs.some(x => x.project === 'mu'), 'entrée venue de dispatch.mjs comptée deux fois');
    assert(by('notify').some(x => x.pipeline === 'routage'), 'notify non rattaché au Routage');
    assert(by('session-neuve').some(x => x.project === 'kappa'), 'session neuve non observée');
    // Rien n'a changé dans les tours : le texte du musicien est intact.
    const lam = await until(() => readLog('lambda').some(e => e.type === 'user_prompt' && e.text === 'bonjour'), 15_000);
    assert(lam, 'le tour du musicien n\'a pas reçu le texte inchangé');
    // Une entrée de la file ne sera pas re-comptée au drain : l'id voyage avec elle.
    const v = await json('/api/pipeline-observe?n=50');
    assert(v.mode === 'observation' && v.items.length && v.counts.byPipeline && v.entryKinds['terminal'], 'route /api/pipeline-observe incomplète');
    return `${recs.length} entrées observées : ${[...new Set(recs.map(x => x.entry))].join(', ')}`;
  });
  await check(S, 'pipeline-gaps', 'Lacunes de pipeline : une lacune proposée (par le model ou signalée, jamais détectée sur des mots) produit un signalement avec proposition, notifié au chef ; « Accepter » ajoute bien l’étape (choix du model ensuite), « Rejeter » n’ajoute rien ; signalement explicite d’une étape sans case', async () => {
    const first = await get('/api/pipeline-gaps');
    if (first.status === 404) NA('lacunes absentes de cet état du code');
    const routingPath = path.join(sb.root, 'model-routing.json');
    const text = 'planifie mes vacances en Italie avec un budget serré';
    // 0.66.0 : une lacune n'est plus détectée sur des mots ; elle vient du model
    // (classement, Routage) ou d'un signalement explicite — joué ici comme le model.
    let r = await post('/api/pipeline-gaps', { text, project: 'lambda', by: 'model:recette', why: 'le model de classement ne trouve aucun pipeline pour cette demande d’action',
      proposal: { kind: 'pipeline', id: 'x-voyages', label: 'Voyages', text: 'créer un pipeline « Voyages »' }, alternative: { kind: 'rattachement', pipeline: 'discussion', text: 'rattacher à Discussion' } });
    assert(r.status === 201, `signalement : ${r.status}`);
    const open = async () => (await json('/api/pipeline-gaps')).open;
    assert(await until(async () => (await open()).some(g => g.entries?.[0]?.head === text), 8000), 'aucun signalement pour la demande');
    const gap = (await open()).find(g => g.entries[0].head === text);
    assert(gap.reason === 'signalée' && gap.entries[0].pipeline === null, 'la demande a été classée par mots-clés à l’observation');
    assert(gap.proposal?.kind === 'pipeline' && gap.proposal.text && !gap.proposal.keywords && gap.alternative?.kind === 'rattachement', `proposition : ${JSON.stringify(gap.proposal)}`);
    assert(await until(() => readLog('chef').some(e => e.type === 'user_prompt' && e.source === 'pipeline-gap' && e.text.includes(text.slice(0, 30))), 5000), 'le chef n’a pas été notifié');
    // Accepter → le pipeline et ses cases existent, le model se choisit ensuite.
    r = await post(`/api/pipeline-gaps/${encodeURIComponent(gap.key)}/accept`, { choice: 'primary' });
    const acc = await r.json();
    assert(r.status === 200 && acc.applied?.slot, `accepter : ${r.status} ${JSON.stringify(acc)}`);
    const v = await json('/api/model-routing');
    assert(v.pipelines.some(p => p.id === acc.applied.pipeline) && v.slots.some(s => s.id === acc.applied.slot), 'le pipeline accepté n’apparaît pas');
    const put = (slot, body) => fetch(`${sb.url}/api/model-routing/${slot}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert((await put(acc.applied.slot, { provider: 'anthropic', model: 'claude-sonnet-5' })).status === 200, 'model refusé sur la nouvelle case');
    assert(!(await open()).some(g => g.key === gap.key), 'la lacune acceptée reste ouverte');
    assert((await post(`/api/pipeline-gaps/${encodeURIComponent(gap.key)}/accept`, {})).status === 404, 'double acceptation possible');
    // Signalement explicite d'une étape sans case, puis Accepter / Rejeter.
    r = await post('/api/pipeline-gaps', { text: 'publier l’APK sur le Play Store', project: 'alpha', why: 'aucune variante de « Livrer » ne couvre la publication sur un store',
      proposal: { kind: 'variante', pipeline: 'dev', step: 'livrer', id: 'store', label: 'Publication store', text: 'ajouter la variante « Publication store » à 6 Livrer' } });
    assert(r.status === 201, `signalement : ${r.status}`);
    const key2 = (await r.json()).key;
    assert((await post(`/api/pipeline-gaps/${encodeURIComponent(key2)}/accept`, {})).status === 200, 'variante non acceptée');
    assert((await json('/api/model-routing')).slots.some(s => s.id === 'dev.livrer.store'), 'variante absente après acceptation');
    r = await post('/api/pipeline-gaps', { text: 'trier les photos du téléphone par lieu', proposal: { kind: 'etape', pipeline: 'images', after: 'cadrer', id: 'trier', label: 'Trier', text: 'nouvelle étape « Trier » après Cadrer' } });
    const key3 = (await r.json()).key;
    assert((await post(`/api/pipeline-gaps/${encodeURIComponent(key3)}/reject`, {})).status === 200, 'rejet refusé');
    assert(!(await json('/api/model-routing')).slots.some(s => s.id === 'images.trier'), 'une lacune rejetée a ajouté une étape');
    assert((await post('/api/pipeline-gaps', { text: 'x', proposal: { kind: 'etape', pipeline: 'dev', after: 'livrer', id: '../x' } })).status === 400, 'proposition invalide acceptée');
    assert((await post('/api/pipeline-gaps', { text: 'x', proposal: { kind: 'inconnu' } })).status === 400, 'sorte inconnue acceptée');
    // L'instance repart sans structure ajoutée pour les parcours navigateur.
    fs.rmSync(routingPath, { force: true });
    return `proposition « ${gap.proposal.kind} » acceptée → ${acc.applied.slot}`;
  });
  await check(S, 'api-keys', 'Clés API : enregistrer (état « configurée », .env de l’instance de test), l’API ne renvoie jamais la valeur, tester, groupe OpenRouter dégrisé pour le jugement, Supprimer, valeurs et origines refusées, JSON illisible sans écho', async () => {
    const first = await get('/api/api-keys');
    if (first.status === 404) NA('clés API absentes de cet état du code');
    const envPath = path.join(sb.root, '.env');
    const VALUE = 'sk-or-v1-regression-0123456789abcdef-valid';
    const keyReq = (method, p, body, extra = {}) => fetch(sb.url + p, { method, headers: { ...H, 'Content-Type': 'application/json', ...extra }, body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const ks = await first.json();
    assert(ks.keys.map(k => k.name).join(',') === 'nvidia,openrouter' && ks.keys.every(k => k.state === 'absente'), `état initial : ${JSON.stringify(ks.keys.map(k => [k.name, k.state]))}`);
    // Enregistrer.
    let r = await keyReq('PUT', '/api/api-keys/openrouter', { value: VALUE });
    let txt = await r.text();
    assert(r.status === 200, `PUT ${r.status} ${txt.slice(0, 120)}`);
    const k = JSON.parse(txt).key;
    assert(k.state === 'configurée' && k.valid === true && k.last4 === VALUE.slice(-4) && k.checkedAt, `après Enregistrer : ${JSON.stringify(k)}`);
    assert(!txt.includes(VALUE) && !txt.includes(VALUE.slice(0, 24)), 'la réponse contient la valeur');
    txt = await (await get('/api/api-keys')).text();
    assert(!txt.includes(VALUE.slice(0, 24)), 'GET /api/api-keys contient la valeur');
    assert(fs.readFileSync(envPath, 'utf8').includes(`OPENROUTER_API_KEY=${VALUE}`), 'valeur absente du .env de l’instance');
    // Prise en compte à chaud : groupe OpenRouter dégrisé pour une étape de jugement.
    const c = await json('/api/model-catalog');
    assert(c.providers.openrouter.keyPresent === true && c.providers.openrouter.disabled === false, 'OpenRouter encore grisé avec la clé');
    const put = (slot, body) => keyReq('PUT', `/api/model-routing/${slot}`, body);
    assert((await put('routage.classifier', { provider: 'openrouter', model: 'qwen/qwen3-coder' })).status === 200, 'OpenRouter refusé sur une étape de jugement avec la clé');
    const harnessOn = (await json('/api/model-routing')).agentHarness?.openrouter === true;
    const orAction = await put('dev.vert', { provider: 'openrouter', model: 'qwen/qwen3-coder' });
    assert(orAction.status === (harnessOn ? 200 : 409), harnessOn ? `OpenRouter outillé mais refusé sur une étape d’action (${orAction.status})` : 'OpenRouter accepté sur une étape d’action (outillage en construction)');
    await put('dev.vert', { default: true });
    await put('routage.classifier', { default: true });
    // Tester, refuser, protéger.
    r = await keyReq('POST', '/api/api-keys/openrouter/test');
    assert(r.status === 200 && (await r.json()).key.valid === true, 'Tester');
    assert((await keyReq('PUT', '/api/api-keys/openrouter', { value: 'avec espace interdit 1234567890' })).status === 400, 'valeur invalide acceptée');
    assert((await keyReq('PUT', '/api/api-keys/openrouter', { value: 'sk-or-xxxxxxxxxxxxxxxxxxxx\nPIRATE=1' })).status === 400, 'injection de ligne acceptée');
    assert(!fs.readFileSync(envPath, 'utf8').includes('PIRATE'), 'ligne injectée dans .env');
    assert((await keyReq('PUT', '/api/api-keys/openrouter', { value: VALUE }, { Origin: 'http://site-tiers.example' })).status === 403, 'origine étrangère acceptée');
    r = await keyReq('PUT', '/api/api-keys/openrouter', `{"value": ${VALUE.slice(0, 30)}SECRETZZZ`);
    txt = await r.text();
    assert(r.status === 400 && !txt.includes('SECRETZZZ') && !txt.includes(VALUE.slice(0, 20)), `JSON illisible : écho du corps (${txt.slice(0, 80)})`);
    assert((await keyReq('PUT', '/api/api-keys/anthropic', { value: VALUE })).status === 404, 'clé inconnue acceptée');
    // Clé refusée par le fournisseur (convention hors ligne de l'instance).
    r = await keyReq('PUT', '/api/api-keys/openrouter', { value: 'sk-or-v1-regression-0123456789abcdef-bad' });
    assert((await r.json()).key.state === 'invalide', 'clé refusée non marquée « invalide »');
    // Supprimer.
    r = await keyReq('DELETE', '/api/api-keys/openrouter');
    assert(r.status === 200 && (await r.json()).key.state === 'absente', 'Supprimer');
    assert(!fs.readFileSync(envPath, 'utf8').includes('OPENROUTER_API_KEY'), 'ligne encore présente dans .env');
    assert((await json('/api/model-catalog')).providers.openrouter.disabled === true, 'OpenRouter non regrisé après suppression');
    return 'enregistrer → configurée (acceptée), jamais la valeur, supprimer → absente';
  });
  await check(S, 'sse', 'Flux temps réel /api/sse/fleet : une ligne de log arrive au client', async () => {
    const ac = new AbortController();
    const res = await fetch(`${sb.url}/api/sse/fleet`, { headers: H, signal: ac.signal });
    assert(res.ok, `SSE ${res.status}`);
    const reader = res.body.getReader();
    const marker = 'sse-probe-' + Date.now();
    setTimeout(() => fs.appendFileSync(path.join(sb.root, 'logs', 'lambda.jsonl'),
      JSON.stringify({ type: 'notification', subtype: 'probe', text: marker, timestamp: new Date().toISOString() }) + '\n'), 800);
    let buf = '', got = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !got) {
      const { value, done } = await Promise.race([reader.read(), sleep(8000).then(() => ({ done: true }))]);
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      got = buf.includes(marker) && buf.includes('"lambda"');
    }
    ac.abort();
    assert(got, 'événement non reçu en 8 s');
  });
  await check(S, 'notify', '/api/notify écrit dans le log du chef', async () => {
    const r = await post('/api/notify', { project: 'chef', text: 'note de recette' });
    assert(r.ok, `HTTP ${r.status}`);
    assert(readLog('chef').some(e => e.type === 'user_prompt' && e.text === 'note de recette'), 'absent du log');
  });
  await check(S, 'attach', 'Pièce jointe : envoi image puis service /attachments', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const r = await fetch(`${sb.url}/api/attach/image`, { method: 'POST', headers: { ...H, 'Content-Type': 'image/png' }, body: png });
    assert(r.ok, `upload ${r.status}`);
    const { path: p } = await r.json();
    assert(p && fs.existsSync(p), 'fichier non écrit');
    const g = await get('/attachments/' + path.basename(p));
    assert(g.ok, `service ${g.status}`);
  });
  // User requirement 2026-10-16 (0.108.0): « Acceptes les mkv et les fichiers jusqu'à 500Mo ».
  await check(S, 'attach-mkv-500', 'Pièce jointe : .mkv accepté, 500 Mo acceptés, au-delà refusé (413, message clair), autres types intacts', async () => {
    const MB = 1024 * 1024, MAX = 500 * MB;
    const up = (type, body) => fetch(`${sb.url}/api/attach/image`, { method: 'POST', headers: { ...H, 'Content-Type': type }, body });
    for (const [type, ext] of [['video/x-matroska', '.mkv'], ['video/mkv', '.mkv'], ['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/gif', '.gif']]) {
      const r = await up(type, Buffer.from('recette'));
      if (r.status === 415 && type.includes('mkv')) return 'NA';   // ref older than 0.108.0
      assert(r.ok, `${type} : HTTP ${r.status}`);
      const { path: p } = await r.json();
      assert(p.endsWith(ext) && fs.existsSync(p), `${type} : fichier ${p}`);
      fs.unlinkSync(p);
    }
    const bad = await up('text/plain', Buffer.from('x'));
    const badBody = await bad.json();
    assert(bad.status === 415 && /MKV/.test(badBody.error) && /500 Mo/.test(badBody.error), `type refusé : ${bad.status} ${badBody.error}`);
    // Raw HTTP so the body can be streamed without materialising 500 MB in memory.
    const { request } = await import('node:http');
    const u = new URL(`${sb.url}/api/attach/image`);
    const send = (total, { declare }) => new Promise((resolve, reject) => {
      const headers = { ...H, 'Content-Type': 'video/x-matroska' };
      if (declare) headers['Content-Length'] = String(total);
      let answered = false;
      const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers }, (res) => {
        answered = true;
        let d = ''; res.setEncoding('utf8'); res.on('data', c => { d += c; });
        const done = () => resolve({ status: res.statusCode, body: d });
        res.on('end', done); res.on('close', done);
      });
      // The server drops the socket after a 413: a write error then is expected.
      req.on('error', (e) => { if (!answered) reject(e); });
      const chunk = Buffer.alloc(4 * MB, 0x41);
      let sent = 0;
      const pump = () => {
        while (sent < total && !answered) {
          const n = Math.min(chunk.length, total - sent);
          sent += n;
          if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) { req.once('drain', pump); return; }
        }
        req.end();
      };
      // Declared size: the server answers 413 on the header alone, then closes.
      // Streaming meanwhile raced that close (write ECONNRESET before the
      // response was read, 0.114.1): wait for the answer first, body only if none comes.
      if (declare) { req.flushHeaders(); setTimeout(() => { if (!answered) pump(); }, 3000); } else pump();
    });
    const exact = await send(MAX, { declare: false });
    assert(exact.status === 200, `500 Mo exactement : HTTP ${exact.status} ${exact.body}`);
    const ep = JSON.parse(exact.body).path;
    assert(fs.statSync(ep).size === MAX, `taille écrite ${fs.statSync(ep).size}`);
    fs.unlinkSync(ep);
    const declared = await send(MAX + 1, { declare: true }).catch(e => ({ status: 0, body: e.message }));
    assert(declared.status === 413 && /500 Mo/.test(declared.body) && /trop volumineux/.test(declared.body), `> 500 Mo annoncé : ${declared.status} ${declared.body}`);
    const streamed = await send(MAX + 1, { declare: false }).catch(e => ({ status: 0, body: e.message }));
    assert(streamed.status === 413 && /500 Mo/.test(streamed.body), `> 500 Mo en flux : ${streamed.status} ${streamed.body}`);
    const mkvLeft = () => fs.readdirSync(path.join(sb.root, 'attachments')).filter(f => f.endsWith('.mkv'));
    await until(async () => mkvLeft().length === 0, 5000);
    assert(!mkvLeft().length, `fichiers refusés laissés sur le disque : ${mkvLeft().join(', ')}`);
    return '.mkv + 7 types, 500 Mo acceptés, 500 Mo + 1 refusé (annoncé et en flux)';
  });
  await check(S, 'downloads', '/downloads : carte, APK, rechargement à chaud de downloads.json', async () => {
    let html = await (await fetch(`${sb.url}/downloads`)).text();
    assert(html.includes('Alpha App'), 'carte absente');
    assert((await fetch(`${sb.url}/downloads/alpha/apk`)).ok, 'APK non servi');
    const f = path.join(sb.root, 'downloads.json');
    const reg = JSON.parse(fs.readFileSync(f, 'utf8'));
    reg.apps[0].label = 'Alpha Renommée';
    fs.writeFileSync(f, JSON.stringify(reg, null, 2));
    html = await until(async () => { const t = await (await fetch(`${sb.url}/downloads`)).text(); return t.includes('Alpha Renommée') ? t : null; }, 5000);
    assert(html, 'modification non prise à chaud');
    reg.apps[0].label = 'Alpha App';
    fs.writeFileSync(f, JSON.stringify(reg, null, 2));
  });
  await check(S, 'ws-gate', 'WebSocket /ws/pty refusé sans jeton', async () => {
    // Gate coupé : l'ouvrir lancerait un VRAI claude.exe interactif — on s'abstient.
    if (!gateOn) NA('gate désactivé dans server.js : une connexion lancerait un vrai claude.exe');
    const { default: WebSocket } = await import('ws');
    const outcome = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${sb.port}/ws/pty`);
      const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve('ouvert et maintenu'); }, 4000);
      ws.on('unexpected-response', (_q, res) => { clearTimeout(t); resolve(`refusé HTTP ${res.statusCode}`); });
      ws.on('close', (code) => { clearTimeout(t); resolve(`fermé ${code}`); });
      ws.on('error', () => { clearTimeout(t); resolve('refusé'); });
    });
    assert(!/maintenu/.test(outcome), outcome);
    return outcome;
  });
  await check(S, 'callback-wake', 'Dispatch avec --callback chef : tour du musicien, notification au chef, réveil du chef', async () => {
    // [FAKE_LONG_REPORT]: the musician's report is the multi-paragraph one that
    // check `report-full` below expects to reach the chef whole.
    const d = await post('/api/dispatch', { project: 'omega', prompt: 'Tâche de recette pour le réveil [FAKE_LONG_REPORT]', queueIfBusy: true, callback: 'chef' });
    assert(d.status === 202, `dispatch ${d.status}`);
    const done = await until(() => readLog('omega').some(e => e.type === 'result'), 30_000);
    assert(done, 'le tour du musicien ne s\'est pas terminé');
    const notified = await until(() => readLog('chef').some(e => e.type === 'notification' && e.source === 'omega'), 20_000);
    assert(notified, 'aucune notification musician_done dans le log du chef');
    const woke = await until(() => readLog('chef').some(e => e.type === 'user_prompt' && e.source === 'wake'), 60_000, 1000);
    assert(woke, 'le chef n\'a pas été réveillé en 60 s');
    const chefDone = await until(() => { const l = readLog('chef'); const i = l.findIndex(e => e.type === 'user_prompt' && e.source === 'wake'); return i >= 0 && l.slice(i).some(e => e.type === 'result'); }, 40_000, 1000);
    assert(chefDone, 'le tour de réveil du chef ne s\'est pas terminé');
  });
  // TODO t-a7f8ca (0.100.3): the chef used to get only the last paragraph, cut
  // at 280 characters — the number of tests passed never reached it.
  await check(S, 'report-full', 'Compte rendu de fin de tour : arrive en entier au chef (notification et réveil)', async () => {
    const results = readLog('omega').filter(e => e.type === 'result' && /FIN-DU-RAPPORT/.test(e.result || ''));
    if (!results.length) NA('aucun result du compte rendu long (parcours callback-wake)');
    const n = readLog('chef').filter(e => e.type === 'notification' && e.source === 'omega').pop();
    assert(n, 'aucune notification de omega dans le log du chef');
    if (n.report === undefined) NA('serveur antérieur à 0.100.3 (pas de champ report)');
    assert(/412 tests passés/.test(n.report) && /FIN-DU-RAPPORT/.test(n.report) && /## Vérifications/.test(n.report),
      `notification : compte rendu incomplet : ${String(n.report).slice(0, 300)}`);
    assert(n.summary.length < n.report.length && !/412 tests passés/.test(n.summary), 'la carte garde le résumé court');
    const w = readLog('chef').filter(e => e.type === 'user_prompt' && e.source === 'wake').pop();
    assert(w && /412 tests passés/.test(w.text) && /FIN-DU-RAPPORT/.test(w.text) && !/résumé coupé/.test(w.text),
      `réveil : compte rendu incomplet : ${String(w?.text).slice(0, 400)}`);
    return `notification ${n.report.length} car., réveil complet`;
  });
  // Last of the HTTP walks: it creates kappa's log (kappa has none before, checked by 'pupitre').
  // User rule (2026-10-20): « si aucune activite de ma part depuis plus de 15
  // minutes, et qu'un process attend quelque chose de moi, et que je ne reponds
  // pas dans les 5 minutes, opus 5.5 est charge et autorise a repondre a ma
  // place. Un point de retours est cree si possible. Sinon il faut avancer »
  // + « Ces gardes fous sont tres importants, garde les ».
  await check(S, 'auto-answer', 'Réponse automatique (Opus 5.5, utilisateur inactif) : interrupteur visible et à chaud, garde-fous obligatoires sans route qui les modifie, activité = geste du navigateur ou de l’app (jamais un script), utilisateur actif ⇒ rien, inactif + attente ⇒ décision par claude-opus-5-5 marquée partout (log, fil du chef, résumé), point de retour noté, « Vu », interrupteur coupé ⇒ rien', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'auto-answer.mjs'))) NA('réponse automatique absente de cet état du code');
    const logs = path.join(sb.root, 'logs');
    const readLog = (n) => { try { return fs.readFileSync(path.join(logs, `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
    const BROWSER = { ...H, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (regression)' };
    const settings = (b) => post('/api/auto-answer/settings', b);
    const ask = async (tag) => {
      const r = await post('/api/permission/request', { project: 'kappa', tool: 'Bash', input: { command: `echo recette-${tag}` }, toolUseId: `toolu_auto_${tag}`, timeoutMs: 30 * 60_000 });
      const j = await r.json();
      assert(r.ok && j.status === 'pending', `demande ${tag} : ${r.status} ${JSON.stringify(j)}`);
      return j.id;
    };
    const status = async (id) => (await json(`/api/permission/${id}`));
    let v = await json('/api/auto-answer');
    assert(v.settings.enabled === false && v.guardrailsAlwaysOn === true && v.model === 'claude-opus-5-5', `vue initiale : ${JSON.stringify(v.settings)}`);
    for (const id of ['argent', 'secret', 'envoi-externe', 'suppression-definitive', 'publication-prive']) assert(v.guardrails.some(g => g.id === id && g.mandatory), `garde-fou ${id} absent`);
    for (const m of ['POST', 'PUT', 'DELETE']) {
      const r = await fetch(`${sb.url}/api/auto-answer/guardrails`, { method: m, headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });
      assert(r.status === 404, `${m} /api/auto-answer/guardrails → ${r.status} (une route modifie les garde-fous)`);
    }
    assert((await settings({ idleMin: 0.001 })).status === 400, 'délai sous le minimum accepté');
    try {
      const before = (await json('/api/auto-answer')).activity.lastAt;
      await post('/api/user-activity', { kind: 'clic' });   // node: a script, not the user
      assert((await json('/api/auto-answer')).activity.lastAt === before, 'un appel de script compté comme activité de l’utilisateur');
      // User active (a gesture every second) ⇒ nothing, even with the switch on.
      assert((await settings({ enabled: true, idleMin: 0.05, waitMin: 0.01, projects: ['kappa'] })).ok, 'activation refusée');
      // The user is there when the request is born (0.123.0: a wait born before
      // the user's return is backlog, never answered automatically).
      await fetch(`${sb.url}/api/user-activity`, { method: 'POST', headers: BROWSER, body: JSON.stringify({ kind: 'clic' }) });
      const a = await ask('actif');
      for (let i = 0; i < 4; i++) { await fetch(`${sb.url}/api/user-activity`, { method: 'POST', headers: BROWSER, body: JSON.stringify({ kind: 'clic' }) }); await sleep(1000); }
      assert((await status(a)).status === 'pending', 'utilisateur actif : la demande a reçu une réponse automatique');
      v = await json('/api/auto-answer');
      assert(v.activity.last?.kind === 'clic' && !v.activity.idle, `activité du navigateur non enregistrée : ${JSON.stringify(v.activity)}`);
      // Inactive ⇒ Opus decides (fake claude, model checked), marked everywhere.
      const done = await until(async () => { const s = await status(a); return s.status === 'decided' ? s : null; }, 25_000, 500);
      assert(done && done.decision?.by === 'réponse automatique' && done.decision.decision === 'allow_once', `décision : ${JSON.stringify(done)}`);
      v = await json('/api/auto-answer');
      const rec = v.decisions.find(d => d.permissionId === a);
      assert(rec && rec.status === 'applied' && rec.kind === 'permission' && rec.served === 'claude-opus-5-5' && rec.text.startsWith('🤖 réponse automatique (Opus 5.5, utilisateur inactif)'), `registre : ${JSON.stringify(rec)}`);
      assert(rec.recovery && /Aucun point de retour possible/.test(rec.recovery.text) && /avance/.test(rec.recovery.text) && rec.undoable === false, `point de retour : ${JSON.stringify(rec.recovery)}`);
      assert(readLog('kappa').some(e => e.type === 'notification' && e.subtype === 'auto_answer' && e.autoAnswer?.id === rec.id), 'marque absente du log de kappa');
      assert(readLog('chef').some(e => e.type === 'notification' && e.subtype === 'musician_done' && e.autoAnswer?.id === rec.id && /réponse automatique/.test(e.text)), 'carte absente du fil du chef');
      assert(v.unseen >= 1, 'résumé au retour vide');
      assert((await post(`/api/auto-answer/${rec.id}/undo`, {})).status === 409, 'annulation sans point de retour acceptée');
      assert((await post('/api/auto-answer/seen', {})).ok && (await json('/api/auto-answer')).unseen === 0, '« Vu » sans effet');
      // Switch off ⇒ nothing.
      assert((await settings({ enabled: false })).ok, 'coupure refusée');
      const b = await ask('coupe');
      await sleep(4000);
      assert((await status(b)).status === 'pending', 'interrupteur coupé : réponse automatique quand même');
      await post(`/api/permission/${b}/decide`, { decision: 'deny', by: 'recette' });
      return `kappa : actif ⇒ en attente ; inactif ⇒ ${rec.id} autorisé une fois par claude-opus-5-5 (marqué dans le log, le fil, le résumé), aucun point de retour (noté) ; coupé ⇒ en attente`;
    } finally {
      await settings({ enabled: false, idleMin: 15, waitMin: 5, projects: [] });
    }
  });
  // Incident of 2026-10-20 (v0.121.0): « opus 5.5 avait pris une decision a ma
  // place alors que je suis actif, et que je ne vois aucune question en attente »
  // + « Il faut pouvoir aussi discard des notifications qui ne sont plus utiles ».
  await check(S, 'auto-answer-presence', 'Réponse automatique : un utilisateur qui lit (battement de présence du dashboard) n’est pas inactif ; une attente antérieure à l’activation est un arriéré jamais traité et listé ; la notification dit quoi, sur quel élément et pourquoi inactif ; « Écarter » retire une décision traitée et la garde dans l’historique ; une décision encore en attente exige une confirmation', async () => {
    if (!fs.existsSync(path.join(sb.root, 'scripts', 'auto-answer.mjs'))) NA('réponse automatique absente de cet état du code');
    const src = fs.readFileSync(path.join(sb.root, 'scripts', 'auto-answer.mjs'), 'utf8');
    if (!/classifyWaits/.test(src)) NA('arriéré et présence absents de cet état du code (avant 0.123.0)');
    const BROWSER = { ...H, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (regression)' };
    const settings = (b) => post('/api/auto-answer/settings', b);
    const beat = (kind = 'présence') => fetch(`${sb.url}/api/user-activity`, { method: 'POST', headers: BROWSER, body: JSON.stringify({ kind }) });
    const ask = async (tag) => {
      const r = await post('/api/permission/request', { project: 'kappa', tool: 'Bash', input: { command: `echo presence-${tag}` }, toolUseId: `toolu_presence_${tag}`, timeoutMs: 30 * 60_000 });
      const j = await r.json();
      assert(r.ok && j.status === 'pending', `demande ${tag} : ${r.status} ${JSON.stringify(j)}`);
      return j.id;
    };
    const status = async (id) => (await json(`/api/permission/${id}`));
    const ids = [];
    try {
      // 1. Backlog: born while the rule is off, then the rule is switched on.
      assert((await settings({ enabled: false })).ok, 'coupure refusée');
      const old = await ask('arriere'); ids.push(old);
      await sleep(300);
      assert((await settings({ enabled: true, idleMin: 0.05, waitMin: 0.01, projects: ['kappa'] })).ok, 'activation refusée');
      let v = await json('/api/auto-answer');
      assert(v.settings.activatedAt, `activation non datée : ${JSON.stringify(v.settings)}`);
      // 2. A reader: heartbeats only (no gesture) while a new request waits.
      await beat();
      const read = await ask('lecture'); ids.push(read);
      for (let i = 0; i < 6; i++) { await beat(); await sleep(1000); }
      assert((await status(read)).status === 'pending', 'utilisateur qui lit (battements) : réponse automatique quand même');
      v = await json('/api/auto-answer');
      assert(v.activity.last?.kind === 'présence' && !v.activity.idle, `battement non compté : ${JSON.stringify(v.activity)}`);
      // 3. The reader leaves: the new request is answered, the backlog never.
      const done = await until(async () => { const s = await status(read); return s.status === 'decided' ? s : null; }, 25_000, 500);
      assert(done && done.decision?.by === 'réponse automatique', `décision : ${JSON.stringify(done)}`);
      await sleep(3000);
      assert((await status(old)).status === 'pending', 'arriéré (né avant l’activation) traité automatiquement');
      v = await json('/api/auto-answer');
      const bl = (v.backlog || []).find(w => w.key === `perm:${old}`);
      assert(bl && bl.reason === 'avant-activation', `arriéré non listé : ${JSON.stringify(v.backlog)}`);
      const rec = v.decisions.find(d => d.permissionId === read);
      assert(rec && /autorisée une fois|refusée/.test(rec.what) && rec.target?.type === 'permission' && /Pourquoi vous étiez considéré inactif : dernier signe de vous à \d\d:\d\d \(présence/.test(rec.text) && /seuil de/.test(rec.why_inactive), `notification incomplète : ${JSON.stringify({ what: rec?.what, target: rec?.target, text: rec?.text })}`);
      // 4. Dismiss: handled ⇒ hidden, kept in the history.
      let r = await post('/api/auto-answer/dismiss', { ids: [rec.id] });
      assert(r.ok, `écarter : ${r.status}`);
      v = await json('/api/auto-answer');
      assert(!v.decisions.some(d => d.id === rec.id) && v.history.some(d => d.id === rec.id), 'écartée mais toujours affichée, ou absente de l’historique');
      // A pending decision (submitted, request still open) needs a confirmation.
      const AA = await import(pathToFileURL(path.join(sb.root, 'scripts', 'auto-answer.mjs')).href);
      const pid = AA.newId();
      AA.upsertDecision(path.join(sb.root, 'logs'), { id: pid, key: `perm:${old}`, kind: 'permission', permissionId: old, project: 'kappa', status: 'submitted', at: new Date().toISOString(), question: 'q' });
      r = await post('/api/auto-answer/dismiss', { ids: [pid] });
      const j = await r.json();
      assert(r.status === 409 && j.needsConfirm?.includes(pid), `en attente écartée sans confirmation : ${r.status} ${JSON.stringify(j)}`);
      assert((await post('/api/auto-answer/dismiss', { ids: [pid], confirm: true })).ok, 'confirmation refusée');
      // 5. Presented gaps are recorded (only gaps).
      const pr = await (await post('/api/auto-answer/presented', { keys: ['gap:recette-presence', 'log:x'] })).json();
      assert(pr.ok && pr.recorded === 1, `présentation : ${JSON.stringify(pr)}`);
      return `lecteur ⇒ en attente, parti ⇒ ${rec.id} décidé ; arriéré ${old} jamais traité (listé) ; écartée ⇒ historique ; en attente ⇒ 409 sans confirmation`;
    } finally {
      await settings({ enabled: false, idleMin: 15, waitMin: 5, projects: [] });
      for (const id of ids) await post(`/api/permission/${id}/decide`, { decision: 'deny', by: 'recette' }).catch(() => {});
    }
  });
}

async function restartCheck(sb) {
  await check('http', 'restart', 'restart-orchestrateur.mjs (copie de l\'instance) redémarre le serveur', async () => {
    const script = path.join(sb.root, 'scripts', 'restart-orchestrateur.mjs');
    if (!fs.existsSync(script)) NA('script absent');
    const src = fs.readFileSync(script, 'utf8');
    assert(!/\b7777\b/.test(src) && src.includes(String(sb.port)), 'port de la copie non réécrit — refus de lancer');
    const r = await runNode(script, sb.root, 120_000);
    assert(r.code === 0, `exit ${r.code} : ${r.out.slice(-300)}`);
    assert(await waitUp(sb.port, 30_000), 'serveur absent après redémarrage');
    const v = await (await fetch(`${sb.url}/api/version`, { headers: { 'X-Orchestrator-Token': sb.token } })).json();
    return `redémarré, v${v.version}`;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// Stale run (0.94.0): the tested content is taken at the START. If it changes
// while the run goes on, the verdict would be about content nobody delivers:
// the run stops at once — only its own suites and sandbox — and says to
// relaunch on the final content, instead of finishing for nothing.
let sbPromise = null;
let staleWatch = null;
const t0 = Date.now();
const reportOut = () => opt('--out') || path.join(REGRESS_DIR, `report-${safeLabel}.json`);
const requestedMode = () => (selection && !selection.full ? (selection.kind === 'perimeter' ? 'perimeter' : 'targeted')
  : (flag('--no-suites') || flag('--no-browser')) ? 'partial' : 'full');
function writeReport(tree, extra = {}) {
  const c = { OK: 0, KO: 0, NA: 0 };
  for (const r of results) c[r.status]++;
  const out = reportOut();
  const narrowed = selection && !selection.full;
  const commit = (spawnSync('git', ['-C', REPO, 'rev-parse', source.ref || 'HEAD'], { encoding: 'utf8' }).stdout || '').trim() || null;
  // "full" = every stage on every suite: the only kind a production jump accepts.
  // "perimeter" (0.106.0) = the impacted perimeters only: accepted by a
  // production jump when its base is the production version (prod-jump.mjs).
  const mode = narrowed ? 'targeted' : (flag('--no-suites') || flag('--no-browser')) ? 'partial' : 'full';
  // A perimeter run without a stage it needs is refused by reportCoversPlan.
  const runMode = mode === 'targeted' && selection.kind === 'perimeter' ? 'perimeter' : mode;
  const report = { label, at: new Date().toISOString(), durationS: Math.round((Date.now() - t0) / 1000), tree, commit, mode: runMode,
    ...(selection ? { selection: { since: selection.since, changed: selection.changed, full: !!selection.full, reason: selection.reason || null,
      suites: selection.suites || null, http: selection.http ?? true, browser: selection.browser ?? true,
      ...(selection.kind === 'perimeter' ? { kind: 'perimeter', base: selection.base, baseCommit: selection.baseCommit, target: selection.target, perimeters: selection.perimeters || null } : {}) } } : {}),
    ...extra, counts: c, results };
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  return { report, out, c, mode: runMode };
}
async function abortStale(info) {
  const diff = changedPaths(REPO, info.start, info.current);
  console.log(`\n${staleMessage(diff)}`);
  for (const c of liveSuites) killOwnTree(c.pid);
  try { const sb = await sbPromise; if (sb && !flag('--keep')) await sb.stop(); } catch { /* not started */ }
  const { out, c, report: rep } = writeReport(info.start, { stale: { ...info, changed: diff.paths, more: diff.more } });
  live?.finish({ status: 'stale', counts: c, reportAt: rep.at, durationS: Math.round((Date.now() - t0) / 1000) });
  console.log(`=== PÉRIMÉE : arrêtée après ${Math.round((Date.now() - t0) / 1000)} s — rapport (refusé à la livraison) : ${out}`);
  console.log('=== LIVRAISON : REFUSÉE — contenu modifié pendant l’exécution, relancer sur le contenu final');
  process.exit(STALE_EXIT);
}

async function main() {
  fs.mkdirSync(REGRESS_DIR, { recursive: true });
  console.log(`\n=== Non-régression — état testé : ${label} ===\n`);
  if (process.env.ORCH_REGRESS_LIVE !== '0') {
    try {
      live = createLiveRun({ root: REPO, label, mode: requestedMode(), argv: process.argv.slice(2) });
      live.setReport(path.relative(REPO, path.resolve(reportOut())).split(path.sep).join('/'));
      // Any other way out (crash, early exit) still leaves a final status.
      process.on('exit', (code) => { if (!live.finished) live.finish({ status: code === 0 ? 'ok' : 'error', durationS: Math.round((Date.now() - t0) / 1000) }); });
    } catch (e) { console.log(`   (suivi en direct indisponible : ${e.message})`); }
  }
  if (source.worktree && !flag('--no-stale-stop')) {
    staleWatch = createStaleWatch({ read: () => worktreeTree(REPO), onStale: (info) => { abortStale(info); } });
    if (staleWatch.start) console.log(`   contenu testé : arbre ${staleWatch.start.slice(0, 10)} — arrêt immédiat s’il change en cours de route`);
  }
  if (!flag('--no-suites')) { console.log('── 1. Suites node'); await runSuites(); }

  const narrowed = selection && !selection.full;
  const runHttp = !narrowed || selection.http;
  const runBrowser = !flag('--no-browser') && (!narrowed || selection.browser);
  if (!runHttp) console.log('\n── 2. Instance de test : non touchée par cette modification (ciblée)');
  else { console.log('\n── 2. Instance de test (autre port, fixtures, faux claude)'); live?.stage('http'); }
  let sb = null;
  if (runHttp) try {
    sbPromise = startSandbox(source, safeLabel, { port: opt('--port') || null });
    sb = await sbPromise;
    console.log(`   instance : ${sb.url}  (${sb.root})`);
    record('http', 'boot', 'Démarrage de server.js sur une instance isolée', 'OK', `port ${sb.port}`);
  } catch (e) {
    record('http', 'boot', 'Démarrage de server.js sur une instance isolée', 'KO', e.message);
  }
  if (sb) {
    try {
      await apiChecks(sb);
      if (runBrowser) {
        console.log('\n── 3. Navigateur (Edge / Playwright)');
        live?.stage('navigateur');
        const { browserChecks } = await import('./_regression_browser.mjs');
        await browserChecks(sb, { check, record, NA, assert, sleep, until, shots: opt('--shots') });
      }
      if (flag('--restart-check')) await restartCheck(sb);
    } finally {
      if (!flag('--keep')) await sb.stop();
      else console.log(`   instance conservée : ${sb.url}/?token=${sb.token}`);
    }
  }

  // The tested content is recorded: a delivery is checked against EXACTLY this
  // tree by scripts/delivery-gate.mjs (0.71.3). Since 0.94.0 it is the tree the
  // run STARTED on; one last sample catches a change in the final interval.
  if (staleWatch) {
    staleWatch.stop();
    const end = worktreeTree(REPO);
    if (staleWatch.start && end && end !== staleWatch.start) await abortStale({ start: staleWatch.start, current: end, at: new Date().toISOString() });
  }
  const tree = staleWatch?.start || (source.worktree ? worktreeTree(REPO)
    : source.ref ? (spawnSync('git', ['-C', REPO, 'rev-parse', `${source.ref}^{tree}`], { encoding: 'utf8' }).stdout || '').trim() || null : null);
  const { report, out, c, mode } = writeReport(tree);
  live?.finish({ status: c.KO ? 'ko' : 'ok', counts: c, reportAt: report.at, durationS: Math.round((Date.now() - t0) / 1000) });
  console.log(`\n=== ${mode === 'full' ? 'COMPLÈTE' : mode === 'targeted' ? 'CIBLÉE' : mode === 'perimeter' ? 'PAR PÉRIMÈTRE' : 'PARTIELLE'} : ${c.OK} OK · ${c.KO} KO · ${c.NA} NA — ${Math.round((Date.now() - t0) / 1000)} s — rapport : ${out}`);
  const gate = checkReport(report, { knownKo: readKnownKo(REPO) });
  for (const k of gate.accepted) console.log(`KO accepté (docs/known-ko.json) : ${k.id} — ${k.reason}`);
  console.log(`=== LIVRAISON : ${gate.ok ? 'AUTORISÉE' : `REFUSÉE — ${gate.reasons.join(' ; ')}`}`);
  process.exit(c.KO ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
