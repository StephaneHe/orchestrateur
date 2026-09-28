# Vue « Projets » : synthèse et conception retenue (Opus 5.5)

Demande utilisateur (verbatim) : « Orchestrateur, web interface : je veux voir
en un coup d'œil le statut de chacun des projets. Demande à Fable puis OpenAI
Astra 6, puis Opus 5.5 fera le meilleur des 2, en corrigeant ou ajoutant ce
qu'il faut. »

Sources : `fable-5-1.md` (Claude Fable 5.1) et `gpt-6-astra.md` (OpenAI GPT-6
Astra). Ce document dit ce que je garde de chacun, ce que je corrige, ce que
j'ajoute, puis la conception implémentée en 0.29.0.

## 0. Point de retour (posé AVANT toute modification)

| Élément | Valeur |
|---|---|
| Tag annoté | `pre-status-view-v0.28.0` |
| Commit | `17c0899` (« docs: propose independent Astra project status dashboard ») |
| Version serveur à ce point | `0.28.0` |

La procédure de retour arrière complète est au §6.

---

## 1. Ce que je retiens de Fable 5.1

- **Un niveau routé `#/projets` dans la salle**, pas une page à part ni une
  modale. La vue réutilise les réducteurs, le SSE, le snapshot et `openMusician`,
  et reste ouverte en permanence sans rien dupliquer.
- **Tuiles compactes en grille** (`auto-fill, minmax(…)`), deux lignes :
  « où en est-il » (glyphe + mot + ligne) et « depuis quand » (âge). Sur un
  écran de bureau, les 32 projets tiennent presque sans défilement. Un tableau
  (Astra) en montre une douzaine.
- **Troisième ligne « détails »** optionnelle et mémorisée : version, APK,
  coût et durée du dernier tour.
- **Zéro poll en plus**. Le SSE donne l'état à la milliseconde, le snapshot
  `/api/pupitre` (5 s, onglet visible) la santé et les nouveaux champs, le
  ticker 1 s les âges.
- **Un seul endpoint enrichi de façon additive** (`/api/pupitre`), mis en
  cache. Les nouveaux champs du cœur (`lastActivityAt`, `lastTurn`, `mission`,
  `callbackTo`) vivent dans `scanProject` : le CLI `fleet-status` en hérite.
- **Réordonnancement stable** (règle du rail) : un changement de section est
  immédiat, une permutation dans une section attend 1,5 s, jamais sous le
  pointeur. Le DOM est patché par `data-name`, pas reconstruit.
- Ses pièges, tous repris : parqués affichés « prêt », somme naïve de
  `total_cost_usd`, `git describe` ou spawn à chaque poll (le watchdog tuerait
  le serveur), result fantôme pris pour une fin de tour, question cachée
  derrière un compteur, couleur seule.

## 2. Ce que je retiens d'Astra (GPT-6)

- **Groupes disjoints** : chaque projet apparaît une seule fois.
  `awaitingChef` (« attend le chef ») et « en file » vont dans **Actifs et en
  attente**, pas dans « À votre attention ». Ce n'est pas à l'utilisateur de
  répondre, c'est au chef ou à la file.
- **Le parcage est un attribut, pas un état.** Un parqué qui travaille, pose
  une question ou échoue remonte dans le groupe correspondant, avec son badge
  PARQUÉ. On ne le déparque jamais automatiquement.
- **« Tous » veut dire tous** : aucun groupe replié au premier affichage,
  parqués compris (repli manuel, mémorisé). Le **chef** a sa tuile, avec le
  badge CHEF.
- **Métadonnées honnêtes** :
  - « code v1.4.2 » est la version **source**, jamais présentée comme celle de
    l'APK ;
  - « APK copié il y a 3 h » vient du mtime de `latest.apk` ;
  - le coût est un « coût rapporté » du dernier result, jamais un total 24 h ;
  - un coût absent s'affiche « non fourni », pas « 0 $ ».
