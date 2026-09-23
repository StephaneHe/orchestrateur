# Implémentation P0 « redéfinition des événements » — progression

Spec : `docs/orchestrateur-events-redesign-fable.md` § PLAN P0. Cible web **0.18.0**, Android **vc13**.
**Serveur 7777 NON redémarré par moi — le chef redéploie.** Vocabulaire d'états verrouillé (aucune nouvelle chaîne).

## P0-1 — Panier de résultats (client) — FAIT
- [x] callback pendant un tour chef → différé (`_pendingResults`), rendu APRÈS la bulle finale (`_endChefTurn`)
- [x] groupe « Résultats reçus (n) » (`role:"results"`), replié si n>1, ouvert si n=1
- [x] chef.turn suivant : « prend en compte : A ✓ B ✕ » (snapshot au `system/init`, rendu sur la réflexion ou la bulle chef)
- [x] `loadChatHistory` reconstruit le même ordre (maintien pendant un tour + fusion des paniers adjacents)
- [x] filet PID (`_disarmConductorWait`) vide le panier → jamais de résultat piégé
- Vérif : ordre `user,conductor,results` ; 3 callbacks → 1 panier de 3 ; reload → `user,conductor,results,user,conductor`

## P0-2 — Carte de résultat enrichie (serveur + client) — FAIT
- [x] `notification` enrichie : `outcome`, `summary`, `duration_ms`, `cost_usd`, `awaitingChef` (tous additifs)
- [x] `summarizeResult()` = dernier paragraphe (≤280c, coupe sur un mot) au lieu du `slice(0,600)` tronqué
- [x] carte à liseré couleur d'état + durée + coût + bouton « voir » ; rétro-compat vérifiée (ancien callback → carte `done`)
- [x] `/api/conductor-chat` repasse les champs → reload identique

## P0-3 — Question musicien dans le fil + attend-le-chef (serveur + client) — FAIT
- [x] `notification/musician_question` écrite sur transition → `input` ; le client la rend en bulle « X te demande » qui SAUTE le panier + bouton qui préremplit `@X`
- [x] `NEEDS_CHEF_INPUT` → `awaitingChef` (état reste `unread` — vocabulaire verrouillé) ; carte web affiche « ATTEND LE CHEF », carte de résultat affiche ⇄ + badge
- [x] course réglée : le watcher n'émet plus « Tour terminé » pour un tour qui attend le chef (outcome `ask_chef`), et un `result` SYNTHÉTIQUE n'émet plus rien du tout
- [x] échec (`error`) émet désormais une carte `failed` (avant : silence total)

## P0-4 — Android : synthétique ≠ échec — FAIT
- [x] `Models.kt` : champ `synthetic` désérialisé (il ne l'était pas → toujours traité comme une vraie erreur)
- [x] `Musician.kt` : `isErr && synthetic` → `State.idle` + `syntheticCause()` (« limité (quota) » / « interrompu »)
- [x] vc13 / 0.4.8 construit — APK `android/app/build/outputs/apk/debug/app-debug.apk`

## P0-5 — Question du chef conservée — FAIT
- [x] `/api/conductor-chat` ne supprime plus la réponse quand `NEEDS_USER_INPUT` : elle est conservée avec `question:true`
- [x] client : bulle chef marquée « question » (liseré orange + tag), en live comme au reload

## Notes
- Seul point « noyau » : la valeur choisie par le reducer Android pour un `result` synthétique (`error` → `idle`).
  C'est un ALIGNEMENT sur les 3 reducers serveur/web, pas une nouvelle chaîne d'état.
- `synthetic` n'était pas dans `RawEvent` : l'app ne pouvait pas distinguer un tour clos par le système d'un échec.
- Un `result` synthétique n'émet plus AUCUN callback (avant : rien non plus, car seul `unread` notifiait — mais un
  échec réel ne notifiait pas non plus ; c'est corrigé, `failed` émet une carte).
- Non fait volontairement (P1) : exposer `awaitingChef` via `/api/pupitre`, bandeau attention, limite 5 h, pupitre mobile.

## P1 — priorité MOBILE (2026-09-23, android vc14/0.5.0 + web 0.19.0) — FAIT
- [x] **Snapshot pupitre mobile** : `Api.fetchPupitre()` + `PupitreSnapshot`/`PupitreRow` ; poll 5 s **premier plan seulement**
      (démarré par boot/resumeStream, arrêté par pauseStream) ; `Musician.applyPupitre()` alimente stalled/deadInFlight/pid/
      pidAlive/silentMs/turnElapsedMs/observedModel/activity/queueDepth. Un musicien planté ne reste plus « EN COMMUNICATION ».
- [x] **2ᵉ ligne de panneau** (`TelemetryStrip` dans MainPane) : activité · tour · silence · pid ✓/✗ · modèle · file,
      + bandeau « ⚠ PROCESSUS PERDU » / « ⚠ SANS PROGRÈS OBSERVÉ ». Pastilles d'onglet : `✗` / `⚠` / `⇄`.
- [x] **Fil chef mobile à parité** : panier « Résultats reçus (n) » (retenu pendant un tour chef, publié après la réponse,
      replié si plusieurs), `ResultCard` (liseré couleur d'issue + durée + coût + résumé + badge « attend le chef »),
      `QuestionBubble` (saute le panier), `TakingLine` (« prend en compte : A ✓ B ✕ »), réponse chef marquée QUESTION.
      `loadConductorHistory` rejoue le même ordre (maintien pendant un tour + fusion des paniers).
- [x] **Onglet stable** : promotion en tête seulement au passage en `input`/`error` (avant : à CHAQUE transition).
- [x] **`awaitingChef` sur `/api/pupitre`** : ajouté dans `deriveState` + `scanProject` (additif, état inchangé).
- [x] **Limite 5 h + fraîcheur** : bandeau système « ⚡ Claude limité jusqu'à HH:MM » / « ⟲ données anciennes ».
- [x] Bonus : dédup des callbacks (notification + user_prompt relayé) ; `shortcut→X` rendu en bulle utilisateur.
- Vérif : build Android **sans warning**, APK vc14/0.5.0-debug ; `node --check` server.js + fleet-status-core.mjs ;
  `deriveState` testé (NEEDS_CHEF_INPUT → unread+awaitingChef, NEEDS_USER_INPUT → input, nouveau tour → reset).

## Reste à faire (P2 / web)
- **Mobile P2** : replier l'activité intermédiaire du chef (aujourd'hui chaque outil = une ligne à plat dans le fil).
- **Web P1 restant** : bandeau « Attention » agrégé en tête du fil ; consommer `limitedUntil`/`noFailover`/`queueDepth`
  côté web ; rendu des notices `log_growth_skipped` ; tri différé des cartes.
