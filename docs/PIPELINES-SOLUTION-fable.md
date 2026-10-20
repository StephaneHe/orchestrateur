# Pipelines — étude et plan de réorganisation (solution Fable 5.1)

Étude indépendante, l'une des trois (Fable 5.1, OpenAI Astra, Opus 5.5) qu'Opus 5.5
comparera ensuite, comme pour la refonte du Routage. Règle d'indépendance respectée :
ni `docs/PIPELINES-REFONTE.md` ni les `PIPELINES-SOLUTION-*.md` des autres models n'ont
été lus. Document écrit le 2026-10-20, sur les données de la prod lues en lecture seule
(`I:\orchestrateur\logs`, `model-routing.json`) : 650 `run.json`, 255 classements par
model, 1 766 observations d'entrée, 28 signalements de lacunes.

Demande de l'utilisateur (verbatim) :

> Donc on a etudie le routage, maintenant je voudrais qu'on optimise et arrange les
> pipelines. Retours d'experience :
> - la suggestion de nouveaux pipelines est souvent trop atomiques, et se concentre sur
>   un detail, plutot que de voir the big picture
> - si aucun pipeline est trouve, il faut une action qui ne mene pas a un cul de sac, qui
>   permette d'avancer, et qui peut faire preuve de creativite
> - un pipeline doit pouvoir utiliser ou etre utilise par un autre pipeline (ex : preparer
>   la redaction d'un email peut etre un pipeline utilise par le pipeline de reunion)
> - les pipelines prennent beaucoup de temps, il faut optimiser tout en gardant la
>   predictabilite des actions menees

Ajout : « Il faut aussi prevoir des cas generique, comme un travail ponctuel sur un
document ».

Cohérence avec `docs/ROUTAGE-SYNTHESE.md` (décisions de l'utilisateur du 2026-10-19, §5) :
ce document ne touche ni au tour unique du chef, ni au classement tâche par tâche en
parallèle, ni au registre des demandes. Les points de jonction sont marqués **[⇄ Routage]**.

---

## 0. Résumé pour l'utilisateur

**Diagnostic (10 lignes).**
1. 650 exécutions en 12 jours, dont 610 du Routage du chef : les pipelines des musiciens
   n'ont tourné que 40 fois (dev 14, discussion 10, rédaction 7, le reste 1 à 2 fois).
2. Le temps actif médian d'un pipeline de musicien est court (2 à 11 min) ; le temps mural
   est long (dev complet : 2,6 h médiane, p95 5,7 h) : plus de 90 % du mur est de l'attente
   d'une réponse humaine à une pause.
3. Dev complet : 29 appels de model médians (max 94, 423 $ pour une exécution) ; 69 % des
   items de la liste de tests étaient « déjà couverts » et ont quand même coûté un tour
   Rouge et une suite de tests chacun.
4. Dev léger : 75 % des exécutions ont au moins un refus ; Livrer refusé 8 fois sur 12
   (« aucun commit créé »), Vert refusé 11 fois sur 22 (« aucune modification »).
5. Discussion : 70 % des exécutions refusées à Comprendre pour « chemins cités inexistants »,
   alors que le model citait un fichier pour dire qu'il manquait : +40 s à +2 min pour rien.
6. Des demandes génériques sont forcées dans des pipelines inadaptés : « git push » →
   Maintenance (4 étapes sans rapport, rien poussé : un cul-de-sac), « inscrire 2 lignes
   dans TODO_LIST.md » → Dev léger avec test rouge, « télécharger un reel » → Données
   (7 appels), « bond de prod » → Maintenance ou Audit.
7. Les 458 tâches classées comptent 18 % d'opérations (git, déploiement, APK, redémarrage),
   de travaux sur un document ou de manipulations de fichiers qu'aucun pipeline ne vise.
8. Lacunes : avant 0.66.0, les propositions venaient des mots d'un seul message
   (« x-devra-etre », « x-hors-pipeline », « x-annuler-fichiers-restore ») ; depuis, les
   3 lacunes du model disent toutes la même chose (déploiement / mise en prod), mais la
   seule acceptée est devenue « x-7e4cf1 », un pipeline sans critère au libellé tronqué.
9. La composition existe déjà en contrebande : Réunion copie les étapes de Rédaction,
   Incident réutilise Rouge/Vert, sept pipelines partagent Livrer. Rien n'est contractuel.
10. Le Routage ajoute ~3,2 min de chef (1,7 avant, 1,5 au retour) à chaque tâche : c'est
    la refonte du Routage qui s'en charge, pas ce plan.

**Propositions (4 axes × 4 lignes).**
- **a) Lacunes « big picture »** : le classement nomme d'abord une *famille de résultat*
  (code, texte, fichiers, état d'un système, information, supervision), puis un pipeline.
  Une lacune n'est plus « un pipeline proposé » mais un *besoin* journalisé (famille, verbe
  canonique, résultat attendu). Proposition à l'utilisateur seulement à 3 besoins
  semblables en 30 jours, dans l'ordre : élargir un pipeline, composer des briques, créer.
- **b) Aucun pipeline trouvé** : un pipeline `libre` remplace le repli vers Discussion pour
  les demandes d'action. Planifier (plan JSON de 6 étapes au plus, briques connues,
  critères choisis dans une liste close) → Annoncer (par le code, pause unique si effet
  irréversible) → Exécuter (chaque étape vérifiée par le code, code = sous-pipeline Dev)
  → Vérifier → Figer (le plan devient un besoin ; 3 plans semblables = proposition).
- **c) Composition** : une étape `kind: 'pipeline'` appelle un pipeline fils avec un
  contrat (demande composée par le code, artefact attendu, fichiers autorisés, livraison
  par le parent). Profondeur 2, graphe acyclique vérifié par un test, pauses remontées,
  models des cases du fils, frise indentée, budget partagé. Réunion → Rédaction devient
  la première vraie composition ; Livrer, Rouge/Vert, Revue, Rédiger/Relire, Rechercher,
  Vérifier deviennent des briques déclarées.
- **d) Vitesse** : chemins cités vérifiés sur le journal des lectures (plus de faux refus),
  Livrer et « rien à faire » par le code, suite de tests mémorisée par empreinte d'arbre,
  tri de couverture avant la boucle TDD (0 appel pour un item déjà couvert), juges
  indépendants en parallèle (audit), étapes juges voisines fusionnées, sonnet pour Rouge
  simple/mécanique. Estimation : −40 à −55 % d'appels et de temps actif, pauses −50 %.

**Plan (8 lignes).**
1. Phase 0 (1,5 j) : faux refus de chemins, Livrer et sauts par le code, cache de suite,
   nettoyage des lacunes par mots-clés et de x-7e4cf1, mesure (`pipeline-bench.mjs`).
2. Phase 1 (3 j) : briques déclarées et composition, Réunion → Rédaction migrée.
3. Phase 2 (3 j) : pipelines génériques `document`, `fichiers`, `operations`, variante
   « vérification » de Discussion, mode « interne » de Recherche.
4. Phase 3 (3 j) : pipeline `libre`, journal des besoins, panneau « Besoins ».
5. Phase 4 (2,5 j) : vitesse du Développement (tri de couverture, revue par groupe,
   « continuer » automatique borné, juges parallèles).
6. Phase 5 (0,5 j + 7 j) : bascule par réglages relus à chaud, bond de prod, mesure.
7. Chaque phase derrière un réglage de `model-routing.json` (`pipelinesV2.*`), tag de retour,
   corpus de vrais cas lents ou bloqués rejoué par le faux claude.
8. Tout sur `orchestrateur-dev`, non-régression par périmètre, puis bond décidé par
   l'utilisateur ; total ≈ 13,5 jours.

**Décisions** : §5 (12 questions, chacune avec ma recommandation).

---

## 1. Diagnostic sur les données réelles

### 1.1 Volume et répartition

