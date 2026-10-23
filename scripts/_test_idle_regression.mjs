#!/usr/bin/env node
// ============================================================================
// scripts/_test_idle_regression.mjs — full non-regression AFTER the fact,
// during idle hours only (0.142.0, scripts/idle-regression.mjs)
// ============================================================================
//
// User decision (2026-10-23): « non. la non régression ne serait plus une
// condition pour la mise en prod. la.mise en prod ne dépend plus que des tests
// unitaires et les non régression ne servent plus qu'à posteriori. Les non
// régressions et corrections ne sont lancées que pendant les heures
// d'inactivité ». Context: « ne faire les tests de non régression qu'en dehors
// des sprints de dev. mesures un laps de temps d'au moins une demi heure avant
// d'autoriser un lancement de non régression ».
//
//   1. Switch: off by default, on/off/projects/--idle-min by pipeline-enforce,
//      off --all; frozen per run.
//   2. Idle window (sweep with injected effects): nothing while the user is
//      active or a musician runs; launch after idleMin; stop when activity
//      resumes or a musician starts; relaunch in a later window.
//   3. Real end to end on a git fixture (detached runner, real worktrees):
//      green → red → bisect → culprit → alert → fix dispatched while idle only.
//   4. Requirement suites still run with the task (targeted, never the full one).
//   5. prod-jump without a full run (task's tests green), refused on KO/stale;
//      off = the previous rule.
//   6. The real dispatch.mjs: the musician's rule and ORCH_UNIT_DELIVERY.
//   7. Never a production checkout; chef-alerts kind `posteriori`.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as IR from './idle-regression.mjs';
import { runStep } from './idle-regression-runner.mjs';
import { selectTargets } from './regression-targets.mjs';
import { regressionAlerts, alertLine, KINDS } from './chef-alerts.mjs';
import { preflight, jumpPlan } from './prod-jump.mjs';
import { checkUnitReport } from './delivery-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true });
const MIN = 60_000;

