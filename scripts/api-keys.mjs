// ============================================================================
// scripts/api-keys.mjs — clés NVIDIA et OpenRouter (0.43.0)
// ============================================================================
//
// Demande utilisateur : « prevois dans la page Models, un endroit pour entrer
// les clefs de nvidia et de openrouter ».
//
// RÈGLES DE SÉCURITÉ (non négociables) :
//   - la VALEUR d'une clé ne sort jamais de ce module : ni dans une réponse
//     d'API, ni dans un log, ni dans le fichier d'état — au plus ses 4 derniers
//     caractères ;
//   - écriture uniquement dans <racine>/.env (gitignoré), en temp + rename, les
//     autres lignes du fichier restent intactes ;
//   - le test d'une clé l'envoie seulement à l'hôte de son fournisseur.
// Prise en compte à chaud : tout le monde relit .env à l'usage (catalogue,
// dispatch.mjs pour le failover NVIDIA).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

export const KEY_DEFS = {
  nvidia: {
    env: 'NVIDIA_API_KEY', label: 'NVIDIA', host: 'integrate.api.nvidia.com',
    usage: 'failover NVIDIA aujourd’hui ; outillage d’agent à venir',
  },
  openrouter: {
    env: 'OPENROUTER_API_KEY', label: 'OpenRouter', host: 'openrouter.ai',
    usage: 'models OpenRouter dans la page Models (étapes de jugement, puis outillage d’agent)',
  },
};

const NVIDIA_TEST_MODELS = ['z-ai/glm-5.3-flash', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'google/gemma-3-4b-it', 'moonshotai/kimi-k3'];

// Caractères admis : une clé n'a ni espace, ni guillemet, ni retour à la ligne
// (une valeur « x\nAUTRE=1 » injecterait une ligne dans .env).
const VALUE_RE = /^[A-Za-z0-9._~+\/=:-]{16,512}$/;

