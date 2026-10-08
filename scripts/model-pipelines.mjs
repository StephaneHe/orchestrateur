// ============================================================================
// scripts/model-pipelines.mjs — les pipelines de la vue « Models par tâche »
// ============================================================================
//
// Données pures (0.40.0) : 13 pipelines, chacun une suite d'étapes dans
// l'ordre, avec ses boucles et ses retours. Une étape (ou une variante) est
// une « case » à laquelle on assigne un model.
//
// Le dépôt est public : les exemples décrivent le fleet SANS nommer les projets
// privés (l'orchestrateur lui-même est public et sert d'exemple à volonté).
//
// `need` = ce que l'étape exige :
//   llm   : 'text' | 'vision' | 'image-gen' | 'audio-in' | 'audio-out' |
//           'video-in' | null (aucun LLM ne convient seul)
//   local : capacités d'outil local acceptées (voir LOCAL_TOOLS)
// Une variante sans `need` hérite de celui de son étape.
// ============================================================================

export const CAPS = {
  text:        'texte / code (agent avec outils)',
  vision:      'lecture d’images (vision)',
  'image-gen': 'génération d’images',
  'audio-in':  'écoute / transcription (audio en entrée)',
  'audio-out': 'synthèse vocale (audio en sortie)',
  'video-in':  'lecture de vidéo',
};

// Outils locaux connus. `bin` = exécutable cherché dans le PATH, `py` = module
// Python, `always` = intégré (navigateur, Windows). Seuls les outils réellement
// présents sont sélectionnables.
export const LOCAL_TOOLS = [
  { id: 'ffmpeg',         label: 'ffmpeg',                     bin: 'ffmpeg',      caps: ['video-edit', 'audio-proc', 'capture', 'thumbnails', 'scene-detect', 'subtitles'] },
  { id: 'ffprobe',        label: 'ffprobe',                    bin: 'ffprobe',     caps: ['media-check'] },
  { id: 'yt-dlp',         label: 'yt-dlp',                     bin: 'yt-dlp',      caps: ['acquire'] },
  { id: 'whisper',        label: 'Whisper local (openai-whisper)', bin: 'whisper', caps: ['stt', 'subtitles'] },
  { id: 'faster-whisper', label: 'faster-whisper',             py: 'faster_whisper', caps: ['stt', 'subtitles'] },
  { id: 'whisper-cpp',    label: 'whisper.cpp',                bin: 'whisper-cli', caps: ['stt', 'subtitles'] },
  { id: 'tesseract',      label: 'Tesseract (OCR)',            bin: 'tesseract',   caps: ['ocr'] },
  { id: 'pillow',         label: 'Pillow (Python)',            py: 'PIL',          caps: ['image-proc', 'thumbnails'] },
  { id: 'opencv',         label: 'OpenCV (Python)',            py: 'cv2',          caps: ['image-proc', 'thumbnails', 'scene-detect'] },
  { id: 'imagemagick',    label: 'ImageMagick',                bin: 'magick',      caps: ['image-proc', 'thumbnails'] },
  { id: 'piper',          label: 'Piper (TTS local)',          bin: 'piper',       caps: ['tts'] },
  { id: 'espeak-ng',      label: 'eSpeak NG',                  bin: 'espeak-ng',   caps: ['tts'] },
  { id: 'web-speech',     label: 'Synthèse vocale du navigateur (Web Speech, celle du dashboard)', always: true, caps: ['tts'] },
  { id: 'windows-sapi',   label: 'Windows SAPI (System.Speech)', always: 'win32', caps: ['tts'] },
  { id: 'sox',            label: 'SoX',                        bin: 'sox',         caps: ['audio-proc'] },
  { id: 'demucs',         label: 'Demucs (séparation de sources)', bin: 'demucs',  caps: ['audio-sep'] },
  { id: 'jiwer',          label: 'jiwer (calcul du WER)',      py: 'jiwer',        caps: ['wer'] },
];

const T = { llm: 'text', local: [] };

