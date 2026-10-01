# Contre-expertise chef figé — Anthropic Fable — 2026-09-18

Arbitrage indépendant de `docs/chef-stuck-analysis-astra.md` (GPT-6 Astra). Lecture seule : aucun code, version ou config modifié, serveur 7777 non redémarré. Seule écriture : ce fichier.

**Méthode et limites.** J'ai relu chaque zone de code citée (les numéros de ligne ci-dessous sont ceux que j'ai vérifiés dans l'arbre de travail, v0.16.0). Je n'ai **pas** rejoué la reproduction en VM d'Astra ni re-vérifié ses numéros de ligne dans `logs/chef.jsonl` (331 Mo) : mes verdicts reposent sur le code, pas sur ses séquences de log. État observé en lecture : `logs/no-failover` présent, `logs/claude-limited.until` absent, `logs/chef.pid` absent, dernier événement du chef = un `result`.

## Verdict global

**Le diagnostic d'Astra est juste et bien prouvé. Son plan est correct dans l'intention mais sur-dimensionné d'un facteur 5 à 10 pour un dashboard mono-utilisateur, mono-processus.** Le symptôme se tue avec ~15 lignes côté client, sans restart. Le reste est du renforcement, dont une bonne moitié est à écarter.

## Verdicts point par point

| # | Affirmation | Verdict | Preuve vérifiée |
|---|---|---|---|
| 1 | Cause racine : `/api/notify` append un `user_prompt` sans tour ; le client arme le drapeau sans condition ; effacé seulement par `result` ; pas de timeout | **CONFIRMÉ** | `server.js:2745-2769` : append `type:'user_prompt'` (+`source`), toast, `res.json` — aucun spawn. `public/app.js:1910-1911` : `_awaitingConductorResponse = true` exécuté pour **tout** `user_prompt` non vide, y compris la branche callback (`:1897-1904`) et même un callback dédupliqué. `:1582,1594-1595` : la pastille dépend du seul drapeau. `:1947-1949` : unique remise à `false`. 4 occurrences du drapeau au total (`:889,1582,1911,1949`) → aucun timeout. **Reproductible** trivialement : dashboard ouvert, chef au repos, `printf x \| node scripts/notify.mjs chef --stdin --source test`. Le callback de la présente tâche le reproduit lui-même. |
| 2 | Le raccourci `@musicien` est un second déclencheur | **CONFIRMÉ** | `server.js:3075-3081` : `user_prompt` synthétique `source: shortcut→<nom>` écrit dans le log chef, commenté « NOT a dispatched turn », puis dispatch du **musicien** (`:3096`). Aucun `result` ne suivra jamais dans le log chef. |
| 3 | v0.14.3 n'a traité que le callback AUTO | **CONFIRMÉ** | `server.js:2716-2743` : `autoNotifyConductor` écrit `notification/musician_done` puis s'arrête (commentaire ROOT FIX). `/api/notify` inchangé, drapeau client inchangé. La branche client `notification` retourne avant le drapeau (`app.js:1865-1877`) — c'est pourquoi l'auto est sain et le manuel non. |
| 4a | Reconnexion SSE ne réconcilie ni drapeau ni cartes | **CONFIRMÉ, impactant** | `app.js:802-812` : `onopen` → `loadChatHistory()` seul. `:1080-1113` remplace `this.chat`, ne touche pas au drapeau. Un `result` manqué pendant la coupure = pastille figée. |
| 4b | SSE agrégé saute à EOF au-delà de 4 Mio | **CONFIRMÉ, impact rare** | `server.js:2128-2152`. Le client ne traite ni `log_growth_skipped` ni `oversized_line_skipped` (0 occurrence dans `public/`). Perte d'un `result` possible mais il faut >4 Mio en un tick : rare. Couvert par le filet P0-b ci-dessous. |
| 4c | `healOrphanedLogs()` une seule fois au boot | **CONFIRMÉ, impact moyen** | `server.js:460-500`, appel unique `:500`. `dispatch.mjs` ne fabrique pas de `result` si l'enfant meurt sans en émettre (aucun `synthetic` côté claude). Un crash serveur-vivant reste donc ouvert jusqu'au prochain tour ou restart. |
| 4d | Watcher de fond alloue toute la croissance | **CONFIRMÉ, impactant** | `server.js:3710` : `Buffer.alloc(stat.size - fileState.offset)` sans plafond. **Nuance ajoutée** : c'est exactement la croissance que le pump SSE plafonne à 4 Mio à cause de l'incident OOM du 29 avril — la protection est donc incomplète : le watcher lit le même burst sans garde. |
| 4e | `/sse/logs/:project` lit depuis l'offset 0 | **CONFIRMÉ, mais NUANCÉ** | `server.js:3524,3537` : alloc de la taille entière (331 Mo pour chef), synchrone. **Nuance** : aucun appelant dans `public/`, `android/`, `scripts/`, `src/` — c'est une **route morte**. Donc pas un sujet d'architecture : on la supprime. |
| 5 | Divergence des reducers | **CONFIRMÉ** | `server.js:1458-1459` et `:2058-2059` : sortie de `idle/unread` seulement. `fleet-status-core.mjs:86-87` : aussi de `input`. Les trois partagent le défaut « tout `user_prompt` → `live` ». Unifier est sain mais **pas requis** pour le symptôme. |
| 6 | Quota non exploité, badge séparé | **CONFIRMÉ, pertinence faible** | 0 occurrence de `rate_limit_event` dans `server.js`, `app.js`, `dispatch.mjs`, `fleet-status-core.mjs`. Astra dit lui-même que le quota n'est pas la cause. Nice-to-have pur → P2. |
| 7 | 330 Mo ≠ cause ; rotation P2 | **CONFIRMÉ** | `server.js:1434-1443` : hydratation bornée à 256 Kio. D'accord : rotation **P2**. Mais 4d et 4e ne sont pas « de la rotation » : ce sont deux lectures non bornées, à traiter en P1 indépendamment. |

