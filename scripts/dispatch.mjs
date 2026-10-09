#!/usr/bin/env node
// ============================================================================
// scripts/dispatch.mjs — sub-agent spawn helper
// ============================================================================
//
// Called by the central claude via its Bash tool:
//
//   node scripts/dispatch.mjs <projectName> "<prompt>"
//   node scripts/dispatch.mjs <projectName> --prompt-stdin < /tmp/p.txt
//
// MODE DOUBLE MODEL (0.44.0) — deux models sur la même tâche, puis relecture :
//
//   node scripts/dispatch.mjs <projet> "<demande>" --model <principal> --second-model <second>
//        [--provider claude|codex] [--second-provider claude|codex]   (déduit de l'id : gpt… → codex)
//        [--dual-mode action|judge]                                   (défaut : action)
//
//   Les deux branches tournent EN PARALLÈLE et INDÉPENDAMMENT, chacune dans un
//   git worktree (logs/dual/wt/<projet>/<rôle>), avec son log, sa session et son
//   coût (logs/dual/<run>/). Puis le PRINCIPAL relit les deux résultats dans le
//   vrai dépôt, fusionne la meilleure version et conclut par « ## Synthèse
//   double ». Worktrees et branches git nettoyés ; l'archive reste
//   (diffs, résumés, summary.json). Le dépôt doit être git et propre.
//   - seconde en échec → relecture quand même + avertissement (log et chef) ;
//   - principal en échec → pause avec question (NEEDS_USER_INPUT), jamais de
//     substitution ;
//   - `--dual-mode judge` : deux rapports et une synthèse, rien de fusionné ;
//   - « model explicite = aucun fallback » pour les deux.
//   Codes : 0 relecture faite, 2 pause (principal en échec), 64 refus
//   (pas git, NVIDIA/OpenRouter, flags), 65 dépôt non propre.
//   Détails : scripts/dual-run.mjs et docs/PLAN-pipeline-enforcement.md.
//
// Duties (per CLAUDE.md):
//   1. Resolve the project from config.json (fail loudly if unknown).
//   2. Scrub ANTHROPIC_API_KEY from the child env — subscription auth only.
//   3. Build the argv with verified kebab-case flags (see server.js top
//      for the verification note).
//   4. Append stream-json events to logs/<project>.jsonl.
//   5. Parse events on-the-fly and write logs/<project>.session when we see
//      a session_id. The orchestrator server re-reads sidecars via chokidar.
//   6. Propagate the sub-agent's exit code.
//
// Provider abstraction:
//   • provider="claude" (default) — existing stream-json pipeline, OAuth auth.
//   • provider="codex"            — OpenAI Codex CLI (full-auto quiet mode);
//     plain text output is wrapped in synthetic stream-json events so the
//     viewer pipeline (chokidar → SSE → Musician) works identically.
//     Auth is codex's own OAuth login (`codex login`) — NO API key is ever
//     forwarded, same rule as Claude. No session continuity (Codex has no
//     --resume equivalent); each turn is independent.
//
// ---------------------------------------------------------------------------
// DETERMINISTIC FAILOVER — Claude session limit → NVIDIA cascade (codage-first)
// ---------------------------------------------------------------------------
//
// THIS CODE RUNS WHEN EVERYTHING ELSE IS BROKEN. When the Claude account
// hits its session limit, the conductor (itself a Claude session) is dead
// too — so there is NO intelligence available to react. Every step below is
// therefore plain, boring, side-effect-free-until-it-must-not-be code. No
// LLM in the loop deciding routing, no callback that has to "decide".
//
// WHERE THE FAILOVER GOES (changed 2026-08-31):
//   The operator was unhappy with codex/gpt-5.6-sol, so the failover now
//   routes to NVIDIA's free OpenAI-compatible endpoint
//   (https://integrate.api.nvidia.com/v1) trying an ORDERED, coding-first
//   cascade — the next model is tried ONLY if the previous errored / hit a
//   quota / timed out / returned empty:
//     1. moonshotai/kimi-k3
//     2. deepseek-ai/deepseek-v4-pro-0813
//     3. nvidia/nemotron-3-ultra-550b-a55b
//     4. deepseek-ai/deepseek-v4-flash-0731
//   (model IDs verified live against GET /v1/models on 2026-08-31.)
//
//   WHY A DIRECT CLIENT AND NOT THE CODEX HARNESS: the clean option would be
//   to keep codex as the agentic harness and point its provider at NVIDIA,
//   preserving tool-use. That is NOT possible here: codex-cli 0.147.0 dropped
//   `wire_api = "chat"` and requires the Responses API, but NVIDIA only
//   exposes chat/completions (`/v1/responses` → 404). So the failover leg
//   speaks OpenAI chat/completions to NVIDIA directly (see runNvidiaFailover).
//   TRADE-OFF, stated honestly: this leg is a SINGLE-SHOT completion — the
//   NVIDIA model returns text/code but cannot run Bash/Edit tools or fire the
//   callback. It is a degraded mode whose only job is to keep the turn from
//   being lost while Claude is out.
//
//   AUTH: NVIDIA_API_KEY is read from I:\orchestrateur\.env (gitignored) and
//   sent ONLY to integrate.api.nvidia.com — never forwarded to any child
//   process. ANTHROPIC_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY are all
//   scrubbed from the child env. No secret is ever logged.
//
// Flow:
//   1. START OF EVERY DISPATCH — read logs/claude-limited.until.
//      · now <  until  → skip Claude entirely, run the NVIDIA cascade.
//      · now >= until  → delete the flag, run Claude normally. This is the
//        automatic return to Claude at reset time: no operator action, no
//        scheduled job, it just happens on the next dispatch.
//   2. DURING A CLAUDE TURN — scan authoritative output (result event,
//      stderr, assistant text) for the session-limit message.
//   3. ON DETECTION — parse "resets <time>" out of the message, write the
//      absolute reset timestamp to logs/claude-limited.until (fallback:
//      now + 60 min if parsing fails), then replay THE SAME prompt through
//      the NVIDIA cascade. The prompt is kept in memory precisely for this
//      replay: the turn must be re-run from its original text.
//   4. The flag is FLEET-WIDE by design — the limit is global to the
//      Claude account, so every project routes to NVIDIA until reset.
//   5. LAST RESORT: if the entire NVIDIA cascade is down (or the key is
//      missing), the leg falls through once to codex/gpt-5.6-sol (OAuth,
//      restores tool-use) rather than losing the turn. If codex also fails
//      we log and exit cleanly. Never a retry loop: a loop here would hammer
//      dead upstreams with no one watching.
//
// SELF-TEST: `node scripts/dispatch.mjs --test-failover` exercises the NVIDIA
// leg live WITHOUT touching any project log/sidecar or setting the limit flag
// (add --test-failover-all to walk the whole cascade instead of just kimi-k3).
//
// The nominal Claude path is untouched when no limit is in effect.
//
// NOTE on --bare: NOT used. See server.js top-of-file comment for the
// reasoning (--bare disables OAuth; we want subscription billing). We
// approximate the isolation with --setting-sources project,local +
// --strict-mcp-config + --disable-slash-commands.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { derivedToken } from './local-secret.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DISPATCH_ROOT_FOR_TESTS : racine alternative (config.json, logs/, .env)
// pour les recettes de bout en bout. Le drapeau de limite Claude
// (logs/claude-limited.until) est à l'échelle de la FLOTTE : le simuler dans le
// vrai logs/ ferait basculer tous les musiciens vivants. Jamais posé en
// production ; il ne donne aucun droit de plus (il ne fait que déplacer des
// fichiers que le processus lit déjà).
const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS
  ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS)
  : path.resolve(__dirname, '..');

function die(msg, code = 64) { console.error(`[dispatch] ${msg}`); process.exit(code); }

// ---------- argv ------------------------------------------------------------

const argv = process.argv.slice(2);

// Failover self-test hook. Runs the NVIDIA cascade client against the live
// endpoint WITHOUT touching any project log, sidecar, pid file, or the
// fleet limit flag — proving the leg works without simulating a real limit.
// Function decls below are hoisted, so calling here (before they textually
// appear) is safe; runFailoverSelfTest always ends in process.exit().
if (argv.includes('--test-failover')) {
  await runFailoverSelfTest();   // never returns — exits with the test result
}

if (argv.length < 1) die('usage: node scripts/dispatch.mjs <project> "<prompt>" | --prompt-stdin [--callback <project>] [--source <project>] [--model <id>] [--provider claude|codex] [--queue-if-busy|--no-queue-if-busy] [--pool-assign] [--new-session] [--second-model <id> [--second-provider claude|codex] [--dual-mode action|judge]] | --test-failover');

const projectName = argv[0];

// Extract --callback before prompt parsing so it doesn't bleed into the prompt string.
let callbackProject = null;
const cbIdx = argv.indexOf('--callback');
if (cbIdx !== -1) {
  if (cbIdx + 1 >= argv.length) die('--callback requires a project name');
  callbackProject = argv[cbIdx + 1];
  argv.splice(cbIdx, 2);
}

// Extract --source: marks the originating project when a musician sends a callback.
let sourceProject = null;
const srcIdx = argv.indexOf('--source');
if (srcIdx !== -1) {
  if (srcIdx + 1 >= argv.length) die('--source requires a project name');
  sourceProject = argv[srcIdx + 1];
  argv.splice(srcIdx, 2);
}

