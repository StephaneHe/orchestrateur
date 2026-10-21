#!/usr/bin/env node
// ============================================================================
// scripts/pipeline-corpus-classify.mjs — the corpus classified by the REAL
// classifier model (pipelines phase 1, exit criterion, PIPELINES-SYNTHESE §8.2)
// ============================================================================
//
// _test_pipeline_corpus.mjs proves, offline, that a request classified into
// its generic runs and verifies its effect. This script measures the other
// half: does the real model of the `routage.classifier` case find that
// generic, by the meaning, with the switch `generic` on? One model call per
// case (subscription billing, no API key), a table, exit 1 on a miss.
// Outside the regression (it calls a real model); nothing is written.
//
//   node scripts/pipeline-corpus-classify.mjs [--model claude-sonnet-5] [--md <file>]
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classificationPrompt, parseClassification, classifierChoices } from './pipeline-classify.mjs';
import { oneShotClaude } from './language.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const model = opt('--model', 'claude-sonnet-5');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'pipeline-corpus', 'cases.json'), 'utf8'));

// Choices as the engine builds them with the switch on (the repository's
// pipelines, no accepted gap: a throwaway root without model-routing.json).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-corpus-cls-'));
const choices = classifierChoices(tmp, { generic: true });
const rows = [];
let misses = 0;
for (const c of corpus.cases) {
  const request = c.request.replace('{A}', 'D:\\Series\\Atelier').replace('{B}', 'D:\\Series\\Atekuer S01');
  const t0 = Date.now();
  const r = await oneShotClaude(classificationPrompt(request, {}, choices), { model, timeoutMs: 120_000 });
  const v = r.ok ? parseClassification(r.text, {}, choices) : null;
  const want = [c.expected, ...(c.accepted || [])];
  const hit = v && want.some(w => w.pipeline === v.pipeline && (!w.mode || w.mode === v.mode) && (!w.operation || !v.operations || v.operations.some(o => o.id === w.operation)) && (!w.operations || (v.operations || []).map(o => o.id).join() === w.operations.join()));
  if (!hit) misses++;
  rows.push(`| ${c.id} | ${c.before.pipeline} | ${c.expected.pipeline}${c.expected.mode ? ` / ${c.expected.mode}` : ''}${c.expected.operation ? ` / ${c.expected.operation}` : ''}${c.expected.operations ? ` / ${c.expected.operations.join(' + ')}` : ''} | ${v ? `${v.pipeline}${v.mode && !['leger', 'complet'].includes(v.mode) ? ` / ${v.mode}` : ''}${v.operations ? ` / ${v.operations.map(o => o.id).join(' + ')}` : ''}` : `✕ ${r.ok ? 'réponse illisible' : r.why}`} | ${hit ? '✓' : '✕'} | ${Math.round((Date.now() - t0) / 1000)} s | ${String(v?.raison || '').replace(/\|/g, '/').slice(0, 120)} |`);
  console.log(rows.at(-1));
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
const md = [`Classement du corpus par ${model} (interrupteur « generic » actif), ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '',
  '| cas | avant | attendu | classé | | durée | raison du model |', '|---|---|---|---|---|---|---|', ...rows, '', `${corpus.cases.length - misses}/${corpus.cases.length} au bon pipeline.`].join('\n');
if (opt('--md')) fs.writeFileSync(opt('--md'), `${md}\n`);
console.log(`\n${corpus.cases.length - misses}/${corpus.cases.length} au bon pipeline`);
process.exit(misses ? 1 : 0);
