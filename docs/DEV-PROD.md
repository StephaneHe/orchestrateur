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
- Before any release of `dev`, the full regression runs in the dev checkout:
  `node scripts/regression.mjs`.

## Jumps (dev → prod)

Production moves only by a **jump** to a tested version tag. The user decides
when.

1. In `I:\Dev\orchestrateur-dev`:
   - the version `X.Y.Z` is bumped with its CHANGELOG entry ;
   - the full regression is green ;
   - tag `vX.Y.Z` (annotated) ;
   - push `dev` and the tag to `origin`, with the user's authorisation.
2. In `I:\orchestrateur`, when **no orchestrator turn runs**
   (`node scripts/fleet-status.mjs`, no `logs/orchestrateur.turnlock`, empty
   queue). The scripts are read live by every turn of the fleet.
   ```
   git tag -a prod-before-vX.Y.Z -m "production before the jump to vX.Y.Z"
   git fetch origin --tags
   git merge --ff-only vX.Y.Z      # never a merge commit, never a force
   node scripts/regression.mjs     # on the jumped production checkout
   ```
3. Restart the server so that it serves the same version as the scripts. The
   chef does it with `node scripts/restart-orchestrateur.mjs`, and only if the
   user agrees.
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
node scripts/regression.mjs
```
Every production version is a pushed tag, so any of them can be restored the
same way.

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
