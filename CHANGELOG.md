# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project ships two artefacts that share a single changelog: the Node.js
server/dashboard and the Android companion app. Entries are prefixed
`(server)` or `(android)` when the scope is one-sided.

## [Unreleased]

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
