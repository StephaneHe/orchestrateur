# Plan — « Mode discussion » sur l'orchestrateur

> Demande de l'utilisateur (2026-10-08) : « Je voudrais rajouter un mode
> discussion sur l'orchestrateur. Fais moi un plan ».
> Ce document est un plan : rien n'est implémenté. Version de référence : 0.38.1.

---

## 1. Constat : pourquoi le besoin existe

Aujourd'hui, tout message envoyé depuis le composer part en **tour de travail** :

- **Vers le chef**, il devient un ticket de la file du pool (`POOL_MAX_SIZE = 1`,
  FIFO persistée). Une simple question attend donc derrière un tour de
  supervision en cours. Le chef a aussi `Bash` : il peut lancer
  `dispatch.mjs`, et il le fait.
- **Vers un musicien**, le message reprend sa session de travail (`--resume`)
  avec `Edit,Write,Bash…` (0.28.0). Le `.claude/settings.json` posé en 0.30.0
  accorde en plus `PowerShell`. Une question « explique-moi ce module » peut
  donc finir par un commit. Elle consomme aussi la file du musicien et
  rallonge sa session.

Il n'existe aucun canal pour **réfléchir à voix haute** sans risque d'action
et sans encombrer les files.

---

## 2. Interprétations possibles

| # | Interprétation | Intérêt | Coût / risque |
|---|---|---|---|
| **a** | **Discuter avec le chef sans action** : conseils, explications, état de la flotte, sans dispatch ni écriture | Le plus demandé en pratique (« où en est-on ? », « que ferais-tu ? »). Le chef connaît toute la flotte. Pas d'attente derrière la file du pool. | Faible à moyen. Il faut un couloir séparé du pool et une liste d'outils en lecture seule. Le chef lit sa propre doc (`I:\Dev\Chef`). |
| **b** | **Discuter avec un musicien en lecture seule** : questions sur son code, aucun commit | Les réponses sont précises sur un projet. Très utile pour comprendre avant de demander. | Faible une fois (a) fait : même mécanique, autre `cwd`. Point délicat : ne pas polluer sa session de travail (voir §4.3). |
| **c** | **Table ronde** : plusieurs musiciens et/ou models (Claude, codex) débattent, le chef modère et synthétise | Avis contradictoires, comparaison de models. Fondé sur `--new-session` et `--provider` (0.25–0.27). | Élevé. Il faut orchestrer N tours par manche, régler le coût (N × manches), une UI de débat et une synthèse. À faire après (a) et (b). |
| **d** | **Fils de discussion séparés des tâches** : un chat libre avec historique, plusieurs fils, reprise | L'historique ne se mélange plus au fil de travail du chef. On retrouve une réflexion d'il y a 3 jours. | Moyen. Stockage par fil (JSONL + sidecar session, comme le reste) et liste des fils dans l'UI. |

Ces interprétations ne s'excluent pas : **d** est le *contenant* (des fils),
**a** et **b** sont les *interlocuteurs* possibles d'un fil, **c** est un fil
à plusieurs voix.

### Recommandation pour le MVP : **a + d**, puis **b**, et **c** plus tard

- **MVP (phases 1–2)** : des *fils de discussion* (d) avec **le chef en
  lecture seule** (a). C'est la valeur la plus immédiate, et cela pose toute
  l'infrastructure : fil, garde-fous, UI, passage à l'action.
- **Phase 3** : le même fil peut viser **un musicien** en lecture seule (b).
  C'est presque gratuit une fois l'infrastructure posée.
- **Phase 5 (optionnelle)** : **table ronde** (c), si l'usage le justifie.

---

## 3. UX dans le dashboard (MVP)

### 3.1 Bascule de mode dans le composer
- Un interrupteur à deux positions à gauche du champ : **⚙ Action** /
  **💬 Discussion**. Il est mémorisé par interlocuteur dans `localStorage`
  (`ui.composerMode`). Défaut : Action, donc rien ne change pour l'existant.
- Raccourci `Ctrl+Alt+D` (ignoré dans un champ de saisie et avec AltGr, comme
  `Ctrl+Alt+L`).
- En mode Discussion, le champ change de **couleur de bordure** (variable de
  palette, qui marche pour amber, matrix, ghost et crimson). Le texte indicatif
  devient « Discuter avec le chef — aucune action ne sera lancée », et le
  bouton s'appelle **Discuter** au lieu d'**Envoyer**.

### 3.2 Indicateur visible
- Un badge **💬 DISCUSSION** sur chaque bulle émise en mode discussion, et dans
  l'en-tête du fil.