function parseEnv(raw) {
  return String(raw || '').split(/\r?\n/).map(line => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    return m ? { line, key: m[1], value: m[2].trim().replace(/^["']|["']$/g, '') } : { line };
  });
}

/**
 * @param {object} o
 * @param {string} o.root        racine (fichier <root>/.env)
 * @param {string} o.statusFile  état des vérifications (jamais de valeur)
 * @param {object} [o.env]       environnement du serveur au démarrage (lecture seule)
 * @param {Function} [o.fetch]   injectable pour les tests
 * @param {boolean} [o.offline]  instance de test : aucun appel réseau
 */
export function createApiKeys({ root, statusFile, env = {}, fetch: fetchImpl = globalThis.fetch, offline = false }) {
  const envFile = path.join(root, '.env');

  function readLines() {
    try { return parseEnv(fs.readFileSync(envFile, 'utf8')); } catch { return []; }
  }
  function writeLines(lines) {
    const text = lines.map(l => l.line).join('\n').replace(/\n*$/, '\n');
    const tmp = `${envFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, envFile);
  }
  /** Valeur courante (interne au module). .env d'abord, puis l'environnement du démarrage. */
  function valueOf(name) {
    const def = KEY_DEFS[name];
    const inFile = readLines().filter(l => l.key === def.env && l.value).pop();
    if (inFile) return { value: inFile.value, source: '.env' };
    const fromEnv = env[def.env] && String(env[def.env]).trim();
    if (fromEnv) return { value: fromEnv, source: 'environnement' };
    return null;
  }

  function readStatus() { try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return {}; } }
  function writeStatus(s) {
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      const tmp = `${statusFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, statusFile);
    } catch { /* l'état est un confort, pas une garantie */ }
  }

  /** État public d'une clé : JAMAIS la valeur, au plus ses 4 derniers caractères. */
  function status(name) {
    const def = KEY_DEFS[name];
    if (!def) return null;
    const v = valueOf(name);
    const check = readStatus()[name] || null;
    // Une vérification ne vaut que pour la clé vérifiée.
    const fresh = check && v && check.last4 === v.value.slice(-4) ? check : null;
    const state = !v ? 'absente' : fresh?.valid === false ? 'invalide' : 'configurée';
    return {
      name, label: def.label, env: def.env, usage: def.usage,
      state,
      configured: !!v,
      source: v?.source || null,
      last4: v ? v.value.slice(-4) : null,
      valid: fresh ? fresh.valid : null,
      checkedAt: fresh?.checkedAt || null,
      detail: fresh?.detail || null,
      deletable: v?.source === '.env',
    };
  }
  function all() { return Object.keys(KEY_DEFS).map(status); }

  function set(name, value) {
    const def = KEY_DEFS[name];
    if (!def) return { ok: false, status: 404, error: 'clé inconnue' };
    const v = String(value ?? '').trim();
    if (!VALUE_RE.test(v)) return { ok: false, status: 400, error: 'valeur refusée : 16 à 512 caractères, sans espace, guillemet ni retour à la ligne' };
    const lines = readLines().filter(l => l.key !== def.env);
    lines.push({ line: `${def.env}=${v}` });
    writeLines(lines);
    const s = readStatus(); delete s[name]; writeStatus(s);
    return { ok: true, status: 200, key: status(name) };
  }

  function remove(name) {
    const def = KEY_DEFS[name];
    if (!def) return { ok: false, status: 404, error: 'clé inconnue' };
    const lines = readLines();
    if (!lines.some(l => l.key === def.env)) {
      return valueOf(name)
        ? { ok: false, status: 409, error: `la clé vient de l’environnement du serveur, pas du .env : à retirer de ${def.env} puis redémarrer` }
        : { ok: true, status: 200, key: status(name) };
    }
    writeLines(lines.filter(l => l.key !== def.env));
    const s = readStatus(); delete s[name]; writeStatus(s);
    return { ok: true, status: 200, key: status(name) };
  }

  async function call(url, opts, timeoutMs = 15_000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetchImpl(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
  }

  /** Appel minimal authentifié chez le fournisseur ; seul OK/KO est gardé. */
  async function test(name) {
    const def = KEY_DEFS[name];
    if (!def) return { ok: false, status: 404, error: 'clé inconnue' };
    const v = valueOf(name);
    if (!v) return { ok: false, status: 409, error: 'aucune clé à tester' };
    let valid = null, detail = '';
    if (offline) {
      // Instance de non-régression : convention de test, aucun réseau.
      valid = /-valid$/.test(v.value);
      detail = valid ? 'test hors ligne : acceptée' : 'test hors ligne : refusée';
    } else {
      try {
        let r;
        if (name === 'openrouter') {
          r = await call('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${v.value}` } });
        } else {
          // NVIDIA n'a pas de route « qui suis-je » : une complétion d'un seul
          // jeton, sur un petit model réellement présent dans le catalogue public
          // (les models y disparaissent : 404/410 = model, pas clé → suivant).
          const ids = await call('https://integrate.api.nvidia.com/v1/models', { headers: { accept: 'application/json' } })
            .then(x => x.json()).then(j => new Set((j.data || []).map(m => m.id))).catch(() => new Set());
          const candidates = NVIDIA_TEST_MODELS.filter(m => !ids.size || ids.has(m));
          for (const model of candidates.length ? candidates : NVIDIA_TEST_MODELS) {
            r = await call('https://integrate.api.nvidia.com/v1/chat/completions', {
              method: 'POST',
              headers: { authorization: `Bearer ${v.value}`, 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
            }, 45_000);   // un model NVIDIA « froid » met parfois 20 à 30 s à répondre
            if (r.status !== 404 && r.status !== 410) break;
          }
        }
        if (r.status === 401 || r.status === 403) { valid = false; detail = `refusée par ${def.host} (HTTP ${r.status})`; }
        else if (r.ok) { valid = true; detail = `acceptée par ${def.host}`; }
        else { valid = null; detail = `réponse inattendue de ${def.host} (HTTP ${r.status}) : clé non jugée`; }
      } catch (e) {
        valid = null; detail = `${def.host} injoignable (${e.name === 'AbortError' ? 'délai dépassé' : e.message})`;
      }
    }
    const s = readStatus();
    s[name] = { valid, checkedAt: new Date().toISOString(), last4: v.value.slice(-4), detail };
    writeStatus(s);
    return { ok: true, status: 200, key: status(name) };
  }

  // `valueFor` : usage interne du serveur (essai de langue d'un model) ; la
  // valeur ne part jamais dans une réponse HTTP ni dans un log.
  return { status, all, set, remove, test, envFile, valueFor: (envName) => { const n = Object.keys(KEY_DEFS).find(k => KEY_DEFS[k].env === envName); return n ? valueOf(n)?.value || null : null; } };
}
