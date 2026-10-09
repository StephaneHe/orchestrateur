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
- **Binding is `0.0.0.0` + network guard: loopback and Tailscale only**
  (0.59.0, user decision 2026-10-09 « Protection puis redémarrage »). The
  token gate is off since 2026-09-07, so the guard is the access control:
  `scripts/network-guard.mjs`, first middleware (`// [1] Network guard` in
  `server.js`) and in `wsVerifyClient`, serves only remote addresses in
  `127.0.0.0/8`, `::1`, `100.64.0.0/10`, `fd7a:115c:a1e0::/48`; the home LAN
  gets 403. No portproxy. Emergency widening only via `ORCH_ALLOW_CIDRS`
  (server env, add-only). Test: `scripts/_test_network_guard.mjs`, HTTP
  `network-guard`.
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
  - `--strict-mcp-config` (blocks all MCP servers except the one we pass:
    since 0.45.0, only the local permission server `permission-mcp.mjs`)
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
  ouverte, avec `alreadyHandled: true` et l'état réel : le client masque alors
  la carte, sans erreur. Depuis 0.57.1, un tour en cours ne bloque plus
  l'acquittement.
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

**Ouverture de tour : une seule règle (0.57.1).** Elle est définie dans
`TurnCore.isTurnStart` et `TurnCore.stateAtTurnStart`, utilisées par les quatre
réducteurs.
- Un tour s'ouvre sur un `user_prompt` sans source, un `system/init`, un
  `system/pipeline_start` ou un `system/dual_start`. Une exécution de pipeline
  lancée par le chef n'écrit qu'un `user_prompt` sourcé, sans `init`.
- À l'ouverture, `idle`, `unread`, `input` et `error` passent à `live`, et le
  dernier texte assistant est oublié : un `result` sans texte assistant ne
  relit jamais la question du tour précédent.
- Recette : `scripts/_test_examine_after_chef.mjs`.

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

## Projet prêt à tourner dès sa création (0.30.0)

Règle utilisateur : « les autorisations auraient dû être données à la
création ». Sans confiance du workspace, `claude -p` **ignore** toutes les
règles `permissions.allow` du `.claude/settings.json` du projet (« this
workspace has not been trusted »). Une autorisation accordée depuis le
dashboard ne servait alors à rien.

- `new-project.mjs` écrit `.claude/settings.json` (outils du projet +
  `PowerShell`) et pose `hasTrustDialogAccepted: true` dans `~/.claude.json`
  pour la clé `I:/Dev/X` (la forme lue par le CLI) et sa forme antislash si
  elle existe.
- `~/.claude.json` est partagé par tous les claude en cours : on ne l'écrit
  qu'à travers `scripts/workspace-trust.mjs` (sauvegarde `.orchestrateur-bak`,
  temp + rename, relecture de contrôle, seule l'entrée du projet change).
  Pour supprimer un projet : `forgetWorkspace()`.
- Rétroactif / contrôle : `node scripts/trust-projects.mjs [--dry-run]`.
- `add-tool` (server) pose aussi la confiance.
- Recette : `node scripts/_test_workspace_trust.mjs` (faux `~/.claude.json`,
  `ORCH_CLAUDE_JSON`).

## « Vu », arrêt par le chef, journal d'activité, cadres du Pilotage (0.31.0)

Retours utilisateur : un échec restait dans « À examiner » sans moyen de le
marquer vu ; un arrêt volontaire du chef passait pour un échec ; le volet ne
donnait qu'un accès au log brut.

- **Règles partagées** : `public/turn-core.js`, un seul fichier chargé par le
  navigateur et importé par Node (`fleet-status-core.mjs`, `server.js`). Il ne
  contient ni import ni export et pose `globalThis.TurnCore`. Tout réducteur
  d'état passe par ces règles : `deriveState`, `scanProjectState`,
  `reduceMusician`, `Musician.transition`.
- **« Vu »** : `POST /api/ack/:project {note?, by?, auto?}`.
  - `error` (échec ou arrêt) : ajoute `notification/acknowledged` au log
    (même conception que `question_resolved`), puis l'état passe à `idle`.
  - `unread` (y compris attente du chef) : pose le marqueur de lecture.
  - `input`, tour en cours ou rien à acquitter : 409.
  - **Règle choisie** : ouvrir le volet vaut « vu » pour un échec, un arrêt ou
    un résultat. Une question n'est jamais acquittée ainsi : elle attend une
    réponse ou un « Marquer comme répondue ».
  - Boutons « ✓ Vu » ou « ✓ Répondue » sur chaque ligne de « À examiner »,
    « ✓ Marquer vu » dans la bande d'attention et sur l'état du volet.
- **Arrêt par le chef** : `kill-stalled.mjs <p> [--reason "…"]` écrit
  `result/error_killed_by_conductor` (`stopped_by`, `reason`). L'état reste
  `error` (vocabulaire verrouillé), avec l'attribut additif `stopped`, affiché
  « ■ Arrêté par le chef ».
  - kill-stalled pose `logs/<p>.killed` avant de tuer.
  - `dispatch.mjs` (`killedByConductor`) clôt alors le tour sans rien écrire
    d'autre. Avant, un `error_model_unavailable` masquait l'arrêt.
  - Les réducteurs ignorent tout result qui suit un arrêt dans le même tour,
    pour les anciens logs.
- **Journal** : `GET /api/project/:name/journal?n=` renvoie les tours, du plus
  récent au plus ancien : demande sans boilerplate, 1 à 3 lignes de résultat,
  commits, versions, URL, issue, durée, coût et model. Aucun LLM.
  - Seule la fin du log est lue (4 à 64 Mio), en asynchrone, avec un cache
    incrémental et une requête à la fois par musicien.
  - Le client redemande le journal à chaque événement de bord du musicien
    ouvert (`public/activite.js`). Le log brut reste dans l'onglet « Log brut ».
  - **Plié / déplié** (0.33.0) : chaque tour porte aussi `promptFull` et
    `resultFull` (`{text, cut}`, plafonnés à 12 000 caractères). Ils sont
    rendus en Markdown via `mdToHtml` seulement quand l'entrée est dépliée.
    Les contrôles « ▸ Afficher tout / ▾ Réduire » ont `aria-expanded`, et un
    « ▴ Réduire » en bas ramène l'entrée à l'écran. Les entrées dépliées sont
    gardées par musicien, et le focus clavier est rendu au même contrôle après
    chaque rafraîchissement temps réel.
  - `turn-core.js` est chargé par le **serveur au démarrage** : une
    modification de ce fichier demande un redémarrage pour le journal servi.
    Sans ces champs (ancien serveur), le contrôle n'apparaît pas.
- **Cadres** : 2ᵉ partie verticale du Pilotage, un cadre par musicien. Tri : tours en cours d'abord, puis `lastActivityAt` de
  `/api/pupitre`. Depuis 0.32.0, il n'y a plus de bloc « En cours » au-dessus
  (il doublonnait les cadres) : le haut ne montre que « À examiner ». Le cadre
  d'un tour en cours porte la durée du tour (« tour N min »), sa file (⏳ n) et
  « données anciennes » si l'instantané date. Le bloc revient seulement si
  `ui.railCards` est désactivé. La sorte et le mot
  viennent de `Projets.describe` (une seule classification avec la vue
  Projets). L'âge est affiché à la minute, et chaque partie du rail a son
  propre cache pour qu'un cadre ne soit pas recréé sous le pointeur.
- **Désactiver sans redéploiement** : `config.json` →
  `"ui": { "activityJournal": false, "railCards": false }` (à chaud), ou
  `?journal=0` / `?cadres=0` pour un seul navigateur.
- Recettes : `node scripts/_test_activity_journal.mjs` (dont kill-stalled
  contre le vrai dispatch.mjs), parcours HTTP `ack-stopped` et `journal`,
  parcours navigateur `examine-*`, `journal-*`, `cards-order`, `flags-031`,
  `mobile-journal`.

## Taille du texte (0.34.0)

Demande utilisateur : « donne la possibilité d'augmenter ou diminuer la taille
de la police ».

- **Toutes les polices sont en `rem`** (`font-size` en px converties : N px →
  N/16 rem). La racine vaut `html { font-size: calc(16px * var(--text-scale)) }`,
  et `body` garde ses 14 px (0.875rem). À 100 %, le rendu est identique à avant.
  **Toute nouvelle règle doit écrire `font-size` en `rem`**, jamais en px :
  sinon elle ne suit pas le réglage.
- `public/text-size.js` est chargé dans `<head>` sans `defer`, pour appliquer
  l'échelle avant le premier rendu.
  - Crans : 85, 90, 100, 110, 125 et 150 %.
  - Mémorisé dans `localStorage` (`ui.textScale`, absent = 100 %).
  - Réglage A− / A / A+ dans la barre du haut, avec `aria-label`. Il reste
    visible sur mobile (⋮ et ⚙ y sont masqués), avec des cibles de 44 px.
- Raccourcis : `Ctrl+Alt+=` (ou `+`), `Ctrl+Alt+-`, `Ctrl+Alt+0`. `Ctrl+/-`
  reste au zoom du navigateur. Sous Windows, AltGr = Ctrl+Alt (AZERTY :
  AltGr+0 = « @ ») : les raccourcis sont ignorés dans un champ de saisie et
  quand AltGr est enfoncé.
