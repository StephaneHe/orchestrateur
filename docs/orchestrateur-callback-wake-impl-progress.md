# Implémentation P0 « réveil sûr du chef sur callback attendu » — progression

Spec : `docs/orchestrateur-callback-wake-fable.md` § PLAN P0. Cible web **0.20.0**.
**Serveur 7777 NON redémarré par moi — le chef redéploie.** Vocabulaire d'états verrouillé.

## Lot 1 — Attente enregistrée — FAIT
- [x] `scripts/dispatch.mjs` : `callback:"<chef>"` stampé sur le `user_prompt` synthétique du tour (additif, vit dans le log du musicien → survit au redémarrage, lié au TOUR et non au projet).
- [x] `wakeGen` hérité de `DISPATCH_WAKE_GEN` stampé sur le même événement (profondeur de réveil portée par la donnée, pas devinée).
- [x] `server.js` `reduceMusician` : capture `expectCallback`/`wakeGen` sur le `user_prompt` d'ouverture **uniquement** (le `system/init` qui suit appartient au même tour et ne doit pas les effacer) ; **consommés au `result`** puis remis à zéro → un événement ultérieur sur le même log ne peut pas re-déclencher.
- Vérif : `--callback chef` ⇒ `{callback:"chef"}` ; sans flag ⇒ absent ; enfant d'un tour gen 1 ⇒ `{callback:"chef",wakeGen:1}` ; après consommation ⇒ `expectCallback=null`.

## Lot 2 — Tireur (le réveil) — FAIT
- [x] Panier serveur `wake.pending` + sidecar atomique `logs/queue/chef.wake.json` (même motif que `persistQueue`) + journal `logs/chef.wake-log.ndjson`.
- [x] Coalescence **10 s** après le dernier résultat, plafonnée à **90 s** depuis le premier du lot.
- [x] `tryFireWake()` = **point de tir unique** ; à chaque condition non remplie il **ré-arme** au lieu de forcer → rien n'est perdu, seulement différé.
- [x] Tir via `spawnDirectDispatch(chef, prompt, [], [], {source:'wake', wakeGen})` → `dispatch.mjs --resume` : le chef **retrouve sa session, donc sa promesse**.
- [x] Prompt `[CALLBACK_WAKE lot=n gen=k]` + une ligne par musicien (✓ / ✕ / ⇄, durée, coût, résumé) — le chef ne lit pas `chef.jsonl`, il faut lui **donner** le lot.
- [x] Accroché dans le watcher **après** `autoNotifyConductor` (la notification/carte reste écrite dans tous les cas ; le réveil ne décide que si le chef doit *parler*).

## Lot 3 — Provenance / génération (anti-boucle) — FAIT
- [x] `--source wake` ⇒ prompt sourcé ⇒ n'arme pas « le chef répond » (v0.16.1) et ne promeut pas l'état (v0.17.0) ; c'est `system/init` qui ouvre le tour.
- [x] `DISPATCH_WAKE_GEN` exporté à l'enfant ⇒ hérité par le Bash de l'agent ⇒ stampé par tout `dispatch.mjs` lancé depuis ce tour.
- [x] Watcher refuse `wakeGen >= WAKE_MAX_GEN (2)` : **utilisateur → réveil 1 → réveil 2 → STOP**, déterministe.
- [x] `spawnDirectDispatch` étendu de façon **additive** (5ᵉ paramètre optionnel) : les 3 appelants existants (drain de file, `@shortcut`, relais NEEDS_CHEF) sont inchangés ; argv reste un tableau (règle projet).

## Lot 4 — Contrat du chef — **À APPLIQUER PAR LE CHEF** (hors de mon périmètre)
`I:\Dev\Chef\CLAUDE.md` appartient au projet Chef : par la règle « toute action sur un projet passe par son claude dédié », je ne l'édite pas. **Texte exact à insérer** à la fin de la section « ### 2. Déléguer via `dispatch.mjs` » (~:149) :

