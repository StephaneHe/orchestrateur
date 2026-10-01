# {{NAME}}

*(Une ligne : ce que fait ce projet.)*

- **Version** : `1.0.0`
- **Créé le** : {{DATE}}
- **Constitution** : [`docs/CONSTITUTION.md`](docs/CONSTITUTION.md)
- **Spec courante** : [`docs/SPEC.md`](docs/SPEC.md)
- **Changelog** : [`CHANGELOG.md`](CHANGELOG.md)

---

## Où vit le numéro de version

Règle fleet : **la version doit être visible dans l'artefact livré** et
incrémentée à chaque release (`patch` = fix, `minor` = feature, `major` =
breaking). Départ à `1.0.0`.

L'emplacement dépend de la stack — garde **une seule** source de vérité et
supprime les lignes non pertinentes ci-dessous :

| Stack | Source de vérité | Affichage exigé |
| ----- | ---------------- | --------------- |
| **Android** | `app/build.gradle.kts` → `versionName` (semver) **+** `versionCode` (entier, **+1 strict** à chaque build poussé) | `BuildConfig.VERSION_NAME` rendu dans l'UI (header ou écran « À propos ») |
| **Node.js** | `package.json` → `version` | Exposé par l'app (endpoint `/api/version`, footer, ou `--version` en CLI) |
| **Python** | `<package>/__init__.py` → `__version__ = "1.0.0"` | `--version` en CLI, ou endpoint/`About` si service |
| **Web statique** | `package.json` → `version` | Footer de la page |

> Un `versionCode` Android qui n'est pas strictement incrémenté fait
> échouer l'installation par-dessus la build précédente. Ne jamais le
> réutiliser ni le décrémenter.

---

## Installation

```
# à compléter
```

## Utilisation

```
# à compléter
```

## Configuration

Variables d'environnement attendues (à documenter ici au fur et à mesure) :

| Variable | Requis | Description |
| -------- | ------ | ----------- |
|          |        |             |

> **Secrets** : jamais commités. Utilise un `.env` gitignoré ; ce tableau
> documente les noms de variables, **jamais leurs valeurs**.

---

## Développement

- Le travail se fait **dans ce dossier** (voir `CLAUDE.md`).
- Commit à chaque milestone ; `git push` uniquement sur demande explicite.
- Avant toute grosse feature : remplir `docs/SPEC.md`.
- Definition of Done : voir `docs/CONSTITUTION.md`.