- Recettes : parcours `text-size` (bureau) et `text-size-mobile`, avec
  captures à 85 % et 150 %. Ils vérifient l'absence de débordement, les bords
  réels de la barre et les libellés du rail qui ne passent pas sous les boutons.

## Lecture audio des réponses du chef (0.35.0)

Demande utilisateur : « implémente une fonction de lecture audio des réponses,
déjà du chef ».

- `public/tts.js` : Web Speech API du navigateur (`speechSynthesis`),
  100 % local et gratuit, sans service cloud ni clé. Comme `turn-core.js`,
  le fichier n'a ni import ni export et pose `globalThis.Tts`. Sa partie pure
  est testée sous Node par `scripts/_test_tts_text.mjs` :
  - `toSpeech(md)` retire le Markdown, ne lit jamais les blocs de code (« bloc
    de code »), remplace les liens par leur texte (« lien vers domaine » pour
    une URL nue), les chemins par leur dernier segment, les SHA et longs
    identifiants par « identifiant » ; il annonce les tableaux (et les lit
    s'ils ont au plus 8 lignes) ;
  - `chunks()` découpe en morceaux de 220 caractères au plus, aux fins de
    phrase (une ponctuation suivie d'un espace) ;
  - `guessLang()` repère l'anglais nettement dominant et lui donne une voix
    anglaise.
- **Lecteur** : un énoncé par morceau, le suivant sur `onend`. Les moteurs
  coupent les longs énoncés, et la pause n'est pas fiable sur Android : pause
  = arrêt en mémorisant le morceau, reprise = relecture de ce morceau.
  - Bouton « 🔊 écouter / ⏹ arrêter » dans l'en-tête de chaque bulle du chef
    (`Tts.buttonHtml`, état posé par `Tts.sync()` après chaque `renderChat`).
  - Barre ⏸/▶ et ⏹ (`#tts-bar`).
  - Raccourci `Ctrl+Alt+L` : écouter la dernière réponse, ou arrêter. Il est
    ignoré dans un champ de saisie et avec AltGr.
- **Lecture automatique** (désactivée par défaut) : appelée depuis
  `onConductorEvent` quand une bulle du chef arrive en direct. Le SSE ne
  rejoue pas l'historique, donc rien d'ancien n'est relu au chargement.
- **Réglages** dans le panneau ⚙ (rendu visible sur mobile pour cela) : voix
  (par défaut la meilleure voix française, « Natural » / « Online » d'abord),
  vitesse, lecture automatique, voix anglaise pour l'anglais. Mémorisés dans
  `localStorage` (`tts.*`).
- **Désactiver sans redéploiement** : `config.json` → `"ui": {"tts": false}`
  (à chaud ; ce drapeau est servi par `uiFlags()` de server.js, depuis le
  redémarrage qui suit la 0.35.0), ou `?tts=0` pour un navigateur.
- Recettes : `_test_tts_text.mjs` et les parcours `tts`, `tts-settings`,
  `tts-mobile`, avec une doublure de `speechSynthesis` injectée par
  `addInitScript`. Elle enregistre chaque énoncé, ce qui permet de vérifier
  le texte réellement envoyé au moteur.

## Toute demande utilisateur devient un test de non-régression (0.36.0)

Règle utilisateur, pour toute la flotte : « que ce soit pour le chef ou pour
les musiciens, à partir du moment où je fais une demande spécifique à propos
d'une fonctionnalité, il faut rajouter un test de non-régression pour plus
tard ».

- **Pour ce projet** : chaque demande est tracée dans
  `docs/USER_REQUIREMENTS.md` (date, demande verbatim, test associé, version).
  Les noms de projets privés y sont remplacés par « [projet] ».
  - Le test doit être ajouté à `regression.mjs`, à `_regression_browser.mjs`
    ou à une suite `scripts/_test_*.mjs`.
  - Références : `suite:<fichier>`, `http:<id>`, `nav:<id>`.
  - `scripts/_test_user_requirements.mjs` échoue si une demande n'a pas de
    test, si une référence n'existe plus, ou si un nom de projet privé du
    `config.json` local apparaît.
  - Un test d'exigence ne se supprime ni ne s'affaiblit sans accord explicite.
- **Pour les musiciens** : `dispatch.mjs` ajoute `userRequirementsRule()` au
  prompt de chaque musicien (pas du chef), comme la règle de fin de tour.
  Elle reste invisible dans le fil (après `promptForLog`).
- **Pour les nouveaux projets** : `templates/project/CLAUDE.md` porte la règle
  n° 6, et `templates/project/docs/USER_REQUIREMENTS.md` le registre.
  `new-project.mjs` copie tout le modèle. Les projets existants reçoivent la
  consigne par le dispatch, qui leur dit de créer le registre et la suite.
- **Le chef** : il ne code pas et n'a pas de suite. Son contrat (`I:\Dev\Chef`,
  un autre projet) doit relayer la règle à chaque demande de fonctionnalité.
- Recettes :
  - `_test_user_requirements.mjs` : vrai `dispatch.mjs` avec une doublure de
    `claude`, modèle de projet, registre ;
  - `_test_pool_chef_dispatch.mjs` (scénario 7b) ;
  - `_test_repo_hygiene.mjs` : rien de sensible suivi par git.

## Refus d'autorisation : nature, « Vu », plus de retour (0.37.0)

Exigence utilisateur : « fais en sorte que les demandes d'autorisations s'en
aillent après validation ».

- **Trois natures de refus** (`PermissionDenial.classify`, public/permission-denial.js),
  relevées dans les logs de la flotte :
  - `tool` : « Claude requested permissions to use X, but you haven't
    granted it yet ». C'est le **seul** refus que « + Autoriser X » règle
    (`add-tool` : settings.json + confiance).
  - `path` : écriture ou lecture hors du projet, fichier sensible,
    `workingDir`, « may only access files ».
  - `command` : analyse de sécurité du CLI (`subcommandResults`,
    `safetyCheck`, `rule`) : opérations multiples, `$( )`, script, .NET,
    tâche planifiée… L'outil est déjà accordé : **jamais de bouton
    « Autoriser »**, une explication et « ✓ Vu ».
- Le motif vient de `system/permission_denied` (`decision_reason_type`,
  `message`) ou de la `tool_result` en erreur du même appel
  (`PermissionDenial.enrich`). Le `result` ne donne que l'outil.
- **Refus traités** : `POST /api/project/:name/denials/ack {toolIds, action:
  seen|granted, tool?}` ajoute `notification/denials_acknowledged` au log.
  Le volet et le panneau ne ré-affichent jamais un `tool_use_id` acquitté.
  « + Autoriser » accorde l'outil puis acquitte. Repli : `localStorage`
  (`perm.acked`) si la route est absente (serveur pas encore redémarré).
- Cause du signalement : l'ancien volet comparait l'outil aux `tools` de
  config.json. Un outil accordé par settings.json (PowerShell) y paraissait
  « manquant », et le volet ré-affichait sans fin les refus du dernier tour.
  Ces refus dataient d'avant la confiance du dossier (0.30.0). Testé le
  2026-10-05 : dans un dossier de confiance avec `PowerShell` autorisé,
  `Get-Content @(…)` et `Get-Content $(…)` passent ; une règle de préfixe
  `PowerShell(Get-Content:*)` n'apporte rien, et n'est donc pas ajoutée.
- Sans motif connu (événement du CLI hors de la fenêtre chargée, seul le
  `result` reste), un refus **Bash ou PowerShell** est classé `command` ; les
  autres outils sont classés `unknown`. Jamais `tool` par défaut (0.37.1).
  Fixture : la commande réelle `Get-Content README.md,CHANGELOG.md,…`.
- `dispatch.mjs` ajoute `simpleCommandsRule()` au prompt des musiciens :
  préférer Bash ou des commandes PowerShell simples.
- Recettes : `_test_permission_denial.mjs` (classification, enrichissement,
  acquittements), parcours HTTP `denials-ack` et navigateur `denial-ack`,
  scénario 7c de `_test_pool_chef_dispatch.mjs`.

## Callback par fichier, résumés longs (0.37.2)

- **Consigne de callback** (`dispatch.mjs`, bloc `if (callbackProject)`) :
  1. le musicien écrit son résumé avec l'outil **Write** dans
     `<projet>/.orchestrateur-callback.md` (dans son dossier, donc toujours
     autorisé) ;
  2. il lance `node "<orchestrateur>/scripts/notify.mjs" chef --file
     "<ce fichier>" --source <projet>`.

  notify.mjs supprime le fichier après l'envoi (`--keep` pour le garder).
  L'ancienne forme (`RESUME="…"` multi-ligne puis `printf | node notify.mjs
  --stdin`) était refusée par l'analyse de sécurité du CLI. `--stdin` et le
  texte en argument restent acceptés.
- **Erreurs 500 de notify** : `/api/notify` limitait le corps à **2 Ko**
  (`express.json({limit:'2kb'})`). « entity too large » tombait dans le
  gestionnaire d'erreurs global, qui renvoyait 500. La limite est maintenant
  `NOTIFY_MAX_BODY = '512kb'`, et le gestionnaire global renvoie **413** pour
  un corps trop gros et **400** pour un JSON illisible.
- Repli côté notify.mjs (serveur pas encore redémarré) : sur 413 ou 500 avec
  un corps de plus de 1 900 octets, le texte est envoyé en parties numérotées
  « [partie i/n] », coupées aux paragraphes.
- Recettes : `_test_user_requirements.mjs` (section 1b : consigne réellement
  injectée avec `--callback`) et parcours HTTP `notify-long` : 20 Ko
  accentué avec tableau livré en un envoi, texte intact, fichier supprimé ;
  600 Ko → 413.

## Plus de « mis de côté » (0.38.0)

Demande utilisateur : « Ce concept de mis de cote n'a plus d'interet. Fais une
etude du code, et supprime le concept. Fais attention a ne rien supprimer
d'autre ». Un projet remis en activité restait hors de la liste principale.

- Supprimés : le champ `parked` (config.json, `/api/config`,
  `/api/pupitre`), `healthTracked`, le cache de 60 s des projets parqués, la
  route `POST /api/project/:name/park`, le bouton ⊟ et le menu « Mettre de
  côté / Remettre en avant », le groupe « Mis de côté » du rail, le groupe
  « Parqués » de la vue Projets, les badges PARQUÉ / MIS DE CÔTÉ / PARKED,
  l'étagère « En attente » (code mort), et leur équivalent dans l'app Android
  (0.8.0).
- **Tous les projets sont traités pareil** : liste principale, cadres,
  attention et santé (stall, processus perdu).
- Un ancien `"parked": true` resté dans un config.json est **ignoré**. Les
  fixtures de régression le gardent sur zeta et eta pour le prouver.
- Ne pas réintroduire de notion équivalente sans demande explicite.
  Recettes : `_test_projects_view.mjs` (section 4), parcours HTTP `no-parked`
  et navigateur `groups`, `tiles`, `only`, `cards-order`.
- Retour arrière : `git revert` jusqu'au tag `pre-remove-parked-v0.37.2`. La
  copie du config.json d'avant est dans
  `.tmp/config.before-remove-parked.json` (locale, non versionnée).

## Models par tâche (0.39.0)

Demande utilisateur : une interface accessible depuis l'orchestrateur, qui
représente clairement l'enchaînement des tâches, et où l'on assigne à chaque
tâche un model, dans un menu déroulant, parmi Anthropic, OpenAI, NVIDIA et
OpenRouter.

- Vue `#/models` (`public/models.js` + `models.css`). On l'ouvre par :
  - la pill « ⇄ Models » ;
  - le menu ⋮ ;
  - `g` puis `m`.
- **Structure depuis la 0.40.0** : 13 pipelines en onglets, définis dans
  **`scripts/model-pipelines.mjs`** (données pures).
  - Un pipeline a des étapes (`flow`), des boucles (`kind: 'loop'` avec
    `back`), des retours (`returns`) et des renvois (`ref`, sans menu).
  - Les étapes peuvent avoir des variantes et un besoin
    (`need: {llm, local}`).
  - Une **case** = `pipeline.étape` ou `pipeline.étape.variante`. Une
    variante vide hérite de l'étape, puis du défaut du projet.
  - Les exemples ne nomment **aucun projet privé**, car le dépôt est public :
    le test le vérifie contre le config.json local.
  - Ajouter un pipeline ou une étape : éditer ce fichier, et `LEGACY_MAP` si
    une case disparaît. Les tests HTTP et navigateur suivent la structure.
- Migration : un `model-routing.json` sans `version: 2` est migré à la
  première lecture.
  - La correspondance est dans `LEGACY_MAP`.
  - L'ancien fichier est gardé en `model-routing.json.v1-bak`.
  - Le résultat va dans `migration.{mapped,lost}`, et l'interface l'affiche
    dans un bandeau.
- Capacités : chaque model du catalogue porte `caps` (`text`, `vision`,
  `image-gen`, `audio-in`, `audio-out`, `video-in`).
  - Une étape ne propose que les models compatibles.
  - Les outils locaux (`LOCAL_TOOLS`) sont détectés dans le PATH et les
    modules Python. Un outil non installé est visible mais non sélectionnable.
  - Le serveur refuse un model incompatible (400) et un outil absent (409).
- **Phase 1 = interface et enregistrement seulement.** `dispatch.mjs` ne lit
  pas encore `model-routing.json`. Ne pas brancher sans demande.
- Listes de models (`GET /api/model-catalog[?refresh=1]`, cache dans
  `logs/model-catalog.cache.json`) :
  - **Anthropic** : liste `ANTHROPIC_VERIFIED`, mise à jour à la main. Il n'existe
    aucune liste publique sans clé API, et aucune clé payante ne doit être
    ajoutée.
  - **OpenAI** : `models_cache.json` de codex (`CODEX_HOME` respecté).
  - **NVIDIA** : cascade de `nvidiaFailoverConfig()` (lue dans `dispatch.mjs`,
    source unique), plus la liste publique `/v1/models`, sans clé. Les models
    de la cascade absents du catalogue sont signalés.
  - **OpenRouter** : liste publique, sans clé, filtrée sur `tools`.

  Une source injoignable garde sa dernière liste connue (`stale`).
- **Clés** : seule la présence de la clé OpenRouter est rapportée
  (`OPENROUTER_API_KEY` dans l'environnement du serveur ou dans le `.env` de
  l'orchestrateur), jamais sa valeur. Sans clé, le groupe est grisé et le
  `PUT` renvoie 409. Les `.env` des autres projets ne sont jamais lus par le
  code. Exception : la copie unique et autorisée du 2026-10-08, voir
  ci-dessous.
- **Section « 🔑 Clés API » (0.43.0)** : `scripts/api-keys.mjs`, routes
  `/api/api-keys` (GET, PUT `:name`, POST `:name/test`, DELETE `:name`).
  - **Jamais la valeur** dans une réponse, un log ou `logs/api-keys.status.json` :
    au plus les 4 derniers caractères.
  - Écriture atomique dans le `.env` de la racine, et nulle part ailleurs.
    La valeur doit respecter `^[A-Za-z0-9._~+/=:-]{16,512}$`, ce qui empêche
    toute injection de ligne.
  - Test envoyé à l'hôte du fournisseur seulement. Les écritures exigent la
    même origine (`sameOriginOnly`).
  - Instance de test : mode hors ligne (`MODEL_CATALOG_FIXTURES`), où une clé
    finissant par `-valid` est acceptée.
  - Le serveur retire `OPENROUTER_API_KEY` et `NVIDIA_API_KEY` de
    `process.env` au démarrage (copie privée `BOOT_PROVIDER_KEYS`), et
    `dispatch.mjs` les retire de l'environnement de ses fils : aucun processus
    qui n'en a pas besoin ne les reçoit.
  - La clé OpenRouter vient du `.env` d'un autre projet de l'utilisateur. Elle
    a été copiée une seule fois, sur son autorisation explicite (« Utilises la
    meme clef »).
- Enregistrement : `PUT /api/model-routing/:task {provider, model}` ou
  `{default:true}`.
  - Les choix vont dans **`model-routing.json`** (racine, non versionné), et
    jamais dans config.json, qui est partagé par plusieurs chefs.
  - Écriture en temp + rename, avec un historique `{at, task, from, to, by}`
    borné à 500 entrées.
  - Tout est validé : type, fournisseur, identifiant, et présence dans la
    liste quand celle-ci est connue.
- Désactiver à chaud : `"ui": {"modelRouting": false}`, ou `?models=0` pour un
  seul navigateur.
- Recettes :
  - `_test_model_routing.mjs` ;
  - HTTP `model-routing` ;
  - navigateur `models-view` et `models-mobile`.

  L'instance de test lit des listes de fixtures (`MODEL_CATALOG_FIXTURES`,
  dont `local-tools.json`), sans réseau, et sans clé OpenRouter.

## Pipelines — phase 1 : observation (0.41.0)

Demande utilisateur : « Il faut que toute entree dans l'orchestrateur passe par
les pipelines decides dans la page Models ». Plan et décisions :
`docs/PLAN-pipeline-enforcement.md`.

- **Rien n'est imposé** pour l'instant. Chaque entrée est classée (pipeline et
  mode) et journalisée dans `logs/pipeline-observe.ndjson` par
  `scripts/pipeline-observe.mjs` (classifieur à règles `règles-v1`).
  - Les entrées : `/api/dispatch` (dashboard ou Android × chef, @mention,
    musicien), `dispatch.mjs` hors serveur (`dispatch-cli`, appelant déduit du
    cwd), réveil, relais dans les deux sens, notify, session neuve, **terminal
    interactif** (une ligne validée = une entrée), et un filet de sécurité dans
    `spawnDirectDispatch`.
  - **Inclassable = Discussion** (règle utilisateur).
- **Une entrée n'est comptée qu'une fois** : l'identifiant d'observation voyage
  dans la file, le pool et le corps du POST de `dispatch.mjs` (`obsId`), puis
  jusqu'au tour (`ORCH_OBS_ID`). `dispatch.mjs` le retire de son environnement :
  sinon l'outil Bash du chef en hériterait et ses dispatches ne seraient plus
  observés.
- **L'observation ne bloque jamais un dispatch** : import dynamique et try/catch
  dans `dispatch.mjs`, `observeEntry()` qui avale ses erreurs côté serveur.
- Lecture : `GET /api/pipeline-observe?n=`, et le panneau « Observation » de la
  page Models.
- **Étapes action / jugement** (`JUDGE_STEPS`, `scripts/model-pipelines.mjs`).
  - NVIDIA et OpenRouter n'ont pas encore de harnais d'agent
    (`AGENT_HARNESS = false`). Ils restent visibles, mais grisés « 🔧 outillage
    en construction » sur une étape d'action, et le serveur répond 409.
  - Passer `AGENT_HARNESS` à `true` seulement quand la phase « Outillage » est
    livrée (codex et OpenRouter, passerelle Responses → chat pour NVIDIA ;
    voir le plan §2.7).
- Projet pilote dédié : `pipelineLab` (`I:\Dev\pipelineLab`, `npm test`), le
  seul projet où les phases suivantes seront mises en service d'abord.
- **Décision Q9 (0.42.0)** : quand la classification hésite entre léger et
  complet pour du développement, le mode est **léger** (`modeUncertain`). Le
  classifieur compare tout **sans accents**, car l'utilisateur tape souvent sans.
- **Lacunes (0.42.0)**. Règle utilisateur : « si il manque des taches, ou une
  etape ne peut pas etre classee en une tache precise, il faut remonter
  l'information en proposant une solution ».
  - **Détection** : `detectGap()` dans `pipeline-observe.mjs`.
    - Il y a lacune pour une demande d'**action** qu'aucun pipeline ne
      reconnaît, ou pour un classement flou (égalité entre deux pipelines).
    - Les remarques, les questions et les messages internes (`[…]`, réponses
      relayées) ne sont pas des lacunes.
    - Le signalement est porté par l'enregistrement d'observation (`gap`), avec
      une proposition et une alternative.
  - **Lecture et décisions** :
    - `GET /api/pipeline-gaps` regroupe les signalements par clé ;
    - les décisions vont dans `model-routing.json` (`gapDecisions`) ;
    - **Accepter** écrit l'ajout dans `custom` (pipelines, steps, variants,
      attach), appliqué par `applyCustom()` de `model-pipelines.mjs`. Le
      fichier versionné n'est jamais touché.
  - **Notification** : une seule fois par lacune au chef (`source:
    'pipeline-gap'`), par `observeEntry` ou par un balayage toutes les 60 s
    pour celles vues par `dispatch.mjs`. Au démarrage, ce qui est déjà connu
    n'est pas re-signalé.
  - **Signalement explicite** : `POST /api/pipeline-gaps`, proposition
    validée (`kind`, identifiants en slug).
  - Recettes : `_test_pipeline_gaps.mjs`, HTTP `pipeline-gaps`, navigateur
    `gaps-view`.
- Recettes :
  - `_test_pipeline_observe.mjs` : vraies demandes du fleet, terminal, câblage
    de chaque entrée, vrai `dispatch.mjs` ;
  - HTTP `pipeline-observe` ;
  - navigateur `observe-view` et `models-harness`.

## Double model (0.44.0)

Demande utilisateur : « on peut donner 2 models (1 par defaut), et si 2 sont
precises, on lance la tache sur les 2, puis le 1er relis le tout pour en tirer
le meilleur des 2 ».

- **Page Models** : un menu « Principal » (`.mr-select`) et un menu « Second
  (optionnel) » (`.mr-select2`, `data-role="second"`) par étape et par
  variante.
  - `PUT /api/model-routing/:task {…, role: 'second'}`, stocké dans
    `assignments[case].second`.
  - Mêmes validations que le principal. Le second exige un principal (409).
    Retirer le principal retire le second.
  - Si principal = second : réponse `warning`.
- **Exécution** : `dispatch.mjs --model A --second-model B
  [--second-provider] [--dual-mode action|judge]` délègue à
  `scripts/dual-run.mjs`, **après** la file. Une demande mise en file garde
  `secondModel`, `secondProvider` et `dualMode` (server.js : file, drain,
  `spawnDirectDispatch`).
  - Les branches sont des `dispatch.mjs --dual-branch <run>:<rôle> --dual-cwd
    <worktree>` : log, session et `.pid` sous `logs/dual/<run>/`, jamais ceux
    du musicien. `--dual-cwd` n'accepte que `logs/dual/wt/…`.
  - La relecture est un `dispatch.mjs --dual-synthesis <run>`. Elle n'écrit
    pas de `user_prompt` : elle prolonge le tour ouvert par le parent, donc
    **un tour** au journal.
  - Événements dans le log du musicien : `user_prompt.dual`, `dual_start`,
    `dual_progress` (toutes les 60 s), `dual_branch_done`,
    `dual_branch_failed`, `dual_review_start`, puis le result de la relecture
    et `dual_summary`.
  - Le journal (`turn-core.js`, `t.dual`) et le panneau (`activite.js`,
    encadré « ×2 ») les lisent.
- Refus avant toute écriture :
  - projet sans git, NVIDIA / OpenRouter ou model incohérent avec son
    provider → 64 ;
  - dépôt non propre → 65.

  Codes de fin : 0 relecture faite, 2 pause (le principal a échoué).
- **Exécution interrompue** (parent tué) : au lancement double suivant sur le
  même projet, `recoverInterrupted()` archive chaque branche `dual/*` restante
  (non commité compris) en `logs/dual/<run>/<rôle>.interrupted.diff`, supprime
  les worktrees et les branches, puis clôt le tour resté ouvert
  (`system/dual_interrupted` et `result/error_dual_interrupted`).
- Recettes :
  - `_test_dual_model.mjs` : vrai dispatch, faux claude
    (`FAKE_CLAUDE_ECHO_MODEL`, `FAKE_CLAUDE_WRITE`, `FAKE_CLAUDE_MERGE`,
    `FAKE_CLAUDE_FAIL_MODEL`), copie git de `pipelineLab` ;
  - section « second » de `_test_model_routing.mjs` ;
  - HTTP `model-routing` ;
  - navigateur `models-dual`.

## Pipelines obligatoires — phase 2 : outillage NVIDIA / OpenRouter (0.47.0)

Demande utilisateur (2026-10-09) : « est-ce que l'on utilise les pipeline
specifies plutot ? Sinon, il faut faire en sorte que ces pipelines soient
obligatoirement utlises. » Les phases 2 à 7 de `docs/PLAN-pipeline-enforcement.md`
sont lancées dans l'ordre. Ce paragraphe décrit la phase 2. L'état et la phase
suivante sont tenus dans le plan.

- **codex = harnais unique hors Claude.** Usage : `dispatch.mjs <p> "<demande>"
  --provider nvidia|openrouter --model <éditeur/model>`.
  - Le model est toujours explicite : sans lui, exit 64, sauf
    `nvidiaModel` / `openrouterModel` dans le projet.
  - Erreur d'API → `fallback_refused` + `error_model_unavailable` (pause,
    décision n° 8), aucun repli.