- Un bandeau fin en haut du fil : « Lecture seule — Edit, Write, Bash,
  dispatch désactivés ». Il n'est pas refermable, car c'est la garantie
  affichée.

### 3.3 Fils de discussion
- Une nouvelle **pill « Discussions »** dans la barre (à côté de Projets),
  route `#/discussions`.
  - À gauche, la liste des fils : titre (auto = 60 premiers caractères,
    renommable), interlocuteur, date du dernier message, coût cumulé.
  - À droite, le fil, rendu par le même moteur que le chat du chef
    (`mdToHtml`, bulles).
- « + Nouveau fil » ouvre un choix d'interlocuteur : Chef pour le MVP, un
  musicien en phase 3.
- Les fils sont **archivables**, pas supprimables depuis l'UI : on ne détruit
  jamais de log.
- Mobile : la liste et le fil sont empilés, avec un bouton retour. Les cibles
  font 44 px, et toutes les polices sont en `rem` (règle 0.34.0).

### 3.4 Historique
- Un fil = un log JSONL append-only, au même format stream-json que les
  musiciens. Les réducteurs, le journal et la recherche existants
  s'appliquent sans nouveau format.
- La recherche du dashboard inclut les fils (case « inclure les
  discussions »).

### 3.5 TTS (0.35.0)
- Le bouton 🔊 est présent sur les bulles de réponse d'un fil : `Tts.buttonHtml`
  est réutilisé tel quel.
- La lecture automatique, si elle est activée, s'applique aussi aux réponses
  en direct d'un fil de discussion. Une case séparée permet de la limiter au
  chef de travail.

### 3.6 Android
- **MVP sans Android.** L'app reste centrée sur la flotte. Elle affiche
  seulement le **nombre de fils actifs** dans l'écran Réglages, pour signaler
  qu'ils existent.
- **Phase 4** : écran « Discussions », avec une liste, un fil et un champ de
  saisie, sur les mêmes routes. versionName passe en mineur et versionCode
  augmente de 1.

---

## 4. Comportement serveur

### 4.1 Un couloir séparé : `discuss`
- **Nouveau script** `scripts/discuss.mjs`, frère de `dispatch.mjs`. Il ne
  passe **ni par la file du musicien ni par le pool du chef**. Une question
  n'attend jamais derrière un tour de travail, et ne retarde jamais un tour de
  travail.
- **Routes** (token-gated quand le gate est actif, comme tout le reste) :
  - `GET  /api/discussions` : la liste des fils ;
  - `POST /api/discussions {with, title?}` : crée un fil et renvoie `{id}` ;
  - `POST /api/discussions/:id/message {text, attachmentPaths?}` : lance un
    tour en lecture seule ;
  - `GET  /api/discussions/:id/events` : le SSE, sur le modèle de
    `/api/project/:name/events` ;
  - `POST /api/discussions/:id/archive` ;
  - `POST /api/discussions/:id/to-task` (voir §6).
- **Stockage** dans `logs/discuss/<id>.jsonl`, `<id>.session` et `<id>.meta.json`
  (interlocuteur, titre, archivé, coût), à côté des autres logs dans `logs/`.
  Donc **gitignoré** et jamais synchronisé : les règles sur `logs/`
  s'appliquent. `<id>` est un slug généré par le serveur
  (`d-<horodatage>-<aléa>`) et validé par une regex avant tout `path.join`.
- **Un seul tour à la fois par fil.** Un second message pendant qu'un tour
  tourne reçoit un 409 et l'UI désactive le bouton. Pas de file : c'est une
  conversation.

### 4.2 Outils autorisés (lecture seule)
- `--allowed-tools "Read,Grep,Glob,WebFetch,WebSearch"`. Le web est inclus,
  conformément à la règle 0.28.0 « tous les projets ont droit au web et à la
  lecture ».
- **Et surtout `--disallowed-tools "Edit,Write,NotebookEdit,Bash,PowerShell,Agent,Task"`.**
  Raison : depuis 0.30.0, le `.claude/settings.json` de chaque projet accorde
  ses outils (dont `PowerShell`) et le dossier est de confiance. Un simple
  `--allowed-tools` restreint **ne suffit pas**, car le `permissions.allow`
  du projet s'ajoute. Une règle *deny* l'emporte toujours sur *allow* : c'est
  elle qui garantit la lecture seule.
- `--permission-mode plan` en défense supplémentaire : le CLI n'exécute
  aucune action d'écriture dans ce mode.
