# Orchestre — Android companion app

Native Kotlin + Jetpack Compose client for the Orchestre dashboard.

## What it does (V1)

- **Login** with biometric unlock. First run asks for server URL and
  32-byte hex token (one-time); stored in `EncryptedSharedPreferences`
  on top of the Android KeyStore.
- **Fleet view** — hand-of-playing-cards fan, 5 cards per hand, stacked
  in 2–3 levels. Rank-0 (most active) on top. Swipe horizontally (either
  direction) to rotate the deck.
- **Focused sheet** — tap a card to open a bottom sheet with the
  musician's latest assistant text.
- **Composer** — talks to the conductor (project `orchestrateur`) by
  default. The conductor delegates to other musicians.

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

## Deferred (V2)

- @mention picker in composer
- Multi-musician direct messaging
- Full event stream with markdown rendering in focused view
- Push notifications on `input` state transitions
- Attachments (paste/image)
