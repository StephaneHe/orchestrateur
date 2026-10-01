# Refonte Orchestrateur (affichage musiciens + fonctionnalités + code) — OpenAI GPT-6 Astra — 2026-09-18

## Décision proposée

**Faire du fleet le premier écran de supervision : une liste compacte et stable, une action attendue explicite par musicien, et un détail d’activité commun.** Réutiliser le pupitre et ses composants ; corriger les divergences de données avant d’ajouter des indicateurs. Le chat chef reste accessible dans un panneau redimensionnable. La vue « orchestre » peut rester une présentation secondaire.

Le gain principal ne vient pas d’animations supplémentaires : il vient de pouvoir distinguer **travail en cours, question à traiter, silence suspect, processus perdu, résultat terminé et quota bloquant**, sans ouvrir chaque carte. Le non-lu doit devenir un badge indépendant, pas remplacer l’état du travail.

## Périmètre, méthode et observations

Analyse en lecture seule du code de travail : `server.js`, `public/app.js`, HTML/CSS, `public/pupitre-row.js`, `public/pupitre-detail.js`, `scripts/dispatch.mjs`, `scripts/fleet-status-core.mjs`, `scripts/notify.mjs`, `config.json` et rapports précédents. Références `fichier:ligne` relevées dans cet arbre, déjà fortement modifié avant l’étude. Aucun code, config, test ou log modifié par l’analyse ; aucune installation, aucun dispatch, aucun redémarrage. Seule écriture documentaire : ce rapport. Le callback final explicitement demandé écrit naturellement une notification via le serveur.

Vérifications effectuées : lectures ciblées ; exécution des fonctions pures existantes sur des événements en mémoire ; rendu détaillé testé avec un conteneur factice ; deux GET locaux, `/api/version` et `/api/pupitre`. Pas de test de charge, de mutation d’état, de navigation marquant un musicien comme lu, ni de capture visuelle. Les conclusions de lisibilité reposent sur le DOM/CSS et les règles de disposition ; leur validation visuelle appartient à l’implémentation.

Relevé vers **2026-09-18 23:51 UTC**, soit **2026-09-19 02:51 à Jérusalem** ; date de titre conservée conformément à la demande :

- Configuration : **29 projets, dont 13 mis de côté**, chef inclus ; défaut `claude-opus-4-8` / `claude` (`config.json:2`, `config.json:4`, `config.json:6`).
- `/api/pupitre` répond 200 : 24 `unread`, 1 `live`, 4 `idle`, aucun `stalled` dans cet instantané. Ce sont les catégories renvoyées, pas une preuve indépendante de 24 résultats réellement non lus.
- **Version chargée à distinguer du disque :** `/api/version` annonce **0.15.1**, `package.json:3` déclare **0.16.1**. Les corrections web et dispatch décrites ci-dessous existent sur disque. Cela ne permet pas d’affirmer que tout le code serveur examiné tourne déjà dans le processus 7777, ni de conclure que le navigateur a rechargé le client.
- Tailles observées : `chef.jsonl` 337 117 136 octets ; `vuBox.jsonl` 238 928 249 ; `orchestrateur.jsonl` 173 902 828 ; `panierIL.jsonl` 143 798 212. Ces fichiers continuent d’évoluer.
- `logs/no-failover` présent ; `logs/claude-limited.until` absent à ce relevé. **Aucun quota bloquant actuel établi** ; aucune API fournisseur interrogée.

### Socle acquis : fix chef-figé v0.16.1

Cette étude s’appuie sur [l’analyse Astra](chef-stuck-analysis-astra.md) et [la contre-expertise validée](chef-stuck-analysis-validated.md), sans refaire leur diagnostic. Le callback manuel `/api/notify` écrit un `user_prompt` sans lancer de tour ; l’ancien armement inconditionnel de `_awaitingConductorResponse` expliquait « LE CHEF RÉPOND » figé.

Le **P0 déjà fait** est visible : armement seulement sur prompt sans source (`public/app.js:1948`) ou `system/init` (`public/app.js:1984`), désarmement au résultat (`public/app.js:1989`), filet PID après 20 s (`public/app.js:2517`) et vérification à la reconnexion (`public/app.js:808`). Le garde no-failover produit désormais un résultat synthétique terminal, au démarrage et après limite détectée (`scripts/dispatch.mjs:1404`, `scripts/dispatch.mjs:1321`). **Ne pas réimplémenter ce P0.** Il ferme le symptôme chef ; il ne constitue pas encore un état métier partagé pour toutes les cartes.

La contre-expertise demande justement de rester proportionné : un processus Node, JS natif, JSONL et sidecars suffisent. Aucun nouveau service, framework, ordonnanceur distribué ou base de données n’est nécessaire.

## Findings priorisés

Priorités de cette refonte : **P1** = fiabilité ou visibilité immédiate ; **P2** = pilotage et confort ; **P3** = extension à différer. Les défauts certains du code sont séparés des risques dont la fréquence n’a pas été mesurée.

### Affichage client

