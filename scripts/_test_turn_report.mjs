#!/usr/bin/env node
// ============================================================================
// scripts/_test_turn_report.mjs — a musician's end-of-turn report reaches the
// chef WHOLE (0.100.3, TODO t-a7f8ca)
// ============================================================================
//
// User, verbatim (2026-10-13): « pourquoi certains comptes rendus sont coupes ?
// A verifier et corriger ». Reports of orchestrateur-dev reached the chef cut
// before the number of tests passed: the chef read « résultat : [p] Tour
// terminé. … ⚠ [résumé coupé : 274 caractères sur 1031 …] ». Cause: server.js
// put summarizeResult (LAST paragraph only, 280 characters — a card line) in
// the musician_done notification AND in the wake prompt; the Routage's
// conversation excerpt then gave the chef that line. Every earlier paragraph
// (the test count) was dropped, the last one cut.
//
// Protected:
//   1. the real shape: the full report keeps every paragraph, the test count
//      included; the card line stays short (and states its cut);
//   2. beyond REPORT_MAX the report is cut with an explicit notice and where
//      the whole is — never silently;
//   3. the wake prompt body is the full report (indented), the short line only
//      for items queued before 0.100.3;
//   4. the Routage's conversation excerpt shows the full report of a
//      notification, the short line for older notifications;
//   5. server.js wiring: every turn-end notification and every wake carries
//      `report`, and the wake prompt uses it.
//
//   node scripts/_test_turn_report.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from './turn-report.mjs';
import { conversationExcerpt } from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// Shape of the 2026-10-13 report: test count in a middle paragraph, a last
// paragraph of about 1,000 characters.
const REPORT = [
  'Correction livrée sur la branche dev (v0.99.9).',
  '## Vérifications\n| Étape | Résultat |\n|---|---|\n| Non-régression ciblée | 412 tests passés, 0 échec |',
  `Reste à décider : ${'la mise en prod attend le feu vert de l’utilisateur, rien d’autre n’est en suspens. '.repeat(12)}FIN-DU-RAPPORT`,
].join('\n\n');

// ---------------------------------------------------------------------------
section('1. Le cas du 2026-10-13 : le compte rendu complet garde le nombre de tests');
const ev = { type: 'result', result: REPORT };
const short = R.summarizeResult(ev);
const full = R.fullReport(ev);
ok(REPORT.length > 1000 && REPORT.length < R.REPORT_MAX, `compte rendu de ${REPORT.length} caractères`);
ok(!short.includes('412 tests passés') && /résumé coupé/.test(short), 'la ligne de carte, elle, est courte (et le dit) : c’est elle qui arrivait au chef', short);
ok(full === REPORT.trim(), 'compte rendu complet : intact, mise en forme comprise');
ok(full.includes('412 tests passés, 0 échec') && full.includes('FIN-DU-RAPPORT'), 'nombre de tests et fin du compte rendu présents');
ok(R.fullReport({ result: '' }) === '' && R.fullReport({}) === '' && R.fullReport(null) === '', 'pas de result : rien');

// ---------------------------------------------------------------------------
section('2. Au-delà de REPORT_MAX : coupe signalée, jamais silencieuse');
const HUGE = `DEBUT\n${'ligne du compte rendu. '.repeat(600)}\nFIN`;
const cut = R.fullReport({ result: HUGE }, { where: 'logs/x.jsonl (dernier result)' });
const m = /⚠ \[compte rendu tronqué par l’orchestrateur : (\d+) caractères sur (\d+) — texte complet : logs\/x\.jsonl \(dernier result\)\]$/.exec(cut);
ok(HUGE.length > R.REPORT_MAX && m && Number(m[2]) === HUGE.length && Number(m[1]) <= R.REPORT_MAX, 'coupe signalée avec les longueurs et où lire le tout', cut.slice(-200));
ok(/tronqué[^\]]*journal du musicien\]$/.test(R.fullReport({ result: HUGE })), 'sans emplacement : renvoie au journal du musicien');

// ---------------------------------------------------------------------------
section('3. Réveil du chef : le corps est le compte rendu complet');
const body = R.wakeItemBody({ summary: short, report: full });
ok(body.includes('412 tests passés') && body.includes('FIN-DU-RAPPORT') && !/résumé coupé/.test(body), 'corps du réveil = compte rendu complet', body.slice(0, 300));
ok(body.split('\n').every(l => l.startsWith('  ')), 'chaque ligne est indentée sous son musicien');
ok(R.wakeItemBody({ summary: 'ligne courte' }) === '  ligne courte', 'élément mis en attente avant 0.100.3 : la ligne courte');
ok(R.wakeItemBody({}) === '', 'rien à dire : corps vide');

// ---------------------------------------------------------------------------
section('4. Extrait de conversation du Routage : le compte rendu complet');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-turnrep-'));
const LOG = path.join(T, 'chef.jsonl');
fs.writeFileSync(LOG, [
  { type: 'notification', subtype: 'musician_done', source: 'p', outcome: 'done', text: `[p] Tour terminé. ${short}`, summary: short, report: full },
  { type: 'notification', subtype: 'musician_done', source: 'old', outcome: 'done', text: '[old] Tour terminé. Ancienne ligne courte.', summary: 'Ancienne ligne courte.' },
].map(e => JSON.stringify(e)).join('\n') + '\n');
const x = conversationExcerpt(LOG);
ok(x.includes('**résultat** : [p] Tour terminé.\n\n') && x.includes('412 tests passés, 0 échec') && x.includes('FIN-DU-RAPPORT'), 'notification 0.100.3 : en-tête puis compte rendu complet', x);
ok(!x.includes('résumé coupé'), 'la ligne courte coupée n’est plus ce que lit le chef');
ok(x.includes('**résultat** : [old] Tour terminé. Ancienne ligne courte.'), 'ancienne notification (sans report) : lue telle quelle');
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }

// ---------------------------------------------------------------------------
section('5. Câblage de server.js');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
ok(!/function summarizeResult\(/.test(src) && /from '\.\/scripts\/turn-report\.mjs'/.test(src), 'une seule définition, celle de turn-report.mjs');
const calls = [...src.matchAll(/autoNotifyConductor\(name, \{[\s\S]*?\}\);/g)].map(r => r[0]);
ok(calls.length === 3 && calls.every(c => /report: turnReport\(name, ev\)/.test(c)), `chaque notification de fin de tour porte le compte rendu (${calls.length} appels)`, calls.join('\n'));
const wakeCall = /scheduleConductorWake\(\{[\s\S]*?\}\);/.exec(src)?.[0] || '';
ok(/report: turnReport\(name, ev\)/.test(wakeCall), 'chaque réveil porte le compte rendu', wakeCall);
ok(/const body = wakeItemBody\(it\);/.test(src), 'le prompt de réveil utilise le compte rendu');
ok(/\.\.\.\(report && report !== summary \? \{ report \} : \{\}\)/.test(src), 'la notification enregistre le champ report');

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
