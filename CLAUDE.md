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
musician→chef, and by the prompt that opened the chef's turn for
chef→musician (0.137.0: only a chef turn OPENED by the marker is relayed,
never its answers to the user). In-memory only ; server restart may
re-relay the last chef answer at most once.

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
- **Secret scan before any push**: gitleaks is installed outside the PATH,
  `I:\tools\gitleaks\gitleaks.exe` (v8.30.1). Scan the commits about to be
  pushed: `I:\tools\gitleaks\gitleaks.exe git --log-opts="<last pushed>..<tag
  or HEAD>" --redact -v .` — push only on « no leaks found ».

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
Sans copie sous `builds/`, la source du projet est relue à chaque requête
(0.112.0, brouillon de mail `Ayor/mail-retour-reunion`) ; les repères
`[À COMPLÉTER : …]` / `[À VÉRIFIER : …]` sont mis en évidence (`mark.draft-gap`).
Recette : `_test_mail_draft_page.mjs`.

**Tout ou rien.** JSON cassé ou une seule entrée invalide ⇒ le fichier entier
est refusé, la dernière version valide reste servie (jamais de 500) et la
raison est journalisée une fois dans la console et `logs/server-debug.log`.
Si une modification « ne prend pas », c'est là qu'il faut regarder. Une app
sans `latest.apk` s'affiche « APK pas encore publié » au lieu d'un bouton mort.

---

## Prod et dev : `orchestrateur-dev` (0.68.0)

Décision utilisateur (2026-10-10) : la prod reste figée sur une version, le
développement continue sur un autre musicien, et la prod « fera des bons quand
ce sera utile ». Procédure complète : `docs/DEV-PROD.md`.

- **Prod** : musicien `orchestrateur`, `I:\orchestrateur`, port 7777, figée
  sur un tag (`v0.67.1` au départ).
- **Dev** : musicien `orchestrateur-dev` (`devOf: orchestrateur`, `port:
  7778` dans config.json), `I:\Dev\orchestrateur-dev`, branche `dev`.
  - C'est un **clone indépendant**, jamais un worktree : un worktree
    partagerait le `.git` de la prod.
  - Remote `prod` en lecture seule (push URL `NO_PUSH_TO_PROD_REPO`).
  - Fichiers locaux : `.orchestrateur-instance.json` (rôle, port, journaux,
    tag de base), `CLAUDE.local.md` (règles du musicien dev), son propre
    `.token`.
  - Pas de serveur à elle. Une instance vivante ne passe que par le bac à
    sable : `node scripts/regression.mjs --keep --no-suites --no-browser
    --port 7778`. `--port` refuse 7777 et un port occupé.
- **Bond** (décidé par l'utilisateur, jamais par le musicien dev) : tag
  `vX.Y.Z` vérifié dans la dev, puis, dans la prod sans tour en cours,
  `git tag -a prod-before-vX.Y.Z`, `git merge --ff-only vX.Y.Z`, puis
  redémarrage par le chef quand la flotte est au repos, puis non-régression
  sur orchestrateur-dev. **Retour arrière** : `git reset --hard
  prod-before-vX.Y.Z`, redémarrage, non-régression sur orchestrateur-dev.
- **Jamais de non-régression dans la prod** (0.125.0). Règle utilisateur,
  rappelée le 2026-10-20 : « Aucune non regression ne doit se lancer sur
  orchestrateur. C'etait une regle. Uniquement sur orchestrateur-dev ».
  `prod-jump.mjs` n'en prescrit ni n'en lance aucune (après `--apply` :
  « redémarrage par le chef quand la flotte est au repos, puis non-régression
  sur orchestrateur-dev »). `regression.mjs` **refuse** (code 65, avant toute
  écriture) quand sa racine ou `--dir` est une prod (`scripts/prod-guard.mjs` :
  `I:\orchestrateur`, instance `"role": "prod"`, `config.json` qui déclare sa
  dev par `devOf`, `ORCH_PROD_ROOTS` en ajout seulement pour les tests).
  Aucune dérogation. `--prod I:\orchestrateur` (lancé dans la dev) ne fait que
  lire le commit de la prod. Recette : `_test_no_prod_regression.mjs`.
- **`TODO_LIST.md` n'est pas versionné** (0.74.2, « Une TODO list ne devrait
  pas etre dans git ») : `.gitignore`, fichier gardé sur le disque. Au bond,
  `prod-jump --apply` le remet sur le disque de la prod depuis
  `prod-before-vX.Y.Z` (`keptOnDisk`). Un commit de la prod absent de la dev
  bloque le bond : `git fetch prod` puis le fusionner dans `dev` avant le tag.
  Recette : `_test_todo_untracked.mjs`.
- Contrôle : `node scripts/dev-split.mjs check`. Recette :
  `_test_dev_split.mjs`.
- **La dev peut être en service dans les pipelines** (0.113.0, « Il faut que
  orchestrateur-dev fonctionne avec des pipelines », option A). **État réel au
  2026-10-20 : HORS service** — l'utilisateur l'a retirée de
  `enforcement.projects` le 2026-10-19 ; décision 18 de
  `docs/PIPELINES-SYNTHESE.md` : la remettre en service après le bond de la
  phase 0 des pipelines (`pipeline-enforce.mjs on orchestrateur-dev`, depuis la
  prod). Quand elle est en service : `enforcement.projects` ; son
  `.orchestrateur/pipeline.json` déclare
  `node scripts/regression.mjs --targeted --no-browser` et `testTimeoutMin: 30`
  (délai par projet de la commande de test, `testTimeoutMs` du moteur, défaut
  10 min, plafond 120). Depuis 0.115.0 (P9 en prod), ses exécutions de
  pipeline tournent en couloir, deux à la fois (`_test_dev_pipeline_lanes.mjs`).
  Retour arrière : `pipeline-enforce.mjs off orchestrateur-dev`. Recette :
  `_test_dev_instance_pipelines.mjs`.
- Supprimer la dev : retirer l'entrée de config.json, `forgetWorkspace()`,
  supprimer le dossier. La prod n'est pas touchée.

## Toutes les logs : identifiant de tour, stderr, un tour à la fois (0.67.0)

Demande utilisateur : « Je veux qu'il y ai toutes les logs » (entrées « Demande
non visible » du journal d'activité).

- **`orch_turn`** : `dispatch.mjs` (`TURN_ID`, `tagTurnLines`, `musicianLog`)
  pose le même identifiant sur chaque ligne d'un tour. Le moteur de pipeline et
  `dual-run.mjs` le lisent dans `process.env.ORCH_TURN_ID`. La relecture du
  mode double hérite de celui du parent. Tout autre dispatch, y compris lancé
  depuis l'outil Bash d'un tour, a le sien.
- **Journal** (`turn-core.js`, `createJournal`) : il route chaque ligne vers
  son tour (`byId`). Pour les anciens logs : `adopt()` (demande sourcée en
  attente, sinon suite du tour précédent), et continuation après
  `failover` / `task_notification`. Le serveur charge ce fichier au démarrage :
  redémarrage nécessaire.
- **stderr** : `stderrSink` le transforme en `system/stderr {origin, text}`,
  pour claude comme pour codex. Plus jamais d'octets bruts dans le JSONL.
- **Verrou de tour** `logs/<p>.turnlock` (création exclusive, libéré à la
  sortie, repris si le PID est mort) :
  - un seul tour par musicien, le chef excepté (pool) ;
  - un dispatch qui le trouve tenu attend, ou se met en file avec
    `--queue-if-busy` ;
  - `ORCH_TURN_LOCK_WAIT_MS` (4 h par défaut, puis départ avec un
    avertissement) et `ORCH_TURN_LOCK_POLL_MS`.
- Recette : `_test_turn_logs.mjs`.

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
- **Tâche de file jamais perdue au lancement** (0.144.0, défaut vu en prod :
  deux tâches refusées « modifications non commitées » pendant la pause d'une
  exécution, disparues de la file). `scripts/queue-requeue.mjs` : une nouvelle
  exécution lancée par la file (ou `--queue-if-busy`) dans une copie qu'une
  exécution en pause a laissée non propre revient **en tête** de file
  (`heldBy {kind: 'paused-run', run}`), avant toute écriture dans le journal
  (sauf `notification/queue_entry_held`) et avant le classement ; le serveur
  ne lance pas une tête retenue tant que l'exécution est en pause (fin ou
  `close-run.mjs` = libérée). Copie non propre sans exécution en pause :
  `dirty`, durable, alerte `queue` de chefAlerts ; aucun couloir libre :
  `capacity`. Nouvel essai sur un result ou après le délai
  (`ORCH_QUEUE_HELD_RETRY_MS`). Une réponse à la pause n'est jamais retenue.
  Redémarrage nécessaire (route, drain, alertes) ; `dispatch.mjs` est actif
  tout de suite. Recette : `_test_queue_requeue.mjs`.
  **Copie propre comprise, réponses de pause prioritaires** (0.148.0, défaut
  vu en prod sur [projet] : pause de processus avec le dernier item commité,
  copie propre, tête de file lancée par-dessus, réponse du chef mise en fin de
  file) : une exécution en pause retient la file de son couloir même copie
  propre ; une réponse à une pause mise en file (`pauseReply` : relais du chef,
  `--pipeline-resume`, mot du menu) passe après les réponses déjà en attente,
  avant une tête retenue et les tâches ordinaires (`queueInsertIndex`). Jamais
  pour une tâche ordinaire ni une réponse du chef à une question ordinaire.
  Redémarrage nécessaire (file du serveur). Recette : `_test_queue_requeue.mjs` §7.
