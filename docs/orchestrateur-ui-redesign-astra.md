# Design fonctionnel UI Orchestrateur (web + Android) — OpenAI GPT-6 Astra — 2026-09-23

**Décision de design : une conversation de direction, accompagnée d'un rail de pilotage.** Le chef reste l'interlocuteur ; chaque musicien est une mission observable. Les résultats arrivent dans un panier compact, puis le chef les transforme en rapport. Tout nom de musicien ouvre son contenu, avec retour à l'endroit quitté.

> « un dialogue avec le chef, qui pilote les autres, puis me fait un rapport une fois les résultats obtenus. Toujours la possibilité de plonger dans un musicien pour voir le contenu. »

Document fonctionnel : comportements, information et navigation, sans implémentation. Sources lues sur disque le 23 septembre 2026 : serveur **0.20.0**, Android **0.5.0 / versionCode 14**. Ces versions ne prouvent pas le déploiement du processus 7777 ni l'installation de l'APK. Aucun code, configuration, version ou service modifié. Seule écriture documentaire : ce fichier ; le callback demandé est envoyé séparément au chef par `notify.mjs`.

## 1. Matière réelle de l'interface : le serveur d'abord

### 1.1 Sources et ordre de confiance

La cartographie repose sur les handlers et producteurs de `server.js`, puis `scripts/fleet-status-core.mjs`, `scripts/dispatch.mjs`, `config.json`, et les consommateurs web/Android. Les documents suivants expliquent l'intention, mais ne remplacent pas le code présent :

- [Redéfinition des événements](orchestrateur-events-redesign-fable.md) et [progression événements](orchestrateur-events-impl-progress.md) : panier, cartes, questions, puis parité mobile.
- [Réveil sur callback](orchestrateur-callback-wake-fable.md) et [progression callback](orchestrateur-callback-wake-impl-progress.md) : réveil sélectif, regroupement, protection contre les boucles.
- [Analyse Astra précédente](orchestrateur-redesign-astra.md), [contre-expertise](orchestrateur-redesign-validated.md), [problème du chef figé](chef-stuck-analysis-validated.md), [brief initial](project-brief.md) : historique des contraintes. Leur proposition éventuelle de mettre la flotte au centre est dépassée par la présente décision utilisateur.
- `public/index.html`, `app.js`, `styles.css`, `pupitre-row.*`, `pupitre-detail.*` ; Android `Models.kt`, `FleetScreen.kt`, `FleetViewModel.kt`, `MainPane.kt` et `Api.kt` : acquis réellement consommés.

Les repères ci-dessous sont ceux de l'arbre lu ; les noms des handlers restent les repères durables.

### 1.2 Endpoints et surfaces disponibles

| Surface réelle | Données / effet constatés | Utilisation fonctionnelle |
|---|---|---|
| `GET /api/version` (`server.js:1708`) | `{version}` du serveur chargé | Version serveur visible dans À propos ; distincte de la version Android. |
| `GET /api/config` (`:1712`) | `conductor`, defaults, projets : nom, chemin, modèle, outils, provider, `parked`, session attachée, `readAt`, `currentState`, `lastLine`, `unreadCount` | Identité du chef, annuaire, réglages et lecture/non-lu. Ce n'est pas un instantané de santé. |
| `GET /api/pupitre` (`:1776`) | Racine `now`, `conductor`, `noFailover`, `limitedUntil`, `fleet` ; détail ci-dessous | État observé et santé de tous les membres, chef inclus. Source commune du rail et du détail. |
| `GET /api/sse/fleet` (`:2665`) | Flux commun ; enveloppe `{project, line}` dont `line` contient l'événement JSONL ; signal `fleet_config_changed` ; heartbeat 15 s | Stream live, changements de liste et indices de rafraîchissement. Aucun historique complet ni curseur de replay garanti. |
| `GET /api/conductor-chat?n=` (`:2246`) | 60 entrées par défaut, maximum 200, queue de fichier de 2 Mio ; rôles `user`, `conductor`, `callback`, provenance et champs enrichis | Reconstruction du dialogue, paniers et questions. Ne renvoie pas toute l'activité intermédiaire du chef. Les prompts `source:"wake"` sont omis. |
| `GET /api/project/:name/events?n=` (`:2150`) | 120 événements par défaut, maximum 500, lecture des derniers 2 Mio ; recomposition des deltas en blocs assistant | Détail musicien immédiat, y compris tour déjà commencé. Fenêtre récente, **pas un accès paginé à l'intégralité du log**. |
| `POST /api/dispatch` (`:3365`) | Projet, prompt, pièces jointes ; réponse 202 après lancement, avec informations de dispatch. Envoi normal vers un projet occupé : interruption coopérative et reprise. Préfixe `@X` envoyé au chef : raccourci vers X, mis en file si occupé | Composer chef par défaut ; expliciter la cible et les effets en cours de tour. Un 202 ne signifie pas « tâche réussie ». |
| `POST /api/notify` (`:3103`) | `{project,text,source}` ; écrit un `user_prompt` sourcé et peut produire un toast. Body JSON limité à 2kb | Information de coordination, éventuellement intermédiaire. **Ne démarre pas un tour et ne constitue pas un résultat terminal attendu.** |
| `POST /api/mark-read` (`:1836`) | Marqueur persistant par projet, timestamp optionnel | Lecture/non-lu partagée ; lire ne signifie ni résoudre ni faire synthétiser par le chef. |
| Sessions : `GET /api/sessions`, `GET /api/projects/:name/sessions`, `POST` et `DELETE /api/projects/:name/attach`, `POST /api/projects/:name/sessions/new` | Sessions connues, attachement/détachement, nouvelle session | Actions avancées dans le détail ou les réglages. |
| Administration : `POST /api/conductor`, `/api/config/provider`, `/api/project/:name/provider`, `/api/project/:name/park`, `/api/project/:name/add-tool` ; `GET /api/projects/candidates`, `POST /api/projects`, `PATCH /api/projects/:name/tools`, `DELETE /api/projects/:name` | Choix chef, configuration, mise de côté, projets et outils | « Gérer l'orchestre », séparé du parcours de dialogue. Changer de chef affecte les sessions ; ce n'est pas une simple sélection de vue. |
| `POST /api/attach/image`, `/attachments/…` | Upload et accès aux médias, chemins repris au dispatch | Conserver joindre/coller/glisser, vignette et retrait avant envoi. |
| `/downloads`, `/downloads/:app/apk`, `/downloads/:project/doc/:id`, suffixe `/raw` | Catalogue HTML, APK `builds/<app>/latest.apk`, documents enregistrés, rendu et Markdown brut | Livrables accessibles depuis le rapport et un accès secondaire « Livrables ». Pas d'API universelle de builds/jobs. |
| `/pupitre`, `/healthz`, `/ws/pty`, `POST /api/ssh/register-key` | Pupitre autonome, santé serveur, pont terminal central, clé Android | Garder les usages existants ; diagnostic et administration hors du dialogue courant. Aucun terminal interactif inventé pour un musicien headless. |

