# Parallel tasks for the same musician — design

Status: **lot 1 implemented in 0.101.0** (2026-10-15); **P9 (pipeline engine in a lane) in 0.115.0** (2026-10-18, §12) — see §7 for what is
in, what is not, and the decisions taken by default; Q2/Q3 applied in 0.101.1
(§8); Q4 (version/CHANGELOG rule) and Q5 (pilot = orchestrateur-dev) applied
in 0.102.0 (§9); Q1 (default `maxParallel` = 2, user decision) applied in
0.103.0 (§10). An explicit `maxParallel: 1` keeps a project serial.
Requested by the user (verbatim):

> « Il faut que ce soit assez fin (d'ou la question sur git) pour que les
> taches d'un meme musicien puissent s'activer en parallele. Sauf pour
> certains cas particuliers sont detectes, ils doivent alors etre justifies et
> documentes. Les taches de plusieurs musiciens en parallele, c'etait deja
> possible. »

**Requirement rule.** This request becomes a permanent non-regression test
(`scripts/_test_parallel_lanes.mjs`, plus HTTP `lanes-*` and browser `lanes-*`
routes) and a line in `docs/USER_REQUIREMENTS.md`. The line is added by item
**P1** together with the first real test: `_test_user_requirements.mjs`
rejects a registry line whose test does not exist yet, so the line cannot
land before its test.

---

## 0. Where we are today

| Mechanism | Granularity today | Source |
|---|---|---|
| Turn lock | one per musician, `logs/<p>.turnlock` (exclusive create) | `dispatch.mjs` §« verrou de tour (0.67.0) » |
| Working copy | the musician's single checkout (`config.json` `path`) | `config.json` |
| Session | `logs/<p>.session`, one `session_id` | `dispatch.mjs`, `server.js` `sessions` Map |
| PID / liveness | `logs/<p>.pid`, `dispatchPidAlive(name)` | `server.js` |
| Log | `logs/<p>.jsonl`, append-only; lines tagged `orch_turn` (0.67.0) | `dispatch.mjs`, `turn-core.js` |
| Queue | `logs/queue/<p>.json`, drained when the musician is free | `server.js` `drainQueue` |
| Routage pending | `after: {projet, offset, key}` — offset in `logs/<p>.jsonl` | `routage-pending.mjs` |
| Version / CHANGELOG | written by the turn (or the pipeline's Livrer step) in the checkout | project rules, `item-delivery.mjs` |

So the parallelism added by the Routage (0.58.0 detached tasks, 0.69.0
per-task classification, 0.100.0 request map) only plays **between
musicians**: two tasks for the same musician serialise on the turn lock.

Two existing mechanisms are the building blocks of this design:

- **Mode double (0.44.0, `dual-run.mjs`)** already runs two turns of the same
  musician at once, each in a `git worktree` with its own branch
  (`dual/<run>/<role>`), its own log, session and `.pid` under
  `logs/dual/<run>/`, then archives, merges and cleans up, with crash
  recovery (`recoverInterrupted`). It proves the isolation works with the
  claude CLI, the hooks and the pipeline engine.
- **The chef pool (`conductorPool`, `server.js`)** already runs N turns of one
  role through *slots*: slot 1 keeps the legacy file names, slot N gets
  `<name>-N` files. Same idea here, called **lanes**.

---

## 1. Git isolation per task

### 1.1 Choice: one persistent worktree per lane, one branch per task

- A **lane** is an execution slot of a musician: a working directory, a turn
  lock, a log, a session file, a `.pid`. Lane `0` is the musician's own
  checkout (legacy files, unchanged). Lanes `1..N-1` are **git worktrees**.
- A **task** runs in one lane, on its own branch
  `lane/<lane>/<task-id>` created from the tip of the **integration branch**
  (the branch checked out in the musician's main checkout, e.g. `master`,
  `dev`).
- Lane directories are **persistent** and reused task after task, located at
  `<orchestrator root>/lanes/<project>/<lane>` (on `I:`, gitignored with
  `logs/`; never inside the project, so the project's `git status` stays
  clean). Rejected alternatives:
  - *A fresh worktree per task*: a new path every time breaks three things
    that are keyed by the **directory path**: workspace trust
    (`~/.claude.json`, 0.30.0 — without it `permissions.allow` is ignored),
    the claude CLI session store (`~/.claude/projects/<cwd-slug>/` — a
    `--resume` from another cwd does not find the session), and warm caches
    (`node_modules`, Gradle `build/`). Persistent lanes are trusted once.
  - *A full clone per lane*: duplicates objects, needs fetch/push between
    clones, and the main checkout would not see lane branches. Worktrees
    share one object store and one ref namespace.
  - *No isolation, file-level locking*: the model edits arbitrary files and
    runs the test suite on the whole tree; two turns in one tree see each
    other's half-written state. Rejected.

### 1.2 Lifecycle

1. **Lane creation** (first time the lane is needed, `lanes.mjs ensureLane`):
   `git worktree add --detach <laneDir> <integration tip>`; then
   `workspace-trust.mjs` trust for `laneDir`; then **provisioning** (§1.3).
   Recorded in `lanes/<project>/lanes.json` (lane, path, createdAt, base).
2. **Task start** (under the lane lock): verify the lane tree is clean (else
   archive it as `logs/lanes/<p>/<lane>/<ts>.orphan.diff` and reset); `git
   checkout -B lane/<lane>/<task> <integration tip>`; record
   `{task, branch, base, startedAt}` in `logs/lanes/<p>/<lane>.task.json`.
3. **Turn(s)**: `claude -p` / codex / pipeline engine with `cwd = laneDir`.
   The task may need several turns (question answered, `[CHEF_ANSWER]`,
   pipeline pause + « continuer »): they all go to **the same lane** (task
   affinity, §2.2) and resume the same session.
4. **End of task** = the turn produces a final `result` that is not a
   question/pause. The engine commits whatever is left (`commitWork`
   semantics, `.claude/` and run artefacts excluded) on the task branch.
   Nothing changed ⇒ the branch is deleted, no integration.
5. **Integration** (§1.4) into the integration branch.
6. **Cleanup**: the lane is reset to `--detach` on the new integration tip
   and returned to the pool. The task branch of a **finished** task
   (integrated, or nothing to integrate) is **kept one week, then deleted**
   (user decision Q2, §6): no tag, no archive. Failed, paused or abandoned
   integrations keep the branch (never deleted automatically) and write
   `logs/lanes/<p>/<task>.diff`. Retention rule:
   - at the end of a finished task, `{branch, task, title, outcome, tip,
     finishedAt, deleteAfter}` is recorded in
     `logs/lanes/<p>/retained-branches.json` (`retainBranch`);
   - `pruneRetainedBranches` deletes (`git branch -D`, in the main checkout) a
     recorded branch only when `now − finishedAt ≥ 7 days`
     (`BRANCH_RETENTION_MS`) **and** its tip is still the recorded one; a
     branch whose tip moved since (someone kept working on it) is kept and
     flagged `moved`; a branch already gone is dropped from the registry;
   - it runs at each lane task start (`dispatch.mjs`, event
     `system/lane_branches_pruned` in the musician's log), from the server's
     hourly sweep (`sweepLaneBranches`, for a musician that gets no new lane
     task), and by hand: `node scripts/lanes.mjs prune <p> [--dry-run]`;
     `lanes.mjs status` and `GET /api/lanes/:project` list
     `retainedBranches` with their `deleteAfter`;
   - `ORCH_LANE_BRANCH_RETENTION_MS` overrides the week **for tests only**.
   - Test: `_test_parallel_lanes.mjs` §1 (branches kept with `deleteAfter` =
     end + 7 days, no tag) and §9 (nothing deleted one minute before the
     week; deleted one minute after; moved branch kept; paused branch never
     deleted; end-to-end pruning at a lane task start, traced; CLI).
7. **Crash recovery** (server start, and before each lane acquisition), same
   pattern as `recoverInterrupted`: a lane whose lock owner is dead and whose
   task never ended is frozen (commit on its branch), its diff archived, the
   task's turn closed in the log (`system/lane_interrupted` +
   `result/error_lane_interrupted`), and the lane reset. `git worktree prune`
   cleans worktrees removed by hand.
8. **Lane removal** (`maxParallel` lowered, project removed):
   `git worktree remove --force`, `forgetWorkspace(laneDir)`, `lanes.json`
   updated. Never while a lane holds a task.

### 1.3 Provisioning a worktree

A worktree contains only **tracked** files. Everything ignored or untracked
in the main checkout is missing: `node_modules/`, `.env`, `CLAUDE.local.md`,
untracked `.claude/settings.json` (excluded via `.git/info/exclude` at
onboarding, 0.56.0), `local.properties` (Android SDK path), generated files.

- Declared per project in `.orchestrateur/pipeline.json` (versioned):
  `"lanes": {"link": ["node_modules"], "copy": [".env", "CLAUDE.local.md",
  ".claude/settings.json", "local.properties"], "setup": ["npm ci"]}`.
  `link` = directory junction (`mklink /J` via argv, no shell); `copy` =
  file copy refreshed at every task start; `setup` = commands run once per
  lane creation and again when the lockfile changes.
- Defaults when nothing is declared: copy `CLAUDE.local.md`,
  `.claude/settings.json(.local)`, `.env*` if present; nothing linked.
- A task whose branch changes dependency manifests (`package.json`,
  `package-lock.json`, `build.gradle*`, `requirements*.txt`…) must not write
  into a **linked** `node_modules` shared with the main checkout: rule
  `deps-shared` (§3) unlinks and runs `setup` in that lane only.
- Secrets copied into a lane stay on `I:` under the orchestrator's gitignored
  `lanes/`; the lane tree is excluded from any sync like `logs/`.

### 1.4 Integration and merge conflicts

Integration is **serialised per project** by `logs/<p>.integrate.lock`
(exclusive create, owner PID, takeover when dead — same code as the turn
lock). Order = order of task completion (FIFO).

1. In the lane: `git merge --no-edit <integration branch>` (bring the latest
   integrated work into the task branch). Merge rather than rebase: one
   conflict resolution per task instead of one per commit, which is what a
   model resolves reliably; history stays readable in the ⎇ Git panel.
   **Merge, never squash** (user decision Q3, §6): every commit of the task
   reaches the integration branch's history (checked by
   `_test_parallel_lanes.mjs` §1: each task tip is an ancestor of the
   integration branch).
2. **Conflict** ⇒ an **integration turn** in the same lane, same session,
   prompt `[INTÉGRATION]` listing the conflicted files and the other task(s)
   that touched them (titles from the Routage, commit subjects). The model
   resolves, runs the tests, commits. At most `LIMITS.integrationRounds` (2).
   Still conflicting, or tests red ⇒ **pause** (`NEEDS_USER_INPUT`, state
   `input` on the lane) with the usual plain-language menu: « réessayer »,
   « mettre de côté » (patch kept, branch kept, lane freed), « abandonner ».
   Never auto-resolved by `-X ours/theirs`.
3. **Checks on the merged tree, in the lane**: the project's test command
   (`pipeline.json`), plus for this repository the delivery gate (targeted
   regression on exactly that tree).
4. **Version and CHANGELOG** (§2.8) applied by the integrator, committed in
   the lane.
5. **Fast-forward**: `git merge --ff-only lane/<lane>/<task>` in the **main
   checkout**. If the integration branch moved meanwhile (a direct dialogue
   in lane 0 committed), go back to step 1 (bounded). If the main checkout
   has uncommitted changes on files touched by the task (ff refuses), the
   integration pauses with a `lane-integration-dirty` reason; it never
   stashes or overwrites the user's work.
6. Events in the musician's log: `system/lane_integrate_start`,
   `lane_conflict {files, others}`, `lane_integrated {commit, version}`,
   `lane_integration_paused {reason}`.

**Early warning.** When a task commits, the integrator compares its changed
files with those of every other running lane (`git diff --name-only
<base>...HEAD` in each lane). An overlap writes `system/lane_overlap` and
shows a ⚠ on both lanes; it does not stop anything (the files may merge
cleanly).

**Never pushed.** Integration is local, like every commit today.

---

## 2. What becomes per task (per lane) instead of per musician

Naming: lane 0 keeps today's files; lane `k ≥ 1` uses
`logs/lanes/<project>/<k>.<ext>`. Musician name stays the unit of the
allowlist, routing and UI; the lane is a sub-identifier `<project>#<k>`
(never a new `config.json` project — unlike chef slots, lanes are not
addressable by name from outside).

### 2.1 Turn lock
`logs/<p>.turnlock` becomes **one lock per lane**. `dispatch.mjs` acquires
the first free lane up to `maxParallel` (§4), after the exclusivity decision
(§3). If no lane is free: today's behaviour (wait, or `--queue-if-busy`).
A new **project-exclusive lock** `logs/<p>.exclusive` is taken by a task
whose exclusivity rule fires: it waits until all lanes are idle and blocks
new lanes while held. `maxParallel = 1` ⇒ strictly today's behaviour (the
regression test proves it).

