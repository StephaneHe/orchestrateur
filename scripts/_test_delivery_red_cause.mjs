#!/usr/bin/env node
// ============================================================================
// scripts/_test_delivery_red_cause.mjs — a red suite after Livrer is never
// read as a provider outage (0.141.1)
// ============================================================================
//
// Defect seen in production on 2026-10-23 (runs p-20261023T034727-63c0e9 and
// p-20261023T060612-23bc5b, complete Development): Livrer was refused because
// `npm test` failed after the delivery (a deterministic cause), but the pause
// said « Le fournisseur du model a une panne passagère », its « cause » being a
// line of the TEST OUTPUT (« network error » in a CHANGELOG line, « 509.2256ms »
// read as an HTTP 5xx), menu « continuer » / « abandonner », sent to the user
// instead of the chef.
//
// User rule (2026-10-22), verbatim: « arrête de poser des questions de
// découpage. tu sais comment est organisé le process mieux que moi ».
//
// Protected (user requirement, never weakened without the user's agreement):
//   1. replay of both real refusals (tests/delivery-red-cases.json), with and
//      without the program's delivery report: cause « tests rouges après
//      livraison » (code_delivery), no « panne » / « fournisseur », no provider
//      evidence, « confier au model » offered and recommended, never
//      « continuer », routed to the CHEF;
//   2. outage-like words in test output (failure, fails, unavailable, network,
//      5xx-looking durations) are never read as a provider error, whatever the
//      limit; a real provider error passed apart by the model call still is;
//   3. anti-loop: once the delivery was handed to the model, the next red
//      delivery recommends another way (« changer d’approche », model again),
//      and an option already answered is no longer offered.
//
//   node scripts/_test_delivery_red_cause.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnosePause, smartMenu, fixMenu, checkMenu, excludeAnswered, providerText, readProviderError, readTestOutput } from './pause-diagnosis.mjs';
import { routePause, pauseSignature } from './process-pause.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const OUTAGE = /panne|fournisseur|de le model/i;
const STEP = { id: 'livrer', label: 'livraison (version, journal des changements, commit)' };
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'delivery-red-cases.json'), 'utf8')).cases;

const diag = (input, ctx = {}) => {
  const d = diagnosePause({ limit: 'criteria', step: STEP, ...input });
  const menu = fixMenu(d, smartMenu(d, { step: STEP, delivered: 3, ...ctx }));
  return { d, menu };
};

// ---------------------------------------------------------------------------
section('1. Rejeu des deux refus réels de Livrer (suite rouge après la livraison)');
ok(Object.keys(CASES).length === 2, `deux cas réels (${Object.keys(CASES).join(', ')})`);
for (const [run, why] of Object.entries(CASES)) {
  for (const cd of [null, { from: '1.9.2', to: '1.10.0', red: true, stale: [] }]) {
    const tag = `${run} ${cd ? '(livraison par le programme)' : '(livraison par le model)'}`;
    const { d, menu } = diag({ why, testOutput: why, attempts: [why, why], codeDelivery: cd });
    ok(d.kind === 'code_delivery', `${tag} : cause « code_delivery » (obtenu « ${d.kind} »)`, d.cause);
    ok(/^Tests rouges après livraison/.test(d.cause) && !OUTAGE.test(d.cause), `${tag} : « Tests rouges après livraison », sans panne ni fournisseur`, d.cause);
    ok(/✖ (version is bumped|the version displayed)/.test(d.cause), `${tag} : la cause cite le test en échec, pas l’en-tête « failing tests »`, d.cause);
    ok(!(d.evidence || []).some(e => e.source === 'fournisseur'), `${tag} : aucune preuve « fournisseur » tirée de la sortie des tests`, d.evidence);
    ok(!d.transient, `${tag} : cause non passagère`);
    const keys = menu.options.map(o => o.key);
    ok(keys.includes('confier au model') && menu.recommend.key === 'confier au model' && !keys.includes('continuer'), `${tag} : choix ${keys.join(', ')} ; recommandé « ${menu.recommend.key} »`, menu);
    ok(menu.options.find(o => o.key === 'confier au model')?.effect?.modelDeliver === true, `${tag} : « confier au model » confie réellement la livraison au model`);
    ok(!checkMenu(d, menu).length, `${tag} : menu conforme aux règles (${checkMenu(d, menu).join(' ; ')})`);
    const sig = pauseSignature({ limit: 'criteria', kind: d.kind, step: 'livrer', item: null });
    const r = routePause({ limit: 'criteria', d, menu, pipeline: 'dev', lane: 0, history: [], sig, project: '[projet]', run, n: 1 });
    ok(r.to === 'chef', `${tag} : pause transmise au CHEF (${r.why})`, r);
    if (r.to === 'chef') ok(r.menu.options.some(o => o.key === 'confier au model') && !OUTAGE.test(r.question.replace(/l’utilisateur/g, '')), `${tag} : le chef reçoit « confier au model », sans parler de panne`, r.question.slice(0, 400));
  }
  ok(providerText({ limit: 'criteria', why, testOutput: why }) === '', `${run} : aucun texte « fournisseur » lu dans la sortie des tests`);
}