// ---------------------------------------------------------------------------
// --model / --provider (0.22.0)
// ---------------------------------------------------------------------------
// Avant : pour lancer un musicien sur un autre model, le chef éditait
// `config.json` (set → dispatch → revert). Avec plusieurs chefs c'est une
// écriture concurrente sur un fichier partagé : perte de mise à jour garantie,
// et le hot-reload du serveur tourne dans le vide. Le flag remplace la danse ;
// `config.json` n'a plus à être écrit par un chef. Absent, on retombe
// EXACTEMENT sur l'ancien comportement (`project.model || defaults.model`) :
// rien de ce qui marche aujourd'hui ne casse.
function takeFlagValue(flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  if (i + 1 >= argv.length) die(`${flag} requires a value`);
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const modelOverride    = takeFlagValue('--model');
const providerOverride = takeFlagValue('--provider');
// 0.47.0 (phase 2 des pipelines) : nvidia et openrouter passent par codex,
// harnais unique hors Claude — mêmes outils, même journal, aucun repli.
if (providerOverride && !['claude', 'codex', 'nvidia', 'openrouter'].includes(providerOverride)) {
  die(`--provider must be "claude", "codex", "nvidia" or "openrouter" (got "${providerOverride}")`);
}

// ---------------------------------------------------------------------------
// MODE DOUBLE MODEL (0.44.0) — voir scripts/dual-run.mjs
// ---------------------------------------------------------------------------
// Demande utilisateur : « on peut donner 2 models (1 par defaut), et si 2 sont
// precises, on lance la tache sur les 2, puis le 1er relis le tout pour en tirer
// le meilleur des 2 ». `--second-model` déclenche le mode : deux branches
// indépendantes et isolées (worktree git chacune), puis la relecture par le
// principal (`--model`), qui fusionne la meilleure version dans le vrai dépôt.
// Les drapeaux `--dual-branch` / `--dual-cwd` / `--dual-synthesis` sont posés
// par dual-run.mjs pour ses propres lancements, jamais à la main.
const secondModel    = takeFlagValue('--second-model');
const secondProvider = takeFlagValue('--second-provider');
const dualMode       = takeFlagValue('--dual-mode') || 'action';
const dualBranchArg  = takeFlagValue('--dual-branch');
const dualCwdArg     = takeFlagValue('--dual-cwd');
const dualSynthesis  = takeFlagValue('--dual-synthesis');
// 0.47.2 — tour d'ESSAI (outillage, recette) : affiché « 🧪 test en cours »,
// jamais en rouge, même si son processus est arrêté. `ORCH_TEST_LABEL` pour
// les scripts de test qui lancent dispatch.mjs.
const testLabel      = (takeFlagValue('--test') || process.env.ORCH_TEST_LABEL || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
// ---------------------------------------------------------------------------
// PIPELINES — phase 3 : le moteur (0.48.0), voir scripts/pipeline-engine.mjs
// ---------------------------------------------------------------------------
//   --pipeline discussion|dev    exécution d'un pipeline (une étape = un tour,
//                                sur le model de SA case de la page Models)
//   --pipeline-resume <run>      reprend une exécution en pause
//   --hors-pipeline "<raison>"   sortie d'urgence (décision n° 1), TRACÉE
//   --pipeline-step / --pipeline-session : posés par le moteur pour ses propres
//   tours d'étape, avec un jeton signé (ORCH_STEP_TOKEN) — jamais à la main.
// Sur un projet EN SERVICE (model-routing.json → enforcement), une demande sans
// --pipeline est classée et part dans le bon pipeline ; un musicien ne peut pas
// y lancer de tour ; une étape ne lance aucun tour.
const pipelineArg       = takeFlagValue('--pipeline');
const pipelineResumeArg = takeFlagValue('--pipeline-resume');
const pipelineStepArg   = takeFlagValue('--pipeline-step');
const pipelineSession   = takeFlagValue('--pipeline-session');
const horsPipelineArg   = takeFlagValue('--hors-pipeline');
// --mode leger|complet (0.49.0) : force le mode du Développement ; sinon la classification.
const pipelineModeArg   = takeFlagValue('--mode');
if (pipelineModeArg && !['leger', 'complet'].includes(pipelineModeArg)) die(`--mode leger|complet (reçu « ${pipelineModeArg} »)`);
const STEP_TOKEN = process.env.ORCH_STEP_TOKEN || null;
const TURN_OF    = process.env.ORCH_TURN_PROJECT || null;   // ce dispatch est lancé DEPUIS un tour de ce projet
const TURN_STEP  = process.env.ORCH_TURN_STEP || null;      // … qui est une étape de pipeline
delete process.env.ORCH_STEP_TOKEN; delete process.env.ORCH_TURN_PROJECT; delete process.env.ORCH_TURN_STEP;
let PIPE_STEP = null;   // { run, key } : ce processus est un tour d'étape du moteur
if (pipelineStepArg) {
  const m = /^(p-\d{8}T\d{6}-[a-z0-9]{4,8}):(\d{2}-[a-z0-9-]{1,40})$/.exec(pipelineStepArg);
  if (!m) die(`--pipeline-step invalide : ${pipelineStepArg}`);
  PIPE_STEP = { run: m[1], key: m[2] };
}
if (pipelineSession && !/^[a-z0-9-]{1,40}$/.test(pipelineSession)) die(`--pipeline-session invalide : ${pipelineSession}`);
if (pipelineArg && !['discussion', 'dev'].includes(pipelineArg)) {
  die(`--pipeline ${pipelineArg} : pipeline pas encore en service (phase 3 : discussion, dev). Les autres arrivent en phase 6.`);
}
if (horsPipelineArg != null && !String(horsPipelineArg).trim()) die('--hors-pipeline exige une raison');
const DUAL_RUN_RE = /^d-\d{8}T\d{6}-[a-z0-9]{4,8}$/;
if (secondProvider && !['claude', 'codex', 'nvidia', 'openrouter'].includes(secondProvider)) die(`--second-provider must be "claude", "codex", "nvidia" or "openrouter" (got "${secondProvider}")`);
if (!['action', 'judge'].includes(dualMode)) die(`--dual-mode must be "action" or "judge" (got "${dualMode}")`);
if (secondModel && !modelOverride) die('--second-model exige un model principal explicite : --model <principal> --second-model <second>');
let DUAL_BRANCH = null;   // { run, role } : ce processus est l'une des deux branches
if (dualBranchArg) {
  const m = /^(d-\d{8}T\d{6}-[a-z0-9]{4,8}):(principal|second)$/.exec(dualBranchArg);
  if (!m) die(`--dual-branch invalide : ${dualBranchArg}`);
  DUAL_BRANCH = { run: m[1], role: m[2] };
}
if (dualSynthesis && !DUAL_RUN_RE.test(dualSynthesis)) die(`--dual-synthesis invalide : ${dualSynthesis}`);

// ---------------------------------------------------------------------------
// --queue-if-busy (0.22.0)
// ---------------------------------------------------------------------------
// Un musicien occupé n'est JAMAIS interrompu par un chef. Jusqu'ici ce script
// spawnait sans regarder le `.pid` de sa cible : deux dispatches rapprochés
// lançaient deux `claude --resume` sur la même session. Quand la file est
// active, on POSTe au serveur qui range dans la file par musicien.
// Par défaut ACTIF quand DISPATCH_SLOT est défini (c'est un chef qui parle) ;
// inactif sinon, pour ne rien changer aux appels manuels/outillés.
// Qui lance ce dispatch ? `DISPATCH_SLOT` ne le dit PAS : le serveur le stampe
// sur le tour de chef qu'il lance LUI-MÊME pour remplir un slot, et le `claude`
// du chef le transmet ensuite à son outil Bash. Les deux cas ont donc le même
// env ; seul un argv les sépare, parce qu'un flag ne s'hérite pas. Sans cette
// distinction, les gardes ci-dessous tuaient le tour de chef que le pool venait
// d'assigner — sortie 65 instantanée, file bloquée (24/09/2026).
// --new-session (0.27.0) : ce tour démarre SANS --resume. L'ancienne session
// n'est pas effacée : son sidecar est archivé (.session.bak-<horodatage>), puis
// le session_id du nouveau tour devient le courant. Usages : études
// indépendantes par des models différents sur un même musicien, ou repartir
// d'un contexte court quand une session est devenue trop longue (et chère).
const newSessionIdx = argv.indexOf('--new-session');
if (newSessionIdx !== -1) argv.splice(newSessionIdx, 1);
const NEW_SESSION = newSessionIdx !== -1;

const poolAssignIdx = argv.indexOf('--pool-assign');
if (poolAssignIdx !== -1) argv.splice(poolAssignIdx, 1);
const POOL_ASSIGN = poolAssignIdx !== -1;

// ---------------------------------------------------------------------------
// Réveil en RAPPORT SEUL (0.23.1)
// ---------------------------------------------------------------------------
// Passé WAKE_MAX_GEN, le serveur réveille quand même le chef (un résultat
// attendu n'est plus jamais perdu) mais avec DISPATCH_REPORT_ONLY=1. Tout
// dispatch lancé depuis ce tour est REFUSÉ, avant la moindre écriture.
//
// Pourquoi refuser plutôt qu'accepter sans --callback : les deux coupent la
// boucle de réveils, mais le second lancerait encore une 4ᵉ génération de
// travail autonome (commits, push, builds…) dont personne ne ferait le point.
// Refuser rend la fin de chaîne nette : le chef rend compte, l'utilisateur
// décide de la suite. Le tour de chef lui-même (lancé par le serveur avec
// --pool-assign) n'est évidemment pas concerné.
if (process.env.DISPATCH_REPORT_ONLY === '1' && !POOL_ASSIGN) {
  die(`dispatch refusé : ce tour de chef est un réveil en RAPPORT SEUL (chaîne de réveils ` +
    `au maximum). Fais le point à l'utilisateur et propose-lui l'étape suivante — c'est lui ` +
    `qui la lancera (cible demandée : « ${argv[0]} »).`, 65);
}

const noQueueIdx = argv.indexOf('--no-queue-if-busy');
if (noQueueIdx !== -1) argv.splice(noQueueIdx, 1);
const queueIdx = argv.indexOf('--queue-if-busy');
if (queueIdx !== -1) argv.splice(queueIdx, 1);
const CHEF_SLOT   = Number(process.env.DISPATCH_SLOT || 0) || null;
const CHEF_TICKET = process.env.DISPATCH_TICKET || null;
// Les lancements internes du mode double ne passent jamais par la file : le
// parent tient déjà la place du musicien.
const queueIfBusy = (DUAL_BRANCH || dualSynthesis || PIPE_STEP) ? false : noQueueIdx !== -1 ? false : (queueIdx !== -1 || CHEF_SLOT != null);
// Une branche ne rend compte à personne : c'est la relecture qui rend compte.
if (DUAL_BRANCH || PIPE_STEP) callbackProject = null;

let prompt = '';
let imagePaths = [];   // populated when server passes attachment paths
let videoPaths = [];   // populated when server passes video paths (Claude API doesn't accept video)

if (argv[1] === '--prompt-stdin') {
  const raw = fs.readFileSync(0, 'utf8');
  // Server sends a JSON envelope when attachments are present; plain text otherwise.
  try {
    const env = JSON.parse(raw);
    if (typeof env.prompt === 'string') {
      prompt = env.prompt;
      if (Array.isArray(env.attachmentPaths)) imagePaths = env.attachmentPaths;
      if (Array.isArray(env.videoPaths))      videoPaths = env.videoPaths;
    } else {
      prompt = raw;
    }
  } catch {
    prompt = raw; // plain text — backward compat
  }
} else if (argv.length >= 2) {
  prompt = argv.slice(1).join(' ');
} else if (pipelineResumeArg) {
  prompt = '';   // la demande est dans l'état de l'exécution reprise
} else {
  die('missing prompt — pass as argv or use --prompt-stdin');
}

if (!prompt.trim() && !imagePaths.length && !videoPaths.length && !pipelineResumeArg) die('empty prompt');

// ---------- config ----------------------------------------------------------

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Garde-fous du pool (0.22.0) — AVANT la résolution du projet, pour que le
// message explique le vrai problème plutôt qu'un « unknown project ».
// ---------------------------------------------------------------------------
const CONDUCTOR = config.conductor || 'chef';
// Un chef ne cible jamais un slot par son nom : le pool s'adresse par son nom
// logique, et c'est le serveur qui choisit le slot. (Les alias `chef-2`/
// `chef-3` arrivent en P0-B ; les refuser dès maintenant évite l'habitude.)
const CHEF_SPEAKING = CHEF_SLOT != null && !POOL_ASSIGN;
if (CHEF_SPEAKING && new RegExp(`^${CONDUCTOR}-\\d+$`).test(projectName)) {
  die(`un chef ne cible jamais un slot (« ${projectName} ») — écris « ${CONDUCTOR} », le serveur choisit`, 65);
}
// Délégation chef → chef : c'est P0-B. Refuser explicitement vaut mieux que
// spawner un second `--resume` sur la session du chef (suicide de tour).
if (CHEF_SPEAKING && projectName === CONDUCTOR) {
  die('délégation chef → chef non disponible (P0-B) — route vers un musicien ou réponds toi-même', 65);
}

const project = config.projects.find(p => p.name === projectName);
if (!project) {
  die(`unknown project "${projectName}". Known: ${config.projects.map(p => p.name).join(', ')}`);
}
if (!fs.existsSync(project.path)) {
  die(`project path does not exist: ${project.path}`, 66);
}
if (callbackProject && !config.projects.find(p => p.name === callbackProject)) {
  die(`--callback: unknown project "${callbackProject}". Known: ${config.projects.map(p => p.name).join(', ')}`);
}

// Le flag gagne sur la config ; sans flag, le comportement historique.
const model    = modelOverride    || project.model    || config.defaults?.model        || 'claude-sonnet-4-6';
const tools    = project.tools    || config.defaults?.allowedTools || 'Read,Edit,Write,Bash,WebFetch,WebSearch,Grep,Glob';
const provider = providerOverride || project.provider || config.defaults?.provider     || 'claude';

// Un `--model` doit appartenir à la famille du provider qui va le recevoir.
// Transmis tel quel, un `claude-*` fait échouer codex (et un `gpt-*` le CLI
// claude) après le démarrage du tour : mieux vaut un refus clair ici, avant la
// moindre écriture de log.
const CLAUDE_MODEL_RE = /^(claude|opus|sonnet|haiku|fable)\b/i;
const OPENAI_MODEL_RE = /^(gpt|o\d|codex)\b/i;
// NVIDIA et OpenRouter : leurs identifiants sont « éditeur/model » ; le model
// est toujours explicite (--model, ou nvidiaModel / openrouterModel du projet).
const HARNESS_PROVIDER = provider === 'nvidia' || provider === 'openrouter';
if (HARNESS_PROVIDER && !modelOverride && !project[`${provider}Model`]) {
  die(`--provider ${provider} : précise le model (--model éditeur/model), il n'y a pas de défaut`, 64);
}
if (HARNESS_PROVIDER && modelOverride && !/^[A-Za-z0-9][A-Za-z0-9._:\/@+~-]{0,159}$/.test(modelOverride)) {
  die(`--model ${modelOverride} : identifiant invalide`, 64);
}
if (modelOverride && provider === 'codex' && CLAUDE_MODEL_RE.test(modelOverride)) {
  die(`--model ${modelOverride} est un model Claude : avec --provider codex, passe un model OpenAI ` +
    `(ex. gpt-6-astra, gpt-5.6-sol) ou omets --model pour le défaut de codex (config.toml)`);
}
if (modelOverride && provider === 'claude' && OPENAI_MODEL_RE.test(modelOverride)) {
  die(`--model ${modelOverride} est un model OpenAI : ajoute --provider codex`);
}

// ---------- pipelines en service : porte d'entrée (phase 3, 0.48.0) ----------
// Avant toute écriture. Les refus sont mécaniques (plan §3.3) : une consigne de
// prompt ne suffit pas.
const pipeEngine = await import('./pipeline-engine.mjs');
const ENFORCEMENT = pipeEngine.readEnforcement(ROOT);
const ENFORCED = pipeEngine.isEnforced(ENFORCEMENT, projectName);
// 1. Une étape de pipeline ne lance aucun tour (le moteur est seul maître).
if (TURN_STEP) {
  die(`dispatch refusé : ce tour est une étape de pipeline (${TURN_STEP}) — une étape ne lance pas d'autre tour. ` +
    `Si un autre travail est nécessaire, écris-le dans ton artefact : l'utilisateur ou le chef le lancera.`, 65);
}
// 2. Un musicien (pas le chef) ne lance pas de tour sur un projet en service.
const TURN_OF_CHEF = TURN_OF === CONDUCTOR || new RegExp(`^${CONDUCTOR}-\\d+$`).test(TURN_OF || '') || CHEF_SLOT != null;
if (TURN_OF && !TURN_OF_CHEF && ENFORCED && !PIPE_STEP) {
  die(`dispatch refusé : « ${projectName} » est en service (pipelines obligatoires) et ce dispatch vient d'un tour du ` +
    `musicien « ${TURN_OF} ». Seuls le chef, l'utilisateur et le moteur de pipelines lancent un tour sur ce projet.`, 65);
}
// 3. Lancements internes (étape, branche ou relecture du mode double) sur un
//    projet en service : jeton d'étape signé obligatoire, model conforme.
let STEP_GRANT = null;
if (PIPE_STEP || (ENFORCED && (DUAL_BRANCH || dualSynthesis))) {
  const v = pipeEngine.verifyStepToken(ROOT, STEP_TOKEN);
  if (!v.ok) die(`tour d'étape refusé : ${v.why}`, 65);
  const g = v.payload;
  const allowed = [g.model || null, g.second?.model || null];
  const okModel = DUAL_BRANCH ? allowed.includes(modelOverride || null) : (modelOverride || null) === (g.model || null);
  if (g.project !== projectName) die(`tour d'étape refusé : jeton émis pour « ${g.project} »`, 65);
  if (PIPE_STEP && (g.run !== PIPE_STEP.run || g.key !== PIPE_STEP.key)) die('tour d\'étape refusé : jeton émis pour une autre étape', 65);
  if (!okModel) die(`tour d'étape refusé : model « ${modelOverride || 'défaut'} » ≠ model de la case (« ${g.model || 'défaut du projet'} »)`, 65);
  STEP_GRANT = g;
}
// 4. Un projet en service ne reçoit pas de model choisi à la main : ce sont les
//    cases de la page Models qui décident (sauf sortie d'urgence tracée).
const AUTO_PIPELINE = ENFORCED && !PIPE_STEP && !DUAL_BRANCH && !dualSynthesis && horsPipelineArg == null;
if (AUTO_PIPELINE && (modelOverride || secondModel) && !pipelineResumeArg) {
  die(`« ${projectName} » est en service (pipelines obligatoires) : les models viennent des cases de la page Models. ` +
    `Retire --model/--second-model, ou utilise --hors-pipeline "<raison>" (tracé et visible).`, 64);
}
if ((pipelineArg || pipelineResumeArg) && (PIPE_STEP || DUAL_BRANCH || dualSynthesis)) die('--pipeline est incompatible avec un lancement interne');
if ((pipelineArg || pipelineResumeArg) && (modelOverride || secondModel)) {
  die('--pipeline : les models viennent des cases de la page Models — retire --model/--second-model', 64);
}

// ---------------------------------------------------------------------------
// MODEL EXPLICITE = AUCUN FALLBACK (0.26.0, règle utilisateur)
// ---------------------------------------------------------------------------
// « Si un modèle est précisément demandé, aucun fallback n'est toléré. »
// Un model est explicite quand il arrive par `--model` — y compris depuis une
// file, le pool ou l'API, qui relancent tous dispatch.mjs avec `--model`.
// Dans ce cas : pas de failover NVIDIA, pas de repli codex, pas de défaut
// projet/fleet, et on VÉRIFIE que le CLI sert bien ce model. Indisponible ou
// substitué ⇒ le tour échoue proprement (result is_error, cause explicite), le
// chef est notifié ✕, et rien n'est exécuté par un autre model.
// Sans --model, rien ne change : défauts et failover sur limite comme avant.
const EXPLICIT_MODEL = modelOverride || null;

/** Le model servi est-il bien celui demandé ? Tolère un suffixe de DATE
 *  (`claude-haiku-4-5` ↔ `claude-haiku-4-5-20251001`), un suffixe entre
 *  crochets (`[1m]`) et un alias nu (`opus`). Surtout PAS un préfixe
 *  quelconque : `claude-opus-5-5` n'est pas `claude-opus-5`. `<synthetic>` =
 *  message fabriqué par le CLI lui-même (notice d'erreur), pas un model. */
function modelMatches(requested, actual) {
  if (!actual || actual === '<synthetic>') return true;
  const norm = (s) => String(s).toLowerCase().replace(/\[.*?\]$/, '').trim();
  const r = norm(requested), a = norm(actual);
  if (a === r) return true;
  const dated = (long, short) => long.startsWith(short) && /^-\d{8}$/.test(long.slice(short.length));
  if (dated(a, r) || dated(r, a)) return true;
  if (/^(opus|sonnet|haiku|fable)$/.test(r)) return a.startsWith(`claude-${r}-`);
  return false;
}

// ---------- paths -----------------------------------------------------------

const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

// Kill-switch failover : si logs/no-failover existe, aucune bascule de modèle.
const NO_FAILOVER = fs.existsSync(path.join(LOGS, 'no-failover'));

// Une BRANCHE du mode double ne touche à rien de ce qui appartient au musicien :
// ni son log (le pump interpréterait son result comme la fin du tour), ni sa
// session, ni son .pid. Tout va dans logs/dual/<run>/<role>.*, session neuve.
const DUAL_DIR = DUAL_BRANCH ? path.join(LOGS, 'dual', DUAL_BRANCH.run) : null;
if (DUAL_DIR) fs.mkdirSync(DUAL_DIR, { recursive: true });
// Un tour d'ÉTAPE (pipelines, 0.48.0) non plus : son log, son .pid et sa session
// (une par exécution et par groupe/model, plan §2.2) sont sous logs/runs/<run>/.
// La relecture d'un mode double DANS une étape écrit aussi dans le log d'étape.
const STEP_DIR = PIPE_STEP ? path.join(LOGS, 'runs', PIPE_STEP.run) : null;
if (STEP_DIR) fs.mkdirSync(STEP_DIR, { recursive: true });
const logPath     = DUAL_DIR ? path.join(DUAL_DIR, `${DUAL_BRANCH.role}.jsonl`)   : STEP_DIR ? path.join(STEP_DIR, `${PIPE_STEP.key}.jsonl`) : path.join(LOGS, `${projectName}.jsonl`);
const sessionPath = DUAL_DIR ? path.join(DUAL_DIR, `${DUAL_BRANCH.role}.session`) : STEP_DIR ? path.join(STEP_DIR, `${pipelineSession || PIPE_STEP.key}.session`) : path.join(LOGS, `${projectName}.session`);
const pidPath     = DUAL_DIR ? path.join(DUAL_DIR, `${DUAL_BRANCH.role}.pid`)     : STEP_DIR ? path.join(STEP_DIR, `${PIPE_STEP.key}.pid`) : path.join(LOGS, `${projectName}.pid`);

let sessionId = null;
if (!DUAL_BRANCH) { try { sessionId = fs.readFileSync(sessionPath, 'utf8').trim() || null; } catch {} }

// Dossier de travail : celui du projet, sauf pour une branche du mode double
// (sa copie isolée — un worktree sous logs/dual/wt/, rien d'autre n'est admis).
let WORK_DIR = project.path;
if (dualCwdArg) {
  const wtRoot = path.resolve(LOGS, 'dual', 'wt') + path.sep;
  const wanted = path.resolve(dualCwdArg);
  if (!DUAL_BRANCH || !wanted.startsWith(wtRoot) || !fs.existsSync(wanted)) die(`--dual-cwd refusé : ${dualCwdArg}`);
  WORK_DIR = wanted;
}

// Demandes d'autorisation interactives (0.45.0). Délai de réponse : 5 min par
// défaut, `permissionTimeoutMin` du projet puis de `defaults` (config.json, lu
// seulement), ORCH_PERM_TIMEOUT_MS pour les tests. Désactivables sans
// redéploiement : `defaults.permissionPrompts: false` (ou celui du projet).
const PERMISSION_PROMPTS = process.env.ORCH_PERM_DISABLE !== '1' &&
  (project.permissionPrompts ?? config.defaults?.permissionPrompts ?? true) !== false;
const PERMISSION_TIMEOUT_MS = Number(process.env.ORCH_PERM_TIMEOUT_MS) > 0
  ? Number(process.env.ORCH_PERM_TIMEOUT_MS)
  : Math.round(60_000 * (Number(project.permissionTimeoutMin) > 0 ? Number(project.permissionTimeoutMin)
    : Number(config.defaults?.permissionTimeoutMin) > 0 ? Number(config.defaults.permissionTimeoutMin) : 5));

// ============================================================================
// FAILOVER CORE — deterministic, no IA in the loop. See top-of-file comment.
// ============================================================================

// Fleet-wide flag. Contains a single ISO-8601 timestamp: the moment the
// Claude session limit is expected to reset. Presence alone means nothing —
// only `now < contents` means "limited". An expired flag is deleted on read,
// which is what makes the return to Claude automatic.
const LIMIT_FLAG_PATH = path.join(LOGS, 'claude-limited.until');

// Model used for the failover leg. Explicit per the fleet spec; a project's
// own codexModel (or the config default) still wins if one is configured.
const FAILOVER_CODEX_MODEL = 'gpt-5.6-sol';

// Conservative fallback when the reset time can't be parsed out of the
// message. Long enough to stop hammering a dead account, short enough that
// an over-estimate costs at most one hour of codex routing.
const LIMIT_FALLBACK_MS = 60 * 60 * 1000;

// Never trust a parsed reset further out than this. Guards against a
// misparse pinning the whole fleet on codex for days.
const LIMIT_MAX_MS = 24 * 60 * 60 * 1000;

/** Phrases that mean "the Claude session/usage budget is exhausted".
 *  Kept narrow on purpose: a false positive routes a healthy turn to codex. */
const LIMIT_PATTERNS = [
  /you'?ve\s+hit\s+your\s+(?:session|usage)\s+limit/i,
  /you\s+have\s+hit\s+your\s+(?:session|usage)\s+limit/i,
  /(?:session|usage)\s+limit\s+reached/i,
  /\d+\s*-?\s*hour\s+limit\s+reached/i,
  /claude\s+(?:ai\s+)?usage\s+limit\s+reached/i,
  /rate[_\s-]?limit[_\s-]?(?:error|exceeded)/i,
  /\bupgrade_required\b/i,
];

// "You're approaching your session limit" is a WARNING on a healthy turn.
// Treating it as exhaustion would fail over while Claude still works.
const LIMIT_NEGATIVE_PATTERN = /approaching|will\s+reach|about\s+to\s+(?:hit|reach)/i;

/** True when `text` states the Claude budget is actually exhausted. */
function detectClaudeLimit(text) {
  if (typeof text !== 'string' || !text) return false;
  if (LIMIT_NEGATIVE_PATTERN.test(text)) return false;
  return LIMIT_PATTERNS.some(re => re.test(text));
}

/**
 * Extract the reset instant from a limit message.
 * Handles "resets 3pm", "resets at 3:30 PM", "resets at 15:00" and an
 * embedded ISO timestamp. Returns a Date, or null when nothing parses.
 *
 * Times are read as LOCAL time — that is how the CLI prints them.
 */
function parseResetTime(text, now = new Date()) {
  if (typeof text !== 'string' || !text) return null;

  // Form 1: an explicit ISO timestamp — unambiguous, prefer it.
  const isoMatch = /resets?\b[^\n]{0,20}?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (isoMatch) {
    const d = new Date(isoMatch[1].replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) return clampReset(d, now);
  }

  // Form 2: a wall-clock time, optionally with am/pm.
  const clockMatch = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (clockMatch) {
    let hour = parseInt(clockMatch[1], 10);
    const minute = clockMatch[2] ? parseInt(clockMatch[2], 10) : 0;
    const meridiem = clockMatch[3] ? clockMatch[3].toLowerCase() : null;
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      if (hour <= 23) {
        const d = new Date(now);
        d.setHours(hour, minute, 0, 0);
        return clampReset(d, now);
      }
    }
  }
  return null;
}

/** Force a parsed reset into a sane window: strictly in the future (a time
 *  already past today means tomorrow), and never beyond LIMIT_MAX_MS. */
function clampReset(date, now = new Date()) {
  let ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  // A wall-clock time earlier than now refers to tomorrow (e.g. "resets 2am"
  // read at 11pm). Reset instants are always ahead of us.
  if (ms <= now.getTime()) ms += 24 * 60 * 60 * 1000;
  const maxMs = now.getTime() + LIMIT_MAX_MS;
  if (ms > maxMs) ms = maxMs;
  return new Date(ms);
}

/**
 * Read the fleet limit flag.
 * Returns a Date while the limit is still in effect, or null.
 * SIDE EFFECT (intended): an expired or unreadable flag is deleted, so the
 * fleet returns to Claude automatically at reset time.
 */
function readClaudeLimitFlag() {
  let raw;
  try { raw = fs.readFileSync(LIMIT_FLAG_PATH, 'utf8').trim(); }
  catch { return null; }                        // no flag = not limited

  const until = new Date(raw);
  if (!raw || Number.isNaN(until.getTime())) {
    // Corrupt flag: refuse to strand the fleet on codex forever.
    console.error(`[FAILOVER] unreadable ${LIMIT_FLAG_PATH} ("${raw}") — clearing, routing Claude normally`);
    clearClaudeLimitFlag();
    return null;
  }
  if (Date.now() >= until.getTime()) {
    console.error(`[FAILOVER] Claude limit expired at ${until.toISOString()} — clearing flag, back to Claude`);
    clearClaudeLimitFlag();
    return null;
  }
  return until;
}

/** Persist the reset instant. Returns the Date actually written. */
function writeClaudeLimitFlag(resetAt) {
  const until = resetAt instanceof Date && !Number.isNaN(resetAt.getTime())
    ? resetAt
    : new Date(Date.now() + LIMIT_FALLBACK_MS);   // parsing failed → conservative
  try {
    // Temp + rename: a concurrent dispatch must never read a half-written
    // timestamp and conclude the flag is corrupt.
    const tmp = LIMIT_FLAG_PATH + '.tmp';
    fs.writeFileSync(tmp, until.toISOString());
    fs.renameSync(tmp, LIMIT_FLAG_PATH);
  } catch (e) {
    // Even if persisting fails, this dispatch still fails over to codex —
    // we just lose the fleet-wide short-circuit for other projects.
    console.error(`[FAILOVER] could not write ${LIMIT_FLAG_PATH}: ${e.message}`);
  }
  return until;
}

function clearClaudeLimitFlag() {
  try { fs.unlinkSync(LIMIT_FLAG_PATH); } catch {}
}

/** Model the codex LAST-RESORT leg will use — resolved the same way runCodex
 *  does, so the log line never disagrees with what actually runs. */
function failoverCodexModel() {
  return project.codexModel || config.defaults?.codexModel || FAILOVER_CODEX_MODEL;
}

/** Model par défaut de codex, tel que son config.toml le déclare (clé `model`
 *  de premier niveau, avant toute section `[…]`). Sert UNIQUEMENT à tracer dans
 *  le log le model qu'utilisera codex quand on ne lui en passe pas ; null si
 *  illisible. `CODEX_HOME` est respecté comme le fait codex lui-même. */
function readCodexConfigModel() {
  const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
  try {
    const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const top = text.split(/^\s*\[/m)[0];
    const m = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(top);
    return m ? m[1] : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// NVIDIA failover cascade (codage-first) — direct OpenAI-compatible client.
// Not routed through codex: codex 0.147.0 requires the Responses API and
// NVIDIA only serves chat/completions (see top-of-file header for the full
// reasoning). This is a SINGLE-SHOT completion leg — no tool-use, no callback.
// ---------------------------------------------------------------------------

/** Cascade definition. Ordered: model N+1 is tried ONLY if model N fails.
 *  A function (not a const) so the early --test-failover gate can call it
 *  before any module-level const is initialised (no temporal-dead-zone). */
function nvidiaFailoverConfig() {
  return {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    // IDs verified live against GET /v1/models on 2026-08-31 — they are
    // namespaced (vendor/model). Keep this list in sync with the header.
    cascade: [
      'moonshotai/kimi-k3',                  // 1 — primary coder
      'deepseek-ai/deepseek-v4-pro-0813',    // 2 — strong coder
      'nvidia/nemotron-3-ultra-550b-a55b',   // 3 — large generalist
      'deepseek-ai/deepseek-v4-flash-0731',  // 4 — fast last rung
    ],
    maxTokens: 4096,
    timeoutMs: 120_000,
  };
}

/** Read NVIDIA_API_KEY from process.env first, then I:\orchestrateur\.env.
 *  NEVER logged. Returns the key string or null. */
/** Clé d'un fournisseur : environnement du parent, sinon .env (jamais affichée). */
function loadProviderKey(name) {
  if (process.env[name] && process.env[name].trim()) return process.env[name].trim();
  try {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm').exec(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

function loadNvidiaKey() {
  if (process.env.NVIDIA_API_KEY && process.env.NVIDIA_API_KEY.trim()) {
    return process.env.NVIDIA_API_KEY.trim();
  }
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*NVIDIA_API_KEY\s*=\s*(.*)$/.exec(line);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return null;
}

/**
 * One OpenAI-compatible chat/completions call to NVIDIA. Resolves (never
 * rejects) to { ok:true, text, usage, model } or { ok:false, error }.
 * The key rides the Authorization header to integrate.api.nvidia.com only.
 */
function nvidiaChat({ baseUrl, model, messages, apiKey, maxTokens, timeoutMs }) {
  return new Promise((resolve) => {
    let body;
    try { body = JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens, stream: false }); }
    catch (e) { resolve({ ok: false, error: `body: ${e.message}` }); return; }
    let req;
    try {
      req = https.request(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; if (data.length > 8_000_000) { try { req.destroy(); } catch {} } });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Truncate + collapse: upstream errors can be verbose, and we log
            // them — must never risk echoing a header/token back out.
            resolve({ ok: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 200).replace(/\s+/g, ' ')}` });
            return;
          }
          try {
            const j = JSON.parse(data);
            const text = j.choices?.[0]?.message?.content ?? '';
            resolve({ ok: true, text, usage: j.usage || null, model: j.model || model });
          } catch (e) { resolve({ ok: false, error: `parse: ${e.message}` }); }
        });
      });
    } catch (e) { resolve({ ok: false, error: `request: ${e.message}` }); return; }
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve({ ok: false, error: `timeout after ${timeoutMs}ms` }); });
    req.end(body);
  });
}

/**
 * The failover leg: walk the NVIDIA cascade, emit Claude-schema events so the
 * viewer/reducer/callback pipeline is unaffected, and exit. If the whole
 * cascade is down (or the key is missing) fall through ONCE to codex/gpt-5.6-sol
 * (OAuth, tool-use) as the absolute last resort. Terminates the process.
 */
async function runNvidiaFailover() {
  const cfg    = nvidiaFailoverConfig();
  const apiKey = loadNvidiaKey();
  const fakeSid = `nvidia-${crypto.randomUUID()}`;

  if (!apiKey) {
    console.error('[FAILOVER] NVIDIA_API_KEY not found in env or .env — last resort codex/gpt-5.6-sol');
    try {
      logStream.write(JSON.stringify({
        type: 'system', subtype: 'failover-note',
        note: 'nvidia_key_missing', to: `codex/${FAILOVER_CODEX_MODEL}`,
        timestamp: new Date().toISOString(),
      }) + '\n');
    } catch {}
    runCodex(true);
    return;
  }

  logStream.write(JSON.stringify({
    type: 'system', subtype: 'init', session_id: fakeSid,
    provider: 'nvidia', failover: true,
    model: cfg.cascade[0], cascade: cfg.cascade,
    timestamp: new Date().toISOString(),
  }) + '\n');

  const messages = [
    { role: 'system', content:
        'You are a coding assistant acting as a FAILOVER for a headless agent whose primary model is temporarily unavailable. '
      + `You are working on the project at ${project.path}. In this failover mode you CANNOT execute shell commands or edit files — `
      + 'answer with concrete, complete code and clear step-by-step instructions the operator can apply directly. Prioritise correctness.' },
    { role: 'user', content: prompt },
  ];

  for (let i = 0; i < cfg.cascade.length; i++) {
    const model = cfg.cascade[i];
    console.error(`[FAILOVER] NVIDIA cascade ${i + 1}/${cfg.cascade.length}: ${model} for ${projectName}`);
    const r = await nvidiaChat({ baseUrl: cfg.baseUrl, model, messages, apiKey, maxTokens: cfg.maxTokens, timeoutMs: cfg.timeoutMs });

    if (r.ok && r.text && r.text.trim()) {
      logStream.write(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: r.text }] },
        provider: 'nvidia', model, timestamp: new Date().toISOString(),
      }) + '\n');
      logStream.write(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false,
        result: r.text, session_id: fakeSid, num_turns: 1,
        usage: r.usage
          ? { input_tokens: r.usage.prompt_tokens ?? 0, output_tokens: r.usage.completion_tokens ?? 0 }
          : {},
        provider: 'nvidia', model, failover: true, cascade_index: i,
        timestamp: new Date().toISOString(),
      }) + '\n');
      console.error(`[FAILOVER] NVIDIA ${model} answered ${projectName} (cascade rung ${i + 1})`);
      try { fs.unlinkSync(pidPath); } catch {}
      endLogAndExit(0);
      return;
    }

    console.error(`[FAILOVER] NVIDIA ${model} failed for ${projectName}: ${r.error || 'empty response'} — advancing cascade`);
    try {
      logStream.write(JSON.stringify({
        type: 'system', subtype: 'failover-note',
        note: 'nvidia_model_failed', model,
        error: (r.error || 'empty response').slice(0, 200),
        timestamp: new Date().toISOString(),
      }) + '\n');
    } catch {}
  }

  // Every NVIDIA rung is down. One last rung — codex/gpt-5.6-sol via OAuth —
  // restores tool-use rather than losing the turn outright.
  console.error(`[FAILOVER] entire NVIDIA cascade failed for ${projectName} — last resort codex/${FAILOVER_CODEX_MODEL}`);
  try {
    logStream.write(JSON.stringify({
      type: 'system', subtype: 'failover-note',
      note: 'nvidia_cascade_exhausted', to: `codex/${FAILOVER_CODEX_MODEL}`,
      timestamp: new Date().toISOString(),
    }) + '\n');
  } catch {}
  runCodex(true);
}

/**
 * Self-test for the NVIDIA leg. Hits the live endpoint but touches NO project
 * log / sidecar / pid file and NEVER sets the limit flag. Exits 0 if at least
 * one probed model answered, 1 otherwise. Never prints the key.
 */
async function runFailoverSelfTest() {
  const cfg    = nvidiaFailoverConfig();
  const apiKey = loadNvidiaKey();
  console.error('[test-failover] NVIDIA failover self-test — no project logs touched, no limit flag set');
  if (!apiKey) { console.error('[test-failover] FAIL: NVIDIA_API_KEY not found in env or .env'); process.exit(1); }
  console.error(`[test-failover] key loaded (length=${apiKey.length}); cascade = ${cfg.cascade.join(' -> ')}`);

  // Default: probe only the primary (kimi-k3) — enough to prove the leg.
  // --test-failover-all walks every rung so an operator can check the lot.
  // maxTokens is generous: several cascade models are REASONING models that
  // spend hidden tokens before emitting visible content — a tiny cap makes
  // them return empty (finish_reason "length"), which is a false negative.
  const all = process.argv.includes('--test-failover-all');
  const models = all ? cfg.cascade : [cfg.cascade[0]];
  const messages = [{ role: 'user', content: 'Reply with the single word PONG and nothing else.' }];

  let anyOk = false;
  for (const model of models) {
    const t0 = Date.now();
    const r = await nvidiaChat({ baseUrl: cfg.baseUrl, model, messages, apiKey, maxTokens: 256, timeoutMs: 90_000 });
    const ms = Date.now() - t0;
    const text = (r.text || '').trim();
    // Match the real leg: ok transport + empty content counts as a failure.
    if (r.ok && text) { anyOk = true; console.error(`[test-failover] OK   ${model} (${ms}ms): ${JSON.stringify(text.slice(0, 40))}`); }
    else               console.error(`[test-failover] FAIL ${model} (${ms}ms): ${r.ok ? 'empty content' : r.error}`);
  }
  process.exit(anyOk ? 0 : 1);
}

// ---------- musicien occupé ⇒ file, jamais un second --resume ---------------
//
// Deux `claude --resume` sur la même session, c'est au mieux deux tours qui
// s'écrasent, au pire une session corrompue. Le serveur possède déjà une file
// par musicien (`dispatchQueue`) : on la lui confie plutôt que de spawner.
// Serveur injoignable ⇒ ancien comportement + avertissement explicite : la
// file est un confort, pas un point de panne.

function pidAliveFor(name) {
  const p = path.join(LOGS, `${name}.pid`);
  try {
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > 12 * 60 * 60 * 1000) return null;   // sidecar périmé
    const pid = Number(fs.readFileSync(p, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return pid; }
    catch (e) { return e.code === 'EPERM' ? pid : null; }
  } catch { return null; }
}

function postQueueIfBusy() {
  return new Promise((resolve) => {
    let token;
    try { token = fs.readFileSync(path.join(ROOT, '.token'), 'utf8').trim(); }
    catch { return resolve(null); }
    const payload = { project: projectName, prompt, queueIfBusy: true };
    if (callbackProject)   payload.callback = callbackProject;
    if (sourceProject)     payload.source   = sourceProject;
    if (modelOverride)     payload.model    = modelOverride;
    if (providerOverride)  payload.provider = providerOverride;
    // --new-session voyage avec l'entrée de file : il prendra effet au lancement.
    if (NEW_SESSION)       payload.newSession = true;
    // L'origine (quel tour de chef attend ce résultat) voyage avec l'entrée de
    // file : une demande qui patiente ne doit pas perdre à qui elle répond.
    if (CHEF_SLOT != null) payload.slot   = CHEF_SLOT;
    if (CHEF_TICKET)       payload.ticket = CHEF_TICKET;
    if (imagePaths.length) payload.attachmentPaths = imagePaths;
    if (videoPaths.length) payload.videoPaths      = videoPaths;
    // Déjà observée ici : le serveur ne la compte pas une seconde fois.
    if (obsId)             payload.obsId           = obsId;
    // Mode double : la demande garde ses deux models en file d'attente.
    if (secondModel)       payload.secondModel     = secondModel;
    if (secondProvider)    payload.secondProvider  = secondProvider;
    if (secondModel)       payload.dualMode        = dualMode;
    // Pipelines (0.48.0) : la demande garde son pipeline en file d'attente.
    if (pipelineArg)       payload.pipeline        = pipelineArg;
    if (pipelineResumeArg) payload.pipelineResume  = pipelineResumeArg;
    if (horsPipelineArg != null) payload.horsPipeline = horsPipelineArg;
    if (pipelineModeArg)   payload.pipelineMode    = pipelineModeArg;
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request({
      hostname: '127.0.0.1', port: 7777, path: '/api/dispatch', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orchestrator-Token': token,
        'Content-Length': body.length,
      },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 202 && res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { try { req.destroy(); } catch {} resolve(null); });
    req.end(body);
  });
}

// ---------- pipelines, phase 1 : observation (0.41.0) ------------------------
//
// Toute entrée est classée (pipeline + mode) et journalisée, SANS rien changer
// au tour. Lancé par le serveur, l'entrée est déjà observée (ORCH_OBS_ID).
// La variable est retirée de l'environnement : sinon l'outil Bash du tour en
// hériterait et les dispatches que le chef lance ne seraient plus observés.
const OBS_ID_FROM_SERVER = process.env.ORCH_OBS_ID || '';
delete process.env.ORCH_OBS_ID;
let obsId = OBS_ID_FROM_SERVER;
if (!obsId) {
  try {
    const obs = await import('./pipeline-observe.mjs');
    const rec = obs.createObserver({ logsDir: LOGS }).record({
      entry: 'dispatch-cli', project: projectName, text: prompt,
      caller: obs.projectFromCwd(process.cwd(), config.projects) || 'humain/script',
      extra: { fromAgent: !!process.env.CLAUDECODE },
    });
    obsId = rec.id;
  } catch { /* l'observation ne bloque jamais un dispatch */ }
}

if (queueIfBusy && projectName !== CONDUCTOR) {
  const busyPid = pidAliveFor(projectName);
  if (busyPid) {
    const r = await postQueueIfBusy();
    if (r?.queued) {
      console.log(`[dispatch] ${projectName} a un tour en cours — mis en file derrière lui (position ${r.position ?? r.queueLength})`);
      process.exit(0);
    }
    if (r?.direct) {
      console.log(`[dispatch] ${projectName} s'est libéré — lancé par le serveur (pid=${r.pid})`);
      process.exit(0);
    }
    console.error(`[dispatch] ATTENTION : ${projectName} a un tour en cours (pid=${busyPid}) et le serveur est injoignable — dispatch direct malgré tout`);
  }
}

// ---------- pipelines (0.48.0) : délégation au moteur -------------------------
// Ici, après la file (comme le mode double) : un musicien occupé a reçu la
// demande en file, avec son pipeline, et ce processus est déjà sorti.
let pipelineBypass = null;   // trace d'un tour qui ne passe PAS par un pipeline
if (horsPipelineArg != null && !PIPE_STEP) {
  pipelineBypass = { reason: String(horsPipelineArg).replace(/\s+/g, ' ').trim().slice(0, 300), by: 'hors-pipeline', enforced: ENFORCED };
}
if (!PIPE_STEP && !DUAL_BRANCH && !dualSynthesis && (pipelineArg || pipelineResumeArg || AUTO_PIPELINE)) {
  let pipe = pipelineArg, resumeRun = pipelineResumeArg, classification = null, mode = pipelineModeArg;
  if (!pipe && !resumeRun) {
    // Réponse « continuer » à une exécution en pause : on la reprend.
    const paused = latestPausedRun(projectName);
    const reply = prompt.replace(/^\s*\[CHEF_ANSWER\]\s*/i, '').trim();
    if (paused && /^(continue|continuer|reprends|reprendre|on continue|oui|go|vas-y)\b/i.test(reply)) resumeRun = paused;
    // Les autres choix proposés par la pause font vraiment quelque chose.
    const answer = !paused ? null
      : /^(abandonner|abandonne|abandon|annuler|annule|arr[eê]te)\b/i.test(reply) ? 'abandonner'
      : /^simplifi/i.test(reply) ? 'simplifier'
      : /^changer?\s+(de\s+|le\s+)?mod[eè]le?/i.test(reply) ? 'changer le model' : null;
    if (answer) {
      process.exit(await pipeEngine.answerPausedRun({ logsDir: LOGS, project, projectName, run: paused, answer, promptForLog: prompt, sourceProject, callbackProject, testLabel }));
    }
  }
  if (!pipe && !resumeRun) {
    const obs = await import('./pipeline-observe.mjs');
    const c = obs.classify({ text: prompt });
    classification = { pipeline: c.pipeline, mode: c.mode, confidence: c.confidence, classifier: obs.CLASSIFIER, unclassifiable: !!c.unclassifiable };
    if (ENFORCEMENT.pipelines.includes(c.pipeline)) {
      pipe = c.pipeline;
      if (!mode) mode = c.mode;
    } else {
      pipelineBypass = { reason: `pipeline « ${c.pipeline} » pas encore en service (phase 3 : ${ENFORCEMENT.pipelines.join(', ')})`, by: 'hors-perimetre', classification, enforced: true };
    }
  }
  // --pipeline dev sans --mode : la classification choisit (Q9 : hésitation → léger).
  if (pipe === 'dev' && !mode) mode = (await import('./pipeline-observe.mjs')).classify({ text: `/dev ${prompt}` }).mode;
  if (pipe || resumeRun) {
    const code = await pipeEngine.runPipeline({
      root: ROOT, logsDir: LOGS, project, projectName,
      prompt: imagePaths.length || videoPaths.length
        ? `${prompt}\n\nPièces jointes (à lire avec l'outil Read) :\n${[...imagePaths, ...videoPaths].map(p => `- ${p}`).join('\n')}`
        : prompt,
      promptForLog: prompt, pipeline: pipe, resumeRun, classification, mode,
      callbackProject, sourceProject, obsId, testLabel,
      dispatchScript: fileURLToPath(import.meta.url),
    });
    process.exit(code);
  }
}

/** Dernière exécution EN PAUSE de ce projet (logs/runs/<run>/run.json), ou null. */
function latestPausedRun(name) {
  try {
    const dir = path.join(LOGS, 'runs');
    const runs = fs.readdirSync(dir).filter(r => /^p-\d{8}T\d{6}-[a-z0-9]{4,8}$/.test(r)).sort().reverse();
    for (const r of runs.slice(0, 50)) {
      let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, r, 'run.json'), 'utf8')); } catch { continue; }
      if (s.project !== name) continue;
      return s.status === 'paused' ? r : null;
    }
  } catch { /* aucun dossier */ }
  return null;
}

