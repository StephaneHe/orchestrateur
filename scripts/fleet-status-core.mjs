// ============================================================================
// scripts/fleet-status-core.mjs — shared fleet state/stall/silence logic.
// ============================================================================
//
// SINGLE SOURCE OF TRUTH for "what is each musician doing right now?". Both the
// CLI supervisor (scripts/fleet-status.mjs) and the server's live desk view
// (/api/pupitre in server.js) import from here, so the two never diverge.
//
// A musician is any project with a logs/<name>.jsonl stream — the conductor
// (chef) included; it is treated exactly like the others.
//
// "Stalled" = state is live/think AND no non-partial event for >= STALL_SILENCE_MS
// AND no terminal `result` written. (A dead PID while still in-flight is an
// additional, stronger stall signal, surfaced separately as pidAlive === false.)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../public/turn-core.js';   // pose globalThis.TurnCore

const TurnCore = globalThis.TurnCore;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_LOGS = path.join(ROOT, 'logs');

export const STALL_SILENCE_MS = 60_000;   // live/think without progress → suspect
const TAIL_BYTES = 256 * 1024;            // only scan the last 256 KB

/**
 * « Result fantôme » : un `result` à 0 tour et 0 ms d'API n'est PAS une fin de
 * tour. Le CLI claude en émet un au `--resume` quand la session précédente a
 * laissé une notification de tâche d'arrière-plan tuée (`system/
 * task_notification` status "stopped") : il « rejoue » cette notification en
 * mini-tour vide, AU MILIEU du nouveau tour — après son user_prompt et son
 * system/init — puis traite le vrai prompt. Même session_id, même coût cumulé
 * que le result précédent, `stop_reason: null`.
 *
 * Le prendre pour une fin de tour réveillait le chef avec l'ancien texte,
 * consommait l'attente `--callback` du vrai tour (dont la fin ne réveillait
 * donc plus personne), vidait la file en plein tour et fermait le ticket de
 * chef en cours (25/09/2026, TranslateOverlay et vuBox ; 181 dans chef.jsonl).
 *
 * Les result synthétiques écrits par dispatch.mjs / le serveur portent
 * `num_turns: 1` ou `synthetic: true` : ils ne tombent jamais ici. On exige les
 * DEUX champs à 0 exactement, pour qu'un result sans ces champs reste un vrai.
 */
export function isPhantomResult(ev) {
  return ev?.type === 'result' && !ev.synthetic &&
    ev.num_turns === 0 && ev.duration_api_ms === 0;
}

/**
 * Acquittement d'une question (0.25.0). Écrit par POST /api/question/:p/resolve
 * dans le log DU MUSICIEN, juste après le result qui a posé la question.
 * Pourquoi un événement de log plutôt qu'un sidecar : tous les réducteurs lisent
 * déjà ce log dans l'ordre, donc « ignoré si un nouveau tour a démarré depuis »
 * est gratuit (un user_prompt/init postérieur reprend la main), l'acquittement
 * survit au redémarrage, part au dashboard par le SSE existant et reste visible
 * dans le journal du panneau — sans rapprocher des horodatages que les
 * événements du CLI ne portent pas.
 * Règle unique pour tous les réducteurs : il ne fait passer que `input` → `idle`.
 */
export function isQuestionResolved(ev) {
  return ev?.type === 'notification' && ev.subtype === 'question_resolved';
}

// 0.31.0 — « vu » (acquittement d'un échec / arrêt) et arrêt par le chef. Les
// définitions vivent dans public/turn-core.js, partagé avec le navigateur.
export const isAcknowledged  = TurnCore.isAcknowledged;
export const isConductorStop = TurnCore.isConductorStop;
export const stopInfo        = TurnCore.stopInfo;
export const createJournal   = TurnCore.createJournal;

/** Read the last TAIL_BYTES of a file and split into full JSON lines (dropping
 *  a partial head line that may be cut mid-object). */
export function tailLines(filePath) {
  let st; try { st = fs.statSync(filePath); } catch { return { lines: [], mtimeMs: 0, size: 0 }; }
  const size = st.size;
  const fd = fs.openSync(filePath, 'r');
  const want = Math.min(TAIL_BYTES, size);
  const buf = Buffer.alloc(want);
  try { fs.readSync(fd, buf, 0, want, size - want); } finally { fs.closeSync(fd); }
  // Filter NUL bytes that crashed writes can leave behind on Windows.
  const text = buf.toString('utf8').replace(/\u0000+/g, '');
  const raw = text.split('\n');
  // Only a window that STARTS mid-file can begin with a partial line: a log that
  // fits entirely keeps its first event (before 0.29.0 it was always dropped).
  if (want < size && raw.length > 1) raw.shift();
  return { lines: raw.filter(Boolean), mtimeMs: st.mtimeMs, size };
}

