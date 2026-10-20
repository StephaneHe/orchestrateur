# Parité de l'app Android avec le dashboard web

Demande utilisateur du 2026-10-20 : « Fais une nouvelle application android
Orchestrateur, qui prend en compte toutes les fonctionalites. Une fois faite,
mets la sur la page d'exposition des applications http://stephane:7777/downloads ».

App **1.0.0** (`versionCode` 24), même `applicationId` (`com.orchestrateur`) :
elle s'installe par-dessus la 0.13.0. Serveur **0.127.0** (menu des pauses
dans `/api/pipeline-runs`).

Ce document est vérifié par `scripts/_test_android_parity.mjs` (non-régression,
exigence permanente) :

- chaque ligne a un statut : `oui`, `partiel` ou `non applicable`, avec une
  raison dès que ce n'est pas `oui` ;
- chaque écran cité (`chemin#Symbole`, sous
  `android/app/src/main/java/com/orchestrateur/`) existe ;
- chaque test cité (`jvm:Classe#méthode`, sous `android/app/src/test/`) existe ;
- chaque script de `public/` est couvert par au moins une ligne ;
- chaque route `/api` du serveur est appelée par l'app, ou listée plus bas avec
  sa raison ;
- chaque section de l'écran « Plus » (`ui/more/Sections.kt`) est nommée ici ;
- la version de l'app figure ici.

**Ajouter une fonctionnalité au dashboard** : ajouter sa ligne ici, avec son
écran dans l'app et son test JVM (ou `partiel` / `non applicable` et la
raison). Sinon la non-régression échoue.

Navigation de l'app : le fil du chef (racine), le détail d'un musicien
(`musicien/{name}`), l'écran « Plus » (`plus`) et une destination par
section : `projets`, `pipelines`, `non-regressions`, `todo`, `git`,
`release`, `requetes`, `models`, `reponse-auto`, `autorisations`,
`reglages`, `nouveau-musicien`, plus `sessions/{name}`.

## Fonctionnalités

