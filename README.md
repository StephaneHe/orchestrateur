# Claude Code Orchestrator (PHOSPHOR/03)

A local Windows dashboard: one interactive "conductor" Claude session pilots
N headless `claude -p` sub-agents, one per project, with a live web viewer
(Node.js + vanilla JS) and an Android companion app (`android/`).

## ⚠ Security

The dispatch API **runs commands on the host machine** (sub-agents get
`Read,Edit,Write,Bash…` in each project folder). Expose it only on
`127.0.0.1` or a private network you trust (e.g. Tailscale), never on the
public Internet.

- Access control is the 32-byte hex token in `./.token` (generated locally,
  never committed), sent as `?token=<hex>` or `X-Orchestrator-Token`.
  Check `TOKEN_GATE_ENABLED` in `server.js`: when `false`, anyone who can
  reach the port can dispatch commands.
- `logs/`, `attachments/`, `builds/`, `.token`, `.env`, `secrets/` and
  `config.json` stay out of git: they hold conversations, file contents and
  local paths.
- Billing rides the Claude Max/Pro OAuth session; `ANTHROPIC_API_KEY` is
  stripped from every child process.

## Setup

    npm install
    copy config.example.json config.json   # then list your own projects
    .\start.ps1                            # prints the tokenized URL

Android app: set the server URL and, if the token gate is on, paste the
token from `.token` in the app's configure screen.

Project rules and architecture: `CLAUDE.md`, `docs/project-brief.md`.
Changes: `CHANGELOG.md`.