| Pipeline / mode | Exécutions | Projets | Statuts | Mur médiane / p95 | Actif médiane / p95 | Appels model méd. / max | Coût méd. |
|---|---|---|---|---|---|---|---|
| routage / demande | 413 | 1 | 411 done, 2 pause | 1,7 / 2,9 min | idem | 4 / 5 | 1,45 $ |
| routage / callback | 197 | 1 | 195 done | 1,5 / 2,0 min | idem | 3 / 4 | 1,23 $ |
| discussion / léger | 10 | 7 | 10 done | 2,0 / 5,5 min | 2,5 / 5,5 | 4 / 4 | 1,66 $ |
| dev / léger | 8 | 5 | 4 done, 2 pause, 2 interrompues | 5,2 min / **23 h** | 7,4 / 11,2 min | 5 / 14 | 1,69 $ |
| dev / complet | 6 | 4 | 2 done, 2 pause, 2 abandons | **2,6 h / 5,7 h** | 10,9 / 34 min | 29 / **94** | 10,7 $ (p95 40 $) |
| rédaction / léger | 7 | 5 | 7 done | 4,0 / 6,1 min | idem | 4 / 5 | 2,18 $ |
| maintenance / léger | 2 | 2 | 1 done, 1 pause | 2,0 min | idem | 4 / 5 | 0,37 $ |
| incident / léger | 1 | 1 | done | 13,6 min | idem | 9 | 7,02 $ |
| vidéo / léger | 1 | 1 | done | 13,4 min | idem | 1 (+ ffmpeg) | 4,03 $ |
| réunion / léger | 1 | 1 | done | **16,9 h** | 4,0 min | 5 (+ 2 code) | 4,71 $ |
| données / léger | 1 | 1 | done | 28 min | 5,9 min | 7 | 0,24 $ |
| audit, recherche, nouveau, images, audio | 0 | — | — | — | — | — | — |

Lecture : 94 % des exécutions sont le Routage du chef (traité par la refonte en cours).
Les pipelines des musiciens sont jeunes (40 exécutions, 10 projets) : les médianes
ci-dessous sont indicatives, les causes de refus sont, elles, nettes. Audit (33 tâches
classées) et Recherche n'ont **jamais tourné** : leurs projets (orchestrateur-dev, vuBox,
orchestrateur) n'étaient pas en service, les tâches sont parties en tour ordinaire.

### 1.2 Par étape : durées, refus, essais

| Pipeline | Étape | n | ok | refus | méd. / p95 | Motifs de refus dominants |
|---|---|---|---|---|---|---|
| discussion | comprendre | 17 | 10 | **7 (41 %)** | 39 s / 2,2 min | « chemins cités inexistants » ×5 (le model cite le fichier *manquant*) |
| | rechercher | 10 | 10 | 0 | 31 s / 1,5 min | |
| | repondre | 10 | 10 | 0 | 28 s / 55 s | |
| dev léger | rouge | 9 | 6 | 3 | 52 s / 1,5 min | « la suite passe encore » ×2, « aucun test ajouté » |
| | vert | 22 | 9 | **11 (50 %)** | 34 s / **8,5 min** | « aucune modification » ×5, « la suite échoue encore » ×3, tests modifiés ×1 |
| | revue | 11 | 11 | 0 | 29 s / 1,1 min | |
| | livrer | 12 | 4 | **8 (67 %)** | 28 s / 1,4 min | « aucun commit créé » ×8 (une exécution : 4 paires de refus, +4 min) |
| dev complet | rouge | 78 | 76 | 2 | 50 s / 1,6 min | 246 $ au total (opus) |
| | vert | 105 | 39 | 15 (+14 `launch_failed`, 37 sautés) | 33 s / 1,6 min | « fichiers de test modifiés » ×8, « aucune modification » ×7 |
| | refactor | 72 | 14 | 0 (58 sautés) | 26 s | sauté sous 10 lignes : bien |
| | revue | 41 | 37 | 4 échecs | 35 s / 3,6 min | limite d'usage codex ×4 (second model) |
| | livrer | 6 | 3 | 3 | 32 s | « version non incrémentée » ×2 (corrigé 0.114.1) |
| rédaction | rediger | 8 | 7 | 1 | 1,4 min / 3,6 min | |
| | relire | 7 | 7 | 0 | 57 s | |
| | mettre-en-forme | 7 | 7 | 0 | 33 s | appelé même quand il n'y a rien à appliquer |
| | livrer | 7 | 7 | 0 | 24 s | un commit de doc : aucune créativité |
| incident | detecter | 2 | 1 | 1 | 40 s | « chemins cités inexistants : ssl.py » (même faux refus) |
| | post-mortem | 1 | 1 | 0 | 2,5 min | |
| données | presenter | 3 | 1 | 2 | 42 s | critères contradictoires (corrigé 0.114.3) |
| maintenance | dette | 3 | 1 | 2 | 17 s | « artefact absent » : la demande n'était pas de la maintenance |
| routage | decomposer | 458 | 318 | 45 | 32 s / 1,1 min | refonte du Routage |

Le temps **hors étapes** (contrôles, git, écriture des événements) est négligeable :
médiane 1 s, p95 6 s par exécution terminée. La durée d'une étape inclut la suite de tests
que le moteur lance après une action : sur `orchestrateur-dev`, un Vert a duré 21 min dont
l'essentiel en non-régression ciblée ; sur `youtube-live`, un Vert de 8,5 min a lancé la
suite pytest 6 fois lui-même.

### 1.3 Où passe le temps mural

Pauses en cours ou passées : `green` 3, `criteria` 5, `duration` 1, `precondition` 1,
`launch` 1, `aside_conflict` 1, `doutes` 1, `model_unavailable` 1. Exemples :

- [[p-20261009T193934-083679]] (panierIL, dev complet) : 28 items, 109 min actives,
  182 min murales, 94 appels, 423 $, 14 `launch_failed` sur Vert, pause `launch`.
- [[p-20261016T155123-18ff0c]] (youtube-live, dev complet) : 34 min actives, **41 h**
  murales, 19 défauts rapportés, abandonnée sur `aside_conflict`.
- [[p-20261018T154104-6cfbe8]] (youtube-live, dev léger) : 10,7 min actives, 23 h murales,
  Livrer refusé 8 fois (le model n'arrivait pas à commiter : 3 tests figés à adapter, que
  le pipeline lui interdisait de toucher) ; résolu par un accord de l'utilisateur relayé.
- [[p-20261009T123458-2a1135]] (panierIL) : pause `precondition` (suite déjà rouge). Il a
  fallu que l'utilisateur lance un Incident à la main, puis une reprise : deux tours du
  chef et une journée. Le moteur savait pourtant ce qu'il fallait faire.
- [[p-20261016T155415-e67865]] (Ayor, réunion) : 4 min actives, 16,9 h murales, pause
  `doutes` légitime (suppression de fichiers).

Conclusion : **la lenteur ressentie est d'abord de l'attente de décision**, puis le
Routage (×2 par tâche), puis seulement les appels de model. Réduire les pauses évitables
rapporte plus que raccourcir les étapes.

### 1.4 Items « déjà couverts » : la liste de tests découpe trop fin

| Exécution | Items | Déjà couverts | Tours Rouge | Vert ok | Revues |
|---|---|---|---|---|---|
| pipelineLab [[p-20261009T014516-e88f28]] | 16 | **11** | 18 | 5 | 2 |
| youtube-live [[p-20261018T091024-0e199e]] | 16 | **13** | 16 | 4 | 17 |
| youtube-live [[p-20261016T155123-18ff0c]] | 8 | 5 | 10 | 5 | 10 |
| veille [[p-20261009T123458-1dbf5f]] | 4 | 4 | 5 | 1 | 1 |
| panierIL [[p-20261009T193934-083679]] | 28 | 4 | 29 | 24 | 11 |

Sur 72 items, **37 (51 %) étaient déjà couverts** ; chacun a coûté un tour Rouge (25 à
50 s, opus) et au moins une suite de tests, pour constater qu'il n'y avait rien à faire.
La revue par item (0.63.0) ajoute une revue par item couvert (youtube-live : 17 revues
pour 4 Vert utiles).

### 1.5 Demandes génériques forcées dans des pipelines spécialisés