- **Le non-lu vient du marqueur de lecture** : `deriveState` du cœur ne le
  connaît pas. La vue prend donc l'état du réducteur client (`Musician`),
  hydraté par `/api/config` qui applique `readAt`. C'est déjà ce que fait le
  rail.
- **Accessibilité** :
  - l'état est dit par un glyphe **et** un mot visible ;
  - zone `aria-live="polite"` pour annoncer une nouvelle question (pas chaque
    seconde) ;
  - cibles tactiles de 44 px ;
  - focus visible ;
  - aucun déplacement pendant que le focus ou le pointeur est dans la grille.
- La liste de recette des cas limites : parqué actif, question acquittée,
  fantôme, `awaitingChef` ≠ « votre réponse », file sans tour, PID inconnu ≠
  mort. Elle est reprise dans les tests (§5).

## 3. Ce que je corrige

| Source | Affirmation | Correction |
|---|---|---|
| Fable §1 | « 32 projets : 1 chef, 19 actifs, 12 parqués » | `config.json` : 32 entrées, **13 parquées** (Astra a raison). |
| Fable §4.3 | libellé d'état « au survol/lecteur d'écran » | Le **mot** est visible sur la tuile. Au survol seulement, c'est de la couleur + glyphe, insuffisant. |
| Fable §4.1 | remplacer le bouton « Musiciens / chercher » par la pill Projets | Refusé : régression sur la recherche. La pill **s'ajoute** au bouton, qui reste. |
| Fable §4.2 | barre « 4,80 $ dernière heure » | Retiré. Fable dit lui-même que `total_cost_usd` ne se somme pas (piège n° 3). Seul le coût rapporté du dernier tour est montré. |
| Fable §4.2 | « attend le chef » dans « À votre attention » | Déplacé dans « Actifs et en attente » (Astra). |
| Fable §4.2 | parqués repliés par défaut | Ouverts par défaut, pour que « chacun » soit visible. Repli mémorisé. |
| Fable §5 | boutons d'action sur les tuiles, appui long mobile | Reporté. Les actions restent dans le volet et la bande d'attention, déjà testées. Un clic de consultation ne déclenche rien (Astra). |
| Astra §4 | ordre dans Attention : perdu > échec > question > stall | Aligné sur la bande d'attention existante (question > perdu > échec > sans progrès) : une seule règle pour toutes les surfaces. |
| Astra §4 | tableau à colonnes sur desktop | Grille de tuiles : plus dense et lisible à 5 colonnes. Le tableau de santé reste `/pupitre`. |
| Astra §1 | vue sélectionnée à la première visite | Non : l'entrée de la salle ne change pas, ce qui garantit la non-régression du fil. La pill « Projets » avec ses compteurs est visible sur tous les écrans, et le dernier niveau ouvert est mémorisé. |
| Astra §6 | nouvel événement SSE `project_status` nommé, révisions, génération, suppression du poll 5 s, contrôle serveur 5 s | Reporté (lot à part). Cela change le transport de **tout** le dashboard, soit le risque de régression le plus élevé, pour un gain faible : le SSE existant donne déjà l'état en moins d'une seconde, et le snapshot 5 s la santé. |
| Astra §6 | manifeste de build, agrégat de coût 24 h | Reporté. Sans manifeste, « APK copié il y a » est dit comme tel, sans version d'APK. |
| Astra §3 | ne pas montrer la commande brute d'un outil | La ligne réutilise l'aperçu `activity` déjà affiché par le rail et `/pupitre`, derrière le même token gate, borné à 80 car. Pas de nouvelle exposition. |
| Les deux | `/api/pupitre` renvoie `state:'idle'` pour les parqués | Corrigé côté serveur. Les parqués sont scannés avec un cache de 60 s (au lieu de 2,5 s). L'état réel est renvoyé, `stalled`/`deadInFlight` restent `false` (santé non suivie) et `healthTracked: false` est ajouté. |

