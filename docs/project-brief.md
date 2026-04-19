# Claude Code Orchestrator — Project Brief

> Hand-off document for a fresh Claude Code session. Read this end-to-end
> before touching any code.

---

## One-liner

A local web dashboard, running on Windows, that orchestrates a fleet of
Claude Code agents. One central interactive session pilots N headless
sub-agents, one per personal coding project. Live view of all activity,
questions from sub-agents surface to the user, all via the user's Claude
subscription (not API billing).

---

## Why this exists

I have multiple personal coding projects, each with its own repository and
its own Docker-based runtime (projects run in Linux containers inside Docker
Desktop on Windows). Today I open one Claude Code session per project, which
means constant context switching, no cross-project awareness, and no way to
ask "what's the state of all my projects right now?".

The orchestrator is a single place where I can:

- Ask a central Claude to get status across all projects.
- Dispatch work to a specific project by name.
- See sub-agents work in real time in side panels.
- Get notified when a sub-agent needs input and relay my answer back.

---

## Non-goals

- Not a CI/CD system. Not meant to run autonomously overnight.
- Not a team tool. Single user, localhost only, personal projects only.
- Not a replacement for opening Claude Code directly when I want deep focus
  on one project.
- Not meant to run on macOS/Linux. Windows-first (WSL is out of scope per
  user constraint — Claude Code runs natively in PowerShell).

---

## Architecture overview

```
┌────────────────────────────────────────────────────────────────┐
│  Browser (localhost viewer)                                    │
│  ┌────────────────────────────┬──────────────────────────────┐ │
│  │ CENTRAL TERMINAL           │ PROJECT PANELS (read-only)   │ │
│  │ xterm.js attached to a     │ one panel per sub-agent,     │ │
│  │ live claude session        │ tailing stream-json logs     │ │
│  └────────────────────────────┴──────────────────────────────┘ │
└─────────▲──────────────────────────────▲───────────────────────┘
          │ WebSocket (bi-directional)    │ SSE (one per log file)
          │                               │
┌─────────┴───────────────────────────────┴───────────────────────┐
│  Node.js server (localhost only)                                │
│  - node-pty: spawns central `claude` via ConPTY, bridges bytes  │
│  - chokidar: watches logs/*.jsonl, pushes new lines via SSE     │
│  - express + ws: single process, single port                    │
└─────────────────────────────────────────────────────────────────┘
          │
          │ The central claude, running inside the pty, uses its
          │ Bash tool to invoke sub-agents:
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  claude -p "<prompt>" --cwd <project_dir>                       │
│          --resume <session_id>                                  │
│          --output-format stream-json                            │
│          --include-partial-messages                             │
│          --allowedTools "Read,Edit,Write,Bash"                  │
│     >> logs/<project>.jsonl  2>&1                               │
│                                                                 │
│  One invocation = one "turn" of work on that project.           │
│  Session context is preserved across invocations via --resume.  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key architectural decisions (and why)

### 1. Node.js, not Python

The core libraries (node-pty, xterm.js, chokidar) are all Microsoft / JS
ecosystem. Using them from Python via pywinpty works but adds impedance
mismatch. Single-language stack = less plumbing.

### 2. Headless sub-agents (`claude -p`), not interactive

Interactive multi-terminal orchestration on Windows without tmux is painful.
`claude -p` with `--resume` gives session persistence, structured output
via stream-json, and is scriptable from the central Claude's Bash tool.
The tradeoff: sub-agents can't pause mid-task to ask questions; they
complete a turn and return. Questions from a sub-agent surface at the end
of its turn and are relayed by the central.

### 3. Single Node.js process, single port

No microservices. No separate ttyd for the terminal + Flask for the viewer.
One Node.js process handles: HTTP static, WebSocket for the pty, SSE for
the log files. Reduces ports, simplifies auth, simplifies startup.

### 4. Subscription auth, not API key

`ANTHROPIC_API_KEY` must NOT be set in the environment that spawns child
`claude` processes. Without it, Claude Code falls back to OAuth
(~/.claude/ credentials) and bills against the Claude Max/Pro plan, not
per-token API usage.

**Critical bug to guard against**: there is a known issue where child
`claude` processes detect ANTHROPIC_API_KEY in their inherited env and
bill to the API even when the parent uses subscription auth. The
orchestrator must explicitly unset it in the child env before spawn.

### 5. stream-json with partial messages

Sub-agents are launched with `--output-format stream-json
--include-partial-messages`. This gives token-level streaming into the
JSONL log file, so the viewer shows text appearing live, not just in
bursts at end of turn.

### 6. Stable log filenames, append mode

Each project has a stable log filename (e.g., `logs/bookhaven.jsonl`).
Every sub-agent invocation appends to it. The viewer tails the file;
historical context is preserved; rotation is a separate, manual concern.

---

## Components to build

In order of priority:

1. **Orchestrator core** (`server.js`): Node.js process, express +
   express-ws, node-pty for the central, chokidar for log watching,
   SSE endpoints, static file serving.
2. **Viewer front-end** (`public/index.html` + assets): xterm.js for the
   central terminal, custom CSS for panels, minimal JS (no framework).
3. **Config**: `config.json` or equivalent listing projects (name, path,
   initial prompt/instructions).
4. **Startup script** (`start.ps1`): sets safe env (unsets
   ANTHROPIC_API_KEY), launches Node server, opens browser.
5. **Styling pass**: cyberpunk/Matrix aesthetic. Design brief handled
   separately.

---

## Security & constraints

- **Logs contain sensitive content.** stream-json can include file
  content, tokens in strings, config values. The `logs/` directory must
  be in `.gitignore` and excluded from cloud-sync folders (OneDrive,
  Dropbox).
- **No ANTHROPIC_API_KEY in spawn env.** Explicitly unset in the child
  process environment when launching sub-agents. See decision #4.
- **No shell interpolation of user input.** When the central Claude
  dispatches work to a sub-agent, project names and paths must be
  validated against the config allowlist before being interpolated into
  command strings.
- **Safe permission defaults.** Sub-agents launched with
  `--allowedTools "Read,Edit,Write,Bash"` — enough for dev work but not
  blanket `--dangerously-skip-permissions`. If a sub-agent needs a
  broader tool set, that is a deliberate config choice per project.

---

## Suggested file layout

```
orchestrator/
├── server.js              # Node.js server: HTTP + WS + SSE + pty
├── config.json            # list of projects, paths, optional per-project
│                          # prompts / tool allowlists
├── package.json
├── package-lock.json
├── public/
│   ├── index.html         # the viewer
│   ├── app.js             # xterm.js wiring, SSE handlers, panel rendering
│   ├── styles.css         # cyberpunk theme, panel states, event types
│   └── fonts/             # self-hosted monospace + display fonts
├── logs/                  # gitignored, runtime-generated stream-json files
│   ├── central.log        # PowerShell transcript of the central session
│   ├── <project>.jsonl    # one file per project, appended
├── start.ps1              # bootstrap: unset API key, start server, open browser
├── .gitignore
├── .claude/
│   ├── settings.json
│   └── commands/          # custom slash commands for orchestrator workflows
├── CLAUDE.md              # project brief for future Claude Code sessions
└── docs/
    └── project-brief.md   # this file
