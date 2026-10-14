#!/usr/bin/env node
// ============================================================================
// scripts/_test_context_calibration.mjs — the context sent with each model
// request is calibrated to what the task needs (0.99.0)
// ============================================================================
//
// User, verbatim (2026-10-13, TODO t-182fa2): « Il faut qu'on mette en place
// une gestion plus fine des contextes : a chaque requete, il faut que soit fait
// un travail sur le context necessaire et minimal a envoyer a chaque requete
// vers un model. » Precision (2026-10-14): « Le model au moment de faire le
// travail, que ce soit de conception ou de developpement, n'a pas besoin de
// connaitre tout le context du projet la plus part du temps, sauf cas
// particulier qu'il faut identifier. Il faut que le context de chaque requete
// soit calibre exactement pour avoir toutes les infos dont le model a besoin,
// mais pas fiorcement l'historique, par exemple, de tous les developpements
// differents. Sauf peut-etre si ces developpements font parti de la meme tache
// initiale »
//
// Protected:
//   1. the decision (sessionDecision): a new task from the chef starts a FRESH
//      session (no history of the other developments); the same task resumes
//      it — Routage mark « meme_tache », the musician waiting for its own
//      question's answer, the chef's answer, a direct dialogue; a session too
//      long starts fresh with the current task regenerated (taskBrief);
//   2. end to end with the real dispatch.mjs and a claude double: the
//      --resume argument is passed or not as above, the old session is
//      archived (never deleted), the log says why (user_prompt.context), the
//      regenerated context reaches the model but not the thread;
//   3. pipeline: one session per item for 4a/4b/4c, per reviewed group for the
//      review, its own for Livrer; a Development/Discussion step only gets the
//      rules it can use;
//   4. Routage: « meme_tache » validated, carried to --meme-tache, also through
//      the server's queue.
//
//   node scripts/_test_context_calibration.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as CP from './context-policy.mjs';
import * as E from './pipeline-engine.mjs';
import * as RP from './routage-pending.mjs';
import { catalogSteps } from './pipeline-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
section('1. La décision : reprendre la session seulement pour la même tâche');
{
  const d = (o) => CP.sessionDecision({ hasSession: true, maxTokens: 150_000, ...o });
  ok(!d({ source: 'chef' }).resume && /nouvelle tâche/.test(d({ source: 'chef' }).reason), 'nouvelle tâche venue du chef : session neuve (sans l’historique des autres développements)');
  ok(d({ source: 'chef', sameTask: true }).resume, 'marquée « meme_tache » par le Routage : session reprise');
  ok(d({ source: 'chef', state: 'input' }).resume, 'le musicien attendait la réponse à sa question : reprise');
  ok(d({ source: 'chef', prompt: '[CHEF_ANSWER] oui' }).resume && d({ source: 'chef', awaitingChef: true }).resume, 'réponse du chef à sa question : reprise');
  ok(d({ source: null }).resume, 'dialogue direct de l’utilisateur avec le musicien : reprise (cas particulier)');
  ok(d({ source: 'chef', forceResume: true }).resume && !d({ forceNew: true }).resume, '--resume-session / --new-session : forçage explicite');
  const big = d({ source: null, contextTokens: 900_000 });
  ok(!big.resume && big.regenerate && /trop longue/.test(big.reason), 'même tâche mais session trop longue : session neuve + contexte régénéré');
  ok(!d({ source: 'chef', contextTokens: 900_000 }).regenerate, 'nouvelle tâche : rien à régénérer');
  ok(!CP.sessionDecision({ hasSession: false, sameTask: true }).resume, 'pas de session : rien à reprendre');
  ok(CP.contextMaxTokens({ ORCH_CONTEXT_MAX_TOKENS: '5000' }) === 5000 && CP.contextMaxTokens({}) === 150_000, 'seuil réglable (ORCH_CONTEXT_MAX_TOKENS), 150 000 par défaut');
  const lines = [JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 5000 } } }), JSON.stringify({ type: 'result', usage: { cache_read_input_tokens: 9e9 } })];
  ok(CP.lastContextTokens(lines) === 905_002, 'taille du contexte = celle de la DERNIÈRE requête au model (pas le cumul du result)');
  const L = (o) => JSON.stringify(o);
  const brief = CP.taskBrief([L({ type: 'user_prompt', text: 'VIEILLE-TACHE' }), L({ type: 'result', result: 'vieux' }),
    L({ type: 'user_prompt', text: 'T1' }), L({ type: 'result', result: 'R1' }), L({ type: 'user_prompt', text: 'T2' }), L({ type: 'result', result: 'R2' }),
    L({ type: 'user_prompt', text: 'T3' }), L({ type: 'result', result: 'R3' })], { turns: 3 });
  ok(/CONTEXTE RÉGÉNÉRÉ/.test(brief) && ['T1', 'R1', 'T2', 'R2', 'T3', 'R3'].every(s => brief.includes(s)) && !brief.includes('VIEILLE-TACHE'), 'contexte régénéré : les derniers échanges de la tâche, pas le reste de la session');
}

