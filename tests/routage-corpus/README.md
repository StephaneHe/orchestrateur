# Routage corpus (Routage v3, phase 2)

Real cases of the production Routage, read **read-only** on 2026-10-22
(`logs/runs/*/run.json`, the chef's run artefacts, `logs/chef-actions.log`),
**anonymised** for this public repository: private project names replaced
(`projet-video`, `projet-reunion`, `projet-a`…), texts abridged, URLs replaced by
`example.org`, no mail nor secret. Source: `docs/ROUTAGE-SYNTHESE.md` §1 and §3.10.

`cases.json` — 59 cases:

| kind | n | what the old Routage did |
|---|---|---|
| `refus` | 45 | a Découper attempt refused as a whole (« renvoi_chef ne peut pas attendre », « apres → renvoi », « aucune tâche », « le chef ne se délègue pas », 7 or 17 tasks, unknown project, resume of a run not paused, dependency out of bounds) |
| `renvoi-65` | 5 | a task handed back to the chef, refused with exit 65 (P0-B) |
| `infra` | 3 | OAuth expired, session limit, provider refusal (twice) |
| `reprise-par-citation` | 5 | a run id cited in a task's text turned into a resume (`detectReprise`) |
| `inversion` | 1 | `p-20261019T181739-7e7851`: the run closed BEFORE the TODO note, and « abandonner » sent as `kill-stalled` |

Each case holds the user's message, the **v3 plan** the single chef turn writes
for it (the old plan converted: a task for the chef becomes a typed action, an
explicit resume, or work the chef does in its own turn — `chefInTurn`), the
runs it refers to (`runs`, their status at the time) and `expect`:

- no global refusal (`toTreat`, `launchAtLeast`), one targeted retry only
  where the old plan had a dependency out of bounds (`retry`, `retryPlan` = the
  corrected plan of that time);
- no constraint removed: every « puis » is still there (`order`);
- no resume that was not asked for (`resumes`, `noResume`);
- `cancel_run`, never `stop_turn`, to abandon a run (`cancelRun`);
- nothing launched to the chef; infrastructure failures parked with the right
  cause and the right number of calls (`cause`, `calls`).

Replay: `node scripts/chef-turn.mjs corpus` (by the code, no model) or
`--live` (each message sent to the real chef model: a bench, outside the
regression, journal under `logs/chef-shadow/`). Checked by
`scripts/_test_routage_corpus.mjs`.