```

---

## Event types in stream-json (per-panel rendering)

Each line of a `<project>.jsonl` is a JSON event. The viewer renders each
type differently:

| Event type    | Visual treatment                                            |
| ------------- | ----------------------------------------------------------- |
| `text`        | Default prose. Primary foreground color. Markdown-rendered. |
| `thinking`    | Dimmed, italic, collapsible group. Low visual weight.       |
| `tool_use`    | Inline badge (tool name as glyph) + truncated args preview. |
| `tool_result` | Monospace block, collapsed if > N lines, expandable.        |
| `error`       | Red, sticky, always visible until acknowledged.             |

Panels themselves have five states: `idle`, `live`, `needs_user_input`,
`done`, `error`. See the design brief for visual specs.

---

## Protocol: how sub-agents ask questions

Each sub-agent is instructed (via its initial prompt, injected by the
central Claude) with this rule:

> If you need clarification from the user and cannot proceed, end your
> response with a line of the exact form:
> `NEEDS_USER_INPUT: <your question>`
> and stop.

The viewer detects this marker in the stream and transitions the panel
to `needs_user_input`. The user answers the question in the central
terminal. The central Claude is expected to recognize "answer for
<project>" and call:

```
claude -p "<user's answer>" --resume <session_id> --cwd <project_path> ...
```

The sub-agent resumes with the answer in context.

---

## Anti-patterns to avoid

- **Don't** try to make sub-agents interactive. `claude -p` is
  intentionally one-shot per call; faking interactivity via pty-per-project
  would force abandoning the headless model and lose the structured log.
- **Don't** pipe stream-json through `tail`/`head` or truncate it — the
  viewer needs every event to render state correctly.
- **Don't** use `--dangerously-skip-permissions` globally. Per-project
  escalation only, documented in config.
- **Don't** introduce a framework (React, Vue, etc.) for the viewer.
  Vanilla JS + xterm.js is enough and keeps the surface small.
- **Don't** store the token gate secret in code or log it anywhere.

---

## Open questions / future work

- **Telegram integration** (deferred): alerts on
  `NEEDS_USER_INPUT`/`ERROR`, possibly bidirectional (answer from phone).
  The user already has a working Telegram bot infrastructure from a
  separate flight-monitor project — reuse that token/chat_id/webhook
  pattern rather than building new.
- **Per-project pty sub-agent** (deferred): currently sub-agents are
  headless. A future mode could give any sub-agent its own interactive
  pty for cases where back-and-forth is needed, at the cost of losing
  structured logging for that session.
- **Log rotation** (deferred): `<project>.jsonl` grows unbounded. Manual
  rotation for now; consider automatic when files exceed N MB.
- **Multi-machine** (probably never): single-user, single-machine by
  design. Remote access for the user themselves (from phone, etc.) is
  better served by Claude Code's native Remote Control feature if ever
  needed.

---

## References — what led to this design

- Claude Code headless mode docs (`claude -p`, `--resume`,
  `--output-format stream-json`, `--include-partial-messages`,
  `--allowedTools`, `--bare`).
- Known subscription auth bug: child `claude` processes can bill to API
  if ANTHROPIC_API_KEY is in env (GitHub issue
  anthropics/claude-code#39903).
- Claude Agent SDK was rejected: requires API key, does not honor
  subscription billing (GitHub issue
  anthropics/claude-agent-sdk-python#559).
- Native subagents were rejected: they share the parent's context and
  can't target separate project directories.
- Agent Teams was rejected: designed for parallel domains of a single
  codebase, not for piloting independent projects.
- Cowork was rejected: designed for non-coding knowledge work,
  Projects are flat/independent (no orchestration between them),
  sandbox VM may conflict with Docker Desktop.
