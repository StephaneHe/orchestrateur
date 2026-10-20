#!/usr/bin/env node
// ============================================================================
// scripts/_test_infra_retry.mjs — infrastructure failures are held for a retry and
// relaunched, never counted as errors or step criteria (Routage v3, phase 0 a)
// ============================================================================
//
// User decision (2026-10-19, docs/ROUTAGE-SYNTHESE.md §3.7 and §3.9, phase 0 a):
// « Les pannes d'infrastructure (OAuth expiré, limite de session/quota, refus
// du fournisseur, sortie 1) ne sont plus comptées comme des erreurs ni des
// critères d'étape : la demande est mise de côté, relancée automatiquement, et
// l'utilisateur voit un message clair. »
//
// Real production cases replayed (exact CLI results, fake claude
// FAKE_CLAUDE_INFRA_FILE):
//   - p-20261014T044705-556920: « Failed to authenticate: OAuth session expired
//     and could not be refreshed » — 2 tries, a [DÉFAUT] each, then a
//     « criteria » pause (« refusée 2 fois par les vérifications automatiques »);
//   - p-20261012T085659-061170: « API Error: Sonnet 5.5 can't help with this.
//     Start a new session to continue. » — same path;
//   - p-20261012T102220-3a6fde: « You've hit your session limit » — pause
//     « model indisponible » recommending to change the model, no relaunch.
//
// Protected (real dispatch.mjs + engine):
//   1. OAuth: ONE turn (no blind retry), no attempt counted, no defect, no
//      [DÉFAUT] to the chef; run paused « infra » with the clear message; set
//      aside in the registry; relaunched by the sweep only once the Claude
//      credentials changed — and then it finishes;
//   2. provider refusal: one new try in a FRESH session; a second refusal sets
//      the run aside, never relaunched automatically;
//   3. session limit: held until the reset time, relaunched after it;
//   4. exit without a result (« sortie 1 »), after the in-run back-off: set
//      aside, automatic relaunch at 5 min;
//   5. a real criterion failure is unchanged (counted, reported, « criteria »).
//
//   node scripts/_test_infra_retry.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FAST_TEST_COMMAND } from '../tests/fixture-speed.mjs';
import * as IP from './infra-retry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Chef notifications are recorded ([DÉFAUT] must never be sent for these failures).
const notes = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { try { notes.push(JSON.parse(b)); } catch { notes.push({ raw: b }); } res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-infra-retry-'));
const LOGS = path.join(T, 'logs');
const P = path.join(T, 'P');
for (const d of [LOGS, P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude', maxParallel: 1 },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' },
    ...Object.fromEntries(['comprendre', 'rechercher', 'repondre'].map(s => [`discussion.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
}));
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
fs.mkdirSync(path.join(P, 'test')); fs.mkdirSync(path.join(P, '.orchestrateur'));
fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: FAST_TEST_COMMAND, testGlobs: ['test/**'], versionFiles: ['package.json'] }));
g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');

const CRED = path.join(T, 'credentials.json');
fs.writeFileSync(CRED, '{}');
fs.utimesSync(CRED, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
const INFRA = path.join(T, 'infra.json');
const setInfra = (cause, left) => fs.writeFileSync(INFRA, JSON.stringify({ cause, left }));
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', FAKE_CLAUDE_INFRA_FILE: INFRA,
  ORCH_CLAUDE_CREDENTIALS: CRED, ORCH_BACKOFF_STEP_MS: '1', ORCH_BACKOFF_MAX_TIERS: '1' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|TURN_ID)$|^DISPATCH_SLOT$|^FAKE_PIPE_|^ORCH_PIPE_(ITEMS|REVIEW_ROUNDS|GREEN_ATTEMPTS|CRITERIA_ATTEMPTS)$/.test(k)) delete baseEnv[k];
const logOf = () => { try { return fs.readFileSync(path.join(LOGS, 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const runState = (run) => JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', run, 'run.json'), 'utf8'));
const dispatch = (args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const go = (args, env) => {
  const n0 = logOf().length, k0 = notes.length;
  const r = dispatch(args, env);
  const evs = logOf().slice(n0);
  const run = evs.find(e => e.type === 'user_prompt' && e.pipeline)?.pipeline.run;
  return { ...r, evs, run, st: run ? runState(run) : null, notes: notes.slice(k0), result: evs.filter(e => e.type === 'result').pop() };
};
const ASK = ['Pourquoi le projet P n’a-t-il qu’un seul commit ?', '--pipeline', 'discussion'];
const stepStarts = (evs) => evs.filter(e => e.subtype === 'pipeline_step_start').length;
const noDefect = (x) => !x.evs.some(e => e.subtype === 'pipeline_defect') && !x.notes.some(n => /DÉFAUT/.test(JSON.stringify(n)));
const clearLimit = () => { try { fs.rmSync(path.join(LOGS, 'claude-limited.until'), { force: true }); } catch {} };
const waitStatus = async (run, want, ms = 120_000) => { const t = Date.now() + ms; while (Date.now() < t) { try { if (runState(run).status === want) return true; } catch {} await sleep(300); } return false; };

try {
  // -------------------------------------------------------------------------
  section('1. Rejeu de p-20261014T044705-556920 : connexion OAuth expirée');
  setInfra('auth', 99);
  let x = await go(ASK);
  ok(x.code === 2 && x.st?.status === 'paused' && x.st.pausedLimit === 'infra' && x.st.infra?.cause === 'auth', `en attente de relance : ${x.st?.status} / ${x.st?.pausedLimit} / ${x.st?.infra?.cause} (code ${x.code})`, x.out.slice(-900));
  ok(stepStarts(x.evs) === 1, `un seul tour, aucun nouvel essai à l’aveugle (${stepStarts(x.evs)} tour(s) d’étape ; la prod en faisait 2)`);
  ok(x.st && !x.st.steps.some(s => s.status === 'failed' || s.status === 'refused') && x.st.steps.every(s => s.status === 'infra'), `aucun essai compté comme échec ni refus (${x.st?.steps.map(s => s.status).join(', ')})`);
  ok(noDefect(x), 'aucun défaut signalé, aucun [DÉFAUT] envoyé au chef', JSON.stringify(x.notes).slice(0, 600));
  ok(x.result && !x.result.is_error && x.result.pipeline_paused === true, 'le tour finit en pause (question), jamais en erreur');
  const msg = x.result?.result || '';
  ok(/⚠ Ce qui s’est passé : la connexion de Claude a expiré/.test(msg) && /✓ Ce que j’ai fait : votre demande est gardée/.test(msg) && /→ Vous pouvez répondre : « continuer »/.test(msg) && /claude \/login/.test(msg) && !/vérifications automatiques/.test(msg),
    'message clair : ce qui s’est passé, ce qui est fait, quoi répondre (et pas « refusée par les vérifications automatiques »)', msg);
  const held = IP.readRetries(LOGS).find(e => e.run === x.run);
  ok(held?.cause === 'auth' && held.retryAt === null, `inscrite au registre des relances (${JSON.stringify(held)})`);
  const env1 = { ...process.env, ORCH_CLAUDE_CREDENTIALS: CRED };
  ok(IP.dueRetries(LOGS, { now: Date.now() + 86_400_000, env: env1 }).due.length === 0, 'pas de relance tant que Claude n’est pas reconnecté (même un jour plus tard)');
  // The user runs `claude /login`: the credentials file changes.
  setInfra('auth', 0);
  fs.writeFileSync(CRED, '{"renewed":true}');
  const sw = IP.sweepRetries({ root: T, env: { ...baseEnv } });
  ok(sw.launched.length === 1 && sw.launched[0].run === x.run, `reconnexion vue : relance automatique (${sw.launched.map(l => l.why).join(', ')})`);
  ok(await waitStatus(x.run, 'done'), `l’exécution relancée se termine (${runState(x.run).status})`);
  ok(IP.sweepRetries({ root: T, env: { ...baseEnv } }).launched.length === 0 && !IP.readRetries(LOGS).some(e => e.run === x.run), 'retirée du registre, jamais relancée deux fois');

  // -------------------------------------------------------------------------
  section('2. Rejeu de p-20261012T085659-061170 : refus du fournisseur (« Start a new session »)');
  setInfra('refusal', 1);
  x = await go(ASK);
  const fresh = x.evs.filter(e => e.subtype === 'pipeline_retry_fresh_session');
  ok(x.code === 0 && x.st?.status === 'done' && fresh.length === 1, `un refus : nouvel essai en session neuve, puis l’exécution aboutit (${x.st?.status}, ${fresh.length} essai(s) en session neuve)`, x.out.slice(-900));
  ok(noDefect(x), 'le refus n’est pas un défaut');
  setInfra('refusal', 99);
  x = await go(ASK);
  ok(x.code === 2 && x.st?.pausedLimit === 'infra' && x.st.infra?.cause === 'refusal' && stepStarts(x.evs) === 2, `deux refus (le second en session neuve) : en attente de relance (${x.st?.pausedLimit}/${x.st?.infra?.cause}, ${stepStarts(x.evs)} tours)`);
  ok(/le fournisseur du model a refusé/.test(x.result?.result || '') && /can't help with this/.test(x.result?.result || ''), 'message : la cause et l’extrait du refus', x.result?.result);
  ok(noDefect(x) && IP.dueRetries(LOGS, { now: Date.now() + 86_400_000, env: env1 }).due.every(d => d.run !== x.run), 'aucun défaut ; jamais relancée automatiquement (décision de l’utilisateur)');

  // -------------------------------------------------------------------------
  section('3. Rejeu de p-20261012T102220-3a6fde : limite de session');
  setInfra('limit', 1);
  x = await go(ASK);
  clearLimit();
  ok(x.code === 2 && x.st?.pausedLimit === 'infra' && x.st.infra?.cause === 'limit' && x.st.infra.until, `en attente de relance jusqu’à la fin de la limite (${x.st?.pausedLimit}/${x.st?.infra?.cause}, ${x.st?.infra?.until})`, x.out.slice(-900));
  ok(!/changer le model/.test(x.result?.question || x.st?.question || '') && /limite d’utilisation de Claude/.test(x.result?.result || ''), 'plus de recommandation « changer le model » : la limite est dite, la relance est automatique', x.st?.question);
  const until = Date.parse(x.st?.infra?.until || 0);
  ok(IP.dueRetries(LOGS, { now: until - 60_000, env: env1 }).due.every(d => d.run !== x.run) && IP.dueRetries(LOGS, { now: until + 120_000, env: env1 }).due.some(d => d.run === x.run),
    'relance due après l’heure de fin de la limite, pas avant');
  IP.sweepRetries({ root: T, now: until + 120_000, env: { ...baseEnv } });
  ok(await waitStatus(x.run, 'done'), `relancée à l’heure, l’exécution se termine (${runState(x.run).status})`);

  // -------------------------------------------------------------------------
  section('4. Sortie sans résultat (« sortie 1 ») après les attentes de l’exécution : en attente de relance, relance à 5 min');
  const LF = path.join(T, 'launch-fail');
  fs.writeFileSync(LF, '99');
  x = await go(ASK, { FAKE_CLAUDE_LAUNCH_FAIL_FILE: LF });
  ok(x.code === 2 && x.st?.pausedLimit === 'launch', `pause de lancement après les attentes (${x.st?.pausedLimit})`, x.out.slice(-600));
  const pe = IP.readRetries(LOGS).find(e => e.run === x.run);
  ok(pe?.cause === 'exit' && Math.abs(Date.parse(pe.retryAt) - Date.parse(pe.at) - 5 * 60_000) < 5000, `inscrite au registre, relance automatique à 5 min (${pe?.retryAt})`);
  ok(/prochain essai automatique/.test(x.result?.result || ''), 'le message annonce la relance automatique');
  ok(noDefect(x), 'aucun défaut signalé');
  fs.writeFileSync(LF, '0');
  const now4 = Date.parse(pe.at) + 6 * 60_000;
  ok(IP.sweepRetries({ root: T, now: now4, env: { ...baseEnv } }).launched.some(l => l.run === x.run), 'relancée à l’heure');
  ok(await waitStatus(x.run, 'done'), `puis terminée (${runState(x.run).status})`);

  // -------------------------------------------------------------------------
  section('5. Inchangé : un vrai critère non rempli est compté et signalé');
  setInfra('auth', 0);
  x = await go(ASK, { FAKE_PIPE_BAD: 'comprendre:99', ORCH_PIPE_CRITERIA_ATTEMPTS: '2' });
  ok(x.code === 2 && x.st?.pausedLimit === 'criteria' && x.evs.some(e => e.subtype === 'pipeline_defect') && !IP.readRetries(LOGS).some(e => e.run === x.run),
    `critère : pause « criteria », défaut signalé, pas d’attente de relance (${x.st?.pausedLimit})`);
} finally {
  srv.close();
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
