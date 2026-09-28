# Tous les projets, en un coup d’œil — proposition indépendante GPT-6 Astra

Étude du 28 septembre 2026. Demande : « Orchestrateur, web interface : je veux voir en un coup d'œil le statut de chacun des projets. » Document de conception uniquement ; aucune implémentation. Les autres propositions de `docs/dashboard-status/` n’ont pas été consultées.

## 1. Proposition

Ajouter à l’interface principale une vue **Projets**, pleine largeur, accessible à côté de **Conversation** et sélectionnée à la première visite. Mémoriser ensuite le choix de l’utilisateur. Cette vue présente une liste compacte de tous les projets, groupée par besoin d’attention, avec une seule ligne logique par projet. Le panneau existant s’ouvre au clic.

Le premier regard doit répondre à trois questions : **qui a besoin de moi, qui travaille, qu’attendent les autres ?** Le second donne la dernière activité et les livrables. Modèles, coûts et sessions restent visibles à la demande ou dans un mode de densité enrichie ; ils ne doivent pas repousser la question ouverte hors écran.

« Tous » signifie aucune exclusion implicite, aucune pagination et aucun groupe fermé au premier affichage, y compris les parqués. Cela ne signifie pas faire tenir 32 lignes et leur contexte dans un écran de téléphone : une seule surface défilante permet de les parcourir, avec les compteurs toujours visibles.

## 2. Ce qui existe réellement

Analyse des sources applicatives, des règles de `CLAUDE.md`, de la configuration et lecture authentifiée de `/api/pupitre`. Aucun dispatch, changement de configuration ni acquittement n’a été effectué pour cette étude.

| Source examinée | Constat et conséquence |
|---|---|
| `public/index.html`, `public/salle.js`, `public/salle.css` | L’accueil est une salle de direction : conversation principale, rail Pilotage secondaire, bande d’attention repliée, recherche globale, panneau musicien `#/m/<nom>`. Le rail présente **En cours avant À examiner** ; « Tous les musiciens » et « Mis de côté » sont fermés par défaut. « Tous » répète aussi les projets déjà présents dans les autres groupes. Sur mobile, le rail devient une feuille ouverte depuis une ligne de synthèse. |
| `public/app.js` | Un `EventSource('/api/sse/fleet')` transporte l’activité. Les états, la lecture des résultats, la conversation et les callbacks ont déjà leurs traitements. La flotte est rafraîchie par `/api/pupitre` toutes les 5 s lorsque visible ; un mécanisme ciblé utilise aussi 2,5 s, avec des indications SSE temporisées à 400 ms. La nouvelle vue doit partager ce transport et remplacer les cadences concurrentes. |
| `server.js`, page `/pupitre`, `public/pupitre-row.js` | Tableau de santé déjà disponible dans le menu : état, nom, activité, durée du tour, silence, PID et provider/modèle ; tiroir de détail. Bon socle sémantique, mais pas une vue des livrables, des coûts récents et des files. Son classement place les stalls avant les erreurs puis les questions. |
| `/api/pupitre` et `scripts/fleet-status-core.mjs` | Retourne `now`, `conductor`, `fleet`, `pool`, `limitedUntil`, `noFailover`. Une ligne contient notamment `state`, `awaitingChef`, `stalled`, `deadInFlight`, `activity`, `lastKind`, `silentMs`, `fileSilentMs`, `turnElapsedMs`, `pidAlive`, `model`, `provider`, `needsInput`, `questionResolved`, `queueDepth`, `parked`. Lecture bornée à 256 Kio de fin de log ; cache serveur de 2,5 s invalidé par mtime/taille. |
| Configuration et réponse API au moment de l’étude | **32 entrées : 31 projets musiciens et le chef ; 13 parquées.** Le serveur inclut bien ces 32 entrées, mais remplace le scan des parqués par `{name, state: 'idle'}`. Ce `idle` ne prouve donc pas leur repos. Le rail dit déjà « santé non suivie ». |
| `/api/config`, `/api/sessions`, routes de sessions par projet | Configuration, `readAt`, `unreadCount`, `attachedSession` et marqueurs de lecture existent. Les sidecars de session sont la persistance, la Map serveur un cache. La présence d’une session ne prouve pas qu’un tour tourne. |
| Files de `server.js` | `dispatchQueue` est la source en mémoire, persistée sous `logs/queue/`. `/api/queue/:project` donne le détail avec identifiant, date et aperçu. La file des musiciens est distincte de `pool.queue`, la file de direction. Les files peuvent être drainées après une question : question et tâches en file ne sont pas mutuellement exclusives. |
| Questions et callbacks | `notification/question_resolved` acquitte une question sans relancer le musicien ; les résultats fantômes sont ignorés par `isPhantomResult`. Les notifications et `user_prompt` avec `source` peuvent être de simples messages de coordination, sans nouveau tour. `awaitingChef` différencie une décision demandée au chef d’un résultat terminé. |
| `downloads.json`, `scripts/downloads-registry.mjs`, `scripts/copy-build.mjs`, `builds/` | Le registre lit des versions dans des fichiers déclarés et vérifie `latest.apk`. La copie publie un APK horodaté et `latest.apk`, sans manifeste liant l’artefact à une version. Les ensembles ne coïncident pas : des applications du registre ne sont pas des projets configurés, et certains dossiers de builds n’ont pas d’entrée applicative. La liste des projets doit partir de `config.projects`. |
| Coûts actuels | `result.total_cost_usd` et les callbacks `cost_usd` servent déjà aux résultats du fil et du panneau. Le client a aussi des accumulateurs dépendant des événements reçus. `/api/pupitre` ne fournit aucun coût, et aucun agrégat serveur fiable sur 24 h n’a été identifié dans les sources examinées. |

