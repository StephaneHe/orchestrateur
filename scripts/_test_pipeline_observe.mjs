// Suite « pipelines, phase 1 : observation » (0.41.0) — scripts/pipeline-observe.mjs
// et son branchement dans dispatch.mjs (vrai script, doublure de claude).
//   node scripts/_test_pipeline_observe.mjs
//
// Exigence utilisateur (2026-10-08) : « Il faut que toute entree dans
// l'orchestrateur passe par les pipelines decides dans la page Models » ; et
// (réponse n° 1) « Le terminal interactif […] Il faut que ca passe dans le
// routeur aussi. Si aucune classification possible, alors consideres une
// discussion ».
//
// 0.66.0 — demande utilisateur (2026-10-10) : « Ce n'est pas une recherche de
// mot qui pourra faire un routage efficace, c'est une recherche de sens que
// seul un modele peut faire ». L'observation ne garde que le choix EXPLICITE ;
// les vraies demandes du fleet ne sont plus du tout classées par mots-clés.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { explicitChoice, createObserver, TerminalLineBuffer, projectFromCwd, normalizeText, ENTRY_KINDS } from './pipeline-observe.mjs';
import { classificationPrompt } from './pipeline-classify.mjs';
import { PIPELINES } from './model-pipelines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };

console.log('\n── 1. Plus aucun classement par mots-clés — vraies demandes du fleet : « à classer » par le model');
const CASES = [
  'Je voudrais rajouter un mode discussion sur l\'orchestrateur. Fais moi un plan',
  'donne la possibilité d\'augmenter ou diminuer la taille de la police',
  'implémente une fonction de lecture audio des réponses, déjà du chef',
  'corrige la typo dans le README',
  'pourquoi le serveur est lent ?',
  'le serveur est en panne, plus rien ne répond',
  'fais un audit sécurité du dépôt avant publication',
  'quelles sont les alternatives à whisper pour la transcription ?',
  'traduis ce texte en anglais',
  'transcris l\'enregistrement de la réunion de ce matin',
  'génère une icône pour l\'app compagnon',
  'mets à jour les dépendances npm',
];
for (const text of CASES) {
  const c = explicitChoice({ text, entry: 'dashboard:chef' });
  t(`« ${text.slice(0, 60)} » → aucun pipeline deviné (à classer par le model)`, c.pipeline === null && c.explicit === false, JSON.stringify(c));
}

console.log('\n── 2. Inclassable = Discussion (règle utilisateur) : une consigne du model, plus une règle de mots');
const p = classificationPrompt('bonjour');
t('la consigne du model porte « inclassable = Discussion »', /If nothing fits clearly → discussion/.test(p) && /unclassifiable = Discussion/.test(p));
t('la consigne demande un classement par le SENS', /by their MEANING/.test(p));
for (const text of ['bonjour', 'ok', '', '   ']) t(`« ${text} » : aucun pipeline deviné par l’orchestrateur`, explicitChoice({ text, entry: 'terminal' }).pipeline === null);

