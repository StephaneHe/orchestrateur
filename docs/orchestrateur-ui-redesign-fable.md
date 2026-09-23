# Design fonctionnel UI Orchestrateur (web + Android) — Anthropic Fable — 2026-09-23

Document de design, lecture seule sur l'arbre de travail (v0.20.0 sur disque). Aucun code modifié, serveur 7777 non redémarré. Conçu à partir du code serveur et de l'UI actuelle, **sans lecture** du design d'Astra. Numéros de ligne vérifiés au moment de l'écriture.

**Concept en une phrase : l'UI est le journal de bord du chef.** Un seul fil, celui du dialogue chef ↔ utilisateur. Tout ce que le chef fait faire aux musiciens apparaît *dans* ce fil, à l'endroit où il l'a décidé, sous forme de **cartes de mission** qui évoluent sur place (lancée → en cours → terminée/question/échec). Le rapport du chef vient les clore. Plonger dans un musicien ouvre une **fenêtre latérale** sur son flux, sans jamais quitter le fil ; on remonte exactement là où l'on était.

---

## 1. Cartographie serveur — la matière de l'UI

### 1.1 Endpoints et ce qu'ils donnent

| Endpoint | `server.js` | Contenu utile à l'UI | Usage dans ce design |
|---|---|---|---|
| `GET /api/config` | `:1712-1738` | conducteur, projets (path, model, tools, provider, `parked`, `attachedSession`, `readAt`), **état hydraté** `currentState` + `lastLine` + `unreadCount` via `scanProjectState` (`:1649-1706`) | bootstrap du rail et de la carte chef ; `parked` sépare la « remise » |
| `GET /api/pupitre` | `:1776-1801` | par membre (chef inclus) : `state`, `awaitingChef`, `stalled`, `deadInFlight`, `lastKind`, `activity`, `silentMs`, `fileSilentMs`, `turnElapsedMs`, `pid`, `pidAlive`, `model`, `provider`, `needsInput`, `queueDepth`, `isConductor`, `parked` ; racine : `now`, `noFailover`, `limitedUntil` | **source de vérité de la santé** (stall, PID mort, fraîcheur) — badge L0, en-tête musicien, bandeau système |
| `GET /api/conductor-chat?n` | `:2246-2328` | fil chef reconstruit : `user` (avec `source`, pièces jointes), `conductor` (+ `question:true`), `callback` (`outcome`, `summary`, `duration_ms`, `cost_usd`, `awaitingChef`) ; **saute** `source:"wake"` (`:2281`) | rechargement du fil ; les `callback` deviennent la face « résultat » des cartes de mission |
| `GET /api/project/:name/events?n` | `:2150-2236` | 500 derniers événements avec deltas recousus en `assistant` synthétiques | backfill du drill-down (niveau 2) |
| `GET /api/sse/fleet` | `:2665-2729` | **une** connexion, chaque ligne JSONL brute de chaque projet, + `fleet_config_changed`, `log_growth_skipped`, `oversized_line_skipped` | flux live des cartes, du fil chef, du drill-down |
| `POST /api/dispatch` | `:3365-3602` | `{project, prompt, attachmentPaths, videoPaths, force_interrupt}` ; raccourci `@X` vers un musicien (`:3420-3458`) avec file si occupé ; interruption coopérative si tour en vol (`:3511-3532`) ; 202 immédiat | le composeur du fil (vers le chef) **et** le composeur du drill-down (vers le musicien, `@X` implicite) |
| `POST /api/notify` | `:3103-3127` | `user_prompt` sourcé dans le log cible (callback prose des musiciens) | rendu comme *note de mission* rattachée à la carte, pas comme message |
| `POST /api/mark-read` | `:1836-1849` | marqueur `.read` → `unread` redevient `idle` | consommé quand la carte-résultat est dépliée ou le musicien ouvert |
| `GET /api/version` | `:1708` | version serveur | pied de page (règle standing) ; **manque côté Android** |
| `/api/projects*`, `/api/project/:name/{park,add-tool,provider}`, `/api/projects/:name/{sessions,attach}`, `/api/conductor` | `:1880-1941`, `:2889-3000`, `:3624-3800` | administration : ajouter/retirer/parquer, sessions Claude à attacher, outils, provider, changer de chef | menu « ⋯ » du musicien et écran Réglages — hors du fil |
| `POST /api/attach/image` | `:3812` | upload pièce jointe | composeur |
| `/downloads*`, `/pupitre` | `:1541-1576`, `:1807` | page builds/docs, page pupitre autonome | liens secondaires |

### 1.2 Le modèle d'événements que l'UI consomme

Trois familles, trois provenances, un même fichier par projet (`logs/<p>.jsonl`) :

