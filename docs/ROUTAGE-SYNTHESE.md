# Routage du chef — troisième avis et synthèse (auteur : Opus 5.5)

> Demande de l'utilisateur (2026-10-19) : « On va commencer par travailler sur le
> routage : il y a trop d'erreurs, et c'est trop difficile de les corriger quand ca
> arrive. Des qu'il y a un probleme on est dans une impasse. Il faut demander a Fable
> 5.5 et openai 6 astra de travailler sur une solution chacun, puis opus 5.5 fera son
> avis et prendra la synthese du meilleur des 3 » ; puis : « Et aussi il doit etre
> beaucoup plus rapide : reduire ou simplifier les taches ».
>
> Sources comparées : `docs/ROUTAGE-SOLUTION-fable.md` (claude-fable-5-1, commit
> 49fe173) et `docs/ROUTAGE-SOLUTION-astra.md` (gpt-6-astra, commits 88ddae7 et
> f890560). Document de décision écrit en français, comme les deux études. Étude
> seulement : aucun code modifié, aucun redémarrage. Les fichiers non commités de
> l'exécution en pause n'ont pas été touchés. Attribution de chaque idée :
> **[F]** Fable, **[A]** Astra, **[O]** Opus.

---

## 1. Avis propre d'Opus (diagnostic refait sur les données)

Mesures relevées en lecture seule dans la prod : 613 `run.json` du Routage
(2026-10-09 11:19 → 2026-10-19 18:25), `chef.jsonl` (416 Mo),
`pipeline-classify.ndjson`, `chef-actions.log`, `model-routing.json`.

| Mesure | Valeur | Remarque |
|---|---|---|
| Exécutions | 413 demande, 197 réveil, 3 discussion ; 609 `done`, 4 `paused` | |
| Durée murale d'une demande (`endedAt − createdAt`) | médiane **104 s**, p90 153 s, p95 **172 s**, max **966 s** | 118 au-delà de 2 min, 16 au-delà de 3 min |
| Somme des `durationMs` des étapes d'une demande | médiane **102 s**, p95 170 s, max 964 s | la mesure de Fable |
| Réveil | médiane 87 s, p95 124 s, max 270 s | |
| Latence perçue (`user_prompt` sans source → `result`, `chef.jsonl`) | médiane **98 s**, p90 140 s, p95 159 s, n = 327 | ce que l'utilisateur attend vraiment |
| Étapes de model, médianes (demande) | Lire 23 s · Comprendre 8,5 s · Découper 29 s · Classer 7 s (p95 35 s) · Rapporter 26 s | Affecter, Dispatcher, Relancer : < 0,5 s |
| Exécutions avec au moins un nouvel essai | 50 sur 413 (12 %), médiane 141 s | chaque essai coûte ~30 s |
| Essais de Découper refusés | 47 sur 458 (10 %) | 12 « renvoi_chef ne peut pas attendre », 5 « apres → renvoi », 16 « aucune tâche » (corrigé 0.70.0), 6 « le chef ne se délègue pas » |
| Messages sans tâche (réponse ou question) | 93 sur 413 (23 %) | ils paient quand même Lire + Comprendre + Rapporter |
| Tâches lancées | 230 routées, 21 questions, 11 actions du chef | sur les exécutions qui portent `tasks` |
| Classifier | 255 décisions, **0 échec** | sonnet-5 |
| Coût cumulé indiqué par le CLI | **886,6 $** (637 demande, 245 réveil, 4 discussion) | **équivalent API** : la facturation passe par l'abonnement OAuth (règle du fleet). C'est du quota consommé, pas une facture |
| Renvois au chef | 16, dont 5 sorties 65 (P0-B, corrigé 0.100.1) | |
| **État actuel de la prod** | `pipeline-enforce off --chef` le 2026-10-19 à 18:27:54 ; prod en 0.114.3 | depuis, le chef fait des tours ordinaires : 5 messages, médiane **55 s** (25 à 80 s) |

Ce que j'en conclus, avant lecture détaillée des deux études :

1. **La lenteur vient du nombre d'appels, pas du message.** Quatre à cinq `claude -p`
   en série relisent le même contexte. Lire (23 s) ne produit rien qu'une autre
   étape ne refasse. Rapporter (26 s, opus) rédige des faits que le code possède.
   Le tour ordinaire du chef mesuré depuis la coupure (55 s, opus, avec ses outils)
   montre l'ordre de grandeur d'un seul appel.
2. **Les erreurs viennent surtout de contraintes du moteur imposées au model**
   (renvoi en fin de tour, interdiction de dépendre du chef). Le validateur refuse
   tout l'artefact ; le second essai passe en retirant la contrainte, donc en
   perdant du sens.
