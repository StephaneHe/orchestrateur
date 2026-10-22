#!/usr/bin/env node
// ============================================================================
// scripts/chef-turn.mjs — the chef's single turn (Routage v3, phase 2), SHADOW
// ============================================================================
//
// User decision of 2026-10-22 (« vas y »), docs/ROUTAGE-SYNTHESE.md §3.1, §3.9
// phase 2, decisions 2 (one chef turn on claude-sonnet-5-5, case
// `routage.chef`), 3 (classification task by task, in parallel) and 8 (typed
// actions, scripts/typed-operations.mjs). One turn replaces Lire, Comprendre,
// Découper and Rapporter:
//   [1] entry: direct paths are decided by the code, 0 model call;
//   [2] compact context written by the code, ONE call of the chef model;
//   [3] the ```plan block is extracted and repaired (plan-repair.mjs), with ONE
//       retry only (form unreadable, or a meaning problem the code never fixes);
//   [4] each task without a complete explicit choice is classified on its own,
//       all in parallel (case routage.classifier);
//   [5] the launch — NOT in this phase: the shadow says what WOULD be launched;
//   [6] a block of facts written by the code under the chef's prose.
// Infrastructure failures (OAuth, limit, refusal, no result) park the turn
// (§3.7): no retry for OAuth or a limit, one fresh retry for a refusal.
//
// SHADOW MODE (this phase): `model-routing.json` → `chefV3.shadow`, written by
// `node scripts/pipeline-enforce.mjs chef-shadow on|off`, re-read at each chef
// turn. When on, dispatch.mjs starts `chef-turn.mjs shadow` DETACHED next to
// the real chef turn of a user message: it reads the logs, calls the models,
// and writes ONLY logs/chef-shadow/ (its journal). It dispatches nothing,
// writes no session, no registry, no pending entry, no classify log. The real
// chef is untouched (chefMode stays what it is).
//
//   node scripts/chef-turn.mjs shadow --request <r-…> [--force]    (message on stdin)
//   node scripts/chef-turn.mjs corpus [--dir tests/routage-corpus] [--live] [--out <f>]
//   node scripts/chef-turn.mjs list [--n 20] | show <id>
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-file.mjs';
import { extractPlan, repairPlan, pendingFor } from './plan-repair.mjs';
import { chefActionsCatalogText } from './typed-operations.mjs';
import { routingContext, conversationExcerpt, pausedRuns, pidAlive } from './pipeline-engine.mjs';
import { classifyTask } from './pipeline-classify.mjs';
import { resolveClaudeBin } from './language.mjs';
import { infraFailure } from './model-backoff.mjs';
import { listRequests, summaryLine, TERMINAL } from './requests.mjs';
import { splitTodoLines } from './todo-capture.mjs';
import { chefDiscussion } from './chef-discussion.mjs';
import { matchOptionKey } from './pause-diagnosis.mjs';
import { readChefV3, writeChefV3 } from './pipeline-tuning.mjs';

export const CHEF_SLOT = 'routage.chef';
/** Decision 2 (2026-10-19): the chef's single turn runs on Sonnet 5.5 unless the case says otherwise. */
export const DEFAULT_CHEF_MODEL = 'claude-sonnet-5-5';
export const SHADOW_DIR = 'chef-shadow';
const RUN_RE = /\bp-\d{8}T\d{6}-[0-9a-f]{6}\b/g;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readConfig = (root) => readJson(path.join(root, 'config.json')) || { projects: [] };

// ---------------------------------------------------------------------------
// Settings: the shadow switch, the case
// ---------------------------------------------------------------------------

// The shadow switch lives in pipeline-tuning.mjs (with the other switches read by
// pipeline-enforce.mjs and dispatch.mjs); re-exported here.
export { readChefV3, writeChefV3 };

/** The model of the case routage.chef, or decision 2's default. */
export function chefCase(root) {
  const a = readJson(path.join(root, 'model-routing.json'))?.assignments?.[CHEF_SLOT] || null;
  if (a?.model && a.provider === 'anthropic') return { provider: 'claude', model: a.model, source: 'case' };
  if (a?.model) return { provider: a.provider, model: a.model, source: 'case' };
  return { provider: 'claude', model: DEFAULT_CHEF_MODEL, source: 'décision 2' };
}