| Événement | Écrit par | Sens | Réducteur |
|---|---|---|---|
| `user_prompt` **sans** `source` | `dispatch.mjs:628` | début de tour (demande réelle) | ouvre `live` |
| `user_prompt` avec `source` | `dispatch.mjs:630` (`--source`), `/api/notify`, raccourci `@` (`server.js:3433-3439`), **`wake`** (`:537`) | note de coordination, **pas** un tour | ignoré par les réducteurs ; `wake` sauté partout |
| `user_prompt.callback` + `wakeGen` | `dispatch.mjs:640-649` | **le chef attend ce tour** (v0.20.0) | `reduceMusician:2352-2355` le porte jusqu'au `result` |
| `system/init`, `stream_event`, `assistant`, `user` (tool_result) | claude CLI | progression | `live`/`think`, deltas pour le détail |
| `result` (ok / `NEEDS_USER_INPUT` / `NEEDS_CHEF_INPUT` / erreur / **synthétique**) | CLI ; `healOrphanedLogs` ; garde limite | fin de tour | `unread` / `input` / `unread`+`awaitingChef` / `error` / `idle` (`:2366-2383`) |
| `notification/musician_done` et `musician_question` | `autoNotifyConductor:3061-3101`, écrit **dans le log du chef** | carte-résultat : `outcome` (`done`/`failed`/`question`/`ask_chef`), `summary` (dernier paragraphe, 280 c., `:2400-2411`), `duration_ms`, `cost_usd`, `awaitingChef` | fil chef |
| `[CALLBACK_WAKE lot=n gen=k]` | `buildWakePrompt:477-493` → `spawnDirectDispatch(chef, …, {source:'wake'})` | le serveur demande au chef de faire le point ; le tour chef qui suit est un **rapport** | client : le prompt est masqué, la réponse porte « prend en compte » |

Points d'appui décisifs pour l'UI :

1. **L'attente est enregistrée** (`callback:"chef"` sur le `user_prompt` du musicien). C'est exactement l'information « le chef pilote ce musicien pour cette demande ». Elle est dans le flux SSE du musicien, donc le client peut **rattacher une mission au tour chef en cours** sans nouvelle donnée.
2. **Le rapport a une signature** : un `system/init` du chef qui suit un `user_prompt{source:'wake'}`. L'UI peut donc distinguer *réponse à l'utilisateur* et *rapport spontané*.
3. **La santé n'est pas dans les événements** : stall, PID mort, silence viennent uniquement de `/api/pupitre` (poll). Le client doit donc *toujours* garder ce poll, et n'afficher la fraîcheur qu'à partir de l'âge du dernier snapshot reçu.
4. **Le vocabulaire des réducteurs est verrouillé.** Le CLAUDE.md nomme `idle|live|input|done|error` pour le DOM ; les trois réducteurs (`scanProjectState`, `reduceMusician`, `deriveState`) et le client utilisent en réalité `idle|live|think|input|error|unread` (`done` ≡ `unread` + marqueur lu). Ce design **ne touche à aucune chaîne** ; tout ce qui suit est badge, regroupement, disposition.

### 1.3 Ce que l'UI actuelle fait de cette matière — et où ça coince

- **Deux surfaces concurrentes** : le fil chef à gauche et une grille de cartes absolument positionnées à droite (`app.js:537-569`), 29 projets dont 15 parqués. Le regard doit aller chercher l'orchestration hors du dialogue : le fil dit « je dispatche vuBox », la carte vuBox bouge ailleurs.
- **Le panier de résultats arrive après coup** (`_appendResultGroup`, `app.js:2135`) : le lien entre « j'ai lancé A » et « A a terminé » n'est que textuel (« prend en compte »). Il n'existe pas de carte qui *soit* la mission du début à la fin.
- **Le drill-down est un overlay modal** (`#overlay-focused`) sans route : impossible d'y arriver par un lien, de le garder ouvert en lisant le fil, ni de revenir en arrière proprement (aucun `hash`/`pushState`).
- **Mobile** : la « main de cartes » est calculée puis masquée par CSS (`styles.css:2344-2347`) ; la flotte est une barre d'onglets qui se réordonne à chaque transition ; un projet est un onglet, pas une plongée.
- **Android** n'a ni navigation (un seul `setContent`), ni carte de flotte, ni version affichée, ni bouton « répondre à X » ; il ré-implémente le fil et la télémétrie sans partager de logique.

---

## 2. Principes UX

