#!/usr/bin/env node
// ============================================================================
// scripts/routage-pending.mjs — Routage tasks waiting for another one (0.58.0)
// ============================================================================
//
// The chef's Routage can decide "do B after A". B waits in
// logs/routage-pending.json until A has produced its result. Until 0.57.x, B was
// only released by the chef's wake-up turn (Relancer step), which never came for
// tasks launched by the Routage itself, and the dependency needed a timestamped
// result that ordinary CLI turns never write: the fleet froze after the end of
// a turn while work remained (user report, 2026-10-09: "A nouveau, orchestrateur
// est termine, et plus rien ne se passe. Il faut corriger la situation").
//
// This module is the single owner of that file:
//   - a dependency is anchored on a log POSITION (byte offset of the awaited
//     project's log when the awaited task was launched) and on the awaited
//     task's text, so any real result written after it releases the waiter —
//     timestamped or not, and never the result of an unrelated earlier turn;
//   - releaseReady() is mechanical (no LLM): dispatch.mjs calls it at the end of
//     EVERY turn, the server sweeps it, the Relancer step still calls it;
//   - a waiter that resumes a paused pipeline run carries `reprise` and is
//     launched with `--pipeline-resume <run>`, never as a new run;
//   - entries are deduplicated (0.67.0) on an explicit identity, never on a
//     text prefix: the same Routage task (run + task number), the same resumed
//     run, or the same task content (fingerprint of the WHOLE normalised text +
//     project + pipeline + mode + awaited project). A duplicate is never dropped
//     silently: it is returned with its reason, appended to
//     logs/routage-pending-duplicates.ndjson, and the engine reports it to the chef.
//
// Why not the first 120 characters any more (user, 2026-10-10: « La clé de
// dédoublonnage ne garde que les 120 premiers caractères de la demande :
// manifestement mauvaise methode, trouves en une autre »): two different tasks
// starting with the same sentence were merged — task 4 of a run was dropped as a
// duplicate of task 3, without any trace. A full-text fingerprint keeps every
// distinct task; the task reference catches a re-dispatch of the same task even
// if its text was reworded; the content fingerprint catches the same work queued
// again by another Routage run (a replayed wake-up).
//
// CLI (never edit the JSON file by hand):
//   node scripts/routage-pending.mjs list [--json]
//   node scripts/routage-pending.mjs release [<id>…] [--force]
//   node scripts/routage-pending.mjs drop <id>… | --run <routage run> [--projet <p>] | --all
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PENDING_FILE = 'routage-pending.json';
export const RUN_ID_RE = /\bp-\d{8}T\d{6}-[0-9a-f]{6}\b/g;
export const DUPLICATES_FILE = 'routage-pending-duplicates.ndjson';
export const RELEASED_FILE = 'routage-released.ndjson';
// Only a short, human-readable label now (logs, CLI): never an identity.
const KEY_LEN = 120;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function readPending(logsDir) { return readJson(path.join(logsDir, PENDING_FILE))?.tasks || []; }
export function writePending(logsDir, tasks) {
  const f = path.join(logsDir, PENDING_FILE);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ tasks }, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}

