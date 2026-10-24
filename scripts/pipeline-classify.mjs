// ============================================================================
// scripts/pipeline-classify.mjs — entry classification by the model of the
// `routage.classifier` slot (pipelines, phase 5, 0.52.0)
// ============================================================================
//
// Plan §1.3: an entry without an explicit choice (selector, `/prefix`,
// `--pipeline`) is classified by the model the user assigned to the
// `routage.classifier` slot in the Models page (any provider since 0.53.0:
// Claude and codex via their CLI, OpenRouter and NVIDIA via their API). The
// output is a validated JSON object; an invalid answer gets one retry.
// Since 0.66.0 there is NO keyword fallback (user request, 2026-10-10: « Ce
// n'est pas une recherche de mot qui pourra faire un routage efficace, c'est
// une recherche de sens que seul un modele peut faire »): an empty slot, a
// missing key or a model failing twice gives { failed } — the caller pauses
// and asks the user; only an explicit choice (prefix, flag) skips the model.
// Every decision (or failure) is traced in logs/pipeline-classify.ndjson.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { oneShotClaude, chatCompletion } from './language.mjs';
import { explicitChoice, normalizeText } from './pipeline-observe.mjs';
import { PIPELINES, applyCustom } from './model-pipelines.mjs';
import { effectiveCustom } from './inert-custom.mjs';
import { readTuning, tuningFor } from './pipeline-tuning.mjs';
import { OPERATION_IDS } from './typed-operations.mjs';

export const CLASSIFIER_SLOT = 'routage.classifier';
export const CLASSIFY_FILE = 'pipeline-classify.ndjson';
const PROVIDER_OF = { anthropic: 'claude', openai: 'codex', nvidia: 'nvidia', openrouter: 'openrouter' };
// Routage is the chef's own pipeline: a musician entry is never classified into it.
// Pipelines phase 1 (docs/PIPELINES-SYNTHESE.md §3, decision 4): two generic
// pipelines and three generic modes of existing ones, offered with the switch
// `generic` only. Their rule is one of MEANING for the model (never keywords).
export const GENERIC_PIPELINES = ['operations', 'fichiers'];
export const GENERIC_MODES = { redaction: ['document'], discussion: ['verification'], recherche: ['interne'] };
// Never a destination of a request: the chef's Routage and the knowledge index's model cases (0.131.0).
const NOT_ROUTED = new Set(['routage', 'kg']);
const CHOICES = PIPELINES.filter(p => !NOT_ROUTED.has(p.id) && !GENERIC_PIPELINES.includes(p.id) && p.id !== 'exploitation' && p.id !== 'design');
export const GENERIC_RULE = 'Specialised pipelines first, then the generic ones, then discussion for a pure question. ' +
  'operations = running ONE or a few operations on the project or its environment, no code to write: git push, git tag, push a tag, restore files to the last commit, prepare the production jump (plan only), publish the APK on the downloads page, install an APK on the device, restart a declared service, run a declared script → operations, never maintenance (maintenance upkeeps code) nor dev. ' +
  `For operations, set "operations" to the ordered list of ALL the operations the task asks for — every one of them, e.g. publishing then installing is two — each {"id": one of ${OPERATION_IDS.join(', ')}, "params": the parameters the request gives (e.g. {"remote": "origin"}, {"tag": "v1.2.0"})}, and "autorisation" to the user's EXACT words that ask for or authorize them when the request quotes them. ` +
  'fichiers = the files themselves, not their content: download a video or a file from a URL, copy, move, rename or delete files, compare two folders → fichiers (not video/audio/images, which transform media; not reunion, which files a meeting; not maintenance). ' +
  'redaction with mode "document" = a one-off piece of work on an EXISTING document the request names: proofread, summarize, translate, reformat, complete (e.g. add two items to a TODO_LIST.md) or convert it; writing a NEW text stays redaction with its usual mode. ' +
  'discussion with mode "verification" = check or compare and answer with verified findings (« vérifie que… », « compare… »), nothing modified. ' +
  'recherche with mode "interne" = research in the repository and its logs only, without the web. ';
