#!/usr/bin/env node
// ============================================================================
// scripts/_test_review_doc_nonblocking.mjs — doc-only review findings do not
// loop the Review: after one correction round they go to the delivery notes
// ============================================================================
//
// User request (2026-10-27), verbatim: « il faut améliorer l'orchestrateur si
// il pose des problèmes ». Observed: the Review looped on points with no effect
// for the user (CHANGELOG wording, a docstring, the report). A finding that
// only concerns documentation, a comment, the CHANGELOG or the report (the
// review model's `delivery` side) goes to the delivery notes without blocking,
// after ONE correction round at most. Findings on code or tests (`items`) keep
// blocking (0.65.0), and so does a mixed review. The last test checks that the
// kept notes reach the prompt of the program delivery (Livrer, release mode).
//
//   node scripts/_test_review_doc_nonblocking.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyDocFindingsPolicy } from './review-doc-policy.mjs';

const docs = ['préciser le commentaire de parseItems', 'reformuler l’entrée du CHANGELOG'];

test('first round: doc-only findings still cause one correction round', () => {
  const r = applyDocFindingsPolicy({ items: [], delivery: docs }, 0);
  assert.deepEqual(r.blocking.delivery, docs);
  assert.equal(r.blocking.verdict, 'problemes');
  assert.deepEqual(r.notes, []);
});

test('after one round: doc-only findings go to the delivery notes and do not block', () => {
  const r = applyDocFindingsPolicy({ items: [], delivery: docs }, 1);
  assert.deepEqual(r.blocking.delivery, []);
  assert.equal(r.blocking.verdict, 'ok');
  assert.deepEqual(r.notes, docs);
});

test('code/test findings keep blocking whatever the round', () => {
  const r = applyDocFindingsPolicy({ items: ['crash sur liste vide'], delivery: [] }, 3);
  assert.deepEqual(r.blocking.items, ['crash sur liste vide']);
  assert.equal(r.blocking.verdict, 'problemes');
  assert.deepEqual(r.notes, []);
});

test('mixed review keeps blocking on the code finding', () => {
  const r = applyDocFindingsPolicy({ items: ['crash sur liste vide'], delivery: docs }, 2);
  assert.deepEqual(r.blocking.items, ['crash sur liste vide']);
  assert.deepEqual(r.blocking.delivery, docs);
  assert.equal(r.blocking.verdict, 'problemes');
  assert.deepEqual(r.notes, []);
});

// The notes must reach the model that writes the delivery text. `stepPrompt`
// is not exported, so it is read through a throwaway copy of the engine that
// re-exports it. The copy lives in the OS temp dir (a suite never writes into
// the repository): its relative imports are rewritten to absolute file URLs.
test('program delivery (release mode) tells the model about the doc notes', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-doc-'));
  const copy = path.join(tmp, 'engine.mjs');
  const abs = (rel) => pathToFileURL(path.resolve(here, rel)).href;
  const src = fs.readFileSync(path.join(here, 'pipeline-engine.mjs'), 'utf8')
    .replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (_m, pre, q, rel) => `${pre}${q}${abs(rel)}${q}`);
  fs.writeFileSync(copy, `${src}
export { stepPrompt as __stepPrompt };
`);
  try {
    const { __stepPrompt } = await import(pathToFileURL(copy).href);
    const note = 'NOTE-DOC-UNIQUE reformuler le commentaire de parseItems';
    const ctx = { run: 'p-20261029T000000-aaaaaa', pipeline: 'dev', mode: 'complet', artDir: path.join(tmp, 'art'), cfg: {},
      deliveryMode: 'release', release: { delivered: [], aside: [] }, deliveryNotes: [{ item: 1, description: note }] };
    const step = { id: 'livrer', title: '6 Livrer', artefact: 'livraison.md' };
    const text = __stepPrompt(ctx, step, null);
    assert.match(text, /LIVRAISON=texte/);
    assert.ok(text.includes(note), 'the delivery-text prompt must carry the non-blocking doc findings');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
