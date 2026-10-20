# Pipelines — comparaison des trois études et synthèse (auteur : Opus 5.5)

> Demande de l'utilisateur (2026-10-20, verbatim) :
> « Donc on a etudie le routage, maintenant je voudrais qu'on optimise et arrange les
> pipelines. Retours d'experience :
> - la suggestion de nouveaux pipelines est souvent trop atomiques, et se concentre sur
>   un detail, plutot que de voir the big picture
> - si aucun pipeline est trouve, il faut une action qui ne mene pas a un cul de sac, qui
>   permette d'avancer, et qui peut faire preuve de creativite
> - un pipeline doit pouvoir utiliser ou etre utilise par un autre pipeline (ex :
>   preparer la redaction d'un email peut etre un pipeline utilise par le pipeline de
>   reunion)
> - les pipelines prennent beaucoup de temps, il faut optimiser tout en gardant la
>   predictabilite des actions menees »
> Puis : « On fait comme avec le routage avec Fable, astra et opus. »
> Puis : « Il faut aussi prevoir des cas generique, comme un travail ponctuel sur un
> document ».
>
> Sources comparées :
> - `docs/PIPELINES-REFONTE.md` (Opus 5.5, commit ef3f45e), écrite **avant** l'ajout des
>   cas génériques ;
> - `docs/PIPELINES-SOLUTION-fable.md` (claude-fable-5-1, commit c72fc53) ;
> - `docs/PIPELINES-SOLUTION-astra.md` (gpt-6-astra, commit e2f1596).
>
> Étude seulement : aucun code modifié, aucun redémarrage, rien écrit sous
> `I:\orchestrateur` (journaux lus en lecture seule le 2026-10-20). Attribution de chaque
> idée : **[O]** Opus (étude du commit ef3f45e), **[F]** Fable, **[A]** Astra, **[S]**
> ajout de cette synthèse. Cohérence obligatoire avec `docs/ROUTAGE-SYNTHESE.md` et ses
> décisions de l'utilisateur (§5) : voir §9.

---

## 1. Vérification des chiffres en conflit

Relevé refait en lecture seule sur la prod (`I:\orchestrateur`, servie en **v0.119.0**) :
`logs/runs/*/run.json`, `logs/pipeline-classify.ndjson`, `logs/pipeline-observe.ndjson`,
`model-routing.json`. Scripts jetables sous `.tmp/` (non versionnés).

### 1.1 Valeurs de référence

