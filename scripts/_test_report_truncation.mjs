#!/usr/bin/env node
// ============================================================================
// scripts/_test_report_truncation.mjs — a musician's report reaching the chef
// is never cut silently (0.93.0)
// ============================================================================
//
// Incident (2026-10-14): the report of the musician orchestrateur (5 entries
// removed from logs/routage-pending.json) reached the chef cut at « |
// 26cf9ce7 | orchestrateur-dev | attend », its « after » list missing, so the
// chef could not check the result. The whole 3,207-character report WAS in
// the chef's log (notify); the cut came from the excerpt the Routage gives its
// steps (conversationExcerpt): every message cut at 2,000 characters, the
// 30,000-character window cut in the middle of its oldest message, silently.
// User, verbatim: « c'est problematique. S'il n'y a pas de taches existantes
// qui investigue et corrige ce probleme, il faut en creer une ».
//
// Protected:
//   1. the real shape: a 3,207-character report with its « after » list at
//      the end reaches conversation.md WHOLE;
//   2. a report longer than the per-message limit is cut with an explicit
//      notice, and its whole text is written next to the excerpt (and read
//      back intact); without that directory, the notice points to the log line;
//   3. the window drops whole messages, never part of one, and says so;
//   4. a musician's message is labelled as such, never « utilisateur » (the
//      off-pipeline authorization only trusts the user's own lines);
//   5. the chef's context (contexte.md) states its cuts too;
//   6. the wake summary (server.js summarizeResult) states its cut.
//
//   node scripts/_test_report_truncation.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './pipeline-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-trunc-'));
const LOG = path.join(T, 'chef.jsonl');
const J = (evs) => evs.map(e => JSON.stringify(e)).join('\n') + '\n';
const rows = (n, tag) => Array.from({ length: n }, (_, i) => `| ${tag}${String(i).padStart(4, '0')} | orchestrateur-dev | attend orchestrateur-dev (relance n° ${i}) |`).join('\n');

// The real shape of 2026-10-14: before list, then the « after » list at the end.
const REPORT = `orchestrateur (prod) : les 5 entrées obsolètes d'orchestrateur-dev sont **retirées** du registre.\n\n## Liste avant (9 entrées)\n| Id | Projet | État |\n${rows(30, 'a')}\n| 26cf9ce7 | orchestrateur-dev | attend orchestrateur-dev (RELANCE de 4df9337e) |\n\n## Liste après (4 entrées)\n| Id | Projet | État |\n${rows(4, 'b')}\nFIN-DU-COMPTE-RENDU`;

// ---------------------------------------------------------------------------
section('1. Le cas du 2026-10-14 : le compte rendu arrive en entier');
fs.writeFileSync(LOG, J([
  { type: 'user_prompt', text: 'Retire les 5 entrées obsolètes du registre.' },
  { type: 'user_prompt', source: 'orchestrateur', text: REPORT },
  { type: 'user_prompt', source: 'wake', text: '[CALLBACK_WAKE lot=1 gen=1]\nrésumé' },
]));
ok(REPORT.length > 2000 && REPORT.length < E.EXCERPT_MESSAGE_MAX, `compte rendu de ${REPORT.length} caractères (au-delà de l’ancienne coupe à 2 000)`);
let x = E.conversationExcerpt(LOG, { fullDir: path.join(T, 'full1') });
ok(x.includes('## Liste après (4 entrées)') && x.includes('FIN-DU-COMPTE-RENDU') && x.includes('26cf9ce7 | orchestrateur-dev | attend orchestrateur-dev (RELANCE'), 'la liste « après » et la fin du compte rendu sont là', x.slice(-400));
ok(!/tronqué/.test(x), 'rien n’est coupé quand rien ne doit l’être');

// ---------------------------------------------------------------------------
section('2. Un compte rendu trop long : coupé AVEC un avis, texte complet à côté');
const LONG = `DEBUT\n${rows(260, 'c')}\n## Liste après\nFIN-LONGUE`;
fs.writeFileSync(LOG, J([{ type: 'user_prompt', source: 'orchestrateur', text: LONG }]));
const FULL = path.join(T, 'full2');
x = E.conversationExcerpt(LOG, { fullDir: FULL });
const m = /⚠ \[tronqué par l’orchestrateur : (\d+) caractères affichés sur (\d+) — texte complet : (.+?) \(à lire avec Read\)\]/.exec(x);
ok(LONG.length > E.EXCERPT_MESSAGE_MAX && m && Number(m[2]) === LONG.length && Number(m[1]) <= E.EXCERPT_MESSAGE_MAX, 'la coupe est signalée, avec les longueurs', x.slice(-300));
ok(m && fs.readFileSync(m[3], 'utf8') === LONG, 'le texte complet est écrit à côté de l’extrait, intact (liste « après » comprise)');
x = E.conversationExcerpt(LOG);
ok(new RegExp(`texte complet : ${LOG.replace(/[\\.]/g, '\\$&')}, ligne 1`).test(x), 'sans dossier : l’avis donne le journal et la ligne', x.slice(-250));
const c = E.clipText('abc', 10);
const longText = 'mot '.repeat(7) + 'fin du texte';
ok(c.text === 'abc' && !c.cut && new RegExp(`tronqué par l’orchestrateur : \\d+ caractères affichés sur ${longText.length}`).test(E.clipText(longText, 12).text), 'clipText : intact sous la limite, avis au-delà');

