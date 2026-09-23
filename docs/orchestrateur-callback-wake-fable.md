# Design : réveil sûr du chef sur callback attendu — Anthropic Fable — 2026-09-23

Document de design, lecture seule (v0.19.0 sur disque). Aucun code modifié, serveur 7777 non redémarré. Numéros de ligne vérifiés dans l'arbre de travail.

## 0. La décision révisée, et pourquoi elle est tenable

Mon rapport du 2026-09-22 a écarté « tour chef déclenché par callback ». Le motif était juste : le mécanisme retiré en v0.14.3 réveillait le chef **sur chaque fin de musicien**, avec le texte brut du callback comme *prompt utilisateur*, et rejouait les vieux callbacks depuis la file persistée au redémarrage (`git show 6d1944b`). Trois défauts : indiscriminé, mal attribué, non idempotent.

L'utilisateur a raison sur le fond : quand le chef **promet** « je te fais le point dès le callback », ne pas le réveiller casse la promesse. La bonne question n'est pas « réveiller ou non » mais « **réveiller sur quoi** ». Réponse : uniquement sur un callback que le chef a **explicitement attendu au moment du dispatch**, une seule fois par lot, sans interruption, sous budget, sans rejeu. Ce document spécifie cela.

**Fait décisif relevé dans le code.** Le flag `--callback chef` n'est passé **par personne côté serveur** (`server.js`, `scripts/*` : 0 occurrence hors `dispatch.mjs` lui-même). Il n'apparaît que dans les commandes Bash du chef — **515 fois** dans `logs/chef.jsonl`. L'intention « j'attends ce résultat » est donc déjà exprimée à chaque dispatch ; elle n'est simplement **jamais enregistrée** : `dispatch.mjs:572-576` la transforme en prose injectée dans le prompt du musicien, puis l'oublie. Le design consiste à **capturer cette intention là où elle existe déjà**, pas à en inventer une.

## 1. Cartographie : comment le chef est invoqué aujourd'hui

| Chemin | Où | Ce qui se passe | Réveille le chef ? |
|---|---|---|---|
| Message utilisateur | `POST /api/dispatch` (`server.js:3133-3341`) | interrompt un tour en cours (`killDispatchTree`, `:3281-3300`), spawn `dispatch.mjs chef --prompt-stdin` (`:3323`) | **oui** — le seul chemin nominal |
| Raccourci `@musicien` | `:3188-3226` | `user_prompt` sourcé écrit dans le log chef pour visibilité (`:3199-3210`), dispatch du **musicien** | non (par conception) |
| Fin de tour musicien | watcher `:3716-3749` → `autoNotifyConductor` (`:2769-2796`) | écrit `notification` enrichie dans le log chef, toast | **non** (v0.14.3, `:2786-2795`) |
| Callback manuel du musicien | `scripts/notify.mjs` → `POST /api/notify` (`:2798-2822`) | `user_prompt` sourcé dans le log cible | non |
| `NEEDS_CHEF_INPUT` | pompe SSE `:2272-2274` → `maybeDispatchChefQuestion` (`:1830-1846`) | `spawnDirectDispatch(chef, prompt)` avec marqueur `[NEEDS_CHEF_INPUT_FROM:x]`, dédup `(musicien, 100 premiers chars)` | **oui** — seul réveil programmatique existant |

**Le serveur sait donc déjà spawner le conducteur** : `spawnDirectDispatch(name, prompt)` (`:348-390`) lance `dispatch.mjs <chef> --prompt-stdin`, qui fait `--resume` sur la session du chef (`dispatch.mjs:1066-1079`). C'est exactement ce qu'il faut : **le chef réveillé retrouve sa propre session, donc sa promesse**. Deux limites à connaître :

- `spawnDirectDispatch` **ne vérifie ni l'état ni le PID** du chef (`:348-390`, aucun appel à `dispatchPidAlive`). Le relais NEEDS_CHEF (`:1845`) l'appelle tel quel : deux `claude -p --resume` sur la même session peuvent tourner en parallèle et s'écraser le `.pid` (`dispatch.mjs` écrit le sidecar). C'est un défaut **préexistant** que le réveil ne doit pas reproduire.
- Le mécanisme retiré en v0.14.3 avait, lui, une garde « chef occupé → file + état fantôme → drain » (`git show 6d1944b`). Elle était correcte ; c'est le *contenu* du prompt et l'*indiscrimination* qui posaient problème.