| # | Principe | Conséquence concrète |
|---|---|---|
| P1 | **Le fil chef est la seule surface primaire** | Pas de grille de flotte au premier niveau. Les musiciens n'existent dans le fil que comme *conséquences* d'une décision du chef. |
| P2 | **Une mission = une carte, qui vit sur place** | La carte apparaît quand le chef dispatche, se met à jour pendant le tour, prend sa face finale au résultat. Le panier v0.18 devient la *face finale* de ces cartes, plus un bloc séparé. |
| P3 | **Le chef rend compte ; le musicien ne parle pas** | Seuls l'utilisateur et le chef ont des bulles. Musicien = carte (mono, liseré d'état). Système = bandeau ou badge, jamais une bulle. |
| P4 | **Plonger sans quitter** | Le drill-down est un volet latéral (desktop) ou un écran empilé (mobile). Le fil ne bouge pas ; retour = là où l'on était, garanti par une route. |
| P5 | **Trois niveaux, pas plus** | L0 une ligne · L1 la carte dépliée · L2 le flux complet. Chaque niveau se suffit. |
| P6 | **Ce qui réclame l'humain remonte, le reste reste à sa place** | Une bande « À traiter » épinglée regroupe questions, échecs, PID morts, limite. Rien d'autre ne saute la file. |
| P7 | **Fraîcheur toujours visible, jamais bruyante** | Pastille de connexion + âge du dernier snapshot ; les cartes vieillissent visuellement (grisées) au lieu de mentir. |
| P8 | **Une seule chose bouge à la fois** | Pas de tri automatique dans le fil ; le rail se réordonne avec un délai ; les rapports arrivent en un bloc. |

---

## 3. Architecture de l'information

```
Racine  #/                        ── le journal (fil chef) + rail des musiciens engagés
├─ #/m/<musicien>                 ── plongée : volet (desktop) / écran (mobile), fil conservé
├─ #/pupitre                      ── tous les musiciens, tableau de santé (existant, à intégrer)
├─ #/reglages                     ── projets, chef, provider, palette, version (admin, hors fil)
└─ #/telechargements              ── builds & docs (existant)
```

Objets manipulés par l'UI :

| Objet | Dérivé de | Identité |
|---|---|---|
| **Tour chef** | `system/init` … `result` du chef ; `wake` si précédé de `user_prompt{source:'wake'}` | index séquentiel dans le fil |
| **Mission** | `user_prompt` **sans source** du musicien, reçu par SSE pendant qu'un tour chef est ouvert *ou* dans les 60 s qui suivent sa clôture ; `callback:"chef"` confirme le pilotage | `(musicien, timestamp du user_prompt)` |
| **Résultat** | `notification/musician_*` dans le log chef, ou `result` du musicien | rattaché à la dernière mission ouverte du même musicien |
| **Rapport** | tour chef né d'un `wake` | porte la liste des missions qu'il couvre (« prend en compte ») |
| **Santé** | `/api/pupitre` | par musicien, horodatée par l'âge du snapshot |

Règle de rattachement (client, déterministe, rejouable au rechargement) : une carte-résultat cherche la mission ouverte la plus récente du même musicien ; s'il n'y en a pas (musicien lancé hors chef, par `@X` ou à la main), la carte est créée *orpheline* dans un groupe « Résultats hors mission » après le dernier tour — c'est le comportement v0.18 conservé comme repli.

---

## 4. Vues et maquettes — desktop

### 4.1 Vue racine : le journal

```
┌─────────────────────────────────────────────────────────────────────┬──────────────────────┐
│ ORCHESTRATEUR   ● connecté · snapshot 2 s        [Pupitre] [Réglages]│ EN SCÈNE (3)         │
├─────────────────────────────────────────────────────────────────────┤ ● vuBox      EN COURS│
│ À TRAITER (2)                                                        │   bash npm test · 3m │
│ ? DeskZen te demande « Quelle option de sync ? »           [Répondre]│ ⇄ DeskZen   ATTEND   │
│ ✗ RemotePad · PID mort depuis 4 min                     [Voir][Relancer]│   LE CHEF          │
├─────────────────────────────────────────────────────────────────────┤ ✕ RemotePad ERREUR   │
│                                                                      │   PID mort · 4m      │
│                           ┌────────────────────────────────────────┐ │──────────────────────│
│                           │ Lance les tests sur vuBox et vérifie   │ │ À TRAITER (2)  ▸     │
│                           │ le build RemotePad                     │ │ AUTRES (11)    ▸     │
│                           └────────────────────────────────────────┘ │ REMISE (15)    ▸     │
│ ┃♛ CHEF · 09:31                                                      │──────────────────────│
│ ┃ ▸ 3 outils · 1m40                                                  │ ♛ CHEF  ● répond     │
│ ┃ Je lance vuBox sur les tests et RemotePad sur le build, je te fais │   opus-4-8 · 1m40    │
│ ┃ le point dès les callbacks.                                        │                      │
│ ┃                                                                    │                      │
│ ┃ ┌ MISSIONS (2) ──────────────────────────────────────────────────┐ │                      │
│ ┃ │ ▮ VUBOX      ● en cours 3m12 · bash npm test        [Plonger ›]│ │                      │
│ ┃ │ ▮ REMOTEPAD  ✕ échec 0m48 · Build failed: gradle…   [Plonger ›]│ │                      │
│ ┃ └────────────────────────────────────────────────────────────────┘ │                      │
│                                                                      │                      │
│ ┃♛ CHEF · RAPPORT · 09:40 · prend en compte vuBox ✓ · RemotePad ✕    │                      │
│ ┃ vuBox : tests OK, 2 avertissements (…). RemotePad : gradle échoue  │                      │
│ ┃ sur … ; je propose de relancer avec … — tu valides ?               │                      │
├──────────────────────────────────────────────────────────────────────┤                      │
│ ▸ @ pour parler à un musicien · ⌘↩ envoyer                           │                      │
│ [ Écrire au chef…                                        ] [📎] [↩] │                      │
└──────────────────────────────────────────────────────────────────────┴──────────────────────┘
   v0.21.0
```