### 2.2 Session and task affinity
- `logs/lanes/<p>/<k>.session` per lane; the claude session store is keyed by
  the lane path, so a session only resumes in its own lane.
- `logs/lanes/<p>/<k>.task.json` records the task held by the lane.
- 0.99.0 calibration (`sessionDecision`) is unchanged in spirit: a **new
  task** = new session in whichever lane; the **same task** (answer to its
  question, `[CHEF_ANSWER]`, `--meme-tache`, pipeline « continuer ») must go
  to the lane holding that task — lookup by task id, never by "the
  musician's session". A same-task request whose lane was recycled restarts
  in a new session with the regenerated `taskBrief`.
- Direct user dialogue (no `--source`) stays in **lane 0**, the user's own
  checkout, as today.

### 2.3 Log
- One log per lane (`logs/lanes/<p>/<k>.jsonl`), append-only, never
  truncated. Reason: every reducer (`deriveState`, `scanProjectState`,
  `reduceMusician`, `isTurnStart`) reads a log as one sequential stream of
  turns; interleaving two turns is exactly the 0.67.0 incident.
- `logs/<p>.jsonl` stays the log of lane 0 and receives one-line **lane
  markers** (`system/lane_task {lane, task, title, state}`) so that existing
  readers (journal, Android app) see that work happens elsewhere.