const genericRule = (choices) => (choices.some(p => GENERIC_PIPELINES.includes(p.id)) ? GENERIC_RULE : '') + exploitationRule(choices) + designRule(choices);
// The light Exploitation lane (0.141.0, switch `exploitation`): a rule of MEANING for the model, never keywords.
export const EXPLOITATION_PIPELINE = 'exploitation';
export const EXPLOITATION_RULE = 'exploitation = a small one-off OPERATIONS task on the project or its machine, no code to write and no new behaviour: install a tool, configure, start or restart a service, publish a local service on the tailnet (tailscale serve), a firewall rule, a scheduled task, change a configuration value, declare a service or a script in .orchestrateur/pipeline.json, a small fix of a doc or config file → exploitation, never dev (even with « puis » / several steps) nor maintenance. ' +
  'Writing or changing code, tests, a feature or a behaviour → dev, never exploitation. ';
const exploitationRule = (choices) => (choices.some(p => p.id === EXPLOITATION_PIPELINE)
  ? `${EXPLOITATION_RULE}${choices.some(p => p.id === 'operations') ? 'operations only when every operation is one of its closed list (push, tag, restore, prod jump plan, publish or install the APK, restart a DECLARED service, run a DECLARED script); any other operations task → exploitation. ' : ''}`
  : '');
// The Design pipeline (0.146.0, switch `design`): a rule of MEANING for the model, never keywords.
export const DESIGN_PIPELINE = 'design';
export const DESIGN_RULE = 'design = the VISUAL quality of an EXISTING interface, judged on its rendered screens: it looks ugly, empty, cluttered, unprofessional or badly presented; redo the style, the layout, the presentation, the UI polish, colours, typography, spacing, readability on mobile — without a new feature nor a new behaviour → design, never dev nor redaction. ' +
  'A new screen, a new function, a fix of what the interface DOES (a button that does nothing, wrong data) → dev, never design. ';
const designRule = (choices) => (choices.some(p => p.id === DESIGN_PIPELINE) ? DESIGN_RULE : '');
const modeList = (choices) => (choices.some(p => GENERIC_PIPELINES.includes(p.id)) ? '"leger"|"complet"|"document"|"verification"|"interne"' : '"leger"|"complet"');
const opFields = (choices) => (choices.some(p => GENERIC_PIPELINES.includes(p.id)) ? ',"operations":[{"id":"<optional>","params":{}}],"autorisation":"<optional>"' : '');

