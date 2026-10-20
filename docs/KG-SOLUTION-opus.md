# Graphe de connaissances pour l'orchestrateur — étude indépendante (auteur : Opus 5.5)

> Demande de l'utilisateur (2026-10-20, verbatim) : « Prochaine etude a faire avec les
> meme models : Les Graphes de Connaissances (Knowledge Graphs). Je veux rajouter ceci a
> l'orchestrateur, ca l'aidera dans les decisions, et le travail en general. Lances
> l'etude avec les differents models, appliquee a l'orchestrateur »
>
> Méthode : trois auteurs indépendants (Opus 5.5, Fable 5.1, Astra), puis une synthèse.
> Ce document est l'avis d'**Opus 5.5** (`claude-opus-5-5`). Les études des deux autres
> auteurs n'ont pas été lues. Étude seulement : aucun code, aucun redémarrage, rien
> écrit sous `I:\orchestrateur` (journaux lus le 2026-10-20 en lecture seule, prod en
> v0.119.0, orchestrateur-dev au commit ddb1729). Document à articuler avec
> `ROUTAGE-SYNTHESE.md` (§5) et `PIPELINES-SYNTHESE.md` (§11).

---

## 0. Résumé en une page

**Thèse.** L'orchestrateur n'a pas besoin d'un « GraphRAG » ni d'une base de graphe. Il
a besoin d'une **carte des liens** entre ce qu'il possède déjà en fichiers, et d'une
**petite couche de faits datés et sourcés** : décisions, règles, préférences, incidents.

Aujourd'hui, ces liens existent, mais à la main, dans la tête du chef ou dans 3 600 lignes
de `CLAUDE.md` :

- chef : 639 lignes ;
- orchestrateur-dev : 2 963 lignes.

Les liens existants sont de trois sortes :

- des tableaux recopiés d'une synthèse à l'autre (`PIPELINES-SYNTHESE.md` §11.1 :
  décision → tests d'exigence) ;
- des `[[liens]]` entre mémoires ;
- `regression-perimeters.json` (fichier → périmètre → suites).

**Ce que je propose — « la Carte » :**

1. **Graphe dérivé, reconstruit par le code**, sans model.
   - Sources : `config.json`, `run.json`, `regression-perimeters.json`, les
     `USER_REQUIREMENTS.md`, `CHANGELOG.md`, `TODO_LIST.md`, `model-routing.json`, les
     mémoires et les sections « Décisions de l'utilisateur » des synthèses.
   - Il est jetable, reconstruit en quelques secondes et n'est jamais une source de vérité.
2. **Journal de faits** `logs/kg/facts.jsonl`, en ajout seul.
   - Chaque fait porte une provenance (fichier:ligne, commit, exécution, citation exacte),
     des dates de validité (`valide_depuis`, `valide_jusqua`) et un statut
     (`certain` | `proposé` | `validé` | `périmé` | `contredit`).
   - Un model ne fait que **proposer**. Le code vérifie que la citation existe.
     L'utilisateur valide, corrige ou périme.
3. **Interrogation par le code**, par requêtes typées, jamais par mots-clés :
   - `fiche <projet>`, `impact <fichier>`, `règles <contexte>`, `précédents <situation>`,
     `model <case>`, `explique <id>` ;
   - un bloc « Mémoire utile » d'au plus 1 200 tokens dans le contexte compact du chef
     (Routage v3) ;
   - au plus 800 tokens dans le dispatch d'un musicien.
4. **Dans le dashboard** :
   - un onglet « Mémoire » (valider, corriger, périmer) ;
   - une section « Liens » dans l'overlay des identifiants existant (`id-resolve.mjs`,
     0.107.0).

**Effort** : environ 8,5 jours en 5 phases. La phase 0 (2 j) est utile seule, sans aucun
model.

Tout est basculable à chaud (`kg.*` dans `model-routing.json`). « Off » rend exactement le
comportement actuel.

---

## 1. État de l'art (sourcé, daté)

Légende : **[V]** vérifié sur la source primaire ; **[S]** source secondaire ou propos du
vendeur ; **[NV]** non vérifié pendant cette étude. Recherche web faite le 2026-10-20.

### 1.1 GraphRAG et variantes

**GraphRAG (Microsoft)** — arXiv 2404.16130, avril 2024 **[NV]**.
- Indexation : extraction d'entités par LLM, puis communautés de Leiden, puis résumés de
  communautés. Coûteuse.
- Version 1.0 en décembre 2024 **[S]**.

**LazyGraphRAG** — Microsoft Research, fin 2024 **[S]**.
- Remplace l'extraction par LLM par du NLP de groupes nominaux.
- Coût d'indexation annoncé : 0,1 % de GraphRAG ; requêtes globales plus de 700 fois moins
  chères. Ce sont des chiffres du vendeur seul.
- Source : https://www.microsoft.com/en-us/research/blog/lazygraphrag/

**LightRAG** — arXiv 2410.05779, v3 du 2025-04-28 **[V]**.
- Récupération à deux niveaux, mises à jour incrémentales.

**HippoRAG 2** — arXiv 2502.14802, ICML 2025 **[V]**.
- +7 % en mémoire associative.
- Les auteurs notent eux-mêmes que les RAG à graphe font **moins bien que le RAG simple**
  sur la mémoire factuelle de base.

**GraphRAG-Bench** — arXiv 2506.05690, v3 du 2026-02-22 **[V]**.
- Constat : « GraphRAG frequently underperforms vanilla RAG on many real-world tasks ».
- Le graphe aide surtout le raisonnement multi-sauts et la synthèse globale.

**Han et al., « RAG vs. GraphRAG »** — arXiv 2502.11371, 2025 **[S]**.
- Les deux approches sont complémentaires ; l'hybride l'emporte.

### 1.2 Mémoire en graphe des agents