export const PIPELINES = [
  // ── 1. Développement ──────────────────────────────────────────────────────
  {
    id: 'dev', label: 'Développement', icon: '⚙',
    purpose: 'Écrire ou corriger du code par le TDD canonique de Kent Beck : une liste de tests, puis un test à la fois, rouge → vert → refactor.',
    when: 'Toute modification de code d’un projet : nouvelle fonctionnalité, correction de bug, évolution.',
    source: { label: 'Canon TDD — Kent Beck', url: 'https://newsletter.kentbeck.com/p/canon-tdd' },
    variantsInfo: [
      { label: 'Bugfix', text: 'l’étape 4a commence par un test qui reproduit le bug (il doit échouer pour la bonne raison).' },
      { label: 'Spike', text: 'exploration jetable hors TDD quand on ne sait pas encore comment faire ; on jette le code et on revient à l’étape 3.' },
    ],
    advice: [
      'Conseil : faire écrire la liste de tests (3) et les tests (4a) par un model différent de celui qui écrit le code (4b) — la preuve reste indépendante.',
    ],
    flow: [
      { id: 'comprendre', n: '1', title: 'Comprendre', what: 'Lire le code existant et les logs avant de toucher à quoi que ce soit.',
        example: 'Lire server.js et les logs d’un musicien pour comprendre pourquoi une demande d’autorisation revenait.',
        variants: [
          { id: 'codebase', label: 'Étude de codebase', what: 'Cartographier modules, conventions, points d’entrée.' },
          { id: 'logs', label: 'Analyse de logs / crash', what: 'Lire traces et journaux pour trouver la cause.' },
        ] },
      { id: 'concevoir', n: '2', title: 'Concevoir', what: 'Choisir la structure et découper le travail en étapes vérifiables.',
        example: 'Décider de mettre les choix de models dans un fichier dédié plutôt que dans config.json, partagé par plusieurs chefs.',
        variants: [
          { id: 'architecture', label: 'Architecture / conception', what: 'Modules, compromis, contrats entre composants.' },
          { id: 'plan', label: 'Plan d’implémentation', what: 'Étapes ordonnées, livrables, critères de réussite.' },
        ] },
      { id: 'spike', n: 'S', title: 'Spike (exploration jetable)', optional: 'conditionnel',
        what: 'Seulement si l’on ne sait pas encore comment faire : un essai rapide, hors TDD, puis on le jette.',
        example: 'Vérifier en cinq minutes qu’un endpoint public liste bien les models sans clé avant de concevoir le catalogue.',
        returns: [{ to: 'liste-tests', label: 'on jette l’essai, retour à 3' }] },
      { id: 'liste-tests', n: '3', title: 'Liste de tests',
        what: 'Écrire les comportements attendus et les critères d’acceptation, sans aucune décision d’implémentation.',
        example: '« la vue montre 13 onglets », « un choix est relu après rechargement », « OpenRouter est grisé sans clé ».',
        advice: 'Conseil : un model différent de celui de 4b.' },
      { kind: 'loop', id: 'tdd', n: '4', title: 'Boucle TDD — un test à la fois',
        what: 'On prend UN item de la liste et on fait le cycle complet ; on recommence tant que la liste n’est pas vide.',
        back: { from: 'refactor', to: 'rouge', label: 'test suivant tant que la liste n’est pas vide' },
        steps: [
          { id: 'rouge', n: '4a', title: 'Rouge', what: 'Écrire UN test et vérifier qu’il échoue, pour la bonne raison.',
            example: 'Un parcours navigateur qui attend 13 onglets alors que la vue n’en a que 6 → il échoue.',
            advice: 'Conseil : un model différent de celui de 4b (indépendance de la preuve).',
            variants: [
              { id: 'comportement', label: 'Nouveau comportement', what: 'Le test décrit ce qui doit exister.' },
              { id: 'bugfix', label: 'Bugfix : reproduire le bug', what: 'Le test reproduit le bug signalé avant toute correction.' },
            ] },
          { id: 'vert', n: '4b', title: 'Vert', what: 'Écrire le code minimal qui fait passer ce test ET tous les autres.',
            example: 'Ajouter juste ce qu’il faut à models.js pour afficher les onglets.',
            variants: [
              { id: 'simple', label: 'Feature simple', what: 'Ajout localisé, bien délimité.' },
              { id: 'complexe', label: 'Feature complexe', what: 'Plusieurs modules ou un algorithme délicat.' },
              { id: 'mecanique', label: 'Edits mécaniques', what: 'Renommages, remplacements en série.' },
              { id: 'refactoring', label: 'Refactoring', what: 'Restructurer sans changer le comportement.' },
              { id: 'migration', label: 'Migration', what: 'Changer de version, de bibliothèque ou de format.' },
            ] },
          { id: 'refactor', n: '4c', title: 'Refactor', optional: 'optionnel',
            what: 'Nettoyer le code maintenant que les tests protègent, sans changer le comportement.',
            example: 'Factoriser la construction des menus déroulants une fois les tests verts.' },
        ] },
      { id: 'revue', n: '5', title: 'Revue', what: 'Relire le changement : défauts, sécurité, second avis.',
        example: 'Relire la route PUT /api/model-routing : validation des entrées, aucune clé exposée.',
        returns: [{ to: 'tdd', label: 'problème trouvé → nouvel item dans la liste → retour à 4' }],
        variants: [
          { id: 'code', label: 'Revue de code', what: 'Défauts, lisibilité, cohérence.' },
          { id: 'securite', label: 'Revue sécurité', what: 'Injection, secrets, droits.' },
          { id: 'second-avis', label: 'Second avis / contradiction', what: 'Un autre model conteste les conclusions.' },
        ] },
      { id: 'livrer', n: '6', title: 'Livrer', what: 'Commit, build, déploiement et vérification sur l’appareil ou de bout en bout.',
        example: 'Commit, tag, push, puis copy-build.mjs pour publier l’APK de l’app compagnon.',
        variants: [
          { id: 'git', label: 'Opérations git', what: 'Commits, tags, branches, conflits.' },
          { id: 'build', label: 'Build / déploiement', what: 'Compiler, publier, déployer.' },
          { id: 'device', label: 'Vérif device / E2E', what: 'Téléphone, navigateur, parcours de bout en bout.' },
        ] },
      { id: 'documenter', n: '7', title: 'Documenter', what: 'Mettre à jour la doc, le CHANGELOG, et rendre compte.',
        example: 'Entrée CHANGELOG, section de CLAUDE.md, résumé au chef par notify.mjs --file.',
        variants: [
          { id: 'docs', label: 'Documentation technique', what: 'README, guides, CLAUDE.md.' },
          { id: 'changelog', label: 'CHANGELOG', what: 'Entrée Keep a Changelog de la version.' },
          { id: 'rapport', label: 'Rapport / synthèse', what: 'Résumé pour décider.' },
        ] },
    ],
  },

  // ── 2. Discussion ─────────────────────────────────────────────────────────
  {
    id: 'discussion', label: 'Discussion', icon: '💬',
    purpose: 'Répondre à une question, réfléchir, conseiller — sans rien modifier.',
    when: 'Une question ou une réflexion qui n’appelle pas (encore) de modification : « pourquoi… ? », « que ferais-tu ? ».',
    flow: [
      { id: 'comprendre', n: '1', title: 'Comprendre la question', what: 'Reformuler la question et ce qui est réellement attendu.',
        example: '« mode discussion » n’était pas défini : lister les interprétations possibles.' },
      { id: 'rechercher', n: '2', title: 'Rechercher', what: 'Lire le code, les docs ou le web — en lecture seule.',
        example: 'Lire l’aide de la CLI claude pour vérifier qu’un drapeau existe.' },
      { id: 'repondre', n: '3', title: 'Répondre', what: 'Une réponse directe, argumentée, avec une recommandation.',
        example: 'Le plan du mode discussion : interprétations, recommandation, questions.' },
      { id: 'tache', n: '4', title: 'Transformer en tâche', optional: 'sur confirmation',
        what: 'Seulement si l’utilisateur le confirme : la discussion devient une tâche.',
        example: 'Le plan validé devient une demande de développement confiée au chef.',
        ref: { pipeline: 'routage', label: 'passe au pipeline Routage (le chef dispatche)' } },
    ],
  },

  // ── 3. Routage ────────────────────────────────────────────────────────────
  {
    id: 'routage', label: 'Routage (chef)', icon: '♛',
    purpose: 'Ce que fait le chef : comprendre une demande, la découper, choisir qui la fait et avec quel model, suivre, rendre compte.',
    when: 'Toute demande adressée au chef.',
    flow: [
      { id: 'lire', n: '1', title: 'Lire la demande', what: 'Comprendre ce que veut l’utilisateur et pour quel projet.',
        example: '« ajoute du travail sur images, vidéos, sons » → trois pipelines de plus.' },
      { id: 'classifier', n: '2', title: 'Classifier', what: 'Choisir le pipeline concerné (développement, incident, recherche…).',
        example: 'Une demande d’interface → pipeline Développement.' },
      { id: 'decomposer', n: '3', title: 'Décomposer en tâches', what: 'Découper en tâches confiables à un musicien chacune.',
        example: 'Interface + tests + doc pour l’orchestrateur, une seule tâche.' },
      { id: 'affecter', n: '4', title: 'Affecter un model', what: 'Choisir le model de chaque tâche — c’est le rôle de ce tableau.',
        example: 'Opus pour concevoir, Sonnet pour coder, un autre model pour le second avis.' },
      { id: 'dispatcher', n: '5', title: 'Dispatcher', what: 'Lancer le tour du musicien (dispatch.mjs), avec callback.',
        example: 'dispatch.mjs orchestrateur --callback chef.' },
      { id: 'superviser', n: '6', title: 'Superviser', what: 'Suivre les tours, débloquer une question, arrêter un tour bloqué.',
        example: 'fleet-status, puis kill-stalled après avoir demandé un état d’avancement.',
        returns: [{ to: 'dispatcher', label: 'relance ou réponse à une question → nouveau dispatch' }] },
      { id: 'callback', n: '7', title: 'Callback', what: 'Recevoir le résumé du musicien en fin de tour.',
        example: 'Le résumé arrive par notify.mjs --file et réveille le chef.' },
      { id: 'rapporter', n: '8', title: 'Rapporter', what: 'Synthèse claire pour l’utilisateur, projet nommé.',
        example: '« orchestrateur v0.40.0 : 13 onglets, tests verts, redémarrage nécessaire ».' },
    ],
  },

  // ── 4. Incident ───────────────────────────────────────────────────────────
  {
    id: 'incident', label: 'Incident', icon: '🚨',
    purpose: 'Réagir à une panne ou à un comportement anormal : limiter les dégâts d’abord, comprendre ensuite, corriger, puis en tirer la leçon.',
    when: 'Quelque chose casse en usage réel : serveur qui tombe, build cassé, données abîmées.',
    flow: [
      { id: 'detecter', n: '1', title: 'Détecter', what: 'Remarquer le problème : alerte, symptôme, signalement.',
        example: 'Le dashboard affiche « processus perdu » pour un musicien.' },
      { id: 'evaluer', n: '2', title: 'Évaluer l’impact', what: 'Qui est touché, depuis quand, quelle urgence.',
        example: 'Un seul musicien ou toute la flotte ? Le serveur répond-il encore ?' },
      { id: 'contenir', n: '3', title: 'Contenir', what: 'Arrêter les dégâts : arrêt d’un tour, retour arrière par tag.',
        example: 'git revert jusqu’au tag pre-… puis redémarrage par le chef.' },
      { id: 'diagnostiquer', n: '4', title: 'Diagnostiquer', what: 'Trouver la cause réelle.',
        example: 'Le « crash » serveur était un watchdog qui tuait un serveur seulement lent.',
        variants: [
          { id: 'simple', label: 'Debug simple', what: 'Reproductible, cause probable évidente.' },
          { id: 'difficile', label: 'Debug difficile', what: 'Intermittent, concurrence, cause inconnue.' },
        ] },
      { id: 'corriger', n: '5', title: 'Corriger', what: 'La correction suit le pipeline Développement, variante Bugfix.',
        example: 'Test qui reproduit la limite de 2 Ko de notify, puis correction.',
        ref: { pipeline: 'dev', label: 'utilise le pipeline Développement (variante Bugfix)' } },
      { id: 'post-mortem', n: '6', title: 'Post-mortem', what: 'Écrire ce qui s’est passé et ce qui empêchera la récidive.',
        example: 'Section CLAUDE.md « faux crash serveur = watchdog tueur ».' },
    ],
  },

  // ── 5. Recherche ──────────────────────────────────────────────────────────
  {
    id: 'recherche', label: 'Recherche', icon: '🔎',
    purpose: 'Faire l’état de l’art d’un sujet, sources à l’appui.',
    when: 'Choisir une technologie, comparer des solutions, comprendre un domaine.',
    flow: [
      { id: 'cadrer', n: '1', title: 'Cadrer', what: 'La question précise, les critères, ce qui est hors sujet.',
        example: '« Quels models exposent de la génération d’image sans clé payante ? »' },
      { id: 'rechercher', n: '2', title: 'Rechercher (web)', what: 'Trouver les sources : docs officielles, articles, catalogues.',
        example: 'Interroger les catalogues publics NVIDIA et OpenRouter.' },
      { id: 'lire', n: '3', title: 'Lire en profondeur', what: 'Lire réellement les sources retenues, pas seulement les titres.',
        example: 'Lire l’article Canon TDD de Kent Beck en entier.' },
      { id: 'recouper', n: '4', title: 'Recouper les sources', what: 'Confronter les sources ; écarter ce qui n’est pas confirmé.',
        returns: [{ to: 'rechercher', label: 'contradiction ou trou → nouvelle recherche' }],
        example: 'Un model listé mais absent du catalogue réel est signalé, pas supposé.' },
      { id: 'synthetiser', n: '5', title: 'Synthétiser', what: 'Une synthèse qui permet de décider, avec les sources.',
        example: 'Tableau comparatif avec recommandation et liens.' },
    ],
  },

  // ── 6. Audit sécurité ─────────────────────────────────────────────────────
  {
    id: 'audit', label: 'Audit sécurité', icon: '🛡',
    purpose: 'Chercher les failles d’un projet de façon méthodique, avec un second regard indépendant.',
    when: 'Avant de rendre un dépôt public, après un changement sensible, périodiquement.',
    advice: ['Conseil : le second avis par une autre famille de model que la revue manuelle (Claude ↔ GPT ↔ autre) — elle ne partage pas les mêmes angles morts.'],
    flow: [
      { id: 'cartographier', n: '1', title: 'Cartographier', what: 'Surface d’attaque : routes, entrées, secrets, droits.',
        example: 'Lister les routes HTTP de server.js et le token gate.' },
      { id: 'scans', n: '2', title: 'Scans automatisés', what: 'Secrets, dépendances vulnérables, fichiers sensibles suivis.',
        example: 'gitleaks et _test_repo_hygiene avant de publier le dépôt.' },
      { id: 'revue-manuelle', n: '3', title: 'Revue manuelle', what: 'Lire le code sensible : injection, validation, chemins.',
        example: 'Vérifier qu’un identifiant de model ne peut pas sortir du fichier visé (../).' },
      { id: 'second-avis', n: '4', title: 'Second avis indépendant', what: 'Un autre model refait la revue sans voir les conclusions.',
        example: 'Une revue par GPT après une revue par Claude.',
        advice: 'Conseil : une autre famille de model que l’étape 3.' },
      { id: 'corriger', n: '5', title: 'Corriger', what: 'Corriger chaque faille confirmée.',
        example: 'Valider l’entrée côté serveur et ajouter le test qui le prouve.' },
      { id: 'reverifier', n: '6', title: 'Re-vérifier', what: 'Rejouer scans et revue sur la correction.',
        returns: [{ to: 'corriger', label: 'faille encore présente → retour à 5' }],
        example: 'Relancer gitleaks et les tests après correction.' },
    ],
  },

  // ── 7. Maintenance ────────────────────────────────────────────────────────
  {
    id: 'maintenance', label: 'Maintenance', icon: '🧹',
    purpose: 'Garder les projets sains sans ajouter de fonctionnalité.',
    when: 'Entretien périodique, ou quand la dette ralentit le travail.',
    flow: [
      { id: 'dependances', n: '1', title: 'Mise à jour des dépendances', what: 'Monter les versions, lire les changements cassants, retester.',
        example: 'Monter playwright-core puis rejouer la non-régression.' },
      { id: 'historique', n: '2', title: 'Nettoyage d’historique', what: 'Retirer de git ce qui n’aurait pas dû y être.',
        example: 'filter-repo pour sortir config.json et les captures de l’historique public.' },
      { id: 'tests-instables', n: '3', title: 'Tests instables', what: 'Trouver pourquoi un test échoue parfois et le fiabiliser.',
        example: 'Un parcours navigateur dépendant du défilement automatique.' },
      { id: 'dette', n: '4', title: 'Dette technique', what: 'Rembourser la dette la plus coûteuse en premier.',
        example: 'server.js importe des fichiers non versionnés : les versionner.' },
    ],
  },

  // ── 8. Nouveau projet ─────────────────────────────────────────────────────
  {
    id: 'nouveau', label: 'Nouveau projet', icon: '✚',
    purpose: 'Démarrer un projet prêt à tourner : cadré, avec ses règles de flotte, puis un MVP.',
    when: 'Création d’un nouveau projet dans I:\\Dev.',
    flow: [
      { id: 'cadrage', n: '1', title: 'Cadrage', what: 'But, utilisateurs, périmètre du MVP, contraintes.',
        example: 'Une app Android compagnon : ce qu’elle montre, sur quel téléphone.' },
      { id: 'squelette', n: '2', title: 'Squelette', what: 'Version, CHANGELOG, USER_REQUIREMENTS, suite de tests, droits.',
        example: 'new-project.mjs : modèle copié, settings.json et confiance posés.' },
      { id: 'mvp', n: '3', title: 'MVP', what: 'Le MVP se construit par le pipeline Développement.',
        example: 'Premier écran, premier test, première version 1.0.0.',
        ref: { pipeline: 'dev', label: 'utilise le pipeline Développement' } },
      { id: 'publication', n: '4', title: 'Publication', what: 'Premier build publié, page /downloads, dépôt.',
        example: 'copy-build.mjs puis une entrée dans downloads.json.' },
    ],
  },

  // ── 9. Données / scraping ─────────────────────────────────────────────────
  {
    id: 'donnees', label: 'Données', icon: '🗃',
    purpose: 'Récupérer des données, les rendre propres et exploitables, puis les montrer.',
    when: 'Scraping, import, surveillance automatisée de sources, constitution d’un jeu de données.',
    flow: [
      { id: 'collecter', n: '1', title: 'Collecter', what: 'Récupérer les données accessibles (API, pages publiques, fichiers).',
        example: 'Lire la liste publique des models OpenRouter.' },
      { id: 'nettoyer', n: '2', title: 'Nettoyer', what: 'Filtrer, dédoublonner, normaliser.',
        example: 'Écarter les models d’embeddings et de filtrage de la liste NVIDIA.' },
      { id: 'stocker', n: '3', title: 'Stocker', what: 'Un format simple et durable (JSON, JSONL, sidecar).',
        example: 'Cache du catalogue dans logs/model-catalog.cache.json.' },
      { id: 'presenter', n: '4', title: 'Présenter', what: 'Une vue lisible, un rapport, un export.',
        example: 'Les menus déroulants de cette vue.' },
    ],
  },

  // ── 10. Rédaction / traduction ────────────────────────────────────────────
  {
    id: 'redaction', label: 'Rédaction', icon: '✎',
    purpose: 'Écrire ou traduire un texte destiné à être lu : doc, message, article.',
    when: 'README, guide, courriel, traduction, texte d’interface.',
    flow: [
      { id: 'rediger', n: '1', title: 'Rédiger', what: 'Le premier jet, pour le bon lecteur.',
        example: 'Le README public de l’orchestrateur.',
        variants: [
          { id: 'ecriture', label: 'Écriture', what: 'Texte original.' },
          { id: 'traduction', label: 'Traduction', what: 'D’une langue à l’autre, ton conservé.' },
        ] },
      { id: 'relire', n: '2', title: 'Relire', what: 'Exactitude, clarté, ton, fautes.',
        returns: [{ to: 'rediger', label: 'à reprendre → retour à 1' }],
        example: 'Vérifier qu’aucun nom de projet privé ne figure dans le texte public.' },
      { id: 'mettre-en-forme', n: '3', title: 'Mettre en forme', what: 'Titres, listes, tableaux, Markdown propre.',
        example: 'Une entrée CHANGELOG au format Keep a Changelog.' },
    ],
  },

  // ── 11. Images ────────────────────────────────────────────────────────────
  {
    id: 'images', label: 'Images', icon: '🖼',
    purpose: 'Produire, retoucher ou lire des images, avec une vérification visuelle avant livraison.',
    when: 'Icônes, illustrations, captures à analyser, texte à extraire d’une image, vignettes.',
    flow: [
      { id: 'cadrer', n: '1', title: 'Cadrer le besoin', what: 'Ce qu’il faut obtenir : format, taille, style, usage.',
        example: 'Une icône d’app Android en 512 px, fond transparent.' },
      { id: 'produire', n: '2', title: 'Générer / éditer / analyser', what: 'Le cœur du travail ; le bon outil dépend de la variante.',
        example: 'Lire le texte d’une capture d’écran du dashboard.',
        need: { llm: 'vision', local: ['image-proc', 'ocr', 'thumbnails'] },
        variants: [
          { id: 'generation', label: 'Génération', what: 'Créer une image à partir d’une description.', need: { llm: 'image-gen', local: [] } },
          { id: 'retouche', label: 'Retouche', what: 'Modifier une image existante.', need: { llm: 'image-gen', local: ['image-proc'] } },
          { id: 'ocr', label: 'OCR / lecture d’écran', what: 'Extraire le texte d’une image ou d’une capture.', need: { llm: 'vision', local: ['ocr'] } },
          { id: 'legende', label: 'Description / légende', what: 'Décrire une image, texte alternatif.', need: { llm: 'vision', local: [] } },
          { id: 'vignettes', label: 'Vignettes', what: 'Redimensionner, recadrer en série.', need: { llm: null, local: ['thumbnails'] } },
        ] },
      { id: 'verifier', n: '3', title: 'Vérifier visuellement', what: 'Un model vision regarde le résultat et le compare au besoin.',
        example: 'Vérifier que l’icône est lisible en petit et sans artefact.',
        need: { llm: 'vision', local: [] },
        returns: [{ to: 'produire', label: 'refusé → retour à 2' }] },
      { id: 'livrer', n: '4', title: 'Livrer', what: 'Déposer le fichier au bon endroit, au bon format.',
        example: 'Copier l’icône dans les ressources de l’app et rebuild.' },
    ],
  },

  // ── 12. Vidéo ─────────────────────────────────────────────────────────────
  {
    id: 'video', label: 'Vidéo', icon: '🎬',
    purpose: 'Récupérer, analyser et monter des vidéos, puis vérifier le résultat avant de le livrer.',
    when: 'Séances enregistrées, extraits, sous-titres, chapitres, captures.',
    flow: [
      { id: 'acquerir', n: '1', title: 'Acquérir', what: 'Télécharger un contenu accessible ou capturer un flux.',
        example: 'Récupérer l’enregistrement d’une séance en direct publique.',
        need: { llm: 'text', local: ['acquire', 'capture'] } },
      { id: 'analyser', n: '2', title: 'Transcrire / analyser', what: 'Comprendre le contenu : texte parlé, scènes, résumé.',
        example: 'Transcrire une séance pour en faire les chapitres.',
        need: { llm: 'video-in', local: ['stt', 'scene-detect'] },
        variants: [
          { id: 'transcription', label: 'Transcription', what: 'Le texte parlé, horodaté.', need: { llm: 'audio-in', local: ['stt'] } },
          { id: 'scenes', label: 'Détection de scènes', what: 'Repérer les changements de plan.', need: { llm: 'video-in', local: ['scene-detect'] } },
          { id: 'resume', label: 'Résumé', what: 'Résumer la vidéo (à partir de la transcription ou de l’image).', need: { llm: 'text', local: [] } },
        ] },
      { id: 'monter', n: '3', title: 'Monter', what: 'Découper, assembler, chapitrer, sous-titrer (ffmpeg).',
        example: 'Couper le début d’une séance et incruster les sous-titres.',
        need: { llm: 'text', local: ['video-edit', 'subtitles'] },
        variants: [
          { id: 'decoupe', label: 'Découpe / concaténation', what: 'Couper et assembler.', need: { llm: null, local: ['video-edit'] } },
          { id: 'chapitres', label: 'Chapitres', what: 'Titres et horodatages des parties.', need: { llm: 'text', local: [] } },
          { id: 'sous-titres', label: 'Sous-titres', what: 'Fichier SRT/VTT, incrustation.', need: { llm: 'audio-in', local: ['subtitles'] } },
        ] },
      { id: 'verifier', n: '4', title: 'Vérifier', what: 'Lecture, durée, synchronisation son/image/sous-titres.',
        example: 'ffprobe : durée attendue, pistes présentes ; contrôle de la synchro.',
        need: { llm: 'video-in', local: ['media-check'] },
        returns: [{ to: 'monter', label: 'défaut → retour à 3' }] },
      { id: 'livrer', n: '5', title: 'Livrer', what: 'Publier ou déposer la vidéo finale.',
        example: 'Une séance prête à regarder sur l’app TV du fleet.' },
    ],
  },

  // ── 13. Audio ─────────────────────────────────────────────────────────────
  {
    id: 'audio', label: 'Audio', icon: '🔊',
    purpose: 'Transcrire, synthétiser ou traiter du son, avec une vérification à l’écoute.',
    when: 'Réunions à transcrire, voix de synthèse, nettoyage d’un enregistrement.',
    flow: [
      { id: 'acquerir', n: '1', title: 'Acquérir', what: 'Récupérer ou enregistrer le son.',
        example: 'L’enregistrement d’une réunion par l’enregistreur du fleet.',
        need: { llm: 'text', local: ['acquire', 'capture'] } },
      { id: 'traiter', n: '2', title: 'Transcrire / synthétiser / traiter', what: 'Selon le besoin : du son vers le texte, du texte vers le son, ou du son vers un meilleur son.',
        example: 'Transcrire une réunion ; lire à voix haute une réponse du chef.',
        need: { llm: 'audio-in', local: ['stt', 'tts', 'audio-proc'] },
        variants: [
          { id: 'stt', label: 'Transcrire (STT)', what: 'Parole → texte.', need: { llm: 'audio-in', local: ['stt'] } },
          { id: 'tts', label: 'Synthétiser (TTS)', what: 'Texte → parole (ex. lecture audio du dashboard).', need: { llm: 'audio-out', local: ['tts'] } },
          { id: 'traitement', label: 'Traiter', what: 'Nettoyage, séparation des voix, normalisation du volume.', need: { llm: null, local: ['audio-proc', 'audio-sep'] } },
        ] },
      { id: 'verifier', n: '3', title: 'Vérifier', what: 'Écouter ; pour une transcription, mesurer le taux d’erreur (WER).',
        example: 'Comparer une transcription à un passage corrigé à la main.',
        need: { llm: 'audio-in', local: ['wer', 'media-check'] },
        returns: [{ to: 'traiter', label: 'qualité insuffisante → retour à 2' }] },
      { id: 'livrer', n: '4', title: 'Livrer', what: 'Le texte ou le fichier son, au bon endroit.',
        example: 'Le compte rendu de réunion, ou la voix du dashboard réglée.' },
    ],
  },
];

