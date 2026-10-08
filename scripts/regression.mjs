#!/usr/bin/env node
// ============================================================================
// scripts/regression.mjs — batterie de NON-RÉGRESSION de tout le dashboard
// ============================================================================
//
// Une seule commande, à rejouer à chaque modification. Code de sortie non nul au
// moindre échec. Trois étages :
//
//   1. SUITES  : toutes les suites node `scripts/_test_*.mjs` de l'état testé
//                (sauf _test_phase2*, qui écrivent dans les vrais logs/).
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
//   node scripts/regression.mjs --no-browser         sans navigateur
//   node scripts/regression.mjs --no-suites          sans les suites node
//   node scripts/regression.mjs --shots <dossier>    enregistre les captures
//   node scripts/regression.mjs --restart-check      rejoue restart-orchestrateur.mjs sur l'instance
//   node scripts/regression.mjs --keep               garde l'instance (débogage)
//   node scripts/regression.mjs --out <fichier.json> rapport JSON (défaut .regress/report-<label>.json)
//   node scripts/regression.mjs --compare avant.json apres.json [--md sortie.md]
//
// Statuts : OK · KO · NA (fonction absente de l'état testé, ex. la vue Projets
// sur un tag antérieur). Seul KO fait échouer.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO, REGRESS_DIR, extractCode, startSandbox, waitUp, serverEnv } from './_regression_sandbox.mjs';

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
  const md = lines.join('\n');
  if (opt('--md')) fs.writeFileSync(opt('--md'), md + '\n');
  console.log(md);
  process.exit(regressions ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------
const source = opt('--ref') ? { ref: opt('--ref') } : opt('--dir') ? { dir: opt('--dir') } : { worktree: true };
const label = opt('--ref') || (opt('--dir') ? path.basename(path.resolve(opt('--dir'))) : 'worktree');
const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '_');
const results = [];
function record(stage, id, name, status, detail = '') {
  results.push({ stage, id: `${stage}:${id}`, name, status, detail: String(detail).slice(0, 400) });
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
const EXCLUDED_SUITES = {
  '_test_phase2.mjs': 'écrit dans les vrais logs/ (router-*.ndjson) et dépend du classifieur',
  '_test_phase2_5_override.mjs': 'écrit dans les vrais logs/ (router-*.ndjson)',
};
// Suites hermétiques non liées au code du serveur : ajoutées à un ancien ref
// qui ne les versionnait pas encore, pour que l'avant/après compare la même liste.
const HERMETIC_OVERLAY = [
  '_test_phase1_crlf.mjs', '_test_phase1_backpressure.mjs', '_test_phase1_close_handler.mjs',
  '_test_phase1_queue_persist.mjs', '_test_phase4b_harness.mjs',
];

function runNode(file, cwd, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [file], { cwd, env: { ...process.env, ANTHROPIC_API_KEY: '' }, windowsHide: true });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => { try { c.kill(); } catch {} }, timeoutMs);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