**Zep / Graphiti** — arXiv 2501.13956, janvier 2025 **[V]**.
- Graphe **bi-temporel** :
  - temps de l'événement : `t_valid` / `t_invalid` ;
  - temps d'enregistrement : `t'_created` / `t'_expired`.
- Une contradiction **invalide** l'ancienne arête au lieu de la supprimer.
- Écritures par requêtes **prédéfinies**, jamais générées par le LLM.
- Résultats : DMR 94,8 % ; LongMemEval jusqu'à +18,5 % et −90 % de latence.
- graphiti-core 0.29.x en 2026, avec un serveur MCP **[S]**.
- C'est la meilleure référence pour la **temporalité**, mais elle exige Neo4j, FalkorDB
  ou Kuzu et des embeddings.

**Mem0 / Mem0g** — arXiv 2504.19413, 2025-04-28 **[V]**.
- Sur LOCOMO : +26 % face à la mémoire d'OpenAI, −91 % de latence p95.
- La **variante graphe n'ajoute qu'environ 2 %**.
- Le benchmark LOCOMO est contesté **[S]** : 10 conversations synthétiques, résultats non
  reproduits, querelles entre vendeurs.

**Letta (ex-MemGPT)**, billet d'août 2025 **[S]**.
- Un simple **système de fichiers** consulté par l'agent atteint 74,0 % sur LoCoMo et bat
  des bibliothèques mémoire spécialisées.
- C'est l'argument le plus fort pour garder les fichiers comme socle.

**A-MEM** — arXiv 2502.12110 **[S]**.
- Notes liées de type Zettelkasten ; une note neuve peut réécrire les anciennes.
- Le risque de dérive est connu.

**Cognee 1.x** (2026, Python, graphe + vecteurs) **[S]**. Les dates de version sont
incohérentes selon les sources.

**Serveur MCP « memory » officiel** **[V]**.
- Graphe en un fichier `memory.jsonl` : entités, relations, observations ; 9 outils.
- Ni temporalité, ni provenance, ni confiance.
- C'est le format le plus proche de la règle « JSONL sans base de données », mais il est
  trop pauvre tel quel.
- Source : https://github.com/modelcontextprotocol/servers/blob/main/src/memory/README.md

### 1.3 Outils légers et locaux (pour Node)

| Outil | Embarqué Node | État (2026-10) | Pour nous |
|---|---|---|---|
| Objets JS + JSON/JSONL | oui | — | **suffisant** (≈ 30 000 nœuds, §3.1) |
| graphology (MIT, JS pur) | oui | maintenu, v0.26 **[S]** | à garder en réserve si des algorithmes deviennent utiles (PageRank, composantes) |
| N3.js / Turtle / JSON-LD | oui | **[NV]** | RDF sans intérêt ici : pas d'interopérabilité requise |
| Oxigraph (RDF/SPARQL en WASM) | oui | **[S]** | surdimensionné |
| KuzuDB | natif | **archivé le 2025-10-10**, v0.11.3 **[V]** | à exclure |
| LadybugDB (fork de Kuzu, `@ladybugdb/core`) | natif N-API | 0.19.x en 2026 **[S]** | seule base embarquée crédible, **si** une base devenait un jour nécessaire (décision D2) |
| SQLite + GraphQLite, DuckDB + duckpgq | — | jeunes ou expérimentaux **[S]** | contraires à « No database » |
| Neo4j, FalkorDB(Lite), Cozo | serveur, Python ou abandonné | — | à exclure |

### 1.4 Modélisation