// ---------- mode double model (0.44.0) : délégation à dual-run.mjs ------------
// Ici, après la file : un musicien occupé a reçu la demande en file (avec ses
// deux models) et ce processus est déjà sorti. Dans une étape de pipeline, le
// mode double écrit dans le log de l'étape et sa relecture garde le jeton.
if (secondModel && !DUAL_BRANCH && !dualSynthesis) {
  const { runDual } = await import('./dual-run.mjs');
  const code = await runDual({
    root: ROOT, logsDir: LOGS, config, project, projectName, prompt, promptForLog: prompt,
    imagePaths, videoPaths,
    principal: { model: modelOverride, provider },
    second: { model: secondModel, provider: secondProvider || null },
    mode: dualMode, callbackProject, sourceProject, obsId,
    dispatchScript: fileURLToPath(import.meta.url),
    ...(PIPE_STEP ? {
      logFile: logPath, pidFile: pidPath, sessionFile: sessionPath,
      synthesisArgs: ['--pipeline-step', `${PIPE_STEP.run}:${PIPE_STEP.key}`, ...(pipelineSession ? ['--pipeline-session', pipelineSession] : [])],
      childEnvExtra: STEP_TOKEN ? { ORCH_STEP_TOKEN: STEP_TOKEN } : {},
      stepPrompt: true,
    } : {}),
  });
  process.exit(code);
}