- Sans `Bash`, le chef **ne peut pas lancer** `dispatch.mjs`,
  `kill-stalled.mjs`, `notify.mjs`, `git` ni `queue.mjs`. Le garde-fou
  « pas de dispatch » est donc **mécanique**, pas promis par le prompt.
- **Lecture de l'état de la flotte** sans Bash : le chef sait le lire via
  `fleet-status`. Pour le remplacer, `discuss.mjs` **injecte un instantané**
  dans le premier message de chaque tour : le résumé de `/api/pupitre`, soit
  l'état, la question en cours, le dernier result en une ligne et la file,
  pour chaque musicien. L'instantané est invisible dans le fil, comme les
  règles de fin de tour (après `promptForLog`). Les fichiers des projets
  restent lisibles avec `Read`.
- Isolation inchangée : `--setting-sources project,local`,
  `--strict-mcp-config`, `--disable-slash-commands`, et suppression de
  `ANTHROPIC_API_KEY` de l'environnement du fils.

### 4.3 Session : dédiée, avec reprise du contexte en option
- **Session dédiée par fil** : le premier tour se fait sans `--resume`, puis
  `--resume <sid du fil>`. La session de travail du chef ou du musicien
  **n'est jamais touchée** : pas de pollution, pas de risque de corruption
  par deux `--resume` simultanés.
- **Option « avec le contexte de travail »** (case à cocher à la création) :
  `--resume <sid de travail> --fork-session`. Le CLI copie la session en une
  nouvelle. Le fil hérite de tout ce que l'interlocuteur sait déjà, et
  l'original reste intact. Coût : le contexte copié est rechargé (cache
  probable). Défaut : décoché pour le chef, coché pour un musicien (phase 3).
- **Prompt système ajouté** (`--append-system-prompt`), en substance :
  - « Tu es en MODE DISCUSSION : aucun outil d'action n'est disponible.
    Réponds directement. Si une action est souhaitable, décris-la et termine
    par `PROPOSITION_TACHE: <projet> — <consigne>`. L'utilisateur décidera. »

### 4.4 Model et coût
- Model par défaut **configurable** : `config.json` →
  `discussion.defaultModel`, relu à chaud.
  - Proposition : `sonnet` pour le chef, qui répond à des questions et non à
    de l'orchestration fine.
  - Le sélecteur de model du fil permet `opus` ponctuellement.
- **La règle 0.26.0 s'applique** : un model choisi explicitement = aucun
  fallback. Un model par défaut peut basculer selon les règles habituelles de
  limite.
- Codex est possible avec `--provider codex`, en lecture seule via son bac à
  sable `-s read-only`, et `-c web_search=live` si le web est accordé. Le
  MVP est Claude seulement ; codex vient en phase 3.
- Le coût de chaque tour (`result.total_cost_usd`) est cumulé dans
  `<id>.meta.json` et affiché dans la liste des fils. Un plafond optionnel
  `discussion.maxCostPerThreadUsd` désactive l'envoi au-delà, avec un message
  clair.

### 4.5 Interactions avec l'existant
- **File de direction et pool du chef** : aucune. Les tours de discussion
  n'apparaissent ni dans `queue.mjs` ni dans `/api/pool`.
- **État des musiciens, attention, « À examiner »** : une discussion ne change
  **jamais** l'état d'un panneau (`idle|live|input|done|error`). Les logs sont
  séparés, donc rien à filtrer dans les réducteurs.
- **Callbacks (`notify.mjs`) et sentinelles** : désactivés en discussion.
  - `NEEDS_USER_INPUT` n'a pas de sens : on est déjà en conversation avec
    l'utilisateur.
  - Le pump ne surveille pas `logs/discuss/`.
- **Limite Claude de flotte** : un tour de discussion qui la rencontre pose le
  drapeau comme les autres. Une discussion ne bascule pas vers NVIDIA et
  échoue proprement : le message dit « limite atteinte ».
- **Concurrence avec un tour de travail du même interlocuteur** : c'est
  autorisé, car les sessions sont distinctes. Avec `--fork-session` pendant un
  tour en cours, la copie part du dernier état écrit sur disque, ce qui est
  acceptable. L'UI le signale : « le chef travaille en parallèle ; son
  contexte peut avoir avancé ».

---

## 5. Garde-fous : appliqués par le code, pas par le prompt

