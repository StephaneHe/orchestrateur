#!/usr/bin/env node
// ============================================================================
// scripts/_test_auto_answer.mjs — Opus 5.5 answers in place of an inactive
// user, behind mandatory guardrails (0.121.0)
// ============================================================================
//
// User rule (2026-10-20, verbatim): « si aucune activite de ma part depuis plus
// de 15 minutes, et qu'un process attend quelque chose de moi, et que je ne
// reponds pas dans les 5 minutes, opus 5.5 est charge et autorise a repondre a
// ma place. Un point de retours est cree si possible. Sinon il faut avancer »
// Confirmation (verbatim): « Ces gardes fous sont tres importants, garde les »
//
// Protected (requirement tests — never removed nor weakened without the user):
//   1. settings: switch on by default, 15 / 5 minutes, hot, clamped;
//   2. guardrails: the five mandatory ones, always present (file or code);
//   3. activity: user gestures only (browser / app), never a script;
//   4. due waits: inactive + wait > 5 min → due; active → nothing; switch
//      off → nothing; permission answered before its own expiry; caps;
//   5. EVERY guardrail blocks an engaging answer (named by the answer, by the
//      verification, or verification impossible) → non-engaging option;
//   6. waits read from the logs: questions, chef, lanes, pipeline pauses;
//   7. end to end with the real model runner (fake claude) and real git:
//      inactive → automatic answer + return point (tag, uncommitted work),
//      undo; active → nothing; guardrail → non-engaging answer; switch off →
//      nothing; served model ≠ Opus → nothing (no fallback); user back
//      during the turn → abandoned; no git → noted, and it goes on;
//   8. wiring: server routes, activity hook, no route that edits the
//      guardrails, dashboard switch and summary.
//
//   node scripts/_test_auto_answer.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as AA from './auto-answer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d !== undefined ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 1500)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-answer-'));
const MIN = 60_000;
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const G = AA.MANDATORY_GUARDRAILS.map(g => g.id);