| ID / priorité | Constat et effet utilisateur | Preuve | Correction proposée |
|---|---|---|---|
| A1 — P1 | Le fleet passe après le chat : 60 % de la largeur au chef, cartes desktop de 220 px, classement par fréquence d’événements. Un agent bavard prend le dessus sur une erreur silencieuse. Les détails d’activité sont ellipsés à 10–11 px et l’état à 9 px. | `public/app.js:467`, `public/app.js:483`, `public/app.js:495`, `public/styles.css:370`, `public/styles.css:390`. | Liste fleet principale, tri par attention puis ordre stable, chat redimensionnable. Nom, état, activité et action sans ouverture préalable. |
| A2 — P1 | Vocabulaire ambigu et hétérogène : `live` = « EN COMMUNICATION », `input` = « EN ATTENTE », `unread` remplace la fin de travail ; pupitre en anglais. Le briefing compte seulement `input/unread` comme « à vérifier », en omettant les erreurs. | `public/app.js:41`, `public/pupitre-row.js:29`, `public/app.js:2783`. | Libellés français orientés action, résultat et non-lu séparés ; compteur attention incluant erreurs, questions et santé suspecte. |
| A3 — P1 | **Le détail live jette tous les `assistant`**, supposés déjà rendus par les deltas. Or l’adaptateur Codex émet des `assistant` sans ces deltas. Réflexions/outils/textes Codex sont donc absents du détail live ; le résultat final ou une réouverture peut redonner du contenu. Même risque pour Claude après un trou SSE. | `public/pupitre-detail.js:186`, surtout `:206` ; `scripts/dispatch.mjs:857`, `:877`. Reproduction en mémoire : un `assistant` Codex texte → **0 ajout DOM**. | Ne dédupliquer que les blocs effectivement affichés ; conserver tout assistant consolidé sans bloc correspondant. Partager cette règle entre historique et live. |
| A4 — P1 | La carte annonce le silence après 30 s depuis **tout événement reçu** ; le pupitre utilise 60 s depuis un événement **non partiel**. L’un peut animer pendant qu’un autre dit stalled. De plus, `stalled` est testé avant `deadInFlight` : « STALLED » masque « PID MORT ». | `public/app.js:122`, `:311` ; `scripts/fleet-status-core.mjs:25`, `:44`, `:189` ; `public/pupitre-row.js:30`. Priorité erronée reproduite en mémoire. | Une règle de santé partagée, avec libellé prudent ; processus confirmé mort prioritaire sur silence. Séparer réception, progression observée et statut du producteur. |
| A5 — P1 | Les données peuvent vieillir sans avertissement. `onerror` SSE est silencieux ; les échecs de poll conservent le snapshot ; le pupitre affiche l’heure de **rendu**, renouvelée chaque seconde, comme mise à jour même si le dernier GET a échoué. | `public/app.js:850`, `:2499` ; `server.js:985`, `:989`, `:1068`. | Bandeau « synchronisé il y a… / reconnexion / données anciennes » fondé sur le dernier succès ; âge du snapshot visible, interpolation indiquée comme telle. |
| A6 — P2 | La télémétrie existe mais surtout dans le pupitre/détail. Sur mobile, la CSS masque activité, PID et modèle/fournisseur. La carte ne montre que le provider configuré non-Claude ; elle ne suit pas le modèle réellement observé. | `public/app.js:292`, `:2454`, `:2562` ; `public/pupitre-row.css:45` ; `public/pupitre-row.js:71`. | Même résumé en carte/liste/mobile ; deuxième ligne mobile pour activité et provider. Modèle observé vs configuration de secours explicitement distingués. |
| A7 — P2 | Les tokens/coûts sont accumulés en mémoire depuis l’ouverture. Le détail cherche `.pf-usage`, absent du HTML actuel. Les deux appels optionnels à `recomputeFromRing` n’ont pas d’implémentation trouvée. Des valeurs existent donc sans affichage fiable ni total historique. | `public/app.js:100`, `:194`, `:2444`, `:2601`, `:2610` ; `public/index.html:123`. | Dernier tour mesuré visible, période de cumul nommée, champs absents affichés « — ». Réhydratation explicite, sans compter deux fois les résultats. |

### Données et états

