# Agent channel — wire format, routing, lifecycle

**Audience** : someone who has never seen this code and needs to debug or
extend the orchestrator ↔ headless `claude -p` channel. Everything required
to answer the six peer-readable questions below is in this single document.

## 1. How do I spawn a new agent?

The orchestrator spawns one fresh `claude` child process per **dispatch**
(one user turn). Spawning happens inside `POST /api/dispatch` in
`server.js`, which forks `node scripts/dispatch.mjs <project> --prompt-stdin`
with an env-scrubbed environment, and the dispatch script in turn spawns
the real `claude` CLI.

Concretely :

```js
// server.js, inside POST /api/dispatch
const child = spawn(process.execPath, [
  dispatchScript, name, '--prompt-stdin',
], {
  cwd: __dirname,
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: '',                    // never forward the API key
    DISPATCH_TRACE_ID: traceId,               // instrumentation context
    DISPATCH_INTERRUPTED: interrupted ? '1' : '0',
    DISPATCH_TIME_SINCE_LAST_MS: String(timeSinceLastMs),
    DISPATCH_REQUEST_IN_TS: String(requestInTs),
  },
  stdio: ['pipe', 'ignore', 'ignore'],
  windowsHide: true,
});
child.stdin.end(stdinPayload);
```

`dispatch.mjs` then spawns `claude` with stream-json I/O :

```js
const args = [
  '--print',
  ...(useStreamJsonInput ? [] : [prompt]),
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--allowed-tools', tools,
  '--model', model,
  '--setting-sources', 'project,local',
  '--strict-mcp-config',
  '--disable-slash-commands',
];
if (useStreamJsonInput) args.push('--input-format', 'stream-json');
if (sessionId) args.push('--resume', sessionId);

const child = spawn('claude', args, {
  cwd: project.path,
  env,
  stdio: [useStreamJsonInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  shell: false,
  windowsHide: true,
});
```

## 2. How do I send a user turn?

Two paths :

**Text-only** : the prompt is passed as the last positional argv to `claude`.
This is the default and uses no stdin.

