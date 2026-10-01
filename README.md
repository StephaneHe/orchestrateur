# Claude Code Orchestrator (PHOSPHOR/03)

A local Windows dashboard: one interactive "conductor" Claude session pilots
N headless `claude -p` sub-agents, one per project, with a live web viewer
(Node.js + vanilla JS) and an Android companion app (`android/`).

## ⚠ Security

**As shipped, the dashboard has no authentication and lets anyone who
reaches it run commands on the host machine.** The dispatch API starts
sub-agents with `Read,Edit,Write,Bash…` in each project folder, and the
server listens on `0.0.0.0:7777`. Run it only on a network you fully trust
(localhost, home LAN, a private Tailscale tailnet). **Never expose it to
the Internet**: no port forwarding, no public tunnel, no public Wi-Fi.

- `TOKEN_GATE_ENABLED = false` in `server.js` is a deliberate choice for a
  trusted private network. To require a token, set it to `true`. The
  server then checks the 32-byte hex token in `./.token` (generated
  locally, never committed), sent as `?token=<hex>` or
  `X-Orchestrator-Token`.
- `logs/`, `attachments/`, `builds/`, `.token`, `.env`, `secrets/` and
  `config.json` stay out of git: they hold conversations, file contents and
  local paths.
- Billing rides the Claude Max/Pro OAuth session; `ANTHROPIC_API_KEY` is
  stripped from every child process.

## Setup

    npm install
    copy config.example.json config.json   # then list your own projects
    .\start.ps1                            # prints the tokenized URL

Android app: set the server URL and, only if the token gate is on, paste the
token from `.token` in the app's configure screen.

Project rules and architecture: `CLAUDE.md`, `docs/project-brief.md`.
Changes: `CHANGELOG.md`.

## License

MIT — see `LICENSE`.