| ID / priorité | Constat et conséquence | Preuve | Correction proposée |
|---|---|---|---|
| D1 — P1 | Quatre réductions restent distinctes : hydratation serveur, watcher, client, core pupitre. Un callback sourcé remet encore le core/cartes en `live`. Seul le core fait sortir `input` au prompt/init. Le pupitre ignore les marqueurs de lecture. Le fix de la pastille chef ne corrige pas ces divergences. | `server.js:1458`, `:2052` ; `public/app.js:138` ; `scripts/fleet-status-core.mjs:69`, `:86`, `:105` ; marqueur dans `server.js:1447`. | Petit reducer pur partagé ; lecture, santé et rendu autour de lui. Un callback seul ne démarre pas un tour ; `system/init` couvre les vrais dispatchs `--source`. |
| D2 — P1 | Le dernier texte assistant n’est pas remis à zéro au démarrage. Une ancienne `NEEDS_USER_INPUT` peut contaminer un tour suivant sans nouveau texte. Les erreurs synthétiques, dont `error_limited`, sont toutes aplaties en `idle`. | `scripts/fleet-status-core.mjs:71`, `:86`, `:103` ; `public/app.js:143`, `:210` ; `server.js:2054`, `:2072`. Reproductions : question → résultat → nouveau prompt/init → résultat = `input` ; résultat synthétique limité = `idle`. | Réinitialiser les champs du tour ; garder motif terminal et attente indépendants de la disponibilité. « Interrompu » ou « Limité » doit rester visible même si le producteur est au repos. |
| D3 — P1 | La mesure de silence n’est pas univoque : les deltas sont exclus, les notifications incluses ; si le dernier événement n’a pas de timestamp, fallback sur mtime. Un début de tour hors des 256 Kio devient inconnu ; un init sans date peut être daté à chaque scan avec `Date.now()`. La durée n’est donc pas toujours exacte. | `scripts/fleet-status-core.mjs:26`, `:44`, `:89`, `:189`, `:198`. | Horodater l’observation, conserver le début courant depuis le prompt/init connu ; distinguer temps exact, estimé, inconnu. Un delta de contenu prouve une progression ; un callback ne la prouve pas. |
| D4 — P1 | Reconnexion : historique chef + filet PID chef, sans réparation générale des états et feeds musiciens. SSE saute à EOF sur >4 Mio de croissance et n’émet pas de curseur rejouable ; les notices de saut sont ignorées par le détail. Un résultat manqué peut laisser une carte fausse. | `public/app.js:802` ; `server.js:2113`, `:2136`, `:2188` ; `public/pupitre-detail.js:176`. | Snapshot de tout le fleet à la reconnexion et après notice de perte, puis historique du panneau ouvert. Drainage borné conservant les petits événements suivants. Pas besoin initialement d’un journal de replay SSE. |
| D5 — P1 | Protection mémoire incomplète : watcher notifications alloue toute la croissance ; ancien SSE unitaire lit depuis zéro ; `res.write()` ignore le retour false. La limite de taille de ligne intervient après accumulation de `partial`, qui peut elle-même grossir sur plusieurs lectures. | `server.js:3710`, `:3524`, `:3537`, `:2159`, `:2177`, `:2197`. Recherche d’appelants `/sse/logs/` : seulement la définition dans les sources client/Android/scripts/src examinées. | Supprimer la route inutilisée après contrôle des consommateurs ; lire par blocs avec budget par tick, borner la ligne en construction, isoler un client lent. Réduire les doublons de lecture ensuite. Risque de ressources établi par le code, pas crash provoqué ici. |

### Fonctionnalités et pilotage

| ID / priorité | Constat et conséquence | Preuve | Correction proposée |
|---|---|---|---|
| F1 — P1 | Deux modes d’envoi surprenants : `@musicien` occupé → queue ; message direct à ce même projet → interruption du processus. Le chemin `@` précède même le traitement de l’override. La réponse utilisateur ne donne pas un choix explicite avant l’envoi. | `server.js:3057`, `:3085`, `:3113`, `:3153` ; `public/app.js:2230`. | Afficher cible et mode « Ajouter à la file / Interrompre et envoyer ». Même contrat de routage pour tous les points d’entrée. |
| F2 — P1 | La file est persistée, mais non administrable par le dashboard. `drainQueue` retire/persiste avant de lancer ; un échec de spawn ne remet pas l’élément. Le drainage accepte `idle/error` : avec `error_limited` synthétique et no-failover, il peut consommer successivement les demandes en attente sans travail exécuté. | `server.js:301`, `:393`, `:375`, `:3731` ; `scripts/dispatch.mjs:1404`. Risque déduit des chemins, pas exécuté sur la file réelle. | Exposer contenu/profondeur/âge/pause/erreur ; conserver l’élément en démarrage jusqu’à confirmation ; pause du drainage sur quota ou erreur, reprise explicite. |
| F3 — P1 | Un callback est enregistré et affiché, pas nécessairement pris en charge par le chef. Son état de traitement, sa date par musicien et son lien au travail manquent. Le relais de questions chef existe déjà, mais lance directement ; l’association de réponse cherche le dernier marqueur dans 512 Kio. Des questions simultanées peuvent créer concurrence ou ambiguïté. | `server.js:2716`, `:2745`, `:1778`, `:1793`, `:1804`, `:1829`. | Boîte callbacks et demandes de décision ; « reçu / à traiter / traité » explicites. Sérialiser les décisions du chef et conserver un lien vers la demande ; ne pas réveiller automatiquement le chef pour chaque fin normale. |
| F4 — P2 | Quota/no-failover/failover sont gérés par le dispatcher mais peu exposés au dashboard. Une bascule NVIDIA produit du texte sans capacité d’exécuter les outils du musicien : un résultat conversationnel peut être pris pour un travail agentique accompli. | `scripts/dispatch.mjs:198`, `:309`, `:450`, `:477`, `:494`, `:1337` ; carte `public/app.js:292`. | Badge disponibilité fournisseur et politique no-failover ; provenance réelle ; indication « réponse seule, outils indisponibles » si applicable. Ne pas assimiler fin de réponse et réalisation de la tâche. |
| F5 — P2 | Historique et notifications existent, mais pas de recherche fleet/historique métier, filtres d’attention complets, retry/stop explicites ou dépendances déclarées dans les routes et vues examinées. L’API d’événements ne renvoie que la queue de 2 Mio, max 500 événements. | `server.js:1891`, `:1899`, `:1976`, `:2561`, `:2689` ; actions `public/app.js:276` ; `public/index.html:155`, `:203`. | Enrichir l’existant : recherche bornée annoncée, historique des tours, filtres persistants, actions contextuelles, dépendances simples en dernier. |

