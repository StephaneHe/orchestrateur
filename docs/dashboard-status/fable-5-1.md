# Vue « Projets » — le statut de chaque projet en un coup d'œil

Proposition de conception indépendante (Fable 5.1), 2026-09-28.
Demande utilisateur, verbatim : « Orchestrateur, web interface : je veux voir en
un coup d'œil le statut de chacun des projets. »

Aucun code dans ce document. Il décrit ce qui existe, ce qui manque, la vue
proposée, les données à ajouter côté serveur et l'effort.

---

## 1. Ce que l'utilisateur voit aujourd'hui

La flotte compte 32 projets dans `config.json` : 1 chef, 19 musiciens actifs,
12 parqués (`parked: true`). Quatre surfaces montrent un état, aucune ne montre
tous les projets d'un coup avec ce qui compte.

| Surface | Ce qu'elle montre | Ce qui manque pour « un coup d'œil » |
|---|---|---|
| **Rail PILOTAGE** (`salle.js`, `renderRail`) | « En cours » et « À examiner » dépliés ; « Tous les musiciens » et « Mis de côté » **repliés par défaut**. Une ligne par musicien : glyphe, libellé, sous-ligne (activité, question, âge). | Les projets au repos et les parqués sont invisibles sans clic. Rail étroit : la sous-ligne est tronquée à 48 caractères. Ni version, ni coût, ni file, ni model. |
| **Bande d'attention** (`renderAttention`) | Une ligne repliée : compteurs (questions, processus perdus, échecs, sans progrès) + l'élément le plus grave. | Ne montre que les anomalies, par construction. |
| **`/pupitre`** (page servie par `pupitrePageHtml`) | Tableau de santé : état, activité, tour, silence, PID, provider·model. Tri par gravité. | Page séparée, style différent de la salle, orienté diagnostic. Les parqués apparaissent tous « PRÊT » car `/api/pupitre` ne les scanne pas (`state: 'idle'` forcé). Ni file, ni question acquittée, ni version, ni coût, ni dernière activité datée. Pas de regroupement. |
| **Briefing** (overlay, `openBriefing`) | Une ligne par musicien : nom, état, `lastLine`. Compte « à vérifier ». | Liste plate non triée (ordre de `config.json`), sans télémétrie, sans parqués distingués, sans version ni coût. Modal : on ne peut pas la laisser ouverte. |

Résumé du manque : l'information existe presque entièrement (snapshot
`/api/pupitre`, réducteur client `Musician`, `/api/config`), mais elle est
éparpillée sur quatre surfaces, aucune n'est exhaustive et aucune ne répond
d'un seul regard à « qui fait quoi, qui attend quoi, et depuis quand ».

---

## 2. Inventaire des données existantes

### 2.1 `/api/pupitre` (poll 5 s flotte, 2,5 s volet ouvert ; cache serveur 2,5 s par `(mtime,size)`)

Par membre de `fleet[]` (`scanProject`, `fleet-status-core.mjs` + enrichissement `server.js`) :

| Champ | Sens | Utile pour la vue |
|---|---|---|
| `state` | `idle\|live\|think\|input\|error\|unread` (vocabulaire verrouillé) | **P0** |
| `awaitingChef` | terminé mais bloqué sur `NEEDS_CHEF_INPUT` | **P0** (sous-état « attend le chef ») |
| `stalled`, `deadInFlight` | en vol sans progrès ≥ 60 s / PID mort en vol | **P0** |
| `activity`, `lastKind` | aperçu de l'action courante (`bash · git push…`, `(réflexion…)`, texte) | **P0** (la « ligne ») |
| `needsInput` | question ouverte, seulement si `state === 'input'` | **P0** |
| `questionResolved` | `{ts, note, question}` du dernier acquittement (0.25.0) | P1 |
| `silentMs`, `turnElapsedMs`, `fileSilentMs` | âges (extrapolés côté client par `recvPerf`) | **P0** (« depuis quand ») |
| `pid`, `pidAlive` | liveness (`null` = inconnu, jamais « mort ») | P1 (détail) |
| `model`, `provider`, `configModel`, `configProvider` | model servi (log) sinon configuré | P1 |
| `queueDepth` | nombre de tâches en file derrière le tour | **P0** |
| `parked`, `isConductor` | | **P0** |

