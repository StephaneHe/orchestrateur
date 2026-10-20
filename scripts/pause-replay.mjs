#!/usr/bin/env node
// ============================================================================
// scripts/pause-replay.mjs — real past pauses: the menu offered then, the menu now
// ============================================================================
//
// Read-only. Walks the musicians' logs of a logs folder, takes every pipeline
// pause (notification/pipeline_limit), the menu the user was offered then (the
// « … » words of the NEEDS_USER_INPUT line that followed) and what the smart
// pause (pause-diagnosis.mjs, 0.122.0) offers for the same facts. No model is
// called: a cause the code cannot establish is shown as such.
//
//   node scripts/pause-replay.mjs [--logs <dir>] [--limit criteria,items…] [--md <file>] [--json] [--max N]
//
// The output may name private projects: write it outside the repository's
// tracked files (default: stdout).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnosePause, smartMenu, fixMenu, checkMenu } from './pause-diagnosis.mjs';
import { orchArtefactNames } from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Menu words quoted in a pause question (« continuer », « abandonner »…). */
export function oldMenuOf(text) {
  const line = (/NEEDS_USER_INPUT:\s*([^\n]*)/.exec(String(text || '')) || [])[1] || String(text || '');
  const head = line.split(/\s:\s/)[0];
  return [...head.matchAll(/«\s*([^»]{2,40}?)\s*»/g)].map(m => m[1]).filter((w, i, a) => a.indexOf(w) === i && !/^je recommande/.test(w));
}

/** Pauses found in one JSONL log: the event, then the question that followed. */
export function pausesInLog(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e?.type !== 'notification' || e.subtype !== 'pipeline_limit') continue;
    let question = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
      let x; try { x = JSON.parse(lines[j]); } catch { continue; }
      const t = x?.type === 'assistant' ? (x.message?.content || []).map(b => b?.text || '').join('\n') : x?.type === 'result' ? String(x.result || '') : '';
      if (/NEEDS_USER_INPUT:/.test(t)) { question = t; break; }
    }
    out.push({ at: e.timestamp || null, run: e.pipeline?.run || null, step: e.pipeline?.step || null, limit: e.limit, value: e.value, why: e.why || '', lastOutput: e.lastOutput || '', question });
  }
  return out;
}

/** The smart menu for a recorded pause (facts of the event only, no model). */
export function replayPause(p, { files = [] } = {}) {
  const d = diagnosePause({ limit: p.limit, step: p.step ? { id: p.step, label: p.step } : null, why: p.why, testOutput: p.lastOutput, providerError: p.limit === 'model_unavailable' ? p.why : undefined,
    written: p.limit === 'item_tests' ? p.value : undefined, itemsDone: p.limit === 'items' && /après \d+ items/.test(p.why) ? Number(/après (\d+)/.exec(p.why)[1]) : 0,
    itemsLeft: p.limit === 'items' ? [{ n: 1, text: (/suivant : « ([^»]+)/.exec(p.why) || [])[1] || '…' }] : [], files, orchNames: orchArtefactNames() });
  const menu = fixMenu(d, smartMenu(d, { step: p.step ? { id: p.step, label: p.step } : null }));
  return { d, menu, problems: checkMenu(d, menu) };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const logs = path.resolve(opt('--logs') || path.join(ROOT, 'logs'));
  const only = opt('--limit') ? new Set(opt('--limit').split(',')) : null;
  const max = Number(opt('--max')) || 200;
  const files = [];
  for (const f of fs.readdirSync(logs)) if (f.endsWith('.jsonl')) files.push(path.join(logs, f));
  try { for (const p of fs.readdirSync(path.join(logs, 'lanes'))) for (const f of fs.readdirSync(path.join(logs, 'lanes', p))) if (f.endsWith('.jsonl')) files.push(path.join(logs, 'lanes', p, f)); } catch { /* no lanes */ }
  const rows = [];
  for (const f of files) {
    let lines; try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    for (const p of pausesInLog(lines)) {
      if (only && !only.has(p.limit)) continue;
      const r = replayPause(p);
      rows.push({ log: path.basename(f, '.jsonl'), ...p, before: oldMenuOf(p.question), after: r.menu.options.map(o => o.key), recommend: r.menu.recommend, cause: r.d.cause, kind: r.d.kind, problems: r.problems });
    }
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const shown = rows.slice(0, max);
  if (args.includes('--json')) { console.log(JSON.stringify(shown, null, 2)); return; }
  const md = ['# Pauses réelles rejouées — menu d’avant, menu d’après', '', `${rows.length} pause(s) trouvée(s) dans ${logs}${rows.length > max ? ` (les ${max} plus récentes)` : ''}.`, '',
    ...shown.flatMap(r => [`## ${r.at || '?'} — ${r.limit}${r.step ? `, étape ${r.step}` : ''} (${r.log})`, '', `- Motif enregistré : ${String(r.why).split('\n')[0].slice(0, 240) || '—'}`,
      `- **Avant** : ${r.before.length ? r.before.map(w => `« ${w} »`).join(', ') : '(question non retrouvée)'}`,
      `- **Cause (après)** [${r.kind}] : ${r.cause}`,
      `- **Après** : ${r.after.map(w => `« ${w} »`).join(', ')} — recommandé « ${r.recommend.key} » : ${r.recommend.why}`,
      ...(r.problems.length ? [`- ⚠ ${r.problems.join(' ; ')}`] : []), ''])];
  const out = md.join('\n');
  if (opt('--md')) { fs.writeFileSync(opt('--md'), out); console.log(`[pause-replay] ${shown.length} pause(s) → ${opt('--md')}`); } else console.log(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