Sur les 458 tâches classées par le Routage (toutes n'ont pas tourné en pipeline) :

| Demande réelle (titre du Routage) | Pipeline choisi | Ce qui s'est passé ou se serait passé |
|---|---|---|
| « git : pousser les commits locaux » (youtube-live) | maintenance / léger | 4 étapes Dépendances → Historique → Tests instables → Dette (3,2 min, 4 appels), Livrer sauté : **rien n'a été poussé** |
| « git push des commits locaux (v0.113.0) », « git push … (v1.48.0) » | maintenance, audit | idem, ou audit de sécurité pour un push |
| « TODO : inscrire 5 vidéos YouTube puis reel Instagram » | dev / léger / mécanique | Rouge, Vert, Revue ×2, Livrer (5 appels) **pour deux lignes de Markdown** |
| « TODO_LIST : clore t-fc8c73 abandonné », « TODO : clore l'item … » | maintenance | pipeline de maintenance de code pour cocher une case |
| « télécharger le reel Instagram » | données / léger | Collecter → Nettoyer → Stocker → Présenter (7 appels, 2 refus) pour un téléchargement |
| « Ayor : rapatrier la vidéo de rog via Tailscale » | incident / léger | 7 étapes d'incident pour une copie de fichier |
| « mise en prod 0.96.0 + 0.97.0 », « bond de prod (prod-jump --apply) », « prod : appliquer le bond en 0.107.0 » | maintenance, maintenance / complet, audit | aucun n'exécute un bond |
| « app TV : installer 0.12.10 (vc41) sur la Mi Box », « déploiement serveur puis app TV » | lacune (non routé) | tâche non lancée, question à l'utilisateur |
| « Changer le model affecté à la case routage.callback » | dev / léger | TDD pour un réglage |
| « Anim-Series : comparer deux dossiers Witch Hat » | discussion | convenable, mais sans checklist vérifiable |
| « Verifie que la collection Disney co tient bien tous les Disney disponibles » | discussion (repli) | réponse sans action : cul-de-sac |

Comptage par famille de résultat attendu, sur les 458 tâches (lecture des titres et
demandes) : opérations (git, release, déploiement, redémarrage, APK) ≈ 40 ; travail sur
un document existant (TODO, README, registre, sections de portfolio, mails) ≈ 45 ;
manipulation de fichiers (télécharger, ranger, copier, comparer) ≈ 10 ; supervision de
l'orchestrateur (clore une pause, file, mémoire du chef) ≈ 35 ; études et analyses à
écrire dans le dépôt ≈ 15. Soit **≈ 30 % des tâches hors du cœur « code / question »**,
servies aujourd'hui par Dev, Maintenance, Audit, Données ou le repli Discussion.

### 1.6 Lacunes et propositions : pourquoi « trop atomiques »

28 signalements, 19 clés distinctes.

**Avant 0.66.0 (règles lexicales, 16 clés)** : la proposition était fabriquée à partir
de trois mots du message. Exemples réels :

- « Mais ce dev devra etre fait sur dev » → créer un pipeline **« Devra etre »** (Cadrer →
  Réaliser → Vérifier → Livrer), reconnu par les mots « devra », « etre » ;
- « oui, hors pipeline » → pipeline **« Hors pipeline »** ;
- « @orchestrateur Annuler les 14 fichiers (git restore). » → pipeline **« Annuler fichiers
  restore »** ;
- « Verifie que la collection Disney co tient bien tous les Disney disponibles » → pipeline
  **« Verifie collection disney »** ;
- 11 propositions « rattacher à incident et ajouter « suite, pipelines, obligatoires » à sa
  description » : des réponses de l'utilisateur à des questions du chef, prises pour des
  demandes.

Six de ces rattachements ont été **acceptés** depuis le dashboard : `custom.attach` porte
encore des mots-clés comme « réponse, l'utilisateur, question » (recherche) ou « demande,
l'utilisateur, verbatim » (audit). Ils sont inertes depuis 0.66.0 mais toujours dans le
fichier.

**Depuis 0.66.0 (model, 3 lacunes + 6 « aucun pipeline » du Routage)** : le fond est juste
et **convergent** — « il manque un pipeline déploiement / mise en prod » (prod-jump
--apply ; serveur + box ; APK sur un device via adb) — mais :

- la lacune acceptée le 2026-10-13 a créé **`x-7e4cf1`** : libellé « proposition du model
  de classement : Il manque un pipeline d », quatre étapes génériques sans aucun critère,
  `when` égal au texte d'une seule demande. Le classifier l'a ensuite choisi une fois
  (« serveur : mise en production v1.49.5 ») ;
- chaque lacune est jugée **sur une demande**, jamais sur la famille : trois signalements
  distincts pour un seul besoin, et la proposition reste au niveau de la commande citée
  (`prod-jump`, `adb`), pas du résultat (« un système dans un état voulu, vérifié »).
- les six « aucun pipeline » du Routage (supervision du chef, nettoyage git ponctuel) ne
  sont pas des lacunes de pipeline : ce sont des actions du chef, résolues par les actions
  typées de la refonte du Routage **[⇄ Routage §3.2]**.

Le mécanisme pousse donc à l'atomicité par construction : une proposition par message,
formulée avec les mots du message, acceptée en un clic sans critère ni regroupement.

### 1.7 Ce qui existe déjà et qu'il faut garder

- Le moteur juge chaque étape **par le code** (sections, JSON, chemins, suite verte,
  `onlyGlobs`, `protectTests`, `headUnchanged`, empreintes d'arbre, annulation d'un essai
  refusé). C'est la source de la prévisibilité : tout ce qui suit la conserve.
- Les étapes de **code** (`kind: 'code'`, `handler`) : Réunion supprime et vérifie par le
  code, le Routage affecte et dispatche par le code. Modèle à généraliser.
- La **session par groupe** (`stepSessionGroup`) : les étapes d'un même groupe et d'un même
  model partagent déjà une session ; les juges indépendants (`redaction-2`, `audit-2`) ont
  la leur.
- **Réutilisation** : `crit: 'rouge' | 'vert' | 'livrer'`, `chain` de cases, `fromPipeline`
  (Réunion → Rédaction), `prerun: 'scans'`. C'est de la composition sans contrat.
- Les pauses « menu » (continuer, simplifier, changer le model, abandonner, accepter), les
  pannes d'infrastructure garées et relancées (0.118.0), la clôture par commande (0.117.0).

---

## 2. Propositions

### 2.a Lacunes « big picture » : raisonner par famille de résultat

**Principe.** Une demande est d'abord rangée dans une **famille de résultat attendu**, puis
dans un pipeline. La famille est ce que l'utilisateur obtient à la fin ; elle est
indépendante des mots et du projet. Liste close, portée par `scripts/pipeline-families.mjs` :

| Famille | Résultat attendu | Pipelines aujourd'hui | Manque |
|---|---|---|---|
| `code` | du code modifié, testé, livré | dev, incident, maintenance, audit, nouveau | — |
| `texte` | un texte neuf ou un document modifié | redaction | `document` (§2.e) |
| `fichiers` | des fichiers produits, déplacés, rangés, acquis | reunion, images, video, audio, donnees | `fichiers` (§2.e) |
| `systeme` | un système dans un état voulu et vérifié (dépôt distant, serveur, appareil, réglage) | — | `operations` (§2.e) |
| `information` | une réponse, une comparaison, une étude, une vérification | discussion, recherche | variante « vérification », mode « interne » |
| `supervision` | l'orchestrateur lui-même (pauses, files, mémoire du chef) | — | actions typées du chef **[⇄ Routage §3.2]**, jamais un pipeline |

**Classement.** Le classifier par tâche (décision 3 du Routage : un appel par tâche, en
parallèle) répond `{famille, pipeline|null, mode, nature, raison}`. `famille` est
obligatoire. `pipeline: null` dans une famille qui a un pipeline générique → ce générique ;
`pipeline: null` dans `systeme` → `operations` ; `famille` sans aucun pipeline applicable →
`libre` (§2.b). La Discussion n'est plus le repli d'une **action** ; elle reste celui d'une
**question**. (Décision D1.)

**Un besoin, pas une proposition.** `emitRoutingGap` et la porte de `dispatch.mjs` n'écrivent
plus de « proposition de pipeline ». Ils écrivent un **besoin** dans
`logs/pipeline-needs.ndjson` : `{at, projet, famille, verbe, objet, resultat, demande
(extrait), run, plan (si libre)}`. `verbe` et `objet` sont **canoniques**, choisis par le
model dans une liste ouverte mais normalisée par lui (« déployer », « installer »,
« publier », « ranger », « résumer »…), pas des mots du message. La clé de regroupement
est `famille/verbe/objet`.

**Seuil et regroupement.** Un panneau « Besoins » (page Models, remplace « Lacunes ») montre
les groupes. Une **proposition** n'est produite qu'à **3 besoins** d'une même clé en
30 jours, venant d'au moins 2 demandes distinctes (décision D8). Elle est écrite par le
model de la case `routage.classifier` à partir des N demandes réelles, et doit répondre
dans cet ordre, en justifiant le passage à l'option suivante :

1. **élargir** un pipeline existant : nouvelle variante d'une étape, étape optionnelle,
   extension de la description (`custom.steps`, `custom.variants`, déjà appliqués par
   `applyCustom`) ;
2. **composer** des briques existantes en un pipeline déclaré par un plan `libre` figé
   (§2.b, « Figer ») ;
3. **créer** un pipeline neuf, avec pour chaque étape un critère vérifiable de la liste
   close (§2.c.3). Une proposition sans critère est refusée par le code.

Le libellé proposé est un nom de famille et de verbe (« Déploiement », « Mise à jour d'un
document »), jamais un extrait de demande. Accepter ne crée plus rien sans critère :
l'ajout passe par `catalog` (pipeline neuf = fichier `scripts/pipeline-catalog-custom.json`,
même schéma que le catalogue, validé par le même test).

