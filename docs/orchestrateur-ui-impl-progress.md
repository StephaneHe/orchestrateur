# Implémentation UI Orchestrateur — progression (Opus 5)

Spec autoritaire : `docs/orchestrateur-ui-redesign-validated.md`.
Lot en cours : **P0 uniquement**. Web 0.21.0 · Android 0.6.0 / vc15.

Légende : ☐ à faire · ◐ en cours · ☑ fait

---

## Web (`public/*`) — ☑ terminé

Nouveaux fichiers : `public/salle.css` (chargé après `styles.css`, complète et
surcharge) et `public/salle.js` (chargé **avant** `app.js`, expose `window.Salle`).

| # | Lot | Statut | Notes |
|---|---|---|---|
| P0-1 | Disposition : fil ≈ 2/3 + rail PILOTAGE, en-tête chef, suppression scène de cartes + `#chef-card` | ☑ | `.stage` en colonne flex, `#main-row` = fil + rail (+ volet). Groupes En cours / À examiner / Tous / Mis de côté, tri stable, réordonnancement différé 1,5 s et suspendu sous le pointeur. Mobile : ligne « Pilotage » + feuille (remplace `#tab-bar`). |
| P0-2 | Bloc MISSIONS (+ ACTIVITÉ DE L'ORCHESTRE), rehydratation `/api/project/chef/events` | ☑ | `Salle.extractDispatches()` (nom validé contre la flotte) + `App._openMission/_markMissionStarted/_closeMission`. Rehydratation par `App.rehydrateMissions()` ; fenêtre bornée annoncée. |
| P0-3 | Panier → Point sur les résultats (wake mémorisé, liseré double, puces) | ☑ | `_wakeObservedAt` (jamais affiché) consommé au `system/init` ⇒ `report:true`. Paniers séparés par `_lastTurnStartTs`. Moteur 0.18 (`_fileResult`/`_appendResultGroup`/`_flushPendingResults`) conservé. |
| P0-4 | Questions via le chef (défaut) / direct secondaire, contexte composer | ☑ | `answerViaChef()` / `talkToChefAbout()` / `sendDirectTo()`, chip « À : CHEF », zone `#composer-context`. |
| P0-5 | Bande d'attention + bandeau système unique + vocabulaire de fraîcheur | ☑ | `Salle.renderAttention()` (question > PID mort > échec > sans progrès) et `Salle.renderSysBanner()` (un seul, le plus grave). `setConnState` distingue « direct interrompu » de « hors ligne ». |
| P0-6 | Détail musicien routé `#/m/<X>` à onglets + recherche globale | ☑ | `Salle.router()` sur `hashchange`, volet remplaçant le rail, onglets Activité / Dernier résultat / Journal, `PupitreDetail` réutilisé, « En parler au chef » + Actions avancées, annuaire `#overlay-search` (parkés inclus). |

### Vérification web

Banc de fumée jsdom (hors dépôt, `%TEMP%\orch-jsdom\smoke.mjs`) rejouant les
scénarios de réception du §9 : **41/41**, zéro erreur runtime.
Couvre : rail ≤ 8 lignes avec flotte chargée · parkés invisibles sans dépliage ·
attention priorisée · bandeau PID mort · missions rehydratées avec issue ·
activité de l'orchestre séparée · wake invisible ⇒ POINT · 3 fins pendant un tour
⇒ **un** panier après la réponse · réponse via le chef · envoi direct explicite ·
`#/m/X` ouvre/ferme et rend le rail · onglets Résultat/Journal · annuaire filtrant ·
SSE coupé ⇒ « direct interrompu ».

## Android (`android/*`) — ☑ terminé

| # | Lot | Statut | Notes |
|---|---|---|---|
| P0-7 | Navigation 3 destinations, ligne Pilotage + feuille (recherche/filtres), bottom sheet L1, détail à onglets, « Nouveau rapport ↓ », version serveur | ☑ | `MainActivity.kt` (NavHost, VM à l'échelle de l'activité), `PilotageSheet.kt` (nouveau), `MusicianDetailScreen.kt` (nouveau), `FleetScreen.kt` → `JournalScreen` + `SettingsScreen`, `MainPane.kt` (MissionLine / MissionSheet / point / questions via le chef), `FleetViewModel.kt` (missions, wake→point, isInfo, contexte de réponse), `Api.kt` (`/api/version`). |

Dépendance ajoutée : `androidx.navigation:navigation-compose:2.8.5` (résolue, build OK).

Le ViewModel est créé dans `MainActivity` et passé aux destinations : sans cela chaque
`NavBackStackEntry` en aurait créé un nouveau (second SSE, fil rechargé, ancre perdue).
C'est ce qui rend vrai le critère « Back depuis détail ⇒ journal à la même ancre ».

## Livraison

| Item | Statut |
|---|---|
| `package.json` 0.21.0 | ☑ |
| `CHANGELOG.md` 2026-09-23 | ☑ |
| Android vc15 / 0.6.0 | ☑ (`versionCode = 15`, `versionName = "0.6.0"`) |
| `node --check` sur les fichiers Node modifiés | ☑ (`public/app.js`, `public/salle.js`) |
| APK debug construit + chemin donné | OK — `I:/orchestrateur/android/app/build/outputs/apk/debug/app-debug.apk` (vc15 - 0.6.0-debug) |
| Commit local (pas de push, pas de restart) | ☑ deux commits : web puis Android |

## Garde-fous vérifiés

- [x] `idle|live|think|input|error|unread` : aucune nouvelle chaîne DOM / enum Kotlin
- [x] 0.16.1 — `_armConductorWait` / `_disarmConductorWait` inchangés ; le wake sourcé n'arme rien
- [x] 0.17.0 — cadences `/api/pupitre` inchangées (5 s flotte / 2,5 s ciblé), aucun poll par ligne
- [x] 0.18.0 — `_makeResultItem` / `_fileResult` / `_appendResultGroup` / `_flushPendingResults` conservés ; la mission POINTE vers la carte, ne la duplique pas
- [x] 0.19.0 — parité Android : snapshot, stall, PID, seconde ligne, limite, panier et questions conservés ; sélection stable (la feuille trie une fois par composition)
- [x] 0.20.0 — prompt `source:"wake"` jamais affiché ; aucun bouton ne déclenche un wake
- [x] Aucun changement `server.js` (pas de restart P0)

## Reste (hors P0)

- **P1** : `expectCallback`/`pendingWake` dans `/api/pupitre` (badge « attendu par le chef »),
  `wake:true` dans `/api/conductor-chat` (le Point survit au rechargement), trous de flux
  explicites, accessibilité, routes `#/reglages` et `#/telechargements`. **Un seul redémarrage
  serveur groupé, décidé par le chef.**
- **P2** : suppression effective du code mort (`computeFanLayout`, `computeDesktopArc`,
  `wireFanSwipe`, `deckRotate`, `renderFocusedBody`, `redrawThreads`, `renderParkedShelf`,
  `scheduleThreadSettle`, CSS de la scène), fusion `attentionRank` / `PupitreRow.rank`,
  découpage de `app.js` en modules, `#/pupitre` intégré, remplacement des `alert()` restants.
