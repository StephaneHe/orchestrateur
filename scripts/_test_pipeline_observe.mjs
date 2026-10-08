// Suite « pipelines, phase 1 : observation » (0.41.0) — scripts/pipeline-observe.mjs
// et son branchement dans dispatch.mjs (vrai script, doublure de claude).
//   node scripts/_test_pipeline_observe.mjs
//
// Exigence utilisateur (2026-10-08) : « Il faut que toute entree dans
// l'orchestrateur passe par les pipelines decides dans la page Models » ; et
// (réponse n° 1) « Le terminal interactif […] Il faut que ca passe dans le
// routeur aussi. Si aucune classification possible, alors consideres une
// discussion ».
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classify, createObserver, TerminalLineBuffer, projectFromCwd, normalizeText, ENTRY_KINDS } from './pipeline-observe.mjs';
import { PIPELINES } from './model-pipelines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };

console.log('\n── 1. Classification (règles) — vraies demandes du fleet');
const CASES = [
  // [texte, pipeline attendu, mode attendu ou null]
  ['Je voudrais rajouter un mode discussion sur l\'orchestrateur. Fais moi un plan', 'dev', null],
  ['Il faut que toute entree dans l\'orchestrateur passe par les pipelines decides dans la page Models, est-ce deja le cas ?', 'dev', null],
  ['donne la possibilité d\'augmenter ou diminuer la taille de la police', 'dev', null],
  ['implémente une fonction de lecture audio des réponses, déjà du chef', 'dev', 'complet'],
  ['On peut aussi rajouter du travail sur images ? Videos ? Sons ?', 'dev', null],
  ['Ce concept de mis de cote n\'a plus d\'interet. Fais une etude du code, et supprime le concept.', 'dev', 'complet'],
  ['corrige la typo dans le README', 'dev', 'leger'],
  ['pourquoi le serveur est lent ?', 'discussion', 'leger'],
  ['c\'est quoi le mode léger ?', 'discussion', 'leger'],
  ['le serveur est en panne, plus rien ne répond', 'incident', null],
  ['fais un audit sécurité du dépôt avant publication', 'audit', null],
  ['quelles sont les alternatives à whisper pour la transcription ?', 'recherche', null],
  ['traduis ce texte en anglais', 'redaction', null],
  ['crée un nouveau projet pour une app de recettes', 'nouveau', null],
  ['scrape les annonces du site et fais un csv', 'donnees', null],
  ['transcris l\'enregistrement de la réunion de ce matin', 'audio', null],
  ['génère une icône pour l\'app compagnon', 'images', null],
  ['monte la vidéo de la séance et ajoute les chapitres', 'video', null],
  ['mets à jour les dépendances npm', 'maintenance', null],
];
for (const [text, want, mode] of CASES) {
  const c = classify({ text, entry: 'dashboard:chef' });
  t(`« ${text.slice(0, 60)} » → ${want}${mode ? ' ' + mode : ''}`, c.pipeline === want && (!mode || c.mode === mode), `(obtenu ${c.pipeline} ${c.mode} — ${c.reasons.join(' ; ')})`);
}

console.log('\n── 2. Inclassable = Discussion (règle utilisateur)');
for (const text of ['bonjour', 'ok', '', '   ', 'hmm 42']) {
  const c = classify({ text, entry: 'terminal' });
  t(`« ${text} » → Discussion, marquée inclassable`, c.pipeline === 'discussion' && c.unclassifiable === true);
}

console.log('\n── 3. Choix explicite et entrées système');
t('/incident en tête : explicite', (() => { const c = classify({ text: '/incident le build casse' }); return c.pipeline === 'incident' && c.explicit; })());
t('/léger force le mode', classify({ text: '/dev /léger renomme la variable' }).mode === 'leger');
t('/complet force le mode', classify({ text: '/complet corrige la typo' }).mode === 'complet');
for (const entry of ['wake', 'relais-vers-chef', 'notify']) t(`${entry} → Routage`, classify({ text: 'n’importe quoi', entry }).pipeline === 'routage');
t('les consignes injectées (RÈGLE DE FIN DE TOUR…) sont ignorées', normalizeText('corrige le bug\n\n---\nRÈGLE DE FIN DE TOUR : ton tour…') === 'corrige le bug');
const ids = new Set(PIPELINES.map(p => p.id));
t('toute classification désigne un pipeline existant de la page Models', CASES.every(([text]) => ids.has(classify({ text }).pipeline)));
t('chaque sorte d’entrée a un libellé', ['dashboard:chef', 'dashboard:mention', 'android:chef', 'dispatch-cli', 'terminal', 'wake', 'notify', 'file', 'session-neuve', 'relais-vers-musicien'].every(k => ENTRY_KINDS[k]));

console.log('\n── 4. Terminal interactif : lignes validées');
{
  const b = new TerminalLineBuffer();
  t('frappe puis Entrée → une ligne', JSON.stringify(b.feed('corrige le bug')) === '[]' && JSON.stringify(b.feed('\r')) === '["corrige le bug"]');
  t('retour arrière appliqué', JSON.stringify(b.feed('pourquoi\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7fcomment ?\r')) === '["comment ?"]');
  t('flèches et séquences ignorées', JSON.stringify(b.feed('\x1b[A\x1b[Bfix\x1b[D\r')) === '["fix"]');
  t('collage encadré', JSON.stringify(b.feed('\x1b[200~ajoute un test\x1b[201~\r')) === '["ajoute un test"]');
  t('Ctrl+C abandonne la ligne', JSON.stringify(b.feed('abc\x03\r')) === '[]');
  t('Entrée seule : rien', JSON.stringify(b.feed('\r\r')) === '[]');
}