// ---------------------------------------------------------------------------
// [1] Direct paths: decided by the code, never a model (§3.6)
// ---------------------------------------------------------------------------

const MENU_RE = /^(continue|continuer|reprends|reprendre|on continue|accepter?|abandonner|abandonne|annuler|simplifier|changer (?:de |le )?mod[eè]le?|tester (?:le )?mod[eè]le?|relance|relancer)$/i;
/**
 * → { path: 'todo'|'chef-discussion'|'menu'|'menu-ambigu'|'cancel_run'|'model', … }.
 * Only explicit forms: a TODO line, the /chef-discussion prefix, a bare menu
 * word (with the run cited, or the single paused run), « /abandonne p-… ».
 */
export function directPath(text, { paused = [] } = {}) {
  const s = String(text || '').trim();
  const t = splitTodoLines(s);
  if (t.todos.length && !t.rest) return { path: 'todo', todos: t.todos };
  if (chefDiscussion(s).on) return { path: 'chef-discussion' };
  const ab = /^\/abandonne\s+(p-\d{8}T\d{6}-[0-9a-f]{6})\s*$/i.exec(s);
  if (ab) return { path: 'cancel_run', run: ab[1] };
  const cited = [...s.matchAll(RUN_RE)].map(m => m[0]);
  const bare = s.replace(RUN_RE, '').replace(/[\s.!…:,;«»"]+/g, ' ').trim();
  const key = matchOptionKey(bare);
  if (bare && (MENU_RE.test(bare) || (key && key.length >= bare.length - 1))) {
    const run = cited[0] || (paused.length === 1 ? paused[0].run : null);
    return run ? { path: 'menu', run, answer: bare } : { path: 'menu-ambigu', answer: bare, open: paused.map(p => p.run) };
  }
  return { path: 'model', rest: t.todos.length ? t.rest : s, todos: t.todos };
}

// ---------------------------------------------------------------------------
// [2] Compact context and prompt
// ---------------------------------------------------------------------------

function queueSection(logsDir) {
  let files = [];
  try { files = fs.readdirSync(path.join(logsDir, 'queue')).filter(f => f.endsWith('.json')); } catch { return '(vide)'; }
  const out = [];
  for (const f of files) {
    const q = readJson(path.join(logsDir, 'queue', f));
    const list = Array.isArray(q) ? q : Array.isArray(q?.queue) ? q.queue : Array.isArray(q?.entries) ? q.entries : [];
    if (list.length) out.push(`- ${f.replace(/\.json$/, '')} : ${list.length} en file — ${list.slice(0, 3).map(e => `${e.id || '?'} « ${String(e.text || e.prompt || '').replace(/\s+/g, ' ').slice(0, 80)} »`).join(' ; ')}`);
  }
  return out.join('\n') || '(vide)';
}

/** The context the code gives to the chef's single turn: compact, nothing cut in silence. */
export function compactContext(root, { logsDir = path.join(root, 'logs'), now = Date.now() } = {}) {
  const cfg = readConfig(root);
  const conductor = cfg.conductor || 'chef';
  const chef = (cfg.projects || []).find(p => p.name === conductor);
  const chefLog = path.join(logsDir, `${conductor}.jsonl`);
  const projects = (cfg.projects || []).filter(p => p.name !== conductor && !/^chef-\d+$/.test(p.name));
  const open = listRequests(logsDir).filter(r => !TERMINAL.has(r.state));
  return [
    '# Projets (liste fermée : une tâche ne vise que l’un d’eux)', '',
    projects.map(p => `- ${p.name}${p.devOf ? ` (instance de développement de ${p.devOf})` : ''}`).join('\n') || '(aucun)', '',
    routingContext(root, { logsDir, chefLog, chefDir: chef?.path || root }), '',
    '## Demandes non terminées (registre, logs/requests/)', '',
    open.length ? open.slice(-15).map(r => `- ${summaryLine(r)}`).join('\n') + (open.length > 15 ? `\n⚠ [${open.length - 15} plus ancienne(s) non reprise(s) — node scripts/requests.mjs list]` : '') : '(aucune)', '',
    '## Files d’attente des musiciens', '', queueSection(logsDir), '',
    conversationExcerpt(chefLog, { max: 12, maxChars: 20_000 }),
  ].join('\n');
}

/** The single prompt of the chef (French: the discussion language; the plan keys are fixed). */
export function chefPrompt({ context, message, now = new Date() }) {
  return `[CHEF_V3] Tu es le chef d’orchestre. Réponds à l’utilisateur EN UN SEUL TOUR : comprends son message, réponds en prose (français), et si du travail doit partir, découpe-le en tâches unitaires dans un bloc de plan.

Règles du plan (le code le répare pour la forme, jamais pour le sens) :
- Termine TOUJOURS ta réponse par un bloc \`\`\`plan contenant un objet JSON ; \`{}\` s’il n’y a rien à lancer.
- Forme : {"taches": [{"ref": "a", "projet": "<un projet de la liste>", "titre": "<3 à 60 caractères, distinct>", "demande": "<texte complet et autonome pour le musicien>", "apres": ["<ref>"], "pipeline": "<seulement si l’utilisateur l’a choisi>", "mode": "<idem>", "session_neuve": true, "meme_tache": true, "hors_pipeline": "<mots EXACTS de l’utilisateur qui l’autorisent>"}], "actions": [{"ref": "b", "action": "<action typée>", "cible": "<p-… ou projet>", "apres": ["a"], "raison": "…"}], "reprises": [{"ref": "c", "run": "p-…", "message": "…"}], "question": "<une question à l’utilisateur, si le sens est ambigu>"}
- Une tâche = un projet et une seule nature de travail. « puis » = « apres » vers la tâche ou l’action précédente (références locales ; une action peut attendre une tâche et inversement).
- Une reprise d’exécution en pause seulement si l’utilisateur la demande explicitement ; un identifiant cité n’est qu’une référence.
- Le chef ne se lance pas de tâche : ce que tu fais toi-même sur l’orchestration passe par une action typée, liste fermée :
${chefActionsCatalogText()}
- « abandonner » une exécution = cancel_run (jamais stop_turn) ; arrêter un tour qui tourne = stop_turn.
- Sens ambigu ou projet incertain : pose la question dans « question » au lieu de deviner.
- Ne recopie pas d’état (lancé, en file) : le code l’écrit lui-même sous ta réponse.

Date : ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC

${context}

# Message de l’utilisateur

<<<
${message}
>>>`;
}

// ---------------------------------------------------------------------------
// The call (stdin, stream-json: a long context never hits the command-line cap)
// ---------------------------------------------------------------------------

/**
 * One exchange with the chef model through the CLI, no tools, in a temporary
 * folder (no project, no session written by the orchestrator).
 * → { ok, text, result, code, served, ms, why? }
 */
export function callChefModel(prompt, { model, timeoutMs = 240_000, env = process.env, resume = null } = {}) {
  return new Promise((resolve) => {
    const bin = resolveClaudeBin(env);
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model,
      '--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands', '--max-turns', '1',
      '--disallowed-tools', 'Bash,Edit,Write,NotebookEdit,PowerShell', ...(resume ? ['--resume', resume] : []), '--verbose'];
    const childEnv = { ...env };
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ORCH_REQUEST_ID', 'ORCH_TURN_ID']) delete childEnv[k];
    const isJs = /\.(mjs|js|cjs)$/i.test(bin);
    const t0 = Date.now();
    let c;
    try { c = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, { cwd: os.tmpdir(), env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ ok: false, code: null, why: `lancement impossible : ${e.message}`, ms: 0 }); return; }
    let out = '', err = '';
    const timer = setTimeout(() => { try { c.kill(); } catch {} }, timeoutMs);
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.stdin.on('error', () => {});
    c.on('error', e => { clearTimeout(timer); resolve({ ok: false, code: null, why: e.message, ms: Date.now() - t0 }); });
    c.on('close', (code) => {
      clearTimeout(timer);
      let result = null, served = null;
      for (const line of out.split(/\r?\n/)) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init' && ev.model) served = ev.model;
        if (ev.type === 'result') result = ev;
      }
      const text = typeof result?.result === 'string' ? result.result : '';
      const ok = code === 0 && result && !result.is_error && text.trim();
      resolve({ ok: !!ok, text, result, code, served, ms: Date.now() - t0, session: result?.session_id || null,
        costUsd: result?.total_cost_usd ?? null, ...(ok ? {} : { why: String(result?.result || err || `code ${code}`).replace(/\s+/g, ' ').slice(0, 300) }) });
    });
    c.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
  });
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** Infrastructure failure of a call → { cause, until?, detail } | null (§3.7). */
export function callFailure(r) {
  if (r.ok) return null;
  const inf = infraFailure({ code: r.code ?? 1, log: { result: r.result || null } });
  if (inf) return inf;
  return { cause: 'exit', detail: r.why || 'sortie sans résultat' };
}

