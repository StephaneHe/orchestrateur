#!/usr/bin/env node
// ============================================================================
// scripts/_test_routage_new_session.mjs — the Routage passes --new-session to
// dispatch.mjs for a task that asks for a fresh session (0.95.0)
// ============================================================================
//
// Incident (2026-10-14): the user asked to relaunch a full test at a musician
// in a FRESH session. The Routage only copied « --new-session » into the text
// of the task: the queue entry did not carry « SESSION NEUVE » and the
// musician's session file was not archived — the turn would have resumed a
// session already too long. User, verbatim: « demande à orchestrateur-dev de
// faire passer --new-session par le Routage. »
//
// Protected:
//   1. the Decomposer accepts « session_neuve »: true, documented in its
//      instructions; anything but a boolean, or with « reprise » or
//      « renvoi_chef », is refused;
//   2. end to end on a real chef Routage turn:
//      - a free musician's task with session_neuve runs WITHOUT resuming: its
//        session file is archived, its user_prompt says newSession;
//      - a busy musician's task with session_neuve goes to the queue WITH
//        newSession (the entry shown « SESSION NEUVE »);
//      - a task without the field resumes its session, nothing archived;
//      - dispatch.json and the Affecter table say « session neuve »;
//   3. launchTask: --new-session also for an off-pipeline task and for a
//      waiting task released later; never without the field.
//   (--new-session ignored with codex: scripts/_test_explicit_model.mjs.)
//
//   node scripts/_test_routage_new_session.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RP from './routage-pending.mjs';
import * as E from './pipeline-engine.mjs';
import { catalogSteps } from './pipeline-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-newsess-'));
const LOGS = path.join(T, 'logs');
for (const d of ['logs', 'chef', 'Q', 'R', 'S']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n\nContrat du chef (doublure).\n');
fs.writeFileSync(path.join(T, '.token'), 'a'.repeat(64));
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  // maxParallel: 1 — R's busy musician goes through the 0.67.0 queue path; the default is 2 since 0.103.0.
  projects: ['chef', 'Q', 'R', 'S'].map(n => ({ name: n, path: path.join(T, n), ...(n === 'R' ? { maxParallel: 1 } : {}) })),
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, history: [],
  enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])),
}, null, 2));

// A stand-in for the server: records what a busy musician's dispatch queues.
const posted = [];
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', d => { b += d; });
  req.on('end', () => {
    if (req.url.startsWith('/api/dispatch')) { try { posted.push(JSON.parse(b)); } catch { /* ignore */ } }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queued: true, position: 1, id: 'q-test' }));
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

// R is busy: its .pid names a live process this test started.
const busy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
fs.writeFileSync(path.join(LOGS, 'R.pid'), String(busy.pid));
for (const n of ['Q', 'R', 'S']) fs.writeFileSync(path.join(LOGS, `${n}.session`), `old-${n}`);

const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1',
  FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: String(PORT), ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL', 'CODEX_HOME', 'FAKE_CLAUDE_CLASSIFY', 'FAKE_CLAUDE_CLASSIFY_MAP']) delete baseEnv[k];
