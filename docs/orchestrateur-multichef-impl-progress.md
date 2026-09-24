# Pool de chefs — progression d'implémentation

Spec autoritaire : `docs/orchestrateur-multichef-queue-fable.md` (design Fable, 2026-09-24).

| Phase | Version | État | Date |
|---|---|---|---|
| **P0-A — la file devant un chef unique** | 0.22.0 | **FAIT** | 2026-09-24 |
| P0-B — le pool de 3 chefs | 0.23.0 | à faire | — |
| P1 — parité Android / robustesse | android 0.7.0 / serveur 0.23.x | à faire | — |

> **Serveur NON redémarré** par ce lot (règle : c'est le chef qui redémarre).
> Le code est committé en local, jamais poussé. Client : hard-reload
> (`?v=0.22.0` déjà en place sur les assets).

---

## P0-A — ce qui est fait (v0.22.0)

### A1 — [noyau] Ordonnanceur et file du pool ✅

`server.js`, bloc « File de direction » (juste après `drainQueue`).

- `logs/queue/chef.pool.json` — sidecar de file, écriture atomique tmp+rename
  (même recette que `persistQueue`). `logs/chef.pool-log.ndjson` — journal
  d'audit, une ligne par transition (sur le modèle de `chef.wake-log.ndjson`).
- Cycle de vie : `QUEUED → ASSIGNED → RUNNING → DONE|FAILED`, plus `LOST`
  (requeue **×1** en tête avec préfixe `[REPRISE] …`, `attempts = 2` ⇒ `FAILED`)
  et `WITHDRAWN`.
- `schedulePool(reason, delayMs)` — **seul point de spawn d'un tour de chef**.
  `delayMs = 0` passe de façon synchrone (l'appel HTTP peut donc répondre juste) ;
  un délai non nul ne fait que *rapprocher* le prochain passage, jamais le
  repousser. Filet périodique `POOL_RETRY_MS = 5 s` tant que la file n'est pas
  vide, car un slot peut se libérer sans qu'aucun événement ne nous réveille.
- Ordre : FIFO, avec **une** règle de classe en P0-A — un ticket `point`
  n'est pris que si aucun `user`/`decision` n'est prenable.
- Garde `readLimitedUntil()` : sous limite Claude, **rien** n'est spawné ; la
  file reste visible et l'ordonnanceur repasse toutes les 30 s.
- `poolReapLost()` : un slot assigné sans PID vivant depuis `POOL_LOST_MS = 60 s`
  a perdu son tour.
- `POST /api/dispatch {project:'chef'}` **enfile** (202 `{ticket, class, slot,
  position, poolSize, interrupting}`) sauf `!interrupt` / `force_interrupt`.
- `DELETE /api/pool/queue/:ticket` (rend le brouillon), `POST /api/pool/interrupt/:slot`.
- Stampage : `DISPATCH_TICKET` / `DISPATCH_SLOT` dans l'env du tour de chef ;
  `dispatch.mjs` les recopie sur le `user_prompt` (`ticket`, `slot`).

**Point d'ordonnancement subtil, à ne pas défaire** : `poolInterruptSlot(slot,
why, reschedule)` prend un troisième argument. La route `/api/dispatch` appelle
avec `reschedule = false` puis enfile le remplaçant en tête — sinon le slot
libéré serait immédiatement pris par le ticket qui patientait et le message qui
vient d'interrompre attendrait *derrière lui*. La route
`POST /api/pool/interrupt/:slot` (pas de remplaçant) garde `reschedule = true`.

### A2 — Réveil et relais via la file ✅

- `tryFireWake` n'appelle plus `spawnDirectDispatch` : il **enfile un ticket
  `point`** (`source:'wake'`, donc invisible dans le fil comme en 0.20.0). La
  garde « ne pas interrompre » (`dispatchPidAlive(chef)`) a été retirée : elle
  est devenue structurelle.
- `maybeDispatchChefQuestion` enfile un ticket `decision`. Dédupe inchangée.
- `wake.inFlight` appartient maintenant au **ticket** : relâché à la fin du tour
  de point, à son retrait, à sa perte ou à son éviction par débordement — plus
  sur n'importe quel `result` du chef.
- `cancelWakeOnUserPrompt` retire aussi les tickets `point` **encore en file**
  (un tour en cours n'est jamais tué).

### A3 — API additive ✅

- `/api/pupitre` → `pool: { size, model, slots[{slot,name,state,pidAlive,ticket,lastResultAt}], queue[…] }`.
  Les slots ne sont **pas** ajoutés à `fleet[]`. Aucun poll supplémentaire.
- SSE `{type:'pool', reason:'enqueued'|'assigned'|'started'|'done'|'withdrawn'|'lost'}`.
- `/api/conductor-chat` : `ticket`, `slot`, `queued`, `answersTicket` ; les
  tickets encore en file sont restitués en fin de fil (dédupés contre le log
  pour ne pas doubler un ticket perdu-puis-requeué).

### A4 — `dispatch.mjs` ✅

- `--model <id>`, `--provider claude|codex` : le flag gagne, sinon comportement
  historique. **`config.json` n'a plus à être écrit par un chef.**
- `--queue-if-busy` / `--no-queue-if-busy` ; actif par défaut quand
  `DISPATCH_SLOT` est défini. Cible occupée ⇒ `POST /api/dispatch
  {queueIfBusy:true}` ; serveur injoignable ⇒ ancien comportement + avertissement.
- File par musicien portant `callback` / `source` / `model` / `provider`, et
  `drainQueue` les transmet (**bug corrigé** : le callback était perdu).
- Refus (exit 65) d'un chef ciblant `chef` (délégation = P0-B) ou `chef-N`.

### A5 — UI web ✅

`public/salle.js` (`poolSnap`/`ticketStatusHtml`/`renderPoolBand`),
`public/app.js`, `public/salle.css`, `public/index.html` (`#poolband`).

- Ligne de statut sous chaque bulle utilisateur + actions.
- Bande « File de direction », repliée par défaut, **après** la bande
  d'attention, visible seulement si un ticket attend.
- En-tête : `· file n`. Composer : `À : CHEF (n libre)` + avertissement de mise
  en file **avant** l'envoi ; le libellé du bouton ne change pas.
- Pill « ↩ répond à … » (avec ancre) quand la bulle visée n'est pas juste
  au-dessus.
- Honnêteté respectée : pas de compte à rebours, « pris par » seulement au
  `user_prompt` stampé du slot, `null` (pas `0`) quand l'instantané manque.

### A7 — Version et changelog ✅

`package.json` 0.22.0 (⇒ `/api/version` et pied de page), `?v=0.22.0` sur les
assets, entrée `CHANGELOG.md` datée 2026-09-24, `TODO_LIST.md`.

### Recette

`node scripts/_test_pool_p0a.mjs` — **42 assertions, 0 échec**. Le harnais
charge le **bloc de code réel** du pool extrait de `server.js` dans un bac à
sable où `spawnDirectDispatch`, `dispatchPidAlive`, `readLimitedUntil` et les
sidecars sont doublés : ce qui est testé est le code livré, pas une
réimplémentation. Aucun `claude` lancé, aucun log de projet touché.

Scénarios couverts : rafale (le second attend, aucun tour tué, FIFO au
`result`) · ordre des classes (`decision` et `user` avant `point`) · verrou de
réveil porté par le ticket · limite Claude (file gelée puis reprise dans
l'ordre) · interruption explicite (tue, le remplaçant double la file, le
patient garde sa place) · redémarrage (`LOST` requeué **une** fois, jamais
deux) · « pris par » piloté par le log · retrait · taille bornée à 1 ·
`dispatch.mjs` (flags consommés, `--provider` validé, refus chef→chef et
chef-N).

---

## A6 — Contrat du chef : TEXTE EXACT À APPLIQUER

⚠️ **`I:\Dev\Chef\CLAUDE.md` est hors de mon périmètre — c'est au chef de
l'appliquer.** En attendant, `dispatch.mjs` reste **rétro-compatible** : la
« dance » `config.json` continue de fonctionner tant que le flag n'est pas
utilisé, donc rien ne bloque.

### 1) Remplacer le paragraphe « Mécanisme » (`CLAUDE.md:28-37`)

Le texte actuel commence par « Mécanisme : `dispatch.mjs` lit le model via
`project.model || defaults.model` à CHAQUE dispatch… » et se termine par « …
et que les dispatches suivants repartent propres. Choix des models : ».
Le remplacer par :

> Mécanisme : `dispatch.mjs` accepte **`--model <id>`** à chaque dispatch.
> Pour une tâche : `node I:\orchestrateur\scripts\dispatch.mjs <projet>
> "<prompt>" --model <id> [--callback chef]`. **N'écris JAMAIS `config.json`**
> — ni pour le model, ni pour le provider, ni pour quoi que ce soit d'autre :
> plusieurs chefs peuvent tourner en même temps et la dernière écriture
> écraserait les autres. Sans `--model`, le projet retombe sur son défaut
> (`project.model || defaults.model`), ce qui reste le bon réflexe quand le
> défaut convient. Choix des models :

### 2) Remplacer le paragraphe « Models OpenAI (via codex) » (`CLAUDE.md:50-53`)

Le texte actuel dit « mets `"provider": "codex"` sur l'entrée du projet dans
`config.json` (+ optionnellement `"codexModel": "<id>"`), même logique
set→dispatch→revert que pour `model`. » Le remplacer par :

> passe **`--provider codex`** à `dispatch.mjs` (le `codexModel` du projet ou le
> défaut du poste s'applique). Là non plus, **aucune écriture de
> `config.json`**.

### 3) Ajouter, dans la section dispatch (près de `CLAUDE.md:138-169`)

> **Ne relance jamais un musicien occupé.** Si sa ligne dit « en cours »,
> dispatche quand même : `dispatch.mjs` détecte son tour en vol et **met ta
> demande en file derrière lui** (il te répond « mis en file derrière lui
> (position n) »). N'utilise pas `!interrupt` sur un musicien pour « passer
> devant » — tu perdrais son travail en cours.
>
> **Ton propre tour n'est plus jamais interrompu par un message.** Quand
> l'utilisateur écrit pendant que tu travailles, son message entre dans la
> **file de direction** et t'arrivera au tour suivant. Termine proprement ce
> que tu fais : rien ne se perd. Seul un `!interrupt` explicite de
> l'utilisateur tue un tour ; dans ce cas tu reçois le message directement,
> sans note de reprise.
>
> **Ne délègue pas à `chef`** et **ne cible jamais `chef-2` / `chef-3`** :
> `dispatch.mjs` refuse (exit 65). La délégation chef → chef arrive en P0-B.

---

## Ce qui reste — P0-B (le pool de 3, v0.23.0)

Repères posés en P0-A pour que B1 soit surtout du câblage :

- `POOL_MAX_SIZE = 1` (server.js) — **c'est la seule borne à relever** pour
  ouvrir la concurrence, `poolSize()` lit déjà `config.conductorPool.size`.
- `poolSlotName(slot)` renvoie déjà `chef` / `chef-2` / `chef-3` ; le slot 1
  **est** le chef actuel (aucun renommage, aucune migration de session).
- Les tickets portent déjà `pinnedSlot`, `affinitySlot`, `hop` — jamais lus
  au-delà de `pinnedSlot` en P0-A.
- `dispatch.mjs` stampe déjà `callbackSlot`/`callbackTicket` sur le
  `user_prompt` des musiciens : c'est ce qui fera revenir le point au bon chef.
- `poolSnapshot()` est la seule source du `pool` exposé ; ajouter `affinity`,
  les grâces et les trois pastilles n'y change pas le schéma.

Restent à écrire :

| # | Lot | Notes |
|---|---|---|
| B1 | `resolveProject` partagé (`scripts/fleet-status-core.mjs`) reconnaissant `^<conductor>-([2-3])$` ; sessions/PID/logs par slot ; `healOrphanedLogs` et watchers sur les slots ; affinité + épinglage + grâces (`WAKE_LOT_MAX_MS` pour un point dé-épinglé) ; walk-back du relais `NEEDS_CHEF_INPUT` sur le log **du slot** ; `conductorPool.model` réellement passé en `--model` ; `POST /api/conductor` vide la file | `config.json` devra recevoir `"conductorPool": { "size": 3, "model": "claude-opus-5" }` — **non ajouté en P0-A** (la clé absente vaut `size: 1`) |
| B2 | Registre de direction : champ `registry` du `user_prompt` (≤ 1 500 c.), injecté au changement de chef / délégation / point dé-épinglé ; `/api/conductor-chat` l'ignore | construire près de `buildWakePrompt` |
| B3 | Délégation chef → chef bornée (`hop ≤ 1`, refus exit 65 + `notification/delegation_refused`) | le refus P0-A est déjà en place, il devient conditionnel à `hop` |
| B4 | UI : trois pastilles, motifs de liseré `┃`/`┇`/`┋`, `♛ⁿ`, ligne de délégation, « délégué par », « Confier à un autre chef », détail `#/c/n`, réglages du pool | `renderPoolBand` et `ticketStatusHtml` sont déjà paramétrés par slot |
| B5 | Version + changelog 0.23.0 | — |

## Ce qui reste — P1

P1-1 Android (`pool` dans `/api/pupitre`, `slot`/`ticket` dans le fil,
`DirectionSheet`, `versionCode` +1) · P1-2 `/pupitre` section « Direction » et
`fleet-status.mjs` (profondeur de file) · P1-3 métriques de file dans
`instrumentation-report.mjs` · P1-4 reprise d'un ticket `LOST` avec extrait du
dernier `tool_use` · P1-5 accessibilité (`aria-live` sur la bande, `aria-label`
des pastilles, focus restitué après Retirer).

## Garde-fous de non-régression vérifiés

Vocabulaire d'états `idle|live|think|input|error|unread` intact (aucune chaîne
d'état ajoutée : `QUEUED`/`ASSIGNED` sont des attributs de **ticket**) ·
réveil-sur-callback 0.20.0 conservé (un seul point de tir, budget, dédupe,
`gen ≤ 2`) · panier 0.18.0 inchangé · drill-down / volet routé 0.21.x
inchangés · aucun poll supplémentaire · token gate, argv tableau, aucun
`ANTHROPIC_API_KEY` transmis.