Au niveau flotte : `limitedUntil` (limite Claude), `noFailover`, `pool` (file
de direction du chef : `queue[]`, `slots[]`).

### 2.2 `/api/config` (au chargement, et sur `fleet_config_changed`)

`path`, `model`, `tools`, `provider`, `parked`, `attachedSession` (session id),
`readAt` (marqueur `logs/<p>.read`), `currentState`, `lastLine`, `unreadCount`,
`questionResolved`. C'est là que vit le « non lu ».

### 2.3 Flux `/api/sse/fleet`

Une enveloppe `{project, line}` par ligne de log, plus `{type:'pool'}` et
`{type:'fleet_config_changed'}`. Le client (`Musician.transition`) en déduit
l'état **instantanément** ; le snapshot reste la vérité pour la santé.
Rien à ajouter au flux.

### 2.4 Dans les logs, non exposés aujourd'hui dans le snapshot

| Donnée | Où | Remarque |
|---|---|---|
| Coût du tour | `result.total_cost_usd` | Déjà lu par le réveil (`costUsd`) et le panier du fil. Non cumulatif entre sessions (valeurs observées 29,8 → 16,7 → 2,4 $ sur BookHaven). |
| Durée, issue du tour | `result.duration_ms`, `is_error`, `subtype`, `synthetic` | |
| Mission en cours | `user_prompt.text` (sans `source`) | Première ligne = « ce qu'il fait » quand l'activité brute (`bash · …`) est peu parlante. |
| Rapport promis au chef | `user_prompt.callback === 'chef'` | La pompe le suit (`expectCallback`, `musicianAutoStates`) mais ne l'expose pas. |
| Session neuve | `user_prompt.newSession`, `archivedSession` | |
| Model demandé / servi | `system/init.model`, `modelSource` | |

### 2.5 Hors logs

| Donnée | Source | Coût de lecture |
|---|---|---|
| Version applicative | `downloads.json` → `version.file` + regex (13 apps) ; sinon `package.json`, `pyproject.toml`, `app/build.gradle.kts`, `android/app/build.gradle.kts`, ou premier `## [x.y.z]` de `CHANGELOG.md` | 1 `stat` + lecture si mtime changé |
| Dernier build | `builds/<p>/latest.apk` (mtime) | 1 `stat` |
| Session courante | `logs/<p>.session` (id) + mtime | 1 `stat`/lecture |
| File du musicien | `dispatchQueue` (mémoire) + `/api/queue/:p` pour le détail | déjà en mémoire |
| Point du chef en préparation | `wake.pending[]` (`chef.wake.json`) | déjà en mémoire |
| Limite Claude | `logs/claude-limited.until` | déjà lu |

---

## 3. Informations par projet et priorité

Règle : **une tuile répond en deux lignes à « où en est-il, et depuis quand »**.
Tout le reste est chip discret, détail au survol, ou volet.

| Priorité | Information | Rendu sur la tuile | Source |
|---|---|---|---|
| **P0** | État (7 cas visibles) : question · processus perdu · échec · sans progrès · attend le chef · en cours (dont réflexion) · terminé non lu · prêt · mis de côté | glyphe + libellé texte + couleur de bordure | `state`, `stalled`, `deadInFlight`, `awaitingChef`, `parked`, `unreadCount` |
| **P0** | Depuis quand : « tour 4m12 » en vol, « il y a 2 h » au repos, « sans progrès 3m » si stall | âge en mono, extrapolé à la seconde pour les tuiles en vol | `turnElapsedMs`, `silentMs`, `lastActivityAt` (à ajouter) |
| **P0** | La ligne : question ouverte > ce qu'il fait (`activity`) > mission (`user_prompt`) > dernier résultat (`lastLine`) | 1 ligne, ellipsée, texte complet en `title` | `needsInput`, `activity`, `mission` (à ajouter), `lastLine` |
| **P0** | File d'attente | chip « ⏳ 2 en file » | `queueDepth` |
| P1 | Rapport promis au chef | chip « ⇄ chef » sur une tuile en vol | `callbackTo` (à ajouter) |
| P1 | Question acquittée (tant qu'aucun tour n'a repris) | sous-ligne « ✓ marquée répondue — note » | `questionResolved` |
| P1 | Coût du dernier tour, durée | chip « 2,4 $ · 33 s » sur terminé/échec | `lastTurn` (à ajouter) |
| P1 | Model servi (sinon configuré) | chip court « opus 5.5 » / « gpt-6-astra », préfixe provider si codex | `model`/`configModel`, `provider` |
| P2 | Version + dernier build | chip « v1.4.2 · APK 22/09 » | `version`, `build` (à ajouter) |
| P2 | Session (id court, âge, neuve) | survol / volet seulement | `session` (à ajouter) |
| P2 | PID, silence brut | volet seulement (déjà là) | |

