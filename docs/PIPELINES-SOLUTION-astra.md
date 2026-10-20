# Étude indépendante Astra — réorganisation des pipelines

20 octobre 2026 — étude et plan, sans implémentation. Auteur : OpenAI Astra.

Document créé avant l’analyse détaillée, puis complété. Aucune lecture de `docs/PIPELINES-REFONTE.md` ni des solutions parallèles. Référence normative : `docs/ROUTAGE-SYNTHESE.md`, particulièrement ses décisions utilisateur au §5. Aucun test exécuté, aucun navigateur, aucun redémarrage, aucune écriture directe dans la production. Les tests décrits ici appartiennent au futur chantier d’implémentation. Le seul livrable à commiter est ce document, sans bump.

## Diagnostic — dix lignes

1. Les 650 exécutions lisibles couvrent 12 projets, mais 613 sont du Routage : seuls 37 cas éclairent directement les autres pipelines.
2. Cinq des quatorze pipelines standards n’ont aucune exécution ; leur performance ne peut pas être présentée comme mesurée.
3. Discussion prend 134 s de médiane et 465 s au p95 ; sept de ses dix exécutions ont un nouvel essai.
4. Rédaction prend 241 s de médiane, quatre tours de model médians ; la mise en forme coûte à elle seule 33 s médians.
5. Dev compte 42 refus sur 252 critères observés, neuf exécutions passées en pause sur quatorze, et des reprises qui réinitialisent le numéro d’essai.
6. Un tri de vidéos mobilise 642 s actives déclarées, mais dure 23 h 06 ; ses huit refus de livraison disent tous « aucun commit créé ».
7. Un mail de réunion suit historiquement un rangement et attend 16 h 50 ; le lien Réunion → Rédaction ajouté depuis doit être généralisé, pas réinventé.
8. Les propositions historiques « Verifie collection disney », « Devra etre » et « Hors pipeline » confondent objet, formulation et famille de besoins.
9. Le classement sémantique a remplacé ces mots-clés, mais une fiche personnalisée acceptée n’est toujours pas un contrat exécutable du moteur.
10. Priorité : choisir un parcours adapté, rendre chaque blocage récupérable, puis réduire les tours sans affaiblir rouge, vert, revue ni livraison.

## Propositions — quatre axes, quatre lignes chacun

### A. Lacunes et besoin global

1. Enregistrer l’objectif global, le livrable, la tâche locale et la capacité manquante ; ne pas déduire un pipeline des premiers mots.
2. Regrouper sémantiquement les observations, dédupliquer les relances, et proposer après trois demandes indépendantes sur trente jours.
3. Examiner dans cet ordre : correction de classement, extension d’un mode, composition, puis création d’une famille nouvelle.
4. Toute proposition présente des exemples positifs et négatifs, des critères exécutables et un coût ; son acceptation ne la rend pas automatiquement active.

### B. Aucun pipeline trouvé et demandes génériques

1. Faire aboutir une lacune à « plan générique → travail utile → contrôles → restitution », sans abandon de la demande ni sortie hors pipeline implicite.
2. Fournir les parcours courts document, inspection/comparaison, collecte d’un fichier et opération ponctuelle, à partir des besoins réellement observés.
3. Montrer le plan, ses fichiers et ses effets avant l’exécution ; poursuivre l’autorisation déjà donnée et demander seulement les décisions manquantes.
4. Autoriser la créativité dans le choix des moyens bornés, produire au minimum un diagnostic exploitable si l’action manque, et capitaliser les répétitions.

### C. Composition

1. Appeler un pipeline versionné avec entrées, sorties, preuves et effets typés ; Réunion utilise Rédaction sans copie de ses étapes.
2. Limiter l’imbrication à trois niveaux au total, interdire les cycles, partager les budgets et attribuer la livraison à un seul propriétaire.
3. Remonter les pauses avec leur cible exacte et conserver les cases Models des enfants ; aucun repli de model silencieux.
4. Déplier les enfants dans la frise et tester contrats, reprises, annulations, idempotence et garanties de chaque pipeline de code.

### D. Vitesse avec prévisibilité

1. Fusionner les travaux intellectuels compatibles des parcours non-code ; conserver les portes distinctes rouge, vert, revue et livraison.
2. Faire par le code inventaires, diff, contrôles de format et restitution factuelle ; ne plus exiger un texte artificiel pour prouver une opération mécanique.
3. Paralléliser seulement les lectures indépendantes, réutiliser les preuves valides et les sessions compatibles, et étendre le léger aux besoins courants.
4. Viser Discussion 45–75 s et Rédaction 130–180 s médians, puis mesurer sur cas appariés ; aucune promesse de gain sur les attentes humaines.

## Plan — huit lignes

1. Phase 0, 1–2 j : instrumenter appels/contrôles/attentes, consolider les corrections existantes et éviter les relances identiques sans progrès.
2. Phase 1, 2–3 j : contrat commun versionné, capacités exécutables, plans affichés et contrôles statiques, en mode ombre sans effets.
3. Phase 2, 2–3 j : parcours génériques document/inspection/collecte/opération, puis regroupement des lacunes et seuil de proposition.
4. Phase 3, 3–4 j : composition bornée Réunion → Rédaction, pauses propagées, frise imbriquée et livraison unique.
5. Phase 4, 2–3 j : fusions non-code, preuves réutilisables, concurrence bornée et choix de models validés sur corpus.
6. Chaque phase : exigences tracées et tests automatisés en dev ; rejouer les vrais cas lents et bloqués avec doublures déterministes.
7. Livraison : tag testé dans orchestrateur-dev, puis bond décidé par l’utilisateur ; observation réelle après le bond, aucune attente d’un chef vivant en dev.
8. Bascule à chaud par projet et capacité, exécutions épinglées à leur version ; retour au moteur précédent pour les nouvelles demandes, sans rejouer les effets.

## Décisions à soumettre à l’utilisateur

| Décision | Recommandation Astra | Conséquence |
|---|---|---|
| D1 — Parcours sans correspondance | Activer le générique borné, avec plan visible ; pas de confirmation supplémentaire pour une action déjà autorisée | Complète la ligne « lacune » du Routage §3.3 ; ne change aucune décision du §5 |
| D2 — Organisation des génériques | Une entrée Générique ; « document » comme mode réutilisable de Rédaction, « inspection » de Discussion, « acquisition simple » de Données | Évite une nouvelle taxonomie de micro-pipelines ; ces parcours restent directement sélectionnables |
| D3 — Création après répétition | Trois demandes indépendantes en trente jours ; deux contextes distincts, ou répétition explicite d’un même workflow ; demande explicite utilisateur prioritaire | Seuil de proposition, jamais d’activation automatique ; une famille critique peut être étudiée dès le premier cas |
| D4 — Composition et limites | Trois niveaux incluant la racine, douze nœuds maximum pour un plan générique, deux branches de lecture simultanées au départ | Budgets partagés ; les limites TDD existantes ne changent pas |
| D5 — Mode léger | L’étendre d’abord au non-code, sur périmètre et risques objectifs | Ne change ni le choix léger/complet du Dev ni ses seuils actuels ; tout changement ultérieur relève d’une décision distincte |
| D6 — Models | Conserver les affectations existantes ; proposer un model plus léger seulement pour extraction/classement bornés, après comparaison | Aucun fallback automatique, aucune modification d’une case choisie sans décision ; le chef reste sur claude-sonnet-5-5 |
| D7 — Déploiement | Étudier une famille « publier une version vérifiée », avec adaptateurs serveur et appareil, distincte de l’action ponctuelle | Regroupe les trois lacunes récentes ; ni installation ni bond ni envoi externe implicitement autorisé |
| D8 — Périmètre initial | Phase 0, document générique et Réunion → Rédaction d’abord ; effort total 10–15 j hors observation et travaux du Routage | Gains visibles tôt ; ne pas commencer par un moteur universel ni une base de données |

## 1. Corpus, sources et méthode

### 1.1 Périmètre effectivement lu