/** Pipelines offered to the model: the Models page structure, accepted gaps included (their description, never keywords). */
export function classifierChoices(root, { generic = false, exploitation = false, design = false } = {}) {
  let custom = null;
  // Decision 7 (switch inertCleanup): non-executable pipelines and keyword attachments are not offered.
  try { custom = effectiveCustom(JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8'))) || null; } catch { /* no file */ }
  // Phase 1: the generic pipelines are offered only with the switch `generic` (off = exactly as before);
  // the Exploitation lane only with its own switch (0.141.0), the Design pipeline likewise (0.146.0).
  const keep = (p) => !NOT_ROUTED.has(p.id) && (generic || !GENERIC_PIPELINES.includes(p.id)) && (exploitation || p.id !== EXPLOITATION_PIPELINE) && (design || p.id !== DESIGN_PIPELINE);
  try { return applyCustom(custom).filter(keep); } catch { return CHOICES.filter(keep); }
}

/** Is the switch `generic` on for this project (pipeline-tuning.mjs, re-read at each call)? */
export function genericFor(root, project) {
  try { return !!tuningFor(readTuning(root), project || '').generic; } catch { return false; }
}
/** Is the switch `exploitation` on for this project (0.141.0, re-read at each call)? */
export function exploitationFor(root, project) {
  try { return !!tuningFor(readTuning(root), project || '').exploitation; } catch { return false; }
}

/** Is the switch `design` on for this project (0.146.0, re-read at each call)? */
export function designFor(root, project) {
  try { return !!tuningFor(readTuning(root), project || '').design; } catch { return false; }
}

/** The assigned classifier model, or null when the slot is empty. */
export function classifierCase(root) {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')).assignments?.[CLASSIFIER_SLOT] || null; } catch { /* no file */ }
  if (!a?.model || !PROVIDER_OF[a.provider]) return null;
  return { model: a.model, provider: PROVIDER_OF[a.provider] };
}

// 0.110.0 (user request 2026-10-16): a meeting request had been sent to
// Maintenance, which upkeeps CODE. A rule of meaning for the model, never a
// keyword match.
const MEETING_RULE = 'Managing the minutes or the files of a MEETING (record the final e-mail or minutes the user sent, delete drafts, file the recording, transcript, opinion or notes so they can be found under a name) → reunion, never maintenance (maintenance only upkeeps code: dependencies, git history, flaky tests, technical debt). Writing a new text ABOUT a meeting (an e-mail or message after it) may also go to reunion: it routes internally to the Rédaction steps when needed; a writing request with no link to a meeting → redaction. ';
const meetingRule = (choices) => (choices.some(p => p.id === 'reunion') ? MEETING_RULE : '');

// Nature of a dev request (case variants; « mecanique » has no red test).
const KINDS = { comportement: 'simple', simple: 'simple', bugfix: 'bugfix', mecanique: 'mecanique', 'mécanique': 'mecanique' };

/** `fixed`: what the user already chose explicitly (pipeline and/or mode) — the model fills the rest. */
export function classificationPrompt(text, fixed = {}, choices = CHOICES) {
  const list = choices.map(p => `- ${p.id}: ${p.label} — ${p.when || p.purpose || ''}`).join('\n');
  const imposed = [fixed.pipeline && `pipeline "${fixed.pipeline}"`, fixed.mode && `mode "${fixed.mode}"`].filter(Boolean);
  return '[CLASSIFY] You route requests sent to a software project agent, by their MEANING. Pick the ONE pipeline that fits the request below.\n' +
    `Pipelines:\n${list}\n\n` +
    (imposed.length ? `The user already chose ${imposed.join(' and ')}: keep it as is and decide only the rest.\n` : '') +
    'Rules: a question, a remark or a reflection that does not ask for a change → discussion. If nothing fits clearly → discussion (user rule: unclassifiable = Discussion). ' +
    meetingRule(choices) +
    genericRule(choices) +
    'For dev: mode "complet" for a new feature or behaviour, "leger" for a small fix or a mechanical edit; if unsure between the two → "leger". ' +
    'For dev, also the nature: "bugfix" (a defect to reproduce then fix), "mecanique" (a mechanical edit that changes no behaviour: rename, replace, reformat), or "comportement" (a behaviour to add or change). ' +
    'Other pipelines: mode "complet" unless the request is clearly small.\n' +
    'If the request asks for an ACTION that no pipeline covers, answer "discussion" and set "lacune" to one sentence proposing the missing pipeline or step; otherwise leave it out.\n' +
    `Answer with ONE JSON object and nothing else: {"pipeline":"<id>","mode":${modeList(choices)},"nature":"comportement"|"bugfix"|"mecanique","raison":"<one short sentence in French>","lacune":"<optional, French>"${opFields(choices)}}\n\n` +
    `Request:\n<<<\n${normalizeText(text).slice(0, 6000)}\n>>>`;
}

/** Validated {pipeline, mode, kind, raison, lacune[, operations, autorisation]} from the model's answer, or null. */
export function parseClassification(answer, fixed = {}, choices = CHOICES) {
  const m = /\{[\s\S]*\}/.exec(String(answer || ''));
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const pipeline = fixed.pipeline || (typeof j.pipeline === 'string' ? j.pipeline.trim().toLowerCase() : '');
  if (!choices.some(p => p.id === pipeline) && pipeline !== fixed.pipeline) return null;
  // A generic mode (phase 1) only when the generics are offered, and only for its pipeline.
  const generic = choices.some(p => GENERIC_PIPELINES.includes(p.id));
  const asked = typeof j.mode === 'string' ? j.mode.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') : '';
  const genericMode = generic && GENERIC_MODES[pipeline]?.includes(asked) ? asked : null;
  const mode = fixed.mode || genericMode || (asked === 'complet' ? 'complet' : asked === 'leger' ? 'leger' : generic && Object.values(GENERIC_MODES).flat().includes(asked) ? 'complet' : null);
  if (!mode) return null;
  // The nature is part of the classification of a dev request: no default.
  const kind = pipeline === 'dev' ? KINDS[String(j.nature || '').trim().toLowerCase()] || null : null;
  if (pipeline === 'dev' && !kind) return null;
  const raison = typeof j.raison === 'string' ? j.raison.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const lacune = typeof j.lacune === 'string' && j.lacune.trim() ? j.lacune.replace(/\s+/g, ' ').trim().slice(0, 400) : null;
  return { pipeline, mode, kind, raison, lacune, ...(pipeline === 'operations' ? operationsOf(j) : {}) };
}

/**
 * The operations the classifier named (the engine then skips « Préparer »):
 * the whole ordered list, or nothing when one id is not in the registry — a
 * partial list would silently drop an operation the user asked for. A single
 * `operation` (older answer shape) is a list of one.
 */
export function operationsOf(j) {
  const raw = Array.isArray(j?.operations) ? j.operations : j?.operation ? [{ id: j.operation, params: j.params }] : [];
  if (!raw.length || raw.length > 6) return {};
  const list = [];
  for (const o of raw) {
    const id = typeof o === 'string' ? o : o?.id;
    if (!OPERATION_IDS.includes(id)) return {};
    const params = o && typeof o === 'object' && o.params && typeof o.params === 'object' && !Array.isArray(o.params) ? o.params : {};
    list.push({ id, params });
  }
  return { operations: list, ...(typeof j.autorisation === 'string' && j.autorisation.trim() ? { autorisation: j.autorisation.trim().slice(0, 400) } : {}) };
}

/** Provider key from the environment, then the orchestrator's own .env (never logged). */
export function keyFromDotEnv(root, name) {
  if (process.env[name] && process.env[name].trim()) return process.env[name].trim();
  try {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm').exec(fs.readFileSync(path.join(root, '.env'), 'utf8'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

/** codex binary: CODEX_BIN, then the npm package entry point, then codex on PATH. */
export function resolveCodexBin(env = process.env) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  const dirs = [...(env.PATH || '').split(path.delimiter), env.APPDATA ? path.join(env.APPDATA, 'npm') : null].filter(Boolean);
  for (const d of dirs) {
    const js = path.join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) return js;
  }
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

/** One tool-less codex exchange (subscription billing, read-only sandbox, temp cwd). */
export function oneShotCodex(prompt, { model, timeoutMs = 90_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const bin = resolveCodexBin(env);
    const out = path.join(os.tmpdir(), `orch-classify-${process.pid}-${Date.now()}.txt`);
    const args = ['exec', ...(model ? ['--model', model] : []), '-s', 'read-only', '--skip-git-repo-check', '--json', '--cd', os.tmpdir(), '--output-last-message', out, '-'];
    const childEnv = { ...env };
    for (const k of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID']) delete childEnv[k];
    const isJs = /\.(mjs|js|cjs)$/i.test(bin);
    let c;
    try { c = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, { cwd: os.tmpdir(), env: childEnv, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }); }
    catch (e) { resolve({ ok: false, why: `lancement de codex impossible : ${e.message}` }); return; }
    let err = '';
    const t = setTimeout(() => { try { c.kill(); } catch {} resolve({ ok: false, why: 'délai dépassé' }); }, timeoutMs);
    c.stderr.on('data', d => { err += d; });
    c.on('error', e => { clearTimeout(t); resolve({ ok: false, why: e.message }); });
    c.on('close', (code) => {
      clearTimeout(t);
      let text = '';
      try { text = fs.readFileSync(out, 'utf8').trim(); fs.rmSync(out, { force: true }); } catch {}
      resolve(code === 0 && text ? { ok: true, text } : { ok: false, why: (err || `code ${code}`).replace(/\s+/g, ' ').slice(0, 300) });
    });
    c.stdin.end(prompt);
  });
}

/** The one-shot caller for a provider (non-Claude: 0.53.0). */
export function callerFor(provider, { root, keys = (n) => keyFromDotEnv(root, n), env = process.env, fetchImpl } = {}) {
  if (provider === 'claude') return (prompt, o) => oneShotClaude(prompt, o);
  if (provider === 'codex') return (prompt, o) => oneShotCodex(prompt, o);
  if (provider === 'openrouter' || provider === 'nvidia') {
    const name = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
    const base = provider === 'openrouter' ? (env.ORCH_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1') : (env.ORCH_NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1');
    return async (prompt, o) => {
      const key = keys(name);
      if (!key) return { ok: false, why: `clé ${provider === 'openrouter' ? 'OpenRouter' : 'NVIDIA'} absente` };
      return chatCompletion({ url: `${base}/chat/completions`, key, model: o.model, prompt, fetchImpl, timeoutMs: o.timeoutMs });
    };
  }
  return null;
}

function record(logsDir, rec) {
  if (!logsDir) return;
  try { fs.appendFileSync(path.join(logsDir, CLASSIFY_FILE), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n'); } catch { /* never blocks */ }
}

/**
 * Asks the classifier model, with one retry on an invalid answer.
 * → { ok:true, value, model } | { ok:false, why, model? }  (never a keyword fallback)
 */
async function askClassifier({ root, prompt, parse, oneShot, keys, fetchImpl, timeoutMs, env }) {
  const c = classifierCase(root);
  if (!c) return { ok: false, why: `la case « ${CLASSIFIER_SLOT} » de la page Models n’a pas de model affecté` };
  // Every provider of the Models page can classify (0.53.0): Claude and codex
  // through their CLI (subscription), OpenRouter and NVIDIA through their API.
  const call = oneShot || callerFor(c.provider, { root, keys, env, fetchImpl });
  if (!call) return { ok: false, why: `fournisseur ${c.provider} non géré`, model: c.model, provider: c.provider };
  let why = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await call(prompt, { model: c.model, timeoutMs, env });
    if (!r.ok) { why = r.why || 'échec'; continue; }
    const value = parse(r.text);
    if (value) return { ok: true, value, model: c.model, provider: c.provider };
    why = `réponse non conforme (« ${String(r.text).slice(0, 80)} »)`;
  }
  return { ok: false, why: `${c.model} : ${why}`, model: c.model, provider: c.provider };
}

/**
 * Classifies one entry by its meaning. Explicit choices (prefix, `fixed` from
 * flags) never reach the model when they are complete; otherwise the model of
 * the routage.classifier slot decides the rest. No keyword fallback (0.66.0):
 * → { pipeline, mode, kind, explicit, classifier, raison?, lacune? }
 *   | { failed: true, why, explicit }   (the caller pauses and asks the user)
 */
export async function classifyEntry({ root, logsDir, text, project = null, entry = null, fixed = {}, oneShot = null, keys, fetchImpl, timeoutMs = 60_000, env = process.env } = {}) {
  const generic = genericFor(root, project);
  const exploitation = exploitationFor(root, project);
  const design = designFor(root, project);
  const e = explicitChoice({ text, entry, generic, exploitation, design });
  const want = { pipeline: fixed.pipeline || e.pipeline || null, mode: fixed.mode || e.mode || null, kind: fixed.kind || null };
  if (e.system) return { pipeline: 'routage', mode: null, kind: null, explicit: true, classifier: 'explicite', reasons: [`entrée système « ${entry} »`] };
  // Complete explicit choice: dev needs its nature too; other pipelines take
  // their only mode (« complet ») unless one was chosen.
  if (want.pipeline && want.pipeline !== 'dev') {
    return { pipeline: want.pipeline, mode: want.mode || (want.pipeline === 'discussion' ? 'leger' : 'complet'), kind: null, explicit: true, classifier: 'explicite', reasons: [`choix explicite → ${want.pipeline}`] };
  }
  if (want.pipeline === 'dev' && want.mode && want.kind) {
    return { pipeline: 'dev', mode: want.mode, kind: want.kind, explicit: true, classifier: 'explicite', reasons: ['choix explicite → dev'] };
  }
  const fixedForModel = { ...(want.pipeline ? { pipeline: want.pipeline } : {}), ...(want.mode ? { mode: want.mode } : {}) };
  const choices = classifierChoices(root, { generic, exploitation, design });
  const r = await askClassifier({ root, prompt: classificationPrompt(text, fixedForModel, choices), parse: (t) => parseClassification(t, fixedForModel, choices), oneShot, keys, fetchImpl, timeoutMs, env });
  if (!r.ok) {
    record(logsDir, { project, entry, provider: r.provider || null, model: r.model || null, ok: false, why: r.why, fixed: fixedForModel });
    return { failed: true, why: r.why, explicit: !!want.pipeline, fixed: fixedForModel };
  }
  const v = r.value;
  record(logsDir, { project, entry, provider: r.provider, model: r.model, ok: true, model_result: v, fixed: fixedForModel });
  return {
    pipeline: v.pipeline, mode: v.mode, kind: v.kind, explicit: !!want.pipeline, confidence: 'model',
    reasons: [`${r.model} : ${v.raison || 'sans raison'}`], classifier: `model:${r.model}`,
    raison: v.raison, ...(v.lacune ? { lacune: v.lacune } : {}),
    ...(v.operations ? { operations: v.operations, ...(v.autorisation ? { autorisation: v.autorisation } : {}) } : {}),
  };
}

/**
 * Routage, split before classify (0.69.0). User request (2026-10-10): « le
 * routeur ne doit pas classer une demande entiere alors qu'elle est deja
 * decoupee » — first the global meaning, then the split into unit tasks, then
 * each task is classified ON ITS OWN. This prompt therefore only ever holds ONE
 * task (never the whole message). Besides a pipeline, a task may be answered
 * with "question" (ambiguous: ask the user, never guess) or "lacune" (an action
 * no pipeline covers — a gap about THIS task only).
 */
export function routingTaskPrompt(task, fixed = {}, choices = CHOICES) {
  const list = choices.map(p => `- ${p.id}: ${p.label} — ${p.when || p.purpose || ''}`).join('\n');
  const imposed = [fixed.pipeline && `pipeline "${fixed.pipeline}"`, fixed.mode && `mode "${fixed.mode}"`].filter(Boolean);
  return '[CLASSIFY] ROUTING TASK. A message to the conductor was already understood and split into unit tasks; you route ONE of them, by its MEANING. ' +
    'Pick the ONE pipeline that fits this task alone.\n' +
    `Pipelines:\n${list}\n\n` +
    (imposed.length ? `The user already chose ${imposed.join(' and ')}: keep it as is and decide only the rest.\n` : '') +
    'Rules: a question, a remark or a reflection that does not ask for a change → discussion. ' +
    meetingRule(choices) +
    genericRule(choices) +
    'For dev: mode "complet" for a new feature or behaviour, "leger" for a small fix or a mechanical edit; if unsure between the two → "leger"; ' +
    'and the nature: "bugfix", "mecanique" (no behaviour change) or "comportement". Other pipelines: mode "complet" unless the task is clearly small.\n' +
    'If the task is ambiguous (you cannot tell what is wanted, or which of two pipelines), do NOT guess: set "question" to the question to ask the user. ' +
    'If the task asks for an ACTION that no pipeline covers, set "lacune" to one sentence proposing the missing pipeline or step.\n' +
    'If the task is NOT work for the project\'s agent but something the CONDUCTOR (chef) must do itself — restart the orchestrator server, stop a running or stalled turn, mark a question as answered, publish an APK, or any other direct supervision action — do NOT pick a pipeline: set "chef" to "restart-orchestrateur", "kill-stalled", "resolve-question", "copy-build", or "autre" if none of them fits. Such a task is never sent to a project agent.\n' +
    `Answer with ONE JSON object and nothing else: {"pipeline":"<id>","mode":${modeList(choices)},"nature":"comportement"|"bugfix"|"mecanique","raison":"<one short sentence in French>","question":"<optional, French>","lacune":"<optional, French>","chef":"<optional>"${opFields(choices)}}\n\n` +
    `Project: ${task.projet || '?'}\n` +
    `Request:\n<<<\n${normalizeText(task.demande).slice(0, 6000)}\n>>>`;
}

/** {chef, raison} | {question} | {lacune, raison} | {pipeline, mode, kind, raison} from the model's answer, or null. */
export function parseTaskClassification(answer, fixed = {}, choices = CHOICES) {
  const m = /\{[\s\S]*\}/.exec(String(answer || ''));
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const text = (v, n) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, n) : null);
  const raison = text(j.raison, 300) || '';
  // A chef's own action (0.71.0, ROUTAGE-PROBLEMES n° 8) wins over anything else.
  const chef = text(j.chef, 40);
  if (chef) return { chef, raison };
  const question = text(j.question, 600);
  if (question) return { question, raison };
  const lacune = text(j.lacune, 400);
  if (lacune) return { lacune, raison };
  const v = parseClassification(answer, fixed, choices);
  return v ? { ...v, lacune: null } : null;
}

/**
 * Classifies ONE unit task of a Routage run (one model call per task, slot
 * routage.classifier, one retry). A complete explicit choice skips the model.
 * → { pipeline, mode, kind, raison, classifier } | { question } | { lacune } | { failed, why }
 */
export async function classifyTask({ root, logsDir, task, fixed = {}, oneShot = null, keys, fetchImpl, timeoutMs = 60_000, env = process.env } = {}) {
  const want = { pipeline: fixed.pipeline || null, mode: fixed.mode || null, kind: fixed.kind || null };
  if (want.pipeline && want.pipeline !== 'dev') {
    return { pipeline: want.pipeline, mode: want.mode || (want.pipeline === 'discussion' ? 'leger' : 'complet'), kind: null, classifier: 'explicite', raison: `choix explicite → ${want.pipeline}` };
  }
  if (want.pipeline === 'dev' && want.mode && want.kind) return { pipeline: 'dev', mode: want.mode, kind: want.kind, classifier: 'explicite', raison: 'choix explicite → dev' };
  const fixedForModel = { ...(want.pipeline ? { pipeline: want.pipeline } : {}), ...(want.mode ? { mode: want.mode } : {}) };
  const choices = classifierChoices(root, { generic: genericFor(root, task.projet), exploitation: exploitationFor(root, task.projet), design: designFor(root, task.projet) });
  const r = await askClassifier({ root, prompt: routingTaskPrompt(task, fixedForModel, choices), parse: (t) => parseTaskClassification(t, fixedForModel, choices), oneShot, keys, fetchImpl, timeoutMs, env });
  record(logsDir, { project: task.projet || null, entry: 'routage-tache', provider: r.provider || null, model: r.model || null, ok: r.ok, ...(r.ok ? { model_result: r.value } : { why: r.why }), fixed: fixedForModel });
  if (!r.ok) return { failed: true, why: r.why, model: r.model || null };
  return { ...r.value, classifier: `model:${r.model}`, model: r.model };
}

/**
 * One choice among named options, by the classifier model (e.g. the variant
 * of a media step). options: [{ id, what }]. → { ok, id } | { ok:false, why }
 */
export async function chooseOption({ root, logsDir, question, request, options, project = null, oneShot = null, keys, fetchImpl, timeoutMs = 60_000, env = process.env } = {}) {
  const ids = options.map(o => o.id);
  const prompt = `[CLASSIFY] ${question}\nOptions:\n${options.map(o => `- ${o.id}: ${o.what || o.id}`).join('\n')}\n\n` +
    'Decide by the MEANING of the request. Answer with ONE JSON object and nothing else: {"choix":"<id>","raison":"<one short sentence in French>"}\n\n' +
    `Request:\n<<<\n${normalizeText(request).slice(0, 6000)}\n>>>`;
  const parse = (t) => {
    const m = /\{[\s\S]*\}/.exec(String(t || ''));
    let j = null; try { j = m ? JSON.parse(m[0]) : null; } catch { return null; }
    const id = typeof j?.choix === 'string' ? j.choix.trim() : '';
    return ids.includes(id) ? { id, raison: String(j.raison || '').slice(0, 300) } : null;
  };
  const r = await askClassifier({ root, prompt, parse, oneShot, keys, fetchImpl, timeoutMs, env });
  record(logsDir, { project, entry: 'choix', question: question.slice(0, 200), options: ids, provider: r.provider || null, model: r.model || null, ok: r.ok, ...(r.ok ? { model_result: r.value } : { why: r.why }) });
  return r.ok ? { ok: true, id: r.value.id, raison: r.value.raison, model: r.model } : { ok: false, why: r.why };
}
