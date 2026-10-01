# Claude Code Orchestrator — CLAUDE.md

Local Windows dashboard. One interactive central Claude session pilots N
headless `claude -p` sub-agents, one per personal project in `I:\Dev`.
Full context: `docs/project-brief.md`. Design system: PHOSPHOR/03,
`docs/AI Agent Orchestration Dashboard-handoff/`.

---

## Règles standing du fleet (instaurées 2026-04-30)

Ce projet est hybride : **serveur Node.js** (`server.js` + `public/`) + **app Android compagnon** (`android/`). Les règles s'appliquent aux deux artefacts.

**1 — Versioning.** Toute release/build doit avoir un numéro visible et incrémenté.

- **Node** : champ `version` dans `package.json`. Doit être à la fois :
  - exposé via `GET /api/version` (token-gated comme le reste), et
  - affiché dans le footer du dashboard (`public/index.html`, alimenté par `/api/version` au chargement).
- **Android** : `versionName` (semver) + `versionCode` (entier, **+1 strict** à chaque build poussé) dans `android/app/build.gradle.kts`. `versionName` doit être affiché dans l'UI (actuellement dans le header de `FleetScreen`, via `BuildConfig.VERSION_NAME`).
- **Bump** : `patch` (fix), `minor` (feature), `major` (breaking change). Démarrage à `1.0.0` pour les nouveaux artefacts ; ce projet a commencé sous `0.x` et n'est pas remis à `1.0.0` rétroactivement.

