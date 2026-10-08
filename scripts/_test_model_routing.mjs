// Suite « Models par tâche » (0.39.0 → 0.40.0 : pipelines) — scripts/model-routing.mjs, sans réseau.
//   node scripts/_test_model_routing.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelRouting, PIPELINES, SLOTS, LEGACY_MAP, HISTORY_MAX, incompatibility } from './model-routing.mjs';
import { JUDGE_STEPS } from './model-pipelines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), path.join(dir, 'scripts', 'dispatch.mjs'));
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({ fetched_at: 'x', models: [
    { slug: 'gpt-6-astra', priority: 1, input_modalities: ['text', 'image'] }, { slug: 'bad slug!', priority: 2 },
  ] }));
  return dir;
}
const SECRET = 'sk-or-v1-' + 'f'.repeat(64);
const mod = (i, o) => ({ input_modalities: i, output_modalities: o });
const fakeFetch = (fail) => async (url) => {
  if (fail) throw new Error('réseau coupé');
  const data = url.includes('nvidia')
    ? [{ id: 'moonshotai/kimi-k3' }, { id: 'z-ai/glm-5.3' }, { id: 'nvidia/nemotron-3-embed-1b' }, { id: 'nvidia/vila' }, { id: 'nvidia/cosmos-reason2-8b' }]
    : [
      { id: 'qwen/qwen3-coder', supported_parameters: ['tools'], architecture: mod(['text'], ['text']) },
      { id: 'x/no-tools', supported_parameters: [], architecture: mod(['text'], ['text']) },
      { id: 'google/gemini-3-pro-image', supported_parameters: [], architecture: mod(['text', 'image'], ['text', 'image']) },
      { id: 'openai/gpt-audio', supported_parameters: [], architecture: mod(['text', 'audio'], ['text', 'audio']) },
    ];
  return { ok: true, status: 200, json: async () => ({ data }) };
};
const fakeWhich = async () => ({ bins: new Set(['ffmpeg', 'whisper']), py: new Set(['PIL']) });
const make = (dir, extra = {}) => createModelRouting({ root: dir, cacheFile: path.join(dir, 'cache.json'), fetch: fakeFetch(false), env: { CODEX_HOME: dir }, which: fakeWhich, ...extra });
const stepsOf = (p) => p.flow.flatMap(n => (n.kind === 'loop' ? n.steps : [n]));

