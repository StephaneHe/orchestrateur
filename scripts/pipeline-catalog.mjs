// ============================================================================
// scripts/pipeline-catalog.mjs — declarative plans of the pipelines beyond
// Discussion and Development (pipelines phase 6, 0.53.0)
// ============================================================================
//
// Each step is ONE turn on the model of its Models-page slot (`chain`: the
// most precise assigned slot wins). The engine never trusts the model's word:
// every step has exit criteria checked by code (`checks`).
//
// kind:
//   judge    read-only; writes its artefact; the project must not change.
//   action   may modify the project; the test suite must stay green.
//   deliver  one commit (version + CHANGELOG + requirement line when
//            `version: true`; just a clean commit otherwise).
// crit: reuse a Development criterion ('rouge' | 'vert' | 'livrer').
//
// checks (judge):
//   sections   required `##` headings (keywords, accent-insensitive)
//   minSources at least N distinct sources (URLs, or cited files when `files`)
//   citedPaths every path cited between backquotes must exist
//   json       artefact is JSON with these array/string keys
// checks (action):
//   nothing    marker that allows "nothing to do" (no change allowed then)
//   onlyGlobs  changes restricted to these files
//   protectTests  existing test files must not change
//   suiteTwice run the test suite twice (flaky-test step)
//   requireFiles  files that must exist after the step
// loop: { field, back } — the JSON field lists what remains; when non-empty
//   and the round budget allows, the `back` steps are inserted again.
// prerun: 'scans' — the engine runs the project's scanners first and hands
//   their output to the model (it never trusts a reported scan).
// ============================================================================

const DOC_GLOBS = ['**/*.md', 'docs/**', '**/*.txt', '**/*.rst', '**/*.adoc'];