// ---------------------------------------------------------------------------
section('2. Bout en bout : vrai dispatch.mjs, doublure de claude');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-context-'));
const PROJ = path.join(T, 'proj');
fs.mkdirSync(path.join(T, 'logs'), { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', defaults: { model: 'claude-opus-4-8', allowedTools: 'Read', provider: 'claude' },
  projects: [{ name: 'chef', path: PROJ }, { name: 'M', path: PROJ }] }));
const STUB = path.join(T, 'claude-stub.mjs');
const ARGS = path.join(T, 'args.json');
fs.writeFileSync(STUB, `
const a = process.argv.slice(2);
let stdin = ''; try { stdin = (await import('node:fs')).default.readFileSync(0, 'utf8'); } catch {}
(await import('node:fs')).default.writeFileSync(process.env.STUB_ARGS, JSON.stringify({ a, stdin }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'sid-new', model: 'claude-opus-4-8' });
out({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'fait' }], usage: { input_tokens: 10 } }, session_id: 'sid-new' });
out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_api_ms: 10, result: 'fait', session_id: 'sid-new' });
`);
const LOG = path.join(T, 'logs', 'M.jsonl'), SESS = path.join(T, 'logs', 'M.session');
const backups = () => fs.readdirSync(path.join(T, 'logs')).filter(f => f.startsWith('M.session.bak-'));
const prime = (history) => {
  for (const f of fs.readdirSync(path.join(T, 'logs'))) fs.rmSync(path.join(T, 'logs', f), { force: true, recursive: true });
  fs.writeFileSync(SESS, 'old-sid');
  fs.writeFileSync(LOG, history.map(e => JSON.stringify(e)).join('\n') + '\n');
};
function run(extra, text = 'fais la tâche', env = {}) {
  const r = spawnSync(process.execPath, [DISPATCH, 'M', ...extra, text], { cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ANTHROPIC_API_KEY: '', DISPATCH_SLOT: '', DISPATCH_TICKET: '', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9',
      ORCH_NO_PENDING_RELEASE: '1', DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: STUB, STUB_ARGS: ARGS, ...env } });
  let got = { a: [], stdin: '' }; try { got = JSON.parse(fs.readFileSync(ARGS, 'utf8')); } catch {}
  fs.rmSync(ARGS, { force: true });
  const evs = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
  const up = evs.filter(e => e.type === 'user_prompt').pop();
  const resumed = got.a.includes('--resume') ? got.a[got.a.indexOf('--resume') + 1] : null;
  return { code: r.status, out: `${r.stdout}${r.stderr}`, resumed, up, sent: `${got.a.join(' ')}\n${got.stdin}` };
}
const done = [{ type: 'user_prompt', text: 'ANCIENNE-TACHE : refaire le menu' }, { type: 'system', subtype: 'init' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'menu refait' }], usage: { input_tokens: 2, cache_read_input_tokens: 40_000 } } },
  { type: 'result', subtype: 'success', num_turns: 3, duration_api_ms: 900, result: 'menu refait' }];
{
  prime(done);
  let x = run(['--source', 'chef'], 'Nouvelle tâche : ajouter un export CSV');
  ok(x.code === 0 && x.resumed === null, `nouvelle tâche du chef : PAS de --resume (${x.resumed})`, x.out.slice(-500));
  ok(backups().length === 1 && fs.readFileSync(path.join(T, 'logs', backups()[0]), 'utf8') === 'old-sid', 'l’ancienne session est archivée, jamais effacée');
  ok(x.up?.context?.resume === false && /nouvelle tâche/.test(x.up.context.reason), 'le log dit pourquoi (user_prompt.context)', JSON.stringify(x.up?.context));
  ok(fs.readFileSync(SESS, 'utf8') === 'sid-new', 'la session du nouveau tour devient la courante (la suite de cette tâche la reprendra)');

  prime(done);
  x = run(['--source', 'chef', '--meme-tache'], 'Corrige l’export CSV que tu viens de livrer');
  ok(x.resumed === 'old-sid' && x.up?.context?.resume === true && backups().length === 0, 'tâche marquée « meme_tache » : --resume old-sid, rien archivé');

  prime([...done.slice(0, 2), { type: 'assistant', message: { content: [{ type: 'text', text: 'Quel format ?\nNEEDS_USER_INPUT: CSV ou JSON ?' }] } },
    { type: 'result', subtype: 'success', num_turns: 2, duration_api_ms: 50, result: 'Quel format ?\nNEEDS_USER_INPUT: CSV ou JSON ?' }]);
  x = run(['--source', 'chef'], 'Réponse : CSV');
  ok(x.resumed === 'old-sid' && /question/.test(x.up?.context?.reason || ''), 'le musicien attendait la réponse à sa question : session reprise', JSON.stringify(x.up?.context));

  prime(done);
  x = run(['--source', 'chef'], '[CHEF_ANSWER] Oui, garde le format actuel.');
  ok(x.resumed === 'old-sid', 'réponse du chef ([CHEF_ANSWER]) : session reprise');

  prime(done);
  x = run([], 'Et ajoute aussi le pied de page');
  ok(x.resumed === 'old-sid' && /dialogue direct/.test(x.up?.context?.reason || ''), 'dialogue direct de l’utilisateur : session reprise');

  prime([...done.slice(0, 2), { type: 'assistant', message: { content: [{ type: 'text', text: 'menu refait' }], usage: { input_tokens: 2, cache_read_input_tokens: 900_000 } } }, done[3]]);
  x = run([], 'Et ajoute aussi le pied de page');
  ok(x.resumed === null && x.up?.context?.regenerated === true && /trop longue/.test(x.up.context.reason), 'session trop longue (900 000 tokens) : session neuve', JSON.stringify(x.up?.context));
  ok(/CONTEXTE RÉGÉNÉRÉ/.test(x.sent) && x.sent.includes('ANCIENNE-TACHE') && x.sent.includes('menu refait'), 'le model reçoit le contexte de la tâche, régénéré depuis le log');
  ok(!/CONTEXTE RÉGÉNÉRÉ/.test(x.up?.text || ''), 'le fil ne l’affiche pas (texte de la demande inchangé)');

  prime(done);
  x = run(['--source', 'chef', '--resume-session'], 'Nouvelle tâche, mais reprise demandée');
  ok(x.resumed === 'old-sid', '--resume-session force la reprise');
}

