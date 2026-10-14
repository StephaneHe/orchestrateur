// ============================================================================
// scripts/request-map.mjs — from each user request to its atomic tasks, and the
// live state of every task, even detached ones (0.100.0)
// ============================================================================
//
// User request (2026-10-14): « Je parle de voir comment une requete utilisateur
// a ete decoupee en taches atomiques, et voir le progres de ces taches, meme
// detachees. On avait fait le contstat qu'elles n'etaient pas visible
// actuellement ».
//
// A user request to the chef is one run of the Routage pipeline
// (logs/runs/<run>/run.json: `request`, `tasks` once classified). Its artefacts
// (<chef>/.orchestrateur/runs/<run>/) say what became of each task:
// dispatch.json (launched: project, log offset, text fingerprint; waiting;
// duplicates; chef actions; hand-back to the chef). After the chef's turn the
// tasks live on elsewhere — a musician's queue, logs/routage-pending.json, the
// musician's log, a pipeline run — and nothing linked them back. This module
// follows each task to where it is NOW, read-only, without any model:
//   - launched → its turn in the musician's log, found by the fingerprint of
//     its whole text after the launch offset (the same rule as the dependency
//     release), else its queue entry, else the launching process;
//   - waiting for another task → logs/routage-pending.json, then, once
//     released, logs/routage-released.ndjson (written by releaseReady) gives
//     the launch offset and fingerprint, and the turn is followed like above;
//   - a turn that runs a pipeline → that run's own state (steps done, paused,
//     done), so a task resumed later is still followed;
//   - hand-back to the chef → the chef's « [RENVOI_CHEF <run>] » turn;
//   - chef action, question, gap, duplicate → what the Routage recorded.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { textHash, readPending, idOf, cleanTitle, RELEASED_FILE } from './routage-pending.mjs';

export { RELEASED_FILE };
const RUN_RE = /^p-\d{8}T\d{6}-[0-9a-f]{6}$/;

// State of a task, the words shown to the user, and its tone (CSS family).
export const TASK_STATES = {
  attente:     { label: 'en attente d’une autre tâche', tone: 'wait' },
  bloquee:     { label: 'bloquée', tone: 'bad' },
  file:        { label: 'en file chez le musicien', tone: 'wait' },
  lancee:      { label: 'lancée, pas encore commencée', tone: 'wait' },
  en_cours:    { label: 'en cours', tone: 'live' },
  pause:       { label: 'en pause (pipeline)', tone: 'input' },
  question:    { label: 'question posée', tone: 'input' },
  terminee:    { label: 'terminée', tone: 'ok' },
  echouee:     { label: 'échouée', tone: 'bad' },
  arretee:     { label: 'arrêtée', tone: 'neutral' },
  abandonnee:  { label: 'abandonnée', tone: 'neutral' },
  renvoyee:    { label: 'renvoyée au chef', tone: 'chef' },
  action:      { label: 'action du chef', tone: 'chef' },
  non_lancee:  { label: 'non dispatchée', tone: 'neutral' },
  doublon:     { label: 'écartée (doublon)', tone: 'neutral' },
  a_dispatcher:{ label: 'pas encore dispatchée', tone: 'wait' },
  introuvable: { label: 'lancée, introuvable', tone: 'bad' },
};
const TERMINAL = new Set(['terminee', 'echouee', 'arretee', 'abandonnee', 'non_lancee', 'doublon', 'action']);

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const flat = (s, max = 400) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const isPhantom = (e) => !e.synthetic && e.num_turns === 0 && e.duration_api_ms === 0;

function conductorOf(root) { return readJson(path.join(root, 'config.json'))?.conductor || 'chef'; }
function projectPath(root, name) {
  const p = (readJson(path.join(root, 'config.json'))?.projects || []).find(x => x.name === name);
  return p?.path || null;
}

// --- reading a musician's log from a byte offset ---------------------------
const CHUNK = 4 * 1024 * 1024;
const MAX_SCAN = 96 * 1024 * 1024;
/** Calls fn(line, byteStart) for each complete line from `from`; stops when fn returns true. */
function scanLines(file, from, fn, maxBytes = MAX_SCAN) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    const size = fs.fstatSync(fd).size;
    let pos = Math.max(0, Math.min(from, size));
    const end = Math.min(size, pos + maxBytes);
    let carry = Buffer.alloc(0), carryAt = pos;
    while (pos < end) {
      const len = Math.min(CHUNK, end - pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const data = carry.length ? Buffer.concat([carry, buf]) : buf;
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 10) continue;
        if (fn(data.toString('utf8', start, i), carryAt + start)) return;
        start = i + 1;
      }
      carry = data.subarray(start); carryAt += start;
      pos += len;
    }
  } finally { try { fs.closeSync(fd); } catch {} }
}

