// Suite « lacunes de pipeline » et décision Q9 (0.42.0).
//   node scripts/_test_pipeline_gaps.mjs
//
// Règle utilisateur (2026-10-08) : « si il manque des taches, ou une etape ne
// peut pas etre classee en une tache precise, il faut remonter l'information en
// proposant une solution ». Décision Q9 : « La reponse a ta question de
// classification : ok. » → hésitation léger / complet = LÉGER.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, detectGap, createObserver, significantWords } from './pipeline-observe.mjs';
import { createModelRouting } from './model-routing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };

console.log('\n── 1. Décision Q9 : dans le doute, mode LÉGER');
{
  const amb = 'ajoute dans la page des réglages une option pour choisir l’ordre des cadres et la mémoriser entre deux sessions du navigateur';
  const c = classify({ text: amb });
  t('demande de développement sans signal net → léger, marquée « mode incertain »', c.pipeline === 'dev' && c.mode === 'leger' && c.modeUncertain === true, JSON.stringify(c));
  t('signal net de grosse demande → complet', classify({ text: 'implémente une nouvelle fonctionnalité de synchronisation' }).mode === 'complet');
  t('signal net de petite demande → léger, sans « incertain »', (() => { const x = classify({ text: 'corrige la typo du titre' }); return x.mode === 'leger' && !x.modeUncertain; })());
  t('/complet explicite l’emporte', classify({ text: '/complet ajoute une option de couleur' }).mode === 'complet');
}

console.log('\n── 2. Détection des lacunes, avec proposition');
{
  const g1 = detectGap({ text: 'planifie mes vacances en Italie avec un budget serré', classification: classify({ text: 'planifie mes vacances en Italie avec un budget serré' }) });
  t('inclassable et non trivial → lacune « aucun pipeline »', g1?.reason === 'aucun-pipeline' && /Discussion/.test(g1.why));
  t('demande d’action → proposition « nouveau pipeline » avec mots-clés', g1?.proposal.kind === 'pipeline' && g1.proposal.id.startsWith('x-') && g1.proposal.keywords.length >= 2 && /pipeline/.test(g1.proposal.text));
  t('alternative proposée : rattachement à Discussion', g1?.alternative?.kind === 'rattachement' && g1.alternative.pipeline === 'discussion');
  const g2 = detectGap({ text: 'les impôts de cette année me stressent', classification: classify({ text: 'les impôts de cette année me stressent' }) });
  t('remarque sans demande d’action → Discussion, sans lacune (sa vraie place)', g2 === null);
  t('question → Discussion, sans lacune', detectGap({ text: 'que penses-tu des impôts cette année ?', classification: classify({ text: 'que penses-tu des impôts cette année ?' }) }) === null);
  const g2b = detectGap({ text: 'Vas jusqu’au bout de chaque commande pour vérifier les prix de livraison', classification: classify({ text: 'Vas jusqu’au bout de chaque commande pour vérifier les prix de livraison' }) });
  t('vraie demande d’action hors pipeline (achats en ligne) → lacune avec proposition', g2b?.reason === 'aucun-pipeline' && g2b.proposal.kind === 'pipeline');
  t('messages internes ([REPRISE], réponse relayée) → aucune lacune', detectGap({ text: '[REPRISE] Ton tour précédent a été perdu', classification: classify({ text: '[REPRISE] x' }) }) === null
    && detectGap({ text: 'Réponse pour orchestrateur à sa question : MIT', classification: classify({ text: 'Réponse pour orchestrateur à sa question : MIT' }) }) === null);
  t('sans accents : « Fais le deploiement » est du développement', classify({ text: 'Fais le deploiement du projet' }).pipeline === 'dev');
  t('sans accents : « on a perdu une fonctionalite » est du développement', classify({ text: 'je crois qu’on a perdu une fonctionalite' }).pipeline === 'dev');
  const flouText = 'fais un audit sécurité et traduis le rapport en anglais';
  const c3 = classify({ text: flouText });
  const g3 = detectGap({ text: flouText, classification: c3 });
  t('deux pipelines à égalité → lacune « flou », rattachement à l’un ou l’autre', c3.tie && g3?.reason === 'flou' && g3.proposal.kind === 'rattachement' && g3.alternative.pipeline !== g3.proposal.pipeline, JSON.stringify(c3.ranked));
  for (const text of ['bonjour', 'ok merci', 'oui', '/help', 'go']) t(`trivial « ${text} » → aucune lacune`, detectGap({ text, classification: classify({ text }) }) === null);
  t('entrée système → aucune lacune', detectGap({ text: 'planifie mes vacances en Italie', entry: 'wake', classification: classify({ text: 'x', entry: 'wake' }) }) === null);
  t('choix explicite (/discussion …) → aucune lacune', detectGap({ text: '/discussion planifie mes vacances', classification: classify({ text: '/discussion planifie mes vacances' }) }) === null);
  t('demande bien classée → aucune lacune', detectGap({ text: 'corrige la typo du titre', classification: classify({ text: 'corrige la typo du titre' }) }) === null);
  t('mots porteurs de sens sans mots vides', significantWords('Planifie mes vacances en Italie').join(',') === 'planifie,vacances,italie');
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), path.join(dir, 'scripts', 'dispatch.mjs'));
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({ models: [] }));
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  const mr = createModelRouting({ root: dir, cacheFile: path.join(dir, 'c.json'), fetch: fake, env: { CODEX_HOME: dir }, which: async () => ({ bins: new Set(), py: new Set() }) });
  const obs = createObserver({ logsDir: path.join(dir, 'logs'), extraRules: () => mr.classifierExtras() });
  return { dir, mr, obs };
}

