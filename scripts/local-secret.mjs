// scripts/local-secret.mjs — secret local de l'orchestrateur (phase 2, 0.47.0)
//
// `.orchestrateur-secret` (racine, gitignoré, distinct de `.token`) : 32 octets
// aléatoires créés au premier besoin. On n'en diffuse que des DÉRIVÉS (HMAC par
// usage) : le jeton de la passerelle aujourd'hui, les jetons d'étape du moteur
// de pipelines ensuite (plan §3.3). Le secret brut ne va jamais dans
// l'environnement d'un tour.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readOrCreateSecret(root) {
  const file = path.join(root, '.orchestrateur-secret');
  for (let i = 0; i < 3; i++) {
    try {
      const s = fs.readFileSync(file, 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(s)) return s;
    } catch { /* absent */ }
    try {
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    } catch { /* créé en même temps par un autre processus : on relit */ }
  }
  throw new Error('secret local illisible : .orchestrateur-secret');
}

/** Dérivé du secret pour un usage donné (ex. 'gateway'). */
export function derivedToken(root, purpose) {
  return crypto.createHmac('sha256', readOrCreateSecret(root)).update(`orchestrateur:${purpose}`).digest('hex');
}