Ce qui **n'est pas** sur la tuile : chemin, outils autorisés, `readAt`, tokens.
Ce qui reste aux surfaces existantes : la conversation, le détail d'événements.

---

## 4. Mise en page

### 4.1 Où elle vit

Un **niveau routé `#/projets`** dans la salle de direction, au même titre que
le volet musicien `#/m/<nom>`. Il remplace la zone `main-row` (fil + rail)
quand il est ouvert ; la topbar, le bandeau système et la bande d'attention
restent. Pourquoi pas une page à part comme `/pupitre` : la salle possède déjà
les réducteurs, le snapshot, le SSE, la palette, `openMusician`, les actions
(répondre via le chef, acquitter, parquer). Une page séparée les dupliquerait.
Pourquoi pas un overlay comme le briefing : une modale ne se laisse pas ouverte
sur un second écran ou un téléphone posé à côté.

Points d'entrée : pill **« Projets (32) »** dans la topbar (remplace le bouton
« Musiciens / chercher », dont la recherche devient le filtre de la vue),
entrée du menu ⋮, ligne « Pilotage » sur mobile (elle ouvre la vue au lieu de
la feuille du rail), raccourci clavier `g` puis `p`. Échap ou « ‹ Salle »
ramène au fil. Le dernier niveau ouvert est mémorisé dans `localStorage`
(l'utilisateur qui veut la vue en permanence l'a au rechargement).

### 4.2 Structure : quatre sections, tuiles compactes en grille

```
┌ À VOTRE ATTENTION (3) ────────────────────────────────────────────┐
│  tuiles : question > processus perdu > échec > sans progrès       │
│           > attend le chef                                        │
├ EN COURS (4) ─────────────────────────────────────────────────────┤
│  tuiles : silence décroissant (le plus muet d'abord)              │
├ AU REPOS (13) ────────────────────────────────────────────────────┤
│  terminé non lu d'abord (fin de tour la plus récente en tête),    │
│  puis prêt, par dernière activité décroissante                    │
├ MIS DE CÔTÉ (12) ─ replié par défaut, un clic déplie ─────────────┤
│  par nom ; version et dernière activité seulement, santé non suivie│
└───────────────────────────────────────────────────────────────────┘
```

Le chef n'a pas de tuile : son état vit déjà dans la topbar (règle de la
salle). La file de direction et le point en préparation apparaissent dans la
**barre de synthèse** en tête de vue.

**Barre de synthèse** (sticky sous la topbar, une ligne) :
`3 à votre attention · 4 en cours · 13 au repos · 12 de côté · file chef 1 · point en préparation (2) · 4,80 $ dernière heure · synchronisé il y a 3 s`
Chaque compteur est un bouton : il fait défiler jusqu'à la section (mobile)
ou l'isole (filtre rapide, desktop).

**Grille** : `grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))`.
Sur 1600 px → 5 colonnes, 32 tuiles de 64 px tiennent en ~8 rangées
(≈ 600 px avec les en-têtes) : **tout est visible sans défiler** sur un écran
desktop. Sur 1100 px → 3 colonnes, 11 rangées, un léger défilement. Sur
mobile (< 768 px) → 1 colonne, la section « Mis de côté » repliée, ≈ 20 tuiles
de 56 px, un écran et demi.

### 4.3 Anatomie d'une tuile

```
▌ ● BookHaven                              ⏳2   ⇄chef   opus 5.5
▌   bash · git push origin main                        tour 4m12
```