L’état observé est celui du **travail de l’agent**, pas la disponibilité de l’application développée. « Au repos » ne signifie ni application arrêtée, ni projet terminé, ni dernière compilation réussie.

## 3. Informations et règles d’affichage

### Priorités par projet

| Priorité | Information | Présentation |
|---|---|---|
| P0, toujours | Nom complet identifiable et état explicite | Nom ouvrant le panneau ; pictogramme + libellé, jamais une pastille seule. Badge « Parqué » indépendant. |
| P0, toujours | Ce qu’il fait ou attend | Une ligne issue de données constatées : question ouverte, cause d’échec, attente identifiée, outil en cours ou dernier résultat. Pas de résumé généré par un autre modèle. |
| P0, toujours | Dernière activité et fraîcheur | « il y a 20 s », « 2 j », ou « jamais observée ». Si l’horodatage est approximatif, « ~ 4 min ». Une date absolue est accessible au focus et dans le panneau. |
| P0, si pertinent | Question, file, stall | La question remplace l’aperçu normal ; badge « File 2 », même si le projet travaille ou pose une question. Silence suspect : « ! Sans progrès depuis 2 min », accompagné de la dernière action. |
| P1, desktop | Version et dernier artefact disponible | Colonne Livrable : « Code v2.4 · APK disponible, copié il y a 3 h ». Les deux versions ne sont unifiées que si un manifeste les relie. |
| P1, affichage enrichi | Modèle/provider et coût récent | Modèle du tour courant, sinon « dernier : … » ; repli configuré explicitement marqué « prévu ». Coût libellé selon sa portée, avec date et couverture. |
| P2, panneau | Session, durée, détail de file, callback, PID | Présence de session et identifiant abrégé, dernière sortie, destinataire de coordination, détails d’erreur et de build. Pas d’UUID ni de PID dans la vue normale. |

L’aperçu choisit, dans cet ordre, la question utilisateur ouverte, l’erreur ou l’anomalie, la décision attendue du chef, la raison connue d’attente de file, l’action réelle en cours, puis le dernier résultat. En cas d’erreur et de question concomitantes, le badge signale l’erreur et le texte conserve la question. La troncature visuelle ouvre sur le texte complet au clic ; le téléphone peut utiliser deux lignes pour une question.

Ne pas exposer automatiquement la commande brute d’un outil comme résumé : préférer « Bash · exécution en cours », « Read · app.js », ou le texte d’activité déjà disponible, nettoyé et borné. Les arguments peuvent contenir des secrets ; le journal détaillé reste dans le panneau authentifié.

### État du moteur et état présenté

Conserver les chaînes existantes `idle | live | think | input | unread | error`. Attente, stall, lecture et parking sont des propriétés complémentaires, pas de nouvelles valeurs injectées dans les réducteurs.

