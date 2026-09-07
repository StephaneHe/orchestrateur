# TODO_LIST

Suivi léger des tâches en cours / différées côté orchestrateur.

## Fait

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
