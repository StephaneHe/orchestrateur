# orchestrateur — exigences utilisateur

Chaque demande précise de l'utilisateur sur une fonctionnalité est protégée
par un test automatisé de la non-régression (`node scripts/regression.mjs`),
rejoué à chaque évolution. Règle utilisateur du 2026-10-04 : « à partir du
moment où je fais une demande spécifique à propos d'une fonctionnalité, il
faut rajouter un test de non-régression pour plus tard ».

- Une ligne par demande, jamais retirée. Les noms de projets privés sont
  remplacés par « [projet] » (dépôt public).
- **Test associé**, une référence par code :
  - `suite:<fichier>` : une suite `scripts/_test_*.mjs` ;
  - `http:<id>` : un parcours HTTP de `scripts/regression.mjs` ;
  - `nav:<id>` : un parcours navigateur de `scripts/_regression_browser.mjs`.

  `scripts/_test_user_requirements.mjs` vérifie que chaque référence existe.
- Un test listé ici ne se supprime ni ne s'affaiblit sans l'accord explicite
  de l'utilisateur.

| Date | Demande (verbatim) | Test associé | Depuis |
|------|--------------------|--------------|--------|
| 2026-09-27 | « l'affichage montre toujours une question de [projet] à laquelle j'ai déjà répondu » (acquitter une question sans relancer le musicien) | `http:question` `nav:resolve` | 0.25.0 |
| 2026-09-27 | « si un modèle est précisément demandé, aucun fallback n'est toléré » | `suite:_test_explicit_model.mjs` | 0.26.0 |
| 2026-09-27 | [projet] doit avoir accès à internet ; trois models doivent produire chacun une étude indépendante (session neuve, `--new-session`) | `suite:_test_explicit_model.mjs` | 0.27.0 |
| 2026-09-27 | « tous les projets doivent avoir droit au web et à la lecture » | `suite:_test_tools_resolution.mjs` | 0.28.0 |
| 2026-09-28 | « je veux voir en un coup d'œil le statut de chacun des projets » (vue Projets, désactivable) | `suite:_test_projects_view.mjs` `http:pupitre-projects` `nav:groups` `nav:flag-hot` `nav:param` | 0.29.0 |
| 2026-09-28 | « faire des tests de non-régression pour être sûr que toutes les fonctionnalités marchent toujours, et être capable de revenir en arrière » | `suite:_test_user_requirements.mjs` (ce registre est vérifié) | 0.29.0 |
| 2026-09-28 | « un petit panneau me demande une autorisation mais sans me dire laquelle ; une fois le musicien ouvert, je ne vois pas quelle autorisation a été demandée » | `suite:_test_permission_denial.mjs` `nav:denial-false` `nav:denial-true` | 0.29.1 |
| 2026-10-01 | « rien n'apparaisse sur le git, ni dans l'historique » (logs, config, jetons, captures hors dépôt) | `suite:_test_repo_hygiene.mjs` | 0.29.2 |
| 2026-10-02 | « les autorisations auraient dû être données à la création » (workspace de confiance, permissions standard) | `suite:_test_workspace_trust.mjs` | 0.30.0 |
| 2026-10-02 | « je n'ai pas la possibilité de le marquer comme vu, et le cadre reste affiché dans la partie À examiner, même après l'avoir vu » | `suite:_test_activity_journal.mjs` `http:ack-stopped` `nav:examine-stopped` `nav:examine-seen` | 0.31.0 |
| 2026-10-02 | un arrêt volontaire par le chef doit être présenté « Arrêté par le chef », pas comme un échec | `suite:_test_activity_journal.mjs` `http:ack-stopped` `nav:examine-stopped` | 0.31.0 |
| 2026-10-02 | « je voudrais plutôt un résumé de toutes les actions entreprises, sous forme de journal » | `suite:_test_activity_journal.mjs` `http:journal` `nav:journal-tab` `nav:journal-live` | 0.31.0 |
| 2026-10-02 | « mettre aussi sous forme de cadre les musiciens, en les classant du dernier actif en haut au plus anciennement actif en bas » | `nav:cards-order` `nav:mobile-journal` `nav:flags-031` | 0.31.0 |
| 2026-10-02 | « la fenêtre des musiciens En cours est trop petite… on peut sans doute enlever la fenêtre des musiciens filtrés en cours » | `nav:rail` `nav:rail-no-running` `nav:cards-order` | 0.32.0 |
| 2026-10-03 | « les messages longs sont tronqués, je ne peux pas tout lire. Faire un plié / déplié ? » | `suite:_test_activity_journal.mjs` `nav:journal-fold` `nav:mobile-journal` | 0.33.0 |
| 2026-10-04 | « donne la possibilité d'augmenter ou diminuer la taille de la police » | `nav:text-size` `nav:text-size-mobile` | 0.34.0 |
| 2026-10-04 | « implémente une fonction de lecture audio des réponses, déjà du chef » | `suite:_test_tts_text.mjs` `nav:tts` `nav:tts-settings` `nav:tts-mobile` | 0.35.0 |
| 2026-10-04 | « que ce soit pour le chef ou pour les musiciens, à partir du moment où je fais une demande spécifique à propos d'une fonctionnalité, il faut rajouter un test de non-régression pour plus tard » | `suite:_test_user_requirements.mjs` `suite:_test_pool_chef_dispatch.mjs` | 0.36.0 |
| 2026-10-05 | « Même après l'avoir ajouté, je continue à avoir une demande d'autorisation PowerShell pour [projet]. Vérifie, et fais en sorte que les demandes d'autorisations s'en aillent après validation. » | `suite:_test_permission_denial.mjs` `http:denials-ack` `nav:denial-ack` `nav:denial-true` `suite:_test_pool_chef_dispatch.mjs` | 0.37.0 |
| 2026-10-05 | Panneau affiché : « 🚫 PowerShell refusé au dernier tour : Get-Content README.md,CHANGELOG.md,TODO_LIST.md,package.json,… — + Ajouter PowerShell à ses outils » (bouton trompeur : PowerShell est déjà accordé, c'est la commande à liste de fichiers que le CLI refuse) | `suite:_test_permission_denial.mjs` `nav:denial-ack` | 0.37.1 |
| 2026-10-05 | « Bash refusé pendant ce tour : RESUME="…" … c'est cet appel précis que le CLI a refusé » et les « erreur 500 » de notify.mjs sur les résumés longs : le musicien écrit son résumé dans un fichier puis lance « notify.mjs chef --file <chemin> » ; un résumé long (15–20 Ko, markdown, accents, tableaux) passe du premier coup | `suite:_test_user_requirements.mjs` `http:notify-long` | 0.37.2 |
| 2026-10-05 | « [projet] était un projet mis de côté, maintenant qu'il est actif il n'est quand même pas revenu dans la liste principale. Ce concept de mis de côté n'a plus d'intérêt. Fais une étude du code, et supprime le concept. Fais attention à ne rien supprimer d'autre » | `suite:_test_projects_view.mjs` `http:no-parked` `nav:groups` `nav:cards-order` | 0.38.0 |
| 2026-10-08 | « Commences par me faire une interface accessible a partir de l'orchestrateur, ou tu feras quelque chose de visualement clair pour representer l'evolution des taches les unes apres les autres, et sur chacune de ces taches, je pourrais y assigner un model, en menu deroulant, a partir de anthropic, openai, nvidia et openrouter (je ne sais plus si je t'ai donne la clef) » | `suite:_test_model_routing.mjs` `http:model-routing` `nav:models-view` `nav:models-mobile` | 0.39.0 |
| 2026-10-08 | « Oui, tous les pipeline. Fais en sorte que l'interface soit claire, et que l'on puisse bien comprendre les differents cas, et assigner clairement un model a chacune des taches. » (remplace la structure en 6 étapes de la 0.39.0 par des pipelines en onglets, boucles et retours dessinés ; décision de l'utilisateur) | `suite:_test_model_routing.mjs` `http:model-routing` `nav:models-view` `nav:models-mobile` | 0.40.0 |
| 2026-10-08 | « On peut aussi rajouter du travail sur images ? Videos ? Sons ? » (pipelines Images, Vidéo, Audio ; models spécialisés détectés dans les catalogues ; outils locaux réellement installés ; model incompatible jamais proposé) | `suite:_test_model_routing.mjs` `http:model-routing` `nav:models-view` | 0.40.0 |
| 2026-10-08 | « Il faut que toute entree dans l'orchestrateur passe par les pipelines decides dans la page Models, est-ce deja le cas ? Pour que chaque etape soit effectivement encadree par le bon modele. » — phase 1 : chaque entrée est classée et journalisée, sans changement de comportement | `suite:_test_pipeline_observe.mjs` `http:pipeline-observe` `nav:observe-view` | 0.41.0 |
| 2026-10-08 | « Le terminal interactif peut aussi bien etre une discussion qu'une instruction pour un developpement. Il faut que ca passe dans le routeur aussi. Si aucune classification possible, alors consideres une discussion » | `suite:_test_pipeline_observe.mjs` | 0.41.0 |
| 2026-10-08 | « tous les models doivent pouvoir agir de maniere identique. Nvidia et openrouter aussi doivent pouvoir avoir un outillage » (en attendant l'outillage : gardés dans la page Models, marqués « outillage en construction », refusés sur une étape d'action) | `suite:_test_model_routing.mjs` `http:model-routing` `nav:models-harness` | 0.41.0 |
| 2026-10-08 | « La reponse a ta question de classification : ok. » — quand la classification hésite entre léger et complet pour du développement, mode LÉGER (bascule en complet si la demande grossit) | `suite:_test_pipeline_gaps.mjs` | 0.42.0 |
| 2026-10-08 | « si il manque des taches, ou une etape ne peut pas etre classee en une tache precise, il faut remonter l'information en proposant une solution » | `suite:_test_pipeline_gaps.mjs` `http:pipeline-gaps` `nav:gaps-view` | 0.42.0 |
| 2026-10-08 | « Utilises la meme clef, et prevois dans la page Models, un endroit pour entrer les clefs de nvidia et de openrouter. » | `suite:_test_api_keys.mjs` `http:api-keys` `nav:api-keys-view` | 0.43.0 |
| 2026-10-08 | « On va introduire une nouvelle notion pour chaque tache : on peut donner 2 models (1 par defaut), et si 2 sont precises, on lance la tache sur les 2, puis le 1er relis le tout pour en tirer le meilleur des 2. Adaptes le code et la page Models dans ce sens. » | `suite:_test_dual_model.mjs` `suite:_test_model_routing.mjs` `http:model-routing` `nav:models-dual` | 0.44.0 |
| 2026-10-08 | « Il faut revoir la boite de dialogue de demande d'autorisation . Je n'ai pas vu de moyen d'autoriser(1 fois, pour toujours). Il faut d'ailleur que je puisse avoir plus de details sur l'operation en question. En clickant dessus je dois voir un overlay avec tous les details. Il faut donc attendre ma reponse pendant au moins 5 minutes avant de passer. » | `suite:_test_permission_prompt.mjs` `http:permission-prompt` `nav:permission-card` `nav:permission-deny` `nav:permission-mobile` | 0.45.0 |
| 2026-10-08 | « Continue » — réponse à la proposition du chef : appliquer à la page Models la recommandation consolidée de l'étude comparative des models, EN SUGGESTIONS, sans toucher à ses choix (ajout de claude-haiku-5-5, retrait de gpt-reserve et gpt-5.5, models dominés marqués, gpt-6.1-sol / gpt-6-luna annoncés, « Appliquer » par étape et « étapes vides seulement ») | `suite:_test_model_reco.mjs` `http:model-reco` `nav:models-reco` `nav:models-reco-mobile` | 0.46.0 |