| Preuve disponible | Affichage principal | Groupe |
|---|---|---|
| `deadInFlight === true` | ✕ Processus perdu | À votre attention |
| `state === 'error'` | ✕ Échec, avec cause | À votre attention |
| Question utilisateur encore ouverte | ? Votre réponse attendue | À votre attention |
| `stalled` sans processus confirmé mort | ! Sans progrès — à vérifier | À votre attention |
| `live` ou `think`, sans anomalie | ▶ En cours / ◐ Réflexion | Actifs et en attente |
| `awaitingChef` | ⇄ Attend le chef | Actifs et en attente |
| File non vide sans tour en cours | ⏳ En file ; raison si connue | Actifs et en attente |
| `unread`, sans attente du chef | ✓ Résultat disponible ; badge « Non lu » selon le marqueur de lecture | Au repos |
| `idle`, aucune attente | ○ Au repos ; « Jamais lancé » seulement si absence prouvée d’historique | Au repos |
| `parked`, sans activité ni alerte | ▫ Parqué ; dernière activité connue | Parqués |
| Données absentes, périmées ou parqué non scanné | — État inconnu / dernier état connu, daté | Groupe conservé si connu ; sinon Au repos avec sous-libellé « état à vérifier » |

Le moteur actuel signale un stall après **60 s sans événement non partiel** pendant `live/think`. C’est une suspicion : une compilation silencieuse peut continuer. Conserver ce seuil partagé dans la première version, afficher la dernière action et le temps de silence, sans tuer ni relancer automatiquement. Un PID inconnu n’est pas un PID mort. `fileSilentMs` et `silentMs` ne sont pas interchangeables ; les deltas de texte et les callbacks ne doivent pas masquer une absence de progrès du tour.

**Questions.** Un acquittement retire la question du regroupement dès son événement SSE, y compris après rechargement. Ouvrir le panneau ou marquer un résultat lu ne résout pas une question. Une nouvelle question doit avoir une identité liée au tour ou à l’événement, pas uniquement à son texte. Un nouveau tour ne doit pas ressusciter une question ancienne.

**Résultats non lus.** `deriveState` du cœur de santé ne consomme pas le marqueur `.read` : son `unread` ne suffit pas à établir un vrai non-lu. La projection doit rapprocher le résultat et `readAt`, comme le font déjà les traitements de lecture. Un ancien résultat lu reste « Résultat disponible », sans alerte.

**Parqués.** Le parking est un rangement, pas une désactivation garantie. Un parqué qui travaille ou attend une réponse doit remonter dans le groupe correspondant avec son badge Parqué. La nouvelle projection doit donc connaître son activité ; tant qu’elle ne l’a pas analysée, montrer « état non vérifié », jamais « prêt ». Ne pas le déparquer automatiquement.

**Attentes.** Séparer « votre réponse », « décision du chef », « tâches en file » et « retour externe attendu ». Cette dernière mention exige une attente structurée liée à un tour, avec ouverture et clôture ; le simple texte d’un callback ou `--callback chef` ne prouve pas qu’un build détaché reste actif. En première version, les callbacks sont du contexte récent dans le panneau, sans inventer un état persistant d’attente externe.

## 4. Composition, densité et navigation

En-tête : bascule Conversation / Projets, état du flux, recherche. Bande de compteurs cliquables : « Tous 32 », « Attention 3 », « Actifs / attente 6 », « Repos 10 », « Parqués 13 ». Ces nombres sont illustratifs, sauf le total et le nombre de parqués observés ; la définition des compteurs est explicitée ci-dessous.

Une liste organisée en quatre groupes **disjoints**, dans cet ordre :

1. **À votre attention** : processus perdu, échec, question utilisateur, silence suspect ; cet ordre fixe à l’intérieur, puis nom. Les décisions attendues du chef ne deviennent pas des demandes utilisateur sans escalade explicite.
2. **Actifs et en attente** : tours en cours, décisions du chef, files à démarrer ; tri stable par catégorie puis nom.
3. **Au repos** : résultats récents disponibles avant les projets au repos, puis nom. Les états non déterminés sont libellés comme tels, avec un sous-compteur « à vérifier » ; ils ne sont pas comptés comme repos confirmé.
4. **Parqués** : tous ceux sans activité ou alerte prioritaire, ordre alphabétique. Groupe ouvert au départ, repli manuel possible et mémorisé.

