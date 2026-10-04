# {{NAME}} — CLAUDE.md

> Fichier chargé automatiquement par le musicien `{{NAME}}` au démarrage de
> chaque tour. Pas de slash command, pas d'invocation manuelle : ces
> instructions sont toujours actives.

---

## Rôle du projet

**{{NAME}} — …**  ← *(remplir en une ligne : ce que fait ce projet, pour qui)*

Contexte long et décisions d'architecture : `docs/CONSTITUTION.md`.
Spécification de la feature en cours : `docs/SPEC.md`.

---

## Règles fleet héritées (non-négociables)

Ces règles viennent de l'orchestrateur et s'appliquent à **tout** projet du fleet.

**1 — Le travail se fait DANS ce dossier.**
Toute création/édition de fichier reste sous la racine de ce projet. Ne
modifie jamais un autre projet du fleet ni le code de l'orchestrateur : si
tu as besoin d'un changement ailleurs, remonte la demande au chef
(`NEEDS_CHEF_INPUT: …`).

**2 — Version visible, bumpée à chaque release.**
Ce projet expose un numéro de version dans son artefact final (voir
`README.md` pour l'emplacement exact selon la stack). Toute release doit
l'incrémenter : `patch` (fix), `minor` (feature), `major` (breaking change).
Démarrage à `1.0.0`.

**3 — CHANGELOG.md tenu à jour.**
Format [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Sections :
`Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`.
En-tête d'entrée : `## [X.Y.Z] - YYYY-MM-DD`.
**Couplage strict** : aucune release sans bump de version **ET** entrée
changelog correspondante.

**4 — Secrets jamais commités.**
Aucune clé d'API, aucun token, aucun mot de passe, aucun `.env` dans git.
Utilise un `.env` gitignoré et documente les variables attendues dans le
`README.md`. Si tu découvres un secret déjà commité, signale-le
immédiatement (`NEEDS_USER_INPUT: …`) — ne le supprime pas silencieusement.

**5 — Commit à chaque milestone.**
Un commit par unité de travail cohérente et testée, message à l'impératif
décrivant le *quoi* et le *pourquoi*. Ne laisse pas s'accumuler un gros
diff non commité. Ne pousse (`git push`) que sur demande explicite.

**6 — Toute demande utilisateur devient un test de non-régression.**
Dès que l'utilisateur fait une demande précise sur une fonctionnalité
(comportement voulu, réglage, correction signalée), ajoute un **test
automatisé** à la suite de non-régression du projet et trace-le dans
`docs/USER_REQUIREMENTS.md` (date, demande verbatim, test associé).
- Rejoue toute la suite **avant** chaque modification, puis **après**.
- Un test d'exigence utilisateur ne se supprime ni ne s'affaiblit sans
  l'accord explicite de l'utilisateur (`NEEDS_USER_INPUT: …`).
- Exemple : « la lecture d'un chapitre se fait en une seule image » → un
  test qui ouvre un chapitre et vérifie qu'une seule image est affichée,
  rejoué à chaque évolution.

---

## Definition of Done

Une tâche n'est terminée que si **toutes** ces cases sont cochées — voir
`docs/CONSTITUTION.md` pour la liste faisant foi.

---

## Question protocol

- `NEEDS_USER_INPUT: <question>` — préférence perso, autorisation d'une
  action irréversible, choix sans meilleure option objective, credentials,
  incident à signaler.
- `NEEDS_CHEF_INPUT: <question>` — décision d'architecture transverse,
  coordination avec un autre projet, politique fleet, synthèse
  cross-projet.

Dans le doute : **user**. Le chef est un délégué, l'utilisateur est
l'autorité finale.
