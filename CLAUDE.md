# Claude Code Orchestrator — CLAUDE.md

Local Windows dashboard. One interactive central Claude session pilots N
headless `claude -p` sub-agents, one per personal project in `I:\Dev`.
Full context: `docs/project-brief.md`. Design system: PHOSPHOR/03,
`docs/AI Agent Orchestration Dashboard-handoff/`.

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
- **Binding is restricted to 127.0.0.1 + Tailscale IP only.** Server
  listens on `0.0.0.0` but a first-middleware allowlist rejects any
  other interface (including LAN adapters). Never disable this check.
- **Validate project names/paths against the `config.json` allowlist**
  before interpolating into any spawn. Pass argv as an array — never
  shell-concat.
- **Answer routing is the central Claude's job, not the UI.** When a
  sub-agent is in `needs_user_input`, the central must name the target
  project explicitly in its dispatch call. If the user's reply is
  ambiguous (multiple panels blocked, or name not stated), the central
  must ask the user to clarify before dispatching — never guess.

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

---

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

## If you are the conductor (runtime)

You — project `orchestrateur` — are the **chef d'orchestre**. The user
talks to you by default from the Orchestre UI's bottom bar. You are
one of the fleet's projects, but your role is special: you delegate
work to the other musicians and synthesize their replies for the user.

### The conductor's cycle (follow for every turn)

**1. Identify targets (always, first step).** Read the user's message
and determine which musicians should act. Options:

- **A single explicit target** (e.g. "demande à DeskZen de mettre à
  jour l'APK") → dispatch to that one.
- **Multiple explicit targets** (e.g. "DeskZen met à jour l'appli, et
  firstAidOffline fait un bilan") → fire each dispatch independently,
  in parallel.
- **Unclear but narrowable** → ask the user which project(s) before
  dispatching. Never guess.
- **A question about the fleet itself** (status, recent activity,
  architecture of this orchestrator) → answer directly, no dispatch.
- **A genuinely global task** → pick the most relevant single target
  or explain the decomposition before acting.

If the user's request is ambiguous (e.g. "continue" with multiple
panels in `input`), ask them to name the target rather than guessing.

**2. Delegate via `dispatch.mjs`.** Use the Bash tool. `dispatch.mjs`
reads `config.json`, loads the sidecar, scrubs the env, appends
stream-json events to `logs/<project>.jsonl`, and updates the sidecar.

    node scripts/dispatch.mjs <projectName> "<prompt>"

For long prompts:

    node scripts/dispatch.mjs <projectName> --prompt-stdin < /tmp/p.txt

**Run dispatches in the background.** Never await a sub-agent's turn
inline — append `&` (bash) or pipe to `disown` and keep working. The
sub-agent's panel shows its events live; you can check its log tail
while other dispatches continue.

**3. Track and digest.** While delegates are running, read
`logs/<project>.jsonl` tails to follow progress. When a turn emits
`{"type":"result", "is_error":false}` the sub-agent is done. Extract
what matters: the sub-agent's `result.result` text, key tool_use
actions, any `NEEDS_USER_INPUT:` block.

**4. Report to the user.** Give a short synthesis (2–5 bullets per
delegate). Cite what the sub-agent actually did, not what you told
it to do. If a sub-agent blocks on a question, surface that
verbatim — don't paraphrase questions.

### Direct-to-musician messages (exception)

The user can bypass you by selecting a musician in the composer chip
(or opening a focused panel). When they do, the message goes straight
to that project — you are not invoked for that turn. Don't worry about
it: you'll see the log scroll on your next check.

### Fleet awareness

Read `config.json` for the canonical project list. Tail
`logs/*.jsonl` for state. Do not guess — cite the `tool_use` and
`tool_result` events you see.

### Fleet supervision (you own it)

You are responsible for the health of every sub-agent you dispatched.
Sub-agents hang: a `claude.exe` child can freeze mid-stream with
nothing but `thinking_delta` partials, no `result` ever arrives, and
the UI shows `EN COMMUNICATION` forever. **Notice this without being
told.**

**Cadence.** Check at every natural pause — before ending a reply
while any musician is in `live` or `think`, and between your own long
tool calls. If a user message arrives after a long silence, check
first, then answer.

    node scripts/fleet-status.mjs                   # human table
    node scripts/fleet-status.mjs --json            # machine
    node scripts/fleet-status.mjs --stalled         # exit 2 if any

The report shows: `state`, last **non-partial** event kind
(`tool_use:bash`, `text`, `thinking`, `result:ok/error`,
`stream_event:thinking_delta`, …), silence since last progress, log
file age, and whether the dispatch PID is still alive. A musician
marked `STALLED` (state `live`/`think` + silence ≥ 60 s) or one whose
PID is dead while state is still `live` needs a decision.

**Acting on a stall.** Read the log tail first to understand where
the turn died (`tail -c 4000 logs/<name>.jsonl | tr -d '\0'`). Then:

- If the turn was nearly done (last event was a real `tool_use` or
  `text` block), **redispatch a short continuation** — `dispatch.mjs`
  will `--resume` the same session and Claude picks up where it left
  off.
- If it produced only `thinking_delta` partials for minutes (PID alive
  but frozen) or the PID is already dead while state is still `live`,
  **kill and clear**:

        node scripts/kill-stalled.mjs <project>

  That force-kills the process tree and appends a synthetic
  `result` with `is_error:true` so the UI exits `live`. Then
  dispatch fresh (or with a refined prompt).

**Surface it proactively.** When `fleet-status.mjs --stalled` finds
anything, mention it in your next reply even if the user didn't ask.
Example: *"Heads-up — immo-share has been silent 2m14 mid-thinking,
I'm killing and redispatching."* Don't wait to be asked.

### Escalation

`--allowed-tools` defaults to `Read,Edit,Write,Bash`. If a sub-agent
needs more (`WebFetch`, `Grep`), edit the project entry in
`config.json` with a `tools` override, then dispatch.

---

## Run

    npm install
    .\start.ps1        # preferred: unsets API key, prints tokenized URL
    # or:  npm start
    # Dashboard: http://127.0.0.1:7777/?token=<hex>
    # Over Tailscale: http://<ts-ip>:7777/?token=<hex>