3. **Les impasses ont trois causes vérifiables dans le code** :
   - une réponse à une pause du chef ne l'atteint jamais : `dispatch.mjs:1446-1461`
     (`CHEF_ROUTED`) sort sur un `runPipeline` neuf **avant** le traitement des
     réponses de pause (`dispatch.mjs:1462-1499`) ;
   - les pannes d'infrastructure (OAuth, quota, refus du fournisseur, sortie 1) sont
     comptées comme critères non remplis ;
   - aucune commande ne clôt une demande comme unité.
4. **Une classe d'erreur silencieuse** : `detectReprise` (`routage-pending.mjs:221`)
   transforme tout identifiant d'exécution en pause cité dans le texte en reprise.
   Vérifié sur [[p-20261019T180056-e8254b]] : la tâche est une Discussion, mais
   `dispatch.json` porte `reprise: p-20261019T144511-44d707`.
5. **Ma solution** : un seul tour du chef, avec un plan typé ; une réparation par le
   code qui ne retire jamais une contrainte ; un registre des demandes en fichiers
   (pas de base de données) ; des chemins directs à 0 appel ; des pannes
   d'infrastructure garées et relancées automatiquement ; des actions du chef dont
   le **résultat** est vérifié, pas seulement le code retour.

---

## 2. Comparaison des trois propositions

### 2.1 Tableau condensé

| Critère | Fable — « un tour, un plan, une boîte de réception » | Astra — « petit ordonnanceur transactionnel » | Opus — synthèse |
|---|---|---|---|
| a) Erreurs | Supprime les refus de forme par réparation (table 2.3) ; **manque la reprise par citation** | Couvre la reprise par citation, l'ordre perdu, les postconditions ; réparation bornée qui ne retire aucune contrainte | Réparation de Fable + règle d'Astra « ne jamais retirer une contrainte » + reprise seulement explicite |
| b) Impasses | 7 statuts, chaque statut non terminal a 3 sorties (chat, CLI, bouton), testées | 10 états de tâche, `needs_action` avec responsable, CLI de secours sans model ni tableau de bord | 2 niveaux (demande, tâche), états d'Astra simplifiés, sorties de Fable, test de couverture |
| c) Vitesse | 102 s → ~40 s (tâches), 25 s (réponse), 30 s (réveil), < 2 s (menu) | 104 s → 25–45 s, p95 60–90 s ; réveil < 2 s pour l'état | demande ≤ 45 s, p95 ≤ 90 s ; réponse ≤ 30 s ; réveil < 2 s (état) + ≤ 30 s si une décision est requise |
| d) Coût | −70 % (sonnet) estimé | non chiffré | −60 à −70 % de quota |
| Effort | ~8,5 j | 14–22 j | ~11 j |
| Risque de migration | faible : bascule à chaud `chefMode` | élevé : import, double propriétaire, base | faible : bascule à chaud, registre en fichiers, mode ombre |
| Règles du fleet | ✓ fichiers ; ✗ rattachement « au plus récent » (devine) ; ✗ « une semaine en dev » impossible (la dev n'a pas de chef vivant) | ✗ **SQLite contredit « No database »** ; ✓ règle de non-devinette | ✓ fichiers, ✓ aucune devinette, ✓ dev → bond |

### 2.2 Chiffres en conflit, vérifiés

| Affirmation | Vérification | Verdict |
|---|---|---|
| Fable : 102 s de médiane par message | somme des `durationMs` : 102 s | exact (somme des étapes) |
| Astra : 104 s, p95 172 s, max 966 s | `activeMs` / `endedAt − createdAt` : 104 / 172 / 966 s | exact (durée murale) |
| Les deux | latence perçue dans `chef.jsonl` : 98 s, p95 159 s | les deux mesures sont cohérentes et décrivent le même problème |
| Fable : « 887 $ en dix jours » | somme : 886,6 $ | chiffre exact, **interprétation fausse** : c'est l'équivalent API calculé par le CLI ; la facturation passe par l'abonnement (quota), pas par un débit de 887 $ |
| Fable : 13 refus « renvoi_chef ne peut pas attendre » | 12 | Fable surcompte de 1 (Astra : 12) |
| Fable : 7 refus « le chef ne se délègue pas » | 6 (5 + 1 variante) | Astra exact |
| Fable : 25 `[DÉFAUT]` pour le chef ; Astra : 45 | 45 `user_prompt` « [DÉFAUT — chef — … » dans `chef.jsonl` | Astra exact |
| Fable : les pauses du chef sont irrécupérables par le chat | `dispatch.mjs:1446-1461` sort avant `1462-1499` | **Fable exact** |
| Astra : « des menus existent » pour les pauses du chef (§4.5) | le menu est affiché, mais aucune réponse ne l'atteint | **Astra inexact** pour le chef |
| Astra : reprise déclenchée par un identifiant cité (§4.1) | `detectReprise` + `dispatch.json` de [[p-20261019T180056-e8254b]] | **Astra exact** ; Fable n'en parle pas |
| Astra : « abandonner » traduit en `kill-stalled` (§4.3) | `dispatch.json` de [[p-20261019T181739-7e7851]] : `kill-stalled … no pid file — nothing to kill`, statut `done` ; [[p-20261019T144511-44d707]] toujours `paused` | **Astra exact** |
| Astra : Routage du chef coupé en prod | `enforcement.since 2026-10-19T18:27:54Z, by: pipeline-enforce off --chef` | exact ; Fable écrit avant la coupure |

### 2.3 Erreurs factuelles et points faibles

**Fable**
- Présente 887 $ comme une dépense, alors que c'est un équivalent API (quota d'abonnement).
- Ne voit pas la reprise par citation (5 cas au moins : [[p-20261019T180056-e8254b]],
  [[p-20261012T073703-b610a9]], [[p-20261012T075424-47deee]], [[p-20261016T163603-9c57b2]],
  [[p-20261017T084436-c012a2]]) et garde le champ `reprise` sans retirer la détection dans le texte.
- Rattache le message suivant « au ticket en attente le plus récent ». Avec plusieurs
  tickets ouverts, c'est deviner : la règle du fleet impose de demander.
- La réparation « dépendance invalide retirée, tâche lancée » peut reproduire
  l'inversion de [[p-20261019T181739-7e7851]].
- Phase 4 « chefMode v2 en dev une semaine » : orchestrateur-dev n'a ni serveur ni
  chef vivant (bac à sable seulement). L'observation réelle ne peut se faire qu'en
  prod, après un bond.
- Petits surcomptes (13 au lieu de 12, 7 au lieu de 6).

**Astra**
- SQLite contredit la règle « No database. config.json + JSONL + sidecar files = full
  persistence ». Il faudrait une décision explicite de l'utilisateur.
- Juge que des menus de récupération existent pour le chef ; pour lui, ils sont inatteignables.
- Aucun chiffrage du coût. Fourchettes de latence larges, sans budget par chemin.
- « Réveil < 2 s » ne vaut que pour la mise à jour de l'état. Quand un résultat
  appelle une décision (échec, question, relance), il faut un appel du chef.
- Effort de 14 à 22 jours et migration lourde (import, double propriétaire,
  idempotence de bout en bout) : risque élevé pour un gain d'erreurs que la version
  en fichiers obtient en grande partie.

**Ce que chacun apporte et que l'autre n'a pas**
- Fable : la preuve de l'impasse du chef (`CHEF_ROUTED`), les pannes d'infrastructure
  garées, le gabarit de message d'erreur, la latence par nature de message, une phase 0
  concrète, un effort réaliste.
- Astra : la reprise seulement explicite, les dépendances chef ↔ musicien dans le même
  graphe, les postconditions des actions, l'accusé de réception et l'idempotence, la
  règle « une réparation ne retire jamais une contrainte », le mode ombre avant
  bascule, et le constat que la dépendance d'une pause (`pipeline_paused` en
  `success`) risque de libérer à tort.