export function lastMeaningful(lines) {
  // Walk backwards for the most recent non-partial, parseable event.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'stream_event') continue; // partials are not "progress"
      if (isPhantomResult(ev)) continue;        // not a turn end (see above)
      return ev;
    } catch { /* skip corrupt */ }
  }
  return null;
}

export function lastAny(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev && typeof ev === 'object') return ev;
    } catch { /* skip */ }
  }
  return null;
}

/** Mirror of public/app.js Musician.transition for the bits we need here:
 *  is a turn running, when did it start, and what model/provider is in use? */
export function deriveState(lines) {
  let state = 'idle';
  let lastAssistantText = '';
  let turnStartTs = null;     // ts of the in-flight turn's opening event, else null
  let model = null;
  let provider = null;
  // Finished, but blocked on a CHEF decision (NEEDS_CHEF_INPUT). The state stays
  // `unread` — the vocabulary is locked — so this additive flag is what lets a
  // card say "attend le chef" instead of the misleading "terminé".
  let awaitingChef = false;
  // Dernier acquittement de question vu dans la fenêtre (null sinon).
  let resolution = null;
  // 0.31.0 : arrêt par le chef du dernier tour (null sinon) et dernier « vu ».
  let stopped = null;
  let acknowledged = null;
  // 0.45.0 : demandes d'autorisation sans décision du tour en cours. Le tour est
  // en PAUSE volontaire (il attend l'utilisateur) : ni bloqué, ni au repos.
  const permPending = new Map();

  for (const ln of lines) {
    let ev; try { ev = JSON.parse(ln); } catch { continue; }
    if (isPhantomResult(ev)) continue;   // mini-tour rejoué par le CLI, pas une fin de tour
    if (ev?.type === 'system' && ev.subtype === 'permission_request' && ev.permission?.id) {
      permPending.set(ev.permission.id, { id: ev.permission.id, tool: ev.permission.tool, preview: ev.permission.preview || '',
        toolUseId: ev.permission.toolUseId || null, deadline: ev.permission.deadline || null, risk: ev.permission.risk || null });
      continue;
    }
    if (ev?.type === 'notification' && ev.subtype === 'permission_decision') {
      if (ev.permission?.id) permPending.delete(ev.permission.id);
      continue;
    }
    if (ev?.type === 'user' && permPending.size) {
      for (const b of ev.message?.content || []) {
        if (b?.type !== 'tool_result') continue;
        for (const [id, p] of permPending) if (p.toolUseId && p.toolUseId === b.tool_use_id) permPending.delete(id);
      }
    }
    if (ev?.type === 'result' || (ev?.type === 'user_prompt' && !ev.source)) permPending.clear();
    if (isQuestionResolved(ev)) {
      if (state === 'input') { state = 'idle'; resolution = { ts: ev.timestamp || null, note: ev.note || '', question: ev.question || '' }; }
      continue;
    }
    if (isAcknowledged(ev)) {
      if (state === 'error' || state === 'unread') {
        state = 'idle'; awaitingChef = false;
        acknowledged = { ts: ev.timestamp || null, by: ev.by || '', note: ev.note || '' };
      }
      continue;
    }
    // Tout result qui suit un arrêt du chef, avant le tour suivant, est ignoré.
    if (ev?.type === 'result' && stopped && !isConductorStop(ev)) continue;
    const t = ev?.type;

    // Track model/provider as they appear (init, assistant, result all carry them).
    const evModel = ev?.model || ev?.message?.model;
    if (typeof evModel === 'string' && evModel) model = evModel;
    const evProvider = ev?.provider || ev?.message?.provider;
    if (typeof evProvider === 'string' && evProvider) provider = evProvider;

    // Sourced user_prompt (callback / @shortcut / notify) is not a turn start;
    // only a source-less prompt or a system/init is (a --source dispatch emits
    // init too, so real turns are still covered).
    if ((t === 'user_prompt' && !ev.source) || (t === 'system' && ev.subtype === 'init')) {
      if (state === 'idle' || state === 'unread' || state === 'input') {
        state = 'live';
        turnStartTs = ev.timestamp ? Date.parse(ev.timestamp) : Date.now();
      }
      awaitingChef = false;   // a new turn clears the pending chef decision
      stopped = null;
    } else if (t === 'assistant') {
      const blocks = ev.message?.content || [];
      let hasTool = false, hasThink = false, gotText = null;
      for (const b of blocks) {
        if (b?.type === 'text')     gotText = b.text || '';
        if (b?.type === 'thinking') hasThink = true;
        if (b?.type === 'tool_use') hasTool = true;
      }
      if (gotText) lastAssistantText = gotText;
      state = hasTool ? 'live' : (hasThink ? 'think' : 'live');
    } else if (t === 'result') {
      const isErr = !!ev.is_error || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'));
      const needs = /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(lastAssistantText);
      if (isConductorStop(ev)) stopped = stopInfo(ev);
      if (isErr && ev.synthetic) state = 'idle';          // crash/restart — no question posed
      else state = isErr ? 'error' : (needs ? 'input' : 'unread');
      awaitingChef = !isErr && !needs &&
        (/NEEDS_CHEF_INPUT:/i.test(lastAssistantText || '') ||
         (typeof ev.result === 'string' && /NEEDS_CHEF_INPUT:/i.test(ev.result)));
      turnStartTs = null;                                  // turn is over
    }
  }
  // Une demande dont l'échéance est largement passée (tour tué pendant l'attente)
  // ne fait plus « attendre » personne.
  const now = Date.now();
  const waiting = [...permPending.values()].filter(p => !p.deadline || now < p.deadline + 60_000);
  const awaitingPermission = (state === 'live' || state === 'think') && waiting.length
    ? { ...waiting[waiting.length - 1], count: waiting.length } : null;
  return {
    state, lastAssistantText, turnStartTs, model, provider, awaitingChef, resolution,
    stopped: state === 'error' ? stopped : null, acknowledged, awaitingPermission,
  };
}

