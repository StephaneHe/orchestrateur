# Production and development instances of the orchestrator

User decision (2026-10-10): « l'orchestrateur actuel sera sur une version donnée
du code alors que le nouveau musicien sera sur une version au moins égale ou
plus récente. donc la version du code actuel sera figé pour ce musicien. le
développement continuera et les versions évolueront sur le nouveau musicien. le
code actuel (en prod sur le musicien Orchestrateur) fera des bons quand ce sera
utile. »

## Roles

| | Production | Development |
|---|---|---|
| Musician | `orchestrateur` | `orchestrateur-dev` (`devOf: orchestrateur`) |
| Checkout | `I:\orchestrateur`, branch `master` | `I:\Dev\orchestrateur-dev`, branch `dev` |
| Git | the reference repository | an **independent clone** (own `.git`, `git clone --no-hardlinks`) |
| Code | frozen on a version tag (first: `v0.67.1`) | starts from that tag, moves on |
| Server | port **7777**, scheduled tasks (server + watchdog), the dashboard | **no server of its own**; a live instance only through the sandbox, port **7778** |
| Logs | `I:\orchestrateur\logs` | `I:\Dev\orchestrateur-dev\logs`, sandbox logs under its `.regress/` |
| Remotes | `origin` = GitHub | `origin` = GitHub, `prod` = `I:\orchestrateur` **fetch-only** (push URL `NO_PUSH_TO_PROD_REPO`) |

Why a clone and not a `git worktree`: a worktree shares production's `.git`
(refs, tags, stash, hooks, gc). Any git operation of the dev musician would
touch production's repository. A clone shares nothing, and it is removed by
deleting one directory plus one fleet entry. `scripts/dev-split.mjs` (and the
suite `_test_dev_split.mjs`) refuses a worktree.

Local, never committed files of the dev checkout:
- `.orchestrateur-instance.json`: role, branch, port, logs dir, base tag ;
- `CLAUDE.local.md`: the dev musician's rules ;
- `config.json`: a snapshot of the production fleet, for the test suites only.
  Never start the dev's own `server.js` with it ;
- `.token`: its own token.

## Development

- The chef dispatches development tasks to `orchestrateur-dev`. Production
  (`orchestrateur`) only receives urgent fixes, if the user asks for them.
- The dev musician commits on `dev`. Pushing `dev` to GitHub needs the user's
  explicit authorisation, like any push.
- Live dev instance (fixtures, fake claude, its own logs, never port 7777):
  `node scripts/regression.mjs --keep --no-suites --no-browser --port 7778`
  (run in `I:\Dev\orchestrateur-dev`). The sandbox rewrites 7777 in its copy
  of `server.js` and the scripts, and verifies that none is left. `--port`
  refuses 7777 and a busy port.
- During development, the **targeted** regression is enough (0.72.0):
  `node scripts/regression.mjs --targeted [--since <tag>]` runs the always-run
  base plus the suites and stages that cover the changed files, and falls back
  to the full run when a changed file is covered by nothing. A targeted run
  with a KO still refuses the delivery commit (git hook).
- Before production, the regression **by perimeter** (0.106.0) is enough, on
  exactly the tag's content and from the version production runs:
  `node scripts/regression.mjs --ref vX.Y.Z --perimeters --prod I:\orchestrateur`
  (or `--since <prod commit>`). The project is split into isolated perimeters
  in `scripts/regression-perimeters.json` (every file in exactly one
  perimeter or category, every suite in one perimeter); the run takes the
  files changed since production (`git diff`), prints the perimeters and
  suites it keeps and why, and runs the base, the suites of the impacted
  perimeters (and of the perimeters whose suites reach them) and their HTTP /
  browser stages. It falls back to the **full** run (`node scripts/regression.mjs
  --ref vX.Y.Z`, every suite and stage, still accepted) when a transverse file
  changed (dependencies, `package.json` beyond its version, shared utilities,
  test doubles), when a changed file belongs to no perimeter, or with
  `--full`. Preview only: `node scripts/regression-perimeters.mjs select
  --since <prod commit> --ref vX.Y.Z`.
- Keeping the map up to date: `node scripts/regression-perimeters.mjs check`
  (also the base suite `_test_regression_perimeters.mjs`, so every run fails
  while a file or a suite is unattached, or while a suite reaches a perimeter
  its entry does not declare). `check --suggest` prints the `uses` lists the
  suites need, to paste into the map.

## Jumps (dev → prod)

Production moves only by a **jump** to a tested version tag. The user decides
when.

