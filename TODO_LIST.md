# TODO_LIST

Suivi léger des tâches en cours / différées côté orchestrateur.

## Fait

- [x] **Pool de chefs — P0-A : la file devant un chef unique** (2026-09-24, v0.22.0).
  Spec : `docs/orchestrateur-multichef-queue-fable.md` (§5, lots A1→A7). Progression :
  `docs/orchestrateur-multichef-impl-progress.md`.
  Écrire au chef pendant qu'il travaille **ne tue plus** son tour (`server.js` interrompait) : le message
  devient un **ticket FIFO persisté** (`logs/queue/chef.pool.json` + journal `chef.pool-log.ndjson`) et un
  ordonnanceur unique (`schedulePool`, modèle `tryFireWake`) le tire quand le chef se libère. L'interruption
  reste un **geste explicite** (`!interrupt`, `force_interrupt`, `POST /api/pool/interrupt/:slot`) et le
  remplaçant passe en tête. Classes `user`/`decision`/`point` (le réveil 0.20.0 et le relais
  `NEEDS_CHEF_INPUT` passent par la file) ; `LOST` requeué **×1** avec note `[REPRISE]` ; gelé sous
  `claude-limited.until`. Prérequis de concurrence posés : **`dispatch.mjs --model/--provider`** (fin de la
  « dance » `config.json`), **`--queue-if-busy`** (un musicien occupé n'est jamais doublé d'un second
  `--resume`), **`drainQueue` ne perd plus le `--callback`**. API additive `/api/pupitre.pool`, SSE `pool`,
  `/api/conductor-chat` avec `ticket`/`slot`/`queued`/`answersTicket`. UI : statut sous chaque bulle, bande
  « File de direction », `À : CHEF (n libre)`, pill « ↩ répond à ». 42 assertions
  (`scripts/_test_pool_p0a.mjs`) sur le code réel en bac à sable, 0 spawn réel.
  **Restart 7777 requis (chef)** + **contrat du chef à appliquer par lui** (texte exact dans le doc de
  progression, §A6). **Toujours UN SEUL chef** : `conductorPool.size` est borné à 1.
  Reste : **P0-B** (pool de 3 : slots `chef-2`/`chef-3`, affinité/épinglage, registre de direction,
  délégation bornée, UI 3 pastilles) puis **P1** (Android, `/pupitre`, métriques, accessibilité).

- [x] **Réveil sûr du chef sur callback attendu — P0** (2026-09-23, v0.20.0). Spec : `docs/orchestrateur-callback-wake-fable.md`.
  `--callback chef` était utilisé 515 fois par le chef mais **jamais enregistré** → aucune réinvocation, promesse sans suite.
  `dispatch.mjs` stampe `callback`/`wakeGen` sur le `user_prompt` du tour ; `reduceMusician` capture et consomme au `result` ;
  sur résultat réel **attendu**, panier coalescé 10 s (cap 90 s) → **1 seul** tour `[CALLBACK_WAKE lot=n gen=k]` via
  `spawnDirectDispatch(--source wake)` → le chef reprend **sa session**. Garde-fous : sélectivité, `gen ≤ 2`, 1 tir en vol,
  jamais d'interruption, 60 s/6 h, pas sous limite, annulation si l'utilisateur écrit, idempotence + 1 rattrapage borné.
  Client : prompt `wake` invisible (la réponse porte « prend en compte »). 20 assertions sur fixtures, 0 spawn réel.
  **Restart 7777 requis (chef)** + **contrat du chef à appliquer par lui** (texte exact dans le doc de progression).
  Reste P1 : stall/synthétique, `/api/pupitre`, budget visible, liveness dans `spawnDirectDispatch`.

