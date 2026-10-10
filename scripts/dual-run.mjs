// ============================================================================
// scripts/dual-run.mjs — mode DOUBLE MODEL (0.44.0)
// ============================================================================
//
// Demande utilisateur : « on peut donner 2 models (1 par defaut), et si 2 sont
// precises, on lance la tache sur les 2, puis le 1er relis le tout pour en
// tirer le meilleur des 2 ».
//
// Appelé par dispatch.mjs quand `--second-model` est passé :
//   node scripts/dispatch.mjs <projet> "<demande>" --model A --second-model B
//        [--provider claude|codex] [--second-provider claude|codex]
//        [--dual-mode action|judge]
//
// Déroulé :
//   1. deux BRANCHES lancées en parallèle, INDÉPENDANTES : chacune dans sa
//      copie isolée du dépôt (git worktree sous logs/dual/wt/<projet>/<rôle>),
//      sa propre session, son propre log (logs/dual/<run>/<rôle>.jsonl). Aucune
//      ne voit le travail de l'autre ;
//   2. chaque branche est figée (commit dans son worktree) puis ARCHIVÉE :
//      <rôle>.diff, <rôle>.result.md, coût, durée, model servi ;
//   3. la RELECTURE : un tour normal du PRINCIPAL dans le vrai dépôt, qui lit
//      les deux résultats (handoff par fichiers — marche aussi avec codex),
//      fusionne la meilleure version et dit ce qu'il a retenu de chacun ;
//   4. nettoyage : worktrees et branches git supprimés ; l'archive reste.
//
// Règles :
//   - « model explicite = aucun fallback » pour les DEUX (chaque branche est un
//     dispatch.mjs avec --model) ;
//   - la seconde échoue → la relecture a lieu quand même avec ce qui existe, et
//     l'utilisateur est prévenu explicitement (log + chef) ;
//   - le principal échoue → PAUSE avec question (NEEDS_USER_INPUT), jamais de
//     substitution silencieuse ;
//   - étape de jugement (`--dual-mode judge`) : deux rapports, puis une
//     synthèse ; rien n'est fusionné.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export const ROLES = ['principal', 'second'];
const OPENAI_RE = /^(gpt|o\d|codex)\b/i;

/** Provider déduit de l'identifiant quand il n'est pas donné. */
export function inferProvider(model) {
  return OPENAI_RE.test(String(model || '')) ? 'codex' : 'claude';
}

/** Identifiant d'exécution : d-AAAAMMJJTHHMMSS-xxxx. */
export function newRunId(now = new Date()) {
  const s = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `d-${s}-${crypto.randomBytes(3).toString('hex')}`;
}

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, ...opts });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

/** Dernier result, model servi et erreurs d'un log de branche. */
export function readBranchLog(file) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const init = lines.find(e => e.type === 'system' && e.subtype === 'init') || null;
  const served = [...lines].reverse().find(e => e.type === 'assistant' && e.message?.model && e.message.model !== '<synthetic>')?.message.model || init?.model || null;
  const result = [...lines].reverse().find(e => e.type === 'result') || null;
  const refused = lines.find(e => e.type === 'system' && e.subtype === 'fallback_refused') || null;
  const lastText = [...lines].reverse().map(e => (e.type === 'assistant' ? (e.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') : '')).find(Boolean) || '';
  return { init, served, result, refused, lastText, events: lines.length };
}

export function branchStatus(exitCode, log) {
  if (!log.result) return { ok: false, why: exitCode === 0 ? 'aucun résultat' : `processus sorti avec le code ${exitCode}` };
  if (log.result.is_error) return { ok: false, why: String(log.result.result || log.result.subtype || 'échec').slice(0, 300) };
  if (exitCode !== 0) return { ok: false, why: `processus sorti avec le code ${exitCode}` };
  return { ok: true, why: '' };
}

function postNotify(root, project, text) {
  return new Promise((resolve) => {
    let token = '';
    try { token = fs.readFileSync(path.join(root, '.token'), 'utf8').trim(); } catch {}
    const port = Number(process.env.ORCH_PORT) || 7777;
    const body = Buffer.from(JSON.stringify({ project, text, source: 'double-model' }));
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/notify', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Orchestrator-Token': token } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { try { req.destroy(); } catch {} resolve(null); });
    req.end(body);
  });
}