- Bordure gauche 3 px dans la couleur d'état + glyphe + libellé texte au
  survol/lecteur d'écran : **jamais la couleur seule**.
- Ligne 1 : glyphe, nom (mono, gras), à droite les chips dans cet ordre
  fixe : file, rapport promis, model. Les chips absents ne laissent pas de
  trou.
- Ligne 2 : la ligne (§3), puis l'âge aligné à droite.
- Ligne 3, **optionnelle**, densité « détails » (bouton dans la barre,
  mémorisé) : `v1.4.2 · APK 22/09 · dernier tour 2,4 $ · 33 s · session 91bb…`.
  Par défaut cette ligne est repliée sur desktop et absente sur mobile.
- Toute la tuile est un `<button>` (ou `<a href="#/m/BookHaven">`) :
  `aria-label="BookHaven, en cours depuis 4 minutes 12, bash git push origin
  main, 2 tâches en file, rapport promis au chef"`. La grille est
  `role="list"`, chaque tuile `role="listitem"`.

### 4.4 Codes d'état : couleur + glyphe + mot

Les couleurs sont les jetons existants `--st-*` de `styles.css` ; les glyphes
sont ceux de `salle.js` (`GLYPH`) complétés par ceux de la santé et du parcage.

| Cas | Glyphe | Libellé | Couleur | Note |
|---|---|---|---|---|
| Question ouverte | `?` | Votre réponse attendue | `--st-input` (orange) | pulse lente, coupée sous `prefers-reduced-motion` |
| Processus perdu | `✗` | Processus perdu | `--st-error` | prime sur tout état en vol |
| Échec | `✕` | Échec | `--st-error` (magenta) | sous-libellé = `subtype` |
| Sans progrès | `!` | Sans progrès 3m | `--st-error` à 60 % | en vol, silence ≥ 60 s |
| Attend le chef | `⇄` | Attend le chef | `--st-unread` | `unread` + `awaitingChef` |
| En cours | `●` | En cours | `--st-live` (vert) | |
| Réflexion | `◐` | Réflexion | `--st-think` (ambre) | |
| Terminé non lu | `✓` | Terminé · non lu ×2 | `--st-unread` (cyan) | badge compteur si > 1 |
| Prêt | `○` | Prêt | `--st-idle` (gris-sauge) | |
| Mis de côté | `⏸` | Mis de côté | `--fg-3`, tuile atténuée | pas de santé |

Contraste : les libellés restent en `--fg-1` sur `--bg-1`, seuls la bordure et
le glyphe portent la couleur d'état. Aucune information n'est portée
uniquement par une animation.

### 4.5 Maquette ASCII — desktop 1600 px (5 colonnes)

