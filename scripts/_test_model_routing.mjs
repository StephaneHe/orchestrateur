// Suite « Models par tâche » (0.39.0) — scripts/model-routing.mjs, sans réseau.
//   node scripts/_test_model_routing.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelRouting, TASK_TYPES, STAGES, HISTORY_MAX } from './model-routing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), path.join(dir, 'scripts', 'dispatch.mjs'));
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({ fetched_at: 'x', models: [{ slug: 'gpt-6-astra', priority: 1 }, { slug: 'bad slug!', priority: 2 }] }));
  return dir;
}
const SECRET = 'sk-or-v1-' + 'f'.repeat(64);
const fakeFetch = (fail) => async (url) => {
  if (fail) throw new Error('réseau coupé');
  const data = url.includes('nvidia')
    ? [{ id: 'moonshotai/kimi-k3' }, { id: 'z-ai/glm-5.3' }, { id: 'nvidia/nemotron-3-embed-1b' }]
    : [{ id: 'qwen/qwen3-coder', supported_parameters: ['tools'] }, { id: 'x/no-tools', supported_parameters: [] }];
  return { ok: true, status: 200, json: async () => ({ data }) };
};

console.log('\n── 1. Les 20 types de tâche en 6 étapes');
t('20 types numérotés 1→20', TASK_TYPES.length === 20 && TASK_TYPES.every((x, i) => x.n === i + 1));
t('6 étapes dans l’ordre demandé', STAGES.map(s => s.label).join(' > ') === 'Réfléchir > Écrire > Corriger > Vérifier > Livrer / opérer > Écrire sur le code');
t('chaque type a une étape connue, un libellé et une description', TASK_TYPES.every(x => STAGES.some(s => s.id === x.stage) && x.label && x.description));
t('identifiants uniques', new Set(TASK_TYPES.map(x => x.id)).size === 20);

console.log('\n── 2. Catalogue');
{
  const dir = sandbox();
  const mr = createModelRouting({ root: dir, cacheFile: path.join(dir, 'cache.json'), fetch: fakeFetch(false), env: { CODEX_HOME: dir } });
  const c = await mr.getCatalog({ refresh: true });
  t('Anthropic : liste vérifiée (8)', c.providers.anthropic.models.length === 8);
  t('OpenAI : models_cache de codex, identifiants invalides écartés', c.providers.openai.models.map(m => m.id).join() === 'gpt-6-astra');
  const nv = c.providers.nvidia.models;
  t('NVIDIA : la cascade du failover vient de dispatch.mjs, en tête', nv[0].id === 'moonshotai/kimi-k3' && nv[0].cascade === 1);
  t('NVIDIA : un model de la cascade absent du catalogue est signalé', nv.some(m => m.cascade && m.missing));
  t('NVIDIA : les embeddings sont écartés', !nv.some(m => /embed/.test(m.id)));
  t('OpenRouter : seulement les models à outils', c.providers.openrouter.models.map(m => m.id).join() === 'qwen/qwen3-coder');
  t('OpenRouter : clé absente → groupe désactivé', c.providers.openrouter.keyPresent === false && c.providers.openrouter.disabled === true);
  t('cache écrit', fs.existsSync(path.join(dir, 'cache.json')));

  // Source injoignable : la dernière liste connue reste servie.
  const mr2 = createModelRouting({ root: dir, cacheFile: path.join(dir, 'cache.json'), fetch: fakeFetch(true), env: { CODEX_HOME: dir } });
  const c2 = await mr2.getCatalog({ refresh: true });
  t('réseau coupé : listes NVIDIA/OpenRouter conservées et marquées', c2.providers.nvidia.stale === true && c2.providers.nvidia.models.length === nv.length && /injoignable/.test(c2.providers.openrouter.error || ''));
}

console.log('\n── 3. Clé OpenRouter : présence seulement, jamais la valeur');
{
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, '.env'), `OTHER=1\nOPENROUTER_API_KEY="${SECRET}"\n`);
  const mr = createModelRouting({ root: dir, cacheFile: path.join(dir, 'cache.json'), fetch: fakeFetch(false), env: { CODEX_HOME: dir, OPENROUTER_API_KEY: SECRET } });
  const k = mr.openrouterKey();
  t('présente, dans le .env et la variable d’environnement', k.present && k.where.length === 2);
  const c = await mr.getCatalog({ refresh: true });
  const dump = JSON.stringify(c) + JSON.stringify(k) + fs.readFileSync(path.join(dir, 'cache.json'), 'utf8');
  t('la valeur n’apparaît ni dans le catalogue ni dans le cache', !dump.includes(SECRET) && !dump.includes('sk-or-'));
  t('groupe activé avec la clé', c.providers.openrouter.disabled === false);
  const r = mr.setAssignment('revue', { provider: 'openrouter', model: 'qwen/qwen3-coder' });
  t('choix OpenRouter accepté avec la clé', r.ok && r.changed);
  fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=\n');
  const mr3 = createModelRouting({ root: dir, cacheFile: path.join(dir, 'cache.json'), fetch: fakeFetch(false), env: { CODEX_HOME: dir } });
  t('valeur vide = absente', mr3.openrouterKey().present === false);
}

console.log('\n── 4. Enregistrement, validation, historique');
{
  const dir = sandbox();
  const mr = createModelRouting({ root: dir, cacheFile: path.join(dir, 'cache.json'), fetch: fakeFetch(false), env: { CODEX_HOME: dir } });
  await mr.getCatalog();
  t('type inconnu → 404', mr.setAssignment('nope', { provider: 'anthropic', model: 'claude-opus-5-5' }).status === 404);
  t('fournisseur inconnu → 400', mr.setAssignment('plan', { provider: 'x', model: 'y' }).status === 400);
  t('identifiant invalide → 400', mr.setAssignment('plan', { provider: 'anthropic', model: 'a b' }).status === 400);
  t('model hors liste → 400', mr.setAssignment('plan', { provider: 'anthropic', model: 'claude-x' }).status === 400);
  t('OpenRouter sans clé → 409', mr.setAssignment('plan', { provider: 'openrouter', model: 'qwen/qwen3-coder' }).status === 409);
  const a = mr.setAssignment('plan', { provider: 'openai', model: 'gpt-6-astra' }, 'chef');
  t('choix enregistré', a.ok && a.changed);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'model-routing.json'), 'utf8'));
  t('écrit dans model-routing.json', onDisk.assignments.plan.model === 'gpt-6-astra');
  t('aucun fichier temporaire laissé', !fs.readdirSync(dir).some(f => f.endsWith('.tmp')));
  t('même choix : pas de nouvelle ligne d’historique', !mr.setAssignment('plan', { provider: 'openai', model: 'gpt-6-astra' }).changed && mr.view().historyTotal === 1);
  mr.setAssignment('plan', null);
  const v = mr.view();
  t('(défaut du projet) retire le choix', !v.assignments.plan);
  t('historique : ancien → nouveau, auteur, plus récent d’abord', v.history[0].from === 'openai:gpt-6-astra' && v.history[0].to === null && v.history[1].by === 'chef');
  for (let i = 0; i < HISTORY_MAX + 20; i++) mr.setAssignment('git', i % 2 ? { provider: 'anthropic', model: 'claude-opus-5-5' } : null);
  t(`historique borné à ${HISTORY_MAX}`, mr.view().historyTotal === HISTORY_MAX);
  fs.writeFileSync(path.join(dir, 'model-routing.json'), '{cassé');
  t('fichier illisible : vue vide, pas d’exception', Object.keys(mr.view().assignments).length === 0);
}

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
