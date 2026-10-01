# Analyse ‘LE CHEF RÉPOND’ figé / trou de callback — OpenAI GPT-6 Astra — 2026-09-18

Analyse en lecture seule du code présent dans `I:\orchestrateur`, version déclarée 0.16.0. Aucun correctif, redémarrage du serveur 7777, bump ou commit. Seul fichier créé : ce rapport. L’envoi final par `notify.mjs --stdin`, explicitement demandé, entraîne naturellement les écritures de notification du serveur. Le dépôt comportait déjà de nombreuses modifications ; les références ci-dessous désignent le code de travail, sans présumer qu’il correspond exactement au processus serveur chargé en mémoire.

## Diagnostic principal

**Oui, un chemin de callback est fautif : le callback manuel `notify.mjs` est enregistré comme un début de tour, alors qu’aucun tour du chef n’est lancé.** Deux états indépendants restent alors ouverts : les reducers passent à `live`, et surtout le client met `_awaitingConductorResponse = true`, directement responsable du texte « le chef répond ». Seul un `result` ultérieur efface ce drapeau. Ce défaut est prouvé dans le code, reproduit en mémoire avec les fonctions réelles, et compatible avec plusieurs séquences concrètes du log.

La correction v0.14.3 a supprimé le faux dispatch du callback **automatique** `autoNotifyConductor`. Elle n’a pas converti le callback **manuel** `/api/notify`, ni corrigé l’activation inconditionnelle du drapeau client. Une bulle correctement attribuée au musicien peut donc toujours déclencher une fausse attente du chef.

Trois hypothèses initiales doivent être corrigées :

- `system/task_started`, `rate_limit_event` et `stream_event` **ne repromouvent pas directement** les reducers examinés. `user_prompt`, `system/init` et `assistant` le font ; les autres événements peuvent laisser cet état inchangé ou fausser la mesure du silence.
- Le relevé actuel contient un `result` final réussi. Le constat « dernier result à environ 428 événements de la fin » était un instantané antérieur ; il ne suffit pas à distinguer un tour encore en cours d’une queue réellement orpheline.
- Le quota observé est `status: allowed`, utilisation 5 h de 73 %. `overageDisabledReason: out_of_credits` décrit ici l’indisponibilité du dépassement payant, pas une fenêtre principale déjà épuisée.

## Preuves dans les logs et limites du constat

Lecture séquentielle bornée à la taille initiale de `logs/chef.jsonl`, relevé achevé le **2026-09-18 à 06:34:42 UTC** (09:34:42 à Jérusalem). Fichier : 331 214 271 octets, 601 724 lignes physiques. Dernier `result/success` : **`logs/chef.jsonl:601724`**, sans événement ultérieur dans cet instantané ; dernier texte assistant horodaté : `logs/chef.jsonl:601720`, 06:33:49.594 UTC. `chef.session` existe ; **`chef.pid` est absent** lors de ce relevé. Les logs continuent à évoluer pendant l’analyse.

Les séquences suivantes montrent le défaut sans supposer un quota épuisé :

| Séquence | Preuves | Conséquence pour un dashboard connecté |
|---|---|---|
| Fin normale, puis callback vuBox, puis prochain vrai prompt presque 58 min plus tard | `logs/chef.jsonl:595771` : `result/success` ; `:595773` : `user_prompt`, `source=vuBox`, 03:56:25.433 UTC ; `:595777` : prompt sans source, 04:54:16.213 UTC | Le callback rouvre l’état sans activité de génération du chef dans cet intervalle. L’attente ne peut se fermer que plus tard. |
| Même motif BookHaven, environ 36 min | `logs/chef.jsonl:597363` : `result/success` ; `:597365` : callback, 05:28:07.198 UTC ; `:597373` : prochain prompt sans source, 06:04:09.006 UTC | La fin du musicien ne garantit aucune réponse du chef. |
| Callback manuel puis notification automatique | `logs/chef.jsonl:598911` : `result/success` ; `:598913` : callback BookHaven, 06:19:40.896 UTC ; `:598915` : `notification/musician_done`, 06:20:00.815 UTC ; `:598917` : prochain prompt sans source, 06:24:36.584 UTC | Le premier événement ouvre une fausse attente ; la notification suivante ne la ferme pas. |