Chaque entrée configurée apparaît exactement une fois. Inclure le chef avec le badge **CHEF** : dans cette vue, cette ligne remplace sa télémétrie détaillée de l’en-tête, pour éviter un doublon. Les slots internes du pool restent dans son panneau et n’ajoutent pas de faux projets. Les compteurs de groupes totalisent les entrées ; un filtre transversal « Parqués » compte tous les `parked`, même ceux remontés dans Attention. Si nécessaire afficher « 13 parqués, dont 1 en activité ».

**Desktop ≥ 1200 px.** Tableau de comparaison pleine largeur : Projet, État, Activité/attente, Dernière activité, File, Livrable. Lignes de 52–60 px environ, texte principal de 14 px, secondaire de 12–13 px. Une douzaine de lignes utiles sur un écran courant ; défilement vertical pour la suite. Mode « Détails » ajoutant Modèle et Coût, plutôt que neuf colonnes microscopiques par défaut. Pas de grandes cartes à logs intégrés, de géométrie en arc ni de virtualisation pour 32 éléments.

**Tablette 768–1199 px.** Même ordre de lecture ; Livrable et les métadonnées passent en sous-ligne. Garder la colonne d’activité flexible et une largeur suffisante pour l’identité des projets.

**Mobile < 768 px.** Une carte-ligne de 88–112 px : nom + badge d’état ; aperçu ; dernière activité + file. Version, build, coût et modèle dans le panneau. Aucun défilement horizontal. Compteurs sur deux lignes, recherche compacte, sections ouvertes. Cibles tactiles d’au moins 44 px. Le panneau occupe l’écran et le retour retrouve le projet et la position de défilement.

**Accessibilité.** Réutiliser les variables et polices locales du thème actuel, sans imposer un nouveau système visuel. Vert + ▶ pour le travail, ambre + ◐ pour la réflexion, orange + ? pour une question, magenta/rouge + ✕ pour l’échec, ambre + ! pour une suspicion, cyan + ✓ pour un résultat, gris lisible + ○/▫ pour repos/parking. Aucun statut porté seulement par la couleur ou une animation. Vérifier le contraste du texte dans chaque thème, notamment les gris actuels ; viser 4,5:1 pour le texte normal. Focus visible, titres de groupes, noms accessibles, état en texte. Annoncer sobrement une nouvelle question dans une zone `aria-live="polite"`, pas chaque seconde de chronomètre. Respecter la réduction des mouvements.

**Stabilité.** Appliquer les changements de libellé immédiatement, mais différer de 1,5 s les déplacements de groupe/rang, comme le rail actuel. Suspendre tout déplacement sous le pointeur, pendant un geste tactile ou tant que le focus est dans la ligne. Le compteur Attention se met tout de suite à jour. À priorité égale, le dernier token reçu ne change pas l’ordre.

**Interactions minimales.** Le nom/lien et la surface non interactive de la ligne ouvrent le panneau existant. Réutiliser les onglets Activité, Dernier résultat, Journal récent, la file et « En parler au chef ». Ajouter au panneau les métadonnées de livrable et coût. Échap/Retour ferme et restitue le focus. La navigation `#/m/<nom>` est conservée ; mémoriser l’origine Projets pour revenir au bon écran. Les filtres sont locaux : recherche par nom, groupe, « avec file », « parqués », « résultat non lu ». Afficher « 7 / 32 » et « Effacer les filtres » ; persister les préférences sans cacher silencieusement des projets à la première visite.

Les actions qui répondent, acquittent, interrompent, retirent de la file ou changent une session restent dans le panneau. Un simple clic de consultation n’en déclenche aucune. Le marquage de lecture reste cohérent avec le comportement existant, sans acquittement implicite.

## 5. Maquette textuelle

Exemple fictif de présentation, avec valeurs illustratives ; les lignes omises ci-dessous pour la brièveté seraient toutes rendues dans l’interface.

