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

export const CLASSIFIER_SLOT = 'routage.classifier';
export const CLASSIFY_FILE = 'pipeline-classify.ndjson';
const PROVIDER_OF = { anthropic: 'claude', openai: 'codex', nvidia: 'nvidia', openrouter: 'openrouter' };
// Routage is the chef's own pipeline: a musician entry is never classified into it.
const CHOICES = PIPELINES.filter(p => p.id !== 'routage');

/** Pipelines offered to the model: the Models page structure, accepted gaps included (their description, never keywords). */
export function classifierChoices(root) {
  let custom = null;
  try { custom = JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')).custom || null; } catch { /* no file */ }
  try { return applyCustom(custom).filter(p => p.id !== 'routage'); } catch { return CHOICES; }
}

/** The assigned classifier model, or null when the slot is empty. */
export function classifierCase(root) {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')).assignments?.[CLASSIFIER_SLOT] || null; } catch { /* no file */ }
  if (!a?.model || !PROVIDER_OF[a.provider]) return null;
  return { model: a.model, provider: PROVIDER_OF[a.provider] };
}

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
    'For dev: mode "complet" for a new feature or behaviour, "leger" for a small fix or a mechanical edit; if unsure between the two → "leger". ' +
    'For dev, also the nature: "bugfix" (a defect to reproduce then fix), "mecanique" (a mechanical edit that changes no behaviour: rename, replace, reformat), or "comportement" (a behaviour to add or change). ' +
    'Other pipelines: mode "complet" unless the request is clearly small.\n' +
    'If the request asks for an ACTION that no pipeline covers, answer "discussion" and set "lacune" to one sentence proposing the missing pipeline or step; otherwise leave it out.\n' +
    'Answer with ONE JSON object and nothing else: {"pipeline":"<id>","mode":"leger"|"complet","nature":"comportement"|"bugfix"|"mecanique","raison":"<one short sentence in French>","lacune":"<optional, French>"}\n\n' +
    `Request:\n<<<\n${normalizeText(text).slice(0, 6000)}\n>>>`;
}

/** Validated {pipeline, mode, kind, raison, lacune} from the model's answer, or null. */
export function parseClassification(answer, fixed = {}, choices = CHOICES) {
  const m = /\{[\s\S]*\}/.exec(String(answer || ''));
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const pipeline = fixed.pipeline || (typeof j.pipeline === 'string' ? j.pipeline.trim().toLowerCase() : '');
  if (!choices.some(p => p.id === pipeline) && pipeline !== fixed.pipeline) return null;
  const mode = fixed.mode || (j.mode === 'complet' ? 'complet' : j.mode === 'leger' || j.mode === 'léger' ? 'leger' : null);
  if (!mode) return null;
  // The nature is part of the classification of a dev request: no default.
  const kind = pipeline === 'dev' ? KINDS[String(j.nature || '').trim().toLowerCase()] || null : null;
  if (pipeline === 'dev' && !kind) return null;
  const raison = typeof j.raison === 'string' ? j.raison.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const lacune = typeof j.lacune === 'string' && j.lacune.trim() ? j.lacune.replace(/\s+/g, ' ').trim().slice(0, 400) : null;
  return { pipeline, mode, kind, raison, lacune };
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
  const e = explicitChoice({ text, entry });
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
  const choices = classifierChoices(root);
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
  };
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