Ces preuves concernent l’activité enregistrée du chef. Elles ne démontrent pas rétrospectivement l’absence de toute activité de tous les musiciens, ni l’état exact du navigateur de l’utilisateur au moment du symptôme.

**La nature exclusivement interactive du chef n’est pas confirmée.** Le chemin dashboard `/api/dispatch` lance `dispatch.mjs` pour le projet sélectionné, chef compris (`server.js:2773`, `server.js:3180`). Ce script utilise `--print`, `--output-format stream-json` et éventuellement `--resume` (`scripts/dispatch.mjs:1066-1079`), écrit le prompt (`:628-631`), puis la sortie du processus (`:1241-1243`). L’instrumentation atteste sept dispatchs chef réussis ce matin, avec PID et code de sortie 0 : `logs/instrumentation-2026-09-18.ndjson:1`, `:2`, `:4`, `:8`, `:10`, `:11`, `:12`. Le dernier couvre 06:29:58–06:33:50 UTC. Un nouveau `user_prompt` puis `system/init` apparaissent bien à `logs/chef.jsonl:600139-600140`, après le résultat précédent `:600137`.

Le terminal central interactif est un autre chemin : `server.js:3599` lance `claude.exe` via PTY et sa sortie va dans **`central.log`**, via `server.js:3614-3619`. Un `.session` persistant prouve une session réutilisable, pas un processus interactif actif. Il faut distinguer session, processus et tour dans la future logique.

## Flux de callback : point exact de rupture

1. `scripts/notify.mjs:59-62` lit stdin. `:81-91` envoie `{project, text, source}` à `POST http://127.0.0.1:7777/api/notify`.
2. `server.js:2745-2768` valide puis **append un `type: user_prompt` avec `source`** (`:2755-2761`) dans le log cible. Il envoie éventuellement un toast, puis répond OK. **Aucun dispatch, aucune injection dans le PTY, aucun accusé de lecture par le modèle, aucun `result` chef attendu sur ce chemin.** « Callback livré » signifie ici stocké pour affichage, pas pris en charge par le chef.
3. Le watcher de fond appelle `reduceMusician` (`server.js:3721-3722`). Un `user_prompt`, quelle que soit sa source, transforme `idle/unread` en `live` (`:2058-2059`). L’hydratation fait pareil (`:1458-1459`).
4. Le SSE appelle d’abord `Musician.transition`, puis `App.onConductorEvent` (`public/app.js:822`, `:836`). Le premier passe à `live` (`:143-146`). Le second reconnaît pourtant le callback et crée une bulle `role: callback` (`:1897-1903`), **puis active sans distinction `_awaitingConductorResponse = true` (`:1910-1911`)**. Même un callback dédupliqué passe par cette activation.
5. Le texte « le chef répond » dépend de ce drapeau, **pas de `state === live`** (`public/app.js:1580-1595`). Il n’est remis à false que par `result` (`:1947-1949`), outre sa valeur initiale false (`:885-889`). Aucun timeout ne le ferme.

Le callback automatique, lui, écrit `notification/musician_done` (`server.js:2724-2726`), puis retourne sans relancer le chef (`:2733-2742`). Sa branche client revient avant toute activation du drapeau (`public/app.js:1865-1876`). C’est bien le périmètre du fix v0.14.3 (`CHANGELOG.md:63-68`), distinct du reclassement visuel v0.14.1 (`:76-83`).

**Autre déclencheur certain de la même famille :** le raccourci `@musicien` écrit dans le log chef un `user_prompt` avec `source: shortcut→...` pour simple visibilité (`server.js:3069-3081`), puis dispatche le musicien (`:3096`). Il peut donc faire attendre une réponse chef qui n’a jamais été demandée.

Si le produit attend une synthèse automatique, il manque un protocole explicite de prise en charge : notification reçue → synthèse planifiée → tour réellement démarré → terminé/échoué. Le callback actuel assure l’affichage et le toast, pas ce traitement. Réintroduire un faux prompt utilisateur systématique recréerait le défaut corrigé en v0.14.3.