// Terminal outcomes never change: kept so an old request is read once.
const turnCache = new Map();

/**
 * The turn of a task in `projet`'s log: the first turn-opening user_prompt
 * after `offset` whose whole-text fingerprint is `hash` (or that `match`es),
 * then what that turn became. null when no such prompt exists (yet).
 */
export function findTurn(logsDir, projet, { hash = null, match = null, offset = null, since = null, exclusive = true } = {}) {
  const file = path.join(logsDir, `${projet}.jsonl`);
  const ck = `${projet}|${hash || ''}|${offset}|${since || ''}|${match ? 'm' : ''}`;
  const cached = turnCache.get(ck);
  if (cached?.terminal) return cached.turn;
  // No launch offset (hand-back turn): the last 32 MiB, filtered by `since`.
  let start = Number.isFinite(offset) && offset >= 0 ? offset : null;
  if (start == null) { try { start = Math.max(0, fs.statSync(file).size - 32 * 1024 * 1024); } catch { return null; } }
  if (cached?.promptAt != null) start = cached.promptAt;
  let prompt = null, promptAt = null, turnId = null;
  const ev = { result: null, lastText: null, pipelineRun: null, lastAt: null, events: 0, laterTurn: false };
  scanLines(file, start, (line, at) => {
    if (!line.includes('"type"')) return false;
    let e; try { e = JSON.parse(line); } catch { return false; }
    if (!prompt) {
      if (e.type !== 'user_prompt' || typeof e.text !== 'string') return false;
      if (since && e.timestamp && e.timestamp < since) return false;
      const ok = match ? match(e) : (hash && textHash(e.text) === hash);
      if (!ok) return false;
      prompt = e; promptAt = at; turnId = e.orch_turn || null;
      ev.pipelineRun = e.pipeline?.run || null;
      ev.lastAt = e.timestamp || null;
      return false;
    }
    // Lines of this turn: same turn id (0.67.0); older logs: until the next
    // turn-opening prompt. A musician runs one turn at a time (turn lock): a
    // later turn opening means this one ended without a result (killed,
    // session cut). The chef runs several turns at once: not for it.
    const opens = e.type === 'user_prompt' && (!e.source || e.pipeline || e.callback);
    if (turnId ? e.orch_turn !== turnId : opens) {
      if (exclusive && opens) { ev.laterTurn = true; return true; }
      return !turnId;
    }
    ev.events++;
    if (e.timestamp) ev.lastAt = e.timestamp;
    if (e.type === 'assistant') {
      const txt = (e.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      if (txt) ev.lastText = txt;
    }
    if (e.type === 'system' && e.pipeline?.run && !ev.pipelineRun) ev.pipelineRun = e.pipeline.run;
    if (e.type === 'result' && !isPhantom(e)) { ev.result = e; return true; }
    return false;
  });
  if (!prompt) { turnCache.set(ck, { promptAt: null }); return null; }
  const turn = { at: prompt.timestamp || null, promptAt, turnId, pipelineRun: ev.pipelineRun, result: ev.result, lastText: ev.lastText, lastAt: ev.lastAt, interrupted: !ev.result && ev.laterTurn };
  const terminal = (!!ev.result || ev.laterTurn) && !ev.pipelineRun;
  turnCache.set(ck, { promptAt, terminal, turn });
  return turn;
}

/** State of a pipeline run started by a task's turn (followed even after the turn). */
export function pipelineRunState(logsDir, run) {
  if (!run || !RUN_RE.test(run)) return null;
  const st = readJson(path.join(logsDir, 'runs', run, 'run.json'));
  if (!st) return null;
  // `plan` is the list of step ids (markers « @… » are the engine's own), and
  // `index` the position reached: progress is read there, not in `steps`
  // (which lists every attempt, refused ones included).
  const plan = (st.plan || []).map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
  const real = plan.filter(id => !id.startsWith('@'));
  const index = Number.isInteger(st.index) ? st.index : 0;
  const done = st.status === 'done' ? real.length : plan.slice(0, index).filter(id => !id.startsWith('@')).length;
  const current = st.status === 'done' ? null : plan.slice(index).find(id => !id.startsWith('@')) || null;
  return { run, pipeline: st.pipeline || null, mode: st.mode || null, status: st.status || null, steps: real.length, done,
    current, pausedFor: st.pausedLimit || null, updatedAt: st.updatedAt || null };
}

/** What a found turn says about the task. */
function fromTurn(logsDir, turn) {
  const pr = turn.pipelineRun ? pipelineRunState(logsDir, turn.pipelineRun) : null;
  const base = { since: turn.at, lastAt: turn.lastAt, ...(pr ? { pipelineRun: pr } : {}) };
  // A pipeline run is followed to its own end (a later « continuer » resumes it).
  if (pr) {
    if (pr.status === 'done') return { state: 'terminee', ...base, detail: `pipeline ${pr.pipeline} terminé (${pr.done}/${pr.steps} étapes)` };
    if (pr.status === 'paused') return { state: 'pause', ...base, detail: `pipeline ${pr.pipeline} en pause${pr.current ? ` à l’étape « ${pr.current} »` : ''} (${pr.done}/${pr.steps})` };
    if (pr.status === 'abandoned') return { state: 'abandonnee', ...base, detail: `pipeline ${pr.pipeline} abandonné` };
    if (pr.status === 'failed') return { state: 'echouee', ...base, detail: `pipeline ${pr.pipeline} en échec` };
    if (pr.status === 'interrupted') return { state: 'arretee', ...base, detail: `pipeline ${pr.pipeline} interrompu (${pr.done}/${pr.steps} étapes)` };
    if (!turn.result) return { state: 'en_cours', ...base, detail: `pipeline ${pr.pipeline} : ${pr.done}/${pr.steps} étapes${pr.current ? `, « ${pr.current} » en cours` : ''}` };
  }
  const r = turn.result;
  if (!r && turn.interrupted) return { state: 'arretee', ...base, detail: 'tour interrompu sans résultat (un tour suivant a commencé)' };
  if (!r) return { state: 'en_cours', ...base, detail: turn.lastText ? flat(turn.lastText.split('\n').pop(), 200) : 'tour démarré' };
  const text = typeof r.result === 'string' ? r.result : '';
  const end = { ...base, endedAt: r.timestamp || turn.lastAt, excerpt: flat(text, 600) };
  if (r.stopped_by || r.subtype === 'error_killed_by_conductor') return { state: 'arretee', ...end, detail: `arrêtée${r.stopped_by ? ` par ${r.stopped_by}` : ''}${r.reason ? ` — ${flat(r.reason, 160)}` : ''}` };
  if (r.is_error || String(r.subtype || '').startsWith('error')) return { state: 'echouee', ...end, detail: flat(text || r.subtype, 200) };
  const q = text.match(/NEEDS_(USER|CHEF)_INPUT:\s*([\s\S]*)$/);
  if (q) return { state: 'question', ...end, detail: `${q[1] === 'CHEF' ? 'question au chef' : 'question à l’utilisateur'} : ${flat(q[2], 240)}` };
  return { state: 'terminee', ...end, detail: flat(text.split('\n').find(l => l.trim()) || 'fait', 200) };
}

/** Queue entry of `projet` carrying this exact task text, with its position. */
function queuePosition(logsDir, projet, hash) {
  const q = readJson(path.join(logsDir, 'queue', `${projet}.json`));
  if (!Array.isArray(q)) return null;
  const i = q.findIndex(e => e && typeof e.prompt === 'string' && textHash(e.prompt) === hash);
  return i < 0 ? null : { position: i + 1, length: q.length, id: q[i].id || null, enqueuedAt: q[i].enqueuedAt || null };
}

/** A launched task (dispatch record or release record) → its current state. */
export function launchedState(logsDir, rec) {
  const turn = findTurn(logsDir, rec.projet, { hash: rec.hash, offset: Number.isFinite(rec.offset) ? rec.offset : null, since: Number.isFinite(rec.offset) ? null : rec.at });
  if (turn) return fromTurn(logsDir, turn);
  const q = queuePosition(logsDir, rec.projet, rec.hash);
  if (q) return { state: 'file', since: q.enqueuedAt || rec.at, detail: `position ${q.position} sur ${q.length} dans la file de ${rec.projet}`, queue: q };
  if (pidAlive(rec.pid)) return { state: 'lancee', since: rec.at, detail: 'le lancement attend la fin du tour en cours du musicien' };
  return { state: 'introuvable', since: rec.at, detail: `lancée le ${rec.at || '?'}, mais aucun tour ni entrée de file ne porte ce texte (file retirée, ou tour antérieur à la fin lue du log)` };
}

/** Release records (routage-released.ndjson) of one Routage run, by task number. */
function releasedOf(logsDir, run) {
  const out = new Map();
  let txt = '';
  try { txt = fs.readFileSync(path.join(logsDir, RELEASED_FILE), 'utf8'); } catch { return out; }
  for (const l of txt.split('\n')) {
    if (!l.includes(run)) continue;
    try { const r = JSON.parse(l); if (r.run === run && Number.isInteger(r.n)) out.set(r.n, r); } catch {}
  }
  return out;
}

/** The chef's own turn for tasks handed back to it ([RENVOI_CHEF <run>]). */
function handoffState(logsDir, conductor, run, handoff, since) {
  const turn = findTurn(logsDir, conductor, { since, exclusive: false, match: (e) => e.chefHandoff?.run === run || e.text.startsWith(`[RENVOI_CHEF ${run}]`) });
  if (turn) {
    const s = fromTurn(logsDir, turn);
    return { ...s, detail: `tour du chef : ${s.detail}` };
  }
  if (handoff?.status === 'failed') return { state: 'echouee', detail: `renvoi au chef non lancé : ${handoff.why || '?'}` };
  // The deferred launcher writes the outcome of the chef's turn to
  // logs/chef-actions.log: a refused turn never reaches the chef's log.
  const exit = handoffExit(logsDir, run);
  if (exit && exit.code !== 0) return { state: 'echouee', detail: `le tour du chef n’a pas pu partir (code ${exit.code}) : ${flat(exit.why, 240)}`, endedAt: exit.at };
  return { state: 'renvoyee', detail: handoff?.status === 'scheduled' ? 'tour du chef programmé après le Routage, pas encore commencé' : 'renvoyée au chef' };
}

/** Last « handoff <run>#… exited with N: why » line of logs/chef-actions.log. */
function handoffExit(logsDir, run) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(logsDir, 'chef-actions.log'), 'utf8'); } catch { return null; }
  let found = null;
  for (const l of txt.split('\n')) {
    const m = l.match(/^(\S+) \[chef-action\] handoff (p-\d{8}T\d{6}-[0-9a-f]{6})#\S* exited with (-?\d+)(?::\s*(.*))?$/);
    if (m && m[2] === run) found = { at: m[1], code: Number(m[3]), why: m[4] || '' };
  }
  return found;
}