- The activity journal (`/api/project/:name/journal`) merges lanes by
  timestamp, each turn tagged with its lane.

### 2.4 State / dashboard panel
- Per lane: the usual state vocabulary `idle | live | input | done | error`.
- Musician aggregate (card, rail, Projets, `/api/pupitre`, fleet-status,
  Android): priority `input > error > live > unread > idle`, plus additive
  fields `lanes: [{lane, state, task, title, since, branch, exclusive?}]`
  and `parallel {running, max}`. Additive only: old clients keep working.
- Panel: one tab per active lane (thread, journal, raw log), lane chip
  `#k « titre »` on each card line; the « À examiner » band lists lanes, and
  « ✓ Vu » / « ✓ Marquer comme répondue » act on one lane
  (`POST /api/ack/:project?lane=k`, `/api/question/:project/resolve?lane=k`).
- **Answer routing (hard rule extended):** when several lanes of a musician
  are in `input`, the chef must name project **and** lane/task in its
  dispatch; an ambiguous reply is clarified with the user, never guessed.

### 2.5 Queue
- Still **one queue per musician** (`logs/queue/<p>.json`): order of the
  queue = order of **start**. The drain launches the head as soon as a lane
  is free and no exclusivity rule blocks it; an entry blocked by
  exclusivity does not block the entries behind it only if they are
  independent (no `apres`) — otherwise strict FIFO. Same-task entries carry
  their lane and wait for it.
- `queueHeld` (0.82.0) and the 30 s sweep reason per lane:
  `dispatchPidAlive(name, lane)`.
- Queue entries gain `lane?` (affinity) and `exclusive?` (precomputed
  reason, shown in the queue overlay).

### 2.6 Callbacks, wake, Routage pending, request map
- `notify.mjs` gets `--lane k` (injected in the callback instruction by
  `dispatch.mjs`); the pump's `musician_done` / `musician_question`
  notifications carry `{lane, task}`.
- `routage-pending.json` `after` gains `lane`: the offset is an offset in the
  **lane log** the awaited task runs in. `releaseReady` looks there.
- `request-map.mjs findTurn` searches the lane logs of the musician
  (fingerprint of the full text, as today).
- NEEDS_CHEF_INPUT relay dedupe key becomes `(musician#lane, question head)`;
  the `[CHEF_ANSWER]` goes back to that lane.

### 2.7 Pipeline runs
- Already per run (`logs/runs/<run>/`). The run records `lane` and
  `branch`; its cwd is the lane; artefacts in `<lane>/.orchestrateur/runs/`
  (excluded through the shared `.git/info/exclude`).
- Item delivery (0.64.0) commits on the **task branch**. The final
  **Livrer** step no longer bumps the version: it writes a changelog
  fragment (§2.8); the version commit is done by the integrator.
- Mode double inside a lane: its worktrees branch off the task branch
  (`git worktree add` works from any worktree of the repo); paths stay under
  `logs/dual/wt/`.
- `--pipeline-resume` resumes in the run's lane (affinity).

### 2.8 Version bump and CHANGELOG
Two parallel tasks would both write `0.101.0` and both edit the top of
`CHANGELOG.md`: a certain conflict, and two different features under one
number. So:

- **A task in a lane never edits the version fields nor `CHANGELOG.md`.** It
  writes a fragment `changelog.d/<task-id>.md` with front matter
  `bump: patch|minor|major` and Keep-a-Changelog sections. Fragments never
  conflict (one file per task).
- **The integrator assigns the version at integration time**, under the
  integration lock: next version = current version of the integration
  branch + the fragment's bump; it rewrites `package.json` /
  `build.gradle.kts` (`versionName`, `versionCode + 1`), turns the fragment
  into the `## [X.Y.Z] - date` entry, deletes the fragment, commits
  `chore(release): vX.Y.Z (<task title>)`. One task = one release, versions
  strictly increasing in integration order, the same rule as today.
- Detection: a task branch that changed a version field or `CHANGELOG.md`
  directly is caught by the integrator (diff vs merge base); the change is
  converted into a fragment when it is a plain top entry, otherwise the
  integration pauses (`lane-version-edited`).
- The musician prompt gets a `laneRule()` (like `todoRule()`), only in lanes
  `≥ 1`. In lane 0 (direct dialogue, exclusive tasks) the project's usual
  rule applies unchanged.
- `release-notes.mjs` (0.97.0) lists pending fragments under « ⏳ En cours ».
- The delivery gate of this repository accepts the integrator's release
  commit when the report covers exactly the merged tree.

**Validated by the user (Q4, 2026-10-15): « Question 4 : ok, je valide tout ».**
Delivered in 0.102.0 (`enforceChangelogRule`, `applyFragments`,
`runReleaseCheck` of `scripts/lanes.mjs`; test `_test_lane_changelog_rule.mjs`):

- The rule is applied on the task's own changes **before** the integration
  branch is merged into the task branch, so a direct edit never conflicts
  with releases integrated meanwhile.
- Conversion of a direct edit: version fields put back to the integration
  value (other edits of `package.json` / gradle kept), the added CHANGELOG
  text moved to `changelog.d/<task>-converted.md`; the bump is deduced from
  the version the task wrote (else from its entry heading, else patch). Only
  a *plain addition* converts: one new `## [X.Y.Z]` entry above every
  released entry, or lines added under `## [Unreleased]`. Anything else
  (older entry edited, lines removed, two entries) ⇒ pause
  `lane-version-edited`, nothing integrated. Event `system/lane_version_rule`.
- Fragment checks: no front matter / no `bump:` ⇒ patch, flagged
  `bumpDefaulted`; a `bump:` other than patch/minor/major ⇒ pause
  `lane-fragment-invalid` (never guessed).
- A task with changes and no fragment gets a generated patch fragment
  (« entry generated by the integrator »): each task stays one release.
- `lanes.releaseCheck` (argv, placeholders `{base}`, `{version}`; timeout
  `lanes.releaseCheckTimeoutMin`, 45 min by default) runs in the lane on the
  staged release tree; red ⇒ pause `release-check`, output in
  `logs/lanes/<p>/<task>.release-check.log`.
