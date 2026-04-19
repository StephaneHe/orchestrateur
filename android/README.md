# PHOSPHOR/03 — Android cockpit

Mobile companion app to the orchestrator running on your PC.
Same palette, same fonts, same server API. Built with Kotlin +
Jetpack Compose. Connects over Tailscale.

## Features (v0.1)

- **Biometric login** — fingerprint / face / device credential via
  `androidx.biometric`. Token is stored in
  `EncryptedSharedPreferences` (AES-256 master key in the Android
  Keystore).
- **Fleet list** — one row per project with live state chip
  (idle / live / needs-input / done / error) driven by SSE from the
  orchestrator's `/sse/logs/<project>` endpoint.
- **Session picker** — bottom sheet listing every `~/.claude/projects/
  <encoded-cwd>/<uuid>.jsonl` session for a project, with preview +
  git branch + relative age. Tap to attach, DETACH to release.
- **Add / remove project** — `+` FAB → picker of `I:\Dev` directories
  not yet in the fleet; swipe/tap REMOVE on any panel to drop it.
- **Multi-device safe** — tokens are device-local, cleartext only on
  loopback (`127.0.0.1`, `10.0.2.2`) and Tailscale CGNAT
  (`100.64.0.0/10`). Anything else goes over HTTPS only (config in
  `res/xml/network_security_config.xml`).

## Build

This directory ships everything **except** the Gradle wrapper JAR
(binary, deliberately not committed). Two paths:

### If you have Android Studio installed

```
File → Open → I:\orchestrateur\android
```

Studio will generate `gradle/wrapper/gradle-wrapper.jar` and
`local.properties` automatically, then sync. Hit Run.

### Headless / PowerShell

```powershell
# 1. Point Gradle at your Android SDK
echo "sdk.dir=C:\Users\$env:USERNAME\AppData\Local\Android\Sdk" > local.properties

# 2. Generate the wrapper (one-time)
gradle wrapper --gradle-version=8.9 --distribution-type=bin

# 3. Assemble
.\gradlew.bat assembleDebug

# 4. Install onto a connected device
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

If you don't have `gradle` on PATH, install it with Scoop
(`scoop install gradle`) or Chocolatey (`choco install gradle`),
run step 2 once, then the wrapper takes over for every subsequent
build.

## First launch

1. On the PC, note the Tailscale URL printed by `.\start.ps1` — it
   looks like `http://100.x.y.z:7777/?token=<64-hex>`.
2. In the app:
   - Host: `100.x.y.z:7777` (no scheme; the app prepends `http://`).
   - Token: paste the 64-hex.
   - Hit **CONNECT**.
3. The app stores the credentials encrypted on device. On relaunch
   the **UNLOCK WITH BIOMETRIC** button is offered; tap it to skip
   the manual form entirely.

## Architecture

```
auth/   BiometricAuth · TokenStore (EncryptedSharedPreferences)
data/   OrchestratorApi (OkHttp + cookie jar)
        SseClient       (okhttp-sse)
        PanelReducer    (stream-json → PanelSnapshot state machine)
        Models          (kotlinx.serialization data classes)
state/  AppViewModel    (single StateFlow + side effects)
ui/     theme/ · screens/LoginScreen · FleetScreen · SessionPickerSheet
                                       · AddProjectSheet
```

The stream-json reducer mirrors `public/app.js` exactly — `system`
init → LIVE + turnCount++, `assistant` → update activity verb/note,
`result` → DONE / INPUT (NEEDS_USER_INPUT: regex) / ERROR. Partial
stream deltas (`stream_event`) are ignored; the complete `assistant`
event carries the canonical content.

## Deviations from the desktop UI

Built without access to the mobile handoff zip from claude.ai. The
layout is a mobile adaptation of PHOSPHOR/03 desktop:

- Single scroll (no side-by-side terminal + fleet).
- Central xterm.js terminal is **not** shown on v0.1 — rendering
  ANSI in Compose is non-trivial and the mobile use case is
  fleet-monitoring, not piloting.
- Bottom sheets replace the desktop modals.

Drop the mobile handoff zip into `docs/` and the styling can be
rebased onto it while keeping `data/`, `auth/`, `state/` untouched.

## What's *not* in v0.1

- No central terminal stream (could be added with a `Terminal`
  composable that paints raw xterm bytes — skipped as out of scope).
- No push notifications on NEEDS_USER_INPUT. Out of band requires
  a separate channel (e.g. FCM or the deferred Telegram bot).
- No dispatch from mobile — the app is a viewer + configurator,
  not a place to type prompts for sub-agents. The central Claude
  on the PC remains the driver.
- No partial-message rendering (`stream_event`); complete events
  only, same as the desktop viewer ships today.
