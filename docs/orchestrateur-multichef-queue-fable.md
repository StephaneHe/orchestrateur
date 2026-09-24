# Design file d'attente + pool de 3 chefs — Anthropic Fable — 2026-09-24

Lecture seule : aucun code, aucune config, aucune version modifiés ; serveur 7777 non redémarré. Seule écriture : ce fichier. Lignes citées vérifiées dans l'arbre de travail au 2026-09-24 (v0.21.3 sur disque, `package.json:3`).

**Concept en une phrase : l'utilisateur continue de parler « au chef », mais chaque message devient un ticket dans une file de direction ; jusqu'à trois chefs, sessions distinctes mais même rôle, prennent les tickets dans l'ordre, chacun route vers le musicien concerné (ou, une fois au plus, vers un confrère chef), et le point revient au chef qui a lancé la mission ; quand les trois sont occupés, le ticket attend, visiblement, sans jamais interrompre personne.**

Trois décisions structurantes, justifiées plus bas :

1. **Le pool est élastique, pas symétrique.** Le chef 1 garde l'affinité de conversation ; les chefs 2 et 3 ne prennent un ticket que si le chef 1 est occupé. À faible tempo, rien ne change par rapport à aujourd'hui (une session, une mémoire, un seul liseré ambre). C'est la garantie de non-régression des acquis 0.16.1 → 0.21.x.
2. **La mémoire de direction est dans la flotte, pas dans la session.** Trois sessions `claude -p` ne partagent rien. Le serveur injecte donc, à chaque changement de chef, un court « registre de direction » (derniers tickets, missions en vol, questions ouvertes) construit à partir de données qu'il possède déjà. Le chef n'a jamais « tout » en tête : c'est déjà vrai aujourd'hui (`I:\Dev\Chef\CLAUDE.md:199-203` lui demande de lire `config.json` et les tails, pas de se souvenir).
3. **Un message n'interrompt plus jamais un chef par défaut.** Aujourd'hui, écrire pendant un tour du chef le tue (`server.js:3511-3532`). Avec la file, le message attend ou part vers un chef libre ; l'interruption reste possible mais **explicite** (`!interrupt`, ou l'action « Interrompre » sur le slot).

---

## 1. Cartographie du conductor actuel (chef unique)

| Mécanique | Où (vérifié) | Ce qui change avec le pool |
|---|---|---|
| Identité du chef : un seul nom `config.conductor` (`chef`), entrée sans `model`/`tools` propres | `server.js:345` (`conductorName()`), `config.json:2,9-12` | `chef` devient le **nom logique du pool** ; les workers sont `chef`, `chef-2`, `chef-3` (alias dérivés, §2.3) |
| Message du composer ⇒ `POST /api/dispatch {project:'chef'}` | `public/app.js:2752-2867` (cible toujours `CONDUCTOR` `:2760`, fetch `:2839-2843`), `server.js:3365-3602` | La route **enfile** au lieu de spawner ; réponse `202 {ticket, slot|null, position}` |
| Raccourci `@X` : file par musicien si `live/think`, sinon spawn direct ; note `shortcut→X` dans le log chef | `server.js:3420-3458` | Inchangé (ne passe pas par le pool) ; la note va dans le log du **pool** (`chef.jsonl`, §2.8) |
| **Pas de verrou chef** : si un PID vit pour le projet, le tour est **tué** (`taskkill /T /F`) et le prompt reçoit un `[SYSTEM_INTERRUPT_RESUME]` | `server.js:3511-3532`, `killDispatchTree :3349-3363`, `formatInterruptResumeNotice :3254-3278` | Devient l'exception explicite (§2.8) |
| Spawn réel = `node scripts/dispatch.mjs <name> --prompt-stdin` ; env scrubbé, `DISPATCH_*` d'instrumentation | `server.js:3555-3570` (route), `spawnDirectDispatch :549-597` (wake, relais, drain) | Un seul spawner de chefs : `spawnDirectDispatch` piloté par l'ordonnanceur (§2.4) ; ajout de `DISPATCH_SLOT`, `DISPATCH_TICKET`, `DISPATCH_CHEF_HOP` |
| argv `claude` : `--print … --model <m> --setting-sources project,local --strict-mcp-config --disable-slash-commands [--resume sid]` ; `cwd = project.path` | `scripts/dispatch.mjs:1085-1098`, `:1153-1159` | Inchangé ; `--model`/`--provider` deviennent des **flags** (§2.6) |
| Model/tools/provider lus à chaque dispatch : `project.model || defaults.model` | `dispatch.mjs:189-191` | + `conductorPool.model` pour les slots |
| Sidecars par projet : `logs/<p>.session` (source de vérité), `logs/<p>.pid`, `logs/<p>.jsonl` | `dispatch.mjs:201-203`, session écrite `:1231-1234`, PID `:1163` ; `server.js:264-277` (Map + rehydratation) | Un jeu de trois fichiers **par slot** ; aucun format ne change |
| Vivacité = PID + fraîcheur ≤ 12 h | `server.js:3297-3342` | Réutilisé tel quel pour l'état des slots |
| File par musicien (`@X` seulement), persistée `logs/queue/<name>.json`, drainée au `result` | `server.js:292-339`, `drainQueue :600-608`, drain `:4093-4099` | Étendue : les entrées portent `callback`/`source`/`model` et **tout** dispatch vers un musicien occupé s'y range (§2.6) |
| Réveil-sur-callback 0.20.0 : état unique `wake` (`pending`, `inFlight`), un seul point de tir, jamais d'interruption, budget, dedupe persistée | `server.js:347-540` (`tryFireWake :497-538`, `scheduleConductorWake :446-455`, `cancelWakeOnUserPrompt :460-468`), site `:4075-4091`, libération `:4036-4039`, attente stampée `dispatch.mjs:628-650` | Le lot devient un **ticket de classe « point »**, épinglé au slot qui a lancé la mission (`callbackSlot`), `inFlight` par slot (§2.8) |
| Relais `NEEDS_CHEF_INPUT` → chef → `[CHEF_ANSWER]` ; walk-back du log chef pour retrouver le marqueur | `server.js:2003-2089` | Question = ticket de classe « décision » ; walk-back sur le log du **slot** qui a produit le `result` |
| Notifications de résultat écrites dans `chef.jsonl` (`notification/musician_done|question`) ; `/api/notify` append un `user_prompt` sourcé | `server.js:3061-3101`, `:3103-3127` | Inchangé : `chef.jsonl` = log du slot 1 **et** journal du pool |
| Fil = `GET /api/conductor-chat` (tail 2 Mio de `chef.jsonl`, saute `source:'wake'`) | `server.js:2246-2328` | Fusion des trois logs, champs `slot`, `ticket`, `answersTicket` (§2.11) |
| Snapshot = `GET /api/pupitre` (cache 2,5 s, `isConductor`, `queueDepth`) | `server.js:1751-1801` | + objet racine `pool` (§2.11) ; les slots 2-3 sont exclus de `fleet[]` |
| UI : état du chef **uniquement** dans l'en-tête ; drapeau client `_awaitingConductorResponse` armé par prompt sans source / `system/init`, désarmé par `result` ou filet PID | `public/salle.js:89-120`, `public/app.js:2292-2313`, `:3070-3082`, `public/index.html:30-37` | Trois pastilles de slot dans l'en-tête ; le drapeau devient **par slot** (§3) |
| Missions reconnues au `tool_use Bash … dispatch.mjs <X>` du chef | `public/salle.js:464-488` | Même règle, par slot ; une cible `chef` devient une **ligne de délégation** `♛` (§3.3) |
| Règles du chef : dance `config.json` set → dispatch → revert pour choisir le model | `I:\Dev\Chef\CLAUDE.md:26-49` | **À supprimer** (course entre chefs) au profit de `--model` (§2.6, §6) |
| Coût observé (tail 20 Mio de `logs/chef.jsonl`, 81 tours) : 2,2 USD, 97 s, 3,8 tool-turns en moyenne par tour de chef (Opus 4.8) ; musiciens : 1,9 à 17,7 USD par tour | mesure du 2026-09-24 | Base de la reco model (§4) |