// ---------------------------------------------------------------------------
section('1. Interrupteur : coupé par défaut, réglable à chaud, figé par exécution');
{
  const R = tmp('orch-idle-sw-');
  fs.writeFileSync(path.join(R, 'config.json'), JSON.stringify({ conductor: 'chef', projects: [{ name: 'A', path: R }, { name: 'B', path: R }] }));
  let s = IR.readSettings(R);
  ok(!s.enabled && s.idleMin === 30, 'absent = coupé, seuil par défaut 30 min');
  const pe = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline-enforce.mjs'), ...a], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: R }, encoding: 'utf8' });
  let r = pe('idle-regression', 'on', '--idle-min', '45');
  s = IR.readSettings(R);
  ok(r.status === 0 && s.enabled && s.idleMin === 45 && !s.projects && s.since, `on --idle-min 45 : actif pour tous, seuil 45 min (${r.stdout.trim().slice(0, 80)}…)`);
  r = pe('idle-regression', 'off');
  ok(!IR.readSettings(R).enabled && IR.readSettings(R).idleMin === 45, 'off : coupé, le seuil reste mémorisé');
  r = pe('idle-regression', 'on', 'A');
  s = IR.readSettings(R);
  ok(s.enabled && JSON.stringify(s.projects) === '["A"]' && IR.enabledFor(s, 'A') && !IR.enabledFor(s, 'B'), 'on A : seulement le projet A');
  r = pe('idle-regression', 'on', 'Z');
  ok(r.status === 64, 'projet inconnu refusé (64)');
  r = pe('idle-regression', 'on', '--idle-min', '0');
  ok(r.status === 64, 'seuil hors bornes refusé (64)');
  r = pe('off', '--all');
  ok(!IR.readSettings(R).enabled, 'off --all coupe aussi idleRegression');
  // Frozen per run: run.json keeps the value it read at the start.
  pe('idle-regression', 'on');
  const st = {};
  ok(IR.runIdleRegression(st, R, ['A']) === true && st.idleRegression === true, 'départ d’une exécution : valeur lue et figée dans run.json');
  pe('idle-regression', 'off');
  ok(IR.runIdleRegression(st, R, ['A']) === true, 'coupé ensuite : l’exécution garde sa valeur');
  ok(IR.runIdleRegression({}, R, ['A'], { resumed: true }) === false, 'reprise d’une exécution d’avant 0.142.0 : ancien comportement');
  fs.rmSync(R, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('2. Fenêtre d’inactivité (balayage, effets simulés)');
{
  const L = tmp('orch-idle-win-');
  let now = Date.parse('2026-10-23T20:00:00Z');
  let activity = now;           // the user was there just now
  let busy = false;
  let head = 'c'.repeat(40);
  const launched = [], killed = [];
  const alive = new Set();
  let nextPid = 1000;
  const deps = () => ({
    logsDir: L, now, bootAt: 0,
    settings: () => IR.cleanSettings({ enabled: true, since: '2026-10-23T00:00:00Z', idleMin: 30 }),
    lastActivityAt: () => activity,
    targets: () => [{ name: 'P', path: L, plan: { full: ['run'], bisect: null, inPlace: false } }],
    busy: () => busy, head: () => head, revList: () => [], subject: () => null,
    launch: (step) => { const pid = nextPid++; alive.add(pid); launched.push({ ...step, pid }); return { pid }; },
    alive: (pid) => alive.has(pid), kill: (pid) => { killed.push(pid); alive.delete(pid); },
    dispatchFix: () => {}, chefAlertsOn: () => true,
  });
  let v = IR.sweep({ ...deps(), settings: () => IR.cleanSettings({}) });
  ok(v.off && !launched.length && !fs.existsSync(IR.stateFile(L)), 'coupé : rien lu, rien écrit, rien lancé');
  v = IR.sweep(deps());
  ok(v.waiting && !launched.length, 'utilisateur actif : aucune non-régression');
  now += 29 * MIN; v = IR.sweep(deps());
  ok(v.waiting && !launched.length, 'inactif depuis 29 min : toujours rien (seuil 30 min)');
  now += 1 * MIN; busy = true; v = IR.sweep(deps());
  ok(!launched.length, 'inactif depuis 30 min mais un musicien est en cours : rien');
  busy = false; v = IR.sweep(deps());
  ok(launched.length === 1 && launched[0].kind === 'full' && launched[0].commit === head, 'inactif ≥ 30 min, aucun musicien : complète lancée sur la tête');
  v = IR.sweep(deps());
  ok(v.running && launched.length === 1, 'une seule à la fois : la suivante attend');
  activity = now; v = IR.sweep(deps());
  ok(killed.includes(launched[0].pid) && !IR.readState(L).active && IR.readState(L).projects.P.interrupted === 1, 'activité reprise : arrêtée proprement (processus tué, état « interrompue »)');
  ok(fs.readFileSync(IR.journalFile(L), 'utf8').includes('activité de l’utilisateur reprise'), 'arrêt journalisé avec la raison');
  now += 31 * MIN; v = IR.sweep(deps());
  ok(launched.length === 2 && launched[1].commit === head, 'nouvelle fenêtre d’inactivité : relancée');
  busy = true; v = IR.sweep(deps());
  ok(killed.includes(launched[1].pid), 'un musicien démarre sur le projet : arrêtée');
  busy = false; now += MIN; IR.sweep(deps());
  // Result: green → lastGreen, nothing more on the same head.
  fs.writeFileSync(launched[2].resultFile, JSON.stringify({ code: 0, ko: [] }));
  IR.sweep(deps());
  ok(IR.readState(L).projects.P.lastGreen?.commit === head, 'verte : dernière complète verte = la tête');
  v = IR.sweep(deps());
  ok(v.nothing && launched.length === 3, 'tête inchangée : rien à refaire');
  // A dead runner without result = interrupted, relaunched later.
  head = 'd'.repeat(40); IR.sweep(deps());
  alive.delete(launched[3].pid); v = IR.sweep(deps());
  ok(launched.length === 5 && IR.readState(L).projects.P.interrupted === 3, 'processus mort sans résultat : interrompue, relancée');
  // Switching off stops the run in progress.
  IR.sweep({ ...deps(), settings: () => IR.cleanSettings({}) });
  ok(killed.includes(launched[4].pid) && !IR.readState(L).active, 'interrupteur coupé : la complète en cours est arrêtée');
  fs.rmSync(L, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('3. Bout en bout réel : verte → rouge → recherche du commit fautif → alerte → correction différée');
{
  const W = tmp('orch-idle-e2e-');
  const P = path.join(W, 'proj'), L = path.join(W, 'logs');
  fs.mkdirSync(path.join(P, '.orchestrateur'), { recursive: true });
  git(W, 'init', '-q', P);
  fs.writeFileSync(path.join(P, 'check.mjs'), "import fs from 'node:fs';\nif (fs.existsSync('bug.txt')) { console.log('KO bug'); process.exit(1); }\nconsole.log('OK');\n");
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node check.mjs' }));
  git(P, 'add', '-A'); git(P, 'commit', '-qm', 'c1 base');
  const c1 = git(P, 'rev-parse', 'HEAD').stdout.trim();
  let now = Date.now() + 60 * MIN;
  let activity = Date.now() - 60 * MIN;
  const alerts = [], fixes = [];
  let chefAlertsOn = false;
  const deps = () => ({
    logsDir: L, now: Date.now(), bootAt: 0,
    settings: () => IR.cleanSettings({ enabled: true, since: '2026-01-01T00:00:00Z', idleMin: 30 }),
    lastActivityAt: () => activity,
    targets: (s) => IR.targetsOf({ projects: [{ name: 'proj', path: P }], inService: ['proj'], settings: s, isProd: () => false }),
    busy: () => false, head: IR.gitHead, revList: IR.gitRevList, subject: IR.gitSubject,
    launch: (step) => IR.launchRunner(step, { root: ROOT }), alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
    kill: IR.killTree, dispatchFix: (name, text) => fixes.push({ name, text, at: Date.now() }),
    chefAlertsOn: () => chefAlertsOn, alert: (a) => alerts.push(...a),
  });
  const until = async (pred, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { IR.sweep(deps()); if (pred()) return true; await sleep(250); } return false; };
  ok(IR.targetsOf({ projects: [{ name: 'proj', path: P }], inService: ['proj'], settings: IR.cleanSettings({ enabled: true }), isProd: () => false })[0]?.plan.full[1] === 'node check.mjs',
    'projet sans déclaration : sa testCommand, dans un worktree du commit');
  ok(await until(() => IR.readState(L).projects.proj?.lastGreen?.commit === c1), 'complète réelle verte sur c1 (runner détaché, worktree)');
  ok(!git(P, 'worktree', 'list').stdout.includes('wt'), 'worktree retiré après l’essai');
  for (const [file, msg] of [['a.txt', 'c2 a'], ['bug.txt', 'c3 introduit le bug'], ['b.txt', 'c4 b'], ['c.txt', 'c5 c']]) {
    fs.writeFileSync(path.join(P, file), 'x'); git(P, 'add', '-A'); git(P, 'commit', '-qm', msg);
  }
  const c3 = git(P, 'rev-parse', 'HEAD~2').stdout.trim();
  const c5 = git(P, 'rev-parse', 'HEAD').stdout.trim();
  ok(await until(() => IR.readState(L).projects.proj?.red?.searchDone), 'complète rouge sur c5, puis recherche du commit fautif menée à son terme');
  const red = IR.readState(L).projects.proj.red;
  ok(red.commit === c5 && red.good === c1, 'rouge sur la tête, recherche depuis la dernière complète verte');
  ok(red.bisect.culprit === c3 && red.bisect.subject === 'c3 introduit le bug', `commit fautif trouvé : ${red.bisect.culprit?.slice(0, 7)} « ${red.bisect.subject} »`);
  ok(red.bisect.steps.length === 2, `recherche dichotomique : ${red.bisect.steps.length} essais pour 4 commits`);
  ok(alerts.length === 1 && alerts[0].kind === 'posteriori' && alerts[0].red.culprit === c3, 'alerte au chef (chef-alerts coupé : réveil direct), avec le commit fautif');
  // The fix waits for an idle window and a free musician.
  ok(await until(() => fixes.length === 1, 10_000), 'correction lancée pendant l’inactivité');
  ok(fixes[0].name === 'proj' && /voie Incident/.test(fixes[0].text) && fixes[0].text.includes(c3.slice(0, 7)) && /Ne lance pas de non-régression complète/.test(fixes[0].text),
    'demande de correction : voie Incident, commit fautif, pas de complète');
  IR.sweep(deps());
  ok(fixes.length === 1, 'correction lancée une seule fois');
  // Same head, still red: nothing re-launched until a new commit.
  ok(IR.sweep(deps()).nothing, 'tête toujours rouge, inchangée : aucune relance');
  // The fix commits: the next idle full run is green again.
  fs.rmSync(path.join(P, 'bug.txt')); git(P, 'add', '-A'); git(P, 'commit', '-qm', 'c6 correction');
  const c6 = git(P, 'rev-parse', 'HEAD').stdout.trim();
  ok(await until(() => IR.readState(L).projects.proj?.lastGreen?.commit === c6), 'après la correction : complète verte, rouge levé');
  ok(!IR.readState(L).projects.proj.red && fs.readFileSync(IR.journalFile(L), 'utf8').includes('"repaired"'), 'état rouge effacé, réparation journalisée');
  // A run stopped by activity is really killed.
  fs.writeFileSync(path.join(P, 'check.mjs'), "setTimeout(() => {}, 120000);\n"); git(P, 'add', '-A'); git(P, 'commit', '-qm', 'c7 lent');
  IR.sweep(deps());
  const a = IR.readState(L).active;
  await sleep(1500);
  activity = Date.now();
  IR.sweep(deps());
  await sleep(500);
  let alive = true; try { process.kill(a.pid, 0); } catch { alive = false; }
  ok(a && !alive && !IR.readState(L).active, 'activité reprise : le vrai processus (et son arbre) est arrêté');
  // With chef-alerts on, the alert is carried by its sweep (posterioriAlerts).
  chefAlertsOn = true;
  const L2 = path.join(W, 'logs2'); fs.mkdirSync(L2);
  fs.writeFileSync(IR.stateFile(L2), JSON.stringify({ projects: { proj: { red: { commit: c5, at: new Date().toISOString(), ko: ['testCommand'], searchDone: true, good: c1, bisect: { culprit: c3 }, alerted: { via: 'chef-alerts' } } } } }));
  const pa = IR.posterioriAlerts({ logsDir: L2, since: '2026-01-01T00:00:00Z' });
  ok(pa.length === 1 && KINDS.includes('posteriori'), 'chef-alerts actif : l’alerte passe par son balayage (une fois par événement)');
  const line = alertLine(pa[0], 0, { root: ROOT });
  ok(/A POSTERIORI rouge/.test(line) && line.includes(c3.slice(0, 7)) && /fix proj --now/.test(line), 'texte de l’alerte : complète a posteriori, commit fautif, correction différée');
  git(P, 'worktree', 'prune');
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('4. Tests de la tâche : jamais la complète, les tests d’exigence restent');
{
  const R = tmp('orch-idle-sel-');
  fs.mkdirSync(path.join(R, 'scripts'));
  fs.writeFileSync(path.join(R, 'scripts', 'feature.mjs'), 'export const f = 1;\n');
  fs.writeFileSync(path.join(R, 'scripts', 'orphan.mjs'), 'export const o = 1;\n');
  fs.writeFileSync(path.join(R, 'scripts', '_test_feature_requirement.mjs'), "import { f } from './feature.mjs';\n");
  fs.writeFileSync(path.join(R, 'scripts', '_test_user_requirements.mjs'), '\n');
  git(R, 'init', '-q'); git(R, 'add', '-A'); git(R, 'commit', '-qm', 'base');
  const files = ['scripts/feature.mjs', 'scripts/orphan.mjs', 'scripts/_test_feature_requirement.mjs', 'scripts/_test_user_requirements.mjs'];
  const old = selectTargets(R, ['scripts/feature.mjs', 'scripts/orphan.mjs'], { files });
  ok(old.full, 'interrupteur coupé : un fichier non couvert ⇒ la complète (comportement d’avant)');
  const sel = selectTargets(R, ['scripts/feature.mjs', 'scripts/orphan.mjs'], { files, noFull: true });
  ok(!sel.full && sel.deferred?.some(d => d.file === 'scripts/orphan.mjs' && /a posteriori/.test(d.reason)), 'interrupteur allumé : jamais la complète, le fichier non couvert est reporté a posteriori');
  ok(sel.suites.some(s => s.file === '_test_feature_requirement.mjs'), 'le test d’exigence qui couvre le fichier modifié tourne avec la tâche');
  ok(sel.suites.some(s => s.file === '_test_user_requirements.mjs'), 'le registre des exigences (socle) tourne toujours');
  const pkgSel = selectTargets(R, ['package-lock.json'], { files, noFull: true });
  ok(!pkgSel.full && pkgSel.deferred.length === 1, 'dépendances modifiées : reportées a posteriori, pas de complète pendant la tâche');
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'regression.mjs'), 'utf8');
  ok(/ORCH_UNIT_DELIVERY === '1'/.test(src) && /--no-full/.test(src) && /--only-suites/.test(src), 'regression.mjs : --targeted sans repli (--no-full / ORCH_UNIT_DELIVERY), --only-suites pour la recherche');
  fs.rmSync(R, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('5. Mise en prod sans complète (prod-jump)');
{
  const W = tmp('orch-idle-jump-');
  const D = path.join(W, 'dev'), Pd = path.join(W, 'prod');
  git(W, 'init', '-q', D);
  fs.writeFileSync(path.join(D, 'a.txt'), '1'); git(D, 'add', '-A'); git(D, 'commit', '-qm', 'v1');
  spawnSync('git', ['clone', '-q', D, Pd], { windowsHide: true });
  fs.writeFileSync(path.join(D, 'a.txt'), '2'); git(D, 'add', '-A'); git(D, 'commit', '-qm', 'v2');
  git(D, 'tag', '-a', 'v9.9.9', '-m', 't');
  const tree = git(D, 'rev-parse', 'v9.9.9^{tree}').stdout.trim();
  fs.mkdirSync(path.join(D, '.regress'));
  const report = (name, extra) => fs.writeFileSync(path.join(D, '.regress', name), JSON.stringify({ label: 'worktree', at: new Date().toISOString(), tree, mode: 'targeted', results: [{ id: 'suite:_test_x.mjs', status: 'OK' }], ...extra }));
  report('report-worktree.json', {});
  // The production's switch is read, never written.
  const mr = path.join(Pd, 'model-routing.json');
  let p = preflight({ dev: D, prod: Pd, tag: 'v9.9.9', turnLock: path.join(W, 'none.lock') });
  ok(!p.ok && p.problems.some(x => /COMPLÈTE/.test(x)), 'interrupteur coupé : la ciblée ne suffit pas (comportement d’avant)');
  fs.writeFileSync(mr, JSON.stringify({ idleRegression: { enabled: true, since: '2026-10-23T00:00:00Z', idleMin: 30 } }));
  // model-routing.json is untracked in this prod fixture: keep the tree clean.
  fs.appendFileSync(path.join(Pd, '.git', 'info', 'exclude'), 'model-routing.json\n');
  const before = fs.readFileSync(mr, 'utf8');
  p = preflight({ dev: D, prod: Pd, tag: 'v9.9.9', turnLock: path.join(W, 'none.lock') });
  ok(p.ok && p.report.unit && p.report.mode === 'targeted', 'interrupteur allumé : tests de la tâche verts sur le tag ⇒ mise en prod possible, sans complète');
  ok(fs.readFileSync(mr, 'utf8') === before, 'le réglage de la prod est lu, jamais écrit');
  ok(/a posteriori/.test(p.plan.at(-1)) && /jamais en prod/.test(p.plan.at(-1)), 'plan : la complète tourne a posteriori sur orchestrateur-dev, jamais en prod');
  ok(p.plan[0].includes('prod-before-v9.9.9'), 'le point de retour prod-before-… reste');
  report('report-worktree.json', { results: [{ id: 'suite:_test_x.mjs', status: 'KO', detail: 'rouge' }] });
  p = preflight({ dev: D, prod: Pd, tag: 'v9.9.9', turnLock: path.join(W, 'none.lock') });
  ok(!p.ok && p.problems.some(x => /KO non accepté/.test(x)), 'tests de la tâche rouges : refusée');
  report('report-worktree.json', { stale: { start: tree } });
  ok(!checkUnitReport(JSON.parse(fs.readFileSync(path.join(D, '.regress', 'report-worktree.json'), 'utf8')), { tree }).ok, 'rapport périmé : refusé');
  fs.rmSync(path.join(D, '.regress', 'report-worktree.json'));
  report('report-idle-bisect-x.json', { mode: 'partial' });
  p = preflight({ dev: D, prod: Pd, tag: 'v9.9.9', turnLock: path.join(W, 'none.lock') });
  ok(!p.ok, 'un essai de recherche du programme (report-idle-…, quelques suites) ne vaut pas les tests de la tâche');
  ok(/puis non-régression sur orchestrateur-dev/.test(jumpPlan({ prod: Pd, tag: 'v1' }).at(-1)), 'interrupteur coupé : plan d’avant inchangé');
  fs.rmSync(W, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('6. Le vrai dispatch.mjs : consigne du musicien et ORCH_UNIT_DELIVERY');
{
  const T = tmp('orch-idle-disp-');
  fs.mkdirSync(path.join(T, 'logs')); fs.mkdirSync(path.join(T, 'proj'));
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
    conductor: 'chef', defaults: { model: 'claude-opus-5-5', allowedTools: 'Read', provider: 'claude' },
    projects: [{ name: 'chef', path: path.join(T, 'proj') }, { name: 'M', path: path.join(T, 'proj') }],
  }));
  const STUB = path.join(T, 'claude-stub.mjs');
  fs.writeFileSync(STUB, `
import fs from 'node:fs';
fs.writeFileSync(process.env.STUB_ARGS, JSON.stringify({ argv: process.argv.slice(2), unit: process.env.ORCH_UNIT_DELIVERY || null }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'sid-i', model: 'claude-opus-5-5' });
out({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'fait' }] }, session_id: 'sid-i' });
out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_api_ms: 5, result: 'fait', session_id: 'sid-i' });
`);
  const run = (n) => {
    const argsFile = path.join(T, `args-${n}.json`);
    const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: STUB, STUB_ARGS: argsFile, ORCH_UNIT_DELIVERY: '1' };
    delete env.ANTHROPIC_API_KEY;
    for (const k of Object.keys(env)) if (/^DISPATCH_/.test(k) && k !== 'DISPATCH_ROOT_FOR_TESTS') delete env[k];
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'M', `Ajoute la fonction ${n}`, '--no-queue-if-busy', '--new-session'], { env, encoding: 'utf8', timeout: 60_000 });
    let j = {}; try { j = JSON.parse(fs.readFileSync(argsFile, 'utf8')); } catch {}
    return { r, prompt: (j.argv || []).find(a => a.startsWith(`Ajoute la fonction ${n}`)) || '', unit: j.unit };
  };
  const off = run('a');
  ok(off.r.status === 0 && off.prompt.includes(IR.requirementsRuleText(false)) && /Avant toute modification, rejoue cette suite/.test(off.prompt), 'coupé : consigne d’avant, mot pour mot');
  ok(off.unit === null, 'coupé : ORCH_UNIT_DELIVERY retiré de l’environnement du tour (même hérité)');
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ idleRegression: { enabled: true, since: '2026-10-23T00:00:00Z', idleMin: 30 } }));
  const on = run('b');
  ok(on.r.status === 0 && /Ne lance JAMAIS de non-régression complète/.test(on.prompt) && !/Avant toute modification, rejoue cette suite/.test(on.prompt), 'allumé : tests de la tâche seulement, jamais de complète avant ni après');
  ok(/tests d'exigence compris/.test(on.prompt) && /ni supprimé ni affaibli/.test(on.prompt), 'allumé : les tests d’exigence restent exécutés et intouchables');
  ok(on.unit === '1', 'allumé : ORCH_UNIT_DELIVERY=1 pour le tour (la ciblée ne bascule jamais sur la complète)');
  fs.rmSync(T, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('7. Jamais dans une prod ; essais du programme hors des alertes « non-régression KO »');
{
  const projects = [{ name: 'orchestrateur', path: 'I:\\orchestrateur' }, { name: 'orchestrateur-dev', path: ROOT, devOf: 'orchestrateur' }, { name: 'chef', path: ROOT }];
  const t = IR.targetsOf({ projects, inService: ['orchestrateur'], conductor: 'chef', settings: IR.cleanSettings({ enabled: true, projects: ['orchestrateur'] }) });
  ok(!t.some(x => x.name === 'orchestrateur'), 'la prod (I:\\orchestrateur) n’est jamais une cible');
  ok(t.length === 1 && t[0].name === 'orchestrateur-dev' && t[0].plan.inPlace && t[0].plan.full.includes('--ref'), 'l’orchestrateur est testé dans orchestrateur-dev (regression.mjs --ref, déclaré dans pipeline.json)');
  const W = tmp('orch-idle-prod-');
  fs.writeFileSync(path.join(W, '.orchestrateur-instance.json'), JSON.stringify({ role: 'prod' }));
  const res = path.join(W, 'r.json');
  const code = await runStep({ id: 'x', path: W, commit: 'HEAD', argv: ['node', '-e', '0'], inPlace: true, resultFile: res, logFile: path.join(W, 'x.log') });
  ok(code === 65 && JSON.parse(fs.readFileSync(res, 'utf8')).refused, 'le runner refuse une prod (65), même appelé directement');
  const dir = path.join(W, 'repo'); fs.mkdirSync(path.join(dir, '.regress', 'live'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.regress', 'history.ndjson'), [
    { id: 'r1', status: 'ko', startedAt: '2026-10-23T10:00:00Z', endedAt: '2026-10-23T10:30:00Z', launcher: { by: 'idle-regression' }, ko: ['suite:x'] },
    { id: 'r2', status: 'ko', startedAt: '2026-10-23T11:00:00Z', endedAt: '2026-10-23T11:30:00Z', launcher: { by: 'tour de M' }, ko: ['suite:y'] },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const ra = regressionAlerts({ dirs: [{ project: 'M', dir }], since: '2026-10-23T00:00:00Z' });
  ok(ra.length === 1 && ra[0].run.id === 'r2', 'chef-alerts : un essai du programme (bisect) n’est pas signalé comme non-régression KO');
  fs.rmSync(W, { recursive: true, force: true });
  const reg = fs.readFileSync(path.join(ROOT, 'docs', 'USER_REQUIREMENTS.md'), 'utf8');
  ok(reg.includes(IR.USER_DECISION) && reg.includes(IR.USER_CONTEXT), 'registre des exigences : les deux citations de l’utilisateur');
}

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