## Reducers, interruptions et perte de clôture

| Événement après un `result` | État serveur/client de la carte | Drapeau « répond » |
|---|---|---|
| `user_prompt`, y compris avec `source` | `idle/unread → live` | true si texte non vide |
| `system/init` | `idle/unread → live` | Inchangé |
| `assistant` texte ou outils | `live`, même sans tour identifié | Inchangé |
| `assistant` thinking sans outil | `think` | Inchangé |
| `system/task_started`, `rate_limit_event`, notification | Inchangé | Inchangé |
| `stream_event`, y compris `message_stop` | Inchangé ; activité client rafraîchie | Inchangé |
| `result` | `idle/unread/input/error` selon contenu ; erreur synthétique → idle | false |

Références : `server.js:1458-1485`, `server.js:2052-2082`, `public/app.js:138-234`, `public/app.js:1878-1949`. Le reducer pupitre constitue une copie supplémentaire (`scripts/fleet-status-core.mjs:69-109`) ; il présente déjà une divergence : un prompt peut sortir de `input` (`:87`), contrairement aux deux reducers serveur précédents.

Un assistant tardif peut donc rouvrir un tour terminé ; des deltas seuls ne le font pas, mais ne ferment jamais un tour déjà ouvert. Les événements ne portent pas de contrat de tour exploité par ces reducers : aucun contrôle d’appartenance, aucun filtre des sorties d’un ancien processus, aucune clôture implicite. Supprimer arbitrairement tous les assistants après `result` serait incorrect : le début d’un vrai tour peut avoir été perdu par le transport ou exclu de la fenêtre de lecture.

**Interruption : chemin possible, pas cause établie de l’épisode relevé.** Le nouveau prompt tue l’arbre du PID existant (`server.js:3153-3172`, `killDispatchTree` à `:2991-3000`) et lance le suivant. Ce chemin ne journalise pas de clôture terminale de l’ancien tour. Le dispatch Claude relaie les octets reçus ; lors d’une sortie/signal il supprime le PID (`scripts/dispatch.mjs:1284`) puis ferme le log (`:1349-1354`), sans fabriquer de `result` manquant. Une interruption, un crash ou un échec du nouveau lancement peuvent donc laisser des événements non clôturés. Une sortie d’ancien processus peut également arriver autour du démarrage du suivant, sans `turnId` pour les séparer.

Le handler commun est déclenché par `exit` ou `close` (`scripts/dispatch.mjs:1266-1275`, `:1357-1358`). Sa clôture au premier signal de cycle de vie, et le drain limité à 256 lignes par appel (`:1205`), méritent un contrôle spécifique de fin de stdout : le flush du fichier ne garantit pas à lui seul que toutes les données du pipe ont déjà été reçues. C’est un risque de code, pas une perte du dernier `result` démontrée ici.

**Trou de transport supplémentaire :** à la reconnexion SSE le client recharge uniquement l’historique de chat (`public/app.js:802-810`, `:1080-1111`), sans réconcilier le drapeau d’attente ni l’état des cartes. Un `result` manqué pendant une déconnexion peut donc laisser « répond » affiché alors que le fichier est terminé. Le flux démarre à EOF (`server.js:2113-2116`) et saute jusqu’à EOF si la croissance dépasse 4 Mio (`:2128-2152`), pouvant aussi perdre un résultat. Aucun traitement réparateur des notices `log_growth_skipped` / `oversized_line_skipped` n’a été trouvé dans le client.

## Auto-guérison : ce qui existe et ce qui manque

`healOrphanedLogs()` est appelé **une seule fois au démarrage** (`server.js:460-500`). Il écrit un résultat synthétique si le dernier événement non partiel n’est pas un résultat, sauf si le PID est vivant, ou si le PID est absent et le fichier a moins de 60 s (`:476-494`). Le commentaire « gate alone never healed it » (`:469`) décrit la réparation ajoutée pour un PID mort après redémarrage ; ce n’est pas un superviseur périodique.

