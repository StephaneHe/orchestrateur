#!/usr/bin/env node
// ============================================================================
// scripts/todo.mjs — the only writer of a musician's TODO_LIST.md (0.75.0)
// ============================================================================
//
// User request (2026-10-13): the TODO list is read-only for the user in the
// dashboard; the musician of the item ticks it, and its name is shown next to
// each done item. The name comes from the turn (ORCH_TURN_PROJECT, set by
// dispatch.mjs for every turn), never from an argument: outside a turn,
// `done` and `start` are refused. Format: scripts/todo-core.mjs.
//
//   node scripts/todo.mjs add [--type projet|fonctionnalite|correction|autre] "<titre>"
//   node scripts/todo.mjs start <id> | --match "<extrait du titre>"
//   node scripts/todo.mjs done  <id> | --match "<extrait du titre>"
//   node scripts/todo.mjs list [--json]
//   --project <p> : another project's list — the conductor only (chef).
// Exit codes: 0 ok · 2 item not found / ambiguous · 3 refused · 64 usage.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TODO_FILE, TODO_TYPES, parseTodo, sortTodo, addItem, setStatus } from './todo-core.mjs';
import { writeFileAtomic } from './atomic-file.mjs';

const ROOT = process.env.ORCH_TODO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const die = (code, msg) => { console.error(`[todo] ${msg}`); process.exit(code); };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function config() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (e) { die(3, `config.json illisible (${ROOT}) : ${e.message}`); }
}

/** Exclusive lock beside the file; a lock older than 30 s is taken over. */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (i > 200) die(3, `liste verrouillée (${lock})`);
      sleep(50);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

const cmd = argv[0];
if (!['add', 'start', 'done', 'list'].includes(cmd)) die(64, 'usage : todo.mjs add|start|done|list … (voir l’en-tête du script)');

const cfg = config();
const conductor = cfg.conductor || 'chef';
const turn = process.env.ORCH_TURN_PROJECT || null;
const asked = opt('--project');
if ((cmd === 'start' || cmd === 'done') && !turn) die(3, 'refusé : seul un musicien coche ses items, pendant son tour (l’utilisateur ne coche pas).');
if (asked && turn && asked !== turn && turn !== conductor) die(3, `refusé : ${turn} ne peut modifier que sa propre liste (seul le chef écrit dans celle d’un autre projet).`);
const projectName = asked || turn;
if (!projectName) die(64, 'projet inconnu : lancer depuis un tour, ou préciser --project');
const project = (cfg.projects || []).find(p => p && p.name === projectName);
if (!project?.path) die(3, `projet hors de config.json : ${projectName}`);
const file = path.join(project.path, TODO_FILE);
const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

if (cmd === 'list') {
  const items = sortTodo(parseTodo(read(), { project: projectName }));
  if (argv.includes('--json')) console.log(JSON.stringify(items, null, 2));
  else for (const i of items) console.log(`${i.status === 'done' ? '[x]' : i.status === 'progress' ? '[~]' : '[ ]'} ${i.id}  ${i.title}${i.doneBy ? `  (✓ ${i.doneBy})` : ''}`);
  process.exit(0);
}

const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !['--type', '--project', '--match'].includes(all[i - 1]));
// Checked before taking the lock: an exit inside it would leave the lock behind.
const type = opt('--type');
if (cmd === 'add' && type && !TODO_TYPES.includes(type)) die(64, `type inconnu : ${type} (${TODO_TYPES.join(', ')})`);
if (cmd === 'add' && !positional.join(' ').trim()) die(64, 'add : titre requis');
const ref = opt('--match') ? { match: opt('--match') } : { id: positional[0] };
if (cmd !== 'add' && !ref.id && !ref.match) die(64, `${cmd} : identifiant ou --match requis`);
try {
  const out = withLock(file, () => {
    const text = read();
    if (cmd === 'add') {
      const r = addItem(text, { title: positional.join(' '), type });
      writeFileAtomic(file, r.text, `${file}.${process.pid}.tmp`);
      return `ajouté ${r.id}`;
    }
    const next = setStatus(text, ref, cmd === 'done' ? 'done' : 'progress', { by: turn, project: projectName });
    writeFileAtomic(file, next, `${file}.${process.pid}.tmp`);
    return cmd === 'done' ? `coché par ${turn}` : 'en cours';
  });
  console.log(`[todo] ${projectName} : ${out}`);
} catch (e) {
  die(/aucun item|items correspondent/.test(e.message) ? 2 : 3, e.message);
}
