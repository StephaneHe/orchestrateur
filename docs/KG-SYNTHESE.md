# Graphe de connaissances pour l'orchestrateur — SYNTHÈSE (Opus 5.5)

> Demande de l'utilisateur (2026-10-20, verbatim) : « Prochaine etude a faire avec les
> meme models : Les Graphes de Connaissances (Knowledge Graphs). Je veux rajouter ceci a
> l'orchestrateur, ca l'aidera dans les decisions, et le travail en general. Lances
> l'etude avec les differents models, appliquee a l'orchestrateur »
>
> Sources comparées :
> - **[O]** Opus 5.5 : `I:\Dev\orchestrateur-dev\docs\KG-SOLUTION-opus.md` (non commitée) ;
> - **[F]** Fable 5.1 : `reports/KG-SOLUTION-fable.md` (commit 02d1d88) ;
> - **[A]** GPT-6 Astra : `reports/KG-SOLUTION-astra.md` (commit af9175e).
> - **[S]** : apport propre de cette synthèse.
>
> Étude seulement, écrite le 2026-10-20 : aucun code, aucun redémarrage, rien écrit sous
> `I:\orchestrateur`. Toutes les vérifications du §1 ont été refaites en lecture seule sur
> la prod (v0.119.0), sur orchestrateur-dev (commit 5a32483), sur la mémoire du chef et
> sur l'état réel de la machine (ports, services). Les identifiants sont écrits nus (règle
> des fichiers écrits).

---

## 0. Verdict en une page

Les trois études convergent sur l'essentiel, sans s'être lues :

- pas de GraphRAG, pas de base de données, pas d'embeddings au départ ;
- **un index de faits sourcés et datés, construit d'abord par le code** à partir des fichiers
  existants, qui restent la seule vérité ;
- un model ne fait que **proposer**, avec une citation que le code retrouve ;
- le graphe **informe, n'autorise jamais rien** ;
- tout est basculable à chaud, avec un mode ombre avant toute injection ;
- développement dans orchestrateur-dev, bond décidé par l'utilisateur.

Les différences portent sur le **dosage** :

- **[O]** est le plus concret sur le schéma (17 types, deux couches dérivée/faits) et sur
  la mesure ;
- **[F]** est le plus riche en cas réels et apporte les **prédicats fonctionnels** (la
  détection de contradiction par construction), l'outil `free-port` et la coupure
  automatique de l'extraction ;
- **[A]** est le plus rigoureux sur la **sûreté** :
  - autorité distincte de la confiance ;
  - origine fiable d'un message « utilisateur » ;
  - double temps « valable à » / « connu à » ;
  - règles impératives jamais tronquées ;
  - banc A/B/C qui isole l'apport propre du graphe.

  Il est aussi le seul à avoir vu le conflit entre la réponse automatique et la décision 14.

La vérification sur les données réelles (§1) trouve **une erreur de chiffre importante
chez [O]**, **trois chez [F]**, aucune chez [A]. Elle montre aussi que la table des ports
est **bien plus périmée** qu'aucune des trois ne le dit : WSL est arrêté, et l'annuaire
(port 80), immo-share et Ollama ne répondent plus.

**Recommandation** : adopter l'architecture commune, avec le schéma de [O], les
prédicats fonctionnels de [F] et les garde-fous de [A]. Commencer par une **phase 0 a
sans code** (trancher les contradictions déjà connues), puis une **phase 0 b de 2 jours
sans model**. Effort total ≈ 10 jours, hors observation.

---

## 1. Vérification sur les données réelles

Relevés du 2026-10-20, en lecture seule.

### 1.1 Les quatre contradictions annoncées

**C1 — Règle des models : pas trois versions, mais quatre sources qui se contredisent.**

| Source | Date | Ce qu'elle dit |
|---|---|---|
| mémoire `feedback_plan_opus5_code_opus48` | 2026-08-31 | « on n'utilise PLUS DU TOUT Opus 5, TOUT sur opus-4-8 » |
| ligne d'index de cette même mémoire dans `MEMORY.md` | — | « planification → Opus 5, code → Opus 4.8 » : périmée **même par rapport à son propre fichier** |
| mémoire `feedback_vubox_opus5` et sa ligne d'index | 2026-08-24 | renvoie à la règle « plan/code générale » |
| mémoire `feedback_all_opus5` | 2026-09-25 | « TOUTES les opérations sur Opus 5.5 », « ne plus router par nature de tâche » ; remplace la mémoire du 2026-08-31 **et** le tableau du CLAUDE.md |
| `CLAUDE.md` du chef, lignes 37-48 | — | tableau opus-5 / opus-4-8 « défaut du fleet » / sonnet-5 / haiku-4-5 / fable-5 ; ligne 248 : ces models sont « dominés », liste « datée » |
| prod, `config.json` | — | `defaults.model = claude-opus-5-5` |
| prod, `model-routing.json` | 2026-10-08 et 09 | 81 cases : opus-5-5 ×40, sonnet-5-5 ×23, haiku-5-5 ×7, outils ×7, gpt-6-astra ×2, sonnet-5 ×1 (`routage.classifier`), fable-5-1 ×1 |

Le routage par case **contredit littéralement** « ne plus router par nature de tâche ».
Les cases ont été posées après le 2026-09-25 et la décision Routage 2 (chef v3 sur
sonnet-5-5) les confirme. La règle réelle est donc : **la page Models fait foi case par
case, Opus 5.5 est le défaut hors case.**

- [O] et [F] l'ont vu ; [F] est le plus complet (il cite aussi `dev.concevoir.plan` sur
  gpt-6-astra).
- **Erreur de [O]** : il présente la case `routage.chef` sur sonnet-5-5 comme existante.
  Elle n'existe **pas** en prod : c'est une décision pour la v3, pas encore livrée.

**C2 — 17 ou 38 projets.**

- `config.json` compte **38 entrées**, dont chef, orchestrateur et orchestrateur-dev.
- 20 projets sont en service dans les pipelines (`enforcement.projects`).
- « Fleet de 17 projets » (mémoire `user_profile`) est périmé. **[F] a raison.**

**C3 — vuBox : WSL ou Windows natif.**

Vérifié sur la machine : le service Windows `vuBox` est RUNNING (`node.exe`, session
Services) et écoute sur 0.0.0.0:3001. La distribution `Ubuntu-20.04` est **Stopped**.
**Windows natif**, comme le dit `project_vubox_windows_native` ; la table des ports est
fausse sur cette ligne. [O], [F] et [A] ont raison.

Nuance juste de [A] : `config.json` pointe vuBox vers `I:\Dev\vuBox`, alors que le
runtime de prod est le worktree `I:\Dev\vuBox-win`. Le graphe doit distinguer projet,
worktree et environnement.

**Constat nouveau [S] : la table des ports est périmée bien au-delà de vuBox.**

- WSL étant arrêté, les règles portproxy (80, 3000, 3003, 3100, 8000, 8080, 9000, 9001,
  11434, 8097 → 172.20.206.21) ne mènent plus nulle part. En GET local,
  **l'annuaire (80), immo-share (3000) et Ollama (11434) ne répondent pas**.
- BookHaven (8097) et panierIL (8001) répondent, mais par un `python.exe` **Windows** :
  la table les dit « web WSL ».
- **Erreur de [O]** : il écrit qu'Ollama est « déjà en service sur le port 11434 ». Ce
  n'est pas le cas aujourd'hui.