// ---------------------------------------------------------------------------
section('3. Pipelines : une session par item, consignes utiles seulement');
{
  const dev = (id) => ({ id, group: { comprendre: 'analyse', concevoir: 'analyse', 'liste-tests': 'tests', rouge: 'tests', vert: 'code', refactor: 'code', revue: 'revue', livrer: 'code' }[id] });
  const g = (id, o = {}) => CP.stepSessionGroup({ step: dev(id), model: 'claude-opus-5-5', ...o });
  ok(g('rouge', { item: { n: 1 } }) !== g('rouge', { item: { n: 2 } }) && g('vert', { item: { n: 2 } }).startsWith('code-i2-'), '4a/4b/4c : une session par item (l’item 2 ne relit pas les échanges de l’item 1)');
  ok(g('revue', { reviewGroup: 3 }).startsWith('revue-g3-'), 'revue : une session par groupe relu');
  ok(g('livrer').startsWith('livrer-') && g('livrer') !== g('vert', { item: { n: 1 } }), 'Livrer : sa propre session (artefacts et diff, pas l’historique du code)');
  ok(g('comprendre') === g('concevoir'), 'Comprendre et Concevoir partagent leur session (même travail d’analyse)');
  ok(['rouge', 'vert', 'revue', 'livrer'].every(id => /^[a-z0-9-]{1,40}$/.test(g(id, { item: { n: 12 }, reviewGroup: 12 }))), 'noms acceptés par dispatch.mjs (--pipeline-session)');
  ok(CP.stepRules('concevoir').join() === 'background,commands' && CP.stepRules('rouge').includes('requirements') && !CP.stepRules('vert').includes('todo'), 'consignes : Concevoir n’a ni TODO ni exigences ; 4a a la règle des exigences');
  ok(CP.stepRules('reproduire').length === 5, 'étape d’un autre pipeline : toutes les consignes (jamais sous-informer)');
  const ENG = fs.readFileSync(path.join(ROOT, 'scripts', 'pipeline-engine.mjs'), 'utf8');
  ok(/const sessionGroup = stepSessionGroup\(\{ step, model: info\.model, item: ctx\.item/.test(ENG), 'le moteur nomme les sessions d’étape par stepSessionGroup');
  const D = fs.readFileSync(DISPATCH, 'utf8');
  ok(/if \(PIPE_STEP && projectName !== CONDUCTOR\) \{\s*const \{ stepRules \}/.test(D), 'dispatch.mjs applique stepRules aux tours d’étape');
}

// ---------------------------------------------------------------------------
section('4. Routage : « meme_tache » jusqu’au lancement, file comprise');
{
  const t = (o) => [{ projet: 'M', titre: 'export CSV', demande: 'Corrige l’export.', ...o }];
  ok(E.validateUnitTasks(T, t({ meme_tache: true })) === null, 'meme_tache: true accepté');
  ok(/« meme_tache » doit valoir true/.test(E.validateUnitTasks(T, t({ meme_tache: 'oui' })) || ''), 'valeur non booléenne refusée');
  ok(/« meme_tache » et « session_neuve » s’excluent/.test(E.validateUnitTasks(T, t({ meme_tache: true, session_neuve: true })) || ''), 'incompatible avec session_neuve');
  const dec = catalogSteps('routage').find(s => s.id === 'decomposer');
  ok(/MÊME TÂCHE/.test(dec.role) && /session NEUVE/.test(dec.role) && /"meme_tache"/.test(dec.jsonExample), 'consigne et exemple JSON de Découper');
  const REC = path.join(T, 'rec.mjs'), RECF = path.join(T, 'rec.ndjson');
  fs.writeFileSync(REC, "import fs from 'node:fs';\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{fs.appendFileSync(process.env.REC_FILE, JSON.stringify(process.argv.slice(2))+'\\n');});\n");
  process.env.REC_FILE = RECF;
  RP.launchTask(T, { projet: 'M', titre: 'suite', demande: 'Suite', memeTache: true }, REC);
  RP.launchTask(T, { projet: 'M', titre: 'neuve', demande: 'Neuve' }, REC);
  let l = [];
  for (let i = 0; i < 50 && l.length < 2; i++) { await sleep(100); try { l = fs.readFileSync(RECF, 'utf8').trim().split('\n').map(x => JSON.parse(x)); } catch {} }
  ok(l.some(a => a.includes('--meme-tache')) && l.some(a => !a.includes('--meme-tache')), 'launchTask : --meme-tache seulement pour la tâche marquée');
  const S = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/sameTask: req\.body\?\.sameTask === true/.test(S) && /if \(opts\.sameTask\) args\.push\('--meme-tache'\)/.test(S) && /payload\.sameTask = true/.test(fs.readFileSync(DISPATCH, 'utf8')), 'musicien occupé : la marque voyage dans la file et revient en --meme-tache au lancement');
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