const logOf = (n) => { try { return fs.readFileSync(path.join(LOGS, `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const backups = (n) => fs.readdirSync(LOGS).filter(f => f.startsWith(`${n}.session.bak-`));

// ---------------------------------------------------------------------------
section('1. Découper : « session_neuve » accepté, validé et documenté');
{
  const t = (extra) => [{ projet: 'Q', titre: 'test complet', demande: 'Relancer le test complet.', ...extra }];
  ok(E.validateUnitTasks(T, t({ session_neuve: true })) === null, 'session_neuve: true accepté');
  ok(E.validateUnitTasks(T, t({ session_neuve: false })) === null, 'session_neuve: false accepté (sans effet)');
  ok(/« session_neuve » doit valoir true/.test(E.validateUnitTasks(T, t({ session_neuve: 'oui' })) || ''), 'une valeur qui n’est pas un booléen est refusée');
  ok(/« session_neuve » et « reprise » s’excluent/.test(E.validateUnitTasks(T, t({ session_neuve: true, reprise: 'p-20261014T120000-abcdef' })) || ''), 'avec « reprise » : refusé');
  ok(/« renvoi_chef » et « session_neuve » s’excluent/.test(E.validateUnitTasks(T, t({ session_neuve: true, renvoi_chef: { raison: 'le chef agit lui-même' } })) || ''), 'avec « renvoi_chef » : refusé');
  const dec = catalogSteps('routage').find(s => s.id === 'decomposer');
  ok(/SESSION NEUVE/.test(dec.role) && /« session_neuve »: true/.test(dec.role) && /N’écris jamais « --new-session » dans le texte/.test(dec.role) && /trop longue/.test(dec.role),
    'consigne de Découper : quand l’utiliser (demande explicite, session trop longue), jamais dans le texte');
  ok(/"session_neuve"/.test(dec.jsonExample), 'exemple JSON de Découper : champ session_neuve');
}

// ---------------------------------------------------------------------------
section('2. Bout en bout : un vrai tour du chef en Routage');
const n0 = logOf('chef').length;
const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', 'Relance les tests en session neuve sur Q et R, et le test rapide sur S', '--test', 'routage-new-session'], {
  env: { ...baseEnv,
    FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'taches', sens: 'trois relances', raison: 'x' },
      decomposer: { taches: [
        { projet: 'Q', titre: 'Q : test complet', demande: 'Q — relancer le test complet.', session_neuve: true },
        { projet: 'R', titre: 'R : test complet', demande: 'R — relancer le test complet.', session_neuve: true },
        { projet: 'S', titre: 'S : test rapide', demande: 'S — relancer le test rapide.' },
      ] } }),
    FAKE_CLAUDE_CLASSIFY_MAP: JSON.stringify({ 'relancer le test': { pipeline: 'dev', mode: 'leger', nature: 'comportement', raison: 'r' } }),
  }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
const evs = logOf('chef').slice(n0);
const run = evs.find(e => e.type === 'user_prompt')?.pipeline?.run;
const art = run ? path.join(T, 'chef', '.orchestrateur', 'runs', run) : null;
const st = run ? JSON.parse(fs.readFileSync(path.join(LOGS, 'runs', run, 'run.json'), 'utf8')) : null;
const status = (st?.steps || []).map(s => `${s.id}:${s.status}`).join(' ');
ok(r.status === 0 && /dispatcher:ok/.test(status), `exécution du Routage : ${status}`, `${r.stdout}${r.stderr}`.slice(-900));

// Detached task turns: wait for Q and S to finish, and R's queue post.
const done = (n) => logOf(n).some(e => e.type === 'result');
for (let i = 0; i < 120 && !(done('Q') && done('S') && posted.length); i++) await sleep(250);

const qUp = logOf('Q').find(e => e.type === 'user_prompt');
ok(qUp?.newSession === true, 'tâche avec session_neuve, musicien libre : le tour part en session neuve (user_prompt.newSession)', JSON.stringify(qUp));
ok(backups('Q').length === 1 && fs.readFileSync(path.join(LOGS, backups('Q')[0]), 'utf8') === 'old-Q', '… et l’ancienne session est archivée, intacte');
ok(!/--new-session/.test(qUp?.text || ''), 'la demande reçue par le musicien ne contient pas « --new-session » en texte');

const rq = posted.find(p => p.project === 'R');
ok(rq && rq.newSession === true && rq.queueIfBusy === true, 'tâche avec session_neuve, musicien occupé : l’entrée de file porte newSession (« SESSION NEUVE »)', JSON.stringify(posted));
ok(backups('R').length === 0 && fs.readFileSync(path.join(LOGS, 'R.session'), 'utf8') === 'old-R', '… sans rien archiver avant son lancement réel');

const sUp = logOf('S').find(e => e.type === 'user_prompt');
// 0.99.0 (contexte calibré, t-182fa2): a task without the field never gets
// --new-session; being a new task from the chef, dispatch.mjs's context policy
// starts it fresh by itself (the old session archived, intact). The same task
// (« meme_tache ») resumes it: _test_context_calibration.mjs.
ok(sUp && !sUp.newSession && sUp.context?.resume === false && /nouvelle tâche/.test(sUp.context.reason || '')
  && backups('S').length === 1 && fs.readFileSync(path.join(LOGS, backups('S')[0]), 'utf8') === 'old-S',
  'tâche sans le champ : jamais --new-session ; nouvelle tâche ⇒ session neuve décidée par la politique de contexte, ancienne archivée intacte', JSON.stringify(sUp));

const disp = art ? JSON.parse(fs.readFileSync(path.join(art, 'dispatch.json'), 'utf8')) : null;
const dq = disp?.dispatched?.find(d => d.projet === 'Q'), ds = disp?.dispatched?.find(d => d.projet === 'S');
ok(dq?.sessionNeuve === true && !ds?.sessionNeuve, 'dispatch.json : sessionNeuve sur la tâche concernée seulement');
const aff = art ? fs.readFileSync(path.join(art, 'affectation.md'), 'utf8') : '';
ok(/\| Q \|[^\n]*— session neuve/.test(aff) && !/\| S \|[^\n]*session neuve/.test(aff), 'tableau Affecter : « session neuve » sur sa ligne', aff);

// ---------------------------------------------------------------------------
section('3. launchTask : hors pipeline, tâche en attente libérée plus tard');
const REC = path.join(T, 'recorder.mjs');
const RECF = path.join(T, 'launches.ndjson');
fs.writeFileSync(REC, "import fs from 'node:fs';\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{fs.appendFileSync(process.env.REC_FILE, JSON.stringify({argv:process.argv.slice(2),stdin:s})+'\\n');});\n");
process.env.REC_FILE = RECF;
const launches = async (n) => { for (let i = 0; i < 60; i++) { try { const l = fs.readFileSync(RECF, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); if (l.length >= n) return l; } catch {} await sleep(100); } return []; };
{
  RP.launchTask(T, { projet: 'Q', titre: 'hors pipeline', horsPipeline: 'autorisé', sessionNeuve: true, demande: 'Hors pipeline neuve' }, REC);
  RP.launchTask(T, { projet: 'S', titre: 'ordinaire', demande: 'Sans session neuve' }, REC);
  const l = await launches(2);
  const hp = l.find(x => x.stdin === 'Hors pipeline neuve'), plain = l.find(x => x.stdin === 'Sans session neuve');
  ok(hp && hp.argv.includes('--hors-pipeline') && hp.argv.includes('--new-session') && hp.argv.includes('--queue-if-busy'), `hors pipeline tracé : --new-session passé (${hp?.argv.slice(1).join(' ')})`);
  ok(plain && !plain.argv.includes('--new-session'), 'sans le champ : jamais --new-session');
  fs.rmSync(RECF, { force: true });
  RP.addPending(LOGS, [{ run: 'rX', n: 2, projet: 'Q', titre: 'après S', demande: 'En attente, session neuve', sessionNeuve: true, after: { projet: 'S', offset: 0 } }]);
  const rel = RP.releaseReady({ root: T, logsDir: LOGS, dispatchScript: REC });
  const l2 = await launches(1);
  ok(rel.launched.length === 1 && l2[0]?.argv.includes('--new-session'), 'tâche en attente libérée plus tard : --new-session gardé', JSON.stringify(l2));
}

try { busy.kill(); } catch { /* ignore */ }
srv.close();
await sleep(300);
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