Limites : aucune guérison après un crash survenu serveur déjà démarré ; fichier trop récent au boot jamais réexaminé par cette fonction ; PID vivant considéré comme preuve suffisante ; callback récent confondu avec progrès ; `lastNonPartialType` ignore les deltas et peut trouver un ancien `result` derrière des deltas orphelins (`server.js:430-437`). À l’inverse, une notification après un résultat peut être prise pour une queue orpheline. Le test porte sur le dernier type, pas sur un tour ouvert identifié.

Le pupitre **signale**, sans fermer : `stalled = inFlight && silentMs >= 60_000`, `deadInFlight` séparé (`scripts/fleet-status-core.mjs:189-206`). Le silence vient du dernier événement non partiel horodaté, sinon du mtime. Les notifications peuvent donc rajeunir le silence ; les deltas peuvent aussi être mal représentés. Le client rafraîchit `lastActivityMs` pour tout événement (`public/app.js:122-125`). Ces indicateurs ne sont pas une preuve fiable de progression du modèle.

**Mécanisme recommandé :**

1. Distinguer les événements de contexte/callback des événements de cycle de vie. Donner à chaque dispatch un `turnId`, un propriétaire de processus (PID + identité de démarrage), `startedAt`, `lastProgressAt` et une clôture idempotente. Une session interactive conserve son identité entre plusieurs tours ; son PID vivant ne suffit jamais à afficher « répond ».
2. Unifier la réduction entre hydratation, watcher, pupitre et client. Un événement de notification ne démarre ni tour, ni animation. Les anciens callbacks doivent être normalisés lors de la lecture, sans réécrire les archives. Ne pas ignorer aveuglément tout `source` : `dispatch.mjs:630` peut aussi l’ajouter à un vrai dispatch ; utiliser un type/intention explicite et la présence d’un démarrage réel.
3. Journaliser `turn_finished`, `turn_interrupted`, `turn_failed` ou `turn_limited` à la fin effective du producteur, après drainage de stdout. Un nouveau tour ferme explicitement le précédent comme interrompu ; ses événements tardifs n’affectent plus l’état courant. Ne pas fabriquer une réponse réussie ni des coûts/tokens pour cette clôture.
4. Ajouter un contrôle périodique, par exemple toutes les 10 s : **tour ouvert + aucun progrès depuis 60–120 s + absence confirmée de producteur actif pour ce tour → clôture interrompue et état idle** (en conservant séparément les messages non lus). Vérifier la course de démarrage et la propriété du PID avant fermeture. Une simple absence du sidecar ou un PID recyclé ne constitue pas une preuve suffisante.
5. Avec un producteur encore vivant mais silencieux, afficher « sans progrès / vérification » après le seuil, sans animation « répond » ; ne pas annoncer une fin ni tuer automatiquement un outil long. Un heartbeat/lease du superviseur doit distinguer outil actif, attente externe, quota bloquant et processus réellement perdu. Le timeout seul ne peut garantir ces distinctions.
6. Réconcilier un snapshot autoritatif à chaque reconnexion et notice de perte SSE, puis périodiquement. Le drapeau d’attente doit dériver du tour courant ; un résultat passé ou un état terminal ferme aussi les réflexions restées ouvertes. Préserver unread indépendamment de l’activité.

`message_stop` clôt un message du flux, pas nécessairement tout le travail du tour : la fermeture implicite doit tenir compte de `stop_reason`, des outils en cours et du producteur. Un `tool_use` suivi de `message_stop` doit rester actif. Un `end_turn` corrélé suivi de la fin du producteur peut justifier la clôture en l’absence de `result`, avec une provenance explicite.

## Quota 5 h et out_of_credits

Dernier événement observé : `logs/chef.jsonl:601354` : `status=allowed`, `rateLimitType=five_hour`, `unifiedWindows.five_hour.utilization=0.73`, `overageStatus=rejected`, `overageDisabledReason=out_of_credits`, `isUsingOverage=false`. Reset indiqué : `1789714800`, soit **2026-09-18 07:00 UTC / 10:00 Jérusalem**. Un résultat réussi survient ensuite (`:601724`). **Aucune preuve d’épuisement bloquant dans ce relevé.**

