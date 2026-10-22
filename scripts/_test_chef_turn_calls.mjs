#!/usr/bin/env node
// ============================================================================
// scripts/_test_chef_turn_calls.mjs — the chef's single turn (Routage v3,
// phase 2): number of calls per path, compact context, shadow mode
// ============================================================================
//
// User decision of 2026-10-22 (« vas y »): « chef-turn.mjs : contexte compact,
// un appel, extraction du plan, un seul nouvel essai » and « MODE OMBRE : plan
// produit sur les vrais messages de l'utilisateur […], SANS aucun effet (aucun
// dispatch, aucune écriture hors de son journal d'ombre). chefMode reste off ».
// docs/ROUTAGE-SYNTHESE.md §3.10 `_test_chef_turn_calls.mjs`: réponse 1,
// tâches 1 + 1 vague (classement en parallèle), chemin direct 0; decision 2
// (claude-sonnet-5-5, case routage.chef); §3.7 infrastructure failures.
//
// Real chef-turn.mjs, real CLI calls to the fake claude, real dispatch.mjs for
// the shadow, private root.
//
//   node scripts/_test_chef_turn_calls.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as CT from './chef-turn.mjs';
import * as RQ from './requests.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chefturn-'));
const LOGS = path.join(T, 'logs');
for (const d of [LOGS, path.join(T, 'P'), path.join(T, 'Q'), path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, '.token'), 'a'.repeat(64));
fs.writeFileSync(path.join(LOGS, 'no-failover'), '');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude', maxParallel: 1 },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: path.join(T, 'P') }, { name: 'Q', path: path.join(T, 'Q') }],
}));
const routing = (extra = {}) => fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, history: [], assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...extra } }));
routing();
const CALLS = path.join(T, 'chef-calls.ndjson');
const CLS = path.join(T, 'classify.ndjson');
const DUMP = path.join(T, 'prompts.ndjson');
const SEQ = path.join(T, 'answers.json');
const INFRA = path.join(T, 'infra.json');
const LFAIL = path.join(T, 'launch-fail');
const clean = { ...process.env };
for (const k of Object.keys(clean)) if (/^(ANTHROPIC|OPENAI|OPENROUTER|NVIDIA)_API_KEY$|^ORCH_(TURN_PROJECT|TURN_STEP|STEP_TOKEN|OBS_ID|TEST_LABEL|TURN_ID|REQUEST_ID)$|^DISPATCH_SLOT$|^FAKE_/.test(k)) delete clean[k];
const env = (extra = {}) => ({ ...clean, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', ORCH_PERM_DISABLE: '1',
  ORCH_NO_PENDING_RELEASE: '1', FAKE_CLAUDE_CHEF_V3_LOG: CALLS, FAKE_CLAUDE_CLASSIFY_LOG: CLS, FAKE_CLAUDE_DUMP_PROMPT: DUMP, ...extra });
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const reset = () => { for (const f of [CALLS, CLS, DUMP, SEQ, INFRA, LFAIL]) fs.rmSync(f, { force: true }); };
const plan = (o) => `Réponse du chef.\n\n\`\`\`plan\n${JSON.stringify(o)}\n\`\`\``;
const turn = (message, extra = {}, o = {}) => CT.runChefTurn({ root: T, logsDir: LOGS, message, env: env(extra), delays: [0, 0], ...o });
const snapshot = (dir) => {
  const out = new Map();
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.set(path.relative(T, p), fs.statSync(p).size); } };
  walk(dir); return out;
};