## Findings ajoutés (absents ou sous-pondérés chez Astra)

**F1 — Le kill-switch v0.16.0 crée un chemin « chef figé » DÉTERMINISTE (latent).** `scripts/dispatch.mjs:628-631` écrit le `user_prompt` au niveau module, **avant** la garde de démarrage (`~:1399-1403`) qui, si `logs/no-failover` existe et que le drapeau de limite est actif, écrit `system/limited-no-failover` puis `endLogAndExit(1)` — **sans `result`**. Chaque prompt envoyé au chef pendant une fenêtre limitée laisse donc un tour ouvert : pastille figée + carte `live`, précisément pendant le run de nuit que la sentinelle protège. Astra l'effleure (« sans garantir une clôture ») sans voir que c'est systématique à ce point d'entrée. État actuel : sentinelle **présente**, 0 occurrence de `limited-no-failover` dans `chef.jsonl` → pas encore déclenché, mais l'utilisation 5 h relevée par Astra est à 73 %. (Transparence : cette garde est mon propre changement du 2026-09-17, implémenté selon la spec reçue.)

**F2 — La route morte 4e est un tueur de serveur, pas juste un risque mémoire.** Une lecture synchrone de 331 Mo bloque la boucle d'événements plusieurs secondes ; or le watchdog `taskkill /F` un serveur simplement lent. Avec le token gate désactivé (`TOKEN_GATE_ENABLED=false`), un seul `GET /sse/logs/chef` depuis le LAN suffit. Correctif : supprimer la route.

**F3 — Le faux `live` côté serveur a un effet FONCTIONNEL, pas seulement cosmétique.** `musicianAutoStates` pilote la file du raccourci `@` (`server.js:3085-3094`) : un `/api/notify` vers le log d'un *musicien* le laisse `live`, et les messages `@` suivants sont mis en file sans limite de durée jusqu'à un `result`.

**F4 — `healOrphanedLogs` fabrique de faux « turn interrupted ».** Il teste `lastType !== 'result'` (`server.js:482`). Un callback ou une notification en dernière ligne ⇒ au prochain boot, un `result error_interrupted` synthétique est ajouté au log du chef. Effet de bord heureux (ça referme l'état), mais l'historique ment. Persiste même après conversion de `/api/notify` en `notification`.

**F5 — Cosmétique lié à #2** : le prompt du raccourci porte un `source`, donc `isLocalEcho` (`app.js:1889`, exige `!source`) échoue et le message de l'utilisateur est ré-affiché en bulle *callback* signée « shortcut→X ». Même correctif que P0-a.

## Verdict sur le plan d'Astra

| Item Astra | Verdict |
|---|---|
| P0 — convertir `/api/notify`, corriger le drapeau et les reducers, traiter `@` et les anciens callbacks à la lecture | **NUANCÉ.** Bon objectif, mauvais ordre. La conversion serveur exige un restart + compat Android + `/api/conductor-chat`. Le drapeau client seul tue le symptôme sans rien de tout ça. « Normaliser les anciens callbacks à la lecture » devient inutile avec la règle P1-a. |
| P0 — réconciliation autoritative, « dériver l'indicateur du tour réel » | **CONFIRMÉ dans l'intention, REJETÉ dans la forme.** Le signal autoritatif existe déjà : `/api/pupitre` expose `pid`/`pidAlive`/`silentMs` par projet (`fleet-status-core.mjs:189-214`) et le client le sonde toutes les 2,5 s (`app.js:2440`). Aucun modèle de tour à inventer. |
| P1 — clôture producteur + `turnId` + superviseur périodique | **Sur-ingénierie** (voir plus bas). On garde une seule chose : écrire un `result` synthétique là où on sort sans en avoir (F1). |
| P1 — quota structuré | **P2.** Sans lien avec le symptôme. |
| P1 — bornes de lecture / drainage paginé | **CONFIRMÉ**, et plus simple qu'annoncé : boucle par blocs de 4 Mio. |
| P2 — checkpoint + segmentation + pagination d'archives | **Sur-ingénierie**, et contraire au `CLAUDE.md` du projet (« Don't add log rotation — deferred », « No database »). |