```text
ORCHESTRE     Conversation  [ PROJETS ]                ● Synchronisé
[Tous 32] [Attention 3] [Actifs / attente 6] [Repos 10] [Parqués 13]
Chercher un projet…                       [Avec file] [Détails : non]

PROJET             ÉTAT                 ACTIVITÉ / ATTENTE          DERNIÈRE   FILE  LIVRABLE
À VOTRE ATTENTION · 3
RemotePad          ✕ Échec              Tests de connexion échoués   2 min      1    Code 1.8 · APK 3 h
BookHaven          ? Votre réponse      Autorisez-vous la diffusion ? 8 min     —    Code 2.4 · APK 1 j
vuBox              ! Sans progrès      Gradle · silence 2 min        2 min      —    Code 1.3 · APK 2 j

ACTIFS ET EN ATTENTE · 6
orchestrateur      ▶ En cours           Rédige la proposition        12 s      2    Node 0.28 · Android…
TranslateOverlay   ⇄ Attend le chef     Choix de protocole à valider  4 min      —    Code 1.2 · APK 1 j
DeskZen            ⏳ En file            2 tâches ; démarrage attendu  6 min      2    Code 1.6 · APK 8 h
… 3 autres lignes, dont le chef identifié par son badge

AU REPOS · 10
immo-share         ✓ Résultat · non lu  Navigation corrigée           1 h        —    Code 2.0 · APK 1 h
coursSQL           ○ Au repos          Dernier résultat : cours relu  2 j        —    Non renseigné
… 8 autres lignes

PARQUÉS · 13                                                   [Replier]
meetingScribe ▫    Parqué              Dernier résultat disponible    4 j        —    Code 1.1 · APK 5 j
photoLab ▫         Parqué              État non vérifié               —          —    Code 1.0 · APK 8 j
… 11 autres lignes
```

```text
Mobile · 390 px
Conversation   [Projets]       ● À jour
Tous 32   Attention 3   Actifs / attente 6
Repos 10  Parqués 13
[Chercher…                      ] [Filtres]

À VOTRE ATTENTION · 3
┌─────────────────────────────────────┐
│ RemotePad                 ✕ Échec   │
│ Tests de connexion échoués          │
│ Dernière activité : 2 min   File 1  │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ BookHaven             ? À répondre  │
│ Autorisez-vous la diffusion de      │
│ cette version ?                    │
│ Dernière activité : 8 min           │
└─────────────────────────────────────┘
La liste continue ; toucher ouvre le panneau.
```

## 6. Données : réemploi et ajouts nécessaires

### Contrat de lecture

Enrichir **additivement `/api/pupitre`**, plutôt que créer un deuxième endpoint concurrent de santé. Une projection serveur par projet fait autorité pour toutes les surfaces, y compris le rail et `/pupitre`. Le navigateur ne lance ni scan de dépôt ni requête de détail pour chacune des 32 lignes.

| Besoin | Réemploi | Ajout proposé |
|---|---|---|
| États et activité | `fleet-status-core`, réducteurs existants, `activity`, `needsInput`, `awaitingChef` | Projection cohérente entre surfaces ; `observedAt`, qualité de l’observation et statut non vérifié explicites. Ne pas réécrire un sixième réducteur divergent. |
| Dernière activité | Timestamp des événements, `silentMs`, mtime en secours | `lastActivityAt`, `lastProgressAt`, `timestampSource`. Distinguer activité du tour, coordination et simple écriture fichier. Une mtime doit rester une approximation, jamais une date de résultat certaine. |
| Questions et lecture | `question_resolved`, `.read`, `/api/config`, résolution existante | Question avec identifiant de tour/événement ; `hasUnreadResult`, `lastResultAt`, rapprochement du marqueur de lecture dans la projection. Conserver l’état métier indépendant du non-lu. |
| File | `dispatchQueue`, `queueDepth`, `queueEntryView`, `pool` | `queueOldestAt`, aperçu borné de la tête et `waitReason` seulement si connu. Diffusion de toute mutation de file, même sans nouvel événement JSONL. Détail via `/api/queue/:project` uniquement à l’ouverture. |
| Modèle | `model`, `provider` des événements ; config en repli | Portée courant/dernier/prévu et `modelSource` si présent. Pour Codex, respecter la résolution réelle (`codexModel`, défauts, config Codex), sans présenter le `configModel` Claude de repli comme modèle servi. Exclure les modèles synthétiques. |
| Sessions | `/api/config.attachedSession`, `/api/sessions`, sidecars | Réutiliser les métadonnées au panneau ; distinguer session Claude attachée et identifiant du tour/provider courant. Ne pas proposer de nouvelles opérations de session sur la ligne. |
| Parqués | Entrées de configuration et flux de leurs logs déjà suivi | Supprimer le faux raccourci `idle` pour cette projection : scan borné initial, cache, invalidation par événement. Vérification PID pour tous les tours observés en vol, parqués inclus. Un projet dormant ne nécessite pas de scan périodique de son log. |
| Version | Lecteur et validation de `downloads-registry`, sources déclarées ; `/api/version` pour le serveur orchestrateur | Métadonnées de version en JSON, cache par mtime/taille. Étendre le registre avec associations projet/composant explicites et sources validées pour les projets absents ; aucune exploration récursive de `I:\Dev` à chaque affichage. Un projet hybride peut afficher Node + Android. |
| Build disponible | Présence/stat de `builds/<projet>/latest.apk`, chemins existants de téléchargement | `available`, `copiedAt`, type d’artefact, lien validé. Sans manifeste : version d’artefact inconnue. Ajouter ensuite un manifeste publié atomiquement après copie : version embarquée vérifiée, date, artefact, composant, éventuellement commit. Ni mtime ni texte de callback ne prouvent un build réussi. |
| Coût récent | Dernier vrai `result` avec `total_cost_usd`, provenance provider/session | `lastReportedCost` avec montant, date, portée et couverture. Exclure fantômes et doublons ; ne pas recompter le callback du même résultat. Valeur absente = « non fourni », pas zéro. |