try {
  section('1. Réponse seule : UN appel, aucun classement');
  reset();
  let r = await turn('Où en est le projet P ?', { FAKE_CLAUDE_CHEF_V3: plan({}) });
  ok(r.path === 'model' && r.calls === 1 && lines(CALLS).length === 1 && lines(CLS).length === 0, `1 appel du chef, 0 classement (${r.calls}, ${lines(CLS).length})`);
  ok(r.prose === 'Réponse du chef.' && r.repaired.items.length === 0 && /Aucune tâche/.test(r.facts), 'prose rendue, plan vide, bloc de faits « aucune tâche »');
  ok(lines(DUMP).some(d => d.model === 'claude-sonnet-5-5' && /^\[CHEF_V3\]/.test(d.prompt)), 'model : claude-sonnet-5-5 (décision 2, case routage.chef vide)');
  ok(r.model.source === 'décision 2', 'source du model dite : « décision 2 »');

  section('2. Tâches : 1 appel du chef + 1 vague de classements EN PARALLÈLE');
  reset();
  r = await turn('Corrige le bug de P, ajoute un test à Q, puis documente P.', { FAKE_CLAUDE_CHEF_V3: plan({ taches: [
    { ref: 'a', projet: 'P', titre: 'corriger le bug', demande: 'Corrige le bug de connexion de P.' },
    { ref: 'b', projet: 'Q', titre: 'ajouter un test', demande: 'Ajoute un test de non-régression à Q.' },
    { ref: 'c', projet: 'P', titre: 'documenter', demande: 'Documente la correction dans le README de P.', apres: ['a'] },
    { ref: 'd', projet: 'Q', titre: 'discussion imposée', demande: 'Explique le module X de Q.', pipeline: 'discussion' }] }), FAKE_CLAUDE_LATENCY_MS: '400' });
  const cls = lines(CLS);
  ok(r.calls === 1 && lines(CALLS).length === 1, 'un seul appel du chef');
  ok(cls.length === 3 && r.classification.tasks === 4, `3 classements par le model (la tâche au pipeline imposé n’en demande pas) : ${cls.length}`);
  const sum = r.repaired.items.reduce((s, i) => s + (i.classifiedMs || 0), 0);
  ok(r.classification.ms < sum * 0.75, `classements en parallèle : ${r.classification.ms} ms au total, ${sum} ms cumulés`);
  const m = new Map(r.repaired.items.map(i => [i.ref, i]));
  ok(m.get('a').state === 'prête' && m.get('c').state === 'en_attente_de' && m.get('d').pipeline === 'discussion' && m.get('a').pipeline, 'états et pipelines relevés ; « puis » gardé');
  ok(/Serait lancé : a P/.test(r.facts) && /Attendrait a : c P/.test(r.facts), 'bloc de faits écrit par le code (« Serait lancé », « Attendrait »)', r.facts);

  section('3. Un seul nouvel essai : plan absent, puis plan illisible deux fois');
  reset();
  fs.writeFileSync(SEQ, JSON.stringify(['Réponse sans bloc.', plan({ taches: [{ ref: 'a', projet: 'P', titre: 'tâche unique', demande: 'Fais X dans P.' }] })]));
  r = await turn('Fais X dans P.', { FAKE_CLAUDE_CHEF_V3_FILE: SEQ });
  ok(r.calls === 2 && lines(CALLS)[1]?.retry === true && r.repaired.items[0].state === 'prête', 'bloc absent → un nouvel essai, qui réussit');
  reset();
  fs.writeFileSync(SEQ, JSON.stringify(['Pas de bloc.', 'Toujours pas de bloc.', plan({})]));
  r = await turn('Fais Y dans P.', { FAKE_CLAUDE_CHEF_V3_FILE: SEQ });
  ok(r.calls === 2 && r.unreadable && /Aucune tâche lancée/.test(r.facts) && /à traiter/.test(r.facts), 'deux fois illisible : prose livrée, « aucune tâche lancée », jamais un troisième appel');
  reset();
  fs.writeFileSync(SEQ, JSON.stringify([plan({ taches: [{ ref: 'a', projet: 'P', titre: 'A', demande: 'Fais A.', apres: ['zz'] }, { ref: 'b', projet: 'Q', titre: 'B indépendante', demande: 'Fais B.' }] }),
    plan({ taches: [{ ref: 'a', projet: 'P', titre: 'A', demande: 'Fais A.', apres: ['zz'] }, { ref: 'b', projet: 'Q', titre: 'B indépendante', demande: 'Fais B.' }] })]));
  r = await turn('Fais A puis B.', { FAKE_CLAUDE_CHEF_V3_FILE: SEQ });
  const mm = new Map(r.repaired.items.map(i => [i.ref, i]));
  ok(r.calls === 2 && /« zz »/.test(lines(DUMP).filter(d => /CORRECTION DU PLAN/.test(d.prompt))[0]?.prompt || ''), 'dépendance inconnue → nouvel essai CIBLÉ sur ce champ');
  ok(mm.get('a').state === 'à_traiter' && mm.get('a').apres[0] === 'zz' && mm.get('b').state === 'prête', 'toujours fausse : à traiter (dépendance gardée), la tâche indépendante part');

  section('4. Chemins directs : 0 appel');
  reset();
  for (const [msg, want] of [['TODO: racheter du café', 'todo'], ['continuer p-20261019T144511-44d707', 'menu'], ['/abandonne p-20261019T144511-44d707', 'cancel_run'], ['/chef-discussion parle-moi de P', 'chef-discussion'], ['abandonner', 'menu-ambigu']]) {
    const x = await turn(msg);
    ok(x.path === want && x.calls === 0, `« ${msg} » → ${x.path}, ${x.calls} appel`);
  }
  ok(lines(CALLS).length === 0 && lines(CLS).length === 0, 'aucun appel de model pour les chemins directs');
  ok(CT.directPath('Arrête le tour de Q, il boucle').path === 'model', '« Arrête le tour de Q… » est une demande (pas un mot de menu seul)');

  section('5. Pannes d’infrastructure : garée (§3.7)');
  reset();
  fs.writeFileSync(INFRA, JSON.stringify({ cause: 'auth', left: 5 }));
  r = await turn('Lance X sur P.', { FAKE_CLAUDE_INFRA_FILE: INFRA, FAKE_CLAUDE_INFRA_ANY: '1' });
  ok(r.parked?.cause === 'auth' && r.calls === 1 && /claude \/login/.test(r.facts), 'OAuth expirée : garée, AUCUN nouvel essai, message « reconnectez Claude »');
  reset();
  fs.writeFileSync(INFRA, JSON.stringify({ cause: 'limit', left: 5 }));
  r = await turn('Lance X sur P.', { FAKE_CLAUDE_INFRA_FILE: INFRA, FAKE_CLAUDE_INFRA_ANY: '1' });
  ok(r.parked?.cause === 'limit' && r.calls === 1, 'limite de session : garée, aucun nouvel essai');
  reset();
  fs.writeFileSync(INFRA, JSON.stringify({ cause: 'refusal', left: 1 }));
  r = await turn('Lance X sur P.', { FAKE_CLAUDE_INFRA_FILE: INFRA, FAKE_CLAUDE_INFRA_ANY: '1', FAKE_CLAUDE_CHEF_V3: plan({}) });
  ok(!r.parked && r.calls === 2 && r.attempts[1].why.startsWith('refus du fournisseur'), 'refus du fournisseur : UN essai en session neuve, qui passe');
  reset();
  fs.writeFileSync(LFAIL, '1');
  r = await turn('Lance X sur P.', { FAKE_CLAUDE_LAUNCH_FAIL_FILE: LFAIL, FAKE_CLAUDE_LAUNCH_FAIL_ALL: '1', FAKE_CLAUDE_CHEF_V3: plan({}) });
  ok(!r.parked && r.calls === 2 && r.attempts[0].failure?.cause === 'exit', 'sortie sans résultat : nouvel essai après attente, qui passe');

  section('6. Contexte compact et consigne');
  RQ.createRequest(LOGS, { project: 'chef', text: 'Une demande restée ouverte sur Q.' });
  fs.mkdirSync(path.join(LOGS, 'runs', 'p-20261020T101010-abcdef'), { recursive: true });
  fs.writeFileSync(path.join(LOGS, 'runs', 'p-20261020T101010-abcdef', 'run.json'), JSON.stringify({ run: 'p-20261020T101010-abcdef', project: 'P', pipeline: 'dev', mode: 'leger', status: 'paused', pausedLimit: 'green', request: 'Corrige le parseur.' }));
  fs.mkdirSync(path.join(LOGS, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(LOGS, 'queue', 'Q.json'), JSON.stringify([{ id: 'q-1', text: 'Tâche en file pour Q' }]));
  const ctx = CT.compactContext(T, { logsDir: LOGS });
  ok(/- P\n- Q/.test(ctx) && !/^- chef$/m.test(ctx.split('# Projets')[1].split('\n\n')[1] || ''), 'liste fermée des projets (sans le chef)');
  ok(/Une demande restée ouverte sur Q/.test(ctx) && /p-20261020T101010-abcdef/.test(ctx) && /Q : 1 en file/.test(ctx), 'demandes non terminées, pauses, files : dans le contexte');
  const prompt = CT.chefPrompt({ context: ctx, message: 'x' });
  ok(/cancel_run/.test(prompt) && /stop_turn/.test(prompt) && /todo_add/.test(prompt) && /restart/.test(prompt) && /```plan/.test(prompt), 'la consigne donne la liste fermée des actions typées et le bloc ```plan');
  routing({ 'routage.chef': { provider: 'anthropic', model: 'claude-opus-5-5' } });
  ok(CT.chefCase(T).model === 'claude-opus-5-5' && CT.chefCase(T).source === 'case', 'une case routage.chef remplie est respectée');
  routing();

  section('7. Mode ombre : à côté du vrai tour du chef, AUCUN effet');
  reset();
  const enforce = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline-enforce.mjs'), ...a], { env: env(), encoding: 'utf8', windowsHide: true });
  let e = enforce('chef-shadow');
  ok(/chefV3.shadow = off/.test(e.stdout), 'coupée par défaut');
  const dispatch = (args, extra = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', ...args], { env: env(extra), encoding: 'utf8', timeout: 120_000, windowsHide: true });
  let d = dispatch(['Bonjour, que fait P ?']);
  await sleep(1500);
  ok(d.status === 0 && !fs.existsSync(path.join(LOGS, 'chef-shadow')), 'ombre coupée : rien ne tourne');
  e = enforce('chef-shadow', 'on');
  ok(e.status === 0 && CT.readChefV3(T).shadow === true, 'pipeline-enforce.mjs chef-shadow on');
  ok(/chefMode = off — ombre v3 : on/.test(enforce('chef-mode').stdout) && enforce('chef-mode', 'v3').status === 64, 'chef-mode reste off ; « v3 » refusé (bascule de la phase 4)');
  const before = snapshot(T);
  d = dispatch(['Corrige le bug de P puis documente-le.'], { FAKE_CLAUDE_CHEF_V3: plan({ taches: [{ ref: 'a', projet: 'P', titre: 'corriger', demande: 'Corrige le bug de P.' }, { ref: 'b', projet: 'P', titre: 'documenter', demande: 'Documente la correction de P.', apres: ['a'] }] }) });
  const jfile = path.join(LOGS, 'chef-shadow', 'journal.ndjson');
  const end = Date.now() + 60_000; while (Date.now() < end && !lines(jfile).length) await sleep(200);
  const j = lines(jfile);
  const req = RQ.listRequests(LOGS).filter(x => x.text === 'Corrige le bug de P puis documente-le.')[0];
  ok(d.status === 0 && j.length === 1 && j[0].request === req?.id && j[0].path === 'model' && j[0].calls === 1, `le vrai tour finit ; l’ombre a écrit son journal, rattaché à la demande ${req?.id}`, JSON.stringify(j));
  const rec = JSON.parse(fs.readFileSync(path.join(LOGS, 'chef-shadow', `${j[0]?.id}.json`), 'utf8'));
  ok(rec.result.repaired.items.length === 2 && rec.result.repaired.items[1].state === 'en_attente_de' && /Serait lancé/.test(rec.result.facts), 'le plan d’ombre : ce qui SERAIT lancé, et l’attente');
  const after = snapshot(T);
  const added = [...after.keys()].filter(k => !before.has(k));
  const allowed = (k) => k.startsWith(path.join('logs', 'chef-shadow')) || k.startsWith(path.join('logs', 'requests')) || /^logs[\\/]chef\.(jsonl|session|pid)/.test(k) || /\.ndjson$/.test(path.basename(k)) && [CALLS, CLS, DUMP].map(f => path.relative(T, f)).includes(k) || /^logs[\\/](pipeline-observe|pipeline-gate)\.ndjson$/.test(k);
  ok(added.every(allowed), `rien d’autre écrit que le journal d’ombre (et le vrai tour) : ${added.join(', ') || 'aucun fichier'}`, added.filter(k => !allowed(k)).join(', '));
  ok(!fs.existsSync(path.join(LOGS, 'P.jsonl')) && !fs.existsSync(path.join(LOGS, 'routage-pending.json')) && !fs.existsSync(path.join(LOGS, 'pipeline-classify.ndjson')), 'aucun dispatch vers P, aucune attente, aucun journal de classement');
  ok(RQ.readRequest(LOGS, req.id).tasks.length === 0, 'le registre ne reçoit aucune tâche de l’ombre');
  const chefLog = lines(path.join(LOGS, 'chef.jsonl'));
  ok(chefLog.filter(x => x.type === 'result').length >= 2 && !chefLog.some(x => /CHEF_V3/.test(JSON.stringify(x))), 'le journal du vrai chef ne porte aucune trace de l’ombre');
  d = dispatch(['[CALLBACK_WAKE] résultat de P', '--source', 'wake']);
  await sleep(1500);
  ok(lines(jfile).length === 1, 'un réveil ne lance pas l’ombre (message de l’utilisateur seulement)');
  ok(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'chef-turn.mjs'), 'list'], { env: env(), encoding: 'utf8' }).stdout.includes(j[0].id), 'chef-turn.mjs list montre le tour en ombre');
  enforce('off', '--all');
  ok(CT.readChefV3(T).shadow === false, 'pipeline-enforce.mjs off --all coupe aussi l’ombre');
  const s = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'chef-turn.mjs'), 'shadow', '--request', '-'], { env: env(), input: 'x', encoding: 'utf8' });
  ok(s.status === 2 && /ombre coupée/.test(s.stderr), 'ombre coupée : chef-turn.mjs shadow ne fait rien (code 2)');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