/** run id → { status, project, alive } (read only), for the repair of resumes. */
export function runInfoFrom(logsDir) {
  return (run) => {
    const st = readJson(path.join(logsDir, 'runs', run, 'run.json'));
    return st ? { status: st.status, project: st.project, alive: st.status === 'running' ? pidAlive(st.pid) : false } : null;
  };
}

/**
 * The single chef turn, without any effect. Calls: 1 (+1 retry of the plan
 * only, + infrastructure retries) for the chef, then one classifier call per
 * task needing it, in parallel.
 * deps: { call(prompt, {model}) → callChefModel shape, classify(task) →
 *         classifyTask shape, delays: [ms] for exits without result }
 * → { path, prose, plan, repaired, attempts: [...], classification, facts, parked?, ms }
 */
export async function runChefTurn({ root, logsDir = path.join(root, 'logs'), message, userTexts = null, context = null, now = new Date(),
  call = null, classify = null, delays = [30_000, 120_000], env = process.env } = {}) {
  const t0 = Date.now();
  const cfg = readConfig(root);
  const conductor = cfg.conductor || 'chef';
  const projects = (cfg.projects || []).map(p => p.name).filter(Boolean);
  const direct = directPath(message, { paused: pausedRuns(logsDir) });
  if (direct.path !== 'model') return { path: direct.path, direct, calls: 0, attempts: [], ms: Date.now() - t0 };

  const kase = chefCase(root);
  const callFn = call || ((p, o) => callChefModel(p, { ...o, env }));
  const ctx = context ?? compactContext(root, { logsDir });
  const prompt = chefPrompt({ context: ctx, message: direct.rest, now });
  const attempts = [];
  const ask = async (p, why) => {
    let refusals = 0, exits = 0;
    for (;;) {
      const r = await callFn(p, { model: kase.model });
      const fail = callFailure(r);
      attempts.push({ why, ok: r.ok, ms: r.ms ?? null, model: kase.model, served: r.served || null, costUsd: r.costUsd ?? null, ...(fail ? { failure: fail } : {}) });
      if (!fail) return { r };
      if (fail.cause === 'refusal' && refusals++ < 1) { why = 'refus du fournisseur : un essai en session neuve'; continue; }
      if (fail.cause === 'exit' && exits < delays.length) { await sleep(delays[exits++]); why = `sortie sans résultat : nouvel essai ${exits}`; continue; }
      return { parked: fail };
    }
  };
  const first = await ask(prompt, 'tour du chef');
  if (first.parked) return { path: 'model', parked: first.parked, attempts, calls: attempts.length, contextChars: ctx.length, model: kase, ms: Date.now() - t0, facts: parkedText(first.parked) };
  let ex = extractPlan(first.r.text);
  const texts = userTexts || [message];
  const opts = { projects, conductor, userTexts: texts, runInfo: runInfoFrom(logsDir), pending: pendingFor(logsDir) };
  let rep = ex.ok ? repairPlan(ex.plan, opts) : null;
  let retried = null;
  // ONE retry: an unreadable plan, or a meaning problem the code does not fix.
  if (!ex.ok || rep.retry) {
    retried = ex.ok ? rep.retry.problems.map(p => p.why) : [ex.why];
    const fix = ex.ok ? rep.retry.prompt : `[CHEF_V3] CORRECTION DU PLAN. ${ex.why}. Réponds de nouveau, même prose, terminée par le bloc \`\`\`plan (un objet JSON ; \`{}\` s’il n’y a rien à lancer).`;
    const second = await ask(`${prompt}\n\n# Ta réponse précédente\n\n${first.r.text}\n\n${fix}`, 'nouvel essai du plan');
    if (second.parked) return { path: 'model', parked: second.parked, prose: ex.prose, attempts, calls: attempts.length, contextChars: ctx.length, model: kase, ms: Date.now() - t0, facts: parkedText(second.parked) };
    const ex2 = extractPlan(second.r.text);
    if (ex2.ok) { ex = ex2; rep = repairPlan(ex.plan, { ...opts, final: true }); }
    else if (ex.ok) rep = repairPlan(ex.plan, { ...opts, final: true });
    else { ex = ex2; rep = null; }
  }
  if (!rep) {
    return { path: 'model', prose: ex.prose, plan: null, repaired: null, unreadable: ex.why, attempts, calls: attempts.length, contextChars: ctx.length, model: kase, ms: Date.now() - t0,
      facts: `[Routeur] Aucune tâche lancée : le plan est resté illisible après un nouvel essai (${ex.why}). La demande passe « à traiter ».` };
  }
  const classification = await classifyItems(root, rep.items, { classify, env });
  const out = { path: 'model', prose: ex.prose, plan: ex.plan, repaired: rep, retried, classification, attempts, calls: attempts.length, contextChars: ctx.length, model: kase, ms: Date.now() - t0 };
  out.facts = factsBlock(out);
  return out;
}