Lecture seule de `I:/orchestrateur/logs/runs/*/run.json`, de `logs/pipeline-classify.ndjson`, de `logs/pipeline-observe.ndjson`, des événements de pipeline dans les journaux des douze projets observés, et des seules rubriques `custom`/`gapDecisions` de `model-routing.json`. Les chemins de cette phrase sont relatifs à la production sauf indication contraire. Recherche de `logs/runs` à la racine de tous les dossiers projet sous `I:/Dev` : aucun autre corpus trouvé, pas de `logs/runs` dans orchestrateur-dev. Les exécutions sont centralisées en production, même quand leur projet est ailleurs.

650 fichiers `run.json` valides, créés du 8 octobre 22:48 UTC au 19 octobre 18:25 UTC. Un 651e dossier, `p-20261014T183249-4966c1`, ne contient pas de `run.json` et est exclu. Photographie prise le 20 octobre vers 07:42 UTC ; les journaux ne constituent pas un historique immuable des versions du moteur. Statuts relus : 637 `done`, 5 `paused`, 2 `interrupted`, 6 `abandoned`. Les quatre anciennes pauses du chef sont désormais `abandoned` : ne pas proposer de les clore une seconde fois.

Projets représentés : pipelineLab, frenchradio, veille, devopsPrep, chef, panierIL, RemotePad, TranslateOverlay, youtube-live, Ayor, jellyfin et orchestrateur-dev. Le corpus inclut les essais de mise en service explicitement nommés dans les demandes, notamment pipelineLab ; ce n’est pas un échantillon aléatoire de travail courant. Le détail par projet figure en annexe.

Sources de conception lues dans la dev : `scripts/pipeline-engine.mjs`, `pipeline-catalog.mjs`, `pipeline-catalog-media.mjs`, `pipeline-classify.mjs`, `pipeline-observe.mjs`, `model-routing.mjs`, ainsi que les règles prod/dev. La liste des suites existantes a été consultée, sans les exécuter. Les sources de Routage ont été lues pour cohérence, sans lire les études concurrentes de pipelines.

### 1.2 Définitions et limites de mesure

- **Durée murale W** : `endedAt - createdAt` sur les seuls `done`. Un `endedAt` existe aussi sur certaines pauses : il ne signifie donc pas réussite.
- **Durée des étapes S** : somme de `durationMs`. Elle inclut le tour du model et ses outils, mais pas nécessairement les validations lancées ensuite par le moteur. Ce n’est pas du temps de génération pur.
- **Temps hors pauses H** : W moins les intervalles observés entre `pipeline_summary(status=paused)` et le prochain `pipeline_start` du même run. Il inclut tests, orchestration et attentes fournisseur internes. Les cibles de vitesse portent sur H.
- **Médiane** : moyenne des deux valeurs centrales si l’effectif est pair. **p95** : rang supérieur `ceil(0,95 × n)` ; avec moins de vingt cas, c’est le maximum, pas une estimation robuste de la queue.
- **Appels** : tours d’étape tentés hors `source=code`, hors `skipped`, `launch_failed` et `model_unavailable`, y compris les échecs après lancement. Les affectations nulles héritées du projet comptent : `served` prouve notamment les tours de Réunion et Vidéo. Les échanges internes d’un agent avec son fournisseur ne sont pas dénombrables dans `run.json`.
- **Critères** : taux `refused / (ok + refused)` sur les occurrences non sautées. Les 11 `failed`, 14 `launch_failed` et 1 `model_unavailable` sont séparés ; ils ne prouvent pas un défaut du livrable.
- **Essais** : nombre d’occurrences avec `attempt > 1`, borne basse des répétitions. Un nouveau tour après pause ou une boucle de revue peut repartir à 1. Les journaux portent aussi vingt événements `pipeline_loop`.
- **Pauses** : exécutions ayant au moins un résumé `paused`, et nombre d’épisodes. Le taux par étape utilise le nombre d’exécutions ayant atteint l’étape ; un nombre d’épisodes peut dépasser ce dénominateur.
- **Attentes** : intervalles pause → reprise effectivement fermés, séparés des pauses toujours ouvertes et du backoff. L’attente en file avant création du run, la latence réseau et le temps de test ne sont pas séparables globalement ; marquer ces valeurs non mesurées, jamais zéro.
- **Anomalie d’horloge** : sur `p-20261009T014516-e88f28`, S = 941 s dépasse `activeMs` = 655 s ; sur `p-20261018T091024-0e199e`, S = 2 132 s dépasse 668 s. Ne pas traiter `activeMs` comme une référence fiable sur tout l’historique, ni transformer automatiquement W − S en attente humaine.

Les 255 décisions de classement enregistrées du 12 au 19 octobre comprennent 250 classements de tâche, deux choix de variante média, deux entrées dispatch et une entrée source:chef. Toutes portent `ok=true`, ce qui prouve un résultat accepté par le parseur, pas une bonne orientation métier. Il manque les durées et le nombre d’essais internes : impossible de donner un p95 individuel du classifier à partir de ce journal. L’étape Routage « classifier » a, elle, une durée agrégée qui peut recouvrir plusieurs tâches. Les tableaux séparent donc ces décisions des tours d’étape.

### 1.3 Résultats et interprétation

Les tableaux exhaustifs par pipeline et étape sont en annexe. Hors Routage : 37 runs, dont 28 terminés. Les cinq pipelines sans observation sont Recherche, Audit, Nouveau, Images et Audio. Le catalogue standard compte bien quatorze pipelines et neuf sont observés. Cette distinction est importante pour ne pas fabriquer une référence.

Le classement actuel dispose d’un catalogue descriptif enrichissable, mais `ENGINE_PIPELINES` reste une liste de pipelines intégrés ; `runPipeline` refuse un identifiant absent. Dans la configuration observée, le pipeline personnalisé de déploiement `x-7e4cf1` est accepté et possède quatre cases génériques. Cela ne suffit pas à le rendre exécutable. C’est une incohérence de capacité, pas uniquement un problème de formulation du prompt. Le classificateur doit recevoir **uniquement les parcours réellement exécutables**, avec leurs contrats et préconditions.

Le lien Réunion → Rédaction existe déjà : `pipeline-catalog.mjs` copie les étapes de Rédaction dans Réunion et choisit entre `rangement`, `redaction`, `les-deux`. Il conserve les cases de Rédaction, mais n’offre pas un appel générique avec identité enfant, contrat et budget propre. Il constitue le premier adaptateur à migrer.

Plusieurs défauts historiques ont déjà des corrections dans la dev : critères de présentation Données, largeur des clés d’étape au-delà de 99, gestion des pannes d’infrastructure, et routage interne de Réunion. Les cas historiques servent à éprouver leur maintien et à guider la généralisation, pas à affirmer qu’ils restent tous ouverts.

## 2. Lacunes : passer de la phrase à la capacité

### 2.1 Exemples réels et contre-propositions

Le journal d’observation contient 1 775 observations, 28 occurrences de lacunes et 26 clés distinctes. La configuration contient quinze décisions sur ces clés : douze acceptations, trois rejets ; les acceptations ont produit onze rattachements et une création.

| Observation datée | Proposition réellement observée | Analyse et traitement conseillé |
|---|---|---|
| 8 octobre 16:18, vérifier une collection de films | « Verifie collection disney » ; finalement rattaché à Discussion | Le nom de collection est un paramètre. Famille : comparer un inventaire à une référence et produire les manques ; inspection + recherche si référence externe |
| 9 octobre 10:33, changer deux cases Models et continuer | « Passes décomposer rapporter » ; rejeté ensuite | C’est une réponse et un réglage de supervision. Le Routage doit conserver le contexte et exécuter une action typée, sans nouvelle famille |
| 10 octobre 18:05, « Mais ce dev devra etre fait sur dev » | « Devra etre » | Une contrainte de lieu sur la demande existante n’est pas un travail autonome ; rattachement explicite dans le registre |
| 10 octobre 19:09, « oui, hors pipeline » | « Hors pipeline » | Une autorisation ne devient pas un pipeline. Le Routage vérifie l’autorisation et garde la demande visée |
| 10 octobre 19:21, annuler des modifications de fichiers | « Annuler fichiers restore » | Famille : opération contrôlée sur un ensemble de fichiers, avec sauvegarde, liste exacte, autorisation et postcondition ; pas une famille par commande |
| 13 octobre puis deux fois le 19, déployer un serveur / installer un APK | Trois lacunes « déploiement/mise en prod » ; première acceptée le 16 | Famille pertinente, mais dupliquée autour de moyens différents. Contrat commun : version vérifiée, cible, autorisation, installation, santé, retour arrière ; adaptateurs distincts |