- **Détail d'une entrée de file** (0.80.0, demande « Les éléments de la file
  d'attente doivent être clickable pour voir leurs détails ») : dans le volet
  d'un musicien, chaque `.dq-item` (clic, Entrée, Espace) ouvre
  `#queue-overlay`, en lecture seule, avec l'entrée complète (`text` intégral
  de `GET /api/queue/:projet`, champs, position suivie en direct). Fermeture
  par ✕, Échap (capture : le volet reste ouvert), clic hors zone. L'édition et
  le glisser-déposer s'ajouteront par `Salle.registerQueueAction({id, label,
  when?, run(entry, {project, close, reload})})`. Recettes : HTTP
  `queue-detail`, navigateur `queue-item-detail`.
- **Glisser-déposer de la file** (0.86.0, demande « il faut pouvoir drag &
  drop les éléments de la file d'attente, et que celà ai un impacte sur
  l'ordre de traitement ») : souris sur la ligne (seuil 6 px), doigt sur la
  poignée `.dq-grip` (44 px sur mobile), Alt+↑/↓. `POST
  /api/queue/:projet/order {ids}` (`sameOriginOnly`) réordonne la file en
  **mémoire** puis réécrit le fichier : le drain lance la tête, donc l'ordre
  déposé **est** l'ordre d'exécution. Concurrence (`reorderQueue` de
  `scripts/queue-order.mjs`) : un élément parti est ignoré (`missing`), un
  arrivé reste après (`appended`), sans perte ni doublon. Délais du balayage
  réglables pour les tests seulement (`ORCH_QUEUE_SWEEP_MS`,
  `ORCH_QUEUE_STALL_MS`). Recettes : `_test_queue_order.mjs` (instance
  privée : les tours partent dans l'ordre déposé ; suite en série), HTTP
  `queue-order`, navigateur `queue-drag`.
- **Modifier une entrée en attente** (0.89.0, même demande, « tant qu'ils ne
  sont pas traités ils sont éditables ») : « Modifier la demande… » dans le
  détail (Enregistrer / Ctrl+Entrée, Annuler / Échap). `POST
  /api/queue/:projet/:id {text}` (`sameOriginOnly`, `editQueueEntry` de
  `scripts/queue-order.mjs`) remplace le **texte seul** dans la file en
  mémoire puis réécrit le fichier ; c'est ce texte qui est lancé. Le drain
  retire la tête de façon synchrone : une entrée partie ou retirée donne
  **409** (`alreadyStarted`), l'interface la montre non modifiable et garde le
  texte saisi. Recettes : `_test_queue_edit.mjs` (instance privée, suite en
  série), HTTP `queue-edit`, navigateur `queue-edit`.

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

**Processus vivant après le `result` = « En cours », jamais « Prêt » (0.78.1).**
Signalement : « toute tâche qui tourne attachée à un musicien fait que le
musicien est En cours, ou en Reflexion, en tout cas,pas Prêt ». Le CLI garde
le processus du tour vivant après son `result` tant qu'une tâche qu'il a
lancée en arrière-plan tourne ; le serveur retient alors la file
(`dispatchPidAlive`). Même signal pour l'affichage :
- `scanProject` (`/api/pupitre`, fleet-status, app Android) : `state: 'live'`
  si le log dit idle/unread et que `logs/<p>.pid` (moins de 12 h) vit ;
  `logState` = ce que dit le log seul ; `lingering {pid, sinceMs,
  background}` (tâches `system/task_started` en arrière-plan sans
  `task_notification`) ; activité « ⏳ tour terminé, processus encore actif… ».
  Pas de `stalled`, aucune alarme, rien n'est tué.
- `/api/config` : `currentState: 'live'` + `heldState`.
- Client : `TurnCore.reconcileBusy(state, held, lingering)` appliqué à chaque
  instantané `/api/pupitre` (`applyPupitreToCards`) ; l'état du log revient
  quand le processus s'arrête. Une question ou un échec gardent leur état.
- Recettes : `_test_busy_never_ready.mjs`, HTTP et navigateur `busy-not-ready`.
- **File retenue** (0.82.0, partie 2/2) : ce processus retient aussi la file
  (à raison). `scripts/queue-hold.mjs` : `scanProject` pose `queueHeld {pid,
  sinceMs, queueLength, background}` si la file sur disque n'est pas vide ;
  pastille « ⏸ n retenue » du cadre, bandeau de la file, note `FILE RETENUE`
  de fleet-status et `--held` (exit 2). Le balayage `sweepQueueHolds`
  (30 s) écrit `notification/queue_held` dans le log du musicien et un
  message `queue-held` au chef après `queueHoldAlertMin` (projet, puis
  `defaults`, 5 min), rappel tous les `queueHoldRepeatMin` (30, 0 = jamais),
  puis `queue_hold_released`. **Rien n'est tué automatiquement** ; actions
  proposées : attendre, `kill-stalled.mjs <p> --by utilisateur`, retirer.
  Tests : `ORCH_QUEUE_HOLD_SWEEP_MS`, `ORCH_QUEUE_HOLD_ALERT_MS`,
  `ORCH_QUEUE_HOLD_REPEAT_MS`. Recettes : `_test_queue_held.mjs`, HTTP et
  navigateur `queue-held`.

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
- **Après** (en développement, `--targeted` suffit : voir la section 0.72.0
  plus bas) : lancer `node scripts/regression.mjs --out .regress/report-apres.json`,
  puis `node scripts/regression.mjs --compare .regress/report-avant.json
  .regress/report-apres.json --md <rapport.md>`. La comparaison sort en code
  non nul si une ligne passe de OK à autre chose.
- `regression.mjs` sort en code non nul au moindre KO. Il enchaîne trois
  étages :
  1. toutes les suites `scripts/_test_*.mjs`, sauf `_test_phase2.mjs` (code
     mort : `route`/`decide`/`classify` ne sont jamais appelés en
     production ; appels Haiku réels). `_test_phase2_5_override.mjs` en fait
     partie depuis 0.74.1 (`detectOverride`, télémétrie dans un dossier
     temporaire via `ORCH_ROUTER_LOGS_DIR`) ;
  2. une **instance de test isolée** (`.regress/`, port libre, 14 projets de
     fixtures, faux `claude` = `tests/fake_claude`) et ses parcours HTTP ;
  3. les parcours navigateur (Edge headless via `playwright-core`) : fil et
     saisie, rail, attention, « Marquer comme répondue », volet et onglets,
     file + Retirer, recherche, briefing, pool, pièce jointe, temps réel,
     mobile, vue Projets.
- **Sortie d'une suite en échec** (0.73.0) : gardée en entier dans
  `.regress/suite-output/<label>-<horodatage>/<suite>.log`, référencée par
  le champ `output` de l'entrée du rapport (`scripts/suite-runner.mjs`).
  Recette : `_test_failed_suite_output.mjs`.
- **`--ref` voit le bon état** (0.74.3) : la copie extraite sous `.regress/`
  devient son propre dépôt git (`snapshotRepo` de `_regression_sandbox.mjs`),
  sinon les suites qui interrogent git remontent au dépôt dev, où rien de la
  copie n'est suivi. Recette : `_test_ref_snapshot.mjs`.
- **Fichiers lus par le serveur pendant qu'on les écrit** (0.74.3) : sous
  Windows, `renameSync(tmp, f)` échoue avec `EPERM` si un autre processus lit
  `f` (cause des KO intermittents `pipeline-routage` / `callback-wake`).
  Passer par `renameRetry` / `writeFileAtomic` de `scripts/atomic-file.mjs`
  (`run.json` et l'état de mise en service du moteur). Recette :
  `_test_atomic_rename.mjs`.
- **Suites en parallèle** (0.74.0) : `runPool` de `scripts/suite-runner.mjs`,
  au plus `--jobs N` (ou `ORCH_REGRESS_JOBS` ; défaut : un quart des cœurs,
  de 1 à 4). Les suites de `SERIAL_SUITES` (sensibles au temps, ou qui
  travaillent dans la racine du dépôt) tournent seules, à la fin. Résultats,
  rapport et sortie des échecs dans l'ordre alphabétique d'origine.
  `--jobs 1` = l'ancien comportement. **Toute nouvelle suite sensible au
  temps ou qui écrit hors de son dossier temporaire va dans
  `SERIAL_SUITES`.** Recette : `_test_parallel_suites.mjs`.
- **Suites du moteur rapides** (0.73.3) : leurs projets de test passent par
  `tests/fixture-speed.mjs` (`FAST_TEST_COMMAND` en un seul processus,
  maintenance git coupée). Toute nouvelle suite du moteur l'importe.
  Recette : `_test_fixture_speed.mjs`.
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
- **Aucune livraison avec une suite rouge** (0.71.3, incident du n° 8 :
  « Le correctif a pourtant été livré. […] Ca ne devrait pas arriver ») :
  - `scripts/delivery-gate.mjs`, installé comme hook git `pre-commit` par
    `node scripts/delivery-gate.mjs install-hook`, à faire dans chaque clone.
    Il refuse un commit de livraison (version de `package.json` changée) sans
    rapport vert fait sur exactement ce contenu (`report.tree` = arbre
    indexé).
  - Un KO n'est accepté que s'il est listé, avec sa raison, dans
    `docs/known-ko.json`, et il est alors affiché.
  - `--compare` refuse aussi un KO préexistant (« Livraison : REFUSÉE »).
  - Recette : `_test_delivery_gate.mjs`.
  - Donc : écrire version, CHANGELOG et docs **avant** la non-régression
    finale, puis `git add -A` et commit. Le rapport doit porter sur le
    contenu exact.

## Ciblée pendant le développement, complète avant la prod (0.72.0)

Demande utilisateur (2026-10-11) : « Implemente une Non-régression ciblée
pendant le développement, et la complète seulement avant une mise en prod ».

- **Pendant le développement** : `node scripts/regression.mjs --targeted
  [--since <ref>]` (par défaut, le travail non commité ; `--since <tag de
  retour>` pour tout un sujet). Sélection déterministe
  (`scripts/regression-targets.mjs`, `selectTargets`), affichée avec la
  raison de chaque choix et gardée dans le rapport (`mode: 'targeted'`,
  `selection`) :
  - le **socle** (`BASE_SUITES`, quelques secondes) tourne toujours :
    hygiène du dépôt, registre des exigences, garde-fou de livraison,
    sélection ciblée ;
  - une suite couvre les fichiers qu'elle **nomme** et la clôture des
    **imports réels** de ses imports (une simple mention dans du code
    n'entraîne pas tout le dépôt) ;
  - étage HTTP : `HTTP_ROOTS` (server.js, bac à sable, doublures) et ce
    qu'ils couvrent ; étage navigateur : `public/**`,
    `_regression_browser.mjs`, server.js ;
  - documentation (`docs/`, `*.md`) et `package.json` dont seule la version
    change : le socle seulement ;
  - **un fichier modifié couvert par rien ⇒ complète**, avec la raison ;
    un changement de dépendances (`FULL_TRIGGERS`, `package-lock.json`) ⇒
    complète ;
  - **outillage de la non-régression** (`TOOLING_FILES` : `regression.mjs`,
    `regression-targets.mjs`, `suite-runner.mjs`, `delivery-gate.mjs`,
    `prod-jump.mjs`), depuis 0.73.0 (décision utilisateur « B », 2026-10-12) :
    les suites qui le couvrent plus `TOOLING_SUITES`, et l'étage HTTP pour
    `regression.mjs` ; **jamais la complète** ;
  - **code Android** (`android/`, `OUT_OF_SCOPE`), depuis 0.73.2 (décision
    utilisateur, 2026-10-12) : **hors périmètre** de la non-régression, aucune
    suite au-delà du socle, jamais la complète ; raison affichée « code
    Android : hors périmètre de la non-régression ».
- **Aucune livraison avec une suite exécutée rouge, ciblée comprise** : le
  hook `pre-commit` vérifie le rapport ciblé comme un complet.
- **Avant la prod** : depuis 0.106.0, celle **par périmètre** depuis la
  version en prod (section suivante), ou la complète (`mode: 'full'` ;
  `--no-suites` ou `--no-browser` donnent `partial`) sur exactement l'arbre du
  tag : `node scripts/regression.mjs --ref vX.Y.Z`. Puis
  `node scripts/prod-jump.mjs --tag vX.Y.Z --prod I:\orchestrateur
  [--apply]` refuse sans elle (et si la prod est modifiée, un tour en cours,
  pas d'avance rapide), sinon affiche le plan ; `--apply` (décision de
  l'utilisateur) pose `prod-before-vX.Y.Z` et fait l'avance rapide, sans
  jamais redémarrer. Contrôle seul : `node scripts/delivery-gate.mjs
  prod-check vX.Y.Z`. Un rapport antérieur à 0.72.0 (sans `mode`) ne compte
  pas.
- Le tag de retour avant modification et le test d'exigence restent
  obligatoires.
- Recette : `_test_targeted_regression.mjs`.

## Avant la prod : par périmètre, la complète en repli (0.106.0)

Demande utilisateur (2026-10-15) : « les tests complets de regression
deviennent beaucoup trop long. Il faut decouper l'ensemble du projet de
maniere cloisonee, et seul les tests correspondant au perimetre impacte par
des modifications devront etre lances avant une mise en prod. »

- **Carte** `scripts/regression-perimeters.json` (versionnée) : chaque fichier
  dans exactement un périmètre (un nom exact prime sur un motif) ou une
  catégorie `transverse` (→ complète), `noTests`, `outOfScope` ; chaque suite
  dans un périmètre (ou `excludedSuites`). `uses` : `"Q"` (toutes les suites
  du périmètre) ou `{perimeter, suites}` ; **non transitif**.
- **Avant la prod** : `node scripts/regression.mjs --ref vX.Y.Z --perimeters
  --prod I:\orchestrateur` (ou `--since <commit>`). Diff depuis la version en
  prod, périmètres et suites affichés avec leur raison, socle + suites des
  périmètres touchés + celles qui les atteignent + étages des périmètres
  touchés. **Complète** : fichier transverse, fichier inconnu, `package.json`
  au-delà de la version, `--full`. Rapport `mode: 'perimeter'`.
- `prod-jump.mjs` / `delivery-gate.mjs prod-check --prod` recalculent la
  sélection depuis la carte du tag (`prodPlan`) et exigent : même base que la
  prod, toutes les suites et étages attendus, aucun KO. La complète reste
  acceptée ; ciblée et partielle refusées.
- **Tenir la carte à jour** : `node scripts/regression-perimeters.mjs check`
  (`_test_regression_perimeters.mjs`, dans le socle des deux modes). Toute
  nouvelle suite ou tout nouveau fichier doit y être rattaché ; une suite qui
  exécute du code d'un autre périmètre (import, ou script lancé : clôture
  d'imports de `dispatch.mjs`, `server.js`…) exige l'arête. `check --suggest`
  donne les listes `uses` exactes à recopier.
- Recette : `_test_regression_perimeters.mjs`.

## Non-régression visible ; aucun état réglable ne fait échouer une suite (0.119.0)

Demandes utilisateur (2026-10-20) : « Je ne vois pas que le test de non
regression est en cours sur orchestrateur-dev. C'est un probleme. » et « s'il
est necessaire que l'on soit en pipeline pour le test, il faut etre capable de
passer en pipleline seul, puis le remettre comme il etait apres le test. Un
seul status n'est pas une source de bug. »

- **Visible pendant qu'elle tourne** (`scripts/regression-live.mjs`) : tout
  `regression.mjs` écrit `.regress/live/<id>.json` dans le dépôt testé (étage,
  suites faites / total, vérifications, KO, lanceur, rapport attendu ; toutes
  les 15 s et à chaque résultat), puis son bilan dans `.regress/history.ndjson`.
  Processus mort sans bilan ou muet 5 min = « interrompue ». Le lanceur vient
  du tour (`ORCH_TURN_PROJECT`, `ORCH_TURN_STEP`) ou de
  `ORCH_REGRESS_LAUNCHER` (à poser dans un script du chef).
  `ORCH_REGRESS_LIVE=0` le coupe ; `suite-runner.mjs` le pose pour les suites
  (leurs non-régressions de fixtures restent hors du tableau de bord).
- Serveur, **lecture seule** : `GET /api/regressions`, `/api/regressions/:p`,
  `/api/regressions/:p/report/:id` (un `.json` sous `.regress/` seulement ; 410
  si un lancement plus récent du même nom l'a remplacé) ; dossier et couloirs
  de chaque projet ; `regression` dans `/api/pupitre`, `regressions` dans le
  journal. Client `public/regress-live.js` : bande `#regress-band`, pastille
  « 🧪 NR n/N » du cadre, entrée du journal. Redémarrage nécessaire.
- **État réglable ≠ échec** : une suite qui regarde l'installation réelle passe
  par `tests/real-config.mjs` ; elle met une **copie isolée** dans l'état dont
  elle a besoin (vrai `pipeline-enforce.mjs` sous `DISPATCH_ROOT_FOR_TESTS`),
  la remet comme elle était, et vérifie la vraie configuration identique octet
  pour octet. Les interrupteurs (`pipelineLanes`, `maxParallel`) sont retirés
  avant de juger une politique (`neutralConfig`). Jamais `readEnforcement(ROOT)`
  ni lecture directe de model-routing.json, language-settings.json ou
  permission-rules.json de la vraie racine dans une suite (garde statique).
- Recettes : `_test_regression_live.mjs`, `_test_config_state_independence.mjs`,
  HTTP et navigateur `regression-live`.

## Non-régression complète a posteriori, pendant l'inactivité (0.142.0)

Décision utilisateur (2026-10-23) : « non. la non régression ne serait plus une
condition pour la mise en prod. la.mise en prod ne dépend plus que des tests
unitaires et les non régression ne servent plus qu'à posteriori. Les non
régressions et corrections ne sont lancées que pendant les heures
d'inactivité » (idée : « ne faire les tests de non régression qu'en dehors des
sprints de dev. mesures un laps de temps d'au moins une demi heure avant
d'autoriser un lancement de non régression »).

- **Interrupteur** `idleRegression` de `model-routing.json` : `node
  scripts/pipeline-enforce.mjs idle-regression on|off [<projet>] [--idle-min
  N]` (défaut 30 min), relu à chaque balayage et à chaque dispatch, **figé dans
  `run.json.idleRegression`** au départ d'une exécution ; coupé par défaut ;
  coupé = les règles des sections précédentes, exactement ; `off --all` le
  coupe. Pour la dev : allumé pour `orchestrateur` ou `orchestrateur-dev`.
- **Allumé — pendant une tâche** : seulement les tests de la tâche, ceux qui
  couvrent les fichiers modifiés (tests d'exigence compris, toujours
  intouchables) et la suite rapide. `regression.mjs --targeted` ne bascule
  **jamais** sur la complète (`--no-full`, ou `ORCH_UNIT_DELIVERY=1` posé par
  `dispatch.mjs` dans le tour et par le moteur pour la commande de test) : un
  fichier non couvert ou un changement de dépendances est listé « reporté a
  posteriori » (`selection.deferred`). Consigne des musiciens :
  `requirementsRuleText(true)` (plus de « avant / après »). **Plus de tag
  « avant » ni de complète « avant / après » pour ce projet non plus.**
- **Livraison** : le hook `pre-commit` exige toujours un rapport vert sur
  l'arbre exact (une ciblée suffit, comme avant). **Mise en prod** :
  `prod-jump.mjs` (interrupteur lu dans la prod, jamais écrit, ou `--unit`)
  accepte un rapport vert de tout mode sur l'arbre du tag (pas un essai
  `report-idle-*` partiel) ; l'état des complètes a posteriori est affiché,
  jamais une condition. `delivery-gate.mjs prod-check <ref> --unit`. Le point
  de retour `prod-before-…` reste.
- **Complète a posteriori** (`scripts/idle-regression.mjs`, balayage du serveur
  toutes les 60 s, `ORCH_IDLE_REGRESSION_SWEEP_MS`) : lancée par le
  **programme**, jamais par un musicien, seulement si l'utilisateur est inactif
  depuis le seuil (`logs/user-activity.json` : gestes et présence du dashboard
  et de l'app) ET qu'aucun musicien n'est en cours sur le projet ; une à la fois
  pour la flotte ; arrêtée (arbre du processus) dès que l'un ou l'autre change,
  ou si l'interrupteur est coupé, puis relancée dans une fenêtre suivante. Elle
  porte sur la tête de la copie, depuis la dernière complète verte. Cibles :
  projets en service et instances de dev ; **jamais une prod** (`devOf`,
  instance « prod », puis `prod-guard.mjs` dans le runner) : l'orchestrateur
  est testé dans orchestrateur-dev. Déclaration dans
  `.orchestrateur/pipeline.json` → `idleRegression {full, bisect, inPlace,
  timeoutMin}` (`{ref}`, `{report}`, `{suites}`) ; sans elle, la
  `testCommand` dans un worktree détaché du commit (dépendances liées).
  Runner détaché `scripts/idle-regression-runner.mjs` (jamais importé).
- **Rouge** : recherche dichotomique du commit fautif entre la dernière verte
  et la rouge (seulement les suites KO, `regression.mjs --ref <c>
  --only-suites a,b`), alerte au chef (type `posteriori` de `chef-alerts.mjs`
  si chefAlerts est allumé, sinon ticket direct), puis la **correction**
  (voie Incident, `--source idle-regression`) lancée vers le musicien du projet
  pendant l'inactivité, une fois ; tout de suite seulement à la demande :
  `node scripts/idle-regression.mjs fix <projet> --now`. Les essais du
  programme ne sont pas signalés comme « non-régression KO ».
- État : `logs/idle-regression.json` (ce module seul l'écrit), journal
  `logs/idle-regression.ndjson`, sorties `logs/idle-regression/<projet>/`.
  Lecture : `node scripts/idle-regression.mjs status`. Redémarrage nécessaire
  pour le balayage ; `dispatch.mjs`, le moteur et `prod-jump.mjs` sont actifs
  tout de suite.
- Recette : `_test_idle_regression.mjs`.

## Copie propre et alerte précise (0.145.0)

Accord utilisateur (2026-10-24) : « oui », aux deux propositions du chef après
la première nuit de complètes a posteriori (deux projets rouges seulement parce
qu'un fichier ignoré par git manquait dans une copie propre ; une alerte « KO :
testCommand » pour 1 test sur 559).

- **Copie propre** (`scripts/clean-copy-check.mjs`, `checkCleanCopy`) : la
  `testCommand` tourne une fois dans un `git worktree` détaché du commit courant
  (liens de dépendances comme le runner a posteriori, rien d'autre). Rouge ⇒
  raison avec les tests en échec (ou pourquoi la commande n'a pas pu tourner) et
  les fichiers ignorés par git cités par la sortie. État `logs/clean-check.json`
  (`recordCleanCheck` seul), sortie `logs/clean-check/<projet>.log`.
  - `onboardProject` (donc `new-project.mjs`) : vérifiée avant toute écriture ;
    rouge ⇒ pas en service, rien de commité (`details` affichés).
  - `node scripts/pipeline-onboard.mjs --check-clean <projet>|--all|--changed` :
    projets en service et instances de dev, jamais une prod ; rouge =
    avertissement bloquant (exit 1), **jamais de retrait d'office** ;
    `--changed` : testCommand changée, ou rouge sur un commit plus ancien
    (`cleanCheckNeeded`), exit 2 s'il n'y a rien à vérifier.
  - Balayage d'inactivité : un projet déclaré (`idleRegression.full`) dont la
    testCommand a changé passe d'abord une étape `clean-check` ; rouge ⇒
    `red.cleanCopy`, alerte `posteriori` et demande d'incident
    `[COPIE PROPRE ROUGE]`. La complète d'un projet non déclaré vaut cette
    vérification et est enregistrée comme telle.
- **Alerte précise** (`scripts/test-failures.mjs`, `parseTestOutput`) : node
  --test (spec, TAP), pytest, unittest, gradle/JUnit, dotnet test, sinon les
  dernières lignes utiles ; `tests` (N en échec, nommés) / `not-run` (la
  commande n'a pas pu tourner : environnement, fichier manquant, compilation,
  collecte) / `unknown`. Le runner met `ko = test:<nom>` (ou
  `testCommand:non-lancée`), `failures`, `ignored` ; l'alerte du chef et
  `fixText` disent « Échec : … » avec une ligne par test, jamais « KO :
  testCommand ». Lire la sortie d'une machine n'est pas du routage par
  mots-clés.
- Redémarrage nécessaire pour le balayage servi (`idle-regression.mjs`,
  `chef-alerts.mjs`) ; le runner, `pipeline-onboard.mjs` et `new-project.mjs`
  sont actifs tout de suite.
- Recette : `_test_clean_copy_check.mjs`.
- **Préparation de la copie propre** (0.147.0, post-mortem de
  p-20261024T033920-3a0055 : fichier généré par `postinstall`, ignoré par git,
  absent ⇒ faux rouge 404). `scripts/copy-setup.mjs` (`runCopySetup`), juste
  après la liaison des dépendances : `.orchestrateur/pipeline.json` →
  `setupCommand` (chaîne = shell, ou argv ; `false` la coupe ;
  `setupTimeoutMin`, 10 par défaut), sinon `npm run postinstall --if-present`
  si package.json déclare un `postinstall`, sinon rien. Partout où une copie
  propre est faite : `addCleanWorktree` (validation de l'onboarding,
  `--check-clean`, runner a posteriori : code 71, ko `setup:échec`) et couloirs
  de pipeline (`dispatch.mjs`, tampon dans le dossier git du worktree : rejouée
  seulement si commande, package.json, package-lock.json ou pipeline.json
  changent ; journal `logs/lanes/<p>/<k>.setup.log` ; échec ⇒
  `system/lane_setup_failed`, l'exécution continue). Échec = nature `setup`
  (« tests non lancés : préparation … en échec »), tests jamais lancés.
  Recette : `_test_copy_setup.mjs`.

## Un test périmé s'arrête aussitôt (0.94.0)

Demande utilisateur (2026-10-14) : « si un test est detecte comme inutile, on
aurait pu l'arreter pour ne pas perdre de temps et commencer l'autre ? Si oui,
il faut en faire une regle ».

- `regression.mjs` (arbre de travail) prend l'arbre testé **au départ**,
  l'échantillonne toutes les 15 s (`ORCH_REGRESS_STALE_MS`) ; un changement
  vu deux fois de suite arrête le lancement : ses suites (`liveSuites`) et son
  instance de test seulement, rapport `stale` (refusé par `checkReport`),
  code 3. `--no-stale-stop` coupe la surveillance. Module
  `scripts/stale-run.mjs`.
- **Règle de travail** (aussi `staleTestRule` dans le prompt des musiciens,
  règle n° 7 du modèle de projet) : si tu modifies le contenu pendant qu'un
  test que TU as lancé tourne, arrête-le tout de suite et relance sur le
  contenu final. Jamais un serveur, un processus partagé ni le tour d'un autre
  musicien.
- Recette : `_test_stale_run.mjs`.

## Panneau latéral et TODO des musiciens (0.75.0)

Demande utilisateur (2026-10-13) : « Sur dev, je veux que l'on reprenne
l'implémentation de notre todo list et git visualisation sur pannel ». Ici la
partie TODO ; proposition du 2026-10-11 (`attachments/proposition-panneau-todo.html`
de la prod).

- **Panneau** (`public/side-panel.js` + `side-panel.css`) : tiroir pleine
  hauteur sous la barre du haut (plein écran sur mobile). On l'ouvre et le
  ferme par la pill « ☑ TODO », la touche `t`, l'onglet du bord ou Échap.
  L'état ouvert et l'onglet sont mémorisés. **Générique** :
  `SidePanel.register({id, label, icon, key, mount, onOpen, onClose})`, et
  tout élément `[data-sp-open="<id>"]` l'ouvre. L'onglet Git des musiciens
  viendra s'y brancher.
- **TODO** (`public/todo-panel.js`) : la liste de chaque musicien, en cases
  à cocher **désactivées**. Les **non faits sont en haut, les faits en bas**
  (0.76.2, demande « en haut les tâches non faites, en bas les tâches
  faites », qui remplace l'ordre de 0.75.0) ; dans chaque partie, du plus
  récent au plus ancien par date d'entrée. Le nom du
  musicien est à côté de chaque fait.
- **Lecture** : `GET /api/todo[?project=]`. Le `TODO_LIST.md` de chaque
  projet de `config.json` est lu sur le **disque**, jamais par git, avec un
  cache par mtime et taille. **Aucune route d'écriture.**
- **Écriture** : `scripts/todo.mjs` seulement (format dans
  `scripts/todo-core.mjs`) :
  - `add [--type]`, `start`, `done <id>|--match`, `list` ;
  - le nom (« → fait (date) par <musicien> ») vient de `ORCH_TURN_PROJECT`,
    jamais d'un argument ;
  - `done` et `start` sont refusés hors d'un tour ;
  - un musicien n'écrit que sa liste, sauf le chef ;
  - verrou et écriture atomique.

  `dispatch.mjs` ajoute `todoRule()` au prompt des musiciens. Les anciennes
  lignes sont lues telles quelles : sans date, c'est la date du fichier,
  affichée « ≈ » ; cochées à la main, elles affichent « ✓ — ».
- **Désactiver sans redéploiement** : `"ui": {"sidePanel": false}`, ou
  `?todo=0` pour un navigateur.
- Recettes : `_test_todo.mjs`, HTTP `todo-api`, navigateur `todo-panel` et
  `todo-panel-mobile`.
- **Overlay d'un item** (0.77.0, partie 1/5 de la demande « chaque item doit
  être clickable et afficher une overlay qui présente l'item complet […] ») :
  clic, Entrée ou Espace sur un item → `#todo-overlay` (`role=dialog`) avec
  l'item **complet**. `/api/todo` porte `detailFull` (quand `detail` est
  coupé à 400 caractères) et `more` (lignes indentées sous l'item, jusqu'à
  une ligne vide). Fermeture : ✕, Échap (écouteur en capture : le panneau
  reste ouvert), clic hors zone. Les parties suivantes (notes, rejet, envoi
  au chef) s'ajoutent par `TodoPanel.registerAction({id, label, when?,
  run(item, {close, reload})})` ; la barre est masquée sans action. Le
  glisser-déposer viendra sur les `.todo-item`. Recette : navigateur
  `todo-item-overlay` (bureau et mobile).
- **« Envoyer au chef… »** (0.79.0, partie 4/5, « lancer le contenu de
  l'item au chef, pour lancer l'execution ») : action de l'overlay
  (`send-chef`). Une confirmation montre le message exact (`TodoPanel.
  chefMessage` : item complet, notes s'il y en a, identifiant) et annonce le
  brouillon remplacé ; Annuler / Échap n'y touchent pas. Confirmé : le
  message va dans la saisie du chef (`App.prepareChefMessage`, contexte
  « Item TODO de … ») et part quand l'utilisateur l'envoie, par le même
  canal que tout message au chef. Cette action n'envoie rien au serveur elle-même. Recette : navigateur `todo-send-chef`.
- **« 💬 Discuter avec le chef… »** (0.96.0, demande « pas pour lancer mais
  en discuter, si j'ai besoin de reponse ») : action `discuss-chef`, même
  confirmation, message préfixé `/chef-discussion` (`TodoPanel.
  discussMessage`). `dispatch.mjs` (`scripts/chef-discussion.mjs`, avant la
  capture « TODO: ») lance alors le Routage du chef en mode `discussion`
  (Lire → Discuter → Rapporter, **aucune étape de lancement**), même si le
  chef n'est pas routé ; réponse dans le fil, aucun dispatch. Recettes :
  `_test_todo_discuss_chef.mjs`, navigateur `todo-discuss-chef`.
- **Notes d'un item** (0.81.0, partie 2/5, « Possibilité d'y ajouter des
  notes ») : section « Notes » de l'overlay (bouton ou Ctrl+Entrée, brouillon
  gardé par item, jamais effacé par le rafraîchissement ; « ✎ n » dans la
  liste). Ce sont les notes de **l'utilisateur** : elles vont dans
  `todo-notes.json` (racine, non versionné, `scripts/todo-notes.mjs`,
  écriture atomique, relu quand il change, jamais réécrit s'il est
  illisible), **jamais dans le `TODO_LIST.md` du musicien**. Route
  `POST /api/notes/todo/:projet/:item {text}` (`sameOriginOnly`, projet de
  config.json, item existant, 4 000 caractères et 200 notes par item au
  plus) ; `GET /api/todo` joint `notes` à chaque item. `/api/todo` reste sans
  route d'écriture. Interdiction de POST du panneau (exigence
  0.75.0) **entièrement levée** par l'utilisateur (2026-10-13, 0.85.1 : « L'accord
  POST couvre toutes les requetes necessaires a cette fonctionalite.
  L'interdication peut donc finalement etre entierement levee. ») ;
  `_test_todo.mjs` vérifie ce qu'écrit chaque route, plus ce qu'envoie le
  panneau. Recettes : `_test_todo_notes.mjs`, HTTP `todo-notes`,
  navigateur `todo-item-notes`.
- **Rejet d'un item** (0.85.0, partie 3/5 ; choix de l'utilisateur : « le
  rejet est marqué dans le TODO_LIST.md du musicien. Dans l'UI passe le dans
  la liste des "faits" mais barre, avec une marque « rejeté (date) par
  l'utilisateur » ») : action « Rejeter l'item… » de l'overlay (item non
  fait), avec confirmation. `POST /api/reject/todo/:projet/:item`
  (`sameOriginOnly`) réécrit **la seule ligne** de l'item : `[x] … → rejeté
  (date) par l'utilisateur` (`rejectItem` de `todo-core.mjs`), sous le verrou
  de la liste (`withListLock` de `todo-capture.mjs`, celui de `todo.mjs`),
  écriture atomique. C'est la **seule** écriture du dashboard dans un
  `TODO_LIST.md`. Relu `status: done` + `rejected {at, by}` : rangé avec les
  faits, barré, « ✕ rejeté (date) par l'utilisateur ». Déjà fait ou rejeté :
  409 ; liste verrouillée : 423. Recettes : `_test_todo_reject.mjs`, HTTP
  `todo-reject`, navigateur `todo-item-reject`.
- **Glisser-déposer** (0.83.0, partie 5/5, « Chaque item est drag & dropable,
  et les positions doivent persister ») : souris n'importe où sur l'item
  (seuil 6 px), doigt sur la poignée `.ti-grip` (44 px sur mobile), ou
  Alt+↑/↓. Un item ne quitte jamais sa partie (non faits en haut, faits en
  bas). Le glisser n'ouvre pas l'overlay (`suppressClickUntil`), le clic simple
  si. Ordre de **l'utilisateur** : `todo-order.json` (racine, non versionné,
  `scripts/todo-order.mjs`, écriture atomique, relu quand il change, jamais
  réécrit s'il est illisible), **jamais dans un `TODO_LIST.md`**. Un seul
  ordre global de clés `<projet>/<id>` ; `POST /api/order/todo {keys}`
  (`sameOriginOnly`, liste vide = tri par défaut) ; `GET /api/todo` applique
  `applyOrder` (items jamais placés d'abord).  Recettes :
  `_test_todo_order.mjs`, HTTP `todo-order`, navigateur `todo-item-drag`.
- **Onglet ⎇ Git** (0.76.0, même demande, partie git) : l'arbre git de chaque
  musicien, en **lecture seule** (`public/git-panel.js`, pill `#btn-git`).
  - On choisit le musicien ; les projets sans dépôt sont listés, désactivés.
  - Graphe SVG : un point par commit, une voie colorée par ligne
    d'historique, fusions et embranchements. Chaque ligne affiche branches
    (HEAD en évidence), branches distantes, tags, sha court, sujet, auteur
    et date. « Plus de commits » relit l'historique, par 80, jusqu'à 300.
  - Serveur : `GET /api/git-graph` et `GET /api/git-graph/:projet?n=`,
    cache de 15 s, projets de `config.json` seulement. **GET seulement.**
  - `scripts/git-graph-core.mjs` : la **seule** commande est `git log --all
    --topo-order --decorate=full` (argv en tableau, sans shell,
    `GIT_OPTIONAL_LOCKS=0` : l'index n'est jamais réécrit). Calcul des voies
    pur (`layoutGraph`). Ne jamais y ajouter de commande qui écrit.
  - Recettes : `_test_git_graph.mjs`, HTTP `git-graph`, navigateur
    `git-panel` et `git-panel-mobile`.
- **Serveur pas encore redémarré** (0.76.4, signalement « le pan git et vide,
  et sa liste de musiciens aussi ») : le front est lu sur le disque, donc un
  serveur lancé sur une version antérieure sert les nouveaux onglets sans
  leurs routes (404). `SidePanel.explainFailure` remplace alors le panneau
  vide par un message qui donne les deux versions (`/api/version`) et le
  redémarrage à faire ; la liste des musiciens affiche « indisponible ». Même
  chose pour la TODO (sa liste depuis 0.76.5, signalement « le pan todo et
  vide, et sa liste de musiciens aussi »). Recettes : navigateur
  `git-panel-musicians` et `todo-panel-musicians`.

## Tâches parallèles d'un même musicien : couloirs (0.101.0)

Demande utilisateur (2026-10-15) : « Il faut que ce soit assez fin (d'ou la
question sur git) pour que les taches d'un meme musicien puissent s'activer en
parallele. Sauf pour certains cas particuliers sont detectes, ils doivent alors
etre justifies et documentes. » Conception, état livré (§7) et règles (§3) :
`docs/PLAN-parallel-tasks-same-musician.md`.

- **Limite par projet** : `maxParallel` (entrée du projet, puis
  `defaults`) ; **défaut 2** depuis 0.103.0 (décision Q1 « Q1: defaut a 2, et
  on monitore pour verifier si on peut passer a 3 », `DEFAULT_MAX_PARALLEL`
  de `lanes.mjs`) ; 1 explicite = le chemin 0.67.0 intact ; plafond 4 ; les
  règles d'exception restent actives. Surveillance 2 → 3 : TODO séparée.
  Retour arrière : `"defaults": {"maxParallel": 1}`, sans redémarrage.
  Recette : `_test_maxparallel_default.mjs`.
- **La dev d'abord, la prod à la mise à jour suivante** (0.104.0, décision
  « il ne faudra passer d'abord que orchestrateur-dev, on ne passera
  orchestrateur qu'a la maj suivante ») : un projet désigné par le `devOf`
  d'un autre garde 1 (chemin 0.67.0, aucun couloir) sauf `maxParallel` dans
  sa propre entrée ; `defaults.maxParallel` ne l'atteint pas
  (`maxParallelInfo`, `DEV_PILOT_FIRST`). Lever à la mise à jour suivante.
  Recette : `_test_dev_pilot_first.mjs`.
- **Couloir** (`scripts/lanes.mjs`) : 0 = la copie du musicien, fichiers
  d'aujourd'hui ; k ≥ 1 = worktree git persistant `lanes/<p>/<k>`
  (gitignoré), fichiers `logs/lanes/<p>/<k>.*`, une branche
  `lane/<k>/<tâche>` par tâche. Fin de tâche : intégration (fusion, version
  tirée du fragment `changelog.d/`, avance rapide, jamais poussée) ; conflit
  ⇒ pause, branche gardée, chef prévenu, rien d'écrasé. Question ⇒ couloir
  gardé, réponse par `--lane k`.
- **Branches de tâches terminées** (0.101.1, décisions Q2 « On peut eliminer
  les branches de taches une fois terminees, apres 1 semaine. » et Q3
  « Fusion par merge ») : jamais de tag ; gardées une semaine
  (`logs/lanes/<p>/retained-branches.json`), puis supprimées par
  `pruneRetainedBranches` (départ d'une tâche de couloir, balayage horaire du
  serveur, `lanes.mjs prune <p> [--dry-run]`) ; jamais avant, jamais une
  branche en pause ni une branche modifiée depuis. Intégration = merge, jamais
  squash. Q1 de la conception reste ouverte.
- **Version et CHANGELOG d'une tâche de couloir** (0.102.0, décision Q4
  « Question 4 : ok, je valide tout ») : la tâche n'y touche pas, elle écrit
  `changelog.d/<tâche>.md` (`bump: patch|minor|major` + sections) ;
  l'intégrateur (`enforceChangelogRule`, `applyFragments` de `lanes.mjs`) fait
  une release par tâche dans l'ordre d'intégration. Modification directe en
  tête ou sous `[Unreleased]` ⇒ convertie en fragment ; autre modification du
  CHANGELOG ⇒ pause `lane-version-edited` ; hausse invalide ⇒
  `lane-fragment-invalid` ; pas de fragment ⇒ fragment patch généré. Le commit
  de release passe par les hooks (jamais `--no-verify`) après
  `lanes.releaseCheck` (`.orchestrateur/pipeline.json`) sur l'arbre exact de la
  release ; rouge ⇒ pause `release-check` / `release-commit`.
- **Pilote = orchestrateur-dev** (décision Q5 « Non, orchestrateur-dev, a nous
  de faire en sorte qu'il ne se trompe pas ») : son `.orchestrateur/pipeline.json`
  provisionne un couloir (`config.json`, `.orchestrateur-instance.json`,
  `.token`, lien `node_modules`) et lance `regression.mjs --targeted --since
  {base}` avant chaque release, vérifiée par le hook de livraison. Garde-fous
  et conditions de mise en service : §9 du document de conception. Recette :
  `_test_lane_changelog_rule.mjs`.
- **Exceptions** (`scripts/lane-rules.mjs`) : toute règle a un id, une portée
  et une ligne dans le §3 du document (vérifié par `_test_lane_rules.mjs`).
  Détectée par le code ou déclarée par le Routage (`--ressources`, liste
  fermée), jamais par mots-clés. Tâche retenue : `system/lane_exclusive` dans
  le log, entrée de file avec `exclusive`, « ⛓ En série » au journal. **Toute
  nouvelle règle : registre + ligne du §3 + cas dans `_test_lane_rules.mjs`.**
- Lecture : `GET /api/lanes/:projet`, `node scripts/lanes.mjs status <p>`.
- Recettes : `_test_parallel_lanes.mjs` (série), `_test_lane_rules.mjs`, HTTP
  `lanes-queue` et `lanes-api`.
- **Pipelines dans un couloir** (0.115.0, P9, demande « Lances-led ») :
  détail au §12 du document de conception.
  - Une exécution **neuve** prend un couloir ≥ 1 libre, la copie principale
    en dernier et seulement propre (mode `pipeline` de `decide`) ; la règle
    `pipeline-engine` ne garde plus que la reprise d'une exécution commencée
    dans la copie principale.
  - Une réponse à une pause va au couloir de l'exécution
    (`pausedPipelineRuns`, avant le choix du couloir) ; plusieurs candidates
    sans `--lane` ⇒ 64.
  - Le moteur reçoit `cwd`, journal et `.pid` du couloir (`run.json.lane`) ;
    chaque étape recalcule le dossier du couloir. Livrer y écrit
    `changelog.d/<tâche>.md` (`FRAGMENT=`), jamais la version ni le
    CHANGELOG ; l'intégrateur fait la release.
  - Pause ⇒ couloir gardé, travail non commité ; « abandonner » ⇒ rien
    d'intégré, travail sur sa branche, couloir libéré.
  - Couloir d'un pipeline : `node_modules`, `.venv`, `venv` liés,
    `local.properties` copié (`provisionPipelineLane`) ; le reste par
    `lanes.copy` / `lanes.link`.
  - Registre des exigences fusionné par union à l'intégration seulement
    (`unionMergeArgs`). Dépendances du Routage : marqueur `lane_task`
    (`promptHash`, `turnEnd`).
  - Recette : `_test_lane_pipeline.mjs` (série).
- **orchestrateur-dev d'abord** (0.115.0, demande « orchestrateur-dev : il
  faut activer P9 ») : seule une instance de dev (`devOf`) fait tourner ses
  pipelines en couloir (`pipelineLanesInfo`, `PIPELINE_LANES_PILOT_ONLY`) ;
  tout autre projet garde ses exécutions de pipeline en série dans la copie
  principale (règle `pipeline-pilot`) sauf `"pipelineLanes": true` (entrée ou
  `defaults`, relu à chaque dispatch). Retour arrière : `"pipelineLanes":
  false` sur la dev. La prod reste à `maxParallel` 1. Recette :
  `_test_dev_pipeline_lanes.mjs` (série).

## Contexte calibré par requête (0.99.0)

Demande utilisateur (TODO t-182fa2, précisée le 2026-10-14) : le contexte de
chaque requête doit contenir ce dont le model a besoin, « mais pas
fiorcement l'historique […] de tous les developpements differents. Sauf
peut-etre si ces developpements font parti de la meme tache initiale ».
Module `scripts/context-policy.mjs`.

- **Tour ordinaire d'un musicien** (`dispatch.mjs`, `sessionDecision`) : la
  session (`--resume`) n'est reprise que pour la **même tâche** :
  - réponse à sa question (état `input`) ou réponse du chef (`[CHEF_ANSWER]`,
    `awaitingChef`) ;
  - tâche marquée `"meme_tache": true` par l'étape Découper du Routage
    (`--meme-tache`, exclusif avec `session_neuve`) ;
  - dialogue direct de l'utilisateur (pas de `--source`) ;
  - `--resume-session` (forçage).

  Toute autre demande (nouvelle tâche du chef, file…) part en **session
  neuve** : l'ancienne est archivée en `.session.bak-<horodatage>`, jamais
  effacée. Hors champ : le chef, les slots, les étapes, le mode double, codex.
- **Session trop longue** : si la dernière requête dépassait
  `ORCH_CONTEXT_MAX_TOKENS` (150 000, `usage` du dernier `assistant`), même
  pour la même tâche, le tour part en session neuve avec le contexte de la
  tâche régénéré depuis le log (`taskBrief` : les trois derniers échanges,
  coupes annoncées), envoyé au model mais pas affiché dans le fil.
- Trace : `user_prompt.context {resume, reason, regenerated?}`.
- **Pipelines** : `stepSessionGroup` (une session par item pour 4a/4b/4c, par
  groupe relu pour la Revue, la sienne pour Livrer) ; `stepRules` (les étapes
  du Développement et de la Discussion ne reçoivent que les consignes utiles,
  les autres pipelines les gardent toutes).
- La file transporte `sameTask` / `resumeSession`. Le Routage du chef était
  déjà calibré (0.93.0) et n'est pas touché.
- Recette : `_test_context_calibration.mjs`.

## Onglet « 🧭 Requêtes » : découpage et progrès de chaque requête (0.100.0)

Demande utilisateur (2026-10-14) : « Je parle de voir comment une requete
utilisateur a ete decoupee en taches atomiques, et voir le progres de ces
taches, meme detachees ». Forme : la « carte du Routage » recommandée par la
recherche du 2026-10-14 (colonnes reliées par les dépendances).

- `scripts/request-map.mjs`, **lecture seule, sans model** : une requête =
  une exécution du Routage du chef (`logs/runs/<run>/run.json`, réveils
  exclus) ; chaque tâche est suivie là où elle est : son tour dans le log du
  musicien (`findTurn` : empreinte du texte complet après l'offset de
  lancement, fantômes ignorés, tour suivi d'un autre tour sans result =
  interrompu), sa file, `routage-pending.json`, son exécution de pipeline
  (`plan`/`index`), le tour du chef renvoyé ou son refus dans
  `logs/chef-actions.log`, ou ce qu'a noté le Routage.
- **Tâches détachées** : `releaseReady` ajoute chaque libération à
  `logs/routage-released.ndjson` (run, n, offset, empreinte).
- Routes GET `/api/requests[?n=]`, `/api/requests/:run`. Onglet
  `public/requests-panel.js`, pill `#btn-requests`, fenêtre
  `#requests-overlay`, rafraîchi toutes les 10 s ; colonnes empilées sur
  mobile. App Android non touchée.
- Recettes : `_test_request_map.mjs` (jeu de données partagé
  `tests/request-fixture.mjs`), HTTP `requests-map`, navigateur
  `requests-panel` et `requests-panel-mobile`.

## Onglet « 📰 Release » : la liste qui mène à la release note (0.97.0)

Demande utilisateur (2026-10-14) : « Je dois voir comme TODO ou GIT, une liste
qui augmente au fur et a mesure et qui conduira a la release note en fonction
de ce qui est pret » ; choix : source CHANGELOG, dernière release trouvée
seule (« l'orchestrateur est sensé connaître sa propre version »), langue du
CHANGELOG.

- `scripts/release-notes.mjs` : `parseChangelog`, `readyVersions` (prêt = ce
  qui est au-dessus de l'entrée publiée), `releaseList`, `releaseNote`
  (Keep a Changelog, texte verbatim), `lastRelease` (serveur → `PKG_VERSION` ;
  `devOf` → la release du projet développé ; sinon dernier tag `v*` ; sinon
  aucune).
- En cours = `[Unreleased]` + items TODO `[~]`. Routes GET `/api/release`,
  `/api/release/:projet`. Panneau `public/release-panel.js`, pill
  `#btn-release`, Copier / Télécharger `.md`.
- Recettes : `_test_release_list.mjs`, HTTP `release-list`, navigateur
  `release-panel`.
- **Groupes et détail** (0.98.0, demande « les items doivent etre regroupes
  par release, et chaque release est clickable et ouvrir une fenetre ») :
  `groupByRelease` → `groups` (« ⏳ En cours » d'abord, puis chaque version
  prête, la plus récente en haut) ; en-tête de bloc = bouton qui ouvre
  `#release-overlay` (chaque élément en entier, Markdown) ; Échap en capture
  (l'onglet reste ouvert), ✕, clic hors zone. Recettes :
  `_test_release_groups.mjs`, navigateur `release-groups`.

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

  puis la non-régression dans `I:\Dev\orchestrateur-dev`, jamais dans la prod
  (section « Jamais de non-régression dans la prod »).

- `ssh-server.js`, `src/*.mjs` et `templates/` sont désormais versionnés
  (constaté le 2026-10-10 en clonant la dev) : un checkout propre a tout le
  code. Un clone a seulement besoin de `npm install`, d'un `config.json` et
  d'un `.token`.

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
- **En service dans les pipelines dès la création** (0.109.0, règle « Tout
  nouveau musicien est sensé en être ») : `new-project.mjs` appelle
  `serviceNewProject` (`pipeline-onboard.mjs`). Dossier neuf : `git init` +
  `.gitignore` ; sans commande de test déclarée ni autre pile : suite Node
  minimale (`package.json` `"test": "node --test"`, `tests/smoke.test.mjs`) ;
  commit de ce que la création a écrit, et seulement cela ; suite lancée,
  verte exigée ; `pipeline.json` commité ; `enforcement.projects`. Impossible
  (dossier existant sans git, autre pile sans test, suite rouge, arbre sale,
  tour en cours) ⇒ « ⚠ HORS SERVICE » + raison, **code 67**, jamais en
  silence. Relance idempotente ; le chef reste au Routage. Recette :
  `_test_new_project_service.mjs`.

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

## Sorties HTML des models (0.105.0)

Demande utilisateur (2026-10-16) : « il faut qu'elles soient au format html (et
que le client web soit capables de les afficher correctemetn) ». La consigne
côté models est une autre tâche ; ici, le rendu.

- `public/html-render.js` (`HtmlRender`, sans import ni export, testé sous
  Node) : `isHtml` (fragment HTML ou Markdown/texte ; code en ligne et blocs
  ignorés), `sanitize` (liste blanche, re-sérialisation sans DOM), `toPlain`
  (texte façon Markdown pour la lecture audio et les résumés).
- **Tout passe par `mdToHtml`** (app.js) : HTML → `sanitize`, sinon le chemin
  Markdown d'avant. Les demandes de l'utilisateur : `mdToHtml(t, {html:
  false})`, jamais interprétées comme HTML.
- **Liste blanche** : balises de texte, listes, tableaux, `pre/code`,
  `details`, liens. Supprimés avec leur contenu : script, style, iframe, svg,
  math, object, embed, template, textarea… Attributs : `title`, `lang`, et
  quelques-uns par balise (`href`, `colspan`, `start`, `open`, `class`
  `language-*` sur code/pre). Liens : http(s), mailto, `/`, `#` seulement,
  jugés après décodage des entités et retrait des caractères de contrôle,
  ouverts avec `rel="noopener noreferrer"`. Toute balise est refermée, une
  fermeture parasite est ignorée : un fragment ne sort jamais de sa bulle.
  **N'ajouter à la liste blanche ni balise active ni attribut d'événement.**
- `turn-core.js` (résumés du journal) retire aussi les balises côté serveur
  (sans html-render.js) : redémarrage nécessaire pour le journal servi.
- Recettes : `_test_html_output.mjs` (dont 20 injections refusées),
  navigateur `html-output`.

## Identifiants cliquables et leur overlay (0.107.0)

Demande utilisateur (2026-10-16) : « il faut que toutes references a un
identifiant quelconque soit un lien qui ouvre un overlay qui decrit ou explique
ce qu'est cet identifiant ».

- **Client** (`public/id-links.js` + `id-links.css`, `IdLinks`, testé sous
  Node) : `mdToHtml` passe sa sortie assainie à `IdLinks.linkify` (option
  `{idrefs: false}` pour s'en passer). Liens : balises `[[valeur]]` /
  `[[type:valeur]]` des models, et formats connus (`t-…`, `p-…`, `q-…`,
  `vX.Y.Z`, chemin de fichier avec `:ligne`, case **exacte** de la page Models,
  hex de 7 à 40 avec au moins une lettre, noms de projets). Jamais dans `<a>`
  ni `<pre>`. Un nom en minuscules n'est pas lié après un déterminant (« la
  garde »), les mots génériques (`COMMON_WORDS`) et le chef seulement balisés,
  un identifiant en chiffres seuls aussi. Vocabulaire : `GET
  /api/identify/vocab` (projets, cases). Clic → `#idref-overlay` (✕, Échap en
  capture qui ne ferme que lui, clic hors zone), liens utiles : volet,
  onglets TODO / Git / Release / Requêtes, page Models.
- **Serveur** (`scripts/id-resolve.mjs`, `resolveId`) : `GET
  /api/identify?id=&kind=&project=`, **lecture seule** : TODO_LIST.md, run.json,
  file, `routage-pending.json`, `git log -1` (argv, `GIT_OPTIONAL_LOCKS=0`),
  CHANGELOG.md, config.json, `stat` d'un fichier **dans** un dossier de projet
  (jamais son contenu), cases de la page Models. Inconnu : `known: false` et un
  message clair, jamais une erreur.
- **Consigne** (`idRefRule` de `dispatch.mjs`) : tout tour dont le texte va au
  lecteur (musiciens, chef, étapes `ID_MARK_STEPS` = Rapporter et Répondre ;
  pas les branches du mode double ni les autres étapes) ; jamais de balise dans
  du JSON, du code, une commande ou une valeur lue par un programme.
- La lecture audio, les résumés du journal (`turn-core.js`) et
  `report-check.mjs` tiennent compte des balises. **L'app Android affiche
  encore les balises brutes.** Redémarrage nécessaire (routes, journal).
- Recettes : `_test_id_links.mjs`, HTTP `identify`, navigateur `id-links`.

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

- **Rien n'est imposé** pour l'instant. Chaque entrée est journalisée dans
  `logs/pipeline-observe.ndjson` par `scripts/pipeline-observe.mjs`. Depuis
  0.66.0, le journal ne garde que le **choix explicite** (`explicitChoice` :
  préfixe, entrée système). Il n'y a plus aucun classifieur à règles ; le reste
  est « à classer » par le model (voir « Aucun routage par mots-clés »).
  - Les entrées : `/api/dispatch` (dashboard ou Android × chef, @mention,
    musicien), `dispatch.mjs` hors serveur (`dispatch-cli`, appelant déduit du
    cwd), réveil, relais dans les deux sens, notify, session neuve, **terminal
    interactif** (une ligne validée = une entrée), et un filet de sécurité dans
    `spawnDirectDispatch`.
  - **Inclassable = Discussion** (règle utilisateur) : c'est une consigne du
    model de classement depuis 0.66.0.
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
  complet pour du développement, le mode est **léger**. Depuis 0.66.0, c'est une
  consigne du model de classement (`classificationPrompt`).
- **Lacunes (0.42.0)**. Règle utilisateur : « si il manque des taches, ou une
  etape ne peut pas etre classee en une tache precise, il faut remonter
  l'information en proposant une solution ».
  - **Détection (0.66.0) : par le model, jamais par mots.** `detectGap()`
    n'existe plus.
    - Le model de classement renvoie `lacune` (une phrase de proposition) pour
      une demande d'action qu'aucun pipeline ne couvre. `dispatch.mjs`
      l'enregistre (`entry: 'signalement'`, clé `model:<hash>`).
    - Le Routage du chef (Classifier « lacune ») le fait par
      `emitRoutingGap`.
    - Un signalement explicite passe par `POST /api/pipeline-gaps`.
    - Une lacune acceptée complète la **description** des pipelines lue par le
      model (`classifierChoices`). Elle n'apprend plus aucun mot-clé
      (`classifierExtras` supprimé).
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
  - `_test_responses_shim.mjs` (bout en bout réel avec faux fournisseurs).
    Depuis 0.73.1, son bac à sable `harnais-*` est supprimé à chaque sortie,
    et codex y reçoit un `TEMP` privé : un `CODEX_HOME` neuf obtenait sinon
    l'écriture sur tout `%TEMP%` (nouveau SID de capacité à chaque exécution),
    et la première commande ralentissait d'exécution en exécution ;
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
  - **Exécution orpheline** (0.114.0) : `running` avec un `pid` mort (tour
    tué par kill-stalled, plantage) ⇒ `reclaimOrphanedRun` la met en pause
    `orphaned` (question claire, `system/pipeline_orphaned`, **sans** result :
    ni drain ni réveil), reprise à l'étape interrompue. Appliqué par
    `--pipeline-resume`, « continuer » et le départ d'une nouvelle exécution
    (fini `interrupted` sans reprise). Recette : `_test_orphaned_run.mjs`.
  - **Message joint à une reprise** (0.114.2, « Corriger la cause ») : le
    texte d'une reprise (`--pipeline-resume <run> "<texte>"`, `[CHEF_ANSWER]`,
    « continuer … »), sauf simple décision (`resumeMessage`), va tel quel dans
    `run.json` (`resumeMessages`) et dans les consignes de l'étape reprise,
    de ses nouveaux essais et des suivantes (`resumeMessagesBlock`). Trace
    `system/pipeline_resume_message`. Recette : `_test_resume_message.mjs`.
  - **Artefact = travail** (0.114.3, « corriges les tests qui font que ca
    bloque ») : `checks.artefactIsWork` (Données › Présenter) juge l'étape sur
    son artefact et ses sections, jamais « aucune modification ». Un marqueur
    « rien à faire » combiné à des sections : consigne et refus les nomment
    (`nothingHint`). Recette : `_test_presenter_artefact.mjs`.
- **Étape** : `dispatch.mjs --pipeline-step <run>:<clé> --pipeline-session
  <groupe>`, avec `ORCH_STEP_TOKEN`.
  - La clé vaut `<n>-<étape>`, avec n = `padStart(2)` du nombre d'étapes :
    3 chiffres dès la 100ᵉ. Les validateurs (`dispatch.mjs`, `STEP_KEY_RE`)
    acceptent de 2 à 6 chiffres depuis la 0.64.1. Recette :
    `_test_step_key_3digits.mjs`.
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
  - Il utilise le model de la case `routage.classifier`, tout fournisseur
    depuis 0.53.0.
  - Sortie JSON validée (pipeline, mode, nature d'une demande de dev,
    lacune), avec une nouvelle tentative. **Plus aucun repli par règles
    depuis 0.66.0** : voir « Aucun routage par mots-clés ».
  - Chaque décision ou échec est tracé dans `logs/pipeline-classify.ndjson`.
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
  - Le serveur retient chaque ligne sans choix explicite, la fait classer par
    le model (0.66.0, `toClassify`) et la transmet si c'est une Discussion.
    Sinon, ou en cas d'échec du classement, il envoie `route-confirm` et
    attend `{type:'route', id, action: run|discuss|cancel, project?}`.
    `!`/`#` et les préfixes restent décidés sans model.
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

## Aucun routage par mots-clés (0.66.0)

Demande utilisateur (2026-10-10) : « Ce n'est pas une recherche de mot qui
pourra faire un routage efficace, c'est une recherche de sens que seul un
modele peut faire ». **Toute décision de routage ou de classement est prise
par le model de la case `routage.classifier`.**

- **Supprimés** :
  - le classifieur `règles-v1` (`RULES`, `QUESTION_START`, `ACTION_REQUEST`,
    `MEDIA_VERB`, `HEAVY`/`LIGHT`, `classify`) ;
  - le repli par règles de `classifyEntry` ;
  - `detectGap` et `significantWords` ;
  - les mots-clés appris des lacunes (`classifierExtras`, `keywords`) ;
  - `devKind` (nature d'une demande de dev) ;
  - `isDeliveryFix` (tri d'un constat de revue) ;
  - les regex de variantes média ;
  - le classement par mots du terminal routé ;
  - les mots d'arrêt (`STOP_WORDS`) de `src/interrupt_policy.mjs`.
- **Gardés**, car ce sont des choix explicites et non des recherches de mots :
  - les préfixes `/dev /complet /discussion…` (`explicitChoice`) ;
  - les drapeaux `--pipeline`, `--mode` et `--kind` ;
  - les entrées système (réveil, relais, notify → Routage) ;
  - `!`/`#` du terminal ;
  - la commande `!interrupt` ;
  - les réponses aux menus des pauses (« continuer », « accepter »…) ;
  - les identifiants d'exécution cités (`RUN_ID_RE`) ;
  - les sentinelles `NEEDS_USER_INPUT` / `NEEDS_CHEF_INPUT`.
- **Échec du model** (case vide, model indisponible, réponse invalide deux
  fois) : `classifyEntry` renvoie `{ failed }`. `dispatch.mjs` écrit alors une
  pause (`NEEDS_USER_INPUT`) et **garde la demande** dans
  `logs/<projet>.a-classer.json`. Réponses possibles :
  - « continuer » : nouvel essai ;
  - un préfixe seul, comme « /dev /léger » : appliqué à la demande gardée ;
  - « abandonner » : la demande est oubliée.

  Jamais de repli lexical. Pour une variante média, l'exécution se met en
  pause `classifier`.
- Recette : `_test_no_lexical_routing.mjs`. Elle fait un scan statique des
  modules et vérifie, avec le vrai dispatch, la pause sans perte de message,
  la nature, la variante et la lacune par le model. Les suites d'observation,
  de lacunes et d'entrées ont été réécrites dans ce sens.

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
  (`lire, comprendre, decomposer, classifier, affecter, dispatcher,
  rapporter` depuis 0.69.0, voir plus bas) et `callback` (`lire, callback,
  rapporter`). Pas de git : `needs.git:false`,
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
- **Variantes** (`variants: {nom: description}`) : depuis 0.66.0, le model de
  la case `routage.classifier` choisit la variante par le sens de la demande
  (`chooseOption`), mémorisée dans `state.variants`. Un échec met l'exécution
  en pause (`classifier`) ; « continuer » réessaie. La case
  `pipeline.étape.variante` passe en tête de `chain`.
- **Outil local** : `localToolFor(assignments, chain)` repère une case
  `provider: 'local'`. L'étape reçoit `OUTIL_LOCAL=`.
- La vérification reçoit `ctx.lastMedia`. Les fichiers produits sont listés
  dans le résultat final (`state.media`).
- Fake claude : `MEDIA=` produit un vrai petit fichier (PNG, WAV, texte,
  en-tête MP4) ; `FAKE_PIPE_TRANSCRIPT`.
- Recettes : `_test_pipeline_media.mjs`, HTTP `pipeline-media`.

## Pipeline « Compte rendu de réunion » (0.110.0)

Demande utilisateur (2026-10-16) : « Il faut un nouveau pipeline, plus adapté
aux demandes de gestion de compte rendu de réunions » (une demande de
rangement des fichiers d'une réunion était partie en Maintenance).

- `reunion` dans `pipeline-catalog.mjs` : Inventorier (`inventaire.json`) →
  Lister ce qui sera supprimé (`suppression.json`, `askUser: 'doutes'`) →
  Enregistrer la version définitive (`definitif.json`) → Supprimer (étape de
  **code** `reunion-supprimer`) → Regrouper, nommer, indexer
  (`rangement.json`) → Vérifier (code `reunion-verifier`, `verification.md`,
  le résultat final) → Livrer (`crit: 'livrer'` : version, CHANGELOG, commit
  local, jamais de push).
- **Critères** : `scripts/meeting-check.mjs` (`checks.meeting`), appelés par
  `meetingCheck` / `meetingContext` du moteur : fichiers inventoriés existants,
  chaque fichier dans UNE seule liste, seuls `brouillon` / `doublon`
  supprimables, texte définitif = passage de `demande.md` (espaces, guillemets
  et apostrophes normalisés seulement), éléments gardés dans le dossier et
  cités par un index qui contient le nom de la réunion, rien d'autre ne change.
- **Suppression par le code seulement**, depuis la liste explicite, revalidée ;
  chaque fichier est d'abord copié dans `logs/runs/<run>/corbeille/`.
- **Doutes** : une liste avec `doutes` met l'exécution en pause `doutes`
  AVANT toute suppression (`pauseForDoubts`). « continuer » garde les fichiers
  en doute ; « tout supprimer » (`dispatch.mjs`, seulement si `pausedLimit ===
  'doutes'`) les supprime aussi (`state.deleteDoubts`).
- Sélection : préfixes `/reunion`, `/réunion`, `/compte-rendu` ; option
  « Réunion » du sélecteur (dashboard, app Android 0.12.0) ; sept cases
  `reunion.*` sur la page Models. Classement par le sens : description du
  pipeline, Maintenance limitée au code, règle `MEETING_RULE` de
  `pipeline-classify.mjs` (jamais de mots-clés).
- **Mise en service** : `enforcement.pipelines` est une liste explicite ;
  ajouter `reunion` par `node scripts/pipeline-enforce.mjs pipelines all`.
- Au passage : un artefact réduit au marqueur « rien à faire »
  (`RIEN_A_NETTOYER`…) n'est plus refusé comme vide (minimum de 20 caractères).
- Faux claude : `REUNION=definitif|rangement` (`FAKE_PIPE_JSON`,
  `FAKE_REUNION_TEXT`), `FAKE_PIPE_MARKER_ONLY=1`.
- Recette : `_test_reunion_pipeline.mjs`.
- **Lien interne vers la Rédaction** (0.111.0, demande « Fais un lien entre le
  pipline Réunion vers le pipline Rédaction. Il peut être optionel, un routage
  interne en fonction du besoin ») : avant toute étape, le model de
  `routage.classifier` choisit par le sens (`chooseOption`, `catalog.route`)
  `rangement` (plan de 0.110.0, défaut de `planSteps`), `redaction` (Rédiger,
  Relire, Mettre en forme, `livrer-texte` sans version : cases et critères de
  la Rédaction, `fromPipeline: 'redaction'`) ou `les-deux` (rangement puis
  rédaction, une livraison `livrer`). `state.route`, `state.mode` et
  `state.plan` suivent le choix ; `final` dépend du mode. Échec ⇒ pause
  `classifier` avant toute étape. Trace `system/pipeline_route`. Page Models :
  deux renvois (`ref`), aucune case de plus. Faux claude : `FAKE_CLAUDE_CHOICE`.
  Recette : `_test_reunion_redaction_route.mjs`.

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

## Routeur : les lignes « TODO: » vont dans la TODO list, par le code (0.84.0)

Demande utilisateur (2026-10-13) : « Dans ma requete, si je commence par
TODO: , alors ce qui suit doit etre ajoute dans la todo list. Ce doit etre une
fonctionalite codee dans le routeur. »

- `dispatch.mjs`, à l'entrée du tour du chef, **avant** le Routage et sans
  model (`scripts/todo-capture.mjs`) : seulement un message de l'utilisateur
  (pas de `--source` : ni callback, ni relais, ni réveil, ni musicien).
- Chaque ligne qui commence par `TODO:` (aussi `TODO :`, toute casse) devient
  un item du `TODO_LIST.md` **du chef** (celui du panneau TODO, lu par
  `routingContext`) : format de `todo.mjs`, daté, texte verbatim, même verrou
  et écriture atomique. Trace : `system/todo_capture`.
- Message fait seulement de lignes TODO : le tour se termine aussitôt
  (réponse synthétique « 📝 Ajouté… », result `todo_capture: true`), aucun
  model, aucune exécution du Routage. Message mixte : le reste est routé avec
  une note `[Routeur]`. Écriture impossible : le message entier part au chef,
  avec la raison (rien n'est perdu).
- Recette : `_test_todo_capture.mjs`.

## Comptes rendus jamais coupés en silence (0.93.0)

Demande utilisateur (2026-10-14) : « c'est problematique. S'il n'y a pas de
taches existantes qui investigue et corrige ce probleme, il faut en creer une ».

- `conversationExcerpt` (conversation.md des étapes du Routage) : messages
  entiers jusqu'à `EXCERPT_MESSAGE_MAX` (8 000) ; au-delà, avis « ⚠ [tronqué
  par l'orchestrateur : N sur M — texte complet : …] » et texte complet dans
  `<run>/conversation/message-NN.md` ; la fenêtre de 30 000 caractères écarte
  des messages entiers et le dit.
- `clipText` pour toute coupe du contexte du chef ; `summarizeResult`
  (réveil, server.js) signale sa coupe.
- Un message d'un musicien est étiqueté « message de <musicien> », jamais
  « utilisateur » (`userSaid` ne fait confiance qu'à l'utilisateur).
- Recette : `_test_report_truncation.mjs`.
- **Compte rendu de fin de tour entier** (0.100.3, TODO t-a7f8ca, « pourquoi
  certains comptes rendus sont coupes ? ») : `scripts/turn-report.mjs`.
  `summarizeResult` (dernier paragraphe, 280 caractères) n'est plus que la
  ligne de carte ; le chef lit `fullReport` (result entier, avis au-delà de
  8 000) : champ `report` de la notification `musician_done` /
  `musician_question` (lu par `conversationExcerpt`) et de chaque élément du
  réveil (`wakeItemBody`). Redémarrage nécessaire. Recettes :
  `_test_turn_report.mjs`, HTTP `report-full`.

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
- **Lacunes** : aucune n'est jamais signalée à l'observation (0.66.0). Le
  Routage la signale (`emitRoutingGap`) si le Classifier conclut à « lacune »,
  avec la raison du model pour proposition. La porte de `dispatch.mjs` la
  signale quand le model de classement renvoie `lacune`.
- Rejet avec motif : `decideGap(…, {reason})`.
- Recette : `_test_pipeline_routage.mjs`, sections 8 et 9.

## Routage : comprendre, découper, PUIS classer chaque tâche (0.69.0)

Demande utilisateur (2026-10-10) : « le routeur ne doit pas classer une demande
entiere alors qu'elle est deja decoupee […] le model essaie de trouver le sens
global - si besoin decouper en taches plus petites - trouver un sens et router
les taches ainsi trouvees une par une ».

- **Comprendre** (`sens.json`, case `routage.lire`) : `suite | taches |
  reponse | question` et le sens global. Aucun pipeline n'est choisi, et la
  « lacune » sur le message entier n'existe plus (refusée par `jsonEnum`).
- **Découper** (`taches.json`, `validateUnitTasks`) : des tâches unitaires,
  chacune avec un projet et une seule nature de travail, sans pipeline. Seul un
  préfixe de l'utilisateur s'impose (`impose: {pipeline, mode}`). Si le
  découpage est impossible : `taches: []` et une `question`.
- **Classer** : étape de **code** `classer`, qui appelle `classifyTask` de
  `pipeline-classify.mjs` une fois par tâche. Chaque appel ne voit que sa
  tâche (`routingTaskPrompt`, `[CLASSIFY] ROUTING TASK`). Résultat par tâche
  dans `classement.json`, avec `route` à true ou false.
  - Une tâche ambiguë (`question`) ou dont le classement échoue (`failed`)
    n'est pas lancée : sa question finit le tour (`NEEDS_USER_INPUT`, plusieurs
    questions numérotées).
  - Une lacune porte sur une tâche seulement (`emitRoutingGap(…, {task,
    projet})`, texte de la tâche).
  - Une tâche « apres » une tâche non lancée ne part pas.
  - La nature d'un développement part en `--kind` (`launchTask`).
- Affecter et Dispatcher ne lancent que les tâches `route`. Une exécution en
  pause d'un moteur antérieur (sans `state.tasks`) relit l'ancien
  `taches.json`.
- Faux claude : `FAKE_CLAUDE_CLASSIFY_MAP` (`{"<extrait de la tâche>":
  <réponse>}`).
- Recettes : `_test_routage_split.mjs` (permanente, exigence utilisateur) et
  `_test_pipeline_routage.mjs` (section 9 réécrite).

## Routage : actions du chef et décomposition vide justifiée (0.70.0)

Suivi `docs/ROUTAGE-PROBLEMES.md`, n° 7 et 9 (« on commence par s'attaquer a
ca »).

- **Nature `action`** à l'étape Comprendre : une action directe du chef, seule
  ou avec des tâches. Découper, Classer, Affecter et Dispatcher tournent.
- **`taches.json`** peut porter :
  - `actions` : `[{action, projet?, raison?, note?}]`, liste blanche
    `CHEF_ACTIONS` (`restart-orchestrateur`, `kill-stalled`,
    `resolve-question`, `copy-build`), validées par `validateChefActions` ;
  - `aucun_dispatch` : la raison d'une liste vide.

  Une liste vide sans `aucun_dispatch`, `actions` ni `question` est refusée.
- **Exécution par le code** (Dispatcher, `runChefActions`) : jamais un
  dispatch, argv construit (`chefActionArgs`). `restart-orchestrateur` est
  lancé par `Win32_Process Create` → `scripts/chef-action-deferred.mjs
  --wait-pid <tour du chef>` : hors de l'arbre du serveur, après la fin du
  tour, journal `logs/chef-actions.log`. Trace : `system/chef_action`,
  `dispatch.json.actions` et une ligne du rapport écrite par le code.
- **Tests** : `ORCH_CHEF_ACTION_RUNNER=<script>` remplace chaque script. Sous
  `DISPATCH_ROOT_FOR_TESTS`, sans cette doublure, l'action est `refused` : un
  test ne redémarre jamais la prod.
- Recette : `_test_chef_actions.mjs`.

## Routage : une action du chef n'est jamais dispatchée (0.71.0)

Suivi `docs/ROUTAGE-PROBLEMES.md`, n° 8. Feu vert : « 3. J'ai lu et
j'accepte ».

- `classifyTask` peut rendre `{chef: <action>|"autre"}`
  (`parseTaskClassification`). Dans `CODE_STEPS.classer` :
  - une action de la liste blanche passe dans `state.extraActions` (même
    validation que `actions`), puis est exécutée par le Dispatcher avec les
    `actions` de `taches.json` ;
  - sinon, la tâche devient une question.

  La tâche porte `chefAction`, `route: false`.
- `ne_pas_dispatcher: true` (étape Découper) : la tâche n'est pas classée et
  devient une question (`noDispatch`).
- Une action du chef avec `apres` n'est pas exécutée : une question est posée.
- Le Dispatcher saute `route === false`, `ne_pas_dispatcher`, `chefAction`
  et `noDispatch`.
- Recette : `_test_no_dispatch_chef.mjs`.

## Routage : réponse à une pause du chef, clôture par commande (0.117.0)

Refonte du Routage, phase 0 b (`docs/ROUTAGE-SYNTHESE.md`, décisions de
l'utilisateur du 2026-10-19).

- `dispatch.mjs`, AVANT la branche du Routage (qui lance toujours une
  exécution neuve) : une réponse de pause du chef (« continuer », « accepter »,
  « abandonner », « simplifier », « changer / tester le model », SEULE,
  éventuellement avec l’identifiant ; « Arrête le tour de Q… » est une demande ;
  pas « oui » ni « go ») va à l'exécution du Routage citée dans la réponse, à
  `--pipeline-resume <run>`, ou à la dernière exécution du Routage du chef si
  elle est en pause (`chefPausedRun` ; une exécution plus récente remplace
  une ancienne pause : jamais deviné entre plusieurs).
- **Clore une exécution en pause** : `node scripts/close-run.mjs <run>
  [--reason "…"] [--by utilisateur|chef]` — `abandoned`, résumé et
  `question_resolved` dans le log, aucun result ; exécution vivante refusée
  (3), orpheline mise en pause puis close, couloir k ≥ 1 refusé (64, répondre
  « abandonner » avec `--lane k`), déjà terminée (2). Rien n'est annulé dans
  le projet.
- Les 4 pauses mortes du chef en prod ne sont PAS closes (point 7 en attente
  de l'utilisateur).
- Recette : `_test_chef_pause_reply.mjs`.

## Routage v3, phase 1 : registre des demandes et secours (0.128.0)

Décision « vas y » (2026-10-21) ; `docs/ROUTAGE-SYNTHESE.md` §3.4 et §3.9,
décisions 1 (registre en fichiers) et 8 (actions du chef par commande, inscrites
au registre). Branché sur le chef **actuel** (`off` en prod, ou `routage`) sans
rien changer à son comportement : le registre n'est qu'écrit et lu ; retirer
`logs/requests/` ne change rien d'autre.

- **`scripts/requests.mjs`, propriétaire unique** de `logs/requests/<r-…>.json`
  (verrou par demande, écriture atomique). **Ne jamais éditer ces fichiers à la
  main.** États `reçue | en_cours | attend_utilisateur | garée | à_traiter |
  suivie | terminée | abandonnée` ; tâches `en_attente_de | lancée | en_file |
  en_cours | réussie | à_traiter | annulée`. `EXITS` : pour chaque état non
  terminal, sa sortie par le chat (en phase 1 : le chef lance la commande), par
  commande, par bouton (phase 3) ou par un événement avec échéance.
- CLI : `list [--all] | show <id>[#n] | answer <id> "<texte>" | close <id> |
  retry <id>[#n] | fix <id>#<n> [--pipeline|--mode|--projet|--after] |
  cancel <id>#<n> | drop <id> | replay <id> | reconcile`. Rien n'est annulé ni
  abandonné pendant un tour vivant (code 3).
- **`dispatch.mjs`** : un tour du chef = une demande (créée, ou continuée par
  `ORCH_REQUEST_ID` pour `answer` / `retry`), issue relevée à la fin du tour
  (question, panne d'infra ou erreur ⇒ `garée`). `ORCH_REQUEST_ID` est posé
  dans l'environnement du tour du chef : ses dispatches (outil Bash, Routage)
  sont ses tâches ; jamais hérité par le tour d'un musicien, ni par une tâche
  libérée (`releaseReady`) ou une relance d'infra.
- **Accusé** : `--task-id r-…#n` (`.k` pour le k-ième lancement) écrit `taskId`
  sur le `user_prompt` ; la file le garde (`POST /api/dispatch`, drain). Second
  lancement du même identifiant (journal ou file) : refusé (65). Arrêt avant
  d'écrire la demande : tâche `à_traiter` aussitôt.
- **Réconciliation** (balayage de 60 s du serveur, `ORCH_REQUESTS_SWEEP_MS`) :
  tour du chef mort ⇒ son résultat ou `garée` ; accusés et résultats relus dans
  les journaux et la file (`dependencyResult` : une pause ne vaut jamais
  « réussie ») ; sans accusé 2 min après un lancement ⇒ `à_traiter`, jamais de
  relance à l'aveugle ; demande muette depuis 2 h signalée une fois (console et
  `server-debug.log`) ; dépendances posées par `fix --after`.
- Redémarrage nécessaire pour le balayage et le `taskId` de la file ;
  `dispatch.mjs` est actif tout de suite.
- Recette : `_test_requests_registry.mjs` (périmètre `routage`).
- **Tâche lancée avec `--pipeline`** (0.132.0, signalement « l'interface montre
  toujours la question de psyProfile, alors que je crois y avoir répondu ») :
  le moteur écrit le `user_prompt` de l'exécution avec l'accusé (`eventTag` de
  `runPipeline` / `answerPausedRun`, fourni par `taskTag` de `dispatch.mjs`) ;
  **toute nouvelle écriture d'un `user_prompt` hors de `musicianLog` doit
  passer par lui**. Accusé manqué (`sans-accusé`, `lancement`) : rattrapé par la
  réconciliation (`recoverAck`, empreinte du texte). Demande abandonnée à tort :
  `requests.mjs recheck <id> [--by chef]`. Le dashboard n'affiche pas le
  registre. Recette : `_test_requests_pipeline_ack.mjs`.

## Routage v3, phase 2 : tour unique du chef, en OMBRE (0.130.0)

Décision « vas y » (2026-10-22) ; `docs/ROUTAGE-SYNTHESE.md` §3.9, table §3.3,
décisions 2 (claude-sonnet-5-5, case `routage.chef`), 3 (classement par tâche,
en parallèle) et 8 (actions typées). **Le chef réel ne change pas** :
`chefMode` reste `off` en prod ; la bascule (`v3`) est la phase 4, décision de
l'utilisateur (`pipeline-enforce.mjs chef-mode v3` refuse, 64).

- `scripts/chef-turn.mjs` (`runChefTurn`) : chemins directs par le code, 0 appel
  (`directPath` : `TODO:`, `/chef-discussion`, mot de menu seul avec l'exécution
  citée ou la seule en pause, `/abandonne p-…`) ; sinon contexte compact
  (`compactContext` : projets, `routingContext`, demandes ouvertes du registre,
  files, conversation sans coupe silencieuse), UN appel (stdin stream-json, sans
  outil d'écriture, dossier temporaire), bloc ```plan obligatoire (`{}` = rien),
  UN nouvel essai, classement de chaque tâche en parallèle (`classifyItems`,
  `logsDir: null` : aucun journal de classement), bloc de faits écrit par le
  code. Pannes (§3.7) : OAuth et limite garées sans essai, refus = un essai en
  session neuve, sortie sans résultat = essais à 30 s et 2 min.
- `scripts/plan-repair.mjs` (`extractPlan`, `repairPlan`) : la table §3.3. Une
  contrainte n'est **jamais** retirée (une dépendance fausse reste, la tâche
  passe `à_traiter`) ; reprise seulement par `reprises[]`.
- Actions typées du chef : entrées `scope: 'chef'` du registre UNIQUE
  `scripts/typed-operations.mjs` (`CHEF_OPERATIONS`, `CHEF_OPERATION_IDS`) :
  `cancel_run`, `stop_turn`, `resolve_question`, `restart` (différé ; pid de
  `/api/version`), `todo_add`, `copy_build` partagée. `OPERATION_IDS` (pipeline
  Opérations d'un musicien) ne les contient jamais. **Ne pas créer de seconde
  liste.**
- **Ombre** : `node scripts/pipeline-enforce.mjs chef-shadow on|off`
  (`model-routing.json` → `chefV3`, `pipeline-tuning.mjs`, relu à chaque tour
  du chef ; `off --all` la coupe). À chaque nouveau message de l'utilisateur au
  chef, `dispatch.mjs` lance `chef-turn.mjs shadow` détaché ; il n'écrit que
  `logs/chef-shadow/` (`<id>.json`, `journal.ndjson`). Lecture :
  `node scripts/chef-turn.mjs list | show <id>`. Aucun redémarrage nécessaire.
- Corpus réel anonymisé `tests/routage-corpus/` (59 cas) :
  `node scripts/chef-turn.mjs corpus [--live]` (`--live` = banc contre le vrai
  model, hors non-régression).
- Limite de la phase 1 levée : une tâche « apres » du Routage est une tâche de
  la demande d'origine dès sa décision (`en_attente_de`, `waitsFor`), lancée à
  la libération avec son `--task-id` (`markReleased` avant la réécriture du
  fichier d'attente).
- Recettes : `_test_plan_repair.mjs`, `_test_chef_turn_calls.mjs`,
  `_test_routage_corpus.mjs`, `_test_chef_typed_actions.mjs`,
  `_test_requests_pending_link.mjs` (périmètre `routage`).

## Routage : renvoi au chef, qui agit lui-même (0.88.0)

Demande utilisateur (2026-10-14) : « IL faut que le routage puisse renvoyer au
chef pour qu'il agisse lui meme ».

- **Découper** : une tâche peut porter `renvoi_chef: {raison}` (projet : le
  chef ou le projet concerné). Sans lui, une tâche au chef reste refusée
  (« le chef ne se délègue pas de tâche »). Exclusif avec `apres`,
  `impose`, `hors_pipeline`, `reprise`, `ne_pas_dispatcher` ; aucune
  tâche ne peut attendre une tâche renvoyée.
- **Classer** : le model doit répondre `chef`. S'il voit un pipeline (travail
  de projet : code, git, build), le renvoi est refusé et devient une question.
  Action de la liste blanche : exécutée par le code, comme avant ; `chef:
  "autre"` : renvoyée au chef (ce n'est plus une question).
- **Dispatcher** : UN tour du chef pour toutes les tâches renvoyées, lancé
  détaché par `chef-action-deferred.mjs --handoff logs/runs/<run>/handoff.json`
  après la fin du tour du Routage, hors Routage : `dispatch.mjs <chef>
  --chef-handoff <run>#<n,…>` signé par `ORCH_HANDOFF_TOKEN`
  (`handoffToken` / `verifyHandoff`). Sans le bon jeton : 65 ; vers un
  musicien : 64.
- **Traces** : `system/chef_handoff`, `dispatch.json.handoff`,
  `user_prompt.chefHandoff`, ligne du rapport écrite par le code. Le relevé
  de mise en service ne le compte pas comme contournement. Racine de test :
  aucun tour réel sans `ORCH_CHEF_HANDOFF_TEST=1`.
- **Jeton vérifié avant la garde P0-B** (0.100.1, t-dd3d21, « 1. oui / 2. A ») :
  le lanceur hérite de `DISPATCH_SLOT` du tour du chef ; seul `--chef-handoff`
  avec un jeton valide pour SA référence passe, tout autre chef → chef reste
  en 65. Le renvoi a sa session (`logs/runs/<run>/handoff.session`, jamais
  `logs/chef.session`) et ne tamponne aucun slot/ticket.
- **Renvoi refusé ou en échec = carte dans le fil du chef** (0.100.2,
  « 3. oui ») : `chef-action-deferred.mjs` ajoute au log du chef une
  `notification/musician_done` `outcome: failed` (`handoff {ref, run, tasks,
  code, why}`) : référence, titre, code, raison. `logs/chef-actions.log`
  garde « exited with N: <raison> » (lu par la vue Requêtes). Recette :
  `_test_chef_handoff_failed.mjs`.
- Recettes : `_test_chef_handoff.mjs`, `_test_chef_handoff_slot.mjs`, `_test_chef_handoff_failed.mjs`
  (`DISPATCH_SLOT` gardé, comme en prod), section 5 de `_test_no_dispatch_chef.mjs`.

## Routage : session neuve par le vrai drapeau (0.95.0)

Demande utilisateur (2026-10-14) : « demande à orchestrateur-dev de faire
passer --new-session par le Routage. »

- **Découper** : `"session_neuve": true` sur une tâche (session neuve demandée,
  ou session devenue trop longue). Booléen seulement ; exclusif avec
  `reprise` et `renvoi_chef`. Écrire « --new-session » dans la demande n'a
  aucun effet.
- Le champ suit la tâche (`sessionNeuve`) ; `launchTask` ajoute
  `--new-session` (tour ordinaire, hors pipeline, tâche en attente libérée) ;
  un musicien occupé reçoit l'entrée de file avec `newSession`. codex :
  ignoré par `dispatch.mjs`.
- Recette : `_test_routage_new_session.mjs`.

## Dossier du chef : rien n'est annulé pendant le Routage (0.71.1)

Suivi `docs/ROUTAGE-PROBLEMES.md`, n° 18.

- Dans un dossier hors git (`walkSnapshot`, `isWalkSnapshot`), un changement
  constaté pendant une étape de jugement ne la fait plus refuser
  (`checkCatalogCriteria`, champ `externalChanges`), et `restoreFiles` ne
  touche jamais à ce dossier.
- Signalement : `system/pipeline_external_change {files}`,
  `state.externalChanges`, et une ligne du rapport du Routage.
- Les projets git gardent la règle stricte (refus et annulation).
- **Écrire dans `I:\Dev\Chef` n'est plus perdu**, même pendant une exécution
  du chef.
- Recette : `_test_chef_folder_writes.mjs`.

## Routage : tâche hors pipeline autorisée par l'utilisateur (0.71.2)

Suivi `docs/ROUTAGE-PROBLEMES.md`, n° 10.

- Une tâche de l'étape Découper peut porter `hors_pipeline: {raison,
  autorisation}` (`validateUnitTasks` : exclusif avec `impose`).
- **Vérification de l'autorisation** (`userSaid` du moteur) : les mots cités
  doivent figurer dans `demande.md` ou dans une ligne `**utilisateur**` de
  `conversation.md`. Une demande ou une ligne relayée (`[NEEDS_CHEF_INPUT_FROM:`,
  `[CALLBACK_WAKE`) ne compte jamais : un musicien ne s'autorise pas
  lui-même.
- Si l'autorisation est retrouvée :
  - la tâche n'est pas classée (`horsPipeline`, `classifier: 'hors-pipeline'`) ;
  - `launchTask` passe `--hors-pipeline <raison>` ;
  - le tour est signalé par `system/pipeline_hors_pipeline` et dans le
    rapport ;
  - les tâches en attente (`addPending`) gardent `horsPipeline`.
- Si elle est introuvable : la tâche devient une question.
- Recette : `_test_hors_pipeline_task.mjs`.

## Tâches du Routage en attente : jamais bloquées (0.58.0)

**Titre court obligatoire** (0.87.0, tâche 1/4 de « Lances les taches », après
la confusion par le chef de deux tâches nées de la même demande) : l'étape
Découper donne à chaque tâche un `titre` (3 à 60 caractères,
`titleProblem` de `routage-pending.mjs`, appelé par `validateUnitTasks`) ;
sans lui, `taches.json` est refusé. Le titre suit la tâche (classement,
`dispatch.json`, `routage-pending.json`) et s'affiche `id « titre »`
(`pendingLabel`) partout : `list` / `--json`, `release`, `drop`,
contexte du chef, rapport du Routage, réveils, `/api/version`. Une entrée
plus ancienne reçoit à l'affichage un titre de repli tiré de `rattache`
(`titleOf`, « titre de repli »), sans réécriture. Recette :
`_test_routage_titles.mjs`.

**Titres ambigus refusés** (0.90.0, tâche 2/4) : `ambiguityProblem` de
`routage-pending.mjs`, appelé par `validateUnitTasks`, refuse dans une même
exécution deux tâches au même titre (casse, espaces, accents ignorés) ou au
même début affiché (`displayedHead`, `DISPLAY_HEAD` = 140, la coupe de
`list`), en nommant chaque paire en conflit. Recette :
`_test_routage_ambiguous.mjs`.

**Ce qui diffère est affiché** (0.91.0, tâche 3/4) : `distinctExcerpts` de
`routage-pending.mjs` donne, pour chaque entrée dont le début affiché est
partagé, l'extrait qui commence où elle s'écarte de son jumeau le plus proche ;
`list` (« ce qui la distingue », « rattachée à »), `--json` (`distinct`) et le
contexte du chef l'affichent. Affichage seul. Recette :
`_test_routage_distinct.mjs`.

**Contrôle de la réponse du chef par le code** (0.92.0, tâche 4/4) :
`checkReportIds` de `scripts/report-check.mjs`, appliqué au rapport du
Routage (demande et réveil) avant l'envoi : identifiant connu complété par son
titre, inconnu signalé, identifiant suivi du libellé d'une autre entrée signalé
comme contradictoire (avec le bon identifiant) ; `q-…` et `p-…` inconnus
signalés ; rien n'est retiré ; événement `system/report_check`. Règle
`ID_METHOD_RULE` dans les consignes des étapes qui écrivent. Recette :
`_test_report_check.mjs`.


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
- **Reprise** : une tâche `reprise: <run>` part en `--pipeline-resume`.
  **Seul ce champ reprend** (0.116.0, phase 0 c, décision 4 de l'utilisateur) :
  un identifiant d'exécution cité dans une demande n'est qu'une référence,
  jamais une reprise (`detectReprise` ne lit plus le texte). Recette :
  `_test_resume_explicit_only.mjs`.
- **Doublons** (0.67.1, `identities`) : refusés sur une identité explicite,
  **jamais sur un début de texte** :
  - même tâche du même Routage (`run#n`) ;
  - reprise de la même exécution ;
  - même contenu (SHA-256 du texte complet + projet + pipeline + mode + projet
    attendu).

  Chaque doublon écarté est journalisé (`logs/routage-pending-duplicates.ndjson`),
  listé dans `dispatch.json.duplicates` et signalé au chef
  (`routage-duplicate`). `dispatch.json.waiting` ne liste que ce qui est
  vraiment en file. La tâche attendue est reconnue à `after.hash` (texte
  complet). Recette : `_test_routage_dedupe.mjs`.
- **Une pause ne libère pas** (0.115.1, phase 0 d de la refonte du Routage) :
  une exécution en pause (`pipeline_paused`) ou un tour fini sur une question
  garde la tâche qui l'attend (`releaseReady` → `held`, avec la raison) ;
  libération au résultat final de cette exécution, au tour qui répond ou à
  « Marquer comme répondue » ; exécution close sans livraison ⇒ bloquée.
  Recette : `_test_paused_dependency.mjs`.
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

## Erreurs de lancement : attentes progressives (0.60.0)

Demande utilisateur : « Apres deux erreurs, il faut un timeout avant de
recommencer deux fois […] On augmente le timeout de 10s a chaque fois. Et on
donne a l'utilisateur le choix : tester le model, changer de model, forcer un
nouvel essai ».

- **Détection** (`isLaunchFailure`, `scripts/model-backoff.mjs`) : le model n'a
  jamais travaillé. C'est le cas d'un tour mort sans rien écrire, d'un CLI mort
  sans avoir servi (« sans result »), ou d'une erreur passagère d'API (5xx,
  529, overloaded, délai, réseau) avant tout travail.
  - **Hors back-off** : un model inconnu, une limite de session, un model qui a
    démarré puis échoué, un refus sur critère.
- **Règle** :
  - ces erreurs ne comptent pas dans la limite d'essais ;
  - toutes les 2 erreurs, l'exécution attend palier × 10 s, puis fait 2 essais
    avec le même model (relu dans la page Models) ;
  - après 6 paliers, pause `launch`.
  - Réglage en test : `ORCH_BACKOFF_STEP_MS`, `ORCH_BACKOFF_MAX_TIERS`.
- **Choix** : `logs/runs/<run>/backoff-control.json`.
  - Depuis 0.72.1, une demande compte dès l'annonce de l'attente
    (`since`, pris avant l'événement `pipeline_backoff` et la notification du
    chef) ; seule une demande antérieure est périmée. Le fichier est pris par
    un renommage atomique avant lecture (`takeControl`).
  - CLI : `node scripts/model-backoff.mjs <run> status|retry|test`.
  - Après redémarrage : route `POST /api/pipeline-runs/:run/backoff` et
    boutons de la frise.
- **Test du model** : `scripts/model-test.mjs`, qui réutilise `oneShotClaude` et
  `chatCompletion`. Journal dans `logs/model-tests/`, lisible par
  `GET /api/model-tests/:name`.
- Le stderr de chaque étape est gardé : `logs/runs/<run>/<clé>.stderr.log`.
- **Refus de lancement par `dispatch.mjs`** (0.61.1, `dispatchRefusal`) :
  - signature : sortie non nulle, une ligne `[dispatch] <raison>` sur stderr,
    log d'étape vide ;
  - l'étape est classée `launch_refused`, avec une pause immédiate qui nomme
    la cause ;
  - le message ne contient jamais « le model n'a rien produit » ni « tester /
    changer le model ».
  - Ce contrôle passe avant `isLaunchFailure`.
  - Test : `ORCH_FAKE_STEP_REFUSAL=1`, `_test_launch_refused.mjs`.
- Faux claude : `FAKE_CLAUDE_LAUNCH_FAIL_FILE` (et `_ALL`, `FAKE_CLAUDE_LAUNCH_LOG`).
- Recettes : `_test_model_backoff.mjs`, HTTP `model-backoff`.

## Pannes d'infrastructure : en attente de relance, relancées automatiquement (0.118.0)

Refonte du Routage, phase 0 a (`docs/ROUTAGE-SYNTHESE.md` §3.7).

- `infraFailure` (`model-backoff.mjs`), sur un tour d'étape en échec
  seulement : `auth` (OAuth expirée), `limit` (limite de session ou
  d'usage), `refusal` (« can't help with this. Start a new session »).
  Avant les échecs de lancement et « model indisponible ».
- Moteur : aucun essai compté, aucun défaut, aucun `[DÉFAUT]`, aucune pause
  « critère ». Refus ⇒ UN essai en session d'étape neuve ; sinon pause
  `infra` (`state.infra`, `system/pipeline_infra_hold`, message écrit par le
  code). La pause `launch` (sortie sans résultat après les attentes) est
  inscrite aussi.
- `scripts/infra-retry.mjs` (`logs/infra-retry.json`, propriétaire unique) :
  relance `--pipeline-resume` — limite à son heure de fin, sortie à 5, 15,
  30 min, OAuth dès que le fichier d'identifiants de Claude change
  (`ORCH_CLAUDE_CREDENTIALS`), refus jamais. Balayage en fin de chaque tour
  de `dispatch.mjs` et toutes les 60 s dans le serveur (redémarrage
  nécessaire pour ce dernier). CLI `list | show <run> | sweep [--dry-run]`.
- Hors champ : un tour ordinaire (hors pipeline) garde son comportement.
- Faux claude : `FAKE_CLAUDE_INFRA_FILE`. Recette : `_test_infra_retry.mjs`.

## Refonte des pipelines, phase 0 : gains rapides et interrupteurs (0.120.0)

Décisions de l'utilisateur du 2026-10-20 (« tout comme recommandé ») :
`docs/PIPELINES-SYNTHESE.md` §11, plan §8. Une phase qui s'en écarte demande
une nouvelle décision.

- **Interrupteurs** (`scripts/pipeline-tuning.mjs`) : `model-routing.json` →
  `enforcement.tuning {levier: true | [projets]}`, écrit par `node
  scripts/pipeline-enforce.mjs tuning <levier|all> on|off [<projet>]`, relu à
  chaque dispatch, **figé dans `run.json.tuning` au départ** (une reprise garde
  ses réglages ; une exécution d'avant 0.120.0 : tout coupé). **Tout est coupé
  par défaut** ; `off --all` les remet à zéro. Mise en service par le chef
  après le bond, `pipelineLab` d'abord.
- `citedPathsLog` (`scripts/cited-paths.mjs`) : un chemin cité est jugé sur
  ce que le tour a observé (Read réussi, sortie d'outil), les noms de
  l'orchestrateur, chemins abrégés ou hors projet acceptés et **signalés**
  (`citedReported`) ; un chemin inventé du projet reste refusé.
- `codeDeliver` (`scripts/code-delivery.mjs`) : le model n'écrit que le
  texte de Livrer (`LIVRAISON=texte`, `bump`, `## CHANGELOG`, `## Exigence`,
  `## Livré`) ; le programme écrit version, entrée, exigence, commit, puis le
  **même** critère de Livrer. Texte invalide ⇒ nouvel essai ; refus du
  programme (suite rouge) ⇒ pause aussitôt (`noRetry`). Livraison sans version
  (Rédaction, médias) ⇒ un commit du programme, sans model.
- `codeFormat` : Mettre en forme par le programme (aucune correction, texte
  dans l'artefact, remplacements exacts `{fichier, avant, apres}`), sinon le
  model.
- `suiteCache` (`scripts/suite-cache.mjs`) : suite verte réutilisée pour un
  arbre, une commande et un environnement identiques (24 h,
  `logs/suite-cache/`), jamais un résultat rouge ni une suite à passer deux
  fois ; chaque réutilisation est dite (`pipeline_suite_cached`).
- `inertCleanup` (`scripts/inert-custom.mjs`) : pipelines ajoutés non
  exécutables et rattachements à mots-clés cachés au classement et à la page
  Models ; `scripts/pipeline-cleanup.mjs plan|apply|restore` les retire avec
  sauvegarde.
- Garanties TDD inchangées (Rouge réel, Vert sans toucher aux tests, revue par
  item, tout défaut bloque).
- Recettes : `_test_cited_paths_log.mjs`, `_test_code_deliver.mjs`,
  `_test_suite_cache.mjs`, `_test_inert_cleanup.mjs` ; sections « par le
  programme » des tests ⚠ `_test_item_delivery`, `_test_release_prebump`,
  `_test_lane_changelog_rule` (accord du 2026-10-20).

## Refonte des pipelines, phase 1 : les génériques (0.129.0)

Décision « vas y » (2026-10-21) ; `docs/PIPELINES-SYNTHESE.md` §3.3, §8.2,
décisions 4, 5 et 10 (« tout comme recommandé »). État livré et mesures : §11.3.

- **Interrupteurs** (`pipeline-tuning.mjs`, coupés par défaut, figés dans
  `run.json.tuning`) : `generic` (génériques proposés au classement, modes
  génériques, préfixes `/operations`, `/fichiers`, `/document`, `/verification`,
  `/interne`) et `discussionOne` (levier 6). Coupés = exactement 0.128.0. Mise en
  service par le chef après le bond, `pipelineLab` d'abord ; `operations` et
  `fichiers` doivent aussi entrer dans `enforcement.pipelines`
  (`pipeline-enforce.mjs pipelines all`).
- **`scripts/typed-operations.mjs`, registre unique** des opérations typées
  (`{label, irreversible, params, prepare, verify}`), à réutiliser tel quel par
  les actions typées du chef (Routage v3, phase 2) : `git_push`, `git_tag`,
  `git_push_tag`, `git_restore`, `prod_jump` (PLAN seulement, jamais
  `--apply`), `copy_build`, `adb_install`, `service_restart` et `run_script`
  (seulement ce que déclare `.orchestrateur/pipeline.json` →
  `operations.services|scripts`, contrôle obligatoire). Argv en tableau,
  préconditions d'abord, **effet relu** ensuite : un code retour seul ne vaut
  jamais « fait ». `ORCH_ADB` (chemin d'adb, ou script Node de test).
- **Pipeline `operations`** : Préparer (model, sauté si le classement a nommé
  toutes les opérations) → Autoriser → Exécuter → Rapporter (code). Une
  opération irréversible part seulement avec les mots exacts de l'utilisateur
  (`userSaid`) ou la réponse « autoriser » à la pause `autoriser` ; jamais par
  la réponse automatique (`USER_ONLY_PAUSES` de `auto-answer.mjs`). Pause
  `operation` (« relancer l’opération ») sur une condition ou un effet faux ;
  une opération vérifiée n'est jamais relancée (`state.opsDone`).
- **Pipeline `fichiers`** (`scripts/files-check.mjs`) : le model écrit la liste
  (`fichiers.json`) et télécharge ; copier, déplacer, renommer, supprimer
  (corbeille `logs/runs/<run>/corbeille/`) et comparer sont faits par le code,
  chaque effet relu ; doute ⇒ pause `doutes` avant toute suppression ; la
  livraison ne commite jamais un binaire.
- **Rédaction `document`** (`scripts/document-check.mjs`) : Cibler (programme
  si un seul document nommé, sinon model) → Modifier (case
  `redaction.modifier.<opération>`) → Relire (au-delà de 80 lignes) → Livrer
  (programme, sans version). Copie des cibles d'abord (`doc-base.json`,
  `sauvegarde/`) ; hors git, un essai refusé est annulé depuis la copie.
- **Discussion `verification`** (preuves vérifiées dans le journal du tour,
  `toolUsesInTurn` de `cited-paths.mjs`) et **Recherche `interne`** (sources =
  fichiers du projet, web refusé).
- **Étapes du catalogue** : `kind: 'code'` peut rendre `{pause}` ou
  `{finish}` ; `codeFirst` (le programme fait l'étape, sinon le model),
  `chainFrom` (case choisie d'après un artefact), `skipUnless` (`SKIP_RULES`),
  `needsByMode`. Page Models : `code: true` = étape sans case (badge
  « programme »).
- Corpus réel anonymisé `tests/pipeline-corpus/` ; mesures hors non-régression :
  `node scripts/pipeline-corpus-classify.mjs --model <id>` (vrai classement) et
  `node scripts/pipeline-discussion-bench.mjs --routing <model-routing.json>`
  (vrais tours, racine jetable).
- Recettes : `_test_typed_operations.mjs`, `_test_generic_operations.mjs`,
  `_test_generic_files.mjs`, `_test_generic_document.mjs`,
  `_test_generic_modes.mjs`, `_test_pipeline_corpus.mjs` (série).

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
  - **0.61.0** (décision « c+d ») : chaque case ouverte annonce
    `(tests: N)`, avec N de 1 à `LIMITS.testsPerItem` (2 par défaut,
    `ORCH_PIPE_TESTS_PER_ITEM`). Une case sans déclaration ou au-delà du
    plafond est refusée, avec un message qui demande de redécouper.
    - Même règle pour les entrées de `revue.json` en mode complet, qui
      deviennent des cases `(revue)`.
    - Recette : `_test_tests_per_item.mjs`.
    - **0.62.0, vérification après coup** (`scripts/item-tests.mjs`,
      `checkItemTests`) : un test = une déclaration de cas de test (JS
      `test(`/`it(`, Python `def test_`, Kotlin/Java `@Test`, Go
      `func Test`). Le compte par fichier de test est pris au début de
      l'item (`state.itemTestBase`). Les tests de l'item sont la somme des
      hausses par fichier. Contrôle en 4a (seule étape qui écrit des tests),
      DEJA_COUVERT compris : un dépassement refuse l'essai avec « … doit être
      redécoupé ». Contrôle de nouveau avant de cocher (`@check`) : un
      dépassement met en pause (`item_tests`), sans jamais cocher. Un item
      sans déclaration ou commencé avant 0.62.0 est signalé, pas refusé.
      `pipeline_item_done.tests` porte `{declared, written}`. Recette :
      `_test_item_tests.mjs` (faux claude `FAKE_PIPE_ITEM_EXTRA_TESTS`,
      `FAKE_PIPE_DECL=two`).
    - La livraison par item (c) viendra dans une étape suivante.
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
  `items` (comportements) et `hors_tdd`. Depuis 0.66.0, ce tri est celui du
  model de la Revue seulement : `isDeliveryFix`, qui retriait par mots-clés, a
  été supprimé.
  - **Depuis 0.65.0, ils bloquent la livraison** (voir ci-dessous) : ils ne
    vont plus à Livrer. Une étape `vert` de correction (`reviewItems`,
    `state.fixGroup`) les corrige, puis l'item est relu de nouveau.
    `state.deliveryFixes` ne sert plus qu'aux exécutions en pause d'un ancien
    moteur.
  - Ils ne deviennent jamais un test et ne consomment pas la limite de tests.
    Ils comptent pour un tour de revue.
  - Livrer ajoute **d'office** la ligne du registre des exigences.
- **Tout défaut détecté bloque la livraison et est rapporté aussitôt** (0.65.0,
  règle utilisateur du 2026-10-10 : « tout problème détecté doit bloquer une
  livraison et être rapporté immédiatement ») :
  - **Aucun seuil de gravité** : P1, P2, P3, constat de doc, de registre ou de
    CHANGELOG, critère non rempli, test rouge, scan. L'audit corrige et
    re-vérifie toutes les failles, y compris basses. En Rédaction, une
    correction listée par la relecture ne peut pas être sautée par
    `RIEN_A_METTRE_EN_FORME` (critère `applies`).
  - **Rapport** (`reportDefects`) : événement `system/pipeline_defect`
    (projet, exécution, étape, item, gravité, description) dans le log du
    musicien, et `/api/notify` au chef (`source: 'pipeline-defect'`). C'est
    attendu (`await`) au moment même de la détection :
    - Revue ;
    - essai refusé ;
    - failles de l'audit ;
    - points restants d'une boucle ;
    - scanner en erreur ;
    - suite rouge en précondition.
  - Livraison : un commit d'item seulement après une Revue sans aucun défaut.
    En léger, le constat de doc renvoie à `vert` puis `revue`. Une Revue
    « problèmes » sans rien de listé est refusée.
  - **« accepter »** (`dispatch.mjs`, `o.acceptDefects`) : seule autre façon
    de livrer.
    - Pause `review` ou `items_blocked` (items mis de côté pour la revue) :
      `state.acceptReview`.
    - La Revue suivante de cet item (ou de l'exécution) est remplacée par
      `pipeline_defect_accepted`. Les défauts vont dans
      `state.acceptedDefects`, que Livrer reçoit pour le CHANGELOG
      (problèmes connus).
  - Frise : `turn-core.js` (`p.defects`) et `activite.js` (`.jt-defects`).
  - Recette : `_test_defect_blocks.mjs`.
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
- **Revue en complet : par item** (0.63.0, décision « c+d », partie c ;
  `scripts/item-review.mjs`). Le plan complet n'a plus de Revue globale.
  - `@check` insère `revue` dès que le groupe de l'item n'a plus de case
    ouverte (`groupReady`), avec `state.reviewGroup`.
  - `diff.patch` = `treeDiff(arbre au début du groupe, arbre actuel)`. Les
    arbres sont pris par `worktreeTree`, avec un index privé
    `logs/runs/<run>/item-review.idx`. Repli sur le diff complet, signalé
    dans la consigne.
  - Un défaut devient la case `(revue item N)`, insérée après le groupe N
    (`insertAttachedCases`). Les autres items ne sont pas relus de nouveau.
  - Tours comptés par item : `itemReviewRounds`, `itemReviewBudgets` pour
    « continuer ».
  - Montée en complet : le travail léger est le groupe 0, relu au premier
    `@loop` (`pendingGroupReview`).
  - Une exécution en pause sans `itemReview` garde l'ancienne Revue globale.
  - En léger : retour à 4b, comme en 0.48.0.
  - Recette : `_test_item_review.mjs`.
- **Livraison par item** (0.64.0, « c+d », partie c ; `scripts/item-delivery.mjs`).
  Drapeau `state.itemDelivery`, posé sur les nouvelles exécutions complètes
  et à la montée en complet. Le marqueur `@aside` est placé avant `livrer`.
  - Revue d'un groupe sans défaut : `deliverGroup` fait un commit du code
    (`commitWork`, sans `.claude/` ni artefacts, identité de repli), avec
    `state.lastDelivered`, `delivered[]` et `releasePending`.
  - Livrer = commit de version seulement (version, CHANGELOG, exigence),
    vérifié contre `ctx.releaseBase` (= dernier item livré). Il est sauté
    s'il n'y a rien de nouveau. Le repli des commits se fait vers
    `lastDelivered`, jamais vers `base`.
  - Limite propre à un item (revue, `item_tests`, green / criteria de
    4a/4b/4c ou de sa Revue) : `setAside`. Le préfixe du plan jusqu'à
    `@loop` est gardé, le correctif va dans `logs/runs/<run>/aside-item-N.patch`
    (`setAsideWork`), et seuls les fichiers de l'item sont remis. `@loop`
    saute ses cases.
  - `@aside` :
    - `restoreQueue` (posée par « continuer » après `items_blocked`) :
      `reapplyWork` (apply, puis `--3way` ; conflit → `aside_conflict`),
      remise du contexte, une allocation de plus ;
    - sinon, s'il reste des items de côté : la version de ce qui est livré,
      puis la pause `items_blocked`.
  - Une exécution en pause sans `itemDelivery` garde son commit unique.
  - **Correctif périmé** (0.113.2, « toujours bloque ») : au conflit, l'item
    est marqué (`conflict`, `asideConflict`) et la file restante est gardée ;
    « continuer » après `aside_conflict` l'écarte (`discardedAside`,
    `system/pipeline_aside_discarded`, correctif gardé, listé partout) et
    reprend les autres — jamais de boucle `items_blocked` ↔ `aside_conflict`.
    Une réponse du menu (« simplifier »…) arrivée avec `--pipeline-resume`
    (Routage) fait son effet (`pauseAnswer` de `dispatch.mjs`).
  - Recette : `_test_item_delivery.mjs`.
  - **Version déjà incrémentée par un item** (0.114.1, « les deux », exécution
    bloquée du 2026-10-18) : si chaque fichier de version diffère entre le
    début de l'exécution (ou sa version précédente, `ctx.versionBase`) et le
    dernier item livré (`bumpedInRun`), Livrer est contrôlé depuis ce point :
    commit de doc seule accepté, **aucun commit** accepté si version, entrée
    CHANGELOG et ligne d'exigence sont déjà commitées ; la consigne interdit
    un second incrément. Sans incrément dans l'exécution, rien ne change
    (refus). Recette : `_test_release_prebump.mjs`.
- **Montée léger → complet** : après 4b en léger, `lightScope` mesure le
  changement (plus de 3 fichiers, plus de 150 lignes, ou un nouveau fichier de
  code, hors tests). Au-delà :
  - `state.mode = complet`, `escalated` ;
  - insertion de `liste-tests, @loop` ;
  - événement `system/pipeline_escalate` ;
  - mention dans le résultat.
- **Mode et nature** : `--mode leger|complet` et `--kind
  simple|bugfix|mecanique` (0.66.0), ou les préfixes `/léger` et `/complet`.
  Sinon, le model de classement décide : nouvelle fonctionnalité → complet,
  hésitation → léger (Q9). Le moteur ne devine plus la nature (`devKind`
  supprimé) et refuse une demande de dev sans nature. Le champ `pipelineMode`
  voyage dans la file.
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
- **Explication de chaque demande** (0.78.0, demande « une demande
  d'autorisation donne la commande à autiriser. Il faut aussi donner une
  explication de celle-ci ») : `PermissionCore.explain(tool, input,
  {lastText})` → `{what, said, reason, text}`. `what` est écrit **par le code
  à partir de la commande** (étape par étape, en français, déterministe, aucun
  model), `said` est la `description` de l'appel donnée par le musicien,
  `reason` la fin de son dernier message ; secrets masqués. Champ
  `explanation` de la demande : carte (`.pc-explain`), overlay
  (`.po-explain`, en tête), log `system/permission_request`, notification de
  bureau et message `[AUTORISATION EN ATTENTE]` au chef (« Explication : … »).
  `dispatch.mjs` (`permissionExplainRule`) demande aux musiciens de remplir la
  `description` de leurs appels Bash, PowerShell et Monitor dans la langue de
  discussion. **L'app Android n'affiche pas encore l'explication** (champ
  ignoré jusqu'à une mise à jour de l'app). Recettes :
  `_test_permission_prompt.mjs` §9, HTTP `permission-prompt`, navigateur
  `permission-explain`.

## Réponse automatique quand l'utilisateur est inactif (0.121.0)

Règle utilisateur (2026-10-20) : « si aucune activite de ma part depuis plus de
15 minutes, et qu'un process attend quelque chose de moi, et que je ne reponds
pas dans les 5 minutes, opus 5.5 est charge et autorise a repondre a ma place.
Un point de retours est cree si possible. Sinon il faut avancer ». Garde-fous
confirmés : « Ces gardes fous sont tres importants, garde les ».

- Module `scripts/auto-answer.mjs` ; balayage du serveur toutes les 30 s
  (`ORCH_AUTO_ANSWER_SWEEP_MS`), une attente à la fois.
- **Activité** (`logs/user-activity.json`) : un POST de `ACTIVITY_ROUTES`
  (message du composer ou de l'app, décision d'autorisation, de pause, de
  question, de lacune, geste sur la file, `/api/user-activity`) venu d'un
  navigateur ou de l'app (`activityOf`), jamais d'un script ni d'une décision
  automatique. Inconnue = depuis le démarrage du serveur.
- **Attentes** : questions `NEEDS_USER_INPUT` (musiciens, couloirs, chef),
  pauses de pipeline, demandes d'autorisation (répondues à échéance − 90 s,
  « une fois », jamais « toujours »), lacunes proposées. Pas pendant un tour.
- **Réponse** : `claude-opus-5-5` explicite, model servi vérifié, aucun repli,
  outils Read/Grep/Glob ; il suit d'abord la recommandation donnée et les
  décisions prises (CLAUDE.md, registres, synthèses, TODO, mémoire). Puis un
  tour de vérification indépendant contre les garde-fous ; c'est
  `enforceGuardrails` (code) qui décide. Plafonds : 3 par projet, 20 par
  absence. Utilisateur revenu pendant le tour ⇒ rien n'est appliqué.
- **Garde-fous obligatoires** (`data/auto-answer-guardrails.json` + code,
  `MANDATORY_GUARDRAILS`) : argent ; secret ; envoi ou signature au nom de
  l'utilisateur ; suppression sans retour ; publication d'un dépôt privé.
  Toujours actifs, indépendants de l'interrupteur, **aucune route ni bouton ne
  les modifie** ; les changer demande une nouvelle décision explicite de
  l'utilisateur. Touchés ⇒ l'option non engageante (autorisation ⇒ refus),
  sinon rien n'est envoyé et le point est soumis à l'utilisateur (carte dans le
  fil du chef).
- **Point de retour** avant d'appliquer : tag `auto-answer/<id>` (avec le
  travail non commité, `git stash create`), copie de `run.json` ou de
  `model-routing.json` ; sinon noté, et on avance. « Annuler » : état courant
  gardé dans `auto-answer-undo/<id>`, puis retour au point.
- **Traces** : `logs/auto-answers.json` ; `notification/auto_answer` dans le
  log du processus (journal, ligne du musicien), carte `musician_done` /
  `musician_question` dans le fil du chef, marque « 🤖 réponse automatique
  (Opus 5.5, utilisateur inactif) ».
- **Interface** : pill `#btn-auto` (interrupteur global), overlay
  `#auto-overlay` (délais, garde-fous en lecture seule, décisions), bandeau
  `#auto-band` au retour (« Annuler », « ✓ Vu »).
- Réglages à chaud : `auto-answer-settings.json` (racine, non versionné ;
  `enabled`, `idleMin`, `waitMin`, `maxPerProject`, `maxTotal`,
  `permissionLeadSec`, `projects`). Routes `GET /api/auto-answer`, `POST
  /api/auto-answer/settings|seen|:id/undo`, `POST /api/user-activity`.
  Redémarrage nécessaire (routes, balayage, crochet d'activité).
- Instance de test : règle coupée par défaut, délais courts permis
  (`ORCH_AUTO_ANSWER_TESTING`), faux Opus (`ORCH_AUTO_ANSWER_CHILD_ENV`,
  `FAKE_CLAUDE_AUTO_ANSWER` / `FAKE_CLAUDE_AUTO_VERIFY`).
- Recettes : `_test_auto_answer.mjs`, HTTP et navigateur `auto-answer`.
  L'app Android n'affiche pas encore l'interrupteur ni le résumé.
- **Incident du 2026-10-20 (0.123.0)** : des lacunes de 10 jours, invisibles
  hors de la page Models, rejetées pendant que l'utilisateur lisait.
  - **Présence** : le dashboard (`public/auto-answer.js`) et l'app (0.13.0)
    envoient `POST /api/user-activity {kind: "présence"}` (1/min au plus) tant
    que l'onglet est visible, focalisé et utilisé depuis moins de 10 min.
    `user-activity.json` garde `presentSince` (début de la période de
    présence) et le dernier vrai geste.
  - **Arriéré** (`classifyWaits`) : seule une attente née après
    `activatedAt` (réglages ; datée à l'activation ou au premier balayage) ET
    après le dernier retour (`presentSince`), et pour une lacune seulement si
    elle a été présentée (`POST /api/auto-answer/presented`, envoyé par la page
    Models ; délai compté depuis la présentation), est traitée. Le reste :
    `backlog` de `GET /api/auto-answer`, « 📥 Arriéré » du menu.
  - **Notification** : quoi (`decisionWhat`), sur quel élément (lien,
    `decisionTarget`), pourquoi inactif (`inactivityText`).
  - **Écarter** : `POST /api/auto-answer/dismiss {ids | handled: true,
    confirm?}` ; traitée ou obsolète (`decisionPhase`, `targetOpen`) ⇒ hors de
    la vue, gardée (`history`) ; en attente ⇒ 409 sans `confirm`.
  - **Zone compacte** `#notif-dock` (`public/notif-dock.js`) : bandeaux des
    autorisations et des réponses automatiques, hauteur bornée, défilement
    interne, jamais par-dessus la page, repli mémorisé (`notif.collapsed`),
    « Tout réduire ». **Tout nouveau bandeau de demandes va dans `.nd-body`
    et publie `data-nd-count`.**
  - Garde-fous du menu : une ligne repliée « 🔒 5 garde-fous actifs »
    (affichage seul).
  - Recettes : `_test_auto_answer.mjs` §9, HTTP `auto-answer-presence`,
    navigateur `notif-dock` et `auto-answer-dismiss`.
- **Limite de pipeline** (0.126.0, décision « applique la recommandation »,
  synthèse KG décision 6) : la limite reste une pause (décision 14 des
  Pipelines tenue, le moteur ne la franchit jamais seul). En absence, Opus peut
  y répondre (`LIMIT_PAUSES` = limites de budget `items`, `review`,
  `duration`, `item_tests`, `items_blocked` ; `green` / `criteria` restent à la
  règle des choix intelligents, extension à décider par l'utilisateur) :
  **une fois par exécution**
  (`limitAnswered` sur le registre ; ensuite arriéré `limite-deja-repondue`),
  **tag git obligatoire** (sinon `submitted`), réponse suffixée « 🤖 auto »
  (`LIMIT_MARK`), seulement les options du menu de la cause **sans** effet
  `abandon` ni `model` (`limitOptions` ; menu vide ⇒ `limite-sans-choix`).
  Recette : `_test_auto_answer.mjs` §10.

## Pauses : la cause d'abord, des choix qui agissent dessus (0.122.0)

Demande utilisateur (2026-10-20) : « Une chose qui me gene c'est de porposer des
choix stupides. Si quelque chose a provoquer une erreur, proposer de continuer
ou de changer de modele ne resoudra pas l'erreur. Il faudrait un choix plus
intelligent ».

- Module `scripts/pause-diagnosis.mjs`. **Toute pause du moteur passe par
  `pauseWith`** (`pipeline-engine.mjs`) : `diagnosePause` (le code, dans
  l'ordre : critère refusé et motif, sortie des tests, diff, erreur du
  fournisseur, limite, fichier manquant), puis, seulement si la cause reste
  `unknown`, `diagnoseWithModel` (un choix court, model de la case
  `routage.classifier` via `chooseOption`). Lire des messages de machine
  (critères, tests, fournisseurs) n'est pas du routage par mots-clés.
- `smartMenu` dérive les choix de la cause ; `fixMenu` / `checkMenu`
  garantissent les règles : cause énoncée, « continuer » seulement si
  passagère (`TRANSIENT_KINDS`), « changer le model » seulement avec preuve
  (`d.proof` : model inconnu, test du model en échec, refus — une limite
  d'utilisation n'en est pas une),
  « abandonner » toujours, une recommandée et justifiée, chaque option dit ce
  qu'elle fera. `run.json.diagnosis`, `system/pipeline_diagnosis`.
- **Mots du menu** : `OPTION_KEYS` (registre unique ; `resume` | `abandon` |
  `test` | `model` | `accept` | `deleteDoubts`), reconnus par `dispatch.mjs`
  (`matchOptionKey`, réponse explicite) et passés au moteur (`pauseOption`) qui
  applique l'effet de l'option avant la reprise : `message` (consigne précise
  dans `resumeMessages`, `from: 'diagnostic'`), `relax` (`state.relaxed` :
  `citedPaths`, `itemTests`), `split` (`reste.md`, `state.splitOff`),
  `repair` (`npm`/`pip` seulement), `extend`. **Ajouter une cause** :
  `CAUSE_KINDS`, détecteur dans `diagnosePause`, cas dans `smartMenu`, mot dans
  `OPTION_KEYS`, cas dans `_test_smart_pause.mjs`.
- Réponse automatique : cause, choix et recommandation dans le prompt ;
  `normalizeAnswer` refuse une réponse hors du menu.
- **Le motif d'une limite de budget cite le travail** (0.139.1, item citant
  « Voix indisponible » pris pour une panne) : `BUDGET_LIMITS` (`items`,
  `duration`, `review`, `item_tests`) ne lisent une erreur du fournisseur que
  dans `providerError` passé à part (`providerText`) ; ailleurs, le texte entre
  « » est ignoré par ce détecteur. Recette : `_test_limit_pause_cause.mjs`.
- **La sortie des tests n'est jamais une panne** (0.141.1, Livrer refusé pour
  suite rouge pris pour une panne : « network error », « 509.2256ms ») :
  `providerText` ne lit jamais le motif d'un résultat de tests (« la suite
  échoue… », ou motif qui contient la sortie) et retire ailleurs les lignes de
  lanceur de tests ; seul `providerError` passé à part reste lu. Livrer refusé
  pour suite rouge ⇒ `code_delivery` « Tests rouges après livraison », que la
  livraison soit du programme ou du model : « confier au model », puis
  « changer d'approche » (anti-boucle, mention périmée et suite rouge = même
  cause). Recette : `_test_delivery_red_cause.mjs`.
- Rejeu des vraies pauses (lecture seule) : `node scripts/pause-replay.mjs
  --logs <dossier> [--md <fichier>]` (sortie hors dépôt : noms de projets).
- Recette : `_test_smart_pause.mjs` (vrais cas `tests/pause-cases.json`,
  vrai dispatch). Redémarrage inutile (moteur et dispatch), sauf pour le
  balayage de la réponse automatique du serveur.

## Pauses de processus tranchées par le chef (0.133.0)

Règle utilisateur (2026-10-22) : « arrête de poser des questions de découpage.
tu sais comment est organisé le process mieux que moi ».

- `scripts/process-pause.mjs`, appelé par `pauseWith` du moteur quand le
  levier `chefPauses` est allumé (`pipeline-tuning.mjs`, coupé par défaut,
  **figé dans `run.json.tuning`** ; coupé = comportement d'avant exact) :
  - **processus** (`PROCESS_LIMITS` × `PROCESS_KINDS` : items, items mis de
    côté, correctif périmé, limites de tests, d'étapes, de relecture, de durée,
    reprise) → **chef** : fin de tour `NEEDS_CHEF_INPUT:` sur UNE ligne
    (`[<run> · pause n] …`, cause, choix, recommandation, format « [ANSWER]
    <choix> — <raison> ») ; relais existant du serveur ; `[CHEF_ANSWER]`
    → `dispatch.mjs` (`CHEF_PAUSE`, `pendingChefPause`) reprend CETTE exécution
    même hors service, avec l'effet de l'option ;
  - **décision utilisateur** (autoriser, opération, doutes, base rouge, infra,
    lancement, model, classement, commit, cause non établie, Routage du chef,
    couloir ≥ 1) et **tout doute** → l'utilisateur, comme avant.
  - Le chef ne choisit que dans `CHEF_KEYS` (jamais abandonner, simplifier,
    accepter, tout supprimer, autoriser, réparer, tester / changer le model).
    Réponse hors des choix ou `NEEDS_USER_INPUT` ⇒ `handChefPauseToUser` (menu
    complet rendu à l'utilisateur).
- **Anti-boucle** : `run.json.pauseAnswers` (signature `pauseSignature`) ; une
  option déjà choisie `MAX_SAME_ANSWER` (2) fois sur la même pause n'est plus
  proposée ; items mis de côté ⇒ « livrer sans eux » recommandé avec la raison,
  une demande séparée par item suggérée.
- **Traces** : `system/pipeline_chef_pause`, `system/pipeline_chef_decision`
  (« ⚖ tranché par le chef : <option> — <raison> », frise `p.chefDecisions`
  de `turn-core.js`, `.jt-chef-decision`), notify `pipeline-chef-pause` ;
  `/api/pipeline-runs` : `pause.byChef`, aucun bouton (app Android comprise).
- La réponse automatique ne prend jamais une pause en attente du chef.
- Mise en service : `node scripts/pipeline-enforce.mjs tuning chefPauses on
  [<projet>]` (relu à chaque dispatch, pas de redémarrage ; `turn-core.js` :
  redémarrage pour le journal servi).
- Recette : `_test_chef_process_pauses.mjs` (rejeu des 4 pauses réelles).

## Relais des réponses du chef : chaque pause, rien d'autre (0.137.0)

Signalement (2026-10-22) : « psyProfile ne semble pas avancer » (2ᵉ et 3ᵉ
réponses du chef aux pauses d'une même exécution jamais appliquées, réponses
du chef à l'utilisateur relayées au musicien → Discussions parasites).

- **Relais** (`scripts/chef-relay.mjs`, `chefAnswerRelay`, appelé par
  `maybeRelayChefAnswer`) : un `result` du chef n'est relayé que si le
  `user_prompt` qui a OUVERT ce tour (même `orch_turn` ; sans lui, le dernier
  message non sourcé) porte `[NEEDS_CHEF_INPUT_FROM:…]` ; une fois par
  ouverture (`turn:<orch_turn>`). **Jamais la clé `session_id:num_turns`** :
  `num_turns` compte les tours d'UN appel `claude -p`, toutes les réponses
  courtes d'une même session avaient la même.
- Le texte relayé nomme ce qu'il tranche : `[RELAIS: pause <run> n° <n>]`
  (question qui commence par `[<run> · pause <n>]`) ou `[RELAIS: question]`.
  `dispatch.mjs` : `chefPauseTarget` (cette pause seulement, revérifiée après
  le verrou de tour) ; pause déjà tranchée ou remplacée ⇒
  `system/pipeline_chef_answer_stale`, sortie 0, aucun tour ; `question` ⇒
  jamais une réponse de pause (ni « oui » qui reprend). Sans ligne (ancien
  serveur) : règle 0.133.0.
- **Exécution citée** (`citedPausedRun`) : une réponse de menu qui cite une
  exécution en pause du projet lui répond, même si une exécution plus récente
  occupe la copie principale ; du chef (son tour, `--source chef`) à une pause
  qui l'attend, avec une de ses options (aussi par `--pipeline-resume`) =
  décision du chef. « accepter » / « tout supprimer » avec l'exécution nommée.
- **Réponse non appliquée sous 2 min** (`unappliedChefAnswers`, balayage du
  serveur, `ORCH_CHEF_ANSWER_WATCH_MS` / `ORCH_CHEF_ANSWER_GRACE_MS`) : ticket
  `decision` au chef (`unappliedText` : pause, réponse, commande
  `--pipeline-resume`), une fois par pause, et
  `system/pipeline_chef_answer_unapplied` dans le journal du musicien. Jamais
  à l'utilisateur.
- Redémarrage nécessaire (relais, balayage) ; `dispatch.mjs` est actif tout de
  suite. Recette : `_test_chef_pause_relay.mjs`.

## Alertes du chef (0.138.0)

Demande (2026-10-22) : « la non régression est en erreur. tu gères
automatiquement ? je ne te vois pas reprendre la main ».

- `scripts/chef-alerts.mjs`, balayage du serveur (`ORCH_CHEF_ALERTS_SWEEP_MS`,
  30 s) : un ticket `[ALERTE n=…]` de la file de direction (classe
  `decision`, entrée observée `alerte-chef`) pour (1) une non-régression KO,
  en erreur ou interrompue sans bilan d'un projet (`regressionDirsOf` : projet,
  id, suites KO, lanceur, relance ou tour en cours qui la traite) ; (2) une
  pause de PROCESSUS non transmise au chef (`pauseFamily`, ni `chefPause`
  pending, ni rappel au chef : ceux-là le réveillent déjà) ; (3) un musicien
  en cours sans progrès depuis `stallMin` (10 min) ou au PID mort alors qu'il
  est « en cours » (`scanProject`, chef et slots exclus).
- **Une fois par événement** (clé stable, `logs/chef-alerts.json`, survit au
  redémarrage ; journal `logs/chef-alerts.ndjson`) ; en attente pendant un tour
  du chef ou une file non vide, puis UN ticket pour tout ce qui attend ;
  blocage ou pause résolus entre-temps retirés ; 6 réveils par heure au plus.
- **Interrupteur** `chefAlerts` de `model-routing.json` : `node
  scripts/pipeline-enforce.mjs chef-alerts on|off [--stall-min N]`, relu à
  chaque balayage, coupé par défaut, `since` figé à l'activation, coupé = rien
  lu, rien écrit ; `off --all` le coupe. Redémarrage nécessaire (balayage).
- Recettes : `_test_chef_alerts.mjs`, HTTP `chef-alerts`.

## Items mis de côté : moins souvent, jamais perdus (0.139.0)

Constat du chef (2026-10-23, six exécutions du Développement complet d'un même
projet) et règle « arrête de poser des questions de découpage. tu sais comment
est organisé le process mieux que moi ». `scripts/aside-rework.mjs`, quatre
leviers de `pipeline-tuning.mjs` (coupés par défaut, **figés dans
`run.json.tuning`**, coupé = 0.138.0 exact) :

- `itemTestFix` : la correction après la Revue d'un item peut modifier les
  tests de CET item (changés depuis le dernier item livré, `ownTestFiles`) ;
  les autres restent protégés ; la Revue sait qu'un tel constat est corrigé
  tout de suite, jamais « à l'étape Livrer ».
- `testWrong` : 4b écrit `TEST_FAUX: <raison>` dans `vert.md` ⇒ retour à 4a
  (`state.testFix`, consigne `TEST_FAUX=`) pour corriger le test, deux fois au
  plus par item (`system/pipeline_test_wrong`). Marqueur de protocole, comme
  `DEJA_COUVERT`, jamais un mot-clé.
- `asideRedo` : correctif qui ne s'applique plus ⇒ item REFAIT depuis le code
  actuel (`uncheckGroup`, `redoHints`, correctif copié dans le dossier
  d'exécution comme indication), une fois par item (`state.redone`,
  `system/pipeline_item_redo`).
- `asideGroup` : les conflits restants sont tous constatés, puis UNE pause
  `aside_conflict` (`asideConflict` = liste, `asideGrouped`).
- Mise en service : `node scripts/pipeline-enforce.mjs tuning <levier> on
  [<projet>]` (relu à chaque dispatch, sans redémarrage). Recette :
  `_test_aside_rework.mjs` (série ; rejeu de p-20261022T221404-3a1835).

## Livraison par le programme : toutes les mentions de version (0.140.0)

Défaut vu en prod (2026-10-23, levier `codeDeliver`) : package.json en 1.9.0,
la ligne « Version » du README restée à 1.8.1, test d'exigence du projet rouge ;
la pause ne proposait que « corriger le code », qui relançait la même livraison.
Règle : « arrête de poser des questions de découpage. tu sais comment est
organisé le process mieux que moi ».

- `code-delivery.mjs` : `versionMentions` = ligne « Version » du README
  (convention) + `.orchestrateur/pipeline.json` → `versionMentions` (chemin, ou
  `{file, regex}` à UN groupe capturant) ; `syncVersionMentions` les écrit dans
  le commit de version ; une mention déclarée introuvable ⇒ Livrer échoue
  avant tout commit, fichier nommé (`staleVersion`). Suite rouge après la
  livraison : `staleVersionHints` nomme les lignes suivies qui affichent
  encore l'ancienne version à côté de « version ».
- Pause : causes `version_stale` / `code_delivery` (entrée `codeDelivery` du
  diagnostic, `rec.codeDelivery`), option « confier au model » (effet
  `modelDeliver` : Livrer par le model pour cette exécution, consigne précise,
  `pipeline_model_deliver`) ; jamais « corriger le code ». Pause de processus
  (chef).
- **Anti-boucle de Livrer** (tous leviers) : même étape de livraison, même
  cause, deux pauses de suite ⇒ l'option déjà répondue
  (`diagnosis.answered`) n'est plus proposée (`excludeAnswered`,
  `diagnosis.excluded`).
- Recette : `_test_version_mentions.mjs` (rejeu de p-20261023T044621-dc1385).

## Voie légère « Exploitation » (0.141.0)

Demande (2026-10-23) : « Je ferai passer ce genre de petites tâches
d'exploitation par une voie plus légère => fais ca » (déclarer un service puis
le redémarrer était parti en Développement complet, ~45 min ; tailscale serve et
un redémarrage refusés par Opérations).

- Pipeline **`exploitation`** (`scripts/exploitation.mjs`, catalogue, onglet
  « Exploitation » de la page Models, case `exploitation.executer`) : UN tour de
  model sans TDD, puis « Livrer » par le programme (`exploitation-livrer`).
  Check-list vérifiée par le code (`checkExploitation` du moteur) : sections
  `## État avant`, `## Action`, `## Vérification` (« - Preuve : `<commande ou
  URL>` — Constaté : … », commande lancée DANS le tour, URL vue dans le tour,
  jamais un code retour seul), `## Retour arrière`, `## Compte rendu`, et
  `## CHANGELOG` si des fichiers du dépôt ont changé. Fichiers changés ⇒
  version patch, entrée du CHANGELOG, mentions de version, un commit (hooks,
  jamais de push) ; sinon aucun commit.
- **Bascule en Développement** : `BASCULE_DEV: …` du model, fichier de code, de
  test, de script ou de type inconnu modifié (doc, config, versions, CHANGELOG
  ne comptent pas), ou suite rouge ⇒ modifications annulées (git), même demande
  relancée `--pipeline dev --queue-if-busy` (rappel et source gardés,
  `ORCH_BASCULE_RECORD` en test), `system/pipeline_exploitation_bascule`.
- **Garde-fous** (commandes du tour, `irreversibleCommands`) : `--force` refusé
  aussitôt ; push, suppression, publication, envoi sans les mots exacts de
  l'utilisateur (`## Autorisation`, citation vérifiée par `userSaid`) refusés
  aussitôt ; `AUTORISATION_REQUISE: …` ⇒ pause `autoriser` (utilisateur seul,
  jamais la réponse automatique), l'étape refaite avec l'autorisation.
- **Classement** par le sens (`EXPLOITATION_RULE`), préfixe `/exploitation`,
  `--pipeline exploitation`. Classée ainsi, la voie est en service sur tout
  projet en service sans figurer dans `enforcement.pipelines`
  (`pipelineServed`).
- **Interrupteur** `exploitation` (`pipeline-tuning.mjs`, coupé par défaut,
  figé dans `run.json.tuning`) : coupé = 0.140.0 exact (non proposée, préfixe
  ignoré, `--pipeline exploitation` refusé 64). Mise en service par le chef :
  `node scripts/pipeline-enforce.mjs tuning exploitation on [<projet>]`, relu à
  chaque dispatch, sans redémarrage.
- Recette : `_test_exploitation.mjs` (3 cas réels rejoués, bascules,
  garde-fous, interrupteur).

## Pipeline « Design » : regarder l'écran rendu (0.146.0)

Accord utilisateur (2026-10-24) : « ok » à la proposition du chef, après
« l'ui de [projet] est vraiment moche. quel model la fait » et « faut-il un
pipeline dédié ? » (le Développement vérifie que le code marche, personne ne
regarde jamais l'écran rendu).

- **Pipeline `design`** (`scripts/design.mjs`, catalogue, onglet « Design » de la
  page Models) : Capturer (programme) → Critiquer (case `design.critiquer`,
  vision) → tant qu'il reste un P1/P2 : Corriger (`design.corriger`) → Capturer
  → Critiquer → Second avis (`design.second-avis`, vision, autre famille) →
  Vérifier (programme) → Livrer. « Corriger » n'entre au plan que par la boucle.
- **Captures réelles** (mobile 390×844, bureau 1280×800, Edge/Chrome headless
  par `playwright-core`) dans le dossier d'artefacts de l'exécution (exclu de
  git), puis avant/après copiées dans `logs/runs/<run>/captures/`. Déclaration :
  `.orchestrateur/pipeline.json` → `design` : `capture` (commande du projet qui
  écrit ses PNG dans `{out}`), ou `start` (`command`, `url` avec `{port}`) +
  `screens` (`[{id, path, actions}]`, actions en liste fermée), `maxRounds`
  (3 à 5, défaut 4), `charte`, `viewports`, `schemes`, `timeoutSec` ; sans
  déclaration, l'`index.html` statique du projet. Les fichiers écrits par
  l'application pendant la capture sont remis. Capture impossible ⇒ pause
  `operation` qui dit quoi déclarer.
- **Le model voit les captures** : jointes en images au message de l'étape
  (enveloppe stdin de `dispatch.mjs` : blocs image pour Claude, `--image` pour
  codex), 20 au plus et 2000 px, mobile et bureau en alternance ; les autres à
  ouvrir avec Read, vérifié dans le journal de chaque essai de l'étape. Étape
  servie par codex (pas d'outil Read) : toutes les captures jointes (0.146.1).
- **Critères par le code** : chaque capture critiquée, gravité P1/P2/P3, critère
  d'arrêt du critique, `arret` cohérent ; la liste P1/P2 de la boucle est
  calculée par le code. Correction : affichage seulement, tests protégés et
  suite verte, charte du projet, toute ressource externe NOUVELLE déclarée dans
  « ## Ressources externes ». Les problèmes d'une critique sont la liste de
  travail du tour suivant (pas de `pipeline_defect` à chaque tour) ; à la borne,
  pause `review` (pause de processus).
- **Interrupteur** `design` (`pipeline-tuning.mjs`, coupé par défaut, figé dans
  `run.json.tuning`) : coupé = 0.145.0 exact (non proposé, préfixe `/design`
  ignoré, `--pipeline design` refusé 64). Allumé : en service sur tout projet
  en service (`pipelineServed`). Mise en service par le chef : `node
  scripts/pipeline-enforce.mjs tuning design on [<projet>]`, relu à chaque
  dispatch, sans redémarrage.
- Recette : `_test_design.mjs` (capture réelle headless, commande de capture
  d'un projet, cas rejoué, anti-boucle, second avis, garde-fous, interrupteur).

## Leviers « vitesse » du Développement complet (0.143.0)

Accord de l'utilisateur (2026-10-23) : « ok », sur la proposition du chef
mesurée sur 6 exécutions réelles d'un projet (304 appels, 319 min de model).
`scripts/pipeline-speed.mjs` ; six leviers de `pipeline-tuning.mjs`, **coupés
par défaut, figés dans `run.json.tuning`** (valeurs dans
`run.json.tuningValues`) ; coupé = 0.142.0 exact. Mise en service : `node
scripts/pipeline-enforce.mjs tuning <levier> on [<projet>]`, relu à chaque
dispatch, sans redémarrage.

- `limits` : limites réglables à chaud, `pipeline-enforce.mjs tuning-values
  [--items N] [--run-min N] [--review-batch N] [--red-green-max N] | --reset`
  (`enforcement.tuningValues` ; `off --all` les remet à zéro) ; levier allumé :
  25 tests, 150 min par défaut.
- `redGreen` : item ≤ 2 tests annoncés ⇒ UNE étape `rouge-vert` (case de 4b) ;
  le **programme** prouve le rouge (code de l'étape remis comme avant, la suite
  doit échouer en citant le test, sortie `logs/runs/<run>/<clé>.rouge.txt`),
  puis le vert. Refusée une fois ⇒ 4a puis 4b (`pipeline_redgreen_fallback`),
  jamais un défaut.
- `groupReview` : une relecture pour `reviewBatch` (3) items ; commit
  provisoire par item (`state.batch`), chaque constat nomme son item, un défaut
  ne reprend que son item (case rattachée insérée après les items commencés),
  le préfixe relu est livré (`deliverablePrefix`). Limite de relecture : l'item
  et ceux commités par-dessus dans le lot mis de côté ensemble (nommés).
  **Rien de non relu ne reste commité** : abandon, échec, `close-run.mjs` ⇒
  `unfoldBatch`. Une mise de côté d'un item seul part du dernier commit du lot.
- `reuseContext` : une exécution complète qui cite (identifiant, jamais des
  mots) l'exécution précédente de la même demande reprend `comprehension.md` et
  `plan.md`, sauf divergence du code depuis sa fin (`divergence` : autre chose
  que doc, versions, CHANGELOG, registre) ; raison dite dans les deux cas.
- `targetedTests` : 4a, 4b, 4c, 4ab ne lancent que les tests de l'item et ceux
  dont la clôture d'imports atteint, ou dont le texte nomme, un fichier modifié
  depuis la dernière livraison (tests d'exigence compris) ; un doute ⇒ suite
  complète, dit. Suite complète au départ et à Livrer. Commande :
  `targetedTestCommand` (`{files}`) de `.orchestrateur/pipeline.json`, sinon
  déduite d'un script `node … --test`. (L'index d'impact de la Mémoire ne couvre
  que l'orchestrateur et n'est jamais importé par le moteur : ce levier calcule
  la même règle sur les tests du projet.)
- `extraTests` : « N annoncés, N+1 écrits » accepté et noté si le test en plus
  est dans le même fichier.
- Banc : `node scripts/pipeline-speed-bench.mjs extract …` (lecture seule,
  cas anonymisés `tests/speed-bench-cases.json`) puis `replay` (vrai moteur,
  faux claude ; appels comptés, temps estimé depuis les temps mesurés). Hors
  non-régression.
- Recette : `_test_pipeline_speed.mjs` (série).

## Le rappel appartient à l'exécution (0.136.0)

Demande (2026-10-22) : « peut-on le mettre dans le code à la place ou en plus
de ta mémoire ? » (pauses d'une exécution lancée par le chef qui ne le
réveillaient plus après une reprise).

- `runCallback` (moteur) : le `callback` de `run.json` sert à **toute** reprise
  (`runPipeline`, `answerPausedRun`), quel qu'en soit l'auteur ; un
  `--callback` explicite prime et devient celui de l'exécution.
- `CHEF_RESUME_CALLBACK` (`dispatch.mjs`) : une reprise lancée depuis le tour du
  chef (`ORCH_TURN_PROJECT`), avec `--source chef` ou par `[CHEF_ANSWER]` porte
  le rappel au chef, même oublié ; une reprise du chef mise en file aussi.
- `awaitedWake` (`fleet-status-core.mjs`, pump du serveur) : une exécution en
  pause attendue par le chef le réveille, pause pour l'utilisateur comprise
  (« ⇄ exécution en pause — attend ta décision ») ; la question d'un tour
  ordinaire ne le réveille toujours pas. Redémarrage nécessaire pour ce point.
- Recettes : `_test_run_callback.mjs`, HTTP `pipeline-pause-wake`.

## Reprise d'une pause : plus aucune « réponse attendue » (0.134.0)

Signalement (2026-10-22) : « [projet] est toujours marqué avec "votre réponse
attendue" ».

- Moteur : à la reprise (toute réponse), `question` quitte `run.json`
  (historique `answeredQuestions`). `/api/pipeline-runs` : `question` et
  `pause` seulement pour une exécution en pause.
- **Une question n'attend plus dès qu'un tour du même musicien s'est ouvert
  après elle** (`TurnCore.questionOpen`, `QuestionRule` côté Android) : bulle du
  fil « ↻ reprise — plus de réponse attendue », sans bouton. Source du début de
  tour : flux en direct, `lastTurnStartAt` de `/api/config` et `/api/pupitre`.
  Redémarrage nécessaire (routes, `turn-core.js`).
- Recettes : `_test_resume_clears_question.mjs`, HTTP `resume-no-question`,
  navigateur `question-superseded`, JVM `QuestionRuleTest`.

## Cartes à jour en direct, pipelines et coupures du flux compris (0.135.0)

Signalement (2026-10-22, app 1.1.0) : « a l'instant je ne vois dans pilotage sur
l'application : 1 en cours » / « après avoir relancé l'application je vois bien
les 2 tâches en cours ».

- **Ouverture de tour** : partout la règle du serveur (`TurnCore.isTurnStart`,
  `stateAtTurnStart`). Une exécution de pipeline lancée ou reprise par le chef
  n'écrit ni `init` ni message assistant dans le journal du musicien : l'app
  Android (`Musician.ingest`, `LiveStateRule.stateAtTurnStart`) l'ouvre sur
  `pipeline_start`, comme le dashboard.
- **Rattrapage par le relevé** (`TurnCore.snapshotState`, miroir
  `data/LiveStateRule.kt`) appliqué à chaque `/api/pupitre` : départ vu par le
  serveur (`lastTurnStartAt` plus récent) ⇒ aussitôt ; autre écart (en cours,
  question, échec) ⇒ au 2ᵉ relevé consécutif ; non lu / prêt et en cours /
  réflexion jamais. L'app relit `/api/config` au retour au premier plan.
- Recettes : `_test_live_state.mjs`, navigateur `snapshot-live`, JVM
  `LiveStateRuleTest`. Redémarrage nécessaire pour `turn-core.js` servi.

## Graphe de connaissances, phase 0 b : l'index par le programme (0.124.0)

Décisions de l'utilisateur du 2026-10-20 (« tout comme recommandé ») :
`docs/KG-SYNTHESE.md` §6. Une phase qui s'en écarte demande une nouvelle
décision.

- **`scripts/kg.mjs`, seul écrivain**, seulement sous `logs/kg/` (hors git) :
  `derived.json` (couche dérivée, jetable), `build.json` (empreintes des
  sources, faits rejetés), `contradictions.md`. **Aucun model, aucune
  injection** dans un tour à cette phase : ni `dispatch.mjs`, ni `server.js`, ni
  le moteur n'importent ce module (vérifié).
- **Sources** : config.json, model-routing.json (`--state <racine>` pour lire
  celles de la prod, en lecture seule), mémoires et CLAUDE.md du chef (dossier
  `~/.claude/projects/<chemin>/memory`, `ORCH_KG_CLAUDE_HOME`), table des ports,
  sections « Décisions de l'utilisateur » des `docs/*-SYNTHESE.md`, registre
  des exigences, CHANGELOG, TODO, 50 commits, `logs/runs/*/run.json`
  (`--runs`), couverture des suites, ports à l'écoute (`netstat`). Jamais :
  `.env`, `secrets/`, `.token`, `logs/<p>.jsonl` (`forbiddenSource`).
- **Schéma fermé** (`NODE_TYPES`, `PREDICATES`) ; **provenance vérifiée**
  (`validateFact` : citation ≤ 200 caractères retrouvée, ligne recalculée,
  pointeur JSON, commit connu) ; secrets masqués avant écriture.
- **Affirmations reconnues dans la prose** : liste fermée `CLAIM_PATTERNS`
  (model par défaut, politique de routage, nombre de projets, Routage du chef,
  « tourne en Windows natif ») ; le texte barré et les « citations » ne
  comptent pas ; une ligne datée remplace une ligne non datée ou plus ancienne
  de la même source. Liens `[[…]]` des mémoires : `supersedes`
  (« supersede », « remplacé par », « caduc »), `exception_to`, `cites`.
- **Contradictions** : prédicats fonctionnels ; autorité `live` (état vivant)
  > `user` (décisions écrites) > `document` ; contredit par plus haut = « à
  revoir », même autorité et valeurs différentes = conflit (montré, jamais
  tranché) ; ligne de MEMORY.md d'une mémoire remplacée qui ne le dit pas ;
  port déclaré muet ou déclaration de plus de 60 jours. Un port tenu par un
  portproxy « écoute » même si le service derrière est mort.
- **Requêtes** (< 100 ms, `QUERY_BUDGET_MS`) : `node scripts/kg.mjs fiche <p> |
  regles [--projet p] | impact <fichier> | explique <id> | historique <case> |
  contradictions | perimes | port-libre [--from n]` (`--json`). `impact` refait
  les règles de `selectTargets` sur une couverture précalculée.
- **Interrupteur** : `node scripts/pipeline-enforce.mjs kg off|shadow|assist`
  (bloc `kg` de model-routing.json, relu à chaque appel ; `off --all` le
  coupe). Absent = off : construction et requêtes refusées (code 2, `--force`
  pour un essai), rien d'écrit. En 0 b, shadow et assist ne font que permettre
  construction et requêtes.
- **Corpus** `tests/kg-corpus/` (anonymisé ; exécutions dans
  `before/runs-fixture.json`, rangées par `fixture.mjs` dans une copie : un
  `run.json` versionné serait « couvert » par toute suite qui nomme ce fichier).
- Recettes : `_test_kg_core.mjs`, `_test_kg_replay.mjs`, `_test_kg_queries.mjs`
  (périmètre `kg`). Pas de redémarrage (aucune route).

## Graphe de connaissances, phase 1 : faits curés et onglet Mémoire (0.131.0)

Décision « vas y » (2026-10-22) ; `docs/KG-SYNTHESE.md` §4 phase 1, §6 décisions
8, 9, 15, état livré §7. Toujours **aucune injection** dans un tour.

- **Interrupteurs** (bloc `kg` de model-routing.json, relus à chaque appel,
  effectifs seulement si `kg.mode` ≠ off, coupés par défaut) : `kg.build`
  (reconstruction automatique), `kg.extract` (extraction par model et paires),
  `kg.ui` (onglet, bandeau, routes). `node scripts/pipeline-enforce.mjs kg
  <build|extract|ui> on|off` ; `kg off` et `off --all` retirent tout le bloc.
- **Couche des faits** `logs/kg/facts.jsonl` : ajout seul, `kg.mjs` seul
  écrivain, sous verrou (`withFactsLock`) ; ajouts, verrou et suppressions par
  `appendLines` / `withExclusiveLock` / `removeFile` d'`atomic-file.mjs`,
  **toujours sur un chemin `kgPath`** (logs/kg ou logs/kg/backup ; vérifié par
  `_test_kg_facts.mjs`). Décisions (`decide`) : idempotentes par `commandId`,
  révision attendue (409), posées sur l'index dérivé au chargement (`overlay`),
  jamais écrasées par une reconstruction. **Ne jamais éditer ce fichier à la
  main.** `review.jsonl` (entrées et sorties de la file), `backup/` (copie
  quotidienne, 30 jours), `extract.json` (sources lues, appels du jour, rejets).
- **Extraction** (`kg.mjs extract`, case `kg.extraire`, défaut
  `claude-sonnet-5-5`, Claude seulement) : identifiants fournis par le code
  (`candidateIds`), prédicats `MODEL_PREDICATES` (liens seulement), citation
  retrouvée (`checkProposal`), secrets masqués avant le model ; fait toujours
  `proposed` ; source inchangée jamais relue ; appel en échec = lot suspendu ;
  30 appels par jour (`DAILY_CALLS`). **Coupure automatique** (`CUTOFF`) : plus
  d'un faux parmi les 30 derniers faits de model jugés ⇒ `kg.extract` coupé
  d'office (`kg.cutoff.why`).
- **Paires suspectes** (`kg.mjs pairs`, case `kg.juger`, `suspectPairs`) : le
  code choisit, le model juge, l'utilisateur confirme puis « celle-ci vaut ».
- **`injectable(f)`** : seuls `observed` / `validated` non périmés peuvent être
  énoncés ; **un fait `proposed` ne l'est jamais** (règle à garder pour
  l'injection de la phase 2).
- **Serveur** : `GET /api/kg/status|review|rules|stats|source`, `POST
  /api/kg/decision` (`sameOriginOnly`). Le serveur **ne charge jamais
  `kg.mjs`** (`kgCli` le lance en sous-processus ; `_test_kg_core` /
  `_test_kg_facts` vérifient qu'aucun module des tours ni `server.js` ne
  l'importe). `kg.ui` coupé ⇒ 404 `disabled`. Balayage toutes les 5 min
  (`kg.mjs sweep`, `ORCH_KG_SWEEP_MS`). `ui.kgMemory` dans `uiFlags()`.
  Redémarrage nécessaire (routes, balayage).
- **Client** `public/kg-panel.js` + `kg-panel.css` : onglet « 🧠 Mémoire »
  (touche `k`), créé à chaud quand `ui.kgMemory` passe à vrai ; Revue (quatre
  questions, Valider / Corriger / Périmer / Rejeter, Ouvrir la source — fenêtre
  `#kg-source-overlay`, Échap en capture —, Corriger la source =
  `App.prepareChefMessage(…, {kg: true})`), Règles en vigueur, Statistiques ;
  bandeau `#kg-band` dans `.nd-body`. App Android 1.1.0 : écran Mémoire.