export function readPid(project, logsDir = DEFAULT_LOGS) {
  try {
    const v = fs.readFileSync(path.join(logsDir, `${project}.pid`), 'utf8').trim();
    const pid = Number(v);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function fmtAge(ms) {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}`;
}

/** Compact label of the most recent real activity, e.g. tool_use:bash,
 *  thinking, result:ok, stream_event:thinking_delta. */
export function lastKindOf(meaningful, any) {
  if (meaningful?.type === 'assistant') {
    const b = (meaningful.message?.content || []).slice(-1)[0];
    if (b?.type === 'tool_use') return `tool_use:${(b.name || '?').toLowerCase()}`;
    if (b?.type === 'thinking') return 'thinking';
    if (b?.type === 'text')     return 'text';
    return 'assistant';
  }
  if (meaningful?.type === 'result') return meaningful.is_error ? 'result:error' : 'result:ok';
  if (meaningful?.type === 'user_prompt') return 'user_prompt';
  if (meaningful?.type === 'system')      return `system:${meaningful.subtype || '?'}`;
  if (any?.type === 'stream_event') {
    const dt = any.event?.delta?.type;
    return dt ? `stream_event:${dt}` : 'stream_event';
  }
  return meaningful?.type || any?.type || '—';
}

/** Short human preview of what the musician is doing NOW (for the desk view). */
function activityPreview(meaningful, lastAssistantText) {
  if (meaningful?.type === 'assistant') {
    const blocks = meaningful.message?.content || [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b?.type === 'tool_use') {
        const arg = b.input ? Object.values(b.input).find(v => typeof v === 'string') : '';
        return `${(b.name || 'tool').toLowerCase()}${arg ? ' · ' + String(arg).replace(/\s+/g, ' ').slice(0, 80) : ''}`;
      }
      if (b?.type === 'text' && b.text)     return b.text.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (b?.type === 'thinking')           return '(réflexion…)';
    }
  }
  if (meaningful?.type === 'result') {
    return meaningful.is_error ? (meaningful.subtype || 'échec du tour')
                               : (typeof meaningful.result === 'string' ? meaningful.result.replace(/\s+/g, ' ').trim().slice(0, 120) : 'terminé');
  }
  if (lastAssistantText) return lastAssistantText.replace(/\s+/g, ' ').trim().slice(0, 120);
  return '';
}

/** Le dernier vrai `result` de la fenêtre (fantômes exclus), réduit à ce que la
 *  vue « Projets » affiche. `costUsd` est le `total_cost_usd` RAPPORTÉ tel quel :
 *  il suit la session Claude, il ne se somme pas d'un tour à l'autre. */
function lastTurnOf(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (ev?.type !== 'result' || isPhantomResult(ev)) continue;
    const endedAt = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
    return {
      endedAt: Number.isFinite(endedAt) ? endedAt : null,
      durationMs: Number.isFinite(ev.duration_ms) ? ev.duration_ms : null,
      costUsd: Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : null,
      isError: !!ev.is_error || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error')),
      subtype: typeof ev.subtype === 'string' ? ev.subtype : null,
      synthetic: !!ev.synthetic,
    };
  }
  return null;
}

/** Le dernier `user_prompt` SANS source (= une vraie demande de tour ; un prompt
 *  sourcé est un callback / @raccourci / notify). null si la fenêtre de 256 Kio
 *  ne le contient pas : on ne l'invente pas. */
function lastMissionPrompt(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (ev?.type === 'user_prompt' && !ev.source) return ev;
  }
  return null;
}

/**
 * Full snapshot for one project. Used by the CLI table and the live desk view.
 * Includes state, current activity, turn-elapsed, silence, PID liveness,
 * stall, and model/provider.
 */
export function scanProject(name, logsDir = DEFAULT_LOGS) {
  const logPath = path.join(logsDir, `${name}.jsonl`);
  const { lines, mtimeMs, size } = tailLines(logPath);
  const last = lastMeaningful(lines);
  const tail = lastAny(lines);
  const { state, lastAssistantText, turnStartTs, model, provider, awaitingChef, resolution, stopped, acknowledged, awaitingPermission } = deriveState(lines);
  const now = Date.now();
  const lastMeaningfulTs = last?.timestamp ? Date.parse(last.timestamp) : (mtimeMs || 0);
  const silentMs = now - (lastMeaningfulTs || now);
  const fileSilentMs = now - (mtimeMs || now);
  const inFlight = state === 'live' || state === 'think';
  // Un tour qui attend une autorisation se tait par construction : pas un stall.
  const stalled = inFlight && !awaitingPermission && silentMs >= STALL_SILENCE_MS;
  const pid = readPid(name, logsDir);
  const alive = pid ? pidAlive(pid) : null;
  const lastKind = lastKindOf(last, tail);
  // Seulement si la question est ENCORE ouverte : avant 0.25.0 le texte de la
  // dernière question restait remonté pendant le tour suivant et après un
  // acquittement (fleet-status affichait « needs: … » indéfiniment).
  const needs = state === 'input' ? /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(lastAssistantText || '') : null;
  const turnElapsedMs = inFlight && turnStartTs ? (now - turnStartTs) : null;
  const lastTurn = lastTurnOf(lines);
  // Le `result` du CLI n'est pas horodaté : s'il est le dernier événement, sa
  // fin est l'écriture du log (approximation, signalée par endedAtApprox).
  if (lastTurn && lastTurn.endedAt == null && last?.type === 'result' && mtimeMs) {
    lastTurn.endedAt = mtimeMs;
    lastTurn.endedAtApprox = true;
  }
  const missionEv = lastMissionPrompt(lines);
  const mission = missionEv
    ? (String(missionEv.text || '').split('\n').map(s => s.trim()).find(Boolean) || '').slice(0, 120) || null
    : null;

  return {
    name,
    state,
    // Additive: finished but waiting on a chef decision (state stays `unread`).
    awaitingChef,
    // Additif 0.45.0 : {id, tool, preview, deadline, risk, count} tant qu'une
    // demande d'autorisation attend l'utilisateur (l'état reste `live`).
    awaitingPermission,
    stalled,
    // Dead process while the log still says a turn is running — a stronger,
    // separate stall signal (the child was SIGKILLed or crashed silently).
    deadInFlight: inFlight && pid != null && alive === false,
    lastKind,
    activity: activityPreview(last, lastAssistantText),
    silentMs,
    fileSilentMs,
    turnElapsedMs,
    sizeBytes: size,
    pid,
    pidAlive: alive,
    model: model || null,
    provider: provider || null,
    needsInput: needs ? needs[1].trim().slice(0, 160) : null,
    // Additif : dernier acquittement (« répondue via le chef »), pour l'UI.
    questionResolved: resolution,
    // Additifs 0.31.0 : arrêt par le chef ({by, reason, ts}) tant que l'état
    // est `error`, et dernier « vu » (acquittement d'un échec / arrêt).
    stopped,
    acknowledged,
    // Additifs 0.29.0 (vue « Projets »). `lastActivitySource: 'mtime'` = l'âge
    // n'est qu'une approximation (aucun événement horodaté dans la fenêtre).
    lastActivityAt: lines.length ? (lastMeaningfulTs || null) : null,
    lastActivitySource: !lines.length ? null : (last?.timestamp ? 'event' : 'mtime'),
    lastTurn,
    mission,
    // Rapport promis : seulement pendant le tour qui l'a demandé.
    callbackTo: inFlight && typeof missionEv?.callback === 'string' ? missionEv.callback : null,
  };
}
