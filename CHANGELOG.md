# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project ships two artefacts that share a single changelog: the Node.js
server/dashboard and the Android companion app. Entries are prefixed
`(server)` or `(android)` when the scope is one-sided.

## [Unreleased]

## [0.34.0] - 2026-10-04

Demande utilisateur : « donne la possibilité d'augmenter ou diminuer la taille
de la police ».

### Added
- (viewer) **Taille du texte réglable** sur tout le dashboard : fil, Pilotage,
  cadres, journal, vue Projets, panneaux, mobile.
  - Réglage « A− / 100 % / A+ » dans la barre du haut, toujours visible (aussi
    sur mobile, en cibles de 44 px), avec `aria-label`.
  - Six crans : 85, 90, 100, 110, 125 et 150 %. La préférence est mémorisée
    dans le navigateur et appliquée avant le premier rendu, sans éclair.
  - Raccourcis : `Ctrl+Alt+=` / `Ctrl+Alt+-` / `Ctrl+Alt+0`. `Ctrl+/-` reste
    au zoom du navigateur. Les raccourcis ne s'appliquent jamais dans un champ
    de saisie, ni avec AltGr (sous Windows, AltGr équivaut à Ctrl+Alt ; sur
    AZERTY, AltGr+0 tape « @ »).
- Parcours navigateur `text-size` (bureau) et `text-size-mobile`, avec
  captures à 85 % et 150 %.

### Changed
- (viewer) Les 292 tailles de police des feuilles de style passent de px à
  `rem`. La racine (16 px × échelle) porte le réglage, et `body` garde ses
  14 px : le rendu à 100 % est inchangé.

### Fixed
- (viewer) En grand texte, l'état d'une ligne de « À examiner » passait sous
  le bouton « ✓ Vu / ✓ Répondue ». Il s'ellipse désormais.
- (viewer) Sur mobile, les actions de la barre du haut passent à la ligne au
  lieu de sortir de l'écran.

## [0.33.0] - 2026-10-03

Retour utilisateur sur le journal d'activité : « les messages longs sont
tronqués, je ne peux pas tout lire. Faire un plié / déplié ? »

### Added
- (viewer) **Plié / déplié** dans le journal d'activité de chaque musicien.
  - Chaque entrée garde son aperçu court.
  - « ▸ Afficher tout » déplie le texte **complet** de la demande (sans
    boilerplate) et du résultat, sans quitter le journal.
  - Le texte complet est rendu en Markdown : titres, gras, listes, tableaux,
    blocs de code, liens.
  - « ▾ Réduire » replie l'entrée. Un second « ▴ Réduire », en bas d'un long
    texte, replie et ramène l'entrée à l'écran.
  - Au clavier : boutons natifs (Entrée / Espace), `aria-expanded` /
    `aria-controls`. Le focus reste sur le contrôle après chaque
    rafraîchissement.
  - L'état déplié est conservé pendant le rafraîchissement temps réel et
    quand on passe d'un volet à l'autre.
  - Sur mobile : cibles de 44 px. Tableaux et blocs de code défilent dans leur
    cadre, sans débordement horizontal de la page.
- (server) Chaque tour du journal (`/api/project/:name/journal`) porte
  `promptFull` et `resultFull` (`{text, cut}`), plafonnés à 12 000
  caractères chacun. Au-delà, le texte est coupé, l'interface le signale et
  renvoie à l'onglet « Log brut ».
- Recettes :
  - `_test_activity_journal.mjs` vérifie le texte complet, le boilerplate
    retiré et le plafond ;
  - le nouveau parcours navigateur `journal-fold` teste une entrée longue
    pliée puis dépliée (Markdown, clavier, état conservé, « Réduire » du bas) ;
  - les captures bureau et mobile montrent l'entrée pliée et dépliée.

## [0.32.0] - 2026-10-02

Retour utilisateur : « la fenêtre des musiciens En cours est trop petite, elle
fait doublon avec les dernières activités des musiciens ; on peut l'enlever ».

### Removed
- (viewer) Le bloc « En cours » de la colonne Pilotage, quand les cadres des
  musiciens sont affichés. La partie haute ne montre plus que « À examiner » ;
  la place libérée revient aux cadres. Le bloc réapparaît si `ui.railCards`
  est désactivé.

### Changed
- (viewer) Cadres du Pilotage :
  - les tours en cours viennent explicitement **en tête**, avec une bordure à
    la couleur de leur état ;
  - ils reprennent ce que seul l'ancien bloc affichait : la durée du tour
    (« tour N min », à la minute près) et la mention « données anciennes »
    quand l'instantané date ;
  - ils indiquent aussi la file derrière le tour (⏳ n).
  - La santé (sans progrès, processus perdu) reste dans « À examiner ». Le
    bloc n'avait ni bouton d'interruption ni file.
  - Un cadre en cours mais malade (processus perdu, sans progrès) prend la
    couleur d'alerte, plus celle de « en cours ».

### Fixed
- (viewer) La partie haute du Pilotage (« À examiner ») se faisait écraser par
  la liste des cadres, et sa dernière ligne était coupée. Elle garde sa hauteur
  (48 % au plus), et les cadres prennent le reste.
- Parcours navigateur adaptés : le parcours `rail` vérifie les cadres en tête,
  et le nouveau parcours `rail-no-running` vérifie l'absence du bloc et la
  part de place des cadres. `cards-order` impose l'ordre « en cours, puis
  activité ».

## [0.31.0] - 2026-10-02

Retours utilisateur sur le dashboard :
- un musicien arrêté par le chef s'affichait « ✕ Échec » ;
- rien ne permettait de le marquer comme vu, et il restait dans « À examiner »
  même après avoir été consulté ;
- le volet d'un musicien ne donnait accès qu'à son log, alors qu'il était
  censé résumer ses actions.

### Added
- (server, viewer) **« Vu » sans relancer de tour** : `POST /api/ack/:project`.
  - Un échec ou un arrêt est acquitté par un événement
    `notification/acknowledged` ajouté au log. Il survit au redémarrage et
    part par le SSE.
  - Un résultat en attente l'est par le marqueur de lecture.
  - Une question ou un tour en cours renvoie 409.
  - Boutons « ✓ Vu » / « ✓ Répondue » sur chaque ligne de « À examiner »,
    « ✓ Marquer vu » dans la bande d'attention et dans le volet.
  - **Ouvrir le volet vaut « vu »** pour un échec, un arrêt ou un résultat,
    jamais pour une question.
- (viewer) **Journal d'activité** : le volet s'ouvre sur la liste des tours du
  musicien. Chaque tour donne :
  - la demande, sans boilerplate ;
  - ce qu'il a fait, en 1 à 3 lignes tirées du résultat ;
  - les commits, versions et URL détectés ;
  - l'issue, la durée, le coût et le model.

  Le journal se met à jour en temps réel ; le log brut reste dans l'onglet
  « Log brut ». Il est servi par `GET /api/project/:name/journal` : lecture
  de la fin du log seulement, en asynchrone, avec un cache incrémental. Aucun
  appel à un LLM.
- (viewer) **Cadres des musiciens** dans la 2ᵉ partie verticale du Pilotage :
  un cadre par musicien, du plus récemment actif au plus ancien, avec son
  état, sa dernière action et depuis quand. Un clic ouvre son journal. Les
  états sont ceux de la vue Projets (`Projets.describe`).
- `public/turn-core.js` réunit les règles « vu », « arrêt par le chef » et le
  journal, partagées par le navigateur et le serveur. Recette :
  `scripts/_test_activity_journal.mjs`, qui inclut kill-stalled contre le vrai
  dispatch.mjs. Nouveaux parcours HTTP et navigateur (desktop et mobile) dans
  `regression.mjs`.
- Désactivable sans redéploiement, à chaud : `config.json` →
  `"ui": { "activityJournal": false, "railCards": false }`. Pour un seul
  navigateur : `?journal=0` / `?cadres=0`.

### Changed
- **Arrêt par le chef ≠ échec**. L'état affiché est « ■ Arrêté par le chef »,
  avec le motif s'il est connu.
  - `kill-stalled.mjs <projet> [--reason "…"]` écrit `stopped_by` et
    `reason`.
  - Le nom de projet est désormais validé.

### Fixed
- Après un `kill-stalled`, `dispatch.mjs` écrivait un second result (« model
  demandé indisponible… le CLI a échoué sans result »), qui masquait l'arrêt.
  - kill-stalled pose maintenant `logs/<projet>.killed` avant de tuer, et
    dispatch.mjs clôt le tour sans rien ajouter.
  - Les réducteurs ignorent ce result parasite dans les anciens logs.
- (viewer, mobile) Le volet plein écran passait sous la barre du haut
  (contexte d'empilement de `.main-row`), et son bouton « Retour » était
  intouchable.

## [0.30.0] - 2026-10-02

Demande de l'utilisateur : « les autorisations auraient dû être données à la
création ». Cas constaté sur un projet tout juste créé : trois appels à
l'outil `PowerShell` ont été refusés en mode headless (`cd …;` composé, chemin
vu comme UNC).
L'autorisation accordée ensuite depuis le dashboard (`add-tool`) a été écrite
dans `.claude/settings.json`, mais sans effet : le workspace n'était pas de
confiance. Dans ce cas, `claude -p` écarte toutes les règles `permissions.allow`
du projet (« Ignoring N permissions.allow entries… this workspace has not been
trusted »). 21 projets de la flotte étaient dans ce cas.

### Added
- `scripts/workspace-trust.mjs` :
  - marque un workspace de confiance dans `~/.claude.json`
    (`projects["I:/Dev/X"].hasTrustDialogAccepted`, plus la forme
    antislash si elle existe) ;
  - ajoute à `.claude/settings.json` du projet les outils standard et
    `PowerShell`.

  Ce fichier est partagé par tous les claude en cours, d'où ces précautions :
  - sauvegarde `~/.claude.json.orchestrateur-bak` avant écriture ;
  - lecture, modification et écriture en une seule passe brève ;
  - fichier temporaire renommé par-dessus, sans rien écraser si le fichier a
    changé entre-temps ;
  - relecture de contrôle, avec nouvel essai si une autre instance a écrit
    une copie périmée ;
  - seule l'entrée du projet est modifiée.
- `scripts/trust-projects.mjs [<projet>…] [--dry-run] [--json]` applique la
  même correction aux projets existants, en n'ajoutant que ce qui manque, et
  affiche l'état avant/après. Les réglages du chef ne sont pas modifiés.
  Appliqué à toute la flotte : 33 projets sur 33 sont de confiance (21 ne
  l'étaient pas avant).
- `scripts/_test_workspace_trust.mjs` (26 assertions, faux `~/.claude.json`),
  joué par `regression.mjs`.

### Changed
- `new-project.mjs` : un projet créé est aussitôt opérationnel, avec ses
  permissions et son workspace de confiance. Dans une racine de test, le vrai
  `~/.claude.json` n'est jamais touché sans `ORCH_CLAUDE_JSON`.
- (server) `POST /api/project/:name/add-tool` marque aussi le workspace de
  confiance (champ `trusted` dans la réponse). **Prise en compte au prochain
  redémarrage de 7777.** L'instance de régression pointe `ORCH_CLAUDE_JSON`
  vers sa propre copie.

## [0.29.4] - 2026-10-01

### Changed
- README professionnel (en anglais, comme le dépôt public) : présentation,
  fonctionnalités, statut, prérequis, installation, configuration (fichiers
  et noms de variables d'environnement, sans valeurs), utilisation,
  architecture, tests et non-régression, déploiement, versionnage, feuille de
  route, sécurité et signalement, contribution, licence, auteur.

## [0.29.3] - 2026-10-01

### Changed
- Le dépôt public s'appelle désormais **`StephaneHe/orchestrateur`** : l'outil
  ne pilote pas que Claude (Codex/OpenAI, repli NVIDIA). Ce dépôt neuf a été
  créé depuis l'historique nettoyé et ne contient aucun objet antérieur à la
  réécriture. README neutre côté fournisseurs, avec l'URL de clonage. L'ancien
  dépôt privé `claudeOrchestrateur` n'est plus le remote `origin`.
- La licence MIT (`LICENSE`) et l'avertissement du README (dashboard sans
  authentification, à n'ouvrir que sur un réseau de confiance) sont arrivés
  avec cette publication.

## [0.29.2] - 2026-10-01

Passe sécurité git (directive utilisateur : « rien n'apparaisse sur le git, ni
dans l'historique »). L'historique du dépôt a été réécrit.

### Security
- **Historique réécrit** (`git filter-repo`) : en sont retirés `logs/`,
  `attachments/`, `builds/`, `config.json`, les captures d'écran (`docs/*.png`,
  `docs/**/captures/`, `ui-*.png`, `android/*.png`), l'ancien jeton du
  dashboard codé en dur dans l'app Android, le nom d'hôte et les IP
  Tailscale/LAN. Le `.token` a été régénéré.
- (android, 0.7.0) **Le jeton n'est plus jamais compilé dans l'app.** Il se
  saisit dans l'écran de configuration (champ masqué, facultatif) et part en
  `X-Orchestrator-Token` sur toutes les requêtes, SSE comprise, seulement s'il
  est renseigné. Plus d'adresse serveur préremplie.

### Added
- `README.md` (avertissement : l'API de dispatch exécute des commandes sur la
  machine) et `config.example.json` anonymisé. `config.json` reste local et
  n'est plus versionné : `copy config.example.json config.json`.

## [0.29.1] - 2026-09-28

Signalement utilisateur : « un petit panneau me demande une autorisation mais
sans me dire laquelle ; une fois le musicien ouvert, je ne vois pas quelle
autorisation a été demandée, et le musicien continue ». C'était un **faux
positif** : le tour de la vue Projets avait lu `public/app.js`, dont le texte
contient « requires approval ». Or toute `tool_result` contenant cette chaîne
était prise pour un refus.

### Fixed
- (server, viewer) **Un refus d'autorisation n'est détecté que s'il est réel.**
  Il faut une `tool_result` avec `is_error: true`, dont le texte **commence**
  par un libellé réel du CLI claude, relevé dans les logs de la flotte :
  - « This command requires approval » ;
  - « Claude requested permissions to use|write to|edit … but you haven't
    granted it yet » ;
  - « This Bash|PowerShell command contains multiple operations. The following
    part(s) require(s) approval » ;
  - « Permission to use X … has been denied » ;
  - « …denied by your permission settings ».

  Un Read, ou une sortie de grep, qui contient la chaîne ne déclenche plus
  rien. Nouveau module partagé : `public/permission-denial.js`. Il remplace
  les quatre détections par sous-chaîne d'`app.js` : réducteur `Musician`,
  fil des cartes, toast, rendu d'événement.
- (android) Même règle dans `Musician.kt`, avec des motifs identiques au web
  (vérifié par test) ; `is_error` ajouté au modèle `Block`. versionName
  **0.6.1**, versionCode **16**. Compilé (`compileDebugKotlin`), mais **APK
  non reconstruit ni publié**.

### Changed
- (viewer) **Le panneau de refus dit toujours** quel musicien, quel outil,
  quel appel (commande, fichier, requête…), le motif du CLI, et quoi faire.
  - Le bouton « + Autoriser X » n'apparaît que si X manque aux outils du
    musicien.
  - Si l'outil est déjà autorisé, le panneau explique que c'est cet appel
    précis que le CLI refuse.
  - Un refus sans outil ou sans appel connu n'est **jamais** annoncé : plus
    de panneau vague.
- (viewer) Le volet musicien affiche les refus (zone `.dive-denials`) : ceux
  du tour en cours, sinon les `permission_denials` du dernier résultat.
- (server, cli) Aucune détection de refus n'existait dans `server.js`,
  `/api/pupitre` ou `fleet-status` : rien à y changer.

### Added
- (tests) `scripts/_test_permission_denial.mjs` (27) : chaque libellé réel,
  les faux positifs de l'incident, les refus complets, la pertinence du
  bouton, les motifs identiques web / Android.
- (tests) Deux parcours navigateur dans la batterie de non-régression : un
  Read piégé ne déclenche rien, et un vrai refus produit un panneau complet
  (toast + volet).

## [0.29.0] - 2026-09-28

Demande utilisateur : « je veux voir en un coup d'œil le statut de chacun des
projets ». Conception : synthèse des propositions de Fable 5.1 et de GPT-6
Astra, dans `docs/dashboard-status/SYNTHESE.md`. Point de retour posé avant
toute modification : tag `pre-status-view-v0.28.0` (`17c0899`).

### Added
- (server, viewer) **Vue « Projets »** (`#/projets`) : tous les projets d'un
  coup d'œil.
  - Entrées : pill « ▦ Projets » de la topbar, avec des compteurs toujours
    visibles (⚠ attention · ● en cours) ; menu ⋮ ; touches `g` puis `p`.
  - Quatre groupes disjoints, dans cet ordre : À votre attention, Actifs et en
    attente, Au repos, Parqués. Un parqué qui travaille ou pose une question
    remonte dans le bon groupe avec son badge.
  - Tuile en deux lignes : glyphe + **mot** d'état (jamais la couleur seule),
    ligne d'activité ou de question, âge, et chips (file, rapport promis au
    chef, model, CHEF, PARQUÉ). Une ligne « détails » facultative ajoute :
    - version **source** du code ;
    - date de copie de l'APK ;
    - coût et durée **rapportés** du dernier tour.
  - Outils : filtre texte (`/`), compteurs qui isolent un groupe, clavier
    (flèches, Échap).
  - Temps réel par le flux SSE et l'instantané existants, sans aucun poll
    supplémentaire. Réordonnancement stable, jamais sous le pointeur ni sous
    le focus.
  - Mobile sur une colonne, cibles ≥ 44 px ; annonce `aria-live` des
    nouvelles questions.
- (server) `/api/pupitre`, champs additifs :
  - par ligne : `lastActivityAt`, `lastActivitySource`, `lastTurn`,
    `mission`, `callbackTo`, `healthTracked`, `version`, `build` ;
  - au niveau flotte : `ui`.

  `/api/config` expose aussi `ui`. Versions et APK sont relus en **tâche de
  fond asynchrone** (60 s, liste fixe de fichiers, jamais d'I/O synchrone sur
  `I:\Dev` dans une route).
- (server) **Désactivation sans redéploiement** :
  - `config.json` → `"ui": { "projectsView": false }`, relu à chaud :
    signal `fleet_config_changed`, la vue disparaît des dashboards ouverts ;
  - côté navigateur, `?projets=0` / `?projets=1`.

  Défaut : activée.
- (tests) **Batterie de non-régression `scripts/regression.mjs`** :
  - toutes les suites node ;
  - une **instance de test isolée**, construite depuis n'importe quel ref git
    ou dossier (`_regression_sandbox.mjs`) : port libre, flotte de 14
    fixtures, faux `claude`, 7777 réécrit puis vérifié absent ;
  - 18 parcours HTTP et 33 parcours navigateur (Edge / Playwright,
    `_regression_browser.mjs`) sur tout le dashboard ;
  - rapports JSON et comparaison avant/après (`--compare`) ;
  - code de sortie non nul au moindre échec.
- (docs) `docs/dashboard-status/SYNTHESE.md` (conception) et
  `NON-REGRESSION.md` : tableau avant/après, 0 régression, retour arrière
  testé (revert → identique au tag), captures `captures/{avant,apres}/`.
- (tests) `scripts/_test_projects_view.mjs` (31) : champs du cœur, classement
  réel de `projets.js` en VM, contrats de `/api/pupitre`.
- (dev) `playwright-core` en devDependency (pilote l'Edge installé ; aucun
  navigateur téléchargé).

### Changed
- (server) `/api/pupitre` renvoie l'**état réel des parqués** (scan avec cache
  de 60 s) au lieu d'un `idle` forcé. La santé reste non suivie pour eux
  (`stalled`/`deadInFlight` à `false`, `healthTracked: false`) ; `/pupitre`
  n'affiche donc plus « PRÊT » pour un parqué en plein tour.