| Garde-fou | Mécanisme | Testé par |
|---|---|---|
| Aucune écriture de fichier | `--disallowed-tools Edit,Write,NotebookEdit` + `--permission-mode plan` | suite `_test_discussion.mjs` : argv réellement construit + faux `claude` qui tente Edit |
| Aucune commande (donc aucun dispatch, commit, notify, kill) | `--disallowed-tools Bash,PowerShell` | même suite + recherche de `dispatch.mjs` dans les tool_use d'un fil = 0 |
| Pas de sous-agent qui contournerait | `--disallowed-tools Agent,Task` | même suite |
| La liste deny n'est pas dérivable de config.json | constante figée dans `discuss.mjs`, **jamais** fusionnée avec `tools` du projet ni `defaults.allowedTools` | test : un projet avec `tools: "…,Bash"` garde Bash interdit en discussion |
| Session de travail intacte | jamais `--resume <sid travail>` sans `--fork-session` ; `logs/<p>.session` jamais écrit par discuss | test : hash de `logs/<p>.session` identique avant/après |
| Pas de nouveau chemin d'injection | `<id>` validé par regex, interlocuteur validé contre `config.projects`, argv en tableau | test : id `../x` → 400 |
| Coût borné | plafond par fil optionnel | test HTTP |

---

## 6. Passer de la discussion à l'action

- Chaque bulle de réponse porte un bouton **« → Transformer en tâche »**.
  - Si la réponse contient `PROPOSITION_TACHE: <projet> — <consigne>`, il est
    mis en avant et pré-rempli.
  - Sinon, l'utilisateur choisit le projet et rédige ou valide la consigne.
- **Confirmation obligatoire** : une modale montre le projet cible, la
  consigne exacte (éditable), le model et le mode de lancement. Le mode
  « direct au musicien (file si occupé) » est celui par défaut ; l'autre est
  « confier au chef ». Rien ne part sans un clic sur **Lancer**.
- Route `POST /api/discussions/:id/to-task {project, prompt, via: 'musician'|'chef', model?}`.
  Elle valide le projet contre l'allowlist et réutilise **le chemin
  existant** : `/api/dispatch` avec `queueIfBusy`, ou un ticket du pool pour
  le chef. Aucun nouveau lanceur.
- La tâche porte un lien de provenance, `source: "discussion:<id>"`, et le
  fil reçoit un événement `notification/task_created` (projet, horodatage).
  On sait d'où vient une tâche, et le fil montre « → tâche envoyée à X ».
- La consigne envoyée peut inclure un résumé du fil, case « joindre le
  contexte de la discussion », cochée par défaut. Ce résumé est extrait sans
  LLM : les 3 derniers échanges, tronqués.

---

## 7. Impacts

| Élément | Changement |
|---|---|
| `scripts/discuss.mjs` | **Nouveau.** Il réutilise de `dispatch.mjs` la résolution du binaire claude, l'écriture du log, la suppression d'`ANTHROPIC_API_KEY` et la vérification du model explicite, factorisées dans `scripts/lib/claude-spawn.mjs` si c'est utile. |
| `scripts/dispatch.mjs` | Inchangé fonctionnellement. Seulement une factorisation éventuelle, couverte par la non-régression existante. |
| `server.js` | Routes `/api/discussions*`, SSE, cumul de coût et flag `ui.discussions` dans `uiFlags()`. **Redémarrage nécessaire.** |
| `public/` | `discussions.js` + `discussions.css` (vue), bascule du composer dans `app.js`, badge 💬, modale « Transformer en tâche ». |
| `config.json` | Bloc optionnel `discussion: {defaultModel, maxCostPerThreadUsd}` et `ui.discussions` (désactivation à chaud). **Aucune écriture par le code.** |
| `I:\Dev\Chef\CLAUDE.md` (autre projet, modifié par le musicien Chef) | Il faut une section « Mode discussion » qui dit : « tu n'as pas d'outils d'action : tu conseilles et tu proposes `PROPOSITION_TACHE`. Tu ne promets pas d'avoir lancé quoi que ce soit ». Elle relaie aussi la règle 0.36.0 si la discussion débouche sur une demande de fonctionnalité. |
| Android | Phase 4 seulement. |
| Docs | Section « Mode discussion » de `CLAUDE.md` et `README`, entrées CHANGELOG, et ligne au registre `docs/USER_REQUIREMENTS.md`. |

---

## 8. Plan par phases

Chaque phase suit le protocole 0.29.0 :

1. tag annoté `pre-discussion-pN-v<X.Y.Z>` ;
2. `regression.mjs --ref <tag>` avant ;
3. `regression.mjs` après ;
4. `--compare` sans régression ;
5. bump de version, CHANGELOG et commit.