- **Graphe de propriétés** (arêtes porteuses d'attributs : dates, confiance, source)
  plutôt que RDF. La provenance s'inspire de **PROV-O** (W3C, 2013-04-30) : *dérivé de*,
  *produit par*, *attribué à*.
- **Bi-temporalité** selon Zep, mais tenue **par le code** : un remplacement explicite
  plutôt qu'une contradiction jugée par LLM à chaque écriture.
- **Ontologie fermée et petite** **[S]** : laisser le LLM inventer des types de nœuds
  « crée le chaos ».

### 1.5 Ce qui marche, ce qui est surestimé

**Ce qui marche :**
- les **graphes déterministes** : la repo map d'Aider (tree-sitter + classement, budget
  d'environ 1 000 tokens, 2023-10-22 **[V]**), les dépendances, les liens explicites ;
- l'horodatage avec invalidation plutôt que suppression ;
- la récupération « juste à temps » par fichiers et grep (Anthropic, « Effective context
  engineering », 2025-09-29 **[V]**).

**Ce qui est surestimé :**
- l'extraction exhaustive par LLM sans résolution d'entités : graphes bruités, doublons,
  coût (DEG-RAG, arXiv 2510.14271 **[V]** ; RAGU, 2026 **[S]**) ;
- GraphRAG complet pour des questions factuelles locales ;
- les gains « graphe » des mémoires du commerce (Mem0g +2 %) ;
- les chiffres LOCOMO des vendeurs.

**Non trouvé** : aucun retour de praticien indépendant et chiffré sur la résolution
d'entités en production.

**Conséquence pour nous :**
- le corpus est petit, les questions sont **locales et structurées** (« quelle décision
  s'applique à cette case ? »), pas « globales » ;
- un graphe **dérivé par le code**, plus une **couche de faits curés**, est le bon point.
  GraphRAG n'en est pas un.

---

## 2. Ce que le graphe apporterait — cas réels

### 2.1 Données relevées (prod, 2026-10-20)

| Source | Volume |
|---|---|
| Exécutions `logs/runs/*/run.json` | 650 : 613 Routage du chef, 37 exécutions de musiciens sur 11 projets |
| Étapes de model des musiciens | `dev.rouge` opus 88 (5 refus) · `dev.vert.complexe` sonnet-5.5 **66 (29 refus, 44 %)** · `dev.livrer.git` sonnet-5.5 28 (11 refus) · `dev.vert.simple` sonnet-5.5 21 (12 refus) · `dev.revue` opus 37 (0) / astra 14 (4) · `dev.refactor` 14 (0) · `discussion.comprendre` 17 (7) |
| Motifs de refus | 75 « item déjà couvert » · 12 « aucune modification » · 9 « aucun commit créé » · 8 « fichiers de test modifiés » · 14 « lancement impossible (code 64) » · 4 quota codex · 2 OAuth expirée · 2 refus du fournisseur |
| Mémoires Claude | **175 fichiers** dans 50 dossiers `memory/`, dont 33 pour le chef |
| Exigences utilisateur | ≈ 500 lignes de registre (orchestrateur-dev 148, BookHaven 110, vuBox 82, vuBox-win 78…) |
| Versions | 1 253 entrées de CHANGELOG sur 38 projets |
| Périmètres | `regression-perimeters.json`, 1 160 lignes (fichier → périmètre → suites) |
| Règles | `CLAUDE.md` du chef (639 lignes) et d'orchestrateur-dev (2 963 lignes) |
| Journal du chef | `chef.jsonl`, **421 Mo** |

### 2.2 Huit cas concrets

**1. Règles qui se contredisent ou ont vieilli (le cas le plus probant).**

Pour le choix d'un model, trois sources coexistent dans la mémoire du chef :

- `feedback_plan_opus5_code_opus48` (2026-08-31) : « tout sur Opus 4.8 » ;
- `feedback_all_opus5` (2026-09-25) : « TOUTES les opérations sur Opus 5.5 », « ne plus
  router par nature de tâche », remplace la précédente ;
- la décision 2 du Routage (2026-10-19) : la case `routage.chef` sur
  **`claude-sonnet-5-5`**. Les cases `dev.vert.*` et `dev.livrer.git` tournent aussi sur
  sonnet-5.5.

Il y a deux problèmes :

- **La ligne d'index de `MEMORY.md` est périmée.** Elle dit encore « planification →
  Opus 5, code → Opus 4.8 », alors que le fichier lui-même se déclare caduc.
- **La directive « tout sur Opus 5.5 » n'est plus littéralement vraie.** La page Models
  l'a remplacée case par case.

Un graphe avec des liens `REMPLACE` datés et une règle « la plus spécifique et la plus
récente gagne » rend la règle en vigueur **calculable et affichable**. La contradiction
devient **visible** au lieu d'être découverte par un model qui lit la mauvaise ligne.

**2. Erreurs répétées.**

- Le chef a **deux fois** affirmé qu'Opus 5.5 n'existait pas (mémoire `feedback_all_opus5`).
- haiku sur une longue session donne « Prompt is too long » (`feedback_haiku_context_limit`,
  TradeBot).
- Le quota codex a été atteint 4 fois, l'OAuth a expiré 2 fois.

Aujourd'hui, ces leçons ne reviennent que si le model relit la bonne mémoire. Avec un nœud
`Incident` relié à sa **condition** (model = haiku ET session longue) et à sa **conduite**,
le code peut rappeler la leçon **au moment exact** : au dispatch sur haiku d'un projet dont
le fichier `.session` est gros.

**3. Analyse d'impact.**

`regression-perimeters.json` donne déjà fichier → suites. Il manque le lien suite →
**exigence** utilisateur (et donc le ⚠ « accord requis ») et exigence → **décision**.

Exemple réel : le tableau §11.1 de `PIPELINES-SYNTHESE.md` (décision 9 →
`_test_item_delivery`, `_test_release_prebump`, `_test_lane_changelog_rule`) a été
construit à la main par un model. La requête
`impact scripts/dispatch.mjs` le rend en moins d'une seconde, avec la liste des décisions
§5 et §11 qui contraignent ce fichier.

**4. Choix du model selon l'historique, avec prudence.**

Les données montrent `dev.vert.complexe` sur sonnet-5.5 refusé 44 % du temps, mais :

- les refus sont des **critères** (« aucune modification », « tests modifiés ») ;
- l'échantillon est de **37 exécutions** de musiciens.

Le graphe peut porter des arêtes `A_EXÉCUTÉ` (case, model, projet, issue, cause classée)
et alimenter les **suggestions** de la page Models (décision 16 des Pipelines). La
condition : n ≥ 20 et cause « capacité » distinguée de « critère » et « infrastructure ».
Sans ce garde-fou, le graphe pousserait une mauvaise conclusion.

**5. Routage : qui est concerné ?**

`project_fleet_ports.md` (mis à jour le 2026-08-03) indique :

- PostgreSQL 5432 **partagé** par newsParser et immo-share ;
- vuBox en « web WSL » sur 3001, alors que vuBox a migré en Windows natif le 2026-09-18
  (`project_vubox_windows_native`).

Une demande « mets à jour Postgres » concerne donc **deux** projets. Une demande sur
vuBox doit savoir que la ligne de port est périmée.

Ce sont des liens `UTILISE` / `ÉCOUTE` datés, que ni `config.json` ni le classifier ne
connaissent.

**6. Réponse automatique en l'absence de l'utilisateur.**

La règle du 2026-10-20 (inactif plus de 15 min, plus 5 min sans réponse ⇒ Opus 5.5
répond) a besoin de **précédents**. Exemple : sur les 18 décisions des Pipelines,
l'utilisateur a répondu « tout comme recommandé ».

Le graphe fournit les décisions passées **de même forme** (même type de pause, même
étape, même projet), avec leur source, pour que la réponse « auto » cite son appui.

Les **garde-fous** restent une liste fermée vérifiée hors du graphe :

- argent ;
- secret ;
- envoi au nom de l'utilisateur ;
- suppression sans retour ;
- publication d'un dépôt privé.

Un précédent ne peut jamais les franchir.

**7. Mémoire partagée entre musiciens.**

Les leçons « fleet » sont aujourd'hui dans la mémoire du **seul** chef, et 49 autres
dossiers mémoire ne les voient pas. Exemples :

- OAuth : `claude /login` ;
- ne jamais tuer tous les Chrome ;
- émulateur quand le téléphone est débranché.

La fiche injectée au dispatch rend ces règles disponibles au musicien concerné, et
seulement à lui : règle `S_APPLIQUE_A` projet ou plateforme (Android).

**8. Rappel au bon moment, contexte plus petit.**

Le chef relit 639 lignes de règles à chaque tour. La Carte ne remplace pas `CLAUDE.md`,
mais elle permet au contexte compact (Routage v3 §3.1) de ne citer **que** les règles et
décisions reliées aux projets ciblés et aux cases en jeu. Le budget est fixe, avec la
source de chaque ligne.

### 2.3 Apport réel ou complexité inutile

| Ce que le graphe apporte vraiment | Ce qui serait de la complexité inutile |
|---|---|
| liens **entre** registres déjà en fichiers (exigence ↔ test ↔ fichier ↔ décision ↔ version) | recopier dans le graphe ce que `config.json` ou `model-routing.json` disent : le graphe **pointe** vers l'état vivant, il ne le duplique pas |
| validité dans le temps (`REMPLACE`, `valide_jusqua`) et règle en vigueur calculée | extraction par LLM de tout `chef.jsonl` (421 Mo) : coût élevé, bruit, doublons, données personnelles |
| contradictions détectées sur des **paires choisies par le code** (même sujet) | GraphRAG, communautés, résumés globaux : nos questions sont locales |
| incidents reliés à une condition testable par le code | base de graphe, Cypher, serveur |
| précédents structurés pour la réponse automatique | similarité par mots (interdite depuis 0.66.0) ; embeddings au départ |
| une page pour **voir et corriger** ce que l'orchestrateur « croit » | un graphe que personne ne peut corriger |

**Ce que les fichiers font déjà bien et qu'il ne faut pas changer** : la mémoire Markdown
(lisible, versionnable, déjà chargée par Claude Code), les registres, les CHANGELOG.
**La Carte les lit ; elle ne les remplace pas.**

---

## 3. Solution : « la Carte »

### 3.1 Modèle de données

**Deux couches**, toutes deux en fichiers sous `logs/kg/` (non versionnés, comme les
autres journaux ; le dépôt est public).

| Couche | Fichier | Écrit par | Nature |
|---|---|---|---|
| **Dérivée** | `logs/kg/derived.json` (instantané), `logs/kg/build.json` (empreintes des sources) | `scripts/kg-build.mjs` uniquement | jetable, reconstruite ; statut `certain` ; jamais éditée |
| **Faits** | `logs/kg/facts.jsonl` (ajout seul), `logs/kg/facts.lock` | `scripts/kg-facts.mjs` uniquement (verrou, `atomic-file.mjs`) | décisions, règles, préférences, incidents, contradictions ; chaque correction est un **nouvel** événement |

**Taille estimée**, à confirmer en phase 0 : ≈ 30 000 nœuds et 80 000 arêtes, en majorité
étapes d'exécution, versions et fichiers. Moins de 30 Mo en mémoire ; reconstruction
complète en moins de 10 s ; incrémentale (par empreinte de source) en moins de 1 s.

**Types de nœuds — liste fermée (17)**, identifiants réutilisant ceux de `id-resolve.mjs` :

| Type | Id | Source |
|---|---|---|
| `projet` | nom de `config.json` | config.json |
| `demande` | `r-…` (Routage v3 phase 1) | `logs/requests/` |
| `exigence` | `<projet>#REQ-<n>` | `docs/USER_REQUIREMENTS.md` |
| `décision` | `ROUTAGE-D4`, `PIPELINES-D9`, `mem:<nom>` | §5 et §11 des synthèses, mémoires `feedback_*` |
| `règle` | `regle:<slug>` | CLAUDE.md (sections « Hard rules »), mémoires |
| `préférence` | `pref:<slug>` | mémoires `user_*` / `feedback_*` |
| `exécution` | `p-…` | run.json |
| `case` | `dev.vert.complexe` | model-routing.json |
| `model` | `claude-sonnet-5-5` | run.json (`served`) |
| `pipeline` | `dev` | catalogue |
| `incident` | `inc:<classe>:<hash>` | motifs `why`, refus, pannes d'infrastructure |
| `fichier` | `<projet>:<chemin>` | git ls-files, périmètres |
| `suite` | `<projet>:scripts/_test_x.mjs` | regression-perimeters.json |
| `version` | `<projet>@vX.Y.Z` | CHANGELOG.md |
| `commit` | `<projet>@<sha7>` | git log |
| `service` | `<projet>:<port>` | mémoire des ports, config |
| `todo` | `t-…` | TODO_LIST.md |

Volontairement **absents** : les personnes autres que « l'utilisateur », les contenus des
projets (mails, CV, données clients de demarchage ou Jarvis-Career) et tout secret.

**Liens — liste fermée (≈ 20)**, dirigés : `CONCERNE`, `DÉCIDE`, `REMPLACE`, `CONTREDIT`,
`PROTÈGE` (suite → exigence), `TESTE` (suite → fichier), `APPARTIENT`, `DÉPEND_DE`
(projet → projet, périmètre → périmètre), `UTILISE` (projet → service), `ÉCOUTE` (service
→ port), `A_EXÉCUTÉ` (exécution → case, avec model, issue, durée, cause), `CAUSE`
(incident → cause), `CORRIGÉ_PAR` (incident → version), `LIVRÉ_DANS` (exigence → version),
`S_APPLIQUE_A` (règle → projet, case, model ou plateforme), `CONDITION`, `CONDUITE`
(incident → règle), `CITE`, `SOURCE`.

**Forme d'un fait** (une ligne de `facts.jsonl`) :

```json
{"ev":"assert","id":"f-20261020-3a9c1e","s":"mem:feedback_all_opus5","p":"REMPLACE","o":"mem:feedback_plan_opus5_code_opus48",
 "props":{},"valide_depuis":"2026-09-25","valide_jusqua":null,"enregistre":"2026-10-20T10:12:00Z",
 "source":{"fichier":"C:/Users/steph/.claude/projects/I--Dev-Chef/memory/feedback_all_opus5.md","ligne":19,
           "citation":"supersede [[feedback_plan_opus5_code_opus48]]","sha256":"…"},
 "par":"code|model:claude-sonnet-5-5|utilisateur","statut":"certain|proposé|validé|périmé|contredit","confiance":0.9}
```

- **Bi-temporel** (d'après Zep) : `valide_depuis` / `valide_jusqua` (vérité dans le
  monde) et `enregistre` / `retire` (vérité dans le journal). On ne supprime rien. Une
  correction ajoute `{"ev":"retract"|"supersede"|"correct", "cible":"f-…"}`.
- **Provenance obligatoire.** Pas de source, pas de fait. Une citation de 200 caractères
  au plus, que le code **retrouve** dans le fichier source (même principe que
  `report-check`). Sinon le fait est rejeté.
- **Confiance** : statut discret d'abord. Un nombre seulement pour les statistiques de
  models (taux et n).
- **Priorité de lecture** : `utilisateur` > `certain` (code) > `validé` > `proposé`. Un
  fait `proposé` n'est **jamais** injecté comme règle ; il peut être montré avec la
  mention « (non validé) ».

### 3.2 Alimentation

| Source | Faits produits | Par qui | Fréquence | Coût |
|---|---|---|---|---|
| config.json, model-routing.json, catalogue | projet, case, pipeline, model (liens seulement) | code | à chaque construction | 0 |
| run.json, pipeline-classify.ndjson | exécution, `A_EXÉCUTÉ`, incident (classé par le code depuis `why`, `isLaunchFailure`, motifs connus) | code | réveil ou balayage de 60 s, incrémental | 0 |
| regression-perimeters.json, git ls-files | fichier, suite, `TESTE`, `DÉPEND_DE` | code | à chaque commit | 0 |
| USER_REQUIREMENTS.md | exigence, `PROTÈGE` (colonne « test associé »), `LIVRÉ_DANS` | code (tableau Markdown) | à chaque modification | 0 |
| CHANGELOG.md, git log | version, commit, `CORRIGÉ_PAR` quand l'entrée cite un `p-…` ou une exigence | code | à chaque modification | 0 |
| TODO_LIST.md, `logs/requests/` | todo, demande | code | à chaque modification | 0 |
| Synthèses : « Décisions de l'utilisateur » (§5, §11) | décision numérotée, `CONCERNE` (tests, cases, fichiers cités entre accents graves) | **code** pour la structure ; **model** pour lier une décision à son sujet quand rien n'est cité | à chaque nouvelle synthèse | 1 appel sonnet par document (≈ 0,3 $ d'équivalent API, sur l'abonnement) |
| Mémoires `*.md` (175) | règle, préférence, décision ; `REMPLACE` quand le texte le dit (« supersede », « caduc », « remplace ») ; `S_APPLIQUE_A` | frontmatter et `[[liens]]` par le code ; **model** pour typer et relier, avec citation exacte | à chaque fichier modifié (empreinte) | 1 appel court par mémoire modifiée ; amorçage unique ≈ 175 appels ≈ 15 à 25 $ d'équivalent API |
| Paires suspectes | `CONTREDIT` candidat | **code** choisit les paires (même `S_APPLIQUE_A`, même sujet, toutes deux valides) ; **model** juge (oui/non/remplacement + citation) | quotidien | ≈ 10 à 30 appels courts par jour |
| `chef.jsonl` (421 Mo) | **rien en vrac.** Seulement : réponses de l'utilisateur aux questions et pauses (déjà structurées), décisions marquées | code | balayage | 0 |

**Déduplication.**
- Les identifiants sont **canoniques et produits par le code**. Le model ne crée jamais
  d'entité : il choisit dans une **liste fermée** fournie par le code, comme le
  rattachement des besoins (Pipelines §4.4).
- Un fait identique (s, p, o, même source) est ignoré.
- Un fait de même (s, p) avec un autre o devient candidat `REMPLACE` ou `CONTREDIT`.

**Fraîcheur.**
- Chaque fait affiche « vu le » (dernière confirmation par sa source).
- Chaque type a un délai de péremption : `service`/port 60 j, statistiques de model 30 j
  (comme `staleAfterDays` de `model-recommendations.json`), règles et décisions sans
  délai mais `valide_jusqua` explicite.
- Si la source disparaît ou change, le fait passe `à revoir`. Il n'est pas supprimé.

### 3.3 Interrogation

**Un seul module** `scripts/kg.mjs`, lecture seule, avec une CLI et des fonctions. Les
requêtes sont **typées** ; aucune recherche par mots.

| Requête | Rend | Utilisateur principal |
|---|---|---|
| `fiche <projet>` | règles et décisions en vigueur qui s'y appliquent, services et ports, dépendances, 5 derniers incidents, exigences ouvertes | chef, dispatch d'un musicien |
| `impact <fichier…>` | périmètres, suites, **exigences protégées (⚠)**, décisions qui contraignent, projets dépendants | étape Liste de tests, Revue, chef |
| `règles --projet X --case Y --model Z` | règles applicables, la plus spécifique et la plus récente en premier, contradictions ouvertes signalées | dispatch, chef |
| `précédents --type pause --etape dev.livrer --projet X` | décisions passées de même forme, avec la réponse et sa source | réponse automatique, chef |
| `model <case>` | n, taux d'issue par model, causes classées, date, avertissement si n < 20 | page Models (suggestions) |
| `explique <id>` | le nœud et ses liens à 1 saut, avec sources | overlay `[[…]]` du dashboard |
| `contradictions`, `périmés` | files de revue | onglet Mémoire |

**Injection** (le code compose ; jamais un résumé de model) :

- **Chef** (Routage v3 phase 2, contexte compact) : bloc « Mémoire utile », **au plus
  1 200 tokens**. Il contient les `fiche` des projets ciblés par les demandes ouvertes et
  les règles applicables aux cases en jeu. Une ligne par fait, avec sa source :
  `• Postgres 5432 partagé par newsParser et immo-share (mémoire project_fleet_ports, 2026-08-03 — à revoir : > 60 j)`.
- **Musicien** (`dispatch.mjs`) : « Fiche du projet », **au plus 800 tokens**, en tête du
  prompt, après les règles fixes (langue, TODO…) ; sautée si vide.
- **Étapes de pipeline** : Liste de tests et Revue reçoivent `impact` des fichiers
  touchés (au plus 400 tokens). Le classifier ne reçoit **rien** du graphe au départ,
  pour ne pas réintroduire de routage lexical ni d'inertie.
- **Outil pour les models** : `node scripts/kg.mjs …` est autorisé en lecture à tous
  (règle « web + lecture »). Un serveur MCP n'est pas nécessaire ; on pourra en ajouter un
  plus tard, en simple enveloppe de `kg.mjs`.
- **Langue** : les libellés et les gabarits de lignes sont en français. Les identifiants
  et le code restent tels quels.

### 3.4 Affichage et correction dans le dashboard

**Overlay des identifiants** (`id-resolve.mjs`, 0.107.0) : section « Liens » ajoutée,
1 saut, 10 liens au plus avec « voir plus ». C'est l'entrée la plus naturelle : chaque
`p-…`, `vX.Y.Z` ou fichier cité ouvre déjà un overlay.

Nouveau type d'identifiant `fait` (`f-…`), et `décision` (`ROUTAGE-D4`).

**Onglet « 🧠 Mémoire »**, avec filtres type, projet, statut :

- **Revue** : faits `proposé`, contradictions, faits `à revoir` ou périmés. Boutons :
  `Valider`, `Corriger` (édition des champs, avec la source gardée), `Périmer à la date…`,
  `Rejeter`, `Ouvrir la source`.
- **Règles en vigueur** : par projet et par case, avec la chaîne `REMPLACE` dépliable.
- **Statistiques de models** : par case. Ce sont les mêmes données que les suggestions de
  la page Models.

**Toute correction** est un événement `par: utilisateur` dans `facts.jsonl`. Elle gagne
toujours et n'est jamais écrasée par une reconstruction.

**Hors du graphe** : si le fait vient d'une mémoire `.md`, le bouton propose **aussi** de
corriger la mémoire source. C'est un dispatch au projet propriétaire, jamais une écriture
directe du serveur dans `~/.claude`.

**API** : `GET /api/kg/{fiche,impact,explique,revue}`. Écritures par
`POST /api/kg/facts/:id/{valider,corriger,perimer,rejeter}` (`sameOriginOnly`,
`commandId` idempotent, comme le Routage v3 §3.9). Le navigateur est utilisable sur
bureau et mobile.

### 3.5 Contraintes du fleet

**Pas de base de données.**
- Les deux couches sont en JSON et JSONL. Le graphe est chargé en mémoire par le serveur
  (objets JS, index par type et par extrémité).
- **Aucune base n'est indispensable** à cette taille. Si un jour le graphe dépassait
  environ 10⁶ arêtes, la seule option crédible serait LadybugDB (fork embarqué de Kuzu).
  Ce serait une décision à soumettre (D2), avec l'alternative actuelle en fichiers.

**Local, aucune clé payante.**
- Aucun embedding au départ.
- Les appels de model passent par le CLI `claude` (abonnement) sur la case
  `kg.extraire` (sonnet-5.5 suggéré).
- Plus tard, en option : embeddings locaux par Ollama (déjà en service sur le port
  11434), si la mesure montre que des précédents manquent (D6).

**Aucun secret.** Cinq protections :
- **Sources exclues** : `secrets/`, `api-keys.status.json`, `config.json` au-delà de
  noms, chemins et ports, tout `.env`, les contenus des projets.
- **Champs en liste blanche.** Une citation passe par le masquage de secrets existant
  (`maskSecrets` de `public/permission-core.js`, déjà utilisé par
  `permission-store.mjs`), complété des motifs de jetons du fleet, **avant** écriture. Si elle échoue, elle est
  remplacée par `[citation retirée]`, et le fait est gardé avec son fichier:ligne.
- **Suite** `_test_kg_no_secret.mjs` : des jetons factices sont plantés dans les sources
  et doivent être absents de `logs/kg/`.
- **Sauvegardes et diagnostics** : `logs/kg/` n'est jamais copié dans un rapport ni dans
  un corpus de test sans anonymisation.
- **Dépôt public** : aucune donnée du graphe n'est versionnée.

**Langue de discussion.** Les fiches, les libellés de l'onglet et les messages sont en
français ; le code et les commentaires en anglais.

**Garde-fous.**
- Le graphe **n'autorise jamais rien**. Il n'existe aucun type `autorisation`. Une
  décision passée n'est pas une autorisation pour un nouvel effet irréversible
  (Pipelines D5 : la demande doit citer l'action).
- La réponse automatique vérifie la liste fermée des garde-fous **avant** de consulter
  les précédents. Un précédent n'apparaît que comme appui cité.

**Prod/dev.** Développement et non-régression dans orchestrateur-dev ; bond décidé par
l'utilisateur.

### 3.6 Risques et parades

| Risque | Exemple réel | Parade |
|---|---|---|
| **Fait obsolète** qui oriente mal | port de vuBox « web WSL » après la migration native ; index de `MEMORY.md` périmé | `valide_jusqua`, « vu le », péremption par type, mention « à revoir » dans l'injection ; **l'état vivant gagne toujours** (le graphe ne reprend pas les valeurs de `config.json` et `model-routing.json`, il y renvoie) |
| **Fait faux / hallucination** | un model qui relie une règle Android à un projet web | le model ne crée aucun identifiant (liste fermée) ; citation exacte vérifiée par le code ; statut `proposé` jamais injecté comme règle ; correction en un clic |
| **Statistiques trompeuses** | 44 % de refus de `dev.vert.complexe` sur sonnet-5.5, surtout des critères | cause classée (capacité / critère / infrastructure / couverture) ; n ≥ 20 ; date ; suggestion seulement (décision 16 des Pipelines) |
| **Inertie** : le passé fige les choix | « on a toujours fait X » | précédents montrés comme **appui**, jamais comme décision ; aucune injection dans le classifier |
| **Vie privée** | projets demarchage, Jarvis-Career, Ayor | contenus des projets exclus ; seules les métadonnées de l'orchestrateur sont prises ; seule personne : « l'utilisateur » |
| **Coût, latence** | — | code seul pour plus de 90 % des faits ; requêtes < 50 ms en mémoire ; injection bornée en tokens ; amorçage ≈ 20 $ d'équivalent API, puis quelques appels par jour |
| **Graphe qui devient une seconde vérité** | une règle corrigée dans le graphe mais pas dans la mémoire | bouton « corriger aussi la source » ; balayage qui signale les divergences graphe ↔ source |
| **Contexte pollué** | une fiche de 3 000 tokens à chaque tour | budget dur, ordre par spécificité, troncature **signalée** (« 4 faits de plus : kg.mjs fiche X ») et non silencieuse (règle 0.93.0) |

### 3.7 Mesure du bénéfice

**Corpus rejoué** `tests/kg-corpus/` (anonymisé, dépôt public). Cas tirés de la prod :

| Cas réel | Attendu de la Carte |
|---|---|
| index `MEMORY.md` « plan Opus 5 / code Opus 4.8 » face à `feedback_all_opus5`, à la décision Routage 2 (sonnet) et aux cases `dev.vert.*` | chaîne `REMPLACE` reconstruite ; règle en vigueur = page Models par case ; contradiction « directive globale ↔ cases » **signalée** |
| dispatch d'une petite tâche sur haiku vers TradeBot (session longue) | rappel de l'incident « Prompt is too long » et de sa conduite dans la fiche |
| « Opus 5.5 n'existe pas » | règle « vérifier empiriquement un model » injectée quand une case cite un model absent du catalogue local |
| `impact scripts/dispatch.mjs` et les fichiers des décisions 9 et 10 des Pipelines | retrouve 100 % des tests ⚠ du tableau §11.1, sans faux positif d'exigence |
| « mettre à jour Postgres » | newsParser **et** immo-share concernés |
| 20 commits récents d'orchestrateur-dev | suites prédites ⊇ suites rouges observées (rappel ≥ 95 %) |
| questions de pause passées avec réponse de l'utilisateur | précédent de même forme trouvé dans le top 3 pour ≥ 70 % des cas |

**Critères chiffrés (7 jours en prod, après le bond) :**

| Mesure | Seuil |
|---|---|
| exactitude des faits injectés (échantillon de 50 jugé par l'utilisateur dans l'onglet) | ≥ 90 % |
| faits `proposé` rejetés par l'utilisateur | ≤ 20 % (au-delà : revoir l'extraction) |
| secrets dans `logs/kg/` | 0 |
| tokens injectés : chef / musicien | ≤ 1 200 / ≤ 800, médiane mesurée |
| latence d'une requête / d'une reconstruction incrémentale | < 50 ms / < 1 s |
| erreurs répétées sur un incident connu (haiku longue session, model déclaré inexistant, OAuth) | 0 |
| contradictions ouvertes de plus de 7 jours | 0 (traitées ou acceptées) |
| règles redemandées par l'utilisateur (« je t'ai déjà dit… », relevé sur `chef.jsonl`, mesure seulement) | en baisse face aux 30 jours précédents |
| temps du chef pour une analyse d'impact (tableau de type §11.1) | de plusieurs minutes de model à moins de 1 s de code |

Si les trois premiers seuils ne sont pas tenus, on garde la phase 0 seule (le graphe
dérivé) et on coupe l'injection.

---

## 4. Plan par phases

**Règles communes :**
- **Prod/dev.** Code et non-régression dans `orchestrateur-dev` (bac à sable 7778, faux
  claude, fixtures), puis tag `vX.Y.Z`, puis **bond décidé par l'utilisateur**
  (`prod-jump.mjs`). Tag de retour `pre-kg-<phase>-vX.Y.Z` avant chaque phase.
  L'observation réelle se fait en prod seulement.
- **Bascule à chaud** dans `model-routing.json` :
  `kg {build, facts, extract, injectChef, injectMusicians, injectSteps, autoAnswerPrecedents, ui}`,
  écrite par `pipeline-enforce.mjs kg <clé> on|off`, relue à chaque dispatch.
  `kg off --all` rend exactement le comportement actuel.
- **Mode ombre** avant toute injection : ce qui *aurait* été injecté est journalisé dans
  `logs/kg/shadow.ndjson` et comparé au corpus.
- **Exigences.** La demande de l'utilisateur et chaque comportement livré entrent dans
  `docs/USER_REQUIREMENTS.md` avec leur test. Fichiers et suites sont rattachés à un
  nouveau périmètre `kg` dans `regression-perimeters.json`. Les tests passent par
  `tests/real-config.mjs` (0.119.0).

| Phase | Contenu | Effort | Critère de sortie | Articulation |
|---|---|---|---|---|
| **0 — Carte dérivée, sans model** | `kg-build.mjs` (sources « code » du §3.2) ; `kg.mjs` (`fiche`, `impact`, `explique`, `model`) ; section « Liens » de l'overlay ; aucune injection | **2 j** | `impact` retrouve le tableau §11.1 ; construction < 10 s ; 0 secret ; `_test_kg_build`, `_test_kg_impact`, `_test_kg_no_secret` | indépendante ; peut partir tout de suite, en parallèle des phases 0 et 1 des Pipelines |
| **1 — Faits curés et onglet Mémoire** | `kg-facts.mjs` (journal, verrou, événements) ; extraction des mémoires et des décisions (case `kg.extraire`, citation vérifiée) ; paires suspectes → `CONTREDIT` ; onglet « 🧠 Mémoire » ; API d'écriture | **2,5 j** | corpus : chaîne opus 4.8 → 5.5 → cases reconstruite ; contradiction signalée ; `proposé` jamais injecté ; `_test_kg_facts`, `_test_kg_quote_check`, HTTP `kg-review`, navigateur `kg-tab` (bureau et mobile) | indépendante |
| **2 — Injection (ombre, puis active)** | « Mémoire utile » dans le contexte compact du chef ; « Fiche du projet » dans `dispatch.mjs` ; `impact` pour Liste de tests et Revue ; budgets et troncature signalée | **1,5 j** | 3 jours d'ombre en prod : exactitude ≥ 90 % sur 50 lignes jugées, budgets tenus ; `_test_kg_inject_budget` | **après la phase 2 du Routage v3** (contexte compact) ; l'injection musicien peut précéder |
| **3 — Incidents, précédents, suggestions** | incidents classés et règles de conduite liées à une condition ; `précédents` pour la réponse automatique (après les garde-fous) ; `model <case>` alimente les suggestions de la page Models | **1,5 j** | rappel haiku et model inexistant sur le corpus ; précédent dans le top 3 ≥ 70 % ; garde-fous jamais franchis (`_test_kg_guardrails`) | après la livraison de la réponse automatique (orchestrateur-dev, demandée le 2026-10-20) et la décision 16 des Pipelines |
| **4 — Bascule et mesure** | bond ; `kg` activé clé par clé ; 7 jours de mesure (§3.7) | 0,5 j + 7 j | §3.7 | peut partager le bond d'une phase du Routage ou des Pipelines, avec des interrupteurs distincts |
| **5 — Registres reliés au Routage v3 et aux Pipelines** | `demande` (`logs/requests/`), `besoin` (`logs/pipeline-needs/`), opérations typées et postconditions (`typed-operations.mjs`) deviennent des nœuds | 0,5 j | `explique r-…` montre tâches, exécutions, versions | après les phases correspondantes |

**Total ≈ 8,5 jours**, hors observation.

**Retour arrière** : `kg off --all` à chaud. Supprimer `logs/kg/` ne casse rien, car la
couche dérivée se reconstruit. La seule perte possible concerne les corrections de
l'utilisateur, d'où une sauvegarde quotidienne de `facts.jsonl` sous `logs/kg/backup/`.

**Tests d'exigence existants** : aucun n'est modifié. `_test_id_links` gagne des cas
(nouveaux types) sans qu'aucune assertion ne change.

---

## 5. Décisions à soumettre à l'utilisateur

1. **Forme du graphe.** Une « Carte » reconstruite par le programme à partir des fichiers
   existants, plus un petit journal de faits datés et sourcés (décisions, règles,
   incidents). Pas de GraphRAG, pas d'extraction de tout l'historique du chef.
   **Recommandé : oui.**
2. **Pas de base de données.** Tout en fichiers JSON/JSONL, chargé en mémoire. Une base
   (LadybugDB) ne serait proposée que si le graphe devenait cent fois plus gros.
   **Recommandé : rester en fichiers.**
3. **Rôle des models.** Ils **proposent** des liens (types, remplacements, contradictions)
   avec une citation exacte vérifiée par le programme. Seuls les faits validés ou
   produits par le programme servent de règle. **Recommandé : oui.**
4. **Validation.** Vous validez dans l'onglet Mémoire les faits proposés, par lots.
   Recommandé : **oui**, avec une exception : les décisions déjà écrites dans une section
   « Décisions de l'utilisateur » sont prises telles quelles, la source restant affichée.
5. **Ce qui est injecté.** Le chef reçoit au plus environ une page (1 200 tokens) de
   mémoire utile, et chaque musicien au plus 800 tokens pour son projet, toujours avec la
   source et la date. Le classement des tâches ne reçoit rien. **Recommandé : oui, après
   3 jours en mode ombre.**
6. **Recherche par ressemblance** (embeddings locaux par Ollama). **Recommandé : pas
   maintenant.** On mesure d'abord si les requêtes typées suffisent.
7. **Réponse automatique en votre absence.** Elle peut citer vos décisions passées de
   même forme comme appui. Les garde-fous (argent, secret, envoi en votre nom,
   suppression sans retour, publication d'un dépôt privé) restent vérifiés avant et ne
   peuvent jamais être levés par un précédent. **Recommandé : oui.**
8. **Correction d'une mémoire.** Quand vous corrigez un fait issu d'une mémoire, le
   programme propose aussi de corriger le fichier mémoire d'origine (par le projet
   concerné). Rien n'est réécrit en silence. **Recommandé : oui.**
9. **Ordre.** Phase 0 (la Carte, sans model) tout de suite, en parallèle des gains rapides
   des Pipelines. Injection dans le contexte du chef après la phase 2 du Routage v3. Mise
   en prod par bond décidé par vous. **Recommandé : oui.**
10. **Nettoyage immédiat, hors projet.** La ligne d'index de la mémoire du chef sur
    « plan Opus 5 / code Opus 4.8 » est périmée, et la mémoire « tout sur Opus 5.5 »
    ne reflète plus les choix faits case par case (le chef sur sonnet-5.5). Faut-il les
    faire mettre à jour par le chef dès maintenant ? **Recommandé : oui.** C'est le
    premier cas que la Carte doit détecter seule ; on le garde dans le corpus comme
    attendu.