Les premières propositions sont celles de l’ancien `règles-v1`. Le code actuel ne fabrique plus ces suggestions par mots-clés, et les mots-clés hérités ne doivent pas être réactivés. Les trois lacunes récentes sont sémantiques : le problème restant est la couverture exécutable et la consolidation des observations.

### 2.2 Contrat d’une observation et seuil

Conserver dans un registre en fichiers : demande source, tâche du Routage, objectif global, résultat attendu, objets manipulés, effets autorisés, capacité manquante, candidats refusés et raison, proposition éventuelle, version du catalogue. Le texte global est du contexte ; le classement reste **un appel séparé par tâche**, conformément au Routage §5.3.

Dédupliquer par demande source et tâche, sans compter une relance comme un nouveau besoin. Un model peut proposer un regroupement sémantique ; le code conserve les preuves et calcule les effectifs. Le regroupement ne repose ni sur un nom de projet ni sur un mot comme « vidéo ». Les observations ambiguës restent séparées jusqu’à clarification.

À trois demandes indépendantes sur trente jours, proposer une revue de famille : au moins deux contextes distincts, ou une récurrence explicitement identifiée dans un contexte. Les trois signalements de déploiement ne doivent pas être présentés d’office comme trois demandes indépendantes : les deux du 19 peuvent appartenir au même objectif. Une demande utilisateur explicite de nouveau pipeline déclenche l’étude sans attendre le seuil.

La proposition répond à cinq questions : quel résultat récurrent, quelle couverture actuelle insuffisante, pourquoi un mode ou une composition ne suffit pas, quels critères exécutables, quel coût d’entretien ? Elle comporte trois exemples admissibles, deux contre-exemples et une voie de récupération. États : observé → regroupé → proposé → accepté pour construction → exécutable validé → actif. Rejet ou fusion restent traçables ; aucune suppression silencieuse des choix existants.

## 3. Parcours par défaut et génériques

### 3.1 Avancer sans inventer une autorisation

Le classifier renvoie un parcours exécutable, une question de sens, ou une lacune. Une panne du classifier reste une panne d’infrastructure garée selon le Routage ; elle ne devient pas un prétexte pour improviser des effets.

Pour une lacune, le moteur crée une exécution Générique rattachée à la même tâche du registre. Un tour propose un petit graphe d’actions existantes, les sorties attendues, les fichiers autorisés et le budget. Le code valide le graphe et publie le plan dans la frise **avant** le premier effet. Une action déjà demandée peut démarrer après cette publication ; toute extension d’autorisation demande une réponse explicite.

Le plan initial comporte au plus six nœuds de travail, extensibles à douze dans le budget approuvé ; le comptage inclut les nœuds exécutables des sous-pipelines dépliés, afin de ne pas contourner la limite par composition. Une seule réparation de forme est tentée, jamais une suppression de contrainte. Une révision de fond est visible et validée avant effets nouveaux. La créativité porte sur la manière d’atteindre le résultat : comparer des inventaires, préparer un brouillon, transformer un document, assembler une recherche et une synthèse, proposer une méthode alternative.

La liberté du plan n’est pas un accès arbitraire au shell. Il utilise des actions enregistrées et des outils bornés par leurs droits. Les transformations travaillent sur une copie préparatoire ; le code contrôle le manifeste et applique seulement les modifications autorisées. Un moyen inconnu peut être décrit comme proposition, pas exécuté automatiquement avec des permissions plus larges.

Si une entrée manque, produire ce qui reste utile : inventaire, diagnostic, brouillon à trous explicites, plan avec prochaine action et responsable. Statuts de sortie : réussi, partiel avec manque explicite, attend utilisateur, garé infrastructure, échec récupérable, annulé. Un résultat partiel n’est jamais déclaré réussi et ne libère pas un successeur qui attend la sortie manquante. Chaque attente possède une cible, des actions « préciser / corriger / reprendre / annuler » et un point de reprise enregistré.

### 3.2 Parcours courts ancrés dans les demandes

| Parcours et preuve du besoin | Étapes courtes | Critères vérifiés par le code | Réutilisation et lien avec Générique |
|---|---|---|---|
| **Document existant**, mode de Rédaction : sections de portfolio corrigées les 12 octobre, puis ajout explicite de l’utilisateur « relire, corriger, résumer, traduire, reformater, compléter » | Capturer source et consigne → transformer et relire → vérifier le diff et remettre | Source existante, empreinte initiale, seul fichier métier autorisé modifié, sortie ouvrable, format et composants protégés conservés, diff accessible, liens internes contrôlés | Réunion, Recherche et Générique appellent la même brique ; résumé/traduction peuvent produire une sortie nouvelle déclarée, sans remplacer la source |
| **Texte nouveau / brouillon**, mode de Rédaction : mail demandé le 16 octobre | Rassembler les références → rédiger et relire → remettre le brouillon | Fichier non vide, format, références existantes, destinataires conformes au contrat, absence d’effet d’envoi ; champs inconnus explicitement signalés | Réunion appelle Rédaction avec ses références ; Générique choisit ce mode lorsqu’un livrable textuel suffit |
| **Inspection / comparaison**, mode de Discussion : comparaison de deux répertoires le 19 octobre, vérification de collection | Inventorier par le code → comparer / expliquer → publier preuves et écarts | Inventaires datés, aucune modification métier, chemins réels, comptes et différences reproductibles, empreintes si identité de contenu demandée | Brique d’Audit, Recherche, Réunion ; premier progrès en lecture seule quand la demande est encore incomplète |
| **Acquisition simple**, mode de Données : téléchargement d’un reel le 19 octobre, archivage vidéo le 12 | Résoudre source et cible → acquérir → contrôler / remettre | Fichier présent, taille non nulle, URL et empreinte enregistrées, format/durée via analyseur, destination autorisée ; aucun montage ou changement de lecteur implicite | Vidéo/Audio et Générique l’utilisent ; si la demande modifie un lecteur ou du code, composer ensuite avec Dev et ses garanties |
| **Opération ponctuelle**, profil du Générique : ajouter deux TODO le 19 octobre, push de commits déjà autorisé, restauration ciblée le 10 | Préparer état et effet exact → exécuter adaptateur → vérifier postcondition | TODO relus sans perte d’entrées ; push limité à la référence et aux commits autorisés, référence distante vérifiée ; restauration limitée à la liste sauvegardée | Livraison ou supervision peuvent l’appeler ; l’action du chef reste au chef si le Routage l’identifie comme telle |

« Seul le fichier visé a changé » signifie seul **fichier métier** modifié par cette opération, par rapport à l’état initial, sans écraser le travail déjà présent. Les journaux et copies de sauvegarde résident hors de ce périmètre métier et sont déclarés. Un travail documentaire n’exige pas Git : sauvegarde + hash + diff suffisent ; commit local seulement si demandé ou prévu par le contrat du projet.

Pour DOCX/ODT/PPTX, contrôler l’intégrité du conteneur, les composants et styles protégés, puis rendre le résultat si une mise en page doit être préservée. Pour PDF, valider structure/pages et comparaison rendue. Une simple égalité d’extension ne prouve pas le format conservé. Le code ne peut pas certifier à lui seul une traduction fidèle ou un bon ton : il vérifie les contraintes objectives, conserve la relecture et expose les limites de validation sémantique. Un document peut contenir des instructions hostiles ; son contenu reste une donnée, jamais une source de droits.