const S = {
  // ── Incident ─────────────────────────────────────────────────────────────
  incident: {
    needs: { git: true, tests: true, clean: true },
    final: 'post-mortem',
    steps: [
      { id: 'detecter', title: '1 Détecter', chain: ['incident.detecter'], group: 'incident', artefact: 'detection.md', kind: 'judge',
        role: 'DÉTECTER : établis les faits — symptômes observés, depuis quand, preuves (logs, sorties, fichiers). Aucune hypothèse de cause à ce stade.',
        checks: { sections: ['Symptômes', 'Preuves'], citedPaths: true } },
      { id: 'evaluer', title: '2 Évaluer l’impact', chain: ['incident.evaluer'], group: 'incident', artefact: 'impact.md', kind: 'judge',
        role: 'ÉVALUER L’IMPACT : qui ou quoi est touché, gravité (critique / majeure / mineure), urgence, données en jeu.',
        checks: { sections: ['Impact', 'Gravité'] } },
      { id: 'contenir', title: '3 Contenir', chain: ['incident.contenir'], group: 'incident', artefact: 'contention.md', kind: 'action',
        role: 'CONTENIR : limite les dégâts tout de suite par la mesure la plus simple et réversible (désactiver, garde-fou), sans chercher encore la vraie correction. Si rien n’est nécessaire, ne modifie rien.',
        checks: { nothing: 'RIEN_A_CONTENIR', protectTests: true } },
      { id: 'diagnostiquer', title: '4 Diagnostiquer', chain: ['incident.diagnostiquer.simple', 'incident.diagnostiquer'], group: 'incident', artefact: 'diagnostic.md', kind: 'judge',
        role: 'DIAGNOSTIQUER : trouve la cause racine, preuves à l’appui (fichier, ligne, sortie). Distingue la cause des symptômes.',
        checks: { sections: ['Cause'], citedPaths: true } },
      { id: 'corriger-rouge', title: '5a Corriger — test qui reproduit', chain: ['incident.corriger', 'dev.rouge.bugfix', 'dev.rouge'], group: 'tests', artefact: 'rouge.md', kind: 'action', crit: 'rouge', devRole: 'rouge' },
      { id: 'corriger-vert', title: '5b Corriger — correction', chain: ['incident.corriger', 'dev.vert'], group: 'code', artefact: 'vert.md', kind: 'action', crit: 'vert', devRole: 'vert' },
      { id: 'post-mortem', title: '6 Post-mortem', chain: ['incident.post-mortem'], group: 'incident', artefact: 'post-mortem.md', kind: 'judge',
        role: 'POST-MORTEM : chronologie, cause racine, ce qui a été corrigé, et les actions pour que cela ne se reproduise pas. Sans recherche de coupable.',
        checks: { sections: ['Chronologie', 'Cause racine', 'Actions'] } },
      { id: 'livrer', title: '7 Livrer', chain: ['dev.livrer.git', 'dev.livrer'], group: 'code', artefact: 'livraison.md', kind: 'deliver', crit: 'livrer', devRole: 'livrer' },
    ],
  },
  // ── Recherche ────────────────────────────────────────────────────────────
  recherche: {
    needs: { git: true },
    final: 'synthetiser',
    steps: [
      { id: 'cadrer', title: '1 Cadrer', chain: ['recherche.cadrer'], group: 'recherche', artefact: 'cadrage.md', kind: 'judge',
        role: 'CADRER : la question précise, le périmètre, et les critères qui départageront les options.',
        checks: { sections: ['Question', 'Critères'] } },
      { id: 'rechercher', title: '2 Rechercher (web)', chain: ['recherche.rechercher'], group: 'recherche', artefact: 'sources.md', kind: 'judge',
        role: 'RECHERCHER : trouve les sources pertinentes (web et documentation), une ligne par source avec son URL et ce qu’elle apporte.',
        checks: { minSources: 3 } },
      { id: 'lire', title: '3 Lire en profondeur', chain: ['recherche.lire'], group: 'recherche', artefact: 'lecture.md', kind: 'judge',
        role: 'LIRE EN PROFONDEUR les meilleures sources : les faits, chiffres et limites de chacune, avec leur URL.',
        checks: { minSources: 2 } },
      { id: 'recouper', title: '4 Recouper les sources', chain: ['recherche.recouper'], group: 'recherche', artefact: 'recoupement.md', kind: 'judge',
        role: 'RECOUPER : ce sur quoi les sources s’accordent, ce sur quoi elles divergent, et la fiabilité de chacune.',
        checks: { sections: ['Convergences', 'Divergences'] } },
      { id: 'synthetiser', title: '5 Synthétiser', chain: ['recherche.synthetiser'], group: 'recherche', artefact: 'synthese.md', kind: 'judge',
        role: 'SYNTHÉTISER pour l’utilisateur : l’état de l’art, la comparaison selon les critères du cadrage, et une recommandation argumentée, sources à l’appui.',
        checks: { sections: ['Recommandation'], minSources: 3 } },
    ],
  },
  // ── Audit sécurité ───────────────────────────────────────────────────────
  audit: {
    needs: { git: true, clean: true },
    final: 'reverifier',
    steps: [
      { id: 'cartographier', title: '1 Cartographier', chain: ['audit.cartographier'], group: 'audit', artefact: 'cartographie.md', kind: 'judge',
        role: 'CARTOGRAPHIER la surface d’attaque : points d’entrée (routes, CLI, fichiers lus), secrets, dépendances, données sensibles.',
        checks: { sections: ['Surface'], citedPaths: true } },
      { id: 'scans', title: '2 Scans automatisés', chain: ['audit.scans'], group: 'audit', artefact: 'scans.md', kind: 'judge', prerun: 'scans',
        role: 'SCANS AUTOMATISÉS : l’orchestrateur a lancé lui-même les scanners du projet ; leur sortie est dans scans-sortie.txt. Interprète-la : vrais problèmes, faux positifs, et ce que les scanners ne voient pas.',
        checks: { sections: ['Résultats'] } },
      { id: 'revue-manuelle', title: '3 Revue manuelle', chain: ['audit.revue-manuelle'], group: 'audit', artefact: 'revue-manuelle.json', kind: 'judge',
        role: 'REVUE MANUELLE du code à partir de la cartographie : injections, contrôle d’accès, secrets, désérialisation, chemins, dépendances.',
        checks: { json: { findings: 'array' } }, jsonExample: '{"findings": [{"severity": "haute|moyenne|basse", "file": "chemin", "issue": "description"}]}' },
      { id: 'second-avis', title: '4 Second avis indépendant', chain: ['audit.second-avis'], group: 'audit-2', artefact: 'second-avis.json', kind: 'judge', independent: ['revue-manuelle.json'],
        role: 'SECOND AVIS INDÉPENDANT : refais la revue de sécurité SANS lire revue-manuelle.json (indépendance), à partir de la cartographie et du code.',
        checks: { json: { findings: 'array' } }, jsonExample: '{"findings": [{"severity": "haute|moyenne|basse", "file": "chemin", "issue": "description"}]}' },
      { id: 'corriger', title: '5 Corriger', chain: ['audit.corriger'], group: 'code', artefact: 'corrections.md', kind: 'action',
        role: 'CORRIGER les failles de gravité haute ou moyenne relevées par les deux revues (revue-manuelle.json, second-avis.json), sans changer le comportement attendu. S’il n’y en a aucune, ne modifie rien.',
        checks: { nothing: 'RIEN_A_CORRIGER', protectTests: true } },
      { id: 'reverifier', title: '6 Re-vérifier', chain: ['audit.reverifier'], group: 'audit', artefact: 'reverification.json', kind: 'judge', prerun: 'scans',
        role: 'RE-VÉRIFIER : les scanners ont été relancés (scans-sortie.txt). Contrôle chaque faille corrigée et liste celles qui restent (gravité haute ou moyenne).',
        checks: { json: { remaining: 'array' } }, jsonExample: '{"remaining": [{"severity": "haute|moyenne", "file": "chemin", "issue": "ce qui reste"}], "verified": ["faille corrigée et vérifiée"]}',
        loop: { field: 'remaining', back: ['corriger', 'reverifier'] } },
      { id: 'livrer', title: '7 Livrer', chain: ['dev.livrer.git', 'dev.livrer'], group: 'code', artefact: 'livraison.md', kind: 'deliver', crit: 'livrer', devRole: 'livrer', ifChanged: true },
    ],
  },
  // ── Maintenance ──────────────────────────────────────────────────────────
  maintenance: {
    needs: { git: true, tests: true, clean: true },
    final: null,
    steps: [
      { id: 'dependances', title: '1 Dépendances', chain: ['maintenance.dependances'], group: 'maintenance', artefact: 'dependances.md', kind: 'action',
        role: 'METTRE À JOUR LES DÉPENDANCES sans rupture (versions mineures et correctifs ; une version majeure seulement si elle est sans risque), en vérifiant les avis de sécurité. Si rien n’est à faire, ne modifie rien.',
        checks: { nothing: 'RIEN_A_METTRE_A_JOUR', protectTests: true } },
      { id: 'historique', title: '2 Historique (rapport)', chain: ['maintenance.historique'], group: 'maintenance', artefact: 'historique.md', kind: 'judge',
        role: 'EXAMINER L’HISTORIQUE git (gros fichiers, secrets commités, branches mortes) et proposer le nettoyage. Ne réécris RIEN : une réécriture d’historique exige l’accord explicite de l’utilisateur.',
        checks: { sections: ['Constats', 'Propositions'], headUnchanged: true } },
      { id: 'tests-instables', title: '3 Tests instables', chain: ['maintenance.tests-instables'], group: 'maintenance', artefact: 'tests-instables.md', kind: 'action',
        role: 'TESTS INSTABLES : repère les tests qui échouent par intermittence (temps, ordre, réseau) et rends-les déterministes, sans affaiblir ce qu’ils vérifient. Si tout est stable, ne modifie rien.',
        checks: { nothing: 'RIEN_A_STABILISER', suiteTwice: true } },
      { id: 'dette', title: '4 Dette technique', chain: ['maintenance.dette'], group: 'code', artefact: 'dette.md', kind: 'action',
        role: 'DETTE TECHNIQUE : un nettoyage ciblé (code mort, duplication, noms), sans changement de comportement, tests inchangés. Si rien ne vaut la peine, ne modifie rien.',
        checks: { nothing: 'RIEN_A_NETTOYER', protectTests: true } },
      { id: 'livrer', title: '5 Livrer', chain: ['dev.livrer.git', 'dev.livrer'], group: 'code', artefact: 'livraison.md', kind: 'deliver', crit: 'livrer', devRole: 'livrer', ifChanged: true },
    ],
  },
  // ── Nouveau projet ───────────────────────────────────────────────────────
  nouveau: {
    needs: { git: true, clean: true },
    final: null,
    steps: [
      { id: 'cadrage', title: '1 Cadrage', chain: ['nouveau.cadrage'], group: 'nouveau', artefact: 'cadrage.md', kind: 'judge',
        role: 'CADRAGE du nouveau projet : objectif, utilisateurs, périmètre du MVP (et ce qui est hors MVP), stack proposée.',
        checks: { sections: ['Objectif', 'MVP', 'Stack'] } },
      { id: 'squelette', title: '2 Squelette', chain: ['nouveau.squelette'], group: 'code', artefact: 'squelette.md', kind: 'action',
        role: 'SQUELETTE prêt à tourner, avec les règles de la flotte : README, CHANGELOG (Keep a Changelog), version visible (1.0.0), docs/USER_REQUIREMENTS.md, une commande de test qui passe, et .orchestrateur/pipeline.json ({"testCommand", "testGlobs", "versionFiles", "changelog", "requirements"}).',
        checks: { requireFiles: ['README.md', 'CHANGELOG.md', 'docs/USER_REQUIREMENTS.md', '.orchestrateur/pipeline.json'], reloadConfig: true, needTestCommand: true } },
      { id: 'mvp', title: '3 MVP', chain: ['nouveau.mvp'], group: 'code', artefact: 'mvp.md', kind: 'action',
        role: 'MVP : le plus petit produit utile défini au cadrage, avec ses tests.',
        checks: {} },
      { id: 'publication', title: '4 Publication', chain: ['nouveau.publication', 'dev.livrer'], group: 'code', artefact: 'livraison.md', kind: 'deliver', crit: 'livrer', devRole: 'livrer' },
    ],
  },
  // ── Données ──────────────────────────────────────────────────────────────
  donnees: {
    needs: { git: true, clean: true },
    final: 'presenter',
    steps: [
      { id: 'collecter', title: '1 Collecter', chain: ['donnees.collecter'], group: 'donnees', artefact: 'collecte.md', kind: 'action',
        role: 'COLLECTER les données demandées (script de collecte versionné, données brutes à part), en respectant les conditions d’utilisation des sources. Liste les sources (URL) dans l’artefact.',
        checks: { minSources: 1 } },
      { id: 'nettoyer', title: '2 Nettoyer', chain: ['donnees.nettoyer'], group: 'donnees', artefact: 'nettoyage.md', kind: 'action',
        role: 'NETTOYER : doublons, formats, valeurs manquantes — par un script rejouable, jamais à la main. Si les données sont déjà propres, ne modifie rien.',
        checks: { nothing: 'RIEN_A_NETTOYER' } },
      { id: 'stocker', title: '3 Stocker', chain: ['donnees.stocker'], group: 'donnees', artefact: 'stockage.md', kind: 'action',
        role: 'STOCKER les données propres dans un format durable et documenté (schéma, emplacement). Si c’est déjà fait, ne modifie rien.',
        checks: { nothing: 'RIEN_A_STOCKER' } },
      { id: 'presenter', title: '4 Présenter', chain: ['donnees.presenter'], group: 'donnees', artefact: 'presentation.md', kind: 'action',
        role: 'PRÉSENTER le résultat à l’utilisateur : chiffres clés, tableau ou graphique, limites des données. Écris la présentation dans l’artefact (et un fichier du projet si utile).',
        checks: { nothing: 'PRESENTATION_SEULE', sections: ['Résultats', 'Limites'] } },
      { id: 'livrer', title: '5 Livrer', chain: ['dev.livrer.git', 'dev.livrer'], group: 'code', artefact: 'livraison.md', kind: 'deliver', crit: 'livrer', devRole: 'livrer', ifChanged: true },
    ],
  },
  // ── Rédaction ────────────────────────────────────────────────────────────
  redaction: {
    needs: { git: true, clean: true },
    final: 'relire',
    steps: [
      { id: 'rediger', title: '1 Rédiger', chain: ['redaction.rediger.ecriture', 'redaction.rediger'], group: 'redaction', artefact: 'texte.md', kind: 'action',
        role: 'RÉDIGER le texte demandé. Un document du projet (README, docs…) se modifie directement ; un texte à envoyer (courriel, message, article) s’écrit en entier dans l’artefact. Aucun code.',
        checks: { onlyGlobs: DOC_GLOBS, nothing: 'TEXTE_DANS_ARTEFACT' } },
      { id: 'relire', title: '2 Relire', chain: ['redaction.relire'], group: 'redaction-2', artefact: 'relecture.json', kind: 'judge',
        role: 'RELIRE le texte (artefact texte.md et documents modifiés) : justesse, clarté, ton, orthographe. Donne le texte final.',
        checks: { json: { corrections: 'array', final: 'string' } }, jsonExample: '{"verdict": "ok|corrections", "corrections": ["correction 1"], "final": "le texte final complet, ou « voir les documents modifiés »"}' },
      { id: 'mettre-en-forme', title: '3 Mettre en forme', chain: ['redaction.mettre-en-forme'], group: 'redaction', artefact: 'mise-en-forme.md', kind: 'action',
        role: 'METTRE EN FORME : applique les corrections de la relecture aux documents du projet (titres, listes, liens). Aucun code. Si rien n’est à appliquer, ne modifie rien.',
        checks: { onlyGlobs: DOC_GLOBS, nothing: 'RIEN_A_METTRE_EN_FORME' } },
      { id: 'livrer', title: '4 Livrer', chain: ['dev.livrer.git', 'dev.livrer'], group: 'code', artefact: 'livraison.md', kind: 'deliver', ifChanged: true, version: false,
        role: 'LIVRER : un SEUL commit des documents modifiés (git add -A puis git commit, message clair). Pas de version ni de CHANGELOG pour une simple rédaction. Pas de push.' },
    ],
  },
};

export const CATALOG_PIPELINES = Object.keys(S);
export function catalogOf(pipeline) { return S[pipeline] || null; }
export function catalogSteps(pipeline) { return (S[pipeline]?.steps || []).map(s => ({ ...s, judge: s.kind === 'judge' })); }
export { DOC_GLOBS };