console.log('\n── 3. Journal : lacune enregistrée, regroupée, décidée');
{
  const { mr, obs, dir } = sandbox();
  await mr.getCatalog();
  const text = 'planifie mes vacances en Italie avec un budget serré';
  const r1 = obs.record({ entry: 'dashboard:chef', project: 'chef', text });
  obs.record({ entry: 'terminal', project: 'central', text });
  t('l’entrée reste traitée en Discussion (aucun classement forcé)', r1.pipeline === 'discussion' && r1.unclassifiable && r1.gap?.key);
  let g = obs.gaps(mr.gapDecisions());
  t('une demande répétée = une seule lacune, avec son compte', g.open.length === 1 && g.open[0].count === 2 && g.open[0].entries.length === 2);

  // Accepter la proposition « nouveau pipeline ».
  const acc = mr.decideGap(g.open[0], 'accept', { choice: 'primary' });
  t('Accepter → pipeline ajouté, case « Réaliser » renvoyée', acc.ok && acc.applied.kind === 'pipeline' && acc.applied.slot.endsWith('.realiser'), JSON.stringify(acc));
  const eff = mr.view();
  const np = eff.pipelines.find(p => p.id === acc.applied.pipeline);
  t('le pipeline ajouté a ses 4 étapes et ses cases', np && np.custom && np.flow.length === 4 && eff.slots.some(s => s.id === acc.applied.slot));
  t('« Cadrer » est une étape de jugement, « Réaliser » une étape d’action', eff.slots.find(s => s.id === `${np.id}.cadrer`)?.judge === true && !eff.slots.find(s => s.id === acc.applied.slot)?.judge);
  t('l’utilisateur peut choisir le model de la nouvelle case', mr.setAssignment(acc.applied.slot, { provider: 'anthropic', model: 'claude-sonnet-5' }).ok);
  t('l’ajout survit aux écritures suivantes', mr.view().pipelines.some(p => p.id === np.id));
  g = obs.gaps(mr.gapDecisions());
  t('la lacune quitte la liste ouverte, passe en « décidée »', g.open.length === 0 && g.decided[0].decision.decision === 'accepted');
  t('une seconde décision est refusée (409)', mr.decideGap(g.decided[0], 'reject').status === 409);
  const again = obs.record({ entry: 'dashboard:chef', text });
  t('la même demande est désormais classée dans le nouveau pipeline, sans lacune', again.pipeline === np.id && !again.gap, JSON.stringify(again));
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'model-routing.json'), 'utf8'));
  t('ajout et décision enregistrés dans model-routing.json (pas ailleurs)', file.custom.pipelines.length === 1 && Object.keys(file.gapDecisions).length === 1);
}

console.log('\n── 4. Les quatre sortes de proposition, et le rejet');
{
  const { mr, obs } = sandbox();
  await mr.getCatalog();
  const mk = (key, proposal) => ({ key, why: 'test', proposal, entries: [{ head: 'publier l’APK sur le store' }] });
  const v = mr.decideGap(mk('k1', { kind: 'variante', pipeline: 'dev', step: 'livrer', id: 'store', label: 'Publication store', text: 'variante' }), 'accept');
  t('variante acceptée → case dev.livrer.store', v.ok && v.applied.slot === 'dev.livrer.store' && mr.view().slots.some(s => s.id === 'dev.livrer.store'));
  const e = mr.decideGap(mk('k2', { kind: 'etape', pipeline: 'dev', after: 'livrer', id: 'surveiller', label: 'Surveiller', text: 'étape' }), 'accept');
  const devFlow = mr.view().pipelines.find(p => p.id === 'dev').flow.map(n => n.id);
  t('étape acceptée → insérée juste après « Livrer »', e.ok && devFlow.indexOf('surveiller') === devFlow.indexOf('livrer') + 1);
  const a = mr.decideGap(mk('k3', { kind: 'rattachement', pipeline: 'redaction', keywords: ['newsletter'], text: 'rattachement' }), 'accept');
  t('rattachement accepté → description complétée et mot-clé appris', a.ok && /Aussi/.test(mr.view().pipelines.find(p => p.id === 'redaction').when) && mr.classifierExtras().some(x => x.pipeline === 'redaction' && x.keywords.includes('newsletter')));
  t('… et la demande est reclassée', obs.record({ text: 'la newsletter du mois' }).pipeline === 'redaction');
  t('Rejeter → rien n’est ajouté', mr.decideGap(mk('k4', { kind: 'variante', pipeline: 'dev', step: 'vert', id: 'rejetee', text: 'x' }), 'reject').ok && !mr.view().slots.some(s => s.id === 'dev.vert.rejetee'));
  t('proposition invalide refusée (étape cible inconnue)', mr.decideGap(mk('k5', { kind: 'variante', pipeline: 'dev', step: 'nexistepas', id: 'x', text: 'x' }), 'accept').status === 400);
  t('identifiant invalide refusé', mr.decideGap(mk('k6', { kind: 'etape', pipeline: 'dev', after: 'livrer', id: '../x', text: 'x' }), 'accept').status === 400);
  t('les 13 pipelines du code restent intacts (ajouts seulement locaux)', (await import('./model-pipelines.mjs')).PIPELINES.find(p => p.id === 'dev').flow.every(n => n.id !== 'surveiller'));
}

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