## Proposition concrète : les panneaux musiciens

### 1. Structure de l’écran

Vue par défaut **« Fleet »**, avec trois niveaux, conservant palette sombre et polices existantes :

1. **Bandeau de supervision** : actifs ; attendent une réponse ; à vérifier ; terminés non lus ; messages en file. À droite : état de connexion, âge du snapshot, disponibilité Claude et état no-failover. Les compteurs sont cliquables et filtrent la liste. Une erreur ne doit jamais être cachée dans un nombre « nouveaux messages ».
2. **Liste de musiciens** : une ligne de deux ou trois rangées, 80–104 px de haut à valider visuellement. Nom complet, état principal, dernière activité, durée du tour, silence, modèle/provider et action. Tri « attention » par défaut, noms stables à priorité égale ; options nom, activité récente, durée, provider et favoris. Pas de déplacement à chaque delta. Figer l’ordre pendant focus clavier, survol d’une action ou lecture d’un panneau.
3. **Détail latéral** au clic/Entrée : mission courante, timeline, résultat/question, outils, usage et file. Le chat chef est un onglet ou panneau voisin redimensionnable, pas une obligation de 60 % de largeur. Garder une petite ligne chef fixe et distincte du compte des musiciens.

Maquette textuelle illustrative, **valeurs fictives**, réalisable avec les composants existants :

```text
FLEET   Actifs 4 | Réponse requise 2 | À vérifier 1 | Terminés non lus 3 | File 5
Synchronisé il y a 1 s                  Claude : disponible · no-failover actif
Rechercher un projet…      [Attention] [Tous] [Provider] [Mis de côté 13]

DeskZen      RÉPONSE REQUISE                         non lu 1        [Répondre]
             « Quelle option de synchronisation ? »                  [Détail]
             Claude · modèle observé … | tour terminé en 3m12 | callback 09:41

BookHaven    EN COURS · OUTIL                       À vérifier       [Détail]
             Bash · tests… | tour 8m14 | sans progrès observé 1m20   [Arrêter…]
             Claude · modèle observé … | producteur vivant | file 2

RemotePad    TERMINÉ                                non lu 1        [Résultat]
             Tests exécutés, rapport disponible | durée 2m06        [Continuer]
             dernier tour : entrée … / cache … / sortie … | callback reçu 09:42

CHEF         AU REPOS · 3 callbacks à traiter                    [Ouvrir le chat]
```

Le nombre « à vérifier » n’est pas synonyme de processus bloqués. Si le transport est perdu, le bandeau devient « Connexion perdue — dernier état connu… » ; on n’attribue pas simultanément une panne à tous les musiciens.

### 2. État, activité, santé et lecture : quatre informations distinctes

Ce sont des champs de présentation dérivés du reducer, pas quatre machines à états autonomes.

| Dimension | Valeurs proposées | Règle et action |
|---|---|---|
| Travail | Prêt, Démarrage, En cours, Réponse requise, Attend le chef, Terminé, Échec, Interrompu, Limité | Le résultat terminal conserve son issue. « Prêt » signifie pas de travail courant ; « Terminé » conserve le dernier résultat. Réponse humaine et décision chef sont distinguées. |
| Activité courante | Réflexion, Texte en cours, Outil : nom, Attente de résultat outil | Déduite des événements observés. Ne pas afficher « outil en cours » si le provider ne signale que son achèvement ; préciser « dernier outil terminé ». |
| Santé | Normal, Sans progrès observé, Processus perdu, État inconnu | PID mort confirmé prioritaire ; PID absent = information manquante, pas preuve automatique de crash. Silence seul → vérification, jamais kill automatique. |
| Lecture/coordination | Non lu N, File N, Callback reçu à…, Question à traiter | Indépendant du travail. Ouvrir un résultat ne transforme pas une erreur en succès et n’acquitte pas implicitement une décision. |

Garder les valeurs DOM actuelles pendant la migration, avec des badges additionnels ; étendre les états seulement lorsque tous les consommateurs concernés sont adaptés. Les invariants historiques de `CLAUDE.md:188` et les états réels diffèrent déjà ; documenter le mapping canonique.

**Progrès :** ne pas inventer un pourcentage à partir des tokens ou du temps. Afficher phase, dernière action, nombre d’outils terminés si connu, durée et silence. Une checklist « 2/4 étapes » n’est disponible que si la tâche déclare réellement ces étapes. Pour un tour long sans début dans la fenêtre historique : « durée inconnue », pas un compteur remis à zéro au dernier poll.

