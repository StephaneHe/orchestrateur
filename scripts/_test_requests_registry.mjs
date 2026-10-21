#!/usr/bin/env node
// ============================================================================
// scripts/_test_requests_registry.mjs — requests registry and its exits
// (Routage v3, phase 1 « registre et secours »)
// ============================================================================
//
// User decisions (2026-10-19, docs/ROUTAGE-SYNTHESE.md §5): 1 « registre des
// demandes en fichiers », 8 « actions du chef par commande autorisées, et
// inscrites au registre »; phase 1 launched on 2026-10-21 (« vas y ») with:
// « chaque état non terminal a ses trois sorties, verrou, accusé, second
// lancement refusé, réconciliation après un processus tué entre retrait et
// lancement », plugged on the CURRENT chef without changing what it does.
//
// Protected (real dispatch.mjs, fake claude, private root):
//   1. a chef turn is a request (created, `en_cours`, then `terminée`); its
//      tools inherit ORCH_REQUEST_ID, a musician's turn never does;
//   2. a dispatch launched from the chef turn is a task of the request; its
//      user_prompt carries `taskId` (acknowledgement); its result is followed;
//   3. a second launch of the same --task-id is refused (log, queue);
//   4. queued task: `taskId` travels with the entry, acknowledged `en_file`;
//   5. process killed between the queue removal and the launch: `à_traiter`
//      after 2 min, never relaunched blindly; `retry` relaunches the operation;
//   6. chef turn outcomes: question → `attend_utilisateur` → answer (end to end);
//      OAuth expired → `garée` → retry (end to end); process dead → `garée`;
//   7. every non-terminal state has its three exits, each command run for real;
//   8. lock: concurrent writers lose nothing;
//   9. an answer is attached only when one request waits or its id is cited;
//  10. a request silent for 2 h is reported once;
//  11. fix --after waits for the predecessor;
//  12. removing the registry changes nothing else;
//  13. the server carries the task id through its queue; released waiters and
//      infra retries are never attached to the releasing turn's request.
//
//   node scripts/_test_requests_registry.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RQ from './requests.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Fake orchestrator server: /api/dispatch with queueIfBusy answers « queued ».
const posts = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', d => { b += d; });
  req.on('end', () => {
    let j = null; try { j = JSON.parse(b); } catch {}
    posts.push({ url: req.url, body: j });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/dispatch' && j?.queueIfBusy ? { ok: true, queued: true, id: `q-test-${posts.length}`, position: 1 } : { ok: true }));
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-requests-'));
const LOGS = path.join(T, 'logs');
for (const d of [LOGS, path.join(T, 'P'), path.join(T, 'Q'), path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, '.token'), 'a'.repeat(64));
fs.writeFileSync(path.join(LOGS, 'no-failover'), '');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude', maxParallel: 1 },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: path.join(T, 'P') }, { name: 'Q', path: path.join(T, 'Q') }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, history: [], assignments: {} }));
const ENVDUMP = path.join(T, 'env.ndjson');
const INFRA = path.join(T, 'infra.json');
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_DISABLE: '1',
  ORCH_PORT: String(srv.address().port), ORCH_NO_PENDING_RELEASE: '1', FAKE_CLAUDE_ENV_DUMP: ENVDUMP, FAKE_CLAUDE_INFRA_FILE: INFRA, FAKE_CLAUDE_INFRA_ANY: '1' };
for (const k of Object.keys(baseEnv)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|TURN_ID|REQUEST_ID)$|^DISPATCH_SLOT$|^FAKE_PIPE_|^FAKE_CLAUDE_(REPLY|PIPELINE)$/.test(k)) delete baseEnv[k];
const dispatch = (project, args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), project, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
// The fake server lives in this process: a dispatch that calls it must not block the event loop.
const dispatchAsync = (project, args, env = {}) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), project, ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; ch.stdout.on('data', d => { out += d; }); ch.stderr.on('data', d => { out += d; });
  ch.on('exit', (code) => resolve({ code, out }));
});
const cli = (args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'requests.mjs'), ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const logOf = (p) => { try { return fs.readFileSync(path.join(LOGS, `${p}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
const envDumps = () => { try { return fs.readFileSync(ENVDUMP, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const all = () => RQ.listRequests(LOGS);
const get = (id) => RQ.readRequest(LOGS, id);
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }); return Number(r.stdout.trim()); };
const spy = () => { const calls = []; const f = (root, r, t) => { calls.push({ r, t }); return { pid: 4242 }; }; f.calls = calls; return f; };
const waitFor = async (pred, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (pred()) return true; } catch {} await sleep(200); } return false; };
const H = 3600_000, MIN = 60_000;

try {
  // -------------------------------------------------------------------------
  section('0. Machine d’états : chaque état non terminal a ses sorties déclarées');
  const nonTerminal = RQ.STATES.filter(s => !RQ.TERMINAL.has(s));
  ok(nonTerminal.length === 6 && nonTerminal.every(s => RQ.EXITS[s]), `six états non terminaux, tous dans EXITS (${nonTerminal.join(', ')})`);
  for (const s of nonTerminal) {
    const e = RQ.EXITS[s];
    ok(!!e.chat && Array.isArray(e.command) && e.command.length > 0 && (!!e.button || !!e.event), `« ${s} » : chat (${e.chat.slice(0, 40)}…), commande (${e.command.join('/')}), bouton (${e.button?.label}${e.button?.phase ? `, phase ${e.button.phase}` : ''})${e.event ? `, événement (${e.event.deadline})` : ''}`);
  }
  const usage = cli(['help']).out;
  ok(['show', 'answer', 'retry', 'fix', 'cancel', 'drop', 'replay'].every(c => usage.includes(c)), 'la CLI offre show / answer / retry / fix / cancel / drop / replay');

  // -------------------------------------------------------------------------
  section('1. Un tour du chef est une demande, sans rien changer au tour');
  let x = dispatch('chef', ['Bonjour, où en est P ?']);
  let rs = all();
  const r1 = rs[0];
  const chefTurn = logOf('chef').find(e => e.type === 'user_prompt')?.orch_turn;
  ok(x.code === 0 && rs.length === 1 && r1.kind === 'message' && r1.chefMode === 'off' && r1.project === 'chef' && r1.text === 'Bonjour, où en est P ?', `demande créée (${r1?.id}, ${r1?.kind}, chefMode ${r1?.chefMode})`, x.out.slice(-600));
  ok(r1.state === 'terminée' && r1.turns.length === 1 && r1.turns[0].turn === chefTurn && r1.turns[0].end?.end === 'done', `tour suivi puis terminée (${r1.state}, tour ${r1.turns[0]?.turn})`);
  ok(r1.history.map(h => h.to).join('>') === 'reçue>en_cours>terminée', `historique reçue → en_cours → terminée (${r1.history.map(h => h.to).join(' > ')})`);
  ok(envDumps().pop()?.requestId === r1.id, 'l’outil Bash du chef hérite de ORCH_REQUEST_ID (ses dispatches seront inscrits)');
  ok(!logOf('chef').some(e => 'taskId' in e || 'requestId' in e), 'le journal du chef est inchangé (aucun champ ajouté)');

  // -------------------------------------------------------------------------
  section('2. Un dispatch lancé depuis le tour du chef est une tâche de sa demande');
  const r2 = RQ.createRequest(LOGS, { project: 'chef', text: 'Lance P sur la doc' });
  RQ.startTurn(LOGS, r2.id, { turn: 't-test-r2', pid: process.pid });
  x = dispatch('P', ['Écris la doc de P.'], { ORCH_REQUEST_ID: r2.id });
  let rr = get(r2.id);
  const up = logOf('P').filter(e => e.type === 'user_prompt').pop();
  ok(x.code === 0 && rr.tasks.length === 1 && rr.tasks[0].id === `${r2.id}#1` && rr.tasks[0].projet === 'P' && rr.tasks[0].demande === 'Écris la doc de P.', `tâche inscrite (${rr.tasks[0]?.id})`, x.out.slice(-500));
  ok(up?.taskId === `${r2.id}#1`, `accusé : le user_prompt porte taskId (${up?.taskId})`);
  ok(rr.tasks[0].state === 'en_cours' && rr.tasks[0].ack?.where === 'log' && rr.tasks[0].ack.turn === up.orch_turn, `tâche accusée en_cours (${rr.tasks[0].state}, ${rr.tasks[0].ack?.where})`);
  ok(envDumps().pop()?.requestId === null, 'le tour du musicien n’hérite pas de ORCH_REQUEST_ID');
  RQ.finishTurn(LOGS, r2.id, { turn: 't-test-r2', result: { type: 'result', is_error: false, result: 'Lancé.' } });
  ok(get(r2.id).state === 'suivie', `fin du tour du chef avec une tâche non relue : suivie (${get(r2.id).state})`);
  let rec = RQ.reconcile({ root: T, logsDir: LOGS, launch: spy() });
  rr = get(r2.id);
  ok(rr.tasks[0].state === 'réussie' && rr.state === 'terminée' && rec.changed.includes(r2.id), `réconciliation : résultat relu, tâche réussie, demande terminée (${rr.tasks[0].state}, ${rr.state})`);

  // -------------------------------------------------------------------------
  section('3. Second lancement du même identifiant refusé');
  x = dispatch('P', ['Écris la doc de P.', '--task-id', `${r2.id}#1`]);
  ok(x.code === 65 && /déjà lancée/.test(x.out) && logOf('P').filter(e => e.taskId === `${r2.id}#1` && e.type === 'user_prompt').length === 1, `refusé (code ${x.code}), une seule demande dans le journal`, x.out.slice(-400));
  const r3 = RQ.createRequest(LOGS, { project: 'chef', text: 'Deux tâches' });
  RQ.startTurn(LOGS, r3.id, { turn: 't-test-r3', pid: process.pid });
  const t3 = RQ.addTask(LOGS, r3.id, { projet: 'Q', demande: 'Vérifie Q.' });
  x = dispatch('Q', ['Vérifie Q.', '--task-id', t3.id]);
  const x2 = dispatch('Q', ['Vérifie Q.', '--task-id', t3.id]);
  ok(x.code === 0 && x2.code === 65 && logOf('Q').filter(e => e.type === 'user_prompt' && e.taskId === t3.id).length === 1, `--task-id : premier lancement accepté, second refusé (${x.code} puis ${x2.code})`, x2.out.slice(-300));
  ok(get(r3.id).tasks[0].state === 'en_cours', 'la tâche lancée par --task-id est accusée');
  RQ.finishTurn(LOGS, r3.id, { turn: 't-test-r3', result: { type: 'result', is_error: false, result: 'Lancées.' } });

  // -------------------------------------------------------------------------
  section('4. Tâche mise en file : l’identifiant voyage avec l’entrée');
  const t4 = RQ.addTask(LOGS, r3.id, { projet: 'P', demande: 'Ajoute un test à P.' });
  fs.writeFileSync(path.join(LOGS, 'P.pid'), String(process.pid));   // P is busy
  const p0 = posts.length;
  x = await dispatchAsync('P', ['Ajoute un test à P.', '--task-id', t4.id, '--queue-if-busy']);
  const post = posts.slice(p0).find(p => p.url === '/api/dispatch');
  rr = get(r3.id);
  const qt = rr.tasks.find(t => t.n === t4.n);
  ok(x.code === 0 && post?.body?.taskId === t4.id && post.body.queueIfBusy === true, `POST /api/dispatch porte taskId (${post?.body?.taskId})`, x.out.slice(-300));
  ok(qt.state === 'en_file' && qt.ack?.where === 'queue' && /^q-test-/.test(qt.ack.queueId), `accusé « en file » (${qt.state}, ${qt.ack?.queueId})`);
  fs.mkdirSync(path.join(LOGS, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(LOGS, 'queue', 'P.json'), JSON.stringify([{ id: qt.ack.queueId, prompt: 'Ajoute un test à P.', taskId: t4.id }]));
  x = dispatch('P', ['Ajoute un test à P.', '--task-id', t4.id]);
  ok(x.code === 65 && /en file/.test(x.out), `déjà en file : second lancement refusé (${x.code})`, x.out.slice(-300));
  fs.rmSync(path.join(LOGS, 'P.pid'), { force: true });

  // -------------------------------------------------------------------------
  section('5. Processus tué entre le retrait de la file et le lancement');
  fs.rmSync(path.join(LOGS, 'queue', 'P.json'), { force: true });   // drained: removed from the queue…
  // …and the dispatch it spawned died before writing anything.
  const now5 = Date.now();
  let sp = spy();
  RQ.reconcile({ root: T, logsDir: LOGS, now: now5 + MIN, launch: sp });
  ok(get(r3.id).tasks.find(t => t.n === t4.n).state === 'en_file', 'à 1 min : encore « en file » (pas de conclusion hâtive)');
  rec = RQ.reconcile({ root: T, logsDir: LOGS, now: now5 + 3 * MIN, launch: sp });
  let t5 = get(r3.id).tasks.find(t => t.n === t4.n);
  ok(t5.state === 'à_traiter' && t5.error?.code === 'sans-accusé' && /retirée de la file/.test(t5.error.why), `à 3 min : à traiter, sans accusé (${t5.state}, ${t5.error?.why})`);
  ok(sp.calls.length === 0 && rec.launched.length === 0, 'jamais relancée à l’aveugle par la réconciliation');
  ok(t5.actions?.some(a => a.includes(`retry ${r3.id}#${t4.n}`)) && get(r3.id).state === 'à_traiter', `sortie proposée : « retry » ; demande à traiter (${get(r3.id).state})`);
  sp = spy();
  let c = RQ.cmdRetry({ root: T, logsDir: LOGS, id: `${r3.id}#${t4.n}`, launchTask: sp });
  t5 = get(r3.id).tasks.find(t => t.n === t4.n);
  ok(c.ok && sp.calls.length === 1 && t5.attempt === 2 && t5.state === 'lancée' && RQ.taskIdOf(r3.id, t5.n, t5.attempt) === `${r3.id}#${t4.n}.2`, `retry : l’opération existante est relancée, essai n° 2 (${c.text})`);
  // The same, with the task's user_prompt written before the kill: acknowledged by the log.
  const t5b = RQ.addTask(LOGS, r3.id, { projet: 'Q', demande: 'Relis Q.' });
  fs.appendFileSync(path.join(LOGS, 'Q.jsonl'), JSON.stringify({ orch_turn: 't-killed', type: 'user_prompt', text: 'Relis Q.', taskId: t5b.id }) + '\n');
  RQ.reconcile({ root: T, logsDir: LOGS, now: Date.now() + 3 * MIN, launch: spy() });
  ok(get(r3.id).tasks.find(t => t.n === t5b.n).state === 'en_cours', 'demande déjà écrite avant la mort : accusée par le journal, pas « à traiter »');
  // Refused right after registration (dispatch exits before writing): « à traiter » at once.
  x = dispatch('Q', ['Tâche impossible.', '--lane', '3'], { ORCH_REQUEST_ID: r3.id });
  const t5c = get(r3.id).tasks.pop();
  ok(x.code === 64 && t5c.state === 'à_traiter' && t5c.error?.code === 'lancement', `lancement refusé après inscription : à traiter aussitôt (${t5c.state}, ${t5c.error?.why})`, x.out.slice(-300));

  // -------------------------------------------------------------------------
  section('6. Issues du tour du chef, de bout en bout');
  x = dispatch('chef', ['Quel projet en premier ?'], { FAKE_CLAUDE_REPLY: 'Deux options.\n\nNEEDS_USER_INPUT: P ou Q d’abord ?' });
  const r6 = all().find(r => r.text === 'Quel projet en premier ?');
  ok(r6?.state === 'attend_utilisateur' && /P ou Q/.test(r6.question?.text || ''), `question : attend_utilisateur (${r6?.state}, « ${r6?.question?.text} »)`, x.out.slice(-300));
  c = cli(['answer', r6.id, 'P d’abord']);
  ok(c.code === 0 && get(r6.id).state === 'reçue' && get(r6.id).answers[0]?.text === 'P d’abord', `answer : réponse gardée, tour du chef relancé (${c.out.trim()})`);
  ok(await waitFor(() => get(r6.id).state === 'terminée' && get(r6.id).turns.length === 2), `le tour relancé continue la MÊME demande puis la termine (${get(r6.id).state}, ${get(r6.id).turns.length} tours)`);
  ok(all().filter(r => r.text === 'Quel projet en premier ?' || r.text === 'P d’abord').length === 1 && logOf('chef').some(e => e.type === 'user_prompt' && e.text === 'P d’abord'), 'aucune demande en double ; le chef reçoit la réponse telle quelle');
  // OAuth expired
  fs.writeFileSync(INFRA, JSON.stringify({ cause: 'auth', left: 1 }));
  x = dispatch('chef', ['Fais le point sur Q.']);
  const r6b = all().find(r => r.text === 'Fais le point sur Q.');
  ok(r6b?.state === 'garée' && r6b.parked?.cause === 'auth', `connexion expirée : garée, cause auth (${r6b?.state}, ${r6b?.parked?.cause})`, x.out.slice(-400));
  c = cli(['retry', r6b.id]);
  ok(c.code === 0 && await waitFor(() => get(r6b.id).state === 'terminée' && get(r6b.id).turns.length === 2), `retry : relancée et terminée (${get(r6b.id).state})`, c.out);
  // Turn process dead without a result
  const r6c = RQ.createRequest(LOGS, { project: 'chef', text: 'Tour tué' });
  RQ.startTurn(LOGS, r6c.id, { turn: 't-dead', pid: deadPid(), log: path.join(LOGS, 'chef.jsonl'), offset: fs.statSync(path.join(LOGS, 'chef.jsonl')).size });
  RQ.reconcile({ root: T, logsDir: LOGS, launch: spy() });
  ok(get(r6c.id).state === 'garée' && get(r6c.id).parked?.cause === 'exit', `processus mort sans résultat : garée par le balayage (${get(r6c.id).state}, ${get(r6c.id).parked?.detail})`);
  // Relaunched turn that never starts
  const r6d = RQ.createRequest(LOGS, { project: 'chef', text: 'Relance perdue' });
  RQ.startTurn(LOGS, r6d.id, { turn: 't-x', pid: deadPid() });
  RQ.finishTurn(LOGS, r6d.id, { turn: 't-x', result: null, code: 1 });
  RQ.cmdRetry({ root: T, logsDir: LOGS, id: r6d.id, launchChef: () => ({ pid: null }) });
  RQ.reconcile({ root: T, logsDir: LOGS, now: Date.now() + 3 * MIN, launch: spy() });
  ok(get(r6d.id).state === 'garée' && /n’a pas démarré/.test(get(r6d.id).parked?.detail || ''), `tour relancé jamais démarré : de nouveau garée (${get(r6d.id).parked?.detail})`);

  // -------------------------------------------------------------------------
  section('7. Chaque état non terminal : ses commandes, exécutées');
  const mk = (text) => RQ.createRequest(LOGS, { project: 'chef', text });
  // reçue
  let r = mk('reçue');
  ok(r.state === 'reçue' && cli(['drop', r.id]).code === 0 && get(r.id).state === 'abandonnée', 'reçue → drop → abandonnée');
  // en_cours
  r = mk('en cours'); RQ.startTurn(LOGS, r.id, { turn: 't-live', pid: process.pid });
  c = cli(['show', r.id]);
  ok(c.code === 0 && JSON.parse(c.out).exits?.command?.includes('show'), 'en_cours → show (avec ses sorties)');
  ok(cli(['drop', r.id]).code === 3 && get(r.id).state === 'en_cours', 'en_cours → drop refusé tant que le tour vit (rien d’abandonné à l’aveugle)');
  // attend_utilisateur → close
  r = mk('question'); RQ.startTurn(LOGS, r.id, { turn: 't-q', pid: process.pid });
  RQ.finishTurn(LOGS, r.id, { turn: 't-q', result: { type: 'result', is_error: false, result: 'NEEDS_USER_INPUT: oui ?' } });
  c = cli(['close', r.id, '--note', 'réglé à la main']);
  ok(c.code === 0 && get(r.id).state === 'terminée' && get(r.id).question.closed?.note === 'réglé à la main', `attend_utilisateur → close → terminée (${get(r.id).state})`);
  ok(cli(['answer', r.id, 'trop tard']).code === 2, 'answer sur une demande qui n’attend plus rien : refusé (2)');
  // garée → drop
  r = mk('garée'); RQ.startTurn(LOGS, r.id, { turn: 't-g', pid: process.pid });
  RQ.finishTurn(LOGS, r.id, { turn: 't-g', result: { type: 'result', is_error: true, result: 'boom' }, code: 1 });
  ok(get(r.id).state === 'garée' && cli(['drop', r.id]).code === 0 && get(r.id).state === 'abandonnée', 'garée → drop → abandonnée');
  // à_traiter → fix, cancel
  r = mk('à traiter'); RQ.startTurn(LOGS, r.id, { turn: 't-a', pid: process.pid });
  const ta = RQ.addTask(LOGS, r.id, { projet: 'P', demande: 'A' });
  const tb = RQ.addTask(LOGS, r.id, { projet: 'Q', demande: 'B' });
  RQ.finishTurn(LOGS, r.id, { turn: 't-a', result: { type: 'result', is_error: false, result: 'ok' } });
  RQ.failTask(LOGS, ta.id, { code: 'échec', why: 'test rouge' });
  RQ.failTask(LOGS, tb.id, { code: 'échec', why: 'inutile' });
  ok(get(r.id).state === 'à_traiter', 'tâches en échec : demande à traiter');
  sp = spy();
  c = RQ.cmdFix({ root: T, logsDir: LOGS, id: ta.id, pipeline: 'discussion', projects: ['P', 'Q'], launch: sp });
  ok(c.ok && sp.calls[0]?.t.launch.pipeline === 'discussion' && sp.calls[0].t.attempt === 2, `à_traiter → fix --pipeline discussion : relancée corrigée (${c.text})`);
  ok(RQ.cmdFix({ root: T, logsDir: LOGS, id: tb.id, projet: 'Inconnu', projects: ['P', 'Q'], launch: sp }).code === 64, 'fix vers un projet hors de config.json : refusé');
  c = cli(['cancel', tb.id]);
  ok(c.code === 0 && get(r.id).tasks.find(t => t.n === tb.n).state === 'annulée', `à_traiter → cancel → annulée (${c.out.trim()})`);
  // suivie
  ok(get(r.id).state === 'suivie', `une tâche relancée, l’autre annulée : suivie (${get(r.id).state})`);
  RQ.ackTask(LOGS, RQ.taskIdOf(r.id, ta.n, 2), { where: 'log', log: path.join(LOGS, 'P.jsonl'), offset: 0, hash: 'x', turn: 't-z', pid: process.pid });
  ok(cli(['cancel', ta.id]).code === 3, 'suivie : annuler une tâche en cours est refusé (3), avec la marche à suivre');
  ok(cli(['replay', r.id]).code === 2, 'replay d’une demande non terminée : refusé (2)');
  // terminée → replay
  c = RQ.cmdReplay({ root: T, logsDir: LOGS, id: r1.id, launch: () => ({ pid: 7 }) });
  ok(c.ok, `terminée → replay : nouvelle demande, même texte (${c.text})`);

  // -------------------------------------------------------------------------
  section('8. Verrou : écrivains concurrents, rien de perdu');
  const r8 = mk('concurrence');
  const writer = `import * as RQ from ${JSON.stringify(path.join(ROOT, 'scripts', 'requests.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'))};\nfor (let i = 0; i < 8; i++) RQ.addTask(${JSON.stringify(LOGS)}, ${JSON.stringify(r8.id)}, { projet: 'P', demande: 'w' + process.argv[2] + '-' + i });`;
  const wf = path.join(T, 'writer.mjs'); fs.writeFileSync(wf, writer);
  await Promise.all(Array.from({ length: 6 }, (_, k) => new Promise(res => { const ch = spawn(process.execPath, [wf, String(k)], { stdio: 'ignore' }); ch.on('exit', res); })));
  const ts = get(r8.id).tasks;
  ok(ts.length === 48 && new Set(ts.map(t => t.n)).size === 48 && new Set(ts.map(t => t.demande)).size === 48, `6 processus × 8 tâches : ${ts.length} tâches, numéros uniques`);
  ok(!fs.existsSync(`${RQ.fileOf(LOGS, r8.id)}.lock`) && !fs.existsSync(`${RQ.fileOf(LOGS, r8.id)}.tmp`), 'aucun verrou ni fichier temporaire restant');

  // -------------------------------------------------------------------------
  section('9. Rattachement d’une réponse : jamais deviné');
  for (const rq of all()) if (rq.state === 'attend_utilisateur') RQ.cmdClose({ logsDir: LOGS, id: rq.id });
  ok(RQ.attachAnswer(LOGS, 'oui').none === true, 'aucune demande en attente : rien');
  const qa = mk('qa'); RQ.startTurn(LOGS, qa.id, { turn: 't-qa', pid: process.pid }); RQ.finishTurn(LOGS, qa.id, { turn: 't-qa', result: { is_error: false, result: 'NEEDS_USER_INPUT: A ?' } });
  ok(RQ.attachAnswer(LOGS, 'oui').id === qa.id, 'une seule en attente : rattachée');
  const qb = mk('qb'); RQ.startTurn(LOGS, qb.id, { turn: 't-qb', pid: process.pid }); RQ.finishTurn(LOGS, qb.id, { turn: 't-qb', result: { is_error: false, result: 'NEEDS_USER_INPUT: B ?' } });
  const amb = RQ.attachAnswer(LOGS, 'oui');
  ok(amb.ambiguous?.length === 2 && !amb.id, 'deux en attente, aucune citée : ambigu (le chef demande laquelle)');
  ok(RQ.attachAnswer(LOGS, `pour ${qb.id} : oui`).id === qb.id, 'deux en attente, une citée : celle-là');

  // -------------------------------------------------------------------------
  section('10. Demande silencieuse depuis 2 h : signalée une fois');
  rec = RQ.reconcile({ root: T, logsDir: LOGS, now: Date.now() + 3 * H, launch: spy() });
  ok(rec.stale.includes(qa.id) && rec.stale.includes(qb.id), `signalées (${rec.stale.length})`);
  ok(RQ.reconcile({ root: T, logsDir: LOGS, now: Date.now() + 4 * H, launch: spy() }).stale.length === 0, 'pas deux fois');

  // -------------------------------------------------------------------------
  section('11. fix --after : la tâche attend sa devancière');
  const r11 = mk('dépendances'); RQ.startTurn(LOGS, r11.id, { turn: 't-11', pid: process.pid });
  const a11 = RQ.addTask(LOGS, r11.id, { projet: 'P', demande: 'A' });
  const b11 = RQ.addTask(LOGS, r11.id, { projet: 'Q', demande: 'B' });
  RQ.finishTurn(LOGS, r11.id, { turn: 't-11', result: { is_error: false, result: 'ok' } });
  RQ.failTask(LOGS, b11.id, { why: 'ordre' });
  sp = spy();
  c = RQ.cmdFix({ root: T, logsDir: LOGS, id: b11.id, after: a11.id, launch: sp });
  ok(c.ok && sp.calls.length === 0 && get(r11.id).tasks[1].state === 'en_attente_de', `en attente de ${a11.id} (${c.text})`);
  RQ.reconcile({ root: T, logsDir: LOGS, launch: sp });
  ok(sp.calls.length === 0, 'devancière non finie : rien ne part');
  RQ.updateRequest(LOGS, r11.id, (x) => { x.tasks[0].state = 'réussie'; });
  rec = RQ.reconcile({ root: T, logsDir: LOGS, launch: sp });
  ok(sp.calls.length === 1 && sp.calls[0].t.n === b11.n && rec.launched.length === 1, 'devancière réussie : la tâche part, une fois');
  ok(RQ.reconcile({ root: T, logsDir: LOGS, launch: sp }) && sp.calls.length === 1, 'jamais deux fois');

  // -------------------------------------------------------------------------
  section('12. Retirer le registre ne change rien d’autre');
  fs.rmSync(path.join(LOGS, 'requests'), { recursive: true, force: true });
  const n12 = logOf('P').length;
  x = dispatch('P', ['Tour sans registre.'], { ORCH_REQUEST_ID: 'r-20261021T000000-abcdef' });
  ok(x.code === 0 && logOf('P').slice(n12).some(e => e.type === 'result') && !logOf('P').slice(n12).some(e => 'taskId' in e), 'demande inconnue dans l’environnement : tour normal, rien d’inscrit');
  x = dispatch('P', ['Tour avec un identifiant inconnu.', '--task-id', 'r-20261021T000000-abcdef#1']);
  ok(x.code === 0 && /inconnue du registre/.test(x.out), '--task-id inconnu : le tour part quand même (avertissement)', x.out.slice(-300));
  x = dispatch('chef', ['Un message après la suppression.']);
  ok(x.code === 0 && all().length === 1 && all()[0].state === 'terminée', 'le chef recrée simplement une demande');

  // -------------------------------------------------------------------------
  section('13. Serveur et lanceurs (statique)');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/args\.push\('--task-id', opts\.taskId\)/.test(server) && /taskId: typeof req\.body\?\.taskId === 'string'/.test(server) && /lane, ressources, taskId, noQueueIfBusy: true/.test(server), 'le serveur garde taskId dans la file et le repasse au lancement (--task-id)');
  ok(/rq\.reconcile\(\{ root: __dirname, logsDir: LOGS_DIR \}\)/.test(server) && /setInterval\(sweepRequests/.test(server), 'réconciliation dans le balayage de 60 s');
  const rp = fs.readFileSync(path.join(ROOT, 'scripts', 'routage-pending.mjs'), 'utf8');
  const ir = fs.readFileSync(path.join(ROOT, 'scripts', 'infra-retry.mjs'), 'utf8');
  ok(/if \(released\) delete env\.ORCH_REQUEST_ID/.test(rp) && /\{ released: true \}/.test(rp) && /'ORCH_REQUEST_ID'\]\) delete env\[k\]/.test(ir), 'une tâche libérée ou une relance d’infra n’est jamais rattachée à la demande du tour qui la lance');
} catch (e) {
  fail++; console.log(`  ✗ exception : ${e.stack}`);
} finally {
  srv.close();
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
