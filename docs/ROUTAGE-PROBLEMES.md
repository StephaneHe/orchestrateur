# Routage (chef) — suivi des problèmes (9 et 10 octobre 2026)

> **Référence : ce document, `docs/ROUTAGE-PROBLEMES.md` du dépôt de l’orchestrateur (`orchestrateur-dev`, branche `dev`)** — décision de l’utilisateur du 2026-10-11. Une copie identique est déposée dans `I:\Dev\Chef\docs\ROUTAGE-PROBLEMES.md` après chaque mise à jour (hors exécution Routage du chef, voir n° 18) ; en cas d’écart, c’est ce document-ci qui fait foi.

Source : inventaire du chef, exécution `p-20261010T194702-b47305`
(`I:\Dev\Chef\.orchestrateur\runs\p-20261010T194702-b47305\rapport.md`), tiré de
ses exécutions de routage (`I:\Dev\Chef\.orchestrateur\runs\`), des
signalements « lacune » et « défaut » reçus, et de son `TODO_LIST.md`.

Décision de l'utilisateur (2026-10-10, verbatim) : « Document
I:\Dev\Chef\docs\ROUTAGE-PROBLEMES.md : vas, et on commence par s'attaquer a
ca ». Le document vit dans le dépôt de l'orchestrateur, parce que le code qui
corrige ces problèmes est le sien.

Le dépôt est public : les noms de projets privés sont remplacés par « [projet A] », « [projet B] »… La correspondance est dans le rapport du chef cité ci-dessus (local, non versionné).

**Statuts** :
- **ouvert** ;
- **corrigé en dev, non promu en prod** : commité sur la branche `dev` de
  `orchestrateur-dev`, pas encore en prod ;
- **corrigé** : en prod ;
- **sans objet**.

Les fichiers de code cités sont des **pistes**, pas un diagnostic établi.

| N° | Problème (court) | Statut | Code probablement concerné |
|----|------------------|--------|----------------------------|
| 1 | Message entier classé avant le découpage | corrigé en dev, non promu en prod (`4b82450`) | `scripts/pipeline-catalog.mjs`, `pipeline-engine.mjs`, `pipeline-classify.mjs` |
| 2 | Réponse à une question du chef classée comme demande neuve | corrigé en dev, non promu en prod (à valider en usage) | idem n° 1 (étape Comprendre, `routingContext`) |
| 3 | Réponses courtes → « lacunes » absurdes | corrigé en dev, non promu en prod (à valider en usage) | idem n° 1 ; `emitRoutingGap` ; affichage des lacunes |
| 4 | Classement « flou » entre deux pipelines | ouvert (en partie traité par `4b82450`) | `pipeline-classify.mjs` (`classifyEntry`), porte de `dispatch.mjs` |
| 5 | 9 % de lacunes ; pas de pipeline « navigation web / achats » | ouvert (décision de l'utilisateur) | `pipeline-catalog.mjs`, `model-pipelines.mjs` |
| 6 | Pas de pipeline devops / versionnage git | ouvert (décision de l'utilisateur) | `pipeline-catalog.mjs`, `model-pipelines.mjs` |
| 7 | Action directe du chef non exprimable | corrigé en dev, non promu en prod (0.70.0) | `pipeline-catalog.mjs` (`S.routage`), `pipeline-engine.mjs` (`CODE_STEPS`) |
| 8 | Tâche « action directe, ne pas dispatcher » dispatchée quand même | corrigé en dev, non promu en prod (0.71.0) | `pipeline-engine.mjs` (`dispatcher`), `routage-pending.mjs` (`launchTask`) |
| 9 | Défaut « `taches.json` : aucune tâche » bloquant | corrigé en dev, non promu en prod (0.70.0) | `pipeline-engine.mjs` (`validateUnitTasks`, `validateTasks`, `checkCatalogCriteria`, `reportDefects`) |
| 10 | Tâche « hors pipeline » autorisée non dispatchée | ouvert | `routage-pending.mjs` (`launchTask`), `pipeline-engine.mjs` (`classer`, `emitRoutingGap`), `pipeline-catalog.mjs` |
| 11 | Préfixe contraire à l'intention (« /discussion Corrige… ») | ouvert | `pipeline-observe.mjs` (`explicitChoice`), `pipeline-classify.mjs` |
| 12 | Tâche en file partie sans sa condition | ouvert | `server.js` (file et drain), `routage-pending.mjs`, `scripts/queue.mjs` |
| 13 | Tour en double sur la mauvaise cible (prod) | ouvert | `scripts/queue.mjs`, `server.js` (file), procédure du chef |
| 14 | Collision de version 0.69.0 prod / dev | sans objet | — |
| 15 | Exécutions en pause à vérifier après redémarrage | ouvert (à reprendre ; chef à vérifier) | — (`--pipeline-resume`) |
| 16 | Lignes `NEEDS_USER_INPUT` coupées dans la conversation du routeur | ouvert (à confirmer) | `pipeline-engine.mjs` (`conversationExcerpt`, `routingContext`) |
| 17 | Anciennes erreurs (`[projet C]`, prompts « ?? ») | corrigé | — |
| 18 | Écriture dans le dossier du chef effacée pendant une étape du Routage | corrigé en dev, non promu en prod (0.71.1) | `pipeline-engine.mjs` (`walkSnapshot`, `restoreFiles`) |

---

## A. Classement : le routeur classe avant de découper

### 1. Le message entier est classé d'un bloc, avant le découpage
Une demande qui contient plusieurs tâches reçoit un seul pipeline, ce qui
produit de fausses « lacunes ».

- **Statut : corrigé en dev, non promu en prod.** Commit `4b82450` sur
  `orchestrateur-dev` (v0.69.0 de la dev), « comprendre → découper → classer
  chaque tâche ». Test permanent `scripts/_test_routage_split.mjs`, 23 OK. Il
  n'est **pas intégré à la prod**, qui garde le défaut.
- Code : `scripts/pipeline-catalog.mjs` (`S.routage`, mode `demande` :
  `lire, comprendre, decomposer, classifier, affecter, dispatcher,
  rapporter`), `scripts/pipeline-engine.mjs` (`CODE_STEPS.classer`),
  `scripts/pipeline-classify.mjs` (`classifyTask`, `routingTaskPrompt`).

### 2. Une réponse à une question ouverte du chef est classée comme une demande neuve
Elle devrait être décomposée en tâches, une par musicien concerné.

- Signalée par l'utilisateur le 2026-10-09 : « là je répondais à une question
  que tu as dans ton contexte donc le routeur devrait pouvoir décomposer… ».
  Ce message a lui-même été classé « recherche ou dev, classement flou ».
- Entrée ouverte dans le TODO du chef depuis le 2026-10-09.
- **Statut : corrigé en dev, non promu en prod, à valider en usage.** Avec
  `4b82450`, l'étape Comprendre reconnaît une « suite » (réponse à une
  question ou une offre ouverte, d'après `contexte.md`), puis la découpe en
  une tâche par musicien concerné. Le cas « suite courte » est couvert par
  `_test_routage_split.mjs` (section 3). Le classement par mots-clés
  (« classement flou ») n'existe plus depuis 0.66.0.
- Code : `pipeline-catalog.mjs` (étape `comprendre`), `pipeline-engine.mjs`
  (`routingContext`).

### 3. Des réponses courtes aux questions du chef deviennent des « lacunes »
Chacune a reçu une proposition absurde de nouveau pipeline :

- « oui, hors pipeline » : pipeline « Hors pipeline » proposé ;
- « Mais ce dev devra etre fait sur dev » : pipeline « Devra etre » ;
- « passes décomposer et rapporter en opus 5.5… » : pipeline « Passes
  décomposer rapporter » ;
- « @orchestrateur Annuler les 14 fichiers (git restore) » : pipeline
  « Annuler fichiers restore ». Traité en Discussion par défaut, alors que
  c'était une action voulue.

- **Statut : corrigé en dev, non promu en prod, à valider en usage.** Avec
  `4b82450`, le message entier ne peut plus être une « lacune » : elle est
  refusée à l'étape Comprendre. Une réponse courte est comprise comme une
  « suite ». Une lacune ne porte plus que sur une tâche découpée. Reste à
  vérifier d'où viennent les noms de pipeline tirés des mots du message
  (« Devra etre »…) dans le signalement ou son affichage, pour s'assurer
  qu'aucun ne subsiste.
- Code : `pipeline-engine.mjs` (`emitRoutingGap`), `pipeline-observe.mjs`
  (signalements), `public/models.js` (panneau des lacunes).

### 4. Classement « flou » entre deux pipelines sur des messages de conversation
Les mots-clés proposés n'ont aucun sens (« ordre, c'est, possible », « suis,
temporairement, l'app »…) :

- « Dans cet ordre, si c'est possible : rollback… redémarre… » : incident ou
  audit. Selon l'utilisateur, c'est du devops et du versionnage, un pipeline
  qui n'existe pas encore (voir n° 6) ;
- « Décisions de l'utilisateur (verbatim)… » (dispatch-cli) : incident ou
  audit ;
- « [projet B] : je ne comprends pas, si c'est un probleme de pipeline… » :
  recherche ou audit ;
- « je suis temporairement sur l'App… proposes tu de redémarrer ? » :
  recherche ou dev.

- **Statut : ouvert, en partie traité.** Les « mots-clés proposés » venaient
  du classement par règles, supprimé en 0.66.0. Dans le Routage du chef,
  `4b82450` classe chaque tâche à part. En revanche, une entrée qui ne passe
  pas par le Routage (porte de `dispatch.mjs` d'un musicien, `dispatch-cli`)
  reste classée en un seul bloc par `classifyEntry`. Il faut aussi
  reconnaître une conversation (question, remarque) avant de chercher un
  pipeline d'action.
- Code : `pipeline-classify.mjs` (`classifyEntry`, `classificationPrompt`),
  `dispatch.mjs` (porte).

### 5. Taux de lacunes de 9 % sur 101 demandes réelles
Mesuré le 2026-10-08 sur l'orchestrateur 0.42.0. Il manque un pipeline
« navigation web / achats ».

- **Statut : ouvert.** Nouveau pipeline : il faut une décision de
  l'utilisateur (périmètre, étapes, cases de la page Models).
- Code : `pipeline-catalog.mjs`, `model-pipelines.mjs`, et une suite de test
  dans `_test_pipeline_catalog.mjs`.

### 6. Pas de pipeline pour le devops et le versionnage git
Push, tags, nettoyage, retour arrière. Le pipeline `maintenance` ne fait que
des rapports, et ces tâches finissent donc en lacune. L'utilisateur a dit que
ce pipeline serait créé plus tard.

- **Statut : ouvert.** Nouveau pipeline : il faut une décision de
  l'utilisateur.
- Code : `pipeline-catalog.mjs`, `model-pipelines.mjs`.

## B. Les actions du chef ne peuvent pas sortir du routage

### 7. Une action directe du chef n'est pas exprimable
Redémarrage, `kill-stalled`, supervision : la décomposition exige au moins
une tâche, et l'étape Dispatcher n'exécute que des dispatches.

- « ACTION DE SUPERVISION DU CHEF : arrêter le tour en double » a été classée
  en lacune **deux fois** (`p-20261010T190323`, `p-20261010T190920`). Il a
  fallu un troisième message pour que l'arrêt se fasse (`p-20261010T191255`).
- **Statut : corrigé en dev, non promu en prod (0.70.0).** L'étape
  Comprendre a la nature « action ». L'étape Découper rend des « actions » du
  chef, limitées à une liste blanche (`restart-orchestrateur`, `kill-stalled`,
  `resolve-question`, `copy-build`), que le Dispatcher exécute par le code
  (argv construit) sans jamais les confier à un musicien. Le redémarrage est
  lancé hors de l'arbre du serveur et attend la fin du tour du chef
  (`scripts/chef-action-deferred.mjs`). Toute autre action est refusée, et
  une tâche pour le chef ou un slot `chef-N` reste refusée. Test permanent :
  `scripts/_test_chef_actions.mjs`.
- Code : `pipeline-catalog.mjs` (`S.routage`, natures de l'étape
  Comprendre), `pipeline-engine.mjs` (`CODE_STEPS` : il faudrait une étape
  qui exécute, ou au moins déclare, une action du chef hors dispatch).

### 8. Une tâche marquée « action directe du chef, ne pas dispatcher » a quand même été dispatchée
Le redémarrage de la prod est parti en tour ordinaire chez le musicien
`orchestrateur` (19:36 UTC, `p-20261010T193435`). C'est contraire à la
consigne de l'utilisateur, « rien d'autre », et à la règle « jamais de
redémarrage par un musicien ». Le musicien a refusé de lui-même et n'a rien
fait.

- **Statut : corrigé en dev, non promu en prod (0.71.0).** Feu vert de
  l'utilisateur du 2026-10-11 (« J'ai lu et j'accepte », ordre 8, 18, 10).
  Le classement de chaque tâche peut répondre « action du chef »
  (`chef`) : la tâche n'est jamais dispatchée. Une action de la liste
  blanche est faite par le code, comme en 0.70.0 ; une autre action devient
  une question. Une tâche marquée `ne_pas_dispatcher` n'est ni classée ni
  dispatchée, et devient une question. Une action du chef qui doit attendre
  une autre tâche (« puis ») n'est pas exécutée en fin de tour : une
  question est posée. Le Dispatcher saute ces tâches quoi qu'en dise le
  classement. Test permanent : `scripts/_test_no_dispatch_chef.mjs`.
- Code : `pipeline-engine.mjs` (`CODE_STEPS.dispatcher`, `validateTasks`),
  `routage-pending.mjs` (`launchTask`).

### 9. Défaut « Décomposer en tâches : `taches.json` : aucune tâche »
Quand le chef n'a rien à dispatcher, l'exécution est bloquée (« aucune
livraison tant qu'il n'est pas corrigé ou accepté »). Trois exécutions :
`p-20261010T090927-06522f`, `p-20261010T193119-6e8112`,
`p-20261010T193435-08c2d3`.

- **Statut : corrigé en dev, non promu en prod (0.70.0).** `taches: []` est
  accepté, sans défaut, avec une raison (`aucun_dispatch`), des `actions` du
  chef ou une `question`. Sans aucun des trois, la liste vide reste refusée,
  et le message dit quoi ajouter. Exécutions concernées depuis le rapport :
  `p-20261010T200454-616091`, `p-20261010T200830-8b2b1c`. Test permanent :
  `scripts/_test_chef_actions.mjs`.
- Code : `pipeline-engine.mjs` (`validateUnitTasks`, `validateTasks`,
  `checkCatalogCriteria` critère `unitTasks`, `reportDefects`).

### 10. Une tâche « hors pipeline » autorisée par l'utilisateur n'est pas dispatchée
Le nettoyage git de la prod a été classé en lacune **trois fois**, malgré
« oui, hors pipeline » puis « oui vas y ». La raison tracée était même
tronquée : « maintenance de la flotte : ». Il a fallu passer par un message
direct au musicien.

- **Statut : ouvert.** Une tâche du Routage ne peut pas porter
  `--hors-pipeline` : `launchTask` ne le transmet pas, et l'étape Découper
  n'a pas de champ pour une autorisation hors pipeline. Avec `4b82450`, une
  tâche en « lacune » n'est jamais lancée. La troncature de la raison est à
  chercher dans l'analyse de `--hors-pipeline` ou dans le signalement.
- Code : `routage-pending.mjs` (`launchTask`), `pipeline-catalog.mjs` (étape
  `decomposer`, champ `impose`), `pipeline-engine.mjs` (`classer`,
  `emitRoutingGap`), `dispatch.mjs` (`--hors-pipeline`).

## C. Préfixes et intentions contradictoires

### 11. « /discussion Corrige avec git »
Le préfixe (lecture seule) contredit l'intention (modifier). Le préfixe l'a
emporté, et il n'existe aucune règle pour lever la contradiction ou la
signaler clairement à l'utilisateur.

- **Statut : ouvert.** Le préfixe est un choix explicite qui ne passe jamais
  par le model (0.66.0).
- Code : `pipeline-observe.mjs` (`explicitChoice`), `pipeline-classify.mjs`
  (`classifyEntry`, `classifyTask` : un préfixe complet court-circuite le
  model).

## D. File d'attente et cibles

### 12. Une tâche en file est partie sans sa condition
Le 2026-10-10 à 10:15, « création de la version dev » était annoncée
« lancée sous condition ». En réalité, elle allait partir sans condition à la
fin du tour en cours. Le chef l'a retirée à la main (`q-1791627334397-e75c`).

- **Statut : ouvert.** La file par musicien (`--queue-if-busy`) n'a pas de
  condition. Seules les tâches `apres` du Routage (`routage-pending.mjs`)
  attendent un résultat.
- Code : `server.js` (file, drain), `scripts/queue.mjs`,
  `routage-pending.mjs`.

### 13. Un tour en double sur la mauvaise cible
Le développement « découper avant de classer » était d'abord mis en file sur
la **prod** `orchestrateur`, puis redirigé vers `orchestrateur-dev`. L'entrée
de file prod n'a pas été retirée à temps : elle a démarré à 18:29 UTC (tour
`t-20261010T182920-9507dab8`). Résultat : 14 fichiers modifiés et un test
ajouté dans la prod, un arrêt (`kill-stalled`), puis un nettoyage git en
trois temps. Ce travail n'a jamais été commité ni poussé (constaté le
2026-10-10 : arbre de la prod propre, aucune trace dans `master`).

- **Statut : ouvert.** Rediriger une tâche ne retire pas l'entrée de file
  d'origine.
- Code : `scripts/queue.mjs`, `server.js` (file), contrat du chef
  (`I:\Dev\Chef`).

## E. Effets de bord et état lié

### 14. Collision de version
La prod et la dev avaient chacune une « 0.69.0 » différente (`8202dc8` contre
`4b82450`). Une question d'`orchestrateur-dev` était en attente : intégrer
`8202dc8`, renuméroter le Routage en 0.70.0, rejouer la non-régression, puis
pousser `dev`.

- **Statut : sans objet.** L'utilisateur a décidé de **ne pas** intégrer
  `8202dc8` et de le supprimer de git partout (« Le redemarrage s'est bien
  deroule, on peut oublier le retour, et le supprimer completement, meme de
  tout historique git »). La prod a remis `origin/master` sur `322dd5f`. La dev a
  purgé ses références locales le 2026-10-10 (`git cat-file -t 8202dc8`
  échoue). Le Routage `4b82450` garde la 0.69.0.

### 15. Exécutions en pause à vérifier après le redémarrage
[projet A] `p-20261009T193934-083679` et `p-20261009T123458-2a1135`, [projet B]
`p-20261009T123458-82d93b`, chef `p-20261009T193025-d2f51b`.

- **Mise à jour du 2026-10-10** : la prod a été redémarrée en 0.69.0 avec
  succès. Les exécutions [projet A] `p-20261009T193934-083679` et
  `p-20261009T123458-2a1135`, et [projet B] `p-20261009T123458-82d93b` sont
  toujours reprenables.
- **Statut : ouvert.** Il reste à les reprendre (« continuer » ou tâche
  `reprise`), et à vérifier l'exécution du chef `p-20261009T193025-d2f51b`,
  absente de la mise à jour.

### 16. Lignes `NEEDS_USER_INPUT` coupées dans la conversation fournie au routeur
Exemples : « Q », « J'arrête tout de sui… ». Il faut vérifier si c'est un
défaut de capture ou un simple affichage.

- **Statut : ouvert (à confirmer).**
- Code : `pipeline-engine.mjs` (`conversationExcerpt` coupe chaque message à
  2 000 caractères ; `routingContext` extrait les questions ouvertes).

### 17. Pour mémoire, corrigés
- Erreur de routage `[projet C]` (2026-10-02) : tour tué, [projet D] créé.
- Prompts transmis en « ?? » par le pipe PowerShell (2026-10-09) : corrigé.

- **Statut : corrigé.**

### 18. Une écriture dans le dossier du chef pendant une étape de son Routage est effacée
Ajouté le 2026-10-11, constaté en écrivant ce document. La première copie de
`I:\Dev\Chef\docs\ROUTAGE-PROBLEMES.md` a été supprimée quelques secondes
après son écriture. L'exécution Routage du chef `p-20261010T210614-034d0d`
(mode réveil) était en cours. Son étape Lire a été refusée avec « étape en
lecture seule, mais des fichiers du projet ont changé :
docs/ROUTAGE-PROBLEMES.md », puis le dossier a été restauré à son empreinte
d'avant l'étape, ce qui a effacé le fichier. Réécrit après la fin de
l'exécution, il est resté.

- **Risque** : toute modification faite dans `I:\Dev\Chef` pendant une étape
  de jugement du Routage est annulée, y compris une modification faite à la
  main par l'utilisateur (`TODO_LIST.md`, `CLAUDE.md`…). Elle est aussi
  comptée à tort comme une faute de l'étape (essai refusé, défaut signalé).
- **Statut : corrigé en dev, non promu en prod (0.71.1).** Feu vert de
  l'utilisateur du 2026-10-11 (« J'ai lu et j'accepte »). Dans un dossier
  hors git (celui du chef), un changement constaté pendant une étape de
  jugement n'est plus une faute de l'étape et n'est **jamais annulé** : il
  est signalé (`system/pipeline_external_change` dans le fil du chef, ligne
  dans le rapport). Les projets git gardent la règle stricte (refus +
  annulation). La limitation fine des outils de ces étapes (écriture
  réservée à l'artefact), envisagée dans la page de présentation, n'a pas été
  faite : son effet réel avec le CLI non interactif n'est pas vérifiable
  ici ; c'est l'option de repli « signaler sans annuler » qui est livrée.
  Test permanent : `scripts/_test_chef_folder_writes.mjs`.
- Code : `pipeline-engine.mjs` (`walkSnapshot`, `restoreFiles`, critère
  « lecture seule » des étapes de jugement quand `needs.git:false`). Piste :
  ne restaurer que les fichiers modifiés par le processus de l'étape, ou
  tolérer les changements extérieurs dans le dossier du chef en les signalant
  sans les annuler.

---

## Ordre de traitement

1. **Groupe B d'abord : les actions du chef doivent pouvoir sortir du
   routage.** Dans l'ordre : **n° 7** (action directe du chef exprimable),
   **n° 9** (« rien à dispatcher » n'est pas un défaut), **n° 8** (une tâche
   marquée « ne pas dispatcher » n'est jamais dispatchée), **n° 10** (une
   tâche hors pipeline autorisée part en tour ordinaire, tracé).
2. **Puis A : n° 2, 3, 4.** Valider en usage ce que `4b82450` corrige, puis
   traiter le reste (classement en un bloc hors du Routage, noms de lacunes
   tirés des mots). Le n° 1 est déjà corrigé en dev.
3. **Puis C : n° 11** (contradiction entre préfixe et intention).
4. **Puis D : n° 12, 13** (file conditionnelle, redirection qui retire
   l'entrée d'origine).
5. **En dernier : n° 5 et 6** (nouveaux pipelines « navigation web / achats »
   et « devops / versionnage git »). Ils demandent une décision de
   l'utilisateur sur leur périmètre.

Le n° 15 est un suivi d'exploitation (reprise des exécutions en pause), à
faire dès que possible et indépendamment du code. Le n° 16 est à confirmer
avant d'être corrigé. Le n° 18, ajouté après l'inventaire, est un risque de
perte de modifications : à traiter juste après le groupe B.

Toute correction suit la règle du projet : un test de non-régression par
demande, une ligne dans `docs/USER_REQUIREMENTS.md`, un commit sur `dev`.
Aucun push sans autorisation, et la promotion en prod se fait par un bond
décidé par l'utilisateur (`docs/DEV-PROD.md`).