Les reducers n’exploitent pas `rate_limit_event`. Le dispatch détecte plutôt des phrases d’épuisement (`scripts/dispatch.mjs:233-251`) dans des résultats, erreurs ou textes assistant (`:1216-1235`), puis exige aussi un échec (`:1279-1280`). En mode sans failover, il écrit `system/limited-no-failover` et sort (`:1321-1325`), sans garantir une clôture si aucun résultat n’avait été reçu. Ce système ne constitue pas une gestion structurée de l’état quota du dashboard.

Recommandation : séparer **activité du tour** et **disponibilité du fournisseur**. Pour `allowed` avec dépassement désactivé : conserver l’état réel, éventuellement badge « dépassement indisponible ». Pour un rejet bloquant confirmé et aucune opération encore active : fermer le tour comme limité, afficher `idle` avec badge « limité jusqu’à … », et conserver l’explication dans l’historique. Si l’heure de reset est inconnue, l’indiquer sans inventer d’échéance. Après reset, revalider la disponibilité ; ne pas relancer automatiquement une action à effets de bord. Si un failover autorisé démarre réellement, afficher son fournisseur et son vrai tour actif. Ne pas confondre une limite 5 h avec une éventuelle limite 7 jours.

## Taille, lectures et rotation sûre

| Fichier | Octets observés | Taille décimale approximative |
|---|---:|---:|
| `logs/chef.jsonl` | 331 214 271 | 331,2 Mo |
| `logs/vuBox.jsonl` | 238 928 249 | 238,9 Mo |
| `logs/orchestrateur.jsonl` | 170 406 431 | 170,4 Mo |
| `logs/panierIL.jsonl` | 143 798 212 | 143,8 Mo |

L’accumulation est confirmée ; aucun mécanisme de rotation de ces JSONL n’a été trouvé dans les chemins examinés. **En revanche, l’hydratation normale ne parse pas 330 Mo :** `scanProjectState` lit au plus 256 Kio (`server.js:1434-1443`) ; le pupitre fait pareil (`scripts/fleet-status-core.mjs:26-36`) ; les historiques événements/chat lisent au plus 2 Mio (`server.js:1899`, `:1996`) ; le warm-up du watcher lit 32 Kio (`:3752`). Un appel isolé de la fonction réelle `scanProjectState('chef')`, avec marqueur de lecture neutralisé, a donné `unread` en environ 4,3 ms. Ce n’est pas une mesure de latence du serveur chargé.

Risques résiduels précis :

- `/sse/logs/:project` commence à offset zéro et alloue la taille entière à la première connexion (`server.js:3524`, `:3536-3551`). Une connexion chef peut donc lire 331 Mo de façon synchrone, puis les convertir/émettre. Le dashboard principal utilise le SSE agrégé (`public/app.js:801`) ; l’ancienne route n’est pas sa lecture normale.
- Le watcher de fond alloue toute la croissance depuis son dernier passage, sans plafond (`server.js:3710-3716`). Un gros append peut encore bloquer ou consommer beaucoup de mémoire, indépendamment de la taille totale déjà accumulée.
- Le SSE agrégé limite les lectures, mais perd les événements d’une croissance supérieure à 4 Mio au lieu de les drainer par blocs. Cette protection mémoire peut donc créer un trou de clôture côté client.
- Les fenêtres de 32/256 Kio peuvent exclure le début ou la fin pertinente d’un tour. Un état reconstruit depuis une queue arbitraire n’est pas un checkpoint fiable. Plusieurs lecteurs retirent aussi systématiquement la première ligne même si tout le petit fichier a été lu (`server.js:1446`, `scripts/fleet-status-core.mjs:40`) : à corriger avant de s’appuyer sur de petits segments neufs.

**Rotation proposée, sans opération effectuée :** segments archivés immuables, par exemple à 32–64 Mio ou quotidiennement, plus un journal actif et un checkpoint durable contenant génération, offset/numéro de séquence, tour actif/terminé, dernier progrès, état quota et marqueurs de lecture. La taille et la rétention restent des paramètres produit.