- Page Models : pipeline `kg` (cases `kg.extraire`, `kg.juger`), exclu du
  classement (`NOT_ROUTED` de `pipeline-classify.mjs`).
- Faux claude : `[KG_EXTRACT]` / `[KG_PAIR]`, `FAKE_CLAUDE_KG(_MAP|_FILE|_FAIL|_LOG)`.
- Recettes : `_test_kg_facts.mjs` (périmètre `kg`), HTTP `kg-review`,
  navigateur `kg-tab` et `kg-tab-mobile` (`tests/kg-fixture.mjs`).

## App Android 1.0.0 : parité avec le dashboard (0.127.0)

Demande utilisateur (2026-10-20) : « Fais une nouvelle application android
Orchestrateur, qui prend en compte toutes les fonctionalites ». Inventaire et
statut de chaque fonctionnalité : `docs/ANDROID-PARITY.md`.

- **Toute nouvelle fonctionnalité du dashboard** ajoute sa ligne dans
  `docs/ANDROID-PARITY.md` (écran `chemin#Symbole` + test `jvm:Classe#méthode`,
  ou `partiel` / `non applicable` et la raison), et toute nouvelle route `/api`
  est appelée par l'app ou listée dans « Routes sans écran ». Sinon
  `scripts/_test_android_parity.mjs` (statique, sans Gradle) échoue.