```markdown
**Si tu promets un point à l'utilisateur, dispatche avec `--callback chef` et
TERMINE ton tour.**

    node I:\orchestrateur\scripts\dispatch.mjs <projectName> "<prompt>" --callback chef &

Le serveur enregistre l'attente, et quand le musicien rend son résultat il te
réveille **une seule fois** avec le lot complet — un prompt `[CALLBACK_WAKE
lot=n gen=k]` listant chaque musicien (✓ terminé / ✕ échec / ⇄ attend ta
décision), sa durée, son coût et sa conclusion. Tu n'as donc pas à rester à
tourner ni à promettre sans suite : finis ton tour, tu seras rappelé.

Sans `--callback chef`, personne ne te réveille : le résultat n'apparaîtra que
dans ta prochaine invocation par l'utilisateur.

**Dans un tour `[CALLBACK_WAKE]`** : fais le point (2–5 puces par musicien, ce
qu'il a EFFECTIVEMENT fait, questions restituées verbatim) et **ne redispatche
que si c'était prévu dans la demande initiale**. Un tour né d'un réveil ne peut
en déclencher qu'un seul de plus — au-delà, la chaîne est coupée et l'utilisateur
devra te relancer.
```

## Lot 5 — Client : le prompt `wake` n'est pas un message — FAIT
- [x] `public/app.js` : `source === "wake"` ⇒ **rien** dans le fil (ni carte, ni bulle, ni drapeau). La réponse du chef qui suit porte déjà « prend en compte : A ✓ · B ✕ » (acquis v0.18.0) — c'est **elle** qui explique pourquoi le chef parle sans qu'on lui ait écrit.
- [x] `/api/conductor-chat` saute le prompt `wake` ⇒ un rechargement ne le ressuscite pas en carte.
- [x] Android `FleetViewModel` : même garde (compilé, pas d'APK ce tour).
- Vérif headless : prompt `wake` ⇒ `chat.length=0`, non armé, pas de panier ; callback réel ⇒ toujours 1 carte ; séquence poussée complète ⇒ `results,conductor` + « prend en compte : A ».

## Garde-fous — tous vérifiés sur fixtures (`.tmp/wake-logic.mjs`, 20 assertions)
| Garde | Constante | Vérifié |
|---|---|---|
| Sélectivité : jamais `/api/notify`, `@`, synthétique, tour du chef, tour non attendu | — | `expectCallback === chef` + `!ev.synthetic` + `name !== chef` |
| `input` (question à l'UTILISATEUR) exclu du réveil | — | la bulle question saute déjà le panier ; un réveil ferait doublon |
| Coalescence : 1 tour par lot | 10 s / 90 s | 3 résultats ⇒ **1** spawn, `lot=3` |
| Anti-rentrance : 1 tir en vol | libéré au `result` du chef | pas de 2ᵉ spawn pendant le tour |
| Jamais d'interruption | PID chef vivant ⇒ diffère | vérifié (≠ `/api/dispatch` qui, lui, tue) |
| PID fantôme ⇒ on tire | `dispatchPidAlive === null` | vérifié |
| Débit | 60 s entre tirs, 6/heure | les deux bloquent |
| Pas sous limite Claude | `readLimitedUntil()` | diffère de 30 s |
| Annulation par l'utilisateur | prompt sans source au chef | panier vidé, rien ne part |
| Idempotence | clé `musicien:session:ts` | doublon ignoré |
| Redémarrage | sidecar + TTL 6 h + cap 20 | **1** rattrapage, items périmés jetés |
| Filet anti-blocage | 15 min sans `result` chef | `inFlight` relâché |
| Échec = réveil aussi | — | `newState==='error'` ⇒ ✕ dans le lot |

## Reste (P1, tour suivant)
- Réveil unique sur tour attendu **stallé / PID mort** (promesse rompue par un musicien qui ne finit jamais) et sur **clôture synthétique** (`error_interrupted`) ; sur `error_limited`, différer à l'expiration de `limitedUntil`.
- `/api/pupitre` : `expectCallback` par musicien + racine `pendingWake` / `lastWakeAt` → badge « ⏳ attendu par le chef » et bandeau « point en préparation (n) ».
- Compteur de budget visible (une saturation du plafond horaire = signal d'une boucle non prévue).
- Garde de liveness dans `spawnDirectDispatch` (bénéficie aussi au relais NEEDS_CHEF, défaut préexistant).
- Option : ligne système discrète « ⟲ le chef fait le point (n) » à la place du prompt `wake` masqué.