**Seuil initial de santé :** conserver 60 s comme seuil commun de vérification tant qu’aucune mesure ne justifie mieux ; indiquer le seuil dans l’infobulle. Un outil long avec PID vivant peut être sain et silencieux. Les deltas de texte/thinking sont du progrès observé ; notifications et callbacks n’effacent pas son silence. Un heartbeat transport prouve seulement la connexion. Distinguer `lastProgressAt`, fraîcheur du snapshot et dernier callback.

### 3. Timeline d’activité commune

Réutiliser `PupitreDetail`, déjà partagé entre dashboard et pupitre, avec ces changements :

- En-tête de tour : prompt court, début, modèle/provider observés, durée, état terminal. Replier les tours antérieurs.
- Réflexion : bloc compact « réflexion reçue » avec aperçu replié ; afficher uniquement le contenu effectivement transmis, sans supposer une visibilité intégrale du raisonnement.
- Outil : nom, cible/commande courte, début et résultat liés par `tool_use_id`, durée lorsqu’elle est mesurable. Résultat détaillé replié ; erreur/refus visible et conservé dans le résumé jusqu’au traitement.
- Texte : un seul bloc par message ; les deltas remplissent ce bloc, le message consolidé le confirme ou le complète. Sans deltas, le consolidé s’affiche normalement.
- Résultat : encart distinct « terminé / échec / interrompu / limité », résumé lisible et usage disponible. Terminer visuellement les blocs de streaming encore ouverts au résultat terminal.
- Événements de coordination : callback ou `@` routé affiché comme tel, jamais comme démarrage de génération. Notices de perte SSE et bascule provider visibles.
- Pin automatique seulement si l’utilisateur est au bas du flux ; sinon bouton « N nouveaux événements ». Conserver les bornes DOM et le regroupement par animation frame déjà présents (`public/pupitre-detail.js:58`, `:69`).

Horodatage : `tsOf` reporte actuellement la dernière date connue (`public/pupitre-detail.js:35`). C’est acceptable comme estimation, pas comme heure exacte de chaque outil. Marquer les dates estimées ; pour les nouveaux événements, conserver une date d’observation quand la source n’en fournit pas.

### 4. Chef, file @ et callbacks

**Chef :** badge de rôle permanent ; état du tour séparé des callbacks à traiter. Le PTY central (`server.js:3587`, sortie dans `central.log` à `:3614`) et le projet chef dispatché via `claude -p` ne sont pas la même activité. Une session attachée ou un PID vivant ne signifie pas « répond ». Présenter le canal actif explicitement lorsqu’il est connu.

**File :** avant envoi, puce cible « Direct : DeskZen » et mode choisi. Après envoi : « enregistré en file, position 2 » ; après lancement confirmé : « démarré ». Panneau file avec texte court, âge, position, pause et actions retirer/monter/descendre. Si un élément échoue au démarrage ou rencontre le quota, il reste identifiable et récupérable.

**Callbacks :** sous la ligne musicien, dernier callback et lien ; côté chef, boîte regroupée par projet, avec reçu/non lu/traité. « Reçu » signifie enregistré par l’application. « Traité par le chef » exige une action ou réponse explicitement liée ; ne pas l’inférer de la disparition d’un toast. Conserver la distinction callback manuel / fin automatique et dédupliquer leur présentation sans fusionner des tours différents qui auraient le même texte.

### 5. Mobile et accessibilité

Liste verticale avec nom/état/action en première ligne, activité/silence en deuxième, modèle et file en détail extensible. Ne pas cacher toute l’activité comme `public/pupitre-row.css:47`. Garder les onglets projet comme navigation secondaire, sans éventail comme seule vue d’ensemble.

Texte, icône et couleur pour chaque état ; cible tactile suffisante, actions nommées, navigation clavier et focus visibles. Les cartes actuelles sont des `article` cliquables sans comportement clavier équivalent (`public/app.js:262`, `:295`), contrairement à la carte chef (`public/index.html:92`). Limiter les animations aux activités réelles, respecter `prefers-reduced-motion`, ne pas annoncer chaque token dans une région `aria-live`. Vérifier contraste et densité sur 1366×768 et écran mobile lors de l’implémentation.

## Améliorations fonctionnelles