// Ancienne structure (0.39.0, 20 types) → nouvelles cases. Une ancienne
// affectation est recopiée sur chaque case listée.
export const LEGACY_MAP = {
  'architecture':      ['dev.concevoir.architecture'],
  'plan':              ['dev.concevoir.plan'],
  'etude-codebase':    ['dev.comprendre.codebase'],
  'feature-complexe':  ['dev.vert.complexe'],
  'feature-simple':    ['dev.vert.simple'],
  'edits-mecaniques':  ['dev.vert.mecanique'],
  'refactoring':       ['dev.vert.refactoring', 'dev.refactor'],
  'migration':         ['dev.vert.migration'],
  'debug-simple':      ['incident.diagnostiquer.simple'],
  'debug-difficile':   ['incident.diagnostiquer.difficile'],
  'analyse-crash':     ['dev.comprendre.logs', 'incident.diagnostiquer'],
  'tests':             ['dev.rouge'],
  'revue':             ['dev.revue.code'],
  'audit-securite':    ['dev.revue.securite', 'audit.revue-manuelle'],
  'second-avis':       ['dev.revue.second-avis', 'audit.second-avis'],
  'build-deploiement': ['dev.livrer.build'],
  'git':               ['dev.livrer.git'],
  'device-e2e':        ['dev.livrer.device'],
  'documentation':     ['dev.documenter.docs'],
  'synthese':          ['dev.documenter.rapport', 'recherche.synthetiser'],
};