Le mode « document » est sélectionné par l’effet attendu, pas seulement par l’extension : modifier une spécification exécutable, un test d’exigence ou un comportement documenté protégé peut nécessiter Dev et une décision. Un générique ne contourne jamais une garantie de code en renommant le fichier.

## 4. Composition : contrat et moteur

### 4.1 Contrat minimal versionné

| Partie | Champs / règle |
|---|---|
| Identité | `pipelineId`, `definitionVersion`, `contractVersion`, `requestId`, `taskId`, `rootRunId`, `parentRunId`, `callNodeId` |
| Entrée | Objectif, mode, références d’artefacts et leurs hashes, paramètres typés, langue, résultat attendu ; aucun passage implicite de tout l’historique |
| Droits | Racines lisibles, chemins modifiables, effets externes, autorisations et leur portée ; droits de l’enfant inclus dans ceux du parent |
| Exécution | Dépendances, préconditions, cases Models résolues, budgets, mode de livraison, identifiant d’idempotence |
| Sortie | Statut, artefacts typés avec chemins/hashes, preuves de contrôle, changements réels, limites, défauts restants, éventuelle question ciblée |
| Succès | Toutes les sorties requises existent et passent les contrôles de l’enfant **et** les postconditions métier du parent |

Exemple : Réunion fournit les références de transcription, notes et mail source à Rédaction, avec langue et destinataires, et demande un `emailDraft`. Rédaction retourne le brouillon, sa relecture et les points manquants. Réunion vérifie que les références existent, que les destinataires sont ceux demandés, et publie le brouillon. **Préparer n’autorise pas envoyer.** Un éventuel envoi utilise un effet séparé, autorisé et vérifié.

### 4.2 Imbrication, critères et anti-boucle

- Trois niveaux incluant la racine : Réunion → Rédaction → inspection documentaire est admissible ; un quatrième niveau est refusé avant lancement.
- Détection des cycles dans les définitions et dans la pile réelle des appels : A → B → A est refusé, même avec un autre alias ou mode. Les identifiants canoniques font foi.
- Identité enfant stable dérivée de l’appel parent et de la version du plan. Une reprise rattache l’enfant existant ; elle ne crée pas un nouveau run ni un nouveau commit.
- Un budget racine couvre toutes les branches : nombre de tours, temps actif, durée des attentes, nombre de nœuds, quota si disponible. Les enfants n’obtiennent pas chacun un nouveau budget de 90 minutes.
- Deux essais de critère et une révision du plan pour le générique ; les plafonds Dev existants, dont trois essais verts, restent inchangés. Une pause ne remet pas à zéro le compteur cumulatif.
- Même erreur et mêmes empreintes d’entrée/sortie sur deux essais : arrêt de la répétition automatique, diagnostic ciblé. Un utilisateur peut accorder un budget supplémentaire explicitement, mais aucun défaut n’est déclaré corrigé par cette seule prolongation.
- Toute preuve porte les hashes des entrées, sorties, commande, environnement et version du contrôle. Changement d’une dépendance → preuve périmée → contrôle refait. Les validations de sécurité et les actions externes ne se déduisent jamais d’un simple texte « fait ».

Les garanties des étapes rouge, vert sans toucher aux tests, revue indépendante et livraison restent des contrats indivisibles. Les briques qui produisent ou modifient du code passent par ces portes ; une composition ne peut déclarer « vert » sans preuve du test ni livrer un défaut non résolu.

### 4.3 Pauses, modèles, concurrence et frise

Une pause enfant remonte un jeton ciblé sur cet enfant, son motif et les choix réellement possibles. Le parent est `attend_enfant`, les successeurs dépendants restent bloqués. Les branches indépendantes déjà autorisées peuvent finir leurs lectures ; aucune nouvelle écriture parallèle n’est ouverte pendant une question qui pourrait modifier le périmètre. Répondre explicitement au jeton reprend le point précis ; citer un run dans une discussion ne reprend rien.

Annuler le parent annule les tâches non démarrées et demande l’arrêt contrôlé des enfants actifs appartenant à cette exécution ; aucun processus partagé n’est tué. Les effets déjà réalisés restent inscrits et ne sont pas annulés fictivement. Une compensation destructive exige son propre contrat et l’autorisation applicable.

Résolution Models : case canonique de l’enfant, variante éventuelle, héritage actuel affiché ; le parent ne remplace pas silencieusement le model. La version du plan enregistre le choix résolu. Un changement à chaud s’applique aux futures étapes selon un événement explicite ; il n’altère pas les preuves déjà acquises. Les sessions restent séparées entre auteur et revue indépendante, entre projets, droits et versions incompatibles.

La frise garde une carte racine avec résultat attendu, plan affiché, temps actif/contrôles/attentes séparés, puis des cartes enfants dépliables. Un appel fusionné peut satisfaire plusieurs jalons, mais est affiché comme **un** appel ; une étape sautée porte sa raison. Chaque carte montre case/model réellement servi, essai cumulatif, preuve et bouton de reprise ciblée. Les durées du parent ne somment pas deux fois celles des enfants.

Reproductibilité : conserver les versions du plan, des prompts, outils, contrôles et paramètres du model, les références d’entrée, les réponses reçues et leurs hashes. Le rejeu des transitions et contrôles sur ces artefacts doit être déterministe. Une nouvelle génération de texte par un model n’est pas garantie identique mot pour mot ; elle constitue une nouvelle tentative traçable, jamais la même preuve. Un effet externe est réconcilié avec son résultat réel, pas rejoué aveuglément.

Parallélisme : deux branches de lecture au départ, snapshots communs, dépendances déclarées. Écritures sérialisées dans un même périmètre ; des couloirs isolés existants peuvent être utilisés si leurs règles d’intégration le permettent. Pas de parallélisation rouge/vert/revue sur le même changement.

### 4.4 Briques à extraire, sans multiplier les pipelines

| Brique | Origine actuelle | Contrat réutilisable |
|---|---|---|
| Rédaction documentaire / brouillon | Rédaction, copie actuellement intégrée à Réunion | Sources → document ou brouillon relu ; pas d’envoi |
| Recherche et synthèse | Recherche : cadrer, rechercher, lire, recouper, synthétiser | Question → références datées, faits recoupés, incertitudes |
| Inspection et inventaire | Discussion, Réunion, Audit | Périmètre en lecture seule → inventaire vérifié et écarts |
| Acquisition / contrôle média | Données, Images, Vidéo, Audio | Source → fichier valide, provenance, caractéristiques |
| Revue | Dev, Audit, Rédaction | Snapshot → défauts structurés ; contexte indépendant quand requis |
| Livraison | Dev et autres `livrer` | Artefacts vérifiés + effet autorisé → résultat observable et preuve |

Livraison est une famille de contrats : remettre un fichier, commiter, pousser, publier et envoyer sont des effets différents. Un enfant prépare ; par défaut la racine possède l’effet final. Si le contrat historique exige une livraison enfant, son effet est enregistré, puis exclu de la livraison parent. Il ne faut ni double commit ni double bump. Les livraisons par item déjà prévues en Dev restent intactes.

## 5. Vitesse : gains plausibles et garanties

### 5.1 Actions proposées

**Phase 0.** Ajouter des mesures d’étape distinctes `modelMs`, `toolMs` si observable, `checkMs`, `waitMs`, `queueMs` et les compteurs de lancement. Diagnostiquer le motif avant de relancer : « aucun commit » après une commande refusée n’est pas résolu en redemandant la même chose huit fois. Réutiliser le gabarit de réparation du Routage et ses catégories infrastructure, sans modifier deux fois ce chantier.

**Fusions non-code.** Discussion simple : comprendre, rechercher localement et répondre dans un même tour outillé, avec preuves de lecture vérifiées. Recherche : réunir cadrage et plan, paralléliser les lectures indépendantes, garder recoupement/synthèse. Rédaction : premier tour produit le texte au bon format ; relecture conservée selon le contrat, application mécanique des corrections structurées et contrôle par le code. Correction complexe ou ambiguë → étape de rédaction supplémentaire, pas application aveugle.