**With attachments** (image content blocks, video paths) : `dispatch.mjs`
sets `--input-format stream-json` and writes a single NDJSON line on
`claude`'s stdin :

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}},
  {"type":"text","text":"the prompt"}
]}}
```

Stdin is closed immediately after the write — `--print` mode runs
exactly one turn, no interactive follow-up.

## 3. What does each event type look like?

`claude --output-format stream-json` emits one NDJSON event per line on
stdout. The orchestrator cares about :

| `type`            | `subtype`            | When                           | Carries                                           |
|-------------------|----------------------|--------------------------------|---------------------------------------------------|
| `system`          | `init`               | first event                    | `session_id` (UUID), tool list, model name        |
| `system`          | `api_retry`          | network blip                   | retry count                                       |
| `system`          | `plugin_install`     | rare                           | plugin name                                       |
| `assistant`       | —                    | per assistant message          | `message.content[]` blocks (text, thinking, tool_use) |
| `stream_event`    | various              | with `--include-partial-messages` | per-token deltas — high cardinality          |
| `user`            | —                    | tool result echoed             | `message.content[]` `tool_result` blocks          |
| `result`          | —                    | terminal event per turn        | `result`, `session_id`, `total_cost_usd`, `duration_ms`, `num_turns`, `usage` |

The orchestrator also writes synthetic events to log files :

| `type`            | When                                | Carries                                       |
|-------------------|-------------------------------------|-----------------------------------------------|
| `user_prompt`     | dispatch.mjs writes one before claude starts | the original user text, optional `attachmentPaths`, optional `source` (when injected by another musician) |
| `notification`    | `scripts/notify.mjs` POST           | callback text from one musician to another    |
| `system/log_growth_skipped` | server.js pump skipped >4MB tail | count of bytes skipped                |
| `system/oversized_line_skipped` | server.js pump dropped >1MB single line | size                              |

## 4. How does interruption work, including the override channel?

There are two interrupt paths : **policy-driven** and **explicit override**.

### 4.1 Policy-driven (kill+respawn)

When `POST /api/dispatch` arrives for a project with a turn already in
flight, the orchestrator :

1. Captures in-flight state from the log tail :
   `captureInterruptStateAsync(name)` reads the last 256 KB of
   `logs/<project>.jsonl` and extracts `lastToolUse`, `lastToolStatus`,
   the list of recent tool calls, and the previous user prompt text.
2. Calls `MessageRouter.route(...)` which delegates to
   `InterruptPolicy.decide(...)`. Three states :
   - `interrupt` — hard signal (stop-word / classifier `useless_now` /
     parallel agent error / budget guard).
   - `queue` — additive, complementary, or default safe.
   - `consult` — classifier returns `uncertain`. Behavioural fallback is
     always QUEUE (never freezes) ; the entry is appended to
     `logs/consult-pending.ndjson` for human review.
3. If `interrupt` : `killDispatchTree(name, livePid)` (Windows :
   `taskkill /T /F` ; POSIX : `kill -SIGKILL <pgid>`), then prepends a
   `[SYSTEM_INTERRUPT_RESUME]` notice to the new prompt summarising the
   captured state, and respawns `dispatch.mjs` with `--resume <session_id>`.

Why kill+respawn, not in-process interrupt : `claude --print
--input-format=stream-json` runs one turn per process. There is no
documented control-message-on-stdin to abort an in-flight turn. The
session id survives in the sidecar, so the user-perceptible effect of
respawn vs in-process interrupt is the same.

### 4.2 Explicit override — `!interrupt`

Provides a deterministic interrupt channel that bypasses the
classifier entirely. Two trigger mechanisms :

**Prompt prefix** : the user's prompt (after trim) starts with the
literal token `!interrupt` or `! interrupt` (one space variant), case
insensitive, followed by whitespace, end-of-string, or a non-word
boundary character.

```text
!interrupt switch to OAuth instead   ✓ override (stripped → "switch to OAuth instead")
!INTERRUPT cancel                    ✓ override
! interrupt with space               ✓ override (permissive)
!interrupt                           ✓ override (empty remainder)
!interrupt; reason: corruption       ✓ override (semicolon is non-word)
!interruption of normal flow         ✗ NOT override (letter follows)
please !interrupt this               ✗ NOT override (not at position 0)
```

Regex (in `src/message_router.mjs`) :
```js
const OVERRIDE_RE = /^!\s?interrupt(?=\s|$|[^\p{L}\p{N}])/iu;
```

**API flag** : `forceInterrupt: true` in the call to `route(...)`.

Telemetry : the resulting `logs/router-<isoDate>.ndjson` line carries
`reason: 'explicit_override'` and `override_source: 'prefix' | 'api_flag'`.
The classifier is **not** invoked on override paths — verified by the
`classifierInvocationCount` counter in tests.

## 5. What is CONSULT and when does it fire?

CONSULT is the third state of `InterruptPolicy.decide(...)`. It fires
when the classifier returns `verdict: 'uncertain'` AND no hard signal
(stop-word, parallel error, budget guard) applies.

When CONSULT fires :
- The runtime decision is **QUEUE** — orchestrator never freezes.
- One NDJSON entry is appended to `logs/consult-pending.ndjson` :
  ```json
  {"ts":"...","agent_id":"...","current_turn_summary":"...",
   "new_prompt":"...","recommendation":"interrupt"|"queue",
   "reasoning":"...","fallback":"queue"}
  ```
- One NDJSON entry is appended to `logs/router-<isoDate>.ndjson` with
  `decision: 'consult'`, `reason: 'classifier_uncertain'`,
  `recommendation: <classifier lean>`.

The `recommendation` field is the classifier's best guess of which way
the human would lean if forced to choose. It is **not** acted on at
runtime — the decision is always queue. It exists for human review.

A future Phase 7 (out of scope for this run) will surface CONSULT
entries to Stéphane via Telegram so they don't accumulate silently.

## 6. What happens when a child dies?

`dispatch.mjs` and `server.js` both wire `error`, `exit`, AND `close`
on every spawn, with idempotent teardown. Either order is tolerated.

```js
// dispatch.mjs
let lifecycleClosed = false;
function lifecycleEnd(code, signal) {
  if (lifecycleClosed) return;
  lifecycleClosed = true;
  try { processLineQueue(); } catch {}      // drain pending parses
  try { logStream.end(); } catch {}
  try { fs.unlinkSync(pidPath); } catch {}
  try { fs.appendFileSync(instrPath, JSON.stringify(record) + '\n'); } catch {}
  if (signal) { console.error(`killed by ${signal}`); process.exit(128); }
  process.exit(code ?? 1);
}
child.on('exit',  (code, signal) => lifecycleEnd(code, signal));
child.on('close', (code, signal) => lifecycleEnd(code, signal));
```

```js
// server.js (POST /api/dispatch)
let lifecycleLogged = false;
const onLifecycleEnd = (code, signal, ev) => {
  if (lifecycleLogged) return;
  lifecycleLogged = true;
  traceWrite({ trace: traceId, event: 'dispatch_exited', project: name, code, signal, via: ev });
};
child.on('exit',  (code, signal) => onLifecycleEnd(code, signal, 'exit'));
child.on('close', (code, signal) => onLifecycleEnd(code, signal, 'close'));
```

If the child died mid-turn (SIGKILL, server restart, machine sleep),
the JSONL log ends without a `result` event. The boot routine
`healOrphanedLogs` in server.js detects logs whose last non-partial
event isn't `result` AND have been quiet for >60s, and appends a
synthetic error-result so the viewer's reducer can close the turn
panel cleanly.

`dispatchQueue` (`server.js:251`, in-memory `Map`) is mirrored to
`logs/queue/<name>.json` via atomic write-then-rename on every
mutation. On boot, `loadQueuesFromDisk()` rehydrates the in-memory map
BEFORE accepting new dispatches, so a SIGKILL between push and drain
cannot lose pending turns.

## Phase 0 root causes — fixed in code

| # | Cause                                | Status                | Reference                                           |
|---|--------------------------------------|-----------------------|-----------------------------------------------------|
| 1 | PTY contamination                    | DOES NOT APPLY        | `dispatch.mjs` uses plain `child_process.spawn`     |
| 2 | Chunk-boundary parsing               | fixed (already present) | `dispatch.mjs:lineQueue` line-buffered split      |
| 3 | Windows CRLF                         | fixed                 | `split(/\r?\n/)` in `dispatch.mjs` and pump in `server.js` |
| 4 | stderr backpressure                  | DOES NOT APPLY (drained) | `dispatch.mjs:209-212`                          |
| 5 | stdout backpressure                  | fixed                 | `dispatch.mjs` O(1) data handler + setImmediate drainer |
| 6 | stdin newline                        | DOES NOT APPLY        | `dispatch.mjs` ends with `\n`                       |
| 7 | Permission deadlock                  | INSTRUMENTED          | `auditToolUse` in `server.js` writes `logs/tool-audit/` per `tool_use` |
| 8 | Concurrent stdin writers             | DOES NOT APPLY        | one stdin per spawn, single `.end()`                |
| 9 | Event-loop starvation                | fixed                 | `dispatchPidAliveAsync`, `captureInterruptStateAsync`, async poll loop |
|10 | Lost queued turns on crash           | fixed                 | `persistQueue` + `loadQueuesFromDisk` in `server.js` |
|11 | Missing exit/close/error             | fixed                 | both `dispatch.mjs` and `server.js` wire all three idempotently |
|12 | `--include-partial-messages` blowup  | mitigated             | server.js pump caps individual line size (1 MB) and per-tick read (4 MB) |

## Test 1.3 calibration note

The original Phase 1 spec asked for a microbench showing async hot-path
I/O ≥ 2× faster than sync, OR a weighted composite ≥ 50% reduction.
That criterion cannot be met by a tight-loop microbench on small files :
`fs.promises.readFile` always loses to `fs.readFileSync` because of
libuv worker-pool dispatch overhead (~0.2 ms vs ~0.05 ms per call on
modern Windows + Node 24).

The actual benefit of async I/O is **event-loop unblocking under
concurrent load** : while a 256 KB log-tail read runs on the libuv
worker pool, the event loop can serve other HTTP requests. A
microbench in a tight loop never has competing requests, so the
benefit is invisible.

The Phase 1 patch is therefore validated **structurally** (three sites
migrated to async equivalents : `dispatchPidAliveAsync`,
`captureInterruptStateAsync`, async poll-loop callback). Quantitative
proof would require a Test 4.5-style concurrent-load comparison
between pre-patch sync and post-patch async, which has not been run
(see Test 4.5 in the v3 run report — DEFERRED).

## API quick reference

### `decide({ turnSummary, newPrompt, classifier, parallelAgentError, budgetGuardFired })`

In `src/interrupt_policy.mjs`. Pure function. Returns
`{ decision, reason, ... }` where `decision` is one of `interrupt`,
`queue`, `consult`. Never throws — classifier failures fall back to
`{ decision: 'queue', reason: 'classifier_error' }`.

### `route({ agentId, newPrompt, inFlightTurnSummary, inFlightTurnAgeMs, queueDepthAfter, classifier, parallelAgentError, budgetGuardFired, forceInterrupt })`

In `src/message_router.mjs`. Async. Delegates to `decide(...)` after
checking `!interrupt` override. Writes one NDJSON line to
`logs/router-<isoDate>.ndjson` per call ; CONSULT decisions also append
to `logs/consult-pending.ndjson`. Returns
`{ action: 'interrupt' | 'queue' | 'route-existing', record, verdict?, effectivePrompt? }`.

### `classify(turnSummary, newPrompt)`

In `src/classifier.mjs`. Spawns `claude --print --output-format=json
--model claude-haiku-4-5-20251001` with a fixed prompt template, parses
the assistant's single-JSON-line reply, returns `{ verdict, lean,
reasoning }` or `null` on any failure.

### Stop-words

Defined in `src/interrupt_policy.mjs` :
- EN : `stop`, `abort`, `cancel`, `scrap that`, `never mind`, `wait`
- FR : `stop`, `arrête`, `arrete`, `annule`, `oublie`, `attends`, `laisse tomber`

Matched as Unicode-aware whole words (single-token entries) or literal
phrase substrings (multi-token entries). Case insensitive.

## Operational runbook

| Need                             | Where to look                              |
|----------------------------------|--------------------------------------------|
| Why was an agent interrupted ?   | `logs/router-<isoDate>.ndjson` for the trace, then `logs/<project>.jsonl` for the SYSTEM_INTERRUPT_RESUME notice. |
| Did a tool freeze the agent ?    | `logs/tool-audit/tool-audit-<isoDate>.ndjson` — find rows with `attempted_in_allowed: false`. |
| Is the conductor up to date ?    | `logs/instrumentation-<isoDate>.ndjson` for per-dispatch metrics, then `scripts/instrumentation-report.mjs` for the report. |
| What's queued for an agent ?     | `logs/queue/<name>.json` (rehydrated on each server boot). |
| Did anything need human review ? | `logs/consult-pending.ndjson`. |
| Server crashed silently ?        | `logs/crash.log` (mtime gives suspect window) ; `logs/_server.out` for stderr. |