**Ce que le chef croit.** Son contrat (`I:\Dev\Chef\CLAUDE.md:138-166`) ne mentionne pas `--callback` : il lui dit de **tailler les logs pendant son propre tour** (§3) puis de synthétiser (§4). La promesse « je te fais le point dès le callback » est une improvisation du chef sans mécanisme derrière. Le contrat devra être aligné (§6, P0-4).

## 2. Attendu vs incident : où vit l'attente

**Principe : l'attente est une propriété du *tour* du musicien, enregistrée dans son log, pas un marqueur en mémoire.**

- `dispatch.mjs` connaît `callbackProject` dès l'analyse des arguments (`:131-135`, validé `:185`). Il écrit déjà un `user_prompt` synthétique en tête de tour (`:628-631`, avec `source` si `--source`). **Ajouter `callback: "<chef>"` à cet événement** (champ additif, une ligne). Rien d'autre à persister : le log est la vérité, il survit au redémarrage, et l'attente est liée sans ambiguïté au tour qu'elle concerne.
- `reduceMusician` (`server.js:2104-2136`) capture `expectCallback = ev.callback` sur le `user_prompt` **sans source** ou `system/init` qui ouvre le tour, le renvoie avec `prevState/newState`, et l'efface au `result`. Même pattern que `awaitingChef` ajouté en 0.18.0.
- Le watcher (`:3716-3749`), sur un `result` **réel** (non synthétique) d'un tour dont `expectCallback === conductorName()` : écrit la `notification` **comme aujourd'hui** (inchangé), puis appelle `scheduleConductorWake(item)`.

Tout le reste est *incident* et ne réveille jamais : `POST /api/notify` (manuel, peut arriver **en cours de tour** — la prose injectée dit « ou si tu as un point important à signaler en cours de route »), `@shortcut`, un musicien lancé sans `--callback`, un `result` synthétique, la fin du **propre tour du chef**.