// Étapes de JUGEMENT (0.41.0) : elles travaillent sur un texte fourni (demande,
// artefacts, diff) et rendent du texte — un model sans harnais d'agent peut les
// tenir. Toutes les autres étapes « texte » sont des étapes d'ACTION : lire le
// projet, écrire, exécuter. Décision utilisateur (réponse n° 7) : « tous les
// models doivent pouvoir agir de manière identique » — tant que l'outillage
// NVIDIA / OpenRouter n'existe pas, ils sont limités au jugement.
export const JUDGE_STEPS = new Set([
  'dev.concevoir', 'dev.liste-tests', 'dev.revue',
  'discussion.comprendre', 'discussion.repondre',
  'routage.lire', 'routage.classifier', 'routage.decomposer', 'routage.affecter', 'routage.rapporter',
  'incident.evaluer',
  'recherche.cadrer', 'recherche.recouper', 'recherche.synthetiser',
  'audit.second-avis',
  'redaction.rediger', 'redaction.relire',
  'nouveau.cadrage',
  'images.cadrer',
]);
for (const p of PIPELINES) {
  for (const n of p.flow) {
    for (const s of n.kind === 'loop' ? n.steps : [n]) if (JUDGE_STEPS.has(`${p.id}.${s.id}`)) s.judge = true;
  }
}

/** Toutes les étapes d'un pipeline, boucles aplaties, dans l'ordre. */
export function stepsOf(p) {
  const out = [];
  for (const node of p.flow) {
    if (node.kind === 'loop') for (const s of node.steps) out.push({ ...s, loop: node.id });
    else out.push(node);
  }
  return out;
}

/** Cases assignables : `pipeline.étape` et `pipeline.étape.variante`. Les renvois n'en ont pas. */
export function slotsOf() {
  const slots = [];
  for (const p of PIPELINES) {
    for (const s of stepsOf(p)) {
      if (s.ref) continue;
      const need = s.need || T;
      const judge = !!s.judge;
      slots.push({ id: `${p.id}.${s.id}`, pipeline: p.id, step: s.id, label: `${p.label} · ${s.n} ${s.title}`, need, judge });
      for (const v of s.variants || []) {
        slots.push({ id: `${p.id}.${s.id}.${v.id}`, pipeline: p.id, step: s.id, variant: v.id, label: `${p.label} · ${s.n} ${s.title} · ${v.label}`, need: v.need || need, judge });
      }
    }
  }
  return slots;
}