| Phase | Livrables | Critères de réussite | Tests de non-régression | Effort | Model conseillé |
|---|---|---|---|---|---|
| **0 — Plan** (cette version, 0.38.1) | Ce document | Validé par l'utilisateur, questions §9 tranchées | Néant (doc). Suites `_test_repo_hygiene` et `_test_user_requirements` vertes. | fait | — |
| **1 — Moteur + garde-fous** (0.39.0) | `discuss.mjs`, `logs/discuss/`, routes de création, message, liste et SSE, deny-list, instantané de flotte, session dédiée | Une question au chef reçoit une réponse **sans** passer par le pool. Toute tentative d'Edit, Write ou Bash est refusée par le CLI. La session de travail du chef est inchangée. | **Nouvelle suite `_test_discussion.mjs`** : argv réel, deny-list figée, refus d'Edit et de Bash avec `fake_claude`, sid de travail intact, validation de l'id. **Parcours HTTP `discussion-basic`.** **Ligne au registre USER_REQUIREMENTS** (« mode discussion », références `suite:_test_discussion.mjs` et `http:discussion-basic`). | 1 à 1,5 j | Opus (sécurité, garde-fous) |
| **2 — UI fils + bascule** (0.40.0) | Pill et vue `#/discussions`, bascule du composer, bandeau lecture seule, badge, TTS, mobile, « Transformer en tâche » avec confirmation, `ui.discussions` à chaud | Créer un fil, discuter, archiver, transformer en tâche (la tâche arrive dans la file du musicien avec `source: discussion:<id>`), sur bureau et mobile | Parcours navigateur `discussion-thread`, `discussion-toggle`, `discussion-to-task` (aucun dispatch sans clic sur Lancer), `discussion-mobile`, `discussion-tts`, `flags-discussion` | 1,5 à 2 j | Sonnet (UI), revue Opus de la modale |
| **3 — Discuter avec un musicien** (0.41.0) | Interlocuteur = n'importe quel projet, `--fork-session` optionnel, codex en lecture seule (`-s read-only`) | Question sur le code d'un musicien, réponse précise, aucun fichier modifié (vérifié par `git status` propre sur une fixture) | Suite `_test_discussion.mjs` étendue (fork : sid d'origine intact ; projet avec `tools` contenant Bash, toujours interdit) et parcours HTTP `discussion-musician` | 0,5 à 1 j | Sonnet |
| **4 — Android** (Android 0.9.0) | Écran Discussions : liste, fil, saisie, sans « Transformer en tâche » au départ | Consulter et poursuivre un fil depuis le téléphone | `assembleDebug` et test d'instrumentation ou de ViewModel sur le parsing | 1 j | Sonnet |
| **5 — Table ronde** (optionnelle, 0.42.0) | Fil à N voix : musiciens et/ou models, manches bornées, synthèse du chef | Débat à 2 ou 3 voix en ≤ 3 manches, synthèse finale, coût affiché avant lancement | Suite `_test_roundtable.mjs` (ordre des tours, plafond de manches et de coût) et parcours `roundtable` | 2 à 3 j | Opus (conception), Sonnet (UI) |

**Retour arrière** : chaque phase a son tag `pre-discussion-pN-…`. La
fonctionnalité se désactive aussi **sans redéploiement** avec
`config.json` → `"ui": {"discussions": false}` (pill et routes masquées ; les
routes renvoient 404), ou `?discussions=0` pour un navigateur.

---

## 9. Questions pour l'utilisateur

1. **Interprétation** : la recommandation « fils de discussion avec le chef en
   lecture seule, puis avec un musicien » correspond-elle à votre idée ? Ou
   pensiez-vous d'abord à la **table ronde** (plusieurs avis qui débattent) ?
2. **Web** : le chef en discussion peut-il **chercher sur le web**
   (WebSearch/WebFetch) ? Recommandé : oui, conformément à la règle 0.28.0.
3. **Contexte** : une discussion avec le chef doit-elle **hériter de ce qu'il
   sait déjà** (copie de sa session, plus chère au premier message), ou
   repartir de zéro avec seulement l'état de la flotte injecté ?
4. **Model par défaut** : Sonnet (moins cher, suffisant pour discuter) ou Opus
   comme le chef de travail ? Et voulez-vous un **plafond de coût** par fil ?
5. **Où** : une vue séparée « Discussions » (fils listés), ou seulement une
   **bascule dans le composer actuel**, avec les échanges mélangés au fil du
   chef mais marqués 💬 ? Recommandé : vue séparée, pour ne pas mêler
   réflexion et travail.
6. **Android** : le mode discussion est-il nécessaire sur le téléphone dès le
   départ, ou peut-il attendre la phase 4 ?
7. **Transformer en tâche** : par défaut, la tâche part-elle **directement au
   musicien** ou **au chef** (qui décide et coordonne) ?
