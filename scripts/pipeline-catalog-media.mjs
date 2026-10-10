// ============================================================================
// scripts/pipeline-catalog-media.mjs — Images, Vidéo, Audio (pipelines phase 6,
// lot C, 0.55.0). Merged into the catalog by pipeline-catalog.mjs.
// ============================================================================
//
// Media steps are turns of the model of their slot (an agent that can call the
// local tools); a slot assigned to a LOCAL TOOL (ffmpeg, whisper, tesseract…)
// is announced to the step as the tool to use. Every output is checked by code
// (scripts/media-check.mjs): listed in « ## Fichiers », inside the project or
// the run folder, right signature, image dimensions, and — when ffprobe is
// installed — a real decode with a duration and the expected stream.
//
// variants: { id: description } — the step's slot variant is chosen by the
//   MEANING of the request, by the classifier model (0.66.0, never by keyword
//   regexes); `media` may depend on it (OCR and captions produce text).
// media: { kind, min, optionalWith } — optionalWith: marker that waives the
//   media requirement (e.g. an analysis-only request needs no montage).
// ============================================================================

const VERIFY_JSON = '{"verdict": "ok|problemes", "items": ["défaut constaté 1"]}';

export const MEDIA_PIPELINES = {
  images: {
    needs: { git: true, clean: true },
    final: 'verifier',
    media: true,
    steps: [
      { id: 'cadrer', title: '1 Cadrer le besoin', chain: ['images.cadrer'], group: 'media', artefact: 'cadrage.md', kind: 'judge',
        role: 'CADRER le besoin image : ce qui est attendu (génération, retouche, texte à extraire, légende, vignettes), formats, dimensions, emplacement des fichiers.',
        checks: { sections: ['Besoin', 'Livrables'] } },
      { id: 'produire', title: '2 Produire', chain: ['images.produire'], group: 'media-prod', artefact: 'production.md', kind: 'action',
        variants: { ocr: 'extraire le texte présent dans une image (OCR)', legende: 'décrire ou légender une image', vignettes: 'produire des vignettes ou miniatures', retouche: 'retoucher une image existante (recadrer, redimensionner, détourer, corriger)', generation: 'générer une image nouvelle' },
        mediaByVariant: { ocr: 'text', legende: 'text' },
        role: 'PRODUIRE les images demandées (ou, pour l’OCR et la légende, le texte tiré des images), avec les outils disponibles. Range les fichiers dans le projet (ou dans le dossier d’artefacts si ce ne sont pas des livrables du projet).',
        checks: { media: { kind: 'image', min: 1 } } },
      { id: 'verifier', title: '3 Vérifier visuellement', chain: ['images.verifier'], group: 'media-verif', artefact: 'verification.json', kind: 'judge', vision: true,
        role: 'VÉRIFIER VISUELLEMENT chaque fichier produit (ouvre-le avec l’outil Read) : conforme au cadrage, lisible, sans artefact ni texte erroné.',
        checks: { json: { verdict: 'string', items: 'array' }, jsonEnum: { verdict: ['ok', 'problemes'] } }, jsonExample: VERIFY_JSON,
        loop: { field: 'items', back: ['produire', 'verifier'] } },
      { id: 'livrer', title: '4 Livrer', chain: ['images.livrer', 'dev.livrer'], group: 'code', artefact: 'livraison.md', kind: 'deliver', ifChanged: true, version: false,
        role: 'LIVRER : un SEUL commit des fichiers produits dans le projet (git add -A puis git commit). Pas de push.' },
    ],
  },
  video: {
    needs: { git: true, clean: true },
    final: 'verifier',
    media: true,
    steps: [
      { id: 'acquerir', title: '1 Acquérir', chain: ['video.acquerir'], group: 'media', artefact: 'acquisition.md', kind: 'action',
        role: 'ACQUÉRIR la vidéo source (fichier fourni, téléchargement autorisé, capture) dans le projet ou le dossier d’artefacts, et indique sa provenance.',
        checks: { media: { kind: 'video', min: 1 } } },
      { id: 'analyser', title: '2 Transcrire / analyser', chain: ['video.analyser'], group: 'media-prod', artefact: 'analyse.md', kind: 'action',
        variants: { scenes: 'découper une vidéo en scènes ou en plans', resume: 'résumer le contenu d’une vidéo', transcription: 'transcrire ce qui est dit dans une vidéo' },
        role: 'ANALYSER la vidéo : transcription horodatée, découpage en scènes ou résumé selon la demande. Écris le résultat dans un fichier texte (.srt, .vtt, .txt ou .md) listé dans « ## Fichiers ».',
        checks: { media: { kind: 'text', min: 1 } } },
      { id: 'monter', title: '3 Monter', chain: ['video.monter'], group: 'media-prod', artefact: 'montage.md', kind: 'action',
        variants: { 'sous-titres': 'produire des sous-titres', chapitres: 'découper en chapitres', decoupe: 'monter ou découper la vidéo elle-même' },
        role: 'MONTER : découpe, chapitres ou incrustation des sous-titres, selon la demande. Si la demande ne réclame aucun montage (analyse seule), écris « AUCUN_MONTAGE » dans l’artefact.',
        checks: { media: { kind: 'video', min: 1, optionalWith: 'AUCUN_MONTAGE' } } },
      { id: 'verifier', title: '4 Vérifier', chain: ['video.verifier'], group: 'media-verif', artefact: 'verification.json', kind: 'judge',
        role: 'VÉRIFIER le résultat : l’orchestrateur a contrôlé les fichiers (durée, pistes) ; vérifie le contenu (synchronisation, coupes, lisibilité des sous-titres) à partir des fichiers produits.',
        checks: { json: { verdict: 'string', items: 'array' }, jsonEnum: { verdict: ['ok', 'problemes'] } }, jsonExample: VERIFY_JSON,
        loop: { field: 'items', back: ['monter', 'verifier'] } },
      { id: 'livrer', title: '5 Livrer', chain: ['video.livrer', 'dev.livrer'], group: 'code', artefact: 'livraison.md', kind: 'deliver', ifChanged: true, version: false,
        role: 'LIVRER : un SEUL commit des fichiers produits dans le projet. Pas de push.' },
    ],
  },
  audio: {
    needs: { git: true, clean: true },
    final: 'verifier',
    media: true,
    steps: [
      { id: 'acquerir', title: '1 Acquérir', chain: ['audio.acquerir'], group: 'media', artefact: 'acquisition.md', kind: 'action',
        role: 'ACQUÉRIR l’enregistrement source (fichier fourni, capture) — ou, pour une synthèse vocale, le texte à dire, dans un fichier listé dans « ## Fichiers ».',
        variants: { tts: 'synthèse vocale : faire dire un texte par une voix', source: 'travailler à partir d’un enregistrement audio existant' },
        mediaByVariant: { tts: 'text' },
        checks: { media: { kind: 'audio', min: 1 } } },
      { id: 'traiter', title: '2 Transcrire / synthétiser / traiter', chain: ['audio.traiter'], group: 'media-prod', artefact: 'traitement.md', kind: 'action',
        variants: { tts: 'synthèse vocale : faire dire un texte par une voix', traitement: 'traiter un son existant (nettoyer, réduire le bruit, normaliser, séparer, couper les silences)', stt: 'transcrire de la parole en texte' },
        mediaByVariant: { stt: 'text' },
        role: 'TRAITER : transcription (texte), synthèse vocale (audio) ou nettoyage (audio), selon la demande, avec les outils disponibles. Liste les fichiers produits dans « ## Fichiers ».',
        checks: { media: { kind: 'audio', min: 1 }, wer: true } },
      { id: 'verifier', title: '3 Vérifier', chain: ['audio.verifier'], group: 'media-verif', artefact: 'verification.json', kind: 'judge',
        role: 'VÉRIFIER le résultat : l’orchestrateur a contrôlé les fichiers (et le taux d’erreur si une transcription de référence existait) ; vérifie le contenu (texte fidèle, voix intelligible, son propre).',
        checks: { json: { verdict: 'string', items: 'array' }, jsonEnum: { verdict: ['ok', 'problemes'] } }, jsonExample: VERIFY_JSON,
        loop: { field: 'items', back: ['traiter', 'verifier'] } },
      { id: 'livrer', title: '4 Livrer', chain: ['audio.livrer', 'dev.livrer'], group: 'code', artefact: 'livraison.md', kind: 'deliver', ifChanged: true, version: false,
        role: 'LIVRER : un SEUL commit des fichiers produits dans le projet. Pas de push.' },
    ],
  },
};