// ---------- --new-session : archivage de la session courante -----------------
// ICI et pas plus tôt : si le musicien était occupé, la demande vient de
// partir en file (avec newSession) et ce processus est déjà sorti — rien ne
// doit être archivé avant que le tour ne tourne vraiment. Seulement pour
// claude : codex n'a pas de session, archiver ferait repartir à zéro le
// PROCHAIN tour claude sans que personne ne l'ait demandé.
let archivedSession = null;
if (NEW_SESSION && provider === 'claude') {
  if (sessionId) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    archivedSession = `${sessionPath}.bak-${stamp}`;
    try {
      fs.renameSync(sessionPath, archivedSession);
      console.log(`[dispatch] --new-session : session ${sessionId} archivée → ${path.basename(archivedSession)}`);
    } catch (e) {
      die(`--new-session : archivage de ${sessionPath} impossible (${e.message}) — tour annulé plutôt que de reprendre l'ancienne session`, 66);
    }
  }
  sessionId = null;          // ⇒ pas de --resume : le CLI ouvre une session neuve
} else if (NEW_SESSION) {
  console.log(`[dispatch] --new-session ignoré avec --provider ${provider} (pas de session à reprendre)`);
}

// ---------- règle de fin de tour : pas d'attente sur l'arrière-plan (0.24.1) --
//
// Un tour `claude -p` se termine au `result` et ses tâches d'arrière-plan sont
// TUÉES avec lui (`system/task_notification` status "stopped"). Deux musiciens
// ont fini leur tour sur « je reprends dès que le banc/le déploiement se
// termine » (TranslateOverlay, vuBox, 25/09) : le process est mort, personne
// n'a repris, et la notification résiduelle a en plus produit un result
// fantôme au tour suivant. La consigne s'ajoute à tout dispatch de musicien
// (pas au chef : c'est un routeur, il ne lance pas ce genre de process).
function backgroundRule(notifyTo) {
  const notifyPath = path.join(ROOT, 'scripts', 'notify.mjs');
  return `\n\n---\nRÈGLE DE FIN DE TOUR : ton tour s'arrête à ta dernière réponse et toute tâche d'arrière-plan ` +
    `(run_in_background, « & », Start-Job) est alors TUÉE — personne ne reprendra « quand elle aura fini ». ` +
    `Ne termine donc JAMAIS un tour en comptant sur un process d'arrière-plan. Soit tu l'exécutes en ` +
    `avant-plan et tu attends son résultat dans ce tour ; soit, s'il est trop long, tu le lances réellement ` +
    `DÉTACHÉ (PowerShell : Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments ` +
    `@{CommandLine='cmd /c <ta commande> > <log> 2>&1 & node "${notifyPath}" ${notifyTo} "<projet> : <tâche> terminée, voir <log>" --source ${projectName}'}) ` +
    `pour qu'il prévienne lui-même « ${notifyTo} » à la fin — et tu le dis explicitement dans ta réponse.`;
}