| Ajout | Première version utile | Ce qui existe à préserver / limite |
|---|---|---|
| Centre d’attention | Une liste filtrable des questions, échecs, processus perdus et silences suspects ; accès direct à la bonne action. | Étendre briefing et tri pupitre, ne pas ajouter une troisième définition d’attention. |
| Dispatch explicite et file administrable | Cible et mode visibles ; voir, annuler, réordonner, mettre en pause ; âge et motif de blocage. | La persistance de queue existe. Priorité locale simple ; pas de scheduler global initialement. |
| Stop / retry / continuer | Stop clôt le tour comme interrompu ; retry montre le prompt précédent ; continuer reprend la session et le contexte disponibles. | L’interruption avec capture existe. Une relance peut répéter des effets déjà produits : afficher sa portée et laisser le choix, sans retry automatique aveugle. |
| Quota 5 h / 7 j / no-failover | Usage/reset quand fournis, source et date du relevé, avertissement avant épuisement, file en pause sur limite confirmée. Reset inconnu ou estimé indiqué. | Ne pas convertir `out_of_credits` du dépassement en blocage du quota principal si `status=allowed`. Le flag local peut être une estimation issue de texte. Pas de bascule de modèle si no-failover est actif. |
| Boîte de décisions chef | Questions humaines vs chef, destinataire, origine et réponse liée ; sérialisation des décisions. | `NEEDS_CHEF_INPUT` et relais existent. Les rendre traçables avant toute automatisation supplémentaire. |
| Historique de tours | Derniers tours : prompt, issue, durée, fournisseur, résumé, callback, reprise. Recherche par projet/texte/type sur périmètre annoncé. | API actuelle bornée. Afficher « derniers 2 Mio / historique partiel » avant une recherche d’archives ; ne pas promettre une recherche intégrale avec cette API. |
| Notifications utiles | Fin, erreur, question, silence prolongé ; déduplication, regroupement, sourdine par projet, lien d’action. | Toast Windows + callbacks existent. Notifier une transition, pas chaque tick/poll. L’alerte de silence se referme au progrès suivant. |
| Tokens et coûts | Dernier tour, journée, projet ; entrée/cache/sortie séparés ; total des usages mesurés et provenance. | Coût déclaré ≠ facture réelle d’un abonnement. Zéro et non fourni sont différents. Ne pas afficher un pourcentage de contexte à partir d’un cumul de plusieurs appels. |
| Stockage | Taille par log, croissance récente, avertissement de volume ; archivage manuel hors activité en extension. | Répond à la demande de rotation ; ce n’est pas le préalable aux correctifs mémoire. Aucune purge automatique dans la première version. |
| Dépendances/pipelines | Métadonnées simples « dépend de X », bloqué par Y, prochaine étape ; petit graphe ou liste à la demande. | Commencer par visualiser des dépendances déclarées ; aucun graphe déduit des traits décoratifs chef–musiciens. Exécution automatique seulement après fiabilisation de queue/reprise. |

## Améliorations de code concrètes et proportionnées

### C1 — Un noyau de réduction, plusieurs vues

Extraire la partie pure de `scripts/fleet-status-core.mjs:69` dans un module JS utilisable par Node et le navigateur ; garder lecture fichiers/PID dans le core serveur. Remplacer progressivement les réductions `server.js:1435`, `server.js:2052`, `public/app.js:138`. Garder un petit état : activité, texte du tour, attente, début connu, dernier résultat et sa cause. La santé et le marqueur de lecture sont des projections séparées.

Réutiliser `/api/pupitre` comme contrat de snapshot commun plutôt que créer une API concurrente. Ajouter les champs indispensables de façon additive : fraîcheur, issue, attente, dernier progrès, dernier callback, profondeur de file, dernier usage et provenance du modèle. Réconcilier les cartes avec ce snapshot. Le reducer ne doit ni envoyer de notification ni écrire de fichiers.

Corriger également les lectures de queue qui suppriment systématiquement la première ligne, même quand la lecture commence à zéro (`scripts/fleet-status-core.mjs:40`, `server.js:1446`, `server.js:1931`). Ne retirer cette ligne que si l’offset initial est non nul. Garder « inconnu » lorsque la fenêtre ne contient plus le début du tour ; ne pas inventer un historique complet.

### C2 — Une clôture fiable, compatible avec result

Préserver les `result` synthétiques de v0.16.1. Étendre la convention aux sorties anormales sans résultat, après drainage effectif de stdout ; pas de nouvelle taxonomie d’événements terminale. Actuellement le premier `exit/close` déclenche la fermeture et le drain ne traite que 256 lignes (`scripts/dispatch.mjs:1201`, `:1270`, `:1361`). Attendre `close` pour finaliser les flux ; vider la queue d’analyse avant la décision quota/failover. Ne pas produire un deuxième résultat terminal si un résultat réel suffit déjà ; distinguer les tentatives si le failover continue.

Réinitialiser la question et le texte au vrai début du tour. Une erreur synthétique libère l’exécution tout en conservant son motif pour l’UI et la queue. Un PID absent à un instant isolé reste une information incomplète. Éviter les timers qui déclarent automatiquement terminé un travail simplement silencieux.

### C3 — Transport et lecture bornés

Conserver **un SSE agrégé** et les watchers partagés ; la mutualisation par client existe déjà (`server.js:2094`). Faire converger ensuite le watcher SSE et le watcher notifications vers un seul lecteur par projet, avec un dispatch interne vers réduction, notification et transport. Ce refactoring ne doit pas être un préalable aux bornes mémoire.

À court terme : drainage par blocs et budget par tick dans les deux lecteurs ; décodage UTF-8 conservant les caractères coupés entre blocs ; plafond sur la ligne partielle avec mode « ignorer jusqu’au prochain newline » pour une ligne géante, sans perdre le résultat qui suit. Conserver les fichiers bruts sur disque. Le retour false de `res.write` doit entraîner une stratégie bornée par client lent — attente drain limitée ou déconnexion contrôlée suivie de resynchronisation — jamais un tampon illimité ni l’arrêt de tous les abonnés. Appliquer aussi la pression retour au flux fichier du dispatch (`scripts/dispatch.mjs:1241`).