- **OpenRouter** : en direct, en Responses.
  - La clé (`.env`) va seulement à ce fils, via `env_key`.
  - `ORCH_OPENROUTER_BASE_URL` sert aux tests.
- **NVIDIA** : passerelle `scripts/responses-gateway.mjs`
  (`mountGatewayRoutes`, routes `/api/llm-gateway/nvidia[-web]/v1/…`).
  - Boucle locale seulement ; jeton `derivedToken(root, 'gateway')`
    (`scripts/local-secret.mjs`, secret `.orchestrateur-secret`, gitignoré).
  - Clé NVIDIA côté serveur seulement.
  - **NVIDIA est appelé sans flux** : en flux, kimi-k3 laissait fuir ses jetons
    de modèle.
  - **NVIDIA est appelé avec le « thinking » coupé** (0.47.1,
    `extraBody: {chat_template_kwargs: {thinking: false}, temperature: 0.6,
    top_p: 0.95}`) : sinon kimi-k3 dégénère dès le deuxième tour d'outils.
  - Messages assistant consécutifs fusionnés ; outils « namespace » et
    `web_search` natif retirés ; `web_fetch` servi par la passerelle si le
    projet a droit au web.
  - `ORCH_GATEWAY_UPSTREAM_NVIDIA` sert aux tests.
