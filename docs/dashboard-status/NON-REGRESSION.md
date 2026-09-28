# Non-régression — vue « Projets » (0.29.0)

Rejouable : `node scripts/regression.mjs` (voir `CLAUDE.md`, section
« Non-régression »). Chaque ligne ci-dessous est un test automatisé : une
suite node, un parcours HTTP ou un parcours navigateur. Tous tournent sur une
**instance de test isolée** (port libre, 14 projets de fixtures, faux
`claude`). La production (7777) n'est jamais touchée.

- **Avant** : `node scripts/regression.mjs --ref pre-status-view-v0.28.0`
  (tag de retour, commit `17c0899`, v0.28.0).
- **Après** : `node scripts/regression.mjs` (arbre de travail, v0.29.0).
- Statuts : **OK** ; **KO** ; **NA** = fonction absente de cet état du code,
  ou volontairement non exécutée (motif en clair).

## Résultat

| | OK | KO | NA |
|---|---|---|---|
| Avant (tag `pre-status-view-v0.28.0`) | 48 | 1 | 17 |
| Après (0.29.0) | 64 | 0 | 3 |
| **Régressions (OK → autre)** | **0** | | |

- Le seul KO « avant », `_test_queue_sidecar_sweep`, est un **harnais de test
  périmé depuis 0.24.0**, pas un défaut du serveur. Corrigé en 0.29.0.
- Les 17 NA « avant » sont les parcours de la vue Projets (absente du tag) et
  les exclusions volontaires.
- NA « après », motifs :
  - `_test_phase2*` : écrivent dans les vrais `logs/` ;
  - WebSocket sans jeton : le gate est désactivé dans `server.js`, et
    ouvrir `/ws/pty` lancerait un vrai `claude.exe`.

## Tableau détaillé