**Nettoyage.** `custom.attach` (mots-clés, inertes depuis 0.66.0) et `custom.pipelines`
(`x-7e4cf1`) sont retirés de `model-routing.json` par une migration qui garde la copie
`.v2-bak` ; les 19 décisions de `gapDecisions` deviennent des besoins historiques. Le
besoin « déploiement » (3 occurrences réelles) est le premier groupe du panneau : il est
satisfait par `operations` (§2.e).

**Exemples rejoués.** « Mais ce dev devra etre fait sur dev » : classé `supervision`
(consigne au chef), aucun besoin. « Annuler les 14 fichiers (git restore) » : `systeme` /
« restaurer » / « fichiers du dépôt » → `operations` (opération typée `git_restore`, avec
autorisation). « Verifie que la collection Disney… » : `information` / « vérifier » /
« collection » → Discussion, variante vérification. « Installer 0.12.10 sur la Mi Box » :
`systeme` / « installer » / « APK » → `operations`.

### 2.b Aucun pipeline trouvé : le pipeline `libre`

**Objectif.** Qu'une demande d'action non couverte **avance toujours**, de façon créative
mais prévisible : le plan est écrit avant d'agir, montré, vérifié par le code à chaque pas,
et il peut devenir un pipeline s'il se répète.

**Plan du pipeline.**

| # | Étape | Qui | Artefact | Critères vérifiés par le code |
|---|---|---|---|---|
| 1 | Planifier | model, case `libre.planifier` | `plan.json` | schéma ; 1 à 6 étapes ; chaque étape a une `brique` connue ou un `pipeline` du catalogue ; `fichiers` (globs) dans le projet ou chemins externes déclarés ; `critere` dans la liste close ; `effets` externes (push, suppression, installation, envoi, redémarrage) marqués `irreversible: true` ; une étape qui modifie du code (globs de code du projet) doit être `pipeline: dev` |
| 2 | Annoncer | code | `annonce.md` | la frise reçoit les étapes du plan (comme `@loop`) ; notification au chef ; **une seule pause** `autorisation` si le plan contient un effet irréversible ou un chemin externe, sauf si la demande l'autorise déjà (`userSaid`, règle de 0.71.2) (décision D3) ; sinon départ immédiat |
| 3..n | Étapes du plan | model (case de la brique) ou sous-pipeline | `etape-<k>.md` | les critères de la brique + le `critere` du plan ; `onlyGlobs` = `fichiers` de l'étape ; suite verte si `testCommand` ; les effets irréversibles passent par le handler `commande` (argv en tableau, exécuté par le moteur, postcondition obligatoire) |
| n+1 | Vérifier | model, case `libre.verifier` (sonnet) | `verification.json` | `{constats: [{attendu, observe, preuve, ok}]}` ; chaque `attendu` du plan a un constat ; un constat `ok: false` renvoie **une fois** à l'étape fautive (replanification locale), puis pause `criteria` |
| n+2 | Livrer | code, puis model seulement si version | `livraison.md` | `ifChanged` ; version et CHANGELOG seulement si une étape `dev` a tourné (règle du couloir : fragment `changelog.d/`) |
| n+3 | Figer | code | besoin dans `pipeline-needs.ndjson` | signature du plan (briques, famille, verbe) ; 3 plans semblables ⇒ proposition « figer en pipeline » (§2.a) |

**Briques** (liste close, chacune une étape existante du catalogue rendue réutilisable,
§2.c.1) : `lire` (juge, lecture seule, sections), `rediger` (redaction.rediger),
`modifier-document` (document.modifier), `rechercher` (recherche.rechercher),
`agir-fichiers` (fichiers.executer), `commande` (operations.executer : opérations typées),
`verifier` (discussion.verifier), `dev` (sous-pipeline Développement léger), `livrer`.