```
ORCHESTRE  SALLE DE DIRECTION      ♛ CHEF · en cours · file 1       [Projets 32] [● synchronisé] ⋮ ⚙
──────────────────────────────────────────────────────────────────────────────────────────────────────
⚠ À votre attention  1 question · 1 échec · 1 sans progrès        TradeBot : Déployer le bot en prod ?  ▸
──────────────────────────────────────────────────────────────────────────────────────────────────────
‹ Salle   PROJETS   [filtre : nom, activité…      ]   ◻ détails       3 à votre attention · 4 en cours ·
                                                                     13 au repos · 12 de côté · 4,80 $/h
 À VOTRE ATTENTION (3)
┌───────────────────────────┐┌───────────────────────────┐┌───────────────────────────┐
│▌? TradeBot                ││▌✕ jellyfin        opus 5.5││▌! vuBox         ⇄chef opus│
│▌  Déployer le bot en prod ?││▌  error_max_turns · 4,1 $ ││▌  bash · gradle assemble  │
│▌               question 12m││▌               il y a 25m ││▌         sans progrès 3m10│
│ [Répondre via le chef] [✓] ││ [Ouvrir] [En parler au chef]│ [Ouvrir] [En parler au chef]│
└───────────────────────────┘└───────────────────────────┘└───────────────────────────┘
 EN COURS (4)
┌───────────────────────────┐┌───────────────────────────┐┌───────────────────────────┐┌───────────────────────────┐
│▌● orchestrateur  ⇄chef fable││▌◐ BtLocator     ⏳2  astra ││▌● TranslateOverlay  ⇄chef ││▌● SmartKeyGuard    sonnet │
│▌  write · docs/dashboard-… ││▌  (réflexion…)            ││▌  read · MainActivity.kt  ││▌  bash · ./gradlew test   │
│▌                 tour 6m40 ││▌                tour 1m05 ││▌                tour 18m02││▌                 tour 0m41│
└───────────────────────────┘└───────────────────────────┘└───────────────────────────┘└───────────────────────────┘
 AU REPOS (13)
┌───────────────────────────┐┌───────────────────────────┐┌───────────────────────────┐┌───────────────────────────┐┌───────────────────────────┐
│▌✓ BookHaven ×2            ││▌✓ RemotePad               ││▌○ DeskZen                 ││▌○ coursSQL                ││▌○ immo-share              │
│▌  Push terminé, 29 commits ││▌  ✓ question marquée rép… ││▌  APK 1.3.0 publié        ││▌  Chapitre 4 relu         ││▌  —                       │
│▌  terminé il y a 40m · 2,4 $││▌            il y a 3h12   ││▌             il y a 1j    ││▌             il y a 3j    ││▌             il y a 12j   │
└───────────────────────────┘└───────────────────────────┘└───────────────────────────┘└───────────────────────────┘└───────────────────────────┘
  … 8 autres tuiles au repos …
 MIS DE CÔTÉ (12)  ▸  batteryGuard · collection_trad · demarchage · firstAidOffline · frenchradio · liveRec · …
```

En vue « détails », chaque tuile gagne sa troisième ligne :
`v1.4.2 · APK 22/09 · dernier tour 2,4 $ · 33 s · session 91bb…`.

### 4.6 Maquette ASCII — mobile 390 px (1 colonne)

```
┌────────────────────────────────────┐
│ ORCHESTRE      ♛ CHEF · en cours   │
│ ‹ Salle  PROJETS   [filtre…]   ⚙  │
│ 3 attention · 4 en cours · 13 repos│
├────────────────────────────────────┤
│ À VOTRE ATTENTION (3)              │
│▌? TradeBot                    12m  │
│▌  Déployer le bot en prod ?        │
│▌✕ jellyfin                    25m  │
│▌  error_max_turns · 4,1 $          │
│▌! vuBox                  ⇄  3m10   │
│▌  sans progrès · gradle assemble   │
│ EN COURS (4)                       │
│▌● orchestrateur          ⇄   6m40  │
│▌  write · docs/dashboard-status/…  │
│▌◐ BtLocator             ⏳2  1m05  │
│▌  réflexion…                       │
│  …                                 │
│ AU REPOS (13)                      │
│▌✓ BookHaven ×2               40m   │
│▌  Push terminé, 29 commits         │
│  …                                 │
│ MIS DE CÔTÉ (12)                ▸  │
└────────────────────────────────────┘
```

Sur mobile : pas de chip model, pas de troisième ligne, les âges en mono à
droite, glyphes conservés. Un appui long sur une tuile ouvre la feuille
d'actions (Ouvrir, Répondre via le chef, Marquer comme répondue, Mettre de
côté), un appui court ouvre le volet.

### 4.7 Squelette HTML statique d'une tuile (pour le vocabulaire des classes)

```html
<section class="pv-section" data-group="attention" aria-labelledby="pv-h-attention">
  <h2 id="pv-h-attention" class="pv-head">À votre attention <span class="pv-n">(3)</span></h2>
  <div class="pv-grid" role="list">
    <a class="pv-tile" role="listitem" href="#/m/TradeBot" data-name="TradeBot"
       data-state="input" data-health="" aria-label="TradeBot, votre réponse attendue depuis 12 minutes : Déployer le bot en prod ?">
      <span class="pv-glyph" aria-hidden="true">?</span>
      <span class="pv-name">TradeBot</span>
      <span class="pv-chips">
        <span class="pv-chip pv-chip-queue" hidden>⏳ <b>0</b></span>
        <span class="pv-chip pv-chip-cb" hidden>⇄ chef</span>
        <span class="pv-chip pv-chip-model">opus 5.5</span>
      </span>
      <span class="pv-line" title="Déployer le bot en prod ?">Déployer le bot en prod ?</span>
      <span class="pv-age" data-since="1790593111293">question 12m</span>
      <span class="pv-more" hidden>v0.9.1 · dernier tour 1,1 $ · 2m04 · session 5c1a…</span>
    </a>
  </div>
</section>
```