Pourquoi déclencher sur le `result` et non sur le `POST /api/notify` : le `result` est le moment autoritaire (le tour est vraiment fini, l'issue est connue, la carte enrichie existe déjà) ; le notify du musicien n'est que sa prose, et il peut précéder le `result` de quelques secondes ou ne jamais venir. Le prompt de réveil embarquera les deux quand les deux existent (§3).

## 3. Déclenchement : un tour de synthèse, coalescé, poussé

`scheduleConductorWake(item)` ne spawne **jamais** directement. Il alimente un panier d'attente serveur — le pendant serveur du « panier de résultats » client de 0.18.0 — puis un unique point de tir décide.

```
result attendu de A ──▶ pendingWake += {A, outcome, summary, duration, cost, ts, notifyText?}
                        arme/rafraîchit un délai de coalescence (COALESCE_MS ≈ 10 s)
                        si d'autres tours ATTENDUS tournent encore → prolonge, plafonné (WAIT_LOT_MAX ≈ 90 s)
                                    │
                         tireur (une seule fonction, un seul verrou)
                                    │
        ┌──────────── conditions de tir toutes vraies ? ────────────┐
        │ pendingWake non vide                                        │
        │ chef sans producteur vivant (dispatchPidAlive === null)     │
        │ budget non épuisé (§4-3) ; pas de limite Claude active      │
        │ aucun prompt utilisateur pour le chef depuis l'entrée       │
        └─────────────────────────────────────────────────────────────┘
                                    │ oui
              construit UN prompt [CALLBACK_WAKE] avec tout le panier
              spawnDirectDispatch(chef, prompt)   (dispatch.mjs --resume)
              journalise le lot tiré ; vide pendingWake
```

**Contenu du prompt de réveil** (le chef ne lit pas `chef.jsonl`, il ne voit que sa session — il faut lui *donner* le lot) :

```
[CALLBACK_WAKE lot=3 gen=1]
Les résultats que tu attendais sont arrivés. Fais le point à l'utilisateur
(2–5 puces par musicien, ce qu'il a EFFECTIVEMENT fait). Ne redispatche que
si c'était prévu dans la demande initiale ; sinon termine ton tour.

— vuBox ✓ 3m12 · $0.42 · Tests OK, 2 avertissements restants…
  (callback du musicien : « … »)
— RemotePad ✕ 0m48 · Build failed: gradle…
— DeskZen ⇄ attend ta décision : « Quelle option de sync ? »
```

**Intégration au panier client (0.18.0/0.19.0) — rien à défaire.** Les cartes sont déjà dans le fil (`notification` écrite avant le tir). Le réveil produit un `system/init` du chef → snapshot `_resultsSinceChefTurn` → la réponse du chef porte « prend en compte : vuBox ✓ · RemotePad ✕ · DeskZen ⇄ » (`app.js`, `_currentTurnTaking`). La séquence visible devient exactement la maquette du 22/09, **poussée au lieu d'attendue** : panier → ♛ CHEF · prend en compte … → synthèse.

Le `user_prompt` du réveil sera écrit par `dispatch.mjs` **avec `source: "wake"`** (via `--source wake`, ou un `--wake` dédié). Conséquences déjà correctes grâce aux acquis : sourcé ⇒ n'arme pas « le chef répond » (v0.16.1) ni ne promeut l'état (v0.17.0) — c'est `system/init` qui le fait ; ⇒ n'est pas rendu comme message utilisateur. Un seul ajustement client : `source === "wake"` ne doit **pas** devenir une carte de résultat (aujourd'hui `_fileResult` prendrait tout `source` non-shortcut, `app.js` branche `user_prompt`) — le rendre en ligne système discrète « ⟲ le chef fait le point (3) » ou ne pas le rendre. Idem `/api/conductor-chat` et `FleetViewModel.kt`.

## 4. Garde-fous anti-boucle et anti-coût

Chaque garde répond à un défaut concret du mécanisme retiré ou à un risque identifié §1.

### 4-1. Sélectivité (le défaut n° 1 de v0.14.3)
Seul un `result` réel d'un tour porteur de `callback: chef` déclenche. Pas les notifications incidentes, pas `/api/notify`, pas `@`, pas les synthétiques, pas la fin d'un tour du chef, pas un tour lancé par `spawnDirectDispatch` (relais NEEDS_CHEF, drain de file) — ces derniers n'ont pas `--callback`.

### 4-2. Anti-rentrance : profondeur de génération bornée
Un tour de réveil peut légitimement dispatcher (« c'était prévu ») avec `--callback chef` → nouveau réveil. Sans borne : A → réveil → A → réveil → … Borne déterministe :
- le prompt de réveil porte `gen=n` ; `spawnDirectDispatch` passe `DISPATCH_WAKE_GEN=n` ; `dispatch.mjs` propage `wakeGen` dans le `user_prompt` de tout musicien dispatché **depuis** ce tour (env hérité par le Bash du chef → `dispatch.mjs` enfant le lit et l'écrit) ;
- le watcher n'appelle `scheduleConductorWake` que si `wakeGen < WAKE_MAX_GEN` (**2**). Au-delà, la `notification` est écrite normalement et le lot attendra le prochain prompt utilisateur (= comportement actuel, donc jamais pire qu'aujourd'hui).
- Longueur maximale d'une chaîne sans intervention humaine : prompt utilisateur → réveil gen 1 → réveil gen 2 → stop.

### 4-3. Débit et coût
- **Un seul tir en vol** : verrou `wakeInFlight` levé au `result` du chef (le watcher voit les résultats du chef, `:3720`) ou au timeout de sécurité.
- **Jamais d'interruption** : contrairement à `/api/dispatch`, le réveil n'appelle jamais `killDispatchTree`. Chef occupé (PID vivant) ⇒ le panier attend ; le `result` du chef re-déclenche le tireur. État « occupé » sans PID vivant = fantôme (cas déjà traité en v0.14.3 et par le filet PID 0.16.1) ⇒ on tire.
- **Budget** : ≥ 60 s entre deux tirs ; ≤ 6 tirs par heure glissante (constantes, journalisées). Au-delà, coalescence dans le prochain créneau autorisé.
- **Pas de tir vers une limite** : si `readLimitedUntil()` (`server.js`, 0.17.0) est actif, on ne spawne pas — le tour écrirait un synthétique `error_limited` et brûlerait un créneau. Le panier reste et se libère au prochain prompt ou à l'expiration.
- **Annulation par l'utilisateur** : un `user_prompt` **sans source** pour le chef (l'utilisateur a parlé) **vide `pendingWake`** — le tour normal qui suit affichera de toute façon le panier via « prend en compte ». Zéro tour payé en double.

### 4-4. Idempotence et redémarrage (le défaut n° 3 de v0.14.3)
- Clé de dédup par résultat : `${musicien}:${result.timestamp ?? duration_ms}:${session_id}`. Un même résultat ne peut être compté deux fois (rejeu SSE, reprise du watcher par blocs).
- `pendingWake` est miroir dans `logs/queue/chef.wake.json` (écriture atomique, même code que `persistQueue`, `:301-315`) ; rehydraté au boot **avant** tout dispatch comme les files (`:317-340`).
- Chaque tir journalise le lot couvert dans `logs/chef.wake-log.ndjson`. Au boot, les résultats attendus **postérieurs au dernier lot journalisé** et antérieurs au boot forment **un seul** réveil de rattrapage, sous budget. Rien n'est rejoué au-delà (contrairement à l'ancienne file qui rejouait tout).
- Le prompt de réveil est identifiable (`[CALLBACK_WAKE`) : `healOrphanedLogs`/`lastNonPartialType` n'ont rien à changer (c'est un `user_prompt` sourcé, déjà ignoré depuis 0.17.0).

### 4-5. Pas de dispatch implicite
Le réveil ne dispatche jamais rien lui-même ; il n'écrit qu'un prompt. Si le chef redispatche, c'est une action explicite de l'agent, soumise à 4-2. Le prompt lui rappelle de ne pas le faire sauf plan initial.

## 5. Risques et cas limites

| Cas | Comportement spécifié |
|---|---|
| Chef en train de répondre | pas d'interruption ; panier gardé ; tir au `result` du chef (ou immédiatement si PID fantôme). |
| Callback en **échec** (`failed`) | compte comme **accompli** : on réveille avec ✕ — l'utilisateur doit entendre la mauvaise nouvelle, c'est le cœur de la promesse. |
| Musicien qui **ne finit jamais** | aucun `result` ⇒ aucun réveil (pas de faux « point »). P1 : si un tour attendu est `stalled`/PID mort (`/api/pupitre`, 0.17.0) depuis `EXPECT_STALL_MS` (≈ 20 min), réveiller **une fois** avec outcome `stalled` : « je n'ai pas de nouvelles de X ». |
| Tour attendu clos **synthétiquement** (`error_interrupted` / `error_limited`) | P0 : pas de réveil (pas de travail à rapporter). P1 : réveil unique avec outcome `closed` — la promesse est rompue par le système, l'utilisateur doit le savoir ; sur `limited`, différer à l'expiration de `limitedUntil`. |
| Plusieurs musiciens finissent ensemble | coalescence (10 s + attente du lot jusqu'à 90 s) ⇒ **un** tour, un « prend en compte » multiple. |
| Notify du musicien avant son `result` | le notify est stocké (sourced `user_prompt`, déjà) et **joint** au prompt de réveil ; pas de réveil séparé. |
| Redémarrage serveur mi-parcours | attente dans le log du musicien (survit) ; `pendingWake` rehydraté ; rattrapage unique borné (4-4). |
| Deux `--callback chef` pour le même musicien (redispatch) | chaque tour a sa propre attente ; dédup par résultat, pas par musicien. |
| Utilisateur tape pendant l'attente | `pendingWake` annulé, le tour utilisateur affiche le panier. |
| Le chef **oublie** `--callback` | comportement actuel (carte + prochain prompt). Le contrat du chef (§6) rend le flag explicite : « si tu promets de revenir, mets `--callback chef` ». |
| Réveil pendant `no-failover` + limite | pas de tir (4-3) ; le panier attend. |

## 6. Plan pour Opus 5 — P0 puis P1

Tout est additif : aucune nouvelle chaîne d'état, aucun événement CLI réécrit, le panier client 0.18.0/0.19.0 est réutilisé tel quel. `dispatch.mjs` est relu à chaque appel ; `server.js` demande **un** redémarrage par le chef. Version cible **0.20.0**.

### P0 — le réveil sûr (serveur + dispatch + contrat du chef)

| # | Lot | Fichiers | Critère de vérification |
|---|---|---|---|
| P0-1 | **Enregistrer l'attente** : `callback: callbackProject` sur le `user_prompt` synthétique ; `reduceMusician` capture/renvoie `expectCallback`, effacé au `result`. | `scripts/dispatch.mjs:628-631`, `server.js:2104-2136` | log d'un dispatch `--callback chef` ⇒ `user_prompt.callback === "chef"` ; sans flag ⇒ absent ; `reduceMusician` le rend jusqu'au `result` puis `null`. |
| P0-2 | **`scheduleConductorWake` + tireur** : panier `pendingWake` + sidecar atomique ; coalescence 10 s / lot 90 s ; conditions de tir (PID chef, budget, limite, annulation utilisateur) ; verrou en vol levé au `result` du chef ; journal `chef.wake-log.ndjson` ; rattrapage unique au boot. Appel depuis le watcher **après** `autoNotifyConductor`, uniquement `!ev.synthetic && expectCallback === conductorName()`. | `server.js` (watcher `:3716-3749`, nouveau bloc près de `persistQueue` `:301`) | fixtures : 3 résultats attendus en 5 s ⇒ **1** spawn ; résultat non attendu ⇒ 0 ; chef PID vivant ⇒ 0 jusqu'au `result` du chef puis 1 ; 7 lots en 1 h ⇒ 6 tirs ; redémarrage avec sidecar ⇒ 1 rattrapage ; prompt utilisateur pendant l'attente ⇒ 0. |
| P0-3 | **Prompt de réveil + provenance** : `spawnDirectDispatch(chef, prompt, …, { source: 'wake', wakeGen })` → `dispatch.mjs --source wake` ; env `DISPATCH_WAKE_GEN` propagé aux enfants ; watcher refuse `wakeGen ≥ 2`. | `server.js:348-390`, `scripts/dispatch.mjs:139-145, 628-631` | chaîne user → gen1 → gen2 → **stop** vérifiée sur fixtures ; le `user_prompt` du chef porte `source:"wake"`. |
| P0-4 | **Contrat du chef** : §2 « si tu comptes revenir vers l'utilisateur après coup, dispatche avec `--callback chef` et **termine ton tour** : le serveur te réveillera une fois avec le lot » ; §3 le tail des logs devient l'option « point immédiat » ; règle « dans un tour `[CALLBACK_WAKE]`, ne redispatche que si prévu ». | `I:\Dev\Chef\CLAUDE.md:138-166` | relecture ; un dispatch de test montre le flag. |
| P0-5 | **Client** : `source === "wake"` ⇒ ligne système « ⟲ le chef fait le point (n) » (ou rien), jamais une carte ; `/api/conductor-chat` marque `wake:true` ; Android idem. | `public/app.js` (branche `user_prompt`), `server.js:2074-2082`, `FleetViewModel.kt` | harness headless : `user_prompt{source:'wake'}` ⇒ aucune carte ; la réponse chef suivante porte « prend en compte ». |

### P1 — promesses rompues et observabilité
- Réveil unique sur tour attendu `stalled`/PID mort (`EXPECT_STALL_MS`) et sur clôture synthétique `error_interrupted` ; sur `error_limited`, différé à l'expiration de `limitedUntil`.
- `/api/pupitre` : champs additifs `expectCallback` (par musicien) et racine `pendingWake: n`, `lastWakeAt` → badge carte « ⏳ attendu par le chef » et bandeau « point en préparation (2) ».
- Compteur de budget visible dans le pupitre ; alerte si la borne horaire est atteinte (signal d'une boucle qu'on n'a pas prévue).
- Garde de liveness dans `spawnDirectDispatch` (bénéficie aussi au relais NEEDS_CHEF, §1).

### Écarté, et pourquoi
- Réveil sur `POST /api/notify` : arrive en cours de tour, non autoritaire, indiscriminé — c'est l'ancien défaut.
- Réveil sur *toute* fin de musicien avec une heuristique (« le chef a récemment dit "callback" ») : fragile ; le flag existe déjà 515 fois, autant l'utiliser.
- File `dispatchQueue` du chef pour porter les réveils : elle rejoue au boot sans dédup et sert le raccourci `@` ; le panier dédié est plus petit et idempotent.
- Un tour chef par résultat (pas de coalescence) : coût × n et n synthèses partielles ; le panier 0.18.0 existe précisément pour l'éviter.

## 7. Garde-fous vis-à-vis de l'acquis

- **v0.16.1** : le `user_prompt` de réveil est sourcé ⇒ n'arme pas `_awaitingConductorResponse` ; `system/init` l'arme, `result` le désarme, filet PID inchangé.
- **v0.17.0** : reducers ignorent le prompt sourcé, cache `/api/pupitre` et skip parked intacts ; pas de drain de file sur synthétique conservé ; `healOrphanedLogs` déjà insensible aux prompts sourcés.
- **v0.18.0 / v0.19.0** : le panier client et les cartes ne changent pas ; le réveil les *complète* (le « prend en compte » fonctionne déjà). Seule addition : ne pas transformer le prompt `wake` en carte.
- **Vocabulaire d'états** : `idle|live|think|input|error|unread` inchangé ; `expectCallback`, `wakeGen`, `pendingWake` sont des champs/structures additifs.
- **Sécurité** : le réveil passe par `spawnDirectDispatch` → env sans `ANTHROPIC_API_KEY` (`:365`), mêmes `--allowed-tools`, aucun shell-concat (argv tableau).

*Rapport non committé — le chef décide. Aucun autre fichier touché.*