Les routes de téléchargements sont déclarées **avant** le token gate (`server.js:1541–1573`) ; les routes applicatives sont ensuite derrière le middleware, selon son activation. Celui-ci accepte header, query ou cookie. Le design ne modifie pas l'accès existant et n'invente pas un téléchargement public des logs ou des documents non enregistrés.

### 1.3 Le snapshot pupitre : ce que signifie chaque information

Pour un membre non mis de côté : `name`, `state`, `awaitingChef`, `stalled`, `deadInFlight`, `lastKind`, `activity`, `silentMs`, `fileSilentMs`, `turnElapsedMs`, `sizeBytes`, `pid`, `pidAlive`, `model`, `provider`, `needsInput`. Le serveur ajoute `isConductor`, `parked`, `queueDepth`, `configModel`, `configProvider`.

- `stalled` : tour `live/think`, sans événement non partiel depuis **60 s** selon le core. C'est « sans progrès observé », pas une preuve d'échec ; des deltas peuvent encore arriver. Le core emploie des fallbacks de date/mtime : les durées sont des observations, pas une horloge contractuelle de mission.
- `deadInFlight` : tour encore ouvert dans le log, PID connu mais non vivant. Signal plus fort, affiché avant le stall. `pidAlive:null` signifie inconnu, pas mort.
- `silentMs` et `fileSilentMs` répondent à des questions différentes : dernier événement non partiel et dernière écriture fichier. Aucun des deux n'est l'âge de la connexion du client.
- `activity` est un aperçu court ; `needsInput` est limité à 160 caractères. Ouvrir le contenu pour une question ou une commande complète.
- `model/provider` observés priment sur `configModel/configProvider` ; si seul le fallback existe, l'appeler « configuré ».
- Cache serveur de 2,5 s. Le web a un poll global visible de 5 s et un poll de détail de 2,5 s avec indices SSE ; Android interroge toutes les 5 s au premier plan. Ne pas multiplier les polls par carte.
- Les projets `parked` ne sont **pas scannés** : leur entrée minimale `state:idle` n'atteste ni une inactivité vérifiée ni un PID sain. Afficher « Mis de côté · santé non suivie » ; leur contenu reste consultable.

`config.json` contient **29 projets : chef + 28 musiciens, dont 13 mis de côté**, donc 15 musiciens non parkés. Actifs dans la configuration : jellyfin, coursSQL, TradeBot, BookHaven, RemotePad, DeskZen, vuBox, orchestrateur, immo-share, newsParser, index, soundhive, youtube-live, Jarvis-Career, devopsPrep. Mis de côté : meetingScribe, firstAidOffline, photoLab, batteryGuard, shoette, stmichel, veille, Speech2Text, demarchage, frenchradio, panierIL, liveRec, collection_trad. « Actif dans la configuration » ne signifie pas « travaille actuellement ». La liste doit suivre `/api/config`, jamais être codée en dur.

### 1.4 Événements, reducers et état verrouillé

Les réductions sont distinctes : `scanProjectState` hydrate la config en tenant compte de la lecture ; `reduceMusician` (`server.js:2333`) pilote les notifications et consomme l'attente callback au résultat ; `deriveState/scanProject` du core calculent le pupitre sans marqueur de lecture. Web et Android ont aussi leur reducer. Cette pluralité interdit de présenter une simple copie du dernier événement comme une vérité complète.

| Événement existant | Sens | Présentation attendue |
|---|---|---|
| `user_prompt` sans source, puis `system/init` | Demande / début de tour | Bulle utilisateur ; activité du chef quand un vrai tour est engagé. |
| `user_prompt` sourcé | Notify, raccourci ou wake, selon `source` | Jamais un démarrage supposé. `shortcut→X` reste un message utilisateur explicitement direct ; `wake` reste invisible dans le dialogue. |
| `stream_event`, `assistant`, `user` avec `tool_result` | Deltas puis contenu consolidé, outils et sorties | Activité condensée ; détail conserve les blocs. Pas de double texte delta + assistant. |
| `result` réel | Fin de tour, métriques, texte, succès/erreur/question | Fin observée ; n'assimiler ni « tour fini » ni « non lu » à « demande entièrement satisfaite ». |
| `notification/musician_done` ou `musician_question` | Coordination écrite dans le log chef | Carte avec `source`, `outcome`, `summary`, `duration_ms`, `cost_usd`, `awaitingChef`. |
| `result` erreur synthétique | Clôture système : interruption, quota, réparation | État de repos + cause ; pas un succès, pas une fausse erreur imputée au musicien, pas de callback terminal normal. |
| Notices `log_growth_skipped`, `oversized_line_skipped` | Contenu omis du flux | Avertissement de contenu incomplet, accès au détail récent ; aucune promesse de récupération intégrale. |

