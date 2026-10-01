# Redéfinition des événements & enchaînements (web + app) — Anthropic Fable — 2026-09-22

Document de design, lecture seule sur le code (v0.17.0). Aucun code modifié, serveur 7777 non redémarré. Numéros de ligne vérifiés dans l'arbre de travail au moment de l'écriture.

**Vocabulaire d'états verrouillé** : `idle | live | think | input | error | unread` (clés partagées par `scanProjectState`, `reduceMusician`, `deriveState`, `Musician.transition` web et `Musician.kt` Android). Tout ce qui suit est **additif** — badges, regroupements, libellés, timeline, champs de snapshot — sauf mention explicite « noyau ». Les acquis v0.16.1 (chef figé) et v0.17.0 (tri d'attention, 2ᵉ ligne, fraîcheur, cache pupitre) sont conservés tels quels.

---

## 1. Le problème, reformulé

L'utilisateur dit : « les callbacks sont peut-être délivrés, mais pas forcément au bon moment ». Après lecture, le diagnostic est plus précis : **les callbacks arrivent au bon moment pour la machine et au mauvais moment pour l'humain**, parce qu'un seul canal — le transcript du chef — mélange trois voix qui n'ont pas le même rythme :

| Voix | Rythme réel | Ce que l'utilisateur attend |
|---|---|---|
| **Musicien** | termine quand il termine (secondes à heures), à n'importe quel moment | « X a fini, voilà l'essentiel » — sans interrompre ce qu'il lit |
| **Chef** | ne parle que quand on lui parle (aucun tour n'est déclenché par un callback depuis v0.14.3) | une synthèse qui *suit* la fin des musiciens concernés |
| **Système** | à l'instant où ça casse (déconnexion, PID mort, limite) | un signal discret mais impossible à rater |

Aujourd'hui le transcript chef est une pile plate où ces trois voix s'intercalent dans l'ordre d'écriture du fichier `logs/chef.jsonl`, sans notion de tour ni de lien. Le résultat : un « [vuBox] Tour terminé… » tombe au milieu d'une réflexion du chef, la synthèse du chef arrive une heure plus tard quand l'utilisateur relance, et rien n'indique que les deux parlent de la même chose.

---

## 2. Cartographie actuelle — Web

### 2.1 Événements produits, par source

| Événement | Produit par | Écrit où | Diffusé par | Rendu où |
|---|---|---|---|---|
| `user_prompt` (sans source) | `dispatch.mjs:628-631` | `logs/<p>.jsonl` | SSE agrégé (`server.js:2110+`) | Chef : bulle utilisateur (`app.js:1906`) ; carte : `live` |
| `user_prompt` **avec `source`** | `dispatch.mjs:630` (`--source`), `/api/notify` (`server.js:2745-2769`), raccourci `@` (`server.js:3075-3081`) | log du projet cible | SSE | Bulle *callback* si source ≠ shortcut, bulle *user* si shortcut (v0.17.0). N'arme plus rien (v0.16.1). |
| `system/init` | claude CLI | log projet | SSE | Début de tour réel : carte `live`, pastille « le chef répond » (`app.js:1984`) |
| `stream_event` (deltas) | claude CLI | log projet | SSE | Détail live token par token (`pupitre-detail.js:190`) ; heartbeat de carte (`app.js:160`) |
| `assistant` (thinking / tool_use / text) | claude CLI | log projet | SSE | Chef : bulle *réflexion* accumulée (`app.js:1913-1933`) ; carte : `live`/`think` ; détail : rendu si aucun delta (v0.17.0) |
| `user` (tool_result) | claude CLI | log projet | SSE | Ligne condensée dans la réflexion (`app.js:1934-1946`) |
| `result` ok / `NEEDS_USER_INPUT` / erreur / **synthétique** | claude CLI ; `healOrphanedLogs` (`server.js:483-494`) ; garde no-failover (`dispatch.mjs` ×2) | log projet | SSE | Carte `unread`/`input`/`error`/`idle` ; chef : bulle *conductor* + désarmement |
| `notification/musician_done` | `autoNotifyConductor` (`server.js:2716-2731`) sur transition → `unread` (`:3716-3718`) | **log du chef** | SSE | Bulle *callback* + toast (`app.js:1865-1877`) ; dans l'historique (`server.js:2094`) |
| `rate_limit_event` | claude CLI | log projet | SSE | **Aucun reducer ne le lit** (vérifié : 0 occurrence dans server.js / app.js / core) |
| `system/limited-no-failover` | garde no-failover | log projet | SSE | Ignoré par les reducers ; visible seulement dans le détail brut |
| Stall / PID mort / silence | `scanProject` (`fleet-status-core.mjs:189-206`) | calculé | `/api/pupitre` (poll 5 s visible, cache 2,5 s) | 2ᵉ ligne de carte, `pid-dead`, ligne pupitre |
| Fraîcheur / connexion | client | mémoire | — | Pastille `#conn-status` (v0.17.0) |

### 2.2 Les deux pompes qui lisent le même fichier

Le log d'un musicien est lu par **deux** tailers indépendants du serveur :

1. **Pompe SSE agrégée** (`server.js:2130+`) — diffuse aux clients, et détecte `NEEDS_CHEF_INPUT` → `maybeDispatchChefQuestion` (`:2273-2274`) / relais de réponse chef (`:2276`).
2. **Watcher de notifications** (`server.js:3687+`) — `reduceMusician`, puis `autoNotifyConductor` sur `unread` (`:3716`) et `drainQueue` sur `result` non synthétique (`:3725`).

Elles ne sont pas ordonnées entre elles. Conséquence directe (§3.4).

### 2.3 Rendu chef : quatre rôles de bulle

`user` · `callback` · `reflection` (details repliable, live/closed) · `conductor` (`app.js:1677-1712`). Le rôle `reflection` est **client seulement** : `/api/conductor-chat` (`server.js:2039-2099`) ne renvoie que `user`, `conductor`, `callback` — un rechargement perd toute l'activité intermédiaire du chef, et l'ordre est reconstruit par estampillage (`:2062-2068`) parce que les événements CLI n'ont pas de timestamp.

---

## 3. Problèmes de timing et d'enchaînement — preuves

### 3.1 Le callback humain et la synthèse chef sont découplés (le vrai « mauvais moment »)

`autoNotifyConductor` écrit la notification **à l'instant du `result`** du musicien (`server.js:3716`), et **ne lance rien** (`:2733-2742`, fix v0.14.3, correct). Le chef ne synthétise donc que lors du **prochain tour déclenché par l'utilisateur**. Entre les deux : minutes ou heures (séquences relevées par Astra : 36 à 58 min). L'utilisateur voit une ligne grise « [X] Tour terminé. <600 premiers caractères du résultat> » — un extrait brut, pas une synthèse — puis, bien plus tard, un chef qui en reparle sans lien visuel. **C'est un problème de conception, pas un bug** : il manque un événement « synthèse liée à ces callbacks ».

### 3.2 Le callback s'intercale dans la réflexion du chef

Le handler `result` cherche la réflexion ouverte **à reculons** parce que « a musician callback may have been pushed after it » (`app.js:2021-2033`). Autrement dit, le code sait qu'un callback peut tomber *au milieu* d'un tour du chef, et le tolère au lieu de le placer. Visuellement : réflexion → callback gris → suite de la réflexion → réponse du chef. L'utilisateur lit un dialogue à trois sans savoir qui répond à quoi.

### 3.3 Le texte du callback est un extrait, pas un résumé

`lastLine` = `ev.result.slice(0, 600)` (`server.js:2129`) ; `autoNotifyConductor` l'accole à « Tour terminé. » (`:2723`). Un musicien qui termine par un rapport markdown de 40 lignes produit un callback tronqué au milieu d'une phrase. Le toast en montre 110 caractères (`app.js:2055`). Ni l'issue (succès / question / erreur), ni la durée, ni le coût ne sont dans le callback — ils sont dans le `result` du musicien, jamais remontés au chef.

### 3.4 Course entre les deux pompes sur `NEEDS_CHEF_INPUT`

Quand un musicien termine par `NEEDS_CHEF_INPUT`, la pompe SSE dispatche le chef (`:2274`) **et** le watcher écrit une notification « Tour terminé » dans le log du chef (`:3716`) — deux écritures dans `chef.jsonl` depuis deux tailers non ordonnés. Selon l'ordre, l'utilisateur voit soit « [X] Tour terminé. NEEDS_CHEF_INPUT: … » puis le chef qui répond, soit l'inverse. Et la carte du musicien passe `input` (`reduceMusician:2124` ne distingue pas `NEEDS_CHEF_INPUT` de `NEEDS_USER_INPUT` — seule la regex `NEEDS_USER_INPUT` est testée, donc un `NEEDS_CHEF_INPUT` finit en `unread`, pas en `input` : la carte dit « terminé » alors que le musicien attend le chef).

### 3.5 Question à l'utilisateur : deux surfaces, aucun lien

Un `NEEDS_USER_INPUT` d'un musicien met sa carte en `input` (`server.js:2125`) mais **n'écrit rien dans le transcript chef** — l'utilisateur doit remarquer la carte orange. À l'inverse, un `NEEDS_USER_INPUT` du chef supprime la bulle conductor de l'historique (`server.js:2089-2093` : `if (!needs)`) — la question du chef disparaît au rechargement.

### 3.6 Événements avalés

- `rate_limit_event` et `system/limited-no-failover` : ignorés par tous les reducers ; la limite 5 h n'est visible nulle part côté cartes (le champ `limitedUntil` de `/api/pupitre` existe depuis v0.17.0 mais n'est **pas encore consommé** par le client).
- Le `result` synthétique `error_limited` → `idle` (`server.js:2127`) : correct pour libérer la file, mais la **cause** (« limité jusqu'à… ») est perdue pour l'utilisateur.
- L'activité intermédiaire du chef (`reflection`) n'existe pas dans l'historique (§2.3) : un rechargement montre un chef qui « a répondu d'un coup ».

### 3.7 « Trop d'un coup » — où ça se produit

- Au `result` du chef, la réflexion se ferme et la bulle finale apparaît **en même temps** que la ré-ouverture de toutes les cartes touchées (`markDirty` par carte) : tout bouge à la fois.
- Un callback = bulle + toast + tri de carte + badge, simultanés.
- Sur un gros append (>4 Mio), la pompe SSE saute à EOF avec une notice `log_growth_skipped` que **le client ne rend pas** (0 occurrence dans `public/`) : ici c'est *rien* d'un coup.

---

## 4. Cartographie actuelle — Android

### 4.1 Consommation

- Un seul SSE, single-flight, reconnexion exponentielle (`FleetViewModel.kt:155-228`). À l'ouverture : `syncFromConfig()` + historique chef, **pas de snapshot pupitre** — l'app ne lit jamais `/api/pupitre` (0 occurrence de « pupitre » dans `android/`), donc **aucune notion de stall, PID mort ou fraîcheur** côté mobile.
- Reducer `Musician.kt:92-209` : `system/init` → `live`, `assistant` → `live`/`think`, `result` → `error`/`input`/`unread`/`idle`. **N'interprète ni `user_prompt`, ni `notification`, ni `rate_limit_event`, ni `synthetic`** (grep : 0 occurrence). Deux conséquences :
  - un callback n'arme jamais rien (Android était déjà sain là où le web a eu besoin de v0.16.1) ;
  - un `result` synthétique `error_limited` ou `error_interrupted` est rendu **ERREUR rouge** sur Android alors que web et serveur le réduisent en `idle` — **divergence de plateforme**.
- Transcript chef : rôles `user` / `callback` / `activity` (thinking, tool, text, result) / `conductor` (`FleetViewModel.kt:230-300`). Les étapes intermédiaires sont **persistantes** (`Role.activity`, vc11) — plus riche que le web, mais donc encore plus « tout d'un coup » : chaque outil du chef devient une ligne dans le fil principal.
- « le chef répond… » = chef `live/think` **et** dernier message `user` ou `callback` (`MainPane.kt:117-119`) : dérive de l'état, pas d'un drapeau — pas de figeage possible, mais un callback reçu pendant un vrai tour affiche « répond » à juste titre.
- Barre d'onglets : sélection épinglée à gauche, puis live/think, input/error, unread, idle (`TabBar.kt:34-40`) ; le musicien change de place **à chaque changement d'état** (`FleetViewModel.kt:181-184` remonte en tête de liste).

### 4.2 Problèmes propres au mobile

1. Pas de santé (stall / PID) ni de fraîcheur : un musicien planté reste « EN COURS » indéfiniment.
2. Synthétique = erreur rouge (divergence).
3. Le fil chef mélange activités intermédiaires et messages finaux à plat, sur un écran de 6 pouces.
4. `TabBar` bouge à chaque transition — sur mobile, l'onglet sous le pouce se déplace.

---

## 5. Modèle d'événements redéfini

Principe : **on ne change pas les événements bruts du CLI ni les chaînes d'état ; on définit une couche « événements de coordination » par-dessus, et un ordre de présentation.** Tout est dérivable des lignes JSONL existantes.

### 5.1 Typologie (trois voix × cinq types)

| Voix | Type | Dérivé de | Sens pour l'utilisateur |
|---|---|---|---|
| **Musicien** | `turn.start` | `system/init` | « X démarre : <prompt court> » |
| | `turn.progress` | `assistant` tool_use / thinking / deltas | activité courante (jamais dans le fil chef, seulement carte + détail) |
| | `turn.question` | `result` + `NEEDS_USER_INPUT` | « X a besoin de toi » — **prioritaire** |
| | `turn.ask_chef` | `result` + `NEEDS_CHEF_INPUT` | « X attend une décision du chef » |
| | `turn.done` | `result` ok | « X a terminé (durée, coût) — résumé » |
| | `turn.failed` | `result` erreur non synthétique | « X a échoué : raison » |
| | `turn.closed` | `result` **synthétique** (`error_interrupted`, `error_limited`) | « tour clos par le système : cause » — **jamais rendu comme un échec du musicien** |
| **Chef** | `chef.turn` | `system/init` du chef | ouvre un **groupe** dans le fil |
| | `chef.working` | `assistant` du chef | réflexion repliée dans le groupe |
| | `chef.reply` | `result` du chef sans `NEEDS_USER_INPUT` | bulle finale du groupe |
| | `chef.question` | `result` du chef avec `NEEDS_USER_INPUT` | bulle **question**, conservée dans l'historique |
| | `chef.decision` | `result` du chef relayé (`[ANSWER]`) | bulle liée à un `turn.ask_chef` |
| **Système** | `sys.link` | `notification/musician_done` (existant) | **rattache** un `turn.done` au fil chef — ne parle pas, pointe |
| | `sys.limited` | `rate_limit_event` bloquant, `limited-no-failover`, `limitedUntil` | bandeau global « Claude limité jusqu'à … » |
| | `sys.health` | `/api/pupitre` : `stalled`, `deadInFlight`, `pidAlive` | badge de carte, jamais une bulle |
| | `sys.transport` | SSE open/error, `log_growth_skipped`, poll échoué | pastille de connexion + ligne « N événements non reçus — ouvrir le détail » |

### 5.2 Enchaînements : qui parle quand

```
Utilisateur ──prompt──▶ CHEF
                        ├─ chef.turn (groupe ouvert)
                        ├─ chef.working ×n   (replié, compteur « 3 outils »)
                        ├─ dispatch → MUSICIEN A, B   (ligne système « → A, B » dans le groupe)
                        └─ chef.reply         (groupe fermé)

MUSICIEN A (asynchrone) ─ turn.start → turn.progress ×n → turn.done
                                                          │
                                                          ▼
                    Fil chef : sys.link « A ✓ 3m12 · résumé » ─ PAS une bulle de dialogue,
                    une CARTE DE RÉSULTAT compacte, groupée sous « Résultats reçus (2) »
                    tant que le chef n'a pas parlé. Aucune synthèse n'est attendue ici.

Utilisateur ──prompt suivant──▶ CHEF
                        ├─ chef.turn
                        │    └─ en-tête du groupe : « prend en compte : A ✓, B ✓ »
                        │       (les sys.link non consommés sont RATTACHÉS au groupe, pas laissés flotter)
                        └─ chef.reply
```

Règles d'ordre (présentation, pas fichier) :

1. **Un `sys.link` ne s'insère jamais dans un groupe chef ouvert.** S'il arrive pendant `chef.turn`, il est mis en attente et affiché *après* `chef.reply`, dans le panier « Résultats reçus ». (Corrige §3.2.)
2. **Les `sys.link` en attente sont consommés par le prochain `chef.turn`** et listés dans son en-tête. (Rend visible le lien §3.1 sans lancer de tour.)
3. **`turn.question` saute la file** : il crée une bulle « X te demande » dans le fil chef *et* met la carte en `input`. Une réponse depuis le fil dispatche au musicien nommé (le routage `@` existe déjà). (Corrige §3.5.)
4. **`turn.ask_chef`** : la carte passe en **badge « attend le chef »** (état reste `unread` — badge additif, pas de nouvelle chaîne), le fil chef montre « A demande au chef → décision » comme un seul groupe lié. (Corrige §3.4 sans toucher au relais.)
5. **`turn.closed`** (synthétique) : carte `idle` + badge cause (« limité jusqu'à 10:00 », « interrompu au redémarrage ») pendant 10 min ou jusqu'au prochain `turn.start`. Jamais rouge. (Corrige §3.6 et la divergence Android.)
6. **`sys.limited`** : bandeau unique en haut ; les cartes concernées reçoivent le badge ; la file `@` affiche « en pause : limite ». Aucune bulle.

---

## 6. Divulgation progressive — quoi montrer, quand

Trois niveaux, identiques web et mobile :

| Niveau | Web | Mobile | Contenu |
|---|---|---|---|
| **0 — coup d'œil** (toujours visible) | 2ᵉ ligne de carte + badges ; bandeau attention en haut du fil chef | pilule d'onglet + 1 ligne sous la barre | état, issue, **une** ligne : question / résumé / cause / activité |
| **1 — résumé** (un clic / tap) | carte de résultat dans le fil chef (dépliée) ; groupe chef déplié | feuille en bas (bottom sheet) | résumé 3–5 lignes, durée, coût, outils comptés, boutons Répondre / Ouvrir |
| **2 — détail** (à la demande) | overlay pupitre-detail existant | écran session existant | timeline complète, deltas, tool_result |

Règles anti « trop d'un coup » :

- **Panier plutôt que pile** : plusieurs `turn.done` rapprochés → une seule ligne « 3 résultats reçus ▸ » qui se déplie ; un seul toast « 3 musiciens ont terminé ».
- **Réflexion du chef repliée par défaut** avec compteur (« 4 outils · 2 min ») ; dépliée seulement si l'utilisateur l'ouvre ou si le tour dure > 60 s sans réponse (alors on montre la *dernière* action seulement).
- **Résumé du callback** : au lieu de `slice(0,600)`, prendre le **dernier paragraphe** du `result` (les musiciens terminent par leur conclusion) limité à 280 caractères, précédé de l'issue et de la durée. Le texte complet reste au niveau 1.
- **Une seule chose bouge à la fois** : le tri des cartes est différé de 1,5 s après un `sys.link` (le temps que l'utilisateur voie le badge apparaître là où il regardait).
- **Aucun événement système en bulle** : bandeaux et badges uniquement.

---

## 7. Différenciation graphique

### 7.1 Langage visuel (palette PHOSPHOR existante, rien de nouveau à charger)

| Voix | Forme | Couleur | Marqueur |
|---|---|---|---|
| **Utilisateur** | bulle pleine, alignée à droite | `--fg-0` sur fond léger | — |
| **Chef** | bulle bordée, gauche, **liseré ambre** `--accent` à gauche | ambre | icône ♛, en-tête de groupe |
| **Musicien** | **carte de résultat** rectangulaire (pas une bulle), gauche, liseré de la couleur de **son état** | vert `--st-live` / cyan `--st-unread` / orange `--st-input` / magenta `--st-error` | nom en capitale mono + ✓ ? ✕ ⏸ |
| **Système** | bandeau plein-largeur fin, ou badge | gris `--fg-2` ; orange si action requise ; magenta si perte | ⚡ (limite) · ⟲ (reconnexion) · ⚠ (PID mort) |

Distinction voulue : **le musicien n'a pas de bulle de dialogue** — il ne « parle » pas à l'utilisateur, il *rend compte*. Sa carte de résultat ressemble à la 2ᵉ ligne de sa carte de pupitre : même typo mono, mêmes couleurs d'état. Le chef et l'utilisateur, eux, dialoguent en bulles.

### 7.2 Badges additifs sur l'état verrouillé

| Clé (inchangée) | Badge possible (additif) | Déclencheur |
|---|---|---|
| `live` / `think` | ⏱ tour 8m14 · ⚠ sans progrès · ✗ PID mort | `/api/pupitre` |
| `unread` | ✓ résumé · **attend le chef** · 2 résultats | `NEEDS_CHEF_INPUT`, `unreadCount` |
| `input` | ? question (1 ligne) · Répondre | `NEEDS_USER_INPUT` |
| `error` | ✕ raison courte | `result.subtype` |
| `idle` | ⚡ limité jusqu'à 10:00 · ⟲ interrompu | `result.synthetic` + subtype, `limitedUntil` |

### 7.3 Maquette — fil chef (web)

```
┌ ATTENTION ───────────────────────────────────────────────────────┐
│ ? DeskZen te demande : « Quelle option de sync ? »   [Répondre]  │
│ ⚡ Claude limité jusqu'à 10:00 · file @ en pause (2)             │
└──────────────────────────────────────────────────────────────────┘

                                     ┌────────────────────────────┐
                                     │ Lance les tests sur vuBox  │  ◀ utilisateur
                                     └────────────────────────────┘
┃♛ CHEF · 09:31 · prend en compte : BookHaven ✓
┃ ▸ 3 outils · 1m40                                    (replié)
┃ Je dispatche vuBox pour les tests et je te reviens.
┃ → vuBox

  ┌ RÉSULTATS REÇUS (2) ─────────────────────────────────────────┐
  │ ▮ VUBOX      ✓ 3m12 · $0.42   Tests OK, 2 avertissements…    │  ◀ liseré cyan
  │ ▮ REMOTEPAD  ✕ 0m48           Build failed: gradle…    [Voir]│  ◀ liseré magenta
  └──────────────────────────────────────────────────────────────┘

                                     ┌────────────────────────────┐
                                     │ Et RemotePad ?             │
                                     └────────────────────────────┘
┃♛ CHEF · 09:40 · prend en compte : vuBox ✓, RemotePad ✕
┃ RemotePad a échoué sur gradle ; je relance avec …
```

### 7.4 Maquette — carte musicien (web, niveau 0)

```
┌──────────────────────────────┐
│ ● vuBox            EN COURS  │   ← clé d'état + libellé FR (v0.17.0)
│ ⚙ Bash npm test              │   ← activité
│ PID ✓ · tour 3m12 · opus-4-8 │   ← 2ᵉ ligne (v0.17.0)
│ ⚠ sans progrès 1m20          │   ← badge santé (additif)
└──────────────────────────────┘
```

### 7.5 Maquette — mobile

```
[♛ Chef] [● vuBox] [? DeskZen] [✓ RemotePad] [○ …]      ← pilules, couleur = état
 ⚠ Claude limité jusqu'à 10:00                          ← bandeau système, fin
──────────────────────────────────────────────────────
                          ┌ Lance les tests sur vuBox ┐
┃♛ CHEF 09:31 · ▸ 3 outils
┃ Je dispatche vuBox…
 ▮ RÉSULTATS (2) ▸                                       ← ligne unique, tap = feuille
                          ┌ Et RemotePad ? ┐
┃♛ CHEF 09:40 · prend en compte vuBox ✓ RemotePad ✕
┃ RemotePad a échoué…
```

Feuille « Résultats » (niveau 1) : une rangée par musicien, liseré couleur d'état, résumé 3 lignes, boutons **Ouvrir** (niveau 2) / **Répondre** (si `input`).

---

## 8. Plan priorisé pour Opus 4.8

Tout est additif sauf marqué **[noyau]**. Client = hard-reload ; serveur = un redémarrage groupé par le chef.

### P0 — le bon moment, sans nouvelle donnée

| # | Lot | Fichiers | Additif ? | Critère de vérif |
|---|---|---|---|---|
| P0-1 | **Panier de résultats** : les `callback` ne s'insèrent plus dans une réflexion ouverte ; ils vont dans un groupe « Résultats reçus (n) » rendu après le `chef.reply` ; le prochain `chef.turn` affiche « prend en compte : … » | `public/app.js` (`onConductorEvent`, `_conductorBubbleHtml`, `renderMainPane`), `public/styles.css` | additif | callback pendant tour chef → apparaît après la bulle finale ; 3 callbacks en 10 s → une ligne repliée ; historique rechargé → même ordre |
| P0-2 | **Carte de résultat** à la place de la bulle callback : issue + durée + coût + résumé « dernier paragraphe » | `server.js` `autoNotifyConductor` (enrichir la `notification` avec `outcome`, `duration_ms`, `cost`, `summary` — champs additifs), `public/app.js`, `MainPane.kt` | additif | notification contient les 4 champs ; anciens callbacks sans champs rendus comme avant |
| P0-3 | **Question musicien dans le fil chef** : `turn.question` crée une bulle « X te demande » + bouton Répondre (route `@X` existante) | `server.js` (écrire une `notification/musician_question` sur transition → `input`), `app.js`, `FleetViewModel.kt` | additif | carte `input` ⇒ bulle visible dans le fil ; réponse ⇒ dispatch vers X |
| P0-4 | **Synthétique ≠ échec** sur Android : `result.synthetic` → `idle` + badge cause | `Musician.kt:147-168` | **[noyau Android, alignement sur web]** | `error_limited` ⇒ pilule grise + « limité », pas rouge |
| P0-5 | **Question du chef conservée** dans l'historique (`NEEDS_USER_INPUT` du chef ⇒ bulle question, pas suppression) | `server.js:2088-2093`, `app.js` | additif | rechargement conserve la question |

### P1 — santé et limite visibles partout

| # | Lot | Fichiers | Additif ? | Critère |
|---|---|---|---|---|
| P1-1 | Bandeau **Attention** en tête du fil chef (questions, échecs, PID morts, limite) — même définition que le briefing v0.17.0 | `app.js`, `styles.css` | additif | une erreur silencieuse apparaît dans le bandeau sans ouvrir de carte |
| P1-2 | Consommer `limitedUntil` / `noFailover` / `queueDepth` (déjà servis) : bandeau ⚡ + badge carte + « file en pause » | `app.js`, `pupitre-row.js` | additif | sentinelle + flag ⇒ bandeau ; expiration ⇒ disparition |
| P1-3 | **Badge « attend le chef »** : distinguer `NEEDS_CHEF_INPUT` de `NEEDS_USER_INPUT` dans les reducers → `unread` + `awaitingChef: true` | `server.js:2124`, `fleet-status-core.mjs:103`, `app.js`, `Musician.kt` | additif (nouveau champ, clé inchangée) | carte montre « attend le chef » ; décision ⇒ badge retiré |
| P1-4 | **Android : snapshot `/api/pupitre`** toutes les 10 s au premier plan → stall / PID / fraîcheur sur les pilules | nouveau fetch dans `FleetViewModel.kt`, `TabBar.kt` | additif | musicien tué ⇒ pilule ⚠ en ≤ 15 s |
| P1-5 | **Rendu des notices de transport** : `log_growth_skipped` ⇒ ligne « N Ko non reçus — ouvrir le détail » ; poll échoué déjà couvert | `app.js`, `pupitre-detail.js` | additif | burst simulé ⇒ ligne visible, pas de trou silencieux |
| P1-6 | **Tri différé** (1,5 s après un lien) web ; **onglet mobile stable** (ne remonter en tête qu'au passage en `input`/`error`, pas à chaque transition) | `app.js` `reorderSoon`, `FleetViewModel.kt:181-184` | additif | l'onglet sous le doigt ne bouge pas pendant un `live→think` |

### P2 — cohérence de plateforme

Historique chef enrichi (`/api/conductor-chat` renvoie les activités repliées avec un compteur, sans les deltas) ; réflexion chef repliée par défaut sur mobile (aujourd'hui à plat, `MainPane.kt:183-202`) ; toasts agrégés.

### Écarté

Nouvelle chaîne d'état (`done`, `limited`, `waiting_chef`) — casserait cinq reducers et l'app ; tout est couvert par badges + champs additifs. Identifiants de tour persistants et re-tri des logs — le fil est reconstruit à la présentation, le fichier reste la vérité. Déclencher un tour chef sur callback — exactement ce que v0.14.3 a retiré ; le lien « prend en compte » donne la continuité sans coût ni faux tour.

---

## 9. Garde-fous

- **v0.16.1** : `_awaitingConductorResponse` reste armé uniquement par un prompt sans source ou `system/init`, désarmé par `result` ou le filet PID. Le panier P0-1 ne touche pas ce drapeau ; il change seulement *où* la bulle callback est rangée.
- **v0.17.0** : tri d'attention, 2ᵉ ligne, pastille, cache pupitre, skip parked, pas de drain sur synthétique — inchangés. P1-6 ajoute un délai au tri, il ne le remplace pas.
- **Vocabulaire** : aucune proposition ne modifie une chaîne `data-state` ni un `State` Kotlin. P0-4 modifie *la valeur choisie* par le reducer Android pour un cas (synthétique → `idle` au lieu de `error`), pour l'aligner sur les trois reducers serveur — c'est le seul point marqué noyau, et il réduit une divergence au lieu d'en créer une.
- **Fichier** : aucun réordonnancement de `logs/*.jsonl`, aucun événement CLI réécrit ; les nouveaux champs vivent sur des événements que le serveur écrit déjà lui-même (`notification`).
- **Android/web** : mêmes noms de types (§5.1), mêmes couleurs d'état, même règle « musicien = carte, chef = bulle, système = bandeau ».

*Rapport non committé — le chef décide. Aucun autre fichier touché.*
