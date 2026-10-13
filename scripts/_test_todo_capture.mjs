#!/usr/bin/env node
// ============================================================================
// scripts/_test_todo_capture.mjs — « TODO: » lines go to the TODO list, by the
// router's code (0.84.0)
// ============================================================================
// User request (2026-10-13, verbatim): « Dans ma requete, si je commence par
// TODO: , alors ce qui suit doit etre ajoute dans la todo list. Ce doit etre
// une fonctionalite codee dans le routeur. »
// Checks: the parser (TODO:, TODO :, any case; only line starts), the write in
// the chef's TODO_LIST.md (dated, verbatim, todo.mjs format), and the REAL
// dispatch.mjs: a message of TODO lines only ends with no model at all (plain
// chef and chef in Routage), a mixed message routes the rest only, a callback
// or a musician's message is untouched, a failed write loses nothing.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitTodoLines, captureTodos } from './todo-capture.mjs';
import { parseTodo } from './todo-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

section('1. Parser: « TODO: » at the start of a line, any case, spaces around the colon');
let s = splitTodoLines('TODO: Acheter du pain\nTODO : Relire la doc\ntodo:appeler Paul\n  Todo :  vérifier « ceci » & cela  \nTODO:\nTODOS: pas ça\nFaire TODO: pas ça non plus\nQuestion normale ?');
ok(JSON.stringify(s.todos) === JSON.stringify(['Acheter du pain', 'Relire la doc', 'appeler Paul', 'vérifier « ceci » & cela']), `lignes reconnues : ${JSON.stringify(s.todos)}`);
ok(s.rest === 'TODOS: pas ça\nFaire TODO: pas ça non plus\nQuestion normale ?', `le reste, intact : ${JSON.stringify(s.rest)}`);
s = splitTodoLines('Bonjour\nquelle est la météo ?');
ok(s.todos.length === 0 && s.rest === 'Bonjour\nquelle est la météo ?', 'sans préfixe : rien de capturé');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-todocap-'));
try {
  section('2. Write: chef’s TODO_LIST.md, dated, verbatim, todo.mjs format, existing items kept');
  const D = path.join(T, 'direct');
  fs.mkdirSync(D);
  fs.writeFileSync(path.join(D, 'TODO_LIST.md'), '# TODO\n\n- [ ] (2026-10-01 09:00) Ancien item <!-- id:t-000001 -->\n');
  const added = captureTodos(D, ['Acheter du pain', 'vérifier « ceci » & cela'], { now: new Date(2026, 9, 13, 18, 30) });
  const items = parseTodo(fs.readFileSync(path.join(D, 'TODO_LIST.md'), 'utf8'), { project: 'chef' });
  ok(added.length === 2 && added.every(a => /^t-[0-9a-f]{6}$/.test(a.id)), `identifiants : ${JSON.stringify(added)}`);
  ok(items.length === 3 && items[0].title === 'Ancien item', 'l’item existant est gardé');
  ok(items[1].title === 'Acheter du pain' && items[2].title === 'vérifier « ceci » & cela' && items[1].status === 'todo', `textes verbatim, non faits : ${items.slice(1).map(i => i.title).join(' | ')}`);
  ok(items[1].addedAt === '2026-10-13T18:30' && !items[1].addedEstimated, `daté : ${items[1].addedAt}`);
  ok(!fs.existsSync(path.join(D, 'TODO_LIST.md.lock')), 'verrou libéré');

  section('3. Real dispatch.mjs (claude double, throw-away root)');
  for (const d of ['logs', 'chef', 'P']) fs.mkdirSync(path.join(T, d), { recursive: true });
  const CHEF_LIST = path.join(T, 'chef', 'TODO_LIST.md');
  fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef (doublure)\n');
  fs.writeFileSync(path.join(T, 'P', 'CLAUDE.md'), '# P\n');
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
    conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
    projects: ['chef', 'P'].map(n => ({ name: n, path: path.join(T, n) })),
  }));
  const DUMP = path.join(T, 'prompts.ndjson');
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9',
    ORCH_NO_PENDING_RELEASE: '1', FAKE_CLAUDE_DUMP_PROMPT: DUMP, FAKE_CLAUDE_REPLY: 'Réponse du chef de recette, en français, assez longue pour le contrôle de langue.' };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'ORCH_TEST_LABEL', 'CODEX_HOME']) delete env[k];
  const logOf = (n) => { try { return fs.readFileSync(path.join(T, 'logs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const prompts = () => { try { return fs.readFileSync(DUMP, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).prompt); } catch { return []; } };
  const listTitles = () => { try { return parseTodo(fs.readFileSync(CHEF_LIST, 'utf8'), { project: 'chef' }).map(i => i.title); } catch { return []; } };
  function turn(project, text, extra = [], extraEnv = {}) {
    const n0 = logOf(project).length, p0 = prompts().length;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), project, text, '--test', 'todo-capture', ...extra],
      { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, evs: logOf(project).slice(n0), sent: prompts().slice(p0) };
  }

  // a. Only TODO lines: written by code, no model turn at all.
  let x = turn('chef', 'TODO: Préparer la démo du vendredi\nTODO : relancer le fournisseur');
  ok(x.code === 0, `sortie 0`, x.out.slice(-600));
  ok(listTitles().join(' | ') === 'Préparer la démo du vendredi | relancer le fournisseur', `ajoutés à la liste du chef : ${listTitles().join(' | ')}`);
  ok(x.sent.length === 0 && !x.evs.some(e => e.type === 'system' && e.subtype === 'init'), 'aucun tour de model');
  const res = x.evs.filter(e => e.type === 'result').pop();
  ok(x.evs.some(e => e.type === 'system' && e.subtype === 'todo_capture' && e.items?.length === 2) && res?.todo_capture === true && !res.is_error
    && /Ajoutés à la TODO list \(chef\/TODO_LIST\.md\)/.test(res.result) && /Préparer la démo du vendredi/.test(res.result), `journal : capture, réponse et result clos (${res?.result})`);
  ok(x.evs.some(e => e.type === 'user_prompt' && /TODO: Préparer la démo/.test(e.text)), 'le message de l’utilisateur reste visible dans le fil');

  // b. Mixed: the TODO line is captured, only the rest reaches the model.
  x = turn('chef', 'Quel est l’état de la flotte ?\nTODO: Acheter des cartouches');
  ok(x.code === 0 && listTitles().includes('Acheter des cartouches'), 'ligne TODO du message mixte ajoutée', x.out.slice(-600));
  const sent = x.sent.join('\n');
  ok(x.sent.length >= 1 && /Quel est l’état de la flotte \?/.test(sent) && !/TODO: Acheter des cartouches/.test(sent) && /\[Routeur\] 📝 Ajouté à la TODO list/.test(sent),
    `le model reçoit le reste, avec la mention du routeur : ${JSON.stringify(sent.slice(0, 300))}`);

  // c. A callback / relay (--source) is never captured.
  const n = listTitles().length;
  x = turn('chef', 'TODO: ne pas capturer (callback)', ['--source', 'P']);
  ok(listTitles().length === n, 'message sourcé (callback, relais) : rien capturé');
  // d. Only the chef's router does it: a message to a musician is untouched.
  x = turn('P', 'TODO: ne pas capturer (musicien)');
  ok(listTitles().length === n && !fs.existsSync(path.join(T, 'P', 'TODO_LIST.md')), 'message à un musicien : rien capturé');

  // e. Chef in Routage: TODO lines only ⇒ no Routage run, no model.
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, history: [], enforcement: { projects: [], pipelines: ['discussion'], chef: true }, assignments: {} }, null, 2));
  x = turn('chef', 'todo: Ranger le garage');
  ok(x.code === 0 && listTitles().includes('Ranger le garage') && x.sent.length === 0 && !x.evs.some(e => e.type === 'user_prompt' && e.pipeline) && !fs.existsSync(path.join(T, 'logs', 'runs')),
    'chef en Routage : capturé par le code, aucune exécution du Routage', x.out.slice(-600));
  fs.rmSync(path.join(T, 'model-routing.json'), { force: true });

  // f. A failed write loses nothing: the whole message goes on, with the reason.
  fs.writeFileSync(CHEF_LIST + '.lock', 'autre');
  const before = listTitles().length;
  x = turn('chef', 'TODO: item impossible à écrire');
  fs.rmSync(CHEF_LIST + '.lock', { force: true });
  ok(listTitles().length === before && x.sent.some(p => /TODO: item impossible à écrire/.test(p) && /\[Routeur\] ✕ TODO non ajouté/.test(p)),
    'écriture impossible : le message entier part au chef avec la raison', x.out.slice(-600));
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