Lecture :

- **Colonne centrale = le fil**, seule zone qui défile. Bulles utilisateur à droite, chef à gauche avec liseré ambre `┃`. La réflexion du chef est repliée (`▸ 3 outils · 1m40`, existant).
- **Bloc MISSIONS dans le tour chef** (nouveau, P2). Créé dès qu'un `user_prompt` sans source arrive pour un musicien pendant le tour ; une ligne par mission. Chaque ligne évolue : `● en cours` → `✓ terminé` / `? question` / `⇄ attend le chef` / `✕ échec` / `⟲ clos par le système`. Clic = L1 (dépliage sur place). `[Plonger ›]` = L2.
- **Rapport** : tour chef marqué `RAPPORT` (liseré ambre **double**), avec « prend en compte » (existant, `takingHtml`). Les noms cités sont des puces cliquables vers L2.
- **Rail droit « EN SCÈNE »** (remplace la grille) : uniquement les musiciens **engagés** (mission ouverte ou résultat non lu depuis < 2 h) ; puis compteurs repliés `À TRAITER`, `AUTRES`, `REMISE` (parqués). Le chef en pied de rail, avec son état. Le rail ne se réordonne qu'après 1,5 s de stabilité. Clic sur un membre = L2.
- **Bande « À TRAITER »** épinglée sous la barre : questions à l'utilisateur, échecs, PID morts, limite Claude, « point en préparation » (réveil en attente). Disparaît quand vide.
- **Composeur** unique. `@X` route directement (existant). Bouton `↩` = répondre au dernier message cité (existant).

### 4.2 Niveau 1 : mission dépliée sur place

```
┃ ┌ MISSIONS (2) ────────────────────────────────────────────────────────┐
┃ │ ▾ VUBOX   ✓ terminé 3m12 · $0.42 · opus-4-8                          │
┃ │   Demande : « Lance npm test, corrige les avertissements bloquants » │
┃ │   Conclusion : Tests OK (42/42). 2 avertissements restants sur       │
┃ │   deprecations, non bloquants. Aucun fichier modifié.                │
┃ │   Note de mission 09:37 : « point intermédiaire : 3 tests …»         │  ← /api/notify (sourcé)
┃ │   [Plonger dans vuBox ›]   [Répondre @vuBox]   [Marquer lu]          │
┃ │ ▸ REMOTEPAD  ✕ échec 0m48 · Build failed: gradle…                    │
┃ └──────────────────────────────────────────────────────────────────────┘
```

Contenu L1 = ce que `notification/musician_done` porte déjà (`outcome`, `summary`, `duration_ms`, `cost_usd`, `awaitingChef`) + le texte de la demande (le `user_prompt` du musicien, déjà dans le SSE) + les notes sourcées `/api/notify`. Déplier envoie `mark-read`.

Cas particuliers en L1 :

- `? question` : la question en clair (`needsInput`), bouton **Répondre** qui préremplit `@X ` (existant `app.js:1895-1905`). La même carte est *aussi* listée dans « À traiter ».
- `⇄ attend le chef` : « a demandé au chef : … » puis, quand le relais (`maybeRelayChefAnswer`) a eu lieu, « décision du chef : … » sous la même carte. Le badge tombe au `system/init` suivant du musicien.
- `⟲ clos par le système` (`result.synthetic`) : cause (`error_interrupted` / `error_limited`), grisé, jamais rouge.

### 4.3 Niveau 2 : plongée dans un musicien (`#/m/vuBox`)

