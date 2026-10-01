# Contre-expertise refonte Orchestrateur — Anthropic Fable — 2026-09-19

Arbitrage indépendant de `docs/orchestrateur-redesign-astra.md` (GPT-6 Astra). Lecture seule : aucun code, version ou config modifié, serveur 7777 non redémarré. Seule écriture : ce fichier.

**Méthode et limites.** J'ai relu dans l'arbre de travail chaque zone que je cite ci-dessous (numéros de ligne vérifiés par moi). Je n'ai **pas** rejoué les reproductions en mémoire d'Astra, ni fait de capture visuelle : les jugements de lisibilité reposent sur le DOM/CSS. Deux GET en lecture : `/api/version` et la config. Relevé : 29 projets dont 13 mis de côté, **aucun projet sur un provider non-Claude**, sentinelle `logs/no-failover` active, serveur en mémoire **0.15.1** vs disque **0.16.1**.

## Verdict global

**Les constats d'Astra sont exacts presque partout ; le plan est trois à cinq fois trop gros pour un dashboard mono-utilisateur.** Astra chiffre 10 lots pour ~14 à 25 jours. L'essentiel de la valeur visible — comprendre l'état des musiciens d'un coup d'œil — tient en ~2 jours, dont la moitié sans redémarrage. Le raccourci principal est qu'Astra propose de construire une liste fleet alors qu'elle **existe déjà** : `/pupitre` + `PupitreRow`, déjà chargé dans le dashboard (`public/app.js:2484`).

Deux points ne sont pas dans le rapport d'Astra et changent l'ordre des travaux : un effet de bord de mon propre fix v0.16.1 sur la file `@` (B1), et le coût de `/api/pupitre` qui doit être traité **avant** d'en faire l'écran principal (B2).

## Axe 1 — Affichage des musiciens (priorité)

| ID | Verdict | Preuve vérifiée | Ce que je retiens |
|---|---|---|---|
| A1 | **Faits CONFIRMÉS, remède NUANCÉ** | `public/app.js:467-469` (60 % au chef), `:495` (tri par `freq`). | Remplacer le tri par fréquence par un tri d'attention : oui, P0, et `rank()` existe déjà (`public/pupitre-row.js:45-52`). Inverser chat et fleet comme écran principal : **décision produit qui revient à l'utilisateur**, pas un correctif. Proposer une bascule « vue liste », pas un remplacement. |
| A2 | **CONFIRMÉ** | `app.js:43` « EN COMMUNICATION », `:45` « EN ATTENTE » ; `pupitre-row.js:33-38` en anglais ; `app.js:2783` le briefing ne compte que `input`/`unread`. | Libellés français orientés action + erreurs dans le compteur : P0, quelques lignes. « Non-lu comme badge séparé de l'état » : **NUANCÉ** — `unread` est un état dans 4 reducers + l'app Android. Version bornée : garder la chaîne d'état, changer le libellé en « TERMINÉ · non lu ». |
| A3 | **Code CONFIRMÉ, impact NUANCÉ** | `public/pupitre-detail.js:206` : `if (raw.type === 'assistant') return;` | Bug réel. Mais Astra le note impact 5 sur le scénario Codex : **0 projet non-Claude** et failover coupé par la sentinelle, donc ce scénario n'est pas vivant. Il reste utile pour un détail ouvert en milieu de message ou après un trou SSE. À corriger car peu coûteux ; impact 3. |
| A4 | **CONFIRMÉ** | `pupitre-row.js:30-31` : `stalled` testé avant `deadInFlight` ; `app.js:314` et `:937` seuil 30 s vs 60 s côté core. | Inverser deux lignes. Aligner la carte sur le `stalled` du snapshot quand il est disponible. P0. |
| A5 | **CONFIRMÉ** | `app.js:850` : `onerror` vide ; `:2499-2500` l'échec de poll garde l'ancien snapshot en silence. | Indicateur « connexion perdue / données d'il y a X s » : P0, fort rapport valeur/coût. |
| A6 | **CONFIRMÉ** | `public/pupitre-row.css:46-48` masque activité, PID et modèle sous 720 px. | Deuxième ligne mobile : P1, CSS seul. |
| A7 | **CONFIRMÉ** | `recomputeFromRing` : 2 appels optionnels (`app.js:2444`, `:2601`), **aucune définition** ; `.pf-usage` lu en `:2611`, absent de `index.html`. | L'usage est calculé et jamais affiché. Brancher le dernier tour : P1. Totaux jour/projet et coûts : **gadget** sous abonnement Max. |