---

## 2. Modèle fonctionnel

### 2.1 Vocabulaire

- **Pool** : le nom logique `config.conductor` (`chef`). C'est toujours ce nom que l'utilisateur, les musiciens (`--callback chef`, `notify.mjs chef`) et les chefs eux-mêmes emploient. Personne n'adresse un slot par son nom, sauf le serveur.
- **Slot** (chef N) : un worker conductor, `N ∈ {1,2,3}`. Nom de fichiers `chef` (slot 1, **inchangé**, rétro-compatible), `chef-2`, `chef-3`. Même `cwd` (`I:\Dev\Chef`), même `CLAUDE.md`, sessions, logs et PID **séparés**.
- **Ticket** : un élément de la file, `m-<epochms>-<4 hex>`. Classes : `user` (composer), `decision` (relais `NEEDS_CHEF_INPUT`), `point` (lot de réveil 0.20.0), `delegation` (chef → chef).
- **Affinité** : slot préféré d'un ticket (dernier slot ayant parlé à l'utilisateur, ou slot cité par « répondre à »). Souhait, pas contrainte.
- **Épinglage** : slot **obligatoire** d'un ticket (réponse à une question posée par le chef N, point d'une mission lancée par le chef N). Contrainte, avec délai de grâce.
- **Hop** : profondeur de délégation chef → chef. `0` pour un ticket utilisateur, `1` pour un ticket délégué. **`2` est refusé.**

### 2.2 Cycle de vie d'un ticket

```
 composer / relais / wake / chef
        │  enqueue (persisté)
        ▼
   ┌─────────┐   slot libre compatible    ┌──────────┐  spawn dispatch.mjs   ┌─────────┐
   │ QUEUED  │ ─────────────────────────▶ │ ASSIGNED │ ────────────────────▶ │ RUNNING │
   └─────────┘                            └──────────┘   (user_prompt +      └─────────┘
        │  ▲ requeue (1 fois max,          │ PID mort > 60 s   system/init)     │ result
        │  │  après crash serveur)         ▼                                     ▼
        │  └────────────────────────── ┌──────┐                            ┌────────────┐
        │  Retirer (UI)                │ LOST │                            │ DONE|FAILED│
        ▼                              └──────┘                            └────────────┘
   ┌───────────┐
   │ WITHDRAWN │
   └───────────┘
```

- `QUEUED` : dans `logs/queue/chef.pool.json` (écriture atomique tmp+rename, même recette que `persistQueue` `server.js:301-315`). Position visible.
- `ASSIGNED` : le serveur a choisi le slot et spawné `dispatch.mjs chef-N`. L'UI dit « pris par CHEF 2 » seulement quand le `user_prompt` (stampé `ticket`, `slot`) apparaît dans le log du slot ; « en cours » au `system/init` (même règle d'honnêteté que les missions, doc UI validé §3.1).
- `RUNNING → DONE` au `result` du slot (le pump du watcher le voit déjà, `server.js:4036`). `FAILED` si `is_error` ; `synthetic` (interrompu, limité) = clos par le système, gris, jamais rouge.
- `LOST` : slot assigné sans PID vivant depuis 60 s (`healOrphanedLogs` ferme déjà le tour orphelin au boot, `server.js:674` ; en cours d'exécution, l'ordonnanceur applique la même règle). Requeue **une seule fois**, en tête, avec un préfixe `[REPRISE] ton tour précédent a été perdu ; vérifie l'état avant d'agir` (réutilise `formatInterruptResumeNotice`). Un ticket `attempts=2` passe en `FAILED` avec une bulle système.
- Journal d'audit `logs/chef.pool-log.ndjson` (une ligne par transition), sur le modèle de `chef.wake-log.ndjson` (`server.js:376`).

### 2.3 Le pool : identité, sessions, config

`config.json` :

```json
"conductor": "chef",
"conductorPool": { "size": 3, "model": "claude-opus-5" }
```