- The release commit runs the project's git hooks (never `--no-verify`); a
  refusal (e.g. this repository's delivery gate without a green report on
  that tree) ⇒ pause `release-commit`, main checkout untouched. The other
  lane commits (leftovers, wip, conversion) are not delivery commits and keep
  `--no-verify`.
- Still to do: `release-notes.mjs` listing the fragments of running lanes
  under « ⏳ En cours » (the integrated releases already appear as « prêt »).

---

## 3. When same-musician parallelism is impossible or dangerous

Principle: **parallel by default (within `maxParallel`), serial only when a
rule fires**. Every rule lives in `scripts/lane-rules.mjs` with an `id`, a
detector, a scope (`project` = never parallel; `task` = this task runs
alone; `resource` = tasks sharing the resource serialise) and a pointer to
its justification below. Detection is by **code on facts** (git, files,
config, processes) or by a **model-declared field** at the Découper step —
never by keywords in the request (0.66.0 rule).

Scope and status below are those of the registry (`scripts/lane-rules.mjs`,
checked by `_test_lane_rules.mjs`). Scopes: `project` = never parallel
(legacy turn lock); `lane0` = this task runs in lane 0, other lanes keep
running; `lane` = this task goes to one given lane; `task` = this task runs
alone (waits for every lane, blocks new ones); `resource` = tasks sharing the
resource run one after the other; `none` = informational. Status: `active` =
detected since 0.101.0; `planned` = documented, detector not written yet.

| id | Case | Scope | Status | Detected by | Justification |
|---|---|---|---|---|---|
| `no-git` | project not a git repo, or no commit | project | active | `git rev-parse --is-inside-work-tree`, `HEAD` exists | no worktree, no isolation possible |
| `git-unsupported` | submodules, LFS without the filter installed, sparse checkout, detached HEAD, git < 2.20 | project | active | `.gitmodules`, `.gitattributes filter=lfs` + `git lfs version`, `core.sparseCheckout`, `git symbolic-ref HEAD`, `git --version` | worktree content would differ from the checkout; a detached HEAD has no integration branch |
| `same-task` | answer/resume of a task already holding a lane (`--lane k`, `[CHEF_ANSWER]`, `--meme-tache`, `--resume-session`) | lane | active | task affinity: `logs/lanes/<p>/<k>.task.json` in state `input`; two such lanes without `--lane` ⇒ refused (64), never guessed | session and work tree belong to that lane |
| `lane0-direct` | direct user dialogue | lane0 | active | the user's own message only: no `--source`, not launched from a chef or slot turn, not from the queue, not a pool-slot fill | the user works in their own checkout by definition |
| `pipeline-engine` | resume of a pipeline run that started in the main checkout (paused before 0.115.0, or run in lane 0) | lane0 | active | `lanes.mjs pausedPipelineRuns`: the paused run has no lane (or lane 0) | its files are in the main checkout; since P9 (0.114.0) a NEW run goes to a lane (§12) |
| `pipeline-pilot` | new pipeline run of a project that is not a P9 pilot: only a dev instance (`devOf`) runs its pipelines in lanes; any other project needs `"pipelineLanes": true` (its entry or `defaults`) | lane0 | active | `lanes.mjs pipelineLanesInfo` (`PIPELINE_LANES_PILOT_ONLY`) | user request 2026-10-18 « orchestrateur-dev : il faut activer P9 », with the 2026-10-15 rule that the dev instance pilots lanes first (§12) |
| `dual-mode` | `--second-model` on an ordinary dispatch (outside a pipeline) | lane0 | active | flag | `dual-run.mjs` branches its worktrees off the main checkout; inside a pipeline step in a lane, the dual mode works from the lane (§12) |
| `main-dirty` | main checkout has uncommitted tracked changes and no turn runs in lane 0 | lane0 | active | `git status --porcelain --untracked-files=no` | the task must see the user's work, so it runs in that checkout; changes made by a running lane-0 turn do not count |
| `machine-state` | scheduled tasks, services, registry, global installs, `~/.claude.json` | task | active | Routage field `ressources: ["poste"]` (`--ressources poste`) | global side effects cannot be merged |
| `migration` | schema migration | task | active | Routage field `ressources: ["migration"]`; also holds resource `db` | ordering of migrations is global |
| `port` | the task runs a server on a fixed TCP port | resource | active | Routage field `ressources: ["serveur"]` ⇒ resource `port-<n>` for each known port (config `port`, `lanes.ports` of `pipeline.json`), `port` if none is known. Runtime detection of listened ports = item P10 | two servers cannot bind the same port; a test hitting `localhost:n` would hit the other lane's server |
| `orchestrator-self` | this repository: sandbox on the instance's fixed port | resource | active | `.orchestrateur-instance.json` `port` + `ressources: ["serveur"]` ⇒ resource `port-<n>`. `SERIAL_SUITES` need no rule: in a lane, the "repo root" they write to is the lane's own copy | see `port` |
| `adb-device` | Android install / run on a device or emulator | resource | active | Routage field `ressources: ["appareil"]` ⇒ resource `adb`. Runtime detection (`adb` child) = item P10 | one device, one installed APK, one foreground app |
| `database` | shared external DB or a DB file outside the repo | resource | active | Routage field `ressources: ["base"]` ⇒ resource `db` | concurrent writes / fixtures overwrite each other |
| `gradle-heavy` | Gradle builds | none | planned | Gradle wrapper present | separate worktrees have separate `build/` and project caches, `~/.gradle` is lock-safe; but each daemon costs 1–2 GB, so it will count `weight: 2` in the host limit (§4) |
| `deps-shared` | task changes dependency manifests while `node_modules` is linked | task | planned | diff on manifests vs merge base | a shared install would break the other lanes (only with `lanes.link`; nothing is linked by default) |
| `outside-repo` | writes outside the lane directory | task | planned | the permission flow (0.45.0) knows the lane; post-turn scan of `tool_use.file_path` (item P10). Today: the lane prompt forbids it | the change escapes isolation and integration |
| `chef` | the chef | none | active | `CONDUCTOR` | already parallel through its pool, unchanged |
| `codex-sandbox` | codex runner in a lane | none | active | — | codex runs with `cwd = lane` (`--cd`); listed so a regression shows here |

**Model-declared resources.** The Découper step (0.69.0) gets an optional
field per task: `ressources: [...]` from a closed list (`migration`,
`serveur`, `appareil`, `base`, `poste`), with a one-line `raison`. It is the
meaning of the task as judged by the model; code then maps it to rules.
Absent ⇒ only code detectors apply.

**Learning, never forgetting silently.** A runtime detection (port, adb,
outside write) on a task that ran in parallel writes
`system/lane_rule_learnt` and adds the resource to `logs/<p>.resources.json`,
so the next tasks serialise; it is shown to the user once, with the
evidence.