**Coûts : livraison en deux niveaux.** En première version, afficher « Dernier coût rapporté : $0,42 · il y a 1 h », avec « portée non vérifiée » si le producteur ne garantit pas un coût par tour. Ne pas le baptiser coût 24 h. Pour un véritable coût récent « 24 h glissantes », normaliser chaque producteur : coût par tour ou différence de cumuls dans une même session, changement de session, compteur réinitialisé, idempotence des événements. Si le point de départ manque, afficher une couverture partielle. Un résultat Codex sans montant reste inconnu. Ne pas assimiler ces estimations de consommation à une facture d’abonnement.

La projection reste une Map dans le processus Node existant. Pour les agrégats qui exigent plus que la fin du log, prévoir un petit sidecar dérivé sous `logs/`, écrit atomiquement, avec curseur/version de schéma et reprise incrémentale ; les JSONL append-only restent la source. Reconstruction asynchrone bornée, jamais lecture synchrone complète des gros historiques dans une route HTTP. Un historique insuffisant produit « inconnu/partiel », pas un état rassurant par défaut.

### Temps réel sans polling lourd

1. Au chargement, conserver le chargement de configuration et demander un instantané `/api/pupitre`. Partager **l’unique connexion `/api/sse/fleet`** avec la conversation et le panneau.
2. Ajouter un événement SSE **nommé** `project_status` contenant la ligne normalisée, une révision monotone et l’identifiant de génération du serveur. Le flux actuel de lignes `{project,line}` et les messages `fleet_config_changed` / `pool` continuent de fonctionner. Le type nommé évite que les anciens clients prennent la projection pour un log. Pour les clients migrés, transmettre aussi les changements de `pool`, de disponibilité provider et de composition de flotte dans une projection globale légère ; le signal `pool` seul oblige aujourd’hui à redemander l’instantané.
3. Les watchers et mutations existants invalident la projection : résultat, question acquittée, nouveau tour, lecture, file, parking, configuration, métadonnées de build. Coalescer les mises à jour par projet sur 250–500 ms avec délai maximum ; une émission continue de tokens ne doit pas repousser indéfiniment une fin de tour.
4. Un contrôle serveur partagé, toutes les 5 s, vérifie les PID des seuls projets en vol et la traversée du seuil de stall, même si aucun log n’arrive. Réutiliser les boucles existantes si possible ; aucune boucle par navigateur. Ne pas rescanner tous les logs inchangés. Les âges se calculent localement depuis les timestamps ; les diagnostics viennent du serveur.
5. Envoyer un événement de fraîcheur applicatif léger, par exemple toutes les 15 s, distinct du commentaire SSE `: ping` invisible à JavaScript. Un flux connecté sans nouvelles lignes n’est pas un système mort. Après deux battements manqués, afficher « données anciennes », conserver les dernières valeurs et leur date ; ne pas transformer tous les projets en erreurs.
6. À la reconnexion ou au retour d’un onglet masqué, resynchroniser une fois par instantané. Le flux actuel n’assure pas de replay avec identifiants SSE : ajouter génération/révision à l’instantané et aux mises à jour, mettre en tampon pendant le chargement, puis appliquer seulement les révisions plus récentes. Un message trop gros sauté ou un trou détecté provoque aussi cette resynchronisation.
7. Une seule requête de rattrapage à la fois. En secours, pendant une panne SSE mais HTTP disponible, un instantané toutes les 30 s maximum, avec temporisation progressive sur erreur ; arrêt du secours dès le retour du flux, et aucune boucle réseau de secours quand l’onglet est masqué. Remplacer les polls 5 s/2,5 s de cette interface, ne pas leur ajouter un troisième mécanisme.