---

## 3. Synthèse finale — « Routage v3 »

### 3.1 Architecture cible

```
message ─► [1] Entrée (code, 0 model)
             ├─ chemin direct : TODO:, préfixe, commande typée, bouton, réponse de menu ciblée,
             │                   @projet explicite, /chef-discussion  ──► registre ─► effet (< 2 s)
             └─ sinon ─► [2] Tour du chef (1 appel, sa session, contexte compact par le code)
                              └─► texte pour l'utilisateur + bloc ```plan (facultatif)
                         [3] Réparation du plan (code)  ── forme ✔ / référence ✔ / jamais une contrainte retirée
                         [4] Classement par tâche (classifier, appels EN PARALLÈLE ; sauté si préfixe)
                         [5] Lancement (code) : dispatch.mjs --task-id, file, attentes, actions typées
                         [6] Bloc de faits écrit par le code sous le texte du chef
réveil ─► [7] Mise à jour du registre par le code (< 2 s) ; appel du chef seulement si décision requise
panne d'infra (toute étape de model) ─► demande « garée », relance automatique
```

- **Un seul tour du chef** remplace Lire, Comprendre, Découper et Rapporter **[F, A]**.
  Il garde sa session (`--resume`, calibrage 0.99.0) **[F]**.
- **Contexte compact par le code** : questions ouvertes, demandes non terminées, pauses,
  file, TODO « EN ATTENTE », extraits complets sans coupe silencieuse (0.93.0) **[F, A]**.
- **Classement par tâche gardé**, en parallèle (règle utilisateur 0.69.0) **[F]**.
- **Affecter et Relancer supprimés** comme étapes ; la libération en fin de tour suffit **[F, A]**.
- La **porte des pipelines** de `dispatch.mjs` reste l'unique point d'imposition **[F]**.
- **Registre en fichiers**, pas de base de données **[O]** (Fable : un fichier ; Astra : SQLite).

### 3.2 Le plan : petit, typé, sans exclusions à mémoriser

```json
{"taches": [{"ref": "a", "projet": "…", "titre": "…", "demande": "…", "apres": ["b"],
             "pipeline": "dev", "mode": "leger", "session_neuve": true, "meme_tache": true,
             "hors_pipeline": "mots exacts de l'utilisateur"}],
 "actions": [{"ref": "b", "action": "cancel_run", "cible": "p-…", "apres": ["a"]}],
 "reprises": [{"ref": "c", "run": "p-…", "message": "…"}],
 "question": "…"}
