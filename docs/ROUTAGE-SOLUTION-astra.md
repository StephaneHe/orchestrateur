# Étude indépendante Astra — refonte du Routage

Date : 19 octobre 2026. Auteur : OpenAI 6 Astra. Étude et proposition uniquement, destinée à la comparaison puis à la synthèse par Opus. Aucune autre proposition ROUTAGE-SOLUTION n'a été consultée.

## 1. Recommandation

Réduire fortement le Routage : un plan sémantique court, validé par le code, puis une exécution durable de tâches identifiées. Retirer le Routage du moteur générique de développement. Conserver les pipelines spécialisés des musiciens, les modèles choisis et les protections d'autorisation. Une tâche du chef doit avoir le même suivi et les mêmes dépendances qu'une tâche de musicien, avec des permissions différentes.

La priorité n'est pas un meilleur prompt de classification. C'est de rendre impossible la disparition administrative d'une demande : chaque tâche garde un propriétaire, un état vérifiable, son résultat attendu et des actions de récupération exécutables sans modèle. Une panne peut empêcher de réussir ; elle ne doit jamais empêcher de savoir ce qui reste à faire et de choisir une issue.

## 2. Périmètre, sources et limites des preuves

### 2.1 Corpus effectivement examiné

- Dépôt de développement : I:/Dev/orchestrateur-dev, HEAD 7a9676584ecbaaa785d9bdebcb571addc45453a1, package 0.114.0.
- Code : scripts/pipeline-engine.mjs, pipeline-catalog.mjs, pipeline-classify.mjs, routage-pending.mjs, chef-action-deferred.mjs, dispatch.mjs, request-map.mjs, server.js ; définitions, critères, reprise, effets, suivi et réveils.
- Journaux réels : I:/orchestrateur/logs/runs/*/run.json, pipeline-classify.ndjson, chef.jsonl, chef-actions.log, routage-released.ndjson et routage-pending.json.
- Artefacts de routage : I:/Dev/Chef/.orchestrateur/runs/<run>/dispatch.json et rapport.md, plus les tâches persistées dans run.json.
- Production au moment de la lecture : package 0.114.3. Les fichiers de production ont été comparés en lecture seule à ceux du développement. Le classificateur, le gestionnaire de renvoi différé et server.js sont identiques ; moteur, catalogue, dispatch et attentes diffèrent.
- Les quatre fichiers non commités indiqués dans la mission sont laissés intacts. Le correctif local resumeNotes n'est pas assimilé au correctif resumeMessages présent en production.
- La configuration de production porte déjà « pipeline-enforce off --chef », daté du 19 octobre à 18:27:54 UTC ; orchestrateur-dev n'est plus dans les projets soumis aux pipelines. C'est un constat, pas une action de cette étude.

Les 650 run.json lisibles comprennent 613 exécutions du chef, toutes en Routage, du 9 octobre à 11:19:58 UTC au 19 octobre à 18:25:00 UTC. Le corpus contient plusieurs versions successives : un incident historique n'établit pas, à lui seul, que le même défaut existe encore. Les journaux sont vivants et ne constituent pas une capture transactionnelle.

### 2.2 Mesures reproductibles

| Mesure | Résultat | Interprétation |
|---|---:|---|
| États du chef | 609 done, 4 paused | done signifie fin du routage, pas satisfaction de toutes les demandes |
| Modes | 413 demande, 197 callback, 3 discussion | Les réveils représentent une part substantielle du travail |
| Étapes | 3 165 ok, 49 refused, 6 failed, 1 model_unavailable, 364 skipped | Les étapes sautées normalement ne sont pas des erreurs |
| Exécutions avec refused/failed | 52, pour 55 tentatives | 49 ont ensuite terminé ; 3 restent en pause |
| En ajoutant model_unavailable | 53 exécutions, 56 événements | Environ 8,6 % du corpus ont cette trace technique ; ce n'est pas le taux complet d'erreurs métier |
| Classificateur journalisé | 255 décisions, toutes ok:true ; dont 250 routage-tache | Succès de format et de protocole, pas preuve de justesse sémantique |
| Lacunes dans ce journal | 3 | Les run.json conservent 8 tâches avec lacune sur une période plus large |
| Tâches avec question / refused | 23 / 4 | Catégories pouvant se recouper, pas des exécutions à additionner |
| Messages directs du chef | 109 DÉFAUT, dont 45 concernant chef ; 11 RENVOI_CHEF | Les défauts de musiciens ne sont pas tous des défauts de routage |
| Renvois dans chef-actions.log | 16 tentatives : 5 sorties 65, 11 sorties 0 | Les cinq refus ne figurent pas comme erreurs dans les étapes de leurs routages |
| Durée active des demandes terminées | médiane 104 s ; p95 172 s, n=411 | Temps du routage, sans le travail ultérieur des musiciens |
| Durée active des callbacks terminés | médiane 87 s ; p95 124 s, n=195 | Une synthèse de retour nécessite actuellement plusieurs étapes |
| Attentes présentes au relevé | 0 | Ne prouve pas que les attentes historiques ont toutes été satisfaites |

Le relevé de chef.jsonl parcourt 825 070 lignes. Il retient seulement les user_prompt dont le texte commence par DÉFAUT ou RENVOI_CHEF, sans compter les citations de ces messages dans les réponses.

## 3. Fonctionnement réel

Le parcours actuel « demande » n'est plus exactement Lire → Classifier → Découper. Dans scripts/pipeline-catalog.mjs:261-317, il est :

**Lire → Comprendre le sens global → Découper → Classer chaque tâche → Affecter → Dispatcher → Rapporter.**

Lire, Comprendre, Découper et Rapporter sont des étapes de modèle avec artefacts. Classer est un handler de code appelant le modèle séparément pour chaque tâche. Affecter et Dispatcher sont du code. Le mode callback fait Lire → Relancer → Callback → Rapporter ; le mode discussion fait Lire → Discuter → Rapporter.

Le découpeur produit simultanément projet, titre, texte autonome, dépendances, rattachement, éventuelle reprise, action du chef, renvoi au chef, choix imposé, autorisation hors pipeline et choix de session. Plusieurs combinaisons sont interdites. Le classificateur réinterprète ensuite ce plan ; le dispatcher peut encore réinterpréter une citation de run comme une reprise.

Les effets sont répartis entre run.json, artefacts, fichiers d'attente, files par musicien, journaux de tours, traces de libération, tickets du chef et processus différés. La page Requêtes reconstruit utilement leur état, mais n'est pas le registre transactionnel de ces effets.

Des récupérations existent déjà : reprise d'une pause, abandon, simplification, choix de modèle, test du modèle, release --force d'une attente nommée, drop d'attentes et gestion de file. Le problème n'est donc pas « aucune commande ne marche ». Ces commandes ne forment pas un parcours cohérent par tâche, certaines passent par le mécanisme qui vient d'échouer, et des réparations exigent de refaire interpréter une demande.

## 4. Incidents avérés, causes racines et impasses

### 4.1 Un identifiant cité devient une commande : le Routage fait autre chose que la demande

**Preuve forte : p-20261019T180056-e8254b**, tâche « vérifier : échec de tests = relance ou correction ? ». run.json conserve pipeline=discussion, route=true, sans reprise. La demande exige lecture seule, aucune modification, et cite comme exemple p-20261019T144511-44d707. dispatch.json contient pourtant reprise=p-20261019T144511-44d707.

Même mécanisme sur p-20261012T073703-b610a9, tâche 4 : « Cette tâche est indépendante de ton exécution dev en pause ... ne la reprends pas et n'y touche pas » ; le dispatch reprend p-20261009T123458-82d93b. p-20261012T075424-47deee annonce aussi une nouvelle Rédaction, « ne reprends PAS » cette exécution, mais le lancement porte encore cette reprise.

Sur p-20261016T163603-9c57b2, le texte demande une nouvelle exécution faststart après une reprise déjà rebloquée ; le lancement reprend encore p-20261016T155123-18ff0c. p-20261017T084436-c012a2 transforme une nouvelle rédaction de mail en reprise de p-20261016T155415-e67865.

Cause actuelle : detectReprise parcourt les identifiants présents dans demande, sans distinguer citation, négation et instruction ; le dispatcher applique cette détection à toutes les tâches. Sources : routage-pending.mjs:220-227 ; pipeline-engine.mjs:1215-1217. Ce comportement est encore dans les deux copies lues.

**Impasse :** préciser davantage le contexte peut renforcer le mauvais rattachement. Une nouvelle tâche et une correction explicite rebasculent vers la même pause. Le classement peut être juste et toutes les étapes être vertes. Il faut séparer les références documentaires d'un ordre typé de reprise.

Huit dispatchs sans champ reprise explicite ont été trouvés. Tous ne sont pas fautifs : p-20261016T163309-8fbcca et les deux p-20261019T144257-7734d9 / p-20261019T144257-e2903d peuvent traduire une continuation voulue. Ils ne doivent pas être comptés automatiquement comme huit erreurs.

### 4.2 Les dépendances impliquant le chef sont interdites, puis déplacées dans la prose

Dix-sept refus avérés : douze « renvoi_chef ne peut pas attendre » et cinq « apres ne peut pas désigner une tâche renvoyée au chef ». Exemples : p-20261014T181424-996bab, p-20261015T110935-f9a1a7, p-20261018T090045-234c79 et p-20261019T181739-7e7851. Liste exhaustive en annexe.

Cause actuelle : validateTasks refuse un prédécesseur renvoyé au chef ; handoffProblem refuse apres sur le renvoi lui-même ; classer refuse aussi une action du chef différée. Sources : pipeline-engine.mjs:719, 851-855, 1137-1153.

**Impasse :** « faire A puis B » est une demande légitime mais le moteur ne sait pas en représenter l'ordre si A ou B relève du chef. Le second essai peut enlever apres pour passer le validateur, en laissant « après » dans le texte. Le moteur n'applique alors plus la contrainte.

Cas établi sur p-20261019T181739-7e7851 : l'utilisateur demande « mettre en TODO avec les details, puis oublie ». Après refus, le plan validé n'a plus de dépendance. Le dispatcher exécute kill-stalled avant le renvoi chargé d'écrire le TODO. Le rapport final reconnaît explicitement l'inversion de l'ordre. Un routage « done » peut donc avoir perdu une exigence essentielle.

### 4.3 Action autorisée, mais mauvaise opération : abandonner est traduit en tuer un processus

Même exécution p-20261019T181739-7e7851. La tâche demande de clore la pause p-20261019T144511-44d707. pipeline-classify.ndjson, 18:19:43 UTC, répond chef=kill-stalled avec ok:true. dispatch.json annonce status=done, code=0, mais sa sortie dit « no pid file ... nothing to kill ». Le rapport constate que l'exécution reste paused.

**Cause :** la liste blanche protège l'exécutable mais pas la postcondition métier. kill-stalled est une opération sur un tour/processus ; abandonner une pause est une transition sur une exécution. Le code retour ne prouve pas la clôture demandée.

**Impasse :** l'interface peut annoncer une action faite alors que l'objet bloquant n'a pas changé. Réessayer l'action choisie ne change rien. La réparation exige une commande distincte de clôture, liée à l'identifiant de l'exécution.

### 4.4 Renvoi annoncé, puis refusé hors du cycle de vie du Routage

Cinq cas prouvés par chef-actions.log :

| Routage | Refus différé |
|---|---|
| p-20261014T181424-996bab | sortie 65 à 18:16:52 UTC |
| p-20261014T193744-22be72 | sortie 65 à 19:40:26 UTC |
| p-20261015T072034-dc447d | sortie 65 à 07:22:12 UTC |
| p-20261015T085629-5371e8 | sortie 65 à 08:57:55 UTC |
| p-20261015T110935-f9a1a7 | sortie 65 à 11:13:25 UTC |

Motif identique : « délégation chef → chef non disponible (P0-B) ». Les run.json restent done ; les dispatch.json lus gardent handoff.status=scheduled.

**Impasse historique :** le parent avait fini, le processus fils avait refusé et aucune tâche durable n'attendait un responsable. Un processus créé n'est pas une action reçue, encore moins exécutée.

**À créditer à l'existant :** chef-action-deferred.mjs:52-103 publie désormais une notification visible d'échec ; onze renvois ultérieurs atteignent un tour du chef et sortent avec 0. Ce n'est donc pas un échec permanent du mécanisme. Mais le message « elle est à relancer » ne crée pas une opération de reprise idempotente ; scheduled reste un artefact historique, pas une confirmation.

### 4.5 Pause générique pour une cause qui ne se répare pas par répétition

Les quatre pauses du chef encore présentes au relevé :

| Exécution | Cause observée | Pourquoi « continuer » ne suffit pas |
|---|---|---|
| p-20261009T193025-d2f51b | Deux étapes sans résultat, code 1, pause criteria | Le journal résumé ne distingue pas le lancement de la production d'artefact ; il faut diagnostiquer le transport |
| p-20261012T085659-061170 | Deux refus du fournisseur à Callback, pause criteria | Répéter le même contexte et le même appel ne résout pas le refus |
| p-20261012T102220-3a6fde | Quota de session jusqu'au 12 octobre 11:50 UTC, pause model_unavailable | L'échéance passée n'a pas suffi à clôturer ou reprendre cette exécution |
| p-20261014T044705-556920 | Deux échecs OAuth expiré, pause criteria | Il faut reconnecter le fournisseur ; régénérer un JSON ne répare pas une authentification |

Ce sont des pauses persistantes, pas une preuve d'absence totale de choix : des menus existent. Leur maintien jusqu'au 19 octobre démontre au minimum une dette de récupération et une responsabilité mal définie.

Les messages DÉFAUT du chef emploient souvent « aucune livraison tant qu'il n'est pas corrigé ou accepté », y compris pour OAuth et le format d'un plan de routage. Cela mélange défaut de produit, défaut du plan et indisponibilité du service. Une correction au second essai laisse aussi un ancien message alarmant sans incident structuré résolu.

### 4.6 Tâche valide sans pipeline : refus sémantique et promesse non persistée

Huit tâches portent lacune dans six routages :

- p-20261010T190323-2556e1 : deux tâches, supervision et nettoyage ;
- p-20261010T190920-c977f2 : deux tâches, supervision et sortie hors pipeline autorisée ;
- p-20261010T191443-2ede19 : nettoyage ponctuel autorisé ;
- p-20261013T095206-96fdf6 : tâche 2, mise en production ;
- p-20261019T103517-b0c80f : tâche 5, mise en production ;
- p-20261019T112409-4ebe4d : tâche 2, construction/déploiement APK.

Sur p-20261013T095206-96fdf6, la préparation est dispatchée ; l'application de production n'est ni dispatchée ni enregistrée dans waiting. Le rapport promet de reprendre l'application après retour du plan.

**Impasse :** un catalogue incomplet est traité comme l'impossibilité de travailler. La continuation survit dans une promesse textuelle, sans obligation durable comparable à une tâche en attente. Ajouter toujours plus de pipelines ne résout pas la classe de problème.

Aujourd'hui les actions de chef et l'autorisation hors pipeline ont déjà des branches dédiées. Mais classer continue de produire route=false pour lacune et le signalement propose un nouveau pipeline, sans créer un chemin d'exécution alternatif. Sources : pipeline-engine.mjs:1103-1118, 1162-1166, 1298-1308.

### 4.7 États orphelins et réponses perdues : incidents historiques, correctifs à préserver

p-20261018T101119-ce3136 refuse de reprendre p-20261018T091024-0e199e car cette dernière est encore running après arrêt de son processus. Le rapport décrit le gel et renvoie la réparation au chef. Une nouvelle exécution aurait été refusée à cause des fichiers non commités : c'est une véritable impasse entre deux gardes.

La production contient désormais reclaimOrphanedRun (pipeline-engine.mjs:1466-1511) : un running sans processus devient paused/orphaned et peut être repris. Le développement lu conserve encore le chemin interrupted. Ne pas présenter la panne historique comme dépourvue de correctif actuel ; le risque résiduel est notamment le rejeu d'effets déjà produits et l'identification par PID seul.

Le problème de message joint à « continuer » est attesté par les demandes et défauts autour de p-20261019T144511-44d707. La version locale en pause coupe resumeNotes à 4 000 caractères et cinq notes ; le DÉFAUT du 19 octobre 15:34:02 UTC le relève. La production contient déjà resumeMessages, horodatés, transmis aux étapes, avec un plafond de 20 000 caractères par message. Ce plafond reste à rendre explicite ou à remplacer par un stockage intégral référencé. L'étude ne modifie aucun des deux correctifs.

### 4.8 Contrats de forme et conflits de frontières

Les 49 refus d'étape se répartissent en : 17 dépendances du chef ; 16 listes vides ; 6 auto-délégations du chef ; 3 JSON invalides ; 2 plafonds de tâches ; 2 dépendances invalides ; 1 projet inconnu ; 1 reprise d'exécution non paused ; 1 modification détectée pendant une étape en lecture seule.

Toutes ces exécutions ont terminé ensuite : ce sont des rejets et des risques d'impasse, pas 49 impasses définitives. Les listes vides ont maintenant un contrat aucun_dispatch/question ; l'interdiction générale du chef dispose du renvoi ; les changements externes du dossier du chef sont maintenant exposés. Les protections utiles doivent rester.

Autres refus métier : p-20261013T205934-731d5e (action hors liste blanche), p-20261014T181424-996bab et p-20261018T084859-4a7d53 (découpeur et classificateur en désaccord sur le destinataire chef), p-20261017T161836-defca2 (redémarrage une fois et en dernier). Tous sont done avec une question/refused, sans correction typée de la tâche.

**Impasse possible :** l'utilisateur doit expliquer le schéma interne ou changer le texte pour franchir un contrat, au lieu de corriger directement le projet, l'action ou la dépendance. Un retry peut faire accepter la forme en sacrifiant le sens. Les plafonds de charge doivent entraîner un lotissement, pas l'abandon d'une partie de la demande.

## 5. Fragilités actuelles déduites du code, non présentées comme incidents prouvés

1. releaseReady retire les attentes du fichier sous verrou AVANT leur lancement (routage-pending.mjs:380-429). Cela protège d'une double libération concurrente, mais un crash entre retrait et spawn peut perdre la tâche. Aucun cas exact de cette fenêtre n'est démontré ici.
2. launchTask retourne un PID, ignore stdout/stderr et ne reçoit pas d'accusé durable du destinataire. Le dispatcher ne considère perdus que les lancements sans PID. Une sortie immédiate avec PID peut donc être annoncée comme lancement.
3. Une reprise de dispatcher peut rejouer des dispatchs immédiats déjà faits : la déduplication actuelle concerne principalement les attentes, sans registre transactionnel commun pour tous les effets.
4. dependencyResult renvoie un result correspondant au texte ; releaseReady refuse is_error et subtype error. Mais une pause de pipeline est écrite comme result success, pipeline_paused=true ; elle n'est pas explicitement exclue ici. Risque de libérer B alors que A attend une décision, à tester impérativement.
5. Les réveils ont des protections réelles : regroupement, six par heure, une minute minimum, trois générations puis rapport seul. Mais le tampon est limité à 20 et les éléments anciens à six heures ; leur retrait ou l'annulation du lot quand l'utilisateur parle n'a pas de preuve de lecture par tâche. Sources : server.js:500-734.
6. La page Requêtes distingue déjà question, bloquée et introuvable. Toutefois non_lancee appartient aux états terminaux ; une lacune peut donc sortir du compteur des tâches ouvertes. Sources : request-map.mjs:58, 263-328.
7. detectReprise exige paused même en production, en amont du moteur qui sait réparer les orphelins : la réparation récente doit être accessible dès le routage, pas seulement après franchissement de ce filtre.
8. La dépendance par offset, empreinte de texte et projet est meilleure qu'un préfixe tronqué, mais n'est pas une identité d'opération. Une rotation du journal ou deux demandes identiques voulues à des dates différentes nécessitent une réconciliation explicite.

## 6. Architecture proposée : un petit ordonnanceur, pas un pipeline de fabrication du routage

### 6.1 Choix entre trois options

| Option | Gain | Limite | Avis Astra |
|---|---|---|---|
| Corriger les contrats du pipeline à sept étapes | Migration faible | Conserve les réinterprétations, les effets dispersés et le coût des callbacks | Mesure transitoire seulement |
| Supprimer toute orchestration, chef libre de lancer des commandes | Très simple à court terme | Les dépendances, accusés, reprises et autorisations redeviennent des promesses conversationnelles | Mode d'exploitation possible, insuffisant comme garantie durable |
| Un plan sémantique court + validation et suivi déterministes | Moins d'appels, état réparable et effets vérifiables | Nécessite un registre de tâches et des adaptateurs | Recommandée |

Le planificateur comprend d'abord le message, le découpe puis caractérise chaque tâche dans une sortie structurée unique. Une demande simple n'a pas besoin de quatre tours de modèle et de quatre artefacts intermédiaires. Si l'exigence historique de classement par un appel distinct pour chaque tâche doit rester littérale, on garde provisoirement ce seul appel par tâche : le gain reste important en supprimant les autres tours artificiels.

La fusion des cases Models doit être explicite : choisir le modèle de la nouvelle case de planification lors de la migration, afficher les anciennes affectations et conserver leur historique. Ne pas convertir silencieusement plusieurs choix de modèles en un seul. Tant que ce choix n'est pas validé, garder les appels sémantiques actuels derrière le nouveau suivi.

Réduction visée : un appel de planification, éventuellement un complément sémantique ciblé si réellement ambigu, et aucune génération obligatoire pour afficher l'état. Une réponse conversationnelle reste produite par le chef. Le rendu initial et les retours opérationnels sont générés directement à partir des tâches ; une synthèse rédactionnelle facultative ne bloque jamais l'exécution.

### 6.2 Ce que l'on conserve

- Le classement par le sens, les choix explicites de l'utilisateur et l'absence de remplacement silencieux du modèle.
- Les pipelines métier des musiciens et leurs critères de livraison ; cette étude ne les supprime pas.
- Le contrôle des capacités : le chef gère l'orchestration ; les musiciens font le travail des projets.
- Les jetons et le contrôle d'origine des commandes, la file, les couloirs et leur isolation.
- Les demandes originales, leurs corrections, les comptes rendus complets, les identifiants cliquables et titres lisibles.
- Les protections anti-boucle et les budgets des synthèses automatiques.
- Les réparations existantes utiles : orphelins, reprise avec message, signalement des renvois ratés, visibilité des attentes.

### 6.3 Ce que l'on remplace

- Lire/Comprendre/Découper/Rapporter comme tours obligatoires : remplacés par un plan et un rendu d'état.
- Affecter comme étape et artefact : devient une résolution de configuration vérifiée avant émission.
- Le contrôle qui cherche des identifiants dans une prose : remplacé par une commande explicite portant un identifiant cible.
- Les tâches du chef exécutées « forcément à la fin du tour » : deviennent des tâches ordonnancées, à capacités limitées, avec les mêmes prédécesseurs que les autres.
- Les attentes reconnues dans les logs : remplacées par taskId/operationId ; l'empreinte du texte ne sert plus que d'aide à l'import et de suggestion de doublon.
- Les titres distincts et préfixes de texte comme conditions bloquantes : un intitulé de repli ou un suffixe désambiguïse l'affichage sans modifier la demande.
- « Aucun pipeline » comme arrêt : crée une décision à résoudre, avec propositions concrètes et conservation de la tâche. Hors pipeline seulement si l'autorisation applicable existe, sinon choix explicite demandé une fois.
- Les notifications DÉFAUT isolées : deviennent un incident rattaché à une tâche et résolu lorsque sa cause disparaît.

### 6.4 Composants minimaux

1. **Entrée et plan** : conserve le message intégral, l'auteur, les pièces, les décisions antérieures applicables et la configuration choisie ; produit réponse, clarification ou liste de tâches.
2. **Service de tâches** : seul écrivain du registre ; valide une commande puis écrit tâche, opération à émettre et événement d'audit dans la même transaction.
3. **Adaptateurs d'exécution** : dispatcher existant, action d'orchestration typée, travail du chef, reprise d'un pipeline existant. Ils renvoient un accusé avec une identité durable, puis un résultat.
4. **Réconciliation** : au démarrage et périodiquement, recherche les accusés manquants, baux expirés et opérations sans résultat ; répare ou crée une action explicite.
5. **Interface et CLI** : utilisent exactement les mêmes commandes de tâche. La réparation ne requiert ni modèle, ni édition de JSON, ni passage préalable par le Routage.

Proposition de stockage : petite base SQLite locale, transactions et un seul service écrivain. Tables tâches, opérations, décisions et audit ; pas de service réseau supplémentaire ni de moteur distribué. Valider le pilote choisi et les contraintes Windows au prototype. Les journaux et artefacts actuels restent consultables ; ils cessent d'être plusieurs sources concurrentes de vérité. Un adaptateur doit éviter que les anciennes files et le nouveau registre puissent programmer simultanément la même opération.

## 7. Modèle d'état et contrat de récupération

### 7.1 Objets stables

Une demande possède requestId, texte intégral, auteur et date ; une tâche possède taskId stable, titre, demande source, targetProject, executor et revision. Les liens entre tâches portent des taskId, jamais le numéro réinterprétable d'une ligne.

L'intention est un type exclusif : nouveau travail, répondre à une question identifiée, reprendre une exécution identifiée, annuler une exécution identifiée, ou action d'orchestration identifiée. Les referencesToRuns sont documentaires ; elles ne sont jamais exécutées.

Une tentative porte attemptId, operationId, version du plan, modèle/configuration retenus, accusé du destinataire, bail et résultat. Une correction crée une nouvelle révision, jamais une réécriture silencieuse de ce qui a été envoyé. Une réparation automatique ne peut supprimer une dépendance, une interdiction de modification ou une cible explicite pour faire passer le schéma ; elle doit conserver la contrainte ou demander une décision sur le champ concerné.

Les autorisations sont des décisions persistées avec auteur, texte intégral, portée, date et révocation éventuelle. Le modèle peut proposer de réutiliser une décision ; le code vérifie la portée. Une citation incluse par un musicien ne vaut jamais autorisation utilisateur.

### 7.2 États de tâche

| État | Sens exact | Sortie minimale disponible |
|---|---|---|
| draft | Plan incomplet ou pas encore validé | Corriger ou annuler |
| ready | Valide, autorisé et prédécesseurs satisfaits | Lancer, modifier avant émission ou annuler |
| waiting_dependency | Prédécesseur identifié non réussi | Voir le prédécesseur, le réparer, modifier la dépendance sous autorisation ou annuler |
| dispatching | Opération persistée, accusé attendu | Vérifier l'accusé ; ne pas créer une deuxième opération |
| queued | Accusé durable reçu, exécution non commencée | Modifier la demande si non prise, retirer ou conserver |
| running | Exécution attestée par bail et identité de tentative | Voir l'activité, demander l'arrêt ou fournir une réponse |
| needs_action | Cause précise nécessitant une décision/réparation | Au moins une action locale valide ; destinataire de la décision affiché |
| cancelling | Annulation enregistrée, arrêt en cours de confirmation | Vérifier l'arrêt et voir les effets déjà produits |
| succeeded | Résultat et postcondition vérifiés | Consulter ; nouvelle tâche explicite si nouveau travail |
| cancelled | Aucun nouveau lancement possible ; effets existants conservés | Consulter le bilan et les travaux éventuellement récupérables |

Les erreurs récupérables sont needs_action avec error.code et retryPolicy ; pas d'état « failed » opaque sans issue. Une panne dont les effets sont inconnus a le code OUTCOME_UNKNOWN et interdit le rejeu aveugle. Une demande agrège les états : terminée seulement quand chaque tâche est réussie ou annulée explicitement, sinon en cours ou intervention requise. La fin du tour du chef est un événement séparé.

Si A est annulée ou échoue, B ne devient pas prête : elle passe en needs_action avec « réparer A », « remplacer A », « autoriser B sans A » ou « annuler B ». Le défaut de dépendance ne doit ni lancer B ni supprimer B.

### 7.3 Émission fiable et effets externes

Transaction : valider la révision et les préconditions → inscrire l'opération à émettre → confirmer à l'appelant. Un worker envoie cette opération avec une clé d'idempotence. Le destinataire enregistre cette clé avant d'accepter le travail ; une répétition retourne le même accusé au lieu de créer un deuxième tour.

Après crash, la réconciliation commence par rechercher cet accusé. Elle ne rejoue automatiquement que les opérations dont l'absence d'effet ou l'idempotence est établie. Un outil externe non idempotent reste en vérification explicite si son résultat est incertain. Le système ne prétend pas garantir une exécution universellement « exactement une fois ».

L'accusé queued n'est pas succeeded. Le résultat doit nommer l'opération et la postcondition. Une question adressée à l'utilisateur, y compris dans un tour ordinaire terminé avec code 0, n'est pas une réussite de la tâche : elle devient needs_action. Pour cancel_run, la postcondition est l'état terminal de l'exécution ciblée ; l'absence de PID n'est pas une preuve. Pour un redémarrage, une confirmation du service revenu, pas seulement la création du processus de redémarrage.

Les tâches du chef attendent ses capacités disponibles et le verrou de sa session. Si elles dépendent d'un musicien, elles attendent sa réussite confirmée. Aucun sous-processus ne décide seul de commencer « quand même » parce que l'attente d'un PID a expiré.

### 7.4 « Jamais d'impasse » : critère vérifiable, limite honnête

Pour tout état non terminal persisté, le service expose soit un prochain événement attendu avec délai de contrôle, soit une action de récupération exécutable avec responsable. Après expiration, il produit needs_action, jamais une attente sans explication.

L'utilisateur et le chef peuvent lister, inspecter, corriger, reprendre, suspendre ou annuler par le même contrat. Si le tableau de bord ou le modèle est indisponible, un CLI local peut agir sans eux, en obtenant le verrou exclusif du registre lorsque le service est arrêté. Si le registre est illisible, le CLI permet diagnostic, export de preuves lisibles et restauration d'une sauvegarde vérifiée ; il n'écrase pas la base corrompue.

Cela ne garantit ni la disponibilité de la machine ni la réussite d'une action distante. Une opération déjà en cours chez un fournisseur peut être impossible à arrêter immédiatement : elle reste cancelling/OUTCOME_UNKNOWN avec preuves et nouvelle vérification. « Abandonner proprement » signifie empêcher les nouveaux effets, traiter les dépendants et rendre visibles les effets déjà engagés, pas prétendre les annuler rétroactivement.

## 8. Ce que le code doit vérifier

| Vérification | Comportement exigé |
|---|---|
| Forme du plan | Schéma typé exclusif ; erreurs par champ ; une réparation ciblée du plan au maximum |
| Couverture de la demande | Chaque fragment d'intention a une tâche, une réponse ou une clarification ; vérification sémantique évaluée sur corpus, pas présentée comme preuve mathématique |
| Origine et autorisation | Décision persistée applicable ; pas d'autorisation déduite d'un callback ou d'une citation |
| Cible | Projet existant, exécutant autorisé, cible de reprise/annulation explicite, même projet et bon propriétaire |
| Dépendances | Références existantes, graphe sans cycle, attente de succeeded ; chef autorisé comme prédécesseur ou successeur |
| Concurrence | Révision attendue, verrou de ressource/session, bail et identité de tentative, protection contre réponses tardives |
| Émission | Opération persistée avant envoi, accusé corrélé, idempotence de bout en bout lorsque supportée |
| Postcondition | État réellement obtenu ; code 0/PID/texte « fait » insuffisants pour une action d'administration |
| Reprise | Réutilise l'exécution visée, conserve tous les messages et ne refait pas les effets déjà confirmés |
| Annulation | Coupe les nouveaux départs, traite tous les descendants, conserve les artefacts et résultats acquis |
| Configuration | Modèle et règles applicables fixés pour la tentative ; changement traçable, aucun fallback silencieux |
| Présentation | Titre lisible de repli, références valides, texte complet accessible ; une faute de forme ne bloque pas tout le lot |

Le code ne peut pas prouver seul que « tuer un processus » signifie « abandonner une pause ». La solution consiste à réduire les types d'actions que le modèle doit choisir et à vérifier la postcondition de chacun. Le chef dispose directement des actions cancel_run et stop_attempt, distinctes.

## 9. Classement des erreurs, automatique et escalade

| Classe | Réparation automatique permise | Action explicite ensuite |
|---|---|---|
| Format cosmétique, titre absent | Normaliser, donner un titre de repli, conserver l'original | Corriger le libellé |
| Plan invalide ou ambigu | Une correction structurée ciblée, sans toucher aux tâches déjà acceptées | Corriger le champ ou choisir parmi des propositions |
| Réseau / quota temporaire | Reprise bornée avec temporisation et date de prochain essai, même modèle | Réessayer maintenant, attendre, changer explicitement le modèle, annuler |
| Authentification | Aucun retry répétitif du même appel invalide | Reconnecter puis tester, choisir un modèle autorisé, annuler |
| Refus fournisseur / contexte invalide | Pas de boucle automatique ; préserver le diagnostic | Examiner la cause ; corriger une demande légitime, restaurer un contexte adapté si pertinent, ou annuler |
| Exécution orpheline | Vérifier bail, processus et accusés ; rendre l'état réparable | Reprendre le reste, cloner une nouvelle tâche avec bilan, annuler |
| Dépendance échouée | Bloquer uniquement les descendants, préserver les branches indépendantes | Réparer le prédécesseur, modifier la dépendance avec motif, annuler |
| Pipeline absent | Conserver la tâche et les choix existants ; enregistrer la lacune comme amélioration du produit | Choisir un pipeline adapté ou autoriser un tour ordinaire borné |
| Résultat inconnu | Interroger le destinataire ; aucun rejeu d'effet non idempotent | Réconcilier avec une preuve ou conserver la suspension |
| Invariant cassé / corruption | Isoler la tâche ou le registre concerné, conserver les preuves | Réparer via commande contrôlée ou restaurer une sauvegarde |

Une erreur corrigée automatiquement devient un incident résolu, replié dans l'historique. Une seule alerte active par cause et tâche, mise à jour si elle évolue. L'escalade indique le propriétaire : utilisateur pour une décision nouvelle, chef pour une opération autorisée, opérateur pour l'authentification ou l'état du service. Pas de cycle chef → routage défaillant → chef.

## 10. UX commune à l'utilisateur et au chef

Une carte de tâche montre : intitulé, projet, demande d'origine, état réel, dernier résultat utile, ce qui a déjà été fait, ce qui manque, cause précise, responsable et prochain geste. Les détails techniques restent dépliables.

Exemple de la mauvaise reprise :

> « Vérifier le comportement des tests » n'a pas été lancée en Discussion. Le Routage a tenté de reprendre le développement cité dans votre question. Votre demande est conservée. La cible proposée est Discussion, lecture seule.  
> Actions : **Corriger la cible et lancer** · **Examiner les effets de la tentative** · **Annuler cette tâche**.

Exemple de dépendance :

> « Redémarrer après les tests » attend la tâche « Tests complets », qui a échoué. Aucun redémarrage n'a été lancé.  
> Actions : **Voir et réparer les tests** · **Modifier la condition avec justification** · **Annuler le redémarrage**.

Exemple de renvoi :

> Le chef n'a pas reçu « Ranger les attentes ». Le lancement a été refusé ; aucun travail n'a commencé.  
> Action recommandée : **Relancer l'opération existante**. L'identifiant reste le même.

Contrat proposé, à implémenter (ces commandes n'existent pas encore) : routing-task inspect <taskId>, routing-task correct <taskId> --revision <n>, routing-task retry <taskId> --revision <n>, routing-task resume-run <taskId> --run <runId>, routing-task cancel <taskId> --revision <n>. Un même endpoint POST /api/routing/tasks/:id/commands reçoit action, expectedRevision, commandId et les paramètres typés. La correction se saisit dans l'UI ou par paramètres du CLI, jamais par édition des fichiers internes. Une répétition du même commandId restitue le résultat initial.

Un bouton n'est affiché que si le service expose la commande correspondante avec ses préconditions. La vue technique et le CLI montrent taskId, revision, error.code, opérations possibles et preuves. « Continuer » peut être une commodité lorsque la carte cible est sélectionnée, jamais une recherche approximative dans toute la conversation.

Corriger une tâche montre le changement de projet, d'action, de modèle ou de dépendance avant validation. Les décisions déjà accordées restent acquises dans leur portée ; un nouveau choix hors pipeline ou une levée de dépendance non autorisée nécessite une décision réelle. Les autres tâches du lot continuent si elles sont indépendantes.

Les callbacks mettent d'abord l'état à jour et rendent le résultat visible. Une synthèse du chef peut être différée par son budget, mais ni la livraison du résultat ni la libération des dépendances ne dépend d'un nouveau tour de modèle.

## 11. Migration et retour arrière

### 11.1 Séquence

1. **Photographier et qualifier.** Export contrôlé des états, fichiers d'attente, files et accusés ; version des schémas et empreintes des sources. Distinguer les exécutions réellement actives des historiques done. Ne modifier aucune exécution en pause pendant l'import.
2. **Installer le secours avant de changer le routage.** Commandes typées inspect/repair/resume/cancel sur un objet explicite, avec validation et journalisation. Elles s'appuient d'abord sur des adaptateurs de l'existant. Aucune réparation manuelle de run.json.
3. **Créer le registre et les accusés.** Les nouveaux départs ont operationId et accusé durable ; la réconciliation tourne sans modèle. L'ancien moteur continue de posséder ses exécutions engagées.
4. **Observer sans agir.** Le nouveau planificateur produit des propositions sur les mêmes entrées, sans dispatch, action de chef ni effet. Comparer sur le corpus et sur des messages réels autorisés à cette observation.
5. **Piloter sur un périmètre restreint.** Activer pour de nouvelles demandes seulement, par configuration explicite. Une demande a engineOwner=legacy ou tasks-v2 ; jamais les deux. Ne pas réactiver le Routage du chef actuellement désactivé simplement pour tester.
6. **Importer les obligations restantes.** Chaque attente devient une tâche avec legacyRef. Correspondance certaine : lier la dépendance à l'opération réelle. Correspondance ambiguë, historique incomplet ou renvoi scheduled sans accusé : needs_action, avec les preuves et une décision de réconciliation. Rien n'est relancé automatiquement sur la seule base d'un ancien PID.
7. **Retirer l'ancien parcours de Routage.** Après validation, les sept étapes cessent d'être le chemin normal. Garder les lecteurs d'historique et les adaptateurs tant qu'il reste des exécutions anciennes.

Les anciennes pauses restent reprenables avec le moteur qui sait les interpréter ; une copie du travail vers une nouvelle tâche est une opération explicite avec bilan des effets déjà réalisés. L'import conserve les identifiants historiques et n'écrit pas dans les fichiers de travail des projets.

### 11.2 Rollback réellement sûr

- Le drapeau de bascule ne concerne que les nouvelles demandes.
- Les tâches déjà acceptées par le nouveau registre continuent d'y être suivies, ou sont suspendues puis exportées par un adaptateur contrôlé. L'ancien moteur ne les redémarre pas.
- Garder une version de service capable de lire ce registre pendant toute la période de rollback ; pas de retour aveugle vers un binaire ignorant les tâches v2.
- Pour rétro-importer une tâche, arrêter son ancien propriétaire, vérifier les accusés et réserver son operationId dans la cible avant de l'y rendre prête.
- Sauvegarder configuration et base avant migration. Une restauration de base après effets externes exige une réconciliation avec les reçus du destinataire ; revenir à une sauvegarde ne doit pas faire oublier un travail déjà lancé.
- Si le pilote pose problème, le chef ordinaire et les commandes de secours restent utilisables. Le rollback ne rétablit pas la reprise sur simple mention pour les objets déjà migrés.

## 12. Tests, exigences et critères d'acceptation

Cette étude ne crée aucun test de comportement ni ne modifie docs/USER_REQUIREMENTS.md : l'interdiction explicite de modifier le code et les quatre fichiers en pause prime pour ce livrable. Les scénarios ci-dessous sont des travaux à réaliser lors de l'implémentation, avec la demande verbatim, la date, les fichiers de test et leur rattachement à la non-régression.

### 12.1 Matrice proposée de non-régression

| Scénario automatisé | Incident ou risque couvert | Résultat vérifié |
|---|---|---|
| Une demande de Discussion cite une exécution paused, avec ou sans « ne pas reprendre » | p-20261019T180056-e8254b ; p-20261012T073703-b610a9 | Zéro reprise ; tâche de lecture seule conservée |
| Une commande resume cible explicitement une exécution | Reprise volontaire | Même run, notes intégrales, aucun redémarrage des effets confirmés |
| Le chef attend A ; B attend le chef | Les 17 refus de dépendances | Ordre vérifié par événements, sans suppression de lien |
| TODO puis abandon | p-20261019T181739-7e7851 | TODO confirmé avant cancel_run ; aucun kill-stalled substitué |
| Le fils reçoit un PID puis refuse | Les cinq renvois sortie 65 | Tâche non réussie, erreur visible, reprise de la même opération disponible |
| Crash avant envoi, après envoi et avant accusé, après accusé, après résultat | Fenêtres de persistance | Ni perte ni double acceptation ; état inconnu explicite si nécessaire |
| Deux libérations concurrentes, double clic, réponse tardive | Concurrence | Une opération ; révision périmée refusée sans perte de la correction |
| Résultat paused/success, abandoned/success, erreur, réussite réelle | Dépendances | Seule la réussite métier libère le successeur |
| OAuth expiré, quota, refus fournisseur, JSON invalide | Quatre pauses historiques | Cause juste, retries bornés, réparation et annulation sans modèle |
| Sept puis dix-sept tâches, zéro tâche avec réponse directe | Plafond et listes vides | Toutes conservées ; lotissement ; aucune omission pour franchir le contrat |
| Lacune alors qu'une autorisation applicable existe ; puis sans autorisation | Huit lacunes | Parcours autorisé disponible ; sinon question ciblée conservant la tâche |
| Service redémarré, PID réutilisé, exécution orpheline | p-20261018T101119-ce3136 | Réconciliation par tentative/bail/accusé, pas PID seul |
| Annulation d'un parent avec descendants en file ou actifs | Abandon propre | Aucun nouveau départ ; descendants traités ; effets acquis explicités |
| Message de reprise supérieur à 20 000 caractères et corrections successives | Perte de contexte | Texte intégral accessible et référencé ; aucune coupe silencieuse |
| Chef occupé, budget de réveil épuisé, plus de vingt résultats | Réveils | Tous les résultats consultables ; dépendances libérées sans synthèse LLM |
| Tableau de bord indisponible et modèle indisponible | Sortie de secours | CLI inspect/correct/resume/cancel utilisable avec le même contrat |
| Migration puis rollback avec lancement déjà accepté | Double propriétaire | Aucun double départ ; historique et opérations inchangés |
| Registre illisible ou disque plein | Limite de l'infrastructure | Aucun succès fictif, diagnostic hors modèle, export/restauration contrôlés |

Les tests doivent vérifier des résultats observables et des transitions, pas la présence d'une phrase de prompt ou le nom d'une fonction. Conserver les tests utiles existants : routage, pending, dedupe, handoff_failed, no_dispatch_chef, wake_report_only, request_map, hors_pipeline_task, resume_message et user_requirements. Les fixtures des incidents seront anonymisées pour ne pas publier de données privées du chef.

**Exigences historiques à arbitrer avant toute modification de tests :** la reprise déduite d'un identifiant cité, les règles de séparation/classification par tâche, les titres distincts et les contraintes de délégation. scripts/_test_routage_pending.mjs protège notamment le comportement de reprise implicite. Le nouveau contrat doit être approuvé explicitement avant d'inverser ou supprimer cette assertion ; ne pas le faire discrètement au nom de la refonte. Cette étude recommande ce changement, elle ne constitue pas cet accord.

### 12.2 Mesures de succès

- Zéro reprise accidentelle sur tous les cas reproduits et leurs négations.
- Zéro perte ou double acceptation dans les injections de crash et de concurrence ; aucun résultat inconnu présenté comme succès.
- 100 % des tâches non terminales exposent une action disponible ou un événement attendu avec délai ; chaque expiration produit une action nommée.
- Une correction sur une branche ne relance pas les branches réussies et conserve leurs reçus.
- Les dix-sept cas de dépendance du chef passent sans modifier le sens de « puis ».
- Une lacune de catalogue ne supprime aucune obligation ; l'absence de consentement devient une question précise, pas une demande de créer un pipeline.
- Objectif initial de latence : réduire d'au moins 50 % la médiane de routage sur corpus comparable et même modèle ; c'est un objectif à mesurer, pas un gain garanti.
- En pilote, comparer les erreurs par catégorie, le nombre de relectures/corrections utilisateur, les tâches non terminales âgées et le coût par demande. L'augmentation des états needs_action visibles peut d'abord révéler une dette existante ; elle n'est pas forcément une régression.
- Le passage du corpus ne suffit pas à prouver la qualité sémantique générale : ajouter des paraphrases, contre-exemples, demandes multitâches et interruptions concurrentes.

## 13. Effort et ordre de livraison

Estimations en jours de développement pour une personne connaissant ce dépôt, tests de l'étape inclus. Le modèle, les dépendances et l'historique rendent ces estimations incertaines ; affiner après le prototype.

| Étape | Travail et résultat contrôlable | Effort |
|---|---|---:|
| 0 | Contrat de récupération, inventaire des exigences, accord sur les tests incompatibles, scénarios d'incidents | 1–2 j |
| 1 | Registre minimal, opérations, révisions, accusés, réconciliation ; secours CLI sur exécutions existantes | 3–5 j |
| 2 | Planificateur court, suppression des tours artificiels, rendu déterministe, observation sans effets | 2–3 j |
| 3 | Dépendances communes chef/musicien, cancel_run distinct de stop_attempt, adaptateurs de file et reprise | 3–4 j |
| 4 | Cartes de réparation, décisions persistées, erreurs contextualisées, tests HTTP et parcours navigateur | 3–5 j |
| 5 | Import, rollback, corpus complet, injections de panne et pilote | 2–3 j |
| Total | Hors délai d'observation en exploitation | **14–22 j** |

Première tranche utile : après les étapes 0 et 1, une tâche possède déjà une issue explicite même si le routage historique subsiste. Ne pas commencer par renommer les étapes ni multiplier les prompts. L'étape 2 réduit les causes d'erreurs ; les étapes 1 et 3 empêchent que ces erreurs perdent les demandes.

Si la réduction du nombre de tours ne peut être validée immédiatement, livrer d'abord le suivi et les commandes de réparation avec le planificateur existant. Cela limite le changement simultané de qualité sémantique et d'exécution.

## 14. Décisions proposées à la synthèse d'Opus

1. Retenir la réduction forte du Routage, en gardant les pipelines métier hors de cette refonte.
2. Faire du contrat de tâche et de l'accusé durable le préalable à toute promesse « lancé » ou « fait ».
3. Remplacer la reprise par citation par une commande explicite, après accord sur les tests d'exigence existants.
4. Autoriser les dépendances chef ↔ musicien dans le même graphe, sans permettre au chef de faire du travail de projet.
5. Traiter une lacune comme une décision récupérable et un signal produit, jamais comme une disparition de la demande.
6. Ne pas promettre « jamais de panne » : exiger « jamais d'état non terminal sans responsable et issue exécutable ».
7. Utiliser un seul état opérationnel et le même contrat pour UI, CLI et chef ; les notifications et modèles n'en sont que des clients.

## Annexe A — inventaire exhaustif des refus/échecs d'étapes du chef

Les lignes ci-dessous couvrent les 56 événements refused, failed et model_unavailable de 53 exécutions. Les listes d'identifiants sont dédupliquées dans chaque catégorie ; « tentatives » compte les répétitions. Les incidents sémantiques, lacunes et renvois différés sont détaillés séparément au §4 car ils peuvent se produire avec toutes les étapes ok.

| Cause enregistrée | Tentatives | Exécutions |
|---|---:|---|
| taches.json : 17 tâches (au plus 6 par message : découper) | 1 | p-20261009T113003-6fb43a |
| taches.json : tâche 1 : « apres » doit désigner une tâche précédente (1 à 0) | 2 | p-20261009T155431-22e10e, p-20261009T191151-80eaf2 |
| aucun résultat (code 1) | 2 | p-20261009T193025-d2f51b |
| Chef exclu des destinataires | 6 | p-20261009T194110-385a6e, p-20261012T090302-104e01, p-20261012T121417-b696ce, p-20261014T044834-2601c2, p-20261014T070908-f73a62, p-20261016T080754-38dedf |
| taches.json : aucune tâche | 16 | p-20261009T211219-9972bc, p-20261009T222017-56bdf1, p-20261009T223520-ba5287, p-20261009T230229-64976e, p-20261010T090927-06522f, p-20261010T193119-6e8112, p-20261010T193435-08c2d3, p-20261010T200454-616091, p-20261010T200830-8b2b1c, p-20261010T203520-fd7fb6, p-20261011T082353-8c1993, p-20261012T065613-1fb969, p-20261012T081436-07169b, p-20261012T082133-dbb1c5, p-20261012T085303-8ec7b2, p-20261012T085907-0fbc82 |
| étape en lecture seule, mais des fichiers du projet ont changé : docs/ROUTAGE-PROBLEMES.md | 1 | p-20261010T210614-034d0d |
| classement.json n’est pas un JSON valide | 1 | p-20261012T074740-2d21c7 |
| Refus fournisseur | 2 | p-20261012T085659-061170 |
| limite de session Claude jusqu'à 2026-10-12T11:50:00.000Z | 1 | p-20261012T102220-3a6fde |
| taches.json : tâche 2 : projet inconnu « divers » | 1 | p-20261013T124219-ebf448 |
| taches.json : 7 tâches (au plus 6 par message : découper) | 1 | p-20261013T202938-f29b0e |
| Failed to authenticate: OAuth session expired and could not be refreshed | 2 | p-20261014T044705-556920 |
| Renvoi chef ne peut pas attendre | 12 | p-20261014T145525-24a1d7, p-20261014T181424-996bab, p-20261014T193744-22be72, p-20261015T085122-5e9386, p-20261015T110935-f9a1a7, p-20261015T143258-127cd3, p-20261016T043850-a0106b, p-20261016T102815-e75edf, p-20261019T142547-a86bfa, p-20261019T151215-af4324, p-20261019T181739-7e7851, p-20261019T182500-d0171a |
| Tâche ne peut pas attendre le chef | 5 | p-20261015T210716-da95c0, p-20261016T164356-3b9838, p-20261017T084436-c012a2, p-20261018T090045-234c79, p-20261019T165050-4d7b7f |
| taches.json : tâche 1 : l'exécution p-20261018T091024-0e199e n'est pas une exécution en pause de youtube-live | 1 | p-20261018T101119-ce3136 |
| sens.json n’est pas un JSON valide | 2 | p-20261019T112141-7a656b, p-20261019T144550-cf6b8b |


## Note de reprise du 19 octobre 2026

La rédaction préparée dans le tour de 21:32 à 21:56 a été récupérée directement dans son transcript, avec les compléments enregistrés avant interruption. Les chiffres décrivent le relevé de ce tour, sans nouveau parcours des journaux de production. Aucun test ni parcours navigateur supplémentaire n’a été lancé pour cette livraison documentaire, conformément à la consigne de reprise. La vérification préalable du tour interrompu ne vaut pas validation complète : un échec de nettoyage temporaire Windows a été relevé dans scripts/_test_hors_pipeline_task.mjs, après passage de ses assertions ; aucune conclusion globale verte n’est revendiquée.
