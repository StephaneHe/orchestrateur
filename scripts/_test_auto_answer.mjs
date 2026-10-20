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
function engine(name, { activityAgoMin = 20, waitAgoMin = 6, enabled = true, env = fakeEnv(), repo = 'git', runModel = null, kind = 'question' } = {}) {
  const root = freshRoot(name);
  const logsDir = path.join(root, 'logs');
  if (!enabled) AA.writeSettings(root, { enabled: false });
  AA.recordActivity(logsDir, { kind: 'message' }, Date.now() - activityAgoMin * MIN);
  const proj = repo === 'git' ? gitRepo(path.join(root, 'proj')) : path.join(root, 'nogit');
  fs.mkdirSync(proj, { recursive: true });
  if (repo === 'git') fs.writeFileSync(path.join(proj, 'a.txt'), 'v1 + travail non commité\n');
  const wait = kind === 'permission'
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
  fs.writeFileSync(routing, JSON.stringify({ version: 2, custom: { attach: [{ pipeline: 'dev', when: 'a' }, { pipeline: 'dev', when: 'ajout' }] }, gapDecisions: { k: { decision: 'accepted' }, other: { decision: 'rejected' } } }));
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

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