Avertissement d'Astra à retenir : **ne pas** utiliser « `source` présent ⇒ pas de tour » comme discriminant brut — vérifié, `dispatch.mjs:630` pose `source` sur un tour réel lancé avec `--source`. D'où la règle « `system/init` = preuve de tour » ci-dessous.

## PLAN D'ACTION CONSOLIDÉ — minimal d'abord

### P0 — tue le symptôme (client seul, **aucun restart**, hard-reload)

**P0-a. Le drapeau ne s'arme que sur preuve de tour.** `public/app.js:1910-1911` : n'armer que si le `user_prompt` n'a **pas** de `source` ; ajouter l'armement sur `system`/`init` (tout vrai tour `claude -p` en émet un, y compris un dispatch `--source`). `result` continue de désarmer.
*Vérif (harness headless existant) :* `user_prompt{source}` → pas de pastille ; `shortcut→X` → pas de pastille ; `user_prompt` sans source → pastille ; `system/init` seul → pastille ; `result` → effacée ; 0 erreur console.

**P0-b. Filet de sécurité par liveness du PID.** Dans `pollPupitre` (`app.js:2456`, déjà 2,5 s) et à la réouverture SSE (`:808`) : si drapeau armé **et** ligne chef `pidAlive !== true` **et** armé depuis > ~20 s → désarmer et fermer la réflexion ouverte. Couvre d'un coup : `result` manqué (4a, 4b), dispatch tué ou planté (4c), échec de spawn, sortie no-failover (F1). Sens de la panne sûr : un PID recyclé laisse au pire l'état actuel.
*Vérif :* armer le drapeau à la main sans `.pid` → effacé en ≤ 25 s ; pendant un vrai tour (PID vivant, outil long silencieux) → reste armé.

**P0-c. Clore le tour dans la garde no-failover** (`scripts/dispatch.mjs`, garde de démarrage ; relu à chaque appel, **sans restart**) : écrire avant `endLogAndExit(1)` un `result` `{is_error:true, synthetic:true, subtype:'error_limited', result:'Claude limité jusqu'à …'}`. La convention existe déjà : `is_error && synthetic` → `idle` dans les trois reducers.
*Vérif :* `node --check` ; relecture ; avec sentinelle + drapeau de limite factice dans un dossier de logs de test, le log se termine par un `result`.

### P1 — renforcements utiles (un seul restart 7777, à grouper)

- **P1-a. Reducers : `user_prompt` avec `source` ne change pas l'état ; `system/init` continue de passer à `live`.** 4 sites : `server.js:1458`, `:2058`, `fleet-status-core.mjs:86`, `app.js:143-146`. Rétro-compatible avec les lignes déjà dans les logs → pas de normalisation à la lecture, pas de changement de format, pas d'impact Android. Corrige aussi F3. *Vérif :* rejouer `result → user_prompt{source}` → état inchangé ; `→ system/init` → `live`.
- **P1-b. Supprimer `/sse/logs/:project`** (`server.js:3508+`). *Vérif :* grep 0 appelant (déjà établi) ; 404 après restart.
- **P1-c. Borner le watcher** (`server.js:3710`) et remplacer le saut à EOF du pump (`:2136-2152`) par un drainage en blocs de 4 Mio. *Vérif :* append de 10 Mio contenant un `result` final → `result` reçu, RSS stable.
- **P1-d. `healOrphanedLogs` / `lastNonPartialType`** : ignorer `notification` et `user_prompt` sourcé comme « dernier type ». *Vérif :* log finissant par `result` puis callback → aucun synthétique au boot.
- **P1-e (optionnel).** `/api/notify` écrit `notification` quand `source` est présent. Devenu facultatif après P0-a + P1-a ; demande de vérifier `/api/conductor-chat` et l'app Android. À ne faire que si on veut un journal sémantiquement propre.

### P2 — nice-to-have
Badge quota séparé de l'activité ; factoriser les reducers serveur sur `fleet-status-core.mjs` (déjà un module ESM importable) ; rotation **hors-ligne au boot** (renommer un `.jsonl` > N Mo avant `healOrphanedLogs`, quand aucun writer n'existe — `restart-orchestrateur.mjs` tue tout l'arbre) : aucune coordination de handles nécessaire.

## Sur-ingénierie à écarter

- `turnId` + identité de propriétaire de processus + lease/heartbeat + superviseur périodique 10 s. Le sidecar `.pid` fournit déjà la liveness du producteur ; un seul utilisateur, un seul processus serveur, un tour à la fois par projet.
- Taxonomie `turn_finished / interrupted / failed / limited`. Le `result` synthétique (`synthetic:true`) joue déjà ce rôle et tous les reducers le comprennent.
- Clôture implicite via `message_stop` / `stop_reason`. Fragile, et inutile dès que P0-b existe.
- Checkpoint durable + générations + curseurs SSE + identifiants d'événements + segments verrouillés + pagination d'archives + pièces jointes référencées. Disproportionné, et contraire aux règles du projet.

## Commit

Ce rapport n'est **pas committé** : je laisse le chef décider (si oui, committer ce seul fichier, sans bump). Aucun autre fichier touché.