/** Whole task text, normalised (the chef's « Rattachée à » suffix is not part of the task). */
export function normalizeTask(text) {
  return String(text || '').replace(/\n\n\(Rattachée à :[\s\S]*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
/** Short label of a task text (display only). */
export function taskKey(text) { return normalizeTask(text).slice(0, KEY_LEN); }
/** Fingerprint of the WHOLE normalised text: what identifies a turn's request. */
export function textHash(text) {
  return crypto.createHash('sha256').update(normalizeTask(text)).digest('hex').slice(0, 32);
}
/** Fingerprint of a task's content: project, pipeline, mode, awaited project and whole text. */
export function contentHash(t) {
  return crypto.createHash('sha256')
    .update([t.projet || '', t.pipeline || '', t.mode || '', t.after?.projet || '', normalizeTask(t.demande)].join('\u0000'))
    .digest('hex').slice(0, 32);
}
/** Explicit reference of a Routage task: its run and its number in that run. */
export const taskRef = (t) => (t.run && Number.isInteger(t.n) ? `${t.run}#${t.n}` : null);
/**
 * The identities that make two entries the same work, strongest first:
 * same Routage task, same resumed run of the same project, same content.
 */
export function identities(t) {
  return [
    ...(taskRef(t) ? [`ref:${taskRef(t)}`] : []),
    ...(t.reprise ? [`run:${t.projet}|${t.reprise}`] : []),
    `content:${contentHash(t)}`,
  ];
}
/** Kept for the id of entries written before 0.67.0 (and for display). */
export function dedupeKey(t) { return identities(t)[0]; }
export function pendingId(t) {
  return crypto.createHash('sha1').update(`${t.run || ''}|${taskRef(t) || ''}|${contentHash(t)}`).digest('hex').slice(0, 8);
}
/** Entries written before 0.58.0 have no id: derive a stable one. */
export const idOf = (t) => t.id || pendingId(t);

// --- short title (0.87.0) ----------------------------------------------------
// On 2026-10-13 the chef confused two waiting tasks of the same request: their
// texts shared their first ~400 characters, every display cut them at ~140, and
// an 8-hex id says nothing. Each task now gets a short title at the Decomposer
// step, shown next to its id everywhere; an id never appears alone.
export const TITLE_MIN = 3;
export const TITLE_MAX = 60;
export const cleanTitle = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
/** null when `titre` is a valid short title, else why (French, for the model's retry). */
export function titleProblem(titre) {
  const s = cleanTitle(titre);
  if (!s) return '« titre » obligatoire : quelques mots qui disent ce que fait cette tâche et la distinguent des autres (ex. « file : glisser-déposer »)';
  if (s.length < TITLE_MIN) return `« titre » trop court (« ${s} ») : quelques mots qui distinguent cette tâche`;
  if (s.length > TITLE_MAX) return `« titre » trop long (${s.length} caractères, ${TITLE_MAX} au plus) : un titre court, pas la demande`;
  return null;
}
/**
 * Title of an entry. Entries written before 0.87.0 have none: a fallback is
 * derived from their « rattache » (else the start of the demand) at display
 * time only — the stored entry and its demand are never modified.
 */
export function titleOf(t) {
  const own = cleanTitle(t?.titre);
  if (own) return { titre: own, fallback: false };
  const src = cleanTitle(t?.rattache) || cleanTitle(String(t?.demande || '').replace(/\n\n\(Rattachée à :[\s\S]*$/, ''));
  const cut = src.length > TITLE_MAX - 2 ? `${src.slice(0, TITLE_MAX - 3).replace(/\s+\S*$/, '')}…` : src;
  return { titre: `↳ ${cut || 'sans titre'}`, fallback: true };
}
// --- ambiguous tasks (0.90.0) -----------------------------------------------
// Task 2/4 of the same mechanism: within ONE Routage run, two tasks must not
// look alike where they are shown — neither the same title (case, spacing and
// accents ignored) nor the same displayed start of text (the cut used by
// `list`; the chef's context shows more, so equal here means equal there too).
export const DISPLAY_HEAD = 140;
/** Start of a task's text exactly as `routage-pending.mjs list` shows it. */
export const displayedHead = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, DISPLAY_HEAD);
export const titleKey = (s) => cleanTitle(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/**
 * null when the tasks are told apart, else why — naming every conflicting
 * pair (1-based task numbers) so the step can fix exactly those.
 */
export function ambiguityProblem(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i] || {}, b = list[j] || {};
      const sameTitle = titleKey(a.titre) && titleKey(a.titre) === titleKey(b.titre);
      const sameHead = displayedHead(a.demande) && displayedHead(a.demande) === displayedHead(b.demande);
      if (!sameTitle && !sameHead) continue;
      out.push(`tâches ${i + 1} et ${j + 1} : ${[
        sameTitle && `même titre (« ${cleanTitle(a.titre)} »)`,
        sameHead && `même début de texte affiché (« ${displayedHead(a.demande).slice(0, 80)}… »)`,
      ].filter(Boolean).join(' et ')}`);
    }
  }
  if (!out.length) return null;
  return `tâches ambiguës — ${out.join(' ; ')}. Donne à chacune un titre distinct qui dit ce qui la distingue, ` +
    `et fais commencer sa demande par ce qui la distingue (les ${DISPLAY_HEAD} premiers caractères sont ce que l’on voit dans la liste)`;
}

// --- what differs (0.91.0) ----------------------------------------------------
// Task 3/4: on 2026-10-13 two waiting tasks showed the same 140 characters
// while they differed after ~400, and their `rattache` (which named the part
// covered) was shown nowhere. Entries that share their displayed start now
// show, each, the excerpt that starts where it parts from its closest twin.
export const DISTINCT_EXCERPT = 220;
const flatText = (text) => String(text || '').replace(/\n\n\(Rattachée à :[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
/**
 * Map id → {excerpt, commonLength, commonWith: [ids]} for every entry whose
 * displayed start is shared by another entry; entries told apart by their
 * start are absent (their start is enough).
 */
export function distinctExcerpts(tasks) {
  const list = (tasks || []).map(t => ({ id: idOf(t), head: displayedHead(t.demande), text: flatText(t.demande) }));
  const out = new Map();
  for (const a of list) {
    const twins = list.filter(b => b !== a && a.head && b.head === a.head);
    if (!twins.length) continue;
    const common = Math.max(...twins.map(b => commonPrefix(a.text, b.text)));
    // Back to a word boundary so the excerpt does not start mid-word.
    let from = common;
    while (from > 0 && a.text[from - 1] !== ' ') from--;
    const rest = a.text.slice(from);
    out.set(a.id, {
      excerpt: rest ? `…${rest.slice(0, DISTINCT_EXCERPT)}${rest.length > DISTINCT_EXCERPT ? '…' : ''}` : '(même texte complet)',
      commonLength: common, commonWith: twins.map(b => b.id),
    });
  }
  return out;
}
/** Lines that name what sets an entry apart (CLI and the chef's context). */
export function entryDetailLines(t, distinct, { indent = '    ' } = {}) {
  const d = distinct?.get(idOf(t));
  const lines = [];
  if (d) {
    lines.push(`${indent}ce qui la distingue : ${d.excerpt}`);
    lines.push(`${indent}(même début sur ${d.commonLength} caractères que ${d.commonWith.join(', ')})`);
  } else lines.push(`${indent}${displayedHead(t.demande)}`);
  const r = cleanTitle(t.rattache);
  if (r) lines.push(`${indent}rattachée à : ${r.slice(0, 300)}`);
  return lines;
}

/** `id « titre »`: the only way an id is shown. */
export function pendingLabel(t) {
  const id = idOf(t);
  const { titre, fallback } = titleOf(t);
  return { id, titre, ...(fallback ? { titreRepli: true } : {}), text: `${id} « ${titre} »${fallback ? ' (titre de repli)' : ''}` };
}

export function logOffset(logsDir, projet) {
  try { return fs.statSync(path.join(logsDir, `${projet}.jsonl`)).size; } catch { return 0; }
}

/**
 * The paused pipeline run this task explicitly resumes (its `reprise` field),
 * else null. Routage v3 phase 0 c (user decision 4, 2026-10-19): a run id
 * cited in the task text is only a reference — it never turns the task into
 * a resume (it used to: a Discussion citing a paused run resumed that run).
 */
export function detectReprise(logsDir, t) {
  if (!t.reprise || !RUN_ID_RE.test(String(t.reprise))) { RUN_ID_RE.lastIndex = 0; return null; }
  RUN_ID_RE.lastIndex = 0;
  const st = readJson(path.join(logsDir, 'runs', t.reprise, 'run.json'));
  return st && st.project === t.projet && st.status === 'paused' ? t.reprise : null;
}

const DUP_REASON = {
  ref: 'même tâche du même Routage déjà en attente (re-dispatch)',
  run: 'reprise de la même exécution en pause déjà en attente',
  content: 'même travail déjà en attente (même projet, même pipeline, même texte complet)',
};

/**
 * Adds waiters, skipping true duplicates. Returns {added, duplicates}; every
 * duplicate says why and which entry it matched, and is appended to
 * logs/routage-pending-duplicates.ndjson — never dropped silently.
 */
export function addPending(logsDir, entries) {
  return withLock(logsDir, () => {
    const tasks = readPending(logsDir);
    const seen = new Map();
    const index = (t) => { for (const k of identities(t)) if (!seen.has(k)) seen.set(k, t); };
    tasks.forEach(index);
    const added = [], duplicates = [];
    for (const e of entries) {
      const hit = identities(e).find(k => seen.has(k));
      if (hit) {
        const kept = seen.get(hit);
        duplicates.push({ projet: e.projet, run: e.run || null, n: e.n ?? null, reprise: e.reprise || null, key: hit,
          reason: DUP_REASON[hit.split(':')[0]], keptId: idOf(kept), keptTitre: titleOf(kept).titre, keptRun: kept.run || null, keptN: kept.n ?? null,
          demande: String(e.demande || '').slice(0, 2000) });
        continue;
      }
      const t = { ...e, ...(cleanTitle(e.titre) ? { titre: cleanTitle(e.titre) } : {}), id: e.id || pendingId(e), createdAt: e.createdAt || new Date().toISOString() };
      tasks.push(t); added.push(t); index(t);
    }
    writePending(logsDir, tasks);
    if (duplicates.length) {
      const at = new Date().toISOString();
      try { fs.appendFileSync(path.join(logsDir, DUPLICATES_FILE), duplicates.map(d => JSON.stringify({ at, ...d })).join('\n') + '\n'); } catch {}
    }
    return { added, duplicates };
  });
}

/** One line per duplicate, in the user's language, for the chef's report. */
export function duplicatesText(duplicates) {
  return duplicates.map(d => `- ${d.projet}${d.n != null ? ` (tâche ${d.n}${d.run ? ` du Routage ${d.run}` : ''})` : ''} : écartée — ${d.reason} ; gardée : ${d.keptId}${d.keptTitre ? ` « ${d.keptTitre} »` : ''}${d.keptN != null ? ` (tâche ${d.keptN}${d.keptRun ? ` du Routage ${d.keptRun}` : ''})` : ''}. Demande : « ${String(d.demande).replace(/\s+/g, ' ').slice(0, 160)} »`).join('\n');
}

/**
 * The real result that satisfies a dependency, or null.
 *  - `after.offset` (0.58.0): only what was appended to the awaited log after
 *    that byte position counts; with `after.key`, only the result of the turn
 *    whose user_prompt starts with the awaited task's text (a turn that was
 *    already running when the task got queued does not count).
 *  - legacy entries (`after.since` only): a timestamped result after it.
 * Phantom results (num_turns 0 and duration_api_ms 0) never count.
 *  - phase 0 d (Routage v3, 2026-10-19): a PAUSED awaited task has not ended.
 *    A pipeline run paused (result `success` + `pipeline_paused`) is followed
 *    until its own final result (any later result of the same run); a turn that
 *    ends on a question (NEEDS_USER_INPUT / NEEDS_CHEF_INPUT) until the answer
 *    turn's result, or its acknowledgement (question_resolved). A run closed
 *    without delivery (« abandonner », « simplifier », close-run) is a failure.
 *  `info.held` (optional out-param) says what the waiter still waits for.
 */
const QUESTION_RE = /(^|\n)\s*NEEDS_(USER|CHEF)_INPUT\s*:/;
const isPauseResult = (e) => !e.is_error && (e.pipeline_paused === true || e.pipeline?.status === 'paused' || QUESTION_RE.test(String(e.result || '')));
export function dependencyResult(logsDir, after, info = {}) {
  if (!after?.projet) return null;
  const file = path.join(logsDir, `${after.projet}.jsonl`);
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const from = Number.isFinite(after.offset) ? Math.min(after.offset, size) : Math.max(0, size - 4 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  const legacy = !Number.isFinite(after.offset);
  let armed = legacy || !(after.key || after.hash);
  // The awaited task paused: { run } (pipeline run) or { question } (ordinary turn).
  let held = null;
  for (const l of text.split('\n')) {
    if (!l.includes('"type"')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    // A task that ran in a parallel lane (0.101.0, pipelines since P9) has its
    // turn in the lane's log; its end is marked here (system/lane_task with the
    // fingerprint of its text): integrated or nothing to integrate = success;
    // integration paused, abandoned = failed. A lane waiting for an answer
    // (state input) has not finished: its work is not integrated yet.
    if (after.hash && e.type === 'system' && e.subtype === 'lane_task' && e.promptHash === after.hash && ['done', 'paused', 'abandoned'].includes(e.state)) {
      const okEnd = e.state === 'done' && e.turnEnd !== 'error';
      return { type: 'result', subtype: okEnd ? 'success' : 'error_lane', is_error: !okEnd, lane: e.lane ?? null, outcome: e.outcome || e.state,
        result: e.why || e.text || `${after.projet}, couloir ${e.lane} : ${e.outcome || e.state}`, timestamp: e.timestamp || null, fromLane: true };
    }
    // A paused run closed by command (close-run.mjs) writes no result.
    if (held?.run && e.type === 'system' && e.subtype === 'pipeline_summary' && e.pipeline?.run === held.run && e.pipeline?.status === 'abandoned' && e.closed) {
      return { type: 'result', subtype: 'error_run_abandoned', is_error: true, pipeline: e.pipeline, result: e.text || `exécution ${held.run} close`, timestamp: e.timestamp || null };
    }
    // « Marquer comme répondue »: the question is settled, the task is over.
    if (held?.question && e.type === 'notification' && e.subtype === 'question_resolved') {
      return { type: 'result', subtype: 'success', is_error: false, result: `question marquée répondue${e.note ? ` : ${e.note}` : ''}`, timestamp: e.timestamp || null, resolved: true };
    }
    // Only a prompt that opens a turn re-arms (a notify message is no turn).
    // 0.67.0: the awaited task is recognised by the fingerprint of its whole
    // text (`after.hash`); a shared opening sentence is not enough any more.
    // Entries written before keep the legacy prefix match.
    if (!legacy && (after.hash || after.key) && e.type === 'user_prompt' && typeof e.text === 'string' && (!e.source || e.pipeline || e.callback)) {
      const own = after.hash ? textHash(e.text) === after.hash : (taskKey(e.text).startsWith(after.key.slice(0, 60)) || taskKey(e.text) === after.key);
      // After a pause, the turns that continue the awaited task count: its run
      // resumed or answered, or the answer to its question.
      const continues = held?.run ? e.pipeline?.run === held.run
        : held?.question ? (e.context?.resume === true || /^\s*\[CHEF_ANSWER\]/.test(e.text)) : false;
      armed = own || continues;
      continue;
    }
    if (e.type !== 'result') continue;
    const sameRun = held?.run && e.pipeline?.run === held.run;
    if (!armed && !sameRun) continue;
    if (!e.synthetic && e.num_turns === 0 && e.duration_api_ms === 0) continue;
    if (legacy && (!e.timestamp || e.timestamp <= after.since)) continue;
    if (isPauseResult(e)) { held = e.pipeline?.run ? { run: e.pipeline.run } : { question: true }; continue; }
    if (e.pipeline?.status === 'abandoned') return { ...e, is_error: true, subtype: 'error_run_abandoned' };
    return e;
  }
  if (held) info.held = held;
  return null;
}

function conductorOf(root) { return readJson(path.join(root, 'config.json'))?.conductor || 'chef'; }

/**
 * Launches one Routage task by dispatch.mjs (queued if the musician is busy),
 * with a report back to the chef. A task that resumes a paused run goes out as
 * `--pipeline-resume <run>`: never `--pipeline`, which would start a new run.
 * Returns the launch record, including the awaited log offset taken BEFORE the
 * spawn (what a later "after this task" waiter anchors on).
 */
export function launchTask(root, t, dispatchScript, { released = false } = {}) {
  const conductor = conductorOf(root);
  const logsDir = path.join(root, 'logs');
  const offset = logOffset(logsDir, t.projet);
  const args = [dispatchScript, t.projet, '--prompt-stdin', '--callback', conductor, '--source', conductor, '--queue-if-busy'];
  if (t.reprise) args.push('--pipeline-resume', t.reprise);
  // Off-pipeline task authorized by the user (0.71.2, ROUTAGE-PROBLEMES n° 10):
  // ordinary turn, traced as such by dispatch.mjs (pipelineBypass).
  else if (t.horsPipeline) args.push('--hors-pipeline', String(t.horsPipeline).slice(0, 300));
  else if (t.served) {
    args.push('--pipeline', t.pipeline);
    if (t.pipeline === 'dev' && t.mode) args.push('--mode', t.mode);
    // A generic mode found when the task was classified (pipelines phase 1).
    else if (['document', 'verification', 'interne'].includes(t.mode)) args.push('--mode', t.mode);
    // The nature found when the task was classified on its own (0.69.0).
    if (t.pipeline === 'dev' && ['simple', 'bugfix', 'mecanique'].includes(t.kind)) args.push('--kind', t.kind);
  }
  // Fresh session asked for this task (0.95.0): a real flag, never words in the
  // demand. dispatch.mjs carries it into the queue entry when the musician is
  // busy, and ignores it (saying so) with codex or inside a pipeline run.
  if (t.sessionNeuve === true) args.push('--new-session');
  // Calibrated context (0.99.0): the Routage says this task continues the
  // musician's current task, so its session is resumed (otherwise fresh).
  else if (t.memeTache === true) args.push('--meme-tache');
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID']) delete env[k];
  // A released waiter belongs to the request that queued it, not to the turn that releases it (requests registry, phase 1).
  if (released) delete env.ORCH_REQUEST_ID;
  let pid = null;
  try {
    const c = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    c.on('error', () => {});
    c.stdin.on('error', () => {});
    c.stdin.end(t.rattache ? `${t.demande}\n\n(Rattachée à : ${t.rattache})` : t.demande);
    c.unref();
    pid = c.pid || null;
  } catch { pid = null; }
  return { projet: t.projet, ...(cleanTitle(t.titre) ? { titre: cleanTitle(t.titre) } : {}), pipeline: t.reprise ? t.pipeline || null : t.served ? t.pipeline : null, mode: t.mode || null, ...(t.horsPipeline ? { horsPipeline: t.horsPipeline } : {}),
    reprise: t.reprise || null, ...(t.sessionNeuve === true ? { sessionNeuve: true } : {}), ...(t.memeTache === true ? { memeTache: true } : {}), pid, at: new Date().toISOString(), offset, key: taskKey(t.demande), hash: textHash(t.demande) };
}

/**
 * Mechanical release (no LLM): every waiter whose awaited task has produced a
 * real, successful result is launched once and removed from the file; a failed
 * awaited task keeps the waiter (reported as blocked). The file is rewritten
 * BEFORE launching, under a lock, so two turns ending together never launch the
 * same waiter twice. `onlyAfter` limits the scan to waiters of that project.
 */
export function releaseReady({ root, logsDir = path.join(root, 'logs'), dispatchScript, onlyAfter = null, ids = null, force = false, launch = launchTask }) {
  const ready = [], blocked = [], twins = [], held = [];
  const still = withLock(logsDir, () => {
    const tasks = readPending(logsDir);
    const keep = [];
    const keys = new Map();
    for (const t of tasks) {
      const id = idOf(t);
      if (ids && !ids.includes(id)) { keep.push(t); continue; }
      if (!ids && onlyAfter && t.after?.projet !== onlyAfter) { keep.push(t); continue; }
      const dep = {};
      const r = force ? { forced: true } : dependencyResult(logsDir, t.after, dep);
      if (!r) {
        // Phase 0 d: a paused awaited task keeps its waiter, and says so.
        if (dep.held) held.push({ id, label: pendingLabel(t).text, projet: t.projet, after: t.after?.projet, run: dep.held.run || null,
          why: dep.held.run ? `la tâche attendue (${t.after?.projet}) est en pause dans l’exécution ${dep.held.run} : attente maintenue jusqu’à sa fin` : `la tâche attendue (${t.after?.projet}) attend la réponse à sa question : attente maintenue` });
        keep.push(t); continue;
      }
      if (r.is_error || (typeof r.subtype === 'string' && r.subtype.startsWith('error'))) {
        blocked.push({ id, label: pendingLabel(t).text, projet: t.projet, after: t.after?.projet, why: r.subtype === 'error_run_abandoned' ? `la tâche attendue (${t.after?.projet}) a été arrêtée sans livraison : non relancée` : `la tâche attendue (${t.after?.projet}) a échoué : non relancée` });
        keep.push({ ...t, blocked: t.blocked || new Date().toISOString() });
        continue;
      }
      // Same work released once (identities, never a text prefix); the twin
      // (entries written before 0.67.0) is traced, never dropped silently.
      const ks = identities(t);
      const twin = ks.find(k => keys.has(k));
      if (twin) { twins.push({ projet: t.projet, run: t.run || null, n: t.n ?? null, key: twin, reason: 'jumeau d’une tâche libérée au même moment : lancée une seule fois', keptId: keys.get(twin), demande: String(t.demande || '').slice(0, 2000) }); continue; }
      ks.forEach(k => keys.set(k, id));
      ready.push({ ...t, id });
    }
    writePending(logsDir, keep);
    if (twins.length) {
      const at = new Date().toISOString();
      try { fs.appendFileSync(path.join(logsDir, DUPLICATES_FILE), twins.map(d => JSON.stringify({ at, ...d })).join('\n') + '\n'); } catch {}
    }
    return keep;
  });
  const launched = ready.map(t => {
    // A resume is re-checked at launch time: a run already resumed (or closed)
    // is not paused any more, and the engine would refuse it anyway. Only the
    // explicit field resumes (phase 0 c): a run cited in the text is a reference.
    const reprise = detectReprise(logsDir, t);
    if (t.reprise && !reprise) return { id: t.id, label: pendingLabel(t).text, projet: t.projet, skipped: `exécution ${t.reprise} plus en pause : rien relancé` };
    return { id: t.id, run: t.run || null, n: t.n ?? null, label: pendingLabel(t).text, ...launch(root, { ...t, reprise }, dispatchScript, { released: true }), after: t.after?.projet };
  });
  // A released task leaves the pending file: its launch (log offset, text
  // fingerprint) is kept so the request map still follows it (0.100.0).
  const traced = launched.filter(l => !l.skipped && l.run);
  if (traced.length) {
    try {
      fs.appendFileSync(path.join(logsDir, RELEASED_FILE), traced.map(l => JSON.stringify({ at: l.at || new Date().toISOString(), run: l.run, n: l.n, id: l.id,
        projet: l.projet, offset: l.offset ?? null, hash: l.hash || null, pid: l.pid ?? null, titre: l.titre || null })).join('\n') + '\n');
    } catch { /* never blocks a release */ }
  }
  return { launched, blocked, held, still, duplicates: twins };
}

/** Waiters older than `maxMs` (default 2 h), not yet reported. */
export function staleEntries(tasks, { now = Date.now(), maxMs = 2 * 3600_000 } = {}) {
  return tasks.filter(t => !t.staleNotified && Date.parse(t.createdAt || 0) < now - maxMs);
}
export function markNotified(logsDir, ids) {
  return withLock(logsDir, () => {
    const tasks = readPending(logsDir).map(t => (ids.includes(idOf(t)) ? { ...t, staleNotified: new Date().toISOString() } : t));
    writePending(logsDir, tasks);
    return tasks;
  });
}

/** Drops waiters by id, by Routage run (optionally one project), or all. */
export function dropPending(logsDir, { ids = null, run = null, projet = null, all = false } = {}) {
  return withLock(logsDir, () => {
    const tasks = readPending(logsDir);
    const hit = (t) => all || (ids && ids.includes(idOf(t))) || (run && t.run === run && (!projet || t.projet === projet));
    const dropped = tasks.filter(hit);
    writePending(logsDir, tasks.filter(t => !hit(t)));
    return dropped;
  });
}

// --- lock: a directory, atomic on every filesystem; stale after 30 s --------
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function withLock(logsDir, fn) {
  fs.mkdirSync(logsDir, { recursive: true });
  const lock = path.join(logsDir, `${PENDING_FILE}.lock`);
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() - t0 > 5000) throw new Error('routage-pending : verrou occupé');
      sleepSync(50);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function describe(logsDir, t, distinct) {
  const dep = t.after ? dependencyResult(logsDir, t.after) : null;
  const state = !t.after ? 'sans dépendance' : !dep ? `attend ${t.after.projet}` : dep.is_error ? `${t.after.projet} a échoué` : `prête (${t.after.projet} a fini)`;
  return `${pendingLabel(t).text}  ${t.projet}${t.reprise ? ` — reprise ${t.reprise}` : ''}  [${state}]  depuis ${t.createdAt || '?'}  (routage ${t.run || '?'})\n${entryDetailLines(t, distinct).join('\n')}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(here, '..');
  const LOGS = path.join(ROOT, 'logs');
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (f) => { const i = rest.indexOf(f); if (i < 0) return null; const v = rest[i + 1]; rest.splice(i, 2); return v; };
  const has = (f) => { const i = rest.indexOf(f); if (i < 0) return false; rest.splice(i, 1); return true; };
  if (cmd === 'list') {
    const tasks = readPending(LOGS);
    const distinct = distinctExcerpts(tasks);
    if (has('--json')) console.log(JSON.stringify(tasks.map(t => { const lb = pendingLabel(t); const d = distinct.get(lb.id); return { ...t, id: lb.id, titre: lb.titre, ...(lb.titreRepli ? { titreRepli: true } : {}), ...(d ? { distinct: d } : {}), ready: !!(t.after && dependencyResult(LOGS, t.after)) }; }), null, 2));
    else console.log(tasks.length ? tasks.map(t => describe(LOGS, t, distinct)).join('\n') : 'aucune tâche en attente');
  } else if (cmd === 'release') {
    const force = has('--force');
    const ids = rest.filter(Boolean);
    if (force && !ids.length) { console.error('--force exige au moins un identifiant'); process.exit(64); }
    const r = releaseReady({ root: ROOT, logsDir: LOGS, dispatchScript: path.join(here, 'dispatch.mjs'), ids: ids.length ? ids : null, force });
    for (const l of r.launched) console.log(l.skipped ? `— ${l.label} ${l.projet} : ${l.skipped}` : `↗ ${l.label} ${l.projet} lancée${l.reprise ? ` (reprise ${l.reprise})` : ''}`);
    for (const b of r.blocked) console.log(`✕ ${b.label} ${b.projet} : ${b.why}`);
    if (!r.launched.length && !r.blocked.length) console.log('rien à relancer');
  } else if (cmd === 'drop') {
    const run = flag('--run'), projet = flag('--projet'), all = has('--all');
    const ids = rest.filter(Boolean);
    if (!run && !all && !ids.length) { console.error('drop : donner un identifiant, --run <routage run> [--projet <p>] ou --all'); process.exit(64); }
    const d = dropPending(LOGS, { ids: ids.length ? ids : null, run, projet, all });
    console.log(d.length ? d.map(t => `− ${pendingLabel(t).text} ${t.projet} retirée`).join('\n') : 'aucune tâche retirée');
    process.exit(d.length ? 0 : 2);
  } else {
    console.error('usage : routage-pending.mjs list [--json] | release [<id>…] [--force] | drop <id>… | --run <run> [--projet <p>] | --all');
    process.exit(64);
  }
}