const ACTION_WORD = { done: 'faite', scheduled: 'programmée après le tour du chef', failed: 'en échec', refused: 'refusée' };

/**
 * One request: its text, what the Routage understood, and each atomic task
 * with its dependency level, its state now, and where that state comes from.
 */
export function buildRequest(root, { logsDir = path.join(root, 'logs'), run, state = null, pending = null } = {}) {
  const st = state || readJson(path.join(logsDir, 'runs', run, 'run.json'));
  if (!st) return null;
  const conductor = conductorOf(root);
  const chefDir = projectPath(root, st.project || conductor);
  const art = chefDir ? path.join(chefDir, '.orchestrateur', 'runs', run) : null;
  const disp = art ? readJson(path.join(art, 'dispatch.json')) : null;
  const classement = art ? readJson(path.join(art, 'classement.json')) : null;
  const sens = art ? readJson(path.join(art, 'sens.json')) : null;
  const raw = Array.isArray(st.tasks) ? st.tasks : Array.isArray(classement?.taches) ? classement.taches : [];
  const waiting = (pending || readPending(logsDir)).filter(p => p.run === run);
  const released = releasedOf(logsDir, run);
  const routageOver = ['done', 'failed', 'abandoned'].includes(st.status);
  const tasks = raw.map((t, i) => {
    const n = Number.isInteger(t.n) ? t.n : i + 1;
    const base = { n, projet: t.projet || null, titre: cleanTitle(t.titre) || flat(t.demande, 60), demande: String(t.demande || ''),
      apres: Number.isInteger(t.apres) ? t.apres : null, pipeline: t.pipeline || null, mode: t.mode || null,
      ...(t.rattache ? { rattache: flat(t.rattache, 300) } : {}), ...(t.reprise ? { reprise: t.reprise } : {}),
      ...(t.raison ? { raison: flat(t.raison, 300) } : {}) };
    let s;
    const dup = (disp?.duplicates || []).find(d => d.n === n);
    const launched = (disp?.dispatched || []).find(d => d.n === n);
    const wait = waiting.find(p => p.n === n);
    const rel = released.get(n);
    if (dup) s = { state: 'doublon', detail: `${dup.reason}${dup.keptId ? ` ; gardée : ${dup.keptId}${dup.keptTitre ? ` « ${dup.keptTitre} »` : ''}` : ''}` };
    else if (launched) s = { ...launchedState(logsDir, launched), launchedAt: launched.at };
    else if (rel) s = { ...launchedState(logsDir, rel), launchedAt: rel.at, released: true };
    else if (wait) s = wait.blocked
      ? { state: 'bloquee', since: wait.createdAt, detail: `la tâche attendue (${wait.after?.projet || '?'}) a échoué : non relancée`, pendingId: idOf(wait) }
      : { state: 'attente', since: wait.createdAt, detail: `attend la fin de la tâche ${base.apres ?? '?'}${wait.after?.projet ? ` (${wait.after.projet})` : ''}`, pendingId: idOf(wait) };
    else if (t.chefHandoff) s = handoffState(logsDir, conductor, run, disp?.handoff, st.createdAt);
    else if (t.chefAction && !t.refused) {
      const a = (disp?.actions || []).find(x => x.action === t.chefAction && (!x.projet || !t.projet || x.projet === t.projet));
      s = { state: a?.status === 'failed' || a?.status === 'refused' ? 'echouee' : 'action', detail: `« ${t.chefAction} » ${a ? ACTION_WORD[a.status] || a.status : routageOver ? 'non exécutée' : 'à exécuter par le Dispatcher'}` };
    } else if (t.route === false || t.noDispatch) {
      const why = t.lacune ? `lacune : ${flat(t.lacune, 200)}` : t.blocked ? `attendait la tâche ${t.blocked}, non lancée` : t.refused ? `${t.refused}` : t.failed ? `classement en échec : ${t.why || '?'}` : null;
      s = t.question ? { state: 'question', detail: `question posée à l’utilisateur : ${flat(t.question, 260)}` } : { state: 'non_lancee', detail: why || 'non lancée' };
    } else if (t.apres && routageOver) s = { state: 'introuvable', detail: `devait attendre la tâche ${t.apres} : plus en attente, et aucun lancement enregistré (libérée avant 0.100.0, ou retirée)` };
    else s = { state: routageOver ? 'non_lancee' : 'a_dispatcher', detail: routageOver ? 'non lancée par le Routage' : `Routage ${st.status === 'paused' ? 'en pause' : 'en cours'} : pas encore dispatchée` };
    return { ...base, ...s, stateLabel: TASK_STATES[s.state]?.label || s.state, tone: TASK_STATES[s.state]?.tone || 'neutral' };
  });
  // Dependency level: the column of the map (a task after task k sits right of it).
  const level = new Map();
  const lv = (t, seen = new Set()) => {
    if (level.has(t.n)) return level.get(t.n);
    if (!t.apres || seen.has(t.n)) { level.set(t.n, 0); return 0; }
    seen.add(t.n);
    const dep = tasks.find(x => x.n === t.apres);
    const v = dep ? lv(dep, seen) + 1 : 0;
    level.set(t.n, v);
    return v;
  };
  tasks.forEach(t => { t.level = lv(t); });
  const counts = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] || 0) + 1;
  const open = tasks.filter(t => !TERMINAL.has(t.state)).length;
  const request = typeof st.request === 'string' ? st.request : '';
  return {
    run, createdAt: st.createdAt || null, updatedAt: st.updatedAt || null, endedAt: st.endedAt || null,
    mode: st.mode || null, routageStatus: st.status || null,
    origin: /^\s*\[(NEEDS_CHEF_INPUT_FROM|CALLBACK_WAKE|RENVOI_CHEF)/.test(request) ? 'relais' : 'utilisateur',
    request, requestHead: flat(request.replace(/^Je réponds à ton message précédent\s*:\s*/i, ''), 220),
    sens: sens?.sens ? flat(sens.sens, 600) : null, nature: sens?.nature || null,
    aucunDispatch: disp?.aucun_dispatch || null,
    questions: Array.isArray(classement?.questions) ? classement.questions.map(q => flat(q, 400)) : [],
    tasks, counts, open, total: tasks.length,
  };
}

/**
 * The latest user requests (Routage runs in « demande » or « discussion »
 * mode; the chef's wake-ups are not requests), newest first.
 */
export function listRequests(root, { logsDir = path.join(root, 'logs'), limit = 20 } = {}) {
  const conductor = conductorOf(root);
  const runsDir = path.join(logsDir, 'runs');
  let names = [];
  try { names = fs.readdirSync(runsDir).filter(d => RUN_RE.test(d)); } catch { return []; }
  // Run ids start with their creation time: newest first without reading them all.
  names.sort().reverse();
  const pending = readPending(logsDir);
  const out = [];
  for (const run of names) {
    if (out.length >= limit) break;
    const st = readJson(path.join(runsDir, run, 'run.json'));
    if (!st || st.pipeline !== 'routage' || (st.project && st.project !== conductor)) continue;
    if (st.mode === 'callback' || st.source === 'wake') continue;
    const r = buildRequest(root, { logsDir, run, state: st, pending });
    if (r) out.push(r);
  }
  return out;
}