`data-state` reprend le vocabulaire verrouillé ; `data-health` vaut `stall`,
`dead` ou vide ; `data-parked="1"` pour les parqués. Le CSS ne dérive rien
d'autre.

---

## 5. Interactions (minimales)

- **Clic / Entrée** sur une tuile → `App.openMusician(nom)` (volet `#/m/<nom>`).
  Retour → `#/projets` par `history.back()`.
- **Actions contextuelles** : sur les tuiles « À votre attention » seulement,
  deux boutons inline (mêmes handlers que la bande d'attention :
  `answerViaChef`, `resolveQuestion`, `talkToChefAbout`). Ailleurs, menu ⋮
  au survol ou appui long : Ouvrir · Envoyer directement · Mettre de côté /
  Remettre en avant · Marquer lu.
- **Filtre texte** : un champ, filtre nom + ligne, sans requête serveur.
  `/` le focalise. Les parqués sont inclus dans la recherche (ils se déplient
  s'ils correspondent).
- **Filtres rapides** : les compteurs de la barre de synthèse isolent une
  section (desktop) ou y défilent (mobile). Un second clic annule.
- **Densité** : case « détails » (troisième ligne), mémorisée.
- **Clavier** : flèches entre tuiles, Entrée ouvre, Échap revient à la salle.
- Rien d'autre : pas de glisser-déposer, pas de colonnes configurables, pas de
  tri manuel. L'ordre est une règle, pas une préférence.

---

## 6. Temps réel, sans poll supplémentaire

Trois horloges existent déjà ; la vue s'y branche sans en créer.

1. **SSE** (`/api/sse/fleet`) → `Musician.transition` → `App.markDirty(m)`.
   La vue s'abonne à `markDirty` : une tuile est **patchée** (texte des
   nœuds `pv-line`, `pv-glyph`, `data-state`), jamais reconstruite. L'état
   change à la milliseconde, comme le rail.
2. **Snapshot `/api/pupitre`** toutes les 5 s quand l'onglet est visible
   (`applyPupitreToCards`) → santé, âges, file, model, et les nouveaux champs
   (§7). C'est lui qui fait changer une tuile de section (stall, file).
3. **Ticker 1 s** (`startHeartbeatTicker`) → seules les tuiles en vol ou en
   stall voient leur `pv-age` réécrit (extrapolation `recvPerf`, comme
   `/pupitre`). Aucun repaint quand l'onglet est caché.

Réordonnancement : même règle que le rail (`stableOrder`) — un changement de
**section** est immédiat (c'est l'information), une permutation **à l'intérieur**
d'une section attend 1,5 s et jamais sous le pointeur. Le DOM est clé par
`data-name` : on déplace des nœuds, on ne régénère pas la grille.

Fraîcheur : l'âge du snapshot est déjà affiché dans la topbar ; en plus, si
`snapStale()` (> 15 s), les âges passent en `--fg-3` et la barre de synthèse
dit « données anciennes (42 s) ». Une tuile ne prétend jamais une santé
qu'elle n'a pas : parqué = « santé non suivie », pas « prêt ».

Coût client : 32 tuiles × 6 nœuds texte, patch ciblé ; rien de comparable aux
deltas de tokens du fil, qui sont déjà coalescés par rAF.

---

## 7. Côté serveur : réutiliser d'abord, ajouter peu

Tout tient dans **un** endpoint : `/api/pupitre`, enrichi de champs additifs.
Pas de nouvelle route, pas de base, pas de framework. Chaque ajout est cache
par mtime : le poll de 5 s ne relit jamais un fichier inchangé.

### 7.1 Dans `scanProject` (`fleet-status-core.mjs`) — gratuit, même queue de log

