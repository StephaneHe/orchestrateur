// ============================================================================
// scripts/_regression_sandbox.mjs — instance de test ISOLÉE du dashboard
// ============================================================================
//
// Construit, depuis n'importe quel état du code (ref git, dossier, ou l'arbre
// de travail), une copie jetable sous `.regress/` et y lance le VRAI server.js
// sur un port libre, avec :
//   · une flotte de fixtures (14 projets couvrant tous les états, dont deux qui gardent l'ancien marqueur « parked »,
//     file, question, stall, processus perdu, question acquittée…) ;
//   · `CLAUDE_BIN` → tests/fake_claude (aucun appel réseau, aucun coût) ;
//   · 7777 réécrit dans server.js ET dans les scripts copiés (dispatch, notify,
//     restart…) — puis VÉRIFIÉ absent : si une occurrence survit, on abandonne
//     plutôt que de risquer de parler (ou de tuer) l'instance de production ;
//   · ssh-server remplacé par un bouchon, notifications bureau neutralisées.
//
// Le serveur de production (7777, I:\orchestrateur\logs) n'est jamais touché.
// Les node_modules sont trouvés en remontant (`.regress/` est sous le dépôt).
// ============================================================================

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(__dirname, '..');
export const REGRESS_DIR = path.join(REPO, '.regress');

// Fichiers dont server.js / les parcours ont besoin mais qui ne sont pas
// (encore) versionnés : copiés depuis l'arbre de travail s'ils manquent au ref.
const OVERLAY_IF_MISSING = [
  'src/classifier.mjs', 'src/interrupt_policy.mjs', 'src/message_router.mjs',
  'scripts/notify.mjs', 'scripts/restart-orchestrateur.mjs',
  'tests/fake_claude/fake_claude.mjs', 'scripts/downloads-registry.mjs',
];
const OVERLAY_DIRS_IF_MISSING = ['templates'];   // lu par new-project.mjs (non versionné)

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (skip(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, skip);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/** Extrait le code d'un état donné dans `dst`.
 *  source = { worktree: true } | { ref: 'tag-ou-sha' } | { dir: 'chemin' } */
export function extractCode(source, dst) {
  fs.mkdirSync(dst, { recursive: true });
  if (source.ref) {
    const tar = path.join(path.dirname(dst), `${path.basename(dst)}.tar`);
    const a = spawnSync('git', ['-C', REPO, 'archive', '--format=tar', '-o', tar, source.ref], { encoding: 'utf8' });
    if (a.status !== 0) throw new Error(`git archive ${source.ref} : ${a.stderr}`);
    // bsdtar de Windows : le tar GNU de Git Bash lit « I: » comme un hôte distant.
    const winTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const x = spawnSync(fs.existsSync(winTar) ? winTar : 'tar', ['-xf', tar, '-C', dst], { encoding: 'utf8' });
    if (x.status !== 0) throw new Error(`tar : ${x.stderr}`);
    fs.rmSync(tar, { force: true });
  } else {
    const base = source.dir ? path.resolve(source.dir) : REPO;
    for (const f of ['server.js', 'package.json', 'downloads.json']) {
      if (fs.existsSync(path.join(base, f))) fs.copyFileSync(path.join(base, f), path.join(dst, f));
    }
    for (const d of ['public', 'scripts', 'src', 'tests', 'data']) {
      if (fs.existsSync(path.join(base, d))) copyDir(path.join(base, d), path.join(dst, d), (s) => /\.bak$/.test(s));
    }
  }
  for (const d of OVERLAY_DIRS_IF_MISSING) {
    if (!fs.existsSync(path.join(dst, d)) && fs.existsSync(path.join(REPO, d))) copyDir(path.join(REPO, d), path.join(dst, d));
  }
  for (const rel of OVERLAY_IF_MISSING) {
    const to = path.join(dst, rel);
    if (fs.existsSync(to) || !fs.existsSync(path.join(REPO, rel))) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), to);
  }
}