console.log('\n── 3. Choix explicite et entrées système (gardés : ce ne sont pas des recherches de mots)');
t('/incident en tête : explicite', (() => { const c = explicitChoice({ text: '/incident le build casse' }); return c.pipeline === 'incident' && c.explicit; })());
t('/léger force le mode', explicitChoice({ text: '/dev /léger renomme la variable' }).mode === 'leger');
t('/complet force le mode', explicitChoice({ text: '/complet corrige la typo' }).mode === 'complet');
t('un « /dev » au milieu du texte n’est pas un préfixe', explicitChoice({ text: 'parle-moi du /dev ici' }).pipeline === null);
for (const entry of ['wake', 'relais-vers-chef', 'notify']) t(`${entry} → Routage`, explicitChoice({ text: 'n’importe quoi', entry }).pipeline === 'routage');
t('les consignes injectées (RÈGLE DE FIN DE TOUR…) sont ignorées', normalizeText('corrige le bug\n\n---\nRÈGLE DE FIN DE TOUR : ton tour…') === 'corrige le bug');
const ids = new Set(PIPELINES.map(x => x.id));
t('tout préfixe explicite désigne un pipeline existant de la page Models', ['/dev x', '/incident x', '/audio x', '/redaction x', '/donnees x'].every(x => ids.has(explicitChoice({ text: x }).pipeline)));
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
  t('champs : aucun pipeline deviné (à classer), classifieur « explicite », extrait', r1.pipeline === null && r1.explicit === false && r1.classifier === 'explicite' && r1.head === 'corrige la typo');
  const r3 = o.record({ entry: 'dashboard:chef', project: 'chef', text: '/dev /complet ajoute X' });
  t('un préfixe explicite est journalisé tel quel', r3.pipeline === 'dev' && r3.mode === 'complet' && r3.explicit === true);
  t('compteurs par entrée', o.recent(10).counts.byEntry.terminal === 1);
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
  t('observée sans classement par mots (à classer par le model)', recs[0]?.pipeline === null && recs[0]?.explicit === false);
  run(root, { ORCH_OBS_ID: 'obs-deja-vu' });
  t('lancé par le serveur (ORCH_OBS_ID) : pas de double observation', read().length === 1);
  const prompt = fs.readFileSync(path.join(root, 'logs', 'alpha.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e => e.type === 'user_prompt');
  t('le texte du tour n’est pas modifié par l’observation', prompt.every(x => x.text === 'corrige la typo du titre'));
}

console.log('\n── 7. Câblage : aucun point d’entrée n’échappe à l’observation');
{
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const dsp = fs.readFileSync(path.join(ROOT, 'scripts', 'dispatch.mjs'), 'utf8');
  for (const kind of ['wake', 'relais-vers-chef', 'relais-vers-musicien', 'notify', 'session-neuve', 'terminal']) {
    t(`server.js observe l’entrée « ${kind} »`, new RegExp(`(entry|observeAs): '${kind}'`).test(srv));
  }
  t('/api/dispatch observe dashboard / android × chef / mention / musicien', /\$\{clientOf\(req\)\}:\$\{isChef \? \(mention \? 'mention' : 'chef'\) : 'musicien'\}/.test(srv));
  // 0.52.0 : les deux chemins passent par writeInput, qui observe AVANT tout routage.
  const legacyPaths = /centralPty\.write\(parsed\.data\);\s*observeTyping\(parsed\.data\)/.test(srv) && /centralPty\.write\(text\);\s*observeTyping\(text\)/.test(srv);
  const routedPaths = /const writeInput = \(data\) => \{\s*observeTyping\(data\);/.test(srv) && /writeInput\(parsed\.data\)/.test(srv) && /writeInput\(text\)/.test(srv);
  t('terminal interactif : les deux chemins d’écriture sont observés', legacyPaths || routedPaths);
  t('spawnDirectDispatch : filet de sécurité (lancement sans origine observé)', /function spawnDirectDispatch[\s\S]{0,900}observeEntry\(\{ entry, project: name, text: prompt \}\)/.test(srv));
  t('l’identifiant suit l’entrée jusqu’au tour (ORCH_OBS_ID) : file, pool, direct', (srv.match(/ORCH_OBS_ID/g) || []).length >= 3 && /obsId: t\.obsId/.test(srv) && /newSession, obsId,( secondModel, secondProvider, dualMode,)?( pipeline, pipelineResume, horsPipeline,( pipelineMode,)?)? noQueueIfBusy/.test(srv));
  t('dispatch.mjs : observe hors serveur et retire ORCH_OBS_ID de l’environnement du tour', /entry: 'dispatch-cli'/.test(dsp) && /delete process\.env\.ORCH_OBS_ID/.test(dsp));
  t('dispatch.mjs : l’observation ne bloque jamais (import dynamique + try/catch)', /try \{\s*const obs = await import\('\.\/pipeline-observe\.mjs'\)/.test(dsp));
}

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
