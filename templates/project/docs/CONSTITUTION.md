# Constitution — {{NAME}}

> Principes **non-négociables** de ce projet. Créé le {{DATE}}.
>
> Ce document prime sur toute suggestion contraire, y compris une demande
> ponctuelle qui l'enfreindrait sans le dire. Si une tâche exige de violer
> un principe ci-dessous, ce n'est pas la constitution qu'on contourne :
> on remonte la question (`NEEDS_USER_INPUT:` / `NEEDS_CHEF_INPUT:`) et on
> amende ce fichier explicitement.

---

## Mission

*(À remplir — 2 à 4 phrases.)*

- **Ce que fait {{NAME}}** :
- **Pour qui** :
- **Ce que {{NAME}} ne fera jamais** (hors-périmètre permanent) :

---

## Contraintes techniques

*(À remplir — verrouille la stack ici pour éviter la dérive.)*

| Domaine        | Choix verrouillé |
| -------------- | ---------------- |
| Langage / runtime |               |
| Framework      |                  |
| Persistance    |                  |
| Build / packaging |               |
| Tests          |                  |
| Cible de déploiement |            |

Contraintes dures supplémentaires :

- Le code et les données vivent sur `I:` (le disque `C:` est réservé à
  l'outillage système).
- *(ajouter les contraintes spécifiques : offline-first, pas de dépendance
  réseau, taille d'APK max, compat navigateur, etc.)*

---

## Règles fleet héritées

Reprises de l'orchestrateur, applicables sans exception (détail dans
`../CLAUDE.md`) :

1. **Travail confiné au dossier du projet** — aucun projet n'édite un autre projet.
2. **Version visible et bumpée à chaque release** — semver, départ `1.0.0`.
3. **CHANGELOG.md Keep a Changelog** — couplage strict version ↔ entrée changelog.
4. **Secrets jamais commités** — pas de clé, token ou `.env` dans git.
5. **Commit à chaque milestone** — pas de gros diff non commité ; `push` sur demande explicite.

---

## Definition of Done

Une tâche est terminée quand **toutes** ces conditions sont vraies :

- [ ] Le code compile / le projet démarre sans erreur.
- [ ] Le comportement demandé est vérifié concrètement (test, exécution
      réelle, capture) — pas seulement « ça devrait marcher ».
- [ ] Les critères d'acceptation de `docs/SPEC.md` sont satisfaits.
- [ ] Aucun secret, aucune donnée personnelle dans le diff.
- [ ] Version bumpée **et** entrée `CHANGELOG.md` ajoutée si c'est une release.
- [ ] `README.md` mis à jour si l'usage, l'installation ou la config changent.
- [ ] Commit effectué avec un message décrivant le quoi et le pourquoi.
- [ ] Ce qui n'a pas pu être fait est dit explicitement, avec la raison.