**Liste close des critères d'un plan** : `fichier_existe`, `fichier_absent`,
`seulement_ces_fichiers_changent`, `diff_non_vide`, `aucun_changement`, `commande_retourne_0`,
`url_repond` (code HTTP attendu), `texte_contient` (fichier, motif), `suite_verte`,
`postcondition_operation` (celle de l'opération typée), `media_valide` (ffprobe, image).
Tous existent déjà dans `checkCatalogCriteria`, `media-check.mjs`, `meeting-check.mjs` ou
sont triviaux. Le model **choisit** parmi eux ; il n'en invente pas.

**Garde-fous.** 6 étapes, 1 replanification, `runMs` 45 min, budget d'appels de 12,
profondeur de composition 2, `libre` ne peut pas appeler `libre`, aucun effet irréversible
hors handler `commande`, chemins hors projet seulement s'ils sont déclarés et autorisés.
Limite atteinte ⇒ le menu de pause habituel. Résultat final : `verification.json` rendu en
texte par le code, plus la ligne « ce plan a été noté comme besoin ; s'il revient, je
proposerai de le figer ».

**Pourquoi ce n'est pas un retour au tour ordinaire.** Le tour ordinaire n'a ni plan
visible, ni critère, ni frise ; `libre` a les trois, et le code refuse tout écart au plan.
La créativité est dans Planifier (model fort, opus) ; l'exécution est tenue.

**Exemples.** « Verifie que la collection Disney co tient bien tous les Disney
disponibles » : plan = `rechercher` (liste de référence, ≥ 2 sources) → `lire` (collection
locale, chemins vérifiés sur le journal des lectures) → `verifier` (tableau manquants /
présents) ; aucun effet. « Rapatrier la vidéo de rog via Tailscale » : `commande`
(opération typée `copier_distant`, hôte dans la liste Tailscale, postcondition : taille
identique) → `agir-fichiers` (ranger) → `verifier`. « Changer le model de la case
routage.callback » : `supervision`, pas `libre` : action du chef.

### 2.c Composition : un pipeline appelle un pipeline

#### 2.c.1 Briques déclarées

Le catalogue gagne `use: '<pipeline>.<étape>'` : l'étape est **référencée**, pas copiée.
`catalogSteps` résout la référence (rôle, cases, artefact, critères) et accepte des
surcharges locales (`role` préfixé, `title`). Réunion → Rédaction (`fromPipeline`, boucle
de copie en fin de `pipeline-catalog.mjs`) devient `use`. Incident garde `crit`/`devRole`
(déjà une référence). Briques identifiées : `dev.rouge`, `dev.vert`, `dev.revue`,
`dev.livrer` (7 pipelines), `redaction.rediger`, `redaction.relire`, `recherche.rechercher`,
`recherche.cadrer` (aussi nouveau, images), `audit.scans` (prerun), `reunion.verifier`
(code), `discussion.verifier` (nouvelle), `document.modifier`, `fichiers.executer`,
`operations.executer`. Un test vérifie que toute brique a un critère et une case.

#### 2.c.2 Contrat d'une étape `kind: 'pipeline'`

```json
{ "id": "mail", "title": "R Rédiger le mail", "kind": "pipeline", "pipeline": "redaction",
  "mode": "leger",
  "input":  { "demande": "Rédige le mail décrit dans demande.md, à partir de {{rangement.json}}",
              "fichiers": ["reunions/**"] },
  "expect": { "artefact": "texte.md", "sections": ["Objet"], "onlyGlobs": ["**/*.md"] },
  "deliver": "parent" }
```

| Élément | Règle |
|---|---|
| **Entrée** | `demande.md` du fils **composée par le code** à partir de la demande du parent et des artefacts cités (`{{artefact}}` : inclusion textuelle, jamais un résumé par un model) ; `fichiers` = périmètre autorisé (globs), intersection avec celui du parent ; `contexte.md` du parent joint en lecture |
| **Sortie** | le `final` du fils (artefact ou fichiers) copié sous `<run parent>/<étape>/` ; `changed` (fichiers modifiés) ; statut `done | paused | abandoned | failed` ; `activeMs`, appels, coût |
| **Critères** | le fils vérifie les siens ; le parent vérifie **le contrat** : artefact attendu présent et non vide, sections, `changed ⊆ onlyGlobs ∩ fichiers`, suite verte si le parent a `testCommand` |
| **Livraison** | `deliver: 'parent'` : Livrer du fils sauté, un seul commit par le parent ; version et CHANGELOG par le parent seul. `deliver: 'self'` autorisé seulement si le parent n'a pas d'étape Livrer |
| **Exécution** | même `cwd` et même couloir (0.101.0), en série ; le fils a son `run.json` (`parent: {run, step}`) sous `logs/runs/`, donc visible du journal, de l'onglet Requêtes et de `close-run.mjs` ; le parent note `child: <run>` sur l'étape |
| **Models** | les cases du fils (`redaction.rediger`…) ; la page Models montre l'étape parent en `ref` vers le fils (mécanisme existant, sans menu). Pas de surcharge par composition au départ (décision D9) |
| **Limites** | celles du fils ; `activeMs` du fils compté dans `runMs` du parent ; budget d'appels partagé (`remaining` passé au fils) ; profondeur **2** (parent → fils → petit-fils), décision D10 |
| **Pauses** | pause du fils ⇒ le parent se met en pause `child` avec **la même question** préfixée « [R Rédiger le mail] » ; la réponse va au parent (`--pipeline-resume <parent>`), qui la transmet au fils ; « abandonner » clôt le fils et met le parent en pause `criteria` sur cette étape (menu habituel) ; une panne d'infrastructure du fils gare le parent (0.118.0 réutilisé) |
| **Anti-boucle** | graphe de composition du catalogue **acyclique**, vérifié au chargement et par `_test_pipeline_composition.mjs` ; à l'exécution, un pipeline absent de la chaîne d'ancêtres seulement ; `libre` ne compose jamais `libre` ; un fils ne peut pas déclencher la montée léger → complet du parent |
| **Frise** | événements `pipeline_child_start / _step_done / _done` portant `pipeline.parent` ; `turn-core.js` les indente sous l'étape du parent ; `activite.js` affiche « ↳ Rédaction 1/4 » ; un seul tour au journal |
| **Tests** | `_test_pipeline_composition.mjs` : faux claude joue le fils (`FAKE_CLAUDE_PIPELINE=1` déjà), contrat refusé (artefact manquant, fichier hors périmètre), pause remontée et réponse transmise, abandon, profondeur 3 refusée, cycle refusé, budget partagé, un seul commit ; Réunion → Rédaction rejoué sur la demande réelle d'Ayor (`_test_reunion_redaction_route.mjs` étendu) ; HTTP `pipeline-child`, navigateur `run-child-timeline` |

#### 2.c.3 Exemple complet : Réunion

`reunion` mode `les-deux` devient : inventorier → trier → definitif → supprimer (code) →
ranger → verifier (code) → **mail** (`kind: pipeline`, `redaction`, entrée composée du
rangement) → livrer (parent, version). Même frise qu'aujourd'hui, une étape de moins
copiée, et la Rédaction évolue sans retoucher Réunion. Autres compositions immédiates :
`nouveau.publication` → `operations` ; `incident` → `dev` (Rouge/Vert) au lieu de `crit` ;
`libre` → n'importe quelle brique.

### 2.d Vitesse avec prévisibilité

Sept leviers, chacun sans perte de garantie, puis l'estimation par pipeline.

1. **Chemins cités vérifiés sur le journal des lectures.** `citedPaths` compare aujourd'hui
   chaque chemin entre accents graves au disque. Nouveau : un chemin est accepté s'il
   existe **ou** s'il figure dans les `tool_use` Read/Glob/Grep du tour (le model l'a
   cherché), ou s'il est précédé d'un marqueur d'absence (« manque », « absent », « à
   créer », « n'existe pas »). Zéro faux refus, même rigueur sur les affirmations positives.
   Gain : Discussion −41 % de refus à Comprendre, Incident Détecter.