// ---------------------------------------------------------------------------
section('2. Les mots d’une sortie de test ne sont jamais une panne du fournisseur');
const NOISE = [
  'la suite échoue encore (npm test) :\n✖ shows an error when saving fails (network error)\n  AssertionError: expected « Voix indisponible »',
  'la suite échoue après la livraison (npm test) :\n✔ a vignette audio failure (reject) shows the text (509.2256ms)\n✖ service unavailable banner (503.1ms)\n  AssertionError: banner missing',
  'la suite échoue encore (pytest) :\nFAILED tests/test_api.py::test_timeout - assert 504 == 200 (request timed out)',
];
for (const why of NOISE) {
  for (const limit of ['green', 'criteria']) {
    const d = diagnosePause({ limit, step: { id: limit === 'green' ? 'vert' : 'livrer' }, why, testOutput: why });
    ok(!['provider_transient', 'network', 'limit', 'refusal', 'env_auth'].includes(d.kind) && !OUTAGE.test(d.cause), `${limit} « ${why.split('\n')[1].slice(0, 50)}… » → ${d.kind}`, d.cause);
    ok(!readProviderError(providerText({ limit, why, testOutput: why })), `${limit} : rien lu comme erreur du fournisseur`);
  }
}
const real = diagnosePause({ limit: 'model_unavailable', step: { id: 'vert' }, why: 'API Error: 529 overloaded', providerError: 'API Error: 529 overloaded', model: 'claude-x' });
ok(real.kind === 'provider_transient' && /Le fournisseur du model claude-x/.test(real.cause), `vraie erreur passée à part : toujours lue (${real.kind})`, real.cause);
const apart = diagnosePause({ limit: 'criteria', step: STEP, why: CASES[Object.keys(CASES)[1]], providerError: 'API Error: 503 Service Unavailable' });
ok(apart.kind === 'code_delivery', `suite rouge après Livrer + erreur passée à part : la suite rouge prime (${apart.kind})`);
ok(readTestOutput('✖ failing tests:\n\ntest at t.mjs:3:1\n✖ the real failure (2ms)')?.line === '✖ the real failure (2ms)', 'l’en-tête « ✖ failing tests: » n’est jamais pris pour l’échec');

// ---------------------------------------------------------------------------
section('3. Anti-boucle : une livraison déjà confiée au model ne repropose pas la même chose');
{
  const why = CASES[Object.keys(CASES)[0]];
  const { d, menu } = diag({ why, testOutput: why }, { modelDelivered: true });
  const keys = menu.options.map(o => o.key);
  ok(keys.includes('changer d’approche') && menu.recommend.key === 'changer d’approche', `déjà confiée au model : recommandé « ${menu.recommend.key} » (${keys.join(', ')})`, menu);
  ok(menu.options.find(o => o.key === 'changer d’approche')?.effect?.modelDeliver === true, '« changer d’approche » reste une livraison par le model, avec une autre méthode');
  const x = excludeAnswered(menu, ['confier au model']);
  ok(!x.options.some(o => o.key === 'confier au model') && x.recommend.key === 'changer d’approche', `« confier au model » déjà choisi : plus proposé, « ${x.recommend.key} » recommandé`, x);
  const y = excludeAnswered(menu, ['confier au model', 'changer d’approche']);
  ok(y.options.map(o => o.key).join() === 'abandonner', `les deux déjà choisis : seul « abandonner » reste (${y.options.map(o => o.key).join(', ')})`);
  const engine = fs.readFileSync(path.join(ROOT, 'scripts', 'pipeline-engine.mjs'), 'utf8');
  ok(/modelDelivered: !!state\.modelDeliver/.test(engine) && /family\(prev\.kind\) === family\(d\.kind\)/.test(engine), 'le moteur passe « déjà confiée au model » et traite mention périmée et suite rouge comme une même cause');
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
