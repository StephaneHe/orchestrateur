#!/usr/bin/env node
// ============================================================================
// scripts/_test_report_check.mjs — the code checks every id written in the
// chef's Routage report (0.92.0)
// ============================================================================
//
// Incident (2026-10-13): the chef named a waiting Routage task from memory by
// the wrong id (5383dd61 instead of 75627914) and the mistake was repeated
// from answer to answer; « ne devine rien, cite ce que tu vois » was enforced
// by no code. The user validated a 4-task mechanism, verbatim: « Lances les
// taches ». This is task 4/4: THE CODE CHECKS THE CHEF'S REPORT.
//
// Protected:
//   1. checkReportIds: a known waiting task gets its official title; an
//      unknown id is flagged; the case of 2026-10-13 (5383dd61 described as
//      « glisser-déposer », which is 75627914) is flagged as contradictory
//      and names the right id; a coherent label is left alone; a commit sha
//      is not taken for a task; unknown queue (q-…) and run (p-…) ids are
//      flagged, known ones are not;
//   2. the method rule is in the instructions of every Routage step that
//      writes;
//   3. end to end: a chef turn whose report contains the incident's sentence
//      ends with the annotated report and a system/report_check event.
//
//   node scripts/_test_report_check.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RP from './routage-pending.mjs';
import * as E from './pipeline-engine.mjs';
import { checkReportIds } from './report-check.mjs';
import { catalogSteps, ID_METHOD_RULE } from './pipeline-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const after = { projet: 'R', offset: 0, hash: RP.textHash('x') };
const PENDING = [
  { id: '5383dd61', run: 'p-20261013T153043-b3a351', n: 3, projet: 'Q', demande: 'Édition d’un élément de file tant qu’il n’est pas traité.', rattache: 'Tâche 3/4 : édition tant que non traité', after },
  { id: '75627914', run: 'p-20261013T153043-b3a351', n: 4, projet: 'Q', demande: 'Glisser-déposer des éléments de la file.', rattache: 'Tâche 4/4 : glisser-déposer', after },
  { id: 'a1b2c3d4', run: 'p-20261014T080000-cccccc', n: 1, projet: 'R', titre: 'journal : durée', demande: 'Corrige la durée du journal.', after },
];
const QUEUES = new Map([['q-1791966036774-83c6', 'Q']]);
const RUNS = new Set(['p-20261013T153043-b3a351']);
const check = (text) => checkReportIds(text, { pending: PENDING, queueIds: QUEUES, hasRun: (r) => RUNS.has(r) });