## 4. Ce que j'ajoute

1. **Désactivation sans redéploiement** (exigence C) :
   - `config.json` → `"ui": { "projectsView": false }` : la clé est relue à
     chaud, un signal `fleet_config_changed` est poussé, et les dashboards
     ouverts masquent la vue sans rechargement ;
   - ou, côté navigateur seul, `?projets=0` (mémorisé dans `localStorage`,
     `?projets=1` pour rétablir).

   Défaut : activée.
2. **Aucune I/O synchrone sur `I:\Dev` dans une route.** Versions et APK sont
   rafraîchis en tâche de fond, en asynchrone (`fs.promises`), au plus une fois
   par 60 s par projet, sur une liste **fixe** de fichiers (jamais récursive) :
   - entrée `downloads.json` du projet ;
   - sinon `package.json`, `app/build.gradle.kts`,
     `android/app/build.gradle.kts`, `pyproject.toml`.

   `/api/pupitre` ne lit que le cache mémoire. Mémoire projet : un serveur
   lent sur le disque USB se fait tuer par le watchdog.
3. **Batterie de non-régression unique** : `scripts/regression.mjs`.
   - Suites node existantes plus une nouvelle suite (`_test_projects_view.mjs`).
   - Une **instance de test isolée**, construite depuis n'importe quel ref git
     (tag ou arbre de travail) dans `.regress/`, sur un port libre, avec une
     flotte de fixtures, `CLAUDE_BIN` → `tests/fake_claude`, et `7777` réécrit
     dans les scripts copiés. La production n'est jamais contactée.
   - Les parcours HTTP et navigateur (Playwright + Edge) portent sur **tout**
     le dashboard.
   - Sortie JSON, comparaison avant/après, code de sortie non nul au moindre
     échec.
4. **Le test préexistant `_test_queue_sidecar_sweep` était rouge sur le tag.**
   Son harnais était périmé depuis 0.24.0 : `newQueueEntryId` manquait dans le
   bac à sable. Il est corrigé ; le serveur n'était pas en cause.

## 5. Conception finale (implémentée en 0.29.0)

### Entrée et navigation

- Une pill **« ▦ Projets »** dans la topbar porte des compteurs toujours
  visibles, par exemple « ⚠ 2 · ● 3 ». Autres entrées : l'item du menu ⋮, la
  touche `g` puis `p`, et le lien direct `#/projets`.
- La vue remplace le fil et le rail (`main-row`). La topbar, le bandeau
  système, la bande d'attention et la file de direction restent.
