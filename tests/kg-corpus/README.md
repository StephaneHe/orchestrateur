# Corpus de l'index de connaissances (phase 0 b)

Vrais cas relevés par les études KG du 2026-10-20 (docs/KG-SYNTHESE.md §1),
**anonymisés** (dépôt public) : `boxapp` = le service migré de WSL vers
Windows, `shelfapp` / `basketapp` = services dits « WSL » mais servis sous
Windows, `liveapp` = le projet hors pipelines.

- `before/` : l'état d'avant les décisions 1, 2 et 4 de l'utilisateur — les
  contradictions C1 (règle des models), C2 (17 / 38 projets), C3 (boxapp WSL /
  Windows) et C4 (Routage du chef « en service » alors que coupé) doivent
  toutes sortir.
- `after/` : construit par la suite à partir de `before/`, avec les
  corrections du chef ; seule C3 reste (décision 3 en attente).

Les exécutions passées sont dans `before/runs-fixture.json` ; `fixture.mjs` les
range en `runs/<run>/run.json` dans une copie temporaire.

Ce que vérifient `scripts/_test_kg_replay.mjs` (et `_test_kg_core`, `_test_kg_queries`) : voir leur en-tête.