Objectif mesurable : aucune requête périodique `/api/pupitre` en régime SSE sain après amorçage ; aucune requête par ligne ; activité/fin de tour visible en moins d’une seconde hors charge exceptionnelle ; perte de processus détectée au prochain contrôle partagé. Les scans de versions/builds sont mutualisés et limités aux fichiers déclarés, avec cache et contrôle léger des changements.

Tous les ajouts restent dans Node/Express/chokidar et le JavaScript/CSS natifs existants. Pas de base de données, framework, service séparé, dépendance distante ou appel LLM. Conserver le token gate pour endpoints et SSE, les chemins et noms validés, l’échappement des aperçus, et ne jamais envoyer la configuration sensible ou les logs complets avec la projection.

## 7. Découpage et effort

Estimation pour une personne connaissant le dépôt, en jours de travail effectif ; conception fournie ici, implémentation à venir après synthèse.

| Lot | Contenu | Effort |
|---|---|---:|
| A | Projection partagée, priorités, parqués, lecture/questions, files et dates fiables | 1–1,5 j |
| B | Vue Projets, groupes, filtres, adaptation mobile, intégration du panneau et accessibilité | 1,5–2 j |
| C | Événements SSE agrégés, contrôle silencieux, fraîcheur, reconnexion et retrait des polls redondants | 1–1,5 j |
| D | Versions/builds disponibles, coût rapporté et provenance du modèle, caches de métadonnées | 0,5–1 j |
| E | Recette des cas limites, performance sur 32 projets, vérification visuelle et corrections | 1 j |
| **Première version complète** | Tous projets + attention + métadonnées honnêtes + temps réel | **5–7 j** |
| Enrichissement ultérieur | Manifestes de builds, agrégat fiable 24 h, éventuel protocole d’attente externe structurée | **2–3 j supplémentaires**, selon les producteurs |

Recette de l’implémentation : 32 identités uniques dont le chef ; parqué actif/avec question visible ; question acquittée encore fermée après redémarrage ; résultat fantôme sans effet ; résultat lu sans retour du badge ; `awaitingChef` différent de « votre réponse » ; file évoluant sans log ; tour silencieux avec PID vivant puis mort ; PID inconnu ; version source différente de celle du build ; coût absent, cumul de session et changement de session ; callback tardif sans faux démarrage. Vérifier reconnexion et mise à jour concurrente d’un instantané, puis filtrage/clavier/mobile à 390 px, zoom à 200 %, thème monochrome et stabilité du focus pendant les changements. Mesurer l’absence de requêtes par projet et de rescans complets à chaque token.

## 8. Mes cinq choix les plus importants et les pièges à éviter

1. **Une vue Projets pleine largeur, exhaustive et ouverte par défaut.** Le piège serait d’ajouter une autre synthèse qui cache encore les projets au repos et les 13 parqués, ou de rendre 32 cartes illisibles pour les faire tenir dans un écran.
2. **L’attention avant l’activité, avec état, cause et destinataire explicites.** Le piège serait de confondre question utilisateur, attente du chef, file, résultat non lu et panne ; un stall reste une suspicion, pas une autorisation de relance.
3. **Une seule projection de santé partagée, et le parking comme attribut.** Le piège serait de reprendre le `idle` synthétique des parqués, de ressusciter une question acquittée ou de développer des règles contradictoires entre tableau, panneau et CLI.
4. **Le flux existant complété par un contrôle serveur des silences.** Le piège serait de croire que SSE seul détecte un processus mort, de rescanner 32 journaux à chaque token, ou de cumuler plusieurs polls dans chaque onglet.
5. **Des métadonnées honnêtes et secondaires.** Le piège serait d’afficher une version source comme version de l’APK, une session attachée comme agent actif, un modèle configuré comme modèle servi, ou un coût absent/cumulé comme coût récent exact.