2. **Le mécanique par le code.** Livrer sans version (Rédaction, Document, Fichiers,
   Réunion sans incrément) = `git add` des fichiers changés + commit par le code, message
   dérivé de la demande ; Livrer avec version = le code écrit version, CHANGELOG et ligne
   d'exigence depuis un fragment que l'étape précédente a déjà produit (`changelog.d/`,
   mécanisme des couloirs 0.102.0), le model n'intervient que si le fragment manque.
   « Rien à faire » : quand `relecture.json.corrections` est vide, Mettre en forme est
   **sautée par le code** (aujourd'hui un appel pour écrire `RIEN_A_METTRE_EN_FORME`). Gain :
   −1 appel sur Rédaction, −0 à −8 refus sur Livrer de Dev léger.
3. **Suite de tests mémorisée par empreinte.** `runCommand(testCommand)` garde
   `{empreinte de l'arbre (worktreeTree) → résultat}` dans `logs/runs/<run>/suite-cache.json`
   ; une suite verte n'est pas relancée tant que l'arbre est identique (Livrer après Vert,
   `@check`, précondition après une reprise). Sur `orchestrateur-dev`, 2 à 10 min par
   exécution.
4. **Tri de couverture avant la boucle TDD** (dev complet). Après Liste de tests, une étape
   de code lance la suite une fois, puis un appel sonnet (`dev.liste-tests.couverture`)
   marque les items déjà couverts **avec preuve** (`coveredProof` : commit ou
   `fichier:ligne`, règle de 0.50.0 inchangée) ; le code vérifie la preuve et coche
   (`pipeline_item_covered`). Un item couvert ne coûte plus ni Rouge ni Revue. Sur les
   5 exécutions mesurées : 37 tours Rouge opus et 37 suites évités. (Décision D5.)
5. **Modèles plus légers là où c'est sans risque.** Rouge pour `nature: simple | mecanique`
   et Post-mortem, Évaluer, Cadrer, Vérifier → sonnet (suggestion dans
   `data/model-recommendations.json`, appliquée par l'utilisateur sur la page Models,
   jamais par le code). Opus reste sur Concevoir, Rouge complexe/bugfix, Revue, Planifier.
   Gain : −40 % du coût de la boucle TDD (Rouge = 246 $ sur 6 exécutions complètes).
6. **Parallélisme des juges indépendants.** Deux étapes `kind: 'judge'` consécutives dont
   l'une est `independent` de l'autre (Audit : Revue manuelle ∥ Second avis) tournent en
   même temps, chacune dans sa session, sur le même arbre en lecture seule ; le moteur
   attend les deux. Pas de parallélisme sur les actions (un seul arbre). Gain : Audit
   −1,5 min.
7. **Étapes juges voisines fusionnées.** Même case, même groupe, lecture seule : Discussion
   Comprendre + Rechercher → « Comprendre et rechercher » (un appel, deux sections) ;
   Incident Détecter + Évaluer. La Revue reste séparée du code (indépendance), Relire de
   Rédiger. Gain : −1 appel sur Discussion et Incident.

Autres mesures : « continuer » **automatique et borné** quand la limite `items` est
dépassée de moins de 50 % sans aucun défaut rapporté (une fois, tracé
`pipeline_limit_extended auto`), jamais sur `duration`, `green` ni `review` (décision D6) ;
précondition « suite déjà rouge » : proposition **dans la pause** de lancer la composition
`incident` sur la base (un bouton, pas automatique) ; `vert` refusé « aucune modification »
: le moteur joint la sortie du test rouge et la liste des fichiers lus par Rouge à la
consigne du nouvel essai ; Revue par groupe de 3 items ou 150 lignes en complet au lieu de
par item (décision D4, car elle revient sur « c+d » de 0.63.0).

**Estimation avant / après** (médianes mesurées ; « après » = leviers 1-7 + génériques ;
hypothèse : 30 s par appel juge, 45 s par appel action, suite 20 s hors orchestrateur-dev) :

| Pipeline | Avant : appels / actif | Après : appels / actif | Leviers | Mur |
|---|---|---|---|---|
| Discussion | 4 / 2,0 min (refus 70 %) | **2 / 1,0 min** (refus < 10 %) | 1, 7 | idem |
| Dev léger | 5 / 7,4 min (refus 75 %) | **4 / 4,5 min** (refus < 30 %) | 2, 3, 5, essai informé | pauses `green` inchangées |
| Dev complet (10 items, 50 % couverts) | 29 / 10,9 min, mur 2,6 h | **16 / 6,5 min**, mur < 1 h | 3, 4, 5, revue groupée, continuer auto | −60 % |
| Rédaction | 4 / 4,0 min | **2,5 / 2,6 min** | 2 | idem |
| Incident | 9 / 13,6 min | **7 / 9 min** | 1, 2, 5, 7 | idem |
| Audit (estimé, 0 exécution) | 7 / ~8 min | **6 / 5,5 min** | 2, 6 | idem |
| Réunion | 5 + 2 code / 4 min | 5 + 2 code / 3,5 min | 2, composition | pause `doutes` légitime |
| Données pour un téléchargement | 7 / 5,9 min | → `fichiers` **2 / 2 min** | générique | −80 % |
| « git push » via Maintenance | 4 / 3,2 min, rien poussé | → `operations` **1 / 1,5 min + commande**, poussé et vérifié | générique | cul-de-sac supprimé |
| Deux lignes de TODO via Dev | 5 / ~4 min | → `document` **1 à 2 / 1,5 min** | générique | |
| Routage (×2 par tâche) | 7 / 3,2 min | refonte du Routage : ≤ 45 s + réveil par le code | **[⇄ Routage §3.8]** | |

Total pondéré par la fréquence observée des tâches : **−45 % d'appels, −40 % de temps
actif, −50 % de temps mural** (pauses évitables et attentes du Routage comprises, cette
dernière part relevant de la refonte du Routage).

### 2.e Pipelines génériques

Quatre pipelines courts, chacun une brique de composition et une sortie du parcours
`libre`. Tous : `needs.git` facultatif (un projet sans git livre sans commit), critères
par le code, une pause au plus.

#### `document` — travail ponctuel sur un document existant

Couvre : relire, corriger, résumer, traduire, reformater, compléter, convertir **un fichier
qui existe** (README, TODO_LIST, registre, section de portfolio, compte rendu, mail en
brouillon). Rédaction reste pour un texte **neuf**.

| # | Étape | Qui | Critères vérifiés par le code |
|---|---|---|---|
| 1 | Cibler | model (sonnet), `document.cibler` | `cible.json {fichiers: [...], operation, langue_cible?, contraintes}` ; chaque fichier existe, est dans le projet (ou chemin externe cité par l'utilisateur, `userSaid`), 5 fichiers au plus ; `operation` dans la liste close (`relire-corriger | resumer | traduire | reformater | completer | convertir`) ; sauté par le code si la demande nomme un seul fichier existant |
| 2 | Modifier | model, `document.modifier` (variantes = opérations) | `onlyGlobs` = exactement les fichiers ciblés ; `diff_non_vide` sauf marqueur `DOCUMENT_DEJA_CONFORME` ; **format préservé** : même extension, encodage et fins de ligne, front-matter conservé, JSON/YAML/TOML qui s'analysent encore, Markdown dont le nombre de titres `##` ne baisse pas sauf `resumer`/`convertir` ; rapport longueur ±25 % pour `relire-corriger`/`reformater`, < 50 % pour `resumer` ; `detectLanguage` = langue cible pour `traduire` ; `completer` n'efface aucune ligne existante (diff sans suppression hors espaces) ; le code écrit `diff.patch` dans l'artefact |
| 3 | Relire | model (sonnet), `use: redaction.relire` | seulement en mode complet ou si le diff dépasse 80 lignes ; corrections vides ⇒ rien ; sinon un retour à Modifier |
| 4 | Livrer | code | commit des seuls fichiers ciblés, sans version ; `ifChanged` |

1 à 2 appels, ~1,5 min. Brique : `reunion` (mettre au propre un compte rendu), `libre`,
`redaction.mettre-en-forme` (peut devenir `use: document.modifier`).

#### `fichiers` — acquérir, ranger, copier, comparer

Couvre : télécharger (yt-dlp, HTTP), rapatrier (Tailscale, SMB), copier, déplacer,
renommer, comparer deux dossiers, supprimer des brouillons. Généralise `meeting-check.mjs`
en `files-check.mjs` ; Réunion devient `use: fichiers.*` pour son rangement.

| # | Étape | Qui | Critères |
|---|---|---|---|
| 1 | Inventorier | model, `fichiers.inventorier` | `operations.json [{op: acquerir|copier|deplacer|renommer|supprimer|comparer, source, destination, attendu: {taille_min?, type?}}]` ; sources existantes ou URL ; destinations dans le projet ; **supprimer** seulement avec `raison`, et pause `doutes` comme Réunion ; 50 opérations au plus |
| 2 | Exécuter | **code** pour copier / déplacer / renommer / supprimer (corbeille `logs/runs/<run>/corbeille/`) ; model (`fichiers.acquerir`, outil local `yt-dlp` possible) pour acquérir | après l'étape : chaque destination existe, taille > 0 ou `taille_min`, `ffprobe` valide pour un média, **rien d'autre n'a changé** (empreinte de l'arbre hors destinations), index mis à jour si le dossier en a un |
| 3 | Vérifier | code (`comparer` produit le tableau), puis model (sonnet) seulement pour une comparaison à commenter | `verification.md` écrit par le code |
| 4 | Livrer | code, `ifChanged`, binaires exclus par `.gitignore` | |

2 appels (1 si tout est mécanique), ~2 min + temps de transfert. Brique : `reunion`,
`video/audio/images` (acquérir), `libre`.

#### `operations` — git, release, déploiement, appareil, service

Couvre les 3 lacunes réelles et ~40 tâches : push, tag, bond de prod (`prod-jump`),
publication d'APK (`copy-build`), installation sur un appareil (adb), redémarrage d'un
service du projet, restauration de fichiers. Fondé sur un **registre d'opérations typées
avec postcondition**, `scripts/typed-operations.mjs`, **le même module que les actions
typées du chef** (`cancel_run`, `restart`, `copy_build`… **[⇄ Routage §3.2]**) : une
opération = `{id, argv(params), preconditions, postcondition, irreversible}`.

| Opération | Préconditions (code) | Postcondition (code) | Irréversible |
|---|---|---|---|
| `git_push` | arbre propre, branche suivie, aucune réécriture d'historique | `git ls-remote` contient HEAD | oui |
| `git_tag` | tag absent, arbre propre | tag présent et annoté | non |
| `git_restore` (fichiers listés) | diff sauvegardé dans `<run>/restore.patch` | fichiers identiques à HEAD | oui |
| `prod_jump` | `delivery-gate prod-check` vert, aucun tour en cours | `prod-jump` sans `--apply` = plan ; `--apply` : HEAD de la prod = tag | oui |
| `copy_build` | APK plus récent que le dernier publié | `builds/<app>/latest.apk` à jour | non |
| `adb_install` | appareil listé (`adb devices`), APK présent | `pm list packages` + `dumpsys` donne le `versionCode` | oui |
| `service_restart` (commande déclarée dans `pipeline.json`) | commande déclarée | URL de santé répond, PID différent | oui |
| `run_script` (script déclaré dans `pipeline.json.operations`) | déclaré, argv fixe | code retour 0 + postcondition déclarée | selon déclaration |

| # | Étape | Qui | Critères |
|---|---|---|---|
| 1 | Préparer | model (sonnet), `operations.preparer` | `plan.json [{op, params}]` : opérations du registre seulement, params validés, ordre ; préconditions **évaluées par le code** et refus nommé si l'une manque (« arbre sale : 3 fichiers ») |
| 2 | Autoriser | code | une pause si une opération est irréversible et que la demande ne l'autorise pas (`userSaid`) ; la question liste les opérations et leurs cibles |
| 3 | Exécuter | **code** | argv en tableau, jamais de shell ; arrêt à la première postcondition fausse ; journal `operations.json` |
| 4 | Rapporter | code (tableau), model (sonnet) seulement si une postcondition a échoué | |

1 appel (0 si la demande est une opération évidente et autorisée : « pousse les commits »
→ Préparer sauté), ~1,5 min + durée des commandes. Brique : `nouveau.publication`,
`dev.livrer.device`, `libre`. Jamais `--dangerously-skip-permissions`, jamais de commande
hors registre.

#### Discussion : variante « vérification » ; Recherche : mode « interne »

- `discussion.verifier` (variante de Répondre) : `verification.json {constats: [{affirmation,
  observe, preuve, verdict}]}` ; chaque constat a une preuve (chemin vérifié sur le journal
  des lectures, sortie de commande, URL) ; projet inchangé. Pour « vérifie que… »,
  « compare… », « est-ce que… tourne ». Brique finale de `libre`.
- `recherche` mode `interne` : sources = fichiers du dépôt et journaux (plus `minSources`
  en URL), Cadrer + Lire fusionnés, Rechercher (web) sauté. Pour les études et analyses à
  écrire dans `docs/` (ce document en est une). C'est l'application de la règle « élargir
  avant de créer ».

Catalogue : 14 → 18 pipelines (`document`, `fichiers`, `operations`, `libre`), 2 variantes,
0 pipeline « x- » restant. Classement : les descriptions des génériques sont écrites au
niveau du résultat (« un fichier existant à modifier », « des fichiers à produire ou
déplacer », « un système à mettre dans un état et à vérifier »), et la règle de tie-break
pour le classifier est : spécialisé avant générique, générique avant `libre`, `libre`
avant Discussion pour une action.

---

## 3. Plan par phases

Règle commune : développement sur `orchestrateur-dev` (branche `dev`), non-régression
ciblée pendant, par périmètre avant la prod, tag `vX.Y.Z`, **bond décidé par
l'utilisateur** (`prod-jump.mjs`), jamais par le musicien. Les pipelines des musiciens
sont actuellement **hors service** sur `orchestrateur-dev` et le Routage du chef coupé
(décision du 2026-10-19) : les essais en conditions réelles se font dans le bac à sable
(port 7778, faux claude) et, après le bond, sur `pipelineLab` (en service en prod).

Bascule : un objet `pipelinesV2` dans `model-routing.json`, écrit par `pipeline-enforce.mjs
v2 <clé> on|off`, **relu à chaque dispatch** :

```json
{ "pipelinesV2": { "citedPathsFromLog": true, "codeDeliver": true, "suiteCache": true,
                   "composition": false, "generic": false, "libre": false,
                   "coverageTriage": false, "groupedReview": false, "autoContinueItems": false,
                   "parallelJudges": false, "fusedJudges": false } }
```

Chaque clé à `false` rend exactement le comportement d'aujourd'hui ; une exécution en
cours garde la valeur lue à son départ (`run.json.v2`).

| Phase | Contenu | Effort | Retour arrière | Critère de réussite |
|---|---|---|---|---|
| **0 — gains rapides** | leviers 1 (chemins sur le journal), 2 (Livrer et sauts par le code), 3 (cache de suite) ; migration de `model-routing.json` (retrait de `custom.attach` à mots-clés et de `x-7e4cf1`, `.v2-bak`) ; `scripts/pipeline-bench.mjs` (médiane, p95, appels, refus, pauses par pipeline et par étape, à partir des `run.json` : le script de cette étude, productisé) ; `famille` ajoutée à la sortie du classifier en **observation** (journalisée, sans effet) | 1,5 j | `pipelinesV2.*` à `false` ; tag `pre-pipelines-v2-p0` | Discussion : refus < 10 % ; Rédaction : 3 appels ; aucune suite relancée sur un arbre identique (`_test_suite_cache`) |
| **1 — briques et composition** | `use:`, `kind: 'pipeline'`, contrat, fils sous `logs/runs/`, pauses remontées, frise, budget ; Réunion → Rédaction migrée ; graphe acyclique testé | 3 j | `composition: false` ⇒ `fromPipeline` (copie) conservé jusqu'à la phase 5 | `_test_pipeline_composition` vert ; Réunion « les-deux » rejouée à l'identique (mêmes artefacts, un commit) |
| **2 — génériques** | `document`, `fichiers` (`files-check.mjs` depuis `meeting-check.mjs`), `operations` (`typed-operations.mjs` partagé avec les actions du chef), variante vérification, mode interne ; descriptions du classifier ; mise en service par `enforcement.pipelines` (liste existante) | 3 j | `generic: false` + retrait de la liste `enforcement.pipelines` | sur le corpus (§3.1) : « git push », « TODO 2 lignes », « reel », « installer APK », « bond » vont aux génériques ; postconditions vérifiées ; 0 cul-de-sac (chaque action produit un effet vérifié ou une question explicite) |
| **3 — `libre` et besoins** | `libre` (Planifier → Annoncer → étapes → Vérifier → Livrer → Figer), `pipeline-needs.ndjson`, panneau « Besoins » (remplace « Lacunes »), seuil, proposition en trois options, `pipeline-catalog-custom.json` validé | 3 j | `libre: false` ⇒ repli Discussion d'aujourd'hui ; le panneau Lacunes reste derrière `ui.gapsLegacy` | « Verifie la collection Disney » et « rapatrier via Tailscale » aboutissent avec plan annoncé ; 0 proposition issue d'un seul message ; `_test_needs_grouping` |
| **4 — vitesse du Développement** | tri de couverture (D5), revue groupée (D4), « continuer » auto borné (D6), juges parallèles, juges fusionnés, essai informé de Vert, bouton « lancer un Incident sur la base » dans la pause `precondition` ; suggestions de models (D7) dans `data/model-recommendations.json` | 2,5 j | une clé par mesure | dev complet rejoué (corpus) : ≤ 2,5 appels par item livré, 0 appel par item couvert ; `_test_item_tests`, `_test_pipeline_covered`, `_test_item_review`, `_test_item_delivery` inchangés et verts |
| **5 — bascule, mesure, nettoyage** | tag, non-régression par périmètre, bond ; `pipelinesV2` tout à `true` en prod sur `pipelineLab` d'abord puis `enforcement.projects` ; 7 jours de `pipeline-bench` ; retrait de la copie `fromPipeline` et du panneau Lacunes (sous les conditions de la décision 9 du Routage : tableau de correspondance des vérifications, contrôle par script, tests d'exigence intacts) | 0,5 j + 7 j | `pipelinesV2.*` à `false` à chaud ; `git reset --hard prod-before-vX.Y.Z` | §3.2 |

