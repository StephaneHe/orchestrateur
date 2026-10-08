#!/usr/bin/env node
// scripts/_test_model_reco.mjs — suggestions de la page Models (0.46.0)
//
// Demande utilisateur (2026-10-08, via le chef, réponse « Continue ») : appliquer
// à la page Models la recommandation consolidée de l'étude comparative, en
// SUGGESTIONS, sans toucher à ses choix ; ajouter claude-haiku-5-5 ; retirer
// gpt-reserve et gpt-5.5 ; marquer les models dominés ; gpt-6.1-sol et
// gpt-6-luna « annoncés », sélectionnables dès qu'ils sont dans codex.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecommendations, validate } from './model-reco.mjs';
import { createModelRouting, decorateCatalog, incompatibility, ANTHROPIC_VERIFIED, SLOTS } from './model-routing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'model-recommendations.json');
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };

console.log('\n── 1. Fichier de données (versionné, régénérable)');
const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
t('forme valide (schéma 1, date du rapport, étapes, cases)', validate(raw) === null, validate(raw));
t('date du rapport et commit de la source', raw.report.date === '2026-10-08' && raw.report.commit === 'a8c5cc2');
t('les 25 étapes du rapport, chacune avec principal, alternative(s), confiance et section', Object.keys(raw.steps).length === 25 && Object.values(raw.steps).every(s => s.principal && Array.isArray(s.alternatives) && s.confidence && s.section && s.why));
t('étapes « non tranchées » du rapport signalées : Discussion, Refactor, Recherche, Rédaction', ['discussion', 'refactor', 'recherche', 'redaction'].every(k => raw.steps[k].undecided === true) && Object.values(raw.steps).filter(s => s.undecided).length === 4);
t('CHAQUE case des 13 pipelines a une suggestion explicite', SLOTS.every(s => raw.slots[s.id]), SLOTS.filter(s => !raw.slots[s.id]).map(s => s.id).join(','));
t('aucune valeur de model codée en dur dans public/models.js', !/claude-(opus|sonnet|haiku|fable)-|gpt-\d/.test(fs.readFileSync(path.join(ROOT, 'public', 'models.js'), 'utf8')));
t('aucune valeur de model codée en dur dans scripts/model-reco.mjs', !/claude-(opus|sonnet|haiku|fable)-|gpt-\d/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'model-reco.mjs'), 'utf8')));
t('aucun nom de projet privé du config.json local dans le fichier (dépôt public)', (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const text = JSON.stringify(raw);
    return !cfg.projects.map(p => p.name).filter(n => n.length > 3 && !/^(chef|orchestrateur)$/i.test(n))
      .some(n => new RegExp(`(?<![\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(text));
  } catch { return true; }
})());
t('un fichier cassé est refusé en entier (validation)', validate({ schema: 1, report: { date: '2026-10-08' }, steps: {}, slots: { 'dev.vert': 'inconnue' } }) !== null && validate({ schema: 2 }) !== null);

console.log('\n── 2. Listes de models');
t('claude-haiku-5-5 dans la liste Anthropic (vérifiée avec la CLI)', ANTHROPIC_VERIFIED.models.includes('claude-haiku-5-5'));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-'));
const fx = path.join(sandbox, 'fixtures');
fs.mkdirSync(fx);
const writeCodex = (slugs) => fs.writeFileSync(path.join(fx, 'models_cache.json'), JSON.stringify({ fetched_at: '2026-10-08T12:00:00Z', models: slugs.map((s, i) => ({ slug: s, visibility: /reserve|5\.5$/.test(s) ? 'hide' : 'list', priority: i })) }));
writeCodex(['gpt-6-astra', 'gpt-reserve', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
fs.writeFileSync(path.join(fx, 'nvidia.json'), JSON.stringify({ data: [] }));
fs.writeFileSync(path.join(fx, 'openrouter.json'), JSON.stringify({ data: [] }));
fs.writeFileSync(path.join(fx, 'local-tools.json'), JSON.stringify({ bins: ['ffmpeg', 'ffprobe'], py: [] }));
const reco = createRecommendations({ file: DATA });
const mr = createModelRouting({ root: sandbox, cacheFile: path.join(sandbox, 'cache.json'), env: { MODEL_CATALOG_FIXTURES: fx }, catalogRules: () => reco.catalogRules() });
let cat = await mr.getCatalog({ refresh: true });
const oai = () => cat.providers.openai.models;
t('gpt-reserve et gpt-5.5 absents des menus', !oai().some(m => m.id === 'gpt-reserve' || m.id === 'gpt-5.5'));
t('les retraits sont publiés avec leur raison (pour l\'avertissement « obsolète »)', cat.removed.length === 2 && cat.removed.every(r => r.reason && r.source));
const dom = ['claude-opus-5', 'claude-opus-4-8', 'claude-fable-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
t('dominés marqués avec la raison et la source : opus-5, opus-4-8, fable-5, sonnet-5, haiku-4-5, gpt-5.6-sol',
  dom.every(id => cat.providers.anthropic.models.find(m => m.id === id)?.dominated?.reason) && oai().find(m => m.id === 'gpt-5.6-sol')?.dominated?.source);
t('les dominés restent sélectionnables (compatibilité)', cat.providers.anthropic.models.find(m => m.id === 'claude-opus-5') && !cat.providers.anthropic.models.find(m => m.id === 'claude-opus-5').unavailable);
t('gpt-6.1-sol et gpt-6-luna : « annoncé, pas encore disponible dans codex », non sélectionnables',
  ['gpt-6.1-sol', 'gpt-6-luna'].every(id => { const m = oai().find(x => x.id === id); return m?.unavailable && /annoncé, pas encore disponible dans codex/.test(m.label); }));
const refused = mr.setAssignment('dev.vert.migration', { provider: 'openai', model: 'gpt-6.1-sol' }, 'test');
t('le serveur refuse un model annoncé (409)', refused.status === 409, JSON.stringify(refused));
t('le serveur refuse un model retiré (400)', mr.setAssignment('dev.vert', { provider: 'openai', model: 'gpt-reserve' }, 'test').status === 400);
writeCodex(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-luna']);
cat = await mr.getCatalog({ refresh: true });
t('dès que gpt-6.1-sol apparaît dans models_cache.json : sélectionnable automatiquement', oai().filter(m => m.id === 'gpt-6.1-sol').length === 1 && !oai().find(m => m.id === 'gpt-6.1-sol').unavailable && mr.setAssignment('dev.vert.migration', { provider: 'openai', model: 'gpt-6.1-sol' }, 'test').ok);
t('gpt-6-luna reste annoncé tant qu\'il n\'y est pas', oai().find(m => m.id === 'gpt-6-luna')?.unavailable === true);
const resolvedNow = reco.resolve(mr.effective().slots, cat, incompatibility).slots;
t('la cible devient l\'alternative disponible (migration → gpt-6.1-sol)', resolvedNow['dev.vert.migration'].alternatives.find(a => a.model === 'gpt-6.1-sol')?.available === true);
mr.setAssignment('dev.vert.migration', null, 'test');
t('décoration idempotente (catalogue en cache relu plusieurs fois)', (() => { const c = JSON.parse(JSON.stringify(cat)); decorateCatalog(c, reco.catalogRules()); decorateCatalog(c, reco.catalogRules()); return c.providers.openai.models.filter(m => m.id === 'gpt-6-luna').length === 1; })());
writeCodex(['gpt-6-astra', 'gpt-reserve', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
cat = await mr.getCatalog({ refresh: true });

console.log('\n── 3. Suggestions et application');
const v = reco.view(mr.effective().slots, cat, incompatibility);
t('une suggestion pour chacune des 102 cases', v.counts.withSuggestion === SLOTS.length && SLOTS.length === 102, JSON.stringify(v.counts));
t('chaque suggestion porte confiance, section et justification', Object.values(v.slots).every(s => s.confidence && s.section && s.why));
t('applicabilité expliquée (hors listes, non installé…)', v.slots['images.produire.generation'].principal.applicable === false && /hors des listes/.test(v.slots['images.produire.generation'].principal.reason));
t('cible absente → repli « aujourd\'hui » montré (liste de tests → claude-sonnet-5-5)', (() => { const a = v.slots['dev.liste-tests'].alternatives[0]; return a.model === 'gpt-6.1-sol' && a.available === false && a.today.model === 'claude-sonnet-5-5'; })());
// Choix de l'utilisateur : jamais touché par « cases vides seulement ».
mr.setAssignment('dev.concevoir', { provider: 'openai', model: 'gpt-6-astra' }, 'utilisateur');
mr.setAssignment('dev.vert.simple', { provider: 'openai', model: 'gpt-5.6-luna' }, 'utilisateur');
// Choix existant sur un model retiré : conservé (marqué obsolète par l'interface).
const routingFile = path.join(sandbox, 'model-routing.json');
const j = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
j.assignments['maintenance.dette'] = { provider: 'openai', model: 'gpt-5.5', at: '2026-10-01T00:00:00Z' };
fs.writeFileSync(routingFile, JSON.stringify(j));
const before = JSON.stringify(mr.readRouting().assignments);
reco.view(mr.effective().slots, cat, incompatibility);
t('afficher les suggestions ne modifie AUCUN choix', JSON.stringify(mr.readRouting().assignments) === before);
const assignments = mr.readRouting().assignments;
const { plan, skipped } = reco.applyPlan(reco.resolve(mr.effective().slots, cat, incompatibility).slots, assignments, { mode: 'empty' });
t('« étapes vides seulement » : aucune case déjà choisie dans le plan', !plan.some(p => assignments[p.slot]) && ['dev.concevoir', 'dev.vert.simple', 'maintenance.dette'].every(id => skipped.some(s => s.slot === id && /déjà choisie/.test(s.reason))));
t('« étapes vides seulement » : une variante qui hérite déjà de la même suggestion reste vide', skipped.some(s => s.slot === 'dev.comprendre.codebase' && /hérite/.test(s.reason)) && !plan.some(p => p.slot === 'dev.comprendre.codebase'));
t('« étapes vides seulement » : une variante à suggestion propre est remplie (vert.complexe)', plan.some(p => p.slot === 'dev.vert.complexe' && p.model === 'claude-opus-5-5'));
for (const p of plan) mr.setAssignment(p.slot, { provider: p.provider, model: p.model }, 'suggestion du rapport 2026-10-08 (cases vides)');
const after = mr.readRouting();
t('après application : les choix existants sont intacts', after.assignments['dev.concevoir'].model === 'gpt-6-astra' && after.assignments['dev.vert.simple'].model === 'gpt-5.6-luna' && after.assignments['maintenance.dette'].model === 'gpt-5.5');
t('les cases vides ont reçu la suggestion', after.assignments['dev.comprendre'].model === 'claude-opus-5-5' && after.assignments['routage.classifier'].model === 'claude-haiku-5-5');
t('chaque application est dans l\'historique', after.history.filter(h => /suggestion du rapport/.test(h.by)).length === plan.length);
const one = reco.applyPlan(reco.resolve(mr.effective().slots, cat, incompatibility).slots, after.assignments, { mode: 'one', slots: ['dev.concevoir'] });
t('« Appliquer la suggestion » (clic explicite) : remplace cette case seulement, et le dit', one.plan.length === 1 && one.plan[0].slot === 'dev.concevoir' && one.plan[0].from === 'openai:gpt-6-astra' && one.plan[0].model === 'claude-opus-5-5');

console.log('\n── 4. Âge du rapport');
const at = (iso) => createRecommendations({ file: DATA, now: () => Date.parse(iso) }).age();
t('frais le jour même', at('2026-10-08T12:00:00Z').level === 'fresh');
t('« à refaire d\'ici 1-2 mois » à partir de 30 jours', at('2026-11-08T12:00:00Z').level === 'aging');
t('dépassé à partir de 60 jours', at('2026-12-08T12:00:00Z').level === 'stale' && at('2026-12-08T12:00:00Z').days === 61);

console.log('\n── 5. Câblage');
const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
t('server.js : GET /api/model-recommendations et POST apply-suggestions (même origine, dryRun)', /app\.get\('\/api\/model-recommendations'/.test(srv) && /apply-suggestions', sameOriginOnly/.test(srv) && /b\.dryRun/.test(srv));
t('la régression copie data/ dans l\'instance de test', /'tests', 'data'\]/.test(fs.readFileSync(path.join(ROOT, 'scripts', '_regression_sandbox.mjs'), 'utf8')));

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