- Architecture : `data/Rest.kt` (accès JSON générique, lecteurs tolérants),
  `ui/common/Common.kt` (`LocalEnv` : api, préférences, voix, navigation,
  `prepareChef`, `openId`), `ui/more/Sections.kt` (une route par section),
  logique pure testée sur la JVM à côté de chaque écran
  (`./gradlew testDebugUnitTest`).
- Le flux en direct suit l'**activité** (`MainActivity`), plus l'écran du fil.
- `/api/pipeline-runs` porte `pause` (menu de la pause, `scripts/pipeline-run-view.mjs`) :
  l'app en fait des boutons qui répondent `{project, prompt: "<choix> <run>",
  pipelineResume}` (sans `pipelineResume` pour « accepter » / « tout
  supprimer », et pour le chef).
- Recettes : `_test_android_parity.mjs`, `_test_pipeline_run_view.mjs`, HTTP
  `pipeline-runs-pause`.

## Attachments

Images uploaded via the dashboard (paste / drag-drop / file picker) land in
`I:\orchestrateur\attachments\` as `att-<timestamp>-<random>.<ext>`.
The folder is gitignored. **No automatic cleanup is implemented (v1).**
Purge manually when it grows large, or wire a scheduled task in a future iteration.

Types and cap (0.108.0, « Acceptes les mkv et les fichiers jusqu'à 500Mo ») :
single source `public/attach-policy.js` (`AttachPolicy`, browser + server):
PNG/JPG/WEBP/GIF, MP4/WEBM/MOV/MKV (`.mkv` also by extension), 500 MB per
file; HTTP `requestTimeout` 1 h. Recettes : `_test_attach_policy.mjs`, HTTP
`attach-mkv-500` (500 MB accepted, +1 byte refused), navigateur `attach-mkv`.

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
