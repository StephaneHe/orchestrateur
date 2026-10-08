# Plan — Faire passer toute entrée par les pipelines de la page Models

> Demande de l'utilisateur (2026-10-08) : « Il faut que toute entree dans
> l'orchestrateur passe par les pipelines decides dans la page Models, est-ce
> deja le cas ? Pour que chaque etape soit effectivement encadree par le bon
> modele. »
>
> **Réponse courte : non.** En 0.40.0, `model-routing.json` est seulement
> enregistré. Chaque dispatch reste **un seul tour `claude -p` (ou codex) sur
> un seul model**, choisi par `--model`, puis par le défaut du projet, puis par
> la flotte. Aucun pipeline, aucune étape, aucun contrôle de sortie.
>
> Ce document est un **plan**. Version de référence : 0.40.1. La **phase 1
> (observation)** est livrée en **0.41.0** : chaque entrée est classée et
> journalisée, sans changement de comportement (voir §5).

---

## Décisions du 2026-10-08

Réponses de l'utilisateur aux 9 questions du §6, avec l'interprétation du chef :

| # | Question | Décision |
|---|---|---|
| 1 | Aucune exception ? | **Aucune.** « Le terminal interactif peut aussi bien être une discussion qu'une instruction pour un développement. Il faut que ça passe dans le routeur aussi. Si aucune classification possible, alors considère une discussion. » Une sortie d'urgence `--hors-pipeline "raison"`, **tracée et visible**, reste possible pour la maintenance de la flotte. |
| 2 | Case non affectée | **Défaut du projet, avec un avertissement visible** (§3.2). |
| 3 | Défaut quand la classification hésite | **Discussion** : inclassable = Discussion. |
| 4 | TDD | **Un test à la fois.** Le parallèle viendra peut-être plus tard. |
| 5 | Limites | **D'accord** (3 essais de 4b, 2 revues, 15 items, 90 min), **et prévenir quand quelque chose arrive à cause d'une limite** (§2.5). |
| 6 | Projet pilote | Un projet de test **dédié** : **`pipelineLab`** (`I:\Dev\pipelineLab`), créé en 0.41.0 avec `new-project.mjs`. Il a des tests rapides (`npm test`, moins d'une seconde), une version visible, un CHANGELOG, un registre USER_REQUIREMENTS et un `.orchestrateur/pipeline.json`. |
| 7 | NVIDIA / OpenRouter | « **Tous les models doivent pouvoir agir de manière identique.** NVIDIA et OpenRouter aussi doivent pouvoir avoir un outillage. » Ils ne sont **pas** retirés de la page Models. Ils sont marqués « 🔧 outillage en construction », et le serveur **refuse leur affectation à une étape d'action** (409) tant que l'outillage n'est pas livré (§2.7, phase 2). |
| 8 | Model indisponible | **Pause.** |
| 9 | Latence du Développement complet | *En attente* : l'utilisateur a demandé ce qu'est le mode léger et pourquoi la latence serait 3 à 5 fois plus longue. Le chef lui répond. |

---

## 0. Constats mesurés avant de planifier

| Constat | Mesure | Conséquence |
|---|---|---|
| Reprendre la **même session** avec un **autre model** fonctionne | Essai réel du 2026-10-08 : tour 1 en `claude-haiku-4-5` (« retiens PAPILLON-42 »), puis `--resume <même sid> --model claude-sonnet-5`. Résultat : même `session_id`, `system/init.model = claude-sonnet-5`, `assistant.message.model = claude-sonnet-5`, réponse « PAPILLON-42 » | Le contexte peut passer d'une étape Claude à l'autre sans fichier intermédiaire |
| …mais changer de model **casse le cache de prompt** | Tour 2 : `cache_creation_input_tokens = 59 240` pour une question triviale (0,28 $ en équivalent API, contre 0,05 $ pour le tour 1) | Alterner les models à chaque étape coûte une réécriture du contexte à chaque bascule. Il faut regrouper les étapes qui partagent le même model |
| Durée réelle d'un tour de musicien | 358 tours récents : médiane **3 min**, 90ᵉ percentile **15 min**, médiane de 11 tours d'outils internes. Chef : médiane **21 s** | Base des estimations de latence (§4) |
| Coût réel | `total_cost_usd` est cumulé sur la session (environ 200 $ affichés pour le chef) et l'abonnement ne facture pas à l'unité | Les coûts sont exprimés en **tours** et en **minutes** (consommation du quota), le $ seulement à titre indicatif |
| **NVIDIA et OpenRouter n'ont pas de harnais d'agent** | Le failover NVIDIA n'appelle que `chat/completions` (en-tête de `dispatch.mjs`) ; aucune voie OpenRouter n'existe ; codex n'accepte plus `wire_api = "chat"` | Ces models peuvent produire du texte (revue, second avis, synthèse) mais **ne peuvent ni lire ni modifier les fichiers** d'un projet. La page Models les propose aujourd'hui pour des étapes de code, ce qui est trompeur (§2.6) |
| Un musicien peut lancer `dispatch.mjs` | Rien n'empêche un tour de musicien d'exécuter `node scripts/dispatch.mjs autreProjet …` (seuls les tours de réveil « rapport seul » du chef sont refusés) | Une règle de prompt ne suffit pas : il faut un **jeton d'étape** délivré par le serveur (§3.3) |

---

## 1. Tous les points d'entrée et leur rattachement à un pipeline

Inventaire fait dans le code (`server.js`, `scripts/`, app Android, `ssh-server.js`).

### 1.1 Entrées qui lancent un tour de LLM

| # | Point d'entrée | Chemin actuel | Rattachement proposé |
|---|---|---|---|
| E1 | **Composer du dashboard → chef** | `POST /api/dispatch {project: chef}` → ticket du pool → `spawnDirectDispatch(chef)` | Le tour du chef **est** l'exécution du pipeline **Routage**. Il tourne sur le model de la case `routage.classifier`. Il sort une décision structurée (`pipeline`, `léger/complet`, projets) puis dispatche avec `--pipeline` |
| E2 | **Composer → musicien directement** (`@musicien …`) | Raccourci de `/api/dispatch` : contourne le chef | Sélecteur de pipeline dans le composer, sur trois positions : *Auto* (défaut), *pipeline choisi*, *léger*. En mode *Auto*, une **classification serveur** courte tourne sur le model de `routage.classifier`, sans outils, avant le dispatch |
| E3 | **App Android** (`Api.kt` → `/api/dispatch`) | Comme E1 et E2 | Même règle côté serveur, donc rien ne contourne. Ensuite, un sélecteur de pipeline dans l'app (phase 3) |
| E4 | **`dispatch.mjs` lancé par le chef** (son outil Bash) | Spawn direct de `claude -p` | Il devient un **client** : il demande au serveur d'ouvrir une **exécution** (`POST /api/runs`) avec `--pipeline <id> [--light]`. Sans `--pipeline`, refus (exit 64) une fois le pipeline mis en service |
| E5 | **`dispatch.mjs` lancé à la main** (humain, script, tâche planifiée) | Idem | Même règle. Seule échappatoire : `--hors-pipeline "<raison>"`, journalisée, visible dans le dashboard (« hors pipeline : raison »). Question Q1 |
| E6 | **Musicien qui lance `dispatch.mjs`** (Bash dans son tour) | Possible aujourd'hui | **Refusé** : seul un processus muni d'un jeton d'étape valide peut lancer `claude` ou codex. Un musicien n'a pas de jeton de dispatch, et le CLI le refuse |
| E7 | **File par musicien** (`drainQueue`, balayage de 30 s) | `spawnDirectDispatch` avec l'entrée de file | L'entrée de file porte `run`/`step`. Le drain **reprend l'exécution** à son étape, jamais un tour libre |
| E8 | **Pool du chef** (`poolSchedule`, tickets) | `spawnDirectDispatch(chef)` | Comme E1 : tout ticket est une exécution Routage |
| E9 | **Réveil du chef** (callback `musician_done`, `wake`) | Tour du chef `source: wake` | Étapes **Callback / Superviser / Rapporter** du pipeline Routage de l'exécution d'origine, sur leurs cases (`routage.callback`, `routage.rapporter`) |
| E10 | **Relais `NEEDS_CHEF_INPUT`** musicien ↔ chef | `[NEEDS_CHEF_INPUT_FROM:x]` → chef → `[CHEF_ANSWER]` → musicien | La question vient d'une étape d'exécution. La réponse **reprend la même étape, sur le même model** : ce n'est pas une nouvelle entrée |
| E11 | **`notify.mjs`** (musicien → chef, information) | `POST /api/notify` → log du chef, réveil éventuel | Comme E9 : l'étape Callback du pipeline Routage |
| E12 | **`POST /api/projects/:name/sessions/new`** | Spawn **direct** de `dispatch.mjs` (en dehors de `spawnDirectDispatch`) | Rebranché sur la même porte que E2. Sans pipeline, refus |
| E13 | **Terminal central** `/ws/pty` (`claude.exe` interactif) | `pty.spawn('claude.exe')`, aucun dispatch | **Routé, comme le reste** (décision n° 1). Chaque ligne validée est classée ; c'est déjà le cas en observation depuis 0.41.0. En service, la session devient une **Discussion** en lecture seule, et une ligne classée comme action est confirmée puis lancée en exécution du bon pipeline. Inclassable = Discussion |
| E14 | **Failover et repli codex** dans `dispatch.mjs` | Bascule automatique sous limite Claude | Inchangé pour les cases non affectées. Pour une case affectée, le model est explicite : **aucun repli** (§3.2) |

### 1.2 Entrées qui ne lancent pas de tour (aucun rattachement)

| Entrée | Pourquoi aucun pipeline |
|---|---|
| `POST /api/question/:p/resolve`, `/api/ack/:p`, `/api/mark-read`, `/api/project/:p/denials/ack` | Écritures d'état dans le log, sans LLM |
| `kill-stalled.mjs`, `queue.mjs`, `resolve-question.mjs`, `fleet-status.mjs` | Outils de supervision, sans LLM |
| `POST /api/projects` (création de projet), `add-tool`, `/api/config/provider` | Configuration. Le premier dispatch d'un nouveau projet déclenche le pipeline **Nouveau projet** |
| SSH (`ssh-server.js`) | SFTP seulement : `shell`, `exec` et `pty` sont refusés |
| `PUT /api/model-routing/:slot` | C'est la configuration des pipelines elle-même |

### 1.3 Classification : qui, sur quel model, avec quel défaut

- **Qui** : le chef pour E1, E3, E8 (c'est son métier). Une **classification serveur** courte pour les entrées directes E2, E3 (musicien direct) et E12.
- **Sur quel model** : celui de la case **`routage.classifier`** (Haiku suffit sans doute ; c'est l'utilisateur qui décide dans la page Models).
- **Sortie imposée** : un JSON validé par le serveur, `{pipeline, mode: "leger"|"complet", raison, projets[]}`. S'il est invalide : une nouvelle tentative, puis le pipeline par défaut.
- **Choix explicite** : il l'emporte toujours. Il passe par le sélecteur du composer ou de l'app, `--pipeline` sur `dispatch.mjs`, ou un préfixe du message (`/dev`, `/incident`, `/léger`, `/complet`…).
- **En phase 1 (observation, 0.41.0)** : un classifieur **à règles** (`scripts/pipeline-observe.mjs`, `règles-v1`) classe toutes les entrées, sans coût ni latence. Il a été calé sur les vraies demandes du fleet. La classification par model ne remplacera ces règles qu'à la mise en service, après comparaison avec ce journal.
- **Pipeline par défaut** quand rien n'est décidé : **Discussion** (lecture seule). Une demande mal classée ne modifie donc jamais rien. Q3.

---

## 2. Exécution étape par étape

### 2.1 Mécanisme retenu : un moteur d'exécution côté serveur

- **Une exécution** (« run ») = un pipeline appliqué à une demande sur un projet.
  - État persistant dans `logs/runs/<runId>.json` : pipeline, mode, étape courante, item de la liste de tests, compteurs, artefacts, model de chaque étape.
  - Le fichier est append-only pour l'historique, et l'état est réécrit en temp + rename.
- **Une étape = un tour séparé** (`claude -p` ou `codex exec`), toujours lancé avec **`--model <model de la case>`**.
  - Le moteur choisit la case la plus précise : variante, puis étape.
  - Une case vide hérite du défaut du projet (§3.2).
- **Artefacts de passation** dans le projet, sous `.orchestrateur/runs/<runId>/` (gitignoré dans chaque projet) :
  - `demande.md`, `comprehension.md`, `plan.md`, `tests.md` (la liste à cocher) ;
  - `revue.json`, `rapport-<étape>.md`.

  Chaque étape lit les artefacts précédents et écrit le sien. Le moteur **vérifie** leur présence et leur forme.

### 2.2 Les trois mécanismes comparés

| Mécanisme | Pour | Contre | Verdict |
|---|---|---|---|
| **`--resume` de la même session, `--model` différent** | Vérifié : ça marche. Contexte complet, rien à resservir | Le cache est cassé à chaque bascule (≈ 59 k tokens réécrits, mesuré). Claude seulement. La session de travail grossit sans fin. L'indépendance de 4a et 4b est faible, puisque le second voit tout le raisonnement du premier | **Optimisation** : on reprend la session **seulement entre étapes consécutives sur le même model** (par exemple 4b → 4c en Sonnet) |
| **Passation par artefacts** (session neuve par étape ou par model) | Marche entre Claude, codex, NVIDIA et OpenRouter. Contextes courts. Indépendance réelle des preuves. Contrôlable par le code. Rejouable | Chaque étape relit le code utile. `comprehension.md` et `plan.md` limitent ce coût | **Contrat de base, obligatoire partout** (et indispensable entre Claude et codex, qui n'ont pas de session commune) |
| **Sous-agents** (outil `Agent` dans un tour) | Rien à orchestrer côté serveur | Le model du sous-agent n'est pas imposable ni vérifiable de l'extérieur, rien n'est tracé dans les logs de la flotte, et les sous-agents natifs ont été rejetés par le brief | **Écarté** |

**Sessions** : une session **par exécution et par model** (`logs/runs/<runId>/<model>.session`). La session de travail du musicien (`logs/<p>.session`) n'est pas touchée : l'historique de travail habituel reste propre.

### 2.3 La boucle TDD (4a → 4b → 4c, un test à la fois) sans exploser coût et latence

1. **3 Liste de tests** produit `tests.md` : des cases `- [ ]`, une par comportement, avec des critères d'acceptation et aucune décision d'implémentation.
2. Pour chaque item non coché, dans l'ordre :
   - **4a Rouge** : session « tests » (model de 4a), prompt minimal. Il contient l'item, `tests.md`, les chemins des tests existants, et rien de l'implémentation en cours.
   - **4b Vert** : session « code » (model de 4b). Il reçoit le test qui échoue et sa sortie d'échec, puis écrit le code minimal.
   - **4c Refactor** : même session que 4b si le model est le même, donc aucun cache cassé. L'étape est **sautée automatiquement** si 4b a touché moins de N lignes, ou si le model répond `RIEN_À_REFACTORER`.
   - Le moteur coche l'item et passe au suivant.
3. **Leviers de coût** :
   - Deux sessions longues par exécution (« tests » et « code »), reprises d'un item à l'autre. Le cache tient tant que le model ne change pas **dans** une session.
   - Le prompt de chaque item est court (l'item et la sortie du test), plutôt qu'un contexte complet.
   - Une **commande de test rapide** (`fastTestCommand`) dans la boucle, et la **suite complète** imposée avant de quitter 4b sur le dernier item, puis avant 5.
   - Les items triviaux peuvent être regroupés (option « lot », Q4). Par défaut : un à la fois, comme le canon.

### 2.4 Critères de sortie vérifiés par le code

Le moteur exécute lui-même les commandes du projet. Elles sont décrites dans un fichier **versionné dans le projet**, `.orchestrateur/pipeline.json`, et non dans config.json :

    { "testCommand": "npm test", "fastTestCommand": "node --test test/unit",
      "testGlobs": ["test/**", "**/*.test.*", "scripts/_test_*.mjs"],
      "buildCommand": "gradlew assembleDebug", "versionFiles": ["package.json"] }

Un détecteur propose ces valeurs (package.json, gradle, pyproject, `regression.mjs`…). L'utilisateur ou le musicien les valide une fois.

| Étape | Critère vérifié par le moteur (pas déclaré par le model) |
|---|---|
| 1 Comprendre | `comprehension.md` existe, n'est pas vide, et chaque chemin cité existe. Aucun fichier du projet modifié (`git status` inchangé hors `.orchestrateur/`) |
| 2 Concevoir | `plan.md` avec les sections attendues. Aucune modification du code |
| S Spike | Exploration dans une branche ou un dossier jetable, **annulée** par le moteur à la sortie (`git stash` / `git checkout`), puis retour à 3 |
| 3 Liste de tests | `tests.md` contient au moins une case `- [ ]`. Aucune modification du code |
| **4a Rouge** | Le diff ne touche **que** des fichiers de `testGlobs`. La suite passait avant cette étape. **La commande de test échoue maintenant**, et l'échec cite le test ajouté. Variante Bugfix : idem, avec le bug reproduit |
| **4b Vert** | Les fichiers de test sont **identiques** à la fin de 4a (empreinte), pour qu'un model ne puisse pas affaiblir le test. La **suite complète passe** (code 0) |
| 4c Refactor | Tests inchangés, suite complète verte |
| 5 Revue | `revue.json` valide `{verdict: "ok"|"problèmes", items[]}`. Chaque problème devient une case `- [ ]` dans `tests.md`, puis retour à 4 |
| 6 Livrer | Commit créé (HEAD a changé), arbre propre. Version incrémentée dans `versionFiles` **et** entrée CHANGELOG `## [X.Y.Z]` (règles de flotte). `buildCommand` réussit s'il est défini. Le push reste soumis à l'autorisation existante |
| 7 Documenter | Entrée CHANGELOG et ligne `docs/USER_REQUIREMENTS.md` pour une demande de fonctionnalité (règle 0.36.0), vérifiées par le même contrôle que `_test_user_requirements` |
| Autres pipelines | Même principe : un artefact attendu, et une commande ou une vérification déterministe quand elle existe. Exemples : Audit → les scans passent ; Vidéo → `ffprobe` (durée, pistes) ; Audio → WER si une référence existe |

### 2.5 Limites et escalade

| Limite (proposition, Q5) | Valeur |
|---|---|
| Essais de 4b pour un même test | 3. Chaque essai reçoit la sortie d'échec précédente |
| Échecs du critère de 4a (le test passe déjà, ou touche du code) | 2 |
| Tours de revue (5 → 4) | 2 |
| Items dans une exécution | 15. Au-delà, on découpe en plusieurs exécutions |
| Durée totale d'une exécution | 90 min, ou plafond par pipeline |

Une limite atteinte met **l'exécution en pause** dans l'état `input`, le vocabulaire existant. La question est claire : « 4b a échoué 3 fois sur l'item "…" (sortie jointe). Continuer, simplifier l'item, changer le model de 4b, abandonner ? ».

**Prévenir explicitement (décision n° 5).** Toute limite atteinte (essais, revues, items, durée) produit en même temps :

1. Un événement **`notification/pipeline_limit`** dans le log du musicien : limite, valeur, exécution, étape, item, dernière sortie. Tous les réducteurs le lisent, comme `question_resolved`.
2. Un **message dans le dashboard** : une ligne dans la bande d'attention, « ⏸ Limite atteinte — <projet> · <pipeline> · <étape> : 3 essais de 4b sans passer », avec les boutons de la question. Le cadre du musicien et la frise de l'exécution affichent la même chose.
3. Une **notification au chef** (`/api/notify`, source `pipeline-limit`). Il la relaie à l'utilisateur en nommant le projet et l'exécution.
4. Une notification de bureau, comme pour les autres alertes.

Une exécution n'est **jamais** arrêtée ou relancée en silence à cause d'une limite. Un test vérifie, pour chaque limite, que les quatre signaux partent.

On ne change **jamais** de model en silence : les models affectés sont explicites (§3.2).

### 2.6 Prérequis : distinguer « agent » et « chat »

La page Models doit distinguer deux capacités :

- **`agent`** : un harnais qui lit et écrit les fichiers. C'est le cas de la CLI claude et de codex.
- **`chat`** : du texte seulement, produit à partir d'un contexte fourni par le moteur. C'est le cas de NVIDIA et OpenRouter aujourd'hui.

Les étapes qui modifient le projet (4a, 4b, 4c, Livrer, Corriger…) exigent `agent`. Les étapes de jugement (Revue, Second avis, Classifier, Synthèse) acceptent `chat`. Le moteur leur sert alors le diff ou les artefacts, et écrit lui-même leur réponse dans l'artefact.

**Fait en 0.41.0** :

- Chaque étape « texte » est marquée **action** ou **jugement** (`JUDGE_STEPS` dans `scripts/model-pipelines.mjs`).
- NVIDIA et OpenRouter restent dans tous les menus. Sur une étape d'action, leur groupe est grisé « 🔧 outillage en construction ».
- Le serveur refuse ces affectations (409) tant que `AGENT_HARNESS` (`scripts/model-routing.mjs`) ne les déclare pas outillés.
- Sur une étape de jugement, ils sont proposés normalement.

### 2.7 Outillage NVIDIA / OpenRouter (décision n° 7)

**Objectif** : que NVIDIA et OpenRouter agissent exactement comme Claude et codex :

- lire et écrire des fichiers, exécuter des commandes ;
- les permissions du projet (mêmes `allowed-tools`) ;
- le même format de log JSONL, que le dashboard affiche déjà ;
- le même traçage `system/init` (`model`, `modelSource`, `provider`) ;
- la même règle « model explicite = aucun fallback ».

**Essais réels du 2026-10-08** (codex-cli 0.154.0, fournisseur passé par `-c model_providers.*`) :

| Essai | Résultat |
|---|---|
| codex + NVIDIA, `wire_api = "chat"` | **Refusé par codex** : « `wire_api = "chat"` is no longer supported. How to fix: set `wire_api = "responses"` ». |
| codex + NVIDIA, `wire_api = "responses"` | **404** : `integrate.api.nvidia.com/v1/responses` n'existe pas. NVIDIA ne parle que `chat/completions`. |
| codex + OpenRouter, `wire_api = "responses"` | **Configuration acceptée** : codex s'arrête seulement sur « Missing environment variable: OPENROUTER_API_KEY ». L'endpoint `openrouter.ai/api/v1/responses` existe (401 sans clé, contre 404 pour un chemin inexistant). |

**Solutions évaluées** :

| Solution | Pour | Contre | Verdict |
|---|---|---|---|
| **codex avec un fournisseur OpenAI-compatible** (OpenRouter) | Même harnais que codex aujourd'hui : bac à sable, `apply_patch`, shell, rollout pour vérifier le model. `dispatch.mjs` convertit déjà ses événements en JSONL de flotte | Il faut une clé OpenRouter (payante à l'usage). La qualité des appels d'outils varie selon le model, et chacun doit être validé | **Retenu pour OpenRouter** |
| **Passerelle Responses → chat/completions intégrée au serveur** (pour NVIDIA) | codex reste le harnais unique. Elle reste dans le **même processus et sur le même port** : route interne en boucle locale seulement, protégée par le jeton. La clé NVIDIA ne quitte pas le serveur, comme aujourd'hui pour le failover | Traduire le flux SSE Responses (éléments, appels de fonction, arguments en flux) depuis le flux chat : environ 400 lignes, à couvrir de tests | **Retenu pour NVIDIA** |
| LiteLLM ou un autre proxy (Python) | Prêt à l'emploi | Un second processus, une dépendance Python : contraire à l'invariant « un seul processus Node, un seul port » | Écarté |
| Autres harnais (opencode, qwen-code, aider…) | Parlent chat/completions | Permissions, journal et bac à sable différents : les garanties ne seraient plus « identiques » | Écarté, sauf si la passerelle échoue |
| Harnais maison (boucle d'appels d'outils) | Contrôle total | Il faudrait réimplémenter le bac à sable, les permissions, l'analyse des commandes et les reprises : risqué et coûteux | Écarté |

**Recommandation** : **codex comme harnais unique de tout ce qui n'est pas Claude**.

- OpenRouter **directement** (Responses).
- NVIDIA **via la passerelle intégrée**.

Correspondance des outils du projet (`allowed-tools`) avec codex :

| Outils du projet | Côté codex |
|---|---|
| `Read`, `Grep`, `Glob` | Lecture par le shell (bac à sable `read-only` si le projet n'a que ces outils) |
| `Edit`, `Write` | `workspace-write` et `apply_patch` |
| `Bash` | Shell (`approval never` dans le bac à sable du projet) |
| `WebFetch`, `WebSearch` | `web_search=live` pour OpenAI. Via la passerelle, c'est un outil de fonction `web_fetch` servi par le serveur (à écrire) |

Le `system/init` porte `provider: "nvidia" | "openrouter"`, `model` et `modelSource`. Le model réellement servi est relu dans le rollout codex, comme en 0.26.0. Il n'y a aucun repli.

---

## 3. Garanties

### 3.1 Traçabilité par étape

Chaque tour d'étape écrit dans le log du musicien un `user_prompt` et un `system/init` qui portent :

- `run`, `pipeline`, `step` et `slot` ;
- `model` (demandé) et **`modelSource: "pipeline"`** ;
- puis le model **réellement servi** : `system/init.model` et chaque `assistant.message.model`, comme en 0.26.0.

Le journal d'activité affiche l'exécution comme une **frise d'étapes** : étape, model, durée, critère OK ou KO.

### 3.2 « Model explicite = aucun fallback » maintenu

- **Case affectée** dans la page Models : le model est explicite.
  - Il est vérifié dès l'`init`.
  - Aucun failover NVIDIA, aucun repli codex.
  - En cas d'indisponibilité : `system/fallback_refused`, puis un result `error_model_unavailable`, et **l'exécution passe en pause** avec une question à l'utilisateur (attendre, choisir un autre model pour cette étape, sauter l'étape si elle est optionnelle).
- **Case non affectée** (« défaut du projet ») : le comportement actuel, failover compris (décision n° 2), **avec un avertissement visible** :
  - un badge « défaut du projet — aucune case affectée » sur l'étape dans la frise ;
  - `modelSource: "project-default"` dans le `system/init` ;
  - un compteur des étapes non affectées par pipeline dans la page Models.
- Le drapeau de limite de flotte continue d'être posé, comme aujourd'hui.

### 3.3 Rien ne contourne le pipeline : un enforcement mécanique

1. **Une seule porte** : le serveur est la seule autorité qui lance un tour.
   - `spawnDirectDispatch`, le drain, le pool, le réveil, le relais et `sessions/new` passent tous par `startStep(run, step)`.
   - `dispatch.mjs` lancé hors du serveur devient un client de `POST /api/runs`.
2. **Jeton d'étape** :
   - Le serveur signe `{run, step, slot, model, exp}` par HMAC avec un secret local (`.orchestrateur-secret`, gitignoré, distinct de `.token`).
   - Le lanceur de tour (`dispatch.mjs` en mode exécutant) **refuse de lancer `claude` ou codex** sans jeton valide, ou avec un `--model` différent de celui du jeton.
   - Le jeton n'est jamais transmis à l'environnement du tour : un musicien ne peut donc pas s'en servir pour lancer un autre tour.
3. **Rien dans le prompt n'est une garantie** : les consignes d'étape aident le model, mais ce sont les **critères de sortie** (§2.4) et le **jeton** qui décident.
4. **Mise en service par drapeau** : `model-routing.json` → `enforcement: {pipelines: ["dev"], projects: ["pilote"]}`. Il est modifiable depuis la page Models (« en service : oui / non ») et relu à chaud. Hors du périmètre en service, le comportement actuel reste inchangé, avec un journal « hors pipeline » pour mesurer.
5. **Test de contournement** dans la non-régression : un faux musicien qui exécute `dispatch.mjs` doit être refusé, et une entrée sans pipeline doit être refusée ou classée.

### 3.4 Rôles

- **Chef** :
  - Il ne choisit plus les models : c'est la page Models qui le fait.
  - Il **classe, découpe, lance des exécutions** (`dispatch.mjs <p> --pipeline dev [--light]`), suit les frises et répond aux pauses.
  - Son propre tour est l'exécution du pipeline Routage, sur les models de ses cases.
- **Musiciens** : des exécutants d'étape, chacun avec un contrat court (rôle, artefact attendu, critère de sortie), injecté par le moteur comme les règles actuelles (fin de tour, exigences, commandes simples). Leur CLAUDE.md de projet reste inchangé ; on y ajoute le `.orchestrateur/pipeline.json` du projet.
- **CLAUDE.md du chef** (`I:\Dev\Chef`, un autre projet, modifié par le musicien Chef) :
  - une nouvelle section « Pipelines » : toujours `--pipeline`, jamais `--model` (sauf essai hors pipeline autorisé) ;
  - lire la frise ;
  - répondre aux pauses en nommant l'exécution ;
  - relayer la règle des exigences.

---

## 4. Coûts et latence

Unités : **tours** (consommation du quota de l'abonnement) et **minutes**. Les durées viennent des mesures du §0 : un tour d'étape ciblé est estimé entre 1 et 3 min, un tour de chef à environ 20 s. Ce sont des estimations ; la phase pilote les mesure.

| Pipeline (mode) | Tours aujourd'hui | Tours avec pipeline | Latence aujourd'hui | Latence estimée |
|---|---|---|---|---|
| Discussion | 1 chef (+ 1 musicien) | 1 classification + 1 à 3 étapes courtes | 0,5 à 3 min | 0,5 à 3 min (**inchangée**) |
| Développement **léger** (edit mécanique, petit correctif) | 1 musicien + réveil | classification + (4a si correctif) + 4b + Livrer (+ revue « chat ») | 3 à 15 min | 4 à 15 min (**+1 tour**) |
| Développement **complet**, N tests | 1 musicien (souvent long) + réveil | 6 + ≈2,5·N (N = 5 → environ 19 tours) | 3 à 15 min | 30 à 60 min (**× 3 à 5**) |
| Incident | 1 à 3 tours | 5 + Développement léger | 5 à 20 min | 15 à 40 min |
| Recherche, Rédaction | 1 à 2 tours | 3 à 5 étapes | 3 à 10 min | 8 à 20 min |
| Audit sécurité | 1 à 2 tours | 6 étapes (+ corrections) | 10 à 20 min | 30 à 60 min |
| Média (images, vidéo, audio) | 1 tour | 4 à 5 étapes, dont une partie en outils locaux (gratuits, déterministes) | variable | × 2 à 3 |

- **Tokens** : de × 2 à × 4 pour un Développement complet. Chaque étape relit une partie du code, et chaque bascule de model réécrit environ 60 k tokens de cache. Les leviers du §2.3 (deux sessions longues, prompts courts, regroupement par model) visent plutôt × 2.
- **NVIDIA et outils locaux** : gratuits. **OpenRouter** : payant à l'usage (clé à fournir). **codex** : sur son abonnement.

### Pipeline léger : qui décide, sur quels critères

- **Qui** : la classification (§1.3) propose `léger` ou `complet`. L'utilisateur peut forcer avec `/léger` ou `/complet` (sélecteur ou préfixe).
- **Critères vers le léger** (tous requis) :
  - aucun nouveau comportement, ou un correctif localisé ;
  - au plus 2 fichiers estimés ;
  - aucun sujet sensible (sécurité, données, publication, suppression) ;
  - le projet a une `testCommand`.
- **Garde-fou automatique** : si une exécution légère dépasse le périmètre (diff de plus de 3 fichiers ou de 150 lignes, nouveau fichier de code), le moteur **la fait monter** en complet à l'étape 3, et le dit.
- **Questions et réflexion** → Discussion, qui ne modifie rien.

---

## 5. Phases (mise en service progressive)

Chaque phase suit le protocole 0.29.0 : tag `pre-pipeline-enforce-pN-v<X.Y.Z>`, puis `regression.mjs --ref` avant, puis après, puis `--compare` sans régression, avec bump, CHANGELOG et commit.

| Phase | Livrables | Critères de réussite | Tests (dont l'exigence utilisateur) | Effort | Model |
|---|---|---|---|---|---|
| **P1 — Observation** ✅ (0.41.0, livrée) | Chaque entrée E1 à E14 est classée (pipeline + mode) par un **classifieur à règles** (`scripts/pipeline-observe.mjs`, gratuit et instantané) et journalisée dans `logs/pipeline-observe.ndjson`, terminal interactif compris (ligne par ligne). Inclassable = Discussion. **Aucun changement de comportement.** Panneau « Observation » dans la page Models. Étapes action / jugement, et NVIDIA / OpenRouter marqués « outillage en construction » (refus 409 sur une étape d'action). Projet pilote `pipelineLab` | Chaque entrée observée une seule fois (l'identifiant suit l'entrée jusqu'au tour) ; le texte des tours est inchangé | `_test_pipeline_observe.mjs` (classification sur les vraies demandes du fleet, terminal, câblage de chaque entrée, vrai `dispatch.mjs`), HTTP `pipeline-observe`, navigateur `observe-view` et `models-harness` | fait | Opus |
| **P2 — Outillage NVIDIA / OpenRouter** (0.42.0) | §2.7 : codex + OpenRouter (Responses), passerelle Responses → chat intégrée au serveur pour NVIDIA, outil `web_fetch` de la passerelle, correspondance des `allowed-tools` avec le bac à sable codex, `system/init` complet, vérification du model servi, aucun repli. `AGENT_HARNESS` passe à `true` fournisseur par fournisseur | Sur `pipelineLab`, un tour NVIDIA (kimi-k3) et un tour OpenRouter (avec la clé) **lisent un fichier, le modifient et lancent `npm test`**, avec un journal JSONL identique à un tour codex. Un model indisponible donne `fallback_refused`, pas de repli | `_test_responses_shim.mjs` (traduction SSE, appels d'outils en flux, erreurs), HTTP `harness-nvidia` (faux NVIDIA local), contrôle réel sur `pipelineLab` | 3 à 4 j | Opus |
| **P3 — Moteur + Discussion + Dev léger, sur `pipelineLab`** (0.43.0) | Moteur d'exécution (`logs/runs/`), jeton d'étape, porte unique `startStep`, frise dans le journal, pause et escalade, **signaux de limite** (§2.5), avertissement « défaut du projet ». Classification par le model de `routage.classifier`, comparée au journal de la phase 1. Pipelines **Discussion** et **Développement léger** en service sur `pipelineLab` seulement | Sur le pilote, chaque tour porte `run/step/modelSource`, avec le bon model servi. Un `dispatch.mjs` lancé par un musicien est refusé. Un model indisponible met l'exécution en pause | HTTP `pipeline-run`, `pipeline-bypass`, `pipeline-unavailable`, `pipeline-limit-notice`. Navigateur `run-timeline` | 3 à 4 j | Opus |
| **P4 — Développement complet** (0.44.0) | Boucle TDD pilotée (4a → 4b → 4c, un test à la fois), critères vérifiés (§2.4), revue → 4, limites et signaux, montée léger → complet. Toujours sur `pipelineLab` | Sur `pipelineLab` : 4a échoue réellement, 4b qui modifie le test est refusé, la suite passe à la sortie, la boucle s'arrête quand la liste est vide, chaque limite prévient l'utilisateur | `_test_pipeline_gates.mjs`, HTTP `pipeline-tdd`, `pipeline-limits` | 3 j | Opus (critères), Sonnet (intégration) |
| **P5 — Toutes les entrées branchées** (0.45.0, Android 0.9.0) | Sélecteur de pipeline dans le composer et l'app, préfixes, `@musicien`, `sessions/new`, file, pool, réveil, relais. **Terminal interactif routé** (décision n° 1) : sa session devient une Discussion en lecture seule, et une ligne classée comme action est confirmée puis lancée en exécution du bon pipeline. Refus sans pipeline (sauf `--hors-pipeline` tracé). Contrat du chef mis à jour (dispatch vers le musicien Chef) | **Test de la demande utilisateur** : pour chaque entrée E1 à E14 de l'instance de test, le tour lancé appartient à une exécution et tourne sur le model de sa case. Aucune entrée ne lance de tour hors pipeline | HTTP `pipeline-all-entries`, navigateur `composer-pipeline` et `terminal-routing`, Android `assembleDebug` et un test de ViewModel | 3 j | Sonnet |
| **P6 — Autres pipelines** (0.46.x) | Incident, Recherche, Audit, Rédaction, Maintenance, Nouveau projet, Données, Routage complet, puis **média** (outils locaux exécutés par le moteur, models spécialisés) | Chaque pipeline a ses critères et un parcours de test | Une recette par pipeline | 3 à 5 j | Sonnet (Opus pour l'audit) |
| **P7 — Généralisation** (0.47.0) | Tous les projets en service, mode observation retiré, rapport de coûts réels par pipeline | Une semaine d'usage sans contournement, et des coûts conformes aux estimations à ± 50 % | Non-régression complète | 1 j | Sonnet |

**Retour arrière** : à chaque phase, le tag, plus le drapeau `enforcement` vidé. Sans redéploiement, le comportement redevient celui d'avant (un tour, un model).

---

## 6. Questions à trancher par l'utilisateur

> **Réponses reçues le 2026-10-08** : voir « Décisions du 2026-10-08 » en tête du document. Seule la n° 9 est encore ouverte.

1. **Aucune exception ?** Le terminal interactif `/ws/pty` et `dispatch.mjs` lancé à la main doivent-ils aussi passer par un pipeline ? Garde-t-on une échappatoire d'urgence `--hors-pipeline "raison"`, tracée et visible ?
2. **Cases non affectées** : faut-il utiliser le défaut du projet (avec le failover actuel), ou **bloquer** l'étape tant que la page Models ne lui a pas donné de model ?
3. **Pipeline par défaut** quand la classification hésite : Discussion (rien n'est modifié, proposé) ou Développement léger ?
4. **TDD strict « un test à la fois »** toujours, ou un mode « lot » autorisé pour les gros chantiers ?
5. **Limites** : 3 essais de 4b par test, 2 tours de revue, 15 items, 90 min par exécution. Ces valeurs conviennent-elles ?
6. **Projet pilote** : lequel ? Il faut un projet avec une suite de tests rapide.
7. **NVIDIA et OpenRouter n'ont pas de harnais d'agent** : faut-il les réserver aux étapes de jugement (revue, second avis, synthèse, classification), ce qui est proposé, ou investir dans un harnais pour qu'ils puissent modifier du code ?
8. **Model indisponible** : mettre en pause et demander (proposé), ou désigner à l'avance un model de remplacement par étape, qui serait alors lui aussi « explicite » ?
9. **Latence × 3 à 5** pour un Développement complet : est-ce acceptable, ou faut-il que le léger soit le défaut et que le complet soit réservé aux fonctionnalités ?