```

- Les dépendances sont des **références locales** (`ref`), et le chef peut être
  prédécesseur ou successeur **[A]**. Une action différée devient une entrée de
  `routage-pending.mjs` de type `action`, exécutée par le code à la libération **[F]**.
  Les 17 refus « renvoi/apres » disparaissent sans perdre « puis ».
- **Reprise seulement explicite** (`reprises[]`, bouton ou commande). Un identifiant
  cité dans une demande reste une référence documentaire. `detectReprise` ne lit plus
  le texte **[A]**. Cela inverse une assertion existante de `_test_routage_pending.mjs` :
  décision D4.
- **Actions typées avec postcondition** **[A]** : `cancel_run` (l'exécution visée est
  terminale), `stop_turn` (ex-`kill-stalled` : le PID est mort), `resolve_question`
  (plus de question ouverte), `restart` (le serveur répond avec un autre PID et
  `/api/version`), `copy_build` (l'APK existe), `todo_add` (l'item est relu). Le code
  retour seul ne vaut jamais « fait ».
- Le chef garde ses outils (contrat d'avant 0.54.0, et sa situation actuelle en prod).
  Ses dispatches par Bash passent par la porte et sont **inscrits au registre** grâce à
  `ORCH_REQUEST_ID`, posé dans l'environnement du tour comme `ORCH_TURN_ID` **[O]**.

### 3.3 Réparation par le code : la forme toujours, le sens jamais

| Problème | Réparation (dite par « [Routeur] ») | Sinon |
|---|---|---|
| bloc plan absent ou JSON illisible | **un** nouvel essai dans la même session, ~10 s **[F]** | texte livré, « aucune tâche lancée », demande `à_traiter` |
| titre absent ou ambigu | titre de repli, suffixe « (2) » **[F, A]** | — |
| projet inconnu | correspondance unique insensible à la casse et aux accents **[F]** | une question groupée avec les 3 plus proches |
| plus de 6 tâches | lancement par vagues **[F, A]** | — |
| dépendance hors bornes ou cycle | **jamais retirée** : un nouvel essai ciblé sur ce champ **[A]** | la tâche passe `à_traiter` (« corriger la dépendance ») ; les tâches indépendantes partent |
| `hors_pipeline` sans citation retrouvée (`userSaid`) | lancée **en** pipeline, avec une note **[F]** | — |
| classifier en échec deux fois | les autres tâches partent ; celle-ci passe `à_classer` **[F]** | chat « /dev /léger », commande, bouton |
| aucun pipeline adapté (lacune) | la tâche est gardée, signalement produit **[A]** ; Discussion si l'utilisateur le veut | « choisir un pipeline » ou « tour ordinaire autorisé » |
| reprise d'une exécution non en pause | si orpheline : `reclaimOrphanedRun` (prod) ; si terminée : le dire **[A]** | — |
| doublon (`identities`, 0.67.1) | écarté et dit | — |

Le code ne pose plus de question de taxonomie (« est-ce une action du chef ? ») **[F]** :
c'est le chef qui fait ou qui lance.

### 3.4 Machine d'états et sorties

**Demande** (une par message de l'utilisateur, réveil ou question de musicien),
fichier `logs/requests/<id>.json`, id `r-<horodatage>-<hex>`, propriétaire unique
`scripts/requests.mjs` (verrou par demande, écriture atomique via `atomic-file.mjs`)
**[O]**, sur le modèle de `routage-pending.mjs` **[F]**.

| État | Sens | Chat | Commande (`node scripts/requests.mjs …`) | Bouton (onglet 🧭 Requêtes) |
|---|---|---|---|---|
| `reçue` | en attente du tour du chef | « abandonne r-… » | `drop <id>` | Abandonner |
| `en_cours` | tour du chef vivant (`.pid`) | — | `show <id>` ; processus mort → `garée` (balayage) | Voir |
| `attend_utilisateur` | le chef a posé une question | réponse : rattachée **seulement** si une seule demande attend, ou si `r-…` est cité ; sinon le chef demande laquelle (règle du fleet) **[O]** | `answer <id> "<texte>"`, `close <id>` | Répondre (saisie liée), Marquer répondue |
| `garée` | panne d'infrastructure | « relance », « abandonne » (avec l'id si plusieurs) | `retry <id>`, `drop <id>` | Relancer maintenant, Tester le model, Abandonner |
| `à_traiter` | au moins une tâche en `à_traiter` ou `à_classer` | « /dev /léger » pour la tâche citée, « abandonne r-…#n » | `fix <id>#<n> --pipeline … / --projet … / --after …`, `cancel <id>#<n>` | Corriger et lancer, Annuler la tâche |
| `suivie` | tout est lancé ; tâches en cours ou en file | — | `show <id>` | Voir |
| `terminée` | chaque tâche réussie ou annulée explicitement **[A]** | — | `replay <id>` (nouvelle demande, même texte) | Rejouer |
| `abandonnée` | sur décision | — | — | — |