function freshRoot(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, AA.GUARDRAILS_FILE), path.join(root, AA.GUARDRAILS_FILE));
  return root;
}
function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}
const ev = (o) => JSON.stringify(o) + '\n';
function questionLog(file, { question = 'Je fais A ou B ? Je recommande A.', endedAt }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file,
    ev({ type: 'user_prompt', text: 'Ajoute la fonction X', timestamp: new Date(endedAt - 2 * MIN).toISOString() }) +
    ev({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', timestamp: new Date(endedAt - 2 * MIN).toISOString() }) +
    ev({ type: 'assistant', message: { content: [{ type: 'text', text: `J'ai analysé.\nNEEDS_USER_INPUT: ${question}` }] } }) +
    ev({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_api_ms: 1000, result: `NEEDS_USER_INPUT: ${question}`, timestamp: new Date(endedAt).toISOString() }));
}

// ---------------------------------------------------------------------------
section('1. Réglages : interrupteur, 15 min, 5 min, à chaud');
{
  const root = freshRoot('settings');
  const s = AA.readSettings(root);
  ok(s.enabled === true && s.idleMin === 15 && s.waitMin === 5, 'défauts : règle active, 15 min d’inactivité, 5 min sans réponse', s);
  ok(AA.writeSettings(root, { idleMin: 0.5 }).status === 400, 'moins d’une minute refusé hors instance de test');
  ok(AA.writeSettings(root, { projects: ['x'] }).status === 400, 'liste de projets : fichier seulement');
  ok(AA.writeSettings(root, { enabled: 'non' }).status === 400, 'interrupteur : booléen seulement');
  const w = AA.writeSettings(root, { enabled: false, idleMin: 20, waitMin: 7 }, { by: 'utilisateur' });
  ok(w.ok && AA.readSettings(root).enabled === false && AA.readSettings(root).idleMin === 20 && AA.readSettings(root).waitMin === 7, 'écrit puis relu à chaud (aucun redémarrage)', w);
  ok(AA.writeSettings(root, { idleMin: 0.02 }, { testing: true }).ok, 'instance de test : délais courts permis');
}

// ---------------------------------------------------------------------------
section('2. Garde-fous obligatoires, toujours présents');
{
  const repo = JSON.parse(fs.readFileSync(path.join(ROOT, AA.GUARDRAILS_FILE), 'utf8'));
  ok(G.length === 5 && ['argent', 'secret', 'envoi-externe', 'suppression-definitive', 'publication-prive'].every(id => G.includes(id)), 'les cinq garde-fous décidés sont dans le code', G);
  ok(G.every(id => repo.guardrails.some(g => g.id === id && g.cases.length >= 1)), 'le fichier versionné les décrit tous, avec leurs cas');
  ok(repo.decision?.verbatim === 'Ces gardes fous sont tres importants, garde les', 'la décision de l’utilisateur est citée mot pour mot', repo.decision);
  const root = freshRoot('guard');
  fs.writeFileSync(path.join(root, AA.GUARDRAILS_FILE), JSON.stringify({ guardrails: [{ id: 'argent', label: 'Argent', cases: ['payer'] }, { id: 'autre-cas', label: 'Ajout', cases: [] }] }));
  let g = AA.loadGuardrails(root);
  ok(G.every(id => g.guardrails.some(x => x.id === id && x.mandatory)) && g.problems.length === 4, 'un garde-fou retiré du fichier est rétabli depuis le code (et signalé)', g.problems);
  ok(g.guardrails.some(x => x.id === 'autre-cas' && !x.mandatory), 'le fichier peut AJOUTER des cas réglables');
  fs.writeFileSync(path.join(root, AA.GUARDRAILS_FILE), '{cassé');
  g = AA.loadGuardrails(root);
  ok(G.every(id => g.guardrails.some(x => x.id === id)), 'fichier illisible : les cinq garde-fous restent appliqués');
  AA.writeSettings(root, { enabled: false });
  ok(AA.loadGuardrails(root).guardrails.length >= 5, 'interrupteur coupé : les garde-fous ne dépendent pas de lui');
}

// ---------------------------------------------------------------------------
section('3. Activité de l’utilisateur : gestes seulement, jamais un script');
{
  const B = 'Mozilla/5.0 (Windows NT 10.0) Edg/130', A = 'okhttp/4.12.0', N = 'node';
  const a = (p, ua = B, body = {}, method = 'POST') => AA.activityOf({ method, path: p, userAgent: ua, body });
  ok(a('/api/dispatch')?.kind === 'message', 'message du composer (dashboard)');
  ok(a('/api/dispatch', A)?.kind === 'message', 'message de l’app Android');
  ok(a('/api/dispatch', N) === null, 'dispatch d’un script (node) : pas une activité');
  ok(a('/api/dispatch', B, { queueIfBusy: true, source: 'chef' }) === null, 'dispatch relayé (file, chef) : pas une activité');
  ok(a('/api/permission/p-0123456789ab/decide')?.kind === 'autorisation', 'clic d’autorisation');
  ok(a('/api/permission/p-0123456789ab/decide', B, { by: AA.BY }) === null, 'décision de la réponse automatique : pas une activité de l’utilisateur');
  ok(a('/api/question/x/resolve')?.kind === 'question', '« Marquer comme répondue »');
  ok(a('/api/pipeline-gaps/k/accept')?.kind === 'lacune', 'décision sur une lacune');
  ok(a('/api/pipeline-runs/p-1/backoff')?.kind === 'pause', 'choix d’une pause');
  ok(a('/api/queue/x/order')?.kind === 'menu', 'geste sur la file');
  ok(a('/api/dispatch', B, {}, 'GET') === null && a('/api/version') === null, 'lecture : pas une activité');
  const logs = path.join(TMP, 'act-logs');
  AA.recordActivity(logs, { kind: 'message', source: 'dashboard' }, Date.parse('2026-10-20T10:00:00Z'));
  ok(AA.readActivity(logs)?.at === Date.parse('2026-10-20T10:00:00Z'), 'dernière activité enregistrée et relue');
}

// ---------------------------------------------------------------------------
section('4. Attentes dues : inactif + attente > 5 min ; actif → rien ; coupé → rien');
{
  const S = { ...AA.DEFAULT_SETTINGS, projects: [] };
  const now = Date.parse('2026-10-20T12:00:00Z');
  const idleOf = (agoMin, s = S) => AA.idleInfo({ activity: { at: now - agoMin * MIN }, now, settings: s });
  const W = (key, sinceAgoMin, extra = {}) => ({ key, kind: 'question', project: 'P', since: now - sinceAgoMin * MIN, ...extra });
  const due = (waits, idle, s = S, ledger = []) => AA.dueWaits({ waits, now, idle, settings: s, ledger }).map(w => w.key);
  ok(due([W('a', 6)], idleOf(20)).join() === 'a', 'inactif depuis 20 min, attente de 6 min : due');
  ok(due([W('a', 4)], idleOf(20)).length === 0, 'attente de 4 min : pas encore');
  ok(due([W('a', 30)], idleOf(10)).length === 0, 'utilisateur actif il y a 10 min : rien');
  ok(due([W('a', 30)], idleOf(20), { ...S, enabled: false }).length === 0, 'interrupteur coupé : rien');
  ok(due([W('a', 30)], AA.idleInfo({ activity: null, bootAt: now - 5 * MIN, now, settings: S })).length === 0, 'activité inconnue : comptée depuis le démarrage du serveur');
  const perm = { key: 'perm:p', kind: 'permission', project: 'P', since: now - 4 * MIN, deadline: now + 1 * MIN };
  ok(due([perm], idleOf(20)).join() === 'perm:p', 'autorisation : répondue avant son expiration (échéance − 90 s)');
  ok(due([W('a', 6)], idleOf(20), S, [{ key: 'a', status: 'applied' }]).length === 0, 'une attente déjà traitée ne l’est pas deux fois');
  ok(due([W('a', 6)], idleOf(20), S, [{ key: 'a', status: 'abandoned' }]).join() === 'a', 'une tentative abandonnée (utilisateur revenu) peut reprendre à l’absence suivante');
  const idle = idleOf(20);
  const ledger = [1, 2, 3].map(i => ({ key: `x${i}`, project: 'P', idleSince: idle.lastAt, status: 'applied' }));
  ok(due([W('b', 6)], idle, S, ledger).length === 0 && due([W('b', 6, { project: 'Q' })], idle, S, ledger).join() === 'b', 'plafond par projet pendant une même absence (3)');
  ok(due([W('a', 9), W('b', 7)], idleOf(20)).join() === 'a,b', 'la plus ancienne d’abord');
}

// ---------------------------------------------------------------------------
section('5. Chaque garde-fou bloque une réponse engageante');
{
  const { guardrails } = AA.loadGuardrails(ROOT);
  const q = { kind: 'question', project: 'P', question: 'On paye ?' };
  const engaging = (engages = []) => ({ ok: true, answer: 'Oui, fais-le en mon nom.', decision: null, engages, concerns: [], safeAnswer: 'Ne le fais pas ; avance sur le reste.', reason: 'r', sources: [] });
  const clean = { ok: true, answerEngages: [], safeEngages: [] };
  for (const id of G) {
    let f = AA.enforceGuardrails(q, engaging([id]), clean, guardrails);
    ok(f.mode === 'safe' && f.text === 'Ne le fais pas ; avance sur le reste.' && f.hits.includes(id), `${id} : nommé par la réponse → l’option non engageante est envoyée`, f);
    f = AA.enforceGuardrails(q, engaging([]), { ok: true, answerEngages: [id], safeEngages: [] }, guardrails);
    ok(f.mode === 'safe' && f.text !== engaging().answer, `${id} : vu par la vérification indépendante → bloqué`, f);
    f = AA.enforceGuardrails(q, engaging([]), { ok: true, answerEngages: [id], safeEngages: [id] }, guardrails);
    ok(f.mode === 'submit' && f.text === null, `${id} : l’option « sûre » engage aussi → rien n’est envoyé, soumis à l’utilisateur`, f);
    f = AA.enforceGuardrails({ ...q, kind: 'permission' }, { ...engaging([]), decision: 'allow' }, { ok: true, answerEngages: [id], safeEngages: [] }, guardrails);
    ok(f.mode === 'safe' && f.decision === 'deny', `${id} : autorisation engageante → refusée`, f);
    f = AA.enforceGuardrails({ ...q, kind: 'pause' }, engaging([id]), clean, guardrails);
    ok(f.mode !== 'answer', `${id} : pause de pipeline → jamais la réponse engageante`, f);
  }
  let f = AA.enforceGuardrails(q, engaging([]), { ok: false, why: 'model indisponible' }, guardrails);
  ok(f.mode === 'submit' && f.hits.includes(AA.VERIFY_FAILED), 'vérification impossible → rien d’engageant ne passe (soumis)', f);
  f = AA.enforceGuardrails({ ...q, kind: 'permission' }, { ...engaging([]), decision: 'allow' }, { ok: false, why: 'x' }, guardrails);
  ok(f.decision === 'deny', 'vérification impossible sur une autorisation → refus');
  f = AA.enforceGuardrails({ ...q, kind: 'gap' }, { ...engaging(['argent']), decision: 'accept' }, clean, guardrails);
  ok(f.mode === 'submit', 'lacune touchant un garde-fou → laissée à l’utilisateur');
  f = AA.enforceGuardrails(q, engaging([]), clean, guardrails);
  ok(f.mode === 'answer' && f.text === engaging().answer, 'aucun garde-fou en jeu : la réponse est envoyée telle quelle');
  ok(AA.normalizeAnswer({ kind: 'permission' }, { answer: 'x', decision: 'always' }).ok === false, 'autorisation : « toujours » n’existe pas pour la réponse automatique');
  ok(AA.answerPrompt({ kind: 'question', project: 'P', question: 'Q ?', context: {} }, { guardrails, idleMin: 15, waitMin: 5 }).includes('Ces gardes fous sont tres importants'), 'la consigne donnée à Opus cite les garde-fous et la décision de l’utilisateur');
}

// ---------------------------------------------------------------------------
section('6. Ce qui attend l’utilisateur, lu dans les logs');
{
  const logs = path.join(TMP, 'waits-logs');
  const now = Date.now();
  questionLog(path.join(logs, 'P.jsonl'), { endedAt: now - 6 * MIN });
  questionLog(path.join(logs, 'chef.jsonl'), { question: 'Je lance la release ?', endedAt: now - 7 * MIN });
  questionLog(path.join(logs, 'lanes', 'L', '1.jsonl'), { question: 'Couloir 1 : je garde ?', endedAt: now - 8 * MIN });
  questionLog(path.join(logs, 'R.jsonl'), { question: 'Pause : continuer ou abandonner ?', endedAt: now - 9 * MIN });
  fs.mkdirSync(path.join(logs, 'runs', 'p-20261020T100000-abcdef'), { recursive: true });
  fs.writeFileSync(path.join(logs, 'runs', 'p-20261020T100000-abcdef', 'run.json'), JSON.stringify({ project: 'R', pipeline: 'dev', status: 'paused', pausedLimit: 'review' }));
  fs.writeFileSync(path.join(logs, 'Idle.jsonl'), ev({ type: 'result', subtype: 'success', num_turns: 1, result: 'fini' }));
  const waits = AA.collectLogWaits({ logsDir: logs, projects: ['P', 'chef', 'L', 'R', 'Idle'].map(name => ({ name })), conductor: 'chef' });
  const by = (p) => waits.find(w => w.project === p);
  ok(by('P')?.kind === 'question' && by('P').question === 'Je fais A ou B ? Je recommande A.', 'question NEEDS_USER_INPUT d’un musicien', by('P'));
  ok(by('chef')?.isChef && by('chef').question === 'Je lance la release ?', 'question du chef');
  ok(by('L')?.lane === 1, 'question d’un couloir');
  ok(by('R')?.kind === 'pause' && by('R').context.run === 'p-20261020T100000-abcdef' && by('R').context.pausedLimit === 'review', 'pause de pipeline (menu)', by('R'));
  ok(!by('Idle'), 'un musicien sans question n’attend rien');
  ok(Math.abs(by('P').since - (now - 6 * MIN)) < 1000, 'l’attente compte depuis la fin du tour qui a posé la question');
  ok(AA.collectLogWaits({ logsDir: logs, projects: [{ name: 'P' }], busy: () => true }).length === 0, 'tour en cours : on n’y répond pas');
  const pw = AA.permissionWaits([{ id: 'p-0123456789ab', project: 'P', tool: 'Bash', preview: 'git push', createdAt: now, deadline: now + 5 * MIN, status: 'pending', explanation: { text: 'pousse' } }]);
  ok(pw[0]?.kind === 'permission' && pw[0].deadline === now + 5 * MIN, 'demande d’autorisation');
  const gw = AA.gapWaits([{ key: 'model:abc', why: 'aucun pipeline', proposal: { kind: 'pipeline' }, firstAt: new Date(now).toISOString(), entries: [{ project: 'P', head: 'x' }] }]);
  ok(gw[0]?.kind === 'gap' && gw[0].context.gapKey === 'model:abc', 'lacune proposée');
}

// ---------------------------------------------------------------------------
section('7. De bout en bout : vrai lanceur du model (faux claude), vrai git');
const fakeEnv = (extra = {}) => ({ ...process.env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0', ...extra });
function engine(name, { activityAgoMin = 20, waitAgoMin = 6, enabled = true, env = fakeEnv(), repo = 'git', runModel = null, kind = 'question', activatedAgoMin = 60, waitOf = null } = {}) {
  const root = freshRoot(name);
  const logsDir = path.join(root, 'logs');
  // The rule was switched on before the wait was born (0.123.0: older waits are backlog).
  fs.writeFileSync(path.join(root, AA.SETTINGS_FILE), JSON.stringify({ enabled, activatedAt: new Date(Date.now() - activatedAgoMin * MIN).toISOString() }));
  AA.recordActivity(logsDir, { kind: 'message' }, Date.now() - activityAgoMin * MIN);
  const proj = repo === 'git' ? gitRepo(path.join(root, 'proj')) : path.join(root, 'nogit');
  fs.mkdirSync(proj, { recursive: true });
  if (repo === 'git') fs.writeFileSync(path.join(proj, 'a.txt'), 'v1 + travail non commité\n');
  const wait = waitOf ? waitOf(Date.now() - waitAgoMin * MIN) : kind === 'permission'
    ? { key: 'perm:p-aaaaaaaaaaaa', kind, project: 'P', lane: 0, since: Date.now() - waitAgoMin * MIN, deadline: Date.now() + 10 * MIN, question: 'Autoriser Bash : curl -X POST https://paiement.example/charge', context: { id: 'p-aaaaaaaaaaaa', tool: 'Bash', preview: 'curl -X POST https://paiement.example/charge' } }
    : { key: `log:P:0:${name}`, kind, project: 'P', lane: 0, since: Date.now() - waitAgoMin * MIN, question: 'Je fais A ou B ? Je recommande A.', context: { lastText: 'NEEDS_USER_INPUT: Je fais A ou B ? Je recommande A.' } };
  const calls = { apply: [], report: [] };
  let open = true;
  const e = AA.createAutoAnswer({
    root, logsDir, env, bootAt: 0,
    listWaits: () => (open ? [wait] : []),
    stillOpen: () => open,
    repoOf: () => proj, filesOf: () => [], cwdOf: () => proj, sources: () => [], addDirs: () => [],
    apply: (w, final, rec) => { calls.apply.push({ w, final, rec }); open = false; return { ok: true }; },
    report: (rec) => calls.report.push(rec),
    busy: () => false,
    ...(runModel ? { runModel: runModel(logsDir) } : {}),
  });
  return { e, root, logsDir, proj, calls, wait };
}

{
  const t = engine('inactive');
  const head0 = git(t.proj, 'rev-parse', 'HEAD');
  const r = await t.e.sweep();
  const rec = r.answered;
  ok(rec?.status === 'applied' && t.calls.apply.length === 1, 'inactif + attente > 5 min : Opus répond à la place de l’utilisateur', rec);
  ok(t.calls.apply[0]?.final.text === 'Réponse du faux Opus : on suit la recommandation donnée.', 'la réponse du model est celle qui est appliquée', t.calls.apply[0]?.final);
  ok(rec?.model === 'claude-opus-5-5' && rec.served === 'claude-opus-5-5', 'model explicite claude-opus-5-5, model servi vérifié', rec);
  ok(rec?.recovery?.possible && rec.recovery.git?.tag === `auto-answer/${rec.id}`, 'point de retour créé avant d’appliquer (tag git)', rec?.recovery);
  ok(rec?.recovery?.git?.stash && git(t.proj, 'show', `${rec.recovery.git.tag}:a.txt`) === 'v1 + travail non commité', 'le travail non commité est dans le point de retour', rec?.recovery);
  ok(rec?.recovery?.git?.head === head0, 'le point de retour garde le HEAD d’avant');
  ok(t.calls.report.length === 1 && AA.decisionText(rec).startsWith(AA.MARK), `carte marquée « ${AA.MARK} »`, AA.decisionText(rec));
  ok(/Retour arrière/.test(rec?.recovery?.text || '') && rec.reason, 'la raison et le moyen de revenir en arrière sont indiqués', rec);
  const v = t.e.view();
  ok(v.unseen === 1 && v.decisions[0].undoable && v.decisions[0].text.startsWith(AA.MARK), 'résumé au retour : décision non vue, annulable', v.decisions[0]);
  // Work done after the automatic answer, then undo.
  fs.writeFileSync(path.join(t.proj, 'b.txt'), 'après\n');
  git(t.proj, 'add', '-A'); git(t.proj, 'commit', '-qm', 'travail après la réponse');
  const u = t.e.undo(rec.id);
  ok(u.ok && git(t.proj, 'rev-parse', 'HEAD') === head0 && fs.readFileSync(path.join(t.proj, 'a.txt'), 'utf8') === 'v1 + travail non commité\n', 'Annuler : le projet revient au point de retour (HEAD et travail non commité)', u);
  ok(git(t.proj, 'tag', '-l', `auto-answer-undo/${rec.id}`) === `auto-answer-undo/${rec.id}`, 'l’état d’avant l’annulation est gardé (tag auto-answer-undo)');
  ok(t.e.undo(rec.id).status === 409, 'une décision ne s’annule qu’une fois');
  ok(t.e.seen() === 1 && t.e.view().unseen === 0, '« Vu » : le résumé se vide');
  ok((await t.e.sweep()).answered === null, 'l’attente traitée ne l’est pas une seconde fois');
}
{
  const t = engine('active', { activityAgoMin: 2 });
  const r = await t.e.sweep();
  ok(r.skipped === 'utilisateur actif' && t.calls.apply.length === 0 && AA.readLedger(t.logsDir).length === 0, 'utilisateur actif : rien n’est répondu', r);
}
{
  const t = engine('off', { enabled: false });
  const r = await t.e.sweep();
  ok(r.skipped === 'règle coupée' && t.calls.apply.length === 0 && AA.readLedger(t.logsDir).length === 0, 'interrupteur coupé : rien', r);
}
{
  const t = engine('young', { waitAgoMin: 3 });
  ok((await t.e.sweep()).answered === null && t.calls.apply.length === 0, 'attente de moins de 5 min : on attend encore');
}
for (const id of G) {
  const t = engine(`guard-${id}`, { env: fakeEnv({
    FAKE_CLAUDE_AUTO_ANSWER: JSON.stringify({ answer: 'Oui, vas-y, fais-le en mon nom.', engages: [], concerns: [id], safeAnswer: 'Ne fais pas cette partie ; avance sur le reste et laisse-la à l’utilisateur.', reason: 'r' }),
    FAKE_CLAUDE_AUTO_VERIFY: JSON.stringify({ answerEngages: [id], safeEngages: [], why: 'engage' }),
  }) });
  const rec = (await t.e.sweep()).answered;
  ok(rec?.status === 'safe' && t.calls.apply[0]?.final.text.startsWith('Ne fais pas cette partie') && rec.guardrails.hits.includes(id), `garde-fou ${id} : l’option non engageante est envoyée, jamais la réponse engageante`, rec);
}
{
  const t = engine('guard-perm', { kind: 'permission', env: fakeEnv({ FAKE_CLAUDE_AUTO_ANSWER: JSON.stringify({ answer: 'ok', decision: 'allow', engages: ['argent'] }) }) });
  const rec = (await t.e.sweep()).answered;
  ok(rec?.status === 'safe' && t.calls.apply[0]?.final.decision === 'deny', 'garde-fou sur une autorisation : refusée', rec);
}
{
  const t = engine('guard-submit', { env: fakeEnv({
    FAKE_CLAUDE_AUTO_ANSWER: JSON.stringify({ answer: 'Voici le mot de passe : hunter2', engages: ['secret'], safeAnswer: '' }),
  }) });
  const rec = (await t.e.sweep()).answered;
  ok(rec?.status === 'submitted' && t.calls.apply.length === 0 && t.calls.report.length === 1 && rec.recovery === null, 'sans option non engageante : rien n’est envoyé, la décision est soumise à l’utilisateur', rec);
}
{
  const t = engine('wrong-model', { env: fakeEnv({ FAKE_CLAUDE_ECHO_MODEL: '' }) });
  const rec = (await t.e.sweep()).answered;
  ok(rec?.status === 'failed' && /aucun repli/.test(rec.why) && t.calls.apply.length === 0, 'model servi ≠ Opus 5.5 : rien n’est répondu (aucun repli)', rec);
}
{
  const t = engine('back', { runModel: (logsDir) => async (prompt, opts) => {
    const r = await AA.runOpus(prompt, opts);
    if (prompt.startsWith('[AUTO_VERIFY]')) AA.recordActivity(logsDir, { kind: 'message' });
    return r;
  } });
  const rec = (await t.e.sweep()).answered;
  ok(rec?.status === 'abandoned' && rec.why === 'utilisateur revenu' && t.calls.apply.length === 0, 'l’utilisateur revient pendant le tour d’Opus : rien n’est appliqué', rec);
}
{
  const t = engine('nogit', { repo: 'none' });
  const rec = (await t.e.sweep()).answered;
  ok(rec?.status === 'applied' && rec.recovery.possible === false && /Aucun point de retour possible/.test(rec.recovery.text) && /avance/.test(rec.recovery.text), 'aucun point de retour possible : noté, et on avance quand même', rec?.recovery);
  ok(!t.e.view().decisions[0].undoable && t.e.undo(rec.id).status === 409, 'sans point de retour : pas de bouton Annuler');
}
{
  // Incident of the first sandbox run: a project folder without git, inside
  // another repository, got its return point (and would get its undo) in the
  // PARENT repository.
  const parent = gitRepo(path.join(TMP, 'parent-repo'));
  const nested = path.join(parent, 'projects', 'kappa');
  fs.mkdirSync(nested, { recursive: true });
  const rp = AA.makeRecoveryPoint({ id: 'aa-nested', logsDir: path.join(TMP, 'nested-logs'), repo: nested });
  ok(!AA.isGitRepo(nested) && rp.possible === false && rp.git === null && git(parent, 'tag', '-l') === '', 'dossier sans git DANS un autre dépôt : aucun tag dans le dépôt parent, noté « hors git »', rp);
  ok(AA.isGitRepo(parent), 'la racine d’un dépôt est bien reconnue');
}
{
  const logsDir = path.join(TMP, 'files');
  const f = path.join(TMP, 'run.json');
  fs.writeFileSync(f, '{"status":"paused"}');
  const rp = AA.makeRecoveryPoint({ id: 'aa-x', logsDir, files: [f] });
  fs.writeFileSync(f, '{"status":"running"}');
  const u = AA.undoRecovery({ id: 'aa-x', project: 'P', recovery: rp, kind: 'pause' });
  ok(rp.possible && u.ok && fs.readFileSync(f, 'utf8') === '{"status":"paused"}', 'point de retour d’un état (run.json) : copié puis restauré');
  const routing = path.join(TMP, 'model-routing.json');
  fs.writeFileSync(routing, JSON.stringify({ version: 2, custom: { attach: [{ pipeline: 'dev', when: 'a' }] }, gapDecisions: {} }));
  const rg = AA.makeRecoveryPoint({ id: 'aa-g', logsDir, files: [routing] });
  fs.writeFileSync(routing, JSON.stringify({ version: 2, custom: { attach: [{ pipeline: 'dev', when: 'a' }, { pipeline: 'dev', when: 'ajout' }] }, gapDecisions: { k: { decision: 'accepted', by: AA.BY }, other: { decision: 'rejected' } } }));
  AA.undoRecovery({ id: 'aa-g', project: null, kind: 'gap', gapKey: 'k', recovery: rg }, { routingFile: routing });
  const after = JSON.parse(fs.readFileSync(routing, 'utf8'));
  ok(!after.gapDecisions.k && after.gapDecisions.other && after.custom.attach.length === 1, 'lacune : seule sa décision et ce qu’elle a ajouté sont retirés', after);
}

// ---------------------------------------------------------------------------
section('8. Branchement : serveur, interface');
{
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/createAutoAnswer\(/.test(srv) && /autoAnswer\.sweep\(\)/.test(srv), 'le serveur balaie les attentes (createAutoAnswer, sweep)');
  ok(/activityOf\(/.test(srv) && /recordActivity\(/.test(srv), 'chaque geste de l’utilisateur est enregistré (activityOf → recordActivity)');
  for (const r of ["app.get('/api/auto-answer'", "app.post('/api/auto-answer/settings'", "app.post('/api/auto-answer/seen'", "app.post('/api/auto-answer/:id/undo'", "app.post('/api/user-activity'"]) ok(srv.includes(r), `route ${r.replace(/^app\./, '')}`);
  ok(!/app\.(post|put|delete|patch)\(\s*'\/api\/auto-answer\/guardrails/.test(srv) && !/guardrails[^\n]*sameOriginOnly/.test(srv), 'aucune route ne modifie les garde-fous');
  ok(/AUTO_MODEL/.test(srv) || /auto-answer\.mjs/.test(srv), 'le serveur utilise le module (model explicite)');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'auto-answer.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  ok(html.includes('id="btn-auto"') && html.includes('auto-answer.js') && html.includes('id="auto-band"'), 'interrupteur visible dans la barre du haut, bandeau du résumé');
  ok(/\/api\/auto-answer\/settings/.test(client) && /undo/.test(client) && /seen/.test(client), 'le client règle l’interrupteur, annule et marque vu');
  ok(!/guardrails[^\n]*(POST|PUT|method)/.test(client), 'le client n’offre aucun moyen de modifier les garde-fous');
  const tc = fs.readFileSync(path.join(ROOT, 'public', 'turn-core.js'), 'utf8');
  ok(/auto_answer/.test(tc), 'le journal d’activité lit la marque de réponse automatique');
}

// ---------------------------------------------------------------------------
// Incident of 2026-10-20 (v0.121.0 in production), user's words:
// « Tu viens d'afficher une petite fenetre pour me prevenir que opus 5.5 avait
// pris une decision a ma place alors que je suis actif, et que je ne vois aucune
// question en attente » — ten-day-old proposed gaps, invisible outside the
// Models page, were rejected while the user was reading the dashboard.
// « La partie "Garde-fous — obligatoires, toujours actifs" est trop importante.
// Trouve un moyen de la faire plus discrete. Il faut pouvoir aussi discard des
// notifications qui ne sont plus utiles une fois acceptee ou annulee ou obsoletes »
section('9. Incident du 2026-10-20 : lecture, arriéré, lacune non présentée, notification, écarter');
{
  const B = 'Mozilla/5.0 (Windows NT 10.0) Edg/130';
  ok(AA.activityOf({ method: 'POST', path: '/api/user-activity', userAgent: B, body: { kind: 'présence' } })?.kind === 'présence', 'battement de présence du dashboard : compté comme activité');
  ok(AA.activityOf({ method: 'POST', path: '/api/user-activity', userAgent: 'node', body: { kind: 'présence' } }) === null, 'battement venu d’un script : ignoré');

  // 9a — a user who reads (heartbeat) is not inactive.
  {
    const t = engine('reading', { activityAgoMin: 20, waitAgoMin: 6 });
    AA.recordActivity(t.logsDir, { kind: 'présence', source: 'dashboard' }, Date.now() - 1 * MIN);
    const r = await t.e.sweep();
    ok(r.skipped === 'utilisateur actif' && t.calls.apply.length === 0 && AA.readLedger(t.logsDir).length === 0, 'utilisateur qui lit (battement il y a 1 min, aucun geste depuis 20 min) : aucune réponse', r);
    const a = AA.readActivity(t.logsDir);
    ok(a.kind === 'présence' && a.lastGestureKind === 'message', 'la présence ne remplace pas le dernier geste (gardé pour l’explication)', a);
  }
  // 9b — presence periods: a return starts a new one.
  {
    const logs = path.join(TMP, 'presence-logs');
    const t0 = Date.parse('2026-10-20T08:00:00Z');
    AA.recordActivity(logs, { kind: 'message' }, t0);
    AA.recordActivity(logs, { kind: 'présence' }, t0 + 5 * MIN);
    ok(AA.readActivity(logs).presentSince === t0, 'battements rapprochés : même période de présence');
    AA.recordActivity(logs, { kind: 'présence' }, t0 + 60 * MIN);
    ok(AA.readActivity(logs).presentSince === t0 + 60 * MIN, 'retour après plus de 15 min sans signe : nouvelle période de présence');
  }
  // 9c — backlog: born before the activation of the rule ⇒ never answered.
  {
    const t = engine('backlog-activation', { activityAgoMin: 30, waitAgoMin: 10 * 24 * 60, activatedAgoMin: 60 });
    const r = await t.e.sweep();
    ok(r.answered === null && t.calls.apply.length === 0, 'attente de 10 jours, antérieure à l’activation : jamais traitée', r);
    const v = await t.e.overview();
    ok(v.backlog.length === 1 && v.backlog[0].reason === 'avant-activation' && /activation/.test(v.backlog[0].reasonText), 'elle est listée pour l’utilisateur (arriéré, avec la raison)', v.backlog);
  }
  {
    // A rule enabled by default before 0.123.0 has no activation date: it is set now.
    const root = freshRoot('no-activation');
    ok(AA.readSettings(root).activatedAt === null && AA.ensureActivation(root).activatedAt !== null, 'règle active sans date d’activation : datée au premier balayage');
    const st = AA.writeSettings(root, { enabled: false });
    const t1 = Date.now();
    const on = AA.writeSettings(root, { enabled: true });
    ok(st.ok && on.ok && Date.parse(on.settings.activatedAt) >= t1 - 1000, 'rallumer la règle la redate (l’arriéré de la coupure n’est jamais traité)', on.settings);
  }
  // 9d — backlog: born before the user's last return ⇒ never answered.
  {
    const t = engine('backlog-return', { activityAgoMin: 180, waitAgoMin: 120, activatedAgoMin: 600 });
    AA.recordActivity(t.logsDir, { kind: 'message' }, Date.now() - 30 * MIN);   // back 30 min ago, idle since
    const r = await t.e.sweep();
    const v = await t.e.overview();
    ok(r.answered === null && t.calls.apply.length === 0 && v.backlog[0]?.reason === 'avant-retour', 'attente née avant le retour de l’utilisateur : jamais traitée, listée', { r, b: v.backlog });
  }
  // 9e — proposed gaps: only once presented to the user.
  {
    const S = { ...AA.DEFAULT_SETTINGS, activatedAt: new Date(Date.now() - 60 * MIN).toISOString() };
    const now = Date.now();
    const idle = AA.idleInfo({ activity: { at: now - 40 * MIN }, now, settings: S });
    const gap = { key: 'gap:k1', kind: 'gap', project: 'P', since: now - 30 * MIN, question: 'Lacune', context: { gapKey: 'k1' } };
    ok(AA.dueWaits({ waits: [gap], now, idle, settings: S }).length === 0, 'lacune jamais présentée : exclue');
    ok(AA.classifyWaits({ waits: [gap], settings: S, idle }).backlog[0]?.backlog === 'non-presentee', 'elle est listée comme non présentée');
    ok(AA.dueWaits({ waits: [gap], now, idle, settings: S, presented: { 'gap:k1': now - 2 * MIN } }).length === 0, 'présentée il y a 2 min : le délai de 5 min court depuis la présentation');
    ok(AA.dueWaits({ waits: [gap], now, idle, settings: S, presented: { 'gap:k1': now - 6 * MIN } }).length === 1, 'présentée il y a 6 min, sans réponse : due');
    const logs = path.join(TMP, 'presented-logs');
    ok(AA.recordPresented(logs, ['gap:k1', 'log:x', 'gap:k1']) === 1 && AA.readPresented(logs)['gap:k1'] > 0 && !AA.readPresented(logs)['log:x'], 'présentation enregistrée (lacunes seulement, une fois)');
    // The production incident replayed: idle 15 min, gap 10 days old, rule enabled by default.
    const old = { ...gap, since: now - 14_032 * MIN };
    const prodS = { ...AA.DEFAULT_SETTINGS, activatedAt: new Date(now).toISOString() };
    ok(AA.dueWaits({ waits: [old], now: now + 20 * MIN, idle: AA.idleInfo({ activity: { at: now - 15 * MIN }, now: now + 20 * MIN, settings: prodS }), settings: prodS, presented: {} }).length === 0, 'incident rejoué (lacune de 10 jours, jamais présentée) : aucune décision');
  }
  // 9f — the notification says what, on which element, and why inactive.
  {
    const t = engine('notice', { activityAgoMin: 20 });
    const rec = (await t.e.sweep()).answered;
    const txt = AA.decisionText(rec);
    ok(rec?.inactivity?.thresholdMin === 15 && rec.inactivity.idleMin >= 19 && rec.inactivity.lastKind === 'message', 'la décision garde pourquoi l’utilisateur était inactif', rec?.inactivity);
    ok(/question — répondu à votre place/.test(txt) && /Élément : question de P/.test(txt) && /Pourquoi vous étiez considéré inactif : dernier signe de vous à \d\d:\d\d \(message\), soit \d+ min sans activité ≥ seuil de 15 min ; demande en attente depuis 6 min/.test(txt), 'notification : quoi, sur quel élément, pourquoi inactif', txt);
    const d = (await t.e.overview()).decisions[0];
    ok(d.target?.type === 'project' && d.target.project === 'P' && d.what && d.why_inactive, 'la vue donne la cible (lien) et la raison', d);
    const gapRec = { kind: 'gap', status: 'applied', decision: 'reject', gapKey: 'routage:44', waitedMin: 14032, inactivity: { lastAt: new Date().toISOString(), lastKind: 'message', lastSource: 'dashboard', idleMin: 15, thresholdMin: 15 } };
    ok(/lacune proposée — lacune rejetée/.test(AA.decisionText(gapRec)) && /lacune « routage:44 »/.test(AA.decisionText(gapRec)) && /10 jours/.test(AA.decisionText(gapRec)) && AA.decisionTarget(gapRec).type === 'gap', 'lacune : « lacune rejetée », sa clé, l’attente en jours', AA.decisionText(gapRec));
  }
  // 9g — undo of a rejected gap: return point noted, undo works, user decisions untouched.
  {
    const logs = path.join(TMP, 'gap-undo');
    const routing = path.join(TMP, 'model-routing-gap.json');
    fs.writeFileSync(routing, JSON.stringify({ version: 2, custom: { attach: [] }, gapDecisions: { other: { decision: 'rejected', by: 'dashboard' } } }));
    const rp = AA.makeRecoveryPoint({ id: 'aa-gap1', logsDir: logs, files: [routing] });
    ok(rp.possible && !/git reset/.test(rp.text) && /bouton « Annuler »/.test(rp.text), 'point de retour noté pour une lacune (copie), sans « git reset » trompeur', rp.text);
    const cur = JSON.parse(fs.readFileSync(routing, 'utf8'));
    cur.gapDecisions.k = { decision: 'rejected', by: AA.BY };
    cur.custom.attach.push({ pipeline: 'dev', when: 'ajout ultérieur de l’utilisateur' });
    fs.writeFileSync(routing, JSON.stringify(cur));
    const u = AA.undoRecovery({ id: 'aa-gap1', kind: 'gap', gapKey: 'k', recovery: rp }, { routingFile: routing });
    const after = JSON.parse(fs.readFileSync(routing, 'utf8'));
    ok(u.ok && !after.gapDecisions.k && after.gapDecisions.other && after.custom.attach.length === 1, 'Annuler un rejet : la lacune est de nouveau proposée, le reste (décisions et ajouts postérieurs) intact', { u, after });
    after.gapDecisions.k = { decision: 'accepted', by: 'dashboard' };
    fs.writeFileSync(routing, JSON.stringify(after));
    const u2 = AA.undoRecovery({ id: 'aa-gap1', kind: 'gap', gapKey: 'k', recovery: rp }, { routingFile: routing });
    ok(u2.ok === false && u2.status === 409 && JSON.parse(fs.readFileSync(routing, 'utf8')).gapDecisions.k.by === 'dashboard', 'décision reprise depuis par l’utilisateur : l’annulation la laisse intacte (409)', u2);
  }
  // 9h — dismiss: handled ⇒ removed from the view, kept in the history; obsolete detected; pending needs confirmation.
  {
    const logs = path.join(TMP, 'dismiss-logs');
    const mk = (id, status, extra = {}) => AA.upsertDecision(logs, { id, key: `k-${id}`, kind: 'question', project: 'P', status, at: new Date().toISOString(), question: 'Q', ...extra });
    mk('aa-1', 'applied'); mk('aa-2', 'submitted'); mk('aa-3', 'submitted'); mk('aa-4', 'failed');
    const open = (r) => (r.id === 'aa-3' ? false : true);
    ok(AA.decisionPhase(AA.readLedger(logs)[2], open).phase === 'obsolete' && AA.decisionPhase(AA.readLedger(logs)[1], open).phase === 'pending', 'obsolète détectée (demande close entre-temps) ; soumise encore ouverte = en attente');
    let r = AA.dismissDecisions(logs, { ids: ['aa-1'], targetOpen: open });
    ok(r.ok && r.dismissed.join() === 'aa-1' && AA.readLedger(logs).find(d => d.id === 'aa-1').dismissedAt, '« Écarter » une décision traitée : retirée de la vue', r);
    ok(AA.readLedger(logs).length === 4, 'rien n’est effacé du registre (historique)');
    r = AA.dismissDecisions(logs, { ids: ['aa-2'], targetOpen: open });
    ok(!r.ok && r.needsConfirm.join() === 'aa-2' && !AA.readLedger(logs).find(d => d.id === 'aa-2').dismissedAt, 'une décision encore en attente ne s’écarte pas sans confirmation', r);
    r = AA.dismissDecisions(logs, { handled: true, targetOpen: open });
    ok(r.ok && r.dismissed.sort().join() === 'aa-3,aa-4', '« Écarter tout ce qui est traité ou obsolète » : la soumise ouverte reste', r);
    r = AA.dismissDecisions(logs, { ids: ['aa-2'], confirm: true, targetOpen: open });
    ok(r.ok && r.dismissed.join() === 'aa-2', 'avec confirmation : écartée');
    const t = engine('dismiss-view');
    const rec = (await t.e.sweep()).answered;
    ok(t.e.dismiss({ ids: [rec.id] }).ok, 'écarter depuis le moteur');
    const v = t.e.view();
    ok(!v.decisions.some(d => d.id === rec.id) && v.history.some(d => d.id === rec.id && d.dismissed) && v.unseen === 0, 'la vue ne la montre plus, l’historique la garde', { d: v.decisions.length, h: v.history.length });
  }
  // 9i — guardrails: compact in the menu, still the five, still enforced.
  {
    const client = fs.readFileSync(path.join(ROOT, 'public', 'auto-answer.js'), 'utf8');
    ok(/<details class="aa-guards-d"><summary[^>]*>🔒 \$\{list\.length\} garde-fous actifs<\/summary>/.test(client) && !/aa-guards-d"[^>]*open/.test(client), 'menu : garde-fous repliés par défaut sur une ligne « 🔒 N garde-fous actifs »');
    ok(!/<h3>Garde-fous/.test(client), 'plus de grande section « Garde-fous » dans le menu');
    const { guardrails } = AA.loadGuardrails(ROOT);
    ok(G.every(id => guardrails.some(g => g.id === id && g.mandatory)), 'les cinq garde-fous restent chargés et obligatoires');
    const f = AA.enforceGuardrails({ kind: 'question' }, { ok: true, answer: 'Paye.', decision: null, engages: ['argent'], concerns: [], safeAnswer: '', reason: '', sources: [] }, { ok: true, answerEngages: [], safeEngages: [] }, guardrails);
    ok(f.mode === 'submit', 'et restent appliqués (affichage seul changé)');
  }
  // 9j — wiring.
  {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    for (const r of ["app.post('/api/auto-answer/dismiss'", "app.post('/api/auto-answer/presented'"]) ok(srv.includes(r), `route ${r.replace(/^app\./, '')}`);
    ok(/targetOpen:/.test(srv) && /autoAnswer\.overview\(/.test(srv), 'obsolescence et arriéré servis par /api/auto-answer');
    const client = fs.readFileSync(path.join(ROOT, 'public', 'auto-answer.js'), 'utf8');
    ok(/\/api\/user-activity/.test(client) && /visibilityState/.test(client) && /hasFocus/.test(client), 'le dashboard envoie un battement de présence (onglet visible, focalisé, utilisé)');
    const models = fs.readFileSync(path.join(ROOT, 'public', 'models.js'), 'utf8');
    ok(/\/api\/auto-answer\/presented/.test(models), 'la page Models déclare les lacunes réellement présentées');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    ok(/id="notif-dock"[\s\S]*id="perm-band"[\s\S]*id="auto-band"[\s\S]*<\/section>/.test(html) && html.includes('notif-dock.js') && html.includes('notif-dock.css'), 'demandes regroupées dans la zone compacte #notif-dock');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'notif-dock.css'), 'utf8');
    ok(/\.nd-body\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/.test(css) && !/position:\s*fixed/.test(css), 'zone de hauteur bornée, défilement interne, jamais par-dessus la page');
  }
  // 9k — the client's presence logic (visible, focused, recently used).
  {
    const vm = await import('node:vm');
    const ctx = { console, setTimeout, clearTimeout, setInterval: () => 0, Date, JSON, globalThis: null };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'auto-answer.js'), 'utf8'), ctx);
    const A = ctx.AutoAnswer;
    const doc = (vis, focus) => ({ visibilityState: vis, hasFocus: () => focus });
    const now = Date.now();
    A.presence.lastInteraction = now - 2 * MIN; A.presence.lastSent = now - 2 * MIN;
    ok(A.presenceDue(now, doc('visible', true)) === true, 'onglet visible, focalisé, utilisé il y a 2 min : battement');
    ok(A.presenceDue(now, doc('hidden', true)) === false, 'onglet caché : aucun battement');
    ok(A.presenceDue(now, doc('visible', false)) === false, 'onglet sans le focus : aucun battement');
    A.presence.lastInteraction = now - 11 * MIN;
    ok(A.presenceDue(now, doc('visible', true)) === false, 'rien touché depuis plus de 10 min : plus de battement (absence)');
    A.presence.lastInteraction = now; A.presence.lastSent = now - 10_000;
    ok(A.presenceDue(now, doc('visible', true)) === false, 'un battement par minute au plus');
  }
}

// ---------------------------------------------------------------------------
// User decision (2026-10-20, verbatim): « Réponse en votre absence face à une
// limite de pipeline.: applique la recommandation » (KG synthesis, decision 6).
// The limit stays a pause (decision 14 of the pipelines, _test_pipeline_gates
// untouched); in the user's absence Opus may answer it: once per run, git
// return point first, answer marked « 🤖 auto », never « abandonner », options
// derived from the diagnosed cause.
section('10. Limite de pipeline en votre absence : une fois par exécution, point de retour, « 🤖 auto », jamais abandonner');
{
  const RUN = 'p-20261020T120000-abc123';
  const diag = (recommend = 'découper') => ({ cause: 'La liste compte 19 tests (maximum 15).', kind: 'too_big',
    options: [{ key: 'découper', does: 'je livre ce qui est fait ; le reste devient des demandes nommées.' },
      { key: 'prolonger', does: 'j’accepte les 19 tests dans cette exécution seulement.' },
      { key: 'changer le model', does: 'choisissez un autre model puis « continuer ».' },
      { key: 'simplifier', does: 'je clos l’exécution.' }, { key: 'livrer sans eux', does: 'j’arrête ici.' },
      { key: 'abandonner', does: 'je clos l’exécution sans rien livrer.' }],
    recommend: { key: recommend, why: 'parce que.' } });
  const limitWait = (since, { limit = 'items', run = RUN, d = diag(), key = `log:P:0:${since}` } = {}) => ({ key, kind: 'pause', project: 'P', lane: 0, since,
    question: 'Limite atteinte : que faire ?', context: { lastText: 'NEEDS_USER_INPUT: Limite atteinte.', run, pipeline: 'dev', pausedLimit: limit, diagnosis: d } });
  const { guardrails } = AA.loadGuardrails(ROOT);

  // 10a — what counts as a limit, which options remain.
  ok(AA.isLimitPause(limitWait(1)) && !AA.isLimitPause(limitWait(1, { limit: 'doutes' })) && !AA.isLimitPause({ kind: 'question', context: { pausedLimit: 'items' } }), 'pause de limite reconnue (items, review, duration…), pas une autre pause');
  ok(['items', 'review', 'duration', 'item_tests', 'items_blocked'].every(l => AA.LIMIT_PAUSES.includes(l)), 'les limites de budget du moteur sont couvertes (items, tours de revue, durée, tests par item, items mis de côté)');
  ok(AA.limitOptions(diag()).map(o => o.key).join() === 'découper,prolonger', 'options dérivées de la cause, sans abandonner / simplifier / livrer sans eux / changer le model', AA.limitOptions(diag()));

  // 10b — never « abandonner » (nor any option that closes the run).
  const W = limitWait(1);
  for (const bad of ['abandonner, la limite est atteinte', 'simplifier', 'livrer sans eux', 'changer le model', 'continuer'])
    ok(AA.normalizeAnswer(W, { answer: bad }).ok === false, `réponse « ${bad} » refusée sur une limite`);
  const good = AA.normalizeAnswer(W, { answer: 'découper — la liste dépasse de 4 tests.', safeAnswer: 'abandonner' });
  ok(good.ok && good.safeAnswer === '', 'réponse « découper » acceptée ; une option sûre « abandonner » est retirée', good);
  ok(AA.normalizeAnswer(limitWait(1, { d: { ...diag(), options: diag().options.filter(o => ['abandonner', 'simplifier'].includes(o.key)) } }), { answer: 'abandonner' }).ok === false, 'limite dont le menu ne propose que la clôture : aucune réponse acceptée');

  // 10c — the prompt shows only the allowed options and says why.
  const p = AA.answerPrompt(W, { guardrails, idleMin: 15, waitMin: 5 });
  ok(/PIPELINE LIMIT/.test(p) && /ONCE for this run/.test(p) && /NEVER choose an option that closes the run/.test(p), 'la consigne d’Opus annonce la limite, la réponse unique, l’interdiction de clore');
  ok(p.includes('« découper »') && p.includes('« prolonger »') && !p.includes('- « abandonner »') && !p.includes('- « changer le model »'), 'seules les options autorisées sont proposées à Opus');
  ok(/not allowed here/.test(AA.answerPrompt(limitWait(1, { d: diag('abandonner') }), { guardrails, idleMin: 15, waitMin: 5 })), 'recommandation « abandonner » de l’orchestrateur : non suivie, Opus choisit parmi les options autorisées');

  // 10d — once per run.
  const S = { ...AA.DEFAULT_SETTINGS, projects: [] };
  const now = Date.parse('2026-10-20T12:00:00Z');
  const idle = AA.idleInfo({ activity: { at: now - 30 * MIN }, now, settings: S });
  const due = (waits, ledger = []) => AA.dueWaits({ waits, now, idle, settings: S, ledger }).map(w => w.key);
  const second = limitWait(now - 6 * MIN, { limit: 'review', key: 'second' });
  const answered = [{ key: 'first', run: RUN, limitPause: true, status: 'applied', project: 'P', idleSince: 0 }];
  ok(due([second]).join() === 'second', 'première limite d’une exécution : due');
  ok(due([second], answered).length === 0, 'seconde limite de la même exécution : elle attend l’utilisateur');
  const cls = AA.classifyWaits({ waits: [second], settings: S, idle, ledger: answered });
  ok(cls.backlog[0]?.backlog === 'limite-deja-repondue' && /une fois/.test(cls.backlog[0].backlogText), 'listée dans l’arriéré avec sa raison', cls.backlog[0]);
  for (const st of ['failed', 'submitted', 'abandoned']) ok(due([second], [{ ...answered[0], status: st }]).join() === 'second', `une tentative « ${st} » (rien répondu) ne compte pas`);
  ok(due([limitWait(now - 6 * MIN, { run: 'p-20261020T130000-def456', key: 'other' })], answered).join() === 'other', 'une autre exécution garde sa réponse');
  ok(due([{ ...limitWait(now - 6 * MIN, { limit: 'doutes', key: 'doubt' }) }], answered).join() === 'doubt', 'une pause qui n’est pas une limite n’est pas concernée');
  const onlyClose = limitWait(now - 6 * MIN, { key: 'close', d: { ...diag(), options: diag().options.filter(o => o.key === 'abandonner') } });
  ok(AA.classifyWaits({ waits: [onlyClose], settings: S, idle }).backlog[0]?.backlog === 'limite-sans-choix', 'limite sans option autorisée : elle attend l’utilisateur');

  // 10e — end to end: return point, « 🤖 auto », once.
  {
    const t = engine('limit', { waitOf: (since) => limitWait(since), env: fakeEnv({ FAKE_CLAUDE_AUTO_ANSWER: JSON.stringify({ answer: 'découper — 19 tests pour 15 : une exécution plus courte reste vérifiable.', engages: [], concerns: [], safeAnswer: '', reason: 'recommandation suivie' }) }) });
    const rec = (await t.e.sweep()).answered;
    const text = t.calls.apply[0]?.final.text || '';
    ok(rec?.status === 'applied' && rec.limitPause && rec.pausedLimit === 'items' && rec.run === RUN, 'limite répondue à la place de l’utilisateur absent', rec);
    ok(text.startsWith('découper') && text.includes(AA.LIMIT_MARK) && rec.answer === text, `réponse envoyée : le mot du menu, marquée « ${AA.LIMIT_MARK} »`, text);
    ok(rec.recovery?.git?.tag === `auto-answer/${rec.id}` && git(t.proj, 'tag', '-l', rec.recovery.git.tag) === rec.recovery.git.tag, 'point de retour (tag git) créé avant d’appliquer', rec.recovery);
    ok(AA.decisionWhat(rec).startsWith('limite de pipeline') && /une seule réponse automatique par exécution/.test(AA.decisionText(rec)) && AA.decisionText(rec).startsWith(AA.MARK), 'carte : « limite de pipeline », la borne est dite', AA.decisionText(rec));
    ok(AA.limitAnswered(limitWait(Date.now(), { limit: 'review' }), AA.readLedger(t.logsDir)), 'le registre retient qu’une limite de cette exécution a reçu sa réponse');
  }
  {
    const t = engine('limit-abandon', { waitOf: (since) => limitWait(since), env: fakeEnv({ FAKE_CLAUDE_AUTO_ANSWER: JSON.stringify({ answer: 'abandonner', engages: [], safeAnswer: 'abandonner' }) }) });
    const rec = (await t.e.sweep()).answered;
    ok(rec?.status === 'failed' && t.calls.apply.length === 0, 'Opus répond « abandonner » : rien n’est envoyé', rec);
  }
  {
    const t = engine('limit-nogit', { repo: 'none', waitOf: (since) => limitWait(since), env: fakeEnv({ FAKE_CLAUDE_AUTO_ANSWER: JSON.stringify({ answer: 'prolonger', engages: [] }) }) });
    const rec = (await t.e.sweep()).answered;
    ok(rec?.status === 'submitted' && t.calls.apply.length === 0 && /point de retour obligatoire/.test(rec.why) && t.calls.report.length === 1, 'sans point de retour possible : rien n’est répondu, la limite est soumise à l’utilisateur', rec);
  }
  // 10f — decision 14 stays: the module never resumes a run by itself.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'auto-answer.mjs'), 'utf8');
  ok(!/pipeline-engine\.mjs/.test(src) && !/runPipeline|answerPausedRun/.test(src), 'la réponse automatique ne reprend jamais une exécution elle-même : elle répond à la question posée (décision 14 tenue)');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