1. In `I:\Dev\orchestrateur-dev`:
   - the version `X.Y.Z` is bumped with its CHANGELOG entry ;
   - tag `vX.Y.Z` (annotated) ;
   - the regression BY PERIMETER from production is green on the tag:
     `node scripts/regression.mjs --ref vX.Y.Z --perimeters --prod I:\orchestrateur`
     (it runs the full one by itself when needed; a targeted or partial run
     does not count) ;
   - `node scripts/prod-jump.mjs --tag vX.Y.Z --prod I:\orchestrateur` checks
     everything (green report on the tag's tree — full, or by perimeter from
     the production commit, the selection recomputed from the tag's own map
     and every expected suite and stage present — production clean, no turn
     running, fast-forward possible) and prints the plan ;
   - push `dev` and the tag to `origin`, with the user's authorisation.

   **With the idle-time policy on** (0.142.0, `node scripts/pipeline-enforce.mjs
   idle-regression on`, user decision of 2026-10-23: « la mise en prod ne
   dépend plus que des tests unitaires et les non régression ne servent plus
   qu'à posteriori »): no full nor perimeter run is required. `prod-jump.mjs`
   (switch read in the production's `model-routing.json`, or `--unit`) accepts
   the green report of the task's tests on the tag's tree — the delivery
   commit's own targeted report — and prints the state of the full runs after
   the fact (`scripts/idle-regression.mjs`: launched by the program in
   orchestrateur-dev while the user is idle, never in production). The
   `prod-before-vX.Y.Z` tag and the way back are unchanged.
2. In `I:\orchestrateur`, when **no orchestrator turn runs**
   (`node scripts/fleet-status.mjs`, no `logs/orchestrateur.turnlock`, empty
   queue). The scripts are read live by every turn of the fleet.
   `node scripts/prod-jump.mjs --tag vX.Y.Z --prod I:\orchestrateur --apply`
   (on the user's decision) refuses without that green run, then does the
   first three commands below; it never restarts anything.
   ```
   git tag -a prod-before-vX.Y.Z -m "production before the jump to vX.Y.Z"
   git fetch origin --tags
   git merge --ff-only vX.Y.Z      # never a merge commit, never a force
   ```
   **No non-regression ever runs in production** (0.125.0, user rule of
   2026-10-20: « Aucune non regression ne doit se lancer sur orchestrateur.
   C'etait une regle. Uniquement sur orchestrateur-dev »). The run that
   counts is the one made in the dev on the tag (step 1). `regression.mjs`
   refuses (exit 65) to run in a production checkout or with `--dir` on one
   (`scripts/prod-guard.mjs`: `I:\orchestrateur`, an instance marked
   `"role": "prod"`, a checkout whose `config.json` declares its dev with
   `devOf`); there is no waiver.
   A file that production tracks but the version stops tracking and ignores
   (`TODO_LIST.md` since 0.74.2) is deleted by the fast-forward: `--apply`
   puts it back from `prod-before-vX.Y.Z` (the plan lists it). By hand:
   `git show prod-before-vX.Y.Z:TODO_LIST.md > TODO_LIST.md`.
   A production commit missing from the dev blocks the jump: fetch it
   (`git fetch prod`) and merge it into `dev` before tagging.
3. Restart the server so that it serves the same version as the scripts. The
   chef does it with `node scripts/restart-orchestrateur.mjs` when the fleet
   is idle, and only if the user agrees. Then, if needed, a non-regression on
   `orchestrateur-dev` — never in production.
4. Push `master` and the tags with the user's authorisation. `master` then
   equals `vX.Y.Z` (fast-forward), so `dev` and `master` share their history.

Data that a version migrates (`logs/`, `config.json`, `model-routing.json`,
`language-settings.json`, `permission-rules.json`) is described in that
version's CHANGELOG and kept reversible.

## Rollback

From a jump to `vX.Y.Z` back to the previous production state, again with no
orchestrator turn running:
```
git reset --hard prod-before-vX.Y.Z    # or: git checkout v<previous>
node scripts/restart-orchestrateur.mjs # chef, with the user's agreement
```
then, in `I:\Dev\orchestrateur-dev` (never in production):
`node scripts/regression.mjs --ref <restored tag>`.
Every production version is a pushed tag, so any of them can be restored the
same way.

### Jump without a push (0.85.1 → 0.95.0, 2026-10-14)

The user ordered this jump without any push, so `v0.95.0` was never on
`origin`: production fetched it from the local dev clone instead
(`git -C I:\orchestrateur fetch I:\Dev\orchestrateur-dev tag v0.95.0`, which
also brings the dev tags reachable from it), then
`git merge --ff-only v0.95.0`. The rollback tag was named
`pre-prod-0.95.0` (on `60392e1`, 0.85.1). Rollback:
```
git -C I:\orchestrateur reset --hard pre-prod-0.95.0   # back to 0.85.1 (60392e1)
node I:\orchestrateur\scripts\restart-orchestrateur.mjs # chef, user's agreement
```
then the non-regression in the dev on the restored state, never in production.
Checked before relying on it, on a throwaway clone of production (never on the
live checkout, whose server reads `public/` and the scripts from disk):
`9d3b678` 0.95.0 → `reset --hard pre-prod-0.95.0` → `60392e1` 0.85.1, clean
tree → `merge --ff-only v0.95.0` → `9d3b678` 0.95.0 again. `TODO_LIST.md` is
untracked on both sides, so it is left as is.

Removing the dev instance:
1. remove the `orchestrateur-dev` entry from `config.json` ;
2. `forgetWorkspace()` of `scripts/workspace-trust.mjs` ;
3. delete `I:\Dev\orchestrateur-dev`.

Production is not affected.

## What needs a server restart

The fleet configuration is read at startup by `server.js`. Until the
production server restarts:
- `dispatch.mjs` (read at every dispatch) already knows `orchestrateur-dev`:
  the chef can dispatch to it from its Bash tool
  (`node scripts/dispatch.mjs orchestrateur-dev …`) ;
- the dashboard, the Android app, `/api/dispatch`, the queue and the chef's
  callback wake-up for this musician come with the restart.

## Checks

- `node scripts/dev-split.mjs check`: the real installation (every fleet entry
  with `devOf`).
- `node scripts/_test_dev_split.mjs`: the same rules on fixtures (clone,
  worktree, port, logs, remotes, fleet entry, token) plus the real
  installation. It is part of `scripts/regression.mjs`.