La bascule doit être coordonnée avec **tous** les auteurs (`dispatch`, notifications, réparation) : fermer/vider les handles, verrouiller brièvement la bascule, publier le checkpoint et le nouveau segment de manière récupérable après crash, puis reprendre les append. Privilégier une frontière de tour ; si un tour doit traverser deux segments, conserver son identifiant. Ne pas tronquer ni renommer à chaud sous un `WriteStream` ouvert (`scripts/dispatch.mjs:596`) sans protocole de réouverture, particulièrement sous Windows.

Les trois familles de tailers doivent suivre une génération et un offset : leurs seuls tests `size < offset` (`server.js:2133`, `:3708`, `:3534`) ne détectent pas correctement toutes les substitutions/régénérations. Rejouer après le checkpoint, sans redéclencher notifications et queues déjà consommées. Prévoir des identifiants d’événements et un curseur SSE pour la reprise.

L’historique visible doit pouvoir parcourir les archives par pagination et reconstituer les derniers messages au-delà d’un segment neuf. Conserver les sidecars `.session`/`.read` et l’association aux tours. Compresser les archives après fermeture et validation ; une troncature sans archive ferait perdre l’historique. Borne de mémoire nécessaire aussi pour chaque lecture incrémentale, en traitant les lignes complètes et les UTF-8 partiels ; les très gros résultats d’outil peuvent être stockés comme pièces jointes référencées.

## Plan de correction priorisé — impact × effort

| Priorité | Correction proposée | Impact | Effort |
|---|---|---|---|
| P0 | Convertir `/api/notify` en notification explicite ; corriger `_awaitingConductorResponse` et les reducers ; traiter également le raccourci `@` et les anciens callbacks à la lecture | Supprime le déclencheur confirmé, même flotte inactive | Faible à moyen |
| P0 | Réconciliation autoritative après reconnexion/perte SSE ; dériver l’indicateur du tour réel | Répare l’affichage même si le `result` existe mais a été manqué | Moyen |
| P1 | Clôture garantie par le producteur + identifiant de tour + superviseur périodique, erreurs/interruption incluses | Supprime les queues orphelines et évite les faux signaux de vie | Moyen à élevé |
| P1 | Gestion structurée du quota et de `limited-no-failover`, badge séparé de l’activité | Empêche de simuler une réponse lorsque le fournisseur est bloqué | Moyen |
| P1 | Borne de lecture du watcher/ancienne route SSE ; drainage paginé au lieu du saut à EOF | Réduit gel/OOM et perte de clôture sous gros append | Moyen |
| P2 | Checkpoint commun, segmentation/archives et pagination d’historique | Maîtrise la croissance sans casser état, historique ou reprise | Élevé |

Vérifications d’acceptation recommandées : callback reçu après résultat sans nouveau tour ; callback pendant un vrai tour sans fermer ce dernier ; doublon de callback ; raccourci `@` ; ancien assistant tardif ; interruption puis échec de lancement ; PID absent/mort/recyclé ; outil long vivant ; `allowed + out_of_credits` versus rejet effectif ; reconnexion avec résultat manqué ; burst supérieur à 4 Mio contenant un résultat ; rotation au repos et reprise après crash sans notification dupliquée.

**Vérification réalisée pour cette analyse :** extraction des fonctions réelles dans une VM Node en mémoire, sans importer/exécuter le serveur. `reduceMusician`, `Musician.transition` et `onConductorEvent` ont été rejoués : callback → `live/live/awaiting=true` ; notification seule → `unread/unread/false` ; task_started/quota/delta seuls → état inchangé ; assistant seul → `live` mais pas d’activation du drapeau. Une seconde vérification avec assertions confirme que les événements auxiliaires et `message_stop` ne ferment pas l’attente ouverte par un callback, puis qu’un résultat synthétique ferme l’état et le drapeau. Aucun fichier de test créé, aucun dispatch ni incident injecté en production.

Le callback final demandé empruntera lui-même le chemin défectueux tant qu’il n’est pas corrigé : sa livraison ne doit pas être interprétée comme une reprise réelle du chef. Aucun correctif ni commit n’a été effectué dans cette analyse.
