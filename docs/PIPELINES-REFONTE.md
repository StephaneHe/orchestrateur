# Pipelines — étude et plan de refonte (auteur : Opus 5.5)

> Demande de l'utilisateur (2026-10-20), après l'étude du Routage :
> « Donc on a etudie le routage, maintenant je voudrais qu'on optimise et arrange
> les pipelines. Retours d'experience :
> - la suggestion de nouveaux pipelines est souvent trop atomiques, et se concentre
>   sur un detail, plutot que de voir the big picture
> - si aucun pipeline est trouve, il faut une action qui ne mene pas a un cul de sac,
>   qui permette d'avancer, et qui peut faire preuve de creativite
> - un pipeline doit pouvoir utiliser ou etre utilise par un autre pipeline (ex :
>   preparer la redaction d'un email peut etre un pipeline utilise par le pipeline
>   de reunion)
> - les pipelines prennent beaucoup de temps, il faut optimiser tout en gardant la
>   predictabilite des actions menees »
>
> Étude et plan seulement : aucun code modifié, aucun redémarrage, rien d'écrit sous
> `I:\orchestrateur` (lecture seule de ses journaux). Document de décision écrit en
> français, comme `docs/ROUTAGE-SYNTHESE.md`, avec lequel il doit rester cohérent
> (points de jonction : §6).

---

## 1. Diagnostic sur les données réelles

### 1.1 Corpus

Relevé en lecture seule dans la prod (2026-10-08 → 2026-10-19) :
`logs/runs/*/run.json` (651 exécutions), les journaux d'étape `<nn>-<étape>.jsonl`
(durée du model lue dans chaque `result`), `logs/pipeline-classify.ndjson`
(255 décisions), `logs/pipeline-observe.ndjson` (1 763 entrées, dont 28 signalements
de lacune) et `model-routing.json` (`gapDecisions`, `custom`, `enforcement`).

| Mesure | Valeur |
|---|---|
| Exécutions | 613 du Routage du chef, **38 seulement de musiciens**, sur 11 projets |
| Tâches lancées par le Routage | 230, dont **18 seulement** vers un projet en service (liste actuelle `enforcement.projects`) ; les autres sont des tours ordinaires (orchestrateur-dev 116, orchestrateur 34, vuBox 32, youtube-live 28…) |
| Pipelines jamais exécutés | recherche, audit, nouveau, images, audio. Audit a pourtant été choisi **33 fois** par le classifier |
| Temps mural cumulé des 38 exécutions | **170 h**, pour **6,8 h actives** : 96 % du temps mural est une attente (pause, question, limite) |
| Part du model dans la durée d'une étape | **84 à 97 %** (les contrôles par le code ne pèsent presque rien). Exception : la Revue sur codex, où la durée du model n'est pas relevée |
| Tours d'outil par appel d'étape | 5 à 16 : chaque étape relit le projet depuis zéro |

**Limite** : 38 exécutions, c'est peu. Les médianes par pipeline sont indicatives.
Les estimations du §3.4 s'appuient donc surtout sur les durées **par étape**, mieux
fournies (127 étapes vert, 87 rouge, 52 revue).

### 1.2 Par pipeline (durée active, appels de model)