/**
 * [4] Each task without a complete explicit choice is classified on its own,
 * all at once (decision 3). A failure after the classifier's own retry ⇒
 * `à_classer`; a gap ⇒ `à_traiter` (« choisir un pipeline »); an ambiguity ⇒
 * a question. Nothing is written (no classify log). Mutates items' state.
 */
export async function classifyItems(root, items, { classify = null, env = process.env } = {}) {
  const todo = items.filter(it => it.kind === 'tache' && ['prête', 'en_attente_de'].includes(it.state) && !it.horsPipeline);
  const cls = classify || ((task, fixed) => classifyTask({ root, logsDir: null, task, fixed, env }));
  const t0 = Date.now();
  const res = await Promise.all(todo.map(async (it) => {
    const fixed = { ...(it.pipeline ? { pipeline: it.pipeline } : {}), ...(it.mode ? { mode: it.mode } : {}) };
    const s = Date.now();
    let r; try { r = await cls({ projet: it.projet, demande: it.demande }, fixed); } catch (e) { r = { failed: true, why: e.message }; }
    return { it, r, ms: Date.now() - s };
  }));
  for (const { it, r, ms } of res) {
    it.classifiedMs = ms;
    if (r.failed) { it.state = 'à_classer'; it.error = { code: 'à_classer', why: `classement en échec deux fois : ${r.why}`, actions: ['« /dev /léger » (préfixe)', 'requests.mjs fix --pipeline', 'annuler'] }; }
    else if (r.lacune) { it.state = 'à_traiter'; it.error = { code: 'lacune', why: `aucun pipeline adapté : ${r.lacune}`, actions: ['choisir un pipeline', 'tour ordinaire autorisé', 'annuler'] }; }
    else if (r.question) { it.state = 'à_traiter'; it.error = { code: 'question', why: r.question, actions: ['répondre', 'annuler'] }; }
    else if (r.chef) { it.state = 'à_traiter'; it.error = { code: 'chef', why: `le classement y voit un travail du chef (${r.chef})`, actions: ['action typée', 'annuler'] }; }
    else { it.pipeline = r.pipeline; it.mode = r.mode; if (r.kind) it.nature = r.kind; it.classifier = r.classifier || null; }
  }
  // A dependant of a task that cannot start waits for a decision too.
  const byRef = new Map(items.map(i => [i.ref, i]));
  for (const it of items) if (it.state === 'en_attente_de') {
    const b = it.apres.map(r => byRef.get(r)).find(p => p && ['à_traiter', 'à_classer'].includes(p.state));
    if (b) { it.state = 'à_traiter'; it.error = { code: 'prédécesseur', why: `${b.ref} est ${b.state}`, actions: [`réparer ${b.ref}`, `lancer ${it.ref} sans ${b.ref} (autorisation)`, `annuler ${it.ref}`] }; }
  }
  return { calls: todo.filter(it => it.state === 'à_classer' || String(it.classifier || '').startsWith('model:')).length, tasks: todo.length, ms: Date.now() - t0, parallel: true };
}