// ---------- règle des exigences utilisateur (0.36.0) ------------------------
//
// Règle utilisateur, pour toute la flotte : « à partir du moment où je fais une
// demande spécifique à propos d'une fonctionnalité, il faut rajouter un test de
// non-régression pour plus tard ». Même mécanisme que la règle de fin de tour :
// dans le prompt de chaque musicien, jamais dans le texte affiché.
function userRequirementsRule() {
  return `\n\n---\nRÈGLE DES EXIGENCES UTILISATEUR : toute demande de l'utilisateur concernant une fonctionnalité ` +
    `(comportement voulu, réglage, correction signalée) doit être protégée par un TEST AUTOMATISÉ ajouté à la ` +
    `suite de non-régression du projet, rejouée à chaque évolution, et tracée dans docs/USER_REQUIREMENTS.md ` +
    `(date, demande verbatim, test associé). Crée ce fichier et la suite s'ils n'existent pas. Avant toute ` +
    `modification, rejoue cette suite ; après, rejoue-la et signale tout échec. Un test d'exigence utilisateur ne ` +
    `peut être ni supprimé ni affaibli sans l'accord explicite de l'utilisateur (demande-le par NEEDS_USER_INPUT).`;
}

// ---------- commandes simples (0.37.0) ---------------------------------------
//
// En mode non interactif, l'analyse de sécurité du CLI refuse sans recours les
// commandes PowerShell qu'elle ne sait pas valider (91 refus relevés sur la
// flotte : opérations multiples, $( ), script, .NET…). Autoriser l'outil n'y
// change rien : on réduit la source.
function simpleCommandsRule() {
  return `\n\n---\nCOMMANDES : préfère l'outil Bash, ou des commandes PowerShell simples — une commande par appel, ` +
    `sans sous-expression $( ), ni tableau @( ), ni bloc de script { }, ni chemin calculé, ni appel .NET. ` +
    `Sinon le CLI refuse l'appel en mode non interactif, sans recours possible.`;
}

// ---------- callback injection ----------------------------------------------

// promptForLog = original prompt shown in the viewer (no boilerplate).
// prompt       = what actually reaches claude (with injected callback instruction).
const promptForLog = prompt;
if (callbackProject) {
  // 0.37.2 — le résumé passe par un FICHIER. L'ancienne consigne (variable
  // shell multi-ligne RESUME="…" puis printf | node notify.mjs --stdin) était
  // refusée par l'analyse de sécurité du CLI en mode non interactif, et le
  // texte long tombait en plus sur la limite de 2 Ko de /api/notify (500).
  // Write dans le dossier du projet (toujours autorisé), puis une commande
  // simple ; notify.mjs supprime le fichier après l'envoi.
  const notifyPath = path.join(ROOT, 'scripts', 'notify.mjs').replace(/\\/g, '/');
  const cbFile = path.join(project.path, '.orchestrateur-callback.md').replace(/\\/g, '/');
  prompt = prompt + `\n\n---\nUne fois ta tâche terminée — ou si tu as un point important à signaler en cours de route — envoie un résumé au projet « ${callbackProject} » en DEUX étapes, sans variable shell, heredoc, printf ni pipe (le CLI refuse ces commandes) :\n\n  1. Écris le résumé complet (markdown, tableaux et accents permis, pas de limite de taille gênante) avec l'outil Write dans le fichier :\n     ${cbFile}\n  2. Lance exactement cette commande Bash :\n     node "${notifyPath}" ${callbackProject} --file "${cbFile}" --source ${projectName}\n\nnotify.mjs supprime le fichier après l'envoi (ne le commite pas). Adapte le contenu au contexte : ce que tu as accompli, découvert, ou la question que tu poses.`;
}
// Seul `prompt` (ce que reçoit claude) porte la règle ; `promptForLog` reste le
// texte d'origine, donc le fil et le panneau n'affichent pas ce bloc.
if (projectName !== CONDUCTOR) prompt = prompt + backgroundRule(callbackProject || CONDUCTOR);
if (projectName !== CONDUCTOR) prompt = prompt + userRequirementsRule();
if (projectName !== CONDUCTOR) prompt = prompt + simpleCommandsRule();

// ---------- env scrub -------------------------------------------------------

const env = { ...process.env };
// Subscription/OAuth auth only — NEVER forward a provider API key to a child.
// Claude rides the Max/Pro OAuth session (~/.claude/), codex rides its own
// OAuth login (`codex login`). Forwarding a key would silently move billing
// off the subscription. Guards anthropics/claude-code#39903.
delete env.ANTHROPIC_API_KEY;
delete env.OPENAI_API_KEY;
// The NVIDIA key is used ONLY by our own https client (runNvidiaFailover),
// sent ONLY to integrate.api.nvidia.com. It must never reach a child process
// (a codex last-resort spawn rides its own OAuth). loadNvidiaKey reads it from
// the parent process.env / .env, so scrubbing the child copy is harmless here.
delete env.NVIDIA_API_KEY;
// Même règle pour la clé OpenRouter (0.43.0) : seuls nos modules la lisent,
// depuis .env ; aucun fils (claude, codex) n'en hérite.
delete env.OPENROUTER_API_KEY;
// Un dispatch lancé PAR ce tour n'est pas un essai : le marquage ne se transmet pas.
delete env.ORCH_TEST_LABEL;
// Pipelines (0.48.0) : le tour sait de quel projet il est, et s'il est une
// étape. Un dispatch.mjs lancé depuis ce tour est jugé là-dessus (refus).
env.ORCH_TURN_PROJECT = projectName;
if (PIPE_STEP || STEP_GRANT) env.ORCH_TURN_STEP = PIPE_STEP ? `${PIPE_STEP.run}:${PIPE_STEP.key}` : `${STEP_GRANT.run}:${STEP_GRANT.key}`;
else delete env.ORCH_TURN_STEP;
delete env.ORCH_STEP_TOKEN;

// ---------- shared log setup ------------------------------------------------

const logStream = fs.createWriteStream(logPath, { flags: 'a' });
logStream.write(`\n`); // ensure boundary from previous turn

/**
 * Close the log and exit — WAITING for the buffered writes to reach disk.
 *
 * `process.exit()` does not flush pending WriteStream data. Calling it right
 * after `logStream.end()` silently truncated whatever was written in the last
 * few milliseconds of the turn: the synthetic `result`, and — worse — the
 * entire `failover` audit trail plus the codex output, since those are all
 * emitted immediately before exit. Observed in testing: the turn ran, the
 * console showed [FAILOVER], and the JSONL held nothing.
 *
 * We therefore exit from the stream's finish callback, with a 2 s ceiling so
 * a wedged stream can never hang a dispatch.
 */
function endLogAndExit(code) {
  let exited = false;
  const go = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  // Deliberately NOT unref'd: the timer must hold the event loop open long
  // enough for the flush to land, otherwise Node would exit 0 on its own.
  const guard = setTimeout(go, 2000);
  try { logStream.end(() => { clearTimeout(guard); go(); }); }
  catch { clearTimeout(guard); go(); }
}

// Synthetic "user_prompt" event so the viewer can show what was asked before
// any real stream-json event arrives.
const userPromptEvent = { type: 'user_prompt', text: promptForLog, timestamp: new Date().toISOString() };
if (imagePaths.length) userPromptEvent.attachmentPaths = imagePaths;
if (sourceProject) userPromptEvent.source = sourceProject;
// CALLBACK WAKE (0.20.0) — record the EXPECTATION, additively.
//
// `--callback <chef>` already tells the musician "report back to chef" by
// injecting prose into its prompt (below), but nothing ever recorded that the
// chef is *waiting*. Stamping it on the turn's opening event makes the
// expectation durable (it lives in the musician's own log, so it survives a
// server restart) and unambiguous (it belongs to THIS turn, not to the project).
// The server's watcher reads it back to decide whether a finished turn should
// wake the chef for a synthesis.
if (callbackProject) userPromptEvent.callback = callbackProject;
// Wake generation of the turn that spawned us. A chef turn started BY a wake
// runs with DISPATCH_WAKE_GEN=n in its environment; its Bash tool inherits it,
// so any dispatch.mjs the chef launches from that turn stamps the same n here.
// Past WAKE_MAX_GEN the watcher wakes in report-only mode, whose dispatches
// are refused above — that is the anti-loop bound, carried by the data.
const inheritedWakeGen = Number(process.env.DISPATCH_WAKE_GEN || 0);
if (Number.isFinite(inheritedWakeGen) && inheritedWakeGen > 0) {
  userPromptEvent.wakeGen = inheritedWakeGen;
}
// Diagnostic en une ligne : le tour de chef dit lui-même qu'il est en rapport seul.
if (POOL_ASSIGN && process.env.DISPATCH_REPORT_ONLY === '1') userPromptEvent.reportOnly = true;
if (testLabel) userPromptEvent.test = { label: testLabel };
// Trace du --new-session : ce tour ne reprend PAS la session précédente.
if (NEW_SESSION && provider === 'claude') {
  userPromptEvent.newSession = true;
  if (archivedSession) userPromptEvent.archivedSession = path.basename(archivedSession);
}
// POOL (0.22.0) — stampage d'origine, même mécanisme que wakeGen.
//
// Deux cas, distingués par la CIBLE et non par une seconde variable :
//   · cible = le chef  ⇒ ce tour EST la consommation d'un ticket de la file :
//     on stampe `ticket`/`slot`. C'est le log qui prouve « pris par CHEF n »,
//     jamais la réponse HTTP.
//   · cible = un musicien ⇒ `DISPATCH_SLOT`/`DISPATCH_TICKET` ont été hérités
//     de l'env du chef via son outil Bash : c'est le tour de chef qui ATTEND
//     ce résultat. On stampe `callbackSlot`/`callbackTicket` pour que le point
//     revienne au bon chef (exploité en P0-B).
if (CHEF_SLOT != null) {
  if (projectName === CONDUCTOR) {
    userPromptEvent.slot = CHEF_SLOT;
    if (CHEF_TICKET) userPromptEvent.ticket = CHEF_TICKET;
  } else {
    userPromptEvent.callbackSlot = CHEF_SLOT;
    if (CHEF_TICKET) userPromptEvent.callbackTicket = CHEF_TICKET;
  }
}
// Mode double : une branche trace son rôle ; la relecture prolonge le tour que
// le parent a ouvert (pas de second user_prompt, un seul tour au journal).
if (DUAL_BRANCH) userPromptEvent.dual = { run: DUAL_BRANCH.run, role: DUAL_BRANCH.role, model, provider, modelSource: STEP_GRANT ? 'pipeline' : EXPLICIT_MODEL ? 'flag' : 'project' };
// Traçabilité par étape (plan §3.1) : exécution, étape, model et sa source.
if (PIPE_STEP) userPromptEvent.pipelineStep = { run: PIPE_STEP.run, key: PIPE_STEP.key, model, provider, modelSource: EXPLICIT_MODEL ? 'pipeline' : 'project-default' };
// Tour hors pipeline : la raison est écrite, donc visible (décision n° 1).
if (pipelineBypass) userPromptEvent.pipelineBypass = pipelineBypass;
if (dualSynthesis) {
  logStream.write(JSON.stringify({
    type: 'system', subtype: 'dual_review_start', dual: { run: dualSynthesis, role: 'relecture' },
    model, provider, modelSource: EXPLICIT_MODEL ? 'flag' : 'project',
    text: `relecture par le principal ${model}`, timestamp: new Date().toISOString(),
  }) + '\n');
} else {
  logStream.write(JSON.stringify(userPromptEvent) + '\n');
  if (pipelineBypass) {
    logStream.write(JSON.stringify({ type: 'system', subtype: 'pipeline_bypass', ...pipelineBypass,
      text: `hors pipeline : ${pipelineBypass.reason}`, timestamp: new Date().toISOString() }) + '\n');
  }
}

/**
 * Échec d'un tour à model EXPLICITE (règle « aucun fallback »). Écrit la
 * décision (system/fallback_refused) puis un result is_error qui clôt le tour.
 * Volontairement PAS `synthetic` : un result synthétique est traité comme
 * « clos par le système » et n'émet ni notification ni réveil — or le chef
 * DOIT recevoir ce ✕. `model_unavailable` sert au serveur à ne pas drainer la
 * file tout de suite derrière (le balayage de secours le fera, jamais sous
 * limite). `duration_api_ms` est omis exprès : ce result ne doit jamais
 * ressembler à un « result fantôme » (0 tour / 0 ms).
 */
/** Marqueur posé par kill-stalled.mjs juste avant de tuer ce tour. Consommé. */
function killedByConductor(since) {
  const p = path.join(LOGS, `${projectName}.killed`);
  try {
    const st = fs.statSync(p);
    fs.unlinkSync(p);
    return st.mtimeMs >= since - 1000;
  } catch { return false; }
}

/** « 5 min 03 s », « 42 s ». */
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')} s` : ''}` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/**
 * Échec d'un fournisseur, lisible tel quel (0.47.2) : « ✕ échec : NVIDIA 504
 * après 5 min », plutôt qu'un message brut ou, pire, un « processus perdu ».
 * La durée vient de la passerelle quand elle la donne (« après 5 min 00 s »),
 * sinon c'est la durée du tour.
 */
function providerFailureText(label, msg, elapsedMs) {
  const s = String(msg || '');
  const code = (/\bHTTP (\d{3})\b/.exec(s) || /\b(4\d\d|5\d\d)\b/.exec(s) || [])[1];
  const after = (/après (\d+ (?:min|s|h)[^—)\n]*)/.exec(s) || [])[1];
  const when = after ? after.trim() : fmtDur(elapsedMs);
  if (code) return `✕ échec : ${label} ${code} après ${when}`;
  const short = s.replace(/\s+/g, ' ').trim().slice(0, 160);
  return `✕ échec : ${label}${short ? ` — ${short}` : ''} (après ${when})`;
}

let explicitFailed = false;
function failExplicitModel(reason, extra = {}) {
  if (explicitFailed) return;
  explicitFailed = true;
  const { headline, ...rest } = extra;
  extra = rest;
  const cause = `${headline ? `${headline} — ` : ''}model demandé ${EXPLICIT_MODEL} indisponible : ${reason} — aucun fallback (règle utilisateur)`;
  console.error(`[dispatch] fallback refusé : model explicite ${EXPLICIT_MODEL} — ${reason}`);
  try {
    logStream.write(JSON.stringify({
      type: 'system', subtype: 'fallback_refused',
      model_requested: EXPLICIT_MODEL, provider, reason, ...extra,
      text: `fallback refusé : model explicite ${EXPLICIT_MODEL}`,
      timestamp: new Date().toISOString(),
    }) + '\n');
    logStream.write(JSON.stringify({
      type: 'result', subtype: 'error_model_unavailable', is_error: true,
      model_unavailable: true, model_requested: EXPLICIT_MODEL, provider,
      result: cause, num_turns: 0,
      ...(sessionId ? { session_id: sessionId } : {}),
      timestamp: new Date().toISOString(),
    }) + '\n');
  } catch {}
  try { fs.unlinkSync(pidPath); } catch {}
  endLogAndExit(1);
}

/**
 * codex ne dit PAS dans son flux --json quel model il a servi. Sa « rollout »
 * (~/.codex/sessions/AAAA/MM/JJ/rollout-…-<thread_id>.jsonl) le consigne : on
 * la relit après le tour. Résultat : ok=true (que le model demandé), ok=false
 * + served (un autre model a servi), ok=null + why (introuvable / pas de champ
 * model — rien n'est prouvé, on le journalise sans faire échouer le tour).
 * Les sous-threads (ex. `guardian` en codex-auto-review) ont leur propre
 * fichier : ils ne sont pas confondus avec le thread principal.
 */