- [x] **Événements P1 — priorité MOBILE** (2026-09-23, android vc14/0.5.0 + web v0.19.0). L'app Android rattrape le P0 web.
  L'app n'interrogeait PAS `/api/pupitre` → aucune fraîcheur, un musicien planté restait « EN COMMUNICATION » : poll 5 s
  premier plan, stall/PID mort/durée/silence, 2e ligne de panneau + pastilles `✗`/`⚠`/`⇄`. Fil chef à parité web : panier
  « Résultats reçus (n) » publié APRÈS la réponse du chef, cartes de résultat (issue/durée/coût/résumé), question musicien
  qui saute le panier, « prend en compte : A ✓ B ✕ », réponse chef marquée QUESTION, historique rejoué dans le même ordre.
  Onglet stable (promotion seulement sur input/error). Bandeau système limite 5 h + « données anciennes ». Dédup des
  callbacks. Serveur : `awaitingChef` additif sur `/api/pupitre`. **Restart 7777 requis (chef)** pour la part serveur.
  APK `android/app/build/outputs/apk/debug/app-debug.apk`. Reste : P2 mobile (replier l'activité du chef) + P1 web restant.

- [x] **Redéfinition des événements / enchaînements — P0** (2026-09-22, web v0.18.0 + android vc13/0.4.8).
  Spec : `docs/orchestrateur-events-redesign-fable.md`. Panier de résultats (un callback n'est plus inséré dans un tour chef ;
  publié après la réponse, groupé, replié si plusieurs ; en-tête « prend en compte : A ✓ B ✕ » sans déclencher de tour) ;
  carte de résultat enrichie (outcome/summary/duration/cost additifs, résumé = dernier paragraphe au lieu d'un slice(0,600)) ;
  question musicien dans le fil du chef + bouton `@X` ; « attend le chef » ≠ « terminé » (`awaitingChef`, état `unread` inchangé)
  + course SSE/watcher réglée ; synthétique n'émet plus de callback, échec en émet un ; question du chef conservée à l'historique ;
  Android : synthétique → `idle` + cause, plus d'ERREUR rouge. Vérifié headless + `node --check` + APK construit.
  **Restart 7777 requis (chef)** ; client = hard-reload. Progression : `docs/orchestrateur-events-impl-progress.md`.
  Reste : **P1** (bandeau attention, limite 5 h visible, badge attend-le-chef sur /api/pupitre, snapshot pupitre mobile,
  notices de transport, tri différé / onglet mobile stable) puis P2/P3.

- [x] **Refonte affichage musiciens + serveur — P0 (Lots 1/2/3)** (2026-09-19, v0.17.0). Spec : `docs/orchestrateur-redesign-validated.md`.
  Lot 1 (client) : PID mort > sans progrès, libellés FR (clés d'état inchangées), briefing compte erreurs+bloqués, détail live rend
  l'assistant consolidé sans deltas, pastille connexion/fraîcheur. Lot 2 (client) : tri par attention stable, 2ᵉ ligne de carte
  (/api/pupitre : PID/tour/model), poll 5 s visible. Lot 3 (serveur, **restart 7777 par le chef**) : pas de drain de file sur result
  synthétique (B1), /api/pupitre cache mtime+size + skip parked + champs queueDepth/noFailover/limitedUntil, reducers ignorent
  user_prompt sourcé, route morte /sse/logs supprimée, watcher borné (blocs 4 MiB), heal ignore notification/callback.
  Vérifié headless + node --check + deriveState. Progression : `docs/orchestrateur-impl-progress.md`. Reste (non fait) : P1/P2/P3 du rapport.

- [x] **Fix chef figé « LE CHEF RÉPOND… » (P0)** (2026-09-18, v0.16.1, `public/app.js` + `scripts/dispatch.mjs`).
  P0-a : `_awaitingConductorResponse` armé seulement sur `user_prompt` sans `source` OU `system/init` (callback/@shortcut n'arment plus ; F5 : @shortcut rendu en bulle utilisateur). P0-b : filet liveness PID
  (`_conductorLivenessCheck`, ticker 5 s + reopen SSE) désarme si armé >20 s et chef `pidAlive!==true`. P0-c :
  `result` synthétique `error_limited` avant les 2 sorties no-failover de `dispatch.mjs`. Périmètre P0 strict
  (pas de P1/P2). Vérifié headless + `node --check`. **Aucun restart serveur — hard-reload du dashboard requis.**
  Suite possible (non demandée) : P1 dans `docs/chef-stuck-analysis-validated.md` (reducers, route morte /sse/logs, bornage watcher, heal).

- [x] **Kill-switch failover (sentinelle `logs/no-failover`)** (2026-09-17, v0.16.0, `scripts/dispatch.mjs`).
  Si `logs/no-failover` existe, aucune bascule de modèle sur limite Claude : la date de reset est quand même
  écrite dans `logs/claude-limited.until`, event `system/limited-no-failover` loggué, puis arrêt propre
  (`endLogAndExit(1)`). Garde aux 2 points d'entrée (fin de tour + démarrage), avant `runNvidiaFailover()`.
  Branche codex intacte. Réversible (retirer la sentinelle réactive). But : run de nuit « Opus 4.8 uniquement ».
  `node --check` OK. Sentinelle créée (datée 2026-09-17). Pas de restart 7777 (dispatch.mjs relu à chaque appel).

- [x] **Hot-reload des musiciens (ajout/retrait sans restart)** (2026-09-11, v0.15.0). `config.json` surveillé (chokidar)
  + poll 3s fallback → `reloadConfigFromDisk` réconcilie `config.projects`/streams en place, abonne les dashboards connectés
  aux nouveaux flux, pousse un signal SSE `fleet_config_changed` ; client (`refreshFleet`) réconcilie la liste sans rebuild.
  JSON invalide = liste précédente conservée (pas de crash). Vérifié (logique isolée + reconcile headless).
  **Un dernier restart 7777 (chef) pour déployer**, ensuite hot.

- [x] **`/downloads` liste l'app orchestrateur** (2026-09-11, v0.14.4). `'orchestrateur'` ajouté à `DOWNLOAD_APPS` +
  `APP_VERSION_SOURCES` (version lue depuis `android/app/build.gradle.kts` = 0.4.6). APK déjà dans `builds/orchestrateur/latest.apk`.
  **Restart serveur 7777 requis (chef)** pour que la carte + le lien `/downloads/orchestrateur/apk` apparaissent.

- [x] **App Android : vignette sélectionnée toujours visible + panneau chef conserve tout le tour** (2026-09-11, android vc11 0.4.6).
  Bug1 `TabBar.kt` : la vignette active est épinglée à gauche (tabPriority -1 pour activeTab) → plus de disparition/inaccessibilité.
  Bug2 `FleetViewModel.kt`/`MainPane.kt` : le contenu mi-tour du chef (thinking/tool/texte/result) est accumulé en entrées
  persistantes (`Role.activity`) au lieu du buffer transitoire liveText → rien n'est effacé, tour scrollable ; synthèse finale = bulle conductor.
  Compile OK. **Non installé (device déconnecté)** → APK à copier par le chef.

- [x] **Fix RACINE callbacks musiciens : plus de faux tour utilisateur au chef** (2026-09-09, v0.14.3, server.js).
  `autoNotifyConductor` ne re-dispatche PLUS le callback « [musicien] Tour terminé… » au chef comme user_prompt.
  Une complétion = event musicien (notification `musician_done` + `result` dans logs/<projet>.jsonl que le chef lit).
  Plus de réponse forcée du chef ni d'attribution à l'utilisateur. Vrai chat chef↔user + NEEDS_CHEF intacts.
  **Restart serveur 7777 requis (chef).** (v0.14.1 client = défense en profondeur, conservé.)

- [x] **`/downloads` page blanche sur Android TV (MiBox)** (2026-09-09, v0.14.2). Cause : `<link>` render-blocking
  vers fonts.googleapis.com → sur TV sans internet le vieux WebView bloque le paint → blanc. Fix (`server.js`
  `downloadsPageHtml`) : page autonome, polices système, plus de ressource externe ; espacement flex-gap → marges
  (compat Chromium <84). Vérifié headless (UA MiBox + offline → cartes visibles). **Restart serveur requis (chef).**

- [x] **Dashboard — callbacks musiciens déguisés en messages user, dupliqués, rejoués** (2026-09-08, web v0.14.1).
  Cause : `autoNotifyConductor` (serveur) écrit un `musician_done` PUIS dispatche le même « [musicien] Tour terminé… »
  au chef (user_prompt sans source → rendu comme user). Fix client (`app.js`) : reclassement relay→callback,
  dédup par contenu (`_callbackDup`) dans `onConductorEvent` + `loadChatHistory`, plus de re-post d'anciens.
  Vérifié headless. Client statique → hard-reload. (Note racine serveur : le dispatch relay devrait porter `--source`.)

- [x] **Liens cliquables dans le chat (web + Android)** (2026-09-08, web v0.14.0 / android vc10 0.4.5).
  Web `mdToHtml` : autolink URL nues http(s):// + liens markdown → `<a target=_blank>` (guards anti double-link/code).
  Android `Markdown.kt` : annotation URL + `LinkableText` (ClickableText + LocalUriHandler) → ouvre le navigateur.
  Vérifié headless (web). Android compile OK ; **non installé (device déconnecté)** → APK à copier par le chef. Web = hard-reload.

- [x] **App Android — trous vides supprimés dans la session musicien + entête version propre** (2026-09-07, android vc9 0.4.4).
  `MainPane.kt` : ring filtré par `isRenderable()` (plus d'items vides des `user`/tool_result/`system`), spacing 8→6dp, texte trimé.
  Coût fleet retiré de l'entête (collait à la version → « $1.85 » perçu comme artefact) ; usage par tour toujours sur les lignes result. Installé sur device.

- [x] **App Android — carte/session musicien : tool_use avec cible, réflexion rendue, version corrigée** (2026-09-07, android vc8 0.4.3).
  `Block.input` désérialisé + `toolArgPreview` → `⚙ Edit <fichier>` / `Bash <cmd>` (aligné web) ; `thinking` rendu ;
  `fmtCost`/`fmtTok` en `Locale.US` (le « $6,78 » était le coût fleet, pas un artefact). Installé sur device.

- [x] **App Android — barre des musiciens triée par activité** (2026-09-07, android vc7 0.4.2).
  `TabBar.kt` : `tabPriority` réordonné (live/think à gauche) + tri stable (`sortedBy`), re-tri live,
  chef hors tri, parkés exclus, sélection préservée. Installé sur device.

- [x] **App Android — ouverture de la page chef directement en bas** (2026-09-07, android vc6 0.4.1).
  `MainPane.kt` : `animateScrollToItem` → `scrollToItem` instantané au 1er affichage (flag one-shot
  `firstScrollDone`), puis animé pour le suivi live. Idem vue session musicien. Installé sur device.

- [x] **Dashboard web — réponse du chef affichée en double corrigée** (2026-09-07, v0.13.2). Cause :
  la réponse finale était stockée à la fois dans la bulle « réflexion » (event `text`) et comme bulle
  `conductor` (`onConductorEvent`/result). Fix : au `result`, fermeture en arrière de la dernière réflexion
  ouverte + retrait de son event `text` égal à la réponse → affichage aligné sur l'historique serveur.
  Vérifié headless (0 doublon, callback intercalé OK). Client statique → hard-reload.

- [x] **Dashboard web — fin du clignotement pendant le streaming SSE** (2026-09-07, v0.13.1). `renderMainPane`
  ne reconstruit plus tout le transcript à chaque event : réconciliation en place (`reconcileChildren`,
  clé index+signature), interactions en délégation, feeds de cartes via `setHtmlIfChanged`. Vérifié headless
  (identité DOM préservée sur 25 events, 0 erreur, perf 0.11.0 intacte). Client statique → hard-reload pour appliquer.

- [x] **Refonte app Android + serveur — token retiré, SSH/Builds supprimés, cartes temps réel** (2026-09-07, v0.13.0 / android vc5 0.4.0).
  Token gate serveur désactivé (`TOKEN_GATE_ENABLED=false`, **restart 7777 requis côté chef après checkpoint user**) ; auth token entièrement retirée de l'app ; SSH/SCP + onglet Builds supprimés (sshj/BC/eddsa/security-crypto + perm INSTALL). Cartes temps réel : `stream_event` hors ring + buffer live streaming, merge-on-Open, buffer SSE illimité, boot auto-réparant.

- [x] **`/downloads` — toutes les apps Android du fleet** (2026-09-04, v0.12.0). `DOWNLOAD_APPS`
  élargi à 11 apps (+ DeskZen, vuBox/TV, firstAidOffline, frenchradio, immo-share/mobile,
  meetingScribe, photoLab, SncfOptimizer, sommeil), `builds/<nom>/latest.apk` peuplés (APK
  gitignorés), `readAppVersion` généralisé (table + regex Kotlin/Groovy), badge plateforme.
  **Restart 7777 requis (chef)** + rafraîchir `builds/DeskZen/latest.apk` avec la build signée.

- [x] **Perf dashboard — animations compositor-only + pause onglet caché** (2026-09-02, v0.11.0).
  Supprime le plancher « gpu-process/DWM 100 % au repos » (latence clavier 3-6 s). Fils SVG
  statiques (drop-shadow + `stroke-dashoffset` retirés, redraw diffé), halos `blur` sur `::before`
  statique + keyframes littérales, anneau d'attente `box-shadow`→`::after` opacity, SSE batché rAF
  + auto-scroll throttlé, tickers dirty-flag, `html.anim-paused` via Page Visibility. Vérifié
  Chrome headless (0 erreur console, blur déplacé) ; chute GPU réelle à confirmer par l'utilisateur.

- [x] **Failover → cascade NVIDIA codage-first** (2026-08-31, v0.10.0). La patte
  failover de `scripts/dispatch.mjs` route vers NVIDIA (endpoint OpenAI-compatible)
  au lieu de codex/gpt-5.6-sol : `moonshotai/kimi-k3` → `deepseek-ai/deepseek-v4-pro-0813`
  → `nvidia/nemotron-3-ultra-550b-a55b` → `deepseek-ai/deepseek-v4-flash-0731`.
  Client direct chat/completions (codex 0.147 exige l'API Responses, indispo côté
  NVIDIA). Clé dans `.env`. Auto-test `--test-failover`. Doc : `docs/failover-nvidia.md`.

## À surveiller / différé

- [ ] **Tool-use en mode failover** : le leg NVIDIA est single-shot (pas de Bash/Edit,
  pas de callback auto). Réévaluer si/quand NVIDIA expose l'API Responses, ou câbler
  une mini-boucle agentique maison si le besoin se confirme.
- [ ] **Fiabilité endpoint NVIDIA gratuit** : latence variable (~2 s à >80 s) et
  `ECONNRESET` ponctuels observés sur les modèles deepseek lors du test 2026-08-31
  (kimi-k3 et nemotron-3-ultra OK). La cascade absorbe ces échecs ; surveiller si un
  rung devient durablement indisponible et réordonner le cas échéant.
- [ ] **Vérifier le leg en conditions réelles** : l'auto-test prouve le client + la
  cascade sans déclencher de vraie limite. La chaîne complète (flag `claude-limited.until`
  → `runNvidiaFailover` → events écrits dans le log projet) se validera à la prochaine
  vraie limite de session Claude.