### 3.1 Trace of every justification

When a rule makes a task wait or run alone:

- event `system/lane_exclusive {rule, scope, resource?, evidence, detectedBy,
  waitingFor?}` in the musician's (lane) log;
- in the thread: a one-line card « ⛓ En série — <plain reason> (règle
  `<id>`) », with a link to the rule's section in this document;
- on the musician card and in the queue overlay: chip « ⛓ <rule> »;
- `/api/pupitre` `lanes[].exclusive {rule, text}`; fleet-status note
  `EN SÉRIE: <rule>`;
- `GET /api/lanes/:project` lists lanes, held resources and active rules.

**Documentation is enforced by test**: `_test_lane_rules.mjs` fails if a rule
id in `lane-rules.mjs` has no row in the table above (or the reverse).

---

## 4. Concurrency limits

- **Per musician**: `maxParallel` in the project entry of `config.json`, else
  `defaults.maxParallel`; **default 2** since 0.103.0 (user decision Q1, §6;
  it was 1 = opt-in project by project up to 0.102.0); an explicit 1 keeps
  today's behaviour; hard cap 4. Lowering it never kills a running
  lane; it stops new acquisitions.
- **Per host**: `defaults.hostMaxTurns` (default: `max(2, floor(cores / 2))`,
  hard cap 12) counts every running musician turn of every lane (chef pool
  excluded, it has its own `conductorPool.size`) weighted by rule weights
  (`gradle-heavy` = 2, emulator = 3). Implemented as a host semaphore of
  token files `logs/host-slots/<n>.lock` (exclusive create, dead-owner
  takeover), so `dispatch.mjs` processes started outside the server respect
  it too.
- **Memory guard**: no new lane when free physical memory is below
  `defaults.laneMinFreeMb` (2048); the task waits with reason `host-memory`
  (a host rule, traced like §3.1).
- **Subscription limits**: the fleet limit flag (Claude limit) applies to all
  lanes; parallel lanes consume the same Max quota, which is why the default
  is 2 (not more until monitored, Q1) and the host cap is conservative.
- Visible: `parallel {running, max}` per musician, host gauge
  `hostTurns {running, max}` in `/api/pupitre` and the top bar.

---

## 5. Development items (each with its regression test)

Before starting: rollback tag `pre-parallel-lanes-v<current>`, targeted
regression before/after for each item (0.72.0), full regression before any
prod jump. Pilot project: **orchestrateur-dev itself** (user decision Q5,
§9), with the reinforced safeguards of §9; then the user picks the next ones.

| # | Item | Testable result | Regression test |
|---|---|---|---|
| P1 | `lane-rules.mjs`: rule registry and pure detectors (git facts, config, declared resources, manifests) | each rule fires on a fixture repo and only there; doc table ↔ registry consistent | `suite:_test_lane_rules.mjs`; **+ USER_REQUIREMENTS line** and `suite:_test_parallel_lanes.mjs` skeleton (permanent requirement test, grows with each item) |
| P2 | `lanes.mjs`: lane paths and files (lane 0 = legacy names), `lanes.json` | path mapping, lane 0 byte-identical to today | `suite:_test_lanes_layout.mjs` |
| P3 | Worktree lifecycle: create, trust (`workspace-trust.mjs`), provision (link/copy/setup), per-task branch, reset, removal, crash recovery | temp repo: create → task → reset → kill mid-task → recovery archives diff and closes the turn | `suite:_test_lane_worktree.mjs` (fake `~/.claude.json` via `ORCH_CLAUDE_JSON`) |
| P4 | `dispatch.mjs`: lane acquisition replaces the single turn lock; exclusive lock; host semaphore | fake claude, `maxParallel=2`: two dispatches run concurrently, two logs never interleaved, two sessions; `maxParallel=1`: second one waits/queues exactly as 0.67.0 | `suite:_test_parallel_lanes.mjs` §dispatch; `_test_turn_logs.mjs` unchanged and green |
| P5 | Integration: merge, conflict turn, checks, version assignment from fragments, ff-only, integration lock, pauses | temp repo with two lanes editing the same line → conflict turn (fake claude resolves) → two versions in integration order; dirty main → pause, nothing overwritten | `suite:_test_lane_integration.mjs` |
| P6 | Server: queue drain per free lane, `dispatchPidAlive(name, lane)`, sweeps, `/api/lanes/:project`, additive `/api/pupitre` fields | sandbox instance: 3 queued tasks, `maxParallel=2` → 2 start, 3rd starts when one finishes; exclusive entry waits with trace | `http:lanes-queue`, `http:lanes-api` |
| P7 | State aggregation in `turn-core.js` + fleet-status + `scanProject` | aggregate priority, lane list, `busy-not-ready` per lane | `suite:_test_lane_state.mjs`; `_test_busy_never_ready.mjs` green |
| P8 | Routing: lane affinity of same-task requests, `notify --lane`, `after.lane` in Routage pending, request map, chef relay dedupe, `ressources` field at Découper | answer to a lane's question resumes that lane's session; dependent task released on the right lane log | `suite:_test_lane_routing.mjs`; `_test_routage_pending.mjs`, `_test_request_map.mjs`, `_test_context_calibration.mjs` green |
| P9 | Pipeline engine in a lane: cwd, artefacts, item delivery on the task branch, Livrer → fragment, dual mode inside a lane | full dev run in lane 1 ends with a fragment and no version edit; integration produces the release | `suite:_test_lane_pipeline.mjs`; pipeline suites green |
| P10 | Runtime detectors: listened ports of the lane tree, outside-repo writes through the permission flow, learnt resources | fake claude starts a listener in lane 1 → resource learnt, next task serialised, event shown | `suite:_test_lane_runtime_rules.mjs`; `_test_permission_prompt.mjs` green |
| P11 | UI: lane chips and tabs, « ⛓ En série » cards with rule link, overlap ⚠, integration pause menu, per-lane ack/resolve, host gauge (desktop + mobile, `rem` fonts) | visible and actionable per lane | `nav:lanes-panel`, `nav:lanes-exclusive`, `nav:lanes-mobile` |
| P12 | Rollout: `maxParallel: 2` on `orchestrateur-dev` once the §9 conditions hold, docs (CLAUDE.md section, DEV-PROD note), rollback `maxParallel=1` everywhere | two real independent tasks on the pilot run in parallel, each passes the targeted regression and the delivery gate, and integrates as its own release | full `regression.mjs`; `_test_parallel_lanes.mjs` end-to-end scenario; `_test_lane_changelog_rule.mjs` |

Android app: additive fields ignored until an app update (out of the
regression scope since 0.73.2).

## 6. Questions for the user

**Decided (2026-10-15):**