### Fixed
- (server, cli) `tailLines` (`fleet-status-core`) et `scanProjectState`
  jetaient **toujours** la première ligne du log, même quand le fichier
  entier tenait dans la fenêtre de 256 Kio. Un petit log perdait ainsi son
  premier événement (`user_prompt` d'ouverture, question…). La ligne n'est
  plus jetée que si la fenêtre commence en cours de fichier.
- (tests) `_test_queue_sidecar_sweep.mjs` était rouge depuis 0.24.0 : son bac
  à sable n'avait pas `newQueueEntryId`, la ReferenceError était avalée, et le
  test annonçait à tort une file perdue. Le serveur n'était pas en cause.

`server.js` est modifié : **redémarrage requis** (par le chef, via
`restart-orchestrateur.mjs`). La nouvelle vue n'apparaît qu'après.

## [0.28.0] - 2026-09-27

Règle utilisateur : « tous les projets doivent avoir droit au web et à la
lecture ». Elle remplace le « web en opt-in » de 0.27.0.

### Changed
- (config, non versionné) `defaults.allowedTools` =
  `Read,Edit,Write,Bash,WebFetch,WebSearch,Grep,Glob`. Les 16 overrides
  `tools` ont été complétés avec les outils manquants de cette liste, sans
  rien retirer : BookHaven, par exemple, garde son `Agent`. L'écriture est
  atomique, avec deux contrôles : seuls `defaults.allowedTools` et
  `projects[].tools` ont bougé, et aucun outil n'a été retiré. C'est effectif
  immédiatement pour les dispatches, car `dispatch.mjs` relit `config.json`.
  Aucun autre outil de lecture n'a été ajouté : `Read` couvre fichiers,
  images, PDF et notebooks, `Grep`/`Glob` la recherche, et l'ancien `LS`
  n'existe plus.
- (dispatch, server, cli) Les replis codés en dur, utilisés si `config.json`
  n'a pas de défaut, ont la même liste : `dispatch.mjs`, `new-project.mjs`, et
  `FALLBACK_TOOLS` de `server.js`, qui remplace six occurrences.
- (cli) **`new-project.mjs` fait hériter le défaut** : pas d'entrée `tools`.
  `--tools` est fusionné avec le défaut et ne sert qu'à ajouter (par exemple
  `Agent`) ; un `--tools` plus étroit ne crée pas d'override. `--web` est
  obsolète : accepté, sans effet, avec un avertissement.
- (codex) Conséquence directe de 0.27.0 : tous les dispatches codex ont la
  recherche web live, car tous les projets ont désormais le web.

### Added
- (tests) `scripts/_test_tools_resolution.mjs` évalue la vraie expression de
  `dispatch.mjs` et le vrai `allowedToolsFor` de `server.js` sur le vrai
  `config.json`. Les 32 projets sont conformes, et les deux résolutions sont
  identiques. `_test_explicit_model.mjs` (55) couvre le nouveau
  comportement de `new-project`.
- (docs) `CLAUDE.md`, puce « Web et lecture pour tous les projets ». Dans
  `I:\Dev\Chef\CLAUDE.md` : section Escalation (web et lecture par défaut),
  et remplacement du paragraphe 0.27.0 « un projet sans `tools` n'a pas le
  web ».

`server.js` est modifié (constante de repli) : redémarrage requis, mais sans
urgence. `config.json` ayant ses défauts, le repli ne sert pas.

## [0.27.0] - 2026-09-27

Contexte : BtLocator doit avoir accès à internet, et trois models doivent
produire chacun un état de l'art indépendant.

### Added
- (dispatch) **`--new-session`** démarre le tour sans `--resume`. L'ancienne
  session n'est jamais effacée : `logs/<p>.session` est archivé en
  `.session.bak-<horodatage ISO>`, et le `session_id` du nouveau tour devient
  le courant. Si l'archivage échoue, le tour est annulé plutôt que de
  reprendre l'ancienne session.
  - L'archivage n'a lieu qu'après la décision de file : une demande mise en
    file n'archive rien. Le flag voyage avec l'entrée (`newSession`), et le
    drain le repasse.
  - API : `POST /api/dispatch {newSession: true}`. `queue.mjs` affiche
    « SESSION NEUVE ».
  - Claude uniquement : ignoré avec `--provider codex`, sans toucher à la
    session claude.
  - Traçabilité : le `user_prompt` porte `newSession` et `archivedSession`.
