#!/usr/bin/env node
// ============================================================================
// scripts/_test_routage_corpus.mjs — the real refused cases of the prod Routage,
// replayed through the v3 chef turn (Routage v3, phase 2)
// ============================================================================
//
// User decision of 2026-10-22 (« vas y »): « plan produit sur les vrais messages
// de l'utilisateur et rejoué sur le corpus tests/routage-corpus/ ».
// docs/ROUTAGE-SYNTHESE.md §3.10: the 45 refused Découper attempts, the 5
// hand-offs refused with exit 65, the infrastructure failures, the 5 resumes by
// citation, and the inverted order + wrong action of p-20261019T181739-7e7851.
// Expected: no global refusal, no constraint removed, no resume that was not
// asked for, cancel_run and not kill-stalled, « puis » respected.
//
//   node scripts/_test_routage_corpus.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayCorpus, judgeCase } from './chef-turn.mjs';
import { repairPlan } from './plan-repair.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tests', 'routage-corpus');
const CORPUS = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8'));
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1200)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rcorpus-'));
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ conductor: 'chef', projects: [{ name: 'chef', path: T }] }));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {} }));

try {
  section('1. Le corpus : réel, anonymisé, complet');
  const kinds = {};
  for (const c of CORPUS.cases) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
  ok(kinds.refus === 45 && kinds['renvoi-65'] === 5 && kinds.infra === 3 && kinds['reprise-par-citation'] === 5 && kinds.inversion === 1, `45 refus, 5 renvois en 65, 3 pannes, 5 reprises par citation, l’inversion (${JSON.stringify(kinds)})`);
  ok(CORPUS.cases.every(c => /^p-\d{8}T\d{6}-[0-9a-f]{6}$/.test(c.run) && c.message && c.expect), 'chaque cas : son exécution réelle, le message, les attendus');
  const motifs = new Set(CORPUS.cases.filter(c => c.kind === 'refus').map(c => c.why.replace(/tâche \d+/g, 'tâche N').replace(/\d+ tâches/, 'N tâches').replace(/« [^»]* »$/, '').slice(0, 50)));
  ok(motifs.size >= 8, `les motifs de refus réels sont représentés (${motifs.size})`);
  const text = JSON.stringify(CORPUS);
  const hosts = [...new Set([...text.matchAll(/https?:\/\/([^/\s"]+)/g)].map(m => m[1]))];
  ok(hosts.every(h => ['www.example.org', 'www.anthropic.com'].includes(h)), `aucune URL réelle hors du message public du fournisseur (${hosts.join(', ')})`);
  let priv = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const pub = new Set(['orchestrateur', 'orchestrateur-dev', 'chef', 'pipelineLab']);
    priv = (cfg.projects || []).map(p => p.name).filter(n => n && !pub.has(n) && !/^chef-\d+$/.test(n) && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  } catch { /* no local config */ }
  ok(!priv.length, `aucun nom de projet privé du config.json local${priv.length ? ` : ${priv.join(', ')}` : ''}`);
  ok(!/[\w.+-]+@[\w-]+\.(com|fr|org)\b/.test(text.replace(/adresse@example\.org/g, '')), 'aucune adresse mail');

  section('2. Rejeu par le code : chaque cas conforme');
  const res = await replayCorpus({ root: T, dir: DIR });
  const bad = res.filter(r => !r.verdict.ok);
  ok(!bad.length, `${res.length - bad.length}/${res.length} cas conformes`, bad.map(b => `${b.id} : ${b.verdict.fails.join(' ; ')}`).join('\n      '));
  const byKind = (k) => res.filter(r => r.kind === k);
  ok(byKind('refus').every(r => r.repaired && !r.repaired.items.some(i => ['à_traiter', 'à_classer'].includes(i.state)) || r.id === 'refus-ebf448'), 'aucun refus global : les 45 plans refusés partent (sauf le projet inconnu, qui pose sa question)');
  const ebf = res.find(r => r.id === 'refus-ebf448');
  ok(ebf && /projet-divers/.test(ebf.repaired.question || '') && ebf.repaired.items.some(i => i.state === 'prête'), 'projet inconnu « divers » (à l’époque) : une question groupée, la tâche indépendante part');
  const orders = CORPUS.cases.reduce((n, c) => n + (c.expect.order || []).length, 0);
  ok(orders >= 20, `« puis » vérifié sur ${orders} relations réelles, aucune perdue`);
  ok(res.filter(r => r.retried).map(r => r.id).sort().join() === 'refus-22e10e,refus-80eaf2', 'un seul nouvel essai, et seulement pour les dépendances hors bornes');
  ok(byKind('renvoi-65').every(r => !r.repaired.items.some(i => i.kind === 'tache' && i.projet === 'chef')), 'renvois en 65 : plus aucune tâche lancée vers le chef');
  ok(byKind('reprise-par-citation').every(r => !r.repaired.items.some(i => i.kind === 'reprise')), 'reprises par citation : un identifiant cité ne reprend plus rien');
  const inv = res.find(r => r.id === 'inversion-7e7851');
  const m = new Map(inv.repaired.items.map(i => [i.ref, i]));
  ok(m.get('b').action === 'cancel_run' && m.get('b').apres.includes('a') && m.get('b').state === 'en_attente_de' && m.get('a').state === 'prête', 'p-…7e7851 : la note TODO d’abord, puis cancel_run (jamais kill-stalled)');
  const infra = Object.fromEntries(byKind('infra').map(r => [r.id, r]));
  ok(infra['infra-auth'].parked?.cause === 'auth' && infra['infra-auth'].calls === 1, 'OAuth expirée : garée, aucun nouvel essai');
  ok(infra['infra-limit'].parked?.cause === 'limit' && infra['infra-limit'].calls === 1, 'limite de session : garée, aucun nouvel essai');
  ok(infra['infra-refusal'].parked?.cause === 'refusal' && infra['infra-refusal'].calls === 2, 'refus du fournisseur : un essai en session neuve, puis garée');

  section('3. Le juge refuse ce que l’ancien Routage faisait (contrôles négatifs)');
  const inversion = CORPUS.cases.find(c => c.id === 'inversion-7e7851');
  const judge = (plan) => judgeCase(inversion, { repaired: repairPlan(plan, { projects: CORPUS.projects, conductor: 'chef', runInfo: (r) => inversion.runs[r] || null }) });
  const lost = structuredClone(inversion.plan); delete lost.actions[1].apres;
  ok(!judge(lost).ok && /perdu/.test(judge(lost).fails.join()), 'ordre perdu (la clôture avant la note) : refusé');
  const kill = structuredClone(inversion.plan); kill.actions[1] = { ref: 'b', action: 'stop_turn', cible: 'orchestrateur-dev', raison: 'abandonner', apres: ['a'] };
  ok(!judge(kill).ok && /cancel_run/.test(judge(kill).fails.join()), '« abandonner » traduit en stop_turn (ex-kill-stalled) : refusé');
  const cite = CORPUS.cases.find(c => c.kind === 'reprise-par-citation');
  const run = cite.expect.noResume[0];
  const implicit = { ...cite.plan, reprises: [{ ref: 'r', run }] };
  ok(!judgeCase(cite, { repaired: repairPlan(implicit, { projects: CORPUS.projects, runInfo: (r) => cite.runs[r] || null }) }).ok, 'une reprise non demandée de l’exécution citée : refusée');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