function verifyCodexRollout(threadId, requested, codexHome) {
  if (!threadId) return { ok: null, why: 'thread_id inconnu (codex n’a pas émis thread.started)' };
  const home = codexHome || process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
  const days = new Set();
  for (const back of [0, 1]) {
    const d = new Date(Date.now() - back * 86_400_000);
    for (const [y, m, dd] of [[d.getFullYear(), d.getMonth() + 1, d.getDate()], [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]]) {
      days.add(path.join(home, 'sessions', String(y), String(m).padStart(2, '0'), String(dd).padStart(2, '0')));
    }
  }
  let file = null;
  for (const dir of days) {
    try {
      const hit = fs.readdirSync(dir).find(f => f.endsWith(`-${threadId}.jsonl`));
      if (hit) { file = path.join(dir, hit); break; }
    } catch { /* jour absent */ }
  }
  if (!file) return { ok: null, why: `rollout du thread ${threadId} introuvable` };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: null, why: `rollout illisible : ${e.message}` }; }
  const served = [...new Set([...text.matchAll(/"model"\s*:\s*"([^"]+)"/g)].map(m => m[1]))];
  if (!served.length) return { ok: null, why: 'aucun champ model dans la rollout', file };
  const other = served.find(s => !modelMatches(requested, s));
  return other ? { ok: false, served: other, file } : { ok: true, served: served[0], file };
}

/** Tue l'arbre d'un processus fils (Windows : taskkill /T /F, comme le serveur). */
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

// ============================================================================
// PROVIDER BRANCH
// ============================================================================

/**
 * Run the turn through the OpenAI Codex CLI.
 *
 * @param {boolean} isFailover  true when reached from the Claude failover
 *        path. Only changes logging, the default model, and the exit
 *        behaviour on failure — there is NO second failover level.
 */
function runCodex(isFailover = false) {

  // ── Codex path ─────────────────────────────────────────────────────────────
  //
  // The OpenAI Codex CLI (@openai/codex) has its own non-interactive mode,
  // `codex exec --json`, whose event schema is NOT Claude's stream-json. We
  // run it and translate every event into the Claude schema (see the mapper
  // below) so the rest of the pipeline (chokidar → SSE → Musician state
  // machine → fleet-status) is unaffected.
  //
  // Limitations vs Claude:
  //   • No session continuity. `codex exec resume <thread_id>` exists but is
  //     not wired up; each turn is independent.
  //   • Auth is codex's own OAuth (`codex login`, ~/.codex/auth.json).
  //     No API key is forwarded — both ANTHROPIC_API_KEY and OPENAI_API_KEY
  //     are scrubbed from the child env.

  /**
   * Locate the codex CLI and return how to spawn it: { cmd, prefixArgs }.
   *
   * WHY THIS IS NOT JUST "return 'codex.cmd'":
   * Since the BatBadBut fix (Node ≥18.20.2/20.12/21.7, and every Node 24),
   * `spawn()` with `shell: false` THROWS EINVAL on a `.cmd`/`.bat` target.
   * The previous implementation returned `codex.cmd` (or a bare `codex`
   * PATH lookup that resolves to `.cmd` via PATHEXT), so the codex path
   * could not start at all on this machine — the failover would have died
   * on an uncaught EINVAL at the exact moment it was needed.
   *
   * Resolution order, safest first:
   *   1. CODEX_BIN — explicit operator override (test stubs use this).
   *   2. The package's own `codex.js`, run as `node codex.js`. Argv stays an
   *      array, no shell is involved, so nothing in the prompt can be
   *      interpreted as a command. This is the path we want.
   *   3. A real `codex.exe` — also spawnable directly.
   *   4. `.cmd` wrapper via cmd.exe — last resort, see the note below.
   *
   * npm bin dirs are discovered from PATH as well as the usual locations,
   * because a custom npm prefix (here: I:\npm-global) is invisible to a
   * hardcoded %APPDATA%\npm list.
   */
  function resolveCodexBin() {
    const fromEnv = process.env.CODEX_BIN;
    if (fromEnv) return classifyCodexBin(fromEnv);
    if (process.platform !== 'win32') return { cmd: 'codex', prefixArgs: [] };

    // Candidate npm bin directories, in priority order.
    const dirs = [];
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) {
      dirs.push(path.join(home, 'AppData', 'Roaming', 'npm'), path.join(home, '.local', 'bin'));
    }
    for (const p of (process.env.PATH || '').split(path.delimiter)) {
      if (p && p.trim()) dirs.push(p.trim());
    }
    try {
      for (const u of fs.readdirSync('C:\\Users', { withFileTypes: true })) {
        if (!u.isDirectory()) continue;
        if (u.name === 'Public' || u.name === 'Default' || u.name.startsWith('All ')) continue;
        dirs.push(`C:\\Users\\${u.name}\\AppData\\Roaming\\npm`);
      }
    } catch {}

    const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

    // Pass 1 — the JS entry point (safest).
    for (const d of dirs) {
      const js = path.join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (isFile(js)) return { cmd: process.execPath, prefixArgs: [js] };
    }
    // Pass 2 — a native executable.
    for (const d of dirs) {
      const exe = path.join(d, 'codex.exe');
      if (isFile(exe)) return { cmd: exe, prefixArgs: [] };
    }
    // Pass 3 — the .cmd shim.
    for (const d of dirs) {
      const cmdFile = path.join(d, 'codex.cmd');
      if (isFile(cmdFile)) return classifyCodexBin(cmdFile);
    }
    return { cmd: 'codex', prefixArgs: [] };
  }

  /** Turn an explicit binary path into a safe spawn descriptor. */
  function classifyCodexBin(bin) {
    if (/\.(mjs|js|cjs)$/i.test(bin)) return { cmd: process.execPath, prefixArgs: [bin] };
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
      // LAST RESORT. A batch shim cannot be spawned directly (EINVAL), so it
      // must go through cmd.exe. `/d /s /c` plus wrapping the whole command
      // line in one extra pair of quotes is the documented-safe form, and
      // windowsVerbatimArguments stops Node from re-quoting on top of ours.
      // Prefer the .js route above whenever it exists — the prompt is
      // attacker-shaped text and we do not want it near a command line.
      return { cmd: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', bin], viaCmd: true };
    }
    return { cmd: bin, prefixArgs: [] };
  }

  const codexBinInfo = resolveCodexBin();
  // Choix du model (0.25.1). Avant : `… || 'gpt-4o'` codé en dur — sans
  // codexModel configuré (le cas du poste), tout dispatch codex partait sur
  // gpt-4o, en ignorant `--model` ET le défaut de ~/.codex/config.toml.
  //   · tour codex demandé : --model > project.codexModel > defaults.codexModel
  //     > rien (codex lit alors SON config.toml) ;
  //   · leg de failover : INCHANGÉ — codexModel configuré > FAILOVER_CODEX_MODEL.
  //     Le `--model` d'un dispatch Claude qui bascule en failover est un model
  //     Claude : il ne doit jamais atteindre codex.
  // Harnais (0.47.0) : NVIDIA et OpenRouter tournent DANS codex, avec leur
  // fournisseur déclaré par -c model_providers.* (NVIDIA via la passerelle du
  // serveur, qui traduit Responses → chat/completions ; OpenRouter en direct).
  const harness = !isFailover && HARNESS_PROVIDER ? provider : null;
  const runLabel = harness || 'codex';
  const { model: codexModel, source: codexModelSource } = isFailover
    ? (project.codexModel || config.defaults?.codexModel
        ? { model: project.codexModel || config.defaults.codexModel, source: project.codexModel ? 'project' : 'defaults' }
        : { model: FAILOVER_CODEX_MODEL, source: 'failover' })
    : modelOverride          ? { model: modelOverride,              source: 'flag' }
    : harness                ? { model: project[`${harness}Model`], source: 'project' }   // jamais codexModel pour NVIDIA / OpenRouter
    : project.codexModel     ? { model: project.codexModel,         source: 'project' }
    : config.defaults?.codexModel ? { model: config.defaults.codexModel, source: 'defaults' }
    : { model: null, source: 'codex-config' };
  // Pour la trace seulement : quand on laisse codex choisir, on écrit dans le
  // log ce que son config.toml désigne, pour que le chef puisse le vérifier.
  const loggedCodexModel = codexModel || readCodexConfigModel() || 'défaut codex (config.toml illisible)';
  const fakeSid    = `codex-${crypto.randomUUID()}`;

  const codexWeb = /\b(WebSearch|WebFetch)\b/.test(tools);
  // Correspondance des outils du projet avec le bac à sable codex (plan §2.7) :
  // sans Edit/Write/Bash, le projet est en lecture seule.
  const canWrite = /\b(Edit|Write|Bash)\b/.test(tools);
  const harnessCfg = [];
  let harnessError = null;
  if (harness === 'openrouter') {
    const key = loadProviderKey('OPENROUTER_API_KEY');
    if (!key) harnessError = 'clé OpenRouter absente (page Models → Clés API)';
    else env.OPENROUTER_API_KEY = key;   // ce fils seulement : codex en a besoin pour appeler OpenRouter
    harnessCfg.push('-c', 'model_provider=openrouter',
      '-c', 'model_providers.openrouter.name="OpenRouter"',
      // ORCH_OPENROUTER_BASE_URL : faux OpenRouter local de la suite de tests.
      '-c', `model_providers.openrouter.base_url="${process.env.ORCH_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}"`,
      '-c', 'model_providers.openrouter.wire_api="responses"',
      '-c', 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"');
  } else if (harness === 'nvidia') {
    try { env.ORCH_GATEWAY_TOKEN = derivedToken(ROOT, 'gateway'); } catch (e) { harnessError = `jeton de passerelle indisponible : ${e.message}`; }
    harnessCfg.push('-c', 'model_provider=orchnv',
      '-c', 'model_providers.orchnv.name="NVIDIA (passerelle de l\'orchestrateur)"',
      '-c', `model_providers.orchnv.base_url="http://127.0.0.1:${process.env.ORCH_PORT || 7777}/api/llm-gateway/${codexWeb ? 'nvidia-web' : 'nvidia'}/v1"`,
      '-c', 'model_providers.orchnv.wire_api="responses"',
      '-c', 'model_providers.orchnv.env_key="ORCH_GATEWAY_TOKEN"');
  }
  // Les commandes du model ne voient jamais la clé ni le jeton (codex les
  // exclut déjà par motif *KEY*/*TOKEN* ; vérifié réellement le 2026-10-08).
  if (harness) harnessCfg.push('-c', 'shell_environment_policy.exclude=["OPENROUTER_API_KEY","ORCH_GATEWAY_TOKEN","NVIDIA_API_KEY"]');

  logStream.write(JSON.stringify({
    type: 'system', subtype: 'init', session_id: fakeSid,
    provider: runLabel, ...(harness ? { harness: 'codex' } : {}), failover: isFailover || undefined,
    model: loggedCodexModel, modelSource: codexModelSource,
    sandbox: canWrite ? 'workspace-write' : 'read-only',
    webSearch: harness === 'nvidia' ? (codexWeb ? 'web_fetch (passerelle)' : 'aucun (projet sans outils web)')
      : harness === 'openrouter' ? 'aucun (OpenRouter : pas de recherche web dans codex)'
      : codexWeb ? 'live' : 'défaut codex (projet sans outils web)',
    timestamp: new Date().toISOString(),
  }) + '\n');
  if (harnessError) {
    if (EXPLICIT_MODEL) { failExplicitModel(harnessError); return; }
    logStream.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: harnessError, session_id: fakeSid, provider: runLabel, num_turns: 1, timestamp: new Date().toISOString() }) + '\n');
    try { fs.unlinkSync(pidPath); } catch {}
    endLogAndExit(1);
    return;
  }

  // Where codex writes its final assistant message. Authoritative source for
  // the synthetic `result` text — more reliable than reassembling it from the
  // event stream. Removed once read.
  const lastMsgPath = path.join(LOGS, `${projectName}.codex-last.txt`);
  try { fs.unlinkSync(lastMsgPath); } catch {}

  // ── Invocation (codex-cli 0.147.0, verified against `codex exec --help`) ──
  //
  // `codex exec` is the non-interactive mode. Flag notes, each one learned the
  // hard way from the real CLI:
  //   • The old `--approval-mode full-auto` / `--quiet` pair NO LONGER EXISTS.
  //     Passing it made codex exit 2 immediately ("unexpected argument").
  //   • `--approve-for-me` is its replacement: auto-approval routed through
  //     the workspace-write sandbox.
  //   • `-s/--sandbox` is MUTUALLY EXCLUSIVE with `--approve-for-me` ("cannot
  //     be used with"). --approve-for-me already implies workspace-write, so
  //     we must NOT pass -s alongside it.
  //   • `--dangerously-bypass-approvals-and-sandbox` is the codex equivalent
  //     of --dangerously-skip-permissions. FLEET RULE: never used.
  //   • `--skip-git-repo-check` is required — several fleet projects are not
  //     git repositories and codex otherwise refuses to run.
  //   • `--json` emits JSONL events (mapped to the Claude schema below).
  //   • Prompt goes through STDIN with the `-` placeholder: no argv length
  //     limit, and nothing in the prompt can ever reach a command line.
  // RECHERCHE WEB (0.27.0). `codex exec` n'a pas de --search (drapeau de la
  // TUI seulement) ; la clé de config `web_search` (disabled|cached|indexed|
  // live, vérifiée sur codex-cli 0.154.0) l'active. On suit le même opt-in par
  // projet que côté Claude : un projet dont les `tools` accordent le web
  // (WebFetch/WebSearch) a la recherche live ; sinon on ne passe rien et codex
  // garde son défaut. La recherche est un outil côté serveur OpenAI : le bac à
  // sable workspace-write ne la bloque pas, et aucune clé n'est transmise.
  const codexArgs = [
    'exec',
    ...(codexModel ? ['--model', codexModel] : []),   // absent ⇒ codex applique son config.toml
    ...harnessCfg,
    // La recherche live est un outil côté serveur OpenAI : seulement pour codex/OpenAI.
    ...(codexWeb && !harness ? ['-c', 'web_search=live'] : []),
    // --approve-for-me implique workspace-write ; sans outil d'écriture : lecture seule.
    ...(canWrite ? ['--approve-for-me'] : ['-s', 'read-only']),
    '--skip-git-repo-check',
    '--json',
    '--cd', WORK_DIR,
    '--output-last-message', lastMsgPath,
    // Images are natively supported here, unlike the old path which dropped
    // them silently — matters when a failover replays a turn that had attachments.
    ...imagePaths.flatMap(p => ['--image', p]),
    '-',   // read the prompt from stdin
  ];

  // spawn() can THROW synchronously (EINVAL on a batch shim, ENOENT on a bad
  // override) rather than emitting 'error'. On the failover leg an uncaught
  // throw here would kill the dispatch with no result event and no clean
  // exit — precisely the crash-when-everything-is-broken case this feature
  // exists to prevent. Requirement: log it, close the turn, exit. No retry.
  let codexChild;
  try {
    codexChild = spawn(codexBinInfo.cmd, [...codexBinInfo.prefixArgs, ...codexArgs], {
      cwd: WORK_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],   // stdin carries the prompt
      shell: false,
      windowsHide: true,
      ...(codexBinInfo.viaCmd ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    const where = isFailover ? '[FAILOVER] codex fallback' : '[dispatch/codex] codex';
    console.error(`${where} could not be spawned (${codexBinInfo.cmd}): ${err.message} — giving up (no retry loop)`);
    logStream.write(JSON.stringify({
      type: 'result', subtype: 'error', is_error: true,
      result: `codex spawn failed: ${err.message}`,
      session_id: fakeSid, usage: {},
      provider: runLabel, failover: isFailover || undefined,
      timestamp: new Date().toISOString(),
    }) + '\n');
    try { fs.unlinkSync(pidPath); } catch {}
    endLogAndExit(1);
    return;
  }
  try { fs.writeFileSync(pidPath, String(codexChild.pid)); } catch {}

  // 0.47.2 — BATTEMENTS. codex n'écrit rien tant que le fournisseur génère
  // (NVIDIA par la passerelle : plusieurs minutes par appel). Sans signe de
  // vie, la supervision prenait ce silence pour un « sans progrès » rouge. Le
  // battement dit « j'attends le fournisseur depuis N » ; la supervision ne
  // compte le silence qu'à partir du dernier battement (fleet-status-core).
  const PROVIDER_LABEL = { nvidia: 'NVIDIA', openrouter: 'OpenRouter', codex: 'OpenAI (codex)' }[runLabel] || runLabel;
  const HEARTBEAT_MS = Number(process.env.ORCH_HEARTBEAT_MS) > 0 ? Number(process.env.ORCH_HEARTBEAT_MS) : 30_000;
  let codexLastOutAt = Date.now();
  const codexStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const waited = Date.now() - codexLastOutAt;
    if (waited < HEARTBEAT_MS) return;
    try {
      logStream.write(JSON.stringify({
        type: 'system', subtype: 'heartbeat', provider: runLabel,
        waitingMs: waited, intervalMs: HEARTBEAT_MS,
        text: `en attente de ${PROVIDER_LABEL} depuis ${fmtDur(waited)}`,
        timestamp: new Date().toISOString(),
      }) + '\n');
    } catch {}
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // Feed the prompt and close stdin so codex stops waiting for more input.
  try { codexChild.stdin.end(prompt); } catch {}

  // ── codex --json → Claude stream-json mapping ──────────────────────────────
  //
  // The two schemas are NOT compatible, and everything downstream (the log
  // reducer in server.js, fleet-status.mjs, the viewer, the chef's callback)
  // only understands Claude's. Writing codex events through raw would leave
  // the panel stuck with no `result` — the failover would "work" while the
  // fleet stayed visibly blocked. So we translate.
  //
  // Real codex 0.147.0 event shapes (captured live, not guessed):
  //   {"type":"thread.started","thread_id":"…"}
  //   {"type":"turn.started"}
  //   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
  //   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N,…}}
  // and on failure:
  //   {"type":"item.completed","item":{"type":"error","message":"…"}}
  //   {"type":"error","message":"…"}
  //   {"type":"turn.failed","error":{"message":"…"}}
  //
  // NOTE: the codex thread_id is deliberately NOT written to
  // logs/<project>.session. That sidecar feeds `claude --resume`; putting a
  // codex id there would corrupt the Claude session on the way back from a
  // failover.

  let codexStdoutTail = '';
  let codexFinalText  = '';   // accumulated agent_message text (fallback)
  let codexErrorMsg   = null; // first hard error seen
  let codexTurnFailed = false;
  let codexUsage      = null;
  let codexThreadId   = null;

  function writeAssistant(blocks) {
    if (!blocks.length) return;
    logStream.write(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: blocks },
      provider: runLabel, timestamp: new Date().toISOString(),
    }) + '\n');
  }

  /** Translate one codex event into zero or more Claude-schema events. */
  function mapCodexEvent(ev) {
    switch (ev.type) {
      case 'thread.started':
        // The system/init that puts the panel in `live` was already written
        // before the spawn (so a codex that dies instantly still shows a
        // started turn). Here we only record the thread id, which is echoed
        // on the final result for traceability.
        codexThreadId = ev.thread_id || null;
        return;

      case 'item.completed': {
        const item = ev.item || {};
        switch (item.type) {
          case 'agent_message':
            if (item.text) {
              codexFinalText = item.text;
              writeAssistant([{ type: 'text', text: item.text }]);
            }
            return;
          case 'reasoning':
            if (item.text) writeAssistant([{ type: 'thinking', thinking: item.text }]);
            return;
          case 'command_execution':
            writeAssistant([{
              type: 'tool_use', id: item.id || 'codex-cmd', name: 'Bash',
              input: { command: item.command ?? '', status: item.status },
            }]);
            return;
          case 'file_change':
            writeAssistant([{
              type: 'tool_use', id: item.id || 'codex-edit', name: 'Edit',
              input: { changes: item.changes ?? item },
            }]);
            return;
          case 'mcp_tool_call':
          case 'web_search':
            writeAssistant([{
              type: 'tool_use', id: item.id || `codex-${item.type}`, name: item.type,
              input: item,
            }]);
            return;
          case 'error':
            // Non-fatal notice (codex emits these as warnings too). Surface it,
            // but let turn.failed / exit code decide whether the turn errored.
            if (item.message) writeAssistant([{ type: 'text', text: `[codex] ${item.message}` }]);
            return;
          default:
            // Unknown item kind: keep it visible rather than dropping it.
            if (item.text) writeAssistant([{ type: 'text', text: item.text }]);
            return;
        }
      }

      case 'error':
        if (!codexErrorMsg) codexErrorMsg = extractCodexError(ev.message);
        return;

      case 'turn.failed':
        codexTurnFailed = true;
        if (!codexErrorMsg) codexErrorMsg = extractCodexError(ev.error?.message ?? ev.error);
        return;

      case 'turn.completed':
        if (ev.usage) codexUsage = ev.usage;
        return;

      default:
        return;   // turn.started and anything future: nothing to emit
    }
  }

  /** codex nests the upstream API error as a JSON string. Pull out the human part. */
  function extractCodexError(raw) {
    if (raw == null) return null;
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
    try {
      const parsed = JSON.parse(s);
      return parsed?.error?.message || parsed?.message || s;
    } catch { return s; }
  }

  codexChild.stdout.on('data', (chunk) => {
    codexLastOutAt = Date.now();
    codexStdoutTail += chunk.toString('utf8');
    const lines = codexStdoutTail.split(/\r?\n/);
    codexStdoutTail = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); }
      catch {
        // Not JSONL (a banner, a warning) — preserve it as plain text.
        writeAssistant([{ type: 'text', text: line }]);
        continue;
      }
      try { mapCodexEvent(ev); }
      catch (e) { debugCodex(`event map failed: ${e.message}`); }
    }
  });

  function debugCodex(msg) { console.error(`[dispatch/codex] ${msg}`); }

  codexChild.stderr.on('data', (chunk) => {
    // codex uses stderr for progress chatter; keep it off the JSONL log so we
    // never corrupt the event stream with non-JSON lines.
    process.stderr.write(chunk);
  });

  codexChild.on('error', (err) => {
    // Terminal for this turn. On the failover leg this is the second and
    // LAST provider — we log loudly and let finishCodex exit. No retry.
    if (isFailover) {
      console.error(`[FAILOVER] codex fallback also failed to spawn for ${projectName}: ${err.message} — giving up (no retry loop)`);
    } else {
      console.error(`[dispatch/codex] spawn error: ${err.message}`);
    }
  });

  let codexDone = false;
  function finishCodex(code, signal) {
    if (codexDone) return;
    codexDone = true;
    clearInterval(heartbeat);

    // Drain a trailing partial line (no newline before EOF).
    if (codexStdoutTail.trim()) {
      let ev = null;
      try { ev = JSON.parse(codexStdoutTail); } catch {}
      if (ev) { try { mapCodexEvent(ev); } catch {} }
      else writeAssistant([{ type: 'text', text: codexStdoutTail }]);
      codexStdoutTail = '';
    }

    // The final message file is authoritative; fall back to the last
    // agent_message we saw, then to the error text.
    let finalText = '';
    try { finalText = fs.readFileSync(lastMsgPath, 'utf8').trim(); } catch {}
    if (!finalText) finalText = codexFinalText.trim();
    try { fs.unlinkSync(lastMsgPath); } catch {}

    // A turn is an error if codex said so OR the process failed. Both are
    // checked: turn.failed can appear with exit 0 in principle, and a crash
    // can kill codex before it emits any event at all.
    const isErr = codexTurnFailed || !!codexErrorMsg
      || (code !== 0 && code !== null) || !!signal;

    if (isErr && !finalText) finalText = codexErrorMsg || `codex exited with code ${code}${signal ? ` (signal ${signal})` : ''}`;

    // Harnais NVIDIA / OpenRouter : le model est toujours explicite. Une erreur
    // d'API (model inconnu, limite, fournisseur injoignable) n'a aucun repli :
    // fallback_refused, puis la pause côté chef (décision n° 8).
    // 0.47.2 : l'échec se lit tel quel (« ✕ échec : NVIDIA 504 après 5 min »),
    // jamais comme un processus perdu.
    const failHead = isErr && !signal ? providerFailureText(PROVIDER_LABEL, codexErrorMsg, Date.now() - codexStartedAt) : null;
    if (harness && (codexTurnFailed || codexErrorMsg) && !signal) {
      try { fs.unlinkSync(lastMsgPath); } catch {}
      if (EXPLICIT_MODEL) { failExplicitModel(`${harness} : ${codexErrorMsg || 'tour codex en échec'}`, { thread_id: codexThreadId, headline: failHead }); return; }
    }
    if (failHead && !/^✕ échec/.test(finalText)) finalText = `${failHead}${finalText ? ` — ${finalText}` : ''}`;

    // Model EXPLICITE (hors failover) : codex a-t-il servi CE model ?
    if (!isFailover && EXPLICIT_MODEL) {
      const v = verifyCodexRollout(codexThreadId, EXPLICIT_MODEL);
      if (v.ok === false) {
        failExplicitModel(`codex a servi « ${v.served} » au lieu du model demandé (rollout ${path.basename(v.file)})`,
          { model_served: v.served, thread_id: codexThreadId });
        return;
      }
      try {
        logStream.write(JSON.stringify({
          type: 'system', subtype: v.ok ? 'model_verified' : 'model_unverified',
          model_requested: EXPLICIT_MODEL, provider: runLabel,
          ...(v.ok ? { model_served: v.served } : { reason: v.why }),
          timestamp: new Date().toISOString(),
        }) + '\n');
      } catch {}
    }

    // THE event everything downstream keys on: server.js's reducer, the
    // viewer's panel state, fleet-status.mjs and the chef's callback all
    // look for a Claude-shaped `result`. Without it the panel never leaves
    // `live`, whatever codex actually did.
    logStream.write(JSON.stringify({
      type: 'result',
      subtype: isErr ? 'error' : 'success',
      is_error: isErr,
      result: finalText,
      session_id: fakeSid,
      thread_id: codexThreadId,
      num_turns: 1,
      usage: codexUsage
        ? { input_tokens: codexUsage.input_tokens ?? 0, output_tokens: codexUsage.output_tokens ?? 0 }
        : {},
      provider: runLabel,
      ...(harness ? { harness: 'codex' } : {}),
      model: loggedCodexModel,
      failover: isFailover || undefined,
      timestamp: new Date().toISOString(),
    }) + '\n');
    try { fs.unlinkSync(pidPath); } catch {}
    // END OF THE LINE. Codex is the last provider we try — whatever happened
    // here, we exit. A retry loop would pound a dead account unattended.
    if (isFailover) {
      if (isErr) console.error(`[FAILOVER] codex fallback FAILED for ${projectName} (code=${code} signal=${signal || 'none'}) — turn lost, giving up (no retry loop)`);
      else       console.error(`[FAILOVER] codex fallback completed ${projectName} via ${loggedCodexModel}`);
    }
    if (signal) { console.error(`[dispatch/codex] killed by ${signal}`); endLogAndExit(128); return; }
    endLogAndExit(code ?? 1);
  }
  codexChild.on('exit',  (c, s) => finishCodex(c, s));
  codexChild.on('close', (c, s) => finishCodex(c, s));

}