| Champ | Dérivation |
|---|---|
| `lastActivityAt` | `timestamp` du dernier événement non partiel, non fantôme (déjà calculé pour `silentMs`, juste exposé). |
| `mission` | Première ligne (≤ 120 car.) du dernier `user_prompt` **sans `source`** de la fenêtre ; `null` si la fenêtre de 256 Kio ne le contient pas (on le dit, on n'invente pas). |
| `lastTurn` | Du dernier `result` non fantôme : `{endedAt, durationMs, costUsd, isError, subtype, synthetic}`. `costUsd = total_cost_usd` tel quel : c'est ce que le réveil et le panier montrent déjà. |
| `callbackTo` | `callback` du `user_prompt` ouvrant le tour en vol, `null` sinon (même règle que `expectCallback` de la pompe, consommé au `result`). |

Le CLI `fleet-status.mjs` en hérite (règle de la source unique) : il peut
afficher « mission » et « dernier tour » sans autre travail.

### 7.2 Dans `/api/pupitre` (`server.js`)

| Champ | Source | Cache |
|---|---|---|
| `unreadCount` | même calcul que `/api/config` (`scanProjectState` + `readMarker`) | dans le cache 2,5 s existant |
| `queueHead` | `head` de la première entrée de `dispatchQueue.get(p)` (≤ 60 car.) | mémoire |
| `version` | `{value, source}` : registre `downloads.json` si le projet y est, sinon détection dans `p.path` (§2.5), sinon `null` | par mtime du fichier de version, TTL 60 s |
| `build` | `{at}` = mtime de `builds/<p>/latest.apk`, `null` sinon ; l'URL est déjà `/downloads/<p>/apk` | `stat` seul, TTL 60 s |
| `session` | `{id, ageMs, isNew}` depuis `logs/<p>.session` (mtime) et `user_prompt.newSession` du tour | par mtime |
| **Parqués** | scannés avec `scanFleetMemberCached` mais **TTL 60 s** au lieu de 2,5 s, et `stalled`/`deadInFlight` forcés à `false` (santé non suivie, comme aujourd'hui) — on gagne `lastActivityAt`, `lastTurn`, `version` sans changer la règle | 60 s |
| Au niveau flotte : `wakePending` | `wake.pending.map(({source, outcome}) => …)` — « point en préparation (2) » | mémoire |

Coût : au pire 32 `stat` par poll (négligeable) et une lecture de fichier de
version par projet par minute. Les 12 parqués ajoutent 12 lectures de queue
de log par minute (le cache par `(mtime,size)` évite de relire un log figé :
en pratique, zéro).

### 7.3 Pas de nouveau script, deux tests

- `scripts/_test_pupitre_overview.mjs` : sur les vrais logs, vérifie la forme
  des champs additifs, l'absence de champ manquant pour un parqué, et que
  `version.value` est bien lu pour les 13 apps du registre.
- Étendre `scripts/_test_downloads_hot.mjs` ? Non : la détection de version
  réutilise `VERSION_NAME_RE` du registre ; aucun nouveau format.

Règles respectées : token gate inchangé (même route), noms de projets déjà
validés contre `config.json`, aucun chemin venu d'une requête, `logs/`
jamais commité, pas de DB, pas de framework, vocabulaire d'états verrouillé
(tous les ajouts sont additifs, comme `awaitingChef`).

---

## 8. Effort

| Lot | Contenu | Estimation |
|---|---|---|
| **A — vue client, données existantes** | `public/projets.js` + `projets.css` : route `#/projets`, 4 sections, tuiles 2 lignes, filtre, barre de synthèse, patch DOM par `data-name`, `stableOrder`, mobile, clavier, a11y. Alimenté par `App.musicians` + snapshot actuel (état, santé, activité, question, file, model, parqué, âges). | 1,5 j |
| **B — serveur** | §7.1 et §7.2, caches, test `_test_pupitre_overview.mjs`, `fleet-status` affiche `mission` et `lastTurn`. | 0,5 à 1 j |
| **C — finitions** | Troisième ligne « détails » (version, build, coût, session), actions contextuelles, appui long mobile, `wakePending` dans la barre, recette sur téléphone via Tailscale, palettes matrix/encre. | 0,5 j |
| Livraison | Bump **minor** (0.29.0), `CHANGELOG.md`, cache-busting `?v=` dans `index.html`. | inclus |

**Total ≈ 3 jours.** Le lot A seul livre l'essentiel de la demande (« qui
fait quoi, qui attend quoi, depuis quand, tous visibles ») ; B et C ajoutent
version, coût, mission et session. `/pupitre` reste en place pour le
diagnostic (PID, silence brut) et pourra être retiré plus tard si la vue
« détails » le rend redondant.

---

## 9. Les cinq choix qui comptent

1. **Une seule surface exhaustive, dans la salle, routée** (`#/projets`),
   pas une page ni une modale : elle hérite des réducteurs, du SSE, des
   actions et de la palette, et se laisse ouverte en permanence.
2. **Quatre sections à ordre imposé** (attention → en cours → au repos →
   de côté) avec des règles de tri fixes et le réordonnancement stable du
   rail. Le regard tombe d'abord sur ce qui bloque ; rien ne saute sous le
   pointeur.
3. **Tuile en deux lignes, deux questions** : « où en est-il » (glyphe +
   libellé + ligne) et « depuis quand » (âge). Tout le reste est chip ou
   troisième ligne optionnelle. La densité vient de ce qu'on retire.
4. **État = glyphe + mot + couleur, jamais la couleur seule** ; le vocabulaire
   `idle|live|think|input|error|unread` reste verrouillé, tous les sous-états
   (stall, PID mort, attend le chef, parqué, non lu) sont des drapeaux
   additifs comme aujourd'hui.
5. **Zéro poll en plus, un seul endpoint enrichi** : SSE pour l'instant,
   snapshot 5 s pour la santé et les nouveaux champs (mis en cache par mtime),
   ticker 1 s pour les compteurs. Les parqués entrent dans le snapshot à
   60 s, sans santé.

## 10. Pièges à éviter

- **Reconstruire la grille en `innerHTML` à chaque snapshot** : 32 tuiles
  toutes les 5 s, plus le SSE, feraient sauter le défilement et perdre le
  focus clavier. Patcher par `data-name`, déplacer les nœuds.
- **Faire dire « prêt » aux parqués** (le comportement actuel de `/pupitre`) :
  c'est faux et ça masque un tour lancé sur un parqué. Afficher « mis de
  côté », l'âge réel, et « santé non suivie ».
- **Sommer `total_cost_usd` sans précaution** : il n'est ni strictement
  par tour ni cumulatif sur toute la vie du musicien (il suit la session
  Claude et repart avec `--new-session`). Afficher le coût **du dernier
  tour** sur la tuile ; le total horaire de la barre est une somme des
  derniers `result` de la fenêtre, étiquetée « ≥ ».
- **Lire la version par `git describe` ou en spawnant quoi que ce soit** à
  chaque poll : 32 processus toutes les 5 s sur un disque USB, et le watchdog
  tuerait le serveur (cf. mémoire projet). Fichiers seulement, cache par mtime.
- **Confondre « lancé » et « démarré »** : une tâche en file ou un dispatch
  sans `system/init` observé n'est pas « en cours ». Le chip ⏳ dit « en
  file », la tuile ne passe en vert qu'au tour réel (même prudence que les
  lignes de mission).
- **Cacher une question derrière un compteur** : « Terminé · non lu ×3 » ne
  doit jamais absorber un `input` ou un `error`. Les sections l'empêchent par
  construction ; garder cette règle si un jour on ajoute un mode « liste
  plate ».
- **Traiter le result fantôme** (`num_turns: 0`, `duration_api_ms: 0`) comme
  une fin de tour : la tuile passerait « terminé » en plein travail. Le
  client l'ignore déjà ; `lastTurn` côté serveur doit l'ignorer aussi.
- **Réutiliser le bouton « Mettre de côté » sans confirmation** depuis la
  grille : un clic mal placé sur mobile parquerait un projet actif. Le
  garder derrière le menu ⋮ / l'appui long, avec confirmation.
- **Animer la couleur pour signaler un changement** : sous
  `prefers-reduced-motion` ou pour un daltonien, rien ne passe. Le glyphe et
  le mot changent, l'animation est un bonus.