**Écart explicite avec le vocabulaire demandé.** Le contrat visuel de cette refonte est strictement `idle|live|input|done|error`. Cependant les sources actuelles, y compris `Models.kt`, transportent aussi `think` et `unread` et ne produisent pas généralement `done` comme état de reducer. On ne renomme aucune chaîne existante. La correspondance ci-dessous est une **règle de présentation**, pas une migration du protocole ni de l'enum Android.

| Valeur reçue / fait | État visuel parmi les cinq | Libellé et badge séparés |
|---|---|---|
| `idle` | `idle` | Prêt ; si clôture synthétique : Interrompu / Limité. |
| `live` | `live` | En cours. |
| `think` | `live` | En cours · réflexion. |
| `input` | `input` | Votre réponse attendue. |
| `unread` | `done` | Tour terminé · non lu si confirmé par la lecture. Le snapshot seul ne prouve pas le non-lu. |
| `unread` + `awaitingChef` | `done` | **Attend le chef**, qui remplace « Terminé » en texte principal ; le tour headless est clos mais la mission attend. |
| `error` | `error` | Échec · raison. |

Une valeur `done` venant d'un composant visuel reste `done`. Aucun état `stalled`, `waiting_chef`, `offline` ou `limited` ajouté : ce sont des badges orthogonaux. Après lecture, un reducer peut revenir à `idle` ; le dernier résultat demeure consultable. Le travail, la santé, la fraîcheur et la lecture restent quatre informations distinctes.

### 1.5 Réveil-sur-callback : acquis et limites observables

Le `user_prompt` du tour musicien peut porter `callback:chef` et `wakeGen`. `reduceMusician` conserve cette attente pendant le tour puis la consomme au `result`. Le watcher écrit la notification et programme un réveil seulement pour un résultat réel attendu, d'un autre projet que le chef, vers `unread` ou `error`. Une question à l'utilisateur (`input`) est exclue. Le relais `NEEDS_CHEF_INPUT` est un autre chemin existant, avec `[NEEDS_CHEF_INPUT_FROM:X]` et retour `[CHEF_ANSWER]` ; ne pas lui attribuer les garanties de sérialisation du nouveau scheduler.

Le scheduler (`server.js:366–541`) regroupe les arrivées : fenêtre calme de 10 s, collecte plafonnée à 90 s, puis tir seulement si les autres gardes le permettent. Il n'attend pas une liste exhaustive de missions restantes. Chef occupé ou quota actif : report du tir ; au moins 60 s entre tirs, au plus 6/heure, deux générations. Une vraie demande utilisateur au chef annule le lot de réveil en attente. Persistance du pending et dédup, reprise bornée au redémarrage, TTL 6 h et cap 20. Le plafond de collecte de 90 s n'est donc **pas un délai garanti de rapport**.

Le prompt serveur `[CALLBACK_WAKE lot=n gen=k]` fournit au chef issues, résumés, durées et coûts. Il ne doit jamais apparaître comme parole humaine. L'interface actuelle capture les résultats reçus au début du tour chef et affiche « prend en compte : A ✓ · B ✕ » sur sa réponse. Ce lien est une association d'affichage, **pas un accusé serveur attestant que chaque résultat a effectivement été analysé**.

**Non exposé aujourd'hui par `/api/pupitre` :** `expectCallback`, nombre de réveils en attente, `lastWakeAt`, budget et motif précis de report. Ils sont encore P1 dans le document d'implémentation. `/api/conductor-chat` retire le prompt wake sans fournir `wake:true`. Pas non plus d'identifiant durable de demande, graphe de dispatchs ou relation structurée rapport↔résultats. Le design principal fonctionne sans eux ; les raffinements qui en dépendent sont isolés en fin de document.

## 2. Ce qui change dans l'architecture de l'information

L'UI actuelle possède déjà un fil chef, un composer, un panneau flotte, une carte chef, un briefing, un pupitre et un détail commun. Le problème n'est pas leur absence : le fil reste un panneau gauche à largeur contrainte, face à une scène de cartes, fils lumineux et chef dupliqué. Sur Android, le changement d'onglet met aisément un musicien au rang d'interlocuteur ; les activités intermédiaires du chef occupent le fil à plat. Les acquis 0.18–0.20 sont présents, mais leur hiérarchie n'exprime pas suffisamment « demande → délégation → retour du chef ».

### 2.1 Trois niveaux, une seule destination de conversation

1. **Dialogue avec le chef** : écran d'accueil et point de retour. Demandes, réponses, questions à arbitrer, paniers et rapports. Le composer annonce toujours sa cible.
2. **Pilotage** : rail desktop, feuille mobile. Montre qui travaille, sur quoi, qui attend, qui a rendu et les anomalies. Il accompagne le fil sans le remplacer.
3. **Détail d'un musicien** : même destination depuis rail, nom dans une mission, carte résultat, ligne « prend en compte », question, alerte, recherche ou annuaire. Contenu complet disponible dans la fenêtre servie, pas un nouveau chat principal.

Accès permanent « Musiciens / rechercher » sur tous les niveaux, y compris si le rail est replié. Il inclut les parkés et permet de passer à un autre musicien sans retourner à l'accueil. Les noms structurés sont activables ; dans la prose du chef, reconnaître les noms exacts connus sans modifier la copie du texte. L'annuaire reste le recours lorsque le chef emploie un alias non reconnu.

### 2.2 Répartition desktop

Sur grand écran, la conversation reçoit environ deux tiers de l'espace utile ; largeur de lecture confortable, sans étirer les lignes. Le rail droit reste de l'ordre de 300–360 px. Ce sont des intentions de composition, pas des valeurs CSS imposées. Quand le détail s'ouvre, il remplace le rail et s'élargit ; le fil reste visible si l'espace le permet. Sur fenêtre étroite, le détail devient une vue pleine largeur avec retour explicite.