| Étage | Fonctionnalité | Avant (pre-status-view-v0.28.0) | Après (worktree) | Écart |
|---|---|---|---|---|
| suite | _test_downloads_hot.mjs | OK | OK |  |
| suite | _test_explicit_model.mjs | OK | OK |  |
| suite | _test_phase1_backpressure.mjs | OK | OK |  |
| suite | _test_phase1_close_handler.mjs | OK | OK |  |
| suite | _test_phase1_crlf.mjs | OK | OK |  |
| suite | _test_phase1_queue_persist.mjs | OK | OK |  |
| suite | _test_phase2.mjs (exclue : écrit dans les vrais logs/ (router-*.ndjson) et dépend du classifieur) | NA | NA |  |
| suite | _test_phase2_5_override.mjs (exclue : écrit dans les vrais logs/ (router-*.ndjson)) | NA | NA |  |
| suite | _test_phase4b_harness.mjs | OK | OK |  |
| suite | _test_pool_chef_dispatch.mjs | OK | OK |  |
| suite | _test_pool_p0a.mjs | OK | OK |  |
| suite | _test_projects_view.mjs | NA | OK | corrigé / nouveau |
| suite | _test_queue_api.mjs | OK | OK |  |
| suite | _test_queue_sidecar_sweep.mjs | KO | OK | corrigé / nouveau |
| suite | _test_tools_resolution.mjs | OK | OK |  |
| suite | _test_wake_report_only.mjs | OK | OK |  |
| http | Démarrage de server.js sur une instance isolée | OK | OK |  |
| http | Token gate (contrat de server.js) : jeton par en-tête, paramètre, cookie ; 401 sans jeton si activé | OK | OK |  |
| http | /api/version = version de package.json | OK | OK |  |
| http | /api/config : flotte, états hydratés, parcage, lecture | OK | OK |  |
| http | /api/pupitre : santé (stall, processus perdu, PID vivant), file, pool | OK | OK |  |
| http | /api/pupitre : champs de la vue Projets (dernier tour, mission, version, APK, parqués réels) | NA | OK | corrigé / nouveau |
| http | Page /pupitre et /healthz | OK | OK |  |
| http | File par musicien : mise en file si occupé, GET, DELETE d'une entrée | OK | OK |  |
| http | Question acquittée sans relancer (200 puis 409), événement dans le log | OK | OK |  |
| http | Marquer lu (/api/mark-read) persiste le marqueur | OK | OK |  |
| http | Mettre de côté / remettre en avant (config.json) | OK | OK |  |
| http | Flux temps réel /api/sse/fleet : une ligne de log arrive au client | OK | OK |  |
| http | /api/notify écrit dans le log du chef | OK | OK |  |
| http | Pièce jointe : envoi image puis service /attachments | OK | OK |  |
| http | /downloads : carte, APK, rechargement à chaud de downloads.json | OK | OK |  |
| http | WebSocket /ws/pty refusé sans jeton | NA | NA |  |
| http | Dispatch avec --callback chef : tour du musicien, notification au chef, réveil du chef | OK | OK |  |
| navigateur | Lancement du navigateur (Edge headless) | OK | OK |  |
| navigateur | Chargement du dashboard avec jeton, version du serveur au pied de page | OK | OK |  |
| navigateur | Topbar : flux temps réel « synchronisé » | OK | OK |  |
| navigateur | Fil du chef : historique rechargé | OK | OK |  |
| navigateur | Rail PILOTAGE : groupes En cours / À examiner, dépliage « Tous » | OK | OK |  |
| navigateur | Bande d'attention : compteurs, dépliage, question visible | OK | OK |  |
| navigateur | « ✓ Marquer comme répondue » : la question quitte l'attention, le serveur l'enregistre | OK | OK |  |
| navigateur | Volet musicien : ouverture depuis le rail, onglets, retour | OK | OK |  |
| navigateur | File du musicien dans le volet + « Retirer » | OK | OK |  |
| navigateur | Annuaire / recherche : filtrer puis Entrée ouvre le volet | OK | OK |  |
| navigateur | En-tête chef : ouvre le pupitre du chef | OK | OK |  |
| navigateur | Menu ⋮ → Briefing de l'orchestre | OK | OK |  |
| navigateur | Barre de saisie → chef : bulle utilisateur puis réponse du chef | OK | OK |  |
| navigateur | File de direction : 2e message en attente, bande visible, « Retirer » rend le brouillon | OK | OK |  |
| navigateur | Pièce jointe : image choisie → vignette → envoi au chef | OK | OK |  |
| navigateur | Temps réel : un tour lancé par l'API change l'état côté client sans rechargement | OK | OK |  |
| navigateur | Projets · pill de la topbar avec compteurs | NA | OK | corrigé / nouveau |
| navigateur | Projets · ouverture : remplace fil + rail | NA | OK | corrigé / nouveau |
| navigateur | Projets · groupes disjoints, chaque projet une fois, ordre d'attention | NA | OK | corrigé / nouveau |
| navigateur | Projets · tuiles : sorte, mot d'état visible, badges, chips, aria-label | NA | OK | corrigé / nouveau |
| navigateur | Projets · filtre texte | NA | OK | corrigé / nouveau |
| navigateur | Projets · compteur « Attention » isole le groupe, second clic annule | NA | OK | corrigé / nouveau |
| navigateur | Projets · détails : version source, APK, dernier tour | NA | OK | corrigé / nouveau |
| navigateur | Projets · clic sur une tuile → volet → retour à la vue | NA | OK | corrigé / nouveau |
| navigateur | Projets · clavier : flèches entre tuiles, Échap → salle, g p → vue | NA | OK | corrigé / nouveau |
| navigateur | Projets · drapeau config.json ui.projectsView=false à chaud puis rétabli (sans rechargement) | NA | OK | corrigé / nouveau |
| navigateur | Projets · paramètre ?projets=0 (ce navigateur) puis ?projets=1 | NA | OK | corrigé / nouveau |
| navigateur | Mobile 390 px : ligne Pilotage → feuille du rail | OK | OK |  |
| navigateur | Projets · mobile : une colonne, aucun défilement horizontal, cibles ≥ 44 px | NA | OK | corrigé / nouveau |
| navigateur | Navigateur sans jeton : contrat du token gate de server.js | OK | OK |  |
| navigateur | Page /downloads (publique) : carte et lien APK | OK | OK |  |
| navigateur | Captures desktop + mobile (docs/dashboard-status/captures/{avant,apres}) | OK | OK |  |
| navigateur | Aucune erreur JavaScript non interceptée pendant les parcours | OK | OK |  |
| http | restart-orchestrateur.mjs (copie de l'instance) redémarre le serveur | — | OK | non exécuté d'un côté |

Avant : 48 OK · 1 KO · 17 NA — Après : 64 OK · 0 KO · 3 NA — Régressions : 0

## Retour arrière — testé

| Voie | Commande | Vérification sur l'instance de test | Résultat |
|---|---|---|---|
| Désactivation à chaud (vue seule) | `config.json` → `"ui": {"projectsView": false}` | pill retirée des dashboards ouverts, `#/projets` renvoyé au fil, puis rétablie, sans rechargement | OK (parcours « drapeau … à chaud ») |
| Désactivation navigateur | `/?projets=0`, `/?projets=1` | pill masquée puis rétablie | OK (parcours « paramètre ?projets=0 ») |
| Retour au code du tag | `git checkout pre-status-view-v0.28.0 -- …` | batterie complète sur le code du tag (= colonne « Avant ») | 48 OK · 1 KO préexistant |
| `git revert` du commit 0.29.0 | worktree jetable + `git revert --no-commit 7b80962` + `regression.mjs --dir … --restart-check` | batterie complète, redémarrage par `restart-orchestrateur.mjs` (copie de l'instance) | 48 OK · 1 KO préexistant · 17 NA : **identique au tag**, 0 régression ; serveur redémarré en v0.28.0 |
| Redémarrage après modification | `restart-orchestrateur.mjs` (copie de l'instance, port réécrit puis vérifié) | l'instance 0.29.0 repart et sert `/api/version` | OK |

En production, le retour arrière est exécuté par le chef :

    git -C I:\orchestrateur revert --no-edit <commit 0.29.0>
    node I:\orchestrateur\scripts\restart-orchestrateur.mjs
    node I:\orchestrateur\scripts\regression.mjs

## Captures (instance de test, Edge headless)

- Avant : `captures/avant/salle-desktop.png`, `captures/avant/salle-mobile.png`.
- Après :
  - `captures/apres/salle-desktop.png`, `captures/apres/salle-mobile.png` :
    la salle, inchangée hormis la pill ;
  - `captures/apres/projets-desktop.png`,
    `captures/apres/projets-desktop-details.png` ;
  - `captures/apres/projets-mobile.png`,
    `captures/apres/projets-mobile-long.png`.

## Constat hors périmètre (non modifié)

Le token gate est **désactivé** dans `server.js`
(`TOKEN_GATE_ENABLED = false`, commit `3bc33bc`, décision utilisateur du
2026-09-07). L'allowlist d'interface est commentée (2026-05-13). Le serveur,
qui écoute sur `0.0.0.0:7777`, accepte donc toute requête du LAN sans jeton,
`/api/dispatch` compris. Cela contredit la règle dure « Token gate is
mandatory » du `CLAUDE.md`. Le comportement est identique avant et après
0.29.0 ; la batterie le signale à chaque passage.