Total ≈ **13,5 jours** hors observation. Ordre recommandé : 0 → 1 → 2 → 4 → 3 → 5 si
l'utilisateur préfère les gains mesurables avant `libre` ; 0 → 1 → 2 → 3 → 4 → 5 sinon
(décision D12). Indépendant des phases 1-5 du Routage : seule l'interface du classifier
(`famille`) et le module `typed-operations.mjs` sont partagés, à coordonner quand la
phase 2 du Routage écrit ses actions typées.

### 3.1 Tests

- **Corpus de vrais cas** `tests/pipeline-corpus/` (dépôt public : projets renommés,
  textes abrégés) : les exécutions lentes ou bloquées citées au §1 ([[p-20261018T154104-6cfbe8]]
  Livrer ×8, [[p-20261019T163311-e4336f]] `green`, [[p-20261019T144511-44d707]] `duration`,
  [[p-20261009T193934-083679]] `launch`, [[p-20261018T091024-0e199e]] items couverts,
  [[p-20261016T155123-18ff0c]] `aside_conflict`, [[p-20261019T162957-4ebfbf]] push via
  Maintenance, [[p-20261019T150341-318fcf]] reel via Données, [[p-20261016T155415-e67865]]
  Réunion, les 7 refus de Discussion). Le faux claude rejoue les tours depuis les
  `tool_use` des logs d'étape ; attendus : nombre d'appels, aucun faux refus, génériques
  choisis, effets vérifiés. Suite `_test_pipeline_corpus.mjs` (série, lente : marquée dans
  `SERIAL_SUITES`).