- En-tête : identité du chef, fraîcheur, accès Musiciens et menu secondaire. Pas de seconde grande carte chef.
- Sous l'en-tête : bandeau « À votre attention » seulement si nécessaire ; priorité question utilisateur, processus perdu, erreur, stall. Une ligne et un compteur, détail au clic. Les limites de fournisseur et la perte de connexion ont un libellé système distinct.
- Fil : groupes chef, résultats et questions. L'activité technique du chef est repliable sous son tour.
- Rail : missions observées en cours, à examiner, autres disponibles ; « Tous les musiciens » et « Mis de côté (n) ». Ordre d'attention stable, nom à priorité égale ; pas de déplacement sous le pointeur ou le focus.
- Composer fixé au bas du fil, avec brouillon, pièces jointes et éventuel contexte de réponse.

« Mission » signifie ici le prompt d'un tour observé. Si aucune relation structurée ne prouve son rattachement à la demande affichée, la section s'appelle **Activité de l'orchestre**, et non « Tes trois sous-tâches ». Le texte du chef peut annoncer un plan ; une ligne de pilotage ne passe à « démarré » qu'après événement observé. Aucun pourcentage ni compteur « 2 sur 3 » sans liste connue.

### 2.3 Entrer et sortir du détail

Ouvrir un musicien conserve ancre de lecture, position de scroll, dépliages et brouillon chef. Le détail porte son nom, son rôle « Musicien piloté par le chef », sa mission observée et un bouton **Retour au chef**. Échap ferme sur desktop ; le Retour Android ferme d'abord clavier/feuille, puis détail. La fermeture restitue le focus à l'élément d'origine.

Le détail propose **Activité**, **Dernier résultat** et **Journal récent** :

- Activité : stream live, texte, outils et sorties associés ; arguments longs et `tool_result` repliés, dépliables et copiables sans perdre leur contenu. Réflexion déjà disponible dans le flux repliée et atténuée.
- Dernier résultat : issue, texte disponible, durée, coût rapporté, éventuelle question et liens de livrables. Ouvrir depuis une ancienne carte vise d'abord ce résultat si encore disponible, puis permet « Voir l'activité actuelle ».
- Journal récent : ordre des événements, horodatages fournis, notices système, détails techniques. Mention explicite de la fenêtre bornée ; pas de faux bouton « Tout l'historique » tant que l'API ne le permet pas.

En tête : état + activité ; seconde ligne compacte « tour · dernier progrès · processus · modèle ». PID numérique, provider et queue dans « Santé et session ». `—` pour les mesures absentes. Le détail permet de suivre le bas du flux ; remonter suspend le suivi et affiche « N nouveaux événements · rejoindre le direct ».

L'action principale est **En parler au chef** : elle retourne au composer chef avec projet nommé et extrait cité. Ouvrir un musicien ne change jamais silencieusement le destinataire du composer. Les fonctions existantes d'envoi direct restent dans « Actions avancées → Envoyer directement à X » avec cible et effet explicites.

## 3. Résultats, rapport et questions : règles de présentation

### 3.1 Le panier prépare la lecture du rapport

Une notification terminale alimente « Résultats reçus (n) ». Une ligne donne le nombre et les issues ; un résultat unique peut montrer son aperçu, plusieurs restent repliés. Chaque entrée porte le nom, l'issue et une conclusion courte ; durée et coût au niveau résumé. Le coût est celui rapporté par le tour, pas une facture ni un cumul de session. Une valeur absente vaut « non fourni », jamais zéro.

Le résumé serveur est un extrait de conclusion (dernier paragraphe, environ 280 caractères), pas une nouvelle synthèse générée par l'UI. Le texte complet servi se consulte dans le détail. Les anciens callbacks sans champs gardent leur texte et une provenance claire ; un notify manuel sans issue autoritaire est présenté comme **Information de X**, sans coche de réussite ajoutée.

Si le chef travaille, un résultat normal rejoint le panier retenu. Un compteur discret « 2 résultats reçus » peut évoluer dans le rail ; aucune carte ne coupe sa réponse. Le panier est publié après celle-ci ou après désarmement par le filet de liveness. Une question utilisateur saute ce mécanisme. Aucun toast supplémentaire lorsque le même résultat est déjà lisible ; hors de la zone regardée, une notification groupée suffit.

### 3.2 Le rapport est une réponse du chef

Séquence nominale : panier reçu → véritable tour chef → rapport dans le même fil, sans nouveau message utilisateur. Pendant le tour, « Le chef prépare son point » si l'origine réveil a été observée ; sinon « Le chef travaille ». Ne pas afficher cette activité au seul `user_prompt` sourcé : attendre le démarrage réel.

Le rapport commence par **CHEF — Point sur les résultats**, puis « prend en compte : A ✓ · B ✕ · C ⇄ ». Chaque référence ouvre sa carte source et son musicien. Ensuite : conclusion du chef, réalisations utiles, échecs ou décisions restantes, suite proposée. L'interface préserve le texte du chef ; elle ne réécrit pas une réponse pour lui faire tenir une promesse. Réponse longue : aperçu et « Lire le rapport », sans masquer une question active.

Le panier conserve sa place comme trace d'arrivée. Le rapport lui ajoute un lien de navigation ; il ne recopie pas toutes ses cartes. Ouvrir le panier ne marque pas ses éléments « traités par le chef ». « Prend en compte » reste l'intitulé acquis ; son aide précise « résultats reçus avant ce tour ». Sans relation durable, on ne montre ni « validés » ni garantie d'exhaustivité.

Si B arrive après le début du rapport sur A, B reste dans un nouveau panier : ne pas l'ajouter rétrospectivement à l'en-tête figé du rapport. Le chef pourra faire un point complémentaire. Un rapport intermédiaire ne devient pas « demande terminée » tant que du travail connu reste ouvert.

### 3.3 Attente sans rapport et reprise utilisateur

« Résultats reçus · rapport du chef non reçu » décrit un fait disponible. Pas de décompte « réponse dans 10 s », ni de « réveil en attente : 2 » inventé à partir du panier visuel. Si le chef est occupé, montrer son activité ; si `limitedUntil` est actif, montrer l'heure et `noFailover` en détail. Un stall ou PID mort sans résultat ne déclenche pas aujourd'hui de réveil P0 ; l'alerte reste visible sans promettre une synthèse automatique.