- `size` ∈ 1..3, défaut **1** si absent (⇒ comportement « file devant un chef unique », voir P0-A). `3` est la valeur demandée.
- Les slots ne sont **pas** listés dans `projects[]`. Un helper partagé `resolveProject(name)` (à placer dans `scripts/fleet-status-core.mjs`, importé par `server.js` et `dispatch.mjs`) reconnaît `^<conductor>-([2-3])$` et renvoie l'entrée du conductor avec `slot:N`. Ainsi `dispatch.mjs:176-183` (validation du nom, `project.path`) et `scanProject` (`fleet-status-core.mjs:193`) fonctionnent sans dupliquer la config. Les chefs eux-mêmes ne peuvent pas cibler `chef-2` : `dispatch.mjs` refuse un nom de slot quand `DISPATCH_SLOT` est défini dans son env (c'est un chef qui parle).
- Sessions : `logs/chef.session`, `logs/chef-2.session`, `logs/chef-3.session`. Le slot 1 **reprend la session actuelle** telle quelle. Les slots 2-3 démarrent à froid à leur premier ticket (coût d'amorçage : lecture de `CLAUDE.md`, pas de cache) ; c'est une raison de plus pour l'affinité.
- Model : `conductorPool.model || conductor.model || defaults.model`, identique pour les trois slots (§4 explique pourquoi on ne mélange pas).
- `POST /api/conductor` (`server.js:1813`) : changer de conductor vide la file (les tickets `QUEUED` sont `WITHDRAWN` avec une bulle système) ; les slots en vol terminent.

### 2.4 Ordonnancement

**FIFO avec contraintes, servi à chaque événement** (enfilement, `result` d'un slot, PID perdu, expiration d'une grâce). Une seule fonction `schedulePool()` sur le modèle de `tryFireWake` : ré-armée, jamais forcée ; rien n'est perdu, seulement différé.

Algorithme, pour chaque slot libre (pas de PID vivant, pas de ticket `ASSIGNED`), dans l'ordre 1, 2, 3 :

1. Parcourir la file du plus ancien au plus récent ; prendre le **premier** ticket dont la contrainte est satisfaite par ce slot :
   - épinglé à ce slot ⇒ oui ;
   - épinglé à un autre slot ⇒ non, sauf si la grâce est expirée (voir ci-dessous) ;
   - non épinglé ⇒ oui, mais si son slot d'affinité est **libre et différent**, on laisse ce slot le prendre à son tour (le parcours 1→3 suffit : le slot d'affinité est traité en premier quand c'est le 1, sinon on saute et on y revient).
2. Un ticket de classe `point` n'est pris que si aucun ticket `user` ou `decision` n'est prenable par ce slot (les points coalescent, les attendre les enrichit ; l'utilisateur et un musicien bloqué passent avant).
3. Refus global : si `logs/claude-limited.until` est actif (`readLimitedUntil` `server.js:1766-1774`), on ne spawne **rien** (même garde que `tryFireWake :514-515`) ; la file reste visible avec le bandeau `⚡ limité jusqu'à …`.

Grâces (starvation) :

- **Épinglé « réponse à une question du chef N »** : attend N sans limite. Le chef N a posé une question et terminé son tour, il est donc libre sauf s'il a repris un autre ticket entre-temps ; l'UI montre « attend le chef N » avec l'action secondaire « Confier à un autre chef » (dé-épingle, injecte le registre + la question citée).
- **Épinglé « point pour le chef N »** : grâce = `WAKE_LOT_MAX_MS` (90 s, `server.js:368`) ; ensuite n'importe quel slot libre le prend, le prompt de réveil contient déjà tout le lot (`buildWakePrompt :477-493`) et le registre donne le contexte de lancement.
- **Affinité** : jamais bloquante.

Équité : un utilisateur qui envoie cinq messages en rafale les voit servis dans l'ordre, trois immédiatement, deux en positions 1 et 2. Aucun ticket `user` n'expire. Les tickets `point` gardent le TTL de 6 h de 0.20.0.

### 2.5 Tous occupés

- Le ticket reste `QUEUED`, position affichée sous la bulle et dans la bande « File de direction » (§3). Aucun compte à rebours (règle d'honnêteté du doc UI validé §1).
- Le composer prévient **avant** l'envoi (« Les 3 chefs sont occupés : votre message sera mis en file ») et ne change pas le libellé du bouton.
- Interrompre reste possible, mais c'est un geste : `!interrupt <texte>` ou `force_interrupt:true` (`server.js:3476-3498`, conservés) vise le slot d'affinité ; l'action « Interrompre » d'une pastille vise ce slot. Le ticket interrompant saute la file (il **est** le remplaçant du tour tué), le tour tué reçoit son `result` synthétique comme aujourd'hui.
- « Retirer de la file » sur un ticket `QUEUED` ⇒ `WITHDRAWN`, bulle grisée `⟲ retiré`, brouillon restitué dans le composer.

### 2.6 Routage chef → musicien (ce que fait un chef quand il consomme)

Inchangé dans son principe : le chef lit le ticket, identifie la cible, décompose, choisit un model, dispatche en arrière-plan avec `--callback chef` s'il promet un point (`I:\Dev\Chef\CLAUDE.md:138-169`). Trois changements rendus nécessaires par la concurrence :

1. **`--model <id>` et `--provider <p>` sur `dispatch.mjs`** (aujourd'hui inexistants ; le model vient de `config.json:189-191`). La « dance » set → dispatch → revert de `CLAUDE.md:26-49` est une écriture concurrente de `config.json` par trois processus : perte de mise à jour garantie tôt ou tard, et le hot-reload (`fleet_config_changed`) tourne dans le vide. Le flag remplace la dance ; `config.json` n'est plus écrit par un chef.
2. **Un musicien occupé n'est jamais interrompu par un chef.** Aujourd'hui `dispatch.mjs` spawne sans regarder le `.pid` : deux chefs qui visent le même musicien lanceraient deux `claude --resume` sur la même session. Nouveau comportement : si `logs/<X>.pid` est vivant, `dispatch.mjs` **poste** au serveur (`POST /api/dispatch {project:X, prompt, callback, source, model, queueIfBusy:true}`, token lu comme dans `notify.mjs:74-77`) ; le serveur range dans la file par musicien existante (`dispatchQueue`), qui doit désormais porter `callback`/`source`/`model` (aujourd'hui `drainQueue :603` perd le callback : `spawnDirectDispatch` ne le transmet pas). Serveur injoignable ⇒ comportement actuel + avertissement dans le log. Le chef voit « mis en file derrière le tour en cours » dans la sortie de `dispatch.mjs` et sa ligne de mission dit `⏸ en file`.
3. **Stampage d'origine.** `dispatch.mjs` copie `DISPATCH_SLOT` et `DISPATCH_TICKET` (hérités de l'env du chef, même mécanisme que `DISPATCH_WAKE_GEN` `dispatch.mjs:646-649`) dans le `user_prompt` du musicien : `callback:'chef'`, `callbackSlot:2`, `ticket:'m-…'`. C'est ce qui permet au point de **revenir au chef 2** et à l'UI de relier mission ↔ ticket sans nouveau champ serveur ailleurs.

### 2.7 Délégation chef → chef (« le musicien concerné peut être un autre chef »)

Cas légitimes : un ticket agrège plusieurs missions longues et indépendantes que le chef veut voir supervisées en parallèle (un chef par mission, chacun avec son propre point) ; ou le chef constate que le sujet appartient à une mission qu'un confrère suit (le registre le lui dit).

Mécanique : le chef exécute `node dispatch.mjs chef "<sous-mission>" [--callback chef]`. Comme la cible est le pool, `dispatch.mjs` **ne spawne pas** : il poste un ticket `delegation` avec `hop = DISPATCH_CHEF_HOP + 1`, `origin = slot courant`, affinité = aucun (un autre slot de préférence : l'ordonnanceur évite le slot d'origine s'il existe une alternative, sinon le prend quand il se libère).

Bornes, toutes portées par les données :

- **`hop ≤ 1`.** Un slot qui tourne avec `DISPATCH_CHEF_HOP=1` et qui dispatche vers `chef` reçoit un refus immédiat (`exit 65`, message clair) et le serveur écrit une `notification/delegation_refused` dans le journal du pool. Le chef doit alors router vers un musicien ou répondre lui-même.
- **`WAKE_MAX_GEN = 2`** continue de borner les réveils, `DISPATCH_WAKE_GEN` étant hérité à travers la délégation.
- Un ticket délégué ne peut pas être épinglé au slot d'origine (sinon il attendrait son propre créateur).
- Le délégué **répond à l'utilisateur** comme n'importe quel chef (sa bulle porte « délégué par CHEF 1 »). Si le délégant a mis `--callback chef`, il reçoit en plus un point épinglé (classe `point`, donc après les tickets utilisateur) : c'est le seul cas où deux chefs parlent du même sujet, et l'UI le montre (§3.3).

### 2.8 Interaction avec l'existant

| Acquis | Comportement avec le pool |
|---|---|
| **0.16.1 chef figé** (drapeau client armé par prompt sans source / `system/init`, désarmé par `result` ou PID) | Le drapeau devient une **Map par slot** (`_awaitingConductor[slot]`). Même sources d'armement, sur le log du slot ; le filet PID (`_conductorLivenessCheck`) interroge `pool.slots[n].pidAlive`. Une pastille « répond… » sans PID vivant ⇒ même auto-guérison qu'aujourd'hui. |
| **0.17.0 santé** (`/api/pupitre`, cache 2,5 s) | Les slots sont scannés par `scanFleetMemberCached('chef-N')` (cache par nom) et exposés sous `pool.slots`, **pas** dans `fleet[]` (le rail ne montre jamais un chef). Aucun poll supplémentaire. |
| **0.18.0 panier** | Inchangé : `autoNotifyConductor` écrit dans `chef.jsonl` (journal du pool). Le panier se place après le tour du chef qui l'a **lancé** (le `notification` porte `callbackSlot`). |
| **0.19.0 mobile / Android** | P1 : `pool` dans `/api/pupitre`, `slot`/`ticket` dans `/api/conductor-chat` ; l'app garde son fil unique, badges de slot et ligne « Direction » (§3.6). |
| **0.20.0 réveil** | `wake` devient `wake[slot]` : `pending`, `seen`, `inFlight` par slot ; le lot épinglé à `callbackSlot`. `cancelWakeOnUserPrompt` (`:460-468`) ne s'applique qu'au **slot** qui reçoit le prompt utilisateur (le chef 2 qui prépare un point ne perd pas son lot parce que l'utilisateur parle au chef 1). Budget `WAKE_MAX_PER_HOUR` : **global au pool** (6/h), pas par slot, pour que la concurrence ne triple pas les points. `tryFireWake` n'appelle plus `spawnDirectDispatch` : il enfile un ticket `point`. |
| **Relais `NEEDS_CHEF_INPUT`** (`:2037-2053`) | `maybeDispatchChefQuestion` enfile un ticket `decision` (affinité = slot qui a lancé le musicien, via `callbackSlot`). `maybeRelayChefAnswer` (`:2055-2089`) walk-back **le log du slot** dont vient le `result` (le pump connaît `name`). Dédupe inchangée. |
| **Raccourci `@X`** (`:3420-3458`) | Inchangé ; la note `shortcut→X` va dans `chef.jsonl`. |
| **`/api/notify`** (`:3103-3127`) | Cible `chef` ⇒ append dans `chef.jsonl` (journal du pool), aucun tour, comme aujourd'hui. |
| **Interruption** (`:3511-3532`) | Uniquement sur `!interrupt` / `force_interrupt` / action « Interrompre » ; sinon la route enfile. Le ticket interrompant est marqué `interrupting:true` et vise un slot précis. |
| **Sessions** (`/api/projects/:name/sessions`, attach) | Fonctionnent pour `chef-2`, `chef-3` via `resolveProject` ; accessibles depuis le détail du slot (§3.5). |
| **Redémarrage serveur** | `logs/queue/chef.pool.json` rehydraté avant tout dispatch (comme `loadQueuesFromDisk :317-339`) ; tickets `ASSIGNED/RUNNING` dont le PID est mort ⇒ `LOST` ⇒ requeue une fois ; `healOrphanedLogs` doit itérer aussi les slots (`:674-676` itère `config.projects`). |
| **Kill-switch / limite** | `readLimitedUntil` bloque l'ordonnanceur ; `no-failover` inchangé (par processus `dispatch.mjs`). |

### 2.9 Registre de direction (contexte partagé)

Injecté par le serveur en tête du prompt d'un ticket **quand le slot qui le prend n'est pas celui qui a traité le ticket `user` précédent** (changement de chef), et toujours pour un ticket `delegation` ou `point` dé-épinglé. Borné à ~1 500 caractères, construit sans IA :

```
[POOL chef 2/3 · ticket m-1790231000-a3f2 · 2 en file]
Registre de direction (généré par le serveur, état à 09:41:07) :
• Derniers tickets : 09:31 CHEF 1 « Vérifie vuBox et RemotePad » (en cours) · 09:38 CHEF 3 « Prépare la release DeskZen » (terminé)
• Missions en vol : vuBox (lancée par CHEF 1, 3m12, bash npm test) · RemotePad (CHEF 1, 0m40, ! sans progrès)
• Questions ouvertes : DeskZen → utilisateur « Quelle synchro ? » (non répondue)
• Un confrère peut déjà suivre ce sujet : ne relance pas une mission en cours ; lis son log si besoin.
```

Sources : la file et son journal (tickets), `musicianAutoStates` + `user_prompt.callbackSlot` des musiciens (missions en vol), `reduceMusician` (`input`, `awaitingChef`). Le registre est **écrit dans le `user_prompt` du slot sous un champ `registry`** distinct du `text`, pour que le fil n'affiche jamais ce préambule (même principe que `source:'wake'` sauté par `/api/conductor-chat:2281-2285`).

### 2.10 Ordre des réponses

Avec trois chefs, les réponses peuvent arriver dans un ordre différent des questions. Règles :

- Le fil reste **chronologique par arrivée** (honnête, et c'est déjà l'ordre du log). Chaque bulle de chef porte `answersTicket` ; l'UI affiche « ↩ répond à « … » » quand la bulle utilisateur visée n'est pas immédiatement au-dessus, avec ancre cliquable.
- Un `notification` ou un panier se rattache au slot qui a lancé la mission (`callbackSlot`), donc au bon tour.
- L'UI ne réordonne jamais le fil ; elle relie. Aucune fusion de réponses de chefs différents.

### 2.11 API (additive)

- `POST /api/dispatch {project:'chef', prompt, attachmentPaths?, videoPaths?, force_interrupt?, replyToSlot?, replyToTicket?}` ⇒ `202 {ok, ticket, class:'user', slot:null|N, position, poolSize}`. `slot` non nul seulement si un slot était libre au moment de l'appel (assignation immédiate).
- `GET /api/pupitre` ⇒ ajoute `pool: { size, model, slots:[{ slot, name, state:'idle'|'live'|'think'|'input'|'error'|'unread', pidAlive, ticket:{id, head, since}|null, lastResultAt }], queue:[{ id, class, head, source, pinnedSlot, affinitySlot, enqueuedAt, position, hop }] , limitedUntil }`. Vocabulaire d'état des slots = celui des réducteurs, inchangé.
- SSE `/api/sse/fleet` ⇒ `data: {type:'pool', reason:'enqueued'|'assigned'|'started'|'done'|'withdrawn'|'lost'}` comme signal « quelque chose a changé » (comme `fleet_config_changed :2585-2591`) ; le snapshot reste la vérité.
- `GET /api/conductor-chat` ⇒ fusion horodatée des logs `chef`, `chef-2`, `chef-3` (tail 2 Mio chacun), entrées `user` avec `ticket`, `slot` (si assigné), `queued:true` si encore en file ; entrées `conductor` avec `slot`, `answersTicket`, `delegatedBy`, `wake:true` (P1-2 du doc UI, ici nécessaire).
- `DELETE /api/pool/queue/:ticket` (retirer) ; `POST /api/pool/interrupt/:slot` (équivalent de `force_interrupt` visant un slot) ; `POST /api/pool/queue/:ticket/unpin` (« Confier à un autre chef »).
- `dispatch.mjs` : `--model <id>`, `--provider claude|codex`, `--queue-if-busy` (défaut vrai quand `DISPATCH_SLOT` est défini), refus des noms de slot depuis un chef, cible `chef` ⇒ POST pool.

---

## 3. Traduction visuelle (intégrée à la Salle de direction 0.21.x)

### 3.1 Principes

- **Le fil reste la scène unique.** La file se lit **sur les bulles elles-mêmes** (statut sous chaque message en attente) ; une bande fine « File de direction » n'apparaît que si la file est non vide, au même rang que « À votre attention » (`index.html:61`).
- **Les trois chefs vivent dans l'en-tête**, à la place de la pastille unique (`index.html:30-37`, `renderChefStatus salle.js:89-120`) : trois pastilles numérotées, pas de carte, pas de colonne. Le rail PILOTAGE ne montre **jamais** un chef.
- **Un chef = une voix, un numéro, un motif de liseré.** La couleur ambre reste la voix du chef ; la distinction est typographique et géométrique (lisible sans couleur, mouvement réduit respecté).
- **Honnêteté** : « assigné » ≠ « pris » ≠ « en cours » ; « en file · position n » sans compte à rebours ; slot sans PID = « processus inconnu » ; jamais « chef 2 vous répond » avant `system/init`.

### 3.2 Bureau, niveau 0

```
┌──────────────────────────────────────────────────────────────────────┬─────────────────────────┐
│ ORCHESTRE / SALLE DE DIRECTION   ♛ CHEFS [1 ● répond 0m42][2 ◐ réfléchit][3 ○ libre]   sync 3 s │
│                                                        file : 1 en attente   [Musiciens] [⋮] [⚙] │
├──────────────────────────────────────────────────────────────────────┴─────────────────────────┤
│ ⏳ FILE DE DIRECTION · 1 message en attente · 2 chefs occupés · 1 libre (épinglé)          [▾] │
├──────────────────────────────────────────────────────────────────────┬─────────────────────────┤
│                                        ┌─────────────────────────┐   │ PILOTAGE                │
│                                        │ Vérifie vuBox et       │   │ EN COURS (2)            │
│                                        │ RemotePad.      09:31  │   │ [vuBox]      En cours   │
│                                        └─────────────────────────┘   │  bash npm test · 3m12   │
│                                          ▸ pris par CHEF 1 · 09:31   │ [RemotePad]  En cours   │
│ ┃♛¹ CHEF 1 · 09:31                                                   │  ! sans progrès 1m12    │
│ ┃ ▸ Activité : 3 outils · 1m40                                       │ À EXAMINER (1)          │
│ ┃ Je leur confie les tests et la compilation ; point à leurs retours.│ [DeskZen]  Votre réponse│
│ ┃ ┌ MISSIONS (2) ────────────────────────────────────────────────┐  │ ─────────────────────── │
│ ┃ │ ▮ VUBOX     ● en cours 3m12 · bash npm test        [Ouvrir ›]│  │ Tous les musiciens (15) │
│ ┃ │ ▮ REMOTEPAD ● en cours 0m40 · ! sans progrès       [Ouvrir ›]│  │ Mis de côté (13)      ▸ │
│ ┃ └──────────────────────────────────────────────────────────────┘  │                         │
│                                        ┌─────────────────────────┐   │                         │
│                                        │ Prépare la release     │   │                         │
│                                        │ DeskZen.        09:38  │   │                         │
│                                        └─────────────────────────┘   │                         │
│                                          ▸ pris par CHEF 2 · 09:38   │                         │
│ ┇♛² CHEF 2 · 09:39   ↩ répond à « Prépare la release DeskZen »       │                         │
│ ┇ ▸ Activité : 2 outils · 0m50                                       │                         │
│ ┇ Je découpe : build par DeskZen, puis notes de version. Je te fais  │                         │
│ ┇ le point.                                                          │                         │
│ ┇ ┌ MISSIONS (1) ──────────────────────────────────────────────────┐ │                         │
│ ┇ │ ▮ DESKZEN   ⏸ en file derrière son tour en cours   [Ouvrir ›] │ │                         │
│ ┇ └────────────────────────────────────────────────────────────────┘ │                         │
│                                        ┌─────────────────────────┐   │                         │
│                                        │ Réponse pour DeskZen : │   │                         │
│                                        │ synchro par Wi-Fi.09:40│   │                         │
│                                        └─────────────────────────┘   │                         │
│                       ⏳ en file · position 1 · attend le CHEF 1 (question posée par lui)     │
│                                        [Retirer] [Confier à un autre chef]                    │
├──────────────────────────────────────────────────────────────────────┴─────────────────────────┤
│ À : CHEFS (1 libre)  [📎] Écrivez au chef…                                          [Envoyer] │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
  serveur v0.22.0
```

Lecture : l'en-tête dit **qui** est occupé et **depuis quand** ; la bande dit **combien** attendent ; chaque bulle utilisateur dit **où en est son message** ; chaque bulle de chef dit **quel chef** et **à quoi** il répond. Les missions restent dans le tour du chef qui les a lancées.

### 3.3 Les bulles

**Bulle utilisateur — ligne de statut** (sous la bulle, petites capitales, JetBrains Mono) :

| Phase | Texte | Source |
|---|---|---|
| `QUEUED` | `⏳ en file · position 2` (+ `· attend le CHEF 1` si épinglé, `· 3 chefs occupés` sinon) + `[Retirer]` (+ `[Confier à un autre chef]` si épinglé) | `pool.queue` |
| `ASSIGNED` | `▸ assigné au CHEF 2` (gris) | événement `pool` |
| pris (log du slot) | `▸ pris par CHEF 2 · 09:38` | `user_prompt{ticket}` du slot |
| interrompant | `⚡ a interrompu le CHEF 1` | `interrupting` |
| `WITHDRAWN` | `⟲ retiré de la file` (bulle grisée) | — |
| `LOST` ⇒ requeue | `⟲ tour perdu · remis en tête de file` | — |

**Bulle de chef** : label `♛¹ CHEF 1`, `♛² CHEF 2`, `♛³ CHEF 3` ; liseré `┃` (1), `┇` (2), `┋` (3). Pill `↩ répond à « … »` quand la bulle visée n'est pas juste au-dessus (clic ⇒ ancre). Point sur les résultats : liseré doublé du même motif (`┃┃`, `┇┇`, `┋┋`) + en-tête `CHEF 2 — POINT SUR LES RÉSULTATS`. Délégation : pill `↩ délégué par CHEF 1`.

**Ligne de délégation** dans le bloc MISSIONS du délégant (cible = pool) :

```
┃ ┌ MISSIONS (3) ───────────────────────────────────────────────────────┐
┃ │ ▮ VUBOX      ● en cours 3m12                               [Ouvrir ›]│
┃ │ ♛ CHEF (pool) ⏳ délégation en file « superviser RemotePad + vuBox »  │
┃ │ ♛ CHEF 3     ● délégation prise 09:42 « préparer la release »  [Voir ›]│
┃ └──────────────────────────────────────────────────────────────────────┘
```

`[Voir ›]` fait défiler jusqu'à la bulle du délégué (même fil), pas de volet. Une délégation refusée (hop 2) apparaît en `✕ délégation refusée : profondeur max` avec aide.

### 3.4 Bande « File de direction », dépliée (niveau 1)

```
┌ ⏳ FILE DE DIRECTION (2) ─────────────────────────────────────────────────────── [▴] ┐
│ 1. 09:40  « Réponse pour DeskZen : synchro par Wi-Fi »   attend le CHEF 1 (question)  │
│           [Retirer] [Confier à un autre chef]                                          │
│ 2. 09:41  « Regarde pourquoi TradeBot plante »            n'importe quel chef · 3 occ. │
│           [Retirer] [Interrompre le CHEF 3 avec ce message]                            │
│ Points en préparation : 1 (pour CHEF 1, vuBox ✓ RemotePad ✕)          ⓘ après les vôtres │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Priorité d'affichage si la bande cohabite avec « À votre attention » : attention d'abord (question, processus perdu), file ensuite ; les deux restent une ligne chacune repliées.

### 3.5 Détail d'un chef, niveau 2 : `#/c/<n>`

Clic sur une pastille ⇒ volet routé qui **remplace le rail** (même composant que `#/m/<X>`, `salle.js:572-870`), onglets Activité / Dernier tour / Journal récent, en-tête `pool.slots[n]` (état, ticket en cours, durée, PID, model observé, session). Actions : **Interrompre avec un message** (préremplit `!interrupt` et vise ce slot), Sessions (existant), Ouvrir `/pupitre`. Aucune action d'administration du pool ici (taille et model = `#/reglages`).

### 3.6 Mobile (web ≤ 768 px, `app.js:511-512` / `salle.css:479`) et Android

```
Journal (mobile)                       Feuille Direction                  Bulle chef (mobile)
┌────────────────────────────┐        ┌────────────────────────────┐     ┇♛² CHEF 2 · 09:39
│ ♛ CHEFS ●◐○ · file 1 · 3 s ⋮│        │ DIRECTION         [Fermer] │     ┇ ↩ « Prépare la release… »
│ Pilotage : 2 en cours ·    │        │ 1 ● répond 0m42 « Vérifie… »│    ┇ ▸ 2 outils · 0m50
│            1 question    › │        │ 2 ◐ réfléchit « Prépare… » │     ┇ Je découpe : build…
│ ⚠ DeskZen : « Quelle … » ▾ │        │ 3 ○ libre (épinglé : non)  │     ┇ MISSIONS (1)
│────────────────────────────│        │────────────────────────────│     ┇  ▮ DeskZen ⏸ en file
│            ┌ Vérifie … ┐   │        │ FILE (1)                   │
│   ▸ pris par CHEF 1 09:31  │        │ 1. « Réponse pour DeskZen »│
│ ┃♛¹ 09:31 ▸ 3 outils       │        │    attend le CHEF 1        │
│ ┃ Je leur confie …         │        │    [Retirer] [Autre chef]  │
│ ┃ MISSIONS (2) …           │        │ Points en préparation : 1  │
│            ┌ Réponse … ┐   │        └────────────────────────────┘
│   ⏳ en file · pos. 1 ·    │
│      attend le CHEF 1   ›  │   tap « ⏳ … › » ⇒ feuille Direction
│────────────────────────────│   tap pastilles ⇒ feuille Direction
│ À : CHEFS (0 libre) [+] [➤]│   tap chef dans la feuille ⇒ écran détail (NavHost)
└────────────────────────────┘
  app 0.7.0 · serveur 0.22.0
```

- L'en-tête mobile condense les trois pastilles en `●◐○` (glyphes seuls, `aria-label` complet) + `file n`.
- Une **feuille Direction** (nouvelle, sœur de la feuille Pilotage) liste slots puis file ; c'est la seule surface mobile où l'on agit sur la file.
- Android : mêmes règles, `FleetViewModel` lit `pool` dans `/api/pupitre` et `slot`/`ticket` dans `/api/conductor-chat` ; badge de slot sur `ConductorBubble`, ligne de statut sous `UserBubble`, `DirectionSheet` à côté de `PilotageSheet`. Retour : feuille, puis détail, puis journal à l'ancre (inchangé).

### 3.7 Différenciation graphique

| Objet | Marqueur | Forme | Notes |
|---|---|---|---|
| Chef 1 / 2 / 3 | `♛¹` `♛²` `♛³` + `CHEF n` | liseré `┃` / `┇` / `┋` | Ambre pour les trois ; le numéro est toujours écrit (jamais couleur seule). Option de teinte : 1 = ambre, 2 = ambre clair, 3 = ambre sourd, désactivable (`prefers-contrast`). |
| Pastille de slot (en-tête) | `○` libre · `●` répond · `◐` réfléchit · `?` question posée · `✗` processus perdu · `⚡` limité | pill `data-state` = état du réducteur | `data-state` inchangé (`idle|live|think|input|error|unread`) ; libellés du doc UI validé §2. |
| Ticket en file | `⏳` + position | petites capitales sous la bulle | `⟲` retiré/perdu (gris), `⚡` interrompant. |
| Point | liseré doublé du motif du slot | en-tête `CHEF n — POINT SUR LES RÉSULTATS` | Inchangé sinon (0.18/0.20). |
| Délégation | `♛` en tête de ligne de mission | ligne mono dans MISSIONS | `⏳ en file` → `● prise par CHEF n` → `✓/✕`. |
| Bande File | `⏳ FILE DE DIRECTION (n)` | une ligne, dépliable | Un seul bandeau système reste la règle ; la bande File est une **bande**, comme Attention. |

### 3.8 Divulgation progressive et honnêteté

| Objet | L0 | L1 | L2 |
|---|---|---|---|
| Slot | glyphe + numéro (+ « répond 0m42 » sur bureau) | tooltip / feuille : ticket en cours, depuis, PID, model | `#/c/n` : activité, dernier tour, journal, session |
| File | compteur dans l'en-tête et la bande | liste ordonnée avec contraintes et actions | — (chaque ticket renvoie à sa bulle) |
| Ticket | statut sous la bulle | actions Retirer / Confier / Interrompre | — |
| Réponse | bulle chef numérotée | pill « répond à » avec ancre | tour complet |
| Délégation | ligne `♛` dans MISSIONS | bulle du délégué avec « délégué par » | — |

Interdits : « chef 2 vous répond » avant `system/init` ; compte à rebours ; « 2 sur 3 » sans liste ; fusionner les réponses de deux chefs ; réordonner le fil ; montrer le registre de direction dans le fil ; afficher les slots dans le rail.

---

## 4. Recommandation de model pour le rôle de chef

**Ce que fait un tour de chef** (mesuré, 81 tours récents) : 97 s, 3,8 appels d'outils, 2,2 USD en moyenne. Tool-léger, mais **chaque décision engage un tour de musicien** de 2 à 18 USD et de 5 à 15 minutes. Le coût d'un routage raté (mauvais projet, prompt flou, décomposition manquée, model sous-dimensionné) dépasse d'un ordre de grandeur le surcoût du chef lui-même. Le critère dominant est donc la **qualité de jugement**, sous contrainte de fiabilité d'outillage (Bash Windows, `dispatch.mjs`, callbacks) et de latence perçue (l'utilisateur attend l'accusé du chef).

| Candidat | Routage / décomposition / prompts aux musiciens | Coût (×3 en pointe) | Latence | Outillage et callbacks dans ce fleet | Verdict chef |
|---|---|---|---|---|---|
| `claude-opus-5` | Excellent ; le meilleur jugement des workhorses ; rédige de bons prompts délégués ; synthèses fidèles | Supérieur à 4.8, du même ordre ; tour tool-léger ⇒ surcoût absolu faible | Comparable à 4.8 | Déjà éprouvé comme musicien ici (TradeBot, shoette, RemotePad, orchestrateur : `stream-json`, `notify.mjs`, `--resume` OK) | **Recommandé, par défaut pour les trois slots** |
| `claude-opus-4-8` | Très bon ; c'est le chef actuel, sans incident de routage documenté (les incidents « chef figé » étaient infra) | Référence (2,2 USD/tour) | Référence | Le plus rodé (110 tours de chef) | **Repli sûr** si le coût d'Opus 5 est jugé trop élevé ; aucun changement de comportement à attendre |
| `claude-sonnet-5` | Bon sur cibles explicites ; plus faible sur décomposition ambiguë multi-projets et sur l'affectation fine des models | Nettement moindre | Meilleure | Éprouvé (TradeBot, jellyfin) | Non recommandé comme chef ; les économies portent sur la partie la moins chère du système |
| `claude-haiku-4-5` | Insuffisant pour décomposer/synthétiser ; ferait de bons « triages » mais ajouterait un saut | Minime | Excellente | Éprouvé | Non |
| `claude-fable-5-1` | Le plus fort en analyse/planification (rôle où le fleet l'emploie déjà : `CLAUDE.md:45`, cette tâche) | Le plus élevé, ×3 en pointe | La plus haute (raisonnement profond) sur des tours où l'utilisateur attend un accusé | Éprouvé comme musicien `orchestrateur` (35 événements) | **Pas comme chef** : la profondeur est mieux placée dans les musiciens de conception ; le chef gagne à rester rapide et décisif. À réserver en **escalade explicite** (voir ci-dessous) |
| `gpt-6-astra` / `gpt-5.6-sol` (codex) | Bons, mais famille différente | Séparé de l'abonnement Claude | Variable | `runCodex` est une branche de **failover** (`dispatch.mjs:656-1065`), sans parité `--resume`/session ni stampage d'attente | Non comme chef ; utile comme **second avis** musicien (déjà la doctrine `CLAUDE.md:51-64`) |

**Recommandation.**

1. **`conductorPool.model = "claude-opus-5"`** pour les trois slots. Justification : jugement de routage et qualité des prompts délégués (le levier de coût réel), fiabilité d'outillage déjà démontrée dans ce fleet, latence équivalente au chef actuel.
2. **Un seul model pour tout le pool, pas d'escalade par ticket.** Changer de model sur une session `--resume` casse le cache de prompt : un tour « économique » en Sonnet sur une longue session de chef rejoue tout le contexte au prix fort. Les économies attendues d'un mélange sont fictives, et l'UI devrait expliquer pourquoi le chef 3 « raisonne moins bien ». Homogène, donc.
3. **Escalade = délégation, pas changement de chef.** Quand un ticket exige de la conception (architecture, arbitrage transverse, revue), le chef **délègue à un musicien en Fable** (`--model claude-fable-5-1`) ou demande un second avis codex, exactement comme aujourd'hui. Le chef reste un routeur rapide ; la profondeur est achetée là où elle sert.
4. **Coût ×3** : c'est une pointe, pas une moyenne. Le pool ne multiplie pas le nombre de tours (un message = un tour de chef, avant comme après) ; il en multiplie la simultanéité. Surcoûts réels : amorçage à froid des slots 2-3 (lecture de `CLAUDE.md`, pas de cache) et registre de direction (≤ 1 500 caractères). L'affinité les minimise : tant que l'utilisateur ne sature pas le chef 1, la facture est celle d'aujourd'hui, Opus 5 mis à part. Garde-fou : `conductorPool.size` réglable à chaud (1 à 3) et budget de réveils global.
5. **Repli** : si l'utilisateur préfère ne rien changer au coût, `claude-opus-4-8` est un choix défendable ; passer à Opus 5 est alors un simple champ de config, sans redémarrage (`dispatch.mjs` relit `config.json` à chaque dispatch).

---

## 5. Plan d'implémentation priorisé (pour Opus 5)

Tout est additif sauf mention **[noyau]**. Vocabulaire d'états inchangé. Aucun `ANTHROPIC_API_KEY` ne circule (`spawnDirectDispatch` garde `ANTHROPIC_API_KEY:''`, `dispatch.mjs:581-592` scrubbe). Jamais de push. Chaque lot = bump + `CHANGELOG.md`.

### P0-A — La file devant un chef unique (serveur 0.22.0, web 0.22.0) — `conductorPool.size = 1`

Objectif : plus aucune interruption implicite, file visible, fondations du pool (tickets, ordonnanceur, API), sans encore ouvrir la concurrence. Livrable testable seul.

| # | Lot | Fichiers | Critère de réception |
|---|---|---|---|
| A1 | **[noyau] Ordonnanceur et file du pool** : `poolQueue` + sidecar `logs/queue/chef.pool.json` + journal `chef.pool-log.ndjson` ; `schedulePool()` (un seul point de spawn, ré-armé) ; états `QUEUED/ASSIGNED/RUNNING/DONE/FAILED/LOST/WITHDRAWN` ; requeue ×1 ; garde `readLimitedUntil` ; `POST /api/dispatch {project:'chef'}` enfile (sauf `!interrupt`/`force_interrupt`) ; `DELETE /api/pool/queue/:ticket` ; `POST /api/pool/interrupt/:slot` ; stampage `ticket` sur le `user_prompt` du chef ; `DISPATCH_SLOT`/`DISPATCH_TICKET` dans l'env | `server.js` (près de `:347-608`, `:3365-3602`), `scripts/dispatch.mjs` (`:628-650`) | Deux messages en 5 s ⇒ le second attend le `result` du premier, aucun `taskkill` ; `!interrupt` tue bien ; redémarrage serveur avec 2 tickets en file ⇒ 2 tickets rejoués dans l'ordre, une seule fois |
| A2 | **Réveil et relais via la file** : `tryFireWake` enfile un ticket `point` (classe servie après `user`/`decision`) ; `maybeDispatchChefQuestion` enfile un ticket `decision` ; `inFlight` par slot ; budget réveils global | `server.js:446-538`, `:2037-2053`, `:4030-4040` | Un réveil pendant un tour de chef ⇒ ticket `point` visible dans la file, tiré après ; jamais de double point |
| A3 | **`/api/pupitre.pool` + événement SSE `pool` + `/api/conductor-chat` avec `ticket`/`slot`/`answersTicket`/`queued`** | `server.js:1776-1801`, `:2246-2328`, `:2585-2591` | Rechargement ⇒ les statuts de file sont reconstruits ; `wake:true` restitué |
| A4 | **`dispatch.mjs --model/--provider`, `--queue-if-busy`, file par musicien portant `callback/source/model`, `spawnDirectDispatch` transmettant `--callback`** | `dispatch.mjs:115-173`, `:189-191`, `server.js:292-339`, `:549-608` | Un dispatch vers un musicien `live` ⇒ 202 file, puis lancement au `result` **avec** son callback ; aucun `claude` doublé sur une session |
| A5 | **UI web** : pastille(s) de slot dans l'en-tête (1 en A), ligne de statut sous les bulles utilisateur, bande « File de direction » repliée/dépliée, actions Retirer/Interrompre, composer « À : CHEFS (n libre) » + avertissement tous-occupés, pill « répond à », drapeau `_awaitingConductor` par slot | `public/salle.js` (`renderChefStatus :89-120`, nouveau `renderPoolBand`), `public/app.js` (`sendMessage :2752-2867`, `_armConductorWait :2292`, `onConductorEvent`), `public/index.html:30-37,61,85`, `salle.css` | Envoi pendant un tour ⇒ bulle avec « en file · position 1 », pas d'interruption ; « Retirer » restitue le brouillon ; pastille « répond… » sans PID ⇒ auto-guérison |
| A6 | **`I:\Dev\Chef\CLAUDE.md`** : remplacer la dance `config.json` par `--model` ; « ne relance pas un musicien occupé, `dispatch.mjs` met en file » ; « tu peux déléguer à `chef` une fois » ; « ne cible jamais `chef-N` » ; « le registre en tête de prompt vient du serveur » | `I:\Dev\Chef\CLAUDE.md:26-49,138-169` | Aucune écriture de `config.json` par un chef sur 20 tours observés |
| A7 | **Version + changelog** : `package.json` 0.22.0, `/api/version`, pied de page, cache-busting `?v=0.22.0`, entrée `CHANGELOG.md` (`Added` file/pool, `Changed` interruption explicite, `Fixed` callback perdu par `drainQueue`) | `package.json`, `CHANGELOG.md`, `public/index.html:12-16,267-272` | — |

### P0-B — Le pool de 3 (serveur 0.23.0, web 0.23.0) — `conductorPool.size = 3`

| # | Lot | Fichiers | Critère de réception |
|---|---|---|---|
| B1 | **[noyau] Slots** : `resolveProject` (alias `chef-2/3`) partagé ; sessions/PID/logs par slot ; `healOrphanedLogs` et watchers sur les slots ; affinité + épinglage + grâces ; `callbackSlot` stampé par `dispatch.mjs` ; walk-back du relais sur le log du slot ; `conductorPool.model` ; changement de conductor vide la file | `scripts/fleet-status-core.mjs:193`, `dispatch.mjs:176-203`, `server.js:264-277,674-676,2055-2089,4030-4091` | Trois messages en rafale ⇒ trois `system/init` sur `chef`, `chef-2`, `chef-3` ; un quatrième attend ; le point d'une mission lancée par `chef-2` arrive sur `chef-2` |
| B2 | **Registre de direction** (champ `registry` du `user_prompt`, ≤ 1 500 c.), injecté au changement de chef, aux délégations, aux points dé-épinglés | `server.js` (constructeur près de `buildWakePrompt :477-493`), `/api/conductor-chat` l'ignore | Le chef 2 cite correctement la mission en vol du chef 1 dans un scénario de test ; le fil ne montre jamais le registre |
| B3 | **Délégation chef → chef bornée** : cible `chef` depuis un chef ⇒ POST ticket `delegation` (`hop+1`), refus `hop ≥ 2` (exit 65 + `notification/delegation_refused`), refus des noms de slot, `DISPATCH_CHEF_HOP` hérité | `dispatch.mjs`, `server.js` | Chef 1 délègue ⇒ chef 3 prend ; chef 3 tente de déléguer ⇒ refus visible dans MISSIONS ; aucune boucle en 10 min de test |
| B4 | **UI web** : trois pastilles, motifs de liseré, `♛ⁿ`, ligne de délégation, « délégué par », « Confier à un autre chef », détail `#/c/n` (réutilise le volet), `#/reglages` : taille du pool et model | `salle.js`, `app.js` (`extractDispatches :464-488` pour la cible `chef`), `salle.css`, `index.html` | Trois réponses dans le désordre ⇒ chaque bulle porte « répond à » cliquable ; les slots n'apparaissent jamais dans le rail |
| B5 | **Version + changelog** 0.23.0 | — | — |

### P1 — Parité et robustesse (Android 0.7.0 / vc16, serveur 0.23.x)

| # | Lot |
|---|---|
| P1-1 | Android : `pool` dans `/api/pupitre`, `slot`/`ticket` dans le fil, `DirectionSheet`, badges de slot, statut sous bulle, actions Retirer/Confier ; `versionCode` +1 |
| P1-2 | Tableau `/pupitre` : section « Direction » (slots + file) ; `fleet-status.mjs` : ligne par slot et profondeur de file (les chefs supervisent avec cet outil) |
| P1-3 | Métriques du pool dans `instrumentation-report.mjs` : temps d'attente en file, taux d'affinité respectée, tickets perdus/requeués, délégations refusées |
| P1-4 | Reprise d'un ticket `LOST` avec extrait du dernier `tool_use` (comme `captureInterruptStateAsync :3176-3243`) |
| P1-5 | Accessibilité : `aria-live` sur la bande File, `aria-label` des pastilles, focus restitué après Retirer/Confier |

### Écarté

Un seul chef « superviseur » qui répartit aux deux autres (hiérarchie : ajoute un tour et un point de panne) ; sessions partagées entre slots (impossible avec `--resume`) ; priorité manuelle (« passer en tête ») en P0 ; slots hétérogènes en model ; pool > 3 ; auto-dispatch côté client ; nouvelle chaîne d'état (`queued`, `assigned` sont des attributs de ticket, pas des états de panneau).

---

## 6. Risques et garde-fous

| Risque | Gravité | Garde-fou |
|---|---|---|
| **Mémoire éclatée** : le chef 2 ignore ce que le chef 1 a promis | Élevée | Affinité (le chef 1 par défaut) ; registre de direction au changement de chef ; « répond à » et « délégué par » pour que l'utilisateur sache à qui il parle ; réponse à une question du chef N **épinglée** à N |
| **Deux chefs sur le même musicien** (double `--resume`, session corrompue) | Élevée | `dispatch.mjs --queue-if-busy` ⇒ file par musicien avec callback conservé ; le chef ne tue jamais un musicien (règle `CLAUDE.md`) |
| **Course d'écriture sur `config.json`** (dance set/revert × 3) | Élevée | `--model`/`--provider` ; interdiction d'écrire `config.json` depuis un chef (revue des `tool_use Edit` sur `config.json` en recette) |
| **Récursion chef → chef** | Moyenne | `hop ≤ 1` porté par l'env et le ticket ; `WAKE_MAX_GEN` hérité ; interdiction de cibler un slot ; refus journalisé et visible |
| **Ordre des réponses** | Moyenne | Fil chronologique + liens ; jamais de fusion ni de réordonnancement |
| **Redémarrage serveur en plein vol** | Moyenne | Sidecar atomique rehydraté avant tout dispatch ; `LOST` ⇒ requeue ×1 avec préfixe de reprise ; `healOrphanedLogs` sur les slots ; journal `pool-log` |
| **Coût de pointe ×3 et limite Claude** | Moyenne | Taille du pool 1..3 à chaud ; budget de réveils global ; ordonnanceur gelé sous `claude-limited.until` ; affinité qui garde un seul chef à faible tempo |
| **Un chef occupé indéfiniment** (stream gelé) bloque les tickets épinglés | Moyenne | Filet PID (`dispatchPidAlive`) ⇒ `LOST` après 60 s sans PID ; `kill-stalled.mjs` accepte `chef-N` ; action « Interrompre » depuis la pastille ; « Confier à un autre chef » |
| **Faux « pris par » / faux « répond »** | Faible | Statut piloté par le log du slot (`user_prompt{ticket}`, `system/init`), jamais par la réponse HTTP |
| **Volume de logs ×3** | Faible | Tails bornés (2 Mio par log) ; pas de rotation (hors périmètre, doctrine inchangée) |
| **Redémarrage du serveur lancé par deux chefs à la fois** | Faible | `restart-orchestrateur.mjs` est idempotent (kill du port puis relance) ; règle : seul un tour utilisateur (`hop 0`) peut le lancer |
| **Perte de l'interruption implicite** (habitude) | Faible | `!interrupt` conservé ; action « Interrompre le CHEF n » à un clic ; composer qui annonce la mise en file avant l'envoi |

Garde-fous de non-régression (repris du doc UI validé §9, complétés) : le drapeau 0.16.1 n'est armé que par un `user_prompt` sans source ou un `system/init` **du slot** ; aucun poll supplémentaire (0.17.0) ; panier et point inchangés dans leur moteur (0.18.0) ; Android garde son snapshot et son fil (0.19.0) ; seul le serveur réveille, l'UI n'affiche jamais un prompt `wake` ni un `registry` (0.20.0) ; `idle|live|think|input|error|unread` intacts partout ; token gate, argv tableau, aucun dispatch implicite côté client.

---

## 7. Scénarios de réception (à rejouer par Opus 5)

1. **Rafale** : quatre messages en 10 s ⇒ `chef`, `chef-2`, `chef-3` démarrent (trois `system/init`), le quatrième affiche « en file · position 1 · 3 chefs occupés », puis « pris par CHEF n » au premier `result`. Aucun `taskkill` dans `logs/traces.jsonl`.
2. **Tempo lent** : un message toutes les 3 minutes, chef 1 toujours libre ⇒ 100 % des tickets sur `chef`, `chef-2.jsonl` et `chef-3.jsonl` n'existent pas ; l'UI ressemble à 0.21.3 plus une pastille `○` par slot.
3. **Question du chef** : chef 2 termine par `NEEDS_USER_INPUT:` ; la réponse de l'utilisateur est épinglée à 2 ; si 2 est occupé, statut « attend le CHEF 2 (question posée par lui) » et « Confier à un autre chef » disponible.
4. **Point au bon endroit** : chef 2 dispatche vuBox `--callback chef` ; vuBox termine ⇒ ticket `point` épinglé à 2 ⇒ `CHEF 2 — POINT SUR LES RÉSULTATS` après les tickets utilisateur en attente ; grâce 90 s puis n'importe quel slot.
5. **Délégation** : chef 1 dispatche `chef` ⇒ ligne `♛ CHEF (pool) ⏳` puis `● prise par CHEF 3` ; bulle de chef 3 « délégué par CHEF 1 » ; chef 3 tente `dispatch.mjs chef` ⇒ refus, ligne `✕ délégation refusée`.
6. **Même musicien** : chef 1 et chef 2 dispatchent RemotePad à 5 s d'écart ⇒ un seul `claude` sur la session, second en file par musicien avec son callback, lancé au `result`.
7. **Interruption explicite** : `!interrupt Stop, change de plan` pendant un tour du chef 1 ⇒ `taskkill`, `result` synthétique gris, nouveau tour du chef 1 avec la note de reprise, ticket marqué `⚡ a interrompu le CHEF 1`.
8. **Redémarrage** : deux tickets en file, un en cours ⇒ après `restart-orchestrateur.mjs`, le ticket en cours est `LOST` puis requeué en tête avec `[REPRISE]`, les deux autres suivent, rien n'est rejoué deux fois.
9. **Limite Claude** : `claude-limited.until` actif ⇒ tickets visibles, ordonnanceur gelé, bandeau `⚡` ; à l'expiration, reprise dans l'ordre.
10. **Rechargement** : file, statuts sous les bulles, numéros de chef, « répond à », points, délégations reconstruits depuis `/api/conductor-chat` + `/api/pupitre.pool`.

*Rapport non committé — le chef décide. Aucun autre fichier touché.*