- Clé et jeton exclus des commandes du model : motifs par défaut de codex, plus
  `shell_environment_policy.exclude`.
- Bac à sable selon les `allowed-tools` : `-s read-only` sans Edit, Write ni
  Bash. Le bac à sable Windows `elevated` vient du `config.toml` du poste : sans
  lui, chaque commande passe par le relecteur automatique de
  `--approve-for-me`, qui appelle le même fournisseur.
- `AGENT_HARNESS` vaut true pour nvidia et openrouter. La règle « en
  construction » reste disponible.
- **Dispatch serveur pas encore redémarré** : la route de la passerelle n'existe
  pas. Un tour `--provider nvidia` échoue alors en `fallback_refused`
  (passerelle 404). OpenRouter marche sans redémarrage.
- **Disponibilité NVIDIA** (2026-10-09) : la cascade du failover est presque
  morte (n° 2 et n° 4 retirés, n° 3 en 500, n° 1 kimi-k3 très lent). Voir le
  plan, §2.7.
- Recettes :
  - `_test_responses_shim.mjs` (bout en bout réel avec faux fournisseurs) ;
  - HTTP `harness-nvidia`.

## Pipelines obligatoires — phase 3 : le moteur (0.48.0)

Suite de la demande du 2026-10-09. Plan : `docs/PLAN-pipeline-enforcement.md`.

