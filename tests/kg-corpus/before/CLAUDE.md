# Chef — CLAUDE.md (extrait anonymisé, état d'avant les décisions du 2026-10-20)

  Choix des models :
  - **`claude-opus-5`** — le plus capable : conception/architecture.
  - **`claude-opus-4-8`** — défaut du fleet : tâches exigeantes standard.
  - **`claude-sonnet-5`** — équilibré : implémentation courante.

## Routage

  > - **Ton propre tour EST un pipeline Routage** (en service depuis 0.56.0,
  >   `pipeline-enforce.mjs on --chef`).