```
┌───────────────────────────────────┬──────────────────────────────────────────────────────────┐
│ (fil chef, atténué, non défilé)   │ ‹ Retour au journal        VUBOX   ● EN COURS      [⋯]   │
│                                   │ tour 3m12 · silence 4 s · PID 18412 ✓ · opus-4-8 · claude│
│  ┃♛ CHEF · 09:31                  │ ⚠ sans progrès 1m20 ← n'apparaît que si stalled          │
│  ┃ …                              ├──────────────────────────────────────────────────────────┤
│  ┃ ┌ MISSIONS (2) ──┐             │ MISSION EN COURS                                          │
│  ┃ │ ▮ VUBOX  ● …   │ ◀ surligné  │ « Lance npm test, corrige … »  attendu par le chef ⏳      │
│  ┃ │ ▮ REMOTEPAD ✕  │             ├──────────────────────────────────────────────────────────┤
│  ┃ └────────────────┘             │ FLUX                                     ⏬ suit le flux  │
│                                   │ 09:31:02 ▸ réflexion (repliée)                            │
│                                   │ 09:31:05 ⚙ Bash  npm test                                │
│                                   │          └ résultat (48 lignes) ▸                         │
│                                   │ 09:34:10 ⚙ Read  src/foo.test.ts                          │
│                                   │ 09:34:12 …texte en cours de frappe▌                       │
│                                   ├──────────────────────────────────────────────────────────┤
│                                   │ DERNIER RÉSULTAT (09:12, tour précédent) ✓ 2m01 ▸        │
│                                   ├──────────────────────────────────────────────────────────┤
│                                   │ [ Écrire directement à vuBox (hors chef)…        ] [↩]   │
└───────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

- **Volet à droite, ~55 % de largeur** ; le fil reste visible et atténué à gauche, sa position de défilement n'est pas touchée. `‹ Retour` ou `Échap` = `history.back()`. La mission concernée est surlignée dans le fil pour garder le lien.
- **En-tête** = la ligne `/api/pupitre` (état, tour, silence, PID, modèle, provider), poll 2,5 s (existant). Badges santé additifs.
- **Flux** = le renderer partagé `PupitreDetail` (existant, `public/pupitre-detail.js`) : backfill `/api/project/:name/events?n=200` puis SSE. Notices de transport rendues : `log_growth_skipped` ⇒ ligne « N Ko non reçus — contenu sur disque ».
- **Dernier résultat** épinglé en bas, replié : la conclusion du dernier tour même si le musicien a déjà redémarré.
- **Composeur direct** : dispatch `@vuBox` (le serveur écrit déjà une note `shortcut→vuBox` dans le log chef, `server.js:3433-3439`, donc le chef en a la trace). Libellé explicite « hors chef ».
- **Menu ⋯** : parquer, sessions à attacher, outils autorisés, provider, marquer lu, ouvrir `/pupitre`.

### 4.4 Vue « Pupitre » (`#/pupitre`) — inchangée dans l'esprit

Le tableau de santé existant (`/pupitre`) devient une route de l'app plutôt qu'une page à part : mêmes lignes `PupitreRow`, même tiroir. C'est la vue « tous les musiciens » ; elle n'est jamais la vue par défaut.

---

## 5. Vues et maquettes — Android

Même IA, trois écrans empilés (NavHost) au lieu d'un seul `setContent` :

```
Journal (#/)                     Mission (bottom sheet, L1)         Musicien (#/m/X, L2)
┌──────────────────────────┐    ┌──────────────────────────┐        ┌──────────────────────────┐
│ ♛ Orchestrateur  ● 2s  ⋮ │    │ ▮ VUBOX  ✓ 3m12 · $0.42   │        │ ‹  VUBOX  ● EN COURS     │
│ [●vuBox][⇄DeskZen][✕Rem…]│    │ Demande : « Lance … »     │        │ tour 3m12 · PID ✓ · opus │
│ ⚠ À traiter (2) ▸        │    │ Conclusion : Tests OK …   │        │──────────────────────────│
│──────────────────────────│    │ Note 09:37 : « … »        │        │ MISSION « Lance … » ⏳    │
│        ┌ Lance les tests ┐│    │                           │        │──────────────────────────│
│ ┃♛ 09:31 ▸ 3 outils      │    │ [Plonger ›] [Répondre @]  │        │ 09:31 ⚙ Bash npm test    │
│ ┃ Je lance vuBox et …    │    └──────────────────────────┘        │       └ résultat ▸       │
│ ┃ MISSIONS (2)           │                                         │ 09:34 ⚙ Read src/…       │
│ ┃  ▮ vuBox    ● 3m12     │  tap ligne → sheet                      │ 09:34 …frappe▌           │
│ ┃  ▮ RemotePad ✕ 0m48    │  tap « Plonger » → écran L2             │──────────────────────────│
│                          │  back → sheet fermée / journal          │ DERNIER RÉSULTAT ✓ ▸     │
│ ┃♛ RAPPORT 09:40         │  à la même position                     │──────────────────────────│
│ ┃ prend en compte …      │                                         │ [ @vuBox …          ] ↩ │
│──────────────────────────│                                         └──────────────────────────┘
│ [ Écrire au chef…   ] 📎↩│
└──────────────────────────┘
      v0.6.0 (footer)
```

Déclinaison :