console.log('\n── 1. Les 13 pipelines');
t('13 pipelines dans l’ordre demandé', PIPELINES.map(p => p.id).join() === 'dev,discussion,routage,incident,recherche,audit,maintenance,nouveau,donnees,redaction,images,video,audio');
t('chaque pipeline a un bandeau (à quoi il sert, quand)', PIPELINES.every(p => p.purpose && p.when));
const incomplete = PIPELINES.flatMap(p => stepsOf(p).filter(s => !s.title || !s.what || !s.example || !s.n).map(s => `${p.id}.${s.id}`));
t('chaque étape a numéro, titre, quand/quoi et exemple', !incomplete.length, incomplete.join(', '));
const dev = PIPELINES[0];
const loop = dev.flow.find(n => n.kind === 'loop');
t('Développement : 1 → 2 → S → 3 → boucle 4 → 5 → 6 → 7', dev.flow.map(n => n.n).join() === '1,2,S,3,4,5,6,7');
t('boucle TDD 4a → 4b → 4c → retour 4a', loop.steps.map(s => s.n).join() === '4a,4b,4c' && loop.back.from === 'refactor' && loop.back.to === 'rouge');
t('4c Refactor optionnel, Spike conditionnel', stepsOf(dev).find(s => s.id === 'refactor').optional && stepsOf(dev).find(s => s.id === 'spike').optional);
t('Revue : retour vers la boucle 4', stepsOf(dev).find(s => s.id === 'revue').returns[0].to === 'tdd');
t('Spike : retour vers 3', stepsOf(dev).find(s => s.id === 'spike').returns[0].to === 'liste-tests');
t('4b Vert : 5 variantes, 4a : variante Bugfix', stepsOf(dev).find(s => s.id === 'vert').variants.length === 5 && stepsOf(dev).find(s => s.id === 'rouge').variants.some(v => v.id === 'bugfix'));
t('Bugfix et Spike expliqués dans le bandeau', dev.variantsInfo.map(v => v.label).join() === 'Bugfix,Spike');
const inc = PIPELINES.find(p => p.id === 'incident');
t('Incident : Corriger renvoie au pipeline Développement', stepsOf(inc).find(s => s.id === 'corriger').ref.pipeline === 'dev');
t('Incident : Diagnostiquer simple / difficile', stepsOf(inc).find(s => s.id === 'diagnostiquer').variants.map(v => v.id).join() === 'simple,difficile');
t('Nouveau projet : MVP renvoie à Développement', stepsOf(PIPELINES.find(p => p.id === 'nouveau')).find(s => s.id === 'mvp').ref.pipeline === 'dev');
t('Images : vérification → retour à générer', stepsOf(PIPELINES.find(p => p.id === 'images')).find(s => s.id === 'verifier').returns[0].to === 'produire');
t('Images : 5 variantes (génération, retouche, OCR, légende, vignettes)', stepsOf(PIPELINES.find(p => p.id === 'images')).find(s => s.id === 'produire').variants.length === 5);
t('Vidéo et Audio : 5 et 4 étapes', stepsOf(PIPELINES.find(p => p.id === 'video')).length === 5 && stepsOf(PIPELINES.find(p => p.id === 'audio')).length === 4);
const refs = new Set(PIPELINES.flatMap(p => stepsOf(p).filter(s => s.ref).map(s => `${p.id}.${s.id}`)));
const missing = PIPELINES.flatMap(p => stepsOf(p).flatMap(s => [s.ref ? null : `${p.id}.${s.id}`, ...(s.variants || []).map(v => `${p.id}.${s.id}.${v.id}`)])).filter(Boolean).filter(id => !SLOTS.some(x => x.id === id));
t('une case par étape (hors renvois) et par variante', !missing.length && SLOTS.every(s => !refs.has(s.id)), missing.join(', '));
t('étapes de jugement : toutes existent et portent une case marquée', [...JUDGE_STEPS].every(id => SLOTS.some(s => s.id === id && s.judge)) && SLOTS.filter(s => s.id === 'dev.vert').every(s => !s.judge));
t('les cibles de retour existent', PIPELINES.every(p => { const ids = new Set([...p.flow.map(n => n.id), ...stepsOf(p).map(s => s.id)]); return stepsOf(p).every(s => (s.returns || []).every(r => ids.has(r.to))); }));
t('l’ancienne structure (20 types) se projette sur des cases existantes', Object.keys(LEGACY_MAP).length === 20 && Object.values(LEGACY_MAP).flat().every(id => SLOTS.some(s => s.id === id)));
const publicText = JSON.stringify(PIPELINES);
t('aucun nom de projet privé du config.json local dans les exemples', (() => {
  try { const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); return !cfg.projects.map(p => p.name).filter(n => n.length > 3 && !/^(chef|orchestrateur)$/i.test(n)).some(n => new RegExp(`(?<![\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(publicText)); } catch { return true; }
})());

console.log('\n── 2. Catalogue et capacités');
{
  const dir = sandbox();
  const mr = make(dir);
  const c = await mr.getCatalog({ refresh: true });
  t('Anthropic : 8 models, vision, sans génération d’image', c.providers.anthropic.models.length === 8 && c.providers.anthropic.models.every(m => m.caps.includes('vision') && !m.caps.includes('image-gen')));
  t('OpenAI : models_cache de codex, vision lue dans input_modalities', c.providers.openai.models.map(m => m.id).join() === 'gpt-6-astra' && c.providers.openai.models[0].caps.includes('vision'));
  const nv = c.providers.nvidia.models;
  t('NVIDIA : la cascade du failover en tête', nv[0].id === 'moonshotai/kimi-k3' && nv[0].cascade === 1);
  t('NVIDIA : model de la cascade absent du catalogue signalé', nv.some(m => m.cascade && m.missing));
  t('NVIDIA : embeddings écartés, vision et vidéo déduites du nom', !nv.some(m => /embed/.test(m.id)) && nv.find(m => m.id === 'nvidia/vila').caps.includes('vision') && nv.find(m => m.id === 'nvidia/cosmos-reason2-8b').caps.includes('video-in'));
  const or = c.providers.openrouter.models;
  t('OpenRouter : texte seulement avec outils', or.find(m => m.id === 'qwen/qwen3-coder').caps.includes('text') && !or.some(m => m.id === 'x/no-tools'));
  t('OpenRouter : génération d’image et TTS détectés', or.find(m => m.id === 'google/gemini-3-pro-image').caps.includes('image-gen') && or.find(m => m.id === 'openai/gpt-audio').caps.includes('audio-out'));
  t('OpenRouter : model média sans outils non proposé pour du code', !or.find(m => m.id === 'google/gemini-3-pro-image').caps.includes('text'));
  t('OpenRouter : clé absente → groupe désactivé', c.providers.openrouter.keyPresent === false && c.providers.openrouter.disabled === true);
  const loc = c.providers.local.models;
  t('outils locaux : installés / non installés', loc.find(x => x.id === 'ffmpeg').installed && loc.find(x => x.id === 'whisper').installed && loc.find(x => x.id === 'pillow').installed && !loc.find(x => x.id === 'piper').installed && /non installé/.test(loc.find(x => x.id === 'piper').label));
  t('synthèse vocale du navigateur toujours disponible', loc.find(x => x.id === 'web-speech').installed);
  t('cache écrit (schéma 2)', JSON.parse(fs.readFileSync(path.join(dir, 'cache.json'), 'utf8')).schema === 2);
  const mr2 = make(dir, { fetch: fakeFetch(true) });
  const c2 = await mr2.getCatalog({ refresh: true });
  t('réseau coupé : listes NVIDIA/OpenRouter conservées et marquées', c2.providers.nvidia.stale === true && c2.providers.nvidia.models.length === nv.length && /injoignable/.test(c2.providers.openrouter.error || ''));
  fs.writeFileSync(path.join(dir, 'cache.json'), JSON.stringify({ providers: { anthropic: { models: [] } } }));
  const c3 = await make(dir).getCatalog();
  t('ancien cache (sans capacités) reconstruit', c3.schema === 2 && c3.providers.local);
}

console.log('\n── 3. Compatibilité étape ↔ model');
t('génération d’image : un model texte refusé', !!incompatibility({ llm: 'image-gen', local: [] }, 'anthropic', { caps: ['text', 'vision'] }));
t('génération d’image : un model qui génère accepté', incompatibility({ llm: 'image-gen', local: [] }, 'openrouter', { caps: ['image-gen'] }) === null);
t('étape sans LLM (vignettes) : un LLM refusé', /outil local/.test(incompatibility({ llm: null, local: ['thumbnails'] }, 'openai', { caps: ['text'] }) || ''));
t('outil local hors sujet refusé', !!incompatibility({ llm: 'text', local: [] }, 'local', { caps: ['video-edit'], installed: true }));
t('outil local non installé refusé', /non installé/.test(incompatibility({ llm: 'audio-out', local: ['tts'] }, 'local', { caps: ['tts'], installed: false }) || ''));

console.log('\n── 4. Clé OpenRouter : présence seulement, jamais la valeur');
{
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, '.env'), `OTHER=1\nOPENROUTER_API_KEY="${SECRET}"\n`);
  const mr = make(dir, { env: { CODEX_HOME: dir, OPENROUTER_API_KEY: SECRET } });
  const k = mr.openrouterKey();
  t('présente, dans le .env et la variable d’environnement', k.present && k.where.length === 2);
  const c = await mr.getCatalog({ refresh: true });
  const dump = JSON.stringify(c) + JSON.stringify(k) + fs.readFileSync(path.join(dir, 'cache.json'), 'utf8');
  t('la valeur n’apparaît ni dans le catalogue ni dans le cache', !dump.includes(SECRET) && !dump.includes('sk-or-'));
  t('groupe activé avec la clé', c.providers.openrouter.disabled === false);
  t('choix OpenRouter accepté avec la clé', mr.setAssignment('dev.revue.code', { provider: 'openrouter', model: 'qwen/qwen3-coder' }).changed);
  t('génération d’image OpenRouter acceptée', mr.setAssignment('images.produire.generation', { provider: 'openrouter', model: 'google/gemini-3-pro-image' }).ok);
  fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=\n');
  t('valeur vide = absente', make(dir).openrouterKey().present === false);
}

console.log('\n── 5. Migration de l’ancien format (0.39.0)');
{
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'model-routing.json'), JSON.stringify({ version: 1, updatedAt: 'x', history: [{ at: 'x', task: 'plan', from: null, to: 'anthropic:claude-opus-5-5' }], assignments: {
    plan: { provider: 'anthropic', model: 'claude-opus-5-5' },
    synthese: { provider: 'anthropic', model: 'claude-opus-5-5' },
    'analyse-crash': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    disparu: { provider: 'anthropic', model: 'claude-opus-5-5' },
  } }));
  const mr = make(dir);
  const v = mr.view();
  t('reprises sur les nouvelles cases', v.assignments['dev.concevoir.plan']?.model === 'claude-opus-5-5' && v.assignments['recherche.synthetiser'] && v.assignments['dev.documenter.rapport'] && v.assignments['incident.diagnostiquer']?.model === 'claude-sonnet-5-5');
  t('perte signalée avec sa raison', v.migration.lost.length === 1 && v.migration.lost[0].from === 'disparu' && /sans équivalent/.test(v.migration.lost[0].reason));
  t('détail des reprises', v.migration.mapped.length === 3);
  t('ancien fichier sauvegardé, nouveau au format 2', fs.existsSync(path.join(dir, 'model-routing.json.v1-bak')) && JSON.parse(fs.readFileSync(path.join(dir, 'model-routing.json'), 'utf8')).version === 2);
  t('historique conservé et migration tracée', v.history.some(e => e.task === 'plan') && v.history.some(e => /migration/.test(e.by || '')));
  const again = make(dir).view();
  t('migration faite une seule fois', JSON.stringify(again.assignments) === JSON.stringify(v.assignments) && again.migration.at === v.migration.at);
}

console.log('\n── 6. Enregistrement, validation, historique');
{
  const dir = sandbox();
  const mr = make(dir);
  await mr.getCatalog();
  t('case inconnue → 404', mr.setAssignment('dev.nope', { provider: 'anthropic', model: 'claude-opus-5-5' }).status === 404);
  t('un renvoi n’a pas de case → 404', mr.setAssignment('incident.corriger', { provider: 'anthropic', model: 'claude-opus-5-5' }).status === 404);
  t('fournisseur inconnu → 400', mr.setAssignment('dev.rouge', { provider: 'x', model: 'y' }).status === 400);
  t('identifiant invalide → 400', mr.setAssignment('dev.rouge', { provider: 'anthropic', model: 'a b' }).status === 400);
  t('model hors liste → 400', mr.setAssignment('dev.rouge', { provider: 'anthropic', model: 'claude-x' }).status === 400);
  t('OpenRouter sans clé → 409', mr.setAssignment('dev.rouge', { provider: 'openrouter', model: 'qwen/qwen3-coder' }).status === 409);
  t('génération d’image avec un model texte → 400', mr.setAssignment('images.produire.generation', { provider: 'anthropic', model: 'claude-opus-5-5' }).status === 400);
  t('outil local non installé → 409', mr.setAssignment('audio.traiter.tts', { provider: 'local', model: 'piper' }).status === 409);
  t('outil local pour du code → 400', mr.setAssignment('dev.vert', { provider: 'local', model: 'ffmpeg' }).status === 400);
  t('ffmpeg pour la découpe vidéo → accepté', mr.setAssignment('video.monter.decoupe', { provider: 'local', model: 'ffmpeg' }).ok);
  t('synthèse du navigateur pour le TTS → acceptée', mr.setAssignment('audio.traiter.tts', { provider: 'local', model: 'web-speech' }).ok);
  t('vision NVIDIA pour la vérification visuelle → acceptée', mr.setAssignment('images.verifier', { provider: 'nvidia', model: 'nvidia/vila' }).ok);
  // Réponse utilisateur n° 7 : NVIDIA / OpenRouter gardés, outillage en construction.
  const harness = mr.setAssignment('dev.vert', { provider: 'nvidia', model: 'z-ai/glm-5.3' });
  t('NVIDIA sur une étape d’action (4b) → 409 « outillage en construction »', harness.status === 409 && /outillage/.test(harness.error));
  t('NVIDIA sur une étape de jugement (revue) → accepté', mr.setAssignment('dev.revue.code', { provider: 'nvidia', model: 'z-ai/glm-5.3' }).ok);
  t('NVIDIA pour classifier (Routage) → accepté', mr.setAssignment('routage.classifier', { provider: 'nvidia', model: 'z-ai/glm-5.3' }).ok);
  t('Anthropic / codex restent acceptés sur une étape d’action', mr.setAssignment('dev.vert', { provider: 'anthropic', model: 'claude-sonnet-5' }).ok);
  t('la vue expose les fournisseurs sans harnais', mr.view().agentHarness.nvidia === false && mr.view().agentHarness.openrouter === false && mr.view().agentHarness.anthropic === true);
  const a = mr.setAssignment('dev.rouge', { provider: 'openai', model: 'gpt-6-astra' }, 'chef');
  t('choix enregistré', a.ok && a.changed);
  t('écrit dans model-routing.json', JSON.parse(fs.readFileSync(path.join(dir, 'model-routing.json'), 'utf8')).assignments['dev.rouge'].model === 'gpt-6-astra');
  t('aucun fichier temporaire laissé', !fs.readdirSync(dir).some(f => f.endsWith('.tmp')));
  const n0 = mr.view().historyTotal;
  t('même choix : pas de nouvelle ligne d’historique', !mr.setAssignment('dev.rouge', { provider: 'openai', model: 'gpt-6-astra' }).changed && mr.view().historyTotal === n0);
  mr.setAssignment('dev.rouge', null);
  const v = mr.view();
  t('valeur héritée retire le choix', !v.assignments['dev.rouge']);
  t('historique : ancien → nouveau, auteur, plus récent d’abord', v.history[0].from === 'openai:gpt-6-astra' && v.history[0].to === null && v.history[1].by === 'chef');
  for (let i = 0; i < HISTORY_MAX + 20; i++) mr.setAssignment('dev.livrer.git', i % 2 ? { provider: 'anthropic', model: 'claude-opus-5-5' } : null);
  t(`historique borné à ${HISTORY_MAX}`, mr.view().historyTotal === HISTORY_MAX);
  fs.writeFileSync(path.join(dir, 'model-routing.json'), '{cassé');
  t('fichier illisible : vue vide, pas d’exception', Object.keys(mr.view().assignments).length === 0);
}

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
