# Synthèse UI Orchestrateur — meilleur des deux (Astra + Fable) — Anthropic Fable — 2026-09-23

Lecture seule. Sources : `docs/orchestrateur-ui-redesign-astra.md`, `docs/orchestrateur-ui-redesign-fable.md`, re-vérifiées contre `server.js`, `scripts/fleet-status-core.mjs`, `scripts/dispatch.mjs`, `config.json`, `public/*`, `android/*` (v0.20.0 sur disque). Aucun code modifié, serveur 7777 non redémarré.

**Concept validé en une phrase : une conversation de direction avec le chef, dans laquelle chaque délégation apparaît comme une ligne de mission qui vit sur place, accompagnée d'un rail de pilotage secondaire ; les résultats arrivent en panier, le chef les transforme en point ; tout nom de musicien ouvre son contenu dans un volet routé, et l'on revient exactement là où l'on était.**

Corrections factuelles apportées aux deux docs :

- Fable écrivait « 15 parqués » : `config.json` en compte **13** (chef + 15 musiciens actifs + 13 mis de côté = 29). Astra avait juste.
- Astra cite `PATCH /api/projects/:name/tools` : la route existe bien (`server.js:3739`), elle manquait dans la cartographie de Fable.
- Le log du chef contient les `tool_use Bash` dont la commande est `node …/dispatch.mjs <X> … --callback chef` (vérifié dans `logs/chef.jsonl`). C'est le signal structuré qui manquait à Astra pour oser le mot « mission » et qui rend le bloc MISSIONS de Fable **reconstructible au rechargement** via `/api/project/chef/events` — sans nouveau champ serveur.

---

## 1. Tableau d'arbitrage