- **Rail = chips horizontaux « en scène »** en haut du journal (les musiciens engagés seulement, couleur = état, chip stable : ne change de place qu'au passage en `input`/`error`, jamais sur `live→think`). Un chip « Tous (29) » ouvre une feuille listant la flotte complète (remplace la `TabBar` qui bouge sous le pouce).
- **« À traiter »** = une ligne repliée sous les chips ; tap = feuille listant questions/échecs/PID morts avec boutons.
- **Cartes de mission** inline dans le fil, identiques au web (une ligne L0). Tap = **bottom sheet** L1 (le fil reste derrière). « Plonger » = écran L2 poussé sur la pile ; retour système = retour au journal, `LazyListState` conservé.
- **L2** = `TelemetryStrip` existant en en-tête + `ProjectSession` existant pour le flux + bloc « dernier résultat » + composeur `@X`.
- **Santé** : Android poll déjà `/api/pupitre` 5 s (vc14) ; le bandeau `limitedUntil`/télémétrie périmée existe (`FleetScreen.kt:154-170`). À ajouter : `deadInFlight`/`stalled` en badge de chip, et l'âge du snapshot dans l'en-tête.
- **Version** : `/api/version` du serveur affichée en pied (règle standing), à côté du `versionName` déjà dans le header.
- **Résultat synthétique** ⇒ gris `⟲`, jamais rouge (alignement acquis P0-4 du 22/09 à conserver).

---

## 6. Parcours d'une demande

```
 1. UTILISATEUR écrit au chef                     fil : bulle droite ; rail : ♛ « répond »
 2. CHEF réfléchit, dispatche A et B (--callback) fil : ▸ réflexion repliée
    ├─ SSE A : user_prompt{callback:'chef'}       fil : bloc MISSIONS créé dans le tour, ligne A ● en cours
    └─ SSE B : idem                               rail : A, B entrent « en scène »
 3. CHEF termine son tour                         fil : bulle chef « je te fais le point dès les callbacks »
                                                  (bloc MISSIONS reste ouvert sous la bulle)
 4. A travaille                                   ligne A : activité (bash npm test · 2m10), badges santé
    · utilisateur curieux → [Plonger ›]           volet L2 sur A, fil intact ; ‹ Retour → même position
    · A envoie /api/notify en cours de route      ligne A : « note 09:37 » (L1), pas de bulle
 5. A termine → result + notification/done        ligne A : ✓ 3m12 · $0.42 · conclusion (L0) ; toast unique
    B échoue  → result + notification/failed      ligne B : ✕ 0m48 · raison ; entre dans « À traiter »
 6. Serveur : panier wake (10–90 s) → [CALLBACK_WAKE] bande : « ⏳ point en préparation (2) »
    (prompt wake masqué dans le fil)              rail : ♛ « fait le point »
 7. CHEF (réveillé) rend son rapport              fil : ┃┃ RAPPORT · prend en compte A ✓ · B ✕ ; puces → L2
                                                  bloc MISSIONS du tour 2 marqué « couvert par le rapport 09:40 »
 8. Si le chef pose une question                  bulle chef `question` + « À traiter »
    Si A avait posé une question à l'utilisateur  ligne A « ? » + « À traiter » + [Répondre] → @A
    Si A attend le chef (NEEDS_CHEF_INPUT)        ligne A « ⇄ attend le chef » → puis « décision : … »
 9. L'utilisateur répond au chef                  pendingWake annulé côté serveur (déjà) ; nouveau tour, nouveau bloc
```

Cas dégradés visibles à chaque étape : PID mort en 4 ⇒ badge `✗ PID mort` sur la ligne + « À traiter » ; Claude limité ⇒ bandeau `⚡ limité jusqu'à 10:00` + lignes concernées grisées ; SSE perdu ⇒ pastille `perdu`, cartes grisées, fil marqué « depuis 09:42 les événements peuvent manquer ».

---

## 7. Différenciation graphique

Palette PHOSPHOR/03 existante (`amber` par défaut, `matrix`, `ghost`, `crimson`), Chakra Petch pour l'UI, JetBrains Mono pour tout ce qui vient d'un musicien.

| Voix | Forme | Typo | Marqueur |
|---|---|---|---|
| **Utilisateur** | bulle pleine, droite | Chakra | — |
| **Chef** | bulle bordée, gauche, liseré ambre `┃` | Chakra | `♛` · `RAPPORT` = liseré double `┃┃` + en-tête « prend en compte » |
| **Musicien** | **ligne/carte mono** (jamais une bulle), liseré = couleur d'état | JetBrains Mono, nom en capitales | `●` en cours · `◐` réflexion · `✓` terminé · `?` question · `⇄` attend le chef · `✕` échec · `⟲` clos système · `○` idle |
| **Système** | bandeau fin plein-largeur (haut) ou badge inline | Chakra petite capitale | `⚡` limite · `⟲` reconnexion · `✗` PID mort · `⚠` sans progrès · `⏳` point en préparation |

États verrouillés → couleurs inchangées (`--st-live` vert, `think` cyan pâle, `unread` cyan, `input` orange, `error` magenta, `idle` gris). Enrichissements **additifs** :

| Clé réducteur | Libellé L0 | Badges possibles | Source |
|---|---|---|---|
| `live` / `think` | EN COURS / RÉFLÉCHIT | `⏱ 3m12` · `⚠ sans progrès` · `✗ PID mort` · `⏳ attendu par le chef` | `/api/pupitre` (`turnElapsedMs`, `stalled`, `deadInFlight`), `expectCallback` (P1 serveur) |
| `unread` | TERMINÉ | `✓ résumé` · `⇄ attend le chef` · `$0.42` | `notification`, `awaitingChef` |
| `input` | QUESTION | question 1 ligne · `[Répondre]` | `needsInput` |
| `error` | ÉCHEC | raison courte | `result.subtype` |
| `idle` | — | `⟲ interrompu` · `⚡ limité jusqu'à …` (10 min) | `result.synthetic`, `limitedUntil` |

Fraîcheur : chaque carte et le rail portent l'âge du dernier snapshot (`now − reçu`). > 15 s ⇒ texte grisé + `·` en pointillé ; > 60 s ou SSE perdu ⇒ pastille `perdu`, bandeau système. Aucune animation de halo quand la donnée est périmée.

---

## 8. Divulgation progressive — règles

| Niveau | Où | Quoi | Coût pour l'utilisateur |
|---|---|---|---|
| **L0** | ligne de mission, chip du rail, bande « À traiter » | icône d'issue, nom, durée, **une** ligne (activité ou conclusion ou question) | zéro clic |
| **L1** | dépliage sur place (web) / bottom sheet (mobile) | demande, conclusion complète (≤ 280 c. + « lire tout »), notes de mission, durée/coût/modèle, boutons | un clic, pas de navigation |
| **L2** | volet `#/m/X` (web) / écran (mobile) | en-tête santé, flux complet, dernier résultat, composeur direct | une navigation, retour garanti |

Anti-« trop d'un coup » :

- **Un bloc MISSIONS par tour chef**, jamais N cartes flottantes ; plusieurs fins dans la même minute ⇒ un seul toast « 2 missions terminées ».
- **Le rapport arrive en un bloc** : le `RAPPORT` n'est rendu qu'au `result` du chef (le streaming reste dans la réflexion repliée), avec ses puces déjà liées.
- **Rien ne se déplace dans le fil** ; seul le rail se réordonne, avec 1,5 s de délai.
- **Réflexion chef repliée** par défaut, compteur d'outils ; dépliée seulement à la demande.
- **Les bandeaux ne s'empilent pas** : un seul bandeau système, le plus grave (perdu > limité > reconnexion), les autres en compteur.
- **Les événements de transport** (`log_growth_skipped`, `oversized_line_skipped`) n'existent qu'en L2, comme une ligne grise dans le flux.

---

## 9. Contraintes et garde-fous

1. **États verrouillés** : aucune nouvelle chaîne, aucune modification de `Musician.transition`, `reduceMusician`, `scanProjectState`, `deriveState`, `Musician.kt`. Tout est disposition, badge, regroupement.
2. **Acquis 0.16.1** (chef figé) : `_awaitingConductorResponse` reste armé/désarmé comme aujourd'hui ; le bloc MISSIONS n'y touche pas.
3. **Acquis 0.17.0** : poll `/api/pupitre` 5 s / 2,5 s, cache serveur, skip des parqués, 2ᵉ ligne — réutilisés tels quels (la 2ᵉ ligne devient l'en-tête L2 et le sous-titre du chip).
4. **Acquis 0.18.0** : `_makeResultItem`/`_fileResult`/`_appendResultGroup` restent le moteur ; ils alimentent la *face finale* d'une ligne de mission quand elle existe, sinon le panier « hors mission » (repli identique à aujourd'hui). « prend en compte » inchangé.
5. **Acquis 0.19.0** : snapshot autoritaire ; la fraîcheur reste dérivée côté client de l'âge du snapshot.
6. **Acquis 0.20.0** : le `user_prompt{source:'wake'}` reste masqué ; le `RAPPORT` est déduit du `system/init` qui le suit — aucun changement serveur requis pour P0. Si le tour chef né d'un wake n'est pas identifiable au rechargement (le wake est sauté par `/api/conductor-chat`), le rapport se rend comme bulle chef ordinaire avec « prend en compte » — dégradation acceptable.
7. **Aucun nouvel endpoint obligatoire.** Additifs souhaitables (P1, tous champs facultatifs) : `expectCallback` par membre et `pendingWake`/`lastWakeAt` en racine de `/api/pupitre` (déjà P1 du design réveil) ; `wake:true` sur l'entrée `conductor` de `/api/conductor-chat` pour marquer le rapport au rechargement ; `/api/version` consommé par Android.
8. **Sécurité inchangée** : token gate, argv tableau, aucun dispatch implicite. Le composeur direct L2 passe par le raccourci `@X` existant.
9. **Pas de framework** (vanilla + xterm côté web ; Compose côté Android). Le routage `#/…` se fait avec `hashchange`, sans bibliothèque.

---

## 10. Priorités de changement vs UI actuelle

### P0 — le journal, les missions, la plongée

| # | Changement | Fichiers | Critère |
|---|---|---|---|
| P0-1 | **Bloc MISSIONS dans le tour chef** : créer une ligne au `user_prompt` sans source d'un musicien reçu pendant/juste après un tour chef ; mettre à jour au fil du SSE ; faire converger `_fileResult` vers cette ligne (repli : panier existant) | `public/app.js` (`onFleetEvent`, `_fileResult`, `_conductorBubbleHtml`), `styles.css` ; `MainPane.kt`, `FleetViewModel.kt` | dispatch A par le chef ⇒ ligne A dans le tour ; fin de A ⇒ même ligne passe ✓ ; rechargement ⇒ même rendu (résultats rattachés par musicien+ordre) |
| P0-2 | **Rail « en scène »** à la place de la grille : engagés + compteurs repliés + chef en pied ; tri différé 1,5 s | `index.html` (`#fleet-panel`), `app.js` (`computeLayout` → liste), `styles.css` | 29 projets ⇒ ≤ 6 lignes visibles par défaut ; parqués jamais visibles sans dépliage |
| P0-3 | **Plongée routée** `#/m/X` : volet latéral, fil intact, `Échap`/`‹` = `history.back()` ; réutilise `PupitreDetail` + `PupitreRow` ; composeur direct `@X` | `app.js` (remplace `#overlay-focused` modal par un volet), `index.html` | ouvrir/fermer 10× ⇒ la position du fil ne bouge pas ; lien `#/m/X` direct fonctionne |
| P0-4 | **Bande « À traiter »** : questions, échecs, PID morts, limite, point en préparation ; boutons Répondre/Voir | `app.js`, `styles.css` ; `FleetScreen.kt` | une erreur silencieuse apparaît dans la bande sans ouvrir de carte |
| P0-5 | **Rapport signé** : tour chef né d'un wake ⇒ en-tête `RAPPORT`, liseré double, puces cliquables | `app.js` (`onConductorEvent` : mémoriser le `wake` masqué jusqu'au `system/init`) ; `MainPane.kt` | réveil ⇒ la bulle suivante est marquée RAPPORT ; prompt utilisateur ⇒ bulle normale |
| P0-6 | **Android : navigation** (NavHost 3 destinations), chips « en scène » stables, bottom sheet L1, version serveur en pied | `MainActivity.kt`, `FleetScreen.kt`, `TabBar.kt`, `Api.kt` | back depuis L2 ⇒ journal à la même position ; `live→think` ne déplace aucun chip |

