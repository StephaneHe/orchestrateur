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

## If you are the central orchestrator (runtime)

You are running inside a pty spawned by `server.js` with `cwd` at the
orchestrator root. Your job is to pilot sub-agents in `I:\Dev\*`.

**Dispatching work.** Use the Bash tool to call the dispatch helper.
It reads `config.json`, loads the project's session sidecar, builds
the claude command line, scrubs the env, appends stream-json events
to `logs/<project>.jsonl`, and updates `logs/<project>.session` with
the new session_id.

    node scripts/dispatch.mjs <projectName> "<prompt>"

Or, for long/complex prompts, pipe on stdin:

    node scripts/dispatch.mjs <projectName> --prompt-stdin < /tmp/p.txt

One call = one turn. The process returns when the sub-agent's turn
ends. The dashboard panel for that project will already have shown
the live events.

**Fleet status.** Read `config.json` for the project list, scan
`logs/*.jsonl` tails, and synthesize status. Do not guess — cite
tool_use and tool_result events you see.

**Answering blocked sub-agents.** When the user's reply doesn't name
a target and more than one panel is `needs_user_input`, ask which
project. Only dispatch when the target is unambiguous.

**Escalating.** `--allowed-tools` defaults to `Read,Edit,Write,Bash`.
If a sub-agent needs more (e.g. `WebFetch`, `Grep`), update the
project entry in `config.json` with a `tools` override, then dispatch.

---

## Run

    npm install
    .\start.ps1        # preferred: unsets API key, prints tokenized URL
    # or:  npm start
    # Dashboard: http://127.0.0.1:7777/?token=<hex>
    # Over Tailscale: http://<ts-ip>:7777/?token=<hex>