/** [6] The facts the code writes under the chef's prose (shadow: « would »). */
export function factsBlock(o, { shadow = true } = {}) {
  const v = shadow ? { go: 'Serait lancé', wait: 'Attendrait', todo: 'À traiter', out: 'Écarté' } : { go: 'Lancé', wait: 'En attente de', todo: 'À traiter', out: 'Écarté' };
  const L = [];
  const lab = (it) => it.kind === 'tache' ? `${it.ref} ${it.projet} « ${it.titre} »${it.pipeline ? ` (${it.pipeline}${it.mode ? ` ${it.mode}` : ''})` : ''}`
    : it.kind === 'action' ? `${it.ref} action ${it.action}${it.cible ? ` → ${it.cible}` : ''}` : `${it.ref} reprise ${it.run}`;
  for (const it of o.repaired?.items || []) {
    if (it.state === 'prête') L.push(`- ${v.go} : ${lab(it)}${it.vague > 1 ? ` (vague ${it.vague})` : ''}`);
    else if (it.state === 'en_attente_de') L.push(`- ${v.wait} ${it.apres.join(', ')} : ${lab(it)}`);
    else if (['à_traiter', 'à_classer'].includes(it.state)) L.push(`- ${v.todo} : ${lab(it)} — ${it.error?.why || it.state}`);
    else if (it.state === 'écartée') L.push(`- ${v.out} (doublon) : ${lab(it)}`);
    else if (it.state === 'refusée') L.push(`- Rien à faire : ${lab(it)}`);
  }
  const notes = (o.repaired?.notes || []).map(n => `- ${n}`);
  return [L.length ? L.join('\n') : '- Aucune tâche', ...(notes.length ? ['', ...notes] : []), ...(o.repaired?.question ? ['', `Question : ${o.repaired.question}`] : [])].join('\n');
}