**Tâche** (dans sa demande) **[A, simplifié O]** : `en_attente_de` → `lancée` (accusé) →
`en_file` | `en_cours` → `réussie` | `à_traiter` (code d'erreur, responsable,
actions) | `annulée`. Une tâche dont le prédécesseur échoue ou est en pause ne part
pas : elle passe `à_traiter`, avec « réparer A », « lancer B sans A » (autorisation)
et « annuler B » **[A]**. Une pause d'un musicien (`pipeline_paused`, écrite en
`success`) **ne libère jamais** un successeur **[A]**.

**Accusé et idempotence, en fichiers** **[O, d'après A]** : `launchTask` passe
`--task-id r-…#n`. `dispatch.mjs` l'écrit dans le `user_prompt` (comme `orch_turn`).
Le registre passe la tâche à `lancée` quand il relit ce `user_prompt`, ou l'entrée de
file qui porte le même id. Un second lancement du même id est refusé par
`dispatch.mjs` (déjà dans le log ou dans la file). Le balayage de 60 s réconcilie
après un redémarrage : sans accusé au bout de 2 min, la tâche passe `à_traiter`
(« relancer l'opération existante »), jamais un nouveau lancement aveugle.

**Règle vérifiée par test** : tout état non terminal a une sortie par le chat, une par
commande et une par bouton **[F]**, ou un événement attendu avec échéance **[A]**.
Le balayage signale toute demande non terminale sans activité depuis 2 h.

### 3.5 Ce que fait le code, ce que fait un model

| Code (déterministe, < 1 s) | Model |
|---|---|
| chemins directs, préfixes, commandes, boutons, `TODO:` | le chef : comprendre, découper, répondre en prose, poser une question de sens |
| contexte compact, registre, accusés, réconciliation | classifier : le pipeline de chaque tâche (une tâche par appel, en parallèle) |
| réparation de forme et de référence, vagues, titres | — |
| lancement, file, dépendances, actions typées et postconditions | — |
| bloc de faits « Lancé / En file / En attente de / Garé » sous la réponse **[F]** | — |
| identifiants vérifiés (`report-check`), langue, `[[ ]]` | (portier de langue : reformulation seulement si écart) |
| mise à jour au réveil, libération des dépendances | le chef, au réveil, seulement si un résultat appelle une décision |

### 3.6 Chemins directs (0 appel de model)

| Entrée | Effet | Source |
|---|---|---|
| `TODO: …` | item TODO du chef (0.84.0, inchangé) | existant |
| bouton ou commande sur une carte (`relance`, `abandonne`, `corrige`, `répondue`) | commande typée sur l'id de la carte | **[A, F]** |
| « continuer / abandonner / accepter » quand **une seule** pause est ouverte, ou avec `p-…` cité | `answerPausedRun` sur cette exécution, chef compris : corrige l'impasse `CHEF_ROUTED` | **[F]** |
| `/abandonne p-…` | `cancel_run` avec postcondition, jamais `kill-stalled` | **[A]** |
| `@projet <texte>` avec préfixe de pipeline | dispatch direct, inscrit au registre | **[O]** |
| réveil | mise à jour du registre et des cartes, libérations | **[A]** |

### 3.7 Pannes d'infrastructure

Elles sont reconnues partout où un model est appelé (`isLaunchFailure` étendu)
**[F, A]**. Elles ne comptent jamais comme critère, ne déclenchent jamais de
`[DÉFAUT]` adressé au chef et n'ouvrent jamais le menu du pipeline de Développement.

| Cause | Reconnue par | Conduite |
|---|---|---|
| OAuth expirée | « OAuth session expired », « Failed to authenticate » | **aucun** nouvel essai ; `garée` ; message « reconnectez Claude (`claude /login`), puis « relance » » ; `model-test` vert ⇒ relance automatique |
| limite de session | « limite de session … jusqu'à <date> » | `garée` jusqu'à la date, relance automatique |
| refus du fournisseur | « can't help with this. Start a new session » | **un** nouvel essai en session neuve (ce que dit le message) ; sinon `garée` avec l'extrait du refus |
| sortie sans résultat, 5xx, délai | `isLaunchFailure` actuel | essais à 30 s puis 2 min, ensuite `garée` avec relance à 5, 15 puis 30 min |

Gabarit du message, écrit par le code **[F]** :

```
⚠ Ce qui s'est passé : <cause réelle, une phrase>
✓ Ce que j'ai fait : <votre message est gardé [[r-…]] ; prochain essai automatique à HH:MM>
→ Vous pouvez répondre : « relance » · « abandonne »   (ou boutons de la carte)
ℹ Détail : node scripts/requests.mjs show r-…
```

### 3.8 Durées et coûts cibles

Hypothèses mesurées : un appel sonnet-5.5 sur le contexte du chef ≈ 23 s (Lire), plus
5 à 12 s pour écrire un plan ; un tour ordinaire du chef en opus ≈ 55 s (n = 5) ;
classifier ≈ 7 s par tâche, en parallèle ; code < 1 s.

| Chemin | Aujourd'hui (médiane / p95) | Cible v3 sonnet | Cible v3 opus | Coût, équivalent API |
|---|---|---|---|---|
| message avec tâches | 104 / 172 s | **≤ 45 s / ≤ 80 s** | ≤ 60 / ≤ 100 s | 1,45 $ → ≤ 0,5 $ |
| réponse seule (23 %) | ~64 s | **≤ 30 s** | ≤ 45 s | → ≤ 0,3 $ |
| chemin direct (menu, bouton, commande) | ~100 s, souvent une exécution confuse | **< 2 s** | < 2 s | 0 |
| réveil, mise à jour de l'état | 87 / 124 s | **< 2 s** | < 2 s | 0 |
| réveil avec décision du chef | 87 / 124 s | ≤ 30 s | ≤ 45 s | ≤ 0,35 $ |
| refus de forme (12 % des demandes) | +30 s, sens parfois perdu | ~0 (réparé), +10 s au pire | idem | — |
| total sur 10 jours (même trafic) | 887 $ | **~250–300 $** | ~450 $ | quota −50 à −70 % |

### 3.9 Plan par phases

Toute livraison suit la règle prod/dev : développement et non-régression dans
`orchestrateur-dev` (bac à sable sur le port 7778 pour l'instance vivante), tag
`vX.Y.Z`, puis **bond décidé par l'utilisateur** vers `I:\orchestrateur`
(`prod-jump.mjs`, non-régression par périmètre sur orchestrateur-dev, jamais dans la prod :
règle de l'utilisateur du 2026-10-20, `regression.mjs` refuse en prod depuis 0.125.0). La bascule est un réglage relu à
chaud : `enforcement.chefMode: "off" | "routage" | "v3"` (`pipeline-enforce.mjs
chef-mode …`). `"off"` est l'état actuel de la prod.

| Phase | Contenu | Effort | Retour arrière |
|---|---|---|---|
| **0 — gains rapides sur l'existant** (utiles avec ou sans Routage) | (a) pannes d'infra → `garée` / attente, plus de `criteria` ni de `[DÉFAUT]` au chef **[F]** ; (b) réponses aux pauses du chef traitées avant `CHEF_ROUTED`, et `cancel_run` typé pour clore les 4 pauses mortes **[F, A]** ; (c) `detectReprise` limité au champ explicite **[A]**, après D4 ; (d) une pause (`pipeline_paused`) ne libère pas une attente : test d'abord, correction si besoin **[A]** ; (e) si le Routage est rallumé : `renvoi_chef + apres` converti en action en attente **[F]**, Lire fusionné dans Comprendre (−23 s) **[O]**, classifier en parallèle **[F]** | 2 j | `git revert` ; tag `pre-routage-v3-phase0-vX.Y.Z` |
| **1 — registre et secours** | `requests.mjs` (états, CLI `show/answer/retry/fix/cancel/drop/replay`), `--task-id` et accusé dans `dispatch.mjs`, réconciliation dans le balayage de 60 s, `ORCH_REQUEST_ID` ; branché sur le chef actuel (`off` ou `routage`) **[A : « le secours avant le routage »]** | 3 j | le registre n'est que lu ; le retirer ne change rien d'autre |
| **2 — tour unique v3** | `chef-turn.mjs` (contexte compact, appel, extraction du plan, un nouvel essai), `plan-repair.mjs` (table 3.3), actions typées avec postconditions, case `routage.chef` ; **mode ombre** : plan produit sur les vrais messages et rejoué sur le corpus, sans effet **[A]** | 3 j | `chefMode` ≠ `v3` |
| **3 — réveil par le code, cartes et boutons** | réveil = mise à jour, appel seulement sur décision ; onglet Requêtes lu depuis `logs/requests/` ; `/api/requests/:id/commands` (`sameOriginOnly`, `commandId` idempotent **[A]**) ; navigateur bureau et mobile | 2 j | ancienne vue gardée derrière `ui.requestsV3` |
| **4 — bascule** | tag, bond, `chefMode v3` en prod, 7 jours de mesure | 0,5 j + observation | `chefMode off` ou `routage`, à chaud |
| **5 — nettoyage** | retrait des étapes Lire, Comprendre, Découper, Affecter, Relancer, Callback, Rapporter (cases en `ref`, `LEGACY_MAP`) ; regroupement des suites, **sans affaiblir un test d'exigence** | 1 j | tag avant la phase |

Total ≈ **11,5 jours**, hors observation.

État : phase 0 livrée (0.115.1 à 0.118.0) ; **phase 1 livrée en 0.128.0**
(`scripts/requests.mjs`, `_test_requests_registry.mjs`). Les boutons de chaque
état et les chemins directs du chat (« abandonne r-… », « relance ») arrivent
avec les phases 2 et 3 ; d'ici là, la sortie par le chat passe par le chef, qui
lance la commande (décision 8).

**Phase 2 livrée en 0.130.0, en mode ombre** (décision « vas y » du
2026-10-22) : `scripts/chef-turn.mjs` (contexte compact, un appel, extraction
du plan, un seul nouvel essai, classement en parallèle), `scripts/plan-repair.mjs`
(table 3.3), actions typées du chef ajoutées au registre unique
`scripts/typed-operations.mjs`, case `routage.chef` (claude-sonnet-5-5), corpus
`tests/routage-corpus/` (59 cas réels). L'ombre s'allume par
`node scripts/pipeline-enforce.mjs chef-shadow on` et n'écrit que
`logs/chef-shadow/` ; `chefMode` reste `off`. La limite de la phase 1 (tâche
libérée plus tard non rattachée à sa demande) est levée. Écart assumé et dit :
en ombre, le tour n'utilise pas la session du chef (`--resume`), qui appartient
au vrai chef ; la conversation récente est dans le contexte compact. Le
`--resume` de la session du chef viendra avec la bascule (phase 4).

### 3.10 Tests

- **Rejouer les vrais cas refusés de la prod** **[F, A]** : corpus anonymisé
  `tests/routage-corpus/` (le dépôt est public ; noms de projets remplacés). Il
  contient les 47 `taches.json` refusés (9 motifs), les 5 renvois en sortie 65, les
  4 pannes d'infrastructure, les 5 reprises par citation, et l'ordre inversé et la
  mauvaise action de [[p-20261019T181739-7e7851]]. Attendus : aucun refus global,
  aucune contrainte retirée, aucune reprise non demandée, `cancel_run` et non
  `kill-stalled`, « puis » respecté. Suite `_test_routage_corpus.mjs`.
- `_test_requests_registry.mjs` : couverture de la machine d'états (chaque état non
  terminal a ses trois sorties), verrou, accusé, second lancement refusé,
  réconciliation après un processus tué entre retrait et lancement **[A]**.
- `_test_plan_repair.mjs` (table 3.3), `_test_infra_park.mjs` (4 causes, relance
  automatique, jamais de `[DÉFAUT]`), `_test_chef_pause_reply.mjs` (phase 0 b),
  `_test_paused_dependency.mjs` (phase 0 d), `_test_chef_turn_calls.mjs` (nombre
  d'appels : réponse 1, tâches 1 + 1 vague, réveil 0 ou 1, chemin direct 0).
- **Rattachement ambigu** : deux demandes en attente et une réponse sans id ⇒ question
  du chef, aucun envoi.
- HTTP `requests-commands`, navigateur `requests-cards` et `requests-cards-mobile`.
- **Banc de latence** `scripts/routage-bench.mjs` : médiane et p95 par chemin, lus dans
  le registre et `chef.jsonl`. Il sert de critère de bascule.
- Exigences existantes conservées : `_test_routage_split`, `_test_routage_titles`,
  `_test_routage_ambiguous`, `_test_routage_distinct`, `_test_report_check`,
  `_test_routage_dedupe`, `_test_hors_pipeline_task`, `_test_routage_new_session`,
  `_test_todo_capture`, `_test_todo_discuss_chef`, `_test_report_truncation`,
  `_test_chef_actions`, `_test_chef_handoff*`. Seule l'assertion de reprise implicite
  de `_test_routage_pending` change, et seulement avec l'accord D4.
- Tout nouveau fichier et toute nouvelle suite sont rattachés dans
  `regression-perimeters.json` (périmètre `routage`), et la demande est tracée dans
  `docs/USER_REQUIREMENTS.md`.

### 3.11 Critères de réussite (7 jours après la bascule, en prod)

| Mesure | Aujourd'hui | Seuil |
|---|---|---|
| latence médiane d'un message avec tâches | 104 s | ≤ 45 s (sonnet) / ≤ 60 s (opus) |
| p95 d'un message | 172 s | ≤ 90 s |
| chemins directs | ~100 s | ≤ 2 s |
| demandes avec un nouvel essai ou un refus de forme | 12 % | ≤ 2 % |
| reprises non demandées | ≥ 5 en 10 jours | 0 |
| demandes non terminales sans sortie | inconnu (4 pauses mortes) | 0 (test et balayage) |
| `[DÉFAUT]` adressés au chef sur lui-même | 45 | 0 |
| quota équivalent API par message (médiane) | 1,45 $ | ≤ 0,5 $ |
| messages redemandés par l'utilisateur après une perte de sens | non mesuré | compté par le banc, en baisse |

---

## 4. Décisions à soumettre à l'utilisateur

1. **Approche** : v3 (un tour du chef, registre en fichiers, ~11,5 j), recommandée ;
   ou l'ordonnanceur complet d'Astra (14 à 22 j), qui exige de lever la règle « No database ».
2. **Model de la case `routage.chef`** : sonnet-5.5 (≤ 45 s, recommandé) ou opus-5.5
   (≤ 60 s, meilleure compréhension).
3. **Classement** : un appel séparé par tâche, en parallèle (lecture littérale de la
   règle 0.69.0, recommandé d'abord) ; ou le classement dans le plan du chef
   (−7 à −11 s, à décider après mesure).
4. **Reprise seulement explicite** : accepter que l'assertion de reprise implicite de
   `_test_routage_pending.mjs` soit inversée (un id cité ne reprend plus rien). C'est
   un test d'exigence : accord explicite requis.
5. **Réveil** : mise à jour par le code, et appel du chef seulement si une décision est
   requise (recommandé) ; ou toujours un appel du chef.
6. **Prod en attendant** : garder le Routage du chef coupé (`off`, état actuel) jusqu'à
   la v3 (recommandé, la phase 0 vise alors a à d) ; ou le rallumer avec la phase 0 complète.
7. **Les 4 pauses mortes du chef** ([[p-20261009T193025-d2f51b]],
   [[p-20261012T085659-061170]], [[p-20261012T102220-3a6fde]],
   [[p-20261014T044705-556920]]) : les clore par `cancel_run` dès la phase 0 ?
8. **Effets du chef par Bash** : les laisser possibles et inscrits au registre
   (recommandé), ou n'autoriser les effets que par les actions typées du plan.
9. **Nettoyage de la phase 5** : accord pour regrouper ou retirer les suites qui ne
   testent que les étapes supprimées, les tests d'exigence restant intacts.

---

## 5. Décisions de l'utilisateur (2026-10-19)

Réponses de l'utilisateur aux questions du §4, dans le même ordre. Elles
s'imposent aux phases suivantes (§3.9) ; une phase qui s'en écarte doit d'abord
obtenir une nouvelle décision de l'utilisateur.

1. **Registre des demandes en fichiers**, pas de base de données (v3 ; la règle
   « No database » reste en vigueur).
2. **Tour unique du chef sur `claude-sonnet-5-5`** (case `routage.chef`).
3. **Classement tâche par tâche, en parallèle** : un appel séparé par tâche (lecture
   littérale de la règle 0.69.0).
4. **Reprise seulement sur demande explicite.** Accord donné pour inverser le test
   d'exigence concerné (assertion de reprise implicite de `_test_routage_pending.mjs` :
   un identifiant cité ne reprend plus rien). Livré en phase 0 c (0.116.0).
5. **Réveils mis à jour par le code** ; le chef n'est appelé que s'il y a une
   décision à prendre : échec, question, suite dépendante, choix, rapport promis.
6. **Routage du chef laissé coupé en prod** pour l'instant (`off`).
7. **Les 4 pauses mortes du chef sont closes**, par la commande de clôture de la
   phase 0 b (`scripts/close-run.mjs`, 0.117.0), avec le motif « Routage du chef
   coupé le 2026-10-19 ; pause irrécupérable (bug corrigé en phase 0) ; clos sur
   décision utilisateur » : [[p-20261014T044705-556920]],
   [[p-20261012T102220-3a6fde]], [[p-20261012T085659-061170]],
   [[p-20261009T193025-d2f51b]]. [[p-20261019T144511-44d707]]
   (orchestrateur-dev) n'en fait pas partie (autre décision). **Fait** : les 4 pauses
   ont été closes le 2026-10-20 (statut `abandoned`, motif ci-dessus) ; la prod tourne
   en v0.119.0.
8. **Actions du chef par commande autorisées**, et inscrites au registre.
9. **Regroupement des suites de tests en phase 5, accordé SOUS CONDITIONS**
   (verbatim : « ok comme ca ») :
   a) un tableau de correspondance relie chaque vérification des anciennes suites à
      sa remplaçante ; une vérification non couverte bloque la suppression ;
   b) un contrôle fait par un script, pas par un model, refuse toute suppression tant
      qu'une vérification n'est pas couverte ;
   c) les anciennes suites restent tant que les nouvelles ne sont pas toutes vertes ;
   d) les tests d'exigence de `docs/USER_REQUIREMENTS.md` restent intouchables et
      doivent passer avant comme après ;
   e) le tableau est présenté à l'utilisateur pour validation avant toute suppression.

   Rappel : les étapes des pipelines des musiciens (test rouge, code vert sans toucher
   aux tests, revue, livraison) ne changent pas.