| Pipeline / mode | n | Statuts | Actif médiane / p95 | Appels (méd.) | Étapes refusées | Constat principal |
|---|---|---|---|---|---|---|
| discussion | 10 | 10 done | **151 s / 465 s** | 4 | 7 / 37 (19 %) | **7 exécutions sur 10** refusées une fois à Comprendre : « chemins cités inexistants » (`system/init`, `rouge.md`, `taches.json`, fichiers d'un autre projet). Faux positifs, ~40 à 90 s perdues à chaque fois |
| dev / léger | 8 | 4 done, 2 interrupted, 2 paused | 642 s / 5 557 s | 5 | 22 / 54 (41 %) | Livrer refusé en boucle (voir 1.3) ; vert « aucune modification » |
| dev / complet | 6 | 2 done, 2 paused, 2 abandoned | 668 s / 6 541 s | **56** | 20 / 313 | [[p-20261009T193934-083679]] : **91 étapes, 109 min actives**, ~420 $ d'équivalent API, fini en pause (limite d'usage de codex à la Revue) |
| rédaction | 7 | 7 done | 241 s / 459 s | 4 | 1 / 29 | Fiable. Mettre en forme sur opus (33 s, jusqu'à 1,8 $) pour appliquer des corrections déjà écrites |
| maintenance | 2 | 1 done, 1 paused | 192 s | 5 | 2 / 10 | **Les deux sont des erreurs d'aiguillage** : un rangement de réunion ([[p-20261016T132118-ddfd3b]], pause « dette.md absent ») et un `git push` ([[p-20261019T162957-4ebfbf]] : 4 étapes d'analyse sans rapport avec la demande, puis « rien à livrer » ; le push ne fait partie d'aucune étape) |
| incident | 1 | done | 814 s | 9 | 1 / 9 | 8 étapes en série, dont Contenir (« rien à contenir ») |
| vidéo | 1 | done | 791 s | 9 | 0 | dominé par le téléchargement (407 s) |
| réunion | 1 | done | 241 s actif, **1 014 min mural** | 6 | 1 / 8 | la demande était un **brouillon de mail** ([[p-20261016T155415-e67865]]) ; une Rédaction a été relancée le lendemain ([[p-20261017T085337-57048e]]). C'est le besoin de composition |
| données | 1 | done | 357 s actif, 28 min mural | 7 | 2 / 7 | un téléchargement de reel classé en Données ; Nettoyer et Stocker jouées pour rien |

Pour comparaison, le Routage du chef coûte en amont **104 s** de médiane (§1 de
`ROUTAGE-SYNTHESE.md`). Une simple question passe donc aujourd'hui par
4 + 1 + 4 = **9 appels de model** en série, soit 4 à 5 min.

### 1.3 Par étape (toutes exécutions de musiciens)

| Étape | n | Médiane / p95 | Constat |
|---|---|---|---|
| dev.vert | 127 | 23 s / 97 s | 38 sautées (item déjà couvert), 12 refusées « aucune modification » |
| dev.rouge | 87 | 51 s / 98 s | **38 items sur 87 (44 %) étaient déjà couverts** (`DEJA_COUVERT`) : la Liste de tests découpe trop, et chaque item couvert coûte un tour complet pour le constater |
| dev.revue | 52 | 34 s / 215 s | garantie à garder ; la limite d'usage de codex a bloqué une exécution |
| dev.refactor | 72 | 0 s | 58 sautées par le code (seuil de 10 lignes) : peu coûteux, déjà optimisé |
| dev.livrer | 18 | 32 s / 101 s | **11 refus sur 18 (61 %)** : « aucun commit créé », « version non incrémentée ». [[p-20261018T154104-6cfbe8]] : **9 essais de Livrer**, 330 s. Une tâche mécanique confiée à un model |
| discussion.comprendre | 17 | 39 s / 172 s | 7 refus « chemins cités » (faux positifs) |
| discussion.rechercher + repondre | 20 | 45 s + 32 s | trois appels en série qui relisent le même code |
| redaction.rediger | 8 | 87 s / 257 s | 16,6 tours d'outil par appel |

### 1.4 Le classement révèle une famille manquante

Sur 255 décisions du classifier, **0 échec**, mais des choix forcés faute de mieux :

- **audit** (audit de *sécurité*) choisi 33 fois pour « lancer la non-régression
  complète avant la mise en prod », « bond dev → prod avec prod-jump », « vérifier
  en lecture seule que le failover est inactif » ;
- **maintenance** choisie 15 fois pour « push git mécanique », « ajout d'entrées dans
  TODO_LIST.md », « arrêt d'un server.js sur le port 7778 », « bascule de production » ;
- **incident** pour « relance d'un service Windows » ou « récupérer un fichier via
  Tailscale ».

Le besoin commun est clair : **exécuter une procédure d'exploitation connue
(déployer, pousser, relancer, installer, vérifier) et en vérifier le résultat.** Il
n'existe pas. Le même besoin a d'ailleurs été signalé comme lacune trois fois, sous
trois clés différentes (voir 1.5).

### 1.5 Les propositions de pipelines : trop atomiques, prouvé par les données

26 lacunes distinctes (28 signalements) : 13 « flou », 13 « aucun pipeline ».

| Date | Proposition réelle | Défaut |
|---|---|---|
| 2026-10-08 | créer « **Verifie collection disney** » (Cadrer → Réaliser → Vérifier → Livrer), « reconnu par les mots verifie, collection, disney » | nom et déclencheur tirés des mots d'**une** demande |
| 2026-10-09 | « **Passes décomposer rapporter** » | c'était une réponse de l'utilisateur au chef, pas un besoin |
| 2026-10-10 | « **Devra etre** », « **Hors pipeline** », « **Annuler fichiers restore** » | mots vides de la demande ; un geste ponctuel érigé en pipeline |
| 2026-10-08 → 10 | 13 « flou » : « rattacher à recherche et ajouter **« réponse, l'utilisateur, question »** à sa description » | 11 rattachements acceptés, gardés dans `custom.attach` avec des mots-clés (lexique hérité, inutilisé depuis 0.66.0) |
| 2026-10-10 | 5 lacunes « aucun pipeline » du Routage : supervision du chef (kill-stalled, queue), nettoyage git de la prod | ce sont des **actions du chef**, pas un besoin de pipeline |
| 2026-10-13, 2026-10-19 ×2 | « Il manque un pipeline dédié **déploiement / mise en prod** » (prod-jump, serveur + box, APK via adb) | **même besoin, trois clés** (`routage:<sha1 du texte de la tâche>`), jamais regroupées |
| 2026-10-16 | celle du 10-13 acceptée ⇒ `x-7e4cf1`, libellé **coupé** « proposition du model de classement : Il manque un pipeline d », but = le contexte d'une seule demande, flux générique | **non exécutable** : `ENGINE_PIPELINES` ne contient pas les pipelines de `custom`. Le classifier l'a choisi une fois, puis la tâche est retombée en tour ordinaire (« pas encore en service ») |

Causes, toutes visibles dans le code :

1. **La clé est le texte d'une tâche** (`emitRoutingGap`, `pipeline-engine.mjs:1367`) :
   deux demandes du même besoin ne se rejoignent jamais.
2. **La consigne demande « une phrase »** pour **une** tâche (`pipeline-classify.mjs:69`
   et `:236`), sans le catalogue des familles ni les lacunes déjà vues.
3. **Aucun seuil** : une proposition naît dès la première occurrence.
4. **Aucune échelle de réponses** : « créer » est la seule forme offerte. Généraliser
   un pipeline existant ou en composer deux n'est jamais proposé.
5. **Accepter ne produit rien d'exécutable** (`x-7e4cf1`).

### 1.6 Aucun pipeline trouvé : où mène le chemin aujourd'hui

- **Porte de `dispatch.mjs`** : une lacune devient une **Discussion**, qui ne fait
  rien. L'action demandée n'a pas lieu.
- **Routage** : la tâche devient une **question** et n'est pas lancée. La Routage v3
  (§3.3 de la synthèse) dit « la tâche est gardée, signalement ; Discussion si
  l'utilisateur le veut ».
- **Faute de lacune déclarée** : un pipeline mal ajusté (Maintenance pour un push,
  pour un rangement) **joue ses étapes fixes** et rend « rien à livrer » ou une pause
  de critère. C'est le cul-de-sac le plus coûteux, car il a l'air d'avancer.

### 1.7 Composition : un précédent, mais en dur

Réunion → Rédaction (0.111.0) existe : `pipeline-catalog.mjs:252-256` **recopie** les
étapes de la Rédaction dans la Réunion (`fromPipeline: 'redaction'`, titres « R1 … »,
`livrer-texte`). Ça marche, c'est testé (`_test_reunion_redaction_route.mjs`), mais
c'est une copie : aucun contrat, aucune règle de profondeur ou d'anti-boucle, aucune
réutilisation ailleurs, un `final` et un `modes` écrits à la main.

### 1.8 Diagnostic en dix lignes

1. Seules 38 exécutions de musiciens en 12 jours : les chiffres par pipeline sont indicatifs.
2. 96 % du temps mural est de l'attente (pauses). Le temps actif est dominé à 84–97 % par le model.
3. La vitesse dépend donc du **nombre d'appels** et de leur relecture du projet, pas des contrôles.
4. Discussion : 3 appels pour une question, et 70 % des exécutions refusées à tort (« chemins cités »).
5. Livrer, une étape mécanique, est refusé 61 % du temps (jusqu'à 9 essais).
6. Développement complet : 44 % des items de la liste de tests étaient déjà couverts.
7. Il manque une famille entière : l'**exploitation** (déployer, pousser, relancer). Elle est forcée en Audit ou en Maintenance.
8. Les lacunes portent sur une tâche (clé = son texte), sans seuil ni regroupement. D'où « Verifie collection disney ».
9. « Aucun pipeline » mène à une Discussion inerte, à une question, ou à un pipeline mal ajusté qui joue ses étapes fixes.
10. La seule composition existante (Réunion → Rédaction) est une copie en dur, sans contrat.

---

## 2. Principes retenus

- **Prévisibilité d'abord.** Tout plan est écrit **avant** d'agir, gardé dans
  `run.json`, affiché dans la frise. Tout critère est vérifié **par le code**. Un choix
  du model (route, étapes à la carte, plan libre) se fait **dans une liste fermée**, et
  il est tracé.
- **Aucun routage par mots-clés** (0.66.0) : regroupement, généralisation et choix
  restent des jugements du model. Le code ne contrôle que la **structure**.
- **Garanties des pipelines de code inchangées** : test rouge, code vert sans toucher
  aux tests, revue par item, aucun défaut livré (0.65.0), une livraison vérifiée.
- **Chaque optimisation est un interrupteur** relu à chaud, et l'état d'une exécution
  fige ses interrupteurs au départ : une reprise rejoue le même plan.

---

## 3. Propositions

### 3.a Lacunes « big picture »

**Une lacune décrit un besoin, pas une tâche.** Le classifier ne rend plus une phrase
mais un objet structuré, quand aucun pipeline ne convient :

```json
{"besoin": {"famille": "Exploitation : déployer, pousser, relancer",
            "resultat_attendu": "la version X tourne en prod et répond",
            "plus_proche": "maintenance",
            "ecart": "Maintenance analyse et nettoie ; ici il faut exécuter une procédure connue et en vérifier l'effet"}}
```

**Familles en fichier** : `logs/pipeline-families.json` (propriétaire unique
`scripts/pipeline-families.mjs`, verrou, écriture atomique, comme
`routage-pending.mjs`). Une famille regroupe ses signalements (exemples complets, date,
projet, demande d'origine).

**Rattachement par le model, jamais par mots.** À chaque nouveau signalement, un appel
court (case `routage.classifier`) reçoit le besoin et la liste des familles ouvertes et
des pipelines, et répond `{famille: <id existant> | "nouvelle"}`. C'est un choix dans
une liste fermée, comme `chooseOption`. Les tâches classées « action du chef » ne
produisent **jamais** de lacune : c'est le rôle des actions typées de la Routage v3.

**Seuil avant proposition.** Une famille reste « observée » tant qu'elle n'a pas
**3 signalements venus d'au moins 2 demandes distinctes en 30 jours** (réglable).
L'information remonte dès le premier signalement (règle 0.42.0 : « remonter
l'information en proposant une solution »). La proposition provisoire est alors
« exécuté en Libre (§3.b), famille X observée 1/3 ». La proposition de pipeline arrive
au seuil, ou plus tôt si l'utilisateur la demande.

**Échelle de propositions, dans cet ordre** (le model justifie chaque rejet d'un
échelon) :

1. **généraliser** un pipeline existant : nouveau mode, variante ou étape facultative ;
2. **composer** des briques existantes (§3.c) en une recette ;
3. **créer** un pipeline, seulement si 1 et 2 ne suffisent pas.

**Contrôles par le code** : au moins 3 exemples réels joints ; l'échelon choisi et la
raison du rejet des précédents ; chaque étape proposée prend ses critères dans la
bibliothèque existante (`checks` du catalogue) ; libellé ≤ 60 caractères, jamais coupé.
**Accepter produit une définition exécutable** (entrée `custom` reconnue par le moteur,
cases de la page Models créées), et une exécution d'essai sur fixture doit passer avant
la mise en service. Plus jamais de `x-7e4cf1` inerte.

**Application immédiate aux données** : les 3 lacunes « déploiement », les 33 « audit »
et 15 « maintenance » mal ajustés forment une seule famille, **Exploitation** :
Préparer (procédure et commandes, autorisations requises) → Exécuter → Vérifier les
postconditions **par le code** (version servie, PID, APK installé, push présent sur le
distant) → Rapporter. Elle reprend les postconditions des actions typées de la Routage
v3 (§3.2 de la synthèse). Toute action irréversible (push, bond, suppression) exige
l'autorisation citée de l'utilisateur (`userSaid`, 0.71.2). Sinon, l'exécution se met
en pause.

> En 4 lignes : une lacune = un besoin structuré (famille, résultat attendu, pipeline le
> plus proche, écart). Le model rattache chaque signalement à une famille. On propose au
> seuil de 3 signalements et 2 demandes, en essayant dans l'ordre : généraliser, puis
> composer, puis créer. Toute acceptation produit un pipeline exécutable et testé.
> Première famille : Exploitation.

### 3.b Aucun pipeline trouvé : le pipeline « Libre »

Une **demande d'action** qu'aucun pipeline ne couvre part dans **Libre**, au lieu d'une
Discussion inerte ou d'une question. Les questions pures restent en Discussion.

| Étape | Qui | Ce qui est vérifié par le code |
|---|---|---|
| L1 Planifier | model (case `libre.planifier`) | `plan.json` : objectif, résultat attendu, 1 à 6 étapes. Chaque étape est **une brique du catalogue** (§3.c) ou une étape improvisée typée (`judge` ou `action`), avec des critères pris dans la bibliothèque, les fichiers modifiables (`onlyGlobs`) et un drapeau `irreversible` |
| L2 Valider et annoncer | code | schéma, briques existantes, budget, cohérence `kind`/critères ; plan affiché dans la frise et envoyé au chef. **Pause d'approbation** seulement si le plan contient une action irréversible sans autorisation citée, ou modifie plus de N fichiers (défaut 10) |
| L3… Exécuter | model, étape par étape | les critères déclarés. Une action improvisée a au minimum : suite verte, `onlyGlobs`, `protectTests`. Un jugement : lecture seule et sections déclarées. **Le plan ne s'étend jamais en cours de route** : un besoin nouveau = pause « plan à revoir » |
| Lv Vérifier | model + code | le résultat attendu de L1, confronté aux artefacts ; postconditions déclarées |
| Livrer | code (§3.d-1) | si quelque chose a changé |

- **Créativité** : le model choisit et compose librement, y compris des briques
  d'autres familles (un téléchargement + une rédaction, par exemple).
- **Prévisibilité** : plan écrit et montré avant d'agir, liste fermée de critères,
  budget borné, aucune extension silencieuse.
- **Figer** : chaque exécution Libre enregistre la signature de son plan (suite de
  briques) dans sa famille (§3.a). Quand des plans semblables se répètent et passent
  le seuil, la proposition « figer en pipeline » est faite, avec le plan éprouvé comme
  définition : c'est l'échelon 2 (composer), déjà testé en vrai.
- **Garde-fous** : jamais pour le chef lui-même (actions typées de la v3) ; jamais un
  push ou un bond sans autorisation citée ; `--hors-pipeline` garde son sens actuel.

> En 4 lignes : une action sans pipeline part en Libre. Le model y écrit un plan de
> briques et d'étapes typées. Le code le valide, l'affiche et ne fait une pause que pour
> l'irréversible. L'exécution suit des critères vérifiés par le code, sans extension
> silencieuse du plan. Un plan qui se répète devient une proposition de pipeline « figé ».

### 3.c Composition : un pipeline en appelle un autre

**Étape d'appel** dans le catalogue :

```js
{ id: 'courriel', kind: 'call', pipeline: 'courriel', mode: 'leger',
  with: { demande: 'demande.md', contexte: ['inventaire.json', 'rangement.json'] },
  output: 'texte.md' }
```

| Point | Règle proposée |
|---|---|
| **Exécution** | **Expansion dans la même exécution** (recommandé, comme Réunion → Rédaction aujourd'hui, mais générique) : au calcul du plan, l'étape `call` est remplacée par les étapes de la brique, préfixées (`courriel/rediger`…). Un seul `run.json`, une frise, un verrou de tour, un couloir, une session par groupe. Pas de sous-processus |
| **Contrat entrée / sortie** | Chaque brique déclare `inputs` (fichiers lus dans le dossier de l'exécution, obligatoires ou facultatifs) et `outputs` (artefacts et leurs critères). L'appelant les relie par `with` et `output`. Le code refuse au chargement du catalogue un appel dont une entrée obligatoire n'est pas fournie. Les artefacts de la brique vivent sous `sub/<n>-<brique>/`, et la sortie est recopiée sous le nom attendu par l'appelant |
| **Profondeur** | **2 au plus** (pipeline → brique → brique). Vérifiée au chargement |
| **Anti-boucle** | graphe des appels **acyclique**, vérifié au chargement du catalogue (sinon le catalogue entier est refusé, comme `downloads.json`). À l'exécution, une pile d'expansion refuse un pipeline déjà présent dans la pile |
| **Critères** | ceux de la brique, **jamais affaiblis** par l'appelant. L'appelant peut en **ajouter** (`extraChecks`), jamais en retirer |
| **Limites** | un seul budget par exécution (items, durée active, tours de revue). Une brique peut déclarer un sous-plafond inférieur ou égal à celui de l'appelant |
| **Livraison** | une seule par exécution : `livrer` d'une brique appelée est retiré (`deliver: 'parent'`), et l'appelant livre le tout, comme le mode `les-deux` de la Réunion |
| **Pauses** | une pause dans une brique **est** la pause de l'exécution. Le message dit « Courriel (dans Réunion), étape Relire ». « continuer » reprend l'étape de la brique, « abandonner » clôt l'exécution entière. Les pannes d'infrastructure (0.118.0) s'appliquent sans changement |
| **Models par case** | la brique garde ses cases (`courriel.rediger`). L'appelant peut déclarer une case dédiée (`reunion.courriel.rediger`), placée en tête de `chain`. La page Models montre la brique en renvoi (`ref`) avec la case dédiée facultative |
| **Frise** | bloc replié « ▸ Courriel » sous l'étape d'appel, avec ses étapes indentées. Il est déplié pendant l'exécution et replié une fois fini |
| **Classement** | une brique peut aussi être un pipeline de premier niveau (Rédaction, Recherche), ou seulement appelable (`callableOnly`) |

**Briques identifiées dans le catalogue actuel** :

| Brique | Étapes | Appelée par |
|---|---|---|
| **Rédaction** | rédiger, relire, mettre en forme | Réunion (déjà, en dur), Nouveau (README), Incident (post-mortem destiné à l'extérieur), Libre |
| **Courriel** (nouvelle, spécialisation de Rédaction) | rédiger (destinataire, objet, ton), relire ; jamais envoyé | Réunion, Libre ; c'est l'exemple de l'utilisateur |
| **Recherche** | cadrer, rechercher, lire, recouper, synthétiser | Discussion complète, Nouveau (choix de stack), Audit (avis de sécurité), Libre |
| **Cycle TDD** | rouge, vert, refactor, revue d'item | Développement, Incident (corriger-rouge/vert, déjà réutilisés par `crit`), Audit (corriger), Maintenance (dette) |
| **Revue** | revue indépendante sur un diff | Développement, Rédaction (relecture d'un document technique), Audit |
| **Livraison** | version, CHANGELOG, exigence, commit (§3.d-1) | tous (déjà partagé par `crit: 'livrer'`) |
| **Acquisition média** | acquérir, vérifier le fichier | Vidéo, Audio, Données (le reel téléchargé en Données) |
| **Vérification des postconditions** (nouvelle, code) | contrôles déclarés | Exploitation, Libre |

**Tests** : chargement du catalogue (cycle, profondeur, contrats) ; une brique appelée
par deux pipelines ; pause dans une brique puis reprise ; case dédiée prioritaire ;
une seule livraison ; frise (navigateur, bureau et mobile). La Réunion migrée vers le
mécanisme générique doit garder `_test_reunion_redaction_route.mjs` **vert sans
modification** (test d'exigence).

> En 4 lignes : une étape `call` est remplacée par les étapes de la brique au calcul du
> plan. On garde un seul run.json, une frise et une livraison. Contrat entrée/sortie
> déclaré, profondeur 2, graphe acyclique vérifié au chargement. Critères jamais
> affaiblis, budget partagé, pauses qui remontent avec leur contexte. Huit briques, dont
> Courriel pour la Réunion.

### 3.d Vitesse en gardant la prévisibilité

Mesures classées par gain rapporté à l'effort. **C** = déjà prouvé par les données.

1. **Livrer par le code** (C : 61 % de refus, jusqu'à 9 essais). Le commit, la hausse de
   version (type `patch|minor|major` déclaré), l'entrée CHANGELOG et la ligne du
   registre des exigences sont faits par le code, sur le modèle des fragments
   `changelog.d/` des couloirs (`applyFragments`, 0.102.0). Le model écrit seulement
   le fragment (type de hausse et sections), dans la dernière étape d'action ou par un
   appel court. Les vérifications de Livrer restent les mêmes, et elles deviennent
   déterministes. Gain : −1 appel (~32 s, p95 101 s) et les essais répétés.
2. **Discussion en une étape** (C : 3 appels, 70 % de refus). Une seule étape
   « Répondre » dans une session, en lecture seule vérifiée par le code, avec ses
   sections, ses sources citées et ses chemins vérifiés. **La Recherche reste
   disponible** en brique quand la question demande le web (choix par route).
3. **Corriger le faux positif « chemins cités »** : ne contrôler que les chemins relatifs
   au projet ou absolus sous un dossier de la flotte. Ignorer les noms d'artefacts de
   l'orchestrateur (`rouge.md`, `taches.json`), les événements de log (`system/init`) et
   les chemins d'un autre projet, qui sont signalés sans refus.
4. **Rédaction : Mettre en forme par le code** quand le texte est dans l'artefact
   (`TEXTE_DANS_ARTEFACT`). La relecture rend déjà `final` : le code l'écrit.
   L'étape model reste pour les documents du projet. Livrer par le code.
5. **Étapes à la carte** pour Maintenance, Incident, Données et Vidéo (C : un push a joué
   4 étapes d'analyse ; Nettoyer et Stocker jouées pour rien). Au départ, un appel court
   du classifier (comme la route de la Réunion, `chooseOption`) choisit dans une **liste
   fermée** les étapes utiles (« contenir : seulement si le défaut est actif en
   production »). Les étapes écartées figurent dans la frise « sautée — non requise :
   raison ». Le choix est gardé dans `run.json`.
6. **Liste de tests vérifiée avant le rouge** (C : 44 % d'items déjà couverts). La Liste
   de tests reçoit les tests existants (déclarations relevées par `countTests`,
   0.62.0). Un item déclaré déjà couvert y porte sa preuve (`fichier:test`), vérifiée
   par le code (`coveredProof`) **à la liste**, et l'item n'entre pas dans la boucle. Le
   rouge reste obligatoire pour tout item nouveau. Gain : ~50 s par item couvert.
7. **Session de l'item partagée par rouge, vert et refactor** (aujourd'hui : groupes
   `tests` et `code`, donc deux sessions). L'interdiction de toucher aux tests est
   vérifiée par le code, pas par l'ignorance du model, donc la garantie ne change pas.
   La Revue reste indépendante (autre session, autre model). Gain estimé : −20 à −30 %
   de tours d'outil sur vert.
8. **Base verte en cache** : le résultat de la suite au départ est gardé par empreinte
   d'arbre (`git write-tree` + commande + version de l'outil), 24 h au plus. Deux
   exécutions qui se suivent sur le même arbre ne relancent pas la suite (la
   non-régression ciblée d'orchestrateur-dev dure jusqu'à 30 min).
9. **Rouge ciblé** (facultatif par projet, `.orchestrateur/pipeline.json` →
   `testFileCommand`) : à l'étape rouge, ne lancer que le fichier de test modifié pour
   prouver l'échec. La suite complète reste exigée à vert et à refactor.
10. **Parallélisme des étapes indépendantes** : Audit (revue manuelle ∥ second avis, déjà
    indépendants par construction) ; Maintenance (historique ∥ dépendances, l'historique
    lisant une copie figée) ; variantes média indépendantes. Les items du Développement
    restent en série (les tâches parallèles passent par les couloirs).
11. **Models plus légers là où un critère strict juge** (`reunion.trier`, mettre en
    forme, relire un texte court, fragment de livraison, choix à la carte) :
    **suggestions** affichées par le mécanisme existant (0.46.0), appliquées par
    l'utilisateur seulement. Aucun model n'est changé d'office.

**Estimation avant / après (durée active médiane, mêmes models)** :

| Pipeline | Aujourd'hui | Après | Leviers |
|---|---|---|---|
| Discussion | 151 s (4 appels) | **≈ 50 s** (1 appel) | 2, 3 |
| Rédaction | 241 s (4) | **≈ 150 s** (2 + code) | 1, 4 |
| Développement léger | 642 s (5) | **≈ 420 s** (4) | 1, 7, 8 |
| Développement complet | 668 s / p95 6 541 s | **≈ 430 s / ≈ 3 900 s** | 1, 6, 7, 8, 9 |
| Maintenance | 192 s (5 fixes) | **≈ 80 s** (1 à 2) | 1, 5 |
| Incident | 814 s (9) | **≈ 600 s** | 1, 5 |
| Données | 357 s (7) | **≈ 220 s** | 1, 5 |
| Vidéo | 791 s | ≈ 720 s (téléchargement incompressible) | 1, 5 |
| Réunion (rangement) | 241 s | ≈ 210 s | 1 |
| Audit, Recherche | pas de donnée | Audit −15 à −20 % (10) | 1, 10 |
| Bout en bout d'une question (Routage actuel + Discussion) | ≈ 255 s, 9 appels | ≈ 95 s avec la Routage v3 (≤ 45 s) + 50 s | v3 + 2 |

L'attente (96 % du temps mural) n'est pas comprise : elle dépend des réponses aux
pauses. Les pannes d'infrastructure, garées et relancées depuis 0.118.0, en
retirent une partie. Les autres leviers sont des pauses mieux évitées (faux positifs,
erreurs d'aiguillage, Livrer) : environ un tiers des pauses du corpus.

> En 4 lignes : la livraison passe au code, Discussion et Mettre en forme se réduisent à
> un appel ou au code, et les étapes deviennent à la carte, choisies dans une liste
> fermée. Les items déjà couverts sont prouvés dès la liste, et rouge, vert et refactor
> partagent une session. Base verte en cache, rouge ciblé, jugements indépendants en
> parallèle. Gain attendu : −35 à −65 % de temps actif selon le pipeline, avec une frise
> et des critères inchangés.

---

## 4. Plan par phases

**Règle prod/dev** : chaque phase est développée et passée en non-régression dans
`orchestrateur-dev` (bac à sable sur le port 7778 pour une instance vivante, projet
pilote `pipelineLab` dans les fixtures). Puis tag `vX.Y.Z` vérifié, et **bond décidé par
l'utilisateur** (`prod-jump.mjs`, non-régression par périmètre). Tag de retour
`pre-pipelines-<phase>-vX.Y.Z` avant chaque phase. Constat : orchestrateur-dev ne fait
plus partie de `enforcement.projects` en prod (retiré le 2026-10-19). Ses propres
pipelines ne servent donc pas d'observation.

**Bascule à chaud** : `model-routing.json` → `enforcement.tuning {livrerCode,
discussionUne, aLaCarte, listeVerifiee, sessionItem, baseCache, rougeCible,
parallele, libre, briques, familles}`. Ces réglages sont relus à chaque dispatch, écrits
par `pipeline-enforce.mjs tuning on|off <nom>`, et `tuning off --all` sert de retour
arrière. **Une exécution fige ses réglages au départ** (`state.tuning`) : une reprise
rejoue le même plan, et une exécution commencée avant une bascule finit comme elle a
commencé.

| Phase | Contenu | Effort | Critère de sortie |
|---|---|---|---|
| **0 — gains rapides** | 3 (chemins cités), 1 (Livrer par le code), 4 (Mettre en forme par le code), 8 (base verte en cache) ; le classifier ne propose plus un pipeline `custom` non exécutable | 2 j | corpus rejoué : 0 refus « chemins cités » à tort ; Livrer sans essai répété |
| **1 — Discussion et à la carte** | 2 (Discussion en une étape, Recherche en option), 5 (à la carte pour Maintenance, Incident, Données, Vidéo) | 2 j | Discussion ≤ 60 s de médiane sur le banc |
| **2 — briques** | étape `call`, contrats, profondeur, graphe acyclique, frise imbriquée, cases dédiées ; Réunion → Rédaction migrée ; briques Courriel et Vérification des postconditions | 3 j | `_test_reunion_redaction_route.mjs` vert sans modification ; Réunion → Courriel de bout en bout |
| **3 — familles de lacunes** | besoin structuré, `pipeline-families.mjs`, rattachement par le model, seuil, échelle de propositions, acceptation exécutable ; reprise des 26 lacunes existantes | 2 j | les 26 lacunes du corpus donnent ≤ 4 familles, dont Exploitation ; 0 proposition sous le seuil |
| **4 — Libre** | pipeline Libre (planifier, valider, annoncer, exécuter, vérifier), signature des plans, « figer » | 3 j | le corpus « aucun pipeline » avance jusqu'à un résultat ou une pause d'autorisation, jamais une Discussion inerte |
| **5 — Exploitation** | première famille figée (décision D9), postconditions vérifiées par le code | 1,5 j | les 3 lacunes « déploiement » et les 48 aiguillages forcés (33 audit, 15 maintenance) du corpus classés Exploitation |
| **6 — vitesse 2** | 6 (liste vérifiée), 7 (session d'item), 9 (rouge ciblé), 10 (parallélisme), 11 (suggestions de models) | 2,5 j | Développement complet −35 % sur le banc |
| **7 — mesure en prod** | bond, 7 jours d'observation, `pipeline-bench.mjs` | 0,5 j + observation | critères du tableau ci-dessous |

Total ≈ **16,5 jours**, hors observation.

**Tests**

- **Corpus réel anonymisé** `tests/pipeline-corpus/` (le dépôt est public : noms de
  projets remplacés). Il contient les 7 refus « chemins cités » de Discussion, les
  9 essais de Livrer de [[p-20261018T154104-6cfbe8]], les 91 étapes de
  [[p-20261009T193934-083679]] (plan et `tests.md`), les deux erreurs d'aiguillage de
  Maintenance, la Réunion qui était un mail, et les 28 signalements de lacune. Suite
  `_test_pipeline_corpus.mjs` (faux claude rejouant les sorties enregistrées).
- `_test_pipeline_bricks.mjs`, `_test_pipeline_libre.mjs`, `_test_pipeline_families.mjs`,
  `_test_livrer_code.mjs`, `_test_a_la_carte.mjs`, `_test_tuning_switch.mjs` (bascule
  à chaud, réglages figés à la reprise) ; HTTP `pipeline-tuning`, `pipeline-families` ;
  navigateur `run-bricks-timeline` (bureau et mobile), `families-view`.
- **Banc** `scripts/pipeline-bench.mjs` : médiane et p95 par pipeline et par étape,
  nombre d'appels, refus, pauses, lus dans `logs/runs/`. C'est le critère de chaque phase.
- Tests d'exigence existants gardés **intacts** : `_test_pipeline_gates`,
  `_test_item_review`, `_test_item_delivery`, `_test_defect_blocks`,
  `_test_pipeline_covered`, `_test_item_tests`, `_test_tests_per_item`,
  `_test_reunion_redaction_route`, `_test_reunion_pipeline`, `_test_no_lexical_routing`,
  `_test_pipeline_gaps`, `_test_release_prebump`, `_test_lane_changelog_rule`. Une
  assertion qui changerait (par exemple la Discussion à trois étapes, ou Livrer joué par
  un model) ne change qu'avec l'accord explicite de l'utilisateur (D5, D6).
- Chaque demande de l'utilisateur de ce document entre dans `docs/USER_REQUIREMENTS.md`
  avec son test, au moment de la phase qui la livre. Chaque nouveau fichier et chaque
  nouvelle suite sont rattachés dans `regression-perimeters.json`.

**Critères de réussite (7 jours en prod après la phase 7)**

| Mesure | Aujourd'hui | Seuil |
|---|---|---|
| Discussion, durée active médiane | 151 s | ≤ 60 s |
| Exécutions avec un refus à tort (chemins cités, Livrer mécanique) | 7/10 Discussion, 61 % des Livrer | 0 |
| Développement complet, p95 actif | 6 541 s | ≤ 4 000 s |
| Appels de model par exécution (médiane, hors Développement complet) | 4 à 9 | −40 % |
| Demandes d'action finies en Discussion inerte ou en « rien à livrer » par erreur d'aiguillage | ≥ 3 dans le corpus | 0 |
| Propositions de pipeline sous le seuil ou nommées d'après une seule demande | 13 sur 13 | 0 |
| Pipelines acceptés non exécutables | 1 (`x-7e4cf1`) | 0 |
| Garanties TDD (test rouge, tests intacts à vert, revue, aucun défaut livré) | vérifiées | inchangées (suites d'exigence vertes) |

> Le plan en 8 lignes :
> 0 — chemins cités, Livrer et Mettre en forme par le code, base verte en cache (2 j).
> 1 — Discussion en un appel, étapes à la carte (2 j).
> 2 — briques et composition, Réunion → Courriel (3 j).
> 3 — familles de lacunes, seuil, échelle généraliser / composer / créer (2 j).
> 4 — pipeline Libre, qui avance toujours, et « figer » (3 j).
> 5 — Exploitation, la première famille (1,5 j). 6 — liste vérifiée, session d'item, rouge ciblé, parallélisme (2,5 j).
> 7 — bond et 7 jours de mesure. Chaque phase : interrupteur à chaud, tag de retour, corpus réel rejoué, banc chiffré.
> Dev d'abord, prod par bond décidé par l'utilisateur.

---

## 5. Décisions à soumettre à l'utilisateur

| # | Question | Recommandation |
|---|---|---|
| D1 | Une **action** sans pipeline part en **Libre** (plan montré, critères du code) au lieu d'une question ou d'une Discussion. Cela modifie la ligne « aucun pipeline adapté » du §3.3 de `ROUTAGE-SYNTHESE.md` | **Oui.** Les questions pures restent en Discussion |
| D2 | Approbation du plan Libre | **Plan montré puis exécuté**, pause seulement pour une action irréversible sans autorisation citée ou plus de 10 fichiers ; autre choix : toujours attendre l'accord |
| D3 | Seuil de proposition d'un pipeline | **3 signalements, 2 demandes distinctes, 30 jours** |
| D4 | Composition | **Expansion dans une seule exécution**, profondeur 2 ; autre choix : sous-exécutions séparées (plus d'isolement, frise et pauses plus complexes) |
| D5 | **Livrer par le code** pour tous les pipelines (le model écrit seulement le fragment) | **Oui** : c'est l'étape la plus refusée, et elle devient déterministe |
| D6 | **Discussion en une étape** (les cases `discussion.comprendre/rechercher` deviennent des renvois) | **Oui**, Recherche disponible en brique |
| D7 | Étapes **à la carte** (Maintenance, Incident, Données, Vidéo) choisies par le classifier dans une liste fermée | **Oui** |
| D8 | Models plus légers sur les étapes à critère strict | **Suggestions seulement**, appliquées par vous |
| D9 | Créer **Exploitation** tout de suite d'après les données, ou attendre la consolidation | **Tout de suite** (phase 5) : le besoin est prouvé (3 lacunes, 48 aiguillages forcés) |
| D10 | Nettoyage de l'existant : les 11 rattachements à mots-clés de `custom.attach` et `x-7e4cf1` | **Retirer les rattachements** (inutilisés depuis 0.66.0) ; **remplacer `x-7e4cf1` par Exploitation** |
| D11 | Session partagée par rouge, vert et refactor d'un même item | **Oui** : l'interdiction de toucher aux tests reste vérifiée par le code, et la Revue reste indépendante |
| D12 | Rouge ciblé sur le fichier de test modifié | **Oui, sur opt-in par projet** ; suite complète à vert et à refactor |
| D13 | Ordre par rapport à la Routage v3 | **Phase 0 des pipelines après la phase 1 de la v3** (indépendante : moteur seulement) ; phases 3 et 4 (lacunes, Libre) **après la phase 2 de la v3**, car elles touchent la réponse du classifier |

---

## 6. Points de jonction avec la refonte du Routage (`ROUTAGE-SYNTHESE.md`)

Aucune décision du §5 de la synthèse n'est contredite.

- **§5.3, classement tâche par tâche en parallèle** : inchangé. Le classifier gagne
  deux sorties, `besoin` (lacune structurée, §3.a) et le choix `libre` (§3.b), toujours
  pour une seule tâche.
- **§3.3, ligne « aucun pipeline adapté »** : modifiée si D1 est accepté (Libre au lieu
  d'une tâche gardée en question). Le signalement est gardé et rattaché à une famille.
- **§3.2, actions typées avec postconditions** : la brique « Vérification des
  postconditions » et Exploitation réutilisent les mêmes contrôles. Une tâche classée
  « action du chef » ne produit jamais de lacune et n'entre jamais en Libre.
- **§3.1, la porte de `dispatch.mjs` reste l'unique point d'imposition** : Libre et les
  briques passent par elle.
- **§3.4, registre des demandes** : une exécution (briques comprises) reste **une**
  tâche du registre. Une pause dans une brique fait passer la demande en
  `attend_utilisateur`, avec le chemin « Courriel (dans Réunion) ».
- **§3.7, pannes d'infrastructure** : s'appliquent aux briques et à Libre sans
  changement (0.118.0).
- **§5.4, reprise seulement explicite** : la reprise d'une exécution à briques se fait
  par son identifiant, comme aujourd'hui.
- **§3.5, « le code écrit les faits »** : même principe pour Livrer par le code (§3.d-1).
- **§5.9, rappel** : « les étapes des pipelines des musiciens (test rouge, code vert sans
  toucher aux tests, revue, livraison) ne changent pas ». Ici, leurs **garanties** ne
  changent pas. Livrer par le code garde exactement les mêmes vérifications, mais le
  **faiseur** change. Cela relève de D5, qui demande l'accord explicite.