/** Réécrit 7777 → port dans server.js et scripts/ ; neutralise ssh et toasts.
 *  Lève si une occurrence de 7777 survit dans du code exécutable. */
function patchForPort(root, port) {
  const srvPath = path.join(root, 'server.js');
  let srv = fs.readFileSync(srvPath, 'utf8');
  srv = srv.replace(/const PORT\s*=\s*7777;/, `const PORT = ${port};`).replace(/7777/g, String(port));
  srv = srv.replace(/function fireDesktopNotification\(([^)]*)\)\s*\{/, 'function fireDesktopNotification($1) { return;');
  fs.writeFileSync(srvPath, srv);
  fs.writeFileSync(path.join(root, 'ssh-server.js'),
    '// bouchon de l\'instance de test : pas de serveur SFTP\nexport function startSshServer() {}\n');

  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(root, 'scripts')).filter(f => /\.(mjs|js|cmd|ps1)$/.test(f))) {
    const t = fs.readFileSync(f, 'utf8');
    if (!t.includes('7777')) continue;
    fs.writeFileSync(f, t.replace(/7777/g, String(port)));
  }
  const leftovers = [srvPath, ...walk(path.join(root, 'scripts'))]
    .filter(f => /\.(mjs|js)$/.test(f))
    .filter(f => /\b7777\b/.test(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
  if (leftovers.length) throw new Error(`7777 subsiste dans : ${leftovers.join(', ')} — abandon (sécurité production)`);
  if (!new RegExp(`const PORT = ${port};`).test(fs.readFileSync(srvPath, 'utf8'))) {
    throw new Error('le port de server.js n\'a pas pu être réécrit — abandon');
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const OPUS = 'claude-opus-5-5';

const prompt = (text, ago, extra = {}) => ({ type: 'user_prompt', text, timestamp: iso(ago), ...extra });
const init = (ago) => ({ type: 'system', subtype: 'init', session_id: 'sess-fixture', model: OPUS, timestamp: iso(ago) });
const said = (text, ago) => ({ type: 'assistant', message: { model: OPUS, content: [{ type: 'text', text }] }, timestamp: iso(ago) });
const tool = (name, input, ago) => ({ type: 'assistant', message: { model: OPUS, content: [{ type: 'tool_use', id: 'toolu_' + crypto.randomBytes(4).toString('hex'), name, input }] }, timestamp: iso(ago) });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_api_ms: 9000, duration_ms: 33000, total_cost_usd: 0.42, result: 'ok', session_id: 'sess-fixture', ...extra });

/** Décrit la flotte de fixtures : ce que chaque projet DOIT montrer. */
export const FIXTURE_EXPECT = {
  attention: ['gamma', 'theta', 'iota', 'eta', 'beta', 'mu'],   // beta/mu : jusqu'à leur acquittement
  active: ['eps', 'delta'],
  rest: ['chef', 'alpha', 'lambda', 'kappa', 'omega', 'zeta'],
};

function fleetFixtures(root, keepAlivePid) {
  const logs = path.join(root, 'logs');
  const P = (name, lines) => fs.writeFileSync(path.join(logs, `${name}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  P('chef', [prompt('Fais le point sur la flotte', 2 * H), init(2 * H), said('Bonjour — la flotte est calme, rien à signaler.', 2 * H - 30_000), result({ result: 'Bonjour — la flotte est calme, rien à signaler.' })]);
  P('alpha', [prompt('Publier la version 1.2.3 de l\'app', 3 * H), init(3 * H), tool('Bash', { command: 'npm run build' }, 3 * H - 5000), said('Version 1.2.3 publiée.', 3 * H - 30_000), result()]);
  P('beta', [prompt('Préparer le déploiement', 20 * MIN), init(20 * MIN), said('Tout est prêt.\nNEEDS_USER_INPUT: Déployer en production maintenant ?', 12 * MIN), result()]);
  P('gamma', [prompt('Corriger les tests', 40 * MIN), init(40 * MIN), tool('Bash', { command: 'npm test' }, 39 * MIN), result({ is_error: true, subtype: 'error_max_turns', total_cost_usd: 1.1 })]);
  P('delta', [prompt('Choisir le protocole', 30 * MIN), init(30 * MIN), said('NEEDS_CHEF_INPUT: MQTT ou WebSocket pour la télémétrie ?', 25 * MIN), result()]);
  P('eps', [prompt('Lancer la suite complète', 50_000, { callback: 'chef' }), init(50_000), tool('Bash', { command: 'npm test -- --all' }, 5_000)]);
  P('theta', [prompt('Compiler le module natif', 15 * MIN), init(15 * MIN), tool('Bash', { command: 'gradlew assembleRelease' }, 10 * MIN)]);
  // iota (processus perdu) est écrit APRÈS le démarrage : healOrphanedLogs()
  // clôt au boot tout tour en vol dont le PID est mort (cf. injectAfterBoot).
  P('lambda', [prompt('Vérifier la config', 5 * H), init(5 * H), said('NEEDS_USER_INPUT: Garder le port 8080 ?', 5 * H - 60_000), result(),
    { type: 'notification', subtype: 'question_resolved', question: 'Garder le port 8080 ?', note: 'répondu via le chef', by: 'utilisateur', text: '✓ question marquée répondue', timestamp: iso(4 * H) }]);
  P('mu', [prompt('Nommer le module', 50 * MIN), init(50 * MIN), said('NEEDS_USER_INPUT: getUser ou fetchUser ?', 45 * MIN), result()]);
  P('zeta', [prompt('Archiver le projet', 9 * D), init(9 * D), said('Archivé.', 9 * D - 60_000), result()]);
  P('eta', [prompt('Relancer le scraping', 2 * D), init(2 * D), said('NEEDS_USER_INPUT: Le site a changé, continuer ?', 2 * D - 60_000), result()]);
  // kappa et omega : aucun log (« jamais observé »).

  fs.writeFileSync(path.join(logs, 'eps.pid'), String(keepAlivePid));
  // Marqueurs de lecture : zeta/chef déjà lus (repos), alpha non lu.
  fs.writeFileSync(path.join(logs, 'chef.read'), new Date().toISOString());
  fs.writeFileSync(path.join(logs, 'zeta.read'), new Date().toISOString());
  const qdir = path.join(logs, 'queue');
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(path.join(qdir, 'eps.json'), JSON.stringify([
    { id: 'q-fixture-1', prompt: 'Relancer les tests flaky', enqueuedAt: iso(3 * MIN) },
    { id: 'q-fixture-2', prompt: 'Publier le rapport de couverture', enqueuedAt: iso(2 * MIN) },
  ], null, 2));
}

function injectAfterBoot(root) {
  const logs = path.join(root, 'logs');
  fs.writeFileSync(path.join(logs, 'iota.pid'), '4194300');         // PID mort
  fs.writeFileSync(path.join(logs, 'iota.jsonl'), [
    prompt('Migrer la base', 5 * MIN), init(5 * MIN), tool('Bash', { command: 'node migrate.mjs' }, 30_000),
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
}

function writeFixtures(root, keepAlivePid) {
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const projDir = path.join(root, 'projects');
  const names = ['chef', 'alpha', 'beta', 'gamma', 'delta', 'eps', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'omega', 'zeta', 'eta'];
  for (const n of names) fs.mkdirSync(path.join(projDir, n), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'alpha', 'package.json'), JSON.stringify({ name: 'alpha', version: '1.2.3' }));
  fs.mkdirSync(path.join(projDir, 'alpha', 'app'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'alpha', 'app', 'build.gradle.kts'), 'android {\n  defaultConfig {\n    versionName = "1.2.3"\n    versionCode = 7\n  }\n}\n');
  fs.writeFileSync(path.join(projDir, 'gamma', 'pyproject.toml'), '[project]\nname = "gamma"\nversion = "0.4.0"\n');

  const config = {
    conductor: 'chef',
    defaults: { allowedTools: 'Read,Edit,Write,Bash,WebFetch,WebSearch,Grep,Glob', provider: 'claude' },
    // zeta et eta gardent l'ancien marqueur « parked » (concept supprimé en
    // 0.38.0) : il doit être IGNORÉ, comme dans un config.json pas encore nettoyé.
    projects: names.map(n => ({ name: n, path: path.join(projDir, n), ...(n === 'zeta' || n === 'eta' ? { parked: true } : {}) })),
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2) + '\n');

  fs.writeFileSync(path.join(root, 'downloads.json'), JSON.stringify({
    apps: [{ name: 'alpha', label: 'Alpha App', platform: 'phone', description: 'App de recette', version: { file: path.join(projDir, 'alpha', 'app', 'build.gradle.kts') } }],
    docs: [],
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(root, 'builds', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'builds', 'alpha', 'latest.apk'), Buffer.from('PK\u0003\u0004fake-apk'));

  fs.writeFileSync(path.join(root, '.token'), crypto.randomBytes(32).toString('hex'));
  modelCatalogFixtures(root);
  fleetFixtures(root, keepAlivePid);
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------
function listenerPids(port) {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  const out = new Set();
  for (const line of (r.stdout || '').split('\n')) {
    if (!/LISTENING/.test(line) || !new RegExp(`:${port}\\b`).test(line)) continue;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (pid > 0) out.add(pid);
  }
  return [...out];
}

/** Listes de models de la vue « Models par tâche » (0.39.0) : aucun réseau. */
function modelCatalogFixtures(root) {
  const dir = path.join(root, '.model-catalog-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-10-01T00:00:00Z',
    models: [
      { slug: 'gpt-6-astra', visibility: 'list', priority: 1, description: 'Frontier' },
      { slug: 'gpt-5.6-sol', visibility: 'list', priority: 4 },
      { slug: 'gpt-reserve', visibility: 'hide', priority: 3 },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'nvidia.json'), JSON.stringify({ data: [
    { id: 'moonshotai/kimi-k3' }, { id: 'nvidia/nemotron-3-ultra-550b-a55b' },
    { id: 'z-ai/glm-5.3' }, { id: 'nvidia/nemotron-3-embed-1b' },
    { id: 'meta/llama-3.2-90b-vision-instruct' },
  ] }));
  const mod = (inp, out) => ({ input_modalities: inp, output_modalities: out });
  fs.writeFileSync(path.join(dir, 'openrouter.json'), JSON.stringify({ data: [
    { id: 'anthropic/claude-haiku-5.5', supported_parameters: ['tools'], architecture: mod(['text', 'image'], ['text']) },
    { id: 'qwen/qwen3-coder', supported_parameters: ['tools', 'temperature'], architecture: mod(['text'], ['text']) },
    { id: 'some/no-tools-model', supported_parameters: ['temperature'], architecture: mod(['text'], ['text']) },
    { id: 'google/gemini-3-pro-image', supported_parameters: [], architecture: mod(['text', 'image'], ['text', 'image']) },
    { id: 'openai/gpt-audio', supported_parameters: [], architecture: mod(['text', 'audio'], ['text', 'audio']) },
  ] }));
  // Outils locaux « installés » de l'instance (aucune recherche dans le PATH).
  fs.writeFileSync(path.join(dir, 'local-tools.json'), JSON.stringify({ bins: ['ffmpeg', 'ffprobe', 'whisper', 'tesseract'], py: ['PIL'] }));
}

export function serverEnv(root, port) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // Clés OpenRouter / NVIDIA : toujours « absentes » dans l'instance de test
  // (état connu ; son .env est vide — le vrai n'est jamais copié).
  delete env.OPENROUTER_API_KEY;
  delete env.NVIDIA_API_KEY;
  delete env.DISPATCH_ROOT_FOR_TESTS;
  delete env.DISPATCH_SLOT;
  // Lancée depuis un tour (chef ou musicien), la recette hériterait de ses
  // marqueurs (0.48.0) : l'instance et ses dispatches passeraient pour ce tour.
  delete env.ORCH_TURN_PROJECT;
  delete env.ORCH_TURN_STEP;
  delete env.ORCH_STEP_TOKEN;
  Object.assign(env, {
    CLAUDE_BIN: path.join(root, 'tests', 'fake_claude', 'fake_claude.mjs'),
    CODEX_BIN: path.join(root, 'tests', 'fake_claude', 'fake_claude.mjs'),
    FAKE_CLAUDE_LATENCY_MS: '700',
    FAKE_CLAUDE_TOOL_USES: '2',
    // Étapes de pipeline (0.48.0) : n'agit que sur un prompt « PIPELINE_STEP= ».
    FAKE_CLAUDE_PIPELINE: '1',
    ORCH_PORT: String(port),
    // add-tool also marks the workspace trusted: never in the real ~/.claude.json.
    ORCH_CLAUDE_JSON: path.join(root, '.claude.json'),
    MODEL_CATALOG_FIXTURES: path.join(root, '.model-catalog-fixtures'),
    // Terminal central (0.52.0) : une doublure interactive, jamais le vrai claude.exe.
    ORCH_CENTRAL_CMD: JSON.stringify([process.execPath, path.join(root, 'tests', 'fake_claude', 'fake_claude.mjs'), '--orch-fake-interactive']),
  });
  return env;
}

export async function waitUp(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (r.status > 0) return true;
    } catch { /* pas encore */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

/**
 * Construit et démarre une instance. Renvoie { root, port, token, url, stop,
 * restartWith(scriptRel) }. `label` nomme le dossier sous .regress/.
 */
/** A fixed port for the sandbox (0.68.0: the dev instance's own port). Never
 *  the production port, and only if nothing listens on it. */
export async function checkFixedPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`port invalide : ${port}`);
  if (p === 7777) throw new Error('7777 est le port de la production : jamais pour une instance de test');
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', () => reject(new Error(`le port ${p} est déjà occupé`)));
    s.listen(p, '0.0.0.0', () => s.close(resolve));
  });
  return p;
}

export async function startSandbox(source, label, { port: fixedPort = null } = {}) {
  const root = path.join(REGRESS_DIR, `${label}-${Date.now().toString(36)}`);
  fs.mkdirSync(root, { recursive: true });
  extractCode(source, root);
  const port = fixedPort ? await checkFixedPort(fixedPort) : await freePort();
  patchForPort(root, port);

  // Un vrai processus vivant tient le PID du musicien « eps » (tour en vol).
  const keepAlive = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore', windowsHide: true });
  writeFixtures(root, keepAlive.pid);
  const token = fs.readFileSync(path.join(root, '.token'), 'utf8').trim();

  const out = fs.openSync(path.join(root, 'server.out'), 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: serverEnv(root, port), stdio: ['ignore', out, out], windowsHide: true,
  });
  const up = await waitUp(port);
  if (!up) {
    try { child.kill(); } catch {}
    try { keepAlive.kill(); } catch {}
    throw new Error(`l'instance de test ne répond pas sur :${port} — voir ${path.join(root, 'server.out')}`);
  }
  injectAfterBoot(root);

  // Garde le tour d'eps « vivant » (un événement toutes les 20 s) : sinon il
  // basculerait en « sans progrès » au bout de 60 s et fausserait les attentes.
  const pulse = setInterval(() => {
    try {
      fs.appendFileSync(path.join(root, 'logs', 'eps.jsonl'),
        JSON.stringify(tool('Bash', { command: 'npm test -- --shard ' + Math.floor(Math.random() * 9) }, 0)) + '\n');
    } catch {}
  }, 20_000);
  pulse.unref();

  async function stop() {
    clearInterval(pulse);
    for (const pid of listenerPids(port)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    try { child.kill(); } catch {}
    try { keepAlive.kill(); } catch {}
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && listenerPids(port).length) await new Promise(r => setTimeout(r, 300));
  }

  return { root, port, token, url: `http://127.0.0.1:${port}`, stop, env: serverEnv(root, port), child };
}
