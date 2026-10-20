# Orchestre — Android companion app

Native Kotlin + Jetpack Compose client for the Orchestre dashboard.

## What it does (1.0.0)

Parity with the web dashboard: every feature, its screen and its JVM test are
listed in `docs/ANDROID-PARITY.md` (checked by `scripts/_test_android_parity.mjs`).

- **Login** with biometric unlock; server URL and optional token.
- **Chef thread** — composer with every pipeline of the engine, direction
  queue, notification dock (permissions, automatic decisions), attention band,
  questions and pipeline pause choices, speech, clickable identifiers, HTML
  replies rendered safely.
- **Musician detail** — activity journal, live events, last result, queue
  (detail, edit, order, remove), raw log, direct send, sessions.
- **« Plus »** — Projets, Exécutions de pipeline, Non-régressions, TODO, Git,
  Release, Requêtes, Models, Réponse automatique, Autorisations permanentes,
  Réglages, Nouveau musicien, /downloads and /pupitre.

Code: `data/Rest.kt` (generic JSON access), `ui/common/Common.kt` (`LocalEnv`),
`ui/more/Sections.kt` (one route per section); pure logic next to each screen,
tested with `./gradlew testDebugUnitTest`.

## Networking

Reuses the existing server endpoints:
- `GET /api/config` — project list
- `GET /api/sse/fleet?token=<hex>` — aggregate stream-json over SSE
- `POST /api/dispatch` — one-turn dispatch to a project
- Token is sent as `X-Orchestrator-Token` header on every request.

## Build

Java 17 required. From `android/`:

```bash
# First time: generate the gradle wrapper jar
gradle wrapper

# Debug build
./gradlew assembleDebug
# APK at app/build/outputs/apk/debug/app-debug.apk
```

## Install on the phone

Tailscale device: `<phone-tailscale-ip>:<adb-port>` (see local notes).

```bash
adb connect <phone-tailscale-ip>:<adb-port>
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Deferred

- Android notifications when the app is closed (permission requests, questions)
