#!/usr/bin/env node
// Row of GET /api/pipeline-runs (scripts/pipeline-run-view.mjs): a paused run
// carries its pause menu (cause, choices, recommendation) so a client without
// Markdown parsing (the Android app 1.0.0) can show the choices as buttons.
import { runView } from './pipeline-run-view.mjs';

let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ok  ${name}`); } else { ko++; console.log(`  KO  ${name} ${extra}`); } };

const base = { run: 'p-20261020T100000-abcdef', project: 'omega', pipeline: 'dev', mode: 'leger', status: 'running', createdAt: '2026-10-20T10:00:00Z',
  steps: [{ id: 'rouge', key: '01-rouge', title: 'Rouge', slot: 'dev.rouge', model: 'claude-opus-5-5', status: 'refused', why: 'x'.repeat(500), durationMs: 12 }] };

const r1 = runView(base);
t('fields kept', r1.run === base.run && r1.project === 'omega' && r1.pipeline === 'dev' && r1.mode === 'leger' && r1.status === 'running');
t('why cut at 300', r1.steps[0].why.length === 300);
t('running run: no pause', r1.pause === null);
t('endedAt null by default', r1.endedAt === null);

const diagnosis = { at: '2026-10-20T10:05:00Z', limit: 'criteria', step: 'rouge', kind: 'test_passes', transient: false,
  cause: 'le test passe déjà sur le code actuel', source: 'code', evidence: [{ text: 'secret evidence' }],
  options: [
    { key: 'corriger le test', does: 'je relance « Rouge » avec la consigne…', effect: { message: 'INTERNAL' } },
    { key: 'abandonner', does: 'j’arrête et je ne livre rien' },
  ],
  recommend: { key: 'corriger le test', why: 'c’est le test qui ne vérifie pas ce qui manque' } };
const r2 = runView({ ...base, status: 'paused', question: 'omega en pause — répondez…', diagnosis });
t('paused run: pause present', !!r2.pause);
t('pause cause', r2.pause?.cause === diagnosis.cause && r2.pause?.kind === 'test_passes' && r2.pause?.transient === false);
t('pause options keys and does', JSON.stringify(r2.pause?.options) === JSON.stringify([
  { key: 'corriger le test', does: 'je relance « Rouge » avec la consigne…', recommended: true },
  { key: 'abandonner', does: 'j’arrête et je ne livre rien', recommended: false }]), JSON.stringify(r2.pause?.options));
t('internal effect never exposed', !JSON.stringify(r2).includes('INTERNAL') && !JSON.stringify(r2).includes('secret evidence'));
t('recommendation', r2.pause?.recommend?.key === 'corriger le test' && /ne vérifie pas/.test(r2.pause?.recommend?.why));
t('question kept', r2.question === 'omega en pause — répondez…');

// A stale diagnosis of a run that resumed and finished is not a pause.
t('done run with old diagnosis: no pause', runView({ ...base, status: 'done', diagnosis }).pause === null);
// A paused run without diagnosis (older engine): pause with the question only.
const r3 = runView({ ...base, status: 'paused', question: 'q ?' });
t('paused without diagnosis: options empty', r3.pause && r3.pause.options.length === 0 && r3.pause.cause === null);
// Options with an unknown or empty key are dropped.
const r4 = runView({ ...base, status: 'paused', diagnosis: { ...diagnosis, options: [{ key: '', does: 'x' }, { key: 'continuer', does: '' }, { key: 'continuer', does: 'je reprends' }] } });
t('invalid options dropped', r4.pause.options.length === 1 && r4.pause.options[0].key === 'continuer');

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