// ---------------------------------------------------------------------------
section('3. La fenêtre écarte des messages entiers, jamais un morceau, et le dit');
const many = Array.from({ length: 12 }, (_, i) => ({ type: 'user_prompt', source: 'orchestrateur', text: `MSG${i}-DEBUT ${'x'.repeat(4000)} MSG${i}-FIN` }));
fs.writeFileSync(LOG, J(many));
x = E.conversationExcerpt(LOG, { maxChars: 30_000 });
const starts = [...x.matchAll(/MSG(\d+)-DEBUT/g)].map(r => r[1]), ends = [...x.matchAll(/MSG(\d+)-FIN/g)].map(r => r[1]);
ok(starts.length && starts.join() === ends.join(), `chaque message gardé l’est en entier (${starts.length} gardés)`, `${starts} / ${ends}`);
ok(starts[starts.length - 1] === '11' && /⚠ \[\d+ message\(s\) plus ancien\(s\) non repris ici — journal complet/.test(x), 'les plus récents sont gardés, les plus anciens écartés avec un avis');

// ---------------------------------------------------------------------------
section('4. Le message d’un musicien n’est jamais étiqueté « utilisateur »');
fs.writeFileSync(LOG, J([{ type: 'user_prompt', text: 'Ma demande.' }, { type: 'user_prompt', source: 'orchestrateur', text: 'Mon compte rendu.' }]));
x = E.conversationExcerpt(LOG);
ok(x.includes('**utilisateur** : Ma demande.') && x.includes('**message de orchestrateur** : Mon compte rendu.') && !x.includes('**utilisateur** : Mon compte rendu.'), 'utilisateur et musicien distingués', x);

// ---------------------------------------------------------------------------
section('5. Le contexte du chef signale ses coupes');
const LOGS = path.join(T, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(path.join(T, 'chef'), { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'M', path: path.join(T, 'M') }] }));
const Q = `Questions en attente : 1. ${'détail '.repeat(150)} 2. panierIL p-20261009T193934-083679 QUESTION-FIN ?`;
fs.writeFileSync(path.join(LOGS, 'M.jsonl'), J([{ type: 'user_prompt', text: 'x' }, { type: 'result', result: `Fait.\nNEEDS_USER_INPUT: ${Q}` }]));
fs.writeFileSync(path.join(LOGS, 'chef.jsonl'), J([{ type: 'assistant', message: { content: [{ type: 'text', text: `${'Réponse longue. '.repeat(500)}DERNIERE-PHRASE` }] } }]));
const ctx = E.routingContext(T, { logsDir: LOGS, chefLog: path.join(LOGS, 'chef.jsonl'), chefDir: path.join(T, 'chef') });
ok(/\*\*M\*\* : [\s\S]*⚠ \[tronqué par l’orchestrateur : \d+ caractères affichés sur \d+ — texte complet : [^\]]*M\.jsonl\]/.test(ctx), 'question d’un musicien coupée : avis et journal du musicien', ctx.slice(0, 200));
ok(/## Ta dernière réponse[\s\S]*⚠ \[tronqué par l’orchestrateur[^\]]*chef\.jsonl\]/.test(ctx), 'dernière réponse du chef coupée : avis et journal du chef');

// ---------------------------------------------------------------------------
section('6. Le résumé du réveil (server.js) signale sa coupe');
// 0.100.3: moved to scripts/turn-report.mjs, imported by server.js.
const { summarizeResult } = await import('./turn-report.mjs');
ok(typeof summarizeResult === 'function' && /import \{[^}]*summarizeResult[^}]*\} from '\.\/scripts\/turn-report\.mjs'/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), 'summarizeResult : celle de turn-report.mjs, utilisée par server.js');
const shortS = summarizeResult({ result: 'Début.\n\nConclusion courte mais assez longue pour être gardée telle quelle.' });
const longS = summarizeResult({ result: `Début.\n\n${'Conclusion très longue. '.repeat(40)}` });
ok(shortS === 'Conclusion courte mais assez longue pour être gardée telle quelle.', 'résumé court : intact');
ok(/… ⚠ \[résumé coupé : \d+ caractères sur \d+ — compte rendu complet dans le journal du musicien/.test(longS), 'résumé long : coupe signalée, et où lire le tout', longS);

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