- **Mise en service** : `model-routing.json` → `enforcement {projects,
  pipelines}`, relu à chaque dispatch.
  - Écriture par `node scripts/pipeline-enforce.mjs on|off <projet>` ;
    `off --all` est le retour arrière.
  - Lecture : `GET /api/pipeline-enforcement`.
  - En service : **pipelineLab**. Pipelines en service : `discussion`, `dev`
    (léger ; le mode complet arrive en phase 4 et tourne en léger d'ici là,
    avec une note).
- **Porte** : `dispatch.mjs`, avant toute écriture, sur un projet en service :
  - une demande sans `--pipeline` est classée (`classify` de
    pipeline-observe) ;
  - un pipeline pas en service donne un tour ordinaire, avec la trace
    `pipelineBypass` et `system/pipeline_bypass` ;
  - `--model` / `--second-model` sont refusés (64) ;
  - un dispatch lancé depuis le tour d'un musicien (`ORCH_TURN_PROJECT`, posé
    dans l'env de chaque tour, et pas le chef) est refusé (65) ;
  - depuis une étape (`ORCH_TURN_STEP`), tout dispatch est refusé (65) ;
  - `--hors-pipeline "raison"` : tour ordinaire, tracé.

  Limite connue : un musicien qui efface ces variables échappe au refus n° 2
  (même niveau que `sameOriginOnly`). Les tours d'étape, eux, exigent un jeton.