| n° | Fonctionnalité | Source web | Statut | Où dans l'app | Test | Note |
|---|---|---|---|---|---|---|
| 1 | Connexion : URL du serveur, jeton facultatif, déverrouillage biométrique | `index.html` | oui | `ui/login/LoginScreen.kt#LoginScreen` | — | |
| 2 | Flux en direct SSE `/api/sse/fleet`, instantané `/api/pupitre` toutes les 5 s, sur TOUS les écrans | `app.js` | oui | `MainActivity.kt#MainActivity` `ui/fleet/FleetViewModel.kt#FleetViewModel` | `jvm:PupitreDecodeTest#realSnapshotDecodes` | 1.0.0 : le flux suit l'activité, il ne s'arrête plus à l'ouverture d'un autre écran |
| 3 | Fil du chef : bulles, historique `/api/conductor-chat`, « le chef répond… », « Nouveau rapport ↓ » | `app.js` | oui | `ui/fleet/MainPane.kt#ConductorTranscript` `ui/fleet/MainPane.kt#ChatBubble` | — | |
| 4 | Corbeille « Résultat(s) reçu(s) » et cartes de résultat | `app.js` | oui | `ui/fleet/MainPane.kt#ResultsBasket` | — | |
| 5 | Lignes de mission et « Activité de l'orchestre » | `app.js` | oui | `ui/fleet/MainPane.kt#MissionsBlock` | — | |
| 6 | Composer : envoi au chef, brouillon gardé en cas d'échec, citation (« ↩ répondre ») | `app.js` | oui | `ui/fleet/FleetScreen.kt#Composer` | `jvm:PipelineChoiceTest#autoSendsNoPipeline` | |
| 7 | Sélecteur de pipeline ⇄ auto / Discussion / Dév. léger / Dév. complet / Réunion (appui) | `app.js` | oui | `data/PipelineChoice.kt#PipelineChoice` `ui/fleet/FleetScreen.kt#Composer` | `jvm:PipelineChoiceTest#tapCyclesThroughEveryChoice` `jvm:PipelineChoiceTest#explicitChoiceTravelsInThePayload` | |
| 8 | Autres pipelines du moteur (Incident, Recherche, Audit, Maintenance, Nouveau projet, Données, Rédaction, Images, Vidéo, Audio) et « 💬 Discuter avec le chef » (`/chef-discussion`) | `app.js` | oui | `data/PipelineChoice.kt#dispatchPayload` | `jvm:ChefExtrasTest#everyEnginePipelineIsSelectable` `jvm:ChefExtrasTest#chefDiscussionIsATextPrefix` | appui long sur « PIPELINE : … » |
| 9 | @mention d'un musicien et envoi direct `@X` | `app.js` | oui | `ui/fleet/FleetScreen.kt#MentionMenu` | — | |
| 10 | Pièces jointes images et vidéos (`/api/attach/image`) | `app.js` `attach-policy.js` | partiel | `ui/fleet/FleetScreen.kt#ImageStrip` | — | un fichier par sélection ; types filtrés par le sélecteur Android (image/*, video/*), plafond de 500 Mo appliqué par le serveur (413/415) et non avant l'envoi |
| 11 | File de direction du chef : bande, « Retirer » (texte rendu au composer), « Interrompre le chef avec ce message » | `app.js` | oui | `ui/fleet/ChefExtras.kt#PoolBand` | `jvm:ChefExtrasTest#poolBand` `jvm:ChefExtrasTest#emptyPool` | |
| 12 | « ✎ Éditer et renvoyer » une demande | `app.js` | oui | `ui/fleet/MainPane.kt#ChatBubble` | — | appui long sur la bulle |
| 13 | En-tête : version de l'app et du serveur, « ⚠ redémarrage requis (dépôt vY) », état du chef, fraîcheur | `app.js` | oui | `ui/fleet/FleetScreen.kt#JournalHeader` | `jvm:SettingsLogicTest#serverVersionAndRestartNotice` | |
| 14 | Bandeau système (processus perdu, limite Claude, flux coupé) | `app.js` `salle.js` | oui | `ui/fleet/FleetScreen.kt#SystemBanner` | — | |
| 15 | Bande « ⚠ À votre attention » : autorisations, questions, processus perdus, échecs ; « 🔐 Décider », « ✓ Vu », « ✓ Marquer comme répondue », « Répondre via le chef », « En parler au chef » | `app.js` `salle.js` | oui | `ui/fleet/FleetScreen.kt#AttentionBand` `ui/fleet/ChefExtras.kt#AckButtons` | — | |
| 16 | Questions des musiciens : bulle, « Répondre via le chef », « Répondre directement à X », « ✓ Marquer comme répondue » | `app.js` | oui | `ui/fleet/MainPane.kt#QuestionBubble` | — | |
| 17 | Pauses de pipeline : cause, choix intelligents en boutons, recommandation, réponse à l'exécution | `activite.js` | oui | `ui/ops/PipelineRunsScreen.kt#PauseChoices` `ui/ops/PipelineRunsScreen.kt#PauseBlock` | `jvm:PipelineRunsModelTest#pauseReplyForAMusicianTargetsTheRun` `jvm:PipelineRunsModelTest#latestPausedRunWithAPause` | serveur 0.127.0 : `pause` dans `/api/pipeline-runs` |
| 18 | Lecture audio des réponses du chef : « 🔊 écouter / ⏹ arrêter », lecture automatique, vitesse | `tts.js` | partiel | `ui/fleet/ChefExtras.kt#TtsButton` `ui/settings/SettingsPlusScreen.kt#SpeechCard` | `jvm:ChefExtrasTest#speechTextNeverReadsCodeOrMarkup` `jvm:ChefExtrasTest#speechChunksStayShort` | moteur vocal du téléphone ; pas de choix de voix ni de voix anglaise pour l'anglais |
| 19 | « ⚠ langue » et « voir l'original » d'une réponse reformulée | `app.js` `activite.js` | oui | `ui/fleet/MainPane.kt#ChefBubbleFooter` `ui/fleet/DetailExtras.kt#TurnCard` | `jvm:JournalTurnsTest#parsesTurnsAndFields` | |
| 20 | Sorties HTML des models rendues et assainies | `html-render.js` | oui | `ui/fleet/Markdown.kt#Markdown` | `jvm:HtmlTextTest#everyInjectionIsRefused` `jvm:HtmlTextTest#fragmentBecomesSupportedMarkdown` | |
| 21 | Identifiants `[[…]]` et formats connus cliquables, overlay d'explication `/api/identify` | `id-links.js` | oui | `ui/fleet/Markdown.kt#LinkableText` `ui/common/IdentifyDialog.kt#IdentifyDialog` | `jvm:IdLinksTest#knownFormatsDetected` `jvm:MarkdownParseTest#identifierBecomesIdRef` `jvm:IdLinksTest#webLinksMapToAppRoutes` | |
| 22 | Rail « Pilotage » : ligne résumée, feuille, recherche et filtres | `salle.js` | oui | `ui/fleet/PilotageSheet.kt#PilotageSheet` | — | |
| 23 | Volet d'un musicien : état, télémétrie, « Marquer lu », « En parler au chef » | `app.js` `salle.js` | oui | `ui/fleet/MusicianDetailScreen.kt#MusicianDetailScreen` | — | |
| 24 | Journal d'activité : tours, issue, demande, frise de pipeline, autorisations, puces, « Afficher tout », non-régressions mêlées | `activite.js` `turn-core.js` | oui | `ui/fleet/DetailExtras.kt#ActivityJournalTab` | `jvm:JournalTurnsTest#outcomeWordLikeTheWeb` `jvm:JournalTurnsTest#pipelineTimelineRowsAndUpcoming` `jvm:JournalTurnsTest#afterLines` | |
| 25 | Onglets « Dernier résultat », « En direct », « Log brut » | `pupitre-detail.js` `pupitre-row.js` | oui | `ui/fleet/MusicianDetailScreen.kt#ResultTab` `ui/fleet/MusicianDetailScreen.kt#ActivityTab` `ui/fleet/MusicianDetailScreen.kt#JournalTab` | — | |
| 26 | Attente après erreurs de lancement : « 🔬 Tester le model », « ↻ Réessayer maintenant », « ⇄ Changer de model », journal du test | `activite.js` | oui | `ui/fleet/DetailExtras.kt#TurnCard` `ui/ops/PipelineRunsScreen.kt#BackoffBlock` | `jvm:PipelineRunsModelTest#backoffTextAndBody` | |
| 27 | File d'un musicien : liste, détail, « Modifier la demande… », ordre ↑ / ↓, « Retirer », file retenue | `app.js` | oui | `ui/fleet/DetailExtras.kt#QueueTab` | `jvm:QueueLogicTest#detailFieldsLikeTheWebOverlay` `jvm:QueueLogicTest#moveKeepsEveryIdOnce` | glisser-déposer remplacé par ↑ / ↓ (même route) |
| 28 | « Envoyer directement à X… » | `app.js` | oui | `ui/fleet/DetailExtras.kt#DirectSendDialog` | — | |
| 29 | Refus d'autorisation : « + Autoriser X », « ✓ Vu » | `permission-denial.js` | oui | `ui/fleet/DetailExtras.kt#DenialsBlock` | — | |
| 30 | Demandes d'autorisation : carte, compte à rebours, explication, « Une fois », « Toujours… », « Refuser… », détails | `permissions.js` `permission-core.js` | oui | `ui/fleet/PermissionBand.kt#PermissionBand` `ui/fleet/PermissionBand.kt#PermissionDetailsDialog` | — | |
| 31 | Zone de notifications compacte (« 🔔 n demandes en attente », « Tout réduire », hauteur bornée) | `notif-dock.js` | oui | `ui/fleet/ChefExtras.kt#NotificationDock` | — | |
| 32 | Autorisations permanentes : liste, « Révoquer » | `permissions.js` | oui | `ui/ops/PermissionRulesScreen.kt#PermissionRulesScreen` | `jvm:PermissionRulesModelTest#groupsByProjectSorted` `jvm:PermissionRulesModelTest#revokeBody` | section `autorisations` |
| 33 | Réponse automatique : interrupteur, délais, activité, garde-fous discrets (une ligne repliée, lecture seule), arriéré, décisions, « Annuler », « Écarter », historique | `auto-answer.js` | oui | `ui/ops/AutoAnswerScreen.kt#AutoAnswerScreen` | `jvm:AutoAnswerModelTest#guardrailsAreReadOnlyDataWithCollapsedLabel` `jvm:AutoAnswerModelTest#needsConfirmOnlyOn409WithList` `jvm:AutoAnswerModelTest#backlogAndHistory` | section `reponse-auto` |
| 34 | Bandeau « 🤖 n décisions prises à votre place » : Détail, Annuler, Reporter, Écarter, « ✓ Vu » | `auto-answer.js` `notif-dock.js` | oui | `ui/ops/AutoAnswerScreen.kt#AutoAnswerBand` | `jvm:AutoAnswerModelTest#bandKeepsUnseenFinishedNotDismissedNotSnoozed` | |
| 35 | Présence : l'utilisateur qui lit l'app n'est pas inactif | `auto-answer.js` | oui | `MainActivity.kt#startPresenceLoop` | — | |
| 36 | Vue Projets : groupes, tuiles, compteurs qui isolent, filtre, détails | `projets.js` `salle.js` | oui | `ui/projects/ProjectsScreen.kt#ProjectsScreen` | `jvm:ProjectsLogicTest#classifiesEveryKindLikeTheWeb` `jvm:ProjectsLogicTest#redOnlyForRealIncidents` `jvm:ProjectsLogicTest#groupsCountsAndOrder` | section `projets` |
| 37 | Exécutions de pipeline : liste, frise des étapes, filtre par projet | `activite.js` | oui | `ui/ops/PipelineRunsScreen.kt#PipelineRunsScreen` | `jvm:PipelineRunsModelTest#parsesRunsStepsAndPause` | section `pipelines` |
| 38 | Non-régressions en direct : bande, liste, rapport, pastille du musicien | `regress-live.js` | oui | `ui/ops/RegressionsScreen.kt#RegressionsScreen` `ui/ops/RegressionsScreen.kt#RegressionBand` | `jvm:RegressionsModelTest#bandRowsKeepRunningAndRecentUnderTenMinutes` `jvm:RegressionsModelTest#reportSummaryFromReportJson` | section `non-regressions` |
| 39 | Panneau latéral : accès aux onglets TODO, Git, Release, Requêtes | `side-panel.js` | oui | `ui/more/Sections.kt#MoreScreen` | — | un écran par onglet dans « Plus » |
| 40 | TODO : non faits / faits, filtre, détail, notes, rejet, ordre, « Envoyer au chef… », « 💬 Discuter avec le chef… » | `todo-panel.js` | oui | `ui/panels/TodoScreen.kt#TodoScreen` `ui/panels/TodoScreen.kt#TodoItemDialog` | `jvm:TodoLogicTest#chefMessageIsIdenticalToTheWeb` `jvm:TodoLogicTest#discussMessageIsIdenticalToTheWeb` `jvm:TodoLogicTest#moveKeepsThePartAndMergesIntoTheWholeOrder` | section `todo` |
| 41 | Git : choix du musicien, graphe des voies, références, « Plus de commits » | `git-panel.js` | oui | `ui/panels/GitScreen.kt#GitScreen` `ui/panels/GitScreen.kt#GraphCell` | `jvm:GitLogicTest#parsesCommitsRefsAndLayout` `jvm:GitLogicTest#rowStrokesSplitSegmentsAtTheRowBoundary` | section `git` |
| 42 | Release : groupes, détail, note « Copier » / « Partager .md » | `release-panel.js` | oui | `ui/panels/ReleaseScreen.kt#ReleaseScreen` | `jvm:ReleaseLogicTest#groupsInProgressFirstThenEachVersion` | section `release` ; partage au lieu de téléchargement |
| 43 | Requêtes : découpage, tâches par niveau, progrès, détail | `requests-panel.js` | oui | `ui/panels/RequestsScreen.kt#RequestsScreen` | `jvm:RequestsLogicTest#columnsByLevelAndWhyNoTask` `jvm:RequestsLogicTest#detailRowsLikeTheWebDialog` | section `requetes` |
| 44 | Models : étapes par pipeline, Principal / Second, compatibilités, historique, rafraîchir | `models.js` | oui | `ui/models/ModelsScreen.kt#ModelsScreen` `ui/models/StepsTab.kt#SlotEditor` | `jvm:ModelsDataTest#actionStepMenuFiltersByCapsAndGreysUnharnessedProviders` `jvm:ModelsDataTest#putBodies` | section `models` |
| 45 | Models : suggestions de l'étude comparative, « Appliquer » et « étapes vides seulement » | `models.js` | oui | `ui/models/StepsTab.kt#RecoBlock` `ui/models/StepsTab.kt#RecoBox` | `jvm:ModelsPanelsTest#applySuggestionBodiesPlanAndResult` | |
| 46 | Models : mise en service, observation | `models.js` | oui | `ui/models/PanelsTabs.kt#HealthTab` `ui/models/PanelsTabs.kt#ObserveTab` | `jvm:ModelsPanelsTest#parsesHealth` `jvm:ModelsPanelsTest#parsesObservation` | |
| 47 | Models : lacunes proposées (accepter, alternative, rejeter ; présentées à l'utilisateur) | `models.js` | oui | `ui/models/PanelsTabs.kt#GapsTab` | `jvm:ModelsPanelsTest#parsesGapsAndPresentedKeys` | |
| 48 | Models : clés API (valeur jamais affichée), langues des models | `models.js` `langue.js` | oui | `ui/models/PanelsTabs.kt#KeysTab` `ui/models/PanelsTabs.kt#LangsTab` | `jvm:ModelsPanelsTest#parsesKeysAndNotices` `jvm:ModelsPanelsTest#parsesModelLanguages` | |
| 49 | Langue de discussion : défaut et exceptions par projet | `langue.js` | oui | `ui/settings/SettingsPlusScreen.kt#LanguageCard` | `jvm:SettingsLogicTest#parsesLanguageView` `jvm:SettingsLogicTest#languageBodies` | section `reglages` |
| 50 | Fournisseur IA CLAUDE / CODEX | `app.js` | oui | `ui/settings/SettingsPlusScreen.kt#ProviderCard` | `jvm:SettingsLogicTest#providerFromConfigAndBody` | |
| 51 | Taille du texte A− / A / A+ (85 % à 150 %) et palette | `text-size.js` | oui | `ui/settings/SettingsPlusScreen.kt#DisplayCard` `ui/theme/Theme.kt#OrchestreTheme` | `jvm:ChefExtrasTest#textScaleSteps` `jvm:SettingsLogicTest#paletteLabels` | |
| 52 | Nouveau musicien : candidats, nom, chemin, chef d'orchestre | `app.js` | oui | `ui/projects/AddProjectScreen.kt#AddProjectScreen` | `jvm:ProjectAdminLogicTest#validatesNameAndPathLikeTheServer` | section `nouveau-musicien` |
| 53 | Session Claude d'un musicien : liste, attacher, détacher, nouvelle session | `app.js` | oui | `ui/projects/SessionsScreen.kt#SessionsScreen` | `jvm:ProjectAdminLogicTest#parsesSessionsAndMarksAttached` `jvm:ProjectAdminLogicTest#newSessionOutcomes` | |
| 54 | Page `/downloads` et page `/pupitre` | `index.html` | oui | `ui/more/Sections.kt#MoreScreen` | — | ouvertes dans le navigateur |
| 55 | Raccourcis clavier (g puis m, Ctrl+Alt+L, Alt+↑/↓, Échap…) | `app.js` `tts.js` `text-size.js` | non applicable | — | — | téléphone sans clavier : chaque action a son bouton |
| 56 | Interrupteurs `ui.*` de config.json et paramètres `?todo=0`, `?models=0`… | `app.js` | non applicable | — | — | réglages d'affichage du navigateur ; toutes les sections sont toujours accessibles dans l'app |
| 57 | Notification de bureau d'une nouvelle demande d'autorisation | `permissions.js` | partiel | `ui/fleet/PermissionBand.kt#PermissionBand` | — | la carte apparaît dans l'app ouverte ; pas encore de notification Android quand l'app est fermée |

## Routes sans écran

Routes `/api` que l'app n'appelle pas directement, avec la raison (le test
échoue pour toute autre route non appelée).

| Route | Raison |
|---|---|
| `GET /api/lanes/:project` | lecture des couloirs pour le CLI et les tests ; le dashboard web ne l'affiche pas non plus |
| `GET /api/model-tests/:name` | ouverte dans le navigateur par le lien « voir le journal du test » (URL construite à partir du nom) |
| `GET /api/pipeline-enforcement` | état de mise en service lu par les scripts du chef ; non affiché par le web |
| `GET /api/regressions/:project/report/:id` | URL fournie telle quelle par `/api/regressions` (champ `report`) et lue par l'écran Non-régressions |
| `GET /api/sessions` | table nom → session pour les scripts ; l'écran Session Claude utilise `/api/projects/:name/sessions` |
| `PATCH /api/projects/:name/tools` | réglage d'administration des outils d'un projet, sans écran dans le web |
| `POST /api/permission/:id/expire` | appelée par le serveur MCP d'autorisation à l'échéance, jamais par une interface |
| `POST /api/permission/request` | appelée par le serveur MCP d'autorisation pour poser une demande, jamais par une interface |
| `POST /api/pipeline-gaps/:key/accept` | appelée par la page Models avec un chemin construit (`ModelsState.kt`, accepter ou rejeter) |
| `POST /api/pipeline-gaps/:key/reject` | appelée par la page Models avec un chemin construit (`ModelsState.kt`, accepter ou rejeter) |
| `POST /api/project/:name/provider` | surcharge du fournisseur par projet, sans écran dans le web (le réglage global est dans Réglages) |
| `POST /api/ssh/register-key` | enregistrement de clé SSH, sans écran dans le web ni usage dans la flotte actuelle |