function branchPrompt(prompt, role, run, mode) {
  const other = role === 'principal' ? 'second' : 'principal';
  return `${prompt}\n\n---\n[MODE DOUBLE — branche « ${role} », exécution ${run}]\n` +
    (mode === 'action'
      ? `Tu travailles dans une COPIE ISOLÉE du dépôt (git worktree). Un autre model (branche « ${other} ») traite la même demande en parallèle, ` +
        `sans que vous voyiez le travail l'un de l'autre. Fais le travail complètement ICI : modifie, teste, et commite dans cette copie. ` +
        `Ne pousse rien (aucun git push) et ne touche pas au dépôt d'origine : le principal fusionnera ensuite la meilleure version. `
      : `C'est une étape de JUGEMENT : lis, analyse, mais ne modifie aucun fichier. Un autre model (branche « ${other} ») fait le même travail ` +
        `de son côté, sans que vous vous voyiez. `) +
    `Termine par un résumé clair de ce que tu as fait et de tes choix.`;
}

function synthesisPrompt({ prompt, run, mode, dir, branches, failed, testCommand }) {
  const lines = [];
  lines.push(`[RELECTURE DOUBLE — exécution ${run}]`);
  lines.push(`Demande d'origine :\n${prompt}\n`);
  lines.push(`La demande a été traitée EN PARALLÈLE et INDÉPENDAMMENT par deux models. Tu es le model PRINCIPAL : relis les deux résultats et produis le résultat FINAL en prenant le meilleur des deux.`);
  for (const b of branches) {
    lines.push(`\n### Branche « ${b.role} » — ${b.provider}/${b.model} — ${b.ok ? 'terminée' : `ÉCHEC : ${b.why}`}`);
    lines.push(`- résumé de la branche : ${path.join(dir, `${b.role}.result.md`)}`);
    if (mode === 'action') {
      lines.push(`- différences par rapport au point de départ : ${path.join(dir, `${b.role}.diff`)}`);
      if (b.gitBranch) lines.push(`- BRANCHE_${b.role === 'principal' ? 'PRINCIPALE' : 'SECONDE'}=${b.gitBranch} (branche git locale, lisible et fusionnable depuis le dépôt)`);
    }
  }
  if (failed.length) {
    lines.push(`\n⚠ ATTENTION : ${failed.map(b => `la branche « ${b.role} » (${b.model}) a échoué — ${b.why}`).join(' ; ')}. Fais la relecture avec ce qui existe, et COMMENCE ta réponse par cet avertissement, pour que l'utilisateur en soit prévenu.`);
  }
  if (mode === 'action') {
    lines.push(`\nÀ faire, dans le dépôt réel (dossier courant) :`);
    lines.push(`1. compare les deux versions (fichiers .diff, branches git) ;`);
    lines.push(`2. construis la version finale : fusionne la meilleure (git merge / git checkout <branche> -- <fichier> / cherry-pick), ou combine-les, ou réécris ce qui doit l'être ;`);
    lines.push(`3. ${testCommand ? `lance la suite de tests (${testCommand}) : elle doit passer ;` : 'vérifie que tout fonctionne (tests du projet s\'il y en a) ;'}`);
    lines.push(`4. commite le résultat final (pas de git push sans autorisation) ;`);
    lines.push(`5. ne supprime pas les branches dual/… : l'orchestrateur les archive et les nettoie après toi.`);
  } else {
    lines.push(`\nC'est une étape de JUGEMENT : ne modifie aucun fichier. Écris le rapport final, en prenant le meilleur des deux rapports.`);
  }
  lines.push(`\nTermine OBLIGATOIREMENT par une section « ## Synthèse double » qui dit, pour chaque branche, ce que tu as retenu, ce que tu as écarté, et POURQUOI.`);
  return lines.join('\n');
}