/**
 * Run the turn through Claude (nominal path).
 *
 * Unchanged from the original implementation except for the session-limit
 * watch: output is scanned for exhaustion, and if the turn dies from it we
 * hand the SAME prompt to runCodex(true) instead of exiting.
 */
function runClaude() {

  // ── Claude path (original) ─────────────────────────────────────────────────

  // When images are present we use --input-format stream-json so we can embed
  // base64 image content blocks in the user message. The claude CLI has no
  // --image flag (verified against v2.1.113); stream-json input is the only way.
  // Videos are not supported as content blocks by the Claude API; they are
  // referenced as text (path) so the sub-agent knows a video exists on disk.
  const useStreamJsonInput = imagePaths.length > 0 || videoPaths.length > 0;

  const args = [
    '--print',
    ...(useStreamJsonInput ? [] : [prompt]),  // prompt as positional arg in text-only mode
    '--output-format', 'stream-json',
    '--verbose',                              // required with stream-json
    '--include-partial-messages',
    '--allowed-tools', tools,
    '--model', model,
    '--setting-sources', 'project,local',     // skip global user settings
    '--strict-mcp-config',                    // no MCP servers but ours (permissions, below)
    '--disable-slash-commands',               // no skills leaking in
  ];
  if (useStreamJsonInput) args.push('--input-format', 'stream-json');
  if (sessionId) args.push('--resume', sessionId);
  // 0.45.0 — demandes d'autorisation interactives : au lieu de refuser sur-le-
  // champ un outil non autorisé, le CLI demande à notre serveur MCP local
  // (permission-mcp.mjs), qui attend la décision de l'utilisateur. Le seul
  // serveur MCP du tour (--strict-mcp-config reste) ; son outil est masqué au
  // model (--disallowed-tools : vérifié, le CLI l'appelle quand même).
  if (PERMISSION_PROMPTS) {
    args.push(
      '--mcp-config', JSON.stringify({ mcpServers: { orch: { type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'permission-mcp.mjs')] } } }),
      '--permission-prompt-tool', 'mcp__orch__approve',
      '--disallowed-tools', 'mcp__orch__approve',
    );
    Object.assign(env, {
      ORCH_ROOT: ROOT,
      ORCH_PERM_URL: `http://127.0.0.1:${process.env.ORCH_PORT || 7777}`,
      ORCH_PERM_PROJECT: projectName,
      ORCH_PERM_TIMEOUT_MS: String(PERMISSION_TIMEOUT_MS),
      ORCH_PERM_MODEL: model,
      ORCH_PERM_CWD: WORK_DIR,
      ORCH_PERM_LOG: logPath,
      ...(DUAL_BRANCH ? { ORCH_PERM_BRANCH: DUAL_BRANCH.role } : {}),
    });
    // Le CLI n'attend pas un outil MCP indéfiniment : marge au-delà du délai.
    if (!env.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = String(PERMISSION_TIMEOUT_MS + 5 * 60_000);
  }

  // CLAUDE_BIN env opt-in: when set, spawn that binary instead of `claude`.
  // Used by Phase 4.B/4.C harness to swap in the deterministic fake_claude
  // stub. If the value ends in `.mjs` or `.js`, prepend node so the file
  // runs without needing a #! shebang on Windows.
  //
  // Path resolution fallback: when server.js runs as a Windows service under
  // LocalSystem, the user-level PATH is NOT inherited and `spawn('claude',
  // ...)` fails with ENOENT (-4058) — observed 2026-05-13 after NSSM install.
  // We probe a list of well-known install paths and pick the first that exists.
  function resolveClaudeBin() {
    const fromEnv = process.env.CLAUDE_BIN;
    if (fromEnv) return fromEnv;
    if (process.platform !== 'win32') return 'claude';
    // Under LocalSystem (Windows service), USERPROFILE points at the system
    // profile, not the human user — so the env-derived candidates miss the
    // real install location. We also probe every C:\Users\<name>\.local\bin\
    // so the service works regardless of which user installed claude.
    const candidates = [];
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) {
      candidates.push(
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, '.local', 'bin', 'claude.cmd'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      );
    }
    // Scan C:\Users\*\.local\bin\claude.exe so service contexts find it too.
    try {
      for (const u of fs.readdirSync('C:\\Users', { withFileTypes: true })) {
        if (!u.isDirectory()) continue;
        if (u.name === 'Public' || u.name === 'Default' || u.name.startsWith('All ')) continue;
        candidates.push(
          `C:\\Users\\${u.name}\\.local\\bin\\claude.exe`,
          `C:\\Users\\${u.name}\\.local\\bin\\claude.cmd`,
        );
      }
    } catch {}
    candidates.push('C:\\Program Files\\Claude\\claude.exe');
    for (const c of candidates) {
      try { if (fs.statSync(c).isFile()) return c; } catch {}
    }
    return 'claude';  // last resort — PATH lookup
  }
  const claudeBin = resolveClaudeBin();
  let spawnCmd, spawnArgs;
  if (claudeBin && /\.(mjs|js|cjs)$/i.test(claudeBin)) {
    spawnCmd  = process.execPath;
    spawnArgs = [claudeBin, ...args];
  } else {
    spawnCmd  = claudeBin;
    spawnArgs = args;
  }
  const child = spawn(spawnCmd, spawnArgs, {
    cwd: WORK_DIR,          // project CLAUDE.md and .claude/ load from here
    env,
    stdio: [useStreamJsonInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });

  // Record the claude child PID so fleet-status.mjs can check if a stalled
  // turn's process is still alive. Removed on clean exit below.
  try { fs.writeFileSync(pidPath, String(child.pid)); } catch {}

  // ---------- event parsing → session sidecar + instrumentation --------------
  //
  // Patch 1.1: line-splitter accepts both `\n` and `\r\n` endings (the previous
  // version split only on `\n`, so any chunk delivering a CRLF-ended line left
  // a trailing `\r` that broke JSON.parse silently — observed events lost).
  //
  // Patch 1.2: the `'data'` handler MUST be O(1). It only appends bytes to the
  // log stream and pushes complete lines into an in-memory queue; a separate
  // drainer scheduled on `setImmediate` does the JSON.parse work. This decouples
  // child stdout flow from the cost of parsing, so a slow consumer (heavy line)
  // can never fill the OS pipe buffer and stall the child.
  //
  // Patch 1.7 (dispatch side): note the wall-clock timestamp of the first
  // stream-json event and the eventual `result`. These are appended to the
  // instrumentation log on lifecycle close so server-side reporting can
  // compute first_event_ms / turn_total_ms without parsing the full log.

  let newSessionId        = null;
  let stdoutTail          = '';
  let firstEventAtMs      = null;
  let resultAtMs          = null;
  let tokensInputCached   = null;
  let tokensOutputCached  = null;
  const dispatchStartedAt = Date.now();

  // ---------- session-limit watch (failover trigger) -------------------------
  //
  // We only ever act on this if the turn ALSO failed (non-zero exit or an
  // error result). That conjunction is what keeps a musician who merely
  // *writes about* rate limits from triggering a spurious failover.

  let limitDetected = false;
  let limitResetAt  = null;
  let limitEvidence = '';
  let resultIsError = false;
  let modelMismatch = null;   // { actual, where } si le CLI sert un autre model que le --model explicite
  let stderrTail    = '';

  /** Record the first credible limit sighting; later ones can't override it. */
  function noteLimitEvidence(text) {
    if (limitDetected || typeof text !== 'string' || !text) return;
    if (!detectClaudeLimit(text)) return;
    limitDetected = true;
    limitEvidence = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    limitResetAt  = parseResetTime(text);
  }

  const lineQueue = [];
  let drainerScheduled = false;

  function scheduleDrain() {
    if (drainerScheduled) return;
    drainerScheduled = true;
    setImmediate(processLineQueue);
  }

  function processLineQueue() {
    drainerScheduled = false;
    // Cap work per tick so a giant burst doesn't starve the event loop.
    // 256 lines/tick is generous; the tail of the queue picks up next tick.
    let budget = 256;
    while (lineQueue.length && budget-- > 0) {
      const line = lineQueue.shift();
      if (!line || !line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (firstEventAtMs == null) firstEventAtMs = Date.now();
      if (!newSessionId && typeof ev.session_id === 'string' && ev.session_id.length > 0) {
        newSessionId = ev.session_id;
        try { fs.writeFileSync(sessionPath, newSessionId); } catch {}
      }
      // Model EXPLICITE : on vérifie ce que le CLI sert VRAIMENT. system/init
      // arrive avant tout travail — une substitution y est arrêtée net ; chaque
      // message assistant porte aussi son model (`<synthetic>` exclu). Pas
      // `modelUsage` du result : il est cumulé sur toute la session reprise et
      // liste aussi les appels annexes (Haiku), il ne prouve rien pour CE tour.
      if (EXPLICIT_MODEL && !modelMismatch) {
        const served = ev.type === 'system' && ev.subtype === 'init' ? ev.model
          : ev.type === 'assistant' ? ev.message?.model : null;
        if (served && !modelMatches(EXPLICIT_MODEL, served)) {
          modelMismatch = { actual: served, where: ev.type === 'assistant' ? 'message assistant' : 'system/init' };
          killTree(child);
        }
      }
      if (ev.type === 'result') {
        resultAtMs = Date.now();
        if (ev.is_error || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'))) {
          resultIsError = true;
        }
        // Authoritative fields only — never tool_result payloads, which can
        // legitimately contain the words "rate limit" from a file the agent read.
        noteLimitEvidence(typeof ev.result === 'string' ? ev.result : '');
        noteLimitEvidence(typeof ev.subtype === 'string' ? ev.subtype : '');
        noteLimitEvidence(typeof ev.error === 'string' ? ev.error : (ev.error?.message || ''));
        const u = ev.usage || ev.message?.usage;
        if (u) {
          if (typeof u.input_tokens  === 'number') tokensInputCached  = u.input_tokens;
          if (typeof u.output_tokens === 'number') tokensOutputCached = u.output_tokens;
        }
      } else if (ev.type === 'assistant') {
        // The CLI often surfaces the limit notice as the final assistant text.
        for (const b of ev.message?.content || []) {
          if (b?.type === 'text') noteLimitEvidence(b.text);
        }
      }
    }
    if (lineQueue.length) scheduleDrain();
  }

  child.stdout.on('data', (chunk) => {
    // O(1): append bytes to log + line buffer, defer parse work.
    logStream.write(chunk);
    stdoutTail += chunk.toString('utf8');
    const lines = stdoutTail.split(/\r?\n/);   // Patch 1.1: CRLF-tolerant
    stdoutTail = lines.pop() ?? '';
    if (lines.length) {
      for (const l of lines) lineQueue.push(l);
      scheduleDrain();
    }
  });

  child.stderr.on('data', (chunk) => {
    logStream.write(chunk);
    process.stderr.write(chunk);
    // A bare CLI failure (limit hit before any stream-json event) shows up
    // only here. Keep a bounded tail — stderr can be large on a crash loop.
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192);
    noteLimitEvidence(stderrTail);
  });

  child.on('error', (err) => {
    console.error(`[dispatch] spawn error: ${err.message}`);
  });

  // Patch 1.4: idempotent lifecycle teardown. Both `exit` and `close` may fire
  // (in either order, both with reasonable timing); this guarantees we do the
  // flush + sidecar cleanup exactly once.
  let lifecycleClosed = false;
  function lifecycleEnd(code, signal) {
    if (lifecycleClosed) return;
    lifecycleClosed = true;
    // Drain any pending queued lines before we shut the log so we don't lose
    // a final `result` observation (which may carry the limit message).
    try { processLineQueue(); } catch {}

    // Did this turn die because the Claude account is exhausted? Requires
    // BOTH a limit message and an actual failure — see noteLimitEvidence.
    const turnFailed  = (code !== 0 && code !== null) || !!signal || resultIsError;
    const doFailover  = limitDetected && turnFailed;

    // On failover the codex leg keeps writing to this same stream, so the
    // close is deferred to finishCodex (via endLogAndExit).
    try { fs.unlinkSync(pidPath); } catch {}
    // Patch 1.7: append the instrumentation record. Best-effort; never blocks
    // exit and never throws. The trace id, interrupt flag, and time-since-last
    // are propagated from server.js via env vars so each line is self-contained.
    try {
      const instrPath = path.join(LOGS, `instrumentation-${new Date().toISOString().slice(0, 10)}.ndjson`);
      const turnTotalMs = resultAtMs ? (resultAtMs - dispatchStartedAt) : null;
      const firstEventMs = firstEventAtMs ? (firstEventAtMs - dispatchStartedAt) : null;
      const tslRaw = process.env.DISPATCH_TIME_SINCE_LAST_MS;
      const timeSinceLastMs = tslRaw ? Number(tslRaw) : null;
      const record = {
        ts: new Date().toISOString(),
        trace_id: process.env.DISPATCH_TRACE_ID || null,
        project: projectName,
        pid: child.pid,
        dispatch_started_at: new Date(dispatchStartedAt).toISOString(),
        first_event_ms: firstEventMs,
        turn_total_ms: turnTotalMs,
        tokens_input:  tokensInputCached,
        tokens_output: tokensOutputCached,
        interrupt_requested: process.env.DISPATCH_INTERRUPTED === '1',
        time_since_last_dispatch_ms: Number.isFinite(timeSinceLastMs) ? timeSinceLastMs : null,
        exit_code: code ?? null,
        exit_signal: signal ?? null,
        claude_limited: doFailover || undefined,
      };
      fs.appendFileSync(instrPath, JSON.stringify(record) + '\n');
    } catch {}

    // ---------- ARRÊT PAR LE CHEF (kill-stalled, 0.31.0) --------------------
    // kill-stalled clôt lui-même le tour (result error_killed_by_conductor).
    // Rien d'autre ici : ni « model indisponible », ni bascule, ni repli — sinon
    // l'arrêt volontaire passait pour un échec.
    if (killedByConductor(dispatchStartedAt)) { endLogAndExit(1); return; }

    // ---------- MODEL EXPLICITE : jamais de repli (0.26.0) -------------------
    if (EXPLICIT_MODEL) {
      if (modelMismatch) {
        failExplicitModel(`le CLI a servi « ${modelMismatch.actual} » (${modelMismatch.where}) au lieu du model demandé — tour arrêté`,
          { model_served: modelMismatch.actual });
        return;
      }
      if (doFailover) {
        // Le compte EST limité : on pose quand même le drapeau de flotte, pour
        // que les dispatches SANS model explicite continuent de basculer.
        const until = writeClaudeLimitFlag(limitResetAt);
        failExplicitModel(`limite de session Claude jusqu'à ${until.toISOString()}`, { limited_until: until.toISOString(), evidence: limitEvidence });
        return;
      }
      if (turnFailed && resultAtMs == null && !signal) {
        // Le CLI est mort sans result (ex. model inconnu refusé au démarrage) :
        // on clôt le tour avec la cause plutôt que de laisser le panneau figé.
        const why = (stderrTail || '').replace(/\s+/g, ' ').trim().slice(-300) || `code ${code}`;
        failExplicitModel(`le CLI claude a échoué sans result (${why})`);
        return;
      }
    }

    // ---------- FAILOVER HANDOFF -------------------------------------------
    //
    // Claude is out of budget. Persist the fleet-wide flag so every OTHER
    // project short-circuits straight to codex from now until reset, then
    // replay THIS turn's original prompt through codex. `prompt` still holds
    // it (callback instruction included) — that is why we keep it around.
    if (doFailover) {
      const until = writeClaudeLimitFlag(limitResetAt);
      if (NO_FAILOVER) {
        console.error(`[NO-FAILOVER] Claude limited until ${until.toISOString()} — model switch DISABLED (logs/no-failover). Turn stops; resume on Claude after reset.`);
        try { logStream.write(JSON.stringify({ type:'system', subtype:'limited-no-failover', reason:'claude_session_limit', limited_until: until.toISOString(), timestamp:new Date().toISOString() }) + '\n'); } catch {}
        // Close the turn so the dashboard doesn't stay pinned on "le chef
        // répond…". `is_error && synthetic` is already understood as → idle by
        // every reducer; this does NOT fabricate a successful answer.
        try { logStream.write(JSON.stringify({ type:'result', is_error:true, synthetic:true, subtype:'error_limited', result:`Claude limité jusqu'à ${until.toISOString()}`, ...(sessionId ? { session_id: sessionId } : {}), timestamp:new Date().toISOString() }) + '\n'); } catch {}
        endLogAndExit(1);
        return;
      }
      console.error(`[FAILOVER] Claude limited until ${until.toISOString()}, routing ${projectName} -> NVIDIA cascade`);
      if (!limitResetAt) {
        console.error(`[FAILOVER] reset time not parseable from the limit message — assuming +60 min (conservative fallback)`);
      }
      console.error(`[FAILOVER] evidence: ${limitEvidence}`);
      try {
        logStream.write(JSON.stringify({
          type: 'system', subtype: 'failover',
          from: 'claude', to: 'nvidia-cascade',
          reason: 'claude_session_limit',
          limited_until: until.toISOString(),
          reset_parsed: !!limitResetAt,
          evidence: limitEvidence,
          timestamp: new Date().toISOString(),
        }) + '\n');
      } catch {}
      // NVIDIA cascade is the failover leg; it falls through to codex only as a
      // last resort. Either way it always terminates the process.
      runNvidiaFailover();
      return;
    }

    if (signal) {
      console.error(`[dispatch] sub-agent killed by ${signal}`);
      endLogAndExit(128);
      return;
    }
    endLogAndExit(code ?? 1);
  }

  child.on('exit', (code, signal) => lifecycleEnd(code, signal));
  child.on('close', (code, signal) => lifecycleEnd(code, signal));

  // ---------- stream-json stdin (images) --------------------------------------

  if (useStreamJsonInput) {
    // Build a user message with image content blocks followed by the text prompt.
    // Videos cannot be sent as content blocks (Claude API limitation); they are
    // referenced by path in a text block so the sub-agent knows they exist.
    const EXT_TO_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const content = [];
    for (const imgPath of imagePaths) {
      const ext = path.extname(imgPath).slice(1).toLowerCase();
      const mediaType = EXT_TO_MIME[ext] || 'image/png';
      const data = fs.readFileSync(imgPath).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    }
    for (const vidPath of videoPaths) {
      content.push({ type: 'text', text: `[Vidéo jointe — disponible sur le disque : ${vidPath}]\nNote : l'API Claude ne prend pas en charge les vidéos en entrée. Tu ne peux pas visionner cette vidéo, mais tu peux en tenir compte dans ta réponse si le contexte le demande.` });
    }
    if (prompt.trim()) content.push({ type: 'text', text: prompt });
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
    child.stdin.end(msg + '\n');
  }

} // end runClaude