| Mesure | Valeur vérifiée |
|---|---|
| Dossiers d'exécution | 651, dont **650** avec un `run.json` (`p-20261014T183249-4966c1` vide) |
| Statuts | 637 `done`, 5 `paused`, 2 `interrupted`, 6 `abandoned` |
| Routage du chef / musiciens | 613 / **37** exécutions de musiciens, sur **11** projets |
| Temps mural / actif / somme des étapes (musiciens) | **170,4 h / 6,8 h / 5,7 h** : 96 % du mur est de l'attente |
| `activeMs` inférieur à la somme des étapes | 2 exécutions ([[p-20261009T014516-e88f28]], [[p-20261018T091024-0e199e]]) : `activeMs` n'est pas fiable sur tout l'historique |
| Discussion | 10 `done`, actif médian **134 s** (p95 465 s), 4 appels ; **7 exécutions sur 10** refusées une fois à Comprendre, **toutes** pour « chemins cités inexistants » (7 sur 7) |
| Rédaction | 7 `done`, 241 s, 4 appels ; Mettre en forme toujours sur **opus** (33 s médiane, jusqu'à 1,76 $), **2 fois sur 7 sans aucun fichier modifié** |
| Dev léger | 8 exécutions (4 done) ; actif médian **280 s** (terminées) ou 378 s (toutes) ; p95 642 s ; **6 sur 8** avec au moins un refus |
| Dev complet | 6 exécutions (2 done) ; actif médian 661 s (toutes), p95 6 541 s ; appels de model médians **34** (29, 9, 0, 94, 39, 47) ; 54 étapes médianes |
| Livrer (Dev) | **11 refus sur 18** (léger 8/12, complet 3/6) : 9 « aucun commit créé », 2 « version non incrémentée » |
| [[p-20261018T154104-6cfbe8]] | **9 essais** de Livrer dont **8 refusés**, 330 s ; 642 s actives pour **23,1 h** murales |
| Vert (Dev) | 127 occurrences : 48 ok, 26 refusés (12 « aucune modification », 9 « fichiers de test modifiés »), 38 sautés, 14 `launch_failed` |
| Items déjà couverts (Dev complet) | **35 items sur 72 (49 %)** portent `covered` ; 38 tours Rouge en tout ont conclu « déjà couvert » (léger compris) |
| [[p-20261009T193934-083679]] | 113 étapes, 109 min actives, 423 $ d'équivalent API |
| « git push » [[p-20261019T162957-4ebfbf]] | Maintenance : Dépendances, Historique, Tests instables, Dette joués, Livrer sauté : **rien poussé** |
| Classifier | 255 décisions, 0 échec ; **audit 33**, **maintenance 15**, incident 18, chef 29, `x-7e4cf1` 1 ; 3 lacunes rendues par le model |
| Lacunes observées | **28 signalements, 26 clés distinctes** ; 8 signalements « model / routage » depuis 0.66.0 |
| `gapDecisions` | **15** (12 acceptées, 3 rejetées) → **11** rattachements `custom.attach` + 1 pipeline `x-7e4cf1` (libellé coupé, non exécutable) |
| Mise en service | 20 projets ; **orchestrateur-dev absent** de `enforcement.projects` ; 14 pipelines en service ; Routage du chef coupé |
| 4 pauses mortes du chef | **déjà closes** (`abandoned`, motif de la décision 7) |

### 1.2 Erreurs factuelles relevées

| Auteur | Affirmation | Réalité | Gravité |
|---|---|---|---|
| **Opus** | 651 exécutions, 38 de musiciens | 650 et **37** | faible |
| Opus | Discussion : actif médian 151 s | **134 s** | moyenne (estimations du §3.d calées dessus) |
| Opus | Dev léger : médiane 642 s | 280 s (terminées) ; **642 s est le p95** | moyenne |
| Opus | Dev complet : 56 appels médians | **34** appels de model ; 56 ≈ nombre d'étapes | moyenne |
| Opus | « 38 items sur 87 (44 %) déjà couverts » | mélange des tours Rouge et des items : **35 items sur 72 (49 %)** | faible (conclusion juste) |
| **Fable** | Résumé : « 69 % des items déjà couverts » | son propre corps dit 51 % ; réel **49 %** | moyenne (incohérence interne) |
| Fable | 40 exécutions de musiciens, 10 projets | **37** et **11** | faible |
| Fable | 19 clés de lacunes, 19 `gapDecisions`, « six rattachements acceptés » | **26** clés, **15** décisions, **11** rattachements | moyenne |
| Fable | « chemins cités inexistants » ×5 | **×7**, la totalité des refus de Comprendre | faible |
| Fable | Dev léger : actif médian 7,4 min | 4,7 min (terminées) ou 6,3 min (toutes) | faible |
| Fable | « 18 % » puis « ≈ 30 % » des tâches hors code/question | incohérence interne ; non vérifiable sans relecture humaine des 458 titres | faible |
| **Astra** | — | ses chiffres vérifiés sont **exacts** (650, 37, 134 s, 7/37, 11/18, 26 clés, 15 décisions, pauses du chef déjà closes, anomalie `activeMs`) | — |
| Astra | Dev « gain modeste 0–11 % » | n'exploite pas les 49 % d'items couverts : sous-estime le levier principal du Dev | jugement, pas un chiffre faux |
| Les trois | « profondeur 2 » (Opus, Fable) contre « 3 niveaux » (Astra) | **même règle** : racine + 2 niveaux d'appel | conflit apparent |
| **Documents du dépôt** | `ROUTAGE-SYNTHESE.md` §5.7 : « pas encore exécuté, prod en 0.114.3 » | prod en 0.119.0, les 4 pauses sont closes | à mettre à jour |
| Documents du dépôt | `CLAUDE.md` (0.113.0) : orchestrateur-dev « en service dans les pipelines » | absent de `enforcement.projects` en prod (retiré le 2026-10-19 selon Opus) | à signaler à l'utilisateur |

---

## 2. Comparaison sur les cinq axes

### 2.1 Tableau condensé

| Axe | Opus (ef3f45e) | Fable | Astra | Retenu |
|---|---|---|---|---|
| **a) Lacunes « big picture »** | besoin structuré (famille, résultat, plus proche, écart) ; rattachement par le model à une famille ouverte ; seuil 3/2/30 j ; échelle généraliser → composer → créer ; acceptation exécutable et testée | famille de **résultat** obligatoire dans le classement (liste close de 6) ; besoin `famille/verbe/objet` ; même seuil et même échelle ; panneau « Besoins » | registre d'observations (objectif, livrable, capacité manquante) ; demandes **indépendantes** (relances dédupliquées) ; contre-exemples, coût ; états observé → actif | famille de résultat **[F]** + rattachement par le model **[O]** + indépendance, contre-exemples, états **[A]** |
| **b) Aucun pipeline → avancer** | Libre : plan de briques, pause seulement si irréversible ou > 10 fichiers ; « figer » | `libre` + Vérifier ; tout code passe par un sous-pipeline Dev ; critères dans une liste close ; Figer | « Générique » : plan publié avant tout effet ; sortie **partielle utile** explicite ; aucune autorisation inventée | Libre **[O, F]** + sous-pipeline Dev obligatoire **[F]** + statut « partiel utile » et plan publié avant effet **[A]** |
| **c) Composition** | expansion dans la même exécution ; contrats, profondeur, acyclique, livraison unique ; case dédiée facultative | fils avec son propre `run.json` ; demande du fils composée par le code ; livraison par le parent ; pas de surcharge de model | contrat versionné (identité, droits inclus, idempotence) ; pause ciblée ; budget racine | expansion **[O]** + entrée composée par le code et contrat d'attente **[F]** + droits inclus, identité stable, budget racine **[A]** |
| **d) Vitesse avec prévisibilité** | 11 leviers chiffrés ; Livrer par le code ; Discussion en 1 appel ; à la carte ; liste vérifiée | 7 leviers ; chemins vérifiés sur le journal des lectures ; tri de couverture ; revue groupée ; continuer automatique | instrumentation fine ; arrêt des relances identiques ; preuves réutilisables avec invalidation stricte ; prudence chiffrée | leviers communs **[O, F, A]** + instrumentation et arrêt des relances **[A]** + chemins sur le journal **[F]** ; revue groupée et continuer automatique **non** (§6.3) |
| **e) Cas génériques** | absent (étude antérieure) ; seulement Exploitation | 4 pipelines : `document`, `fichiers`, `operations`, `libre` + 2 variantes | modes d'existants : Rédaction/document, Discussion/inspection, Données/acquisition, opération ponctuelle | 2 pipelines neufs (`operations`, `fichiers`) **[F]** + 2 modes **[A]** + Libre (§3) |
| Simplicité | moyenne | plus de pipelines | plus de concepts (états, versions de contrat) | 3 pipelines neufs, 2 modes, 1 type d'étape |
| Effort annoncé | 16,5 j | 13,5 j | 10–15 j | **≈ 14 j** (§7) |
| Risque | faible (interrupteurs) | faible (interrupteurs) | migration `legacy/shadow/v2` plus lourde | faible : interrupteurs par levier **[O, F]** + mode ombre pour Libre **[A]** |
| Cohérence ROUTAGE §5 | ✓ (D13 ordre) | ✓ | ✓ (tableau §7 exhaustif) | ✓ ; seule la ligne « aucun pipeline adapté » du §3.3 change (décision 1) |
| Qualité des données | 5 erreurs | 7 erreurs, 2 incohérences internes | exacte | — |

### 2.2 Ce que chacun apporte seul

- **Opus** : la preuve de la famille manquante dans le classement (audit ×33, maintenance ×15
  pour des opérations) ; Livrer par le code sur le modèle des fragments `changelog.d/` ;
  Discussion en un appel ; étapes à la carte ; banc `pipeline-bench.mjs` ; réglages figés
  par exécution.
- **Fable** : les **familles de résultat**, qui donnent la « big picture » au classement
  lui-même ; les génériques détaillés avec leurs critères (format préservé, `completer`
  sans suppression, corbeille) ; le **registre d'opérations typées partagé** avec les
  actions du chef ; les chemins cités jugés sur le journal des lectures ; le tri de
  couverture.
- **Astra** : des chiffres exacts et une méthode explicite ; le **résultat partiel utile**
  (jamais déclaré réussi, ne libère aucun successeur) ; l'arrêt d'une relance identique ;
  les droits de l'enfant **inclus** dans ceux du parent ; « préparer n'autorise pas
  envoyer » ; formats bureautiques et documents hostiles ; contre-exemples dans une
  proposition ; la liste des vrais cas à rejouer.

### 2.3 Points faibles écartés