/**
 * Reprise d'une exécution double INTERROMPUE (parent tué : arrêt de session,
 * redémarrage…). Ses copies et branches git sont figées puis archivées
 * (<rôle>.interrupted.diff — le travail non commité compris), supprimées, et le
 * tour resté ouvert dans le log du musicien est clos explicitement. Rien n'est
 * perdu, et le panneau ne reste pas « en cours » sans fin.
 */
export function recoverInterrupted({ projectPath, projectName, logsDir, writeEvent, say = () => {} }) {
  const recovered = [];
  const wtRoot = path.join(logsDir, 'dual', 'wt', projectName);
  const branches = git(projectPath, ['branch', '--list', 'dual/*', '--format=%(refname:short)']).out.split('\n').filter(Boolean);
  const runs = new Set();
  for (const br of branches) {
    const m = /^dual\/(d-\d{8}T\d{6}-[a-z0-9]{4,8})\/(principal|second)$/.exec(br);
    if (!m) continue;
    const [, run, role] = m;
    runs.add(run);
    const dir = path.join(logsDir, 'dual', run);
    fs.mkdirSync(dir, { recursive: true });
    const wt = path.join(wtRoot, role);
    if (fs.existsSync(wt) && git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).out === br) {
      git(wt, ['add', '-A']);
      if (git(wt, ['status', '--porcelain']).out) {
        git(wt, ['-c', 'user.name=orchestrateur', '-c', 'user.email=orchestrateur@localhost', 'commit', '-q', '-m', `double ${run} : branche ${role} interrompue`]);
      }
    }
    const base = git(projectPath, ['merge-base', 'HEAD', br]).out;
    const diff = base ? git(projectPath, ['diff', `${base}..${br}`], { maxBuffer: 64 * 1024 * 1024 }).out : '';
    fs.writeFileSync(path.join(dir, `${role}.interrupted.diff`), diff ? diff + '\n' : '');
    if (fs.existsSync(wt)) git(projectPath, ['worktree', 'remove', '--force', wt]);
    git(projectPath, ['branch', '-D', br]);
    recovered.push({ run, role, diffBytes: diff.length });
  }
  for (const role of ROLES) {
    const wt = path.join(wtRoot, role);
    if (fs.existsSync(wt)) { git(projectPath, ['worktree', 'remove', '--force', wt]); try { fs.rmSync(wt, { recursive: true, force: true }); } catch {} }
  }
  git(projectPath, ['worktree', 'prune']);
  for (const run of runs) {
    const dir = path.join(logsDir, 'dual', run);
    if (!fs.existsSync(path.join(dir, 'summary.json'))) {
      fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ run, interrupted: true, recoveredAt: new Date().toISOString(), branches: recovered.filter(r => r.run === run) }, null, 2));
    }
    const msg = `exécution double ${run} interrompue (processus arrêté avant la relecture) — travail des branches archivé dans logs/dual/${run} (*.interrupted.diff)`;
    writeEvent({ type: 'system', subtype: 'dual_interrupted', dual: { run }, text: msg });
    writeEvent({ type: 'result', subtype: 'error_dual_interrupted', is_error: true, num_turns: 1, dual: { run }, result: msg });
    say(`reprise : ${msg}`);
  }
  return recovered;
}

/**
 * Lance les deux branches, archive, fait relire par le principal, nettoie.
 * Renvoie le code de sortie du processus parent.
 */
