// ============================================================================
// scripts/pipeline-engine.mjs — moteur de pipelines, phase 3 (0.48.0)
// ============================================================================
//
// Demande utilisateur (2026-10-09) : « est-ce que l'on utilise les pipeline
// specifies plutot ? Sinon, il faut faire en sorte que ces pipelines soient
// obligatoirement utlises. » Plan : docs/PLAN-pipeline-enforcement.md (§2, §3).
//
// Une EXÉCUTION (run) = un pipeline appliqué à une demande sur un projet.
//   - Une ÉTAPE = un tour séparé (claude -p ou codex), lancé sur le model de SA
//     case de la page Models (variante, puis étape ; principal + second en mode
//     double). Case vide = défaut du projet, AVEC un avertissement visible.
//   - Passation par FICHIERS : <projet>/.orchestrateur/runs/<run>/ (demande.md,
//     comprehension.md, recherche.md, reponse.md, revue.json…), jamais versionné.
//   - Critères de sortie VÉRIFIÉS PAR LE CODE (diff, commande de test, artefact),
//     jamais sur la parole du model. Un essai refusé est relancé avec la raison,
//     puis l'exécution se met en PAUSE (question à l'utilisateur).
//   - Chaque étape tourne avec un JETON D'ÉTAPE signé (HMAC du secret local) :
//     dispatch.mjs refuse une étape sans jeton valide, ou avec un autre model.
//   - Model indisponible (règle « aucun fallback ») → PAUSE, jamais de repli.
//   - Toute limite atteinte → notification/pipeline_limit dans le log, question
//     dans le dashboard (état input), notification au chef. Jamais en silence.
//
// Côté musicien, une exécution est UN tour : un user_prompt (avec `pipeline`),
// des événements system/pipeline_* (frise), puis un seul result (ou une pause).
// Les tours d'étape ont leurs propres logs : logs/runs/<run>/<clé>.jsonl.
//
// En service en phase 3 : Discussion et Développement LÉGER, sur les projets
// listés dans model-routing.json → enforcement (pipelineLab d'abord).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { derivedToken } from './local-secret.mjs';
import { readBranchLog } from './dual-run.mjs';

export const RUN_RE = /^p-\d{8}T\d{6}-[a-z0-9]{4,8}$/;
export const STEP_KEY_RE = /^\d{2}-[a-z0-9-]{1,40}$/;
export const SESSION_GROUP_RE = /^[a-z0-9-]{1,40}$/;

// Limites (décision n° 5, plan §2.5). ORCH_PIPE_* pour les tests.
export const LIMITS = {
  criteriaAttempts: 2,     // essais d'une étape dont le critère échoue
  greenAttempts: 3,        // essais de 4b pour un même test
  reviewRounds: 2,         // tours de revue → correction
  runMs: 90 * 60_000,      // durée totale d'une exécution
};
const PROGRESS_MS = Number(process.env.ORCH_PIPE_PROGRESS_MS) > 0 ? Number(process.env.ORCH_PIPE_PROGRESS_MS) : 30_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

/** Pipelines en service en phase 3 (les autres restent hors périmètre). */
export const ENGINE_PIPELINES = ['discussion', 'dev'];

// ---------------------------------------------------------------------------
// Mise en service (model-routing.json → enforcement), relue à chaque dispatch
// ---------------------------------------------------------------------------
export function readEnforcement(root) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')); } catch { /* absent */ }
  const e = j?.enforcement && typeof j.enforcement === 'object' ? j.enforcement : {};
  const projects = Array.isArray(e.projects) ? e.projects.filter(p => typeof p === 'string') : [];
  const pipelines = (Array.isArray(e.pipelines) ? e.pipelines : ENGINE_PIPELINES).filter(p => ENGINE_PIPELINES.includes(p));
  return { projects, pipelines, since: e.since || null, by: e.by || null };
}
export function isEnforced(enf, project) {
  return enf.projects.includes(project) || enf.projects.includes('*');
}

