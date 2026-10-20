// ============================================================================
// scripts/cited-paths.mjs — cited paths judged on what the turn really read
// ============================================================================
//
// Pipeline redesign, phase 0, lever 1 (docs/PIPELINES-SYNTHESE.md §6.2,
// switch `citedPathsLog`). Before it, a judge step (Discussion › Comprendre,
// Incident › Détecter…) was refused when a path cited between backquotes did
// not exist in the project: 7 Discussion runs out of 10 lost a whole model
// turn on it, never for an invented file — a file of another project the turn
// had read, a bare file name whose full path exists, a run artefact
// (`rouge.md`, `taches.json`), a stack frame of the Python library seen in a
// test output, an event type of the orchestrator (`system/init`).
//
// Rule kept: a positive claim about a file of the project is still checked on
// the disk. What changes: a path is also accepted when the turn OBSERVED it
// (a Read that succeeded, or the output of a tool: Glob, Grep, a command), and
// names of the orchestrator itself, elided paths (`…`) and paths of another
// folder are reported — never a refusal. Bash command LINES do not count as
// observations (a command can name a file that does not exist).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

const STRIP = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ABSENT_RE = /(\bni\b|\bpas d|\baucun|\bsans\b|absent|n.existe pas|inexistant|manqu|\bmissing\b|\bno\b|\bnot\b|does not exist|n.y a pas|a creer|a ajouter)/;
const EVENT_RE = /^(system|notification|result|assistant|user|user_prompt)\/[a-z_]+$/;

/** Backquoted tokens that look like paths, with the line they are on. */
export function citedPathTokens(text) {
  const out = [];
  const s = String(text);
  for (const m of s.matchAll(/`([^`\n]{2,200})`/g)) {
    const p = m[1].trim().replace(/:\d+(-\d+)?$/, '');
    const looksPath = /^[\w.\-@]+([\\/][\w.\-@ ]+)+$/.test(p) || /^[\w.\-]+\.(m?js|cjs|ts|tsx|jsx|json|md|kt|kts|py|java|css|html|ya?ml|toml|txt|ps1|sh|gradle)$/i.test(p) || /^[A-Za-z]:[\\/]/.test(p);
    if (!looksPath || /^https?:/i.test(p) || /[*?]/.test(p)) continue;
    const start = s.lastIndexOf('\n', m.index) + 1;
    const end = s.indexOf('\n', m.index);
    out.push({ path: p, line: s.slice(start, end < 0 ? undefined : end) });
  }
  return out;
}

/** The line says the file is ABSENT (« ni `pyproject.toml` ni `setup.py` »): a correct observation. */
export function saysAbsent(line) {
  return ABSENT_RE.test(STRIP(String(line).replace(/`[^`\n]*`/g, ' ')));
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/**
 * What a step turn observed, from its stream-json log: the file_path of every
 * Read that succeeded, and the text of every successful tool result.
 * → { text: string (normalised, lower case), reads: string[] }
 */
export function observedInTurn(logFile) {
  let lines = [];
  try { lines = fs.readFileSync(logFile, 'utf8').split('\n'); } catch { return { text: '', reads: [] }; }
  const uses = new Map();
  const parts = [];
  const reads = [];
  for (const l of lines) {
    if (!l) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use') uses.set(b.id, b);
      else if (b?.type === 'tool_result' && !b.is_error) {
        const use = uses.get(b.tool_use_id);
        if (use?.name === 'Write' || use?.name === 'Edit' || use?.name === 'NotebookEdit') continue;
        if (use?.name === 'Read' && use.input?.file_path) reads.push(String(use.input.file_path));
        const c = b.content;
        parts.push(typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (typeof x?.text === 'string' ? x.text : '')).join('\n') : '');
      }
    }
  }
  return { text: norm([...reads, ...parts].join('\n')), reads };
}

function seenIn(observed, p) {
  const n = norm(p);
  if (!n || !observed.text) return false;
  let i = observed.text.indexOf(n);
  while (i >= 0) {
    const before = i === 0 ? '' : observed.text[i - 1];
    const after = observed.text[i + n.length] || '';
    if (!/[\w.\-]/.test(before) && !/[\w\-]/.test(after)) return true;
    i = observed.text.indexOf(n, i + 1);
  }
  return false;
}

/**
 * Verdict on the paths cited by an artefact.
 *   exists(rel|abs) → bool (default: the disk, relative to cwd)
 *   observed        → observedInTurn(stepLog)
 *   orchNames       → Set of lower-case artefact / log file names of the orchestrator
 * → { missing: [paths refused], reported: [{path, why}] (accepted, said) }
 */
export function judgeCitedPaths(text, cwd, { exists = null, observed = { text: '', reads: [] }, orchNames = new Set() } = {}) {
  const has = exists || ((p) => fs.existsSync(path.isAbsolute(p) ? p : path.join(cwd, p)));
  const missing = [], reported = [];
  const root = norm(path.resolve(cwd)) + '/';
  for (const { path: p, line } of citedPathTokens(text)) {
    if (has(p)) continue;
    if (saysAbsent(line)) continue;
    if (seenIn(observed, p)) { reported.push({ path: p, why: 'lu pendant le tour' }); continue; }
    const n = norm(p);
    if (n.includes('…') || n.includes('...')) { reported.push({ path: p, why: 'chemin abrégé' }); continue; }
    if (EVENT_RE.test(n)) { reported.push({ path: p, why: 'type d’événement de l’orchestrateur' }); continue; }
    if (orchNames.has(path.posix.basename(n)) && (!n.includes('/') || /(^|\/)(\.orchestrateur\/runs|logs)\//.test(n))) { reported.push({ path: p, why: 'artefact ou journal de l’orchestrateur' }); continue; }
    if (/^[a-z]:\//.test(n) && !n.startsWith(root)) { reported.push({ path: p, why: 'hors du projet' }); continue; }
    missing.push(p);
  }
  return { missing: [...new Set(missing)], reported: reported.filter((r, i, a) => a.findIndex(x => x.path === r.path) === i) };
}