- **Q2 — task branches after integration.** User, verbatim: « On peut
  eliminer les branches de taches une fois terminees, apres 1 semaine. » ⇒ no
  tags; a finished task's branch is kept one week, then deleted
  automatically, never before (retention rule and test: §1.2 step 6).
  Delivered in 0.101.1.
- **Q3 — merge or squash.** User, verbatim: « Fusion par merge ». ⇒ the
  integration branch is merged into the task branch, then the main checkout
  fast-forwards (§1.4); no squash. Unchanged since 0.101.0, now tested.

- **Q4 — version/CHANGELOG rule.** User, verbatim: « Question 4 : ok, je
  valide tout ». ⇒ the §2.8 rule as proposed: a lane task writes a
  `changelog.d/` fragment, never the version nor `CHANGELOG.md`; the
  integrator assigns the number and writes the dated entry, one task at a
  time, each task one release in integration order. Lane 0 and projects
  without `maxParallel` keep the usual rule. Delivered in 0.102.0 (§2.8, §9).
- **Q5 — pilot.** User, verbatim: « Question 5 : Non, orchestrateur-dev, a
  nous de faire en sorte qu'il ne se trompe pas ». ⇒ the pilot is not
  `pipelineLab` but **orchestrateur-dev**; no checkpoint after P5: the
  reliability must come from the work itself (a regression test per
  mechanism, rollback tag, documented and tested rollback). §9.

- **Q1 — default `maxParallel`.** User, verbatim: « Q1: defaut a 2, et on
  monitore pour verifier si on peut passer a 3. Le monitoring n'est pas a
  faire maintenant, mets dans une TODO ». ⇒ default 2 (`DEFAULT_MAX_PARALLEL`
  of `lanes.mjs`), hard cap 4 unchanged, all exception rules unchanged; an
  explicit `maxParallel: 1` keeps the 0.67.0 path. Monitoring whether 3 is
  safe is a separate TODO item, not done here. Delivered in 0.103.0 (§10).

All §6 questions are now decided.

## 7. Delivered in 0.101.0 (lot 1)

User request (2026-10-15, verbatim): « Il faut que ce soit assez fin (d'ou la
question sur git) pour que les taches d'un meme musicien puissent s'activer en
parallele. Sauf pour certains cas particuliers sont detectes, ils doivent alors
etre justifies et documentes. »

**In** (tests: `_test_parallel_lanes.mjs`, `_test_lane_rules.mjs`, HTTP
`lanes-queue`, `lanes-api`):

- P1 — `scripts/lane-rules.mjs`: registry, pure detectors, closed list of
  declared resources (`--ressources migration,serveur,appareil,base,poste`),
  doc ↔ registry check.
- P2 — `scripts/lanes.mjs`: lane 0 = today's files byte for byte; lanes ≥ 1
  under `logs/lanes/<p>/<k>.*` and `<root>/lanes/<p>/<k>` (gitignored).
- P3 — worktree lifecycle: `git worktree add --detach`, workspace trust,
  provisioning (ignored local files: `CLAUDE.local.md`, `.claude/settings*.json`,
  `.env*`, plus `lanes.copy` / `lanes.link` of `pipeline.json`), branch
  `lane/<k>/<task>` per task, crash recovery (`system/lane_interrupted` +
  `result/error_lane_interrupted`, work committed on its branch).
- P4 — `dispatch.mjs`: one lock per lane (lane 0 first, then the first free
  lane), project-exclusive lock (`logs/<p>.exclusive`) for `task` rules,
  resource locks (`logs/lanes/<p>/res-<key>.lock`). `maxParallel = 1` ⇒ the
  0.67.0 code path, untouched (no lane file, no new field).
- P5 (partial) — integration at the end of the turn, under
  `logs/<p>.integrate.lock`: leftovers committed, `merge` of the integration
  branch, release from `changelog.d/*.md` fragments (package.json, gradle
  `versionName`/`versionCode` from `versionFiles`, CHANGELOG entry), `merge
  --ff-only` in the main checkout (retried when the branch moved; waits for
  lane 0's turn when its local changes block the ff), branch deleted (0.101.0;
  since 0.101.1 kept one week, then deleted — decision Q2, §8). Conflict,
  failed turn or blocked ff ⇒ **pause**: branch kept, diff archived in
  `logs/lanes/<p>/<task>.diff`, `lane_integration_paused`, notify to the chef
  (`source: lane-integration`). Nothing is overwritten, stashed or pushed.
- P6 (partial) — server: queue entries carry `lane`, `ressources`,
  `exclusive`; an entry with `exclusive` is queued even when lane 0 is free;
  the drain passes `--lane` / `--ressources` back; `GET /api/lanes/:project`.
- P8 (partial) — same-task affinity: `--lane k`; `[CHEF_ANSWER]`,
  `--meme-tache`, `--resume-session` go to the one lane whose task waits for
  an answer (two such lanes ⇒ refused, 64). The lane prompt (`laneRule`) asks
  the musician to say « --lane k » in its question, never to edit the
  version/CHANGELOG, to write a fragment, to stay in its folder.
- Visibility: `system/lane_exclusive` and `system/lane_task` markers in the
  musician's log; activity journal (`turn-core.js`, `activite.js`): one entry
  per lane task with its outcome/version, « ⛓ En série — raison (règle) » on
  a retained turn; queue detail: « En série », « Couloir », « Ressources »;
  queue row: « ⛓ en série : <règle> ». CLI `node scripts/lanes.mjs status
  <p> [--json]` and `release <p> <k>` (frees a lane waiting for an answer).

**Not yet** (unchanged plan items): the model-driven conflict-resolution turn
(P5: a conflict pauses instead), the delivery gate on the merged tree for this
repository, the Découper field `ressources` (P8: the flag exists, the Routage
does not fill it yet), `after.lane` of Routage pending tasks, request map and
chef relay of lane questions (the server's pump reads lane 0's log only — a
lane task reports through its `notify.mjs` callback), per-lane state in
`/api/pupitre` / cards / Android (P7, P11), the pipeline engine and dual mode
inside a lane (P9: rules `pipeline-engine`, `dual-mode` keep them in lane 0),
runtime detectors (P10: `outside-repo`, learnt ports), host limit and memory
guard (§4: `gradle-heavy`), `deps-shared`.

**Decided by default** (§6 questions, to confirm by the user): `maxParallel`
stays 1 everywhere (opt-in per project); task branches are deleted after a
successful integration (no tag); integration merges the integration branch
into the task branch, then fast-forwards (no squash). Q2 and Q3 were then
answered by the user: see §8.

**Rollback**: remove `maxParallel` from config.json (or set 1): the 0.67.0
path is used again at the next dispatch, no restart. Code: `git revert` to
the tag `pre-parallel-lanes-v0.100.3`.

## 8. User decisions Q2 / Q3 applied (0.101.1)