**2 — Changelog.** `CHANGELOG.md` à la racine, format [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

- Sections : `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`.
- En-tête entrée : `## [X.Y.Z] - YYYY-MM-DD`.
- **Couplage strict** : aucune release sans bump de version **ET** entrée changelog correspondante. Les changements Node et Android partagent le même fichier ; préfixer si utile (`(server)`, `(android)`).

---

## Hard rules (non-negotiable)

- **Never forward `ANTHROPIC_API_KEY` to any child `claude` process.**
  The server deletes it from its own `process.env` at boot *and* again
  from the per-spawn env. Billing must ride the Max/Pro OAuth session
  (`~/.claude/`). Guards anthropics/claude-code#39903.
- **Never use `--dangerously-skip-permissions` as a default.** Sub-agents
  run `--allowed-tools "Read,Edit,Write,Bash"`. Wider scopes are
  per-project opt-in in `config.json`.
- **`logs/` and `.token` are always gitignored.** Never commit, never
  cloud-sync. stream-json events embed file content, tokens, secrets.
- **Projects live in `I:\Dev`.** Code/data on `I:` only. `C:\` is
  tooling (`~/.claude/`, `~/.netrc`, system). Logs stay on `I:`.
- **Token gate is mandatory.** Every HTTP route and every WS upgrade
  requires the 32-byte hex token from `./.token` via either
  `?token=<hex>` query param or `X-Orchestrator-Token` header.
  Browser-side WS upgrades must use the query param (browsers can't
  set custom headers on WS).
- **Binding is `0.0.0.0` + token gate only** (policy updated 2026-05-13).
  The interface allowlist middleware has been disabled: trusted home LAN,
  token gate is the sole authentication layer. Re-enable the middleware
  (it's commented out in `server.js` near `// [1] Interface allowlist`)
  if the operating network becomes untrusted (public Wi-Fi, conference,
  etc.).
- **Validate project names/paths against the `config.json` allowlist**
  before interpolating into any spawn. Pass argv as an array — never
  shell-concat.
- **Answer routing is the central Claude's job, not the UI.** When a
  sub-agent is in `needs_user_input`, the central must name the target
  project explicitly in its dispatch call. If the user's reply is
  ambiguous (multiple panels blocked, or name not stated), the central
  must ask the user to clarify before dispatching — never guess.

---

## Question protocol (musicians → user OR chef)

Musicians can route questions to two addressees. The orchestrator's
pump detects sentinel prefixes in the musician's final assistant text
and forwards automatically.

### `NEEDS_USER_INPUT: <question>`

Use when the question requires the user :
- Personal preference (which technology, design choice, name)
- Authorization for an irreversible action (deploy, push origin,
  delete, send email)
- Choice between options where no option is objectively better
- Credentials or secrets the musician doesn't have
- Discovery of an incident the user must know about

The viewer detects this sentinel and shows the project panel in
`needs_user_input` state. The user replies via the chat ; the central
relays.

### `NEEDS_CHEF_INPUT: <question>`

Use when the question requires the conductor (chef) :
- Architectural decision spanning multiple projects / musicians
- Coordination with another musician (need info outside this project's
  domain)
- Application of a transverse policy (security, org-wide convention)
- A synthesis you cannot make alone (cross-project context)

Routing :
1. Pump detects `NEEDS_CHEF_INPUT:` in the musician's final assistant
   text or `result.result` field.
2. Pump auto-dispatches chef with prompt :
   `[NEEDS_CHEF_INPUT_FROM:<musician>] <question>` and a brief
   instruction to answer with `[ANSWER] …` or redirect to user with
   `NEEDS_USER_INPUT: …`.
3. Chef's next result event lands ; pump walks back chef's log to find
   the `[NEEDS_CHEF_INPUT_FROM:` marker, extracts the musician name,
   strips chef's `[ANSWER]` prefix, dispatches the cleaned response
   back to the musician with `[CHEF_ANSWER] …`.
4. The musician resumes via `--resume <session_id>` with the chef's
   decision in hand.

Dedupe is by `(musician, first-100-chars-of-question)` for
musician→chef, and by `(chef session_id, num_turns)` for chef→musician.
In-memory only ; server restart may re-relay the last chef answer at
most once.

### Tie-breaker

If a musician is uncertain which addressee, default to user. The user
is the ultimate authority ; the chef is a delegate. Chef receiving a
question that should have been for the user can redirect by responding
with `NEEDS_USER_INPUT: <reformulated>` instead of `[ANSWER]`.

### Examples

| Question | Addressee |
|----------|-----------|
| `getUserData` vs `fetchUser` for a function name | none (decide yourself) |
| "Deploy to prod now ?" | user (irreversible) |
| "Tailwind or MUI ?" | user (preference) |
| "Where is the API X documented across projects ?" | chef (cross-project) |
| "Should I follow the org-wide PII logging policy ?" | chef (transverse policy) |
| "This migration touches project Y, should Y go first ?" | chef (coordination) |
| "I broke the build, rollback ?" | self if obvious, user otherwise |
| "You told me approach A but I see it's inefficient. Change ?" | user (revises a prior user decision) |

---

## Stack (locked)

| Area          | Choice                                       |
| ------------- | -------------------------------------------- |
| Server        | Node.js 20+, single process, single port 7777 |
| PTY bridge    | `node-pty` (ConPTY — native, no WSL)         |
| HTTP + WS     | `express` + `express-ws`                     |
| Log watcher   | `chokidar` → SSE                             |
| Viewer        | Vanilla JS + `@xterm/xterm` 5.5 (self-hosted) |
| Fonts         | Chakra Petch + JetBrains Mono (self-hosted)  |
| Bootstrap     | `start.ps1` (sanitizes env, starts server)   |

---

## Architecture invariants

- One Node process, one port 7777. No microservices.
- Sub-agents are headless. One `claude -p` invocation = one turn.
  Session continuity via `--resume <session_id>`. Never fake interactivity
  with a per-project pty.
- Stable log filename per project, append-only: `logs/<project>.jsonl`.
  Never pipe through `tail`/`head`, never truncate.
- Session persistence is **dual**: in-memory `Map<project, session_id>`
  in the server, plus sidecar `logs/<project>.session` on disk. Sidecar
  is source of truth; memory is a cache. Sidecar updates on every
  successful dispatch.
- Question protocol: sub-agent ends its final assistant text with a
  literal line `NEEDS_USER_INPUT: <question>`. Viewer detects → panel
  transitions to `needs_user_input`. Central relays the user's reply
  with a new `claude -p "<answer>" --resume <sid>` call, naming the
  target project explicitly.
- **Sub-agent isolation (important nuance vs brief §5)**: the brief
  originally said `--bare`, but `--bare` disables OAuth and requires
  `ANTHROPIC_API_KEY`. To preserve subscription billing AND isolate
  sub-agents from global user config, we instead pass:
  - `--setting-sources project,local` (skips user-level hooks, skills,
    plugins, global settings)
  - `--strict-mcp-config` (blocks all MCP servers — we pass no
    `--mcp-config`)
  - `--disable-slash-commands` (no skills/slash commands)
  This satisfies the intent of "no global config leakage" while
  keeping OAuth auth working. Project CLAUDE.md and project `.claude/`
  still auto-discover from the spawn `cwd`. Documented at the top of
  `server.js` and `scripts/dispatch.mjs`.

---

## Design system (from `docs/AI Agent Orchestration Dashboard-handoff/`)

- PHOSPHOR/03 — Agent Orchestration Cockpit.
- Palettes: `amber` (default), `matrix`, `ghost`, `crimson` via
  `body[data-palette=…]`.
- Fonts: Chakra Petch (UI), JetBrains Mono (terminal & code).
- Panel states (wire exactly these strings to DOM `data-state`):
  `idle | live | input | done | error`.
- Event-type rendering spec (from prototype CSS, do not deviate):
  `text` default prose · `thinking` dim italic collapsed ·
  `tool_use` cyan badge + args preview · `tool_result` monospace block
  collapsed > N lines · `error` red, sticky.
- Read the prototype source directly — do not screenshot.

---

## Conventions

- ES modules (`"type": "module"`), Node 20+.
- No frameworks on the viewer.
- Build argv arrays; never shell-concat user-provided strings.
- Comments explain non-obvious WHY only; names do the rest.
- Prefer editing over creating files.

---

## Page /downloads — ajouter une app (à chaud, sans redémarrage)

Le registre de `/downloads` vit dans **`downloads.json`** à la racine
(versionné ; ce n'est PAS `config.json`). Le serveur le relit dès que son
mtime change : **aucun redémarrage** pour ajouter/retirer une app ou un doc,
changer un libellé, une plateforme, une description ou une source de version.
Le reste de la carte est déjà calculé à chaque requête (version lue dans le
gradle, présence de `builds/<app>/latest.apk`, HTML).

Ajouter une app Android :

1. Publier l'APK : `node scripts/copy-build.mjs <Projet>` → `builds/<Projet>/latest.apk`.
2. Ajouter une entrée dans `apps[]` (l'ordre du tableau = l'ordre des cartes) :

       { "name": "<Projet>",
         "description": "Une phrase affichée sous le titre",
         "version": { "file": "I:\Dev\<Projet>\app\build.gradle.kts" } }

   - `name` (requis) : nom du dossier sous `builds/`, lettres/chiffres/`_.-`.
   - `label` : titre affiché (défaut : `name`).
   - `platform` : badge (`phone` par défaut, `TV`, `mobile`…).
   - `description` : texte sous le titre.
   - `version.file` : chemin **absolu** ; sans `regex`, c'est le `versionName`
     du gradle (Kotlin ou Groovy). Autre source : `"regex"` avec **un** groupe
     capturant, `"flags"` parmi `i m s u` (voir l'entrée RemotePad).
3. Recharger `/downloads`. Vérifier : `node scripts/_test_downloads_hot.mjs`
   (valide aussi le `downloads.json` du dépôt).

Un doc : entrée dans `docs[]` avec `project`, `id` (slug), `title`, `file`
(nom simple sous `builds/<project>/`) et `fallbacks` (chemins absolus).

**Tout ou rien.** JSON cassé ou une seule entrée invalide ⇒ le fichier entier
est refusé, la dernière version valide reste servie (jamais de 500) et la
raison est journalisée une fois dans la console et `logs/server-debug.log`.
Si une modification « ne prend pas », c'est là qu'il faut regarder. Une app
sans `latest.apk` s'affiche « APK pas encore publié » au lieu d'un bouton mort.

---

## Fin de tour, file par musicien, results fantômes (0.24.1)

- **Un tour `claude -p` s'arrête à son `result`, et ses tâches d'arrière-plan
  meurent avec lui** (`system/task_notification` status `stopped`).
  `dispatch.mjs` ajoute donc à tout prompt de musicien (pas au chef) une
  « RÈGLE DE FIN DE TOUR » : ne jamais finir un tour en comptant sur un process
  d'arrière-plan. Il faut soit l'exécuter en avant-plan, soit le lancer
  réellement détaché (`Win32_Process Create`) avec un `notify.mjs` vers le chef
  à la fin. La consigne va dans le prompt envoyé à claude, pas dans
  `promptForLog` : le fil ne l'affiche pas.
- **Result fantôme.** Au `--resume` suivant, le CLI rejoue la notification de
  la tâche tuée sous forme d'un mini-tour vide, au milieu du nouveau tour :
  `result` avec `num_turns: 0`, `duration_api_ms: 0`, `stop_reason: null` et le
  même coût. `isPhantomResult()` (`scripts/fleet-status-core.mjs`) le reconnaît
  partout où un result est interprété :
  - le pump (aucun réveil, aucune notification, aucun drain, le ticket du chef
    n'est pas clos, et l'attente `--callback` du tour n'est pas consommée) ;
  - `scanProjectState`, `fleet-status` et `/api/pupitre` ;
  - `/api/conductor-chat` et `/api/project/:name/events` ;
  - le relais `NEEDS_CHEF_INPUT` ;
  - le client.

  Chaque fantôme ignoré est journalisé dans `logs/server-debug.log`
  (`[result-fantôme]`).
- **File par musicien.** Le drain part au `result`, mais attend que le
  processus du tour qui finit soit mort avant de lancer la tête avec
  `--no-queue-if-busy`. Sans cette attente, le fils voyait encore le PID et se
  re-postait en fin de file, sans fin. Le drain a lieu aussi quand le tour
  finit en `input` : la question reste affichée. Un balayage toutes les 30 s
  draine une file non vide devant un musicien libre, sans processus, depuis
  au moins 60 s (après un redémarrage, un result manqué…), jamais sous limite
  Claude. Il est journalisé `[queue-sweep]`. La file se gère avec
  `scripts/queue.mjs`, jamais en éditant `logs/queue/*.json`.

---

## Questions acquittées sans relancer le musicien (0.25.0)

L'état `input` (question `NEEDS_USER_INPUT` du dernier tour) ne s'efface
normalement qu'au tour suivant du musicien. Quand l'utilisateur répond via le
chef, ou que la question devient sans objet, on l'**acquitte** sans rien
relancer :

- `POST /api/question/:project/resolve {note?, by?}` (token-gated) ajoute au
  log du musicien un événement `notification/question_resolved` (question,
  note, auteur, horodatage). La route renvoie 409 si aucune question n'est
  ouverte ou si un tour tourne.
- CLI : `node scripts/resolve-question.mjs <projet> [--note "…"]`. Codes de
  sortie : 0 acquittée, 2 rien à acquitter, 3 serveur < 0.25.0.
- UI : bouton « ✓ Marquer comme répondue » sur la bulle de question du fil, la
  ligne de la bande d'attention et l'état du panneau. Une bulle acquittée est
  grisée « ✓ marquée répondue » avec la note.

Pourquoi un événement de log et pas un sidecar : tous les réducteurs
(`reduceMusician`, `scanProjectState`, `deriveState` via `isQuestionResolved`,
le client) lisent déjà le log dans l'ordre. La règle est unique : seul `input`
passe à `idle`. Un nouveau tour qui démarre reprend donc naturellement la
main, l'acquittement survit au redémarrage, part au dashboard par le SSE et
reste lisible dans le journal du panneau. `scanProject` ne remonte plus
`needsInput` hors de l'état `input` (fleet-status n'affiche plus « needs: … »
pour une question acquittée ou dépassée).

---

## Provider et model d'un dispatch (`dispatch.mjs`)

- `--provider claude|codex` et `--model <id>` choisissent le provider et le
  model pour un seul dispatch, sans écrire `config.json`. Un chef n'écrit
  jamais ce fichier.
- **codex, hors failover** (0.25.1) : le model est choisi dans cet ordre :
  1. `--model` ;
  2. `codexModel` du projet ;
  3. `defaults.codexModel` ;
  4. sinon, aucun `--model` n'est passé et codex applique son propre
     `~/.codex/config.toml` (`CODEX_HOME` respecté).

  Le `'gpt-4o'` codé en dur a disparu. Models vus dans le models_cache de
  codex : `gpt-6-astra`, `gpt-reserve`, `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`, `gpt-5.5`.
- **Leg de failover codex** (limite Claude) : inchangé. C'est le `codexModel`
  configuré, sinon `FAILOVER_CODEX_MODEL`. Le `--model` d'un dispatch Claude
  qui bascule n'atteint jamais codex.
- **Refus avant toute écriture (exit 64)** : un model Claude
  (`claude|opus|sonnet|haiku|fable…`) avec `--provider codex`, et un model
  OpenAI (`gpt|o<n>|codex…`) sans lui.
- **Traçabilité** : le `system/init` et le `result` codex du log portent
  `model`, c'est-à-dire le model passé, ou celui que désigne `config.toml`
  quand on laisse codex choisir. Le `system/init` porte en plus `modelSource`
  (`flag|project|defaults|codex-config|failover`).
- **Model explicite = aucun fallback** (0.26.0, règle utilisateur : « si un
  modèle est précisément demandé, aucun fallback n'est toléré »). Un model est
  explicite dès qu'il arrive par `--model`, y compris via la file, le pool ou
  l'API, qui repassent `--model` tel quel. Le tour tourne alors sur ce model
  et seulement lui :
  - pas de failover NVIDIA, pas de repli codex, pas de défaut projet ou flotte ;
  - vérification du model réellement servi :
    - claude : `system/init.model`, puis chaque `assistant.message.model`
      (`<synthetic>` exclu). Pas `modelUsage`, qui est cumulé sur la session
      et inclut des appels annexes. Un écart arrête le tour dès l'`init`,
      avant tout travail.
    - codex : la rollout `~/.codex/sessions/…-<thread_id>.jsonl`, relue après
      le tour. Si elle est introuvable, `system/model_unverified` est
      journalisé sans faire échouer le tour.
  - Si le model est indisponible (limite, substitution, CLI mort sans
    result), le tour échoue : `system/fallback_refused` suivi d'un `result`
    `is_error`, `subtype: error_model_unavailable`, cause
    « model demandé X indisponible : … — aucun fallback (règle utilisateur) ».
    Ce result n'est **pas** synthétique : le chef reçoit le ✕ et son réveil.
  - Le drapeau de limite de flotte est tout de même posé : les dispatches
    sans model explicite continuent de basculer.
  - Le serveur trace `[fallback-refusé]` et ne draine pas la file
    immédiatement derrière ; le balayage de secours s'en charge, jamais sous
    limite.

  Sans `--model`, rien ne change. Recette de bout en bout, isolée par
  `DISPATCH_ROOT_FOR_TESTS` (le drapeau de limite est à l'échelle de la
  flotte) : `node scripts/_test_explicit_model.mjs`.
- **`--new-session`** (0.27.0) démarre le tour **sans `--resume`**.
  L'ancienne session n'est pas effacée : `logs/<p>.session` est renommé en
  `.session.bak-<horodatage ISO>`, puis le `session_id` du nouveau tour
  devient le courant. Usages : études indépendantes par des models
  différents sur un même musicien, ou repartir d'un contexte court quand une
  session est devenue trop longue.
  - L'archivage a lieu **après** la décision de file : une demande mise en
    file n'archive rien. Le flag voyage avec l'entrée (`newSession`), le
    drain le repasse en `--new-session`, et `queue.mjs` affiche « SESSION
    NEUVE ».
  - API : `POST /api/dispatch {…, newSession: true}`.
  - Claude uniquement : avec `--provider codex`, le flag est ignoré et le dit,
    pour ne pas faire repartir à zéro le tour claude suivant.
  - Traçabilité : le `user_prompt` porte `newSession: true` et
    `archivedSession`.
- **Web et lecture pour tous les projets** (0.28.0). Règle utilisateur :
  « tous les projets doivent avoir droit au web et à la lecture ».
  - `defaults.allowedTools` vaut
    `Read,Edit,Write,Bash,WebFetch,WebSearch,Grep,Glob`. Les replis codés en
    dur (`dispatch.mjs`, `FALLBACK_TOOLS` de `server.js`, `new-project.mjs`)
    ont la même liste.
  - Chaque override `tools` a été complété, sans jamais rien retirer : aucun
    projet n'a moins que le défaut.
  - `new-project.mjs` fait hériter le défaut ; `--tools` ne sert qu'à ajouter
    (par exemple `Agent`), et `--web` est obsolète, accepté sans effet.
  - Pas d'autre outil de lecture : `Read` couvre fichiers, images, PDF et
    notebooks, `Grep`/`Glob` la recherche. L'ancien `LS` n'existe plus.
  - Vérifier : `node scripts/_test_tools_resolution.mjs` évalue la vraie
    résolution de `dispatch.mjs` et de `server.js` sur le vrai `config.json`.
- **Web pour codex** (codex-cli 0.154.0) : `codex exec` n'a pas de `--search`
  (drapeau de la TUI uniquement). C'est la clé `web_search`
  (`disabled|cached|indexed|live`) qui l'active. `dispatch.mjs` passe
  `-c web_search=live` quand les `tools` du projet accordent le web, et ne
  passe rien sinon.
  - C'est un outil côté serveur OpenAI : aucune clé transmise, pas bloqué par
    le bac à sable.
  - Vérifier : `system/init.webSearch` dans le log du musicien, puis des
    `tool_use` nommés `web_search` pendant le tour.

---

## Non-régression — à rejouer à CHAQUE modification (0.29.0)

Exigence utilisateur : « faire des tests de non-régression pour être sûr que
toutes les fonctionnalités marchent toujours, et être capable de revenir en
arrière ».

- **Avant** de modifier : poser un tag annoté de retour
  (`git tag -a pre-<sujet>-v<X.Y.Z> -m …`), puis lancer
  `node scripts/regression.mjs --ref <ce tag> --out .regress/report-avant.json`.
- **Après** : lancer `node scripts/regression.mjs --out .regress/report-apres.json`,
  puis `node scripts/regression.mjs --compare .regress/report-avant.json
  .regress/report-apres.json --md <rapport.md>`. La comparaison sort en code
  non nul si une ligne passe de OK à autre chose.
- `regression.mjs` sort en code non nul au moindre KO. Il enchaîne trois
  étages :
  1. toutes les suites `scripts/_test_*.mjs` (sauf `_test_phase2*`, qui
     écrivent dans les vrais `logs/`) ;
  2. une **instance de test isolée** (`.regress/`, port libre, 14 projets de
     fixtures, faux `claude` = `tests/fake_claude`) et ses parcours HTTP ;
  3. les parcours navigateur (Edge headless via `playwright-core`) : fil et
     saisie, rail, attention, « Marquer comme répondue », volet et onglets,
     file + Retirer, recherche, briefing, pool, pièce jointe, temps réel,
     mobile, vue Projets.
- **Sécurité de l'instance de test** : `7777` est réécrit dans sa copie de
  `server.js` et des scripts, puis **vérifié absent** (sinon abandon). La
  production n'est jamais contactée ni redémarrée. `--restart-check` rejoue
  `restart-orchestrateur.mjs` sur la copie. `--no-browser`, `--no-suites`,
  `--keep` (garder l'instance) et `--shots <dossier>` (captures) sont aussi
  disponibles.
- Toute nouvelle route ou fonctionnalité ajoute son parcours dans
  `regression.mjs` (HTTP) et/ou `_regression_browser.mjs` (navigateur). Une
  fonctionnalité absente d'un ancien ref y est notée NA, pas KO.
- Le contrôle du token gate suit le mode **réel** de `server.js`. Depuis le
  2026-09-07, `TOKEN_GATE_ENABLED = false` (décision utilisateur, commit
  `3bc33bc`) : le rapport le signale au lieu de le masquer.

## Vue « Projets » et retour arrière (0.29.0)

- `#/projets` (`public/projets.js` + `projets.css`) : le statut de chaque
  projet en un coup d'œil. Conception : `docs/dashboard-status/SYNTHESE.md`.
  Elle lit `App.musicians` (l'état) et `/api/pupitre` (la santé et les champs
  additifs). Aucun poll supplémentaire.
- **Désactiver sans redéploiement** : `config.json` →
  `"ui": { "projectsView": false }`, relu à chaud. Les dashboards ouverts
  perdent la pill et `#/projets` renvoie au fil. Pour un seul navigateur :
  `/?projets=0` (`?projets=1` rétablit). Défaut : activée.
- **Retour arrière complet**, exécuté par le chef :

      git -C I:\orchestrateur revert --no-edit pre-status-view-v0.28.0..v0.29.0   # tous les commits de la release, figés par tags
      # ou : git -C I:\orchestrateur checkout pre-status-view-v0.28.0 -- server.js public scripts/fleet-status-core.mjs package.json
      node I:\orchestrateur\scripts\restart-orchestrateur.mjs
      node I:\orchestrateur\scripts\regression.mjs

- Dette : `server.js` importe `ssh-server.js` et `src/*.mjs`, **non
  versionnés**. Un checkout propre ailleurs ne démarrerait pas ; ici, ils
  restent en place.

## Attachments

Images uploaded via the dashboard (paste / drag-drop / file picker) land in
`I:\orchestrateur\attachments\` as `att-<timestamp>-<random>.<ext>`.
The folder is gitignored. **No automatic cleanup is implemented (v1).**
Purge manually when it grows large, or wire a scheduled task in a future iteration.

---

## Do-not

- No React / Vue / Svelte.
- No truncation of stream-json.
- No database. `config.json` + JSONL + sidecar files = full persistence.
- Don't resurrect Claude Agent SDK, native subagents, Agent Teams, or
  Cowork (all rejected in brief).
- Don't add log rotation, multi-machine, or Telegram — deferred.
- Don't disable the interface allowlist or the token gate.

---

## Conductor (runtime) — moved

The conductor's runtime instructions (routing, dispatch, supervision)
now live in `I:\Dev\Chef\CLAUDE.md`. The **Chef** is a separate project
in `config.json` with `cwd = I:\Dev\Chef`, so its Claude session no
longer accidentally edits this server's code. This file covers the
dashboard itself; Chef covers how to orchestrate the fleet.

If you are a Claude working **on this project** (fixing a server bug,
touching `public/app.js`, etc.), you are not the conductor. The
conductor is a separate process running in Chef.

---

## Run

    npm install
    .\start.ps1        # preferred: unsets API key, prints tokenized URL
    # or:  npm start
    # Dashboard: http://127.0.0.1:7777/?token=<hex>
    # Over Tailscale: http://<ts-ip>:7777/?token=<hex>
