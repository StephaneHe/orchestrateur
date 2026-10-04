# {{NAME}} — exigences utilisateur

Chaque demande précise de l'utilisateur sur une fonctionnalité est protégée
par un test automatisé de la suite de non-régression, rejoué à chaque
évolution (règle fleet n° 6 du `CLAUDE.md`).

- Une ligne par demande, la plus récente en bas. On n'en retire jamais.
- **Demande** : les mots de l'utilisateur, entre guillemets (verbatim).
- **Test** : fichier et nom du test qui la vérifie. « à écrire » n'est
  admis que le temps du tour en cours.
- Un test listé ici ne se supprime ni ne s'affaiblit sans l'accord explicite
  de l'utilisateur.

Suite de non-régression : *(commande exacte, par exemple `npm test`)*

| Date | Demande (verbatim) | Test associé | Depuis |
|------|--------------------|--------------|--------|
| {{DATE}} | *(exemple — à remplacer)* « la lecture d'un chapitre se fait en une seule image » | `tests/reader.test.js` › « un chapitre = une image » | v1.0.0 |