À la reconnexion et sur `log_growth_skipped` / `oversized_line_skipped`, rafraîchir snapshot + détail ouvert. Les protections mémoire restent nécessaires même après cette réparation. Pas de stockage durable des curseurs SSE en V1.

### C4 — Queue et disponibilité avant la prise en charge suivante

Centraliser les décisions d’envoi pour `/api/dispatch`, `spawnDirectDispatch`, drainage et demandes chef (`server.js:348`, `:393`, `:1778`, `:3007`). Une garde locale par projet doit empêcher deux lancements concurrents avant que le PID/log ait été publié. Respecter le mode explicitement demandé ; ne pas décider uniquement à partir d’un état `live` potentiellement ancien.

Ajouter un identifiant de **demande en file** et ses dates, pas un protocole distribué de tours. Persister « en démarrage » avant spawn, conserver l’échec et permettre reprise sans effacer le prompt. Sur redémarrage, ne pas rejouer aveuglément une demande dont le démarrage est incertain. Le reset quota rend une demande éligible ; il ne prouve pas que la demande reste souhaitée. Les requêtes de décision chef utilisent cette même file et une association demande/réponse explicite, au lieu du dernier marqueur textuel retrouvé dans le log.

### C5 — Quota structuré et provenance fournisseur

Normaliser en données de disponibilité les événements `rate_limit_event`, les messages `limited-no-failover` et le flag local. Distinguer quota principal, dépassement, reset confirmé/estimé et dernière observation. Garder la détection textuelle du dispatcher comme fallback (`scripts/dispatch.mjs:248`, `:330`, `:1216`), sans traiter le texte d’un outil comme preuve de limite.

Le fournisseur réellement observé et les capacités effectives remplacent le badge statique de carte. Le fallback configuration doit être libellé « configuré ». Un ancien modèle trouvé dans la queue historique n’est pas nécessairement celui du nouveau tour. Les changements de fournisseur apparaissent dans la timeline.

### C6 — Usage, historique et performance

Restaurer un vrai rendu usage dans le détail ; lire les résultats sans rejouer les effets de transition ou les notifications. Nommer la période de cumul et dédupliquer avec un identifiant existant quand fiable, sinon une position de journal pour le calcul local. Ne pas transformer toutes les valeurs absentes en zéro (`public/app.js:195`). Ne pas choisir arbitrairement le premier `modelUsage` pour résumer plusieurs modèles (`public/app.js:201`).

`/api/pupitre` rescane synchroniquement chaque projet à chaque requête (`server.js:1528`, `scripts/fleet-status-core.mjs:30`) : au plafond actuel, 29 × 256 Kio ≈ 7,25 Mio de lecture par poll, multiplié par les clients. Ce plafond n’est pas une mesure de charge réelle. Cache court du snapshot et recalcul des fichiers modifiés, une requête client à la fois, arrêt des polls cachés ; conserver rAF et réconciliation DOM déjà présents. Le pupitre reconstruit encore toutes les lignes chaque seconde (`server.js:969`) : mettre à jour seulement champs/compteurs modifiés.

Nettoyer après migration les chemins rendus obsolètes, les appels optionnels sans implémentation et commentaires devenus faux. Sortir progressivement le HTML/JS du pupitre de `server.js:854` vers les fichiers publics existants ou un module dédié ; éviter une réécriture globale du serveur.

### C7 — Croissance des logs, puis archivage simple

L’accumulation est réelle, mais l’hydratation normale est déjà bornée : 256 Kio pour l’état, 2 Mio pour les événements, 32 Kio pour le warm-up (`server.js:1440`, `:1899`, `:3752`). La priorité est la lecture non bornée, pas la rotation.

La demande présente autorise **à étudier** la rotation malgré son report historique dans `CLAUDE.md:224`. Option P3 : archive datée/compressée lors d’une maintenance garantissant l’absence de writers et de tour actif ; réinitialiser les lecteurs et conserver sessions, marqueurs et index d’archives cohérents. Aucun renommage/troncature à chaud ; aucun présupposé que « boot » signifie absence de writer externe. Commencer par taille/croissance/export et une procédure hors activité. Ne pas supprimer des archives automatiquement en V1.

## Plan pour Opus 4.8 : impact × effort

Échelle impact 1–5 ; effort indicatif en jours de développement et vérification, hors validation produit. Scores destinés à comparer les lots, pas à promettre un délai. Le P0 chef v0.16.1 est acquis.