**Travail mécanique.** Le code énumère les fichiers, calcule différences et hashes, applique un renommage approuvé, vérifie un média, écrit le bloc de faits final. Il ne crée pas de test utilisateur pour une simple correction typographique, mais les futures fonctionnalités de ce moteur seront toutes protégées par la non-régression. Un livrable inchangé peut être un succès justifié (« déjà conforme ») sans écrire un fichier artificiel.

**Léger.** Étendre le léger aux parcours non-code bornés : fichier unique, lecture seule, acquisition simple, brouillon. Conserver les contrôles indispensables, supprimer les étapes sans utilité pour le résultat. Ne pas classer systématiquement une acquisition comme transcription ou montage faute d’option « inutile ». Le mode léger actuel n’a pas empêché le push de passer quatre étapes Maintenance.

**Sessions et cache.** Le moteur réutilise déjà des sessions par groupe via `stepSessionGroup` ; ce n’est pas un gain entièrement nouveau. Raffiner les paquets de contexte et les références d’artefacts ; pas de cache interprojet implicite. Cache exact sur hashes, version d’outil, configuration et environnement ; les appels externes sensibles au temps ont une échéance explicite ou restent non cachables. Une revue indépendante ne reprend jamais la session de l’auteur.

**Critères moins coûteux.** Vérifier d’abord format, existence, scope et préconditions par le code, avant les contrôles longs. Éviter de relancer une suite identique deux fois sur le même snapshot si la règle actuelle autorise une preuve réutilisée ; ne jamais supprimer un test ni remplacer une obligation de passage avant/après sans accord. La preuve doit être invalidée dès qu’un fichier testé change, y compris pendant le lancement. Pour Dev, l’optimisation initiale porte sur le contexte et les contrôles redondants autorisés, pas sur la fusion des portes.

**Models.** Comparer sur le corpus les affectations existantes à un model moins coûteux pour extraction structurée et classement bornés. Conserver les models de conception/revue tant que la qualité n’est pas démontrée. Le corpus montre des modèles servis différents selon les cases ; il ne permet pas d’attribuer causalement un gain à un changement de model. Aucune réduction de latence hypothétique n’est comptée deux fois avec une fusion d’étapes.

### 5.2 Estimations avant / après par pipeline

Unités : secondes. « Avant mesuré » = H médiane / p95 des réussites ; les pauses sont exclues par événements, pas effacées de l’expérience utilisateur. « Après » est une hypothèse de médiane / enveloppe p95 à valider, sur le **même besoin**, pas un résultat observé. Les données à n=1 ne constituent pas une distribution. La comparaison ne remplace pas les tableaux de durées murales en annexe.

| Pipeline | Avant mesuré H médiane / p95 (n réussites) | Après proposé médiane / p95 | Justification / limites |
|---|---|---|---|
| Discussion | 134 / 465 (10) | 45–75 / 150–240 | Trois tours utiles fusionnables en un ; 7 refus dans Comprendre à éviter par références structurées |
| Dev | 315 / 991 (6) | 280–315 / 850–991 | Gain modeste 0–11 % sur travail comparable ; rouge, vert, revue, livraison inchangés ; sorties génériques comptées à part |
| Incident | 814 / 814 (1) | 650–800 / 1 200 | Préparation factuelle commune ; pas de fusion des garanties de correction ; p95 cible de contrôle, pas estimation statistique |
| Recherche | Non mesuré | 120–200 / 360 + temps externe | Budget analytique : 5 tours de 30–50 s → 3–4 tours avec lectures parallèles ; avant hypothétique 150–250 s + temps externe |
| Audit | Non mesuré | 180–300 / 600 + scans/correction | Avant hypothétique 7 tours × 30–60 s = 210–420 s + scans/correction ; conserver les deux avis indépendants |
| Maintenance | 192 / 192 (1, push ponctuel) | 20–60 / 120 pour ce push | Utiliser l’adaptateur d’opération autorisée ; ne pas généraliser ce gain à une vraie maintenance de dépendances |
| Nouveau | Non mesuré | 105–240 / 480 + construction/tests | Avant hypothétique 4 tours × 30–60 s = 120–240 s + construction/tests ; gains surtout sur préparation, aucune promesse sur le MVP |
| Données | 357 / 357 (1, acquisition) | 110–170 / 300 + variation réseau | Acquisition simple, vérification et restitution ; supprimer les étapes de nettoyage/présentation inutiles |
| Rédaction | 241 / 459 (7) | 130–180 / 300–360 | Retirer environ 33 s de mise en forme et 24 s de livraison model mécanique, selon corrections requises |
| Réunion | 241 / 241 (1, rangement malgré demande de mail) | 90–150 / 240 pour rangement ; 130–180 / 360 pour mail | Séparer le choix de parcours du gain de moteur ; aucune promesse sur les 16 h 50 d’attente humaine |
| Routage | 104 / 172 (411 demandes réussies) | ≤45 / ≤90 | Cible déjà décidée dans la synthèse ; ne pas l’attribuer au présent chantier |
| Images | Non mesuré | 60–120 / 240 + génération | Avant hypothétique 4 tours × 30–60 s = 120–240 s + génération ; acquisition/validation mécanique, contrôle visuel conservé |
| Vidéo | 802 / 802 (1, récupération) | 450–600 / 900 pour ce cas | Acquisition observée 407 s ; retirer analyse/montage sans rapport, conserver validation ; 9 tours → 2–3 hors classifier |
| Audio | Non mesuré | 60–120 / 240 + traitement | Avant hypothétique 4 tours × 30–60 s = 120–240 s + traitement ; ne pas supprimer écoute/validation nécessaire |

Les budgets analytiques non observés ne sont pas des percentiles prédits : temps externe, scans, construction et traitement s’ajoutent et peuvent dominer. Leur première validation consiste à créer un banc représentatif, pas à annoncer un pourcentage gagné. Le coût en dollars affiché par les CLI reste un équivalent API de consommation, pas une facture ; aucun gain financier n’est établi ici.

## 6. Migration, retour arrière et validation future

### 6.1 Bascule contrôlée

Proposer un réglage relu à chaud `pipelineExecution: legacy | shadow | v2`, par projet avec capacités optionnelles (`generic`, `composition`, `fastNonCode`). Ne pas le confondre avec `enforcement.chefMode` du Routage. `shadow` valide/classifie les plans, avec effets interdits ; si une comparaison appelle un model, son quota reste plafonné et enregistré.

Chaque run fige version du moteur, définition du graphe et contrats. Bascule : nouvelles demandes seulement ; les pauses existantes reprennent dans leur moteur d’origine. Une migration manuelle crée un lien explicite et reprend les effets déjà prouvés, sans les réexécuter. La persistance reste JSON/JSONL et fichiers annexes avec écriture atomique/verrou, sans base de données.

Retour arrière : arrêter les nouveaux départs v2, repasser `legacy` à chaud, conserver le lecteur et la commande de secours v2 pour terminer ou annuler ses runs. Une nouvelle demande Générique ne doit pas retomber dans un pipeline legacy incompatible : conserver une entrée récupérable avec choix explicite. Si le binaire précédent ne comprend pas un run v2, ne jamais le lui confier ; la compatibilité de lecture précède le bond.

Production : développement, fixtures et non-régression sur orchestrateur-dev ; instance isolée de recette seulement selon la procédure du projet. Tag testé, puis bond par la procédure habituelle et sur décision utilisateur. Mesure en production après le bond ; les exécutions réelles ne peuvent pas être observées pendant « une semaine de chef en dev ».

### 6.2 Tests à implémenter, pas à lancer pour cette étude

Chaque demande fonctionnelle citée ci-dessous devra être datée, reproduite verbatim et reliée à ses tests dans `docs/USER_REQUIREMENTS.md`, puis intégrée à la non-régression et à `regression-perimeters.json`. Avant et après chaque modification de code future, rejouer les suites applicables. Aucun fichier de test ou registre d’exigences n’est modifié par cette étude documentaire.