export async function runDual(o) {
  const { root, logsDir, project, projectName, prompt, promptForLog, principal, mode, callbackProject, sourceProject, obsId, dispatchScript } = o;
  const second = { model: o.second.model, provider: o.second.provider || inferProvider(o.second.model) };
  const say = (m) => console.log(`[double] ${m}`);
  // Dans une étape de pipeline (0.48.0), tout va dans le log de l'étape, et la
  // relecture garde le jeton d'étape et ses drapeaux.
  const projectLog = o.logFile || path.join(logsDir, `${projectName}.jsonl`);
  const pidPath = o.pidFile || path.join(logsDir, `${projectName}.pid`);
  // Same turn id as the dispatch running us (0.67.0): one turn in the journal.
  const writeEvent = (ev) => { try { fs.appendFileSync(projectLog, JSON.stringify({ ...(process.env.ORCH_TURN_ID ? { orch_turn: process.env.ORCH_TURN_ID } : {}), ...ev, timestamp: new Date().toISOString() }) + '\n'); } catch {} };

  // ── Garde-fous, avant toute écriture ──────────────────────────────────────
  for (const [role, b] of [['principal', principal], ['second', second]]) {
    // 0.47.0 : NVIDIA / OpenRouter ont un harnais (codex). Leurs identifiants
    // « éditeur/model » sont ambigus entre les deux : le provider doit être dit.
    if (String(b.model).includes('/') && b.provider !== 'nvidia' && b.provider !== 'openrouter') {
      console.error(`[double] refusé : ${role} « ${b.model} » — précise le fournisseur (--${role === 'second' ? 'second-' : ''}provider nvidia|openrouter).`);
      return 64;
    }
    if (b.provider === 'claude' && OPENAI_RE.test(b.model)) { console.error(`[double] refusé : ${role} « ${b.model} » est un model OpenAI : provider codex attendu.`); return 64; }
    if (b.provider === 'codex' && /^(claude|opus|sonnet|haiku|fable)\b/i.test(b.model)) { console.error(`[double] refusé : ${role} « ${b.model} » est un model Claude : provider claude attendu.`); return 64; }
  }
  const isGit = git(project.path, ['rev-parse', '--is-inside-work-tree']).out === 'true';
  if (!isGit) {
    console.error(`[double] refusé : ${project.path} n'est pas un dépôt git — l'isolation des deux branches passe par un worktree par model.`);
    return 64;
  }
  // Jugement : rien n'est fusionné, l'état courant peut être modifié (étape Revue d'un pipeline).
  const dirty = mode === 'action' ? git(project.path, ['status', '--porcelain', '--untracked-files=no']).out : '';
  if (dirty) {
    console.error(`[double] refusé : le dépôt a des modifications non commitées (${dirty.split('\n').length} fichier(s)). Les deux branches partent du dernier commit : commite ou range d'abord.`);
    return 65;
  }
  const base = git(project.path, ['rev-parse', 'HEAD']).out;
  if (!base) { console.error('[double] refusé : dépôt sans commit.'); return 65; }

  // Avant le nouveau tour : clore et archiver une exécution double interrompue.
  recoverInterrupted({ projectPath: project.path, projectName, logsDir, writeEvent, say });

  const run = newRunId();
  const dir = path.join(logsDir, 'dual', run);
  fs.mkdirSync(dir, { recursive: true });
  const same = principal.model === second.model && principal.provider === second.provider;
  const started = Date.now();

  // Le musicien est occupé pendant tout le mode double : le parent tient le .pid.
  try { fs.writeFileSync(pidPath, String(process.pid)); } catch {}
  const userPrompt = {
    type: 'user_prompt', text: promptForLog,
    dual: { run, mode, principal, second, ...(same ? { sameModel: true } : {}) },
    ...(sourceProject ? { source: sourceProject } : {}),
    ...(callbackProject ? { callback: callbackProject } : {}),
  };
  writeEvent(userPrompt);
  writeEvent({ type: 'system', subtype: 'dual_start', dual: { run, mode, base },
    text: `mode double : ${principal.model} (principal) et ${second.model} (second) en parallèle`,
    branches: [{ role: 'principal', ...principal }, { role: 'second', ...second }] });
  if (same) say('avertissement : principal et second identiques — le mode double n\'apporte presque rien.');
  say(`exécution ${run} — principal ${principal.provider}/${principal.model}, second ${second.provider}/${second.model}, mode ${mode}`);

  // ── 1. Copies isolées ────────────────────────────────────────────────────
  const branches = ROLES.map(role => ({
    role, ...(role === 'principal' ? principal : second),
    gitBranch: `dual/${run}/${role}`,
    wt: path.join(logsDir, 'dual', 'wt', projectName, role),
  }));
  const cleanupWorktrees = () => {
    for (const b of branches) {
      if (fs.existsSync(b.wt)) git(project.path, ['worktree', 'remove', '--force', b.wt]);
      try { fs.rmSync(b.wt, { recursive: true, force: true }); } catch {}
    }
    git(project.path, ['worktree', 'prune']);
  };
  cleanupWorktrees();   // reste d'une exécution interrompue
  for (const b of branches) {
    fs.mkdirSync(path.dirname(b.wt), { recursive: true });
    const r = git(project.path, ['worktree', 'add', '-b', b.gitBranch, b.wt, base]);
    if (!r.ok) {
      console.error(`[double] worktree impossible pour ${b.role} : ${r.err}`);
      cleanupWorktrees();
      for (const x of branches) git(project.path, ['branch', '-D', x.gitBranch]);
      try { fs.unlinkSync(pidPath); } catch {}
      writeEvent({ type: 'result', subtype: 'error_dual_setup', is_error: true, num_turns: 1, result: `mode double impossible : worktree ${b.role} — ${r.err}` });
      return 1;
    }
    // Dépendances non suivies (node_modules) : partagées par jonction, en lecture.
    const nm = path.join(project.path, 'node_modules');
    if (fs.existsSync(nm) && !fs.existsSync(path.join(b.wt, 'node_modules'))) {
      try { fs.symlinkSync(nm, path.join(b.wt, 'node_modules'), 'junction'); } catch {}
    }
  }

  // ── 2. Les deux branches en parallèle ────────────────────────────────────
  const heartbeat = setInterval(() => writeEvent({ type: 'system', subtype: 'dual_progress', dual: { run }, text: 'branches en cours' }), 60_000);
  const childEnv = { ...process.env, ORCH_OBS_ID: obsId || 'obs-dual-branch', ...(o.childEnvExtra || {}) };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'DISPATCH_SLOT', 'DISPATCH_TICKET']) delete childEnv[k];
  const runChild = (args, input) => new Promise((resolve) => {
    const c = spawn(process.execPath, [dispatchScript, ...args], { cwd: root, env: childEnv, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    c.on('error', () => resolve(127));
    c.on('exit', (code) => resolve(code ?? 1));
    c.stdin.end(input);
  });
  const t0 = Date.now();
  const codes = await Promise.all(branches.map(b => {
    const args = [projectName, '--prompt-stdin', '--model', b.model, '--provider', b.provider,
      '--dual-branch', `${run}:${b.role}`, '--dual-cwd', b.wt, '--no-queue-if-busy'];
    const text = branchPrompt(prompt, b.role, run, mode) + (o.stepPrompt ? `\n\n[ÉTAPE DE PIPELINE EN MODE DOUBLE] N'écris PAS le fichier ARTEFACT= ci-dessus (l'autre branche le ferait aussi) : mets son contenu COMPLET dans ta réponse finale. La relecture écrira l'artefact.` : '');
    const input = (o.imagePaths?.length || o.videoPaths?.length)
      ? JSON.stringify({ prompt: text, attachmentPaths: o.imagePaths || [], videoPaths: o.videoPaths || [] }) : text;
    b.startedAt = Date.now();
    return runChild(args, input).then(code => { b.endedAt = Date.now(); return code; });
  }));
  clearInterval(heartbeat);

  // ── 3. Figer et archiver chaque branche ──────────────────────────────────
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    const log = readBranchLog(path.join(dir, `${b.role}.jsonl`));
    Object.assign(b, branchStatus(codes[i], log));
    b.served = log.served;
    b.costUsd = Number.isFinite(log.result?.total_cost_usd) ? log.result.total_cost_usd : null;
    b.durationMs = log.result?.duration_ms || (b.endedAt - b.startedAt);
    b.log = path.join(dir, `${b.role}.jsonl`);
    const resultText = (typeof log.result?.result === 'string' && log.result.result.trim().length >= 20 ? log.result.result : log.lastText) || (b.ok ? '(aucun texte)' : `ÉCHEC : ${b.why}`);
    fs.writeFileSync(path.join(dir, `${b.role}.result.md`), `# Branche « ${b.role} » — ${b.provider}/${b.model}\n\n${resultText}\n`);
    if (mode === 'action' && fs.existsSync(b.wt)) {
      git(b.wt, ['add', '-A']);
      if (git(b.wt, ['status', '--porcelain']).out) {
        git(b.wt, ['-c', 'user.name=orchestrateur', '-c', 'user.email=orchestrateur@localhost', 'commit', '-q', '-m', `double ${run} : branche ${b.role} (${b.model})`]);
      }
      const diff = git(project.path, ['diff', `${base}..${b.gitBranch}`], { maxBuffer: 64 * 1024 * 1024 });
      fs.writeFileSync(path.join(dir, `${b.role}.diff`), diff.out ? diff.out + '\n' : '');
      b.diffstat = git(project.path, ['diff', '--shortstat', `${base}..${b.gitBranch}`]).out || 'aucune modification';
    }
    writeEvent({
      type: 'system', subtype: 'dual_branch_done', dual: { run, role: b.role },
      model: b.model, served: b.served, provider: b.provider, modelSource: 'flag',
      status: b.ok ? 'ok' : 'failed', error: b.ok ? undefined : b.why,
      costUsd: b.costUsd, durationMs: b.durationMs, diffstat: b.diffstat || null,
      log: path.relative(root, b.log).split(path.sep).join('/'),
      text: `branche ${b.role} (${b.model}) : ${b.ok ? 'terminée' : `ÉCHEC — ${b.why}`}`,
    });
    say(`branche ${b.role} (${b.model}) : ${b.ok ? 'ok' : `ÉCHEC — ${b.why}`} — ${b.diffstat || ''} — ${Math.round(b.durationMs / 1000)} s${b.costUsd != null ? ` — ${b.costUsd.toFixed(3)} $` : ''}`);
  }
  const [P, S] = branches;
  const failed = branches.filter(b => !b.ok);

  const finish = async (code, review) => {
    // Archive gardée (logs/dual/<run>) ; copies et branches git retirées.
    cleanupWorktrees();
    for (const b of branches) git(project.path, ['branch', '-D', b.gitBranch]);
    const summary = {
      type: 'system', subtype: 'dual_summary', dual: { run, mode, archive: path.relative(root, dir).split(path.sep).join('/') },
      branches: branches.map(b => ({ role: b.role, model: b.model, served: b.served, provider: b.provider, status: b.ok ? 'ok' : 'failed', error: b.ok ? undefined : b.why, costUsd: b.costUsd, durationMs: b.durationMs, diffstat: b.diffstat || null })),
      review: review || null,
      totalMs: Date.now() - started,
      text: `mode double terminé : ${branches.map(b => `${b.role} ${b.ok ? 'ok' : 'échec'}`).join(', ')}${review ? `, relecture ${review.status}` : ''}`,
    };
    writeEvent(summary);
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    say(summary.text + ` — archive : ${summary.dual.archive}`);
    return code;
  };

  // ── Le principal a échoué : PAUSE avec question, jamais de substitution ──
  if (!P.ok) {
    const q = `Le model principal ${P.model} a échoué (${P.why}). ` +
      (S.ok ? `Le second (${S.model}) a terminé : son travail est archivé dans ${path.relative(root, dir).split(path.sep).join('/')} (second.diff, second.result.md). ` : `Le second (${S.model}) a échoué aussi (${S.why}). `) +
      `Que faire : relancer avec le même principal, choisir un autre principal, ou retenir le travail du second tel quel ?`;
    writeEvent({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: `⏸ Mode double en pause : aucune relecture sans le principal (règle « aucun fallback »).\n\nNEEDS_USER_INPUT: ${q}` }] } });
    writeEvent({ type: 'result', subtype: 'success', is_error: false, dual_paused: true, num_turns: 1, duration_ms: Date.now() - started,
      result: `⏸ Mode double en pause : aucune relecture sans le principal (règle « aucun fallback »).\n\nNEEDS_USER_INPUT: ${q}` });
    try { fs.unlinkSync(pidPath); } catch {}
    await postNotify(root, callbackProject || 'chef', `[MODE DOUBLE — ${projectName}] ⏸ pause : ${q}`);
    // Le travail du second reste archivé : la branche git est gardée pour une reprise.
    cleanupWorktrees();
    git(project.path, ['branch', '-D', P.gitBranch]);
    const summary = { type: 'system', subtype: 'dual_summary', dual: { run, mode, paused: true, archive: path.relative(root, dir).split(path.sep).join('/') },
      branches: branches.map(b => ({ role: b.role, model: b.model, provider: b.provider, status: b.ok ? 'ok' : 'failed', error: b.ok ? undefined : b.why, costUsd: b.costUsd, durationMs: b.durationMs })),
      text: `mode double en pause : principal en échec` };
    writeEvent(summary);
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    say(`PAUSE : ${q}`);
    return 2;
  }

  // ── La seconde a échoué : l'utilisateur est prévenu, la relecture a lieu ─
  if (!S.ok) {
    writeEvent({ type: 'system', subtype: 'dual_branch_failed', dual: { run, role: 'second' }, model: S.model, error: S.why,
      text: `⚠ mode double : la branche seconde (${S.model}) a échoué — ${S.why}. La relecture se fait avec le seul travail du principal.` });
    await postNotify(root, callbackProject || 'chef', `[MODE DOUBLE — ${projectName}] ⚠ la branche seconde (${S.model}) a échoué : ${S.why}. Relecture avec le seul travail du principal.`);
  }

  // ── 4. Relecture par le principal, dans le vrai dépôt ────────────────────
  let testCommand = null;
  try { testCommand = JSON.parse(fs.readFileSync(path.join(project.path, '.orchestrateur', 'pipeline.json'), 'utf8')).testCommand || null; } catch {}
  const synth = synthesisPrompt({ prompt, run, mode, dir, branches, failed, testCommand });
  fs.writeFileSync(path.join(dir, 'relecture.prompt.md'), synth);
  const rArgs = [projectName, '--prompt-stdin', '--model', principal.model, '--provider', principal.provider, '--dual-synthesis', run, '--no-queue-if-busy', ...(o.synthesisArgs || [])];
  if (callbackProject) rArgs.push('--callback', callbackProject);
  if (sourceProject) rArgs.push('--source', sourceProject);
  const rStart = Date.now();
  // La relecture reprend la session du musicien, dont le coût est CUMULÉ : on
  // retranche le dernier coût connu de cette session pour un coût par étape.
  const linesBefore = (() => { try { return fs.readFileSync(projectLog, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } })();
  let sid = null;
  try { sid = fs.readFileSync(o.sessionFile || path.join(logsDir, `${projectName}.session`), 'utf8').trim() || null; } catch {}
  const prevCost = (() => {
    if (!sid) return 0;
    try {
      const evs = fs.readFileSync(projectLog, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const r = [...evs].reverse().find(e => e.type === 'result' && e.session_id === sid && Number.isFinite(e.total_cost_usd));
      return r ? r.total_cost_usd : 0;
    } catch { return 0; }
  })();
  const rCode = await runChild(rArgs, synth);
  // Seuls les événements écrits APRÈS le lancement de la relecture comptent.
  let fresh = [];
  try { fresh = fs.readFileSync(projectLog, 'utf8').split('\n').filter(Boolean).slice(linesBefore).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const rr = [...fresh].reverse().find(e => e.type === 'result') || null;
  const rServed = [...fresh].reverse().find(e => e.type === 'assistant' && e.message?.model && e.message.model !== '<synthetic>')?.message.model || null;
  const rawCost = Number.isFinite(rr?.total_cost_usd) ? rr.total_cost_usd : null;
  const review = {
    model: principal.model, provider: principal.provider, served: rServed,
    status: rr && !rr.is_error && rCode === 0 ? 'ok' : 'failed',
    costUsd: rawCost == null ? null : (rr.session_id && rr.session_id === sid ? Math.max(0, rawCost - prevCost) : rawCost),
    durationMs: rr?.duration_ms || (Date.now() - rStart),
  };
  if (mode === 'action') review.headAfter = git(project.path, ['rev-parse', 'HEAD']).out;
  return finish(rCode, review);
}
