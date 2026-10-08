// Suite « Clés API » (0.43.0) — scripts/api-keys.mjs, sur un .env de TEST.
//   node scripts/_test_api_keys.mjs
//
// Demande utilisateur : « prevois dans la page Models, un endroit pour entrer
// les clefs de nvidia et de openrouter ». Exigences : enregistrer → état
// « configurée » ; l'API ne renvoie jamais la valeur ; Supprimer fonctionne.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiKeys, KEY_DEFS } from './api-keys.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };

const SECRET = 'sk-or-v1-' + 'a1b2c3d4'.repeat(8);
const NV = 'nvapi-' + 'Zz09'.repeat(12);
function sandbox(initial = '# commentaire gardé\nAUTRE=1\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-'));
  if (initial != null) fs.writeFileSync(path.join(dir, '.env'), initial);
  return dir;
}
const leaks = (obj, v) => JSON.stringify(obj).includes(v) || JSON.stringify(obj).includes(v.slice(0, 20));

console.log('\n── 1. Enregistrer, état, jamais la valeur');
{
  const dir = sandbox();
  const k = createApiKeys({ root: dir, statusFile: path.join(dir, 'status.json'), fetch: async () => ({ ok: true, status: 200 }) });
  t('au départ : absente', k.status('openrouter').state === 'absente' && !k.status('openrouter').configured);
  const r = k.set('openrouter', SECRET);
  t('enregistrer → « configurée », source .env, 4 derniers caractères', r.ok && r.key.state === 'configurée' && r.key.source === '.env' && r.key.last4 === SECRET.slice(-4));
  t('la réponse ne contient jamais la valeur', !leaks(r, SECRET) && !leaks(k.all(), SECRET));
  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  t('écrite dans .env, les autres lignes intactes', env.includes(`OPENROUTER_API_KEY=${SECRET}`) && env.includes('# commentaire gardé') && env.includes('AUTRE=1'));
  k.set('openrouter', SECRET.replace('a1', 'ff'));
  t('remplacer : une seule ligne pour la clé', (fs.readFileSync(path.join(dir, '.env'), 'utf8').match(/OPENROUTER_API_KEY=/g) || []).length === 1);
  t('aucun fichier temporaire laissé', !fs.readdirSync(dir).some(f => f.endsWith('.tmp')));
  for (const bad of ['', 'court', 'avec espace dans la clé 1234567890', 'sk-or-xxxxxxxxxxxxxxxx\nAUTRE=pirate', '"sk-or-xxxxxxxxxxxxxxxxxx"']) {
    const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    const b = k.set('openrouter', bad);
    t(`valeur refusée (${JSON.stringify(bad).slice(0, 30)}) sans toucher au .env`, b.status === 400 && fs.readFileSync(path.join(dir, '.env'), 'utf8') === before);
  }
  t('clé inconnue → 404', k.set('anthropic', SECRET).status === 404);
}

console.log('\n── 2. Tester : OK / KO, jamais la valeur dans l’état');
{
  const dir = sandbox();
  const calls = [];
  let answer = 200;
  const k = createApiKeys({ root: dir, statusFile: path.join(dir, 'status.json'), fetch: async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.authorization });
    if (url.endsWith('/v1/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'z-ai/glm-5.3-flash' }] }) };
    return { ok: answer < 300, status: answer };
  } });
  k.set('openrouter', SECRET);
  let r = await k.test('openrouter');
  t('acceptée (200) → valide, date de vérification', r.key.valid === true && r.key.state === 'configurée' && r.key.checkedAt);
  t('la clé ne part que vers openrouter.ai', calls.every(c => new URL(c.url).host === 'openrouter.ai'));
  answer = 401;
  r = await k.test('openrouter');
  t('refusée (401) → « invalide »', r.key.valid === false && r.key.state === 'invalide');
  t('le fichier d’état ne contient pas la valeur', !fs.readFileSync(path.join(dir, 'status.json'), 'utf8').includes(SECRET.slice(0, 20)));
  k.set('openrouter', SECRET.replace('a1', 'ee'));
  t('une nouvelle clé efface l’ancien verdict', k.status('openrouter').valid === null && k.status('openrouter').state === 'configurée');
  answer = 200;
  k.set('nvidia', NV);
  calls.length = 0;
  r = await k.test('nvidia');
  t('NVIDIA : complétion d’un jeton sur un model du catalogue, envoyée seulement à NVIDIA', r.key.valid === true && calls.every(c => new URL(c.url).host === 'integrate.api.nvidia.com') && calls.some(c => c.auth === `Bearer ${NV}`));
  const k2 = createApiKeys({ root: dir, statusFile: path.join(dir, 's2.json'), fetch: async () => { throw new Error('réseau coupé'); } });
  t('fournisseur injoignable → « non vérifiée », pas « invalide »', (await k2.test('openrouter')).key.valid === null);
  const k3 = createApiKeys({ root: dir, statusFile: path.join(dir, 's3.json'), offline: true });
  k3.set('openrouter', 'sk-or-test-0123456789-valid');
  t('mode hors ligne (instance de test) : convention « -valid »', (await k3.test('openrouter')).key.valid === true);
  t('rien à tester → 409', (await createApiKeys({ root: sandbox(null), statusFile: path.join(dir, 's4.json') }).test('nvidia')).status === 409);
}

console.log('\n── 3. Supprimer');
{
  const dir = sandbox();
  const k = createApiKeys({ root: dir, statusFile: path.join(dir, 'status.json') });
  k.set('openrouter', SECRET);
  const r = k.remove('openrouter');
  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  t('Supprimer → « absente », ligne retirée, le reste intact', r.ok && r.key.state === 'absente' && !env.includes('OPENROUTER_API_KEY') && env.includes('AUTRE=1'));
  t('supprimer une clé absente : sans effet', k.remove('openrouter').ok);
  const ke = createApiKeys({ root: sandbox(), statusFile: path.join(dir, 's.json'), env: { NVIDIA_API_KEY: NV } });
  t('clé venue de l’environnement : visible, non supprimable depuis la page (409)', ke.status('nvidia').source === 'environnement' && !ke.status('nvidia').deletable && ke.remove('nvidia').status === 409);
  t('les deux clés connues : NVIDIA et OpenRouter', Object.keys(KEY_DEFS).join(',') === 'nvidia,openrouter');
}

console.log('\n── 4. Jamais transmise aux processus qui n’en ont pas besoin');
{
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const dsp = fs.readFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), 'utf8');
  t('server.js retire OPENROUTER_API_KEY et NVIDIA_API_KEY de process.env au démarrage', /for \(const k of \['OPENROUTER_API_KEY', 'NVIDIA_API_KEY'\]\)[\s\S]{0,120}delete process\.env\[k\]/.test(srv));
  t('dispatch.mjs retire les deux clés de l’environnement de ses fils', /delete env\.NVIDIA_API_KEY;/.test(dsp) && /delete env\.OPENROUTER_API_KEY;/.test(dsp));
  t('un JSON illisible ne renvoie pas le début du corps (Node ≥ 20 le recopie)', !/corps illisible : \$\{err\.message\}/.test(srv));
  t('écritures de clé : même origine exigée', /app\.put\('\/api\/api-keys\/:name', sameOriginOnly/.test(srv) && /app\.delete\('\/api\/api-keys\/:name', sameOriginOnly/.test(srv));
  t('aucune journalisation de req.body dans les routes de clés', !/api-keys[\s\S]{0,600}console\.log\([^)]*req\.body/.test(srv));
}

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