/** Écriture atomique de la mise en service (CLI pipeline-enforce.mjs, route serveur). */
export function writeEnforcement(root, { projects, pipelines, by }) {
  const file = path.join(root, 'model-routing.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* neuf */ }
  if (!j || typeof j !== 'object') j = {};
  if (!j.version) j.version = 2;
  j.assignments = j.assignments || {};
  j.history = Array.isArray(j.history) ? j.history : [];
  const at = new Date().toISOString();
  const before = j.enforcement || null;
  j.enforcement = { projects: [...new Set(projects)], pipelines: pipelines.filter(p => ENGINE_PIPELINES.includes(p)), since: at, by };
  j.history.push({ at, task: 'enforcement', from: before ? `${(before.projects || []).join(',')} / ${(before.pipelines || []).join(',')}` : null, to: `${j.enforcement.projects.join(',') || '—'} / ${j.enforcement.pipelines.join(',')}`, by });
  if (j.history.length > 500) j.history = j.history.slice(-500);
  j.updatedAt = at;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return j.enforcement;
}

// ---------------------------------------------------------------------------
// Jeton d'étape (plan §3.3)
// ---------------------------------------------------------------------------
function b64u(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64u(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }

export function signStepToken(root, payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', derivedToken(root, 'pipeline-step')).update(body).digest('hex');
  return `v1.${body}.${mac}`;
}

/** Renvoie {ok, payload} ou {ok:false, why}. Comparaison à temps constant. */
export function verifyStepToken(root, token, now = Date.now()) {
  const m = /^v1\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(String(token || ''));
  if (!m) return { ok: false, why: 'jeton d’étape absent ou illisible' };
  const want = crypto.createHmac('sha256', derivedToken(root, 'pipeline-step')).update(m[1]).digest();
  const got = Buffer.from(m[2], 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, why: 'jeton d’étape invalide (signature)' };
  let p;
  try { p = JSON.parse(unb64u(m[1])); } catch { return { ok: false, why: 'jeton d’étape illisible' }; }
  if (!Number.isFinite(p.exp) || p.exp < now) return { ok: false, why: 'jeton d’étape expiré' };
  return { ok: true, payload: p };
}

// ---------------------------------------------------------------------------
// Cases et models
// ---------------------------------------------------------------------------
const PROVIDER_OF = { anthropic: 'claude', openai: 'codex', nvidia: 'nvidia', openrouter: 'openrouter' };

/**
 * Model d'une étape : la case la plus précise affectée (variante, puis étape).
 * Case vide → défaut du projet (`source: 'project-default'`), avertissement.
 * Une affectation « outil local » n'est pas un model de tour : ignorée.
 */
export function resolveCase(assignments, chain) {
  for (const slot of chain) {
    const a = assignments?.[slot];
    if (!a?.model || !PROVIDER_OF[a.provider]) continue;
    const second = a.second?.model && PROVIDER_OF[a.second.provider]
      ? { model: a.second.model, provider: PROVIDER_OF[a.second.provider] } : null;
    return { slot, model: a.model, provider: PROVIDER_OF[a.provider], second, source: 'pipeline' };
  }
  return { slot: chain[0], model: null, provider: null, second: null, source: 'project-default' };
}

function readAssignments(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')).assignments || {}; } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Plans des pipelines en service
// ---------------------------------------------------------------------------
const STRIP = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Nature d'une demande de développement léger : bugfix, mécanique ou simple. */
export function devKind(text) {
  const t = STRIP(text);
  if (/\b(bug|corrig|fix|repar|erreur|plante|crash|regression|ne marche|ne fonctionne|casse)/.test(t)) return 'bugfix';
  if (/\b(renomm|remplac|rename|deplac|typo|coquille|faute d'orthographe|libelle|wording|reformat)/.test(t)) return 'mecanique';
  return 'simple';
}

/** Étapes d'une exécution, dans l'ordre. */
export function planSteps(pipeline, { mode = 'leger', kind = 'simple' } = {}) {
  if (pipeline === 'discussion') {
    return [
      { id: 'comprendre', title: '1 Comprendre la question', chain: ['discussion.comprendre'], group: 'discussion', artefact: 'comprehension.md', judge: true },
      { id: 'rechercher', title: '2 Rechercher', chain: ['discussion.rechercher'], group: 'discussion', artefact: 'recherche.md', judge: true },
      { id: 'repondre', title: '3 Répondre', chain: ['discussion.repondre'], group: 'discussion', artefact: 'reponse.md', judge: true, final: true },
    ];
  }
  if (pipeline === 'dev') {
    const steps = [];
    if (kind !== 'mecanique') {
      const v = kind === 'bugfix' ? 'bugfix' : 'comportement';
      steps.push({ id: 'rouge', title: `4a Rouge${kind === 'bugfix' ? ' (reproduire le bug)' : ''}`, chain: [`dev.rouge.${v}`, 'dev.rouge'], group: 'tests', artefact: 'rouge.md' });
    }
    const vv = kind === 'mecanique' ? 'mecanique' : 'simple';
    steps.push({ id: 'vert', title: '4b Vert', chain: [`dev.vert.${vv}`, 'dev.vert'], group: 'code', artefact: 'vert.md' });
    steps.push({ id: 'revue', title: '5 Revue', chain: ['dev.revue.code', 'dev.revue'], group: 'revue', artefact: 'revue.json', judge: true });
    steps.push({ id: 'livrer', title: '6 Livrer (+ 7 Documenter)', chain: ['dev.livrer.git', 'dev.livrer'], group: 'code', artefact: 'livraison.md', final: true });
    return steps;
  }
  throw new Error(`pipeline « ${pipeline} » pas encore en service`);
}

// ---------------------------------------------------------------------------
// Git, instantanés, globs
// ---------------------------------------------------------------------------
function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, ''), err: (r.stderr || '').trim() };
}
const RUNS_PREFIX = '.orchestrateur/runs/';

/** Empreinte de chaque fichier suivi ou non ignoré (hors artefacts d'exécution). */
export function snapshot(cwd) {
  const files = git(cwd, ['ls-files', '-c', '-o', '--exclude-standard']).out.split('\n').filter(f => f && !f.startsWith(RUNS_PREFIX));
  const uniq = [...new Set(files)];
  const map = new Map();
  const present = uniq.filter(f => fs.existsSync(path.join(cwd, f)));
  if (present.length) {
    const r = spawnSync('git', ['-C', cwd, 'hash-object', '-w', '--stdin-paths'], { input: present.join('\n') + '\n', encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const hashes = (r.stdout || '').split('\n');
    present.forEach((f, i) => map.set(f, hashes[i] || ''));
  }
  return map;
}
export function changedFiles(a, b) {
  const out = [];
  for (const [f, h] of b) if (a.get(f) !== h) out.push(f);
  for (const f of a.keys()) if (!b.has(f)) out.push(f);
  return [...new Set(out)].sort();
}
export function globToRe(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export function isTestFile(f, globs) { return (globs || []).some(g => globToRe(g).test(f)); }

function runCommand(cwd, command, env) {
  if (!command) return { ok: true, code: 0, out: '' };
  const t0 = Date.now();
  // La commande vient du fichier VERSIONNÉ du projet (.orchestrateur/pipeline.json),
  // jamais d'une entrée réseau : un shell est nécessaire (« npm test »).
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: TEST_TIMEOUT_MS, env, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, code: r.status, out: out.slice(-12_000), ms: Date.now() - t0, timedOut: r.error?.code === 'ETIMEDOUT' };
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/** Version courante lue dans un fichier de version (package.json ou gradle). */
export function readVersion(file, text) {
  if (/\.json$/i.test(file)) { try { return JSON.parse(text).version || null; } catch { return null; } }
  const m = /versionName\s*=?\s*["']([^"']+)["']/.exec(text) || /^version\s*=\s*["']?([0-9][^"'\s]*)/m.exec(text);
  return m ? m[1] : null;
}

/** Chemins cités entre accents graves qui n'existent pas. */
export function missingCitedPaths(text, cwd) {
  const out = [];
  for (const m of String(text).matchAll(/`([^`\n]{2,200})`/g)) {
    const p = m[1].trim().replace(/:\d+(-\d+)?$/, '');
    const looksPath = /^[\w.\-@]+([\\/][\w.\-@ ]+)+$/.test(p) || /^[\w.\-]+\.(m?js|cjs|ts|tsx|jsx|json|md|kt|kts|py|java|css|html|ya?ml|toml|txt|ps1|sh|gradle)$/i.test(p) || /^[A-Za-z]:[\\/]/.test(p);
    if (!looksPath || /^https?:/i.test(p) || /[*?]/.test(p)) continue;
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    if (!fs.existsSync(abs)) out.push(p);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Identifiants, événements, notification
// ---------------------------------------------------------------------------
export function newRunId(now = new Date()) {
  const s = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `p-${s}-${crypto.randomBytes(3).toString('hex')}`;
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')} s` : ''}`;
}
function postNotify(root, project, text, source) {
  return new Promise((resolve) => {
    let token = '';
    try { token = fs.readFileSync(path.join(root, '.token'), 'utf8').trim(); } catch {}
    const port = Number(process.env.ORCH_PORT) || 7777;
    const body = Buffer.from(JSON.stringify({ project, text, source }));
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/notify', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Orchestrator-Token': token } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { try { req.destroy(); } catch {} resolve(null); });
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Consignes d'étape (le contrat du musicien) — le code vérifie, pas le prompt
// ---------------------------------------------------------------------------
function stepPrompt(ctx, step, extra) {
  const { run, pipeline, artDir, cfg } = ctx;
  const art = (f) => path.join(artDir, f).replace(/\\/g, '/');
  const L = [];
  L.push(`[PIPELINE ${pipeline === 'dev' ? 'Développement léger' : 'Discussion'} — exécution ${run} — étape ${step.title}]`);
  L.push(`PIPELINE_STEP=${step.id}`);
  L.push(`ARTEFACT=${art(step.artefact)}`);
  L.push(`DOSSIER_ARTEFACTS=${artDir.replace(/\\/g, '/')}`);
  L.push('');
  L.push(`Demande d'origine : ${art('demande.md')} (lis-la d'abord). Les artefacts des étapes précédentes sont dans le même dossier : lis ceux qui existent.`);
  L.push('');
  const T = cfg.testCommand ? `« ${cfg.testCommand} »` : 'la suite de tests du projet';
  switch (step.id) {
    case 'comprendre':
      L.push('Ton rôle : COMPRENDRE la question. Reformule ce qui est réellement demandé, les interprétations possibles, et repère les fichiers utiles du projet.');
      L.push(`Écris ${art('comprehension.md')}. Cite les fichiers du projet entre accents graves (\`chemin/relatif\`) : chaque chemin cité doit exister.`);
      L.push('Ne modifie AUCUN fichier du projet (lecture seule).');
      break;
    case 'rechercher':
      L.push('Ton rôle : RECHERCHER, en lecture seule, ce qu’il faut pour répondre (code, docs, web si utile).');
      L.push(`Écris ${art('recherche.md')} : les faits trouvés, avec leur source (fichier, ligne, URL).`);
      L.push('Ne modifie AUCUN fichier du projet.');
      break;
    case 'repondre':
      L.push('Ton rôle : RÉPONDRE à l’utilisateur, à partir de comprehension.md et recherche.md : une réponse directe, argumentée, avec une recommandation.');
      L.push(`Écris la réponse complète, en Markdown, dans ${art('reponse.md')} : c'est elle que l'utilisateur lira.`);
      L.push('Ne modifie AUCUN fichier du projet. Si une modification est souhaitable, propose-la : elle deviendra une tâche si l’utilisateur la confirme.');
      break;
    case 'rouge':
      L.push(`Ton rôle : étape 4a ROUGE du TDD. Écris UN test qui décrit le comportement attendu${ctx.kind === 'bugfix' ? ' — ici : un test qui REPRODUIT le bug signalé' : ''}, et rien d'autre.`);
      L.push(`Tu ne modifies QUE des fichiers de test (motifs : ${(cfg.testGlobs || []).join(', ')}). Aucun code de production.`);
      L.push(`Après ton tour, l'orchestrateur lance ${T} : elle doit ÉCHOUER, à cause de ton test.`);
      L.push(`Écris ${art('rouge.md')} : le nom du test, le fichier, et pourquoi il échoue aujourd'hui.`);
      break;
    case 'vert':
      if (ctx.reviewItems?.length) {
        L.push('Ton rôle : CORRIGER les problèmes relevés par la revue (revue.json), sans toucher aux tests existants (tu peux en AJOUTER).');
        L.push(`Problèmes à corriger :\n${ctx.reviewItems.map(i => `- ${i}`).join('\n')}`);
      } else if (ctx.kind === 'mecanique') {
        L.push('Ton rôle : étape 4b — faire la modification MÉCANIQUE demandée (renommage, remplacement…), sans changer le comportement. Ne modifie aucun test existant.');
      } else {
        L.push('Ton rôle : étape 4b VERT du TDD. Écris le code MINIMAL qui fait passer le test écrit à l’étape 4a (voir rouge.md) ET tous les autres.');
        L.push('Interdit : modifier les fichiers de test (l’orchestrateur compare leur empreinte : toute modification est refusée).');
      }
      L.push(`Après ton tour, l'orchestrateur lance ${T} : elle doit PASSER.`);
      L.push(`Écris ${art('vert.md')} : ce que tu as changé et pourquoi. Ne commite pas (l'étape Livrer le fera).`);
      break;
    case 'revue':
      L.push('Ton rôle : REVUE du changement en cours (défauts, sécurité, cohérence, tests suffisants). Le diff complet est dans le fichier :');
      L.push(`  ${art('diff.patch')}`);
      L.push(`Écris ${art('revue.json')}, et UNIQUEMENT ce JSON : {"verdict": "ok" | "problèmes", "items": ["problème 1", …]}. « problèmes » seulement pour un défaut réel, à corriger maintenant.`);
      L.push('Ne modifie AUCUN fichier du projet.');
      break;
    case 'livrer': {
      L.push('Ton rôle : LIVRER et DOCUMENTER (règles de la flotte), dans cet ordre :');
      L.push(`1. incrémente la version (patch pour une correction, minor pour une fonctionnalité) dans : ${(cfg.versionFiles || []).join(', ') || '(fichier de version du projet)'} ;`);
      L.push(`2. ajoute l'entrée « ## [X.Y.Z] - AAAA-MM-JJ » correspondante dans ${cfg.changelog || 'CHANGELOG.md'} ;`);
      if (cfg.requirements) L.push(`3. ajoute la ligne de la demande dans ${cfg.requirements} (date, demande verbatim, test associé, version) ;`);
      L.push(`${cfg.requirements ? 4 : 3}. un SEUL commit avec tout le changement (git add -A puis git commit) — l'arbre doit être propre ensuite ;`);
      L.push('Pas de git push (il reste soumis à autorisation). Pas de nouvelle modification de code ni de test.');
      L.push(`Écris ${art('livraison.md')} : version, commit, ce qui a été livré.`);
      L.push(`L'orchestrateur vérifie ensuite : commit créé, arbre propre, version incrémentée, entrée CHANGELOG${cfg.requirements ? ', ligne d’exigence' : ''}, ${T} vert${cfg.buildCommand ? `, build (« ${cfg.buildCommand} »)` : ''}.`);
      break;
    }
  }
  if (extra?.retryWhy) L.push(`\n⚠ L'essai précédent de cette étape a été REFUSÉ par l'orchestrateur : ${extra.retryWhy}\nCorrige précisément ce point.`);
  L.push('\nRègles de l’étape : ne lance aucun dispatch (dispatch.mjs), ne pousse rien (git push interdit), ne commite pas sauf à l’étape Livrer. Termine par un résumé court de ce que tu as fait.');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Critères de sortie (plan §2.4)
// ---------------------------------------------------------------------------
function readArtefact(ctx, f) { try { return fs.readFileSync(path.join(ctx.artDir, f), 'utf8'); } catch { return null; } }

function checkCriteria(ctx, step, before, after) {
  const { cwd, cfg } = ctx;
  const changed = changedFiles(before, after);
  const art = readArtefact(ctx, step.artefact);
  const need = (cond, why) => (cond ? null : why);
  const artOk = art != null && art.trim().length >= 20;
  if (step.judge) {
    const why = need(artOk, `artefact ${step.artefact} absent ou vide`) ||
      need(!changed.length, `étape en lecture seule, mais des fichiers du projet ont changé : ${changed.slice(0, 8).join(', ')}`);
    if (why) return { ok: false, why, changed };
    if (step.id === 'comprendre') {
      const missing = missingCitedPaths(art, cwd);
      if (missing.length) return { ok: false, why: `chemins cités inexistants : ${missing.slice(0, 6).join(', ')}`, changed };
    }
    if (step.id === 'revue') {
      let j;
      try { j = JSON.parse(art.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return { ok: false, why: 'revue.json n’est pas un JSON valide', changed }; }
      const verdict = STRIP(j?.verdict || '');
      if (!['ok', 'problemes'].includes(verdict) || !Array.isArray(j.items)) return { ok: false, why: 'revue.json : il faut {"verdict": "ok"|"problèmes", "items": [...]}', changed };
      return { ok: true, changed, review: { verdict, items: j.items.map(x => String(typeof x === 'string' ? x : x?.text || JSON.stringify(x)).slice(0, 400)).slice(0, 15) } };
    }
    return { ok: true, changed };
  }
  if (step.id === 'rouge') {
    if (!changed.length) return { ok: false, why: 'aucun test ajouté ni modifié', changed };
    const notTests = changed.filter(f => !isTestFile(f, cfg.testGlobs));
    if (notTests.length) return { ok: false, why: `l’étape Rouge ne touche que des tests ; modifiés hors tests : ${notTests.slice(0, 8).join(', ')}`, changed };
    const t = runCommand(cwd, cfg.testCommand, ctx.testEnv);
    if (t.ok) return { ok: false, why: `la suite passe encore : le nouveau test n’échoue pas (${cfg.testCommand})`, changed, test: t };
    const names = changed.map(f => path.basename(f).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, ''));
    const titles = [];
    for (const f of changed) {
      let s = ''; try { s = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch {}
      for (const m of s.matchAll(/\b(?:test|it|describe)\s*\(\s*(['"`])(.{3,120}?)\1/g)) titles.push(m[2]);
    }
    const cited = [...names, ...titles].some(n => n && t.out.includes(n));
    if (!cited) return { ok: false, why: 'la suite échoue, mais l’échec ne cite pas le test ajouté (cause sans rapport ?)', changed, test: t };
    return { ok: true, changed, test: t };
  }
  if (step.id === 'vert') {
    if (!changed.length) return { ok: false, why: 'aucune modification', changed };
    const tests = ctx.testPrint;  // empreinte des tests à protéger
    const touched = [...tests.keys()].filter(f => after.get(f) !== tests.get(f));
    if (touched.length) return { ok: false, why: `fichiers de test modifiés (interdit à cette étape) : ${touched.slice(0, 8).join(', ')}`, changed };
    const t = runCommand(cwd, cfg.testCommand, ctx.testEnv);
    if (!t.ok) return { ok: false, why: `la suite échoue encore (${cfg.testCommand}, code ${t.code}) :\n${t.out.slice(-1500)}`, changed, test: t };
    return { ok: true, changed, test: t };
  }
  if (step.id === 'livrer') {
    const head = git(cwd, ['rev-parse', 'HEAD']).out;
    if (!head || head === ctx.base) return { ok: false, why: 'aucun commit créé', changed };
    const dirty = git(cwd, ['status', '--porcelain']).out.split('\n').filter(l => l && !l.slice(3).startsWith(RUNS_PREFIX));
    if (dirty.length) return { ok: false, why: `arbre non propre après le commit : ${dirty.slice(0, 6).join(' ; ')}`, changed };
    const diffNames = git(cwd, ['diff', '--name-only', `${ctx.base}..HEAD`]).out.split('\n').filter(Boolean);
    let version = null;
    for (const vf of cfg.versionFiles || []) {
      if (!diffNames.includes(vf)) return { ok: false, why: `version non incrémentée : ${vf} inchangé`, changed };
      let txt = ''; try { txt = fs.readFileSync(path.join(cwd, vf), 'utf8'); } catch {}
      const prev = git(cwd, ['show', `${ctx.base}:${vf}`]).out;
      const v = readVersion(vf, txt), pv = readVersion(vf, prev);
      if (v && pv && v === pv) return { ok: false, why: `version inchangée dans ${vf} (${v})`, changed };
      version = version || v;
    }
    const cl = cfg.changelog || 'CHANGELOG.md';
    if (fs.existsSync(path.join(cwd, cl)) || (cfg.versionFiles || []).length) {
      if (!diffNames.includes(cl)) return { ok: false, why: `${cl} sans nouvelle entrée`, changed };
      if (version) {
        let txt = ''; try { txt = fs.readFileSync(path.join(cwd, cl), 'utf8'); } catch {}
        if (!txt.includes(`## [${version}]`)) return { ok: false, why: `${cl} : pas d’entrée « ## [${version}] »`, changed };
      }
    }
    if (cfg.requirements && !diffNames.includes(cfg.requirements)) return { ok: false, why: `${cfg.requirements} : pas de ligne pour cette demande`, changed };
    const t = runCommand(cwd, cfg.testCommand, ctx.testEnv);
    if (!t.ok) return { ok: false, why: `la suite échoue après la livraison (${cfg.testCommand}) :\n${t.out.slice(-1500)}`, changed, test: t };
    if (cfg.buildCommand) {
      const b = runCommand(cwd, cfg.buildCommand, ctx.testEnv);
      if (!b.ok) return { ok: false, why: `le build échoue (${cfg.buildCommand}) :\n${b.out.slice(-1500)}`, changed };
    }
    return { ok: true, changed, commit: head, version };
  }
  return { ok: artOk, why: artOk ? '' : `artefact ${step.artefact} absent`, changed };
}

// ---------------------------------------------------------------------------
// L'exécution
// ---------------------------------------------------------------------------
/**
 * Lance (ou reprend) une exécution. Renvoie le code de sortie du processus :
 * 0 terminée, 2 pause (question à l'utilisateur), 64/65 refus avant écriture.
 */
export async function runPipeline(o) {
  const { root, logsDir, project, projectName, prompt, dispatchScript, callbackProject, sourceProject, obsId, classification } = o;
  const say = (m) => console.log(`[pipeline] ${m}`);
  const cwd = project.path;
  const projectLog = path.join(logsDir, `${projectName}.jsonl`);
  const pidPath = path.join(logsDir, `${projectName}.pid`);
  const writeEvent = (ev) => { try { fs.appendFileSync(projectLog, JSON.stringify({ ...ev, timestamp: new Date().toISOString() }) + '\n'); } catch {} };
  const limits = {
    criteriaAttempts: Number(process.env.ORCH_PIPE_CRITERIA_ATTEMPTS) || LIMITS.criteriaAttempts,
    greenAttempts: Number(process.env.ORCH_PIPE_GREEN_ATTEMPTS) || LIMITS.greenAttempts,
    reviewRounds: Number.isFinite(Number(process.env.ORCH_PIPE_REVIEW_ROUNDS)) && process.env.ORCH_PIPE_REVIEW_ROUNDS !== undefined ? Number(process.env.ORCH_PIPE_REVIEW_ROUNDS) : LIMITS.reviewRounds,
    runMs: Number(process.env.ORCH_PIPE_RUN_MS) || LIMITS.runMs,
  };

  // ── Reprise d'une exécution en pause, ou exécution neuve ─────────────────
  let state;
  if (o.resumeRun) {
    if (!RUN_RE.test(o.resumeRun)) { console.error(`[pipeline] exécution invalide : ${o.resumeRun}`); return 64; }
    state = readJson(path.join(logsDir, 'runs', o.resumeRun, 'run.json'));
    if (!state || state.project !== projectName) { console.error(`[pipeline] exécution ${o.resumeRun} introuvable pour ${projectName}`); return 64; }
    if (state.status !== 'paused') { console.error(`[pipeline] exécution ${o.resumeRun} : statut « ${state.status} », seule une exécution en pause se reprend`); return 65; }
  }
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']).out !== 'true') {
    console.error(`[pipeline] refusé : ${cwd} n'est pas un dépôt git (les critères de sortie s'appuient sur git).`); return 64;
  }
  const cfg = readJson(path.join(cwd, '.orchestrateur', 'pipeline.json')) || {};
  const pipeline = state?.pipeline || o.pipeline;
  if (!ENGINE_PIPELINES.includes(pipeline)) { console.error(`[pipeline] « ${pipeline} » n'est pas en service (phase 3 : ${ENGINE_PIPELINES.join(', ')}).`); return 64; }
  if (pipeline === 'dev' && !cfg.testCommand) {
    console.error(`[pipeline] refusé : Développement exige .orchestrateur/pipeline.json avec testCommand dans ${cwd} (critères de sortie vérifiés par le code).`); return 64;
  }
  const base = state?.base || git(cwd, ['rev-parse', 'HEAD']).out;
  if (!base) { console.error('[pipeline] refusé : dépôt sans commit.'); return 65; }
  if (!state && pipeline === 'dev') {
    const dirty = git(cwd, ['status', '--porcelain']).out.split('\n').filter(l => l && !l.slice(3).startsWith(RUNS_PREFIX));
    if (dirty.length) { console.error(`[pipeline] refusé : modifications non commitées (${dirty.length} fichier(s)) — l'étape Livrer doit produire UN commit propre. Commite ou range d'abord.`); return 65; }
  }

  // Artefacts jamais versionnés, même si le projet ne les ignore pas.
  try {
    const gitDir = git(cwd, ['rev-parse', '--git-dir']).out;
    const excl = path.join(path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir), 'info', 'exclude');
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(RUNS_PREFIX)) { fs.mkdirSync(path.dirname(excl), { recursive: true }); fs.appendFileSync(excl, `${cur && !cur.endsWith('\n') ? '\n' : ''}${RUNS_PREFIX}\n`); }
  } catch { /* le critère « fichiers changés » ignore déjà ce dossier */ }

  // Exécution restée « running » dont le processus est mort (tour tué) : close
  // comme interrompue, pour qu'elle ne passe jamais pour une exécution en cours.
  try {
    const dir = path.join(logsDir, 'runs');
    for (const r of fs.readdirSync(dir).filter(x => RUN_RE.test(x))) {
      const f = path.join(dir, r, 'run.json');
      const s = readJson(f);
      if (!s || s.project !== projectName || s.status !== 'running' || r === state?.run) continue;
      let alive = false;
      try { process.kill(s.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) continue;
      s.status = 'interrupted'; s.endedAt = new Date().toISOString();
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2)); fs.renameSync(`${f}.tmp`, f);
      say(`exécution ${r} close comme interrompue (processus ${s.pid} mort)`);
    }
  } catch { /* aucun dossier d'exécutions */ }

  const run = state?.run || newRunId();
  const runDir = path.join(logsDir, 'runs', run);
  const artDir = path.join(cwd, '.orchestrateur', 'runs', run);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(artDir, { recursive: true });
  const mode = state?.mode || 'leger';
  const kind = state?.kind || (pipeline === 'dev' ? devKind(prompt) : null);
  const assignments = readAssignments(root);
  if (!state) {
    state = {
      run, project: projectName, pipeline, mode, kind, base, status: 'running',
      createdAt: new Date().toISOString(), request: prompt.slice(0, 20_000),
      plan: planSteps(pipeline, { mode, kind }).map(s => s.id), index: 0, reviewRounds: 0, steps: [],
      ...(classification ? { classification } : {}), ...(o.modeNote ? { modeNote: o.modeNote } : {}),
      callback: callbackProject || null, source: sourceProject || null,
    };
    fs.writeFileSync(path.join(artDir, 'demande.md'), `# Demande\n\n${prompt}\n`);
  }
  const saveState = () => {
    state.updatedAt = new Date().toISOString();
    const f = path.join(runDir, 'run.json');
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${f}.tmp`, f);
  };
  const resumed = state.status === 'paused';
  state.status = 'running';
  state.pid = process.pid;
  saveState();

  // Le musicien est occupé pendant toute l'exécution : le parent tient le .pid.
  try { fs.writeFileSync(pidPath, String(process.pid)); } catch {}
  const stepDefs = Object.fromEntries(planSteps(pipeline, { mode, kind }).map(s => [s.id, s]));
  const planned = state.plan.map(id => ({ id, title: stepDefs[id].title, slot: resolveCase(assignments, stepDefs[id].chain) }));
  writeEvent({
    type: 'user_prompt', text: o.promptForLog ?? prompt,
    pipeline: { run, pipeline, mode, kind, resumed: resumed || undefined, steps: planned.map(p => ({ id: p.id, title: p.title, slot: p.slot.slot, model: p.slot.model, provider: p.slot.provider, second: p.slot.second, source: p.slot.source })) },
    ...(sourceProject ? { source: sourceProject } : {}),
    ...(callbackProject ? { callback: callbackProject } : {}),
    ...(o.testLabel ? { test: { label: o.testLabel } } : {}),
  });
  writeEvent({ type: 'system', subtype: 'pipeline_start', pipeline: { run, pipeline, mode, kind, base },
    text: `${resumed ? 'reprise de l’exécution' : 'exécution'} ${run} : pipeline ${pipeline === 'dev' ? 'Développement léger' : 'Discussion'} — ${planned.map(p => p.title).join(' → ')}`,
    ...(o.modeNote ? { note: o.modeNote } : {}) });
  for (const p of planned) {
    if (p.slot.source === 'project-default') {
      writeEvent({ type: 'system', subtype: 'pipeline_warning', pipeline: { run, step: p.id, slot: p.slot.slot },
        text: `⚠ ${p.title} : aucune case affectée (${p.slot.slot}) — défaut du projet, failover compris` });
    }
  }
  say(`${resumed ? 'reprise' : 'exécution'} ${run} — ${pipeline}${kind ? ` (${kind})` : ''} — ${planned.map(p => `${p.id}:${p.slot.model || 'défaut'}`).join(', ')}`);

  let current = null;
  const progress = setInterval(() => {
    writeEvent({ type: 'system', subtype: 'pipeline_progress', pipeline: { run, step: current?.id || null },
      text: current ? `étape ${current.title} en cours (${current.model || 'défaut du projet'}) depuis ${fmtDur(Date.now() - current.t0)}` : 'exécution en cours' });
  }, PROGRESS_MS);
  progress.unref?.();

  const childEnv = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'DISPATCH_SLOT', 'DISPATCH_TICKET', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_TEST_LABEL']) delete childEnv[k];
  if (obsId) childEnv.ORCH_OBS_ID = obsId;
  const testEnv = { ...childEnv };
  delete testEnv.ORCH_OBS_ID;
  const ctx = { run, pipeline, kind, cwd, cfg, artDir, base, testEnv, reviewItems: null, testPrint: null };
  const started = Date.parse(state.createdAt) || Date.now();
  const totals = { costUsd: 0, apiMs: 0, turns: 0 };

  const finish = async ({ code, result, isError = false, paused = false, question = null, limit = null }) => {
    clearInterval(progress);
    state.status = paused ? 'paused' : isError ? 'failed' : 'done';
    state.endedAt = new Date().toISOString();
    if (question) state.question = question;
    saveState();
    const summary = {
      type: 'system', subtype: 'pipeline_summary', pipeline: { run, pipeline, mode, kind, status: state.status },
      steps: state.steps.map(s => ({ id: s.id, key: s.key, title: s.title, slot: s.slot, model: s.model, served: s.served, source: s.source, status: s.status, why: s.why, durationMs: s.durationMs, costUsd: s.costUsd, attempt: s.attempt })),
      totalMs: Date.now() - started, costUsd: totals.costUsd || null,
      text: `exécution ${run} : ${state.status === 'done' ? 'terminée' : state.status === 'paused' ? 'en pause' : 'échec'} — ${state.steps.filter(s => s.status === 'ok').length} étape(s) validée(s)`,
    };
    writeEvent(summary);
    const text = paused ? `${result}\n\nNEEDS_USER_INPUT: ${question}` : result;
    if (paused) writeEvent({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] } });
    // Ni « fantôme » (0 tour / 0 ms d'API) ni « synthétique » : le chef doit
    // recevoir ce résultat et son réveil, comme pour un tour ordinaire.
    writeEvent({ type: 'result', subtype: isError ? 'error_pipeline' : 'success', is_error: isError,
      num_turns: Math.max(1, totals.turns), duration_ms: Date.now() - started, duration_api_ms: Math.max(1, totals.apiMs),
      stop_reason: 'end_turn', pipeline: { run, pipeline, status: state.status, ...(limit ? { limit } : {}) },
      ...(paused ? { pipeline_paused: true } : {}), result: text });
    try { fs.unlinkSync(pidPath); } catch {}
    if (callbackProject) {
      await postNotify(root, callbackProject, `[PIPELINE — ${projectName} — ${run}] ${paused ? `⏸ pause : ${question}` : isError ? `✕ ${result.slice(0, 1500)}` : result.slice(0, 8000)}`, paused && limit ? 'pipeline-limit' : 'pipeline');
    } else if (paused && limit) {
      await postNotify(root, 'chef', `[PIPELINE — ${projectName} — ${run}] ⏸ ${question}`, 'pipeline-limit');
    }
    say(`${summary.text}`);
    return code;
  };

  const pauseForLimit = async ({ limit, value, step, why, lastOutput }) => {
    const label = { criteria: `${value} essais refusés par le critère de sortie`, green: `${value} essais de 4b sans passer`, review: `${value} tours de revue`, duration: `durée maximale (${fmtDur(value)})` }[limit] || limit;
    const notice = `⏸ Limite atteinte — ${projectName} · ${pipeline === 'dev' ? 'Développement léger' : 'Discussion'} · ${step ? step.title : 'exécution'} : ${label}`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step?.id || null }, limit, value, why: why ? String(why).slice(0, 2000) : null,
      lastOutput: lastOutput ? String(lastOutput).slice(-2000) : null, text: notice });
    const question = `${notice}. ${why ? `Dernier refus : ${String(why).split('\n')[0].slice(0, 300)}. ` : ''}` +
      `Que faire : continuer (node scripts/dispatch.mjs ${projectName} --pipeline-resume ${run}), simplifier la demande, changer le model de l'étape dans la page Models, ou abandonner ?`;
    return finish({ code: 2, paused: true, limit, question, result: notice });
  };

  const pauseForModel = async (step, info, why) => {
    const notice = `⏸ Model indisponible — ${projectName} · ${step.title} : ${info.model} (${info.provider}) — aucun repli (règle utilisateur)`;
    writeEvent({ type: 'notification', subtype: 'pipeline_limit', pipeline: { run, step: step.id }, limit: 'model_unavailable', value: info.model, why: String(why).slice(0, 2000), text: notice });
    const question = `${notice}. Cause : ${String(why).split('\n')[0].slice(0, 300)}. Que faire : attendre puis continuer (node scripts/dispatch.mjs ${projectName} --pipeline-resume ${run}), choisir un autre model pour la case ${info.slot} dans la page Models puis continuer, ou abandonner ?`;
    return finish({ code: 2, paused: true, limit: 'model_unavailable', question, result: notice });
  };

  // ── Une étape : un tour, sur le model de sa case, jeton signé ────────────
  const runStep = async (step, attempt, extra) => {
    const info = resolveCase(readAssignments(root), step.chain);
    const n = String(state.steps.length + 1).padStart(2, '0');
    const key = `${n}-${step.id}`;
    const sessionGroup = `${step.group}-${(info.model || 'defaut').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`.replace(/-+$/, '');
    const token = signStepToken(root, { run, key, project: projectName, model: info.model, provider: info.provider, second: info.second, exp: Date.now() + 6 * 3600_000 });
    const args = [projectName, '--prompt-stdin', '--pipeline-step', `${run}:${key}`, '--pipeline-session', sessionGroup, '--no-queue-if-busy'];
    if (info.model) args.push('--model', info.model, '--provider', info.provider);
    if (info.model && info.second) args.push('--second-model', info.second.model, '--second-provider', info.second.provider, '--dual-mode', step.judge ? 'judge' : 'action');
    const text = stepPrompt(ctx, step, extra);
    const before = snapshot(cwd);
    current = { id: step.id, title: step.title, model: info.model, t0: Date.now() };
    writeEvent({ type: 'system', subtype: 'pipeline_step_start', pipeline: { run, step: step.id, key, slot: info.slot, attempt },
      model: info.model, provider: info.provider, second: info.second, modelSource: info.source,
      text: `étape ${step.title} — ${info.model ? `${info.provider}/${info.model}${info.second ? ` + second ${info.second.model}` : ''}` : 'défaut du projet ⚠'}${attempt > 1 ? ` — essai ${attempt}` : ''}` });
    // Mode double dans une étape d'action : les deux branches partent du dernier
    // commit — l'état courant y est figé par un commit de point d'étape, replié
    // (git reset --soft) avant Livrer pour qu'il ne reste qu'UN commit.
    if (info.second && !step.judge && git(cwd, ['status', '--porcelain']).out) {
      git(cwd, ['add', '-A']);
      git(cwd, ['-c', 'user.name=orchestrateur', '-c', 'user.email=orchestrateur@localhost', 'commit', '-q', '-m', `[pipeline ${run}] point avant ${step.id}`]);
      state.checkpoints = (state.checkpoints || 0) + 1; saveState();
    }
    const t0 = Date.now();
    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [dispatchScript, ...args], { cwd: root, env: { ...childEnv, ORCH_STEP_TOKEN: token }, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
      c.on('error', () => resolve(127));
      c.on('exit', (cc) => resolve(cc ?? 1));
      c.stdin.end(text);
    });
    const log = readBranchLog(path.join(runDir, `${key}.jsonl`));
    const after = snapshot(cwd);
    const rec = { id: step.id, key, title: step.title, slot: info.slot, model: info.model, provider: info.provider, second: info.second, source: info.source,
      served: log.served, attempt, durationMs: Date.now() - t0, costUsd: Number.isFinite(log.result?.total_cost_usd) ? log.result.total_cost_usd : null, exit: code };
    totals.turns += 1;
    totals.apiMs += Number(log.result?.duration_api_ms) || Number(log.result?.duration_ms) || 0;
    if (rec.costUsd) totals.costUsd += rec.costUsd;
    current = null;
    // Model indisponible : la règle « aucun fallback » a refusé, ou rien n'a tourné.
    if (log.refused || log.result?.subtype === 'error_model_unavailable') {
      rec.status = 'model_unavailable'; rec.why = String(log.refused?.reason || log.result?.result || 'model indisponible');
      return { rec, unavailable: true, info };
    }
    if (!log.result || log.result.is_error || code !== 0) {
      rec.status = 'failed'; rec.why = !log.result ? `aucun résultat (code ${code})` : String(log.result.result || log.result.subtype || 'échec').slice(0, 1500);
      return { rec, info, before, after };
    }
    const c = checkCriteria(ctx, step, before, after);
    rec.status = c.ok ? 'ok' : 'refused';
    rec.why = c.ok ? null : c.why;
    rec.changed = c.changed?.slice(0, 50);
    if (c.test) rec.test = { ok: c.test.ok, code: c.test.code, ms: c.test.ms };
    return { rec, crit: c, info, before, after, log };
  };

  const record = (r) => {
    state.steps.push(r.rec);
    saveState();
    const s = r.rec;
    writeEvent({ type: 'system', subtype: 'pipeline_step_done', pipeline: { run, step: s.id, key: s.key, slot: s.slot, attempt: s.attempt },
      model: s.model, served: s.served, provider: s.provider, modelSource: s.source, status: s.status, why: s.why ? String(s.why).slice(0, 2000) : undefined,
      durationMs: s.durationMs, costUsd: s.costUsd, changed: s.changed, test: s.test, log: `logs/runs/${run}/${s.key}.jsonl`,
      text: `étape ${s.title} : ${s.status === 'ok' ? '✓ critère vérifié' : s.status === 'refused' ? `✕ refusée — ${String(s.why).split('\n')[0].slice(0, 200)}` : s.status === 'model_unavailable' ? '⏸ model indisponible' : `✕ échec — ${String(s.why).split('\n')[0].slice(0, 200)}`}` });
  };

  // ── Préconditions de Développement : la suite doit être verte au départ ──
  if (pipeline === 'dev' && state.index === 0 && !resumed) {
    const t = runCommand(cwd, cfg.testCommand, testEnv);
    if (!t.ok) {
      writeEvent({ type: 'system', subtype: 'pipeline_precondition', pipeline: { run }, text: `la suite (${cfg.testCommand}) est déjà rouge avant l'étape 4a`, output: t.out.slice(-2000) });
      return finish({ code: 2, paused: true, limit: 'precondition',
        question: `La suite de tests de ${projectName} (${cfg.testCommand}) échoue AVANT toute modification : le TDD ne peut pas démarrer (4a doit partir d'une suite verte). Que faire : réparer d'abord la suite (nouvelle demande), ou abandonner ?`,
        result: `⏸ Précondition non remplie — ${projectName} : suite déjà rouge` });
    }
  }
  // Empreinte des tests protégés : à la reprise, celle de l'état actuel.
  const testsNow = () => new Map([...snapshot(cwd)].filter(([f]) => isTestFile(f, cfg.testGlobs)));
  if (pipeline === 'dev') ctx.testPrint = testsNow();
  if (state.reviewItems) ctx.reviewItems = state.reviewItems;

  // ── Boucle des étapes ─────────────────────────────────────────────────────
  while (state.index < state.plan.length) {
    if (Date.now() - started > limits.runMs) return pauseForLimit({ limit: 'duration', value: limits.runMs, step: stepDefs[state.plan[state.index]] });
    const step = stepDefs[state.plan[state.index]];
    // Un seul commit à la livraison : points d'étape du mode double, commits de
    // sa relecture… tout ce qui a été commité depuis le départ est replié.
    if (step.id === 'livrer' && git(cwd, ['rev-parse', 'HEAD']).out !== base) {
      git(cwd, ['reset', '--soft', base]);
      state.checkpoints = 0; saveState();
    }
    if (step.id === 'revue') {
      const tracked = git(cwd, ['diff', base]).out;
      const untracked = git(cwd, ['ls-files', '-o', '--exclude-standard']).out.split('\n').filter(f => f && !f.startsWith(RUNS_PREFIX));
      const extraTxt = untracked.map(f => { let s = ''; try { s = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch {} return `--- /dev/null\n+++ b/${f}\n${s.split('\n').map(l => `+${l}`).join('\n')}`; }).join('\n');
      fs.writeFileSync(path.join(artDir, 'diff.patch'), `${tracked}\n${extraTxt}\n`);
      try { fs.unlinkSync(path.join(artDir, 'revue.json')); } catch {}
    }
    const maxAttempts = step.id === 'vert' ? limits.greenAttempts : limits.criteriaAttempts;
    let attempt = 0, last = null, retryWhy = null;
    for (;;) {
      attempt++;
      if (step.id !== 'revue') { try { fs.unlinkSync(path.join(artDir, step.artefact)); } catch {} }
      const r = await runStep(step, attempt, { retryWhy });
      record(r);
      if (r.unavailable) return pauseForModel(step, r.info, r.rec.why);
      last = r;
      if (r.rec.status === 'ok') break;
      // Un essai refusé n'est pas gardé : retour à l'état d'avant l'essai.
      if (!step.judge && r.before && r.after) restoreFiles(cwd, r.before, r.after, step.id === 'livrer' ? base : null);
      if (step.judge && r.before && r.after) restoreFiles(cwd, r.before, r.after, null);
      retryWhy = r.rec.why;
      if (attempt >= maxAttempts) {
        return pauseForLimit({ limit: step.id === 'vert' ? 'green' : 'criteria', value: attempt, step, why: r.rec.why, lastOutput: r.crit?.test?.out });
      }
    }
    if (step.id === 'rouge') ctx.testPrint = testsNow();
    if (step.id === 'vert' && ctx.reviewItems) { ctx.reviewItems = null; state.reviewItems = null; }
    if (step.id === 'revue' && last.crit?.review?.verdict === 'problemes' && last.crit.review.items.length) {
      if (state.reviewRounds >= limits.reviewRounds) {
        return pauseForLimit({ limit: 'review', value: state.reviewRounds, step, why: `la revue relève encore : ${last.crit.review.items.slice(0, 5).join(' ; ')}` });
      }
      state.reviewRounds++;
      ctx.reviewItems = state.reviewItems = last.crit.review.items;
      ctx.testPrint = testsNow();   // tests existants protégés ; en ajouter reste permis
      state.plan.splice(state.index + 1, 0, 'vert', 'revue');
      writeEvent({ type: 'system', subtype: 'pipeline_loop', pipeline: { run, from: 'revue', to: 'vert', round: state.reviewRounds },
        text: `revue : ${last.crit.review.items.length} problème(s) → retour à 4b (tour de revue ${state.reviewRounds}/${limits.reviewRounds})` });
    }
    state.index++;
    saveState();
  }

  // ── Fin : la réponse (Discussion) ou la livraison (Développement) ────────
  let result;
  if (pipeline === 'discussion') {
    result = (readArtefact(ctx, 'reponse.md') || '').trim() || '(réponse vide)';
  } else {
    const head = git(cwd, ['log', '-1', '--format=%h %s']).out;
    result = `✓ ${projectName} — pipeline Développement léger terminé (${run}).\n\n` +
      `- Commit : ${head}\n` +
      `- Étapes : ${state.steps.filter(s => s.status === 'ok').map(s => `${s.title.split(' ')[0]} ${s.model || 'défaut'}`).join(' → ')}\n` +
      `- Critères vérifiés par l'orchestrateur : test rouge puis vert, tests inchangés en 4b, revue, version, CHANGELOG${cfg.requirements ? ', exigence' : ''}, suite verte\n` +
      `- Pas de push (soumis à autorisation).\n\n${(readArtefact(ctx, 'livraison.md') || '').trim().slice(0, 4000)}`;
  }
  return finish({ code: 0, result });
}

/** Annule les modifications d'un essai refusé (fichiers seulement, jamais les artefacts). */
function restoreFiles(cwd, before, after, resetTo) {
  if (resetTo) git(cwd, ['reset', '--soft', resetTo]);
  for (const f of changedFiles(before, after)) {
    const abs = path.join(cwd, f);
    if (!before.has(f)) { try { fs.rmSync(abs, { force: true }); } catch {} continue; }
    const h = before.get(f);
    const r = spawnSync('git', ['-C', cwd, 'cat-file', 'blob', h], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, r.stdout); }
  }
}