// ---------------------------------------------------------------------------
section('1. Contrôle des identifiants d’un rapport');
let r = check('La tâche 75627914 attend la fin de Q.');
ok(r.text.includes('75627914 « ↳ Tâche 4/4 : glisser-déposer »') && r.findings[0]?.kind === 'titled', 'identifiant connu : complété par son titre officiel', r.text);
r = check('La tâche 75627914 « glisser-déposer » attend.');
ok(r.text === 'La tâche 75627914 « glisser-déposer » attend.' && !r.findings.length, 'titre déjà écrit et cohérent : rien n’est ajouté', r.text);
r = check('Je relance 9f8e7d6c dès que possible.');
ok(/9f8e7d6c ⚠ \[contrôle : identifiant absent du registre/.test(r.text) && r.findings[0]?.kind === 'unknown' && /Contrôle des identifiants par l’orchestrateur/.test(r.text), 'identifiant inconnu : signalé dans le texte et en fin de rapport', r.text);
// The real sentence of 2026-10-13.
r = check('Il reste 5383dd61 « glisser-déposer » à relancer.');
const c = r.findings.find(f => f.kind === 'contradiction');
ok(c && c.id === '5383dd61' && c.rightId === '75627914', 'cas du 2026-10-13 : 5383dd61 décrit comme « glisser-déposer » → contradiction, la bonne entrée est 75627914', JSON.stringify(r.findings));
ok(r.text.includes('5383dd61 est « ↳ Tâche 3/4 : édition tant que non traité », pas « glisser-déposer » — « glisser-déposer » est 75627914'), 'la contradiction est écrite en clair à côté de l’identifiant', r.text);
r = check('5383dd61 (glisser-déposer) et 75627914 — édition tant que non traité.');
ok(r.findings.filter(f => f.kind === 'contradiction').map(f => f.id).join() === '5383dd61,75627914', 'aussi entre parenthèses et après un tiret, dans les deux sens', JSON.stringify(r.findings));
r = check('Livré au commit abc12345, sha 1234abcd.');
ok(!r.findings.length && r.text === 'Livré au commit abc12345, sha 1234abcd.', 'un sha de commit n’est pas pris pour une tâche');
r = check('File : q-1791966036774-83c6 puis q-1791966036999-ffff ; exécutions p-20261013T153043-b3a351 et p-20261014T999999-abcdef.');
ok(r.findings.map(f => `${f.kind}:${f.id}`).join() === 'unknown-queue:q-1791966036999-ffff,unknown-run:p-20261014T999999-abcdef', 'file et exécution : seules les inconnues sont signalées', JSON.stringify(r.findings));

// ---------------------------------------------------------------------------
section('2. Règle de méthode dans les consignes du Routage');
const steps = catalogSteps('routage');
ok(['lire', 'comprendre', 'decomposer', 'callback', 'rapporter'].every(id => steps.find(s => s.id === id)?.role.includes(ID_METHOD_RULE)), 'Lire, Comprendre, Découper, Callback et Rapporter portent la règle');
ok(/relu son entrée dans ce tour/.test(ID_METHOD_RULE) && /identifiant « titre »/.test(ID_METHOD_RULE), 'la règle : relire l’entrée dans le tour, toujours « identifiant « titre » »');

// ---------------------------------------------------------------------------
section('3. Bout en bout : le rapport du chef sort annoté, avec un événement report_check');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reportcheck-'));
const LOGS = path.join(T, 'logs');
for (const d of ['logs', 'chef', 'Q', 'R']) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.writeFileSync(path.join(T, 'chef', 'CLAUDE.md'), '# Chef\n');
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: ['chef', 'Q', 'R'].map(n => ({ name: n, path: path.join(T, n) })) }));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, history: [], enforcement: { projects: [], pipelines: E.ENGINE_PIPELINES, chef: true },
  assignments: Object.fromEntries(['lire', 'classifier', 'decomposer', 'rapporter'].map(s => [`routage.${s}`, { provider: 'anthropic', model: 'claude-haiku-5-5' }])) }));
RP.writePending(LOGS, PENDING);
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_NO_PENDING_RELEASE: '1',
  FAKE_PIPE_JSON: JSON.stringify({ comprendre: { nature: 'reponse', sens: 'où en sont les tâches', raison: 'question sur l’état' } }),
  FAKE_PIPE_REPORT: '# Rapport\n\nIl reste 5383dd61 « glisser-déposer » à relancer, et 75627914 attend.\n' };
for (const k of ['ANTHROPIC_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ORCH_HANDOFF_TOKEN', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'DISPATCH_REPORT_ONLY', 'ORCH_TEST_LABEL']) delete env[k];
const x = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'chef', 'Où en sont les tâches en attente ?', '--test', 'controle-rapport'], { env, encoding: 'utf8', timeout: 180_000, windowsHide: true });
let evs = []; try { evs = fs.readFileSync(path.join(LOGS, 'chef.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
const result = evs.filter(e => e.type === 'result').pop()?.result || '';
ok(x.status === 0 && result.includes('5383dd61 ⚠ [contrôle : 5383dd61 est « ↳ Tâche 3/4 : édition tant que non traité », pas « glisser-déposer » — « glisser-déposer » est 75627914'), 'le rapport envoyé porte la contradiction repérée par le code', `${result}\n---\n${(x.stdout || '').slice(-400)}${(x.stderr || '').slice(-400)}`);
ok(result.includes('75627914 « ↳ Tâche 4/4 : glisser-déposer » attend'), 'et le titre officiel de l’identifiant cité seul');
const ev = evs.find(e => e.subtype === 'report_check');
ok(ev && ev.findings.some(f => f.kind === 'contradiction' && f.rightId === '75627914') && ev.findings.some(f => f.kind === 'titled' && f.id === '75627914'), 'événement system/report_check avec les constats', JSON.stringify(ev));
ok(RP.readPending(LOGS).length === 3, 'le registre des tâches en attente n’est pas touché');
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