async function runSuites() {
  let codeRoot = REPO;
  if (!source.worktree) {
    codeRoot = path.join(REGRESS_DIR, `${safeLabel}-code-${Date.now().toString(36)}`);
    extractCode(source, codeRoot);
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
  for (const f of [...known].sort()) {
    if (EXCLUDED_SUITES[f]) { record('suite', f, `${f} (exclue : ${EXCLUDED_SUITES[f]})`, 'NA'); continue; }
    if (!suites.includes(f)) { record('suite', f, f, 'NA', 'absente de cet état du code'); continue; }
    const t0 = Date.now();
    const r = await runNode(path.join(dir, f), codeRoot);
    const tail = r.out.trim().split('\n').slice(-1)[0] || '';
    record('suite', f, f, r.code === 0 ? 'OK' : 'KO', `${tail} (${Math.round((Date.now() - t0) / 1000)} s, exit ${r.code})`);
  }
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
  await check(S, 'pupitre', '/api/pupitre : santé (stall, processus perdu, PID vivant), file, pool', async () => {
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
  await check(S, 'question', 'Question acquittée sans relancer (200 puis 409), événement dans le log', async () => {
    const a = await post('/api/question/mu/resolve', { note: 'recette', by: 'regression' });
    assert(a.status === 200, `1er acquittement ${a.status}`);
    const b = await post('/api/question/mu/resolve', { note: 'bis' });
    assert(b.status === 409, `2e acquittement ${b.status}`);
    assert(readLog('mu').some(e => e.type === 'notification' && e.subtype === 'question_resolved'), 'événement absent');
    const c = await json('/api/config');
    assert(c.projects.find(p => p.name === 'mu').currentState === 'idle', 'mu non repassé idle');
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
  await check(S, 'permission-prompt', 'Autorisations interactives : tour en attente (carte, supervision, chef prévenu), détails complets masqués, une fois / refus motivé / toujours (puis sans demande) / expiration, origine étrangère 403', async () => {
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
  await check(S, 'model-routing', 'Models par tâche : 13 pipelines (boucles, retours, renvois), une case par étape et variante, migration de l\'ancien format, capacités média, outils locaux, choix validé, enregistré hors config.json, relu, historisé', async () => {
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
    assert(ids === 'dev,discussion,routage,incident,recherche,audit,maintenance,nouveau,donnees,redaction,images,video,audio', `pipelines : ${ids}`);
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
  await check(S, 'pipeline-observe', 'Pipelines, phase 1 (observation) : chaque entrée (composer → chef, @musicien, app Android, musicien direct, dispatch.mjs via la file, notify, session neuve) est classée et journalisée une seule fois, inclassable = Discussion, aucun changement de comportement', async () => {
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
    assert(by('dashboard:chef').some(x => x.pipeline === 'dev' && x.mode === 'leger'), 'composer → chef non classé dev léger');
    assert(by('dashboard:mention').some(x => x.target === 'omega' && x.pipeline === 'discussion'), '@omega non observé (discussion)');
    assert(by('android:chef').some(x => x.pipeline === 'redaction'), 'entrée Android non reconnue');
    assert(by('dashboard:musicien').some(x => x.project === 'lambda' && x.pipeline === 'discussion' && x.unclassifiable), 'inclassable non rangé en Discussion');
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
  await check(S, 'pipeline-gaps', 'Lacunes de pipeline : une entrée inclassable est traitée en Discussion ET produit un signalement avec proposition, notifié au chef ; « Accepter » ajoute bien l’étape (choix du model ensuite), « Rejeter » n’ajoute rien ; signalement explicite d’une étape sans case', async () => {
    const first = await get('/api/pipeline-gaps');
    if (first.status === 404) NA('lacunes absentes de cet état du code');
    const routingPath = path.join(sb.root, 'model-routing.json');
    const text = 'planifie mes vacances en Italie avec un budget serré';
    // lambda : fixture sans état à préserver (beta porte la question des parcours « attention »).
    let r = await post('/api/dispatch', { project: 'lambda', prompt: text, queueIfBusy: true });
    assert(r.status === 202, `dispatch : ${r.status}`);
    const open = async () => (await json('/api/pipeline-gaps')).open;
    assert(await until(async () => (await open()).some(g => g.entries?.[0]?.head === text), 8000), 'aucun signalement pour l’entrée inclassable');
    const gap = (await open()).find(g => g.entries[0].head === text);
    assert(gap.reason === 'aucun-pipeline' && gap.entries[0].pipeline === 'discussion', 'l’entrée n’est pas traitée en Discussion');
    assert(gap.proposal?.kind === 'pipeline' && gap.proposal.text && gap.alternative?.kind === 'rattachement', `proposition : ${JSON.stringify(gap.proposal)}`);
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
    const d = await post('/api/dispatch', { project: 'omega', prompt: 'Tâche de recette pour le réveil', queueIfBusy: true, callback: 'chef' });
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
async function main() {
  fs.mkdirSync(REGRESS_DIR, { recursive: true });
  console.log(`\n=== Non-régression — état testé : ${label} ===\n`);
  const t0 = Date.now();
  if (!flag('--no-suites')) { console.log('── 1. Suites node'); await runSuites(); }

  console.log('\n── 2. Instance de test (autre port, fixtures, faux claude)');
  let sb = null;
  try {
    sb = await startSandbox(source, safeLabel);
    console.log(`   instance : ${sb.url}  (${sb.root})`);
    record('http', 'boot', 'Démarrage de server.js sur une instance isolée', 'OK', `port ${sb.port}`);
  } catch (e) {
    record('http', 'boot', 'Démarrage de server.js sur une instance isolée', 'KO', e.message);
  }
  if (sb) {
    try {
      await apiChecks(sb);
      if (!flag('--no-browser')) {
        console.log('\n── 3. Navigateur (Edge / Playwright)');
        const { browserChecks } = await import('./_regression_browser.mjs');
        await browserChecks(sb, { check, record, NA, assert, sleep, until, shots: opt('--shots') });
      }
      if (flag('--restart-check')) await restartCheck(sb);
    } finally {
      if (!flag('--keep')) await sb.stop();
      else console.log(`   instance conservée : ${sb.url}/?token=${sb.token}`);
    }
  }

  const c = { OK: 0, KO: 0, NA: 0 };
  for (const r of results) c[r.status]++;
  const out = opt('--out') || path.join(REGRESS_DIR, `report-${safeLabel}.json`);
  fs.writeFileSync(out, JSON.stringify({ label, at: new Date().toISOString(), durationS: Math.round((Date.now() - t0) / 1000), counts: c, results }, null, 2));
  console.log(`\n=== ${c.OK} OK · ${c.KO} KO · ${c.NA} NA — ${Math.round((Date.now() - t0) / 1000)} s — rapport : ${out}`);
  process.exit(c.KO ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