| Critère | Astra | Fable | **Choix** | Raison |
|---|---|---|---|---|
| Surface primaire | Conversation de direction ≈ 2/3 de la largeur + rail de pilotage 300–360 px | Journal central + rail « en scène » | **Fusion : identique sur le fond.** Fil ≈ 2/3, rail droit compact, pas de grille de cartes, pas de seconde carte chef | Les deux convergent ; l'état du chef va dans l'en-tête (Astra), pas en pied de rail (Fable) — une seule source visuelle pour « le chef répond » |
| Où apparaît le pilotage dans le fil | « Pilotage observé : [vuBox] démarré · [RemotePad] démarré » sous le tour chef ; « mission » seulement si relation structurée, sinon « Activité de l'orchestre » | Bloc MISSIONS dans le tour chef, ligne par musicien qui évolue jusqu'au résultat | **Fable, avec la prudence d'Astra.** Bloc **MISSIONS** créé au `tool_use Bash dispatch.mjs <X>` du chef (signal structuré), ligne « démarré » seulement à l'événement observé du musicien ; un musicien lancé hors chef (`@X`, file, relais) va dans un bloc **ACTIVITÉ DE L'ORCHESTRE** séparé | Le signal existe (tool_use du chef + `callback:"chef"` sur le prompt du musicien) : on peut dire « mission » sans mentir. La ligne qui vit sur place matérialise « le chef pilote » ; la distinction pilotée/observée est l'honnêteté d'Astra |
| Résultats | Panier « Résultats reçus (n) » comme trace d'arrivée, séparé du rapport, jamais recopié | Le résultat devient la face finale de la ligne de mission ; panier conservé en repli | **Fusion.** Le panier reste l'objet **persisté** (il vient du log chef via `/api/conductor-chat`) ; la ligne de mission affiche l'issue et **pointe** vers sa carte du panier (pas de duplication) | Fable seul ne survivait pas au rechargement (les missions ne sont pas dans `/api/conductor-chat`) ; Astra seul perdait le lien visuel lancement → résultat. Ensemble : lien vivant + persistance |
| Bande d'attention | « À votre attention » : une ligne + compteur, détail au clic | « À TRAITER » : liste épinglée avec boutons | **Fusion.** Une ligne repliée (priorité : question > PID mort > échec > sans progrès) montrant l'élément le plus grave ; clic ⇒ liste avec actions | Une ligne ne vole pas le fil (Astra) ; les actions directes évitent un détour (Fable) |
| Rapport | « CHEF — Point sur les résultats » si origine wake observée ; « prend en compte » = association d'affichage, pas accusé serveur | Tour `RAPPORT`, liseré double, puces cliquables | **Fusion.** Libellé **« CHEF — Point sur les résultats »**, liseré ambre double, « prend en compte : A ✓ · B ✕ » avec puces ouvrant carte + musicien ; aide « résultats reçus avant ce tour » | Même idée ; on garde la formulation honnête d'Astra et la signature visuelle de Fable. Au rechargement l'origine wake est perdue (`/api/conductor-chat:2281` saute le prompt) ⇒ bulle chef ordinaire, `wake:true` en P1 |
| Réponse à une question de musicien | « Répondre via le chef » par défaut (cite la question, nomme X) ; direct `@X` en action secondaire explicite | Bouton Répondre ⇒ préremplit `@X` (raccourci direct existant) | **Astra.** Défaut = via le chef ; « Répondre directement à X » en secondaire, avec mention file/interruption | Règle dure du CLAUDE.md (« Answer routing is the central Claude's job ») et pilier 2. Surtout : un dispatch direct n'a pas `--callback`, donc **pas de réveil, pas de point** ; via le chef, la boucle mission → résultat → rapport reste entière |
| Drill-down | Remplace le rail, s'élargit ; onglets Activité / Dernier résultat / Journal récent ; action principale « En parler au chef », direct sous « Actions avancées » ; retour restaure ancre, dépliages, brouillon, focus | Volet routé `#/m/X`, fil intact non défilé, `Échap`/`‹` = `history.back()`, composeur direct en pied | **Fusion.** Volet routé par hash (Fable) qui remplace le rail (les deux), trois onglets d'Astra, action principale **En parler au chef**, envoi direct explicite en secondaire, restauration ancre/dépliages/brouillon/focus (Astra) | Le hash donne lien direct + bouton Retour natif + pile Android ; les onglets d'Astra structurent le contenu ; « En parler au chef » est cohérent avec le choix précédent |
| Annuaire | Accès permanent « Musiciens / chercher », parkés inclus, depuis tous les niveaux | Compteurs repliés « Autres / Remise » dans le rail | **Astra**, plus les compteurs de Fable dans le rail | Avec 29 projets, la recherche est indispensable ; c'est l'idée qui manquait à Fable |
| Vocabulaire d'états | Correspondance visuelle vers 5 clés (`think`→`live`, `unread`→`done`) comme règle de présentation | Six clés des réducteurs inchangées jusque dans le DOM | **Fable pour le DOM, Astra pour les libellés.** Aucune chaîne `data-state` ni enum Kotlin ne change ; les libellés suivent la table d'Astra (« En cours · réflexion », « Terminé », « Attend le chef ») | Renommer `data-state` toucherait la CSS d'état (`styles.css:460-481`) sans bénéfice ; les libellés suffisent à respecter le contrat des cinq états |
| Fraîcheur / santé | Quatre notions distinctes : synchronisé, flux interrompu, données anciennes, sans progrès / processus perdu ; `pidAlive:null` = inconnu ; parkés « santé non suivie » | Âge du snapshot, grisé > 15 s, bandeau unique le plus grave | **Fusion.** Vocabulaire d'Astra, seuils et « un seul bandeau » de Fable | Les deux se complètent ; Astra évite de déclarer tout mort sur un SSE coupé |
| Mobile : flotte | Ligne « Pilotage : 2 en cours · 1 question › » + feuille Pilotage avec recherche/filtres | Chips « en scène » stables en haut + feuille « Tous » | **Astra.** Une ligne de synthèse stable + feuille ; pas de chips | Les lignes de mission dans le fil montrent déjà *qui* travaille ; des chips réordonnables ajoutent du mouvement pour peu d'info |
| Mobile : mission / détail | Feuille Pilotage → détail plein écran à onglets ; Retour restaure le fil ; « Nouveau rapport ↓ » sans scroll forcé | Bottom sheet L1 sur la ligne de mission, écran L2 via NavHost à 3 destinations | **Fusion.** NavHost 3 destinations (Fable, concret) ; tap sur ligne de mission ⇒ bottom sheet L1 (Fable) ; « Plonger » ⇒ écran L2 à onglets (Astra) ; « Nouveau rapport ↓ » (Astra) | Complémentaires |
| Divulgation progressive | Tableau objet × niveau (mission, résultats, rapport, question, santé) | L0 ligne / L1 dépliage / L2 flux + règles anti « tout d'un coup » | **Fusion** : la grille d'Astra + les règles de Fable | — |
| Honnêteté des affichages | Pas de « 2 sur 3 », pas de compte à rebours, coût absent = « non fourni », question tronquée signalée, 202 ≠ réussite, « lu » ≠ « traité » | Peu explicité | **Astra**, intégralement | Ce sont des garde-fous sans coût |
| Hygiène du code | Non traité | Suppression grille absolue / main de cartes masquée / code mort, fusion des deux tris, découpage en modules, tweaks persistés | **Fable**, en P2 | Nécessaire pour qu'Opus 5 ne construise pas sur du code mort |
| Version affichée | À propos (serveur ≠ Android) | Pied de page web + Android via `/api/version` | **Fusion** : pied de page web, en-tête + À propos Android | Règle standing du CLAUDE.md |

---

## 2. Matière serveur retenue (rappel vérifié)

| Besoin de l'UI | Source réelle | Note |
|---|---|---|
| Fil chef (bulles, panier, questions) | `GET /api/conductor-chat` (`server.js:2246-2328`) : `user`, `conductor` (+`question`), `callback` (`outcome`, `summary`, `duration_ms`, `cost_usd`, `awaitingChef`) ; saute `source:"wake"` | Persisté ; l'activité intermédiaire du chef n'y est pas |
| Missions (le chef dispatche) | SSE : `assistant` du chef avec `tool_use Bash` dont `input.command` contient `dispatch.mjs <X>` ; au rechargement `GET /api/project/<chef>/events?n=500` (`:2150-2236`) | Fenêtre bornée (500 evts / 2 Mio) : au-delà, « activité non chargée » |
| Mission démarrée / attendue | SSE du musicien : `user_prompt` sans source (`dispatch.mjs:628`) portant `callback:"chef"` (`:640`), puis `system/init` | `callback` = « le chef attend ce tour » (0.20.0) |
| Issue, résumé, durée, coût | `notification/musician_done|musician_question` écrite dans le log chef (`autoNotifyConductor:3061-3101`) | Résumé = dernier paragraphe ≤ 280 c. (`summarizeResult:2400`) |
| Santé, stall, PID, silence, tour, modèle, `needsInput`, `queueDepth`, `limitedUntil`, `noFailover` | `GET /api/pupitre` (`:1776-1801`), core `scanProject` | Cache 2,5 s ; parkés non scannés ; `pidAlive:null` = inconnu |
| Rapport poussé | `user_prompt{source:'wake'}` puis `system/init` du chef (`tryFireWake:497-538`) | Origine visible en live seulement ; `wake:true` sur `/api/conductor-chat` = P1 serveur |
| Réponse via le chef | `POST /api/dispatch {project: chef}` (`:3365`) ; interruption coopérative si tour chef vivant (`:3511-3532`) | L'UI doit dire « Envoyer et interrompre le tour du chef » quand `pidAlive` |
| Envoi direct | `POST /api/dispatch` au chef avec préfixe `@X` (`:3420-3458`) : file si occupé, note `shortcut→X` dans le log chef | Sans `--callback` ⇒ aucun réveil |
| Détail musicien | `GET /api/project/:name/events?n=200` + SSE ; renderer partagé `public/pupitre-detail.js` | Notices `log_growth_skipped` / `oversized_line_skipped` à rendre |
| Lu / non lu | `POST /api/mark-read` (`:1836`) | « lu » ≠ « traité » |
| Administration | `/api/projects*`, `/api/project/:name/{park,add-tool,provider}`, `PATCH /api/projects/:name/tools`, sessions, `/api/conductor` | Hors du fil, écran Réglages |
| Version | `GET /api/version` (`:1708`) | Non consommé par Android aujourd'hui |

Vocabulaire des réducteurs (`scanProjectState`, `reduceMusician`, `deriveState`, `Musician.transition`, `Musician.kt`) : `idle | live | think | input | error | unread`. **Aucune chaîne ne change.** Libellés : `idle` Prêt · `live` En cours · `think` En cours · réflexion · `input` Votre réponse attendue · `unread` Terminé (ou **Attend le chef** si `awaitingChef`) · `error` Échec.

---

## 3. Design validé — web

### 3.1 Écran racine `#/` : conversation + rail de pilotage

```
┌────────────────────────────────────────────────────────────────────┬─────────────────────────┐
│ ORCHESTRATEUR / CHEF  ♛ répond… · synchronisé il y a 3 s   [Musiciens / chercher] [Menu ⋮] │
├────────────────────────────────────────────────────────────────────┼─────────────────────────┤
│ ⚠ À VOTRE ATTENTION · 1 question · 1 processus perdu    DeskZen : « Quelle synchro ? » [▾] │
├────────────────────────────────────────────────────────────────────┤ PILOTAGE                │
│                                        ┌─────────────────────────┐ │ EN COURS (2)            │
│                                        │ Vérifie vuBox et       │ │ [vuBox]      En cours   │
│                                        │ RemotePad.             │ │  bash npm test · 3m12   │
│                                        └─────────────────────────┘ │  progrès 8 s · proc. OK │
│ ┃♛ CHEF · 09:31                                                    │ [RemotePad]  En cours   │
│ ┃ ▸ Activité du chef : 3 outils · 1m40                             │  ! sans progrès 1m12    │
│ ┃ Je leur confie les tests et la compilation ; je te fais le point │ À EXAMINER (1)          │
│ ┃ dès leurs retours.                                               │ [DeskZen]  Votre réponse│
│ ┃ ┌ MISSIONS (2) ────────────────────────────────────────────────┐ │ ─────────────────────── │
│ ┃ │ ▮ VUBOX     ● en cours 3m12 · bash npm test        [Ouvrir ›]│ │ Tous les musiciens (15) │
│ ┃ │ ▮ REMOTEPAD ● en cours 0m40 · ! sans progrès       [Ouvrir ›]│ │ Mis de côté (13)      ▸ │
│ ┃ └──────────────────────────────────────────────────────────────┘ │                         │
│                                                                    │                         │
│ ┌ RÉSULTATS REÇUS (2) · 1 terminé · 1 échec ──────────────────────┐ │                         │
│ │ ▮ VUBOX     ✓ 3m12 · 0,42 USD  Tests réussis ; 2 avertissements │ │                         │
│ │ ▮ REMOTEPAD ✕ 0m48 · coût non fourni  Compilation arrêtée : …   │ │                         │
│ └────────────────────────────────────────────────────────────────┘ │                         │
│ ┃┃♛ CHEF — POINT SUR LES RÉSULTATS · 09:40                          │                         │
│ ┃┃ prend en compte : [vuBox ✓] · [RemotePad ✕]   ⓘ reçus avant ce tour                       │
│ ┃┃ vuBox est vérifié. RemotePad reste bloqué sur la dépendance … ;  │                         │
│ ┃┃ je propose … — tu valides ?                          [Lire tout]│                         │
├────────────────────────────────────────────────────────────────────┴─────────────────────────┤
│ À : CHEF   [📎] Écrivez au chef…                                                   [Envoyer] │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
  serveur v0.21.0
```

Règles :

- **Fil ≈ 2/3, seule zone qui défile.** Bulle utilisateur à droite ; chef à gauche, liseré ambre `┃`, activité repliée avec compteur. Aucune carte chef dupliquée : son état est dans l'en-tête.
- **Bloc MISSIONS** dans le tour chef : ligne créée au `tool_use Bash dispatch.mjs <X>` du chef (« lancée »), passe à « démarrée » au `system/init` de X, puis suit `/api/pupitre` (activité, tour, stall, PID). À la fin : icône d'issue + lien vers la carte du panier ; le texte reste une ligne. Un musicien actif sans dispatch du chef observé (`@X`, file, relais chef) apparaît dans **ACTIVITÉ DE L'ORCHESTRE**, bloc séparé sous le dernier tour — jamais « mission » sans preuve.
- **Panier « Résultats reçus »** : moteur 0.18 inchangé (`_fileResult`, `_appendResultGroup`, `_flushPendingResults`). Une ligne d'en-tête « n reçus · issues », cartes repliées si n > 1, aperçu si n = 1. Coût absent = « non fourni ». Un notify manuel = « Information de X », sans coche.
- **Point sur les résultats** : tour chef consécutif à un `wake` observé ⇒ en-tête `CHEF — POINT SUR LES RÉSULTATS`, liseré double, « prend en compte » (existant `takingHtml`) avec puces ouvrant carte + musicien, aide « résultats reçus avant ce tour ». Un résultat arrivé après le début du point va dans un **nouveau** panier, jamais ajouté rétroactivement. Sans origine wake observée (rechargement) ⇒ bulle chef ordinaire avec « prend en compte ».
- **À votre attention** : une ligne, priorité question > processus perdu > échec > sans progrès ; l'élément le plus grave est lisible sans clic ; `▾` déplie la liste avec actions (Répondre via le chef, Ouvrir). Limite Claude et flux interrompu sont des **bandeaux système** distincts, un seul visible (le plus grave), les autres en compteur.
- **Rail PILOTAGE** (300–360 px) : EN COURS, À EXAMINER (`input`, `error`, `awaitingChef`, stall/PID), puis « Tous les musiciens (n) » et « Mis de côté (n) ». Tri d'attention stable, nom à priorité égale, réordonnancement différé de 1,5 s, jamais sous le pointeur. Chaque ligne = `PupitreRow` (2ᵉ ligne 0.17.0). Un parké ouvert affiche « santé non suivie ».
- **Musiciens / chercher** : accessible partout, inclut les parkés, ouvre le détail.
- **Composer** : cible affichée « À : CHEF » ; brouillon conservé ; contexte de réponse (« réponse à la question de DeskZen ») retirable ; si le chef a un tour vivant, libellé « Envoyer et interrompre le tour du chef ». `@X` reste possible, affiché comme envoi direct.

### 3.2 Niveau 1 : dépliages sur place

```
┃ ┃ ▾ VUBOX   ✓ terminé 3m12 · 0,42 USD · opus-4-8 (observé)
┃ ┃   Demande : « Lance npm test, corrige les avertissements bloquants »
┃ ┃   Conclusion : Tests réussis (42/42). Deux avertissements non bloquants…   [Texte complet ›]
┃ ┃   Information de vuBox 09:37 : « point intermédiaire : 3 tests … »        ← /api/notify
┃ ┃   [Ouvrir vuBox ›]  [En parler au chef]  [Marquer lu]
```

- `input` : question visible (« question abrégée » si issue de `lastLine` tronqué, avec « voir le texte source »), **[Répondre via le chef]** (prépare un message au chef citant la question et nommant X), **[Répondre directement à X]** secondaire (envoi `@X`, mention « mis en file si X est occupé »).
- `awaitingChef` : « ⇄ Attend le chef — a demandé : … » puis « décision du chef : … » quand le relais est observé (`[CHEF_ANSWER]` dans le log de X). Lien établi seulement via les marqueurs existants ; sinon événements séparés.
- `result.synthetic` : « ⟲ clos par le système : interrompu / limité jusqu'à … », gris, jamais rouge.
- Déplier un résultat envoie `mark-read` ; « lu » n'efface rien et n'acquitte pas.

### 3.3 Niveau 2 : détail musicien `#/m/<X>`

```
┌────────────────────────────────────┬───────────────────────────────────────────────────────┐
│ CHEF (conversation conservée,      │ [‹ Retour au chef]   REMOTEPAD   [Musiciens] [⋮]      │
│  ancre, dépliages, brouillon)      │ Musicien piloté par le chef · mission « compiler … »  │
│                                    │ ● En cours · ! sans progrès 1m12                      │
│  ┃ ┌ MISSIONS ────────┐            │ tour 0m48 · dernier progrès 1m12 · processus ✓ · opus │
│  ┃ │ ▮ REMOTEPAD ● … │◀ surlignée │ snapshot il y a 2 s                  [Santé / session]│
│  ┃ └──────────────────┘            ├───────────────────────────────────────────────────────┤
│                                    │ [Activité] [Dernier résultat] [Journal récent]        │
│                                    │ 09:31:02 ▸ réflexion (repliée)                        │
│                                    │ 09:31:05 ⚙ Bash  ./gradlew assembleDebug        [▾]  │
│                                    │          └ sortie 42 lignes                     [▸]  │
│                                    │ 09:31:50 …texte en cours▌                             │
│                                    │ ⚠ 3 Mo non reçus par le flux — contenu sur disque     │
│                                    │                    Suivi suspendu · 4 nouveaux [Bas ↓]│
│                                    ├───────────────────────────────────────────────────────┤
│                                    │ [En parler au chef]           [Actions avancées ⋮]   │
└────────────────────────────────────┴───────────────────────────────────────────────────────┘
```

- Le volet **remplace le rail** et s'élargit (≈ 55 %) ; sur fenêtre étroite il devient pleine largeur avec retour explicite. Le fil ne défile pas ; `Échap` / `‹` = `history.back()` ; le focus revient à l'élément d'origine.
- **Activité** = `PupitreDetail` (backfill `/api/project/:name/events?n=200` puis SSE) ; arguments longs et `tool_result` repliés, copiables ; notices de transport rendues en ligne grise.
- **Dernier résultat** = issue, texte servi, durée, coût, question éventuelle, liens livrables (`/downloads/...` si enregistrés). Ouvrir depuis une carte ancienne vise cet onglet.
- **Journal récent** = événements bruts horodatés ; mention « fenêtre bornée (500 événements / 2 Mio) », pas de faux « tout l'historique ».
- **En-tête** = ligne `/api/pupitre` (mêmes champs que `renderCardMeta`), `—` pour les mesures absentes, « processus inconnu » si `pidAlive:null`.
- **Action principale : En parler au chef** (retour au composer chef, projet nommé, extrait cité). **Actions avancées** : Envoyer directement à X (cible et file explicites), parquer, sessions, outils, provider, marquer lu, ouvrir `/pupitre`.

### 3.4 Routes secondaires

`#/pupitre` (tableau de santé existant, intégré), `#/reglages` (projets, chef, provider, palette, version), `#/telechargements`.

---

## 4. Design validé — Android

Trois destinations NavHost au lieu d'un `setContent` unique : **Journal** (racine), **Détail musicien**, **Réglages**. Deux feuilles : **Pilotage** (rail mobile) et **Mission/Résultat** (L1).

```
Journal                               Feuille Pilotage                     Détail musicien
┌────────────────────────────┐        ┌────────────────────────────┐        ┌────────────────────────────┐
│ ♛ CHEF répond… · sync 3 s ⋮│        │ PILOTAGE          [Fermer] │        │ ‹ Chef   REMOTEPAD    [⋮]  │
│ Pilotage : 2 en cours ·    │        │ [Rechercher un musicien…]  │        │ Musicien · « compiler … »  │
│            1 question    › │        │ [En cours][À examiner][Tous]│       │ ● En cours · ! sans progrès│
│ ⚠ DeskZen : « Quelle … » ▾ │        │ vuBox          En cours    │        │ tour 0m48 · proc ✓ · opus  │
│────────────────────────────│        │  bash npm test · 3m12      │        │ snapshot il y a 4 s        │
│            ┌ Vérifie … ┐   │        │ RemotePad      En cours !  │        │────────────────────────────│
│ ┃♛ 09:31 ▸ 3 outils        │        │ DeskZen   Votre réponse    │        │ [Activité][Résultat][Journal]│
│ ┃ Je leur confie …         │        │ BookHaven  Attend le chef  │        │ 09:31 ⚙ Bash ./gradlew  [▾]│
│ ┃ MISSIONS (2)             │        │ Mis de côté (13)         ▸ │        │       └ sortie 42 l.    [▸]│
│ ┃  ▮ vuBox     ● 3m12      │        └────────────────────────────┘        │ 09:31 …texte▌              │
│ ┃  ▮ RemotePad ● ! stall   │                                              │ 6 nouveaux  [Rejoindre ↓]  │
│ RÉSULTATS REÇUS (2)      › │  tap ligne de mission → feuille L1           │────────────────────────────│
│ ┃┃♛ POINT SUR LES RÉSULTATS│  « Ouvrir » → écran détail                   │ [En parler au chef]        │
│ ┃┃ prend en compte …       │  Retour → clavier/feuille, puis détail,      └────────────────────────────┘
│ ┃┃ vuBox passe… [Lire tout]│  puis journal à la même ancre
│────────────────────────────│
│ À : CHEF [+] Message… [➤]  │
└────────────────────────────┘
  app 0.6.0 · serveur 0.21.0
```

- **Ligne « Pilotage »** stable sous l'en-tête (compteurs), tap ⇒ feuille Pilotage avec recherche (parkés inclus), filtres, sélection qui ne bouge pas pendant un geste. La `TabBar` actuelle disparaît fonctionnellement.
- **Lignes de mission** inline (même règle que le web). Tap ⇒ bottom sheet L1 (demande, conclusion, durée/coût, boutons). « Ouvrir » ⇒ écran détail à trois onglets (`TelemetryStrip` + `ProjectSession` existants).
- **Nouveau rapport pendant la rédaction** : brouillon et scroll conservés, pastille « Nouveau rapport ↓ ».
- **Retour** : clavier/feuille, puis détail, puis journal à l'ancre d'origine (`LazyListState` conservé).
- **Santé** : badges `deadInFlight` / `stalled` sur les lignes de mission et la feuille ; âge du snapshot dans l'en-tête ; synthétique = gris `⟲`, jamais rouge.
- **Version** : `versionName` Android (existant) + version serveur via `/api/version` (nouveau) dans l'en-tête / À propos.
- Zones tactiles ≥ 48 dp, libellés TalkBack sur les badges, rien réservé au survol. Arrière-plan : SSE et poll s'arrêtent comme aujourd'hui ; au retour, snapshot + historique + événements récents du musicien ouvert, fusion sans doublon ; aucune promesse de push.

---

## 5. Parcours d'une demande

| Étape | Utilisateur voit | Autorisé par |
|---|---|---|
| 1. Demander | Bulle « Vous », envoi accepté (202) ou échec avec brouillon conservé ; ♛ « répond… » dans l'en-tête | HTTP puis `user_prompt` sans source + `system/init` du chef (0.16.1) |
| 2. Le chef pilote | Réponse chef, activité repliée ; bloc MISSIONS « lancée » puis « démarrée » ; rail EN COURS | `tool_use Bash dispatch.mjs X` du chef ; `system/init` de X |
| 3. Les musiciens travaillent | Ligne de mission : activité, tour, badges santé ; « Ouvrir » ⇒ détail, retour à l'ancre ; notify intermédiaire = « Information de X » sous la ligne | SSE + `/api/pupitre` ; chef au repos = normal |
| 4. Question | Musicien → utilisateur : encart dans le fil + Attention + ligne `?` ; **Répondre via le chef** (défaut) / direct (secondaire). Musicien → chef : ligne « ⇄ attend le chef » puis « décision : … ». Chef → utilisateur : bulle Question conservée | Sentinelles, `notification/musician_question`, relais `[NEEDS_CHEF_INPUT_FROM]`/`[CHEF_ANSWER]` |
| 5. Résultats | Panier « Résultats reçus (n) » après le tour chef (jamais au milieu) ; lignes de mission ✓/✕ pointant vers le panier ; toast groupé | `notification/musician_done` ; moteur 0.18 |
| 6. Point | Bandeau discret « le chef prépare son point » si `wake` observé ; puis `CHEF — POINT SUR LES RÉSULTATS`, « prend en compte », puces ; un résultat tardif ⇒ nouveau panier | `user_prompt{source:'wake'}` + `system/init` (0.20.0) ; aucun compte à rebours, aucun « réveil en attente : n » tant que `/api/pupitre` ne l'expose pas |
| 7. Suite | Répondre au chef ; « Demander un point au chef » préremplit une demande nommant les résultats (si le wake a été annulé ou différé) | Prompt utilisateur (annule le panier wake côté serveur, `:4033`) |

Une demande peut traverser plusieurs tours ; **aucune clôture automatique de demande** au dernier `done`. Les missions ouvertes restent visibles ; « tout est terminé » n'appartient qu'au texte du chef.

---

## 6. Différenciation graphique

| Voix | Forme | Typo | Marqueurs |
|---|---|---|---|
| Utilisateur | bulle pleine, droite, label Vous | Chakra Petch | contexte de réponse retirable |
| Chef | bloc gauche, label CHEF, liseré ambre `┃`, largeur de lecture | Chakra Petch | `♛` ; Point = `┃┃` + « POINT SUR LES RÉSULTATS » ; Question = badge |
| Musicien | **ligne de mission / carte mono en retrait, jamais une bulle**, nom en capitales ouvrable | JetBrains Mono | `●` en cours · `◐` réflexion · `✓` terminé · `?` votre réponse · `⇄` attend le chef · `✕` échec · `⟲` clos système · `○` prêt |
| Système | bandeau fin plein-largeur (un seul) ou badge | petites capitales | `⚡` limité jusqu'à … · `⟲` flux interrompu · `✗` processus perdu · `!` sans progrès · `⏳` point en préparation (P1) |

Couleurs d'état : celles de PHOSPHOR déjà câblées sur `data-state` (`styles.css:460-481`), inchangées. Badges additifs par clé :

| Clé | Badges | Source |
|---|---|---|
| `live` / `think` | `⏱ 3m12` · `! sans progrès` · `✗ processus perdu` · `⏳ attendu par le chef` (P1) | `/api/pupitre` |
| `unread` | `✓` · `⇄ attend le chef` · coût | `notification`, `awaitingChef` |
| `input` | question 1 ligne (« abrégée » si tronquée) | `needsInput`, `lastLine` |
| `error` | raison courte | `result.subtype` |
| `idle` | `⟲ interrompu` · `⚡ limité jusqu'à …` (10 min) · « santé non suivie » (parké) | `result.synthetic`, `limitedUntil`, `parked` |

Fraîcheur : « synchronisé il y a X s » (âge du snapshot) ; > 15 s sans snapshot ⇒ valeurs grisées et datées, halos suspendus ; SSE coupé avec snapshot OK ⇒ « états actualisés, direct interrompu » ; jamais « tout est mort » sur une coupure de flux. Mouvement réduit respecté ; pas de clignotement continu.

---

## 7. Divulgation progressive

| Objet | L0 — sans action | L1 — déplier / feuille | L2 — ouvrir |
|---|---|---|---|
| Mission | nom, état, une ligne (sujet ou activité), anomalie prioritaire | demande, durée, modèle, progrès, file, notes | activité, dernier résultat, journal |
| Résultats | « n reçus · issues », aperçu si unique | cartes : conclusion ≤ 280 c., issue, durée, coût | résultat source, contexte musicien |
| Point du chef | conclusion, « prend en compte », décision attendue | texte entier, activité du chef regroupée | résultats référencés |
| Question | question courte, destinataire, action | texte disponible, contexte | événements source, troncature signalée |
| Santé | « processus perdu » / « sans progrès » | âge des données, dernier progrès, limite | PID, modèle observé/configuré, cause |

Règles anti « trop d'un coup » : un bloc MISSIONS par tour chef ; un panier par vague ; un toast groupé ; le point rendu en un bloc au `result` du chef ; rien ne se déplace dans le fil ; le rail se réordonne après 1,5 s ; réflexion du chef repliée ; un seul bandeau système ; notices de transport uniquement en L2 ; replier ne détruit rien ; un nouveau résultat ne referme pas ce qu'on lisait.

---

## 8. Plan d'implémentation pour Opus 5

Tout est **additif** sauf mention **[noyau]**. Aucune chaîne d'état, aucun événement CLI, aucun réducteur ne change. Client web = rechargement dur ; Android = build `versionCode +1` ; serveur = **un** redémarrage groupé par le chef, uniquement si un lot P1 serveur est retenu. Chaque lot porte sa version + entrée `CHANGELOG.md`.

### P0 — la conversation de direction, les missions, la plongée (web 0.21.0, Android 0.6.0 / vc15)

| # | Lot | Fichiers web | Fichiers Android | Critère de réception |
|---|---|---|---|---|
| P0-1 | **Disposition** : fil ≈ 2/3 + rail PILOTAGE (EN COURS / À EXAMINER / Tous / Mis de côté), tri différé 1,5 s, état du chef dans l'en-tête, suppression de la scène de cartes et de `#chef-card` | `public/index.html` (`#fleet-panel`, `#arc`, `#chef-card`, `#threads`), `public/app.js` (`computeLayout`, `attentionRank`, `buildCard` → lignes `PupitreRow`), `public/styles.css` | — | À l'ouverture : fil lisible, ≤ 8 lignes de rail par défaut avec 15 actifs ; parkés jamais visibles sans dépliage |
| P0-2 | **Bloc MISSIONS** : créer la ligne au `tool_use Bash` du chef contenant `dispatch.mjs <X>` (regex sur `input.command`, X validé contre `/api/config`) ; « démarrée » au `system/init` de X ; mise à jour par `/api/pupitre` ; issue + lien vers la carte du panier au `notification` ; bloc ACTIVITÉ DE L'ORCHESTRE pour les tours sans dispatch chef observé ; rehydratation via `/api/project/<chef>/events?n=500` | `app.js` (`onConductorEvent` branche `assistant`, `onFleetEvent`, `_conductorBubbleHtml`, `loadChatHistory`), `styles.css` | `FleetViewModel.kt` (même règle), `MainPane.kt` (composable `MissionLine`) | Dispatch de A par le chef ⇒ ligne A dans son tour en < 1 s ; A termine ⇒ ligne ✓ pointant vers la carte ; rechargement ⇒ mêmes lignes ; `@A` par l'utilisateur ⇒ bloc Activité, pas Mission |
| P0-3 | **Panier → Point** : conserver `_fileResult`/`_appendResultGroup`/`_flushPendingResults` ; en-tête de panier avec issues ; « coût non fourni » ; « Information de X » pour un notify ; mémoriser le `wake` masqué jusqu'au `system/init` suivant ⇒ en-tête « POINT SUR LES RÉSULTATS », liseré double, puces cliquables, aide « reçus avant ce tour » ; résultat tardif ⇒ nouveau panier | `app.js` (`onConductorEvent` branches `user_prompt{source:'wake'}`, `system/init`, `result` ; `takingHtml`), `styles.css` | `FleetViewModel.kt` (`onConductorEvent`), `MainPane.kt` (`ResultsBasket`, `TakingLine`) | Réveil ⇒ la bulle suivante est un Point ; prompt utilisateur ⇒ bulle normale ; 3 fins en 10 s pendant un tour chef ⇒ un panier après la réponse |
| P0-4 | **Questions via le chef** : encart « Question de X · votre décision » ; défaut **Répondre via le chef** (préremplit un message au chef : `Réponse pour X à sa question « … » : `) ; **Répondre directement à X** secondaire (`@X`, mention file) ; `awaitingChef` ⇒ « attend le chef » + décision observée ; question chef conservée | `app.js` (`_conductorBubbleHtml` `is-question`, composer contexte), `index.html` (`#composer` zone contexte) | `MainPane.kt` (`QuestionBubble`), `FleetScreen.kt` (`Composer`, `QuotePreview`) | Clic Répondre ⇒ cible « À : CHEF » avec contexte ; l'envoi direct n'arrive que par l'action secondaire |
| P0-5 | **Attention + bandeaux** : ligne « À votre attention » repliée (priorité question > PID mort > échec > stall), dépliage avec actions ; un seul bandeau système (perdu > limité > reconnexion) ; vocabulaire de fraîcheur (synchronisé / flux interrompu / données anciennes) ; `pidAlive:null` = inconnu ; parké = santé non suivie | `app.js` (`setConnState`, `applyPupitreToCards`, nouveau `renderAttention`), `styles.css` | `FleetScreen.kt` (bannière existante `:154-170` étendue) | Une erreur silencieuse apparaît en Attention sans ouvrir de carte ; SSE coupé avec snapshot OK ⇒ « direct interrompu », cartes non grisées |
| P0-6 | **Détail routé** `#/m/<X>` : volet remplaçant le rail, onglets Activité / Dernier résultat / Journal récent, en-tête `/api/pupitre`, notices de transport rendues, « En parler au chef » principal, Actions avancées ; `hashchange` sans bibliothèque ; restauration ancre/dépliages/brouillon/focus ; « Musiciens / chercher » global (parkés inclus) | `index.html` (`#overlay-focused` → `#dive`), `app.js` (nouveau `router`, réutilise `PupitreDetail`/`PupitreRow`, `startPupitrePoll`), `styles.css` | — | Ouvrir/fermer 10× ⇒ scroll du fil identique ; lien `#/m/X` direct ; `Échap` = retour ; focus restitué |
| P0-7 | **Android navigation** : NavHost (Journal / Détail / Réglages), ligne « Pilotage » + feuille avec recherche et filtres (remplace `TabBar`), bottom sheet L1, détail à onglets, « Nouveau rapport ↓ », version serveur | — | `MainActivity.kt` (NavHost), `FleetScreen.kt`, `TabBar.kt` (→ `PilotageSheet`), `MainPane.kt`, `Api.kt` (`/api/version`), `build.gradle.kts` (vc15) | Back depuis détail ⇒ journal à la même ancre ; `live→think` ne déplace rien ; version serveur visible |

### P1 — attente visible, robustesse, parité (web 0.22.0, Android 0.7.0 / vc16 ; **serveur 0.21.0, un redémarrage**)

| # | Lot | Côté | Fichiers |
|---|---|---|---|
| P1-1 | `/api/pupitre` : `expectCallback` par membre, `pendingWake`, `lastWakeAt` en racine (P1 déjà prévu du design réveil) ⇒ badge `⏳ attendu par le chef`, bandeau « point en préparation (n) » | serveur + clients | `server.js` (`/api/pupitre`, `reduceMusician` déjà porteur), `app.js`, `FleetViewModel.kt` |
| P1-2 | `/api/conductor-chat` : `wake:true` sur l'entrée `conductor` qui suit un prompt `wake` ⇒ le Point survit au rechargement | serveur + clients | `server.js:2281-2308`, `app.js` `loadChatHistory`, `FleetViewModel.kt` `loadConductorHistory` |
| P1-3 | Trous de flux et historique borné explicites (`log_growth_skipped`, fenêtre 2 Mio) ; réconciliation au retour/rechargement sans tout marquer lu | clients | `app.js`, `pupitre-detail.js`, `FleetViewModel.kt` |
| P1-4 | Accessibilité : ordre de focus, TalkBack, grandes polices, mouvement réduit ; libellés identiques web/Android | clients | `styles.css`, composables |
| P1-5 | Réglages/sessions/livrables rangés derrière `#/reglages`, `#/telechargements`, menu ⋮ ; « Demander un point au chef » (préremplissage, sans auto-dispatch) | web | `index.html`, `app.js` |

### P2 — hygiène et dette

- Supprimer `computeDesktopArc`, `computeFanLayout`, `wireFanSwipe`, `deckRotate`, `renderFocusedBody` et ses sélecteurs orphelins (`app.js:581-738`, `:1375-1420`, `:2940-3039`), les CSS de la scène (`#threads`, halos de grille).
- Fusionner `attentionRank` (`app.js:514`) et `PupitreRow.rank` ; une seule règle d'ordre du fil partagée live / historique / Android.
- Découper `app.js` en modules ES sans bundler (`router.js`, `thread.js`, `missions.js`, `rail.js`, `dive.js`, `attention.js`) ; persister les tweaks (`localStorage`) ; remplacer `alert()`.
- Intégrer `/pupitre` comme route `#/pupitre` ; partager `PupitreRow`/`PupitreDetail` avec la page.
- Dépendances serveur facultatives : identifiants durables de tour/résultat, historique paginé — uniquement si un besoin concret apparaît.

### Écarté

Grille de flotte ou onglets musiciens au premier niveau ; bulles pour les musiciens ; nouvelle chaîne d'état (`stalled`, `waiting_chef`, `report`, `limited`) ; auto-dispatch côté client ; compte à rebours de rapport ; « 2 sur 3 » sans liste connue ; réponse directe `@X` implicite au clic.

---

## 9. Garde-fous de production

| Acquis | Non-régression exigée |
|---|---|
| **0.16.1** chef figé | `_awaitingConductorResponse` armé uniquement par prompt sans source / `system/init`, désarmé par `result` ou filet PID (`_conductorLivenessCheck`). Un `wake` sourcé n'arme rien ; le bloc MISSIONS et le Point ne touchent pas ce drapeau. |
| **0.17.0** santé | Polls `/api/pupitre` 5 s / 2,5 s inchangés, cache serveur, skip parked, 2ᵉ ligne réutilisée dans rail et en-tête de détail ; aucun poll par ligne. |
| **0.18.0** panier | `_makeResultItem` / `_fileResult` / `_appendResultGroup` / `_flushPendingResults` conservés ; la ligne de mission **pointe** vers la carte, ne la duplique pas ; question chef conservée ; synthétique ≠ erreur. |
| **0.19.0** parité | Android garde snapshot, stall, PID, seconde ligne, limite, panier/questions ; sélection stable. |
| **0.20.0** réveil | Seul le serveur réveille ; l'UI n'affiche jamais le prompt `wake` ; aucun bouton ne déclenche un wake ; « Demander un point » = message utilisateur ordinaire (qui annule le panier wake, comportement voulu `server.js:4033`). |
| **Vocabulaire** | `idle|live|think|input|error|unread` intacts dans tous les réducteurs, `data-state` et `Musician.kt` ; les cinq états du contrat visuel sont des libellés/badges. |
| **Sécurité** | Token gate, argv tableau, aucun dispatch implicite, envoi direct toujours explicite ; routes admin hors du fil. |
| **Versioning** | Chaque lot = bump + `CHANGELOG.md` ; Android `versionCode +1` ; version serveur affichée web et Android. |
| **Process** | Aucun lot P0 ne nécessite de redémarrage serveur ; P1-1/P1-2 en un seul redémarrage groupé décidé par le chef. |

Scénarios de réception (à rejouer par Opus 5, repris d'Astra) : trois fins pendant un tour chef ⇒ un panier après la réponse ; A ✓ B ✕ C en cours ⇒ point partiel, C visible ; question pendant un point ⇒ encart immédiat, réponse via le chef ; `awaitingChef` ⇒ badge puis décision ; notify puis résultat ⇒ information puis carte, un seul wake ; PID vivant silencieux / mort / inconnu / données anciennes ⇒ quatre rendus ; wake différé ou quota ⇒ pas de compte à rebours ; rechargement ⇒ missions, paniers, questions reconstruits, wake invisible ; parké ouvert ⇒ santé non suivie ; ouvrir, lire, recevoir un point, revenir ⇒ scroll, focus, brouillon intacts.

*Rapport non committé — le chef décide. Aucun autre fichier touché.*