**Demander un point au chef** préremplit une demande nommant les résultats concernés, puis l'utilisateur envoie. Cela permet de fournir du contexte même si le wake a été annulé par une nouvelle demande. Aucun auto-dispatch client. Lorsque le chef a un tour vivant, l'envoi affiche l'effet réel « Envoyer et interrompre le tour actuel du chef » ; la conservation du brouillon permet d'attendre sa fin. Ne pas proposer « Ajouter à la file du chef » sans route correspondante.

### 3.4 Questions : priorité et destinataire explicites

- **`NEEDS_USER_INPUT` d'un musicien** : encart dans le fil « Question de X · votre décision », nom ouvrable, question visible sans ouvrir un panneau. Elle reste accessible dans Attention même si le chef parle. L'action principale « Répondre via le chef » cite la question et nomme X dans un message au chef ; aucun préfixe `@X` implicite, puisqu'il contournerait le chef dans le serveur actuel.
- La réponse reste dans le dialogue de direction ; le chef arbitre/relaye. Si plusieurs questions sont actives, le contexte de réponse affiche la cible choisie. La saisie libre ambiguë n'autorise pas l'UI à deviner le destinataire. « Réponse envoyée au chef » n'est pas « Question résolue » : attendre une reprise ou réponse observée.
- L'ancien raccourci reste accessible comme action secondaire explicite « Répondre directement à X », avec mention de l'envoi direct et de la file si X est occupé. Un retour 202 « mis en file » est affiché comme tel.
- **`NEEDS_CHEF_INPUT`** : carte et ligne de mission « ⇄ Attend le chef », pas « Votre réponse attendue », pas coche de mission achevée. Au dépliage, question au chef et décision/reprise lorsqu'elles sont observées. N'établir le lien que si les marqueurs existants identifient le musicien ; sinon conserver les événements séparés. L'utilisateur peut « En parler au chef » sans devoir prendre sa place.
- **Question du chef** : vraie bulle du chef, marquée Question, conservée au rechargement. Plusieurs questions sont listées, pas écrasées par la plus récente.