### P1 — santé et attente partout

- Badge `⏳ attendu par le chef` et bande « point en préparation (n) » quand `/api/pupitre` expose `expectCallback` / `pendingWake` (champ additif serveur).
- `wake:true` sur l'entrée `conductor` de `/api/conductor-chat` pour que le RAPPORT survive au rechargement.
- Notices de transport rendues en L2 ; fraîcheur > 15 s grisée sur chips et lignes.
- Android : badges `deadInFlight`/`stalled` sur chips, bouton « Répondre @X » sur les questions.

### P2 — hygiène

- Supprimer la grille absolue, `computeDesktopArc`, la main de cartes masquée et `wireFanSwipe` (`app.js:581-738`, `:1375-1420`), `renderFocusedBody` et ses sélecteurs orphelins (`:2940-3039`).
- Fusionner `attentionRank` (`app.js:514`) et `PupitreRow.rank` en une seule fonction partagée.
- Découper `app.js` en modules ES (`thread.js`, `missions.js`, `rail.js`, `dive.js`) sans bundler ; persister les tweaks (`localStorage`).
- Intégrer `/pupitre` comme route `#/pupitre` plutôt que page séparée.

### Écarté

- Une vue « grille de toute la flotte » au premier niveau : elle contredit le pilier 2 (musiciens = exécutants) et ne passe pas à 29 projets.
- Des bulles pour les musiciens dans le fil : ils rendent compte, ils ne dialoguent pas.
- Un onglet par musicien sur mobile : un musicien est une plongée, pas un interlocuteur.
- Toute nouvelle chaîne d'état (`waiting_chef`, `stalled`, `report`) : badges et regroupements suffisent, cinq réducteurs restent intacts.

*Rapport non committé — le chef décide. Aucun autre fichier touché.*
