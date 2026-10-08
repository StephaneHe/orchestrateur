// Suite « mode double model » (0.44.0) — vrai dispatch.mjs + dual-run.mjs, faux
// claude, sur une COPIE git jetable du projet pilote pipelineLab.
//   node scripts/_test_dual_model.mjs
//
// Demande utilisateur : « on peut donner 2 models (1 par defaut), et si 2 sont
// precises, on lance la tache sur les 2, puis le 1er relis le tout pour en
// tirer le meilleur des 2 ».
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inferProvider, newRunId, branchStatus } from './dual-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const LAB = 'I:/Dev/pipelineLab';
const P = 'claude-sonnet-5', S = 'claude-haiku-4-5-20251001';
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });

/** Racine de test : config.json + copie git du pilote (ou d'un mini-projet si absent). */
function sandbox({ gitRepo = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-'));
  const proj = path.join(root, 'projects', 'labo');
  fs.mkdirSync(proj, { recursive: true });
  if (fs.existsSync(LAB)) {
    for (const f of ['package.json', 'CLAUDE.md', 'CHANGELOG.md']) if (fs.existsSync(path.join(LAB, f))) fs.copyFileSync(path.join(LAB, f), path.join(proj, f));
    for (const d of ['src', 'test', '.orchestrateur', 'docs']) if (fs.existsSync(path.join(LAB, d))) fs.cpSync(path.join(LAB, d), path.join(proj, d), { recursive: true });
  } else {
    fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"labo","version":"1.0.0"}\n');
  }
  if (gitRepo) {
    git(proj, 'init', '-q');
    git(proj, 'add', '-A');
    git(proj, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'départ');
  }
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    conductor: 'chef', defaults: { allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
    projects: [{ name: 'chef', path: path.join(root, 'projects', 'chef') }, { name: 'labo', path: proj }],
  }));
  fs.mkdirSync(path.join(root, 'projects', 'chef'));
  return { root, proj };
}
function run(sb, args, extraEnv = {}) {
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: sb.root, CLAUDE_BIN: FAKE, FAKE_CLAUDE_LATENCY_MS: '15',
    FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_WRITE: 'notes/{model}.txt', FAKE_CLAUDE_MERGE: '1', ORCH_PORT: '9', ...extraEnv };
  for (const k of ['DISPATCH_SLOT', 'DISPATCH_TICKET', 'ORCH_OBS_ID', 'ANTHROPIC_API_KEY', 'FAKE_CLAUDE_FAIL_MODEL']) if (!(k in extraEnv)) delete env[k];
  return spawnSync(process.execPath, [DISPATCH, 'labo', ...args], { cwd: sb.root, env, encoding: 'utf8', timeout: 120000 });
}
const events = (sb) => { try { return fs.readFileSync(path.join(sb.root, 'logs', 'labo.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
const runDirOf = (sb) => { const d = path.join(sb.root, 'logs', 'dual'); return fs.existsSync(d) ? fs.readdirSync(d).filter(x => x.startsWith('d-')).map(x => path.join(d, x))[0] : null; };

console.log('\n── 1. Utilitaires');
t('provider déduit : gpt → codex, claude → claude', inferProvider('gpt-6-astra') === 'codex' && inferProvider('claude-opus-5-5') === 'claude');
t('identifiant d’exécution conforme', /^d-\d{8}T\d{6}-[a-f0-9]{6}$/.test(newRunId()));
t('statut d’une branche : sans result = échec', !branchStatus(0, { result: null }).ok && branchStatus(0, { result: { is_error: false } }).ok && !branchStatus(0, { result: { is_error: true, result: 'x' } }).ok);

console.log('\n── 2. Double exécution réussie (action) : deux branches isolées, relecture, fusion');
{
  const sb = sandbox();
  const headBefore = git(sb.proj, 'rev-parse', 'HEAD').stdout.trim();
  const r = run(sb, ['ajoute une note de recette', '--model', P, '--second-model', S]);
  t('sortie 0', r.status === 0, `${r.status} ${r.stderr.slice(-400)}`);
  const ev = events(sb);
  const up = ev.filter(e => e.type === 'user_prompt');
  t('un seul tour au journal : un user_prompt avec le mode double', up.length === 1 && up[0].dual?.principal.model === P && up[0].dual?.second.model === S);
  const done = ev.filter(e => e.subtype === 'dual_branch_done');
  t('deux branches tracées séparément (model, modelSource, statut, durée, coût)', done.length === 2 && done.every(d => d.status === 'ok' && d.modelSource === 'flag' && Number.isFinite(d.durationMs) && 'costUsd' in d) && done.map(d => d.model).sort().join() === [P, S].sort().join());
  const dir = runDirOf(sb);
  const bl = (role) => fs.readFileSync(path.join(dir, `${role}.jsonl`), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  t('chaque branche a son propre log, avec son system/init et son model', bl('principal').find(e => e.subtype === 'init')?.model === P && bl('second').find(e => e.subtype === 'init')?.model === S);
  t('les branches n’écrivent rien dans le log du musicien (le pump ne voit qu’un tour)', ev.filter(e => e.type === 'system' && e.subtype === 'init').length === 1);
  const pd = fs.readFileSync(path.join(dir, 'principal.diff'), 'utf8'), sd = fs.readFileSync(path.join(dir, 'second.diff'), 'utf8');
  t('ISOLATION : chaque branche ne contient que son propre travail', pd.includes(`notes/${P}.txt`) && !pd.includes(`notes/${S}.txt`) && sd.includes(`notes/${S}.txt`) && !sd.includes(`notes/${P}.txt`));
  t('relecture par le PRINCIPAL dans le vrai dépôt', ev.find(e => e.subtype === 'dual_review_start')?.model === P);
  const prompt = fs.readFileSync(path.join(dir, 'relecture.prompt.md'), 'utf8');
  t('la relecture reçoit les deux résultats par fichiers (handoff) et exige la « Synthèse double »', /BRANCHE_PRINCIPALE=dual\//.test(prompt) && /BRANCHE_SECONDE=dual\//.test(prompt) && prompt.includes('second.diff') && /Synthèse double/.test(prompt));
  const res = [...ev].reverse().find(e => e.type === 'result');
  t('résultat final avec la synthèse (ce qui est retenu de chacun)', /Synthèse double/.test(res?.result || '') && /principale/.test(res.result) && /seconde/.test(res.result));
  t('résultat FUSIONNÉ dans le vrai dépôt : les deux apports présents, nouveau commit', fs.existsSync(path.join(sb.proj, 'notes', `${P}.txt`)) && fs.existsSync(path.join(sb.proj, 'notes', `${S}.txt`)) && git(sb.proj, 'rev-parse', 'HEAD').stdout.trim() !== headBefore);
  const sum = ev.find(e => e.subtype === 'dual_summary');
  t('bilan : coût et durée par branche ET pour la relecture', sum && sum.branches.length === 2 && sum.branches.every(b => 'costUsd' in b && Number.isFinite(b.durationMs)) && sum.review?.status === 'ok' && Number.isFinite(sum.review.durationMs) && 'costUsd' in sum.review);
  t('copies isolées nettoyées, branches git supprimées', git(sb.proj, 'worktree', 'list').stdout.trim().split('\n').length === 1 && !git(sb.proj, 'branch', '--list', 'dual/*').stdout.trim());
  t('l’autre résultat reste archivé (diffs, résumés, bilan)', ['principal.diff', 'second.diff', 'principal.result.md', 'second.result.md', 'summary.json', 'relecture.prompt.md'].every(f => fs.existsSync(path.join(dir, f))));
  t('le .pid du musicien est libéré', !fs.existsSync(path.join(sb.root, 'logs', 'labo.pid')));
  // Panneau du musicien : le journal montre UN tour avec les deux branches et la relecture.
  await import('../public/turn-core.js');
  const j = globalThis.TurnCore.createJournal();
  for (const e of ev) j.push(e);
  const turns = j.list();
  const d = turns[0]?.dual;
  t('journal : un seul tour, avec les deux branches et la relecture tracées séparément', turns.length === 1 && d && d.branches.length === 2 && d.branches.every(b => b.status === 'ok' && Number.isFinite(b.durationMs)) && d.review?.status === 'ok' && d.review.model === P && turns[0].outcome === 'ok');
}

console.log('\n── 3. Échec de la branche seconde : relecture quand même, utilisateur prévenu');
{
  const sb = sandbox();
  const r = run(sb, ['ajoute une note', '--model', P, '--second-model', S], { FAKE_CLAUDE_FAIL_MODEL: S });
  const ev = events(sb);
  t('la relecture a lieu (sortie 0)', r.status === 0 && ev.some(e => e.subtype === 'dual_review_start'), `${r.status}`);
  t('échec signalé explicitement (événement dual_branch_failed)', ev.some(e => e.subtype === 'dual_branch_failed' && e.model === S));
  t('la relecture est prévenue et doit commencer par l’avertissement', /ATTENTION/.test(fs.readFileSync(path.join(runDirOf(sb), 'relecture.prompt.md'), 'utf8')));
  t('bilan : seconde en échec, principal ok', (() => { const s = ev.find(e => e.subtype === 'dual_summary'); return s?.branches.find(b => b.role === 'second').status === 'failed' && s.branches.find(b => b.role === 'principal').status === 'ok'; })());
  t('le travail du principal est fusionné', fs.existsSync(path.join(sb.proj, 'notes', `${P}.txt`)));
}

console.log('\n── 4. Échec du PRINCIPAL : pause avec question, aucune substitution');
{
  const sb = sandbox();
  const r = run(sb, ['ajoute une note', '--model', P, '--second-model', S], { FAKE_CLAUDE_FAIL_MODEL: P });
  const ev = events(sb);
  const res = [...ev].reverse().find(e => e.type === 'result');
  t('sortie 2 (pause), aucune relecture lancée', r.status === 2 && !ev.some(e => e.subtype === 'dual_review_start'), `${r.status}`);
  t('question à l’utilisateur (NEEDS_USER_INPUT), sans substitution silencieuse', /NEEDS_USER_INPUT:/.test(res?.result || '') && res.dual_paused === true && !res.is_error);
  t('le travail du second reste archivé', fs.existsSync(path.join(runDirOf(sb), 'second.diff')) && fs.readFileSync(path.join(runDirOf(sb), 'second.diff'), 'utf8').includes(`notes/${S}.txt`));
  t('le vrai dépôt n’a pas été modifié', !fs.existsSync(path.join(sb.proj, 'notes')));
  t('copies isolées nettoyées', git(sb.proj, 'worktree', 'list').stdout.trim().split('\n').length === 1);
}

console.log('\n── 5. Étape de jugement : deux rapports, une synthèse, rien de fusionné');
{
  const sb = sandbox();
  const head = git(sb.proj, 'rev-parse', 'HEAD').stdout.trim();
  const r = run(sb, ['relis le module et donne ton avis', '--model', P, '--second-model', S, '--dual-mode', 'judge']);
  const prompt = fs.readFileSync(path.join(runDirOf(sb), 'relecture.prompt.md'), 'utf8');
  t('sortie 0, synthèse demandée sans fusion', r.status === 0 && /JUGEMENT/.test(prompt) && !/BRANCHE_PRINCIPALE=/.test(prompt));
  t('le vrai dépôt reste inchangé', git(sb.proj, 'rev-parse', 'HEAD').stdout.trim() === head && !fs.existsSync(path.join(sb.proj, 'notes')));
}

console.log('\n── 6. Refus, avant toute écriture');
{
  const sb = sandbox();
  fs.appendFileSync(path.join(sb.proj, 'package.json'), ' ');
  t('dépôt avec modifications non commitées → 65', run(sb, ['x', '--model', P, '--second-model', S]).status === 65);
  const ng = sandbox({ gitRepo: false });
  t('projet sans git → 64 (isolation impossible)', run(ng, ['x', '--model', P, '--second-model', S]).status === 64);
  const sb2 = sandbox();
  t('second NVIDIA / OpenRouter → 64 (outillage en construction)', run(sb2, ['x', '--model', P, '--second-model', 'moonshotai/kimi-k3']).status === 64);
  t('--second-model sans --model → 64', run(sb2, ['x', '--second-model', S]).status === 64);
  t('aucune écriture dans le log après un refus', events(sb2).length === 0);
  const sb3 = sandbox();
  run(sb3, ['x', '--model', P, '--second-model', P]);
  t('principal = second : signalé (sameModel)', events(sb3).find(e => e.type === 'user_prompt')?.dual?.sameModel === true);
}

console.log('\n── 6b. Exécution interrompue (parent tué) : reprise sans rien perdre au lancement suivant');
{
  const sb = sandbox();
  // Simule l'état laissé par un parent tué pendant les branches : copies, branches, travail non commité, tour ouvert.
  const old = 'd-20260101T000000-abcdef';
  const wtRoot = path.join(sb.root, 'logs', 'dual', 'wt', 'labo');
  for (const role of ['principal', 'second']) {
    git(sb.proj, 'worktree', 'add', '-q', '-b', `dual/${old}/${role}`, path.join(wtRoot, role), 'HEAD');
  }
  fs.writeFileSync(path.join(wtRoot, 'principal', 'travail-en-cours.txt'), 'non commité\n');
  fs.appendFileSync(path.join(sb.root, 'logs', 'labo.jsonl'), JSON.stringify({ type: 'user_prompt', text: 'ancien', dual: { run: old, mode: 'action', principal: { model: P }, second: { model: S } } }) + '\n');
  const r = run(sb, ['ajoute une note', '--model', P, '--second-model', S]);
  t('le nouveau lancement réussit malgré les restes', r.status === 0, `${r.status} ${r.stderr.slice(-400)}`);
  const oldDir = path.join(sb.root, 'logs', 'dual', old);
  t('travail interrompu archivé (y compris le non commité)', fs.existsSync(path.join(oldDir, 'principal.interrupted.diff')) && fs.readFileSync(path.join(oldDir, 'principal.interrupted.diff'), 'utf8').includes('travail-en-cours.txt') && fs.existsSync(path.join(oldDir, 'summary.json')));
  t('anciennes branches et copies supprimées', !git(sb.proj, 'branch', '--list', `dual/${old}/*`).stdout.trim() && git(sb.proj, 'worktree', 'list').stdout.trim().split('\n').length === 1);
  const ev = events(sb);
  const iRes = ev.findIndex(e => e.subtype === 'error_dual_interrupted');
  const newUp = ev.findIndex((e, i) => i > 0 && e.type === 'user_prompt');
  t('l’ancien tour est clos (result interrompu) AVANT le nouveau tour', iRes > 0 && newUp > iRes && ev[iRes].is_error === true);
  const j = globalThis.TurnCore.createJournal();
  for (const e of ev) j.push(e);
  const turns = j.list();
  t('journal : l’ancien tour est marqué interrompu, le nouveau est réussi', turns.length === 2 && turns.some(x => x.dual?.interrupted) && turns.some(x => x.dual && !x.dual.interrupted && x.outcome === 'ok'));
}

console.log('\n── 7. Câblage');
{
  const dsp = fs.readFileSync(DISPATCH, 'utf8');
  t('dispatch.mjs : --second-model délègue à dual-run.mjs après la file', /if \(secondModel && !DUAL_BRANCH && !dualSynthesis\)[\s\S]{0,200}import\('\.\/dual-run\.mjs'\)/.test(dsp));
  t('la demande mise en file garde ses deux models', /payload\.secondModel\s*=\s*secondModel/.test(dsp));
  t('une branche n’utilise ni le log, ni la session, ni le .pid du musicien', /DUAL_DIR \? path\.join\(DUAL_DIR, `\$\{DUAL_BRANCH\.role\}\.jsonl`\)/.test(dsp));
  t('dossier de travail d’une branche : seulement sous logs/dual/wt/', /wanted\.startsWith\(wtRoot\)/.test(dsp));
}

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