console.log('\n── 5. Journal');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
  const o = createObserver({ logsDir: dir });
  const r1 = o.record({ entry: 'dashboard:chef', project: 'chef', text: 'corrige la typo' });
  o.record({ entry: 'terminal', project: 'central', text: 'bonjour' });
  const v = o.recent(10);
  t('append-only, plus récent d’abord', v.items.length === 2 && v.items[0].entry === 'terminal' && v.items[1].id === r1.id);
  t('champs : pipeline, mode, confiance, classifieur, extrait', r1.pipeline === 'dev' && r1.mode === 'leger' && r1.classifier && r1.head === 'corrige la typo');
  t('compteurs par pipeline / entrée / inclassables', v.counts.byPipeline.dev === 1 && v.counts.byEntry.terminal === 1 && v.counts.unclassifiable === 1);
  t('projectFromCwd : dossier le plus profond', projectFromCwd('I:\\Dev\\Chef\\sub', [{ name: 'dev', path: 'I:\\Dev' }, { name: 'chef', path: 'I:\\Dev\\Chef' }]) === 'chef' && projectFromCwd('C:\\x', [{ name: 'a', path: 'I:\\Dev\\a' }]) === null);
}

console.log('\n── 6. dispatch.mjs (vrai script) : observé hors serveur, sans changer le tour');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-dispatch-'));
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const proj = path.join(root, 'projects', 'alpha');
  const chefDir = path.join(root, 'projects', 'chef');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(chefDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    conductor: 'chef', defaults: { allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
    projects: [{ name: 'chef', path: chefDir }, { name: 'alpha', path: proj }],
  }));
  const fake = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
  const run = (cwd, extraEnv = {}) => {
    const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: root, CLAUDE_BIN: fake, FAKE_CLAUDE_LATENCY_MS: '50', ...extraEnv };
    delete env.DISPATCH_SLOT; delete env.DISPATCH_TICKET; delete env.ORCH_OBS_ID; delete env.ANTHROPIC_API_KEY;
    Object.assign(env, extraEnv);
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'alpha', 'corrige la typo du titre', '--no-queue-if-busy'], { cwd, env, encoding: 'utf8', timeout: 60000 });
  };
  const obsFile = path.join(root, 'logs', 'pipeline-observe.ndjson');
  const read = () => { try { return fs.readFileSync(obsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const r = run(chefDir, { CLAUDECODE: '1' });
  const recs = read();
  t('le tour a lieu normalement (exit 0, result dans le log)', r.status === 0 && fs.readFileSync(path.join(root, 'logs', 'alpha.jsonl'), 'utf8').includes('"type":"result"'), `exit ${r.status} ${r.stderr.slice(-300)}`);
  t('une observation « dispatch-cli », projet alpha, appelant = chef (depuis un tour d’agent)', recs.length === 1 && recs[0].entry === 'dispatch-cli' && recs[0].project === 'alpha' && recs[0].caller === 'chef' && recs[0].fromAgent === true, JSON.stringify(recs));
  t('classée dev léger', recs[0]?.pipeline === 'dev' && recs[0]?.mode === 'leger');
  run(root, { ORCH_OBS_ID: 'obs-deja-vu' });
  t('lancé par le serveur (ORCH_OBS_ID) : pas de double observation', read().length === 1);
  const prompt = fs.readFileSync(path.join(root, 'logs', 'alpha.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e => e.type === 'user_prompt');
  t('le texte du tour n’est pas modifié par l’observation', prompt.every(p => p.text === 'corrige la typo du titre'));
}

console.log('\n── 7. Câblage : aucun point d’entrée n’échappe à l’observation');
{
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const dsp = fs.readFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), 'utf8');
  for (const kind of ['wake', 'relais-vers-chef', 'relais-vers-musicien', 'notify', 'session-neuve', 'terminal']) {
    t(`server.js observe l’entrée « ${kind} »`, new RegExp(`(entry|observeAs): '${kind}'`).test(srv));
  }
  t('/api/dispatch observe dashboard / android × chef / mention / musicien', /\$\{clientOf\(req\)\}:\$\{isChef \? \(mention \? 'mention' : 'chef'\) : 'musicien'\}/.test(srv));
  t('terminal interactif : les deux chemins d’écriture sont observés', (srv.match(/observeTyping\(/g) || []).length >= 2 && /centralPty\.write\(parsed\.data\);\s*observeTyping\(parsed\.data\)/.test(srv) && /centralPty\.write\(text\);\s*observeTyping\(text\)/.test(srv));
  t('spawnDirectDispatch : filet de sécurité (lancement sans origine observé)', /function spawnDirectDispatch[\s\S]{0,900}observeEntry\(\{ entry, project: name, text: prompt \}\)/.test(srv));
  t('l’identifiant suit l’entrée jusqu’au tour (ORCH_OBS_ID) : file, pool, direct', (srv.match(/ORCH_OBS_ID/g) || []).length >= 3 && /obsId: t\.obsId/.test(srv) && /newSession, obsId, noQueueIfBusy/.test(srv));
  t('dispatch.mjs : observe hors serveur et retire ORCH_OBS_ID de l’environnement du tour', /entry: 'dispatch-cli'/.test(dsp) && /delete process\.env\.ORCH_OBS_ID/.test(dsp));
  t('dispatch.mjs : l’observation ne bloque jamais (import dynamique + try/catch)', /try \{\s*const obs = await import\('\.\/pipeline-observe\.mjs'\)/.test(dsp));
}

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
