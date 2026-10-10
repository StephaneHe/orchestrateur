// Suite « lacunes de pipeline » et décision Q9 (0.42.0).
//   node scripts/_test_pipeline_gaps.mjs
//
// Règle utilisateur (2026-10-08) : « si il manque des taches, ou une etape ne
// peut pas etre classee en une tache precise, il faut remonter l'information en
// proposant une solution ». Décision Q9 : « La reponse a ta question de
// classification : ok. » → hésitation léger / complet = LÉGER.
//
// 0.66.0 — demande utilisateur (2026-10-10) : « Ce n'est pas une recherche de
// mot qui pourra faire un routage efficace, c'est une recherche de sens que
// seul un modele peut faire ». Une lacune est désormais PROPOSÉE PAR LE MODEL
// de classement (jamais détectée sur des mots), et une lacune acceptée complète
// la DESCRIPTION que lit ce model — elle n'apprend plus aucun mot-clé.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explicitChoice, createObserver } from './pipeline-observe.mjs';
import { classifyEntry, classificationPrompt, classifierChoices } from './pipeline-classify.mjs';
import { createModelRouting } from './model-routing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };

console.log('\n── 1. Décision Q9 : dans le doute, mode LÉGER — une consigne du model');
{
  const p = classificationPrompt('ajoute une option dans la page des réglages');
  t('la consigne du model : hésitation léger / complet → léger', /if unsure between the two → "leger"/.test(p));
  t('/complet explicite l’emporte (choix de l’utilisateur, pas une recherche de mots)', explicitChoice({ text: '/complet ajoute une option de couleur' }).mode === 'complet');
  t('le mode imposé par l’utilisateur est transmis au model, qui ne décide que le reste', /The user already chose mode "complet"/.test(classificationPrompt('x', { mode: 'complet' })));
}

console.log('\n── 2. La lacune vient du MODEL, avec sa proposition — jamais d’une détection de mots');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-model-'));
  fs.writeFileSync(path.join(dir, 'model-routing.json'), JSON.stringify({ version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } } }));
  const answer = { pipeline: 'discussion', mode: 'leger', raison: 'organisation de voyage', lacune: 'créer un pipeline « Voyages » : cadrer, comparer, réserver' };
  const c = await classifyEntry({ root: dir, logsDir: dir, text: 'planifie mes vacances en Italie avec un budget serré', oneShot: async () => ({ ok: true, text: JSON.stringify(answer) }) });
  t('le model propose la lacune et sa solution', c.pipeline === 'discussion' && c.lacune === answer.lacune, JSON.stringify(c));
  const prompt = classificationPrompt('x');
  t('la consigne demande au model de proposer la lacune d’une demande d’action hors pipeline', /no pipeline covers/.test(prompt) && /"lacune"/.test(prompt));
  const obs = createObserver({ logsDir: dir });
  for (const text of ['planifie mes vacances en Italie avec un budget serré', 'fais un audit sécurité et traduis le rapport en anglais', 'bonjour']) {
    t(`« ${text.slice(0, 40)} » : aucune lacune détectée sur des mots à l’observation`, !obs.record({ entry: 'dashboard:chef', text }).gap);
  }
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), path.join(dir, 'scripts', 'dispatch.mjs'));
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({ models: [] }));
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  const mr = createModelRouting({ root: dir, cacheFile: path.join(dir, 'c.json'), fetch: fake, env: { CODEX_HOME: dir }, which: async () => ({ bins: new Set(), py: new Set() }) });
  const obs = createObserver({ logsDir: path.join(dir, 'logs') });
  return { dir, mr, obs };
}