- **Moteur** : `scripts/pipeline-engine.mjs` (`runPipeline`), après la file.
  - `logs/runs/<run>/run.json` (état ; reprise par `--pipeline-resume` ou par
    « continuer » si l'exécution est en pause), plus un log par étape
    `<nn>-<étape>.jsonl`.
  - Artefacts : `<projet>/.orchestrateur/runs/<run>/`, exclus de git (ajout
    à `.git/info/exclude`).
  - Côté musicien, **un seul tour** : `user_prompt.pipeline` (étapes, cases,
    models), `system/pipeline_*` (frise, `pipeline_progress` toutes les
    30 s), puis UN result, ou une pause (texte synthétique + result
    `NEEDS_USER_INPUT`).
- **Étape** : `dispatch.mjs --pipeline-step <run>:<clé> --pipeline-session
  <groupe>`, avec `ORCH_STEP_TOKEN`.
  - Le jeton est signé par HMAC (`derivedToken(root, 'pipeline-step')`). Il
    est vérifié (run, clé, projet, model, ou second pour une branche double)
    puis retiré de l'env.
  - Case avec un second : l'étape tourne via `runDual`, dans le log de
    l'étape. Avant une action en mode double, un commit de point d'étape est
    fait ; tout commit postérieur au départ est replié (`reset --soft`) avant
    Livrer.
- **Critères** : `checkCriteria`, voir la liste du CHANGELOG 0.48.0. Les
  commandes viennent du `.orchestrateur/pipeline.json` versionné du projet.
  - Un essai refusé est annulé (empreintes `git hash-object -w`).
  - Limites : `LIMITS`, réglables en test par `ORCH_PIPE_*`.
- **Fake claude** : `FAKE_CLAUDE_PIPELINE=1` joue chaque étape ;
  `FAKE_PIPE_BAD=<étape>[:n]` triche, `FAKE_PIPE_REVIEW=problemes[:n]`.
- Recettes :
  - `_test_pipeline_engine.mjs` (62 contrôles, vrai dispatch) ;
  - HTTP `pipeline-run`, `pipeline-bypass`, `pipeline-unavailable` et
    `pipeline-limit-notice` (le fixture omega devient un dépôt git) ;
  - navigateur `run-timeline`.
- **Redémarrage nécessaire** pour les routes, le journal (`turn-core.js`) et
  le nettoyage de l'env du serveur. Le moteur et la porte (`dispatch.mjs`)
  sont actifs tout de suite.

## Pipelines obligatoires — phase 5 : toutes les entrées branchées (0.52.0)

Suite de la demande du 2026-10-09. Plan : `docs/PLAN-pipeline-enforcement.md`.

- **Classement** : `scripts/pipeline-classify.mjs` (`classifyEntry`), appelé
  par la porte de `dispatch.mjs` pour toute demande sans choix explicite.
  - Il utilise le model de la case `routage.classifier` (Claude seulement,
    via `oneShotClaude`, sans outils).
  - Sortie JSON validée, une nouvelle tentative, puis les règles
    (`règles-v1`), avec une note.
  - Chaque décision du model est comparée aux règles dans
    `logs/pipeline-classify.ndjson`.
- **Aucun tour hors pipeline** sur un projet en service. Un pipeline pas
  encore en service donne une Discussion, avec
  `classification.notInService` et une note. Seule sortie :
  `--hors-pipeline`.
- **Refus visibles** : les refus du moteur avant le départ écrivent
  `user_prompt` et `result/error_pipeline_refused` dans le log du musicien.
- **Sélecteur** : `#composer-pipeline` (dashboard) et `PipelineChoice`
  (Android). Le corps `/api/dispatch` reçoit `pipeline` et `pipelineMode`.
  - Côté serveur : `pipelineOptsFrom()`, `pipelineArgs()` et
    `withPipelinePrefix()`.
  - Le choix suit l'accès direct, l'@mention, la file, `spawnDirectDispatch`
    et la session neuve.
  - Vers le chef, il devient un préfixe `/dev /complet`.
- **Session neuve** sur un projet en service : `spawnDirectDispatch`, puis
  202 `{pipeline: true}`, sans sidecar.
- **Terminal routé** : `enforcement.terminal`, réglé par `pipeline-enforce.mjs
  on|off --terminal`, et désactivé par `off --all`.
  - Module `scripts/terminal-route.mjs` (`TerminalRouter`,
    `discussionArgs`, trames OSC `OrchRoute`).
  - Le serveur retient les lignes d'action, envoie `route-confirm`, et
    attend `{type:'route', id, action: run|discuss|cancel, project?}`.
  - La lecture seule s'applique au **prochain lancement** du claude central.
  - Aucun client du dashboard n'ouvre `/ws/pty` aujourd'hui : le protocole
    est servi et testé, mais il n'y a pas d'interface.
  - Doublure de test : `ORCH_CENTRAL_CMD` (JSON `[exe, …args]`), posée par
    l'instance de régression.
- Fake claude : `[CLASSIFY]`, `FAKE_CLAUDE_CLASSIFY`,
  `FAKE_CLAUDE_CLASSIFY_LOG` et `--orch-fake-interactive`.
- Recettes :
  - `_test_pipeline_entries.mjs` ;
  - HTTP `pipeline-all-entries` et `terminal-routing` ;
  - navigateur `composer-pipeline` ;
  - Android `testDebugUnitTest`.
- **Redémarrage nécessaire** pour le serveur : sélecteur transmis à la file
  et à l'@mention, préfixe vers le chef, session neuve, terminal. Le
  classement par model et la règle « aucun tour hors pipeline » sont dans
  `dispatch.mjs` : ils sont actifs tout de suite.

## Pipelines obligatoires — phase 6, lot A : autres pipelines (0.53.0)

- **Catalogue** : `scripts/pipeline-catalog.mjs`, données pures.
  - Pipelines : incident, recherche, audit, maintenance, nouveau, donnees,
    redaction.
  - Chaque étape porte : `id`, `chain` (cases), `artefact`, `kind`
    (`judge|action|deliver`), `role` (consigne), `checks` (critères), et
    éventuellement `crit` (réutilise `rouge|vert|livrer` du Développement),
    `loop`, `prerun: 'scans'`, `independent` et `ifChanged`.
- **Moteur** :
  - `checkCatalogCriteria` (sections, sources, chemins, JSON, lecture
    seule, `headUnchanged`, `nothing`, `onlyGlobs`, `protectTests`,
    `suiteTwice`, `requireFiles`, `reloadConfig`) ;
  - `catalogStepPrompt`, qui annonce les critères en lignes `ATTENDU_*`,
    `MODIFIER=`, `MARQUEUR_RIEN=` ;
  - `runScanners` ;
  - le second avis : fichiers `independent` retirés pendant le tour ;
  - la boucle bornée par le budget des tours de revue ;
  - la livraison `ifChanged` sautée quand rien n'a changé ;
  - le résultat final via `catalogResult`.
  - `ENGINE_PIPELINES` = discussion, dev + catalogue.
- **Ajouter un pipeline** : une entrée dans le catalogue, puis une section
  dans `_test_pipeline_catalog.mjs`. Le faux claude joue toute étape du
  catalogue à partir des lignes `ATTENDU_*` (`FAKE_PIPE_NOTHING`,
  `FAKE_PIPE_REMAINING`, `FAKE_PIPE_SEEN_LOG`, `FAKE_PIPE_BAD`).
- **Classement par model, tout fournisseur** (`callerFor` de
  `pipeline-classify.mjs`) :
  - claude et codex en CLI (`oneShotCodex`, doublure
    `tests/fake_codex/fake_codex.mjs`) ;
  - OpenRouter et NVIDIA en API chat (`chatCompletion` de `language.mjs`,
    clé du `.env` de l'orchestrateur).
- **Mise en service** : `node scripts/pipeline-enforce.mjs pipelines all`
  (ou une liste qui contient `discussion`).
- Recettes : `_test_pipeline_catalog.mjs`, HTTP `pipeline-catalog`.

## Pipelines obligatoires — phase 6, lot B : Routage, le tour du chef (0.54.0)

- `S.routage` dans `pipeline-catalog.mjs`, avec deux modes : `demande`
  (`lire, classifier, decomposer, affecter, dispatcher, rapporter`) et
  `callback` (`lire, callback, rapporter`). Pas de git : `needs.git:false`,
  donc empreinte `walkSnapshot` et restauration à partir du contenu gardé.
- **Branchement** (`dispatch.mjs`, `CHEF_ROUTED`) : un tour du chef ou d'un
  slot, avec `enforcement.chef === true`, sans `--hors-pipeline`, part dans
  `runPipeline({pipeline:'routage', mode, ticket, slot})`.
  - Le mode est `callback` si la source est `wake` ou si le texte commence
    par `[CALLBACK_WAKE`.
  - `--model` est refusé (64).
- **Étapes de code** (`CODE_STEPS` du moteur) :
  - `affecter` relève les models des cases et écrit `affectation.md` ;
  - `dispatcher` lance un `dispatch.mjs` détaché par tâche (`--callback`,
    `--source chef`, `--queue-if-busy`, `--pipeline` seulement si le projet
    est en service) et écrit `dispatch.json`. Il refuse sous
    `DISPATCH_REPORT_ONLY`.
- `validateTasks` : liste blanche, jamais le chef, pas de Routage délégué,
  6 tâches au plus.
- `conversationExcerpt` : la fin du log du chef.
- `skipIf` : saute une étape d'après le JSON d'une étape précédente.
- `jsonEnum`. Pour une `question`, le texte de la question est obligatoire.
- **Mise en service** : `node scripts/pipeline-enforce.mjs on --chef`
  (désactivé par défaut ; décision de l'utilisateur, comme la phase 7).
- Fake claude : `FAKE_PIPE_JSON='{"<étape>":{…}}'` et `ATTENDU_ENUM`.
- Recettes : `_test_pipeline_routage.mjs`, HTTP `pipeline-routage`.

## Pipelines obligatoires — phase 6, lot C : Images, Vidéo, Audio (0.55.0)

- Définitions : `scripts/pipeline-catalog-media.mjs` (`MEDIA_PIPELINES`),
  fusionnées dans le catalogue.
- Contrôles : `scripts/media-check.mjs` (`checkMediaFiles`, `listedFiles`,
  `imageSize`, `findFfprobe`, `wordErrorRate`).
  - `ORCH_FFPROBE=<chemin>|none` force la découverte de ffprobe (les tests
    mettent `none`).
- **Critère `media: {kind, min, optionalWith}`** : les fichiers de la section
  « ## Fichiers » de l'artefact sont vérifiés. Ils peuvent se trouver dans le
  projet ou dans le dossier d'exécution. Une étape média réussie n'exige donc
  pas de modifier le projet.
  - `mediaByVariant` change le type attendu.
  - `wer: true` mesure la transcription contre `reference.txt` ou
    `cfg.werReference` (maximum `cfg.werMax`, 0,35 par défaut).
- **Variantes** (`variants: {nom: regex}` sur la demande sans accents, la
  première qui correspond) : la case `pipeline.étape.variante` passe en tête
  de `chain`.
- **Outil local** : `localToolFor(assignments, chain)` repère une case
  `provider: 'local'`. L'étape reçoit `OUTIL_LOCAL=`.
- La vérification reçoit `ctx.lastMedia`. Les fichiers produits sont listés
  dans le résultat final (`state.media`).
- Fake claude : `MEDIA=` produit un vrai petit fichier (PNG, WAV, texte,
  en-tête MP4) ; `FAKE_PIPE_TRANSCRIPT`.
- Recettes : `_test_pipeline_media.mjs`, HTTP `pipeline-media`.

## Pipelines obligatoires — phase 7 : mise en service générale (0.56.0)

- **En service** : 20 projets sur 33, le chef en Routage, le terminal routé.
  Le tableau nominatif est local : `logs/pipeline-onboarding.md` et `.json`.
  Le dépôt est public : n'y écrire **aucun nom de projet privé**.
- **Intégrer un projet** : `scripts/pipeline-onboard.mjs --plan <plan.json>
  [--dry-run] [--apply]`.
  - Le plan contient les commandes de test **vérifiées vertes**.
  - Éligibilité : git à la racine, suite verte, arbre propre, pas de tour en
    cours.
  - `.claude/` : non suivi ⇒ `.git/info/exclude` ; réglages suivis ⇒
    `skip-worktree`.
  - `pipeline.json` : un commit dédié, sans push ; il reste local pour une
    branche divergée.
- **`isLocalOnly`** (moteur) : `.claude/` et les artefacts d'exécution ne
  comptent ni pour l'arbre propre, ni pour les empreintes, ni pour « rien à
  livrer ». Une livraison qui les commiterait est refusée.
- **Relevé** : `scripts/pipeline-health.mjs` (`computeHealth`),
  `GET /api/pipeline-health` (cache de 30 s, `?refresh=1`), panneau
  « 📈 Mise en service » de la page Models.
  - Il compte, depuis `enforcement.generalSince` : exécutions, hors
    pipeline, tours ordinaires, refus du moteur, refus de la porte
    (`logs/pipeline-gate.ndjson`, écrit par `gateDie` de `dispatch.mjs`),
    pauses.
  - Il calcule les jours complets sans contournement, avec un critère de
    7 jours.
- **Retour arrière** : `pipeline-enforce.mjs off <projet>`, `off --chef`,
  `off --terminal`, `off --all`. Détail dans le plan, « État livré de la
  phase 7 ».
- Recettes : `_test_pipeline_onboard.mjs`, HTTP `pipeline-health`,
  navigateur `health-view`.

## Routage : contexte, « suite », lacunes tardives (0.57.0)

- **`routingContext`** (moteur) écrit `contexte.md` avant Lire. Il contient :
  - la dernière réponse du chef et ses questions ;
  - les questions en attente des musiciens ;
  - les entrées « EN ATTENTE » du `TODO_LIST.md` du chef ;
  - les tâches en attente.
- **Classifier** : `suite | taches | reponse | question | lacune`.
  `skipIf.unless` accepte une liste : Décomposer, Affecter et Dispatcher
  tournent pour `taches` et `suite`.
- **Tâches ordonnées** : un champ `apres` (n° d'une tâche précédente) fait
  attendre la tâche dans `logs/routage-pending.json`. Le mode réveil passe
  par l'étape **Relancer** (code), qui la lance après un result réel de la
  tâche attendue.
- **Lacunes** : l'observateur a l'option `deferGap`. Pour un message au chef
  routé ou à un projet en service, aucune lacune n'est signalée à
  l'observation : le Routage la signale (`emitRoutingGap`) si le Classifier
  conclut à « lacune », et la porte de `dispatch.mjs` seulement si le
  classement a fini par les règles.
- Rejet avec motif : `decideGap(…, {reason})`.
- Recette : `_test_pipeline_routage.mjs`, sections 8 et 9.

## Tâches du Routage en attente : jamais bloquées (0.58.0)

Signalement utilisateur : « A nouveau, orchestrateur est termine, et plus rien
ne se passe. Il faut corriger la situation ».

- **Propriétaire unique** : `scripts/routage-pending.mjs`, pour
  `logs/routage-pending.json` (verrou, écriture atomique, identifiants).
  - CLI : `list [--json]`, `release [<id>…] [--force]`,
    `drop <id>… | --run <routage> [--projet <p>] | --all`.
  - **Ne jamais éditer le fichier à la main.**
- **Libération mécanique** (`releaseReady`) :
  - à la fin de CHAQUE tour, par le crochet `process.exit` de `dispatch.mjs` ;
  - par l'étape Relancer ;
  - par le balayage serveur de 60 s (après redémarrage).
  - Pas de LLM, ni de réveil du chef nécessaire.
- **Dépendance** : `after: {projet, offset, key}`, c'est-à-dire la position
  dans le log de la tâche attendue au lancement, puis le texte de sa demande.
  Un `result` fantôme ou celui d'un autre tour ne comptent pas.
- **Reprise** : une tâche `reprise: <run>` part en `--pipeline-resume`. Le
  `dispatcher` la détecte aussi d'après un identifiant cité.
- **Doublons** : refusés, sur la clé projet + exécution reprise (ou texte).
- **Tous les `result` sont horodatés** par `dispatch.mjs`.
- **Actif tout de suite** (`dispatch.mjs`, moteur, catalogue) : reprise,
  libération en fin de tour, dépendance, dédoublonnage, CLI.
- **Après redémarrage** (`server.js`, `public/app.js`) :
  - réveil du chef pour ses tâches (le pump lit `callback` d'un prompt
    sourcé) ;
  - balayage avec signalement des attentes de plus de 2 h ;
  - `restartRequired` dans `/api/version` et `/api/pupitre`, et dans le pied
    de page.
- Recettes : `_test_routage_pending.mjs`, HTTP `routage-pending`.

## Langue de discussion (0.51.0)

Demande utilisateur : « La langue de la discussion doit pouvoir etre fixee et
tu dois t'y tenir. Seul le code et les documents qui s'y attachent doivent etre
en anglais » — y compris pour les musiciens, « si la langue choisie n'est pas un
probleme pour le model utilise ».

- **Réglage** : `language-settings.json`, non versionné, écrit par le serveur
  seulement.
  - Contenu : `default`, `projects` (exceptions), `models` (overrides),
    `reformulateModel` et `check`.
  - Module : `scripts/language.mjs`.
  - Routes : `/api/language`, `/api/language/project/:name`,
    `/api/model-languages` et `POST /api/model-languages/test`, toutes en
    `sameOriginOnly` pour les écritures.
  - Interface : panneau ⚙ (`public/langue.js`), page Models (« 🌐 Langues des
    models ») et app Android (Réglages).
- **Injection** (`dispatch.mjs`) : `languageRule(target, working)` est ajoutée
  à la fin de CHAQUE prompt, chef compris.
  - `working` vaut `en` quand le model ne maîtrise pas la cible
    (`reliableLanguages` : override, puis règle de `data/model-languages.json`,
    puis anglais par défaut).
  - Traçabilité : `user_prompt.lang`.
- **Portier** (`gateFinalText`) : il agit sur les tours destinés à
  l'utilisateur, c'est-à-dire ni les branches du mode double ni les tours
  d'étape.
  - Claude : la ligne `result` est retenue jusqu'à la fin du flux
    (`releaseHeldResult`).
  - codex : `finishCodex` est asynchrone, et le portier passe avant le result.
  - Moteur : le résultat final passe par le portier ; les messages de
    l'orchestrateur passent par `localize`.
  - En cas d'écart : `system/language_mismatch` et un message assistant
    synthétique `lang` (avec `original`), puis le result reformulé
    (`result.lang`).
- **Détection** (`detectLanguage`) : part des mots-outils sur la prose, après
  avoir retiré le code, les chemins, les URL et les identifiants.
  - Moins de 12 mots, ou un écart insuffisant : `unknown`, pas de jugement.
  - Reformulation : `oneShotClaude` (CLI, cwd temporaire, aucun outil, aucune
    clé).
- **Lecture** : le fil du chef (`app.js` en direct, `/api/conductor-chat`
  après redémarrage) et le journal (`turn-core.js`, `activite.js`) affichent
  le badge « ⚠ langue » et « voir l'original ».
- Fake claude : `FAKE_CLAUDE_DUMP_PROMPT`, `FAKE_CLAUDE_REPLY`,
  `FAKE_CLAUDE_TRANSLATION` et `FAKE_PIPE_LANG=en`.
- Recettes :
  - `_test_language.mjs` (48 contrôles, vrai dispatch) ;
  - HTTP `language-settings` ;
  - navigateur `lang-settings`, `lang-badge` et `models-langs`.
- **Nouveaux fichiers de code : commentaires en anglais.** Un fichier existant
  garde sa langue tant que l'utilisateur n'a pas décidé (liste fournie le
  2026-10-09).

## Pipelines obligatoires — phase 4 : Développement complet (0.49.0)

- **Plan complet** (`devCatalog`, `planSteps`) : Comprendre → Concevoir →
  Liste de tests → `@loop` → Revue → Livrer.
  - `@loop` lit `tests.md` (`parseItems`) et insère `rouge, vert, refactor,
    @check` pour le premier item non coché. `@check` coche cet item
    (`checkItem`) : c'est le moteur qui coche, jamais le model.
  - La boucle se termine quand la liste est vide.
  - L'item voyage dans le prompt (`ITEM=<n>: …`) et dans les événements
    (`pipeline.item`).
- **Critères** :
  - `plan.md` : au moins deux sections `##` ;
  - `tests.md` : au moins une case `- [ ]`, et au plus `LIMITS.items` (15) ;
  - 4c : tests inchangés et suite verte. Avec `RIEN_A_REFACTORER`, aucune
    modification n'est permise. 4c est sautée (`skipped`, motif écrit) si 4b
    a changé moins de `refactorMinLines` (10) lignes (`lineDelta`).
- **Item déjà couvert** (décision utilisateur Q10 « A », 0.50.0). Un 4a dont
  le test passe d'emblée est accepté (`covered`) si :
  - `rouge.md` contient `DEJA_COUVERT` ;
  - seuls des tests ont changé ;
  - toute la suite passe.

  4b et 4c de cet item sont retirées du plan et tracées `skipped` avec leur
  motif. L'événement `pipeline_item_covered` est écrit, et la Revue reçoit la
  liste `coveredItems`. Sans `DEJA_COUVERT`, le refus strict s'applique, avec
  l'indication.
  - **0.57.2** : la règle vaut aussi en **mode léger**, sans item ; c'est
    alors la demande qui est déjà couverte, et 4b est sautée.
  - La déclaration exige une **preuve vérifiée** (`coveredProof`) : commit
    existant, ou fichier de production `fichier[:ligne]` existant.
  - Un refus de forme d'une déclaration honnête (preuve absente, test non
    réécrit) ne compte pas dans la limite, une fois par étape
    (`pipeline_retry_not_counted`).
  - Livrer et le résultat final la mentionnent.
  - Les étapes du catalogue qui réutilisent le critère `rouge` (Incident)
    n'acceptent pas `DEJA_COUVERT`.
  - À la précondition « base verte », `classifyTestFailure` signale à part un
    échec d'environnement (réseau, délais : `cause: environment`).
  - Recette : `_test_pipeline_covered.mjs`.
- **Durée active** (0.50.0) : la limite compte `activeMs` (cumul des sessions
  d'exécution), jamais le temps passé en pause.
- **« continuer » après une limite** (0.50.0) :
  - `state.pausedLimit` est gardé ;
  - à la reprise, `state.budgets[items|duration|review]` accorde UNE
    allocation de plus, de la même taille ;
  - l'événement `pipeline_limit_extended` est écrit.

  Les valeurs de `LIMITS` restent celles décidées par l'utilisateur (n° 5).
- **Revue** : elle ne relève jamais l'absence de version, de CHANGELOG ou de
  ligne d'exigence. C'est l'étape Livrer qui les ajoute et les fait vérifier.
- **Constats non testables** (retour utilisateur, 0.50.1). La Revue rend
  `items` (comportements) et `hors_tdd`. Pour l'ancien format, le tri se fait
  par `isDeliveryFix` (doc, README, registre, CHANGELOG, version,
  commentaires).
  - Les constats hors TDD vont dans `state.deliveryFixes`, sont transmis au
    prompt de Livrer, et un événement `pipeline_delivery_fixes` est écrit.
  - Ils ne deviennent jamais un test et ne consomment ni la limite de tests
    ni un tour de revue.
  - Livrer ajoute **d'office** la ligne du registre des exigences.
- **Messages de pause** (0.50.1) : `pauseForLimit` et `pauseForModel`
  construisent un texte clair (`pauseText`, `progressText`, `plainStep`) :
  - ce qui s'est passé ;
  - l'avancement chiffré ;
  - les quatre réponses et leur effet concret ;
  - la recommandation.

  La ligne `NEEDS_USER_INPUT` liste les réponses et la recommandation, sans
  aucun jargon (4a/4b, critère, commande). Le chef reçoit le texte complet.
- **Réponses à une pause** (`answerPausedRun`, détectées par `dispatch.mjs`) :
  - « continuer » reprend ;
  - « abandonner » et « simplifier » closent l'exécution (`abandoned`) et
    listent les modifications restées ;
  - « changer le model » dit la case à changer et reste en pause.

  Chaque tour de réponse écrit un message assistant : l'état du musicien se
  lit sur le dernier texte du tour.
- **Revue en complet** : chaque problème devient un item `(revue) …`, puis
  retour à `@loop`, au plus 2 tours. En léger : retour à 4b, comme en 0.48.0.
- **Montée léger → complet** : après 4b en léger, `lightScope` mesure le
  changement (plus de 3 fichiers, plus de 150 lignes, ou un nouveau fichier de
  code, hors tests). Au-delà :
  - `state.mode = complet`, `escalated` ;
  - insertion de `liste-tests, @loop` ;
  - événement `system/pipeline_escalate` ;
  - mention dans le résultat.
- **Mode** : `--mode leger|complet`, sinon la classification
  (`pipeline-observe.classify`) : nouvelle fonctionnalité → complet,
  hésitation → léger (Q9), préfixes `/léger` et `/complet`. Le champ
  `pipelineMode` voyage dans la file.
- **Limites** : `items`, `green`, `criteria`, `review` et `duration`. Chacune
  produit `notification/pipeline_limit`, l'état `input` (question) et
  `/api/notify` au chef (`pipeline-limit`). Réglage en test :
  `ORCH_PIPE_ITEMS`, `ORCH_PIPE_REFACTOR_MIN`.
- **Fake claude** :
  - `FAKE_PIPE_ITEMS=<n>` ;
  - `ITEM=k` → `test/pipe-k`, `src/pipe-k` ;
  - `FAKE_PIPE_BIG=1` (montée) ;
  - `FAKE_PIPE_REFACTOR=1`.

  Le 4b léger complète un fichier **existant** : les fixtures ont
  `src/pipe.mjs`.
- Recettes :
  - `_test_pipeline_gates.mjs` (33 contrôles) ;
  - HTTP `pipeline-tdd` et `pipeline-limits` ;
  - navigateur `run-tdd-timeline`.

  Les recettes de la phase 3 forcent `--mode leger`.

## Rouge = vrai incident ; arrêts, essais et attentes neutres (0.47.2)

Remarque utilisateur : « Si il n'y a pas eu de probleme, ca n'aurait pas du
etre affiche en rouge: piplineLab ne repond pas ou processus perdu ».

- **Rouge réservé** à un PID mort sans result et à un stall réel :
  `Salle.alarming(r)`. Le rail, les cadres, l'attention, le bandeau, la vue
  Projets, le pupitre et le volet passent tous par là (ou par
  `healthFlag(r).neutral`).
- **Arrêt volontaire** : `kill-stalled.mjs <p> --by chef|supervision|test|utilisateur
  --reason "…"` écrit `stopped_by`. Les libellés viennent de
  `TurnCore.stopWord` et `stopText` (« ■ Arrêté par la supervision — motif »).
  L'état reste `error`, en gris.
- **Tour d'essai** : `dispatch.mjs … --test "<libellé>"` (ou
  `ORCH_TEST_LABEL`, retiré de l'env des fils) pose `user_prompt.test`. Le
  champ additif `testRun` est affiché « 🧪 test en cours » ou « 🧪 test
  interrompu », jamais en rouge. **Tout tour lancé pour essai par un Claude
  ou un test doit porter `--test`.**
- **Battements** (`runCodex`) : `system/heartbeat {provider, waitingMs,
  intervalMs, text}` quand codex se tait depuis `ORCH_HEARTBEAT_MS` (30 s).
  `lastMeaningful` les ignore. `scanProject` en tire `waitingProvider` : avec
  un battement frais (moins de max(2,5 × intervalle, 90 s)), il n'y a pas de
  stall jusqu'à `PROVIDER_WAIT_MAX_MS` (20 min).
- **Échec fournisseur** : `providerFailureText()` met « ✕ échec : NVIDIA 504
  après 5 min 00 s » en tête du result. La passerelle ajoute « (après N) » à
  ses erreurs.
- Recettes : `_test_neutral_stop.mjs` charge les vrais `salle.js`,
  `projets.js` et `pupitre-row.js` dans un bac à sable vm, et fait tourner le
  vrai dispatch avec une doublure de codex. S'y ajoute la section 3 de
  `_test_responses_shim.mjs`.

## Suggestions de models de l'étude comparative (0.46.0)

Demande utilisateur (« Continue », à la proposition du chef) : afficher dans la
page Models la recommandation consolidée de l'étude comparative, **en
suggestions, sans toucher aux choix**.

- **Source unique** : `data/model-recommendations.json` (versionné), produit à
  partir du rapport `comparaison-models-2026-10.md` (commit a8c5cc2).
  - `report` : date, commit, seuils d'âge (30 jours : « à refaire d'ici 1-2
    mois », 60 jours : dépassé).
  - `catalog` : `remove`, `dominated` et `announced`, chacun avec sa raison et
    sa source.
  - `steps` : les 25 étapes du rapport, avec principal, alternatives
    (`target` + `today` pour un model annoncé, `external` hors listes),
    confiance, section, justification et `undecided`.
  - `slots` : chacune des 102 cases → une étape, éventuellement avec un
    principal propre et une note `extrapolated`.
- **Prochaine étude** : régénérer ce fichier, même schéma. Aucun model n'est
  codé dans `models.js` ni `model-reco.mjs` (le test le vérifie). Le serveur
  relit le fichier quand son mtime change ; un fichier invalide est refusé en
  entier. Le fichier est public : aucun nom de projet privé (testé).
- **Serveur** : `scripts/model-reco.mjs`.
  - `decorateCatalog()` de `model-routing.mjs`, idempotent :
    - un model retiré disparaît des menus ;
    - un model dominé reçoit `dominated {by, reason, source}` ;
    - un model annoncé est ajouté avec `unavailable` (PUT → 409) tant que la
      vraie liste ne le contient pas.
  - `GET /api/model-recommendations`.
  - `POST /api/model-routing/apply-suggestions {mode: one|empty, slots,
    dryRun}` (`sameOriginOnly`) :
    - `empty` ne modifie jamais une case choisie ;
    - une variante qui hériterait de la même suggestion reste vide ;
    - historique `by` : « suggestion du rapport … ».
- **Interface** (`models.js`) :
  - bloc `.mr-reco` (`data-reco`) sous chaque paire de menus ;
  - encadré `.mr-reco-box` avec « Appliquer les suggestions aux étapes vides
    seulement » ;
  - confirmation en ligne (plan venu du `dryRun`, Confirmer / Annuler) ;
  - un choix sur un model retiré est affiché « ⚠ obsolète » (option et
    `data-obsolete-warn`).
- L'effort conseillé (low, medium, high…) est **affiché**, mais n'est pas
  appliqué : aucune case ne porte encore d'effort.
- `claude-haiku-5-5` est ajouté à `ANTHROPIC_VERIFIED`. La CLI 2.1.283 écrit
  `unrecognized_model` sur stderr mais sert bien le model.
- Recettes :
  - `_test_model_reco.mjs` ;
  - HTTP `model-reco` ;
  - navigateur `models-reco` et `models-reco-mobile`.

## Demandes d'autorisation interactives (0.45.0)

Demande utilisateur : « Je n'ai pas vu de moyen d'autoriser (1 fois, pour
toujours) … En clickant dessus je dois voir un overlay avec tous les details.
Il faut donc attendre ma reponse pendant au moins 5 minutes avant de passer. »

- **Mécanisme** (vérifié sur CLI 2.1.283). `dispatch.mjs` (`runClaude`, tous
  les tours claude : musiciens, chef, slots, branches du mode double) passe :
  - `--mcp-config` (un seul serveur, `scripts/permission-mcp.mjs`) ;
  - `--permission-prompt-tool mcp__orch__approve` ;
  - `--disallowed-tools mcp__orch__approve` (le model ne voit pas l'outil ; le
    CLI l'appelle quand même).

  Le CLI appelle `approve {tool_name, input, tool_use_id}` et attend
  `{behavior:'allow', updatedInput}` ou `{behavior:'deny', message}`. Une
  attente de 5,5 min a été vérifiée ; `MCP_TOOL_TIMEOUT` est posé à
  délai + 5 min.
- **Délai** : `permissionTimeoutMin` du projet, puis de `defaults` (5 par
  défaut). `ORCH_PERM_TIMEOUT_MS` sert aux tests. Désactivable par
  `"permissionPrompts": false` (projet ou `defaults`) ou `ORCH_PERM_DISABLE=1`,
  ce qui ramène l'ancien refus immédiat.
- **Serveur** : `scripts/permission-store.mjs` (`createPermissionStore`,
  `mountPermissionRoutes`, montées aussi par la suite de tests).
  - Les demandes sont gardées en mémoire. Le MCP repose la même demande si le
    serveur redémarre (404), avec la même échéance.
  - Événements écrits dans le log du musicien : `system/permission_request`,
    `notification/permission_decision` (`allow_once | allow_always | rule |
    deny | expired`).
  - Décision et règles : `sameOriginOnly`.
  - **Serveur antérieur à 0.45.0** (route absente) : le MCP refuse aussitôt,
    comme avant, en le disant. `dispatch.mjs` peut donc être actif avant le
    redémarrage.
- **Règles « toujours »** : `permission-rules.json` (racine, non versionné ;
  jamais config.json).
  - C'est l'orchestrateur qui les applique (`ruleMatches` de
    `public/permission-core.js`), et non `.claude/settings.json`. Elles
    marchent donc aussi pour les refus de l'analyse de sécurité du CLI
    (commandes composites).
  - Une règle de préfixe `Bash(x:*)` ne couvre **jamais** une commande
    composite.
- **Supervision** : l'état reste `live`, avec l'attribut `awaitingPermission`
  (`deriveState`/`scanProject`).
  - Jamais `stalled`.
  - `fleet-status` garde `LIVE` (les `restart-when-idle*.ps1` du chef y
    lisent « occupé ») et ajoute « ATTEND AUTORISATION — ne pas tuer ».
  - `kill-stalled.mjs` sort en 3 sans rien tuer, sauf avec `--force`.
- **Interface** : `public/permissions.js` + `permissions.css`.
  - `#perm-band` : les cartes.
  - `#perm-overlay` : les détails, la portée, le motif ; le menu ⋮ donne les
    « Autorisations permanentes ».
  - Les anciennes cartes de refus gardent « ✓ Vu » et gagnent « Toujours
    autoriser à l'avenir ».
  - Android 0.9.0 : `PermissionBand.kt`.
- **Codex** : pas d'équivalent propre aujourd'hui.
  - `codex exec` n'a aucun canal d'approbation externe. Le dispatch utilise
    `--approve-for-me`, une revue automatique dans le bac à sable
    workspace-write : ce qui sort du bac à sable est refusé par codex, sans
    attente.
  - Seul `codex app-server` (marqué *experimental* dans 0.154.0) envoie des
    demandes d'approbation à un client. Le brancher remplacerait tout le
    runner codex : à reprendre quand ce protocole sera stable.
- **Limite connue** : les musiciens tournent sous le même compte Windows, et le
  token gate est coupé. Un musicien qui a déjà Bash pourrait forger une
  requête HTTP de décision : la protection est celle des clés API
  (`sameOriginOnly`), pas une barrière absolue.
- Recettes :
  - `_test_permission_prompt.mjs` (faux claude `FAKE_CLAUDE_PERM`, qui lance
    le vrai MCP) ;
  - HTTP `permission-prompt` ;
  - navigateur `permission-card`, `permission-deny` et `permission-mobile`.

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
- Don't disable the network guard (loopback + Tailscale) or the token gate.

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