| Exigence | Vérification automatique future |
|---|---|
| « big picture », propositions moins atomiques | Corpus des six exemples §2 : aucune famille créée pour « Devra etre »/« Hors pipeline » ; regroupement déploiement, relances dédupliquées, seuil calculé par code, activation refusée sans capacité exécutable |
| « si aucun pipeline est trouve… avancer » | Lacune → plan visible avant effets → artefact utile ou question ciblée ; absence de boucle sans sortie ; panne classifier garée, jamais assimilée à autorisation |
| « utiliser ou etre utilise par un autre pipeline » | Réunion → Rédaction, sorties typées, propagation des droits, erreurs de schéma, profondeur, cycles directs/indirects, budget racine, idempotence après crash |
| « tout en gardant la predictabilite » | Effet hors scope refusé, plan modifié annoncé, frise fidèle aux appels, pause enfant ne libérant aucun successeur, absence de changement silencieux de model |
| « travail ponctuel sur un document » | Source absente, diff sur fichier unique, fichier étranger inchangé, conservation de format/éléments protégés, résumé sans écrasement de source, échec d’ouverture, modifications concurrentes |
| Garanties de code | Rouge échoue pour la bonne raison, vert ne touche pas aux tests, revue indépendante, aucune livraison avec défaut, aucune invalidation d’un test utilisateur par une composition |
| Migration et reprise | Run legacy repris après bascule, run v2 lisible après retour arrière, un effet externe au plus après crash, réponse ciblée, annulation et compensation distinguées |
| Vitesse et cache | Compteurs d’appels vérifiés avec doublures ; cache invalidé sur contenu/configuration/environnement ; résultat de test périmé si modification pendant exécution ; parallélisme limité et sans double écriture |

Rejouer notamment :

- `p-20261018T154104-6cfbe8` : huit refus de livraison identiques ; pas de neuvième essai automatique sans nouvelle preuve ou réparation, et jamais de faux succès.
- `p-20261019T144511-44d707` : contrôle de suite de 1 192–1 289 s dans les motifs ; isoler temps de validation, vérifier reprise avec message, ne pas relancer une suite inchangée arbitrairement.
- `p-20261019T163311-e4336f` : ajout de cinq vidéos en conflit avec deux assertions d’une exigence antérieure ; signaler le conflit, ne pas affaiblir les tests.
- `p-20261019T150341-318fcf` : acquisition utile puis deux refus de présentation et 22 min d’attente ; vérifier la correction existante et le parcours court.
- `p-20261016T155415-e67865` : mail envoyé au parcours de rangement ; plan mail sans suppression ni rangement implicite.
- `p-20261012T152601-2e8a3b` : récupération vidéo orientée transcription puis découpe ; aucune étape sémantiquement inutile forcée.
- `p-20261009T193934-083679` : clés d’étape à trois chiffres, quota de revue, backoff ; absence de boucles infinies et séparation infrastructure/critères.
- `p-20261019T145920-68172b` et `p-20261019T162957-4ebfbf` : ajout TODO et push autorisé sans travail de développement ou maintenance superflu.

Les fixtures sont minimisées et anonymisées avant versionnement : ne pas copier les journaux bruts, chemins personnels, contenu de mails ou secrets dans le dépôt public. Les ids ci-dessus servent à retrouver les preuves locales. Réutiliser et étendre les suites existantes (`_test_pipeline_gates`, `_test_pipeline_engine`, `_test_reunion_redaction_route`, `_test_pipeline_gaps`, `_test_infra_retry`, `_test_context_calibration`, tests d’items et de couloirs). Ne pas les supprimer. Le regroupement des tests exige exactement les conditions du Routage §5.9 : correspondance exhaustive, contrôle par script, anciennes suites gardées jusqu’au vert, exigences préservées, validation utilisateur avant suppression.

### 6.3 Critères de réussite et effort

Critères bloquants de sûreté : zéro effet hors périmètre, zéro doublon d’effet, zéro reprise implicite, zéro successeur libéré sur pause, zéro exigence affaiblie, 100 % des plans validés avant effet, et une sortie documentée pour chaque état non terminal. Ces invariants sont testés avec doublures et injection de crash ; ils ne sont pas déduits du seul taux de réussite d’un model.

Après bond : viser au moins trente demandes représentatives appariées par famille (ou observer quatorze jours et déclarer l’insuffisance d’effectif). Séparer mode, type de livrable, version et tests de laboratoire. Pour Discussion/Rédaction, viser au moins 25 % de réduction médiane de H, sans baisse de conformité sur corpus ; p95 stable ou amélioré. Pour Dev, priorité à la baisse des pauses évitables et des appels sans progrès, sans exiger un gain artificiel sur les garanties.

Mesurer le taux de résultat utile dès le premier parcours générique, cible initiale ≥90 % sur corpus préparé et ≥80 % sur les trente premiers cas réellement éligibles ; « partiel utile » doit être compté séparément de « réussi ». Zéro demande perdue. Viser <5 % de refus purement formels sur les parcours non-code, et aucune répétition automatique au-delà du plafond pour une erreur et un état inchangés. Mesurer séparément l’attente humaine ; sa réduction n’autorise pas la suppression de questions nécessaires.

Effort : 10–15 jours de travail, validation incluse, hors observation, recherche d’outils manquants et refonte du Routage déjà engagée. Le support de formats bureautiques complexes peut ajouter 2–4 jours si les adaptateurs disponibles ne suffisent pas ; livrer alors d’abord texte/Markdown et un échec explicite pour formats non supportés. Risque principal : élargir les capacités plus vite que les contrôles et mélanger catalogues descriptifs et exécutables.

## 7. Points de jonction avec le Routage décidé

| Décision du §5 | Application au chantier pipelines |
|---|---|
| 1 — Registre en fichiers | Demande/tâche reste au registre du Routage ; runs et enfants en fichiers, sans second ordonnanceur de demandes |
| 2 — Tour unique du chef, claude-sonnet-5-5 | Inchangé ; le plan générique est exécuté par le musicien, pas par des tours supplémentaires du chef |
| 3 — Classer chaque tâche séparément, en parallèle | Inchangé ; enrichir le contexte du besoin global et le catalogue exécutable sans classifier tout le message d’un bloc |
| 4 — Reprise explicite | Jeton de pause enfant ciblé ; citation documentaire sans effet |
| 5 — Réveils par code, chef si décision | Avancement enfant traité par code ; réveil pour échec, question, décision ou rapport promis |
| 6 — Routage chef coupé pour l’instant | Aucun rallumage proposé par cette étude ni couplage à la bascule du moteur des musiciens |
| 7 — Anciennes pauses à clore | Déjà `abandoned` dans la photographie ; conserver l’historique, aucune seconde action |
| 8 — Actions du chef par commande autorisées et inscrites | L’adaptateur d’opération ne déplace pas ces actions chez un musicien ; enregistrement et postcondition communs |
| 9 — Regroupement des suites sous conditions | Aucune suppression ici ; appliquer les cinq conditions exactes pendant la future migration |

Le seul complément fonctionnel à arbitrer est le traitement automatique **dans un pipeline générique** de la ligne « aucun pipeline adapté » du Routage §3.3. Il préserve la tâche et les garde-fous, sans autorisation « hors pipeline » inventée. La séparation test rouge / code vert / revue / livraison rappelée en fin de §5 demeure obligatoire.

## Annexe A — Mesures détaillées

Les tableaux ci-dessous sont calculés sur la photographie décrite au §1. Les valeurs absentes signifient « non mesuré », pas une durée nulle.

### A.1 Durées et appels par pipeline

Durées en secondes, W et S sur les réussites seulement. Les tours cumulent toutes les exécutions, réussies ou non ; les tours médians portent sur les réussites. Les 255 décisions classifier sont présentées séparément, car leur attribution par run et leur durée individuelle manquent.