- **Revue groupée [F]** : revient sur « c+d » (0.63.0, test d'exigence). Le tri de
  couverture retire déjà les revues des items couverts, qui faisaient l'essentiel du
  surcoût (youtube-live : 17 revues pour 4 Vert utiles). À réévaluer après mesure.
- **« continuer » automatique [F]** : une limite atteinte est une décision de
  l'utilisateur (n° 5) ; la franchir seul réduit la prévisibilité.
- **Fils avec son propre `run.json` [F]** : deux verrous, deux frises, une réponse de
  pause à relayer. L'expansion garde une seule exécution, avec une identité de sous-bloc.
- **Contrat versionné complet et bascule `legacy/shadow/v2` globale [A]** : trop lourds
  au départ. On garde l'idée utile (exécution figée au départ, mode ombre pour Libre).
- **Session partagée rouge/vert/refactor [O]** : gain estimé faible (−20 % de tours
  d'outil sur Vert), discipline TDD moins visible. Différé.
- **Quatre génériques séparés [F] / tout en modes [A]** : voir §3.2.

---

## 3. Catalogue cible

### 3.1 Vue d'ensemble

| Famille de résultat **[F]** | Pipelines spécialisés (inchangés) | Générique | Briques appelables |
|---|---|---|---|
| `code` | dev, incident, maintenance, audit, nouveau | — (Libre délègue à dev) | Cycle TDD, Revue, Livraison |
| `texte` | redaction, reunion | Rédaction mode **`document`** **[A, F]** | Rédaction, Courriel **[O]** |
| `fichiers` | images, video, audio, donnees, reunion | **`fichiers`** **[F]** | Acquisition, Rangement |
| `systeme` | — | **`operations`** (ex-« Exploitation » **[O]**) **[F, A]** | Opération typée, Vérification des postconditions |
| `information` | discussion, recherche | Discussion variante **`verification`** **[F, A]** ; Recherche mode **`interne`** **[F]** | Recherche, Inspection |
| `supervision` | — | **jamais un pipeline** : actions typées du chef (ROUTAGE §3.2) **[O, F, A]** | — |
| (aucune) | — | **`libre`** **[O, F, A]** | toutes |

Bilan : **3 pipelines neufs** (`operations`, `fichiers`, `libre`), **3 modes ou variantes**
(`redaction/document`, `discussion/verification`, `recherche/interne`), **0 pipeline `x-`**.
Classement : spécialisé avant générique, générique avant Libre, Libre avant Discussion
pour une **action** ; une **question** reste en Discussion **[F]**.

### 3.2 Pourquoi 3 pipelines neufs et pas 4 ni 0 [S]

- `document` reste un **mode de Rédaction** **[A]** : mêmes cases Rédiger / Relire, mêmes
  livrables textuels. Les critères de Fable s'y appliquent.
- `fichiers` est un **pipeline** **[F]** : copier, déplacer, télécharger, comparer ne sont
  ni de l'analyse de données (Données), ni de la Réunion. Il généralise
  `meeting-check.mjs` et sert Réunion, Vidéo et Données (acquisition simple **[A]**).
- `operations` est un **pipeline** : le besoin est prouvé (3 lacunes « déploiement »,
  48 aiguillages forcés), et il partage son registre avec les actions du chef.

### 3.3 Contrats des génériques

**Rédaction, mode `document`** — travail ponctuel sur un document existant **[F, A]**

| Étape | Qui | Critères vérifiés par le code |
|---|---|---|
| Cibler | code si la demande nomme un seul fichier existant, sinon model (sonnet) | `cible.json {fichiers ≤ 5, operation ∈ relire-corriger · resumer · traduire · reformater · completer · convertir, sortie: remplacer|nouveau}` ; fichiers existants, dans le projet ou cités par l'utilisateur (`userSaid`) |
| Modifier | model, case `redaction.document.<operation>` | seuls les fichiers ciblés changent (`onlyGlobs`) ; diff non vide sauf `DOCUMENT_DEJA_CONFORME` ; format préservé (extension, encodage, fins de ligne, front-matter, JSON/YAML/TOML analysables, titres `##` non perdus sauf résumé ou conversion) ; longueur ±25 % pour corriger/reformater, < 50 % pour résumer ; langue cible (`detectLanguage`) pour traduire ; `completer` sans suppression ; résumé ou traduction vers un **nouveau** fichier sans écraser la source **[A]** |
| Relire | model, `use: redaction.relire` | seulement en mode complet ou au-delà de 80 lignes de diff **[F]** |
| Livrer | code | commit des seuls fichiers ciblés, sans version ; sans git : sauvegarde + empreinte + diff **[A]** |

Formats DOCX/ODT/PPTX/PDF : intégrité du conteneur et rendu ; sinon refus explicite
« format non pris en charge » au lieu d'un faux succès **[A]**. Le contenu d'un document
est une **donnée**, jamais une source de droits **[A]**. Un document protégé (spécification
exécutable, test d'exigence) passe en Dev **[A]**.

**`fichiers`** — acquérir, copier, déplacer, renommer, comparer, supprimer **[F]**

| Étape | Qui | Critères |
|---|---|---|
| Inventorier | model (sonnet) | `operations.json` : opérations d'une liste close, sources existantes ou URL, destinations dans le projet, 50 au plus ; `supprimer` avec raison ⇒ pause `doutes` comme Réunion |
| Exécuter | **code** (copier, déplacer, renommer, supprimer vers la corbeille `logs/runs/<run>/corbeille/`) ; model pour acquérir (outil local `yt-dlp` possible) | chaque destination existe, taille > 0, média valide (`ffprobe`), **rien d'autre n'a changé** |
| Vérifier | code (tableau) ; model seulement pour commenter une comparaison | `verification.md` écrit par le code |
| Livrer | code, `ifChanged`, binaires exclus | — |

**`operations`** — git, release, déploiement, appareil, service **[F, O, A]**

- Registre **`scripts/typed-operations.mjs`**, **le même** que les actions typées du chef
  (ROUTAGE §3.2) : `{id, argv(params), préconditions, postcondition, irréversible}`.
  Première liste : `git_push`, `git_tag`, `git_restore`, `prod_jump` (plan seul sans
  autorisation, `--apply` jamais lancé par un musicien sur la prod : décision de
  l'utilisateur **[S]**), `copy_build`, `adb_install`, `service_restart` et `run_script`
  déclarés dans `.orchestrateur/pipeline.json`.
- Étapes : Préparer (model sonnet, sauté si la demande nomme une seule opération) →
  Autoriser (code : pause si irréversible sans citation de l'utilisateur) → Exécuter
  (**code**, argv en tableau, arrêt à la première postcondition fausse) → Rapporter (code).
- Une installation, un bond ou un envoi n'est **jamais** autorisé implicitement **[A]**.
- Un **code retour seul ne vaut jamais « fait »** : la postcondition est relue
  (`git ls-remote`, `versionCode` installé, PID et `/api/version`) **[O, F, A]**.

**Discussion, variante `verification`** **[F, A]** : `verification.json {constats:
[{affirmation, observe, preuve, verdict}]}`, chaque preuve vérifiable (chemin lu, sortie
de commande, URL), projet inchangé. Pour « vérifie que… », « compare… ».

**Recherche, mode `interne`** **[F]** : sources = dépôt et journaux, web sauté.

### 3.4 Libre

| Étape | Qui | Vérifié par le code |
|---|---|---|
| Planifier | model, case `libre.planifier` (opus) | `plan.json` : objectif, **résultat attendu**, 1 à 6 étapes ; chaque étape = une brique ou un pipeline du catalogue, ou une étape improvisée typée `judge|action` ; critères pris dans la **liste close** **[F]** ; fichiers modifiables (`onlyGlobs`) ; effets externes marqués `irreversible` ; **toute modification de code = sous-pipeline Dev** (léger) **[F]** |
| Annoncer | code | plan dans `run.json` et dans la frise **avant tout effet** **[A]**, notifié au chef ; **une seule pause** si effet irréversible sans citation, chemin hors projet non cité, ou plus de 10 fichiers **[O, F]** ; sinon départ immédiat |
| Étapes du plan | model ou code, selon la brique | critères de la brique + critère du plan ; **aucune extension silencieuse** : un besoin nouveau = pause « plan à revoir » **[O]** |
| Vérifier | model (sonnet) + code | un constat par résultat attendu ; un constat faux renvoie **une fois** à l'étape fautive, puis pause **[F]** |
| Livrer | code | `ifChanged` ; version seulement si une étape Dev a tourné (fragment) |
| Figer | code | signature du plan versée au besoin (§4) ; plans semblables au seuil ⇒ proposition « figer » **[O, F]** |

Liste close des critères **[F]** : `fichier_existe`, `fichier_absent`,
`seulement_ces_fichiers_changent`, `diff_non_vide`, `aucun_changement`,
`commande_retourne_0`, `url_repond`, `texte_contient`, `suite_verte`,
`postcondition_operation`, `media_valide`. Tous existent ou sont triviaux.

Garde-fous : 6 étapes au plus, **comptées après expansion des briques** **[A]** ;
1 replanification ; 45 min actives ; 12 appels ; Libre n'appelle pas Libre ; jamais pour
le chef ; `--hors-pipeline` garde son sens actuel.

---

## 4. Règles des lacunes

1. **Une lacune est un besoin, pas un pipeline** **[O, F, A]**. Le classifier rend, pour
   **une** tâche (ROUTAGE §5.3) : `famille` (liste close §3.1, obligatoire **[F]**),
   `pipeline | null`, et si besoin `besoin {resultat_attendu, plus_proche, ecart}` **[O]**.
2. **Jamais une lacune** pour la famille `supervision` (action du chef), une réponse, une
   autorisation (« oui, hors pipeline ») ou une contrainte (« sur dev ») **[O, F, A]**.
3. **Registre en fichiers** `logs/pipeline-needs/` (propriétaire unique
   `scripts/pipeline-needs.mjs`, verrou, écriture atomique) **[O, F]** — pas de base de
   données (ROUTAGE §5.1).
4. **Rattachement par le model, dans une liste fermée** : au signalement, un appel court
   (case `routage.classifier`) choisit un groupe ouvert ou « nouveau » **[O]**. Le code ne
   regroupe jamais par mots (0.66.0).
5. **Compter des demandes indépendantes** : dédoublonnage par demande source et tâche ;
   une relance ne compte pas **[A]**.
6. **Seuil** : 3 signalements, ≥ 2 demandes indépendantes, 30 jours **[O, F, A]**. Une
   demande explicite de l'utilisateur déclenche l'étude sans attendre **[A]**.
7. **L'information remonte dès le 1er signalement** (règle 0.42.0) : « exécuté en Libre,
   besoin X observé 1/3 » **[O]**.
8. **Échelle de proposition**, chaque rejet justifié : élargir un pipeline (mode, variante,
   étape facultative) → composer des briques (plan Libre figé) → créer **[O, F, A]**.
9. **Contenu d'une proposition** : libellé de famille et de verbe (≤ 60 caractères, jamais
   un extrait coupé), 3 exemples réels, **2 contre-exemples** et un coût d'entretien
   **[A]**, critères de la bibliothèque pour chaque étape **[O, F]**.
10. **Accepter = exécutable** : définition reconnue par le moteur, cases de la page Models
    créées, exécution d'essai sur fixture verte **avant** la mise en service ; états
    observé → regroupé → proposé → accepté → exécutable validé → actif **[A]**.
11. **Le classifier ne voit que des pipelines exécutables** **[A]** (fin de `x-7e4cf1`).
12. **Reprise de l'historique** : les 26 clés deviennent des besoins historiques ; les
    3 lacunes « déploiement » forment le premier groupe, satisfait par `operations`.

---

## 5. Parcours sans cul-de-sac

```
tâche classée ─► pipeline spécialisé ── étape inadaptée ? → à la carte (§6.1, levier 7)
             ├─► générique (operations · fichiers · redaction/document · discussion/verification)
             ├─► question pure ─► Discussion
             ├─► action sans pipeline ─► Libre : plan publié ─► étapes vérifiées ─► résultat
             │                                    └─ irréversible non cité ─► 1 pause ciblée
             ├─► supervision ─► action typée du chef (ROUTAGE §3.2)
             └─► classifier en échec ─► `à_classer` (ROUTAGE §3.3) ; panne ─► garée (0.118.0)
```

**Statuts de sortie de toute exécution** **[A]** : réussi · **partiel utile** (manque
explicite : inventaire, diagnostic, brouillon à trous `[À COMPLÉTER : …]`, prochaine
action et responsable) · attend l'utilisateur · garé (infrastructure) · échec
récupérable · annulé. Un partiel n'est **jamais** déclaré réussi et **ne libère aucun
successeur** (0.115.1).

**Règle vérifiée par test** **[S, d'après ROUTAGE §3.4]** : tout état non terminal a une
sortie par le chat, une par commande, une par bouton, ou un événement attendu avec
échéance. Toute action demandée finit par **un effet vérifié ou une question explicite**.

**Arrêt des relances sans progrès** **[A]** : même motif de refus et même empreinte de
l'arbre sur deux essais ⇒ plus de nouvel essai automatique, diagnostic ciblé dans la
pause ([[p-20261018T154104-6cfbe8]] : 8 refus identiques).

---

## 6. Composition et optimisations

### 6.1 Composition

| Point | Règle | Source |
|---|---|---|
| Déclaration | étape `kind: 'call'` (`pipeline`, `mode`, `with`, `expect`, `deliver: 'parent'`) ; `use: 'pipeline.étape'` pour une étape seule | **[O, F]** |
| Exécution | **expansion dans la même exécution** au calcul du plan : un `run.json`, un verrou de tour, un couloir, une frise ; artefacts sous `sub/<n>-<brique>/` ; identité de sous-bloc stable (`callNodeId`) pour la reprise | **[O, A]** |
| Entrée | `demande.md` du sous-bloc **composée par le code** (demande du parent + artefacts cités en inclusion textuelle, jamais un résumé de model) | **[F]** |
| Droits | ceux du sous-bloc **inclus** dans ceux du parent (fichiers, effets) | **[A]** |
| Sortie | contrat `expect` vérifié par le code (artefact, sections, fichiers changés ⊆ autorisés, suite verte si le parent a des tests) | **[F]** |
| Critères | ceux de la brique, **jamais affaiblis** ; l'appelant peut en ajouter | **[O, A]** |
| Profondeur | racine + 2 niveaux d'appel ; quatrième niveau refusé avant lancement | **[O, F, A]** |
| Anti-boucle | graphe d'appel acyclique vérifié au chargement (catalogue refusé en entier sinon) **et** pile d'expansion à l'exécution ; Libre n'appelle pas Libre | **[O, F, A]** |
| Budget | un seul budget racine (durée active, appels, tours de revue, nœuds) ; une pause ne remet aucun compteur à zéro | **[O, A]** |
| Livraison | une seule, par le parent ; aucun double commit ni double incrément | **[O, F, A]** |
| Pauses | la pause d'un sous-bloc **est** la pause de l'exécution, avec son chemin « Courriel (dans Réunion), étape Relire » ; « continuer » reprend ce point ; « abandonner » clôt l'exécution ; pannes d'infrastructure inchangées (0.118.0) | **[O, F, A]** |
| Models | cases du sous-bloc (`redaction.rediger`), **sans surcharge** au départ ; renvoi `ref` sur la page Models | **[F, A]** |
| Frise | bloc « ↳ Rédaction 2/3 » indenté sous l'étape d'appel, déplié pendant l'exécution ; durées non comptées deux fois | **[O, F, A]** |
| Effets | **préparer n'autorise pas envoyer** : un envoi est un effet séparé, autorisé et vérifié | **[A]** |
| Première migration | Réunion → Rédaction (copie `fromPipeline` remplacée par `call`) ; `_test_reunion_redaction_route.mjs` **vert sans modification** ; nouvelle brique Courriel (jamais envoyé) | **[O, F, A]** |

### 6.2 Optimisations chiffrées

Mesures de référence au §1.1 ; « après » = estimation à confirmer par le banc.

| # | Levier | Source | Gain estimé | Ce qui garde la prévisibilité |
|---|---|---|---|---|
| 1 | **Chemins cités** : accepter un chemin lu pendant le tour (`tool_use` Read/Glob/Grep) ou précédé d'un marqueur d'absence ; ignorer les noms d'artefacts de l'orchestrateur et les chemins d'un autre projet (signalés, pas refusés) | **[F, O]** | Discussion : 7 refus sur 10 exécutions → ~0 ; −40 à −120 s par exécution touchée | une affirmation positive reste vérifiée sur le disque |
| 2 | **Livrer par le code** : version, CHANGELOG, ligne d'exigence et commit depuis un fragment (`changelog.d/`, 0.102.0) écrit par la dernière étape d'action | **[O, F, A]** | −1 appel (31 s) et 11 refus sur 18 évités ; [[p-20261018T154104-6cfbe8]] : −330 s, et surtout la pause | mêmes vérifications qu'aujourd'hui, devenues déterministes |
| 3 | **Mettre en forme par le code** quand la relecture rend des corrections structurées ou aucune ; étape model gardée pour une correction ambiguë | **[O, F, A]** | Rédaction : −33 s et un appel opus (jusqu'à 1,76 $) ; 2 sur 7 n'avaient rien à appliquer | règle de 0.65.0 inchangée : une correction listée est appliquée |
| 4 | **Résultat de suite mémorisé** par empreinte (arbre + commande + version d'outil), invalidé au moindre changement, même en cours | **[O, F, A]** | 2 à 10 min par exécution sur orchestrateur-dev ; 10–20 s ailleurs | jamais de preuve réutilisée sur un arbre différent |
| 5 | **Arrêt des relances identiques** (§5) et **instrumentation** `modelMs/checkMs/waitMs/queueMs` | **[A]** | évite les boucles de type 8 refus ; rend les gains mesurables | décision par le code, tracée |
| 6 | **Discussion en un appel** (Comprendre + Répondre en lecture seule, sections et preuves) ; Recherche appelée en brique si le web est nécessaire | **[O, A]** ; Fable : 2 appels | 134 s → **≈ 50–70 s** ; 4 → 1 appel | lecture seule et chemins vérifiés par le code |
| 7 | **Étapes à la carte** (Incident, Vidéo, Données, Maintenance) : choix par le classifier dans une **liste fermée**, gardé dans `run.json`, étapes écartées affichées « sautée — non requise : raison » | **[O]** ; léger étendu **[A]** | Incident 814 → ≈ 600 s ; Vidéo 791 → ≈ 650 s ; Données 357 → ≈ 220 s | plan figé avant la première étape |
| 8 | **Génériques** (§3) au lieu d'un pipeline inadapté | **[F, A]** | push : 192 s et rien poussé → ≈ 30–60 s + commande, vérifié ; reel : 7 appels → 2 ; 2 lignes de TODO : 5 appels → 1 | postconditions vérifiées par le code |
| 9 | **Tri de couverture à la Liste de tests** : un item déjà couvert y porte sa preuve (`fichier:test` ou commit), vérifiée par le code (`coveredProof`, et le test cité existe et passe) ; il n'entre pas dans la boucle | **[O, F]** | 35 items sur 72 : ≈ 35 tours Rouge opus (≈ 51 s chacun), leurs suites et leurs revues évités ; Dev complet −30 à −45 % | le Rouge reste obligatoire pour tout item nouveau ; `DEJA_COUVERT` en 4a reste valable |
| 10 | **Juges indépendants en parallèle** (Audit : revue manuelle ∥ second avis ; lectures indépendantes de la Recherche), 2 branches au plus | **[O, F, A]** | Audit −1,5 min | lecture seule, même arbre figé |
| 11 | **Models plus légers** là où un critère strict juge : **suggestions** sur la page Models, appliquées par l'utilisateur | **[O, F, A]** | Rouge simple/mécanique en sonnet : −40 % du coût de la boucle | aucune case changée d'office, aucun repli silencieux |
| 12 | **Rouge ciblé** (`testFileCommand`, opt-in par projet) ; suite complète exigée à Vert et Refactor | **[O]** | −10 à −60 s par Rouge selon la suite | garantie de non-régression inchangée à Vert |

**Estimation consolidée** (durée active médiane, mêmes models) :

| Pipeline | Aujourd'hui | Après | Leviers |
|---|---|---|---|
| Discussion | 134 s, 4 appels, 70 % refusés à tort | **≈ 60 s, 1 appel, ~0 %** | 1, 6 |
| Rédaction | 241 s, 4 appels | **≈ 170 s, 2 appels** | 2, 3 |
| Dev léger | 280 s (terminées), 61 % des Livrer refusés | **≈ 220 s, Livrer sans refus mécanique** | 2, 4, 5, 12 |
| Dev complet | 661 s, p95 6 541 s, 34 appels | **≈ 420 s, p95 ≤ 4 000 s, ≈ 20 appels** | 2, 4, 9, 11, 12 |
| Incident / Vidéo / Données | 814 / 791 / 357 s | ≈ 600 / 650 / 220 s | 2, 7 |
| Opérations, fichiers, document (mal aiguillés aujourd'hui) | 190–360 s, sans effet ou effet non vérifié | **30–120 s + durée de la commande**, effet vérifié | 8 |

Les **96 % d'attente** ne sont pas comptés : ils dépendent des réponses aux pauses.
Leviers 1, 2, 5 et 8 retirent les pauses évitables (environ un tiers des pauses du
corpus) ; les pannes d'infrastructure sont déjà garées (0.118.0).

### 6.3 Écarté ou différé

Revue groupée par 3 items **[F]**, « continuer » automatique **[F]**, session partagée
rouge/vert/refactor **[O]** : voir §2.3 et décisions 13 à 15.

---

## 7. Garanties TDD des pipelines de code — inchangées

- Test **rouge** obligatoire pour tout item nouveau ; la preuve « déjà couvert » est
  vérifiée par le code (0.50.0, 0.57.2).
- **Vert sans toucher aux tests**, vérifié par le code (empreintes) ; suite complète verte.
- **Revue indépendante par item** (0.63.0), autre session, model choisi par l'utilisateur.
- **Tout défaut bloque la livraison** et est rapporté aussitôt (0.65.0) ; « accepter »
  reste la seule autre voie.
- **Livraison par item** (0.64.0) ; une seule version par exécution (0.114.1).
- Limites `LIMITS` inchangées ; 1 à 2 tests par item (0.61.0, 0.62.0).
- Une composition ou Libre ne peut **ni** déclarer « vert » sans preuve, **ni** livrer un
  défaut, **ni** modifier du code hors sous-pipeline Dev **[F, A]**.
- Le **faiseur** de Livrer change (le code au lieu d'un model) ; ses **vérifications**
  restent identiques (décision 9).

---

## 8. Plan par phases

### 8.1 Règles communes

- **Prod/dev** : développement et non-régression dans `orchestrateur-dev` (bac à sable
  sur le port 7778, faux claude, fixtures) ; tag `vX.Y.Z` ; **bond décidé par
  l'utilisateur** (`prod-jump.mjs`, non-régression par périmètre). Tag de retour
  `pre-pipelines-<phase>-vX.Y.Z` avant chaque phase. Observation réelle **en prod
  seulement**, après le bond (orchestrateur-dev n'a ni chef vivant ni projet en service).
- **Bascule à chaud** **[O, F]** : `model-routing.json` → `pipelinesV2 {citedPathsLog,
  codeDeliver, codeFormat, suiteCache, identicalRetryStop, discussionOne, aLaCarte,
  generic, composition, needs, libre, coverageTriage, parallelJudges, targetedRed}`,
  écrit par `pipeline-enforce.mjs v2 <clé> on|off` (`v2 off --all` = retour arrière),
  relu à chaque dispatch. Chaque clé à `false` rend exactement le comportement actuel.
- **Une exécution fige ses réglages au départ** (`run.json.v2`) : une reprise rejoue le
  même plan ; une pause existante finit dans son moteur d'origine **[O, F, A]**.
- **Mode ombre** pour Libre et les familles : plan et classement produits et journalisés,
  aucun effet, avant la mise en service **[A]**.
- **Tests sur la configuration** : une suite ne lit jamais l'état réglable réel ; elle
  passe par `tests/real-config.mjs` (0.119.0).
- **Exigences** : chaque demande de ce document entre dans `docs/USER_REQUIREMENTS.md`
  avec son test, à la phase qui la livre ; chaque fichier et suite rattachés dans
  `regression-perimeters.json` (périmètre `pipelines`).

### 8.2 Phases

| Phase | Contenu | Effort | Critère de sortie (banc + corpus) | Ordre / Routage v3 |
|---|---|---|---|---|
| **0 — gains rapides** | leviers 1, 2, 3, 4, 5 ; `pipeline-bench.mjs` **[O, F]** ; le classifier ne reçoit que des pipelines exécutables **[A]** ; `famille` journalisée en observation **[F]** | 2 j | 0 refus « chemins cités » à tort sur les 7 cas ; Livrer sans refus mécanique sur [[p-20261018T154104-6cfbe8]] rejoué ; aucune suite relancée sur un arbre identique | **tout de suite**, en parallèle de la phase 1 du Routage v3 (moteur seul, sans lien) |
| **1 — génériques** | `typed-operations.mjs` + `operations` ; `fichiers` (`files-check.mjs`) ; `redaction/document` ; `discussion/verification` ; `recherche/interne` ; levier 6 ; descriptions du classement | 3,5 j | corpus : push, reel, TODO, APK, bond, comparaison de dossiers vont au bon générique ; postconditions vérifiées ; Discussion ≤ 70 s | `typed-operations.mjs` écrit **une fois**, partagé avec les actions typées de la phase 2 du Routage v3 (celle des deux qui passe d'abord le crée) |
| **2 — composition** | étape `call`, `use`, contrats, droits inclus, profondeur, graphe acyclique, frise imbriquée ; Réunion → Rédaction migrée ; brique Courriel | 3 j | `_test_reunion_redaction_route.mjs` vert **sans modification** ; Réunion → Courriel de bout en bout ; cycle et 4ᵉ niveau refusés | indépendante |
| **3 — besoins et Libre** | `pipeline-needs.mjs`, rattachement, seuil, échelle, acceptation exécutable, panneau « Besoins » ; Libre (mode ombre d'abord), statut partiel utile, Figer ; nettoyage `x-7e4cf1` et `custom.attach` | 3,5 j | les 26 clés donnent ≤ 5 besoins, dont « déploiement » ; 0 proposition sous le seuil ; « vérifie la collection », « rapatrier via Tailscale » aboutissent avec plan annoncé | **après la phase 2 du Routage v3** (contrat du classement et ligne §3.3 stabilisés) |
| **4 — vitesse 2** | leviers 7, 9, 10, 11, 12 ; bouton « lancer un Incident sur la base » dans la pause `precondition` **[F]** | 2 j | Dev complet rejoué : 0 appel par item couvert, p95 ≤ 4 000 s ; suites d'exigence TDD vertes inchangées | indépendante |
| **5 — bascule et mesure** | bond ; `pipelinesV2` activé sur `pipelineLab`, puis sur `enforcement.projects` ; 7 jours de banc ; retrait de la copie `fromPipeline` et du panneau Lacunes **sous les conditions de la décision 9 du Routage** | 0,5 j + 7 j | §8.4 | peut partager le bond de la phase 4 du Routage v3, avec des interrupteurs distincts |

Total ≈ **14,5 jours**, hors observation.

### 8.3 Tests

- **Corpus réel anonymisé** `tests/pipeline-corpus/` (dépôt public : projets renommés,
  textes abrégés, aucun mail ni secret **[A]**), rejoué par le faux claude
  (`_test_pipeline_corpus.mjs`, dans `SERIAL_SUITES`) **[O, F, A]** :
  - les 7 refus « chemins cités » de Discussion et celui d'Incident ;
  - [[p-20261018T154104-6cfbe8]] (Livrer ×9) ; [[p-20261019T163311-e4336f]] (`green`,
    conflit avec une exigence antérieure : signalé, aucun test affaibli **[A]**) ;
    [[p-20261019T144511-44d707]] (`duration`, suite de 20 min) ;
    [[p-20261009T193934-083679]] (113 étapes, `launch`) ;
    [[p-20261018T091024-0e199e]] et [[p-20261009T014516-e88f28]] (items couverts) ;
    [[p-20261016T155123-18ff0c]] (`aside_conflict`) ;
  - mauvais aiguillages : [[p-20261019T162957-4ebfbf]] (push), [[p-20261019T150341-318fcf]]
    (reel), [[p-20261019T145920-68172b]] (TODO), [[p-20261016T132118-ddfd3b]] (rangement
    en Maintenance), [[p-20261012T152601-2e8a3b]] (récupération vidéo) ;
  - [[p-20261016T155415-e67865]] (Réunion qui était un mail) ;
  - les 28 signalements de lacunes.
- Nouvelles suites : `_test_cited_paths_log`, `_test_code_deliver`, `_test_suite_cache`,
  `_test_identical_retry_stop`, `_test_typed_operations`, `_test_generic_document`,
  `_test_generic_files`, `_test_pipeline_composition`, `_test_pipeline_needs`,
  `_test_pipeline_libre` (dont injection de crash : un effet au plus **[A]**),
  `_test_coverage_triage`, `_test_a_la_carte`, `_test_v2_switches` (bascule à chaud,
  réglages figés), `_test_no_dead_end` (chaque état non terminal a ses sorties),
  `_test_pipeline_bench`.
- HTTP `pipeline-v2`, `pipeline-child`, `pipeline-needs`, `pipeline-libre` ; navigateur
  `run-child-timeline`, `libre-plan-announce`, `needs-panel` (bureau et mobile).
- **Tests d'exigence existants gardés intacts** : `_test_pipeline_gates`,
  `_test_item_review`, `_test_item_delivery`, `_test_item_tests`, `_test_tests_per_item`,
  `_test_pipeline_covered`, `_test_defect_blocks`, `_test_release_prebump`,
  `_test_lane_changelog_rule`, `_test_reunion_pipeline`, `_test_reunion_redaction_route`,
  `_test_no_lexical_routing`, `_test_pipeline_gaps`, `_test_pipeline_observe`,
  `_test_pipeline_catalog`, `_test_pipeline_engine`, `_test_presenter_artefact`. Une
  assertion qui changerait ne change qu'avec l'accord de l'utilisateur (décisions marquées
  ⚠ au §10).

### 8.4 Critères de réussite (7 jours en prod)

| Mesure | Aujourd'hui | Seuil |
|---|---|---|
| Discussion : actif médian / appels / refus à tort | 134 s / 4 / 7 sur 10 | ≤ 70 s / 1 / 0 |
| Livrer : refus mécaniques | 11 sur 18 | 0 |
| Dev complet : p95 actif ; appels par item couvert | 6 541 s ; 1 à 3 | ≤ 4 000 s ; 0 |
| Appels de model par exécution hors Dev complet (médiane) | 4 à 9 | −40 % |
| Actions finies sans effet vérifié ni question (culs-de-sac) | ≥ 4 dans le corpus | 0 |
| Tâches `systeme` / `fichiers` / document existant routées vers un générique | 0 % | ≥ 80 % |
| Propositions sous le seuil ou nommées d'après une demande | toutes | 0 |
| Pipelines acceptés non exécutables | 1 (`x-7e4cf1`) | 0 |
| Suites relancées sur un arbre identique | systématique | 0 |
| Garanties TDD | vérifiées | inchangées (suites d'exigence vertes) |
| Sûreté **[A]** | — | 0 effet hors périmètre, 0 doublon d'effet, 0 reprise implicite, 0 successeur libéré sur pause ou partiel |

---

## 9. Cohérence avec la refonte du Routage

| ROUTAGE-SYNTHESE | Application ici |
|---|---|
| §5.1 registre en fichiers | besoins, opérations, sous-blocs : fichiers, verrou, écriture atomique ; aucune base |
| §5.2 tour unique du chef (sonnet) | inchangé ; Libre est exécuté par le musicien, jamais par un tour du chef |
| §5.3 classement par tâche, en parallèle | inchangé ; la sortie gagne `famille`, `besoin` et le choix `libre` |
| §5.4 reprise seulement explicite | une exécution à sous-blocs se reprend par son identifiant ; un identifiant cité ne reprend rien |
| §5.5 réveils par le code | l'avancement d'un sous-bloc est traité par le code |
| §5.6 Routage coupé en prod | les pipelines des musiciens n'en dépendent pas : la porte de `dispatch.mjs` classe et impose |
| §5.7 pauses mortes | closes le 2026-10-20 ; §5.7 mis à jour |
| §5.8 actions du chef par commande | `typed-operations.mjs` commun ; `supervision` ne devient jamais un pipeline |
| §5.9 regroupement des suites sous conditions | appliqué au retrait de `fromPipeline` et du panneau Lacunes (phase 5) |
| §3.3 « aucun pipeline adapté » | **modifié si la décision 1 est acceptée** : Libre pour une action, Discussion pour une question, signalement gardé |
| §3.7 pannes d'infrastructure | s'appliquent sans changement aux sous-blocs, aux génériques et à Libre |
| rappel final du §5 (étapes TDD inchangées) | garanties inchangées (§7) ; seul le faiseur de Livrer change (décision 9, ⚠) |

---

## 10. Décisions à soumettre à l'utilisateur

Cette liste remplace les 13 décisions d'Opus, les 12 de Fable et les 8 d'Astra. ⚠ = touche
un test d'exigence existant : accord explicite requis.

1. **Quand aucun pipeline ne convient à une action**, la lancer dans un pipeline
   « Libre » (plan montré, chaque étape contrôlée) au lieu d'une Discussion ou d'une
   question. **Recommandé : oui.** Une simple question reste en Discussion. Cela change
   une ligne de la synthèse du Routage.
2. **Feu vert du plan Libre** : le plan est affiché puis exécuté ; il ne s'arrête pour vous
   demander que s'il prévoit une action irréversible (push, suppression, installation,
   envoi) que vous n'avez pas déjà demandée, un fichier hors du projet, ou plus de
   10 fichiers. **Recommandé : oui** (autre choix : toujours attendre votre accord).
3. **Code dans Libre** : toute modification de code passe par le pipeline Développement,
   avec ses tests. **Recommandé : oui.**
4. **Cas génériques** : créer deux pipelines (« Opérations » : push, tag, publication,
   installation, redémarrage ; « Fichiers » : télécharger, copier, ranger, comparer) et
   trois modes d'existants (Rédaction « document existant », Discussion « vérification »,
   Recherche « interne »). **Recommandé : oui.** Autres choix : 4 pipelines séparés
   (Fable) ou seulement des modes (Astra).
5. **Actions irréversibles d'« Opérations »** : votre demande écrite suffit comme
   autorisation si elle cite l'action ; sinon une pause. Un bond de prod n'est jamais
   appliqué par un musicien. **Recommandé : oui.**
6. **Proposer un nouveau pipeline** seulement après 3 signalements venus d'au moins
   2 demandes différentes en 30 jours, en essayant d'abord d'élargir puis de combiner
   l'existant ; une proposition n'est active qu'après un essai réussi. **Recommandé :
   oui.** Vous pouvez toujours en demander un directement. ⚠ peut toucher
   `_test_pipeline_gaps.mjs` (forme des lacunes).
7. **Nettoyage** : retirer le pipeline inutilisable `x-7e4cf1` (remplacé par
   « Opérations ») et les 11 rattachements à mots-clés devenus inertes, avec sauvegarde.
   **Recommandé : oui.**
8. **Un pipeline qui en utilise un autre** (Réunion → Rédaction d'un mail) : les étapes du
   second s'insèrent dans la même exécution, une seule frise, une seule livraison, deux
   niveaux d'appel au plus, sans changer les models des étapes appelées. **Recommandé :
   oui.**
9. **Livraison faite par le programme** (version, CHANGELOG, commit) au lieu d'un model :
   mêmes vérifications, plus de refus « aucun commit créé ». **Recommandé : oui.**
   ⚠ touche `_test_item_delivery`, `_test_release_prebump`, `_test_lane_changelog_rule`.
10. **Discussion en un seul appel** (au lieu de 3), la Recherche restant appelée si le web
    est nécessaire. **Recommandé : oui.** ⚠ probablement `_test_pipeline_catalog` et
    `_test_pipeline_engine` (étapes de la Discussion).
11. **Étapes « à la carte »** pour Incident, Vidéo, Données et Maintenance : seules les
    étapes utiles sont jouées, choisies dans une liste fermée, les autres affichées
    « sautées » avec la raison. **Recommandé : oui.**
12. **Items déjà couverts écartés dès la liste de tests**, preuve vérifiée par le
    programme : la moitié des items mesurés n'aurait plus coûté de tour. **Recommandé :
    oui.** Le test rouge reste obligatoire pour tout item nouveau (n'affaiblit pas
    `_test_pipeline_covered`).
13. **Revue groupée par 3 items** au lieu d'une revue par item. **Recommandé : non pour
    l'instant**, à revoir après la décision 12. ⚠ revient sur votre choix « c+d »
    (`_test_item_review`).
14. **« continuer » automatique** quand la limite d'items est un peu dépassée.
    **Recommandé : non** : une limite atteinte reste votre décision.
15. **Accélérations TDD optionnelles** : test rouge limité au fichier modifié (activé
    projet par projet, suite complète toujours exigée ensuite) **recommandé : oui** ;
    même session pour test rouge, code et nettoyage **recommandé : plus tard, après
    mesure**.
16. **Models plus légers** sur les étapes à critère strict : de simples suggestions sur la
    page Models, que vous appliquez. **Recommandé : oui.**
17. **Ordre** : gains rapides tout de suite (en parallèle du Routage), puis génériques,
    composition, et Libre après la phase 2 du Routage ; mise en prod par bond décidé par
    vous, `pipelineLab` d'abord. **Recommandé : oui.**
18. **orchestrateur-dev** n'est plus en service dans les pipelines en prod, alors que
    `CLAUDE.md` dit le contraire : le remettre en service, ou corriger la documentation ?
    **Recommandé : corriger la documentation maintenant**, et le remettre en service
    après le bond de la phase 0.

---

## 11. Décisions de l'utilisateur (2026-10-20)

Réponse de l'utilisateur au §10, verbatim : « tout comme recommandé ». Les 18
décisions sont adoptées **telles que recommandées**. Elles s'imposent aux phases du
§8 ; **une phase qui s'en écarte doit d'abord obtenir une nouvelle décision de
l'utilisateur**.

1. **Libre** pour une action sans pipeline adapté ; une simple question reste en
   Discussion. La ligne « aucun pipeline adapté » de `ROUTAGE-SYNTHESE.md` §3.3 change
   en conséquence (à la phase 3).
2. **Feu vert du plan Libre** : plan affiché puis exécuté ; une seule pause, seulement
   pour une action irréversible non demandée, un fichier hors du projet ou plus de
   10 fichiers.
3. **Code dans Libre** : toute modification de code passe par le pipeline
   Développement, avec ses tests.
4. **Cas génériques** : deux pipelines neufs (« Opérations », « Fichiers ») et trois
   modes d'existants (Rédaction « document existant », Discussion « vérification »,
   Recherche « interne »).
5. **Actions irréversibles d'« Opérations »** : la demande écrite de l'utilisateur
   suffit si elle cite l'action, sinon une pause ; un bond de prod n'est jamais
   appliqué par un musicien.
6. **Nouveau pipeline proposé** seulement après 3 signalements venus d'au moins
   2 demandes différentes en 30 jours, élargir puis combiner d'abord ; actif seulement
   après un essai réussi ; une demande directe de l'utilisateur reste possible.
7. **Nettoyage** : retrait du pipeline inutilisable `x-7e4cf1` et des 11 rattachements
   à mots-clés inertes, avec sauvegarde.
8. **Composition** : les étapes du pipeline appelé s'insèrent dans la même exécution,
   une frise, une livraison, deux niveaux d'appel au plus, models des étapes appelées
   inchangés.
9. **Livraison faite par le programme** (version, CHANGELOG, commit), mêmes
   vérifications.
10. **Discussion en un seul appel**, la Recherche restant appelée si le web est
    nécessaire.
11. **Étapes « à la carte »** pour Incident, Vidéo, Données et Maintenance (liste
    fermée, étapes écartées affichées « sautées » avec la raison).
12. **Items déjà couverts écartés dès la liste de tests**, preuve vérifiée par le
    programme ; le test rouge reste obligatoire pour tout item nouveau.
13. **Revue groupée par 3 items : non** (la revue par item « c+d » reste).
14. **« continuer » automatique : non** (une limite atteinte reste une décision de
    l'utilisateur).
15. **Accélérations TDD** : test rouge ciblé sur le fichier modifié, activé projet par
    projet (suite complète toujours exigée ensuite) : **oui** ; même session pour
    rouge, vert et refactor : **plus tard, après mesure**.
16. **Models plus légers** : suggestions sur la page Models seulement, appliquées par
    l'utilisateur.
17. **Ordre** : gains rapides tout de suite (en parallèle du Routage), puis génériques,
    composition, et Libre après la phase 2 du Routage ; mise en prod par bond décidé par
    l'utilisateur, `pipelineLab` d'abord.
18. **orchestrateur-dev** : corriger la documentation maintenant ; le remettre en
    service dans les pipelines après le bond de la phase 0.

### 11.1 Accord explicite pour les tests d'exigence marqués ⚠

« tout comme recommandé » vaut accord **explicite** de l'utilisateur pour adapter, à la
phase qui livre la décision correspondante, les tests d'exigence suivants :

| Décision | Tests d'exigence concernés |
|---|---|
| 6 (seuil des propositions) | `_test_pipeline_gaps.mjs` |
| 9 (Livrer par le programme) | `_test_item_delivery.mjs`, `_test_release_prebump.mjs`, `_test_lane_changelog_rule.mjs` |
| 10 (Discussion en un appel) | `_test_pipeline_catalog.mjs`, `_test_pipeline_engine.mjs` |

L'accord porte sur ce que la décision change, rien de plus : chaque assertion adaptée
garde le même niveau de garantie (mêmes vérifications, faites par le programme), et
chaque adaptation est tracée dans `docs/USER_REQUIREMENTS.md` avec cette référence.
Toute autre modification d'un test d'exigence demande un nouvel accord.