- Nouvelles suites : `_test_cited_paths_log`, `_test_code_deliver`, `_test_suite_cache`,
  `_test_pipeline_composition`, `_test_generic_document` (format préservé : 6 formats,
  traduction détectée, `completer` sans suppression), `_test_generic_files` (corbeille,
  rien d'autre ne change, comparaison), `_test_typed_operations` (chaque opération :
  préconditions, postcondition fausse ⇒ arrêt, jamais de shell), `_test_pipeline_libre`
  (plan refusé : 7 étapes, critère inconnu, code sans sous-pipeline dev, chemin externe
  non déclaré ; pause unique ; replanification une fois ; Figer), `_test_needs_grouping`
  (seuil, trois options, libellé sans extrait de demande), `_test_coverage_triage`,
  `_test_parallel_judges`, `_test_pipeline_bench`.
- Parcours HTTP `pipeline-child`, `pipeline-generic`, `pipeline-libre`, `needs` ;
  navigateur `run-child-timeline`, `needs-panel`, `libre-plan-announce`.
- Toute nouvelle suite et tout nouveau fichier rattachés dans `regression-perimeters.json`
  (périmètre `pipelines`) ; chaque demande de l'utilisateur de cette étude tracée dans
  `docs/USER_REQUIREMENTS.md` avec son test ; **aucun test d'exigence existant affaibli**
  (`_test_pipeline_covered`, `_test_tests_per_item`, `_test_item_review`,
  `_test_item_delivery`, `_test_defect_blocks`, `_test_reunion_*`, `_test_no_lexical_routing`
  restent tels quels ; la revue groupée D4 ajoute un mode, elle ne retire pas le mode par
  item).

### 3.2 Critères de réussite mesurables (7 jours de prod après la bascule, `pipeline-bench`)

| Mesure | Aujourd'hui | Seuil |
|---|---|---|
| Discussion : appels / actif médian / refus | 4 / 2,0 min / 70 % | ≤ 2 / ≤ 1,2 min / ≤ 10 % |
| Dev léger : actif médian / refus Livrer | 7,4 min / 67 % | ≤ 4,5 min / ≤ 10 % |
| Dev complet : appels par item livré ; appels par item couvert | ~4 ; 1 à 2 | ≤ 2,5 ; 0 |
| Dev complet : part du mur en pause | > 90 % | ≤ 50 % |
| Tâches de la famille `systeme` / `texte` (document existant) / `fichiers` routées vers un générique | 0 % | ≥ 80 % |
| Culs-de-sac (action demandée, aucun effet vérifié, aucune question) | ≥ 3 identifiés | 0 |
| Propositions de pipeline issues d'un seul message | 16 sur 19 | 0 |
| Pipelines « x- » sans critère | 1 | 0 |
| Faux refus `citedPaths` | 6 | 0 |
| Suites de tests relancées sur un arbre identique | systématique | 0 |
| Coût médian d'une exécution Dev complet | 10,7 $ | ≤ 6 $ |

---

## 4. Jonctions avec la refonte du Routage (ne rien contredire)

| Point | Routage v3 (décidé) | Ce plan |
|---|---|---|
| Classement | un appel par tâche, en parallèle, case `routage.classifier` | même appel ; sortie enrichie de `famille` ; repli `libre` au lieu de Discussion pour une action (D1) |
| Actions typées du chef avec postcondition (§3.2) | `cancel_run`, `stop_turn`, `resolve_question`, `restart`, `copy_build`, `todo_add` | même registre `typed-operations.mjs`, étendu aux opérations de projet (`git_push`, `adb_install`…) ; la famille `supervision` reste au chef, jamais en pipeline |
| État `à_traiter` d'une tâche sans pipeline (§3.3) | gardée, signalement produit | avec `libre`, le cas « aucun pipeline adapté » devient rare ; la ligne du tableau 3.3 reste pour `libre: false` |
| Registre des demandes (§3.4) | `logs/requests/<id>.json` | un fils de composition porte `parent` ; le registre suit le parent seulement |
| Pannes d'infrastructure (§3.7, 0.118.0) | garées, relancées | réutilisé tel quel par les fils |
| Chef coupé en prod (décision 6) | `off` | les pipelines des musiciens n'en dépendent pas : la porte de `dispatch.mjs` classe et impose |
| Décision 9 (regroupement des suites sous conditions) | tableau de correspondance, contrôle par script | appliqué au retrait de `fromPipeline` et du panneau Lacunes en phase 5 |

---

## 5. Décisions à soumettre à l'utilisateur

1. **D1 — Repli d'une action inclassable** : `libre` (recommandé) au lieu de Discussion
   (règle de 0.41.0 « inclassable = Discussion », qui reste vraie pour une **question**).
2. **D2 — Code dans `libre`** : une étape qui modifie du code passe obligatoirement par un
   sous-pipeline Développement léger, annoncé dans le plan (recommandé) ; ou `libre` refuse
   tout code et pose la question.
3. **D3 — Autorisation des effets irréversibles** (`operations`, `libre`) : la citation de
   l'utilisateur dans la demande suffit (`userSaid`, comme pour `hors_pipeline`),
   recommandé ; ou une pause systématique.
4. **D4 — Revue par groupe** en Développement complet (3 items ou 150 lignes) au lieu de
   par item : revient sur la décision « c+d » (0.63.0). Recommandé **oui**, le mode par item
   restant disponible (`groupedReview: false`).
5. **D5 — Tri de couverture** avant la boucle TDD (0 appel pour un item déjà couvert, preuve
   vérifiée par le code) : recommandé oui.
6. **D6 — « continuer » automatique** : oui pour `items` dépassée de moins de 50 % sans
   défaut, une fois (recommandé) ; jamais pour `duration`, `green`, `review`.
7. **D7 — Models** : suggérer sonnet pour Rouge simple/mécanique, Évaluer, Post-mortem,
   Cadrer, Vérifier (vous décidez sur la page Models) ; nouvelles cases : `libre.planifier`
   opus, `libre.verifier` sonnet, `document.*` sonnet, `fichiers.*` sonnet,
   `operations.preparer` sonnet.
8. **D8 — Seuil de proposition d'un besoin** : 3 occurrences en 30 jours venant de
   2 demandes au moins (recommandé) ; ou 2 ; ou 5.
9. **D9 — Models d'un sous-pipeline** : ceux de ses cases, sans surcharge par composition
   (recommandé) ; ou une surcharge possible par étape parent.
10. **D10 — Profondeur de composition** : 2 (recommandé) ; ou 3.
11. **D11 — Nettoyage** : retirer `x-7e4cf1` et les rattachements par mots-clés de
    `model-routing.json` (sauvegarde `.v2-bak`), et faire des 19 décisions de lacunes des
    besoins historiques : recommandé oui.
12. **D12 — Ordre** : génériques et vitesse avant `libre` (0 → 1 → 2 → 4 → 3 → 5,
    recommandé : gains mesurables plus tôt) ; ou `libre` avant la vitesse.

---

## Annexe — méthode de mesure

Script d'analyse (lecture seule, non versionné : `.tmp/analyse-pipelines.mjs`) sur
`I:\orchestrateur\logs\runs\*\run.json` : durée murale = `updatedAt − createdAt`, temps actif
= `activeMs`, appels = étapes avec `model` et `source: 'pipeline'`, refus = `status:
'refused'`, pauses = `pausedLimit`. Classements : `logs/pipeline-classify.ndjson`
(255 lignes, 250 `routage-tache`, 100 % sonnet-5). Observations : `logs/pipeline-observe.ndjson`
(1 766 lignes, 28 avec `gap`). Tâches : `run.json.tasks` des 313 exécutions du Routage qui
en portent (458 tâches). Les médianes des pipelines de musiciens reposent sur 40 exécutions :
elles seront reprises par `pipeline-bench.mjs` (phase 0) avant toute bascule.