- (dispatch) **Recherche web pour codex.** `codex exec` n'a pas de `--search`
  (c'est un drapeau de la TUI). La clé de config `web_search`
  (`disabled|cached|indexed|live`) a été vérifiée hors ligne sur codex-cli
  0.154.0 : `live` est accepté, une valeur invalide est rejetée au chargement.
  - `-c web_search=live` est passé quand les `tools` du projet accordent le
    web, rien sinon. C'est le même opt-in que côté Claude.
  - Aucune clé n'est transmise et l'auth OAuth est inchangée. C'est un outil
    côté serveur OpenAI, que le bac à sable ne bloque pas.
  - `system/init.webSearch` le trace. Les recherches apparaissent en
    `tool_use` `web_search` : le mapping existait déjà.
- (cli) **`new-project.mjs --web`** ajoute WebFetch,WebSearch, combinable
  avec `--tools`. Sur un projet déjà enregistré, `--web` ajoute seulement ces
  deux outils, sans jamais rien retirer. Sans `--web`, le script affiche
  « AUCUN accès web ». Le web n'est pas activé par défaut : la règle dure veut
  que tout scope plus large que `Read,Edit,Write,Bash` soit un opt-in par
  projet, car le web ouvre l'injection de prompt et l'exfiltration.
- (tests) `_test_explicit_model.mjs` (56), recette dispatch de bout en bout,
  isolée, sans réseau. Elle couvre :
  - `--new-session` : sans `--resume`, archive intacte, nouveau sid courant,
    trace ; sans session existante ; ignoré avec codex ;
  - le chemin de file ;
  - codex `web_search=live` avec ou sans outils web ;
  - `new-project --web` : nouveau projet, combinaison avec `--tools`, ajout
    sur une entrée existante, idempotence, aucune autre entrée touchée.

  `_test_queue_api.mjs` (45) : `newSession` survit au drain.
  `new-project.mjs` accepte aussi `DISPATCH_ROOT_FOR_TESTS`.
- (docs) `CLAUDE.md`. Dans `I:\Dev\Chef\CLAUDE.md`, section dispatch :
  `--new-session` avec l'exemple des trois études, et « un projet sans `tools`
  n'a pas le web ».

### Changed
- (config, non versionné) `config.json` : `"tools":
  "Read,Edit,Write,Bash,WebFetch,WebSearch"` pour **BtLocator** et
  **SmartKeyGuard**. L'écriture est atomique, et un contrôle a vérifié que
  rien d'autre ne changeait. C'est effectif immédiatement, car `dispatch.mjs`
  relit `config.json` à chaque dispatch.
- (server) `spawnDirectDispatch`, l'entrée de file, le drain et
  `POST /api/dispatch` transportent `newSession`. **`server.js` modifié :
  redémarrage requis** (par le chef) pour `--new-session` via la file et
  l'API. Un `--new-session` passé directement à `dispatch.mjs` fonctionne dès
  maintenant.

## [0.26.0] - 2026-09-27

Règle utilisateur : « si un modèle est précisément demandé, aucun fallback
n'est toléré ».

### Added
- (dispatch) **Model explicite = aucun fallback.** Un model est explicite dès
  qu'il arrive par `--model`, y compris depuis la file, le pool ou l'API, qui
  repassent tous `--model` tel quel. Le tour tourne alors sur ce model ou
  échoue. Ce qui est désormais refusé :
  - le failover Claude → NVIDIA, au démarrage sous limite comme en cours de
    tour ;
  - le repli codex (`FAILOVER_CODEX_MODEL`) ;
  - le repli sur le défaut du projet ou de la flotte.

  Échec propre : `system/fallback_refused` (model demandé, raison), puis un
  `result` `is_error`, `subtype: error_model_unavailable`, avec la cause
  « model demandé X indisponible : <raison> — aucun fallback (règle
  utilisateur) ». Ce result n'est **pas** `synthetic` : le chef est notifié et
  réveillé en ✕. Il omet `duration_api_ms`, donc n'est jamais pris pour un
  result fantôme. Le drapeau de limite de flotte reste posé pour que les
  dispatches sans model explicite continuent de basculer.
- (dispatch) **Détection de substitution.**
  - claude : `system/init.model` et chaque `assistant.message.model`
    (`<synthetic>` exclu). Un écart tue l'arbre du CLI dès l'`init`, avant
    tout travail. `modelUsage` n'est pas utilisé : dans les logs réels, il est
    cumulé sur la session reprise (jusqu'à trois models listés) et inclut des
    appels annexes Haiku, il ne prouve rien pour un tour.
  - codex : son flux `--json` ne donne pas le model, donc la rollout
    `~/.codex/sessions/…-<thread_id>.jsonl` est relue après le tour. Si elle
    est introuvable, `system/model_unverified` est journalisé sans faire
    échouer le tour.

  La correspondance tolère un suffixe de date et un alias nu, mais jamais un
  préfixe : `claude-opus-5-5` ≠ `claude-opus-5`.
- (dispatch) Un tour à model explicite dont le CLI meurt sans `result` (model
  inconnu, par exemple) est clos avec sa cause au lieu de laisser le panneau
  figé.
- (dispatch) `DISPATCH_ROOT_FOR_TESTS` : racine alternative (`config.json`,
  `logs/`) réservée aux recettes. Le drapeau de limite étant à l'échelle de la
  flotte, le simuler dans le vrai `logs/` ferait basculer tous les musiciens.
- (tests) `scripts/_test_explicit_model.mjs` (31) : le vrai `dispatch.mjs` de
  bout en bout avec des doublures `claude`/`codex`, sans réseau. Il couvre :
  - la limite au démarrage et pendant le tour, avec et sans `--model` (le
    failover sans `--model` est inchangé) ;
  - la substitution arrêtée dès l'`init` ;
  - le suffixe de date toléré ;
  - la rollout codex conforme, différente ou introuvable ;
  - le model conservé par la file ;
  - le ✕ et le réveil via le vrai `reduceMusician`.
- (docs) `CLAUDE.md` ; `I:\Dev\Chef\CLAUDE.md`, section models : un
  `--model` explicite ne connaît aucun fallback ; le chef doit rapporter le ✕,
  sans redispatcher sur un autre model sans l'accord de l'utilisateur.

### Changed
- (server) `[fallback-refusé]` est tracé dans `logs/server-debug.log`. Il n'y
  a plus de drain immédiat de la file derrière un ✕ « model indisponible » :
  sous limite, l'entrée suivante échouerait ou basculerait sans rien produire.
  Le balayage de secours s'en charge, jamais sous limite. **`server.js`
  modifié : redémarrage requis** (par le chef).

## [0.25.1] - 2026-09-27

### Fixed
- (dispatch) **Avec `--provider codex`, `--model <id>` était ignoré.**
  `runCodex` retombait sur `'gpt-4o'` codé en dur dès qu'aucun `codexModel`
  n'était configuré, ce qui est le cas du poste. Le `--model` demandé par le
  chef et le défaut de `~/.codex/config.toml` (`gpt-5.6-sol`) étaient donc
  ignorés, alors que le chef n'a pas le droit d'écrire `config.json`. L'ordre
  de choix, hors failover, est désormais :
  1. `--model` ;
  2. `codexModel` du projet ;
  3. `defaults.codexModel` ;
  4. sinon, aucun `--model` n'est passé et codex applique son `config.toml`.

  Le `'gpt-4o'` codé en dur a disparu.

### Changed
- (dispatch) **Le leg de failover codex ne change pas** : c'est le
  `codexModel` configuré, sinon `FAILOVER_CODEX_MODEL`. Le `--model` d'un
  dispatch Claude qui bascule en failover n'atteint jamais codex.
- (dispatch) **Refus avant toute écriture (exit 64)** d'un model Claude
  (`claude|opus|sonnet|haiku|fable…`) avec `--provider codex`, et d'un model
  OpenAI (`gpt|o<n>|codex…`) sans lui, avec un message qui dit quoi faire.
- (dispatch) **Traçabilité** : le `system/init` codex porte `model`, soit le
  model passé, soit celui que désigne `config.toml` quand on laisse codex
  choisir. Il porte aussi `modelSource` (`flag|project|defaults|codex-config|
  failover`). Le `result` codex porte le même `model`.

### Added
- (tests) `_test_pool_chef_dispatch.mjs` (36) : refus réels par
  `dispatch.mjs` sans écriture de log ; ordre de choix évalué sur
  l'expression réelle de `runCodex` (dont le failover inchangé) ; lecture du
  `config.toml` (clé de premier niveau, `CODEX_HOME`, fichier illisible) ;
  plus de `gpt-4o`.
- (docs) `CLAUDE.md` : section « Provider et model d'un dispatch ».
  `I:\Dev\Chef\CLAUDE.md` : « Models OpenAI (via codex) », avec
  `--provider codex --model <id>`, l'ordre de choix, les models disponibles et
  où vérifier le model utilisé.

`server.js` n'est pas touché et `dispatch.mjs` est lu à chaque exécution :
aucun redémarrage n'est nécessaire.

## [0.25.0] - 2026-09-27

On peut acquitter la question d'un musicien **sans le relancer**. Signalement :
« l'affichage montre toujours une question de TranslateOverlay à laquelle j'ai
déjà répondu ».

### Added
- (server) **`POST /api/question/:project/resolve {note?, by?}`**, derrière le
  token gate. La route ajoute au log du musicien un événement
  `notification/question_resolved` (question, note, auteur, horodatage) et ne
  lance aucun tour. Elle renvoie 409 si aucune question n'est ouverte ou si un
  tour tourne. La décision se prend sur une lecture fraîche du log.
- (cli) **`scripts/resolve-question.mjs <projet> [--note "…"]`**, qui lit
  `.token` comme `queue.mjs`. Sortie lisible. Codes : 0 acquittée, 2 rien à
  acquitter ou tour en cours, 3 serveur antérieur à 0.25.0, 1 erreur.
- (web) **« ✓ Marquer comme répondue »** sur la bulle de question du fil (la
  plus récente de ce musicien, s'il attend encore), sur la bande d'attention et
  sur la ligne d'état du panneau. Une bulle acquittée est grisée « ✓ marquée
  répondue » avec la note. La note apparaît aussi dans le journal du panneau
  et dans son état.
- (server) `/api/config` expose `questionResolved` (dernier acquittement), ce
  qui permet de reconstruire la bulle au rechargement.
- (tests) Tests étendus :
  - `_test_wake_report_only.mjs` (41) : `deriveState`/`scanProject`,
    `reduceMusician` et `scanProjectState` réels. Couvre l'acquittement, la
    nouvelle question ensuite, et l'acquittement ignoré quand un tour a démarré.
  - `_test_queue_api.mjs` (43) : route réelle sur express éphémère et vrai
    CLI (refus pendant un tour sans écriture, écriture, codes de sortie).
- (docs) `CLAUDE.md` ; `I:\Dev\Chef\CLAUDE.md` (§4 « Rapporter à
  l'utilisateur » : acquitter quand la réponse passe par le chef ou que la
  question devient sans objet).

### Fixed
- (server) **La carte d'un musicien restait « question » indéfiniment** après
  une réponse donnée via le chef, ou quand la décision avait été prise ailleurs
  (ici par SmartKeyGuard). `/api/mark-read` n'y pouvait rien, puisqu'il ne
  touche que unread/idle.
- (cli) **`fleet-status` affichait « needs: … » hors de l'état `input`.**
  `scanProject` remontait la dernière question pendant le tour suivant, et
  après un acquittement. `needsInput` n'est plus renvoyé que si la question
  est ouverte ; même correctif pour `/api/pupitre`.

### Changed
- (server, web, cli) Tous les réducteurs lisent l'événement `question_resolved`
  avec une règle unique : `input` → `idle`, rien d'autre. Ce ne sont pas une
  fin de tour ni un début de tour : ni notification, ni réveil, ni drain. Le
  pump le journalise `[question]` dans `logs/server-debug.log`.

## [0.24.1] - 2026-09-26

Trois défauts observés le 25/09 (TranslateOverlay, vuBox), causes établies
depuis `logs/*.jsonl` et `logs/server.out`.

### Fixed
- (server) **Réveils en double sur un « result fantôme ».** Au `--resume`, le
  CLI rejoue la notification d'une tâche d'arrière-plan tuée au tour précédent
  en émettant un `result` vide : `num_turns: 0`, `duration_api_ms: 0`,
  `stop_reason: null`, même session et même coût. Ce result arrive **au milieu
  du nouveau tour**, après son `user_prompt` et son `system/init`. Pris pour une
  fin de tour, il avait quatre effets :
  - il réveillait le chef avec le texte du tour précédent (« ✓ 0s ») ;
  - il **consommait l'attente `--callback` du vrai tour**, dont la fin ne
    réveillait plus personne ;
  - il drainait la file en plein tour ;
  - côté chef (181 fantômes dans `chef.jsonl`), il fermait le ticket de pool en
    cours.

  `isPhantomResult()` (`scripts/fleet-status-core.mjs`) le reconnaît. Le pump,
  les scanners d'état (`scanProjectState`, `fleet-status`, `/api/pupitre`),
  `/api/conductor-chat`, `/api/project/:name/events`, le relais
  `NEEDS_CHEF_INPUT`, `healOrphanedLogs` et le client l'ignorent. Chaque
  fantôme ignoré est journalisé `[result-fantôme]` dans `logs/server-debug.log`.
  Les result synthétiques (`num_turns: 1` / `synthetic`) ne sont jamais
  concernés.
- (server) **La file d'un musicien tournait en rond sans jamais partir.** Cause
  exacte : le drain part au `result`, avant que le `claude` du tour ne sorte,
  donc son `.pid` est encore vivant. L'entrée drainée porte `slot` (depuis
  0.22.0), donc le `dispatch.mjs` relancé héritait `DISPATCH_SLOT` et activait
  `--queue-if-busy`. Il voyait alors ce PID et se re-postait en fin de file
  sous un nouvel id. `server.out` montre « auto-dispatch » immédiatement suivi
  de « occupé — mis en file » une douzaine de fois ; c'est une régression
  introduite en 0.22.0. Le drain attend maintenant la mort du processus (pas de
  1 s, 120 s maximum) puis lance avec `--no-queue-if-busy`. Une seule attente
  à la fois par musicien, et une tâche retirée pendant l'attente ne part pas.
- (server) **Drain aussi quand le tour finit en `input`.** Les entrées en file
  sont presque toujours des précisions de l'utilisateur, souvent la réponse à
  la question. La question reste affichée.

### Added
- (server) **Balayage de secours toutes les 30 s.** Une file non vide devant un
  musicien libre (ni `live` ni `think`), sans processus, depuis au moins 60 s,
  est drainée. Cela couvre la file rehydratée au redémarrage, qui n'était
  jamais drainée faute de `result`, ainsi qu'un result manqué. Le balayage ne
  s'applique jamais sous limite Claude ni dans la minute qui suit un lancement
  depuis la file. Il est journalisé `[queue-sweep]`. Chaque lancement depuis la
  file trace aussi son id, sa cause (`result`/`sweep`) et l'attente du PID.
- (dispatch) **Règle de fin de tour** injectée à tout prompt de musicien (pas
  au chef) : ne jamais finir un tour en comptant sur un process d'arrière-plan,
  qui meurt avec le tour. Il faut soit l'exécuter en avant-plan, soit le lancer
  réellement détaché (`Win32_Process Create`) avec un `notify.mjs` vers le chef
  à la fin. La règle n'apparaît pas dans le fil (`promptForLog` inchangé).
- (tests) Tests étendus :
  - `_test_wake_report_only.mjs` (30) : séquence réelle vuBox rejouée dans le
    vrai `reduceMusician` et `deriveState` ; le vrai result garde son
    `--callback`.
  - `_test_queue_api.mjs` (36) : bloc réel du drain et du balayage avec un PID
    pilotable (pas de rebouclage, `--no-queue-if-busy`, retrait pendant
    l'attente, cinq cas où le balayage s'abstient).
  - `_test_pool_chef_dispatch.mjs` (21) : règle de fin de tour.
- (docs) `CLAUDE.md` : section « Fin de tour, file par musicien, results
  fantômes ». Le contrat du chef est inchangé.

### Changed
- (cli) `scripts/fleet-status.mjs` délègue au module partagé
  `fleet-status-core.mjs`. Ce refactor était présent mais jamais committé ; il
  est adopté ici parce que le filtre des fantômes vit dans ce module.

## [0.24.0] - 2026-09-25

On peut retirer une tâche de la file d'un musicien **sans redémarrer le serveur**.

### Added
- (server) **`GET /api/queue/:project`** : état occupé/libre et liste des
  entrées. Chaque entrée donne son id, sa position, un extrait du prompt, sa
  date d'ajout, son model/provider, son callback et le nombre de pièces jointes.
  **`DELETE /api/queue/:project/:id`** retire une entrée (404 si absente) et
  **`DELETE /api/queue/:project`** vide la file. Ces routes sont derrière le
  token gate comme le reste, le projet est validé contre `config.json`, et la
  mémoire et le sidecar changent d'un même geste.
- (server) **Id stable par entrée** (`q-<ms>-<hex>`) et `enqueuedAt`, attribués
  à la mise en file par un point d'entrée unique, `queuePush`. Au boot, les
  entrées existantes sans id en reçoivent un une fois, persisté aussitôt ;
  leur ordre et leur contenu ne changent pas. Les réponses 202 de mise en file
  renvoient l'`id`.
- (cli) **`scripts/queue.mjs <projet> [--list | --remove <id> | --clear] [--json]`**
  appelle l'API en lisant `.token`. Sortie lisible ; codes : 2 pour une entrée
  ou un projet introuvable, 3 si la route est absente (serveur antérieur à
  0.24.0, non redémarré).
- (web) **Le panneau du musicien liste sa file** (« ⏸ En file derrière son
  tour (n) ») avec un bouton **Retirer** confirmé. La liste n'est redemandée que
  si le compte de l'instantané `/api/pupitre` change, sans poll supplémentaire.
- (tests) `scripts/_test_queue_api.mjs` : 21 assertions. Il monte le bloc de
  file et les routes réels de `server.js` sur un express éphémère et pilote le
  vrai `queue.mjs`. Il couvre la migration d'ids stable d'un boot à l'autre,
  la liste, le retrait, le vidage et les 404. Il vérifie surtout qu'une tâche
  retirée ne revient pas après un redémarrage, ce qui était le cas de l'incident.
- (chef) `I:\Dev\Chef\CLAUDE.md`, section « Ne relance jamais un musicien
  occupé » : la file se gère avec `queue.mjs`, jamais via le fichier.

### Fixed
- (server) **Éditer `logs/queue/<projet>.json` à la main ne marchait pas.** La
  mémoire fait foi et réécrit ce fichier à chaque mutation : la retouche était
  écrasée et des tâches déjà faites revenaient en tête (TranslateOverlay,
  25/09). Ce n'est plus nécessaire, le retrait passe par l'API.

## [0.23.1] - 2026-09-25

### Fixed
- (server) **Un résultat attendu n'est plus jamais jeté par le garde-fou
  anti-boucle.** Un musicien dispatché avec `--callback chef` depuis un tour de
  réveil `gen=2` (TranslateOverlay, 25/09) finissait sans que le chef soit
  réveillé : `WAKE_MAX_GEN = 2` faisait jeter le résultat en silence
  (« awaited but gen ≥ MAX — not waking »), et l'utilisateur devait relancer le
  chef à la main. Désormais, au-delà de la borne, le chef est réveillé en
  **rapport seul** : prompt `[CALLBACK_WAKE … mode=rapport-seul]` qui lui dit de
  faire le point sans redispatcher.

### Changed
- (server) **`WAKE_MAX_GEN` passe de 2 à 3** : trois relances automatiques
  (crash → fix → feature → push). Ça ne rouvre pas de risque de boucle, car le
  réveil suivant est en rapport seul, donc terminal, et le budget
  (60 s d'intervalle, 6 réveils/h) s'applique toujours.
- (dispatch) **Le rapport seul est imposé, pas seulement demandé.** Le tour de
  chef concerné tourne avec `DISPATCH_REPORT_ONLY=1`, hérité par son outil Bash.
  `dispatch.mjs` refuse alors tout dispatch avec la sortie 65 et un message qui
  nomme la cible, avant la moindre écriture. Le tour lui-même, lancé par le
  serveur avec `--pool-assign`, n'est pas concerné. On refuse plutôt que de
  lancer sans `--callback` : les deux coupent la boucle, mais la seconde option
  laisserait tourner une 4ᵉ génération de travail autonome (commits, push)
  dont personne ne ferait le point. Aucun musicien lancé ⇒ aucun résultat ⇒
  aucun réveil : la chaîne est finie par construction.
- (server) **Diagnostic en une ligne.** Le champ `reportOnly` est ajouté à
  chaque ligne de `logs/chef.wake-log.ndjson`. `logs/server-debug.log` trace
  la décision au pump et au tir (génération, borne, sources), et le
  `user_prompt` du tour de chef porte `reportOnly: true`.
- (chef) La section CALLBACK_WAKE de `I:\Dev\Chef\CLAUDE.md` décrit le nouveau
  contrat : 3 relances, puis rapport seul, où dispatcher est refusé.

### Added
- (tests) `scripts/_test_wake_report_only.mjs` : 18 assertions sur le bloc de
  réveil réel extrait de `server.js` (chaîne légitime gen 1-3, rapport seul
  au-delà, lot mixte, journaux, disparition de la branche qui jetait le
  résultat). `scripts/_test_pool_chef_dispatch.mjs` étendu (15 assertions) :
  refus en rapport seul par le vrai `dispatch.mjs`, tour du chef lui-même
  autorisé, câblage de `DISPATCH_REPORT_ONLY` côté serveur.

## [0.23.0] - 2026-09-25

La page `/downloads` se modifie **sans redémarrer le serveur**.

### Added
- (server) **`downloads.json`** (racine, versionné, distinct de `config.json`) :
  registre des apps et des docs de `/downloads`, relu à chaud dès que son mtime
  change (un `stat` par requête, pas de watcher). Nouveau module
  `scripts/downloads-registry.mjs` (validation, cache, repli).
- (server) Champs optionnels par app : **`description`** (affichée sous le titre
  de la carte), `label` (titre affiché), `platform`, `version.{file,regex,flags}`.
  TranslateOverlay porte sa description.
- (server) Une app sans `builds/<app>/latest.apk` affiche « APK pas encore
  publié » au lieu d'un bouton menant à une 404.
- (tests) `scripts/_test_downloads_hot.mjs` — 26 assertions : réécrit un
  registre temporaire et constate le changement de la page (rendue par le vrai
  `downloadsPageHtml` extrait de `server.js`) sans redémarrage ; repli sur JSON
  cassé, entrée invalide, fichier supprimé ; validité du `downloads.json` du dépôt.
- (docs) `CLAUDE.md` : section « Page /downloads — ajouter une app ».

### Changed
- (server) `DOWNLOAD_APPS`, `APP_PLATFORM`, `APP_VERSION_SOURCES` et
  `DOWNLOAD_DOCS` quittent `server.js` pour `downloads.json`, migrés à
  l'identique (13 apps dans le même ordre, mêmes versions lues, mêmes
  plateformes, 2 docs — vérifié par comparaison avec l'ancien rendu).
- (server) Validation **tout ou rien** : JSON illisible ou une seule entrée
  invalide ⇒ la dernière version valide reste servie (jamais de 500) et la
  raison est journalisée une fois par version du fichier. Les noms qui entrent
  dans une URL ou sous `builds/` sont contraints (pas de traversée), les regex
  de version doivent avoir un groupe capturant et n'accepter que `i m s u`.

## [0.22.3] - 2026-09-25

### Added

- **(server) TranslateOverlay sur `/downloads`.** Ajout à `DOWNLOAD_APPS`
  (form-factor `phone` par défaut) ; version lue dans
  `I:\Dev\TranslateOverlay\app\build.gradle.kts` via `APP_VERSION_SOURCES`
  (`versionName`, 1.1.0 à ce jour). APK servi depuis
  `builds/TranslateOverlay/latest.apk`.

## [0.22.2] - 2026-09-24

### Fixed

- **(server) La file de direction et le lot de réveil étaient détruits à chaque
  démarrage.** `loadQueuesFromDisk()` balaie `logs/queue/*.json` et supprime
  tout sidecar dont le basename n'est pas un projet de `config.json` — règle
  saine pour une file par musicien, fatale pour `chef.pool.json` et
  `chef.wake.json`, dont le basename (`chef.pool`, `chef.wake`) n'est aucun
  projet. Le balayage tourne ligne 340, bien avant `loadWakeFromDisk()` (553) et
  `loadPoolFromDisk()` (4879) : les deux loaders ne trouvaient jamais rien et se
  taisaient. Un ticket en vol au redémarrage disparaissait donc sans laisser de
  trace au journal du pool. Le point est désormais réservé : le balayage ne
  touche plus qu'à `<projet>.json`.

### Added

- **(server) `scripts/_test_queue_sidecar_sweep.mjs`** — charge le vrai bloc de
  `server.js` dans un bac à sable et vérifie qu'un balayage de boot épargne les
  sidecars à point tout en supprimant encore celui d'un projet retiré de la
  config.

## [0.22.1] - 2026-09-24

### Fixed

- **(server) Tout message au chef mourait en sortie 65 depuis 0.22.0.** Les
  garde-fous de `scripts/dispatch.mjs` (« un chef ne délègue pas à un chef »,
  « un chef ne cible jamais un slot ») lisaient `DISPATCH_SLOT` comme preuve que
  l'appelant est un chef. Or le serveur stampe cette variable sur le tour de chef
  qu'il lance **lui-même** pour remplir le slot : chaque ticket assigné était
  refusé avant d'avoir commencé, `poolReapLost` le remettait en file, puis
  l'abandonnait au 2ᵉ essai (« processus perdu 2× — abandonné »). Le tour
  interrompu par le redémarrage restait affiché tel quel, d'où le
  `turn interrupted (orchestrator restarted or child crashed)` visible au
  dashboard. L'appelant est désormais identifié par un drapeau argv
  `--pool-assign`, que l'héritage d'environnement ne peut pas contrefaire ; les
  deux gardes ne s'appliquent plus qu'à un chef qui parle vraiment.

### Added

- **(server) `scripts/_test_pool_chef_dispatch.mjs`** — recette de la couture
  pool → `dispatch.mjs`. `_test_pool_p0a.mjs` double `spawnDirectDispatch` et ne
  voit donc jamais ce que le fils fait de ses arguments : ce harnais lance le
  vrai `dispatch.mjs` avec l'argv et l'env du serveur, et vérifie aussi que
  `server.js` passe encore le drapeau.

## [0.22.0] - 2026-09-24

**P0-A du pool de chefs : la file devant un chef unique.** Spec :
`docs/orchestrateur-multichef-queue-fable.md` (§5, lots A1→A7). Écrire au chef
pendant qu'il travaille ne tue plus son tour : le message attend, visiblement.
La concurrence n'est PAS ouverte — il y a toujours **un seul chef**
(`conductorPool.size` est lu mais borné à 1) ; le pool de trois est P0-B.
Progression détaillée : `docs/orchestrateur-multichef-impl-progress.md`.

### Added
- (server) **File de direction.** Tout ce qui fait parler le chef devient un
  ticket FIFO persisté (`logs/queue/chef.pool.json`, écriture atomique) avec
  son journal d'audit (`logs/chef.pool-log.ndjson`). Classes : `user`
  (composer), `decision` (relais `NEEDS_CHEF_INPUT`), `point` (lot de réveil
  0.20.0). États `QUEUED → ASSIGNED → RUNNING → DONE|FAILED`, plus `LOST`
  (reprise ×1 en tête, avec note `[REPRISE]`) et `WITHDRAWN`. Un ordonnanceur
  unique (`schedulePool`, sur le modèle de `tryFireWake`) est le seul endroit
  où un tour de chef est lancé : ré-armé plutôt que forcé, rien n'est perdu,
  seulement différé. Gelé sous `logs/claude-limited.until`.
- (server) **`GET /api/pupitre` expose `pool`** : `{ size, model, slots[], queue[] }`.
  Additif ; les slots ne sont PAS ajoutés à `fleet[]` (le rail ne montre jamais
  un chef) et aucun poll supplémentaire n'est introduit.
- (server) **SSE `{type:'pool', reason}`** comme signal « quelque chose a
  changé » ; le snapshot reste la vérité.
- (server) **`DELETE /api/pool/queue/:ticket`** (retirer, rend le brouillon) et
  **`POST /api/pool/interrupt/:slot`** (interrompre sans nouveau message).
- (server) **`GET /api/conductor-chat`** porte `ticket`, `slot`, `queued` et
  `answersTicket` ; les tickets encore en file y sont restitués, donc un
  rechargement retrouve « ⏳ en file · position n ».
- (dispatch) **`--model <id>` et `--provider claude|codex`.** Remplacent la
  « dance » set → dispatch → revert de `config.json` : trois chefs écrivant le
  même fichier, c'est une perte de mise à jour garantie. Sans flag, le
  comportement historique (`project.model || defaults.model`) est strictement
  conservé.
- (dispatch) **`--queue-if-busy` / `--no-queue-if-busy`.** Actif par défaut
  quand `DISPATCH_SLOT` est défini (c'est un chef qui parle). Si la cible a un
  `.pid` vivant, `dispatch.mjs` POSTe au serveur qui range dans la file par
  musicien, au lieu de lancer un second `claude --resume` sur la même session.
  Serveur injoignable ⇒ comportement actuel + avertissement explicite.
- (dispatch) **Stampage d'origine** : `ticket`/`slot` sur le `user_prompt` d'un
  tour de chef, `callbackSlot`/`callbackTicket` sur celui d'un musicien lancé
  par un chef (préparation du retour de point au bon chef en P0-B).
- (web) **Statut sous chaque bulle utilisateur** (« ⏳ en file · position n »,
  « ▸ assigné », « ▸ pris par CHEF 1 · 09:38 ») avec les actions *Retirer* et
  *Interrompre le chef avec ce message* ; **bande « File de direction »**
  repliée/dépliable, sous la bande d'attention, visible seulement si un ticket
  attend ; compteur `file n` dans l'en-tête ; pastille composer
  « À : CHEF (n libre) » ; pill « ↩ répond à … » cliquable quand la bulle visée
  n'est pas juste au-dessus.
- (tests) `scripts/_test_pool_p0a.mjs` — 42 assertions sur le **code réel** du
  pool chargé en bac à sable (dépendances doublées), zéro `claude` lancé.

### Changed
- (server) **L'interruption du chef devient un geste explicite.** `!interrupt`,
  `force_interrupt:true` et `POST /api/pool/interrupt/:slot` tuent toujours le
  tour en vol ; un message ordinaire ne le fait plus jamais. Le message qui
  interrompt passe en tête de file (il remplace le tour qu'il vient de tuer) et
  ne se fait pas doubler par les tickets qui patientaient.
- (server) **Le réveil-callback passe par la file.** `tryFireWake` n'appelle
  plus `spawnDirectDispatch` : il enfile un ticket `point`, servi **après** les
  tickets `user`/`decision`. Le verrou `wake.inFlight` appartient désormais au
  ticket (relâché à la fin de CE tour, ou à son retrait), plus à n'importe quel
  `result` du chef. Un point encore en file est retiré si l'utilisateur écrit
  au chef (même règle anti-doublon payant qu'en 0.20.0).
- (server) **Le relais `NEEDS_CHEF_INPUT`** enfile un ticket `decision` au lieu
  de spawner ; un musicien bloqué passe avec les messages utilisateur.
- (web) Le composer annonce la mise en file **avant** l'envoi ; le libellé du
  bouton ne change pas.

### Fixed
- (server) **`drainQueue` perdait le `callback`.** Une entrée de la file par
  musicien ne portait que le prompt et ses pièces jointes : un dispatch mis en
  file perdait son `--callback chef`, donc le chef attendait un point que le
  musicien n'avait jamais été chargé d'envoyer. Les entrées portent désormais
  `callback`, `source`, `model` et `provider`, et `spawnDirectDispatch` les
  transmet. Les entrées rehydratées d'avant 0.22.0 se comportent comme avant.
- (web) **Deux messages d'affilée se dédoublaient.** Un message mis en file part
  plus tard : quand son écho SSE revient, sa bulle locale n'est plus la dernière
  et la détection d'écho (par texte) échouait. L'écho est maintenant identifié
  par son ticket, le texte restant le repli pour l'historique antérieur.
- (dispatch) Un chef ciblant `chef` ou `chef-N` est refusé (exit 65) avec un
  message clair, au lieu de lancer un second `--resume` sur la session du chef.

## [0.21.3] - 2026-09-24

Suite du réglage d'affichage (web) sur la « Salle de direction » — respiration.

### Changed
- (web) **Gouttière horizontale de la scène élargie et responsive.** La marge fixe de 0.21.1
  (`.main-row { padding: 0 14px }`) laissait le contenu trop serré (bord gauche des cartes/bulles à
  ~32 px du bord). Introduction d'une variable `--stage-gutter: clamp(20px, 2.2vw, 44px)` appliquée
  **symétriquement** à gauche et à droite de `.main-row`. Résultat (bureau) : ~20 px de gouttière sur
  fenêtre étroite, jusqu'à 44 px sur large ; à 1600 px la colonne du fil commence à ~35 px et le bord
  gauche des cadres à ~53 px (35 px de gouttière + 18 px de `.cv-scroll`), nettement décollé. Le rail
  conserve une gouttière **droite égale** à la gouttière gauche (symétrie des deux bords de la scène,
  la marge externe étant portée par `.main-row` pour les deux colonnes). Aucun débordement introduit
  (`box-sizing: border-box`). Mobile (≤ 768 px) inchangé : `.main-row { padding: 0 }` conservé, le fil
  garde les 12 px de `.cv-scroll` et le rail reste une feuille fixe.
- (web) **Cache-busting** relevé à `?v=0.21.3` sur les liens CSS/JS de `public/index.html`.

### TODO
- Généraliser le cache-busting au build/release (injecter la version depuis `package.json`).
- P2 : nettoyage du code mort et des `100vw` résiduels (overlays, mobile, `.chef-card`).

## [0.21.2] - 2026-09-24

Suite du correctif d'affichage (web) sur la « Salle de direction ».

### Fixed
- (web) **Débordement horizontal `.stage { width: 100vw }` → `width: 100%`.** `100vw` compte la largeur
  de la **scrollbar verticale** : dès qu'une scrollbar est présente, `.stage` devient ~15 px plus large
  que la zone visible et, avec `overflow: hidden`, les bords des cadres sont rognés/décalés. `100%`
  correspond à la largeur du `body` (scrollbar exclue) et ne déborde jamais. La gouttière symétrique de
  0.21.1 (`.main-row { padding: 0 14px }`) est conservée.

  **Preuve du mécanisme** (Chrome headless, profil isolé) : sur un cas minimal avec scrollbar
  (`body { overflow-y: scroll }`), une boîte `width: 100vw` mesure **1584 px** (⇒ `scrollWidth −
  clientWidth = 15 px` de débordement) alors qu'une boîte `width: 100%` mesure **1569 px = clientWidth**
  (aucun débordement). **Vérification sur la page live** (profil Chrome dédié, jamais le profil par
  défaut) : à 1600 px, `documentElement.scrollWidth == clientWidth` (débordement 0), `#stage` = 1584 px
  = `innerWidth`, gouttières symétriques (`conductor-view.left = 14`, `rightGutter = 14`), 1ʳᵉ carte non
  rognée (`.cv-missions.left = 32`). À 390 px : débordement 0, colonne pleine largeur, aucun rognage.

  Note : le rendu headless du dépôt (avec `html, body { overflow: hidden }`) mesurait déjà un
  débordement de 0 — mais l'environnement réel de l'utilisateur (scrollbars classiques Windows, gutter
  réservé, zoom) peut exposer la scrollbar ; `100%` rend `.stage` immunisé dans tous les cas.

### Changed
- (web) **Cache-busting** relevé à `?v=0.21.2` sur les liens CSS/JS de `public/index.html`, pour qu'un
  rechargement normal prenne le correctif sans `Ctrl+F5`.

### TODO
- Généraliser le cache-busting au build/release (injecter la version depuis `package.json` plutôt que le
  littéral `?v=…`) — reporté tant que le bump reste manuel.
- Audit ponctuel des autres `width: 100vw` restants : overlays plein écran (`.panel-*`), règles mobiles
  (`.conductor-view`, `.dive`) et l'ancienne `.chef-card` (code mort, non montée) — laissés tels quels,
  aucun ne déborde au niveau du document (vérifié : overlays en `position: fixed`, mobile sans scrollbar
  classique). À nettoyer avec le code mort en P2.

## [0.21.1] - 2026-09-24

Correctif d'affichage (web) sur la « Salle de direction » (0.21.0).

### Fixed
- (web) **Gouttière gauche manquante.** `.main-row` remplissait `#stage` sans marge latérale : la
  colonne du fil (`.conductor-view`) était collée au bord gauche du viewport (`left: 0`) et les bords
  gauches des cadres — bloc **Missions**, cartes de résultat, bulles du chef — n'avaient que les 18 px
  de padding de `.cv-scroll`, si près du bord qu'ils paraissaient rognés. Symétriquement, le rail
  touchait le bord droit (`right: 0`). Ajout d'une **gouttière horizontale de 14 px sur `.main-row`**
  (`box-sizing: border-box`, donc sans débordement), réinitialisée à `0` sur mobile (≤ 768 px, où le
  rail devient une feuille fixe). Vérifié par rendu Chrome headless à 1600 px : bord gauche des cadres
  passé de 18 px → **32 px** (14 px de gouttière + 18 px de `.cv-scroll`), gouttière droite passée de
  0 → 14 px — désormais symétrique. Mobile à 390 px : colonne pleine largeur, aucun rognage.

### Changed
- (web) **Cache-busting.** Les liens CSS/JS de `public/index.html` portent un suffixe `?v=0.21.1` :
  un rechargement normal prend les changements sans `Ctrl+F5` (le HTML est servi du disque à chaque
  requête, donc la nouvelle URL est effective immédiatement, sans redémarrage serveur). À incrémenter
  à chaque release cliente.

### TODO
- Généraliser le cache-busting au moment du build/release (ex. injecter la version depuis
  `package.json` au lieu du littéral `?v=0.21.1`) — reporté, gain marginal tant que le bump reste manuel.

## [0.21.0] - 2026-09-23

Lot **P0** de `docs/orchestrateur-ui-redesign-validated.md`. **La salle de direction.**
Le tableau de bord cesse d'être une scène de cartes qu'il faut interpréter pour devenir une
**conversation de direction avec le chef** : le fil occupe ≈ 2/3 de la largeur, les musiciens
deviennent un **rail de pilotage** compact (des subordonnés, pas des interlocuteurs), et chaque
délégation apparaît comme une **ligne de mission qui vit sur place** dans le tour du chef.
Aucun changement serveur : tout est reconstruit depuis les endpoints existants.

### Added
- (web) **Ligne de mission.** Une ligne naît au `tool_use Bash` du chef dont la commande contient
  `dispatch.mjs <X>` — **le seul signal structuré qui prouve une délégation** — avec `X` validé contre
  la flotte de `/api/config`. Elle passe de « lancée » à « démarrée » quand le `system/init` du musicien
  est **réellement observé**, suit ensuite `/api/pupitre` (activité, tour, sans progrès, PID), puis porte
  son issue et **pointe** vers sa carte du panier (jamais de recopie). Un musicien actif **sans** dispatch
  chef observé (`@X`, file, relais) va dans un bloc **« Activité de l'orchestre »** distinct : jamais
  « mission » sans preuve. Rehydraté au rechargement via `/api/project/<chef>/events?n=500`, avec mention
  explicite de la fenêtre bornée au-delà.
- (web) **Point sur les résultats.** Le prompt de réveil (`source:"wake"`) reste **invisible** (acquis
  v0.20.0) mais son origine est désormais **mémorisée** : le tour qui suit est rendu
  `CHEF — POINT SUR LES RÉSULTATS`, liseré double, aide « ⓘ résultats reçus avant ce tour », et les puces
  « prend en compte » sont **cliquables** (elles défilent jusqu'à la carte du panier et la surlignent).
  Un résultat arrivé **après** le début du point ouvre un **nouveau** panier, jamais ajouté rétroactivement.
- (web) **Bande « À votre attention »** repliée en une ligne — priorité question > processus perdu >
  échec > sans progrès — dépliable avec actions directes ; et **un seul bandeau système** à la fois
  (processus perdu > limite Claude > flux interrompu), les autres en compteur.
- (web) **Volet musicien routé par hash `#/m/<projet>`** : il remplace le rail (plein écran en fenêtre
  étroite), onglets **Activité / Dernier résultat / Journal récent**, en-tête de télémétrie
  `/api/pupitre`, notices de transport rendues au niveau 2 uniquement, action principale
  **« En parler au chef »** et **« Actions avancées »** (envoi direct, parquer, session, marquer lu).
  `Échap` et `‹` = `history.back()` ; le bouton Retour du navigateur fonctionne ; le fil ne défile pas et
  le focus revient à l'élément d'origine.
- (web) **Annuaire « Musiciens / chercher »** accessible partout, **parkés inclus**.
- (web) **Cible du composer affichée** (« À : CHEF », « À : X (direct) » sur `@X`), **contexte de réponse
  retirable**, et avertissement explicite quand l'envoi **interrompra** un tour chef vivant.

### Changed
- (web) **Disposition.** Fil ≈ 2/3 + **rail PILOTAGE** (En cours / À examiner / Tous les musiciens /
  Mis de côté), tri d'attention stable, réordonnancement **différé de 1,5 s** et suspendu sous le pointeur.
  L'état du chef vit désormais **dans l'en-tête** — une seule source visuelle, plus de carte chef dupliquée.
  Sur mobile, le rail devient une feuille ouverte par une ligne « Pilotage : 2 en cours · 1 question › »
  qui remplace la barre d'onglets.
- (web) **Réponse à une question de musicien : via le chef par défaut.** « Répondre via le chef » prépare
  un message au chef citant la question et nommant X ; « Répondre directement à X » reste possible en
  action **secondaire explicite**, avec la mention « mis en file si X est occupé · pas de retour au chef »
  (un dispatch direct n'a pas de `--callback`, donc ni réveil ni point). Conforme à la règle dure du
  `CLAUDE.md` : le routage des réponses est le travail du chef.
- (web) **Honnêteté des affichages.** Coût absent = « coût non fourni » (jamais un faux 0,00 $) ;
  un `/api/notify` manuel s'affiche « Information de X », sans coche ; `pidAlive: null` = « processus
  inconnu », jamais « mort » ; un projet parké affiche « santé non suivie » ; un `result.synthetic` est
  « ⟲ clos par le système », gris, jamais rouge ; un SSE coupé avec instantané frais dit **« direct
  interrompu »** et ne grise rien — les états restent actualisés.
- (web) **Divulgation progressive.** L'activité du chef est repliée par défaut (« n étapes · durée ») et
  le dépliage de l'utilisateur est mémorisé, donc un nouvel événement ne referme pas ce qu'il lit ;
  un panier de plusieurs résultats reste en une ligne ; déplier un panier vaut « lu ».
- (web) Libellés d'état alignés sur la table validée (Prêt · En cours · En cours · réflexion · Votre
  réponse attendue · Terminé / Attend le chef · Échec). **Les clés `idle|live|think|input|error|unread`
  sont inchangées** dans tous les réducteurs, `data-state` et l'app Android.

### Added — Android (vc15 · 0.6.0)
- **Navigation à trois destinations** (`NavHost`) : Journal (racine) · Détail musicien · Réglages, en
  remplacement du `setContent` unique. Le `FleetViewModel` est créé à l'échelle de l'**activité** et
  passé aux destinations : sans cela chaque `NavBackStackEntry` en aurait créé un nouveau (second SSE,
  fil rechargé, ancre perdue). Le retour depuis le détail rend le journal **à la même ancre**.
- **Ligne « Pilotage »** stable sous l'en-tête (`2 en cours · 1 question ›`) ouvrant une **feuille de
  pilotage** avec recherche (parkés inclus) et filtres En cours / À examiner / Tous. La `TabBar`
  disparaît fonctionnellement.
- **Lignes de mission** inline, même règle que le web (preuve = `tool_use Bash dispatch.mjs <X>` du
  chef, nom validé). Tap ⇒ **bottom sheet niveau 1** (demande, issue, durée/coût, file, modèle) ;
  « Ouvrir » ⇒ **écran détail à trois onglets** Activité / Résultat / Journal.
- **Bande « À votre attention »** repliée avec actions, et **un seul bandeau système** à la fois.
- **Pastille « Nouveau rapport ↓ »** : un rapport qui arrive ne vole plus la lecture ni le brouillon —
  le défilement automatique ne s'applique que si l'on est déjà en bas.
- **Version du serveur** via `GET /api/version`, affichée dans l'en-tête et dans Réglages, à côté du
  `versionName` de l'app.

### Changed — Android
- Le fil est **toujours** celui du chef : un musicien s'ouvre en détail, il ne prend pas le fil.
  Réponse à une question **via le chef** par défaut, envoi direct `@X` explicite et annoncé
  (« mis en file si X est occupé · aucun retour au chef »). Cible du composer affichée, interruption
  d'un tour chef vivant annoncée **avant** l'envoi.
- Mêmes règles d'honnêteté que le web : « Information de X » pour un notify manuel, « coût non
  fourni », `pidAlive` inconnu ≠ mort, parké = santé non suivie, résultat synthétique gris.
- Zones tactiles portées à ≥ 44–48 dp sur les actions du fil, de la feuille et des en-têtes.

### Removed
- (web) La scène de cartes absolue, la nappe de fils SVG, la carte chef du panneau droit et la barre
  d'onglets mobile ne sont plus montées. Le code mort correspondant (`computeFanLayout`, `deckRotate`,
  `renderFocusedBody`…) est neutralisé et gardé ; sa suppression appartient au lot P2.
- (android) La `TabBar` n'est plus rendue (le fichier reste pour `blend()`), pas plus que le panneau
  de session par onglet — remplacé par l'écran détail.

## [0.20.0] - 2026-09-23

P0 de `docs/orchestrateur-callback-wake-fable.md`. **Le chef tient enfin sa promesse.**
Quand il dispatchait avec `--callback chef` en annonçant « je te fais le point dès le callback », l'intention
n'était enregistrée **nulle part** : le musicien finissait, la carte s'affichait, mais le chef n'était jamais
réinvoqué — l'utilisateur restait sur une promesse sans suite jusqu'à ce qu'il retape un message.

### Added
- (server + dispatch) **Réveil du chef sur callback attendu.** `dispatch.mjs` stampe désormais `callback:"chef"`
  (et la profondeur `wakeGen`) sur le `user_prompt` d'ouverture du tour : l'attente devient **durable** (elle vit
  dans le log du musicien, donc survit à un redémarrage) et **non ambiguë** (elle appartient à ce tour-là, pas au
  projet). `reduceMusician` la capture et la **consomme au `result`**. Sur un résultat **réel** d'un tour
  **explicitement attendu**, le serveur met le résultat dans un panier, **coalesce 10 s** (plafond 90 s), puis
  déclenche **UN SEUL** tour de synthèse via le spawn programmatique qui existait déjà (`spawnDirectDispatch` →
  `dispatch.mjs --resume`) : le chef repart **sur sa propre session**, donc avec sa promesse en mémoire. Le prompt
  `[CALLBACK_WAKE lot=n gen=k]` lui **donne** le lot (✓ terminé / ✕ échec / ⇄ attend ta décision, durée, coût,
  conclusion) — il ne lit pas `chef.jsonl`.
- (server) Panier persisté (`logs/queue/chef.wake.json`, écriture atomique) et journal des lots tirés
  (`logs/chef.wake-log.ndjson`).

### Changed
- (server) `spawnDirectDispatch` accepte un 5ᵉ paramètre **optionnel** `{source, wakeGen}` (provenance + profondeur).
  Les trois appelants existants — drain de file, raccourci `@`, relais `NEEDS_CHEF` — sont inchangés ; `argv` reste
  un tableau.
- (dashboard + android) Le prompt de réveil (`source:"wake"`) n'apparaît **pas** dans le fil : ce n'est pas un
  message d'un humain. C'est la réponse du chef qui suit, avec son « prend en compte : A ✓ · B ✕ » (acquis
  v0.18.0), qui explique pourquoi il parle sans qu'on lui ait écrit. `/api/conductor-chat` le saute aussi, donc un
  rechargement ne le ressuscite pas en carte.

### Notes — pourquoi ceci ne réintroduit pas le défaut retiré en v0.14.3
L'ancien auto-réveil tirait sur **chaque** fin de musicien, injectait le texte brut du callback comme un faux
prompt **utilisateur**, et **rejouait** les vieux callbacks depuis la file persistée au redémarrage. Chaque garde
répond à l'une de ces trois fautes : **sélectivité** (seulement un résultat réel explicitement attendu — jamais
`/api/notify`, ni `@`, ni un résultat synthétique, ni la fin d'un tour du chef, ni une question adressée à
l'utilisateur, déjà poussée en bulle) ; **coalescence** (un tour par lot, pas un tour par résultat) ;
**génération bornée** `gen ≤ 2` propagée par l'environnement (utilisateur → réveil 1 → réveil 2 → stop) ;
**jamais d'interruption** (un chef occupé n'est pas tué — on tire quand il redevient libre ; un PID fantôme, lui,
débloque) ; **débit** (60 s entre tirs, 6/heure, aucun tir sous limite Claude) ; **annulation** (si l'utilisateur
écrit au chef, le panier est jeté — son propre tour montrera les résultats, zéro tour payé en double) ;
**idempotence** (clé par résultat, panier persisté, TTL 6 h → **un** rattrapage borné au redémarrage, jamais un
rejeu). Un échec **réveille aussi** (avec ✕) : la mauvaise nouvelle fait partie de la promesse.

### Notes
- Périmètre **P0**. P1 non fait : réveil sur tour attendu stallé / PID mort / clôture synthétique, exposition de
  `expectCallback` et `pendingWake` sur `/api/pupitre`, compteur de budget visible, garde de liveness dans
  `spawnDirectDispatch`.
- **Le contrat du chef reste à appliquer par le chef lui-même** (`I:\Dev\Chef\CLAUDE.md` appartient à son
  projet) : texte exact dans `docs/orchestrateur-callback-wake-impl-progress.md` § Lot 4. Sans lui, le chef
  continuera à promettre sans passer `--callback chef`, et rien ne le réveillera.
- Acquis préservés : v0.16.1, v0.17.0, v0.18.0, v0.19.0. Vocabulaire d'états inchangé.
- Vérifié : 20 assertions sur fixtures (`.tmp/wake-logic.mjs`) couvrant **tous** les garde-fous, sans spawner un
  seul processus `claude` ; chaîne de générations testée de bout en bout ; formes d'événements de `dispatch.mjs`
  vérifiées ; client headless (prompt `wake` invisible, callback réel toujours en carte, séquence poussée =
  `results,conductor` + « prend en compte ») ; `node --check` sur `server.js` et `dispatch.mjs` ; Android compilé.
- **`server.js`, `dispatch.mjs` et `public/` modifiés → un redémarrage 7777 par le chef** (`dispatch.mjs` est relu
  à chaque appel ; le client est statique → hard-reload).

## [0.19.0] - 2026-09-23

P1 de `docs/orchestrateur-events-redesign-fable.md`, **priorité mobile** : l'app Android rattrape le P0 web.
Symptôme utilisateur traité : « je ne vois plus les retours du chef » et un musicien planté restait « EN COMMUNICATION »
indéfiniment sur le téléphone. Vocabulaire d'états **inchangé** — tout est badges, bandeaux et champs additifs.

### Added
- (android vc14 / 0.5.0) **L'app interroge enfin `/api/pupitre`.** Elle ne consommait QUE le flux SSE, qui ne peut pas prouver qu'un producteur est mort ni qu'un tour est silencieux (ces signaux viennent du sidecar `.pid` et du mtime du log, côté serveur). Poll toutes les 5 s **au premier plan uniquement** (démarré/arrêté avec le SSE par le cycle de vie), qui alimente : **stall**, **PID mort**, durée du tour, silence, modèle observé, profondeur de file.
- (android) **2ᵉ ligne de panneau musicien** (`TelemetryStrip`) : activité, `tour 3m12`, `silence 1m20`, `pid 1234 ✓/✗`, modèle, file — avec un bandeau **« ⚠ PROCESSUS PERDU »** ou **« ⚠ SANS PROGRÈS OBSERVÉ »** quand la télémétrie le prouve. Les pastilles d'onglet portent le même signal (`✗` / `⚠` / `⇄`) pour qu'un musicien planté se voie **sans ouvrir l'onglet**.
- (android) **Parité du fil chef avec le web** : **panier « Résultats reçus (n) »** (un résultat qui arrive pendant un tour du chef est retenu et publié **après** sa réponse, jamais inséré au milieu ; replié quand plusieurs arrivent, ouvert pour un seul) ; **cartes de résultat** à liseré de la couleur de l'issue avec durée, coût et résumé ; **question d'un musicien** en bulle dédiée qui **saute le panier** ; en-tête **« prend en compte : A ✓ · B ✕ »** sur la réponse du chef ; réponse du chef marquée **« QUESTION »** quand elle se termine par `NEEDS_USER_INPUT`. Le rechargement de l'historique rejoue exactement le même ordre.
- (android) **Bandeau système** (jamais une bulle) : **« ⚡ Claude limité jusqu'à HH:MM »** (depuis `limitedUntil`) et **« ⟲ données anciennes »** quand le poll de télémétrie échoue — l'écran cesse de faire passer des valeurs figées pour des valeurs à jour.
- (server) `/api/pupitre` expose le champ additif **`awaitingChef`** (dérivé dans `deriveState`) : un musicien qui a fini mais attend une décision du chef. L'état reste `unread`.

### Fixed
- (android) **L'onglet ne saute plus sous le doigt.** Un musicien remontait en tête de liste à **chaque** transition (`live→think→live` est incessant), donc la pastille visée se déplaçait pendant le tap. Il ne remonte plus que lorsqu'il se met à **réclamer** quelque chose (`input` / `error`).
- (android) **Callbacks dupliqués.** La `notification` et le `user_prompt` sourcé relayé portent le même texte : l'app les affichait deux fois (le web dédupliquait déjà). Ils sont désormais fusionnés en une seule carte.
- (android) **`@musicien` n'est plus rendu comme un callback de musicien** : un prompt `source="shortcut→X"` est le message de l'utilisateur, il reste une bulle utilisateur.

### Notes
- Périmètre **P1**. Non fait, volontairement : repliage de l'activité intermédiaire du chef sur mobile (chaque outil reste une ligne — **P2**), bandeau « Attention » agrégé côté web, notices `log_growth_skipped`, tri différé côté web.
- Acquis préservés : v0.16.1 (chef figé), v0.17.0 (tri d'attention, cache `/api/pupitre`, skip parked) et v0.18.0 (panier web, cartes enrichies, questions, question du chef conservée), ainsi que « synthétique ≠ échec » côté Android.
- Vérifié : `node --check` sur `server.js` et `scripts/fleet-status-core.mjs` ; `deriveState` testé (NEEDS_CHEF_INPUT → `unread` + `awaitingChef`, question utilisateur → `input`, nouveau tour → remis à zéro) ; `scanProject` expose bien `awaitingChef` ; build Android **sans warning**, APK vc14 / 0.5.0-debug.
- **`server.js` et `scripts/fleet-status-core.mjs` modifiés → un redémarrage 7777 par le chef** (l'app affiche simplement `awaitingChef=false` jusque-là ; tout le reste du P1 mobile fonctionne sans redémarrage). APK : `I:\orchestrateur\android\app\build\outputs\apk\debug\app-debug.apk`.

## [0.18.0] - 2026-09-22

Redéfinition des événements et de leurs enchaînements — P0 de `docs/orchestrateur-events-redesign-fable.md`.
Problème traité : « les callbacks sont délivrés, mais pas au bon moment ». Vocabulaire d'états **inchangé**
(`idle|live|think|input|error|unread`) — tout est badges, regroupements et champs additifs.

### Added
- (dashboard) **Panier de résultats.** Un résultat de musicien qui arrive **pendant** un tour du chef n'est plus inséré au milieu de ce tour : il est retenu puis publié **après** la réponse du chef, dans un groupe « Résultats reçus (n) » — replié quand plusieurs atterrissent d'un coup, ouvert pour un seul. Le tour du chef suivant affiche l'en-tête **« prend en compte : A ✓ · B ✕ »**, qui rend le lien visible **sans déclencher le moindre tour** (l'acquis v0.14.3 est préservé). Le filet PID vide le panier, donc un tour qui ne se termine jamais ne peut pas y piéger de résultats. Le rechargement (`loadChatHistory`) reconstruit exactement le même ordre.
- (dashboard + server) **Carte de résultat enrichie.** La `notification` porte désormais `outcome`, `summary`, `duration_ms`, `cost_usd` et `awaitingChef` (**champs additifs** — les anciens callbacks s'affichent comme avant). Le résumé est le **dernier paragraphe** du résultat (la conclusion du musicien), plafonné à 280 caractères sur une coupure de mot, au lieu du `slice(0, 600)` qui tronquait l'introduction en plein milieu. Rendu en **carte** à liseré de la couleur de l'état, avec durée, coût et un bouton « voir ».
- (dashboard + server) **Question d'un musicien dans le fil du chef.** Un `NEEDS_USER_INPUT` émet une `notification/musician_question` et **saute le panier** : bulle « X te demande » avec un bouton qui préremplit `@X`. Auparavant il fallait repérer une carte orange.
- (dashboard) **Différenciation graphique des trois voix** : l'utilisateur et le chef dialoguent en bulles (chef = liseré ambre + ♛), le **musicien ne dialogue pas** — il rend compte via une carte ; le système reste en bandeau/badge.

### Fixed
- (server) **« Attend le chef » n'est plus annoncé comme « terminé ».** Un tour qui se clôt sur `NEEDS_CHEF_INPUT` porte le drapeau additif `awaitingChef` (l'état reste `unread`) : la carte affiche « ATTEND LE CHEF » et la carte de résultat un ⇄ + badge. Cela règle du même coup la **course** entre la pompe SSE qui relaie la question au chef et le watcher qui écrivait « Tour terminé » dans le log du chef.
- (server) **Un `result` synthétique n'émet plus de callback du tout** (tour clos par le système : redémarrage, crash, quota) — il ne pollue plus le fil du chef avec du non-travail. Un **échec** réel, lui, émet désormais une carte `failed` (avant : silence total).
- (server) **La question du chef n'est plus supprimée de l'historique.** Une réponse se terminant par `NEEDS_USER_INPUT` était purement et simplement jetée par `/api/conductor-chat` : elle disparaissait à chaque rechargement. Elle est conservée et marquée comme question.
- (android vc13 / 0.4.8) **Un `result` synthétique n'est plus affiché comme une ERREUR rouge** (`Musician.kt`) : il devient `idle` avec sa cause (« limité (quota) », « interrompu »), comme le font déjà le serveur et le web. Une pause de quota ressemblait à un crash. Seul point touchant un reducer — c'est un **alignement** de plateforme, pas une nouvelle chaîne d'état.

### Notes
- Périmètre **P0 strict**. P1 (bandeau attention, limite 5 h visible, badge « attend le chef » sur `/api/pupitre`, snapshot pupitre mobile, notices de transport, tri différé) et P2/P3 non faits. Rien de la section « Écarté » n'a été implémenté.
- Acquis préservés : v0.16.1 (chef figé) et v0.17.0 (tri d'attention, 2ᵉ ligne, fraîcheur, cache `/api/pupitre`, skip parked, pas de drain sur synthétique).
- Vérifié : headless sur le vrai client (panier retenu puis publié après la réponse, 3 callbacks → 1 panier, « prend en compte », durée/coût/résumé, rétro-compat, question qui saute le panier, ⇄ + badge, « ATTEND LE CHEF », tag question ; **0 erreur console**) ; ordre identique au rechargement ; `summarizeResult` testé isolément ; `node --check` sur `server.js` et `public/app.js` ; APK vc13 construit.
- **Client = hard-reload. Serveur = un redémarrage 7777 par le chef.** APK : `I:\orchestrateur\android\app\build\outputs\apk\debug\app-debug.apk`.

## [0.17.0] - 2026-09-19

### Added
- (dashboard) **Refonte affichage des musiciens — P0 (Lots 1 & 2, client seul, hard-reload).** D'après `docs/orchestrateur-redesign-validated.md`.
  - Rendu exact : « PID MORT » prioritaire sur « SANS PROGRÈS » ; libellés d'état **français orientés action** (EN COURS / RÉPONSE REQUISE / TERMINÉ · non lu…) — **libellés d'affichage seulement, les clés d'état restent verrouillées** ; le briefing « à vérifier » compte aussi erreurs et tours bloqués ; le détail live affiche l'`assistant` consolidé quand aucun bloc de streaming n'a été rendu (récupère le contenu Codex / après un trou SSE).
  - Cartes lisibles : **tri par attention** (bloqué/erreur/question/en cours/non lu/prêt) puis nom, **stable** (fin du réordonnancement par fréquence) ; **2ᵉ ligne de carte** depuis `/api/pupitre` (PID ✓/✗, durée du tour, modèle observé) ; producteur mort surligné.
  - **Pastille de connexion / fraîcheur** dans la barre : SSE coupé → « hors ligne », `/api/pupitre` muet → « données anciennes », sinon « en ligne ». Poll `/api/pupitre` à 5 s, onglet visible seulement.

### Changed / Fixed
- (server) **P0 Lot 3 — nécessite un redémarrage du serveur 7777 (fait par le chef).**
  - **File `@` non consommée à vide pendant une fenêtre limitée** : le pump ne draine plus la file sur un `result` **synthétique** (`ev.synthetic`) — sinon la garde no-failover enchaînait tous les éléments en produisant des synthétiques, sans aucun travail (régression introduite par le `result` synthétique de v0.16.1).
  - **`/api/pupitre`** : cache par log (clé `mtime`+`size`, TTL 2,5 s) et **projets `parked` non scannés** → supprime la relecture synchrone de 29 logs (dont 13 parkés) à chaque requête × clients ; champs additifs `queueDepth`, `noFailover`, `limitedUntil`.
  - **Reducers** : un `user_prompt` **sourcé** (callback / `@shortcut` / `/api/notify`) ne démarre plus un tour (`scanProjectState`, `reduceMusician`, `deriveState`, et le reducer de carte client) — seul un prompt sans source ou un `system/init` le fait (un dispatch `--source` émet un init).
  - **Route morte `/sse/logs/:project` supprimée** (aucun consommateur ; lisait depuis l'offset 0 et allouait le fichier entier — lecture synchrone de 300+ Mo pouvant faire tuer le serveur par le watchdog).
  - **Watcher de notifications borné** : lecture par blocs de 4 MiB avec continuation `setImmediate` (plus d'allocation illimitée sur un gros append), sans manquer d'événement.
  - **`healOrphanedLogs`** : `lastNonPartialType` ignore désormais `notification` et `user_prompt` sourcé → plus de faux `result` synthétique ajouté au boot après un simple callback.
- (server) Durcissement du boot (2026-09-16) committé séparément : une erreur de bind sur le port sort proprement au lieu de laisser un process zombie (voir commit dédié).

### Notes
- Périmètre strict P0 (Lots 1–3). Pas de P1/P2/P3 ni « sur-ingérie écartée ». Le fix « chef figé » v0.16.1 est préservé.
- Vérifié : headless (rendu exact, tri, télémétrie carte, pastille connexion) ; `deriveState` (callback/@shortcut → pas de tour, init → tour) ; `node --check` sur `server.js`, `scripts/fleet-status-core.mjs`, `public/app.js`. **Client = hard-reload ; serveur = 1 redémarrage 7777 par le chef.**

## [0.16.1] - 2026-09-18

### Fixed
- (dashboard + dispatch) **Fix chef figé « LE CHEF RÉPOND… » persistant (P0, d'après `docs/chef-stuck-analysis-validated.md`).** Trois changements minimaux, sans redémarrage serveur :
  - **P0-a — drapeau conditionné à un vrai tour** (`public/app.js`) : `_awaitingConductorResponse` n'est plus armé que par un `user_prompt` **sans `source`** (vrai message utilisateur) ou par un event `system/init` (tout tour `claude -p`, y compris un dispatch lancé avec `--source`). Un callback musicien et un raccourci `@musicien` (qui portent un `source`) **n'arment plus** l'indicateur. `result` continue de le désarmer. Corrige aussi F5 : le message `@shortcut` s'affiche désormais comme bulle **utilisateur** (avec dédup d'echo local), plus comme fausse bulle « callback ».
  - **P0-b — filet de sécurité par liveness du PID** (`public/app.js`) : timestamp d'armement mémorisé ; un ticker toujours actif (5 s) + la réouverture SSE appellent `_conductorLivenessCheck`, qui, si le drapeau est armé depuis > 20 s et que la ligne chef de `/api/pupitre` a `pidAlive !== true`, **désarme** et ferme la réflexion ouverte. Sens de la panne sûr : un PID vivant (même outil long silencieux) garde l'attente. Couvre `result` manqué sur coupure SSE, dispatch tué/planté, échec de spawn, sortie no-failover.
  - **P0-c — clôture du tour en no-failover** (`scripts/dispatch.mjs`) : aux deux sorties `NO_FAILOVER` (fin de tour + démarrage), un `result` synthétique `{is_error:true, synthetic:true, subtype:'error_limited'}` est écrit **avant** `endLogAndExit(1)`, sinon chaque prompt reçu pendant une fenêtre limitée laissait un tour ouvert (chef figé). La convention `is_error && synthetic → idle` est déjà comprise par les reducers ; aucune réponse réussie n'est fabriquée.

### Notes
- Périmètre strict P0 : **aucun** changement P1/P2 (reducers serveur, route `/sse/logs`, bornage watcher, `healOrphanedLogs`, conversion `/api/notify`, turnId/superviseur). Chemin du callback AUTO inchangé. App Android non touchée.
- Vérifié headless : handlers client rejoués dans le vrai `app.js` (callback → pas de pastille ; `@shortcut` → pas de pastille, rendu utilisateur ; `user_prompt` sans source → pastille ; `system/init` → pastille ; `result` → effacée ; filet PID : mort+>20 s → désarmé, vivant → gardé, <20 s → gardé ; 0 erreur console). `node --check` OK sur `app.js` et `dispatch.mjs`. Réplique isolée des sorties no-failover → log terminé par un `result` lu comme idle.
- **`public/app.js` est statique → un hard-reload du dashboard suffit ; `dispatch.mjs` est relu à chaque appel. AUCUN redémarrage du serveur 7777 requis.**

## [0.16.0] - 2026-09-17

### Added
- (server / dispatch) **Kill-switch failover via sentinelle `logs/no-failover`** (`scripts/dispatch.mjs`). Quand le fichier `logs/no-failover` existe, le dispatch ne bascule **JAMAIS** vers un autre modèle (ni NVIDIA, ni codex) sur limite de session Claude : il **écrit quand même** la date de reset dans `logs/claude-limited.until`, loggue un event `system/limited-no-failover`, puis **s'arrête proprement** (`endLogAndExit(1)`). Garde placée aux deux points d'entrée du failover (fin de tour `lifecycleEnd` + démarrage), **avant** `runNvidiaFailover()`. But : garantir « Opus 4.8 uniquement, jamais de bascule » pour un run autonome de nuit. Réversible : supprimer la sentinelle réactive le failover. Branche `provider === 'codex'` intacte. Vérifié `node --check` (0 erreur).

## [0.15.1] - 2026-09-16

### Fixed
- (server) **Plus de serveur zombie après un `EADDRINUSE`.** Au logon, la tâche planifiée et le watchdog lançaient chacun un serveur ; le perdant recevait `EADDRINUSE`, mais `express-ws` ré-émettait l'erreur sur le `WebSocketServer` sans listener → `uncaughtException` simplement loggée → process vivant (heartbeats) mais **non lié au port 7777**, qui gardait `logs/server.out` ouvert. Fix : listener `error` sur le WSS ; dans `httpServer.on('error')`, si un orchestrateur sain répond déjà sur `/healthz` → l'instance sort (exit 0) au lieu de le tuer, sinon 3 tentatives puis exit 1 ; filet de sécurité : tout process non lié au port depuis 90 s se termine.
- (server) **Le watchdog tuait un serveur simplement lent** (`scripts/server-watchdog.mjs`). Les échecs de probe sont désormais classés : **DOWN** (connexion refusée / port non lié) → restart après ~20 s ; **SLOW** (timeout alors que le port est lié) → restart seulement après ~3 min de gel continu. Timeout de probe 4 s → 8 s.
- (server) **Le watchdog relançait pendant le démarrage** : période de grâce de 90 s après son lancement (la tâche serveur n'a pas encore bindé le port au logon).
- (server) **Les relances échouaient en boucle (`cmd start exited 1`, 59 fois)** (`scripts/restart-orchestrateur.mjs`) : si `logs/server.out` est verrouillé (`EBUSY`), la sortie bascule sur `logs/server-<horodatage>.out` ; pas de lancement si un serveur répond déjà.

## [android 0.4.7 / vc12] - 2026-09-11

### Fixed
- (android) **Biométrie : « doigt posé → rien ne se passe » corrigé** (`ui/login/LoginScreen.kt`). L'invite BiometricPrompt s'affichait et le capteur scannait, mais poser le doigt ne faisait rien et **aucun message** n'apparaissait. Cause : `triggerBiometric` demandait `BIOMETRIC_STRONG | DEVICE_CREDENTIAL` **sans** bouton négatif — combo non fiable (mélanger `DEVICE_CREDENTIAL` avec un negative button est illégal ; sur le capteur OEM MTK/sunwave de ce device le prompt scannait sans jamais router le résultat) — et **seul `onAuthenticationError` était géré** : ni `onAuthenticationSucceeded` fiable, ni `onAuthenticationFailed`, ni feedback UI. Fix : config canonique fiable **`BIOMETRIC_STRONG` + `setNegativeButtonText("Annuler")` + `setConfirmationRequired(false)`** ; succès routé vers `onSuccess → step=Ready → onUnlocked()`.

### Added
- (android) **Feedback clair sur l'écran de déverrouillage** : empreinte lue mais non reconnue (`onAuthenticationFailed`) → « Empreinte non reconnue, réessayez. » ; erreur capteur/config (`onAuthenticationError` hors annulation volontaire) → message avec code ; annulation utilisateur → écran propre, pas de nag. Fini le « rien ne se passe » silencieux.
- (android) **Breadcrumbs logcat** (tag `OrchBiometric`) sur `canAuthenticate` + les trois callbacks (succeeded / failed / error+code) → un retest par l'utilisateur (vrai doigt) révèlera exactement ce qui se produit.

### Notes
- Non-régression : les fixes vc11 (vignette sélectionnée visible, chef conserve son tour) et l'entrée dans le fleet sont intacts. Le contournement silencieux quand aucune empreinte n'est enrôlée est **retiré** — l'utilisateur voit désormais un message explicite au lieu d'entrer sans auth.
- Vérifié live sur `V30T…12908` (Android 12) : prompt affiché (`mCurrentFocus=BiometricPrompt`), HAL armé, breadcrumb `canAuthenticate(BIOMETRIC_STRONG)=0` (SUCCESS), annulation → `onAuthenticationError code=10` loggé + écran propre. **Le succès réel (doigt physique → entrée) n'est pas injectable via adb → à RETESTER par l'utilisateur** ; le logcat `OrchBiometric` montrera `onAuthenticationSucceeded` (→ entre) ou `onAuthenticationFailed` (→ finger non matché, message affiché).

## [0.15.0] - 2026-09-11

### Added
- (server + dashboard) **Ajout/retrait d'un musicien pris À CHAUD, sans redémarrer le serveur 7777.** Le serveur ne rechargeait la liste des projets de `config.json` qu'au démarrage ; désormais `config.json` est **surveillé** (chokidar, gère le temp+rename de `atomicWriteJson`) **et re-lu en fallback toutes les 3 s**. À un vrai changement, la liste en mémoire (`config.projects`, `PROJECT_NAMES`) est **réconciliée en place**, les flux par-projet (`fleetEnsureProject`) créés/fermés, les **dashboards déjà connectés abonnés aux nouveaux flux**, et un signal SSE `fleet_config_changed` est **poussé** ; le client web (`public/app.js`, `refreshFleet`) re-fetch `/api/config` et **réconcilie la liste des musiciens sans rebuild** (ajout/retrait, états live préservés). `dispatch.mjs` lisait déjà `config.json` frais à chaque dispatch — inchangé.
- Robustesse : un `config.json` temporairement invalide (écriture en cours / JSON cassé / entrée sans `name`) est **ignoré** — la dernière liste valide est conservée, le serveur ne crashe pas, retry au prochain écrit stable. `parked:true` reste géré comme avant.

### Notes
- Vérifié : logique de reload isolée (ajout → détecté, retrait+conductor → détecté, JSON invalide/entrée sans nom → liste précédente conservée, inchangé → no-op) ; réconciliation client en Chrome headless (musicien fictif retiré au reconcile, musicien réel ré-ajouté, 0 erreur console). `Jarvis-Career` est déjà dans `config.json` → listé dès le déploiement. **Changement server.js → un dernier restart du serveur 7777 (par le chef) pour DÉPLOYER le hot-reload ; ensuite les ajouts/retraits de musiciens sont pris à chaud sans restart.**

## [0.14.4] - 2026-09-11

### Added
- (server) **L'app compagnon `orchestrateur` est désormais listée sur `/downloads`** (`server.js`). Ajout de `'orchestrateur'` en tête de `DOWNLOAD_APPS` + source de version `APP_VERSION_SOURCES.orchestrateur` = `android/app/build.gradle.kts` (lue automatiquement → v0.4.6, plateforme `phone` par défaut). L'APK `builds/orchestrateur/latest.apk` (déjà présent, vc11/0.4.6) devient téléchargeable via `/downloads/orchestrateur/apk`. **Changement server.js → restart du serveur 7777 requis (par le chef) pour que la carte apparaisse.**

## [android 0.4.6 / vc11] - 2026-09-11

### Fixed
- (android) **Une vignette sélectionnée mais idle disparaissait de la barre et devenait inaccessible** (`ui/fleet/TabBar.kt`). Sélectionner une vignette la marque lue → elle passe `idle` (priorité 3) et le tri « travailleurs à gauche » la renvoyait tout à droite, hors écran ; en sélectionnant une autre, on ne pouvait plus y revenir. La vignette **active est désormais épinglée à gauche** (`tabPriority` renvoie -1 pour `activeTab`, clé `remember` incluant `activeTab`) → la sélection reste toujours visible et re-sélectionnable. Le tri des autres (live/think à gauche, idle à droite) est conservé.
- (android) **Le panneau du chef effaçait sa réflexion/texte au lieu de tout garder** (`ui/fleet/FleetViewModel.kt`, `MainPane.kt`). Le contenu mi-tour du chef (thinking/texte) ne vivait que dans le buffer transitoire `liveText` (réinitialisé à chaque bloc, vidé à la consolidation) ; seul le `result` final persistait. Désormais chaque bloc consolidé du chef (thinking, tool_use, texte intermédiaire, résultat d'outil) est **accumulé comme entrée persistante** (`ChatMsg.Role.activity`, rendue en lignes compactes distinctes) dans l'ordre, **rien n'est effacé** ; le tour reste lisible et scrollable. La synthèse finale reste la bulle `conductor` (dédup du texte final pour éviter le doublon). `versionName` 0.4.5 → **0.4.6**, `versionCode` 10 → **11**.

### Notes
- Non-régression : cartes musicien (tool_use détaillés/pas de trous — vc9), liens cliquables (vc10, `LinkableText`), scroll d'ouverture en bas, tri « travailleurs à gauche », header version propre, streaming live — préservés. Compile OK (assembleDebug BUILD SUCCESSFUL). **Non installé sur device ce tour (téléphone déconnecté)** — APK fourni pour copy-build.

## [0.14.3] - 2026-09-09

### Fixed
- (server) **Fix RACINE : un callback de fin de tour d'un musicien ne réinvoque plus le chef comme un faux tour utilisateur** (`server.js`, `autoNotifyConductor`). La fonction écrivait la notification `musician_done` PUIS **dispatchait le texte « [musicien] Tour terminé… » au chef comme un vrai tour** (un `user_prompt` sans `source`) — d'où : rendu comme message « de l'utilisateur » dans le dashboard, chef **forcé de répondre « pour rien »** à chaque complétion, et rejeu d'anciens callbacks depuis la file persistée au restart. Le re-dispatch est **supprimé** : une complétion n'est plus qu'un **événement du musicien** — la notification `musician_done` (visible par l'humain, rendue comme callback du musicien dans le dashboard) + le `result` du musicien déjà présent dans `logs/<projet>.jsonl`, que le chef lit à son rythme pour faire un retour à l'utilisateur. Plus de faux tour utilisateur, plus de réponse forcée, plus d'attribution à l'utilisateur.
- Le fix client v0.14.1 (reclassement/dédup d'affichage) reste en place comme défense en profondeur ; avec ce fix serveur il n'y a même plus de `user_prompt` relayé à reclasser.
- **Non-régression** : le vrai chat chef↔utilisateur est intact (les messages réels via le composer / `/api/dispatch` restent des tours utilisateur normaux → réponse du chef) ; le relais NEEDS_CHEF (question explicite musicien→chef) est inchangé ; l'affichage temps réel, le SSE, les cartes et les toasts de fin de tour restent. `logs/queue/` vide → aucun rejeu résiduel. **Changement server.js → restart du serveur 7777 requis (par le chef) pour déployer.**

## [0.14.2] - 2026-09-09

### Fixed
- (server) **`/downloads` page blanche sur le navigateur Android TV (MiBox)** (`server.js`, `downloadsPageHtml`). La page (HTML server-rendered, sans JS) tirait ses polices d'un `<link>` **render-blocking** vers `fonts.googleapis.com`. La TV atteint `myhost:7777` sur le LAN mais n'a pas/plus d'accès internet, donc la requête police **pend** et le vieux WebView **bloque le premier paint indéfiniment → page blanche, sans erreur**. La page est désormais **entièrement autonome** : plus aucun `<link>`/ressource externe, polices en **fallback système** (`'Chakra Petch','Segoe UI',Roboto,system-ui,sans-serif`). Bonus compat vieux moteur : l'espacement passe de **flex `gap`** (Chromium 84+) à des **marges** (universelles) pour ne pas cramer les cartes. Contenu essentiel (liste des apps + liens `.apk`) inchangé et fonctionnel.
- Vérifié : rendu de la page (isolé) **sans aucune URL externe / sans `<script>`**, et affichage en **Chrome headless simulant la MiBox** (user-agent Android TV Chrome/77 + réseau **offline**) → 3 cartes visibles, badges, lien `/downloads/vuBox/apk` présent, body non vide (plus de page blanche). Rendu desktop inchangé. **Changement server.js → restart du serveur 7777 requis (par le chef) pour déployer.**

## [0.14.1] - 2026-09-08

### Fixed
- (dashboard) **Callbacks des musiciens affichés comme messages utilisateur, en double, et rejoués** (`public/app.js`). Cause : quand un musicien finit un tour, `autoNotifyConductor` (serveur) écrit un event `notification`/`musician_done` (bulle callback) **puis** dispatche le même texte « [musicien] Tour terminé… » au chef comme un vrai tour — dont le `user_prompt` n'a **pas** de `source`, donc le client le rendait comme un message **utilisateur** ; la file de dispatch persistée pouvait aussi rejouer d'anciens callbacks. Correctifs côté client (idempotent, aligné sur l'historique serveur) :
  1. Un `user_prompt` sans source qui matche `^[musicien] Tour terminé…` est **reclassé en callback** du musicien concerné — jamais rendu comme message utilisateur (`onConductorEvent` + `loadChatHistory`).
  2. **Dédup par contenu** (`_callbackDup`) : la notification `musician_done` et le dispatch relayé portent le même texte → une **seule** bulle callback ; `loadChatHistory` déduplique aussi les callbacks de l'historique serveur.
  3. **Plus de re-post d'anciens callbacks** : un callback déjà présent (même texte) est ignoré au live (SSE/queue replay) comme au reconnect/refresh (rebuild dédupliqué depuis le serveur).
- Non-régression : chat chef↔utilisateur normal (le vrai message utilisateur reste une bulle user unique), réponse du chef non dupliquée (fix antérieur), réconciliation en place, temps réel/cartes. Vérifié en Chrome headless isolé : 1 message user + (notification + relay + replay du même callback) → 1 seule bulle callback attribuée au musicien, 0 bulle user parasite. **Client statique → hard-reload requis.**

## [0.14.0] - 2026-09-08

### Added
- (dashboard) **Liens cliquables dans le chat** (`public/app.js`, `mdToHtml`) : autolink des **URL nues** `http(s)://…` (scheme requis — pas de `host:port` type `myhost:7777`) en `<a target="_blank" rel="noopener noreferrer">`, en plus des liens markdown `[texte](url)` déjà gérés. Les spans `<a>`/`<code>` existants et les blocs de code sont protégés par placeholders → pas de double-link ni de lien dans du code. Ponctuation finale (`.,;:!?)]`) laissée hors du lien. Client statique → **hard-reload requis**.
- (android) **Liens réellement cliquables** (`ui/fleet/Markdown.kt`) : `renderInline` porte désormais une annotation `URL` sur les liens markdown **et** les URL nues `http(s)://…` ; un nouveau `LinkableText` (via `ClickableText` + `LocalUriHandler`, l'API `LinkAnnotation.Url` n'existant qu'en Compose 1.7 > BOM 2024.08/1.6.8 du projet) ouvre l'URL dans le navigateur au tap. Style visuel (accent + souligné) conservé, rendu markdown (gras/italique/code/listes/titres/tableaux/citations) inchangé. `versionName` 0.4.4 → **0.4.5**, `versionCode` 9 → **10**.

### Notes
- Vérifié en Chrome headless isolé : URL nues → `<a>`, liens markdown non double-linkés, `myhost:7777`/`8:00` non linkés, URL dans code inline/fence non linkées, gras/italique/code intacts. Android : compile propre (assembleDebug BUILD SUCCESSFUL) ; **non installé sur device ce tour (téléphone déconnecté)** — APK fourni pour copy-build.

## [android 0.4.4 / vc9] - 2026-09-07

### Fixed
- (android) **Gros trous vides entre les blocs de la session d'un musicien** (`ui/fleet/MainPane.kt`). Chaque événement du ring produisait un item de `LazyColumn` **même quand il ne rendait rien** (un `user`/tool_result sans refus après *chaque* appel d'outil, un `system` non-init, un `assistant` vide) — l'item vide consommait quand même l'espacement `spacedBy` → ~2-3 lignes blanches. Le ring est désormais **filtré par `isRenderable()`** (ne garde que les events réellement rendus, en phase avec le `when` d'`EventLine`), l'espacement passe de 8 → **6 dp**, et le texte des blocs est **trimé**. Plus de trous.
- (android) **Entête version « v0.4.3-debug$1.85 »** : le `$1.85` (coût total du fleet) se collait à la version quand la barre débordait, donnant l'impression d'une variable de build cassée. Le total coût/tokens est **retiré de l'entête** (l'usage par tour reste affiché sur chaque ligne `result`) → entête propre `v0.4.4-debug` + statut. `versionName` 0.4.3 → **0.4.4**, `versionCode` 8 → **9**.

## [android 0.4.3 / vc8] - 2026-09-07

### Fixed
- (android) **Les appels d'outils dans la session d'un musicien n'affichaient que le nom nu** (« ⚙ Edit ») sans la cible. Cause : `RawEvent.Block` ne désérialisait pas le champ `input` du `tool_use`. Ajout de `Block.input` + helper `toolArgPreview()` (mirroir du web `public/app.js` : `file_path`/`path`/`command`/`pattern`/`url`), et nouveau `ToolUseChip` dans `MainPane.kt` → chaque outil s'affiche **`⚙ <outil>  <cible>`** (`Edit config.json`, `Bash npm test`, `Read …`). `Musician.lastLine` (aperçu carte/onglet) inclut aussi la cible.
- (android) **Blocs « réflexion » vides** : `EventLine` affichait un « … réflexion » statique sans le contenu. Il rend désormais le texte du bloc `thinking` (italique dim), et itère **tous** les blocs d'un event `assistant` (thinking + tool_use + text) au lieu d'un seul.
- (android) **Entête version « v0.4.2-debug$6,78 »** : le `$6,78` n'était pas une variable de build cassée mais le **coût total du fleet** formaté avec la virgule de la locale FR. `fmtCost`/`fmtTok` (et la durée) forcent désormais `Locale.US` → `$6.78` (aligné sur le web, plus d'ambiguïté). `versionName` 0.4.2 → **0.4.3**, `versionCode` 7 → **8**.

## [android 0.4.2 / vc7] - 2026-09-07

### Changed
- (android) **Barre des noms de musiciens triée par activité** (`ui/fleet/TabBar.kt`) : les musiciens qui travaillent (`live`/`think`) apparaissent le plus à gauche, puis ceux en attente d'action / en erreur (`input`/`error`), puis les résultats non lus (`unread`), puis les inactifs (`idle`) à droite. `tabPriority` réordonné (live/think = 0) et tri rendu **stable** (`sortedBy` au lieu d'un tie-break par nom → à priorité égale l'ordre config est conservé, pas de réagencement erratique). Le re-tri est live (le `remember` a chaque état en clé). Le chef reste hors tri (à gauche), les parkés restent exclus, la sélection active suit le musicien. `versionName` 0.4.1 → **0.4.2**, `versionCode` 6 → **7**.

## [android 0.4.1 / vc6] - 2026-09-07

### Fixed
- (android) **La page du chef scrollait visiblement de haut en bas à l'ouverture** (`ui/fleet/MainPane.kt`). Le `LaunchedEffect` de scroll utilisait `animateScrollToItem` dès le premier affichage → animation visible. Désormais un flag one-shot (`firstScrollDone`) fait un `scrollToItem` **instantané** au premier positionnement (ouverture) puis repasse en `animateScrollToItem` pour le suivi live. Même correctif appliqué à la vue session d'un musicien (même LazyColumn). `versionName` 0.4.0 → **0.4.1**, `versionCode` 5 → **6**.

## [0.13.2] - 2026-09-07

### Fixed
- (dashboard) **Réponse du chef affichée en double** dans le fil quand l'utilisateur envoyait un message (la 2e occurrence disparaissait au refresh). Cause (`public/app.js`, `onConductorEvent` branche `result`) : la réponse finale du chef arrive comme un bloc `assistant` `text` consolidé qui était enregistré **à la fois** dans la bulle « réflexion » (comme événement `text`) **et** poussé comme bulle `conductor` → présent 2× dans le DOM (`answerCountInDOM = 2`). L'historique serveur ne contient pas de réflexion, d'où l'affichage correct au refresh. De plus la réflexion n'était pas toujours refermée : un callback de musicien poussé après elle la laissait `is-live` (ouverte, donc visible).
  - Au `result`, on referme désormais la **dernière** réflexion ouverte en cherchant **en arrière** (elle n'est pas toujours en queue) et on **retire de ses événements le `text` égal à la réponse finale** → la réponse n'apparaît plus qu'une fois (la bulle `conductor`), alignée sur l'historique serveur.
- Vérifié en Chrome headless isolé : réponse chef affichée → envoi utilisateur → **0 doublon** ; enchaînement de 2 tours avec un callback de musicien intercalé après la réflexion → chaque réponse une seule fois, aucune réflexion restée ouverte, 0 erreur console. Cohérent avec la réconciliation en place de v0.13.1 (pas de régression du clignotement).

## [0.13.1] - 2026-09-07

### Fixed
- (dashboard) **Clignotement du dashboard pendant le streaming SSE.** Cause : `renderMainPane` (`public/app.js`) reconstruisait **tout** le transcript du chef (`#cv-scroll.innerHTML = this.chat.map(...)`) à **chaque** événement (via `onConductorEvent → renderChat`), et les mini-feeds des cartes (`updateCard` / `syncChefCard`, `feed.innerHTML = ...`) étaient réécrits à chaque flush → frame blanche + saut de scroll à chaque token/outil.
  - `renderMainPane` réconcilie désormais les enfants **en place** (`reconcileChildren`, clé par index + signature de contenu) : seuls les nœuds réellement modifiés (la bulle « réflexion » en cours + le pill « le chef répond ») sont remplacés ; les autres bulles gardent leur identité DOM. Plus aucun `innerHTML` global du conteneur pendant un tour (un `_setPaneMode` ne vide qu'au changement de mode/onglet). Idem pour la vue session d'un musicien.
  - Interactions du transcript (`↩ répondre`, `✎ éditer`, double-clic) passées en **délégation** (un seul listener sur `#cv-scroll`) au lieu d'un recâblage par nœud à chaque rebuild.
  - Feeds de cartes (`updateCard`, `syncChefCard`) écrits via `setHtmlIfChanged` (skip si contenu identique) → plus de réécriture inutile au ticker/staleness.
  - Auto-scroll conservé mais uniquement si l'utilisateur était déjà en bas (plus de yank).
- Non-régression perf v0.11.0 vérifiée (animations compositor-only, aucune animation `thread-flow`/`border-flash` en boucle). Vérifié en Chrome headless isolé : 25 événements streamés d'affilée → nœud de première bulle préservé (identité DOM intacte, 0 rupture), réflexion live rendue, 0 erreur console.

## [0.13.0] - 2026-09-07

Refonte app Android + serveur, direction corrigée (décision utilisateur) :
suppression totale de l'auth par token (accès Tailscale uniquement) et de tout
le sous-système SSH/SCP/Builds, plus correction de l'affichage temps réel des
cartes. **Remplace/annule** l'entrée précédente non publiée qui déplaçait le
token vers `local.properties` et ajoutait un TOFU SSH (approche abandonnée).

### Removed
- (server) **Token gate désactivé** (`server.js`, `TOKEN_GATE_ENABLED = false`) : les gardes HTTP, WS (`wsVerifyClient`) et pty-WS court-circuitent vers « accepté ». Le `.token` est toujours généré mais n'est plus requis. ⚠️ **Levée de garde-fou assumée** — le dashboard est ouvert sur le réseau Tailscale ; re-basculer le flag à `true` pour ré-armer la gate. **Restart 7777 requis (côté chef, après checkpoint utilisateur).**
- (android) **Auth par token entièrement retirée** : plus aucun token dans l'app (littéral hardcodé supprimé, header `X-Orchestrator-Token`, `?token=`, champ token de l'écran de login, `TokenStore` → remplacé par `ServerStore` qui ne stocke que l'URL). Annule le besoin de rotation du `.token`.
- (android) **Sous-système SSH/SCP + onglet Builds supprimés** : `ui/builds/` (`BuildsScreen`, `BuildsViewModel`), `data/SshKeyStore.kt`, l'onglet Builds de `TabBar`, la dépendance **sshj**, **BouncyCastle**, **eddsa**, **security-crypto**, la permission `REQUEST_INSTALL_PACKAGES`, le `FileProvider` du manifeste et `res/xml/file_paths.xml`. Zéro code mort, zéro import orphelin.

### Fixed
- (android) **Affichage temps réel des cartes** — cause racine : le serveur diffuse chaque ligne JSONL, y compris les `stream_event` (deltas token très fréquents) ; `Musician.ingest` les ajoutait au ring plafonné (30) qui éjectait les vrais events `assistant`/`tool`/`result` → cartes quasi vides. Désormais les `stream_event` ne rentrent plus dans le ring ; ils alimentent un buffer de **streaming live** (`liveText`/`liveActivity`) rendu en bas de la session projet ET dans le fil du chef (texte qui s'écrit token par token). `lastLine` reflète aussi l'activité courante (`⚙ outil`, `réflexion…`) même sans prose.
- (android) **États du fleet effacés à chaque (re)connexion SSE** : `reset()` de tous les musiciens sur `Open` remplacé par une fusion depuis `/api/config` (`syncFromConfig`, préserve le ring).
- (android) **Événements SSE perdus sous rafale** (`FleetStream`) : `buffer(Channel.UNLIMITED)`.
- (android) **App bloquée sur « Chargement… »** si `/api/config` échoue au lancement : boot auto-réparant (démarre toujours le flux, se ré-hydrate à la 1re ouverture SSE).
- (android) **Auto-scroll figé quand le ring est plein** : clé = compteur monotone `ingestSeq` (le chef et les sessions projet suivent le flux live).
- (android) `Markdown` : `toIntOrNull() ?: 1` (plus de `NumberFormatException`). `Api.baseUrl()` : erreur explicite au lieu de `!!`. `ConductorChatEntry.text` nullable (une entrée sans texte ne vide plus l'historique).

### Changed
- (android) `versionName` 0.2.1 → **0.4.0**, `versionCode` 3 → **5**. Login simplifié : URL serveur uniquement (+ verrou biométrique d'ouverture conservé), plus aucun token.

## [0.12.1] - 2026-09-05

### Fixed
- (server) **`ReferenceError: name is not defined` sur chaque dispatch avec un `.pid` périmé** (`server.js`). `_dispatchPidAliveCheck()` référençait `name` dans son `debugLog` de la porte « stale pid » sans le recevoir en paramètre : dès qu'un `logs/<projet>.pid` datait de plus de `STALE_PID_MS` (12 h), le check jetait au lieu de renvoyer `null` et le handler de dispatch échouait. Le nom du projet est maintenant passé explicitement par les deux appelants (`dispatchPidAlive` et `dispatchPidAliveAsync`).

## [0.12.0] - 2026-09-04

### Added
- (server) **`/downloads` liste désormais toutes les apps Android du fleet** (`server.js`). `DOWNLOAD_APPS` passe de `[RemotePad, BookHaven]` à 11 apps : + DeskZen, vuBox (Android TV), firstAidOffline, frenchradio, immo-share (mobile), meetingScribe, photoLab, SncfOptimizer, sommeil. Chaque app a son `builds/<nom>/latest.apk` (servi par `/downloads/:app/apk`).
- (server) **Étiquette de plateforme** sur chaque carte de téléchargement (`APP_PLATFORM` + badge `.app-plat`) : vuBox = `TV`, immo-share = `mobile`, les autres = `phone`.

### Changed
- (server) **`readAppVersion` généralisé** : remplace les deux `if` en dur par une table `APP_VERSION_SOURCES` (fichier source par app) + un matcher `versionName` unique tolérant Kotlin DSL (`versionName = "x"`) **et** Groovy (`versionName "x"`), insensible à la casse (une app écrit `VersionName`), avec lookahead négatif pour ne pas capter `versionNameSuffix`. Versions lues : RemotePad 1.2.0, BookHaven 1.5.0, DeskZen 1.2.0, vuBox 0.10.2, firstAidOffline 0.2.1, frenchradio 1.4.0, immo-share 0.2.1, meetingScribe 0.1.0, photoLab 0.1.1, SncfOptimizer 1.0, sommeil 0.1.0. Défaut `unknown` si illisible (ne bloque pas la carte).

### Notes
- Les APK (`builds/*/latest.apk`) sont **gitignorés** (`*.apk`) — non committés, comportement inchangé. Copiés depuis les sorties de build de chaque projet (préférence signé/release > debug). vuBox et frenchradio avaient déjà un `latest.apk` plus récent que la source → conservés. DeskZen : copie de `app-release-unsigned.apk` (le chef remplacera par une build signée).
- **Restart du serveur 7777 requis** pour que le registre `DOWNLOAD_APPS` élargi soit pris en compte (chargé au boot) — à faire par le chef via `restart-orchestrateur.mjs`. Vérifié hors-ligne : `node --check` OK, extraction de version + présence des 11 `latest.apk` confirmées ; le rendu live se validera après restart.

## [0.11.0] - 2026-09-02

### Changed
- (dashboard) **Perf : toutes les animations du dashboard rendues compositor-only** pour supprimer le plancher permanent « gpu-process Chrome 100 % + DWM 100 % au repos » (latence clavier de 3-6 s signalée). Diagnostic par un autre modèle, implémentation ici.
  - **Fils lumineux SVG** (`public/styles.css` `.threads path`) : suppression de l'animation `stroke-dashoffset` (`@keyframes thread-flow`) **et** du `filter: drop-shadow` — tous deux forçaient un repaint d'un calque taille-viewport à chaque frame, qui re-floutait en cascade toutes les cartes `backdrop-filter` au-dessus. Fils désormais statiques (dashes) ; la lueur est conservée via un chemin compagnon large translucide sans filtre (`public/app.js` `addPath`).
  - **Redraw des fils** (`public/app.js`) : l'intervalle 1 s qui reconstruisait tout le SVG (`svg.innerHTML=""` + `getBoundingClientRect`) est remplacé par un redraw **détecté par signature** (`redrawThreadsIfChanged`) ; ré-ancrage borné pendant le glissement post-réorganisation via une boucle rAF auto-stoppée (`scheduleThreadSettle`).
  - **Halos** (`.m-halo`, `.chef-halo`) : le `blur` passe sur un `::before` statique ; les keyframes `halo-*` utilisent des valeurs d'opacité **littérales** (plus de `calc(...*var(--halo-intensity))`, qui sortait l'animation du compositor). `--halo-intensity` est appliqué statiquement sur l'élément wrapper (contrôle préservé).
  - **Anneau d'attente** (`input`/`error`/`denial`) : l'ancien `@keyframes border-flash` animait `box-shadow` sur une carte `backdrop-filter` (repaint + re-blur/frame). Remplacé par un `.m-body::after` pré-rendu dont seule l'**opacité** est animée (`@keyframes ring-flash`), au-dessus du backdrop.
  - **Rendu SSE batché** (`public/app.js`) : chaque ligne SSE (y compris les deltas token-level) ne déclenche plus un `updateCard`/`renderTabs` synchrone ; cartes, tab bar et pane mobile sont coalescés en un seul repaint par frame via `requestAnimationFrame` (`markDirty`/`_flushDirty`). L'auto-scroll du drawer (`public/pupitre-detail.js`) est throttlé à 1×/frame (lecture de `scrollHeight` = reflow synchrone auparavant par token).
  - **Tickers de fond** : le ticker 5 s ne rafraîchit plus que les cartes in-flight/stale ; tickers 1 s / 5 s court-circuités quand l'onglet est caché.

### Added
- (dashboard) **Page Visibility** : quand l'onglet/dashboard est caché, toutes les animations en boucle sont mises en pause (`html.anim-paused`) et les timers/redraw de fond suspendus — coût GPU quasi nul quand l'utilisateur n'a pas le dashboard au premier plan.

### Notes
- Vérifié en Chrome headless isolé (profil dédié, CDP) sur le dashboard réel avec SSE en direct : page chargée (26 cartes, SVG fils présent), `.m-halo` sans `filter` et `.m-halo::before` avec `blur(18px)` (blur déplacé comme voulu), aucune animation `thread-flow`/`border-flash` active, **0 erreur/exception console** pendant 5 s de stream. La chute effective du GPU-process/DWM reste à confirmer par l'utilisateur dans SON Chrome (recharger le dashboard, puis Shift+Esc → colonne GPU de l'onglet « Orchestre »).

## [0.10.0] - 2026-08-31

### Changed
- (server) **Le leg failover (limite de session Claude) route désormais vers une cascade NVIDIA « codage-first » au lieu de codex/gpt-5.6-sol** (`scripts/dispatch.mjs`). Quand `logs/claude-limited.until` est actif, la patte failover essaie, dans l'ordre et en ne passant au suivant que sur échec/quota/timeout : `moonshotai/kimi-k3` → `deepseek-ai/deepseek-v4-pro-0813` → `nvidia/nemotron-3-ultra-550b-a55b` → `deepseek-ai/deepseek-v4-flash-0731`. Identifiants vérifiés en direct via `GET /v1/models` le 2026-08-31. Le **chemin Claude nominal est inchangé**.

### Added
- (server) Client OpenAI-compatible direct pour l'endpoint NVIDIA `https://integrate.api.nvidia.com/v1` (chat/completions). La clé est lue depuis `I:\orchestrateur\.env` (`NVIDIA_API_KEY`, gitignoré) et n'est envoyée **qu'**à `integrate.api.nvidia.com` — jamais forwardée à un process enfant (scrub ajouté à côté de `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`). Aucun secret loggé.
- (server) Hook d'auto-test `node scripts/dispatch.mjs --test-failover` (option `--test-failover-all`) qui exerce la cascade NVIDIA en direct **sans** toucher aux logs projets, aux sidecars, ni au flag de limite.

### Notes
- **Pourquoi un client direct et pas le harness codex** : l'option propre aurait été de garder codex comme harness agentique en pointant son provider sur NVIDIA (tool-use préservé). Impossible ici : codex-cli 0.147.0 a supprimé `wire_api = "chat"` et exige l'API Responses, or NVIDIA n'expose que chat/completions (`/v1/responses` → 404). Le leg failover est donc un appel **single-shot** : le modèle NVIDIA renvoie du code/texte mais ne peut pas exécuter Bash/Edit ni déclencher le callback — mode dégradé dont le seul rôle est de ne pas perdre le tour pendant que Claude est indisponible.
- **Dernier recours** : si toute la cascade NVIDIA est down (ou la clé absente), le leg retombe une fois sur codex/gpt-5.6-sol (OAuth, tool-use restauré) avant d'abandonner proprement. Jamais de boucle de retry.

## [0.9.2] - 2026-08-21

### Changed
- (dashboard, desktop) La carte fixe du chef est désormais cliquable et accessible au clavier. Elle ouvre `openFocused(chef)`, soit exactement le drawer `/pupitre` partagé utilisé par les autres musiciens : même télémétrie `état · tour · silence · pid · model`, même `PupitreDetail`, mêmes blocs `.e-*` horodatés alimentés par `chef.jsonl`, et même suivi live SSE.
- (dashboard) Le rendu spécial `syncChefCard` est neutralisé comme surface de contenu : il ne conserve que le résumé visuel fixe et le badge `CHEF`; tout le contenu détaillé du chef passe par le drawer commun. Le composer focalisé route via `m.name` et envoie donc vers `chef`, tandis que le composer principal du panneau gauche continue de cibler le chef par défaut.

### Notes
- Vérifié en vrai Chrome 151 via CDP, viewport desktop 1680×1000, sans redémarrer le serveur : clic sur la carte chef → drawer `chef` avec télémétrie complète, 66 blocs `.e-*`/66 horodatages; comparaison avec `jellyfin` → même structure `d-head · d-body · d-foot · pf-compose`. Composer focalisé intercepté côté navigateur vers `{ project: "chef" }`, composer principal toujours en mode conducteur vers `chef`, 0 exception runtime.

## [0.9.1] - 2026-08-21

### Added
- (dashboard) **Horodatage date+heure sur chaque entrée du flux** `.e-*` (`public/pupitre-detail.js`, module partagé par `/pupitre` ET la carte ouverte) : format `JJ/MM HH:MM:SS` (ex. `20/08 16:10:23`), affiché en préfixe du label de chaque bloc. Utilise le **timestamp réel de l'event** (`raw.timestamp`, présent sur `user_prompt`/`assistant`/`user`(tool_result)/`notification`) ; pour les types qui n'en portent structurellement jamais (`system`/init, `result`, `stream_event`, vérifié sur les logs réels — 0 % de couverture native), reprend le dernier timestamp réel vu dans le même flux plutôt que fabriquer une heure de rendu (`new Date()` au moment de l'affichage). Le renderer étant partagé, les deux surfaces affichent des horodatages identiques.

### Changed
- (dashboard) Le lien **« Pupitre »** de la topbar (`#btn-pupitre`) navigue désormais dans le **même onglet** (`target="_blank"` et `rel="noopener"` retirés).

### Notes
- Vérifié en vrai navigateur (Chrome/CDP) : la carte (rechargement statique immédiat) affiche 111/112 blocs horodatés avec les mêmes valeurs que le drawer. Le serveur live tournait encore en v0.7.0 au moment du test — `/pupitre` étant rendu côté serveur, son horodatage ne sera visible qu'après le prochain redémarrage (statique déjà à jour) ; vérifié en attendant via un harness en lecture seule sur port 8899 rejouant le `pupitrePageHtml()` actuel sur disque : mêmes 111/112 blocs, mêmes valeurs d'horodatage que la carte, 0 exception console. Navigation même-onglet du lien Pupitre confirmée (nombre de pages/targets inchangé après clic).

## [0.9.0] - 2026-08-21

### Changed
- (dashboard, desktop) **Cliquer une carte de musicien ouvre désormais EXACTEMENT le même rendu qu'ouvrir une ligne sur `/pupitre`** : la carte focalisée EST le detail drawer de `/pupitre` — `.d-head` (nom + méta télémétrie `état · tour · silence · pid · model` + ✕), `.d-body` (le même flux d'événements `.e-*`, rendu par le MÊME `PupitreDetail`), `.d-foot` (`⏬ suit le flux` · N evts) — **plus** le composer inchangé en dessous pour parler au musicien. Le flux se remplit via `/api/project/:name/events` (backfill) puis en direct via `onLive` (deltas token-level), exactement comme `/pupitre`.
- (server) La chrome du drawer (`.d-head/.d-name/.d-meta/.d-close/.d-body/.d-foot/.pin-on`) est déplacée de l'inline `pupitrePageHtml` vers `public/pupitre-detail.css` (déjà partagé) — source unique chargée par `/pupitre` ET le dashboard.

### Removed
- (dashboard) Suppression de la mise en page spécifique de la carte ouverte qui la faisait différer d'une ligne `/pupitre` : en-tête `pf-head` (nom/sous-titre/état/usage), **chip session SID**, **bloc `pf-tech`/OUTILS séparé**, corps `pf-main`/`pf-tech`, bandeau heartbeat. Il ne reste que [ligne `/pupitre` ouverte identique] + [composer]. (Attacher une session Claude reste possible via le bouton ⌬ de la carte dans la flotte.)

### Notes
- `/pupitre` inchangé et vérifié intact. Composer vérifié (bouton d'envoi activé/désactivé selon la saisie, envoi via `/api/dispatch` inchangé). Preuve en vrai navigateur (Chrome/CDP, cache désactivé, 1680px) : captures côte-à-côte `/pupitre` ligne ouverte vs carte ouverte = mêmes `.d-head`/`.d-body`/`.d-foot` (`jellyfin  UNREAD · tour — · silence 26h · pid — · claude-sonnet-5`, mêmes blocs `.e-*`, `112 evts`), 0 exception console.

## [0.8.0] - 2026-08-21

### Changed
- (dashboard, desktop) **`pf-main` (carte ouverte) affiche désormais le contenu d'une ligne `/pupitre` OUVERTE** : la ligne de télémétrie (état · activité · tour · silence · pid · model) puis **le même flux d'événements que le detail drawer de `/pupitre`** — blocs étiquetés `.e-*` (PROMPT · TEXTE · RÉFLEXION · OUTIL ⚙ + args · RÉSULTAT OUTIL · TOUR TERMINÉ · ÉCHEC · SYSTÈME) avec repli au clic. Auparavant `pf-main` utilisait un rendu markdown `.ev` différent (timestamps + markdown), visuellement distinct du drawer.
- (server) **Source unique du rendu « ligne ouverte »** : extraction du renderer du drawer `/pupitre` dans `public/pupitre-detail.js` (fabrique `PupitreDetail.create(container, {scrollEl, maxNodes, onCount})`) et de son style dans `public/pupitre-detail.css`. `server.js` (`pupitrePageHtml`) et le dashboard chargent tous deux ce module et l'utilisent — `/pupitre` (drawer `#d-body`) et la carte (`.pf-main-stream`) rendent donc un flux identique et ne peuvent plus diverger. `server.js` allégé du renderer inline (~5,8 Ko de JS/CSS retirés).

### Removed
- (dashboard) La bande de télémétrie autonome `#pf-pupitre-strip` (desktop) est supprimée : la télémétrie vit désormais **une seule fois**, en tête de `pf-main` (`.pf-main-telem`, sticky). Plus de doublon. Le badge d'état de l'en-tête reste masqué et la cellule nom de la ligne reste masquée (le nom est le titre de l'en-tête). La bande mobile `#mp-pupitre-strip` et `/pupitre` conservent la ligne complète avec nom.

### Notes
- Inchangés : `pf-tech` (bloc OUTILS, rendu par son propre renderer), le composer `pf-compose`, les actions de la carte. Vérifié en vrai navigateur (Chrome/CDP, cache désactivé, live 7777, 1680px) avec captures avant/après : le `pf-main` de la carte et une ligne `/pupitre` ouverte rendent les mêmes blocs `.e-*` ; `/pupitre` fonctionne toujours après la factorisation.

## [0.7.2] - 2026-08-21

### Changed
- (dashboard, desktop) **La carte ouverte n'affiche plus la télémétrie en double.** Screenshot réel (Chrome/CDP, live 7777, 1680px) : la carte montrait DEUX blocs télémétrie — l'ancien en-tête `.pf-head` (nom + badge d'état « PRÊT ») **et** la nouvelle bande `#pf-pupitre-strip` (état UNREAD + activité). État affiché deux fois, nom affiché deux fois. Corrigé, purement CSS (`public/styles.css`, aucun changement de logique) : le badge d'état de l'en-tête (`.panel-focused .pf-state-tag`) est masqué (l'état vit désormais uniquement dans la bande), et la bande de l'overlay desktop masque sa cellule nom (`.pf-pupitre-strip .cell-name`, grille réduite à 6 colonnes) puisque le nom sert déjà de titre à l'en-tête. Structure finale de haut en bas : en-tête minimal (nom + modèle/outils + chip SID + fermer) → **une seule** bande pupitre (état · activité · tour · silence · pid · model, identique à une ligne `/pupitre`) → flux d'événements → composer. Portée strictement `.pf-pupitre-strip` : `/pupitre` et la bande mobile `.mp-pupitre-strip` gardent la ligne complète avec le nom. Flux de log, composer et actions inchangés.

## [0.7.1] - 2026-08-21

### Fixed
- (dashboard) **La bande de télémétrie « pupitre » de la carte ouverte n'apparaissait jamais sur mobile** — c'est-à-dire dans le cas réel de l'utilisateur (téléphone via Tailscale). Cause identifiée en **reproduction navigateur réelle** (Chrome pilote CDP, authentifié par token, contre le dashboard live 7777) : en viewport desktop la bande fonctionnait déjà (`#pf-pupitre-strip` peuplé, aucune exception), mais en viewport mobile ouvrir un musicien passe par `setActiveTab` → `renderMainPane` (onglets, pas d'overlay focalisé), un chemin où la bande et son polling n'avaient **jamais** été câblés (`mpStripExists:false`, `pollTimer:false`). Le fix precedent (0.7.0) ne touchait que l'overlay desktop `openFocused`.
- (dashboard) Ajout d'un conteneur persistant `#mp-pupitre-strip` dans `#conductor-view` (hors `#cv-scroll`, pour ne pas être effacé à chaque re-render du flux d'événements). La logique de bande est factorisée : `pupitreTargetName()` (musicien focalisé desktop OU onglet musicien actif mobile), `ensurePupitrePoll()` (démarre/arrête le poll `/api/pupitre` selon qu'une vue mono-musicien est ouverte), et `renderPupitreStrip()` peint désormais **les deux** conteneurs (overlay desktop + bande mobile) via le **même** `PupitreRow.rowHtml` que `/pupitre`. Le ticker 1 s rafraîchit la bande indépendamment de l'overlay ; le hint SSE (re-poll 400 ms) se déclenche pour le musicien affiché, desktop **ou** mobile.
- **Vérifié en vrai navigateur (CDP, auth token) après fix, sur les deux viewports** : desktop → overlay `jellyfin` affiche la ligne complète (UNREAD · result:ok · 18h06 · claude · claude-sonnet…) au-dessus du flux intact ; mobile 430px → taper l'onglet `veille` affiche la bande peuplée (ERROR · PARKED · result:error · 97h09 · codex · gpt-4o), `pollTimer` actif, 0 exception console. Colonnes activité/pid/model repliées sous 720px, exactement comme `/pupitre`.

## [0.7.0] - 2026-08-19

### Added
- (server) **L'apercu de carte ouverte affiche desormais la meme telemetrie live qu'une ligne /pupitre.** Nouvelle bande dans le panneau focalise (sous l'en-tete, au-dessus du flux d'evenements) : etat colore (idle/live/think/input/unread/error/**stalled**), ce que le musicien fait maintenant (`tool_use:<nom>`, `text`, `thinking`, `result:ok/error` + apercu), **temps sur le tour courant**, **silence** depuis le dernier progres reel, **PID vivant/mort**, badge **PID MORT** si le processus est mort alors que le tour est encore live, et model/provider. Mise a jour live : reutilise `/api/pupitre` (poll 2.5 s, identique a la cadence de /pupitre) + un hint SSE debounce a 400 ms sur le flux existant `/api/sse/fleet` — aucune nouvelle connexion, aucun nouvel endpoint. Les compteurs tour/silence s'interpolent chaque seconde via le ticker « heartbeat » deja present.
- (server) `public/pupitre-row.js` et `public/pupitre-row.css` — **extraction en source unique** du rendu d'une ligne pupitre (etat, rang de tri, formatage de duree, markup HTML echappe) et de son style, precedemment dupliques/inline dans `pupitrePageHtml()`. Desormais charges a la fois par `/pupitre` et par le dashboard (`public/index.html`), garantissant que la carte ouverte et la ligne /pupitre ne peuvent plus diverger. `server.js` a ete allege d'autant (fonctions `esc`/`fmtAge`/`stateInfo`/`rank` et le gabarit de ligne retires, remplaces par des appels a `PupitreRow.*`).

### Changed
- Aucune fonctionnalite existante de la carte retiree : flux de log complet, boutons/actions, historique via `/api/project/:name/events` restent inchanges — la bande pupitre est un ajout au-dessus du corps existant.

## [0.6.0] - 2026-08-19

### Added
- (server) **Pupitre : panneau de detail par musicien, en flux continu.** Un clic
  sur une ligne ouvre un tiroir qui montre ce que le musicien fait vraiment, et
  pas seulement l'apercu tronque de la grille : prompt recu, blocs de texte,
  reflexion, appels d'outils avec leurs arguments, resultats d'outils, fin de
  tour (duree + nombre de tours), evenements systeme. Le texte, la reflexion et
  les arguments d'outil s'ecrivent **token par token** avec un curseur de frappe,
  puis les blocs longs se replient (clic pour derouler). L'historique est
  pre-charge via `/api/project/:name/events` puis le direct prend le relais.
  Auto-scroll accroche au bas du flux, relache des que l'utilisateur remonte
  (indicateur « suit le flux » / « defilement libre »). Fermeture par Echap, par
  la croix, ou en recliquant la ligne. **Aucun nouvel endpoint ni seconde
  connexion SSE** : la page tient deja une connexion `/api/sse/fleet` qui
  transporte les lignes JSONL brutes de tous les projets — le tiroir se contente
  de lire celles qui arrivent deja. Les deltas `stream_event` sont rendus et
  l'evenement `assistant` consolide est ignore, sinon chaque bloc apparaitrait
  deux fois.

### Fixed
- (server) **Un tour tue par le redemarrage restait « live / STALLED » pour
  toujours.** `healOrphanedLogs()` ne fermait un tour orphelin qu'au-dela de
  `ORPHAN_STALE_MS` (60 s) d'inactivite du log — or un tour tue par le
  redemarrage dont on sort est *frais*, donc jamais repare. Le chef restait
  epingle en LIVE avec un PID mort jusqu'au prochain dispatch manuel (constate
  le 19 aout : `restart-orchestrateur.mjs` fait un `taskkill /T` qui emporte
  tous les dispatches avec le serveur). Le sidecar `.pid` tranche desormais :
  vivant = un vrai dispatch produit encore des evenements, on ne touche a rien ;
  mort = plus personne ne fermera ce tour, on ecrit le `result` synthetique
  immediatement. L'heuristique d'age ne sert plus que lorsqu'il n'y a aucun
  sidecar.
- (server) **Toutes les bulles du chef portaient l'heure du chargement de page.**
  Les lignes stream-json emises par la CLI claude n'ont pas de champ
  `timestamp` — seuls les evenements que `dispatch.mjs` ecrit lui-meme en ont.
  Le repli `: Date.now()` de `/api/conductor-chat` horodatait donc chaque
  reponse du chef a l'instant de la requete HTTP : au rechargement, tout le fil
  s'ecrasait sur « maintenant » et revenait dans le desordre (13 paires
  inversees sur 41 messages). L'horodatage est reconstruit depuis les propres
  chiffres du tour (heure du prompt + `duration_ms` du `result`) puis contraint
  a etre monotone dans l'ordre du log.

## [0.5.0] - 2026-08-19

### Added
- (server) **Vue « pupitre » — suivi temps réel de chaque musicien, le chef inclus.** Nouvelle page `GET /pupitre` (auto-contenue, sans framework ni CDN) et endpoint `GET /api/pupitre`. Pour chaque projet ET le chef (`chef.jsonl`, traité comme un musicien normal) : état coloré (idle / live / think / input / unread / error / **stalled**), activité courante (`tool_use:<nom>`, `text`, `thinking`, `result:ok/error`, `stream_event:*` + aperçu), **temps sur le tour courant** et **silence** depuis le dernier progrès réel, **PID vivant/mort**, mise en évidence **STALL** (live/think + silence ≥ 60 s, ou PID mort alors que le tour est encore live), et model/provider si présents dans le log. Tri par activité : stalled/attention en haut, actifs ensuite, idle en bas. Compteurs qui avancent en continu côté client entre deux snapshots.
- (server) `scripts/fleet-status-core.mjs` — **source de vérité unique** pour la dérivation état/silence/stall, désormais importée à la fois par le CLI `scripts/fleet-status.mjs` et par le serveur (`/api/pupitre`), pour que le dashboard et `node scripts/fleet-status.mjs` ne divergent jamais. Le core ajoute `turnElapsedMs`, `deadInFlight`, `activity`, `model` et `provider` aux champs existants.
- (dashboard) Lien « Pupitre » dans la barre du haut (`public/index.html`), ouvrant `/pupitre` dans un nouvel onglet.

### Changed
- (server) `scripts/fleet-status.mjs` réécrit pour importer la logique commune depuis `fleet-status-core.mjs` au lieu de la dupliquer (sortie CLI table/`--json`/`--stalled` inchangée). Nuance : un tour terminé en erreur est désormais classé `error` (état distinct) au lieu de `input`, cohérent avec le réducteur du serveur.

### Fixed
- (server) **Le tableau de bord ne se mettait plus a jour du tout** : la page se
  chargeait, les cartes restaient figees sur leur dernier etat et aucune reponse
  du chef n'apparaissait, alors que les sous-agents travaillaient normalement.
  Cause : les quatre watchers `chokidar` des logs tournaient en `fs.watch`
  (ReadDirectoryChangesW). Sous Windows, NTFS ne rafraichit l'entree de
  repertoire qu'a la fermeture du handle tant qu'un processus garde le fichier
  ouvert en append — ce que fait chaque dispatch `claude -p` pendant tout son
  tour. Mesure sur un dispatch reel : **396 Ko ajoutes en 60 s = 1 seul
  evenement `change`**, contre **58 avec du polling `stat`**. Les watchers
  passent en `usePolling` (300 ms, surchargeable via `LOG_POLL_MS`) :
  SSE flotte (`/api/sse/fleet`), SSE par projet (`/sse/logs/:project`), pompe
  d'etat de fond (celle qui alimente `musicianAutoStates`, le relais
  `NEEDS_CHEF_INPUT` et `drainQueue`) et watcher des sidecars `.session`.
  Effet de bord notable du meme bug : `drainQueue` ne se declenchant que sur un
  evenement `result` observe, les dispatches mis en file d'attente pouvaient ne
  jamais partir.

## [0.4.1] - 2026-08-18

### Added
- (server) Nouvelle entrée dans le registre `DOWNLOAD_DOCS` : **TradeBot — Revue critique (Fable)** (`docs/REVIEW.md`), exposée sur `/downloads/TradeBot/doc/review`. La carte TradeBot sur `/downloads` affiche désormais deux boutons doc (Proposition + Revue). Aucun changement de mécanisme : réutilise le registre générique introduit en 0.4.0.

## [0.4.0] - 2026-08-17

### Added
- (server) Docs lisibles sur la page publique `/downloads` : un registre générique `DOWNLOAD_DOCS` (un projet peut exposer 1..n docs), pas un cas particulier TradeBot en dur. Première entrée : **TradeBot — Proposition de conception**.
- (server) `GET /downloads/:project/doc/:id` — rend un doc Markdown en **HTML lisible sur mobile** (viewport responsive, largeur de lecture ~720px, thème sombre cohérent, styles auto-contenus). Public (avant le token gate). Renderer Markdown **maison, sans dépendance ni CDN** (le poste/Tailscale peut être hors-ligne ou CDN bloqué) : titres, listes imbriquées, code clôturé/inline, tableaux, citations, règles horizontales, gras/italique, liens. Chaque nœud texte est échappé ; les liens sont restreints à http(s)/mailto/relatif (`javascript:` neutralisé en `#`), les liens externes reçoivent `rel="noopener noreferrer"`.
- (server) `GET /downloads/:project/doc/:id/raw` — téléchargement du `.md` brut (`Content-Disposition: attachment`).
- (server) Source des docs copiée dans `builds/<project>/` (cohérent avec le pattern APK) ; la lecture essaie `builds/` en premier puis retombe sur le chemin projet (`I:\Dev\<project>\…`). Absence des deux sources → 404 lisible, jamais de crash.

### Changed
- (server) La page `/downloads` gère désormais un modèle de carte unifié : app (APK), projet doc-only, ou les deux. Les apps gardent leur ordre de config en premier, les projets doc-only suivent. Icône distincte (Android vs document) et boutons de doc secondaires.
- (server) `PROPOSAL.md` (57 Ko) copié dans `builds/TradeBot/` comme source canonique servie/rendue.

## [0.3.1] - 2026-08-17

### Fixed
- (server) `dispatch.mjs` : le chemin codex ne démarrait pas du tout avec codex-cli 0.147.0 — `--approval-mode full-auto` et `--quiet` n'existent plus (`error: unexpected argument '--approval-mode' found`, exit 2). Invocation corrigée vers `codex exec --model <m> --approve-for-me --skip-git-repo-check --json --cd <path> --output-last-message <f> -`.
- (server) `dispatch.mjs` : `--sandbox` et `--approve-for-me` sont **mutuellement exclusifs** dans codex 0.147.0 (`the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'`). `--approve-for-me` implique déjà le sandbox `workspace-write`, donc `-s` n'est plus passé. `--dangerously-bypass-approvals-and-sandbox` reste proscrit (règle fleet, équivalent de `--dangerously-skip-permissions`).
- (server) `dispatch.mjs` : les événements `codex --json` ne suivent pas le schéma stream-json de Claude, et étaient écrits tels quels dans `logs/<projet>.jsonl`. Aucun event `result` exploitable n'atterrissait donc dans le log : le réducteur de `server.js`, `fleet-status.mjs` et le callback du chef laissaient le panneau bloqué en `live` même quand codex avait terminé. Ajout d'un mapper `codex → schéma Claude` : `thread.started` → thread id, `item.completed`(`agent_message`/`reasoning`/`command_execution`/`file_change`/`mcp_tool_call`/`web_search`/`error`) → events `assistant` (blocs `text`/`thinking`/`tool_use`), `turn.completed`/`turn.failed`/`error` → event `result` synthétique unique avec `is_error`, `result`, `usage` et `num_turns`. Le message final vient de `--output-last-message` (source autoritaire), avec repli sur le dernier `agent_message` puis sur le texte d'erreur ; les erreurs API imbriquées en JSON sont déballées pour rester lisibles.

### Changed
- (server) `dispatch.mjs` : le prompt codex passe désormais par **stdin** (placeholder `-`) au lieu de l'argv — pas de limite de longueur de ligne de commande et le prompt n'approche jamais une ligne de commande.
- (server) `dispatch.mjs` : les pièces jointes image sont transmises à codex via `--image` (elles étaient silencieusement ignorées) — utile quand le failover rejoue un tour qui en comportait.
- (server) `dispatch.mjs` : la sortie stderr de codex n'est plus écrite dans le JSONL (codex y émet sa progression en texte libre, ce qui corrompait le flux d'events) ; elle reste relayée sur le stderr du dispatch.
- (server) `dispatch.mjs` : le `thread_id` codex est reporté sur l'event `result` pour la traçabilité, mais **jamais** écrit dans `logs/<projet>.session` — ce sidecar alimente `claude --resume` et y placer un id codex corromprait la session Claude au retour de failover.

## [0.3.0] - 2026-08-17

### Added
- (server) `templates/project/` — fleet project template with `{{NAME}}`/`{{DATE}}` placeholders: `CLAUDE.md` (instructions chargées automatiquement par le musicien), `docs/CONSTITUTION.md` (Mission, Contraintes techniques, Règles fleet héritées, Definition of Done), `docs/SPEC.md` (Problème, Objectif, Périmètre/Hors-périmètre, Critères d'acceptation, Risques), `CHANGELOG.md` (squelette `[1.0.0]`), `README.md` (emplacement du numéro de version selon la stack).
- (server) `scripts/new-project.mjs` — scaffolder déterministe et idempotent : crée le dossier projet, instancie le template en substituant les placeholders, **n'écrase jamais un fichier existant** (log `exists, skipped`), et ajoute l'entrée `config.json` seulement si absente. Ne redémarre pas le serveur.
- (server) `scripts/dispatch.mjs` — failover déterministe Claude → codex sur épuisement de session, **sans aucune IA dans la boucle** : détection du message de limite dans les sorties autoritatives (event `result`, stderr, texte assistant), écriture du flag fleet-wide `logs/claude-limited.until` (timestamp de reset parsé depuis « resets <heure> », fallback conservateur `now + 60 min`), puis rejeu du **même prompt** via codex (`gpt-5.6-sol` par défaut). Court-circuit en tête de chaque dispatch : `now < until` → codex direct ; `now >= until` → flag effacé, retour automatique à Claude. Un seul niveau de failover, jamais de boucle de retry. Logs `[FAILOVER] …` à chaque bascule.

### Fixed
- (server) `dispatch.mjs` : les écritures du log JSONL en fin de tour étaient perdues — `process.exit()` ne vide pas le buffer d'un `WriteStream`, donc l'event `result` final et (surtout) toute la trace de failover disparaissaient silencieusement. Sortie désormais différée au callback de flush via `endLogAndExit()`, avec plafond de 2 s.
- (server) `dispatch.mjs` : le provider codex ne pouvait plus démarrer du tout sous Node ≥ 18.20.2 — `spawn()` avec `shell: false` lève `EINVAL` sur un `.cmd` (mitigation BatBadBut), et `resolveCodexBin()` retournait justement `codex.cmd`. La résolution privilégie maintenant le point d'entrée `codex.js` lancé via `node` (argv en tableau, aucun shell, prompt jamais exposé à une ligne de commande), puis `codex.exe`, et enfin le shim `.cmd` via `cmd.exe` en dernier recours. Les répertoires npm sont découverts depuis `PATH` (un prefix npm personnalisé comme `I:\npm-global` était invisible).
- (server) `dispatch.mjs` : un `spawn()` qui lève de façon synchrone n'est plus une exception non capturée — l'échec est journalisé, un event `result` d'erreur clôt le tour, et le processus sort proprement (exigence « pas de crash quand tout le reste est cassé »).

### Changed
- (server) `dispatch.mjs` : `OPENAI_API_KEY` est désormais retirée de l'environnement des enfants, au même titre que `ANTHROPIC_API_KEY`. codex s'authentifie via son propre OAuth (`codex login`) — aucune clé de provider n'est transmise à un sous-processus.

## [0.2.2] - 2026-07-17

### Added
- (server) `GET /downloads` — public (no token gate) HTML page listing fleet apps available for download; reads versions dynamically from source files at request time.
- (server) `GET /downloads/:app/apk` — public APK download route serving `builds/<app>/latest.apk` with `Content-Disposition: attachment`; allowlisted to `RemotePad` and `BookHaven` to prevent path traversal.

## [0.2.1] - 2026-05-12

### Added
- (android) `State.error` variant in `enum class State` — error turns now surface as a distinct red state instead of silently falling back to `input`.
- (android) `Palette.StError` color (`#E53535`) — distinct red separate from the hot-pink `StInput`, used by `stateColor()` and `stateLabel()`.
- (android) `parked: Boolean?` field in `ProjectConfig` — parked projects loaded from server config are now recognised.
- (android) `parked` field on `Musician` — parked musicians are hidden from the tab bar (same as desktop behavior).
- (android) `Api.parkProject()` — `POST /api/project/:name/park` client method to toggle a project's parked flag.

### Changed
- (android) `Musician.ingest()` result branch: error turns now set `State.error` instead of `State.input`.
- (android) `Musician.ingest()` system/init branch: a new turn on a project in `State.error` now correctly transitions to `State.live`.
- (android) `tabPriority()` in `TabBar`: `State.error` surfaces at priority 0 (same urgency as `input`).
- (android) `TabBar` `others` list now filters out parked musicians.
- (android) Bumped `versionName` `0.2.0` → `0.2.1`, `versionCode` `2` → `3`.

## [0.2.0] - 2026-04-30

### Added
- (server) `GET /api/version` endpoint exposing the `package.json` version, token-gated like the rest of the API.
- (server) Visible version footer in the dashboard (`public/index.html`), populated at load via `/api/version`.
- (server) SFTP server on port 54782 (`ssh-server.js`): Ed25519-only auth against `secrets/ssh_authorized_keys`, read-only `builds/` root, host key auto-generated to `secrets/ssh_host_ed25519_key`.
- (server) `POST /api/ssh/register-key` endpoint to append a client public key to `secrets/ssh_authorized_keys`.
- (server) `logs/ssh-auth.log` for verbose SSH auth diagnostics (every parseKey/getPublicSSH/match step).
- (server) Graceful EADDRINUSE recovery: server kills the process holding port 7777 (`netstat -ano` + `taskkill /F /PID`) and retries `listen()` instead of crashing.
- (android) `Builds` tab in the fleet UI: SSH key registration card, project/APK browser over SFTP, download with progress, install via `FileProvider`.
- (android) Visible version label `v<versionName>` in `FleetScreen` header (sourced from `BuildConfig.VERSION_NAME`).
- (android) Debug card under the registered-key state showing the public key (selectable) and the runtime Java class of the key pair, for SSH auth debugging.
- (android) Full error-cause chain rendered inside `BuildsScreen`'s error card (selectable, monospace) when SFTP operations fail — no logcat needed.
- (project) Standing fleet rules section in `CLAUDE.md` and this `CHANGELOG.md`.

### Changed
- (server) Bumped `package.json` version `0.1.0` → `0.2.0`.
- (android) Bumped `versionName` `0.1.0` → `0.2.0`, `versionCode` `1` → `2`.
- (android) `SshKeyStore` now generates **and** rehydrates Ed25519 key pairs through the explicit BouncyCastle provider so sshj sees `BCEdDSAPublicKey` / `BCEdDSAPrivateKey` types regardless of which provider was active when a key was first stored.
- (android) `OrchestreApp.onCreate` removes Android's stripped `BC` provider and inserts the full `bcprov-jdk18on:1.75` at position 0 before any JCE call.

### Fixed
- (android) SFTP auth `Cannot find an available KeyAlgorithm for type unknown`: added `net.i2p.crypto:eddsa:0.3.0` so sshj's `ServiceLoader` resolves the Ed25519 `KeyAlgorithm` at runtime.
- (android) SFTP auth `no such algorithm: X25519 for provider BC`: replaced the Android-shipped stripped BouncyCastle with the full `bcprov-jdk18on:1.75` artifact (matches sshj 0.38.0's transitive expectation).
- (server) `ssh-server.js` no longer crashes the host process on malformed keys or unhandled session errors (defensive try/catch + `session.on('error')` handlers).

[Unreleased]: ./
[0.2.0]: ./