- Un clic sur une tuile ouvre le volet `#/m/<nom>`. « ‹ Retour » ou Échap
  revient à `#/projets` (pile d'historique réelle).
- Échap, depuis la vue, ramène au fil. Le dernier niveau (fil ou projets) est
  mémorisé.

### Groupes disjoints, ordre imposé

1. **À votre attention** : question ouverte > processus perdu > échec > sans
   progrès.
2. **Actifs et en attente** : en cours ou réflexion, attend le chef, en file
   (`queueDepth > 0` sans tour en vol).
3. **Au repos** : terminé non lu d'abord, puis prêt ; tri par dernière
   activité, la plus récente d'abord.
4. **Parqués** : parqués sans activité ni alerte ; ouverts par défaut, repli
   mémorisé.

Le chef suit les mêmes règles et porte le badge CHEF.

### Tuile

```
▌ ?  BookHaven   Votre réponse            ⏳2  CHEF  PARQUÉ  opus-5.5
▌    Déployer en prod ?                                        12m04
▌    code v1.4.2 · APK copié il y a 3 h · dernier tour 33s · 2,40 $   (détails)
```

- Bordure gauche de 3 px + glyphe + **mot** : l'état ne repose jamais sur la
  couleur seule.
- Ligne affichée, dans cet ordre de priorité :
  1. question ouverte ;
  2. cause d'échec ;
  3. activité en cours ;
  4. mission (premier `user_prompt` du tour) ;
  5. dernier résultat ;
  6. « ✓ question marquée répondue — note ».
- L'âge, selon le cas :
  - en vol : durée du tour, extrapolée à la seconde ;
  - sans progrès : silence ;
  - au repos : depuis la dernière activité ;
  - rien d'observé : « jamais observé ».
- Chips : file, `⇄ chef` (rapport promis), model (servi, sinon « prévu : »),
  CHEF, PARQUÉ.
- La tuile est un `<button>` dont l'`aria-label` complet reprend nom, état,
  ligne, âge, file et parcage.

### Barre de la vue

- Retour au fil.
- Filtre texte (nom + ligne ; `/` le focalise).
- Compteurs-boutons : Tous, Attention, Actifs, Repos, Parqués. Un clic isole
  un groupe, un second clic annule.
- Case « détails ».
- Fraîcheur du snapshot : « synchronisé il y a 3 s », ou « données anciennes »
  au-delà de 15 s, âges alors grisés.

### Données (additives, `/api/pupitre`)

- Par ligne :

  | Champ | Contenu |
  |---|---|
  | `lastActivityAt` | ms |
  | `lastTurn` | `{endedAt, durationMs, costUsd, isError, subtype, synthetic}` |
  | `mission` | premier `user_prompt` du tour |
  | `callbackTo` | destinataire du rapport promis |
  | `healthTracked` | `false` pour un parqué |
  | `version` | `{value, source}` ou `null` |
  | `build` | `{apkAt}` ou `null` |

- Les parqués sont scannés (cache de 60 s), sans santé.
- Au niveau flotte : `ui.projectsView`. `/api/config` expose aussi `ui`.

### Mobile (< 768 px)

- Une colonne ; tuiles d'au moins 56 px.
- Pas de chip model ni de ligne « détails ».
- Compteurs sur deux lignes, aucun défilement horizontal.

## 6. Retour arrière

- **Sans redéploiement** (la vue seule) :
  - mettre `"ui": { "projectsView": false }` dans `config.json` : la vue
    disparaît des dashboards ouverts en ~3 s, et `#/projets` renvoie au fil ;
  - ou ouvrir `/?projets=0`, pour ce navigateur seulement.
- **Retour complet au code d'avant** (serveur + client), exécuté par le chef :

  ```
  git -C I:\orchestrateur revert --no-edit <commit 0.29.0>   # ou :
  git -C I:\orchestrateur checkout pre-status-view-v0.28.0 -- server.js public scripts/fleet-status-core.mjs package.json
  node I:\orchestrateur\scripts\restart-orchestrateur.mjs
  node I:\orchestrateur\scripts\regression.mjs              # la batterie doit repasser au vert
  ```

  Les deux voies ont été rejouées sur l'instance de test. Le code du tag
  donne 48 OK · 1 KO préexistant. Un `git revert` du commit 0.29.0 (`7b80962`)
  dans un worktree jetable, redémarré par `restart-orchestrateur.mjs`, donne
  un résultat **identique au tag**, sans aucune régression. Détail dans
  `NON-REGRESSION.md`.
- **Attention, dette constatée** : `server.js` importe `./ssh-server.js` et
  `./src/message_router.mjs`, qui **ne sont pas versionnés**. Un checkout
  propre du tag sur une autre machine ne démarrerait pas. Sur cette machine,
  ils restent en place (non suivis), donc le rollback fonctionne. Les
  versionner est une décision à prendre à part.

## 7. Ce qui reste (hors 0.29.0)

- Événement SSE agrégé `project_status` avec révisions, et retrait du poll 5 s
  (Astra §6).
- Manifeste de build publié par `copy-build.mjs` (version d'APK vérifiée).
- Coût agrégé fiable (24 h glissantes, par session).
- Actions contextuelles sur les tuiles, appui long mobile (Fable §5).
- Versionner `ssh-server.js` et `src/` (dette de rollback, §6).