// ============================================================================
// PROVIDER DISPATCH — startup short-circuit
// ============================================================================
//
// Runs at the very start of every dispatch. Three outcomes, all deterministic:
//   • project is configured for codex        → codex, no failover logic at all
//   • Claude flagged limited and not expired → NVIDIA cascade (skip Claude)
//   • otherwise                              → Claude, nominal path untouched
//
// readClaudeLimitFlag() deletes an expired flag as a side effect, so the
// third case is also the automatic return to Claude at reset time.

if (provider === 'codex' || HARNESS_PROVIDER) {
  runCodex(false);
} else {
  const limitedUntil = readClaudeLimitFlag();
  if (limitedUntil && EXPLICIT_MODEL) {
    // Model demandé explicitement et Claude limité : ni NVIDIA ni codex.
    failExplicitModel(`limite de session Claude active jusqu'à ${limitedUntil.toISOString()}`,
      { limited_until: limitedUntil.toISOString() });
  } else if (limitedUntil && NO_FAILOVER) {
    console.error(`[NO-FAILOVER] Claude limited until ${limitedUntil.toISOString()} — skipping dispatch (no model switch).`);
    try { logStream.write(JSON.stringify({ type:'system', subtype:'limited-no-failover', reason:'claude_session_limit_active', limited_until: limitedUntil.toISOString(), timestamp:new Date().toISOString() }) + '\n'); } catch {}
    // Close the turn (see lifecycleEnd guard above) so a prompt received during
    // a limited window doesn't leave the chef pinned on "le chef répond…".
    try { logStream.write(JSON.stringify({ type:'result', is_error:true, synthetic:true, subtype:'error_limited', result:`Claude limité jusqu'à ${limitedUntil.toISOString()}`, ...(sessionId ? { session_id: sessionId } : {}), timestamp:new Date().toISOString() }) + '\n'); } catch {}
    endLogAndExit(1);
  } else if (limitedUntil) {
    console.error(`[FAILOVER] Claude limited until ${limitedUntil.toISOString()}, routing ${projectName} -> NVIDIA cascade`);
    try {
      logStream.write(JSON.stringify({
        type: 'system', subtype: 'failover',
        from: 'claude', to: 'nvidia-cascade',
        reason: 'claude_session_limit_active',
        limited_until: limitedUntil.toISOString(),
        timestamp: new Date().toISOString(),
      }) + '\n');
    } catch {}
    runNvidiaFailover();
  } else {
    runClaude();
  }
}
