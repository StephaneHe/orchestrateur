#!/usr/bin/env node
// ============================================================================
// scripts/_test_kg_queries.mjs — knowledge index, phase 0 b: queries without a
// model, under 100 ms
// ============================================================================
//
// User decisions of 2026-10-20 on docs/KG-SYNTHESE.md, phase 0 b: « Requêtes
// sans model, en moins de 100 ms : fiche d'un projet, règles, impact d'un
// fichier, explication d'un identifiant, historique, contradictions, port
// libre ».
//
// Index built from the anonymised corpus (tests/kg-corpus/before) plus the
// coverage of THIS repository (real size). Protected:
//   - fiche: environment conflict shown, ports with their listening state,
//     dev_of, last incidents classified by cause;
//   - regles: rules in force before superseded ones, the superseding chain,
//     exceptions and conflicts always returned;
//   - impact <file>: exactly the suites, HTTP and browser stages that
//     regression-targets.selectTargets picks for that single file (sample of
//     real files), plus the user requirements those suites protect (⚠) and
//     the decisions that name the file;
//   - explique <id>: node and 1-hop links with their source, for every id form
//     (decision, memory, run, version, port, project), « inconnu » said;
//   - historique <case>: n, outcomes per served model, causes (criterion /
//     infrastructure / failure kept apart), « données insuffisantes » under 20;
//   - port-libre: never a declared nor a listening port, and bindable;
//   - every query < 100 ms on the loaded index; the CLI answers in JSON.
//
//   node scripts/_test_kg_queries.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as KG from './kg.mjs';
import { corpusCopy } from '../tests/kg-corpus/fixture.mjs';
import { selectTargets, repoFiles } from './regression-targets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-queries-'));
const CORPUS = corpusCopy(path.join(T, 'corpus'));
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 1200)}` : ''}`); };
const section = (s) => console.log(`\n${s}`);
const timed = (fn) => { const t0 = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };

