# Routage du chef — diagnostic et proposition (auteur : Fable 5.1)

> Étude indépendante demandée par l'utilisateur le 2026-10-19 : « On va commencer par
> travailler sur le routage : il y a trop d'erreurs, et c'est trop difficile de les
> corriger quand ça arrive. Dès qu'il y a un problème on est dans une impasse. » Et :
> « il doit être beaucoup plus rapide : réduire ou simplifier les tâches ».
> Document de décision destiné à l'utilisateur et à la synthèse d'Opus 5.5, écrit en
> français pour cette raison. Aucun code n'est modifié. Le dépôt est public : les
> projets privés cités sont ceux déjà nommés dans `logs/` de la prod et dans les
> documents existants ; aucun nom nouveau n'est introduit.

Sources lues (lecture seule, prod `I:\orchestrateur\logs`) : les 613 `run.json` du
pipeline `routage` (2026-10-09 → 2026-10-19), leurs artefacts dans
`I:\Dev\Chef\.orchestrateur\runs\`, `pipeline-classify.ndjson` (255 décisions),
`chef.jsonl` (416 Mo : événements `pipeline_*`, messages `[DÉFAUT …]`,
`[RENVOI_CHEF …]`), `chef-actions.log` ; le code : `pipeline-catalog.mjs`
(`S.routage`), `pipeline-engine.mjs` (`CODE_STEPS`, `validateUnitTasks`,
`routingContext`, `conversationExcerpt`, `catalogResult`, `finish`,
`answerPausedRun`), `pipeline-classify.mjs`, `routage-pending.mjs`, `dispatch.mjs`
(branche `CHEF_ROUTED`), `docs/ROUTAGE-PROBLEMES.md`.

---

## 1. Diagnostic factuel

### 1.1 Ce que fait le Routage aujourd'hui

Un message à l'utilisateur ou un réveil déclenche une exécution de pipeline du chef
(`runPipeline({pipeline:'routage'})`, `dispatch.mjs` ligne `CHEF_ROUTED`) :

| Mode | Étapes | Appels de model |
|---|---|---|
| `demande` (413 exécutions) | Lire → Comprendre → Découper → Classer (code, 1 appel par tâche) → Affecter (code) → Dispatcher (code) → Rapporter | 4 + n tâches |
| `callback` (197) | Lire → Relancer (code) → Callback → Rapporter | 3 |
| `discussion` (3) | Lire → Discuter → Rapporter | 3 |

Chaque étape de jugement est un `claude -p` neuf (session par model et par
exécution), qui relit `demande.md`, `contexte.md` (15,7 Ko dans l'exécution du
2026-10-19 18:25) et `conversation.md` (30 Ko) : le même contexte de ~45 Ko est
payé quatre fois par message. Les artefacts JSON sont validés par le code ; un
artefact refusé relance l'étape (au plus 2 essais), puis l'exécution se met en
pause avec le menu « continuer / changer le model / abandonner » du pipeline de
Développement.

### 1.2 Durées mesurées (613 exécutions, `durationMs` des étapes ; la durée murale
`updatedAt − createdAt` est à 2 s près identique)

| Étape (mode demande) | Model (page Models) | n | médiane | p90 | max |
|---|---|---|---|---|---|
| Lire | sonnet-5.5 | 414 | **23 s** | 33 s | 53 s |
| Comprendre | sonnet-5.5 | 271 | 8 s | 12 s | 21 s |
| Découper | opus-5.5 | 458 essais | **32 s** | 55 s | 179 s (un essai de 884 s hors tableau) |
| Classer (code → classifier) | sonnet-5 | 413 | 11 s (≈ 7 s par tâche, en série) | 32 s | 73 s |
| Affecter, Dispatcher | code | 411 | 0 s | 0 s | 2 s |
| Rapporter | opus-5.5 | 411 | **26 s** | 40 s | 348 s |

| Étape (mode callback) | Model | n | médiane | p90 |
|---|---|---|---|---|
| Lire | sonnet-5.5 | 198 | 22 s | 29 s |
| Relancer | code | 196 | 0 s | 0 s |
| Callback | opus-5.5 | 198 | 37 s | 52 s |
| Rapporter | opus-5.5 | 195 | 25 s | 32 s |

| Tour complet | n | médiane | p90 | max | coût médian | coût p90 |
|---|---|---|---|---|---|---|
| demande | 413 | **102 s** | 148 s | 964 s | 1,45 $ | 2,25 $ |
| callback | 197 | **86 s** | 107 s | 269 s | 1,23 $ | 1,49 $ |
| discussion | 3 | 106 s | 128 s | 128 s | 1,46 $ | 1,70 $ |

Coût total des 613 exécutions : **887 $ en dix jours** (637 $ demande, 245 $
callback), soit le routage seul, hors travail des musiciens.

Par nature du message (étape Comprendre, 269 exécutions depuis la 0.69.0) :

| Nature | n | part | médiane | tâches lancées (médiane) |
|---|---|---|---|---|
| `suite` (réponse à une question ouverte) | 123 | 46 % | 105 s | 1 |
| `reponse` (le chef répond lui-même, rien à lancer) | 61 | 23 % | **64 s** | 0 |
| `taches` | 54 | 20 % | 101 s | 1 |
| `action` (action du chef) | 22 | 8 % | 95 s | 0 |
| `question` | 9 | 3 % | 63 s | 0 |

Autrement dit : une **réponse de conversation coûte 64 s et trois appels de model**
(Lire, Comprendre, Rapporter) alors qu'un seul appel du chef la produirait ; un
réveil coûte 86 s et trois appels pour résumer des résultats que le code possède
déjà en entier (`turn-report.mjs`, 0.100.3). Le médian d'un message court (< 120
caractères, 203 cas) est 97 s : la durée ne dépend presque pas du message, mais du
nombre d'étapes.

Les cas lents : l'exécution `p-20261014T145525-24a1d7` (« lance le passage en prod et
le redemarrage ») a duré 964 s dont 884 s pour un essai de Découper **refusé** ;
`p-20261015T141111-4cac75` 437 s ; les 15 plus lentes sont toutes à plus de 185 s,
en général une étape de rédaction d'opus au-delà de 150 s ou un essai refusé.

### 1.3 Erreurs réellement survenues (identifiants d'exécution)

**A. Refus du découpage par le validateur (47 essais sur 458, 10 %)**

| Motif de refus (`validateUnitTasks`) | n | Exemples | Statut |
|---|---|---|---|
| `taches.json : aucune tâche` | 16 | p-20261009T211219-9972bc, p-20261010T090927-06522f, p-20261010T193119-6e8112, p-20261010T193435-08c2d3, p-20261012T085907-0fbc82 … | corrigé 0.70.0 (plus aucun après le 2026-10-12) |
| `« renvoi_chef » ne peut pas attendre une autre tâche (« apres »)` | 13 | p-20261014T145525-24a1d7, p-20261015T110935-f9a1a7, p-20261016T043850-a0106b (« go 0.107.0 »), p-20261019T151215-af4324, p-20261019T182500-d0171a | **ouvert, 1 cas sur 2 jours** |
| `« apres » ne peut pas désigner une tâche renvoyée au chef` | 5 | p-20261015T210716-da95c0, p-20261016T164356-3b9838, p-20261017T084436-c012a2, p-20261018T090045-234c79, p-20261019T165050-4d7b7f | **ouvert** |
| `le chef ne se délègue pas de tâche` | 7 | p-20261009T194110-385a6e, p-20261012T121417-b696ce (« reprends »), p-20261014T070908-f73a62, p-20261016T080754-38dedf | atténué 0.88.0 (`renvoi_chef`) |
| `« apres » doit désigner une tâche précédente (1 à 0)` | 2 | p-20261009T155431-22e10e, p-20261009T191151-80eaf2 | ouvert |
| plus de 6 tâches | 2 | p-20261009T113003-6fb43a (17), p-20261013T202938-f29b0e (7) | ouvert |
| `projet inconnu « divers »` | 1 | p-20261013T124219-ebf448 | ouvert |
| `reprise` d'une exécution qui n'est pas en pause | 1 | p-20261018T101119-ce3136 (« relance p-20261018T091024-0e199e ») | ouvert |
| `sens.json` / `classement.json` pas un JSON valide | 3 | p-20261012T074740-2d21c7, p-20261019T112141-7a656b, p-20261019T144550-cf6b8b | ouvert |

Chaque refus coûte un second essai d'opus (≈ 30 s, ≈ 0,40 $), **émet un
`[DÉFAUT — chef — …]` au chef lui-même** avec la phrase du pipeline de Développement
« aucune livraison tant qu'il n'est pas corrigé ou accepté » (45 événements
`pipeline_defect` dans `chef.jsonl`, dont 25 pour le chef), et surtout **le second
essai perd une partie de l'intention** : dans p-20261014T145525-24a1d7, « lance le
passage en prod et le redémarrage » devient, après refus de `renvoi_chef + apres`,
une seule tâche « mise en prod … (sans redémarrage) » ; le rapport dit « Le
redémarrage n'est pas encore lancé … rien ne garantit que je serai réveillé … écrivez
« redémarre » ». L'utilisateur doit redemander.

**B. Pannes d'infrastructure traitées comme des critères d'étape (7 essais, 4
exécutions définitivement en pause)**

| Exécution | Étape | Cause réelle | Classement par le moteur |
|---|---|---|---|
| p-20261009T193025-d2f51b | Découper | « aucun résultat (code 1) » ×2 | `criteria` → pause |
| p-20261012T085659-061170 | Callback | « API Error: Sonnet 5.5 can't help with this. Start a new session » ×2 | `criteria` → pause, 2 [DÉFAUT] |
| p-20261012T102220-3a6fde | Callback | limite de session Claude jusqu'à 11:50Z | `model_unavailable` → pause |
| p-20261014T044705-556920 | Lire | « OAuth session expired and could not be refreshed » ×2 | `criteria` → pause, 2 [DÉFAUT] |

Les quatre sont **toujours `paused`** au 2026-10-19. Le message reçu : « ⏸ Limite
atteinte — chef : l'étape « lire en profondeur » a été refusée 2 fois », avec le menu
« continuer / changer le model / abandonner ».

**C. Une pause du chef est irrécupérable (impasse structurelle).** La branche
`CHEF_ROUTED` de `dispatch.mjs` appelle toujours `runPipeline` neuf : la réponse de
l'utilisateur à la pause du chef n'est jamais traitée comme une réponse de pause
(`pausedReplyKind` n'est appelé que pour les musiciens). Preuve : à « reprends »
(p-20261012T121417-b696ce), une **nouvelle** exécution démarre, son Découper est
refusé (« le chef ne se délègue pas de tâche »), puis le chef écrit : « Je ne peux pas
reprendre cette pause moi-même, donc j'ai demandé le compte rendu directement à
orchestrateur … Ma pause p-20261012T102220-3a6fde reste officiellement en pause ».
Aucune commande, aucun bouton ne clôt une exécution du chef : il faudrait éditer
`run.json`.

**D. Le système renvoie la décision à l'utilisateur au lieu de la prendre (26
exécutions terminées par une question, 28 exécutions `taches/suite/action` sans
aucun lancement).** 19 de ces questions sont la phrase générée par le code « Tâche n
(projet) marquée « ne pas dispatcher » : … Est-ce une action du chef (redémarrer le
serveur, arrêter un tour, …) ? Laquelle ? » (p-20261013T153043-b3a351 ×2,
p-20261013T204834-ac9b74 ×3, p-20261014T102638-72fe10 ×2, p-20261019T144257-7734d9
×2 …) ; 2 sont « le découpage la renvoie au chef … mais le classement y voit du
travail de projet » (p-20261014T181424-996bab, p-20261018T084859-4a7d53). Le
Découper sait qu'il ne faut pas déléguer, le Classer n'a pas le droit de décider,
et le code pose à l'utilisateur une question de taxonomie interne.

**E. Renvoi au chef : 5 tours sur 16 en échec** (`exited with 65 : délégation chef →
chef non disponible (P0-B)`, 2026-10-14 18:16 → 2026-10-15 11:13 :
p-20261014T181424-996bab, p-20261014T193744-22be72, p-20261015T072034-dc447d,
p-20261015T085629-5371e8, p-20261015T110935-f9a1a7). Corrigé 0.100.1 ; mais le
renvoi reste un **second tour détaché** (20 s à 6 min) sans la session du chef
(`handoff.session`), lancé après la fin du Routage : l'utilisateur voit « son tour
part dès la fin de celui-ci » et attend.

**F. Étapes sans effet.** Relancer : 196 exécutions, **1 tâche lancée en tout** (la
libération se fait déjà à la fin de chaque tour, `releaseReady`). Affecter : 0 s, un
tableau Markdown que personne ne lit. Lire : 23 s pour une « lecture » que Comprendre
et Découper refont. Ce sont 23 s × 613 ≈ 4 h de latence cumulée en dix jours.

**G. Lacunes et contrôles tardifs.** 8 `pipeline_gap`, dont 5 le 2026-10-10 pour
une action du chef inexprimable (p-20261010T190323-2556e1, p-20261010T190920-c977f2,
p-20261010T191443-2ede19 : trois messages pour un `kill-stalled`). `report_check`
signale des identifiants inconnus dans les rapports (p-20261019T083801-88d8e7,
p-20261019T083939-3f9d6b, p-20261019T145330-25129f, p-20261019T152849-62aeff) : le
model écrit de mémoire des `q-…` qui n'existent plus ; le code le constate mais ne
corrige rien.

### 1.4 Causes racines, et pourquoi chacune mène à une impasse

1. **Le schéma de découpage encode les limites du moteur, pas l'intention.**
   `taches.json` a 13 champs optionnels (`apres`, `impose`, `reprise`,
   `ne_pas_dispatcher`, `renvoi_chef`, `hors_pipeline`, `session_neuve`,
   `meme_tache`, `actions`, `aucun_dispatch`, `question`, `titre`, `rattache`) et une
   dizaine d'exclusions mutuelles ; la consigne de Découper fait **4 808 caractères**
   plus 1 465 d'exemple, et grandit à chaque incident. La règle « renvoi_chef ne
   peut pas attendre » existe parce que le renvoi part en fin de tour : c'est une
   contrainte d'implémentation que le model doit deviner. Quand l'utilisateur dit
   « X puis redémarre », le découpage juste est interdit ; le validateur **refuse
   tout l'artefact** au lieu de réparer un champ, et le second essai contourne en
   perdant du sens. Impasse : l'utilisateur ne peut ni corriger le JSON ni forcer la
   dépendance ; il redemande.
2. **Pas de distinction entre « le model s'est trompé » et « le model n'a pas
   répondu ».** OAuth expirée, limite de session, « can't help », sortie 1 sont
   comptés comme des critères non remplis : deux essais immédiats (inutiles), un
   `[DÉFAUT]`, puis une pause dont le remède proposé (« changer le model ») est faux.
3. **Le chef est traité comme un musicien de pipeline, sans en avoir les sorties.**
   Les pauses, menus et messages (« aucune livraison … ») viennent du pipeline de
   Développement. Mais `dispatch.mjs` n'a aucun chemin pour répondre à une pause du
   chef : **toute réponse devient une nouvelle exécution**. Les quatre pauses du
   chef sont mortes, et chaque tentative de les reprendre produit une exécution
   confuse.
4. **Fermeture par défaut sur le doute → question de taxonomie à l'utilisateur.**
   `ne_pas_dispatcher`, `renvoi_chef` non confirmé, classement « hésite » : le code
   n'a pas le droit de trancher et pose une question dont la réponse est, pour
   l'utilisateur, toujours « fais-le toi-même ». 19 fois.
5. **Tout passe par 4 à 5 appels de model, même pour une phrase.** 23 % des messages
   sont une simple réponse ; 32 % des exécutions sont des réveils ; aucun chemin
   court n'existe. Résultat : 100 s et 1,45 $ par message, 887 $ en dix jours.
6. **L'état est éparpillé et sans porte de sortie.** `logs/runs/<p>/run.json`,
   artefacts dans `I:\Dev\Chef\.orchestrateur\runs\`, `routage-pending.json`,
   `handoff.json`, `handoff.session`, `chef-actions.log`, `.a-classer.json`,
   `pipeline-classify.ndjson`, files `logs/queue/*.json`. Pour « corriger quand ça
   arrive », il faut savoir lequel de ces fichiers tient la vérité, et le CLI n'en
   couvre qu'une partie (`routage-pending.mjs`, `queue.mjs`). Rien ne permet de
   clore, relancer ou rejouer une **demande** de l'utilisateur comme unité.
7. **Perte de contexte par conception.** Chaque étape est une session neuve qui
   relit 45 Ko ; le tour de renvoi au chef part sans la session du chef ; le
   musicien « ne voit pas la conversation », donc Découper recopie. Le model écrit
   des identifiants de mémoire (`report_check`).
8. **Bruit.** Le chef reçoit ses propres `[DÉFAUT]` (25), des `pipeline_limit` à
   propos de lui-même, et 2 846 lignes de tests (19 suites) protègent des cas
   limites d'un mécanisme que l'utilisateur veut maintenant couper
   (p-20261019T182500-d0171a : « Je ne veux aucun des 3 par le pipleine »).

Point positif à garder : ce qui est fait **par le code** marche. `routage-pending.mjs`
(dépendances, libération en fin de tour, dédoublonnage), la capture `TODO:`, les
titres obligatoires et le contrôle d'ambiguïté, `report-check`, la file par
musicien, les actions du chef en liste blanche, le classement par tâche
(250 décisions, 0 échec du model), la porte des pipelines dans `dispatch.mjs` (c'est
elle, pas le Routage, qui impose les pipelines aux musiciens).

---

## 2. Solution proposée : « Routage v2 — un tour, un plan, une boîte de réception »

Principe : **le chef redevient un seul tour de model avec ses outils et sa session ;
le code fait tout ce qui est déterministe (contexte, validation réparatrice,
lancement, suivi, messages d'état) ; chaque demande de l'utilisateur est un
ticket dont tous les états ont une sortie par le chat, par une commande et par
l'interface.** C'est l'option « réduire fortement le Routage » : de 7 étapes et 4–5
appels à **1 appel du chef + 1 vague parallèle de classement**.

### 2.1 Architecture : garder, simplifier, supprimer

| Aujourd'hui | v2 | Pourquoi |
|---|---|---|
| Lire, Comprendre, Découper, Rapporter (4 appels, 3 models) | **Un appel du chef** (case `routage.chef`, nouvelle, défaut sonnet-5.5 ; opus au choix dans la page Models). Il reçoit un contexte compact construit par le code et répond par **son texte pour l'utilisateur + un bloc ```plan JSON facultatif** (tâches, dépendances, actions du chef). Session reprise d'un tour à l'autre (`--resume`, calibrage 0.99.0). | Comprendre, découper et rédiger sont un seul acte de sens ; trois relectures du même contexte n'ajoutent rien de vérifiable. |
| Classer (code, série) | **Gardé**, case `routage.classifier` inchangée, **appels en parallèle** (`Promise.all`), sautés quand un préfixe impose le pipeline. Règle utilisateur 0.69.0 respectée : une tâche à la fois, par le sens. | 7 s au lieu de 7 s × n. |
| Affecter | supprimé (le code relève les models au lancement, comme aujourd'hui, sans artefact). | 0 valeur. |
| Dispatcher | **Gardé en code**, enrichi : lancement, file, dépendances (`routage-pending.mjs`), actions du chef, bloc de faits « Lancé / En file / En attente de / Fait » **écrit par le code** sous le texte du chef (0.87.0 étendu). | Les faits viennent du code, jamais de mémoire. |
| Relancer | supprimé (la libération en fin de tour suffit : 1 lancement sur 196). | 0 valeur. |
| Callback (réveil) | **Digest par le code** (`turn-report.mjs` : rapports entiers, état des files, attentes) + **un appel du chef** « voici les résultats ; réponds à l'utilisateur ; propose un plan si une suite s'impose ». | 3 appels → 1. |
| Renvoi au chef (tour détaché, 2e session) | **supprimé** : le chef agit lui-même **dans son tour** (il a Bash et les scripts : kill-stalled, resolve-question, queue, routage-pending, pipeline-enforce). Une action à différer (« après la tâche 2 : redémarrer ») devient une **entrée en attente** de `routage-pending.mjs` de type `action` (après = la tâche), exécutée par le code à la libération. | Supprime la règle « renvoi_chef ne peut pas attendre » (18 refus) et le second tour. |
| Pauses du chef (menu de Développement) | **Il n'y a plus de pause du chef.** Trois issues seulement : répondu ; **question** à l'utilisateur (ticket `attend_utilisateur`) ; **garé** (ticket `garé`, panne d'infra, relance automatique). | Une pause sans chemin de reprise est une impasse par construction. |
| Discussion (`/chef-discussion`) | gardé : même appel, le bloc plan est **ignoré par le code** avec une note. | Garantie par le code, pas par l'absence d'étape. |
| Capture `TODO:`, préfixes, dédoublonnage, titres, ambiguïté, `report-check`, langue, `idRefRule`, `EXCERPT` sans coupe silencieuse | gardés tels quels, appliqués au texte du chef et au plan. | Exigences utilisateur tracées. |
| Porte des pipelines (`dispatch.mjs`) | inchangée. C'est elle qui impose les pipelines aux musiciens, que le chef passe par le plan ou par Bash. | Le Routage n'a jamais été le point d'imposition. |

Le bloc plan est petit et stable :

```json
{"taches":[{"projet":"…","titre":"…","demande":"…","apres":1,"pipeline":"dev","mode":"leger",
           "reprise":"p-…","session_neuve":true,"meme_tache":true,"hors_pipeline":"mots exacts"}],
 "actions":[{"action":"restart-orchestrateur","apres":1}],
 "question":"…"}
```

Dix champs, aucune exclusion à mémoriser : ce que le model n'écrit pas, le code le
complète (titre, pipeline par le classifier, dépendances invalides retirées).

### 2.2 Modèle d'état : une boîte de réception du chef

`logs/chef-inbox.json` (propriétaire unique `scripts/chef-inbox.mjs`, verrou +
écriture atomique, comme `routage-pending.mjs`). Un **ticket par message reçu**
(utilisateur, réveil, question d'un musicien) :

```
{ id: "c-20261019T182500-d0171a", source: "utilisateur|réveil|musicien:<p>",
  texte, reçuLe, statut, essais, prochaineAction, plan, lancées[], enFile[], enAttente[],
  question, erreur: {type, détail, depuis}, historique: [{quand, quoi}] }
```

| Statut | Sens | Sorties (chat / CLI `chef-inbox.mjs` / onglet Requêtes) |
|---|---|---|
| `reçu` | en attente d'un tour du chef (pool occupé) | `drop <id>` |
| `en_cours` | tour du chef en cours | (processus suivi par `.pid`, repris si mort : → `garé`) |
| `répondu` | texte + plan exécutés, tâches suivies dans `lancées/enFile/enAttente` | terminal ; `rejouer <id>` relance le même message |
| `attend_utilisateur` | le chef a posé une question | le prochain message de l'utilisateur **est rattaché par le code** à ce ticket (le plus récent en attente, ou `[c-…]` cité) ; `clore <id>` ; bouton « Marquer répondue » |
| `garé` | panne d'infra (OAuth, limite, « can't help », sortie 1, délai) | relance **automatique** par le balayage de 60 s après `model-test` vert, repli d'attente 1 → 5 → 15 min ; chat « relance », « abandonne » ; `relancer|drop <id>` |
| `à_classer` | une tâche dont le classifier a échoué deux fois ; les autres tâches sont parties | chat « /dev /léger » appliqué à la tâche gardée ; `classer <id> <n> <pipeline>` |
| `abandonné` | sur demande | terminal |

Règle : **chaque statut non terminal a au moins une sortie par le chat, une par
commande et une par bouton**, testée (`_test_chef_inbox.mjs` vérifie la couverture
de la machine d'états). Ce fichier remplace, pour le chef : `run.json`/artefacts du
Routage, `.a-classer.json`, `handoff.json`. `routage-pending.json` reste (il marche)
et chaque entrée porte l'`id` de son ticket. Les exécutions de pipeline des
**musiciens** ne changent pas.

### 2.3 Critères vérifiés par le code — validation **réparatrice**, jamais un refus global

| Problème dans le plan | Réparation automatique (dite dans la réponse, préfixe « [Routeur] ») | Escalade |
|---|---|---|
| bloc plan absent ou JSON invalide | un re-prompt **dans la même session** (« ton bloc plan est illisible : <erreur> ; renvoie-le seul »), ≈ 10 s | sinon : texte livré tel quel, « aucune tâche lancée » ajouté par le code |
| projet inconnu | correspondance insensible à la casse/accents, alias `config.json` | question avec les 3 projets les plus proches |
| tâche pour le chef | exécutée par le chef dans le tour (déjà fait) ou entrée `action` en attente | — |
| `apres` invalide (hors bornes, cycle) | dépendance retirée, tâche lancée, note | — |
| plus de 6 tâches | lancées par **vagues** de 6 (les suivantes `apres` la vague) | — |
| titre absent / ambigu (0.87.0, 0.90.0) | titre tiré des premiers mots, suffixe « (2) » | — |
| `reprise` d'une exécution non en pause | si terminée : dit ; sinon nouvelle tâche, note | — |
| `hors_pipeline` sans citation retrouvée (`userSaid`) | tâche lancée **en pipeline** (jamais hors), note | — |
| classifier KO ×2 | autres tâches lancées ; celle-ci → `à_classer` | chat « /dev … » |
| lacune | Discussion + signalement (comme 0.66.0) | — |
| musicien occupé | file (comme aujourd'hui), dit | — |
| lancement impossible (spawn) | 1 nouvel essai | ticket `répondu` avec `lancées[n].échec`, bouton « relancer la tâche » |
| doublon (`identities`) | écarté, dit (comme 0.67.1) | — |

Panne d'infrastructure du **chef** (le model n'a rien produit : `isLaunchFailure`
étendu aux motifs `OAuth`, `session expired`, `can't help with this`, `limite de
session`, délai > 10 min) : 2 essais espacés (30 s, 2 min), puis ticket `garé`,
message : « Le model <X> ne répond pas (<cause>). Votre message est gardé ; je
réessaie automatiquement toutes les N minutes. Répondez « relance » pour forcer,
« abandonne » pour l'oublier. » Aucun `[DÉFAUT]`, aucune limite de critère.

### 2.4 Classement des erreurs, réparation, escalade (résumé)

1. **Forme** (JSON, champs) → réparée par le code, toujours.
2. **Référence** (projet, exécution, identifiant) → réparée si une correspondance
   unique existe, sinon **une** question groupée, dans le même message que le texte du
   chef.
3. **Sens** (que veut l'utilisateur ?) → c'est le chef qui pose la question, en
   prose ; le code ne fabrique plus de question de taxonomie (`ne_pas_dispatcher`
   disparaît : le chef fait ou lance).
4. **Infrastructure** → ticket `garé`, relance automatique, jamais une pause.
5. **Exécution d'une tâche** (musicien) → inchangé (pipelines, pauses des
   musiciens), mais le réveil arrive au chef avec le rapport **entier** et le ticket
   d'origine, et sa réponse « continuer/abandonner <p-…>» est traitée **par le code**
   avant tout appel de model (`pausedReplyKind` appliqué au chef avec l'exécution
   visée explicite, sinon la seule en pause, sinon question).

### 2.5 UX des messages d'erreur

Un seul gabarit, écrit par le code, en français, identifiants entre `[[ ]]` :

```
⚠ Ce qui s'est passé : <une phrase, cause réelle>
✓ Ce que j'ai fait : <réparation, ou « rien n'est lancé »>
→ Vous pouvez répondre : « relance » · « abandonne » · « /dev /léger » (mots exacts, effet d'une ligne chacun)
ℹ Détail : [[c-…]] (onglet Requêtes) · node scripts/chef-inbox.mjs show c-…
```

Interdits : « aucune livraison tant qu'il n'est pas corrigé ou accepté » pour le
chef ; « étape refusée 2 fois » ; un menu dont une entrée ne fait rien ; un
`[DÉFAUT]` adressé au chef à propos de son propre routage. L'onglet « 🧭 Requêtes »
lit `chef-inbox.json` (une source au lieu de six) et affiche le statut, la prochaine
action et les boutons correspondants.

### 2.6 Vitesse : estimation avant / après

Hypothèses mesurées : un appel sonnet-5.5 avec le contexte du chef ≈ 23 s (Lire
aujourd'hui), avec un plan à écrire ≈ 25–35 s ; opus ≈ 35–45 s ; classifier 7 s par
tâche, en parallèle ; code < 1 s.

| Cas | Aujourd'hui (médiane) | v2 (sonnet) | v2 (opus) | Gain |
|---|---|---|---|---|
| message avec tâches (`taches`/`suite`) | 102 s, 1,45 $ | **~40 s**, ~0,45 $ | ~50 s, ~0,9 $ | −60 % / −50 % |
| réponse simple (`reponse`, 23 %) | 64 s, ~1,0 $ | **~25 s**, ~0,3 $ | ~35 s | −60 % |
| réveil (`callback`, 32 %) | 86 s, 1,23 $ | **~30 s**, ~0,35 $ | ~40 s | −65 % |
| réponse de menu (« continuer », « abandonne », « relance ») | ~100 s, et souvent une exécution confuse | **< 2 s, 0 $** | — | −98 % |
| refus de découpage (10 % des cas) | +30 s, +0,40 $, intention perdue | **0** (réparé) | — | — |
| coût sur 10 jours (613 exécutions) | 887 $ | **~250 $** | ~450 $ | −72 % / −50 % |

Les étapes de code restent à moins d'une seconde ; le re-prompt d'un plan illisible
(rare) ajoute ≈ 10 s. Le plafond p90 visé : 60 s.

### 2.7 Migration, retour arrière, tests

Tout se fait sur `orchestrateur-dev`, derrière un réglage **relu à chaud**
`enforcement.chefMode: "routage" | "v2"` (`pipeline-enforce.mjs chef-mode v2`),
`"routage"` par défaut tant que la phase 3 n'est pas livrée. L'ancien chemin reste
en place jusqu'à la phase 5 : **retour arrière = remettre `"routage"`**, sans
redémarrage pour `dispatch.mjs` (le serveur n'est redémarré que pour l'onglet).

| Phase | Contenu | Effort | Retour arrière |
|---|---|---|---|
| **0 — arrêter l'hémorragie dans l'existant** | (a) `isLaunchFailure` reconnaît OAuth / limite / « can't help » / sortie 1 → back-off au lieu de `criteria` ; (b) `CHEF_ROUTED` : « continuer / abandonner / relance <p-…> » traités par `pausedReplyKind` (clôt enfin les 4 pauses mortes) ; (c) `renvoi_chef` + `apres` accepté : converti en entrée `action` en attente. Supprime ≈ 25 refus / 10 jours. | 1 j | `git revert` du commit, tests `_test_pipeline_routage.mjs` inchangés |
| **1 — boîte de réception + un appel** | `chef-inbox.mjs` (machine d'états, CLI), `chef-turn.mjs` (contexte compact par le code, appel unique, extraction du plan, re-prompt), `plan-repair.mjs` (table 2.3), lancement par le Dispatcher existant ; `chefMode` | 3 j | `chefMode: routage` |
| **2 — chemins rapides** | réponses de menu par le code ; réveil = digest du code + un appel ; classifier en parallèle ; `garé` + relance automatique dans le balayage de 60 s | 1,5 j | idem |
| **3 — interface et CLI** | onglet Requêtes sur `chef-inbox.json` (statut, prochaine action, boutons relancer / abandonner / marquer répondue), `/api/chef-inbox`, `fleet-status` | 1,5 j | serveur sur l'ancienne route : `SidePanel.explainFailure` |
| **4 — bascule** | `chefMode: v2` en dev une semaine, mesure (latence médiane, questions par ticket, tickets garés, réparations), puis bond en prod | 0,5 j + observation | `chefMode: routage` |
| **5 — nettoyage** | retrait des étapes Lire/Comprendre/Découper/Affecter/Relancer/Callback/Rapporter du moteur (cases gardées en `ref` via `LEGACY_MAP`), fusion des 19 suites en ~7, mise à jour de `docs/ROUTAGE-PROBLEMES.md` | 1 j | tag avant la phase |

Total ≈ **8,5 jours** d'un musicien, hors non-régression. Critères d'acceptation
pour la bascule (phase 4) : latence médiane d'un message ≤ 45 s ; aucun ticket sans
sortie (test de couverture) ; ≤ 2 % des tickets terminés par une question que
l'ancien Routage n'aurait pas posée ; 0 `[DÉFAUT]` adressé au chef pour lui-même ;
coût médian ≤ 0,6 $.

Tests (nouvelles suites, dans `regression-perimeters.json`, périmètre `routage`) :

- `_test_chef_inbox.mjs` : chaque statut non terminal a ses trois sorties ; verrou ;
  rattachement du message suivant au ticket `attend_utilisateur` ; reprise après
  processus mort.
- `_test_plan_repair.mjs` : chaque ligne de la table 2.3, **rejouée sur les vrais
  `taches.json` refusés** de la prod (anonymisés en fixtures : les 9 motifs de 1.3-A)
  ; aucun ne doit plus produire un refus.
- `_test_chef_turn.mjs` (faux claude, `FAKE_CLAUDE_REPLY` avec et sans bloc plan) :
  nombre d'appels de model par scénario (réponse : 1 ; tâches : 1 + 1 vague ;
  réveil : 1 ; menu : 0) ; discussion : plan ignoré.
- `_test_infra_recovery.mjs` : OAuth / limite / « can't help » / sortie 1 → `garé`,
  relance automatique, « relance », « abandonne » ; jamais `[DÉFAUT]`.
- `_test_chef_pause_reply.mjs` (phase 0) : « abandonner p-… » adressé au chef clôt
  l'exécution citée ; sans identifiant et plusieurs pauses → question.
- Navigateur `requests-inbox` : statut, boutons, mobile.
- Exigences existantes conservées (adaptées au plan) : `_test_routage_split`,
  `_test_routage_titles`, `_test_routage_ambiguous`, `_test_routage_distinct`,
  `_test_report_check`, `_test_routage_pending`, `_test_routage_dedupe`,
  `_test_hors_pipeline_task`, `_test_routage_new_session`, `_test_todo_capture`,
  `_test_todo_discuss_chef`, `_test_report_truncation`, `_test_chef_actions`. Les
  lignes de `docs/USER_REQUIREMENTS.md` gardent leurs tests ; aucun n'est affaibli.

### 2.8 Risques et parades

- **Un seul appel comprend moins bien qu'une chaîne** : le plan est petit, le code
  répare la forme, le classifier garde le choix du pipeline par tâche ; la qualité se
  mesure (questions par ticket, réparations par ticket) dans le panneau « Mise en
  service » avant la bascule.
- **Le chef agit lui-même dans son tour** : c'est le contrat d'avant la 0.54.0
  (`I:\Dev\Chef\CLAUDE.md` : « Tes seules actions directes : dispatch, supervision,
  redémarrage, copy-build »). Le redémarrage reste différé par le code
  (`chef-action-deferred.mjs`). Les dispatches passent par la porte des pipelines
  quoi qu'il arrive.
- **Session du chef trop longue** : calibrage 0.99.0 (session neuve + brief régénéré
  au-delà de 150 000 tokens), déjà en place pour les musiciens.
- **Modèle plus léger** : sonnet-5.5 par défaut sur `routage.chef` ; l'utilisateur
  choisit opus dans la page Models s'il préfère la qualité à la vitesse ; le
  classifier reste sonnet-5 (0 échec sur 250).

---

## 3. Résumé

**Diagnostic (10 lignes).** 613 exécutions du Routage en dix jours : 102 s et 1,45 $
par message, 86 s par réveil, 887 $ au total, pour 4 à 5 appels de model qui relisent
chacun le même contexte de 45 Ko. 23 % des messages sont de simples réponses (64 s
pour une phrase), 32 % des réveils (3 appels pour résumer ce que le code sait déjà).
10 % des découpages sont refusés par un validateur à 13 champs et 10 exclusions ;
chaque refus coûte 30 s, un `[DÉFAUT]` adressé au chef et souvent une partie de
l'intention (le redémarrage perdu de p-20261014T145525). Les pannes d'infra (OAuth,
limite, « can't help ») sont comptées comme des critères : quatre exécutions du chef
sont en pause depuis des jours et **aucune réponse ne peut les reprendre**, car la
branche chef de `dispatch.mjs` lance toujours une exécution neuve. Le code pose 19
fois une question de taxonomie interne à l'utilisateur ; Relancer a servi une fois
sur 196 ; l'état est réparti sur huit fichiers sans commande pour clore une demande.

**Solution (15 lignes).** Remplacer les sept étapes par **un seul tour du chef**, avec
sa session et ses outils, qui répond à l'utilisateur et joint un petit bloc `plan`
(dix champs) ; le code construit le contexte compact, **répare** le plan au lieu de le
refuser (projet approché, dépendance invalide retirée, vagues au-delà de six, titre
généré, action du chef différée par `routage-pending`), classe chaque tâche en
**parallèle** avec le classifier existant, lance, et écrit lui-même le bloc de faits
« lancé / en file / en attente ». Chaque message devient un **ticket** de
`logs/chef-inbox.json` (`reçu`, `en_cours`, `répondu`, `attend_utilisateur`, `garé`,
`à_classer`, `abandonné`) ; chaque statut a une sortie par le chat (« relance »,
« abandonne », « /dev »), par `chef-inbox.mjs` et par un bouton de l'onglet
Requêtes ; les pannes d'infra garent le ticket et le relancent automatiquement ; les
réponses de menu et les réveils ne coûtent plus qu'un appel ou zéro. Plus de pause du
chef, plus de renvoi en second tour, plus de `[DÉFAUT]` au chef. Estimation : message
avec tâches 102 s → ~40 s, réponse 64 s → ~25 s, réveil 86 s → ~30 s, menu 100 s →
< 2 s, coût −70 %. Migration en cinq phases (≈ 8,5 jours) derrière `chefMode`, relu
à chaud, retour arrière immédiat ; la phase 0 (1 jour) corrige déjà dans l'existant
les trois impasses les plus fréquentes.