| Pipeline | Runs / réussites | W médiane / p95 | S médiane / p95 | Tours de model total / médiane |
|---|---:|---:|---:|---:|
| discussion | 10 / 10 | 134.3 / 465.5 | 131.1 / 462.9 | 37 / 4 |
| dev | 14 / 6 | 314.9 / 83165.3 | 276.1 / 940.6 | 257 / 7 |
| incident | 1 / 1 | 813.9 / 813.9 | 689.8 / 689.8 | 9 / 9 |
| recherche | 0 / 0 | — / — | — / — | 0 / — |
| audit | 0 / 0 | — / — | — / — | 0 / — |
| maintenance | 2 / 1 | 192.4 / 192.4 | 176.5 / 176.5 | 9 / 4 |
| nouveau | 0 / 0 | — / — | — / — | 0 / — |
| donnees | 1 / 1 | 1685.7 / 1685.7 | 316.3 / 316.3 | 7 / 7 |
| redaction | 7 / 7 | 240.6 / 458.5 | 234.9 / 433.5 | 29 / 4 |
| reunion | 1 / 1 | 60849.8 / 60849.8 | 228 / 228 | 6 / 6 |
| routage | 613 / 609 | 96.7 / 165.8 | 94.7 / 163.5 | 2199 / 4 |
| images | 0 / 0 | — / — | — / — | 0 / — |
| video | 1 / 1 | 801.6 / 801.6 | 778.8 / 778.8 | 9 / 9 |
| audio | 0 / 0 | — / — | — / — | 0 / — |

### A.2 Refus, essais et pauses par pipeline

Le taux de refus exclut les erreurs de lancement/infrastructure. Le taux de pause est historique : une exécution finalement terminée peut avoir attendu plusieurs fois. Zéro pause observée ne mesure pas les attentes fournisseur.

| Pipeline | Refus / critères | Essais numérotés >1 | Runs avec essai >1 | Runs ayant été en pause | Épisodes de pause / encore paused |
|---|---:|---:|---:|---:|---:|
| discussion | 7/37 (18.9 %) | 7 | 7/10 (70.0 %) | 0/10 (0.0 %) | 0 / 0 |
| dev | 42/252 (16.7 %) | 30 | 10/14 (71.4 %) | 9/14 (64.3 %) | 29 / 4 |
| incident | 1/9 (11.1 %) | 1 | 1/1 (100.0 %) | 0/1 (0.0 %) | 0 / 0 |
| recherche | — | 0 | — | — | 0 / 0 |
| audit | — | 0 | — | — | 0 / 0 |
| maintenance | 2/9 (22.2 %) | 1 | 1/2 (50.0 %) | 1/2 (50.0 %) | 1 / 1 |
| nouveau | — | 0 | — | — | 0 / 0 |
| donnees | 2/7 (28.6 %) | 1 | 1/1 (100.0 %) | 1/1 (100.0 %) | 1 / 0 |
| redaction | 1/29 (3.4 %) | 1 | 1/7 (14.3 %) | 0/7 (0.0 %) | 0 / 0 |
| reunion | 1/8 (12.5 %) | 1 | 1/1 (100.0 %) | 1/1 (100.0 %) | 1 / 0 |
| routage | 49/3214 (1.5 %) | 52 | 52/613 (8.5 %) | 4/613 (0.7 %) | 4 / 0 |
| images | — | 0 | — | — | 0 / 0 |
| video | 0/9 (0.0 %) | 0 | 0/1 (0.0 %) | 0/1 (0.0 %) | 0 / 0 |
| audio | — | 0 | — | — | 0 / 0 |

### A.3 Attentes observées

Intervalle mesuré : résumé paused vers prochain démarrage du même run. Ces attentes comprennent temps humain et inactivité technique ; les logs ne permettent pas de les départager. Les épisodes sans reprise, même si clos ensuite, sont exclus de cette distribution. Les pauses encore ouvertes sont des observations censurées au 20 octobre 07:42:29 UTC.

| Pipeline | Intervalles fermés | Somme (s) | Médiane / p95 (s) |
|---|---:|---:|---:|
| discussion | 0 | 0 | — / — |
| dev | 23 | 489407.9 | 667.5 / 144085.4 |
| incident | 0 | 0 | — / — |
| recherche | 0 | 0 | — / — |
| audit | 0 | 0 | — / — |
| maintenance | 0 | 0 | — / — |
| nouveau | 0 | 0 | — / — |
| donnees | 1 | 1328.9 | 1328.9 / 1328.9 |
| redaction | 0 | 0 | — / — |
| reunion | 1 | 60609 | 60609 / 60609 |
| routage | 0 | 0 | — / — |
| images | 0 | 0 | — / — |
| video | 0 | 0 | — / — |
| audio | 0 | 0 | — / — |

Pauses toujours ouvertes :

- p-20261009T123458-2a1135 (dev) : au moins 259.1 h depuis le dernier résumé de pause.
- p-20261009T193934-083679 (dev) : au moins 249.0 h depuis le dernier résumé de pause.
- p-20261019T144511-44d707 (dev) : au moins 13.7 h depuis le dernier résumé de pause.
- p-20261019T163311-e4336f (dev) : au moins 15.0 h depuis le dernier résumé de pause.
- p-20261016T132118-ddfd3b (maintenance) : au moins 90.3 h depuis le dernier résumé de pause.

En plus, six backoffs fermés sur Dev/vert, dans p-20261009T193934-083679 : 10 + 20 + 30 + 40 + 50 + 60 s annoncées, soit 210 s (environ 210,2 s entre événements). Ils sont à distinguer des pauses de tableau. Les délais en file avant création et les attentes fournisseur sans événement dédié ne sont pas quantifiables ici.

### A.4 Mesures par étape

n = occurrences non sautées, réussies ou non. Durées en secondes. Tours = lancements de model selon le §1.2 ; une étape de code peut elle-même appeler le classifier (voir note Routage). Refus = refus/critères ; pauses = nombre de runs avec notification de limite sur cette étape / nombre de runs ayant atteint cette étape (étape ou événement), puis nombre de notifications. Attente = somme des intervalles de pause fermés attribuables à cette étape. Les valeurs 0 ne couvrent pas les attentes non instrumentées.