- C'est l'illustration parfaite du risque « fait obsolète ». C'est aussi un point
  d'exploitation à signaler au chef, hors de cette étude.

**C4 — Routage du chef « en service » dans son CLAUDE.md.**

- **Corrigé** : la ligne 157 du CLAUDE.md du chef porte maintenant « ⚠ COUPÉ en prod
  depuis le 2026-10-19 18:27 ».
- Le texte qui suit est présenté comme la description du Routage actif.
- La prod confirme `enforcement.by = "pipeline-enforce off --chef"`, depuis
  2026-10-19T18:27:54Z.
- La contradiction n° 2 de [F] est donc close. Elle reste un bon **cas de test** pour le
  détecteur.

### 1.2 Réponse automatique et décision 14 des Pipelines (point soulevé par [A])

Ce que disent les textes :

- **Décision 14** (PIPELINES-SYNTHESE §11, adoptée par « tout comme recommandé »,
  reçu à 08:02-08:12 UTC le 2026-10-20) : « “continuer” automatique : non (une limite
  atteinte reste une décision de l'utilisateur) ». Le §10 précise l'objet : le
  **programme** qui continue seul « quand la limite d'items est un peu dépassée », sans
  poser de question.
- **Règle d'absence** (chef.jsonl, 2026-10-20 08:14:52 UTC, donc **plus tardive**) :
  inactif depuis plus de 15 min, un process attend, 5 min sans réponse ⇒ Opus 5.5 est
  « chargé et autorisé à répondre à ma place […] Sinon il faut avancer ». Elle a une
  liste fermée de garde-fous (argent, secret, envoi en son nom, suppression sans retour,
  publication d'un dépôt privé). Une limite de pipeline **n'y figure pas**.

**Arbitrage [S].** Les deux règles ne visent pas le même acte :

- la décision 14 interdit au **code** de franchir une limite **sans poser la question** ;
- la règle d'absence désigne **qui répond** à une question posée quand l'utilisateur est
  absent.

Lues ainsi, elles sont compatibles : la limite **reste une pause** (D14 tenue), et cette
pause est une question en attente, que la règle d'absence couvre.

[A] recommande l'inverse : la limite reste bloquante tant que l'utilisateur ne l'a pas
dit. Cette lecture prudente vide la règle d'absence d'un de ses cas les plus fréquents,
alors que l'utilisateur a écrit « il faut avancer ».

**Recommandation** (décision 6) : en absence, Opus 5.5 peut répondre à une pause de
limite, avec quatre bornes :

- **une seule fois par exécution** : une seconde limite attend l'utilisateur ;
- **point de retour obligatoire** (tag) ;
- réponse marquée « auto » et visible ;
- **jamais « abandonner »**, qui clôt l'exécution ; seulement « continuer » ou
  « simplifier ».

**Tests d'exigence touchés** :

- `_test_pipeline_gates.mjs` (message de pause à la limite, 0.50.1) **n'est pas
  affaibli** : la pause existe toujours ;
- la réponse automatique n'a **pas encore** de ligne dans le registre d'exigences
  d'orchestrateur-dev : elle est à créer avec sa livraison, et ce cas doit y figurer.

### 1.3 Autres chiffres en conflit

| Point | [O] | [F] | [A] | Mesure du 2026-10-20 | Verdict |
|---|---|---|---|---|---|
| exécutions | 650 | 651 dossiers | 650 décodés | 651 dossiers, 650 lisibles (1 illisible) ; 613 chef, 37 musiciens sur 11 projets | tous justes |
| `dev.vert.complexe` sonnet-5-5 | « 66, **29 refus (44 %)** » | — | — | 66 essais : 37 ok, **15 refusés**, **14 lancements impossibles** | **erreur [O]** : 29 = non-ok ; la moitié est de l'infrastructure (code 64), c'est le piège que [O] dénonce lui-même |
| `dev.vert.simple` | 21 (12 refus) | — | — | 21 : 9 ok, 11 refusés, 1 échec | [O] approximatif |
| `routage.decomposer` opus-5-5 | — | « 47 refus sur 458 » | 365 / 318 ok / 45 refusés | 365 : 318 ok, 45 refusés, 2 échecs | **erreur [F]** ; [A] juste |
| Livrer | 28 (11 refus) | « 11 refus sur 18 » | 28 / 17 / 11 | 28 : 17 ok, 11 refusés | **erreur [F]** |
| classifier | — | « 255 décisions, 0 échec » | 255 lignes, dénominateur différent | `pipeline-classify.ndjson` : 255 lignes ; étapes sonnet-5 : 284 (1 refus) + haiku 12 | [F] mélange deux dénominateurs ; [A] l'avait signalé |
| mémoire du chef | 33 | 34 fichiers | — | 33 fichiers dont `MEMORY.md` (32 mémoires) | [O] juste, **[F] +1** |
| mémoires du fleet | 175 / 50 dossiers | — | — | 175 / 50 | [O] juste |
| `chef.jsonl` | 421 Mo | 402 Mo | 421 Mo | 421 613 166 octets = 402 Mio | même taille, unités différentes |
| registres d'exigences | « ≈ 500 lignes » | 15 projets, 1 375 lignes | 15 registres | 15 fichiers, 1 378 lignes, 588 lignes de tableau | [O] compte des entrées, pas des lignes ; libellé trompeur |
| TODO | — | 20 | 21 | 21 | [A] juste |
| CLAUDE.md du chef | 639 lignes | — | — | 643 (correction C4 ajoutée) | évolution, pas une erreur |
| ports choisis « sans voir la table » | — | HelloSupport, aiDbPrep, devopsPrep | — | les trois **figurent** dans la table (2026-10-04) | **[F] non démontré** |
| p-20261018T154104-6cfbe8 | — | — | 9 livraisons, 8 refus « aucun commit » | vérifié | [A] juste |
| p-20261019T163311-e4336f | — | — | `paused` alors que la mémoire dit abandon | vérifié : youtube-live, `paused` | [A] juste ; contradiction réelle (décision 5) |
| GraphRAG-Bench | arXiv 2506.05690 | arXiv 2506.02404 | 2506.02404 | deux papiers distincts portent ce nom ; non départagé ici | ni l'un ni l'autre n'est faux, mais les chiffres ne sont pas interchangeables |

---

## 2. Comparaison

| Axe | [O] Opus 5.5 | [F] Fable 5.1 | [A] Astra | Retenu |
|---|---|---|---|---|
| **État de l'art** | large, légendé [V]/[S]/[NV] ; Letta « système de fichiers » 74 % ; Kuzu archivée, LadybugDB en réserve | GraphRAG-Bench chiffré, TDAD (carte code → tests en fichier, régressions 6,08 → 1,82 %), MemConflict (les mémoires gèrent mal les conflits), LLM Wiki / OKF | primaires datées, prudence méthodologique (LongMemEval : abstention, temporalité) ; « local ≠ hors ligne » | les trois concordent : graphe déterministe + temporalité + preuve ; GraphRAG global inutile ici |
| **Apports** | 8 cas, dont la chaîne des règles de models et le rappel d'incident par condition | 9 cas très concrets (youtube-live, FAILOVER vuBox 1.32.15-19, panne WSL commune, ports) + 4 contradictions | 8 cas en dossiers de preuve, avec limites (pause ≠ abandon, comparaison non causale) | cas de [F] et [O] pour le corpus ; limites de [A] comme garde-fous |
| **Modèle de données** | 2 couches : dérivée jetable + `facts.jsonl` ; 17 types, ≈ 20 liens ; statuts discrets | journal unique + index ; ≈ 20 types ; **prédicats fonctionnels** ; confiance 1,0 / 0,9 / 0,6 | assertion riche : `scope`, `authority` ≠ `confidence`, `evidenceKind`, `visibility` ; `exception_to` ; ontologie versionnée | 2 couches [O] + prédicats fonctionnels [F] + autorité, portée, exception [A] |
| **Extraction** | code > 90 % ; model pour mémoires, synthèses, paires suspectes ; amorçage ≈ 175 appels | code d'abord ; model pour mémoire, TODO, synthèses, chef.jsonl ; lot nocturne ; ≤ 1,5 $/j ; coupure si > 5 % de faux | phase 0 sans model ; extraction model **désactivée au départ** ; origine fiable des `user_prompt` | phase 0 sans model [A] ; model ensuite, avec citation et coupure auto [F] |
| **Coût / fraîcheur** | péremption par type (ports 60 j, stats 30 j) ; « vu le » | `seen` / `last_seen` ; 90 j sans revue ⇒ `a_confirmer` | structuré ≤ 5 s, documents ≤ 60 s p95 ; budgets en tokens | péremption par type [O] + délais de fraîcheur [A] |
| **Requêtes** | `fiche`, `impact`, `règles`, `précédents`, `model`, `explique` | `about`, `rules-for`, `impact`, `history`, `similar`, `answers`, `contradictions`, `free-port`, `stale` | `context`, `explain`, `impact`, `history`, `conflicts`, `model-evidence` ; `validAt` / `knownAt` | union typée, sans `similar` au départ (§3.4) |
| **Injection** | chef ≤ 1 200 tokens, musicien ≤ 800, étapes ≤ 400, classifier rien | chef ≤ 40 lignes, classifier ≤ 12 lignes (`similar`), étapes ≤ 30 lignes | chef 1 500 / 12 éléments, classifier 600, musicien 1 500 ; **règles impératives jamais tronquées** | budgets de [O], règle de non-troncature de [A], classifier limité aux décisions explicites |
| **Interface** | overlay `[[…]]` + onglet « 🧠 Mémoire » ; corriger la source par dispatch | onglet « 🕸 Faits » du panneau latéral ; bandeau des contradictions « celle-ci vaut » | fiche « quoi, pourquoi, depuis quand, où » ; chronologie connu/valable ; `commandId` + révision attendue | overlay [O] + onglet + bandeau [F] + fiche à 4 questions et révision [A] |
| **Risques** | table complète ; « seconde vérité » ; « statistiques trompeuses » | doublons, purge `forget --source` ; +5 s max sur le tour du chef | **faux consentement**, prompt injection, pollution récursive, fuite entre projets | union ; [A] est le plus complet |
| **Mesure** | corpus 7 cas, 9 seuils, 7 j en prod | 8 mesures dont « 5 questions sur 21 rendues inutiles » | banc 60 cas, **A/B/C** (C–B = apport du graphe), 0 fait futur | corpus [O]+[F], méthode A/B/C [A] |
| **Règles du fleet** | fichiers ; abonnement ; masquage via `maskSecrets` ; français | fichiers ; filtre de secrets ; français | fichiers ; « local ≠ hors ligne » ; secrets filtrés avant disque **et** avant model | tous conformes |
| **Articulation** | phases liées à Routage v3 ph. 2 et réponse automatique | table complète décision par décision (§6) | table + « ne pas attendre la v3 » | §3.10 |
| **Effort** | 8,5 j | 9 j | 10-14 j (± 40 %) | ≈ 10 j |
| **Erreurs factuelles** | case `routage.chef` dite existante ; « 44 % de refus » ; Ollama « en service » | 3 chiffres faux ; « ports choisis sans la table » ; 34 mémoires | aucune trouvée | — |

---

## 3. Synthèse : architecture cible

### 3.1 Principes (communs [O][F][A])

1. **Les fichiers restent la vérité.** Le graphe **pointe**, il ne recopie pas l'état
   vivant. `config.json` et `model-routing.json` sont lus à la demande ; l'état vivant
   gagne toujours [O][F][A].
2. **Code d'abord, model ensuite, utilisateur au-dessus** [F]. L'**autorité** (qui peut
   établir ce type de fait) est distincte de la **confiance** [A].
3. **Bi-temporel, jamais effacé** : on invalide, on ne supprime pas [O][F][A, Zep]. Une
   requête peut demander « valable à » et « connu à » [A].
4. **Le graphe n'autorise jamais rien.** Aucun type « autorisation » [O]. Aucune
   transition, reprise ni action déclenchée par un lien [A].
5. **Aucun model à la lecture** : la fiche est calculée par le code, en moins de 100 ms [F].
6. **Pas de base de données** : JSONL en ajout seul, plus des instantanés JSON, chargés en
   mémoire [O][F][A].

### 3.2 Stockage

Tout est sous `logs/kg/` : hors git, hors synchronisation, dépôt public [O][F].

| Fichier | Rôle | Écrit par |
|---|---|---|
| `derived.json` + `build.json` | **couche dérivée** jetable : tout ce que le code lit dans des fichiers structurés ; empreinte de chaque source [O] | `kg-build` |
| `facts.jsonl` | **couche des faits** en ajout seul : décisions, règles, préférences, incidents, contradictions, corrections de l'utilisateur ; chaque correction est un nouvel événement [O] | `kg-facts`, avec verrou et `atomic-file.mjs` |
| `review.jsonl` | file des faits proposés [A] | `kg-facts` |
| `shadow.ndjson` | ce qui *aurait* été injecté [O] | moteur |
| `metrics.ndjson` | mesures du §3.9 [A] | moteur |
| `backup/` | copie quotidienne de `facts.jsonl`, la seule donnée non reconstructible [O] | maintenance 03:00 |

**Un seul module propriétaire**, `scripts/kg.mjs` : construction, faits, requêtes, en CLI
et en fonctions. Un seul écrivain.

Un test statique refuse toute écriture hors de `logs/kg/` [F], et toute écriture dans les
registres d'autres propriétaires (demandes, besoins, files) [F][A].

### 3.3 Schéma

**Types de nœuds — liste fermée et versionnée** [O] base, [F][A] ajouts :

| Type | Identifiant | Source |
|---|---|---|
| `projet` | nom `config.json` | config |
| `worktree`, `environnement` | `vuBox-win`, `windows` / `wsl` | config, mémoire [A] (cas vuBox) |
| `demande`, `tache` | `r-…`, `r-…#n` | `logs/requests/` (Routage v3) |
| `question` | `p-…/n` | `NEEDS_USER_INPUT` et pauses [F] |
| `execution`, `etape` | `p-…`, `p-…/clé` | run.json |
| `pipeline`, `case`, `model` | nom | catalogue, model-routing.json, run.json (`served`) |
| `exigence` | `<projet>#<date>#<rang>` | `docs/USER_REQUIREMENTS.md` |
| `decision` | `ROUTAGE-D4`, `PIPELINES-D14`, `mem:<nom>` | §5 et §11 des synthèses, mémoires |
| `regle`, `preference`, `garde_fou` | slug | mémoires, CLAUDE.md ; `garde_fou` écrit **par l'utilisateur seulement** [F] |
| `incident`, `cause_hypothese` | slug daté | refus classés, TODO ; une cause reste une **hypothèse** tant qu'elle n'est pas validée [A] |
| `fichier`, `suite`, `version`, `commit` | `<projet>:<chemin>`, `<projet>@x.y.z`, `<projet>@sha7` | git, périmètres, CHANGELOG |
| `service`, `port` | `<projet>:<nom>` ; `machine/espace/protocole/numéro` [A] | table des ports, `netstat` (lecture) |
| `todo` | `t-…` | TODO_LIST.md |

Sont **absents** : toute personne autre que « l'utilisateur », les contenus des projets
(mails, CV, clients), tout secret [O][A].

**Prédicats — liste fermée** (anglais dans le code, libellés français dans l'interface) :

- `applies_to`, `exception_to` [A], `supersedes`, `contradicts` (dérivé, jamais écrit à
  la main [F]) ;
- `motivated_by`, `decided_in`, `protects` (suite → exigence) ;
- `covers` (suite → fichier), `belongs_to`, `depends_on`, `dev_of`, `runs_in` (service →
  environnement) ;
- `listens_on`, `executed` (exécution → case, avec model servi, issue, durée et cause
  classée) ;
- `refused_with`, `possible_cause_of`, `fixed_in`, `delivered_in`, `answered_with`,
  `mentions` (jamais transformé en `resumes` [A]), `cites`.

**Prédicats fonctionnels** [F] : un seul objet actif par sujet et par portée. Ce sont
`has_state`, `listens_on`, `runs_in`, `dev_of`, et toute règle `fixe` (model par défaut,
langue). Deux faits actifs sur un prédicat fonctionnel, de **même autorité** et de
**portées qui se recouvrent**, font une contradiction signalée [F][A].

**Forme d'un fait** :

```json
{"ev":"assert","id":"f-20261020-3a9c1e",
 "s":"mem:feedback_all_opus5","p":"supersedes","o":"mem:feedback_plan_opus5_code_opus48",
 "scope":{"project":"*"},
 "valid_from":"2026-09-25","valid_to":null,
 "recorded_at":"2026-10-20T10:12:00Z","retired_at":null,
 "source":{"kind":"user|code|model","ref":"memory/feedback_all_opus5.md#L19",
           "anchor":"How to apply","sha256":"…","quote":"supersede [[feedback_plan_opus5_code_opus48]]"},
 "by":"code:extract-memory","authority":"user","status":"observed",
 "confidence":null,"last_seen":"2026-10-20T10:12:00Z","label":"…"}
```

- **Provenance obligatoire** [O][F][A] :
  - citation de 200 caractères au plus ;
  - le code **la retrouve** dans la source, sinon le fait est rejeté ;
  - pour un Markdown : ancre de section + empreinte du passage, la ligne n'étant qu'une
    aide [A].
- **Statuts** [S] (fusion de [O] et [A]) :
  - `observed` (code) ;
  - `proposed` (model) ;
  - `validated` (utilisateur) ;
  - `disputed` (en conflit) ;
  - `superseded` ;
  - `retracted` ;
  - `to_review` (source modifiée ou disparue, ou délai dépassé).
- **Priorité de lecture** [O] : utilisateur > code > validé. **Un fait `proposed` n'est
  jamais injecté comme règle.**
- **Confiance** : un statut discret d'abord ; un nombre seulement pour les statistiques
  de models (taux et n) [O][A].
- **Origine d'un message utilisateur** [A] : un `user_prompt` sans `source` peut être un
  renvoi synthétique du Routage. Il ne vaut parole de l'utilisateur que si son origine
  est prouvée (entrée du dashboard, identifiant). Sinon il reste `proposed`.

### 3.4 Extraction

| Source | Ce qui est produit | Par | Quand | Coût |
|---|---|---|---|---|
| config.json, model-routing.json, catalogue | projets, cases, pipelines (liens seulement) | code | à la relecture | 0 |
| run.json, classify / observe | exécutions, `executed`, refus et incidents **classés par cause** (capacité / critère / infrastructure / couverture) [O] | code | fin d'exécution et balayage de 60 s | 0 |
| regression-perimeters.json, git (50 commits) | fichiers, suites, `covers`, `depends_on` | code | à chaque commit | 0 |
| USER_REQUIREMENTS.md | exigences, `protects`, `delivered_in` | code (tableau) | à la modification | 0 |
| CHANGELOG, TODO, `logs/requests/` | versions, commits, todos, demandes | code | à la modification | 0 |
| front-matter et `[[liens]]` des mémoires | nœuds `regle` / `preference`, `supersedes` quand le texte dit « supersede », « remplace » ou « caduc » | code | à la modification | 0 |
| sections « Décisions de l'utilisateur » | décisions numérotées ; `applies_to` pour les fichiers, tests et cases cités entre accents graves | code | à la modification | 0 |
| corps des mémoires, synthèses, TODO (causes) | portée, motif, exception, `possible_cause_of` | **model** (case `kg.extraire`, sonnet-5-5), schéma fermé, choix dans une liste d'identifiants fournie par le code, citation vérifiée | lot nocturne + à chaud pour une mémoire modifiée | ≈ 10-30 appels/j ; amorçage ≈ 175 appels |
| paires suspectes (même sujet, même portée, toutes deux actives) | `contradicts` candidat | **code** choisit la paire, **model** juge [O] | quotidien | ≈ 10-30 appels courts |
| chef.jsonl | **rien en vrac** ; seulement les paires question → réponse d'origine prouvée [A][F] | code | fin de tour | 0 |
| `logs/<projet>.jsonl`, `.env`, `secrets/`, `api-keys.status.json`, contenus de projets | **jamais** [F][O] | — | — | — |

Règles complémentaires :

- **Déduplication** :
  - identifiants canoniques produits par le code ; le model ne crée jamais d'entité [O][F] ;
  - un fait réextrait incrémente `last_seen` [F] ;
  - aucune fusion par mots (règle 0.66.0) [F] ;
  - un fait recopié depuis un prompt du graphe est marqué « dérivé » et ne se confirme
    jamais lui-même [A].
- **Fraîcheur** :
  - délai de péremption par type : port et service 60 j, statistiques de models 30 j [O],
    fait de model non revu 90 j [F] ;
  - les états volatils (port ouvert, état d'une exécution) sont **relus à la source avant
    tout effet** [A].
- **Coupure automatique** : si plus de 5 % des faits de model échantillonnés sont faux,
  `kg.extract` passe à `off` et le dit [F]. Si le quota manque, l'extraction est
  suspendue sans repli caché [A].

### 3.5 Requêtes

Elles passent par `node scripts/kg.mjs <verbe>` et `GET /api/kg/<verbe>`, en lecture
seule et sans model. La sortie est en Markdown français ou en `--json`.

| Verbe | Rend | Origine |
|---|---|---|
| `fiche <projet>` | règles, décisions et exceptions en vigueur, services et environnement, dépendances, 5 derniers incidents, exigences ouvertes, contradictions qui le touchent | [O][F] |
| `regles --projet --case --model --action` | règles applicables, la plus spécifique puis la plus récente ; **exceptions et conflits toujours rendus** | [O][F][A] |
| `impact <fichier\|projet\|port>` | périmètres et suites (par `regression-targets`, sans second sélecteur [A]), **exigences ⚠**, décisions qui contraignent, projets dépendants | [O][F][A] |
| `explique <id>` | nœud et liens à 1 saut, avec sources ; alimente l'overlay | [O][A] |
| `historique <case>` | n, issues par model servi, causes classées ; « données insuffisantes » si n < 20 (suggestion forte : 30 tâches distinctes [A]) | [O][F][A] |
| `precedents --type --etape --projet` | réponses passées de l'utilisateur à une question de même forme, avec date et source | [O][F] |
| `contradictions`, `perimes` | files de revue | [O][F] |
| `port-libre` | ports déclarés **et** ports réellement à l'écoute | [F] + [S] |

Paramètres communs : `--valide-a` et `--connu-a` [A], `--max-elements`, `--max-tokens`.

**Pas de `similar` au départ** [S]. La recherche lexicale « tâches semblables » de [F]
réintroduirait un routage par mots dans le classifier (règle 0.66.0, [O]). Elle n'entre
qu'en phase 3, et seulement si le banc A/B/C la justifie.

### 3.6 Injection dans le contexte

L'injection est toujours composée par le code, jamais résumée par un model. Chaque ligne
porte sa source et sa date. Une troncature est **signalée** (règle 0.93.0) [O].

| Consommateur | Contenu | Budget |
|---|---|---|
| chef (contexte compact, Routage v3 ph. 2 ; tour ordinaire avant [A]) | « Faits en vigueur » : fiches des projets cités, règles des cases en jeu, contradictions ouvertes | ≤ 1 200 tokens, 12 éléments [O][A] |
| musicien (`dispatch.mjs`) | « Fiche du projet », après les règles fixes ; sautée si vide | ≤ 800 tokens [O] |
| Liste de tests, Revue, Comprendre / Concevoir | `impact` des fichiers touchés ou nommés | ≤ 400 tokens [O][F] |
| Livrer (par le code, D9) | version précédente, exigences à tracer, dépendants | données, pas de prose [F] |
| classifier | **seulement** les décisions explicites qui fixent un pipeline pour ce projet (ex. youtube-live hors pipelines) | ≤ 200 tokens [S] (entre [O] « rien » et [F] « similar ») |
| réponse automatique | garde-fous (hors graphe, vérifiés **avant**), `regles`, `precedents` | ≤ 25 lignes [F] |

**Règle de non-troncature** [A] : les interdictions, garde-fous et conflits ne sont jamais
soumis au classement « top N ». Si le budget déborde, on garde un marqueur de conflit et
une référence.

Chaque exécution **fige** la génération de l'index et ce qui a été injecté [A]. Les
garde-fous et révocations sont **revérifiés au moment de l'effet** [A].

### 3.7 Interface

- **Overlay des identifiants** (`id-resolve.mjs`, 0.107.0) : section « Liens », 1 saut,
  10 liens et « voir plus ». Nouveaux types `f-…` et `ROUTAGE-D4` [O].
- **Onglet « 🧠 Mémoire »** du panneau latéral, bureau et mobile [O][F] :
  - fiche à quatre questions : *ce que nous savons, pourquoi, depuis quand, où cela
    s'applique* [A] ;
  - **Revue** des faits proposés, `to_review` et contradictions, avec les boutons
    Valider, Corriger, Périmer à la date…, Rejeter (motif), Ouvrir la source [O][F] ;
  - **Règles en vigueur** par projet et par case, avec la chaîne `supersedes`
    dépliable [O] ;
  - **Statistiques de models** par case, mêmes données que les suggestions de la page
    Models [O].
- **Bandeau** « N contradictions entre règles », avec pour chacune les deux sources et le
  bouton « celle-ci vaut » [F].
- **Chaque correction** est un événement `by: user`, avec `commandId` idempotent et
  révision attendue (sinon conflit affiché) [A]. Elle n'est jamais écrasée par une
  reconstruction [O].
- **Corriger la source** : pour un fait issu d'une mémoire ou d'un registre, le bouton
  propose un dispatch au projet propriétaire. Jamais d'écriture silencieuse du serveur
  dans `~/.claude` ni dans un registre [O][A].
- Pas de dessin de graphe en phase 0. Un voisinage limité à ≈ 30 nœuds viendra plus
  tard, si l'usage le demande [F][A].

### 3.8 Garde-fous

| Risque | Parade |
|---|---|
| fait obsolète (ex. table des ports, §1.1) | `valid_to`, péremption par type, « vu le », mention « à revoir » dans l'injection, état vivant relu avant effet [O][F][A] ; **[S]** pour les ports, croisement avec la liste des ports réellement à l'écoute |
| fait faux / halluciné | schéma fermé, citation retrouvée, `proposed` jamais injecté comme règle, coupure > 5 % [O][F] |
| **faux consentement** | origine prouvée d'un message utilisateur ; `mentions` ≠ `resumes` ; une préférence générale « avancer » ne lève aucun garde-fou [A] |
| réponse automatique | liste fermée (argent, secret, envoi en son nom, suppression sans retour, publication d'un dépôt privé) vérifiée **hors du graphe et avant** ; un précédent n'est qu'un appui cité [O][F][A] |
| secrets | liste blanche de sources et de champs ; masquage (`maskSecrets` + motifs du fleet) **avant disque et avant model** ; test de corpus piégé ; purge `forget --source` [O][F][A] |
| vie privée, fuite entre projets | contenus de projets exclus ; un musicien ne voit que son projet et les faits partagés explicitement ; filtrage avant expansion [A] |
| prompt injection | texte source traité comme donnée ; aucune commande construite depuis une assertion [A] |
| pollution récursive | faits dérivés marqués ; une répétition n'augmente pas la confiance [A] |
| statistiques trompeuses | cause classée, n minimal, model servi, infrastructure séparée ; suggestion seulement (D16) [O][A] ; le cas réel `dev.vert.complexe` (§1.3) entre au corpus [S] |
| seconde vérité | balayage des divergences entre graphe et source ; correction à la source par dispatch [O] |
| tour du chef plus lent | `routage-bench` avant et après ; abandon au-delà de +5 s sur la médiane [F] |

### 3.9 Mesure du bénéfice : tests sur de vrais cas passés

**Corpus** `tests/kg-corpus/`, anonymisé (dépôt public) :

| Cas réel | Attendu |
|---|---|
| règle des models, 4 sources (§1.1 C1) | chaîne `supersedes` reconstruite ; règle en vigueur = page Models par case ; contradiction « directive globale ↔ cases » et index `MEMORY.md` périmé signalés [O][F] |
| 17 / 38 projets, vuBox WSL / natif, Routage du chef | les 4 contradictions sortent, 0 fausse sur les prédicats fonctionnels [F] |
| table des ports : WSL arrêté, annuaire, immo-share et Ollama muets | lignes `to_review` dès que le port déclaré ne répond plus [S] |
| youtube-live hors pipelines ; p-20261019T163311-e4336f `paused` contre mémoire « abandon » | exception rendue dans la fiche ; conflit d'état **montré**, pas tranché [F][A] |
| quatre pauses mortes du chef | ne jamais proposer leur reprise (état `abandoned` lu à la source) [A] |
| p-20261018T154104-6cfbe8 : 8 refus « aucun commit » | signature reconnue au 2ᵉ refus [A][F] |
| FAILOVER vuBox 1.32.15-19 | « versions livrées par un model de repli » en une requête [F] |
| haiku et session longue ; « Opus 5.5 n'existe pas » | rappel de l'incident et de sa conduite au dispatch [O] |
| `impact scripts/dispatch.mjs` et les fichiers des décisions 9 et 10 | 100 % des tests ⚠ du tableau §11.1 [O] ; égal à `selectTargets` sur 50 commits [F] |
| 21 questions posées à l'utilisateur par le Routage | ≥ 5 rendues inutiles [F] |
| 20 questions piégées (garde-fous) | 20 sur 20 bloquées [F] |
| décision connue le 20 et valable le 19 | 0 fait futur dans un rejeu au 19 [A] |

**Banc A/B/C** [A] : (A) comportement actuel, (B) bon index textuel avec dates, (C) B
plus les relations typées. C–B mesure l'apport **propre** du graphe ; on publie les
intervalles.

**Critères chiffrés (7 jours en prod après le bond, ≥ 100 décisions concernées [A])** :

| Mesure | Seuil |
|---|---|
| exactitude des faits injectés (50 lignes jugées par l'utilisateur) | ≥ 90 % [O] |
| faits de model faux (échantillon hebdomadaire de 30) | ≤ 5 %, sinon coupure [F] |
| citations retrouvées, règles confirmées | 100 % [A] |
| C–B sur les cas relationnels | ≥ +10 points, sinon on reste sur B [A] |
| secret, faux consentement, reprise implicite, fuite entre projets | 0 ; un seul cas bloque la clé concernée [A] |
| tokens injectés chef / musicien | ≤ 1 200 / ≤ 800 [O] |
| latence requête / reconstruction incrémentale | < 100 ms / < 1 s [O][F] |
| tour du chef | +0 à +5 s sur la médiane [F] |
| contradictions ouvertes depuis plus de 7 jours | 0 [O] |
| retour à `off` | < 1 min, sans effet dupliqué [A] |

Si les trois premiers seuils ne sont pas tenus, on garde l'index (phase 0 b) et on coupe
l'injection [O][A].

### 3.10 Articulation avec ROUTAGE-SYNTHESE et PIPELINES-SYNTHESE

| Décision | Conséquence pour le graphe |
|---|---|
| Routage D1 (registre en fichiers, « No database ») | le graphe **lit** `logs/requests/`, ne l'écrit jamais ; même règle de stockage |
| Routage D2 (tour unique du chef sur sonnet-5-5) | « Faits en vigueur » entre dans le contexte compact ; la case `routage.chef` n'existe pas encore en prod (§1.1) |
| Routage D3 (classement tâche par tâche) | paquet par tâche, limité aux décisions explicites (§3.6) |
| Routage D4 (reprise seulement explicite) | `mentions` jamais converti en reprise [A] |
| Routage D5 (réveils par le code) | le réveil lit `explique <exécution>` seulement si une décision est requise [F] |
| Routage D6 (Routage du chef coupé) | la phase 0 b sert le chef ordinaire ; on n'attend pas la v3 [A] |
| Routage D7 (pauses mortes closes) | état lu à la source, jamais d'un ancien événement [A] |
| Routage D8 (actions du chef au registre) | importées par le registre, pas par le texte [F] |
| Routage D9 (tests d'exigence intouchables) | aucun test d'exigence modifié ; `_test_id_links` gagne des cas sans changer d'assertion [O] |
| Pipelines D6 (seuil des besoins) | le registre des besoins garde la propriété ; le graphe empêche de compter deux fois une même demande [A] |
| Pipelines D9 (Livrer par le programme) | Livrer reçoit des données du graphe [F] |
| Pipelines D14 (« continuer » automatique : non) | tenue : la limite reste une pause ; réponse en absence bornée (décision 6) [S] |
| Pipelines D16 (models plus légers = suggestions) | `historique` alimente les suggestions, jamais d'office [O][F][A] |
| Pipelines D17 (ordre, bond, pipelineLab d'abord) | la phase 0 b part en parallèle des gains rapides |
| Pipelines §8.1 (bascule, réglages figés, ombre) | mêmes mécanismes pour `kg.*` |
| règle du 2026-10-20 (réponse en absence) | garde-fous hors du graphe, lus d'abord ; précédents cités en appui |

---

## 4. Plan par phases

**Règles communes :**

- **Prod/dev** [O][F][A] :
  - code et non-régression dans **orchestrateur-dev** (bac à sable 7778, faux claude,
    fixtures, `tests/real-config.mjs`) ;
  - tag `vX.Y.Z`, et tag de retour `pre-kg-<phase>-vX.Y.Z` ;
  - **bond conduit par le chef sur décision de l'utilisateur** (`prod-jump.mjs` : TDD de
    la livraison passés avant le bond, non-régression complète après ; rouge = aucun
    nouveau bond) ;
  - l'observation réelle se fait en prod seulement.
- **Réglages à chaud** dans `model-routing.json`, écrits par
  `pipeline-enforce.mjs kg <clé> on|off|shadow` et relus à chaque dispatch :
  - `kg.mode` vaut `off`, `shadow` ou `assist` [A] ;
  - les clés `kg.build`, `kg.extract`, `kg.injectChef`, `kg.injectMusicians`,
    `kg.injectSteps`, `kg.injectClassifier`, `kg.autoAnswer` et `kg.ui` sont réglables
    une à une [O][F] ;
  - chaque clé à `off` = comportement actuel exact ;
  - réglages figés par exécution.
- **Retour arrière** :
  - `kg off --all` à chaud, en moins d'une minute ;
  - supprimer `logs/kg/` ne casse rien : la couche dérivée se reconstruit ;
  - seul `facts.jsonl` est sauvegardé chaque jour [O].
- **Exigences** :
  - la demande verbatim de l'utilisateur et chaque comportement livré entrent dans
    `docs/USER_REQUIREMENTS.md` d'orchestrateur-dev avec leur test ;
  - un périmètre `kg` est ajouté à `regression-perimeters.json`.

| Phase | Contenu | Effort | Critère de sortie |
|---|---|---|---|
| **0 a — ménage, sans code (tout de suite)** [S] | le chef applique les décisions 1 à 5 (§5) dans sa mémoire et son CLAUDE.md ; les cas avant/après entrent au corpus | 0,5 j (chef) | les 5 contradictions closes et datées |
| **0 b — index dérivé, sans model** [O][F][A] | `kg.mjs` : `build`, `fiche`, `regles`, `impact`, `explique`, `contradictions`, `port-libre`, `perimes` ; extracteurs de code du §3.4 ; prédicats fonctionnels ; filtre de secrets ; rapport `logs/kg/contradictions.md` ; overlay « Liens » ; **aucune injection** ; `kg.build` seul | 2 j | corpus 0 b vert ; `impact` = `selectTargets` ≥ 95 % ; build < 2 s ; 0 secret ; suites `_test_kg_core`, `_test_kg_extract_code`, `_test_kg_contradictions`, `_test_kg_impact`, `_test_kg_no_secret`, `_test_kg_readonly`, `_test_kg_switches` |
| **1 — faits curés et onglet Mémoire** | `facts.jsonl`, événements, verrou ; extraction model (`kg.extraire`) avec citation vérifiée et coupure automatique ; paires suspectes ; onglet, bandeau, API d'écriture | 2,5 j | ≤ 5 % de faux sur 30 faits ; `proposed` jamais injecté ; HTTP `kg-review` ; navigateur `kg-tab` (bureau et mobile) |
| **2 — injection, ombre puis assistée** | fiche du musicien (peut précéder) ; « Faits en vigueur » du chef (tour ordinaire, puis contexte compact v3) ; `impact` pour les étapes ; classifier limité ; budgets, non-troncature | 2 j | 3 à 7 j d'ombre en prod ; exactitude ≥ 90 % ; budgets tenus ; banc A/B/C publié |
| **3 — incidents, précédents, suggestions** | incidents liés à une condition ; `precedents` pour la réponse automatique (après garde-fous) ; `historique` → suggestions de la page Models ; `similar` seulement si C–B le justifie | 2 j | 20/20 questions piégées bloquées ; 0 case changée d'office |
| **4 — bascule et mesure** | bond, clés activées une à une, 7 j de mesure (§3.9) | 0,5 j + 7 j | seuils du §3.9 |
| **5 — registres des refontes** | nœuds `demande`, `besoin`, opérations typées quand ils existent | 0,5 j | `explique r-…` complet |

**Total ≈ 10 jours**, hors observation. Le chiffre est entre [O] (8,5) et [A] (10-14),
car il intègre la revue des premiers faits et le banc A/B/C.

Dépendances :

- la phase 0 b est indépendante ;
- l'injection du chef en contexte compact attend la phase 2 du Routage v3 ;
- la phase 3 attend la livraison de la réponse automatique (orchestrateur-dev, demandée
  le 2026-10-20) et la phase 1 des Pipelines.

---

## 5. Décisions pour l'utilisateur (consolidées, dédupliquées)

**Contradictions à trancher maintenant (phase 0 a)**

1. **Quelle règle des models vaut ?** Quatre textes se contredisent : tout sur Opus 4.8,
   tout sur Opus 5.5, un vieux tableau du chef, et la page Models qui choisit case par
   case.
   - **Recommandé** : la page Models fait foi case par case ; Opus 5.5 reste le défaut
     pour tout ce qui n'a pas de case.
   - Le chef marque comme remplacées les deux anciennes mémoires, corrige leurs lignes
     d'index et remplace son tableau par un renvoi à la page Models.
   - Aucun test d'exigence touché.
2. **Nombre de projets** : 38 dans la configuration, 20 dans les pipelines. **Recommandé** :
   corriger « 17 » dans le profil du chef. Aucun test touché.
3. **vuBox et la table des ports.** Vérifié : vuBox tourne en Windows natif ; WSL est
   arrêté.
   - L'annuaire (port 80), immo-share et Ollama ne répondent plus.
   - BookHaven et panierIL tournent sous Windows alors que la table les dit « WSL ».
   - **Recommandé** : le chef refait la table d'après ce qui écoute réellement, et vous
     dit si l'annuaire et les services WSL doivent être relancés (c'est de
     l'exploitation, hors de cette étude). Aucun test touché.
4. **Routage du chef** : déjà corrigé dans son CLAUDE.md. **Recommandé** : le garder tel
   quel comme cas de test du détecteur. Aucun test touché.
5. **youtube-live** : une exécution est encore « en pause » alors que la mémoire du chef
   la dit abandonnée. **Recommandé** : la clore par la commande de clôture, avec un
   motif, comme les quatre pauses du chef. Aucun test touché.
6. **Réponse automatique en votre absence et « continuer » après une limite.**
   - **Recommandé** : les deux règles tiennent ensemble. Le programme ne franchit jamais
     seul une limite (décision 14) : il pose la question. En votre absence (15 + 5 min),
     Opus 5.5 peut y répondre, avec quatre bornes :
     - une fois par exécution ;
     - point de retour obligatoire ;
     - réponse marquée « auto » ;
     - jamais « abandonner ».
   - L'autre choix (avis d'Astra) : une limite attend toujours votre retour.
   - ⚠ **Touche un test d'exigence** : `_test_pipeline_gates.mjs` reste inchangé (la
     pause demeure), mais l'exigence « réponse automatique » doit être créée avec un
     test qui couvre ce cas.

**Forme du graphe**

7. **Un index de faits en fichiers, construit d'abord par le programme**, sans base de
   données, sans GraphRAG, sans embeddings ; les fichiers actuels restent la vérité.
   **Recommandé : oui.**
8. **Rôle des models** : ils proposent des liens avec une citation exacte que le
   programme retrouve. Rien de proposé ne sert de règle avant votre validation.
   Extraction coupée d'office au-delà de 5 % d'erreurs. **Recommandé : oui, sur
   sonnet-5-5, à partir de la phase 1 seulement.**
9. **Validation** : vous validez les faits proposés par lots dans l'onglet Mémoire. Les
   décisions déjà écrites dans une section « Décisions de l'utilisateur » sont reprises
   telles quelles, source affichée. **Recommandé : oui.**
10. **Lire vos messages au chef** : seulement les paires question → réponse dont on
    prouve qu'elles viennent de vous ; jamais les journaux des musiciens ni les contenus
    d'outils. **Recommandé : oui**, à partir de la phase 3.

**Usage**

11. **Ce qui est injecté** : le chef reçoit au plus une page (≈ 1 200 tokens) ; un
    musicien, au plus 800 tokens pour son projet ; le classement, seulement les
    décisions qui fixent un pipeline pour un projet. Toujours avec source et date. Les
    interdictions ne sont jamais coupées. **Recommandé : oui, après 3 à 7 jours en mode
    ombre.**
12. **Réponse automatique** : elle peut citer vos décisions passées de même forme comme
    appui. Les garde-fous restent vérifiés avant et ne sont jamais levés par un
    précédent. **Recommandé : oui.**
13. **Suggestions de models** tirées de l'historique : affichées sur la page Models avec
    le nombre de cas, jamais appliquées d'office (décision 16). **Recommandé : oui.**
14. **Recherche par ressemblance** (tâches semblables, embeddings locaux) : **Recommandé :
    pas maintenant**, seulement si le banc montre un manque.
15. **Corriger une mémoire** : quand vous corrigez un fait issu d'une mémoire ou d'un
    registre, le programme propose de corriger aussi le fichier d'origine, par le projet
    concerné. Rien n'est réécrit en silence. **Recommandé : oui.**
16. **Confidentialité** : le graphe vit sous `logs/`, n'est jamais commité ni
    synchronisé ; les tests utilisent un corpus anonymisé. **Recommandé : oui.**

**Conduite du projet**

17. **Ordre et mise en prod** :
    - phase 0 a tout de suite (ménage par le chef) ;
    - phase 0 b (2 jours, sans model) en parallèle des gains rapides des Pipelines ;
    - injection du chef après la phase 2 du Routage ;
    - précédents après la réponse automatique ;
    - chaque phase développée dans orchestrateur-dev, puis bond décidé par vous.

    **Recommandé : oui.**
18. **Condition pour continuer après la mesure** : un gain mesuré face à un bon index
    textuel (≥ 10 points sur les cas relationnels), zéro faute de garde-fou, budgets
    tenus ; sinon on garde l'index simple et on coupe l'injection. **Recommandé : oui.**

---

## 6. Décisions de l'utilisateur (2026-10-20)

Réponse de l'utilisateur au §5, verbatim : « tout comme recommandé ». Pour la
décision 6, verbatim : « applique la recommandation ». Les 18 décisions sont adoptées
**telles que recommandées**. Elles s'imposent aux phases du §4 ; **une phase qui s'en
écarte doit d'abord obtenir une nouvelle décision de l'utilisateur**.

Copie de la synthèse de `veille` (`reports/KG-SYNTHESE.md`, commit 62d737f), section
ajoutée dans orchestrateur-dev.

1. **Règle des models** : la page Models fait foi case par case ; Opus 5.5 reste le
   défaut hors case. Le chef marque les deux anciennes mémoires comme remplacées,
   corrige leurs lignes d'index et remplace son tableau par un renvoi à la page Models.
   *Appliquée par le chef (mémoire).*
2. **Nombre de projets** : 38 dans la configuration, 20 dans les pipelines ; « 17 »
   corrigé dans le profil du chef. *Appliquée par le chef.*
3. **vuBox et la table des ports** : le chef refait la table d'après ce qui écoute
   réellement et dit si l'annuaire et les services WSL doivent être relancés.
   *En attente d'une précision de l'utilisateur (WSL et ports).*
4. **Routage du chef** : correction de son CLAUDE.md gardée telle quelle, comme cas de
   test du détecteur. *Appliquée par le chef.*
5. **youtube-live** : l'exécution restée « en pause » est close par la commande de
   clôture, avec un motif. *Appliquée par le chef.*
6. **Réponse automatique et « continuer » après une limite** : le programme ne franchit
   jamais seul une limite (décision 14 des Pipelines) ; en l'absence de l'utilisateur
   (15 + 5 min), Opus 5.5 peut répondre à la pause, une fois par exécution, avec point
   de retour obligatoire, réponse marquée « auto », jamais « abandonner ». L'exigence
   « réponse automatique » couvre ce cas par un test ; `_test_pipeline_gates.mjs` reste
   inchangé. *Tâche séparée d'orchestrateur-dev.*
7. **Index de faits en fichiers**, construit d'abord par le programme, sans base de
   données, sans GraphRAG, sans embeddings ; les fichiers actuels restent la vérité.
8. **Rôle des models** : ils proposent des liens avec une citation exacte que le
   programme retrouve ; rien de proposé ne sert de règle avant validation ; extraction
   coupée d'office au-delà de 5 % d'erreurs ; sonnet-5-5, à partir de la phase 1
   seulement.
9. **Validation** par lots dans l'onglet Mémoire ; les décisions déjà écrites dans une
   section « Décisions de l'utilisateur » sont reprises telles quelles, source affichée.
10. **Messages de l'utilisateur au chef** : seulement les paires question → réponse
    d'origine prouvée ; jamais les journaux des musiciens ni les contenus d'outils ; à
    partir de la phase 3.
11. **Injection** : chef ≤ 1 200 tokens, musicien ≤ 800 tokens pour son projet,
    classement limité aux décisions qui fixent un pipeline pour un projet ; source et
    date toujours ; interdictions jamais coupées ; après 3 à 7 jours en mode ombre.
12. **Réponse automatique** : peut citer les décisions passées de même forme comme
    appui ; les garde-fous restent vérifiés avant et ne sont jamais levés par un
    précédent.
13. **Suggestions de models** tirées de l'historique : affichées sur la page Models avec
    le nombre de cas, jamais appliquées d'office.
14. **Recherche par ressemblance** : pas maintenant, seulement si le banc A/B/C montre un
    manque.
15. **Corriger une mémoire** : le programme propose de corriger aussi le fichier
    d'origine, par le projet concerné ; rien n'est réécrit en silence.
16. **Confidentialité** : le graphe vit sous `logs/`, jamais commité ni synchronisé ;
    les tests utilisent un corpus anonymisé.
17. **Ordre et mise en prod** : phase 0 a tout de suite (chef) ; phase 0 b (2 jours, sans
    model) en parallèle des gains rapides des Pipelines ; injection du chef après la
    phase 2 du Routage ; précédents après la réponse automatique ; chaque phase
    développée dans orchestrateur-dev, puis bond décidé par l'utilisateur.
18. **Condition pour continuer après la mesure** : gain ≥ 10 points face à un bon index
    textuel sur les cas relationnels, zéro faute de garde-fou, budgets tenus ; sinon on
    garde l'index simple et on coupe l'injection.

---

## 7. État livré de la phase 1 (orchestrator-dev 0.131.0)

Décision de l'utilisateur du 2026-10-22 : « vas y » (phase 1 « faits curés et onglet
Mémoire »). Tout est derrière un interrupteur, coupé par défaut ; coupé = 0.130.0 exact.

| Élément (§4, phase 1) | Livré |
|---|---|
| `facts.jsonl`, événements, verrou | `logs/kg/facts.jsonl` en ajout seul, écrit par `scripts/kg.mjs` seul, sous verrou (`withFactsLock`) ; événements `assert` (toujours `proposed` pour un model), `seen`, `pair`, `decide` (`validate`, `reject` + motif, `correct`, `expire` à une date, `arbitrate` « celle-ci vaut »), `cutoff`. Décision idempotente par `commandId`, révision attendue (409). Les décisions sont posées sur l'index dérivé au chargement : jamais écrasées par une reconstruction. `review.jsonl` journalise l'entrée et la sortie de la file de revue ; `backup/` garde une copie quotidienne (30 jours). |
| extraction par model (`kg.extraire`) | `kg.mjs extract`, case `kg.extraire` de la page Models (vide : `claude-sonnet-5-5`, décision 8 ; Claude seulement en phase 1). Mémoires, sections des synthèses, TODO ; secrets masqués avant le model ; identifiants et prédicats fournis par le code (liens seulement) ; citation de 200 caractères au plus retrouvée, sinon rejet motivé ; source inchangée jamais relue ; appel en échec = lot suspendu, sans repli ; 30 appels par jour. |
| citation vérifiée et coupure automatique | plus d'un faux (rejeté ou corrigé) parmi les 30 derniers faits de model jugés = `kg.extract` coupé d'office, raison écrite dans `model-routing.json` et dans l'onglet ; rallumer ouvre une nouvelle fenêtre. |
| `proposed` jamais injecté | `injectable()` : seuls les faits observés par le code ou validés par l'utilisateur sont énoncés (règles, fiches, et l'injection de la phase 2) ; toujours aucune injection dans un tour. |
| paires suspectes | `kg.mjs pairs`, case `kg.juger` : deux règles actives sur la même cible, portées qui se recouvrent, sans lien de remplacement ni d'exception ; « compatible » gardé et jamais montré ; le reste en revue, confirmé puis tranché. |
| onglet, bandeau, API d'écriture | onglet « 🧠 Mémoire » (bureau et mobile) : Revue, Règles en vigueur (chaîne des remplacements), Statistiques ; bandeau « N contradictions entre règles » dans la zone des demandes ; `GET /api/kg/status|review|rules|stats|source`, `POST /api/kg/decision` (même origine). Le serveur ne charge jamais `kg.mjs` : il le lance en sous-processus. App Android 1.1.0 : écran Mémoire. |
| reconstruction (`kg.build`) | balayage du serveur toutes les 5 min : reconstruction seulement si une source a changé (empreinte), sauvegarde quotidienne ; avec `kg.extract`, mémoires modifiées aussitôt, tout le corpus la nuit (après 3 h) puis les paires. |

**Critères de sortie.** `proposed` jamais injecté, HTTP `kg-review` et navigateur `kg-tab`
(bureau et mobile) : vérifiés par la non-régression. « ≤ 5 % de faux sur 30 faits » : se
mesure en prod, sur les 30 premiers faits que l'utilisateur juge dans l'onglet ; la coupure
automatique applique le même seuil.

**Mise en service (après le bond, décision de l'utilisateur)** : `kg.mode` est déjà
`shadow` en prod ; puis `pipeline-enforce.mjs kg ui on` (onglet), `kg build on`
(reconstruction automatique), et `kg extract on` (extraction par model : ≈ 175 appels pour
l'amorçage, 30 par jour au plus, ou `kg.mjs extract --max N` à la main). Retour arrière :
`kg <clé> off`, ou `kg off` (tout coupé).