| Ordre / lot | Périmètre livrable | Impact | Effort | Dépendance / critère de sortie |
|---|---|---:|---:|---|
| 1 — P1, rendu exact | A3 : assistant consolidé sans deltas ; PID mort prioritaire ; compte attention incluant erreurs ; fraîcheur visible. | 5 | 0,5–1 j | Client d’abord. Texte/outils Codex visibles live ; aucun double rendu Claude ; perte réseau visible. |
| 2 — P1, état commun | C1 + D2 : reducer pur partagé, reset question, callback non ouvrant, résultat/cause/non-lu séparés ; snapshot partagé et réconciliation générale. | 5 | 2–3 j | Base des compteurs fiables. Même séquence → même état au reload, SSE, pupitre et CLI. |
| 3 — P1, mémoire et fin de flux | C2/C3 : bornes lecteurs/partial, retrait ancienne route après contrôle, client lent isolé, clôture après drainage. | 5 | 1,5–2,5 j | Indépendant de la maquette ; aucun résultat terminal perdu dans les scénarios de burst/coupure. |
| 4 — P1, premier écran fleet | A1/A2/A6 : liste principale, filtres attention/nom/provider, ordre stable, résumé chef distinct, responsive. | 5 | 1,5–2,5 j | Lot 2 pour les données ; à 29 projets, repérer une question/erreur sans ouvrir les cartes. |
| 5 — P1, file sûre | C4 + badge limite minimale : cible/mode explicites, garde par projet, file inspectable/pause/reprise, conservation des échecs. | 5 | 2–3 j | Lots 2–3. Quota n’efface aucune demande ; deux envois simultanés ne lancent pas deux producteurs. |
| 6 — P2, détail et callbacks | Timeline liée, derniers résultats/questions, dernier callback par musicien et boîte chef ; provenance modèle. | 4 | 1–2 j | Lots 1–2. Callback reçu ne déclenche pas « répond » ; résultat et outil se retrouvent en un clic. |
| 7 — P2, actions et décisions | Stop/retry/continuer ; sérialiser questions chef et lier la réponse au bon musicien. | 4 | 1,5–2,5 j | Lot 5. Échec de reprise visible ; deux questions concurrentes restent correctement attribuées. |
| 8 — P2, quota complet et usage | Disponibilité 5 h/7 j si fournie, reset/provenance, no-failover, tokens/coûts du dernier tour et période. | 4 | 1–2 j | Lots 2 et 5. `allowed + out_of_credits` ne bloque pas à tort ; reload ne gonfle pas les totaux. |
| 9 — P2, historique/recherche/notifications | Historique récent borné, recherche et filtres, alertes dédupliquées, indicateurs stockage ; cache/poll commun. | 3 | 1,5–3 j | Lots 2 et 6. Périmètre de recherche annoncé ; pas de scan complet répété des gros logs. |
| 10 — P3, extensions | Dépendances déclarées, historique d’archives et archivage hors activité. | 2–3 | 2–4 j | Après usage des lots précédents. Aucune donnée écrasée ; aucun pipeline automatique initialement. |

**Découpage recommandé :** livrer d’abord 1–4 pour rendre les musiciens compréhensibles ; intégrer le garde quota du lot 5 dès qu’on touche au drainage. Ensuite 5–8 pour rendre le pilotage actionnable. Les lots 9–10 ne doivent pas retarder la fiabilisation de l’affichage. Les modifications serveur seront à regrouper pour une future fenêtre de redémarrage décidée lors de l’implémentation ; **aucun redémarrage réalisé pour cette étude**.

### Validation ciblée à réaliser pendant l’implémentation

1. Matrice commune de replay : succès ; question humaine puis réponse ; question chef ; callback manuel ; raccourci `@` ; vrai dispatch `--source` puis init ; interruption ; limite synthétique ; erreur ; marqueur de lecture. Vérifier état, motif, queue et effets de notification séparément.
2. Affichage live : Claude avec deltas ; Codex sans deltas ; connexion en milieu de message ; résultat sans dernier assistant ; outil/refus ; résultat qui ferme le streaming. Historique et live donnent le même contenu sans doublon.
3. Santé : delta de contenu régulier ; outil long silencieux avec PID vivant ; PID confirmé mort ; sidecar absent ; snapshot ancien. Aucun de ces cas ne doit être abusivement assimilé à tous les autres.
4. SSE/IO sur fixtures isolées : burst >4 Mio avec résultat final, ligne >1 Mio coupée sur plusieurs blocs, Unicode aux frontières, client lent, reconnexion pendant résultat. Mesurer mémoire et vérifier conservation du résultat suivant la ligne ignorée.
5. Queue sur faux producteurs : deux requêtes simultanées, spawn échoué, limite no-failover, redémarrage avec demande en démarrage, attente utilisateur, réponses chef croisées. Aucun prompt disparu ou replay silencieux.
6. Lecture/usage : reload, événements sans timestamp, début hors fenêtre, petits fichiers dont la première ligne est utile, session multi-modèles ; compteurs étiquetés et stables.
7. QA visuelle et clavier : 29 projets, longues commandes/noms, mobile, zoom, mouvement réduit ; tri stable pendant action ; état de déconnexion immédiatement compréhensible. Ne pas créer de tests qui ne font que recopier le HTML.

## Vérifications de l’étude et livraison

Les scénarios de reducer et de priorité de badge mentionnés dans les findings ont été exécutés **en mémoire**, en important le core ou en évaluant les renderers existants dans un contexte isolé, sans fichier de test créé. Le test du détail live a confirmé zéro ajout au conteneur pour un assistant Codex. Les autres risques de concurrence, fin de stdout, quota/queue et burst sont des conclusions statiques à vérifier sur fixtures lors de l’implémentation, pas des incidents reproduits en production.

**Rapport non committé**, sans bump de version. Aucun autre fichier édité. Le callback final demandé résume cette proposition et pointe vers ce document ; il ne demande aucun lancement ni redémarrage.