| Pipeline / étape | n | Médiane / p95 (s) | Tours | Refus / critères | Essais >1 | Runs en pause / atteints ; épisodes | Attente (s) |
|---|---:|---:|---:|---:|---:|---:|---:|
| discussion / comprendre | 17 | 39.4 / 171.6 | 17 | 7/17 (41.2 %) | 7 | 0/10 (0.0 %) ; 0 | 0 |
| discussion / rechercher | 10 | 37.8 / 118.9 | 10 | 0/10 (0.0 %) | 0 | 0/10 (0.0 %) ; 0 | 0 |
| discussion / repondre | 10 | 29.9 / 195.3 | 10 | 0/10 (0.0 %) | 0 | 0/10 (0.0 %) ; 0 | 0 |
| dev / rouge | 87 | 50.9 / 98.2 | 87 | 5/87 (5.7 %) | 3 | 2/11 (18.2 %) ; 2 | 248708.7 |
| dev / vert | 89 | 33.8 / 115.6 | 75 | 26/74 (35.1 %) | 19 | 5/12 (41.7 %) ; 8 | 7500.7 |
| dev / revue | 52 | 33.2 / 214.8 | 52 | 0/48 (0.0 %) | 2 | 2/11 (18.2 %) ; 5 | 3455.2 |
| dev / livrer | 18 | 31 / 100.9 | 18 | 11/18 (61.1 %) | 6 | 2/8 (25.0 %) ; 5 | 82523.5 |
| dev / comprendre | 3 | 126.1 / 142.9 | 3 | 0/3 (0.0 %) | 0 | 0/3 (0.0 %) ; 0 | 0 |
| dev / concevoir | 3 | 141 / 219 | 3 | 0/3 (0.0 %) | 0 | 0/3 (0.0 %) ; 0 | 0 |
| dev / liste-tests | 5 | 30.7 / 39 | 5 | 0/5 (0.0 %) | 0 | 0/5 (0.0 %) ; 0 | 0 |
| dev / refactor | 14 | 26.2 / 36.2 | 14 | 0/14 (0.0 %) | 0 | 0/5 (0.0 %) ; 0 | 0 |
| dev / @loop | 0 | — / — | 0 | — | 0 | 3/3 (100.0 %) ; 5 | 2295.4 |
| dev / hors étape | 0 | — / — | 0 | — | 0 | 1/1 (100.0 %) ; 3 | 0 |
| incident / detecter | 2 | 132.4 / 224.5 | 2 | 1/2 (50.0 %) | 1 | 0/1 (0.0 %) ; 0 | 0 |
| incident / evaluer | 1 | 42.4 / 42.4 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| incident / contenir | 1 | 57.2 / 57.2 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| incident / diagnostiquer | 1 | 55.8 / 55.8 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| incident / corriger-rouge | 1 | 43.3 / 43.3 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| incident / corriger-vert | 1 | 40.6 / 40.6 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| incident / post-mortem | 1 | 152.7 / 152.7 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| incident / livrer | 1 | 33 / 33 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| recherche / toutes | 0 | — | 0 | — | 0 | — | — |
| audit / toutes | 0 | — | 0 | — | 0 | — | — |
| maintenance / dependances | 2 | 53.3 / 78.4 | 2 | 0/2 (0.0 %) | 0 | 0/2 (0.0 %) ; 0 | 0 |
| maintenance / historique | 2 | 29 / 35 | 2 | 0/2 (0.0 %) | 0 | 0/2 (0.0 %) ; 0 | 0 |
| maintenance / tests-instables | 2 | 37.4 / 46.3 | 2 | 0/2 (0.0 %) | 0 | 0/2 (0.0 %) ; 0 | 0 |
| maintenance / dette | 3 | 16.8 / 22.2 | 3 | 2/3 (66.7 %) | 1 | 1/2 (50.0 %) ; 1 | 0 |
| nouveau / toutes | 0 | — | 0 | — | 0 | — | — |
| donnees / collecter | 1 | 71.9 / 71.9 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| donnees / nettoyer | 1 | 12.9 / 12.9 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| donnees / stocker | 1 | 11.2 / 11.2 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| donnees / presenter | 3 | 42.3 / 47.5 | 3 | 2/3 (66.7 %) | 1 | 1/1 (100.0 %) ; 1 | 1328.9 |
| donnees / livrer | 1 | 96.3 / 96.3 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| redaction / rediger | 8 | 84.5 / 256.6 | 8 | 1/8 (12.5 %) | 1 | 0/7 (0.0 %) ; 0 | 0 |
| redaction / relire | 7 | 56.9 / 100.8 | 7 | 0/7 (0.0 %) | 0 | 0/7 (0.0 %) ; 0 | 0 |
| redaction / mettre-en-forme | 7 | 33.1 / 52 | 7 | 0/7 (0.0 %) | 0 | 0/7 (0.0 %) ; 0 | 0 |
| redaction / livrer | 7 | 23.7 / 49.7 | 7 | 0/7 (0.0 %) | 0 | 0/7 (0.0 %) ; 0 | 0 |
| reunion / inventorier | 2 | 49.3 / 51.9 | 2 | 1/2 (50.0 %) | 1 | 0/1 (0.0 %) ; 0 | 0 |
| reunion / trier | 1 | 24 / 24 | 1 | 0/1 (0.0 %) | 0 | 1/1 (100.0 %) ; 1 | 60609 |
| reunion / definitif | 1 | 23.3 / 23.3 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| reunion / supprimer | 1 | 0.1 / 0.1 | 0 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| reunion / ranger | 1 | 56.9 / 56.9 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| reunion / verifier | 1 | 0 / 0 | 0 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| reunion / livrer | 1 | 25.1 / 25.1 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| routage / lire | 615 | 22.6 / 35.5 | 615 | 1/613 (0.2 %) | 2 | 1/613 (0.2 %) ; 1 | 0 |
| routage / callback | 198 | 36.5 / 67.3 | 197 | 0/195 (0.0 %) | 1 | 2/197 (1.0 %) ; 2 | 0 |
| routage / rapporter | 609 | 25.8 / 42.7 | 609 | 0/609 (0.0 %) | 0 | 0/609 (0.0 %) ; 0 | 0 |
| routage / classifier | 338 | 11.4 / 36.6 | 139 | 1/338 (0.3 %) | 1 | 0/412 (0.0 %) ; 0 | 0 |
| routage / decomposer | 365 | 32.3 / 68.4 | 365 | 45/363 (12.4 %) | 46 | 1/412 (0.2 %) ; 1 | 0 |
| routage / affecter | 313 | 0 / 0.1 | 0 | 0/313 (0.0 %) | 0 | 0/411 (0.0 %) ; 0 | 0 |
| routage / dispatcher | 313 | 0 / 0.4 | 0 | 0/313 (0.0 %) | 0 | 0/411 (0.0 %) ; 0 | 0 |
| routage / relancer | 196 | 0.1 / 0.4 | 0 | 0/196 (0.0 %) | 0 | 0/196 (0.0 %) ; 0 | 0 |
| routage / comprendre | 271 | 8.5 / 14.3 | 271 | 2/271 (0.7 %) | 2 | 0/269 (0.0 %) ; 0 | 0 |
| routage / discuter | 3 | 52.9 / 84.9 | 3 | 0/3 (0.0 %) | 0 | 0/3 (0.0 %) ; 0 | 0 |
| images / toutes | 0 | — | 0 | — | 0 | — | — |
| video / acquerir | 1 | 407.1 / 407.1 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| video / analyser | 1 | 122.3 / 122.3 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| video / monter | 3 | 29.1 / 93.1 | 3 | 0/3 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| video / verifier | 3 | 22.2 / 31.9 | 3 | 0/3 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| video / livrer | 1 | 33.7 / 33.7 | 1 | 0/1 (0.0 %) | 0 | 0/1 (0.0 %) ; 0 | 0 |
| audio / toutes | 0 | — | 0 | — | 0 | — | — |

Notes : le taux de pause par étape utilise les notifications pipeline_limit (35), tandis que le taux par pipeline utilise les résumés paused (36), qui incluent une précondition sans notification de limite. Trois limites Dev ne sont pas rattachées à une étape ; 144 924,3 s de pauses fermées Dev restent sans étape déterminée dans les événements utilisés. Les 461 occurrences skipped ne sont ni des appels ni des essais chronométrés. Les deux répétitions supplémentaires de monter et verifier en Vidéo sont visibles dans n=3 même si attempt reste à 1. Le taux global Routage inclut les nombreux contrôles mécaniques réussis ; pour comparer les difficultés des models, utiliser les lignes par étape, pas ce seul taux global.

Routage/classifier : 338 occurrences, dont 139 anciens tours de model et 199 étapes exécutées par le code ; ces dernières peuvent appeler le classifier une fois par tâche. Ne pas conclure à zéro model parce que source=code. Le journal des décisions en contient 250 pour routage-tache, plus cinq autres décisions ; les essais internes et requêtes réseau ne sont pas observables exhaustivement.

### A.5 Répartition par projet

| Projet | Runs | Répartition |
|---|---:|---|
| Ayor | 3 | maintenance : 1, reunion : 1, redaction : 1 |
| RemotePad | 2 | redaction : 2 |
| TranslateOverlay | 2 | redaction : 2 |
| chef | 613 | routage : 613 |
| devopsPrep | 3 | discussion : 1, redaction : 1, dev : 1 |
| frenchradio | 5 | discussion : 3, redaction : 1, dev : 1 |
| jellyfin | 1 | discussion : 1 |
| orchestrateur-dev | 2 | dev : 1, discussion : 1 |
| panierIL | 3 | dev : 2, incident : 1 |
| pipelineLab | 4 | discussion : 1, dev : 3 |
| veille | 3 | discussion : 2, dev : 1 |
| youtube-live | 9 | video : 1, dev : 5, discussion : 1, donnees : 1, maintenance : 1 |