**Sur la maquette et les « quatre dimensions ».** La séparation travail / activité / santé / lecture est la bonne grille de lecture, et elle est **réalisable avec les données déjà servies** : `/api/pupitre` renvoie `state`, `stalled`, `deadInFlight`, `activity`, `lastKind`, `turnElapsedMs`, `silentMs`, `pid`, `pidAlive`, `model`, `provider` (`scripts/fleet-status-core.mjs:200-215`). Manquent seulement la profondeur de file et l'état quota/no-failover, deux champs additifs.

Utile : tri d'attention stable, activité + durée + silence sur la carte, PID mort visible, indicateur de fraîcheur, badge no-failover/limité. Gadget à ce stade : les neuf valeurs de « Travail », les dates « exactes / estimées / inconnues » (D3), la durée par outil via `tool_use_id`, le bouton « N nouveaux événements », le gel du tri pendant le survol.

**Contrainte qu'Astra sous-estime :** `CLAUDE.md` verrouille les états de panneau (`idle | live | input | done | error`, « do not deviate ») et l'app Android porte son propre reducer (`Musician.kt`) — c'est un **cinquième** reducer qu'Astra ne compte pas. Toute nouvelle chaîne d'état la casse. D'où : on enrichit par badges, on ne touche pas au vocabulaire d'état.

## Axe 2 — Fonctionnalités

