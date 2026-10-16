// ============================================================================
// scripts/report-check.mjs — the code checks the ids in the chef's report
// (0.92.0)
// ============================================================================
//
// Task 4/4 of the mechanism validated after 2026-10-13, when the chef named a
// waiting Routage task from memory with the wrong id (5383dd61 instead of
// 75627914) and the mistake was repeated from answer to answer: the rule « ne
// devine rien, cite ce que tu vois » was enforced by no code. Before the
// Routage report (request and wake-up modes) is sent, every id it writes is
// looked up, and the report is annotated in place:
//   - a waiting Routage task (8 hex characters) known to the registry: its
//     official title is added next to it when the report does not show it;
//   - one that the registry does not know: flagged;
//   - an id whose attached label (« … », (…), " — …") matches ANOTHER entry's
//     title and not its own: flagged as contradictory, naming the right id;
//   - queue entries (q-<digits>-<hex>) and pipeline runs (p-…): flagged when
//     unknown (their formats are unambiguous, so this is safe).
// Nothing is removed from the report: the reader sees what the model wrote
// and what the code checked.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { readPending, idOf, titleOf, cleanTitle } from './routage-pending.mjs';

const HEX8_RE = /(?<![0-9A-Za-z_./#-])([0-9a-f]{8})(?![0-9A-Za-z_-])/g;
const QUEUE_ID_RE = /(?<![\w-])(q-\d{10,16}-[0-9a-f]{3,8})(?![\w-])/g;
const RUN_ID_RE = /(?<![\w-])(p-\d{8}T\d{6}-[0-9a-f]{6})(?![\w-])/g;
// A git sha or a colour is not a task: skip 8-hex words right after these.
const NOT_A_TASK_BEFORE = /(commit|sha|hash|couleur|color|tree|blob)\s*[:=]?\s*`?$/i;

const norm = (s) => cleanTitle(String(s || '').replace(/^↳\s*/, '')).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The label written right after an id: « … », "…", (…), or " — …" / " : …" up to punctuation. */
export function labelAfter(text, end) {
  const rest = text.slice(end, end + 160);
  const m = /^\s*(?:«\s*([^»\n]{2,100}?)\s*»|"([^"\n]{2,100})"|\(([^)\n]{2,100})\)|\s*(?:—|–|:)\s*([^.;,\n«(]{3,80}))/.exec(rest);
  return m ? (m[1] || m[2] || m[3] || m[4] || '').trim() : null;
}

/** Whether a written label designates this entry (its title or its rattache). */
function labelFits(label, t) {
  const l = norm(label);
  if (l.length < 3) return false;
  return [titleOf(t).titre, t.rattache].map(norm).filter(x => x.length >= 3).some(k => k.includes(l) || l.includes(k));
}

function knownQueueIds(logsDir) {
  const ids = new Map();
  let files = [];
  try { files = fs.readdirSync(path.join(logsDir, 'queue')).filter(f => f.endsWith('.json')); } catch { return ids; }
  for (const f of files) {
    try { for (const e of JSON.parse(fs.readFileSync(path.join(logsDir, 'queue', f), 'utf8'))) if (e?.id) ids.set(e.id, f.replace(/\.json$/, '')); } catch { /* unreadable queue: ignored */ }
  }
  return ids;
}
// An id written as an identifier mark [[…]] (0.107.0): the note goes after the mark.
const afterMark = (src, at) => (src.startsWith(']]', at) ? at + 2 : at);
const runExists = (logsDir, run) => fs.existsSync(path.join(logsDir, 'runs', run, 'run.json'));

/**
 * → {text, findings: [{kind: 'titled'|'unknown'|'contradiction'|'unknown-queue'|'unknown-run', id, …}]}
 * `pending` / `queueIds` / `runExists` are injectable for tests.
 */
export function checkReportIds(text, { logsDir, pending = null, queueIds = null, hasRun = null } = {}) {
  const src = String(text || '');
  const tasks = pending || (logsDir ? readPending(logsDir) : []);
  const byId = new Map(tasks.map(t => [idOf(t), t]));
  const queues = queueIds || (logsDir ? knownQueueIds(logsDir) : new Map());
  const runOk = hasRun || ((r) => (logsDir ? runExists(logsDir, r) : true));
  const findings = [];
  const inserts = [];   // {at, note}

  for (const m of src.matchAll(HEX8_RE)) {
    const id = m[1];
    const at = afterMark(src, m.index + id.length);
    if (NOT_A_TASK_BEFORE.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    const t = byId.get(id);
    const label = labelAfter(src, at);
    if (!t) {
      // An id of the registry may be all digits; an UNKNOWN one is only taken
      // for a task id when it mixes digits and letters (not a plain number).
      if (!/[a-f]/.test(id) || !/\d/.test(id)) continue;
      findings.push({ kind: 'unknown', id, label });
      inserts.push({ at, note: ' ⚠ [contrôle : identifiant absent du registre des tâches en attente — déjà lancée, retirée, ou erreur]' });
      continue;
    }
    const own = titleOf(t).titre;
    if (label && !labelFits(label, t)) {
      const other = tasks.find(o => o !== t && labelFits(label, o));
      if (other) {
        findings.push({ kind: 'contradiction', id, label, title: own, rightId: idOf(other), rightTitle: titleOf(other).titre });
        inserts.push({ at, note: ` ⚠ [contrôle : ${id} est « ${own} », pas « ${label} » — « ${label} » est ${idOf(other)} « ${titleOf(other).titre} »]` });
        continue;
      }
    }
    // Known and coherent: name it, unless its title is already written there.
    if (!(label && labelFits(label, t))) {
      findings.push({ kind: 'titled', id, title: own });
      inserts.push({ at, note: ` « ${own} »` });
    }
  }
  for (const m of src.matchAll(QUEUE_ID_RE)) {
    if (queues.has(m[1])) continue;
    findings.push({ kind: 'unknown-queue', id: m[1] });
    inserts.push({ at: afterMark(src, m.index + m[1].length), note: ' ⚠ [contrôle : absent des files d’attente — déjà lancé, retiré, ou erreur]' });
  }
  for (const m of src.matchAll(RUN_ID_RE)) {
    if (runOk(m[1])) continue;
    findings.push({ kind: 'unknown-run', id: m[1] });
    inserts.push({ at: afterMark(src, m.index + m[1].length), note: ' ⚠ [contrôle : exécution inconnue]' });
  }
  let out = src;
  for (const ins of inserts.sort((a, b) => b.at - a.at)) out = out.slice(0, ins.at) + ins.note + out.slice(ins.at);
  const bad = findings.filter(f => f.kind !== 'titled');
  if (bad.length) {
    out += `\n\n**Contrôle des identifiants par l’orchestrateur** : ${bad.length} point(s) à vérifier — ` +
      bad.map(f => f.kind === 'contradiction' ? `${f.id} décrit comme « ${f.label} », qui est ${f.rightId}` : `${f.id} inconnu`).join(' ; ') + '.';
  }
  return { text: out, findings };
}