console.log('\n── 3. Journal : lacune proposée par le model, regroupée, décidée');
{
  const { mr, obs, dir } = sandbox();
  await mr.getCatalog();
  const text = 'planifie mes vacances en Italie avec un budget serré';
  const gap = { key: 'model:voyages01', reason: 'aucun-pipeline', why: 'le model de classement ne trouve aucun pipeline pour cette demande d’action', proposal: { kind: 'pipeline', text: 'créer un pipeline « Voyages »' } };
  obs.record({ entry: 'signalement', project: 'P', text, caller: 'porte', gap });
  obs.record({ entry: 'signalement', project: 'P', text, caller: 'porte', gap });
  let g = obs.gaps(mr.gapDecisions());
  t('une demande répétée = une seule lacune, avec son compte', g.open.length === 1 && g.open[0].count === 2 && g.open[0].entries.length === 2);
  const acc = mr.decideGap(g.open[0], 'accept', { choice: 'primary' });
  t('Accepter → pipeline ajouté (identifiant dérivé de la lacune), case « Réaliser » renvoyée', acc.ok && acc.applied.kind === 'pipeline' && acc.applied.pipeline.startsWith('x-') && acc.applied.slot.endsWith('.realiser'), JSON.stringify(acc));
  const eff = mr.view();
  const np = eff.pipelines.find(p => p.id === acc.applied.pipeline);
  t('le pipeline ajouté a ses 4 étapes et ses cases', np && np.custom && np.flow.length === 4 && eff.slots.some(s => s.id === acc.applied.slot));
  t('il n’apprend AUCUN mot-clé', np && !('keywords' in np));
  t('« Cadrer » est une étape de jugement, « Réaliser » une étape d’action', eff.slots.find(s => s.id === `${np.id}.cadrer`)?.judge === true && !eff.slots.find(s => s.id === acc.applied.slot)?.judge);
  t('l’utilisateur peut choisir le model de la nouvelle case', mr.setAssignment(acc.applied.slot, { provider: 'anthropic', model: 'claude-sonnet-5' }).ok);
  g = obs.gaps(mr.gapDecisions());
  t('la lacune quitte la liste ouverte, passe en « décidée »', g.open.length === 0 && g.decided[0].decision.decision === 'accepted');
  t('une seconde décision est refusée (409)', mr.decideGap(g.decided[0], 'reject').status === 409);
  const choices = classifierChoices(dir);
  t('le nouveau pipeline est proposé au MODEL de classement, avec sa description', choices.some(p => p.id === np.id) && classificationPrompt(text, {}, choices).includes(np.id) && /Voyages/.test(np.when));
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'model-routing.json'), 'utf8'));
  t('ajout et décision enregistrés dans model-routing.json (pas ailleurs)', file.custom.pipelines.length === 1 && Object.keys(file.gapDecisions).length === 1);
}

console.log('\n── 4. Les quatre sortes de proposition, et le rejet');
{
  const { mr, dir } = sandbox();
  await mr.getCatalog();
  const mk = (key, proposal) => ({ key, why: 'test', proposal, entries: [{ head: 'publier l’APK sur le store' }] });
  const v = mr.decideGap(mk('k1', { kind: 'variante', pipeline: 'dev', step: 'livrer', id: 'store', label: 'Publication store', text: 'variante' }), 'accept');
  t('variante acceptée → case dev.livrer.store', v.ok && v.applied.slot === 'dev.livrer.store' && mr.view().slots.some(s => s.id === 'dev.livrer.store'));
  const e = mr.decideGap(mk('k2', { kind: 'etape', pipeline: 'dev', after: 'livrer', id: 'surveiller', label: 'Surveiller', text: 'étape' }), 'accept');
  const devFlow = mr.view().pipelines.find(p => p.id === 'dev').flow.map(n => n.id);
  t('étape acceptée → insérée juste après « Livrer »', e.ok && devFlow.indexOf('surveiller') === devFlow.indexOf('livrer') + 1);
  const a = mr.decideGap(mk('k3', { kind: 'rattachement', pipeline: 'redaction', keywords: ['newsletter'], text: 'rattachement' }), 'accept');
  const red = mr.view().pipelines.find(p => p.id === 'redaction');
  t('rattachement accepté → description complétée, aucun mot-clé appris', a.ok && /Aussi/.test(red.when) && typeof mr.classifierExtras === 'undefined');
  t('… et c’est cette description que lit le model de classement', /Aussi/.test(classifierChoices(dir).find(p => p.id === 'redaction').when));
  t('Rejeter → rien n’est ajouté', mr.decideGap(mk('k4', { kind: 'variante', pipeline: 'dev', step: 'vert', id: 'rejetee', text: 'x' }), 'reject').ok && !mr.view().slots.some(s => s.id === 'dev.vert.rejetee'));
  t('proposition invalide refusée (étape cible inconnue)', mr.decideGap(mk('k5', { kind: 'variante', pipeline: 'dev', step: 'nexistepas', id: 'x', text: 'x' }), 'accept').status === 400);
  t('identifiant invalide refusé', mr.decideGap(mk('k6', { kind: 'etape', pipeline: 'dev', after: 'livrer', id: '../x', text: 'x' }), 'accept').status === 400);
  t('les 13 pipelines du code restent intacts (ajouts seulement locaux)', (await import('./model-pipelines.mjs')).PIPELINES.find(p => p.id === 'dev').flow.every(n => n.id !== 'surveiller'));
}

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