- **Q2** (« On peut eliminer les branches de taches une fois terminees, apres
  1 semaine. »): the immediate `git branch -D` after integration is replaced
  by the one-week retention of §1.2 step 6 (`retainBranch`,
  `pruneRetainedBranches`, `BRANCH_RETENTION_MS`, registry
  `logs/lanes/<p>/retained-branches.json`, pruning at each lane task start,
  hourly server sweep `sweepLaneBranches` — needs a server restart —, CLI
  `lanes.mjs prune`). No tag is ever created.
- **Q3** (« Fusion par merge »): integration unchanged (merge, then
  `--ff-only`); the requirement test now checks that no squash happens.
- Tests: `_test_parallel_lanes.mjs` §1 (the 0.101.0 assertion « branches
  deleted after integration » is replaced by « kept one week, no tag, task
  commits in the history », following the user's decision) and §9.
- Rollback: `git revert` to the tag `pre-lane-branch-retention-v0.101.0`.
  The retained branches then stay until deleted by hand.
- Q1, Q4 and Q5 remained open at that point (§6); Q4/Q5: see §9.

## 9. User decisions Q4 / Q5 applied (0.102.0) — pilot orchestrateur-dev

- **Q4**: §2.8 « Validated by the user ». Test `_test_lane_changelog_rule.mjs`
  §1–§9 (fragments, order of integration, gradle, conversion, pauses,
  generated fragment, release check, hooks), line in
  `docs/USER_REQUIREMENTS.md`.
- **Q5**: the pilot is orchestrateur-dev. « a nous de faire en sorte qu'il ne
  se trompe pas »: every mechanism the pilot relies on has its own permanent
  test, and nothing is enabled before the conditions below hold.

**Why orchestrateur-dev is a demanding pilot.** It is dispatched by the
*production* orchestrator (`I:\orchestrateur`, frozen on a tag), its
musician must never write under that root, its deliveries go through the
delivery gate (`pre-commit` hook, report on the exact tree), and its own
regression suites are heavy and spawn sandbox servers.

**Safeguards delivered in 0.102.0** (all in `_test_lane_changelog_rule.mjs`):

| Risk | Safeguard |
|---|---|
| Lanes created under the production root (`I:\orchestrateur\lanes\…`), which this musician must never write to | `lanes.dir` of `.orchestrateur/pipeline.json` (relative, outside the repository; `../orchestrateur-dev-lanes`), used by `laneDir`/`ensureLane`/`status`; an absolute path or a path inside the repo is ignored (§11) |
| A lane without the untracked files the suites need | `lanes.copy`: `config.json`, `.orchestrateur-instance.json`, `.token`, `model-routing.json`, `language-settings.json`; `lanes.link`: `node_modules` (§10) |
| A release commit bypassing the delivery gate | release commit with hooks; `lanes.releaseCheck` = `node scripts/regression.mjs --targeted --since {base}` on the staged release tree, so the hook finds a report made on exactly that tree; red check or refused hook ⇒ pause, nothing integrated (§8, §9, §10) |
| Two tasks both bumping the version / editing the CHANGELOG | §2.8 rule enforced by the integrator, converted or paused, never a wrong number (§1–§7) |

Existing safeguards the pilot relies on (0.101.x, `_test_parallel_lanes.mjs`,
`_test_lane_rules.mjs`): `main-dirty` (user's uncommitted work ⇒ the task
runs in lane 0), `lane0-direct`, `orchestrator-self` + `port` (the sandbox on
7778 is one resource), conflicts pause and never resolve by `-X`, nothing
pushed, crash recovery, branch retention one week.

**Conditions before setting `maxParallel` on orchestrateur-dev (P12):**

1. The production orchestrator runs a version ≥ 0.102.0: it is the
   production `dispatch.mjs` that creates the lanes of orchestrateur-dev. That
   needs a jump decided by the user (`docs/DEV-PROD.md`) and, for the server
   parts (queue drain per lane, branch sweep), a production restart.
2. The delivery gate hook is installed in the dev clone (`node
   scripts/delivery-gate.mjs install-hook`; worktrees share `.git/hooks`).
3. `maxParallel: 2` in the production `config.json` entry of
   orchestrateur-dev — a production change, made by the chef on the user's
   decision, never by the dev musician.
4. Full regression green on the jumped tag.
5. Planned before or with P12: the release-notes listing of running lanes'
   fragments; per-lane state in `/api/pupitre` (P7) so the user sees the two
   lanes.

**Rollback** (tested by the suites above, no restart): set `maxParallel: 1`
in the orchestrateur-dev entry ⇒ the 0.67.0 path at the next dispatch (since
0.103.0, removing the key gives the default 2, §10); a paused integration
keeps its branch and diff, nothing to undo. Code: `git revert` to the tag
`pre-lane-changelog-rule-v0.101.1`.

## 10. User decision Q1 applied (0.103.0) — default 2

- **Q1** (« Q1: defaut a 2, et on monitore pour verifier si on peut passer a
  3. Le monitoring n'est pas a faire maintenant, mets dans une TODO »):
  `maxParallelFor` falls back to `DEFAULT_MAX_PARALLEL = 2` instead of 1.
  `HARD_CAP` stays 4; every rule of §3 still applies (a project without git,
  a direct dialogue, a pipeline, a port… stays serial, justified).
- **Effect**: every git project without `maxParallel` gets two lanes — on
  the fleet only once the production orchestrator runs ≥ 0.103.0 (a jump
  decided by the user; the §9 conditions for the pilot still hold). The
  chef pool is unaffected (chef excluded from lanes).
- **Not done here**: monitoring whether 3 is safe (host load, memory, Max
  quota, integration pauses) — a separate TODO item.
- Tests: `_test_maxparallel_default.mjs` (permanent requirement test: unit,
  `lanesStatus`, real dispatch with two concurrent tasks on a project without
  `maxParallel`, `no-git` still serial), `_test_lane_rules.mjs` §4, HTTP
  `lanes-api`; `_test_parallel_lanes.mjs` §4 now sets `maxParallel: 1`
  explicitly on its « 0.67.0 behaviour » project.
- **Rollback** (no restart): `"defaults": {"maxParallel": 1}` in
  config.json ⇒ the 0.67.0 path for every project without its own value.
  Code: `git revert` to the tag `pre-maxparallel-default-2-v0.102.0`.

## 11. The dev goes first, production at the next update (0.104.0)

- **User decision** (2026-10-15, answering the pilot question): « il ne
  faudra passer d'abord que orchestrateur-dev, on ne passera orchestrateur
  qu'a la maj suivante ».
- **Rule** (`maxParallelInfo` of `scripts/lanes.mjs`, flag `DEV_PILOT_FIRST`):
  a project designated by another entry's `devOf` (the production
  orchestrator) gets `maxParallel = 1` — exactly the 0.67.0 path: turn lock,
  queue, no lane — unless its OWN entry sets `maxParallel`.
  `defaults.maxParallel` does not reach it. The dev instance and every other
  project keep the default 2. `lanesStatus` (`GET /api/lanes/:projet`,
  `lanes.mjs status`) reports `maxParallelSource: 'dev-pilot-first'` and the
  reason.
- This is a default, not a §3 exception rule: the project never enters the
  lane code, so there is no `system/lane_exclusive` event.
- **Next update** (lifting it): set `DEV_PILOT_FIRST = false` (and update
  `_test_dev_pilot_first.mjs` with the user's agreement), or put
  `"maxParallel": 2` on the `orchestrateur` entry of the production
  config.json (no restart).
- Test: `_test_dev_pilot_first.mjs` (unit, `lanesStatus`, real dispatch:
  production serial without lanes, dev with two concurrent tasks).
- **Rollback**: `git revert` to the tag `pre-dev-pilot-first-v0.103.0`.

## 12. P9 — the pipeline engine in a lane (0.115.0)

- **User request** (2026-10-18), verbatim: « Lances-led », answering the
  chef's offer to launch P9 after « Le parallelisme de l'orchestrateur est-il
  en ligne ? » (yes for ordinary tasks, no for pipelines: rule
  `pipeline-engine` pinned every run to lane 0, so no project in service ran
  two tasks at once, and a paused run blocked the next ones).
- **Lane choice** (`lane-rules.mjs decide`, mode `pipeline`): a new run takes
  a free worktree lane first, lane 0 last and only when the main checkout is
  clean (`git status --untracked-files=no`), so that a run that pauses never
  leaves the user's checkout dirty. No free lane ⇒ wait or queue, as any task.
  `lane0-direct` still comes first (a direct dialogue stays in lane 0; since the 2026-10-27 fix a chef or slot dispatch, a queued request or a pool-slot fill is no longer a direct dialogue).
- **Affinity of a paused run** (`dispatch.mjs`, before the lane choice): a
  reply offered by the pause (« continuer », « accepter », « tout supprimer »,
  « abandonner », « simplifier », « changer le model », « tester le model »,
  or `--pipeline-resume`) goes to the lane holding the run
  (`lanes.mjs pausedPipelineRuns`: run.json `lane`, lane task in state
  `input`), rule `same-task`; a run paused in the main checkout resumes
  there, rule `pipeline-engine` (restricted). Several paused runs and no
  `--lane` ⇒ refused (64), never guessed. The engine refuses a resume in
  another lane than the run's (65).
- **Engine** (`pipeline-engine.mjs runPipeline`): `cwd`, log and `.pid` of
  the lane; `run.json` records `lane {k, task, branch, integration}`;
  artefacts under `<lane>/.orchestrateur/runs/`, excluded through the
  COMMON `info/exclude` (a worktree reads only that one). Each step's
  `dispatch.mjs --pipeline-step` recomputes the lane folder from the run's
  lane number (never a path read from a file) and works there; the steps'
  prompt says which lane and forbids writing in the main checkout.
- **Livrer in a lane** (design §2.8): line `FRAGMENT=changelog.d/<task>.md`;
  the step writes the fragment (`bump: patch|minor|major` + sections), never
  the version nor CHANGELOG.md; the criterion checks exactly that (version
  files and CHANGELOG unchanged, fragment present and valid), plus the
  requirements line, tests and build. The integrator then makes the release
  (fragments → version, CHANGELOG entry, release commit with hooks).
- **End of the turn** (`laneExit` → `finishLane`): done ⇒ integration; pause
  (`result.pipeline_paused`, code 2) ⇒ lane kept in state `input`, its work
  left UNCOMMITTED for the engine (`finishTask commitOnInput: false`);
  « changer / tester le model » ⇒ still paused (`holdTask`); « abandonner » /
  « simplifier » ⇒ nothing integrated, work archived and committed on its
  branch (kept, never pruned), lane freed (`abandonTask`); a request the
  classifier could not classify ⇒ lane freed, the question sent to the chef.
- **Provisioning for pipelines** (`provisionPipelineLane`): the engine runs
  the test command itself, so the main checkout's ignored `node_modules`,
  `.venv`, `venv` are shared by junction (as the dual mode does) and
  `local.properties` is copied. Anything else a project's tests need must be
  declared in `lanes.copy` / `lanes.link`; a red base in a lane says so in
  the pause message. Per-project way out: `"maxParallel": 1`.
- **Requirements registry**: every delivery appends a line at the end of
  `requirements` (pipeline.json), so two parallel deliveries always collide
  there. For the integration merge only, that one file uses git's union driver
  (`unionMergeArgs`, through `-c core.attributesFile`: nothing written in the
  repository): both lines kept. Every other file keeps the strict rule.
- **Dual mode inside a step in a lane**: its branches start from the lane
  (`project.path` = the lane), its worktrees under
  `logs/dual/wt/<p>~lane<k>/`; `recoverInterrupted` never touches the dual
  branches whose worktree belongs to another lane.
- **Routage dependencies** (`routage-pending dependencyResult`): the end
  marker `system/lane_task` written in the musician's log carries
  `promptHash` (fingerprint of the task text) and `turnEnd`: integrated or
  nothing to integrate = success; integration paused, abandoned or failed
  turn = failed; a lane waiting for an answer has not finished.
- **Still not done**: per-lane state on the dashboard and the Android app
  (P7/P11: a lane's question reaches the user through the chef), the
  model-driven conflict turn (P5: a conflict pauses), runtime detectors (P10).
- **Tests**: `_test_lane_pipeline.mjs` (permanent requirement test, serial),
  `_test_lane_rules.mjs` (rule restricted; the 0.101.0 assertion « pipeline
  run in lane 0 » replaced, following the user's request).
- **Rollback** (no restart): `"maxParallel": 1` on a project (or in
  `defaults`) ⇒ the 0.67.0 path. Code: `git revert` to the tag
  `pre-lane-pipeline-v0.110.1`.
- **Pilot first** (0.115.0, user request 2026-10-18 « orchestrateur-dev : il
  faut activer P9 », with the 2026-10-15 rule « il ne faudra passer d'abord
  que orchestrateur-dev »): P9 shipped to production together with this gate.
  `lanes.mjs pipelineLanesInfo`: a dev instance (`devOf`) runs its pipelines
  in lanes; every other project keeps them in lane 0 (rule `pipeline-pilot`,
  §3) unless its entry or `defaults` sets `"pipelineLanes": true` (read at
  each dispatch, no restart; `false` on the dev instance turns P9 off for it).
  Ordinary tasks are unchanged (`maxParallel`). Lifted for the fleet by
  setting `PIPELINE_LANES_PILOT_ONLY` to false. Permanent requirement test:
  `_test_dev_pipeline_lanes.mjs` (two pipeline runs of the dev instance in two
  lanes at once; the production project and an ordinary project stay serial).