/** The message written by the code for a parked turn (§3.7 template). */
export function parkedText(p) {
  const what = { auth: 'la session Claude (OAuth) a expiré', limit: `limite d’utilisation Claude atteinte${p.until ? ` jusqu’à ${p.until}` : ''}`, refusal: 'le fournisseur a refusé la demande, même en session neuve', exit: 'le model n’a rendu aucun résultat après les nouveaux essais' }[p.cause] || p.cause;
  const next = p.cause === 'auth' ? 'reconnectez Claude (`claude /login`), puis « relance »' : p.cause === 'limit' ? 'relance automatique à la fin de la limite' : 'relance automatique à 5, 15 puis 30 min';
  return `⚠ Ce qui s’est passé : ${what}${p.detail ? ` (${String(p.detail).slice(0, 160)})` : ''}\n✓ Ce que j’ai fait : votre message est gardé ; ${next}\n→ Vous pouvez répondre : « relance » · « abandonne »`;
}

// ---------------------------------------------------------------------------
// Shadow journal (logs/chef-shadow/) — the ONLY place the shadow writes
// ---------------------------------------------------------------------------

export function shadowDir(logsDir) { return path.join(logsDir, SHADOW_DIR); }
export function writeShadow(logsDir, rec) {
  const dir = shadowDir(logsDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = rec.id || `s-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
  const full = { ...rec, id };
  writeFileAtomic(path.join(dir, `${id}.json`), JSON.stringify(full, null, 2), path.join(dir, `${id}.json.${process.pid}.tmp`));
  const it = rec.result?.repaired?.items || [];
  const line = { at: rec.at, id, request: rec.request || null, path: rec.result?.path || null, calls: rec.result?.calls ?? 0, ms: rec.result?.ms ?? null,
    model: rec.result?.model?.model || null, retried: !!rec.result?.retried, parked: rec.result?.parked?.cause || null,
    states: it.reduce((m, x) => ({ ...m, [x.state]: (m[x.state] || 0) + 1 }), {}), classifyMs: rec.result?.classification?.ms ?? null, error: rec.error || null };
  fs.appendFileSync(path.join(dir, 'journal.ndjson'), JSON.stringify(line) + '\n');
  return full;
}

/** dispatch.mjs: start the shadow next to a chef turn, detached; never blocks nor fails the turn. */
export function spawnShadow({ root, request, text, env = process.env }) {
  const childEnv = { ...env };
  for (const k of ['ORCH_REQUEST_ID', 'ORCH_TURN_ID', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ANTHROPIC_API_KEY']) delete childEnv[k];
  try {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), 'shadow', '--request', request || '-'], { cwd: root, env: childEnv, detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    c.on('error', () => {});
    c.stdin.on('error', () => {});
    c.stdin.end(String(text || ''));
    c.unref();
    return c.pid || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Corpus replay (tests/routage-corpus/): the real refused cases of the prod
// ---------------------------------------------------------------------------

/**
 * Replays every case: by default its recorded v3 plan goes through the repair
 * and the classifier double (no model); `live` sends its message to the real
 * chef model instead (a bench, outside the regression). Effects: none.
 */
export async function replayCorpus({ root, dir, live = false, classify = null, call = null, env = process.env }) {
  const corpus = readJson(path.join(dir, 'cases.json'));
  if (!corpus?.cases) throw new Error(`corpus illisible : ${path.join(dir, 'cases.json')}`);
  const cfgProjects = corpus.projects || [];
  const out = [];
  for (const c of corpus.cases) {
    const runInfo = (run) => c.runs?.[run] || null;
    const opts = { projects: c.projects || cfgProjects, conductor: 'chef', userTexts: [c.message, ...(c.userLines || [])], runInfo, pending: c.pending || [] };
    let repaired, prose = null, calls = 0, parked = null, retried = false;
    if (c.infra && !live) {
      // The real path of the turn, with the recorded failure as the model's answer.
      const res = await runChefTurn({ root, message: c.message, context: '(contexte non rejoué)', delays: [0, 0], call: async () => ({ ok: false, code: 1, result: c.infra.result, why: String(c.infra.result?.result || '').slice(0, 200) }) });
      parked = res.parked || null; calls = res.calls;
    } else if (live) {
      const res = await runChefTurn({ root, message: c.message, context: c.context || '(contexte non rejoué)', call, classify, env });
      repaired = res.repaired; prose = res.prose; calls = res.calls; parked = res.parked || null;
    } else {
      let rep = repairPlan(c.plan, opts);
      if (rep.retry) { retried = true; rep = repairPlan(c.retryPlan || c.plan, { ...opts, final: true }); }
      await classifyItems(root, rep.items, { classify: classify || ((t, fixed) => Promise.resolve(c.classify?.[t.projet] || { pipeline: fixed.pipeline || 'discussion', mode: fixed.mode || 'leger', classifier: 'corpus' })) });
      repaired = rep;
    }
    out.push({ id: c.id, kind: c.kind, repaired, prose, calls, parked, retried, verdict: judgeCase(c, { repaired, parked, calls, retried }) });
  }
  return out;
}

/** What every corpus case must show (§3.10): checked by the code. */
export function judgeCase(c, { repaired, parked, calls = null, retried = null }) {
  const fails = [];
  const items = repaired?.items || [];
  const byRef = new Map(items.map(i => [i.ref, i]));
  const e = c.expect || {};
  if (c.infra) {
    if (!parked) fails.push('panne d’infrastructure non reconnue');
    else if (e.cause && parked.cause !== e.cause) fails.push(`cause ${parked.cause}, attendue ${e.cause}`);
    if (e.calls != null && calls != null && calls !== e.calls) fails.push(`${calls} appel(s) du model, attendu ${e.calls} (OAuth et limite : aucun nouvel essai ; refus : un seul, en session neuve)`);
    return { ok: !fails.length, fails };
  }
  if (!repaired) return { ok: false, fails: ['aucun plan réparé'] };
  if (e.retry != null && retried != null && e.retry !== retried) fails.push(e.retry ? 'nouvel essai attendu (dépendance invalide)' : 'nouvel essai inattendu');
  // No global refusal: the plan is never rejected as a whole.
  if (e.launchAtLeast != null && items.filter(i => ['prête', 'en_attente_de'].includes(i.state)).length < e.launchAtLeast) fails.push(`moins de ${e.launchAtLeast} élément(s) lancé(s) ou en attente`);
  // No constraint removed: every « puis » of the case is still there.
  for (const [a, b] of e.order || []) {
    const it = byRef.get(b);
    if (!it || !it.apres.includes(a)) fails.push(`« ${b} après ${a} » perdu`);
  }
  // No resume that was not asked for.
  const resumes = items.filter(i => i.kind === 'reprise' && i.state !== 'refusée').map(i => i.run);
  for (const r of resumes) if (!(e.resumes || []).includes(r)) fails.push(`reprise non demandée de ${r}`);
  for (const r of e.resumes || []) if (!resumes.includes(r)) fails.push(`reprise demandée de ${r} absente`);
  for (const r of e.noResume || []) if (items.some(i => i.kind === 'reprise' && i.run === r)) fails.push(`${r} cité devient une reprise`);
  // cancel_run, never stop_turn, to abandon a run.
  for (const run of e.cancelRun || []) {
    if (!items.some(i => i.kind === 'action' && i.action === 'cancel_run' && i.params.run === run)) fails.push(`cancel_run ${run} absent`);
    if (items.some(i => i.kind === 'action' && i.action === 'stop_turn')) fails.push('stop_turn utilisé pour abandonner une exécution');
  }
  // Nothing sent to the chef as a musician task.
  if (items.some(i => i.kind === 'tache' && ['prête', 'en_attente_de'].includes(i.state) && /^chef(-\d+)?$/.test(i.projet))) fails.push('tâche lancée vers le chef');
  if (e.toTreat != null && items.filter(i => ['à_traiter', 'à_classer'].includes(i.state)).length !== e.toTreat) fails.push(`${items.filter(i => ['à_traiter', 'à_classer'].includes(i.state)).length} à traiter, attendu ${e.toTreat}`);
  if (e.question && !repaired.question) fails.push('question attendue absente');
  return { ok: !fails.length, fails };
}

// ---------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(here, '..');
  const LOGS = path.join(ROOT, 'logs');
  const argv = process.argv.slice(2);
  const flag = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1] ?? null; };
  const cmd = argv[0];
  if (cmd === 'shadow') {
    const force = argv.includes('--force');
    if (!force && !readChefV3(ROOT).shadow) { console.error('[chef-turn] ombre coupée (node scripts/pipeline-enforce.mjs chef-shadow on) : rien fait'); process.exit(2); }
    const text = await new Promise((resolve) => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { b += d; }); process.stdin.on('end', () => resolve(b)); });
    if (!text.trim()) { console.error('[chef-turn] message vide'); process.exit(64); }
    const at = new Date().toISOString();
    let result = null, error = null;
    try { result = await runChefTurn({ root: ROOT, logsDir: LOGS, message: text }); } catch (e) { error = e.message; }
    const rec = writeShadow(LOGS, { at, request: flag('--request') !== '-' ? flag('--request') : null, message: text, result, error });
    console.log(`[chef-turn] ombre ${rec.id} : ${result?.path || 'erreur'}, ${result?.calls ?? 0} appel(s), ${result?.ms ?? '?'} ms${error ? ` — ${error}` : ''}`);
    process.exit(error ? 1 : 0);
  }
  if (cmd === 'corpus') {
    const dir = path.resolve(flag('--dir') || path.join(here, '..', 'tests', 'routage-corpus'));
    const res = await replayCorpus({ root: ROOT, dir, live: argv.includes('--live') });
    const bad = res.filter(r => !r.verdict.ok);
    for (const r of res) console.log(`${r.verdict.ok ? 'OK' : 'KO'}  ${r.id} (${r.kind})${r.verdict.ok ? '' : ` — ${r.verdict.fails.join(' ; ')}`}`);
    console.log(`${res.length - bad.length}/${res.length} cas conformes`);
    if (argv.includes('--live')) { const f = flag('--out') || path.join(shadowDir(LOGS), `corpus-${Date.now()}.json`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(res, null, 2)); console.log(`détail : ${f}`); }
    process.exit(bad.length ? 1 : 0);
  }
  if (cmd === 'list') {
    const n = Number(flag('--n')) || 20;
    let lines = []; try { lines = fs.readFileSync(path.join(shadowDir(LOGS), 'journal.ndjson'), 'utf8').trim().split('\n').filter(Boolean).slice(-n); } catch {}
    if (!lines.length) console.log('Aucun tour en ombre.');
    for (const l of lines) { const j = JSON.parse(l); console.log(`${j.id}  ${j.at}  ${j.request || '—'}  ${j.path}  ${j.calls} appel(s)  ${j.ms ?? '?'} ms${j.parked ? `  garée (${j.parked})` : ''}  ${Object.entries(j.states || {}).map(([k, v]) => `${k}:${v}`).join(' ')}`); }
    process.exit(0);
  }
  if (cmd === 'show') {
    const r = readJson(path.join(shadowDir(LOGS), `${argv[1]}.json`));
    if (!r) { console.error(`inconnu : ${argv[1]}`); process.exit(64); }
    console.log(JSON.stringify(r, null, 2)); process.exit(0);
  }
  console.error('usage: node scripts/chef-turn.mjs shadow --request <r-…> [--force] (message sur stdin) | corpus [--dir d] [--live] [--out f] | list [--n 20] | show <id>');
  process.exit(64);
}