La notification peut contenir une question tronquée (`lastLine` jusqu'à 600 caractères). Dans ce cas, afficher « question abrégée » et permettre d'ouvrir le texte source récent ; ne pas présenter l'extrait comme verbatim intégral.

## 4. Maquettes fonctionnelles desktop

Exemples fictifs de contenu et de mesures, sans affirmation sur l'activité actuelle.

### A. Demande et travail délégué

```text
+-----------------------------------------------------------------------------------+
| ORCHESTRATEUR / Chef       Synchronisé il y a 3 s     [Musiciens / chercher] [Menu] |
+-----------------------------------------------------------+-----------------------+
| DIALOGUE AVEC LE CHEF                                      | PILOTAGE              |
|                                      VOUS                 | Activité observée     |
|                       Vérifie vuBox et RemotePad.           |                       |
| CHEF                                                      | [vuBox]       En cours|
| Je leur confie les tests et la compilation.                | Tests de lecture      |
| Je te ferai un point sur les résultats.                    | outil Bash · tour 2m  |
| [Activité du chef : 2 outils >]                            | progrès 8s · proc. OK |
|   Pilotage observé : [vuBox] démarré · [RemotePad] démarré   |                       |
|                                                           | [RemotePad]   En cours|
|                                                           | Compilation Android   |
|                                                           | sans progrès 1m12  (!)|
|                                                           |                       |
|                                                           | [Tous les musiciens]  |
|                                                           | [Mis de côté (13) >]  |
+-----------------------------------------------------------+-----------------------+
| À : CHEF   [Joindre]  Écrivez au chef…                         [Envoyer]            |
+-----------------------------------------------------------------------------------+
```

Le rail est consultable pendant la rédaction. « Pilotage observé » se déplie pour voir mission et étapes disponibles ; aucun outil brut des musiciens ne remplit le fil principal.

### B. Résultats et rapport poussé

```text
+-----------------------------------------------------------+-----------------------+
| DIALOGUE                                                  | PILOTAGE              |
| Résultats reçus (2) : 1 terminé, 1 échec               [v] | [vuBox] Tour terminé  |
|   [vuBox]     ✓ 3m12 · 0,42 USD                            | [RemotePad] Échec     |
|   Tests réussis ; deux avertissements. [Ouvrir le résultat]|                       |
|   [RemotePad] ✕ 0m48 · coût non fourni                     |                       |
|   Compilation arrêtée : dépendance absente. [Ouvrir]       |                       |
|                                                           |                       |
| CHEF — Point sur les résultats                            |                       |
| prend en compte : [vuBox ✓] · [RemotePad ✕]                |                       |
| vuBox est vérifié. RemotePad reste bloqué sur…             |                       |
| Voici ce qui a été obtenu et ce qu'il reste à décider…     |                       |
| [Activité du chef >] [Voir les 2 résultats source]          |                       |
+-----------------------------------------------------------+-----------------------+
| À : CHEF   Votre réponse…                                         [Envoyer]       |
+-----------------------------------------------------------------------------------+
```

Le rapport apparaît sans demande supplémentaire. Le marqueur `[CALLBACK_WAKE]` reste absent. La croix qualifie l'issue du musicien, pas une erreur de transport.

### C. Plongée sans perte du dialogue

```text
+------------------------------------+----------------------------------------------+
| CHEF / conversation conservée      | [Retour au chef]  RemotePad   [Musiciens] [X]|
| Point sur les résultats…           | Musicien piloté par le chef                  |
|                                    | Échec · compilation Android                  |
| (ancre et brouillon conservés)      | Tour 48s · snapshot il y a 2s [Santé/session] |
|                                    +----------------------------------------------+
|                                    | [Activité] [Dernier résultat] [Journal récent]|
|                                    | Mission reçue : compiler…                [>]|
|                                    | Outil : Bash ./gradlew…                   [v]|
|                                    |   Arguments complets…                        |
|                                    |   Sortie liée : 42 lignes                 [>]|
|                                    | Résultat : dépendance absente…               |
|                                    | [En parler au chef] [Actions avancées]       |
|                                    | Suivi suspendu · 4 nouveaux événements [Bas] |
+------------------------------------+----------------------------------------------+
```

### D. Question et santé sans avalanche de panneaux

```text
À VOTRE ATTENTION  [1 question] [1 processus perdu]                        [Détails]

Question de [DeskZen] · votre décision
« Préfères-tu une synchronisation manuelle ou automatique ? »
[Répondre via le chef] [Voir le contexte]

PILOTAGE : [BookHaven] ⇄ Attend le chef  [Voir la question]
           [RemotePad] En cours · ! processus perdu  [Ouvrir]

COMPOSER / À : CHEF
Contexte : réponse à la question de DeskZen                         [Retirer le contexte]
Je préfère la synchronisation manuelle…                            [Envoyer]
```

## 5. Android : la même hiérarchie dans une navigation mobile

L'app conserve connexion, authentification/biométrie, pièces jointes et reprise de flux. Le dialogue chef devient la racine permanente. Les onglets de musiciens au même niveau sont remplacés fonctionnellement par une **barre de pilotage compacte** et l'accès Musiciens. Le web étroit suit la même organisation ; une tablette peut reprendre le détail latéral.

### A. Conversation et rapport

```text
+-------------------------------------+
| ORCHESTRATEUR / Chef [Musiciens] [⋮] |
| Synchronisé il y a 3 s               |
| Pilotage : 2 en cours · 1 question > |
+-------------------------------------+
|                        VOUS         |
|          Vérifie les deux projets.  |
| CHEF                                |
| Je lance les vérifications…          |
| [Pilotage observé : vuBox, RemotePad]|
| [Activité du chef >]                 |
|                                     |
| Résultats reçus (2)              [>] |
| CHEF — Point sur les résultats       |
| prend en compte :                   |
| [vuBox ✓] · [RemotePad ✕]           |
| vuBox passe. RemotePad est bloqué…   |
| [Lire le rapport]                   |
+-------------------------------------+
| À : CHEF                            |
| [+] Votre message…        [Envoyer]  |
+-------------------------------------+
```

Le clavier réduit la zone de lecture, pas l'accès à la cible. Une arrivée de rapport pendant la rédaction préserve le brouillon et ne déplace pas le scroll : « Nouveau rapport ↓ ». Pas d'animation qui impose de rejoindre le bas.

### B. Feuille Pilotage / Musiciens

```text
+-------------------------------------+
| Conversation visible en arrière-plan|
+-------------------------------------+
| PILOTAGE                 [Fermer]   |
| [Rechercher un musicien…]           |
| [En cours] [À examiner] [Tous]       |
|                                     |
| vuBox                      En cours |
| Tests lecture · outil Bash          |
| tour 2m · progrès 8s · processus OK  |
|                                     |
| DeskZen              Votre réponse  |
| Quelle synchronisation ?            |
| [Question dans le fil] [Ouvrir]      |
|                                     |
| BookHaven             Attend le chef|
| [Mis de côté (13) >]                |
+-------------------------------------+
```

Un tap sur la ligne ouvre le détail. La feuille peut s'étendre en plein écran pour parcourir les 28 musiciens ; le champ de recherche inclut les parkés. La sélection reste visible, sans réordonnancement pendant un geste. Une alerte ne vole pas la sélection.

### C. Détail plein écran et retour

```text
+-------------------------------------+
| [< Chef] RemotePad [Musiciens] [⋮]  |
| Musicien · Compilation Android       |
| En cours · ! sans progrès observé    |
| Snapshot il y a 4s    [Santé/session]|
+-------------------------------------+
| [Activité] [Résultat] [Journal]      |
| Mission reçue…                  [>] |
| Outil : Bash ./gradlew…          [v] |
| Arguments…                          |
| Sortie : 42 lignes              [>] |
| Texte du musicien…                  |
|                                     |
| 6 nouveaux événements [Rejoindre ↓] |
+-------------------------------------+
| [En parler au chef]                 |
+-------------------------------------+
```

Retour restaure le fil à l'ancre d'origine. Si l'entrée venait d'une feuille de résultats, Retour retrouve cette feuille ; « Chef » rejoint directement la conversation. Un nouveau rapport peut être signalé par « Chef · nouveau rapport », sans fermeture forcée du détail.

Les zones tactiles sont d'au moins 48 dp, le texte respecte l'agrandissement Android, les badges ont des libellés TalkBack. Ne rien réserver au survol. La télémétrie de second niveau peut être dépliée ; l'alerte principale et sa fraîcheur restent visibles même sur petit écran.

Au passage en arrière-plan, SSE et polling s'arrêtent comme aujourd'hui. Au retour : snapshot, historique chef et événements récents du musicien ouvert, puis reprise du live et fusion sans doublons. Pas de promesse de notification Android en arrière-plan ou de rapport immédiatement visible app fermée : aucun push mobile correspondant n'est établi dans ce périmètre. Le serveur peut travailler pendant l'absence ; l'app retrouve le rapport au retour.

## 6. Cycle de vie d'une demande

| Étape | Ce que voit / fait l'utilisateur | Ce qui autorise cet affichage |
|---|---|---|
| 1. Demander | Composer « À : chef », texte et médias ; envoi en cours, accepté ou échec d'envoi avec brouillon conservé | Réponse HTTP puis prompt observé ; dédup de l'écho local. |
| 2. Le chef pilote | Réponse du chef, activité repliée, missions observées dans le rail | Texte chef pour le plan ; événements du musicien pour démarrage effectif. |
| 3. Les musiciens travaillent | Nom, mission, activité courte, santé ; plongée possible depuis toute référence | SSE pour le contenu, pupitre pour santé et fraîcheur. Chef au repos pendant ce temps = comportement normal. |
| 4. Question éventuelle | Encart dans le fil ou badge « attend le chef », selon destinataire | Sentinelles et notification avec `outcome`, sans mélanger les deux attentes. |
| 5. Résultats reçus | Panier groupé avec succès, échec, attente ; accessible pendant que d'autres continuent | Notifications terminales réelles ; notify manuel reste une information. |
| 6. Rapport | Réponse chef poussée, ligne « prend en compte », conclusion et décisions | Wake attendu effectivement lancé ou nouveau tour utilisateur. Aucun rapport synthétique inventé côté UI. |
| 7. Suite | Répondre au chef, consulter résultat/livrable, demander complément | Action utilisateur ou plan réellement exécuté par le chef. Lire un résultat ne redispatche rien. |

Une demande peut traverser plusieurs tours chef et plusieurs tours d'un même musicien. Le design n'ajoute pas de fermeture automatique de « demande » fondée sur le dernier `done`. L'éventuelle conclusion « tout est terminé » appartient au rapport étayé du chef ; les missions encore ouvertes restent visibles.

## 7. Différenciation graphique et divulgation progressive

### 7.1 Rôles d'abord, couleur ensuite

| Rôle | Forme et hiérarchie | Traitement |
|---|---|---|
| Utilisateur | Bulle à droite, label Vous | Contenu envoyé et contexte de réponse ; aucun callback ne prend ce rôle. |
| Chef | Bloc principal à gauche, label CHEF, liseré ambre et largeur de lecture | Plan, réponse, rapport ; activité technique repliée sous le même tour. |
| Musicien | Ligne de mission ou carte rectangulaire en retrait, nom ouvrable | Rend compte ; pas de composer musicien permanent dans la vue de direction. |
| Système | Bandeau fin ou badge avec libellé explicite | Connexion, santé, limites, contenu incomplet ; aucune bulle anthropomorphe. |

Conserver les ressources locales PHOSPHOR et les préférences visuelles compatibles. Accent chef stable ; codes d'état indépendants : `idle` gris/○, `live` bleu-vert/●, `input` ambre/?, `done` cyan/✓, `error` rouge/✕. Le badge « attend le chef » utilise ⇄ et son texte, même si le tour est visuellement `done`. Le vert/cyan d'un tour fini ne prouve pas une validation métier. Ni couleur seule ni clignotement continu ; transitions discrètes, mouvement réduit respecté. Police mono pour outils/métriques, texte de dialogue lisible et contrasté.

### 7.2 Trois niveaux de lecture

| Objet | Niveau 0 : sans action | Niveau 1 : déplier | Niveau 2 : ouvrir le détail |
|---|---|---|---|
| Mission | Nom, état, une ligne de sujet/activité, anomalie prioritaire | Prompt observé, durée, modèle, progrès, file | Stream et outils, session, journal récent. |
| Résultats | « 3 reçus · 1 échec », ou aperçu si unique | Cartes : conclusion, issue, durée, coût | Résultat source et contexte du musicien. |
| Rapport chef | Conclusion, « prend en compte », décision attendue | Rapport entier, activités chef regroupées | Résultats référencés ou détail chef. |
| Question | Question courte et destinataire, action de réponse | Question disponible et contexte complet | Événements source ; limites de troncature signalées. |
| Santé | « processus perdu » ou « sans progrès observé » | Âge des données, dernier progrès, processus, limite | PID, modèle observé/configuré, cause système. |

Une anomalie prioritaire peut remonter au niveau 0 sans déplier toute la télémétrie. Les activités intermédiaires Android déjà conservées sont regroupées, jamais supprimées. Replier ne détruit pas le contenu. Un nouveau résultat ne referme pas ce que l'utilisateur lisait.

### 7.3 Fraîcheur, silence et panne ne sont pas synonymes

- **Synchronisé il y a X s** : âge du dernier snapshot reçu et état du flux accessibles ; aucune activité musicien nécessaire pour être connecté.
- **Flux interrompu** : SSE coupé, reconnexion automatique. Si le snapshot répond, préciser « états actualisés, direct interrompu » plutôt que déclarer tous les musiciens morts.
- **Données anciennes** : échec de snapshot ou retard anormal ; conserver les dernières valeurs, dater l'observation, suspendre toute apparence de santé confirmée. Proposition de seuil UX : 15 s au premier plan sans snapshot réussi, en complément des erreurs explicites ; ce n'est pas un seuil de stall serveur.
- **Sans progrès observé** : uniquement `stalled` du core pour l'alerte ; silence courant reste une mesure. Un outil long et un PID vivant ne deviennent pas une panne certaine.
- **Processus perdu** : `deadInFlight`, visible avec la date d'observation. Pas de relance automatique par l'interface.
- **Mis de côté / inconnu** : aucune pastille « processus OK » fabriquée pour une donnée absente.

Après déconnexion ou notice de saut, recroiser snapshot et historique récent sans tout marquer lu. Les trous peuvent dépasser la fenêtre de 2 Mio : indiquer « historique partiel » si la continuité ne peut être établie. Ne pas déplacer les anciens messages à l'heure de reconnexion ; préserver l'ordre serveur, et signaler l'heure approximative si elle est reconstruite.

## 8. Contraintes de compatibilité et limites assumées

| Acquis | Non-régression fonctionnelle exigée |
|---|---|
| 0.16.1 : fin du chef figé | Seuls prompt utilisateur réel/init arment l'attente ; résultat ou filet PID la terminent. Un notify/wake sourcé ne suffit pas. Le filet libère aussi les résultats retenus, sans inventer une réponse. |
| 0.17.0 : état et santé | Tri d'attention stable, seconde ligne, fraîcheur, cache pupitre, skip parked ; pas de drain automatique sur résultat synthétique. Aucun scan supplémentaire par carte. |
| 0.18.0 : panier, issues et questions | Résultats après le tour chef, questions immédiatement accessibles, anciens callbacks lisibles, question chef persistante. Synthétique ≠ erreur musicien. |
| 0.19.0 : parité Android | Snapshot, stall, PID mort, seconde ligne, limite, fraîcheur, panier/rapport/questions ; sélection stable et suivi live préservés. |
| 0.20.0 : réveil sûr | Seul le serveur décide de réveiller ; gardes de budget/génération inchangées ; aucun wake sur notify seul ; pas de faux message utilisateur ; rapport poussé naturellement intégré. |
| Vocabulaire | Cinq clés visuelles imposées ; valeurs internes conservées, correspondance explicite, badges additifs. Aucun changement du contrat JSONL/SSE. |
| Fonctions déjà disponibles | Pièces jointes, Markdown et liens, sessions, provider/outils, park/unpark, administration, téléchargements et version restent accessibles, à un niveau secondaire adapté. |

Les marqueurs de lecture n'acquittent pas les questions, les erreurs ou le travail restant. Un résultat ne devient « lu » qu'une fois réellement consulté ; les transitions de reducer associées à `/api/mark-read` ne doivent pas effacer son accès historique.

Le journal chef reconstruit actuellement peu d'activité intermédiaire : ne pas afficher « zéro outil » après rechargement. On peut consulter ses événements récents par le même détail projet ; au-delà, « activité non chargée / historique partiel ». L'UI ne promet ni archive illimitée, ni suppression/réordonnancement de file, ni arrêt/retry générique, ni installation APK automatique : ces contrats ne sont pas établis par les routes cartographiées.

Les raccourcis directs et les envois normaux ont des effets différents (file contre interruption). Ils restent explicitement distingués dans les libellés, sans nouveau comportement serveur implicite. Les réglages ne sont pas confondus avec une conversation ou une simple consultation.

## 9. Changements priorisés par rapport à l'UI actuelle

Les priorités décrivent un futur travail produit ; aucune de ces modifications n'est implémentée dans cette mission.

| Priorité | Changement concret | Gain attendu / critère de réception |
|---|---|---|
| **P0-1** | Donner la largeur principale au dialogue ; remplacer scène flotte et carte chef dupliquée par un rail de pilotage secondaire | À l'ouverture, on sait à qui parler et où arrivera le rapport. Le chef reste central avec 28 musiciens configurés. |
| **P0-2** | Unifier tous les accès au détail musicien, retour avec ancre/brouillon, annuaire permanent incluant parkés | Depuis n'importe quel résultat, question, alerte ou nom, on voit contenu/outils/résultat puis retrouve exactement sa lecture. |
| **P0-3** | Présenter panier → rapport lié comme une continuité ; conserver les règles 0.18–0.20 | Deux résultats dont un échec produisent un panier et une réponse chef avec « prend en compte », sans prompt wake visible ni duplications. |
| **P0-4** | Réponse aux questions via le chef par défaut ; rendre le direct existant explicite | L'utilisateur arbitre dans un seul dialogue. Le simple clic sur une question ne contourne plus silencieusement le chef. |
| **P0-5** | Donner à Android la même racine, feuille de pilotage, détail et retour ; regrouper l'activité chef | On peut lire un rapport et rédiger sans être déplacé par le flux ou des onglets qui bougent. |
| **P0-6** | Stabiliser le contrat d'affichage des états, santé et fraîcheur, bandeau Attention | Aucune confusion entre input/attend le chef, tour fini/mission résolue, silence/déconnexion ou PID inconnu/mort. |
| **P1-1** | Appliquer la même divulgation progressive et les mêmes libellés à toutes les surfaces ; améliorer clavier/TalkBack et grandes polices | Aucun détail disponible perdu ; parcours sans survol, ordre de focus et retour prévisibles. |
| **P1-2** | Rendre les trous de flux et limites d'historique explicites ; réconcilier au retour/rechargement | Résultats et questions restent retrouvables ; une fenêtre partielle n'est pas présentée comme l'intégralité du journal. |
| **P1-3** | Ranger administration/sessions et livrables derrière des accès secondaires cohérents | Toutes les fonctions utiles restent accessibles sans concurrencer le dialogue. |
| **P2, dépendances serveur distinctes** | Si nécessaire : exposer état réel du wake et motif de report, origine durable d'un rapport, références stables de tours/résultats, historique paginé | Permettrait attente vérifiable, liens précis après rechargement et archive. Ne bloque pas P0 ; aucun champ/API fictif dans le design nominal. |

### Scénarios de réception à utiliser lors d'une future implémentation

1. Trois musiciens rendent pendant un tour chef : compteur discret, réponse ininterrompue, un panier ensuite ; le rapport suivant cite les résultats reçus à son démarrage.
2. A réussit, B échoue, C continue : rapport partiel explicite et C encore visible ; pas de succès global artificiel.
3. Question musicien pendant un rapport : encart/action accessibles immédiatement ; réponse nommée au chef, contexte conservé, aucun direct implicite.
4. `awaitingChef` : badge clair sans sollicitation utilisateur ; reprise observée retire le badge, sans effacer la question passée.
5. Notify intermédiaire puis vrai résultat : l'information ne démarre pas le chef et ne prouve pas une fin ; seul le résultat attendu peut programmer le wake.
6. PID vivant silencieux, PID mort, PID inconnu et données anciennes : quatre présentations distinctes ; aucune mutation de l'état brut pour fabriquer l'alerte.
7. Wake différé, quota, résultat synthétique ou absence de callback : pas de compte à rebours mensonger ; résultats accessibles et demande de point possible.
8. Rechargement / retour Android après absence : questions, paniers et rapports reconstruits, wake invisible, versions distinctes, contenu partiel signalé si nécessaire.
9. Ouverture d'un musicien parké depuis la recherche : journal récent consultable, santé indiquée non suivie ; aucune remise en activité automatique.
10. Ouvrir un résultat, lire un outil long, recevoir un rapport puis revenir : texte, scroll, focus et brouillon conservés ; aucune interruption ou dispatch causé par la navigation.

**Périmètre livré : ce design et ses maquettes textuelles uniquement.** Aucun code implémenté, aucun build exécuté, aucun service redémarré, aucun push.