| Proposition | Verdict | Justification |
|---|---|---|
| F1 — mode d'envoi explicite | **Faits CONFIRMÉS, remède NUANCÉ** | `server.js:3085-3094` : `@musicien` occupé → file ; envoi direct → interruption. Un sélecteur de mode à chaque envoi = friction. Version bornée : une ligne d'indice dans le composer (« X est occupé : ce message l'interrompra »). P2. |
| F2 — file fragile | **CONFIRMÉ, et aggravé** | `server.js:393-400` : `shift()` + `persistQueue` **avant** le spawn ; l'erreur de spawn est seulement loguée (`:375`). Voir B1 : c'est devenu un P0. L'interface d'administration de file reste P2. |
| F3 — boîte callbacks, reçu / à traiter / traité, sérialisation des décisions chef | **REJETÉ pour l'essentiel** | Machinerie de processus pour un seul utilisateur. La recherche du marqueur dans 512 Kio est un risque réel mais rare. À garder : « dernier callback à HH:MM » sur la ligne du musicien. P2. |
| F4 — quota / no-failover exposés | **CONFIRMÉ, à remonter** | Deux `fs.existsSync` dans `/api/pupitre` suffisent pour un badge « no-failover actif / limité jusqu'à … ». Très utile pour les runs de nuit. P1. L'alerte « réponse NVIDIA sans outils » est sans objet tant que la sentinelle est active. |
| Stop / retry / continuer | **NUANCÉ** | Stop : oui. « Continuer » = envoyer un message, existe déjà. Retry : risque de rejouer des effets de bord, Astra le dit lui-même → écarté. |
| Historique de tours, recherche, filtres persistants | **P3** | L'API est bornée à 2 Mio ; la valeur solo est faible. |
| Notifications : sourdine, regroupement | **Écarté** | Les toasts existent. Un seul ajout utile : notifier une erreur ou un PID mort. P2. |
| Stockage : taille et croissance affichées | **P3** | Informatif, ne règle rien. |
| Dépendances / pipelines | **Écarté** | Hors besoin exprimé. |

## Axe 3 — Code

| Reco | Verdict | Justification |
|---|---|---|
| C1 / D1 — reducer pur partagé Node + navigateur | **Constat CONFIRMÉ, forme NUANCÉE** | Divergences vérifiées : `server.js:1458`, `:2058`, `fleet-status-core.mjs:86-87`, `app.js:143-155`. Mais le client est en scripts classiques sans bundler, le serveur en ESM : un module isomorphe coûte plus qu'annoncé. Version bornée : fusionner les **3 reducers serveur** dans `deriveState` (Node pur), et faire **réconcilier** les cartes depuis le snapshot `/api/pupitre`. Le reducer client reste pour la réactivité ; le snapshot fait foi. |
| D2 — texte assistant non remis à zéro | **CONFIRMÉ, rare** | `lastAssistantText` survit au `user_prompt` / `init` (`server.js:2053-2059`, `app.js:143-155`). Un reset sur `system/init` : une ligne par reducer. P1. Garder « Limité » visible après `error_limited` : P2. |
| D4 — reconnexion sans réparation des cartes | **CONFIRMÉ** | Même mécanisme que ci-dessus : une fois la réconciliation par snapshot en place, la reconnexion est gratuite. |
| D5 / C3 — lectures non bornées | **CONFIRMÉ** | Identique à mon P1 de `chef-stuck-analysis-validated.md` : `server.js:3710`, route morte `/sse/logs`. Contre-pression `res.write` : **NUANCÉ** — LAN, un ou deux clients ; couper un client dont le tampon dépasse N Mo suffit. Fusionner les deux watchers en un lecteur : refactoring P2, Astra a raison de ne pas en faire un préalable. |
| C2 — clôture après drainage complet de stdout | **NUANCÉ** | Risque plausible, non démontré. P2. D'accord avec Astra : pas de nouvelle taxonomie, on garde le `result` synthétique de v0.16.1. |
| C4 — identifiants de demande, état « en démarrage » persisté, décisions chef dans la même file | **Sur-ingénierie** | À garder : garde anti-double-spawn en mémoire, remise en file si le spawn échoue, pas de drainage sur résultat synthétique. |
| C5 — quota structuré | **P2** | Le badge de F4 couvre le besoin. |
| C6 — cache de `/api/pupitre` | **CONFIRMÉ, mal classé** | Astra le met au lot 9. C'est un **préalable** (B2). |
| C7 — rotation | **CONFIRMÉ P3** | Je **corrige ma position précédente** : j'avais proposé une rotation « hors-ligne au boot ». Astra objecte qu'un boot ne garantit pas l'absence de writer — c'est juste : après un crash, des `dispatch.mjs` enfants peuvent survivre sous Windows. Il faut vérifier le `.pid` de chaque projet avant de toucher à son log. |

**Cohérence avec v0.16.1 :** rien dans le plan d'Astra ne défait le P0. Il le dit explicitement et c'est vérifié.

## Findings ajoutés (angles morts d'Astra)

**B1 — Mon fix P0-c brûle la file `@` pendant une fenêtre limitée.** Le watcher draine la file sur tout `result` dont le nouvel état est `unread`, `idle` ou `error` (`server.js:3731-3735`). Depuis v0.16.1, la garde no-failover écrit un `result` synthétique → état `idle` → `drainQueue` → l'élément suivant est lancé, tombe sur la même garde, produit un nouveau synthétique, et ainsi de suite : **toute la file est consommée en quelques secondes sans qu'aucun travail soit exécuté.** Avant P0-c, l'absence de `result` bloquait la carte mais préservait la file. Astra décrit le mécanisme dans F2 sans voir qu'il vient d'être activé. Portée : uniquement la file du raccourci `@`, sentinelle active + limite atteinte. Correctif : ne pas drainer quand `ev.synthetic` est vrai — une condition dans `server.js`, à embarquer au prochain redémarrage.

**B2 — `/api/pupitre` relit 29 logs en synchrone à chaque requête, dont 13 projets mis de côté** (`server.js:1528-1541`). Aujourd'hui le poll 2,5 s ne tourne que lorsqu'une carte est ouverte (`app.js:2531`). En faire la source permanente des cartes multiplie cette charge, sur un disque USB, avec un watchdog qui tue un serveur seulement lent. Cache par `mtime`+`size` et saut des projets mis de côté **avant** tout poll permanent. En attendant : poll à 5 s, onglet visible uniquement.

**B3 — `server.js` a un diff non committé** (durcissement du boot / `EADDRINUSE`, daté 2026-09-16, pas de moi). À committer séparément avant tout lot serveur pour ne pas mélanger. Par ailleurs les commits entre 0.15.1 et 0.16.1 ne touchent que le client et `dispatch.mjs` : **aucun correctif serveur n'attend un redémarrage** aujourd'hui.

**B4 — L'inversion chat/fleet est un choix d'usage, pas une conclusion technique.** L'interaction principale de l'utilisateur est de parler au chef. À trancher par lui ; la bascule « vue liste » permet d'essayer sans rien casser.

## Sur-ingénierie à écarter (usage solo)

Boîte callbacks à trois états et sérialisation des décisions chef · identifiants de demande et état « en démarrage » persisté · module reducer isomorphe Node/navigateur · dépendances et pipelines · recherche d'historique et archives paginées · totaux de coûts jour/projet · horodatages exacts/estimés/inconnus · durée par outil · stratégie de contre-pression SSE · curseurs de reprise SSE · sourdine et regroupement de notifications · tableau de bord de stockage · neuf valeurs d'état « Travail ».

## PLAN D'ACTION CONSOLIDÉ — minimal d'abord (pour Opus 4.8)

### P0 — affichage, client seul, aucun redémarrage (~1,5 j)

**Lot 1 — rendu exact (`public/pupitre-row.js`, `public/pupitre-detail.js`, `public/app.js`), ~0,5 j**
- « PID MORT » prioritaire sur « STALLED ».
- Libellés français orientés action (« EN COURS », « RÉPONSE REQUISE », « TERMINÉ · non lu ») ; chaînes d'état DOM **inchangées**.
- Le briefing compte aussi erreurs et musiciens bloqués.
- Détail live : afficher l'`assistant` consolidé quand aucun bloc de streaming n'a été rendu pour ce message.
- Indicateur de connexion / fraîcheur des données.
- *Vérif :* harness headless existant — ligne avec `stalled`+`deadInFlight` → « PID MORT » ; `assistant` sans deltas → 1 ajout DOM, avec deltas → pas de doublon ; coupure SSE simulée → bandeau visible ; 0 erreur console.

**Lot 2 — cartes lisibles (`public/app.js`, `public/styles.css`), ~1 j**
- Tri par attention (`PupitreRow.rank`) puis nom, stable ; fin du tri par fréquence.
- Deuxième ligne de carte depuis le snapshot : activité, durée du tour, silence, PID ✗.
- Poll `/api/pupitre` à 5 s, onglet visible seulement, en attendant le cache serveur.
- *Vérif :* 29 projets, une erreur et une question remontent en tête sans ouvrir de carte ; l'ordre ne bouge pas sur une rafale de deltas ; poll suspendu onglet caché.

### P0 serveur — un seul redémarrage, à grouper (~1 j)

**Lot 3 (`server.js`, `scripts/fleet-status-core.mjs`)**
- Committer d'abord le diff de boot en attente (B3).
- Ne pas drainer la file sur `result` synthétique (B1).
- `/api/pupitre` : cache `mtime`+`size`, saut des projets mis de côté ; champs additifs `queueDepth`, `noFailover`, `limitedUntil`.
- Le P1 de `chef-stuck-analysis-validated.md` : reducers ignorent un `user_prompt` sourcé, suppression de `/sse/logs`, watcher borné, `healOrphanedLogs` ignore notifications et callbacks.
- *Vérif :* file de 3 éléments + sentinelle + limite factice dans un dossier de test → file intacte ; deux GET `/api/pupitre` consécutifs sans changement de fichier → aucune relecture ; `/sse/logs/x` → 404.

### P1 (~2 j)
Bascule « vue liste » réutilisant `PupitreRow` dans le volet droit · séparateur chat/fleet redimensionnable et mémorisé · usage du dernier tour dans le détail · deuxième ligne mobile · reset du texte assistant sur `system/init` · réconciliation des cartes depuis le snapshot à la reconnexion · fusion des 3 reducers serveur dans `deriveState` · badge no-failover / limité.

### P2
Bouton Stop · indice interruption/file dans le composer · vue de file (lecture + retrait) · dernier callback par musicien · badge quota depuis `rate_limit_event` · clôture après drainage de stdout · navigation clavier des cartes.

### P3
Rotation avec contrôle des `.pid` · historique et recherche · stockage.

## Commit

Rapport **non committé** : je laisse le chef décider (si oui, ce seul fichier, sans bump). Aucun autre fichier touché.