try {
  const R = path.join(T, 'root');
  fs.mkdirSync(R);
  fs.writeFileSync(path.join(R, 'model-routing.json'), JSON.stringify({ version: 2, assignments: {}, kg: { mode: 'shadow' } }));
  const b = await KG.build(R, { corpus: CORPUS, repo: REPO });
  ok(b.ok && b.summary.rejected === 0, 'construction en mode ombre (corpus + couverture de ce dépôt)', JSON.stringify(b.summary || b));
  const tLoad = timed(() => KG.loadIndex(R));
  const idx = tLoad.r;
  console.log(`    (chargement de l’index : ${tLoad.ms.toFixed(1)} ms, ${b.summary.nodes} nœuds, ${b.summary.facts} faits)`);

  section('fiche');
  {
    const { r, ms } = timed(() => KG.fiche(idx, 'boxapp'));
    ok(r.known && r.label === 'boxapp', 'fiche de boxapp');
    ok(r.environment.length === 2 && r.environment.every(e => e.status === 'disputed'), 'environnement en conflit montré, pas tranché');
    ok(r.ports.some(p => p.listening?.some(x => x.port === 3001 && x.up)), 'port 3001 avec son état d’écoute');
    ok(r.contradictions.some(c => c.kind === 'conflit'), 'contradiction qui le touche');
    ok(r.incidents.length === 5 && r.incidents.every(i => ['critere', 'infrastructure', 'echec'].includes(i.cause)), '5 derniers incidents classés par cause');
    ok(ms < KG.QUERY_BUDGET_MS, `fiche en ${ms.toFixed(1)} ms (< 100)`);
    const dev = KG.fiche(idx, 'orchestrateur-dev');
    ok(dev.dependencies.some(d => d.p === 'dev_of' && d.o === 'projet:orchestrateur'), 'dev_of (orchestrateur-dev → orchestrateur)');
    ok(KG.fiche(idx, 'projet-inexistant').known === false, 'projet inconnu dit');
  }

  section('règles');
  {
    const { r, ms } = timed(() => KG.regles(idx, { projet: 'boxapp' }));
    ok(r.inForce.some(x => x.id === 'mem:feedback_all_opus5') && !r.inForce.some(x => x.id === 'mem:feedback_plan_opus5_code_opus48'), 'règle en vigueur, ancienne règle écartée');
    ok(r.superseded.find(x => x.id === 'mem:feedback_plan_opus5_code_opus48')?.supersededBy.includes('mem:feedback_all_opus5'), 'chaîne de remplacement rendue');
    ok(r.inForce[0].specific, 'la plus spécifique d’abord (règles qui nomment boxapp)');
    ok(r.exceptions.some(e => e.p === 'exception_to'), 'exceptions toujours rendues');
    ok(r.fixed.some(f => f.p === 'default_model' && f.o === 'claude-opus-5-5' && f.authority === 'live'), 'valeur fixe en vigueur (model par défaut, état vivant)');
    ok(ms < KG.QUERY_BUDGET_MS, `règles en ${ms.toFixed(1)} ms (< 100)`);
  }

  section('impact = selectTargets (vrais fichiers de ce dépôt)');
  {
    const files = repoFiles(REPO);
    const sample = ['scripts/dispatch.mjs', 'scripts/kg.mjs', 'scripts/pipeline-engine.mjs', 'scripts/atomic-file.mjs', 'public/app.js', 'server.js', 'scripts/regression.mjs', 'scripts/todo-core.mjs', 'scripts/lanes.mjs', 'scripts/model-backoff.mjs', 'tests/fake_claude/fake_claude.mjs', 'scripts/release-notes.mjs', 'public/turn-core.js', 'scripts/pipeline-tuning.mjs', 'scripts/auto-answer.mjs'].filter(f => files.includes(f));
    let same = 0, worst = 0;
    for (const f of sample) {
      const want = selectTargets(REPO, [f], { files });
      const { r: got, ms } = timed(() => KG.impact(idx, f));
      worst = Math.max(worst, ms);
      const eq = want.full ? !!got.full : (!got.full && JSON.stringify(got.suites.map(s => s.file)) === JSON.stringify(want.suites.map(s => s.file)) && got.http === want.http && got.browser === want.browser);
      if (eq) same++; else console.log(`      ≠ ${f}: attendu ${want.full ? 'complète' : want.suites.length + ' suites'}, obtenu ${got.full ? 'complète' : got.suites.length + ' suites'}`);
    }
    ok(same === sample.length, `impact identique à selectTargets sur ${same}/${sample.length} fichiers`);
    ok(worst < KG.QUERY_BUDGET_MS, `impact en ${worst.toFixed(1)} ms au pire (< 100)`);
    const k = KG.impact(idx, 'scripts/kg.mjs');
    ok(['_test_kg_core.mjs', '_test_kg_replay.mjs', '_test_kg_queries.mjs'].every(s => k.suites.some(x => x.file === s)), 'impact de kg.mjs : ses trois suites');
    const d = KG.impact(idx, 'scripts/dispatch.mjs');
    ok(d.decisions.some(x => x.decision === 'decision:DEMO-D1'), 'décision qui nomme le fichier rendue');
    const g = KG.impact(idx, 'scripts/pipeline-engine.mjs');
    ok(g.exigences.some(e => e.suite === '_test_pipeline_gates.mjs'), '⚠ exigence protégée par une suite touchée (registre)');
    ok(KG.impact(idx, 'docs/KG-SYNTHESE.md').suites.every(s => /socle/.test(s.reasons[0])), 'documentation : le socle seulement');
  }

  section('explique');
  {
    for (const [id, want] of [['DEMO-D1', 'decision:DEMO-D1'], ['feedback_all_opus5', 'mem:feedback_all_opus5'], ['p-20261018T154104-bbbbbb', 'execution:p-20261018T154104-bbbbbb'], ['3001', 'port:3001'], ['boxapp', 'projet:boxapp'], ['routage.classifier', 'case:routage.classifier'], ['[[DEMO-D2]]', 'decision:DEMO-D2']]) {
      const { r, ms } = timed(() => KG.explique(idx, id));
      ok(r.known && r.id === want && ms < KG.QUERY_BUDGET_MS, `explique ${id} → ${want} (${ms.toFixed(1)} ms)`, JSON.stringify(r).slice(0, 300));
    }
    const m = KG.explique(idx, 'feedback_plan_opus5_code_opus48');
    ok(m.links.some(l => l.dir === 'in' && l.p === 'supersedes' && l.s === 'mem:feedback_all_opus5' && /:\d+$/.test(l.ref)), 'liens à un saut avec leur source (fichier:ligne)');
    const dec = KG.explique(idx, 'DEMO-D1');
    ok(dec.links.some(l => l.p === 'applies_to' && l.o === 'suite:_test_pipeline_gates.mjs'), 'décision → test qu’elle cite');
    ok(KG.explique(idx, 'zzz-inconnu').known === false, 'identifiant inconnu dit, sans erreur');
    ok(KG.explique(idx, 'mem:feedback_plan_opus5_code_opus48', { max: 1 }).more >= 1, '« voir plus » au-delà de la limite');
  }

  section('historique');
  {
    const { r, ms } = timed(() => KG.historique(idx, 'dev.vert.complexe'));
    const s = r.byModel['claude-sonnet-5-5'];
    ok(r.n === 66 && s.ok === 37 && s.critere === 15 && s.infrastructure === 14, 'dev.vert.complexe : 66 essais, 37 ok, 15 refus de critère, 14 pannes d’infrastructure (pas « 44 % de refus »)', JSON.stringify(r));
    ok(r.enough && r.assigned === 'claude-sonnet-5-5', 'assez de données ; model de la case');
    const l = KG.historique(idx, 'dev.livrer');
    ok(!l.enough && /données insuffisantes/.test(l.message) && l.causes[0]?.why === 'aucun commit de livraison' && l.causes[0]?.n === 8, 'Livrer : 8 refus « aucun commit » reconnus, données insuffisantes (n < 20)', JSON.stringify(l));
    ok(ms < KG.QUERY_BUDGET_MS, `historique en ${ms.toFixed(1)} ms (< 100)`);
  }

  section('contradictions et périmés');
  {
    const { r, ms } = timed(() => KG.contradictions(idx));
    ok(r.conflicts.length === 1 && r.stale.length >= 4, 'contradictions : 1 conflit, ≥ 4 affirmations contredites ou index périmés');
    ok(ms < KG.QUERY_BUDGET_MS, `contradictions en ${ms.toFixed(1)} ms (< 100)`);
    const p = KG.perimes(idx);
    ok(p.stale.some(x => x.reason === 'port-muet') && p.listening?.ports.includes(3001), 'périmés : ports muets, relevé d’écoute daté');
  }

  section('port libre');
  {
    const r = await KG.portLibre(idx, { from: 3000 });
    ok(r.port && r.port >= 3000 && ![80, 3000, 3001, 7777, 7778, 8001, 8093, 8097, 11434].includes(r.port), `port libre ${r.port} : ni déclaré ni à l’écoute`);
    const busy = net.createServer();
    await new Promise(res => busy.listen({ port: r.port, host: '0.0.0.0' }, res));
    const r2 = await KG.portLibre(idx, { from: r.port });
    ok(r2.port !== r.port, `un port pris à l’instant n’est pas proposé (${r2.port})`);
    await new Promise(res => busy.close(res));
  }

  section('CLI');
  {
    const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: R };
    const run = (args) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'kg.mjs'), ...args], { encoding: 'utf8', env, windowsHide: true });
    const h = run(['historique', 'dev.vert.complexe', '--json']);
    const j = h.status === 0 ? JSON.parse(h.stdout) : null;
    ok(j && j.n === 66 && j.ms < KG.QUERY_BUDGET_MS, `kg.mjs historique --json (${j?.ms?.toFixed?.(1)} ms)`, h.stderr);
    const im = run(['impact', 'scripts/pipeline-engine.mjs']);
    ok(im.status === 0 && /# Impact de scripts\/pipeline-engine\.mjs/.test(im.stdout) && /⚠ exigences/.test(im.stdout), 'kg.mjs impact en Markdown français', im.stderr);
    const c = run(['contradictions']);
    ok(c.status === 0 && /## Conflits \(1\)/.test(c.stdout), 'kg.mjs contradictions', c.stderr);
    ok(run(['n-importe-quoi']).status === 64, 'verbe inconnu : 64');
  }
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
